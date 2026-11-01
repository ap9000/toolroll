/**
 * A scope's terms as a chat card shows them whole, and the digest of exactly those words. A task filed from outside
 * text (a youiyoux change request) approves from chat only on a card that showed every word of its terms, nothing cut:
 * the card binds that digest to its button, and the seal (store.ts, the outside-request quarantine) recomputes it from
 * the live scope and refuses a tap that names anything else. A leaf: the store and the chat road both read it.
 */
import { createHash } from "node:crypto";
import { isAcpProfile } from "./acp-agents.js";
import type { Scope } from "./scope.js";

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

export type ShownScope = Pick<Scope, "goal" | "outOfScope" | "touches" | "acceptance" | "profile" | "budgetMicrousd">;

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
  ].join("\n");
}

/** The digest of the terms shown, bound to the scope's own digest: a changed word, limit or route is another digest. */
export function shownTermsDigest(scope: ShownScope & Pick<Scope, "digest">): string {
  return createHash("sha256").update(JSON.stringify({ v: 1, scope: scope.digest, shown: scopeTermsText(scope) })).digest("hex");
}
