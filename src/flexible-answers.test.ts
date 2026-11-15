/**
 * Flexible threads, slice F2d (flexible-answers.ts, v167): the answer state machine across the main database and the
 * coding catalog. Every transition and every illegal one; the single-use token; each binding (generation, owner,
 * connection, turn, card) refused when it changed, at the decision and at the write; a cancel racing a send (exactly
 * one wins); the ack timeout; an ambiguous tool event; a crash mid-send (a real process killed inside the write) that
 * recovers to uncertain and is never sent again; one decision id in both stores. Scripted connections only: no agent
 * process, no model.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openStore, type Store } from "./store.js";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, finishFlexibleTurn } from "./flexible-turns.js";
import {
  ackFlexibleAnswer, cancelFlexibleAnswer, decideFlexibleAnswer, decideFlexibleAnswerByPolicy, expireFlexibleAnswers, FLEXIBLE_ANSWER_ACK_MS, noteFlexibleToolActivity,
  openFlexibleAnswerCatalog, recordFlexibleProviderDecision, recordFlexibleRequest, recoverFlexibleAnswersOf, revokeFlexibleAnswers, sendFlexibleAnswer,
  type FlexibleAnswerCatalog, type FlexibleAnswerConnection, type FlexibleAnswerPayload, type FlexibleRequestInput,
} from "./flexible-answers.js";
import { fakePid } from "../test/fake-pid.js";

vi.mock("./flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));

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
  const opened = openFlexibleAnswerCatalog(catalogFile);
  if (!opened.ok) throw new Error(opened.message);
  catalog = opened.catalog;
  raw = new DatabaseSync(catalogFile);
});
afterEach(() => { raw.close(); catalog.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

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
    card: { title: "Allow this command?", detail: "npm test" }, clock: () => NOW, ...over });
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
/** A scripted connection standing in for the agent launch: records what it was handed. */
function scripted(id = L1, over: Partial<FlexibleAnswerConnection> = {}) {
  const writes: { ref: string; answer: FlexibleAnswerPayload }[] = [];
  const connection: FlexibleAnswerConnection = { id, write: (ref, answer) => { writes.push({ ref, answer }); return "written"; }, ...over };
  return { connection, writes };
}
const send = (request: string, connection: FlexibleAnswerConnection, clock = () => NOW) => sendFlexibleAnswer(store, catalog, { request, connection, holder: "h1", clock });
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
    expect(ledger()).toEqual([{ outcome: "intended", actor: "pat", source: "work" }, { outcome: "sent", actor: "pat", source: "work" }, { outcome: "delivered", actor: "toolroll", source: "work" }]);
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

  test("every illegal transition is refused by both stores", () => {
    const allowed: Record<string, string[]> = { pending: ["decided", "withdrawn"], decided: ["sending", "not-sent", "uncertain"], sending: ["sent", "not-sent", "uncertain"], sent: ["delivered", "uncertain"],
      delivered: [], "not-sent": [], uncertain: [], withdrawn: [] };
    const all = Object.keys(allowed);
    const final = (state: string) => !["pending", "decided", "sending", "sent"].includes(state);
    const fields = (state: string) => ({
      decision_id: state === "pending" || state === "withdrawn" ? null : tid(++refs), ended_at: final(state) ? NOW.toISOString() : null,
      sent_at: state === "sent" || state === "delivered" ? NOW.toISOString() : null,
    });
    for (const from of all) {
      for (const to of all.filter(one => one !== from)) {
        const id = tid(0x5000 + ++refs);
        const f = fields(from);
        const decided = f.decision_id === null ? [null, null, null, null, null, null, null] : [f.decision_id, "person", "accept", '{"decision":"accept"}', "2".repeat(64), "pat", NOW.toISOString()];
        raw.prepare(`INSERT INTO thread_request (id, thread, turn, connection_id, holder, owner, owner_generation, request_ref, kind, card, request_digest, token_digest, state,
          decision_id, source, decision, answer, payload_digest, decided_by, decided_at, created_at, sent_at, ended_at) VALUES (?, ?, ?, ?, 'h1', 'pat', 1, ?, 'permission', '{"title":"x"}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, T1, turn, L1, `m-${id}`, "1".repeat(64), id.padEnd(64, "0"), from, ...decided, NOW.toISOString(), f.sent_at, f.ended_at);
        const t = fields(to);
        const move = () => to === "decided"
          ? raw.prepare(`UPDATE thread_request SET state = 'decided', decision_id = ?, source = 'person', decision = 'accept', answer = '{"decision":"accept"}', payload_digest = ?, decided_by = 'pat', decided_at = ? WHERE id = ?`)
            .run(f.decision_id ?? tid(0x6000 + refs), "2".repeat(64), NOW.toISOString(), id)
          : raw.prepare("UPDATE thread_request SET state = ?, ended_at = ?, sent_at = COALESCE(sent_at, ?) WHERE id = ?").run(to, t.ended_at, t.sent_at, id);
        if (allowed[from]!.includes(to)) expect(move, `${from} → ${to}`).not.toThrow();
        else expect(move, `${from} → ${to}`).toThrow();
      }
    }
    // The main store has no pending or withdrawn: a decision is born decided.
    for (const from of all.filter(one => one !== "pending" && one !== "withdrawn")) {
      for (const to of all.filter(one => one !== from && one !== "pending" && one !== "withdrawn")) {
        const request = tid(0x7000 + ++refs);
        store.handle.prepare(`INSERT INTO thread_decision (decision_id, thread, turn, request, request_ref, source, decision, request_digest, payload_digest, connection_id, state, at, by, by_generation, state_at)
          VALUES (?, ?, ?, ?, 'r', 'person', 'accept', ?, ?, ?, 'decided', ?, 'pat', 1, ?)`).run(request, T1, turn, request, "1".repeat(64), "2".repeat(64), L1, NOW.toISOString(), NOW.toISOString());
        const road: Record<string, string[]> = { decided: [], sending: ["sending"], sent: ["sending", "!", "sent"], delivered: ["sending", "!", "sent", "delivered"], "not-sent": ["not-sent"], uncertain: ["uncertain"] };
        for (const step of road[from]!) {
          if (step === "!") store.handle.prepare("UPDATE thread_decision SET write_started_at = ? WHERE request = ?").run(NOW.toISOString(), request);
          else store.handle.prepare("UPDATE thread_decision SET state = ? WHERE request = ?").run(step, request);
        }
        const move = () => store.handle.prepare(`UPDATE thread_decision SET state = ?${to === "sent" ? ", write_started_at = COALESCE(write_started_at, 't')" : ""} WHERE request = ?`).run(to, request);
        if (allowed[from]!.includes(to)) expect(move, `main ${from} → ${to}`).not.toThrow();
        else expect(move, `main ${from} → ${to}`).toThrow();
      }
    }
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
    // Changing a person's access starts a new generation of their account.
    ["the owner's access", () => { expect(store.setAccountProjects("pat", [join(dir, "other")], "alex", NOW)).toEqual({ ok: true }); }, "stale-generation"],
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
    const base = { thread: T1, turn, connection: L1, holder: "h1", requestRef: "x", kind: "permission" as const, card: { title: "Allow?" }, clock: () => NOW };
    expect(recordFlexibleRequest(store, catalog, { ...base, holder: "h2" })).toMatchObject({ ok: false, reason: "turn-changed" });
    expect(recordFlexibleRequest(store, catalog, { ...base, connection: L2 })).toMatchObject({ ok: false, reason: "connection-changed" });
    expect(recordFlexibleRequest(store, catalog, { ...base, kind: "question" })).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM thread_request").get()!["n"]).toBe(0);
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

  test("a cancel racing a send whose write has begun loses: the answer was written once and the state says sent", async () => {
    const asked = decided();
    let cancelled: unknown;
    const writes: unknown[] = [];
    const connection: FlexibleAnswerConnection = { id: L1, write: (_ref, answer) => { cancelled = cancelFlexibleAnswer(store, catalog, { request: asked.request, by: pat(), clock: () => NOW }); writes.push(answer); return "written"; } };
    expect(await send(asked.request, connection)).toMatchObject({ ok: true, state: "sent" });
    expect(cancelled).toMatchObject({ ok: false, reason: "too-late", state: "sending" });
    expect(writes).toHaveLength(1);
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
  });

  test("a process killed inside the write recovers to uncertain, and the answer is never written again", async () => {
    const asked = decided();
    const env = { file, catalogFile, request: asked.request, connection: L1, now: NOW.toISOString(),
      modules: { store: new URL("./store.ts", import.meta.url).href, answers: new URL("./flexible-answers.ts", import.meta.url).href } };
    const code = await new Promise<number | null>((resolve, reject) => {
      execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CRASH], { cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, FLEXIBLE_CRASH: JSON.stringify(env) }, timeout: 60_000 },
      (error, _stdout, stderr) => error === null ? reject(new Error(`the process wasn't killed: ${stderr}`)) : resolve(typeof error.code === "number" ? error.code : null));
    });
    expect(code).toBe(9);
    // The write had begun when the process died: both stores still say sending (the final transaction never committed).
    expect(states(asked.request)).toEqual({ catalog: "sending", main: "sending" });
    expect(recoverFlexibleAnswersOf(store, catalog, { holder: "h1", clock: at(5) })).toMatchObject({ ok: true, uncertain: 1 });
    expect(states(asked.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
    const { connection, writes } = scripted();
    expect(await send(asked.request, connection)).toMatchObject({ ok: false, state: "uncertain" });
    expect(cancelFlexibleAnswer(store, catalog, { request: asked.request, by: pat(), clock: () => NOW })).toMatchObject({ ok: false, reason: "too-late", state: "uncertain" });
    expect(writes).toEqual([]);
    expect(ledger().map(one => one["outcome"])).toEqual(["intended", "uncertain"]);
  }, 90_000);

  test("a write that fails partway is uncertain; a connection that provably took nothing is not-sent", async () => {
    const failing = decided();
    expect(await send(failing.request, { id: L1, write: () => { throw new Error("EPIPE"); } })).toMatchObject({ ok: false, state: "uncertain" });
    expect(states(failing.request)).toEqual({ catalog: "uncertain", main: "uncertain" });
    const refused = decided();
    expect(await send(refused.request, { id: L1, write: () => "not-written" })).toMatchObject({ ok: false, state: "not-sent" });
    expect(states(refused.request)).toEqual({ catalog: "not-sent", main: "not-sent" });
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
    expect(ledger()).toEqual([{ outcome: "intended", actor: "toolroll", source: "policy" }, { outcome: "sent", actor: "toolroll", source: "policy" }]);
  });

  test("the agent's own allow is recorded as the provider's, delivered, with nothing sent and no request", () => {
    expect(recordFlexibleProviderDecision(store, { thread: T1, turn, connection: L1, holder: "h1", requestRef: "toolu_5", decision: "accept", provider: "claude", clock: () => NOW })).toMatchObject({ ok: true });
    expect(store.handle.prepare("SELECT source, by, state, request FROM thread_decision").all().map(row => ({ ...row }))).toEqual([{ source: "provider", by: "provider:claude", state: "delivered", request: null }]);
    expect(recordFlexibleProviderDecision(store, { thread: T1, turn, connection: L2, holder: "h1", requestRef: "toolu_6", decision: "accept", provider: "claude", clock: () => NOW })).toMatchObject({ ok: false, reason: "connection-changed" });
  });
});

/** One holder process's send, with its own database handles: the build's constant replaced by a module hook (as
 * vi.mock does here). Its connection's write kills the process, mid-write. */
const CRASH = `
const env = JSON.parse(process.env.FLEXIBLE_CRASH);
const { register } = await import("node:module");
register("data:text/javascript," + encodeURIComponent("export async function resolve(specifier, context, next) { if (/flexible-available\\\\.(js|ts)$/.test(specifier)) return { url: 'data:text/javascript,export const FLEXIBLE_AVAILABLE = true;', shortCircuit: true }; return next(specifier, context); }"));
const { openStore } = await import(env.modules.store);
const { openFlexibleAnswerCatalog, sendFlexibleAnswer } = await import(env.modules.answers);
const store = openStore(env.file);
const opened = openFlexibleAnswerCatalog(env.catalogFile);
await sendFlexibleAnswer(store, opened.catalog, { request: env.request, holder: "h1", clock: () => new Date(env.now), connection: { id: env.connection, write: () => process.exit(9) } });
process.stdout.write("not killed");
`;
