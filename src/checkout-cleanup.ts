/**
 * Checkout cleanup (Settings → Storage, `toolroll storage clean`): which task checkouts can go, and removing them.
 *
 * A finished task's clean checkout goes as the setting says: when its task is complete or cancelled (the default),
 * 2 days or a week after that, or never (only a clean-up by hand). A clean-up by hand doesn't wait for the setting.
 * Only the working copy goes: its branch, and so every commit, stays, and a later lease of the branch makes a new one.
 *
 * Kept until idle (below): one whose task isn't finished (on hold, failed, a revision under way) and a result still
 * waiting for review. Always kept: a checkout in use, one with changes (files Toolroll wrote itself aside), and one
 * with commits on no branch. A release check's checkout (a deploy installs from it) goes once its task is complete, with its dependency
 * install and journey output, except the one deployed now and the project's newest complete one still waiting for its
 * deploy (no deploy since it was complete; at most a week). A superseded or cancelled gate goes at once, whatever its
 * task's state (staged releases keep the rollback copy). A checkout no task names (adopted after a crash) goes only
 * in a clean-up by hand. Every removal is in the ledger.
 *
 * Idle checkouts go too (the idle limit, 14 days by default): one whose whole task family has been idle that long (no
 * run, no person's act, no open lease) goes even with its result waiting for review or its task unfinished, in the
 * storage sweep's child only, never in a clean-up by hand, and only when `WorktreePool.proveRecreatable` says nothing is lost.
 * Nothing needs that working copy: a result page, Accept, Send back and Run checks read saved evidence and the branch,
 * and a retry, revision or resume leases the branch, which makes a new one. Excluded, because that can't be proven: a
 * release gate (a deploy installs from its checkout), work from an external tracker, and a checkout no task names. A
 * checkout with uncommitted changes is never removed by this; it is listed for a person.
 *
 * A kept checkout waiting for review or with changes drops its dependencies and build output once its run ends
 * (`slimKeptCheckouts`); the next run's setup restores them.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { taskBranches } from "./names.js";
import { COMPLETION_ACTION } from "./result-completion.js";
import { CLEANUP_CHOICES, IDLE_CHOICES, bytesWords, diskBytes, diskBytesAsync, type CheckoutCleanup, type CheckoutIdle } from "./storage.js";
import { checkoutIdle, type Store, type WorktreeRow } from "./store.js";
import { worktreePath, type WorktreePool } from "./worktree.js";

const DAY_MS = 86_400_000;
/** A release candidate's checkout holds the build a deploy installs: the newest complete one waits at most a week for it. */
export const CANDIDATE_KEEP_MS = 7 * DAY_MS;
/** The worker's pass removes at most this many; a clean-up by hand has no cap. */
export const AUTO_MAX = 20;
/** Git inspections at once. */
const INSPECT_AT_ONCE = 8;

export type KeepWhy =
  | "in use" | "task not finished" | "waiting for review" | "release candidate"
  | "has changes" | "has commits" | "not on its branch" | "unreadable" | "git refused" | "not due yet" | "cleanup is off" | "no task"
  /** A clean-up by hand leaves it; the next sweep takes it. */
  | "idle";

export type CheckoutItem = {
  path: string; repo: string; branch: string; taskId: string | null; bytes: number; releasedAt: string | null;
  /** null: it goes. */
  why: KeepWhy | null;
  /** With "not due yet" or "release candidate": when it may go. */
  dueAt?: string;
  /** Past the idle limit: when its task last saw any activity. */
  idleSince?: string;
};

export type CheckoutPlan = {
  at: string; cleanup: CheckoutCleanup; idle: CheckoutIdle; manual: boolean;
  go: CheckoutItem[]; stay: CheckoutItem[];
  /** Every checkout on disk. */
  count: number; totalBytes: number; freeBytes: number;
  waitingReview: number; withChanges: number;
  /** What the next sweep's idle cleanup takes. */
  idleCount: number; idleBytes: number;
};

type Status = { keep: KeepWhy | null; taskId: string; finishedAt: string | null; dueAt?: string; atOnce?: boolean };

/** The release a deploy installed last (staged-upgrades/<stage>/deployment.json at phase "deployed"): its commit and
 * builder run. A deploy runs from the gate's checkout, so that checkout stays while it is what runs. */
export type Deployed = { head: string | null; run: number | null; at?: string | null };

