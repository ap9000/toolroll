/**
 * Phone access for this console: the companion engine (daemon.ts) reachable two ways.
 *
 * - **Direct** (direct-server.ts): a listener on this Mac's network (port 4199 by default) that a phone on the same
 *   Wi-Fi, or on this Mac's tailnet, connects straight to. No relay and no relay tokens: Noise from the first message.
 * - **Hosted** (optional): one outbound WebSocket to an end-to-end encrypted relay (wss://relay.toolroll.dev unless
 *   configured otherwise) as this machine's daemon, for a phone anywhere else. The service proves it owns the machine id
 *   (registration proof of possession), keeps the relay's set of admitted phones exactly equal to this workspace's live
 *   paired devices (PUT after every connect and after any change it couldn't deliver, POST on a pairing made through
 *   the relay, DELETE on removal), and passes every routed envelope to the engine.
 *
 * Each path starts, fails and reports on its own: a port in use doesn't stop the hosted path; an unreachable relay
 * doesn't stop the direct one. A dropped relay socket drops only the phone sessions and pairings riding it.
 */

import type { Socket } from "node:net";
import { WebSocket } from "ws";
import { CompanionDaemonEngine, relayEnvelopeLink, type CompanionReadHandlers, type PairingQrPayload, type PeerLink } from "./daemon.js";
import { startDirectServer, type RunningDirectServer } from "./direct-server.js";
import { buildPaths, lanAddressesOf, type CompanionPath } from "./paths.js";
import { decodeRelayEnvelope, signRegistrationPop, signRelayToken } from "./relay-auth.js";
import { listPairedDevices, type PairedDeviceRow } from "./store.js";
import { readTailnetIpv4 } from "../tailnet.js";
import type { Store } from "../store.js";

export type DirectPathState =
  | { state: "off" }
  | { state: "listening"; port: number }
  | { state: "failed"; error: string };

export type HostedPathState =
  | { state: "off" }
  | { state: "starting"; relay: string }
  | { state: "connected"; relay: string; since: string }
  | { state: "unreachable"; relay: string; error: string; retryAt: string };

export interface CompanionServiceStatus {
  running: boolean;
  direct: DirectPathState;
  hosted: HostedPathState;
}

export interface CompanionServiceOptions {
  store: Store;
  reads: CompanionReadHandlers;
  /** The direct listener (null: no direct path). */
  direct: { port: number; host?: string } | null;
  /** The hosted relay's URL (null: no hosted path). */
  hosted: string | null;
  log?: (line: string) => void;
  nowMs?: () => number;
  /** Test seam: the backoff's first and largest waits (ms). */
  backoff?: { first: number; max: number };
  /** Test seams: this Mac's LAN addresses and Tailscale address, and how a direct socket's peer address is read. */
  lanAddresses?: () => string[];
  tailnetIpv4?: () => Promise<string | null>;
  directPeerAddressOf?: (socket: Socket) => string | undefined;
}

/** The relay's HTTP base and WebSocket connect address for a configured `wss://host[/…]` or `ws://…` URL. */
export function relayAddressesOf(url: string): { http: string; ws: string; host: string } {
  const parsed = new URL(url);
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:" && parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("A relay URL starts with wss:// (or ws:// on this computer).");
  }
  const secure = parsed.protocol === "wss:" || parsed.protocol === "https:";
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (!secure && !loopback) throw new Error("A relay off this computer needs TLS (wss://).");
  const base = `${secure ? "https" : "http"}://${parsed.host}`;
  return { http: base, ws: `${secure ? "wss" : "ws"}://${parsed.host}/v1/connect`, host: parsed.host };
}

const TAILNET_REFRESH_MS = 10_000;
/** Bytes queued for the relay before the connection is treated as stalled and reopened. */
const RELAY_BACKLOG_CAP = 16 * 1024 * 1024;

export class CompanionService {
  readonly engine: CompanionDaemonEngine;
  private readonly store: Store;
  private readonly opts: CompanionServiceOptions;
  private readonly log: (line: string) => void;
  private readonly nowMs: () => number;
  private readonly backoff: { first: number; max: number };
  private readonly addresses: { http: string; ws: string; host: string } | null;
  private directServer: RunningDirectServer | null = null;
  private directState: DirectPathState = { state: "off" };
  private socket: WebSocket | null = null;
  private link: PeerLink | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** Bumped by every connect and every stop: an older connect that finishes late sees it moved on and stands down. */
  private connectGeneration = 0;
  private stopped = true;
  private hostedState: HostedPathState = { state: "off" };
  /** Changes to the relay's admitted set run one at a time, each reading the live device set when it runs. */
  private admission: Promise<void> = Promise.resolve();
  /** A change the relay didn't hear yet: a fresh full-set PUT is owed (retried while connected, and on reconnect). */
  private reconcileOwed = false;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileAttempt = 0;
  private tailnet: { ip: string | null; at: number } = { ip: null, at: -Infinity };

