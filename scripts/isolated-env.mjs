/**
 * One throwaway computer for every synthetic journey, e2e script and test worker: an environment built from nothing,
 * so no copy of the caller's environment can bring the person's own home, PATH, agent CLIs, credentials or browser back
 * (2026-11-14: a script spread `{ ...process.env }` after its throwaway HOME and PATH, and a "scripted" build ran this
 * computer's real Claude Code under the person's own login).
 *
 * The bar is ACCIDENT-PROOF: a test, journey or script can't reach the person's setup by accident (a spread
 * environment, a login shell's PATH, a default rooted in HOME, a forgotten credential variable). It is not a sandbox
 * against hostile test code: an approved interpreter (node, python3, perl, env, xargs, find, npm/npx, make) can still
 * run any absolute path, and macOS can't nest sandbox-exec, so journeys can't add an OS fence around Toolroll's own.
 *
 * It is an allowlist, never a blocklist:
 *   - PATH is only run-owned folders: the world's stand-ins (`bin`), and `tools`, which holds exactly APPROVED_TOOLS,
 *     each linked by its resolved absolute path (node from this process, npm/npx/corepack from beside it; never an
 *     nvm, Volta or asdf shim). Anything not listed (every agent CLI, `security`, browsers, `gh`) is simply absent.
 *   - `sh`, `bash` and `zsh` there are wrappers that never start a login shell and never read the system profiles, so
 *     /etc/zprofile and path_helper can't rebuild PATH from the computer's own folders.
 *   - Only exact names of the caller's environment pass (PASS_NAMES), and a proxy only without credentials in it.
 *
 *   isolatedEnvironment({ root })   the environment, its folders under `root`, and recording stand-ins for the browser
 *                                   openers, the service supervisors and gh.
 *   assertIsolated(env, { root })   throws unless that exact environment keeps a process inside the world; run it right
 *                                   before each spawn.
 *   residueCheck({ root, … })       a LIMITED, read-only residue check of the person's real home (see its comment).
 */
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Every coding-agent CLI Toolroll can run (provider.ts, acp-agents.ts) and the ones it knows of. */
export const AGENT_CLIS = ["claude", "codex", "gemini", "opencode", "cursor-agent", "cline", "qwen", "goose", "amp", "aider", "copilot", "droid", "crush", "kiro", "q"];
/** What opens a browser. */
export const BROWSER_OPENERS = ["open", "xdg-open", "sensible-browser", "x-www-browser", "gnome-open", "kde-open", "wslview"];
/** Names that may appear on a world's PATH only as one of its own stand-in files. */
export const STAND_IN_ONLY = new Set([...AGENT_CLIS, ...BROWSER_OPENERS, "gh", "security", "osascript", "launchctl", "systemctl",
  "google-chrome", "chromium", "chromium-browser", "firefox", "safari"]);

