/**
 * THE ROUTE TABLE: every address this server answers, in one ordered list.
 *
 * Each row declares its method, its exact pattern, which callers may reach it,
 * the scope it needs, how its project is found, and what a project-limited
 * account may do there. The server matches a request against this table before
 * any handler runs; a request no row declares is refused (fail closed). The
 * scattered allowlists that used to repeat these facts by hand (the limited
 * account's read/write sets, the viewer's POST set, the selected-project
 * exceptions) are projections of this table.
 *
 * Handlers still re-prove what can change after admission: passwords, nonces,
 * webhook signatures, object membership, stale sessions and revoked tokens.
 */

/** Who presents the request. `service` is a verified external sender (a signed webhook, an OAuth return carrying its one-time state). */
export type Caller = "anonymous" | "service" | "cookie" | "bearer" | "oauth" | "coordinator" | "lead";
/** What the caller must hold: nothing, read, act (an approver or an `act` token), or a fresh password/provider check on top. */
export type RouteScope = "none" | "read" | "act" | "step-up";
/** Where the request's project comes from. */
export type ProjectResolver =
  | "none" // instance-wide or pre-sign-in
  | "session" // the session's open project, or the bearer's X-Standing-Orders-Project header
  | "form" // a `repo` field in the posted form (falls back to the session)
  | "task" // the task named in /t/:id
  | "run" // the run behind /r/:id
  | "decision" // the run behind /d/:id
  | "incident" // the run behind /i/:id
  | "routine" // the routine behind /routines/:id
  | "flow" // the flow behind /flows/:id
  | "proposal" // the saved chat proposal's project
  | "conversation" // the shared conversation's projects
  | "coding" // the saved coding session's project
  | "adapter"; // the protocol adapter resolves it (CLI, MCP, team, session)
/**
 * What a project-limited account may do here:
 * - `deny`: instance access only.
 * - `collection`: a listing within a concrete visible project.
 * - `unscoped`: allowed without a concrete project (the handler filters to the account's projects).
 * - `resource`: the named object's project must be visible, and so must the request's project.
 * - `self`: the caller's own settings or saved objects; the handler proves ownership and each project named.
 * - `proposal`: a chat proposal: the saved owner/room and project must be visible.
 * - `conversation`: a shared room's own audience admission, else instance access.
 */
export type LimitedAccess = "deny" | "collection" | "unscoped" | "resource" | "self" | "proposal" | "conversation";
export type Domain = "tasks" | "flows" | "chat" | "settings" | "people" | "remote" | "pages";
/** `edge`: answered before the console's sign-in (its own protocol proves the caller). `console`: after identify(). */
export type Stage = "edge" | "console";
export type RouteMethod = "GET" | "POST" | "GET,HEAD" | "ANY";

export interface RouteDeclaration {
  readonly id: string;
  readonly domain: Domain;
  readonly stage: Stage;
  readonly method: RouteMethod;
  /** An anchored regular expression source matched against the decoded-free pathname. */
  readonly pattern: string;
  readonly callers: readonly Caller[];
  readonly scope: RouteScope;
  readonly project: ProjectResolver;
  readonly limited: LimitedAccess;
  /** A cookie session with no open project is sent to the project opener first (console GET only). */
  readonly needsProject: boolean;
  /** A viewer (watch-only) account may POST here. */
  readonly viewer: boolean;
  /** A concrete path this row must win, for the precedence test. */
  readonly sample: string;
  /** The exact answer to a caller the row does not admit, when the route has its own protocol (else a plain 403). */
  readonly callerRefusal?: { readonly status: number; readonly type: string; readonly body: string };
}

type Options = Partial<Omit<RouteDeclaration, "id" | "domain" | "method" | "pattern" | "stage">>;
const CONSOLE: readonly Caller[] = ["cookie", "bearer"];

const exact = (path: string): string => `^${path.replace(/[.*+?^${}()|[\]\\/]/g, m => (m === "/" ? "\\/" : `\\${m}`))}$`;
const sampleOf = (pattern: string): string => {
  // Literal patterns sample themselves; others must name a sample.
  if (!/^\^[^()[\]?*+{}|]*\$$/.test(pattern.replace(/\\[./-]/g, ""))) throw new Error(`route ${pattern} needs a sample`);
  return pattern.slice(1, -1).replace(/\\(.)/g, "$1");
};

