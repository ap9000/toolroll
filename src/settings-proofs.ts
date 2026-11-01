/**
 * The settings proof inventory (docs/plans/settings-revamp.md §4): for every settings action, the proof its handler
 * already asks for, as data. Only rendering code reads it (settings-kit.ts draws the step-up dialog from it); no
 * handler does, and nothing here changes what a handler proves. `src/settings-kit.test.ts` pins every row against the
 * form contracts (console-api.ts), the route table, and — for one row of each kind — the handler itself over HTTP.
 *
 * Proof kinds, as the handlers implement them (scope.ts, server/guards.ts):
 * - `none`: the session and the form token (CSRF) only.
 * - `step-up`: `authenticateApprover` — a password typed now; an empty field stands in under Passwordless (the
 *   person's own live browser session) and for a one-use identity-provider re-check.
 * - `credential`: `authenticateCredential` — a password typed now, or a one-use identity-provider re-check. Passwordless
 *   never covers it.
 * - `typed-password`: the handler checks the typed password itself (`authenticateAccount`, or an empty field refused
 *   before the check). Neither Passwordless nor an identity-provider re-check stands in.
 * - `typed-now-operator`: a password typed now by an instance operator (widening check access); not even a re-check.
 */
import { CONSOLE_FORMS, type ConsoleFormName } from "./contracts/console-api.js";

export type ProofKind = "none" | "step-up" | "credential" | "typed-password" | "typed-now-operator";
/** Who the route table admits (route-table.ts `role`); `handler` notes a narrower check the handler makes itself. */
export type ProofRole = "any" | "approver" | "operator";

export type ProofRow = {
  /** Stable id the kit is called with. */
  readonly id: string;
  /** What the person is doing, in words. */
  readonly action: string;
  /** The exact POST paths. */
  readonly routes: readonly string[];
  /** The form contract its handler reads through. */
  readonly form: ConsoleFormName;
  /** The proof field's name, or null when none is read. */
  readonly field: "password" | "token" | null;
  readonly proof: ProofKind;
  /** Only some submissions need the proof (the rest are `none`), in words. */
  readonly when?: string;
  /** Rows that share a route are variants of one handler, each with its own exact proof. A variant with `select`
   * applies exactly when the form carries that hidden value (the kit refuses a form whose hidden terms pick another
   * variant); a variant with `explicit` is named by the caller (a choice the server decides, like widening). */
  readonly select?: { readonly field: string; readonly value: string };
  readonly explicit?: true;
  /** Under Passwordless, does an empty proof field pass? (`accepted` only for step-up.) */
  readonly passwordless: "accepted" | "refused" | "n/a";
  /** Does a one-use identity-provider re-check (empty field after "Confirm with …") pass? */
  readonly sso: "accepted" | "refused" | "n/a";
  readonly role: ProofRole;
  /** A narrower standing the handler checks itself, in words. */
  readonly handlerRole?: string;
  /** Fields that hold a secret that is not the person's proof (never echoed, password managers kept out). */
  readonly secrets: readonly string[];
  /** Fields whose name reads like a credential but hold something else (an id, a bot token…). */
  readonly notProof?: readonly string[];
  /** Every term the handler requires besides the proof: hidden fields carried back unchanged (nonce, digest,
   * fingerprint, the shown project, what a preview showed) and the fields that pick the target (repo, act). */
  readonly terms: readonly string[];
  /** Anything else the handler requires, in words. */
  readonly note?: string;
};

const ACCEPT = { passwordless: "accepted", sso: "accepted" } as const;
const CREDENTIAL = { passwordless: "refused", sso: "accepted" } as const;
const TYPED = { passwordless: "refused", sso: "refused" } as const;
const NONE = { passwordless: "n/a", sso: "n/a" } as const;

/** /mode/sign re-derives the digest from the posted terms, so every one rides back. */
const MODE_TERMS = ["nonce", "digest", "expiry", "name", "days", "publication", "auto-approve", "plan-auto", "chat-approve"] as const;

