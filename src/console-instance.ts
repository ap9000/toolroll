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
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import type { Store } from "./store.js";

export const CONSOLE_INSTANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS console_instance (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  secret     TEXT NOT NULL,
  pid        INTEGER NOT NULL,
  port       INTEGER NOT NULL,
  build      TEXT NOT NULL,
  socket     TEXT NOT NULL,
  started_at TEXT NOT NULL
);`;

/**
 * The socket's own owner-only directory beside the database's REAL file (a symlinked database resolves to the one
 * folder every spelling shares). Each console start binds a socket of its own, under a fresh random name recorded
 * with its secret: no console ever needs to remove — or can remove — another console's socket.
 */
export const INSTANCE_DIR = "run";
export function instanceRunDir(databaseFile: string): string {
  let file = databaseFile;
  try { file = realpathSync(databaseFile); } catch {
    try { file = join(realpathSync(dirname(databaseFile)), basename(databaseFile)); } catch { /* not there yet: as given */ }
  }
  return join(dirname(file), INSTANCE_DIR);
}
const SOCKET_NAME = /^[0-9a-f]{16}\.sock$/;
/** The longest Unix socket path the platform binds without truncating (sun_path less its NUL). */
const SOCKET_PATH_MAX = process.platform === "darwin" ? 103 : 107;
/** The console's own answer to a challenge over HTTP (an edge route, no sign-in: it reveals nothing). */
export const INSTANCE_PATH = "/__instance";
const CHALLENGE = /^[0-9a-f]{32,128}$/;
const LINE_CAP = 4096;

export type InstanceRecord = { secret: string; pid: number; port: number; build: string; socket: string; startedAt: string };
export type HelloFacts = { pid: number; build: string; database: string; port: number };

export function readInstance(store: Store): InstanceRecord | null {
  const row = store.handle.prepare("SELECT secret, pid, port, build, socket, started_at FROM console_instance WHERE id = 1").get();
  if (row === undefined) return null;
  const secret = String(row["secret"]), pid = Number(row["pid"]), port = Number(row["port"]), socket = String(row["socket"]);
  if (!/^[0-9a-f]{64}$/.test(secret) || !Number.isSafeInteger(pid) || !Number.isInteger(port) || port < 1 || port > 65535 || !SOCKET_NAME.test(socket)) return null;
  return { secret, pid, port, build: String(row["build"]), socket, startedAt: String(row["started_at"]) };
}

/** A stopping console forgets itself — only its own record, never a newer start's. */
export function clearInstance(store: Store, secret: string): void {
  store.handle.prepare("DELETE FROM console_instance WHERE id = 1 AND secret = ?").run(secret);
}

export const socketProof = (secret: string, challenge: string): string => createHmac("sha256", secret).update(`socket:${challenge}`).digest("hex");
export const httpProof = (secret: string, challenge: string, address: string, port: number): string =>
  createHmac("sha256", secret).update(`http:${challenge} ${address} ${port}`).digest("hex");
const PROOF = /^[0-9a-f]{64}$/;
/** Constant-time comparison of two proofs, each first required to be exactly 64 hex characters. */
const same = (a: unknown, b: string): boolean => typeof a === "string" && PROOF.test(a) && PROOF.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** The HTTP answer: bound to the address and port THIS connection was received on, as the console saw them. */
export function instanceHttpAnswer(secret: string, challenge: string | null, local: { address: string | undefined; port: number | undefined }): { status: number; body: string } {
  if (challenge === null || !CHALLENGE.test(challenge) || local.address === undefined || local.port === undefined) return { status: 400, body: JSON.stringify({ error: "challenge" }) };
  return { status: 200, body: JSON.stringify({ proof: httpProof(secret, challenge, local.address, local.port) }) };
}

/**
 * The run directory must be private to this user: a real, canonical directory owned by this user with no access for
 * anyone else (0700), inside a canonical directory owned by this user that nobody else can write. Checked before any
 * change is made, and before connecting or binding.
 */
export function runDirProblem(dir: string, uid = process.getuid?.() ?? -1, mustExist = true): string | null {
  const parent = dirname(dir);
  let above;
  try { above = lstatSync(parent); } catch { return `${parent} doesn't exist`; }
  try { if (realpathSync(parent) !== parent) return `${parent} isn't its own real path`; } catch { return `${parent} doesn't exist`; }
  if (!above.isDirectory()) return `${parent} isn't a directory`;
  if (uid >= 0 && above.uid !== uid) return `${parent} belongs to another user`;
  if ((above.mode & 0o022) !== 0) return `${parent} can be written by other users`;
  let info;
  try { info = lstatSync(dir); } catch { return mustExist ? `${dir} doesn't exist` : null; }
  if (!info.isDirectory()) return `${dir} isn't a directory`;
  if (uid >= 0 && info.uid !== uid) return `${dir} belongs to another user`;
  if ((info.mode & 0o077) !== 0) return `${dir} is open to other users — Toolroll uses it only when it is yours alone (chmod 700)`;
  return null;
}
/** A socket path that binds exactly (no truncation), named as a console names its own. */
export function socketPathProblem(path: string): string | null {
  if (!SOCKET_NAME.test(basename(path))) return `${path} isn't a console socket`;
  if (Buffer.byteLength(path) > SOCKET_PATH_MAX) return `${path} is too long for a socket here`;
  return null;
}

