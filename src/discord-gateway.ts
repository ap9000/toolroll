/**
 * A small Discord Gateway (v10) client over `ws`: one shard, JSON encoding, no compression. It is what the Discord
 * follower needs from a gateway and nothing more: identify, heartbeat, resume, reconnect, and the dispatches as raw
 * packets. REST goes through discordApi (src/discord-api.ts).
 *
 * The bot token is sent only in the IDENTIFY and RESUME payloads, and only to Discord's gateway: the first connection
 * goes to gateway.discord.gg, and the resume address Discord hands back must be a wss:// host under discord.gg (it is
 * rebuilt from its host name alone). Nothing here logs; errors never carry the token or a payload.
 *
 * Events (the discord.js names src/discord.ts already used): "raw" {op, t, s, d} for every dispatch, before
 * "shardReady" (after READY) and "shardResume" (after RESUMED); "shardReconnecting" before each reconnect;
 * "shardDisconnect" when Discord closed for good; "error" (a DiscordGatewayError) for a close that must not retry.
 */
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

/** Direct messages, guild messages and their content (Message Content is enabled per app in the developer portal). */
export const DISCORD_INTENTS = (1 << 12) | (1 << 9) | (1 << 15);
export const DISCORD_GATEWAY = "wss://gateway.discord.gg/";
const QUERY = "?v=10&encoding=json";
/** Where the bot's session-start budget is read before every IDENTIFY (the token goes only to discord.com). */
export const DISCORD_GATEWAY_BOT = "https://discord.com/api/v10/gateway/bot";
/** More unsent bytes than this means the peer stopped reading: close instead of queueing more. */
const MAX_BUFFERED = 1024 * 1024;
/** A connection that has stayed up this long resets the backoff and invalid-session counts. */
const STABLE_MS = 60_000;
/** More heartbeat requests than this in HEARTBEAT_FLOOD_MS is not Discord asking: close the connection. */
const HEARTBEAT_FLOOD = 20;
const HEARTBEAT_FLOOD_MS = 10_000;

/** Close codes after which reconnecting would only repeat the refusal. */
const FATAL: Record<number, string> = {
  4004: "Discord rejected the bot token. Disconnect and reconnect with the current bot token.",
  4010: "Discord refused the connection settings. Update Toolroll, then reconnect.",
  4011: "Discord refused the connection settings. Update Toolroll, then reconnect.",
  4012: "Discord refused the connection settings. Update Toolroll, then reconnect.",
  4013: "Discord refused the connection settings. Update Toolroll, then reconnect.",
  4014: "Discord refused the Message Content intent. Turn on Message Content Intent for the app in the Discord Developer Portal; Toolroll tries again every 10 minutes.",
};
/** Close codes after which the session is gone: reconnect with a fresh IDENTIFY, not a RESUME (a normal closure,
 * 1000/1001, ends the session too). */
const FRESH = new Set([1000, 1001, 4003, 4007, 4009]);
const DAILY_LIMIT = "Discord's daily connection limit for this bot is used up. Toolroll reconnects when it resets.";

export class DiscordGatewayError extends Error {
  constructor(message: string, readonly code: number | null, readonly fatal: boolean) {
    super(message);
    this.name = "DiscordGatewayError";
  }
}

/** Discord's resume address, rebuilt from its host when that host is Discord's gateway; otherwise null (identify fresh). */
export function trustedGatewayUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "wss:" || url.username || url.password || (url.port !== "" && url.port !== "443")) return null;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*discord\.gg$/.test(url.hostname) ? `wss://${url.hostname}/` : null;
}

export type DiscordGatewayOptions = {
  /** Where the first connection goes (tests: a local fake gateway). */
  url?: string;
  /** Which resume addresses to accept (tests: the local fake gateway). */
  trust?: (raw: unknown) => string | null;
  intents?: number;
  /** The wait before reconnect attempt n (0-based). */
  backoff?: (attempt: number) => number;
  /** The least time between two IDENTIFYs from this process (Discord allows one per 5 s). */
  identifyGapMs?: number;
  /** How long to wait for HELLO after the socket opens. */
  helloTimeoutMs?: number;
  /** The wait before reconnecting after an INVALID_SESSION (Discord asks for a random 1–5 s). */
  invalidSessionDelay?: () => number;
  /** The fraction of the heartbeat interval before the first heartbeat (Discord asks for a random one). */
  jitter?: () => number;
  /** How GET /gateway/bot is fetched (tests: a scripted response). */
  fetcher?: typeof fetch;
};

