/**
 * Wire budgets, slice 0 of the fluid pages plan (`npm run test:perf:wire`, docs/TESTING.md "Wire budgets"): what the browser receives TODAY for the
 * four everyday pages, measured on the seeded wire world (test/wire-world.ts), and held to committed ceilings
 * (wire-ceilings.json) so a pull request that sends more fails here. It changes no runtime behaviour.
 *
 * Measured, per page and viewer:
 * - the document load (the HTTP page: its bytes, and the workspace JSON embedded in it) and the in-place read
 *   (`?format=workspace`, x-toolroll-read: navigate) that "pages change in place" fetches: bytes and row counts;
 * - SQL statements and projection calls per request (wire-probe.ts), after any change (cold) and again at once (warm);
 * - what one live-room change costs today: the frames each open page's stream receives after one task moves, and the
 *   whole-workspace re-read each page then makes (live-bus.ts: rooms send a hint, the page reads itself again).
 * Bytes are pre-compression. Byte, row, statement and call counts are deterministic and gated; server time and memory
 * are reported, never gated.
 *
 * Raising a ceiling is deliberate: run with WIRE_WRITE_CEILINGS=1 to rewrite wire-ceilings.json from this run (measured
 * value plus the margin below), or edit the one number by hand, and commit it: the diff and the CI summary name it.
 */
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { background, installSqlCounter, newTally, projectionTotal, tallyRequests, withTally, type Tally } from "./wire-probe.js";
import { seeded, seedWireWorld, WIRE_NOW, type WireWorld } from "../wire-world.js";
import type { BrowserWorkspace } from "../../src/browser-workspace.js";
import type { DecisionServer } from "../../src/serve.js";
import type { Store } from "../../src/store.js";
// @ts-expect-error plain ESM script without declarations
import { formatReport, violationsOf } from "../../scripts/wire-report.mjs";

// Projection calls: the reads behind every list and the chrome, counted where another module calls them.
vi.mock("../../src/work-index.js", async importOriginal => (await import("./wire-probe.js")).counted(await importOriginal<Record<string, unknown>>(), "workIndex",
  ["workIndexPage", "workIndexTask", "workCountsByProject", "workStateRows", "workOutcomeRows", "workReadyForReview", "workTidyRows"]));
vi.mock("../../src/assignment.js", async importOriginal => (await import("./wire-probe.js")).counted(await importOriginal<Record<string, unknown>>(), "assignment",
  ["assignmentOf", "assignmentChecksForRun"]));
vi.mock("../../src/browser-workspace.js", async importOriginal => (await import("./wire-probe.js")).counted(await importOriginal<Record<string, unknown>>(), "workspace",
  ["browserCrewOf"]));

// Times on the pages read in UTC wherever this runs (when-html.ts reads the machine's zone).
process.env["TZ"] = "UTC";
const HERE = import.meta.dirname;
const ROOT = join(HERE, "..", "..");
const CEILINGS_FILE = join(HERE, "wire-ceilings.json");
const OUT = process.env["WIRE_OUT"] ?? join(ROOT, "evidence", "wire-budgets.json");
/** How long a live probe listens after its one write: the workspace room speaks at once, the summary room after 1 s. */
const LIVE_LISTEN_MS = 3_000;
/** Development only: a smaller world (WIRE_TASKS) and a progress log (WIRE_DEBUG=<file>). A smaller world's numbers are
 * printed, never held to the ceilings, and never written as them. */
const DEV_TASKS = process.env["WIRE_TASKS"] === undefined ? undefined : Number(process.env["WIRE_TASKS"]);
const debug = (line: string) => { const file = process.env["WIRE_DEBUG"]; if (file) appendFileSync(file, `${new Date(performance.timeOrigin + performance.now()).toISOString()} ${line}\n`); };

type Unit = "bytes" | "count" | "ms";
type Row = { id: string; scenario: string; metric: string; unit: Unit; observed: number; gated: boolean };
const rows: Row[] = [];
const gate = (scenario: string, metric: string, unit: Exclude<Unit, "ms">, observed: number) => rows.push({ id: `${scenario} | ${metric}`, scenario, metric, unit, observed, gated: true });
const info = (scenario: string, metric: string, unit: Unit, observed: number) => rows.push({ id: `${scenario} | ${metric}`, scenario, metric, unit, observed: Math.round(observed * 10) / 10, gated: false });

