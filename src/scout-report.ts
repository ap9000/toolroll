/**
 * The scout's terminal handoff (mate arc §10), parsed with the 422 rule:
 * fail closed, every problem reported at once, stable reasons, caps and
 * control-character rejection on every string. A report reaches the task
 * page, the ledger, the terminal, and — through mateView — the mate; and
 * each follow-up becomes a filing's title and goal at one tap, so it gets
 * the park discipline exactly as the plan does.
 */

import { hasForbiddenControls } from "./decision.js";
import { TASK_TEXT_LIMITS } from "./task-text.js";
import { TEXT_LIMITS } from "./text-limits.js";

export type ReportProblem = { reason: string; message: string };

export type ParsedReport = {
  title: string;
  summary: string;
  /** The report document, markdown, rendered fenced-inert everywhere. */
  report: string;
  /** Proposed follow-ups: each files as a task in the same repository. */
  followUps: { title: string; goal: string }[];
  /** What the scout found, as a short list later steps can read: each cites its URL, and may show one of `images`. */
  items: ReportItem[];
  /** Screenshots the scout saved during the run. From the scout, `file` names a file in its output folder; once
   * stored, the runner adds the bytes' sha256 and the evidence row that holds them. */
  images: ReportImage[];
};

export type ReportItem = { title: string; why: string; url: string; image: string | null };
export type ReportImage = { file: string; caption: string; url: string; sha256?: string; artifact?: number };

export type ReportParseResult =
  | { ok: true; report: ParsedReport }
  | { ok: false; problems: ReportProblem[] };

/** Caps are BYTES of UTF-8 (v4 review, finding 11): a 64 KiB report is
 * 64 KiB whatever script it is written in. They hold what a scout writes;
 * a stored report is read without them (parseReport's `stored`). */
export const REPORT_LIMITS = {
  payload: 96 * 1024,
  title: 200,
  summary: TEXT_LIMITS.reportSummary,
  document: 64 * 1024,
  followUps: 5,
  followUpTitle: 200,
  /** A follow-up files as a task: its goal is held to the task goal limit, in bytes of the same count. */
  followUpGoal: TASK_TEXT_LIMITS.text,
  items: 6,
  itemTitle: 200,
  itemWhy: 1_000,
  url: 2_000,
  images: 8,
  caption: 300,
} as const;

/** A screenshot's name in the scout's output folder: one plain file name, PNG or JPEG, never a path. */
export const REPORT_IMAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(?:png|jpe?g)$/i;

const REPORT_SHAPE = {
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
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, why: { type: "string" }, url: { type: "string" }, image: { type: "string" } },
        required: ["title", "why", "url"],
        additionalProperties: false,
      },
    },
    images: {
      type: "array",
      items: {
        type: "object",
        properties: { file: { type: "string" }, caption: { type: "string" }, url: { type: "string" } },
        required: ["file", "caption", "url"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "summary", "report"],
  additionalProperties: false,
} as const;

/** The park mailbox's decision, the same fields `parseDecision` reads. */
const DECISION_SHAPE = {
  type: "object",
  properties: {
    urgency: { type: "string", enum: ["blocking"] },
    recap: { type: "string" },
    question: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          consequence: { type: "string" },
          reversible: { type: "boolean" },
        },
        required: ["id", "label", "consequence", "reversible"],
        additionalProperties: false,
      },
    },
    recommendation: { type: "string" },
  },
  required: ["urgency", "recap", "question", "options", "recommendation"],
  additionalProperties: false,
} as const;

/**
 * The scout's handback for Claude's `--json-schema` (run 2334's fix): plan
 * mode only lets a session write its own plan file, so a Claude scout
 * returns a report — or a question for the operator — as structured output
 * on the terminal result event. Shape only, never the validator: byte caps,
 * one-line titles and control characters stay `parseReport`'s and
 * `parseDecision`'s, applied to the re-serialized body.
 */
export const SCOUT_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["report", "question"] },
    report: REPORT_SHAPE,
    decision: DECISION_SHAPE,
  },
  required: ["kind"],
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
  if (!readingStored && Buffer.byteLength(value, "utf8") > cap) {
    problems.push({ reason: `${field}-too-long`, message: `${field} is over ${cap} bytes` });
    return null;
  }
  if (hasForbiddenControls(value)) {
    problems.push({ reason: `${field}-controls`, message: `${field} carries control characters that could become terminal escapes` });
    return null;
  }
  return value;
}

/** True while a stored report is read: a limit is for writing, and reading never re-checks a text's length. */
let readingStored = false;

