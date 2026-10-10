/** HTTP answers every console route shares: server options, body limits, safe responses, redirects and return paths. */
import { html, htmlString, isHtml, type Html } from "../html.js";
import { chatResultHref as sharedResultHref } from "../chat-controls.js";
import { type CliHttpOptions,type RunOperateAs } from "../cli-http.js";
import { type CodingWorkspace } from "../coding-workspace.js";
import { hasForbiddenControls } from "../decision.js";
import { type run as execRun } from "../exec.js";
import { type MailSender } from "../flow-actions.js";
import { type FetchLike } from "../flow-share.js";
import { type TriggerIo } from "../flow-triggers.js";
import { type InstallMethod } from "../install-method.js";
import { type IntegrationIo } from "../integrations.js";
import { type VersionRunner } from "../model-catalog.js";
import { type cloneGithubRepo,type listGithubRepos,type previewGithubRepo } from "../onboard.js";
import { type PublishExec } from "../publish.js";
import { type ResultTab } from "../result-review.js";
import { type Store } from "../store.js";
import { type SubscriptionLeadRunner } from "../subscription-chat.js";
import { type launchRuntimeUpdate } from "../toolroll-update.js";
import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage,type ServerResponse } from "node:http";
import { SIGN_IN_LINK_PATH } from "./session.js";

