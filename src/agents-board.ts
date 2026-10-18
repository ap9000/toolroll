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
/** Runs are found by their start back this far; a builder that finished in the window is also found by its finish
 * (agent_board_recent), however long it ran. A planner, review, scout or repair run that lasted over a day and ended
 * in the window is the one case left out: finding it would need a finish-time index over every role. */
const LANE_LOOKBACK_MS = 24 * 60 * 60_000;
const WINDOW_MS: Record<AgentLaneWindow, number> = { "30m": 30 * 60_000, "2h": 2 * 60 * 60_000, "24h": 24 * 60 * 60_000 };
const LANE_ROLES = "('planner', 'builder', 'repair', 'reviewer', 'scout')";

export function laneWindowOf(value: string | null): AgentLaneWindow {
  return value === "30m" || value === "24h" ? value : "2h";
}

export function laneSinceOf(window: AgentLaneWindow, now: Date): Date {
  return new Date(now.getTime() - WINDOW_MS[window]);
}

/** The window's tasks, one row each with whether a run is live and when it was last active, newest activity first,
 * and the total and running counts over all of them. The candidates come from bounded index ranges (run_started;
 * work_unfinished and agent_board_recent, named so SQLite never walks every run) and drive the join (CROSS JOIN), so no
 * task's history is walked; the admitted projects only. */
export function agentLanesSql(): string {
  return `WITH candidate AS (
      SELECT DISTINCT id FROM (
        SELECT id FROM run WHERE started_at >= $lookback
        UNION ALL SELECT id FROM run INDEXED BY work_unfinished WHERE outcome IS NULL
        UNION ALL SELECT id FROM run INDEXED BY agent_board_recent WHERE role = 'builder' AND outcome IS NOT NULL AND finished_at >= $since
      )
    ), active AS (
      SELECT r.task_ref, tr.external_id AS task_id, tr.repo, t.title,
        MAX(r.outcome IS NULL) AS live, MAX(coalesce(r.finished_at, $now)) AS last_at, MAX(r.id) AS last_run, MIN(CASE WHEN r.outcome IS NOT NULL THEN r.id END) AS first_done
      FROM candidate c CROSS JOIN run r ON r.id = c.id
      CROSS JOIN task_ref tr ON tr.id = r.task_ref AND tr.backend = 'built-in' AND tr.repo IS NOT NULL
      CROSS JOIN task t ON t.id = tr.external_id
      WHERE r.role IN ${LANE_ROLES} AND (r.outcome IS NULL OR r.finished_at >= $since)
        AND ($all = 1 OR tr.repo IN (SELECT value FROM json_each($repos)))
      GROUP BY r.task_ref
    )
    SELECT a.*, (SELECT count(*) FROM active) AS total, (SELECT coalesce(sum(live), 0) FROM active) AS running
    FROM active a ORDER BY a.live DESC, a.last_at DESC, a.last_run DESC LIMIT $rows`;
}

/** Segments one row keeps: its newest runs, so a task retried all day stays one readable row. */
export const LANE_SEGMENTS = 40;
/** One chosen task's live runs: all of them, through work_unfinished, so no cap can hide one. */
export function laneLiveRunsSql(): string {
  return `SELECT id, role, provider, outcome, started_at, finished_at FROM run INDEXED BY work_unfinished
    WHERE task_ref = $ref AND outcome IS NULL AND role IN ${LANE_ROLES}`;
}
/** Rows one task's lookups read at most, newest first: a task with thousands of runs costs the same as one with a few. */
export const LANE_TASK_READ = 2000;
/** One chosen task's runs that finished in the window: a seek on its own runs from its first finished run in the
 * window (lead_status_task_run), reading at most LANE_TASK_READ of its newest runs; the newest LANE_SEGMENTS. */
export function laneRunsSql(): string {
  return `SELECT id, role, provider, outcome, started_at, finished_at FROM (
      SELECT id, role, provider, outcome, started_at, finished_at FROM run WHERE task_ref = $ref AND id >= $from ORDER BY id DESC LIMIT ${LANE_TASK_READ}
    ) WHERE outcome IS NOT NULL AND finished_at >= $since AND role IN ${LANE_ROLES}
    ORDER BY id DESC LIMIT ${LANE_SEGMENTS}`;
}
/** A task's newest build, whenever it ran, among its newest 500 runs: the row's state comes from it even when it
 * finished before the window. A task with more runs than that since its last build reads as planning or idle. */
