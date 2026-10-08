/**
 * Retention (v105): how long Toolroll keeps run evidence and logs,
 * finished checkouts' records, chat messages and notifications. Until an
 * instance operator chooses a period, evidence is kept 28 days and every
 * other kind forever; a daily sweep deletes what is older than its period
 * and writes one action ledger entry saying what went and about how much
 * space it freed.
 *
 * Never deleted, whatever the settings: the action ledger (it is append-only),
 * and anything a task still needs. A task still needs its things until it is
 * cancelled, or done with its result marked complete: an unfinished task
 * (failed included: it can be requeued), a result not yet completed, a task
 * on hold, one with a live run, a release candidate, and the source of an
 * unfinished revision all keep theirs.
 *
 * Evidence goes as files: a run's evidence folder is emptied and a note left
 * in it, so its pages say the files were removed by retention rather than
 * damaged. Its database records (hashes, sizes, how each was captured) stay.
 */
import { existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RETENTION_NOTE } from "./evidence.js";
import { COMPLETION_ACTION } from "./result-completion.js";
import { bytesWords, treeBytes } from "./storage.js";
import type { Database, Store } from "./store.js";
import { RETENTION_DAYS, retentionDaysSchema, retentionKindSchema, type RetentionKind, type RetentionPeriods } from "./contracts/retention.js";

