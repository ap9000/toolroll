/**
 * One set of agent states (docs/plans/agents-cockpit.md §1): what a person sees at a glance for an attempt, a task, a
 * flow or a project. A display state is derived from four separate facts — what the agent is doing, how it ended, what
 * someone must do, and whether this person has seen it — and never stored as one. Looking clears only `done`: a failure,
 * an approval or a result to accept stays until it is dealt with. The words and colours of each state live here only.
 */
import { agentFacts, agentGroupOf, type AgentFacts } from "./agents-board.js";
import { stuckSince } from "./agent-board.js";
import type { Store } from "./store.js";
import { runActivityOf } from "./task-activity.js";

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

/** The four facts of one build attempt, from what the Agents board reads (agents-board.ts). */
export function factsOfAttempt(facts: AgentFacts, activityAt: string | null, paused: boolean, now: Date): StateFacts {
  const { group } = agentGroupOf(facts, activityAt, now);
  const outcome: Outcome = facts.outcome === null ? "none" : facts.outcome === "built" ? "built" : facts.outcome === "no-change" ? "no-change" : "failed";
  if (facts.outcome === null) {
    const stuck = facts.turn === "busy" && stuckSince({ state: "busy", stateAt: facts.stateAt ?? facts.startedAt, transcriptAt: facts.transcriptAt ?? facts.startedAt, toolAt: facts.toolAt }, activityAt, now) !== null;
    // An open run asking, crashed or blocked is the board's "needs you": an obligation, not a mood.
    return { activity: paused ? "paused" : stuck ? "stuck" : "running", outcome, obligation: group === "needs-you", unread: false };
  }
  // A finished attempt the board places under "needs you" (parked, failed on an unsettled task) carries an
  // obligation only when it is a decision; a plain failure is a failure, which leads by its own rule.
  const obligation = facts.outcome === "parked";
  return { activity: "finished", outcome, obligation, unread: !(facts.seen || facts.legacy) };
}

/** A project's states for one person: complete counts from their own queries (never the board's capped rows), in the
 * projects they may see. Tasks count once (their current version); obligations count each; attempts count each. */
export type ProjectState = { repo: string; state: DisplayState; counts: StateCounts };

