/** The Agents board's saved state: turn states from Claude and Codex streams under the attempt key (an earlier
 * attempt never repaints a newer one), the status file and its questions, the four-minute Stuck boundary, unread
 * Done and who is watching. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentNowForTask, agentTurnHistory, answerAgentQuestion, attemptKeyOf, holdAgentView, ingestStatus, markAgentSeen, markStuck,
  noteOpenTool, noteTranscript, openAgentQuestions, pageQuestions, QUESTION_PAGE_EVERY_MS, QUESTIONS_OVERFLOW_NOTE, recordAgentTurn, releaseAgentView,
  STUCK_AFTER_MS, TOOL_STUCK_AFTER_MS, VIEW_LEASE_MS,
  watchedPing, watchingAgent, type AgentTurn } from "./agent-board.js";
import { parseStatusLine, readStatusFile } from "./agent-pulse.js";
import { OPEN_TOOLS_CAP, toolCallsOf, turnSignalOf, withAgentTurns } from "./agent-turns.js";
import { agentFacts, agentFactsFor, agentFactsSql, agentGroupOf, agentRowOf, agentRunFingerprint, agentsBoardOf } from "./agents-board.js";
import { liveLogPath, openLiveLog, sanitizeTranscriptLine } from "./live.js";
import { looksLikeProtocolFile, statusFileName } from "./evidence.js";
import { addApprover } from "./scope.js";
import { BUILT_IN, openStore, verifiedAuthor, type Store } from "./store.js";
import { hashPairingCode, mintPairingCode, PAIRING_TTL_MS } from "./telegram.js";

const T0 = new Date("2026-10-11T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const route = (provider: string) => ({ route: { routeDigest: "legacy", phase: "build" as const, provider, model: null, chosen: "legacy" as const } });

let store: Store, taskRef: number, dir: string;
beforeEach(() => {
  store = openStore(":memory:");
  store.createTask({ id: "t-1", title: "Fix the login page" }, T0);
  taskRef = store.refFor(BUILT_IN, "t-1").id;
  store.placeTask(taskRef, "/projects/shop");
  dir = mkdtempSync(join(tmpdir(), "so-agents-"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const start = (lease: string, when = T0, provider = "claude") =>
  store.startRun({ taskRef, leaseId: lease, runner: "builder-1", branch: "feat/a", worktree: dir, provider, now: when, ...route(provider) });
const keyOf = (run: number) => attemptKeyOf(store, run)!;
/** The real observer, recording under the run's own key (as the builder wires it). */
const observer = (run: number, clock: () => Date) =>
  withAgentTurns(null, (state, when) => { recordAgentTurn(store, { run, attemptKey: keyOf(run), state, at: when }); }, clock,
    (open, when) => { noteOpenTool(store, run, keyOf(run), open, when); });
/** A protocol repair of a live build, through its own admission (on the build's claim). */
const repairOf = (parent: number, when: Date) => {
  store.handle.prepare(`INSERT OR IGNORE INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at)
    VALUES ('lease-1', ?, 1, 'builder-1', ?, ?, ?)`).run(taskRef, T0.toISOString(), at(86_400_000).toISOString(), T0.toISOString());
  const admitted = store.admitRepair({ taskRef, leaseId: "lease-1", runner: "builder-1", branch: "feat/a", worktree: dir, provider: "claude", parentRun: parent, now: when,
    route: { routeDigest: "legacy", phase: "repair", provider: "claude", model: null, chosen: "legacy" } });
  if (!admitted.ok) throw new Error(admitted.problem);
  return admitted.runId;
};
const rowOf = (run: number, when: Date, account = "alex") => agentRowOf(store, agentFactsFor(store, run, { repos: null }, account)!, when);
const states = (run: number): AgentTurn[] => agentTurnHistory(store, run).map(one => one.state);

// Canonical stream shapes, as the providers print them.
const CLAUDE = [
  { type: "system", subtype: "init", session_id: "s-1", model: "sonnet" },
  { type: "assistant", message: { content: [{ type: "text", text: "Reading the form handler." }, { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "src/login.ts" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "…" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "tu-2", name: "Edit", input: {} }] } },
  { type: "result", subtype: "success", is_error: false, session_id: "s-1", result: "Done." },
];
const CODEX = [
  { type: "thread.started", thread_id: "th-1" },
  { type: "turn.started" },
  { type: "item.started", item: { id: "i-1", type: "command_execution", command: "npm test", status: "in_progress" } },
  { type: "item.completed", item: { id: "i-1", type: "command_execution", command: "npm test", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "i-2", type: "agent_message", text: "Fixed." } },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
];

