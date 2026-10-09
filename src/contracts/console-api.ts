/**
 * The console's form bodies and JSON API (docs/plans/zod-revamp.md, item 13): one schema for every URL-encoded body a
 * console route reads, and one for each `?format=json` response.
 *
 * A form is read exactly as before. Each field is what `URLSearchParams` holds for it — every value in the order
 * sent, so `get()` is the first and `getAll()` the list — and every field may be left out, because each handler
 * already supplies its own default, trimming, clipping, number conversion and refusal after reading. Unknown fields
 * are ignored (browsers send `csrf`, buttons send their own names, and older pages send fields no longer read). What a
 * handler may read is the schema's field list: `readForm` hands it a view typed by that list, so reading a field the
 * contract doesn't name fails the typecheck instead of drifting. Nothing a person or script sent before is refused
 * now; the CSRF, nonce, digest, password and duplicate-field checks stay in the handlers, in their order.
 *
 * The JSON responses are checked as they are sent (unversioned, unknown keys allowed, their bytes unchanged — an
 * evidence pack carries sealed ledger entries); a response that disagrees is logged and sent anyway.
 *
 * Not here: Telegram's pushed updates (item 11), flow webhooks and public flow forms (item 15).
 */

import { z } from "zod";
import { parseContract, type ContractIssue } from "./contract.js";

/** One form field: every value sent for it, in order. Text only — a URL-encoded body has nothing else. */
const formField = z.array(z.string());

/** A form contract: the route it serves, the fields its handler reads, and the schema those make. */
export type FormContract<K extends string> = {
  readonly route: string;
  readonly fields: readonly string[];
  /** Field-name prefixes read with a computed suffix (`question:<id>`, `param.<id>`). */
  readonly prefixes: readonly string[];
  /** The handler reads names it computes from saved data (a template's questions); any name is typed as readable. */
  readonly dynamic: boolean;
  readonly schema: z.ZodType<Readonly<Record<string, readonly string[]>>>;
  /** Phantom: the names a handler may read. */
  readonly names?: K;
};

type Names<F extends readonly string[], P extends readonly string[], D extends boolean> = D extends true ? string : F[number] | `${P[number]}${string}`;

/** A form's contract: a loose object of optional text fields (unknown fields ignored, as the handlers always did). */
export function formContract<const F extends readonly string[], const P extends readonly string[] = readonly [], const D extends boolean = false>(
  route: string,
  fields: F,
  more: { prefixes?: P; dynamic?: D } = {},
): FormContract<Names<F, P, D>> {
  const schema = z.looseObject(Object.fromEntries(fields.map(field => [field, formField.optional()]))).catchall(formField);
  return { route, fields, prefixes: more.prefixes ?? [], dynamic: more.dynamic ?? false, schema: schema as unknown as FormContract<string>["schema"] };
}

/**
 * A body as its schema sees it: each field name once, in first-sent order, with all its values in sent order. Built
 * with `Object.fromEntries`, so a field named `__proto__` is an ordinary field.
 */
export function formFields(body: URLSearchParams): Record<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const [name, value] of body) {
    const values = fields.get(name);
    if (values === undefined) fields.set(name, [value]);
    else values.push(value);
  }
  return Object.fromEntries(fields);
}

/** What a handler reads a form through: `URLSearchParams`' own reads, limited to the names its contract declares. */
export type FormView<K extends string> = {
  get(name: K): string | null;
  getAll(name: K): string[];
  has(name: K): boolean;
  /** Every name sent, for the handlers' "one value for each field" checks. */
  keys(): ReturnType<URLSearchParams["keys"]>;
  /** The body as sent, for re-showing a form with what was typed and for helpers that take the whole form. */
  readonly sent: URLSearchParams;
};

/** Where a disagreement is reported. The default writes one line to stderr, including under Vitest. */
export type ContractReport = (what: string, issues: readonly ContractIssue[]) => void;

const toStderr: ContractReport = (what, issues) => {
  process.stderr.write(`${what}: disagrees with its contract — ${issues.map(one => one.line).join("; ")}\n`);
};

