/**
 * The Agents board's saved state (one place to check on running agents).
 *
 * Every builder run is admitted with an opaque attempt key (run.attempt_key).
 * The stream observer (agent-turns.ts) records each turn change — busy, idle,
 * crashed — as one append-only agent_turn row, and moves the task's current
 * snapshot (agent_now) only when the writer is the task's newest build
 * attempt AND presents that run's own key: a late event from an earlier or
 * replaced attempt is kept as history and never repaints the row. A protocol
 * repair (role 'repair') mends its parent build and never owns the row: the
 * board shows it as the parent's own activity ("Fixing the handoff").
 * The same stream says which tool calls are open, so a long command reads
 * as Working (Stuck only after TOOL_STUCK_AFTER_MS) rather than as silence.
 *
 * The rest rides the build's existing minute pulse (agent-pulse.ts): the
 * transcript's size, the changed-file count, the agent's own status lines
 * (working, needs-decision, blocked, done) and the four-minute Stuck mark.
 * A needs-decision line is an agent_question; Reply closes exactly that key
 * and files the answer as an ordinary verified steering note, which the
 * steering mailbox delivers to the running agent.
 *
 * Who has seen a finished run (agent_seen) makes Done "not viewed yet"; who
 * is watching a run right now (agent_view, short leases kept by the open
 * page's live stream) holds that person's Needs you and Done pings: they stay
 * pending in their delivery ledgers and go out once the watch lapses, only
 * if the question is still open or the run still unseen (watchedPing).
 * Display state, never evidence: nothing here changes a run's outcome.
 */
import { randomBytes } from "node:crypto";
import type { Store } from "./store.js";

export type AgentTurn = "busy" | "idle" | "crashed";
export const AGENT_TURNS: readonly AgentTurn[] = ["busy", "idle", "crashed"];
export type AgentSaid = "working" | "blocked" | "done";

/** A busy run whose transcript and activity are both this old is Stuck. */
export const STUCK_AFTER_MS = 4 * 60_000;
/** With a tool call still open (a long test run is silent), it is Stuck only after this long. */
export const TOOL_STUCK_AFTER_MS = 15 * 60_000;
/** A page's watch on one run lapses this long after its last keep-alive (the stream's keep-alive is every 15 s). */
export const VIEW_LEASE_MS = 20_000;
export const QUESTION_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const QUESTION_MAX = 300;
export const NOTE_MAX = 200;
export const ANSWER_MAX = 1500;
/** An agent is untrusted: at most this many of its questions are open at once per run… */
export const QUESTIONS_OPEN_MAX = 3;
/** …and at most this many are ever opened per attempt. A needs-decision past either opens nothing and pages no one. */
export const QUESTIONS_PER_ATTEMPT = 10;
/** At most one question page per run in this long; questions asked meanwhile wait for the next page. */
export const QUESTION_PAGE_EVERY_MS = 5 * 60_000;
/** The board's one note on a run whose agent asked past the caps (set once). */
export const QUESTIONS_OVERFLOW_NOTE = "The agent asked more questions than the board takes; see its transcript.";