const RETENTION_TABLE = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  kind       TEXT PRIMARY KEY CHECK (kind IN ('evidence', 'checkouts', 'chat', 'notifications')),
  -- NULL is forever; a row only exists once someone chose.
  days       INTEGER CHECK (days IS NULL OR (days >= 1 AND days <= 3650)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
export const RETENTION_SCHEMA = RETENTION_TABLE("retention_setting");

/** A file from before 1-day evidence keeps `days >= 7` in its CHECK: rebuild the table with the wider one, keeping
 * every row, in one transaction. A file already widened is untouched. */
export function widenRetentionSchema(db: Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'retention_setting'").get();
  if (row === undefined || !/days\s*>=\s*7\b/.test(String(row["sql"]))) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(RETENTION_TABLE("retention_setting_next"));
    db.exec("INSERT INTO retention_setting_next (kind, days, updated_by, updated_at) SELECT kind, days, updated_by, updated_at FROM retention_setting");
    db.exec("DROP TABLE retention_setting");
    db.exec("ALTER TABLE retention_setting_next RENAME TO retention_setting");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type { RetentionKind, RetentionPeriods } from "./contracts/retention.js";

export const RETENTION_KINDS: readonly { kind: RetentionKind; label: string; detail: string }[] = [
  { kind: "evidence", label: "Run evidence and logs", detail: "Diffs, check logs, screenshots and reports saved for each run" },
  { kind: "checkouts", label: "Finished checkout records", detail: "Records of build checkouts that were let go and are no longer on disk" },
  { kind: "chat", label: "Chat messages", detail: "Messages in lead and team chats" },
  { kind: "notifications", label: "Notifications", detail: "Resolved notifications" },
];

/** The periods the page offers for each kind; the command line takes any number of days from 1 to 3650. */
const LONG_CHOICES: readonly (number | null)[] = [30, 90, 180, 365, 730, null];
export const PERIOD_CHOICES: Readonly<Record<RetentionKind, readonly (number | null)[]>> = {
  evidence: [1, 7, 14, 28, null], checkouts: LONG_CHOICES, chat: LONG_CHOICES, notifications: LONG_CHOICES,
};
export const MIN_DAYS = RETENTION_DAYS.min;
export const MAX_DAYS = RETENTION_DAYS.max;
const DAY_MS = 86_400_000;
/** A sweep is due once a day. */
export const SWEEP_EVERY_MS = DAY_MS;
/** At most this many runs, messages, notifications or records go per kind per sweep; the next sweep takes the rest. */
export const SWEEP_BATCH = 2000;
const SWEEP_CURSOR = "retention:last-sweep";

/** What each kind keeps until someone chooses: evidence 28 days, everything else forever. */
export const DEFAULT_PERIODS: RetentionPeriods = { evidence: 28, checkouts: null, chat: null, notifications: null };

export function isRetentionKind(value: string): value is RetentionKind {
  return retentionKindSchema.safeParse(value).success;
}

/** "forever", or a number of days ("90", "90d"), weeks ("12w") or years ("1y"); undefined when it's none of those or out of range. */
export function parsePeriod(text: string): number | null | undefined {
  const value = text.trim().toLowerCase();
  if (value === "forever" || value === "never") return null;
  const match = /^(\d{1,4})\s*(d|days?|w|weeks?|y|years?)?$/.exec(value);
  if (match === null) return undefined;
  const unit = match[2]?.[0] ?? "d";
  const days = Number(match[1]) * (unit === "y" ? 365 : unit === "w" ? 7 : 1);
  return retentionDaysSchema.safeParse(days).success ? days : undefined;
}

export function periodWords(days: number | null): string {
  if (days === null) return "forever";
  if (days % 365 === 0) return days === 365 ? "1 year" : `${days / 365} years`;
  return days === 1 ? "1 day" : `${days} days`;
}

/** What the page offers for `kind`, with `current` among them (in order) when it was set some other way. */
export function periodChoices(kind: RetentionKind, current: number | null): readonly (number | null)[] {
  const offered = PERIOD_CHOICES[kind];
  return offered.includes(current) ? offered : [...offered, current].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
}

/** A period as the page and `retention show` say it: "28 days (default)" when nobody chose, "30 days (custom)" when it's not one the page offers. */
export function periodLabel(kind: RetentionKind, days: number | null, chosen: boolean): string {
  const words = periodWords(days);
  const label = `${words[0]!.toUpperCase()}${words.slice(1)}`;
  if (!chosen) return `${label} (default)`;
  return PERIOD_CHOICES[kind].includes(days) ? label : `${label} (custom)`;
}

export type RetentionCount = { kind: RetentionKind; days: number | null; count: number; bytes: number; more: boolean };
export type RetentionPlan = { at: string; counts: RetentionCount[]; items: RetentionItems };
type RetentionItems = {
  evidence: { run: number; bytes: number }[];
  checkouts: { path: string; releasedAt: string; bytes: number }[];
  chat: { id: number; bytes: number }[];
  notifications: { id: number; bytes: number }[];
};

/** Tasks that no longer need anything kept: cancelled, or done with their result marked complete; not on hold, not
 * running, not a release candidate, and no revision below it (at any depth) still unfinished — cancelled or completed,
 * not merely Ready: a revision's review reads its ancestors' evidence. `r` is the task_ref alias. */
function finishedTask(r: string): string {
  return `EXISTS (SELECT 1 FROM task t WHERE t.id = ${r}.external_id AND ${r}.backend = 'built-in' AND (t.state = 'cancelled' OR (t.state = 'done' AND EXISTS (
      SELECT 1 FROM action_ledger a WHERE a.action = '${COMPLETION_ACTION}' AND (a.task_id = ${r}.external_id OR a.run_id IN (SELECT id FROM run WHERE task_ref = ${r}.id))))))
    AND NOT EXISTS (SELECT 1 FROM hold h WHERE h.task_ref = ${r}.id)
    AND NOT EXISTS (SELECT 1 FROM run live WHERE live.task_ref = ${r}.id AND live.finished_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM task_scope s WHERE s.task_id = ${r}.external_id AND s.candidate IS NOT NULL)
    AND NOT EXISTS (WITH RECURSIVE family(ext) AS (
        SELECT rv.external_id FROM task_ref rv WHERE rv.revision_of = ${r}.external_id
        UNION SELECT rv.external_id FROM task_ref rv JOIN family ON rv.revision_of = family.ext)
      SELECT 1 FROM family JOIN task tv ON tv.id = family.ext
      WHERE NOT (tv.state = 'cancelled' OR (tv.state = 'done' AND EXISTS (SELECT 1 FROM action_ledger a WHERE a.action = '${COMPLETION_ACTION}'
        AND (a.task_id = family.ext OR a.run_id IN (SELECT run.id FROM run JOIN task_ref x ON x.id = run.task_ref WHERE x.external_id = family.ext))))))`;
}

function cutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/** Whether a folder holds anything but the retention note. */
function holdsFiles(dir: string): boolean {
  try { return readdirSync(dir).some(name => name !== RETENTION_NOTE); } catch { return false; }
}

/** What a sweep would delete now under `periods`, and how much space it would free. Reads only. */
export function retentionPlan(store: Store, evidenceRoot: string, now: Date, periods: RetentionPeriods = store.retentionPeriods()): RetentionPlan {
  const db = store.handle;
  const items: RetentionItems = { evidence: [], checkouts: [], chat: [], notifications: [] };
  const more: Record<RetentionKind, boolean> = { evidence: false, checkouts: false, chat: false, notifications: false };

  if (periods.evidence !== null) {
    const rows = db.prepare(`SELECT run.id AS id FROM run JOIN task_ref r ON r.id = run.task_ref
      WHERE run.finished_at IS NOT NULL AND run.finished_at < ? AND ${finishedTask("r")} ORDER BY run.id`).all(cutoff(now, periods.evidence));
    for (const row of rows) {
      const run = Number(row["id"]);
      const dir = join(evidenceRoot, String(run));
      if (!holdsFiles(dir)) continue;
      if (items.evidence.length >= SWEEP_BATCH) { more.evidence = true; break; }
      items.evidence.push({ run, bytes: folderBytes(dir) });
    }
  }

  if (periods.checkouts !== null) {
    const rows = db.prepare(`SELECT w.path AS path, w.released_at AS released_at, length(w.path) + length(w.repo) + length(w.branch) + 64 AS bytes FROM worktree w
      WHERE w.runner IS NULL AND w.released_at IS NOT NULL AND w.released_at < ?
        AND (w.task_ref IS NULL OR EXISTS (SELECT 1 FROM task_ref r WHERE r.id = w.task_ref AND ${finishedTask("r")})) ORDER BY w.released_at`).all(cutoff(now, periods.checkouts));
    for (const row of rows) {
      const path = String(row["path"]);
      // Only the record of a checkout that's gone from disk: the checkout itself is storage retention's (two days after it's let go).
      if (existsSync(path)) continue;
      if (items.checkouts.length >= SWEEP_BATCH) { more.checkouts = true; break; }
      items.checkouts.push({ path, releasedAt: String(row["released_at"]), bytes: Number(row["bytes"]) });
    }
  }

  if (periods.chat !== null) {
    const rows = db.prepare(`SELECT m.id AS id, length(m.text) + COALESCE(length(m.activity), 0) + 64 AS bytes FROM mate_message m JOIN mate_thread th ON th.id = m.thread
      WHERE m.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM team_message tm WHERE tm.message = m.id AND tm.status IN ('queued', 'running', 'uncertain'))
        AND NOT EXISTS (SELECT 1 FROM mate_turn turn WHERE turn.id = m.turn AND turn.state IN ('queued', 'running'))
        AND NOT (th.scope_kind = 'task' AND NOT EXISTS (SELECT 1 FROM task_ref r WHERE r.external_id = th.scope_key AND ${finishedTask("r")}))
      ORDER BY m.id LIMIT ?`).all(cutoff(now, periods.chat), SWEEP_BATCH + 1);
    more.chat = rows.length > SWEEP_BATCH;
    items.chat = rows.slice(0, SWEEP_BATCH).map(row => ({ id: Number(row["id"]), bytes: Number(row["bytes"]) }));
  }

  if (periods.notifications !== null) {
    const rows = db.prepare(`SELECT n.id AS id, length(n.subject) + length(n.body) + 64 AS bytes FROM notification n
      WHERE n.created_at < ? AND n.resolved_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM notification_delivery d WHERE d.notification = n.id AND d.claim_owner IS NOT NULL AND d.claim_expires_at > ?)
        AND NOT (n.resolved_at IS NULL AND n.task_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_ref r WHERE r.id = n.task_ref AND ${finishedTask("r")}))
      ORDER BY n.id LIMIT ?`).all(cutoff(now, periods.notifications), now.toISOString(), SWEEP_BATCH + 1);
    more.notifications = rows.length > SWEEP_BATCH;
    items.notifications = rows.slice(0, SWEEP_BATCH).map(row => ({ id: Number(row["id"]), bytes: Number(row["bytes"]) }));
  }

  const counts = RETENTION_KINDS.map(({ kind }) => ({
    kind, days: periods[kind], count: items[kind].length,
    bytes: (items[kind] as { bytes: number }[]).reduce((sum, one) => sum + one.bytes, 0), more: more[kind],
  }));
  return { at: now.toISOString(), counts, items };
}

/** Bytes a folder holds, the retention note aside. */
function folderBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) if (name !== RETENTION_NOTE) total += treeBytes(join(dir, name));
  return total;
}