describe("turn states from the output stream", () => {
  test("each provider's events read as busy or idle; everything else says nothing", () => {
    expect(CLAUDE.map(turnSignalOf)).toEqual(["busy", "busy", "busy", "busy", "idle"]);
    expect(CODEX.map(turnSignalOf)).toEqual(["busy", "busy", "busy", "busy", "busy", "idle"]);
    expect(turnSignalOf({ type: "turn.failed", error: { message: "rate limited" } })).toBe("idle");
    expect(turnSignalOf({ type: "rate_limit_event" })).toBeNull();
    expect(turnSignalOf({ type: "system", subtype: "compact_boundary" })).toBeNull();
  });

  test("a Codex build records busy then idle; one that exits mid-turn records crashed", () => {
    const run = start("lease-1", T0, "codex");
    const turns = observer(run, () => T0);
    for (const event of CODEX) turns.observe(event);
    turns.ended();
    expect(states(run)).toEqual(["busy", "idle"]);

    store.finishRun(run, { outcome: "failed", reason: "agent", now: at(1000) });
    const next = start("lease-2", at(2000), "codex");
    const cut = observer(next, () => at(3000));
    for (const event of CODEX.slice(0, 3)) cut.observe(event);
    cut.ended();
    expect(states(next)).toEqual(["busy", "crashed"]);
    expect(agentNowForTask(store, taskRef)).toMatchObject({ run: next, state: "crashed" });
    // Crashed is final for that attempt: a stray late event changes nothing.
    cut.observe({ type: "turn.completed" });
    expect(states(next)).toEqual(["busy", "crashed"]);
  });

  test("a process that ends before it says anything crashed", () => {
    const run = start("lease-1");
    const turns = observer(run, () => T0);
    turns.ended();
    expect(states(run)).toEqual(["crashed"]);
  });

  test("a state from an earlier attempt never overwrites a newer one, whichever arrives first", () => {
    const first = start("lease-1");
    const early = observer(first, () => at(1000));
    early.observe(CLAUDE[0]!);
    store.finishRun(first, { outcome: "interrupted", reason: "replaced", now: at(2000) });
    const second = start("lease-2", at(3000));
    const late = observer(second, () => at(4000));
    late.observe(CLAUDE[0]!);
    expect(agentNowForTask(store, taskRef)).toMatchObject({ run: second, state: "busy" });

    // The earlier attempt's result arrives after the newer one started: kept as its own history, never shown.
    early.observe(CLAUDE[4]!);
    early.ended();
    expect(states(first)).toEqual(["busy", "idle"]);
    expect(agentNowForTask(store, taskRef)).toMatchObject({ run: second, attemptKey: keyOf(second), state: "busy" });

    // A forged or mistaken key on the newer run moves nothing either.
    expect(recordAgentTurn(store, { run: second, attemptKey: keyOf(first), state: "idle", at: at(5000) })).toBe(false);
    expect(agentNowForTask(store, taskRef)?.state).toBe("busy");
    // The newer attempt itself still moves it.
    late.observe(CLAUDE[4]!);
    expect(agentNowForTask(store, taskRef)).toMatchObject({ run: second, state: "idle" });
  });

  test("a run admitted before the board has no key and records nothing", () => {
    const run = start("lease-1");
    store.handle.prepare("UPDATE run SET attempt_key = NULL WHERE id = ?").run(run);
    expect(attemptKeyOf(store, run)).toBeNull();
    const key = ["0f1e", "2d3c", "4b5a", "6978"].join("");
    expect(recordAgentTurn(store, { run, attemptKey: key, state: "busy", at: T0 })).toBe(false);
    expect(states(run)).toEqual([]);
  });

  test("each provider's tool calls open and close by id; anything else opens nothing", () => {
    const bash = { type: "assistant", message: { content: [{ type: "tool_use", id: "tu-9", name: "Bash", input: { command: "npm test" } }] } };
    expect(toolCallsOf(bash)).toEqual({ opened: [{ id: "tu-9", kind: "command" }], closed: [] });
    expect(toolCallsOf(CLAUDE[1]!)).toEqual({ opened: [{ id: "tu-1", kind: "tool" }], closed: [] });
    expect(toolCallsOf(CLAUDE[2]!)).toEqual({ opened: [], closed: ["tu-1"] });
    expect(toolCallsOf(CODEX[2]!)).toEqual({ opened: [{ id: "i-1", kind: "command" }], closed: [] });
    expect(toolCallsOf(CODEX[3]!)).toEqual({ opened: [], closed: ["i-1"] });
    for (const nothing of [CODEX[4]!, CLAUDE[4]!, { type: "item.started", item: { id: "i-2", type: "reasoning" } }, { type: "item.started", item: { id: "i-3", type: "toString" } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }, { type: "user", message: { content: "plain" } }]) {
      expect(toolCallsOf(nothing)).toEqual({ opened: [], closed: [] });
    }
  });

  test("a Claude build saves its open command until the call answers; the turn's result closes every call", () => {
    const run = start("lease-1");
    let now = T0;
    const turns = observer(run, () => now);
    turns.observe(CLAUDE[0]!);
    now = at(1000);
    turns.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-9", name: "Bash", input: { command: "npm test" } }] } });
    expect(agentNowForTask(store, taskRef)).toMatchObject({ state: "busy", toolKind: "command", toolAt: at(1000).toISOString() });
    now = at(300_000);
    turns.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-9", content: "ok" }] } });
    // Its answer is the stream moving: the quiet clock starts again from it.
    expect(agentNowForTask(store, taskRef)).toMatchObject({ toolKind: null, toolAt: null, transcriptAt: at(300_000).toISOString() });
    turns.observe(CLAUDE[3]!);
    expect(agentNowForTask(store, taskRef)?.toolKind).toBe("tool");
    turns.observe(CLAUDE[4]!);
    expect(agentNowForTask(store, taskRef)).toMatchObject({ state: "idle", toolKind: null, toolAt: null });
  });

  test("a Codex build saves its open command until the item completes; a process that ends mid-call closes it", () => {
    const run = start("lease-1", T0, "codex");
    const turns = observer(run, () => T0);
    for (const event of CODEX.slice(0, 3)) turns.observe(event);
    expect(agentNowForTask(store, taskRef)).toMatchObject({ state: "busy", toolKind: "command", toolAt: T0.toISOString() });
    turns.observe(CODEX[3]!);
    expect(agentNowForTask(store, taskRef)?.toolKind).toBeNull();
    turns.observe(CODEX[2]!);
    expect(agentNowForTask(store, taskRef)?.toolKind).toBe("command");
    turns.ended();
    expect(agentNowForTask(store, taskRef)).toMatchObject({ state: "crashed", toolKind: null, toolAt: null });
  });

  test("open calls are bounded, and an earlier attempt's calls never repaint a newer attempt", () => {
    const run = start("lease-1");
    const turns = observer(run, () => T0);
    turns.observe(CLAUDE[0]!);
    const many = Array.from({ length: OPEN_TOOLS_CAP + 10 }, (_, i) => ({ type: "tool_use", id: `tu-${i}`, name: "Read", input: {} }));
    turns.observe({ type: "assistant", message: { content: many } });
    // Only the first OPEN_TOOLS_CAP were held: answering those leaves none open.
    turns.observe({ type: "user", message: { content: many.slice(0, OPEN_TOOLS_CAP).map(one => ({ type: "tool_result", tool_use_id: one.id })) } });
    expect(agentNowForTask(store, taskRef)?.toolKind).toBeNull();

    store.finishRun(run, { outcome: "interrupted", reason: "replaced", now: at(1000) });
    const next = start("lease-2", at(2000));
    recordAgentTurn(store, { run: next, attemptKey: keyOf(next), state: "busy", at: at(2000) });
    expect(noteOpenTool(store, run, keyOf(run), { kind: "command", at: at(3000) }, at(3000))).toBe(false);
    expect(noteOpenTool(store, next, keyOf(run), { kind: "command", at: at(3000) }, at(3000))).toBe(false);
    expect(agentNowForTask(store, taskRef)).toMatchObject({ run: next, toolKind: null, transcriptAt: at(2000).toISOString() });
  });
});

