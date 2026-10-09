/**
 * The build's own claim, adjudicated against evidence the plane captured
 * itself (`docs/PRIORITIES.md` Priority 2). Modelled line-for-line on the
 * scout's report (`scout-report.ts`): fail closed, every problem reported at
 * once, stable reasons, byte caps, control-character rejection on every
 * string.
 *
 * The proof is a distinct deliverable from the terminal handoff every
 * attempt writes (including `failed` ones, whose lists are deliberately
 * compacted prose) — only a `completed` attempt owes one, and the plane
 * judges it. A missing or malformed proof never fails the attempt or
 * touches the commit; it only keeps the verdict off "verified".
 *
 * `adjudicate` is pure and does no I/O: every fact it reasons over — whether
 * the proof artifact exists, whether the handoff and terminal diff exist,
 * what the sealed diff-stat says, whether a screenshot's bytes actually are
 * a PNG or JPEG, whether an approved verification command ran and what it
 * returned — is gathered by the caller (`builder.ts`) and handed in as data,
 * so the review itself stays testable without a filesystem or a database.
 */

import { hasForbiddenControls } from "./decision.js";
import type { EvidenceKind } from "./scope.js";
import { contractProblemOf, type ContractProblem } from "./contracts/contract.js";
import type { VerifyCommandFacts } from "./contracts/verification-receipt.js";
import { PROOF_LIMITS, proofPayloadBody, readProofPayload, type CriterionEvidenceRef, type ParsedCriterion, type ParsedProof } from "./contracts/proof.js";

export { PROOF_LIMITS, type CriterionEvidenceRef, type ParsedCheck, type ParsedCriterion, type ParsedProof, type ParsedScreenshot } from "./contracts/proof.js";

export type ProofVerdict = "verified" | "attested" | "short" | "refuted";

/** v39: the rubric side of a criterion, as `adjudicate` reads it — the
 * SIGNED id, statement, and required evidence kinds. Never `how` (never
 * signed). Empty = nothing signed: `adjudicate` runs the v1 rules,
 * byte for byte. */
export type ApprovedCriterion = { id: string; statement: string; evidence: readonly EvidenceKind[] };

/** Shared by preflight and final adjudication; presentation text is never a rubric. */
function criterionContractProblems(approved: ApprovedCriterion, answer: ParsedCriterion | undefined): { kind: "missing" | "statement" | "evidence"; message: string }[] {
  if (answer === undefined) return [{ kind: "missing", message: `the proof does not answer approved criterion "${approved.id}"` }];
  const problems: { kind: "missing" | "statement" | "evidence"; message: string }[] = [];
  if (answer.statement.trim() !== approved.statement.trim()) {
    problems.push({ kind: "statement", message: `criterion "${approved.id}" was signed as "${approved.statement}" and the proof restates it as "${answer.statement}"` });
  }
  for (const kind of approved.evidence) {
    if (!answer.evidence.some(ref => ref.kind === kind)) {
      problems.push({ kind: "evidence", message: `criterion "${approved.id}" requires ${kind} evidence, which the proof does not reference` });
    }
  }
  return problems;
}

/** Only submission defects. A truthful not-met answer is not malformed. */
export function proofSubmissionProblems(proof: ParsedProof, rubric: readonly ApprovedCriterion[]): string[] {
  const answers = new Map(proof.criteria.map(one => [one.id, one]));
  const problems = rubric.flatMap(one => criterionContractProblems(one, answers.get(one.id)).map(problem => problem.message));
  const checks = new Set(proof.checks.map(one => one.command));
  const changed = new Set(proof.changed);
  const shots = new Set(proof.screenshots.map(one => one.path));
  for (const criterion of proof.criteria) {
    if (criterion.verdict === "pending-verification" && !rubric.some(one => one.id === criterion.id && one.evidence.includes("check"))) {
      problems.push(`criterion ${criterion.id} can wait for the final check only when its signed requirements include check evidence`);
    }
    for (const evidence of criterion.evidence) {
      const resolves = evidence.kind === "check" ? checks.has(evidence.ref)
        : evidence.kind === "changed-path" ? changed.has(evidence.ref)
        : evidence.kind === "screenshot" ? shots.has(evidence.ref) : true;
      if (!resolves) problems.push(`criterion ${criterion.id} names a ${evidence.kind} ref that resolves to nothing — ${JSON.stringify(evidence.ref)}`);
    }
  }
  problems.push(...failedMetChecks(proof).map(failedCheckWords));
  return problems;
}

export type ProofProblem = ContractProblem;

export type ProofParseResult =
  | { ok: true; proof: ParsedProof }
  | { ok: false; problems: ProofProblem[] };

function refuse(reason: string, message: string): ProofParseResult {
  return { ok: false, problems: [{ reason, message }] };
}

/** One text field the plain-code rules check, at its path: its byte limit, and whether it is a relative path. */
type TextField = { path: string; value: string; bytes: number; relative?: true };

/** Every text field of a proof body (version 2 shape) that the schema saw as a string. */
function textFields(body: Record<string, unknown>): TextField[] {
  const out: TextField[] = [];
  const text = (path: string, value: unknown, bytes: number, relative?: true) => {
    if (typeof value === "string") out.push({ path, value, bytes, ...(relative ? { relative } : {}) });
  };
  const records = (field: string): [number, Record<string, unknown>][] => {
    const list = body[field];
    return Array.isArray(list) ? list.flatMap((one, index) => (typeof one === "object" && one !== null && !Array.isArray(one) ? [[index, one as Record<string, unknown>] as [number, Record<string, unknown>]] : [])) : [];
  };
  for (const [index, one] of records("criteria")) {
    text(`criteria[${index}].id`, one["id"], PROOF_LIMITS.criterionId);
    text(`criteria[${index}].statement`, one["statement"], PROOF_LIMITS.criterionStatement);
    text(`criteria[${index}].how`, one["how"], PROOF_LIMITS.criterionHow);
    const evidence = one["evidence"];
    if (Array.isArray(evidence)) {
      evidence.forEach((ref, at) => {
        if (typeof ref === "object" && ref !== null) text(`criteria[${index}].evidence[${at}].ref`, (ref as Record<string, unknown>)["ref"], PROOF_LIMITS.evidenceRef);
      });
    }
  }
  for (const [index, one] of records("checks")) {
    text(`checks[${index}].command`, one["command"], PROOF_LIMITS.checkCommand);
    text(`checks[${index}].summary`, one["summary"], PROOF_LIMITS.checkSummary);
  }
  for (const field of ["changed", "caveats"] as const) {
    const list = body[field];
    if (Array.isArray(list)) list.forEach((one, index) => text(`${field}[${index}]`, one, field === "changed" ? PROOF_LIMITS.changedPath : PROOF_LIMITS.caveat));
  }
  for (const [index, one] of records("screenshots")) {
    text(`screenshots[${index}].path`, one["path"], PROOF_LIMITS.screenshotPath, true);
    text(`screenshots[${index}].caption`, one["caption"], PROOF_LIMITS.screenshotCaption);
  }
  return out;
}

/**
 * The rules JSON Schema cannot state, in plain code with path-named errors: blank text, UTF-8 byte limits, control
 * characters, normalized repository-relative screenshot paths (no leading slash, `.`/`..` segment or backslash — the
 * shape `readVerifiedArtifact` enforces on an evidence key), and unique criterion ids and screenshot paths. A field
 * the schema already refused is not reported twice.
 */
