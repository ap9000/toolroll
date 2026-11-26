/**
 * Instant start (solo-workbench plan v2, A0b): which coding agents this computer has, whether each is signed in, and
 * which one the first task goes to. Asked on a first run and on demand (`toolroll agents`, the terminal screens, the
 * console's background checks); a page or an engine read only shows the last answer.
 *
 * What is looked at, per agent, and nothing more (cheap, offline, read only; never a model call):
 *
 *   Claude Code   `claude` on PATH; its own `claude auth status --json` (provider-connection.ts, the welcome's check), or
 *                 on an API key, whether a key is set (Toolroll's key file or the key's environment variable)
 *   Codex         `codex` on PATH; its own `codex login status`, or on an API key, whether a key is set
 *   Gemini CLI    `gemini` on PATH; on an API key (Toolroll's default for it), whether a key is set; on its own Google
 *                 login, whether ~/.gemini/oauth_creds.json exists
 *   OpenRouter    whether an OpenRouter key is set, with `codex` on PATH (it runs through Codex); else not set up
 *   OpenCode      `opencode` on PATH (acp-inspect.ts: looked at, never run); whether its auth.json exists
 *   Qwen Code     `qwen` on PATH; whether ~/.qwen/oauth_creds.json exists
 *   Goose         `goose` on PATH; whether its config.yaml exists (written by `goose configure`)
 *   Cursor, Cline on PATH only: no offline sign-in check is known, so their sign-in reads "unknown"
 *
 * A login file is only stat()ed: never opened, so no token is ever read. A status command's output is read only by
 * signInFacts, which keeps fixed words (signed in or not, and how); nothing it printed is kept, shown or logged. Every
 * binary is found through the PATH-only resolvers (attest.ts resolveExecutable, acp-inspect.ts inspectAcpAgent), never
 * by searching install folders. The two status commands run in parallel, each with a short deadline: one that hangs
 * reads "unknown", and the whole answer comes back within about that deadline.
 *
 * The first task (preference order): an agent a person chose in Settings → Models, when it can take tasks now;
 * otherwise Claude Code, then Codex — the two Toolroll can start with no further choice (each has a default set of
 * models, model-choices.ts AGENT_PRESETS). Gemini CLI and OpenRouter need their models chosen first, and an ACP agent
 * needs its one-time check (acp-check.ts) and its models; their lines say so.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { ACP_AGENTS, ACP_PROVIDER_IDS, isAcpProvider, type AcpProviderId } from "./acp-agents.js";
import { inspectAcpAgent } from "./acp-inspect.js";
import { resolveExecutable } from "./attest.js";
import type { ProviderId } from "./contracts/provider.js";
import { excludedFolders, statusBinaryDiagnosis, statusProbe, STATUS_TIMEOUT_MS, type StatusProbeOptions } from "./status-probe.js";
import { platformAcl } from "./trusted-path.js";
import { keyStatus, OWN_KEY_ENV, readAuthMode } from "./keys.js";
import { createConnectionChecker, type ConnectionChecker, type ProviderConnection } from "./provider-connection.js";

/** How long one status command may take before it reads "unknown" (the whole detection stays under about a second). */
export const DETECT_TIMEOUT_MS = STATUS_TIMEOUT_MS;

export type DetectedState = "signed-in" | "signed-out" | "unknown" | "not-installed";

export type DetectedAgent = {
  id: ProviderId;
  name: string;
  state: DetectedState;
  /** How it is signed in, in fixed words ("Claude account", "API key", "login file"); null when it isn't. */
  how: string | null;
  /** What the person runs to sign it in; null when it is signed in or not installed. */
  signIn: string | null;
  /** It can take a task now, with nothing else to choose. */
  ready: boolean;
  /** What it still needs before it takes tasks, in one sentence; null when nothing (or when it isn't installed). */
  next: string | null;
};

export type AgentDetection = {
  agents: DetectedAgent[];
  /** The agent the first task goes to (preference order above), or null when none can take it yet. */
  firstTask: ProviderId | null;
  /** Where builds go when that isn't the pick (DetectOptions.routed), as asked. */
  routed: string | null;
  checkedAt: string;
  /** How long the detection took. */
  tookMs: number;
};

type LoginCheck =
  /** The connection checker: its own status command on a sign-in, key presence on an API key. */
  | { kind: "checker" }
  | { kind: "gemini" }
  | { kind: "key" }
  /** A login file's presence (stat only), from the home folder and environment. */
  | { kind: "file"; path: (home: string, env: Env) => string; how: string }
  | { kind: "none" };

