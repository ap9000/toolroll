/**
 * One set of agent states (docs/plans/agents-cockpit.md §1): what a person sees at a glance for an attempt, a task, a
 * flow or a project. A display state is derived from four separate facts — what the agent is doing, how it ended, what
 * someone must do, and whether this person has seen it — and never stored as one. Looking clears only `done`: a failure,
 * an approval or a result to accept stays until it is dealt with. The words and colours of each state live here only.
 */
import { agentFactsFor, agentGroupOf, type AgentFacts } from "./agents-board.js";
import { stuckSince } from "./agent-board.js";
import { flowDefinitionOf } from "./flow-engine.js";
import type { Store } from "./store.js";
import { runActivityOf } from "./task-activity.js";
import { workStateRows, type WorkStateRow } from "./work-index.js";
import { assignmentChecksForRun } from "./assignment.js";
import type { WorkSummaryAccess } from "./work-summary.js";
import { DISPLAY_STATES, NO_COUNTS, rollUp, type DisplayState, type StateCounts } from "./agent-state-words.js";

export { DISPLAY_STATES, NEEDS_SOMEONE, NO_COUNTS, rollUp, STATE_TONE, STATE_WORDS, type DisplayState, type StateCounts } from "./agent-state-words.js";

/** What an attempt is doing. */
export type Activity = "queued" | "waiting" | "running" | "stuck" | "pausing" | "paused" | "stopping" | "stopped" | "finished";
/** How it ended (checks-failed: built, but the project's checks failed on its result). */
export type Outcome = "none" | "built" | "no-change" | "failed" | "checks-failed";
export type StateFacts = {
  activity: Activity;
  outcome: Outcome;
  /** Someone must act: a question, a plan or scope to approve, a decision, a result to accept, a sign-in. */
  obligation: boolean;
  /** This person hasn't seen its finished version. */
  unread: boolean;
  /** A newer attempt of the same task is running: an older failure no longer leads. */
  newerRunning?: boolean;
};

/** The one glance a set of facts gives. */
export function displayStateOf(facts: StateFacts): DisplayState {
  if (facts.obligation) return "needs-you";
  // A failure leads until it is dealt with (a retry, a revision, a stop, a cancel): looking never clears it.
  if ((facts.outcome === "failed" || facts.outcome === "checks-failed") && facts.activity === "finished" && facts.newerRunning !== true) return "failed";
  if (facts.activity === "stuck") return "stuck";
  if (facts.activity === "paused") return "paused";
  if (facts.activity === "running" || facts.activity === "pausing" || facts.activity === "stopping") return "working";
  if (facts.activity === "queued" || facts.activity === "waiting") return "waiting";
  // Only a good finish is news to be read; looking clears it, and nothing else does.
  if (facts.activity === "finished" && (facts.outcome === "built" || facts.outcome === "no-change") && facts.unread) return "done";
  return "idle";
}

/** The four facts of one build attempt, from what the Agents board reads (agents-board.ts): its own record only — a
 * stopped or cancelled attempt is not a failure, a parked one is a decision only while it is unanswered and its task is open, and one being
 * repaired is at work, not stuck. */
export function factsOfAttempt(facts: AgentFacts, activityAt: string | null, paused: boolean, now: Date, decisionOpen?: boolean): StateFacts {
  const settled = facts.taskState === "done" || facts.taskState === "cancelled";
  if (facts.outcome === null) {
    const { group } = agentGroupOf(facts, activityAt, now);
    const stuck = !facts.repairing && facts.turn === "busy"
      && stuckSince({ state: "busy", stateAt: facts.stateAt ?? facts.startedAt, transcriptAt: facts.transcriptAt ?? facts.startedAt, toolAt: facts.toolAt }, activityAt, now) !== null;
    // An open run asking, crashed or blocked is an obligation (the board's "needs you"), whatever else it is doing.
    return { activity: paused ? "paused" : stuck ? "stuck" : "running", outcome: "none", obligation: group === "needs-you", unread: false };
  }
  const unread = !(facts.seen || facts.legacy);
  if (facts.outcome === "built" || facts.outcome === "no-change") return { activity: "finished", outcome: facts.outcome, obligation: false, unread };
  // Stopped by a person or a restart, in either spelling (a legacy outcome, or a failure whose reason is the interruption).
  if (facts.outcome === "interrupted" || facts.outcome === "refused" || (facts.outcome === "failed" && facts.reason === "interrupted")) return { activity: "stopped", outcome: "none", obligation: false, unread };
  // A parked attempt asks only while its decision is unanswered (when known) and its task is open.
  if (facts.outcome === "parked") return { activity: "finished", outcome: "none", obligation: !settled && decisionOpen !== false, unread };
  // A failure on a task since settled (done another way, or cancelled) no longer leads.
  return { activity: "finished", outcome: settled ? "none" : "failed", obligation: false, unread };
}

/** A family's display state from the Tasks list's own classification (work-index.ts): failures that lead, what waits
 * on a person (a result to accept included), work waiting its turn; a complete result is news only until this person
 * has seen it. Running work is counted by its attempts instead. The Tasks list's rules are the rules here — where it
 * says a task waits on a person, so does this — so the two never disagree. */