const rows: RouteDeclaration[] = [];
function row(stage: Stage, domain: Domain, id: string, method: RouteMethod, pattern: string, options: Options = {}): void {
  const console_ = stage === "console";
  rows.push({
    id, domain, stage, method, pattern,
    callers: options.callers ?? (console_ ? CONSOLE : ["anonymous"]),
    scope: options.scope ?? (console_ ? (method === "POST" ? "act" : "read") : "none"),
    project: options.project ?? (console_ ? "session" : "none"),
    limited: options.limited ?? "deny",
    needsProject: options.needsProject ?? (console_ && method === "GET"),
    viewer: options.viewer ?? false,
    sample: options.sample ?? sampleOf(pattern),
    ...(options.callerRefusal === undefined ? {} : { callerRefusal: options.callerRefusal }),
  });
}
const edge = (domain: Domain, id: string, method: RouteMethod, path: string, options: Options = {}) => row("edge", domain, id, method, path.startsWith("^") ? path : exact(path), options);
const get = (domain: Domain, id: string, path: string, options: Options = {}) => row("console", domain, id, "GET", path.startsWith("^") ? path : exact(path), options);
const post = (domain: Domain, id: string, path: string, options: Options = {}) => row("console", domain, id, "POST", path.startsWith("^") ? path : exact(path), options);

const ID = "[0-9]{1,15}";
const FLOW = "[1-9][0-9]{0,9}";
const TASK = "[^/]+";
/** Free of a project: no opener redirect for a session with nothing open. */
const free = { needsProject: false } as const;

// ---- edge: answered before the console's sign-in ---------------------------------------------------------------
// Ordered exactly as the server checks them: health and webhooks before the Host check, the rest after it.
edge("pages", "edge.healthz", "GET,HEAD", "/healthz");
edge("remote", "edge.telegram-hook", "ANY", "/hooks/telegram", { callers: ["service"] });
edge("remote", "edge.flow-form", "ANY", "^\\/hooks\\/form\\/.*$", { callers: ["anonymous"], project: "flow", sample: "/hooks/form/abc" });
edge("remote", "edge.flow-hook", "ANY", "^\\/hooks\\/.*$", { callers: ["service"], project: "flow", sample: "/hooks/flow/abc" });
edge("remote", "edge.mcp", "ANY", "/mcp", { callers: ["bearer", "oauth", "coordinator"], scope: "read", project: "adapter" });
edge("remote", "edge.oauth-discovery", "ANY", "^\\/\\.well-known\\/(oauth-protected-resource(\\/mcp)?|oauth-authorization-server)$", { sample: "/.well-known/oauth-authorization-server" });
edge("remote", "edge.oauth", "ANY", "^\\/oauth\\/.*$", { sample: "/oauth/authorize" });
edge("settings", "edge.google-callback", "GET", "/settings/google/callback", { callers: ["service"] });
edge("settings", "edge.connect-callback", "GET", "/settings/tools/connected", { callers: ["service"] });
edge("remote", "edge.sessions", "ANY", "^\\/api\\/sessions(\\/.*)?$", { callers: ["cookie", "bearer"], scope: "act", project: "adapter", sample: "/api/sessions/send" });
edge("remote", "edge.team", "ANY", "^\\/api\\/team(\\/events)?$", { callers: ["cookie", "bearer", "lead"], scope: "read", project: "adapter", sample: "/api/team/events" });
edge("remote", "edge.cli", "ANY", "/api/cli", { callers: ["bearer"], scope: "read", project: "adapter" });
edge("remote", "edge.teams", "ANY", "/teams/messages", { callers: ["service"] });
edge("pages", "edge.browser-asset", "ANY", "^\\/assets\\/(workspace\\.js|workspace\\.css|THIRD_PARTY_NOTICES\\.txt)$", { sample: "/assets/workspace.js" });
edge("pages", "edge.workspace-style", "GET,HEAD", "^\\/assets\\/workspace-[0-9a-f]{64}\\.css$", { sample: `/assets/workspace-${"0".repeat(64)}.css` });
edge("pages", "edge.install-asset", "GET", "^\\/(manifest\\.webmanifest|favicon\\.ico|icon\\.svg|icon-192\\.png|icon-512\\.png|apple-touch-icon\\.png|sw\\.js)$", { sample: "/sw.js" });
edge("pages", "edge.font", "GET", "^\\/fonts\\/geist-(sans|mono)-(400|500|600)\\.woff2$", { sample: "/fonts/geist-sans-400.woff2" });
edge("pages", "edge.desktop-health", "GET", "/desktop/health");
edge("people", "edge.login-page", "GET", "/login");
edge("people", "edge.login-link", "GET", "^\\/login\\/once\\/.*$", { sample: "/login/once/abc" });
edge("people", "edge.sso-start", "GET", "/login/sso");
edge("people", "edge.sso-callback", "GET", "/login/sso/callback", { callers: ["service"] });
edge("people", "edge.sso-finish", "GET", "/login/sso/finish");
edge("people", "edge.signup", "POST", "/signup");
edge("people", "edge.login", "POST", "/login");
edge("people", "edge.logout", "POST", "/logout", { callers: ["anonymous", "cookie"] });
edge("people", "edge.join", "ANY", "^\\/join\\/[A-Za-z0-9_-]{16,64}$", { sample: "/join/abcdefghijklmnop" });

