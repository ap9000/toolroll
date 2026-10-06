/** Pure parsers for review payloads: retained historical reviews, and the one
 * automatic build review's findings (build-review.ts runs it). This module
 * cannot launch providers, create runs or retry work. */
import type { CriterionJudgementWord } from "./proof.js";
import { citesSuppliedProvenance } from "./review-context.js";
import { normalizeStructuredJson, REVIEW_OUTPUT_LIMITS } from "./structured-output.js";
import { readBuildFindings, type BuildFinding } from "./contracts/review-findings.js";

/** The files the pass writes INTO the scratch directory for the agent —
 * the patch always; the rubric, re-serialized proof, check log, and
 * screenshots only when this run actually has one (v40) — a grandfathered
 * run (no rubric) writes exactly what it always has, byte for byte. */
export const REVIEW_PATCH_NAME = "REVIEW-DIFF.patch";
export const REVIEW_RUBRIC_NAME = "REVIEW-RUBRIC.json";
export const REVIEW_PROOF_NAME = "REVIEW-PROOF.json";
/** Audit hardening (still evidence-review-v1, unreleased): the repository's
 * approved verification command's own captured stdout/stderr — a
 * criterion citing `check` evidence was previously judged from the proof's
 * bare claim, never the actual output. */
export const REVIEW_CHECK_LOG_NAME = "REVIEW-CHECK-LOG.txt";
/** v51 (inherited review context): a REVISION's sealed source-and-ancestry
 * inventory — bounded files at the exact sealed head, bound to the source
 * run, plus prior review provenance as context. Materialized only when
 * the run captured one; every other run writes exactly what it always has. */
export const REVIEW_CONTEXT_NAME = "REVIEW-CONTEXT.json";

/** One claimed screenshot's name in the scratch — stable per artifact id,
 * so a reviewer's own tool output naming it is reproducible across a
 * retried materialization within the same pass. */
export function reviewScreenshotName(artifactId: number, kind: "png" | "jpeg"): string {
  return `REVIEW-SCREENSHOT-${artifactId}.${kind === "png" ? "png" : "jpg"}`;
}

export const REVIEW_LIMITS = {
  ...REVIEW_OUTPUT_LIMITS,
  /** The mailbox read cap: 40 maximal comments plus 12 judgements fit with headroom. */
  payload: 64 * 1024,
  /** Initial encoded delivery budget; remaining declared text is available by range. */
  inlineText: 1024 * 1024,
} as const;

export type ReviewComment = {
  path: string;
  line: number | null;
  note: string;
  severity: "note" | "question" | "problem";
};

/** One historical judgement before the ingestion record adds its author. */
export type ReviewCriterionJudgement = { id: string; judgement: CriterionJudgementWord; note: string };

export type ReviewProblem = { reason: string };

/**
 * Every path the patch names — new side, old side, and both halves of a
 * rename — so a comment can be proven patch-local (the brief admits the
 * reviewer saw ONLY the patch; a path it never saw is not a comment, it
 * is a guess).
 */
export function diffPathsOf(patch: string): Set<string> {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) paths.add(line.slice(6).trim());
    else if (line.startsWith("--- a/")) paths.add(line.slice(6).trim());
    else if (line.startsWith("rename to ")) paths.add(line.slice(10).trim());
    else if (line.startsWith("rename from ")) paths.add(line.slice(12).trim());
    else if (line.startsWith("diff --git a/")) {
      // `diff --git a/<old> b/<new>` — the b/ half begins at the last ` b/`.
      const split = line.lastIndexOf(" b/");
      if (split > 13) {
        paths.add(line.slice(13, split).trim());
        paths.add(line.slice(split + 3).trim());
      }
    }
  }
  paths.delete("");
  return paths;
}

/**
 * Strict, wholesale (the mailbox law): a payload with ANY invalid comment
 * OR invalid criterion judgement ingests NOTHING — not just the offending
 * array. The caps are the contract the brief states; a path the patch
 * never named breaks patch-locality; a criterion id absent from the signed
 * rubric, a duplicate id, or an unknown judgement word are the same kind
 * of refusal. `criteria` absent (or incomplete) stays valid ONLY when
 * `approvedCriteriaIds` is empty — every task with no signed rubric, and
 * every grandfathered review (v40). Audit hardening: when a rubric WAS
 * signed, every one of its ids needs exactly one judgement — an omitted
 * id refuses the whole payload exactly like an unsigned one does. A
 * reviewer that ran out of turns and never wrote "criteria" at all is not
 * a comments-only review of a rubric-bearing run; it is a review that
 * never answered what it was asked, and the run's one review allowance is
 * spent on the failure, typed, rather than landing a silent partial pass.
 */
