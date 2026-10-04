/**
 * Deleting a project: everything Toolroll holds for it goes, and
 * nothing else. Its tasks and their versions, runs and their evidence, the
 * checkouts and branches Toolroll made, its chats and threads, flows
 * and cards, teammates, budgets and settings. Never while any of its work is
 * running. The project's own repository, its working copy and every branch
 * Toolroll didn't make stay exactly as they are. The action ledger
 * keeps every entry (its hash chain still verifies) and gains one: who
 * deleted the project and what went.
 *
 * An instance operator does it, with a step-up: Settings → Project (type the
 * project's name, then the password) or `project delete --repo <path> --yes`.
 * There is no undo.
 */
import { existsSync, lstatSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { run, type ExecResult } from "./exec.js";
import { BUILT_IN, type Database, type Store } from "./store.js";
import { BRANCH_PREFIX, BRANCH_PREFIXES, isOwnBranch } from "./names.js";

/** The tables whose history is the audit record itself: never touched. */
const KEPT = new Set(["action_ledger", "ledger_seal", "ledger_checkpoint"]);
/** What Toolroll names the branches it makes: toolroll/…, and standing-orders/… from before the rename. */
export const OWN_BRANCH = BRANCH_PREFIX;
export const OWN_BRANCHES = BRANCH_PREFIXES;

export type ProjectHoldings = {
  tasks: number; versions: number; runs: number; evidence: number; checkouts: number;
  chats: number; flows: number; cards: number; teammates: number; budgets: number; settings: number;
};

export type ProjectDeleteResult =
  | { ok: true; repo: string; removed: ProjectHoldings & { branches: number; rows: number }; left: string[]; ledgerId: number }
  | { ok: false; reason: "running" | "failed"; said: string; running?: string[] };

type Doomed = { refs: number[]; tasks: string[]; runs: number[]; artifacts: number[]; threads: number[]; turns: number[]; flows: number[]; cards: number[]; teammates: number[] };

const list = (db: Database, sql: string, ...params: unknown[]): unknown[] => db.prepare(sql).all(...params).map(row => Object.values(row)[0]);
const ids = (db: Database, sql: string, ...params: unknown[]): number[] => list(db, sql, ...params).map(Number);
const json = (values: readonly unknown[]) => JSON.stringify(values);
const tableExists = (db: Database, name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The project's rows, by what everything else hangs off. */
function doomed(db: Database, repo: string): Doomed {
  const refs = ids(db, "SELECT id FROM task_ref WHERE repo = ?", repo);
  // A built-in task goes when every version of it is this project's.
  const tasks = list(db, `SELECT DISTINCT external_id FROM task_ref WHERE repo = ? AND backend = ?
    AND external_id NOT IN (SELECT external_id FROM task_ref WHERE backend = ? AND (repo IS NULL OR repo <> ?))`, repo, BUILT_IN, BUILT_IN, repo).map(String);
  const runs = ids(db, "SELECT id FROM run WHERE task_ref IN (SELECT value FROM json_each(?))", json(refs));
  const artifacts = ids(db, "SELECT id FROM artifact WHERE run IN (SELECT value FROM json_each(?))", json(runs));
  // A team conversation's thread is the team's, whatever it talked about.
  const threads = ids(db, `SELECT id FROM mate_thread WHERE ((scope_kind = 'project' AND scope_key = ?) OR (scope_kind = 'task' AND scope_key IN (SELECT value FROM json_each(?))))
    AND id NOT IN (SELECT thread FROM team_conversation WHERE thread IS NOT NULL)`, repo, json(tasks));
  const turns = ids(db, "SELECT id FROM mate_turn WHERE thread IN (SELECT value FROM json_each(?))", json(threads));
  const flows = ids(db, "SELECT id FROM flow WHERE repo = ?", repo);
  const cards = ids(db, "SELECT id FROM flow_card WHERE flow IN (SELECT value FROM json_each(?))", json(flows));
  const teammates = ids(db, "SELECT id FROM teammate WHERE repo = ?", repo);
  return { refs, tasks, runs, artifacts, threads, turns, flows, cards, teammates };
}

/** A project's settings: one row per thing someone set for it. */
const SETTINGS: [table: string, column: string][] = [
  ["approval_policy", "repo"], ["verify_command", "repo"], ["worktree_setup", "repo"], ["backend_grant", "repo"], ["publication_grant", "repo"],
  ["intake_grant", "repo"], ["capability", "repo"], ["project_tool", "repo"], ["phase_config", "scope"], ["phase_tier_config", "scope"],
  ["fallback_config", "scope"], ["learning_policy", "repo"], ["operating_mode", "repo"], ["routine", "repo"], ["project_knowledge", "repo"],
  ["project_decision", "repo"], ["flow_script", "repo"], ["workflow_recipe", "repo"], ["team_lead_project", "project"],
];

/** What Toolroll holds for a project, counted. */
export function projectHoldings(store: Store, repo: string): ProjectHoldings {
  const db = store.handle;
  const d = doomed(db, repo);
  const count = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).get(...params)?.["n"] ?? 0);
  const versions = count("SELECT COUNT(DISTINCT external_id) AS n FROM task_ref WHERE repo = ? AND revision_of IS NOT NULL", repo);
  return {
    tasks: count("SELECT COUNT(DISTINCT external_id) AS n FROM task_ref WHERE repo = ?", repo) - versions, versions,
    runs: d.runs.length, evidence: d.artifacts.length,
    checkouts: count("SELECT COUNT(*) AS n FROM worktree WHERE repo = ?", repo),
    chats: d.threads.length, flows: d.flows.length, cards: d.cards.length, teammates: d.teammates.length,
    budgets: count(`SELECT COUNT(*) AS n FROM budget WHERE removed_at IS NULL AND ((scope_kind = 'project' AND scope_key = ?) OR (scope_kind = 'teammate' AND scope_key IN (SELECT CAST(value AS TEXT) FROM json_each(?))))`, repo, json(d.teammates)),
    settings: SETTINGS.filter(([table]) => tableExists(db, table)).reduce((sum, [table, column]) => sum + count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, repo), 0),
  };
}

