/**
 * Shared structured-output recovery primitives for planner and reviewer.
 *
 * The normalizer is deliberately syntax-only. It may remove transport
 * wrappers that carry no meaning; it never extracts a likely-looking object
 * from prose, fills a field, truncates a note, changes an id, or chooses a
 * judgement. Semantic repair belongs to the same agent session and remains
 * subject to the phase's strict parser.
 */

import type { Store } from "./store.js";
import { redactSecretLines, scanForSecrets, storeEvidence } from "./evidence.js";
import { TEXT_LIMITS } from "./text-limits.js";

export const STRUCTURED_REPAIR_ATTEMPTS = 2;
export const STRUCTURED_REPAIR_MAX_TURNS = 4;
export const STRUCTURED_REPAIR_TIMEOUT_MS = 5 * 60_000;

/** Native parsing counts UTF-16 code units. A shorter writing target keeps
 * notes concise without imposing a second, stricter transport contract. */
export const REVIEW_OUTPUT_LIMITS = { comments: 40, criteria: 12, note: TEXT_LIMITS.reviewNote, path: TEXT_LIMITS.reviewPath } as const;
export const REVIEW_NOTE_CODE_POINTS = Math.floor(REVIEW_OUTPUT_LIMITS.note / 2);
export const REVIEW_NOTE_GUIDANCE = `Keep each comment and criterion note to one concise finding and its evidence. Aim for ${REVIEW_NOTE_CODE_POINTS} characters or fewer; the hard limit is ${REVIEW_OUTPUT_LIMITS.note} UTF-16 units. Preserve the conclusion and any needed provenance; omit repeated rubric text.`;

export type StructuredNormalization = {
  text: string;
  changed: boolean;
  changes: readonly ("bom" | "whitespace" | "json-fence" | "json-string")[];
};

/** Strip only unambiguous, whole-payload wrappers. */
export function normalizeStructuredJson(raw: string): StructuredNormalization {
  let text = raw;
  const changes: ("bom" | "whitespace" | "json-fence" | "json-string")[] = [];
  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
    changes.push("bom");
  }

  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  // A pair of complete fenced blocks also matches the outer anchors above
  // (the first opener and final closer). Never collapse that ambiguous
  // payload into one: the strict phase parser should reject it and ask the
  // author to emit one response. A fence marker inside JSON source cannot
  // occur on its own line without making that JSON invalid, so this is a
  // conservative false-negative rather than a semantic rewrite.
  if (fenced !== null && !(fenced[1] ?? "").includes("```")) {
    text = fenced[1] ?? "";
    changes.push("json-fence");
  } else {
    if (trimmed !== text) changes.push("whitespace");
    text = trimmed;
  }

  // Some harness/model pairs double-encode the complete JSON reply as one
  // JSON string. Unwrap exactly one layer only when the decoded value is a
  // string containing one object/array-shaped payload. No brace searching.
  try {
    const once = JSON.parse(text) as unknown;
    if (typeof once === "string") {
      const candidate = once.trim();
      // Shape alone is not enough: `"{not json}"` is content, not an
      // unambiguous transport wrapper. Verify the decoded layer is itself a
      // complete JSON object or array before removing the one string layer.
      let decoded: unknown;
      try {
        decoded = JSON.parse(candidate) as unknown;
      } catch {
        decoded = null;
      }
      if (decoded !== null && typeof decoded === "object") {
        text = candidate;
        changes.push("json-string");
      }
    }
  } catch {
    // The phase parser owns the useful error; normalization never guesses.
  }

  return { text, changed: changes.length > 0, changes };
}

export type StructuredAttemptPhase = "planner" | "reviewer" | "builder-proof";

/**
 * Keep the exact emitted payload unless it contains a high-confidence secret
 * shape, in which case the same line-redaction discipline as terminal diffs
 * keeps the audit record useful without creating a second credential copy.
 */
export function storeStructuredAttempt(
  store: Store,
  root: string,
  logicalRunId: number,
  args: {
    phase: StructuredAttemptPhase;
    attempt: number;
    authoredRunId: number;
    raw: string | Buffer;
    /** Exact source size when `raw` is an intentionally bounded prefix. */
    sourceBytesOriginal?: number;
    /**
     * The exact bytes passed the phase parser and every eligibility gate the
     * caller had checked when it captured them. This is never the workflow's
     * final acceptance: custody, evidence bindings, or the atomic finalizer
     * may still refuse them. The run's terminal outcome is that authority.
     */
    accepted: boolean;
    normalized: boolean;
    now: Date;
  },
): number {
  const rawBytes = Buffer.isBuffer(args.raw) ? args.raw : Buffer.from(args.raw, "utf8");
  const rawText = rawBytes.toString("utf8");
  const hits = scanForSecrets(rawText);
  const content = hits.length === 0 ? rawBytes : Buffer.from(redactSecretLines(rawText, hits), "utf8");
  // `accepted: false` can mean strict validation, provider status, session
  // identity, or another provenance gate rejected the bytes. Keep the
  // evidence wording honest without pretending every refusal was a parser
  // error; the run's typed reason records which gate failed.
  // Do not call a pre-finalization candidate simply "accepted": this
  // artifact must remain truthful if a later custody/binding transaction
  // refuses it. Parser acceptance and final workflow acceptance are separate
  // facts; the latter lives on the terminal run.
  const normalization = args.normalized ? ", syntax normalized" : "";
  const state = args.accepted
    ? `parser accepted${normalization}; workflow pending`
    : `not accepted${normalization}`;
  return storeEvidence(
    store,
    root,
    logicalRunId,
    "structured-output",
    `${args.phase}-response-${args.attempt}.txt`,
    content,
    `${args.phase} response ${args.attempt} from run ${args.authoredRunId} (${state})`,
    args.now,
    {
      redacted: hits.length > 0,
      captureStatus: args.accepted ? "ok" : "failed",
      sourceBytesOriginal: args.sourceBytesOriginal ?? rawBytes.length,
    },
  );
}

/** JSON-quote parser errors so agent-authored ids/paths remain data. */
export function validationErrorsJson(problems: readonly { reason: string; message?: string }[]): string {
  return JSON.stringify(
    problems.map(problem => ({ reason: problem.reason, ...(problem.message === undefined ? {} : { message: problem.message }) })),
    null,
    2,
  );
}
