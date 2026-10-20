/**
 * THE RUNNING CONSOLE, PROVED LIVE (docs/plans/agents-cockpit.md B1).
 *
 * Bare `toolroll` in a repository attaches to a console already running for this installation instead of starting a
 * second one. Build agents run as the operator's own user, so nothing the filesystem says can tell the operator from
 * an agent: the console's Unix socket is DISCOVERY ONLY. It answers one verb, `hello`, with facts an agent could learn
 * anyway, and changes nothing.
 *
 * What proves the console is real is a fresh random instance secret, minted at each start of `up` and written to the
 * database (behind the agent fence) with its pid, build and port. The CLI reads it from the database it opens itself,
 * then makes the LIVE console answer two fresh challenges with it: over the socket (HMAC of "socket:" + challenge),
 * and over the advertised HTTP listener (HMAC of "http:" + challenge + " " + address + " " + port, where the address and
 * port are what the console itself saw as the receiving end of that very connection). The CLI requires those to be
 * 127.0.0.1 and the recorded port, so a relay on 127.0.0.1 forwarding to the console's other address is refused, as are
 * a replayed hello, a stale record with a recycled pid, and another process now on that port.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Store } from "./store.js";

export const CONSOLE_INSTANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS console_instance (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  secret     TEXT NOT NULL,
  pid        INTEGER NOT NULL,
  port       INTEGER NOT NULL,
  build      TEXT NOT NULL,
  started_at TEXT NOT NULL
);`;

/** The socket beside the database, in its owner-only directory. */
export const INSTANCE_SOCKET = "console.sock";
/** The console's own answer to a challenge over HTTP (an edge route, no sign-in: it reveals nothing). */
export const INSTANCE_PATH = "/__instance";
const CHALLENGE = /^[0-9a-f]{32,128}$/;
const LINE_CAP = 4096;

export type InstanceRecord = { secret: string; pid: number; port: number; build: string; startedAt: string };
export type HelloFacts = { pid: number; build: string; database: string; port: number };

export function recordInstance(store: Store, facts: { pid: number; port: number; build: string }, now: Date): string {
  const secret = randomBytes(32).toString("hex");
  store.handle.prepare("INSERT INTO console_instance (id, secret, pid, port, build, started_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET secret = excluded.secret, pid = excluded.pid, port = excluded.port, build = excluded.build, started_at = excluded.started_at")
    .run(secret, facts.pid, facts.port, facts.build, now.toISOString());
  return secret;
}

export function readInstance(store: Store): InstanceRecord | null {
  const row = store.handle.prepare("SELECT secret, pid, port, build, started_at FROM console_instance WHERE id = 1").get();
  if (row === undefined) return null;
  const secret = String(row["secret"]), pid = Number(row["pid"]), port = Number(row["port"]);
  if (!/^[0-9a-f]{64}$/.test(secret) || !Number.isSafeInteger(pid) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { secret, pid, port, build: String(row["build"]), startedAt: String(row["started_at"]) };
}

/** A stopping console forgets itself — only its own record, never a newer start's. */
export function clearInstance(store: Store, secret: string): void {
  store.handle.prepare("DELETE FROM console_instance WHERE id = 1 AND secret = ?").run(secret);
}

export const socketProof = (secret: string, challenge: string): string => createHmac("sha256", secret).update(`socket:${challenge}`).digest("hex");
export const httpProof = (secret: string, challenge: string, address: string, port: number): string =>
  createHmac("sha256", secret).update(`http:${challenge} ${address} ${port}`).digest("hex");
const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The HTTP answer: bound to the address and port THIS connection was received on, as the console saw them. */
export function instanceHttpAnswer(secret: string, challenge: string | null, local: { address: string | undefined; port: number | undefined }): { status: number; body: string } {
  if (challenge === null || !CHALLENGE.test(challenge) || local.address === undefined || local.port === undefined) return { status: 400, body: JSON.stringify({ error: "challenge" }) };
  return { status: 200, body: JSON.stringify({ proof: httpProof(secret, challenge, local.address, local.port) }) };
}

/**
 * The socket's directory must be a real directory owned by this user, writable by nobody else; the socket itself (if
 * there) a socket owned by this user. Anything else is refused before connecting or binding.
 */
export function socketPlaceProblem(socketPath: string, uid = process.getuid?.() ?? -1): string | null {
  const dir = dirname(socketPath);
  let info;
  try { info = lstatSync(dir); } catch { return `${dir} doesn't exist`; }
  if (!info.isDirectory()) return `${dir} isn't a directory`;
  if (uid >= 0 && info.uid !== uid) return `${dir} belongs to another user`;
  if ((info.mode & 0o022) !== 0) return `${dir} can be written by other users`;
  let socket;
  try { socket = lstatSync(socketPath); } catch { return null; }
  if (!socket.isSocket()) return `${socketPath} isn't a socket`;
  if (uid >= 0 && socket.uid !== uid) return `${socketPath} belongs to another user`;
  return null;
}

/** Ask a socket one question; null when nobody is listening (or it said nothing usable in time). */
export function askSocket(socketPath: string, request: object, timeoutMs = 2_000, connect: (path: string) => Socket = path => createConnection(path)): Promise<{ answer: Record<string, unknown> } | { none: "no-listener" | "no-answer" }> {
  return new Promise(resolve => {
    let settled = false, buffer = "";
    const done = (value: { answer: Record<string, unknown> } | { none: "no-listener" | "no-answer" }) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const socket = connect(socketPath);
    const timer = setTimeout(() => done({ none: "no-answer" }), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("error", (error: NodeJS.ErrnoException) => done({ none: error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "no-listener" : "no-answer" }));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > LINE_CAP) return done({ none: "no-answer" });
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, end)) as unknown;
        done(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? { answer: parsed as Record<string, unknown> } : { none: "no-answer" });
      } catch { done({ none: "no-answer" }); }
    });
    socket.on("end", () => done({ none: "no-answer" }));
  });
}