/** What's in it, in words: "12 tasks, 3 versions, 30 runs, …". Empty kinds are left out. */
export function holdingsWords(held: ProjectHoldings & { branches?: number }): string {
  const parts = [
    plural(held.tasks, "task"), ...(held.versions > 0 ? [plural(held.versions, "version")] : []), plural(held.runs, "run"),
    ...(held.evidence > 0 ? [plural(held.evidence, "evidence file")] : []), ...(held.checkouts > 0 ? [plural(held.checkouts, "checkout")] : []),
    ...(held.branches ? [plural(held.branches, "branch", "branches")] : []), ...(held.chats > 0 ? [plural(held.chats, "chat")] : []),
    ...(held.flows > 0 ? [`${plural(held.flows, "flow")} with ${plural(held.cards, "card")}`] : []), ...(held.teammates > 0 ? [plural(held.teammates, "teammate")] : []),
    ...(held.budgets > 0 ? [plural(held.budgets, "budget")] : []), ...(held.settings > 0 ? [plural(held.settings, "setting")] : []),
  ];
  return parts.join(", ");
}

/** The project's work that is running right now, in words; empty when none is. */
export function projectRunning(store: Store, repo: string, now: Date): string[] {
  const db = store.handle;
  const d = doomed(db, repo);
  const at = now.toISOString();
  const count = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).get(...params)?.["n"] ?? 0);
  const building = count(`SELECT COUNT(DISTINCT task_ref) AS n FROM claim WHERE released_at IS NULL AND expires_at > ? AND task_ref IN (SELECT value FROM json_each(?))`, at, json(d.refs));
  const sessions = count("SELECT COUNT(*) AS n FROM held_session WHERE ended_at IS NULL AND run IN (SELECT value FROM json_each(?))", json(d.runs));
  const slots = count("SELECT COUNT(*) AS n FROM execution_slot WHERE state IN ('reserved','running') AND run IN (SELECT value FROM json_each(?))", json(d.runs));
  const chats = count("SELECT COUNT(*) AS n FROM mate_turn WHERE state IN ('queued','running') AND id IN (SELECT value FROM json_each(?))", json(d.turns));
  const steps = count("SELECT COUNT(*) AS n FROM flow_step_run WHERE state = 'running' AND card IN (SELECT value FROM json_each(?))", json(d.cards));
  const calls = count("SELECT COUNT(*) AS n FROM teammate_call WHERE state = 'running' AND teammate IN (SELECT value FROM json_each(?))", json(d.teammates));
  const merges = count(`SELECT COUNT(*) AS n FROM merge_intent WHERE state IN ('claimed','firing') AND publication IN (SELECT id FROM publication WHERE task_ref IN (SELECT value FROM json_each(?)))`, json(d.refs));
  const checkouts = count("SELECT COUNT(*) AS n FROM worktree WHERE repo = ? AND runner IS NOT NULL AND released_at IS NULL", repo);
  return [
    ...(building > 0 ? [`${plural(building, "task")} ${building === 1 ? "is" : "are"} being built`] : []),
    ...(sessions > 0 || slots > 0 ? ["an agent is working"] : []),
    ...(chats > 0 ? ["a chat is answering"] : []),
    ...(steps > 0 ? ["a flow step is running"] : []),
    ...(calls > 0 ? ["a teammate is working"] : []),
    ...(merges > 0 ? ["a merge is in progress"] : []),
    ...(checkouts > 0 && building === 0 ? [`${plural(checkouts, "checkout")} ${checkouts === 1 ? "is" : "are"} in use`] : []),
  ];
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<ExecResult>;
const defaultGit: GitRunner = (args, cwd) => run("git", ["--no-optional-locks", ...args], { cwd, timeoutMs: 60_000 });

