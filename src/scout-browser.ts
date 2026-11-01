/**
 * The scout's browser (run 2356, review 828). Chrome's own sandbox can't start inside the agent fence (nested
 * Seatbelt: every page crashed, even example.com), and switching that sandbox off is not an option. So the browser
 * tool runs beside the agent instead of under it: the worker starts the pinned Playwright MCP itself, outside the
 * fence with Chrome's sandbox on, serving its HTTP transport on a random loopback port, and the fenced agent gets
 * only that URL. Every page still goes through the scout's public-web-only proxy, and screenshots land in the run's
 * image folder. Before research begins the browser is checked once, through that proxy, on a public page, with one
 * time limit for the whole check; a browser that can't start is said in one line and the scout researches
 * without it.
 *
 * Playwright MCP 0.0.82 has no per-client token for its HTTP transport; it answers only on 127.0.0.1, only for
 * that host name (its own host check), and only while this run's scout does.
 *
 * An explicit exception (docs/plans/sandbox-parity.md C4, owner Q-A): Toolroll can't fence this process without
 * switching Chrome's sandbox off, so its launch is held to a contract instead, and refused when any part fails
 * (`browserContractProblem`): the pinned Playwright MCP and its Chrome for Testing are installed in Toolroll's own
 * helpers folder (inside the state folder every build's fence denies) and run by Toolroll's own Node; its arguments are
 * exactly the expected ones (Chrome's sandbox on, the scout's proxy on, its image folder as its output and working
 * folder); its environment is an allowlist. The run records which exception it ran under.
 */
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { run } from "./exec.js";
import { SCOUT_BROWSER_LOCK, SCOUT_BROWSER_MANIFEST } from "./scout-browser-lock.js";
import { sleep } from "./sleep.js";

export type BrowserLaunch = { command: string; args: readonly string[] };
export type ScoutBrowserServer = { url: string; close: () => Promise<void> };
export type BrowserStart = { ok: true; server: ScoutBrowserServer } | { ok: false; reason: string };
export type BrowserStarter = (launch: BrowserLaunch, options: BrowserOptions) => Promise<BrowserStart>;
export type BrowserOptions = {
  /** The browser tool's environment: the scout's own, its proxy settings included. */
  env: Record<string, string | undefined>;
  /** Toolroll's helpers folder (in its state folder) the pinned browser is installed in, and the scout's proxy: the
   * launch contract's trusted inputs, from the plane, never from the launch. */
  contract?: { helpers: string; proxy: string };
  /** Where it saves screenshots (its `--output-dir`), also its working folder. */
  folder: string;
  /** The whole start and check, from spawn to screenshot (review 828: at most 60 seconds). */
  timeoutMs?: number;
};

/** The public page the check opens through the scout's proxy. */
export const PREFLIGHT_PAGE = "https://example.com/";
const PREFLIGHT_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 5_000;
const IMAGE = /\.(png|jpe?g)$/i;

/** How a scout gets its browser: started for real under its launch contract, or, for a test's stub agent, a placeholder
 * that starts nothing. */
export function starterFor(agentInjected: boolean): BrowserStarter {
  return agentInjected ? unstarted : startContractedBrowser;
}

const unstarted: BrowserStarter = async () => ({ ok: true, server: { url: "http://127.0.0.1:9/mcp", close: async () => undefined } });

/** Start the browser tool outside the fence and check it opens a public page and saves a screenshot. */
export async function startScoutBrowser(launch: BrowserLaunch, options: BrowserOptions): Promise<BrowserStart> {
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const late = `the browser did not start within ${Math.round(timeoutMs / 1000)} seconds`;
  const served = await serveBrowser(launch, options, deadline, late);
  if (!served.ok) return served;
  const before = new Set(entries(options.folder));
  const session = openSession(served.server.url, deadline, late);
  try {
    let checked = await preflight(session);
    if (checked.ok && !entries(options.folder).some(name => !before.has(name) && IMAGE.test(name))) checked = { ok: false, reason: "the browser saved no screenshot" };
    if (!checked.ok) {
      await served.server.close();
      return checked;
    }
    return served;
  } finally {
    await session.close();
    // The check's own screenshot and page notes are not the scout's.
    for (const name of entries(options.folder)) if (!before.has(name)) rmSync(join(options.folder, name), { recursive: true, force: true });
  }
}

