/** When an approval form asks for a password (docs/plans/plain-toolroll.md P1.3): one function every approve form reads,
 * so the task page, the focused chat and the shared-action review never disagree. It only decides what a form shows;
 * approve() proves the person, the freshness, the local owner and the digest again inside its own transaction, with
 * the same two rules this reads (freshlyApprovable, localApprovalEligible).
 *
 * - `none`: Passwordless is on for this session, or this computer's local owner may approve this exact work.
 * - `remembered`: a password typed on this session in the last fifteen minutes may stand for these terms; the field
 *   shows, and may be left empty.
 * - `required`: a password typed now: protected or escalated work, terms an agent wrote, or nothing remembered.
 * - `local-refused`: a local owner who can't approve this here, with where to go instead. */
import { freshlyApprovable, localApprovalEligible } from "./scope.js";
import { localOwnerRefusal } from "./local-owner.js";
import type { Scope } from "./scope.js";
import type { Store } from "./store.js";

export type ApprovalPasswordField =
  | { field: "none"; why: "passwordless" | "local-owner" }
  | { field: "remembered"; since: string }
  | { field: "required" }
  | { field: "local-refused"; message: string; href: string; action: string };

export type ApprovalPasswordFacts = {
  /** The approver. */
  name: string;
  taskId: string;
  scope: Scope;
  /** Passwordless is on for this browser session (html.ts passwordlessRendering). */
  passwordless: boolean;
  /** The request is this laptop's local owner (easy-start C5). */
  localOwner: boolean;
  /** When a password was last typed on this session, if it may still stand (scope.ts freshnessFor), else null. */
  freshAt: number | null;
  /** Where a refused local owner goes back to. */
  returnTo: string;
};

export function approvalPasswordField(store: Store, facts: ApprovalPasswordFacts): ApprovalPasswordField {
  if (facts.localOwner) {
    if (localApprovalEligible(store, facts.name, facts.taskId).ok) return { field: "none", why: "local-owner" };
    return { field: "local-refused", ...localOwnerRefusal(store.accountOf(facts.name)?.passwordSet === true, facts.returnTo) };
  }
  if (facts.passwordless) return { field: "none", why: "passwordless" };
  if (facts.freshAt === null) return { field: "required" };
  const gate = store.approvalGate(facts.taskId, facts.name, "person");
  return freshlyApprovable(store, facts.taskId, facts.scope, gate.verdict === "seal" && !gate.protectedWork)
    ? { field: "remembered", since: new Date(facts.freshAt).toISOString() } : { field: "required" };
}