// ---- console reads ---------------------------------------------------------------------------------------------
// Coding: the handler answers any other caller in its own format (JSON for the workspace's fetches).
get("tasks", "code.page", "^\\/code(\\/.*)?$", { project: "coding", limited: "self", ...free, sample: "/code" });
get("pages", "projects.browse", "/projects/browse", free);
get("pages", "projects.github", "/projects/github", free);
get("pages", "projects.page", "/projects", { limited: "unscoped", ...free });
get("pages", "home", "/", { limited: "collection", ...free });
get("tasks", "inbox", "/inbox", { limited: "collection", ...free });
get("tasks", "work", "/work", { limited: "collection", ...free });
get("tasks", "next", "/next", { limited: "collection" });
get("pages", "morning", "/morning");
get("pages", "workbench", "/workbench", free);
get("tasks", "board", "/board", { limited: "collection" });
get("tasks", "review", "/review", { limited: "collection" });
get("settings", "spend", "/spend", free);
get("pages", "ledger", "/ledger", { limited: "unscoped", ...free });
get("pages", "activity", "/activity");
get("tasks", "done", "/done", { limited: "collection" });
get("settings", "mode", "/mode");
get("people", "people.page", "/people", { limited: "unscoped", ...free });
get("pages", "system", "/system");
get("tasks", "tasks", "/tasks", { limited: "collection" });
get("tasks", "queue", "/queue");
get("pages", "peek", "/peek");
get("pages", "fleet", "/fleet", free);
get("tasks", "tasks.new", "/tasks/new", { limited: "collection", ...free });
get("tasks", "task.live", `^\\/t\\/${TASK}\\/live$`, { project: "task", limited: "resource", ...free, sample: "/t/one/live" });
get("tasks", "task.page", `^\\/t\\/${TASK}$`, { project: "task", limited: "resource", ...free, sample: "/t/one" });
get("tasks", "task.evidence", `^\\/t\\/${TASK}\\/evidence$`, { project: "task", limited: "resource", ...free, sample: "/t/one/evidence" });
get("pages", "ledger.export", "/ledger/export", { limited: "unscoped", ...free });
get("tasks", "runs", "/runs", { limited: "collection" });
get("pages", "menu", "/menu", { limited: "collection", ...free });
get("tasks", "run.page", `^\\/r\\/${ID}$`, { project: "run", limited: "resource", ...free, sample: "/r/1" });
get("tasks", "run.evidence", `^\\/r\\/${ID}\\/evidence\\/${ID}$`, { project: "run", limited: "resource", ...free, sample: "/r/1/evidence/2" });
get("tasks", "contest.page", `^\\/contest\\/${ID}$`, { ...free, sample: "/contest/1" });
get("pages", "caps", "/caps");
get("flows", "flows.new", "/flows/new", { limited: "resource", ...free });
get("flows", "flows.gallery", "^\\/flows\\/new\\/[a-z-]{1,40}$", { limited: "resource", ...free, sample: "/flows/new/triage" });
get("flows", "flows.page", "/flows", { limited: "resource", ...free });
get("flows", "kits", "/kits");
get("flows", "kit.page", "^\\/kits\\/[a-z-]{1,40}$", { sample: "/kits/support" });
get("flows", "teammates", "/teammates", free);
get("flows", "teammate.page", `^\\/teammates\\/[1-9][0-9]{0,9}(\\/soul\\.md)?$`, { ...free, sample: "/teammates/1/soul.md" });
get("flows", "flow.read", `^\\/flows\\/${FLOW}\\/(insights|runs\\/${FLOW}\\/${FLOW})$`, { project: "flow", limited: "resource", ...free, sample: "/flows/1/runs/2/3" });
get("flows", "flow.export", `^\\/flows\\/${FLOW}\\/export$`, { project: "flow", limited: "resource", ...free, sample: "/flows/1/export" });
get("flows", "flow.live", `^\\/flows\\/${FLOW}\\/live$`, { callers: ["cookie"], project: "flow", limited: "resource", ...free, sample: "/flows/1/live",
  callerRefusal: { status: 403, type: "application/json", body: JSON.stringify({ error: "session" }) } });
