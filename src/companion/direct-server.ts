/**
 * The direct path: a phone on this Mac's network (same Wi-Fi, or this Mac's tailnet) connects straight to the
 * companion engine — no relay, no relay tokens. The first message is the phone's Noise message 1, so nothing past the
 * HTTP upgrade happens until the phone proves it holds a pairing (or a paired device's) key and the Mac proves it is
 * the Mac in the QR.
 *
 * Exposure is narrow on purpose:
 * - the kernel's peer address is classified on the raw TCP socket, before it is handed to HTTP at all: loopback, LAN
 *   (RFC 1918), IPv6 link-local and Tailscale (100.64/10, fd7a:115c:a1e0::/48) only — anything else is dropped;
 * - two routes: `GET /v1/health` (this Mac's machine id, so a phone can skip an address a different machine now holds)
 *   and the WebSocket upgrade `GET /v1/direct?role=pair|device&id=…`;
 * - sockets are capped globally and per address, upgrades are rate limited per address (bounded state), a socket that
 *   hasn't finished its request headers in 5 s is destroyed, and the engine's own handshake deadline drops a socket
 *   that never completes Noise.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { CompanionDaemonEngine, PeerLink } from "./daemon.js";

export const DIRECT_MAX_PAYLOAD = 70_000;

export interface DirectLimits {
  /** Open TCP sockets, all addresses together. */
  sockets: number;
  /** Open TCP sockets from one address. */
  socketsPerAddress: number;
  /** WebSocket upgrades one address may attempt per minute. */
  upgradesPerMinute: number;
}

const DEFAULT_LIMITS: DirectLimits = { sockets: 32, socketsPerAddress: 8, upgradesPerMinute: 30 };
const RATE_ENTRIES = 512;
const HEADER_DEADLINE_MS = 5_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function ipv4Of(address: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  return parts.every(p => p <= 255) ? parts : null;
}

/** Whether a socket from this kernel-reported address may talk to the direct listener at all. */
export function directPeerAllowed(address: string | undefined): boolean {
  if (address === undefined) return false;
  const bare = address.replace(/^::ffff:/i, "").toLowerCase();
  const v4 = ipv4Of(bare);
  if (v4 !== null) {
    const [a, b] = v4 as [number, number, number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (bare === "::1") return true;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true; // fe80::/10 link-local
  if (/^fd7a:115c:a1e0:/.test(bare)) return true; // Tailscale's IPv6 range
  return false;
}

export interface RunningDirectServer {
  port: number;
  close(): Promise<void>;
}

export interface DirectServerOptions {
  engine: CompanionDaemonEngine;
  port: number;
  host?: string;
  limits?: Partial<DirectLimits>;
  log?: (line: string) => void;
  /** Test seam: how a socket's peer address is read (real sockets on loopback can't present a LAN address). */
  peerAddressOf?: (socket: Socket) => string | undefined;
}

export function startDirectServer(opts: DirectServerOptions): Promise<RunningDirectServer> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const log = opts.log ?? (() => {});
  const addressOf = opts.peerAddressOf ?? ((socket: Socket) => socket.remoteAddress);
  const perAddress = new Map<string, number>();
  const upgrades = new Map<string, { windowStart: number; count: number }>();
  let open = 0;
  let linkSeq = 0;

  const allowUpgrade = (address: string): boolean => {
    const now = Date.now();
    const entry = upgrades.get(address);
    if (entry === undefined || now - entry.windowStart >= 60_000) {
      upgrades.delete(address);
      if (upgrades.size >= RATE_ENTRIES) upgrades.delete(upgrades.keys().next().value!);
      upgrades.set(address, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limits.upgradesPerMinute;
  };

  const handleHttp = (req: IncomingMessage, res: ServerResponse): void => {
    let pathname = "";
    try { pathname = new URL(req.url ?? "/", "http://direct.invalid").pathname; } catch { /* 404 below */ }
    if (req.method === "GET" && pathname === "/v1/health") {
      const body = JSON.stringify({ ok: true, machineId: opts.engine.hostKeys.machineId });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };

  // HTTP never listens itself: the TCP server below admits a socket first and only then hands it over.
  const server: Server = createServer(handleHttp);
  server.headersTimeout = HEADER_DEADLINE_MS;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: DIRECT_MAX_PAYLOAD });
  const headerDeadlines = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
  const headersDone = (socket: Socket) => { const timer = headerDeadlines.get(socket); if (timer !== undefined) clearTimeout(timer); headerDeadlines.delete(socket); };
  server.on("request", (req: IncomingMessage) => headersDone(req.socket));

  const tcp = createTcpServer({ pauseOnConnect: true }, (socket: Socket) => {
    const address = addressOf(socket);
    if (!directPeerAllowed(address) || open >= limits.sockets || (perAddress.get(address!) ?? 0) >= limits.socketsPerAddress) {
      socket.destroy();
      return;
    }
    open += 1;
    perAddress.set(address!, (perAddress.get(address!) ?? 0) + 1);
    const deadline = setTimeout(() => socket.destroy(), HEADER_DEADLINE_MS);
    deadline.unref?.();
    headerDeadlines.set(socket, deadline);
    socket.once("close", () => {
      headersDone(socket);
      open -= 1;
      const left = (perAddress.get(address!) ?? 1) - 1;
      if (left <= 0) perAddress.delete(address!); else perAddress.set(address!, left);
    });
    server.emit("connection", socket);
    socket.resume();
  });

  const attach = (ws: WebSocket, role: "pair" | "device", id: string): void => {
    linkSeq += 1;
    const link: PeerLink = {
      id: `direct#${linkSeq}`,
      send: (_connId, payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload, { binary: true }); },
      close: (_connId, reason) => { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(4000, reason.slice(0, 100)); },
    };
    let alive = true;
    const liveness = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 25_000);
    liveness.unref?.();
    ws.on("pong", () => { alive = true; });
    ws.on("message", (raw, isBinary) => {
      if (!isBinary) { ws.close(4000, "binary_only"); return; }
      const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      opts.engine.peerData(link, 1, buf).catch(error => log(`phone access: direct message failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    ws.on("close", () => {
      clearInterval(liveness);
      opts.engine.handleRelayDisconnected(link);
    });
    ws.on("error", () => { /* "close" follows */ });
    opts.engine.openPeer(link, 1, role, id);
  };

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    headersDone(socket);
    try {
      const address = addressOf(socket);
      if (!directPeerAllowed(address) || !allowUpgrade(address!)) { socket.destroy(); return; }
      const url = new URL(req.url ?? "/", "http://direct.invalid");
      const role = url.searchParams.get("role"), id = url.searchParams.get("id");
      if (url.pathname !== "/v1/direct" || (role !== "pair" && role !== "device") || id === null || !ID.test(id) || req.headers.authorization !== undefined) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => attach(ws, role, id));
    } catch {
      socket.destroy();
    }
  });
  server.on("clientError", (_error, socket) => { socket.destroy(); });

  return new Promise((resolve, reject) => {
    tcp.once("error", reject);
    tcp.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      tcp.off("error", reject);
      tcp.on("error", error => log(`phone access: direct listener error: ${error.message}`));
      const bound = tcp.address();
      resolve({
        port: typeof bound === "object" && bound !== null ? bound.port : opts.port,
        close: () => new Promise<void>(done => {
          for (const client of wss.clients) client.terminate();
          wss.close();
          server.closeAllConnections();
          tcp.close(() => done());
        }),
      });
    });
  });
}
