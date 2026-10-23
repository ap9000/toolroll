/**
 * Bare `toolroll` in a repository (docs/plans/agents-cockpit.md B1): no console running → `up`; a console that proves
 * itself live → add the repository through the ordinary admission (if new) and open that console; anything that can't
 * prove itself → refused with the restart, and nothing opened. Under an agent or with --json nothing starts, is added
 * or opens: it says what it would do. Outside a repository it is not this command (the scan runs as before).
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { capturedEnvelope } from "./envelope.js";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { claimInstance, INSTANCE_PATH, instanceHttpAnswer, openInstanceSocket } from "./console-instance.js";
import { isBareInvocation, runQuickStart, type QuickStartSeams } from "./quick-start.js";
import { openStore, SCHEMA_VERSION } from "./store.js";
import { shortTempDir } from "../test/short-temp.js";
import { INSIDE_FENCE } from "../test/inside-fence.js";

const BUILD = "9.9.9-test";
let dir: string, state: string, databaseFile: string, repo: string;
const closers: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  dir = shortTempDir("so-qs-");
  state = join(dir, "s"); repo = join(dir, "shop");
  mkdirSync(state, { mode: 0o700 }); mkdirSync(repo);
  databaseFile = join(state, "orders.db");
});
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); rmSync(dir, { recursive: true, force: true }); });

/** A live console for this database: its record, HTTP listener and discovery socket. */
async function liveConsole(): Promise<number> {
  const store = openStore(databaseFile);
  let secret: string | null = null;
  const http: HttpServer = createHttpServer((request, response) => {
    const answer = instanceHttpAnswer(secret!, new URL(request.url ?? "/", "http://x").searchParams.get("c"), { address: request.socket.localAddress, port: request.socket.localPort });
    response.writeHead(request.url?.startsWith(INSTANCE_PATH) ? answer.status : 404); response.end(answer.body);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", () => resolve()));
  const port = (http.address() as { port: number }).port;
  const socket = await openInstanceSocket(databaseFile, { pid: process.pid, build: BUILD, database: databaseFile, port }, () => secret);
  if (!socket.ok) throw new Error(socket.problem);
  secret = await claimInstance(store, databaseFile, { pid: process.pid, port, build: BUILD, socket: socket.name }, new Date());
  store.close();
  closers.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }), () => socket.close());
  return port;
}

function seams(over: Partial<QuickStartSeams> = {}) {
  const did: string[] = [];
  const out: string[] = [];
  const value: QuickStartSeams = {
    databaseFile, cwd: repo, env: {}, build: BUILD, terminal: true, underAgent: false,
    findRepo: async () => repo,
    enrolled: async () => false,
    admit: async path => { did.push(`admit ${path}`); return 0; },
    startUp: async () => { did.push("up"); return 0; },
    openBrowser: url => { did.push(`open ${url}`); },
    ...over,
  };
  return { value, did, out, write: (line: string) => out.push(line) };
}

test("bare means nothing, or only --json", () => {
  expect(isBareInvocation([])).toBe(true);
  expect(isBareInvocation(["--json"])).toBe(true);
  expect(isBareInvocation(["."])).toBe(false);
  expect(isBareInvocation(["--all"])).toBe(false);
});

test("outside a repository it is not this command", async () => {
  const { value, write, did } = seams({ findRepo: async () => null });
  expect(await runQuickStart([], write, value)).toBeNull();
  expect(did).toEqual([]);
});

test("with no console running, it starts one for this repository", async () => {
  const { value, write, did } = seams();
  expect(await runQuickStart([], write, value)).toBe(0);
  expect(did).toEqual(["up"]);
});

// Inside the plane's macOS check fence every folder a check may write is too deep for this test's unix socket path (about 104 bytes); CI (Linux, and the tag's macOS jobs) runs it unfenced.
test.skipIf(INSIDE_FENCE)("a console that proves itself: a new repository is added through admission, then that console opens", async () => {
  const port = await liveConsole();
  const { value, write, did, out } = seams();
  expect(await runQuickStart([], write, value)).toBe(0);
  expect(did).toEqual([`admit ${repo}`, `open http://127.0.0.1:${port}`]);
  expect(out).toEqual([`Toolroll is on http://127.0.0.1:${port}`]);
  // Already added: only opened.
  const again = seams({ enrolled: async () => true });
  expect(await runQuickStart([], again.write, again.value)).toBe(0);
  expect(again.did).toEqual([`open http://127.0.0.1:${port}`]);
});