type Budget = { kind: "ok" } | { kind: "wait"; ms: number; message: string } | { kind: "retry" } | { kind: "rejected" };
const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const count = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;

const defaultBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random() / 2);
let lastIdentify = 0;

type Packet = { op: number; d: unknown; s: number | null; t: string | null };

export class DiscordGateway extends EventEmitter {
  #token = "";
  #socket: WebSocket | null = null;
  #seq: number | null = null;
  #session: string | null = null;
  #resumeUrl: string | null = null;
  #acked = true;
  #attempt = 0;
  #invalid = 0;
  #hello = false;
  #requests: number[] = [];
  #stuck = false;
  #done = false;
  #timers = new Set<NodeJS.Timeout>();
  #beat: NodeJS.Timeout | null = null;
  #login: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null;
  readonly #options: Required<DiscordGatewayOptions>;

  constructor(options: DiscordGatewayOptions = {}) {
    super();
    this.#options = {
      url: options.url ?? DISCORD_GATEWAY,
      trust: options.trust ?? trustedGatewayUrl,
      intents: options.intents ?? DISCORD_INTENTS,
      backoff: options.backoff ?? defaultBackoff,
      identifyGapMs: options.identifyGapMs ?? 5500,
      helloTimeoutMs: options.helloTimeoutMs ?? 20_000,
      invalidSessionDelay: options.invalidSessionDelay ?? (() => 1000 + Math.random() * 4000),
      jitter: options.jitter ?? Math.random,
      fetcher: options.fetcher ?? ((input, init) => fetch(input, init)),
    };
  }

  /** Connects and resolves at the first READY; rejects on a close that must not retry, or on destroy. */
  login(token: string): Promise<string> {
    if (this.#done || this.#login || this.#token) return Promise.reject(new DiscordGatewayError("Discord is already connecting", null, false));
    if (typeof token !== "string" || !/^[A-Za-z0-9._-]{1,300}$/.test(token))
      return Promise.reject(new DiscordGatewayError("Enter the bot token from your Discord application", null, true));
    this.#token = token;
    return new Promise<string>((resolve, reject) => {
      this.#login = { resolve, reject };
      this.#connect();
    });
  }

  /** Closes for good: no reconnect, timers cleared, a pending login rejected. */
  async destroy(): Promise<void> {
    if (this.#done && !this.#socket) return;
    this.#done = true;
    this.#settle(new DiscordGatewayError("Discord connection closed", null, false));
    this.#clear();
    const socket = this.#socket;
    this.#socket = null;
    this.#token = "";
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1000);
      socket.once("close", () => {
        clearTimeout(force);
        resolve();
      });
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000);
    });
  }

  #later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      fn();
    }, Math.max(0, ms));
    this.#timers.add(timer);
  }

  #clear(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#beat) clearInterval(this.#beat);
    this.#beat = null;
  }

  #settle(error?: Error): void {
    const pending = this.#login;
    this.#login = null;
    if (!pending) return;
    if (error) pending.reject(error);
    else pending.resolve(this.#token);
  }

  #connect(): void {
    if (this.#done) return;
    const resume = this.#session !== null && this.#seq !== null && this.#resumeUrl !== null;
    if (resume) return this.#open(true);
    // A fresh session spends one of the bot's daily session starts: read the budget first, and never identify into
    // an empty one (Discord resets the token of a bot that keeps going).
    void this.#budget().then((budget) => {
      if (this.#done || this.#socket) return;
      if (budget.kind === "ok") return this.#open(false);
      if (budget.kind === "rejected") return this.#fail(4004);
      if (budget.kind === "retry") return this.#reconnect();
      if (this.listenerCount("error") > 0) this.emit("error", new DiscordGatewayError(budget.message, null, false));
      this.#later(() => this.#connect(), budget.ms);
    });
  }

  async #budget(): Promise<Budget> {
    let response: Response, body: unknown;
    try {
      response = await this.#options.fetcher(DISCORD_GATEWAY_BOT, {
        headers: { Authorization: `Bot ${this.#token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      body = await response.json().catch(() => null);
    } catch {
      return { kind: "retry" };
    }
    if (response.status === 401) return { kind: "rejected" };
    if (response.status === 429) {
      const seconds = record(body).retry_after;
      return { kind: "wait", ms: count(seconds, 86_400) ? Math.ceil(seconds * 1000) + 1000 : 60_000, message: "Discord asked Toolroll to wait before connecting. It reconnects shortly." };
    }
    if (!response.ok) return { kind: "retry" };
    const limit = record(record(body).session_start_limit);
    const remaining = limit.remaining, resetAfter = limit.reset_after;
    if (!count(remaining, 1e9) || !Number.isInteger(remaining) || !count(resetAfter, 7 * 86_400_000)) return { kind: "retry" };
    return remaining > 0 ? { kind: "ok" } : { kind: "wait", ms: resetAfter + 1000, message: DAILY_LIMIT };
  }

  #open(resume: boolean): void {
    const socket = new WebSocket((resume ? this.#resumeUrl! : this.#options.url) + QUERY, {
      handshakeTimeout: 15_000,
      maxPayload: 32 * 1024 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
    });
    this.#socket = socket;
    this.#acked = true;
    this.#hello = false;
    this.#requests = [];
    // A new connection replays (on resume) from the stored sequence, so a dispatch that failed is delivered again.
    this.#stuck = false;
    this.#later(() => {
      if (this.#socket === socket && !this.#hello) this.#drop(4000);
    }, this.#options.helloTimeoutMs);
    socket.on("message", (data) => {
      if (this.#socket !== socket) return;
      let packet: Packet;
      try {
        packet = JSON.parse(String(data)) as Packet;
      } catch {
        return this.#drop(4000);
      }
      // Server data is untrusted: a malformed frame closes and reconnects. Each field is type-checked where it is
      // read, without coercion; listener (application) failures are not protocol errors (see #deliver).
      if (
        packet === null ||
        typeof packet !== "object" ||
        typeof packet.op !== "number" ||
        (packet.s !== null && packet.s !== undefined && typeof packet.s !== "number") ||
        (packet.t !== null && packet.t !== undefined && typeof packet.t !== "string")
      )
        return this.#drop(4000);
      this.#packet(socket, packet, resume);
    });
    // A failed handshake or a dropped socket ends in "close"; the error itself carries nothing to keep.
    socket.on("error", () => {});
    socket.on("close", (code) => {
      if (this.#socket !== socket) return;
      this.#closed(code);
    });
  }

  #send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED) return this.#drop(4000);
    socket.send(JSON.stringify(payload));
  }

  #packet(socket: WebSocket, packet: Packet, resume: boolean): void {
    switch (packet.op) {
      case 10: {
        // One HELLO per connection; a second is a protocol violation.
        if (this.#hello) return this.#drop(4000);
        const interval = record(packet.d).heartbeat_interval;
        if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 250 || interval > 600_000) return this.#drop(4000);
        this.#hello = true;
        const beat = () => {
          if (this.#socket !== socket) return;
          // No ACK since the last beat: the connection is a zombie; close it and resume.
          if (!this.#acked) return this.#drop(4000);
          this.#acked = false;
          this.#send(socket, { op: 1, d: this.#seq });
        };
        // The first beat after a random part of the interval, then every interval from there: each beat always gets a
        // full interval for its ACK.
        const jitter = this.#options.jitter();
        this.#later(() => {
          beat();
          if (this.#socket === socket && this.#beat === null) this.#beat = setInterval(beat, interval);
        }, interval * (jitter >= 0 && jitter < 1 ? jitter : 0.5));
        if (resume) this.#send(socket, { op: 6, d: { token: this.#token, session_id: this.#session, seq: this.#seq } });
        else this.#identify(socket);
        return;
      }
      case 11:
        this.#acked = true;
        return;
      case 1: {
        // Discord expects every heartbeat request answered at once. A flood is not Discord asking: close, saying why.
        const now = Date.now();
        this.#requests = this.#requests.filter((at) => now - at < HEARTBEAT_FLOOD_MS);
        this.#requests.push(now);
        if (this.#requests.length > HEARTBEAT_FLOOD) return this.#drop(4000, undefined, "heartbeat request flood");
        this.#send(socket, { op: 1, d: this.#seq });
        return;
      }
      case 7:
        return this.#drop(4000);
      case 9: {
        if (packet.d !== true) this.#forget();
        // Repeated invalid sessions back off like any other reconnect (each fresh one spends a session start).
        const delay = Math.max(this.#options.invalidSessionDelay(), this.#invalid > 0 ? this.#options.backoff(this.#invalid) : 0);
        this.#invalid++;
        return this.#drop(4000, delay);
      }
      case 0:
        return this.#dispatch(packet);
      default:
        return;
    }
  }

  #identify(socket: WebSocket): void {
    const wait = lastIdentify + this.#options.identifyGapMs - Date.now();
    if (wait > 0) return this.#later(() => this.#identify(socket), wait);
    if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    lastIdentify = Date.now();
    this.#send(socket, {
      op: 2,
      d: {
        token: this.#token,
        intents: this.#options.intents,
        properties: { os: process.platform, browser: "toolroll", device: "toolroll" },
      },
    });
  }

  #dispatch(packet: Packet): void {
    const seq = typeof packet.s === "number" && Number.isSafeInteger(packet.s) ? packet.s : null;
    if (typeof packet.t !== "string") {
      if (seq !== null && !this.#stuck) this.#seq = seq;
      return;
    }
    if (packet.t === "READY") {
      const d = record(packet.d);
      this.#session = typeof d.session_id === "string" && d.session_id.length <= 200 ? d.session_id : null;
      this.#resumeUrl = this.#options.trust(d.resume_gateway_url);
    }
    if (packet.t === "READY" || packet.t === "RESUMED")
      // Only a connection that stays up resets the counts (the timer goes with the connection if it drops first).
      this.#later(() => {
        this.#attempt = 0;
        this.#invalid = 0;
      }, STABLE_MS);
    const delivered = this.#deliver("raw", { op: 0, t: packet.t, s: packet.s, d: packet.d });
    // The stored sequence is what a RESUME asks Discord to replay after. It stops at the last dispatch before one a
    // listener failed on, until the next connection: a resume then replays the failed event (and the ones after it;
    // the follower's saved-event receipts make those repeats no-ops) instead of skipping it. Advancing past it would
    // drop it for good. The connection stays up, and the failure is reported as an "error".
    if (!delivered) this.#stuck = true;
    else if (seq !== null && !this.#stuck) this.#seq = seq;
    if (this.#done) return;
    if (packet.t === "READY") {
      this.#deliver("shardReady", 0);
      this.#settle();
    } else if (packet.t === "RESUMED") {
      this.#deliver("shardResume", 0);
      this.#settle();
    }
  }

  /** Emits to the application's listeners; one that throws is reported as an "error" (with the exception as its
   * cause), never turned into a reconnect or thrown into the socket's handler. */
  #deliver(event: string, ...args: unknown[]): boolean {
    try {
      this.emit(event, ...args);
      return true;
    } catch (cause) {
      const error = new DiscordGatewayError("An incoming Discord event could not be handled. It is delivered again after the next reconnect.", null, false);
      (error as Error & { cause?: unknown }).cause = cause;
      try {
        if (this.listenerCount("error") > 0) this.emit("error", error);
      } catch {
        /* an error listener that throws has nothing left to report to */
      }
      return false;
    }
  }

  #forget(): void {
    this.#session = null;
    this.#seq = null;
    this.#resumeUrl = null;
  }

  /** Closes this socket with a non-1000 code (the session stays resumable) and reconnects. */
  #drop(code: number, delay?: number, reason?: string): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#clear();
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
      else socket.terminate();
      const force = setTimeout(() => socket.terminate(), 2000);
      force.unref();
      socket.once("close", () => clearTimeout(force));
    }
    this.#reconnect(delay);
  }

  #closed(code: number): void {
    this.#socket = null;
    this.#clear();
    if (this.#done) return;
    if (FATAL[code]) return this.#fail(code);
    if (FRESH.has(code)) this.#forget();
    this.#reconnect();
  }

  /** Discord refused for good: no reconnect, the login (or the listener) told why. */
  #fail(code: number): void {
    this.#clear();
    this.#done = true;
    this.#token = "";
    const error = new DiscordGatewayError(FATAL[code]!, code, true);
    if (this.#login) return this.#settle(error);
    this.emit("shardDisconnect", code);
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }

  #reconnect(delay?: number): void {
    if (this.#done) return;
    this.emit("shardReconnecting", 0);
    this.#later(() => this.#connect(), delay ?? this.#options.backoff(this.#attempt++));
  }
}