type Env = Readonly<Record<string, string | undefined>>;
type Row = { id: ProviderId; name: string; binary: string; signIn: string; install: string | null; login: LoginCheck };

/** Under an XDG base folder when the environment names an absolute one, else the usual folder in the home. */
const xdg = (env: Env, name: string, home: string, fallback: string): string => {
  const value = env[name];
  return value !== undefined && isAbsolute(value) ? value : join(home, fallback);
};

const ACP_LOGIN: Readonly<Record<AcpProviderId, LoginCheck>> = {
  opencode: { kind: "file", path: (home, env) => join(xdg(env, "XDG_DATA_HOME", home, join(".local", "share")), "opencode", "auth.json"), how: "login file" },
  qwen: { kind: "file", path: home => join(home, ".qwen", "oauth_creds.json"), how: "login file" },
  goose: { kind: "file", path: (home, env) => join(xdg(env, "XDG_CONFIG_HOME", home, ".config"), "goose", "config.yaml"), how: "set up" },
  cursor: { kind: "none" },
  cline: { kind: "none" },
  antigravity: { kind: "file", path: home => join(home, ".gemini", "oauth_creds.json"), how: "Google account" },
};

/** Every agent Toolroll supports, in preference order. */
export const DETECTED_AGENTS: readonly Row[] = [
  { id: "claude", name: "Claude Code", binary: "claude", signIn: "claude auth login", install: "npm install -g @anthropic-ai/claude-code", login: { kind: "checker" } },
  { id: "codex", name: "Codex", binary: "codex", signIn: "codex login", install: "npm install -g @openai/codex", login: { kind: "checker" } },
  { id: "gemini", name: "Gemini CLI", binary: "gemini", signIn: "gemini", install: null, login: { kind: "gemini" } },
  { id: "openrouter", name: "OpenRouter", binary: "codex", signIn: "toolroll keys set openrouter --key-file <file>", install: null, login: { kind: "key" } },
  ...ACP_PROVIDER_IDS.map((id): Row => ({ id, name: ACP_AGENTS[id].name, binary: ACP_AGENTS[id].binary, signIn: ACP_AGENTS[id].signIn, install: null, login: ACP_LOGIN[id] })),
];
/** The agents Toolroll can give a first task with nothing else to choose, in order. */
export const FIRST_TASK_ORDER: readonly ProviderId[] = ["claude", "codex"];
const GEMINI_KEY_SIGN_IN = "toolroll keys set gemini --key-file <file>";
const CHOOSE_MODELS = "To give it tasks, choose its models in Settings → Models.";
const CHOOSE_AGENT = "To give it tasks, choose it in Settings → Models.";

/** A regular, non-empty file is there: stat only, never opened. */
function present(file: string): boolean {
  try { const seen = statSync(file); return seen.isFile() && seen.size > 0; } catch { return false; }
}

/** A key is set for this provider: Toolroll's own key file, or one of the key's environment variables (presence only). */
function keySet(provider: "gemini" | "openrouter", home: string, env: Env): boolean {
  return keyStatus(provider, home).set || OWN_KEY_ENV[provider].some(name => (env[name] ?? "") !== "");
}

const SIGNED_IN: ReadonlySet<ProviderConnection["state"]> = new Set(["connected", "key-present", "key-works"]);
const SIGNED_OUT: ReadonlySet<ProviderConnection["state"]> = new Set(["signed-out", "missing-key", "key-refused"]);
/** Answers the checker gives without running the agent (an API key): whether the agent is installed is the PATH's to say. */
const KEY_ANSWERS: ReadonlySet<ProviderConnection["state"]> = new Set(["key-present", "key-works", "key-refused", "missing-key"]);

export type DetectOptions = {
  env?: Env;
  home?: string;
  /** Claude Code's and Codex's sign-in check (the console passes its own, cached one). */
  check?: ConnectionChecker;
  timeoutMs?: number;
  /** Where a first task's build goes when that isn't up to this detection (welcome-facts.ts firstTaskRouted): the
   * provider chosen in Settings → Models, or the built-in default; null when the first start fills the pick. */
  routed?: string | null;
  /** Whether an ACP agent passed its one-time check on this computer (store.acpAttestationFor). */
  acpChecked?: (provider: AcpProviderId) => boolean;
  /** More folders an agent can write, besides those status-probe.ts always derives from Toolroll's records. */
  untrusted?: () => readonly string[];
  /** Why an agent's install isn't run for its sign-in check, with its repair, in words (a test's stand-in; by default
   * status-probe.ts statusBinaryDiagnosis); null when it is trusted. */
  trustProblem?: (binary: string) => Promise<string | null>;
  /** Toolroll's records those folders come from: the store in hand, or its database file. */
  store?: StatusProbeOptions["store"];
  databaseFile?: string;
  clock?: () => Date;
};