// Inside the plane's macOS check fence every folder a check may write is too deep for this test's unix socket path (about 104 bytes); CI (Linux, and the tag's macOS jobs) runs it unfenced.
test.skipIf(INSIDE_FENCE)("something that can't prove it is the console is refused with the restart; nothing is added or opened", async () => {
  await liveConsole();
  const { value, write, did, out } = seams({ build: "1.0.0" });
  expect(await runQuickStart([], write, value)).toBe(3);
  expect(did).toEqual([]);
  expect(out.join("\n")).toContain("toolroll up");
});

// Inside the plane's macOS check fence every folder a check may write is too deep for this test's unix socket path (about 104 bytes); CI (Linux, and the tag's macOS jobs) runs it unfenced.
test.skipIf(INSIDE_FENCE)("under an agent, or with --json, nothing starts, is added or opens: it says what it would do", async () => {
  const quiet = seams({ underAgent: true });
  expect(existsSync(databaseFile)).toBe(false);
  expect(await runQuickStart([], quiet.write, quiet.value)).toBe(0);
  expect(quiet.did).toEqual([]);
  expect(quiet.out).toEqual([`Would start Toolroll for ${repo} (toolroll up).`]);
  expect(existsSync(databaseFile)).toBe(false);
  const port = await liveConsole();
  const json = seams();
  expect(await runQuickStart(["--json"], json.write, json.value)).toBe(0);
  expect(json.did).toEqual([]);
  expect(JSON.parse(json.out[0]!)).toMatchObject({ envelopeVersion: expect.any(Number), ok: true, command: "toolroll", repo, would: "add-and-open", url: `http://127.0.0.1:${port}`, dryRun: true });
  // The envelope is the CLI's own (it reaches -o), and the preview changed nothing: no database where there was none.
  expect(capturedEnvelope()).toBe(json.out[0]);
});

test("a database that can't be checked is refused, never read as nothing running; an older one is (up brings it up to date)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  openStore(databaseFile).close();
  const setVersion = (version: number) => { const db = new DatabaseSync(databaseFile); db.prepare("UPDATE schema_version SET version = ?").run(version); db.close(); };
  setVersion(SCHEMA_VERSION + 1);
  const newer = seams();
  expect(await runQuickStart([], newer.write, newer.value)).toBe(3);
  expect(newer.did).toEqual([]);
  setVersion(-SCHEMA_VERSION);
  const migrating = seams();
  expect(await runQuickStart([], migrating.write, migrating.value)).toBe(3);
  setVersion(SCHEMA_VERSION - 1);
  const older = seams();
  expect(await runQuickStart([], older.write, older.value)).toBe(0);
  expect(older.did).toEqual(["up"]);
  // Two version rows (the store's own strict reader refuses them): can't be checked, never "older".
  { const db = new DatabaseSync(databaseFile); db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION - 1); db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION + 1); db.close(); }
  const twoRows = seams();
  expect(await runQuickStart([], twoRows.write, twoRows.value)).toBe(3);
  expect(twoRows.did).toEqual([]);
  // A folder that won't show whether the database is there: refused, never "nothing running".
  chmodSync(state, 0o000);
  try {
    const hidden = seams();
    expect(await runQuickStart([], hidden.write, hidden.value)).toBe(3);
    expect(hidden.did).toEqual([]);
  } finally { chmodSync(state, 0o700); }
  writeFileSync(databaseFile, "not a database");
  const broken = seams();
  expect(await runQuickStart([], broken.write, broken.value)).toBe(3);
  expect(broken.did).toEqual([]);
});

// Inside the plane's macOS check fence every folder a check may write is too deep for this test's unix socket path (about 104 bytes); CI (Linux, and the tag's macOS jobs) runs it unfenced.
test.skipIf(INSIDE_FENCE)("a console that stops while the project is being added is never opened: proved again right before", async () => {
  await liveConsole();
  const { value, write, did } = seams({ admit: async path => { did.push(`admit ${path}`); for (const close of closers.splice(0).reverse()) await close(); return 0; } });
  expect(await runQuickStart([], write, value)).toBe(3);
  expect(did).toEqual([`admit ${repo}`]);
});

// Inside the plane's macOS check fence every folder a check may write is too deep for this test's unix socket path (about 104 bytes); CI (Linux, and the tag's macOS jobs) runs it unfenced.
test.skipIf(INSIDE_FENCE)("an already-added project is opened only after the console proves itself again, after reading the registry", async () => {
  await liveConsole();
  const { value, write, did } = seams({ enrolled: async () => { for (const close of closers.splice(0).reverse()) await close(); return true; } });
  expect(await runQuickStart([], write, value)).toBe(3);
  expect(did).toEqual([]);
});
