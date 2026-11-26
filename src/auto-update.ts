/**
 * Automatic Toolroll updates (Settings → Updates, "Update automatically"): whether this installation installs each new
 * published release by itself, as its one saved switch says (auto_update_policy, schema v187; auto-update-schema.ts).
 *
 * - Off unless its one row says on: a new install and an upgraded one start with automatic updates off, and a row
 *   that can't be read is off. No environment variable, config file, flag, token or request field reads or changes it.
 * - Only an instance operator, as a person, from a browser sign-in changes it (POST /settings/updates/auto): the
 *   ordinary step-up (a solo or Passwordless session stands in, otherwise a password typed now), proved and written in
 *   one transaction with its ledger row (setAutoUpdatePolicy). Never the CLI, an API, remote or lead token, the lead,
 *   a model, an agent tool or the laptop's local owner (no local-owner act names it): chat may only link to the switch.
 * - The trust root is the updater's own: the release is installed by `toolroll update`'s journaled run
 *   (toolroll-update.ts), which verifies the package's npm provenance names ap9000/toolroll's publish workflow before
 *   anything is switched. Nothing here adds a download path, a registry or a package name.
 */
import { join } from "node:path";
import { isNewer } from "./releases.js";
import type { Store } from "./store.js";
import { readRuntimeUpdate, requestRuntimeUpdateCancel, runtimeUpdateTerminal, type RuntimeUpdateJournal } from "./toolroll-update.js";

/** The ledger's action for a change of the switch. */
export const AUTO_UPDATE_ACTION = "automatic updates";

export type AutoUpdatePolicy = { on: boolean; revision: number; by: string | null; at: string | null };

/** The switch as saved, or null when it can't be read (callers fail closed: null never starts anything). No row is
 * off at revision 0. */
export function autoUpdatePolicy(store: Pick<Store, "handle">): AutoUpdatePolicy | null {
  try {
    const rows = store.handle.prepare("SELECT id, enabled, revision, updated_by, updated_at FROM auto_update_policy").all();
    if (rows.length === 0) return { on: false, revision: 0, by: null, at: null };
    const row = rows[0]!;
    if (rows.length !== 1 || row["id"] !== 1 || (row["enabled"] !== 0 && row["enabled"] !== 1) || typeof row["revision"] !== "number" || !Number.isSafeInteger(row["revision"]) || row["revision"] < 1
      || typeof row["updated_by"] !== "string" || typeof row["updated_at"] !== "string") return null;
    return { on: row["enabled"] === 1, revision: row["revision"], by: row["updated_by"], at: row["updated_at"] };
  } catch { return null; }
}

/** Turn automatic updates on or off, with its ledger row; every change moves the revision. The caller proved the person
 * (an instance operator's step-up from a browser) in the same transaction it calls this in. Throws on a policy it can't
 * read: nothing is written over a row this build can't name. */
export function setAutoUpdatePolicy(store: Pick<Store, "handle" | "recordAction">, on: boolean, by: string, now: Date): { changed: boolean; revision: number } {
  const was = autoUpdatePolicy(store);
  if (was === null) throw new Error("The automatic updates setting can't be read. Nothing changed.");
  const revision = was.revision + 1;
  store.handle.prepare(`INSERT INTO auto_update_policy (id, enabled, revision, updated_by, updated_at) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, revision = excluded.revision, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(on ? 1 : 0, revision, by, now.toISOString());
  store.recordAction({ at: now.toISOString(), actor: by, repo: null, taskId: null, runId: null, action: AUTO_UPDATE_ACTION, outcome: on ? "on" : "off", source: "policy",
    detail: `revision ${revision}${was.on === on ? ", unchanged" : ""}` });
  return { changed: was.on !== on, revision };
}

// ---- one attempt per version ---------------------------------------------------------------------------------------

/** Why an automatic update did not start, in the order the decision asks. */
export type AutoUpdateHold = "policy-unreadable" | "off" | "enabler-gone" | "not-managed" | "no-release" | "prerelease" | "not-newer"
  | "history-unreadable" | "attempted" | "journal-unreadable" | "update-active";
/** How an automatic attempt ended: the update journal's own terminal phase, a manual rollback since, a launch that never
 * happened, or a record no longer on this computer. */
export type AutoUpdateOutcome = "complete" | "restored" | "refused" | "cancelled" | "rolled-back" | "not-started" | "unknown";
export type AutoUpdateAttempt = {
  id: number; version: string; from: string; enabledBy: string; policyRevision: number; reservedAt: string;
  journalId: string | null; launchedAt: string | null; outcome: AutoUpdateOutcome | null; outcomeAt: string | null; detail: string | null;
};
/** The ledger's action for an automatic attempt: started, and how it ended. */
export const AUTO_UPDATE_ATTEMPT_ACTION = "toolroll automatic update";
/** A reservation that never got a journal (the console stopped in between) is settled as not started after this long. */
export const AUTO_UPDATE_STALE_MS = 10 * 60_000;
const OUTCOMES: readonly AutoUpdateOutcome[] = ["complete", "restored", "refused", "cancelled", "rolled-back", "not-started", "unknown"];

function attemptOf(row: Record<string, unknown>): AutoUpdateAttempt {
  const text = (key: string) => { const value = row[key]; if (typeof value !== "string") throw new Error(`${key} is not text`); return value; };
  const maybe = (key: string) => row[key] === null ? null : text(key);
  const outcome = maybe("outcome");
  if (outcome !== null && !OUTCOMES.some(one => one === outcome)) throw new Error("unknown outcome");
  if (typeof row["id"] !== "number" || typeof row["policy_revision"] !== "number") throw new Error("not a number");
  return { id: row["id"], version: text("version"), from: text("from_version"), enabledBy: text("enabled_by"), policyRevision: row["policy_revision"], reservedAt: text("reserved_at"),
    journalId: maybe("journal_id"), launchedAt: maybe("launched_at"), outcome: outcome as AutoUpdateOutcome | null, outcomeAt: maybe("outcome_at"), detail: maybe("detail") };
}
const ATTEMPT_COLUMNS = "id, version, from_version, enabled_by, policy_revision, reserved_at, journal_id, launched_at, outcome, outcome_at, detail";

/** The newest attempts first, or null when the history can't be read (callers fail closed). */
export function autoUpdateAttempts(store: Pick<Store, "handle">, limit = 20): AutoUpdateAttempt[] | null {
  try { return store.handle.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM auto_update_attempt ORDER BY id DESC LIMIT ?`).all(limit).map(attemptOf); }
  catch { return null; }
}

