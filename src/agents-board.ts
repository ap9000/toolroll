/**
 * The Agents board's projection (one place to check on running agents): each
 * task's newest build attempt from the last day, in the viewer's admitted
 * projects, grouped Needs you, Working, Stuck, Done (not viewed yet), Idle.
 * A protocol repair never takes the row: while one runs, its parent's row says
 * "Fixing the handoff" and keeps the parent's transcript, changes and link.
 * Saved facts only (agent-board.ts, the run, its activity and its sealed diff
 * stats); nothing here verifies evidence or grants an action.
 */
import { quietSince, stuckSince, type AgentTurn, type ToolKind } from "./agent-board.js";
import { activityLine } from "./activity-line.js";
import type { AgentGroupKey, AgentLaneWindow, BrowserAgentLane, BrowserAgentLanes, BrowserAgentRow, BrowserLaneSegment } from "./browser-workspace.js";
import { readVerifiedArtifact } from "./evidence.js";
import { failedAttemptSentence } from "./needs-you.js";
import { projectName } from "./project.js";
import { providerName } from "./provider-auth.js";
import type { Store } from "./store.js";
import { runActivityOf } from "./task-activity.js";

export const AGENT_GROUPS: readonly { key: AgentGroupKey; label: string }[] = [
  { key: "needs-you", label: "Needs you" },
  { key: "working", label: "Working" },
  { key: "stuck", label: "Stuck" },
  { key: "done", label: "Done" },
  { key: "idle", label: "Idle" },
];
/** Finished attempts stay on the board this long; unread Done and Needs you stay three days. */
const RECENT_MS = 24 * 60 * 60_000;
const KEPT_MS = 3 * RECENT_MS;
const BOARD_LIMIT = 80;

type Row = Record<string, unknown>;
const str = (row: Row, key: string): string | null => row[key] == null ? null : String(row[key]);

export type AgentFacts = {
  runId: number; taskRef: number; taskId: string; title: string; repo: string | null; provider: string; runner: string;
  outcome: string | null; reason: string | null; startedAt: string; finishedAt: string | null; legacy: boolean; taskState: string;
  turn: AgentTurn | null; stateAt: string | null; transcriptAt: string | null; stuckAt: string | null;
  said: string | null; saidNote: string | null; saidAt: string | null; diffFiles: number | null;
  toolKind: ToolKind | null; toolAt: string | null; phase: string | null;
  /** The note the board shows once the agent asked past the questions cap. */
  questionNote: string | null;
  /** A protocol repair of this attempt is running now. */
  repairing: boolean;
  question: { id: number; key: string; text: string } | null; seen: boolean;
};

const FACTS = `SELECT r.id, r.task_ref, r.provider, r.runner, r.outcome, r.reason, r.started_at, r.finished_at, r.phase, r.attempt_key IS NULL AS legacy,
    tr.external_id AS task_id, tr.repo, t.title, t.state AS task_state,
    n.state AS turn, n.state_at, n.transcript_at, n.stuck_at, n.said, n.said_note, n.said_at, n.diff_files, n.tool_kind, n.tool_at, n.question_note,
    EXISTS (SELECT 1 FROM run p WHERE p.parent_run = r.id AND p.role = 'repair' AND p.outcome IS NULL) AS repairing,
    (SELECT json_object('id', q.id, 'key', q.key, 'text', q.question) FROM agent_question q
      WHERE q.run = r.id AND q.closed_at IS NULL AND q.attempt_key = r.attempt_key ORDER BY q.id LIMIT 1) AS question,
    EXISTS (SELECT 1 FROM agent_seen s WHERE s.account = $account AND s.run = r.id) AS seen
  FROM run r
  JOIN task_ref tr ON tr.id = r.task_ref AND tr.backend = 'built-in' AND tr.repo IS NOT NULL
  JOIN task t ON t.id = tr.external_id
  LEFT JOIN agent_now n ON n.task_ref = r.task_ref AND n.run = r.id AND n.attempt_key = r.attempt_key
  WHERE r.role = 'builder'`;

