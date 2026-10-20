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
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

/** A rollout bigger than this is not read (the reader would hold it whole). */
export const ROLLOUT_MAX_BYTES = 64 * 1024 * 1024;

/** Codex thread ids are UUIDs (v7 in 0.156). */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Clock skew allowed between the segment's spawn stamp and the rollout's own timestamps. */
const SKEW_MS = 2_000;

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
  const suffix = `-${threadId}.jsonl`;
  const found: string[] = [];
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1);
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  // Bounded: a session older than ~a year is not continued.
  for (let n = 0; day <= last && n < 400; n += 1, day.setDate(day.getDate() + 1)) {
    const dir = dayDir(sessions, day);
    let names: string[];
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch { continue; }
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
 * How the LAST turn in this rollout ended, when that turn started at or
 * after `sinceMs` in thread `threadId`. The turn is the last
 * `task_started`; its end is a `task_complete` or a `turn_aborted` with
 * reason `interrupted` naming the same turn id. Anything after the end but
 * another turn's start is ignored; any malformed line, a wrong thread, an
 * end naming another turn, or two ends make the answer "none".
 */
export function lastTurnOf(text: string, threadId: string, sinceMs: number): RolloutTurn {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return NO_TURN;
  type Row = { type: string; payload: Record<string, unknown>; at: number };
  const rows: Row[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return NO_TURN; }
    const row = record(parsed);
    const payload = record(row?.["payload"]);
    if (row === null || typeof row["type"] !== "string" || payload === null) return NO_TURN;
    const at = typeof row["timestamp"] === "string" ? Date.parse(row["timestamp"]) : NaN;
    rows.push({ type: row["type"], payload, at });
  }
  const meta = rows[0]!;
  if (meta.type !== "session_meta" || meta.payload["id"] !== threadId) return NO_TURN;
  const event = (row: Row) => row.type === "event_msg" ? String(row.payload["type"] ?? "") : "";
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) if (event(rows[i]!) === "task_started") { start = i; break; }
  if (start < 0) return NO_TURN;
  const begun = rows[start]!;
  const turnId = typeof begun.payload["turn_id"] === "string" ? begun.payload["turn_id"] : null;
  if (turnId === null || !Number.isFinite(begun.at) || begun.at < sinceMs - SKEW_MS) return NO_TURN;
  let before: Totals = { in: 0, out: 0 };
  for (let i = start - 1; i >= 0; i -= 1) {
    if (event(rows[i]!) !== "token_count") continue;
    const totals = totalsOf(rows[i]!.payload);
    if (totals === null) return { boundary: "none", turnId, usage: null };
    before = totals;
    break;
  }
  let boundary: TurnBoundary = "none";
  let ends = 0;
  let after: Totals | null = null;
  let measured = true;
  for (const row of rows.slice(start + 1)) {
    const kind = event(row);
    if (kind === "token_count") {
      const totals = totalsOf(row.payload);
      if (totals === null) measured = false; else after = totals;
    } else if (kind === "task_complete" || kind === "turn_aborted") {
      ends += 1;
      if (row.payload["turn_id"] !== turnId) return { boundary: "none", turnId, usage: null };
      boundary = kind === "task_complete" ? "completed" : row.payload["reason"] === "interrupted" ? "interrupted" : "none";
    }
  }
  if (ends !== 1) boundary = "none";
  const usage = measured && after !== null && after.in >= before.in && after.out >= before.out
    ? { tokensIn: after.in - before.in, tokensOut: after.out - before.out }
    : null;
  return { boundary, turnId, usage };
}
