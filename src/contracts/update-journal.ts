/**
 * The update journals and their small control records (docs/plans/zod-revamp.md, item 19): the desktop app's update
 * (`desktop-update.json` and the retained `receipt.json`) and `toolroll update`'s (`toolroll-update.json`,
 * `.last.json` and the stage's `update.json`), plus the request, stop, cancel and starting marks beside them.
 *
 * Every journal is Toolroll's own and carries `version: 1`, but the reader ignores keys it does not know: a rollback
 * runs an older Toolroll against a journal a newer one wrote, and every field added since 0.8.0 was added under the
 * same version. A newer version is refused plainly. Readers return the saved object itself once it parses, so a
 * journal saved again keeps its keys, their order and anything a newer release added. Paths, ownership, identities
 * and hashes are checked in plain code by the update modules after parsing, with their existing words.
 */

import { z } from "zod";
import { readVersioned, type ContractIssue } from "./contract.js";

/** What a reader made of a saved journal: the saved object itself, or path-named issues. */
export type JournalRead<T> = { ok: true; value: T } | { ok: false; issues: ContractIssue[] };

function journalOf<T>(schema: z.ZodType<T> & { shape: { version: z.ZodLiteral<number> } }, input: unknown): JournalRead<T> {
  const read = readVersioned(schema, input);
  // The parsed copy proves the shape; the saved object (its key order, and keys a newer release added) is what is kept.
  return read.ok ? { ok: true, value: input as T } : read;
}

/** A finished run an update waits on (or stopped waiting on). */
const waitingSchema = z.object({ run: z.number(), on: z.string(), action: z.string().nullable(), since: z.string() });
const releasedCodingOwnerSchema = z.object({ pid: z.number(), nativePid: z.number().nullable() });

// ---- the desktop app's update ------------------------------------------------------------------------------------

export const DESKTOP_UPDATE_PHASES = ["prepared", "draining", "backing-up", "stopping", "installing", "verifying", "rolling-back", "releasing", "complete", "restored", "cancelled", "needs-attention"] as const;

/** An app bundle as the journal records it (`readDesktopBundle`'s identity). */
export const desktopBundleSchema = z.object({
  path: z.string(), hash: z.string(), buildId: z.string(), version: z.string(), bundleId: z.string(),
  schemaVersion: z.number(), development: z.boolean(), providerBin: z.string(), recoveryProtocol: z.number().exactOptional(),
});

/** The keys in the order the old reader checked them, so the first issue picks the same refusal it gave. */
export const desktopUpdateJournalSchema = z.object({
  version: z.literal(1),
  id: z.string(), stateDir: z.string(), workDir: z.string(), label: z.string(),
  intended: z.enum(["install", "restore"]), phase: z.enum(DESKTOP_UPDATE_PHASES),
  old: desktopBundleSchema, next: desktopBundleSchema,
  databaseFile: z.string(), configHash: z.string(), wasRunning: z.boolean(),
  backupHash: z.string().exactOptional(), backupPath: z.string().exactOptional(),
  replacementOccurred: z.boolean().exactOptional(),
  codingCatalogExpected: z.boolean().exactOptional(),
  stoppedPids: z.array(z.number()).exactOptional(),
  codingBackupPath: z.string().exactOptional(), codingBackupHash: z.string().exactOptional(),
  startedAt: z.string(), updatedAt: z.string(), detail: z.string(),
  error: z.string().exactOptional(), checkedAt: z.string().exactOptional(),
  serviceInterrupted: z.boolean().exactOptional(),
  retryableRecovery: z.boolean().exactOptional(),
  /** The finished run the update is waiting on (or stopped waiting on). Absent while it waits on ordinary work. */
  waiting: waitingSchema.exactOptional(),
  /** A stale coding owner record this update released after proving those processes gone. */
  codingOwnerReleased: releasedCodingOwnerSchema.exactOptional(),
});

