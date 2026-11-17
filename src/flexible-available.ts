/**
 * Interactive agent threads (the Flexible plan v2; Settings → General, "Interactive agent threads (beta)"): whether this
 * installation offers them, as its one saved switch says (flexible_setting, schema v171; flexible-setting-schema.ts).
 *
 * - Off unless its one row says on: a new install and an upgraded one start with threads off, and a row that can't be
 *   read is off. No environment variable, config file, flag, token or request field reads or changes it.
 * - Only an instance operator, as a person, changes it (the Settings route and `toolroll config set flexible`; never a
 *   token, the lead or a chat app), proved and written in one transaction with its ledger row (setFlexibleSetting). On
 *   relays the person's Claude sign-in to agents, so it is a credential act: a password typed now on every install,
 *   solo included. Off only narrows: the ordinary step-up (a solo session stands in, a team needs the password).
 * - Every entry point that starts or grants something checks it first (`if (!flexibleAvailable(store)) return ...`): a
 *   thread, a turn, the sign-in relay, a request recorded from an agent, a person's answer, a project's Flexible terms
 *   turned on, the start's terms card, an armed merge. Where an await comes between that check and the write, the write's
 *   own transaction reads it again: the thread start (the transaction that records the thread and admits its turn),
 *   each relay call (its reservation), a launch's start gate (its final reservation, flexible-launch.ts
 *   reserveLaunchOpen), arming a Ship, completing it and reserving its merge (flexible-ship.ts).
 * - What settles, stops, narrows or reads never checks it: stopping an agent, revoking and expiring answers, finishing,
 *   withdrawing and interrupting turns, holder recovery, settling Ships and merges, narrowing a project's terms, a
 *   thread's level or the installation's limits, a person's reads of their own threads, inspecting a thread's candidate
 *   and its quarantined import.
 * - Turned off while a thread runs, the thread is stopped safely: its relay refuses every new model call at once, no
 *   launch's gate opens, nothing new is admitted, recorded or answered, and the agent is stopped by its recorded
 *   process identities (answers revoked, the whole tree stopped and its exit verified, the turn interrupted, the relay
 *   closed): by `toolroll config set flexible off` itself (whoever holds it, a crashed console's included), and by every
 *   console's upkeep tick (every five seconds; engine-api.ts), which keeps retrying any stop not yet verified.
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
