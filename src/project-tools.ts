/**
 * Project tools (v80): the MCP servers one project's builds may use.
 *
 * A project's list REPLACES everything else a build could load: the
 * operator's global Claude and Codex MCP servers, plugins' servers and a
 * repository's own `.mcp.json` are all shut out, and each build gets
 * exactly the servers its project lists — sealed at approval, so a tool
 * added later reaches only work approved after it, while a tool removed
 * leaves every build at once. Reviewers and the lead chat never get tools.
 *
 * Secret values (API keys, tokens, any env value) never enter the
 * database, a chat, a card or a log: they live in the operating system's
 * keychain (tool-secret-store.ts) or, where there is none, in one 0600 file
 * per tool in `tool-secrets` beside the database (files kept before under
 * ~/.toolroll/tool-secrets/, or an older name's, move in on first use).
 * They are written only from the console's password-gated screen, read when a
 * run starts, and reach only that run's tool broker (tool-broker.ts), which
 * gives them to the project's server processes and sign-in headers — never to
 * the agent. A tool connected by signing in gives a run only an access token
 * of its own (oauth-run-token.ts).
 */
import { toolRefusal } from "./policy.js";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanForSecrets } from "./evidence.js";
import type { Store, ToolActionInfo } from "./store.js";
import { namedPath } from "./names.js";
import { startToolBroker, type BrokerOptions, type ToolBroker } from "./tool-broker.js";
import { SecretStoreError, destroyOwnFile, prepareSecretFolder, registerSecretFolder, pathIn, readOwnFile, readSealed, removeValue, secretBackend, secretFolder, secretStorage, serviceOf, withSecretLock, withSecretLockAsync, writeOwnFile, writeSealed, type SecretBackend, type SecretFolder, type SecretItem, type SecretStoreKind } from "./tool-secret-store.js";
import { ACCESS, GRANTED, REFRESH, mintRunToken, mintsRunTokens, oneAtATime, runScope, scopeList, signedIn } from "./oauth-run-token.js";
import { HEADER_NAME, SECRET_NAME, TOOL_NAME as NAME, TOOL_SPEC_LIMITS as LIMITS, readToolSpec, type ToolSecret, type ToolSpec } from "./contracts/integration-metadata.js";

export type { ToolSecret, ToolSpec };

export type ToolTest = { at: string; ok: boolean; tools: string[]; problem: string | null };

export type ProjectTool = {
  id: number;
  repo: string;
  name: string;
  spec: ToolSpec;
  digest: string;
  source: string;
  createdAt: string;
  createdBy: string;
  lastTest: ToolTest | null;
};

/** A tool resolved for one launch: its spec and the secret values it gets. */
export type ResolvedTool = { spec: ToolSpec; digest: string; values: Record<string, string> };

/** Env names a tool may never claim: the process's own plumbing, every
 * provider credential, and anything that changes how a program or its
 * interpreter loads (a secret's value must stay data, never code). */
const RESERVED_ENV_NAMES = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TERM", "PWD", "IFS", "ENV", "BASH_ENV", "PS4", "PROMPT_COMMAND",
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NPM_CONFIG_PREFIX", "NPM_CONFIG_USERCONFIG", "GCONV_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "DOTNET_STARTUP_HOOKS",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "MCP_TIMEOUT"]);
const RESERVED_ENV_PREFIX = /^(LD_|DYLD_|PYTHON|PERL5|PERLLIB|RUBY|GIT_|NODE_|NPM_CONFIG_|BUN_|DENO_|UV_|PIP_|LC_|XDG_|CLAUDE_|CODEX_|ANTHROPIC_|OPENAI_)/;
const RESERVED_ENV = { has: (name: string): boolean => RESERVED_ENV_NAMES.has(name) || RESERVED_ENV_PREFIX.test(name) };

/** Common servers, pinned to exact versions: the lead suggests from here first. */
export const TOOL_CATALOG: readonly (ToolSpec & { label: string })[] = [
  { label: "Playwright", name: "playwright", transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@0.0.82", "--headless"], url: null, secrets: [], bearer: null, headerSecrets: {},
    about: "Drives a real browser to open pages, click through them and take screenshots." },
  { label: "Chrome DevTools", name: "chrome-devtools", transport: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@1.10.1", "--headless", "--isolated"], url: null, secrets: [], bearer: null, headerSecrets: {},
    about: "Inspects pages in Chrome: console errors, network requests and performance." },
  { label: "Context7", name: "context7", transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@4.1.1"], url: null, secrets: [{ name: "CONTEXT7_API_KEY", optional: true }], bearer: null, headerSecrets: {},
    about: "Looks up current documentation for libraries and frameworks." },
  { label: "shadcn/ui", name: "shadcn", transport: "stdio", command: "npx", args: ["-y", "shadcn@4.21.0", "mcp"], url: null, secrets: [], bearer: null, headerSecrets: {},
    about: "Browses and adds shadcn/ui components." },
  { label: "GitHub", name: "github", transport: "http", command: null, args: [], url: "https://api.githubcopilot.com/mcp/", secrets: [{ name: "GITHUB_TOKEN", optional: false }], bearer: "GITHUB_TOKEN", headerSecrets: {},
    about: "Reads and manages GitHub issues, pull requests and code." },
  { label: "Sentry", name: "sentry", transport: "stdio", command: "npx", args: ["-y", "@sentry/mcp-server@0.39.0"], url: null, secrets: [{ name: "SENTRY_ACCESS_TOKEN", optional: false }], bearer: null, headerSecrets: {},
    about: "Reads Sentry issues and errors." },
  { label: "Supabase (read-only)", name: "supabase", transport: "stdio", command: "npx", args: ["-y", "@supabase/mcp-server-supabase@0.13.0", "--read-only"], url: null, secrets: [{ name: "SUPABASE_ACCESS_TOKEN", optional: false }], bearer: null, headerSecrets: {},
    about: "Reads Supabase tables and schema, without changing anything." },
  // Figma's Dev Mode server, run by its desktop app on this computer and signed in as the app is: no key.
  { label: "Figma (desktop app)", name: "figma-desktop", transport: "http", command: null, args: [], url: "http://127.0.0.1:3845/mcp", secrets: [], bearer: null, headerSecrets: {},
    about: "Code, images, variables and metadata from what you select in the Figma desktop app." },
];

/**
 * Apps that serve their own MCP on this computer: Connect adds them like a
 * common tool (`connect` is its one line of how), a test that can't reach one
 * says why (`offline`), and research may read what `reads` names (see
 * readsOnly in mcp-connect.ts). The only loopback address research reaches.
 */
export type LocalApp = { tool: string; connect: string; offline: string; reads: readonly string[] };
export const LOCAL_APPS: readonly LocalApp[] = [
  { tool: "figma-desktop", connect: "Open the Figma desktop app, turn on the Dev Mode MCP server in Preferences, then Connect.",
    offline: "The Figma desktop app isn't running, or its Dev Mode MCP server is off. Open Figma and turn the server on in Preferences.",
    reads: ["code", "image", "screenshot", "variable", "defs", "metadata", "design", "context", "connect", "map", "figjam"] },
];
/** The local app a project's tool is, when it is one exactly as listed (same name and address). */
export function localAppOf(spec: Pick<ToolSpec, "name" | "url">): LocalApp | null {
  const app = LOCAL_APPS.find(one => one.tool === spec.name);
  return app !== undefined && spec.url !== null && spec.url === catalogTool(app.tool)?.url ? app : null;
}