export const AGENT_BOARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_turn (
  id          INTEGER PRIMARY KEY,
  run         INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  attempt_key TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('busy','idle','crashed')),
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_turn_run ON agent_turn (run, id);
CREATE TABLE IF NOT EXISTS agent_now (
  task_ref         INTEGER PRIMARY KEY REFERENCES task_ref(id) ON DELETE CASCADE,
  run              INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  attempt_key      TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('busy','idle','crashed')),
  state_at         TEXT NOT NULL,
  transcript_bytes INTEGER NOT NULL DEFAULT 0,
  transcript_at    TEXT NOT NULL,
  stuck_at         TEXT,
  said             TEXT CHECK (said IN ('working','blocked','done')),
  said_note        TEXT,
  said_at          TEXT,
  status_offset    INTEGER NOT NULL DEFAULT 0,
  diff_files       INTEGER,
  diff_at          TEXT
);
CREATE TABLE IF NOT EXISTS agent_question (
  id          INTEGER PRIMARY KEY,
  run         INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  task_ref    INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  attempt_key TEXT NOT NULL,
  key         TEXT NOT NULL,
  question    TEXT NOT NULL,
  asked_at    TEXT NOT NULL,
  closed_at   TEXT,
  closed_how  TEXT CHECK (closed_how IN ('answered','ended')),
  answer_note INTEGER REFERENCES task_steer(id),
  answered_by TEXT,
  UNIQUE (run, key)
);
CREATE INDEX IF NOT EXISTS agent_question_open ON agent_question (task_ref) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS agent_seen (
  account TEXT NOT NULL,
  run     INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (account, run)
);
CREATE TABLE IF NOT EXISTS agent_view (
  view       TEXT PRIMARY KEY,
  account    TEXT NOT NULL,
  run        INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_view_run ON agent_view (run, account);
CREATE INDEX IF NOT EXISTS agent_board_open ON run (task_ref, id) WHERE role = 'builder' AND outcome IS NULL;
CREATE INDEX IF NOT EXISTS agent_board_recent ON run (finished_at, task_ref, id) WHERE role = 'builder' AND outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_board_repair ON run (parent_run, id) WHERE role = 'repair';
`;
/** Added to agent_now after the table first shipped (store.ts addColumn): the oldest open tool call's kind and start. */
export const AGENT_NOW_COLUMNS: readonly [string, string][] = [["tool_kind", "TEXT"], ["tool_at", "TEXT"],
  // The questions cap's note (set once), and the last question page: when it went and the newest question it covered.
  ["question_note", "TEXT"], ["paged_at", "TEXT"], ["paged_upto", "INTEGER"]];

/** Unpredictable per attempt: the run row is the only place it is written down. */
export function mintAttemptKey(): string {
  return randomBytes(12).toString("hex");
}

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value);

/** A run's attempt key; null for a run admitted before the board existed (or no such run). */
export function attemptKeyOf(store: Store, run: number): string | null {
  const row = store.handle.prepare("SELECT attempt_key FROM run WHERE id = ?").get(run);
  return row === undefined ? null : text(row["attempt_key"]);
}

/** The task's newest build attempt: a repair mends its parent and never stands in for it. */
export const NEWEST_BUILDER = (task: string) => `(SELECT MAX(id) FROM run n WHERE n.task_ref = ${task} AND n.role = 'builder')`;

/** The build attempt a run belongs to on the board: a repair's parent, otherwise itself. */
export function boardRunOf(store: Store, run: number): number {
  const row = store.handle.prepare("SELECT role, parent_run FROM run WHERE id = ?").get(run);
  return row !== undefined && row["role"] === "repair" && row["parent_run"] != null ? Number(row["parent_run"]) : run;
}

/** The writer's own run, proved: it exists, carries exactly this key, and is the task's newest build attempt. */
function provedRun(store: Store, run: number, attemptKey: string): { taskRef: number; newest: boolean } | null {
  const row = store.handle.prepare(`SELECT r.task_ref, r.attempt_key, ${NEWEST_BUILDER("r.task_ref")} AS newest
    FROM run r WHERE r.id = ?`).get(run);
  if (row === undefined || row["attempt_key"] === null || String(row["attempt_key"]) !== attemptKey) return null;
  return { taskRef: Number(row["task_ref"]), newest: Number(row["newest"]) === run };
}

/** The current snapshot moves only for the same attempt, or a strictly newer run; never back. */
const SAME_ATTEMPT = "agent_now.run = ?2 AND agent_now.attempt_key = ?3";

export type TurnFact = { run: number; attemptKey: string; state: AgentTurn; at: Date };

/**
 * Record one turn change. Always appended to the run's own history (under its
 * key); the task's current snapshot moves only when this run is the task's
 * newest and is not already newer-owned. Returns whether the snapshot moved.
 */
export function recordAgentTurn(store: Store, fact: TurnFact): boolean {
  return store.transact(() => {
    const proved = provedRun(store, fact.run, fact.attemptKey);
    if (proved === null) return false;
    const at = fact.at.toISOString();
    store.handle.prepare("INSERT INTO agent_turn (run, attempt_key, state, at) VALUES (?, ?, ?, ?)").run(fact.run, fact.attemptKey, fact.state, at);
    if (!proved.newest) return false;
    const moved = store.handle.prepare(`INSERT INTO agent_now (task_ref, run, attempt_key, state, state_at, transcript_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT (task_ref) DO UPDATE SET
        state = excluded.state, state_at = excluded.state_at,
        stuck_at = CASE WHEN excluded.state = 'busy' AND agent_now.state = 'busy' THEN agent_now.stuck_at ELSE NULL END,
        run = excluded.run, attempt_key = excluded.attempt_key,
        transcript_at = CASE WHEN ${SAME_ATTEMPT} THEN agent_now.transcript_at ELSE excluded.transcript_at END,
        transcript_bytes = CASE WHEN ${SAME_ATTEMPT} THEN agent_now.transcript_bytes ELSE 0 END,
        said = CASE WHEN ${SAME_ATTEMPT} THEN agent_now.said END,
        said_note = CASE WHEN ${SAME_ATTEMPT} THEN agent_now.said_note END,
        said_at = CASE WHEN ${SAME_ATTEMPT} THEN agent_now.said_at END,
        status_offset = CASE WHEN ${SAME_ATTEMPT} THEN agent_now.status_offset ELSE 0 END,
        diff_files = CASE WHEN ${SAME_ATTEMPT} THEN agent_now.diff_files END,
        diff_at = CASE WHEN ${SAME_ATTEMPT} THEN agent_now.diff_at END,
        tool_kind = CASE WHEN ${SAME_ATTEMPT} AND excluded.state = 'busy' THEN agent_now.tool_kind END,
        tool_at = CASE WHEN ${SAME_ATTEMPT} AND excluded.state = 'busy' THEN agent_now.tool_at END,
        question_note = CASE WHEN ${SAME_ATTEMPT} THEN agent_now.question_note END,
        paged_at = CASE WHEN ${SAME_ATTEMPT} THEN agent_now.paged_at END,
        paged_upto = CASE WHEN ${SAME_ATTEMPT} THEN agent_now.paged_upto END
      WHERE agent_now.run < excluded.run OR (${SAME_ATTEMPT} AND agent_now.state <> excluded.state)`)
      .run(proved.taskRef, fact.run, fact.attemptKey, fact.state, at);
    return Number(moved.changes) > 0;
  });
}

/** One run's turn history, oldest first. */
export function agentTurnHistory(store: Store, run: number): { attemptKey: string; state: AgentTurn; at: string }[] {
  return store.handle.prepare("SELECT attempt_key, state, at FROM agent_turn WHERE run = ? ORDER BY id").all(run)
    .map(row => ({ attemptKey: String(row["attempt_key"]), state: String(row["state"]) as AgentTurn, at: String(row["at"]) }));
}

export type AgentNow = {
  taskRef: number; run: number; attemptKey: string; state: AgentTurn; stateAt: string;
  transcriptBytes: number; transcriptAt: string; stuckAt: string | null;
  said: AgentSaid | null; saidNote: string | null; saidAt: string | null;
  statusOffset: number; diffFiles: number | null; diffAt: string | null;
  /** The oldest tool call still open (a command, or any other tool), and when it started; null when none is. */
  toolKind: ToolKind | null; toolAt: string | null;
  /** QUESTIONS_OVERFLOW_NOTE once the agent asked past the caps; null otherwise. */
  questionNote: string | null;
  /** The last question page: when it went, and the newest question it covered. */
  pagedAt: string | null; pagedUpto: number;
};
export type ToolKind = "command" | "tool";

function readNow(row: Row): AgentNow {
  return {
    taskRef: Number(row["task_ref"]), run: Number(row["run"]), attemptKey: String(row["attempt_key"]), state: String(row["state"]) as AgentTurn,
    stateAt: String(row["state_at"]), transcriptBytes: Number(row["transcript_bytes"] ?? 0), transcriptAt: String(row["transcript_at"]),
    stuckAt: text(row["stuck_at"]), said: text(row["said"]) as AgentSaid | null, saidNote: text(row["said_note"]), saidAt: text(row["said_at"]),
    statusOffset: Number(row["status_offset"] ?? 0), diffFiles: row["diff_files"] == null ? null : Number(row["diff_files"]), diffAt: text(row["diff_at"]),
    toolKind: text(row["tool_kind"]) as ToolKind | null, toolAt: text(row["tool_at"]),
    questionNote: text(row["question_note"]), pagedAt: text(row["paged_at"]), pagedUpto: Number(row["paged_upto"] ?? 0),
  };
}

/** The task's current snapshot, whichever run owns it. */
export function agentNowForTask(store: Store, taskRef: number): AgentNow | null {
  const row = store.handle.prepare("SELECT * FROM agent_now WHERE task_ref = ?").get(taskRef);
  return row === undefined ? null : readNow(row);
}

/** The snapshot this attempt owns, or null when another (newer) attempt does or none was recorded. */
export function agentNowForRun(store: Store, run: number, attemptKey: string): AgentNow | null {
  const row = store.handle.prepare("SELECT * FROM agent_now WHERE run = ? AND attempt_key = ?").get(run, attemptKey);
  return row === undefined ? null : readNow(row);
}

/** Fields the pulse may move, for the attempt that owns the snapshot only. */
function updateOwned(store: Store, run: number, attemptKey: string, set: string, values: unknown[]): boolean {
  const moved = store.handle.prepare(`UPDATE agent_now SET ${set} WHERE run = ? AND attempt_key = ?`).run(...values, run, attemptKey);
  return Number(moved.changes) > 0;
}

/** The pulse saw the live transcript's size: new bytes are news, and news is not Stuck. */
export function noteTranscript(store: Store, run: number, attemptKey: string, bytes: number, at: Date): boolean {
  const now = agentNowForRun(store, run, attemptKey);
  if (now === null || now.transcriptBytes === bytes) return false;
  return updateOwned(store, run, attemptKey, "transcript_bytes = ?, transcript_at = ?, stuck_at = NULL", [bytes, at.toISOString()]);
}

/** The changed-file count the pulse observed (null: it could not look). */
export function noteDiff(store: Store, run: number, attemptKey: string, files: number | null, at: Date): boolean {
  const now = agentNowForRun(store, run, attemptKey);
  if (now === null || now.diffFiles === files) return false;
  return updateOwned(store, run, attemptKey, "diff_files = ?, diff_at = ?", [files, at.toISOString()]);
}

/** The stream opened or closed a tool call: the oldest still open, or null. The stream moved, so it clears Stuck. */
export function noteOpenTool(store: Store, run: number, attemptKey: string, open: { kind: ToolKind; at: Date } | null, at: Date): boolean {
  return updateOwned(store, run, attemptKey, "tool_kind = ?, tool_at = ?, transcript_at = max(transcript_at, ?), stuck_at = NULL",
    [open?.kind ?? null, open === null ? null : open.at.toISOString(), at.toISOString()]);
}

/** When the agent last showed a sign of life: its turn, transcript, recorded activity or the tool it opened. */
export function quietSince(now: Pick<AgentNow, "stateAt" | "transcriptAt"> & { toolAt?: string | null }, activityAt: string | null): number {
  return Math.max(...[now.stateAt, now.transcriptAt, activityAt, now.toolAt ?? null].filter((one): one is string => one !== null).map(one => Date.parse(one)));
}

/**
 * Stuck, from saved facts and the clock alone (no model, no tokens): busy, and
 * neither the transcript, the recorded activity nor the turn itself has moved
 * for STUCK_AFTER_MS — or for TOOL_STUCK_AFTER_MS while a tool call is open.
 */
export function stuckSince(now: Pick<AgentNow, "state" | "stateAt" | "transcriptAt"> & { toolAt?: string | null }, activityAt: string | null, clock: Date): string | null {
  if (now.state !== "busy") return null;
  const latest = quietSince(now, activityAt);
  const after = (now.toolAt ?? null) === null ? STUCK_AFTER_MS : TOOL_STUCK_AFTER_MS;
  const quiet = clock.getTime() - latest;
  return Number.isFinite(quiet) && quiet >= after ? new Date(latest + after).toISOString() : null;
}

/** The newest recorded activity of a run: its last kind, or its newest progress checkpoint. */
function activityAtOf(store: Store, run: number): string | null {
  const row = store.handle.prepare(`SELECT max(coalesce((SELECT at FROM run_activity WHERE run = ?1), ''),
      coalesce((SELECT created_at FROM run_checkpoint WHERE run = ?1 ORDER BY id DESC LIMIT 1), '')) AS at`).get(run);
  const at = row === undefined ? "" : String(row["at"] ?? "");
  return at === "" ? null : at;
}

/** The pulse persists the Stuck crossing (and its clearing), so open boards hear it through /live. */
export function markStuck(store: Store, run: number, attemptKey: string, clock: Date): boolean {
  const now = agentNowForRun(store, run, attemptKey);
  if (now === null) return false;
  const stuck = stuckSince(now, activityAtOf(store, run), clock);
  if ((stuck === null) === (now.stuckAt === null)) return false;
  return updateOwned(store, run, attemptKey, "stuck_at = ?", [stuck]);
}

// ---- status lines ---------------------------------------------------------

export type StatusLine =
  | { status: "working" | "blocked" | "done"; note: string | null }
  | { status: "needs-decision"; key: string; question: string };

export type StatusIngest = { lines: StatusLine[]; nextOffset: number };

/**
 * The agent's status lines since the saved offset, for the attempt that owns
 * the snapshot. The offset only moves forward; a needs-decision opens its key
 * once (a key already asked this run is never reopened), within the caps:
 * QUESTIONS_OPEN_MAX open at once and QUESTIONS_PER_ATTEMPT in all. One past
 * either opens nothing and pages no one; the run gets QUESTIONS_OVERFLOW_NOTE,
 * once. New questions page the people the task reaches (pageQuestions).
 */
export function ingestStatus(store: Store, run: number, attemptKey: string, read: StatusIngest, at: Date): { asked: string[]; moved: boolean } {
  return store.transact(() => {
    const now = agentNowForRun(store, run, attemptKey);
    if (now === null || read.nextOffset <= now.statusOffset) return { asked: [], moved: false };
    const iso = at.toISOString();
    const asked: string[] = [];
    let said: { status: AgentSaid; note: string | null } | null = null;
    let overflow = false;
    const known = store.handle.prepare("SELECT 1 AS hit FROM agent_question WHERE run = ? AND key = ?");
    const counts = store.handle.prepare(`SELECT count(*) AS total, coalesce(sum(closed_at IS NULL), 0) AS open
      FROM agent_question WHERE run = ? AND attempt_key = ?`);
    for (const line of read.lines) {
      if (line.status === "needs-decision") {
        if (known.get(run, line.key) !== undefined) continue;
        const count = counts.get(run, attemptKey)!;
        if (Number(count["open"]) >= QUESTIONS_OPEN_MAX || Number(count["total"]) >= QUESTIONS_PER_ATTEMPT) { overflow = true; continue; }
        store.handle.prepare(`INSERT INTO agent_question (run, task_ref, attempt_key, key, question, asked_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(run, now.taskRef, attemptKey, line.key, line.question, iso);
        asked.push(line.key);
      } else {
        said = line;
      }
    }
    updateOwned(store, run, attemptKey, said === null ? "status_offset = ?" : "status_offset = ?, said = ?, said_note = ?, said_at = ?",
      said === null ? [read.nextOffset] : [read.nextOffset, said.status, said.note, iso]);
    const noted = overflow && now.questionNote === null && updateOwned(store, run, attemptKey, "question_note = ?", [QUESTIONS_OVERFLOW_NOTE]);
    pageQuestions(store, run, attemptKey, at);
    return { asked, moved: said !== null || asked.length > 0 || noted };
  });
}

