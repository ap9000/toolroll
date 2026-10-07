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

import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { scanForSecrets } from "./evidence.js";

export const LIVE_LINE_CAP = 2 * 1024;
export const LIVE_FILE_CAP = 2 * 1024 * 1024;
export const LIVE_CAP_MARKER = "[the live view stopped at its size cap — the run record continues]";
export const LIVE_REDACTED_LINE = "[a credential-shaped line was redacted]";
/** Finalized runs keep their live file this long for the final drain. */
export const LIVE_RETAIN_MS = 24 * 60 * 60 * 1000;
/** The bounded sweep: at most this many FINALIZED files survive a pass. */
export const LIVE_FILE_BOUND = 500;

export function liveDir(root: string): string {
  return join(root, "live");
}

/** The exact filename, from the numeric id and nothing else — no user
 * input is ever parsed into this path. */
export function liveLogPath(root: string, runId: number): string {
  return join(liveDir(root), `${Math.trunc(runId)}.log`);
}

/**
 * The fixed tool vocabulary. Known harness tools map to OUR kinds and
 * phrases; anything unrecognized gets the generic one. The tool's own
 * name, arguments, and metadata never reach the file: a tool named after
 * a secret stays unspoken.
 */
export type LiveActivityKind = "session" | "message" | "edit" | "command" | "read" | "search" | "lookup" | "plan" | "delegate" | "tool";
export const LIVE_ACTIVITY_KINDS: readonly LiveActivityKind[] = ["session", "message", "edit", "command", "read", "search", "lookup", "plan", "delegate", "tool"];
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
const KIND_HEADLINES: Readonly<Record<LiveActivityKind, string>> = {
  session: "the agent session started",
  message: "",
  edit: "→ editing files",
  command: "→ running a command",
  read: "→ reading the code",
  search: "→ searching the code",
  lookup: "→ looking something up",
  plan: "→ organizing its plan",
  delegate: "→ delegating to a helper",
  tool: "→ using a tool",
};
const toolKind = (name: unknown): LiveActivityKind => TOOL_KINDS.get(typeof name === "string" ? name : "") ?? "tool";

/**
 * What one stream event says the agent just did, as one fixed kind: the
 * last-activity line's only input. Never text, names or arguments; an
 * event that says nothing (results, deltas, subagent chatter) is null.
 */