/**
 * Read a form through its contract. It never refuses: every value is text and every field optional, so a body that
 * somehow disagrees is reported and read as it was sent (the handler's own checks decide, as before).
 */
export function readForm<K extends string>(body: URLSearchParams, contract: FormContract<K>, report: ContractReport = toStderr): FormView<K> {
  const parsed = parseContract(contract.schema, formFields(body));
  if (!parsed.ok) report(`form ${contract.route}`, parsed.issues);
  return {
    get: name => body.get(name),
    getAll: name => body.getAll(name),
    has: name => body.has(name),
    keys: () => body.keys(),
    sent: body,
  };
}

// ---- every console form ------------------------------------------------------------------------------------------
//
// One per route (or per verb, where one route takes several bodies). A family whose sub-routes share one dispatch —
// `/code/*`, `/flows/*`, the subagent pages, Slack/Teams/Discord — has one contract naming every field its handlers
// read. Every body also passes through `mutationGuardForm` (the shared CSRF and duplicate check, unchanged) and
// `ledgerTargetForm` (the project a request is recorded against).

export const CONSOLE_FORMS = {
  // Before sign-in.
  signup: formContract("POST /signup", ["code", "name", "password"]),
  login: formContract("POST /login", ["name", "token", "return"]),
  join: formContract("POST /join/<invite>", ["name", "password"]),

  // Shared by every signed-in POST.
  mutationGuard: formContract("POST (every signed-in form)", ["csrf", "token", "digest", "nonce", "confirm"]),
  ledgerTarget: formContract("POST (the action ledger's project)", ["repo"]),
  projectCeiling: formContract("POST (project ceiling)", ["repo"]),

  demo: formContract("POST /chat/demo/<act>", ["message", "note"]),
  updatesDismiss: formContract("POST /settings/updates/dismiss", ["version", "quiet", "return"]),
  updatesChecks: formContract("POST /settings/updates/checks", ["check"]),
  code: formContract("POST /code, /code/start, /code/<session>/<act>", ["repo", "password", "title", "model", "prompt", "requestId", "base", "candidate", "goal", "acceptance", "visual", "decision", "answers"], { prefixes: ["question:"] }),
  skillsRevise: formContract("POST /settings/skills/revise", ["run", "repo", "feedback", "nonce"]),
  skillsChange: formContract("POST /settings/skills/import, /settings/skills/change", ["repo", "identity", "revision", "method", "content", "files", "url", "action", "sha", "sample", "nonce", "restore"]),
  kit: formContract("POST /kits/<kit>/<act>", ["repo"]),
  subagents: formContract("POST /settings/lead/subagents/new, /settings/lead/subagents/<id>/<part>, /settings/lead/subagents/questions/<id>/answer", ["choice", "text", "repo", "template", "name", "soul", "op", "id", "schedule", "tool", "state", "note", "model", "dailyTurns", "manager"], { prefixes: ["use.", "undo.", "field.", "over."] }),
  galleryUse: formContract("POST /flows/new/<template>", ["repo", "send-result", "name", "intent", "previewed"], { dynamic: true }),
  flows: formContract("POST /flows/new, /flows/example, /flows/import, /flows/<id>/<act>, /flows/<id>/cards/<card>/<act>, /flows/<id>/triggers/<trigger>/<act>", ["repo", "document", "url", "confirm", "previewed", "template", "name", "answers", "password", "secret", "trigger", "approve", "remove", "about", "body", "timeoutMinutes", "language", "file", "address", "key", "definition", "owner", "revision", "value", "title", "description", "stage", "decision", "note", "draft", "choice", "entry", "label", "watching"], { prefixes: ["param."] }),
  spendBudget: formContract("POST /spend/budget", ["password", "target", "action", "usd", "stop"]),
  projectConcurrency: formContract("POST /settings/project/concurrency", ["repo", "concurrency"]),
  projectDelete: formContract("POST /settings/project/delete", ["repo", "name", "step", "password"]),
  policy: formContract("POST /settings/policy", ["password", "provider", "models", "tools", "ceiling"]),
  approval: formContract("POST /settings/approval", ["repo", "password", "protect", "paths", "not_requester"]),
  sessions: formContract("POST /settings/sessions", ["everyone", "action", "session", "token", "name", "access", "days", "password"]),
  requestLimits: formContract("POST /settings/request-limits", ["target", "action", "read-per-minute", "act-per-minute", "per-minute", "per-day", "password"]),
  signIn: formContract("POST /settings/sign-in", ["action", "password", "issuer", "client-id", "client-secret", "label", "scopes", "groups-claim", "passwords"], { prefixes: ["group-", "role-", "projects-"] }),
  updates: formContract("POST /settings/updates, /settings/updates/seen, /settings/updates/cancel", ["password", "version", "when"]),
  retention: formContract("POST /settings/retention", ["password", "evidence", "checkouts", "chat", "notifications"]),
  storage: formContract("POST /settings/storage, /settings/storage/clean, /settings/storage/discard", ["password", "cleanup", "preview", "path"]),
  pullRequests: formContract("POST /settings/pull-requests", ["repo", "act", "password", "github", "base", "method", "when-green"]),
  checks: formContract("POST /settings/checks", ["repo", "password", "act", "on", "level", "command", "timeout"]),
  backups: formContract("POST /settings/backups", ["password", "every", "keep", "folder"]),
  data: formContract("POST /settings/data", ["password"]),
  flowsOn: formContract("POST /settings/flows/on", ["repo", "starter"]),
  integrationsTest: formContract("POST /settings/integrations/test", ["key"]),
  monitoring: formContract("POST /settings/monitoring", ["password", "webhook", "folder", "traces", "header-name", "header-value", "rotate"]),
  toolsConnect: formContract("POST /settings/tools/connect", ["repo", "also", "service", "template", "kit", "shown", "password", "access"]),
  toolsChange: formContract("POST /settings/tools/change", ["repo", "shown", "action", "name", "password", "catalog", "transport", "target", "secrets", "import", "secret", "value"]),
  appearance: formContract("POST /settings/appearance", ["accent", "quiet", "return", "theme"]),
  models: formContract("POST /settings/models/check, /settings/models/watch, /settings/models/update, /settings/models/agent", ["enabled", "tool", "phase", "agent"]),
  knowledgeRefresh: formContract("POST /settings/knowledge/refresh", ["repo"]),
  knowledgeProposal: formContract("POST /settings/knowledge/proposal", ["repo", "decision", "proposal"]),
  knowledgeDecision: formContract("POST /settings/knowledge/decision", ["repo", "action", "claim", "why", "decision", "reason"]),
  knowledgeChange: formContract("POST /settings/knowledge/change", ["repo", "action", "identity", "revision", "instructions", "title", "content", "path", "id", "restore"]),
  learningChange: formContract("POST /settings/learning/change", ["repo", "action", "identity", "revision", "lesson", "version", "sha"]),
  projectSetup: formContract("POST /control/setup-preview, /control/setup-approve, /control/instructions-preview, /control/instructions-approve", ["repo", "nonce", "fingerprint", "token", "provider", "model", "command", "seconds"]),
  slack: formContract("POST /settings/slack/<connect|pair|unpair|disconnect|alerts>", ["password", "app-token", "bot-token"]),
  chatApproval: formContract("POST /settings/chat-approval/confirm, /settings/chat-approval/save, /settings/chat-approval/off", ["scope", "full-access", "cap-usd", "nonce", "digest", "token"]),
  telegramPair: formContract("POST /settings/telegram/pair, /settings/telegram/unpair", ["password"]),
  teams: formContract("POST /settings/teams/<connect|pair|unpair|disconnect|alerts>", ["password", "app-id", "tenant", "secret"]),
  discord: formContract("POST /settings/discord/<connect|pair|unpair|disconnect|alerts>", ["password", "bot-token"]),
  messaging: formContract("POST /settings/messaging", ["primary"]),
  permissionDefault: formContract("POST /settings/permission-default", ["permission-mode"]),
  qualityDefault: formContract("POST /settings/quality-default", ["quality-mode"]),
  notifications: formContract("POST /settings/notifications", ["mode", "digest", "screenshots"]),
  notificationsMute: formContract("POST /settings/notifications/mute", ["repo", "pings"]),
  telegramDigest: formContract("POST /settings/telegram-digest", ["every"]),
  providerKey: formContract("POST /settings/provider-key, /settings/provider-key-clear", ["provider", "auth-mode", "value"]),
  telegramToken: formContract("POST /settings/telegram-token", ["token"]),
  email: formContract("POST /settings/email, /settings/email-test, /settings/email-read-test", ["host", "port", "secure", "user", "from", "password", "imapHost", "imapPort"]),
  google: formContract("POST /settings/google, /settings/google/disconnect", ["clientId", "clientSecret"]),
  projectsSelect: formContract("POST /projects/select", ["path", "return"]),
  projectsRemove: formContract("POST /projects/remove", ["repo"]),
  projectsOpen: formContract("POST /projects/open", ["path", "return"]),
  tasksAdd: formContract("POST /tasks/add", ["projectRevision", "id", "title", "repo", "goal", "not", "touches", "scout", "permission-mode", "quality-mode", "after", "acceptance", "planning-policy", "plan-first"]),
  queue: formContract("POST /queue/move, /queue/note", ["runner", "note", "from", "projectRevision", "respond", "task", "column", "before", "queueRevision"]),
  runnerRegister: formContract("POST /fleet/runner/register", ["token", "name", "capacity"]),
  mode: formContract("POST /mode/confirm, /mode/sign", ["name", "days", "auto-approve", "plan-auto", "chat-approve", "publication", "expiry", "nonce", "digest", "token", "review-auto", "review-retry-auto", "repair-auto"]),
  peopleProjects: formContract("POST /people/projects", ["token", "name", "access", "projects"]),
  peopleInvite: formContract("POST /people/invite", ["token", "role", "access", "projects"]),
  peopleInviteRevoke: formContract("POST /people/invite-revoke", ["token", "id"]),
  peopleRevoke: formContract("POST /people/revoke", ["token", "name"]),
  runnerRetire: formContract("POST /fleet/runner/retire", ["token", "name"]),
  decisionAnswer: formContract("POST /d/<id>/answer", ["return", "choice", "confirm", "note"]),
  confirmStopped: formContract("POST /t/<task>/confirm-stopped", ["run", "token", "checked", "return"]),
  merge: formContract("POST /t/<task>/merge", ["run", "token", "anyway"]),
  onboard: formContract("POST /projects/onboard-preview, /projects/onboard-confirm", ["repo", "root", "token", "nonce", "big-ok"]),
  pushSubscribe: formContract("POST /push/subscribe", ["token", "endpoint", "p256dh", "auth"]),
  pushRemove: formContract("POST /push/remove", ["id"]),
  phoneDismiss: formContract("POST /onboarding/phone/dismiss", ["quiet"]),
  leadIdentity: formContract("POST /settings/lead/identity", ["name", "persona"]),
  leadAbout: formContract("POST /settings/lead/about", ["about"]),
  leadPromiseCancel: formContract("POST /settings/lead/promise/cancel", ["promise"]),
  chatConfig: formContract("POST /chat/config", ["return", "token", "off", "forget-key", "provider", "model", "weekly-usd", "daily-turns", "key"]),
  leadMint: formContract("POST /chat/mate/mint", ["return", "ceiling-usd", "token", "follow"]),
  leadFollow: formContract("POST /chat/mate/follow", ["enabled", "return"]),
  leadEnd: formContract("POST /chat/mate/end", ["return"]),
  leadStop: formContract("POST /chat/mate/stop", ["return", "turn"]),
  leadProposal: formContract("POST /chat/proposal/<id>/confirm|dismiss", ["return", "nonce", "confirm", "token"]),
  coordinatorProposal: formContract("POST /proposals/<id>/confirm|dismiss", ["return", "confirm"]),
  chat: formContract("POST /chat", ["task", "project", "result", "mode", "request", "request-session", "message", "token"]),
  chatFile: formContract("POST /chat/file/<id>", ["token"]),
  chatAck: formContract("POST /chat/ack/<id>", ["token", "nonce"]),
  // A recipe's own answers and editor fields are read by recipes.ts from the whole form (`sent`; item 17).
  recipes: formContract("POST /recipes/prepare, /recipes/preview, /recipes/import, /recipes/launch, /recipes/save", ["repo", "projectRevision", "recipe", "recipeRevision", "document", "purpose", "source", "sourceRevision", "preview", "next"]),
  runNote: formContract("POST /r/<run>/note", ["note"]),
  diffComment: formContract("POST /r/<run>/comment", ["return", "tab", "intent", "batch", "source", "note", "path", "line", "request"]),
  editorLinks: formContract("POST /session/editor-links", ["on", "return"]),
  revise: formContract("POST /r/<run>/revise", ["return", "batch", "source"]),
  followUp: formContract("POST /r/<run>/checks|add-tests", ["return", "level"]),
  resolveIncident: formContract("POST /i/<id>/resolve", ["return"]),

  // A task's verbs (/t/<task>/<verb>), one body each.
  taskSteer: formContract("POST /t/<task>/steer", ["note"]),
  taskHold: formContract("POST /t/<task>/hold", ["reason"]),
  taskBlock: formContract("POST /t/<task>/block|unblock", ["on"]),
  taskRepairDependency: formContract("POST /t/<task>/repair-dependency", ["blocker", "operation", "replacement"]),
  taskNext: formContract("POST /t/<task>/next", ["undo"]),
  taskReopen: formContract("POST /t/<task>/reopen", ["token"]),
  taskRequeue: formContract("POST /t/<task>/requeue", ["note", "return"]),
  taskFollowUp: formContract("POST /t/<task>/follow-up", ["index"]),
  taskPlanEdit: formContract("POST /t/<task>/plan-edit", ["saw-plan", "plan-document"]),
  taskRevision: formContract("POST /t/<task>/accept-revision|reject-revision", ["revision-id", "token"]),
  taskCancel: formContract("POST /t/<task>/cancel", ["reason"]),
  taskRoute: formContract("POST /t/<task>/route", ["size", "risky", "phase", "clear-phase", "agent", "provider", "model", "sawDigest", "return"]),
  taskScope: formContract("POST /t/<task>/scope", ["sawDigest", "permission-mode", "quality-mode", "budget-usd", "budget-microusd", "requirement", "requirement-new", "goal-brief", "goal", "not", "touches", "acceptance"]),
  taskApprove: formContract("POST /t/<task>/approve", ["return", "digest", "token", "nonce"]),
  taskAcceptProof: formContract("POST /t/<task>/accept-proof", ["run", "note", "return"]),
  taskComplete: formContract("POST /t/<task>/complete", ["receipt", "run", "accept", "note", "publish", "return"]),
  taskStop: formContract("POST /t/<task>/stop", ["run", "return"]),
  taskResume: formContract("POST /t/<task>/resume|resume-arm", ["run", "token", "nonce", "return"]),
} as const;