/**
 * Page the run's open questions no page has covered yet, at most once per
 * QUESTION_PAGE_EVERY_MS. A question asked outside that window, alone, pages
 * at once with its own words; questions asked inside it wait, and the next
 * page after the window says how many are waiting. The pulse calls this every
 * beat, so the waiting ones go out when the window ends.
 */
export function pageQuestions(store: Store, run: number, attemptKey: string, at: Date): boolean {
  const due = () => {
    const now = agentNowForRun(store, run, attemptKey);
    if (now === null) return null;
    const lastPage = now.pagedAt === null ? null : Date.parse(now.pagedAt);
    if (lastPage !== null && at.getTime() - lastPage < QUESTION_PAGE_EVERY_MS) return null;
    const rows = store.handle.prepare(`SELECT q.id, q.key, q.question, q.asked_at, t.title
      FROM agent_question q JOIN task_ref r ON r.id = q.task_ref JOIN task t ON t.id = r.external_id
      WHERE q.run = ? AND q.attempt_key = ? AND q.closed_at IS NULL ORDER BY q.id`).all(run, attemptKey);
    const waiting = rows.filter(row => Number(row["id"]) > now.pagedUpto);
    return waiting.length === 0 ? null : { lastPage, rows, waiting };
  };
  // Read first: most beats have nothing waiting, and need no write.
  if (due() === null) return false;
  return store.transact(() => {
    const found = due();
    if (found === null) return false;
    const { lastPage, rows, waiting } = found;
    const newest = waiting[waiting.length - 1]!;
    const title = String(newest["title"]);
    const alone = waiting.length === 1 && (lastPage === null || Date.parse(String(newest["asked_at"])) >= lastPage + QUESTION_PAGE_EVERY_MS);
    const page = { kind: "agent-question", pushClass: "attention" as const, link: `/agents?run=${run}`, source: { run } };
    if (alone) {
      store.enqueueNotification({ ...page, dedupeKey: `agent-question:${run}:${String(newest["key"])}`,
        subject: `${title}: the agent has a question`, body: String(newest["question"]) }, at);
    } else {
      // "~" never starts a question key, so this never takes a question's own dedupe key.
      store.enqueueNotification({ ...page, dedupeKey: `agent-question:${run}:~${Number(newest["id"])}`,
        subject: `${title}: the agent has questions`, body: questionsWaiting(rows.length) }, at);
    }
    updateOwned(store, run, attemptKey, "paged_at = ?, paged_upto = ?", [at.toISOString(), Number(newest["id"])]);
    return true;
  });
}

