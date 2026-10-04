/**
 * Settings → Integrations and `toolroll integrations`: one place that says
 * which integrations work. Each is Connected, Not set up or Broken, with its
 * last success and last error, what uses it, and one action (Set up, Send
 * test or Fix).
 *
 * Two halves. `integrationsNow` is cheap and synchronous: configuration files,
 * delivery history already in SQLite, and the last check's answer from
 * `integration_check`. It never touches the network, so a page can call it on
 * every render. `checkIntegrations` runs the checks themselves: a harmless
 * read-only call per integration (never a message to anyone, never a write to
 * a repository) with a short timeout, and records each answer. The console
 * runs them in the background through `createIntegrationMonitor`; the CLI
 * runs them inline. Only account and workspace names leave this module:
 * tokens, keys and passwords are never in a row, and every problem text is
 * scrubbed before it is stored.
 */
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { Store } from "./store.js";
import type { Runner } from "./backend.js";
import type { ConnectionChecker, ProviderConnection } from "./provider-connection.js";
import { ALL_CREDENTIAL_ENV, type ProviderId } from "./provider.js";
import { providerName, signInCommand } from "./provider-auth.js";
import { loadBotToken } from "./telegram.js";
import { loadSlackCredentials } from "./slack-api.js";
import { loadDiscordCredentials } from "./discord-api.js";
import { loadTeamsCredentials, teamsAccessToken } from "./teams-api.js";
import { effectivePrimary } from "./webhooks.js";
import { readEmailSettings } from "./email-settings.js";
import { googleConnected } from "./google-mail.js";
import { LINEAR_URL, readHooksBase, readLinearKey } from "./flow-triggers.js";
import { projectToolsOf, readToolSecrets, missingSecrets, testToolOf } from "./project-tools.js";
import { origin, readMonitoring } from "./monitoring-settings.js";
import { targetOf } from "./monitoring.js";


export type IntegrationState = "connected" | "not-set-up" | "broken";
export type IntegrationGroup = "chat" | "code" | "mail" | "tools" | "monitoring" | "agents";
/** Where a person goes (or what they run) to set something up or fix it. */
export type IntegrationPlace = { href: string | null; command: string | null };
export type IntegrationAction =
  | ({ kind: "setup"; label: "Set up" } & IntegrationPlace)
  | { kind: "test"; label: "Send test" }
  | ({ kind: "fix"; label: "Fix"; words: string } & IntegrationPlace);

export type Integration = {
  key: string;
  group: IntegrationGroup;
  name: string;
  state: IntegrationState;
  /** The account or workspace name, never a credential. */
  account: string | null;
  /** One short fact, such as which projects can be pushed to. */
  detail: string | null;
  /** Whether a check has answered for this integration yet (always true for those with nothing to check). */
  checked: boolean;
  checkedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  usedBy: string[];
  action: IntegrationAction;
  /** A project's own MCP tool: it shows a letter, never a logo matched by name. */
  custom?: true;
};

export const STATE_WORDS: Record<IntegrationState, string> = { connected: "Connected", "not-set-up": "Not set up", broken: "Broken" };

export type ProbeResult =
  | { outcome: "ok"; account?: string | null; detail?: string | null }
  | { outcome: "failed"; problem: string; account?: string | null; detail?: string | null; fix?: Partial<IntegrationPlace> }
  | { outcome: "absent"; problem: string; setup?: Partial<IntegrationPlace> };

export type IntegrationIo = {
  store: Store;
  /** The folder beside the database where credential files live; null when there is none. */
  dir: string | null;
  telegramTokenFile: string | null;
  env: Record<string, string | undefined>;
  /** The projects whose MCP tools and GitHub push rights are listed. */
  repos: readonly string[];
  fetch?: typeof fetch;
  /** How `gh` runs (tests replace it). */
  gh?: Runner;
  /** The same sign-in check Settings → AI providers makes. */
  checkConnection?: ConnectionChecker;
  /** Where project tool secrets live. */
  toolHome?: string;
  /** Whether a mail server answers at host:port (tests replace it). */
  reach?: (host: string, port: number, secure: boolean) => Promise<void>;
  clock?: () => Date;
};

type Activity = { okAt: string | null; error: string | null; errorAt: string | null; failing: boolean };
const NO_ACTIVITY: Activity = { okAt: null, error: null, errorAt: null, failing: false };

type Target = {
  key: string;
  group: IntegrationGroup;
  name: string;
  configured: boolean;
  account: string | null;
  setup: IntegrationPlace;
  fix: IntegrationPlace;
  usedBy: string[];
  activity: Activity;
  probe: ((io: IntegrationIo) => Promise<ProbeResult>) | null;
  custom?: true;
};

