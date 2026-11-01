/**
 * The Agents view's Live grid (docs/plans/agents-view.md §1, §2.5): which agents are running now (every role) and
 * which ended in the last ten minutes, with the facts a tile shows. Store facts only — it verifies nothing, grants
 * nothing, and reads no live file; visibility is proved by the caller's `canSee` for each run.
 */
import { attemptKeyOf, agentNowForRun, openAgentQuestions } from "./agent-board.js";
import { agentsLiveRuns, type AgentsLiveRun, type Store } from "./store.js";

/** An ended agent stays on the grid this long, then leaves (it remains on the List). */
export const LIVE_ENDED_KEEP_MS = 10 * 60_000;

export type AgentLiveState = "working" | "needs-you" | "done" | "failed" | "stopped" | "parked";

export type AgentLiveTile = {
  runId: number;
  role: AgentsLiveRun["role"];
  taskId: string;
  title: string;
  project: string | null;
  agent: string;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  state: AgentLiveState;
  /** Why it needs you: it has been quiet (the board's Stuck rule) or it asked a question. */
  why: "quiet" | "question" | null;
  /** Since when it has been quiet, when that is why. */
  quietSince: string | null;
  /** Its output is on this computer (another runner's can't be read here). */
  local: boolean;
  /** A repair's build: the tile it nests under. */
  parentRun: number | null;
  /** The task's own page, for a task this console keeps (an outside tracker's task has none here). */
  taskHref: string | null;
};

const stateOf = (outcome: AgentsLiveRun["outcome"]): AgentLiveState =>
  outcome === null ? "working" : outcome === "built" || outcome === "no-change" ? "done" : outcome === "parked" ? "parked" : outcome === "interrupted" ? "stopped" : "failed";

/** The grid's tiles for one viewer: `canSee` is the caller's proof (ceiling and account access) for each run. */
export function agentsLiveOf(store: Store, now: Date, viewer: { canSee: (run: AgentsLiveRun) => boolean; localRunner: string | undefined }): AgentLiveTile[] {
  const tiles: AgentLiveTile[] = [];
  for (const run of agentsLiveRuns(store, new Date(now.getTime() - LIVE_ENDED_KEEP_MS))) {
    if (!viewer.canSee(run)) continue;
    let state = stateOf(run.outcome);
    let why: AgentLiveTile["why"] = null, quietSince: string | null = null;
    if (state === "working") {
      try {
        const key = attemptKeyOf(store, run.id);
        const facts = key === null ? null : agentNowForRun(store, run.id, key);
        if (run.role === "builder" && openAgentQuestions(store, run.taskRef).length > 0) why = "question";
        else if (facts !== null && facts.stuckAt !== null) { why = "quiet"; quietSince = facts.stuckAt; }
      } catch { /* display state: no word yet */ }
      if (why !== null) state = "needs-you";
    }
    tiles.push({
      runId: run.id, role: run.role, taskId: run.taskId, title: run.title, project: run.repo, agent: run.provider, model: run.model,
      startedAt: run.startedAt, endedAt: run.finishedAt, state, why, quietSince,
      local: viewer.localRunner !== undefined && run.runner === viewer.localRunner,
      parentRun: run.role === "repair" ? run.parentRun : null,
      taskHref: run.builtIn ? `/t/${encodeURIComponent(run.taskId)}` : null,
    });
  }
  return tiles;
}