  constructor(opts: CompanionServiceOptions) {
    this.store = opts.store;
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.backoff = opts.backoff ?? { first: 1_000, max: 60_000 };
    this.addresses = opts.hosted === null ? null : relayAddressesOf(opts.hosted);
    this.engine = new CompanionDaemonEngine({
      store: opts.store,
      handlers: opts.reads,
      onDeviceRegistered: async (deviceId, deviceRelayPub, via) => {
        if (via === this.link && this.link !== null) {
          // Paired through the relay: it must admit the phone before the phone is told (throws → the engine undoes it).
          await this.admit(() => this.relayRequest("POST", `/v1/machines/${this.engine.hostKeys.machineId}/devices`, { deviceId, deviceRelayPub }));
        } else if (this.addresses !== null) {
          // Paired directly: the relay learns of the phone on its own schedule; its outage never undoes the pairing.
          this.oweReconcile();
        }
      },
      onDeviceRevoked: async deviceId => {
        if (this.addresses === null) return;
        try {
          await this.admit(() => this.relayRequest("DELETE", `/v1/machines/${this.engine.hostKeys.machineId}/devices/${encodeURIComponent(deviceId)}`));
        } catch {
          this.oweReconcile();
        }
      },
      ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }),
    });
    this.engine.setPathsProvider(() => this.paths());
  }

  /** What Settings shows. */
  status(): CompanionServiceStatus {
    return { running: !this.stopped, direct: this.directState, hosted: this.hostedState };
  }

  /** This Mac's addresses a phone on the same network can use (empty when the direct path isn't listening). */
  directAddresses(): string[] {
    return this.paths().filter(path => path.kind === "direct").map(path => new URL(path.url).host);
  }

  /** The ways a phone can reach this Mac: direct addresses first, then the approved hosted relay — listed even while
   * it's briefly unreachable, so a phone that saves this list (every hello) keeps its way back from elsewhere. */
  paths(): CompanionPath[] {
    void this.refreshTailnet();
    return buildPaths({
      port: this.directState.state === "listening" ? this.directState.port : null,
      lan: (this.opts.lanAddresses ?? lanAddressesOf)(),
      tailnet: this.tailnet.ip,
      hosted: this.addresses?.ws ?? null,
    });
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.refreshTailnet(true);
    if (this.opts.direct !== null) {
      try {
        this.directServer = await startDirectServer({
          engine: this.engine, port: this.opts.direct.port, log: this.log,
          ...(this.opts.direct.host === undefined ? {} : { host: this.opts.direct.host }),
          ...(this.opts.directPeerAddressOf === undefined ? {} : { peerAddressOf: this.opts.directPeerAddressOf }),
        });
        this.directState = { state: "listening", port: this.directServer.port };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        this.directState = {
          state: "failed",
          error: code === "EADDRINUSE"
            ? `Port ${this.opts.direct.port} on this computer is in use. Set TOOLROLL_PHONE_RELAY_PORT to another port and restart Toolroll.`
            : error instanceof Error ? error.message : String(error),
        };
        this.log(`phone access: direct listener didn't start (${this.directState.error})`);
      }
    }
    if (this.addresses !== null) {
      this.hostedState = { state: "starting", relay: this.addresses.ws };
      void this.connect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connectGeneration += 1;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    this.closeSocket("stopping");
    this.engine.handleRelayDisconnected();
    // Nothing queued for the relay runs after this (admit refuses once stopped), and a write already in flight settles
    // before the caller starts a replacement service that owns the relay's admitted set.
    await this.admission;
    if (this.directServer !== null) {
      const server = this.directServer;
      this.directServer = null;
      await server.close();
    }
    this.directState = { state: "off" };
    this.hostedState = { state: "off" };
  }

  startPairing(accountName: string, binding: string, accountGeneration: number | null = null): { ok: true; qr: PairingQrPayload; expiresAtMs: number } | { ok: false; error: string } {
    if (this.directState.state !== "listening" && this.hostedState.state !== "connected") {
      return { ok: false, error: this.hostedState.state === "starting" ? "Phone access is still starting. Try again in a moment." : "A phone has no way to reach this Mac right now." };
    }
    return this.engine.startPairing(accountName, binding, accountGeneration);
  }

  devices(): PairedDeviceRow[] {
    const generation = this.store.workspaceIdentity().recoveryGeneration;
    return listPairedDevices(this.store.handle).filter(d => d.revokedAt === null && d.recoveryGeneration === generation);
  }

  private refreshTailnet(wait = false): Promise<void> {
    if (!wait && this.nowMs() - this.tailnet.at < TAILNET_REFRESH_MS) return Promise.resolve();
    this.tailnet.at = this.nowMs();
    const read = (this.opts.tailnetIpv4 ?? (() => readTailnetIpv4()))().then(ip => { this.tailnet.ip = ip; }, () => {});
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
      await this.register();
      if (!current()) return;
      await this.reconcile();
      if (!current()) return;
      const socket = await this.openSocket();
      if (!current()) { socket.close(1000, "stopping"); return; }
      // The relay socket carries every phone, so its queue says nothing about any one of them: no phone is dropped for
      // it (each is bounded by its own credit and 1 MiB of held responses). A queue past the hard cap means the relay
      // itself has stalled: the socket is closed and reconnected rather than allowed to grow.
      const link = relayEnvelopeLink(`hosted#${generation}`, envelope => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > RELAY_BACKLOG_CAP) { socket.close(1013, "relay_backlog"); return; }
        socket.send(envelope, { binary: true });
      });
      this.socket = socket;
      this.link = link;
      this.attempt = 0;
      this.hostedState = { state: "connected", relay, since: new Date(this.nowMs()).toISOString() };
      this.log(`phone access: connected to ${relay}`);
      this.keepalive = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.ping(); }, 20_000);
      this.keepalive.unref?.();
      // A change that failed while the socket was opening: settle it now.
      if (this.reconcileOwed) this.oweReconcile();
      socket.on("message", (raw, isBinary) => {
        if (!isBinary) return;
        const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        try {
          decodeRelayEnvelope(buf);
        } catch {
          return;
        }
        this.engine.handleRelayEnvelope(buf, link).catch(error => this.log(`phone access: envelope failed: ${error instanceof Error ? error.message : String(error)}`));
      });
      socket.on("close", (_code, reason) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.link = null;
        if (this.keepalive !== null) clearInterval(this.keepalive);
        this.keepalive = null;
        if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
        this.reconcileTimer = null;
        this.engine.handleRelayDisconnected(link);
        if (!this.stopped) this.scheduleRetry(`the relay closed the connection${reason.length > 0 ? ` (${reason.toString("utf8")})` : ""}`);
      });
      socket.on("error", () => { /* "close" follows */ });
    } catch (error) {
      if (current()) this.scheduleRetry(error instanceof Error ? error.message : String(error));
    }
  }

  private scheduleRetry(error: string): void {
    if (this.stopped || this.addresses === null) return;
    this.attempt += 1;
    const ceiling = Math.min(this.backoff.max, this.backoff.first * 2 ** Math.min(this.attempt - 1, 16));
    const wait = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    this.hostedState = { state: "unreachable", relay: this.addresses.ws, error, retryAt: new Date(this.nowMs() + wait).toISOString() };
    this.log(`phone access: relay unreachable (${error}); retrying in ${Math.round(wait / 1000)} s`);
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

  private daemonToken(): string {
    return signRelayToken(this.engine.hostKeys.relayPriv, { role: "daemon", machineId: this.engine.hostKeys.machineId, ttlSec: 60 });
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

  /** Makes the relay's admitted phones exactly this workspace's live paired devices (the set read when it runs). */
  private reconcile(): Promise<void> {
    return this.admit(async () => {
      this.reconcileOwed = false;
      try {
        await this.relayRequest("PUT", `/v1/machines/${this.engine.hostKeys.machineId}/devices`, { devices: this.engine.admittedDevices() });
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
      socket.once("unexpected-response", (_req, res) => reject(new Error(`the relay refused the connection (${res.statusCode ?? "?"})`)));
      socket.once("error", error => reject(error));
    });
  }

  private async relayRequest(method: string, path: string, body?: unknown, authorized = true): Promise<unknown> {
    if (this.addresses === null) throw new Error("no hosted relay is configured");
    const response = await fetch(`${this.addresses.http}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(authorized ? { authorization: `Bearer ${this.daemonToken()}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    }).catch((error: unknown) => {
      // fetch's own message is only "fetch failed"; the reason (refused, reset, TLS, a timeout) is its cause.
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
      const rawCode = cause === null ? undefined : (cause as Error & { code?: unknown }).code;
      const code = typeof rawCode === "string" ? ` (${rawCode})` : "";
      throw new Error(`couldn't reach ${this.addresses!.http}: ${cause?.message ?? (error instanceof Error ? error.message : String(error))}${code}`);
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`the relay answered ${response.status}${text.length > 0 && text.length < 200 ? ` ${text}` : ""}`);
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
