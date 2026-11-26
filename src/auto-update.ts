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
import { isNewer, RELEASES_PAGE } from "./releases.js";
import type { Store } from "./store.js";
import type { InstallKind } from "./install-method.js";
import { abandonRuntimeUpdate, prepareRuntimeUpdate, readRuntimeUpdate, requestRuntimeUpdateCancel, runtimeUpdateTerminal, type RuntimeRef, type RuntimeUpdateJournal } from "./toolroll-update.js";

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
  id: number; version: string; from: string; enabledBy: string; enabledGeneration: number; policyRevision: number; reservedAt: string;
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
  if (typeof row["id"] !== "number" || typeof row["policy_revision"] !== "number" || typeof row["enabled_generation"] !== "number") throw new Error("not a number");
  return { id: row["id"], version: text("version"), from: text("from_version"), enabledBy: text("enabled_by"), enabledGeneration: row["enabled_generation"], policyRevision: row["policy_revision"], reservedAt: text("reserved_at"),
    journalId: maybe("journal_id"), launchedAt: maybe("launched_at"), outcome: outcome as AutoUpdateOutcome | null, outcomeAt: maybe("outcome_at"), detail: maybe("detail") };
}
const ATTEMPT_COLUMNS = "id, version, from_version, enabled_by, enabled_generation, policy_revision, reserved_at, journal_id, launched_at, outcome, outcome_at, detail";

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
export function reserveAutoUpdate(store: Pick<Store, "handle" | "transact" | "isInstanceOperator" | "recordAction" | "accountOf">, o: { version: string; from: string; now: Date }):
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
      const generation = store.accountOf(policy.by)?.generation;
      if (generation === undefined) return { ok: false as const, why: "enabler-gone" as const };
      const row = store.handle.prepare(`INSERT INTO auto_update_attempt (version, from_version, enabled_by, enabled_generation, policy_revision, reserved_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING ${ATTEMPT_COLUMNS}`)
        .get(o.version, o.from, policy.by, generation, policy.revision, o.now.toISOString());
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

/** Record how an attempt ended, once, with its ledger row and its notice to each instance operator (notifyAutoUpdate),
 * all in one transaction: whichever road settles it (the journal's outcome, a failed preparation or launch), the person
 * is told once. False when it was already recorded. */
