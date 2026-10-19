/**
 * The live conversation's records (docs/plans/live-conversation.md): what a
 * running agent said and did, one JSON object per line of `live/<run>.jsonl`.
 *
 * The recorder turns provider stream events into records. It names a step's
 * target only from a closed list of argument fields, keeps a command's text
 * and output only when the project turned "Show commands in the live view"
 * on (the `commands` tier), and never writes a tool's own name — only our
 * fixed kind. Every string is redacted, then cleaned of controls, then cut.
 * The redaction is best effort; the opt-in is the real control.
 *
 * Readers trust nothing they read back: `parseLiveRecord` re-checks shape,
 * caps and redaction, since the machine running the agent could alter the
 * file. Display state, never evidence.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { scanForSecrets } from "./evidence.js";

/**
 * The fixed tool vocabulary: known harness tools map to OUR kinds; anything
 * unrecognized is "tool". The tool's own name never reaches the file.
 */
export type LiveActivityKind = "session" | "message" | "edit" | "command" | "read" | "search" | "lookup" | "plan" | "delegate" | "tool";
export const LIVE_ACTIVITY_KINDS: readonly LiveActivityKind[] = ["session", "message", "edit", "command", "read", "search", "lookup", "plan", "delegate", "tool"];

/** What a run's live file may hold: the base tier, or commands too (the project setting, read at open). */
export type LiveDetail = "base" | "commands";

/** One record. `at` is when the recorder saw it (ISO). */
export type LiveRecord =
  /** The file's first record: what this run's project allowed when it started, kept with the run. */
  | { k: "open"; at: string; detail: LiveDetail }
  | { k: "start"; at: string }
  | { k: "say"; at: string; t: string[] }
  | { k: "step"; at: string; id: string; kind: LiveActivityKind; target?: string; once?: true }
  | { k: "done"; at: string; id: string; ok: boolean | null; out?: string[] }
  | { k: "cut"; at: string }
  | { k: "cap"; at: string };

/** A record's serialized size limit: a longer one is replaced by `cut`. */
export const LIVE_RECORD_CAP = 8 * 1024;
const LINE_CAP = 2 * 1024;
const COMMAND_CAP = 300;
const SHORT_CAP = 120;
const OUT_LINES = 20;
const OUT_BYTES = 4 * 1024;
const OPEN_STEPS_CAP = 64;
/** A `say` record is split before it grows past this many bytes or lines (the reader's own limits). */
const SAY_CHUNK = 6 * 1024;
const SAY_LINES = 400;

export const HIDDEN_TARGET = "[hidden]";
export const HIDDEN_LINE = "[a line was hidden]";
export const HIDDEN_KEY_BLOCK = "[a key block was hidden]";
export const OUTSIDE_PROJECT = "a file outside the project";
export const SOME_FILE = "a file";

/* ---------- redaction and cleaning ---------- */

/**
 * The live view's own shapes, beside the evidence scanner's high-confidence
 * ones: generic `key = value` credentials, auth headers, and URLs carrying
 * credentials. Over-hiding is the accepted cost here — this is a display.
 */
const LIVE_SECRET_SHAPES: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9])[A-Za-z0-9_.-]*?(?:pass(?:word|wd)?|secret|token|api[_-]?key|authorization|auth|bearer|credentials?|private[_-]?key|session(?:[_-]?(?:id|key|token))?|cookie)["']?\s*[:=]\s*\S/i,
  /\bauthorization\s*:/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i,
  /[?&](?:access_token|token|key|api_key|apikey|secret|sig|signature|password|pwd|auth|code)=[^&\s]+/i,
];
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/** A line that is only a long run of mixed-case base64 — a key body whose BEGIN line was elsewhere (a hash is not). */
function keyBodyShaped(line: string): boolean {
  const bare = line.trim();
  return bare.length >= 24 && /^[A-Za-z0-9+/]+={0,2}$/.test(bare) && /[A-Z]/.test(bare) && /[a-z]/.test(bare) && /[0-9]/.test(bare);
}

/** Whether a line looks like it carries a credential (best effort). */
export function liveSecretHit(line: string): boolean {
  if (scanForSecrets(line).length > 0) return true;
  return keyBodyShaped(line) || LIVE_SECRET_SHAPES.some(shape => shape.test(line));
}

/** Controls, ANSI escapes and bidi overrides out; tabs to spaces. */
export function cleanLiveText(text: string): string {
  return text
    // Escape sequences in every form: CSI (7- or 8-bit, any parameter bytes including ':'), OSC, and the rest.
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:\x1b\]|\u009d)[^\x07\x1b\u009c]*(?:\x07|\x1b\\|\u009c)?/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/\t/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    // Every invisible format character (zero-width, direction marks and overrides, joiners, BOM): never shown.
    .replace(/\p{Cf}/gu, "")
    .replace(BIDI_CONTROLS, "");
}

