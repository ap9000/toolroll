/**
 * Flexible threads, slice F2d (flexible-answers.ts, v167): the answer state machine across the main database and the
 * coding catalog. Every transition and every illegal one; the single-use token; each binding (generation, owner,
 * connection, turn, card) refused when it changed, at the decision and at the write; a cancel racing a send (exactly
 * one wins); no I/O inside a database transaction (a real pipe nobody reads hits its deadline while another writer
 * goes on); a database failure injected after each commit of a send; the ack timeout; an ambiguous tool event; a
 * question id that names object machinery; the catalog's path; a crash mid-send (a real process killed inside the send) that
 * recovers to uncertain and is never sent again; one decision id in both stores. Scripted connections only: no agent
 * process, no model.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openStore, type Store } from "./store.js";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, finishFlexibleTurn } from "./flexible-turns.js";
import {
  ackFlexibleAnswer, cancelFlexibleAnswer, decideFlexibleAnswer, decideFlexibleAnswerByPolicy, expireFlexibleAnswers, FLEXIBLE_ANSWER_ACK_MS, FLEXIBLE_ANSWER_WRITE_MS, noteFlexibleToolActivity,
  openFlexibleAnswerCatalog, recordFlexibleProviderDecision, recordFlexibleRequest, recoverFlexibleAnswersOf, revokeFlexibleAnswers, sendFlexibleAnswer, streamAnswerSender,
  type FlexibleAnswerCatalog, type FlexibleAnswerConnection, type FlexibleAnswerPayload, type FlexibleRequestInput,
} from "./flexible-answers.js";
import { fakePid } from "../test/fake-pid.js";
// @ts-expect-error plain ESM script without declarations
import { checkedEnv, ownRoot } from "../scripts/e2e-kit.mjs";
// @ts-expect-error plain ESM script without declarations
import { isolatedEnvironment } from "../scripts/isolated-env.mjs";

vi.mock("./flexible-available.js", async original => ({ ...await original<typeof import("./flexible-available.js")>(), flexibleAvailable: () => true }));

const NOW = new Date("2026-11-14T10:00:00.000Z");
const at = (ms: number) => () => new Date(NOW.getTime() + ms);
const tid = (k: number) => k.toString(16).padStart(32, "0");
const T1 = tid(1), L1 = tid(0xa1), L2 = tid(0xa2);
let dir: string, file: string, catalogFile: string, REPO: string, store: Store, catalog: FlexibleAnswerCatalog, raw: DatabaseSync, turn: string, digest: string;
let keys = 0;
const gen = (name: string) => store.accountOf(name)!.generation;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flexible-answers-")));
  file = join(dir, "orders.db");
  catalogFile = `${file}.coding.sqlite`;
  REPO = join(dir, "app");
  store = openStore(file);
  store.saveApprover("alex", "hash-a", NOW);
  store.saveApprover("pat", "hash-p", NOW);
  expect(store.setAccountProjects("pat", [REPO], "alex", NOW)).toEqual({ ok: true });
  store.saveApprover("lee", "hash-l", NOW);
  expect(store.setAccountProjects("lee", [REPO], "alex", NOW)).toEqual({ ok: true });
  const terms: FlexibleTerms = { version: 1, repo: REPO, signer: "alex", signerGeneration: gen("alex"), starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  digest = flexibleDigestOf(terms);
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(REPO, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
    .run(T1, REPO, "a".repeat(40), `refs/toolroll/threads/${T1}/base`, `/home/me/state/threads/${T1}`, NOW.toISOString());
  turn = running();
  launch(L1, 1);
  const opened = openFlexibleAnswerCatalog(store);
  if (!opened.ok) throw new Error(opened.message);
  catalog = opened.catalog;
  raw = new DatabaseSync(catalogFile);
});
const children: ChildProcess[] = [];
afterEach(async () => {
  // Only what this file started, by its exact pid; and gone before its folder is removed, so a straggler can never
  // write (or make a database) there afterwards.
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) { resolve(); return; }
    child.once("exit", () => resolve());
    try { process.kill(child.pid, "SIGKILL"); } catch { resolve(); }
  })));
  raw.close(); catalog.close(); store.close(); rmSync(dir, { recursive: true, force: true });
});

/** pat's turn on T1, admitted and running (held by h1). */
function running(): string {
  const made = admitFlexibleTurn(store, { thread: T1, starter: { name: "pat", generation: gen("pat") }, digest, level: "full", freshProof: false, provider: "claude",
    model: "claude-sonnet-4-5", billing: "subscription", requestKey: `m-${++keys}`, holder: "h1", clock: () => NOW });
  if (!made.ok) throw new Error(made.message);
  const begun = beginFlexibleTurn(store, { turn: made.turn, holder: "h1", clock: () => NOW });
  if (!begun.ok) throw new Error(begun.message);
  return made.turn;
}
/** A live agent launch of T1 on the record (as flexibleThreadSpawn registers one), held by h1: the connection. */
function launch(id: string, offset: number): void {
  store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, ?, 'claude', 'full', ?, 'h1', 'here', ?, ?, 't1', 'live', ?)`).run(id, T1, turn, "f".repeat(32), "9".repeat(32), fakePid(offset), NOW.toISOString());
}
const exited = (id: string) => store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ? WHERE id = ?").run(NOW.toISOString(), id);

let refs = 0;
function ask(over: Partial<FlexibleRequestInput> = {}) {
  const made = recordFlexibleRequest(store, catalog, { thread: T1, turn, connection: L1, holder: "h1", requestRef: `r-${++refs}`, kind: "permission",
    card: { title: "Allow this command?", detail: "npm test", tool: "Bash", input: "c".repeat(64), complete: true }, clock: () => NOW, ...over });
  if (!made.ok) throw new Error(`${made.reason}: ${made.message}`);
  return made;
}
const pat = () => ({ kind: "person" as const, name: "pat", generation: gen("pat") });
function decided(over: Partial<Parameters<typeof decideFlexibleAnswer>[2]> = {}) {
  const asked = ask();
  const made = decideFlexibleAnswer(store, catalog, { request: asked.request, token: asked.token, shownDigest: asked.requestDigest, by: pat(), decision: "accept", clock: () => NOW, ...over });
  if (!made.ok) throw new Error(`${made.reason}: ${made.message}`);
  return { ...asked, decisionId: made.decisionId };
}
const frame = (ref: string, answer: FlexibleAnswerPayload) => Buffer.from(JSON.stringify({ ref, answer }));
/** Wait for a state transition (polled; never a fixed sleep standing in for one). */
async function until(check: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  for (let waited = 0; waited < budgetMs && !check(); waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
  if (!check()) throw new Error(`never happened: ${what}`);
}
const attemptOf = (request: string) => store.handle.prepare("SELECT attempt_id FROM thread_decision WHERE request = ?").get(request)?.["attempt_id"] ?? null;
/** A scripted connection standing in for the agent launch: the receiver keeps every byte it was handed. */
function scripted(id = L1, over: Partial<FlexibleAnswerConnection> = {}) {
  const received: Buffer[] = [], writes: { ref: string; answer: FlexibleAnswerPayload }[] = [];
  const connection: FlexibleAnswerConnection = { id, frame, send: async bytes => {
    received.push(Buffer.from(bytes));
    writes.push(JSON.parse(Buffer.from(bytes).toString("utf8")) as { ref: string; answer: FlexibleAnswerPayload });
    return { written: bytes.length, complete: true };
  }, ...over };
  return { connection, received, writes };
}
const send = (request: string, connection: FlexibleAnswerConnection, clock = () => NOW, writeMs?: number) =>
  sendFlexibleAnswer(store, catalog, { request, connection, holder: "h1", clock, ...(writeMs === undefined ? {} : { writeMs }) });
const catalogState = (request: string) => String(raw.prepare("SELECT state FROM thread_request WHERE id = ?").get(request)?.["state"]);
const mainState = (request: string) => store.handle.prepare("SELECT state FROM thread_decision WHERE request = ?").get(request)?.["state"];
const states = (request: string) => ({ catalog: catalogState(request), main: mainState(request) });
const decisions = () => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM thread_decision").get()!["n"]);
const ledger = () => store.handle.prepare("SELECT outcome, actor, source FROM action_ledger WHERE action = 'flexible answer' ORDER BY id").all().map(row => ({ ...row }));

describe("the answer's road", () => {
  test("pending → decided → sending → sent → delivered: the exact answer once, one decision id in both stores, the intent and each outcome in the ledger", async () => {
    const asked = ask({ requestRef: "rpc-7" });
    expect(states(asked.request)).toEqual({ catalog: "pending", main: undefined });
    const made = decideFlexibleAnswer(store, catalog, { request: asked.request, token: asked.token, shownDigest: asked.requestDigest, by: pat(), decision: "accept", clock: () => NOW });
    expect(made).toMatchObject({ ok: true, state: "decided" });
    if (!made.ok) return;
    expect(states(asked.request)).toEqual({ catalog: "decided", main: "decided" });
    // One immutable decision id across both stores.
    expect(raw.prepare("SELECT decision_id FROM thread_request WHERE id = ?").get(asked.request)!["decision_id"]).toBe(made.decisionId);
    expect(store.handle.prepare("SELECT decision_id, source, by, by_generation FROM thread_decision WHERE request = ?").get(asked.request)).toMatchObject({ decision_id: made.decisionId, source: "person", by: "pat", by_generation: gen("pat") });
    expect(() => raw.prepare("UPDATE thread_request SET decision_id = ? WHERE id = ?").run(tid(0xdead), asked.request)).toThrow(/written once/);
    expect(() => store.handle.prepare("UPDATE thread_decision SET decision_id = ? WHERE request = ?").run(tid(0xdead), asked.request)).toThrow(/written once/);
    const { connection, writes } = scripted(L1, { ready: async () => { expect(states(asked.request)).toEqual({ catalog: "sending", main: "sending" }); } });
    expect(await send(asked.request, connection)).toEqual({ ok: true, state: "sent", decisionId: made.decisionId });
    expect(writes).toEqual([{ ref: "rpc-7", answer: { decision: "accept" } }]);
    expect(states(asked.request)).toEqual({ catalog: "sent", main: "sent" });
    expect(ackFlexibleAnswer(store, catalog, { connection: L1, requestRef: "rpc-7", clock: () => NOW })).toEqual({ ok: true, delivered: true });
    expect(states(asked.request)).toEqual({ catalog: "delivered", main: "delivered" });
    expect(ledger()).toEqual([{ outcome: "intended", actor: "pat", source: "work" }, { outcome: "attempt", actor: "pat", source: "work" }, { outcome: "sent", actor: "pat", source: "work" },
      { outcome: "delivered", actor: "toolroll", source: "work" }]);
    // The attempt was committed in both stores, the same one, before the bytes left.
    const marks = [raw.prepare("SELECT attempt_id, write_started_at FROM thread_request WHERE id = ?").get(asked.request), store.handle.prepare("SELECT attempt_id, write_started_at FROM thread_decision WHERE request = ?").get(asked.request)];
    expect(marks[0]!["attempt_id"]).toMatch(/^[0-9a-f]{32}$/);
    expect({ ...marks[1] }).toEqual({ ...marks[0] });
    expect(writes).toHaveLength(1);
  });

  test("a question takes exactly its questions' answers; a permission only accept, decline or cancel", () => {
    const question = ask({ kind: "question", card: { title: "The agent needs your answer", questions: [{ id: "q1", question: "Which branch?" }] } });
    const base = { request: question.request, token: question.token, shownDigest: question.requestDigest, by: pat(), clock: () => NOW };
    expect(decideFlexibleAnswer(store, catalog, { ...base, decision: "answer", answers: { q1: { answers: [] } } })).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(decideFlexibleAnswer(store, catalog, { ...base, decision: "answer", answers: { q1: { answers: ["main"] }, q2: { answers: ["x"] } } })).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(decideFlexibleAnswer(store, catalog, { ...base, decision: "answer", answers: { q1: { answers: ["main"] } } })).toMatchObject({ ok: true });
    expect(JSON.parse(String(raw.prepare("SELECT answer FROM thread_request WHERE id = ?").get(question.request)!["answer"]))).toEqual({ answers: { q1: { answers: ["main"] } } });
    const permission = ask();
    expect(decideFlexibleAnswer(store, catalog, { request: permission.request, token: permission.token, shownDigest: permission.requestDigest, by: pat(), decision: "answer", answers: {}, clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "invalid-request" });
    expect(catalogState(permission.request)).toBe("pending");
  });

  test("a question id that names object machinery is refused; an answer takes only its own keys, never inherited ones", () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      expect(recordFlexibleRequest(store, catalog, { thread: T1, turn, connection: L1, holder: "h1", requestRef: `p-${id}`, kind: "question",
        card: JSON.parse(`{"title":"Which?","questions":[{"id":"${id}","question":"Which branch?"}]}`), clock: () => NOW })).toMatchObject({ ok: false, reason: "invalid-request" });
    }
    const question = ask({ kind: "question", card: { title: "The agent needs your answer", questions: [{ id: "q1", question: "Which branch?" }] } });
    const base = { request: question.request, token: question.token, shownDigest: question.requestDigest, by: pat(), decision: "answer" as const, clock: () => NOW };
    for (const answers of [
      JSON.parse('{"__proto__":{"answers":["x"]},"q1":{"answers":["main"]}}'), // an own __proto__ key
      Object.create({ q1: { answers: ["main"] } }), // the answer inherited
      { q1: Object.create({ answers: ["main"] }) }, // its list inherited
    ]) expect(decideFlexibleAnswer(store, catalog, { ...base, answers })).toMatchObject({ ok: false, reason: "invalid-request" });
    // Even with Object.prototype polluted, an answer missing from the input itself is missing.
    Object.defineProperty(Object.prototype, "q1", { value: { answers: ["polluted"] }, configurable: true, enumerable: false });
    try { expect(decideFlexibleAnswer(store, catalog, { ...base, answers: {} })).toMatchObject({ ok: false, reason: "invalid-request" }); }
    finally { delete (Object.prototype as Record<string, unknown>)["q1"]; }
    expect(catalogState(question.request)).toBe("pending");
    // A null-prototype dictionary of exactly its answers is fine, and is stored as plain JSON.
    const dictionary = Object.assign(Object.create(null) as Record<string, unknown>, { q1: { answers: ["main"] } });
    expect(decideFlexibleAnswer(store, catalog, { ...base, answers: dictionary })).toMatchObject({ ok: true });
    expect(JSON.parse(String(raw.prepare("SELECT answer FROM thread_request WHERE id = ?").get(question.request)!["answer"]))).toEqual({ answers: { q1: { answers: ["main"] } } });
  });

  test("every illegal transition is refused by both stores; an answer with an attempt is never not-sent", () => {
    // "sending*" is sending with a committed attempt: from there only sent or uncertain.
    const allowed: Record<string, string[]> = { pending: ["decided", "withdrawn"], decided: ["sending", "not-sent", "uncertain"], sending: ["not-sent", "uncertain"], "sending*": ["sent", "uncertain"],
      sent: ["delivered", "uncertain"], delivered: [], "not-sent": [], uncertain: [], withdrawn: [] };
    const targets = ["pending", "decided", "sending", "sent", "delivered", "not-sent", "uncertain", "withdrawn"];
    const final = (state: string) => !["pending", "decided", "sending", "sending*", "sent"].includes(state);
    const attempted = (state: string) => ["sending*", "sent", "delivered"].includes(state);
    for (const from of Object.keys(allowed)) {
      for (const to of targets.filter(one => one !== from.replace("*", ""))) {
        const id = tid(0x5000 + ++refs);
        const state = from.replace("*", "");
        const decision = state === "pending" || state === "withdrawn" ? null : tid(0x6000 + refs);
        raw.prepare(`INSERT INTO thread_request (id, thread, turn, connection_id, holder, owner, owner_generation, request_ref, kind, card, request_digest, token_digest, state,
          decision_id, source, decision, answer, payload_digest, decided_by, decided_at, attempt_id, write_started_at, created_at, sent_at, ended_at)
          VALUES (?, ?, ?, ?, 'h1', 'pat', 1, ?, 'permission', '{"title":"x"}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, T1, turn, L1, `m-${id}`, "1".repeat(64), id.padEnd(64, "0"), state, ...(decision === null ? [null, null, null, null, null, null, null] : [decision, "person", "accept", '{"decision":"accept"}', "2".repeat(64), "pat", NOW.toISOString()]),
            attempted(from) ? tid(0x7000 + refs) : null, attempted(from) ? NOW.toISOString() : null, NOW.toISOString(), state === "sent" || state === "delivered" ? NOW.toISOString() : null, final(state) ? NOW.toISOString() : null);
        const move = () => to === "decided"
          ? raw.prepare(`UPDATE thread_request SET state = 'decided', decision_id = ?, source = 'person', decision = 'accept', answer = '{"decision":"accept"}', payload_digest = ?, decided_by = 'pat', decided_at = ? WHERE id = ?`)
            .run(decision ?? tid(0x8000 + refs), "2".repeat(64), NOW.toISOString(), id)
          : raw.prepare("UPDATE thread_request SET state = ?, ended_at = ?, sent_at = COALESCE(sent_at, ?) WHERE id = ?").run(to, final(to) ? NOW.toISOString() : null, to === "sent" || to === "delivered" ? NOW.toISOString() : null, id);
        if (allowed[from]!.includes(to)) expect(move, `${from} → ${to}`).not.toThrow();
        else expect(move, `${from} → ${to}`).toThrow();
      }
    }
    // The main store has no pending or withdrawn: a decision is born decided.
    const mainFrom = Object.keys(allowed).filter(one => one !== "pending" && one !== "withdrawn");
    for (const from of mainFrom) {
      for (const to of targets.filter(one => one !== from.replace("*", "") && one !== "pending" && one !== "withdrawn")) {
        const request = tid(0x9000 + ++refs);
        store.handle.prepare(`INSERT INTO thread_decision (decision_id, thread, turn, request, request_ref, source, decision, request_digest, payload_digest, connection_id, state, at, by, by_generation, state_at)
          VALUES (?, ?, ?, ?, 'r', 'person', 'accept', ?, ?, ?, 'decided', ?, 'pat', 1, ?)`).run(request, T1, turn, request, "1".repeat(64), "2".repeat(64), L1, NOW.toISOString(), NOW.toISOString());
        const road: Record<string, string[]> = { decided: [], sending: ["sending"], "sending*": ["sending", "!"], sent: ["sending", "!", "sent"], delivered: ["sending", "!", "sent", "delivered"], "not-sent": ["not-sent"], uncertain: ["uncertain"] };
        for (const step of road[from]!) {
          if (step === "!") store.handle.prepare("UPDATE thread_decision SET attempt_id = ?, write_started_at = ? WHERE request = ?").run(tid(0xa000 + refs), NOW.toISOString(), request);
          else store.handle.prepare("UPDATE thread_decision SET state = ? WHERE request = ?").run(step, request);
        }
        const move = () => store.handle.prepare("UPDATE thread_decision SET state = ? WHERE request = ?").run(to, request);
        if (allowed[from]!.includes(to)) expect(move, `main ${from} → ${to}`).not.toThrow();
        else expect(move, `main ${from} → ${to}`).toThrow();
      }
    }
    // An attempt is marked once, only while sending, in both stores.
    const asked = decided();
    expect(() => raw.prepare("UPDATE thread_request SET attempt_id = ?, write_started_at = ? WHERE id = ?").run(tid(0xb001), NOW.toISOString(), asked.request)).toThrow(/only moves forward/);
    expect(() => store.handle.prepare("UPDATE thread_decision SET attempt_id = ?, write_started_at = ? WHERE request = ?").run(tid(0xb001), NOW.toISOString(), asked.request)).toThrow(/only moves forward/);
  });
});