const PROBE_MS = 8_000;
const AGENTS: readonly ProviderId[] = ["claude", "codex"];

// ---------------------------------------------------------------- secrets

/** Token shapes that must never reach a page, a log line or --json, whatever an upstream error message says. */
const SECRET_SHAPES: readonly RegExp[] = [
  /\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g,               // Telegram bot token
  /\bx(?:ox[abposr]|app)-[A-Za-z0-9-]{8,}\b/g,     // Slack tokens
  /\blin_(?:api|oauth)_[A-Za-z0-9]{12,}\b/g,        // Linear keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,               // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,                    // provider API keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, // Discord bot token, JWTs
  /\/\/[^/\s:@]+:[^/\s@]+@/g,                      // user:password@ in an address
];

/** Remove every known secret value and anything shaped like a token; keep it to one short line. */
export function scrubIntegrationText(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret !== null && secret !== undefined && secret.length >= 6) out = out.split(secret).join("[hidden]");
  for (const shape of SECRET_SHAPES) out = out.replace(shape, match => (match.startsWith("//") ? "//[hidden]@" : "[hidden]"));
  out = out.replace(/[\p{Cc}\s]+/gu, " ").trim();
  return out.length > 240 ? `${out.slice(0, 239).trimEnd()}…` : out;
}

// ---------------------------------------------------------------- history

type CheckRow = { key: string; outcome: "ok" | "failed" | "absent"; account: string | null; detail: string | null; problem: string | null; checkedAt: string; okAt: string | null; error: string | null; errorAt: string | null };

const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

export function readIntegrationChecks(store: Store): Map<string, CheckRow> {
  if (!tableExists(store, "integration_check")) return new Map();
  const rows = store.handle.prepare("SELECT * FROM integration_check").all();
  return new Map(rows.map(row => [String(row["key"]), {
    key: String(row["key"]), outcome: String(row["outcome"]) as CheckRow["outcome"], account: str(row["account"]), detail: str(row["detail"]), problem: str(row["problem"]),
    checkedAt: String(row["checked_at"]), okAt: str(row["ok_at"]), error: str(row["error"]), errorAt: str(row["error_at"]),
  }]));
}

export function recordIntegrationCheck(store: Store, key: string, result: ProbeResult, now: Date): void {
  const at = now.toISOString();
  const account = result.outcome === "absent" ? null : result.account ?? null;
  const detail = result.outcome === "absent" ? null : result.detail ?? null;
  const problem = result.outcome === "ok" ? null : scrubIntegrationText(result.problem);
  store.handle.prepare(`INSERT INTO integration_check (key, outcome, account, detail, problem, checked_at, ok_at, error, error_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET outcome = excluded.outcome, account = excluded.account, detail = excluded.detail, problem = excluded.problem,
      checked_at = excluded.checked_at, ok_at = COALESCE(excluded.ok_at, integration_check.ok_at),
      error = COALESCE(excluded.error, integration_check.error), error_at = COALESCE(excluded.error_at, integration_check.error_at)`)
    .run(key, result.outcome, account, detail, problem, at, result.outcome === "ok" ? at : null, result.outcome === "failed" ? problem : null, result.outcome === "failed" ? at : null);
}

const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

