/**
 * A scope's terms as a chat card shows them whole, and the digest of exactly those words. A task filed from outside
 * text (a youiyoux change request) approves from chat only on a card that showed every word of its terms, nothing cut:
 * the card binds that digest to its button, and the seal (store.ts, the outside-request quarantine) recomputes it from
 * the live scope and refuses a tap that names anything else. A leaf: the store and the chat road both read it.
 */
import { createHash } from "node:crypto";
import { isAcpProfile } from "./acp-agents.js";
import { checkAccessWords } from "./check-access.js";
import { sandboxTermsWords } from "./project-sandbox.js";
import { chainTermsLines, type Scope } from "./scope.js";

/** What a plan's yes allows an agent to do, in a few plain words (the approval sheet's "You're allowing"). */
export function permissionPlainWords(profile: Scope["profile"] | null | undefined): string | null {
  if (profile === null || profile === undefined) return null;
  const full = "full access, nothing asks first";
  if (profile.provider === "claude") {
    return profile.permissionArgv === "bypassPermissions" ? full
      : profile.permissionArgv === "auto" ? "file edits and routine commands; anything risky stops"
      : "file edits only; commands are refused";
  }
  if (profile.provider === "gemini") return profile.approvalArgv === "yolo" ? full : "file edits only; other tools are refused";
  if (isAcpProfile(profile)) return "full access inside the OS fence, nothing asks first";
  return profile.sandboxMode === "danger-full-access" ? full : "file edits and commands inside the project only";
}

const money = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

export type ShownScope = Pick<Scope, "goal" | "outOfScope" | "touches" | "acceptance" | "profile" | "budgetMicrousd"> & Partial<Pick<Scope, "proposedChainJson">>;

/** Every word of the terms a yes agrees to, as the card shows them: the goal, what's excluded, the files (or plainly any
 * file), each requirement with the evidence it needs, and what the agent may do and spend. Nothing is shortened. */
export function scopeTermsText(scope: ShownScope): string {
  const allows = [permissionPlainWords(scope.profile) ?? "agent permissions not known", scope.budgetMicrousd === null ? "no attempt limit" : `up to ${money(scope.budgetMicrousd)} per attempt`];
  return [
    "Goal:", scope.goal,
    "",
    "Not this:", scope.outOfScope ?? "Nothing excluded.",
    "",
    `Files: ${scope.touches.length === 0 ? "any file (no file list)" : scope.touches.join(", ")}`,
    "",
    "Done when:",
    ...(scope.acceptance.length === 0 ? ["You decide when you review the result."] : scope.acceptance.map(one => `• ${one.statement} (${one.evidence.join(", ")})`)),
    "",
    `Starting allows: ${allows.join(" · ")}`,
    ...((chain) => chain.length === 0 ? [] : ["", "Fallback agents:", ...chain])(chainTermsLines(scope)),
  ].join("\n");
}

/** The digest of the terms shown, bound to the scope's own digest: a changed word, limit or route is another digest. */
export function shownTermsDigest(scope: ShownScope & Pick<Scope, "digest">): string {
  return createHash("sha256").update(JSON.stringify({ v: 1, scope: scope.digest, shown: scopeTermsText(scope) })).digest("hex");
}

/** The digest of the exact words a card showed, taken when the card was made and kept with it. */
export function cardTermsDigest(terms: string): string {
  return createHash("sha256").update(JSON.stringify({ v: 2, shown: terms })).digest("hex");
}

/** Whether these words show this scope as it is now: its whole terms text, word for word, and what only a person's own
 * yes may agree to (checks past the sandbox, extra services). Part of the terms, or an earlier version's, is not. */
export function cardShowsScope(scope: ShownScope, terms: string): boolean {
  if (!terms.includes(scopeTermsText(scope))) return false;
  const profile = scope.profile;
  if (profile === null || profile === undefined) return true;
  const access = profile.checkAccess, mach = sandboxTermsWords(profile).mach;
  return (access === undefined || terms.includes(checkAccessWords(access))) && (mach === null || terms.includes(mach));
}

/** Whether a scope lets its agent do anything, nothing asking first. */
export function scopeFullAccess(profile: Scope["profile"] | null | undefined): boolean {
  if (profile === null || profile === undefined) return false;
  return profile.provider === "claude" ? profile.permissionArgv === "bypassPermissions"
    : profile.provider === "gemini" ? profile.approvalArgv === "yolo" : isAcpProfile(profile) ? true : profile.sandboxMode === "danger-full-access";
}

/** Why a person's own limits refuse this scope, or null. */
export function chatLimitProblem(scope: Pick<Scope, "profile" | "budgetMicrousd">, limits: { fullAccess: boolean; capMicrousd: number | null }, yours: string): string | null {
  if (scopeFullAccess(scope.profile) && !limits.fullAccess) return `This plan asks for more access than ${yours} allows.`;
  const cap = limits.capMicrousd;
  if (cap !== null && (scope.budgetMicrousd === null || scope.budgetMicrousd > cap))
    return `This plan has ${scope.budgetMicrousd === null ? "no attempt limit" : `a ${money(scope.budgetMicrousd)} attempt limit`}, more than ${yours === "your mode" ? "your mode's" : "your chat approval limit of"} ${money(cap)}.`;
  return null;
}