/** Settle with `fallback` once `ms` pass, whatever `work` does. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    work.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

/** Look for every supported agent on this computer, all at once. */
export async function detectAgents(options: DetectOptions = {}): Promise<AgentDetection> {
  const started = Date.now();
  const env = options.env ?? process.env;
  const home = options.home ?? env["HOME"] ?? homedir();
  const timeoutMs = options.timeoutMs ?? DETECT_TIMEOUT_MS;
  const clock = options.clock ?? (() => new Date());
  // Only absolute PATH folders: a relative one would make the answer depend on where this runs.
  const path = (env["PATH"] ?? "").split(delimiter).filter(one => one !== "" && isAbsolute(one)).join(delimiter);
  // The status commands run only from a trusted install outside every project, bounded at the deadline, with an
  // environment built from nothing (status-probe.ts).
  const check = options.check ?? createConnectionChecker({
    home, env: env as NodeJS.ProcessEnv, clock,
    probe: statusProbe({ env, timeoutMs, ...(options.untrusted === undefined ? {} : { untrusted: options.untrusted }),
      ...(options.store === undefined ? {} : { store: options.store }), ...(options.databaseFile === undefined ? {} : { databaseFile: options.databaseFile }) }),
  });
  const routed = options.routed ?? null;

  const one = async (row: Row): Promise<DetectedAgent> => {
    const base = { id: row.id, name: row.name };
    const out = (state: DetectedState, how: string | null = null): DetectedAgent =>
      ({ ...base, state, how, signIn: state === "signed-out" || state === "unknown" ? row.signIn : null, ready: false, next: null });
    if (isAcpProvider(row.id)) {
      if (!inspectAcpAgent(row.id, { PATH: path }).found) return out("not-installed");
      const login = row.login;
      return login.kind === "file" ? present(login.path(home, env)) ? out("signed-in", login.how) : out("signed-out") : out("unknown");
    }
    const resolved = resolveExecutable(row.binary, path);
    // OpenRouter is there when its key is (it runs through Codex, so Codex must be too); without either, it isn't set up.
    if (row.login.kind === "key") return resolved !== null && keySet("openrouter", home, env) ? out("signed-in", "API key") : out("not-installed");
    if (row.login.kind === "gemini") {
      if (resolved === null) return out("not-installed");
      if (readAuthMode("gemini", home) === "api-key") return keySet("gemini", home, env) ? out("signed-in", "API key") : { ...out("signed-out"), signIn: GEMINI_KEY_SIGN_IN };
      return present(join(home, ".gemini", "oauth_creds.json")) ? out("signed-in", "Google account") : out("signed-out");
    }
    // Claude Code and Codex: their own status command, or key presence on an API key.
    const answer = await within(check(row.id).then(value => value as ProviderConnection | null), timeoutMs, null);
    /** Unknown: with why Toolroll won't run its status command, and the repair, when its install fails the trust check. */
    const unknown = async (): Promise<DetectedAgent> => {
      const why = await (options.trustProblem ?? defaultTrustProblem)(row.binary);
      return why === null ? out("unknown") : { ...out("unknown"), next: why };
    };
    const defaultTrustProblem = async (binary: string): Promise<string | null> => {
      const untrusted = await excludedFolders({ store: options.store, databaseFile: options.databaseFile }, options.untrusted?.() ?? []);
      if (untrusted === null) return null;
      return agentTrustWords(statusBinaryDiagnosis(binary, { path, uid: process.getuid?.(), untrusted, acl: platformAcl() }));
    };
    if (answer === null) return resolved === null ? out("not-installed") : unknown();
    if (answer.state === "not-installed" || (KEY_ANSWERS.has(answer.state) && resolved === null)) return out("not-installed");
    if (answer.launchIssue === "command-not-found") return { ...out("unknown"), next: "The status command exited with code 127. Check that the agent and its helpers are on Toolroll's trusted PATH." };
    if (SIGNED_IN.has(answer.state)) return out("signed-in", KEY_ANSWERS.has(answer.state) ? "API key" : answer.method ?? "signed in");
    return SIGNED_OUT.has(answer.state) ? out("signed-out") : unknown();
  };

  const seen = await Promise.all(DETECTED_AGENTS.map(row => one(row).catch(() => ({ id: row.id, name: row.name, state: "unknown" as const, how: null, signIn: row.signIn, ready: false, next: null }))));
  const agents = seen.map(agent => withNext(agent, routed, options.acpChecked));
  return { agents, firstTask: firstTaskOf(agents, routed), routed, checkedAt: clock().toISOString(), tookMs: Date.now() - started };
}

