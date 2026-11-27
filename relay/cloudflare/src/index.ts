/**
 * Cloudflare Workers + Durable Object (WebSocket Hibernation) hosting adapter
 * for the Toolroll Companion Relay (`relay/PROTOCOL.md`).
 *
 * One hosting option implementing the exact same v1 wire contract as `src/companion/reference-relay.ts`.
 * Holds zero Noise keys, never sees plaintext RPC payloads, and enforces Ed25519 pre-upgrade admission,
 * deterministic machineId ownership, 5-byte connId multi-phone routing, 65,535 B frame cap, and rate caps.
 */

const MAX_NOISE_MESSAGE_BYTES = 65_535;
const RELAY_ENVELOPE_HEADER_BYTES = 5;
const MAX_DAEMON_WS_FRAME_BYTES = MAX_NOISE_MESSAGE_BYTES + RELAY_ENVELOPE_HEADER_BYTES;
const MAX_RELAY_TOKEN_TTL_SEC = 300;
const MAX_PHONES_PER_MACHINE = 4;
const RFC4648_LOWER = "abcdefghijklmnopqrstuvwxyz234567";

const OP_PEER_OPEN = 0x01;
const OP_PEER_DATA = 0x02;
const OP_PEER_CLOSE = 0x03;

interface Env {
  MACHINE_ROOM: DurableObjectNamespace;
  RELAY_PUBLIC_HOST: string;
  APNS_TOPIC?: string;
  APNS_ENVIRONMENT?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY_P8?: string;
}

interface RelayTokenClaims {
  v: 1;
  role: "daemon" | "pair" | "device";
  machineId: string;
  deviceId?: string;
  pairSessionId?: string;
  jti: string;
  iat: number;
  exp: number;
}

function fromB64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base32Lower(data: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += RFC4648_LOWER[(acc >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += RFC4648_LOWER[(acc << (5 - bits)) & 0x1f];
  return out;
}

async function deriveMachineId(pubKey: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode("toolroll-machine-id-v1\0");
  const buf = new Uint8Array(prefix.length + pubKey.length);
  buf.set(prefix, 0);
  buf.set(pubKey, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return base32Lower(digest).slice(0, 26);
}

async function verifyEd25519(pubRaw: Uint8Array, message: Uint8Array, sig: Uint8Array): Promise<boolean> {
  if (pubRaw.length !== 32 || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", pubRaw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, sig, message);
  } catch {
    return false;
  }
}

function parseToken(token: string): { claims: RelayTokenClaims; input: Uint8Array; sig: Uint8Array } | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64Url(parts[0]))) as Partial<RelayTokenClaims>;
    if (
      claims.v !== 1
      || (claims.role !== "daemon" && claims.role !== "pair" && claims.role !== "device")
      || typeof claims.machineId !== "string" || !/^[a-z2-7]{26}$/.test(claims.machineId)
      || typeof claims.iat !== "number" || typeof claims.exp !== "number"
    ) return null;
    return {
      claims: claims as RelayTokenClaims,
      input: new TextEncoder().encode(`tr-relay-v1.${parts[0]}`),
      sig: fromB64Url(parts[1]),
    };
  } catch {
    return null;
  }
}

async function verifyToken(token: string, pubKey: Uint8Array): Promise<RelayTokenClaims | null> {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (parsed.claims.exp - parsed.claims.iat > MAX_RELAY_TOKEN_TTL_SEC + 5) return null;
  if (nowSec > parsed.claims.exp + 30 || nowSec + 30 < parsed.claims.iat) return null;
  const ok = await verifyEd25519(pubKey, parsed.input, parsed.sig);
  return ok ? parsed.claims : null;
}

