/**
 * A minimal Mac + phone client for the relay conformance suite: registration, tokens bound to the relay's audience,
 * WebSocket connects that report refusals (status, Toolroll-Relay-Error, headers), and buffered inboxes so no frame
 * is missed between awaits. Test-only; the real Mac client is src/companion/service.ts.
 */

import WebSocket from "ws";
import {
  decodeRelayEnvelope,
  ed25519Sign,
  encodeHeartbeat,
  encodeRelayEnvelope,
  generateEd25519KeyPair,
  RelayOp,
  signRegistrationPop,
  signRelayToken,
  type Ed25519KeyPair,
  type RelayEnvelope,
} from "../../src/companion/relay-auth.js";

export interface RelayTiming { phoneFirstFrameMs: number; phoneIdleMs: number; daemonSilenceMs: number }

export interface RelayTarget {
  name: string;
  url: string;
  wsUrl: string;
  /** The relay's public host: every token's `aud`. */
  publicHost: string;
  timing: RelayTiming;
  /** workerd (Cloudflare, Miniflare) never delivers a server-initiated close to a hibernated socket that has not sent
   * a single frame yet; clients therefore send a frame right after the upgrade (PROTOCOL.md "Clients send first"). */
  silentSocketMissesClose?: boolean;
  /** Rows the machine's replay cache holds (an inspection hook each target provides). */
  replayRows(machineId: string): Promise<number>;
  close(): Promise<void>;
}

export interface RelayTargetOptions {
  timing?: Partial<RelayTiming>;
  /** Per client address per minute (challenge + register). */
  registerPerMin?: number;
  /** Per machine + client address per minute (connect + admission calls). */
  connectPerMin?: number;
  /** Per client address per minute across every machine (connect + admission calls). */
  clientPerMin?: number;
}

export type RelayTargetFactory = (opts: RelayTargetOptions) => Promise<RelayTarget>;

/** A bound on how long a test waits for a fact (a frame, a close): a ceiling, not the thing waited on. */
export const WAIT_BOUND_MS = 10_000;

export function bounded<T>(promise: Promise<T>, what: string, ms = WAIT_BOUND_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); }),
  ]);
}

export interface Machine {
  machineId: string;
  key: Ed25519KeyPair;
}

export async function register(target: RelayTarget, key: Ed25519KeyPair = generateEd25519KeyPair()): Promise<Machine> {
  const chal = await fetch(`${target.url}/v1/challenge`, { method: "POST" });
  if (chal.status !== 200) throw new Error(`challenge answered ${chal.status}`);
  const { challenge } = (await chal.json()) as { challenge: string };
  const res = await fetch(`${target.url}/v1/machines/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      relayMachinePub: key.publicKey.toString("base64url"),
      challenge,
      signature: signRegistrationPop(key.privateKey, target.publicHost, challenge),
    }),
  });
  if (res.status !== 200) throw new Error(`register answered ${res.status}`);
  const { machineId } = (await res.json()) as { machineId: string };
  return { machineId, key };
}

type Signer = Parameters<typeof signRelayToken>[1];

/** A token for this relay (aud = its public host); `over` replaces or adds claims before signing. */
export function token(target: RelayTarget, privateKey: Buffer, claims: Omit<Signer, "aud"> & { aud?: string }): string {
  return signRelayToken(privateKey, { aud: target.publicHost, ...claims } as Signer);
}

export function daemonWsToken(target: RelayTarget, m: Machine, extra: Partial<Signer> = {}): string {
  return token(target, m.key.privateKey, { role: "daemon", machineId: m.machineId, ...extra });
}

export function adminToken(target: RelayTarget, m: Machine, method: "PUT" | "POST" | "DELETE", path: string, extra: Partial<Signer> = {}): string {
  return token(target, m.key.privateKey, { role: "daemon", machineId: m.machineId, htm: method, htu: path, ...extra });
}

/** Signs an arbitrary claims object (for malformed-claims cases). */
export function rawToken(privateKey: Buffer, claims: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${encoded}.${ed25519Sign(privateKey, Buffer.from(`tr-relay-v1.${encoded}`, "ascii")).toString("base64url")}`;
}

export interface Refused { status: number; code: string | null; headers: Record<string, string | string[] | undefined>; body: string }

export function connect(target: RelayTarget, bearer?: string, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; refused?: never } | { refused: Refused; ws?: never }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.wsUrl, { headers: { ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}), ...headers } });
    ws.once("open", () => resolve({ ws }));
    ws.once("unexpected-response", (req, res) => {
      let body = "";
      // With this listener attached, ws leaves the refused request's socket open; a keep-alive server (Cloudflare)
      // then holds it forever and the process (the post-deploy smoke test) never exits.
      res.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      res.on("end", () => {
        req.socket?.destroy();
        const code = res.headers["toolroll-relay-error"];
        resolve({ refused: { status: res.statusCode ?? 0, code: typeof code === "string" ? code : null, headers: res.headers, body } });
      });
      res.on("error", () => { req.socket?.destroy(); resolve({ refused: { status: res.statusCode ?? 0, code: null, headers: res.headers, body } }); });
    });
    ws.once("error", error => reject(error));
  });
}

export async function connectOk(target: RelayTarget, bearer: string): Promise<WebSocket> {
  const result = await connect(target, bearer);
  if (result.refused !== undefined) throw new Error(`connect refused ${result.refused.status} ${result.refused.code}`);
  return result.ws;
}

export async function refusedWith(target: RelayTarget, bearer?: string): Promise<Refused> {
  const result = await connect(target, bearer);
  if (result.ws !== undefined) { result.ws.terminate(); throw new Error("connect unexpectedly accepted"); }
  return result.refused;
}