describe("the agent's status file", () => {
  test("only the four known shapes are read, and their words are sanitized and bounded", () => {
    expect(parseStatusLine('{"status":"working","note":"Rewriting the form handler"}')).toEqual({ status: "working", note: "Rewriting the form handler" });
    expect(parseStatusLine('{"status":"needs-decision","key":"Keep-OAuth","question":"Keep the old OAuth button?"}'))
      .toEqual({ status: "needs-decision", key: "keep-oauth", question: "Keep the old OAuth button?" });
    expect(parseStatusLine('{"status":"needs-decision","key":"bad key!","question":"?"}')).toBeNull();
    expect(parseStatusLine('{"status":"needs-decision","key":"k"}')).toBeNull();
    expect(parseStatusLine('{"status":"celebrating"}')).toBeNull();
    expect(parseStatusLine("not json")).toBeNull();
    expect(parseStatusLine('["working"]')).toBeNull();
    const long = parseStatusLine(JSON.stringify({ status: "blocked", note: "x".repeat(500) }));
    expect(long?.status === "blocked" && long.note!.length).toBe(200);
    const secret = ["sk", "ant", "api03", "A".repeat(40)].join("-");
    expect(parseStatusLine(JSON.stringify({ status: "working", note: `token ${secret}` }))).toEqual({ status: "working", note: "[a credential-shaped line was redacted]" });
  });

  test("reads forward through complete lines only; a replaced or linked file is refused", () => {
    const path = join(dir, statusFileName());
    writeFileSync(path, '{"status":"working","note":"one"}\n{"status":"blo');
    const first = readStatusFile(path, 0);
    expect(first).toEqual({ ok: true, read: { lines: [{ status: "working", note: "one" }], nextOffset: 34 } });
    appendFileSync(path, 'cked","note":"two"}\n');
    expect(readStatusFile(path, 34)).toMatchObject({ ok: true, read: { lines: [{ status: "blocked", note: "two" }] } });
    writeFileSync(path, "");
    expect(readStatusFile(path, 34)).toEqual({ ok: false, reason: "replaced" });
    const link = join(dir, statusFileName());
    symlinkSync(path, link);
    expect(readStatusFile(link, 0)).toEqual({ ok: false, reason: "unreadable" });
  });

  test("its name is protocol-shaped (swept, never committed)", () => {
    const name = statusFileName();
    expect(name).toMatch(/^STANDING-ORDERS-STATUS-[0-9a-f]{16}\.jsonl$/);
    expect(looksLikeProtocolFile(name)).toBe(true);
    expect(looksLikeProtocolFile("STANDING-ORDERS-STATUS-notes.jsonl")).toBe(false);
  });

  test("a needs-decision opens its key once, pages once, and moves only forward", () => {
    const run = start("lease-1");
    recordAgentTurn(store, { run, attemptKey: keyOf(run), state: "busy", at: T0 });
    const ask = { status: "needs-decision" as const, key: "keep-oauth", question: "Keep the old OAuth button?" };
    expect(ingestStatus(store, run, keyOf(run), { lines: [ask, { status: "working", note: "styling the form" }], nextOffset: 90 }, at(1000)))
      .toEqual({ asked: ["keep-oauth"], moved: true });
    // The same offset again, or the same key again, changes nothing.
    expect(ingestStatus(store, run, keyOf(run), { lines: [ask], nextOffset: 90 }, at(2000)).asked).toEqual([]);
    expect(ingestStatus(store, run, keyOf(run), { lines: [ask], nextOffset: 140 }, at(3000)).asked).toEqual([]);
    expect(openAgentQuestions(store, taskRef).map(one => one.key)).toEqual(["keep-oauth"]);
    expect(store.listNotifications("all").filter(one => one.kind === "agent-question")).toHaveLength(1);
    expect(agentNowForTask(store, taskRef)).toMatchObject({ said: "working", saidNote: "styling the form", statusOffset: 140 });
  });
});

describe("bidi controls", () => {
  test("never survive into a transcript line, a question or a note, saved or shown", () => {
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map(code => String.fromCodePoint(code)).join("");
    const hasBidi = (text: unknown) => /[\u202a-\u202e\u2066-\u2069]/u.test(String(text));
    expect(sanitizeTranscriptLine(`Edited ${bidi}login.ts`)).toBe("Edited login.ts");
    expect(parseStatusLine(JSON.stringify({ status: "needs-decision", key: "keep-oauth", question: `Keep the ${bidi}button?` })))
      .toEqual({ status: "needs-decision", key: "keep-oauth", question: "Keep the button?" });
    expect(parseStatusLine(JSON.stringify({ status: "blocked", note: `waiting${bidi} on CI` }))).toEqual({ status: "blocked", note: "waiting on CI" });

    // Saved through the status file the agent appends to.
    const run = start("lease-1");
    recordAgentTurn(store, { run, attemptKey: keyOf(run), state: "busy", at: T0 });
    const path = join(dir, statusFileName());
    writeFileSync(path, `${JSON.stringify({ status: "needs-decision", key: "keep-oauth", question: `Keep ${bidi}it?` })}\n${JSON.stringify({ status: "working", note: `styling${bidi}` })}\n`);
    const read = readStatusFile(path, 0);
    if (!read.ok) throw new Error(read.reason);
    ingestStatus(store, run, keyOf(run), read.read, at(1000));
    expect(openAgentQuestions(store, taskRef).map(one => one.question)).toEqual(["Keep it?"]);
    expect(agentNowForTask(store, taskRef)?.saidNote).toBe("styling");
    expect(hasBidi(JSON.stringify(store.handle.prepare("SELECT question FROM agent_question UNION ALL SELECT said_note FROM agent_now").all()))).toBe(false);

    // Saved through the live transcript the board reads.
    const log = openLiveLog(dir, run)!;
    log.observe({ type: "assistant", message: { content: [{ type: "text", text: `Reading ${bidi}the form handler` }] } });
    log.close();
    const saved = readFileSync(liveLogPath(dir, run), "utf8");
    expect(saved).toContain("Reading the form handler");
    expect(hasBidi(saved)).toBe(false);
  });
});