export function catalogTool(id: string): (ToolSpec & { label: string }) | null {
  return TOOL_CATALOG.find(one => one.name === id) ?? null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What a build is held to: how the server starts and which secrets it names — never their values or its description. */
export function toolDigest(spec: ToolSpec): string {
  const { about: _about, ...terms } = spec;
  return createHash("sha256").update(`standing-orders:tool:v1:${canonical(terms)}`, "utf8").digest("hex").slice(0, 32);
}

const str = (value: unknown, cap: number, what: string): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > cap) throw new Error(`${what} is required, up to ${cap} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${what} cannot contain control characters.`);
  return value.trim();
};

/**
 * A tool definition from any source (catalog, console form, the lead, an import, a saved row), checked whole and made
 * the spec its schema (src/contracts/integration-metadata.ts) says. Throws in plain words.
 */
export function validateToolSpec(input: Record<string, unknown>): ToolSpec {
  const name = str(input["name"], LIMITS.name, "A short name").toLowerCase();
  if (!NAME.test(name)) throw new Error(`The name is lowercase letters, numbers, - and _ (up to ${LIMITS.name}), starting with a letter or number.`);
  const transport = input["transport"] === "http" ? "http" : input["transport"] === "stdio" || input["transport"] === undefined ? "stdio" : null;
  if (transport === null) throw new Error("A tool runs as a local program or at a web address.");
  const secretsIn = Array.isArray(input["secrets"]) ? input["secrets"] : [];
  if (secretsIn.length > LIMITS.secrets) throw new Error(`A tool can name up to ${LIMITS.secrets} secrets.`);
  const secrets: ToolSecret[] = [];
  for (const one of secretsIn) {
    const entry = typeof one === "string" ? { name: one, optional: false } : one as Record<string, unknown>;
    const secretName = typeof entry["name"] === "string" ? entry["name"] : "";
    if (!SECRET_NAME.test(secretName)) throw new Error("Secret names are UPPER_CASE letters, numbers and _.");
    if (RESERVED_ENV.has(secretName)) throw new Error(`${secretName} is reserved; choose another secret name.`);
    if (secrets.some(s => s.name === secretName)) continue;
    secrets.push({ name: secretName, optional: entry["optional"] === true });
  }
  let command: string | null = null, args: string[] = [], url: string | null = null, bearer: string | null = null;
  const headerSecrets: Record<string, string> = {};
  if (transport === "stdio") {
    command = str(input["command"], LIMITS.command, "The command");
    const argsIn = input["args"] === undefined ? [] : input["args"];
    if (!Array.isArray(argsIn) || argsIn.length > LIMITS.args || argsIn.some(arg => typeof arg !== "string" || arg.length > LIMITS.arg || /[\u0000-\u001f\u007f]/.test(arg))) throw new Error(`Arguments are up to ${LIMITS.args} plain words.`);
    args = argsIn as string[];
  } else {
    url = str(input["url"], LIMITS.url, "The address");
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("The address is not a web address."); }
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) throw new Error("A web tool needs an https address.");
    if (parsed.username !== "" || parsed.password !== "") throw new Error("Put credentials in a secret, not in the address.");
    if (input["bearer"] != null) {
      if (typeof input["bearer"] !== "string" || !secrets.some(s => s.name === input["bearer"])) throw new Error("The sign-in token must be one of the tool's secrets.");
      bearer = input["bearer"];
    }
    const headersIn = (input["headerSecrets"] ?? {}) as Record<string, unknown>;
    for (const [header, secret] of Object.entries(headersIn)) {
      if (!HEADER_NAME.test(header) || typeof secret !== "string" || !secrets.some(s => s.name === secret)) throw new Error("Each header must name one of the tool's secrets.");
      if (header.toLowerCase() === "authorization" && bearer !== null) throw new Error("Use either a sign-in token or an Authorization header, not both.");
      headerSecrets[header] = secret;
    }
  }
  const about = typeof input["about"] === "string" && input["about"].trim() !== "" ? input["about"].trim().slice(0, LIMITS.about)
    : TOOL_CATALOG.find(one => one.name === name)?.about
      ?? (transport === "http" ? `Tools from ${new URL(url!).hostname}.` : `Tools from ${programName(command!, args)}.`);
  const spec: ToolSpec = { name, transport, command, args, url, secrets, bearer, headerSecrets, about };
  // Values belong in the secret store; a key typed into a command, argument or address is refused.
  if (scanForSecrets([command ?? "", ...args, url ?? "", about].join("\n")).length > 0) throw new Error("That looks like a key or token in the tool's settings. Name it as a secret instead; its value is set on the secure Tools screen.");
  const checked = readToolSpec(spec);
  if (!checked.ok) throw new Error(`That tool is not valid: ${checked.issues.map(issue => issue.line).join("; ")}`);
  return checked.value;
}

/** What a local tool is, in a word: the package a runner like npx starts, else the program's own name. */
function programName(command: string, args: readonly string[]): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  const runner = ["npx", "bunx", "uvx", "pnpx", "pipx"].includes(base);
  const target = runner ? args.find(arg => !arg.startsWith("-")) : undefined;
  return target === undefined ? base : target.replace(/@[^@/]*$/, "") || target;
}

/** How the tool starts, in one line a person can check. Never a secret value. */
export function toolCommandLine(spec: ToolSpec): string {
  if (spec.transport === "http") return `${spec.url}${spec.bearer === null ? "" : ` (signs in with ${spec.bearer})`}`;
  return [spec.command, ...spec.args].map(part => /^[A-Za-z0-9@%+=:,./_-]+$/.test(part ?? "") ? part : JSON.stringify(part)).join(" ");
}

// ---- secrets -----------------------------------------------------------------

/**
 * Where tool secrets were kept before (an existing ~/.toolroll/tool-secrets, or an older name's), read once when
 * Toolroll starts so their files move in on first use. Never where new secrets go.
 */
export function legacyToolSecretsDir(home: string = homedir()): string | null {
  const found = namedPath(home, ["tool-secrets"], { dot: true });
  return existsSync(found) ? found : null;
}

/** Commands that can start builds or serve the console: Toolroll's folder for secrets is made before any build runs. */
export const SECRETS_FIRST: ReadonlySet<string> = new Set(["serve", "up", "daemon", "watch", "worker", "tick", "build", "run", "reconcile", "bridge"]);

/**
 * Toolroll's folder for the secrets it holds, beside `databaseFile`, checked against the sealing key the database
 * recorded: made now when `eager` (a command that can start builds), else the first time a secret is used.
 * A folder that can't be used is said in Settings and `toolroll integrations`; every secret is refused until then.
 */
export function startToolSecrets(store: Pick<Store, "toolSecretKeyDigest" | "swapToolSecretKeyDigest">, databaseFile: string, clock: () => Date, options: { eager: boolean }): void {
  const anchor = { read: () => store.toolSecretKeyDigest(), swap: (expected: string | null, next: string) => store.swapToolSecretKeyDigest(expected, next, clock()) };
  const state = dirname(databaseFile), legacy = legacyToolSecretsDir();
  if (options.eager) prepareSecretFolder(state, anchor, { standing: true, legacy });
  else registerSecretFolder(state, anchor, { legacy });
}

/** Toolroll's folder for secrets (tool-secret-store.ts): beside the database Toolroll started with, or a test's `state`. */
export function toolSecretsDir(state?: string): string {
  return secretFolder(state).dir;
}

