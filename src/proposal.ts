import { validateTaskText } from "./task-text.js";
import type { Filer } from "./approval-policy.js";
export { validateTaskText } from "./task-text.js";
/**
 * The one door work enters through (Codex adoption review, finding 7).
 *
 * Before this module, each filing surface — CLI, console, intake — validated
 * what it happened to think of: createConsoleTask checked title and goal but
 * not disguised text, the routine command checked terms but nothing checked a
 * repo against the caller's ceiling, and nothing stamped who filed what. The
 * review's ruling: one canonical service that every filer calls, with an
 * exact field allowlist, so a careless caller CANNOT spread a template or
 * model object into scope rows and smuggle approval metadata.
 *
 * The contract, in order:
 *   - every text field is validated here, identically for every caller:
 *     length bounds, control characters, and DISGUISED text (invisibles,
 *     bidi overrides) on the fields an approver reads;
 *   - the repo is canonicalized, and when the caller has a ceiling the
 *     canonical repo must be inside it — an absent ceiling is the CLI's
 *     honest "no ceiling", never a wildcard for surfaces that have one;
 *   - approval fields are hardcoded null by the store methods this calls;
 *     nothing a caller passes can reach them (exact allowlist, no spread);
 *   - the digest is computed HERE, never accepted from the caller;
 *   - provenance (filedVia) is stamped in the same transaction and is
 *     immutable — there is no API to change it, anywhere.
 *
 * Filing carries NO authority. Everything this module creates is unapproved
 * and stays inert until the operator's own ceremony says otherwise.
 */

import { resolveRoutineAuthority } from "./agentconfig.js";
import { resolve } from "node:path";
import { hasForbiddenControls, hasDisguisedText } from "./decision.js";
import { canonicalProject } from "./project.js";
import {
  ROUTINE_NAME,
  routineDigestOf,
  validateRoutineTerms,
  type RoutineTerms,
} from "./routine.js";
import type { Store } from "./store.js";
import { parseAcceptanceCriteria, type UnattendedPermissionMode } from "./scope.js";
import type { QualityMode } from "./quality.js";
import type { TaskSizing } from "./phase-routing.js";
import { heuristicSizing, planningSignals, refineFiledSizing } from "./task-sizing.js";

/** Provenance tokens are part of the audit surface: lowercase, bounded,
 * nothing that could render as anything but itself. */
const FILED_VIA = /^[a-z][a-z0-9:-]{0,63}$/;

export type ProposalRefusal = {
  ok: false;
  /** Stable, machine-readable — joins the envelope like every reason. */
  reason:
    | "bad-title"
    | "bad-goal"
    | "bad-id"
    | "bad-name"
    | "bad-terms"
    | "bad-repo"
    | "outside-ceiling"
    | "bad-provenance"
    | "bad-acceptance"
    | "acceptance-required"
    | "backlog-full"
    | "duplicate";
  message: string;
};

export type TaskProposalInput = {
  id?: string;
  title: string;
  repo?: string;
  goal?: string;
  outOfScope?: string | null;
  touches?: string[];
  /** v39: the signed acceptance rubric — unparsed, checked by
   * `store.createConsoleTask` the same way every other filing text is
   * checked here: identically for every caller of this one door. */
  acceptance?: unknown;
  /** Which door filed this: 'cli', 'console', 'intake', 'template:<name>'. */
  filedVia: string;
  /** v102: who filed it — the person, or the person a coordinator acts for (separation of duties reads it). */
  filedBy?: Filer;
  /** The scope text's author when it is an LLM's (ruling 2; §10 for a
   * scout's follow-up): mode coverage never seals it. */
  proposedVia?: "mate" | "coordinator" | "scout";
  /** What comes back (v34): 'report' files a scout task. Set once, at filing. */
  deliverable?: "branch" | "report";
  /** Planning policy at the filing door. `required` is an explicit
   * operator choice, `skip` is an explicit direct-to-scope choice, and
   * `auto` (the default) plans implementation work whose breadth suggests
   * repository discovery will materially improve the approved scope. */
  planning?: "auto" | "required" | "skip";
  /** Concrete per-task unattended permission choice. When absent, the
   * installation default is resolved as the scope is filed. */
  permissionMode?: UnattendedPermissionMode;
  /** Concrete per-task evidence depth. Absent inherits the installation
   * default when the scope is filed. */
  qualityMode?: QualityMode;
  /**
   * The caller's ceiling as canonical repo paths. undefined = the caller
   * genuinely has none (the CLI on the operator's own machine). A surface
   * that HAS a ceiling must pass it — an empty list refuses every repo,
   * which is the fail-closed reading of an empty ceiling (finding 4).
   */
  admittedRepos?: readonly string[];
  /** v2 routing: the task's size when the caller already knows it (a
   * person's choice). Absent, filing sizes it from the description at
   * once and the process's classifier refines it within five seconds. */
  sizing?: TaskSizing;
};