get("flows", "flow.page", `^\\/flows\\/${FLOW}$`, { project: "flow", limited: "resource", ...free, sample: "/flows/1" });
get("flows", "recipes", "/recipes", { limited: "collection", ...free });
for (const one of ["run", "start", "new", "edit", "from-task", "preview", "export"]) get("flows", `recipes.${one}`, `/recipes/${one}`, { limited: "collection" });
// Any other recipe screen answers the recipe area's own refusal.
get("flows", "recipes.other", "^\\/recipes\\/.*$", { sample: "/recipes/unknown" });
get("tasks", "routines", "/routines", { limited: "collection" });
get("chat", "chat.stream", "/chat/stream", free);
get("chat", "chat.mate-status", "/chat/mate/status", free);
get("chat", "chat.demo-live", "/chat/demo/live", free);
get("chat", "chat.page", "/chat", { project: "conversation", limited: "conversation", ...free });
get("chat", "chat.ack", `^\\/chat\\/ack\\/${ID}$`, { sample: "/chat/ack/1" });
get("tasks", "routine.page", `^\\/routines\\/${ID}$`, { project: "routine", limited: "resource", sample: "/routines/1" });
get("settings", "control", "/control");
get("settings", "control.connection", "/control/connection");
get("chat", "chat.action", `^\\/chat\\/action\\/${ID}$`, { project: "proposal", limited: "proposal", ...free, sample: "/chat/action/1" });
for (const one of ["models", "tools", "project", "approval", "policy", "sessions", "integrations", "monitoring", "updates", "retention", "storage", "pull-requests", "checks", "backups", "data", "sign-in", "lead", "teams", "discord", "slack", "slack/manifest"]) {
  get("settings", `settings.${one}`, `/settings/${one}`, free);
}
get("settings", "settings.skills", "/settings/skills", { limited: "unscoped", ...free });
get("settings", "settings.flows", "/settings/flows", { limited: "collection", ...free });
get("settings", "settings.knowledge", "/settings/knowledge", { limited: "unscoped", ...free });
get("settings", "settings.learning", "/settings/learning", { limited: "unscoped", ...free });
get("settings", "settings.telegram", "/settings/telegram", { limited: "self", ...free });
get("settings", "settings.page", "/settings", { limited: "unscoped", ...free });
get("pages", "health", "/health", free);
get("pages", "metrics", "/metrics", free);
get("chat", "push.key", "/push/key");
get("tasks", "decision.page", `^\\/d\\/${ID}$`, { project: "decision", limited: "resource", ...free, sample: "/d/1" });
get("chat", "lead.status", "/lead/status", free);
get("chat", "chat.task-status", "/chat/task-status", free);
get("tasks", "decision.evidence", `^\\/d\\/${ID}\\/evidence\\/${ID}$`, { project: "decision", limited: "resource", ...free, sample: "/d/1/evidence/2" });

