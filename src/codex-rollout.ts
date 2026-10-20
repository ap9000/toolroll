/**
 * A Codex session's rollout file, read for one fact: how the turn a
 * continuation segment started ended (agents-cockpit plan, C1).
 *
 * `codex exec --json` prints no terminal event when it is interrupted
 * (C0 spike, codex-cli 0.156.1): the only record that a turn stopped at a
 * boundary is the rollout's `turn_aborted` (reason `interrupted`). The
 * rollout lives under the operator's `CODEX_HOME/sessions/YYYY/MM/DD/`,
 * named `rollout-<local time>-<thread id>.jsonl`, and a resumed session
 * appends to the same file.
 *
 * Reading is fail-closed: the file is opened O_NOFOLLOW, must fstat as a
 * regular file under the size cap, and every line must parse. Anything
 * else is "no boundary", never a guess.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** A rollout bigger than this is not read (the reader would hold it whole). */
export const ROLLOUT_MAX_BYTES = 64 * 1024 * 1024;

/** Codex thread ids are UUIDs (v7 in 0.156). */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TurnBoundary = "completed" | "interrupted" | "none";

export type RolloutTurn = {
  boundary: TurnBoundary;
  /** The turn the segment started, or null when none started after the spawn. */
  turnId: string | null;
  /** That turn's tokens, from the rollout's running totals; null when unmeasured. */
  usage: { tokensIn: number; tokensOut: number } | null;
};

export const NO_TURN: RolloutTurn = Object.freeze({ boundary: "none", turnId: null, usage: null });

const pad = (n: number) => String(n).padStart(2, "0");
const dayDir = (sessions: string, day: Date) => join(sessions, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));

/**
 * The rollout for `threadId`, looked for in each local day folder from the
 * day before `from` to the day after `to` (the folder is the session's
 * start day, in local time). Null when absent, ambiguous, or not a plain
 * file; never follows a link.
 */
export function findRollout(sessions: string, threadId: string, from: Date, to: Date): string | null {
  if (!THREAD_ID.test(threadId)) return null;
  // No redirected component anywhere (c1-r2 c1-4): the root is its own realpath and a real directory, and so is each
  // year, month and day folder below it. The fence denies the agent the root, so nothing below it can be swapped.
  try { if (realpathSync(sessions) !== sessions || !lstatSync(sessions).isDirectory()) return null; } catch { return null; }
  const plainDir = (path: string) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
  const suffix = `-${threadId}.jsonl`;
  const found: string[] = [];
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1);
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  // Bounded: a session older than ~a year is not continued.
  for (let n = 0; day <= last && n < 400; n += 1, day.setDate(day.getDate() + 1)) {
    const dir = dayDir(sessions, day);
    const month = dirname(dir);
    if (!plainDir(dirname(month)) || !plainDir(month) || !plainDir(dir)) continue;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(suffix)) continue;
      const path = join(dir, name);
      try { if (lstatSync(path).isFile()) found.push(path); } catch { /* gone */ }
    }
  }
  return found.length === 1 ? found[0]! : null;
}

/** The file's text through one no-follow descriptor, or null. */
export function readRollout(path: string, maxBytes = ROLLOUT_MAX_BYTES): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, read);
      if (n === 0) return null;
      read += n;
    }
    // Grew while read: the writer is not done; this is not a settled record.
    if (fstatSync(fd).size !== stat.size) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

type Totals = { in: number; out: number };

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function totalsOf(payload: Record<string, unknown>): Totals | null {
  const total = record(record(payload["info"])?.["total_token_usage"]);
  if (total === null) return null;
  const tokensIn = count(total["input_tokens"]);
  const tokensOut = count(total["output_tokens"]);
  return tokensIn === null || tokensOut === null ? null : { in: tokensIn, out: tokensOut };
}

/**
 * Where the rollout stood before a segment launched (c1-r2 new 2): its size in bytes and its last turn's id. Only a
 * turn whose `task_started` was appended past this point, with another id, can be the segment's own.
 */
export type RolloutWatermark = { bytes: number; lastTurn: string | null };

export const FRESH_WATERMARK: RolloutWatermark = Object.freeze({ bytes: 0, lastTurn: null });