function encodeEnvelope(op: number, connId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(RELAY_ENVELOPE_HEADER_BYTES + payload.length);
  out[0] = op;
  new DataView(out.buffer).setUint32(1, connId >>> 0, false);
  out.set(payload, RELAY_ENVELOPE_HEADER_BYTES);
  return out;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/health") {
      return jsonResponse(200, { ok: true, version: 1, runtime: "cloudflare-do" });
    }
    if (request.method === "POST" && url.pathname === "/v1/challenge") {
      // Stateless HMAC-free short-lived random challenge routed to global challenge DO or room
      const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
      const challenge = toB64Url(challengeBytes);
      const id = env.MACHINE_ROOM.idFromName("__challenges__");
      const stub = env.MACHINE_ROOM.get(id);
      await stub.fetch("https://do/challenge", { method: "POST", body: JSON.stringify({ challenge }) });
      return jsonResponse(200, { challenge, expiresInSec: 60 });
    }
    if (request.method === "POST" && url.pathname === "/v1/machines/register") {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body["relayMachinePub"] !== "string" || typeof body["challenge"] !== "string" || typeof body["signature"] !== "string") {
        return jsonResponse(400, { error: "invalid_body" });
      }
      const chalStub = env.MACHINE_ROOM.get(env.MACHINE_ROOM.idFromName("__challenges__"));
      const chalRes = await chalStub.fetch("https://do/challenge/consume", {
        method: "POST",
        body: JSON.stringify({ challenge: body["challenge"] }),
      });
      if (!chalRes.ok) return jsonResponse(401, { error: "invalid_or_expired_challenge" });

      const pubKey = fromB64Url(body["relayMachinePub"]);
      const host = env.RELAY_PUBLIC_HOST || url.host;
      const popMsg = new TextEncoder().encode(`register\0${host}\0${body["challenge"]}`);
      const ok = await verifyEd25519(pubKey, popMsg, fromB64Url(body["signature"]));
      if (!ok) return jsonResponse(401, { error: "invalid_pop_signature" });

      const machineId = await deriveMachineId(pubKey);
      const roomStub = env.MACHINE_ROOM.get(env.MACHINE_ROOM.idFromName(machineId));
      return roomStub.fetch("https://do/register", {
        method: "POST",
        body: JSON.stringify({ machineId, relayMachinePub: body["relayMachinePub"] }),
      });
    }

    // Route machine device management and WebSocket connect directly to the machine's DO shard.
    const devMatch = /^\/v1\/machines\/([a-z2-7]{26})\/devices(?:\/([^/]+))?$/.exec(url.pathname);
    if (devMatch) {
      const roomStub = env.MACHINE_ROOM.get(env.MACHINE_ROOM.idFromName(devMatch[1]!));
      return roomStub.fetch(request);
    }

    if (url.pathname === "/v1/connect") {
      const auth = request.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer ")) return jsonResponse(401, { error: "missing_token" });
      const parsed = parseToken(auth.slice(7).trim());
      if (!parsed) return jsonResponse(401, { error: "malformed_token" });
      const roomStub = env.MACHINE_ROOM.get(env.MACHINE_ROOM.idFromName(parsed.claims.machineId));
      return roomStub.fetch(request);
    }

    return jsonResponse(404, { error: "not_found" });
  },
};

interface SocketAttachment {
  role: "daemon" | "pair" | "device";
  connId: number;
  peerId: string;
}

export class MachineRoomDO {
  private readonly state: DurableObjectState;
  private nextConnId = 1;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Challenge pool endpoints (when invoked on __challenges__ singleton)
    if (url.pathname === "/challenge" && request.method === "POST") {
      const { challenge } = (await request.json()) as { challenge: string };
      await this.state.storage.put(`chal:${challenge}`, Date.now() + 60_000);
      return jsonResponse(200, { ok: true });
    }
    if (url.pathname === "/challenge/consume" && request.method === "POST") {
      const { challenge } = (await request.json()) as { challenge: string };
      const exp = await this.state.storage.get<number>(`chal:${challenge}`);
      await this.state.storage.delete(`chal:${challenge}`);
      if (exp === undefined || exp <= Date.now()) return jsonResponse(401, { error: "expired" });
      return jsonResponse(200, { ok: true });
    }

    if (url.pathname === "/register" && request.method === "POST") {
      const { machineId, relayMachinePub } = (await request.json()) as { machineId: string; relayMachinePub: string };
      await this.state.storage.put("machineId", machineId);
      await this.state.storage.put("relayMachinePub", relayMachinePub);
      return jsonResponse(200, { machineId });
    }

    const machinePubB64 = await this.state.storage.get<string>("relayMachinePub");
    if (!machinePubB64) return jsonResponse(401, { error: "unknown_machine" });
    const machinePub = fromB64Url(machinePubB64);

    // Device registration / revocation
    const devMatch = /^\/v1\/machines\/([a-z2-7]{26})\/devices(?:\/([^/]+))?$/.exec(url.pathname);
    if (devMatch) {
      const auth = request.headers.get("authorization") ?? "";
      const claims = auth.startsWith("Bearer ") ? await verifyToken(auth.slice(7).trim(), machinePub) : null;
      if (!claims || claims.role !== "daemon" || claims.machineId !== devMatch[1]) {
        return jsonResponse(401, { error: "unauthorized" });
      }
      if (request.method === "POST" && !devMatch[2]) {
        const body = (await request.json().catch(() => null)) as { deviceId?: string; deviceRelayPub?: string } | null;
        if (!body?.deviceId || !body.deviceRelayPub || fromB64Url(body.deviceRelayPub).length !== 32) {
          return jsonResponse(400, { error: "invalid_body" });
        }
        await this.state.storage.put(`dev:${body.deviceId}`, body.deviceRelayPub);
        return jsonResponse(200, { ok: true, deviceId: body.deviceId });
      }
      if (request.method === "DELETE" && devMatch[2]) {
        const deviceId = decodeURIComponent(devMatch[2]);
        await this.state.storage.delete(`dev:${deviceId}`);
        for (const ws of this.state.getWebSockets()) {
          const att = ws.deserializeAttachment() as SocketAttachment | null;
          if (att?.role === "device" && att.peerId === deviceId) {
            ws.close(1000, "device_revoked");
          }
        }
        return jsonResponse(200, { ok: true, revoked: deviceId });
      }
    }

