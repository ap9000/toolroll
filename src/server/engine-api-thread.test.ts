/**
 * The engine API's Flexible thread roads (F3) over HTTP, with the switch mocked on (tests only, vi.mock; the build's
 * constant is false and flexible-disabled.test.ts proves every road refuses then): a thread's LiveSession window and
 * the list are its owner's only (another approver, the instance operator and a token read nothing), its facts parse as
 * the contract says, and an answer reaches the agent only as its owner's, naming the card digest they were shown. A
 * scripted agent stands in for the process: no model, no agent.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Server } from "node:http";
import { mintApiToken } from "../api-tokens.js";
import { addApprover } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "../flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn } from "../flexible-turns.js";
import { attachFlexibleAgent, startFlexibleThreadSession, type FlexibleSessions } from "../flexible-session.js";
import { liveSessionWindowSchema, liveThreadsSchema } from "../contracts/engine-api.js";
import { threadWorld, type ThreadWorld } from "../../test/flexible-thread-world.js";
import { fakePid } from "../../test/fake-pid.js";
import { standInSignIn } from "../../test/flexible-sign-in-kit.js";

vi.mock("../flexible-available.js", async original => ({ ...await original<typeof import("../flexible-available.js")>(), flexibleAvailable: () => true }));
// The console's own host, kept where the test can attach a scripted agent to it (the real opener, called as the console
// calls it); and hooks run in the middle of a read and between a decision and its send (a session ending right there).
const held = vi.hoisted(() => ({ sessions: null as unknown, duringRead: null as (() => void) | null, afterDecide: null as (() => void) | null }));
vi.mock("../flexible-session.js", async importOriginal => {
  const real = await importOriginal<typeof import("../flexible-session.js")>();
  return { ...real, openFlexibleSessions: (...args: Parameters<typeof real.openFlexibleSessions>) => {
    const opened = real.openFlexibleSessions(...args);
    if (opened.ok) held.sessions = opened.sessions;
    return opened;
  }, flexibleThreadLiveOf: (...args: Parameters<typeof real.flexibleThreadLiveOf>) => {
    const read = real.flexibleThreadLiveOf(...args);
    held.duringRead?.();
    return read;
  } };
});
vi.mock("../flexible-answers.js", async importOriginal => {
  const real = await importOriginal<typeof import("../flexible-answers.js")>();
  return { ...real, decideFlexibleAnswer: (...args: Parameters<typeof real.decideFlexibleAnswer>) => {
    const decided = real.decideFlexibleAnswer(...args);
    held.afterDecide?.();
    return decided;
  } };
});

const NOW = new Date();
const T1 = "1".padStart(32, "0"), L1 = "a1".padStart(32, "0");
let world: ThreadWorld, server: Server, base: string, readToken: string, csrf: string;
const cookies: Record<string, string> = {};
const agent = { stdout: new PassThrough(), stdin: new PassThrough(), exit: new EventEmitter(), sent: [] as string[] };
const say = (...events: unknown[]) => { for (const one of events) agent.stdout.write(`${JSON.stringify(one)}\n`); };
const settled = () => new Promise(resolve => setImmediate(resolve));

async function login(name: string, token: string): Promise<string> {
  const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
  expect(response.status).toBe(303);
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}
async function read(persona: string, path: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = persona === "token" ? { authorization: `Bearer ${readToken}` } : { cookie: cookies[persona]! };
  const response = await fetch(`${base}${path}`, { headers: { ...headers, accept: "application/json" }, redirect: "manual" });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* a refusal page */ }
  return { status: response.status, body };
}
/** A second browser session of `name`'s: its cookie, form token, and a way to end it (as signing out elsewhere does). */
async function secondSession(name: string, token: string): Promise<{ cookie: string; csrf: string; end: () => void }> {
  const before = new Set(world.store.handle.prepare("SELECT id_hash FROM web_session WHERE account = ?").all(name).map(row => String(row["id_hash"])));
  const cookie = await login(name, token);
  const hash = world.store.handle.prepare("SELECT id_hash FROM web_session WHERE account = ?").all(name).map(row => String(row["id_hash"])).find(one => !before.has(one))!;
  const page = await (await fetch(`${base}/settings/project?repo=${encodeURIComponent(world.project)}`, { headers: { cookie } })).text();
  return { cookie, csrf: /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!, end: () => { world.store.handle.prepare("DELETE FROM web_session WHERE id_hash = ?").run(hash); } };
}
const tokenOf: Record<string, string> = {};
async function answerAs(session: { cookie: string; csrf: string }, fields: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}/agents/live/thread/${T1}/answer`, { method: "POST", redirect: "manual",
    headers: { cookie: session.cookie, origin: base, "content-type": "application/x-www-form-urlencoded", "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" },
    body: new URLSearchParams({ csrf: session.csrf, ...fields }).toString() });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* a page */ }
  return { status: response.status, body };
}
async function answer(persona: string, fields: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}/agents/live/thread/${T1}/answer`, { method: "POST", redirect: "manual",
    headers: { cookie: cookies[persona]!, origin: base, "content-type": "application/x-www-form-urlencoded", "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" },
    body: new URLSearchParams({ csrf: csrfOf[persona]!, ...fields }).toString() });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* a page */ }
  return { status: response.status, body };
}
const csrfOf: Record<string, string> = {};