export const questionsWaiting = (count: number): string => `${count} ${count === 1 ? "question" : "questions"} waiting`;

export type AgentQuestion = { id: number; run: number; taskRef: number; key: string; question: string; askedAt: string };
const readQuestion = (row: Row): AgentQuestion => ({ id: Number(row["id"]), run: Number(row["run"]), taskRef: Number(row["task_ref"]),
  key: String(row["key"]), question: String(row["question"]), askedAt: String(row["asked_at"]) });

/** A task's open questions, oldest first: only its newest run's, and only while that run is open. */
export function openAgentQuestions(store: Store, taskRef: number): AgentQuestion[] {
  return store.handle.prepare(`SELECT q.* FROM agent_question q JOIN run r ON r.id = q.run
    WHERE q.task_ref = ? AND q.closed_at IS NULL AND r.outcome IS NULL AND r.attempt_key = q.attempt_key ORDER BY q.id`).all(taskRef).map(readQuestion);
}

export function agentQuestion(store: Store, id: number): (AgentQuestion & { closedAt: string | null; closedHow: string | null; answerNote: number | null }) | null {
  const row = store.handle.prepare("SELECT * FROM agent_question WHERE id = ?").get(id);
  return row === undefined ? null : { ...readQuestion(row), closedAt: text(row["closed_at"]), closedHow: text(row["closed_how"]),
    answerNote: row["answer_note"] == null ? null : Number(row["answer_note"]) };
}