export type DesktopUpdateJournal = z.infer<typeof desktopUpdateJournalSchema>;
export type DesktopUpdatePhase = DesktopUpdateJournal["phase"];

export function readDesktopUpdateJournal(input: unknown): JournalRead<DesktopUpdateJournal> {
  return journalOf(desktopUpdateJournalSchema, input);
}

/** The automatic-recovery guardian's record (`recovery.json`) as Update status reads it: each field is used only when
 * it has its type, as before; the guardian itself owns the full record. */
export const desktopRecoveryViewSchema = z.object({
  id: z.string().optional().catch(undefined), state: z.string().optional().catch(undefined), detail: z.string().optional().catch(undefined),
  attempts: z.number().optional().catch(undefined), repairs: z.number().optional().catch(undefined), updatedAt: z.string().optional().catch(undefined),
});
export type DesktopRecoveryView = z.infer<typeof desktopRecoveryViewSchema>;

/** Update status's view of `recovery.json`; anything that is not an object reads as no guardian, as before. */
export function readDesktopRecoveryView(input: unknown): DesktopRecoveryView | null {
  const read = desktopRecoveryViewSchema.safeParse(input);
  return read.success ? read.data : null;
}

/** `request.json` (a restore) and `stop-request.json`, as `requestUpdateRestore` and `requestUpdateStop` write them. */
export const updateRequestSchema = z.object({ id: z.unknown().exactOptional(), action: z.unknown().exactOptional() });
/** Whether a saved request is `{ id, action }` for this update; anything else is not that request. */
export function updateRequestIs(input: unknown, id: string, action: string): boolean {
  const read = updateRequestSchema.safeParse(input);
  return read.success && read.data.id === id && read.data.action === action;
}

/** The service supervisor's status file, read for the service's process ids before a stop. */
export const supervisorPidsSchema = z.object({ supervisorPid: z.unknown().exactOptional(), controllerPid: z.unknown().exactOptional() });
export function supervisorPidsOf(input: unknown): number[] {
  const read = supervisorPidsSchema.safeParse(input);
  if (!read.success) return [];
  return [read.data.supervisorPid, read.data.controllerPid].filter((pid): pid is number => Number.isSafeInteger(pid) && Number(pid) > 1);
}

// ---- toolroll update ---------------------------------------------------------------------------------------------

export const RUNTIME_UPDATE_STEPS = ["verifying", "draining", "backing-up", "rehearsing", "switching", "restarting", "health"] as const;
export const RUNTIME_PHASES = ["scheduled", ...RUNTIME_UPDATE_STEPS, "complete", "rolling-back", "restored", "refused", "cancelled", "needs-attention"] as const;

const runtimeRefSchema = z.object({ version: z.string(), dist: z.string() });
const unitSchema = z.object({ unit: z.string(), pids: z.array(z.number()) });
const savedFileSchema = z.object({ path: z.string(), saved: z.string() });