/** v51: what a sealed context inventory demands of the judgements — the
 * criteria whose evidence is NOT this run's own patch must be judged by
 * citing supplied provenance (`ctx-<n>`, a patch path, or a sealed file
 * name) in the note, or left `cannot-tell`. Absent = no inventory was
 * sealed for this run, and the parser reads exactly as before. */
export type ReviewProvenanceRules = {
  itemIds: ReadonlySet<string>;
  provenanceRequired: ReadonlySet<string>;
  sealedFiles: ReadonlySet<string>;
  byCriterion?: ReadonlyMap<string, { itemIds: ReadonlySet<string>; patchPaths: ReadonlySet<string>; sealedFiles: ReadonlySet<string> }>;
};

export function parseReview(
  raw: string,
  patchPaths: ReadonlySet<string>,
  approvedCriteriaIds: ReadonlySet<string> = new Set(),
  provenance?: ReviewProvenanceRules,
): { ok: true; comments: ReviewComment[]; criteria: ReviewCriterionJudgement[]; learning?: unknown; learningAssessment?: unknown } | { ok: false; problems: ReviewProblem[] } {
  const problems: ReviewProblem[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problems: [{ reason: "not JSON" }] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, problems: [{ reason: "not an object" }] };
  }
  const payload = parsed as Record<string, unknown>;
  // Run 1638: claude's structured-output floor is ONE flat object shared
  // with the evidence read channel (a top-level union is refused by the
  // API), so a reply can carry `readEvidence` beside review fields. That
  // is neither a read request (exact keys only, review-evidence.ts) nor a
  // review — refused whole, by name, so the correction turn says which.
  if (payload["readEvidence"] !== undefined) {
    return { ok: false, problems: [{ reason: 'readEvidence must be sent alone as {"version":1,"readEvidence":{...}}; a reply mixing an evidence request with review fields is neither' }] };
  }
  if (payload["version"] !== 1) problems.push({ reason: "version must be 1" });
  const list = payload["comments"];
  if (!Array.isArray(list)) {
    problems.push({ reason: "comments must be an array" });
    return { ok: false, problems };
  }
  if (list.length > REVIEW_LIMITS.comments) {
    problems.push({ reason: `at most ${REVIEW_LIMITS.comments} comments` });
    return { ok: false, problems };
  }
  const comments: ReviewComment[] = [];
  list.forEach((one, index) => {
    if (one === null || typeof one !== "object" || Array.isArray(one)) {
      problems.push({ reason: `comment ${index}: not an object` });
      return;
    }
    const comment = one as Record<string, unknown>;
    const path = comment["path"];
    const line = comment["line"];
    const note = comment["note"];
    const severity = comment["severity"];
    if (typeof path !== "string" || path.length === 0 || path.length > REVIEW_LIMITS.path) {
      problems.push({ reason: `comment ${index}: path must be a string of 1..${REVIEW_LIMITS.path} chars` });
      return;
    }
    if (!patchPaths.has(path)) {
      problems.push({ reason: `comment ${index}: ${path} is not in the reviewed patch` });
      return;
    }
    if (line !== undefined && line !== null && (!Number.isInteger(line) || Number(line) < 1)) {
      problems.push({ reason: `comment ${index}: line must be a positive integer or null` });
      return;
    }
    if (typeof note !== "string" || note.trim().length === 0 || note.length > REVIEW_LIMITS.note) {
      problems.push({ reason: `comment ${index}: note must be a string of 1..${REVIEW_LIMITS.note} UTF-16 units` });
      return;
    }
    if (severity !== undefined && severity !== "note" && severity !== "question" && severity !== "problem") {
      problems.push({ reason: `comment ${index}: severity must be note, question, or problem` });
      return;
    }
    comments.push({
      path,
      line: line === undefined || line === null ? null : Number(line),
      note: note.trim(),
      severity: (severity as ReviewComment["severity"] | undefined) ?? "note",
    });
  });

  const criteria: ReviewCriterionJudgement[] = [];
  const criteriaRaw = payload["criteria"];
  const seenCriteriaIds = new Set<string>();
  if (criteriaRaw !== undefined) {
    if (!Array.isArray(criteriaRaw)) {
      problems.push({ reason: "criteria must be an array" });
    } else if (criteriaRaw.length > REVIEW_LIMITS.criteria) {
      problems.push({ reason: `at most ${REVIEW_LIMITS.criteria} criterion judgements` });
    } else {
      criteriaRaw.forEach((one, index) => {
        if (one === null || typeof one !== "object" || Array.isArray(one)) {
          problems.push({ reason: `criterion ${index}: not an object` });
          return;
        }
        const entry = one as Record<string, unknown>;
        const id = entry["id"];
        const judgement = entry["judgement"];
        const note = entry["note"];
        if (typeof id !== "string" || id.length === 0) {
          problems.push({ reason: `criterion ${index}: id must be a non-empty string` });
          return;
        }
        if (!approvedCriteriaIds.has(id)) {
          problems.push({ reason: `criterion ${index}: "${id}" is not a signed criterion` });
          return;
        }
        if (seenCriteriaIds.has(id)) {
          problems.push({ reason: `criterion ${index}: "${id}" is judged more than once` });
          return;
        }
        if (judgement !== "upholds" && judgement !== "contradicts" && judgement !== "cannot-tell") {
          problems.push({ reason: `criterion ${index}: judgement must be upholds, contradicts, or cannot-tell` });
          return;
        }
        if (typeof note !== "string" || note.trim().length === 0 || note.length > REVIEW_LIMITS.note) {
          problems.push({ reason: `criterion ${index}: note must be a string of 1..${REVIEW_LIMITS.note} UTF-16 units` });
          return;
        }
        // v51: a criterion outside this run's own patch is settled only by
        // supplied provenance — an `upholds` or `contradicts` whose note
        // cites none of it is a guess dressed as a judgement, and the whole
        // payload is refused (the correction turn says exactly which id).
        if (
          provenance !== undefined &&
          judgement !== "cannot-tell" &&
          provenance.provenanceRequired.has(id) &&
          !citesSuppliedProvenance(note, provenance.byCriterion?.get(id) ?? { itemIds: provenance.itemIds, patchPaths, sealedFiles: provenance.sealedFiles })
        ) {
          problems.push({ reason: `criterion ${index}: "${id}" is outside the reviewed patch — a ${judgement} must cite supplied provenance (a ctx-<n> item, a patch path, or a sealed file name) or be cannot-tell` });
          return;
        }
        seenCriteriaIds.add(id);
        criteria.push({ id, judgement, note: note.trim() });
      });
    }
  }

  // Full coverage (audit hardening): a signed rubric admits no partial
  // review. Every id in `approvedCriteriaIds` needs exactly one judgement
  // — an omitted id (including every id, when "criteria" is absent
  // entirely) is refused the same way an unsigned id is: the whole
  // payload, comments included, never a silent partial pass.
  if (approvedCriteriaIds.size > 0) {
    const missing = [...approvedCriteriaIds].filter(id => !seenCriteriaIds.has(id));
    if (missing.length > 0) {
      problems.push({ reason: `criteria is missing judgement(s) for signed id(s): ${missing.join(", ")}` });
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, comments, criteria, ...(payload["learning"] === undefined ? {} : { learning: payload["learning"] }), ...(payload["learningAssessment"] === undefined ? {} : { learningAssessment: payload["learningAssessment"] }) };
}

