/**
 * Where each listed task's accepted work landed, for a list (the workbench's rows, `toolroll task list`): the words
 * local-landing.ts landingHistoryOf gives the task page ("Landed on main (abc1234)"), read for a whole page at once.
 *
 * One SQL statement for the page, whatever its size: its Complete tasks' landing intents and settlements, the kept
 * handoffs of exactly their results' commits, each project's newest destination record and its publication grant, and
 * each result's commit. The history is then worked out from those rows exactly as landingHistoryOf works it out per task
 * (landed-rows.test.ts holds the two to the same answers); git is read only for a task Toolroll landed or handed a
 * landing commit for, at most LANDED_GIT_READS times a page, through briefly kept reads. Work a person merged by hand with no Toolroll landing is said on its own page only. Display only:
 * nothing here lands, undoes, completes or allows anything.
 */
import { LAND_DESTINATION, LAND_HANDOFF, LAND_HANDOFF_SETTLED, LAND_INTENT, LAND_SETTLED, landableBranch, revertedOnBranch } from "./local-landing.js";
import type { Store } from "./store.js";
import { recentGitReads, type GitRead } from "./task-base.js";

/** The bounded git reads a list's landing words use (display only, answers kept for a moment). */
const listReads: GitRead = recentGitReads();

/** The git reads one page's landing words may spend, at most (each recorded landing takes up to 3: the revert check). */
export const LANDED_GIT_READS = 24;
class GitBudgetSpent extends Error {}

export type LandedRow = { rootId: string; repo: string | null; resultRunId: number | null; assignmentState: string };

const OID = /^[0-9a-f]{40}$/;
const short = (oid: string) => oid.slice(0, 7);
type Detail = Record<string, unknown>;
type Intent = { id: number; kind: "land" | "undo"; ref: string; old: string; commit: string; candidate: string; reverts: string | number | null; fromHandoff: number | null };
type Handoff = { id: number; ref: string; old: string; commit: string; candidate: string };

/** An intent row's facts, read as local-landing.ts intentOf reads them (anything else is no intent). */
function intentOf(id: number, d: Detail): Intent | null {
  if (d["v"] !== 1 || typeof d["ref"] !== "string" || typeof d["old"] !== "string" || typeof d["commit"] !== "string" || !OID.test(d["old"]) || !OID.test(d["commit"])
    || (d["mode"] !== "files" && d["mode"] !== "ref") || typeof d["key"] !== "string" || (d["kind"] !== "land" && d["kind"] !== "undo")) return null;
  return { id, kind: d["kind"], ref: d["ref"], old: d["old"], commit: d["commit"], candidate: typeof d["candidate"] === "string" && OID.test(d["candidate"]) ? d["candidate"] : d["commit"],
    reverts: typeof d["reverts"] === "number" || typeof d["reverts"] === "string" ? d["reverts"] : null, fromHandoff: typeof d["fromHandoff"] === "number" ? d["fromHandoff"] : null };
}
/** A handoff row's facts, as local-landing.ts handoffRows reads them (settled is decided by the caller). */
function handoffOf(id: number, d: Detail): Handoff | null {
  const ok = d["v"] === 1 && typeof d["key"] === "string" && typeof d["ref"] === "string" && typeof d["old"] === "string" && OID.test(d["old"]) && typeof d["commit"] === "string" && OID.test(d["commit"])
    && typeof d["keep"] === "string" && typeof d["folder"] === "string" && typeof d["candidate"] === "string" && OID.test(d["candidate"]);
  return ok ? { id, ref: d["ref"] as string, old: d["old"] as string, commit: d["commit"] as string, candidate: d["candidate"] as string } : null;
}
const parsed = (text: unknown): Detail | null => {
  try { const value = JSON.parse(String(text ?? "null")) as unknown; return value !== null && typeof value === "object" ? value as Detail : null; } catch { return null; }
};

