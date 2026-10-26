/**
 * The live window (arc 1): what the running agent is saying, on disk, for
 * the run page to poll — and NOTHING else.
 *
 * This file is display state, not evidence. No artifact row points at it,
 * no digest binds it, and the page that renders it says so: the machine
 * running the agent could alter it. It exists so a person can watch work
 * happen without a terminal, and every byte in it went through the same
 * sanitize discipline as the peek: controls stripped, credential-shaped
 * lines replaced whole, tool activity described in OUR fixed vocabulary —
 * event metadata is never echoed.
 *
 * Fail-soft everywhere: a live view that cannot be written must never
 * break, slow, or reclassify a build.
 */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { scanForSecrets } from "./evidence.js";
import { createLiveRecorder, parseLiveRecords, redactLiveLines, projectLiveText, serializeLiveRecord, type KeyState, type LiveActivityKind, type LiveRecord, type LiveRecorderOptions } from "./live-records.js";
import { topLevelEvent } from "./stream-scope.js";

export const LIVE_LINE_CAP = 2 * 1024;
export const LIVE_FILE_CAP = 4 * 1024 * 1024;
export const LIVE_REDACTED_LINE = "[a credential-shaped line was redacted]";
/** Finalized runs keep their live file this long for the final drain. */
export const LIVE_RETAIN_MS = 24 * 60 * 60 * 1000;
/** The bounded sweep: at most this many FINALIZED files survive a pass. */
export const LIVE_FILE_BOUND = 500;

export function liveDir(root: string): string {
  return join(root, "live");
}

/** The exact filename, from the numeric id and nothing else — no user
 * input is ever parsed into this path. Records (`.jsonl`) are what every
 * run writes now; the name is the format. */
export function liveLogPath(root: string, runId: number): string {
  return join(liveDir(root), `${Math.trunc(runId)}.jsonl`);
}

/** The plain-text file runs wrote before the live conversation; read until it ages out. */
export function legacyLiveLogPath(root: string, runId: number): string {
  return join(liveDir(root), `${Math.trunc(runId)}.log`);
}

export { LIVE_ACTIVITY_KINDS, type LiveActivityKind } from "./live-records.js";

/** The activity line's kinds for known Claude tools (task-activity.ts). */
const TOOL_KINDS: ReadonlyMap<string, LiveActivityKind> = new Map([
  ["Edit", "edit"],
  ["Write", "edit"],
  ["MultiEdit", "edit"],
  ["NotebookEdit", "edit"],
  ["Bash", "command"],
  ["Read", "read"],
  ["Glob", "search"],
  ["Grep", "search"],
  ["LS", "read"],
  ["WebFetch", "lookup"],
  ["WebSearch", "lookup"],
  ["TodoWrite", "plan"],
  ["Task", "delegate"],
]);
const toolKind = (name: unknown): LiveActivityKind => TOOL_KINDS.get(typeof name === "string" ? name : "") ?? "tool";

/**
 * What one stream event says the agent just did, as one fixed kind: the
 * last-activity line's only input. Never text, names or arguments; an
 * event that says nothing (results, deltas, subagent chatter) is null.
 */
export function liveActivityKind(event: Record<string, unknown>): LiveActivityKind | null {
  try {
    // A subagent's events, of every type, are not this run's activity (stream-scope.ts).
    if (!topLevelEvent(event)) return null;
    const type = String(event["type"] ?? "");
    if ((type === "system" && String(event["subtype"] ?? "") === "init") || type === "thread.started" || type === "init") return "session";
    if (type === "item.completed") {
      const item = event["item"] as Record<string, unknown> | undefined;
      const kind = item === undefined || item === null ? "" : String(item["type"] ?? "");
      return kind === "agent_message" ? "message" : kind === "command_execution" ? "command" : kind === "file_change" ? "edit" : kind === "web_search" ? "lookup" : null;
    }
    if (type === "message") return String(event["role"] ?? "") === "assistant" && event["delta"] !== true ? "message" : null;
    if (type === "tool_call" || type === "tool_use") return toolKind(event["name"] ?? (event["tool"] as Record<string, unknown> | undefined)?.["name"]);
    if (type !== "assistant") return null;
    const content = (event["message"] as Record<string, unknown> | undefined)?.["content"];
    if (!Array.isArray(content)) return null;
    let last: LiveActivityKind | null = null;
    for (const block of content as Record<string, unknown>[]) {
      if (block === null || typeof block !== "object") continue;
      if (block["type"] === "tool_use") last = toolKind(block["name"]);
      else if (block["type"] === "text" && typeof block["text"] === "string" && block["text"].trim() !== "") last = "message";
    }
    return last;
  } catch {
    return null;
  }
}

