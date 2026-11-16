/**
 * Flexible threads, slice F3 (flexible-session.ts): the wiring F2b–F2d left open, each hook proved with the constant
 * mocked on (the relay's upstream seam's pattern; no runtime knob): the catalog opened through F2d's own opener; the
 * relay's lifetime per thread; a scripted agent's stdout read into records, requests and turn ends, its stdin the answer
 * connection (closed after an uncertain send); answers revoked at a turn's end, the agent's exit and the thread's
 * lowering; recovered at holder recovery (only a holder proved gone); expired on the tick. And the owner's read: its
 * records window, cursor and questions, nobody else's. Scripted connections only: no agent process, no model.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, flexibleTurn } from "./flexible-turns.js";
import { FLEXIBLE_ANSWER_ACK_MS } from "./flexible-answers.js";
import {
  admitFlexibleThreadOwner, answerFlexibleRequest, attachFlexibleAgent, endFlexibleThreadTurn, flexibleThreadLiveOf, flexibleThreadsOf, lowerFlexibleThreadSession, openFlexibleSessions,
  recoverFlexibleHolders, startFlexibleThread, startFlexibleThreadSession, stopFlexibleThreadSession, tickFlexibleSessions, FLEXIBLE_SCOPE_LINES,
  flexibleThreadChangeOf, waitFlexibleThreadChange, FLEXIBLE_WAITERS_MAX, FLEXIBLE_WAIT_MS,
  type FlexibleSessions,
} from "./flexible-session.js";
import { withFlexibleThreadLock } from "./flexible-thread.js";
import { startIdentityOf } from "./flexible-custody.js";
import { defaultCustodyIO } from "./flexible-launch.js";
import { spawn, type ChildProcess } from "node:child_process";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";
import { fakePid } from "../test/fake-pid.js";

vi.mock("./flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));

const NOW = new Date("2026-11-15T10:00:00.000Z");
const at = (ms: number) => () => new Date(NOW.getTime() + ms);
const tid = (k: number) => k.toString(16).padStart(32, "0");
const T1 = tid(1), L1 = tid(0xa1);
let world: ThreadWorld, sessions: FlexibleSessions, digest: string, turn: string, raw: DatabaseSync;
let keys = 0;
const gen = (name: string) => world.store.accountOf(name)!.generation;

beforeEach(() => {
  world = threadWorld();
  const store = world.store;
  store.saveApprover("alex", "hash-a", NOW);
  store.saveApprover("pat", "hash-p", NOW);
  expect(store.setAccountProjects("pat", [world.project], "alex", NOW)).toEqual({ ok: true });
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: gen("alex"), starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  digest = flexibleDigestOf(terms);
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  const folder = join(world.state, "threads", T1);
  mkdirSync(folder, { recursive: true });
  store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
    .run(T1, world.project, world.second, `refs/toolroll/threads/${T1}/base`, folder, NOW.toISOString());
  const opened = openFlexibleSessions(store);
  if (!opened.ok) throw new Error(opened.message);
  sessions = opened.sessions;
  turn = running();
  launch(L1);
  raw = new DatabaseSync(`${world.databaseFile}.coding.sqlite`);
});
afterEach(async () => {
  for (const one of sessions.threads.values()) await one.relay?.close();
  raw.close();
  sessions.catalog.close();
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

/** pat's turn on T1, admitted and running, held by this host. */
function running(holder = sessions.holder): string {
  const made = admitFlexibleTurn(world.store, { thread: T1, starter: { name: "pat", generation: gen("pat") }, digest, level: "full", freshProof: false, provider: "claude",
    model: "claude-sonnet-4-5", billing: "subscription", requestKey: `m-${++keys}`, holder, clock: () => NOW });
  if (!made.ok) throw new Error(made.message);
  const begun = beginFlexibleTurn(world.store, { turn: made.turn, holder, clock: () => NOW });
  if (!begun.ok) throw new Error(begun.message);
  return made.turn;
}
/** A live agent launch of T1 on the record, held by `holder` (a process that isn't real leads it). */
function launch(id: string, holder = sessions.holder, offset = 1): void {
  world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, 't1', 'live', ?)`).run(id, T1, turn, "f".repeat(32), holder, "9".repeat(32), fakePid(offset), NOW.toISOString());
}

/** A scripted agent: what it says on stdout, what it was sent on stdin, and its exit. */
function scripted(stdin: Writable = new PassThrough()) {
  const stdout = new PassThrough(), exit = new EventEmitter();
  const sent: string[] = [];
  if (stdin instanceof PassThrough) stdin.on("data", (chunk: Buffer) => sent.push(chunk.toString("utf8")));
  const say = (...events: unknown[]) => { for (const one of events) stdout.write(`${JSON.stringify(one)}\n`); };
  return { stdout, stdin, sent, exit, say, exited: (listener: () => void) => { exit.once("exit", listener); } };
}
async function attached(clock = () => NOW) {
  const started = await startFlexibleThreadSession(world.store, sessions, { thread: T1 });
  expect(started).toMatchObject({ ok: true });
  const agent = scripted();
  expect(attachFlexibleAgent(world.store, sessions, { thread: T1, turn, launch: L1, stdout: agent.stdout, stdin: agent.stdin, exited: agent.exited, clock })).toEqual({ ok: true });
  return agent;
}
const settled = () => new Promise(resolve => setImmediate(resolve));
const bash = (id: string, command = "npm test") => ({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command }, tool_use_id: `toolu-${id}` } });
const ask = (id: string, question: string, options: string[]) => ({ type: "control_request", request_id: id,
  request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question, header: "Pick", options: options.map(label => ({ label })), multiSelect: false }] } } });
const read = (cursor: string | null = null, viewer = "pat") => {
  const got = flexibleThreadLiveOf(world.store, sessions, { thread: T1, viewer: { name: viewer }, file: "main", cursor });
  if (!got.ok) throw new Error(got.message);
  return got;
};
const pat = () => ({ kind: "person" as const, name: "pat", generation: gen("pat") });
/** The whole request's digest, computed here independently: canonical JSON (keys sorted at every level) of the tool and its input. */
function flexibleInputDigest(tool: string, input: Record<string, unknown>): string {
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : typeof value === "object" && value !== null ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value);
  return createHash("sha256").update(canonical({ tool, input })).digest("hex");
}
const states = () => raw.prepare("SELECT request_ref, state FROM thread_request ORDER BY created_at, request_ref").all().map(row => [row["request_ref"], row["state"]]);

describe("the host: the catalog through F2d's opener, a holder named by this process", () => {
  test("openFlexibleSessions opens <database>.coding.sqlite beside the store, and names this console by pid and start identity", () => {
    expect(existsSync(`${world.databaseFile}.coding.sqlite`)).toBe(true);
    expect(sessions.holder).toMatch(new RegExp(`^console:${process.pid}:[0-9a-f]{16}$`));
  });
});

describe("the relay's lifetime per thread", () => {
  test("a thread's session starts its relay once; stopping the session closes it and revokes every answer still open", async () => {
    const first = await startFlexibleThreadSession(world.store, sessions, { thread: T1 });
    if (!first.ok) throw new Error(first.message);
    expect(await startFlexibleThreadSession(world.store, sessions, { thread: T1 })).toEqual({ ok: true, relayPort: first.relayPort });
    const listening = await fetch(`http://127.0.0.1:${first.relayPort}/v1/messages`, { method: "POST" }).then(answer => answer.status, () => null);
    expect(listening).not.toBeNull();
    const agent = scripted();
    attachFlexibleAgent(world.store, sessions, { thread: T1, turn, launch: L1, stdout: agent.stdout, stdin: agent.stdin, exited: agent.exited, clock: () => NOW });
    agent.say(bash("r1"));
    await settled();
    expect(states()).toEqual([["r1", "pending"]]);
    const stopped = await stopFlexibleThreadSession(world.store, sessions, { thread: T1, reason: "the person stopped it", clock: () => NOW });
    expect(stopped).toMatchObject({ ok: true });
    expect(states()).toEqual([["r1", "withdrawn"]]);
    expect(sessions.threads.has(T1)).toBe(false);
    expect(await fetch(`http://127.0.0.1:${first.relayPort}/v1/messages`, { method: "POST" }).then(() => "answered", () => "closed")).toBe("closed");
    expect(agent.stdin.writableEnded).toBe(true);
  });
});