describe("Reply", () => {
  const file = (task: string, note: string) => store.fileSteerNote(task, verifiedAuthor("alex"), note, at(5000));
  const asked = (run: number) => {
    recordAgentTurn(store, { run, attemptKey: keyOf(run), state: "busy", at: T0 });
    ingestStatus(store, run, keyOf(run), { lines: [{ status: "needs-decision", key: "keep-oauth", question: "Keep the old OAuth button?" }], nextOffset: 10 }, T0);
    return openAgentQuestions(store, taskRef)[0]!.id;
  };

  test("files the answer as a verified steering note and closes exactly that key", () => {
    const run = start("lease-1");
    const id = asked(run);
    ingestStatus(store, run, keyOf(run), { lines: [{ status: "needs-decision", key: "copy", question: "Which button label?" }], nextOffset: 20 }, T0);
    const answered = answerAgentQuestion(store, { question: id, answer: "Keep it for now.", author: "alex", at: at(5000), file });
    expect(answered).toMatchObject({ ok: true, key: "keep-oauth" });
    expect(store.listSteerNotes(taskRef).map(one => one.note)).toEqual(['Reply to your question "keep-oauth": Keep it for now.']);
    expect(openAgentQuestions(store, taskRef).map(one => one.key)).toEqual(["copy"]);
    // The run keeps going, and a second reply to the same key is refused.
    expect(store.getRun(run)?.outcome).toBeNull();
    expect(answerAgentQuestion(store, { question: id, answer: "again", author: "alex", at: at(6000), file })).toEqual({ ok: false, reason: "closed" });
    expect(store.listNotifications("all").find(one => one.dedupeKey === `agent-question:${run}:keep-oauth`)?.resolvedAt).toBe(at(5000).toISOString());
  });

  test("refuses a stale attempt or an empty answer, saving nothing", () => {
    const run = start("lease-1");
    const id = asked(run);
    expect(answerAgentQuestion(store, { question: id, answer: "  ", author: "alex", at: at(1), file })).toMatchObject({ ok: false, reason: "invalid-answer" });
    // A newer attempt on the same task: the earlier one's question is no longer the one to answer.
    start("lease-2", at(2));
    expect(answerAgentQuestion(store, { question: id, answer: "yes", author: "alex", at: at(3), file })).toEqual({ ok: false, reason: "stale" });
    expect(store.listSteerNotes(taskRef)).toEqual([]);
  });

  test("an attempt that ends closes its open questions unanswered", () => {
    const run = start("lease-1");
    const id = asked(run);
    store.finishRun(run, { outcome: "built", committed: true, now: at(1000) });
    expect(openAgentQuestions(store, taskRef)).toEqual([]);
    expect(answerAgentQuestion(store, { question: id, answer: "yes", author: "alex", at: at(2000), file })).toEqual({ ok: false, reason: "closed" });
  });
});