// ---- console actions -------------------------------------------------------------------------------------------
// The attended beat guards itself (cookie, form type, Sec-Fetch-Site) before the shared mutation guard.
post("tasks", "session.attended-beats", "/session/attended-beats", { callers: ["cookie"], callerRefusal: { status: 403, type: "text/plain; charset=utf-8", body: "watching is a browser session's act" } });
// The scripted demo: the handler answers a non-browser caller "no page here".
post("chat", "chat.demo", "^\\/chat\\/demo\\/(ask|[0-9]{1,9}\\/(approve|change|revise|complete))$", { sample: "/chat/demo/ask" });
post("settings", "provider.resume", "^\\/providers\\/[a-z]+\\/resume$", { sample: "/providers/codex/resume" });
post("settings", "settings.updates-dismiss", "/settings/updates/dismiss");
post("settings", "settings.updates-checks", "/settings/updates/checks");
post("tasks", "code.act", "^\\/code(\\/.*)?$", { project: "coding", limited: "self", sample: "/code/start" });
post("settings", "settings.skills-revise", "/settings/skills/revise", { project: "form", limited: "unscoped" });
post("settings", "settings.skills-import", "/settings/skills/import", { project: "form", limited: "unscoped" });
post("settings", "settings.skills-change", "/settings/skills/change", { project: "form", limited: "unscoped" });
post("flows", "kit.act", "^\\/kits\\/[a-z-]{1,40}\\/(setup|sample|github)$", { project: "form", sample: "/kits/support/setup" });
post("flows", "teammate.new", "/teammates/new", { project: "form" });
post("flows", "teammate.act", "^\\/teammates\\/[1-9][0-9]{0,9}\\/(soul|state|note|settings|summary|tools|memory|routines|week)$", { sample: "/teammates/1/soul" });
post("flows", "teammate.answer", "^\\/teammates\\/questions\\/[1-9][0-9]{0,9}\\/answer$", { sample: "/teammates/questions/1/answer" });
post("flows", "flows.gallery-create", "^\\/flows\\/new\\/[a-z-]{1,40}$", { project: "form", limited: "resource", sample: "/flows/new/triage" });
post("flows", "flows.create", "/flows/new", { project: "form", limited: "resource" });
post("flows", "flows.example", "/flows/example", { project: "form" });
post("flows", "flows.import", "/flows/import", { project: "form", limited: "resource" });
post("flows", "flow.act", `^\\/flows\\/${FLOW}\\/(save|cards|archive|scripts)$`, { project: "flow", limited: "resource", sample: "/flows/1/save" });
post("flows", "flow.instance-act", `^\\/flows\\/${FLOW}\\/(linear-key|hooks-address|secrets)$`, { project: "flow", sample: "/flows/1/secrets" });
post("flows", "flow.triggers", `^\\/flows\\/${FLOW}\\/triggers$`, { project: "flow", limited: "resource", sample: "/flows/1/triggers" });
post("flows", "flow.card", `^\\/flows\\/${FLOW}\\/cards\\/${FLOW}\\/(move|decide|cancel|comment|assign|watch)$`, { project: "flow", limited: "resource", sample: "/flows/1/cards/2/move" });
post("flows", "flow.card-choose", `^\\/flows\\/${FLOW}\\/cards\\/${FLOW}\\/choose$`, { project: "flow", sample: "/flows/1/cards/2/choose" });
post("flows", "flow.trigger", `^\\/flows\\/${FLOW}\\/triggers\\/${FLOW}\\/(pause|resume|remove|check|press|renew|secret|share|unshare)$`, { project: "flow", limited: "resource", sample: "/flows/1/triggers/2/pause" });
post("settings", "spend.budget", "/spend/budget");
post("settings", "settings.project-concurrency", "/settings/project/concurrency");
post("settings", "settings.project-delete", "/settings/project/delete", { scope: "step-up" });
post("pages", "ledger.checkpoint", "/ledger/checkpoint");
for (const one of ["policy", "approval", "request-limits", "sessions", "sign-in", "updates", "updates/seen", "updates/cancel", "retention", "storage", "storage/clean", "storage/discard", "pull-requests", "checks", "backups/now", "backups", "data", "integrations/test", "monitoring", "tools/connect", "tools/change", "appearance"]) {
  post("settings", `settings.${one.replaceAll("/", "-")}-send`, `/settings/${one}`);
}
post("settings", "settings.flows-on", "/settings/flows/on", { limited: "collection" });
// Any other models action answers the models area's own refusal.
post("settings", "settings.models-act", "^\\/settings\\/models\\/.*$", { sample: "/settings/models/check" });
post("settings", "settings.knowledge-refresh", "/settings/knowledge/refresh", { project: "form", limited: "unscoped" });
post("settings", "settings.knowledge-proposal", "/settings/knowledge/proposal", { project: "form" });
post("settings", "settings.knowledge-decision", "/settings/knowledge/decision", { project: "form" });
post("settings", "settings.knowledge-change", "/settings/knowledge/change", { project: "form", limited: "unscoped" });
post("settings", "settings.learning-change", "/settings/learning/change", { project: "form", limited: "unscoped" });
for (const one of ["setup-preview", "setup-approve", "instructions-preview", "instructions-approve"]) post("settings", `control.${one}`, `/control/${one}`);
for (const service of ["slack", "teams", "discord"]) post("settings", `settings.${service}-send`, `^\\/settings\\/${service}\\/(connect|pair|unpair|disconnect|alerts)$`, { sample: `/settings/${service}/pair` });
post("settings", "settings.telegram-retry", "/settings/telegram/retry", { limited: "self", scope: "step-up" });
for (const one of ["confirm", "save", "off"]) post("settings", `settings.chat-approval-${one}`, `/settings/chat-approval/${one}`, { limited: "self" });
post("settings", "settings.telegram-pair", "/settings/telegram/pair", { limited: "self", scope: "step-up" });
post("settings", "settings.telegram-unpair", "/settings/telegram/unpair", { limited: "self", scope: "step-up" });
for (const one of ["messaging", "permission-default", "quality-default", "notifications", "notifications/mute", "telegram-digest", "provider-key", "provider-key-clear", "telegram-token", "email", "email-test", "email-read-test", "google", "google/disconnect"]) {
  post("settings", `settings.${one.replaceAll("/", "-")}-send`, `/settings/${one}`);
}
post("pages", "projects.select", "/projects/select", { project: "form", limited: "unscoped", viewer: true });
post("pages", "projects.remove", "/projects/remove", { project: "form" });
post("pages", "projects.open", "/projects/open", { project: "form" });
post("tasks", "tasks.add", "/tasks/add", { project: "form", limited: "collection" });
post("tasks", "queue.move", "/queue/move");
post("tasks", "queue.note", "/queue/note");
post("pages", "fleet.register", "/fleet/runner/register");
post("settings", "mode.confirm", "/mode/confirm", { scope: "step-up" });
post("settings", "mode.sign", "/mode/sign", { scope: "step-up" });
post("settings", "mode.revoke", "/mode/revoke");
post("people", "people.projects", "/people/projects");
post("people", "people.invite", "/people/invite");
post("people", "people.invite-revoke", "/people/invite-revoke");
post("people", "people.revoke", "/people/revoke");
post("pages", "fleet.retire", "/fleet/runner/retire");
post("tasks", "decision.answer", `^\\/d\\/${ID}\\/answer$`, { project: "decision", limited: "resource", scope: "step-up", sample: "/d/1/answer" });
post("tasks", "contest.act", `^\\/contest\\/${ID}\\/(arm|pick|abandon)$`, { sample: "/contest/1/pick" });
post("tasks", "task.attend", `^\\/t\\/${TASK}\\/(attend-preview|attend|attend-revoke)$`, { project: "task", sample: "/t/one/attend" });
post("tasks", "task.act", `^\\/t\\/${TASK}\\/(hold|unhold|requeue|cancel|scope|approve|plan|plan-edit|next|reopen|steer|accept-proof|accept-revision|reject-revision|route|retry-review|complete|merge|confirm-stopped|stop|resume-arm|resume)$`, { project: "task", limited: "resource", sample: "/t/one/approve" });
post("tasks", "task.instance-act", `^\\/t\\/${TASK}\\/(block|unblock|repair-dependency|follow-up)$`, { project: "task", sample: "/t/one/block" });
post("pages", "projects.onboard-preview", "/projects/onboard-preview", { project: "form" });
post("pages", "projects.onboard-confirm", "/projects/onboard-confirm", { project: "form" });
post("chat", "push.subscribe", "/push/subscribe");
post("chat", "push.remove", "/push/remove");
post("chat", "onboarding.phone-dismiss", "/onboarding/phone/dismiss");
for (const one of ["identity", "about", "promise/cancel", "on"]) post("settings", `settings.lead-${one.replaceAll("/", "-")}`, `/settings/lead/${one}`);
post("chat", "chat.config", "/chat/config");
for (const one of ["mint", "follow", "end", "stop"]) post("chat", `chat.mate-${one}`, `/chat/mate/${one}`);
post("chat", "chat.proposal", `^\\/chat\\/proposal\\/${ID}\\/(confirm|dismiss)$`, { project: "proposal", limited: "proposal", sample: "/chat/proposal/1/confirm" });
post("chat", "coordinator.proposal", `^\\/proposals\\/${ID}\\/(confirm|dismiss)$`, { sample: "/proposals/1/confirm" });
post("chat", "chat.send", "/chat", { project: "conversation" });
post("chat", "chat.file", "^\\/chat\\/file\\/[0-9a-f]{32}$", { sample: `/chat/file/${"a".repeat(32)}` });
post("chat", "chat.ack-send", `^\\/chat\\/ack\\/${ID}$`, { sample: "/chat/ack/1" });
for (const one of ["prepare", "preview", "import", "save"]) post("flows", `recipes.${one}-send`, `/recipes/${one}`, { limited: "collection" });
post("flows", "recipes.launch-send", "/recipes/launch", { limited: "collection" });
post("tasks", "routines.add", "/routines/add", { project: "form", limited: "collection" });
post("tasks", "routine.act", `^\\/routines\\/${ID}\\/(approve|refresh|pause|resume|run-now)$`, { project: "routine", limited: "resource", sample: "/routines/1/pause" });
post("tasks", "run.act", `^\\/r\\/${ID}\\/(note|comment|revise|draft-repair|checks|add-tests)$`, { project: "run", limited: "resource", sample: "/r/1/note" });
post("tasks", "session.editor-links", "/session/editor-links", { viewer: true });
post("tasks", "run.turn", `^\\/r\\/${ID}\\/turn$`, { project: "run", sample: "/r/1/turn" });
post("tasks", "incident.resolve", `^\\/i\\/${ID}\\/resolve$`, { project: "incident", sample: "/i/1/resolve" });