describe("the agent's stdout and stdin", () => {
  test("its events become the owner's live records; the cursor reads on; a forged one restarts; a helpers' file is missing", async () => {
    const agent = await attached();
    agent.say({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Looking at the failing test" }] } });
    await settled();
    const first = read();
    expect(first.live).toBe(true);
    if (!first.window.ok) throw new Error("window");
    expect(first.window.records).toEqual([{ k: "say", at: NOW.toISOString(), t: ["Looking at the failing test"] }]);
    expect(first.window).toMatchObject({ restarted: false, earlier: false, more: false });
    agent.say({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Fixed it" }] } });
    await settled();
    const next = read(first.window.cursor);
    expect(next.window).toMatchObject({ ok: true, records: [{ k: "say", t: ["Fixed it"] }], restarted: false });
    expect(read("forged").window).toMatchObject({ ok: true, restarted: true, records: [{ t: ["Looking at the failing test"] }, { t: ["Fixed it"] }] });
    expect(flexibleThreadLiveOf(world.store, sessions, { thread: T1, viewer: { name: "pat" }, file: "sub", cursor: null })).toMatchObject({ ok: true, window: { ok: false, reason: "missing" } });
  });

  test("a request is recorded with its card cleaned (the card shown is the card digested); its answer is exactly the framed choice on stdin", async () => {
    const agent = await attached();
    agent.say(ask("q1", "Which database\u001b[31m should‮ it use?\u0007", ["SQLite", "Postgres"]));
    await settled();
    const question = read().facts.questions[0]!;
    expect(question).toMatchObject({ kind: "question", title: "The agent asks you", state: "pending", answerable: true, parts: [{ id: "1", options: ["SQLite", "Postgres"] }] });
    expect(question.parts[0]!.question).not.toMatch(/[\u0000-\u001f‮]/);
    const asked = ask("q1", "Which database\u001b[31m should\u202e it use?\u0007", ["SQLite", "Postgres"]).request.input;
    // Bound to the tool and the whole input; the question's words were cleaned, so the card says it isn't the whole.
    const card = JSON.stringify({ title: question.title, tool: "AskUserQuestion", input: flexibleInputDigest("AskUserQuestion", asked), complete: false,
      questions: [{ id: "1", question: question.parts[0]!.question, options: [{ label: "SQLite" }, { label: "Postgres" }] }] });
    expect(question.digest).toBe(createHash("sha256").update(card).digest("hex"));
    const done = await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: question.request, shownDigest: question.digest, by: pat(), choice: { question: "1", answer: "Postgres" }, clock: () => NOW });
    expect(done).toEqual({ ok: true, state: "sent" });
    expect(agent.sent.map(line => JSON.parse(line))).toEqual([{ type: "control_response", response: { subtype: "success", request_id: "q1",
      response: { behavior: "allow", updatedInput: { questions: [{ question: "Which database\u001b[31m should‮ it use?\u0007", header: "Pick", options: [{ label: "SQLite" }, { label: "Postgres" }], multiSelect: false }],
        answers: { "Which database\u001b[31m should‮ it use?\u0007": "Postgres" } } } } }]);
    expect(read().facts.questions[0]).toMatchObject({ state: "sent", answerable: false });
    // Its next tool activity carrying the request's id is not an ack here (a question has none); a permission's is.
    agent.say(bash("r2"));
    await settled();
    const permission = read().facts.questions.find(one => one.kind === "permission")!;
    expect(permission).toMatchObject({ title: "Allow this command?", detail: "npm test" });
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: permission.request, shownDigest: permission.digest, by: pat(), choice: { decision: "decline" }, clock: () => NOW })).toEqual({ ok: true, state: "sent" });
    expect(JSON.parse(agent.sent[1]!)).toEqual({ type: "control_response", response: { subtype: "success", request_id: "r2", response: { behavior: "deny", message: "The person declined this." } } });
    agent.say({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu-r2", content: "denied" }] } });
    await settled();
    expect(states()).toEqual([["q1", "sent"], ["r2", "delivered"]]);
  });

  test("a stale card (another digest), another person, or a second answer is refused, and nothing reaches stdin", async () => {
    const agent = await attached();
    agent.say(bash("r1"));
    await settled();
    const shown = read().facts.questions[0]!;
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: shown.request, shownDigest: "0".repeat(64), by: pat(), choice: { decision: "accept" }, clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "card-changed" });
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: shown.request, shownDigest: shown.digest, by: { kind: "person", name: "alex", generation: gen("alex") }, choice: { decision: "accept" }, clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "not-owner" });
    // The owner at another generation (their account changed since), and something that isn't a person, are refused too.
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: shown.request, shownDigest: shown.digest, by: { kind: "person", name: "pat", generation: gen("pat") + 1 }, choice: { decision: "accept" }, clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "not-owner" });
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: shown.request, shownDigest: shown.digest, by: { kind: "agent", name: "pat", generation: gen("pat") } as never, choice: { decision: "accept" }, clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "not-owner" });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM thread_request WHERE decision_id IS NOT NULL").get()!["n"]).toBe(0);
    expect(agent.sent).toEqual([]);
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: shown.request, shownDigest: shown.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW })).toEqual({ ok: true, state: "sent" });
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: shown.request, shownDigest: shown.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "already-answered" });
    expect(agent.sent).toHaveLength(1);
    // A request this host never recorded (another console's, or before a restart) can't be answered from here.
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: tid(0xee), shownDigest: shown.digest, by: pat(), choice: { decision: "accept" } })).toMatchObject({ ok: false, reason: "not-answerable" });
  });

  test("a send that misses its deadline is uncertain, and the agent's stdin is closed after it", async () => {
    await startFlexibleThreadSession(world.store, sessions, { thread: T1 });
    // A stdin that takes the bytes and never says they were flushed.
    const stuck = new Writable({ write: (_chunk, _encoding, _done) => { /* never calls back */ } });
    const agent = scripted(stuck);
    attachFlexibleAgent(world.store, sessions, { thread: T1, turn, launch: L1, stdout: agent.stdout, stdin: stuck, exited: agent.exited, clock: () => NOW });
    agent.say(bash("r1"));
    await settled();
    const shown = read().facts.questions[0]!;
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: shown.request, shownDigest: shown.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW, writeMs: 20 }))
      .toMatchObject({ ok: false, reason: "uncertain" });
    expect(stuck.destroyed).toBe(true);
    expect(states()).toEqual([["r1", "uncertain"]]);
  });
});