beforeAll(async () => {
  world = threadWorld();
  const store = world.store;
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const pat = addApprover(store, "pat", NOW, { name: "alex", token: alex.token }), ines = addApprover(store, "ines", NOW, { name: "alex", token: alex.token });
  if (!pat.ok || !ines.ok) throw new Error("accounts");
  expect(store.setAccountProjects("pat", [world.project], "alex", NOW)).toEqual({ ok: true });
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "pat", name: "terminal", secretHash: minted.hash, access: "read", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "pat" }, new Date());
  readToken = minted.token;
  const generation = (name: string) => store.accountOf(name)!.generation;
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: generation("alex"), starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  const digest = flexibleDigestOf(terms);
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  mkdirSync(join(world.state, "threads", T1), { recursive: true });
  store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
    .run(T1, world.project, world.second, `refs/toolroll/threads/${T1}/base`, join(world.state, "threads", T1), NOW.toISOString());
  // Each starter's own Claude sign-in for threads (stand-ins, never real ones): a thread's terms card names its billing.
  for (const person of ["alex", "pat", "ines"]) standInSignIn(store, world.state, person);
  server = createDecisionServer({ store, evidenceRoot: join(world.dir, "evidence"), repos: [world.project], clock: () => new Date() });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sessions = held.sessions as FlexibleSessions;
  if (sessions === null) throw new Error("the console opened no thread host");
  // pat's running turn, held by this console, and its agent live on the record.
  const made = admitFlexibleTurn(store, { thread: T1, starter: { name: "pat", generation: generation("pat") }, digest, level: "full", freshProof: false, provider: "claude", model: "claude-sonnet-4-5",
    billing: "subscription", requestKey: "m-1", holder: sessions.holder });
  if (!made.ok) throw new Error(made.message);
  if (!beginFlexibleTurn(store, { turn: made.turn, holder: sessions.holder }).ok) throw new Error("begin");
  store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, 't1', 'live', ?)`).run(L1, T1, made.turn, "f".repeat(32), sessions.holder, "9".repeat(32), fakePid(1), NOW.toISOString());
  expect(await startFlexibleThreadSession(store, sessions, { thread: T1 })).toMatchObject({ ok: true });
  agent.stdin.on("data", (chunk: Buffer) => agent.sent.push(chunk.toString("utf8")));
  expect(attachFlexibleAgent(store, sessions, { thread: T1, turn: made.turn, launch: L1, stdout: agent.stdout, stdin: agent.stdin, exited: listener => { agent.exit.once("exit", listener); } })).toEqual({ ok: true });
  say({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Running the tests first" }] } },
    { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" }, tool_use_id: "toolu-1" } });
  await settled();
  tokenOf["pat"] = pat.token;
  for (const [name, token] of [["pat", pat.token], ["ines", ines.token], ["alex", alex.token]] as const) {
    cookies[name] = await login(name, token);
    const page = await (await fetch(`${base}/settings/project?repo=${encodeURIComponent(world.project)}`, { headers: { cookie: cookies[name]! } })).text();
    csrfOf[name] = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? "";
  }
  csrf = csrfOf["pat"]!;
  expect(csrf).toMatch(/^[0-9a-f]{64}$/);
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

const THREAD = `/agents/live/thread/${T1}`;

describe("a thread's LiveSession is its owner's only", () => {
  test("the owner reads its window and facts, and finds it in their list; another approver, the instance operator and a token read nothing", async () => {
    const mine = await read("pat", `${THREAD}?file=main`);
    expect(mine.status).toBe(200);
    const window = liveSessionWindowSchema.parse(mine.body);
    expect(window).toMatchObject({ session: { kind: "thread", id: T1, task: null }, live: true, file: "main", window: { ok: true, restarted: false } });
    if (!window.window.ok || window.thread === undefined) throw new Error("window");
    expect(window.window.records).toEqual([expect.objectContaining({ k: "say", t: ["Running the tests first"] })]);
    expect(window.thread).toMatchObject({ project: "shop", level: "full", agent: { provider: "claude", model: "claude-sonnet-4-5" }, turn: { seq: 1, status: "running", costUsd: null, costBasis: null },
      questions: [{ kind: "permission", title: "Allow this command?", detail: "npm test", state: "pending", answerable: true, parts: [] }] });
    const list = liveThreadsSchema.parse((await read("pat", "/agents/live/threads")).body);
    expect(list.threads).toEqual([{ id: T1, title: `Thread ${T1.slice(0, 8)}`, project: "shop", level: "full", live: true, waiting: 1, costUsd: null, turn: "running", ended: false, stopPending: false }]);
    for (const persona of ["ines", "alex"]) {
      expect(await read(persona, `${THREAD}?file=main`), persona).toEqual({ status: 404, body: { error: "thread" } });
      expect(liveThreadsSchema.parse((await read(persona, "/agents/live/threads")).body).threads, persona).toEqual([]);
    }
    expect((await read("token", THREAD)).status).toBe(403);
    expect((await read("token", "/agents/live/threads")).status).toBe(403);
    expect((await read("pat", `/agents/live/thread/${"b".repeat(32)}`)).body).toEqual({ error: "thread" });
    expect((await read("pat", `${THREAD}?file=other`)).status).toBe(400);
  });
});

describe("an answer goes only through its owner, naming the card they were shown", () => {
  test("another person is refused; a stale card is refused; the owner's answer reaches the agent exactly once, exactly as framed", async () => {
    const shown = liveSessionWindowSchema.parse((await read("pat", THREAD)).body).thread!.questions[0]!;
    const fields = { request: shown.request, card: shown.digest, decision: "accept" };
    for (const persona of ["ines", "alex"]) expect(await answer(persona, fields), persona).toEqual({ status: 404, body: { outcome: "refused", words: "There's no such thread." } });
    expect(await answer("pat", { ...fields, card: "0".repeat(64) })).toEqual({ status: 409, body: { outcome: "refused", words: "The request changed since you saw it. Look at it again before answering. Nothing was sent." } });
    expect(await answer("pat", { request: shown.request, card: shown.digest, decision: "maybe" })).toMatchObject({ status: 400, body: { outcome: "refused" } });
    // A token can't answer at all (the road takes a browser session only).
    const byToken = await fetch(`${base}/agents/live/thread/${T1}/answer`, { method: "POST", redirect: "manual",
      headers: { authorization: `Bearer ${readToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    expect(byToken.status).toBe(403);
    expect(agent.sent).toEqual([]);
    expect(await answer("pat", fields)).toEqual({ status: 200, body: { outcome: "done", words: "Sent to the agent." } });
    expect(agent.sent.map(line => JSON.parse(line))).toEqual([{ type: "control_response", response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { command: "npm test" } } } }]);
    expect(await answer("pat", fields)).toMatchObject({ status: 409, body: { outcome: "refused" } });
    expect(agent.sent).toHaveLength(1);
    expect(liveSessionWindowSchema.parse((await read("pat", THREAD)).body).thread!.questions[0]).toMatchObject({ state: "sent", answerable: false });
  });

  test("a new thread naming terms nobody was shown is refused, and nothing is made", async () => {
    const before = world.store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread").get()!["n"];
    const response = await fetch(`${base}/agents/live/thread`, { method: "POST", redirect: "manual", headers: { cookie: cookies["pat"]!, origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, repo: world.project, message: "Fix the README", model: "claude-sonnet-4-5", terms: "0".repeat(32) }).toString() });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ outcome: "refused", words: "The terms changed since they were shown. Read them again before starting. Nothing was started." });
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread").get()!["n"]).toBe(before);
  });
});