let root: string, store: Store, server: DecisionServer, world: WireWorld, port: number;
let probe: ReturnType<typeof tallyRequests>;
const cookies: Record<string, string> = {};
const realRandom = Math.random;

type Answer = { status: number; body: string; headers: IncomingHttpHeaders; tally: Tally; ms: number; heap: number };
function send(path: string, headers: Record<string, string>, method = "GET", body?: string): Promise<Answer> {
  const tally = newTally();
  probe.expect(tally);
  debug(`${method} ${path}`);
  const heapBefore = process.memoryUsage().heapUsed, started = performance.now();
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, connection: "close", ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      // A turn of the loop after the last byte: work the response's own `finish` started is charged to it too.
      response.on("end", () => setImmediate(() => debug(`  ${response.statusCode} ${Buffer.concat(chunks).length} B, ${tally.statements} statements, ${JSON.stringify(tally.projections)}, ${Math.round(performance.now() - started)} ms`)));
      response.on("end", () => setImmediate(() => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers, tally,
        ms: performance.now() - started, heap: process.memoryUsage().heapUsed - heapBefore })));
    });
    request.on("error", reject);
    request.end(body);
  });
}
const APP_WORK = { "x-toolroll-work": "1" };
const documentRead = (path: string, who: string) => send(path, { cookie: cookies[who]!, accept: "text/html" });
const inPlaceRead = (path: string, who: string) => send(`${path}${path.includes("?") ? "&" : "?"}format=workspace`, { cookie: cookies[who]!, accept: "application/json", "x-toolroll-read": "navigate", ...APP_WORK });

/**
 * Bytes as any machine would count them. The world lives in this machine's temp folder and the console on a free port,
 * and both reach the pages (project paths, links); each is counted as a fixed stand-in of fixed length, so a byte
 * count never depends on where the run happened.
 */
function wireBytes(text: string): number {
  const swaps: [string, string][] = [[root, ROOT_STAND_IN], [encodeURIComponent(root), encodeURIComponent(ROOT_STAND_IN)], [`127.0.0.1:${port}`, "127.0.0.1:65000"]];
  let out = text;
  for (const [from, to] of swaps) out = out.split(from).join(to);
  return Buffer.byteLength(out);
}
const ROOT_STAND_IN = "/home/toolroll/wire-world";

/** "After any change": the workspace revision moves (a cache-metadata row only; live-bus.ts), so every revision-keyed
 * cache the server holds reads again, as it does after a real write. */
function bump(): void {
  store.handle.exec(`INSERT INTO service_cursor(key,value,updated_at) VALUES ('workspace-content:v1',1,'${WIRE_NOW.toISOString()}')
    ON CONFLICT(key) DO UPDATE SET value=service_cursor.value+1`);
}

function embeddedWorkspace(html: string): { json: string; workspace: BrowserWorkspace } {
  const json = /<script type="application\/json" id="standing-orders-workspace-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (json === undefined) throw Error("no workspace JSON in the document");
  return { json, workspace: JSON.parse(json) as BrowserWorkspace };
}

/** The rows a page carries: its view's own list rows, the chrome's rows, and the conversation's messages. */
function rowsOf(ws: BrowserWorkspace): { view: number; chrome: number; messages: number } {
  const view = ws.view;
  let viewRows = 0;
  if (view?.kind === "tasks") viewRows = view.rows.length + (view.board ?? []).reduce((sum, column) => sum + column.rows.length, 0);
  else if (view?.kind === "home") viewRows = view.groups.reduce((sum, group) => sum + group.rows.length, 0) + view.working.length + view.finishedToday.rows.length;
  else if (view?.kind === "task") viewRows = (view.thread?.length ?? 0) + view.sections.length + view.lead.length + (view.result?.attempts.length ?? 0) + (view.result?.selected.mismatch?.rows.length ?? 0);
  else if (view?.kind === "result") viewRows = view.results.length;
  const chrome = ws.crew.length + ws.projects.length + (ws.chats?.length ?? 0) + ws.navigation.length + (ws.projectStates?.length ?? 0)
    + ((ws as { needsYouByProject?: unknown[] }).needsYouByProject?.length ?? 0) + ws.notices.length;
  const messages = (ws.conversation?.messages.length ?? 0) + (ws.conversation?.previous?.messages.length ?? 0);
  return { view: viewRows, chrome, messages };
}