/** A report, checked. `stored`: one already kept as evidence, read without the length caps (a report written under
 * higher limits stays readable); every other check still holds. */
export function parseReport(raw: string, options: { stored?: boolean } = {}): ReportParseResult {
  readingStored = options.stored === true;
  try { return parseReportBody(raw); } finally { readingStored = false; }
}

function parseReportBody(raw: string): ReportParseResult {
  if (!readingStored && Buffer.byteLength(raw, "utf8") > REPORT_LIMITS.payload) {
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

  const images = listOf(body["images"], "images", REPORT_LIMITS.images, problems, (entry, at) => {
    // Any one line here: the runner refuses an image that isn't a plain file name in its output folder, not the report.
    const file = prose(entry["file"], `${at}.file`, REPORT_LIMITS.caption, problems);
    const caption = prose(entry["caption"], `${at}.caption`, REPORT_LIMITS.caption, problems);
    const url = link(entry["url"], `${at}.url`, problems);
    if (file !== null && /[\n\r]/.test(file)) problems.push({ reason: `${at}-file-multiline`, message: `${at}.file must be one line` });
    if (caption !== null && /[\n\r]/.test(caption)) problems.push({ reason: `${at}-caption-multiline`, message: `${at}.caption must be one line` });
    const sha256 = entry["sha256"];
    if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))) problems.push({ reason: `${at}-sha256`, message: `${at}.sha256 must be a sha256 hex digest` });
    const artifact = entry["artifact"];
    if (artifact !== undefined && (typeof artifact !== "number" || !Number.isSafeInteger(artifact) || artifact <= 0)) problems.push({ reason: `${at}-artifact`, message: `${at}.artifact must be an evidence id` });
    if (file === null || caption === null || url === null || /[\n\r]/.test(file) || /[\n\r]/.test(caption)) return null;
    return { file, caption, url, ...(typeof sha256 === "string" ? { sha256 } : {}), ...(typeof artifact === "number" ? { artifact } : {}) };
  });
  const files = new Set<string>();
  for (const one of images) {
    if (files.has(one.file)) problems.push({ reason: "images-duplicate", message: `images names ${one.file} twice` });
    files.add(one.file);
  }
  const items = listOf(body["items"], "items", REPORT_LIMITS.items, problems, (entry, at) => {
    const itemTitle = prose(entry["title"], `${at}.title`, REPORT_LIMITS.itemTitle, problems);
    const why = prose(entry["why"], `${at}.why`, REPORT_LIMITS.itemWhy, problems);
    const url = link(entry["url"], `${at}.url`, problems);
    const image = entry["image"] === undefined || entry["image"] === null || entry["image"] === "" ? null : entry["image"];
    if (itemTitle !== null && /[\n\r]/.test(itemTitle)) problems.push({ reason: `${at}-title-multiline`, message: `${at}.title must be one line` });
    if (image !== null && (typeof image !== "string" || !files.has(image))) problems.push({ reason: `${at}-image`, message: `${at}.image must name one of images by its file` });
    if (itemTitle === null || why === null || url === null || /[\n\r]/.test(itemTitle) || (image !== null && (typeof image !== "string" || !files.has(image)))) return null;
    return { title: itemTitle, why, url, image: image as string | null };
  });

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, report: { title: title as string, summary: summary as string, report: document as string, followUps, items, images } };
}

/** An optional capped list of objects, each read by `one`; problems are reported, never thrown. */
function listOf<T>(value: unknown, field: string, cap: number, problems: ReportProblem[], one: (entry: Record<string, unknown>, at: string) => T | null): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push({ reason: `bad-${field}`, message: `${field} must be an array (got ${describe(value)})` });
    return [];
  }
  if (value.length > cap) {
    problems.push({ reason: `${field}-too-many`, message: `${field} lists ${value.length} — cap is ${cap}` });
    return [];
  }
  const kept: T[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `${field}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push({ reason: `${at}-shape`, message: `${at} must be an object` });
      continue;
    }
    const read = one(entry as Record<string, unknown>, at);
    if (read !== null) kept.push(read);
  }
  return kept;
}

/** A cited web address: http or https, one line, no credentials. */
function link(value: unknown, field: string, problems: ReportProblem[]): string | null {
  const text = prose(value, field, REPORT_LIMITS.url, problems);
  if (text === null) return null;
  let url: URL | null = null;
  try { url = new URL(text); } catch { url = null; }
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:") || /\s/.test(text) || url.username !== "" || url.password !== "") {
    problems.push({ reason: `${field}-not-a-link`, message: `${field} must be an http or https address` });
    return null;
  }
  return text;
}
