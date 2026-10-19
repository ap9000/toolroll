/**
 * A project's "Show commands in the live view" (docs/plans/live-conversation.md):
 * whether a running agent's command text and command output are written to
 * its live conversation. Off unless an approver turned it on for the
 * project with their password; turning it off is one step. Every change is
 * an action-ledger line.
 *
 * The writer reads it once, when it opens a run's live file: what is off
 * never reaches disk, and a change applies from the next run.
 */
import { createHash } from "node:crypto";
import type { Store } from "./store.js";

/** The consent a "Show commands" form carries: a single-use nonce minted for this person and these exact terms. */
export const LIVE_VIEW_CONSENT = "live-view";
export function liveViewConsentDigest(repo: string): string {
  return createHash("sha256").update(JSON.stringify(["live-view", repo, "commands-on"])).digest("hex");
}

export type LiveDetailSetting = { repo: string; commands: boolean; updatedBy: string; updatedAt: string };

/** Whether this project's live conversations show commands. Unknown or absent is off. */
export function liveCommandsShown(store: Store, repo: string | null): boolean {
  if (repo === null) return false;
  try {
    const row = store.handle.prepare("SELECT commands FROM live_detail_setting WHERE repo = ?").get(repo);
    return row !== undefined && Number(row["commands"]) === 1;
  } catch {
    return false;
  }
}

export function liveDetailSetting(store: Store, repo: string): LiveDetailSetting | null {
  const row = store.handle.prepare("SELECT repo, commands, updated_by, updated_at FROM live_detail_setting WHERE repo = ?").get(repo);
  if (row === undefined) return null;
  return { repo: String(row["repo"]), commands: Number(row["commands"]) === 1, updatedBy: String(row["updated_by"]), updatedAt: String(row["updated_at"]) };
}

/** Save the setting and its ledger line in one transaction. The caller has proved who is asking (and, to turn it on, their password). */
export function setLiveCommands(store: Store, change: { repo: string; commands: boolean; by: string; via: string }, now: Date): { said: string } {
  store.transact(() => {
    store.handle
      .prepare(`INSERT INTO live_detail_setting (repo, commands, updated_by, updated_at) VALUES (?,?,?,?)
        ON CONFLICT (repo) DO UPDATE SET commands = excluded.commands, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(change.repo, change.commands ? 1 : 0, change.by, now.toISOString());
    store.recordAction({ at: now.toISOString(), actor: change.by, repo: change.repo, taskId: null, runId: null,
      action: "live view commands", outcome: change.commands ? "on" : "off", source: "request", detail: `via ${change.via}` });
  });
  return { said: change.commands ? "Commands now show in the live view for this project, from the next run." : "Commands are hidden in the live view for this project, from the next run." };
}

/** A run's trusted context for its live file: its own checkout, and its project's setting, read now. */
export function liveLogContext(store: Store, taskRef: number, worktree: string | null): { base: string | null; commands: boolean } {
  let repo: string | null = null;
  try { repo = store.refForId(taskRef)?.repo ?? null; } catch { repo = null; }
  return { base: worktree, commands: liveCommandsShown(store, repo) };
}