describe("questions from an untrusted agent", () => {
  const file = (task: string, note: string) => store.fileSteerNote(task, verifiedAuthor("alex"), note, at(1));
  const ask = (key: string) => ({ status: "needs-decision" as const, key, question: `Question ${key}?` });
  let offset = 0;
  const ingest = (run: number, keys: string[], when: Date) => ingestStatus(store, run, keyOf(run), { lines: keys.map(ask), nextOffset: offset += 100 }, when);
  const counts = (run: number) => store.handle.prepare("SELECT count(*) AS total, coalesce(sum(closed_at IS NULL), 0) AS open FROM agent_question WHERE run = ?").get(run)!;
  const pages = () => store.listNotifications("all").filter(one => one.kind === "agent-question");
  const answerAll = (when: Date) => {
    for (const one of openAgentQuestions(store, taskRef)) {
      expect(answerAgentQuestion(store, { question: one.id, answer: "Yes.", author: "alex", at: when, file })).toMatchObject({ ok: true });
    }
  };
  const busy = (run: number) => { recordAgentTurn(store, { run, attemptKey: keyOf(run), state: "busy", at: T0 }); return run; };
  const note = (run: number) => agentFactsFor(store, run, { repos: null }, "alex")!.questionNote;
  beforeEach(() => { offset = 0; });

  test("50 distinct keys from one run open at most 3 at a time and 10 in all; the board's note is set once", () => {
    const run = busy(start("lease-1"));
    const keys = Array.from({ length: 50 }, (_, index) => `q-${index}`);
    const first = ingest(run, keys.slice(0, 5), T0);
    expect(first.asked).toEqual(["q-0", "q-1", "q-2"]);
    expect(note(run)).toBe(QUESTIONS_OVERFLOW_NOTE);
    // Past the cap, a line is no question and no page, and the note is not written again.
    expect(ingest(run, ["q-5"], at(1000))).toEqual({ asked: [], moved: false });
    for (let index = 6; index < 50; index += 4) {
      answerAll(at(index * 1000));
      ingest(run, keys.slice(index, index + 4), at(index * 1000));
      expect(Number(counts(run)["open"])).toBeLessThanOrEqual(3);
    }
    expect(Number(counts(run)["total"])).toBe(10);
    expect(note(run)).toBe(QUESTIONS_OVERFLOW_NOTE);
    // All inside one page window: one page reached anyone (the first three arrived together, so it counts them).
    expect(pages().map(one => one.body)).toEqual(["3 questions waiting"]);
    // An honest run never sees the note.
    const other = busy(start("lease-2", at(60_000)));
    ingest(other, ["only-one"], at(61_000));
    expect(note(other)).toBeNull();
  });

  test("at most one page per run in five minutes; the next page says how many are waiting", () => {
    expect(QUESTION_PAGE_EVERY_MS).toBe(5 * 60_000);
    const run = busy(start("lease-1"));
    ingest(run, ["first"], T0);
    ingest(run, ["second"], at(60_000));
    // Both are open on the board; only the first paged.
    expect(openAgentQuestions(store, taskRef).map(one => one.key)).toEqual(["first", "second"]);
    expect(pages()).toHaveLength(1);
    expect(pageQuestions(store, run, keyOf(run), at(QUESTION_PAGE_EVERY_MS - 1))).toBe(false);
    expect(pages()).toHaveLength(1);
    // The beat after the window: one summary page, linking to the run.
    expect(pageQuestions(store, run, keyOf(run), at(QUESTION_PAGE_EVERY_MS))).toBe(true);
    expect(pages()).toHaveLength(2);
    expect(pages().find(one => one.dedupeKey !== `agent-question:${run}:first`)).toMatchObject({
      subject: "Fix the login page: the agent has questions", body: "2 questions waiting", pushClass: "attention", link: `/agents?run=${run}` });
    // Nothing new waits, so no further page; the summary resolves once every question is answered.
    expect(pageQuestions(store, run, keyOf(run), at(3 * QUESTION_PAGE_EVERY_MS))).toBe(false);
    answerAll(at(3 * QUESTION_PAGE_EVERY_MS));
    expect(pages().every(one => one.resolvedAt !== null)).toBe(true);
    // A question asked well after the window pages at once again, on its own.
    ingest(run, ["third"], at(4 * QUESTION_PAGE_EVERY_MS));
    expect(pages().map(one => one.dedupeKey)).toContain(`agent-question:${run}:third`);
  });

  test("answering a question frees a slot under the open cap", () => {
    const run = busy(start("lease-1"));
    expect(ingest(run, ["a", "b", "c", "d"], T0).asked).toEqual(["a", "b", "c"]);
    expect(ingest(run, ["e"], at(1000)).asked).toEqual([]);
    const first = openAgentQuestions(store, taskRef)[0]!;
    expect(answerAgentQuestion(store, { question: first.id, answer: "Yes.", author: "alex", at: at(2000), file })).toMatchObject({ ok: true });
    expect(ingest(run, ["e", "f"], at(3000)).asked).toEqual(["e"]);
    expect(openAgentQuestions(store, taskRef).map(one => one.key)).toEqual(["b", "c", "e"]);
  });

  test("a new attempt starts a fresh ten, without the earlier attempt's note", () => {
    const run = busy(start("lease-1"));
    for (let round = 0; round < 4; round++) {
      ingest(run, [0, 1, 2].map(index => `r${round}-${index}`), at(round * 1000));
      answerAll(at(round * 1000 + 500));
    }
    expect(Number(counts(run)["total"])).toBe(10);
    expect(ingest(run, ["one-more"], at(10_000)).asked).toEqual([]);
    expect(note(run)).toBe(QUESTIONS_OVERFLOW_NOTE);
    const next = busy(start("lease-2", at(20_000)));
    expect(keyOf(next)).not.toBe(keyOf(run));
    offset = 0;
    expect(ingest(next, ["one-more", "r0-0", "x"], at(21_000)).asked).toEqual(["one-more", "r0-0", "x"]);
    expect(note(next)).toBeNull();
  });
});

describe("Stuck", () => {
  test("a busy run shows Stuck at exactly four minutes without new transcript or activity, and not a moment before", () => {
    const run = start("lease-1");
    const key = keyOf(run);
    recordAgentTurn(store, { run, attemptKey: key, state: "busy", at: T0 });
    const group = (when: Date) => agentGroupOf(agentFactsFor(store, run, { repos: null }, "alex")!, store.runActivity(run).at, when).group;

    expect(markStuck(store, run, key, at(STUCK_AFTER_MS - 1000))).toBe(false);
    expect(group(at(STUCK_AFTER_MS - 1000))).toBe("working");
    expect(markStuck(store, run, key, at(STUCK_AFTER_MS))).toBe(true);
    expect(agentNowForTask(store, taskRef)?.stuckAt).toBe(at(STUCK_AFTER_MS).toISOString());
    expect(group(at(STUCK_AFTER_MS))).toBe("stuck");

    // New transcript bytes clear it at once.
    expect(noteTranscript(store, run, key, 120, at(STUCK_AFTER_MS + 10_000))).toBe(true);
    expect(agentNowForTask(store, taskRef)?.stuckAt).toBeNull();
    expect(group(at(STUCK_AFTER_MS + 10_000))).toBe("working");

    // So does new activity: recorded activity resets the clock.
    store.recordRunActivity(run, "command", at(2 * STUCK_AFTER_MS));
    expect(markStuck(store, run, key, at(2 * STUCK_AFTER_MS + 60_000))).toBe(false);
    expect(group(at(3 * STUCK_AFTER_MS - 1000))).toBe("working");
    expect(group(at(3 * STUCK_AFTER_MS))).toBe("stuck");

    // An idle agent is never Stuck, however long it waits; while its build is still open it is checking the result.
    recordAgentTurn(store, { run, attemptKey: key, state: "idle", at: at(3 * STUCK_AFTER_MS + 1) });
    expect(markStuck(store, run, key, at(10 * STUCK_AFTER_MS))).toBe(false);
    expect(group(at(10 * STUCK_AFTER_MS))).toBe("working");
  });
});