export type { BuildFinding, FindingSeverity } from "./contracts/review-findings.js";

/** One line, as a revision note and a terminal show it: controls and runs of whitespace become one space. */
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The automatic build review's reply, read through its contract (src/contracts/review-findings.ts), strict and
 * wholesale like parseReview: `{"version":1,"findings":[{"severity","file","line","scenario"}]}`. Any invalid
 * finding refuses the whole reply — a review that did not answer what it was asked is "not reviewed", never a partial
 * pass — and the refusal names each path (`findings[0].line: at least 1`). The reply shares Claude's review channel
 * (provider.ts), so only its version and findings are read, as always. Text is kept to one line so it can travel in a
 * revision note and a terminal; a file or scenario that is blank once it is one line is refused by path.
 */
export function parseBuildFindings(raw: string): { ok: true; findings: BuildFinding[] } | { ok: false; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeStructuredJson(raw).text);
  } catch {
    return { ok: false, problem: "the reply is not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, problem: "the reply is not an object" };
  const reply = parsed as Record<string, unknown>;
  const read = readBuildFindings({ ...(Object.prototype.hasOwnProperty.call(reply, "version") ? { version: reply["version"] } : {}), findings: reply["findings"] });
  if (!read.ok) return { ok: false, problem: read.issues.map(issue => issue.line).join("; ") };
  const findings: BuildFinding[] = [];
  for (const [index, finding] of read.value.findings.entries()) {
    const file = oneLine(finding.file), scenario = oneLine(finding.scenario);
    if (file === "") return { ok: false, problem: `findings[${index}].file: must not be blank` };
    if (scenario === "") return { ok: false, problem: `findings[${index}].scenario: must not be blank` };
    findings.push({ ...finding, file, scenario });
  }
  return { ok: true, findings };
}