function proofRuleProblems(body: Record<string, unknown>, contract: readonly ProofProblem[]): ProofProblem[] {
  const named = (path: string) => contract.some(problem => problem.message.startsWith(`${path}:`));
  const problems: ProofProblem[] = [];
  for (const field of textFields(body)) {
    if (named(field.path)) continue;
    const { path, value } = field;
    if (value.trim() === "") problems.push({ reason: `missing-${path}`, message: `${path}: must not be blank` });
    else if (Buffer.byteLength(value, "utf8") > field.bytes) problems.push({ reason: `${path}-too-long`, message: `${path}: over ${field.bytes.toLocaleString("en-US")} bytes` });
    else if (hasForbiddenControls(value)) problems.push({ reason: `${path}-controls`, message: `${path}: carries control characters that could become terminal escapes` });
    else if (field.relative && (value.startsWith("/") || !value.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\")))) {
      problems.push({ reason: `${path}-not-relative`, message: `${path}: must be a normalized repository-relative path` });
    }
  }
  const unique = (field: "criteria" | "screenshots", key: "id" | "path", what: string) => {
    const list = body[field];
    if (!Array.isArray(list) || named(field)) return;
    const seen = new Set<string>();
    list.forEach((one, index) => {
      const value = typeof one === "object" && one !== null ? (one as Record<string, unknown>)[key] : undefined;
      if (typeof value !== "string") return;
      if (seen.has(value)) problems.push({ reason: `${field}[${index}]-duplicate-${key}`, message: `${field}[${index}].${key}: ${what} ${JSON.stringify(value)} appears twice` });
      seen.add(value);
    });
  };
  unique("criteria", "id", "criterion id");
  unique("screenshots", "path", "screenshot path");
  return problems;
}

/**
 * Read a proof: the payload byte cap and JSON first, then the proof schema (version 2 as itself, the version 1 a
 * builder writes upgraded, a newer one refused plainly), then the plain-code rules. Every problem names its path and
 * is reported at once; fail closed.
 */
export function parseProof(raw: string): ProofParseResult {
  if (Buffer.byteLength(raw, "utf8") > PROOF_LIMITS.payload) {
    return refuse("too-large", `payload: over ${PROOF_LIMITS.payload.toLocaleString("en-US")} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return refuse("not-json", `the payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = proofPayloadBody(parsed);
  if (body === null) return refuse("not-an-object", "payload: must be one JSON object");
  const read = readProofPayload(parsed);
  const contract = read.ok ? [] : read.issues.map(contractProblemOf);
  if (contract.some(problem => problem.reason === "newer-version" || problem.reason === "bad-version")) return { ok: false, problems: contract };
  const problems = [...contract, ...proofRuleProblems(body, contract)];
  if (!read.ok || problems.length > 0) return { ok: false, problems };
  return { ok: true, proof: read.value };
}

/** Serialize the validated shape, never the agent's raw bytes (the scout report's rule, `scout.ts`): what is stored
 * and later hash-verified is exactly what the schema admitted, in its key order. */
export function serializeProof(proof: ParsedProof): string {
  return JSON.stringify(proof, null, 2);
}

/** One caveat that admits an exception to a criterion the same proof marks
 * `met` — the proof's own verdict disagreeing with its own words (atomic
 * authority closure). A caveat NAMES a criterion when the criterion's exact
 * id appears in it as a standalone token (`c1: …`, `(c1)`, `c1,c4`); a
 * named criterion must then be `not-met` or `not-checked`. Nothing here is
 * semantic — the machine cannot read a free-text caveat's meaning, so the
 * contract is the token, stated in the brief and refused by the preflight
 * before the attempt ends. */
export type BlockingCaveat = { caveat: string; index: number; criterionId: string };

function caveatNames(caveat: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, "u").test(caveat);
}

/** Every (caveat, criterion) pair where the caveat names a criterion the
 * proof marks `met` — the proof contradicts itself and cannot verify. In
 * caveat order, then criterion order; `[]` for a proof at peace with its
 * own caveats. */
export function blockingCaveats(proof: Pick<ParsedProof, "criteria" | "caveats">): BlockingCaveat[] {
  const met = proof.criteria.filter(one => one.verdict === "met" || one.verdict === "pending-verification");
  const out: BlockingCaveat[] = [];
  proof.caveats.forEach((caveat, index) => {
    for (const criterion of met) if (caveatNames(caveat, criterion.id)) out.push({ caveat, index, criterionId: criterion.id });
  });
  return out;
}

/** One check a criterion marked `met` cites that exited nonzero — the
 * criterion's id, the exact cited command, and the exit code the proof
 * itself reported. */
export type FailedCheckCitation = { criterionId: string; ref: string; exitCode: number };

/**
 * Every check a criterion marked `met` cites that the proof's own `checks`
 * list says exited nonzero (proof preflight closure): a met criterion
 * resting on a failing command is not evidence, it is a contradiction the
 * adjudicator fails the row for. A not-met or not-checked criterion may
 * cite a failed check honestly — it is reporting, not claiming — so only
 * `met` and `pending-verification` count here: pending asserts the agent's
 * own checks already passed. A ref that resolves to no check is a different
 * problem (an unresolved ref), not this one. In criterion order, then
 * evidence order.
 */
export function failedMetChecks(proof: Pick<ParsedProof, "criteria" | "checks">): FailedCheckCitation[] {
  const checksByCommand = new Map(proof.checks.map(c => [c.command, c] as const));
  const out: FailedCheckCitation[] = [];
  for (const criterion of proof.criteria) {
    if (criterion.verdict !== "met" && criterion.verdict !== "pending-verification") continue;
    for (const evidence of criterion.evidence) {
      if (evidence.kind !== "check") continue;
      const check = checksByCommand.get(evidence.ref);
      if (check !== undefined && check.exitCode !== 0) out.push({ criterionId: criterion.id, ref: evidence.ref, exitCode: check.exitCode });
    }
  }
  return out;
}

/** The one actionable fact a failed check citation is reported as — the
 * adjudicator's matrix detail and the agent's exit preflight say exactly
 * this, so what the preflight refuses is what the plane would have said. */
export function failedCheckWords(one: FailedCheckCitation): string {
  return `criterion "${one.criterionId}"'s check "${one.ref}" exited ${one.exitCode}`;
}

/**
 * One caveat the machine cannot attribute (final authority closure): every
 * caveat is an exception to a signed criterion, and it names that
 * criterion's exact id as a standalone token — so a caveat that names NO
 * known criterion (`unassigned`), or whose leading tag names an id nobody
 * signed (`unknown`), is a claim the verdict cannot be reconciled with.
 * An idea that is not an exception to any criterion belongs in the
 * handoff's follow-ups, not here.
 *
 * THE KNOWN IDS ARE THE SIGNED ONES (final admission closure): when a
 * rubric was signed, only its ids count — an extra criterion the proof
 * authored for itself is the proof's own word, never signed authority, so
 * a caveat tagged with it alone is unknown in preflight and adjudication
 * alike. Only a proof with NO signed rubric may attribute its caveats to
 * the criteria it answered.
 */
export type CaveatAttributionProblem = {
  caveat: string;
  index: number;
  kind: "unassigned" | "unknown";
  tags: string[];
  /** The unknown tags the proof answered for itself (present only when a
   * rubric was signed and at least one such tag exists): the words say
   * the criterion is the proof's own, not that nobody answered it. */
  answered?: string[];
};

/** The leading tag list of a caveat — `c1: …`, `c1, c4: …`, `(c2) …` — as
 * the tokens it names before its first colon or after its parentheses.
 * A caveat with no such prefix has no tags; its attribution rests on any
 * known id appearing as a standalone token anywhere in it. */
function leadingTags(caveat: string): string[] {
  const separator = String.raw`(?:\s*[,/&+]\s*(?:and\s+)?|\s+and\s+)`;
  const prefixed = new RegExp(String.raw`^\s*\(?\s*([\p{L}\p{N}_-]+(?:${separator}[\p{L}\p{N}_-]+)*)\s*\)?\s*:`, "u").exec(caveat);
  if (prefixed === null) return [];
  return prefixed[1]!.split(new RegExp(separator, "u")).map(one => one.trim()).filter(one => one !== "");
}

export function caveatAttributionProblems(
  proof: Pick<ParsedProof, "criteria" | "caveats">,
  signedIds: readonly string[] = [],
): CaveatAttributionProblem[] {
  const own = new Set<string>(proof.criteria.map(one => one.id));
  const known = new Set<string>(signedIds.length > 0 ? signedIds : [...own]);
  const out: CaveatAttributionProblem[] = [];
  proof.caveats.forEach((caveat, index) => {
    const named = [...known].filter(id => caveatNames(caveat, id));
    const tags = leadingTags(caveat);
    const unknown = tags.filter(tag => !known.has(tag));
    const answered = signedIds.length > 0 ? unknown.filter(tag => own.has(tag)) : [];
    if (unknown.length > 0) out.push({ caveat, index, kind: "unknown", tags: unknown, ...(answered.length > 0 ? { answered } : {}) });
    else if (named.length === 0) out.push({ caveat, index, kind: "unassigned", tags: [] });
  });
  return out;
}

/** The words one attribution problem refuses in — shared by the plane's
 * adjudication and the agent's exit preflight so both say the same thing. */
export function caveatAttributionWords(problem: CaveatAttributionProblem): string {
  if (problem.kind !== "unknown") {
    return `caveat ${problem.index + 1} names no criterion — every caveat is an exception to exactly one signed criterion, named by its exact id (an unrelated idea belongs in the handoff's follow-ups): ${problem.caveat}`;
  }
  const quoted = problem.tags.map(tag => `"${tag}"`).join(", ");
  const answered = problem.answered ?? [];
  return answered.length > 0 && answered.length === problem.tags.length
    ? `caveat ${problem.index + 1} names ${quoted}, a criterion the proof authored for itself that nobody signed — a proof-only id is no signed authority; every caveat names a signed criterion's exact id: ${problem.caveat}`
    : `caveat ${problem.index + 1} names ${quoted}, which is no signed or answered criterion — every caveat names an exact criterion id: ${problem.caveat}`;
}

/** One claimed screenshot's fate once the caller has read its bytes off the
 * worktree and checked them against the PNG/JPEG signature and size cap. */
export type ScreenshotOutcome = {
  path: string;
  ok: boolean;
  /** Set when ok is false — why the claimed file did not become evidence. */
  problem?: string;
  /** v39: set when ok is true — the bytes actually read, for the
   * "meaningful byte size" half of the screenshot-evidence rule. */
  bytes?: number;
  /** v39: set when ok is true and dimensions could be read from the
   * image header; null when the format parsed but dimensions could not
   * be determined. Absent entirely for a pre-v39 caller. */
  dims?: { width: number; height: number } | null;
};

/** v39: the floor a criterion's screenshot evidence must clear — "real,
 * not placeholder-sized" in exact numbers (scope: "meaningful byte size
 * and at least 320 by 200 dimensions"). */
export const SCREENSHOT_EVIDENCE_MIN_BYTES = 1024;
export const SCREENSHOT_EVIDENCE_MIN_WIDTH = 320;
export const SCREENSHOT_EVIDENCE_MIN_HEIGHT = 200;

/** What `captureTerminalDiff` gives back, restated for adjudication:
 * whether the sealed stat parsed at all, whether the file list was cut to
 * fit the cap, and the set of paths it names. A truncated stat cannot prove
 * a claimed path is ABSENT, so rule 4 does not fire against one. */
export type DiffStatFacts = {
  captured: boolean;
  truncated: boolean;
  paths: ReadonlySet<string>;
  /** Old name → destination for every entry git paired as a rename or
   * move. The old name is provenance the stat keeps; it is never one of
   * `paths`. Absent on a stat that recorded no renames. */
  renames?: ReadonlyMap<string, string>;
};

/** How a proof's `changed` list compares with the sealed diff-stat, read
 * before the first review so the same session can correct a receipt the
 * sealed facts themselves explain (the Goose FinalOutputTool pattern: a
 * precise error plus the exact expected value, never a silent rewrite).
 *
 * `problems` names every discrepancy, one line per path. `recoverable` is
 * true only when the stat is complete and EVERY discrepancy is one the
 * sealed input establishes on its own: the old name of a rename git
 * paired (the diff holds its destination once), or a sealed path the
 * list left out. Then `sealed` is the one admissible correction — the
 * complete sealed inventory, sorted — and nothing else is. A claimed path
 * the diff never had is an unexplained contradiction: reported, never
 * recoverable, so adjudication refutes it by name. An unavailable or
 * truncated stat proves nothing either way: no problems, not recoverable. */
export type ChangedListReview = {
  problems: string[];
  recoverable: boolean;
  sealed: string[] | null;
};

export function changedListProblems(changed: readonly string[], stat: DiffStatFacts | null): ChangedListReview {
  if (stat === null || !stat.captured || stat.truncated) return { problems: [], recoverable: false, sealed: null };
  const claimed = new Set(changed);
  const problems: string[] = [];
  let unexplained = false;
  for (const path of changed) {
    if (stat.paths.has(path)) continue;
    const destination = stat.renames?.get(path);
    if (destination !== undefined && stat.paths.has(destination)) {
      problems.push(`changed lists ${JSON.stringify(path)}, the old name of a move the sealed diff records once as ${JSON.stringify(destination)} — list the destination only`);
    } else {
      unexplained = true;
      problems.push(`changed lists ${JSON.stringify(path)}, which the sealed diff does not contain`);
    }
  }
  for (const path of stat.paths) {
    if (!claimed.has(path)) problems.push(`changed omits ${JSON.stringify(path)}, which the sealed diff contains`);
  }
  const sealed = [...stat.paths].sort();
  return { problems, recoverable: problems.length > 0 && !unexplained, sealed };
}

/** What a receipt-only correction may never touch: the exact criterion
 * id/verdict pairs the agent submitted (comment 397, run 1648). A
 * correction restates a signed statement or repairs an evidence reference
 * against the exact rubric; it cannot move an answer (not-met or
 * not-checked becoming pending-verification, or any other change of
 * word), drop a criterion — an extra negative answer is a finding, not a
 * formatting defect — or add one. One line per frozen pair broken. */
export function frozenCriterionProblems(submitted: ParsedProof, corrected: ParsedProof): string[] {
  const problems: string[] = [];
  const after = new Map(corrected.criteria.map(one => [one.id, one.verdict] as const));
  for (const prior of submitted.criteria) {
    const verdict = after.get(prior.id);
    if (verdict === undefined) {
      problems.push(`criterion ${prior.id} (${prior.verdict}) was dropped; every submitted criterion and its verdict are frozen by a receipt-only correction`);
    } else if (verdict !== prior.verdict) {
      problems.push(`criterion ${prior.id} was submitted as ${prior.verdict}; a receipt-only correction cannot change it to ${verdict}`);
    }
  }
  const before = new Set(submitted.criteria.map(one => one.id));
  for (const one of corrected.criteria) {
    if (!before.has(one.id)) problems.push(`criterion ${one.id} was added; a receipt-only correction answers exactly the submitted criteria`);
  }
  return problems;
}

/** Whether two readings of the sealed diff-stat state the same facts:
 * the same capture standing, the same paths and the same rename
 * provenance. Settlement reads the stat once before the receipt
 * correction and re-reads it after that correction and after the final
 * gate; a reading that differs is never adjudicated from the cached one. */
export function sameDiffStatFacts(a: DiffStatFacts | null, b: DiffStatFacts | null): boolean {
  if (a === null || b === null) return a === b;
  const restate = (one: DiffStatFacts) => JSON.stringify({
    captured: one.captured,
    truncated: one.truncated,
    paths: [...one.paths].sort(),
    renames: [...(one.renames ?? [])].sort(),
  });
  return restate(a) === restate(b);
}

/** What the approved verification command did (the receipt's `result`); its schema lives with the receipt. */
export type { VerifyCommandFacts } from "./contracts/verification-receipt.js";

export type AdjudicateInput = {
  /** New captures may assess the signed goal directly when the builder wrote
   * no optional proof. Historical calls retain their original contract. */
  directAssessment?: boolean;
  /** Controller-owned command label, never a builder-reported check. */
  verificationCommand?: string;
  /** Whether a `proof` artifact was stored at all for this run. */
  proofArtifactPresent: boolean;
  /** null when no proof artifact exists; otherwise the parse of its bytes. */
  proofParse: ProofParseResult | null;
  handoffPresent: boolean;
  terminalDiffPresent: boolean;
  terminalDiffCaptureStatus: "ok" | "failed" | null;
  diffStat: DiffStatFacts | null;
  verifyCommand: VerifyCommandFacts;
  /** One entry per screenshot the proof claimed, in the order claimed.
   * Empty when the proof named none. */
  screenshots: readonly ScreenshotOutcome[];
  /** v39: the SIGNED rubric this run's scope carried at dispatch, in id
   * order. `[]` (the default) is the grandfathering promise made good:
   * every rule below that reads this is skipped whole, and adjudication
   * runs exactly the v1 rules that follow it. */
  approvedCriteria?: readonly ApprovedCriterion[];
  /** v51: the sealed review-context inventory's per-criterion coverage,
   * when this run captured one. Attached to the matrix rows verbatim; it
   * never moves the verdict — context is for the reviewer, the verdict is
   * the machine's. Absent = no coverage key on any row. */
  reviewContext?: readonly ({ id: string } & CriterionCoverage)[];
};

export type AdjudicateResult = { verdict: ProofVerdict; reasons: string[]; matrix: CriterionMatrixRow[]; machineVerdict?: ProofVerdict };
export const GOAL_ASSESSMENT_PENDING = "The saved evidence is awaiting independent goal assessment.";
/** Legacy folds could only lower a verdict. Direct assessment also records an
 * ordinary wait between green machine checks and the goal judgement. */
export function reviewConflict(matrix: readonly CriterionMatrixRow[], machine: ProofVerdict | null, verdict: ProofVerdict | null): boolean {
  return matrix.some(row => row.assessment !== undefined) ? matrix.some(row => row.review?.judgement === "contradicts")
    : machine !== null && machine !== verdict;
}

/** One row of the criterion-to-evidence matrix every result-facing surface
 * renders identically (task, run, done, builds, board, inbox, chat —
 * Priority 2's "one surface, six places" rule, extended). `pass`: every
 * required evidence kind resolved. `missing`: the criterion went
 * unanswered, or a required kind has no reference at all. `failed`: a
 * reference exists but did not resolve (wrong check exit code, invalid
 * screenshot, a changed-path claim the sealed diff does not back).
 * `manual-review`: every required kind resolved EXCEPT at least one
 * `manual-review` kind, which is never machine-verifiable by design — the
 * row still needs a human's eyes even though nothing failed. */
export type CriterionMatrixState = "pass" | "missing" | "failed" | "manual-review";

/** Human sign-off is owed, with no other recorded evidence failure. This is
 * presentation only; it never changes a verdict or grants acceptance. */
export function manualReviewOnly(proof: { verdict: string; reasons: readonly string[]; matrix?: readonly CriterionMatrixRow[] } | null): boolean {
  return proof?.verdict === "short" && (proof.matrix === undefined || (proof.matrix.some(row => row.state === "manual-review")
    && proof.matrix.every(row => row.state === "pass" || row.state === "manual-review")))
    && proof.reasons.length > 0
    && proof.reasons.every(reason => manualReviewCriterionOf(reason) !== null);
}

/** The criterion id a stored "needs a person's check" reason names, or null
 * for any other reason. The stored words stay as recorded; pages say them
 * through `personCheckWords`. */
export function manualReviewCriterionOf(reason: string): string | null {
  return /^criterion "([^"]+)" requires manual-review evidence — an operator must accept it before this can verify$/.exec(reason)?.[1] ?? null;
}

