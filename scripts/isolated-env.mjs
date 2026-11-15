/**
 * One throwaway computer for every journey and end-to-end script: an environment built from nothing, so no copy of the
 * caller's environment can bring the person's own home, PATH, agent CLIs or browser back (2026-11-14: a script spread
 * `{ ...process.env }` after its throwaway HOME and PATH, and a "scripted" build ran this computer's real Claude Code
 * under the person's own login).
 *
 *   isolatedEnvironment({ root })   HOME, XDG folders and TMPDIR under `root`; a PATH of this world's own stand-ins,
 *                                   node and npm, and every folder of the caller's PATH with the agent CLIs taken out;
 *                                   recording stand-ins for the browser openers (`open`, `xdg-open`, BROWSER,
 *                                   TOOLROLL_BROWSER_COMMAND) and the service supervisors; only allowlisted names of
 *                                   the caller's environment (locale, terminal, CI, proxies, Toolroll's own switches).
 *   assertIsolated(env, …)          throws unless HOME and the XDG folders are inside the world and every agent CLI the
 *                                   PATH finds is one of the world's stand-ins; run it on the environment a process is
 *                                   actually started with, after every spread.
 *   realHomeGuard({ root, repos })  lists, read-only, where a leaked build would leave a trace in the person's real home
 *                                   (Claude's transcript folders named after this world's paths, the projects' build
 *                                   caches), so a run can fail on anything new there.
 */
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Every coding-agent CLI Toolroll can run (provider.ts, acp-agents.ts) and the ones it knows of: never reachable from a
 * throwaway world except as that world's own stand-in. */
export const AGENT_CLIS = ["claude", "codex", "gemini", "opencode", "cursor-agent", "cline", "qwen", "goose", "amp", "aider"];
/** What opens a browser: replaced by a recording stand-in in every world. */
export const BROWSER_OPENERS = ["open", "xdg-open", "sensible-browser", "x-www-browser", "gnome-open", "wslview"];
/** What installs a login service: refused in every world. */
export const SUPERVISORS = ["launchctl", "systemctl"];

/** Names of the caller's environment a world keeps (everything else is dropped). Never a credential, a home or a PATH. */
const PASS_NAMES = new Set(["LANG", "LANGUAGE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "TZ", "CI", "SANDBOX_RUNTIME",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "DOCKER_HOST", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY"]);
const PASS_PATTERNS = [/^LC_[A-Z]+$/, /^(GITHUB|RUNNER)_[A-Z0-9_]+$/, /^(http|https|no|all)_proxy$/i, /^(TOOLROLL|STANDING_ORDERS)_[A-Z0-9_]+$/];
/** Toolroll names a world never inherits: the caller's database, browser command and agent overrides are the caller's. */
const NEVER_PASS = /^(TOOLROLL|STANDING_ORDERS)_(DB|BROWSER_COMMAND|TUI_BINARY|TEST_OUTER_HOME)$/;
/** Credential-shaped names, dropped even when a pattern above matches. */
const CREDENTIAL = /(TOKEN|SECRET|PASSWORD|API_KEY|_KEY$|OAUTH|COOKIE|CREDENTIAL)/i;

/** Whether `name` from the caller's environment may pass into a world. */
export function passes(name) {
  if (NEVER_PASS.test(name) || CREDENTIAL.test(name)) return false;
  return PASS_NAMES.has(name) || PASS_PATTERNS.some(pattern => pattern.test(name));
}

const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const executable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
const shellWord = text => `'${String(text).replace(/'/g, "'\\''")}'`;

/** Where `name` is on `path` (null: nowhere). */
export function onPath(name, path) {
  for (const folder of String(path ?? "").split(delimiter)) {
    if (folder !== "" && executable(join(folder, name))) return join(folder, name);
  }
  return null;
}

/** The person's real home folders: the account's own (the password database, which no HOME hides) and the HOME the
 * caller was started with, each by its real path. */
export function personHomes(env = process.env) {
  const homes = new Set();
  try { homes.add(real(userInfo().homedir)); } catch { /* no account entry */ }
  if (env.HOME) homes.add(real(env.HOME));
  return [...homes];
}

/**
 * The caller's PATH with no agent CLI and no browser opener left on it: a folder holding one is replaced by a folder of
 * links to everything else in it (`shadows`, made once per folder). Folders inside `keep` stay as they are.
 */
