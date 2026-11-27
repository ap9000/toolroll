/**
 * Portable open-source Reference Relay for Toolroll Companion (`relay/PROTOCOL.md`).
 * Zero cloud vendor lock-in: runs on plain Node.js HTTP + `ws` (`docker run` or embedded in tests).
 *
 * The relay holds ZERO Noise keys, cannot read payloads, and cannot authorize any Toolroll act.
 * It enforces pre-upgrade Ed25519 admission, deterministic machineId ownership, 5-byte connId
 * multi-phone routing, 5s first-frame / 60s idle deadlines, 65,535 B frame cap, token-bucket
 * rate & byte limits, and a global circuit breaker.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { MAX_NOISE_MESSAGE_BYTES } from "./noise.js";
import {
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  MAX_DAEMON_WS_FRAME_BYTES,
  parseRelayTokenUnverified,
  RelayOp,
  verifyMachineRegistration,
  verifyRelayToken,
  type RelayRole,
} from "./relay-auth.js";

export interface ReferenceRelayOptions {
  host?: string;
  port?: number;
  /** Override public host used in registration PoP signature check (defaults to Host header). */
  publicHost?: string;
  /** First-frame deadline on newly upgraded peer sockets (default 5_000 ms). */
  firstFrameDeadlineMs?: number;
  /** Idle timeout without any frame in either direction (default 60_000 ms). */
  idleTimeoutMs?: number;
  /** Max concurrent phone/pair sockets per machineId (default 4). */
  maxPhonesPerMachine?: number;
  /** Per-phone sustained frames/min (default 600) and burst (default 120). */
  phoneFramesPerMin?: number;
  phoneFrameBurst?: number;
  /** Per-phone sustained bytes/min (default 4 MiB) and burst (default 2 MiB). */
  phoneBytesPerMin?: number;
  phoneByteBurst?: number;
  /** Per-machine sustained frames/min (default 2400) and bytes/min (default 16 MiB). */
  machineFramesPerMin?: number;
  machineBytesPerMin?: number;
  /** Global circuit breaker: max total forwarded frames before returning 503 (0 = unlimited). */
  globalMaxFrames?: number;
  /** Optional clock for deterministic tests. */
  nowMs?: () => number;
}

class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly capacity: number;
  private readonly ratePerMs: number;

  constructor(perMinute: number, burst: number, nowMs: number) {
    this.capacity = burst;
    this.tokens = burst;
    this.ratePerMs = perMinute / 60_000;
    this.lastRefillMs = nowMs;
  }

  tryConsume(cost: number, nowMs: number): boolean {
    const elapsed = Math.max(0, nowMs - this.lastRefillMs);
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
      this.lastRefillMs = nowMs;
    }
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

interface PeerConn {
  connId: number;
  ws: WebSocket;
  role: "pair" | "device";
  peerId: string;
  receivedFirstFrame: boolean;
  firstFrameTimer: ReturnType<typeof setTimeout>;
  idleTimer: ReturnType<typeof setTimeout>;
  frameBucket: TokenBucket;
  byteBucket: TokenBucket;
}

interface MachineRoom {
  machineId: string;
  relayMachinePub: Buffer;
  devices: Map<string, Buffer>; // deviceId -> 32B Ed25519 pubkey
  daemon: WebSocket | null;
  daemonIdleTimer: ReturnType<typeof setTimeout> | null;
  peers: Map<number, PeerConn>;
  nextConnId: number;
  machineFrameBucket: TokenBucket;
  machineByteBucket: TokenBucket;
  /** Daemon → phones: its own budget (phones can't spend it); over it, the phone being sent to is closed, never the daemon. */
  daemonByteBucket: TokenBucket;
}

/** Machines one reference relay holds at once (it is for self-hosting a household or team, not the public). */
const MAX_ROOMS = 1_000;