export function recordAutoUpdateOutcome(store: OutcomeStore, attempt: AutoUpdateAttempt, outcome: AutoUpdateOutcome, detail: string, now: Date): boolean {
  const clean = detail.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1500);
  return store.transact(() => {
    const changed = store.handle.prepare("UPDATE auto_update_attempt SET outcome = ?, outcome_at = ?, detail = ? WHERE id = ? AND outcome IS NULL")
      .run(outcome, now.toISOString(), clean, attempt.id).changes === 1;
    if (!changed) return false;
    store.recordAction({ at: now.toISOString(), actor: autoUpdateActor(attempt.enabledBy), repo: null, taskId: null, runId: null, action: AUTO_UPDATE_ATTEMPT_ACTION, outcome, source: "policy",
      detail: `${attempt.from} → ${attempt.version}: ${clean}` });
    // Anything but a completed update turns automatic updates off: the yes this attempt stood on is spent, and only a
    // person's browser step-up turns them on again. Correctness never rests on this history surviving a restore.
    if (outcome !== "complete") turnOffAfterAttempt(store, attempt, outcome, now);
    notifyAutoUpdate(store, { ...attempt, outcome, outcomeAt: now.toISOString(), detail: clean }, null, now);
    return true;
  });
}
/** What recording an outcome uses of the store: the attempt, the ledger and the outbox. */
type OutcomeStore = Pick<Store, "handle" | "transact" | "recordAction" | "accountFacts" | "isInstanceOperator" | "enqueueNotification">;

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
export function reconcileAutoUpdates(store: OutcomeStore, o: { stateDir: string; current: string; now: Date }): { attempt: AutoUpdateAttempt; outcome: AutoUpdateOutcome; detail: string }[] {
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

// ---- the trigger ---------------------------------------------------------------------------------------------------

/** What the automatic pass uses of the store. */
export type AutoUpdateStore = Pick<Store, "handle" | "transact" | "isInstanceOperator" | "recordAction" | "accountFacts" | "enqueueNotification" | "accountOf">;

/** What the decision reads, each as it stands now; null where it can't be read. */
export type AutoUpdateFacts = {
  policy: AutoUpdatePolicy | null;
  /** Whether the person who turned it on is still an unrestricted active instance operator. */
  enablerStands: boolean;
  kind: InstallKind;
  current: string;
  /** The newest release the update check knows (its cache), or null. */
  latest: string | null;
  /** Whether an automatic attempt was ever reserved for `latest`; null when the history can't be read. */
  attempted: boolean | null;
  /** The saved update journal: none, finished, under way, or unreadable. */
  journal: "none" | "terminal" | "active" | "unreadable";
};

/** Whether to start an automatic update now, and if not, why. Pure: every fact is passed in. Only a managed install
 * (a runtime `toolroll update` staged), only a stable x.y.z release newer than the running one, never one tried before,
 * never while another update is journaled, and only while the switch stands. Unreadable anything holds. */
export function autoUpdateDecision(facts: AutoUpdateFacts): { go: true; version: string } | { go: false; why: AutoUpdateHold } {
  if (facts.policy === null) return { go: false, why: "policy-unreadable" };
  if (!facts.policy.on) return { go: false, why: "off" };
  if (!facts.enablerStands) return { go: false, why: "enabler-gone" };
  if (facts.kind !== "managed") return { go: false, why: "not-managed" };
  if (facts.latest === null) return { go: false, why: "no-release" };
  if (!/^\d+\.\d+\.\d+$/.test(facts.latest)) return { go: false, why: "prerelease" };
  if (!isNewer(facts.latest, facts.current)) return { go: false, why: "not-newer" };
  if (facts.attempted === null) return { go: false, why: "history-unreadable" };
  if (facts.attempted) return { go: false, why: "attempted" };
  if (facts.journal === "unreadable") return { go: false, why: "journal-unreadable" };
  if (facts.journal === "active") return { go: false, why: "update-active" };
  return { go: true, version: facts.latest };
}

export type AutoUpdatePassOptions = {
  stateDir: string; databaseFile: string; current: RuntimeRef; kind: InstallKind;
  /** The release the update check just read (latestRelease: its daily cache; never asked again here). */
  latest: string | null;
  now: () => Date;
  /** Starts the independent updater for one prepared journal (toolroll-update.ts launchRuntimeUpdate). */
  launch: (args: { databaseFile: string; id: string }) => Promise<void>;
};
export type AutoUpdatePassResult = { started: string; journal: string } | { held: AutoUpdateHold } | { failed: string; version: string };

/**
 * The update check's automatic step (releases.ts startUpdateChecks, beside the console): settle earlier attempts, then,
 * when the decision allows, reserve the version and prepare its journal under the prepare lock, and launch the same
 * independent updater Settings → Updates launches (prepare → a one-off job → resume that journal id only). The updater
 * never runs inside the service it stops. Never a downgrade, never a prerelease, one attempt per version.
 */
export async function autoUpdatePass(store: AutoUpdateStore, o: AutoUpdatePassOptions): Promise<AutoUpdatePassResult> {
  reconcileAutoUpdates(store, { stateDir: o.stateDir, current: o.current.version, now: o.now() });
  const policy = autoUpdatePolicy(store);
  let journal: AutoUpdateFacts["journal"];
  let saved: RuntimeUpdateJournal | null = null;
  try { saved = readRuntimeUpdate(o.stateDir); journal = saved === null ? "none" : runtimeUpdateTerminal(saved.phase) ? "terminal" : "active"; }
  catch { journal = "unreadable"; }
  // An automatic update whose restore needs a person: told once.
  if (saved?.phase === "needs-attention") {
    const open = autoUpdateAttempts(store, 5)?.find(one => one.outcome === null && one.journalId === saved!.id);
    if (open !== undefined) { try { notifyAutoUpdate(store, open, "needs-attention", o.now()); } catch { /* shown on Settings → Updates */ } }
  }
  const decided = autoUpdateDecision({ policy, enablerStands: policy?.by != null && store.isInstanceOperator(policy.by), kind: o.kind, current: o.current.version, latest: o.latest,
    attempted: o.latest === null ? false : autoUpdateAttempted(store, o.latest), journal });
  if (!decided.go) return { held: decided.why };
  const version = decided.version;
  let attempt: AutoUpdateAttempt | null = null, held: AutoUpdateHold | null = null;
  // Reserved inside the prepare lock, once nothing is under way, and bound to its journal before the lock is let go.
  const prepared = prepareRuntimeUpdate({ stateDir: o.stateDir, databaseFile: o.databaseFile, current: o.current, actor: autoUpdateActor(policy!.by!), version, when: "when-idle", at: null }, o.now(), {
    reserve: () => {
      const reserved = reserveAutoUpdate(store, { version, from: o.current.version, now: o.now() });
      if (!reserved.ok) { held = reserved.why; return `Not reserved: ${reserved.why}.`; }
      attempt = reserved.attempt;
      return null;
    },
    prepared: j => { if (attempt === null || !linkAutoUpdateJournal(store, attempt.id, j.id)) throw new Error("its attempt record could not be written"); },
  });
  const reservedAttempt = attempt as AutoUpdateAttempt | null;
  if ("refused" in prepared) {
    if (reservedAttempt === null) return held !== null ? { held } : { failed: prepared.refused, version };
    recordAutoUpdateOutcome(store, reservedAttempt, "not-started", prepared.refused, o.now());
    return { failed: prepared.refused, version };
  }
  // Turned off, or its person's authority lapsed, while it was being prepared: it never starts. (The updater checks both
  // again before it starts and before it switches: toolroll-update.ts automaticAuthorityProblem.)
  const still = autoUpdatePolicy(store);
  const stands = store.isInstanceOperator(reservedAttempt!.enabledBy) && store.accountOf(reservedAttempt!.enabledBy)?.generation === reservedAttempt!.enabledGeneration;
  if (still === null || !still.on || still.revision !== reservedAttempt!.policyRevision || !stands) {
    const why = !stands ? `${reservedAttempt!.enabledBy}, who turned automatic updates on, can no longer manage this installation.` : "Automatic updates were turned off before it started.";
    abandonRuntimeUpdate(o.stateDir, prepared.id, why, o.now());
    recordAutoUpdateOutcome(store, reservedAttempt!, "cancelled", why, o.now());
    return { held: "off" };
  }
  try { await o.launch({ databaseFile: o.databaseFile, id: prepared.id }); }
  catch (error) {
    const why = `The update could not start: ${(error as Error).message}`;
    abandonRuntimeUpdate(o.stateDir, prepared.id, why, o.now());
    recordAutoUpdateOutcome(store, reservedAttempt!, "not-started", why, o.now());
    return { failed: why, version };
  }
  markAutoUpdateLaunched(store, reservedAttempt!.id, o.now());
  store.recordAction({ at: o.now().toISOString(), actor: autoUpdateActor(reservedAttempt!.enabledBy), repo: null, taskId: null, runId: null, action: AUTO_UPDATE_ATTEMPT_ACTION, outcome: "started", source: "policy",
    detail: `${o.current.version} → ${version} (policy revision ${reservedAttempt!.policyRevision})` });
  return { started: version, journal: prepared.id };
}

/** The console's automatic step after each update check: one pass at a time, never throwing into the check loop. */
export function automaticUpdates(store: AutoUpdateStore, o: Omit<AutoUpdatePassOptions, "latest">): (latest: string | null) => Promise<void> {
  let running = false;
  return async latest => {
    if (running) return;
    running = true;
    try { await autoUpdatePass(store, { ...o, latest }); }
    catch { /* a closed store at shutdown, or a record that can't be read: nothing starts */ }
    finally { running = false; }
  };
}

// ---- what a person is told -----------------------------------------------------------------------------------------

/** HH:MM on the computer running Toolroll. */
const clockOf = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
/** A reason as one short sentence, without a trailing "Nothing was changed." the line already implies. */
const reasonOf = (detail: string | null) => (detail ?? "it stopped").replace(/^The update could not start:\s*/i, "").replace(/\s*Nothing (?:was )?changed[^.]*\.?\s*$/i, "").replace(/\.\s*$/, "").slice(0, 300) || "it stopped";
export const whatsNewUrl = (version: string) => `${RELEASES_PAGE}v${version}`;

/**
 * The last automatic attempt in one line (Settings → Updates, the notice, `toolroll update --status`), truthfully: what
 * runs now, and whether it will be tried again. `phase`: the update journal's phase while the attempt is open.
 */
export function autoUpdateLine(attempt: AutoUpdateAttempt, phase: string | null = null): { line: string; failed: boolean } {
  const { version, from } = attempt;
  const later = AUTO_UPDATE_OFF_WORDS;
  switch (attempt.outcome) {
    case null: return phase === "needs-attention" ? { line: `The automatic update to ${version} needs attention: Toolroll couldn't put ${from} back on its own.`, failed: true }
      : { line: `Updating to ${version} by itself.`, failed: false };
    case "complete": return { line: `Updated to ${version} at ${clockOf(attempt.outcomeAt ?? attempt.reservedAt)}.`, failed: false };
    case "restored": return { line: `Couldn't update to ${version}: ${reasonOf(attempt.detail)}. Still on ${from}; its database was put back from the backup.${later}`, failed: true };
    case "refused": case "not-started": return { line: `Couldn't update to ${version}: ${reasonOf(attempt.detail)}. Still on ${from}.${later}`, failed: true };
    case "cancelled": return { line: `The automatic update to ${version} was cancelled. Still on ${from}.${later}`, failed: false };
    case "rolled-back": return { line: `Updated to ${version}, then rolled back to ${from}.${later}`, failed: false };
    case "unknown": return { line: `Couldn't tell how the automatic update to ${version} ended: ${reasonOf(attempt.detail)}.${later}`, failed: true };
  }
}

/**
 * Tell each instance operator, once per version and outcome (the outbox dedupes): updated, couldn't update, or a
 * restore that needs attention. A person's own cancel or rollback needs no notice. Returns how many were queued.
 */
export function notifyAutoUpdate(store: Pick<Store, "accountFacts" | "isInstanceOperator" | "enqueueNotification">, attempt: AutoUpdateAttempt, phase: string | null, now: Date): number {
  const told = attempt.outcome === null ? (phase === "needs-attention" ? "needs-attention" : null) : attempt.outcome === "cancelled" || attempt.outcome === "rolled-back" ? null : attempt.outcome;
  if (told === null) return 0;
  const { line } = autoUpdateLine(attempt, phase);
  let queued = 0;
  for (const recipient of store.accountFacts().map(one => one.name).filter(name => store.isInstanceOperator(name))) {
    if (store.enqueueNotification({ dedupeKey: `auto-update:${attempt.version}:${told}:${recipient}`, kind: "auto-update", link: "/settings/updates", recipient, source: { installation: true },
      ...(told === "complete" ? { subject: `${line.replace(/\.$/, "")} — what's new`, body: whatsNewUrl(attempt.version) }
        : { subject: line, body: "Settings → Updates shows what happened.", pushClass: "attention" as const }) }, now)) queued++;
  }
  return queued;
}

/** Every line about an automatic update that didn't complete ends with this (the switch was turned off with it). */
export const AUTO_UPDATE_OFF_WORDS = " Automatic updates were turned off until you turn them on again.";

/** Turn automatic updates off after an attempt that didn't complete, in the caller's transaction, with a ledger row; only
 * the yes it stood on (the same revision): a person who turned them on again since is not overruled. */
function turnOffAfterAttempt(store: Pick<Store, "handle" | "recordAction">, attempt: AutoUpdateAttempt, outcome: AutoUpdateOutcome, now: Date): boolean {
  const changed = store.handle.prepare("UPDATE auto_update_policy SET enabled = 0, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = 1 AND enabled = 1 AND revision = ?")
    .run("automatic update", now.toISOString(), attempt.policyRevision).changes === 1;
  if (changed) store.recordAction({ at: now.toISOString(), actor: "automatic update", repo: null, taskId: null, runId: null, action: AUTO_UPDATE_ACTION, outcome: "off", source: "policy",
    detail: `the automatic update to ${attempt.version} didn't complete (${outcome}): off until a person turns it on again` });
  return changed;
}