describe("revoking: a turn's end, the agent's exit, the thread's lowering", () => {
  test("the turn's result ends the turn and withdraws its open requests", async () => {
    const agent = await attached();
    agent.say(bash("r1"), { type: "result", subtype: "success", parent_tool_use_id: null });
    await settled();
    expect(flexibleTurn(world.store, turn)!.status).toBe("finished");
    expect(states()).toEqual([["r1", "withdrawn"]]);
    expect(read().facts.questions[0]).toMatchObject({ state: "withdrawn", answerable: false });
    // Called again (another reader saw the same end): nothing more moves, and it says so without failing.
    expect(endFlexibleThreadTurn(world.store, sessions, { thread: T1, turn, outcome: "finished" })).toMatchObject({ ok: true, withdrawn: 0 });
  });

  test("the agent's exit withdraws what it asked; the session forgets it", async () => {
    const agent = await attached();
    agent.say(bash("r1"));
    await settled();
    agent.exit.emit("exit");
    expect(states()).toEqual([["r1", "withdrawn"]]);
    expect(read().live).toBe(false);
  });

  test("lowering the thread (its owner) revokes every open request of it", async () => {
    const agent = await attached();
    agent.say(bash("r1"));
    await settled();
    expect(await lowerFlexibleThreadSession(world.store, sessions, { thread: T1, by: { name: "alex", generation: gen("alex") }, level: "full", clock: () => NOW })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(states()).toEqual([["r1", "pending"]]);
    const lowered = await lowerFlexibleThreadSession(world.store, sessions, { thread: T1, by: { name: "pat", generation: gen("pat") }, level: "full", clock: () => NOW });
    expect(lowered).toMatchObject({ ok: true, level: "full" });
    expect(states()).toEqual([["r1", "withdrawn"]]);
  });
});

describe("holder recovery and the tick", () => {
  test("a holder proved gone has its launches settled and its answers recovered; a live or foreign holder is left alone", async () => {
    // A console that crashed (its pid is no real process), one that is this very process, and a holder named some other way.
    const gone = `console:${fakePid(7)}:${"0".repeat(16)}`, T2 = tid(2), L2 = tid(0xa2);
    world.store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
      .run(T2, world.project, world.second, `refs/toolroll/threads/${T2}/base`, join(world.state, "threads", T2), NOW.toISOString());
    mkdirSync(join(world.state, "threads", T2), { recursive: true });
    const made = admitFlexibleTurn(world.store, { thread: T2, starter: { name: "pat", generation: gen("pat") }, digest, level: "full", freshProof: false, provider: "claude",
      model: "claude-sonnet-4-5", billing: "subscription", requestKey: "m-gone", holder: gone, clock: () => NOW });
    if (!made.ok) throw new Error(made.message);
    expect(beginFlexibleTurn(world.store, { turn: made.turn, holder: gone, clock: () => NOW })).toMatchObject({ ok: true });
    world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
      VALUES (?, ?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, 't1', 'live', ?)`).run(L2, T2, made.turn, "f".repeat(32), gone, "9".repeat(32), fakePid(7), NOW.toISOString());
    raw.exec(`INSERT INTO thread_request (id, thread, turn, connection_id, holder, owner, owner_generation, request_ref, kind, card, request_digest, token_digest, state, created_at)
      VALUES ('${tid(0xb1)}', '${T2}', '${made.turn}', '${L2}', '${gone}', 'pat', ${gen("pat")}, 'r-gone', 'permission', '{"title":"Allow?"}', '${"1".repeat(64)}', '${"2".repeat(64)}', 'pending', '${NOW.toISOString()}')`);
    // A holder named another way ("h1": not a console this host can prove gone) with a turn admitted on a third thread.
    const T3 = tid(3);
    world.store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
      .run(T3, world.project, world.second, `refs/toolroll/threads/${T3}/base`, join(world.state, "threads", T3), NOW.toISOString());
    const other = admitFlexibleTurn(world.store, { thread: T3, starter: { name: "pat", generation: gen("pat") }, digest, level: "full", freshProof: false, provider: "claude",
      model: "claude-sonnet-4-5", billing: "subscription", requestKey: "m-h1", holder: "h1", clock: () => NOW });
    if (!other.ok) throw new Error(other.message);
    const foreign = other.turn;
    const recovered = await recoverFlexibleHolders(world.store, sessions, { clock: () => NOW });
    expect(recovered).toEqual({ ok: true, recovered: [gone], unresolved: [], unknown: [] });
    expect(states()).toEqual([["r-gone", "withdrawn"]]);
    expect(world.store.handle.prepare("SELECT state FROM flexible_thread_launch WHERE id = ?").get(L2)!["state"]).toBe("exited");
    expect(flexibleTurn(world.store, made.turn)!.status).toBe("interrupted");
    // This host's own launch and turn, and the foreign holder's turn, are untouched.
    expect(world.store.handle.prepare("SELECT state FROM flexible_thread_launch WHERE id = ?").get(L1)!["state"]).toBe("live");
    expect(flexibleTurn(world.store, turn)!.status).toBe("running");
    expect(flexibleTurn(world.store, foreign)!.status).toBe("admitted");
  });

  test("the tick settles a sent answer its agent never acknowledged", async () => {
    const agent = await attached();
    agent.say(bash("r1"));
    await settled();
    const shown = read().facts.questions[0]!;
    await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: shown.request, shownDigest: shown.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW });
    expect(tickFlexibleSessions(world.store, sessions, { clock: at(1_000) })).toEqual({ ok: true, uncertain: 0 });
    expect(tickFlexibleSessions(world.store, sessions, { clock: at(FLEXIBLE_ANSWER_ACK_MS + 1) })).toEqual({ ok: true, uncertain: 1 });
    expect(states()).toEqual([["r1", "uncertain"]]);
  });
});

describe("the owner's read", () => {
  test("only the thread's creator reads it or its list; another approver with the project, and a project they lost, read nothing", async () => {
    const agent = await attached();
    agent.say(bash("r1"));
    await settled();
    expect(flexibleThreadLiveOf(world.store, sessions, { thread: T1, viewer: { name: "alex" }, file: "main", cursor: null })).toMatchObject({ ok: false, reason: "thread-unknown" });
    expect(admitFlexibleThreadOwner(world.store, sessions, { thread: T1, viewer: { name: "alex" }, canAccess: () => true })).toMatchObject({ ok: false, reason: "thread-unknown" });
    expect(admitFlexibleThreadOwner(world.store, sessions, { thread: T1, viewer: { name: "pat" }, canAccess: () => false })).toMatchObject({ ok: false, reason: "thread-unknown" });
    expect(admitFlexibleThreadOwner(world.store, sessions, { thread: T1, viewer: { name: "pat" }, canAccess: () => true })).toEqual({ ok: true, repo: world.project });
    expect(flexibleThreadsOf(world.store, sessions, { owner: "alex" })).toEqual({ ok: true, threads: [] });
    const mine = flexibleThreadsOf(world.store, sessions, { owner: "pat" });
    expect(mine).toMatchObject({ ok: true, threads: [{ id: T1, project: "shop", level: "full", live: true, waiting: 1, agent: { provider: "claude", model: "claude-sonnet-4-5" }, turn: { seq: 1, status: "running" } }] });
  });

  test("a new thread is refused before anything is made when this console has no launcher for its network", async () => {
    const before = world.store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread").get()!["n"];
    expect(await startFlexibleThread(world.store, sessions, { repo: world.project, by: { name: "pat", generation: gen("pat") }, digest, message: "Fix the README", model: "claude-sonnet-4-5", launcher: null }))
      .toMatchObject({ ok: false, reason: "no-network" });
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread").get()!["n"]).toBe(before);
  });
});

describe("Codex round 1: an allow covers only what was shown; recovery only on proof; the session at the send", () => {
  const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: name, input, tool_use_id: `toolu-${id}` } });

  test("a multi-line command shows every line; a file change its path and whole change; an unknown tool its full input; each bound to the tool and the whole input's digest", async () => {
    const agent = await attached();
    agent.say(tool("r1", "Bash", { command: "npm test\nrm -rf ~/projects", description: "run the tests" }),
      tool("r2", "Write", { file_path: "/etc/hosts", content: "127.0.0.1 a\n10.0.0.1 b" }),
      tool("r3", "mcp__deploy__ship", { target: "production", force: true }));
    await settled();
    const questions = read().facts.questions;
    const [command, write, other] = ["Bash", "Write", "mcp__deploy__ship"].map(name => questions.find(one => one.tool === name));
    expect(command).toMatchObject({ tool: "Bash", complete: true, detail: "npm test\nrm -rf ~/projects\ndescription: run the tests" });
    expect(write).toMatchObject({ tool: "Write", complete: true, detail: "file: /etc/hosts\ncontent (22 bytes):\n+ 127.0.0.1 a\n+ 10.0.0.1 b" });
    expect(other).toMatchObject({ tool: "mcp__deploy__ship", complete: true, title: "Allow the agent's mcp__deploy__ship step?", detail: '{\n  "target": "production",\n  "force": true\n}' });
    const recorded = JSON.parse(String(raw.prepare("SELECT card FROM thread_request WHERE request_ref = 'r1'").get()!["card"])) as Record<string, unknown>;
    expect(recorded).toMatchObject({ tool: "Bash", input: flexibleInputDigest("Bash", { command: "npm test\nrm -rf ~/projects", description: "run the tests" }), complete: true });
  });

  test("a request too long (or secret-shaped) to show whole can be denied but not allowed, by the session and by F2d", async () => {
    const agent = await attached();
    const long = Array.from({ length: FLEXIBLE_SCOPE_LINES + 5 }, (_, n) => `echo ${n}`).join("\n");
    agent.say(tool("r1", "Bash", { command: long }), tool("r2", "Bash", { command: "export TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ0123456789" }));
    await settled();
    const questions = read().facts.questions;
    const tooLong = questions.find(one => one.detail?.includes("echo 0")), secret = questions.find(one => !one.detail?.includes("echo 0"));
    expect(tooLong).toMatchObject({ complete: false });
    expect(tooLong!.detail).toContain("This can't be allowed from here: it is too long to show here.");
    expect(secret).toMatchObject({ complete: false });
    expect(secret!.detail).not.toContain("ghp_");
    for (const shown of [tooLong!, secret!]) {
      expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: shown.request, shownDigest: shown.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW }))
        .toMatchObject({ ok: false, reason: "scope-unshown" });
    }
    expect(agent.sent).toEqual([]);
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: tooLong!.request, shownDigest: tooLong!.digest, by: pat(), choice: { decision: "decline" }, clock: () => NOW }))
      .toEqual({ ok: true, state: "sent" });
    // An input changed after its card was made (it no longer matches the digest the card holds): refused too.
    agent.say(tool("r3", "Bash", { command: "ls" }));
    await settled();
    const plain = read().facts.questions.find(one => one.detail === "ls")!;
    const entry = [...sessions.threads.get(T1)!.asked.values()].find(one => one.ref === "r3")!;
    entry.input["command"] = "rm -rf ~";
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: plain.request, shownDigest: plain.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "scope-unshown" });
    expect(agent.sent).toHaveLength(1);
    // F2d refuses it as well, whoever asks it to (the session's own check reverted: the card still says incomplete).
    const { decideFlexibleAnswer } = await import("./flexible-answers.js");
    const asked = [...sessions.threads.get(T1)!.asked.values()].find(one => one.ref === "r2")!;
    expect(decideFlexibleAnswer(world.store, sessions.catalog, { request: secret!.request, token: asked.token, shownDigest: secret!.digest, by: pat(), decision: "accept", clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "scope-unshown" });
  });

  test("the session's end between the decision and the send refuses the send: not-sent, nothing written", async () => {
    const agent = await attached();
    agent.say(bash("r1"));
    await settled();
    const shown = read().facts.questions[0]!;
    // Held at the decision; ended by the send (its queue and final attempt re-read it).
    let checks = 0;
    const held = () => ++checks <= 1;
    expect(await answerFlexibleRequest(world.store, sessions, { held, thread: T1, request: shown.request, shownDigest: shown.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "authority-changed", state: "not-sent" });
    expect(agent.sent).toEqual([]);
    expect(states()).toEqual([["r1", "not-sent"]]);
    // Ended before the decision: nothing is decided at all.
    agent.say(bash("r2"));
    await settled();
    const next = read().facts.questions.find(one => one.state === "pending")!;
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => false, thread: T1, request: next.request, shownDigest: next.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "authority-changed" });
    expect(states()).toEqual([["r1", "not-sent"], ["r2", "pending"]]);
  });

  test("a holder whose identity can't be read is never recovered: an unreadable table, or a pid whose start can't be read", async () => {
    const gone = `console:${fakePid(9)}:${"0".repeat(16)}`;
    world.store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ? WHERE id = ?").run(NOW.toISOString(), L1);
    const T2 = tid(2);
    world.store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
      .run(T2, world.project, world.second, `refs/toolroll/threads/${T2}/base`, join(world.state, "threads", T2), NOW.toISOString());
    world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
      VALUES (?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, 't1', 'live', ?)`).run(tid(0xc1), T2, "f".repeat(32), gone, "9".repeat(32), fakePid(9), NOW.toISOString());
    const blind = { ...sessions, io: { ...sessions.io, table: () => null } };
    expect(await recoverFlexibleHolders(world.store, blind, { clock: () => NOW })).toEqual({ ok: true, recovered: [], unresolved: [], unknown: [gone] });
    const startless = { ...sessions, io: { ...sessions.io, table: () => [{ pid: fakePid(9), ppid: 1, pgid: fakePid(9), uid: 0, start: null, zombie: false }] } };
    expect(await recoverFlexibleHolders(world.store, startless, { clock: () => NOW })).toEqual({ ok: true, recovered: [], unresolved: [], unknown: [gone] });
    expect(world.store.handle.prepare("SELECT state FROM flexible_thread_launch WHERE id = ?").get(tid(0xc1))!["state"]).toBe("live");
  });

  test("a replacement launch another console started between recovery's snapshot and the thread's lock is left alone, its agent untouched", async () => {
    const gone = `console:${fakePid(11)}:${"0".repeat(16)}`, other = `console:${process.pid}:${"1".repeat(16)}`, T2 = tid(2), L2 = tid(0xc2);
    world.store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
      .run(T2, world.project, world.second, `refs/toolroll/threads/${T2}/base`, join(world.state, "threads", T2), NOW.toISOString());
    mkdirSync(join(world.state, "threads", T2), { recursive: true });
    world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
      VALUES (?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, 't1', 'live', ?)`).run(L2, T2, "f".repeat(32), gone, "9".repeat(32), fakePid(11), NOW.toISOString());
    // The replacement's agent: a real process this test started (killed after, by its exact pid).
    const child: ChildProcess = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      const pid = child.pid!;
      const io = defaultCustodyIO();
      let start: string | null = null;
      for (let i = 0; i < 50 && start === null; i++) { start = startIdentityOf(pid, io); if (start === null) await new Promise(done => setTimeout(done, 20)); }
      // The lock is held from another task (it is re-entrant within one call, so recovery must not run inside it).
      let locked!: () => void, release!: () => void;
      const isLocked = new Promise<void>(done => { locked = done; }), released = new Promise<void>(done => { release = done; });
      const holding = withFlexibleThreadLock(T2, async () => { locked(); await released; });
      await isLocked;
      // Recovery reads the holder's launches now, then waits for the lock.
      const recovering = recoverFlexibleHolders(world.store, sessions, { clock: () => NOW });
      await settled();
      // Meanwhile another console settled the old launch and started a replacement.
      world.store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ? WHERE id = ?").run(NOW.toISOString(), L2);
      world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
        VALUES (?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, ?, 'live', ?)`).run(tid(0xd1), T2, "f".repeat(32), other, "9".repeat(32), pid, start, NOW.toISOString());
      world.store.handle.prepare("INSERT INTO flexible_relay_grant (token_digest, thread, turn, launch, issued_at) VALUES (?, ?, ?, ?, ?)").run("e".repeat(64), T2, turn, tid(0xd1), NOW.toISOString());
      release();
      await holding;
      await recovering;
      expect(world.store.handle.prepare("SELECT state, stop_reason FROM flexible_thread_launch WHERE id = ?").get(tid(0xd1))).toMatchObject({ state: "live", stop_reason: null });
      expect(world.store.handle.prepare("SELECT revoked_at FROM flexible_relay_grant WHERE launch = ?").get(tid(0xd1))).toEqual({ revoked_at: null });
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      if (child.pid !== undefined && child.exitCode === null) process.kill(child.pid, "SIGKILL");
    }
  });
});

