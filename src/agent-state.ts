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

/** The display states, strongest first: a roll-up takes the first one any member has. */
export const DISPLAY_STATES = ["needs-you", "failed", "stuck", "paused", "working", "waiting", "done", "idle"] as const;
export type DisplayState = (typeof DISPLAY_STATES)[number];

export const STATE_WORDS: Record<DisplayState, string> = {
  "needs-you": "Needs you", failed: "Failed", stuck: "Stuck", paused: "Paused", working: "Working", waiting: "Waiting", done: "Done", idle: "Idle",
};
/** For someone who may not act on it: the obligation is still there, and still counts. */
export const NEEDS_SOMEONE = "Needs someone";
/** Each state's tone, for the console's one palette (attention, problem, live, ready, done, muted). */
export const STATE_TONE: Record<DisplayState, "attention" | "problem" | "live" | "ready" | "done" | "muted"> = {
  "needs-you": "attention", failed: "problem", stuck: "problem", paused: "muted", working: "live", waiting: "muted", done: "ready", idle: "muted",
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

export type StateCounts = Record<DisplayState, number>;
export const NO_COUNTS: StateCounts = Object.freeze({ "needs-you": 0, failed: 0, stuck: 0, paused: 0, working: 0, waiting: 0, done: 0, idle: 0 });

/** The strongest state among counts, and the counts themselves. Nothing counted is idle. */
export function rollUp(counts: StateCounts): { state: DisplayState; counts: StateCounts } {
  return { state: DISPLAY_STATES.find(state => state !== "idle" && counts[state] > 0) ?? "idle", counts };
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

export type ProjectState = { repo: string | null; state: DisplayState; counts: StateCounts };

/**
 * A project's states for one person: complete counts over every task family they may see, with the Tasks list's own
 * admission (never a page or the board's rows). Each family counts once for what it needs or how it ended; each live
 * attempt counts once for what it is doing (working, stuck, paused); an attempt that itself needs a person (crashed,
 * asking) counts there unless its family already does. Flow cards at a person's decision count too. Every visible
 * project is present, idle when nothing counts. Its cost is the Tasks list's own read, plus open runs.
 */
export function projectStates(store: Store, access: WorkSummaryAccess, account: string, now: Date, root?: string, flowRepos?: readonly string[]): ProjectState[] {
  const counts = new Map<string | null, StateCounts>();
  const bump = (repo: string | null, state: DisplayState) => {
    const current = counts.get(repo) ?? { ...NO_COUNTS };
    current[state] += 1;
    counts.set(repo, current);
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
  const checksFailed = (run: number) => resultFacts.get(run)?.["recorded"] === "failed" || assignmentChecksForRun(store, root, run, now).status === "failed";

  const familyOf = new Map<number, WorkStateRow>();
  const needing = new Set<string>();
  for (const row of families) {
    for (const ref of row.members) familyOf.set(ref, row);
    if (AT_WORK.has(row.code) || row.leadClaim) continue; // its attempts are counted below
    const result = row.resultRun === null ? null : resultFacts.get(row.resultRun);
    if (row.code === "failed" || row.code === "vanished-run") { bump(row.repo, "failed"); continue; }
    // A result waiting on a person: a failure when it failed or its checks failed (as its headline reads), otherwise an ask.
    if (row.code === "ready-to-check" || row.code === "result-needs-attention") {
      const failed = result?.["outcome"] === "failed" || (row.resultRun !== null && checksFailed(row.resultRun));
      bump(row.repo, failed ? "failed" : "needs-you");
      if (!failed) needing.add(row.rootId);
      continue;
    }
    if (row.personNeed) { bump(row.repo, "needs-you"); needing.add(row.rootId); continue; }
    if (WAITING_CODES.has(row.code)) { bump(row.repo, "waiting"); continue; }
    if (row.code === "complete" && row.resultRun !== null && unseen.has(row.resultRun)) bump(row.repo, "done");
  }
  // Each live attempt: paused, stuck or at work; one that needs a person counts there, unless its family already does.
  for (const run of open) {
    const family = familyOf.get(Number(run["task_ref"]));
    if (family === undefined) continue;
    const id = Number(run["id"]);
    if (paused.has(id)) { bump(family.repo, "paused"); continue; }
    if (run["role"] !== "builder") { bump(family.repo, "working"); continue; } // only builds are watched for quiet
    const facts = agentFactsFor(store, id, { repos: null }, account);
    if (facts === null || facts.outcome !== null) { bump(family.repo, "working"); continue; }
    const at = runActivityOf(store, { id, runner: String(run["runner"]), startedAt: String(run["started_at"]) }, now).at;
    const state = displayStateOf(factsOfAttempt(facts, at, false, now));
    if (state === "needs-you") { if (!needing.has(family.rootId)) { bump(family.repo, "needs-you"); needing.add(family.rootId); } else bump(family.repo, "working"); continue; }
    bump(family.repo, state === "stuck" ? "stuck" : "working");
  }

  // Flow cards waiting at a person's decision (an approval or a choice), in the flows this person may see: one uncapped
  // count per flow over its deciding zones.
  const repos = flowRepos ?? (access.repos ?? store.listProjects().map(one => one.path));
  const deciding = store.handle.prepare("SELECT COUNT(*) AS n FROM flow_card WHERE flow = ? AND state = 'active' AND stage IN (SELECT value FROM json_each(?))");
  for (const flow of store.listFlows(repos)) {
    const definition = flowDefinitionOf(flow);
    if (definition === null) continue;
    const zones = definition.stages.filter(one => one.kind === "approval" || one.kind === "choose").map(one => one.id);
    if (zones.length === 0) continue;
    const n = Number(deciding.get(flow.id, JSON.stringify(zones))?.["n"] ?? 0);
    for (let i = 0; i < n; i++) bump(flow.repo, "needs-you");
  }

  return [...counts.entries()].map(([repo, value]) => ({ repo, ...rollUp(value) }))
    .sort((a, b) => (a.repo ?? "").localeCompare(b.repo ?? ""));
}
