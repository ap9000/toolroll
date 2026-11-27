/**
 * Phone access for this console: the companion engine (daemon.ts) reachable two ways.
 *
 * - **Direct** (direct-server.ts): a listener on this Mac's network (port 4199 by default, then 4200–4209 if that is
 *   taken; the bound port is remembered) that a phone on the same Wi-Fi, or on this Mac's tailnet, connects straight to.
 *   No relay and no relay tokens: Noise from the first message. Advertised on the local network over Bonjour.
 * - **Hosted** (optional): one outbound WebSocket to an end-to-end encrypted relay (wss://relay.toolroll.dev unless
 *   configured otherwise) as this machine's daemon, for a phone anywhere else. The service keeps the relay's set of
 *   admitted phones exactly equal to this workspace's live and pending paired devices (a full PUT on every connect,
 *   every 10 minutes and after any change it couldn't deliver; POST on a confirmed pairing; DELETE on removal),
 *   registers the machine only when the relay says it doesn't know it, proves the socket alive with an application
 *   heartbeat, and passes every routed envelope to the engine.
 *
 * Each path starts, fails and reports on its own: a port in use doesn't stop the hosted path; an unreachable relay
 * doesn't stop the direct one. A dropped relay socket drops only the phone sessions and pairings riding it.
 */

import type { Socket } from "node:net";
import { WebSocket } from "ws";
import { CompanionDaemonEngine, relayEnvelopeLink, type CompanionReadHandlers, type PairingQrPayload, type PeerLink } from "./daemon.js";
import { startDirectServer, type RunningDirectServer } from "./direct-server.js";
import { startBonjour, type BonjourAdvert, type Spawner } from "./bonjour.js";
import { PACING_PER_HOSTED_LINK, TokenBucket } from "./framing.js";
import { buildPaths, interfaceOf, lanInterfacesOf, type CompanionPath } from "./paths.js";
import { encodeRelayEnvelope, RelayOp, signRegistrationPop, signRelayToken } from "./relay-auth.js";
import { getPairedDevice, livePairedDevices, type CompanionHostKeys, type PairedDeviceRow } from "./store.js";
import { readTailnetStatus } from "../tailnet.js";
import type { Store } from "../store.js";

export interface DirectAddress { address: string; kind: "lan" | "tailnet"; interface: string }

export interface DirectPathState {
  state: "listening" | "failed" | "off";
  port: number | null;
  error: string | null;
  addresses: DirectAddress[];
  tailscale: "found" | "not_found";
}

export type HostedPathState =
  | { state: "off"; superseded: boolean }
  | { state: "starting"; relay: string; superseded: boolean }
  | { state: "connected"; relay: string; since: string; superseded: boolean }
  | { state: "unreachable"; relay: string; error: string; retryAt: string; superseded: boolean };

export interface CompanionServiceStatus {
  running: boolean;
  direct: DirectPathState;
  hosted: HostedPathState;
}

export interface CompanionServiceOptions {
  store: Store;
  reads: CompanionReadHandlers;
  /** The direct listener (null: no direct path): the configured port, then `fallbackPorts` in order if it is taken.
   * `preferredPort` (the last bound one) is tried first when it is one of those; `onBound` hears the port it got. */
  direct: { port: number; host?: string; fallbackPorts?: readonly number[]; preferredPort?: number | null; onBound?: (port: number) => void } | null;
  /** The hosted relay's URL (null: no hosted path). */
  hosted: string | null;
  log?: (line: string) => void;
  nowMs?: () => number;
  /** This console's own address, for the phone's Handoff links (device.hello's `consoleUrl`). */
  consoleUrl?: () => string | null;
  /** Advertise the direct listener over Bonjour (off unless asked: tests never advertise on a real network). */
  bonjour?: boolean | { spawn?: Spawner; platform?: NodeJS.Platform };
  /** Test seam: the backoff's first and largest waits (ms). */
  backoff?: { first: number; max: number };
  /** Test seam: the backoff after another daemon with these keys replaced this one at the relay (4409). */
  supersededBackoff?: { first: number; max: number };
  /** Test seam: how often a heartbeat goes to the relay, and how long without its ACK before reconnecting. */
  heartbeat?: { intervalMs: number; timeoutMs: number };
  /** Test seam: the interval of the full re-PUT of admitted phones while connected. */
  repushMs?: number;
  /** Test seam: the interval of the record sweep (tombstones, pending rows). */
  sweepMs?: number;
  /** Test seams: this Mac's LAN addresses and Tailscale address, and how a direct socket's peer address is read. */
  lanAddresses?: () => string[];
  tailnetIpv4?: () => Promise<string | null>;
  directPeerAddressOf?: (socket: Socket) => string | undefined;
}

