/**
 * Interactive agent threads (the Flexible plan v2; Settings → General, "Interactive agent threads (beta)"): whether this
 * installation offers them, as its one saved switch says (flexible_setting, schema v171; flexible-setting-schema.ts).
 *
 * - Off unless its one row says on: a new install and an upgraded one start with threads off, and a row that can't be
 *   read is off. No environment variable, config file, flag, token or request field reads or changes it.
 * - Only a person's ordinary setting step-up changes it (the Settings route and `toolroll config set flexible`: an
 *   instance operator; a solo session stands in, a team needs the password, never a token), proved and written in one
 *   transaction with its ledger row (setFlexibleSetting).
 * - Every entry point that starts something new checks it first (`if (!flexibleAvailable(store)) return refuse(...)`):
 *   a thread, a turn, an agent launch, the sign-in relay and each of its model calls, a request recorded from an agent,
 *   a person's answer, a project's Flexible terms turned on, the start's terms card, Ship and its merge. The thread
 *   start reads it again inside the transaction that records the thread and admits its first turn.
 * - What settles or stops what already exists never checks it, so turning threads off can always clean up: stopping an
 *   agent, revoking and expiring answers, finishing, withdrawing and interrupting turns, holder recovery, and narrowing a
 *   project's terms or a thread's level.
 * - Turned off while a thread runs, the thread is stopped safely: its relay refuses every new model call at once (the
 *   check is inside each call's own reservation transaction), nothing new is admitted, recorded or answered, and the
 *   console's next upkeep tick (every five seconds; engine-api.ts) stops each running agent: answers revoked, the whole
 *   process tree stopped and its exit verified, the turn interrupted, the relay closed. Wherever it was turned off: the
 *   browser or the CLI.
 *
 * Claude Code only for now: a thread's agent is Claude (flexible-session.ts startFlexibleThread), and a Codex thread is
 * refused (flexible-thread.ts flexibleThreadCodexProfile; the engine API's thread start). Left before the default can
 * flip on for solo installs: Claude's permission prompts proved to reach the person (F0 row H), Codex threads inside the
 * srt thread fence, the bubblewrap attack runs green in CI (test/attacks/flexible-thread-fence.slow.test.ts, Linux native
 * lane, no skips), and the import's quarantine proved against the real sandbox.
 */
import type { Store } from "./store.js";

/** The ledger's action for a change of the switch. */
export const FLEXIBLE_SETTING_ACTION = "interactive agent threads";

/** Whether interactive agent threads are on in this installation: only its one row saying on is on. */
export function flexibleAvailable(store: Pick<Store, "handle">): boolean {
  let row: Record<string, unknown> | undefined;
  try { row = store.handle.prepare("SELECT enabled FROM flexible_setting WHERE id = 1").get(); } catch { return false; }
  return row !== undefined && row["enabled"] === 1;
}

/** The switch as saved: on or off, and who chose it and when (null when nobody has). */
export function flexibleSetting(store: Pick<Store, "handle">): { on: boolean; by: string | null; at: string | null } {
  let row: Record<string, unknown> | undefined;
  try { row = store.handle.prepare("SELECT enabled, updated_by, updated_at FROM flexible_setting WHERE id = 1").get(); } catch { row = undefined; }
  if (row === undefined) return { on: false, by: null, at: null };
  return { on: row["enabled"] === 1, by: String(row["updated_by"]), at: String(row["updated_at"]) };
}

/** Turn interactive agent threads on or off, with its ledger row. The caller proved the person (an instance operator's
 * step-up) in the same transaction it calls this in. `changed`: the switch moved. */
export function setFlexibleSetting(store: Pick<Store, "handle" | "recordAction">, on: boolean, by: string, now: Date): { changed: boolean } {
  const was = flexibleAvailable(store);
  store.handle.prepare(`INSERT INTO flexible_setting (id, enabled, updated_by, updated_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(on ? 1 : 0, by, now.toISOString());
  store.recordAction({ at: now.toISOString(), actor: by, repo: null, taskId: null, runId: null, action: FLEXIBLE_SETTING_ACTION, outcome: on ? "on" : "off", source: "policy",
    detail: was === on ? "unchanged" : null });
  return { changed: was !== on };
}