function readFacts(row: Row): AgentFacts {
  let question: AgentFacts["question"] = null;
  try {
    const parsed = row["question"] == null ? null : JSON.parse(String(row["question"])) as { id: number; key: string; text: string };
    question = parsed === null ? null : { id: Number(parsed.id), key: String(parsed.key), text: String(parsed.text) };
  } catch { question = null; }
  return {
    runId: Number(row["id"]), taskRef: Number(row["task_ref"]), taskId: String(row["task_id"]), title: String(row["title"]), repo: str(row, "repo"),
    provider: String(row["provider"] ?? "claude"), runner: String(row["runner"]), outcome: str(row, "outcome"), reason: str(row, "reason"),
    startedAt: String(row["started_at"]), finishedAt: str(row, "finished_at"), legacy: Number(row["legacy"]) === 1, taskState: String(row["task_state"]),
    turn: str(row, "turn") as AgentTurn | null, stateAt: str(row, "state_at"), transcriptAt: str(row, "transcript_at"), stuckAt: str(row, "stuck_at"),
    said: str(row, "said"), saidNote: str(row, "said_note"), saidAt: str(row, "said_at"), diffFiles: row["diff_files"] == null ? null : Number(row["diff_files"]),
    toolKind: str(row, "tool_kind") as ToolKind | null, toolAt: str(row, "tool_at"), phase: str(row, "phase"), questionNote: str(row, "question_note"), repairing: Number(row["repairing"]) === 1,
    question, seen: Number(row["seen"]) === 1,
  };
}

/**
 * The board's candidate builds, through the partial indexes (agent_board_open, agent_board_recent): open ones and
 * those finished since $kept, one per task (its newest), never a scan of every run. A candidate a newer build of the
 * same task has replaced is dropped by an indexed probe, so the row is still the task's newest build.
 */
export const BOARD_CANDIDATES = `WITH candidate AS (
    SELECT task_ref, id FROM run WHERE role = 'builder' AND outcome IS NULL
    UNION ALL
    SELECT task_ref, id FROM run WHERE role = 'builder' AND outcome IS NOT NULL AND finished_at >= $kept
  ), newest AS (SELECT task_ref, MAX(id) AS id FROM candidate GROUP BY task_ref)`;

/** The board's candidate attempts: each task's newest build, open or recently finished, in the admitted projects. */
export function agentFacts(store: Store, now: Date, access: { repos: readonly string[] | null }, account: string): AgentFacts[] {
  return store.handle.prepare(agentFactsSql())
    .all({ $account: account, $kept: new Date(now.getTime() - KEPT_MS).toISOString(), $all: access.repos === null ? 1 : 0, $repos: JSON.stringify(access.repos ?? []) })
    .map(readFacts);
}

/** The board's query, exported for its query-plan test. */
export function agentFactsSql(): string {
  return `${BOARD_CANDIDATES}
    ${FACTS.replace("FROM run r", "FROM newest c JOIN run r ON r.id = c.id")}
      AND NOT EXISTS (SELECT 1 FROM run x WHERE x.task_ref = r.task_ref AND x.role = 'builder' AND x.id > r.id)
      AND NOT EXISTS (SELECT 1 FROM task_ref c WHERE c.backend = tr.backend AND c.revision_of = tr.external_id AND c.repo IS tr.repo)
      AND ($all = 1 OR tr.repo IN (SELECT value FROM json_each($repos)))
    ORDER BY r.id DESC LIMIT ${BOARD_LIMIT}`;
}

/** One exact build attempt, whatever its age (the opened row), in the admitted projects: a repair opens as its parent. */
export function agentFactsFor(store: Store, run: number, access: { repos: readonly string[] | null }, account: string): AgentFacts | null {
  const row = store.handle.prepare(`${FACTS} AND r.id = (SELECT CASE WHEN role = 'repair' AND parent_run IS NOT NULL THEN parent_run ELSE id END FROM run WHERE id = $run) AND ($all = 1 OR tr.repo IN (SELECT value FROM json_each($repos)))`)
    .get({ $account: account, $run: run, $all: access.repos === null ? 1 : 0, $repos: JSON.stringify(access.repos ?? []) });
  return row === undefined ? null : readFacts(row);
}