/** Whether it can take a task now, and what it still needs otherwise. */
export function withNext(agent: DetectedAgent, routed: string | null, acpChecked?: (provider: AcpProviderId) => boolean): DetectedAgent {
  if (agent.state === "not-installed") return agent;
  // Claude Code and Codex take tasks once signed in, unless another agent was chosen for builds.
  if (FIRST_TASK_ORDER.includes(agent.id)) {
    const ready = agent.state === "signed-in" && (routed === null || routed === agent.id);
    return { ...agent, ready, next: agent.state === "signed-in" && !ready ? CHOOSE_AGENT : agent.next };
  }
  if (isAcpProvider(agent.id)) {
    const checked = acpChecked?.(agent.id) ?? false;
    const ready = checked && routed === agent.id && agent.state !== "signed-out";
    const next = ready ? null : !checked ? `To give it tasks, check it once: run \`toolroll agents check ${agent.id} --model <model>\`.` : routed !== agent.id ? CHOOSE_MODELS : null;
    return { ...agent, ready, next };
  }
  const ready = agent.state === "signed-in" && routed === agent.id;
  return { ...agent, ready, next: ready ? null : CHOOSE_MODELS };
}

/** The agent a first task goes to: the one its build is routed to when it can take tasks now (none, when it can't: the
 * task would wait for it), else the first of Claude Code and Codex that is signed in. */
export function firstTaskOf(agents: readonly Pick<DetectedAgent, "id" | "ready">[], routed: string | null): ProviderId | null {
  if (routed !== null) return agents.find(one => one.id === routed && one.ready)?.id ?? null;
  for (const id of FIRST_TASK_ORDER) if (agents.some(one => one.id === id && one.ready)) return id;
  return null;
}

/** What a person who doesn't see this computer's agents (server/welcome.ts agentInventoryOf) reads when none can take
 * tasks yet. */
export const NO_AGENT_YET = "No coding agent can take tasks on this computer yet.";

/** The fields a line needs (a detected agent, or a welcome row). */
export type AgentLineRow = Pick<DetectedAgent, "id" | "name" | "state" | "signIn" | "next">;

const nameOf = (id: string): string => DETECTED_AGENTS.find(one => one.id === id)?.name ?? id;

/**
 * The first run's lines about agents, the same on every screen (the terminal workbench, the classic screen, the web's
 * welcome, `toolroll agents`, `toolroll welcome`): who the first task goes to; else one "Sign in to <Agent>: run …" line
 * per installed agent (and what a signed-in one still needs); else how to install one.
 */
export function firstRunAgentLines(rows: readonly AgentLineRow[], firstTask: string | null, checking = false, routed: string | null = null): string[] {
  if (firstTask !== null) return [`Your first task goes to ${nameOf(firstTask)}.`];
  if (checking) return ["Looking for agents on this computer…"];
  const installed = rows.filter(one => one.state !== "not-installed");
  const install = ["Install one:", ...DETECTED_AGENTS.filter(one => one.install !== null).map(one => `  ${one.name}: run \`${one.install} && ${one.signIn}\``)];
  if (installed.length === 0) return install;
  const lines: string[] = [];
  // Tasks go to an agent that isn't here (chosen in Settings → Models, or the built-in default): said first.
  const target = routed === null ? null : DETECTED_AGENTS.find(one => one.id === routed) ?? null;
  if (target !== null && !installed.some(one => one.id === target.id)) {
    lines.push(`Your tasks go to ${target.name}, which isn't installed here.${target.install === null ? "" : ` Install it: run \`${target.install} && ${target.signIn}\``}`);
  }
  for (const one of installed) {
    if (one.state === "signed-in") { if (one.next !== null) lines.push(`${one.name} is signed in. ${one.next}`); continue; }
    if (one.state === "unknown" && one.next !== null && FIRST_TASK_ORDER.includes(one.id)) { lines.push(`${one.name}: ${one.next}`); continue; }
    if (one.signIn !== null) lines.push(`Sign in to ${one.name}: run \`${one.signIn}\`${one.state === "unknown" ? " (its sign-in couldn't be checked)" : ""}`);
  }
  return lines.length > 0 ? lines : install;
}