describe("Stuck with a tool call open, and fresh activity", () => {
  test("an open command stays Working, saying so, until fifteen minutes of silence", () => {
    const run = start("lease-1");
    const key = keyOf(run);
    recordAgentTurn(store, { run, attemptKey: key, state: "busy", at: T0 });
    noteOpenTool(store, run, key, { kind: "command", at: T0 }, T0);
    expect(rowOf(run, at(5 * 60_000))).toMatchObject({ group: "working", label: "Working", line: "Running a command · 5 min" });
    expect(markStuck(store, run, key, at(5 * 60_000))).toBe(false);
    expect(rowOf(run, at(TOOL_STUCK_AFTER_MS - 1000))).toMatchObject({ group: "working", line: "Running a command · 14 min" });
    expect(markStuck(store, run, key, at(TOOL_STUCK_AFTER_MS - 1000))).toBe(false);
    expect(markStuck(store, run, key, at(TOOL_STUCK_AFTER_MS))).toBe(true);
    expect(rowOf(run, at(TOOL_STUCK_AFTER_MS))).toMatchObject({ group: "stuck", label: "Stuck", line: "No new output for 15 min" });

    // The command answers: that clears Stuck at once, and the ordinary four minutes apply again.
    noteOpenTool(store, run, key, null, at(TOOL_STUCK_AFTER_MS + 1000));
    expect(agentNowForTask(store, taskRef)?.stuckAt).toBeNull();
    expect(rowOf(run, at(TOOL_STUCK_AFTER_MS + 2000)).group).toBe("working");
    expect(rowOf(run, at(TOOL_STUCK_AFTER_MS + 1000 + STUCK_AFTER_MS)).group).toBe("stuck");
  });

  test("with no call open, four minutes of silence is Stuck; fresh activity clears the saved mark in its own write, before any pulse", () => {
    const run = start("lease-1");
    const key = keyOf(run);
    recordAgentTurn(store, { run, attemptKey: key, state: "busy", at: T0 });
    expect(markStuck(store, run, key, at(STUCK_AFTER_MS))).toBe(true);
    const before = agentRunFingerprint(store, run);
    store.recordRunActivity(run, "command", at(STUCK_AFTER_MS + 5000));
    expect(agentNowForTask(store, taskRef)?.stuckAt).toBeNull();
    expect(agentRunFingerprint(store, run)).not.toBe(before);
    expect(rowOf(run, at(STUCK_AFTER_MS + 6000)).group).toBe("working");
  });
});

describe("a build checking its result", () => {
  test("an open build whose turn has its result stays Working while it captures and checks it", () => {
    const run = start("lease-1");
    recordAgentTurn(store, { run, attemptKey: keyOf(run), state: "busy", at: T0 });
    recordAgentTurn(store, { run, attemptKey: keyOf(run), state: "idle", at: at(1000) });
    for (const phase of ["validating-handoff", "capturing-evidence", "verifying-proof"] as const) {
      store.setRunPhase(run, phase, at(2000));
      expect(rowOf(run, at(60 * 60_000))).toMatchObject({ group: "working", label: "Working", line: "Checking the result" });
    }
    expect(agentsBoardOf(store, at(60 * 60_000), { repos: null }, "alex").map(group => group.key)).toEqual(["working"]);
  });
});

describe("a repair run", () => {
  test("never takes its parent's row: while it runs, the parent says Fixing the handoff and keeps its own transcript", () => {
    const parent = start("lease-1");
    const key = keyOf(parent);
    recordAgentTurn(store, { run: parent, attemptKey: key, state: "busy", at: T0 });
    ingestStatus(store, parent, key, { lines: [{ status: "needs-decision", key: "keep-oauth", question: "Keep it?" }], nextOffset: 10 }, T0);
    noteTranscript(store, parent, key, 4096, at(1000));
    recordAgentTurn(store, { run: parent, attemptKey: key, state: "idle", at: at(2000) });
    const before = agentRunFingerprint(store, parent);
    const repair = repairOf(parent, at(3000));
    // The parent's open view hears the repair start.
    expect(agentRunFingerprint(store, parent)).not.toBe(before);
    const board = agentsBoardOf(store, at(4000), { repos: null }, "alex");
    expect(board.flatMap(group => group.rows)).toHaveLength(1);
    expect(board).toMatchObject([{ key: "needs-you", rows: [{ runId: parent, href: `/agents?run=${parent}` }] }]);
    // A repair is the parent's own activity, never a newer attempt: the parent's question can still be answered.
    const id = openAgentQuestions(store, taskRef)[0]!.id;
    expect(answerAgentQuestion(store, { question: id, answer: "Keep it.", author: "alex", at: at(4500),
      file: (task, note) => store.fileSteerNote(task, verifiedAuthor("alex"), note, at(4500)) }).ok).toBe(true);
    expect(agentsBoardOf(store, at(5000), { repos: null }, "alex")).toMatchObject([{ key: "working", rows: [{ runId: parent, label: "Working", line: "Fixing the handoff" }] }]);
    // Opening the repair opens its parent; the repair writes nothing over the parent's snapshot.
    expect(agentFactsFor(store, repair, { repos: null }, "alex")?.runId).toBe(parent);
    expect(recordAgentTurn(store, { run: repair, attemptKey: keyOf(repair), state: "busy", at: at(6000) })).toBe(false);
    expect(agentNowForTask(store, taskRef)).toMatchObject({ run: parent, attemptKey: key, transcriptBytes: 4096, state: "idle" });
    // A late event from the parent still moves its own row.
    expect(recordAgentTurn(store, { run: parent, attemptKey: key, state: "busy", at: at(7000) })).toBe(true);
  });

  test("a failed repair under a parent that finished built leaves the parent Done", () => {
    const parent = start("lease-1");
    recordAgentTurn(store, { run: parent, attemptKey: keyOf(parent), state: "busy", at: T0 });
    const repair = repairOf(parent, at(1000));
    store.finishRun(repair, { outcome: "failed", reason: "no-handoff", now: at(2000) });
    store.finishRun(parent, { outcome: "built", committed: true, now: at(3000) });
    expect(agentsBoardOf(store, at(4000), { repos: null }, "alex")).toMatchObject([{ key: "done", rows: [{ runId: parent, label: "Done" }] }]);
  });

  test("a built repair under a parent that parked leaves the parent's own outcome", () => {
    const parent = start("lease-1");
    recordAgentTurn(store, { run: parent, attemptKey: keyOf(parent), state: "busy", at: T0 });
    const repair = repairOf(parent, at(1000));
    store.finishRun(repair, { outcome: "built", committed: true, now: at(2000) });
    store.finishRun(parent, { outcome: "parked", reason: "decision:1", now: at(3000) });
    expect(agentsBoardOf(store, at(4000), { repos: null }, "alex")).toMatchObject([{ key: "needs-you", rows: [{ runId: parent, label: "Needs a decision" }] }]);
  });
});