export type ServeOptions = {
  /** Tests: runs a person's command for the HTTP MCP gateway instead of operate.ts's. */
  runOperateAs?: import("../mcp-person.js").RunOperateAs;
  /** `toolroll demo`: the scripted lead that answers Chat instead of a model. */
  demoLead?: import("../demo.js").DemoLead;
  /** Tests: the bin whose real path says how Toolroll was installed (Settings → Updates' command). */
  installBin?: string;
  /** Native coding workspace injection for isolated integration tests. */
  codingWorkspace?: CodingWorkspace;
  /** Read-only worker connections for heavy reads (read-executor.ts); 0 reads in-process. Default: off under tests. */
  readWorkers?: number;
  store: Store;
  evidenceRoot: string;
  clock?: () => Date;
  /**
   * The console's canonical https origin, when TLS terminates in front
   * (arc 3 finding 2/16): EXACTLY an origin — no path, query, credentials.
   * The one trust anchor for secure-context features: it joins the allowed
   * hosts, its origin authorizes POSTs, cookies turn Secure, and the
   * install/push cards light up. X-Forwarded-* is consulted only from a
   * loopback peer, the same-host proxy (public-access.ts).
   */
  publicUrl?: string;
  /** Tests: the shared command boundary `POST /api/cli` runs (default: operate.ts's runOperateAs). */
  cliRunner?: RunOperateAs;
  /** Tests: remote command metadata until the shared contract declares it. */
  cliModeOf?: CliHttpOptions['modeOf'];
  /** Tests: whether a password on a request is still accepted (default: this release's version, password-bearer.ts). */
  passwordBearerAccepted?: boolean;
  /** Tests: the clock request budgets for API tokens count by (request-budget.ts). */
  requestBudgetClock?: () => number;
  /** Where repos.json lives — every enrollment locks exactly this file. */
  registryPath?: string;
  /** This console fronts an `up` process: onboarding copy says how to watch. */
  upConsole?: boolean;
  /**
   * The lead on by default (onboarding): with no lead set up, the agent CLI
   * signed in on this computer runs it, once. `up` and `serve` turn this on;
   * tests opt in.
   */
  leadByDefault?: boolean;
  /** Test seam: the operating system the sign-in command is written for. */
  platform?: NodeJS.Platform;
  /** Extra Host values this server answers as (a Tailscale name, a LAN ip:port). */
  allowedHosts?: readonly string[];
  /**
   * This computer's names on its tailnet (onboarding): read at start and every
   * few minutes; the console answers to each on its own port without an
   * --allow-host, and the phone card names the address. Absent = none.
   */
  tailnetNames?: () => Promise<readonly string[]>;
  /**
   * The first-account road (setup review): while NO approver exists, the
   * login page offers "create the first account", gated by this code —
   * printed once by the process that started the server, never stored.
   * Five wrong codes close the road until the server restarts. The moment
   * an approver exists, the page is the ordinary sign-in.
   */
  setupCode?: string;
  /**
   * Where the Telegram bot token lives when set from here. Present = the
   * settings card renders; absent = no settings surface at all.
   */
  telegramTokenFile?: string;
  /** Where messaging config files live (beside the database) — enables the
   * primary-messenger selector on the settings screen. */
  configDir?: string;
  /** Test seam for the Slack setup handshake. */
  slackFetcher?: typeof fetch;
  /** Settings → Updates seams: the latest release, how this Toolroll was
   * installed, its version, and how the updater job starts. Tests and
   * screenshots inject these; production reads the registry and launchd. */
  updates?: { latest?: () => Promise<{ version: string }>; method?: InstallMethod; current?: string; dist?: string; launch?: typeof launchRuntimeUpdate };
  discordFetcher?: typeof fetch;
  /** Injected by tests: Microsoft sign-in, key metadata and Teams conversation calls. */
  teamsFetcher?: typeof fetch;
  /** Injected by tests: how "Check now" reaches GitHub (gh) and Linear (fetch). */
  flowTriggerIo?: Partial<TriggerIo>;
  /**
   * The repo this console serves. Scopes run evidence to that repo's tasks
   * (and unplaced ones) and turns on the gaps and capabilities views —
   * without it those pages say so instead of guessing.
   */
  repo?: string;
  /**
   * The full authorization ceiling (v2 review, finding 1): `repos` this
   * server may show and operate on, plus `projectRoots` under which any git
   * repository qualifies. `repo` above is sugar for one entry in `repos`.
   * No configuration at all is the legacy unscoped mode — everything
   * visible, and stated as such where the code decides.
   */
  repos?: readonly string[];
  projectRoots?: readonly string[];
  /** Repositories the co-located `up` process has proved and is watching.
   * Kept as a callback so projects added after startup appear immediately
   * without turning the durable registry itself into an authorization source. */
  currentRepos?: () => readonly string[];
  /** Injected by tests: the fetch direct-API chat turns use, and where chat
   * keys are read from (defaults to process.env). */
  chatFetcher?: typeof fetch;
  /** Subscription-backed mate transport; injected in tests so no real
   * Codex or Claude membership turn is consumed. */
  subscriptionChatRunner?: SubscriptionLeadRunner;
  /** Tests: stands in for `codex mcp list --json` in the project (the Tools page's "Found on this computer"). */
  codexToolList?: (cwd: string) => Promise<string | null>;
  /** Tests: the home whose ~/.toolroll (or older ~/.standing-orders) tool-secrets and ~/.claude.json the Tools page uses. */
  toolHome?: string;
  /** v87: sends Send email steps' mail and the settings test (tests inject one). */
  mailSender?: MailSender;
  /** Injected by tests: how Flows → Import fetches a flow file's address. */
  flowFetch?: FetchLike;
  /** v89: Google's token endpoint (tests inject a scripted one). */
  googleFetch?: typeof fetch;
  /** Tests: every request a one-click connection makes (discovery, registration, tokens). */
  connectFetch?: typeof fetch;
  /** Tests: every request sign-in with the identity provider makes (discovery, keys, tokens). */
  ssoFetch?: typeof fetch;
  chatEnv?: Record<string, string | undefined>;
  /**
   * The live peek's locality ASSERTION (live-peek v3 §3): the administrator
   * who starts serve names the runner this machine owns. This is documented
   * as an assertion, not machine-bound credential enforcement — the product
   * has none anywhere. Absent = the peek is off, and says so.
   */
  desktopIdentity?: string;
  /** Trusted native admission callback; enrollment rows alone never supply this authority. */
  additionalProjectRepos?: () => readonly string[];
  /** The co-located `up`'s exact admitted repositories, read on every request: its startup projects plus those
   * added since (`repos add`, the lead, the console) and minus those removed. When given it replaces `repos` as
   * the exact part of the ceiling, so an addition or removal shows without a restart. */
  admittedRepos?: () => readonly string[];
  connectionProbe?: typeof execRun;
  connectionHome?: string;
  /** Test seam for Chat's first tasks: the `gh` and `git grep` reads. */
  firstTaskRunner?: typeof execRun;
  /** Test seam for Settings → Integrations: how its checks reach services (fetch, gh, mail servers). */
  integrationIo?: Partial<IntegrationIo>;
  modelCatalogFetcher?: typeof fetch;
  /** Test seams for Settings → Models: CLI version probes and the PATH they search. */
  modelRunner?: VersionRunner;
  modelPath?: string;
  localRunner?: string;
  /** The checkout pool root the peek confines itself to (realpath-proved). */
  poolRoot?: string;
  /**
   * Editor deep links (arc 6): a DEPLOYMENT capability, not an activation.
   * vscode:// links open on the BROWSER's machine, so links render only
   * when three statements align: the operator started serve with
   * --editor vscode AND --runner (this machine owns the worktrees), the
   * run belongs to that runner, and THIS session turned links on for
   * this device. "vscode" is the only value; the scheme is never data.
   */
  editorLinks?: "vscode";
  /** Injected by tests: the onboarding ceremony's gh-facing halves — the
   * ceremony's gating, nonce, and enrollment logic is what the HTTP tests
   * prove; gh itself is proved by onboard.test.ts. */
  ghPreview?: typeof previewGithubRepo;
  ghClone?: typeof cloneGithubRepo;
  ghList?: typeof listGithubRepos;
  /** Injected by tests: the git and gh calls pull-request setup and Merge make. */
  publishExec?: PublishExec;
};
// A note is at most NOTE_BYTE_CAP (16,000) UTF-8 bytes, which URL encoding
// can triple: room for one whole, before canonical text validation.
export const BODY_CAP = 64 * 1024;