const WAITING_CODES = new Set(["queued", "planning-ready", "scouting-ready", "updating", "retry-scheduled", "waiting-dependency", "worker-at-capacity"]);
/** Codes whose family is at work: its attempts say how. */
const AT_WORK = new Set(["running", "stopping"]);

/** One task family's strongest state in a project, and its one line when an agent is at work on it. */
export type FamilyState = { rootId: string; state: DisplayState; line: string | null;
  /** What it needs a person for, as an identity (task, question, hold, result…), and the agent it is about. */
  ask?: { version: string; run: number | null } };
export type ProjectState = { repo: string | null; state: DisplayState; counts: StateCounts;
  /** Each family that counted, strongest first (flow cards count without one). */
  families: FamilyState[];
  /** Flow cards waiting at a person's decision, by identity (newest first, at most FLOW_ASKS per flow). */
  flowAsks: { card: number; stage: string }[] };
/** Flow cards named per flow in a project's asks; the count stays complete beyond them. */
const FLOW_ASKS = 50;

/**
 * A project's states for one person: complete counts over every task family they may see, with the Tasks list's own
 * admission (never a page or the board's rows). Each family counts once for what it needs or how it ended; each live
 * attempt counts once for what it is doing (working, stuck, paused); an attempt that itself needs a person (crashed,
 * asking) counts there unless its family already does. Flow cards at a person's decision count too. Every visible
 * project is present, idle when nothing counts. Its cost is the Tasks list's own read, plus open runs.
 */