/** The relay's HTTP base and WebSocket connect address for a configured `wss://host[/…]` or `ws://…` URL. `host` is
 * the relay's public host as tokens name it (`aud`) and registration signs it. */
export function relayAddressesOf(url: string): { http: string; ws: string; host: string } {
  const parsed = new URL(url);
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:" && parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("A relay URL starts with wss:// (or ws:// on this computer).");
  }
  const secure = parsed.protocol === "wss:" || parsed.protocol === "https:";
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (!secure && !loopback) throw new Error("A relay off this computer needs TLS (wss://).");
  const base = `${secure ? "https" : "http"}://${parsed.host}`;
  return { http: base, ws: `${secure ? "wss" : "ws"}://${parsed.host}/v1/connect`, host: parsed.host.toLowerCase() };
}

const TAILNET_REFRESH_MS = 10_000;
/** Bytes queued for the relay before the connection is treated as stalled and reopened. */
const RELAY_BACKLOG_CAP = 16 * 1024 * 1024;
const HEARTBEAT = { intervalMs: 20_000, timeoutMs: 45_000 };
const REPUSH_MS = 10 * 60 * 1000;
const SWEEP_MS = 60 * 60 * 1000;
const SUPERSEDED_BACKOFF = { first: 30_000, max: 10 * 60 * 1000 };
/** A connection that lasts this long ends a run of 4409s: the backoff after the next one starts over. */
const SUPERSEDED_SETTLED_MS = 10 * 60 * 1000;
const CLOSE_SUPERSEDED = 4409;
/** Relay admission calls: how long one may take, and a best-effort machine removal. */
const RELAY_CALL_MS = 10_000;
const FORGET_MACHINE_MS = 5_000;

/** A relay's refusal, with its code (`Toolroll-Relay-Error`, protocol §3.1). */
export class RelayHttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfterMs: number | null) {
    super(`the relay answered ${status}: ${describeRelayCode(code)}`);
  }
}

/** A relay refusal code in words for Settings. */
export function describeRelayCode(code: string): string {
  switch (code) {
    case "token_expired":
    case "token_not_yet_valid": return "this Mac's clock looks wrong — check Date & Time";
    case "token_invalid": return "it didn't accept this Mac's credentials";
    case "rate_limited":
    case "too_many_peers":
    case "replay_cache_full": return "it asked Toolroll to slow down";
    case "machine_unknown": return "it doesn't know this Mac yet";
    case "bad_request": return "it refused the request";
    case "daemon_unavailable": return "it has no connection from this Mac";
    default: return /^[a-z_]{1,40}$/.test(code) ? code.replace(/_/g, " ") : "an unexpected answer";
  }
}

function refusalOf(status: number, headers: { get(name: string): string | null }, body: string, nowMs: number): RelayHttpError {
  let code = headers.get("toolroll-relay-error")?.trim() ?? "";
  if (code === "") {
    try { const parsed = JSON.parse(body) as { error?: unknown }; if (typeof parsed.error === "string") code = parsed.error; } catch { /* no body code */ }
  }
  if (!/^[a-z_]{1,40}$/.test(code)) code = `http_${status}`;
  const retryAfter = headers.get("retry-after");
  let retryAfterMs: number | null = null;
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = Math.min(seconds, 3600) * 1000;
    else if (!Number.isNaN(Date.parse(retryAfter))) retryAfterMs = Math.max(0, Math.min(Date.parse(retryAfter) - nowMs, 3_600_000));
  }
  return new RelayHttpError(status, code, retryAfterMs);
}

