/**
 * The decision payload, validated (§7).
 *
 * The convention agents drift from in prose is a schema here, and the schema
 * is fail-closed: a payload missing anything a person would need on a phone
 * screen at 7am is not a decision, it is a malformed one — and the caller's
 * next move is bounded repair, not a guess at what the agent meant.
 *
 * Everything in the payload is written by an agent, which means everything in
 * it is untrusted twice over: it will be rendered into a web page, printed
 * into terminals, and — after the operator answers — quoted back into another
 * agent's brief. The caps and the control-character rejection here are the
 * first line of that defence; the escaping at each sink is the second. The
 * caps also keep one screen one screen: an option list that needs scrolling
 * has already failed the milestone sentence.
 */

import { TEXT_LIMITS } from "./text-limits.js";

export type ParsedOption = {
  id: string;
  label: string;
  consequence: string;
  reversible: boolean;
};

export type ParsedDecision = {
  urgency: "blocking";
  recap: string;
  question: string;
  options: ParsedOption[];
  recommendation: string;
  assignee: string | null;
  /** Normalized to toISOString(), like every timestamp in the store. */
  deadline: string | null;
};

export type Problem = { reason: string; message: string };

export type ParseResult =
  | { ok: true; decision: ParsedDecision }
  | { ok: false; problems: Problem[] };

/** One screen's worth, enforced rather than hoped for. */
export const LIMITS = {
  /** Bytes, before parsing. Applied by the reader too; this is the backstop. */
  payload: 64 * 1024,
  recap: 2_000,
  question: 2_000,
  consequence: 500,
  label: 120,
  optionId: 40,
  assignee: 120,
  options: 6,
  /** UTF-16 code units (TEXT_LIMITS.note: revise feedback, steering and decision notes); the byte backstop lives in validateNote. */
  note: TEXT_LIMITS.note,
} as const;

/** Bytes an operator's note may occupy — the UTF-8 backstop under LIMITS.note. */
export const NOTE_BYTE_CAP = TEXT_LIMITS.noteBytes;

/**
 * Unicode that reorders or breaks lines invisibly: bidi controls and the
 * line/paragraph separators. A note carrying these can spoof what a
 * reviewer SEES agreeing to — rejected outright, never stripped
 * (Codex free-text review, prescribed caps).
 */