    // WebSocket upgrade (/v1/connect)
    if (url.pathname === "/v1/connect" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const parsed = parseToken(token);
      if (!parsed) return jsonResponse(401, { error: "malformed_token" });

      let verifyKey: Uint8Array | null = null;
      if (parsed.claims.role === "daemon" || parsed.claims.role === "pair") {
        verifyKey = machinePub;
      } else if (parsed.claims.role === "device" && parsed.claims.deviceId) {
        const devPubB64 = await this.state.storage.get<string>(`dev:${parsed.claims.deviceId}`);
        verifyKey = devPubB64 ? fromB64Url(devPubB64) : null;
      }
      if (!verifyKey) return jsonResponse(403, { error: "unknown_or_revoked_device" });
      const claims = await verifyToken(token, verifyKey);
      if (!claims) return jsonResponse(401, { error: "invalid_token" });

      const activeSockets = this.state.getWebSockets();
      const peerCount = activeSockets.filter(s => (s.deserializeAttachment() as SocketAttachment | null)?.role !== "daemon").length;
      if (claims.role !== "daemon" && peerCount >= MAX_PHONES_PER_MACHINE) {
        return jsonResponse(429, { error: "too_many_peers" });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      const connId = claims.role === "daemon" ? 0 : this.nextConnId++;
      const attachment: SocketAttachment = {
        role: claims.role,
        connId,
        peerId: claims.deviceId ?? claims.pairSessionId ?? "daemon",
      };
      this.state.acceptWebSocket(server);
      server.serializeAttachment(attachment);

      if (claims.role !== "daemon") {
        const daemon = activeSockets.find(s => (s.deserializeAttachment() as SocketAttachment | null)?.role === "daemon");
        if (daemon) {
          daemon.send(encodeEnvelope(OP_PEER_OPEN, connId, new TextEncoder().encode(JSON.stringify({ role: claims.role, id: attachment.peerId }))));
        }
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    return jsonResponse(404, { error: "not_found" });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === "string") {
      ws.close(1003, "binary_required");
      return;
    }
    const bytes = new Uint8Array(message);
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att) {
      ws.close(1008, "unattached");
      return;
    }
    const sockets = this.state.getWebSockets();

    if (att.role === "daemon") {
      if (bytes.length < RELAY_ENVELOPE_HEADER_BYTES || bytes.length > MAX_DAEMON_WS_FRAME_BYTES) {
        ws.close(1009, "invalid_frame_size");
        return;
      }
      const op = bytes[0]!;
      const connId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
      const target = sockets.find(s => (s.deserializeAttachment() as SocketAttachment | null)?.connId === connId);
      if (op === OP_PEER_CLOSE) {
        target?.close(1000, "closed_by_daemon");
      } else if (op === OP_PEER_DATA && target) {
        target.send(bytes.subarray(RELAY_ENVELOPE_HEADER_BYTES));
      }
      return;
    }

    if (bytes.length > MAX_NOISE_MESSAGE_BYTES) {
      ws.close(1009, "frame_too_large");
      return;
    }
    const daemon = sockets.find(s => (s.deserializeAttachment() as SocketAttachment | null)?.role === "daemon");
    if (!daemon) {
      ws.close(1000, "daemon_unavailable");
      return;
    }
    daemon.send(encodeEnvelope(OP_PEER_DATA, att.connId, bytes));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (!att) return;
    const sockets = this.state.getWebSockets();
    if (att.role === "daemon") {
      for (const s of sockets) {
        const other = s.deserializeAttachment() as SocketAttachment | null;
        if (other && other.role !== "daemon") s.close(1000, "daemon_disconnected");
      }
    } else {
      const daemon = sockets.find(s => (s.deserializeAttachment() as SocketAttachment | null)?.role === "daemon");
      if (daemon) {
        daemon.send(encodeEnvelope(OP_PEER_CLOSE, att.connId, new TextEncoder().encode(JSON.stringify({ reason: "peer_closed" }))));
      }
    }
  }
}