/** A stored verification reason as a person would say it, for pages and
 * cards. The record keeps its exact words; unknown reasons pass through. */
export function plainReasonWords(reason: string): string {
  if (manualReviewCriterionOf(reason) !== null) return "A requirement needs your own check.";
  const unassigned = /^caveat [0-9]+ names no criterion — every caveat is an exception to exactly one signed criterion, named by its exact id \(an unrelated idea belongs in the handoff's follow-ups\): ([\s\S]*)$/.exec(reason);
  if (unassigned !== null) return `The agent left a note without saying which requirement it affects: ${unassigned[1]}`;
  const reviewed = /^(?:reviewer:)?([^\s"]+) (contradicts|needs more evidence for) criterion "[^"]+": ([\s\S]*)$/i.exec(reason);
  if (reviewed !== null) return `${reviewed[1]} ${reviewed[2]!.toLowerCase() === "contradicts" ? "says a requirement is not met" : "isn't sure a requirement is met"}: ${reviewed[3]}`;
  return reason;
}

/** A requirement only a person can confirm, as a person would say it. */
export function personCheckWords(statement: string | null): string {
  const plain = statement?.trim() ?? "";
  return plain === "" ? "You check this one yourself." : `You check this one: ${plain}`;
}
export type CriterionMatrixRow = {
  /** Controller-captured evidence for direct goal assessment. Kept separately
   * from the final row state: available evidence is not a satisfied goal. */
  assessment?: { evidenceState: CriterionMatrixState; detail: string[] };
  id: string;
  statement: string;
  requiredEvidence: readonly EvidenceKind[];
  state: CriterionMatrixState;
  /** Why this row is not a plain pass — empty for `pass`. */
  detail: string[];
  /** The proof's OWN typed evidence references for this criterion, exactly
   * as it answered them — never only the required kinds, so a render can
   * show what was actually cited (and link the artifact behind it, where
   * one exists). `[]` when the criterion went unanswered. */
  answered: readonly CriterionEvidenceRef[];
  /** v40: the independent reviewer's judgement on this criterion, folded in
   * by `foldReview` after `adjudicate` has already run — `null` until a
   * review has settled, and for every criterion no review addressed. */
  review: { judgement: CriterionJudgementWord; note: string; author: string } | null;
  /** v51 (inherited review context): where an independent reviewer's
   * evidence for this criterion comes from — this run's own patch, a
   * sealed context inventory, or nowhere (a named gap). Present only on
   * runs that captured an inventory (revisions); absent on every other
   * run, which reads exactly as before: judged from the patch. */
  coverage?: CriterionCoverage;
};

/** The per-criterion context projection stored on the matrix row (v51),
 * copied from the sealed inventory's coverage at adjudication. */
export type CriterionCoverage = {
  state: "patch" | "context" | "gap";
  /** Same id AND statement as the source run's signed rubric. */
  inherited: boolean;
  /** Provenance tokens (`ctx-<n>`) for complete files or explicitly partial
   * ancestor patches. A partial patch keeps state `gap`, even with eligible
   * prior support; neither property supplies a current judgement. */
  items: string[];
  /** Why context is missing or partial — empty for `patch` and `context`. */
  gaps: string[];
  /** Whether an earlier review of the source run may be weighed as
   * context: eligible only with the same text, verified ancestry, and
   * byte-identical relevant code. Never a judgement on this run. */
  priorSupport: "eligible" | "invalid" | "none";
  /** The change's images and other binary files in one line, when it has any. */
  assets?: string;
};

/** v40: the three words an evidence reviewer can say about one signed
 * criterion, and nothing else — `cannot-tell` is a CORRECT answer whenever
 * the sealed patch alone cannot settle a criterion, not a hedge. */
export type CriterionJudgementWord = "upholds" | "contradicts" | "cannot-tell";

/** One reviewer's typed judgement on one signed criterion (v40), ready to
 * fold into an already-adjudicated result. */
export type CriterionJudgement = {
  id: string;
  judgement: CriterionJudgementWord;
  note: string;
  author: string;
};

/** Set equality, exactly — the "must equal the complete sealed git diff
 * exactly" rule (v39) needs both directions, unlike the legacy subset
 * check. */
function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const one of a) if (!b.has(one)) return false;
  return true;
}

/**
 * The criterion-to-evidence matrix, computed once and shared by every
 * surface (v39) — best-effort from whatever is available: `proof` is null
 * when no proof parsed at all, in which case every approved criterion is
 * simply unanswered. `[]` whenever no rubric was signed, so a
 * grandfathered run renders no matrix at all rather than a wall of
 * "missing" rows nobody signed up for.
 */
function criterionMatrix(
  approvedCriteria: readonly ApprovedCriterion[],
  proof: ParsedProof | null,
  diffStat: DiffStatFacts | null,
  screenshots: readonly ScreenshotOutcome[],
): CriterionMatrixRow[] {
  if (approvedCriteria.length === 0) return [];
  const answers = new Map((proof?.criteria ?? []).map(c => [c.id, c] as const));
  const screenshotsByPath = new Map(screenshots.map(s => [s.path, s] as const));
  const checksByCommand = new Map((proof?.checks ?? []).map(c => [c.command, c] as const));
  const changedSet = new Set(proof?.changed ?? []);
  // null = cannot know either way (diff unavailable or truncated) — never
  // treated as agreement, per "an unavailable or truncated diff cannot verify".
  const diffExact =
    diffStat !== null && diffStat.captured && !diffStat.truncated ? setEquals(changedSet, diffStat.paths) : null;

  return approvedCriteria.map((approved): CriterionMatrixRow => {
    const base = { id: approved.id, statement: approved.statement, requiredEvidence: approved.evidence, review: null };
    const answer = answers.get(approved.id);
    const contract = criterionContractProblems(approved, answer);
    if (answer === undefined) {
      return { ...base, state: "missing", detail: contract.map(one => one.message), answered: [] };
    }
    if (answer.statement.trim() !== approved.statement.trim()) {
      return {
        ...base,
        state: "failed",
        detail: contract.filter(one => one.kind === "statement").map(one => one.message),
        answered: answer.evidence,
      };
    }
    const detail: string[] = [];
    let anyMissing = false;
    let anyFailed = false;
    let anyManual = false;
    // Only adjudicate's trusted successful final check resolves this state.
    // Until then the shared row must not misleadingly read as passed.
    if (answer.verdict === "pending-verification") {
      anyMissing = true;
      detail.push(`criterion "${approved.id}" is waiting for the final check`);
    }
    // The proof's own caveats outrank its verdict word: a criterion marked
    // `met` that a caveat names is not met by the proof's own admission.
    for (const blocking of proof === null ? [] : blockingCaveats(proof)) {
      if (blocking.criterionId !== approved.id) continue;
      anyFailed = true;
      detail.push(`criterion "${approved.id}" is marked met, but caveat ${blocking.index + 1} admits an exception to it: ${blocking.caveat}`);
    }
    for (const kind of approved.evidence) {
      const ref = answer.evidence.find(e => e.kind === kind);
      if (ref === undefined) {
        anyMissing = true;
        detail.push(...contract.filter(one => one.kind === "evidence" && one.message.includes(`requires ${kind} evidence`)).map(one => one.message));
        continue;
      }
      if (kind === "manual-review") {
        anyManual = true;
        detail.push(`criterion "${approved.id}" requires manual-review evidence — an operator must accept it before this can verify`);
        continue;
      }
      if (kind === "check") {
        const check = checksByCommand.get(ref.ref);
        if (check === undefined) {
          anyFailed = true;
          detail.push(`criterion "${approved.id}"'s check evidence "${ref.ref}" does not match any reported check`);
        } else if (check.exitCode !== 0) {
          anyFailed = true;
          detail.push(failedCheckWords({ criterionId: approved.id, ref: ref.ref, exitCode: check.exitCode }));
        }
        continue;
      }
      if (kind === "screenshot") {
        const shot = screenshotsByPath.get(ref.ref);
        if (shot === undefined || !shot.ok) {
          anyFailed = true;
          detail.push(`criterion "${approved.id}"'s screenshot evidence "${ref.ref}" could not be verified${shot?.problem ? `: ${shot.problem}` : ""}`);
        } else if (
          (shot.bytes ?? 0) < SCREENSHOT_EVIDENCE_MIN_BYTES ||
          shot.dims == null ||
          shot.dims.width < SCREENSHOT_EVIDENCE_MIN_WIDTH ||
          shot.dims.height < SCREENSHOT_EVIDENCE_MIN_HEIGHT
        ) {
          anyFailed = true;
          detail.push(
            `criterion "${approved.id}"'s screenshot "${ref.ref}" is missing or placeholder-sized (needs a real PNG or JPEG of at least ${SCREENSHOT_EVIDENCE_MIN_BYTES} bytes and ${SCREENSHOT_EVIDENCE_MIN_WIDTH}x${SCREENSHOT_EVIDENCE_MIN_HEIGHT})`,
          );
        }
        continue;
      }
      // changed-path
      if (!changedSet.has(ref.ref)) {
        anyFailed = true;
        detail.push(`criterion "${approved.id}"'s changed-path evidence "${ref.ref}" is not among the proof's claimed changed paths`);
      } else if (diffExact !== true) {
        anyFailed = true;
        detail.push(
          diffExact === null
            ? `criterion "${approved.id}"'s changed-path evidence cannot verify — the sealed diff is unavailable or truncated`
            : `criterion "${approved.id}"'s changed-path evidence cannot verify — the proof's changed paths do not exactly match the sealed diff`,
        );
      }
    }
    const state: CriterionMatrixState = anyMissing ? "missing" : anyFailed ? "failed" : anyManual ? "manual-review" : "pass";
    return { ...base, state, detail, answered: answer.evidence };
  });
}

/** Evidence readiness only. The signed criteria are copied from the scope,
 * never restated by the builder; an independent assessment must settle them. */
function assessCapturedEvidence(input: AdjudicateInput): AdjudicateResult {
  const completeDiff = input.diffStat !== null && input.diffStat.captured && !input.diffStat.truncated;
  const check = input.verifyCommand;
  const checked = check.configured && check.ran && check.exitCode === 0;
  let machineVerdict: ProofVerdict = checked ? "verified" : "attested";
  const problems: string[] = [];
  if (!input.handoffPresent) problems.push("the terminal handoff is missing");
  if (!input.terminalDiffPresent || input.terminalDiffCaptureStatus !== "ok") problems.push("the machine-captured diff is missing or failed to capture");
  if (!completeDiff) problems.push("the sealed diff is unavailable or truncated; the exact candidate cannot be assessed");
  if (check.configured && !check.ran) problems.push(verificationFailureWords(check.failure));
  if (problems.length > 0) machineVerdict = "short";
  if (check.configured && check.ran && check.exitCode !== 0) {
    machineVerdict = "refuted";
    problems.push(`the repository's approved verification command exited ${check.exitCode}`);
  }
  const matrix = (input.approvedCriteria ?? []).map((criterion): CriterionMatrixRow => {
    const detail: string[] = [];
    const answered: CriterionEvidenceRef[] = [];
    let missing = false, failed = false, manual = false;
    for (const kind of criterion.evidence) {
      if (kind === "check") {
        if (checked) answered.push({ kind, ref: input.verificationCommand ?? "approved project check" });
        else {
          failed ||= check.configured && check.ran && check.exitCode !== 0;
          missing ||= !check.configured || !check.ran;
          detail.push(`criterion "${criterion.id}" needs a passing approved project check`);
        }
      } else if (kind === "changed-path") {
        if (completeDiff) {
          for (const path of input.diffStat!.paths) answered.push({ kind, ref: path });
        } else { missing = true; detail.push(`criterion "${criterion.id}" needs the complete saved source inventory`); }
      } else if (kind === "screenshot") {
        // Screenshots must have been explicitly captured and validated, never
        // guessed from arbitrary files or inferred from a passing test.
        const shots = input.screenshots.filter(shot => shot.ok && (shot.bytes ?? 0) >= SCREENSHOT_EVIDENCE_MIN_BYTES &&
          shot.dims != null && shot.dims.width >= SCREENSHOT_EVIDENCE_MIN_WIDTH && shot.dims.height >= SCREENSHOT_EVIDENCE_MIN_HEIGHT);
        if (shots.length === 0) { missing = true; detail.push(`criterion "${criterion.id}" needs a captured screenshot of the required behavior`); }
        else for (const shot of shots) answered.push({ kind, ref: shot.path });
      } else {
        manual = true;
        detail.push(`criterion "${criterion.id}" requires manual-review evidence — an operator must accept it before this can verify`);
      }
    }
    const evidenceState: CriterionMatrixState = failed ? "failed" : missing ? "missing" : manual ? "manual-review" : "pass";
    const coverage = input.reviewContext?.find(one => one.id === criterion.id);
    return {
      id: criterion.id, statement: criterion.statement, requiredEvidence: criterion.evidence,
      assessment: { evidenceState, detail }, state: evidenceState === "pass" ? "missing" : evidenceState,
      detail: [...detail, `criterion "${criterion.id}" awaits independent goal assessment`], answered, review: null,
      ...(coverage === undefined ? {} : { coverage: { state: coverage.state, inherited: coverage.inherited, items: [...coverage.items], gaps: [...coverage.gaps], priorSupport: coverage.priorSupport, ...(coverage.assets === undefined ? {} : { assets: coverage.assets }) } }),
    };
  });
  return { machineVerdict, verdict: machineVerdict === "refuted" ? "refuted" : "short", matrix,
    reasons: problems.length > 0 ? problems : [GOAL_ASSESSMENT_PENDING] };
}

/** Only direct assessments can settle a pending goal. Machine failures and
 * required evidence remain authoritative; this never upgrades a legacy proof. */
function foldGoalAssessment(base: AdjudicateResult, judgements: readonly CriterionJudgement[]): AdjudicateResult {
  const byId = new Map(judgements.map(one => [one.id, one]));
  const matrix = base.matrix.map((row): CriterionMatrixRow => {
    const evidence = row.assessment!;
    const judgement = byId.get(row.id);
    const review = judgement === undefined ? row.review : { judgement: judgement.judgement, note: judgement.note, author: judgement.author };
    const contradicted = review?.judgement === "contradicts";
    const upheld = review?.judgement === "upholds";
    return { ...row, review,
      state: contradicted ? "failed" : evidence.evidenceState === "pass" ? upheld ? "pass" : "missing" : evidence.evidenceState,
      detail: [...evidence.detail, ...(upheld ? [] : [review === null
        ? `criterion "${row.id}" awaits independent goal assessment`
        : `${review.author} ${contradicted ? "contradicts" : "needs more evidence for"} criterion "${row.id}": ${review.note}`])],
    };
  });
  const machineReady = base.machineVerdict === "verified" || base.machineVerdict === "attested";
  const contradicted = matrix.some(row => row.review?.judgement === "contradicts");
  const passed = machineReady && matrix.every(row => row.state === "pass" && row.review?.judgement === "upholds");
  const verdict = base.machineVerdict === "refuted" || contradicted ? "refuted" : passed ? base.machineVerdict! : "short";
  return { ...base, verdict, matrix, reasons: passed ? ["The saved evidence and independent assessment satisfy the approved goal."]
    : [...(!machineReady ? base.reasons : []), ...matrix.flatMap(row => row.detail)] };
}

function verificationFailureWords(failure: Extract<VerifyCommandFacts, { ran: false }>["failure"]): string {
  return (() => {
      switch (failure) {
        case "dependency-missing":
          return "the approved verification command could not start because a required project executable was unavailable and no approved recovery was enabled";
        case "setup-stale":
          return "automatic recovery stopped because the project setup or check changed";
        case "setup-failed":
          return "the approved setup command failed during automatic recovery";
        case "own-install-failed":
          return "the checkout's own dependency install failed after its package.json or lockfile changed";
        case "tracked-files-changed":
          return "automatic recovery stopped because tracked files no longer matched the built result";
        case "setup-changed-files":
          return "automatic recovery stopped because the setup command changed tracked files after the build";
        case "checkout-moved":
          return "automatic recovery stopped because the checkout moved away from the built commit";
        case "cleanliness-unavailable":
          return "automatic recovery stopped because Toolroll could not confirm that the built checkout was unchanged";
        case "dependency-still-missing":
          return "the required project executable was still unavailable after replaying the approved setup command";
        case "retry-spawn-failed":
          return "the retried verification command could not be started after automatic recovery";
        case "retry-timed-out":
          return "the retried verification command timed out after automatic recovery";
        case "custody-lost":
          return "automatic recovery stopped because this worker no longer owned the build";
        case "timed-out":
          return "the approved verification command timed out before checks finished";
        case "spawn-failed":
        default:
          return "the approved verification command could not be run";
      }
    })();
}

/**
 * Ordered rules; the first that fires wins. Every reason is a sentence the
 * surfaces print verbatim — this function is the only place that decides
 * wording, so the task page, run page, board, CLI, and chat cards cannot
 * drift from each other (Priority 2, the "one surface, six places" rule).
 *
 * v39: `input.approvedCriteria` empty runs the rules below byte for byte —
 * the grandfathering promise. Non-empty inserts the rubric rules AFTER the
 * diff-stat and verify-command rules and BEFORE the legacy unmet check,
 * exactly as approved in the v2 plan: a proof that alters a signed
 * criterion's statement is REFUTED (the same severity as any other
 * altered term); an unanswered criterion, an evidence reference that does
 * not resolve, or a criterion capped at manual-review is SHORT (a gap, or
 * a review a machine cannot finish, never a lie). The legacy self-declared
 * `verdict` field still runs afterward and can only downgrade further,
 * never upgrade past what the evidence proved.
 *
 * The changed[] vs. sealed-diff exactness check (review finding, post-v39)
 * runs GLOBALLY, ahead of the rubric rules and independent of whether any
 * criterion cites changed-path evidence at all — a rubric with none of
 * those must not let an untruthful or incomplete changed[] through
 * unchecked. An unavailable or truncated diff-stat cannot prove either
 * direction, so it can only ever produce SHORT, never REFUTED.
 */
/** An optional screenshot inventory carries no builder-authored completion
 * claims. The existing bounded parser still validates every supplied field. */
export function artifactManifestOnly(proof: ParsedProof): boolean {
  return proof.criteria.length === 0 && proof.checks.length === 0 && proof.changed.length === 0 && proof.caveats.length === 0;
}

export function adjudicate(input: AdjudicateInput): AdjudicateResult {
  const approvedCriteria = input.approvedCriteria ?? [];
  if (input.directAssessment && approvedCriteria.length > 0 && (!input.proofArtifactPresent ||
    (input.proofParse?.ok && artifactManifestOnly(input.proofParse.proof)))) return assessCapturedEvidence(input);
  const coverageById = new Map((input.reviewContext ?? []).map(one => [one.id, one] as const));
  const matrixOf = (proof: ParsedProof | null): CriterionMatrixRow[] =>
    criterionMatrix(approvedCriteria, proof, input.diffStat, input.screenshots).map(row => {
      if (input.reviewContext === undefined) return row;
      const found = coverageById.get(row.id);
      // A criterion the inventory never covered is a gap the surfaces
      // must show, never a silent "judged from the patch".
      const coverage: CriterionCoverage = found === undefined
        ? { state: "gap", inherited: false, items: [], gaps: ["the sealed review context carries no coverage entry for this criterion"], priorSupport: "none" }
        : { state: found.state, inherited: found.inherited, items: [...found.items], gaps: [...found.gaps], priorSupport: found.priorSupport, ...(found.assets === undefined ? {} : { assets: found.assets }) };
      return { ...row, coverage };
    });

  if (!input.proofArtifactPresent) {
    return { verdict: "short", reasons: ["no proof was written"], matrix: matrixOf(null) };
  }
  if (input.proofParse === null || !input.proofParse.ok) {
    const detail =
      input.proofParse !== null && !input.proofParse.ok
        ? input.proofParse.problems.map(p => p.message).join("; ")
        : "the proof could not be read";
    return { verdict: "short", reasons: [`the proof is malformed: ${detail}`], matrix: matrixOf(null) };
  }
  const submitted = input.proofParse.proof;
  const finalCheckPassed = input.verifyCommand.configured && input.verifyCommand.ran && input.verifyCommand.exitCode === 0;
  const pendingContractValid = proofSubmissionProblems(submitted, approvedCriteria).length === 0;
  // Resolve only an explicit conditional claim, against THIS run's machine
  // facts. Never infer intent from prose, modify the sealed receipt, or turn
  // a genuine not-met/not-checked answer into success. All evidence, caveat,
  // manual-review and artifact checks below still apply to the resolved copy.
  const proof: ParsedProof = {
    ...submitted,
    criteria: submitted.criteria.map(one => one.verdict === "pending-verification" && finalCheckPassed && pendingContractValid &&
      approvedCriteria.some(approved => approved.id === one.id && approved.evidence.includes("check") && approved.statement.trim() === one.statement.trim())
      ? { ...one, verdict: "met" } : one),
  };
  const matrix = matrixOf(proof);

  if (!input.handoffPresent) {
    return { verdict: "short", reasons: ["the terminal handoff is missing"], matrix };
  }
  if (!input.terminalDiffPresent || input.terminalDiffCaptureStatus === "failed") {
    return { verdict: "short", reasons: ["the machine-captured diff is missing or failed to capture"], matrix };
  }

  // The claimed changed[] must equal the COMPLETE sealed diff exactly —
  // globally, whether or not any signed criterion cites changed-path
  // evidence at all (a rubric with none of those would otherwise let an
  // untruthful or incomplete changed[] through unchecked). An unavailable
  // or truncated stat cannot prove either direction, so it cannot verify:
  // short, never refuted — "we could not check" is not "the claim is
  // false" (the same ruling the verify-command facts make below).
  if (input.diffStat === null || !input.diffStat.captured || input.diffStat.truncated) {
    return {
      verdict: "short",
      reasons: ["the sealed diff is unavailable or truncated; the claimed changed paths cannot be verified against it"],
      matrix,
    };
  }
  {
    const diffPaths = input.diffStat.paths;
    const claimed = new Set(proof.changed);
    const overclaimed = proof.changed.filter(path => !diffPaths.has(path));
    if (overclaimed.length > 0) {
      return {
        verdict: "refuted",
        reasons: [`claimed changed path${overclaimed.length > 1 ? "s" : ""} not in the sealed diff: ${overclaimed.join(", ")}`],
        matrix,
      };
    }
    const underclaimed = [...diffPaths].filter(path => !claimed.has(path));
    if (underclaimed.length > 0) {
      return {
        verdict: "short",
        reasons: [`the sealed diff touched path${underclaimed.length > 1 ? "s" : ""} the proof never claimed as changed: ${underclaimed.join(", ")}`],
        matrix,
      };
    }
  }

  // Altering a signed requirement is an integrity contradiction, not an
  // evidence gap. It outranks an environment failure: an unavailable check
  // must never downgrade changed authority from refuted to short.
  if (approvedCriteria.length > 0) {
    const restated = matrix.filter(row => row.detail.some(d => d.includes("was signed as")));
    if (restated.length > 0) {
      return { verdict: "refuted", reasons: restated.flatMap(row => row.detail), matrix };
    }
  }

  // A proof whose caveat admits an exception to a criterion it marks met
  // contradicts itself (atomic authority closure): the verdict must agree
  // with the caveats, and a self-disagreeing proof is conflicting
  // evidence — refuted, never verified, whether or not a rubric was
  // signed. It ranks with the altered-statement rule above: an
  // environment failure must never soften a contradiction to short.
  {
    const blocking = blockingCaveats(proof);
    if (blocking.length > 0) {
      return {
        verdict: "refuted",
        reasons: blocking.map(one => `criterion "${one.criterionId}" is marked met, but caveat ${one.index + 1} admits an exception to it: ${one.caveat}`),
        matrix,
      };
    }
    // EVERY caveat is attributed (final authority closure): one that names
    // no known criterion, or a tag nobody signed, is an exception the
    // verdict cannot be reconciled with — the proof's own words do not
    // say which criterion they qualify, and the plane refutes rather than
    // guesses. Known ids are the signed rubric's alone when one was
    // signed (a proof-authored extra id is no authority); the proof's own
    // only when nothing was signed.
    const unattributed = caveatAttributionProblems(proof, approvedCriteria.map(one => one.id));
    if (unattributed.length > 0) {
      return { verdict: "refuted", reasons: unattributed.map(caveatAttributionWords), matrix };
    }
  }

  // A command that could not exercise the product is missing evidence, not
  // contradictory evidence. This precedes criterion-state checks so the
  // actionable environment cause is never buried under a generic gap.
  if (input.verifyCommand.configured && !input.verifyCommand.ran) {
    const reason = verificationFailureWords(input.verifyCommand.failure);
    return { verdict: "short", reasons: [reason], matrix };
  }

  if (input.verifyCommand.configured && input.verifyCommand.ran && input.verifyCommand.exitCode !== 0) {
    return {
      verdict: "refuted",
      reasons: [
        input.verifyCommand.setupReplayed === true
          ? `the repository's approved verification command exited ${input.verifyCommand.exitCode} after the approved setup command was replayed`
          : `the repository's approved verification command exited ${input.verifyCommand.exitCode}`,
      ],
      matrix,
    };
  }

  if (approvedCriteria.length > 0) {
    // manual-review folds in here too (v39 review finding): a row that
    // needs a human's eyes is never machine-verifiable, so it must never
    // reach "verified" or "attested" on its own — it stays "short" until
    // an operator explicitly accepts the proof (the same act that already
    // lets a short/refuted run read as done).
    const unresolved = matrix.filter(row => row.state === "missing" || row.state === "failed" || row.state === "manual-review");
    if (unresolved.length > 0) {
      return { verdict: "short", reasons: unresolved.flatMap(row => row.detail), matrix };
    }
  }

  const unmet = proof.criteria.filter(c => c.verdict !== "met");
  if (unmet.length > 0) {
    return {
      verdict: "short",
      reasons: unmet.map(c => `criterion "${c.statement}" is ${c.verdict === "not-met" ? "not met" : c.verdict === "pending-verification" ? "waiting for the final check" : "not checked"}`),
      matrix,
    };
  }

  const badScreenshots = input.screenshots.filter(s => !s.ok);
  if (badScreenshots.length > 0) {
    return {
      verdict: "short",
      reasons: badScreenshots.map(s => `claimed screenshot "${s.path}" could not be verified${s.problem ? `: ${s.problem}` : ""}`),
      matrix,
    };
  }

  if (input.verifyCommand.configured && input.verifyCommand.ran && input.verifyCommand.exitCode === 0) {
    return {
      verdict: "verified",
      reasons: [
        input.verifyCommand.setupReplayed === true
          ? "the approved verification command passed after the approved setup command ran"
          : "the approved verification command passed",
      ],
      matrix,
    };
  }
  return { verdict: "attested", reasons: ["the proof agrees with the sealed diff; no verification command is configured to re-run"], matrix };
}

/**
 * Folds an independent reviewer's per-criterion judgements into an ALREADY
 * ADJUDICATED result (v40, evidence-review-v1) — pure, and never re-derives
 * verdict facts that were not persisted (verify-command outcome, screenshot
 * bytes): it folds over the STORED result, it does not re-run `adjudicate`.
 *
 * Three rules, and they are the whole contract:
 *  - `contradicts` -> refuted. A second reader saying a signed term is not
 *    met is the same severity as a proof that altered the term: the
 *    matching row becomes `failed`, with the reviewer's note as an
 *    attributed `detail` line.
 *  - `cannot-tell` changes nothing. Recorded and rendered, never moves the
 *    verdict — "we could not check" is not "the claim is false" (the same
 *    maxim `adjudicate` already lives by for an unavailable diff or a
 *    failed verify-command attempt).
 *  - `upholds` never upgrades. A `short` (or `attested`) run stays exactly
 *    what it was — this is the law that stops a second model laundering a
 *    bad proof, and the reason `foldReview` can only LOWER a verdict, never
 *    raise one.
 *
 * A judgement naming a criterion absent from `base.matrix` is ignored —
 * `parseReview` already refuses a payload naming an unsigned id, so this is
 * belt and suspenders, never a live path.
 */
export function foldReview(base: AdjudicateResult, judgements: readonly CriterionJudgement[]): AdjudicateResult {
  if (judgements.length === 0) return base;
  if (base.matrix.length > 0 && base.matrix.every(row => row.assessment !== undefined)) {
    return foldGoalAssessment(base, judgements);
  }
  const byId = new Map(judgements.map(j => [j.id, j] as const));
  let anyContradiction = false;
  const matrix = base.matrix.map((row): CriterionMatrixRow => {
    const judgement = byId.get(row.id);
    if (judgement === undefined) return row;
    const review = { judgement: judgement.judgement, note: judgement.note, author: judgement.author };
    if (judgement.judgement !== "contradicts") return { ...row, review };
    anyContradiction = true;
    return {
      ...row,
      state: "failed",
      detail: [...row.detail, `${judgement.author} contradicts criterion "${row.id}": ${judgement.note}`],
      review,
    };
  });
  if (!anyContradiction) return { ...base, matrix };
  const contradictions = matrix.filter(row => row.review?.judgement === "contradicts");
  return {
    verdict: "refuted",
    reasons: [...base.reasons, ...contradictions.flatMap(row => (row.review === null ? [] : [`${row.review.author} contradicts criterion "${row.id}": ${row.review.note}`]))],
    matrix,
  };
}

/**
 * SEMANTIC coverage (v51): what an INDEPENDENT reviewer actually settled,
 * shown distinctly from the machine proof the matrix `state` records. One
 * projection for the task page, run page, receipt, chat card, and CLI —
 * never a second status engine: it reads the stored matrix and the run's
 * signed quality mode and moves nothing.
 *
 * The policy is explicit and unchanged from v41: under `default` an
 * independent review is optional, so absent or uncertain judgements are
 * reported and nothing is "unsatisfied"; under `strict` (Strict / release)
 * independent coverage is REQUIRED, and only `upholds` satisfies it — a
 * `cannot-tell` is an honest answer that leaves the criterion uncovered,
 * a `contradicts` is a failure, and an unreviewed criterion is uncovered.
 * `cannot-tell` never satisfies required coverage under either policy.
 * Context gaps (`coverage.state === "gap"`) are listed so a reader sees
 * WHY a reviewer could not tell, in the same words the inventory used.
 */
export type SemanticCoverage = {
  policy: "default" | "strict";
  /** Independent coverage is required by the signed policy. */
  required: boolean;
  total: number;
  upheld: string[];
  contradicted: string[];
  uncertain: string[];
  unreviewed: string[];
  /** Criterion ids with a named context gap, with the reasons — every
   * row that carries one, whether or not the patch still judges it. */
  contextGaps: { id: string; gaps: string[] }[];
  /** null when no review has folded at all (nothing to satisfy or fail);
   * otherwise whether every criterion is upheld — the only reading under
   * which required coverage counts as satisfied. */
  satisfied: boolean | null;
};

export function semanticCoverage(matrix: readonly CriterionMatrixRow[], policy: "default" | "strict"): SemanticCoverage {
  const judged = (word: CriterionJudgementWord): string[] => matrix.filter(row => row.review?.judgement === word).map(row => row.id);
  const upheld = judged("upholds");
  const contradicted = judged("contradicts");
  const uncertain = judged("cannot-tell");
  const unreviewed = matrix.filter(row => row.review === null).map(row => row.id);
  // Every named gap is listed, including one on a row the patch still
  // judges: what could not be sealed is said, whatever else was.
  const contextGaps = matrix.flatMap(row => (row.coverage !== undefined && row.coverage.gaps.length > 0 ? [{ id: row.id, gaps: [...row.coverage.gaps] }] : []));
  const reviewed = matrix.length - unreviewed.length;
  return {
    policy,
    required: policy === "strict" || matrix.some(row => row.assessment !== undefined),
    total: matrix.length,
    upheld,
    contradicted,
    uncertain,
    unreviewed,
    contextGaps,
    satisfied: matrix.length === 0 || reviewed === 0 ? null : upheld.length === matrix.length,
  };
}

/** The coverage in plain words — one line every surface prints the same
 * way. `[]` for a run with no rubric: nothing to cover. */
export function coverageWords(coverage: SemanticCoverage): string[] {
  if (coverage.total === 0) return [];
  const lines: string[] = [];
  // No review has folded: nothing is waited for (model review is retired),
  // so only sealed context gaps are worth a line.
  if (coverage.satisfied === null) {
    for (const gap of coverage.contextGaps) lines.push(`context gap ${gap.id}: ${gap.gaps.join("; ")}`);
    return lines;
  }
  const standing =
    coverage.satisfied === null
      ? coverage.required ? "required under strict quality — no independent review has settled yet" : "independent review is optional under default quality — none has settled"
      : coverage.satisfied
        ? coverage.required ? "required under strict quality — satisfied" : "optional under default quality — every criterion upheld"
        : coverage.required
          ? `required under strict quality — NOT satisfied (${[...(coverage.uncertain.length > 0 ? [`cannot-tell never counts: ${coverage.uncertain.join(", ")}`] : []), ...(coverage.contradicted.length > 0 ? [`contradicted: ${coverage.contradicted.join(", ")}`] : []), ...(coverage.unreviewed.length > 0 ? [`unreviewed: ${coverage.unreviewed.join(", ")}`] : [])].join("; ")})`
          : `optional under default quality — ${coverage.upheld.length}/${coverage.total} upheld${coverage.uncertain.length > 0 ? `, cannot-tell: ${coverage.uncertain.join(", ")}` : ""}${coverage.contradicted.length > 0 ? `, contradicted: ${coverage.contradicted.join(", ")}` : ""}`;
  lines.push(`semantic coverage: ${coverage.upheld.length}/${coverage.total} upheld by an independent reviewer — ${coverage.policy === "default" && coverage.required ? standing.replaceAll("under strict quality", "for goal assessment") : standing}`);
  for (const gap of coverage.contextGaps) lines.push(`context gap ${gap.id}: ${gap.gaps.join("; ")}`);
  return lines;
}

/** The pass fraction of a criterion matrix — the one number every list
 * surface (board, chat) needs, shared so "N/M criteria" is computed in
 * exactly one place (v40 closes the two hand-rolled copies). */
export function passFraction(matrix: readonly CriterionMatrixRow[]): { passed: number; total: number } {
  return { passed: matrix.filter(row => row.state === "pass").length, total: matrix.length };
}

/** The matrix in plain lines, for a text surface (the CLI, `brief`) — the
 * same shared vocabulary `criterionMatrixHtml` renders in the console, so
 * the words never drift between the two (Priority 2's rule, extended). */
export function matrixWords(matrix: readonly CriterionMatrixRow[]): string[] {
  if (matrix.length === 0) return [];
  const lines: string[] = ["  acceptance matrix"];
  for (const row of matrix) {
    lines.push(`    [${row.state}] ${row.id}: ${row.statement} (requires: ${row.requiredEvidence.join(", ")})`);
    if (row.answered.length > 0) {
      lines.push(`      answered: ${row.answered.map(a => `${a.kind}: ${a.ref}`).join("; ")}`);
    }
    for (const detail of row.detail) lines.push(`      ${detail}`);
    if (row.review !== null) {
      lines.push(`      review (${row.review.author}): ${row.review.judgement} — ${row.review.note}`);
    }
    if (row.coverage !== undefined) {
      lines.push(`      context: ${coverageStateWords(row.coverage)}`);
    }
  }
  return lines;
}

/** One criterion's context standing in words — shared by the CLI matrix
 * and the console badge title so the two never drift. */
export function coverageStateWords(coverage: CriterionCoverage): string {
  const prior = coverage.priorSupport === "eligible" ? "; an earlier review of the source may be weighed as context (never as this run's verdict)" : coverage.priorSupport === "invalid" ? "; the earlier source review no longer supports it" : "";
  switch (coverage.state) {
    case "patch":
      return `judged from this run's own patch${coverage.gaps.length > 0 ? ` (${coverage.gaps.join("; ")})` : ""}${prior}`;
    case "context":
      return `inherited — sealed context ${coverage.items.join(", ")}${prior}`;
    case "gap":
      return `GAP — inherited context is missing: ${coverage.gaps.join("; ")}${coverage.items.length > 0 ? ` (partial: ${coverage.items.join(", ")})` : ""}${prior}`;
  }
}

/** The verdict a result shows today, read from the stored one and the facts recorded since, never written back: a
 * failed check or an unresolved HIGH review finding refutes; a pending review, or any acceptance criterion that has
 * not passed, keeps it short. It only ever lowers the stored verdict. */
export function shownVerdictOf(stored: ProofVerdict | null, facts: { checkFailed: boolean; highFindings: number; reviewPending: boolean; criteriaPassed: boolean }): ProofVerdict | null {
  if (facts.checkFailed || facts.highFindings > 0 || stored === "refuted") return "refuted";
  if (stored === null) return null;
  if (facts.reviewPending || !facts.criteriaPassed) return "short";
  return stored;
}

/** Plain words for a verdict, shared by every surface (the `summary.ts`
 * pattern) so the task page, run page, board, CLI, and chat cannot say
 * three different things about the same run. */
export function verdictWords(verdict: ProofVerdict, reasons: readonly string[]): { word: string; detail: string } {
  const detail = reasons.length > 0 ? reasons.join("; ") : "";
  switch (verdict) {
    case "verified":
      return { word: "complete — verified", detail };
    case "attested":
      return { word: "complete — evidence attested", detail };
    case "short":
      return { word: "missing evidence", detail };
    case "refuted":
      return { word: "conflicting evidence", detail };
  }
}

/** The `data-dispatch-status` token a page's CSS and tests key off. */
export function dispatchStatusToken(verdict: ProofVerdict): "complete-verified" | "complete-with-evidence" | "needs-verification" | "proof-refuted" {
  switch (verdict) {
    case "verified":
      return "complete-verified";
    case "attested":
      return "complete-with-evidence";
    case "short":
      return "needs-verification";
    case "refuted":
      return "proof-refuted";
  }
}