/** The relay doesn't know this machine (it restarted empty, or its room was removed): register, then carry on. The
 * `unknown_machine` 401 is the reference relay's answer before the relay contract's codes (stream A) — drop it once
 * every relay sends 404 `machine_unknown`. */
const machineUnknown = (error: unknown): boolean =>
  error instanceof RelayHttpError && ((error.status === 404 && error.code === "machine_unknown") || error.code === "unknown_machine");

/** A daemon token for a relay: `aud` its host; an HTTP admission call's also names its method and exact path. */
function daemonTokenFor(keys: CompanionHostKeys, aud: string, call?: { htm: "PUT" | "POST" | "DELETE"; htu: string }): string {
  return signRelayToken(keys.relayPriv, { role: "daemon", machineId: keys.machineId, aud, ...(call ?? {}), ttlSec: 60 });
}

/**
 * Asks a relay to forget this machine entirely (`DELETE /v1/machines/:id`, protocol §3.6): when hosted access is turned
 * off, and before a restore retires this Mac's keys. Best effort, bounded: false when it didn't land.
 */
export async function forgetMachineOnRelay(relayUrl: string, keys: CompanionHostKeys, timeoutMs = FORGET_MACHINE_MS): Promise<boolean> {
  try {
    const addresses = relayAddressesOf(relayUrl);
    const path = `/v1/machines/${keys.machineId}`;
    const response = await fetch(`${addresses.http}${path}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${daemonTokenFor(keys, addresses.host, { htm: "DELETE", htu: path })}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    await response.arrayBuffer().catch(() => null);
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export class CompanionService {
  readonly engine: CompanionDaemonEngine;
  private readonly store: Store;
  private readonly opts: CompanionServiceOptions;
  private readonly log: (line: string) => void;
  private readonly nowMs: () => number;
  private readonly backoff: { first: number; max: number };
  private readonly supersededBackoff: { first: number; max: number };
  private readonly heartbeat: { intervalMs: number; timeoutMs: number };
  private readonly addresses: { http: string; ws: string; host: string } | null;
  private directServer: RunningDirectServer | null = null;
  private bonjour: BonjourAdvert | null = null;
  private directPort: number | null = null;
  private directError: string | null = null;
  private socket: WebSocket | null = null;
  private link: PeerLink | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private sweep: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private supersededAttempt = 0;
  private superseded = false;
  /** Bumped by every connect and every stop: an older connect that finishes late sees it moved on and stands down. */
  private connectGeneration = 0;
  private stopped = true;
  private hostedState: HostedPathState = { state: "off", superseded: false };
  /** Changes to the relay's admitted set run one at a time, each reading the live device set when it runs. */
  private admission: Promise<void> = Promise.resolve();
  /** A change the relay didn't hear yet: a fresh full-set PUT is owed (retried while connected, and on reconnect). */
  private reconcileOwed = false;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileAttempt = 0;
  private tailnet: { ip: string | null; found: boolean; at: number } = { ip: null, found: false, at: -Infinity };

  constructor(opts: CompanionServiceOptions) {
    this.store = opts.store;
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.backoff = opts.backoff ?? { first: 1_000, max: 60_000 };
    this.supersededBackoff = opts.supersededBackoff ?? SUPERSEDED_BACKOFF;
    this.heartbeat = opts.heartbeat ?? HEARTBEAT;
    this.addresses = opts.hosted === null ? null : relayAddressesOf(opts.hosted);
    this.engine = new CompanionDaemonEngine({
      store: opts.store,
      handlers: opts.reads,
      // A confirmed pairing: the connected hosted relay must admit the phone before the phone is told (a refusal fails
      // the pairing). A relay that isn't connected right now learns of it from the full PUT on its next connect.
      onDeviceRegistered: async (deviceId, deviceRelayPub) => {
        if (this.addresses === null) return;
        if (this.socket === null || this.link === null) { this.oweReconcile(); return; }
        await this.admit(() => this.relayRequest("POST", `/v1/machines/${this.engine.hostKeys.machineId}/devices`, { deviceId, deviceRelayPub }));
      },
      onDeviceRevoked: async deviceId => {
        if (this.addresses === null) return;
        try {
          await this.admit(() => this.relayRequest("DELETE", `/v1/machines/${this.engine.hostKeys.machineId}/devices/${encodeURIComponent(deviceId)}`));
        } catch (error) {
          // Already gone at the relay is as good as removed; anything else is settled by a fresh full PUT.
          if (!(error instanceof RelayHttpError && error.status === 404)) this.oweReconcile();
        }
      },
      ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }),
      ...(opts.consoleUrl === undefined ? {} : { consoleUrl: opts.consoleUrl }),
    });
    this.engine.setPathsProvider(() => this.paths());
  }

  /** What Settings shows. */
  status(): CompanionServiceStatus {
    return { running: !this.stopped, direct: this.directStatus(), hosted: this.hostedState };
  }

  private directStatus(): DirectPathState {
    void this.refreshTailnet();
    const tailscale = this.tailnet.found ? "found" as const : "not_found" as const;
    if (this.directServer !== null && this.directPort !== null) {
      return { state: "listening", port: this.directPort, error: null, addresses: this.directAddressList(), tailscale };
    }
    if (this.directError !== null) return { state: "failed", port: null, error: this.directError, addresses: [], tailscale };
    return { state: "off", port: null, error: null, addresses: [], tailscale };
  }

  private directAddressList(): DirectAddress[] {
    const lan = this.opts.lanAddresses === undefined
      ? lanInterfacesOf()
      : this.opts.lanAddresses().map(address => ({ address, interface: interfaceOf(address) ?? "unknown" }));
    const out: DirectAddress[] = lan.map(one => ({ address: one.address, kind: "lan", interface: one.interface }));
    if (this.tailnet.ip !== null) out.push({ address: this.tailnet.ip, kind: "tailnet", interface: interfaceOf(this.tailnet.ip) ?? "tailscale" });
    return out;
  }

  /** This Mac's addresses a phone on the same network can use (empty when the direct path isn't listening). */
  directAddresses(): string[] {
    return this.paths().filter(path => path.kind === "direct").map(path => new URL(path.url).host);
  }

  /** The ways a phone can reach this Mac: direct addresses first, then the approved hosted relay — listed even while
   * it's briefly unreachable, so a phone that saves this list (every hello) keeps its way back from elsewhere. */
  paths(): CompanionPath[] {
    void this.refreshTailnet();
    const lan = this.opts.lanAddresses === undefined ? lanInterfacesOf().map(one => one.address) : this.opts.lanAddresses();
    return buildPaths({
      port: this.directServer === null ? null : this.directPort,
      lan,
      tailnet: this.tailnet.ip,
      hosted: this.addresses?.ws ?? null,
    });
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.refreshTailnet(true);
    // Tombstones past their 30 days and pending phones nobody finished go now and hourly, whether or not a phone is on.
    this.runSweep();
    this.sweep = setInterval(() => this.runSweep(), this.opts.sweepMs ?? SWEEP_MS);
    this.sweep.unref?.();
    if (this.opts.direct !== null) await this.startDirect(this.opts.direct);
    if (this.addresses !== null) {
      this.hostedState = { state: "starting", relay: this.addresses.ws, superseded: this.superseded };
      void this.connect();
    }
  }

  private runSweep(): void {
    try { this.engine.sweepRecords(); } catch (error) { this.log(`phone access: record sweep failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private async startDirect(direct: NonNullable<CompanionServiceOptions["direct"]>): Promise<void> {
    const candidates = [direct.port, ...(direct.fallbackPorts ?? [])];
    const order = direct.preferredPort != null && candidates.includes(direct.preferredPort) ? [direct.preferredPort, ...candidates] : candidates;
    const ports = [...new Set(order)];
    const busy: number[] = [];
    this.directError = null;
    for (const port of ports) {
      try {
        const server = await startDirectServer({
          engine: this.engine, port, log: this.log,
          ...(direct.host === undefined ? {} : { host: direct.host }),
          ...(this.opts.directPeerAddressOf === undefined ? {} : { peerAddressOf: this.opts.directPeerAddressOf }),
        });
        if (this.stopped) { await server.close(); return; }
        this.directServer = server;
        this.directPort = server.port;
        direct.onBound?.(server.port);
        this.startBonjour(server.port);
        return;
      } catch (error) {
        if ((error as { code?: unknown }).code === "EADDRINUSE") { busy.push(port); continue; }
        this.directError = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    if (this.directError === null) {
      this.directError = busy.length === 1
        ? `Port ${busy[0]} on this computer is in use. Set TOOLROLL_PHONE_PORT to another port and restart Toolroll.`
        : `Ports ${busy[0]} and ${busy.slice(1).join(", ")} on this computer are all in use. Set TOOLROLL_PHONE_PORT to a free port and restart Toolroll.`;
    }
    this.log(`phone access: direct listener didn't start (${this.directError})`);
  }

  private startBonjour(port: number): void {
    const want = this.opts.bonjour;
    if (want === undefined || want === false) return;
    this.bonjour = startBonjour({
      port, machineId: this.engine.hostKeys.machineId, log: this.log,
      ...(typeof want === "object" && want.spawn !== undefined ? { spawn: want.spawn } : {}),
      ...(typeof want === "object" && want.platform !== undefined ? { platform: want.platform } : {}),
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connectGeneration += 1;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.sweep !== null) clearInterval(this.sweep);
    this.sweep = null;
    this.closeSocket("stopping");
    this.engine.handleRelayDisconnected();
    // Nothing queued for the relay runs after this (admit refuses once stopped), and a write already in flight settles
    // before the caller starts a replacement service that owns the relay's admitted set.
    await this.admission;
    this.bonjour?.stop();
    this.bonjour = null;
    if (this.directServer !== null) {
      const server = this.directServer;
      this.directServer = null;
      await server.close();
    }
    this.directPort = null;
    this.directError = null;
    this.hostedState = { state: "off", superseded: false };
  }

  /** Hosted access is being turned off (or phone access with it): the relay is asked to forget this machine (§3.6).
   * Best effort, bounded; the caller stops the service after. */
  async forgetHostedMachine(): Promise<boolean> {
    if (this.opts.hosted === null) return false;
    return forgetMachineOnRelay(this.opts.hosted, this.engine.hostKeys);
  }

  startPairing(accountName: string, binding: string, accountGeneration: number): { ok: true; qr: PairingQrPayload; expiresAtMs: number } | { ok: false; error: string } {
    if (this.directServer === null && this.hostedState.state !== "connected") {
      return { ok: false, error: this.hostedState.state === "starting" ? "Phone access is still starting. Try again in a moment." : "A phone has no way to reach this Mac right now." };
    }
    return this.engine.startPairing(accountName, binding, accountGeneration);
  }

  /** Removes one of the account's phones: retired in SQLite and its sessions ended before this returns; the relays are
   * told in the background (a slow relay never holds Settings up). False when it isn't that account's live phone. */
  removePhone(deviceId: string, accountName: string): boolean {
    const device = getPairedDevice(this.store.handle, deviceId);
    if (device === null || device.accountName !== accountName || device.revokedAt !== null) return false;
    return this.engine.revokeDevice(deviceId, "removed");
  }

  devices(): PairedDeviceRow[] {
    return livePairedDevices(this.store, { now: new Date(this.nowMs()) });
  }

  private refreshTailnet(wait = false): Promise<void> {
    if (!wait && this.nowMs() - this.tailnet.at < TAILNET_REFRESH_MS) return Promise.resolve();
    this.tailnet.at = this.nowMs();
    const probe = this.opts.tailnetIpv4 !== undefined
      ? this.opts.tailnetIpv4().then(ip => ({ found: ip !== null, ipv4: ip }))
      : readTailnetStatus();
    const read = probe.then(found => { this.tailnet.ip = found.ipv4; this.tailnet.found = found.found; }, () => {});
    return wait ? read : Promise.resolve();
  }

  /** Serializes one change to the relay's admitted set; the result (or failure) is the caller's. */
  private admit<T>(work: () => Promise<T>): Promise<T> {
    const fenced = () => this.stopped ? Promise.reject(new Error("phone access stopped")) : work();
    const run = this.admission.then(fenced, fenced);
    this.admission = run.then(() => {}, () => {});
    return run;
  }

  /** A change didn't reach the relay: a fresh full-set PUT, retried with backoff while connected (and on reconnect). */
  private oweReconcile(): void {
    this.reconcileOwed = true;
    if (this.reconcileTimer !== null || this.stopped || this.socket === null) return;
    const wait = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconcileAttempt, 5));
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      if (this.stopped || this.socket === null || !this.reconcileOwed) return;
      this.reconcile().then(() => { this.reconcileAttempt = 0; }, () => { this.reconcileAttempt += 1; this.oweReconcile(); });
    }, wait);
    this.reconcileTimer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.addresses === null) return;
    const generation = ++this.connectGeneration;
    const current = () => !this.stopped && generation === this.connectGeneration;
    const relay = this.addresses.ws;
    try {
      // The full admitted set first (registering only if the relay says it doesn't know this machine).
      await this.reconcile();
      if (!current()) return;
      const socket = await this.openSocket();
      if (!current()) { socket.close(1000, "stopping"); return; }
      // The relay socket carries every phone, so its queue says nothing about any one of them: no phone is dropped for
      // it (each is bounded by its own credit and 1 MiB of held responses, and paced). A queue past the hard cap means
      // the relay itself has stalled: the socket is closed and reconnected rather than allowed to grow.
      const send = (envelope: Buffer) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > RELAY_BACKLOG_CAP) { socket.close(1013, "relay_backlog"); return; }
        socket.send(envelope, { binary: true });
      };
      const link = relayEnvelopeLink(`hosted#${generation}`, send, { pacing: new TokenBucket(PACING_PER_HOSTED_LINK.ratePerMin, PACING_PER_HOSTED_LINK.burst, this.nowMs()) });
      this.socket = socket;
      this.link = link;
      this.attempt = 0;
      const connectedAt = this.nowMs();
      this.superseded = false;
      this.hostedState = { state: "connected", relay, since: new Date(connectedAt).toISOString(), superseded: false };
      this.log(`phone access: connected to ${relay}`);

      // Liveness (protocol §3.5): a HEARTBEAT every 20 s; 45 s without its ACK means the socket is dead (a half-open TCP
      // connection after sleep or a network change) — it is torn down and the close handler reconnects.
      let lastAckAt = connectedAt;
      let lastBeatAt = -Infinity;
      let lastRepushAt = connectedAt;
      let lastAdmissionCheckAt = connectedAt;
      let admitted = JSON.stringify(this.engine.admittedDevices());
      const tickMs = Math.max(5, Math.min(5_000, Math.floor(this.heartbeat.intervalMs / 4)));
      this.keepalive = setInterval(() => {
        const now = this.nowMs();
        if (now - lastAckAt > this.heartbeat.timeoutMs) {
          this.log("phone access: the relay stopped answering heartbeats; reconnecting");
          socket.terminate();
          return;
        }
        if (now - lastBeatAt >= this.heartbeat.intervalMs) {
          lastBeatAt = now;
          const stamp = Buffer.alloc(8);
          stamp.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(now))));
          send(encodeRelayEnvelope({ op: RelayOp.HEARTBEAT, connId: 0, payload: stamp }));
        }
        // The full set again every 10 minutes: the relay's copy can't drift for long (a relay that lost a write, a
        // replayed token that changed it).
        if (now - lastRepushAt >= (this.opts.repushMs ?? REPUSH_MS)) { lastRepushAt = now; this.oweReconcile(); }
        // A phone retired outside this service (an account's password or access changed, another console removed it):
        // the relay is told within one heartbeat interval rather than at the next reconnect.
        if (now - lastAdmissionCheckAt >= this.heartbeat.intervalMs) {
          lastAdmissionCheckAt = now;
          const nowAdmitted = JSON.stringify(this.engine.admittedDevices());
          if (nowAdmitted !== admitted) { admitted = nowAdmitted; this.oweReconcile(); }
        }
      }, tickMs);
      this.keepalive.unref?.();
      // A change that failed while the socket was opening: settle it now.
      if (this.reconcileOwed) this.oweReconcile();
      socket.on("message", (raw, isBinary) => {
        if (!isBinary) return;
        const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        if (buf.length >= 5 && buf[0] === RelayOp.HEARTBEAT_ACK) { lastAckAt = this.nowMs(); return; }
        this.engine.handleRelayEnvelope(buf, link).catch(error => this.log(`phone access: envelope failed: ${error instanceof Error ? error.message : String(error)}`));
      });
      socket.on("close", (code, reason) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.link = null;
        if (this.keepalive !== null) clearInterval(this.keepalive);
        this.keepalive = null;
        if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
        this.reconcileTimer = null;
        this.engine.handleRelayDisconnected(link);
        if (this.stopped) return;
        if (code === CLOSE_SUPERSEDED) {
          if (this.nowMs() - connectedAt >= SUPERSEDED_SETTLED_MS) this.supersededAttempt = 0;
          this.scheduleSuperseded();
          return;
        }
        this.scheduleRetry(`the relay closed the connection${reason.length > 0 ? ` (${reason.toString("utf8")})` : ""}`);
      });
      socket.on("error", () => { /* "close" follows */ });
    } catch (error) {
      if (current()) this.scheduleRetry(error instanceof Error ? error.message : String(error), error instanceof RelayHttpError ? error.retryAfterMs : null);
    }
  }

  private scheduleRetry(error: string, retryAfterMs: number | null = null): void {
    if (this.stopped || this.addresses === null) return;
    this.attempt += 1;
    const ceiling = Math.min(this.backoff.max, this.backoff.first * 2 ** Math.min(this.attempt - 1, 16));
    const wait = Math.max(Math.round(ceiling / 2 + Math.random() * (ceiling / 2)), retryAfterMs ?? 0);
    this.hostedState = { state: "unreachable", relay: this.addresses.ws, error, retryAt: new Date(this.nowMs() + wait).toISOString(), superseded: this.superseded };
    this.log(`phone access: relay unreachable (${error}); retrying in ${Math.round(wait / 1000)} s`);
    this.armRetry(wait);
  }

  /** Another Toolroll holding this workspace's keys took the relay's daemon slot (4409): two copies would evict each
   * other forever, so this one waits — 30 s, doubling to 10 minutes — and Settings says why. */
  private scheduleSuperseded(): void {
    if (this.stopped || this.addresses === null) return;
    this.superseded = true;
    this.supersededAttempt += 1;
    const wait = Math.min(this.supersededBackoff.max, this.supersededBackoff.first * 2 ** Math.min(this.supersededAttempt - 1, 16));
    const error = "Another Toolroll with this workspace's keys is connected to the relay.";
    this.hostedState = { state: "unreachable", relay: this.addresses.ws, error, retryAt: new Date(this.nowMs() + wait).toISOString(), superseded: true };
    this.log(`phone access: ${error} Trying again in ${Math.round(wait / 1000)} s`);
    this.armRetry(wait);
  }

  private armRetry(wait: number): void {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, wait);
    this.retry.unref?.();
  }

  private closeSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.link = null;
    if (this.keepalive !== null) clearInterval(this.keepalive);
    this.keepalive = null;
    if (socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close(1000, reason);
  }

  private daemonToken(call?: { htm: "PUT" | "POST" | "DELETE"; htu: string }): string {
    return daemonTokenFor(this.engine.hostKeys, this.addresses!.host, call);
  }

  /** Proves this machine owns its id at the relay (a fresh single-use challenge, signed with the machine key). */
  private async register(): Promise<void> {
    const challenge = await this.relayRequest("POST", "/v1/challenge", undefined, false) as { challenge?: unknown };
    if (typeof challenge.challenge !== "string") throw new Error("the relay sent no registration challenge");
    const keys = this.engine.hostKeys;
    const registered = await this.relayRequest("POST", "/v1/machines/register", {
      relayMachinePub: keys.relayPub.toString("base64url"),
      challenge: challenge.challenge,
      signature: signRegistrationPop(keys.relayPriv, this.addresses!.host, challenge.challenge),
    }, false) as { machineId?: unknown };
    if (registered.machineId !== keys.machineId) throw new Error("the relay derived a different machine id");
  }

  /** Makes the relay's admitted phones exactly this workspace's live and pending paired devices (the set read when it
   * runs); registers first only when the relay doesn't know this machine. */
  private reconcile(): Promise<void> {
    return this.admit(async () => {
      this.reconcileOwed = false;
      const put = () => this.relayRequest("PUT", `/v1/machines/${this.engine.hostKeys.machineId}/devices`, { devices: this.engine.admittedDevices() });
      try {
        try {
          await put();
        } catch (error) {
          if (!machineUnknown(error)) throw error;
          await this.register();
          await put();
        }
      } catch (error) {
        this.reconcileOwed = true;
        throw error;
      }
    });
  }

  private openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.addresses!.ws, { headers: { authorization: `Bearer ${this.daemonToken()}` }, handshakeTimeout: 10_000, maxPayload: 70_000 });
      socket.once("open", () => resolve(socket));
      socket.once("unexpected-response", (_req, res) => {
        const headers = { get: (name: string) => { const value = res.headers[name.toLowerCase()]; return typeof value === "string" ? value : null; } };
        const refusal = refusalOf(res.statusCode ?? 0, headers, "", this.nowMs());
        res.resume();
        if (machineUnknown(refusal)) this.reconcileOwed = true; // the next connect's PUT registers first
        reject(refusal);
      });
      socket.once("error", error => reject(error));
    });
  }

  private async relayRequest(method: "PUT" | "POST" | "DELETE", path: string, body?: unknown, authorized = true): Promise<unknown> {
    if (this.addresses === null) throw new Error("no hosted relay is configured");
    const response = await fetch(`${this.addresses.http}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(authorized ? { authorization: `Bearer ${this.daemonToken({ htm: method, htu: path })}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(RELAY_CALL_MS),
      redirect: "error",
    }).catch((error: unknown) => {
      // fetch's own message is only "fetch failed"; the reason (refused, reset, TLS, a timeout) is its cause.
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
      const rawCode = cause === null ? undefined : (cause as Error & { code?: unknown }).code;
      const code = typeof rawCode === "string" ? ` (${rawCode})` : "";
      throw new Error(`couldn't reach ${this.addresses!.http}: ${cause?.message ?? (error instanceof Error ? error.message : String(error))}${code}`);
    });
    const text = await response.text();
    if (!response.ok) throw refusalOf(response.status, response.headers, text, this.nowMs());
    try {
      return text.length === 0 ? {} : JSON.parse(text) as unknown;
    } catch {
      throw new Error("the relay sent something that isn't JSON");
    }
  }

  /** Test seam: whether a change is waiting for the relay to hear it. */
  get owesReconcile(): boolean {
    return this.reconcileOwed;
  }
}