/** A run ended: every question it still had open is closed unanswered (its answer would reach no one). */
export function closeRunQuestions(store: Store, run: number, at: Date): number {
  const closed = Number(store.handle.prepare("UPDATE agent_question SET closed_at = ?, closed_how = 'ended' WHERE run = ? AND closed_at IS NULL")
    .run(at.toISOString(), run).changes);
  if (closed > 0) {
    const head = `agent-question:${run}:`;
    store.handle.prepare("UPDATE notification SET resolved_at = ? WHERE substr(dedupe_key, 1, ?) = ? AND resolved_at IS NULL").run(at.toISOString(), head.length, head);
  }
  return closed;
}

export type ReplyRefusal = "no-question" | "closed" | "stale" | "invalid-answer" | "not-saved";
export type ReplyResult = { ok: true; note: number; key: string } | { ok: false; reason: ReplyRefusal; problem?: string };

/** The steering note a reply becomes: the agent reads it in its steering folder, under its own key. */
export function replyNoteText(key: string, answer: string): string {
  return `Reply to your question "${key}": ${answer}`;
}

/**
 * Reply to one open question, atomically: the question is still open, its run
 * is still the task's open newest attempt under the same key, the answer saves
 * as an ordinary verified steering note (the mailbox pulse delivers it), and
 * exactly that key closes. Anything stale changes nothing.
 */
