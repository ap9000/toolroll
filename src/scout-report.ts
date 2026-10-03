/**
 * The scout's terminal handoff (mate arc §10), parsed with the 422 rule:
 * fail closed, every problem reported at once, stable reasons, caps and
 * control-character rejection on every string. A report reaches the task
 * page, the ledger, the terminal, and — through mateView — the mate; and
 * each follow-up becomes a filing's title and goal at one tap, so it gets
 * the park discipline exactly as the plan does.
 */

import { hasForbiddenControls } from "./decision.js";

export type ReportProblem = { reason: string; message: string };

export type ParsedReport = {
  title: string;
  summary: string;
  /** The report document, markdown, rendered fenced-inert everywhere. */
  report: string;
  /** Proposed follow-ups: each files as a task in the same repository. */
  followUps: { title: string; goal: string }[];
};

export type ReportParseResult =
  | { ok: true; report: ParsedReport }
  | { ok: false; problems: ReportProblem[] };

/** Caps are BYTES of UTF-8 (v4 review, finding 11): a 64 KiB report is
 * 64 KiB whatever script it is written in. */
export const REPORT_LIMITS = {
  payload: 96 * 1024,
  title: 200,
  summary: 1_000,
  document: 64 * 1024,
  followUps: 5,
  followUpTitle: 200,
  followUpGoal: 2_000,
} as const;

/**
 * The report's shape for Claude's `--json-schema` (run 2334's fix): plan
 * mode only lets a session write its own plan file, so a Claude scout
 * returns its report as structured output on the terminal result event.
 * Shape only, never the validator — byte caps, one-line titles and control
 * characters stay `parseReport`'s, applied to the re-serialized payload.
 */
export const REPORT_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    report: { type: "string" },
    followUps: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, goal: { type: "string" } },
        required: ["title", "goal"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "summary", "report"],
  additionalProperties: false,
} as const;

function refuse(reason: string, message: string): ReportParseResult {
  return { ok: false, problems: [{ reason, message }] };
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return `a ${value.length}-char string`;
  return `a ${Array.isArray(value) ? "array" : typeof value}`;
}

function prose(value: unknown, field: string, cap: number, problems: ReportProblem[]): string | null {
  if (value === undefined || value === null || value === "" || (typeof value === "string" && value.trim() === "")) {
    problems.push({ reason: `missing-${field}`, message: `${field} is required` });
    return null;
  }
  if (typeof value !== "string") {
    problems.push({ reason: `bad-${field}`, message: `${field} must be a string (got ${describe(value)})` });
    return null;
  }
  if (Buffer.byteLength(value, "utf8") > cap) {
    problems.push({ reason: `${field}-too-long`, message: `${field} is over ${cap} bytes` });
    return null;
  }
  if (hasForbiddenControls(value)) {
    problems.push({ reason: `${field}-controls`, message: `${field} carries control characters that could become terminal escapes` });
    return null;
  }
  return value;
}

export function parseReport(raw: string): ReportParseResult {
  if (Buffer.byteLength(raw, "utf8") > REPORT_LIMITS.payload) {
    return refuse("too-large", `the payload is over ${REPORT_LIMITS.payload} bytes`);
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
  const problems: ReportProblem[] = [];

  const title = prose(body["title"], "title", REPORT_LIMITS.title, problems);
  const summary = prose(body["summary"], "summary", REPORT_LIMITS.summary, problems);
  const document = prose(body["report"], "report", REPORT_LIMITS.document, problems);
  if (title !== null && /[\n\r]/.test(title)) {
    problems.push({ reason: "title-multiline", message: "title must be one line" });
  }
  // One paragraph: the summary is what the operator reads first, on a
  // phone, in a digest line — a blank line inside it is a second paragraph.
  if (summary !== null && /\n[ \t]*\n/.test(summary)) {
    problems.push({ reason: "summary-paragraphs", message: "summary is one paragraph — no blank lines" });
  }

  const followUps: { title: string; goal: string }[] = [];
  if (body["followUps"] !== undefined && body["followUps"] !== null) {
    if (!Array.isArray(body["followUps"])) {
      problems.push({ reason: "bad-followUps", message: `followUps must be an array (got ${describe(body["followUps"])})` });
    } else if (body["followUps"].length > REPORT_LIMITS.followUps) {
      problems.push({ reason: "followUps-too-many", message: `followUps lists ${body["followUps"].length} — cap is ${REPORT_LIMITS.followUps}` });
    } else {
      for (const [index, one] of body["followUps"].entries()) {
        if (typeof one !== "object" || one === null || Array.isArray(one)) {
          problems.push({ reason: `followUps[${index}]-shape`, message: `followUps[${index}] must be {title, goal}` });
          continue;
        }
        const entry = one as Record<string, unknown>;
        const followTitle = prose(entry["title"], `followUps[${index}].title`, REPORT_LIMITS.followUpTitle, problems);
        const goal = prose(entry["goal"], `followUps[${index}].goal`, REPORT_LIMITS.followUpGoal, problems);
        if (followTitle !== null && /[\n\r]/.test(followTitle)) {
          problems.push({ reason: `followUps[${index}]-title-multiline`, message: `followUps[${index}].title must be one line` });
        } else if (followTitle !== null && goal !== null) {
          followUps.push({ title: followTitle, goal });
        }
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, report: { title: title as string, summary: summary as string, report: document as string, followUps } };
}