/** The rooms a page's one live stream joins, as the app decides them (browser/app.tsx, live-task.tsx, live-reply.tsx). */
function roomsOf(ws: BrowserWorkspace): string[] {
  if (ws.sensitive) return [];
  const rooms: string[] = [];
  const view = ws.view;
  if (ws.conversation !== null || ws.refreshSeconds !== undefined || view?.kind === "home" || view?.kind === "agents") rooms.push("workspace");
  if (view?.kind === "task" && view.live) rooms.push(view.live.room);
  if (ws.projectStates !== undefined) rooms.push("summary");
  if (ws.conversation !== null) {
    const chat = ws.conversation, query = new URLSearchParams();
    if (chat.taskId) query.set("task", chat.taskId);
    else if (chat.project) query.set("project", chat.project);
    rooms.push(query.toString() === "" ? "chat" : `chat?${query}`);
  }
  return rooms;
}

const PAGES = [
  { name: "Home", path: "/" },
  { name: "Tasks", path: "/tasks" },
  { name: "Tasks (state filter: failed)", path: "/tasks?state=failed" },
  { name: "Tasks (board)", path: "/tasks?layout=board" },
  { name: "Result", path: "" /* filled from the world */ },
  { name: "Chat", path: "/chat" },
] as const;
const pathOf = (page: (typeof PAGES)[number]) => page.name === "Result" ? `/t/${encodeURIComponent(world.resultTask)}?tab=result` : page.path;