export function answerAgentQuestion(store: Store, reply: { question: number; answer: string; author: string; at: Date; file: (taskId: string, note: string) => { ok: true; id: number } | { ok: false; reason: string; problem?: string } }): ReplyResult {
  return store.transact(() => {
    const answer = reply.answer.trim();
    if (answer === "" || answer.length > ANSWER_MAX) return { ok: false as const, reason: "invalid-answer" as const, problem: `Write an answer of up to ${ANSWER_MAX} characters.` };
    const row = store.handle.prepare(`SELECT q.*, r.outcome, r.attempt_key AS run_key, tr.external_id AS task_id,
        ${NEWEST_BUILDER("q.task_ref")} AS newest
      FROM agent_question q JOIN run r ON r.id = q.run JOIN task_ref tr ON tr.id = q.task_ref WHERE q.id = ?`).get(reply.question);
    if (row === undefined) return { ok: false as const, reason: "no-question" as const };
    if (row["closed_at"] !== null) return { ok: false as const, reason: "closed" as const };
    if (row["outcome"] !== null || text(row["run_key"]) !== String(row["attempt_key"]) || Number(row["newest"]) !== Number(row["run"])) {
      return { ok: false as const, reason: "stale" as const };
    }
    const key = String(row["key"]);
    const filed = reply.file(String(row["task_id"]), replyNoteText(key, answer));
    if (!filed.ok) return { ok: false as const, reason: "not-saved" as const, ...(filed.problem === undefined ? {} : { problem: filed.problem }) };
    const closed = store.handle.prepare(`UPDATE agent_question SET closed_at = ?, closed_how = 'answered', answer_note = ?, answered_by = ?
      WHERE id = ? AND closed_at IS NULL`).run(reply.at.toISOString(), filed.id, reply.author, reply.question);
    if (Number(closed.changes) !== 1) throw new Error("the question closed while the reply was saved");
    store.handle.prepare("UPDATE notification SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL")
      .run(reply.at.toISOString(), `agent-question:${String(row["run"])}:${key}`);
    // The last open question answered: a "questions waiting" page has nothing left to wait on.
    const left = store.handle.prepare("SELECT 1 AS hit FROM agent_question WHERE run = ? AND closed_at IS NULL LIMIT 1").get(row["run"]);
    if (left === undefined) {
      const head = `agent-question:${String(row["run"])}:~`;
      store.handle.prepare("UPDATE notification SET resolved_at = ? WHERE substr(dedupe_key, 1, ?) = ? AND resolved_at IS NULL").run(reply.at.toISOString(), head.length, head);
    }
    return { ok: true as const, note: filed.id, key };
  });
}