export type ConsoleFormName = keyof typeof CONSOLE_FORMS;

/** The console POSTs whose handlers read no field (sign-out not even the shared guard): their contract is the empty form. */
export const BODILESS_POSTS = [
  "POST /settings/lead/on",
  "POST /r/<run>/draft-repair",
  "POST /ledger/checkpoint",
  "POST /settings/backups/now",
  "POST /mode/revoke",
  "POST /settings/telegram/retry",
  "POST /providers/<provider>/resume",
  "POST /logout",
  "POST /t/<task>/unhold",
  "POST /t/<task>/plan",
  "POST /t/<task>/retry-review",
] as const;

/** The field names a console form's handler may read. */
export type FormFieldOf<N extends ConsoleFormName> = (typeof CONSOLE_FORMS)[N] extends FormContract<infer K> ? K : never;

// ---- the JSON API ------------------------------------------------------------------------------------------------

const ledgerEntrySchema = z.looseObject({
  id: z.number(), at: z.string(), actor: z.string(), repo: z.string().nullable(), taskId: z.string().nullable(), runId: z.number().nullable(),
  action: z.string(), outcome: z.string(), source: z.string(), detail: z.string().nullable(),
});

/** `GET /ledger?format=json`: the chain's state, a page of entries (newest first) and the cursor for the next. */
export const ledgerPageSchema = z.looseObject({
  chain: z.looseObject({ ok: z.boolean(), entries: z.number(), through: z.number().nullable(), head: z.string(), problem: z.looseObject({ id: z.number().nullable(), what: z.string() }).nullable() }),
  entries: z.array(ledgerEntrySchema),
  nextBefore: z.number().nullable(),
});

