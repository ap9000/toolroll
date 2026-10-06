/**
 * The scout's terminal handoff (mate arc §10), read against the report contract (src/contracts/scout-report.ts) with
 * the 422 rule: fail closed, every problem reported at once, each naming its path (`items[0].url: must be an http or
 * https address`), stable reasons, caps and control-character rejection on every string. A report reaches the task
 * page, the ledger, the terminal, and — through mateView — the mate; and each follow-up becomes a filing's title and
 * goal at one tap, so it gets the park discipline exactly as the plan does.
 */

import { contractProblemOf, type ContractIssue, type ContractProblem } from "./contracts/contract.js";
import {
  FOLLOW_UP_TEXT_FIELDS,
  IMAGE_TEXT_FIELDS,
  ITEM_TEXT_FIELDS,
  readReportPayload,
  REPORT_LIMITS,
  REPORT_TEXT_FIELDS,
  reportPayloadBody,
  type ParsedReport,
} from "./contracts/scout-report.js";
import { hasForbiddenControls } from "./decision.js";
import { TEXT_LIMITS, type TextLimitKey } from "./text-limits.js";

export {
  REPORT_IMAGE_FILE,
  REPORT_LIMITS,
  REPORT_VERSION,
  SCOUT_OUTPUT_JSON_SCHEMA,
  type ParsedReport,
  type ReportImage,
  type ReportItem,
} from "./contracts/scout-report.js";

export type ReportProblem = ContractProblem;

export type ReportParseResult =
  | { ok: true; report: ParsedReport }
  | { ok: false; problems: ReportProblem[] };

function refuse(reason: string, message: string): ReportParseResult {
  return { ok: false, problems: [{ reason, message }] };
}

/** A report, checked. `stored`: one already kept as evidence, read without the length caps (a report written under
 * higher limits stays readable); every other check still holds. */