const FORBIDDEN_INVISIBLES = /[\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/**
 * The one validator every note passes — before a draft persists AND inside
 * the answer CAS, which stays the final gate. Trims, then refuses empty,
 * oversized (units or bytes), control-carrying, or invisibly-reordering
 * text. Ordinary Unicode with internal newlines and tabs passes untouched.
 */
export function validateNote(raw: string): { ok: true; note: string } | { ok: false; problem: string } {
  const note = raw.trim();
  if (note === "") return { ok: false, problem: "an empty note says nothing" };
  if (note.length > LIMITS.note) return { ok: false, problem: `a note is at most ${LIMITS.note} characters` };
  if (Buffer.byteLength(note, "utf8") > NOTE_BYTE_CAP) {
    return { ok: false, problem: `a note is at most ${NOTE_BYTE_CAP} bytes` };
  }
  if (hasForbiddenControls(note) || FORBIDDEN_INVISIBLES.test(note)) {
    return { ok: false, problem: "control and direction-override characters do not travel" };
  }
  return { ok: true, note };
}

/** Option ids travel in URLs, CLI arguments, and CAS updates — they are identifiers, not prose. */
const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Multi-line prose may contain newlines and tabs; nothing anywhere in a
 * decision may contain the rest of C0/C1 — those are how text stops being
 * text and starts being terminal escape sequences.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_MULTILINE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_SINGLE_LINE = /[\u0000-\u001F\u007F-\u009F]/;

/** Whether text carries controls that could become escapes at a sink. Newlines and tabs pass. */
export function hasForbiddenControls(text: string): boolean {
  return FORBIDDEN_MULTILINE.test(text);
}

/**
 * Controls OR direction-override invisibles — the full disguise kit. For
 * text that becomes standing authority or a task identity (setup commands,
 * imported issue titles): a title reading "fix docs" while spelled
 * backwards is not a title, it is a costume.
 */
export function hasDisguisedText(text: string): boolean {
  return FORBIDDEN_MULTILINE.test(text) || FORBIDDEN_INVISIBLES.test(text);
}

export function parseDecision(raw: string): ParseResult {
  if (Buffer.byteLength(raw, "utf8") > LIMITS.payload) {
    return refuse("too-large", `the payload is over ${LIMITS.payload} bytes — one screen does not need that`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return refuse("not-json", `the payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("not-an-object", "the payload must be one JSON object");
  }

  const body = parsed as Record<string, unknown>;
  const problems: Problem[] = [];

  // Urgency is required rather than defaulted: an agent that did not say
  // whether the loop can continue has not composed a decision. Only
  // 'blocking' exists in M3 — advisory needs a commit-and-complete lifecycle
  // this park-before-commit path does not have.
  if (body["urgency"] !== "blocking") {
    problems.push({
      reason: "bad-urgency",
      message: `urgency must be the string "blocking" (got ${describe(body["urgency"])})`,
    });
  }

  const recap = prose(body["recap"], "recap", LIMITS.recap, problems);
  const question = prose(body["question"], "question", LIMITS.question, problems);
  const options = parseOptions(body["options"], problems);

  let recommendation: string | null = null;
  if (typeof body["recommendation"] !== "string" || body["recommendation"] === "") {
    problems.push({
      reason: "missing-recommendation",
      message: "recommendation is required and must be an option id — a decision without one is a shrug",
    });
  } else if (options !== null && !options.some(option => option.id === body["recommendation"])) {
    problems.push({
      reason: "bad-recommendation",
      message: `recommendation "${truncate(String(body["recommendation"]), 60)}" does not match any option id`,
    });
  } else {
    recommendation = body["recommendation"];
  }

  let assignee: string | null = null;
  if (body["assignee"] !== undefined && body["assignee"] !== null) {
    const line = singleLine(body["assignee"], "assignee", LIMITS.assignee, problems);
    if (line !== null) assignee = line;
  }

  let deadline: string | null = null;
  if (body["deadline"] !== undefined && body["deadline"] !== null) {
    const stamp = typeof body["deadline"] === "string" ? Date.parse(body["deadline"]) : NaN;
    if (Number.isNaN(stamp)) {
      problems.push({
        reason: "bad-deadline",
        message: `deadline must be an ISO 8601 timestamp (got ${describe(body["deadline"])})`,
      });
    } else {
      // Normalized so the store's lexicographic-comparison invariant holds.
      deadline = new Date(stamp).toISOString();
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    decision: {
      urgency: "blocking",
      recap: recap as string,
      question: question as string,
      options: options as ParsedOption[],
      recommendation: recommendation as string,
      assignee,
      deadline,
    },
  };
}

function parseOptions(value: unknown, problems: Problem[]): ParsedOption[] | null {
  if (!Array.isArray(value)) {
    problems.push({ reason: "no-options", message: "options must be an array" });
    return null;
  }
  if (value.length < 2) {
    // One option is not a decision, it is a notification wearing one's
    // clothes — and the operator's real alternative ("do neither") deserves
    // to be an option with a stated consequence, not an implied one.
    problems.push({ reason: "too-few-options", message: "a decision needs at least 2 options" });
    return null;
  }
  if (value.length > LIMITS.options) {
    problems.push({
      reason: "too-many-options",
      message: `at most ${LIMITS.options} options fit on one screen (got ${value.length})`,
    });
    return null;
  }

  const options: ParsedOption[] = [];
  const seen = new Set<string>();
  let sound = true;

  value.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push({ reason: "bad-option", message: `option ${index} must be an object` });
      sound = false;
      return;
    }
    const option = entry as Record<string, unknown>;

    const id = option["id"];
    if (typeof id !== "string" || !OPTION_ID.test(id) || id.length > LIMITS.optionId) {
      problems.push({
        reason: "bad-option-id",
        message: `option ${index} needs an id of 1-${LIMITS.optionId} letters, digits, - or _ (got ${describe(id)})`,
      });
      sound = false;
    } else if (seen.has(id)) {
      problems.push({ reason: "duplicate-option-id", message: `option id "${id}" appears twice` });
      sound = false;
    } else {
      seen.add(id);
    }

    const label = singleLine(option["label"], `option ${index} label`, LIMITS.label, problems);
    const consequence = prose(option["consequence"], `option ${index} consequence`, LIMITS.consequence, problems);

    // Absent is invalid, never defaulted: a defaulted reversibility is a
    // guess wearing a schema, and reversible=false is the field the
    // scheduler's refusal to auto-apply rests on.
    if (typeof option["reversible"] !== "boolean") {
      problems.push({
        reason: "missing-reversible",
        message: `option ${index} must say reversible: true or false — unstated is not reversible, it is unstated`,
      });
      sound = false;
    }

    if (label === null || consequence === null) {
      sound = false;
      return;
    }
    if (sound) {
      options.push({
        id: id as string,
        label,
        consequence,
        reversible: option["reversible"] as boolean,
      });
    }
  });

  return sound && options.length === value.length ? options : null;
}

function prose(value: unknown, field: string, cap: number, problems: Problem[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push({ reason: `missing-${slug(field)}`, message: `${field} is required` });
    return null;
  }
  if (value.length > cap) {
    problems.push({ reason: `${slug(field)}-too-long`, message: `${field} is over ${cap} characters` });
    return null;
  }
  if (FORBIDDEN_MULTILINE.test(value)) {
    problems.push({
      reason: `${slug(field)}-control-characters`,
      message: `${field} contains control characters — text only`,
    });
    return null;
  }
  return value.trim();
}

function singleLine(value: unknown, field: string, cap: number, problems: Problem[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push({ reason: `missing-${slug(field)}`, message: `${field} is required` });
    return null;
  }
  if (value.length > cap) {
    problems.push({ reason: `${slug(field)}-too-long`, message: `${field} is over ${cap} characters` });
    return null;
  }
  if (FORBIDDEN_SINGLE_LINE.test(value)) {
    problems.push({
      reason: `${slug(field)}-control-characters`,
      message: `${field} must be one line with no control characters`,
    });
    return null;
  }
  return value.trim();
}

function refuse(reason: string, message: string): ParseResult {
  return { ok: false, problems: [{ reason, message }] };
}

function slug(field: string): string {
  return field.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (typeof value === "string") return `"${truncate(value, 40)}"`;
  return typeof value;
}

function truncate(text: string, at: number): string {
  return text.length <= at ? text : `${text.slice(0, at)}…`;
}

/**
 * The terminal handoff: how every non-parking attempt says how it ended.
 *
 * gnhf's lesson, typed: "the agent seemed to finish" is not an outcome. A
 * clean tree is a success only when the agent SAID no-change; changes are
 * committed only when it said completed; and a missing, malformed, or
 * contradictory handoff is a protocol failure that earns a strike rather
 * than a guess that earns a commit.
 */
export type ParsedHandoff = {
  status: "completed" | "no-change" | "failed";
  conclusion: string;
  /** Compact, structured operator output. Version-1 handoffs rehydrate with
   * empty lists; version 2 agents fill these directly. */
  changes: string[];
  verification: string[];
  followUps: string[];
};

export const HANDOFF_VERSION = 2;
export const HANDOFF_CONCLUSION_CAP = 600;
/** The handoff's whole-file and list caps, exported so the brief states
 * exactly what the parser holds it to (raw authority repair). */
export const HANDOFF_PAYLOAD_CAP = 16 * 1024;
export const HANDOFF_LIST_CAP = 8;
export const HANDOFF_ITEM_CAP = 240;

/** Agent prose is display material, not authority. Once the structural
 * outcome is valid, excess verbosity is compacted deterministically rather
 * than throwing away completed code and paying for a whole new attempt. */
function compactHandoffText(value: string, cap: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= cap) return clean;
  const room = Math.max(1, cap - 1);
  const candidate = clean.slice(0, room);
  const sentence = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("! "), candidate.lastIndexOf("? "));
  const word = candidate.lastIndexOf(" ");
  const cut = sentence >= Math.floor(room * 0.55) ? sentence + 1 : word >= Math.floor(room * 0.55) ? word : room;
  return `${candidate.slice(0, cut).trimEnd()}…`;
}

function handoffList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((one): one is string => typeof one === "string" && one.trim() !== "" && !FORBIDDEN_MULTILINE.test(one))
    .slice(0, HANDOFF_LIST_CAP)
    .map(one => compactHandoffText(one, HANDOFF_ITEM_CAP));
}

export function parseHandoff(
  raw: string,
): { ok: true; handoff: ParsedHandoff } | { ok: false; problems: Problem[] } {
  if (Buffer.byteLength(raw, "utf8") > HANDOFF_PAYLOAD_CAP) {
    return { ok: false, problems: [{ reason: "too-large", message: `the handoff is over ${HANDOFF_PAYLOAD_CAP} bytes` }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      problems: [{ reason: "not-json", message: `the handoff is not JSON: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problems: [{ reason: "not-an-object", message: "the handoff must be one JSON object" }] };
  }
  const body = parsed as Record<string, unknown>;
  const problems: Problem[] = [];

  if (body["version"] !== 1 && body["version"] !== HANDOFF_VERSION) {
    problems.push({
      reason: "bad-version",
      message: `version must be 1 or ${HANDOFF_VERSION} (got ${describe(body["version"])})`,
    });
  }
  const status = body["status"];
  if (status !== "completed" && status !== "no-change" && status !== "failed") {
    problems.push({
      reason: "bad-status",
      message: `status must be "completed", "no-change", or "failed" (got ${describe(status)})`,
    });
  }
  const rawConclusion = body["conclusion"];
  let conclusion: string | null = null;
  if (typeof rawConclusion !== "string" || rawConclusion.trim() === "") {
    problems.push({ reason: "missing-conclusion", message: "conclusion is required" });
  } else if (FORBIDDEN_MULTILINE.test(rawConclusion)) {
    problems.push({ reason: "conclusion-control-characters", message: "conclusion contains control characters — text only" });
  } else {
    conclusion = compactHandoffText(rawConclusion, HANDOFF_CONCLUSION_CAP);
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    handoff: {
      status: status as ParsedHandoff["status"],
      conclusion: conclusion as string,
      changes: handoffList(body["changes"]),
      verification: handoffList(body["verification"]),
      followUps: handoffList(body["followUps"]),
    },
  };
}

/**
 * The compact error a repair turn is resumed with: every problem by name,
 * then the one instruction. Written for an agent that already holds the
 * context — it needs the list of what failed, not the theory of why.
 */
/**
 * Every unattended agent runs headless (run 2085): its turn ending IS the
 * process exiting, so a command left in the background, a wakeup or a loop
 * never gets a second turn — the attempt just ends without its handoff.
 */
export const HEADLESS_RULE: readonly string[] = [
  "- You run headless: run every command in the foreground and wait for it,",
  "  however long it takes. Never background a command to wait on it, and",
  "  never schedule a wakeup, cron job, monitor or loop. Your turn ending",
  "  ends the run, so write the handoff before you stop.",
];

export function repairPrompt(problems: readonly Problem[], mailbox: string): string {
  return [
    `Your parked decision in ${mailbox} failed validation:`,
    ...problems.map(problem => `- ${problem.message} (${problem.reason})`),
    "",
    `Rewrite ${mailbox} only — change no other file, run no commands, and do not`,
    "reconsider the decision itself. Re-emit the same judgement call as valid",
    "JSON: { urgency: \"blocking\", recap, question, options: [{ id, label,",
    "consequence, reversible }], recommendation } — at least two options, every",
    "option's reversible stated explicitly, recommendation naming an option id.",
    ...HEADLESS_RULE,
  ].join("\n");
}