/** The lines for a detection: firstRunAgentLines over its agents. */
export function detectionLines(detection: AgentDetection | null): string[] {
  return detection === null ? firstRunAgentLines([], null, true) : firstRunAgentLines(detection.agents, detection.firstTask, false, detection.routed);
}

const STATE_WORDS: Readonly<Record<DetectedState, string>> = { "signed-in": "signed in", "signed-out": "not signed in", unknown: "installed, sign-in unknown", "not-installed": "not installed" };

/** `toolroll agents`: every agent and its state, then the first-run lines. */
export function detectionReport(detection: AgentDetection): string[] {
  const width = Math.max(...detection.agents.map(one => one.name.length));
  return [
    "Agents on this computer",
    ...detection.agents.map(one => `  ${one.name.padEnd(width)}  ${STATE_WORDS[one.state]}${one.state === "signed-in" && one.how !== null ? ` (${one.how})` : ""}`),
    "",
    ...detectionLines(detection),
  ];
}

// ---- Adding an agent (the terminal workbench's Agents screen) --------------------------------------------------------

/** One command Toolroll may run for a person in a terminal pane: a program found as a trusted install on PATH
 * (status-probe.ts resolveStatusBinary) and arguments that are Toolroll's own constants. */
export type AgentCommand = { binary: string; args: readonly string[] };

/**
 * How each agent is added, all Toolroll's own constants (never text from the agent, a page or the environment):
 *
 * - `install`: the exact install command shown. `installRun`: the same command as a program and arguments, when it may
 *   run in a pane after the person's confirm (npm installs only; a `curl … | bash` installer is shown, never run here).
 * - `signIn` / `signInRun`: the agent's OWN sign-in, run in a pane: the provider's browser sign-in opens as usual and the
 *   credential goes into the agent's own files; Toolroll never reads it.
 * - `key`: an agent that runs on a key Toolroll stores (Gemini on an API key, OpenRouter): what to set and where.
 * - `check`: an ACP agent's one-time check, shown to run (the console has no route that runs it).
 * - `note`: anything else the person should know, in one sentence.
 */
export type AgentSetup = {
  install: string | null;
  installRun: AgentCommand | null;
  signIn: string | null;
  signInRun: AgentCommand | null;
  key: string | null;
  check: string | null;
  note: string | null;
};

const npm = (pkg: string): { install: string; installRun: AgentCommand } => ({ install: `npm install -g ${pkg}`, installRun: { binary: "npm", args: ["install", "-g", pkg] } });
const ACP_CHECK = (id: string): string => `toolroll agents check ${id} --model <model>`;

