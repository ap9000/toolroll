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
/** Toolroll's own name, so it never collides with a project or worktree that happens to sit beside the database. */
export const INSTANCE_DIR = ".toolroll-run";
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

/** The record as stored: none, one this build can't read (never taken for none), or the record. */
export function readInstanceState(store: Store): { state: "none" } | { state: "invalid" } | { state: "ok"; record: InstanceRecord } {
  const row = store.handle.prepare("SELECT secret, pid, port, build, socket, started_at FROM console_instance WHERE id = 1").get();
  if (row === undefined) return { state: "none" };
  const secret = String(row["secret"]), pid = Number(row["pid"]), port = Number(row["port"]), socket = String(row["socket"]);
  if (!/^[0-9a-f]{64}$/.test(secret) || !Number.isSafeInteger(pid) || !Number.isInteger(port) || port < 1 || port > 65535 || !SOCKET_NAME.test(socket)) return { state: "invalid" };
  return { state: "ok", record: { secret, pid, port, build: String(row["build"]), socket, startedAt: String(row["started_at"]) } };
}
export function readInstance(store: Store): InstanceRecord | null {
  const read = readInstanceState(store);
  return read.state === "ok" ? read.record : null;
}

/** v147: the key epoch the running console recorded with its claim (easy-start C2), or null: none recorded. */
export function instanceKeyEpoch(store: Store): string | null {
  const row = store.handle.prepare("SELECT key_epoch FROM console_instance WHERE id = 1").get();
  return row === undefined || row["key_epoch"] == null ? null : String(row["key_epoch"]);
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
  try { lstatSync(join(dir, ".git")); return `${dir} holds a repository, not Toolroll's sockets`; } catch { /* as it should be */ }
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
 *
 * Easy start D: the one other verb is `link`, and only when the console passes `link`. The console answers with a fresh
 * challenge of its own; the asker must answer it with HMAC(secret, "link:" + challenge) — the secret is in the database
 * (behind the agent fence), so only a process that read it can — and then gets one local owner's one-time sign-in path.
 * Each challenge is spent by the first answer on its own connection, right or wrong; the "link:" domain keeps a hello or
 * HTTP proof from ever counting here. The request names no account: what the link signs in as is the console's own
 * decision (`link` returns null unless local mode is on).
 */
export async function openInstanceSocket(databaseFile: string, facts: HelloFacts, secret: () => string | null, link?: () => string | null): Promise<{ ok: true; name: string; close: () => void } | { ok: false; problem: string }> {
  const dir = instanceRunDir(databaseFile);
  const problem = prepareRunDir(dir);
  if (problem !== null) return { ok: false, problem };
  const name = `${randomBytes(8).toString("hex")}.sock`, socketPath = join(dir, name);
  const pathProblem = socketPathProblem(socketPath);
  if (pathProblem !== null) return { ok: false, problem: pathProblem };
  const server: Server = createServer(socket => {
    let buffer = "";
    // The link challenge this connection was given, until its one answer arrives.
    let challenged: string | null = null;
    let done = false;
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy());
    const reply = (body: object) => { done = true; socket.end(`${JSON.stringify(body)}\n`); };
    const answerLine = (line: string): void => {
      let asked: unknown;
      try { asked = JSON.parse(line); } catch { return reply({ error: "refused" }); }
      const field = (key: string): unknown => asked !== null && typeof asked === "object" && !Array.isArray(asked) ? (asked as Record<string, unknown>)[key] : undefined;
      const key = secret();
      if (challenged !== null) {
        // The one answer to this connection's challenge: spent now, whatever it says.
        const expected = key === null ? null : linkProof(key, challenged);
        challenged = null;
        if (expected === null || field("verb") !== "link-proof" || !same(field("proof"), expected)) return reply({ error: "refused" });
        let path: string | null = null;
        try { path = link?.() ?? null; } catch { path = null; }
        return reply(path === null ? { error: "no-link" } : { link: path });
      }
      const verb = field("verb");
      if (verb === "link" && link !== undefined && key !== null) {
        challenged = randomBytes(32).toString("hex");
        socket.write(`${JSON.stringify({ challenge: challenged })}\n`);
        return;
      }
      const challenge = field("challenge");
      if (verb !== "hello" || typeof challenge !== "string" || !CHALLENGE.test(challenge) || key === null) return reply({ error: "refused" });
      reply({ ...facts, proof: socketProof(key, challenge) });
    };
    socket.on("error", () => socket.destroy());
    socket.on("data", chunk => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > LINE_CAP) return void socket.destroy();
      for (let end = buffer.indexOf("\n"); end >= 0 && !done; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        answerLine(line);
      }
    });
  });
  // A Unix bind never replaces an existing path (EADDRINUSE).
  const listening = await new Promise<boolean>(resolve => { server.once("error", () => resolve(false)); server.listen(socketPath, () => resolve(true)); });
  if (!listening) return { ok: false, problem: `couldn't listen on ${socketPath}` };
  return { ok: true, name, close: () => { server.close(); } };
}