export function deployedRelease(stateDir: string | null): Deployed | null {
  if (stateDir === null) return null;
  const root = join(stateDir, "staged-upgrades");
  let newest: { at: string; head: string | null; run: number | null } | null = null;
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return null; }
  for (const name of names) {
    let journal: Record<string, unknown>;
    try { journal = JSON.parse(readFileSync(join(root, name, "deployment.json"), "utf8")) as Record<string, unknown>; } catch { continue; }
    if (journal["phase"] !== "deployed") continue;
    const at = typeof journal["deployedAt"] === "string" ? journal["deployedAt"] : typeof journal["updatedAt"] === "string" ? journal["updatedAt"] : "";
    if (newest !== null && newest.at >= at) continue;
    newest = { at, head: typeof journal["candidate"] === "string" ? journal["candidate"] : null, run: Number.isSafeInteger(journal["builder"]) ? Number(journal["builder"]) : null };
  }
  return newest === null ? null : { head: newest.head, run: newest.run, at: newest.at === "" ? null : newest.at };
}

/** The folder beside the database (where staged releases live), or null for a database in memory. */
function stateDirOf(store: Store): string | null {
  const main = store.handle.prepare("PRAGMA database_list").all().find(row => row["name"] === "main");
  return typeof main?.["file"] === "string" && main["file"] !== "" ? dirname(main["file"]) : null;
}

/**
 * Which release a gate belongs to: a failed gate is re-filed as the same name plus a letter (`release-x`, then
 * `release-xb`, `release-xc` …), so a gate whose name is another gate's in the same project plus one letter is that
 * release's.
 */
export function releaseOf(id: string, gates: ReadonlySet<string>): string {
  return /[b-z]$/.test(id) && gates.has(id.slice(0, -1)) ? id.slice(0, -1) : id;
}
const STRENGTH: Record<string, number> = { "in use": 5, "task not finished": 4, "waiting for review": 3, "release candidate": 2 };
const strength = (one: Status | undefined) => one === undefined ? -1 : one.keep === null ? 0 : STRENGTH[one.keep] ?? 1;
const stronger = (a: Status | undefined, b: Status | undefined) =>
  strength(b) > strength(a) || (strength(b) === 0 && strength(a) === 0 && (b!.finishedAt ?? "") > (a!.finishedAt ?? "")) ? b : a;