/** One deterministic planning policy for console, chat, MCP, and sync
 * filings. A planner needs a repository to inspect; report/scout work is
 * already the discovery phase and never recursively plans itself. With a
 * size (v2 routing), a small change is not planned and a large or risky
 * one is; a medium one keeps the description's signals. */
export function shouldPlanTask(input: TaskProposalInput, sizing?: TaskSizing): boolean {
  if (input.deliverable === "report" || input.planning === "skip") return false;
  // Remote coordinators only propose work. Keep their submissions quarantined
  // until an operator has restated the scope; automatic planning must not turn
  // an untrusted MCP filing into executable workflow state.
  if (input.proposedVia === "coordinator" || input.filedVia?.startsWith("mcp:")) return false;
  if (input.repo === undefined || input.repo.trim() === "") return false;
  if (input.planning === "required") return true;
  if (sizing !== undefined) {
    if (sizing.size === "small" && !sizing.risky) return false;
    if (sizing.size === "large" || sizing.risky) return true;
  }
  return planningSignals(input);
}

export type RoutineProposalInput = {
  name: string;
  /** v102: who is making it (its instances are filed as theirs). */
  createdBy?: string | null;
  repo: string;
  goal: string;
  outOfScope: string | null;
  touches: string[];
  /** v39: the signed rubric every instance's scope copies forward. */
  acceptance: unknown;
  requirements: string[];
  schedule: string;
  costCeilingUsd: number | null;
  /** Per-instance dollar cap in micro-USD (v16); optional, digest-bound. */
  budgetPerRunMicrousd?: number | null;
  filedVia: string;
  admittedRepos?: readonly string[];
};

function refuse(reason: ProposalRefusal["reason"], message: string): ProposalRefusal {
  return { ok: false, reason, message };
}

/** The fields an approver reads must BE what they appear to be: no control
 * characters anywhere, no invisible or direction-override text either. */
function dishonest(text: string): boolean {
  return hasForbiddenControls(text) || hasDisguisedText(text);
}

/** Byte caps beside the character caps (Codex v3 review, change 8): a
 * 2000-character goal of astral-plane text is 8000 bytes — model-authored
 * fields must bound STORAGE, not just what a screen shows. */
const BYTE_CAPS = { title: 800, name: 200, text: 8_000, path: 800, requirement: 400 } as const;

function overBytes(text: string, cap: number): boolean {
  return Buffer.byteLength(text, "utf8") > cap;
}

function checkRepo(
  given: string | undefined,
  admitted: readonly string[] | undefined,
): { ok: true; repo: string | undefined } | ProposalRefusal {
  if (given === undefined || given === "") {
    // A ceiling names the ONLY repos this surface may file into. Filing
    // repo-less under a ceiling would bypass it wholesale (MCP spec v2,
    // Codex round 2 finding 2) — a bounded surface must say where.
    if (admitted !== undefined) {
      return refuse("outside-ceiling", "this surface must name a repository — it is limited to specific ones");
    }
    return { ok: true, repo: undefined };
  }
  // Best-effort canonicalization, the codebase's one convention: a real
  // directory resolves through symlinks; a path that does not exist yet
  // still normalizes, because filing must not depend on this machine
  // seeing every repo the plane knows about.
  const canonical = canonicalProject(given) ?? resolve(given);
  if (admitted !== undefined && !admitted.includes(canonical)) {
    return refuse("outside-ceiling", "that repository is outside what this surface was configured to show");
  }
  return { ok: true, repo: canonical };
}

export function fileTaskProposal(
  store: Store,
  input: TaskProposalInput,
  now: Date,
): { ok: true; id: string; planning: boolean; sizing: TaskSizing } | ProposalRefusal {
  if (!FILED_VIA.test(input.filedVia)) {
    return refuse("bad-provenance", "filedVia is an audit token: lowercase letters, digits, dashes, colons");
  }
  const badText = validateTaskText(input);
  if (badText !== null) return badText;
  // Sized at once from the description; filing never waits for a model.
  const sizing = input.sizing ?? heuristicSizing(input);
  const outOfScope = input.outOfScope ?? null;
  const touches = input.touches ?? [];
  const repo = checkRepo(input.repo, input.admittedRepos);
  if (!repo.ok) return repo;

  // Exact allowlist — built field by field, never spread from the input.
  const made = store.createConsoleTask(
    {
      ...(input.id === undefined ? {} : { id: input.id }),
      title: input.title,
      ...(repo.repo === undefined ? {} : { repo: repo.repo }),
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.qualityMode === undefined ? {} : { qualityMode: input.qualityMode }),
      outOfScope,
      touches,
      acceptance: input.acceptance,
      filedVia: input.filedVia,
      ...(input.filedBy === undefined ? {} : { filedBy: input.filedBy }),
      proposedVia: input.proposedVia ?? null,
      ...(input.deliverable === undefined ? {} : { deliverable: input.deliverable }),
      sizing,
    },
    now,
  );
  if (!made.ok) {
    return refuse(
      made.reason,
      made.reason === "backlog-full"
        ? "the backlog is full — finish or cancel something first"
        : made.reason === "duplicate"
          ? "a task with that id already exists"
          : made.reason === "acceptance-required"
            ? "a goal needs at least one signed acceptance criterion before it can be filed"
            : `the store refused the filing: ${made.reason}`,
    );
  }
  let planning = false;
  const placed = { ...input, ...(repo.repo === undefined ? {} : { repo: repo.repo }) };
  if (shouldPlanTask(placed, sizing)) {
    const ref = store.lookupRef(made.id);
    if (ref !== null) planning = store.requestPlan(ref.id, now).ok;
  }
  // The classifier (when this process has one) answers within five seconds
  // and re-files the still-unapproved scope with its size. Never for work
  // that builds nothing, or for an untrusted remote proposal.
  if (input.sizing === undefined && repo.repo !== undefined && input.goal !== undefined && input.deliverable !== "report" &&
      input.proposedVia !== "coordinator" && !input.filedVia.startsWith("mcp:")) {
    void refineFiledSizing(store, made.id, placed, input.planning === undefined || input.planning === "auto");
  }
  return { ok: true, id: made.id, planning, sizing };
}

