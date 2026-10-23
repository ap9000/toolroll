// Assignment direct assessments reuse custody checks; gaps remain explicit.
import { readObservationEvidence, OBSERVATION_CAPTURE, type ObservationEvidence } from "./observations.js";
import { isVerificationReceipt } from "./verification-evidence.js";
/**
 * Inherited review context (v51, contract handoff task 3): the bounded,
 * sealed source-and-ancestry inventory a REVISION's reviewer is shown
 * beside the revision's own patch.
 *
 * A small revision to a larger feature carries the whole feature's signed
 * rubric, but its terminal diff shows only what the revision touched — so
 * an honest reviewer could only say `cannot-tell` about every criterion
 * the earlier build implemented (run 1518 said exactly that three times,
 * although run 1514 had upheld those same criteria on the base). This
 * module closes that gap WITHOUT letting a reviewer read a checkout:
 *
 *  - Complete items are files read from the git object database BY EXACT
 *    COMMIT (the revision's sealed head) and literal path — `ls-tree` for
 *    identity and size, `cat-file blob` for bytes — with lazy fetch,
 *    replace refs, filters, textconv, and diff drivers all out of the
 *    picture. The working tree is never read: a checkout is mutable, a
 *    blob at a commit is not.
 *  - Which paths are relevant comes from VERIFIED ancestor artifacts: the
 *    source run's sealed proof (its changed paths and the changed-path
 *    evidence it cited per criterion) and its sealed diff-stat. Every item
 *    binds to the source run, the commit, the path, the blob id, and a
 *    SHA-256 of the stored bytes.
 *  - Storage ceilings are independent of prompt delivery. A pathological
 *    oversized file remains a NAMED
 *    GAP. Schema 2 may also supply bounded partial ancestor patch sections
 *    with exact artifact ranges and all intervening sealed changes. Tree
 *    identity is proved independently of full-file capture. Binary,
 *    non-UTF-8, missing, redacted and over-budget context stays a gap.
 *  - An earlier reviewer's judgement on the source run is CONTEXT ONLY.
 *    It is exposed as `priorReview` with its own eligibility proof — same
 *    criterion text, verified ancestry, relevant code byte-identical
 *    between the source head and this head, the source review's own
 *    bindings intact — and never as an automatic judgement for this run.
 *
 * `coverage` is the per-criterion projection every surface reads: `patch`
 * (judged from this revision's own diff), `context` (inherited, partly or wholly outside
 * the patch, every relevant path sealed here), or `gap` (inherited but
 * some relevant context could not be supplied — the reasons are listed).
 */

import { createHash } from "node:crypto";
import { hasForbiddenControls } from "./decision.js";
import type { ExecResult } from "./exec.js";
import { EVIDENCE_CAPS, isBinaryAssetPath, isImagePath, readVerifiedArtifact, redactSecretLines, scanForSecrets, storeEvidence } from "./evidence.js";
import { parseProof, type ApprovedCriterion, type CriterionJudgementWord, type ParsedProof } from "./proof.js";
import type { Artifact, Store } from "./store.js";

/** Explicit bounds. Content bytes are UTF-8 of the stored (possibly
 * redacted) text; the aggregate is the sum over every stored item. */
export const LEGACY_REVIEW_CONTEXT_LIMITS = {
  /** One complete file or partial patch chain. Larger files stay gaps. */
  itemBytes: 48 * 1024,
  /** Every item's bytes together. Whatever would cross it is a named gap. */
  aggregateBytes: 192 * 1024,
  /** Items stored, in deterministic relevance order. */
  items: 24,
  /** Candidate paths considered from the source proof and diff-stat. */
  candidatePaths: 200,
  /** Prior review rows carried as context. */
  priorReviews: 48,
  ancestors: 16,
} as const;

/** Storage ceilings, independent of delivery. Ordinary large files remain whole.
 * The encoded artifact allows worst-case JSON escaping plus metadata. */
export const REVIEW_CONTEXT_LIMITS = {
  ...LEGACY_REVIEW_CONTEXT_LIMITS,
  itemBytes: 8 * 1024 * 1024,
  aggregateBytes: 32 * 1024 * 1024,
  items: 200,
} as const;

/** Only this compact projection enters prompts. Full bytes remain sealed in
 * the artifact and are materialized under generated, flat scratch names. */
export function reviewContextFileName(id: string): string {
  if (!ITEM_ID.test(id)) throw new Error("invalid context item id");
  return `REVIEW-CONTEXT-${id}.txt`;
}

export type ContextGapReason =
  | "source-missing"
  | "source-unverified"
  | "source-proof-missing"
  | "source-scope-changed"
  | "criterion-changed"
  | "stale-ancestry"
  | "missing-at-head"
  | "not-a-file"
  | "binary"
  | "over-limit"
  | "aggregate-limit"
  | "item-cap"
  | "secret-redacted"
  | "capture-failed";

export type ContextItemWhy = "source-criterion-evidence" | "source-changed-path" | "candidate-changed-path";

export type ReviewContextItem = {
  /** `ctx-<n>`: the provenance token a reviewer cites in its notes. */
  id: string;
  path: string;
  /** The exact commit the blob was read at — this run's sealed head. */
  commit: string;
  /** The git blob id at that commit and path. */
  blob: string;
  /** SHA-256 of `content` exactly as stored (after any redaction). */
  sha256: string;
  bytes: number;
  content: string;
  /** The ancestor run whose verified artifacts made this path relevant. */
  sourceRun: number;
  /** Signed criterion ids this path is relevant to. */
  criteria: string[];
  why: ContextItemWhy[];
  /** Whether the blob is byte-identical at the source run's head. null
   * when ancestry could not be verified, so nothing is claimed. */
  unchangedSinceSource: boolean | null;
  redacted: boolean;
  /** Schema 2/3 only. Content is concatenated exact artifact ranges, NEVER
   * a complete file. Segments are ordered from oldest to newest. */
  patch?: { coverage: "partial"; segments: AncestorPatchSegment[] };
};

type AncestorPatchSegment = {
  run: number;
  base: string;
  head: string;
  artifact: number;
  sha256: string;
  offset: number;
  bytes: number;
};

export type ReviewContextIdentity = {
  path: string;
  commit: string;
  blob: string;
  mode: string;
  bytes: number;
  sourceRun: number;
  sourceBlob: string | null;
  sourceMode: string | null;
  unchangedSinceSource: boolean | null;
};

export type ReviewContextGap = {
  reason: ContextGapReason;
  path: string | null;
  criteria: string[];
  detail: string;
};

export type PriorReviewSupport = {
  criterionId: string;
  sourceRun: number;
  reviewerRun: number;
  author: string;
  judgement: CriterionJudgementWord;
  note: string;
  statementMatches: boolean;
  ancestryVerified: boolean;
  relevantPaths: string[];
  relevantUnchanged: boolean;
  bindingsVerified: boolean;
  /** `eligible` = every proof above holds, so the reviewer may weigh it;
   * `invalid` = at least one failed, and the reasons say which. Neither
   * is a judgement on THIS run. */
  support: "eligible" | "invalid";
  reasons: string[];
};

export type CriterionContextCoverage = {
  id: string;
  /** `patch`: judged from this revision's own diff (a criterion new to this
   * rubric, or one whose relevant code the patch touches). `context`:
   * inherited, partly or wholly outside the patch, every relevant path sealed as an
   * item. `gap`: inherited and some relevant context is
   * missing — see `gaps`. */
  state: "patch" | "context" | "gap";
  /** Same id AND same statement as the source run's signed rubric. */
  inherited: boolean;
  paths: string[];
  items: string[];
  gaps: string[];
  priorSupport: "eligible" | "invalid" | "none";
  /** One line for the change's images and other binary files, which are
   * never read as text and so are neither items nor gaps. */
  assets?: string;
};

export type ReviewContextInventory = {
  schema: 1 | 2 | 3;
  /** Optional builder caveats, bound to the captured handoff, never evidence
   * that a criterion passed. Older inventories remain byte-compatible. */
  handoff?: { artifact: number; sha256: string; content: string };
  observations?: ObservationEvidence;
  /** Tree identity is independent of whether content fits capture bounds. */
  identities?: ReviewContextIdentity[];
  bindings?: { run: number; sha256: string; candidate?: true }[];
  run: number;
  head: string;
  base: string | null;
  source: {
    task: string;
    run: number;
    head: string | null;
    scopeDigest: string | null;
    /** The source run's sealed proof AND diff-stat both verified. */
    verified: boolean;
    problems: string[];
  };
  ancestry: { verified: boolean; detail: string };
  items: ReviewContextItem[];
  gaps: ReviewContextGap[];
  priorReview: PriorReviewSupport[];
  coverage: CriterionContextCoverage[];
  limits: { itemBytes: number; aggregateBytes: number; items: number };
};

const CONTEXT_INPUT_KINDS = new Set<Artifact["kind"]>(["terminal-diff", "diff-stat", "proof", "check-log", "screenshot", "review-context"]);

/** A shortened check log is the exact bounded log the reviewer saw.
 * Completeness of patches, proofs and other structured inputs is still
 * required. Failed capture is never evidence, even if its bytes hash. */