describe("the token and the card", () => {
  test("the token is single use: a replay is refused and nothing is decided or sent twice; a token that isn't this request's is refused", async () => {
    const asked = ask();
    const answer = { request: asked.request, token: asked.token, shownDigest: asked.requestDigest, by: pat(), decision: "accept" as const, clock: () => NOW };
    expect(decideFlexibleAnswer(store, catalog, answer)).toMatchObject({ ok: true });
    expect(decideFlexibleAnswer(store, catalog, answer)).toMatchObject({ ok: false, reason: "already-answered", state: "decided" });
    expect(decideFlexibleAnswer(store, catalog, { ...answer, decision: "decline" })).toMatchObject({ ok: false, reason: "already-answered" });
    const other = ask();
    expect(decideFlexibleAnswer(store, catalog, { ...answer, request: other.request })).toMatchObject({ ok: false, reason: "token-mismatch" });
    expect(decideFlexibleAnswer(store, catalog, { ...answer, request: other.request, token: "0".repeat(64), shownDigest: other.requestDigest })).toMatchObject({ ok: false, reason: "token-mismatch" });
    expect(catalogState(other.request)).toBe("pending");
    const { connection, writes } = scripted();
    expect(await send(asked.request, connection)).toMatchObject({ ok: true, state: "sent" });
    expect(await send(asked.request, connection)).toMatchObject({ ok: false, reason: "already-answered", state: "sent" });
    expect(writes).toHaveLength(1);
    expect(decisions()).toBe(1);
    // Only the digest of a token is kept.
    expect(JSON.stringify(raw.prepare("SELECT * FROM thread_request").all())).not.toContain(asked.token);
  });

  test("the person answers the card exactly as they saw it; a model, a lead or an agent never decides", () => {
    const asked = ask();
    const answer = { request: asked.request, token: asked.token, shownDigest: asked.requestDigest, by: pat(), decision: "accept" as const, clock: () => NOW };
    expect(decideFlexibleAnswer(store, catalog, { ...answer, shownDigest: "3".repeat(64) })).toMatchObject({ ok: false, reason: "card-changed" });
    for (const kind of ["model", "lead", "agent", "policy"]) {
      expect(decideFlexibleAnswer(store, catalog, { ...answer, by: { ...pat(), kind } as never })).toMatchObject({ ok: false, reason: "not-a-person" });
    }
    expect(decisions()).toBe(0);
    expect(catalogState(asked.request)).toBe("pending");
  });
});

