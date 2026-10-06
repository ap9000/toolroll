/**
 * The scout's report: one schema for the report a scout writes (its report file, or Claude's structured output), the
 * JSON Schema a Claude scout is given (`--json-schema`, `SCOUT_OUTPUT_JSON_SCHEMA`) and the reader that takes it back
 * (`parseReport` in scout-report.ts), which also reads every report already kept as evidence. The rules JSON Schema
 * cannot state — UTF-8 byte limits, blank text, control characters, one-line titles, a one-paragraph summary, safe
 * links, duplicate screenshots and items naming them — run in plain code after parsing, each with a path-named error.
 */

import { z } from "zod";
import { limitRule, TEXT_LIMITS, type TextLimitKey } from "../text-limits.js";
import { limited, readVersioned, toModelSchema, versioned, type ContractResult } from "./contract.js";

/** How many follow-ups, items and screenshots a report may carry. */
export const REPORT_COUNTS = { followUps: 5, items: 6, images: 8 } as const;

/** Caps are BYTES of UTF-8 (v4 review, finding 11): a 64 KiB report is 64 KiB whatever script it is written in. They
 * hold what a scout writes; a stored report is read without them (`storedReportSchema`). */
export const REPORT_LIMITS = {
  payload: TEXT_LIMITS.reportPayloadBytes,
  title: TEXT_LIMITS.reportTitleBytes,
  summary: TEXT_LIMITS.reportSummary,
  document: TEXT_LIMITS.reportDocumentBytes,
  followUps: REPORT_COUNTS.followUps,
  followUpTitle: TEXT_LIMITS.reportTitleBytes,
  /** A follow-up files as a task: its goal is held to the task goal limit, in bytes of the same count. */
  followUpGoal: TEXT_LIMITS.goal,
  items: REPORT_COUNTS.items,
  itemTitle: TEXT_LIMITS.reportTitleBytes,
  itemWhy: TEXT_LIMITS.reportWhyBytes,
  url: TEXT_LIMITS.reportUrlBytes,
  images: REPORT_COUNTS.images,
  caption: TEXT_LIMITS.reportCaptionBytes,
} as const;

/** A screenshot's name in the scout's output folder: one plain file name, PNG or JPEG, never a path. */
export const REPORT_IMAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(?:png|jpe?g)$/i;

/** Each text field, the limit it is written within, and whether it is one line or a web address. */
export const REPORT_TEXT_FIELDS = {
  title: { limit: "reportTitleBytes", oneLine: true },
  summary: { limit: "reportSummary" },
  report: { limit: "reportDocumentBytes" },
} as const;
export const FOLLOW_UP_TEXT_FIELDS = { title: { limit: "reportTitleBytes", oneLine: true }, goal: { limit: "goal" } } as const;
export const ITEM_TEXT_FIELDS = { title: { limit: "reportTitleBytes", oneLine: true }, why: { limit: "reportWhyBytes" }, url: { limit: "reportUrlBytes", link: true } } as const;
// The image's file is any one line here: the runner refuses one that isn't a plain file name in its output folder, not the report.
export const IMAGE_TEXT_FIELDS = { file: { limit: "reportCaptionBytes", oneLine: true }, caption: { limit: "reportCaptionBytes", oneLine: true }, url: { limit: "reportUrlBytes", link: true } } as const;

/** How a text field is bounded: as written now (its TEXT_LIMITS entry), or as stored (any length; a limit is for writing). */
type Bound = (field: string, limit: TextLimitKey) => z.ZodString;

export const REPORT_VERSION = 1;