/** Whether an automatic update was ever reserved for `version`, or null when the history can't be read. */
export function autoUpdateAttempted(store: Pick<Store, "handle">, version: string): boolean | null {
  try { return store.handle.prepare("SELECT 1 FROM auto_update_attempt WHERE version = ?").get(version) !== undefined; }
  catch { return null; }
}

/**
 * Reserve `version` for one automatic attempt, atomically with the checks that allow it: the switch is on and still
 * stands (the person who turned it on is still an unrestricted active instance operator), the history can be read, and
 * no attempt was ever reserved for this version. Called before anything is prepared or launched, so a crash after it
 * never makes the version eligible again; the database backup the update takes later holds the reservation, so a
 * restore keeps it too.
 */
export function reserveAutoUpdate(store: Pick<Store, "handle" | "transact" | "isInstanceOperator" | "recordAction">, o: { version: string; from: string; now: Date }):
  { ok: true; attempt: AutoUpdateAttempt } | { ok: false; why: AutoUpdateHold } {
  if (!/^\d+\.\d+\.\d+$/.test(o.version)) return { ok: false, why: "prerelease" };
  try {
    return store.transact(() => {
      const policy = autoUpdatePolicy(store);
      if (policy === null) return { ok: false as const, why: "policy-unreadable" as const };
      if (!policy.on || policy.by === null) return { ok: false as const, why: "off" as const };
      if (!store.isInstanceOperator(policy.by)) return { ok: false as const, why: "enabler-gone" as const };
      const attempted = autoUpdateAttempted(store, o.version);
      if (attempted === null) return { ok: false as const, why: "history-unreadable" as const };
      if (attempted) return { ok: false as const, why: "attempted" as const };
      const row = store.handle.prepare(`INSERT INTO auto_update_attempt (version, from_version, enabled_by, policy_revision, reserved_at) VALUES (?, ?, ?, ?, ?) RETURNING ${ATTEMPT_COLUMNS}`)
        .get(o.version, o.from, policy.by, policy.revision, o.now.toISOString());
      return { ok: true as const, attempt: attemptOf(row!) };
    });
  } catch { return { ok: false, why: "history-unreadable" }; }
}

/** Bind a reserved attempt to the update journal prepared for it (once). */
export function linkAutoUpdateJournal(store: Pick<Store, "handle">, attempt: number, journalId: string): boolean {
  return store.handle.prepare("UPDATE auto_update_attempt SET journal_id = ? WHERE id = ? AND journal_id IS NULL").run(journalId, attempt).changes === 1;
}

/** The attempt's independent updater was started (once). */
export function markAutoUpdateLaunched(store: Pick<Store, "handle">, attempt: number, now: Date): boolean {
  return store.handle.prepare("UPDATE auto_update_attempt SET launched_at = ? WHERE id = ? AND launched_at IS NULL").run(now.toISOString(), attempt).changes === 1;
}

/** Record how an attempt ended, once, with its ledger row. False when it was already recorded. */
export function recordAutoUpdateOutcome(store: Pick<Store, "handle" | "transact" | "recordAction">, attempt: AutoUpdateAttempt, outcome: AutoUpdateOutcome, detail: string, now: Date): boolean {
  return store.transact(() => {
    const changed = store.handle.prepare("UPDATE auto_update_attempt SET outcome = ?, outcome_at = ?, detail = ? WHERE id = ? AND outcome IS NULL")
      .run(outcome, now.toISOString(), detail.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1500), attempt.id).changes === 1;
    if (changed) store.recordAction({ at: now.toISOString(), actor: autoUpdateActor(attempt.enabledBy), repo: null, taskId: null, runId: null, action: AUTO_UPDATE_ATTEMPT_ACTION, outcome, source: "policy",
      detail: `${attempt.from} → ${attempt.version}: ${detail}` });
    return changed;
  });
}