/**
 * The watermark of a resumed session's rollout text, or null when that text is not a whole, readable record of this
 * thread (c1-r3): an unreadable history is never mistaken for a fresh one, and the caller refuses to continue. A
 * session with no rollout at all is FRESH_WATERMARK, and only a launch that starts a NEW session may use it.
 */
export function watermarkOf(text: string, threadId: string): RolloutWatermark | null {
  const parsed = rowsOf(text);
  if (parsed === null || parsed.length === 0 || parsed[0]!.type !== "session_meta" || parsed[0]!.payload["id"] !== threadId) return null;
  let lastTurn: string | null = null;
  for (const row of parsed) if (eventOf(row) === "task_started" && typeof row.payload["turn_id"] === "string") lastTurn = row.payload["turn_id"];
  return { bytes: Buffer.byteLength(text), lastTurn };
}

type Row = { type: string; payload: Record<string, unknown>; offset: number };

/** Every line as a record with its byte offset, or null when any line is malformed. */
function rowsOf(text: string): Row[] | null {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const rows: Row[] = [];
  let offset = 0;
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return null; }
    const row = record(parsed);
    const payload = record(row?.["payload"]);
    if (row === null || typeof row["type"] !== "string" || payload === null) return null;
    rows.push({ type: row["type"], payload, offset });
    offset += Buffer.byteLength(line) + 1;
  }
  return rows;
}

const eventOf = (row: Row) => row.type === "event_msg" ? String(row.payload["type"] ?? "") : "";

/**
 * How the LAST turn in this rollout ended, when that turn is the segment's own: its `task_started` lies past the
 * pre-launch watermark and names a new turn id, in thread `threadId`. Its end is a `task_complete`, or a
 * `turn_aborted` with reason `interrupted`, naming the same turn id. A malformed line, a wrong thread, an end naming
 * another turn, or two ends make the answer "none".
 *
 * Tokens (c1-r2 c1-7): the running total at the turn's end minus the last total before its start. Only totals before
 * the end count. With no total before the start, the baseline is zero only when no earlier turn exists; otherwise the
 * turn is unmeasured. A missing or backwards total is unmeasured too.
 */
export function lastTurnOf(text: string, threadId: string, watermark: RolloutWatermark): RolloutTurn {
  const rows = rowsOf(text);
  if (rows === null || rows.length === 0) return NO_TURN;
  const meta = rows[0]!;
  if (meta.type !== "session_meta" || meta.payload["id"] !== threadId) return NO_TURN;
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) if (eventOf(rows[i]!) === "task_started") { start = i; break; }
  if (start < 0) return NO_TURN;
  const begun = rows[start]!;
  const turnId = typeof begun.payload["turn_id"] === "string" ? begun.payload["turn_id"] : null;
  if (turnId === null || begun.offset < watermark.bytes || turnId === watermark.lastTurn) return NO_TURN;
  let before: Totals | null = null;
  let earlierTurn = false;
  for (let i = start - 1; i >= 0; i -= 1) {
    const kind = eventOf(rows[i]!);
    if (kind === "task_started") earlierTurn = true;
    if (kind !== "token_count" || before !== null) continue;
    before = totalsOf(rows[i]!.payload) ?? { in: -1, out: -1 };
  }
  if (before === null && !earlierTurn) before = { in: 0, out: 0 };
  let boundary: TurnBoundary = "none";
  let ends = 0;
  let after: Totals | null = null;
  let measured = before !== null && before.in >= 0;
  for (const row of rows.slice(start + 1)) {
    const kind = eventOf(row);
    if (kind === "token_count" && ends === 0) {
      const totals = totalsOf(row.payload);
      // A running total never runs backwards (c1-r3): one that does makes the whole turn unmeasured.
      const last = after ?? before;
      if (totals === null || (last !== null && (totals.in < last.in || totals.out < last.out))) measured = false;
      else after = totals;
    } else if (kind === "task_complete" || kind === "turn_aborted") {
      ends += 1;
      if (row.payload["turn_id"] !== turnId) return { boundary: "none", turnId, usage: null };
      boundary = kind === "task_complete" ? "completed" : row.payload["reason"] === "interrupted" ? "interrupted" : "none";
    }
  }
  if (ends !== 1) boundary = "none";
  const usage = measured && before !== null && after !== null && after.in >= before.in && after.out >= before.out
    ? { tokensIn: after.in - before.in, tokensOut: after.out - before.out }
    : null;
  return { boundary, turnId, usage };
}
