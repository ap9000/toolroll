/**
 * Local mode's restricted principal (docs: easy-start plan C1). A laptop install made by `up --laptop` starts with one
 * owner who has no password: the browser and the terminal UI drive it as the **local owner**, a principal that may do
 * the everyday acts below and nothing that creates or widens a way in. Everything else stays with **full** authority
 * (a password typed now, an identity-provider sign-in, an API token).
 *
 * Types and pure helpers only: enforcement (route marks, the chat confirm gate, the prover's order) reads these.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { LeadProposalKind, Store } from "./store.js";
import type { ChatAction } from "./chat-actions.js";
import type { ChatTaskAction } from "./chat-task-actions.js";

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
  // A fast start: file and approve in one step (fast-start.ts). Everything else this act could reach is refused.
  "build-now",
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
  // Results routing (docs/plans/results-routing.md, Authority): lowering only — turning an earned rule off (or
  // dropping a paused one), and saying Not now to a suggestion (or switching suggestions off). The writer
  // (route-store.ts proveRuleDoor) checks the in-flight act is exactly the one it needs.
  "routing-turn-off",
  "dismiss-suggestion",
  // Slice 3: stopping a trial of a cheaper model only lowers (proveRuleDoor checks this exact act).
  "trial-stop",
  // The code map (docs/plans/code-map.md §5): on or off for one project only, the same kind of setting as the default
  // agent. Never a refresh, and never the end of a holdout (code-map-acts.ts refuses those by name).
  "code-map-switch",
  // Learning loops (D3): deciding a lesson note or a clean-up of project memory. The writers (memory-pass.ts decideProposal,
  // memory-tidy.ts) check this exact act; instruction proposals stay with full authority.
  "memory-review",
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

// ---- wave 1b: the principal in flight (easy-start plan C1, C3) ----------------------------------------------------

/** Where a local owner's act came from, for the ledger: the console in a browser, or the terminal UI in-process. */
export type LocalTransport = "browser" | "terminal";

/**
 * A local owner acting now: who, the local-mode and account generations its session (or terminal start) was bound to,
 * the transport, and the act the surface it came through is (a route row, a CLI row, a chat card). Only the console's
 * admission and the CLI's dispatch create one; a request's input never names it.
 */
export type LocalPrincipal = {
  readonly account: string;
  readonly localGeneration: number;
  readonly accountGeneration: number;
  readonly transport: LocalTransport;
  readonly act: LocalOwnerAct;
  /** The browser session's saved hash (web_session.id_hash): a write re-reads that it is still saved. Null in the terminal. */
  readonly sessionHash: string | null;
  /**
   * The browser request it was admitted for, marked ended when its answer is sent. Work that outlives the request (a
   * timer or a turn started in its async chain) is never the local owner proving anything: the prover refuses it, and
   * the write-time re-check no longer applies to it. Null in the terminal (a command runs to its end).
   */
  readonly request: { ended: boolean } | null;
};

const localOwnerScope = new AsyncLocalStorage<LocalPrincipal>();
/** The local owner this async chain acts as, or null (full authority, or nobody). Work that outlived its request still
 * reads it (so it is never mistaken for full authority); `localOwnerInFlight` says whether it may still prove anything. */
export function currentLocalOwner(): LocalPrincipal | null {
  return localOwnerScope.getStore() ?? null;
}
/** Whether a local owner's act is still in its request (or its terminal command): only then may it prove or write. */
export function localOwnerInFlight(principal: LocalPrincipal): boolean {
  return principal.request === null || !principal.request.ended;
}
/** Run `body` as a local owner (the console's admission and the CLI's dispatch only). */
export function asLocalOwner<T>(principal: LocalPrincipal, body: () => T): T {
  return localOwnerScope.run(Object.freeze({ ...principal }), body);
}
/**
 * Narrow the current local owner to one act for `body` (a chat card's own act inside the confirm route). Outside a
 * local owner's chain it changes nothing. It can only ever name an allowlisted act: a caller passing null refuses.
 */