function usableReviewInput(root: string, artifact: Artifact): boolean {
  return artifact.captureStatus !== "failed" && (!artifact.truncated || artifact.kind === "check-log") && readVerifiedArtifact(root, artifact).ok;
}

/** A terminal reviewer can have one correction child. Follow its recorded
 * ancestry, never another task's judgement, with a fixed traversal bound. */
function historicalReviewerLineage(store: Store, reviewerId: number) {
  const rows = [];
  const seen = new Set<number>();
  let id: number | null = reviewerId;
  for (let depth = 0; id !== null && depth < 4 && !seen.has(id); depth++) {
    seen.add(id);
    const run = store.getRun(id);
    if (run === null) break;
    rows.push({ id: run.id, taskRef: run.taskRef, role: run.role, parentRun: run.parentRun, outcome: run.outcome });
    if (run.role !== "reviewer") break;
    id = run.parentRun;
  }
  return rows;
}

/** Fingerprint every input the ancestor review depended on, including
 * absent inputs and later additions. No transcript or checkout is copied. */
export function reviewContextBindingOf(store: Store, runId: number, candidate = false): { run: number; sha256: string; candidate?: true } {
  const run = store.getRun(runId);
  const taskId = run === null ? null : store.externalIdFor(run.taskRef);
  const scope = taskId === null ? null : store.getScope(taskId);
  const ref = taskId === null ? null : store.lookupRef(taskId);
  const state = {
    task: taskId, head: run?.headRevision ?? null, base: run?.baseRevision ?? null, scopeDigest: run?.scopeDigest ?? null,
    currentScope: scope?.digest ?? null, termsProblem: scope?.termsProblem ?? null,
    revisionOf: ref?.revisionOf ?? null, revisionBrief: ref?.revisionBriefArtifact ?? null,
    artifacts: store.artifactsFor(runId).filter(one => (CONTEXT_INPUT_KINDS.has(one.kind) && (!candidate || one.kind !== "review-context")) || isVerificationReceipt(one) || one.capture === OBSERVATION_CAPTURE),
    reviews: candidate ? [] : store.criterionReviewsFor(runId),
    reviewerLineages: candidate ? [] : [...new Set(store.criterionReviewsFor(runId).map(one => one.reviewerRun))].map(id => historicalReviewerLineage(store, id)),
  };
  return { run: runId, sha256: createHash("sha256").update(JSON.stringify(state)).digest("hex"), ...(candidate ? { candidate: true as const } : {}) };
}

/** Re-prove sealed context before spending and inside final ingestion. */
export function reviewContextCustodyProblem(store: Store, root: string, inventory: ReviewContextInventory): string | null {
  try {
    const current = readObservationEvidence(store, root, inventory.run);
    if (JSON.stringify(current) !== JSON.stringify(inventory.observations ?? null)) return "the focused observation inventory changed";
  } catch { return "the focused observations no longer verify"; }

  if (inventory.handoff !== undefined) {
    const found = store.artifactsFor(inventory.run).filter(one => one.kind === "handoff");
    const artifact = found[0];
    if (found.length !== 1 || artifact?.id !== inventory.handoff.artifact || artifact.sha256 !== inventory.handoff.sha256) return "the builder notes binding changed";
    const read = readVerifiedArtifact(root, artifact);
    if (!read.ok || read.content.toString("utf8") !== inventory.handoff.content) return "the captured builder notes no longer verify";
  }
  const run = store.getRun(inventory.run);
  const source = run === null ? null : store.revisionSourceOf(run.taskRef) ?? { sourceRun: run.id, sourceTask: store.externalIdFor(run.taskRef) };
  if (run === null || run.headRevision !== inventory.head || run.baseRevision !== inventory.base || source?.sourceRun !== inventory.source.run || source.sourceTask !== inventory.source.task) return "the review context's run, head, base or revision ancestry changed";
  if (!inventory.bindings?.length || inventory.bindings.length > REVIEW_CONTEXT_LIMITS.ancestors || !inventory.bindings.some(one => one.run === inventory.source.run)) return "the review context has no complete bounded source binding";
  for (const binding of inventory.bindings) {
    if (reviewContextBindingOf(store, binding.run, binding.candidate === true).sha256 !== binding.sha256) return `ancestor run #${binding.run}'s scope, ancestry, evidence inventory or review context changed`;
    for (const artifact of store.artifactsFor(binding.run).filter(one => CONTEXT_INPUT_KINDS.has(one.kind) || isVerificationReceipt(one))) {
      try { if (!readVerifiedArtifact(root, artifact).ok) return `ancestor run #${binding.run}'s ${artifact.kind} bytes no longer verify`; }
      catch { return `ancestor run #${binding.run}'s ${artifact.kind} cannot be read`; }
    }
  }
  for (const item of inventory.items) {
    let offset = 0;
    for (const segment of item.patch?.segments ?? []) {
      const source = store.getRun(segment.run);
      const artifact = store.getArtifact(segment.artifact);
      if (source?.baseRevision !== segment.base || source.headRevision !== segment.head || artifact?.run !== segment.run || artifact.kind !== "terminal-diff" || artifact.sha256 !== segment.sha256) return "an ancestor patch's source binding changed";
      try {
        const read = readVerifiedArtifact(root, artifact);
        const content = Buffer.from(item.content, "utf8");
        // Redaction elsewhere does not invalidate this exact clean section.
        // Reselect by path: matching arbitrary bytes alone could admit a
        // fragment that hides a redaction, or another file's section.
        const section = read.ok ? patchSection(read.content, item.path) : null;
        if (!usableReviewInput(root, artifact) || section === null || section.offset !== segment.offset || section.content.length !== segment.bytes || !section.content.equals(content.subarray(offset, offset + segment.bytes))) return "an ancestor patch's exact source bytes no longer verify";
      } catch { return "an ancestor patch cannot be read"; }
      offset += segment.bytes;
    }
  }
  return null;
}

const SHA1 = /^[0-9a-f]{40}$/;
const ITEM_ID = /^ctx-[1-9][0-9]{0,3}$/;

/** A candidate path the object reader will accept on argv: repository-
 * relative, no `..` or `.` segments, no leading dash, no control bytes. */
