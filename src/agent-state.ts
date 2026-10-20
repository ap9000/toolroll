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
import { workStateRows } from "./work-index.js";
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
 * stopped or cancelled attempt is not a failure, a parked one is a decision only while its task is open, and one being
 * repaired is at work, not stuck. */
export function factsOfAttempt(facts: AgentFacts, activityAt: string | null, paused: boolean, now: Date): StateFacts {
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
  if (facts.outcome === "interrupted" || facts.outcome === "refused") return { activity: "stopped", outcome: "none", obligation: false, unread };
  if (facts.outcome === "parked") return { activity: "finished", outcome: "none", obligation: !settled, unread };
  // A failure on a task since settled (done another way, or cancelled) no longer leads.
  return { activity: "finished", outcome: settled ? "none" : "failed", obligation: false, unread };
}

/** A family's display state from the Tasks list's own classification (work-index.ts): failures that lead, what waits
 * on a person (a result to accept included), work running, work waiting its turn; a complete result is news only
 * until this person has seen it. */
const FAILED_CODES = new Set(["failed", "vanished-run", "result-needs-attention"]);
const WAITING_CODES = new Set(["queued", "planning-ready", "scouting-ready", "updating", "retry-scheduled", "waiting-dependency", "worker-at-capacity"]);

export type ProjectState = { repo: string | null; state: DisplayState; counts: StateCounts };

/** A project's states for one person: complete counts over every task family they may see (never a page or the board's
 * rows), each family once (its current version), plus flow cards waiting for a person's decision, plus attempts paused
 * or gone quiet. Every visible project is present, idle when nothing is counted. */
export function projectStates(store: Store, access: WorkSummaryAccess, account: string, now: Date, root?: string, flowRepos?: readonly string[]): ProjectState[] {
  const counts = new Map<string | null, StateCounts>();
  const bump = (repo: string | null, state: DisplayState) => {
    const current = counts.get(repo) ?? { ...NO_COUNTS };
    current[state] += 1;
    counts.set(repo, current);
  };
  for (const repo of access.repos ?? store.listProjects().map(one => one.path)) counts.set(repo, { ...NO_COUNTS });

  const live = workStateRows(store, now, access);
  const runs = [...new Set(live.flatMap(row => row.liveRun ?? row.unfinished ?? []))];
  const paused = new Set(runs.length === 0 ? [] : store.handle.prepare(`SELECT run FROM run_pause WHERE run IN (SELECT value FROM json_each(?))
      AND paused_at IS NOT NULL AND resumed_at IS NULL AND ended_at IS NULL`).all(JSON.stringify(runs)).map(row => Number(row["run"])));
  // Complete results that are news to this person: recorded since seeing was (a keyed attempt), and not yet seen. One read.
  const completed = JSON.stringify(live.flatMap(row => row.code === "complete" && row.resultRun !== null ? [row.resultRun] : []));
  const unseen = new Set(store.handle.prepare(`SELECT r.id FROM run r WHERE r.id IN (SELECT value FROM json_each(?)) AND r.attempt_key IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agent_seen s WHERE s.account = ? AND s.run = r.id)`).all(completed, account).map(row => Number(row["id"])));

  for (const row of live) {
    if (FAILED_CODES.has(row.code)) { bump(row.repo, "failed"); continue; }
    // A result waiting to be checked whose project checks failed is a failure, as its task's headline says (task-status.ts).
    if (row.code === "ready-to-check" && row.resultRun !== null && assignmentChecksForRun(store, root, row.resultRun, now).status === "failed") { bump(row.repo, "failed"); continue; }
    // Someone's lead took it on: it waits on nobody, and is at work.
    if (row.personNeed && !row.leadClaim) { bump(row.repo, "needs-you"); continue; }
    const run = row.liveRun ?? row.unfinished;
    if (row.code === "running" || row.code === "stopping" || row.leadClaim) {
      if (run !== null && paused.has(run)) { bump(row.repo, "paused"); continue; }
      const facts = run === null ? null : agentFactsFor(store, run, { repos: null }, account);
      if (facts !== null && facts.outcome === null) {
        const at = runActivityOf(store, { id: facts.runId, runner: facts.runner, startedAt: facts.startedAt }, now).at;
        bump(row.repo, displayStateOf(factsOfAttempt(facts, at, false, now)) === "stuck" ? "stuck" : "working");
      } else bump(row.repo, "working");
      continue;
    }
    if (WAITING_CODES.has(row.code)) { bump(row.repo, "waiting"); continue; }
    // Complete: news to this person until they have seen its result (an attempt from before seeing was recorded never is).
    if (row.code === "complete" && row.resultRun !== null && unseen.has(row.resultRun)) { bump(row.repo, "done"); continue; }
    if (!counts.has(row.repo)) counts.set(row.repo, { ...NO_COUNTS });
  }

  // Flow cards waiting at a person's decision (an approval or a choice), in the flows this person may see.
  const repos = flowRepos ?? (access.repos ?? store.listProjects().map(one => one.path));
  for (const flow of store.listFlows(repos)) {
    const definition = flowDefinitionOf(flow);
    if (definition === null) continue;
    const deciding = new Set(definition.stages.filter(one => one.kind === "approval" || one.kind === "choose").map(one => one.id));
    for (const card of store.flowCards(flow.id, false)) if (card.state === "active" && deciding.has(card.stage)) bump(flow.repo, "needs-you");
  }

  return [...counts.entries()].map(([repo, value]) => ({ repo, ...rollUp(value) }))
    .sort((a, b) => (a.repo ?? "").localeCompare(b.repo ?? ""));
}