const FINISHED_WELL = new Set(["built", "no-change"]);
const SETTLED_TASK = new Set(["done", "cancelled"]);

/** Where an attempt sits on the board, and its one state word. Stuck is worked out from the facts now, so fresh
 * transcript or activity clears it at once (the pulse's saved mark only tells open boards it crossed). */
export function agentGroupOf(facts: AgentFacts, activityAt: string | null, now: Date): { group: AgentGroupKey; label: string } {
  if (facts.outcome === null) {
    if (facts.question !== null) return { group: "needs-you", label: "Question" };
    if (facts.repairing) return { group: "working", label: "Working" };
    if (facts.turn === "crashed") return { group: "needs-you", label: "Stopped unexpectedly" };
    if (facts.said === "blocked" && facts.turn !== "idle") return { group: "needs-you", label: "Blocked" };
    if (facts.turn === "busy" && stuckSince({ state: "busy", stateAt: facts.stateAt ?? facts.startedAt, transcriptAt: facts.transcriptAt ?? facts.startedAt, toolAt: facts.toolAt },
      activityAt, now) !== null) {
      return { group: "stuck", label: "Stuck" };
    }
    // Its turn has its result, but the build is still capturing and checking it: still at work, not idle.
    return { group: "working", label: "Working" };
  }
  if (FINISHED_WELL.has(facts.outcome)) {
    const label = facts.outcome === "built" ? "Done" : "No changes";
    // Unread only for attempts the board saw start: a run from before it never counts as news.
    return { group: facts.seen || facts.legacy ? "idle" : "done", label };
  }
  if (SETTLED_TASK.has(facts.taskState)) return { group: "idle", label: facts.outcome === "interrupted" ? "Stopped" : "Failed" };
  return { group: "needs-you", label: facts.outcome === "parked" ? "Needs a decision" : facts.outcome === "interrupted" ? "Stopped" : facts.outcome === "refused" ? "Not started" : "Failed" };
}

type DiffSummary = { fileCount: number; additions: number; deletions: number; files: { path: string; additions: number | null; deletions: number | null }[] };
const sealed = new Map<number, DiffSummary | null>();

/** A finished attempt's sealed diff stats (cached by artifact: sealed bytes never change). */
export function sealedDiffOf(store: Store, root: string | undefined, run: number): DiffSummary | null {
  if (root === undefined) return null;
  const artifact = store.artifactsFor(run).find(one => one.kind === "diff-stat");
  if (artifact === undefined || artifact.captureStatus !== "ok") return null;
  if (sealed.has(artifact.id)) return sealed.get(artifact.id) ?? null;
  let summary: DiffSummary | null = null;
  try {
    const read = readVerifiedArtifact(root, artifact);
    if (read.ok) {
      const stat = JSON.parse(read.content.toString("utf8")) as { fileCount?: unknown; additions?: unknown; deletions?: unknown; files?: unknown };
      const files = Array.isArray(stat.files) ? (stat.files as Record<string, unknown>[]).filter(one => typeof one?.["path"] === "string").map(one => ({
        path: String(one["path"]), additions: typeof one["additions"] === "number" ? one["additions"] : null, deletions: typeof one["deletions"] === "number" ? one["deletions"] : null })) : [];
      summary = { fileCount: Number(stat.fileCount ?? files.length) || 0, additions: Number(stat.additions ?? 0) || 0, deletions: Number(stat.deletions ?? 0) || 0, files };
    }
  } catch { summary = null; }
  if (sealed.size > 500) sealed.clear();
  sealed.set(artifact.id, summary);
  return summary;
}

const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