const repoHash = (repo: string) => createHash("sha256").update(repo).digest("hex").slice(0, 16);
const toolName = (tool: string) => { if (!NAME.test(tool)) throw new Error("Choose a tool by its name."); return tool; };
/** A tool's own file in the folder: its secrets where there's no keychain, or the names of those set. */
const toolFile = (folder: SecretFolder, repo: string, tool: string, suffix: string, make = false) => pathIn(folder.dir, [repoHash(repo), `${toolName(tool)}${suffix}`], { make });
/** The same tool's file where secrets were kept before Toolroll's folder; null when there was none. */
const legacyFile = (folder: SecretFolder, repo: string, tool: string) => folder.legacy === null ? null : pathIn(folder.legacy, [repoHash(repo), `${toolName(tool)}.json`]);

/** A tool's keychain item: this Toolroll's folder and the project, hashed, and the tool's name. Never a secret. */
const secretItem = (folder: SecretFolder, repo: string, tool: string): SecretItem => ({ service: serviceOf(folder), account: `${repoHash(repo)}.${toolName(tool)}` });

const secretValues = (parsed: unknown): Record<string, string> => parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ? {}
  : Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => SECRET_NAME.test(entry[0]) && typeof entry[1] === "string"));
const parsedValues = (text: string): Record<string, string> => {
  try { return secretValues(JSON.parse(text)); } catch { throw new SecretStoreError("A tool's stored secrets are damaged."); }
};

/** A secrets file (owner-only, never through a link); null when there is none. */
function readSecretFile(file: string): Record<string, string> | null {
  const text = readOwnFile(file);
  return text === null ? null : parsedValues(text);
}

/** What the current store holds for a tool: its keychain item, or (no keychain) its file in Toolroll's folder; null when nothing. */
function readStored(backend: SecretBackend | null, folder: SecretFolder, repo: string, tool: string): Record<string, string> | null {
  if (backend === null) return readSecretFile(toolFile(folder, repo, tool, ".json"));
  const text = readSealed(backend, folder, secretItem(folder, repo, tool));
  return text === null ? null : parsedValues(text);
}

function writeStored(backend: SecretBackend | null, folder: SecretFolder, repo: string, tool: string, values: Record<string, string>, options: { create?: boolean } = {}): "ok" | "exists" {
  if (backend !== null) {
    const item = secretItem(folder, repo, tool);
    if (Object.keys(values).length === 0) { removeValue(backend, item); return "ok"; }
    return writeSealed(backend, folder, item, JSON.stringify(values), options);
  }
  const file = toolFile(folder, repo, tool, ".json", true);
  if (Object.keys(values).length === 0) destroyOwnFile(file);
  else writeOwnFile(file, JSON.stringify(values));
  return "ok";
}

/** One change to a tool's secrets at a time, across Toolroll's processes, re-entrant within one. */
const withToolLock = <T>(folder: SecretFolder, repo: string, tool: string, work: () => T): T => withSecretLock(folder, `${repoHash(repo)}.${toolName(tool)}`, work);

/** The names of a tool's secrets that have a value, kept beside them so a page never reads a value to say so. */
function writeNames(folder: SecretFolder, repo: string, tool: string, names: readonly string[]): void {
  const file = toolFile(folder, repo, tool, ".names.json", true);
  if (names.length === 0) rmSync(file, { force: true });
  else writeOwnFile(file, JSON.stringify([...names].sort()));
}

/**
 * A tool's secrets moved into the current store from where they were kept before — the old home folder, or (now that
 * there is a keychain) its file in Toolroll's folder — the first time they are used: stored, read back and compared,
 * and only then is the file destroyed. What the store already holds (an earlier move, or a change since) wins over
 * the file. A failure leaves the file as it was, and says so.
 */
function moveIn(backend: SecretBackend | null, folder: SecretFolder, repo: string, tool: string): void {
  const sources = [legacyFile(folder, repo, tool), backend === null ? null : toolFile(folder, repo, tool, ".json")].filter((one): one is string => one !== null && existsSync(one));
  if (sources.length === 0) return;
  withToolLock(folder, repo, tool, () => {
    for (const file of sources) {
      // Damaged, a link, or not plainly Toolroll's: kept as it is, and never used.
      let values: Record<string, string> | null;
      try { values = readSecretFile(file); } catch { values = null; }
      if (values === null) continue;
      if (Object.keys(values).length > 0 && readStored(backend, folder, repo, tool) === null) {
        if (writeStored(backend, folder, repo, tool, values, { create: true }) === "ok") {
          let back: Record<string, string> | null = null;
          try { back = readStored(backend, folder, repo, tool); } catch { back = null; }
          if (back === null || JSON.stringify(back) !== JSON.stringify(values)) {
            try { if (backend !== null) removeValue(backend, secretItem(folder, repo, tool)); } catch { /* the file stays the copy that counts */ }
            throw new SecretStoreError("A tool's secrets couldn't be moved to the keychain; they stay in their file until they can.");
          }
        }
      }
      const kept = readStored(backend, folder, repo, tool) ?? {};
      writeNames(folder, repo, tool, Object.keys(kept));
      destroyOwnFile(file);
    }
  });
}

/** A tool's secret values. Read only to test it, change it or start a run: a page reads which are set (secretsSetFor). */
export function readToolSecrets(repo: string, tool: string, state?: string): Record<string, string> {
  const folder = secretFolder(state);
  const backend = secretBackend();
  moveIn(backend, folder, repo, tool);
  return readStored(backend, folder, repo, tool) ?? {};
}

/** Set (or, with an empty value, clear) one secret of one tool. */
export function setToolSecret(repo: string, tool: string, name: string, value: string, state?: string): void {
  setToolSecrets(repo, tool, { [name]: value }, state);
}

/** Set (or, with empty values, clear) some secrets of one tool, in one change. */
export function setToolSecrets(repo: string, tool: string, values: Record<string, string>, state?: string): void {
  for (const [name, value] of Object.entries(values)) {
    if (!SECRET_NAME.test(name) || RESERVED_ENV.has(name)) throw new Error("Choose one of the tool's secrets.");
    if (value.length > 8_192 || /[\u0000\r\n]/.test(value)) throw new Error("A secret is one line, up to 8,192 characters.");
  }
  const folder = secretFolder(state);
  withToolLock(folder, repo, tool, () => {
    const current = readToolSecrets(repo, tool, state);
    for (const [name, value] of Object.entries(values)) {
      if (value === "") delete current[name];
      else current[name] = value;
    }
    writeStored(secretBackend(), folder, repo, tool, current);
    writeNames(folder, repo, tool, Object.keys(current));
  });
}

export function clearToolSecrets(repo: string, tool: string, state?: string): void {
  const folder = secretFolder(state);
  withToolLock(folder, repo, tool, () => {
    const backend = secretBackend();
    if (backend !== null) removeValue(backend, secretItem(folder, repo, tool));
    for (const file of [toolFile(folder, repo, tool, ".json"), legacyFile(folder, repo, tool)]) if (file !== null && existsSync(file)) destroyOwnFile(file);
    rmSync(toolFile(folder, repo, tool, ".names.json"), { force: true });
  });
}

/**
 * One renewal of a sign-in at a time, across Toolroll's processes (a lock in its folder) and within one: a service
 * that rotates its refresh token on every use would otherwise see the same one twice, and whichever answer was saved
 * last would be the newest only by luck.
 */
export function renewingSignIn<T>(repo: string, tool: string, state: string | undefined, work: () => Promise<T>): Promise<T> {
  const folder = secretFolder(state);
  return oneAtATime(`${folder.root}\0${repo}\0${tool}`, () => withSecretLockAsync(folder, `${repoHash(repo)}.${toolName(tool)}.renew`, work));
}