export function pathWithoutAgents(path, shadows, keep = []) {
  const out = [];
  const drop = new Set([...AGENT_CLIS, ...BROWSER_OPENERS, ...SUPERVISORS]);
  for (const folder of String(path ?? "").split(delimiter)) {
    if (folder === "" || !isAbsolute(folder) || out.includes(folder)) continue;
    if (keep.some(one => inside(real(folder), real(one)))) { out.push(folder); continue; }
    let names;
    try { names = readdirSync(folder); } catch { continue; }
    if (!names.some(name => drop.has(name))) { out.push(folder); continue; }
    const shadow = join(shadows, createHash("sha256").update(folder).digest("hex").slice(0, 12));
    if (!existsSync(shadow)) {
      mkdirSync(shadow, { recursive: true });
      for (const name of names) if (!drop.has(name)) { try { symlinkSync(join(folder, name), join(shadow, name)); } catch { /* left out */ } }
    }
    out.push(shadow);
  }
  return out.join(delimiter);
}

/** Where Playwright keeps its browsers for the caller (read-only; a world's HOME would otherwise hide them). */
function playwrightBrowsers(env) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  const home = env.HOME || homedir();
  const at = process.platform === "darwin" ? join(home, "Library", "Caches", "ms-playwright")
    : join(env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, ".cache"), "ms-playwright");
  return existsSync(at) ? at : null;
}

/**
 * A throwaway computer's environment under `root`, built from nothing. `first`: folders to put first on its PATH (a
 * scripted provider's stand-ins). `set`: names to set last (they win). `outer`: the caller's environment (read for the
 * allowlisted names and its PATH folders only). Returns the environment and where things went: `opened` lists every
 * page or address a browser opener was handed, one per line.
 */
export function isolatedEnvironment({ root, first = [], set = {}, outer = process.env, user = "sam" }) {
  const base = real(root);
  const home = join(base, "home"), tmp = join(base, "tmp"), bin = join(base, "bin"), tools = join(base, "tools"), shadows = join(base, "path");
  const config = join(home, ".config"), cache = join(home, ".cache"), data = join(home, ".local", "share"), state = join(home, ".local", "state");
  for (const one of [home, tmp, bin, tools, shadows, config, cache, data, state]) mkdirSync(one, { recursive: true });
  const opened = join(base, "opened.txt");
  const exe = (file, text) => { writeFileSync(join(bin, file), text); chmodSync(join(bin, file), 0o755); };
  // The browser: every opener records what it was handed and opens nothing.
  for (const opener of BROWSER_OPENERS) exe(opener, `#!/bin/sh\nfor arg in "$@"; do printf '%s %s\\n' ${shellWord(opener)} "$arg" >> ${shellWord(opened)}; done\nexit 0\n`);
  exe("open-browser", `#!/bin/sh\nprintf 'browser %s\\n' "$1" >> ${shellWord(opened)}\nexit 0\n`);
  for (const supervisor of SUPERVISORS) exe(supervisor, `#!/bin/sh\necho "${supervisor} is refused in a throwaway world" >&2\nexit 1\n`);
  // node and npm, by this process's own Node (its folder may hold agent CLIs installed with npm: never put on the PATH).
  const link = (from, name) => { try { if (!existsSync(join(tools, name))) symlinkSync(from, join(tools, name)); } catch { /* left out */ } };
  link(process.execPath, "node");
  for (const tool of ["npm", "npx", "corepack"]) { const found = join(dirname(process.execPath), tool); if (existsSync(found)) link(real(found), tool); }
  const env = {};
  for (const [name, value] of Object.entries(outer)) if (value !== undefined && passes(name)) env[name] = value;
  const browsers = playwrightBrowsers(outer);
  const dockerConfig = outer.DOCKER_CONFIG || (outer.HOME ? join(outer.HOME, ".docker") : null);
  Object.assign(env, {
    HOME: home, USERPROFILE: home, USER: user, LOGNAME: user, SHELL: "/bin/sh",
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data, XDG_STATE_HOME: state,
    PATH: [...first, bin, tools, pathWithoutAgents(outer.PATH, shadows, first)].filter(Boolean).join(delimiter),
    BROWSER: join(bin, "open-browser"), TOOLROLL_BROWSER_COMMAND: join(bin, "open-browser"),
    TOOLROLL_SECRET_STORE: "files", TOOLROLL_STORAGE_SWEEP: outer.TOOLROLL_STORAGE_SWEEP ?? "off", TOOLROLL_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    ...(browsers === null ? {} : { PLAYWRIGHT_BROWSERS_PATH: browsers }),
    ...(dockerConfig !== null && existsSync(dockerConfig) ? { DOCKER_CONFIG: dockerConfig } : {}),
  });
  Object.assign(env, set);
  return { env, root: base, home, tmp, bin, tools, opened };
}