const CHAT_APPS = [["slack", "Slack", "slack", ["app-token", "bot-token"]], ["teams", "Teams", "teams", ["secret"]], ["discord", "Discord", "discord", ["bot-token"]]] as const;

export const PROOF_INVENTORY: readonly ProofRow[] = [
  // CSRF only.
  { id: "quality-default", action: "Set the default quality for new tasks", routes: ["/settings/quality-default"], form: "qualityDefault", field: null, proof: "none", ...NONE, role: "any", secrets: [], terms: [] },
  { id: "notifications", action: "Choose what reaches you", routes: ["/settings/notifications"], form: "notifications", field: null, proof: "none", ...NONE, role: "any", secrets: [], terms: [] },
  { id: "notifications-mute", action: "Mute a project", routes: ["/settings/notifications/mute"], form: "notificationsMute", field: null, proof: "none", ...NONE, role: "any", secrets: [], terms: [] },
  { id: "messaging", action: "Choose the chat app that receives alerts", routes: ["/settings/messaging"], form: "messaging", field: null, proof: "none", ...NONE, role: "any", secrets: [], terms: [] },
  { id: "telegram-digest", action: "Set the Telegram digest", routes: ["/settings/telegram-digest"], form: "telegramDigest", field: null, proof: "none", ...NONE, role: "any", secrets: [], terms: [] },
  { id: "provider-key", action: "Save or clear an AI provider key", routes: ["/settings/provider-key", "/settings/provider-key-clear"], form: "providerKey", field: null, proof: "none", ...NONE, role: "any", secrets: ["value"], terms: [] },
  { id: "telegram-token", action: "Save the Telegram bot token", routes: ["/settings/telegram-token"], form: "telegramToken", field: null, proof: "none", ...NONE, role: "any", secrets: ["token"], notProof: ["token"], terms: [] },
  { id: "email", action: "Set up or test email", routes: ["/settings/email", "/settings/email-test", "/settings/email-read-test"], form: "email", field: null, proof: "none", ...NONE, role: "any", secrets: ["password"], notProof: ["password"], terms: [], note: "`password` is the mail server's password; its wire name stays" },
  { id: "google", action: "Connect or disconnect Google", routes: ["/settings/google", "/settings/google/disconnect"], form: "google", field: null, proof: "none", ...NONE, role: "any", secrets: ["clientSecret"], terms: [] },
  { id: "appearance", action: "Change the theme or accent", routes: ["/settings/appearance"], form: "appearance", field: null, proof: "none", ...NONE, role: "any", secrets: [], terms: [] },
  { id: "chat-approval-confirm", action: "Review approving from chat", routes: ["/settings/chat-approval/confirm", "/settings/chat-approval/off"], form: "chatApproval", field: null, proof: "none", ...NONE, role: "approver", secrets: [], terms: [] },
  ...CHAT_APPS.map(([app, name, form]): ProofRow => ({ id: `${app}-alerts`, action: `Send alerts to ${name}`, routes: [`/settings/${app}/alerts`], form, field: null, proof: "none", ...NONE, role: "approver", secrets: [], terms: [] })),

  // Step-up: a password typed now, the Passwordless session, or a one-use re-check.
  { id: "permission-default", action: "Start new tasks with Full access", routes: ["/settings/permission-default"], form: "permissionDefault", field: "password", proof: "step-up", when: "only when widening to Full access", ...ACCEPT, role: "any", secrets: [], terms: [] },
  { id: "spend-budget", action: "Set a monthly limit", routes: ["/spend/budget"], form: "spendBudget", field: "password", proof: "step-up", ...ACCEPT, role: "operator", secrets: [], terms: [] },
  { id: "models-agent", action: "Change which model does each job", routes: ["/settings/models/agent"], form: "modelsChange", field: "password", proof: "step-up", ...ACCEPT, role: "operator", secrets: [], terms: ["scope", "digest"] },
  { id: "models-apply", action: "Apply a model preset or switch", routes: ["/settings/models/apply"], form: "modelsChange", field: "password", proof: "step-up", ...ACCEPT, role: "operator", secrets: [], terms: ["scope", "digest", "change"], note: "plus the previewed preset, or switch and to" },
  ...([
    ["policy", "Change the policy", "policy", "operator"],
    ["approval", "Change approval rules", "approval", "operator"],
    ["request-limits", "Change request limits", "requestLimits", "operator"],
    ["retention", "Change retention", "retention", "operator"],
    ["backups", "Change backups", "backups", "operator"],
    ["data", "Download everything", "data", "operator"],
  ] as const).map(([path, action, form, role]): ProofRow => ({ id: path, action, routes: [`/settings/${path}`], form, field: "password", proof: "step-up", ...ACCEPT, role, secrets: [], terms: path === "approval" ? ["repo"] : [] })),
  { id: "pull-requests", action: "Change pull-request settings, or turn them off", routes: ["/settings/pull-requests"], form: "pullRequests", field: "password", proof: "step-up", ...ACCEPT, role: "any", handlerRole: "an approver of the project", secrets: [], terms: ["repo", "act"] },
  { id: "pull-requests-on", action: "Turn pull requests on", routes: ["/settings/pull-requests"], select: { field: "act", value: "on" }, form: "pullRequests", field: "password", proof: "step-up", ...ACCEPT, role: "any", handlerRole: "an approver of the project", secrets: [], terms: ["repo", "act", "github", "base"], note: "`github` and `base` are what the page showed; the handler checks again and refuses a difference" },
  { id: "checks", action: "Change checks", routes: ["/settings/checks"], form: "checks", field: "password", proof: "step-up", ...ACCEPT, role: "any", handlerRole: "an approver of the project", secrets: [], terms: ["repo", "act"] },
  { id: "monitoring", action: "Change monitoring", routes: ["/settings/monitoring"], form: "monitoring", field: "password", proof: "step-up", ...ACCEPT, role: "operator", secrets: ["header-value"], terms: [] },
  { id: "updates", action: "Update Toolroll", routes: ["/settings/updates", "/settings/updates/seen", "/settings/updates/cancel"], form: "updates", field: "password", proof: "step-up", ...ACCEPT, role: "operator", secrets: [], terms: [] },
  { id: "storage-cleanup", action: "Choose when checkouts are removed", routes: ["/settings/storage"], form: "storage", field: "password", proof: "step-up", ...ACCEPT, role: "operator", secrets: [], terms: [] },
  { id: "storage-clean", action: "Clean up checkouts", routes: ["/settings/storage/clean"], form: "storage", field: "password", proof: "step-up", ...ACCEPT, role: "operator", secrets: [], terms: ["preview"], note: "`preview` is the digest of what the page showed; a changed list is refused" },
  { id: "storage-discard", action: "Discard a checkout", routes: ["/settings/storage/discard"], form: "storage", field: "password", proof: "step-up", ...ACCEPT, role: "operator", secrets: [], terms: ["path"] },
  { id: "project-live-view", action: "Show a project's commands in the live view", routes: ["/settings/project/live-view"], form: "projectLiveView", field: "password", proof: "step-up", ...ACCEPT, role: "any", handlerRole: "an approver of the project", secrets: [], terms: ["repo", "nonce"] },
  { id: "project-delete", action: "Delete a project", routes: ["/settings/project/delete"], form: "projectDelete", field: "password", proof: "step-up", ...ACCEPT, role: "operator", secrets: [], terms: ["repo", "step"], note: "the project's name typed too" },
  { id: "tools-connect", action: "Connect a tool", routes: ["/settings/tools/connect"], form: "toolsConnect", field: "password", proof: "step-up", ...ACCEPT, role: "approver", secrets: [], terms: ["repo", "shown"], note: "`shown` is the project the page showed (a post from another project is refused), not a digest" },
  { id: "tools-change", action: "Change a project's tools", routes: ["/settings/tools/change"], form: "toolsChange", field: "password", proof: "step-up", when: "only to add a tool (catalog, custom, import) or set a secret", ...ACCEPT, role: "approver", secrets: ["value"], terms: ["repo", "shown", "action"] },
  ...CHAT_APPS.map(([app, name, form]): ProofRow => ({ id: `${app}-close`, action: `Unpair or disconnect ${name}`, routes: [`/settings/${app}/unpair`, `/settings/${app}/disconnect`], form, field: "password", proof: "step-up", ...ACCEPT, role: "approver", secrets: [], terms: [] })),
  { id: "telegram-unpair", action: "Unpair your phone from Telegram", routes: ["/settings/telegram/unpair"], form: "telegramPair", field: "password", proof: "step-up", ...ACCEPT, role: "approver", secrets: [], terms: [] },
  { id: "people-close", action: "Cancel an invite or remove a person", routes: ["/people/invite-revoke", "/people/revoke"], form: "peopleRevoke", field: "token", proof: "step-up", ...ACCEPT, role: "any", handlerRole: "an approver", secrets: [], terms: [] },
  { id: "project-setup", action: "Approve project setup", routes: ["/control/setup-approve"], form: "projectSetup", field: "token", proof: "step-up", ...ACCEPT, role: "any", handlerRole: "an approver of the project; models for a new installation need an instance operator", secrets: [], terms: ["repo", "nonce", "fingerprint", "provider", "model", "command", "seconds"], note: "the nonce is spent before the password is checked: after a refusal, review again; the reviewed inputs are previewed again and must match the fingerprint" },
  { id: "project-instructions", action: "Add the agent instructions", routes: ["/control/instructions-approve"], form: "projectSetup", field: "token", proof: "step-up", ...ACCEPT, role: "any", handlerRole: "an approver of the project", secrets: [], terms: ["repo", "nonce", "fingerprint"], note: "the nonce is spent before the password is checked" },
  { id: "mode-sign", action: "Sign an operating mode", routes: ["/mode/sign"], form: "mode", field: "token", proof: "step-up", ...ACCEPT, role: "any", handlerRole: "an approver of the project", secrets: [], terms: MODE_TERMS },
  { id: "mode-sign-chat-approve", action: "Sign an operating mode that lets your chat app approve", routes: ["/mode/sign"], select: { field: "chat-approve", value: "1" }, form: "mode", field: "token", proof: "credential", ...CREDENTIAL, role: "any", handlerRole: "an approver of the project", secrets: [], terms: MODE_TERMS },

  // Credential acts: a password typed now or a one-use re-check; never Passwordless.
  { id: "passwordless-on", action: "Turn Passwordless on", routes: ["/settings/passwordless"], form: "passwordless", field: "password", proof: "credential", when: "only to turn it on (off needs nothing)", ...CREDENTIAL, role: "operator", secrets: [], terms: [] },
  { id: "sign-in", action: "Change sign-in (SSO)", routes: ["/settings/sign-in"], form: "signIn", field: "password", proof: "credential", when: "every action except Test", ...CREDENTIAL, role: "operator", secrets: ["client-secret"], terms: [] },
  { id: "release-approval", action: "Approve releases automatically", routes: ["/settings/release-approval"], form: "releaseApproval", field: "password", proof: "credential", when: "only to approve automatically (Ask me needs nothing)", ...CREDENTIAL, role: "approver", handlerRole: "an approver of the project", secrets: [], terms: ["repo"] },
  { id: "project-network", action: "Change what builds may reach", routes: ["/settings/project/network"], form: "projectNetwork", field: "password", proof: "credential", ...CREDENTIAL, role: "any", handlerRole: "an approver of the project", secrets: [], terms: ["repo"] },
  { id: "project-writes", action: "Change where builds may write", routes: ["/settings/project/writes"], form: "projectWrites", field: "password", proof: "credential", ...CREDENTIAL, role: "any", handlerRole: "an approver of the project", secrets: [], terms: ["repo"] },
  { id: "project-sandbox", action: "Change a project's sandbox", routes: ["/settings/project/sandbox"], form: "projectSandbox", field: "password", proof: "credential", ...CREDENTIAL, role: "any", handlerRole: "an approver of the project", secrets: [], terms: ["repo"] },
  { id: "project-check-access", action: "Narrow how far checks reach", routes: ["/settings/project/check-access"], form: "projectCheckAccess", field: "password", proof: "credential", ...CREDENTIAL, role: "any", handlerRole: "an approver of the project", secrets: [], terms: ["repo"], note: "for a form that can only narrow; one that offers a wider level uses project-check-access-widen" },
  { id: "project-check-access-widen", action: "Widen how far checks reach", routes: ["/settings/project/check-access"], explicit: true, form: "projectCheckAccess", field: "password", proof: "typed-now-operator", ...TYPED, role: "any", handlerRole: "an instance operator", secrets: [], terms: ["repo"], note: "the server decides whether a choice widens; a form offering any wider level asks for this proof" },
  ...CHAT_APPS.map(([app, name, form, secrets]): ProofRow => ({ id: `${app}-open`, action: `Connect or pair ${name}`, routes: [`/settings/${app}/connect`, `/settings/${app}/pair`], form, field: "password", proof: "credential", ...CREDENTIAL, role: "approver", secrets, terms: [] })),
  { id: "sessions-token", action: "Make an API token", routes: ["/settings/sessions"], form: "sessions", field: "password", proof: "credential", when: "only to make a token (ending sessions and revoking tokens need nothing)", ...CREDENTIAL, role: "any", secrets: [], notProof: ["token"], terms: [], note: "`token` here names an API token to revoke" },
  { id: "people-invite", action: "Invite someone", routes: ["/people/invite"], form: "peopleInvite", field: "token", proof: "credential", ...CREDENTIAL, role: "any", handlerRole: "an approver", secrets: [], terms: [] },
  { id: "people-projects", action: "Change a person's projects", routes: ["/people/projects"], form: "peopleProjects", field: "token", proof: "credential", ...CREDENTIAL, role: "operator", secrets: [], terms: ["name"] },

  // A typed password, checked by the handler itself.
  { id: "telegram-pair", action: "Pair your phone with Telegram", routes: ["/settings/telegram/pair"], form: "telegramPair", field: "password", proof: "typed-password", ...TYPED, role: "approver", secrets: [], terms: [] },
  { id: "chat-approval-save", action: "Turn on approving from chat", routes: ["/settings/chat-approval/save"], form: "chatApproval", field: "token", proof: "typed-password", ...TYPED, role: "approver", secrets: [], terms: ["nonce", "digest", "scope", "full-access", "cap-usd"] },
  { id: "push-subscribe", action: "Get alerts on this device", routes: ["/push/subscribe"], form: "pushSubscribe", field: "token", proof: "typed-password", ...TYPED, role: "any", handlerRole: "an approver", secrets: [], terms: ["endpoint", "p256dh", "auth"] },
  { id: "lead-config", action: "Set up the lead's model and its own key", routes: ["/chat/config"], form: "chatConfig", field: "token", proof: "typed-password", ...TYPED, role: "any", handlerRole: "an approver", secrets: ["key"], terms: [] },
];

const BY_ID = new Map(PROOF_INVENTORY.map(row => [row.id, row]));

/** One row by id; throws on an unknown id (a rendering bug, never a request's input). */
export function proofRow(id: string): ProofRow {
  const row = BY_ID.get(id);
  if (row === undefined) throw new Error(`no proof inventory row ${id}`);
  return row;
}

/** Whether the field a row names is one its form contract reads (used by the kit's own guard and the tests). */
export function contractReads(row: ProofRow, field: string): boolean {
  return CONSOLE_FORMS[row.form].fields.includes(field);
}