export function withLocalAct<T>(act: LocalOwnerAct, body: () => T): T {
  const current = currentLocalOwner();
  return current === null ? body() : localOwnerScope.run(Object.freeze({ ...current, act }), body);
}

const terminalRequest = new AsyncLocalStorage<true>();
/**
 * The terminal UI's door (plan C3): run CLI commands (`runOperate`) inside `fn` as the local owner. runOperate binds the
 * owner from local mode as it reads it when its database opens, and refuses every command not marked for the local owner
 * (surface.ts LOCAL_ALLOW). Never read from argv or the environment.
 */
export function runAsLocalOwner<T>(fn: () => T): T {
  return terminalRequest.run(true, fn);
}
/** Whether this chain asked to run commands as the local owner (runOperate reads it; nothing else should). */
export function localOwnerRequested(): boolean {
  return terminalRequest.getStore() === true;
}

/**
 * The act each lead proposal kind is when a local owner confirms it (null: refused, as LOCAL_OWNER_PROPOSALS says).
 * `action` and `task_action` take their operation's act instead (CHAT_ACTION_LOCAL_ACTS, CHAT_TASK_ACTION_LOCAL_ACTS).
 */
export const PROPOSAL_LOCAL_ACTS: Readonly<Record<LeadProposalKind, LocalOwnerAct | null>> = Object.freeze({
  task: "file-task",
  answer: "answer-question",
  steer: "lead-send",
  cancel: "stop-run",
  hold: "pause-run",
  unhold: "resume-run",
  action: null,
  task_action: null,
  next: null,
  reserve: null,
  scope: null,
  repair: null,
  agents: null,
  review: null,
  control: null,
});

/** Every chat action (chat-actions.ts CHAT_ACTIONS), decided for the local owner: its act, or null (refused). A new
 * action fails to compile here until someone decides it. */
export const CHAT_ACTION_LOCAL_ACTS: Readonly<Record<ChatAction, LocalOwnerAct | null>> = Object.freeze({
  skill_import: null, skill_enable: null, skill_disable: null, skill_restore: null, skill_test: null,
  knowledge_instructions: null, knowledge_save: null, knowledge_remove: null, knowledge_restore: null,
  tool_add: null, tool_remove: null,
  flow_create: null, flow_starter: null, sweep_file: null, sweep_cancel_rest: null, flow_edit: null,
  flow_card_add: null, flow_card_move: null, flow_card_approve: null, flow_card_send_back: null, flow_card_choose: null,
  flow_card_cancel: null, flow_card_comment: null, flow_card_assign: null, flow_card_watch: null, flow_script_save: null,
  flow_trigger_add: null, flow_trigger_pause: null, flow_trigger_resume: null, flow_trigger_remove: null,
  flow_browser: null, flow_browser_off: null,
  subagent_create: null, subagent_soul: null, subagent_state: null, subagent_note: null, subagent_ask: null,
  subagent_answer: null, subagent_tools: null, subagent_memory: null, subagent_routine: null, subagent_undo: null,
  kit_setup: null, decision_record: null, decision_retire: null, lead_about_you: null,
  // Chat and console parity: decided one by one, and none is a local owner's act yet. A password opens them.
  mode_revoke: null, flow_unattended_off: null, flow_archive: null, provider_resume: null, worker_note: null, lead_identity: null,
  task_archive: null, task_restore: null, incident_resolve: null, memory_decide: null,
  // Results routing: Not now only lowers (the rule door checks this exact act).
  suggestion_not_now: "dismiss-suggestion",
  // Stopping a trial only lowers (the rule door checks this exact act).
  trial_stop: "trial-stop",
  // On or off for one project; never the end of a holdout.
  code_map_switch: "code-map-switch",
  code_map_holdout_end: null,
  scope_approve: "approve-plan",
  result_accept: "complete-task",
  task_cancel: "stop-run",
  task_resume: "resume-run",
});