/** Required secrets with no value yet: the tool is left out of builds until they are set. */
export function missingSecrets(spec: ToolSpec, values: Record<string, string>): string[] {
  return spec.secrets.filter(one => !one.optional && (values[one.name] ?? "") === "").map(one => one.name);
}

// ---- found on this computer ------------------------------------------------------

/** A server already configured on this computer, ready to add to a project (values moved, never shown). */
export type FoundTool = { spec: ToolSpec; source: string; values: Record<string, string> };

const envName = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^[^A-Z]+/, "") || "SECRET";

function fromClaudeEntry(name: string, raw: unknown, source: string): FoundTool | null {
  if (raw === null || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const type = typeof entry["type"] === "string" ? entry["type"] : typeof entry["command"] === "string" ? "stdio" : typeof entry["url"] === "string" ? "http" : "";
  const values: Record<string, string> = {};
  const secrets: ToolSecret[] = [];
  const keep = (secret: string, value: unknown) => {
    if (typeof value !== "string" || !SECRET_NAME.test(secret) || RESERVED_ENV.has(secret)) return false;
    values[secret] = value;
    if (!secrets.some(one => one.name === secret)) secrets.push({ name: secret, optional: false });
    return true;
  };
  try {
    if (type === "stdio") {
      for (const [key, value] of Object.entries((entry["env"] ?? {}) as Record<string, unknown>)) keep(key, value);
      const spec = validateToolSpec({ name: name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, LIMITS.name), transport: "stdio", command: entry["command"], args: entry["args"] ?? [], secrets });
      return { spec, source, values };
    }
    if (type === "http") {
      let bearer: string | null = null;
      const headerSecrets: Record<string, string> = {};
      for (const [header, value] of Object.entries((entry["headers"] ?? {}) as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        const bearerValue = header.toLowerCase() === "authorization" ? /^Bearer\s+(.+)$/i.exec(value)?.[1] : undefined;
        const secret = envName(`${name}_${bearerValue !== undefined ? "token" : header}`);
        if (bearerValue !== undefined) { if (keep(secret, bearerValue)) bearer = secret; }
        else if (keep(secret, value)) headerSecrets[header] = secret;
      }
      const spec = validateToolSpec({ name: name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, LIMITS.name), transport: "http", url: entry["url"], secrets, bearer, headerSecrets });
      return { spec, source, values };
    }
  } catch {
    return null;
  }
  return null;
}

function fromCodexEntry(raw: unknown, environment: NodeJS.ProcessEnv): FoundTool | null {
  if (raw === null || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const name = typeof entry["name"] === "string" ? entry["name"] : "";
  const transport = (entry["transport"] ?? {}) as Record<string, unknown>;
  const values: Record<string, string> = {};
  const secrets: ToolSecret[] = [];
  const keep = (secret: string, value: unknown) => {
    if (typeof value !== "string" || value === "" || !SECRET_NAME.test(secret) || RESERVED_ENV.has(secret)) return false;
    values[secret] = value;
    if (!secrets.some(one => one.name === secret)) secrets.push({ name: secret, optional: false });
    return true;
  };
  try {
    if (transport["type"] === "stdio") {
      for (const [key, value] of Object.entries((transport["env"] ?? {}) as Record<string, unknown>)) keep(key, value);
      for (const key of Array.isArray(transport["env_vars"]) ? transport["env_vars"] : []) if (typeof key === "string") keep(key, environment[key]);
      let command = typeof transport["command"] === "string" ? transport["command"] : "";
      const cwd = typeof transport["cwd"] === "string" ? transport["cwd"] : null;
      if (!isAbsolute(command) && command.includes("/") && cwd !== null && isAbsolute(cwd)) command = join(cwd, command);
      const spec = validateToolSpec({ name: name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, LIMITS.name), transport: "stdio", command, args: transport["args"] ?? [], secrets });
      return { spec, source: "Codex on this computer", values };
    }
    if (transport["type"] === "streamable_http") {
      let bearer: string | null = null;
      const headerSecrets: Record<string, string> = {};
      const bearerName = typeof transport["bearer_token_env_var"] === "string" ? transport["bearer_token_env_var"] : null;
      if (bearerName !== null && keep(bearerName, environment[bearerName])) bearer = bearerName;
      for (const [header, env] of Object.entries((transport["env_http_headers"] ?? {}) as Record<string, unknown>)) if (typeof env === "string" && keep(env, environment[env])) headerSecrets[header] = env;
      for (const [header, value] of Object.entries((transport["http_headers"] ?? {}) as Record<string, unknown>)) {
        const secret = envName(`${name}_${header}`);
        if (keep(secret, value)) headerSecrets[header] = secret;
      }
      const spec = validateToolSpec({ name: name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, LIMITS.name), transport: "http", url: transport["url"], secrets, bearer, headerSecrets });
      return { spec, source: "Codex on this computer", values };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The MCP servers this computer already configures for a project: the
 * repository's `.mcp.json`, Claude's global and per-project servers, and
 * Codex's (from `codex mcp list --json`, passed in). The first of each
 * name wins; unusable entries are left out.
 */
export function discoverTools(repo: string, codexServers: unknown[] | null, home: string = homedir(), environment: NodeJS.ProcessEnv = process.env): FoundTool[] {
  const found: FoundTool[] = [];
  const add = (one: FoundTool | null) => { if (one !== null && !found.some(other => other.spec.name === one.spec.name)) found.push(one); };
  const readJson = (file: string): Record<string, unknown> | null => {
    try { const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown; return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : null; } catch { return null; }
  };
  const project = readJson(join(repo, ".mcp.json"));
  for (const [name, raw] of Object.entries((project?.["mcpServers"] ?? {}) as Record<string, unknown>)) add(fromClaudeEntry(name, raw, "this project's .mcp.json"));
  const claude = readJson(join(home, ".claude.json"));
  const perProject = ((claude?.["projects"] ?? {}) as Record<string, Record<string, unknown>>)[repo]?.["mcpServers"] ?? {};
  for (const [name, raw] of Object.entries(perProject as Record<string, unknown>)) add(fromClaudeEntry(name, raw, "Claude for this project"));
  for (const [name, raw] of Object.entries((claude?.["mcpServers"] ?? {}) as Record<string, unknown>)) add(fromClaudeEntry(name, raw, "Claude on this computer"));
  for (const raw of codexServers ?? []) add(fromCodexEntry(raw, environment));
  return found;
}

// ---- the Test button --------------------------------------------------------------

const PROTOCOL = "2025-06-18";
const initialize = (id: number) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "toolroll", version: "1" } } });

function toolNames(result: unknown): string[] {
  const tools = (result as { tools?: unknown } | null)?.tools;
  return Array.isArray(tools) ? tools.map(one => (one as { name?: unknown }).name).filter((name): name is string => typeof name === "string").slice(0, 200) : [];
}

type McpRequest = { method: string; params: unknown; doing: string };
type McpAnswer = { ok: true; result: unknown } | { ok: false; problem: string };

/** Start the server once, ask for its tools, and stop it: the proof a build can use it. */
export async function testTool(spec: ToolSpec, values: Record<string, string>, options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; omitEnv?: readonly string[] } = {}): Promise<{ ok: true; tools: string[] } | { ok: false; problem: string }> {
  const answer = await exchange(spec, values, { method: "tools/list", params: {}, doing: "listing its tools" }, options);
  return answer.ok ? { ok: true, tools: toolNames(answer.result) } : answer;
}

