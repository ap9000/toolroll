/**
 * Phone access for this console: the companion engine (daemon.ts) joined to a relay.
 *
 * Off until an approver turns it on (Settings → Phone). Then it holds one outbound WebSocket to the relay as this
 * machine's daemon, proves it owns the machine id (registration proof of possession), keeps the relay's set of
 * admitted phones exactly equal to this workspace's live paired devices (PUT after every connect, POST on pairing,
 * DELETE on removal), and passes every routed envelope to the engine. A dropped socket drops every phone session and
 * pending pairing riding it (engine.handleRelayDisconnected) and reconnects with jittered backoff.
 *
 * The built-in relay (relay-server.ts, the reference implementation) listens on this computer's loopback only: it
 * serves the iOS Simulator and anything else on this Mac. A phone elsewhere needs a relay it can reach over TLS
 * (a hosted or self-hosted `wss://` relay, configured with its URL).
 */

import { WebSocket } from "ws";
import { CompanionDaemonEngine, type CompanionReadHandlers, type PairingQrPayload } from "./daemon.js";
import { decodeRelayEnvelope, signRegistrationPop, signRelayToken } from "./relay-auth.js";
import { startReferenceRelay, type RunningReferenceRelay } from "./relay-server.js";
import { listPairedDevices, type PairedDeviceRow } from "./store.js";
import type { Store } from "../store.js";

export type CompanionRelayChoice =
  | { kind: "built-in"; port: number }
  | { kind: "external"; url: string };

export type CompanionServiceState =
  | { state: "starting"; relay: string }
  | { state: "connected"; relay: string; since: string }
  | { state: "unreachable"; relay: string; error: string; retryAt: string }
  | { state: "stopped" };

export interface CompanionServiceOptions {
  store: Store;
  reads: CompanionReadHandlers;
  relay: CompanionRelayChoice;
  log?: (line: string) => void;
  nowMs?: () => number;
  /** Test seam: the backoff's first and largest waits (ms). */
  backoff?: { first: number; max: number };
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

export class CompanionService {
  readonly engine: CompanionDaemonEngine;
  private readonly store: Store;
  private readonly choice: CompanionRelayChoice;
  private readonly log: (line: string) => void;
  private readonly nowMs: () => number;
  private readonly backoff: { first: number; max: number };
  private builtIn: RunningReferenceRelay | null = null;
  private addresses: { http: string; ws: string; host: string } | null = null;
  private socket: WebSocket | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** Bumped by every connect and every stop: an older connect that finishes late sees it moved on and stands down. */
  private connectGeneration = 0;
  private stopped = true;
  private current: CompanionServiceState = { state: "stopped" };
  /** A removal the relay didn't hear (it was unreachable): the next connect's reconcile settles it. */
  private reconcileOwed = false;

  constructor(opts: CompanionServiceOptions) {
    this.store = opts.store;
    this.choice = opts.relay;
    this.log = opts.log ?? (() => {});
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.backoff = opts.backoff ?? { first: 1_000, max: 60_000 };
    this.engine = new CompanionDaemonEngine({
      store: opts.store,
      handlers: opts.reads,
      sendToRelay: envelope => {
        if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) this.socket.send(envelope, { binary: true });
      },
      onDeviceRegistered: async (deviceId, deviceRelayPub) => {
        // Throws when the relay didn't take it: the engine undoes the pairing.
        await this.relayRequest("POST", `/v1/machines/${this.engine.hostKeys.machineId}/devices`, { deviceId, deviceRelayPub });
      },
      onDeviceRevoked: async deviceId => {
        try {
          await this.relayRequest("DELETE", `/v1/machines/${this.engine.hostKeys.machineId}/devices/${encodeURIComponent(deviceId)}`);
        } catch {
          this.reconcileOwed = true;
        }
      },
      ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }),
    });
  }

  /** What Settings shows. */
  status(): CompanionServiceState {
    return this.current;
  }

  /** The address phones are given (the QR's relayUrl), once started. */
  relayUrl(): string | null {
    return this.addresses?.ws ?? null;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.choice.kind === "built-in") {
      this.builtIn = await startReferenceRelay({ host: "127.0.0.1", port: this.choice.port });
      this.addresses = relayAddressesOf(this.builtIn.wsUrl);
    } else {
      this.addresses = relayAddressesOf(this.choice.url);
    }
    this.engine.setAdvertisedRelayUrl(this.addresses.ws);
    this.current = { state: "starting", relay: this.addresses.ws };
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connectGeneration += 1;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.closeSocket("stopping");
    this.engine.handleRelayDisconnected();
    if (this.builtIn !== null) {
      const relay = this.builtIn;
      this.builtIn = null;
      await relay.close();
    }
    this.current = { state: "stopped" };
  }

  startPairing(accountName: string, binding: string, accountGeneration: number | null = null): { ok: true; qr: PairingQrPayload; expiresAtMs: number } | { ok: false; error: string } {
    if (this.current.state !== "connected") return { ok: false, error: "Phone access isn't connected to its relay yet. Try again in a moment." };
    return this.engine.startPairing(accountName, binding, accountGeneration);
  }

  devices(): PairedDeviceRow[] {
    const generation = this.store.workspaceIdentity().recoveryGeneration;
    return listPairedDevices(this.store.handle).filter(d => d.revokedAt === null && d.recoveryGeneration === generation);
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
      this.socket = socket;
      this.attempt = 0;
      this.current = { state: "connected", relay, since: new Date(this.nowMs()).toISOString() };
      this.log(`phone access: connected to ${relay}`);
      this.keepalive = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.ping(); }, 20_000);
      this.keepalive.unref?.();
      socket.on("message", (raw, isBinary) => {
        if (!isBinary) return;
        const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        try {
          decodeRelayEnvelope(buf);
        } catch {
          return;
        }
        this.engine.handleRelayEnvelope(buf).catch(error => this.log(`phone access: envelope failed: ${error instanceof Error ? error.message : String(error)}`));
      });
      socket.on("close", (_code, reason) => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.keepalive !== null) clearInterval(this.keepalive);
        this.keepalive = null;
        this.engine.handleRelayDisconnected();
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
    this.current = { state: "unreachable", relay: this.addresses.ws, error, retryAt: new Date(this.nowMs() + wait).toISOString() };
    this.log(`phone access: relay unreachable (${error}); retrying in ${Math.round(wait / 1000)} s`);
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, wait);
    this.retry.unref?.();
  }

  private closeSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
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

  /** Makes the relay's admitted phones exactly this workspace's live paired devices. */
  private async reconcile(): Promise<void> {
    await this.relayRequest("PUT", `/v1/machines/${this.engine.hostKeys.machineId}/devices`, { devices: this.engine.admittedDevices() });
    this.reconcileOwed = false;
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
    if (this.addresses === null) throw new Error("phone access isn't started");
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

  /** Test seam: whether a removal is waiting for the relay to hear it. */
  get owesReconcile(): boolean {
    return this.reconcileOwed;
  }
}