/** Who an automatic update's journal and ledger rows name: the update itself, on the authority of the person who turned
 * automatic updates on. */
export const autoUpdateActor = (enabledBy: string) => `automatic update (turned on by ${enabledBy})`;

/** Where an automatic attempt's own copy of its journal lives (toolroll-update.ts newJournal's stage folder). */
const stageJournal = (stateDir: string, attempt: AutoUpdateAttempt) => join(stateDir, "staged-upgrades", `release-${attempt.version}-${attempt.journalId!.slice(0, 8)}`, "update.json");

/** How an open attempt has ended, from the update's own records, or null while it hasn't (or can't yet be told). */
function settled(attempt: AutoUpdateAttempt, saved: RuntimeUpdateJournal | null, o: { stateDir: string; current: string; now: Date }): { outcome: AutoUpdateOutcome; detail: string } | null {
  if (attempt.journalId === null) {
    return o.now.getTime() - Date.parse(attempt.reservedAt) >= AUTO_UPDATE_STALE_MS ? { outcome: "not-started", detail: "Toolroll stopped before the update could start." } : null;
  }
  // A person rolled this update back since: the rollback names the update it undid.
  if (saved !== null && saved.id !== attempt.journalId && saved.kind === "rollback" && saved.restoreFrom?.updateId === attempt.journalId) {
    return saved.phase === "complete" ? { outcome: "rolled-back", detail: `Rolled back to ${saved.to.version}.` } : null;
  }
  let journal = saved?.id === attempt.journalId ? saved : null;
  if (journal === null) {
    // Replaced by a later update or rollback: its stage keeps its own copy.
    try { journal = readRuntimeUpdate(o.stateDir, stageJournal(o.stateDir, attempt)); } catch { journal = null; }
    if (journal?.id !== attempt.journalId) return { outcome: "unknown", detail: "Its update record is no longer on this computer." };
  }
  if (!runtimeUpdateTerminal(journal.phase)) return null;
  // Complete is said by the version it installed, once that version runs (an older one still running is told nothing).
  if (journal.phase === "complete") return isNewer(attempt.version, o.current) ? null : { outcome: "complete", detail: journal.detail };
  const phase = journal.phase as "restored" | "refused" | "cancelled";
  return { outcome: phase, detail: journal.error ?? journal.detail };
}

/**
 * Record how each open automatic attempt ended, from the update journal (and its stage copy), each once with its ledger
 * row. Fails closed: when the saved journal or the history can't be read, nothing is recorded. Returns what it recorded.
 */
export function reconcileAutoUpdates(store: Pick<Store, "handle" | "transact" | "recordAction">, o: { stateDir: string; current: string; now: Date }): { attempt: AutoUpdateAttempt; outcome: AutoUpdateOutcome; detail: string }[] {
  let open: AutoUpdateAttempt[];
  try { open = store.handle.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM auto_update_attempt WHERE outcome IS NULL ORDER BY id`).all().map(attemptOf); }
  catch { return []; }
  if (open.length === 0) return [];
  let saved: RuntimeUpdateJournal | null;
  try { saved = readRuntimeUpdate(o.stateDir); } catch { return []; }
  const recorded: { attempt: AutoUpdateAttempt; outcome: AutoUpdateOutcome; detail: string }[] = [];
  for (const attempt of open) {
    const ended = settled(attempt, saved, o);
    if (ended !== null && recordAutoUpdateOutcome(store, attempt, ended.outcome, ended.detail, o.now)) recorded.push({ attempt, ...ended });
  }
  return recorded;
}

/**
 * Turning automatic updates off: the automatic update under way (if any) is cancelled while that is still safe (before
 * anything is stopped or switched; toolroll-update.ts requestRuntimeUpdateCancel, bound to that attempt's journal id so a
 * person's own update is never touched). Past that point it finishes or restores on its own, and the words say so.
 * Returns what to tell the person, or null when no automatic update is under way.
 */
export function cancelAutomaticUpdate(store: Pick<Store, "handle">, stateDir: string, now: Date): string | null {
  let open: AutoUpdateAttempt[];
  try { open = store.handle.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM auto_update_attempt WHERE outcome IS NULL AND journal_id IS NOT NULL ORDER BY id DESC`).all().map(attemptOf); }
  catch { return "The automatic update history can't be read, so nothing was cancelled. Settings → Updates shows any update under way."; }
  for (const attempt of open) {
    let said: string;
    try { said = requestRuntimeUpdateCancel(stateDir, now, {}, attempt.journalId!); }
    catch { return "The update record can't be read, so nothing was cancelled. Settings → Updates shows any update under way."; }
    if (said !== "No update is in progress.") return said;
  }
  return null;
}