beforeAll(async () => {
  // Fixed randomness for anything the server draws from Math.random; fixed clock for every Date it reads.
  Math.random = seeded(7);
  vi.useFakeTimers({ toFake: ["Date"], now: WIRE_NOW });
  installSqlCounter();
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-wire-")));
  const { openStore } = await import("../../src/store.js");
  const { createDecisionServer } = await import("../../src/serve.js");
  store = openStore(join(root, "config", "orders.db"));
  const seededAt = performance.now();
  world = seedWireWorld(store, root, { ...(DEV_TASKS === undefined ? {} : { tasks: DEV_TASKS }), progress: debug });
  debug("seeded");
  info("World", "seed time", "ms", performance.now() - seededAt);
  const refuse = async (): Promise<never> => { throw Error("the wire budgets never call a model or the network"); };
  // The server's own periodic work (its request budget's flush) runs in the background tally, never a measured one.
  server = withTally(background, () => createDecisionServer({
    store, evidenceRoot: world.evidenceRoot, repos: world.repos, clock: () => new Date(WIRE_NOW), connectionHome: root, toolHome: root, fenceAvailable: false,
    connectionProbe: async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false }),
    modelCatalogFetcher: refuse as typeof fetch, chatFetcher: refuse as typeof fetch, subscriptionChatRunner: refuse,
    modelRunner: async () => ({ code: 1, stdout: "", stderr: "" }),
    firstTaskRunner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: true }),
    ghList: async () => ({ ok: false, reason: "gh-missing", message: "gh is not installed" }) as never,
  }));
  probe = tallyRequests(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  for (const [who, token] of Object.entries(world.people)) {
    const login = await send("/login", { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${port}` }, "POST", new URLSearchParams({ name: who, token }).toString());
    if (login.status !== 303) throw Error(`sign-in for ${who}: ${login.status}`);
    cookies[who] = String(login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  }
}, 600_000);

afterAll(async () => {
  Math.random = realRandom;
  vi.useRealTimers();
  if (server?.listening) { server.closeAllConnections?.(); await new Promise<void>(resolve => server.close(() => resolve())); }
  store?.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

test("wire budgets: what the browser receives today stays within its committed ceilings", async () => {
  const c = world.counts;
  info("World", "tasks", "count", c.tasks); info("World", "runs", "count", c.runs); info("World", "artifacts on disk", "count", c.artifacts);
  info("World", "artifact bytes on disk", "bytes", c.artifactBytes); info("World", "ledger rows", "count", c.ledger); info("World", "lead messages", "count", c.leadMessages);

  // ---- every page, as the operator; Tasks and its board as the project-limited viewer ----
  const viewers: [string, string, readonly (typeof PAGES)[number][]][] = [
    ["alex", "operator", PAGES],
    // A viewer has no Home (it opens Tasks): their Tasks list and board.
    ["sam", "project-limited viewer", PAGES.filter(page => page.name === "Tasks" || page.name === "Tasks (board)")],
  ];
  const opened: Record<string, BrowserWorkspace> = {};
  for (const [who, label, pages] of viewers) {
    for (const page of pages) {
      const path = pathOf(page), scenario = `${label} · ${page.name}`;
      // The document load: the HTTP page with its embedded workspace.
      bump();
      const doc = await documentRead(path, who);
      expect(doc.status, `${scenario} document (${String(doc.headers.location ?? "")})`).toBe(200);
      const embedded = embeddedWorkspace(doc.body);
      gate(`${scenario} · document`, "bytes", "bytes", wireBytes(doc.body));
      gate(`${scenario} · document`, "embedded workspace bytes", "bytes", wireBytes(embedded.json));
      gate(`${scenario} · document`, "SQL statements", "count", doc.tally.statements);
      gate(`${scenario} · document`, "projection calls", "count", projectionTotal(doc.tally));
      info(`${scenario} · document`, "server time", "ms", doc.ms);
      // The in-place read (pages change in place), after a change, then again at once.
      bump();
      const cold = await inPlaceRead(path, who);
      expect(cold.status, `${scenario} in-place read`).toBe(200);
      const ws = JSON.parse(cold.body) as BrowserWorkspace;
      if (process.env["WIRE_DEBUG"]) writeFileSync(`${process.env["WIRE_DEBUG"]}.${who}-${page.name.replace(/[^a-z]+/gi, "-")}.json`, cold.body);
      const counted = rowsOf(ws);
      gate(`${scenario} · in-place read, cold`, "bytes", "bytes", wireBytes(cold.body));
      gate(`${scenario} · in-place read, cold`, "view rows", "count", counted.view);
      gate(`${scenario} · in-place read, cold`, "chrome rows", "count", counted.chrome);
      if (counted.messages > 0) gate(`${scenario} · in-place read, cold`, "conversation messages", "count", counted.messages);
      gate(`${scenario} · in-place read, cold`, "SQL statements", "count", cold.tally.statements);
      gate(`${scenario} · in-place read, cold`, "projection calls", "count", projectionTotal(cold.tally));
      info(`${scenario} · in-place read, cold`, "server time", "ms", cold.ms);
      info(`${scenario} · in-place read, cold`, "heap delta", "bytes", cold.heap);
      const warm = await inPlaceRead(path, who);
      expect(warm.status).toBe(200);
      gate(`${scenario} · in-place read, warm`, "SQL statements", "count", warm.tally.statements);
      gate(`${scenario} · in-place read, warm`, "projection calls", "count", projectionTotal(warm.tally));
      info(`${scenario} · in-place read, warm`, "server time", "ms", warm.ms);
      opened[`${who} ${page.name}`] = ws;
    }
  }

  // The world reads as a busy team's: a full first page, things waiting, a Ready result, a long conversation, and a
  // viewer who sees only their own project. (A broken seed fails here rather than shrinking every number.)
  const tasks = opened["alex Tasks"]!.view, home = opened["alex Home"]!.view, result = opened["alex Result"]!.view;
  expect(tasks?.kind === "tasks" && tasks.rows.length).toBe(40);
  expect(home?.kind === "home" && home.groups.length).toBeGreaterThan(0);
  expect(result?.kind === "task" && result.result?.selected.taskId).toBe(`${world.resultTask}-r2`);
  expect(opened["alex Chat"]!.conversation?.messages.length).toBeGreaterThanOrEqual(40);
  const samTasks = opened["sam Tasks"]!.view;
  expect(samTasks?.kind === "tasks" && samTasks.rows.length > 0 && samTasks.rows.every(row => row.project === null || row.project === world.samProject.split("/").pop())).toBe(true);

  // ---- one live-room change: four open pages, one task moves ----
  await liveChange(opened);

  // ---- the browser bundle every page loads ----
  const bundle = join(ROOT, "dist", "browser", "workspace.js");
  expect(existsSync(bundle), "the build's browser bundle (test/ensure-build.ts builds it)").toBe(true);
  const bytes = readFileSync(bundle);
  gate("Browser bundle · workspace.js", "gzip bytes", "bytes", gzipSync(bytes, { level: 9 }).length);
  info("Browser bundle · workspace.js", "raw bytes", "bytes", bytes.length);

  // ---- ceilings ----
  const ceilings: Record<string, number> = existsSync(CEILINGS_FILE) ? JSON.parse(readFileSync(CEILINGS_FILE, "utf8")).ceilings : {};
  if (process.env["WIRE_WRITE_CEILINGS"] === "1" && DEV_TASKS === undefined) {
    const next = Object.fromEntries(rows.filter(row => row.gated).map(row => [row.id, ceilingFor(row)]));
    writeFileSync(CEILINGS_FILE, `${JSON.stringify({ schemaVersion: 1, note: "Wire budget ceilings (test/perf/wire.wire.test.ts). Raise one only on purpose: docs/TESTING.md \"Wire budgets\".", ceilings: next }, null, 2)}\n`);
    Object.assign(ceilings, next);
  }
  const report = {
    schemaVersion: 1, sha: process.env["TESTED_SHA"] ?? process.env["GITHUB_SHA"] ?? null, generatedAt: WIRE_NOW.toISOString(),
    rows: rows.map(row => ({ ...row, ceiling: row.gated ? ceilings[row.id] ?? null : null })),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(formatReport(report, null));
  if (DEV_TASKS === undefined) expect(violationsOf(report)).toEqual([]);
}, 900_000);

/** Today's margin over a measured value: bytes +5% (at least 512 B), counts +10% (at least 2). */
function ceilingFor(row: Row): number {
  if (row.unit === "bytes") return row.observed + Math.max(512, Math.ceil(row.observed * 0.05));
  return row.observed + Math.max(2, Math.ceil(row.observed * 0.1));
}

type Frame = { event: string; room: string | null; bytes: number };
type Stream = { frames: Frame[]; close: () => void; status: number };
function openStream(rooms: string[], who: string): Promise<Stream> {
  const query = new URLSearchParams(rooms.map(room => ["room", room]));
  probe.expect(newTally());
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    let buffer = "";
    const request = httpRequest({ host: "127.0.0.1", port, path: `/live?${query}`, headers: { host: `127.0.0.1:${port}`, cookie: cookies[who]!, accept: "text/event-stream" } }, response => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "comment";
          let room: string | null = null;
          try { room = (JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "{}") as { room?: string }).room ?? null; } catch { /* a comment */ }
          frames.push({ event, room, bytes: wireBytes(frame) });
        }
      });
      resolve({ frames, status: response.statusCode!, close: () => { request.destroy(); } });
    });
    request.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
    request.end();
  });
}
/** The address a page re-reads itself at (browser/workspace-client.ts readWorkspace): its refreshUrl, as workspace data. */
function refreshOf(ws: BrowserWorkspace): string {
  const url = new URL(ws.refreshUrl, "http://wire.local");
  url.searchParams.set("format", "workspace");
  url.searchParams.delete("request");
  return url.pathname + url.search;
}
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** What a page is told: every event but the stream's keep-alive comments (transport, every 15 s, never content). */
const told = (frames: readonly Frame[]) => frames.filter(one => one.event !== "comment");
/** Listen until the streams and the work being watched are quiet: at least LIVE_LISTEN_MS, then until 1.5 s pass with no
 * new event and no statement run in `work` (a busy world's summary read takes longer than the listen), at most a minute. */
async function quiet(streams: Stream[], work: Tally): Promise<void> {
  const count = () => streams.reduce((sum, one) => sum + told(one.frames).length, 0) + work.statements;
  await settle(LIVE_LISTEN_MS);
  for (let waited = LIVE_LISTEN_MS, seen = count(); waited < 60_000; waited += 1_500) {
    await settle(1_500);
    if (count() === seen) return;
    seen = count();
  }
}

/**
 * What one live-room change costs today. Home, Tasks, the result page and Chat are open (the operator's), each with its
 * one stream; one task in a project every page shows moves state. Counted: the frames each stream receives, the room
 * reads the write sets off on the server, and the whole-workspace re-read each page makes after its hint, as the app
 * makes it (browser/app.tsx check: a workspace `change` re-reads with the page's ETag; a task room `change` re-reads
 * without one).
 */
async function liveChange(opened: Record<string, BrowserWorkspace>): Promise<void> {
  const pages = ["Home", "Tasks", "Result", "Chat"].map(name => {
    const page = PAGES.find(one => one.name === name)!;
    return { name, path: pathOf(page), ws: opened[`alex ${name}`]! };
  });
  // Each page's own ETag, from a re-read of it as it stands now (the app keeps the last one it saw).
  bump();
  const tags: Record<string, string | null> = {};
  for (const page of pages) {
    const read = await send(refreshOf(page.ws), { cookie: cookies["alex"]!, accept: "application/json", ...APP_WORK });
    tags[page.name] = typeof read.headers.etag === "string" ? read.headers.etag : null;
    page.ws = JSON.parse(read.body) as BrowserWorkspace;
  }
  const streams: Record<string, Stream> = {};
  try {
    for (const page of pages) {
      const rooms = roomsOf(page.ws);
      info(`Live change · ${page.name}`, "rooms joined", "count", rooms.length);
      streams[page.name] = await openStream(rooms, "alex");
      expect(streams[page.name]!.status, `${page.name} live stream`).toBe(200);
    }
    await quiet(Object.values(streams), newTally());
    for (const page of pages) {
      const frames = told(streams[page.name]!.frames);
      gate(`Live change · ${page.name} · stream opened`, "events", "count", frames.length);
      gate(`Live change · ${page.name} · stream opened`, "bytes", "bytes", frames.reduce((sum, one) => sum + one.bytes, 0));
      streams[page.name]!.frames.length = 0;
    }
    // The one write: the task moves. What it sets off on the server (the bus's read, each room's fingerprint, the summary
    // snapshot) runs in timers its commit schedules, so in the write's own context: counted there, past the write itself.
    // Keep-alives and each room's 30-second safety net run in the streams' contexts, never counted here.
    const change = newTally();
    withTally(change, () => store.setTaskState(world.probeTask, "cancelled", WIRE_NOW));
    const own = { statements: change.statements, projections: projectionTotal(change) };
    await quiet(Object.values(streams), change);
    // What each page heard by then; the re-reads below may write (a session's bookkeeping) and say more, never counted.
    const heard = Object.fromEntries(pages.map(page => [page.name, [...streams[page.name]!.frames]]));
    gate("Live change · server", "SQL statements after the write (bus and room reads)", "count", change.statements - own.statements);
    gate("Live change · server", "projection calls after the write (bus and room reads)", "count", projectionTotal(change) - own.projections);
    let rereads = 0, rereadBytes = 0, rereadStatements = 0;
    for (const page of pages) {
      debug(`live ${page.name}: ${heard[page.name]!.map(one => `${one.event}@${one.room} ${one.bytes}`).join(", ")}`);
      const frames = told(heard[page.name]!);
      gate(`Live change · ${page.name} · after one write`, "events", "count", frames.length);
      gate(`Live change · ${page.name} · after one write`, "bytes", "bytes", frames.reduce((sum, one) => sum + one.bytes, 0));
      const live = page.ws.view?.kind === "task" ? page.ws.view.live ?? null : null;
      const workspaceHint = frames.some(one => one.event === "change" && one.room === "workspace");
      const taskHint = live !== null && frames.some(one => one.event === "change" && one.room === live.room);
      if (!workspaceHint && !taskHint) { gate(`Live change · ${page.name} · re-read`, "re-reads", "count", 0); continue; }
      // The page reads itself again: the whole workspace, with its ETag unless a task room nudged it (a forced read).
      const read = await send(refreshOf(page.ws),
        { cookie: cookies["alex"]!, accept: "application/json", ...APP_WORK, ...(!taskHint && tags[page.name] ? { "if-none-match": tags[page.name]! } : {}) });
      rereads++; rereadBytes += wireBytes(read.body); rereadStatements += read.tally.statements;
      gate(`Live change · ${page.name} · re-read`, "re-reads", "count", 1);
      gate(`Live change · ${page.name} · re-read`, "bytes", "bytes", wireBytes(read.body));
      info(`Live change · ${page.name} · re-read`, "HTTP status", "count", read.status);
      gate(`Live change · ${page.name} · re-read`, "SQL statements", "count", read.tally.statements);
      gate(`Live change · ${page.name} · re-read`, "projection calls", "count", projectionTotal(read.tally));
      info(`Live change · ${page.name} · re-read`, "server time", "ms", read.ms);
    }
    gate("Live change · all four pages", "full re-reads", "count", rereads);
    gate("Live change · all four pages", "re-read bytes", "bytes", rereadBytes);
    gate("Live change · all four pages", "re-read SQL statements", "count", rereadStatements);
  } finally {
    for (const stream of Object.values(streams)) stream.close();
  }
}