export function parseReport(raw: string, options: { stored?: boolean } = {}): ReportParseResult {
  const stored = options.stored === true;
  if (!stored && Buffer.byteLength(raw, "utf8") > REPORT_LIMITS.payload) {
    return refuse("too-large", `payload: over ${REPORT_LIMITS.payload.toLocaleString("en-US")} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return refuse("not-json", `payload: not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = reportPayloadBody(parsed);
  if (body === null) return refuse("not-an-object", "payload: must be one JSON object");

  const read = readReportPayload(parsed, { stored });
  // Every report limit counts UTF-8 bytes, including those TEXT_LIMITS names without "Bytes" (a summary, a goal).
  const issues = (read.ok ? [] : read.issues).map(issue => (issue.kind === "too-long" ? { ...issue, line: issue.line.replace(/ characters$/, " bytes") } : issue));
  const contract = issues.map(contractProblemOf);
  if (contract.some(problem => problem.reason === "newer-version" || problem.reason === "bad-version")) return { ok: false, problems: contract };
  const problems = [...contract, ...reportRuleProblems(body, issues, stored)];
  if (!read.ok || problems.length > 0) return { ok: false, problems };

  const payload = read.value;
  return {
    ok: true,
    report: {
      title: payload.title,
      summary: payload.summary,
      report: payload.report,
      followUps: (payload.followUps ?? []).map(one => ({ title: one.title, goal: one.goal })),
      items: (payload.items ?? []).map(one => ({ title: one.title, why: one.why, url: one.url, image: one.image === undefined || one.image === null || one.image === "" ? null : one.image })),
      images: (payload.images ?? []).map(one => ({
        file: one.file,
        caption: one.caption,
        url: one.url,
        ...(one.sha256 === undefined ? {} : { sha256: one.sha256 }),
        ...(one.artifact === undefined ? {} : { artifact: one.artifact }),
      })),
    },
  };
}

type TextRule = { limit: TextLimitKey; oneLine?: boolean; link?: boolean };

/**
 * The rules JSON Schema cannot state, in plain code with path-named errors: blank text, byte caps (on write only),
 * control characters, one-line fields, a one-paragraph summary, safe links, a screenshot named twice and an item
 * naming one the report doesn't have. A field the contract already refused (or one inside it) is skipped, so every
 * problem is reported once and all at once.
 */
function reportRuleProblems(body: Record<string, unknown>, issues: readonly ContractIssue[], stored: boolean): ReportProblem[] {
  const problems: ReportProblem[] = [];
  // An unknown key is about its object, not the fields beside it.
  const refused = issues.filter(issue => issue.kind !== "unknown-key").map(issue => issue.path);
  const touched = (path: string) =>
    refused.some(at => at === path || path.startsWith(`${at}.`) || path.startsWith(`${at}[`) || at.startsWith(`${path}.`) || at.startsWith(`${path}[`));
  const say = (path: string, reason: string, what: string) => problems.push({ reason, message: `${path}: ${what}` });

  /** One text field checked; true when it passed every rule. */
  const text = (value: unknown, path: string, rule: TextRule): value is string => {
    if (typeof value !== "string" || touched(path)) return false;
    const limit = TEXT_LIMITS[rule.limit];
    if (value.trim() === "") say(path, `missing-${path}`, "must not be empty");
    else if (!stored && Buffer.byteLength(value, "utf8") > limit) say(path, `${path}-too-long`, `over ${limit.toLocaleString("en-US")} bytes`);
    else if (hasForbiddenControls(value)) say(path, `${path}-controls`, "carries control characters that could become terminal escapes");
    else if (rule.oneLine === true && /[\n\r]/.test(value)) say(path, `${path}-multiline`, "must be one line");
    else if (rule.link === true && !isLink(value)) say(path, `${path}-not-a-link`, "must be an http or https address");
    else return true;
    return false;
  };
  const entries = (list: "followUps" | "items" | "images"): [Record<string, unknown>, string][] => {
    const value = body[list];
    if (!Array.isArray(value) || touched(list)) return [];
    return value.flatMap((entry, index): [Record<string, unknown>, string][] =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) ? [[entry as Record<string, unknown>, `${list}[${index}]`]] : []);
  };
  const fields = (entry: Record<string, unknown>, at: string, rules: Readonly<Record<string, TextRule>>) => {
    for (const [field, rule] of Object.entries(rules)) text(entry[field], at === "" ? field : `${at}.${field}`, rule);
  };

  fields(body, "", REPORT_TEXT_FIELDS);
  // One paragraph: the summary is what the operator reads first, on a phone, in a digest line — a blank line inside
  // it is a second paragraph.
  const summary = body["summary"];
  if (typeof summary === "string" && !problems.some(problem => problem.message.startsWith("summary:")) && !touched("summary") && /\n[ \t]*\n/.test(summary)) {
    say("summary", "summary-paragraphs", "one paragraph — no blank lines");
  }
  for (const [entry, at] of entries("followUps")) fields(entry, at, FOLLOW_UP_TEXT_FIELDS);

  const files = new Map<string, string>();
  for (const [entry, at] of entries("images")) {
    fields(entry, at, IMAGE_TEXT_FIELDS);
    const file = entry["file"];
    if (typeof file !== "string" || touched(`${at}.file`)) continue;
    const first = files.get(file);
    if (first !== undefined) say(`${at}.file`, "images-duplicate", `names ${file} again (also ${first})`);
    else files.set(file, at);
  }
  // An item's picture is checked against the images as written: one naming a screenshot the report doesn't list is refused.
  const imagesRefused = touched("images");
  for (const [entry, at] of entries("items")) {
    fields(entry, at, ITEM_TEXT_FIELDS);
    const image = entry["image"];
    if (typeof image === "string" && image !== "" && !touched(`${at}.image`) && !imagesRefused && !files.has(image)) {
      say(`${at}.image`, `bad-${at}.image`, "must name one of images by its file");
    }
  }
  return problems;
}

/** A cited web address: http or https, one line, no credentials. */
function isLink(text: string): boolean {
  let url: URL | null = null;
  try { url = new URL(text); } catch { url = null; }
  return url !== null && (url.protocol === "http:" || url.protocol === "https:") && !/\s/.test(text) && url.username === "" && url.password === "";
}