function tableExists(store: Store, table: string): boolean {
  return store.handle.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function telegramActivity(store: Store): Activity {
  const ok = store.handle.prepare("SELECT MAX(delivered_at) AS at FROM notification_delivery WHERE destination LIKE 'telegram:%' AND delivered_at IS NOT NULL").get();
  const bad = store.handle.prepare("SELECT last_error, last_attempt_at FROM notification_delivery WHERE destination LIKE 'telegram:%' AND last_error IS NOT NULL AND delivered_at IS NULL ORDER BY last_attempt_at DESC LIMIT 1").get();
  const okAt = str(ok?.["at"]), errorAt = str(bad?.["last_attempt_at"]);
  return { okAt, error: str(bad?.["last_error"]), errorAt, failing: errorAt !== null && (okAt === null || errorAt > okAt) };
}

function chatActivity(store: Store, channel: "slack" | "discord" | "teams", installation: string): Activity {
  const runtime = `${channel}_runtime`, part = `${channel}_part`, event = `${channel}_event`;
  if (!tableExists(store, runtime)) return NO_ACTIVITY;
  const row = store.handle.prepare(`SELECT connected, problem, retry_at FROM ${runtime} WHERE installation = ?`).get(installation);
  const sent = store.handle.prepare(`SELECT MAX(p.created) AS at FROM ${part} p JOIN ${event} e ON e.id = p.event WHERE e.installation = ? AND p.state = 'sent'`).get(installation);
  const dropped = store.handle.prepare(`SELECT p.problem, p.created FROM ${part} p JOIN ${event} e ON e.id = p.event WHERE e.installation = ? AND p.state = 'dropped' AND p.problem IS NOT NULL ORDER BY p.id DESC LIMIT 1`).get(installation);
  const okAt = later(str(row?.["connected"]), str(sent?.["at"]));
  const runtimeProblem = str(row?.["problem"]);
  const error = runtimeProblem ?? str(dropped?.["problem"]);
  const errorAt = runtimeProblem !== null ? str(row?.["retry_at"]) ?? okAt : str(dropped?.["created"]);
  return { okAt, error, errorAt, failing: runtimeProblem !== null };
}

type TriggerUse = { kind: string; app: string | null; flow: string; delivery: string | null; lastAt: string | null; lastOutcome: string | null; failures: number };

function triggerUses(store: Store): TriggerUse[] {
  return store.handle.prepare(`SELECT t.kind, t.config_json, t.last_at, t.last_outcome, t.failures, f.name FROM flow_trigger t JOIN flow f ON f.id = t.flow
    WHERE t.state = 'active' AND f.state = 'active' ORDER BY t.id`).all().map(row => {
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(String(row["config_json"])) as Record<string, unknown>; } catch { config = {}; }
    return { kind: String(row["kind"]), app: typeof config["app"] === "string" ? config["app"] : null, flow: String(row["name"]), delivery: typeof config["delivery"] === "string" ? config["delivery"] : null,
      lastAt: str(row["last_at"]), lastOutcome: str(row["last_outcome"]), failures: Number(row["failures"] ?? 0) };
  });
}

function triggerActivity(uses: readonly TriggerUse[]): Activity {
  let activity: Activity = NO_ACTIVITY;
  for (const one of uses) {
    if (one.lastAt === null) continue;
    if (one.failures > 0) {
      if (activity.errorAt === null || one.lastAt > activity.errorAt) activity = { ...activity, error: one.lastOutcome ?? "The last check failed", errorAt: one.lastAt, failing: true };
    } else {
      activity = { ...activity, okAt: later(activity.okAt, one.lastAt) };
    }
  }
  return activity;
}

function merge(a: Activity, b: Activity): Activity {
  const aNewer = (a.errorAt ?? "") >= (b.errorAt ?? "");
  return { okAt: later(a.okAt, b.okAt), error: aNewer ? a.error : b.error, errorAt: later(a.errorAt, b.errorAt), failing: a.failing || b.failing };
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
function flowWords(uses: readonly TriggerUse[]): string[] {
  const flows = [...new Set(uses.map(one => one.flow))];
  return flows.length === 0 ? [] : [flows.length <= 2 ? `Flow${flows.length === 1 ? "" : "s"} ${flows.join(", ")}` : plural(flows.length, "flow")];
}

// ---------------------------------------------------------------- probes

const place = (href: string | null, command: string | null = null): IntegrationPlace => ({ href, command });

async function getJson(io: IntegrationIo, url: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await (io.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(PROBE_MS), ...init });
  let body: Record<string, unknown> = {};
  try { const parsed = await response.json() as unknown; if (parsed !== null && typeof parsed === "object") body = parsed as Record<string, unknown>; } catch { body = {}; }
  return { status: response.status, body };
}

const unreachable = (service: string) => `Couldn't reach ${service}. Check this computer's internet connection, then send a test again.`;

async function probeTelegram(io: IntegrationIo, token: string): Promise<ProbeResult> {
  try {
    const { status, body } = await getJson(io, `https://api.telegram.org/bot${token}/getMe`);
    const result = body["result"] as Record<string, unknown> | undefined;
    if (body["ok"] === true && typeof result?.["username"] === "string") return { outcome: "ok", account: `@${result["username"]}` };
    if (status === 401 || status === 404) return { outcome: "failed", problem: "Telegram doesn't accept the saved bot token. Paste a new one from @BotFather." };
    return { outcome: "failed", problem: `Telegram answered with an error (${status}). Try again in a minute.` };
  } catch { return { outcome: "failed", problem: unreachable("Telegram") }; }
}

async function probeSlack(io: IntegrationIo, botToken: string): Promise<ProbeResult> {
  try {
    const { body } = await getJson(io, "https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" }, body: "{}" });
    if (body["ok"] === true) return { outcome: "ok", account: typeof body["team"] === "string" ? body["team"] : null };
    const code = typeof body["error"] === "string" ? body["error"] : "unknown";
    if (["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired"].includes(code)) return { outcome: "failed", problem: "Slack no longer accepts the app's bot token. Reinstall the app in Slack and connect it again." };
    return { outcome: "failed", problem: `Slack said "${code}". Connect the app again if this keeps happening.` };
  } catch { return { outcome: "failed", problem: unreachable("Slack") }; }
}