/** A row's diff size: the sealed stats once finished, the pulse's count while it runs. */
export function diffWords(facts: AgentFacts, diff: DiffSummary | null): string | null {
  if (facts.outcome !== null) {
    if (diff === null) return null;
    if (diff.fileCount === 0) return "No changes";
    return `+${diff.additions} −${diff.deletions} · ${files(diff.fileCount)}`;
  }
  if (facts.diffFiles === null) return null;
  return facts.diffFiles === 0 ? "No changes yet" : `${files(facts.diffFiles)} changed`;
}

const SETTLING_PHASES = new Set(["validating-handoff", "capturing-evidence", "committing", "verifying-proof", "correcting-proof"]);
/** Reasons whose words only restate the Failed chip: the row shows the agent's own last word instead, or nothing. */
const RESTATES_FAILED = new Set(["agent"]);
const minutes = (ms: number) => Math.max(1, Math.floor(ms / 60_000));

/** A finished attempt's one line: never the state again (the chip says it), only why. */
function endedLine(facts: AgentFacts): string | null {
  const own = facts.said === "blocked" || facts.said === "done" ? facts.saidNote : null;
  if (FINISHED_WELL.has(facts.outcome ?? "")) return facts.said === "done" ? facts.saidNote : null;
  if (facts.outcome === "parked") return "Stopped to ask a question";
  if (RESTATES_FAILED.has(facts.reason?.trim() ?? "")) return own;
  return failedAttemptSentence(facts.reason);
}

/** One board row. */
export function agentRowOf(store: Store, facts: AgentFacts, now: Date, root?: string): BrowserAgentRow {
  const activity = facts.outcome === null ? runActivityOf(store, { id: facts.runId, runner: facts.runner, startedAt: facts.startedAt }, now) : null;
  const { group, label } = agentGroupOf(facts, activity?.at ?? null, now);
  let line: string | null, quiet = false;
  if (facts.outcome !== null) line = endedLine(facts);
  else if (facts.question !== null) line = facts.question.text;
  else if (facts.repairing) line = "Fixing the handoff";
  else if (group === "stuck") line = `No new output for ${Math.max(4, minutes(now.getTime() - quietSince({ stateAt: facts.stateAt ?? facts.startedAt, transcriptAt: facts.transcriptAt ?? facts.startedAt, toolAt: facts.toolAt }, activity!.at)))} min`;
  else if (facts.turn === "idle" || (facts.turn !== "crashed" && SETTLING_PHASES.has(facts.phase ?? ""))) line = "Checking the result";
  else if (facts.turn === "busy" && facts.toolAt !== null && now.getTime() - Date.parse(facts.toolAt) >= 60_000) {
    line = `${facts.toolKind === "command" ? "Running a command" : "Waiting on a tool"} · ${minutes(now.getTime() - Date.parse(facts.toolAt))} min`;
  } else {
    const said = facts.saidNote !== null && facts.saidAt !== null && facts.saidAt >= activity!.at ? facts.saidNote : null;
    const read = activityLine(activity!, now.getTime());
    line = said ?? read.text;
    quiet = said === null && read.quiet;
  }
  return {
    runId: facts.runId, taskId: facts.taskId, title: facts.title, project: facts.repo === null ? null : projectName(facts.repo), href: `/agents?run=${facts.runId}`,
    group, label, line, quiet, startedAt: facts.startedAt, endedAt: facts.finishedAt,
    diff: diffWords(facts, facts.outcome === null ? null : sealedDiffOf(store, root, facts.runId)), agent: providerName(facts.provider),
  };
}

