/**
 * The planner's terminal handoff, parsed with the 422 rule: fail closed,
 * every problem reported at once, stable reasons, caps and control-character
 * rejection on every string — because a plan payload reaches terminals, the
 * approve card, and the builder's brief (Codex planning review, question 2:
 * the scope proposal is authority-bearing, so it gets the park discipline).
 */

import { createHash } from "node:crypto";
import { hasForbiddenControls } from "./decision.js";
import { parseAcceptanceCriteria, type AcceptanceCriterion } from "./scope.js";
import { TEXT_LIMITS } from "./text-limits.js";
import type { ContractIssue } from "./contracts/contract.js";
import { planPayloadBody, readPlanPayload } from "./contracts/plan.js";

export type PlanProblem = { reason: string; message: string };

export type ParsedPlan = {
  goal: string;
  outOfScope: string | null;
  touches: string[];
  /** v39: the rubric the planner drafts alongside the goal — mandatory,
   * because the planner is a scope-producing road like any other (the
   * scope text names it explicitly). A malformed or empty rubric fails
   * the whole plan the same way a missing goal always has. */
  acceptance: AcceptanceCriterion[];
  /** The plan document, markdown, rendered fenced-inert everywhere. */
  plan: string;
  /** Why the filed contract must change (contract handoff, task 1): a
   * planner that proposes different goal/outOfScope/touches/acceptance
   * than the operator filed says so HERE, or the plan is malformed. Null
   * when the plan reproduces the filed terms, or when none were filed. */
  amendment: string | null;
};

/** A deliberately small execution plan. The signed scope remains the
 * authority; this is the durable road the builder is expected to follow.
 * Fixed sections make the handoff scannable in the console and prevent the
 * planner from hiding the useful parts in a long essay. */
export type ExecutionPlanDocument = {
  approach: string;
  milestones: string[];
  dependencies: string[];
  risks: string[];
  proof: string[];
};

export type ExecutionPlanDocumentResult =
  | { ok: true; document: ExecutionPlanDocument }
  | { ok: false; problems: PlanProblem[] };

const EXECUTION_PLAN_SECTIONS = ["approach", "milestones", "dependencies", "risks", "proof"] as const;
const EXECUTION_PLAN_LIST_CAP = 12;
const EXECUTION_PLAN_ITEM_CAP = TEXT_LIMITS.planItem;

/** Parse the planner's human-readable artifact without executing Markdown.
 * Older free-form plan artifacts remain renderable through the caller's
 * fallback, while every newly accepted planner handoff uses this shape. */
