/** Approving from chat as a lasting owner setting. An approver turns it on for all their projects or for one, with the
 * limits they agree to (whether a plan may ask for full access, and the most one attempt may cost); a project's own
 * row outranks the all-projects one, and an explicit "off" on a project keeps it off there. Turning it off for all
 * projects also disables that owner's saved project rows. It is off until turned on.
 *
 * It never lapses by date, but it ends with the account: a reset password, revoked access or a lost project ends it.
 * Turning it on or changing its limits takes the password; turning it off is one step. Every change is a ledger line.
 *
 * What the setting allows is only that the owner's own two taps in their paired chat count as their yes. Every other
 * rule still applies at the offer and again at the tap (chat-decide.ts planInChat): protected paths, separation of
 * duties, organisation policy, written-for-you plans, unresolved routes, and the limits here. */
import { createHash } from "node:crypto";
import type { Store } from "./store.js";

/** The all-projects row's scope. */
export const ALL_PROJECTS = "*";

export type ChatApprovalLimits = { fullAccess: boolean; capMicrousd: number | null };
export type ChatApprovalSetting = ChatApprovalLimits & { approver: string; scope: string; enabled: boolean; generation: number; digest: string; updatedBy: string; updatedAt: string };

const money = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

function digestOf(approver: string, scope: string, limits: ChatApprovalLimits, generation: number): string {
  return createHash("sha256").update(JSON.stringify({ v: 1, approver, scope, fullAccess: limits.fullAccess, capMicrousd: limits.capMicrousd, generation })).digest("hex");
}

function readRow(row: Record<string, unknown>): ChatApprovalSetting {
  return {
    approver: String(row["approver"]), scope: String(row["scope"]), enabled: Number(row["enabled"]) === 1, fullAccess: Number(row["full_access"]) === 1,
    capMicrousd: row["attempt_cap_microusd"] == null ? null : Number(row["attempt_cap_microusd"]), generation: Number(row["generation"]),
    digest: String(row["digest"]), updatedBy: String(row["updated_by"]), updatedAt: String(row["updated_at"]),
  };
}

/** This person's rows: all projects first, then each project's. */
export function chatApprovalSettings(store: Store, approver: string): ChatApprovalSetting[] {
  return store.handle.prepare("SELECT * FROM chat_approval_setting WHERE approver = ? ORDER BY scope = '*' DESC, scope").all(approver).map(row => readRow(row as Record<string, unknown>));
}

/** The limits in plain words, said once: what a yes in chat may start. */
export function chatApprovalWords(limits: ChatApprovalLimits): string {
  return `${limits.fullAccess ? "plans may ask for full access" : "plans that ask for full access open in Toolroll"} · ${limits.capMicrousd === null ? "any attempt limit" : `attempts up to ${money(limits.capMicrousd)}`}`;
}

/** Whether this person's chat may approve on this project now, under their lasting setting: which row, and its limits. */
export function effectiveChatApproval(store: Store, repo: string, approver: string):
  { ok: true; setting: ChatApprovalSetting; limits: ChatApprovalLimits } | { ok: false; why: string } {
  const project = store.handle.prepare("SELECT * FROM chat_approval_setting WHERE approver = ? AND scope = ?").get(approver, repo);
  const all = store.handle.prepare("SELECT * FROM chat_approval_setting WHERE approver = ? AND scope = ?").get(approver, ALL_PROJECTS);
  const row = project ?? all;
  const setting = row === undefined ? null : readRow(row as Record<string, unknown>);
  if (setting === null || !setting.enabled) return { ok: false, why: "Approving from chat isn't turned on for this project." };
  const account = store.accountOf(approver);
  if (account === null || account.revokedAt !== null || account.role !== "approver" || account.generation !== setting.generation || !store.accountCanAccess(approver, repo)) {
    return { ok: false, why: "Your access changed since you turned on approving from chat. Turn it on again in Settings." };
  }
  if (setting.digest !== digestOf(setting.approver, setting.scope, setting, setting.generation)) return { ok: false, why: "Your chat approval setting can't be read. Turn it on again in Settings." };
  return { ok: true, setting, limits: { fullAccess: setting.fullAccess, capMicrousd: setting.capMicrousd } };
}

export type ChatApprovalChange = { approver: string; scope: string; enabled: boolean; limits?: ChatApprovalLimits; via: string };

/** Save and ledger the setting; all-projects off also disables every saved project row for this owner.
 * The caller has proved who is asking, and for "on" the password. */
export function setChatApproval(store: Store, change: ChatApprovalChange, now: Date): { ok: true; said: string } | { ok: false; message: string } {
  const account = store.accountOf(change.approver);
  if (account === null || account.revokedAt !== null || account.role !== "approver") return { ok: false, message: "Only an approver can approve from chat." };
  if (change.scope !== ALL_PROJECTS && !store.accountCanAccess(change.approver, change.scope)) return { ok: false, message: "That isn't one of your projects." };
  const limits = change.limits ?? { fullAccess: false, capMicrousd: null };
  if (limits.capMicrousd !== null && (!Number.isSafeInteger(limits.capMicrousd) || limits.capMicrousd < 0)) return { ok: false, message: "Give the attempt limit in dollars, like 5." };
  const where = change.scope === ALL_PROJECTS ? "all your projects" : change.scope;
  store.transact(() => {
    const settings = [{ scope: change.scope, limits }];
    if (change.scope === ALL_PROJECTS && !change.enabled) {
      for (const setting of chatApprovalSettings(store, change.approver)) {
        if (setting.scope !== ALL_PROJECTS) settings.push({ scope: setting.scope, limits: setting });
      }
    }
    const save = store.handle.prepare(`INSERT INTO chat_approval_setting (approver, scope, enabled, full_access, attempt_cap_microusd, generation, digest, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (approver, scope) DO UPDATE SET enabled = excluded.enabled, full_access = excluded.full_access,
      attempt_cap_microusd = excluded.attempt_cap_microusd, generation = excluded.generation, digest = excluded.digest, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    for (const { scope, limits } of settings) {
      save.run(change.approver, scope, change.enabled ? 1 : 0, limits.fullAccess ? 1 : 0, limits.capMicrousd, account.generation,
        digestOf(change.approver, scope, limits, account.generation), change.approver, now.toISOString());
      store.recordAction({ at: now.toISOString(), actor: change.approver, repo: scope === ALL_PROJECTS ? null : scope, taskId: null, runId: null,
        action: "chat approval setting", outcome: change.enabled ? "on" : "off", source: "request",
        detail: `${scope === ALL_PROJECTS ? "all projects" : "this project"}${change.enabled ? ` · ${chatApprovalWords(limits)}` : ""} · via ${change.via}` });
    }
  });
  return { ok: true, said: change.enabled ? `Approving from chat is on for ${where}: ${chatApprovalWords(limits)}.` : `Approving from chat is off for ${where}.` };
}