export interface RunningReferenceRelay {
  url: string;
  wsUrl: string;
  port: number;
  close: () => Promise<void>;
  stats: () => { machines: number; totalForwardedFrames: number };
}

function readJsonBody(req: IncomingMessage, maxBytes = 16_384): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        resolve(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const text = JSON.stringify({ error: reason });
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : status === 503 ? "Service Unavailable" : "Bad Request"}\r\n`
    + `Content-Type: application/json\r\n`
    + `Content-Length: ${Buffer.byteLength(text)}\r\n`
    + `Connection: close\r\n\r\n${text}`,
  );
  socket.destroy();
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export async function startReferenceRelay(opts: ReferenceRelayOptions = {}): Promise<RunningReferenceRelay> {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const firstFrameDeadlineMs = opts.firstFrameDeadlineMs ?? 5_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  const maxPhonesPerMachine = opts.maxPhonesPerMachine ?? 4;
  const phoneFramesPerMin = opts.phoneFramesPerMin ?? 600;
  const phoneFrameBurst = opts.phoneFrameBurst ?? 120;
  const phoneBytesPerMin = opts.phoneBytesPerMin ?? 4 * 1024 * 1024;
  const phoneByteBurst = opts.phoneByteBurst ?? 2 * 1024 * 1024;
  const machineFramesPerMin = opts.machineFramesPerMin ?? 2_400;
  const machineBytesPerMin = opts.machineBytesPerMin ?? 16 * 1024 * 1024;
  const globalMaxFrames = opts.globalMaxFrames ?? 0;

  const challenges = new Map<string, number>(); // challenge -> expiresAtMs
  const rooms = new Map<string, MachineRoom>();
  let totalForwardedFrames = 0;

  const circuitTripped = (): boolean => globalMaxFrames > 0 && totalForwardedFrames >= globalMaxFrames;

  const bearerFrom = (req: IncomingMessage): string | null => {
    const auth = req.headers["authorization"];
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
    return auth.slice("Bearer ".length).trim() || null;
  };

  const cleanupPeer = (room: MachineRoom, connId: number, reason: string, notifyDaemon = true): void => {
    const peer = room.peers.get(connId);
    if (peer === undefined) return;
    clearTimeout(peer.firstFrameTimer);
    clearTimeout(peer.idleTimer);
    room.peers.delete(connId);
    if (peer.ws.readyState === WebSocket.OPEN || peer.ws.readyState === WebSocket.CONNECTING) {
      peer.ws.close(1000, reason);
    }
    if (notifyDaemon && room.daemon !== null && room.daemon.readyState === WebSocket.OPEN) {
      const env = encodeRelayEnvelope({
        op: RelayOp.PEER_CLOSE,
        connId,
        payload: Buffer.from(JSON.stringify({ reason }), "utf8"),
      });
      room.daemon.send(env, { binary: true });
    }
  };

  const authenticateDaemonHttp = (req: IncomingMessage, machineId: string): { ok: true; room: MachineRoom } | { ok: false; status: number; error: string } => {
    const room = rooms.get(machineId);
    if (room === undefined) return { ok: false, status: 401, error: "unknown_machine" };
    const token = bearerFrom(req);
    if (token === null) return { ok: false, status: 401, error: "missing_token" };
    const verified = verifyRelayToken(token, room.relayMachinePub, Math.floor(nowMs() / 1000));
    if (!verified.ok) return { ok: false, status: 401, error: verified.reason };
    if (verified.claims.role !== "daemon" || verified.claims.machineId !== machineId) {
      return { ok: false, status: 403, error: "forbidden_role" };
    }
    return { ok: true, room };
  };

  // Every HTTP request runs guarded: a malformed path, escape or body answers 400 (or drops the socket) and can never
  // reject unhandled — the console runs this relay in-process, so a crash here would take the console down with it.
  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (circuitTripped()) {
      sendJson(res, 503, { error: "relay_budget_exceeded" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://relay.invalid"); // never the Host header: a bad one must not throw

    if (req.method === "GET" && url.pathname === "/v1/health") {
      sendJson(res, 200, { ok: true, version: 1 });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/challenge") {
      // Prune expired challenges
      const t = nowMs();
      for (const [k, exp] of challenges) {
        if (exp <= t) challenges.delete(k);
      }
      if (challenges.size > 10_000) {
        sendJson(res, 429, { error: "challenge_pool_full" });
        return;
      }
      const challenge = randomBytes(32).toString("base64url");
      challenges.set(challenge, t + 60_000);
      sendJson(res, 200, { challenge, expiresInSec: 60 });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/machines/register") {
      const body = await readJsonBody(req);
      if (
        body === null
        || typeof body["relayMachinePub"] !== "string"
        || typeof body["challenge"] !== "string"
        || typeof body["signature"] !== "string"
      ) {
        sendJson(res, 400, { error: "invalid_body" });
        return;
      }
      const exp = challenges.get(body["challenge"]);
      if (exp === undefined || exp <= nowMs()) {
        challenges.delete(body["challenge"]);
        sendJson(res, 401, { error: "invalid_or_expired_challenge" });
        return;
      }
      challenges.delete(body["challenge"]); // single-use
      const relayHost = opts.publicHost ?? String(req.headers.host ?? "localhost");
      const checked = verifyMachineRegistration({
        relayMachinePubB64: body["relayMachinePub"],
        relayHost,
        challenge: body["challenge"],
        signatureB64: body["signature"],
      });
      if (!checked.ok) {
        sendJson(res, 401, { error: checked.reason });
        return;
      }
      if (!rooms.has(checked.machineId)) {
        // Registering is free (a key and a signature), so rooms are bounded: an empty one (no daemon, phones or admitted
        // devices) is evicted to make space; with none empty, a new machine waits.
        if (rooms.size >= MAX_ROOMS) {
          const empty = [...rooms.values()].find(room => room.daemon === null && room.peers.size === 0 && room.devices.size === 0);
          if (empty === undefined) { sendJson(res, 503, { error: "relay_full" }); return; }
          rooms.delete(empty.machineId);
        }
        const t = nowMs();
        rooms.set(checked.machineId, {
          machineId: checked.machineId,
          relayMachinePub: checked.publicKey,
          devices: new Map(),
          daemon: null,
          daemonIdleTimer: null,
          peers: new Map(),
          nextConnId: 1,
          machineFrameBucket: new TokenBucket(machineFramesPerMin, Math.max(phoneFrameBurst * 2, 240), t),
          machineByteBucket: new TokenBucket(machineBytesPerMin, Math.max(phoneByteBurst * 2, 4 * 1024 * 1024), t),
          daemonByteBucket: new TokenBucket(machineBytesPerMin, Math.max(phoneByteBurst * 2, 4 * 1024 * 1024), t),
        });
      }
      sendJson(res, 200, { machineId: checked.machineId });
      return;
    }

    const devicesMatch = /^\/v1\/machines\/([a-z2-7]{26})\/devices$/.exec(url.pathname);
    // PUT replaces the machine's whole set of admitted phones: the daemon reconciles after every (re)connect, so a relay
    // that restarted (empty) or missed a DELETE (revoked or restored while the relay was unreachable) converges exactly.
    // Any phone socket whose device left the set is closed.
    if (req.method === "PUT" && devicesMatch !== null) {
      const machineId = devicesMatch[1]!;
      const auth = authenticateDaemonHttp(req, machineId);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }
      const body = await readJsonBody(req);
      const list = body === null ? null : body["devices"];
      if (!Array.isArray(list) || list.length > 64) {
        sendJson(res, 400, { error: "invalid_body" });
        return;
      }
      const next = new Map<string, Buffer>();
      for (const item of list) {
        const entry = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : null;
        const deviceId = entry?.["deviceId"], pubB64 = entry?.["deviceRelayPub"];
        if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > 128 || typeof pubB64 !== "string") {
          sendJson(res, 400, { error: "invalid_body" });
          return;
        }
        const pub = Buffer.from(pubB64, "base64url");
        if (pub.length !== 32) {
          sendJson(res, 400, { error: "invalid_device_public_key" });
          return;
        }
        next.set(deviceId, pub);
      }
      auth.room.devices.clear();
      for (const [deviceId, pub] of next) auth.room.devices.set(deviceId, pub);
      for (const [connId, peer] of [...auth.room.peers]) {
        if (peer.role === "device" && !next.has(peer.peerId)) cleanupPeer(auth.room, connId, "device_revoked", true);
      }
      sendJson(res, 200, { ok: true, devices: next.size });
      return;
    }
    if (req.method === "POST" && devicesMatch !== null) {
      const machineId = devicesMatch[1]!;
      const auth = authenticateDaemonHttp(req, machineId);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }
      const body = await readJsonBody(req);
      if (body === null || typeof body["deviceId"] !== "string" || typeof body["deviceRelayPub"] !== "string" || body["deviceId"].length === 0) {
        sendJson(res, 400, { error: "invalid_body" });
        return;
      }
      const pub = Buffer.from(body["deviceRelayPub"], "base64url");
      if (pub.length !== 32) {
        sendJson(res, 400, { error: "invalid_device_public_key" });
        return;
      }
      auth.room.devices.set(body["deviceId"], pub);
      sendJson(res, 200, { ok: true, deviceId: body["deviceId"] });
      return;
    }

    const deleteDeviceMatch = /^\/v1\/machines\/([a-z2-7]{26})\/devices\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && deleteDeviceMatch !== null) {
      const machineId = deleteDeviceMatch[1]!;
      const auth = authenticateDaemonHttp(req, machineId);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error });
        return;
      }
      let deviceId: string;
      try {
        deviceId = decodeURIComponent(deleteDeviceMatch[2]!);
      } catch {
        sendJson(res, 400, { error: "invalid_device_id" });
        return;
      }
      auth.room.devices.delete(deviceId);
      for (const [connId, peer] of auth.room.peers) {
        if (peer.role === "device" && peer.peerId === deviceId) {
          cleanupPeer(auth.room, connId, "device_revoked", true);
        }
      }
      sendJson(res, 200, { ok: true, revoked: deviceId });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  };
  const httpServer: Server = createServer((req, res) => {
    handleHttp(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { error: "bad_request" });
      else res.destroy();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_DAEMON_WS_FRAME_BYTES });

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      upgrade(req, socket, head);
    } catch {
      rejectUpgrade(socket, 400, "bad_request");
    }
  });
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (circuitTripped()) {
      rejectUpgrade(socket, 503, "relay_budget_exceeded");
      return;
    }
    const url = new URL(req.url ?? "/", "http://relay.invalid"); // never the Host header: a bad one must not throw
    if (url.pathname !== "/v1/connect") {
      rejectUpgrade(socket, 404, "not_found");
      return;
    }
    const token = bearerFrom(req);
    if (token === null) {
      rejectUpgrade(socket, 401, "missing_token");
      return;
    }
    const unverified = parseRelayTokenUnverified(token);
    if (unverified === null) {
      rejectUpgrade(socket, 401, "malformed_token");
      return;
    }
    const { machineId, role, deviceId, pairSessionId } = unverified.claims;
    const room = rooms.get(machineId);
    if (room === undefined) {
      rejectUpgrade(socket, 401, "unknown_machine");
      return;
    }
    let verifyKey: Buffer | undefined;
    if (role === "daemon" || role === "pair") {
      verifyKey = room.relayMachinePub;
    } else if (role === "device" && deviceId !== undefined) {
      verifyKey = room.devices.get(deviceId);
    }
    if (verifyKey === undefined) {
      rejectUpgrade(socket, 403, "unknown_or_revoked_device");
      return;
    }
    const verified = verifyRelayToken(token, verifyKey, Math.floor(nowMs() / 1000));
    if (!verified.ok) {
      rejectUpgrade(socket, 401, verified.reason);
      return;
    }
    if (role !== "daemon" && room.peers.size >= maxPhonesPerMachine) {
      rejectUpgrade(socket, 429, "too_many_peers");
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      attachSocket(room, ws, role, deviceId ?? pairSessionId ?? "daemon");
    });
  };

  const attachSocket = (room: MachineRoom, ws: WebSocket, role: RelayRole, peerId: string): void => {
    if (role === "daemon") {
      // Replace any previous daemon socket cleanly (authenticated by relayMachinePriv).
      if (room.daemon !== null && room.daemon.readyState === WebSocket.OPEN) {
        room.daemon.close(1000, "replaced_by_new_daemon");
      }
      if (room.daemonIdleTimer !== null) clearTimeout(room.daemonIdleTimer);
      room.daemon = ws;

      const resetDaemonIdle = () => {
        if (room.daemonIdleTimer !== null) clearTimeout(room.daemonIdleTimer);
        room.daemonIdleTimer = setTimeout(() => {
          if (room.daemon === ws) ws.close(1000, "idle_timeout");
        }, idleTimeoutMs);
        room.daemonIdleTimer.unref?.();
      };
      resetDaemonIdle();
      // A WebSocket ping (the daemon's keepalive; `ws` answers the pong itself) counts as activity, so an idle but
      // healthy daemon socket isn't closed and phones don't see the Mac flap between Unavailable and back.
      ws.on("ping", resetDaemonIdle);

      // Notify newly connected daemon of any already-waiting peers
      for (const peer of room.peers.values()) {
        const openEnv = encodeRelayEnvelope({
          op: RelayOp.PEER_OPEN,
          connId: peer.connId,
          payload: Buffer.from(JSON.stringify({ role: peer.role, id: peer.peerId }), "utf8"),
        });
        ws.send(openEnv, { binary: true });
      }

      ws.on("message", (raw, isBinary) => {
        resetDaemonIdle();
        if (!isBinary) {
          ws.close(1003, "binary_required");
          return;
        }
        const buf = rawDataToBuffer(raw);
        if (buf.length > MAX_DAEMON_WS_FRAME_BYTES) {
          ws.close(1009, "frame_too_large");
          return;
        }
        let env;
        try {
          env = decodeRelayEnvelope(buf);
        } catch {
          ws.close(1002, "invalid_envelope");
          return;
        }
        if (env.op === RelayOp.PEER_CLOSE) {
          cleanupPeer(room, env.connId, "closed_by_daemon", false);
          return;
        }
        if (env.op === RelayOp.PEER_DATA) {
          if (circuitTripped()) {
            ws.close(1013, "relay_budget_exceeded");
            return;
          }
          // The daemon's replies have their own bucket (phones can't drain it to get the daemon closed); over it, only
          // the phone being sent to is closed.
          const peer = room.peers.get(env.connId);
          if (peer !== undefined && !room.daemonByteBucket.tryConsume(env.payload.length, nowMs())) {
            cleanupPeer(room, env.connId, "rate_limited", true);
            return;
          }
          if (peer !== undefined && peer.ws.readyState === WebSocket.OPEN) {
            totalForwardedFrames += 1;
            peer.ws.send(env.payload, { binary: true });
          }
        }
      });

      ws.on("close", () => {
        if (room.daemon === ws) {
          room.daemon = null;
          if (room.daemonIdleTimer !== null) {
            clearTimeout(room.daemonIdleTimer);
            room.daemonIdleTimer = null;
          }
          // Close waiting peers cleanly so phones immediately enter truthful Unavailable state (ADR 0004).
          for (const connId of [...room.peers.keys()]) {
            cleanupPeer(room, connId, "daemon_disconnected", false);
          }
        }
      });
      return;
    }

    // Peer socket (`role=pair` or `role=device`)
    const connId = room.nextConnId++;
    const t0 = nowMs();
    const firstFrameTimer = setTimeout(() => {
      const p = room.peers.get(connId);
      if (p !== undefined && !p.receivedFirstFrame) {
        cleanupPeer(room, connId, "first_frame_timeout", true);
      }
    }, firstFrameDeadlineMs);
    firstFrameTimer.unref?.();

    const makeIdleTimer = () => {
      const timer = setTimeout(() => {
        cleanupPeer(room, connId, "idle_timeout", true);
      }, idleTimeoutMs);
      timer.unref?.();
      return timer;
    };

    const peer: PeerConn = {
      connId,
      ws,
      role,
      peerId,
      receivedFirstFrame: false,
      firstFrameTimer,
      idleTimer: makeIdleTimer(),
      frameBucket: new TokenBucket(phoneFramesPerMin, phoneFrameBurst, t0),
      byteBucket: new TokenBucket(phoneBytesPerMin, phoneByteBurst, t0),
    };
    room.peers.set(connId, peer);

    if (room.daemon !== null && room.daemon.readyState === WebSocket.OPEN) {
      const openEnv = encodeRelayEnvelope({
        op: RelayOp.PEER_OPEN,
        connId,
        payload: Buffer.from(JSON.stringify({ role, id: peerId }), "utf8"),
      });
      room.daemon.send(openEnv, { binary: true });
    }

    ws.on("message", (raw, isBinary) => {
      // A peer the relay already dropped can keep sending while its close handshake runs: none of it is forwarded.
      if (room.peers.get(connId) !== peer) return;
      clearTimeout(peer.idleTimer);
      peer.idleTimer = makeIdleTimer();
      if (!peer.receivedFirstFrame) {
        peer.receivedFirstFrame = true;
        clearTimeout(peer.firstFrameTimer);
      }
      if (!isBinary) {
        cleanupPeer(room, connId, "binary_required", true);
        return;
      }
      const buf = rawDataToBuffer(raw);
      if (buf.length > MAX_NOISE_MESSAGE_BYTES) {
        cleanupPeer(room, connId, "frame_too_large", true);
        return;
      }
      if (circuitTripped()) {
        cleanupPeer(room, connId, "relay_budget_exceeded", true);
        return;
      }
      const t = nowMs();
      if (
        !peer.frameBucket.tryConsume(1, t)
        || !peer.byteBucket.tryConsume(buf.length, t)
        || !room.machineFrameBucket.tryConsume(1, t)
        || !room.machineByteBucket.tryConsume(buf.length, t)
      ) {
        cleanupPeer(room, connId, "rate_limited", true);
        return;
      }
      if (room.daemon === null || room.daemon.readyState !== WebSocket.OPEN) {
        cleanupPeer(room, connId, "daemon_unavailable", false);
        return;
      }
      totalForwardedFrames += 1;
      const env = encodeRelayEnvelope({ op: RelayOp.PEER_DATA, connId, payload: buf });
      room.daemon.send(env, { binary: true });
    });

    ws.on("close", () => {
      cleanupPeer(room, connId, "peer_closed", true);
    });
  };

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const bindHost = opts.host ?? "127.0.0.1";

  return {
    url: `http://${bindHost}:${port}`,
    wsUrl: `ws://${bindHost}:${port}/v1/connect`,
    port,
    stats: () => ({ machines: rooms.size, totalForwardedFrames }),
    close: async () => {
      for (const room of rooms.values()) {
        if (room.daemonIdleTimer !== null) clearTimeout(room.daemonIdleTimer);
        for (const connId of [...room.peers.keys()]) {
          cleanupPeer(room, connId, "relay_shutdown", false);
        }
        room.daemon?.close(1001, "relay_shutdown");
      }
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    },
  };
}