/**
 * `up`: the run directory, made 0700 if it isn't there. An existing one is used only as it is (never chmodded): one
 * that isn't private to this user is refused. Everything is checked before anything is created.
 */
export function prepareRunDir(dir: string, uid = process.getuid?.() ?? -1): string | null {
  const before = runDirProblem(dir, uid, false);
  if (before !== null) return before;
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return `${dir} couldn't be made`; }
  return runDirProblem(dir, uid, true);
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
 * the socket proof; every other verb is refused. It reads nothing else and changes nothing. Bound under a fresh name
 * no other process has, so it never clears or replaces anything; its own listener removes it on close.
 */
export async function openInstanceSocket(databaseFile: string, facts: HelloFacts, secret: () => string | null): Promise<{ ok: true; name: string; close: () => void } | { ok: false; problem: string }> {
  const dir = instanceRunDir(databaseFile);
  const problem = prepareRunDir(dir);
  if (problem !== null) return { ok: false, problem };
  const name = `${randomBytes(8).toString("hex")}.sock`, socketPath = join(dir, name);
  const pathProblem = socketPathProblem(socketPath);
  if (pathProblem !== null) return { ok: false, problem: pathProblem };
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
      const key = secret();
      if (verb !== "hello" || typeof challenge !== "string" || !CHALLENGE.test(challenge) || key === null) return reply({ error: "refused" });
      reply({ ...facts, proof: socketProof(key, challenge) });
    });
  });
  // A Unix bind never replaces an existing path (EADDRINUSE).
  const listening = await new Promise<boolean>(resolve => { server.once("error", () => resolve(false)); server.listen(socketPath, () => resolve(true)); });
  if (!listening) return { ok: false, problem: `couldn't listen on ${socketPath}` };
  return { ok: true, name, close: () => { server.close(); } };
}

/** Whether a record's console is live: its socket answers a fresh challenge with the record's secret and pid. */
export async function recordIsLive(databaseFile: string, record: InstanceRecord, ask: typeof askSocket = askSocket): Promise<boolean> {
  const socketPath = join(instanceRunDir(databaseFile), record.socket);
  if (socketPathProblem(socketPath) !== null) return false;
  const challenge = randomBytes(32).toString("hex");
  const asked = await ask(socketPath, { verb: "hello", challenge }, 1_500);
  return "answer" in asked && asked.answer["pid"] === record.pid && same(asked.answer["proof"], socketProof(record.secret, challenge));
}

