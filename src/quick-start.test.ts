/**
 * Bare `toolroll` in a repository (docs/plans/agents-cockpit.md B1): no console running → `up`; a console that proves
 * itself live → add the repository through the ordinary admission (if new) and open that console; anything that can't
 * prove itself → refused with the restart, and nothing opened. Under an agent or with --json nothing starts, is added
 * or opens: it says what it would do. Outside a repository it is not this command (the scan runs as before).
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { capturedEnvelope } from "./envelope.js";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { INSTANCE_PATH, instanceHttpAnswer, instanceSocketPath, openInstanceSocket, recordInstance } from "./console-instance.js";
import { isBareInvocation, runQuickStart, type QuickStartSeams } from "./quick-start.js";
import { openStore } from "./store.js";

const BUILD = "9.9.9-test";
let dir: string, state: string, databaseFile: string, repo: string;
const closers: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join("/tmp", "so-qs-")));
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
  const socket = await openInstanceSocket(instanceSocketPath(databaseFile), { pid: process.pid, build: BUILD, database: databaseFile, port }, () => secret);
  if (!socket.ok) throw new Error(socket.problem);
  secret = recordInstance(store, { pid: process.pid, port, build: BUILD }, new Date());
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

test("a console that proves itself: a new repository is added through admission, then that console opens", async () => {
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

test("something that can't prove it is the console is refused with the restart; nothing is added or opened", async () => {
  await liveConsole();
  const { value, write, did, out } = seams({ build: "1.0.0" });
  expect(await runQuickStart([], write, value)).toBe(3);
  expect(did).toEqual([]);
  expect(out.join("\n")).toContain("toolroll up");
});

test("under an agent, or with --json, nothing starts, is added or opens: it says what it would do", async () => {
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