/** Where every task stands for cleanup, by task_ref id and by each branch it or its runs used. */
export function taskStatuses(store: Store, now: Date, deployed?: Deployed | null): { byRef: Map<number, Status>; byBranch: Map<string, Status> } {
  const db = store.handle;
  const refs = db.prepare(`SELECT r.id AS ref, r.external_id AS id, r.revision_of AS revision_of, t.state AS state, t.updated_at AS updated_at,
      EXISTS (SELECT 1 FROM hold h WHERE h.task_ref = r.id) AS held,
      EXISTS (SELECT 1 FROM run live WHERE live.task_ref = r.id AND live.finished_at IS NULL) AS live,
      (SELECT MAX(s.candidate) FROM task_scope s WHERE s.task_id = r.external_id) AS candidate, r.repo AS repo
    FROM task_ref r LEFT JOIN task t ON t.id = r.external_id AND r.backend = 'built-in'`).all();
  const runs = db.prepare("SELECT id, task_ref, branch FROM run").all();
  const refOfRun = new Map(runs.map(row => [Number(row["id"]), Number(row["task_ref"])]));
  // Release candidates: per project and release, the newest gate not cancelled; and the one deployed.
  const gates = refs.filter(row => row["candidate"] !== null);
  const gateIds = new Map<string, Set<string>>();
  for (const row of gates) { const repo = String(row["repo"]); gateIds.set(repo, (gateIds.get(repo) ?? new Set()).add(String(row["id"]))); }
  const releaseKey = (row: Record<string, unknown>) => `${String(row["repo"])}\u0000${releaseOf(String(row["id"]), gateIds.get(String(row["repo"]))!)}`;
  const newestGate = new Map<string, number>();
  for (const row of gates) {
    if (row["state"] === "cancelled") continue;
    const key = releaseKey(row);
    newestGate.set(key, Math.max(newestGate.get(key) ?? -1, Number(row["ref"])));
  }
  const live = deployed === undefined ? deployedRelease(stateDirOf(store)) : deployed;
  const deployedRef = live === null ? undefined : live.run !== null ? refOfRun.get(live.run) : undefined;
  const isDeployed = (row: Record<string, unknown>) => live !== null &&
    (Number(row["ref"]) === deployedRef || (live.head !== null && String(row["candidate"]) === live.head));
  // The completion names its family's root; its run names the result it completes.
  const completed = new Map<string, string>();
  const completedRef = new Map<number, string>();
  for (const row of db.prepare("SELECT task_id, run_id, at FROM action_ledger WHERE action = ?").all(COMPLETION_ACTION)) {
    const at = String(row["at"]);
    if (row["task_id"] !== null) { const id = String(row["task_id"]); if ((completed.get(id) ?? "") < at) completed.set(id, at); }
    const ref = row["run_id"] === null ? undefined : refOfRun.get(Number(row["run_id"]));
    if (ref !== undefined && (completedRef.get(ref) ?? "") < at) completedRef.set(ref, at);
  }
  const completedAtOf = (row: Record<string, unknown>) => [completed.get(String(row["id"])), completedRef.get(Number(row["ref"]))].filter((one): one is string => one !== undefined).sort().at(-1) ?? null;
  // Per project, the newest complete gate (by when it was complete): the one a deploy may still be about to install.
  // Once the project deployed after it was complete, it waits for nothing.
  const deployedRepo = deployedRef === undefined ? (live?.head == null ? undefined : gates.find(row => String(row["candidate"]) === live.head)?.["repo"]) : refs.find(row => Number(row["ref"]) === deployedRef)?.["repo"];
  const newestDone = new Map<string, { ref: number; at: string }>();
  for (const row of gates) {
    if (row["state"] !== "done") continue;
    const at = completedAtOf(row) ?? (row["updated_at"] === null ? "" : String(row["updated_at"]));
    const seen = newestDone.get(String(row["repo"]));
    if (seen === undefined || at > seen.at || (at === seen.at && Number(row["ref"]) > seen.ref)) newestDone.set(String(row["repo"]), { ref: Number(row["ref"]), at });
  }
  const byRef = new Map<number, Status>();
  const byId = new Map<string, Status>();
  const parentOf = new Map<string, string>();
  for (const row of refs) {
    const ref = Number(row["ref"]);
    const id = String(row["id"]);
    const state = row["state"] === null ? null : String(row["state"]);
    const updated = row["updated_at"] === null ? null : String(row["updated_at"]);
    const gate = row["candidate"] !== null;
    let status: Status;
    if (Number(row["live"]) === 1) status = { keep: "in use", taskId: id, finishedAt: null };
    else if (gate && isDeployed(row)) status = { keep: "release candidate", taskId: id, finishedAt: updated };
    // A superseded or cancelled gate goes at once, whatever its task's state: a newer gate (or none) is the release.
    else if (gate && (state === "cancelled" || newestGate.get(releaseKey(row)) !== ref)) status = { keep: null, taskId: id, finishedAt: updated, atOnce: true };
    else if (state === null || Number(row["held"]) === 1 || (state !== "done" && state !== "cancelled")) status = { keep: "task not finished", taskId: id, finishedAt: null };
    else if (state === "cancelled") status = { keep: null, taskId: id, finishedAt: updated };
    else {
      const completedAt = completedAtOf(row);
      if (gate) {
        const since = completedAt ?? updated ?? now.toISOString();
        const until = new Date(Date.parse(since) + CANDIDATE_KEEP_MS).toISOString();
        const deployedSince = live?.at != null && deployedRepo !== undefined && String(row["repo"]) === String(deployedRepo) && live.at >= since;
        const waiting = newestDone.get(String(row["repo"]))?.ref === ref && !deployedSince && until > now.toISOString();
        status = waiting ? { keep: "release candidate", taskId: id, finishedAt: since, dueAt: until } : { keep: null, taskId: id, finishedAt: since, atOnce: true };
      } else status = completedAt === null ? { keep: "waiting for review", taskId: id, finishedAt: null } : { keep: null, taskId: id, finishedAt: completedAt };
    }
    byRef.set(ref, status);
    byId.set(id, stronger(byId.get(id), status)!);
    if (row["revision_of"] !== null) parentOf.set(id, String(row["revision_of"]));
  }
  // A revision under way keeps what its ancestors worked on: it builds on their branch.
  for (const [id, status] of byId) {
    if (status.keep === null || status.keep === "release candidate") continue;
    const seen = new Set([id]);
    for (let parent = parentOf.get(id); parent !== undefined && !seen.has(parent); parent = parentOf.get(parent)) {
      seen.add(parent);
      const lifted = { ...status, taskId: parent };
      byId.set(parent, stronger(byId.get(parent), lifted)!);
    }
  }
  for (const row of refs) byRef.set(Number(row["ref"]), stronger(byRef.get(Number(row["ref"])), { ...byId.get(String(row["id"]))!, taskId: String(row["id"]) })!);
  const byBranch = new Map<string, Status>();
  const note = (branch: string, status: Status) => byBranch.set(branch, stronger(byBranch.get(branch), status)!);
  for (const row of refs) for (const branch of taskBranches(String(row["id"]))) note(branch, byRef.get(Number(row["ref"]))!);
  for (const row of runs) {
    if (row["branch"] === null) continue;
    const status = byRef.get(Number(row["task_ref"]));
    if (status !== undefined) note(String(row["branch"]), status);
  }
  return { byRef, byBranch };
}