/**
 * The console's discovery socket: one line in, one line out. `hello` (with a challenge) answers the public facts and
 * the socket proof; every other verb is refused. It reads nothing else and changes nothing.
 */
export async function openInstanceSocket(socketPath: string, facts: HelloFacts, secret: string): Promise<{ ok: true; close: () => void } | { ok: false; problem: string }> {
  const problem = socketPlaceProblem(socketPath);
  if (problem !== null) return { ok: false, problem };
  // A socket left by a console that died: removed only when nobody answers on it.
  try {
    lstatSync(socketPath);
    const asked = await askSocket(socketPath, { verb: "ping" }, 1_000);
    if ("answer" in asked) return { ok: false, problem: `another console answers on ${socketPath}` };
    if (asked.none === "no-answer") return { ok: false, problem: `${socketPath} is in use` };
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, problem: `${socketPath} couldn't be cleared` };
  }
  const server: Server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy());
    const reply = (body: object) => { socket.end(`${JSON.stringify(body)}\n`); };
    socket.on("error", () => socket.destroy());
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > LINE_CAP) return void socket.destroy();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let asked: unknown;
      try { asked = JSON.parse(buffer.slice(0, end)); } catch { return reply({ error: "refused" }); }
      const verb = asked !== null && typeof asked === "object" ? (asked as { verb?: unknown }).verb : undefined;
      const challenge = asked !== null && typeof asked === "object" ? (asked as { challenge?: unknown }).challenge : undefined;
      if (verb !== "hello" || typeof challenge !== "string" || !CHALLENGE.test(challenge)) return reply({ error: "refused" });
      reply({ ...facts, proof: socketProof(secret, challenge) });
    });
  });
  const listening = await new Promise<boolean>(resolve => { server.once("error", () => resolve(false)); server.listen(socketPath, () => resolve(true)); });
  if (!listening) return { ok: false, problem: `couldn't listen on ${socketPath}` };
  return { ok: true, close: () => { server.close(); try { if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath); } catch { /* gone */ } } };
}

export type AttachProof =
  | { ok: true; url: string; port: number; pid: number; build: string }
  | { ok: false; state: "none"; message: string }
  | { ok: false; state: "refused"; message: string };

export type AttachSeams = {
  ask?: typeof askSocket;
  fetch?: typeof fetch;
  challenge?: () => string;
};

/**
 * Prove the console this installation's database names is live, on both channels, before anything is shown or
 * opened. "none": no console runs (no record, or nobody on the socket); "refused": something answers that can't
 * prove it is the console (or a different build) — the person restarts it.
 */
export async function proveLiveConsole(databaseFile: string, store: Store, build: string, seams: AttachSeams = {}): Promise<AttachProof> {
  const restart = "stop it and run `toolroll up` again";
  const socketPath = join(dirname(databaseFile), INSTANCE_SOCKET);
  const problem = socketPlaceProblem(socketPath);
  if (problem !== null) return { ok: false, state: "refused", message: `the console's socket can't be trusted: ${problem}` };
  const record = readInstance(store);
  const exists = (() => { try { lstatSync(socketPath); return true; } catch { return false; } })();
  if (!exists) return { ok: false, state: "none", message: "no console is running" };
  const challenge = seams.challenge ?? (() => randomBytes(32).toString("hex"));
  const first = challenge();
  const asked = await (seams.ask ?? askSocket)(socketPath, { verb: "hello", challenge: first });
  if ("none" in asked) {
    if (asked.none === "no-listener") {
      // Stale: nobody is listening. Removed, and nothing is running.
      try { if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath); } catch { /* gone */ }
      return { ok: false, state: "none", message: "no console is running" };
    }
    return { ok: false, state: "refused", message: `the console's socket didn't answer — ${restart}` };
  }
  if (record === null) return { ok: false, state: "refused", message: `something answers on the console's socket, but no console is recorded — ${restart}` };
  const hello = asked.answer;
  if (hello["build"] !== record.build || hello["build"] !== build) {
    return { ok: false, state: "refused", message: `the running console is a different build (${String(hello["build"] ?? "unknown")}, this is ${build}) — ${restart}` };
  }
  if (hello["pid"] !== record.pid || hello["port"] !== record.port || typeof hello["proof"] !== "string" || !same(hello["proof"], socketProof(record.secret, first))) {
    return { ok: false, state: "refused", message: `the console on the socket couldn't prove it's this installation's — ${restart}` };
  }
  const second = challenge();
  let body: unknown;
  try {
    const answer = await (seams.fetch ?? fetch)(`http://127.0.0.1:${record.port}${INSTANCE_PATH}?c=${second}`, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
    body = answer.status === 200 ? await answer.json() : null;
  } catch { body = null; }
  const proof = body !== null && typeof body === "object" ? (body as { proof?: unknown }).proof : undefined;
  if (typeof proof !== "string" || !same(proof, httpProof(record.secret, second, "127.0.0.1", record.port))) {
    return { ok: false, state: "refused", message: `the address 127.0.0.1:${record.port} couldn't prove it's the console — ${restart}` };
  }
  return { ok: true, url: `http://127.0.0.1:${record.port}`, port: record.port, pid: record.pid, build: record.build };
}