export function safeContextPath(path: string): boolean {
  if (path.length === 0 || path.length > 300 || path.startsWith("-") || path.startsWith("/") || path.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

export function serializeReviewContext(inventory: ReviewContextInventory): string {
  return JSON.stringify(inventory, null, 1);
}

/**
 * The strict reader every consumer uses (the reviewer pass, the surfaces,
 * the tests): shape, bounds, unique ids, and every item's SHA-256
 * recomputed from its content. What this refuses, nothing shows.
 */
export function parseReviewContext(raw: string): { ok: true; inventory: ReviewContextInventory } | { ok: false; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problem: "not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, problem: "not an object" };
  const r = parsed as Record<string, unknown>;
  const str = (value: unknown, max = 2000): value is string => typeof value === "string" && value.length <= max && !hasForbiddenControls(value);
  const strList = (value: unknown, max = 64): value is string[] => Array.isArray(value) && value.length <= max && value.every(one => str(one, 300));
  const optionalStr = (value: unknown, max = 2000): value is string | null => value === null || str(value, max);
  if (r["schema"] !== 1 && r["schema"] !== 2 && r["schema"] !== 3) return { ok: false, problem: "unsupported review context schema" };
  const contentLimits = r["schema"] === 3 ? REVIEW_CONTEXT_LIMITS : LEGACY_REVIEW_CONTEXT_LIMITS;
  if (r["schema"] === 1 && r["identities"] !== undefined) return { ok: false, problem: "identities require schema 2" };
  if (!Number.isSafeInteger(r["run"]) || Number(r["run"]) <= 0) return { ok: false, problem: "run must be a positive integer" };
  if (!str(r["head"], 40) || !SHA1.test(r["head"])) return { ok: false, problem: "head must be a 40-hex commit" };
  if (!optionalStr(r["base"], 40)) return { ok: false, problem: "base must be a string or null" };
  const bindings = r["bindings"];
  const handoff = r["handoff"] as ReviewContextInventory["handoff"];
  const observations = r["observations"] as ObservationEvidence | undefined;
  if (observations !== undefined && (!observations || !Number.isSafeInteger(observations.artifact) || observations.artifact <= 0 ||
      typeof observations.content !== "string" || Buffer.byteLength(observations.content) > 64 * 1024 ||
      typeof observations.sha256 !== "string" || createHash("sha256").update(observations.content).digest("hex") !== observations.sha256)) return { ok: false, problem: "focused observations are malformed or do not match their hash" };

  if (handoff !== undefined && (handoff === null || !Number.isSafeInteger(handoff.artifact) || handoff.artifact <= 0 ||
    typeof handoff.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(handoff.sha256) || typeof handoff.content !== "string" ||
    Buffer.byteLength(handoff.content) > 64 * 1024 || createHash("sha256").update(handoff.content).digest("hex") !== handoff.sha256)) return { ok: false, problem: "builder notes are malformed or do not match their hash" };
  if (bindings !== undefined && (!Array.isArray(bindings) || bindings.length > REVIEW_CONTEXT_LIMITS.ancestors || !bindings.every(one => one !== null && typeof one === "object" && Number.isSafeInteger(one.run) && one.run > 0 && typeof one.sha256 === "string" && /^[0-9a-f]{64}$/.test(one.sha256) && (one.candidate === undefined || one.candidate === true)) || new Set(bindings.map(one => one.run)).size !== bindings.length)) return { ok: false, problem: "source bindings are malformed" };
  const source = r["source"];
  if (source === null || typeof source !== "object" || Array.isArray(source)) return { ok: false, problem: "source must be an object" };
  const so = source as Record<string, unknown>;
  if (!str(so["task"], 200) || !Number.isSafeInteger(so["run"]) || !optionalStr(so["head"], 40) || !optionalStr(so["scopeDigest"], 200) || typeof so["verified"] !== "boolean" || !strList(so["problems"], 16)) {
    return { ok: false, problem: "source is malformed" };
  }
  const ancestry = r["ancestry"];
  if (ancestry === null || typeof ancestry !== "object" || Array.isArray(ancestry)) return { ok: false, problem: "ancestry must be an object" };
  const an = ancestry as Record<string, unknown>;
  if (typeof an["verified"] !== "boolean" || !str(an["detail"], 500)) return { ok: false, problem: "ancestry is malformed" };
  const limits = r["limits"];
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) return { ok: false, problem: "limits must be an object" };
  const li = limits as Record<string, unknown>;
  if (![li["itemBytes"], li["aggregateBytes"], li["items"]].every(one => Number.isSafeInteger(one) && Number(one) > 0)) return { ok: false, problem: "limits are malformed" };

  const identities: ReviewContextIdentity[] = [];
  if (r["schema"] !== 1) {
    if (!Array.isArray(r["identities"]) || r["identities"].length > REVIEW_CONTEXT_LIMITS.candidatePaths) return { ok: false, problem: "identities must be a bounded array" };
    for (const one of r["identities"]) {
      if (one === null || typeof one !== "object" || Array.isArray(one)) return { ok: false, problem: "identity must be an object" };
      const it = one as ReviewContextIdentity;
      if (!str(it.path, 300) || !safeContextPath(it.path) || identities.some(other => other.path === it.path) || it.commit !== r["head"] || !str(it.blob, 40) || !SHA1.test(it.blob) || !["100644", "100755"].includes(it.mode) || !Number.isSafeInteger(it.bytes) || it.bytes < 0 || !Number.isSafeInteger(it.sourceRun) || it.sourceRun !== so["run"] || (it.sourceBlob !== null && (!str(it.sourceBlob, 40) || !SHA1.test(it.sourceBlob))) || (it.sourceMode !== null && !["100644", "100755"].includes(it.sourceMode)) || (it.unchangedSinceSource !== null && typeof it.unchangedSinceSource !== "boolean")) return { ok: false, problem: "identity is malformed" };
      if ((it.sourceBlob === null) !== (it.sourceMode === null) || (it.unchangedSinceSource !== null && (!an["verified"] || it.unchangedSinceSource !== (it.blob === it.sourceBlob && it.mode === it.sourceMode)))) return { ok: false, problem: "identity claims unproved equality" };
      identities.push({ path: it.path, commit: it.commit, blob: it.blob, mode: it.mode, bytes: it.bytes, sourceRun: it.sourceRun, sourceBlob: it.sourceBlob, sourceMode: it.sourceMode, unchangedSinceSource: it.unchangedSinceSource });
    }
  }

  const items: ReviewContextItem[] = [];
  if (!Array.isArray(r["items"]) || r["items"].length > contentLimits.items) return { ok: false, problem: `items must be an array of at most ${contentLimits.items}` };
  const ids = new Set<string>();
  const paths = new Set<string>();
  let aggregate = 0;
  for (const [index, one] of (r["items"] as unknown[]).entries()) {
    if (one === null || typeof one !== "object" || Array.isArray(one)) return { ok: false, problem: `item ${index}: not an object` };
    const it = one as Record<string, unknown>;
    if (!str(it["id"], 12) || !ITEM_ID.test(it["id"]) || ids.has(it["id"])) return { ok: false, problem: `item ${index}: id must be a unique ctx-<n> token` };
    if (!str(it["path"], 300) || !safeContextPath(it["path"]) || paths.has(it["path"])) return { ok: false, problem: `item ${index}: path is not a safe repository path` };
    if (!str(it["commit"], 40) || !SHA1.test(it["commit"]) || it["commit"] !== r["head"]) return { ok: false, problem: `item ${index}: commit must be a 40-hex commit` };
    if (!str(it["blob"], 40) || !SHA1.test(it["blob"])) return { ok: false, problem: `item ${index}: blob must be a 40-hex object id` };
    if (typeof it["content"] !== "string" || it["content"].includes("\u0000")) return { ok: false, problem: `item ${index}: content must be a NUL-free string` };
    const bytes = Buffer.byteLength(it["content"], "utf8");
    if (bytes > contentLimits.itemBytes || it["bytes"] !== bytes) return { ok: false, problem: `item ${index}: bytes must equal the content's UTF-8 length and fit the item limit` };
    aggregate += bytes;
    if (aggregate > contentLimits.aggregateBytes) return { ok: false, problem: "items exceed the aggregate content limit" };
    const sha256 = createHash("sha256").update(it["content"], "utf8").digest("hex");
    if (it["sha256"] !== sha256) return { ok: false, problem: `item ${index}: sha256 does not match its content` };
    if (!Number.isSafeInteger(it["sourceRun"]) || Number(it["sourceRun"]) <= 0) return { ok: false, problem: `item ${index}: sourceRun must be a positive integer` };
    if (!strList(it["criteria"], 12)) return { ok: false, problem: `item ${index}: criteria must be a list of ids` };
    if (!Array.isArray(it["why"]) || it["why"].length === 0 || it["why"].length > 2 || !it["why"].every(w => w === "source-criterion-evidence" || w === "source-changed-path" || w === "candidate-changed-path")) {
      return { ok: false, problem: `item ${index}: why must name how the path became relevant` };
    }
    if (it["unchangedSinceSource"] !== null && typeof it["unchangedSinceSource"] !== "boolean") return { ok: false, problem: `item ${index}: unchangedSinceSource must be boolean or null` };
    if (typeof it["redacted"] !== "boolean") return { ok: false, problem: `item ${index}: redacted must be boolean` };
    let patch: ReviewContextItem["patch"];
    if (it["patch"] !== undefined) {
      const p = it["patch"] as ReviewContextItem["patch"];
      if (r["schema"] === 1 || p === null || typeof p !== "object" || p.coverage !== "partial" || !Array.isArray(p.segments) || p.segments.length === 0 || p.segments.length > REVIEW_CONTEXT_LIMITS.ancestors + 1 || it["redacted"] !== false) return { ok: false, problem: `item ${index}: unsupported partial patch` };
      let total = 0;
      const runs = new Set<number>();
      const lineage = [...((bindings ?? []) as { run: number }[]).map(one => one.run), Number(r["run"])];
      let lastPosition = -1;
      for (const s of p.segments) {
        if (s === null || typeof s !== "object" || !Number.isSafeInteger(s.run) || s.run <= 0 || runs.has(s.run) || (s.run !== r["run"] && !(bindings as { run: number }[] | undefined)?.some(one => one.run === s.run)) || !str(s.base, 40) || !SHA1.test(s.base) || !str(s.head, 40) || !SHA1.test(s.head) || !Number.isSafeInteger(s.artifact) || s.artifact <= 0 || !str(s.sha256, 64) || !/^[0-9a-f]{64}$/.test(s.sha256) || !Number.isSafeInteger(s.offset) || s.offset < 0 || !Number.isSafeInteger(s.bytes) || s.bytes <= 0 || s.offset + s.bytes > EVIDENCE_CAPS["terminal-diff"]) return { ok: false, problem: `item ${index}: malformed patch segment` };
        total += s.bytes;
        const position = lineage.indexOf(s.run);
        if (position <= lastPosition) return { ok: false, problem: `item ${index}: patch segments are out of ancestry order` };
        lastPosition = position;
        runs.add(s.run);
      }
      if (total !== bytes) return { ok: false, problem: `item ${index}: patch ranges do not cover its content` };
      patch = { coverage: "partial", segments: p.segments.map(s => ({ run: s.run, base: s.base, head: s.head, artifact: s.artifact, sha256: s.sha256, offset: s.offset, bytes: s.bytes })) };
    } else if (it["redacted"] === false && createHash("sha1").update(`blob ${bytes}\0`).update(it["content"], "utf8").digest("hex") !== it["blob"]) return { ok: false, problem: `item ${index}: git blob identity does not match its content` };
    if (r["schema"] !== 1 && !identities.some(one => one.path === it["path"] && one.blob === it["blob"] && one.sourceRun === it["sourceRun"] && one.unchangedSinceSource === it["unchangedSinceSource"])) return { ok: false, problem: `item ${index}: no matching tree identity` };
    paths.add(it["path"]);
    ids.add(it["id"]);
    items.push({
      id: it["id"],
      path: it["path"],
      commit: it["commit"],
      blob: it["blob"],
      sha256,
      bytes,
      content: it["content"],
      sourceRun: Number(it["sourceRun"]),
      criteria: [...(it["criteria"] as string[])],
      why: [...(it["why"] as ContextItemWhy[])],
      unchangedSinceSource: it["unchangedSinceSource"] as boolean | null,
      redacted: it["redacted"],
      ...(patch === undefined ? {} : { patch }),
    });
  }

  const gaps: ReviewContextGap[] = [];
  if (!Array.isArray(r["gaps"]) || r["gaps"].length > 400) return { ok: false, problem: "gaps must be a bounded array" };
  const GAP_REASONS = new Set<string>([
    "source-missing", "source-unverified", "source-proof-missing", "source-scope-changed", "criterion-changed", "stale-ancestry",
    "missing-at-head", "not-a-file", "binary", "over-limit", "aggregate-limit", "item-cap", "secret-redacted", "capture-failed",
  ]);
  for (const [index, one] of (r["gaps"] as unknown[]).entries()) {
    if (one === null || typeof one !== "object" || Array.isArray(one)) return { ok: false, problem: `gap ${index}: not an object` };
    const g = one as Record<string, unknown>;
    if (!str(g["reason"], 40) || !GAP_REASONS.has(g["reason"]) || !optionalStr(g["path"], 300) || !strList(g["criteria"], 12) || !str(g["detail"], 500)) {
      return { ok: false, problem: `gap ${index}: malformed` };
    }
    gaps.push({ reason: g["reason"] as ContextGapReason, path: g["path"], criteria: [...(g["criteria"] as string[])], detail: g["detail"] });
  }

  const priorReview: PriorReviewSupport[] = [];
  if (!Array.isArray(r["priorReview"]) || r["priorReview"].length > REVIEW_CONTEXT_LIMITS.priorReviews) return { ok: false, problem: "priorReview must be a bounded array" };
  for (const [index, one] of (r["priorReview"] as unknown[]).entries()) {
    if (one === null || typeof one !== "object" || Array.isArray(one)) return { ok: false, problem: `priorReview ${index}: not an object` };
    const p = one as Record<string, unknown>;
    if (
      !str(p["criterionId"], 64) || !Number.isSafeInteger(p["sourceRun"]) || !Number.isSafeInteger(p["reviewerRun"]) || !str(p["author"], 200) ||
      (p["judgement"] !== "upholds" && p["judgement"] !== "contradicts" && p["judgement"] !== "cannot-tell") || !str(p["note"], 500) ||
      typeof p["statementMatches"] !== "boolean" || typeof p["ancestryVerified"] !== "boolean" || !strList(p["relevantPaths"], 200) ||
      typeof p["relevantUnchanged"] !== "boolean" || typeof p["bindingsVerified"] !== "boolean" ||
      (p["support"] !== "eligible" && p["support"] !== "invalid") || !strList(p["reasons"], 16)
    ) {
      return { ok: false, problem: `priorReview ${index}: malformed` };
    }
    if (p["support"] === "eligible" && !(p["statementMatches"] && p["ancestryVerified"] && p["relevantUnchanged"] && p["bindingsVerified"])) {
      return { ok: false, problem: `priorReview ${index}: claims eligibility without every proof` };
    }
    if (r["schema"] !== 1 && p["relevantUnchanged"] && ((p["relevantPaths"] as string[]).length === 0 || !(p["relevantPaths"] as string[]).every(path => identities.some(one => one.path === path && one.unchangedSinceSource === true)))) return { ok: false, problem: `priorReview ${index}: unchanged paths lack tree identity` };
    priorReview.push({
      criterionId: p["criterionId"], sourceRun: Number(p["sourceRun"]), reviewerRun: Number(p["reviewerRun"]), author: p["author"],
      judgement: p["judgement"] as CriterionJudgementWord, note: p["note"], statementMatches: p["statementMatches"], ancestryVerified: p["ancestryVerified"],
      relevantPaths: [...(p["relevantPaths"] as string[])], relevantUnchanged: p["relevantUnchanged"], bindingsVerified: p["bindingsVerified"],
      support: p["support"] as "eligible" | "invalid", reasons: [...(p["reasons"] as string[])],
    });
  }

  const coverage: CriterionContextCoverage[] = [];
  if (!Array.isArray(r["coverage"]) || r["coverage"].length > 12) return { ok: false, problem: "coverage must be a bounded array" };
  const coverageIds = new Set<string>();
  for (const [index, one] of (r["coverage"] as unknown[]).entries()) {
    if (one === null || typeof one !== "object" || Array.isArray(one)) return { ok: false, problem: `coverage ${index}: not an object` };
    const c = one as Record<string, unknown>;
    if (
      !str(c["id"], 64) || coverageIds.has(c["id"]) || (c["state"] !== "patch" && c["state"] !== "context" && c["state"] !== "gap") ||
      typeof c["inherited"] !== "boolean" || !strList(c["paths"], 200) || !strList(c["items"], r["schema"] === 3 ? contentLimits.items : 64) || !strList(c["gaps"], r["schema"] === 3 ? 400 : 64) ||
      (c["priorSupport"] !== "eligible" && c["priorSupport"] !== "invalid" && c["priorSupport"] !== "none") ||
      (c["assets"] !== undefined && !str(c["assets"], 300))
    ) {
      return { ok: false, problem: `coverage ${index}: malformed` };
    }
    if ((c["items"] as string[]).some(id => !ids.has(id) || !items.find(item => item.id === id)?.criteria.includes(String(c["id"])))) return { ok: false, problem: `coverage ${index}: names an item that is not in the inventory` };
    if (items.some(item => (item.patch !== undefined || item.redacted) && (c["items"] as string[]).includes(item.id)) && (c["state"] !== "gap" || (c["gaps"] as string[]).length === 0)) return { ok: false, problem: `coverage ${index}: partial patches require an explicit gap; redacted items do too` };
    coverageIds.add(c["id"]);
    coverage.push({
      id: c["id"], state: c["state"] as CriterionContextCoverage["state"], inherited: c["inherited"], paths: [...(c["paths"] as string[])],
      items: [...(c["items"] as string[])], gaps: [...(c["gaps"] as string[])], priorSupport: c["priorSupport"] as CriterionContextCoverage["priorSupport"],
      ...(c["assets"] === undefined ? {} : { assets: c["assets"] as string }),
    });
  }

  return {
    ok: true,
    inventory: {
      schema: r["schema"],
      ...(handoff === undefined ? {} : { handoff }),
      ...(observations === undefined ? {} : { observations }),
      ...(r["schema"] !== 1 ? { identities } : {}),
      ...(bindings === undefined ? {} : { bindings: bindings as { run: number; sha256: string }[] }),
      run: Number(r["run"]),
      head: r["head"],
      base: r["base"],
      source: { task: so["task"], run: Number(so["run"]), head: so["head"], scopeDigest: so["scopeDigest"], verified: so["verified"], problems: [...(so["problems"] as string[])] },
      ancestry: { verified: an["verified"], detail: an["detail"] },
      items,
      gaps,
      priorReview,
      coverage,
      limits: { itemBytes: Number(li["itemBytes"]), aggregateBytes: Number(li["aggregateBytes"]), items: Number(li["items"]) },
    },
  };
}

/** What the reviewer's parser needs from an inventory: the provenance
 * tokens a note may cite, and the criteria whose judgement must cite one —
 * every criterion NOT judged from the patch alone. */
export function reviewContextRules(inventory: ReviewContextInventory): { itemIds: ReadonlySet<string>; provenanceRequired: ReadonlySet<string> } {
  return {
    itemIds: new Set(inventory.items.map(one => one.id)),
    provenanceRequired: new Set(inventory.coverage.filter(one => one.state !== "patch").map(one => one.id)),
  };
}

/** Whether a reviewer's note cites supplied provenance: a `ctx-<n>` item
 * id from the inventory, a path the patch names, or a sealed file name. */
export function citesSuppliedProvenance(
  note: string,
  supplied: { itemIds: ReadonlySet<string>; patchPaths: ReadonlySet<string>; sealedFiles: ReadonlySet<string> },
): boolean {
  for (const token of note.match(/ctx-[0-9]{1,4}/g) ?? []) if (supplied.itemIds.has(token)) return true;
  for (const path of supplied.patchPaths) if (path.length > 0 && note.includes(path)) return true;
  for (const file of supplied.sealedFiles) if (note.includes(file)) return true;
  return false;
}

type GitRunner = (file: string, args: readonly string[], options?: { cwd?: string; maxBuffer?: number }) => Promise<ExecResult>;

const GIT_READ = ["--literal-pathspecs", "--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks"] as const;

/** One `ls-tree -l` entry: mode, type, object id, size (null for gitlinks). */
type TreeEntry = { mode: string; type: string; object: string; size: number | null };

async function treeEntries(git: GitRunner, cwd: string, revision: string, paths: readonly string[]): Promise<Map<string, TreeEntry> | null> {
  if (paths.length === 0) return new Map();
  const listed = await git("git", [...GIT_READ, "ls-tree", "-z", "-l", revision, "--", ...paths], { cwd, maxBuffer: 4 * 1024 * 1024 });
  if (listed.code !== 0) return null;
  const entries = new Map<string, TreeEntry>();
  for (const record of listed.stdout.split("\u0000")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object, sizeText] = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    if (mode === undefined || type === undefined || object === undefined || sizeText === undefined) continue;
    entries.set(path, { mode, type, object, size: sizeText === "-" ? null : Number(sizeText) });
  }
  return entries;
}

