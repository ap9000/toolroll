/**
 * Wire budgets for the Flexible thread roads (F3; `npm run test:perf:wire`, docs/TESTING.md "Wire budgets"): what a
 * terminal client's thread reads cost, held to committed ceilings (thread-wire-ceilings.json) like the engine API's own
 * reads in wire.wire.test.ts. The constant is mocked on here only (vi.mock; the default is off): a thread with a long
 * transcript and a few questions, read cold (every record and its facts), polled unchanged (no records, facts left out
 * as `known`), listed, and held as a long poll (`wait=1`) woken by the agent's next words (pre-enable push: the
 * terminal waits instead of polling every 250 ms). Bytes and SQL statements are gated; server time is gated at the
 * engine's 300 ms bar (the better of two reads; a held read's time is its wait, so it isn't timed). WIRE_WRITE_CEILINGS=1 rewrites the ceilings from this run, on purpose.
 */
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import { installSqlCounter, newTally, tallyRequests, type Tally } from "./wire-probe.js";
import { threadWorld, type ThreadWorld } from "../flexible-thread-world.js";
import { fakePid } from "../fake-pid.js";
import { addApprover } from "../../src/scope.js";
import { createDecisionServer, type DecisionServer } from "../../src/serve.js";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "../../src/flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn } from "../../src/flexible-turns.js";
import { attachFlexibleAgent, startFlexibleThreadSession, type FlexibleSessions } from "../../src/flexible-session.js";

vi.mock("../../src/flexible-available.js", async original => ({ ...await original<typeof import("../../src/flexible-available.js")>(), flexibleAvailable: () => true }));
const held = vi.hoisted(() => ({ sessions: null as unknown }));
vi.mock("../../src/flexible-session.js", async importOriginal => {
  const real = await importOriginal<typeof import("../../src/flexible-session.js")>();
  return { ...real, openFlexibleSessions: (...args: Parameters<typeof real.openFlexibleSessions>) => {
    const opened = real.openFlexibleSessions(...args);
    if (opened.ok) held.sessions = opened.sessions;
    return opened;
  } };
});

const CEILINGS_FILE = join(import.meta.dirname, "thread-wire-ceilings.json");
const SERVER_MS = 300;
const T1 = "1".padStart(32, "0"), L1 = "a1".padStart(32, "0");
let world: ThreadWorld, server: DecisionServer, port: number, cookie: string, probe: ReturnType<typeof tallyRequests>;
/** The scripted agent's stdout: a woken read's change is one more line said on it. */
let agentOut: PassThrough;

function send(path: string): Promise<{ status: number; body: string; tally: Tally; ms: number }> {
  const tally = newTally();
  probe.expect(tally);
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, cookie, accept: "application/json", connection: "close" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("end", () => setImmediate(() => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8"), tally, ms: performance.now() - started })));
    });
    request.on("error", reject);
    request.end();
  });
}

beforeAll(async () => {
  installSqlCounter();
  world = threadWorld();
  const store = world.store;
  const pat = addApprover(store, "pat", new Date());
  if (!pat.ok) throw new Error("pat");
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "pat", signerGeneration: store.accountOf("pat")!.generation, starters: "approvers-with-access", passwordFreeUpTo: "full",
    max: "full", default: "full", network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  const digest = flexibleDigestOf(terms), at = new Date().toISOString();
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'pat', ?, 'password-now', 'pat', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, at, at);
  mkdirSync(join(world.state, "threads", T1), { recursive: true });
  store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
    .run(T1, world.project, world.second, `refs/toolroll/threads/${T1}/base`, join(world.state, "threads", T1), at);
  server = createDecisionServer({ store, evidenceRoot: join(world.dir, "evidence"), repos: [world.project], clock: () => new Date() });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  probe = tallyRequests(server);
  const sessions = held.sessions as FlexibleSessions;
  const made = admitFlexibleTurn(store, { thread: T1, starter: { name: "pat", generation: store.accountOf("pat")!.generation }, digest, level: "full", freshProof: false, provider: "claude",
    model: "claude-sonnet-4-5", billing: "subscription", requestKey: "m-1", holder: sessions.holder });
  if (!made.ok || !beginFlexibleTurn(store, { turn: made.turn, holder: sessions.holder }).ok) throw new Error("turn");
  store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, 't1', 'live', ?)`).run(L1, T1, made.turn, "f".repeat(32), sessions.holder, "9".repeat(32), fakePid(1), at);
  await startFlexibleThreadSession(store, sessions, { thread: T1 });
  const stdout = new PassThrough(), exit = new EventEmitter();
  agentOut = stdout;
  attachFlexibleAgent(store, sessions, { thread: T1, turn: made.turn, launch: L1, stdout, stdin: new PassThrough(), exited: listener => { exit.once("exit", listener); } });
  // A long turn: 400 records (said, read, edited, ran), and three requests.
  for (let n = 0; n < 100; n++) {
    stdout.write(`${JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: `Step ${n}: checking the totals and the tax rounding.` },
      { type: "tool_use", id: `t-${n}`, name: n % 2 === 0 ? "Read" : "Edit", input: { file_path: `${world.project}/src/total-${n}.ts` } }] } })}\n`);
    stdout.write(`${JSON.stringify({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: `t-${n}`, content: "ok" }] } })}\n`);
  }
  for (let n = 0; n < 3; n++) {
    stdout.write(`${JSON.stringify({ type: "control_request", request_id: `r${n}`, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: `npm test -- --shard ${n}/3\nnpm run lint` }, tool_use_id: `u-${n}` } })}\n`);
  }
  await new Promise(resolve => setImmediate(resolve));
  const login = await fetch(`http://127.0.0.1:${port}/login`, { method: "POST", body: new URLSearchParams({ name: "pat", token: pat.token }), redirect: "manual" });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 120_000);
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