/** Letters, digits and dashes only, after folding look-alike letters and dashes. */
const reduceForm = (text: string): string =>
  text.normalize("NFKC").replace(/[\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/g, "-").toUpperCase().replace(/[^A-Z0-9-]/g, "");

/** An escape a line ended in the middle of, which the next line finishes: CSI, OSC, or a bare ESC. */
export type EscapeCarry = "" | "C" | "O" | "E";
const CSI_ANY = /(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
/** The part of a line that only finishes the escape the previous line began: never shown, never text. */
function finishEscape(line: string, carry: EscapeCarry): { rest: string; carry: EscapeCarry } {
  if (carry === "C") {
    const done = /^[0-?]*[ -/]*[@-~]/.exec(line);
    return done === null ? { rest: "", carry: /^[0-?]*[ -/]*$/.test(line) ? "C" : "" } : { rest: line.slice(done[0].length), carry: "" };
  }
  if (carry === "O") {
    const done = /^[^\x07\x1b\u009c]*(?:\x07|\x1b\\|\u009c)/.exec(line);
    return done === null ? { rest: "", carry: "O" } : { rest: line.slice(done[0].length), carry: "" };
  }
  if (carry === "E") return { rest: line.slice(1), carry: "" };
  return { rest: line, carry: "" };
}
/** Whether a line ends inside an escape the next line must finish. */
function escapeLeftOpen(line: string): EscapeCarry {
  if (/(?:\x1b\[|\u009b)[0-?]*[ -/]*$/.test(line)) return "C";
  if (/(?:\x1b\]|\u009d)[^\x07\x1b\u009c]*$/.test(line)) return "O";
  return /\x1b$/.test(line) ? "E" : "";
}

/**
 * The ways one line can be read when judging where a key block begins or
 * ends: exactly as it will be shown (cleaned, with the escape the previous
 * line left open finished first), with only colour sequences removed, and
 * raw with every escape's payload kept. A block opens if ANY reading shows a
 * BEGIN, and closes only if EVERY reading agrees it has ended — so a marker
 * hidden in, split by, or faked inside an escape never lets a key body
 * through. Over-hiding is the accepted cost.
 */
const boundaryForms = (line: string, carry: EscapeCarry): string[] => {
  const finished = finishEscape(line, carry).rest;
  return [
    reduceForm(cleanLiveText(finished)),
    reduceForm(finished.replace(CSI_ANY, "")),
    reduceForm(line),
  ];
};
/**
 * Every BEGIN and END marker in a line, in order. BEGIN counts with any label (or none); END only as a whole END line
 * — its label and closing dashes — so a header's own trailing dashes never read as one.
 */
const KEY_MARKERS = /-{5}(BEGIN|END[A-Z0-9-]*?-{5})/g;

/** Cut to at most `cap` UTF-8 bytes on a character boundary, "…" when cut. */
export function capLive(text: string, cap: number): string {
  if (Buffer.byteLength(text, "utf8") <= cap) return text;
  let out = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > cap - 3) break;
    out += char;
    bytes += size;
  }
  return `${out}…`;
}

/** One line for the view: redacted whole when it hits, then cleaned and cut. */
export function liveLine(raw: string, cap = LINE_CAP): string {
  const clean = cleanLiveText(raw);
  if (liveSecretHit(raw) || liveSecretHit(clean)) return HIDDEN_LINE;
  return capLive(clean, cap);
}

/** A target: `[hidden]` when it hits, else cleaned and cut. Empty → null. */
function liveTarget(raw: string, cap: number): string | null {
  const clean = cleanLiveText(raw).trim();
  if (clean === "") return null;
  if (liveSecretHit(raw) || liveSecretHit(clean)) return HIDDEN_TARGET;
  return capLive(clean, cap);
}

/**
 * Lines redacted as a whole: each line on its own, and a key block hidden
 * from its BEGIN line to its END (or to the end) as one line. Used for the
 * agent's words, command output, and everything read back.
 */
/**
 * Whether reading is inside a key block: carried from line to line, record to
 * record and — through the reader's cursor — from one read to the next, so a
 * block split anywhere stays hidden.
 */
export type KeyState = {
  inKey: boolean;
  /** Per reading, how much of "-----BEGIN" the stream has ended on so far, then the escape the last line left open:
   * marker characters and one flag only, never content, so it may ride the cursor. Joined with "|" when carried. */
  tail?: string;
};

const BEGIN_WORD = "-----BEGIN";
/** The longest end of `text` that starts "-----BEGIN" without completing it — all a split opener needs carried. */
function beginPrefix(text: string): string {
  for (let size = Math.min(text.length, BEGIN_WORD.length - 1); size > 0; size -= 1) {
    const end = text.slice(-size);
    if (BEGIN_WORD.startsWith(end)) return end;
  }
  return "";
}

