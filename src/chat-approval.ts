/** Approving from chat (owner's decision, docs/plans/toolroll-cards.md): a person with the authority approves from their
 * own linked chat by default, with no limits of their own. This setting is how they say otherwise: off for all their
 * projects or for one, or on with limits (whether a plan may ask for full access, and the most one attempt may cost). A
 * project's own row outranks the all-projects one, and an explicit "off" keeps it off. Turning it off for all projects
 * also disables that owner's saved project rows.
 *
 * A saved row ends with the account: a reset password, revoked access or a lost project ends it, and it must be saved
 * again. Saving limits takes the password; turning it off is one step. Every change is a ledger line.
 *
 * What the setting allows is only that the owner's own two taps in their paired chat count as their yes. Every other
 * rule still applies at the offer and again at the tap (chat-decide.ts planInChat): protected paths, separation of
 * duties, organisation policy, written-for-you plans, unresolved routes, and the limits here. */
import { createHash } from "node:crypto";
import { chatApproveChatsOf, chatNames, modeTermsFromJson, type ModeTerms } from "./modes.js";
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
  const account = store.accountOf(approver);
  if (setting === null) {
    if (account === null || account.revokedAt !== null || account.role !== "approver" || !store.accountCanAccess(approver, repo)) return { ok: false, why: "Only an approver for this project can approve it." };
    const limits: ChatApprovalLimits = { fullAccess: true, capMicrousd: null };
    return { ok: true, limits, setting: { ...limits, approver, scope: ALL_PROJECTS, enabled: true, generation: account.generation, digest: digestOf(approver, ALL_PROJECTS, limits, account.generation), updatedBy: approver, updatedAt: "" } };
  }
  if (!setting.enabled) return { ok: false, why: "You turned off approving from chat for this project." };
  if (account === null || account.revokedAt !== null || account.role !== "approver" || account.generation !== setting.generation || !store.accountCanAccess(approver, repo)) {
    return { ok: false, why: "Your access changed since you saved your chat approval setting. Save it again in Settings." };
  }
  if (setting.digest !== digestOf(setting.approver, setting.scope, setting, setting.generation)) return { ok: false, why: "Your chat approval setting can't be read. Turn it on again in Settings." };
  return { ok: true, setting, limits: { fullAccess: setting.fullAccess, capMicrousd: setting.capMicrousd } };
}

/** What this person's chat on `channel` may approve on this repository now, and under whose limits: their saved setting,
 * else (only with nothing saved) their own live signed mode that names this chat app, else their standing as an
 * approver. A saved setting that refuses refuses here. `digest` names that for
 * the ledger; the yes itself is the person's tap and is sealed as theirs, so it doesn't lapse when the authority does. */
export function chatApproveMode(store: Store, repo: string | null, approver: string, now: Date, channel: "telegram" | "slack" | "discord" | "teams"):
  { ok: true; digest: string; limits: ChatApprovalLimits; source: "setting" | "mode" } | { ok: false; why: string } {
  if (repo === null) return { ok: false, why: "Approving from chat isn't turned on for this project." };
  const setting = effectiveChatApproval(store, repo, approver);
  // A saved setting decides: its "off", a lapse after an access change or an unreadable row refuses before any mode is
  // looked at, so a signed mode never reopens what the person turned off. The mode counts only when nothing is saved.
  if (!setting.ok) return setting;
  const chosen = { ok: true as const, source: "setting" as const };
  if (setting.setting.updatedAt !== "") return { ...chosen, digest: setting.setting.digest, limits: setting.limits };
  // Nothing saved: their own signed mode's limits, where it names this chat app; otherwise their standing as an approver.
  const mode = store.activeMode(repo, now);
  const terms: ModeTerms | null = mode === null ? null : modeTermsFromJson(mode.termsJson);
  if (mode !== null && terms !== null && terms.chatApprove && mode.signedBy === approver && store.accountCanAccess(approver, repo) && chatApproveChatsOf(terms).includes(channel))
    return { ok: true, digest: mode.digest, limits: { fullAccess: terms.permissionDefault === "escalated", capMicrousd: terms.perAttemptBudgetMicrousd }, source: "mode" };
  return { ...chosen, digest: setting.setting.digest, limits: setting.limits };
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
