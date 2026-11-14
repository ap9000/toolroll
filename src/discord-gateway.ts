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

/** Close codes after which reconnecting would only repeat the refusal. */
const FATAL: Record<number, string> = {
  4004: "Discord rejected the bot token. Disconnect and reconnect with the current bot token.",
  4010: "Discord refused the connection settings. Update Toolroll, then reconnect.",
  4011: "Discord refused the connection settings. Update Toolroll, then reconnect.",
  4012: "Discord refused the connection settings. Update Toolroll, then reconnect.",
  4013: "Discord refused the connection settings. Update Toolroll, then reconnect.",
  4014: "Discord refused the Message Content intent. Turn on Message Content Intent for the app in the Discord Developer Portal; Toolroll tries again every 10 minutes.",
};
/** Close codes after which the session is gone: reconnect with a fresh IDENTIFY, not a RESUME. */
const FRESH = new Set([4003, 4007, 4009]);

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
};

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
    const socket = new WebSocket((resume ? this.#resumeUrl! : this.#options.url) + QUERY, {
      handshakeTimeout: 15_000,
      maxPayload: 32 * 1024 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
    });
    this.#socket = socket;
    this.#acked = true;
    this.#later(() => {
      if (this.#socket === socket && this.#beat === null) this.#drop(4000);
    }, this.#options.helloTimeoutMs);
    socket.on("message", (data) => {
      if (this.#socket !== socket) return;
      let packet: Packet;
      try {
        packet = JSON.parse(String(data)) as Packet;
      } catch {
        return this.#drop(4000);
      }
      if (packet === null || typeof packet !== "object" || typeof packet.op !== "number") return this.#drop(4000);
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
    if (this.#socket === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  #packet(socket: WebSocket, packet: Packet, resume: boolean): void {
    switch (packet.op) {
      case 10: {
        const interval = Number((packet.d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval);
        if (!Number.isFinite(interval) || interval < 250 || interval > 600_000) return this.#drop(4000);
        if (this.#beat) clearInterval(this.#beat);
        const beat = () => {
          if (this.#socket !== socket) return;
          // No ACK since the last beat: the connection is a zombie; close it and resume.
          if (!this.#acked) return this.#drop(4000);
          this.#acked = false;
          this.#send(socket, { op: 1, d: this.#seq });
        };
        this.#beat = setInterval(beat, interval);
        this.#later(beat, interval * Math.random());
        if (resume) this.#send(socket, { op: 6, d: { token: this.#token, session_id: this.#session, seq: this.#seq } });
        else this.#identify(socket);
        return;
      }
      case 11:
        this.#acked = true;
        return;
      case 1:
        this.#send(socket, { op: 1, d: this.#seq });
        return;
      case 7:
        return this.#drop(4000);
      case 9:
        if (packet.d !== true) this.#forget();
        return this.#drop(4000, this.#options.invalidSessionDelay());
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
    if (typeof packet.s === "number" && Number.isSafeInteger(packet.s)) this.#seq = packet.s;
    if (typeof packet.t !== "string") return;
    if (packet.t === "READY") {
      const d = (packet.d ?? {}) as { session_id?: unknown; resume_gateway_url?: unknown };
      this.#session = typeof d.session_id === "string" && d.session_id.length <= 200 ? d.session_id : null;
      this.#resumeUrl = this.#options.trust(d.resume_gateway_url);
      this.#attempt = 0;
    } else if (packet.t === "RESUMED") this.#attempt = 0;
    this.emit("raw", { op: 0, t: packet.t, s: packet.s, d: packet.d });
    if (this.#done) return;
    if (packet.t === "READY") {
      this.emit("shardReady", 0);
      this.#settle();
    } else if (packet.t === "RESUMED") {
      this.emit("shardResume", 0);
      this.#settle();
    }
  }

  #forget(): void {
    this.#session = null;
    this.#seq = null;
    this.#resumeUrl = null;
  }

  /** Closes this socket with a non-1000 code (the session stays resumable) and reconnects. */
  #drop(code: number, delay?: number): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#clear();
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) socket.close(code);
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
    const fatal = FATAL[code];
    if (fatal) {
      this.#done = true;
      this.#token = "";
      const error = new DiscordGatewayError(fatal, code, true);
      if (this.#login) return this.#settle(error);
      this.emit("shardDisconnect", code);
      if (this.listenerCount("error") > 0) this.emit("error", error);
      return;
    }
    if (FRESH.has(code)) this.#forget();
    this.#reconnect();
  }

  #reconnect(delay?: number): void {
    if (this.#done) return;
    this.emit("shardReconnecting", 0);
    this.#later(() => this.#connect(), delay ?? this.#options.backoff(this.#attempt++));
  }
}