/** How long a stop waits for subagents and the lead's follow pass before closing anyway. */
export const SHUTDOWN_WAIT_MS = 5_000;

// ---- path plumbing ---------------------------------------------------------

/**
 * Match `/t/<id>` (suffix "") or `/t/<id>/<verb>` — the id percent-decoded
 * exactly once, refused when it does not decode, is oversized, or carries
 * control characters. Legacy CLI-created ids are free-form; the URL is not.
 */
export function matchTaskPath(pathname: string, suffixPattern: string): { taskId: string; verb: string } | null {
  const match = new RegExp(`^/t/([^/]+)${suffixPattern === "" ? "$" : suffixPattern}`).exec(pathname);
  if (match === null) return null;
  let taskId: string;
  try {
    taskId = decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
  if (taskId.length === 0 || taskId.length > 64 || hasForbiddenControls(taskId)) return null;
  return { taskId, verb: match[2] ?? "" };
}

export function taskHref(taskId: string): string {
  return `/t/${encodeURIComponent(taskId)}`;
}

// ---- rendering -------------------------------------------------------------

export const SAFETY = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'; worker-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

/** A text/html answer carries markup (Html); every other type, its own text. */
export type ResponseBody<T extends string> = T extends `text/html${string}` ? Html : string;

export function respond<T extends string>(response: ServerResponse, status: number, type: T, body: ResponseBody<T>): void {
  // A route that set its OWN policy (the service worker's default-src
  // 'none') or its own caching (the pre-auth assets) keeps it —
  // writeHead's headers would otherwise win.
  const own = response.getHeader("content-security-policy");
  const cache = response.getHeader("cache-control");
  response.writeHead(status, {
    ...SAFETY,
    ...(own === undefined ? {} : { "content-security-policy": own as string }),
    ...(cache === undefined ? {} : { "Cache-Control": cache as string }),
    "Content-Type": type,
  });
  response.end(isHtml(body) ? htmlString(body) : body);
}

/**
 * A page response. With a nonce, this response's CSP admits exactly the one
 * inline script the shell stamped with the same value — generated per
 * response, never shared, never 'unsafe-inline' (Codex board review,
 * finding 9). Everything else keeps the constant script-free policy.
 */
export function page(response: ServerResponse, status: number, document: Html, nonce?: string, fetches?: boolean): void {
  if (nonce === undefined) return respond(response, status, "text/html; charset=utf-8", document);
  response.writeHead(status, {
    ...SAFETY,
    "Content-Security-Policy":
      `default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'; worker-src 'self'; img-src 'self'; script-src 'nonce-${nonce}'; ` +
      // connect-src only when the page's script actually fetches (a region
      // poller, the full chrome beat, or the minimal sensitive-page beat).
      `${fetches === true ? "connect-src 'self'; " : ""}form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(htmlString(document));
}

/**
 * An outside sign-in comes back only to the browser that started it: the
 * start leaves the visit's state in this cookie (Lax, so it rides the
 * service's redirect back; the session cookie is Strict and doesn't), and a
 * return whose state isn't the one this browser holds is refused. So nobody
 * can start a sign-in and have someone else finish it into their project.
 */
/** A moment's page on the way to or back from another site's sign-in: no stylesheet may load there, so the palette rides inline. */
export const HANDOFF_STYLE = html`<style>body{font:15px/1.5 "Geist",system-ui,sans-serif;margin:2rem;background:#efefef;color:#171717}a{color:#171717;text-decoration-color:#8f8f8f;text-underline-offset:3px}@media(prefers-color-scheme:dark){body{background:#0b0b0b;color:#ededed}a{color:#ededed;text-decoration-color:#ff6fb5}}</style>`;
export const SIGN_IN_COOKIE = "so-sign-in";
export function startedHere(request: IncomingMessage, state: string): boolean {
  const held = new RegExp(`(?:^|;\\s*)${SIGN_IN_COOKIE}=([A-Za-z0-9_-]{16,128})`).exec(request.headers.cookie ?? "")?.[1];
  return held !== undefined && held.length === state.length && timingSafeEqual(Buffer.from(held), Buffer.from(state));
}
export const signInSpent = (path: string) => `${SIGN_IN_COOKIE}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax`;

/**
 * Off to another site's sign-in (Google, a service's one-click connection):
 * a page that moves on by itself. Not a redirect: every page's form-action
 * 'self' also covers where a form's answer redirects, so a browser stops a
 * form that is answered with another site's address.
 */
export function goOutside(response: ServerResponse, to: string, words: string, bind: { state: string; path: string; secure: boolean }): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
    "set-cookie": `${SIGN_IN_COOKIE}=${bind.state}; Path=${bind.path}; Max-Age=900; HttpOnly; SameSite=Lax${bind.secure ? "; Secure" : ""}`,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  response.end(htmlString(html`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${to}"><title>Toolroll</title>${HANDOFF_STYLE}<p>${words} <a href="${to}">Continue</a></p>`));
}

export function redirect(response: ServerResponse, to: string): void {
  response.writeHead(303, { ...SAFETY, Location: to });
  response.end();
}


export const taskChatHref = (taskId: string): string => `/chat?task=${encodeURIComponent(taskId)}`;
/** A project's own lead thread (v77). */
export const projectChatHref = (repo: string): string => `/chat?project=${encodeURIComponent(repo)}`;

export function safeReturn(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "/";
  // A backslash is a slash to a browser's URL parser (`/\evil` → `//evil`), so it is refused too (v3 review, finding 10).
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\r\n\t\u0000-\u001f]/.test(raw) || raw.length > 512) return "/";
  try {
    const path = decodeURIComponent(new URL(raw, "http://standing-orders.local").pathname);
    if (path.startsWith("//") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return "/";
  } catch { return "/"; }
  return raw;
}

/**
 * The destination a sign-in returns to (a phone's deep link to an exact
 * task or result): `safeReturn`, then narrower still — never the sign-in,
 * sign-up, join or sign-out roads themselves (a loop, or a token in a
 * path), never an encoded second scheme or host once the browser decodes
 * it, never a query key that could carry a secret, and never a region
 * fetch (`?fragment=`), which is a piece of a page and not a place to
 * land. Only the app's own pages qualify: the task lens, the chat, the
 * work and board views, and the fixed control destinations a phone
 * button can name. Nothing here is a second redirect framework: one
 * same-site path, or "/".
 */
export const LOGIN_RETURN_PAGES = /^\/(oauth\/authorize|t\/[^/]+|r\/[1-9]\d*|code(?:\/[a-f0-9]{32}(?:\/ship)?)?|review|chat|work|board|projects|routines|recipes|fleet|settings(\/[a-z-]+)?|mode)$/;
export function loginReturn(raw: string | null | undefined): string {
  const safe = safeReturn(raw);
  if (safe === "/") return "/";
  let parsed: URL;
  try {
    parsed = new URL(safe, "http://standing-orders.local");
  } catch {
    return "/";
  }
  if (parsed.origin !== "http://standing-orders.local" || parsed.username !== "" || parsed.password !== "") return "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return "/";
  }
  if (/^\/\/|\\|[\r\n\t\u0000-\u001f]/.test(decodedPath) || /^\/(login|logout|signup|join)(\/|$)/.test(decodedPath)) return "/";
  if (!LOGIN_RETURN_PAGES.test(decodedPath) || parsed.searchParams.has("fragment")) return "/";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/token|password|secret|csrf|code|key|auth/i.test(key)) parsed.searchParams.delete(key);
  }
  const query = parsed.searchParams.toString();
  return `${parsed.pathname}${query === "" ? "" : `?${query}`}`;
}