async function probeDiscord(io: IntegrationIo, botToken: string): Promise<ProbeResult> {
  try {
    const { status, body } = await getJson(io, "https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bot ${botToken}` } });
    if (status === 200 && typeof body["id"] === "string") return { outcome: "ok" };
    if (status === 401) return { outcome: "failed", problem: "Discord no longer accepts the bot token. Reset it in the Discord developer portal and connect again." };
    return { outcome: "failed", problem: `Discord answered with an error (${status}). Try again in a minute.` };
  } catch { return { outcome: "failed", problem: unreachable("Discord") }; }
}

async function probeTeams(io: IntegrationIo, credentials: { app: string; secret: string }): Promise<ProbeResult> {
  try {
    await teamsAccessToken(credentials, io.fetch ?? fetch);
    return { outcome: "ok" };
  } catch (error) {
    const said = error instanceof Error ? error.message : "";
    return { outcome: "failed", problem: /secret|credential|unauthori[sz]ed|invalid/i.test(said)
      ? "Microsoft doesn't accept the app's client secret. Make a new secret in Azure and connect Teams again."
      : unreachable("Microsoft Teams") };
  }
}

async function probeGithub(io: IntegrationIo, needed: boolean): Promise<ProbeResult> {
  const gh = io.gh;
  if (gh === undefined) return { outcome: "failed", problem: "GitHub can't be checked here." };
  const user = await gh("gh", ["api", "user", "--jq", ".login"], { timeoutMs: PROBE_MS, maxBuffer: 16 * 1024 }).catch(() => null);
  if (user === null || user.notFound) {
    const problem = "The GitHub CLI (gh) isn't installed on this computer.";
    return needed ? { outcome: "failed", problem: `${problem} Install it, then run gh auth login.`, fix: { command: "gh auth login" } } : { outcome: "absent", problem, setup: { command: "gh auth login" } };
  }
  if (user.timedOut) return { outcome: "failed", problem: unreachable("GitHub") };
  const login = user.stdout.trim();
  if (user.code !== 0 || !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    const signedOut = /auth login|not logged|authenticat/i.test(`${user.stderr}\n${user.stdout}`);
    if (signedOut && !needed) return { outcome: "absent", problem: "gh isn't signed in to GitHub.", setup: { command: "gh auth login" } };
    return { outcome: "failed", problem: signedOut ? "gh isn't signed in to GitHub. Run gh auth login." : unreachable("GitHub"), fix: { command: "gh auth login" } };
  }
  // Push rights per project: a read of the repository's own permission for this account, never a write.
  const push: string[] = [], noPush: string[] = [];
  for (const repo of io.repos) {
    const viewed = await gh("gh", ["repo", "view", "--json", "nameWithOwner,viewerPermission"], { cwd: repo, timeoutMs: PROBE_MS, maxBuffer: 16 * 1024 }).catch(() => null);
    if (viewed === null || viewed.code !== 0) continue;
    try {
      const value = JSON.parse(viewed.stdout) as { nameWithOwner?: unknown; viewerPermission?: unknown };
      const name = typeof value.nameWithOwner === "string" ? value.nameWithOwner : basename(repo);
      (["ADMIN", "MAINTAIN", "WRITE"].includes(String(value.viewerPermission)) ? push : noPush).push(name);
    } catch { continue; }
  }
  const detail = [push.length === 0 ? null : `Can push to ${push.join(", ")}`, noPush.length === 0 ? null : `can't push to ${noPush.join(", ")}`].filter(Boolean).join("; ") || null;
  if (noPush.length > 0) return { outcome: "failed", account: login, detail, problem: `${login} can't push to ${noPush.join(", ")}. Ask for write access on GitHub, or sign gh in as an account that has it.`, fix: { command: "gh auth login" } };
  return { outcome: "ok", account: login, detail };
}

async function probeLinear(io: IntegrationIo, key: string): Promise<ProbeResult> {
  try {
    const { status, body } = await getJson(io, LINEAR_URL, { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ viewer { name organization { name } } }" }) });
    const viewer = (body["data"] as { viewer?: { organization?: { name?: unknown } } } | undefined)?.viewer;
    if (status === 200 && viewer !== undefined && viewer !== null) return { outcome: "ok", account: typeof viewer.organization?.name === "string" ? viewer.organization.name : null };
    if (status === 400 || status === 401 || status === 403) return { outcome: "failed", problem: "Linear doesn't accept the saved API key. Make a new one in Linear → Settings → Security & access, and save it on a flow's Linear trigger." };
    return { outcome: "failed", problem: `Linear answered with an error (${status}). Try again in a minute.` };
  } catch { return { outcome: "failed", problem: unreachable("Linear") }; }
}

/** Whether something answers at host:port: a connection opened and closed, no login and no message. */
export function reachServer(host: string, port: number, secure: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = secure ? tlsConnect({ host, port, servername: host, timeout: PROBE_MS }) : tcpConnect({ host, port, timeout: PROBE_MS });
    const done = (error?: Error) => { socket.removeAllListeners(); socket.destroy(); if (error === undefined) resolve(); else reject(error); };
    socket.once(secure ? "secureConnect" : "connect", () => done());
    socket.once("timeout", () => done(new Error("timed out")));
    socket.once("error", error => done(error));
  });
}