test("the thread roads stay within their wire budgets", async () => {
  const rows: { id: string; observed: number }[] = [];
  const slow: string[] = [];
  const cold = await send(`/agents/live/thread/${T1}?file=main`);
  expect(cold.status).toBe(200);
  const read = JSON.parse(cold.body) as { window: { cursor: string }; thread: { version: string; questions: unknown[] } };
  expect(read.thread.questions).toHaveLength(3);
  const reads: [string, string][] = [
    ["thread window, cold", `/agents/live/thread/${T1}?file=main`],
    ["thread window, unchanged poll", `/agents/live/thread/${T1}?file=main&cursor=${encodeURIComponent(read.window.cursor)}&known=${read.thread.version}`],
    ["thread list", "/agents/live/threads"],
  ];
  for (const [name, path] of reads) {
    const first = await send(path), again = await send(path);
    expect(first.status, name).toBe(200);
    if (name.includes("unchanged")) expect(JSON.parse(first.body)).not.toHaveProperty("thread");
    rows.push({ id: `owner · Engine · ${name} | bytes`, observed: Buffer.byteLength(first.body) }, { id: `owner · Engine · ${name} | SQL statements`, observed: first.tally.statements });
    const best = Math.min(first.ms, again.ms);
    if (best > SERVER_MS) slow.push(`${name}: ${Math.round(best)} ms (bar ${SERVER_MS} ms)`);
  }
  // A held read woken by the agent's next words: what the wake costs (its first read, the wait, its read again).
  {
    const fresh = await send(`/agents/live/thread/${T1}?file=main`);
    const at = JSON.parse(fresh.body) as { window: { cursor: string }; thread: { version: string } };
    const held = send(`/agents/live/thread/${T1}?file=main&cursor=${encodeURIComponent(at.window.cursor)}&known=${at.thread.version}&wait=1`);
    await new Promise(resolve => setTimeout(resolve, 100));
    agentOut.write(`${JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Totals checked; the rounding fix is in." }] } })}\n`);
    const woke = await held;
    expect(woke.status).toBe(200);
    expect(woke.ms).toBeLessThan(5_000);
    rows.push({ id: "owner · Engine · thread window, woken long poll | bytes", observed: Buffer.byteLength(woke.body) }, { id: "owner · Engine · thread window, woken long poll | SQL statements", observed: woke.tally.statements });
  }
  const margin = (row: { id: string; observed: number }) => row.observed + (row.id.endsWith("bytes") ? Math.max(512, Math.ceil(row.observed * 0.05)) : Math.max(2, Math.ceil(row.observed * 0.1)));
  if (process.env["WIRE_WRITE_CEILINGS"] === "1") {
    writeFileSync(CEILINGS_FILE, `${JSON.stringify({ schemaVersion: 1, note: "Wire budget ceilings for the Flexible thread roads (test/perf/thread.wire.test.ts). Raise one only on purpose.",
      ceilings: Object.fromEntries(rows.map(row => [row.id, margin(row)])) }, null, 2)}\n`);
  }
  const ceilings = existsSync(CEILINGS_FILE) ? (JSON.parse(readFileSync(CEILINGS_FILE, "utf8")) as { ceilings: Record<string, number> }).ceilings : {};
  console.log(rows.map(row => `${row.id}: ${row.observed} (ceiling ${ceilings[row.id] ?? "none"})`).join("\n"));
  expect(rows.filter(row => typeof ceilings[row.id] !== "number" || row.observed > ceilings[row.id]!).map(row => `${row.id}: ${row.observed} over ${ceilings[row.id]}`)).toEqual([]);
  expect(slow).toEqual([]);
}, 120_000);