/** Where one checkout's task stands: by its task, its branch, or (branch unknown) the name a lease of a branch would give it. */
function statusOf(row: WorktreeRow, statuses: ReturnType<typeof taskStatuses>): Status | undefined {
  let found = stronger(row.taskRef === null ? undefined : statuses.byRef.get(row.taskRef), statuses.byBranch.get(row.branch));
  if (found === undefined) {
    const name = basename(row.path);
    for (const [branch, status] of statuses.byBranch) if (basename(worktreePath("/", row.repo, branch)) === name) found = stronger(found, status);
  }
  return found;
}

/** The let-go checkouts whose task is complete or cancelled, and when it finished. Not a release candidate's that
 * stays: a deploy runs from it. */
export function finishedCheckouts(store: Store, now: Date, repo?: string): { row: WorktreeRow; taskId: string | null; finishedAt: string }[] {
  const statuses = taskStatuses(store, now);
  return store.listWorktrees().filter(row => row.releasedAt !== null && row.runner === null && (repo === undefined || row.repo === repo)).flatMap(row => {
    const status = statusOf(row, statuses);
    if (status === undefined || status.finishedAt === null || status.keep !== null) return [];
    return [{ row, taskId: status.taskId, finishedAt: status.finishedAt }];
  });
}

/** Toolroll's own bookkeeping about a task: none of it is anyone using the task. Every other ledger entry counts as activity. */
const NOT_ACTIVITY = ["assignment status baseline", "assignment status observed", "task archived", "checkout removed", "checkout slimmed", "checkout processes stopped",
  "run processes stopped", "orphan process stopped", "process observation failed", "process witness settled", "branch deleted", "landed work cleaned up"];

/** The newest activity of a task's whole family, and whether something rules idle cleanup out for it. */
type IdleFact = { activeAt: string; blocked: boolean };
export type IdleFacts = { byRef: Map<number, IdleFact>; byBranch: Map<string, IdleFact> };

/**
 * When each task family last saw a run, a person's act or a lease, read in one pass. A revision builds on what it
 * revises, so a family is idle together. `blocked`: an open run, an unreleased claim, a release gate, or a task only an
 * external tracker knows, in the family.
 */