/** The whole board: groups in order, rows newest first within each; empty groups dropped. */
export function agentsBoardOf(store: Store, now: Date, access: { repos: readonly string[] | null }, account: string, root?: string): { key: AgentGroupKey; label: string; rows: BrowserAgentRow[] }[] {
  const recent = new Date(now.getTime() - RECENT_MS).toISOString();
  const rows = agentFacts(store, now, access, account).map(facts => ({ facts, row: agentRowOf(store, facts, now, root) }))
    .filter(({ facts, row }) => facts.outcome === null || row.group === "done" || row.group === "needs-you" || (facts.finishedAt ?? "") >= recent)
    .map(({ row }) => row);
  return AGENT_GROUPS.map(group => ({ ...group, rows: rows.filter(row => row.group === group.key) })).filter(group => group.rows.length > 0);
}

/** A board fingerprint for one exact build: what its open view shows moved, its repairs included. */
export function agentRunFingerprint(store: Store, run: number): string | null {
  const row = store.handle.prepare(`SELECT r.outcome, r.finished_at, r.phase, n.state, n.state_at, n.transcript_bytes, n.stuck_at, n.said_at, n.diff_files, n.tool_at, n.question_note,
      (SELECT count(*) || ':' || coalesce(max(id), 0) || ':' || coalesce(sum(closed_at IS NULL), 0) FROM agent_question WHERE run = r.id) AS asks,
      (SELECT count(*) || ':' || coalesce(max(id), 0) || ':' || coalesce(sum(outcome IS NULL), 0) FROM run p WHERE p.parent_run = r.id AND p.role = 'repair') AS repairs,
      (SELECT at FROM run_activity WHERE run = r.id) AS activity,
      (SELECT count(*) || ':' || coalesce(max(id), 0) FROM task_steer WHERE task_ref = r.task_ref) AS steer
    FROM run r LEFT JOIN agent_now n ON n.run = r.id AND n.attempt_key = r.attempt_key WHERE r.id = ?`).get(run);
  return row === undefined ? null : Object.values(row).map(value => String(value)).join("|");
}


/** The timeline's windows, all rolling (so no server time zone decides what "today" means); two hours by default. */
export const LANE_WINDOWS: readonly { key: AgentLaneWindow; label: string }[] = [{ key: "30m", label: "30m" }, { key: "2h", label: "2h" }, { key: "24h", label: "24h" }];
/** Rows the timeline shows: twenty running tasks read as twelve rows and a count, not a wall. */
export const LANE_ROWS = 12;
/** The board's own order (AGENT_GROUPS), with planning beside working. */
const LANE_ORDER: readonly (AgentGroupKey | "planning")[] = ["needs-you", "working", "planning", "stuck", "done", "idle"];
/** A run is found by its start: one that began up to a day before the window and ended inside it still shows. Every
 * window is at most a day, and no agent run is allowed to outlast that, so the start range covers the window. */
const LANE_LOOKBACK_MS = 24 * 60 * 60_000;
/** Runs read for one timeline at most; past it the oldest are left out and the count says so. */
const LANE_RUNS = 5000;
const WINDOW_MS: Record<AgentLaneWindow, number> = { "30m": 30 * 60_000, "2h": 2 * 60 * 60_000, "24h": 24 * 60 * 60_000 };

export function laneWindowOf(value: string | null): AgentLaneWindow {
  return value === "30m" || value === "24h" ? value : "2h";
}

export function laneSinceOf(window: AgentLaneWindow, now: Date): Date {
  return new Date(now.getTime() - WINDOW_MS[window]);
}

/** The timeline's runs. The candidates come from two bounded index ranges (run_started for runs begun since the
 * lookback; work_unfinished, named so SQLite never walks every run's index, for anything still running) and drive the join (CROSS JOIN keeps SQLite from starting at
 * the task and walking its whole history), in the admitted projects only. */