/** Whether a carried tail is one this code could have produced: three BEGIN prefixes and an escape flag, or nothing. */
export function validKeyTail(tail: string): boolean {
  if (tail === "") return true;
  const parts = tail.split("|");
  if (parts.length !== 4) return false;
  return parts.slice(0, 3).every(part => part.length < BEGIN_WORD.length && BEGIN_WORD.startsWith(part)) && ["", "C", "O", "E"].includes(parts[3]!);
}

export function redactLiveLines(lines: readonly string[], state: KeyState = { inKey: false }): string[] {
  const out: string[] = [];
  for (const line of lines) {
    // Each reading is one stream across line breaks (and reads): markers are found in order wherever they are split,
    // an END then a BEGIN on one line opens a block again, a block opens if ANY reading opens it and closes only if
    // EVERY reading closes it.
    const startedInKey = state.inKey;
    const carried = validKeyTail(state.tail ?? "") && (state.tail ?? "") !== "" ? state.tail!.split("|") : ["", "", "", ""];
    const escape = carried[3] as EscapeCarry;
    const nextTails: string[] = [];
    let opened = false, stillIn = false;
    boundaryForms(line, escape).forEach((form, reading) => {
      const prefix = carried[reading] ?? "";
      const stream = `${prefix}${form}`;
      let inKey = startedInKey;
      for (const marker of stream.matchAll(KEY_MARKERS)) {
        const end = marker.index! + marker[0].length;
        if (end <= prefix.length) continue;
        // A BEGIN may be split across lines; an END counts only within this line.
        if (marker[1] === "BEGIN") { inKey = true; opened = true; } else if (marker.index! >= prefix.length) inKey = false;
      }
      stillIn ||= inKey;
      nextTails.push(beginPrefix(stream));
    });
    const leftOpen = escape === "" ? escapeLeftOpen(line) : finishEscape(line, escape).carry || escapeLeftOpen(finishEscape(line, escape).rest);
    nextTails.push(leftOpen);
    state.tail = nextTails.join("|");
    state.inKey = stillIn;
    if (startedInKey) continue; // a line inside a block is never shown, whatever it holds
    if (line === HIDDEN_KEY_BLOCK || line === HIDDEN_LINE) {
      out.push(line);
      continue;
    }
    if (opened) {
      out.push(HIDDEN_KEY_BLOCK);
      continue;
    }
    out.push(liveLine(line));
  }
  return out;
}

/**
 * Output for a command step: every line redacted first (a key block hidden
 * from its BEGIN line to its END, or to the end), then the last 20 lines
 * within 4 KiB — truncation never comes before redaction.
 */
export function liveOutput(raw: string, keys: KeyState = { inKey: false }): string[] {
  const redacted = redactLiveLines(raw.split(/\r?\n/), keys);
  while (redacted.length > 0 && redacted[redacted.length - 1]!.trim() === "") redacted.pop();
  const kept: string[] = [];
  let bytes = 0;
  for (let index = redacted.length - 1; index >= 0 && kept.length < OUT_LINES; index -= 1) {
    const one = redacted[index]!;
    const size = Buffer.byteLength(one, "utf8") + 1;
    if (bytes + size > OUT_BYTES) break;
    kept.unshift(one);
    bytes += size;
  }
  return kept;
}

/**
 * A target under the key-block rule: hidden while a block is open. A target is one argument (a search pattern, a
 * path), never part of the conversation's text, so it neither opens nor closes a block — searching for "-----BEGIN"
 * is a search, not a key — and a target that itself looks like a marker or a secret is hidden.
 */
function keyedTarget(target: string | null, keys: KeyState): string | null {
  if (target === null || target === HIDDEN_TARGET) return target;
  if (keys.inKey) return HIDDEN_TARGET;
  const [shown] = redactLiveLines([target], { ...keys });
  return shown === HIDDEN_KEY_BLOCK || shown === HIDDEN_LINE ? HIDDEN_TARGET : target;
}

/* ---------- targets ---------- */

/**
 * A path as the view shows it: relative to the run's own checkout when it
 * lies inside it, judged lexically — nothing is opened or resolved on disk.
 */
export function livePath(base: string | null, given: unknown): string | null {
  if (typeof given !== "string" || given.trim() === "") return null;
  if (base === null) return SOME_FILE;
  const full = resolve(base, given);
  const shown = relative(base, full);
  if (shown === "" || isAbsolute(shown) || shown === ".." || shown.startsWith(`..${sep}`)) return OUTSIDE_PROJECT;
  return liveTarget(shown.split(sep).join("/"), LINE_CAP);
}

/** `bash -lc '…'` and friends, unwrapped for display only. */
function unwrapShell(command: string): string {
  const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim());
  return wrapped === null ? command : wrapped[2]!;
}