/** The `link` verb's answer to the console's challenge: bound to this verb, so no other proof ever counts for it. */
export const linkProof = (secret: string, challenge: string): string => createHmac("sha256", secret).update(`link:${challenge}`).digest("hex");
const LINK_PATH = /^\/login\/once\/[A-Za-z0-9_-]{16,128}$/;

/**
 * Ask the console on `socketPath` for a local owner's one-time sign-in path with the record's secret: `link`, the
 * console's challenge, then the proof. Null when it gives none (local mode off, a wrong or late answer, anything
 * malformed). The caller proves the console live first (proveLiveConsole) and opens the path on its proved address.
 */
export function askLink(socketPath: string, secret: string, timeoutMs = 5_000, connect: (path: string) => Socket = path => createConnection(path)): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false, buffer = "", sentProof = false;
    const done = (value: string | null) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const socket = connect(socketPath);
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("error", () => done(null));
    socket.on("connect", () => socket.write(`${JSON.stringify({ verb: "link" })}\n`));
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > LINE_CAP) return done(null);
      for (let end = buffer.indexOf("\n"); end >= 0 && !settled; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { return done(null); }
        const body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        if (!sentProof) {
          const challenge = body["challenge"];
          if (typeof challenge !== "string" || !/^[0-9a-f]{64}$/.test(challenge)) return done(null);
          sentProof = true;
          socket.write(`${JSON.stringify({ verb: "link-proof", proof: linkProof(secret, challenge) })}\n`);
        } else {
          const path = body["link"];
          return done(typeof path === "string" && LINK_PATH.test(path) ? path : null);
        }
      }
    });
    socket.on("end", () => done(null));
  });
}

/**
 * A local owner's one-time sign-in address from this installation's live console (easy start D, `toolroll open`): the
 * console is proved live on both channels first, then asked over its socket with the record's secret. The address is
 * always the proved console's own; null when there is no proved console or it gives no link.
 */
export async function requestLocalLink(databaseFile: string, store: Store, build: string, seams: AttachSeams & { askLink?: typeof askLink } = {}): Promise<{ ok: true; url: string; console: string } | { ok: false; message: string }> {
  const proof = await proveLiveConsole(databaseFile, store, build, seams);
  if (!proof.ok) return { ok: false, message: proof.message };
  const record = readInstance(store);
  if (record === null || record.pid !== proof.pid || record.port !== proof.port) return { ok: false, message: "the console changed while it was being checked" };
  const path = await (seams.askLink ?? askLink)(join(instanceRunDir(databaseFile), record.socket), record.secret);
  if (path === null) return { ok: false, message: "the console gave no sign-in link (local mode is off, or it is still starting)" };
  return { ok: true, url: new URL(path, proof.url).toString(), console: proof.url };
}