/**
 * Start the server once and read what each of its tools does (v94): the name,
 * its description, what input it takes, and whether it says it only reads.
 * A subagent is offered these, each under its own rule.
 */
export async function listProjectToolActions(spec: ToolSpec, values: Record<string, string>, options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; omitEnv?: readonly string[] } = {}): Promise<{ ok: true; actions: ToolActionInfo[] } | { ok: false; problem: string }> {
  const answer = await exchange(spec, values, { method: "tools/list", params: {}, doing: "listing its tools" }, options);
  return answer.ok ? { ok: true, actions: toolActions(answer.result) } : answer;
}

export function toolActions(result: unknown): ToolActionInfo[] {
  const tools = (result as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap(raw => {
    const one = raw as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
    if (typeof one.name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(one.name)) return [];
    const input = one.inputSchema !== null && typeof one.inputSchema === "object" && !Array.isArray(one.inputSchema) && JSON.stringify(one.inputSchema).length <= 8000 ? one.inputSchema as Record<string, unknown> : null;
    return [{ name: one.name, about: typeof one.description === "string" ? safeLine(one.description).slice(0, 300) : "", input, readOnly: one.annotations?.readOnlyHint === true }];
  }).slice(0, 100);
}

export type ToolCall = { ok: true; text: string; isError: boolean } | { ok: false; problem: string };

/**
 * Start the server once, call one of its tools, and stop it (v87): a flow's
 * "Use a tool" step. The answer's text parts are kept; a tool that says it
 * failed (isError) is an answer, not trouble reaching it.
 */
export async function callProjectTool(spec: ToolSpec, values: Record<string, string>, name: string, args: Record<string, unknown>, options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; omitEnv?: readonly string[] } = {}): Promise<ToolCall> {
  const answer = await exchange(spec, values, { method: "tools/call", params: { name, arguments: args }, doing: `using ${name}` }, options);
  if (!answer.ok) return answer;
  const result = (answer.result ?? {}) as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts.map(part => (part as { type?: unknown; text?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? String((part as { text: string }).text) : "").filter(Boolean).join("\n")
    || (result.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent));
  return { ok: true, text, isError: result.isError === true };
}

function exchange(spec: ToolSpec, values: Record<string, string>, request: McpRequest, options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; omitEnv?: readonly string[] }): Promise<McpAnswer> {
  const missing = missingSecrets(spec, values);
  if (missing.length > 0) return Promise.resolve({ ok: false, problem: `Set ${missing.join(", ")} first.` });
  const timeoutMs = options.timeoutMs ?? 60_000;
  return spec.transport === "http" ? exchangeHttp(spec, values, timeoutMs, request) : exchangeStdio(spec, values, timeoutMs, options.env ?? process.env, options.omitEnv ?? [], request);
}

function exchangeStdio(spec: ToolSpec, values: Record<string, string>, timeoutMs: number, base: NodeJS.ProcessEnv, omit: readonly string[], request: McpRequest): Promise<McpAnswer> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = { ...base };
    for (const name of omit) delete env[name];
    Object.assign(env, values);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command!, spec.args, { env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      resolve({ ok: false, problem: `It could not start: ${error instanceof Error ? error.message : "unknown error"}.` });
      return;
    }
    let settled = false, buffer = "", stderr = "";
    const finish = (outcome: McpAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* already gone */ }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ ok: false, problem: `It did not answer within ${Math.round(timeoutMs / 1000)} seconds.` }), timeoutMs);
    const send = (message: unknown) => { try { child.stdin?.write(`${JSON.stringify(message)}\n`); } catch { /* the exit handler reports */ } };
    child.on("error", error => finish({ ok: false, problem: `It could not start: ${error.message}.` }));
    child.on("exit", code => finish({ ok: false, problem: `It stopped before ${request.doing} (exit ${code ?? "signal"})${stderr.trim() === "" ? "" : `: ${safeLine(stderr)}`}.` }));
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2_000); });
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try { message = JSON.parse(line) as typeof message; } catch { continue; }
        if (message.id === 1) {
          if (message.error !== undefined) { finish({ ok: false, problem: `It refused to start a session: ${safeLine(String(message.error.message ?? "error"))}.` }); return; }
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: request.method, params: request.params });
        } else if (message.id === 2) {
          if (message.error !== undefined) finish({ ok: false, problem: `It refused ${request.doing}: ${safeLine(String(message.error.message ?? "error"))}.` });
          else finish({ ok: true, result: message.result });
        }
      }
    });
    send(initialize(1));
  });
}