/** A command's first line, "…" when more followed or it was cut. */
export function liveCommand(given: unknown): string | null {
  const text = Array.isArray(given) ? given.filter(one => typeof one === "string").join(" ") : given;
  if (typeof text !== "string") return null;
  const lines = unwrapShell(text).split(/\r?\n/).filter(one => one.trim() !== "");
  if (lines.length === 0) return null;
  if (lines.some(one => liveSecretHit(one))) return HIDDEN_TARGET;
  const first = liveTarget(lines[0]!, COMMAND_CAP);
  if (first === null || first === HIDDEN_TARGET) return first;
  return lines.length > 1 && !first.endsWith("…") ? `${first} …` : first;
}

/** A URL's host only: no scheme, userinfo, port, path or query. */
function liveHost(given: unknown): string | null {
  if (typeof given !== "string") return null;
  try {
    const host = new URL(given).hostname;
    return host === "" ? null : liveTarget(host, SHORT_CAP);
  } catch {
    return null;
  }
}

const short = (given: unknown): string | null => (typeof given === "string" ? liveTarget(given.split(/\r?\n/)[0] ?? "", SHORT_CAP) : null);

/** Claude tools: our kind, and whether it is a command. */
const CLAUDE_KINDS: ReadonlyMap<string, LiveActivityKind> = new Map([
  ["Edit", "edit"], ["Write", "edit"], ["MultiEdit", "edit"], ["NotebookEdit", "edit"],
  ["Bash", "command"], ["Read", "read"], ["LS", "read"], ["Glob", "search"], ["Grep", "search"],
  ["WebFetch", "lookup"], ["WebSearch", "lookup"], ["TodoWrite", "plan"], ["Task", "delegate"],
]);

function claudeTarget(name: string, input: Record<string, unknown>, base: string | null, commands: boolean): string | null {
  switch (name) {
    case "Edit": case "Write": case "MultiEdit": case "Read":
      return livePath(base, input["file_path"]);
    case "NotebookEdit":
      return livePath(base, input["notebook_path"]);
    case "Grep": case "Glob":
      return short(input["pattern"]);
    case "WebFetch":
      return liveHost(input["url"]);
    case "WebSearch":
      return short(input["query"]);
    case "Task":
      return short(input["description"]);
    case "Bash":
      return commands ? liveCommand(input["command"]) : null;
    default:
      return null;
  }
}

/* ---------- the recorder ---------- */

export type LiveRecorderOptions = {
  /** The run's own checkout; null when it has none (every path is "a file"). */
  base: string | null;
  /** The project's "Show commands in the live view" setting, read at open. */
  commands: boolean;
  clock?: () => Date;
};

export type LiveRecorder = {
  /** The records one stream event adds. Never throws. */
  observe(event: Record<string, unknown>): LiveRecord[];
  /** The process ended: every step still open closes unknown. */
  end(): LiveRecord[];
};

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const providerId = (value: unknown): string | null => (typeof value === "string" && value !== "" && value.length <= 200 ? value : null);