/** A request path fit for a log: the one-time sign-in link's code is left out. */
export function redactedPath(path: string): string {
  return path.startsWith(SIGN_IN_LINK_PATH) ? `${SIGN_IN_LINK_PATH}…` : path;
}

/** The sign-in page that comes back to `path` afterwards, or plain /login when the path is not one to come back to. */
export function loginHref(path: string): string {
  const back = loginReturn(path);
  return back === "/" ? "/login" : `/login?return=${encodeURIComponent(back)}`;
}

/** Chat actions may return only to the unified chat or one task-focused
 * lens. Other same-site paths are valid elsewhere, but not for chat forms. */
export function safeChatReturn(raw: string | null | undefined): string {
  const safe = safeReturn(raw);
  try {
    const parsed = new URL(safe, "http://standing-orders.local");
    if (parsed.pathname !== "/chat") return "/chat";
    const conversation=parsed.searchParams.get('conversation');
    if(conversation&&/^[a-f0-9-]{36}$/.test(conversation))return `/chat?conversation=${encodeURIComponent(conversation)}`;
    if(parsed.searchParams.get('private')==='1')return '/chat?private=1';
    const task = parsed.searchParams.get("task");
    return task !== null && task.length > 0 && task.length <= 64 && !hasForbiddenControls(task)
      ? taskChatHref(task)
      : "/chat";
  } catch {
    return "/chat";
  }
}

export function chatReturnWithSaid(back: string, said: string): string {
  return `${back}${back.includes("?") ? "&" : "?"}said=${encodeURIComponent(said)}`;
}

export const chatReturnWithLatest = (back: string): string => `${back}#latest`;

/** The one result page's address: the task and its run, never a project path
 * (the page finds the result's project itself and keeps the person's own). */
export const reviewHref = (taskId: string, runId: number | null = null): string =>
  `/review?result=${encodeURIComponent(taskId)}${runId === null ? "" : `&run=${runId}`}`;

/** The chat's result detail (package 3): the same panel the run page
 * and the cockpit render, opened beside the conversation when the screen
 * has room and as a dedicated view with Back to chat when it does not. */
export const chatResultHref = (taskId: string, runId: number, tab: ResultTab = "summary"): string => sharedResultHref(taskId, runId, tab);

// ---- request plumbing ------------------------------------------------------

export async function form(request: IncomingMessage, cap = BODY_CAP): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > cap) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