export function parseExecutionPlanDocument(raw: string): ExecutionPlanDocumentResult {
  const problems: PlanProblem[] = [];
  if (Buffer.byteLength(raw, "utf8") > TEXT_LIMITS.planDocumentBytes) {
    return { ok: false, problems: [{ reason: "plan-too-long", message: `plan is over ${TEXT_LIMITS.planDocumentBytes} bytes` }] };
  }
  const normalized = raw.replace(/\r\n?/g, "\n");
  if (hasForbiddenControls(normalized)) {
    return { ok: false, problems: [{ reason: "plan-controls", message: "plan carries control characters that could become terminal escapes" }] };
  }

  const sections = new Map<string, string[]>();
  let current: string | null = null;
  let lastSection = -1;
  for (const line of normalized.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const name = (heading[1] ?? "").trim().toLowerCase();
      if (!EXECUTION_PLAN_SECTIONS.includes(name as (typeof EXECUTION_PLAN_SECTIONS)[number])) {
        problems.push({ reason: "plan-unknown-section", message: `plan section \"${heading[1]}\" is not one of Approach, Milestones, Dependencies, Risks, or Proof` });
        current = null;
        continue;
      }
      const position = EXECUTION_PLAN_SECTIONS.indexOf(name as (typeof EXECUTION_PLAN_SECTIONS)[number]);
      if (position < lastSection) {
        problems.push({ reason: "plan-section-order", message: "plan sections must stay in order: Approach, Milestones, Dependencies, Risks, Proof" });
      }
      lastSection = Math.max(lastSection, position);
      if (sections.has(name)) problems.push({ reason: `plan-duplicate-${name}`, message: `plan has more than one ${name} section` });
      sections.set(name, []);
      current = name;
      continue;
    }
    if (current === null) {
      if (line.trim() !== "") problems.push({ reason: "plan-preamble", message: "plan must start with ## Approach" });
      continue;
    }
    sections.get(current)?.push(line);
  }

  for (const section of EXECUTION_PLAN_SECTIONS) {
    if (!sections.has(section)) problems.push({ reason: `plan-missing-${section}`, message: `plan needs a ## ${section[0]?.toUpperCase()}${section.slice(1)} section` });
  }
  if (problems.length > 0) return { ok: false, problems };

  const approach = (sections.get("approach") ?? []).join("\n").trim();
  if (approach === "") problems.push({ reason: "plan-empty-approach", message: "Approach must say how the work will be done" });
  if (approach.length > TEXT_LIMITS.planApproach) problems.push({ reason: "plan-approach-too-long", message: `Approach is over ${TEXT_LIMITS.planApproach} characters` });

  const list = (name: "milestones" | "dependencies" | "risks" | "proof"): string[] => {
    const items: string[] = [];
    for (const line of sections.get(name) ?? []) {
      if (line.trim() === "") continue;
      const item = /^(?:[-*]\s+|\d+[.)]\s+)(.+)$/.exec(line.trim())?.[1]?.trim();
      if (item === undefined || item === "") {
        problems.push({ reason: `plan-bad-${name}-item`, message: `${name} entries must be bullets or numbered items` });
        continue;
      }
      if (item.length > EXECUTION_PLAN_ITEM_CAP) {
        problems.push({ reason: `plan-${name}-item-too-long`, message: `${name} entries are capped at ${EXECUTION_PLAN_ITEM_CAP} characters` });
        continue;
      }
      items.push(item);
    }
    if (items.length === 0) problems.push({ reason: `plan-empty-${name}`, message: `${name} needs at least one item (use \"None found.\" when honest)` });
    if (items.length > EXECUTION_PLAN_LIST_CAP) problems.push({ reason: `plan-too-many-${name}`, message: `${name} is capped at ${EXECUTION_PLAN_LIST_CAP} items` });
    return items;
  };

  const document = {
    approach,
    milestones: list("milestones"),
    dependencies: list("dependencies"),
    risks: list("risks"),
    proof: list("proof"),
  };
  return problems.length === 0 ? { ok: true, document } : { ok: false, problems };
}

/**
 * The inverse of `parseExecutionPlanDocument`: the canonical fenced-section
 * markdown for a document the parser already admitted.
 *
 * A builder's revision proposal arrives as free-form text that the parser
 * validates and reduces to this shape; what gets STORED — and later
 * hash-verified, re-read, and quoted into the next brief — is rendered back
 * from that validated shape, never the agent's raw bytes (the scout
 * report's rule, and settleProof's). `parseExecutionPlanDocument` composed
 * with this function is the identity on every document the parser admits:
 * sections in their fixed order, one bullet per item, nothing else.
 */
export function renderExecutionPlanDocument(document: ExecutionPlanDocument): string {
  const bullets = (items: readonly string[]): string[] => items.map(item => `- ${item}`);
  return [
    "## Approach",
    document.approach,
    "",
    "## Milestones",
    ...bullets(document.milestones),
    "",
    "## Dependencies",
    ...bullets(document.dependencies),
    "",
    "## Risks",
    ...bullets(document.risks),
    "",
    "## Proof",
    ...bullets(document.proof),
    "",
  ].join("\n");
}

export type PlanParseResult =
  | { ok: true; plan: ParsedPlan }
  | { ok: false; problems: PlanProblem[] };

function refuse(reason: string, message: string): PlanParseResult {
  return { ok: false, problems: [{ reason, message }] };
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return `a ${value.length}-char string`;
  return `a ${Array.isArray(value) ? "array" : typeof value}`;
}