describe("the board's query", () => {
  test("finds each task's newest open or recent build through its indexes, with no correlated MAX over every run", () => {
    const old = new Date(T0.getTime() - 10 * 86_400_000);
    const expected = new Map<number, number>();
    for (let n = 2; n <= 40; n++) {
      const id = `t-${n}`;
      store.createTask({ id, title: `Task ${n}` }, old);
      const ref = store.refFor(BUILT_IN, id).id;
      store.placeTask(ref, "/projects/shop");
      for (let k = 0; k < 3; k++) {
        const run = store.startRun({ taskRef: ref, leaseId: `l-${n}-${k}`, runner: "builder-1", branch: `b-${n}`, worktree: dir, provider: "claude", now: old, ...route("claude") });
        store.finishRun(run, { outcome: "failed", reason: "agent", now: old });
      }
      const last = store.startRun({ taskRef: ref, leaseId: `l-${n}-last`, runner: "builder-1", branch: `b-${n}`, worktree: dir, provider: "claude", now: at(-60_000), ...route("claude") });
      // Every third is still open, every fifth finished recently; the rest finished long ago and stay off the board.
      if (n % 3 === 0) expected.set(ref, last);
      else if (n % 5 === 0) { store.finishRun(last, { outcome: "failed", reason: "agent", now: at(-30_000) }); expected.set(ref, last); }
      else store.finishRun(last, { outcome: "failed", reason: "agent", now: old });
    }
    const found = agentFacts(store, T0, { repos: null }, "alex");
    expect(new Map(found.map(one => [one.taskRef, one.runId]))).toEqual(expected);

    const plan = store.handle.prepare(`EXPLAIN QUERY PLAN ${agentFactsSql()}`)
      .all({ $account: "alex", $kept: at(-3 * 86_400_000).toISOString(), $all: 1, $repos: "[]" }).map(row => String(row["detail"]));
    expect(plan.some(step => step.includes("agent_board_open"))).toBe(true);
    expect(plan.some(step => step.includes("agent_board_recent"))).toBe(true);
    // Never a plain scan of the run table.
    expect(plan.filter(step => /^SCAN (run|r|x|p)\b/.test(step) && !/INDEX/.test(step))).toEqual([]);
  });
});

describe("the board", () => {
  test("groups agents in order, and Done stays unread until this person opens it", () => {
    const run = start("lease-1");
    recordAgentTurn(store, { run, attemptKey: keyOf(run), state: "busy", at: T0 });
    expect(agentsBoardOf(store, at(1000), { repos: null }, "alex").map(group => group.key)).toEqual(["working"]);
    ingestStatus(store, run, keyOf(run), { lines: [{ status: "needs-decision", key: "keep-oauth", question: "Keep the old OAuth button?" }], nextOffset: 10 }, at(1000));
    const asking = agentsBoardOf(store, at(2000), { repos: null }, "alex");
    expect(asking).toMatchObject([{ key: "needs-you", rows: [{ runId: run, label: "Question", line: "Keep the old OAuth button?", project: "shop", href: `/agents?run=${run}` }] }]);

    store.finishRun(run, { outcome: "built", committed: true, now: at(60_000) });
    expect(agentsBoardOf(store, at(61_000), { repos: null }, "alex")).toMatchObject([{ key: "done", rows: [{ label: "Done", endedAt: at(60_000).toISOString() }] }]);
    markAgentSeen(store, "alex", run, at(62_000));
    expect(agentsBoardOf(store, at(63_000), { repos: null }, "alex").map(group => group.key)).toEqual(["idle"]);
    // Someone else has not seen it yet.
    expect(agentsBoardOf(store, at(63_000), { repos: null }, "blair").map(group => group.key)).toEqual(["done"]);
    // Another person's projects never show it.
    expect(agentsBoardOf(store, at(63_000), { repos: ["/projects/other"] }, "blair")).toEqual([]);
  });

  test("a run from before the board is never unread Done", () => {
    const run = start("lease-1");
    store.handle.prepare("UPDATE run SET attempt_key = NULL WHERE id = ?").run(run);
    store.finishRun(run, { outcome: "built", committed: true, now: at(1000) });
    expect(agentsBoardOf(store, at(2000), { repos: null }, "alex").map(group => group.key)).toEqual(["idle"]);
  });
});

