/**
 * Work a lead filed, nested under it on the Live grid (docs/plans/lead-dispatched-tiles.md): which of the viewer's
 * tiles were filed through the viewer's OWN lead chat, and which chat. Proved from the store only, at request time: the
 * task's family root was filed through the lead (`filed_via = 'mate'`) by the viewer as a person, and exactly one record
 * links that root to one of the viewer's own personal lead threads — a confirmed task card the viewer confirmed (its
 * door-written outcome, never the model's payload) or a sweep the viewer started from a card still kept. Attribution is
 * to the chat that filed the family's ORIGINAL task: a revision asked for in another chat stays with the family. Anything
 * short of that is no link:
 * the tile stays a top-level tile, as it is today. A link only groups tiles the viewer already gets; it never adds one.
 */
import type { Store } from "../store.js";

export type FiledBy = { thread: number; chat: "lead" | "project" | "task" };

const BUILT_IN = "built-in";

/** The family root of a built-in task, or null when its lineage can't be proved: the family's own proof (taskFamilyOf:
 * every revision in the root's project, each bound by its brief to its parent's own run), and the task one of it. */
function rootOf(store: Store, taskId: string): string | null {
  const family = store.taskFamilyOf(taskId, null, false);
  return family === null || family.problem !== null || !family.versions.some(version => version.id === taskId) ? null : family.root.id;
}

const parse = (text: unknown): Record<string, unknown> | null => {
  if (typeof text !== "string") return null;
  try { const value = JSON.parse(text) as unknown; return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
};

/** For each run id given (the tiles already in this viewer's answer), the viewer's lead chat that filed its task. */
export function leadFiledLinks(store: Store, viewer: string, runIds: readonly number[]): Map<number, FiledBy> {
  const links = new Map<number, FiledBy>();
  const db = store.handle;
  // The viewer's own personal threads (never a team conversation's), by id.
  const threads = new Map<number, FiledBy["chat"]>();
  for (const row of db.prepare(`SELECT id, scope_kind FROM lead_thread WHERE approver = ? AND NOT EXISTS (SELECT 1 FROM team_conversation tc WHERE tc.thread = lead_thread.id)`).all(viewer)) {
    const kind = row["scope_kind"];
    threads.set(Number(row["id"]), kind === "project" ? "project" : kind === "task" ? "task" : "lead");
  }
  if (threads.size === 0) return links;
  // Each run's family root, proved once per task (attempts of one task share it), and only roots the viewer filed
  // through the lead as a person go further.
  const rootOfTask = new Map<string, string | null>();
  const runRoots = new Map<number, string>();
  const repos = new Map<string, string>();
  const refRow = db.prepare("SELECT repo, filed_via, filed_by, filed_by_kind FROM task_ref WHERE backend = ? AND external_id = ?");
  for (const runId of runIds) {
    const row = db.prepare("SELECT r.backend, r.external_id FROM run JOIN task_ref r ON r.id = run.task_ref WHERE run.id = ?").get(runId);
    if (row === undefined || row["backend"] !== BUILT_IN) continue;
    const task = String(row["external_id"]);
    if (!rootOfTask.has(task)) rootOfTask.set(task, rootOf(store, task));
    const root = rootOfTask.get(task);
    if (root === null || root === undefined) continue;
    if (!repos.has(root)) {
      const ref = refRow.get(BUILT_IN, root);
      // Filed through the lead, by the viewer, as a person.
      const filed = ref !== undefined && ref["filed_via"] === "mate" && ref["filed_by_kind"] === "person" && ref["filed_by"] === viewer && typeof ref["repo"] === "string";
      repos.set(root, filed ? String(ref["repo"]) : "");
    }
    if (repos.get(root) !== "") runRoots.set(runId, root);
  }
  const roots = [...new Set(runRoots.values())];
  if (roots.length === 0) return links;
  // Every confirmed task card in the viewer's own threads naming one of these roots: ONE read per request, through the
  // viewer's threads (lead_thread by approver, lead_proposal by thread and state), never once per family.
  const found = new Map<string, number[]>(roots.map(root => [root, []]));
  const spoiled = new Set<string>();
  const cards = db.prepare(`SELECT p.thread, p.resolved_by, p.payload_json, p.outcome_json, json_extract(p.outcome_json, '$.taskId') AS task FROM lead_proposal p
    JOIN lead_thread t ON t.id = p.thread WHERE t.approver = ? AND p.kind = 'task' AND p.state = 'confirmed' AND json_valid(p.outcome_json)
    AND json_extract(p.outcome_json, '$.taskId') IN (${roots.map(() => "?").join(",")})`).all(viewer, ...roots);
  for (const row of cards) {
    const root = String(row["task"]);
    const outcome = parse(row["outcome_json"]), payload = parse(row["payload_json"]);
    // The door's own outcome (the model writes only the payload), confirmed by the viewer, for this project.
    if (outcome?.["ok"] !== true || outcome["kind"] !== "task" || outcome["taskId"] !== root || row["resolved_by"] !== viewer || payload?.["repo"] !== repos.get(root)) spoiled.add(root);
    else found.get(root)?.push(Number(row["thread"]));
  }
  // A sweep links while the card that started it is kept, as a task card does: ending a chat (or revocation) erases its
  // cards, and with them every link it made — one retention rule for both.
  const sweeps = db.prepare(`SELECT k.root_task, s.owner, s.thread, s.repo, p.thread AS card_thread, p.state AS card_state, p.resolved_by AS card_by
    FROM lead_sweep_task k JOIN lead_sweep s ON s.id = k.sweep LEFT JOIN lead_proposal p ON p.id = s.proposal
    WHERE k.root_task IN (${roots.map(() => "?").join(",")})`).all(...roots);
  for (const row of sweeps) {
    const root = String(row["root_task"]);
    if (row["owner"] !== viewer || row["repo"] !== repos.get(root) || row["thread"] === null || row["card_thread"] !== row["thread"] || row["card_state"] !== "confirmed" || row["card_by"] !== viewer) spoiled.add(root);
    else found.get(root)?.push(Number(row["thread"]));
  }
  for (const [runId, root] of runRoots) {
    // Exactly one record, nothing amiss beside it, naming one of the viewer's own personal threads.
    const named = found.get(root) ?? [];
    if (spoiled.has(root) || named.length !== 1) continue;
    const chat = threads.get(named[0]!);
    if (chat !== undefined) links.set(runId, { thread: named[0]!, chat });
  }
  return links;
}