async function exchangeHttp(spec: ToolSpec, values: Record<string, string>, timeoutMs: number, request: McpRequest): Promise<McpAnswer> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL };
  if (spec.bearer !== null && values[spec.bearer]) headers["authorization"] = `Bearer ${values[spec.bearer]}`;
  for (const [header, secret] of Object.entries(spec.headerSecrets)) if (values[secret]) headers[header] = values[secret]!;
  const signal = AbortSignal.timeout(timeoutMs);
  const call = async (body: unknown, session: string | null): Promise<{ status: number; session: string | null; message: { result?: unknown; error?: { message?: unknown } } | null }> => {
    const response = await fetch(spec.url!, { method: "POST", headers: { ...headers, ...(session === null ? {} : { "mcp-session-id": session }) }, body: JSON.stringify(body), signal });
    const text = (await response.text()).slice(0, 2_000_000);
    const json = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).find(line => line.startsWith("{")) ?? ""
      : text;
    let message = null;
    try { message = json === "" ? null : JSON.parse(json) as { result?: unknown; error?: { message?: unknown } }; } catch { message = null; }
    return { status: response.status, session: response.headers.get("mcp-session-id") ?? session, message };
  };
  try {
    const opened = await call(initialize(1), null);
    if (opened.status === 401 || opened.status === 403) return { ok: false, problem: "It refused the sign-in. Check the secret's value." };
    if (opened.status >= 400 || opened.message === null) return { ok: false, problem: `It did not start a session (HTTP ${opened.status}).` };
    if (opened.message.error !== undefined) return { ok: false, problem: `It refused to start a session: ${safeLine(String(opened.message.error.message ?? "error"))}.` };
    await fetch(spec.url!, { method: "POST", headers: { ...headers, ...(opened.session === null ? {} : { "mcp-session-id": opened.session }) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal }).then(r => r.body?.cancel()).catch(() => undefined);
    const answered = await call({ jsonrpc: "2.0", id: 2, method: request.method, params: request.params }, opened.session);
    if (answered.message === null) return { ok: false, problem: `It did not answer ${request.doing} (HTTP ${answered.status}).` };
    if (answered.message.error !== undefined) return { ok: false, problem: `It refused ${request.doing}: ${safeLine(String(answered.message.error.message ?? "error"))}.` };
    return { ok: true, result: answered.message.result };
  } catch (error) {
    return { ok: false, problem: error instanceof Error && error.name === "TimeoutError" ? `It did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : localAppOf(spec)?.offline ?? "It could not be reached." };
  }
}

/** One line of a server's own words, never a secret. */
function safeLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return scanForSecrets(line).length > 0 ? "(its message was withheld: it looked like a secret)" : line;
}

// ---- launch ------------------------------------------------------------------------

/** The exact servers one launch gets, and those left out with why (`repo`: the project, from the run's record). */
export type ToolLaunch = { tools: ResolvedTool[]; skipped: { name: string; reason: string }[]; repo?: string };

/** Everything a provider spawn needs to use exactly these tools, and the
 * cleanup. `privateDir` holds the run's launch files, which name the broker
 * and its token, never a tool's secret (tool-broker.ts). */
export type ToolLaunchArgs = { argv: string[]; env: Record<string, string>; omitEnv: string[]; cleanup: () => void; privateDir?: string; serverPids?: () => number[] };

const toml = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const tomlList = (values: readonly string[]): string => `[${values.map(toml).join(",")}]`;

/** How a launch's tools are offered: research steps' servers only their read-only actions. */
export type ToolLaunchOptions = { broker?: BrokerOptions; enabledTools?: Readonly<Record<string, readonly string[]>> };

/** The launch's broker, holding its tools' values; the agent gets only its address and token. */
function brokerFor(launch: ToolLaunch, options: ToolLaunchOptions): Promise<ToolBroker> {
  return startToolBroker(launch.tools.map(tool => ({ spec: tool.spec, values: tool.values, ...(options.enabledTools?.[tool.spec.name] === undefined ? {} : { actions: options.enabledTools[tool.spec.name]! }) })), options.broker);
}

/** A private 0700 folder for one launch's files, and its cleanup with the broker's. */
function launchFolder(broker: ToolBroker | null): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "so-tools-"));
  chmodSync(dir, 0o700);
  return { dir, cleanup: () => { broker?.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * Claude: only these servers, in a private 0600 file removed after the run
 * (the provider adds `--strict-mcp-config`). Each is the broker's address
 * with this launch's token: Claude and its shell share one sandbox, so the
 * file holds nothing a tool signs in with.
 */
export async function claudeToolArgs(launch: ToolLaunch, options: ToolLaunchOptions = {}): Promise<ToolLaunchArgs> {
  const broker = launch.tools.length === 0 ? null : await brokerFor(launch, options);
  const servers: Record<string, unknown> = {};
  for (const tool of launch.tools) servers[tool.spec.name] = { type: "http", url: broker!.url(tool.spec.name), headers: { Authorization: `Bearer ${broker!.token}` } };
  const { dir, cleanup } = launchFolder(broker);
  const file = join(dir, "mcp.json");
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return {
    argv: ["--mcp-config", file],
    // A first `npx` download can take longer than the default start-up wait.
    env: launch.tools.length > 0 ? { MCP_TIMEOUT: "60000" } : {},
    omitEnv: [],
    cleanup,
    privateDir: dir,
    ...(broker === null ? {} : { serverPids: broker.pids }),
  };
}

/** Where the tool launcher lives beside this module, built. */
export function toolLauncherPath(): string {
  return fileURLToPath(new URL("./tool-launcher.js", import.meta.url));
}

/** The secret name a launch file gives the broker's token. */
const BROKER_TOKEN = "TOOLROLL_TOOL_TOKEN";

/**
 * Codex: each tool is named by `-c` and started through the launcher, which
 * relays it to the launch's broker. The operator's config.toml, rules, apps,
 * plugins and hooks are already off (the provider's
 * CODEX_BUILD_ISOLATION_ARGV), and nothing of config.toml is carried. Codex
 * gives its own environment to the agent's shell whatever its policy says,
 * so nothing rides it: the launch files name the broker and its token, and
 * the folder holding them is fenced from the agent.
 */
export async function codexToolArgs(launch: ToolLaunch, options: ToolLaunchOptions & { launcher?: string; node?: string } = {}): Promise<ToolLaunchArgs> {
  const argv: string[] = [];
  if (launch.tools.length === 0) return { argv, env: {}, omitEnv: [], cleanup: () => undefined };
  const broker = await brokerFor(launch, options);
  const { dir, cleanup } = launchFolder(broker);
  const launcher = options.launcher ?? toolLauncherPath();
  const node = options.node ?? process.execPath;
  for (const tool of launch.tools) {
    const file = join(dir, `${tool.spec.name}.json`);
    const relay: ToolSpec = { ...tool.spec, transport: "http", command: null, args: [], url: broker.url(tool.spec.name), secrets: [{ name: BROKER_TOKEN, optional: false }], bearer: BROKER_TOKEN, headerSecrets: {} };
    writeFileSync(file, JSON.stringify({ spec: relay, values: { [BROKER_TOKEN]: broker.token } }), { mode: 0o600 });
    const key = `mcp_servers.${tool.spec.name}`;
    argv.push(
      "-c", `${key}.command=${toml(node)}`,
      "-c", `${key}.args=${tomlList([launcher, file])}`,
      "-c", `${key}.startup_timeout_sec=60`,
      // Adding a tool to a project is the operator's yes to its calls: an unattended build has no one to ask.
      "-c", `${key}.default_tools_approval_mode="approve"`,
    );
    // A research step's server offers only its read-only actions.
    const enabled = options.enabledTools?.[tool.spec.name];
    if (enabled !== undefined) argv.push("-c", `${key}.enabled_tools=${tomlList(enabled)}`);
  }
  return { argv, env: {}, omitEnv: [], cleanup, privateDir: dir, serverPids: broker.pids };
}

/** Gemini: no way yet to hand it exactly these servers, so it gets none. */
export const GEMINI_NO_TOOLS_ARGV: readonly string[] = ["--allowed-mcp-server-names", "standing-orders-none"];

// ---- a project's tools, read and resolved -------------------------------------------

type ToolRows = Pick<Store, "projectTools">;

/** The project's active tools with their parsed definitions and last test. */
export function projectToolsOf(store: ToolRows, repo: string): ProjectTool[] {
  return store.projectTools(repo).flatMap(row => {
    try {
      const spec = validateToolSpec(JSON.parse(row.specJson) as Record<string, unknown>);
      let lastTest: ToolTest | null = null;
      try { lastTest = row.lastTestJson === null ? null : JSON.parse(row.lastTestJson) as ToolTest; } catch { lastTest = null; }
      return [{ id: row.id, repo: row.repo, name: row.name, spec, digest: row.digest, source: row.source, createdAt: row.createdAt, createdBy: row.createdBy, lastTest }];
    } catch {
      return [];
    }
  });
}

/**
 * The exact tools one attempt launches with: the project's active tools,
 * limited to those its approval saw (a task approved before tools were
 * sealed gets today's list), each with every required secret set. What is
 * left out says why, in words the task page can show.
 */
export function toolLaunchFor(store: Pick<Store, "projectTools" | "getRun" | "refById" | "getScope" | "toolSealFor" | "orgPolicy">, runId: number, home?: string): ToolLaunch {
  const run = store.getRun(runId);
  const ref = run === null ? null : store.refById(run.taskRef);
  if (ref === null || ref.repo === null) return { tools: [], skipped: [] };
  const approved = store.getScope(ref.externalId)?.approvedDigest ?? null;
  const seal = approved === null ? null : store.toolSealFor(ref.externalId, approved);
  const launch: ToolLaunch = { tools: [], skipped: [], repo: ref.repo };
  const claimed = new Map<string, string>();
  const policy = store.orgPolicy();
  for (const tool of projectToolsOf(store, ref.repo)) {
    // Sprint 8: a tool the organisation policy doesn't allow is left out, and the run says why.
    const disallowed = toolRefusal(policy, tool.name);
    if (disallowed !== null) { launch.skipped.push({ name: tool.name, reason: disallowed }); continue; }
    if (seal !== null && !seal.some(one => one.name === tool.name && one.digest === tool.digest)) {
      launch.skipped.push({ name: tool.name, reason: "added or changed after this task was approved; approve it again to use it" });
      continue;
    }
    const values = readToolSecrets(ref.repo, tool.name, home);
    const missing = missingSecrets(tool.spec, values);
    if (missing.length > 0) { launch.skipped.push({ name: tool.name, reason: `needs ${missing.join(", ")} set on the Tools page` }); continue; }
    // A tool connected by signing in launches with its access token alone: its refresh token, client and the rest
    // stay in the store, and a run that renews gets an access token of its own (prepareRunTools).
    const kept = signedIn(tool.spec) ? { [ACCESS]: values[ACCESS]! }
      : Object.fromEntries(tool.spec.secrets.filter(one => (values[one.name] ?? "") !== "").map(one => [one.name, values[one.name]!]));
    const clash = Object.entries(kept).find(([name, value]) => claimed.has(name) && claimed.get(name) !== value);
    if (clash !== undefined) { launch.skipped.push({ name: tool.name, reason: `uses ${clash[0]} with a different value than another tool` }); continue; }
    for (const [name, value] of Object.entries(kept)) claimed.set(name, value);
    launch.tools.push({ spec: tool.spec, digest: tool.digest, values: kept });
  }
  return launch;
}

/**
 * One attempt's tools, ready for its provider, and recorded on the run:
 * what it launched with and what was left out and why. The caller spawns
 * with `argv`/`env` and calls `cleanup` when the process is done.
 */
export async function prepareRunTools(
  store: Pick<Store, "projectTools" | "getRun" | "refById" | "getScope" | "toolSealFor" | "recordRunTools" | "orgPolicy">,
  runId: number,
  provider: "claude" | "codex" | "openrouter" | "gemini",
  options: { home?: string; now: Date; readOnly?: Readonly<Record<string, readonly string[]>>; withheld?: Readonly<Record<string, string>>; broker?: BrokerOptions; fetcher?: typeof fetch },
): Promise<ToolLaunchArgs> {
  const launch = limitedTo(toolLaunchFor(store, runId, options.home), options.readOnly, options.withheld);
  // Codex's filesystem policy cannot deny KERN_PROCARGS2. Its command
  // sandbox can inspect an external stdio server's environment, so do not
  // start secret-bearing servers there (OpenRouter uses the same harness).
  if (provider === "codex" || provider === "openrouter") {
    launch.tools = launch.tools.filter(one => {
      if (one.spec.transport === "http" || Object.keys(one.values).length === 0) return true;
      launch.skipped.push({ name: one.spec.name, reason: "This tool needs a Claude build to protect its sign-in details." });
      return false;
    });
  }
  const revokes = provider === "gemini" ? [] : await signInRun(launch, { readOnly: options.readOnly !== undefined, now: options.now, ...(options.home === undefined ? {} : { home: options.home }), ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }) });
  const revoke = () => Promise.all(revokes.splice(0).map(one => one())).then(() => undefined);
  const offered: ToolLaunchOptions = { ...(options.readOnly === undefined ? {} : { enabledTools: options.readOnly }), ...(options.broker === undefined ? {} : { broker: options.broker }) };
  let launched: ToolLaunchArgs;
  try {
    launched = provider === "claude" ? await claudeToolArgs(launch, offered)
      : provider === "codex" || provider === "openrouter" ? await codexToolArgs(launch, offered)
          : { argv: [...GEMINI_NO_TOOLS_ARGV], env: {}, omitEnv: [], cleanup: () => undefined };
  } catch (error) {
    // Tokens were made for a run that won't start: each is revoked, and the run with them.
    if (revokes.length === 0) throw error;
    await revoke();
    throw new RunSignInError("This run's tools couldn't be prepared, so it didn't start; the sign-ins made for it were revoked.");
  }
  // The run's own sign-ins end with it: the broker closes first, so nothing uses a token as it is revoked.
  const prepared: ToolLaunchArgs = revokes.length === 0 ? launched : { ...launched, cleanup: () => { launched.cleanup(); void revoke(); } };
  const skipped = provider === "gemini"
    ? [...launch.skipped, ...launch.tools.map(one => ({ name: one.spec.name, reason: "Gemini builds can't use project tools yet" }))]
    : launch.skipped;
  try {
    store.recordRunTools(runId, JSON.stringify({
      provider,
      tools: provider === "gemini" ? [] : launch.tools.map(one => ({ name: one.spec.name, digest: one.digest })),
      skipped,
    }), options.now);
  } catch (error) {
    launched.cleanup();
    await revoke();
    throw revokes.length === 0 ? error : new RunSignInError("This run's tools couldn't be recorded, so it didn't start; the sign-ins made for it were revoked.");
  }
  return prepared;
}

/** A run whose sign-ins couldn't all be made and kept: it doesn't start, and every token made for it is revoked. */
export class RunSignInError extends Error {}

/**
 * Each signed-in tool's own access token for this run (oauth-run-token.ts), read and renewed here, outside the fence,
 * one renewal at a time across Toolroll's processes. A rotated refresh token is saved before the run is let in; when
 * it can't be, or anything else fails once a token is made, every token made for this run is revoked, the saved
 * sign-in is left as it was, and the run doesn't start (RunSignInError). Only the new access token joins the launch.
 * A tool that can't be signed in is left out, saying why. Returns how to revoke the run's tokens.
 */
async function signInRun(launch: ToolLaunch, options: { readOnly: boolean; now: Date; home?: string; fetcher?: typeof fetch }): Promise<(() => Promise<void>)[]> {
  const repo = launch.repo;
  const revokes: (() => Promise<void>)[] = [];
  if (repo === undefined) return revokes;
  const kept: ResolvedTool[] = [];
  try {
    for (const tool of launch.tools) {
      if (!signedIn(tool.spec)) { kept.push(tool); continue; }
      const minted = await renewingSignIn(repo, tool.spec.name, options.home, async () => {
        const values = readToolSecrets(repo, tool.spec.name, options.home);
        // No refresh token: the one access token the sign-in gave stays in the broker, like a key.
        if (!mintsRunTokens(values)) return { ok: true as const, token: null };
        const scope = runScope(scopeList(values[GRANTED]), options.readOnly);
        const answer = await mintRunToken(values, { scope, now: options.now, ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }) });
        if (answer.ok && answer.token.revoke !== null) revokes.push(answer.token.revoke);
        if (answer.ok && answer.token.rotated !== null) {
          try { setToolSecrets(repo, tool.spec.name, { [REFRESH]: answer.token.rotated }, options.home); }
          catch { throw new RunSignInError(`${tool.spec.name}'s renewed sign-in couldn't be saved, so this run didn't start. Check that the keychain is unlocked, then try again.`); }
        }
        return answer;
      });
      if (!minted.ok) { launch.skipped.push({ name: tool.spec.name, reason: minted.reason }); continue; }
      if (minted.token === null) { kept.push(tool); continue; }
      kept.push({ ...tool, values: { [ACCESS]: minted.token.access } });
    }
  } catch (error) {
    await Promise.all(revokes.splice(0).map(one => one()));
    if (error instanceof RunSignInError) throw error;
    throw new RunSignInError("A tool's sign-in couldn't be made for this run, so it didn't start. Check that the keychain is unlocked, then try again.");
  }
  launch.tools = kept;
  return revokes;
}