/** "12 images, 3.4 MB, in the run's evidence": every binary file at the head
 * in one line. Files deleted by the change are not counted. */
async function assetSummary(git: GitRunner, cwd: string, head: string, assets: ReadonlySet<string>): Promise<string | null> {
  const sizes = new Map<string, number>();
  const paths = [...assets].filter(safeContextPath);
  for (let at = 0; at < paths.length; at += 500) {
    const listed = await treeEntries(git, cwd, head, paths.slice(at, at + 500));
    for (const [path, entry] of listed ?? []) if (regular(entry)) sizes.set(path, entry.size);
  }
  if (sizes.size === 0) return null;
  const images = [...sizes.keys()].filter(isImagePath).length;
  const others = sizes.size - images;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const counted = [...(images > 0 ? [plural(images, "image")] : []), ...(others > 0 ? [plural(others, images > 0 ? "other binary file" : "binary file")] : [])].join(", ");
  return `${counted}, ${assetBytesWords([...sizes.values()].reduce((sum, one) => sum + one, 0))}, in the run's evidence`;
}

function assetBytesWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function regular(entry: TreeEntry | undefined): entry is TreeEntry & { size: number } {
  return entry !== undefined && entry.type === "blob" && ["100644", "100755"].includes(entry.mode) && SHA1.test(entry.object) && Number.isSafeInteger(entry.size) && entry.size! >= 0;
}