/**
 * A record's console: "live" (its socket answers a fresh challenge with the record's secret and pid), "gone" (nobody
 * is listening on its socket, or the socket isn't there), or "unknown" (anything else: slow, malformed, a wrong proof).
 * Only "gone" lets another start take the record.
 */
export async function recordLiveness(databaseFile: string, record: InstanceRecord, ask: typeof askSocket = askSocket): Promise<"live" | "gone" | "unknown"> {
  const socketPath = join(instanceRunDir(databaseFile), record.socket);
  if (socketPathProblem(socketPath) !== null) return "unknown";
  const challenge = randomBytes(32).toString("hex");
  const asked = await ask(socketPath, { verb: "hello", challenge }, 5_000);
  if ("none" in asked) return asked.none === "no-listener" ? "gone" : "unknown";
  return asked.answer["pid"] === record.pid && same(asked.answer["proof"], socketProof(record.secret, challenge)) ? "live" : "unknown";
}

/**
 * `up` claims the record for its socket — unless a live console already holds it (another start on the same
 * database, by any spelling of its path). The write is a compare-and-set on the record it checked: two starts racing
 * can't both win. Null: not claimed (this console runs, but `toolroll` won't attach to it).
 */
export async function claimInstance(store: Store, databaseFile: string, facts: { pid: number; port: number; build: string; socket: string; keyEpoch?: string }, now: Date, liveness: (record: InstanceRecord) => Promise<"live" | "gone" | "unknown"> = record => recordLiveness(databaseFile, record)): Promise<string | null> {
  const rawSecret = (): string | null => { const row = store.handle.prepare("SELECT secret FROM console_instance WHERE id = 1").get(); return row === undefined ? null : String(row["secret"]); };
  const checked = rawSecret();
  // Taken only from nobody, or from a console confirmed gone: never on a check that merely failed, and never over a
  // record this build can't read.
  const current = readInstanceState(store);
  if (current.state === "invalid") return null;
  if (current.state === "ok" && await liveness(current.record) !== "gone") return null;
  const secret = randomBytes(32).toString("hex");
  return store.transact(() => {
    // Exactly the record that was checked (or none): anything else is another start's newer claim.
    if (rawSecret() !== checked) return null;
    // v147: the start's key epoch (easy-start C2) is recorded with its claim; a claim without one records none.
    store.handle.prepare("INSERT INTO console_instance (id, secret, pid, port, build, socket, started_at, key_epoch) VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET secret = excluded.secret, pid = excluded.pid, port = excluded.port, build = excluded.build, socket = excluded.socket, started_at = excluded.started_at, key_epoch = excluded.key_epoch")
      .run(secret, facts.pid, facts.port, facts.build, facts.socket, now.toISOString(), facts.keyEpoch ?? null);
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
  // No record: nothing is running here (a console that couldn't claim one isn't offered). One this build can't read
  // isn't "nothing": it is refused.
  const read = readInstanceState(store);
  if (read.state === "none") return { ok: false, state: "none", message: "no console is running" };
  if (read.state === "invalid") return { ok: false, state: "refused", message: `the console's record can't be read — ${restart}` };
  const record = read.record;
  const dir = instanceRunDir(databaseFile);
  const problem = runDirProblem(dir) ?? socketPathProblem(join(dir, record.socket));
  if (problem !== null) return { ok: false, state: "refused", message: `the console's socket can't be trusted: ${problem}` };
  const socketPath = join(dir, record.socket);
  try {
    const socket = lstatSync(socketPath);
    if (!socket.isSocket() || (process.getuid !== undefined && socket.uid !== process.getuid())) return { ok: false, state: "refused", message: `the console's socket can't be trusted: ${socketPath} isn't this user's socket` };
  } catch (error) {
    // Only "not there" means nothing is running; a socket the system won't show can't be checked.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, state: "none", message: "no console is running" };
    return { ok: false, state: "refused", message: `the console's socket can't be checked — ${restart}` };
  }
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