describe("each binding, at the decision and at the write", () => {
  type Change = (asked: { request: string }) => void;
  const changes: [string, Change, string][] = [
    ["the owner's generation", () => { store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'pat'").run(); }, "stale-generation"],
    ["the turn", () => { finishFlexibleTurn(store, { turn, holder: "h1", outcome: "finished", usage: null, clock: () => NOW }); }, "turn-changed"],
    ["the connection", () => { exited(L1); }, "connection-changed"],
    // Changing a person's access starts a new generation of their account, and ends their running turn in the same
    // transaction (flexible-authority-end.ts): the question's turn is over, so it can't be answered.
    ["the owner's access", () => { expect(store.setAccountProjects("pat", [join(dir, "other")], "alex", NOW)).toEqual({ ok: true }); }, "turn-changed"],
    ["the terms", () => { store.handle.prepare("UPDATE flexible_terms SET ended_at = ?, ended_by = 'alex', end_reason = 'off' WHERE ended_at IS NULL").run(NOW.toISOString()); }, "authority-changed"],
    ["the thread's level", () => { store.handle.prepare("INSERT INTO flexible_thread_level (thread, level, set_by, set_at) VALUES (?, 'auto', 'pat', ?)").run(T1, NOW.toISOString()); }, "authority-changed"],
    ["the thread", () => { store.handle.prepare("UPDATE flexible_thread SET state = 'removing' WHERE id = ?").run(T1); }, "thread-changed"],
  ];

  test.each(changes)("%s changed before the decision: refused, nothing recorded", (_what, change, reason) => {
    const asked = ask();
    const generation = gen("pat");
    change(asked);
    expect(decideFlexibleAnswer(store, catalog, { request: asked.request, token: asked.token, shownDigest: asked.requestDigest, by: { kind: "person", name: "pat", generation }, decision: "accept", clock: () => NOW }))
      .toMatchObject({ ok: false, reason });
    expect(decisions()).toBe(0);
    expect(catalogState(asked.request)).toBe("pending");
  });

  test.each(changes)("%s changed after the decision: the final check refuses, nothing is written, the answer is not-sent", async (_what, change, reason) => {
    const asked = decided();
    change(asked);
    const { connection, writes } = scripted();
    expect(await send(asked.request, connection)).toMatchObject({ ok: false, reason, state: "not-sent" });
    expect(writes).toEqual([]);
    expect(states(asked.request)).toEqual({ catalog: "not-sent", main: "not-sent" });
  });

  test.each(changes)("%s changed while the answer was queued (between sending and the write): nothing is written", async (_what, change, reason) => {
    const asked = decided();
    const { connection, writes } = scripted(L1, { ready: async () => change(asked) });
    expect(await send(asked.request, connection)).toMatchObject({ ok: false, reason, state: "not-sent" });
    expect(writes).toEqual([]);
    expect(states(asked.request)).toEqual({ catalog: "not-sent", main: "not-sent" });
  });

  test("another person, even an approver of the project, can't answer; nor the owner at an old generation", () => {
    const asked = ask();
    const answer = { request: asked.request, token: asked.token, shownDigest: asked.requestDigest, decision: "accept" as const, clock: () => NOW };
    expect(decideFlexibleAnswer(store, catalog, { ...answer, by: { kind: "person", name: "lee", generation: gen("lee") } })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(decideFlexibleAnswer(store, catalog, { ...answer, by: { kind: "person", name: "pat", generation: gen("pat") - 1 } })).toMatchObject({ ok: false, reason: "stale-generation" });
    expect(decisions()).toBe(0);
  });

  test("the answer goes only to the connection that asked: another launch's object, or another holder, writes nothing", async () => {
    const asked = decided();
    const other = scripted(L2);
    expect(await send(asked.request, other.connection)).toMatchObject({ ok: false, reason: "connection-changed", state: "not-sent" });
    expect(other.writes).toEqual([]);
    const again = decided();
    const right = scripted();
    expect(await sendFlexibleAnswer(store, catalog, { request: again.request, connection: right.connection, holder: "h2", clock: () => NOW })).toMatchObject({ ok: false, reason: "connection-changed" });
    expect(right.writes).toEqual([]);
  });

  test("a request is recorded only while its turn runs on that very launch, held by that holder", () => {
    const base = { thread: T1, turn, connection: L1, holder: "h1", requestRef: "x", kind: "permission" as const, card: { title: "Allow?", tool: "Bash", input: "c".repeat(64), complete: true }, clock: () => NOW };
    expect(recordFlexibleRequest(store, catalog, { ...base, holder: "h2" })).toMatchObject({ ok: false, reason: "turn-changed" });
    expect(recordFlexibleRequest(store, catalog, { ...base, connection: L2 })).toMatchObject({ ok: false, reason: "connection-changed" });
    expect(recordFlexibleRequest(store, catalog, { ...base, kind: "question" })).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM thread_request").get()!["n"]).toBe(0);
  });
});

describe("an allow covers only a request shown whole (F3, Codex round 1)", () => {
  test("decide refuses an accept on a card that says it isn't whole, or doesn't say it is; a decline still goes", () => {
    for (const complete of [false, undefined]) {
      const asked = ask({ card: { title: "Allow this command?", detail: "echo 0 …", tool: "Bash", input: "c".repeat(64), ...(complete === undefined ? {} : { complete }) } });
      expect(decideFlexibleAnswer(store, catalog, { request: asked.request, token: asked.token, shownDigest: asked.requestDigest, by: pat(), decision: "accept", clock: () => NOW }))
        .toMatchObject({ ok: false, reason: "scope-unshown" });
      expect(decideFlexibleAnswer(store, catalog, { request: asked.request, token: asked.token, shownDigest: asked.requestDigest, by: pat(), decision: "decline", clock: () => NOW }))
        .toMatchObject({ ok: true, state: "decided" });
    }
  });

  test("a permission card must name its tool and its whole input's digest", () => {
    const base = { thread: T1, turn, connection: L1, holder: "h1", requestRef: "s", kind: "permission" as const, clock: () => NOW };
    for (const card of [{ title: "Allow?" }, { title: "Allow?", tool: "Bash" }, { title: "Allow?", input: "c".repeat(64) }, { title: "Allow?", tool: "Bash", input: "short" }]) {
      expect(recordFlexibleRequest(store, catalog, { ...base, card }), JSON.stringify(card)).toMatchObject({ ok: false, reason: "invalid-request" });
    }
  });
});

describe("cancelling", () => {
  test("a decided answer is cancelled: not-sent in both stores, and a later send writes nothing", async () => {
    const asked = decided();
    expect(cancelFlexibleAnswer(store, catalog, { request: asked.request, by: pat(), clock: () => NOW })).toEqual({ ok: true, state: "not-sent" });
    expect(states(asked.request)).toEqual({ catalog: "not-sent", main: "not-sent" });
    const { connection, writes } = scripted();
    expect(await send(asked.request, connection)).toMatchObject({ ok: false, state: "not-sent" });
    expect(writes).toEqual([]);
    expect(ledger().map(one => one["outcome"])).toEqual(["intended", "not-sent"]);
  });

  test("a cancel racing a send while it is queued wins: nothing is written and the state says not-sent", async () => {
    const asked = decided();
    let cancelled: unknown;
    const { connection, writes } = scripted(L1, { ready: async () => { cancelled = cancelFlexibleAnswer(store, catalog, { request: asked.request, by: pat(), clock: () => NOW }); } });
    expect(await send(asked.request, connection)).toMatchObject({ ok: false, reason: "not-sent", state: "not-sent" });
    expect(cancelled).toEqual({ ok: true, state: "not-sent" });
    expect(writes).toEqual([]);
    expect(states(asked.request)).toEqual({ catalog: "not-sent", main: "not-sent" });
  });

  test("a cancel racing a send once its attempt is committed loses: the bytes left once and the state says sent", async () => {
    const asked = decided();
    let cancelled: unknown;
    const { connection, writes } = scripted(L1, { send: async bytes => {
      cancelled = cancelFlexibleAnswer(store, catalog, { request: asked.request, by: pat(), clock: () => NOW });
      received.push(Buffer.from(bytes));
      return { written: bytes.length, complete: true };
    } });
    const received: Buffer[] = [];
    expect(await send(asked.request, connection)).toMatchObject({ ok: true, state: "sent" });
    expect(cancelled).toMatchObject({ ok: false, reason: "too-late", state: "sending" });
    expect(received).toHaveLength(1);
    expect(writes).toEqual([]);
    expect(states(asked.request)).toEqual({ catalog: "sent", main: "sent" });
    expect(cancelFlexibleAnswer(store, catalog, { request: asked.request, by: pat(), clock: () => NOW })).toMatchObject({ ok: false, reason: "too-late", state: "sent" });
  });

  test("only the owner, at their generation, cancels", () => {
    const asked = decided();
    expect(cancelFlexibleAnswer(store, catalog, { request: asked.request, by: { kind: "person", name: "lee", generation: gen("lee") }, clock: () => NOW })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(cancelFlexibleAnswer(store, catalog, { request: asked.request, by: { kind: "person", name: "pat", generation: gen("pat") + 1 }, clock: () => NOW })).toMatchObject({ ok: false, reason: "stale-generation" });
    expect(cancelFlexibleAnswer(store, catalog, { request: asked.request, by: { ...pat(), kind: "model" } as never, clock: () => NOW })).toMatchObject({ ok: false, reason: "not-a-person" });
    expect(states(asked.request)).toEqual({ catalog: "decided", main: "decided" });
  });

  test("revocation: pending requests are withdrawn, answers not yet written are not-sent, a sent one is left to its ack", async () => {
    const pending = ask(), waiting = decided(), sent = decided();
    expect(await send(sent.request, scripted().connection)).toMatchObject({ ok: true });
    expect(revokeFlexibleAnswers(store, catalog, { thread: T1, turn, reason: "the turn ended", clock: () => NOW })).toEqual({ ok: true, withdrawn: 1, notSent: 1 });
    expect(states(pending.request)).toEqual({ catalog: "withdrawn", main: undefined });
    expect(states(waiting.request)).toEqual({ catalog: "not-sent", main: "not-sent" });
    expect(states(sent.request)).toEqual({ catalog: "sent", main: "sent" });
    // A withdrawn request can't be answered.
    expect(decideFlexibleAnswer(store, catalog, { request: pending.request, token: pending.token, shownDigest: pending.requestDigest, by: pat(), decision: "accept", clock: () => NOW }))
      .toMatchObject({ ok: false, reason: "already-answered", state: "withdrawn" });
  });
});

describe("acknowledgements", () => {
  test("sent without an ack times out to uncertain; a later ack doesn't revive it", async () => {
    const asked = decided();
    expect(await send(asked.request, scripted().connection)).toMatchObject({ ok: true });
    expect(expireFlexibleAnswers(store, catalog, { clock: at(FLEXIBLE_ANSWER_ACK_MS - 1) })).toEqual({ ok: true, uncertain: 0 });
    expect(states(asked.request)).toEqual({ catalog: "sent", main: "sent" });
    expect(expireFlexibleAnswers(store, catalog, { clock: at(FLEXIBLE_ANSWER_ACK_MS) })).toEqual({ ok: true, uncertain: 1 });
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
    const ref = String(raw.prepare("SELECT request_ref FROM thread_request WHERE id = ?").get(asked.request)!["request_ref"]);
    expect(ackFlexibleAnswer(store, catalog, { connection: L1, requestRef: ref, clock: at(FLEXIBLE_ANSWER_ACK_MS + 1) })).toEqual({ ok: true, delivered: false });
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
  });

  test("a sent answer whose agent launch stopped is uncertain at once", async () => {
    const asked = decided();
    expect(await send(asked.request, scripted().connection)).toMatchObject({ ok: true });
    exited(L1);
    expect(expireFlexibleAnswers(store, catalog, { clock: at(1) })).toEqual({ ok: true, uncertain: 1 });
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
  });

  test("tool activity correlating with two open answers infers no ack; with exactly one sent answer it is delivered", async () => {
    const first = ask({ correlation: "toolu_1" }), second = ask({ correlation: "toolu_1" });
    for (const one of [first, second]) {
      expect(decideFlexibleAnswer(store, catalog, { request: one.request, token: one.token, shownDigest: one.requestDigest, by: pat(), decision: "accept", clock: () => NOW })).toMatchObject({ ok: true });
      expect(await send(one.request, scripted().connection)).toMatchObject({ ok: true });
    }
    expect(noteFlexibleToolActivity(store, catalog, { connection: L1, turn, correlation: "toolu_1", clock: () => NOW })).toEqual({ ok: true, delivered: null, matched: 2 });
    expect([catalogState(first.request), catalogState(second.request)]).toEqual(["sent", "sent"]);
    // One sent and one still pending with the same correlation: still ambiguous.
    const pendingTwin = ask({ correlation: "toolu_3" }), sentOne = ask({ correlation: "toolu_3" });
    expect(decideFlexibleAnswer(store, catalog, { request: sentOne.request, token: sentOne.token, shownDigest: sentOne.requestDigest, by: pat(), decision: "accept", clock: () => NOW })).toMatchObject({ ok: true });
    expect(await send(sentOne.request, scripted().connection)).toMatchObject({ ok: true });
    expect(noteFlexibleToolActivity(store, catalog, { connection: L1, turn, correlation: "toolu_3", clock: () => NOW })).toEqual({ ok: true, delivered: null, matched: 2 });
    expect([catalogState(sentOne.request), catalogState(pendingTwin.request)]).toEqual(["sent", "pending"]);
    // Exactly one, and sent: an ack.
    const only = ask({ correlation: "toolu_9" });
    expect(decideFlexibleAnswer(store, catalog, { request: only.request, token: only.token, shownDigest: only.requestDigest, by: pat(), decision: "accept", clock: () => NOW })).toMatchObject({ ok: true });
    expect(await send(only.request, scripted().connection)).toMatchObject({ ok: true });
    expect(noteFlexibleToolActivity(store, catalog, { connection: L1, turn: tid(0xbad), correlation: "toolu_9", clock: () => NOW })).toEqual({ ok: true, delivered: null, matched: 0 });
    expect(noteFlexibleToolActivity(store, catalog, { connection: L1, turn, correlation: "toolu_9", clock: () => NOW })).toEqual({ ok: true, delivered: only.request, matched: 1 });
    expect(states(only.request)).toEqual({ catalog: "delivered", main: "delivered" });
    // A later request carrying the same correlation: the activity could be either's, so it acks neither.
    const later = ask({ correlation: "toolu_9" });
    expect(decideFlexibleAnswer(store, catalog, { request: later.request, token: later.token, shownDigest: later.requestDigest, by: pat(), decision: "accept", clock: () => NOW })).toMatchObject({ ok: true });
    expect(await send(later.request, scripted().connection)).toMatchObject({ ok: true });
    expect(noteFlexibleToolActivity(store, catalog, { connection: L1, turn, correlation: "toolu_9", clock: () => NOW })).toEqual({ ok: true, delivered: null, matched: 2 });
    expect(catalogState(later.request)).toBe("sent");
  });
});

describe("crashes and restarts", () => {
  test("a crash while queued (between sending and the write) recovers to uncertain, never to a resend", async () => {
    const asked = decided();
    const { connection, writes } = scripted(L1, { ready: () => new Promise<void>(() => { /* the process dies here */ }) });
    void send(asked.request, connection);
    await Promise.resolve();
    expect(states(asked.request)).toEqual({ catalog: "sending", main: "sending" });
    // A pending request of the same holder is withdrawn; a decision whose catalog row never left pending is not-sent.
    const pending = ask();
    const orphan = ask();
    store.handle.prepare(`INSERT INTO thread_decision (decision_id, thread, turn, request, request_ref, source, decision, request_digest, payload_digest, connection_id, state, at, by, by_generation, state_at)
      VALUES (?, ?, ?, ?, 'o', 'person', 'accept', ?, ?, ?, 'decided', ?, 'pat', ?, ?)`).run(tid(0xc0ffee), T1, turn, orphan.request, orphan.requestDigest, "2".repeat(64), L1, NOW.toISOString(), gen("pat"), NOW.toISOString());
    expect(recoverFlexibleAnswersOf(store, catalog, { holder: "h1", clock: at(5) })).toEqual({ ok: true, withdrawn: 2, uncertain: 1, notSent: 1 });
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
    expect(states(pending.request)).toEqual({ catalog: "withdrawn", main: undefined });
    expect(states(orphan.request)).toEqual({ catalog: "withdrawn", main: "not-sent" });
    const again = scripted();
    expect(await send(asked.request, again.connection)).toMatchObject({ ok: false, state: "uncertain" });
    expect([...writes, ...again.writes]).toEqual([]);
    expect(ledger().map(one => one["outcome"])).not.toContain("attempt");
  });

  test.each([
    ["after its bytes reached the receiver", "after-bytes", 1],
    ["after its attempt was committed, before any byte left", "before-bytes", 0],
  ])("a process killed %s recovers to uncertain, and the answer is never sent again", async (_when, mode, bytes) => {
    const asked = decided();
    const receiver = join(dir, "receiver.bin");
    const root = join(dir, "world");
    mkdirSync(root);
    const world = isolatedEnvironment({ root, outer: process.env });
    ownRoot(root);
    const job = { file, request: asked.request, connection: L1, now: NOW.toISOString(), receiver, mode,
      modules: { store: new URL("./store.ts", import.meta.url).href, answers: new URL("./flexible-answers.ts", import.meta.url).href } };
    const code = await new Promise<number | null>((resolve, reject) => {
      execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CRASH, JSON.stringify(job)], { cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: checkedEnv(world.env), timeout: 60_000 },
      (error, _stdout, stderr) => error === null ? reject(new Error(`the process wasn't killed: ${stderr}`)) : resolve(typeof error.code === "number" ? error.code : null));
    });
    expect(code).toBe(9);
    // What the receiver got before the process died.
    expect(existsSync(receiver) ? JSON.parse(readFileSync(receiver, "utf8")) : null).toEqual(bytes === 1 ? { ref: expect.any(String), answer: { decision: "accept" } } : null);
    // The attempt was committed in both stores before any byte left; its outcome never was.
    expect(states(asked.request)).toEqual({ catalog: "sending", main: "sending" });
    expect(store.handle.prepare("SELECT attempt_id FROM thread_decision WHERE request = ?").get(asked.request)!["attempt_id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(cancelFlexibleAnswer(store, catalog, { request: asked.request, by: pat(), clock: () => NOW })).toMatchObject({ ok: false, reason: "too-late" });
    expect(recoverFlexibleAnswersOf(store, catalog, { holder: "h1", clock: at(5) })).toMatchObject({ ok: true, uncertain: 1 });
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
    const { connection, received } = scripted();
    expect(await send(asked.request, connection)).toMatchObject({ ok: false, state: "uncertain" });
    expect(received).toEqual([]);
    expect(ledger().map(one => one["outcome"])).toEqual(["intended", "attempt", "uncertain"]);
  }, 90_000);

  test("a send that fails partway is uncertain (the receiver holds part of it), and never retried", async () => {
    const asked = decided();
    const receiver: Buffer[] = [];
    const connection: FlexibleAnswerConnection = { id: L1, frame, send: async bytes => { receiver.push(Buffer.from(bytes.subarray(0, 5))); throw new Error("EPIPE"); } };
    expect(await send(asked.request, connection)).toMatchObject({ ok: false, reason: "uncertain", state: "uncertain" });
    expect(Buffer.concat(receiver).length).toBe(5);
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
    expect(await send(asked.request, connection)).toMatchObject({ ok: false, state: "uncertain" });
    expect(Buffer.concat(receiver).length).toBe(5);
    // Part reported by the send itself: uncertain too.
    const half = decided();
    expect(await send(half.request, { id: L1, frame, send: async bytes => ({ written: Math.floor(bytes.length / 2), complete: false }) })).toMatchObject({ ok: false, state: "uncertain" });
    expect(mainState(half.request)).toBe("uncertain");
  });

  test("once its attempt is committed an answer is never not-sent, even when the send says it took nothing; framing that fails beforehand is not-sent", async () => {
    const nothing = decided();
    expect(await send(nothing.request, { id: L1, frame, send: async () => ({ written: 0, complete: false }) })).toMatchObject({ ok: false, state: "uncertain" });
    expect(states(nothing.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
    const unframed = decided();
    const sent: unknown[] = [];
    expect(await send(unframed.request, { id: L1, frame: () => { throw new Error("no form"); }, send: async bytes => { sent.push(bytes); return { written: bytes.length, complete: true }; } })).toMatchObject({ ok: false, state: "not-sent" });
    expect(states(unframed.request)).toEqual({ catalog: "not-sent", main: "not-sent" });
    expect(sent).toEqual([]);
  });

  test("a send that never settles is stopped at its deadline and is uncertain", async () => {
    const asked = decided();
    let aborted = false;
    const connection: FlexibleAnswerConnection = { id: L1, frame, send: (_bytes, { signal }) => { signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => { /* never */ }); } };
    expect(await send(asked.request, connection, () => NOW, 200)).toMatchObject({ ok: false, reason: "uncertain", state: "uncertain" });
    expect(aborted).toBe(true);
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
  });

  test("an attempt only the catalog holds (a process died between the two commits) can't be cancelled or revoked, and reconciles to uncertain", async () => {
    const asked = decided();
    void send(asked.request, scripted(L1, { ready: () => new Promise<void>(() => { /* that process is gone */ }) }).connection);
    expect(states(asked.request)).toEqual({ catalog: "sending", main: "sending" });
    raw.prepare("UPDATE thread_request SET attempt_id = ?, write_started_at = ? WHERE id = ?").run(tid(0xfeed), NOW.toISOString(), asked.request);
    expect(cancelFlexibleAnswer(store, catalog, { request: asked.request, by: pat(), clock: () => NOW })).toMatchObject({ ok: false, reason: "too-late" });
    expect(revokeFlexibleAnswers(store, catalog, { thread: T1, reason: "the turn ended", clock: () => NOW })).toEqual({ ok: true, withdrawn: 0, notSent: 0 });
    expect(expireFlexibleAnswers(store, catalog, { clock: at(FLEXIBLE_ANSWER_WRITE_MS - 1) })).toEqual({ ok: true, uncertain: 0 });
    expect(expireFlexibleAnswers(store, catalog, { clock: at(FLEXIBLE_ANSWER_WRITE_MS) })).toEqual({ ok: true, uncertain: 1 });
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
  });

  test("the catalog moved to uncertain by another process between the send and its outcome: the sender says uncertain, and so do both stores", async () => {
    const asked = decided();
    const { connection, received } = scripted(L1, { send: async bytes => {
      received.push(Buffer.from(bytes));
      // Another process's reconciler, through its own connection to the catalog.
      raw.prepare("UPDATE thread_request SET state = 'uncertain', ended_at = ?, detail = 'reconciled elsewhere' WHERE id = ?").run(NOW.toISOString(), asked.request);
      return { written: bytes.length, complete: true };
    } });
    expect(await send(asked.request, connection)).toMatchObject({ ok: false, reason: "uncertain", state: "uncertain" });
    expect(received).toHaveLength(1);
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
    expect(ledger().map(one => one["outcome"])).not.toContain("sent");
  });

  test("bytes of an uncertain answer that flush late never make it delivered, and its ack is never given to a newer answer", async () => {
    const older = ask({ correlation: "toolu_late" });
    expect(decideFlexibleAnswer(store, catalog, { request: older.request, token: older.token, shownDigest: older.requestDigest, by: pat(), decision: "accept", clock: () => NOW })).toMatchObject({ ok: true });
    let flush: ((result: { written: number; complete: boolean }) => void) | undefined;
    const late: FlexibleAnswerConnection = { id: L1, frame, send: () => new Promise(resolve => { flush = resolve; }) };
    expect(await send(older.request, late, () => NOW, 50)).toMatchObject({ ok: false, state: "uncertain" });
    // The transport finishes after all: nothing moves.
    flush!({ written: 10, complete: true });
    await Promise.resolve();
    expect(states(older.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
    const olderRef = String(raw.prepare("SELECT request_ref FROM thread_request WHERE id = ?").get(older.request)!["request_ref"]);
    expect(ackFlexibleAnswer(store, catalog, { connection: L1, requestRef: olderRef, clock: () => NOW })).toEqual({ ok: true, delivered: false });
    // A newer answer on the same connection, the same tool: the older one's ack and the shared tool activity never deliver it.
    const newer = ask({ correlation: "toolu_late" });
    expect(decideFlexibleAnswer(store, catalog, { request: newer.request, token: newer.token, shownDigest: newer.requestDigest, by: pat(), decision: "accept", clock: () => NOW })).toMatchObject({ ok: true });
    expect(await send(newer.request, scripted().connection)).toMatchObject({ ok: true, state: "sent" });
    expect(ackFlexibleAnswer(store, catalog, { connection: L1, requestRef: olderRef, clock: () => NOW })).toEqual({ ok: true, delivered: false });
    expect(noteFlexibleToolActivity(store, catalog, { connection: L1, turn, correlation: "toolu_late", clock: () => NOW })).toEqual({ ok: true, delivered: null, matched: 2 });
    expect(states(newer.request)).toEqual({ catalog: "sent", main: "sent" });
    expect(states(older.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
    // Its own ack does.
    const newerRef = String(raw.prepare("SELECT request_ref FROM thread_request WHERE id = ?").get(newer.request)!["request_ref"]);
    expect(ackFlexibleAnswer(store, catalog, { connection: L1, requestRef: newerRef, clock: () => NOW })).toEqual({ ok: true, delivered: true });
    expect(states(older.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
  });

  test("two processes, each with its own database connections, send the same answer at once: exactly one sends", async () => {
    const asked = decided();
    const root = join(dir, "world-race");
    mkdirSync(root);
    const world = isolatedEnvironment({ root, outer: process.env });
    ownRoot(root);
    const go = join(dir, "go");
    const runs = ["one", "two"].map(name => {
      const job = { file, request: asked.request, connection: L1, now: NOW.toISOString(), receiver: join(dir, `receiver-${name}.bin`), ready: join(dir, `ready-${name}`), go,
        modules: { store: new URL("./store.ts", import.meta.url).href, answers: new URL("./flexible-answers.ts", import.meta.url).href } };
      let child: ChildProcess | undefined;
      // Settled either way, so a child that fails fails this test with its own words (never an unhandled rejection).
      const done = new Promise<{ result: { ok: boolean; reason?: string; state?: string } } | { error: Error }>(resolve => {
        child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", RACE_SEND, JSON.stringify(job)], { cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: checkedEnv(world.env), timeout: 60_000 },
        (error, stdout, stderr) => resolve(error === null ? { result: JSON.parse(stdout) as { ok: boolean; reason?: string; state?: string } } : { error: new Error(`${error.message}\n${stderr}`) }));
      });
      children.push(child!);
      let ended = false;
      void done.then(() => { ended = true; });
      return { job, done, ended: () => ended };
    });
    // Both ready, or one already ended (its error is reported below). A cold tsx start on a busy runner takes seconds:
    // this waits on the processes themselves, within the test's own time limit, never a short guess.
    await until(() => runs.every(one => existsSync(one.job.ready)) || runs.some(one => one.ended()), "both processes ready, or one ended", 75_000);
    writeFileSync(go, "");
    const settled = await Promise.all(runs.map(one => one.done));
    for (const one of settled) if ("error" in one) throw one.error;
    const results = settled.map(one => (one as { result: { ok: boolean; reason?: string; state?: string } }).result);
    expect(results.filter(one => one.ok)).toEqual([{ ok: true, state: "sent", decisionId: asked.decisionId }]);
    expect(results.filter(one => !one.ok)).toEqual([expect.objectContaining({ ok: false, reason: "already-answered" })]);
    expect(runs.filter(one => existsSync(one.job.receiver))).toHaveLength(1);
    expect(states(asked.request)).toEqual({ catalog: "sent", main: "sent" });
    expect(ledger().map(one => one["outcome"])).toEqual(["intended", "attempt", "sent"]);
  }, 90_000);

  test("a real pipe nobody reads: the send stops at its deadline as uncertain, and another database writer is never blocked meanwhile", async () => {
    const reader = spawn("/bin/sleep", ["30"], { stdio: ["pipe", "ignore", "ignore"], env: {} });
    children.push(reader);
    reader.stdin!.on("error", () => { /* the reader is killed at the end */ });
    const asked = decided(), other = ask();
    const sender = streamAnswerSender(reader.stdin!);
    if (typeof sender !== "function") throw new Error(sender.message);
    const connection: FlexibleAnswerConnection = { id: L1, frame: () => Buffer.alloc(1_000_000, 0x61), send: sender };
    const began = Date.now();
    let settled = false;
    const sending = send(asked.request, connection, () => NOW, 1500).finally(() => { settled = true; });
    // The attempt is committed in both stores and the bytes are at the pipe: the send hasn't settled.
    await until(() => attemptOf(asked.request) !== null, "the attempt committed");
    expect(raw.prepare("SELECT attempt_id FROM thread_request WHERE id = ?").get(asked.request)!["attempt_id"]).toBe(attemptOf(asked.request));
    expect(settled).toBe(false);
    expect(states(asked.request)).toEqual({ catalog: "sending", main: "sending" });
    // A second connection to the database, as another Toolroll process would be: its write goes straight through.
    const second = openStore(file);
    const secondCatalog = openFlexibleAnswerCatalog(second);
    if (!secondCatalog.ok) throw new Error(secondCatalog.message);
    try {
      const writeBegan = Date.now();
      expect(revokeFlexibleAnswers(second, secondCatalog.catalog, { thread: T1, turn, reason: "the turn ended", clock: () => NOW })).toEqual({ ok: true, withdrawn: 1, notSent: 0 });
      expect(Date.now() - writeBegan).toBeLessThan(1000);
      expect(catalogState(other.request)).toBe("withdrawn");
      // The answer on the wire is past cancelling.
      expect(cancelFlexibleAnswer(second, secondCatalog.catalog, { request: asked.request, by: pat(), clock: () => NOW })).toMatchObject({ ok: false, reason: "too-late" });
      expect(settled).toBe(false);
      expect(states(asked.request)).toEqual({ catalog: "sending", main: "sending" });
    } finally { secondCatalog.catalog.close(); second.close(); }
    expect(await sending).toMatchObject({ ok: false, reason: "uncertain", state: "uncertain" });
    expect(Date.now() - began).toBeGreaterThanOrEqual(1400);
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
  }, 30_000);

  test.each([
    ["after the catalog's attempt commit, before this store's", "frame", "UPDATE thread_decision SET attempt_id", 1, 0],
    ["after the catalog's attempt commit, with every later write here failing too", "frame", "UPDATE thread_decision", Infinity, 0],
    ["after the bytes left, before any outcome is recorded", "send", "UPDATE thread_request SET state = 'sent'", 1, 1],
    ["after the bytes left, with every later write to the catalog failing too", "send", "UPDATE thread_request", Infinity, 1],
    ["between the catalog's outcome commit and this store's", "send", "UPDATE thread_decision SET state = ?, state_at = ?, detail = ? WHERE id = ? AND attempt_id", 1, 1],
    ["between the catalog's outcome commit and this store's, with every later write here failing too", "send", "UPDATE thread_decision", Infinity, 1],
  ])("a database failure %s ends uncertain, never not-sent, and nothing is sent again", async (_where, armAt, match, times, bytes) => {
    const asked = decided();
    const real = DatabaseSync.prototype.prepare;
    let armed = false, left = times;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (armed && left > 0 && sql.includes(match)) { left--; throw new Error("injected database failure"); }
      return real.call(this, sql);
    } as never);
    const received: Buffer[] = [];
    const connection: FlexibleAnswerConnection = {
      id: L1,
      frame: (ref, answer) => { if (armAt === "frame") armed = true; return frame(ref, answer); },
      send: async sent => { received.push(Buffer.from(sent)); if (armAt === "send") armed = true; return { written: sent.length, complete: true }; },
    };
    let result: unknown;
    try { result = await send(asked.request, connection); } finally { spy.mockRestore(); }
    expect(result).toMatchObject({ ok: false, state: "uncertain" });
    expect(received).toHaveLength(bytes);
    // The reconciler, once the send's deadline has passed.
    expireFlexibleAnswers(store, catalog, { clock: at(FLEXIBLE_ANSWER_WRITE_MS + 1) });
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
    expect(cancelFlexibleAnswer(store, catalog, { request: asked.request, by: pat(), clock: () => NOW })).toMatchObject({ ok: false, reason: "too-late" });
    const again = scripted();
    expect(await send(asked.request, again.connection)).toMatchObject({ ok: false });
    expect(again.received).toEqual([]);
    expect(ledger().map(one => one["outcome"])).not.toContain("not-sent");
  });

  test("records that disagree (the catalog's answer bytes changed under it) send nothing", async () => {
    const asked = decided();
    raw.exec("DROP TRIGGER thread_request_moves");
    raw.prepare(`UPDATE thread_request SET answer = '{"decision":"decline"}' WHERE id = ?`).run(asked.request);
    const { connection, writes } = scripted();
    expect(await send(asked.request, connection)).toMatchObject({ ok: false, reason: "stores-disagree", state: "not-sent" });
    expect(writes).toEqual([]);
    expect(mainState(asked.request)).toBe("not-sent");
  });
});

describe("the catalog's path", () => {
  /** A fresh store in its own folder, and where its catalog goes. */
  function another(): { store: Store; catalogFile: string; folder: string } {
    const folder = join(dir, `other-${++refs}`);
    mkdirSync(folder);
    const other = openStore(join(folder, "orders.db"));
    return { store: other, catalogFile: join(folder, "orders.db.coding.sqlite"), folder };
  }

  test("it is always beside the store's own file, made private; an in-memory store has none", () => {
    expect(catalog.file).toBe(catalogFile);
    const memory = openStore(":memory:");
    expect(openFlexibleAnswerCatalog(memory)).toMatchObject({ ok: false, reason: "catalog-unsafe" });
    memory.close();
    const fresh = another();
    const opened = openFlexibleAnswerCatalog(fresh.store);
    expect(opened).toMatchObject({ ok: true });
    if (opened.ok) opened.catalog.close();
    expect(readFileSync(fresh.catalogFile).length).toBeGreaterThan(0);
    expect((realpathSync(fresh.catalogFile) === fresh.catalogFile)).toBe(true);
    fresh.store.close();
  });

  test.each([
    ["a link at the catalog's own path", (at: { catalogFile: string; folder: string }) => { symlinkSync(join(at.folder, "elsewhere.sqlite"), at.catalogFile); }, "elsewhere.sqlite"],
    ["a link at its journal", (at: { catalogFile: string; folder: string }) => { symlinkSync(join(at.folder, "elsewhere-wal"), `${at.catalogFile}-wal`); }, "elsewhere-wal"],
    ["a second name for it (a hard link)", (at: { catalogFile: string; folder: string }) => { writeFileSync(join(at.folder, "twin"), "", { mode: 0o600 }); linkSync(join(at.folder, "twin"), at.catalogFile); }, null],
    ["a file others can read", (at: { catalogFile: string; folder: string }) => { writeFileSync(at.catalogFile, ""); chmodSync(at.catalogFile, 0o644); }, null],
  ])("%s is refused, and nothing is made or followed", (_what, plant, target) => {
    const fresh = another();
    plant(fresh);
    expect(openFlexibleAnswerCatalog(fresh.store)).toMatchObject({ ok: false, reason: "catalog-unsafe" });
    if (target !== null) expect(existsSync(join(fresh.folder, target))).toBe(false);
    fresh.store.close();
  });

  test("a folder others can change is refused: group-writable, or another user's", () => {
    const fresh = another();
    chmodSync(fresh.folder, 0o770);
    try { expect(openFlexibleAnswerCatalog(fresh.store)).toMatchObject({ ok: false, reason: "catalog-unsafe", message: expect.stringContaining("others can change its folder") }); }
    finally { chmodSync(fresh.folder, 0o700); }
    expect(existsSync(fresh.catalogFile)).toBe(false);
    // A folder above it others can change (and not sticky, as /tmp is).
    chmodSync(dir, 0o770);
    try { expect(openFlexibleAnswerCatalog(fresh.store)).toMatchObject({ ok: false, reason: "catalog-unsafe", message: expect.stringContaining(`others can change ${dir}`) }); }
    finally { chmodSync(dir, 0o700); }
    expect(existsSync(fresh.catalogFile)).toBe(false);
    // Another user's folder (this process made to see itself as another user).
    const me = process.getuid!();
    const pretend = vi.spyOn(process, "getuid").mockReturnValue(me + 1000);
    try { expect(openFlexibleAnswerCatalog(fresh.store)).toMatchObject({ ok: false, reason: "catalog-unsafe", message: expect.stringContaining("its folder is owned by another user") }); }
    finally { pretend.mockRestore(); }
    expect(existsSync(fresh.catalogFile)).toBe(false);
    const opened = openFlexibleAnswerCatalog(fresh.store);
    expect(opened).toMatchObject({ ok: true });
    if (opened.ok) opened.catalog.close();
    fresh.store.close();
  });

  test.skipIf(process.platform !== "darwin")("a folder whose ACL lets anyone add to it is refused (macOS)", () => {
    const fresh = another();
    expect(spawnSync("/bin/chmod", ["+a", "group:everyone allow add_file,write", fresh.folder]).status).toBe(0);
    try { expect(openFlexibleAnswerCatalog(fresh.store)).toMatchObject({ ok: false, reason: "catalog-unsafe", message: expect.stringContaining("its folder's ACL") }); }
    finally { spawnSync("/bin/chmod", ["-N", fresh.folder]); }
    expect(existsSync(fresh.catalogFile)).toBe(false);
    // The same ACL on a folder above the catalog's folder is refused too.
    const parent = dirname(fresh.folder);
    expect(spawnSync("/bin/chmod", ["+a", "group:everyone allow add_subdirectory,delete_child", parent]).status).toBe(0);
    try { expect(openFlexibleAnswerCatalog(fresh.store)).toMatchObject({ ok: false, reason: "catalog-unsafe", message: expect.stringContaining(`the ACL of ${parent}`) }); }
    finally { spawnSync("/bin/chmod", ["-N", parent]); }
    expect(existsSync(fresh.catalogFile)).toBe(false);
    fresh.store.close();
  });

  test("a state folder swapped for a link after the store opened is refused", () => {
    const fresh = another();
    renameSync(fresh.folder, `${fresh.folder}-moved`);
    symlinkSync(`${fresh.folder}-moved`, fresh.folder);
    expect(openFlexibleAnswerCatalog(fresh.store)).toMatchObject({ ok: false, reason: "catalog-unsafe", message: expect.stringContaining("through a link") });
    expect(existsSync(join(`${fresh.folder}-moved`, "orders.db.coding.sqlite"))).toBe(false);
    fresh.store.close();
  });

  test("a store file swapped for a link to another folder after it opened is refused", () => {
    const fresh = another();
    const elsewhere = join(dir, "elsewhere-state");
    mkdirSync(elsewhere, { mode: 0o700 });
    renameSync(join(fresh.folder, "orders.db"), join(elsewhere, "orders.db"));
    symlinkSync(join(elsewhere, "orders.db"), join(fresh.folder, "orders.db"));
    expect(openFlexibleAnswerCatalog(fresh.store)).toMatchObject({ ok: false, reason: "catalog-unsafe", message: expect.stringContaining("isn't in the store's own state folder") });
    expect(existsSync(fresh.catalogFile)).toBe(false);
    fresh.store.close();
  });

  test("a store inside a thread's folder gets no catalog", () => {
    const folder = join(dir, "threads", "c".repeat(32), "state");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const inThread = openStore(join(folder, "orders.db"));
    expect(openFlexibleAnswerCatalog(inThread)).toMatchObject({ ok: false, reason: "catalog-unsafe", message: expect.stringContaining("inside a thread's folder") });
    inThread.close();
  });

  test("a journal file that turns into a link while SQLite opens the catalog is refused after the open", () => {
    const fresh = another();
    const real = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      const done = real.call(this, sql);
      if (sql.startsWith("PRAGMA journal_mode=WAL") && !existsSync(`${fresh.catalogFile}-journal`)) symlinkSync(join(fresh.folder, "elsewhere-journal"), `${fresh.catalogFile}-journal`);
      return done;
    } as never);
    try { expect(openFlexibleAnswerCatalog(fresh.store)).toMatchObject({ ok: false, reason: "catalog-unsafe", message: expect.stringContaining("orders.db.coding.sqlite-journal") }); }
    finally { spy.mockRestore(); }
    fresh.store.close();
  });
});

describe("policy and the agent's own decisions", () => {
  test("a recorded policy only declines or cancels, is sent like an answer, and never reads as a person's", async () => {
    const asked = ask();
    expect(decideFlexibleAnswerByPolicy(store, catalog, { request: asked.request, rule: "allow-all" as never, clock: () => NOW })).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(decideFlexibleAnswerByPolicy(store, catalog, { request: asked.request, rule: "no-channel", clock: () => NOW })).toMatchObject({ ok: true });
    expect(store.handle.prepare("SELECT source, rule, decision, by, by_generation FROM thread_decision WHERE request = ?").get(asked.request))
      .toMatchObject({ source: "policy", rule: "no-channel", decision: "decline", by: "toolroll", by_generation: null });
    const { connection, writes } = scripted();
    expect(await send(asked.request, connection)).toMatchObject({ ok: true });
    expect(writes.map(one => one.answer)).toEqual([{ decision: "decline" }]);
    expect(ledger()).toEqual([{ outcome: "intended", actor: "toolroll", source: "policy" }, { outcome: "attempt", actor: "toolroll", source: "policy" }, { outcome: "sent", actor: "toolroll", source: "policy" }]);
  });

  test("the agent's own allow is recorded as the provider's, delivered, with nothing sent and no request", () => {
    expect(recordFlexibleProviderDecision(store, { thread: T1, turn, connection: L1, holder: "h1", requestRef: "toolu_5", decision: "accept", provider: "claude", clock: () => NOW })).toMatchObject({ ok: true });
    expect(store.handle.prepare("SELECT source, by, state, request FROM thread_decision").all().map(row => ({ ...row }))).toEqual([{ source: "provider", by: "provider:claude", state: "delivered", request: null }]);
    expect(recordFlexibleProviderDecision(store, { thread: T1, turn, connection: L2, holder: "h1", requestRef: "toolu_6", decision: "accept", provider: "claude", clock: () => NOW })).toMatchObject({ ok: false, reason: "connection-changed" });
  });
});

/** One of two processes sending the same answer, each with its own database connections, started together: the
 * build's constant replaced by a module hook. Its receiver is a file of its own. */
const RACE_SEND = `
const job = JSON.parse(process.argv.at(-1));
const { register } = await import("node:module");
register("data:text/javascript," + encodeURIComponent("export async function resolve(specifier, context, next) { if (/flexible-available\\\\.(js|ts)$/.test(specifier)) return { url: 'data:text/javascript,export const flexibleAvailable = () => true; export const flexibleSetting = () => ({ on: true, by: null, at: null }); export const setFlexibleSetting = () => ({ changed: false }); export const FLEXIBLE_SETTING_ACTION = null;', shortCircuit: true }; return next(specifier, context); }"));
const { existsSync, writeFileSync } = await import("node:fs");
// The test's database must already be there: a process that finds none never makes one.
if (!existsSync(job.file)) { process.stderr.write("no database at " + job.file); process.exit(3); }
const { openStore } = await import(job.modules.store);
const { openFlexibleAnswerCatalog, sendFlexibleAnswer } = await import(job.modules.answers);
const store = openStore(job.file);
const opened = openFlexibleAnswerCatalog(store);
writeFileSync(job.ready, "");
while (!existsSync(job.go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
const result = await sendFlexibleAnswer(store, opened.catalog, { request: job.request, holder: "h1", clock: () => new Date(job.now), connection: { id: job.connection,
  frame: (ref, answer) => Buffer.from(JSON.stringify({ ref, answer })),
  send: async bytes => { writeFileSync(job.receiver, bytes); return { written: bytes.length, complete: true }; } } });
opened.catalog.close();
store.close();
process.stdout.write(JSON.stringify(result));
`;

/** One holder process's send, with its own database handles: the build's constant replaced by a module hook (as
 * vi.mock does here). Its connection's send dies mid-send: after handing its bytes to the receiver (a file), or before. */
const CRASH = `
const job = JSON.parse(process.argv.at(-1));
const { register } = await import("node:module");
register("data:text/javascript," + encodeURIComponent("export async function resolve(specifier, context, next) { if (/flexible-available\\\\.(js|ts)$/.test(specifier)) return { url: 'data:text/javascript,export const flexibleAvailable = () => true; export const flexibleSetting = () => ({ on: true, by: null, at: null }); export const setFlexibleSetting = () => ({ changed: false }); export const FLEXIBLE_SETTING_ACTION = null;', shortCircuit: true }; return next(specifier, context); }"));
const { existsSync, writeFileSync } = await import("node:fs");
if (!existsSync(job.file)) { process.stderr.write("no database at " + job.file); process.exit(3); }
const { openStore } = await import(job.modules.store);
const { openFlexibleAnswerCatalog, sendFlexibleAnswer } = await import(job.modules.answers);
const store = openStore(job.file);
const opened = openFlexibleAnswerCatalog(store);
await sendFlexibleAnswer(store, opened.catalog, { request: job.request, holder: "h1", clock: () => new Date(job.now), connection: { id: job.connection,
  frame: (ref, answer) => Buffer.from(JSON.stringify({ ref, answer })),
  send: async bytes => { if (job.mode === "after-bytes") writeFileSync(job.receiver, bytes); process.exit(9); } } });
process.stdout.write("not killed");
`;