export const runtimeUpdateJournalSchema = z.object({
  version: z.literal(1),
  id: z.string(), stateDir: z.string(), stageDir: z.string(),
  kind: z.enum(["update", "rollback"]),
  databaseFile: z.string(),
  from: runtimeRefSchema, to: runtimeRefSchema,
  when: z.enum(["now", "when-idle", "at"]), at: z.string().nullable(), actor: z.string(),
  phase: z.enum(RUNTIME_PHASES), detail: z.string(), error: z.string().exactOptional(),
  steps: z.array(z.object({ phase: z.enum(RUNTIME_PHASES), at: z.string() })),
  startedAt: z.string(), updatedAt: z.string(), finishedAt: z.string().exactOptional(),
  package: z.object({ sha512: z.string(), repository: z.string(), workflow: z.string() }).exactOptional(),
  notes: z.array(z.string()).exactOptional(),
  /** This run's own verified copies of the live database and coding catalog: what a failure restores. */
  backupPath: z.string().exactOptional(), backupHash: z.string().exactOptional(),
  codingBackupPath: z.string().exactOptional(), codingBackupHash: z.string().exactOptional(),
  /** A rollback installs the update's earlier backups (checked against their recorded hashes). */
  restoreFrom: z.object({ path: z.string(), hash: z.string(), updateId: z.string(), codingPath: z.string().exactOptional(), codingHash: z.string().exactOptional() }).exactOptional(),
  rehearsal: z.object({ tables: z.number(), rows: z.number() }).exactOptional(),
  /** The background service, recorded before it is stopped: its definition and the processes that must be gone. */
  service: unitSchema.exactOptional(),
  /** Each repo's watch daemon that runs this version, recorded the same way: switched with the service, and stopped and
   * restarted with it only when launchd had it loaded before the update (`loaded` absent: 0.8.1 stopped every one). */
  watches: z.array(unitSchema.extend({ loaded: z.boolean().exactOptional() })).exactOptional(),
  /** Recorded before each change so a resumed or failed run knows what to put back. */
  switched: z.object({
    links: z.array(z.object({ path: z.string(), previous: z.string() })),
    unit: savedFileSchema.nullable(),
    watches: z.array(savedFileSchema).exactOptional(),
    databaseRestored: z.boolean().exactOptional(),
  }).exactOptional(),
  /** What the live database held when a failed run restored its backup: nothing written is lost. The newest of `kept`. */
  keptAside: z.string().exactOptional(),
  /** The live database could not be read, so it was moved aside whole rather than copied. */
  keptAsideUnreadable: z.boolean().exactOptional(),
  /** Every copy kept aside, oldest first: a retried restore adds one and never drops the pointer to an earlier one. */
  kept: z.array(z.object({ path: z.string(), unreadable: z.boolean() })).exactOptional(),
  /** The restore put the backup back: a retried restore never puts it back again (what was written since belongs to
   * the restored version and would be lost), and it keeps a fresh copy aside before every attempt until then. */
  restoredDatabase: z.boolean().exactOptional(),
  /** A stale coding owner record this run released after proving its processes gone. */
  codingOwnerReleased: releasedCodingOwnerSchema.exactOptional(),
  seen: z.boolean().exactOptional(),
  /** The finished run the update is waiting on (or stopped waiting on): what is in the way and the command that
   * clears it. Absent while it waits on ordinary running work. */
  waiting: waitingSchema.exactOptional(),
});

export type RuntimeUpdateJournalRecord = z.infer<typeof runtimeUpdateJournalSchema>;

export function readRuntimeUpdateJournal(input: unknown): JournalRead<RuntimeUpdateJournalRecord> {
  return journalOf(runtimeUpdateJournalSchema, input);
}

/** `updater-starting.json`: a launched or resuming updater on its way to `id`. Only `id` and `at` are read. */
export const updaterStartingSchema = z.object({ id: z.unknown().exactOptional(), state: z.unknown().exactOptional(), at: z.unknown().exactOptional() });
/** The mark's update id and start time when it has them; a mark without them is no updater starting, as before. */
export function updaterStartingOf(input: unknown): { id: unknown; at: number } | null {
  const read = updaterStartingSchema.safeParse(input);
  if (!read.success) return null;
  return { id: read.data.id, at: Date.parse(typeof read.data.at === "string" ? read.data.at : String(read.data.at ?? "")) };
}

/** A staged release's `update.json` as pruning reads it: only `startedAt`, from a partial or older file alike. */
export const stagedReleaseStartSchema = z.object({ startedAt: z.unknown().exactOptional() });

/**
 * When a staged release started, for pruning: `startedAt` as text (`""` when absent or when the file holds some other
 * JSON value). `null` for JSON `null`, and the folder's mtime stands in, as it does for a file that is not JSON.
 */
export function stagedStartedAt(input: unknown): string | null {
  const read = stagedReleaseStartSchema.safeParse(input);
  if (read.success) return String(read.data.startedAt ?? "");
  return input === null || input === undefined ? null : "";
}
