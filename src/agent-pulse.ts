/**
 * The Agents board on the build's existing minute pulse (agent-board.ts):
 * the agent's status file, the live transcript's size, the changed-file
 * count and the four-minute Stuck mark. No model and no tokens: files the
 * plane already owns, read with the same discipline as every protocol file.
 *
 * The status file is the agent's: one JSON object per line, appended.
 *   {"status":"working","note":"…"}
 *   {"status":"needs-decision","key":"short-key","question":"…"}
 *   {"status":"blocked","note":"…"}
 *   {"status":"done","note":"…"}
 * It is read forward from a saved offset, only through complete lines, never
 * past its caps, opened O_NOFOLLOW as a regular file; a line that is not one
 * of these shapes is skipped, and every word goes through the live view's
 * sanitizer (a credential-shaped line is replaced whole).
 */
import { closeSync, constants, fstatSync, openSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ingestStatus, markStuck, noteDiff, noteTranscript, NOTE_MAX, pageQuestions, QUESTION_KEY, QUESTION_MAX, QUESTIONS_OPEN_MAX, QUESTIONS_PER_ATTEMPT, type StatusIngest, type StatusLine } from "./agent-board.js";
import { readVerifiedArtifact } from "./evidence.js";
import { liveLogPath, sanitizeTranscriptLine } from "./live.js";
import { observeWorktree, parseBaseTreeSnapshot, PEEK_LIMITS, type BaseTreeEntry } from "./peek.js";
import type { Store } from "./store.js";

/** The whole file may grow this far; past it, nothing more is read. */
export const STATUS_FILE_CAP = 256 * 1024;
/** At most this much is read per beat. */
const STATUS_WINDOW = 64 * 1024;
/** A line longer than this is skipped, never cut. */
const STATUS_LINE_CAP = 4 * 1024;

const clean = (value: unknown, cap: number): string | null => {
  if (typeof value !== "string") return null;
  const one = sanitizeTranscriptLine(value.replace(/\s+/g, " ").trim());
  if (one === "") return null;
  return one.length > cap ? `${one.slice(0, cap - 1).trimEnd()}…` : one;
};

/** One status line, strictly: a known status and its fields, or null. */
export function parseStatusLine(line: string): StatusLine | null {
  if (line.trim() === "" || Buffer.byteLength(line, "utf8") > STATUS_LINE_CAP) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (status === "needs-decision") {
    const key = typeof record["key"] === "string" ? record["key"].trim().toLowerCase() : "";
    const question = clean(record["question"], QUESTION_MAX);
    return QUESTION_KEY.test(key) && question !== null ? { status, key, question } : null;
  }
  if (status === "working" || status === "blocked" || status === "done") return { status, note: clean(record["note"], NOTE_MAX) };
  return null;
}

export type StatusRead = { ok: true; read: StatusIngest } | { ok: false; reason: "missing" | "replaced" | "unreadable" | "full" };

/** The complete lines after `from`, and where the next read starts. */
export function readStatusFile(path: string, from: number): StatusRead {
  if (!Number.isSafeInteger(from) || from < 0) return { ok: false, reason: "unreadable" };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: "unreadable" };
    const size = Math.min(Number(stat.size), STATUS_FILE_CAP);
    if (Number(stat.size) < from) return { ok: false, reason: "replaced" };
    if (from >= STATUS_FILE_CAP) return { ok: false, reason: "full" };
    const want = Math.min(size - from, STATUS_WINDOW);
    if (want <= 0) return { ok: true, read: { lines: [], nextOffset: from } };
    const buffer = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const read = readSync(fd, buffer, got, want - got, from + got);
      if (read <= 0) break;
      got += read;
    }
    const chunk = buffer.subarray(0, got);
    const lastLf = chunk.lastIndexOf(0x0a);
    if (lastLf === -1) {
      // One line longer than the whole window is never going to parse: step past it.
      return { ok: true, read: { lines: [], nextOffset: got >= STATUS_WINDOW ? from + got : from } };
    }
    const lines = chunk.subarray(0, lastLf).toString("utf8").split("\n").map(parseStatusLine).filter((one): one is StatusLine => one !== null);
    return { ok: true, read: { lines, nextOffset: from + lastLf + 1 } };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