/** Whether `path` is inside `root` (not the root itself). */
const inside = (root: string, path: string) => { const rel = relative(resolve(root), resolve(path)); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); };

/**
 * Remove the checkouts and branches Toolroll made for the project: only
 * branches named toolroll/… or standing-orders/… that its tasks, runs, checkouts, races or
 * pull requests used, and only checkouts of those branches or ones it
 * recorded. Git itself refuses to delete a branch that is checked out
 * somewhere; that one stays and is said. Nothing else in the repository moves.
 */
async function removeCheckoutsAndBranches(store: Store, repo: string, d: Doomed, git: GitRunner, poolRoot: string | null): Promise<{ checkouts: number; branches: number; left: string[] }> {
  const db = store.handle;
  const recorded = db.prepare("SELECT path, branch FROM worktree WHERE repo = ?").all(repo).map(row => ({ path: String(row["path"]), branch: String(row["branch"]) }));
  const named = [
    ...d.tasks.flatMap(id => OWN_BRANCHES.map(prefix => `${prefix}${id}`)), ...recorded.map(row => row.branch),
    ...list(db, "SELECT DISTINCT branch FROM run WHERE branch IS NOT NULL AND id IN (SELECT value FROM json_each(?))", json(d.runs)),
    ...list(db, "SELECT DISTINCT c.branch FROM contestant c JOIN contest k ON k.id = c.contest WHERE c.branch IS NOT NULL AND k.task_ref IN (SELECT value FROM json_each(?))", json(d.refs)),
    ...list(db, "SELECT DISTINCT head FROM publication WHERE head IS NOT NULL AND task_ref IN (SELECT value FROM json_each(?))", json(d.refs)),
  ].map(String).filter(isOwnBranch);
  const ours = new Set(named);
  const left: string[] = [];
  let checkouts = 0, branches = 0;
  const isRepo = existsSync(repo) && (await git(["rev-parse", "--git-dir"], repo)).code === 0;
  if (!isRepo) {
    // No repository to ask: only checkouts in Toolroll's own folder go.
    for (const row of recorded) {
      if (poolRoot === null || !inside(poolRoot, row.path) || !existsSync(row.path)) continue;
      rmSync(row.path, { recursive: true, force: true });
      checkouts++;
    }
    return { checkouts, branches, left };
  }
  // Every checkout of one of our branches, and every one we recorded, wherever git has it.
  const listed = await git(["worktree", "list", "--porcelain"], repo);
  const trees: { path: string; branch: string | null }[] = [];
  if (listed.code === 0) {
    let current: { path: string; branch: string | null } | null = null;
    for (const line of listed.stdout.split("\n")) {
      if (line.startsWith("worktree ")) { current = { path: line.slice(9), branch: null }; trees.push(current); }
      else if (line.startsWith("branch refs/heads/") && current !== null) current.branch = line.slice(18);
    }
  }
  const main = trees[0]?.path ?? null;
  const targets = new Set<string>();
  // A checkout goes only while it's on one of our branches, or on no branch at all (a detached checkout Toolroll
  // made). One we recorded that someone has since switched to a branch of their own is theirs now: it stays, and is said.
  for (const tree of trees.slice(1)) {
    const recordedHere = recorded.some(row => resolve(row.path) === resolve(tree.path));
    if (tree.branch !== null && ours.has(tree.branch)) targets.add(tree.path);
    else if (recordedHere && tree.branch === null) targets.add(tree.path);
    else if (recordedHere) left.push(`checkout ${tree.path}: it's on ${tree.branch}, not a Toolroll branch, so it was left alone`);
  }
  for (const path of targets) {
    if (main !== null && resolve(path) === resolve(main)) continue;
    const gone = await git(["worktree", "remove", "--force", path], repo);
    if (gone.code === 0) checkouts++;
    else left.push(`checkout ${path}: ${gone.stderr.trim().split("\n")[0] ?? "git refused"}`);
  }
  // A recorded checkout git no longer knows, still on disk in our folder.
  for (const row of recorded) {
    if (targets.has(row.path) || poolRoot === null || !inside(poolRoot, row.path) || !existsSync(row.path)) continue;
    // Only one git has forgotten: a checkout git still lists was either removed above or left alone on purpose.
    if (trees.some(tree => resolve(tree.path) === resolve(row.path))) continue;
    rmSync(row.path, { recursive: true, force: true });
    checkouts++;
  }
  await git(["worktree", "prune"], repo);
  const existing = await git(["for-each-ref", "--format=%(refname:short)", ...OWN_BRANCHES.map(prefix => `refs/heads/${prefix}`)], repo);
  for (const branch of existing.code === 0 ? existing.stdout.split("\n").map(one => one.trim()).filter(Boolean) : []) {
    if (!ours.has(branch)) continue;
    const gone = await git(["branch", "-D", "--", branch], repo);
    if (gone.code === 0) branches++;
    else left.push(`branch ${branch}: ${gone.stderr.trim().split("\n")[0] ?? "git refused"}`);
  }
  return { checkouts, branches, left };
}