// ---- who has seen, who is watching ------------------------------------------

/** This person opened a finished run (on the board or its result page): it leaves their unread Done. */
export function markAgentSeen(store: Store, account: string, run: number, at: Date): boolean {
  return Number(store.handle.prepare("INSERT OR IGNORE INTO agent_seen (account, run, seen_at) VALUES (?, ?, ?)").run(account, boardRunOf(store, run), at.toISOString()).changes) > 0;
}

/** A page is watching a run: hold (or renew) its short lease. */
export function holdAgentView(store: Store, view: string, account: string, run: number, at: Date): void {
  store.handle.prepare(`INSERT INTO agent_view (view, account, run, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (view) DO UPDATE SET expires_at = excluded.expires_at`).run(view, account, run, new Date(at.getTime() + VIEW_LEASE_MS).toISOString());
}

export function releaseAgentView(store: Store, view: string, at: Date): void {
  store.handle.prepare("DELETE FROM agent_view WHERE view = ? OR expires_at < ?").run(view, at.toISOString());
}

/** Until when this person has this exact run open (its repairs count as the run); null when they do not. */
export function watchingAgentUntil(store: Store, account: string, run: number, at: Date): string | null {
  const row = store.handle.prepare("SELECT max(expires_at) AS until FROM agent_view WHERE run = ? AND account = ? AND expires_at > ?")
    .get(boardRunOf(store, run), account, at.toISOString());
  return row === undefined || row["until"] == null ? null : String(row["until"]);
}