export const AGENT_SETUP: Readonly<Record<ProviderId, AgentSetup>> = Object.freeze({
  claude: { ...npm("@anthropic-ai/claude-code"), signIn: "claude auth login", signInRun: { binary: "claude", args: ["auth", "login"] }, key: null, check: null,
    note: "Flexible threads (off for now) need `claude setup-token`." },
  codex: { ...npm("@openai/codex"), signIn: "codex login", signInRun: { binary: "codex", args: ["login"] }, key: null, check: null, note: null },
  gemini: { ...npm("@google/gemini-cli"), signIn: "gemini", signInRun: { binary: "gemini", args: [] },
    key: "Or run it on an API key: switch it with `toolroll keys auth gemini api-key`, then pipe the key in with `toolroll keys set gemini < key.txt` (or paste it in Settings → Agents in the browser).", check: null,
    note: "Its sign-in starts Gemini CLI: choose Login with Google, finish in the browser, then type /quit." },
  openrouter: { install: null, installRun: null, signIn: null, signInRun: null,
    key: "It runs on an OpenRouter key through Codex: pipe the key in with `toolroll keys set openrouter < key.txt` (or paste it in Settings → Agents in the browser), then choose its models.", check: null,
    note: "Install Codex first: OpenRouter runs through it." },
  opencode: { ...npm("opencode-ai"), signIn: ACP_AGENTS.opencode.signIn, signInRun: { binary: "opencode", args: ["auth", "login"] }, key: null, check: ACP_CHECK("opencode"), note: null },
  cursor: { install: "curl https://cursor.com/install -fsS | bash", installRun: null, signIn: ACP_AGENTS.cursor.signIn, signInRun: { binary: "cursor-agent", args: ["login"] }, key: null, check: ACP_CHECK("cursor"), note: null },
  cline: { ...npm("cline"), signIn: ACP_AGENTS.cline.signIn, signInRun: { binary: "cline", args: ["auth"] }, key: null, check: ACP_CHECK("cline"), note: null },
  qwen: { ...npm("@qwen-code/qwen-code"), signIn: ACP_AGENTS.qwen.signIn, signInRun: { binary: "qwen", args: [] }, key: null, check: ACP_CHECK("qwen"),
    note: "Its sign-in starts Qwen Code: type /auth and finish in the browser, then /quit." },
  goose: { install: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash", installRun: null, signIn: ACP_AGENTS.goose.signIn,
    signInRun: { binary: "goose", args: ["configure"] }, key: null, check: ACP_CHECK("goose"), note: null },
  antigravity: { install: null, installRun: null, signIn: ACP_AGENTS.antigravity.signIn,
    signInRun: { binary: "agy", args: ["acp", "--login"] }, key: null, check: ACP_CHECK("antigravity"),
    note: "Uses your Google account through Antigravity ACP (`agy acp`). Run `agy install` if `agy` is not on PATH." },
});

/** An agent's setup, or null for an id Toolroll doesn't support. */
export function agentSetupOf(id: string): AgentSetup | null {
  return Object.prototype.hasOwnProperty.call(AGENT_SETUP, id) ? AGENT_SETUP[id as ProviderId] : null;
}

/** Where npm would fetch `pkg` from, as the person's own `~/.npmrc` says (an install's confirm says it), mirroring npm's
 * rule: for a scoped package (`@openai/codex`) the last `@scope:registry=` line wins; otherwise, and for an unscoped
 * package, the last `registry=` line. Only those lines are read (never a token or any other line), and only a URL's
 * scheme, host and path are kept. `unsure`: the file does something this doesn't follow (an environment variable
 * `${…}`, a key it can't read, a value that isn't an http(s) URL): the confirm then says it may set another registry.
 * Null url and not unsure: the public registry. */
export function npmRegistryOf(home: string, pkg: string): { url: string | null; unsure: boolean } {
  const file = join(home, ".npmrc");
  try {
    const seen = statSync(file);
    if (!seen.isFile() || seen.size > 64 * 1024) return { url: null, unsure: seen.isFile() };
  } catch { return { url: null, unsure: false }; }
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return { url: null, unsure: true }; }
  const scope = pkg.startsWith("@") ? pkg.split("/")[0]! : null;
  let scoped: string | null = null, plain: string | null = null, unsure = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim(), value = line.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    const isRegistry = key === "registry" || /^@[^:]+:registry$/.test(key);
    if (!isRegistry) { if (/registry/i.test(key) && !key.startsWith("//")) unsure = true; continue; }
    if (value.includes("${")) { unsure = true; continue; }
    if (key === "registry") plain = value;
    else if (scope !== null && key === `${scope}:registry`) scoped = value;
  }
  const chosen = scoped ?? plain;
  if (chosen === null) return { url: null, unsure };
  let url: URL;
  try { url = new URL(chosen); } catch { return { url: null, unsure: true }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { url: null, unsure: true };
  if (url.hostname === "registry.npmjs.org") return { url: null, unsure };
  return { url: `${url.protocol}//${url.host}${url.pathname}`.replace(/[\u0000-\u001f\u007f]/g, ""), unsure };
}

/** An agent install that fails its trust check, in one sentence with its repair (status-probe.ts statusBinaryDiagnosis). */
export function agentTrustWords(diagnosis: { why: string; repair: import("./trust-repair.js").TrustRepair | null } | null): string | null {
  if (diagnosis === null) return null;
  const commands = diagnosis.repair?.commands ?? [];
  const fix = commands.length > 0 ? ` Fix it: run ${commands.map(one => `\`${one}\``).join(", then ")}, then \`toolroll agents\` to check again.`
    : " Reinstall it into a folder only you can change.";
  return `Toolroll won't run its sign-in check: ${diagnosis.why}.${fix}`;
}