async function preflight(session: McpSession): Promise<{ ok: true } | { ok: false; reason: string }> {
  const started = await session.start();
  if (!started.ok) return started;
  for (const [tool, input] of [["browser_navigate", { url: PREFLIGHT_PAGE }], ["browser_take_screenshot", { type: "png" }]] as const) {
    const done = await session.call(tool, input);
    if (!done.ok) return done;
  }
  return { ok: true };
}

/** Spawn the tool with its HTTP transport on a free 127.0.0.1 port and wait until it answers there. */
async function serveBrowser(launch: BrowserLaunch, options: BrowserOptions, deadline: number, late: string): Promise<BrowserStart> {
  const port = await freePort();
  const child = spawn(launch.command, [...launch.args, "--host", "127.0.0.1", "--port", String(port), "--allowed-hosts", `127.0.0.1:${port}`], {
    cwd: options.folder,
    env: options.env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
  });
  let stderr = "";
  let stopped: string | null = null;
  child.on("error", error => { stopped ??= `the browser tool could not run (${error.message})`; });
  child.on("exit", (code, sig) => { stopped ??= `the browser tool stopped (${sig ?? `exit ${code}`})${lastLine(stderr) === "" ? "" : `: ${lastLine(stderr)}`}`; });
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4_000); });
  const close = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(done => child.once("exit", () => done()));
      signal(child.pid, "SIGTERM");
      await Promise.race([exited, new Promise<void>(done => setTimeout(done, CLOSE_GRACE_MS).unref())]);
    }
    // Its browser and helpers go with it.
    signal(child.pid, "SIGKILL");
  };
  // First runs download the pinned tool; it listens once it is ready.
  while (stopped === null && Date.now() < deadline && !(await answers(port))) await sleep(250);
  if (stopped !== null || Date.now() >= deadline) {
    const reason = stopped ?? late;
    await close();
    return { ok: false, reason };
  }
  return { ok: true, server: { url: `http://127.0.0.1:${port}/mcp`, close } };
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address !== null ? done(address.port) : fail(new Error("no free port"))));
    });
  });
}

function answers(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1_000);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => done(false));
    socket.once("timeout", () => { socket.destroy(); done(false); });
  });
}

function signal(pid: number | undefined, name: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, name); } catch { /* already gone */ }
}

function entries(folder: string): string[] {
  try { return readdirSync(folder); } catch { return []; }
}

type Answer = { ok: true; message: Record<string, unknown> } | { ok: false; reason: string };
export type McpSession = {
  start: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  call: (tool: string, input: Record<string, unknown>) => Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; reason: string }>;
  close: () => Promise<void>;
};

/** A client of the browser's HTTP transport, as the scout's own is: every step answers by `deadline`, or says why not. */
export function openSession(url: string, deadline: number, late: string): McpSession {
  let session: string | null = null;
  let next = 0;
  const post = (body: Record<string, unknown>, method = "POST"): Promise<{ ok: true; status: number; headers: Record<string, unknown>; text: string } | { ok: false; reason: string }> =>
    new Promise(done => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return done({ ok: false, reason: late });
      const headers: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json" };
      if (session !== null) headers["mcp-session-id"] = session;
      const sent = httpRequest(url, { method, headers }, answer => {
        let text = "";
        answer.on("data", chunk => { text += String(chunk); });
        answer.on("end", () => { clearTimeout(timer); done({ ok: true, status: answer.statusCode ?? 0, headers: answer.headers, text }); });
        answer.on("error", error => { clearTimeout(timer); done({ ok: false, reason: `the browser stopped answering (${error.message})` }); });
      });
      const timer = setTimeout(() => { sent.destroy(); done({ ok: false, reason: late }); }, remaining);
      sent.on("error", error => { clearTimeout(timer); done({ ok: false, reason: `the browser stopped answering (${error.message})` }); });
      sent.end(method === "POST" ? JSON.stringify(body) : undefined);
    });
  const request = async (method: string, params: unknown): Promise<Answer> => {
    const id = ++next;
    const sent = await post({ jsonrpc: "2.0", id, method, params });
    if (!sent.ok) return sent;
    const message = messages(sent.text).find(one => one["id"] === id);
    if (message === undefined) return { ok: false, reason: `the browser tool answered ${sent.status}${sent.text.trim() === "" ? "" : `: ${oneLine(sent.text)}`}` };
    const header = sent.headers["mcp-session-id"];
    if (typeof header === "string") session = header;
    return { ok: true, message };
  };
  return {
    start: async () => {
      const hello = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "toolroll-scout-preflight", version: "1" } });
      if (!hello.ok) return hello;
      if (hello.message["error"] !== undefined) return { ok: false, reason: `the browser tool refused to start: ${errorText(hello.message)}` };
      const ready = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      return ready.ok ? { ok: true } : ready;
    },
    call: async (tool, input) => {
      const answer = await request("tools/call", { name: tool, arguments: input });
      if (!answer.ok) return answer;
      const failed = toolFailure(answer.message);
      return failed === null ? { ok: true, result: (answer.message["result"] ?? {}) as Record<string, unknown> } : { ok: false, reason: failed };
    },
    close: async () => {
      // Ending the session closes its browser context.
      if (session !== null) await post({}, "DELETE");
    },
  };
}