async function probeEmail(io: IntegrationIo, smtp: { host: string; port: number; secure: boolean } | null, imap: { host: string; port: number; secure: boolean } | null): Promise<ProbeResult> {
  const reach = io.reach ?? reachServer;
  const failed: string[] = [];
  if (smtp !== null) await reach(smtp.host, smtp.port, smtp.secure).catch(() => failed.push(`the outgoing mail server ${smtp.host}:${smtp.port}`));
  if (imap !== null) await reach(imap.host, imap.port, imap.secure).catch(() => failed.push(`the incoming mail server ${imap.host}:${imap.port}`));
  const detail = [smtp === null ? null : "Sending", imap === null ? null : "reading"].filter(Boolean).join(" and ") || null;
  if (failed.length > 0) return { outcome: "failed", detail, problem: `Couldn't reach ${failed.join(" or ")}. Check the server name and port in Settings → Email.` };
  return { outcome: "ok", detail: detail === null ? null : `${detail} reachable` };
}

async function probeAgent(io: IntegrationIo, provider: ProviderId): Promise<ProbeResult> {
  if (io.checkConnection === undefined) return { outcome: "failed", problem: `${providerName(provider)} can't be checked here.` };
  let connection: ProviderConnection;
  try { connection = await io.checkConnection(provider); } catch { return { outcome: "failed", problem: `Couldn't check ${providerName(provider)}'s sign-in.` }; }
  const name = providerName(provider);
  const account = connection.email ?? connection.method ?? null;
  const detail = connection.plan ?? null;
  const command = signInCommand({ provider, authMode: connection.mode });
  switch (connection.state) {
    case "connected": case "key-works": case "key-present": return { outcome: "ok", account, detail };
    case "not-installed": return { outcome: "absent", problem: `The ${name} CLI isn't installed on this computer.` };
    case "signed-out": return { outcome: "failed", account, problem: `${name} isn't signed in. Run ${command}.`, fix: { command } };
    case "missing-key": return { outcome: "failed", problem: `${name} is set to use an API key, and none is saved. Run ${command}.`, fix: { command } };
    case "key-refused": return { outcome: "failed", problem: `${name} refused the saved API key. Save a new one with ${command}.`, fix: { command } };
    default: return { outcome: "ok", account, detail: "Signed in; the account couldn't be read" };
  }
}

// ---------------------------------------------------------------- targets