/** `GET /t/<task>/evidence?format=json`: a task's evidence pack, as `evidence-pack.ts` builds and digests it. */
export const evidencePackSchema = z.looseObject({
  format: z.string(),
  generatedAt: z.string(),
  generatedBy: z.string(),
  task: z.looseObject({ id: z.string(), title: z.string(), state: z.string(), repo: z.string().nullable(), project: z.string().nullable(), filedAt: z.string() }),
  rules: z.looseObject({ now: z.string(), changes: z.array(z.looseObject({ id: z.number(), at: z.string(), by: z.string(), change: z.string().nullable() })) }).nullable(),
  versions: z.array(z.looseObject({ id: z.string(), title: z.string(), state: z.string(), filedAt: z.string(), scope: z.looseObject({ digest: z.string() }).nullable(), runs: z.array(z.looseObject({ id: z.number() })) })),
  result: z.looseObject({ runId: z.number() }).nullable(),
  totals: z.looseObject({ runs: z.number(), costUsd: z.number(), tokensIn: z.number(), tokensOut: z.number() }),
  ledger: z.looseObject({
    entries: z.array(ledgerEntrySchema),
    truncated: z.boolean(),
    chain: z.looseObject({ ok: z.boolean(), entries: z.number(), through: z.number().nullable(), head: z.string(), problem: z.string().nullable(), checkedAt: z.string().nullable() }),
    checkpoint: z.looseObject({ through: z.number(), hash: z.string(), at: z.string() }).nullable(),
    recipe: z.string(),
  }),
  digest: z.string(),
});