export function agentLanesSql(): string {
  return `WITH candidate AS (
      SELECT DISTINCT id FROM (
        SELECT id FROM run WHERE started_at >= $lookback
        UNION ALL SELECT id FROM run INDEXED BY work_unfinished WHERE outcome IS NULL
      )
    )
    SELECT r.id, r.role, r.provider, r.outcome, r.started_at, r.finished_at, tr.external_id AS task_id, tr.repo, t.title
    FROM candidate c CROSS JOIN run r ON r.id = c.id
    CROSS JOIN task_ref tr ON tr.id = r.task_ref AND tr.backend = 'built-in' AND tr.repo IS NOT NULL
    CROSS JOIN task t ON t.id = tr.external_id
    WHERE r.role IN ('planner', 'builder', 'repair', 'reviewer', 'scout')
      AND (r.outcome IS NULL OR r.finished_at >= $since)
      AND ($all = 1 OR tr.repo IN (SELECT value FROM json_each($repos)))
    ORDER BY r.started_at DESC, r.id DESC LIMIT ${LANE_RUNS}`;
}

/** The timeline: one row per task that ran in the window, in the board's order (needs you first, then the newest), the
 * first LANE_ROWS of them; the counts cover every task in the window, not just the rows shown. A task's place comes
 * from its board row; one with only a planner running is planning, otherwise idle. */
export function agentLanesOf(store: Store, now: Date, access: { repos: readonly string[] | null }, board: readonly { rows: readonly BrowserAgentRow[] }[], window: AgentLaneWindow, path = "/agents"): BrowserAgentLanes | null {
  const since = laneSinceOf(window, now);
  const rows = store.handle.prepare(agentLanesSql()).all({
    $lookback: new Date(since.getTime() - LANE_LOOKBACK_MS).toISOString(), $since: since.toISOString(),
    $all: access.repos === null ? 1 : 0, $repos: JSON.stringify(access.repos ?? []),
  });
  const placed = new Map<string, AgentGroupKey>();
  for (const group of board) for (const row of group.rows) if (!placed.has(row.taskId)) placed.set(row.taskId, row.group);
  const lanes = new Map<string, BrowserAgentLane>();
  // Newest first from the query; each lane's segments go back into start order below.
  for (const row of rows) {
    const taskId = String(row["task_id"]);
    const role = String(row["role"]);
    const segment: BrowserLaneSegment = {
      runId: Number(row["id"]), role: role === "repair" ? "builder" : role as BrowserLaneSegment["role"], agent: providerName(String(row["provider"] ?? "claude")),
      startedAt: String(row["started_at"]), endedAt: str(row, "finished_at"), outcome: str(row, "outcome"),
      href: role === "builder" ? `/agents?run=${Number(row["id"])}` : `/r/${Number(row["id"])}`,
    };
    const lane = lanes.get(taskId) ?? { taskId, title: String(row["title"]), project: str(row, "repo") === null ? null : projectName(str(row, "repo")!),
      href: `/t/${encodeURIComponent(taskId)}`, group: placed.get(taskId) ?? "idle", segments: [] };
    lane.segments.push(segment);
    lanes.set(taskId, lane);
  }
  if (lanes.size === 0) return null;
  for (const lane of lanes.values()) {
    lane.segments.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId - b.runId);
    if (!placed.has(lane.taskId) && lane.segments.some(one => one.role === "planner" && one.endedAt === null)) lane.group = "planning";
  }
  // Within a group, the task whose newest run started last comes first (the run id breaks a tie).
  const newest = (lane: BrowserAgentLane) => lane.segments[lane.segments.length - 1]!;
  const ordered = [...lanes.values()].sort((a, b) => LANE_ORDER.indexOf(a.group) - LANE_ORDER.indexOf(b.group)
    || newest(b).startedAt.localeCompare(newest(a).startedAt) || newest(b).runId - newest(a).runId);
  return {
    since: since.toISOString(), now: now.toISOString(),
    windows: LANE_WINDOWS.map(one => ({ ...one, href: `${path}?window=${one.key}`, active: one.key === window })),
    lanes: ordered.slice(0, LANE_ROWS), more: Math.max(0, ordered.length - LANE_ROWS),
    running: ordered.filter(lane => lane.segments.some(one => one.endedAt === null)).length,
    needsYou: ordered.filter(lane => lane.group === "needs-you").length,
    truncated: rows.length >= LANE_RUNS,
  };
}