/** Every task card operation (chat-task-actions.ts), decided for the local owner. */
export const CHAT_TASK_ACTION_LOCAL_ACTS: Readonly<Record<ChatTaskAction, LocalOwnerAct | null>> = Object.freeze({
  stop: "stop-run",
  resume: "resume-run",
  retry: null,
  plan: null,
  wait_for: null,
  stop_waiting: null,
  run_checks: null,
  run_full_checks: null,
  add_tests: null,
});

/**
 * The act a saved proposal is for the local owner, read from its kind and (for operation kinds) its saved operation;
 * null refuses. A runtime read of saved JSON: anything unknown is null.
 */
export function proposalLocalAct(kind: unknown, operation: unknown): LocalOwnerAct | null {
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(PROPOSAL_LOCAL_ACTS, kind)) return null;
  const own = (table: Readonly<Record<string, LocalOwnerAct | null>>): LocalOwnerAct | null =>
    typeof operation === "string" && Object.prototype.hasOwnProperty.call(table, operation) ? table[operation] ?? null : null;
  const act = kind === "action" ? own(CHAT_ACTION_LOCAL_ACTS) : kind === "task_action" ? own(CHAT_TASK_ACTION_LOCAL_ACTS) : PROPOSAL_LOCAL_ACTS[kind as LeadProposalKind];
  return act !== null && localOwnerMayConfirm(kind, act) ? act : null;
}

/** The words every local-owner refusal says, and where it leads: set a first password, or sign in with the one set. */
export function localOwnerRefusal(passwordSet: boolean, returnTo: string): { message: string; action: string; href: string } {
  return passwordSet
    ? { message: "Sign in with your password to do this.", action: "Sign in with your password", href: `/login?return=${encodeURIComponent(returnTo)}` }
    // /password/set continues to the refused page once the password is set (http.ts passwordSetNext re-checks it there).
    : { message: "Set a password to do this.", action: "Set a password", href: returnTo === "/" ? "/password/set" : `/password/set?next=${encodeURIComponent(returnTo)}` };
}

/** Whether local mode is on now (absent is off). Read straight from its one row, so the store's own checks can use it. */
export function localModeOn(store: Pick<Store, "handle">): boolean {
  const row = store.handle.prepare("SELECT enabled FROM local_mode WHERE id = 1").get();
  return row !== undefined && Number(row["enabled"]) === 1;
}

/**
 * The write-time re-check (plan C1): a local owner acting now still stands — local mode on, at the generation it was
 * bound to, for the same owner; the owner an active approver at the account generation it was bound to; and (a browser)
 * its session still saved. Read in the caller's transaction: Store.transact runs it inside every write a local owner's
 * chain makes, and the prover runs it inside the approval's own transaction.
 */
export function localOwnerStandsNow(store: Pick<Store, "handle" | "accountOf" | "webSession">, principal: LocalPrincipal): boolean {
  const mode = store.handle.prepare("SELECT owner, generation, enabled FROM local_mode WHERE id = 1").get();
  if (mode === undefined || Number(mode["enabled"]) !== 1 || Number(mode["generation"]) !== principal.localGeneration || String(mode["owner"]) !== principal.account) return false;
  const account = store.accountOf(principal.account);
  if (account === null || account.revokedAt !== null || account.role !== "approver" || account.generation !== principal.accountGeneration) return false;
  return principal.sessionHash === null || store.webSession(principal.sessionHash) !== null;
}

/** What a local owner's write hears when it no longer stands (local mode turned off or moved, the owner changed, the
 * session ended). */
export const LOCAL_OWNER_LAPSED = "This local sign-in no longer stands. Run `toolroll open` to sign in again.";
/** What widening a launch's confinement hears while local mode is on (plan C5). */
export const LOCAL_MODE_CONFINES = "Turn off local mode first.";