/** A Claude tool_result's text, whatever its shape. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => object(part))
    .filter((part): part is Record<string, unknown> => part !== null && part["type"] === "text" && typeof part["text"] === "string")
    .map(part => String(part["text"]))
    .join("\n");
}

export function createLiveRecorder(options: LiveRecorderOptions): LiveRecorder {
  const clock = options.clock ?? (() => new Date());
  let sequence = 0;
  /** A key block the agent began in one message stays hidden through the next, until it ends or a new session starts. */
  const keyState = { inKey: false };
  /** Provider call id → our step, while it is open. */
  const open = new Map<string, { id: string; kind: LiveActivityKind }>();

  const stamp = (): string => clock().toISOString();
  const closeAll = (at: string): LiveRecord[] => {
    const closed: LiveRecord[] = [...open.values()].map(step => ({ k: "done" as const, at, id: step.id, ok: null }));
    open.clear();
    return closed;
  };
  const openStep = (at: string, call: string | null, kind: LiveActivityKind, target: string | null): LiveRecord[] => {
    if (call !== null && open.has(call)) return []; // a duplicate open is ignored
    const id = `s${++sequence}`;
    const keyed = keyedTarget(target, keyState);
    const step: LiveRecord = { k: "step", at, id, kind, ...(keyed === null ? {} : { target: keyed }) };
    if (call === null) return [{ ...step, once: true } as LiveRecord];
    if (open.size >= OPEN_STEPS_CAP) return [{ ...step, once: true } as LiveRecord];
    open.set(call, { id, kind });
    return [step];
  };
  const say = (at: string, text: string): LiveRecord[] => {
    const records: LiveRecord[] = [];
    let chunk: string[] = [];
    let bytes = 0;
    for (const line of redactLiveLines(text.split(/\r?\n/).filter(raw => raw.trim() !== ""), keyState)) {
      const size = Buffer.byteLength(line, "utf8") + 4;
      if (chunk.length > 0 && (bytes + size > SAY_CHUNK || chunk.length >= SAY_LINES)) {
        records.push({ k: "say", at, t: chunk });
        chunk = [];
        bytes = 0;
      }
      chunk.push(line);
      bytes += size;
    }
    if (chunk.length > 0) records.push({ k: "say", at, t: chunk });
    return records;
  };

  const claude = (event: Record<string, unknown>, at: string): LiveRecord[] => {
    const type = event["type"];
    // A subagent's words, tools, turns and sessions are not this run's conversation — and never close its steps.
    const parent = event["parent_tool_use_id"];
    if (parent !== undefined && parent !== null) return [];
    if (type === "system") return event["subtype"] === "init" ? (keyState.inKey = false, [...closeAll(at), { k: "start", at }]) : [];
    if (type === "result") return closeAll(at);
    const content = object(event["message"])?.["content"];
    if (!Array.isArray(content)) return [];
    const records: LiveRecord[] = [];
    for (const part of content) {
      const block = object(part);
      if (block === null) continue;
      if (type === "assistant" && block["type"] === "text" && typeof block["text"] === "string") {
        records.push(...say(at, block["text"]));
      } else if (type === "assistant" && block["type"] === "tool_use") {
        const name = typeof block["name"] === "string" ? block["name"] : "";
        const kind = CLAUDE_KINDS.get(name) ?? "tool";
        records.push(...openStep(at, providerId(block["id"]), kind, claudeTarget(name, object(block["input"]) ?? {}, options.base, options.commands)));
      } else if (type === "user" && block["type"] === "tool_result") {
        const call = providerId(block["tool_use_id"]);
        const step = call === null ? undefined : open.get(call);
        if (step === undefined) continue; // a close for an unknown id is dropped
        open.delete(call!);
        const out = options.commands && step.kind === "command" ? liveOutput(resultText(block["content"]), keyState) : [];
        records.push({ k: "done", at, id: step.id, ok: block["is_error"] !== true, ...(out.length > 0 ? { out } : {}) });
      }
    }
    return records;
  };

  const codexKind = (type: unknown): LiveActivityKind | null =>
    type === "command_execution" ? "command" : type === "file_change" ? "edit" : type === "web_search" ? "lookup" : type === "mcp_tool_call" ? "tool" : null;
  const codexTarget = (item: Record<string, unknown>): string | null => {
    switch (item["type"]) {
      case "command_execution":
        return options.commands ? liveCommand(item["command"]) : null;
      case "web_search":
        return short(item["query"]);
      case "file_change": {
        const changes = Array.isArray(item["changes"]) ? item["changes"].map(object).filter(one => one !== null) : [];
        const first = changes.length === 0 ? null : livePath(options.base, changes[0]!["path"]);
        if (first === null) return null;
        return changes.length > 1 ? `${first} and ${changes.length - 1} more` : first;
      }
      default:
        return null;
    }
  };
  const codexOk = (item: Record<string, unknown>): boolean | null => {
    if (item["type"] === "command_execution") {
      const code = item["exit_code"];
      return typeof code === "number" ? code === 0 : null;
    }
    return item["status"] === "completed" ? true : item["status"] === "failed" ? false : null;
  };

  const codex = (event: Record<string, unknown>, at: string): LiveRecord[] => {
    const type = event["type"];
    if (type === "thread.started") return [...closeAll(at), { k: "start", at }];
    if (type === "turn.completed" || type === "turn.failed") return closeAll(at);
    const item = object(event["item"]);
    if (item === null) return [];
    if (type === "item.completed" && item["type"] === "agent_message") {
      return typeof item["text"] === "string" ? say(at, item["text"]) : [];
    }
    const kind = codexKind(item["type"]);
    if (kind === null) return [];
    const call = providerId(item["id"]);
    if (type === "item.started") return openStep(at, call, kind, codexTarget(item));
    if (type !== "item.completed") return [];
    const records: LiveRecord[] = [];
    let step = call === null ? undefined : open.get(call);
    // An item that completes without having started (a file change) opens and closes at once.
    if (step === undefined) {
      if (call === null || open.size >= OPEN_STEPS_CAP) return openStep(at, null, kind, codexTarget(item));
      records.push(...openStep(at, call, kind, codexTarget(item)));
      step = open.get(call);
      if (step === undefined) return records;
    }
    open.delete(call!);
    const out = options.commands && kind === "command" && typeof item["aggregated_output"] === "string" ? liveOutput(item["aggregated_output"], keyState) : [];
    records.push({ k: "done", at, id: step.id, ok: codexOk(item), ...(out.length > 0 ? { out } : {}) });
    return records;
  };

  /** Gemini: whole messages and tool headlines, no targets, nothing to pair. */
  const gemini = (event: Record<string, unknown>, at: string): LiveRecord[] | null => {
    const type = event["type"];
    if (type === "init") return [{ k: "start", at }];
    if (type === "message") {
      return event["role"] === "assistant" && event["delta"] !== true && typeof event["content"] === "string" ? say(at, event["content"]) : [];
    }
    if (type === "tool_call" || type === "tool_use") {
      const name = event["name"] ?? object(event["tool"])?.["name"];
      return openStep(at, null, CLAUDE_KINDS.get(typeof name === "string" ? name : "") ?? "tool", null);
    }
    return null;
  };

  /**
   * ACP (acp-client.ts; the runner hands each session update over as `{acp: update}`). The record format is the one
   * every dialect writes: a tool call is held — bounded — until it has a target, starts running or ends, and is then
   * shown once (OpenCode names its command only in a later update); the words of a message, which arrive in chunks,
   * are shown when the message ends (a tool call, or the end of the run).
   */
  const ACP_KINDS: Readonly<Record<string, LiveActivityKind>> = { read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", execute: "command", fetch: "lookup", think: "plan" };
  const ACP_HELD_CAP = 64;
  /** A message's words are shown in one piece when it ends — or, past this many characters, in pieces as they come:
   * every word passes the shared redaction in the order the agent wrote it, none is dropped unseen. */
  const ACP_WORDS_CAP = 16 * 1024;
  /** A line with no end in sight is flushed whole past this (it is cut to a line's length on the way out anyway). */
  const ACP_LINE_HARD_CAP = 256 * 1024;
  const held = new Map<string, { kind: LiveActivityKind; target: string | null }>();
  /** The latest output an open command showed, already redacted when it arrived (a later update may carry none). */
  const outputs = new Map<string, string[]>();
  let acpWords = "";
  /** A step came between the held unfinished line and the words after it: they are joined with one space, so a token
   * keeps the word boundary a scanner needs ("credentials ghp_…") and `key= value` still reads as one. */
  let acpSeparated = false;
  /** Past the hard cap, the rest of that one line is not shown; each piece is still read for the key-block state, in
   * order — the state itself carries a split BEGIN across pieces, and an END split across two simply keeps the block
   * hidden (never the other way). Nothing is read twice. */
  let acpSkipping = false;
  const skipRead = (text: string): void => { redactLiveLines([text], keyState); };
  /** Before anything else is written, the message's complete lines are; a partial last line waits for its own end (a
   * `key=` and its value are never split by an update arriving between them), or for the end of the run. */
  /** A message's complete lines, said in order; its unfinished last line waits for its own end (or the run's): a line
   * is only ever judged — for secrets, for key blocks — whole, as the agent wrote it. */
  const flushLines = (at: string): LiveRecord[] => {
    const cut = acpWords.lastIndexOf("\n");
    if (cut < 0) return [];
    const whole = acpWords.slice(0, cut + 1);
    acpWords = acpWords.slice(cut + 1);
    return whole.trim() === "" ? [] : say(at, whole);
  };
  /** Everything left, at the end of the run. */
  const flushWords = (at: string): LiveRecord[] => {
    const words = acpWords;
    acpWords = "";
    return words.trim() === "" ? [] : say(at, words);
  };
  /** Whether the message's unfinished line opens a key block it hasn't finished saying: until that line is judged,
   * what comes between (a step's target) is hidden — never shown on the strength of a state not yet read. */
  const heldKeyOpen = (): boolean => /BEGIN/i.test(cleanLiveText(acpWords).replace(/[^A-Za-z]/g, ""));
  const acpTarget = (kind: LiveActivityKind, update: Record<string, unknown>, before: string | null): string | null => {
    if (kind === "command") {
      const command = object(update["rawInput"])?.["command"];
      return typeof command === "string" ? (options.commands ? liveCommand(command) : null) : before;
    }
    const first = Array.isArray(update["locations"]) ? object(update["locations"][0]) : null;
    return first !== null && typeof first["path"] === "string" ? livePath(options.base, first["path"]) : before;
  };
  /** An update's command output, redacted now — in stream order, through the shared key state — or null when it has none. */
  const acpOutput = (update: Record<string, unknown>): string[] | null => {
    if (!options.commands || !Array.isArray(update["content"])) return null;
    const text = update["content"].map(object).filter(one => one !== null && one["type"] === "content")
      .map(one => object(one!["content"])).filter(block => block !== null && block["type"] === "text" && typeof block["text"] === "string")
      .map(block => block!["text"] as string).join("\n");
    // ACP sends a call's whole output again with each update — a snapshot, not a stream: each is judged on its own,
    // from a fresh key state, and never moves the message's (key bodies are hidden by their shape either way).
    return text === "" ? null : liveOutput(text, { inKey: false });
  };
  const acp = (update: Record<string, unknown>, at: string): LiveRecord[] => {
    const kind = update["sessionUpdate"];
    if (kind === "agent_message_chunk") {
      const content = object(update["content"]);
      if (content === null || content["type"] !== "text" || typeof content["text"] !== "string") return [];
      let text = content["text"];
      if (acpSkipping) {
        // The rest of a line too long to show: read for the key state, never written, until it ends.
        const end = text.indexOf("\n");
        skipRead(end < 0 ? text : text.slice(0, end));
        if (end < 0) return [];
        acpSkipping = false;
        text = text.slice(end + 1);
      }
      if (acpSeparated && acpWords !== "" && !acpWords.endsWith("\n") && text !== "" && !/^\s/.test(text)) acpWords += " ";
      // Only words actually written settle the break: an empty chunk leaves it owed to the next.
      if (text !== "") acpSeparated = false;
      acpWords += text;
      if (acpWords.length <= ACP_WORDS_CAP) return [];
      // Flushed only at a line's end, so nothing the redaction reads (a key block's BEGIN, a `key=` and its value) is
      // ever split across two pieces; the partial last line waits for the rest of itself.
      const cut = acpWords.lastIndexOf("\n");
      if (cut >= 0) {
        const whole = acpWords.slice(0, cut + 1);
        acpWords = acpWords.slice(cut + 1);
        return whole.trim() === "" ? [] : say(at, whole);
      }
      if (acpWords.length <= ACP_LINE_HARD_CAP) return [];
      // One line with no end in sight: it is not shown — said once — and its rest is only read.
      acpSkipping = true;
      skipRead(acpWords);
      acpWords = "";
      return [{ k: "cut", at }];
    }
    // A tool call or a permission answer is where the agent's message ends: its words go first, whole. Any other
    // update (usage, a plan, a mode) is not: only the message's complete lines go before it, so a line in progress —
    // a `key=` and the value still to come — is never split by one.
    // Anything else comes after the message's complete lines; an unfinished line waits for its end, whatever arrives.
    const records: LiveRecord[] = flushLines(at);
    if (kind === "tool_call" || kind === "permission") acpSeparated = true;
    if (kind === "permission") {
      // A request's title is free text (a command, a path anywhere): only the answer is shown.
      return [...records, ...openStep(at, null, "tool", update["granted"] === true ? "allowed once" : "refused")];
    }
    if (kind !== "tool_call" && kind !== "tool_call_update") return records;
    const call = providerId(update["toolCallId"]);
    if (call === null) return records;
    const status = update["status"];
    const ended = status === "completed" || status === "failed";
    const shown = open.get(call);
    const before = held.get(call);
    const stepKind = typeof update["kind"] === "string" ? ACP_KINDS[update["kind"]] ?? "tool" : shown?.kind ?? before?.kind ?? "tool";
    // Output is read (and so redacted, in order) whatever the call, but kept only for a call shown or held — bounded
    // by them — so an untracked or overflowing call leaves nothing behind.
    const output = stepKind === "command" ? acpOutput(update) : null;
    if (output !== null && (shown !== undefined || before !== undefined || kind === "tool_call")) outputs.set(call, output);
    const done = (step: { id: string }): LiveRecord => {
      const out = outputs.get(call) ?? [];
      outputs.delete(call);
      return { k: "done", at, id: step.id, ok: status === "completed", ...(out.length > 0 ? { out } : {}) };
    };
    if (shown !== undefined) {
      if (!ended) return records;
      open.delete(call);
      return [...records, done(shown)];
    }
    if (before === undefined && kind === "tool_call_update") { outputs.delete(call); return records; }
    const named = acpTarget(stepKind, update, before?.target ?? null);
    const target = named !== null && heldKeyOpen() ? HIDDEN_TARGET : named;
    if (target === null && status !== "in_progress" && !ended) {
      if (before !== undefined || held.size < ACP_HELD_CAP) held.set(call, { kind: stepKind, target });
      else { outputs.delete(call); records.push(...openStep(at, null, stepKind, null)); }
      return records;
    }
    held.delete(call);
    const opened = openStep(at, call, stepKind, target);
    // A step shown "once" (past the open-step cap) is never closed by id: nothing of it is kept.
    if (!open.has(call)) outputs.delete(call);
    if (!ended) return [...records, ...opened];
    // Shown and ended at once: a step and its result.
    const step = open.get(call);
    if (step === undefined) { outputs.delete(call); return [...records, ...opened]; }
    open.delete(call);
    return [...records, ...opened, done(step)];
  };
  const acpEnd = (at: string): LiveRecord[] => {
    const records = flushWords(at);
    for (const [, one] of held) records.push(...openStep(at, null, one.kind, one.target));
    held.clear();
    outputs.clear();
    acpSkipping = false;
    return records;
  };

  return {
    observe(event) {
      try {
        const at = stamp();
        const acpUpdate = object(event["acp"]);
        if (acpUpdate !== null) return acp(acpUpdate, at);
        const type = event["type"];
        if (type === "system" || type === "assistant" || type === "user" || type === "result") return claude(event, at);
        if (typeof type === "string" && (type.startsWith("thread.") || type.startsWith("turn.") || type.startsWith("item."))) return codex(event, at);
        return gemini(event, at) ?? [];
      } catch {
        return [];
      }
    },
    end() {
      try {
        const at = stamp();
        return [...acpEnd(at), ...closeAll(at)];
      } catch {
        return [];
      }
    },
  };
}