/** The sole route table, in match order. */
export const ROUTES: readonly RouteDeclaration[] = Object.freeze(rows.map(one => Object.freeze(one)));

const compiled = ROUTES.map(route => ({ route, test: new RegExp(route.pattern) }));

const methodMatches = (declared: RouteMethod, method: string): boolean =>
  declared === "ANY" || declared === method || (declared === "GET,HEAD" && (method === "GET" || method === "HEAD"));

/** The first row that declares this method and path, or null: an undeclared request never reaches a handler. */
export function matchRoute(method: string, pathname: string, stage?: Stage): RouteDeclaration | null {
  for (const { route, test } of compiled) {
    if (stage !== undefined && route.stage !== stage) continue;
    if (methodMatches(route.method, method) && test.test(pathname)) return route;
  }
  return null;
}

/** True when some row declares this path for another method (a wrong-method request). */
export function declaredForAnotherMethod(method: string, pathname: string, stage?: Stage): boolean {
  return compiled.some(({ route, test }) => (stage === undefined || route.stage === stage) && !methodMatches(route.method, method) && test.test(pathname));
}

/** Refuses a malformed table at startup: duplicate ids, duplicate method+pattern rows, or a row shadowed by an earlier one for its own sample. */
export function assertRouteTable(routes: readonly RouteDeclaration[] = ROUTES): void {
  const ids = new Set<string>(), keys = new Set<string>();
  for (const route of routes) {
    if (ids.has(route.id)) throw new Error(`route table: duplicate id ${route.id}`);
    ids.add(route.id);
    const key = `${route.stage} ${route.method} ${route.pattern}`;
    if (keys.has(key)) throw new Error(`route table: duplicate route ${key}`);
    keys.add(key);
    if (route.callers.length === 0) throw new Error(`route table: ${route.id} admits no caller`);
    const test = new RegExp(route.pattern);
    if (!test.test(route.sample)) throw new Error(`route table: ${route.id} does not match its sample ${route.sample}`);
    const method = route.method === "GET,HEAD" || route.method === "ANY" ? "GET" : route.method;
    const winner = routes.find(one => one.stage === route.stage && methodMatches(one.method, method) && new RegExp(one.pattern).test(route.sample));
    if (winner !== route) throw new Error(`route table: ${route.id} is shadowed by ${winner?.id} for ${route.sample}`);
  }
}
assertRouteTable();

/** The effective policy of every row, as plain data — what the snapshot test compares. */
export const routePolicySnapshot = (): Array<Omit<RouteDeclaration, "sample">> =>
  ROUTES.map(({ sample: _sample, ...rest }) => ({ ...rest }));