/** Create the attempt's empty status file (created here, never adopted); null when it cannot be. */
export function openStatusFile(worktree: string, name: string): string | null {
  const path = join(worktree, name);
  try {
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

export function removeStatusFile(path: string | null): void {
  if (path === null) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** The brief's few lines: where to write, what each status means, and how a reply arrives. */
export function statusBrief(name: string, steerFolder: string | null): string {
  return [
    "",
    "Status for the person watching (the Agents board):",
    `- Append one JSON object per line to ${name} in the worktree root. Never rewrite or delete it; it is never committed.`,
    '  {"status":"working","note":"<what you are doing, one short line>"}',
    '  {"status":"needs-decision","key":"<short-key>","question":"<one question a person must answer>"}',
    '  {"status":"blocked","note":"<what stops you>"}',
    '  {"status":"done","note":"<one-line outcome>"}',
    "- Use needs-decision only for a real judgement call inside the agreed scope; a key is lowercase letters, digits and",
    "  hyphens, at most 40 characters, and is asked once. Keep working on anything that does not depend on the answer.",
    `- At most ${QUESTIONS_OPEN_MAX} questions can be open at once, and ${QUESTIONS_PER_ATTEMPT} in all; any more reach no one.`,
    steerFolder === null
      ? "- A reply cannot reach this attempt while it runs; if the answer is required to finish, park instead."
      : `- A reply arrives as a note in ${steerFolder}/ that begins 'Reply to your question "<short-key>"'.`,
    "",
  ].join("\n");
}

type BaseEntries = readonly BaseTreeEntry[];

/** The run's verified base snapshot, as the live peek reads it; null when it was not captured cleanly. */
export function baseEntriesOf(store: Store, root: string, run: number): BaseEntries | null {
  const artifact = store.artifactsFor(run).find(one => one.kind === "base-tree");
  if (artifact === undefined || artifact.captureStatus !== "ok" || artifact.truncated) return null;
  const read = readVerifiedArtifact(root, artifact);
  if (!read.ok) return null;
  const snapshot = parseBaseTreeSnapshot(read.content.toString("utf8"));
  return snapshot === null || snapshot.run !== run ? null : snapshot.entries;
}

/** What a look at the checkout found: changed, deleted and new files together; null when it could not look. */
export async function changedFileCount(worktree: string, base: BaseEntries): Promise<number | null> {
  const seen = await observeWorktree(worktree, base, { ...PEEK_LIMITS, deadlineMs: 1_500 });
  if (!seen.ok) return null;
  return seen.rows.filter(one => one.kind === "changed" || one.kind === "deleted").length + seen.newPaths.length;
}

export type AgentPulseState = {
  run: number; attemptKey: string; root: string; worktree: string;
  /** The status file, or null when this attempt has none. */
  status: string | null;
  base: BaseEntries | null | undefined;
  looking: boolean;
};

/**
 * One beat for the board. Each part is its own fail-soft step: a status file
 * that cannot be read, or a checkout that cannot be looked at, costs only
 * its own line on the board, never the build.
 */
export function pulseAgentBoard(store: Store, state: AgentPulseState, now: Date): void {
  try {
    const bytes = statSync(liveLogPath(state.root, state.run)).size;
    noteTranscript(store, state.run, state.attemptKey, bytes, now);
  } catch { /* no live log: the activity row still counts */ }
  if (state.status !== null) {
    try {
      const from = store.handle.prepare("SELECT status_offset FROM agent_now WHERE run = ? AND attempt_key = ?").get(state.run, state.attemptKey);
      if (from !== undefined) {
        const read = readStatusFile(state.status, Number(from["status_offset"] ?? 0));
        if (read.ok) ingestStatus(store, state.run, state.attemptKey, read.read, now);
      }
    } catch { /* the next beat reads from the same offset */ }
    // Questions asked inside the page window go out once it ends, with or without a new line.
    try { pageQuestions(store, state.run, state.attemptKey, now); } catch { /* the next beat */ }
  }
  try { markStuck(store, state.run, state.attemptKey, now); } catch { /* the next beat */ }
  if (state.looking) return;
  if (state.base === undefined) {
    try { state.base = baseEntriesOf(store, state.root, state.run); } catch { state.base = null; }
  }
  const base = state.base;
  if (base === null) return;
  state.looking = true;
  void changedFileCount(state.worktree, base)
    .then(count => { if (count !== null) noteDiff(store, state.run, state.attemptKey, count, now); })
    .catch(() => { /* the next beat looks again */ })
    .finally(() => { state.looking = false; });
}