function sameEntry(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  return a === undefined && b === undefined || regular(a) && regular(b) && a.object === b.object && a.mode === b.mode;
}

/** The native redactor replaces an entire diff line. Quoted marker text
 * in code is not a redaction: unchanged/added/deleted lines have a prefix. */
function hasRedactedLine(text: string): boolean {
  return /^\[redacted: [^\r\n]+ detected on this line\]\r?$/m.test(text);
}

/** Select a whole plain, same-path text diff section. Quoted paths,
 * renames, binary patches and redactions WITHIN it are unsupported.
 * Other sections may be redacted; their hidden bytes are never inferred.
 * Offsets refer to the original verified bytes, not regenerated output. */
function patchSection(content: Buffer, path: string): { offset: number; content: Buffer } | null {
  if (!/^[A-Za-z0-9_./-]+$/.test(path)) return null;
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content) || text.includes("\0")) return null;
  const header = `diff --git a/${path} b/${path}\n`;
  const sections = [...text.matchAll(/^diff --git .*\n/gm)];
  const matches = sections.filter(one => one[0] === header);
  if (matches.length !== 1) return null;
  const start = matches[0]!.index;
  const end = sections.find(one => one.index > start)?.index ?? text.length;
  const section = text.slice(start, end);
  if (/^(?:Binary files |GIT binary patch|rename |copy |similarity index )/m.test(section) || scanForSecrets(section).length > 0 || hasRedactedLine(section)) return null;
  const offset = Buffer.byteLength(text.slice(0, start), "utf8");
  return { offset, content: content.subarray(offset, offset + Buffer.byteLength(section, "utf8")) };
}

/** Account for EVERY sealed interval through this revision. If a run's
 * base omits an intervening change to this path, refuse the entire chain.
 * Equal blobs/modes bridge intervals without needing full-file capture. */
async function ancestorPatch(
  store: Store, git: GitRunner, args: CaptureReviewContextArgs, inventory: ReviewContextInventory, path: string,
): Promise<{ ok: true; content: string; segments: AncestorPatchSegment[] } | { ok: false; reason: ContextGapReason; detail: string }> {
  const fail = (detail: string, reason: ContextGapReason = "source-unverified") => ({ ok: false as const, reason, detail });
  if (!inventory.source.verified || !inventory.ancestry.verified || inventory.gaps.some(one => one.path === null && one.reason !== "criterion-changed")) return fail("verified source ancestry is unavailable for a partial patch");
  const runs = [...(inventory.bindings ?? []).map(one => one.run), args.runId];
  const segments: AncestorPatchSegment[] = [];
  const contents: Buffer[] = [];
  let previous: TreeEntry | undefined;
  let previousHead: string | null = null;
  let total = 0;
  for (const runId of runs) {
    const run = store.getRun(runId);
    const base = runId === args.runId ? args.base : run?.baseRevision;
    const head = runId === args.runId ? args.head : run?.headRevision;
    if (!base || !head || !SHA1.test(base) || !SHA1.test(head)) return fail(`run #${runId} has no exact patch endpoints`);
    for (const from of new Set([base, previousHead ?? base])) {
      const ancestor = await git("git", [...GIT_READ, "merge-base", "--is-ancestor", from, head], { cwd: args.worktree });
      if (ancestor.code !== 0) return fail(`run #${runId}'s patch ancestry could not be verified`);
    }
    const before = await treeEntries(git, args.worktree, base, [path]);
    const after = await treeEntries(git, args.worktree, head, [path]);
    if (before === null || after === null) return fail(`run #${runId}'s patch trees could not be read`, "capture-failed");
    const a = before.get(path);
    const b = after.get(path);
    if ((a !== undefined && !regular(a)) || (b !== undefined && !regular(b))) return fail(`run #${runId}'s patch crosses a non-file`, "not-a-file");
    if (previousHead !== null && !sameEntry(previous, a)) return fail(`uncovered changes between ${previousHead} and run #${runId}'s base; no ancestor patch supplied`);
    previous = b;
    previousHead = head;
    if (sameEntry(a, b)) continue;
    const artifacts = store.artifactsFor(runId).filter(one => one.kind === "terminal-diff");
    const artifact = artifacts[0];
    if (artifacts.length !== 1 || artifact === undefined) return fail(`run #${runId}'s terminal patch is missing or ambiguous`);
    if (artifact.truncated) return fail(`run #${runId}'s terminal patch exceeds its capture budget`, "over-limit");
    if (artifact.captureStatus === "failed") return fail(`run #${runId}'s terminal patch capture failed`, "capture-failed");
    let read: ReturnType<typeof readVerifiedArtifact>;
    try { read = readVerifiedArtifact(args.root, artifact); } catch { return fail(`run #${runId}'s terminal patch cannot be read`, "capture-failed"); }
    if (!read.ok) return fail(`run #${runId}'s terminal patch bytes do not verify`);
    const section = patchSection(read.content, path);
    if (section === null) {
      const text = read.content.toString("utf8");
      if (scanForSecrets(text).length > 0 || hasRedactedLine(text)) return fail(`run #${runId}'s terminal patch contains secret-shaped or redacted lines`, "secret-redacted");
      const binary = text.includes(`Binary files a/${path} and b/${path} differ`) || text.includes(`Binary files /dev/null and b/${path} differ`);
      return fail(`run #${runId}'s path patch is ${binary ? "binary" : "missing or an unsupported shape"}`, binary ? "binary" : "source-unverified");
    }
    // Git's index header binds the section to both exact tree blobs.
    const index = /^index ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})(?: [0-7]{6})?$/m.exec(section.content.toString("utf8"));
    if (index === null || !(a?.object ?? "0".repeat(40)).startsWith(index[1]!) || !(b?.object ?? "0".repeat(40)).startsWith(index[2]!)) return fail(`run #${runId}'s path patch does not bind both tree blobs`);
    total += section.content.length;
    if (total > LEGACY_REVIEW_CONTEXT_LIMITS.itemBytes) return fail("the ancestor patch chain exceeds the item budget; no segments were omitted", "over-limit");
    segments.push({ run: runId, base, head, artifact: artifact.id, sha256: artifact.sha256, offset: section.offset, bytes: section.content.length });
    contents.push(section.content);
  }
  if (segments.length === 0) return fail("no changed source section is available for this path");
  return { ok: true, content: Buffer.concat(contents).toString("utf8"), segments };
}

export type CaptureReviewContextArgs = {
  runId: number;
  taskRef: number;
  /** This run's sealed head — the exact commit every item is read at. */
  head: string;
  base: string | null;
  /** The signed rubric this run built against, in id order. */
  rubric: readonly ApprovedCriterion[];
  /** Paths this run's own sealed diff-stat names (empty when unknown). */
  patchPaths: ReadonlySet<string>;
  worktree: string;
  root: string;
  now: () => Date;
};

/**
 * Capture complete criterion-relevant files for every rubric-bearing build.
 * Ordinary builds bind their own candidate; revisions also bind their ancestry.
 * Every capture stores a parseable inventory; problems become gaps in it, never a
 * missing or truncated file.
 */