function targets(io: IntegrationIo): Target[] {
  const { store, dir, env } = io;
  const uses = triggerUses(store);
  const telegram = io.telegramTokenFile === null ? null : loadBotToken(env, io.telegramTokenFile);
  const slack = dir === null ? null : loadSlackCredentials(dir);
  const discord = dir === null ? null : loadDiscordCredentials(dir);
  const teams = dir === null ? null : loadTeamsCredentials(dir);
  const primary = dir === null ? null : effectivePrimary(env, dir, telegram !== null).channel;
  const chatUses = (app: string) => [...(primary === app ? ["Alerts"] : []), ...flowWords(uses.filter(one => one.kind === "chat" && one.app === app))];
  const list: Target[] = [];

  list.push({
    key: "telegram", group: "chat", name: "Telegram", configured: telegram !== null, account: null,
    setup: place("/settings#telegram-token"), fix: place("/settings#telegram-token"), usedBy: chatUses("telegram"), activity: telegramActivity(store),
    probe: telegram === null ? null : check => probeTelegram(check, telegram.token),
  });
  list.push({
    key: "slack", group: "chat", name: "Slack", configured: slack !== null, account: slack?.workspace ?? null,
    setup: place("/settings/slack"), fix: place("/settings/slack"), usedBy: chatUses("slack"), activity: slack === null ? NO_ACTIVITY : chatActivity(store, "slack", slack.installation),
    probe: slack === null ? null : check => probeSlack(check, slack.botToken),
  });
  list.push({
    key: "discord", group: "chat", name: "Discord", configured: discord !== null, account: discord?.workspace ?? null,
    setup: place("/settings/discord"), fix: place("/settings/discord"), usedBy: chatUses("discord"), activity: discord === null ? NO_ACTIVITY : chatActivity(store, "discord", discord.installation),
    probe: discord === null ? null : check => probeDiscord(check, discord.botToken),
  });
  list.push({
    key: "teams", group: "chat", name: "Microsoft Teams", configured: teams !== null, account: teams === null ? null : "Microsoft Teams",
    setup: place("/settings/teams"), fix: place("/settings/teams"), usedBy: chatUses("teams"), activity: teams === null ? NO_ACTIVITY : chatActivity(store, "teams", teams.installation),
    probe: teams === null ? null : check => probeTeams(check, teams),
  });

  // GitHub: always worth checking (gh is how results become pull requests); webhook deliveries count when public.
  const githubUses = uses.filter(one => one.kind === "github");
  const hooksPublic = readHooksBase(dir) !== null;
  const githubActivity = triggerActivity(githubUses.filter(one => one.delivery !== "webhook" || hooksPublic));
  list.push({
    key: "github", group: "code", name: "GitHub", configured: true, account: null,
    setup: place(null, "gh auth login"), fix: place(null, "gh auth login"),
    usedBy: ["Pull requests", ...flowWords(githubUses), ...(hooksPublic && githubUses.some(one => one.delivery === "webhook") ? ["Webhooks"] : [])], activity: githubActivity,
    probe: check => probeGithub(check, githubUses.length > 0),
  });

  const linearKey = readLinearKey(dir);
  const linearUses = uses.filter(one => one.kind === "linear");
  list.push({
    key: "linear", group: "code", name: "Linear", configured: linearKey !== null, account: null,
    setup: place("/flows"), fix: place("/flows"), usedBy: flowWords(linearUses), activity: triggerActivity(linearUses),
    probe: linearKey === null ? null : check => probeLinear(check, linearKey),
  });

  const email = readEmailSettings(dir);
  const google = googleConnected(dir);
  const emailUses = uses.filter(one => one.kind === "email");
  const mailWatch = tableExists(store, "flow_mail_watch") ? store.handle.prepare("SELECT failures, last_outcome, updated_at FROM flow_mail_watch WHERE id = 1").get() : undefined;
  const watchActivity: Activity = mailWatch === undefined ? NO_ACTIVITY : Number(mailWatch["failures"] ?? 0) > 0
    ? { okAt: null, error: str(mailWatch["last_outcome"]), errorAt: str(mailWatch["updated_at"]), failing: true }
    : { okAt: str(mailWatch["updated_at"]), error: null, errorAt: null, failing: false };
  list.push({
    key: "email", group: "mail", name: "Email", configured: email !== null || google !== null, account: email?.from ?? google?.address ?? null,
    setup: place("/settings#email"), fix: place("/settings#email"), usedBy: [...flowWords(emailUses)], activity: merge(triggerActivity(emailUses), watchActivity),
    probe: email === null ? null : check => probeEmail(check, { host: email.host, port: email.port, secure: email.secure }, email.imap),
  });

  // Each project's MCP tools: the server starts and lists its tools.
  const toolHome = io.toolHome ?? homedir();
  let anyTool = false;
  for (const repo of io.repos) {
    for (const tool of projectToolsOf(store, repo)) {
      anyTool = true;
      const href = `/settings/tools?repo=${encodeURIComponent(repo)}#tool-${encodeURIComponent(tool.name)}`;
      const test = tool.lastTest;
      list.push({
        key: `mcp:${repo}:${tool.name}`, group: "tools", name: tool.name, configured: true, account: basename(repo), ...(tool.source === "custom" ? { custom: true as const } : {}),
        setup: place(href), fix: place(href), usedBy: [`Tasks in ${basename(repo)}`],
        activity: test === null ? NO_ACTIVITY : test.ok ? { okAt: test.at, error: null, errorAt: null, failing: false } : { okAt: null, error: test.problem, errorAt: test.at, failing: false },
        probe: async check => {
          const missing = missingSecrets(tool.spec, readToolSecrets(repo, tool.name, toolHome));
          if (missing.length > 0) return { outcome: "failed", problem: `${tool.name} needs ${missing.join(", ")}. Add ${missing.length === 1 ? "it" : "them"} in Settings → Tools.` };
          const tested = await testToolOf(check.store, repo, tool.name, (check.clock ?? (() => new Date()))(), { home: toolHome, omitEnv: ALL_CREDENTIAL_ENV, timeoutMs: 15_000 });
          if (tested === null) return { outcome: "failed", problem: `${tool.name} is no longer on this project.` };
          return tested.ok ? { outcome: "ok", account: basename(repo), detail: plural(tested.tools.length, "tool") } : { outcome: "failed", account: basename(repo), problem: `${tool.name} didn't start: ${scrubIntegrationText(tested.problem ?? "no answer")}` };
        },
      });
    }
  }
  if (!anyTool) list.push({ key: "mcp", group: "tools", name: "MCP tools", configured: false, account: null, setup: place("/settings/tools"), fix: place("/settings/tools"), usedBy: [], activity: NO_ACTIVITY, probe: null });

  // Monitoring: the delivery loop is the check; its status row says how it's going.
  const monitoring = readMonitoring(dir);
  const destinations = [
    ...(monitoring.webhook === null ? [] : [{ sink: "webhook", name: "Audit webhook", account: origin(monitoring.webhook.url), address: monitoring.webhook.url, uses: "Audit stream" }]),
    ...(monitoring.folder === null ? [] : [{ sink: "folder", name: "Audit folder", account: monitoring.folder.path, address: monitoring.folder.path, uses: "Audit stream" }]),
    ...(monitoring.traces === null ? [] : [{ sink: "traces", name: "Traces", account: origin(monitoring.traces.endpoint), address: monitoring.traces.endpoint, uses: "Run traces" }]),
  ];
  for (const one of destinations) {
    const status = store.monitoringStatus(one.sink).find(row => row.target === targetOf(one.address)) ?? null;
    const activity: Activity = status === null ? NO_ACTIVITY : { okAt: status.lastOkAt, error: status.lastError, errorAt: status.lastErrorAt, failing: status.failures > 0 };
    list.push({
      key: `monitoring:${one.sink}`, group: "monitoring", name: one.name, configured: true, account: one.account,
      setup: place("/settings/monitoring"), fix: place("/settings/monitoring"), usedBy: [one.uses], activity,
      probe: async () => status === null || (status.lastOkAt === null && status.lastError === null)
        ? { outcome: "ok", account: one.account, detail: "Starting: the first delivery goes out within a few seconds" }
        : status.failures > 0 ? { outcome: "failed", account: one.account, problem: `Deliveries are failing: ${status.lastError ?? "no answer"}` }
        : { outcome: "ok", account: one.account },
    });
  }
  if (destinations.length === 0) list.push({ key: "monitoring", group: "monitoring", name: "Monitoring", configured: false, account: null, setup: place("/settings/monitoring"), fix: place("/settings/monitoring"), usedBy: [], activity: NO_ACTIVITY, probe: null });

  for (const provider of AGENTS) {
    list.push({
      key: `agent:${provider}`, group: "agents", name: providerName(provider), configured: true, account: null,
      setup: place("/settings#providers"), fix: place("/settings#providers"), usedBy: ["Tasks"], activity: NO_ACTIVITY,
      probe: check => probeAgent(check, provider),
    });
  }
  return list;
}