/** One record as its file line; an oversized one becomes `cut`. */
export function serializeLiveRecord(record: LiveRecord): string {
  const line = JSON.stringify(record);
  return Buffer.byteLength(line, "utf8") <= LIVE_RECORD_CAP ? line : JSON.stringify({ k: "cut", at: record.at });
}

/* ---------- reading back ---------- */

const KINDS = new Set<string>(LIVE_ACTIVITY_KINDS);
const STEP_ID = /^s[1-9][0-9]{0,8}$/;
const strings = (value: unknown, max: number): string[] | null =>
  Array.isArray(value) && value.length <= max && value.every(one => typeof one === "string") ? (value as string[]) : null;

/**
 * One file line back into a record, strictly: a known shape within its caps,
 * every string redacted and cleaned again. Anything else is null — skipped,
 * never shown raw.
 */
export function parseLiveRecord(line: string, keys: KeyState = { inKey: false }): LiveRecord | null {
  if (line === "" || Buffer.byteLength(line, "utf8") > LIVE_RECORD_CAP) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const record = object(value);
  if (record === null) return null;
  const at = record["at"];
  if (typeof at !== "string" || at.length > 40 || (at !== "" && Number.isNaN(Date.parse(at)))) return null;
  switch (record["k"]) {
    case "start": case "cut": case "cap":
      return { k: record["k"], at };
    case "open":
      return record["detail"] === "base" || record["detail"] === "commands" ? { k: "open", at, detail: record["detail"] } : null;
    case "say": {
      const t = strings(record["t"], SAY_LINES);
      if (t === null || t.length === 0) return null;
      return { k: "say", at, t: redactLiveLines(t, keys) };
    }
    case "step": {
      const id = record["id"], kind = record["kind"], target = record["target"];
      if (typeof id !== "string" || !STEP_ID.test(id) || typeof kind !== "string" || !KINDS.has(kind)) return null;
      if (target !== undefined && typeof target !== "string") return null;
      const shown = target === undefined ? null : keyedTarget(target === HIDDEN_TARGET ? HIDDEN_TARGET : liveTarget(target, COMMAND_CAP + 4), keys);
      return { k: "step", at, id, kind: kind as LiveActivityKind, ...(shown === null ? {} : { target: shown }), ...(record["once"] === true ? { once: true as const } : {}) };
    }
    case "done": {
      const id = record["id"], ok = record["ok"];
      if (typeof id !== "string" || !STEP_ID.test(id) || !(ok === true || ok === false || ok === null)) return null;
      const out = record["out"] === undefined ? [] : strings(record["out"], OUT_LINES);
      if (out === null) return null;
      const shown = redactLiveLines(out, keys);
      return { k: "done", at, id, ok, ...(shown.length > 0 ? { out: shown } : {}) };
    }
    default:
      return null;
  }
}