/** Delete the project's rows in one transaction; returns how many rows went. */
function deleteRows(store: Store, repo: string, d: Doomed, now: Date): number {
  const db = store.handle;
  let rows = 0;
  const del = (table: string, where: string, ...params: unknown[]) => {
    if (!tableExists(db, table)) return;
    rows += Number(db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params).changes);
  };
  const IN = (column: string) => `${column} IN (SELECT value FROM json_each(?))`;
  const R = json(d.runs), T = json(d.refs), K = json(d.tasks), A = json(d.artifacts), H = json(d.threads), U = json(d.turns), F = json(d.flows), C = json(d.cards), M = json(d.teammates);
  const decisions = json(ids(db, `SELECT id FROM decision WHERE ${IN("run")}`, R));
  const publications = json(ids(db, `SELECT id FROM publication WHERE ${IN("task_ref")} OR ${IN("run")}`, T, R));
  const notifications = json(ids(db, `SELECT id FROM notification WHERE project = ? OR ${IN("task_ref")} OR ${IN("source_run")}`, repo, T, R));
  const questions = json(ids(db, `SELECT id FROM teammate_question WHERE ${IN("teammate")} OR ${IN("card")}`, M, C));
  const proposals = json(ids(db, `SELECT id FROM mate_proposal WHERE ${IN("thread")}`, H));
  const conversations = json(ids(db, `SELECT id FROM telegram_conversation WHERE ${IN("task_id")}`, K));

  // Chats about the project's work, on every surface.
  for (const surface of ["discord", "slack", "teams"]) {
    del(`${surface}_progress`, IN("run"), R);
    del(`${surface}_action`, IN("proposal"), proposals);
    del(`${surface}_flow_action`, IN("card"), C);
    del(`${surface}_flow_prompt`, IN("card"), C);
    del(`${surface}_flow_choice`, IN("card"), C);
    del(`${surface}_flow_note`, IN("card"), C);
    del(`${surface}_question_action`, IN("question"), questions);
    del(`${surface}_question_prompt`, IN("question"), questions);
    del(`${surface}_ask_action`, IN("turn"), U);
  }
  del("telegram_action", IN("decision"), decisions);
  del("telegram_decision_message", IN("decision"), decisions);
  del("telegram_note_draft", IN("decision"), decisions);
  del("telegram_proposal_action", IN("proposal"), proposals);
  del("telegram_flow_action", IN("card"), C);
  del("telegram_flow_prompt", IN("card"), C);
  del("telegram_flow_choice", IN("card"), C);
  del("flow_send", IN("card"), C);
  del("telegram_question_action", IN("question"), questions);
  del("telegram_question_prompt", IN("question"), questions);
  del("chat_decide_action", IN("task_id"), K);
  del("chat_decide_prompt", IN("task_id"), K);
  del("telegram_task_message", `${IN("task_id")} OR ${IN("source_run")}`, K, R);
  del("telegram_conversation_part", `${IN("conversation")} OR ${IN("source_run")} OR ${IN("task_id")}`, conversations, R, K);
  del("telegram_conversation", IN("id"), conversations);
  del("telegram_outbound_message", `project = ? OR ${IN("notification")} OR ${IN("task_ref")} OR ${IN("source_run")}`, repo, notifications, T, R);
  del("chat_card_task", IN("task_ref"), T);
  del("chat_batch_item", IN("task_ref"), T);
  del("result_shot_sent", IN("run"), R);
  del("push_delivery", IN("notification"), notifications);
  del("notification_actor", IN("notification"), notifications);
  del("notification_delivery", IN("notification"), notifications);
  del("notification", IN("id"), notifications);
  del("chat_focus", IN("task"), K);
  del("team_task_owner", IN("task_ref"), T);
  del("team_mate_session", IN("thread"), H);
  del("mate_turn_evidence", `${IN("turn")} OR ${IN("run")} OR ${IN("task_ref")} OR ${IN("artifact")}`, U, R, T, A);
  del("chat_turn", IN("mate_turn"), U);
  del("mate_ask", IN("turn"), U);
  del("mate_turn", IN("id"), U);
  del("mate_proposal", IN("id"), proposals);
  del("mate_message", IN("thread"), H);
  del("mate_thread", IN("id"), H);

  // Runs and their evidence.
  del("run_decision", `${IN("run")} OR ${IN("decision")}`, R, decisions);
  del("decision_artifact", `${IN("decision")} OR ${IN("artifact")}`, decisions, A);
  del("decision", IN("id"), decisions);
  del("criterion_review", `${IN("reviewer_run")} OR ${IN("source_run")} OR ${IN("artifact")}`, R, R, A);
  del("diff_comment", `${IN("run")} OR ${IN("reviewer_run")} OR ${IN("artifact")}`, R, R, A);
  del("review_request", `${IN("run")} OR ${IN("reviewer_run")}`, R, R);
  del("repair_chain", IN("source_run"), R);
  for (const table of ["incident", "held_session", "proof_acceptance", "proof_verdict", "run_process", "run_route", "run_spend", "run_tool", "run_note", "run_stop", "run_checkpoint", "session_turn", "execution_slot"]) del(table, IN("run"), R);
  del("knowledge_snapshot", `repo = ? OR ${IN("run")}`, repo, R);
  del("learning_snapshot", `repo = ? OR ${IN("run")}`, repo, R);
  del("learning_capture", `repo = ? OR ${IN("source")} OR ${IN("reviewer")}`, repo, R, R);
  del("learning_event", `repo = ? OR ${IN("run")}`, repo, R);
  del("project_lesson", `repo = ? OR ${IN("source")} OR ${IN("reviewer")}`, repo, R, R);
  del("skill_snapshot", `repo = ? OR ${IN("run")}`, repo, R);
  del("skill_test", `${IN("task_ref")} OR ${IN("source_run")}`, T, R);
  del("merge_blocker", `${IN("publication")} OR ${IN("task_id")}`, publications, K);
  del("merge_intent", IN("publication"), publications);
  del("publication", IN("id"), publications);
  del("artifact", IN("id"), A);

  // Tasks and their versions.
  const cycles = json(ids(db, `SELECT id FROM fallback_cycle WHERE ${IN("task_ref")}`, T));
  del("fallback_transition", `${IN("cycle")} OR ${IN("predecessor_run")} OR ${IN("consumed_by")}`, cycles, R, R);
  del("fallback_cycle", IN("id"), cycles);
  const contests = json(ids(db, `SELECT id FROM contest WHERE ${IN("task_ref")}`, T));
  del("contestant", IN("contest"), contests);
  del("contest", IN("id"), contests);
  del("tournament_terms", IN("task_ref"), T);
  del("attended_authorization", IN("task_ref"), T);
  del("run", IN("id"), R);
  del("plan_revision", IN("task_ref"), T);
  for (const table of ["claim", "hold", "task_steer"]) del(table, IN("task_ref"), T);
  del("routine_fire", IN("instance_task_ref"), T);
  const mirrors = json(list(db, `SELECT local_task_id FROM external_mirror WHERE ${IN("local_task_id")}`, K));
  del("external_intent", IN("mirror"), mirrors);
  del("external_mirror", IN("local_task_id"), mirrors);
  for (const [table, column] of [["scope_approval_vote", "task_id"], ["scope_author", "task_id"], ["plan_authorization", "task_id"], ["tool_seal", "task"], ["mcp_idempotency", "task_id"], ["coordinator_event", "task_id"], ["workflow_preview", "task_id"]] as const) del(table, IN(column), K);
  del("workflow_preview", "repo = ?", repo);
  del("coding_handoff_scope", `id IN (SELECT id FROM coding_handoff WHERE json_extract(payload, '$.repo') = ?)`, repo);
  del("coding_handoff", "json_extract(payload, '$.repo') = ?", repo);
  for (const table of ["task_act", "task_replacement"]) del(table, IN("task_ref"), T);
  del("task_ref", IN("id"), T);
  del("task_scope", IN("task_id"), K);
  del("task_edge", `${IN("blocked")} OR ${IN("blocker")}`, K, K);
  del("task", IN("id"), K);

  // Flows, cards and teammates.
  del("flow_trigger_event", `${IN("card")} OR trigger IN (SELECT id FROM flow_trigger WHERE ${IN("flow")})`, C, F);
  del("flow_trigger", IN("flow"), F);
  for (const table of ["flow_card_watcher", "flow_comment", "flow_event", "flow_mail", "flow_step_run"]) del(table, IN("card"), C);
  del("teammate_question", IN("id"), questions);
  del("teammate_call", `${IN("teammate")} OR ${IN("card")}`, M, C);
  for (const table of ["teammate_event", "teammate_memory", "teammate_turn"]) del(table, `${IN("teammate")} OR ${IN("card")}`, M, C);
  for (const table of ["teammate_suggestion", "teammate_tool", "teammate_version"]) del(table, IN("teammate"), M);
  del("budget", `(scope_kind = 'project' AND scope_key = ?) OR (scope_kind = 'teammate' AND scope_key IN (SELECT CAST(value AS TEXT) FROM json_each(?)))`, repo, M);
  del("teammate", IN("id"), M);
  del("flow_card", IN("id"), C);
  del("flow", IN("id"), F);

  // Settings, knowledge and the project itself.
  del("operating_mode_event", "mode IN (SELECT id FROM operating_mode WHERE repo = ?)", repo);
  del("decision_change", "decision IN (SELECT id FROM project_decision WHERE repo = ?)", repo);
  del("memory_sighting", "gap IN (SELECT id FROM memory_gap WHERE repo = ?) OR session IN (SELECT id FROM memory_session WHERE repo = ?)", repo, repo);
  del("routine_fire", "routine_id IN (SELECT id FROM routine WHERE repo = ?)", repo);
  for (const [table, column] of SETTINGS) del(table, `${column} = ?`, repo);
  del("project_mute", "repo = ?", repo);
  for (const table of ["knowledge_change", "project_skill_change", "memory_gap", "memory_proposal", "memory_rejection", "memory_session", "memory_search", "mode_rail", "side_spend", "watch_episode", "worktree", "coordinator_proposal", "lead_commitment"]) del(table, "repo = ?", repo);
  // A builder watching the project keeps its lease until it stops; an ended one goes.
  del("watch_lease", "repo = ? AND expires_at <= ?", repo, now.toISOString());
  del("project", "path = ?", repo);
  return rows;
}

