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
import type { Store } from "./store.js";

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