/**
 * Throws unless `env` keeps a process inside the world at `root`: HOME and the XDG folders there, and every agent CLI its
 * PATH finds inside one of `allowed` (the world's stand-ins), the browser openers the world's own. Run it on the exact
 * environment a process starts with: a later `{ ...process.env }` that brings the person's HOME or PATH back fails here.
 * `homes`: the person's homes, read before this process's own environment became the world's (personHomes()).
 */
export function assertIsolated(env, { root, allowed = [], platform = process.platform, homes = personHomes() }) {
  const base = real(root);
  const problems = [];
  if (!env.HOME || !inside(real(env.HOME), base)) problems.push(`HOME is ${env.HOME ?? "unset"}, outside ${base}`);
  // An XDG folder left unset follows HOME; one that is set must be inside the world too.
  for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    if (env[name] && !inside(real(env[name]), base)) problems.push(`${name} is ${env[name]}, outside ${base}`);
  }
  for (const home of homes) if (env.HOME && real(env.HOME) === home) problems.push(`HOME is the person's own home (${home})`);
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME"]) if (env[name] && !inside(real(env[name]), base)) problems.push(`${name} points outside the world (${env[name]})`);
  const stands = allowed.map(real);
  for (const agent of AGENT_CLIS) {
    const found = onPath(agent, env.PATH);
    if (found !== null && !stands.some(one => inside(real(dirname(found)), one))) problems.push(`${agent} resolves to ${found}, not a stand-in`);
  }
  // The opener Toolroll hands a page to here (sign-in-page.ts platformOpener).
  for (const opener of platform === "darwin" ? ["open"] : platform === "linux" ? ["xdg-open"] : []) {
    const found = onPath(opener, env.PATH);
    if (found !== null && !inside(real(found), base)) problems.push(`${opener} resolves to ${found}, outside the world`);
  }
  if (problems.length > 0) throw new Error(`not an isolated environment: ${problems.join("; ")}`);
  return true;
}

/** A path as Claude Code names its transcript folder for it (agent-fence.ts claudeProjectFolder). */
export const claudeSlug = path => path.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * What a build that escaped the world would leave in the person's real home(s), listed read-only: Claude's transcript
 * folders named after a path under `root`, the build cache folders of `repos` (agent-fence.ts buildCacheFolder), and
 * lines of Toolroll's Git incident log naming a path under `root`.
 * `check()` returns what is there now that wasn't when the guard was made. Folders that can't be read (inside a check's
 * fence) are skipped. `homes` defaults to personHomes() of the caller; never folders inside `root` itself.
 */
export function realHomeGuard({ root, repos = [], homes = personHomes(), platform = process.platform }) {
  const base = real(root);
  const watched = homes.map(real).filter(home => !inside(home, base));
  const paths = [...new Set([root, base])];
  const slugs = paths.map(claudeSlug);
  const cacheRoot = home => platform === "darwin" ? join(home, "Library", "Caches", "toolroll-builds") : join(home, ".cache", "toolroll-builds");
  const hashes = repos.map(repo => createHash("sha256").update(real(repo)).digest("hex").slice(0, 16));
  const list = () => {
    const found = [];
    for (const home of watched) {
      const projects = join(home, ".claude", "projects");
      try { for (const name of readdirSync(projects)) if (slugs.some(slug => name.startsWith(slug))) found.push(join(projects, name)); } catch { /* none, or out of reach */ }
      try { for (const name of readdirSync(cacheRoot(home))) if (hashes.includes(name)) found.push(join(cacheRoot(home), name)); } catch { /* none, or out of reach */ }
      // Toolroll's own Git incident log (teardown-git.ts): a line naming a checkout of this world.
      for (const log of [join(home, ".toolroll", "git-incidents.jsonl"), join(home, ".standing-orders", "git-incidents.jsonl")]) {
        try {
          if (statSync(log).size > 64 * 1024 * 1024) continue;
          readFileSync(log, "utf8").split("\n").forEach((line, index) => { if (paths.some(one => line.includes(one))) found.push(`${log}:${index + 1}`); });
        } catch { /* none, or out of reach */ }
      }
    }
    return found.sort();
  };
  const before = new Set(list());
  return { homes: watched, before: [...before], check: () => list().filter(one => !before.has(one)) };
}

/** A short line for a report: what a world's browser openers were handed (never opened). */
export function openedLines(opened) {
  try { return readFileSync(opened, "utf8").split("\n").filter(line => line !== ""); } catch { return []; }
}