describe("Reply over HTTP: the owner's own, proved as a start is", () => {
  const replyAs = async (persona: string, fields: Record<string, string>) => {
    const response = await fetch(`${base}/agents/live/thread/${T1}/turn`, { method: "POST", redirect: "manual",
      headers: { cookie: cookies[persona]!, origin: base, "content-type": "application/x-www-form-urlencoded", "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" },
      body: new URLSearchParams({ csrf: csrfOf[persona]!, ...fields }).toString() });
    return { status: response.status, body: await response.json() as unknown };
  };
  test("someone else, a token, no password on a team install and a malformed key are refused; a reply while a turn works takes no second turn", async () => {
    const turnsBefore = world.store.handle.prepare("SELECT COUNT(*) AS n FROM thread_turn WHERE thread = ?").get(T1)!["n"];
    const fields = { message: "Now add a test", key: "d".repeat(32) };
    for (const persona of ["ines", "alex"]) expect(await replyAs(persona, fields), persona).toEqual({ status: 404, body: { outcome: "refused", words: "There's no such thread." } });
    const byToken = await fetch(`${base}/agents/live/thread/${T1}/turn`, { method: "POST", redirect: "manual",
      headers: { authorization: `Bearer ${readToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    expect(byToken.status).toBe(403);
    expect(await replyAs("pat", fields)).toEqual({ status: 403, body: { outcome: "refused", words: "Replying here needs your password. Nothing was sent." } });
    expect(await replyAs("pat", { ...fields, key: "nope", password: tokenOf["pat"]! })).toMatchObject({ status: 400, body: { outcome: "refused" } });
    expect(await replyAs("pat", { ...fields, password: tokenOf["pat"]! })).toEqual({ status: 409, body: { outcome: "refused", words: "This thread is already working on a turn. Wait for it to finish, or stop it." } });
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM thread_turn WHERE thread = ?").get(T1)!["n"]).toBe(turnsBefore);
    expect(agent.sent.filter(line => line.includes("Now add a test"))).toEqual([]);
  });
});

describe("the owner's read waits for the thread's next change (wait=1), never polled", () => {
  test("an unchanged read waits; the agent's next words wake it at once with them; a read that isn't held to a version and cursor can't wait", async () => {
    const first = await read("pat", THREAD);
    const window = first.body as { window: { cursor: string }; thread: { version: string } };
    const path = `${THREAD}?file=main&cursor=${encodeURIComponent(window.window.cursor)}&known=${window.thread.version}&wait=1`;
    const started = Date.now();
    const waiting = read("pat", path);
    let answered = false;
    void waiting.then(() => { answered = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(answered).toBe(false);
    say({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Tests pass; writing the summary" }] } });
    const woke = await waiting;
    expect(woke.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    const parsed = liveSessionWindowSchema.parse(woke.body);
    expect(parsed.window.ok && parsed.window.records.length).toBeGreaterThan(0);
    for (const bad of [`${THREAD}?file=main&wait=1`, `${THREAD}?file=main&known=${window.thread.version}&wait=1`, `${THREAD}?file=main&cursor=x&known=${window.thread.version}&wait=2`,
      `${THREAD}?file=main&cursor=x&known=${window.thread.version}&wait=1&wait=1`]) expect((await read("pat", bad)).status, bad).toBe(400);
    // Someone else's thread never waits: refused before anything is read.
    expect((await read("ines", path)).status).toBe(404);
  });
});

describe("a session that ends is refused at admission, during the read, and between the decision and the send", () => {
  const settledAgent = () => new Promise(resolve => setImmediate(resolve));
  test("ended before: the read and an answer are refused; ended during the read: nothing read is sent", async () => {
    const before = await secondSession("pat", tokenOf["pat"]!);
    before.end();
    const read = await fetch(`${base}${THREAD}`, { headers: { cookie: before.cookie, accept: "application/json" }, redirect: "manual" });
    expect(read.status).not.toBe(200);
    const sentBefore = agent.sent.length;
    const refused = await answerAs(before, { request: "d".repeat(32), card: "1".repeat(64), decision: "accept" });
    expect(refused.status === 303 || refused.status === 401 || refused.status === 403, `${refused.status}`).toBe(true);
    expect(agent.sent.length).toBe(sentBefore);
    const during = await secondSession("pat", tokenOf["pat"]!);
    held.duringRead = during.end;
    try {
      const answered = await fetch(`${base}${THREAD}`, { headers: { cookie: during.cookie, accept: "application/json" }, redirect: "manual" });
      expect(answered.status).toBe(404);
      expect(await answered.json()).toEqual({ error: "thread" });
    } finally { held.duringRead = null; }
  });

  test("ended between the decision and the send: F2d's final attempt refuses it, and the agent gets nothing", async () => {
    say({ type: "control_request", request_id: "r9", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm run build" }, tool_use_id: "toolu-9" } });
    await settledAgent();
    const session = await secondSession("pat", tokenOf["pat"]!);
    const shown = liveSessionWindowSchema.parse((await read("pat", THREAD)).body).thread!.questions.find(one => one.state === "pending")!;
    const sentBefore = agent.sent.length;
    held.afterDecide = session.end;
    try {
      const answered = await answerAs(session, { request: shown.request, card: shown.digest, decision: "accept" });
      expect(answered).toEqual({ status: 409, body: { outcome: "refused", words: "You can no longer answer for this thread (its Flexible terms or your access changed). Nothing was sent." } });
    } finally { held.afterDecide = null; }
    expect(agent.sent.length).toBe(sentBefore);
    expect(liveSessionWindowSchema.parse((await read("pat", THREAD)).body).thread!.questions.find(one => one.request === shown.request)).toMatchObject({ state: "not-sent" });
  });
});

describe("the send compares the whole saved session (Codex round 2)", () => {
  const settledAgent = () => new Promise(resolve => setImmediate(resolve));
  let n = 20;
  async function pending(): Promise<{ request: string; digest: string }> {
    n++;
    say({ type: "control_request", request_id: `s${n}`, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: `echo ${n}` }, tool_use_id: `toolu-s${n}` } });
    await settledAgent();
    return liveSessionWindowSchema.parse((await read("pat", THREAD)).body).thread!.questions.find(one => one.state === "pending" && one.detail === `echo ${n}`)!;
  }
  const hashOf = (cookie: string) => world.store.handle.prepare("SELECT id_hash FROM web_session WHERE account = 'pat' ORDER BY created_at DESC LIMIT 1").get()!["id_hash"] as string;
  test.each([
    ["expired by its lifetime but not deleted", (hash: string) => world.store.handle.prepare("UPDATE web_session SET last_seen = ? WHERE id_hash = ?").run(Date.now() - 13 * 3_600_000, hash)],
    ["the same row now another account's", (hash: string) => world.store.handle.prepare("UPDATE web_session SET account = 'ines' WHERE id_hash = ?").run(hash)],
    ["another generation", (hash: string) => world.store.handle.prepare("UPDATE web_session SET generation = generation + 1 WHERE id_hash = ?").run(hash)],
  ])("refused when, between the decision and the send, the saved session is %s", async (_name, change) => {
    const session = await secondSession("pat", tokenOf["pat"]!);
    const hash = hashOf(session.cookie);
    const shown = await pending();
    const sentBefore = agent.sent.length;
    held.afterDecide = () => { change(hash); };
    try {
      expect(await answerAs(session, { request: shown.request, card: shown.digest, decision: "accept" })).toMatchObject({ status: 409, body: { outcome: "refused" } });
    } finally { held.afterDecide = null; session.end(); }
    expect(agent.sent.length).toBe(sentBefore);
  });
});