export function laneNewestBuildSql(): string {
  return `SELECT id FROM (SELECT id, role FROM run WHERE task_ref = $ref ORDER BY id DESC LIMIT 500) WHERE role = 'builder' LIMIT 1`;
}

/** The timeline: one row per task that ran in the window, running ones first, then the most recently active, the
 * first LANE_ROWS of them; the counts cover every task in the window. A row's state is worked out from its own
 * newest build as the board would (planning while only a planner runs, otherwise idle). With nothing in the window but something in the last day,
 * the timeline stays (empty) so its window choice does too; with nothing in a day it is null. */
export function agentLanesOf(store: Store, now: Date, access: { repos: readonly string[] | null }, account: string, window: AgentLaneWindow, path = "/agents"): BrowserAgentLanes | null {
  const read = (since: Date, rows: number) => store.handle.prepare(agentLanesSql()).all({
    $lookback: new Date(since.getTime() - LANE_LOOKBACK_MS).toISOString(), $since: since.toISOString(), $now: now.toISOString(),
    $all: access.repos === null ? 1 : 0, $repos: JSON.stringify(access.repos ?? []), $rows: rows,
  });
  const since = laneSinceOf(window, now);
  const tasks = read(since, LANE_ROWS);
  if (tasks.length === 0 && (window === "24h" || read(laneSinceOf("24h", now), 1).length === 0)) return null;
  const doneOf = store.handle.prepare(laneRunsSql()), liveOf = store.handle.prepare(laneLiveRunsSql()), newestBuildOf = store.handle.prepare(laneNewestBuildSql());
  const lanes: BrowserAgentLane[] = tasks.map(row => {
    const ref = Number(row["task_ref"]);
    const taskId = String(row["task_id"]);
    const done = row["first_done"] == null ? [] : doneOf.all({ $ref: ref, $from: Number(row["first_done"]), $since: since.toISOString() });
    const runs = [...liveOf.all({ $ref: ref }), ...done].sort((a, b) => Number(a["id"]) - Number(b["id"]));
    const segments: BrowserLaneSegment[] = runs.map(run => {
      const role = String(run["role"]);
      return {
        runId: Number(run["id"]), role: role === "repair" ? "builder" : role as BrowserLaneSegment["role"], agent: providerName(String(run["provider"] ?? "claude")),
        startedAt: String(run["started_at"]), endedAt: str(run, "finished_at"), outcome: str(run, "outcome"),
        href: role === "builder" ? `/agents?run=${Number(run["id"])}` : `/r/${Number(run["id"])}`,
      };
    });
    // The row's state from the task's own newest build, as the board would place it (never the board's capped list),
    // even when that build finished before the window.
    const build = newestBuildOf.get({ $ref: ref });
    const facts = build === undefined ? null : agentFactsFor(store, Number(build["id"]), access, account);
    const group: BrowserAgentLane["group"] = facts !== null ? agentGroupOf(facts, facts.outcome === null ? runActivityOf(store, { id: facts.runId, runner: facts.runner, startedAt: facts.startedAt }, now).at : null, now).group
      : segments.some(one => one.role === "planner" && one.endedAt === null) ? "planning" : "idle";
    return { taskId, title: String(row["title"]), project: str(row, "repo") === null ? null : projectName(str(row, "repo")!), href: `/t/${encodeURIComponent(taskId)}`, group, segments };
  });
  const total = tasks.length === 0 ? 0 : Number(tasks[0]!["total"]);
  return {
    since: since.toISOString(), now: now.toISOString(),
    windows: LANE_WINDOWS.map(one => ({ ...one, href: `${path}?window=${one.key}`, active: one.key === window })),
    lanes, more: Math.max(0, total - lanes.length),
    running: tasks.length === 0 ? 0 : Number(tasks[0]!["running"]),

  };
}