/** The only programs a world's `tools` folder holds, by exact name: what Toolroll, git, npm and the journeys run. */
export const APPROVED_TOOLS = Object.freeze([
  "node", "npm", "npx", "corepack", "git", "sh", "bash", "zsh", "env", "which", "sqlite3", "python3", "perl", "tmux", "script",
  "cat", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "ls", "chmod", "touch", "head", "tail", "wc", "sort", "uniq", "tr", "sed", "awk",
  "grep", "egrep", "cut", "date", "dirname", "basename", "readlink", "realpath", "mktemp", "sleep", "kill", "ps", "pgrep", "pkill",
  "lsof", "id", "uname", "true", "false", "test", "expr", "printf", "echo", "tee", "xargs", "find", "diff", "cmp", "patch", "tar",
  "gzip", "gunzip", "zip", "unzip", "shasum", "sha256sum", "md5", "md5sum", "base64", "od", "xxd", "mkfifo", "stat", "du", "df",
  "whoami", "hostname", "sw_vers", "sysctl", "tput", "stty", "nohup", "setsid", "timeout", "file", "make", "openssl", "plutil",
  "defaults", "bwrap", "socat", "rg", "cc", "as", "ld", "seq", "yes", "truncate", "sync", "printenv", "nproc", "getconf", "curl",
]);
/** Approved only where a journey says so (the mail journey's server runs in Docker). */
export const OPTIONAL_TOOLS = Object.freeze(["docker"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);
/** Folders whose programs are version-manager shims (they resolve the real program somewhere else at run time). */
const SHIM = /[/\\](\.volta|\.asdf|\.mise|mise|\.rtx|\.nodenv|\.pyenv|\.rbenv)[/\\]|[/\\]shims[/\\]/;

/** Names of the caller's environment a world keeps, exactly (everything else is dropped). */
export const PASS_NAMES = Object.freeze(["LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "TZ",
  "CI", "GITHUB_ACTIONS", "RUNNER_OS", "SANDBOX_RUNTIME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "TOOLROLL_CHECK_RESULTS_FD", "TOOLROLL_CHECK_GATE", "TOOLROLL_CHECK_KEEP_GOING", "TOOLROLL_RELEASE_FAIL_FAST", "TOOLROLL_RELEASE_NO_RETRY",
  "TOOLROLL_RELEASE_SCRIPTED_TIMEOUT_SECONDS", "TOOLROLL_STORAGE_SWEEP", "TOOLROLL_RESIDUE_UNREADABLE", "PLAYWRIGHT_BROWSERS_PATH"]);
const PROXY = /^(https?|no|all)_proxy$/i;
/** The names isolatedEnvironment itself sets. */
export const BUILT_NAMES = Object.freeze(["HOME", "USERPROFILE", "USER", "LOGNAME", "SHELL", "ZDOTDIR", "TMPDIR", "TMP", "TEMP", "PATH",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "BROWSER", "TOOLROLL_BROWSER_COMMAND", "TOOLROLL_SECRET_STORE",
  "TOOLROLL_STORAGE_SWEEP", "TOOLROLL_NO_UPDATE_CHECK", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"]);
/** Names the journeys give their children on purpose (a world's database, commit identity, plan probe, traces, npm
 * prefix for an install path, a stand-in tool server). Exact names; anything else needs to be given per call. */
export const JOURNEY_NAMES = Object.freeze(["TOOLROLL_DB", "STANDING_ORDERS_DB", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL", "TOOLROLL_NO_PLAN_PROBE", "STANDING_ORDERS_NO_PLAN_PROBE", "TOOLROLL_MATE_TRACE", "STANDING_ORDERS_MATE_TRACE",
  "NODE_OPTIONS", "TOOLROLL_TEST_CONNECT", "npm_config_cache", "npm_config_prefix", "npm_config_update_notifier", "npm_config_fund",
  "npm_config_audit", "npm_config_registry"]);
/** A credential by its name: never in a world, whatever put it there. */
export const CREDENTIAL_NAME = /(_TOKEN|_KEY|_SECRET|_PASSWORD)$|^(ANTHROPIC|OPENAI|AWS|GH)_|^GITHUB_TOKEN$/;
/** Startup hooks: a variable that makes a shell or interpreter run something before the program. */
export function startupHook(name, value) {
  if (["BASH_ENV", "ENV", "PYTHONSTARTUP", "PERL5OPT", "LD_PRELOAD", "LD_AUDIT"].includes(name) || /^DYLD_/.test(name)) return true;
  return name === "NODE_OPTIONS" && String(value ?? "") !== "";
}

/** Whether `name=value` from the caller's environment may pass into a world. A proxy carrying credentials never does. */
export function passes(name, value = "") {
  if (!PASS_NAMES.includes(name)) return false;
  if (PROXY.test(name) && /:\/\/[^/@\s]*@/.test(String(value))) return false;
  return true;
}

const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const executable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
const shellWord = text => `'${String(text).replace(/'/g, "'\\''")}'`;

/** Where `name` is on `path` (the first match; null: nowhere). Empty and relative entries are skipped here; assertIsolated
 * refuses them. */
export function onPath(name, path) {
  for (const folder of String(path ?? "").split(delimiter)) {
    if (folder !== "" && isAbsolute(folder) && executable(join(folder, name))) return join(folder, name);
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

/** A wrapper for a shell: drops every login flag (-l, --login, `l` in a flag cluster) before the command, and starts
 * the real shell without the system profiles (zsh -d, bash --noprofile), so a login shell can't rebuild PATH. */
function shellWrapper(name, target) {
  const extra = name === "zsh" ? " -d" : name === "bash" ? " --noprofile" : "";
  return `#!/bin/sh
# A throwaway world's ${name}: never a login shell, never the system profiles (isolated-env.mjs).
n=$#; stop=0
while [ "$n" -gt 0 ]; do
  a=$1; shift; n=$((n - 1))
  if [ "$stop" = 0 ]; then
    case $a in
      -l|--login) continue ;;
      --*) ;;
      -*) a=$(printf '%s' "$a" | tr -d l); [ "$a" = "-" ] && continue ;;
      *) stop=1 ;;
    esac
    case $a in -*c*) stop=1 ;; esac
  fi
  set -- "$@" "$a"
done
unset BASH_ENV ENV
exec ${shellWord(target)}${extra} "$@"
`;
}

/**
 * The approved tools in `dir`: each name of `names` that the caller's PATH has, linked by its resolved absolute path
 * (node is this process's own binary; npm, npx and corepack the ones beside it); a version-manager shim is never linked.
 * The shells are wrappers (shellWrapper). Returns what was linked and what this computer doesn't have.
 */
export function approvedTools(dir, { outerPath = process.env.PATH, names = APPROVED_TOOLS } = {}) {
  mkdirSync(dir, { recursive: true });
  const linked = [], missing = [];
  for (const name of names) {
    if (!APPROVED_TOOLS.includes(name) && !OPTIONAL_TOOLS.includes(name)) throw new Error(`${name} isn't an approved tool`);
    const at = join(dir, name);
    if (existsSync(at)) { linked.push(name); continue; }
    let target = null;
    if (name === "node") target = real(process.execPath);
    else if (["npm", "npx", "corepack"].includes(name)) { const beside = join(dirname(process.execPath), name); target = existsSync(beside) ? real(beside) : null; }
    else {
      const found = onPath(name, outerPath) ?? (SHELLS.has(name) && existsSync(`/bin/${name}`) ? `/bin/${name}` : null);
      target = found === null ? null : real(found);
      if (target !== null && (SHIM.test(found) || SHIM.test(target))) target = null;
    }
    if (target === null) { missing.push(name); continue; }
    try {
      if (SHELLS.has(name)) { writeFileSync(at, shellWrapper(name, target)); chmodSync(at, 0o755); }
      else symlinkSync(target, at);
      linked.push(name);
    } catch { if (existsSync(at)) linked.push(name); else missing.push(name); }
  }
  recordTools(dir);
  return { dir, linked, missing };
}

/** What each approved tool resolved to when its folder was made (path, device, inode; a shell wrapper's bytes): kept in
 * this process and in the folder's manifest, so assertIsolated checks targets, not names. */
const TOOL_MANIFESTS = new Map();
const MANIFEST = ".approved.json";
const identity = path => { const target = realpathSync(path); const info = statSync(target); return { target, dev: info.dev, ino: info.ino,
  ...(target.startsWith(realpathSync(dirname(path))) ? { sha256: createHash("sha256").update(readFileSync(target)).digest("hex") } : {}) }; };
function recordTools(dir) {
  // What was recorded when the folder was first made stands; only tools new since then are recorded now.
  const manifest = { ...(toolManifest(dir) ?? {}) };
  for (const name of readdirSync(dir)) if (name !== MANIFEST && manifest[name] === undefined && executable(join(dir, name))) manifest[name] = identity(join(dir, name));
  TOOL_MANIFESTS.set(real(dir), manifest);
  writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest), { mode: 0o600 });
}
function toolManifest(dir) {
  const known = TOOL_MANIFESTS.get(real(dir));
  if (known !== undefined) return known;
  try { return JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")); } catch { return null; }
}

/** A recording stand-in gh: `auth status` signed in, `api` answers an empty list for what flow triggers ask, and every
 * call is written to `log`. A world never reaches the person's GitHub login. */
function ghStandIn(log) {
  return `#!/bin/sh
printf '%s\\n' "$*" >> ${shellWord(log)}
case "$1" in
  auth) echo "github.com: Logged in to github.com as e2e (stand-in)"; exit 0 ;;
  api) last=""; for a in "$@"; do last=$a; done
       case $last in
         *actions/runs/*) echo '{"id":1,"status":"completed","conclusion":"success","head_branch":"main","event":"push","created_at":"2026-01-01T00:00:00Z"}' ;;
         *actions/runs*) echo '{"total_count":0,"workflow_runs":[]}' ;;
         *) echo '[]' ;;
       esac; exit 0 ;;
  --version) echo "gh version 2.99.0 (stand-in)"; exit 0 ;;
esac
echo "gh stand-in: no scripted answer for: $*" >&2
exit 1
`;
}

/**
 * A throwaway computer's environment under `root`, built from nothing. `first`: run-owned folders to put first on its
 * PATH (a scripted provider's stand-ins). `set`: names to set last, validated: HOME, PATH and the XDG folders can never
 * point outside `root`, and TMPDIR only inside `root` or at the temp folder `root` is in. `outer`: the caller's
 * environment (read for PASS_NAMES and to find the approved tools). `tools`: extra OPTIONAL_TOOLS by name. Returns the
 * environment and where things went: `opened` lists every page or address a browser opener was handed, one per line.
 * `owner`: the run-owned folder `root` is in, when the world's own folders (a release's home, its prefix) sit beside it.
 */
export function isolatedEnvironment({ root, owner = root, first = [], set = {}, outer = process.env, user = "sam", tools = [] }) {
  const base = real(root), owned = real(owner);
  if (!inside(base, owned)) throw new Error(`isolatedEnvironment: ${base} is not inside ${owned}`);
  const home = join(base, "home"), tmp = join(base, "tmp"), bin = join(base, "bin"), toolDir = join(base, "tools");
  const config = join(home, ".config"), cache = join(home, ".cache"), data = join(home, ".local", "share"), state = join(home, ".local", "state");
  for (const one of [home, tmp, bin, config, cache, data, state]) mkdirSync(one, { recursive: true });
  for (const one of first) if (!inside(real(one), owned)) throw new Error(`isolatedEnvironment: ${one} is not inside the world (${owned})`);
  const opened = join(base, "opened.txt");
  const exe = (file, text) => { writeFileSync(join(bin, file), text); chmodSync(join(bin, file), 0o755); };
  // The browser: every opener records what it was handed and opens nothing.
  for (const opener of BROWSER_OPENERS) exe(opener, `#!/bin/sh\nfor arg in "$@"; do printf '%s %s\\n' ${shellWord(opener)} "$arg" >> ${shellWord(opened)}; done\nexit 0\n`);
  exe("open-browser", `#!/bin/sh\nprintf 'browser %s\\n' "$1" >> ${shellWord(opened)}\nexit 0\n`);
  for (const supervisor of ["launchctl", "systemctl"]) exe(supervisor, `#!/bin/sh\necho "${supervisor} is refused in a throwaway world" >&2\nexit 1\n`);
  exe("gh", ghStandIn(join(base, "gh-calls.txt")));
  approvedTools(toolDir, { outerPath: outer.PATH, names: [...APPROVED_TOOLS, ...tools] });
  const gitconfig = join(home, ".gitconfig");
  if (!existsSync(gitconfig)) writeFileSync(gitconfig, "");
  const env = {};
  for (const [name, value] of Object.entries(outer)) if (value !== undefined && passes(name, value)) env[name] = value;
  const shell = join(toolDir, process.platform === "darwin" && existsSync(join(toolDir, "zsh")) ? "zsh" : "bash");
  Object.assign(env, {
    HOME: home, USERPROFILE: home, USER: user, LOGNAME: user, SHELL: existsSync(shell) ? shell : join(toolDir, "sh"), ZDOTDIR: home,
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data, XDG_STATE_HOME: state,
    PATH: [...first, bin, toolDir].join(delimiter),
    BROWSER: join(bin, "open-browser"), TOOLROLL_BROWSER_COMMAND: join(bin, "open-browser"),
    TOOLROLL_SECRET_STORE: "files", TOOLROLL_STORAGE_SWEEP: outer.TOOLROLL_STORAGE_SWEEP ?? "off", TOOLROLL_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  });
  Object.assign(env, validOverrides(set, { root: owned, tmp: outer.TMPDIR }));
  return { env, root: base, home, tmp, bin, tools: toolDir, opened, ghCalls: join(base, "gh-calls.txt") };
}

/** The overrides a world takes: HOME, PATH and the XDG folders only inside `root`, every PATH entry run-owned, TMPDIR
 * inside `root` or the temp folder `root` sits in. Throws on anything else. */
export function validOverrides(set, { root, tmp = null }) {
  const base = real(root);
  for (const [name, value] of Object.entries(set)) {
    if (value === undefined) continue;
    if (["HOME", "USERPROFILE", "ZDOTDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "GIT_CONFIG_GLOBAL"].includes(name) && !inside(real(value), base)) throw new Error(`override ${name}=${value} points outside the world (${base})`);
    if (name === "PATH") for (const one of String(value).split(delimiter)) if (one === "" || !isAbsolute(one) || !inside(real(one), base)) throw new Error(`override PATH entry ${one || "(empty)"} is not a folder of the world`);
    if (["TMPDIR", "TMP", "TEMP"].includes(name) && !inside(real(value), base) && !(tmp !== null && inside(base, real(tmp)) && real(value) === real(tmp))) throw new Error(`override ${name}=${value} is neither the world's nor the temp folder it is in`);
  }
  return set;
}

/**
 * Throws unless `env` keeps a process inside the world at `root`:
 *   - HOME (never the person's), and every XDG folder, credential folder and git config that is set, inside `root`;
 *     no SSH agent, no credential-shaped name (CREDENTIAL_NAME), no startup hook (startupHook); with `names`, only
 *     those exact names;
 *   - PATH: no empty or relative entry, every entry a run-owned folder that can be read; a `tools` folder holds only
 *     what approvedTools recorded, each still resolving to the exact target it was made with (path, device, inode, a
 *     wrapper's bytes); every other program on PATH a run-owned file by its resolved target, and agent CLIs, browser
 *     openers, gh and `security` (STAND_IN_ONLY) nowhere else.
 * Run it on the exact environment a process starts with, after every spread and override.
 */
export function assertIsolated(env, { root, homes = personHomes(), names = null }) {
  const base = real(root);
  const problems = [];
  if (!env.HOME || !inside(real(env.HOME), base)) problems.push(`HOME is ${env.HOME ?? "unset"}, outside ${base}`);
  for (const home of homes) if (env.HOME && real(env.HOME) === home) problems.push(`HOME is the person's own home (${home})`);
  for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "ZDOTDIR", "GIT_CONFIG_GLOBAL", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME", "GH_CONFIG_DIR", "DOCKER_CONFIG"]) {
    if (env[name] && !inside(real(env[name]), base)) problems.push(`${name} is ${env[name]}, outside ${base}`);
  }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (name === "SSH_AUTH_SOCK") problems.push("SSH_AUTH_SOCK is set");
    else if (CREDENTIAL_NAME.test(name)) problems.push(`${name} looks like a credential`);
    else if (startupHook(name, value)) problems.push(`${name} is a startup hook`);
    else if (names !== null && !names.includes(name)) problems.push(`${name} isn't a name this child may get`);
  }
  for (const folder of String(env.PATH ?? "").split(delimiter)) {
    if (folder === "" || !isAbsolute(folder)) { problems.push(`PATH has ${folder === "" ? "an empty" : "a relative"} entry (${folder || "the working folder"})`); continue; }
    if (!inside(real(folder), base)) { problems.push(`PATH entry ${folder} is not a folder of the world`); continue; }
    let entries;
    try { entries = readdirSync(folder); } catch (error) { if (error?.code !== "ENOENT") problems.push(`PATH entry ${folder} can't be read (${error?.code ?? "error"})`); continue; }
    const manifest = real(folder).endsWith(`${sep}tools`) ? toolManifest(folder) : null;
    if (real(folder).endsWith(`${sep}tools`) && manifest === null) { problems.push(`${folder} has no record of its approved tools`); continue; }
    for (const name of entries) {
      const path = join(folder, name);
      if (name === MANIFEST || !executable(path)) continue;
      if (manifest !== null) {
        const want = manifest[name];
        if (want === undefined) { problems.push(`${path} isn't an approved tool`); continue; }
        let now = null;
        try { now = identity(path); } catch { /* gone or unreadable */ }
        if (now === null || now.target !== want.target || now.dev !== want.dev || now.ino !== want.ino || now.sha256 !== want.sha256) problems.push(`${path} no longer resolves to the approved ${want.target}`);
        continue;
      }
      const target = real(path);
      if (!inside(target, base)) problems.push(STAND_IN_ONLY.has(name) ? `${name} on PATH (${path}) resolves to ${target}, not a stand-in of the world` : `${path} resolves to ${target}, outside the world`);
    }
  }
  if (problems.length > 0) throw new Error(`not an isolated environment: ${problems.join("; ")}`);
  return true;
}

/** A path as Claude Code names its transcript folder for it (agent-fence.ts claudeProjectFolder). */
export const claudeSlug = path => path.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * A LIMITED residue check of the person's real home(s), read-only. It looks only at three places a build that escaped
 * a world has left traces: Claude's transcript folders named after a path under `root` (new ones, and any change in a
 * listing that was already there), the build cache folders of `repos` (only when `repos` is given; agent-fence.ts
 * buildCacheFolder), and lines of ~/.toolroll/git-incidents.jsonl naming a path under `root`. It can't see any other
 * write. `also`: more run-owned folders whose paths count as this run's. A place that exists but can't be read is UNKNOWN,
 * and `check()` reports it as such and fails on it, unless the caller said up front that it accepts unreadable places
 * (`acceptUnreadable`, from TOOLROLL_RESIDUE_UNREADABLE=accept, named in the result): a run inside a fence that hides
 * the person's home can't see them at all. A failed sandbox probe is never taken as proof of anything.
 */
export function residueCheck({ root, also = [], repos = [], homes = personHomes(), platform = process.platform, acceptUnreadable = false }) {
  const base = real(root);
  const watched = homes.map(real).filter(home => !inside(home, base));
  const paths = [...new Set([root, base, ...also, ...also.map(real)])];
  const slugs = paths.map(claudeSlug);
  const cacheRoot = home => platform === "darwin" ? join(home, "Library", "Caches", "toolroll-builds") : join(home, ".cache", "toolroll-builds");
  const hashes = repos.map(repo => createHash("sha256").update(real(repo)).digest("hex").slice(0, 16));
  const read = (what, fn, unknown) => { try { return fn(); } catch (error) { if (error?.code !== "ENOENT") unknown.push(`${what} (${error?.code ?? "unreadable"})`); return null; } };
  // A folder's listing with each entry's size and time; anything in it that can't be read makes the place unknown.
  const listing = (folder, unknown) => read(folder, () => readdirSync(folder).sort().map(name => {
    const info = read(join(folder, name), () => lstatSync(join(folder, name)), unknown);
    return info === null ? `${name}:?` : `${name}:${info.size}:${info.mtimeMs}`;
  }).join("|"), unknown);
  const snapshot = () => {
    const found = new Map(), unknown = [];
    for (const home of watched) {
      const projects = join(home, ".claude", "projects");
      const names = read(projects, () => readdirSync(projects), unknown) ?? [];
      for (const name of names) if (slugs.some(slug => name.startsWith(slug))) found.set(join(projects, name), listing(join(projects, name), unknown));
      if (hashes.length > 0) {
        const caches = read(cacheRoot(home), () => readdirSync(cacheRoot(home)), unknown) ?? [];
        for (const name of caches) if (hashes.includes(name)) found.set(join(cacheRoot(home), name), listing(join(cacheRoot(home), name), unknown));
      }
      const log = join(home, ".toolroll", "git-incidents.jsonl");
      const text = read(log, () => (statSync(log).size > 64 * 1024 * 1024 ? "" : readFileSync(log, "utf8")), unknown);
      if (text !== null) text.split("\n").forEach((line, index) => { if (paths.some(one => line.includes(one))) found.set(`${log}:${index + 1}`, line); });
    }
    return { found, unknown };
  };
  const before = snapshot();
  return {
    homes: watched,
    covers: { transcripts: true, buildCaches: hashes.length > 0, incidents: true },
    check: () => {
      const now = snapshot();
      const left = [...now.found].filter(([path, value]) => !before.found.has(path) || before.found.get(path) !== value).map(([path]) => path).sort();
      const unknown = [...new Set([...before.unknown, ...now.unknown])].sort();
      return { left, unknown, unknownFails: unknown.length > 0 && !acceptUnreadable, acceptedUnreadable: unknown.length > 0 && acceptUnreadable };
    },
  };
}

/** A short line for a report: what a world's browser openers were handed (never opened). */
export function openedLines(opened) {
  try { return readFileSync(opened, "utf8").split("\n").filter(line => line !== ""); } catch { return []; }
}

/** Whether this process runs inside a macOS sandbox (the plane's check fence), where no new sandbox can be made and the
 * fence itself denies the person's home folders. */
export function insideMacSandbox() {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return false;
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(deny default)(allow process-exec)(allow process-fork)(allow file-read*)(allow sysctl-read)(allow mach-lookup)", "/usr/bin/true"], { stdio: "ignore", timeout: 10_000 });
    return false;
  } catch { return true; }
}