// ---------------------------------------------------------------- the list

function combine(target: Target, row: CheckRow | undefined): Integration {
  const base = { key: target.key, group: target.group, name: target.name, usedBy: target.usedBy, ...(target.custom ? { custom: true as const } : {}) };
  const checked = target.probe === null || row !== undefined;
  const lastSuccessAt = later(row?.okAt ?? null, target.activity.okAt);
  const checkError = row?.error ?? null, checkErrorAt = row?.errorAt ?? null;
  const activityNewer = (target.activity.errorAt ?? "") > (checkErrorAt ?? "");
  const lastError = target.activity.error !== null && (activityNewer || checkError === null) ? scrubIntegrationText(target.activity.error) : checkError;
  const lastErrorAt = lastError === null ? null : later(checkErrorAt, target.activity.errorAt);
  const common = { account: row?.account ?? target.account, detail: row?.detail ?? null, checked, checkedAt: row?.checkedAt ?? null, lastSuccessAt, lastError, lastErrorAt };
  if (!target.configured || row?.outcome === "absent") {
    return { ...base, ...common, account: null, detail: row?.outcome === "absent" ? row.problem : null, state: "not-set-up", action: { kind: "setup", label: "Set up", ...target.setup } };
  }
  // Broken: the last check failed, or deliveries are failing and no successful check has come since.
  const failing = row?.outcome === "failed" ? row.problem
    : target.activity.failing && (row === undefined || (target.activity.errorAt ?? "") >= row.checkedAt) ? target.activity.error ?? "Deliveries are failing."
    : null;
  if (failing !== null) {
    return { ...base, ...common, state: "broken", action: { kind: "fix", label: "Fix", words: scrubIntegrationText(failing ?? "The last check failed."), ...target.fix } };
  }
  return { ...base, ...common, state: "connected", action: { kind: "test", label: "Send test" } };
}