export function projectStates(store: Store, access: WorkSummaryAccess, account: string, now: Date, root?: string, flowRepos?: readonly string[]): ProjectState[] {
  const counts = new Map<string | null, StateCounts>();
  const strongest = new Map<string, FamilyState & { repo: string | null }>();
  const asked = new Map<string, { version: string; run: number | null }>();
  const flowAsks = new Map<string | null, { card: number; stage: string }[]>();
  const bump = (repo: string | null, state: DisplayState, rootId?: string, line: string | null = null) => {
    const current = counts.get(repo) ?? { ...NO_COUNTS };
    current[state] += 1;
    counts.set(repo, current);
    if (rootId === undefined || state === "waiting" || state === "idle") return;
    const before = strongest.get(rootId);
    if (before === undefined || DISPLAY_STATES.indexOf(state) < DISPLAY_STATES.indexOf(before.state)) strongest.set(rootId, { repo, rootId, state, line: line ?? before?.line ?? null });
    else if (before.line === null && line !== null) before.line = line;
  };
  for (const repo of access.repos ?? store.listProjects().map(one => one.path)) counts.set(repo, { ...NO_COUNTS });

  const families = workStateRows(store, now, access);
  const refs = families.flatMap(row => row.members);
  // Every live attempt of these families, every role, in one read.
  const open = refs.length === 0 ? [] : store.handle.prepare(`SELECT r.id, r.task_ref, r.role, r.runner, r.started_at FROM run r
      WHERE r.outcome IS NULL AND r.role IN ('planner','builder','scout','reviewer','repair') AND r.task_ref IN (SELECT value FROM json_each(?))`).all(JSON.stringify(refs));
  const paused = new Set(open.length === 0 ? [] : store.handle.prepare(`SELECT run FROM run_pause WHERE run IN (SELECT value FROM json_each(?))
      AND paused_at IS NOT NULL AND resumed_at IS NULL AND ended_at IS NULL`).all(JSON.stringify(open.map(row => Number(row["id"])))).map(row => Number(row["run"])));
  // Complete results that are news to this person: recorded since seeing was (a keyed attempt), and not yet seen.
  const completed = JSON.stringify(families.flatMap(row => row.code === "complete" && row.resultRun !== null ? [row.resultRun] : []));
  const unseen = new Set(store.handle.prepare(`SELECT r.id FROM run r WHERE r.id IN (SELECT value FROM json_each(?)) AND r.attempt_key IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agent_seen s WHERE s.account = ? AND s.run = r.id)`).all(completed, account).map(row => Number(row["id"])));
  // A result's outcome and its recorded check, for the families whose result is waiting on a person.
  const resultFacts = new Map(store.handle.prepare(`SELECT r.id, r.outcome, (SELECT c.status FROM run_check c WHERE c.run = r.id) AS recorded FROM run r
      WHERE r.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(families.flatMap(row => row.resultRun ?? []))).map(row => [Number(row["id"]), row]));
  // The result's checks as the result reads them (follow-up checks included); the recorded check only when nothing
  // else was read, so a passing follow-up clears an earlier failure.
  const checksFailed = (run: number) => {
    const status = assignmentChecksForRun(store, root, run, now).status;
    if (status === "failed" || status === "passed") return status === "failed";
    return resultFacts.get(run)?.["recorded"] === "failed";
  };

  const familyOf = new Map<number, WorkStateRow>();
  for (const row of families) for (const ref of row.members) familyOf.set(ref, row);
  const attempting = new Set(open.map(run => familyOf.get(Number(run["task_ref"]))?.rootId));
  const needing = new Set<string>();
  for (const row of families) {
    // At work: its attempts are counted below; a stop whose run has ended but whose process is not yet confirmed gone
    // is still at work.
    if (AT_WORK.has(row.code)) { if (!attempting.has(row.rootId)) bump(row.repo, "working", row.rootId); continue; }
    const result = row.resultRun === null ? null : resultFacts.get(row.resultRun);
    if (row.code === "failed" || row.code === "vanished-run") { bump(row.repo, "failed", row.rootId); continue; }
    // Waiting its turn, as the Tasks list ranks it: confirmations another computer owes included.
    if (row.waits) { bump(row.repo, "waiting", row.rootId); continue; }
    // A result waiting on a person is a failure when it failed or its checks failed (as its headline reads).
    const asks = row.code === "ready-to-check" || row.code === "result-needs-attention";
    if (asks && (result?.["outcome"] === "failed" || (row.resultRun !== null && checksFailed(row.resultRun)))) { bump(row.repo, "failed", row.rootId); continue; }
    // A family the person's lead has taken on waits on nobody (the Tasks list's rule); a failure still leads, above.
    if (row.leadClaim) { bump(row.repo, "waiting", row.rootId); continue; }
    if (asks || row.personNeed) { bump(row.repo, "needs-you", row.rootId); needing.add(row.rootId); asked.set(row.rootId, { version: row.version, run: row.liveRun }); continue; }
    if (WAITING_CODES.has(row.code)) { bump(row.repo, "waiting", row.rootId); continue; }
    if (row.code === "complete" && row.resultRun !== null && unseen.has(row.resultRun)) bump(row.repo, "done", row.rootId);
  }
  // Each live attempt: paused, stuck or at work; one that needs a person counts there, unless its family already does.
  for (const run of open) {
    const family = familyOf.get(Number(run["task_ref"]));
    if (family === undefined) continue;
    const id = Number(run["id"]);
    // What the agent did last, in the task page's own words: the rail's line for this family.
    const activity = runActivityOf(store, { id, runner: String(run["runner"]), startedAt: String(run["started_at"]) }, now);
    const line = activity.what === "" ? null : activity.what;
    if (paused.has(id)) { bump(family.repo, "paused", family.rootId, line); continue; }
    if (run["role"] !== "builder") { bump(family.repo, "working", family.rootId, line); continue; } // only builds are watched for quiet
    const facts = agentFactsFor(store, id, { repos: null }, account);
    if (facts === null || facts.outcome !== null) { bump(family.repo, "working", family.rootId, line); continue; }
    const at = activity.at;
    const state = displayStateOf(factsOfAttempt(facts, at, false, now));
    if (state === "needs-you") {
      if (!needing.has(family.rootId)) {
        bump(family.repo, "needs-you", family.rootId, line); needing.add(family.rootId);
        asked.set(family.rootId, { version: `${family.version}|agent:${id}:${facts.question?.id ?? facts.turn ?? ""}`, run: id });
      } else bump(family.repo, "working", family.rootId, line);
      continue;
    }
    bump(family.repo, state === "stuck" ? "stuck" : "working", family.rootId, line);
  }

  // Flow cards waiting at a person's decision (an approval or a choice), in the flows this person may see: one uncapped
  // count per flow over its deciding zones.
  const repos = flowRepos ?? (access.repos ?? store.listProjects().map(one => one.path));
  const deciding = store.handle.prepare("SELECT COUNT(*) AS n FROM flow_card WHERE flow = ? AND state = 'active' AND stage IN (SELECT value FROM json_each(?))");
  const namedCards = store.handle.prepare("SELECT id, stage FROM flow_card WHERE flow = ? AND state = 'active' AND stage IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT ?");
  for (const flow of store.listFlows(repos)) {
    const definition = flowDefinitionOf(flow);
    if (definition === null) continue;
    const zones = definition.stages.filter(one => one.kind === "approval" || one.kind === "choose").map(one => one.id);
    if (zones.length === 0) continue;
    const n = Number(deciding.get(flow.id, JSON.stringify(zones))?.["n"] ?? 0);
    for (let i = 0; i < n; i++) bump(flow.repo, "needs-you");
    if (n > 0) flowAsks.set(flow.repo, [...(flowAsks.get(flow.repo) ?? []), ...namedCards.all(flow.id, JSON.stringify(zones), FLOW_ASKS)
      .map(row => ({ card: Number(row["id"]), stage: String(row["stage"]) }))]);
  }

  const rank = (one: FamilyState) => DISPLAY_STATES.indexOf(one.state);
  return [...counts.entries()].map(([repo, value]) => ({ repo, ...rollUp(value),
    families: [...strongest.values()].filter(one => one.repo === repo).map(({ rootId, state, line }) => {
      const ask = state === "needs-you" ? asked.get(rootId) : undefined;
      return { rootId, state, line, ...(ask === undefined ? {} : { ask }) };
    }).sort((a, b) => rank(a) - rank(b)),
    flowAsks: flowAsks.get(repo) ?? [] }))
    .sort((a, b) => (a.repo ?? "").localeCompare(b.repo ?? ""));
}