/** Someone has this exact run open right now. */
export function watchingAgent(store: Store, account: string, run: number, at: Date): boolean {
  return watchingAgentUntil(store, account, run, at) !== null;
}

/** Kinds no watch ever holds: a security alert and the evening digest reach people as they are (store.pingAllowed).
 * Nothing held may delay them either: a channel's ordering never keeps one behind a held ping (neverHeld). */
const NEVER_HELD: ReadonlySet<string> = new Set(["secret-detected", "security-release", "evening-digest"]);
export const neverHeld = (kind: string): boolean => NEVER_HELD.has(kind);
/** Kinds that are news only until the finished run is seen: a ping about one already opened is not sent at all. */
const SEEN_SETTLES: ReadonlySet<string> = new Set(["run-finished", "build-failed"]);

/**
 * A notification's subject (cockpit §3, R11): the run it is about — its own, or for a ping about a task the task's
 * live build — so any ping, not only the agent's own kinds, can be held while its person watches that agent. Null:
 * about nothing a person watches. Its version is the notification's own identity (its dedupe key), so a newer fact
 * about the same subject is a new ping.
 */
export function attentionSubjectOf(store: Store, row: { kind: string; run: number | null; taskRef?: number | null }): { run: number } | null {
  if (NEVER_HELD.has(row.kind)) return null;
  if (row.run !== null) return { run: row.run };
  if (row.taskRef === undefined || row.taskRef === null) return null;
  const live = store.handle.prepare("SELECT id FROM run WHERE task_ref = ? AND role = 'builder' AND outcome IS NULL ORDER BY id DESC LIMIT 1").get(row.taskRef);
  return live === undefined ? null : { run: Number(live["id"]) };
}

/**
 * A watched ping (cockpit §3, R11), decided when its delivery is claimed AND again at every channel's final send
 * fence, after the permanent rules in store.pingAllowed: held until the watch lapses while this person has its
 * subject's agent open; then skipped when it was news about a finished run they have since seen; otherwise sent.
 * A ping about nothing anyone watches is sent. (A delivery already handed to the network can't be recalled.)
 */
export function watchedPing(store: Store, row: { kind: string; run: number | null; taskRef?: number | null }, account: string, now: Date): { hold: string } | "skip" | "send" {
  const subject = attentionSubjectOf(store, row);
  if (subject === null) return "send";
  const until = watchingAgentUntil(store, account, subject.run, now);
  if (until !== null) return { hold: until };
  if (!SEEN_SETTLES.has(row.kind) || row.run === null) return "send";
  const seen = store.handle.prepare("SELECT 1 AS hit FROM agent_seen WHERE account = ? AND run = ?").get(account, boardRunOf(store, row.run));
  return seen === undefined ? "send" : "skip";
}