export type RetentionSweep = { at: string; counts: RetentionCount[]; freed: number; ledgerId: number | null };

/** Delete what the plan names (checking each again first) and write one ledger entry. Nothing to do when every kind is forever. */
export function sweepRetention(store: Store, evidenceRoot: string, now: Date, actor = "worker"): RetentionSweep {
  const periods = store.retentionPeriods();
  store.setServiceCursor(SWEEP_CURSOR, now.getTime(), now);
  if (RETENTION_KINDS.every(({ kind }) => periods[kind] === null)) return { at: now.toISOString(), counts: [], freed: 0, ledgerId: null };
  const plan = retentionPlan(store, evidenceRoot, now, periods);
  const db = store.handle;
  const done: Record<RetentionKind, { count: number; bytes: number }> = { evidence: { count: 0, bytes: 0 }, checkouts: { count: 0, bytes: 0 }, chat: { count: 0, bytes: 0 }, notifications: { count: 0, bytes: 0 } };

  // Evidence: each run's folder is emptied and a note left, so its pages say why the files are gone.
  if (periods.evidence !== null) {
    const still = db.prepare(`SELECT 1 FROM run JOIN task_ref r ON r.id = run.task_ref WHERE run.id = ? AND run.finished_at IS NOT NULL AND run.finished_at < ? AND ${finishedTask("r")}`);
    const before = cutoff(now, periods.evidence);
    for (const one of plan.items.evidence) {
      if (still.get(one.run, before) === undefined) continue;
      const dir = join(evidenceRoot, String(one.run));
      try { if (!lstatSync(dir).isDirectory()) continue; } catch { continue; }
      let freed = 0;
      for (const name of readdirSync(dir)) {
        if (name === RETENTION_NOTE) continue;
        const bytes = treeBytes(join(dir, name));
        try { rmSync(join(dir, name), { recursive: true, force: true }); freed += bytes; } catch { /* left for the next sweep */ }
      }
      try { writeFileSync(join(dir, RETENTION_NOTE), `Removed by the retention setting on ${now.toISOString().slice(0, 10)}.\n`, { mode: 0o600 }); } catch { /* the folder's emptiness says it */ }
      done.evidence.count++;
      done.evidence.bytes += freed;
    }
  }

  store.transact(() => {
    if (periods.checkouts !== null) {
      const forget = db.prepare("DELETE FROM worktree WHERE path = ? AND runner IS NULL AND released_at = ?");
      for (const one of plan.items.checkouts) {
        if (existsSync(one.path)) continue;
        if (Number(forget.run(one.path, one.releasedAt).changes) === 1) { done.checkouts.count++; done.checkouts.bytes += one.bytes; }
      }
    }
    if (periods.chat !== null) {
      const team = db.prepare("DELETE FROM team_message WHERE message = ? AND status NOT IN ('queued', 'running', 'uncertain')");
      const message = db.prepare("DELETE FROM mate_message WHERE id = ? AND NOT EXISTS (SELECT 1 FROM team_message WHERE message = ?)");
      const asked = db.prepare("SELECT turn FROM mate_message WHERE id = ? AND role = 'assistant' AND turn IS NOT NULL");
      // The lead's question goes with the reply that asked it; its buttons then say it expired.
      const ask = db.prepare("DELETE FROM mate_ask WHERE turn = ? AND NOT EXISTS (SELECT 1 FROM mate_message WHERE turn = ? AND role = 'assistant')");
      for (const one of plan.items.chat) {
        team.run(one.id);
        const turn = asked.get(one.id)?.["turn"];
        if (Number(message.run(one.id, one.id).changes) === 1) {
          done.chat.count++; done.chat.bytes += one.bytes;
          if (turn !== undefined && turn !== null) ask.run(Number(turn), Number(turn));
        }
      }
    }
    if (periods.notifications !== null) {
      const deliveries = db.prepare("DELETE FROM notification_delivery WHERE notification = ?");
      const outbound = db.prepare("DELETE FROM telegram_outbound_message WHERE notification = ?");
      const pushes = db.prepare("DELETE FROM push_delivery WHERE notification = ?");
      const notification = db.prepare("DELETE FROM notification WHERE id = ?");
      for (const one of plan.items.notifications) {
        deliveries.run(one.id); outbound.run(one.id); pushes.run(one.id);
        if (Number(notification.run(one.id).changes) === 1) { done.notifications.count++; done.notifications.bytes += one.bytes; }
      }
    }
  });

  const counts = plan.counts.map(one => ({ ...one, count: done[one.kind].count, bytes: done[one.kind].bytes }));
  const freed = counts.reduce((sum, one) => sum + one.bytes, 0);
  const ledgerId = store.recordAction({ at: now.toISOString(), actor, repo: null, taskId: null, runId: null, action: "retention sweep", outcome: freed > 0 || counts.some(one => one.count > 0) ? "removed" : "nothing due", source: "policy", detail: sweepWords(counts, freed) });
  return { at: now.toISOString(), counts, freed, ledgerId };
}