/** A progress note or revision field, checked by hand (those payloads are not on the plan contract yet). */
function prose(
  value: unknown,
  field: string,
  cap: number,
  required: boolean,
  problems: PlanProblem[],
): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) problems.push({ reason: `missing-${field}`, message: `${field} is required` });
    return null;
  }
  if (typeof value !== "string") {
    problems.push({ reason: `bad-${field}`, message: `${field} must be a string (got ${describe(value)})` });
    return null;
  }
  if (value.length > cap) {
    problems.push({ reason: `${field}-too-long`, message: `${field} is over ${cap} characters` });
    return null;
  }
  if (hasForbiddenControls(value)) {
    problems.push({ reason: `${field}-controls`, message: `${field} carries control characters that could become terminal escapes` });
    return null;
  }
  return value;
}

/**
 * A contract issue as a plan problem: the path-named line is the message, and the reason keeps the codes the rest of
 * the code relies on — `missing-goal`, `bad-touches`, `plan-too-long`, `amendment-too-long`, `acceptance-too-many` —
 * so repair eligibility (document-only problems) and durable outcomes read the same as before the contract.
 */
export function planProblemOf(issue: ContractIssue): PlanProblem {
  const at = issue.path;
  const reason = (() => {
    switch (issue.kind) {
      case "required":
      case "empty":
      case "too-few":
        return `missing-${at}`;
      case "too-long":
        return `${at}-too-long`;
      case "too-many":
        return `${at}-too-many`;
      case "unknown-key":
        return `${at}-unknown-key`;
      case "newer-version":
        return "newer-version";
      default:
        return `bad-${at}`;
    }
  })();
  return { reason, message: issue.line };
}

/** scope.ts's rubric problem as a path-named line: `acceptance[0].id: is over 40 bytes`. */
function acceptanceLine(problem: PlanProblem): string {
  const named = /^(acceptance(?:\[\d+\])?(?:\.[A-Za-z]+)?) (.*)$/.exec(problem.message);
  if (named !== null) return `${named[1]}: ${named[2]}`;
  const at = /^(acceptance\[\d+\])-/.exec(problem.reason)?.[1] ?? "acceptance";
  return `${at}: ${problem.message}`;
}

/** True when `problems` name `field` or anything under it. */
const touched = (problems: readonly PlanProblem[], field: string) =>
  problems.some(problem => problem.message.startsWith(`${field}:`) || problem.message.startsWith(`${field}[`) || problem.message.startsWith(`${field}.`));

/**
 * The rules JSON Schema cannot state, in plain code with named errors: control characters, one-line touches, the
 * document's byte cap and sections, the acceptance rubric's byte limits and duplicate ids (scope.ts's own parser),
 * and the Proof naming every criterion. Fields the contract already refused are skipped, so every problem is
 * reported once and all at once.
 */
function planRuleProblems(body: Record<string, unknown>, contract: readonly PlanProblem[]): { problems: PlanProblem[]; criteria: AcceptanceCriterion[] } {
  const problems: PlanProblem[] = [];
  const text = (field: string): string | null => {
    const value = body[field];
    return typeof value === "string" && !touched(contract, field) ? value : null;
  };
  for (const field of ["goal", "outOfScope", "plan", "amendment"]) {
    const value = text(field);
    if (value !== null && hasForbiddenControls(value)) {
      problems.push({ reason: `${field}-controls`, message: `${field}: carries control characters that could become terminal escapes` });
    }
  }
  const touches = body["touches"];
  if (Array.isArray(touches) && !touched(contract, "touches")) {
    for (const [index, path] of touches.entries()) {
      if (typeof path !== "string") continue;
      const field = `touches[${index}]`;
      if (hasForbiddenControls(path)) problems.push({ reason: `${field}-controls`, message: `${field}: carries control characters that could become terminal escapes` });
      else if (/[\n\t]/.test(path)) problems.push({ reason: `${field}-multiline`, message: `${field}: must be one line` });
    }
  }

  let criteria: AcceptanceCriterion[] = [];
  let acceptanceOk = false;
  if (!touched(contract, "acceptance")) {
    const acceptance = parseAcceptanceCriteria(body["acceptance"]);
    problems.push(...acceptance.problems.map(problem => ({ reason: problem.reason, message: acceptanceLine(problem) })));
    criteria = acceptance.criteria;
    acceptanceOk = acceptance.problems.length === 0;
  }

  const document = text("plan");
  if (document !== null && document !== "") {
    if (Buffer.byteLength(document, "utf8") > TEXT_LIMITS.planDocumentBytes) {
      problems.push({ reason: "plan-too-long", message: `plan: over ${TEXT_LIMITS.planDocumentBytes.toLocaleString("en-US")} bytes` });
    } else if (!hasForbiddenControls(document)) {
      const execution = parseExecutionPlanDocument(document);
      if (!execution.ok) {
        problems.push(...execution.problems.map(problem => ({ reason: problem.reason, message: `plan: ${problem.message}` })));
      } else if (acceptanceOk) {
        const proof = execution.document.proof.join("\n");
        for (const criterion of criteria) {
          const mentioned = new RegExp(`(^|[^A-Za-z0-9_-])${criterion.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_-]|$)`).test(proof);
          if (!mentioned) {
            problems.push({ reason: `plan-proof-missing-${criterion.id}`, message: `plan: Proof must name acceptance criterion ${criterion.id}` });
          }
        }
      }
    }
  }
  return { problems, criteria };
}