export function idleFacts(store: Store): IdleFacts {
  const db = store.handle;
  const refs = db.prepare(`SELECT r.id AS ref, r.external_id AS id, r.revision_of AS revision_of, t.state AS state, t.created_at AS created_at, t.updated_at AS updated_at,
      (SELECT MAX(s.candidate) FROM task_scope s WHERE s.task_id = r.external_id) AS candidate
    FROM task_ref r LEFT JOIN task t ON t.id = r.external_id AND r.backend = 'built-in'`).all();
  const parentOf = new Map(refs.filter(row => row["revision_of"] !== null).map(row => [String(row["id"]), String(row["revision_of"])]));
  const rootOf = (id: string): string => {
    const seen = new Set([id]);
    let root = id;
    for (let parent = parentOf.get(root); parent !== undefined && !seen.has(parent); parent = parentOf.get(root)) { seen.add(parent); root = parent; }
    return root;
  };
  const families = new Map<string, IdleFact>();
  const rootByRef = new Map<number, string>();
  const rootsById = new Map<string, string>();
  const note = (root: string | undefined, at: unknown, blocked = false) => {
    if (root === undefined) return;
    const fact = families.get(root) ?? { activeAt: "", blocked: false };
    if (typeof at === "string" && at > fact.activeAt) fact.activeAt = at;
    if (blocked) fact.blocked = true;
    families.set(root, fact);
  };
  for (const row of refs) {
    const id = String(row["id"]), root = rootOf(id);
    rootByRef.set(Number(row["ref"]), root);
    rootsById.set(id, root);
    note(root, row["created_at"]);
    note(root, row["updated_at"], row["state"] === null || row["candidate"] !== null);
  }
  const byTaskRef = (at: unknown, ref: unknown, blocked = false) => note(rootByRef.get(Number(ref)), at, blocked);
  const runRoot = new Map<number, string | undefined>();
  const branches: [string, string][] = [];
  for (const row of db.prepare("SELECT id, task_ref, branch, started_at, finished_at FROM run").all()) {
    const root = rootByRef.get(Number(row["task_ref"]));
    runRoot.set(Number(row["id"]), root);
    note(root, row["started_at"], row["finished_at"] === null);
    note(root, row["finished_at"]);
    if (root !== undefined && row["branch"] !== null) branches.push([String(row["branch"]), root]);
  }
  for (const row of db.prepare("SELECT task_ref, acquired_at, heartbeat_at, released_at FROM claim").all()) {
    for (const at of [row["acquired_at"], row["heartbeat_at"], row["released_at"]]) byTaskRef(at, row["task_ref"]);
    byTaskRef(null, row["task_ref"], row["released_at"] === null);
  }
  for (const row of db.prepare("SELECT task_ref, held_at AS at FROM hold UNION ALL SELECT task_ref, created_at FROM task_steer UNION ALL SELECT task_ref, at FROM task_act").all()) byTaskRef(row["at"], row["task_ref"]);
  for (const row of db.prepare("SELECT run, created_at AS at FROM run_note UNION ALL SELECT run, created_at FROM diff_comment UNION ALL SELECT run, created_at FROM decision UNION ALL SELECT run, answered_at FROM decision").all()) {
    note(runRoot.get(Number(row["run"])), row["at"]);
  }
  for (const row of db.prepare(`SELECT task_id, run_id, MAX(at) AS at FROM action_ledger WHERE (task_id IS NOT NULL OR run_id IS NOT NULL)
    AND action NOT IN (SELECT value FROM json_each(?)) GROUP BY task_id, run_id`).all(JSON.stringify(NOT_ACTIVITY))) {
    if (row["task_id"] !== null) note(rootsById.get(String(row["task_id"])), row["at"]);
    if (row["run_id"] !== null) note(runRoot.get(Number(row["run_id"])), row["at"]);
  }
  const byRef = new Map<number, IdleFact>();
  for (const [ref, root] of rootByRef) byRef.set(ref, families.get(root)!);
  // A branch answers for every family that used it: the newest activity and any block among them.
  const byBranch = new Map<string, IdleFact>();
  const share = (branch: string, root: string) => {
    const one = families.get(root)!, seen = byBranch.get(branch);
    byBranch.set(branch, seen === undefined ? { ...one } : { activeAt: seen.activeAt > one.activeAt ? seen.activeAt : one.activeAt, blocked: seen.blocked || one.blocked });
  };
  for (const row of refs) for (const branch of taskBranches(String(row["id"]))) share(branch, rootOf(String(row["id"])));
  for (const [branch, root] of branches) share(branch, root);
  return { byRef, byBranch };
}

/** The idle limit in days as it stands: null when idle cleanup is off (the limit, or automatic cleanup altogether). */
function idleDays(store: Store): number | null {
  return store.checkoutCleanup() === "never" ? null : IDLE_CHOICES.find(one => one.value === checkoutIdle(store))!.days;
}

/** When this checkout's task last saw activity, when that is past the limit and only its task's standing keeps it; else null. */
function idleSince(pool: WorktreePool, row: WorktreeRow, statuses: ReturnType<typeof taskStatuses>, facts: IdleFacts, days: number | null, now: Date): string | null {
  if (days === null || row.taskRef === null || row.branch === "unknown" || row.releasedAt === null || row.runner !== null || pool.inUse(row.path).held) return null;
  const keep = statusOf(row, statuses)?.keep;
  if (keep !== "waiting for review" && keep !== "task not finished") return null;
  const own = facts.byRef.get(row.taskRef), shared = facts.byBranch.get(row.branch);
  if (own === undefined || own.blocked || shared?.blocked === true) return null;
  const since = [own.activeAt, shared?.activeAt, row.createdAt, row.leasedAt, row.releasedAt].filter((one): one is string => typeof one === "string").sort().at(-1)!;
  return Date.parse(since) + days * DAY_MS <= now.getTime() ? since : null;
}

/** Every commit a task's runs recorded on this checkout or its branch: what `proveRecreatable` must find on a branch. */
function recordedHeads(store: Store, row: WorktreeRow): string[] {
  return store.handle.prepare("SELECT DISTINCT head_revision AS head FROM run WHERE (branch = ? OR worktree = ?) AND head_revision IS NOT NULL").all(row.branch, row.path).map(one => String(one["head"]));
}