export function liveActivityKind(event: Record<string, unknown>): LiveActivityKind | null {
  try {
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
    const parent = event["parent_tool_use_id"];
    if (parent !== undefined && parent !== null) return null;
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

/**
 * One stream event → zero or more display lines, in the fixed vocabulary.
 * Assistant TEXT is the agent's own words (sanitized below); tool use is a
 * headline; everything else — tool results, deltas, results, subagent
 * chatter — renders nothing in v1.
 */
export function renderTranscriptLines(event: Record<string, unknown>): string[] {
  const type = String(event["type"] ?? "");
  if (type === "system" && String(event["subtype"] ?? "") === "init") {
    return ["the agent session started"];
  }
  // Codex-shaped streams (peek): a thread starts, items complete.
  if (type === "thread.started") return ["the agent session started"];
  if (type === "item.completed") {
    const item = event["item"] as Record<string, unknown> | undefined;
    const kind = item === undefined ? "" : String(item["type"] ?? "");
    if (kind === "agent_message") {
      const text = item?.["text"];
      return typeof text === "string" ? text.split("\n").filter(one => one.trim() !== "") : [];
    }
    if (kind === "command_execution") return ["→ running a command"];
    if (kind === "file_change") return ["→ editing files"];
    if (kind === "web_search") return ["→ looking something up"];
    return [];
  }
  // Gemini-shaped streams (peek): whole assistant messages, never deltas.
  if (type === "init") return ["the agent session started"];
  if (type === "message" && String(event["role"] ?? "") === "assistant" && event["delta"] !== true) {
    const content = event["content"];
    return typeof content === "string" ? content.split("\n").filter(one => one.trim() !== "") : [];
  }
  if (type === "tool_call" || type === "tool_use") {
    const name = event["name"] ?? (event["tool"] as Record<string, unknown> | undefined)?.["name"];
    return [KIND_HEADLINES[toolKind(name)]];
  }
  if (type !== "assistant") return [];
  // Top-level only: a subagent's words are not this run's transcript.
  const parent = event["parent_tool_use_id"];
  if (parent !== undefined && parent !== null) return [];
  const message = event["message"] as Record<string, unknown> | undefined;
  const content = message?.["content"];
  if (!Array.isArray(content)) return [];
  const lines: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    if (block === null || typeof block !== "object") continue;
    const kind = String(block["type"] ?? "");
    if (kind === "text") {
      const text = block["text"];
      if (typeof text === "string" && text.trim() !== "") {
        for (const one of text.split("\n")) {
          if (one.trim() !== "") lines.push(one);
        }
      }
    } else if (kind === "tool_use") {
      const name = block["name"];
      lines.push(KIND_HEADLINES[toolKind(name)]);
    }
  }
  return lines;
}

/** Sanitize one display line: strip, redact whole on any secret hit, cap. */
export function sanitizeTranscriptLine(line: string): string {
  const stripped = stripControls(line);
  if (scanForSecrets(stripped).length > 0) return LIVE_REDACTED_LINE;
  return capBytes(stripped, LIVE_LINE_CAP);
}

export type LiveLog = {
  observe(event: Record<string, unknown>): void;
  close(): void;
};

/**
 * Open the run's live file for appending. The directory is 0700, the file
 * 0600 and CREATED HERE (O_EXCL: a name that already exists — whatever put
 * it there — is refused, not appended to), opened O_NOFOLLOW with the
 * descriptor retained for the run's whole duration. Returns null on any
 * failure: no live view is ever worth a build.
 */
export function openLiveLog(root: string, runId: number): LiveLog | null {
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
  let written = 0;
  let capped = false;
  let closed = false;

  const append = (line: string): void => {
    if (closed || capped) return;
    const payload = Buffer.from(`${line}\n`, "utf8");
    // The marker is RESERVED inside the cap: whatever remains must still fit it.
    const markerBytes = Buffer.byteLength(`${LIVE_CAP_MARKER}\n`, "utf8");
    if (written + payload.length + markerBytes > LIVE_FILE_CAP) {
      capped = true;
      try {
        writeSync(fd, `${LIVE_CAP_MARKER}\n`);
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

  return {
    observe(event: Record<string, unknown>): void {
      try {
        for (const line of renderTranscriptLines(event)) {
          append(sanitizeTranscriptLine(line));
        }
      } catch {
        // Rendering is observational; a malformed event renders nothing.
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
    },
  };
}

export type LiveWindowRead =
  | { ok: true; text: string; nextOffset: number; eof: boolean }
  | { ok: false; reason: "missing" | "replaced" | "unreadable" };

const READ_WINDOW = 64 * 1024;
const READ_LOOKAHEAD = 2 * 1024;

/**
 * Read the live file from a byte offset, returning only COMPLETE lines
 * (through the last LF in the window). The descriptor is the authority:
 * opened O_NOFOLLOW, proved a regular file, measured and read through
 * itself. A file smaller than the offset was replaced — the caller resets,
 * visibly, never silently duplicating (arc 1 §4). `allowTail` (the final
 * drain) returns the unterminated tail after finalization.
 */
export function readLiveWindow(root: string, runId: number, from: number, allowTail = false): LiveWindowRead {
  if (!Number.isSafeInteger(from) || from < 0) return { ok: false, reason: "unreadable" };
  let fd: number;
  try {
    fd = openSync(liveLogPath(root, runId), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: "unreadable" };
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
    if (lastLf === -1) {
      if (allowTail && eofReached && offset > 0) {
        return { ok: true, text: chunk.toString("utf8"), nextOffset: from + offset, eof: true };
      }
      return { ok: true, text: "", nextOffset: from, eof: eofReached && offset === 0 };
    }
    if (allowTail && eofReached && lastLf + 1 < offset) {
      return { ok: true, text: chunk.toString("utf8"), nextOffset: from + offset, eof: true };
    }
    const complete = chunk.subarray(0, lastLf + 1);
    return { ok: true, text: complete.toString("utf8"), nextOffset: from + lastLf + 1, eof: from + lastLf + 1 >= size };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    closeSync(fd);
  }
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
    const match = /^(\d{1,15})\.log$/.exec(name);
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