/** Whether a day has passed since the last sweep. */
export function retentionDue(store: Store, now: Date): boolean {
  return now.getTime() - store.serviceCursor(SWEEP_CURSOR) >= SWEEP_EVERY_MS;
}

/** The daily sweep, when it's due: one worker takes it (the cursor moves in the same transaction). */
export function dailyRetention(store: Store, evidenceRoot: string, now: Date): RetentionSweep | null {
  const mine = store.transact(() => {
    if (!retentionDue(store, now)) return false;
    store.setServiceCursor(SWEEP_CURSOR, now.getTime(), now);
    return true;
  });
  return mine ? sweepRetention(store, evidenceRoot, now) : null;
}

export function lastSweepAt(store: Store): string | null {
  const at = store.serviceCursor(SWEEP_CURSOR);
  return at === 0 ? null : new Date(at).toISOString();
}

const NOUNS: Record<RetentionKind, [string, string]> = {
  evidence: ["run's evidence", "runs' evidence"],
  checkouts: ["checkout record", "checkout records"],
  chat: ["chat message", "chat messages"],
  notifications: ["notification", "notifications"],
};

export function countWords(one: Pick<RetentionCount, "kind" | "count">): string {
  return `${one.count} ${NOUNS[one.kind][one.count === 1 ? 0 : 1]}`;
}

/** "3 runs' evidence, 120 chat messages; about 41 MB freed", or "nothing was due". */
export function sweepWords(counts: readonly RetentionCount[], freed: number): string {
  const parts = counts.filter(one => one.count > 0).map(countWords);
  return parts.length === 0 ? "nothing was due" : `${parts.join(", ")}; about ${bytesWords(freed)} freed`;
}