/** `GET /flows/<id>?format=json`: the flow page's view (the same one the workspace renders). */
export const flowViewSchema = z.looseObject({
  kind: z.literal("flow"),
  flow: z.looseObject({ id: z.number(), name: z.string(), project: z.string(), revision: z.number(), href: z.string(), owner: z.string() }),
  chatHref: z.string(),
  triggers: z.array(z.looseObject({})),
  triggerSetup: z.looseObject({}),
  startTrigger: z.number().nullable(),
  me: z.string(),
  sortReady: z.boolean(),
  emailReady: z.boolean(),
  requestSecrets: z.array(z.string()),
  tools: z.array(z.looseObject({ name: z.string() })),
  scripts: z.array(z.looseObject({ name: z.string() })),
  start: z.string(),
  stages: z.array(z.looseObject({ id: z.string(), kind: z.string() })),
  cards: z.array(z.looseObject({ id: z.number() })),
  selectedCard: z.number().nullable(),
  live: z.string().nullable(),
  canEdit: z.boolean(),
  approvers: z.array(z.string()),
  kinds: z.array(z.looseObject({ kind: z.string(), label: z.string() })),
  colors: z.array(z.string()),
});

export const CONSOLE_RESPONSES = {
  ledgerPage: { route: "GET /ledger?format=json", schema: ledgerPageSchema },
  evidencePack: { route: "GET /t/<task>/evidence?format=json", schema: evidencePackSchema },
  flowView: { route: "GET /flows/<id>?format=json", schema: flowViewSchema },
} as const;

export type ConsoleResponseName = keyof typeof CONSOLE_RESPONSES;

/** Check a JSON response just before it is sent; a disagreement is reported, and the payload is returned unchanged. */
export function checkResponse<T>(name: ConsoleResponseName, payload: T, report: ContractReport = toStderr): T {
  const { route, schema } = CONSOLE_RESPONSES[name];
  const parsed = parseContract(schema as z.ZodType, payload);
  if (!parsed.ok) report(route, parsed.issues);
  return payload;
}