/** Strip ANSI escapes and every control character; tabs become spaces. */
function stripControls(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\t/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Cut a string to at most `cap` UTF-8 bytes without splitting a character. */
function capBytes(text: string, cap: number): string {
  if (Buffer.byteLength(text, "utf8") <= cap) return text;
  const bytes = Buffer.from(text, "utf8").subarray(0, cap);
  const decoded = bytes.toString("utf8");
  // A cut mid-character decodes with a trailing replacement char — drop it.
  return decoded.endsWith("�") ? decoded.slice(0, -1) : decoded;
}

/** Bidirectional overrides and isolates (U+202A–U+202E, U+2066–U+2069): they can make shown text read differently from what was written. */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

/** Sanitize one display line: strip controls and bidi overrides, redact whole on any secret hit, cap. */
export function sanitizeTranscriptLine(line: string): string {
  const stripped = stripControls(line).replace(BIDI_CONTROLS, "");
  if (scanForSecrets(stripped).length > 0) return LIVE_REDACTED_LINE;
  return capBytes(stripped, LIVE_LINE_CAP);
}

export type LiveLog = {
  observe(event: Record<string, unknown>): void;
  close(): void;
};

/**
 * Open the run's live file for appending records. The directory is 0700,
 * the file 0600 and CREATED HERE (O_EXCL: a name that already exists —
 * whatever put it there — is refused, not appended to), opened O_NOFOLLOW
 * with the descriptor retained for the run's whole duration. `options` is
 * the run's trusted context: its checkout, and whether its project shows
 * commands (read once, here). Returns null on any failure: no live view is
 * ever worth a build.
 */
export function openLiveLog(root: string, runId: number, options: Partial<LiveRecorderOptions> = {}): LiveLog | null {
  let fd: number;
  try {
    mkdirSync(liveDir(root), { recursive: true, mode: 0o700 });
    fd = openSync(
      liveLogPath(root, runId),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return null;
  }
  const recorder = createLiveRecorder({ base: options.base ?? null, commands: options.commands === true, ...(options.clock === undefined ? {} : { clock: options.clock }) });
  let written = 0;
  let capped = false;
  let closed = false;

  const append = (record: LiveRecord): void => {
    if (closed || capped) return;
    const payload = Buffer.from(`${serializeLiveRecord(record)}\n`, "utf8");
    // The cap record is RESERVED inside the cap: whatever remains must still fit it.
    const capLine = `${serializeLiveRecord({ k: "cap", at: record.at })}\n`;
    if (written + payload.length + Buffer.byteLength(capLine, "utf8") > LIVE_FILE_CAP) {
      capped = true;
      try {
        writeSync(fd, capLine);
      } catch {
        // Nothing to do: the file simply ends early.
      }
      return;
    }
    try {
      writeSync(fd, payload);
      written += payload.length;
    } catch {
      closed = true; // a broken descriptor never breaks the run
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
    }
  };

  append({ k: "open", at: (options.clock ?? (() => new Date()))().toISOString(), detail: options.commands === true ? "commands" : "base" });
  return {
    observe(event: Record<string, unknown>): void {
      try {
        for (const record of recorder.observe(event)) append(record);
      } catch {
        // Recording is observational; a malformed event records nothing.
      }
    },
    close(): void {
      if (closed) return;
      try {
        for (const record of recorder.end()) append(record);
      } catch {
        // the steps simply stay open in the file
      }
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
    },
  };
}

export type LiveFormat = "records" | "text";

export type LiveWindowRead =
  | {
      ok: true;
      /** Complete lines read from `from`: records (JSON lines) or legacy text. */
      text: string;
      nextOffset: number;
      eof: boolean;
      format: LiveFormat;
      /** Which file this offset belongs to: a client holding another resets. */
      gen: string;
    }
  | { ok: false; reason: "missing" | "replaced" | "unreadable" };

const READ_WINDOW = 64 * 1024;
const READ_LOOKAHEAD = 2 * 1024;
/** How far past an over-long line one read looks for its end; past it, the line is skipped up to there. */
const SKIP_SCAN = 64 * 1024 * 1024;

/** The live directory itself: a real directory, never a link to one. */
function liveDirIsReal(root: string): boolean {
  try {
    const stat = lstatSync(liveDir(root));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function openForRead(path: string): { fd: number } | { missing: true } | { unreadable: true } {
  try {
    return { fd: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : { unreadable: true };
  }
}

/** The line that stands in for one too long to read, in the file's own format. */
function cutLine(format: LiveFormat): string {
  return format === "records" ? `${serializeLiveRecord({ k: "cut", at: "" })}\n` : "[a line was too long to show]\n";
}

/**
 * Read the live file from a byte offset, returning only COMPLETE lines
 * (through the last LF in the window). The records file is read when it
 * exists, else the legacy text file. The descriptor is the authority:
 * opened O_NOFOLLOW | O_NONBLOCK inside a real live directory, proved a
 * regular file, measured and read through itself. A file smaller than the
 * offset was replaced — the caller resets, visibly, and `gen` names the file
 * so an offset is never reused against another one. A line longer than the
 * whole window is skipped through its end, so a reader never stalls.
 * `allowTail` (the final drain) returns the unterminated tail after
 * finalization. Legacy text is cleaned again on the way out.
 */
export function readLiveWindow(root: string, runId: number, from: number, allowTail = false): LiveWindowRead {
  if (!Number.isSafeInteger(from) || from < 0) return { ok: false, reason: "unreadable" };
  if (!liveDirIsReal(root)) return { ok: false, reason: "missing" };
  let format: LiveFormat = "records";
  let opened = openForRead(liveLogPath(root, runId));
  if ("missing" in opened) {
    format = "text";
    opened = openForRead(legacyLiveLogPath(root, runId));
  }
  if ("missing" in opened) return { ok: false, reason: "missing" };
  if ("unreadable" in opened) return { ok: false, reason: "unreadable" };
  const fd = opened.fd;
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return { ok: false, reason: "unreadable" };
    // Linux hands a removed file's inode straight to the next one made, so the birth time (ns) tells them apart too.
    const gen = `${format}:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    const size = Number(stat.size);
    if (size < from) return { ok: false, reason: "replaced" };
    const want = Math.min(size - from, READ_WINDOW + READ_LOOKAHEAD);
    const buffer = Buffer.alloc(want);
    let offset = 0;
    while (offset < want) {
      const read = readSync(fd, buffer, offset, want - offset, from + offset);
      if (read <= 0) break;
      offset += read;
    }
    const chunk = buffer.subarray(0, offset);
    const lastLf = chunk.lastIndexOf(0x0a);
    const eofReached = from + offset >= size;
    const out = (text: string, next: number, eof: boolean): LiveWindowRead => ({
      ok: true,
      // Raw: every reader cleans and redacts through liveWindowLines / liveWindowRecords, carrying the key state.
      text,
      nextOffset: next,
      eof,
      format,
      gen,
    });
    if (lastLf === -1) {
      if (allowTail && eofReached && offset > 0) return out(chunk.toString("utf8"), from + offset, true);
      // A whole window without an end of line: skip through its end (bounded), never stall on it.
      if (offset === READ_WINDOW + READ_LOOKAHEAD) {
        const scan = Buffer.alloc(64 * 1024);
        const limit = Math.min(size, from + SKIP_SCAN);
        let at = from + offset;
        while (at < limit) {
          const read = readSync(fd, scan, 0, Math.min(scan.length, limit - at), at);
          if (read <= 0) break;
          const lf = scan.subarray(0, read).indexOf(0x0a);
          if (lf !== -1) return { ok: true, text: cutLine(format), nextOffset: at + lf + 1, eof: at + lf + 1 >= size, format, gen };
          at += read;
        }
        // No end within reach. A finished run's drain, or a line longer than any read looks, is cut where the
        // look stopped, so reading always moves on; a live run's line may still be being written, so it waits.
        if (allowTail || at >= from + SKIP_SCAN) return { ok: true, text: cutLine(format), nextOffset: at, eof: at >= size, format, gen };
        return { ok: true, text: "", nextOffset: from, eof: false, format, gen };
      }
      return out("", from, eofReached && offset === 0);
    }
    if (allowTail && eofReached && lastLf + 1 < offset) return out(chunk.toString("utf8"), from + offset, true);
    const complete = chunk.subarray(0, lastLf + 1);
    return out(complete.toString("utf8"), from + lastLf + 1, from + lastLf + 1 >= size);
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

/** A window's complete lines as the plain words the run page and `toolroll peek` show, whatever its format. `commands` is
 * the run's own captured answer (store.ts runLiveCommands), never the file's say. */
export function liveWindowLines(read: { text: string; format: LiveFormat }, commands: boolean, keys: KeyState = { inKey: false }): string[] {
  if (read.format === "records") return projectLiveText(withholdCommands(parseLiveRecords(read.text, keys), commands));
  return cleanLegacy(read.text, keys).split("\n").filter(one => one !== "");
}

/** A window as records, whatever its format: an older plain file's lines become the agent's words. Command text and
 * output show only when the run's own captured answer (`commands`) is on. */
export function liveWindowRecords(read: { text: string; format: LiveFormat }, commands: boolean, keys: KeyState = { inKey: false }): LiveRecord[] {
  if (read.format === "records") return withholdCommands(parseLiveRecords(read.text, keys), commands);
  return cleanLegacy(read.text, keys).split("\n").filter(one => one !== "").map(line => ({ k: "say" as const, at: "", t: [line] }));
}

/**
 * Enforce a run's captured "Show commands" answer on read: the file is build-writable, so an `open` record, a command
 * step's text or a step's output may say anything. With the answer off, every `open` reads the base tier, command steps
 * lose their text and steps lose their output. (The older plain-text format predates command detail and is unchanged.)
 */
function withholdCommands(records: LiveRecord[], commands: boolean): LiveRecord[] {
  if (commands) return records;
  return records.map(record => {
    if (record.k === "open") return record.detail === "base" ? record : { ...record, detail: "base" as const };
    if (record.k === "step" && record.kind === "command" && record.target !== undefined) { const { target: _target, ...rest } = record; return rest; }
    if (record.k === "done" && record.out !== undefined) { const { out: _out, ...rest } = record; return rest; }
    return record;
  });
}

/** Legacy text lines, cleaned again on read: the file may have been altered after it was written. */
function cleanLegacy(text: string, keys: KeyState): string {
  const lines = text.split("\n");
  const ended = lines.length > 0 && lines[lines.length - 1] === "";
  if (ended) lines.pop();
  const shown = redactLiveLines(lines, keys);
  return ended ? `${shown.join("\n")}\n` : shown.join("\n");
}

export type LiveSweepVerdict = {
  /** run id, or null when the name is not a run's file. */
  runId: number | null;
  fileName: string;
  mtimeMs: number;
};

/**
 * Enumerate the live directory for the reconcile sweep. Pure listing — the
 * CALLER decides which runs are finalized and when; this module only
 * refuses to guess. Non-run names are reported with runId null (orphans
 * from nothing this plane wrote; aged on mtime like everything else).
 */
export function listLiveFiles(root: string): LiveSweepVerdict[] {
  let names: string[];
  try {
    names = readdirSync(liveDir(root));
  } catch {
    return [];
  }
  const out: LiveSweepVerdict[] = [];
  for (const name of names) {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(liveDir(root), name)).mtimeMs;
    } catch {
      continue;
    }
    const match = /^(\d{1,15})\.(?:jsonl|log)$/.exec(name);
    out.push({ runId: match === null ? null : Number(match[1]), fileName: name, mtimeMs });
  }
  return out;
}

/** Remove one live file, silently: a sweep never throws over display state. */
export function removeLiveFile(root: string, fileName: string): void {
  // The name comes from listLiveFiles' own readdir, never from user input.
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) return;
  try {
    unlinkSync(join(liveDir(root), fileName));
  } catch {
    // already gone
  }
}

/**
 * The reconcile sweep (arc 1 §2): ACTIVE runs are exempt ABSOLUTELY — the
 * transport's no-truncation assumption depends on it. Finalized runs age
 * from finished_at; orphans (no run row, or a name this plane never
 * writes) age from mtime; and the 500-file bound applies only WITHIN the
 * finalized-or-orphan set, oldest first.
 */
export function sweepLiveLogs(
  store: { getRun(id: number): { outcome: string | null; finishedAt: string | null } | null },
  root: string,
  now: Date,
): { removed: string[] } {
  const removed: string[] = [];
  const removable: { fileName: string; ageAnchorMs: number }[] = [];
  for (const entry of listLiveFiles(root)) {
    if (entry.runId !== null) {
      const run = store.getRun(entry.runId);
      if (run !== null && run.outcome === null) continue; // live: untouchable
      const finished = run?.finishedAt === null || run?.finishedAt === undefined ? null : Date.parse(run.finishedAt);
      removable.push({
        fileName: entry.fileName,
        ageAnchorMs: finished === null || Number.isNaN(finished) ? entry.mtimeMs : finished,
      });
    } else {
      removable.push({ fileName: entry.fileName, ageAnchorMs: entry.mtimeMs });
    }
  }
  removable.sort((a, b) => a.ageAnchorMs - b.ageAnchorMs);
  const cutoff = now.getTime() - LIVE_RETAIN_MS;
  const survivors: typeof removable = [];
  for (const one of removable) {
    if (one.ageAnchorMs <= cutoff) {
      removeLiveFile(root, one.fileName);
      removed.push(one.fileName);
    } else {
      survivors.push(one);
    }
  }
  // Oldest-first beyond the bound — still never touching an active run.
  for (let index = 0; index < survivors.length - LIVE_FILE_BOUND; index += 1) {
    const one = survivors[index] as { fileName: string };
    removeLiveFile(root, one.fileName);
    removed.push(one.fileName);
  }
  return { removed };
}