/** A research step's launch: only the servers it may read, each limited to its read-only actions; the rest left out, saying why (`withheld`, when a service has its own reason). */
function limitedTo(launch: ToolLaunch, readOnly: Readonly<Record<string, readonly string[]>> | undefined, withheld: Readonly<Record<string, string>> = {}): ToolLaunch {
  if (readOnly === undefined) return launch;
  const readable = (name: string) => (readOnly[name] ?? []).length > 0;
  return {
    ...launch,
    tools: launch.tools.filter(one => readable(one.spec.name)),
    skipped: [...launch.skipped, ...launch.tools.filter(one => !readable(one.spec.name)).map(one => ({ name: one.spec.name, reason: withheld[one.spec.name] ?? "research reads only connected services' read-only actions" }))],
  };
}

/** When a launch's tools cannot be prepared, it still gets none of anything else's: the same isolation with an empty list. */
export function noToolsArgs(provider: "claude" | "codex" | "openrouter" | "gemini"): ToolLaunchArgs {
  if (provider === "claude") return { argv: ["--mcp-config", '{"mcpServers":{}}'], env: {}, omitEnv: [], cleanup: () => undefined };
  if (provider === "gemini") return { argv: [...GEMINI_NO_TOOLS_ARGV], env: {}, omitEnv: [], cleanup: () => undefined };
  return { argv: [], env: {}, omitEnv: [], cleanup: () => undefined };
}