export interface Closed { code: number; reason: string }

/** Records the socket's close the moment it happens, so a test can await it later without a race. */
export function closeOf(ws: WebSocket): Promise<Closed> {
  const existing = (ws as unknown as { __closed?: Promise<Closed> }).__closed;
  if (existing !== undefined) return existing;
  const promise = new Promise<Closed>(resolve => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") })));
  (ws as unknown as { __closed?: Promise<Closed> }).__closed = promise;
  return promise;
}

/** Every binary frame a socket receives, buffered; `next` takes them in order. */
export class Inbox {
  private readonly frames: Buffer[] = [];
  private waiters: Array<(frame: Buffer) => void> = [];
  readonly closed: Promise<Closed>;
  constructor(readonly ws: WebSocket) {
    this.closed = closeOf(ws);
    ws.on("message", data => {
      const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(frame); else this.frames.push(frame);
    });
  }
  next(what = "a frame"): Promise<Buffer> {
    const ready = this.frames.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return bounded(new Promise<Buffer>(resolve => this.waiters.push(resolve)), what);
  }
  get pending(): number { return this.frames.length; }
}

/** The daemon's view: envelopes in, helpers out. */
export class Daemon {
  readonly inbox: Inbox;
  constructor(readonly ws: WebSocket) { this.inbox = new Inbox(ws); }
  async envelope(what = "an envelope"): Promise<RelayEnvelope> {
    return decodeRelayEnvelope(await this.inbox.next(what));
  }
  async expect(op: number, what?: string): Promise<RelayEnvelope> {
    const env = await this.envelope(what ?? `op ${op}`);
    if (env.op !== op) throw new Error(`expected op ${op}, got ${env.op} (${env.payload.toString("utf8").slice(0, 80)})`);
    return env;
  }
  send(op: number, connId: number, payload: Buffer): void {
    this.ws.send(encodeRelayEnvelope({ op: op as RelayEnvelope["op"], connId, payload }), { binary: true });
  }
  data(connId: number, payload: Buffer): void { this.send(RelayOp.PEER_DATA, connId, payload); }
  heartbeat(nowMs: number): void { this.ws.send(encodeHeartbeat(nowMs), { binary: true }); }
  get closed(): Promise<Closed> { return this.inbox.closed; }
}

/** Connects the daemon the way the Mac does: its first HEARTBEAT goes out right after the upgrade (and its ACK is
 * awaited, so the relay has seen the socket's first frame). */
export async function connectDaemon(target: RelayTarget, m: Machine): Promise<Daemon> {
  const daemon = new Daemon(await connectOk(target, daemonWsToken(target, m)));
  daemon.heartbeat(Date.now());
  await daemon.expect(RelayOp.HEARTBEAT_ACK, "the first HEARTBEAT_ACK");
  return daemon;
}

/** An admission call with a fresh daemon token bound to its method and path. */
export async function admin(target: RelayTarget, m: Machine, method: "PUT" | "POST" | "DELETE", path: string, body?: unknown, bearer?: string): Promise<Response> {
  return fetch(`${target.url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer ?? adminToken(target, m, method, path)}` },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

export interface Phone { deviceId: string; key: Ed25519KeyPair }

export function newPhone(deviceId = `dev_${Math.random().toString(36).slice(2, 10)}`): Phone {
  return { deviceId, key: generateEd25519KeyPair() };
}

export function deviceToken(target: RelayTarget, m: Machine, phone: Phone, extra: Partial<Signer> = {}): string {
  return token(target, phone.key.privateKey, { role: "device", machineId: m.machineId, deviceId: phone.deviceId, ...extra });
}

export async function admit(target: RelayTarget, m: Machine, phones: Phone[]): Promise<void> {
  const res = await admin(target, m, "PUT", `/v1/machines/${m.machineId}/devices`, {
    devices: phones.map(p => ({ deviceId: p.deviceId, deviceRelayPub: p.key.publicKey.toString("base64url") })),
  });
  if (res.status !== 200) throw new Error(`PUT devices answered ${res.status} ${res.headers.get("toolroll-relay-error")}`);
}

/** Connects a device socket the way the phone does — its first frame (Noise message 1) right after the upgrade — and
 * returns it with the connId the daemon was told about. The daemon has consumed PEER_OPEN and that first PEER_DATA. */
export async function openPhone(target: RelayTarget, m: Machine, daemon: Daemon, phone: Phone): Promise<{ ws: WebSocket; inbox: Inbox; connId: number }> {
  const { ws, inbox, connId } = await openSilentPhone(target, m, daemon, phone);
  await sendBinary(ws, Buffer.from("msg1"));
  const first = await daemon.expect(RelayOp.PEER_DATA, "the phone's first frame");
  if (first.connId !== connId) throw new Error(`first frame on connId ${first.connId}, expected ${connId}`);
  return { ws, inbox, connId };
}

/** Connects a device socket that sends nothing (for first-frame deadline cases). */
export async function openSilentPhone(target: RelayTarget, m: Machine, daemon: Daemon, phone: Phone): Promise<{ ws: WebSocket; inbox: Inbox; connId: number }> {
  const ws = await connectOk(target, deviceToken(target, m, phone));
  const inbox = new Inbox(ws);
  const open = await daemon.expect(RelayOp.PEER_OPEN, "PEER_OPEN");
  const info = JSON.parse(open.payload.toString("utf8")) as { role: string; id: string };
  if (info.role !== "device" || info.id !== phone.deviceId) throw new Error(`PEER_OPEN for ${info.role}/${info.id}`);
  return { ws, inbox, connId: open.connId };
}

export function sendBinary(ws: WebSocket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => ws.send(data, { binary: true }, error => (error ? reject(error) : resolve())));
}