describe("Codex round 2: what is shown is what is sent", () => {
  const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: name, input, tool_use_id: `toolu-${id}` } });

  test("a Makefile's tabs are drawn as a visible mark, one to one with the bytes sent; a tab beside the mark itself isn't whole", async () => {
    const agent = await attached();
    agent.say(tool("r1", "Write", { file_path: "Makefile", content: "test:\n\tnpm test\n\t\tnpm run lint" }), tool("r2", "Write", { file_path: "notes.txt", content: "a → b\n\tc" }));
    await settled();
    const questions = read().facts.questions;
    const makefile = questions.find(one => one.detail?.includes("Makefile"))!, ambiguous = questions.find(one => one.detail?.includes("notes.txt"))!;
    expect(makefile).toMatchObject({ complete: true, detail: "file: Makefile\ncontent (30 bytes):\n+ test:\n+ →   npm test\n+ →   →   npm run lint" });
    expect(ambiguous.complete).toBe(false);
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: ambiguous.request, shownDigest: ambiguous.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "scope-unshown" });
    expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: makefile.request, shownDigest: makefile.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW }))
      .toEqual({ ok: true, state: "sent" });
    // The bytes sent are the agent's own, tabs and all.
    expect(JSON.parse(agent.sent[0]!).response.response.updatedInput.content).toBe("test:\n\tnpm test\n\t\tnpm run lint");
  });

  test("a tool name too long, or one display would change, makes the card deny-only", async () => {
    const agent = await attached();
    agent.say(tool("r1", "x".repeat(101), { a: 1 }), tool("r2", "deploy‮now", { a: 1 }), tool("r3", "mcp tool", { a: 1 }));
    await settled();
    const questions = read().facts.questions;
    expect(questions).toHaveLength(3);
    for (const one of questions) {
      expect(one, one.request).toMatchObject({ complete: false, tool: "unnamed" });
      expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: one.request, shownDigest: one.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW }))
        .toMatchObject({ ok: false, reason: "scope-unshown" });
    }
    expect(agent.sent).toEqual([]);
  });

  test("a /proc entry that can't be read for any reason but its being gone leaves the holder unknown, and nothing is recovered", async () => {
    const { linuxTable } = await import("./flexible-custody.js");
    const gone = `console:${fakePid(13)}:${"0".repeat(16)}`, T2 = tid(2);
    world.store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
      .run(T2, world.project, world.second, `refs/toolroll/threads/${T2}/base`, join(world.state, "threads", T2), NOW.toISOString());
    world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
      VALUES (?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, 't1', 'live', ?)`).run(tid(0xc3), T2, "f".repeat(32), gone, "9".repeat(32), fakePid(13), NOW.toISOString());
    const errno = (code: string) => Object.assign(new Error(code), { code });
    const stat = (pid: number) => `${pid} (node) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0`;
    const fsWith = (fail: { stat?: string; read?: string }) => ({
      readdir: () => ["1", String(fakePid(13))],
      readFile: (path: string) => { if (path.includes(String(fakePid(13))) && fail.read !== undefined) throw errno(fail.read); return stat(Number(path.split("/")[2])); },
      statUid: (path: string) => { if (path.includes(String(fakePid(13))) && fail.stat !== undefined) throw errno(fail.stat); return 0; },
    });
    // Unreadable (EACCES on stat, EIO on the stat file): the whole table is unknown.
    for (const fail of [{ stat: "EACCES" }, { read: "EIO" }, { stat: "EPERM" }]) {
      expect(linuxTable(fsWith(fail)), JSON.stringify(fail)).toBeNull();
      const blind = { ...sessions, io: { ...sessions.io, table: () => linuxTable(fsWith(fail)) } };
      expect(await recoverFlexibleHolders(world.store, blind, { clock: () => NOW })).toMatchObject({ ok: true, recovered: [], unknown: [gone] });
    }
    // Gone (ENOENT, ESRCH): the process is left out of a table that is otherwise whole.
    for (const fail of [{ stat: "ENOENT" }, { read: "ESRCH" }]) expect(linuxTable(fsWith(fail))?.map(row => row.pid), JSON.stringify(fail)).toEqual([1]);
    expect(world.store.handle.prepare("SELECT state FROM flexible_thread_launch WHERE id = ?").get(tid(0xc3))!["state"]).toBe("live");
  });
});

describe("a card is never cut while it says it is whole", () => {
  const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: name, input, tool_use_id: `toolu-${id}` } });
  test("input under the raw cap whose shown form (tabs drawn as marks) is over it is deny-only; so is one whose detail would pass 32,000 characters", async () => {
    const agent = await attached();
    // 5,000 tabs: under the 16,000-character cap as bytes, 20,000 characters once each is drawn as its mark.
    agent.say(tool("r1", "Write", { file_path: "Makefile", content: `all:\n${"\t".repeat(5_000)}x` }),
      tool("r2", "Bash", { command: Array.from({ length: 150 }, (_, n) => `echo ${String(n).padStart(3, "0")} ${"y".repeat(230)}`).join("\n") }));
    await settled();
    const questions = read().facts.questions;
    expect(questions).toHaveLength(2);
    for (const one of questions) {
      expect(one, one.request).toMatchObject({ complete: false });
      expect(one.detail!.length).toBeLessThanOrEqual(32_000);
      expect(one.detail).toContain("This can't be allowed from here: it is too long to show here.");
      expect(await answerFlexibleRequest(world.store, sessions, { held: () => true, thread: T1, request: one.request, shownDigest: one.digest, by: pat(), choice: { decision: "accept" }, clock: () => NOW }))
        .toMatchObject({ ok: false, reason: "scope-unshown" });
    }
    expect(agent.sent).toEqual([]);
    // Every whole card's detail is exactly the text it shows, never a cut of it.
    const recorded = raw.prepare("SELECT card FROM thread_request").all().map(row => JSON.parse(String(row["card"])) as { complete: boolean; detail: string });
    expect(recorded.filter(card => card.complete)).toEqual([]);
  });
});

describe("the owner's read woken on change (pre-enable push, no polling)", () => {
  test("a wait wakes at the agent's next words, a request, an answer's send and the turn's end; it never waits when a change came first", async () => {
    const agent = await attached();
    const change = () => { const read = flexibleThreadChangeOf(sessions, { thread: T1 }); if (!read.ok) throw new Error(read.message); return read.change; };
    const wakes = async (act: () => void | Promise<unknown>) => {
      const since = change();
      const waiting = waitFlexibleThreadChange(sessions, { thread: T1, since, ms: 5_000 });
      if (!("then" in waiting)) throw new Error(waiting.message);
      await act();
      await settled();
      return waiting;
    };
    expect(await wakes(() => agent.say({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Reading the README" }] } }))).toEqual({ ok: true, woke: "changed" });
    expect(await wakes(() => agent.say(bash("r1")))).toEqual({ ok: true, woke: "changed" });
    const card = read().facts.questions[0]!;
    expect(await wakes(() => answerFlexibleRequest(world.store, sessions, { thread: T1, request: card.request, shownDigest: card.digest, by: pat(), choice: { decision: "accept" }, held: () => true, clock: () => NOW })))
      .toEqual({ ok: true, woke: "changed" });
    expect(await wakes(() => endFlexibleThreadTurn(world.store, sessions, { thread: T1, turn, outcome: "finished", clock: () => NOW }))).toEqual({ ok: true, woke: "changed" });
    // A change between the read and the wait is never missed: the count taken before the read has moved, so it answers now.
    const stale = change();
    agent.say({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Done" }] } });
    await settled();
    expect(await waitFlexibleThreadChange(sessions, { thread: T1, since: stale, ms: 5_000 })).toEqual({ ok: true, woke: "changed" });
  });

  test("with nothing changing it waits its time out; a reader that goes away stops it; past the cap a read answers at once", async () => {
    const since = flexibleThreadChangeOf(sessions, { thread: T1 });
    if (!since.ok) throw new Error(since.message);
    const started = Date.now();
    expect(await waitFlexibleThreadChange(sessions, { thread: T1, since: since.change, ms: 60 })).toEqual({ ok: true, woke: "timeout" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    let stop: () => void = () => {};
    const abandoned = waitFlexibleThreadChange(sessions, { thread: T1, since: since.change, ms: 5_000, abandoned: give => { stop = give; } });
    stop();
    expect(await abandoned).toEqual({ ok: true, woke: "abandoned" });
    expect(sessions.waiters.size).toBe(0);
    const held: Promise<unknown>[] = [];
    for (let n = 0; n < FLEXIBLE_WAITERS_MAX; n++) held.push(waitFlexibleThreadChange(sessions, { thread: T1, since: since.change, ms: 5_000 }) as Promise<unknown>);
    expect(await waitFlexibleThreadChange(sessions, { thread: T1, since: since.change, ms: 5_000 })).toEqual({ ok: true, woke: "busy" });
    // Closing the host wakes every waiter.
    await stopFlexibleThreadSession(world.store, sessions, { thread: T1, reason: "test", clock: () => NOW });
    expect((await Promise.all(held)).every(one => JSON.stringify(one) === JSON.stringify({ ok: true, woke: "changed" }))).toBe(true);
    expect(waitFlexibleThreadChange(sessions, { thread: T1, since: 0, ms: FLEXIBLE_WAIT_MS + 1 })).toMatchObject({ ok: false, reason: "invalid-request" });
  });
});