export function fileRoutineProposal(
  store: Store,
  input: RoutineProposalInput,
  now: Date,
): { ok: true; id: number; digest: string } | ProposalRefusal {
  if (!FILED_VIA.test(input.filedVia)) {
    return refuse("bad-provenance", "filedVia is an audit token: lowercase letters, digits, dashes, colons");
  }
  const repo = checkRepo(input.repo, input.admittedRepos);
  if (!repo.ok) return repo;
  if (repo.repo === undefined) return refuse("bad-repo", "a routine needs the repository it runs in");

  const acceptanceParse = parseAcceptanceCriteria(input.acceptance);

  const terms: RoutineTerms = {
    repo: repo.repo,
    goal: input.goal,
    outOfScope: input.outOfScope,
    touches: input.touches,
    acceptance: acceptanceParse.criteria,
    requirements: input.requirements,
    schedule: input.schedule,
    // v1 routines run one instance at a time, period — hardcoded, not accepted.
    singleFlight: true,
    costCeilingUsd: input.costCeilingUsd,
    ...(input.budgetPerRunMicrousd == null ? {} : { budgetPerRunMicrousd: input.budgetPerRunMicrousd }),
  };
  // EVERY problem at once — an operator fixing a form deserves the whole
  // list, not one complaint per submission.
  const problems = validateRoutineTerms(terms);
  if (acceptanceParse.problems.length > 0) {
    problems.push({ field: "acceptance", problem: acceptanceParse.problems.map(p => p.message).join("; ") });
  }
  if (!ROUTINE_NAME.test(input.name)) {
    problems.unshift({ field: "name", problem: "lowercase letters, digits, and dashes — it becomes each instance's id" });
  }
  if (
    dishonest(input.goal) ||
    overBytes(input.goal, BYTE_CAPS.text) ||
    (input.outOfScope !== null && (dishonest(input.outOfScope) || overBytes(input.outOfScope, BYTE_CAPS.text)))
  ) {
    problems.push({ field: "goal", problem: "no control or disguised text, bounded bytes" });
  }
  // The v3 review, change 8: touches and requirements are approver-read
  // text too — the door holds them to the same honesty everywhere.
  if (input.touches.some(one => dishonest(one) || overBytes(one, BYTE_CAPS.path))) {
    problems.push({ field: "touches", problem: "no control or disguised text, bounded bytes" });
  }
  if (input.requirements.some(one => dishonest(one) || overBytes(one, BYTE_CAPS.requirement))) {
    problems.push({ field: "requirements", problem: "no control or disguised text, bounded bytes" });
  }
  if (problems.length > 0) {
    const named = problems.map(one => `${one.field}: ${one.problem}`).join("; ");
    return refuse(problems.some(one => one.field === "name") ? "bad-name" : "bad-terms", named);
  }
  // v24 filing invariant, routine flavor — since v48 the whole four-role
  // ROUTE: resolve which agents plan, build, repair, and review a firing
  // once, here, from the configuration of this moment, and bind route and
  // profile into the digest a person will sign. Unresolved saves too
  // (finding 19) — approval then refuses until the routine is restated.
  const authority = resolveRoutineAuthority(store, repo.repo, terms.acceptance, now);
  const routineProfile = authority.ok ? authority.profile : null;
  const routineRoute = authority.ok ? authority.route : null;
  const created = store.createRoutine(
    {
      name: input.name,
      ...terms,
      digest: routineDigestOf(terms, routineProfile, routineRoute),
      filedVia: input.filedVia,
      createdBy: input.createdBy ?? null,
      ...(routineProfile === null ? {} : { profile: routineProfile }),
      ...(routineRoute === null ? {} : { route: routineRoute }),
    },
    now,
  );
  if (!created.ok) return refuse("duplicate", `a routine named ${input.name} already exists`);
  return { ok: true, id: created.id, digest: routineDigestOf(terms, routineProfile, routineRoute) };
}