/** Every integration as it stands now, from files and saved history only: no network, no process, never slow. */
export function integrationsNow(io: IntegrationIo): Integration[] {
  const rows = readIntegrationChecks(io.store);
  return targets(io).map(target => combine(target, rows.get(target.key)));
}

/** Run the checks (all, or the named ones), record each answer, and return the list. */
export async function checkIntegrations(io: IntegrationIo, keys?: readonly string[]): Promise<Integration[]> {
  const clock = io.clock ?? (() => new Date());
  const wanted = targets(io).filter(one => one.probe !== null && (keys === undefined || keys.includes(one.key)));
  await Promise.all(wanted.map(async target => {
    let result: ProbeResult;
    try { result = await target.probe!(io); } catch { result = { outcome: "failed", problem: "The check stopped unexpectedly. Try again." }; }
    recordIntegrationCheck(io.store, target.key, result, clock());
  }));
  return integrationsNow(io);
}

/** The one line `status` and `onboard` add when something is Broken; null when nothing is. */
export function integrationsBrokenLine(list: readonly Integration[]): string | null {
  const broken = list.filter(one => one.state === "broken").map(one => one.name);
  if (broken.length === 0) return null;
  const names = broken.length <= 3 ? broken.join(", ") : `${broken.slice(0, 3).join(", ")} and ${broken.length - 3} more`;
  return `Broken integration${broken.length === 1 ? "" : "s"}: ${names}. See \`toolroll integrations\` or Settings → Integrations.`;
}

const whenText = (at: string | null) => (at === null ? "never" : `${at.slice(0, 16).replace("T", " ")} UTC`);

/** The CLI's lines: one per integration, then the fix under anything Broken. */
export function renderIntegrations(list: readonly Integration[]): string[] {
  const width = Math.min(24, Math.max(...list.map(one => one.name.length)));
  return list.flatMap(one => {
    const facts = [one.account, one.detail].filter(Boolean).join(" · ");
    const lines = [`${one.name.padEnd(width)}  ${STATE_WORDS[one.state].padEnd(10)}${facts === "" ? "" : `  ${facts}`}`];
    if (one.state !== "not-set-up") lines.push(`${"".padEnd(width)}  last success ${whenText(one.lastSuccessAt)}${one.lastError === null ? "" : ` · last error ${whenText(one.lastErrorAt)}: ${one.lastError}`}`);
    if (one.action.kind === "fix") lines.push(`${"".padEnd(width)}  Fix: ${one.action.words}${one.action.command === null || one.action.words.includes(one.action.command) ? "" : ` (run ${one.action.command})`}`);
    if (one.action.kind === "setup") lines.push(`${"".padEnd(width)}  Set up: ${one.action.command !== null ? `run ${one.action.command}` : `Settings (${one.action.href ?? "/settings"})`}`);
    return lines;
  });
}

// ---------------------------------------------------------------- background

export type IntegrationMonitor = {
  /** The list now, without waiting; starts a background check when the last one is older than the cache. */
  list(): Integration[];
  /** Check now and wait (Send test, or the first answer in a test). */
  check(keys?: readonly string[]): Promise<Integration[]>;
  /** Whether a background check is running. */
  readonly checking: boolean;
};

/** Checks in the background with a short cache, as the first-run suggestions are: a render never waits on a check. */
export function createIntegrationMonitor(io: () => IntegrationIo, options: { cacheMs?: number; now?: () => number } = {}): IntegrationMonitor {
  const cacheMs = options.cacheMs ?? 60_000;
  const now = options.now ?? Date.now;
  let lastStarted = 0;
  let running: Promise<unknown> | null = null;
  const start = (keys?: readonly string[]) => {
    const current = io();
    const run = checkIntegrations(current, keys).catch(() => []);
    if (keys === undefined) {
      lastStarted = now();
      running = run.finally(() => { running = null; });
    }
    return run;
  };
  return {
    list() {
      const current = io();
      const list = integrationsNow(current);
      if (running === null && now() - lastStarted >= cacheMs) void start();
      return list;
    },
    check: keys => start(keys),
    get checking() { return running !== null; },
  };
}