export async function captureReviewContext(
  store: Store,
  git: GitRunner,
  args: CaptureReviewContextArgs,
): Promise<{ inventory: ReviewContextInventory; artifactId: number } | null> {
  const lineage = store.revisionSourceOf(args.taskRef) ?? { sourceRun: args.runId, sourceTask: store.externalIdFor(args.taskRef)! };
  const inventory = await deriveReviewContext(store, git, args, lineage);
  let encoded = serializeReviewContext(inventory);
  if (Buffer.byteLength(encoded, "utf8") > EVIDENCE_CAPS["review-context"]) {
    // Unreachable under the content limits, but a structured artifact is
    // never byte-truncated: shed every item and say so.
    const stripped: ReviewContextInventory = {
      ...inventory,
      items: [],
      gaps: [...inventory.gaps, { reason: "over-limit", path: null, criteria: inventory.coverage.map(one => one.id), detail: "the encoded inventory exceeded its evidence cap — every item was shed" }],
      coverage: inventory.coverage.map(one => ({ ...one, state: one.state === "patch" ? "patch" : "gap", items: [], gaps: [...one.gaps, "the encoded inventory exceeded its evidence cap"] })),
      priorReview: inventory.priorReview.map(one => ({ ...one, support: "invalid", relevantUnchanged: false, reasons: [...one.reasons, "the inventory was shed"] })),
    };
    encoded = serializeReviewContext(stripped);
    const artifactId = storeEvidence(store, args.root, args.runId, "review-context", "review-context.json", Buffer.from(encoded, "utf8"), `machine-captured review context at ${args.head} (shed, exit 0)`, args.now(), { captureStatus: "ok" });
    return { inventory: stripped, artifactId };
  }
  const artifactId = storeEvidence(store, args.root, args.runId, "review-context", "review-context.json", Buffer.from(encoded, "utf8"), `machine-captured review context at ${args.head} (exit 0)`, args.now(), {
    captureStatus: "ok",
    redacted: inventory.items.some(one => one.redacted),
  });
  return { inventory, artifactId };
}

/**
 * The derivation, separated from storage so a test can hold the inventory
 * against a real repository without an evidence root.
 */