function reportSchemaOf(text: Bound) {
  // Limits named without "Bytes" that a report still counts in bytes: the model is told so.
  const bytes: Bound = (field, limit) => text(field, limit).describe(limitRule(field, TEXT_LIMITS[limit], "bytes"));
  const followUp = z.strictObject({
    title: text("follow-up title", "reportTitleBytes").min(1),
    goal: bytes("follow-up goal", "goal").min(1),
  });
  const item = z.strictObject({
    title: text("item title", "reportTitleBytes").min(1),
    why: text("item why", "reportWhyBytes").min(1),
    url: text("item url", "reportUrlBytes").min(1),
    image: z.string().nullable().optional().describe("the file of the one of images this item shows, if any"),
  });
  const image = z.strictObject({
    file: text("image file", "reportCaptionBytes").min(1),
    caption: text("image caption", "reportCaptionBytes").min(1),
    url: text("image url", "reportUrlBytes").min(1),
    /** Added by Toolroll once the screenshot is stored: its bytes' sha256 and the evidence that holds them. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/, { error: "must be a sha256 hex digest" }).optional().describe("set by Toolroll when it keeps the screenshot; leave out"),
    artifact: z.int().positive().optional().describe("set by Toolroll when it keeps the screenshot; leave out"),
  });
  return versioned(REPORT_VERSION, {
    title: text("title", "reportTitleBytes").min(1),
    summary: bytes("summary", "reportSummary").min(1),
    report: text("report", "reportDocumentBytes").min(1),
    followUps: z.array(followUp).max(REPORT_COUNTS.followUps).optional(),
    items: z.array(item).max(REPORT_COUNTS.items).optional(),
    images: z.array(image).max(REPORT_COUNTS.images).optional(),
  });
}

/** A report as a scout writes it now. */
export const scoutReportSchema = reportSchemaOf(limited);
/** A report kept as evidence: the same, except text keeps the length it was stored with. */
export const storedReportSchema = reportSchemaOf(() => z.string());

export type ScoutReportPayload = z.infer<typeof scoutReportSchema>;
type FollowUp = NonNullable<ScoutReportPayload["followUps"]>[number];
type Item = NonNullable<ScoutReportPayload["items"]>[number];
type Image = NonNullable<ScoutReportPayload["images"]>[number];

/** One finding later steps read: it cites its URL, and may show one of the report's images (null when none). */
export type ReportItem = Omit<Item, "image"> & { image: string | null };
/** A screenshot the scout saved. From the scout, `file` names a file in its output folder; once stored, the runner
 * adds the bytes' sha256 and the evidence row that holds them. */
export type ReportImage = Image;

/** A report as read: the payload without its envelope, every list present (empty when the scout gave none). */
export type ParsedReport = {
  title: string;
  summary: string;
  /** The report document, markdown, rendered fenced-inert everywhere. */
  report: string;
  /** Proposed follow-ups: each files as a task in the same repository. */
  followUps: FollowUp[];
  items: ReportItem[];
  images: ReportImage[];
};

/** The park mailbox's decision as a scout hands it back: the same fields `parseDecision` reads, which stays its
 * validator until the decision contract (docs/plans/zod-revamp.md, item 7) gives it one schema. */
export const scoutDecisionSchema = z.strictObject({
  urgency: z.literal("blocking"),
  recap: z.string(),
  question: z.string(),
  options: z.array(z.strictObject({ id: z.string(), label: z.string(), consequence: z.string(), reversible: z.boolean() })),
  recommendation: z.string(),
});

/**
 * The scout's handback for Claude's `--json-schema` (run 2334's fix): plan mode only lets a session write its own plan
 * file, so a Claude scout returns a report — or a question for the operator — as structured output on the terminal
 * result event. The report branch is the report schema itself; the byte limits and rules JSON Schema cannot state are
 * `parseReport`'s (and `parseDecision`'s), applied to the branch as handed back.
 */
export const scoutHandbackSchema = z.strictObject({
  kind: z.enum(["report", "question"]),
  report: scoutReportSchema.optional(),
  decision: scoutDecisionSchema.optional(),
});

export const SCOUT_OUTPUT_JSON_SCHEMA: Readonly<Record<string, unknown>> = toModelSchema(scoutHandbackSchema);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function pick(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

const ENTRY_FIELDS = {
  followUps: Object.keys(FOLLOW_UP_TEXT_FIELDS),
  items: [...Object.keys(ITEM_TEXT_FIELDS), "image"],
  images: [...Object.keys(IMAGE_TEXT_FIELDS), "sha256", "artifact"],
} as const;

/**
 * A report written or stored before reports carried `version` (every report through 0.9.36), as version 1. The old
 * parser read only the fields it knew, in the report and in each follow-up, item and image, and ignored any others;
 * it read a null list as none. This keeps exactly that, so every report that read then reads now. Values themselves
 * are never rewritten, and anything that is not an object is left for the schema to refuse by path.
 */
export function upgradeUnversionedReport(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { version: REPORT_VERSION, ...pick(body, [...Object.keys(REPORT_TEXT_FIELDS), "followUps", "items", "images"]) };
  for (const list of ["followUps", "items", "images"] as const) {
    if (out[list] === null) delete out[list];
    else if (Array.isArray(out[list])) out[list] = out[list].map(entry => (isRecord(entry) ? pick(entry, ENTRY_FIELDS[list]) : entry));
  }
  return out;
}

export const REPORT_UPGRADES = { 0: upgradeUnversionedReport } as const;

/** The payload as version 1, upgraded when it was written unversioned; null for anything that is not an object. */
export function reportPayloadBody(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  return Object.prototype.hasOwnProperty.call(input, "version") ? input : upgradeUnversionedReport(input);
}

/** Read a report: version 1 as itself, an unversioned one upgraded, a newer one refused plainly. `stored`: one kept as
 * evidence, read without the length limits. */
export function readReportPayload(input: unknown, options: { stored?: boolean } = {}): ContractResult<ScoutReportPayload> {
  return readVersioned(options.stored === true ? storedReportSchema : scoutReportSchema, input, REPORT_UPGRADES);
}