export function projectStates(store: Store, access: { repos: readonly string[] | null }, account: string, now: Date): ProjectState[] {
  const admitted = access.repos;
  const inScope = (repo: string | null) => repo !== null && (admitted === null || admitted.includes(repo));
  const counts = new Map<string, StateCounts>();
  const bump = (repo: string | null, state: DisplayState, by = 1) => {
    if (!inScope(repo) || by === 0) return;
    const current = counts.get(repo!) ?? { ...NO_COUNTS };
    current[state] += by;
    counts.set(repo!, current);
  };
  const all = (sql: string, ...params: unknown[]) => store.handle.prepare(sql).all(...params);

  // Obligations: open decisions, scopes waiting for approval, open agent questions, cancelled blockers of queued work.
  for (const row of all(`SELECT tr.repo, COUNT(*) AS n FROM decision d JOIN run r ON r.id = d.run JOIN task_ref tr ON tr.id = r.task_ref
      WHERE d.state IN ('open','expired') GROUP BY tr.repo`)) bump(row["repo"] as string | null, "needs-you", Number(row["n"]));
  for (const row of all(`SELECT tr.repo, COUNT(*) AS n FROM task_scope s JOIN task t ON t.id = s.task_id
      JOIN task_ref tr ON tr.backend = 'built-in' AND tr.external_id = t.id
      WHERE t.state IN ('queued','running') AND (s.approved_at IS NULL OR s.approved_by IS NULL OR s.approved_digest IS NULL OR s.approved_digest != s.digest)
      GROUP BY tr.repo`)) bump(row["repo"] as string | null, "needs-you", Number(row["n"]));
  for (const row of all(`SELECT tr.repo, COUNT(*) AS n FROM agent_question q JOIN run r ON r.id = q.run JOIN task_ref tr ON tr.id = q.task_ref
      WHERE q.closed_at IS NULL AND r.outcome IS NULL AND q.attempt_key = r.attempt_key GROUP BY tr.repo`)) bump(row["repo"] as string | null, "needs-you", Number(row["n"]));
  for (const row of all(`SELECT tr.repo, COUNT(DISTINCT e.blocker) AS n FROM task_edge e
      JOIN task b ON b.id = e.blocker AND b.state = 'cancelled' JOIN task d ON d.id = e.blocked AND d.state = 'queued'
      JOIN task_ref tr ON tr.backend = 'built-in' AND tr.external_id = e.blocked GROUP BY tr.repo`)) bump(row["repo"] as string | null, "needs-you", Number(row["n"]));

  // Failures that lead: a failed task, or one with an unresolved incident, that nothing is working on now.
  for (const row of all(`SELECT tr.repo, COUNT(*) AS n FROM task t JOIN task_ref tr ON tr.backend = 'built-in' AND tr.external_id = t.id
      WHERE (t.state = 'failed' OR EXISTS (SELECT 1 FROM incident i JOIN run r ON r.id = i.run WHERE r.task_ref = tr.id AND i.resolved_at IS NULL))
        AND NOT EXISTS (SELECT 1 FROM run r WHERE r.task_ref = tr.id AND r.outcome IS NULL)
        AND NOT EXISTS (SELECT 1 FROM task_ref c WHERE c.backend = tr.backend AND c.revision_of = tr.external_id)
      GROUP BY tr.repo`)) bump(row["repo"] as string | null, "failed", Number(row["n"]));

  // Attempts running now, every role: stuck, paused or working, from each open run's own facts.
  const paused = new Set(all(`SELECT run FROM run_pause WHERE paused_at IS NOT NULL AND resumed_at IS NULL AND ended_at IS NULL`).map(row => Number(row["run"])));
  const openBuilds = new Map(agentFacts(store, now, access, account).filter(one => one.outcome === null).map(one => [one.runId, one]));
  for (const row of all(`SELECT r.id, r.role, r.runner, r.started_at, tr.repo FROM run r JOIN task_ref tr ON tr.id = r.task_ref
      WHERE r.outcome IS NULL AND r.role IN ('planner','builder','scout','reviewer','repair')`)) {
    const id = Number(row["id"]), repo = row["repo"] as string | null;
    if (paused.has(id)) { bump(repo, "paused"); continue; }
    const build = openBuilds.get(id);
    if (build === undefined) { bump(repo, "working"); continue; }
    const at = runActivityOf(store, { id, runner: String(row["runner"]), startedAt: String(row["started_at"]) }, now).at;
    const facts = factsOfAttempt(build, at, false, now);
    // An open build asking or blocked is already counted as an obligation (its question); the attempt itself works on.
    bump(repo, facts.activity === "stuck" ? "stuck" : "working");
  }

  // Work waiting its turn: approved, queued, nothing running.
  for (const row of all(`SELECT tr.repo, COUNT(*) AS n FROM task t JOIN task_ref tr ON tr.backend = 'built-in' AND tr.external_id = t.id
      JOIN task_scope s ON s.task_id = t.id
      WHERE t.state = 'queued' AND s.approved_digest IS NOT NULL AND s.approved_digest = s.digest
        AND NOT EXISTS (SELECT 1 FROM run r WHERE r.task_ref = tr.id AND r.outcome IS NULL)
      GROUP BY tr.repo`)) bump(row["repo"] as string | null, "waiting", Number(row["n"]));

  // Finished well and not yet seen by this person: each task's newest build, from the board's own candidates.
  for (const facts of agentFacts(store, now, access, account)) {
    if (facts.outcome === null) continue;
    const state = displayStateOf(factsOfAttempt(facts, null, false, now));
    if (state === "done") bump(facts.repo, "done");
  }

  return [...counts.entries()].map(([repo, value]) => ({ repo, ...rollUp(value) })).sort((a, b) => a.repo.localeCompare(b.repo));
}