export async function deriveReviewContext(
  store: Store,
  git: GitRunner,
  args: CaptureReviewContextArgs,
  lineage: { sourceTask: string; sourceRun: number },
): Promise<ReviewContextInventory> {
  const gaps: ReviewContextGap[] = [];
  const allIds = args.rubric.map(one => one.id);
  const sourceRun = store.getRun(lineage.sourceRun);
  const sourceProblems: string[] = [];
  const inventory: ReviewContextInventory = {
    schema: 3,
    identities: [],
    bindings: [reviewContextBindingOf(store, lineage.sourceRun, lineage.sourceRun === args.runId)],
    run: args.runId,
    head: args.head,
    base: args.base,
    source: { task: lineage.sourceTask, run: lineage.sourceRun, head: sourceRun?.headRevision ?? null, scopeDigest: sourceRun?.scopeDigest ?? null, verified: false, problems: sourceProblems },
    ancestry: { verified: false, detail: "not checked" },
    items: [],
    gaps,
    priorReview: [],
    coverage: [],
    limits: { itemBytes: REVIEW_CONTEXT_LIMITS.itemBytes, aggregateBytes: REVIEW_CONTEXT_LIMITS.aggregateBytes, items: REVIEW_CONTEXT_LIMITS.items },
  };
  const finish = (coverage: CriterionContextCoverage[]): ReviewContextInventory => ({ ...inventory, coverage });
  const gapAll = (reason: ContextGapReason, detail: string): void => {
    gaps.push({ reason, path: null, criteria: allIds, detail });
  };
  try { const observations = readObservationEvidence(store, args.root, args.runId); if (observations) inventory.observations = observations; }
  catch { gapAll("capture-failed", "the focused observations could not be verified"); }
  const handoffs = store.artifactsFor(args.runId).filter(one => one.kind === "handoff");
  if (handoffs.length === 1) {
    const artifact = handoffs[0]!;
    const read = readVerifiedArtifact(args.root, artifact);
    if (read.ok && !artifact.truncated && artifact.captureStatus !== "failed") inventory.handoff = { artifact: artifact.id, sha256: artifact.sha256, content: read.content.toString("utf8") };
    else gapAll("capture-failed", "the captured builder notes could not be verified");
  } else if (handoffs.length > 1) gapAll("source-unverified", "multiple builder notes make the handoff ambiguous");
  const patchOnly = (id: string, inherited: boolean, extra: string[] = []): CriterionContextCoverage => ({
    id, state: "patch", inherited, paths: [], items: [], gaps: extra, priorSupport: "none",
  });

  // 1. The source run and its VERIFIED artifacts.
  if (sourceRun === null) {
    gapAll("source-missing", `source run #${lineage.sourceRun} does not exist — no inherited context can be supplied`);
    return finish(allIds.map(id => ({ ...patchOnly(id, false), state: "gap", gaps: [`source run #${lineage.sourceRun} does not exist`] })));
  }
  const sourceHead = sourceRun.headRevision !== null && SHA1.test(sourceRun.headRevision) ? sourceRun.headRevision : null;
  if (sourceHead === null) sourceProblems.push("the source run has no sealed 40-hex head");
  const sourceArtifacts = store.artifactsFor(sourceRun.id);
  const verifiedOne = (kind: Artifact["kind"], label: string): Buffer | null => {
    const found = sourceArtifacts.filter(one => one.kind === kind);
    if (found.length !== 1) {
      sourceProblems.push(found.length === 0 ? `the source run has no sealed ${label}` : `the source run carries ${found.length} ${label} artifacts — ambiguous`);
      return null;
    }
    const artifact = found[0]!;
    if (artifact.captureStatus === "failed" || artifact.truncated) {
      sourceProblems.push(`the source run's ${label} is ${artifact.truncated ? "truncated" : "a failed capture"}`);
      return null;
    }
    let verified: ReturnType<typeof readVerifiedArtifact>;
    try {
      verified = readVerifiedArtifact(args.root, artifact);
    } catch {
      verified = { ok: false, problem: "the file could not be read" };
    }
    if (!verified.ok) {
      sourceProblems.push(`the source run's ${label} no longer verifies (${verified.problem})`);
      return null;
    }
    return verified.content;
  };
  const hasProof = sourceArtifacts.some(one => one.kind === "proof");
  const proofBytes = hasProof ? verifiedOne("proof", "proof") : null;
  let sourceProof: ParsedProof | null = null;
  if (proofBytes !== null) {
    const parsed = parseProof(proofBytes.toString("utf8"));
    if (parsed.ok) sourceProof = parsed.proof;
    else sourceProblems.push("the source run's proof is not a proof this build can read");
  }
  const statBytes = verifiedOne("diff-stat", "diff-stat");
  let sourceDiffPaths: string[] | null = null;
  if (statBytes !== null) {
    try {
      const stat = JSON.parse(statBytes.toString("utf8")) as { schema?: unknown; base?: unknown; head?: unknown; fileCount?: unknown; filesTruncated?: unknown; files?: { path?: unknown }[] } | null;
      if (stat?.filesTruncated === true) sourceProblems.push("the source run's diff-stat file list is truncated");
      else if (stat?.schema !== 1 || stat.base !== sourceRun.baseRevision || stat.head !== sourceHead || stat.filesTruncated !== false || !Array.isArray(stat.files) || stat.files.length > 400 || stat.fileCount !== stat.files.length || !stat.files.every(one => one !== null && typeof one.path === "string" && safeContextPath(one.path)) || new Set(stat.files.map(one => one.path)).size !== stat.files.length) sourceProblems.push("the source run's diff-stat shape, endpoints or path inventory is unsupported");
      else sourceDiffPaths = stat.files.map(one => one.path as string);
    } catch {
      sourceProblems.push("the source run's diff-stat is not JSON");
    }
  }
  const sourceDiffOk = verifiedOne("terminal-diff", "terminal diff") !== null;
  inventory.source.verified = sourceProblems.length === 0 && sourceDiffPaths !== null && sourceDiffOk && sourceHead !== null;

  // 2. The source rubric: only the exact scope the source run built under
  // (its digest still live on the source task) can say what a criterion
  // meant then. A moved scope is a gap for every criterion.
  const sourceTaskId = store.externalIdFor(sourceRun.taskRef);
  const sourceScope = sourceTaskId === null ? null : store.getScope(sourceTaskId);
  const sourceScopeVerified = sourceRun.scopeDigest !== null && sourceScope !== null && sourceScope.digest === sourceRun.scopeDigest;
  if (!sourceScopeVerified) {
    gapAll("source-scope-changed", sourceRun.scopeDigest === null ? "the source run built under no signed scope — no criterion can be matched to it" : "the source task's scope no longer carries the digest the source run built under — its criteria cannot be matched");
  }
  const sourceCriteria = new Map((sourceScopeVerified ? sourceScope!.acceptance : []).map(one => [one.id, one] as const));

  // 3. Ancestry: is the source head an ancestor of this head?
  if (sourceHead !== null) {
    const check = await git("git", [...GIT_READ, "merge-base", "--is-ancestor", sourceHead, args.head], { cwd: args.worktree });
    if (check.code === 0) inventory.ancestry = { verified: true, detail: `${sourceHead} is an ancestor of ${args.head}` };
    else if (check.code === 1) {
      inventory.ancestry = { verified: false, detail: `${sourceHead} is not an ancestor of ${args.head} — the source work is not in this history` };
      gapAll("stale-ancestry", inventory.ancestry.detail);
    } else {
      inventory.ancestry = { verified: false, detail: `ancestry could not be checked (git exit ${check.code})` };
      gapAll("capture-failed", inventory.ancestry.detail);
    }
  } else {
    inventory.ancestry = { verified: false, detail: "the source run has no sealed head to check ancestry against" };
    gapAll("source-unverified", inventory.ancestry.detail);
  }
  if (hasProof && sourceProof === null) gapAll("source-proof-missing", sourceProblems.find(one => one.includes("proof")) ?? "the source run's proof is unavailable");
  else if (!inventory.source.verified) gapAll("source-unverified", sourceProblems.join("; "));

  // 4. Relevance: which paths matter to which criterion, from the source
  // proof only — criterion-cited changed paths first, then every changed
  // path of the source build for criteria that cited none.
  // A revision of a revision keeps the parent's verified path inventory.
  // Capture those paths anew at THIS head; prior bytes are never substituted.
  let parentContext: ReviewContextInventory | null = null;
  if (sourceArtifacts.some(one => one.kind === "review-context")) {
    const bytes = verifiedOne("review-context", "review context");
    const parsed = bytes === null ? null : parseReviewContext(bytes.toString("utf8"));
    if (parsed?.ok) {
      const problem = reviewContextCustodyProblem(store, args.root, parsed.inventory);
      const combined = new Map([...(parsed.inventory.bindings ?? []), ...inventory.bindings!].map(one => [one.run, one]));
      if (problem === null && combined.size <= REVIEW_CONTEXT_LIMITS.ancestors) {
        parentContext = parsed.inventory;
        inventory.bindings = [...combined.values()];
      } else gapAll("source-unverified", problem ?? "the inherited context exceeds the ancestor bound");
    } else gapAll("source-unverified", "the source revision's inherited context cannot be verified");
  } else if (store.revisionSourceOf(sourceRun.taskRef) !== null) {
    gapAll("source-unverified", "the source revision has no inherited context inventory");
  }
  const generalPaths = [...new Set([...(sourceProof?.changed ?? []), ...(sourceDiffPaths ?? []), ...(parentContext?.coverage.flatMap(one => one.paths) ?? [])])].filter(safeContextPath).sort();
  // A first no-change result has no patch to select files from. Only the
  // signed scope may widen its context; read exact committed paths/directories,
  // under the same existing size/item bounds. Unsupported patterns stay gaps.
  if (generalPaths.length === 0 && sourceScopeVerified) {
    const paths = sourceScope!.touches.filter(path => safeContextPath(path.replace(/\/$/, "")) && !/[?*\[\]]/.test(path));
    if (paths.length > 0) {
      const listed = await git("git", [...GIT_READ, "ls-tree", "-r", "-z", "--name-only", args.head, "--", ...paths], { cwd: args.worktree, maxBuffer: 4 * 1024 * 1024 });
      if (listed.code === 0) generalPaths.push(...[...new Set(listed.stdout.split("\0").filter(safeContextPath))].sort());
      else gapAll("capture-failed", "the committed source paths in the approved scope could not be listed");
    }
  }
  // Files named as images or other binaries are never text context: they are
  // counted in one summary line, never listed as gaps or held against the
  // bounds. A text-named file that turns out not to be text stays a gap.
  const assets = new Set<string>();
  const textOnly = (paths: readonly string[]): string[] => paths.filter(path => {
    if (!isBinaryAssetPath(path)) return true;
    assets.add(path);
    return false;
  });
  generalPaths.splice(0, generalPaths.length, ...textOnly(generalPaths));
  const specificFor = new Map<string, string[]>();
  for (const criterion of sourceProof?.criteria ?? []) {
    const cited = [...new Set(criterion.evidence.filter(one => one.kind === "changed-path").map(one => one.ref))].filter(safeContextPath).sort();
    const inherited = parentContext?.coverage.find(one => one.id === criterion.id)?.paths ?? [];
    const combined = textOnly([...new Set([...cited, ...inherited])].filter(safeContextPath).sort());
    if (combined.length > 0) specificFor.set(criterion.id, combined);
  }
  type Plan = { id: string; knownInSource: boolean; inherited: boolean; paths: string[]; changedText: boolean };
  const plans: Plan[] = args.rubric.map(criterion => {
    const inSource = sourceCriteria.get(criterion.id);
    const knownInSource = inSource !== undefined;
    const inherited = knownInSource && inSource.statement.trim() === criterion.statement.trim() && [...inSource.evidence].sort().join(",") === [...criterion.evidence].sort().join(",");
    if (knownInSource && !inherited) {
      gaps.push({ reason: "criterion-changed", path: null, criteria: [criterion.id], detail: `criterion "${criterion.id}" reads differently now than in the source run's signed rubric — its earlier judgement cannot support it` });
    }
    const paths = knownInSource ? (specificFor.get(criterion.id) ?? generalPaths) : [];
    return { id: criterion.id, knownInSource, inherited, paths, changedText: knownInSource && !inherited };
  });
  const relevance = new Map<string, { criteria: Set<string>; why: Set<ContextItemWhy> }>();
  for (const plan of plans) {
    for (const path of plan.paths) {
      const entry = relevance.get(path) ?? { criteria: new Set(), why: new Set() };
      entry.criteria.add(plan.id);
      entry.why.add(specificFor.get(plan.id)?.includes(path) ? "source-criterion-evidence" : "source-changed-path");
      relevance.set(path, entry);
    }
  }
  // A proof's path citations are relevance hints, not permission to omit other
  // changed files. Deliver new revision files and tests in full as supplemental
  // context without inventing criterion ownership or inheriting a judgement.
  for (const path of textOnly([...args.patchPaths])) {
    if (safeContextPath(path) && !relevance.has(path)) relevance.set(path, { criteria: new Set(), why: new Set(["candidate-changed-path"]) });
  }
  const candidates = [...relevance.keys()].sort((a, b) => {
    const aSpecific = relevance.get(a)!.why.has("source-criterion-evidence") ? 0 : 1;
    const bSpecific = relevance.get(b)!.why.has("source-criterion-evidence") ? 0 : 1;
    return aSpecific !== bSpecific ? aSpecific - bSpecific : a.localeCompare(b);
  });
  if (candidates.length > REVIEW_CONTEXT_LIMITS.candidatePaths) {
    for (const path of candidates.slice(REVIEW_CONTEXT_LIMITS.candidatePaths)) {
      gaps.push({ reason: "item-cap", path, criteria: [...relevance.get(path)!.criteria].sort(), detail: `${path}: beyond the ${REVIEW_CONTEXT_LIMITS.candidatePaths} candidate-path bound` });
    }
    candidates.length = REVIEW_CONTEXT_LIMITS.candidatePaths;
  }

  // 5. Read every candidate at the EXACT head — identity and size first,
  // bytes only for what the bounds admit — and compare identity at the
  // source head when ancestry verified.
  const itemsByPath = new Map<string, ReviewContextItem>();
  if (candidates.length > 0) {
    const atHead = await treeEntries(git, args.worktree, args.head, candidates);
    const atSource = inventory.ancestry.verified && sourceHead !== null ? await treeEntries(git, args.worktree, sourceHead, candidates) : null;
    if (atHead === null) {
      gapAll("capture-failed", `the tree at ${args.head} could not be listed`);
    } else {
      let aggregate = 0;
      for (const path of candidates) {
        const criteria = [...relevance.get(path)!.criteria].sort();
        const why = [...relevance.get(path)!.why].sort() as ContextItemWhy[];
        const entry = atHead.get(path);
        const gap = (reason: ContextGapReason, detail: string): void => { gaps.push({ reason, path, criteria, detail: `${path}: ${detail}` }); };
        if (entry === undefined) { gap("missing-at-head", `no object at ${args.head}`); continue; }
        if (!regular(entry)) { gap("not-a-file", `a ${entry.mode === "120000" ? "symlink" : entry.type} at ${args.head}, not a regular file`); continue; }
        const sourceEntry = atSource?.get(path);
        const unchangedSinceSource = atSource === null ? null : sameEntry(sourceEntry, entry);
        inventory.identities!.push({ path, commit: args.head, blob: entry.object, mode: entry.mode, bytes: entry.size, sourceRun: sourceRun.id, sourceBlob: regular(sourceEntry) ? sourceEntry.object : null, sourceMode: regular(sourceEntry) ? sourceEntry.mode : null, unchangedSinceSource });
        const oversized = entry.size > REVIEW_CONTEXT_LIMITS.itemBytes;
        if (oversized) gap("over-limit", `${entry.size} bytes at ${args.head} exceeds the ${REVIEW_CONTEXT_LIMITS.itemBytes}-byte item limit; full-file context is missing`);
        if (itemsByPath.size >= REVIEW_CONTEXT_LIMITS.items) { gap("item-cap", `beyond the ${REVIEW_CONTEXT_LIMITS.items}-item bound`); continue; }
        if (oversized) {
          const patch = await ancestorPatch(store, git, args, inventory, path);
          if (!patch.ok) { gap(patch.reason, patch.detail); continue; }
          const bytes = Buffer.byteLength(patch.content, "utf8");
          if (aggregate + bytes > REVIEW_CONTEXT_LIMITS.aggregateBytes) { gap("aggregate-limit", `the partial ancestor patch would cross the ${REVIEW_CONTEXT_LIMITS.aggregateBytes}-byte aggregate limit`); continue; }
          aggregate += bytes;
          itemsByPath.set(path, { id: `ctx-${itemsByPath.size + 1}`, path, commit: args.head, blob: entry.object, sha256: createHash("sha256").update(patch.content, "utf8").digest("hex"), bytes, content: patch.content, sourceRun: sourceRun.id, criteria, why, unchangedSinceSource, redacted: false, patch: { coverage: "partial", segments: patch.segments } });
          continue;
        }
        if (aggregate + entry.size > REVIEW_CONTEXT_LIMITS.aggregateBytes) { gap("aggregate-limit", `${entry.size} bytes would cross the ${REVIEW_CONTEXT_LIMITS.aggregateBytes}-byte aggregate limit`); continue; }
        const read = await git("git", [...GIT_READ, "cat-file", "blob", entry.object], { cwd: args.worktree, maxBuffer: REVIEW_CONTEXT_LIMITS.itemBytes + 4096 });
        if (read.code !== 0) { gap("capture-failed", `blob ${entry.object} could not be read (git exit ${read.code})`); continue; }
        if (read.stdout.includes("\u0000") || Buffer.byteLength(read.stdout, "utf8") !== entry.size) { gap("binary", "not UTF-8 text"); continue; }
        // Re-encoding must reproduce the named blob. A literal U+FFFD is
        // valid text; a replacement introduced by decoding fails this hash.
        const blobHash = createHash("sha1").update(`blob ${entry.size}\0`).update(read.stdout, "utf8").digest("hex");
        if (blobHash !== entry.object) { gap("capture-failed", "the returned bytes do not match the named Git blob"); continue; }
        const hits = scanForSecrets(read.stdout);
        const content = hits.length > 0 ? redactSecretLines(read.stdout, hits) : read.stdout;
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > REVIEW_CONTEXT_LIMITS.itemBytes || aggregate + bytes > REVIEW_CONTEXT_LIMITS.aggregateBytes) { gap("over-limit", "redaction did not fit the bounds"); continue; }
        if (hits.length > 0) gap("secret-redacted", `${hits.length} secret-shaped line(s) redacted before storage — the redacted lines cannot support any criterion`);
        aggregate += bytes;
        itemsByPath.set(path, {
          id: `ctx-${itemsByPath.size + 1}`,
          path,
          commit: args.head,
          blob: entry.object,
          sha256: createHash("sha256").update(content, "utf8").digest("hex"),
          bytes,
          content,
          sourceRun: sourceRun.id,
          criteria,
          why,
          unchangedSinceSource,
          redacted: hits.length > 0,
        });
      }
    }
  }
  inventory.items = [...itemsByPath.values()];
  const assetLine = await assetSummary(git, args.worktree, args.head, assets);

  // 6. Prior review provenance — context, proved per criterion, never a verdict.
  const sourceDiff = sourceArtifacts.find(one => one.kind === "terminal-diff") ?? null;
  const sourceProofArtifact = sourceArtifacts.find(one => one.kind === "proof") ?? null;
  const planOf = new Map(plans.map(one => [one.id, one] as const));
  for (const row of store.criterionReviewsFor(sourceRun.id).slice(0, REVIEW_CONTEXT_LIMITS.priorReviews)) {
    const plan = planOf.get(row.criterionId);
    if (plan === undefined || !plan.knownInSource) continue;
    const reasons: string[] = [];
    if (!plan.inherited) reasons.push("the criterion's signed text changed since the source review");
    if (!inventory.ancestry.verified) reasons.push("the source head is not verified ancestry of this head");
    if (!inventory.source.verified) reasons.push("the source run's sealed artifacts do not all verify");
    const relevantUnchanged = plan.paths.length > 0 && plan.paths.every(path => inventory.identities!.some(one => one.path === path && one.unchangedSinceSource === true) && !itemsByPath.get(path)?.redacted && !gaps.some(one => one.path === path && ["binary", "secret-redacted", "capture-failed", "source-unverified"].includes(one.reason)));
    if (!relevantUnchanged) reasons.push(plan.paths.length === 0 ? "no relevant source paths are known for this criterion" : "relevant code is not byte-identical between the source head and this head, or could not be sealed");
    const singularMatches = (kind: Artifact["kind"], bound: { artifact: number; sha256: string } | null) => {
      const entries = sourceArtifacts.filter(one => one.kind === kind);
      return bound === null ? entries.length === 0 : entries.length === 1 && entries[0]!.id === bound.artifact && entries[0]!.sha256 === bound.sha256;
    };
    const shots = sourceArtifacts.filter(one => one.kind === "screenshot");
    const screenshotsMatch = shots.length === row.screenshots.length && shots.every(one => row.screenshots.some(shot => shot.artifact === one.id && shot.sha256 === one.sha256 && shot.path === one.capture));
    const reviewerLineage = historicalReviewerLineage(store, row.reviewerRun);
    const reviewerVerified = reviewerLineage.length >= 2 && reviewerLineage.at(-1)?.id === sourceRun.id && reviewerLineage.slice(0, -1).every(one => one.role === "reviewer" && one.taskRef === sourceRun.taskRef && one.outcome === "no-change");
    const allBytesVerify = sourceArtifacts.filter(one => CONTEXT_INPUT_KINDS.has(one.kind)).every(one => {
      try { return usableReviewInput(args.root, one); } catch { return false; }
    });
    const bindingsVerified =
      allBytesVerify && reviewerVerified &&
      singularMatches("check-log", row.checkLog) && singularMatches("review-context", row.context) && screenshotsMatch &&
      row.headSha === sourceHead &&
      row.scopeDigest === sourceRun.scopeDigest &&
      sourceDiff !== null && row.artifact === sourceDiff.id && row.artifactSha === sourceDiff.sha256 &&
      (row.proof === null ? sourceProofArtifact === null : sourceProofArtifact !== null && row.proof.artifact === sourceProofArtifact.id && row.proof.sha256 === sourceProofArtifact.sha256);
    if (!bindingsVerified) reasons.push("the source review's own evidence bindings no longer match the source run's sealed artifacts");
    inventory.priorReview.push({
      criterionId: row.criterionId,
      sourceRun: sourceRun.id,
      reviewerRun: row.reviewerRun,
      author: row.author,
      judgement: row.judgement,
      note: row.note,
      statementMatches: plan.inherited,
      ancestryVerified: inventory.ancestry.verified,
      relevantPaths: plan.paths,
      relevantUnchanged,
      bindingsVerified,
      support: reasons.length === 0 ? "eligible" : "invalid",
      reasons,
    });
  }

  // 7. Coverage per criterion — the projection every surface reads.
  const coverage = plans.map((plan): CriterionContextCoverage => {
    const prior = inventory.priorReview.filter(one => one.criterionId === plan.id);
    const priorSupport: CriterionContextCoverage["priorSupport"] = prior.length === 0 ? "none" : prior.some(one => one.support === "eligible") ? "eligible" : "invalid";
    const relevantGaps = gaps.filter(one => one.criteria.includes(plan.id)).map(one => one.detail);
    if (!plan.knownInSource) return { ...patchOnly(plan.id, false, relevantGaps), ...(sourceScopeVerified ? {} : { state: "gap" as const }), priorSupport };
    const items = plan.paths.flatMap(path => (itemsByPath.has(path) ? [itemsByPath.get(path)!.id] : []));
    // "Judged from the patch" needs KNOWN relevance: only a verified source
    // proof can say the patch touched what this criterion is about.
    const touched = inventory.source.verified && plan.paths.some(path => args.patchPaths.has(path));
    const complete = plan.paths.length > 0 && plan.paths.every(path => itemsByPath.has(path) && !itemsByPath.get(path)!.redacted && !itemsByPath.get(path)!.patch) && inventory.source.verified && inventory.ancestry.verified;
    const state: CriterionContextCoverage["state"] = complete && relevantGaps.length === 0 ? (touched && plan.paths.every(path => args.patchPaths.has(path)) ? "patch" : "context") : "gap";
    const gapsFor = state === "gap" && relevantGaps.length === 0 ? [plan.paths.length === 0 ? "no relevant source paths are known" : "inherited context is incomplete"] : relevantGaps;
    return { id: plan.id, state, inherited: plan.inherited && lineage.sourceRun !== args.runId, paths: plan.paths, items, gaps: gapsFor, priorSupport };
  });
  return finish(assetLine === null ? coverage : coverage.map(one => ({ ...one, assets: assetLine })));
}