/**
 * Delete the project. Refuses while any of its work is running (checked
 * again inside the deletion). Its tasks are held first so nothing new
 * starts while the checkouts and branches go.
 */
export async function deleteProject(store: Store, repo: string, options: {
  actor: string; via: "console" | "command line"; now: Date; evidenceRoot: string | null; poolRoot: string | null; git?: GitRunner;
}): Promise<ProjectDeleteResult> {
  const git = options.git ?? defaultGit;
  const running = projectRunning(store, repo, options.now);
  if (running.length > 0) return { ok: false, reason: "running", said: `Nothing was deleted: ${running.join(", ")}. Stop it, then try again.`, running };
  const db = store.handle;
  const held = projectHoldings(store, repo);
  let d = doomed(db, repo);
  // Nothing new starts while the checkouts go.
  store.transact(() => {
    for (const ref of d.refs) {
      db.prepare(`INSERT INTO hold (task_ref, owner_kind, owner_id, reason, until, held_at) VALUES (?, 'operator', ?, 'Its project is being deleted', NULL, ?)
        ON CONFLICT (owner_kind, owner_id) DO NOTHING`).run(ref, `project-delete:${ref}`, options.now.toISOString());
    }
  });
  const release = () => store.transact(() => { db.prepare("DELETE FROM hold WHERE owner_kind = 'operator' AND owner_id LIKE 'project-delete:%' AND task_ref IN (SELECT value FROM json_each(?))").run(json(d.refs)); });
  let git_: Awaited<ReturnType<typeof removeCheckoutsAndBranches>>;
  try { git_ = await removeCheckoutsAndBranches(store, repo, d, git, options.poolRoot); }
  catch (error) { release(); return { ok: false, reason: "failed", said: `Nothing was deleted: the checkouts couldn't be removed (${error instanceof Error ? error.message : String(error)}).` }; }
  let rows = 0, ledgerId = 0;
  try {
    store.transact(() => {
      const again = projectRunning(store, repo, options.now);
      if (again.length > 0) throw new RunningError(again);
      d = doomed(db, repo);
      // Checked when the deletion commits, so the order of the deletes doesn't matter; what's left dangling is below.
      db.exec("PRAGMA defer_foreign_keys = ON");
      const before = new Set(db.prepare("PRAGMA foreign_key_check").all().map(row => `${String(row["table"])}:${String(row["rowid"])}`));
      // History tables refuse deletes; the project's own history goes with it, and their guards come straight back.
      const guards = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%RAISE(ABORT%' AND sql NOT LIKE '%AFTER%'`).all()
        .map(row => ({ name: String(row["name"]), sql: String(row["sql"]) }))
        .filter(one => ![...KEPT].some(table => new RegExp(`\\bON\\s+${table}\\b`, "i").test(one.sql)));
      for (const guard of guards) db.exec(`DROP TRIGGER "${guard.name}"`);
      rows = deleteRows(store, repo, d, options.now);
      // Anything else that pointed at the project's rows: a pointer that may be empty is emptied (another project's
      // row keeps everything else); a row that can't exist without it goes too. Never the ledger.
      for (let pass = 0; pass < 8; pass++) {
        const dangling = db.prepare("PRAGMA foreign_key_check").all()
          .filter(row => !before.has(`${String(row["table"])}:${String(row["rowid"])}`) && row["rowid"] != null && !KEPT.has(String(row["table"])));
        if (dangling.length === 0) break;
        for (const row of dangling) {
          const table = String(row["table"]);
          const columns = db.prepare(`PRAGMA foreign_key_list("${table}")`).all().filter(key => Number(key["id"]) === Number(row["fkid"])).map(key => String(key["from"]));
          const nullable = columns.length === 1 && db.prepare(`PRAGMA table_info("${table}")`).all().some(column => column["name"] === columns[0] && Number(column["notnull"]) === 0 && Number(column["pk"]) === 0);
          rows += Number(db.prepare(nullable ? `UPDATE "${table}" SET "${columns[0]}" = NULL WHERE rowid = ?` : `DELETE FROM "${table}" WHERE rowid = ?`).run(row["rowid"]).changes);
        }
      }
      for (const guard of guards) db.exec(guard.sql);
      const removed = { ...held, checkouts: Math.max(held.checkouts, git_.checkouts), branches: git_.branches };
      ledgerId = store.recordProjectDeleted(options.actor, repo, holdingsWords(removed) || "nothing", `deleted from the ${options.via}${git_.left.length > 0 ? ` (${plural(git_.left.length, "item")} git kept)` : ""}`, options.now);
    });
  } catch (error) {
    release();
    if (error instanceof RunningError) return { ok: false, reason: "running", said: `Nothing was deleted: ${error.running.join(", ")}. Stop it, then try again.`, running: error.running };
    return { ok: false, reason: "failed", said: `Nothing was deleted from the database: ${error instanceof Error ? error.message : String(error)}.` };
  }
  // The runs' evidence files, each in its own folder named for the run.
  if (options.evidenceRoot !== null) {
    for (const runId of d.runs) {
      const folder = resolve(options.evidenceRoot, String(runId));
      try { if (lstatSync(folder).isDirectory() && inside(options.evidenceRoot, folder)) rmSync(folder, { recursive: true, force: true }); }
      catch { /* never written, or already gone */ }
    }
  }
  return { ok: true, repo, removed: { ...held, checkouts: Math.max(held.checkouts, git_.checkouts), branches: git_.branches, rows }, left: git_.left, ledgerId };
}

class RunningError extends Error {
  constructor(readonly running: string[]) { super(running.join(", ")); }
}