/**
 * The planner's handoff, read against the plan contract (src/contracts/plan.ts): fail closed, every problem at once,
 * each one naming its path (`acceptance[0].evidence[0]: must be one of ...`). A plan saved before plans carried
 * `version` reads as it always did.
 */
export function parsePlan(raw: string): PlanParseResult {
  if (Buffer.byteLength(raw, "utf8") > TEXT_LIMITS.planPayloadBytes) {
    return refuse("too-large", `payload: over ${TEXT_LIMITS.planPayloadBytes.toLocaleString("en-US")} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return refuse("not-json", `the payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = planPayloadBody(parsed);
  if (body === null) return refuse("not-an-object", "payload: must be one JSON object");

  const read = readPlanPayload(parsed);
  const contract = read.ok ? [] : read.issues.map(planProblemOf);
  if (contract.some(problem => problem.reason === "newer-version" || problem.reason === "bad-version")) return { ok: false, problems: contract };
  const rules = planRuleProblems(body, contract);
  const problems = [...contract, ...rules.problems];
  if (!read.ok || problems.length > 0) return { ok: false, problems };

  const payload = read.value;
  return {
    ok: true,
    plan: {
      goal: payload.goal,
      outOfScope: payload.outOfScope === undefined || payload.outOfScope === null || payload.outOfScope === "" ? null : payload.outOfScope,
      touches: payload.touches ?? [],
      acceptance: rules.criteria,
      plan: payload.plan,
      amendment: payload.amendment === undefined || payload.amendment === null || payload.amendment === "" ? null : payload.amendment,
    },
  };
}

// ---- adaptive execution plans --------------------------------------------
//
// A running build checkpoints durable milestone state against the exact
// plan revision it received, and may file one bounded, evidence-linked
// revision proposal when repository evidence invalidates a named
// dependency, risk, or implementation assumption. Everything below is a
// pure primitive: identity, state, and classification only — no I/O, no
// storage, no claim/lease knowledge. Those live in store.ts, claim.ts, and
// builder.ts, which reuse these functions rather than re-deriving them.

export type MilestoneState = "pending" | "current" | "completed" | "blocked";

const MILESTONE_STATES: readonly MilestoneState[] = ["pending", "current", "completed", "blocked"];

export type Milestone = { id: string; description: string };

/**
 * A milestone's identity is its position plus a short hash of its
 * normalized text — stable across re-reads of the same revision, but a
 * milestone whose wording changes materially becomes a NEW identity rather
 * than silently inheriting stale completion state from a differently-worded
 * predecessor.
 */
export function milestoneId(index: number, description: string): string {
  const hash = createHash("sha256").update(description.trim().toLowerCase(), "utf8").digest("hex").slice(0, 8);
  return `m${index + 1}-${hash}`;
}

export function milestonesOf(document: ExecutionPlanDocument): Milestone[] {
  return document.milestones.map((description, index) => ({ id: milestoneId(index, description), description }));
}

export type ProgressEntry = { id: string; state: MilestoneState; note: string | null };

/** The builder's atomic progress checkpoint: every milestone in the plan
 * revision it received, exactly once each, bound to that revision's exact
 * hash so a checkpoint can never be misread against a different plan. */
export type ProgressSnapshot = {
  revisionHash: string;
  milestones: ProgressEntry[];
};

export type ProgressParseResult =
  | { ok: true; snapshot: ProgressSnapshot }
  | { ok: false; problems: PlanProblem[] };

export const PROGRESS_LIMITS = {
  payload: 8 * 1024,
  note: 300,
  milestones: EXECUTION_PLAN_LIST_CAP,
} as const;

/** Parse a progress checkpoint written by a running build. `expectedRevisionHash`
 * and `knownIds` come from the plan revision the build's brief actually
 * named — a snapshot naming a different revision, an unknown milestone id,
 * a missing milestone, or more than one "current" milestone fails closed
 * with every problem at once, the same 422 rule as the plan itself. */
export function parseProgressSnapshot(
  raw: string,
  expectedRevisionHash: string,
  knownIds: readonly string[],
): ProgressParseResult {
  if (Buffer.byteLength(raw, "utf8") > PROGRESS_LIMITS.payload) {
    return { ok: false, problems: [{ reason: "progress-too-large", message: `progress is over ${PROGRESS_LIMITS.payload} bytes` }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, problems: [{ reason: "progress-not-json", message: `progress is not JSON: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problems: [{ reason: "progress-not-an-object", message: "progress must be one JSON object" }] };
  }
  const body = parsed as Record<string, unknown>;
  const problems: PlanProblem[] = [];

  const revisionHash = typeof body["revisionHash"] === "string" ? body["revisionHash"] : null;
  if (revisionHash === null) {
    problems.push({ reason: "progress-missing-revision", message: "progress must name revisionHash" });
  } else if (revisionHash !== expectedRevisionHash) {
    problems.push({ reason: "progress-stale-revision", message: "progress names a plan revision that is not the one this build received" });
  }

  const rawMilestones = body["milestones"];
  const milestones: ProgressEntry[] = [];
  if (!Array.isArray(rawMilestones)) {
    problems.push({ reason: "progress-bad-milestones", message: `milestones must be an array (got ${describe(rawMilestones)})` });
  } else if (rawMilestones.length > PROGRESS_LIMITS.milestones) {
    problems.push({ reason: "progress-too-many-milestones", message: `milestones is capped at ${PROGRESS_LIMITS.milestones} entries` });
  } else {
    const seen = new Set<string>();
    for (const [index, entryRaw] of rawMilestones.entries()) {
      if (typeof entryRaw !== "object" || entryRaw === null || Array.isArray(entryRaw)) {
        problems.push({ reason: `progress-bad-entry-${index}`, message: `milestones[${index}] must be an object` });
        continue;
      }
      const entry = entryRaw as Record<string, unknown>;
      const id = typeof entry["id"] === "string" ? entry["id"] : null;
      const state = typeof entry["state"] === "string" ? entry["state"] : null;
      const note = prose(entry["note"], `milestones[${index}].note`, PROGRESS_LIMITS.note, false, problems);
      if (id === null || !knownIds.includes(id)) {
        problems.push({ reason: `progress-unknown-milestone-${index}`, message: `milestones[${index}] names a milestone id not in this plan revision` });
        continue;
      }
      if (seen.has(id)) {
        problems.push({ reason: `progress-duplicate-milestone-${index}`, message: `milestone ${id} appears more than once` });
        continue;
      }
      seen.add(id);
      if (state === null || !MILESTONE_STATES.includes(state as MilestoneState)) {
        problems.push({ reason: `progress-bad-state-${index}`, message: `milestones[${index}].state must be one of ${MILESTONE_STATES.join(", ")}` });
        continue;
      }
      milestones.push({ id, state: state as MilestoneState, note });
    }
    for (const knownId of knownIds) {
      if (!seen.has(knownId)) problems.push({ reason: "progress-missing-milestone", message: `progress must report every milestone in the plan revision (missing ${knownId})` });
    }
    if (milestones.filter(entry => entry.state === "current").length > 1) {
      problems.push({ reason: "progress-multiple-current", message: "at most one milestone may be current at a time" });
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, snapshot: { revisionHash: revisionHash as string, milestones } };
}

/** Whether a checkpoint transition is a legitimate update or a regression:
 * once a milestone is completed it never reverts — an agent restating an
 * old snapshot (a stale pulse, a retried read) must never erase progress
 * that a later, newer checkpoint already recorded. */
export function isMilestoneRegression(previous: MilestoneState | undefined, next: MilestoneState): boolean {
  return previous === "completed" && next !== "completed";
}

export type PlanRevisionProposal = {
  /** The complete replacement plan document — the same shape the planner
   * itself produces, never a diff, so a revision is always fully readable
   * on its own. */
  document: ExecutionPlanDocument;
  /** Why: the named dependency, risk, or implementation assumption the
   * repository evidence invalidated. */
  reason: string;
  /** Where: a path, commit, or command output the operator (or a later
   * reader) can go re-check. */
  evidenceLink: string;
};

export type PlanRevisionProposalParseResult =
  | { ok: true; proposal: PlanRevisionProposal }
  | { ok: false; problems: PlanProblem[] };

export const REVISION_LIMITS = {
  payload: 32 * 1024,
  reason: 2_000,
  evidenceLink: 500,
} as const;

/** Parse the builder's terminal revision-proposal file: a complete
 * replacement plan document plus the evidence that invalidated the one it
 * was given. One proposal per build — the caller enforces that by never
 * offering the agent more than one nonce-named path to write. */
export function parsePlanRevisionProposal(raw: string): PlanRevisionProposalParseResult {
  if (Buffer.byteLength(raw, "utf8") > REVISION_LIMITS.payload) {
    return { ok: false, problems: [{ reason: "revision-too-large", message: `revision proposal is over ${REVISION_LIMITS.payload} bytes` }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, problems: [{ reason: "revision-not-json", message: `revision proposal is not JSON: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problems: [{ reason: "revision-not-an-object", message: "revision proposal must be one JSON object" }] };
  }
  const body = parsed as Record<string, unknown>;
  const problems: PlanProblem[] = [];
  const reason = prose(body["reason"], "reason", REVISION_LIMITS.reason, true, problems);
  const evidenceLink = prose(body["evidenceLink"], "evidenceLink", REVISION_LIMITS.evidenceLink, true, problems);
  const planText = prose(body["plan"], "plan", TEXT_LIMITS.planDocumentBytes, true, problems);
  let document: ExecutionPlanDocument | null = null;
  if (planText !== null) {
    const execution = parseExecutionPlanDocument(planText);
    if (!execution.ok) problems.push(...execution.problems);
    else document = execution.document;
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, proposal: { document: document as ExecutionPlanDocument, reason: reason as string, evidenceLink: evidenceLink as string } };
}

/** The exact authority a build's approval rests on: the signed scope
 * (goal, out-of-scope, touches, acceptance, permissions, quality, budget —
 * everything folded into the scope digest) plus publication authority
 * (branch vs. report). A plan revision may only auto-resume when this is
 * byte-identical to what it was when the build started; anything else
 * stays paused for a person, named. */
export type AuthoritySnapshot = { scopeDigest: string; deliverable: "branch" | "report" };

export function authoritySnapshotDigest(snapshot: AuthoritySnapshot): string {
  return createHash("sha256").update(`${snapshot.scopeDigest}\u0000${snapshot.deliverable}`, "utf8").digest("hex").slice(0, 32);
}

export type AuthorityChangeField = "signed-scope" | "publication-authority";

export type RevisionAuthorityCheck = { kind: "plan-only" } | { kind: "authority-change"; changed: AuthorityChangeField[] };

/** Classify a revision against the complete authority snapshot the build
 * actually started under. Everything the builder's own proposal can name is
 * plan-only by construction (it carries no scope fields at all) — this
 * check exists as the defense against the world moving underneath a live
 * build: if the signed scope or publication authority changed by any other
 * road while the build ran, the revision is never auto-applied, whatever it
 * proposes. */
export function classifyRevisionAuthority(previous: AuthoritySnapshot, current: AuthoritySnapshot): RevisionAuthorityCheck {
  const changed: AuthorityChangeField[] = [];
  if (previous.scopeDigest !== current.scopeDigest) changed.push("signed-scope");
  if (previous.deliverable !== current.deliverable) changed.push("publication-authority");
  return changed.length === 0 ? { kind: "plan-only" } : { kind: "authority-change", changed };
}