describe("who is watching", () => {
  const ask = (run: number) => {
    recordAgentTurn(store, { run, attemptKey: keyOf(run), state: "busy", at: T0 });
    ingestStatus(store, run, keyOf(run), { lines: [{ status: "needs-decision", key: "keep-oauth", question: "Keep it?" }], nextOffset: 10 }, T0);
    return store.listNotifications("all").find(one => one.kind === "agent-question")!;
  };
  const view = ["v", "1".repeat(23)].join("");

  test("a watch on the exact run holds that person's question until about 20 s after its last keep-alive, then sends it", () => {
    const run = start("lease-1");
    const ping = ask(run);
    holdAgentView(store, view, "alex", run, T0);
    expect(VIEW_LEASE_MS).toBe(20_000);
    expect(watchingAgent(store, "alex", run, at(1000))).toBe(true);
    expect(watchedPing(store, ping, "alex", at(1000))).toEqual({ hold: at(VIEW_LEASE_MS).toISOString() });
    // A watch is temporary, never one of the permanent quiet rules; and it is that person's and that run's alone.
    expect(store.pingAllowed(ping, "alex")).toBe(true);
    expect(watchedPing(store, ping, "blair", at(1000))).toBe("send");
    expect(watchingAgent(store, "alex", run + 1, at(1000))).toBe(false);
    // A keep-alive moves the hold along; once it lapses the still-open question goes.
    holdAgentView(store, view, "alex", run, at(15_000));
    expect(watchedPing(store, ping, "alex", at(30_000))).toEqual({ hold: at(15_000 + VIEW_LEASE_MS).toISOString() });
    expect(watchedPing(store, ping, "alex", at(15_000 + VIEW_LEASE_MS))).toBe("send");
    // Closing the page ends the watch at once.
    holdAgentView(store, view, "alex", run, at(50_000));
    releaseAgentView(store, view, at(51_000));
    expect(watchedPing(store, ping, "alex", at(52_000))).toBe("send");
  });

  test("a finished run's ping held during a watch goes afterwards only if that person has not seen it", () => {
    const run = start("lease-1");
    recordAgentTurn(store, { run, attemptKey: keyOf(run), state: "busy", at: T0 });
    holdAgentView(store, view, "alex", run, at(1000));
    store.finishRun(run, { outcome: "built", committed: true, now: at(2000) });
    const finished = store.listNotifications("all").find(one => one.kind === "run-finished" && one.run === run)!;
    expect(watchedPing(store, finished, "alex", at(3000))).toEqual({ hold: at(1000 + VIEW_LEASE_MS).toISOString() });
    expect(watchedPing(store, finished, "alex", at(30_000))).toBe("send");
    markAgentSeen(store, "alex", run, at(31_000));
    expect(watchedPing(store, finished, "alex", at(32_000))).toBe("skip");
    expect(watchedPing(store, finished, "blair", at(32_000))).toBe("send");
  });

  test("a phone's push pair waits pending while watched, then sends; a run seen meanwhile retires it unsent", () => {
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver");
    store.enrollPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "B".repeat(87), auth: "a".repeat(22), approver: "alex", approverGeneration: 1,
      uaWords: "a phone", vapidFingerprint: "fp-1" } as Parameters<Store["enrollPushSubscription"]>[0], T0);
    const pairs = () => store.handle.prepare("SELECT n.kind, p.state, p.next_attempt_at, p.last_error FROM push_delivery p JOIN notification n ON n.id = p.notification ORDER BY p.id").all();
    const run = start("lease-1", at(1000));
    holdAgentView(store, view, "alex", run, at(1000));
    const ping = ask(run);
    expect(store.seedPushPairs(at(2000))).toBe(1);
    expect(pairs()).toEqual([{ kind: ping.kind, state: "pending", next_attempt_at: at(1000 + VIEW_LEASE_MS).toISOString(), last_error: null }]);
    expect(store.claimPushPairs("sender", 60_000, 10, at(5000))).toEqual([]);
    // Still watched when it falls due: held on, never sent and never retired.
    holdAgentView(store, view, "alex", run, at(15_000));
    expect(store.claimPushPairs("sender", 60_000, 10, at(1000 + VIEW_LEASE_MS))).toEqual([]);
    expect(pairs()[0]).toMatchObject({ state: "pending", next_attempt_at: at(15_000 + VIEW_LEASE_MS).toISOString() });
    // The watch lapses with the question still open: it goes.
    expect(store.claimPushPairs("sender", 60_000, 10, at(15_000 + VIEW_LEASE_MS))).toHaveLength(1);

    // The run fails while watched (an attention-class failure pushes); the person opens its result before the watch ends: retired unsent.
    holdAgentView(store, view, "alex", run, at(40_000));
    store.finishRun(run, { outcome: "failed", reason: "agent", now: at(41_000) });
    store.enqueueNotification({ source: { run }, dedupeKey: `run:${run}:failed`, kind: "build-failed", pushClass: "attention", subject: "t-1: attempt failed", body: "The agent failed." }, at(41_000));
    store.seedPushPairs(at(42_000));
    expect(pairs().find(one => one["kind"] === "build-failed")).toMatchObject({ state: "pending", next_attempt_at: at(40_000 + VIEW_LEASE_MS).toISOString() });
    markAgentSeen(store, "alex", run, at(43_000));
    expect(store.claimPushPairs("sender", 60_000, 10, at(40_000 + VIEW_LEASE_MS))).toEqual([]);
    expect(pairs().find(one => one["kind"] === "build-failed")).toMatchObject({ state: "retired", last_error: "seen" });
  });

  test("a held Telegram delivery stays unsettled, then is claimed after the watch, unless the question was answered", () => {
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver");
    store.setNotificationPreference("alex", { mode: "all" }, "alex", T0);
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, T0);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: "777000", chatId: "4242", userId: "31337", updateId: 1 }, T0).ok).toBe(true);
    const binding = store.liveTelegramBinding("777000")!;
    const run = start("lease-1", at(1000));
    store.resolveEpisodes("life", at(1000));
    holdAgentView(store, view, "alex", run, at(1000));
    const ping = ask(run);
    const mine = (when: Date) => store.claimTelegramDeliveries(binding, "owner", 1_000, when).filter(one => one.id === ping.id);
    expect(mine(at(2000))).toEqual([]);
    const receipt = () => store.handle.prepare("SELECT receipt, delivered_at, next_attempt_at FROM notification_delivery WHERE notification = ?").get(ping.id);
    expect(receipt()).toEqual({ receipt: null, delivered_at: null, next_attempt_at: at(1000 + VIEW_LEASE_MS).toISOString() });
    expect(mine(at(1000 + VIEW_LEASE_MS))).toHaveLength(1);

    // A second question (past the first's page window), answered while it was held: resolved, so never sent.
    const later = QUESTION_PAGE_EVERY_MS;
    ingestStatus(store, run, keyOf(run), { lines: [{ status: "needs-decision", key: "copy", question: "Which label?" }], nextOffset: 20 }, at(later + 30_000));
    holdAgentView(store, view, "alex", run, at(later + 30_000));
    const second = store.listNotifications("all").find(one => one.dedupeKey === `agent-question:${run}:copy`)!;
    expect(store.claimTelegramDeliveries(binding, "owner", 1_000, at(later + 31_000)).map(one => one.id)).not.toContain(second.id);
    const id = openAgentQuestions(store, taskRef).find(one => one.key === "copy")!.id;
    expect(answerAgentQuestion(store, { question: id, answer: "Save", author: "alex", at: at(later + 32_000), file: (task, note) => store.fileSteerNote(task, verifiedAuthor("alex"), note, at(later + 32_000)) }).ok).toBe(true);
    expect(store.claimTelegramDeliveries(binding, "owner", 1_000, at(later + 30_000 + VIEW_LEASE_MS)).map(one => one.id)).not.toContain(second.id);
  });
});