/** Why a checkout stays before anyone looks at its files, or null: it may go (as far as its task and the setting say). */
function keptFor(pool: WorktreePool, row: WorktreeRow, statuses: ReturnType<typeof taskStatuses>, now: Date, cleanup: CheckoutCleanup | "manual"): { why: KeepWhy | null; dueAt?: string; taskId: string | null } {
  const status = statusOf(row, statuses);
  const taskId = status?.taskId ?? null;
  if (row.releasedAt === null || row.runner !== null || pool.inUse(row.path).held) return { why: "in use", taskId };
  if (status !== undefined && status.keep !== null) return { why: status.keep, taskId, ...(status.dueAt === undefined ? {} : { dueAt: status.dueAt }) };
  if (cleanup === "manual") return { why: null, taskId };
  // A checkout no task names (adopted after a crash, say) has no task to finish: only a clean-up by hand takes it.
  if (status === undefined) return { why: "no task", taskId };
  if (cleanup === "finished") return { why: null, taskId };
  if (cleanup === "never") return { why: "cleanup is off", taskId };
  if (status.atOnce === true) return { why: null, taskId };
  const days = CLEANUP_CHOICES.find(one => one.value === cleanup)!.days!;
  const since = [status.finishedAt, row.releasedAt].filter((one): one is string => one !== null).sort().at(-1)!;
  const dueAt = new Date(Date.parse(since) + days * DAY_MS).toISOString();
  return dueAt > now.toISOString() ? { why: "not due yet", taskId, dueAt } : { why: null, taskId };
}

/** Why a checkout stays as a clean-up by hand reads it (in use, or its task not done with it), before its files; null: it may go. */
export function checkoutKeepWhy(pool: WorktreePool, row: WorktreeRow, statuses: ReturnType<typeof taskStatuses>, now: Date): KeepWhy | null {
  return keptFor(pool, row, statuses, now, "manual").why;
}

async function eachAtMost<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const at = next++; out[at] = await work(items[at]!); }
  }));
  return out;
}

/**
 * What a clean-up would remove now, how much space it would free, and what stays and why. `manual` is a clean-up by
 * hand (it doesn't wait for the setting); otherwise it is the worker's pass under the setting. Reads only.
 */
export async function checkoutPlan(store: Store, pool: WorktreePool, now: Date, options: { manual: boolean; repo?: string }): Promise<CheckoutPlan> {
  const cleanup = store.checkoutCleanup();
  const rows = store.listWorktrees().filter(row => existsSync(row.path) && (options.repo === undefined || row.repo === options.repo));
  const sizes = await diskBytesAsync(rows.map(row => row.path));
  const statuses = taskStatuses(store, now);
  const days = idleDays(store);
  const facts = idleFacts(store);
  const items = await eachAtMost(rows, INSPECT_AT_ONCE, async (row): Promise<CheckoutItem> => {
    const kept = keptFor(pool, row, statuses, now, options.manual ? "manual" : cleanup);
    let why = kept.why;
    if (why === null) { const found = await pool.inspect(row.path); why = found === "clean" ? null : found; }
    const since = kept.why === null ? null : idleSince(pool, row, statuses, facts, days, now);
    if (since !== null) {
      const found = await pool.inspect(row.path);
      const proven = found === "clean" ? await pool.proveRecreatable(row, recordedHeads(store, row)) : found;
      why = proven !== "clean" ? proven : options.manual ? "idle" : null;
    }
    return { path: row.path, repo: row.repo, branch: row.branch, taskId: kept.taskId, bytes: sizes.get(row.path) ?? 0, releasedAt: row.releasedAt, why,
      ...(kept.dueAt === undefined ? {} : { dueAt: kept.dueAt }), ...(since === null ? {} : { idleSince: since }) };
  });
  const go = items.filter(one => one.why === null).sort((a, b) => b.bytes - a.bytes);
  const stay = items.filter(one => one.why !== null).sort((a, b) => (a.why ?? "").localeCompare(b.why ?? "") || b.bytes - a.bytes);
  const idle = items.filter(one => one.idleSince !== undefined && (one.why === null || one.why === "idle"));
  return {
    at: now.toISOString(), cleanup, idle: checkoutIdle(store), manual: options.manual, go, stay,
    count: items.length, totalBytes: items.reduce((sum, one) => sum + one.bytes, 0), freeBytes: go.reduce((sum, one) => sum + one.bytes, 0),
    waitingReview: stay.filter(one => one.why === "waiting for review").length, withChanges: stay.filter(one => one.why === "has changes").length,
    idleCount: idle.length, idleBytes: idle.reduce((sum, one) => sum + one.bytes, 0),
  };
}

/** Names exactly what a preview would remove, so a confirmation removes that and nothing else. */
export function previewDigest(plan: Pick<CheckoutPlan, "go">): string {
  return createHash("sha256").update(plan.go.map(one => one.path).sort().join("\u0000"), "utf8").digest("hex").slice(0, 32);
}

