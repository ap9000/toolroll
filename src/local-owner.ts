/**
 * Local mode's restricted principal (docs: easy-start plan C1). A laptop install made by `up --laptop` starts with one
 * owner who has no password: the browser and the terminal UI drive it as the **local owner**, a principal that may do
 * the everyday acts below and nothing that creates or widens a way in. Everything else stays with **full** authority
 * (a password typed now, an identity-provider sign-in, an API token).
 *
 * Types and pure helpers only: enforcement (route marks, the chat confirm gate, the prover's order) reads these.
 */
import type { LeadProposalKind } from "./store.js";

/** Who a browser session or a terminal command speaks as. Saved sessions from before local mode read "full". */
export type Authority = "full" | "local-owner";
export const AUTHORITIES: readonly Authority[] = Object.freeze(["full", "local-owner"]);
/** A runtime string as an authority; anything else is null (never "full" by default). */
export function authorityOf(value: unknown): Authority | null {
  return value === "full" || value === "local-owner" ? value : null;
}

/**
 * The acts a local owner may do (plan C1). Ids only: each surface (a route row, a chat action, a CLI command) names
 * the act it is, and an act not in this list is refused to a local owner.
 */
export const LOCAL_OWNER_ACTS = Object.freeze([
  "file-task",
  "lead-send",
  "approve-plan",
  "answer-question",
  "stop-run",
  "pause-run",
  "resume-run",
  "complete-task",
  "request-revision",
  "archive-task",
  "add-project",
  "choose-default-agent",
  "mark-seen",
  "watch-agent",
  "read",
] as const);
export type LocalOwnerAct = (typeof LOCAL_OWNER_ACTS)[number];
const ACT_SET: ReadonlySet<string> = new Set(LOCAL_OWNER_ACTS);
/** Whether a runtime string names an act a local owner may do. */
export function localOwnerAct(value: unknown): value is LocalOwnerAct {
  return typeof value === "string" && ACT_SET.has(value);
}

/**
 * Every lead proposal kind, decided for the local owner. A new kind fails to compile here until someone decides it
 * (like METHOD_IS_PERSON in person-proof.ts). `action` and `task_action` are allowed only for an operation that is a
 * LOCAL_OWNER_ACTS act; the confirm gate checks that operation too.
 */
export const LOCAL_OWNER_PROPOSALS: Readonly<Record<LeadProposalKind, "allow" | "refuse">> = Object.freeze({
  task: "allow",
  answer: "allow",
  steer: "allow",
  cancel: "allow",
  hold: "allow",
  unhold: "allow",
  action: "allow",
  task_action: "allow",
  next: "refuse",
  reserve: "refuse",
  scope: "refuse",
  repair: "refuse",
  agents: "refuse",
  review: "refuse",
  control: "refuse",
});
/** Kinds whose allow also needs the operation itself to be a local-owner act. */
export const OPERATION_KINDS: ReadonlySet<LeadProposalKind> = new Set<LeadProposalKind>(["action", "task_action"]);

/**
 * Whether a local owner may confirm a proposal of this kind. A runtime string: an unknown kind is refused. For
 * `action`/`task_action`, `act` must be the local-owner act the operation is (null or unknown refuses).
 */
export function localOwnerMayConfirm(kind: unknown, act: unknown = null): boolean {
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(LOCAL_OWNER_PROPOSALS, kind)) return false;
  if (LOCAL_OWNER_PROPOSALS[kind as LeadProposalKind] !== "allow") return false;
  return OPERATION_KINDS.has(kind as LeadProposalKind) ? localOwnerAct(act) : true;
}

/** Local mode as saved (store.ts `local_mode`, one row): who the owner is, its generation, and whether it is on. */
export type LocalMode = { owner: string; generation: number; enabled: boolean; initializedAt: string; changedAt: string };

/**
 * Whether a local-owner session or link still stands against local mode as read now: on, at the generation it was
 * bound to, for the same owner. Pure: the caller reads `mode` in the same transaction as the act.
 */
export function localBindingStands(mode: LocalMode | null, binding: { account: string; localGeneration: number | null }): boolean {
  return mode !== null && mode.enabled && binding.localGeneration !== null && mode.generation === binding.localGeneration && mode.owner === binding.account;
}