/** Complete file lines (a window's text) into records; bad lines are skipped. */
export function parseLiveRecords(text: string, keys: KeyState = { inKey: false }): LiveRecord[] {
  const records: LiveRecord[] = [];
  for (const line of text.split("\n")) {
    const record = parseLiveRecord(line, keys);
    if (record !== null) records.push(record);
  }
  return records;
}

/* ---------- the text projection ---------- */

export const LIVE_CAP_WORDS = "[the live view stopped at its size cap — the run record continues]";
export const LIVE_CUT_WORDS = "[a line was too long to show]";

const TARGET_WORDS: Readonly<Record<LiveActivityKind, string>> = {
  session: "the agent session started",
  message: "",
  edit: "→ editing",
  command: "→ running",
  read: "→ reading",
  search: "→ searching for",
  lookup: "→ looking up",
  plan: "→ organizing its plan",
  delegate: "→ delegating:",
  tool: "→ using a tool",
};
export const LIVE_KIND_HEADLINES: Readonly<Record<LiveActivityKind, string>> = {
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

/** A step's one line of words, with its target when it has one. */
export function stepWords(step: { kind: LiveActivityKind; target?: string }): string {
  if (step.target === undefined || step.kind === "plan" || step.kind === "tool") return LIVE_KIND_HEADLINES[step.kind];
  return `${TARGET_WORDS[step.kind]} ${step.kind === "delegate" ? step.target : `\`${step.target}\``}`;
}

/** Records as the plain lines the run page and `toolroll peek` show. */
export function projectLiveText(records: readonly LiveRecord[]): string[] {
  const lines: string[] = [];
  for (const record of records) {
    switch (record.k) {
      case "open": break;
      case "start": lines.push("the agent session started"); break;
      case "say": lines.push(...record.t); break;
      case "step": lines.push(stepWords(record)); break;
      case "done": if (record.ok === false) lines.push("  ✗ failed"); break;
      case "cut": lines.push(LIVE_CUT_WORDS); break;
      case "cap": lines.push(LIVE_CAP_WORDS); break;
    }
  }
  return lines;
}