export type CleanResult = { removed: CheckoutItem[]; kept: { path: string; why: KeepWhy }[]; freed: number;
  /** The worker's pass stopped at AUTO_MAX: more may be due, and the sweep comes back an hour later. */
  more?: boolean };

/**
 * Remove what may go: the worker's pass (`manual` false: under the setting, at most AUTO_MAX, one repository) or a
 * clean-up by hand (no cap, every repository). Each checkout is asked again right before it goes; each removal is in
 * the ledger. Idle checkouts go only with `idle`, the storage sweep's child (never the service's own pass, whose git
 * and du must not hold up its heartbeats): each is judged again from a fresh read of its task and its family's
 * activity, `spare` (live work), the OS's list of what runs in the folder, and `proveRecreatable`, inside its reservation.
 */
export async function cleanCheckouts(store: Store, pool: WorktreePool, now: () => Date, options: { manual: boolean; actor: string; repo?: string; only?: ReadonlySet<string>; spare?: (path: string) => boolean;
  /** The storage sweep's child only: idle checkouts go too. `occupied` asks the OS whether any process works in a folder. */
  idle?: { occupied: (path: string) => boolean } }): Promise<CleanResult> {
  const cleanup = store.checkoutCleanup();
  if (!options.manual && cleanup === "never") return { removed: [], kept: [], freed: 0 };
  // `only`: the checkouts a person saw in the preview; nothing they didn't see goes.
  const rows = store.listWorktrees().filter(row => existsSync(row.path) && (options.repo === undefined || row.repo === options.repo) && (options.only === undefined || options.only.has(row.path)));
  let statuses = taskStatuses(store, now());
  const days = options.idle === undefined ? null : idleDays(store);
  let facts: IdleFacts = days === null ? { byRef: new Map(), byBranch: new Map() } : idleFacts(store);
  // The checkouts going for being idle, and since when: judged at every look, so a task coming back drops out.
  const idle = new Map<string, string>();
  const mayGo = (row: WorktreeRow): boolean => {
    idle.delete(row.path);
    if (keptFor(pool, row, statuses, now(), options.manual ? "manual" : cleanup).why === null) return options.spare?.(row.path) !== true;
    const since = idleSince(pool, row, statuses, facts, days, now());
    if (since === null) return false;
    idle.set(row.path, since);
    return options.spare?.(row.path) !== true;
  };
  const refresh = () => { statuses = taskStatuses(store, now()); if (days !== null) facts = idleFacts(store); };
  const sizes = new Map<string, number>();
  const wanted = (row: WorktreeRow, fresh: boolean): boolean => {
    // Right before a checkout goes, where its task stands is read afresh, and its size taken for the ledger.
    // `spare`: live work uses it (storage-sweep.ts), asked at both looks.
    if (fresh) refresh();
    const go = mayGo(row);
    if (go && fresh) {
      sizes.set(row.path, diskBytes([row.path]).get(row.path) ?? 0);
      // du can be slow. The reservation excludes a concurrent checkout lease, and this last read also catches
      // an open run/claim or task change that arrived while size was measured in the sweep child.
      refresh();
      return mayGo(row) && !(idle.has(row.path) && options.idle?.occupied(row.path) === true);
    }
    return go;
  };
  const proof = async (row: WorktreeRow) => idle.has(row.path) ? pool.proveRecreatable(row, recordedHeads(store, row)) : "clean" as const;
  const max = options.manual ? Infinity : AUTO_MAX;
  const pruned = await pool.prune(rows, wanted, max, undefined, proof);
  const removed: CheckoutItem[] = [];
  for (const row of pruned.removed) {
    const taskId = row.taskRef === null ? null : store.externalIdFor(row.taskRef);
    const bytes = sizes.get(row.path) ?? 0;
    const since = idle.get(row.path);
    removed.push({ path: row.path, repo: row.repo, branch: row.branch, taskId, bytes, releasedAt: row.releasedAt, why: null, ...(since === undefined ? {} : { idleSince: since }) });
    store.recordAction({ at: now().toISOString(), actor: options.actor, repo: row.repo, taskId, runId: null, action: "checkout removed", outcome: "removed",
      source: options.manual ? "request" : "work", detail: `${basename(row.path)} (${since === undefined ? "" : `idle since ${since.slice(0, 10)}, `}released ${row.releasedAt?.slice(0, 10) ?? "?"}, about ${bytesWords(bytes)}); branch ${row.branch} kept` });
  }
  return { removed, kept: pruned.kept, freed: removed.reduce((sum, one) => sum + one.bytes, 0), ...(pruned.removed.length >= max ? { more: true } : {}) };
}