/** The JSON-RPC messages in an answer: a plain JSON body, or the data lines of an event stream. */
function messages(text: string): Record<string, unknown>[] {
  const bodies = text.trimStart().startsWith("{") ? [text] : text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5));
  return bodies.flatMap(body => {
    try {
      const parsed = JSON.parse(body) as unknown;
      return typeof parsed === "object" && parsed !== null ? [parsed as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

/** Why a tool call failed, in one line, or null when it worked. */
function toolFailure(answer: Record<string, unknown>): string | null {
  if (answer["error"] !== undefined) return errorText(answer);
  const result = answer["result"] as { isError?: unknown; content?: { text?: unknown }[] } | undefined;
  if (result?.isError !== true) return null;
  const text = result.content?.map(one => (typeof one.text === "string" ? one.text : "")).join("\n") ?? "";
  const line = text.split("\n").map(one => one.replace(/^#+\s*Error\s*$/i, "").replace(/^Error:\s*/, "").replace(/^browserBackend\.callTool:\s*/, "").trim()).find(one => one !== "");
  return oneLine(line ?? "unknown error");
}

function errorText(answer: Record<string, unknown>): string {
  const error = answer["error"] as { message?: unknown } | undefined;
  return oneLine(typeof error?.message === "string" ? error.message : "unknown error");
}

function lastLine(text: string): string {
  return oneLine(text.trim().split("\n").at(-1) ?? "");
}

function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 200);
}

// ---- the launch contract (docs/plans/sandbox-parity.md C4) ----

/** The pinned browser tool, installed once into Toolroll's helpers folder. */
export const SCOUT_BROWSER_PACKAGE = "@playwright/mcp@0.0.82";
const HELPER_NAME = "scout-browser-0.0.82";
/** The names of the worker's environment the browser tool gets: an allowlist, never a denylist. */
export const SCOUT_BROWSER_ENV: readonly string[] = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
  "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];
/** What the run records of the exception it ran under. */
export const SCOUT_BROWSER_CONTAINMENT = "Chrome's sandbox";

/** Where the pinned browser lives under `helpers`. */
export function scoutBrowserHelper(helpers: string): { folder: string; cli: string; browsers: string } {
  const folder = join(helpers, HELPER_NAME);
  return { folder, cli: join(folder, "node_modules", "@playwright", "mcp", "cli.js"), browsers: join(folder, "browsers") };
}

/** The scout's browser tool: the pinned helper, run by Toolroll's own Node, headless, on its bundled Chrome. */
export function scoutBrowserTool(helpers: string): BrowserLaunch {
  return { command: process.execPath, args: [scoutBrowserHelper(helpers).cli, "--headless", "--browser", "chromium"] };
}

/** A folder of Toolroll's own: a real folder (no link at it), this user's, private (0700). */
function privateFolder(path: string): boolean {
  try {
    const held = lstatSync(path);
    return held.isDirectory() && !held.isSymbolicLink() && (process.getuid === undefined || held.uid === process.getuid()) && (held.mode & 0o077) === 0;
  } catch { return false; }
}

const within = (child: string, parent: string): boolean => { const rel = relative(parent, child); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); };

/**
 * Why a browser launch breaks its contract, or null when it holds. Every input it trusts is the plane's: the helpers
 * folder and the proxy come from `options.contract`, never from the launch. The executable must be Toolroll's own
 * Node; the script the pinned helper's, inside a private helpers folder; the arguments exactly the expected ones (no
 * way to switch Chrome's sandbox off, point at another browser or executable, or drop the proxy); the working folder
 * the image folder; the environment only allowlisted names.
 */
export function browserContractProblem(launch: BrowserLaunch, options: BrowserOptions): string | null {
  const contract = options.contract;
  if (contract === undefined) return "the browser has no launch contract";
  const real = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };
  if (real(launch.command) === null || real(launch.command) !== real(process.execPath)) return "the browser isn't run by Toolroll's own Node";
  if (!privateFolder(contract.helpers)) return "Toolroll's helpers folder isn't a private folder of its own";
  const helper = scoutBrowserHelper(contract.helpers);
  const script = launch.args[0] === undefined ? null : real(launch.args[0]);
  const helpers = real(contract.helpers);
  if (script === null || helpers === null || !within(script, helpers) || script !== real(helper.cli)) return "the browser tool isn't the pinned one in Toolroll's helpers folder";
  const expected = [launch.args[0], "--headless", "--browser", "chromium", "--isolated", "--output-dir", options.folder, "--proxy-server", contract.proxy, "--proxy-bypass", "<-loopback>"];
  if (launch.args.length !== expected.length || launch.args.some((one, index) => one !== expected[index])) return "the browser's arguments aren't the contract's (Chrome's sandbox and the scout's proxy stay on)";
  const extra = Object.keys(options.env).filter(name => options.env[name] !== undefined && !SCOUT_BROWSER_ENV.includes(name));
  if (extra.length > 0) return `the browser's environment carries names outside its allowlist (${extra.slice(0, 5).join(", ")})`;
  if (options.env["HTTPS_PROXY"] !== contract.proxy || options.env["HTTP_PROXY"] !== contract.proxy) return "the browser's environment doesn't point at the scout's proxy";
  return null;
}

/** The registry the helper is installed from: pinned, whatever any npm configuration says. */
const NPM_REGISTRY = "https://registry.npmjs.org/";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
/** The pinned lockfile's digest, recorded when the helper is installed and checked before every use. */
export const SCOUT_BROWSER_LOCK_DIGEST = sha256(JSON.stringify(SCOUT_BROWSER_LOCK));

/** The npm of the Node running Toolroll (`lib/node_modules/npm/bin/npm-cli.js` beside it), run by that Node by path:
 * never an `npm` found on PATH. Null where this Node has none beside it (a bundled runtime). */
export function ownNpm(execPath: string = process.execPath): string | null {
  const cli = join(dirname(dirname(execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js");
  try { return realpathSync(cli); } catch { return null; }
}

/**
 * Install the pinned browser into the helpers folder once. The worker runs this outside every fence, so nothing a build
 * could have written may steer it: npm is Toolroll's own Node's, run by path; HOME is the staging folder and the user
 * and global npm configurations are an empty file there (no ~/.npmrc, no global npmrc, no registry, script or Node
 * option from either); the registry is pinned; install scripts never run; `npm ci` installs exactly the pinned lockfile
 * (scout-browser-lock.ts) and refuses a tarball whose integrity differs; the installed versions are checked against it
 * before ready.json is written. The npm cache and Chrome for Testing stay in the folder, never in the user's caches.
 * Residual: Chrome for Testing comes from Playwright's own download over HTTPS, without a pinned hash.
 */
export async function ensureScoutBrowserHelper(helpers: string, timeoutMs = 600_000): Promise<{ ok: true } | { ok: false; reason: string }> {
  const helper = scoutBrowserHelper(helpers);
  if (helperReady(helper.folder)) return { ok: true };
  const npm = ownNpm();
  if (npm === null) return { ok: false, reason: "Toolroll's own Node has no npm beside it, so the pinned browser can't be installed" };
  try { mkdirSync(helpers, { recursive: true, mode: 0o700 }); } catch { /* checked next */ }
  if (!privateFolder(helpers)) return { ok: false, reason: "Toolroll's helpers folder isn't a private folder of its own" };
  const staging = mkdtempSync(join(helpers, ".install-"));
  try {
    writeFileSync(join(staging, "package.json"), JSON.stringify(SCOUT_BROWSER_MANIFEST), { mode: 0o600 });
    writeFileSync(join(staging, "package-lock.json"), JSON.stringify(SCOUT_BROWSER_LOCK), { mode: 0o600 });
    const { env, args } = helperNpm(staging, npm);
    const installed = await run(process.execPath, [...args, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: staging, env, envAllowlist: [], timeoutMs });
    if (installed.code !== 0) return { ok: false, reason: `the pinned browser couldn't be installed (npm exit ${installed.code})` };
    const drift = lockDrift(staging);
    if (drift !== null) return { ok: false, reason: `the installed browser isn't the pinned one (${drift})` };
    const browsers = await run(process.execPath, [join(staging, "node_modules", "playwright", "cli.js"), "install", "chromium"], { cwd: staging, env, envAllowlist: [], timeoutMs });
    if (browsers.code !== 0) return { ok: false, reason: `the pinned browser's Chrome couldn't be installed (exit ${browsers.code})` };
    rmSync(join(staging, "npm-cache"), { recursive: true, force: true });
    writeFileSync(join(staging, "ready.json"), JSON.stringify({ package: SCOUT_BROWSER_PACKAGE, lock: SCOUT_BROWSER_LOCK_DIGEST }), { mode: 0o600 });
    try { renameSync(staging, helper.folder); } catch { if (!helperReady(helper.folder)) return { ok: false, reason: "the pinned browser couldn't be put in place" }; }
    return { ok: true };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** How the helper's npm runs in `staging`: Toolroll's own npm by path, with its home, user and global configuration
 * the staging folder's own empty ones, the registry and cache pinned; the environment only these names. */
export function helperNpm(staging: string, npm: string): { env: Record<string, string>; args: string[] } {
  // Two empty files: npm refuses to load one file as both.
  const user = join(staging, "user.npmrc"), global = join(staging, "global.npmrc");
  for (const file of [user, global]) writeFileSync(file, "", { mode: 0o600 });
  const env = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: staging, PLAYWRIGHT_BROWSERS_PATH: join(staging, "browsers"),
    NPM_CONFIG_USERCONFIG: user, NPM_CONFIG_GLOBALCONFIG: global, npm_config_userconfig: user, npm_config_globalconfig: global,
  };
  return { env, args: [npm, "--no-update-notifier", `--registry=${NPM_REGISTRY}`, "--userconfig", user, "--globalconfig", global, "--cache", join(staging, "npm-cache")] };
}

/** Whether a helper folder holds the pinned install: its ready note names this lockfile, and its tree still matches. */
function helperReady(folder: string): boolean {
  try {
    const ready = JSON.parse(readFileSync(join(folder, "ready.json"), "utf8")) as { lock?: unknown };
    return ready.lock === SCOUT_BROWSER_LOCK_DIGEST && lockDrift(folder) === null;
  } catch { return false; }
}

/** What of an installed tree differs from the pinned lockfile (a package missing or at another version), or null. */
export function lockDrift(folder: string): string | null {
  for (const [path, entry] of Object.entries(SCOUT_BROWSER_LOCK.packages as Record<string, { version?: string }>)) {
    if (path === "" || entry.version === undefined) continue;
    let version: unknown;
    try { version = (JSON.parse(readFileSync(join(folder, path, "package.json"), "utf8")) as { version?: unknown }).version; } catch { version = undefined; }
    if (version !== entry.version) return `${path.replace(/^node_modules\//, "")} is ${typeof version === "string" ? version : "missing"}, pinned ${entry.version}`;
  }
  return null;
}

/** The production starter: the pinned helper in place, then the launch held to its contract, then started. */
export async function startContractedBrowser(launch: BrowserLaunch, options: BrowserOptions): Promise<BrowserStart> {
  if (options.contract === undefined) return { ok: false, reason: "the browser has no launch contract" };
  const installed = await ensureScoutBrowserHelper(options.contract.helpers);
  if (!installed.ok) return installed;
  const env = { ...options.env, PLAYWRIGHT_BROWSERS_PATH: scoutBrowserHelper(options.contract.helpers).browsers };
  const problem = browserContractProblem(launch, { ...options, env: options.env });
  if (problem !== null) return { ok: false, reason: problem };
  return startScoutBrowser(launch, { ...options, env });
}