// ---- changing a project's tools (console and the lead share these) ------------------------

type ToolWrites = Pick<Store, "projectTools" | "addProjectTool" | "removeProjectTool" | "recordProjectToolTest">;

/** Add one tool (and, for an import, the values it brings) to a project's builds. */
export function addToolTo(store: ToolWrites, repo: string, input: ToolSpec, source: string, by: string, now: Date, options: { values?: Record<string, string>; home?: string | undefined } = {}): { ok: true; spec: ToolSpec } | { ok: false; message: string } {
  let spec: ToolSpec;
  try { spec = validateToolSpec(input as unknown as Record<string, unknown>); } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "That tool is not valid." }; }
  if (!store.addProjectTool({ repo, name: spec.name, specJson: JSON.stringify(spec), digest: toolDigest(spec), source: source.slice(0, 120), by }, now)) {
    return { ok: false, message: `This project already has a tool called ${spec.name}. Remove it first to replace it.` };
  }
  const values = Object.fromEntries(Object.entries(options.values ?? {}).filter(([name, value]) => spec.secrets.some(one => one.name === name) && value !== ""));
  try {
    clearToolSecrets(repo, spec.name, options.home);
    if (Object.keys(values).length > 0) setToolSecrets(repo, spec.name, values, options.home);
  } catch {
    return { ok: true, spec };
  }
  return { ok: true, spec };
}

/** Take one tool away from every build now, with its stored secrets. */
export function removeToolFrom(store: ToolWrites, repo: string, name: string, by: string, now: Date, home?: string): boolean {
  if (!store.removeProjectTool(repo, name, by, now)) return false;
  try { clearToolSecrets(repo, name, home); } catch { /* the row is gone; an orphan file is never read */ }
  return true;
}

/** Test one tool of a project and keep the answer on it. */
export async function testToolOf(store: ToolWrites, repo: string, name: string, now: Date, options: { home?: string | undefined; timeoutMs?: number; omitEnv?: readonly string[] } = {}): Promise<ToolTest | null> {
  const tool = projectToolsOf(store, repo).find(one => one.name === name);
  if (tool === undefined) return null;
  const outcome = await testTool(tool.spec, readToolSecrets(repo, name, options.home), { ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.omitEnv === undefined ? {} : { omitEnv: options.omitEnv }) });
  const test: ToolTest = outcome.ok ? { at: now.toISOString(), ok: true, tools: outcome.tools, problem: null } : { at: now.toISOString(), ok: false, tools: [], problem: outcome.problem };
  store.recordProjectToolTest(repo, name, JSON.stringify(test));
  return test;
}

/** Where a tool stands, in a few words: what a person reads first. */
export function toolStanding(tool: ProjectTool, secretsSet: readonly string[]): { ready: boolean; words: string } {
  const missing = tool.spec.secrets.filter(one => !one.optional && !secretsSet.includes(one.name)).map(one => one.name);
  if (missing.length > 0) return { ready: false, words: `Needs ${missing.join(", ")}` };
  if (tool.lastTest === null) return { ready: true, words: "Not tested yet" };
  if (!tool.lastTest.ok) return { ready: false, words: "Last test failed" };
  return { ready: true, words: `Working · ${tool.lastTest.tools.length} tool${tool.lastTest.tools.length === 1 ? "" : "s"}` };
}

/** How a tool's runs get its credentials, in the words Settings and `toolroll integrations` share. */
export type CredentialMode = { mode: "run-token" | "held-key" | "no-key"; words: string; detail: string | null };
export const CREDENTIAL_MODES: Readonly<Record<CredentialMode["mode"], Omit<CredentialMode, "mode">>> = {
  "run-token": { words: "Short-lived token per run", detail: "Each run gets its own access token when it starts, revoked or left to expire when it ends. The refresh token stays with Toolroll." },
  "held-key": { words: "Key held by Toolroll", detail: "Runs reach this tool through Toolroll, which adds the key. The key never enters a build." },
  "no-key": { words: "No key needed", detail: null },
};
/** A tool's credential mode from the names of its secrets that are set (never their values); null while a key it needs is missing. */
export function credentialModeOf(spec: ToolSpec, secretsSet: readonly string[]): CredentialMode | null {
  const mode = spec.secrets.every(one => one.optional && !secretsSet.includes(one.name)) ? "no-key" as const
    : signedIn(spec) && mintsRunTokens(secretsSet) ? "run-token" as const
      : spec.secrets.some(one => !one.optional && !secretsSet.includes(one.name)) ? null
        : "held-key" as const;
  return mode === null ? null : { mode, ...CREDENTIAL_MODES[mode] };
}

/** Names of a tool's secrets that have a value, never the values: in the keychain, from the names kept beside them. */
export function secretsSetFor(repo: string, tool: ToolSpec, state?: string): string[] {
  const folder = secretFolder(state);
  let names: string[] | null = null;
  const backend = secretBackend();
  if (backend !== null && !existsSync(toolFile(folder, repo, tool.name, ".json")) && (folder.legacy === null || !existsSync(legacyFile(folder, repo, tool.name)!))) {
    try { const listed = JSON.parse(readOwnFile(toolFile(folder, repo, tool.name, ".names.json")) ?? "null") as unknown; names = Array.isArray(listed) ? listed.filter((one): one is string => typeof one === "string") : null; } catch { names = null; }
  }
  if (names === null) {
    const values = readToolSecrets(repo, tool.name, state);
    names = Object.keys(values).filter(name => values[name] !== "");
    if (backend !== null) writeNames(folder, repo, tool.name, names);
  }
  return tool.secrets.filter(one => names!.includes(one.name)).map(one => one.name);
}

/** Where this computer keeps tool secrets, in the words Settings and `toolroll integrations` share; `problem` when they can't be used. */
export function toolSecretStorage(): { kind: SecretStoreKind; words: string; filesOnly: boolean; problem?: string } {
  return secretStorage();
}

/** A command line split into program and arguments, honouring "double" and 'single' quotes. */
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = "", quote: '"' | "'" | null = null, started = false;
  for (const char of line.trim()) {
    if (quote !== null) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) { parts.push(current); current = ""; started = false; } continue; }
    current += char; started = true;
  }
  if (quote !== null) throw new Error("A quote in the command is not closed.");
  if (started) parts.push(current);
  return parts;
}