/** Each row's landing words (no closing period), only for a Complete task whose accepted result is on its branch. */
export function landedRowsOf(store: Store, rows: readonly LandedRow[], read: GitRead = listReads): Map<string, string> {
  const out = new Map<string, string>();
  const done = rows.filter(one => one.assignmentState === "complete" && one.repo !== null && one.resultRunId !== null);
  if (done.length === 0) return out;
  const ids = [...new Set(done.map(one => one.rootId))], repos = [...new Set(done.map(one => one.repo!))], runs = [...new Set(done.map(one => one.resultRunId!))];
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
  // The one statement, only what a page's answer can rest on: its tasks' landing intents and their settlements, the kept
  // handoffs of exactly its results' commits, each project's newest destination record and its grant, and its commits.
  const found = store.handle.prepare(`
    WITH heads AS (SELECT id, head_revision FROM run WHERE id IN (${marks(runs.length)})),
    handed AS (SELECT id, task_id, repo, action, outcome, detail FROM action_ledger WHERE task_id IN (${marks(ids.length)}) AND action = ?
      AND (CASE WHEN json_valid(detail) THEN json_extract(detail, '$.candidate') END) IN (SELECT head_revision FROM heads))
    SELECT 'ledger' AS kind, id, task_id, repo, action, outcome, detail FROM action_ledger WHERE task_id IN (${marks(ids.length)}) AND action IN (?, ?)
    UNION ALL SELECT 'ledger', id, task_id, repo, action, outcome, detail FROM handed
    UNION ALL SELECT 'ledger', id, task_id, repo, action, outcome, NULL FROM action_ledger WHERE task_id IN (${marks(ids.length)}) AND action = ? AND outcome IN (SELECT id || ':kept' FROM handed)
    UNION ALL SELECT 'destination', id, NULL, repo, action, NULL, detail FROM action_ledger
      WHERE id IN (SELECT max(id) FROM action_ledger WHERE repo IN (${marks(repos.length)}) AND action = ? AND source = 'request' GROUP BY repo)
    UNION ALL SELECT 'grant', NULL, NULL, repo, NULL, NULL, NULL FROM publication_grant WHERE repo IN (${marks(repos.length)}) AND revoked_at IS NULL
    UNION ALL SELECT 'run', id, NULL, NULL, NULL, head_revision, NULL FROM heads`)
    .all(...runs, ...ids, LAND_HANDOFF, ...ids, LAND_INTENT, LAND_SETTLED, ...ids, LAND_HANDOFF_SETTLED, ...repos, LAND_DESTINATION, ...repos);
  const heads = new Map<number, string | null>(), granted = new Set<string>(), destinations = new Map<string, { id: number; ref: string }>();
  const intents = new Map<string, Intent[]>(), handoffs = new Map<string, { repo: string; one: Handoff }[]>();
  const settled = new Map<number, { id: number; outcome: string }>(), kept = new Set<number>();
  for (const row of found) {
    const kind = String(row["kind"]), id = Number(row["id"]);
    if (kind === "run") { heads.set(id, row["outcome"] == null ? null : String(row["outcome"])); continue; }
    if (kind === "grant") { granted.add(String(row["repo"])); continue; }
    if (kind === "destination") {
      const ref = parsed(row["detail"])?.["ref"], repo = String(row["repo"]);
      // The newest row is the record (recordedDestination), whatever it says.
      if ((destinations.get(repo)?.id ?? -1) < id) destinations.set(repo, { id, ref: typeof ref === "string" && typeof parsed(row["detail"])?.["common"] === "string" ? ref : "" });
      continue;
    }
    const action = String(row["action"]), outcome = String(row["outcome"] ?? ""), task = String(row["task_id"]);
    if (action === LAND_SETTLED) {
      const intent = Number(outcome.slice(0, outcome.indexOf(":")));
      if (outcome.includes(":") && (settled.get(intent)?.id ?? -1) < id) settled.set(intent, { id, outcome: outcome.slice(outcome.indexOf(":") + 1) });
    } else if (action === LAND_HANDOFF_SETTLED) {
      if (/^\d+:kept$/.test(outcome)) kept.add(Number(outcome.slice(0, outcome.indexOf(":"))));
    } else if (action === LAND_INTENT) {
      const one = intentOf(id, parsed(row["detail"]) ?? {});
      if (one !== null) intents.set(task, [...(intents.get(task) ?? []), one]);
    } else if (action === LAND_HANDOFF) {
      const one = handoffOf(id, parsed(row["detail"]) ?? {});
      if (one !== null) handoffs.set(task, [...(handoffs.get(task) ?? []), { repo: String(row["repo"]), one }]);
    }
  }
  const landedOutcome = (intent: number) => settled.get(intent)?.outcome.startsWith("landed") === true;
  // A fixed number of git reads for the whole page: once they are spent, the rows left say nothing (never a wrong word:
  // a row whose reads ran out part way says nothing either).
  let left = LANDED_GIT_READS;
  const budgeted: GitRead = (cwd, args) => {
    if (left <= 0) throw new GitBudgetSpent();
    left -= 1;
    return read(cwd, args);
  };
  for (const row of done) {
    try { const words = landedWordsOf(row); if (words !== null) out.set(row.rootId, words); }
    catch (error) { if (error instanceof GitBudgetSpent) break; throw error; }
  }
  return out;

  function landedWordsOf(row: LandedRow): string | null {
    const repo = row.repo!, head = heads.get(row.resultRunId!) ?? null;
    if (granted.has(repo) || (!intents.has(row.rootId) && !handoffs.has(row.rootId))) return null;
    // landingOf: the newest land intent settled as landed, and whether an undo of it settled since.
    const all = [...(intents.get(row.rootId) ?? [])].sort((a, b) => b.id - a.id);
    const record = all.find(one => one.kind === "land" && landedOutcome(one.id)) ?? null;
    const name = record === null ? null : record.fromHandoff !== null ? `handoff:${record.fromHandoff}` : `intent:${record.id}`;
    const undone = record !== null && all.some(one => one.kind === "undo" && (one.reverts === name || one.reverts === record.id) && landedOutcome(one.id));
    if (record === null || undone) {
      // recognisedOnBranch: its own commit, or a kept landing commit Toolroll handed over, on the destination branch.
      if (head === null || !OID.test(head)) return null;
      const destination = destinations.get(repo)?.ref ?? null;
      const ref = destination !== null && destination !== "" ? destination : (() => { const named = budgeted(repo, ["symbolic-ref", "-q", "HEAD"]); return named !== null && named.startsWith("refs/heads/") ? named : null; })();
      if (ref === null || !landableBranch(ref.slice("refs/heads/".length))) return null;
      const handed = (handoffs.get(row.rootId) ?? []).filter(one => one.repo === repo && kept.has(one.one.id) && one.one.candidate === head && one.one.ref === ref)
        .sort((a, b) => b.one.id - a.one.id).map(one => ({ commit: one.one.commit, old: one.one.old as string | null }));
      const on = [{ commit: head, old: null as string | null }, ...handed].find(one => budgeted(repo, ["merge-base", "--is-ancestor", one.commit, ref]) !== null);
      if (on === undefined) return null;
      const reverted = on.old !== null && revertedOnBranch(repo, ref, { old: on.old, commit: on.commit }, budgeted);
      return `Landed on ${ref.slice("refs/heads/".length)} (${short(on.commit)})${reverted ? " · a later commit reverted it" : ""}`;
    }
    // landedStanding: landed only for this exact result.
    if (head === null || record.candidate !== head) return null;
    const reverted = revertedOnBranch(repo, record.ref, record, budgeted);
    return `Landed on ${record.ref.replace(/^refs\/heads\//, "")} (${short(record.commit)})${reverted ? " · a later commit reverted it" : ""}`;
  }
}