/**
 * `up` claims the record for its socket — unless a live console already holds it (another start on the same
 * database, by any spelling of its path). The write is a compare-and-set on the record it checked: two starts racing
 * can't both win. Null: not claimed (this console runs, but `toolroll` won't attach to it).
 */
export async function claimInstance(store: Store, databaseFile: string, facts: { pid: number; port: number; build: string; socket: string }, now: Date, isLive: (record: InstanceRecord) => Promise<boolean> = record => recordIsLive(databaseFile, record)): Promise<string | null> {
  const rawSecret = (): string | null => { const row = store.handle.prepare("SELECT secret FROM console_instance WHERE id = 1").get(); return row === undefined ? null : String(row["secret"]); };
  const checked = rawSecret();
  const current = readInstance(store);
  if (current !== null && await isLive(current)) return null;
  const secret = randomBytes(32).toString("hex");
  return store.transact(() => {
    // Exactly the record that was checked (or none): anything else is another start's newer claim.
    if (rawSecret() !== checked) return null;
    store.handle.prepare("INSERT INTO console_instance (id, secret, pid, port, build, socket, started_at) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET secret = excluded.secret, pid = excluded.pid, port = excluded.port, build = excluded.build, socket = excluded.socket, started_at = excluded.started_at")
      .run(secret, facts.pid, facts.port, facts.build, facts.socket, now.toISOString());
    return secret;
  });
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
  // No record: nothing is running here (a console that couldn't claim one isn't offered).
  const record = readInstance(store);
  if (record === null) return { ok: false, state: "none", message: "no console is running" };
  const dir = instanceRunDir(databaseFile);
  const problem = runDirProblem(dir) ?? socketPathProblem(join(dir, record.socket));
  if (problem !== null) return { ok: false, state: "refused", message: `the console's socket can't be trusted: ${problem}` };
  const socketPath = join(dir, record.socket);
  try {
    const socket = lstatSync(socketPath);
    if (!socket.isSocket() || (process.getuid !== undefined && socket.uid !== process.getuid())) return { ok: false, state: "refused", message: `the console's socket can't be trusted: ${socketPath} isn't this user's socket` };
  } catch { return { ok: false, state: "none", message: "no console is running" }; }
  const challenge = seams.challenge ?? (() => randomBytes(32).toString("hex"));
  const first = challenge();
  const asked = await (seams.ask ?? askSocket)(socketPath, { verb: "hello", challenge: first });
  if ("none" in asked) {
    // Stale (a console that died): nobody is listening, so nothing is running. Discovery removes nothing.
    if (asked.none === "no-listener") return { ok: false, state: "none", message: "no console is running" };
    return { ok: false, state: "refused", message: `the console's socket didn't answer — ${restart}` };
  }
  const hello = asked.answer;
  if (hello["build"] !== record.build || hello["build"] !== build) {
    return { ok: false, state: "refused", message: `the running console is a different build (${String(hello["build"] ?? "unknown")}, this is ${build}) — ${restart}` };
  }
  if (hello["pid"] !== record.pid || hello["port"] !== record.port || !same(hello["proof"], socketProof(record.secret, first))) {
    return { ok: false, state: "refused", message: `the console on the socket couldn't prove it's this installation's — ${restart}` };
  }
  const second = challenge();
  let body: unknown;
  try {
    const answer = await (seams.fetch ?? fetch)(`http://127.0.0.1:${record.port}${INSTANCE_PATH}?c=${second}`, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
    body = answer.status === 200 ? await answer.json() : null;
  } catch { body = null; }
  const proof = body !== null && typeof body === "object" ? (body as { proof?: unknown }).proof : undefined;
  if (!same(proof, httpProof(record.secret, second, "127.0.0.1", record.port))) {
    return { ok: false, state: "refused", message: `the address 127.0.0.1:${record.port} couldn't prove it's the console — ${restart}` };
  }
  return { ok: true, url: `http://127.0.0.1:${record.port}`, port: record.port, pid: record.pid, build: record.build };
}