export type SlimResult = { slimmed: { path: string; taskId: string | null; dropped: string[]; bytes: number }[] };

/** Checkouts this process already looked at since they were let go (path and release time): looked at once. */
const looked = new Set<string>();

/**
 * A kept checkout (its result waiting for review, or with changes) drops its dependencies and build output once its
 * run has ended; the next run's setup restores them (node_modules only goes where the project has a setup to restore
 * it). Never one in use or a release candidate (a deploy installs from it). Each in the ledger.
 */
export async function slimKeptCheckouts(store: Store, pool: WorktreePool, now: () => Date, options: { actor: string; repo?: string }): Promise<SlimResult> {
  const rows = store.listWorktrees().filter(row => row.releasedAt !== null && row.runner === null && (options.repo === undefined || row.repo === options.repo)
    && !looked.has(`${row.path}\u0000${row.releasedAt}`) && existsSync(row.path));
  const slimmed: SlimResult["slimmed"] = [];
  if (rows.length === 0) return { slimmed };
  const keptAs = (row: WorktreeRow) => keptFor(pool, row, taskStatuses(store, now()), now(), "manual");
  const statuses = taskStatuses(store, now());
  for (const row of rows) {
    const kept = keptFor(pool, row, statuses, now(), "manual");
    if (kept.why === "in use") continue;
    looked.add(`${row.path}\u0000${row.releasedAt}`);
    if (kept.why === "release candidate") continue;
    if (kept.why !== "waiting for review" && await pool.inspect(row.path) !== "has changes") continue;
    const wanted = (fresh: WorktreeRow) => { const why = keptAs(fresh).why; return why !== "in use" && why !== "release candidate"; };
    const done = await pool.slim(row, wanted, store.liveWorktreeSetup(row.repo) !== null);
    if (!done.ok || done.dropped.length === 0) continue;
    const bytes = done.bytes;
    slimmed.push({ path: row.path, taskId: kept.taskId, dropped: done.dropped, bytes });
    store.recordAction({ at: now().toISOString(), actor: options.actor, repo: row.repo, taskId: kept.taskId, runId: null, action: "checkout slimmed", outcome: "removed", source: "work",
      detail: `${basename(row.path)}: dropped ${done.dropped.join(", ")}${bytes > 0 ? ` (about ${bytesWords(bytes)})` : ""}; the next run's setup restores them` });
  }
  return { slimmed };
}

/** Throw away a checkout kept for its changes, on purpose; its branch stays. In the ledger. */
export async function discardCheckout(store: Store, pool: WorktreePool, path: string, now: Date, actor: string): Promise<{ ok: true; bytes: number } | { ok: false; message: string }> {
  const bytes = existsSync(path) ? diskBytes([path]).get(path) ?? 0 : 0;
  const done = await pool.discardChanges(path);
  if (!done.ok) return done;
  const taskId = done.row.taskRef === null ? null : store.externalIdFor(done.row.taskRef);
  store.recordAction({ at: now.toISOString(), actor, repo: done.row.repo, taskId, runId: null, action: "checkout discarded", outcome: "removed", source: "request",
    detail: `${basename(path)} and its uncommitted changes (about ${bytesWords(bytes)}); branch ${done.row.branch} kept` });
  return { ok: true, bytes };
}

/** "Waiting for review", "Has changes" … as a sentence fragment for a person. */
export function whyWords(item: Pick<CheckoutItem, "why" | "dueAt" | "idleSince">): string {
  switch (item.why) {
    case null: return "goes";
    case "in use": return "in use";
    case "task not finished": return "its task isn't finished";
    case "waiting for review": return "its result is waiting for review";
    case "release candidate": return item.dueAt === undefined ? "the deployed release candidate" : `newest release candidate, kept for its deploy until ${item.dueAt.slice(0, 10)}`;
    case "has changes": return "has changes";
    case "has commits": return "has commits on no branch";
    case "not on its branch": return "isn't on its task's branch";
    case "idle": return `idle since ${item.idleSince?.slice(0, 10) ?? "a while"}; the next sweep removes it`;
    case "unreadable": return "git couldn't read it";
    case "git refused": return "git wouldn't remove it";
    case "not due yet": return `due ${item.dueAt?.slice(0, 10) ?? "later"}`;
    case "cleanup is off": return "automatic cleanup is off";
    case "no task": return "no task names it; only a clean-up by hand removes it";
  }
}
