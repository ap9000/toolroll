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

import type { ContractIssue } from "./contracts/contract.js";
import { readDecisionPayload, type DecisionOption, type DecisionPayload } from "./contracts/decision.js";
import { TEXT_LIMITS } from "./text-limits.js";

/** One option as a decision keeps it (src/contracts/decision.ts). */
export type ParsedOption = DecisionOption;

/** A decision as read: the payload's fields, its text trimmed, and the optional ones present or null. */
export type ParsedDecision = Omit<DecisionPayload, "version" | "assignee" | "deadline"> & {
  assignee: string | null;
  /** Normalized to toISOString(), like every timestamp in the store. */
  deadline: string | null;
};

export type Problem = { reason: string; message: string };

export type ParseResult =
  | { ok: true; decision: ParsedDecision }
  | { ok: false; problems: Problem[] };

/** One screen's worth, enforced rather than hoped for. The payload's fields are bounded by its schema (src/contracts/decision.ts, from TEXT_LIMITS). */
export const LIMITS = {
  /** Bytes, before parsing. Applied by the reader too; this is the backstop. */
  payload: 64 * 1024,
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

/**
 * A parked decision, read against its contract (src/contracts/decision.ts): fail closed, every problem at once, each
 * naming its path (`options[1].reversible: required`) under the reason code the repair turn, incidents and tests have
 * always used (`missing-reversible`). A decision written without `version` reads as it always did.
 */
export function parseDecision(raw: string): ParseResult {
  if (Buffer.byteLength(raw, "utf8") > LIMITS.payload) {
    return refuse("too-large", `payload: over ${LIMITS.payload} bytes — one screen does not need that`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return refuse("not-json", `the payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("not-an-object", "payload: must be one JSON object");
  }

  const read = readDecisionPayload(parsed);
  const contract = read.ok ? [] : read.issues.map(decisionProblemOf);
  if (contract.some(problem => problem.reason === "newer-version" || problem.reason === "bad-version")) return { ok: false, problems: contract };
  const body = parsed as Record<string, unknown>;
  const problems = [...contract, ...decisionRuleProblems(body, contract)];
  if (!read.ok || problems.length > 0) return { ok: false, problems };

  const payload = read.value;
  return {
    ok: true,
    decision: {
      urgency: payload.urgency,
      recap: payload.recap.trim(),
      question: payload.question.trim(),
      options: payload.options.map(option => ({ id: option.id, label: option.label.trim(), consequence: option.consequence.trim(), reversible: option.reversible })),
      recommendation: payload.recommendation,
      assignee: payload.assignee === undefined || payload.assignee === null ? null : payload.assignee.trim(),
      // Normalized so the store's lexicographic-comparison invariant holds.
      deadline: payload.deadline === undefined || payload.deadline === null ? null : new Date(Date.parse(payload.deadline)).toISOString(),
    },
  };
}

/** The reason code a contract issue has always had: `missing-recap`, `too-few-options`, `bad-option-id`. */
function decisionReasonOf(issue: ContractIssue): string {
  const at = issue.path;
  if (issue.kind === "newer-version") return "newer-version";
  if (at === "version") return "bad-version";
  if (issue.kind === "unknown-key") return `${at}-unknown-key`;
  const text = (field: string) => (issue.kind === "too-long" ? `${field}-too-long` : `missing-${field}`);
  switch (at) {
    case "urgency": return "bad-urgency";
    case "options": return issue.kind === "too-few" ? "too-few-options" : issue.kind === "too-many" ? "too-many-options" : "no-options";
    case "recommendation": return issue.kind === "too-long" ? "bad-recommendation" : "missing-recommendation";
    case "deadline": return "bad-deadline";
  }
  const option = /^options\[(\d+)\](?:\.(\w+))?$/.exec(at);
  if (option !== null) {
    const [, index, field] = option;
    if (field === undefined) return "bad-option";
    if (field === "id") return "bad-option-id";
    if (field === "reversible") return "missing-reversible";
    return text(`option-${index}-${field}`);
  }
  return text(at);
}

const decisionProblemOf = (issue: ContractIssue): Problem => ({ reason: decisionReasonOf(issue), message: issue.line });

/** True when `problems` name `field` or anything under it. */
const touched = (problems: readonly Problem[], field: string) =>
  problems.some(problem => problem.message.startsWith(`${field}:`) || problem.message.startsWith(`${field}[`) || problem.message.startsWith(`${field}.`));

/**
 * The rules JSON Schema cannot state, in plain code with named errors: text not blank once trimmed and free of control
 * characters (a label or assignee on one line), unique option ids, a recommendation naming one of them, and a deadline
 * that is a timestamp. Fields the contract already refused are skipped, so every problem is reported once and all at
 * once.
 */
function decisionRuleProblems(body: Record<string, unknown>, contract: readonly Problem[]): Problem[] {
  const problems: Problem[] = [];
  const text = (value: unknown, path: string, slug: string, oneLine: boolean) => {
    if (typeof value !== "string" || touched(contract, path)) return;
    if (value.trim() === "") problems.push({ reason: `missing-${slug}`, message: `${path}: must not be blank` });
    else if ((oneLine ? FORBIDDEN_SINGLE_LINE : FORBIDDEN_MULTILINE).test(value)) {
      problems.push({ reason: `${slug}-control-characters`, message: `${path}: ${oneLine ? "must be one line with no control characters" : "contains control characters — text only"}` });
    }
  };
  text(body["recap"], "recap", "recap", false);
  text(body["question"], "question", "question", false);
  const options = Array.isArray(body["options"]) ? (body["options"] as unknown[]) : [];
  const seen = new Set<string>();
  options.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
    const option = entry as Record<string, unknown>;
    const id = option["id"];
    if (typeof id === "string" && !touched(contract, `options[${index}].id`)) {
      if (seen.has(id)) problems.push({ reason: "duplicate-option-id", message: `options[${index}].id: "${id}" appears twice` });
      seen.add(id);
    }
    text(option["label"], `options[${index}].label`, `option-${index}-label`, true);
    text(option["consequence"], `options[${index}].consequence`, `option-${index}-consequence`, false);
  });
  const recommendation = body["recommendation"];
  if (typeof recommendation === "string" && !touched(contract, "recommendation") && !touched(contract, "options") && !options.some(option => typeof option === "object" && option !== null && (option as Record<string, unknown>)["id"] === recommendation)) {
    problems.push({ reason: "bad-recommendation", message: `recommendation: "${truncate(recommendation, 60)}" does not match any option id` });
  }
  if (body["assignee"] !== null) text(body["assignee"], "assignee", "assignee", true);
  const deadline = body["deadline"];
  if (typeof deadline === "string" && !touched(contract, "deadline") && Number.isNaN(Date.parse(deadline))) {
    problems.push({ reason: "bad-deadline", message: `deadline: must be an ISO 8601 timestamp (got ${describe(deadline)})` });
  }
  return problems;
}

function refuse(reason: string, message: string): ParseResult {
  return { ok: false, problems: [{ reason, message }] };
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
