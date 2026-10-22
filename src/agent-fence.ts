/**
 * The agent fence: what no build, plan, scout or repair agent may read or
 * write, whatever its permission mode. Agents run as the operator's own OS
 * user, so without it an agent could read the approver's remembered login
 * (`up-login.txt`), runner and coordinator tokens, provider keys, project
 * tool secrets, other runs' evidence, or the live database — and use them
 * to approve its own work. The fence closes that at the operating system,
 * not in the model's instructions:
 *
 * - Codex (every platform): a permission profile that extends its own
 *   `:workspace` sandbox (Auto keeps it exactly: workspace writes, no
 *   network) or widens it to write anywhere with network on (Full access,
 *   which used to mean no sandbox at all), and denies every fenced path.
 * - Claude and Gemini on macOS: the whole agent process runs inside a
 *   Seatbelt profile that allows everything except the fenced paths.
 * - Claude and Gemini on Linux (v88): the agent runs under bubblewrap, in its
 *   own mount namespace where every fenced folder is an empty one and every
 *   fenced file is /dev/null. Used when `bwrap` is installed and works here.
 * - Claude everywhere also gets Read/Edit deny rules for its own file tools.
 *
 * Checked against codex-cli 0.156 and Claude Code 2.1.281 with a canary
 * file read by an obfuscated script: "Operation not permitted".
 *
 * A build's fence also holds its task boundary (`taskBoundary`): home
 * configuration and the repositories beside its own, so a build works in
 * its task's folders and nowhere else it could do harm.
 *
 * Beside what it denies, a fence grants a little back (`FenceGrants`): other
 * tasks' git metadata is read but never written and their checkouts can be
 * looked up, so `git gc` and `git worktree prune` see live siblings and keep
 * them; the shared dependencies this checkout links are read and run, never
 * written. Every plane checkout pool is denied whole, this build's own checkout given back
 * (`CheckoutPool`), so another project's worktree is out of reach (Codex covers projects present at launch).
 * On macOS the agent also can't read another process's arguments
 * and environment (`kern.procargs`) or inspect a process outside its own
 * sandbox, so a tool server's or Toolroll's own secrets don't leak through
 * a process listing, and every other run's launch folder in the system temp
 * folder is denied, even one made after this launch began. Nor can it get
 * another process's task port (a debugger's way into its memory), or
 * rename or remove a folder of the user's above a fenced path or the temp
 * folder, which would reach the fenced path under a new name.
 */
import { INSTANCE_DIR } from "./console-instance.js";
import { ACP_AGENTS, ACP_PROVIDER_IDS } from "./acp-agents.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readMonitoring } from "./monitoring-settings.js";
import { existingFolders } from "./names.js";
import { DEPS_FOLDER, linkedKey, readyCopy, sharedCopies } from "./shared-deps.js";
import type { LoopbackMode } from "./egress.js";

/** Beside the database: where Linux builds' network bridges are made (its name reads as secret wherever it is). */
export const BRIDGE_DIR = "bridge-secrets";

/** How a launch was fenced, as recorded on the run and said on the task. */
export type FenceMethod = "codex-profile" | "macos-sandbox" | "linux-bubblewrap" | "claude-rules" | "none";

/** Names that are secrets wherever the database lives (used when its folder is shared with other things). */
const SENSITIVE_NAME = /(^up-login\.txt$|token|secret|login|password|credential|vapid|keys?\b|\.pem$|\.key$|^backups$|^evidence$|^remote$|^sign-in\.json$|^monitoring\.json$)/i;

function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Only the plane's recorded repository may supply an own-Git exemption. */
export type WorktreeBinding = { main: string; gitdir: string };
export class CheckoutBindingError extends Error {}
export const HARDENED_GIT_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;
const GIT_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "LANG", "LC_ALL", "CODEX_HOME"];
export function checkoutGitEnv(base: Readonly<NodeJS.ProcessEnv> = process.env): Record<string, string> {
  return Object.fromEntries(GIT_ENV_NAMES.flatMap(name => base[name] === undefined ? [] : [[name, base[name]!]]));
}

export function trustedWorktreeBinding(repository: string, worktree: string, poolRoots: readonly (string | null)[] = []): WorktreeBinding {
  const main = real(repository);
  const checkout = real(worktree);
  const fail = () => new CheckoutBindingError("The checkout's Git pointer was changed or its trusted binding could not be verified.");
  const registry = join(main, ".git", "worktrees");
  try {
    // The registry may legitimately contain the destination of an attacker link.
    // Check the recorded name before accepting that destination as this run's checkout.
    if (realpathSync(worktree) !== join(realpathSync(dirname(worktree)), basename(worktree))) throw fail();
    for (const root of poolRoots) {
      if (root === null) continue;
      const components: string[] = [];
      for (let component = resolve(worktree); component !== dirname(component); component = dirname(component)) {
        components.push(component);
        // Permit system aliases above the trusted pool (e.g. /var -> /private/var),
        // but no redirect at or below it, including older checkout names.
        if (real(component) !== real(root) && component !== resolve(root)) continue;
        for (const one of components) if (lstatSync(one).isSymbolicLink()) throw fail();
        break;
      }
    }
    if (!lstatSync(join(main, ".git")).isDirectory() || !lstatSync(registry).isDirectory()) throw fail();
    // Query the trusted checkout, never the candidate's configurable Git pointer.
    const listed = spawnSync("git", [...HARDENED_GIT_ARGS, "worktree", "list", "--porcelain", "-z"],
      { cwd: main, env: checkoutGitEnv(), encoding: "utf8" });
    if (listed.status !== 0 || !listed.stdout.split("\0").includes(`worktree ${checkout}`)) throw fail();
    for (const entry of readdirSync(registry)) {
      const path = join(registry, entry);
      if (!lstatSync(path).isDirectory() || !inside(real(path), real(registry))) continue;
      if (real(readFileSync(join(path, "gitdir"), "utf8").trim()) !== join(checkout, ".git")) continue;
      const gitdir = real(path);
      if (worktreeGitDir(checkout) !== gitdir || real(join(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim())) !== real(join(main, ".git"))) throw fail();
      return { main, gitdir };
    }
  } catch { throw fail(); }
  throw fail();
}

/**
 * Every path an agent must not reach: the Toolroll state folder
 * beside the database (all of it, except the folder that holds this run's
 * own worktree), the database itself with its journal files, and
 * `~/.toolroll` or an older `~/.standing-orders` (provider keys and project tool secrets). When the
 * database sits anywhere else (a shared folder), only the database and
 * secret-looking entries there are fenced.
 */
export function agentFence(options: { databaseFile: string | null; worktree: string | null; home?: string; extra?: readonly string[]; boundary?: TaskBoundary | null; binding?: WorktreeBinding | null; runFolders?: RunFolders }): string[] {
  const fence = new Set<string>();
  /** The console's run folder: kept by its own pathname through canonicalization (and its target's too). */
  let runFolder: string | null = null;
  /** The bridges' folder, likewise. */
  let bridgeFolder: string | null = null;
  const home = real(options.home ?? homedir());
  const worktree = options.worktree === null ? null : real(options.worktree);
  if (options.databaseFile !== null && options.databaseFile !== "" && options.databaseFile !== ":memory:") {
    const database = real(options.databaseFile);
    const state = dirname(database);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) if (existsSync(database + suffix)) fence.add(database + suffix);
    // The console's run folder (its discovery sockets, console-instance.ts) beside the database, wherever that is: no
    // build may add, rename or remove anything in it while a console listens there. It is made (owner-only) before any
    // build starts if it isn't there yet, so a build can never be the one to create it — and the fence always has a
    // real folder to cover (a Linux bind needs one).
    // Whatever is at that path is fenced, always — a folder, a file, a link (the path itself, never only where a link
    // points), a folder holding anything at all — so no build can replace it; when nothing is there it is made first.
    // If it can't be made, the path is fenced anyway: a sandbox that can't cover a missing path refuses to launch
    // rather than run unfenced. The name is Toolroll's own; nothing else belongs there.
    // The folder Linux builds' network bridges are made in (egress-bridge.ts): made before any build starts and fenced
    // from every build, so no build — however long it runs — can reach a bridge made for a later one.
    const bridges = join(state, BRIDGE_DIR);
    try { lstatSync(bridges); } catch { try { mkdirSync(bridges, { mode: 0o700 }); } catch { /* fenced below either way */ } }
    // Fenced by its own name as well as where it leads: a link planted there is itself out of reach (and the bridge
    // refuses a root that isn't a private folder: egress-bridge.ts).
    bridgeFolder = bridges;
    fence.add(bridges);
    runFolder = join(state, INSTANCE_DIR);
    const present = (): boolean => { try { lstatSync(runFolder!); return true; } catch { return false; } };
    if (!present()) { try { mkdirSync(runFolder, { mode: 0o700 }); } catch { /* fenced below either way */ } }
    fence.add(runFolder);
    // Only a folder that is Toolroll's own (~/.config/toolroll or an older name,
    // the desktop app's "Toolroll") is fenced whole: a database kept
    // in a shared folder (a projects folder, a test's temp folder) must not
    // fence its neighbours, the repositories agents build among them.
    const dedicated = state !== home && state !== sep && !existsSync(join(state, ".git")) && /standing[\s_-]?orders|toolroll|nightorders/i.test(basename(state));
    // The entries this run's worktree needs stay reachable: the one it lives
    // under, and the repository its git metadata belongs to.
    const keep = new Set<string>();
    for (const needed of [worktree, options.binding?.main ?? null]) {
      if (needed !== null && inside(needed, state)) keep.add(relative(state, needed).split(sep)[0]!);
    }
    let entries: string[] = [];
    try { entries = readdirSync(state); } catch { entries = []; }
    for (const entry of entries) {
      // A repository is work, never a secret.
      if (keep.has(entry) || existsSync(join(state, entry, ".git"))) continue;
      if (dedicated || SENSITIVE_NAME.test(entry)) fence.add(join(state, entry));
    }
  }
  for (const secrets of existingFolders(home, { dot: true })) fence.add(secrets);
  // v104: the folder the audit stream writes to holds the whole instance's history.
  if (options.databaseFile !== null && options.databaseFile !== "" && options.databaseFile !== ":memory:") {
    const stream = readMonitoring(dirname(real(options.databaseFile))).folder?.path;
    if (stream !== undefined && existsSync(stream)) fence.add(real(stream));
  }
  for (const path of options.extra ?? []) if (existsSync(path)) fence.add(real(path));
  // Secret, state, database, explicit-extra and home-config denies are never exemptible.
  if (options.runFolders !== undefined) for (const path of otherRunFolders(options.runFolders)) fence.add(path);
  for (const path of options.boundary?.protectedShell ?? []) fence.add(real(path));
  const protectedPaths = new Set([...fence].flatMap(path => path === runFolder || path === bridgeFolder ? [path, real(path)] : [real(path)]));
  for (const path of options.boundary?.shell ?? []) fence.add(path);
  const binding = options.binding;
  const needed = binding === undefined || binding === null ? [] : [binding.gitdir, real(join(binding.main, ".git"))];
  return [...new Set([...fence].flatMap(path => path === runFolder || path === bridgeFolder ? [path, real(path)] : [real(path)]))].filter(path => {
    if (protectedPaths.has(path) || !needed.some(target => target === path || inside(target, path))) return true;
    console.warn(`Dropped build fence entry covering this checkout's own Git data: ${path}`);
    return false;
  }).sort();
}

/**
 * Credentials and agent configuration in the home folder. A build is the
 * operator's own OS user, so without this it could read their SSH keys,
 * cloud logins or another agent's sign-in, or rewrite their own Claude or
 * Codex setup for the next interactive session.
 */
const HOME_CONFIGURATION = [
  ".claude", ".claude.json", ".codex", ".gemini", ".ssh", ".aws", ".gnupg", ".netrc", ".git-credentials", ".kube", join(".config", "gh"), join(".docker", "config.json"),
  // Every ACP agent's own configuration and sign-in (acp-agents.ts): fenced from every build but that agent's own.
  ...ACP_PROVIDER_IDS.flatMap(id => ACP_AGENTS[id].home),
];
/** What a provider's own CLI reads to sign in and keep its sessions. The OS fence around Claude and Gemini holds
 * their whole process, so those stay reachable there; Codex fences only its agent's commands, so it keeps none. */
const PROVIDER_HOME: Record<string, readonly string[]> = {
  claude: [".claude", ".claude.json"], gemini: [".gemini"], codex: [], openrouter: [],
  // Each ACP agent keeps its own configuration and sign-in where its row says (acp-agents.ts).
  ...Object.fromEntries(ACP_PROVIDER_IDS.map(id => [id, ACP_AGENTS[id].home])),
};
/** What Claude's own file tools refuse inside its home: the CLI reads these itself, its model never needs to. */
const CLAUDE_FILE_TOOL_HOME = [".claude.json", join(".claude", ".credentials.json"), join(".claude", "settings.json"), join(".claude", "settings.local.json"), ".npmrc"];

/** The task's boundary: `shell` joins the OS fence; `fileTools` only Claude's file-tool deny rules; `readOnly` and
 * `lookup` are other tasks' git metadata and checkout roots (see FenceGrants). */
export type TaskBoundary = { protectedShell?: string[]; shell: string[]; fileTools: string[]; readOnly: string[]; lookup: string[] };

/**
 * Everything outside a task's own folders that a build could otherwise
 * reach: the home configuration above, the other repositories beside its
 * project (and other tasks' worktrees beside its own), and the project's
 * primary checkout — all but its `.git`, which the worktree's git needs.
 * The task's worktree, the files Toolroll makes for the run (in the
 * system temp folder) and everything else stay as they are.
 */
export function taskBoundary(options: { worktree: string; provider: string; home?: string; binding?: WorktreeBinding | null }): TaskBoundary {
  const home = real(options.home ?? homedir());
  const worktree = real(options.worktree);
  const main = options.binding?.main ?? null;
  const gitdir = options.binding?.gitdir ?? null;
  const needed = [worktree, main, gitdir].filter((path): path is string => path !== null);
  const own = new Set(PROVIDER_HOME[options.provider] ?? []);
  const present = (names: readonly string[]) => names.map(name => join(home, name)).filter(path => existsSync(path)).map(real);
  const shell = new Set(present(HOME_CONFIGURATION.filter(name => !own.has(name))));
  const protectedShell = [...shell];
  const repository = (path: string) => existsSync(join(path, ".git"));
  for (const parent of new Set([dirname(worktree), ...(main === null ? [] : [dirname(main)])])) {
    // Home contains toolchain clones such as .nvm and .oh-my-zsh. The
    // explicit configuration fence above owns home, not repository discovery.
    if (real(parent) === home) continue;
    let entries: string[] = [];
    try { entries = readdirSync(parent); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const candidate = join(parent, entry);
      if (!repository(candidate)) continue;
      const path = real(candidate);
      if (needed.some(target => target === path || inside(target, path))) continue;
      shell.add(path);
    }
  }
  if (main !== null && main !== worktree) {
    let entries: string[] = [];
    try { entries = readdirSync(main); } catch { entries = []; }
    for (const entry of entries) {
      const path = join(main, entry);
      if (entry !== ".git" && path !== worktree && !inside(worktree, path)) shell.add(path);
    }
  }
  // Git needs this worktree's metadata and the shared objects/refs, but
  // must not prune or rewrite the metadata of another task's checkout. It
  // still reads that metadata (gc keeps what a sibling's HEAD and index
  // reach) and looks up the checkout it names: a checkout it can't see is
  // one `git worktree prune` deletes the entry of.
  const readOnly = new Set<string>();
  const lookup = new Set<string>();
  if (gitdir !== null && main !== null) {
    const siblings = dirname(gitdir);
    let entries: string[] = [];
    try { entries = readdirSync(siblings); } catch { entries = []; }
    for (const entry of entries) {
      // Only a plain folder, by the name git gave it: a link a build planted here (to ~/.toolroll, say) is never
      // followed into a grant, which a sandbox that lets the more specific path win would honour over the fence.
      const path = join(siblings, entry);
      if (path === gitdir) continue;
      try { if (!lstatSync(path).isDirectory()) continue; } catch { continue; }
      readOnly.add(path);
      let pointer: string | undefined;
      try { pointer = readFileSync(join(path, "gitdir"), "utf8").trim(); } catch { pointer = undefined; }
      if (pointer === undefined || pointer === "" || !isAbsolute(pointer)) continue;
      const checkout = dirname(real(pointer));
      // The entry's pointer is build-writable: look up only a checkout whose own .git names this entry back, as git
      // links a real one, so a planted pointer can't lift a fenced path's metadata.
      if (worktreeGitDir(checkout) !== path) continue;
      lookup.add(checkout);
      lookup.add(join(checkout, ".git"));
    }
  }
  const fileTools = options.provider === "claude" ? present(CLAUDE_FILE_TOOL_HOME).filter(path => !shell.has(path)) : [];
  return { protectedShell, shell: [...shell].sort(), fileTools: fileTools.sort(), readOnly: [...readOnly].sort(), lookup: [...lookup].sort() };
}

/** Where launches keep their private folders (the system temp folder), and this launch's own tool folder. */
export type RunFolders = { root: string; own: string | null };
/** The prefixes of every launch's private folders: its tools' config, a Codex build's own home, and a Linux build's
 * network bridge (egress-bridge.ts). */
export const RUN_FOLDER_PREFIXES = ["so-tools-", "so-codex-", "so-net-", "so-cmd-"] as const;

export function runFolders(own: string | null, root: string = tmpdir()): RunFolders {
  return { root: real(root), own: own === null ? null : real(own) };
}

/** Every other launch's private folder there now. */
function otherRunFolders(folders: RunFolders): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(folders.root); } catch { entries = []; }
  return entries.filter(entry => RUN_FOLDER_PREFIXES.some(prefix => entry.startsWith(prefix))).map(entry => join(folders.root, entry)).filter(path => path !== folders.own);
}

/**
 * What a fence gives back beside its denied paths. Each is narrow and none
 * ever writes: `readOnly` is read, never written (other tasks' git
 * metadata); `readable` is read and run inside a denied folder (the shared
 * dependencies this checkout links); `lookup` is only looked up, never
 * listed or read (the deps root and the copy linked, other tasks' checkout
 * roots); `runFolders` denies every launch folder in the temp folder but
 * this launch's own (macOS: by pattern, so a later one is denied too);
 * `pool` denies the plane's checkout pools whole and gives this build's own
 * checkout back (CheckoutPool).
 */
export type FenceGrants = { readOnly: string[]; readable: string[]; lookup: string[]; runFolders?: RunFolders; pool?: CheckoutPool; network?: NetworkFence; writes?: WriteAllowlist };

export { isWritesMode, WRITES_DEFAULT, type WritesMode } from "./writes-mode.js";

/**
 * The only places a `workspace` build writes: `subpaths`, each a folder (or file) writable whole, and `prefixes`, a file
 * with the temporary names it is atomically replaced through, or a folder named by a pattern (a regex on macOS;
 * elsewhere the path alone, when it exists). Everything else is read-only to the build; its fence's denies and read-only grants still hold inside these.
 */
export type WriteAllowlist = { subpaths: string[]; prefixes: WritePrefix[] };
/** A file or folder named by `path` followed by what `suffix` (a regular expression, anchored at its end) allows. */
export type WritePrefix = { path: string; suffix: string };

/** Claude's transcript folder for a working folder: its path with every character but a letter or digit made `-`
 * (Claude Code's own naming; a name over 200 characters gets a suffix, so it is granted by prefix). */
export function claudeProjectFolder(home: string, cwd: string): { path: string; byPrefix: boolean } {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return slug.length > 200 ? { path: join(home, ".claude", "projects", slug.slice(0, 200)), byPrefix: true } : { path: join(home, ".claude", "projects", slug), byPrefix: false };
}

/**
 * A folder a write grant may name: made when absent, then only as the real folder it is — never a link, nor reached
 * through one (its real path is its parent's real path and its own name). A build can rewrite what it may write, so a
 * folder it was given could otherwise come back as a link to anywhere and be granted, followed, on its next launch.
 * Null when it isn't such a folder: nothing is granted, and the write it was for fails.
 */
export function grantFolder(path: string, create = true): string | null {
  if (create) { try { mkdirSync(path, { recursive: true, mode: 0o700 }); } catch { /* checked below */ } }
  try {
    const held = lstatSync(path);
    if (held.isSymbolicLink() || !held.isDirectory()) return null;
    const at = realpathSync(path);
    return at === join(realpathSync(dirname(path)), basename(path)) ? at : null;
  } catch {
    return null;
  }
}

/**
 * The data folders an ACP agent writes besides a ~/.local/share|state root, per agent, only where known: Goose's
 * sessions and state; Qwen Code (a Gemini CLI fork) its history and temp, as Gemini measured. An agent not listed
 * (Cursor, Cline: their settings sit among their data) writes nothing of its own under a workspace build until its
 * layout is measured; a project using one chooses `anywhere`.
 */
const ACP_DATA: Readonly<Record<string, readonly string[]>> = {
  goose: [".local/share/goose", ".local/state/goose"],
  qwen: [".qwen/tmp", ".qwen/history"],
};

/** The suffix Claude Code gives a transcript folder whose name it shortened: `-` and a hash, nothing else. */
const CLAUDE_SHORTENED = "-[a-z0-9]+(/|$)";
/** A file and the temporary names it is replaced through (`name.tmp-1`, `name.json.12345`), never a folder below it. */
const ATOMIC_NAMES = "([.~][^/]*)?$";

/** The parts of a repository's shared Git data a commit in a worktree writes: objects, refs and their logs (and the
 * packed refs). Its config, hooks, info, other worktrees' data and submodules' are never among them. */
function commitGitData(common: string): { subpaths: string[]; prefixes: WritePrefix[]; readOnly: string[] } {
  const made = (path: string): string => { try { mkdirSync(path, { recursive: true }); } catch { /* granted as named */ } return real(path); };
  return {
    subpaths: ["objects", "refs", "logs"].map(name => grantFolder(join(common, name))).filter((path): path is string => path !== null),
    prefixes: [{ path: join(common, "packed-refs"), suffix: ATOMIC_NAMES }],
    // Alternates there would let objects come from anywhere.
    readOnly: [made(join(common, "objects", "info"))],
  };
}

/**
 * What a `workspace` build writes and what it loses (arc 2): its checkout, its checkout's Git data (less the shared
 * repository's config, hooks and info, which Git runs or reads as commands), its own launch folder (its temp is there),
 * its project's cache folder, the terminal devices, and only the provider state its CLI must write (measured: Claude's
 * transcript folder for this checkout; Gemini's history, temp and project list; an ACP agent's own folders). The
 * folders named here are made first, so the provider never has to make them where it can't. `deny` is what this
 * provider must not even read (Claude's live sessions' keys).
 */
export function writeAllowlist(options: { provider: string; home: string; worktree: string; binding: WorktreeBinding | null; launchFolder: string | null; cache: string | null }): { writes: WriteAllowlist; readOnly: string[]; deny: string[] } {
  const home = real(options.home);
  const worktree = real(options.worktree);
  const subpaths = new Set<string>([worktree]);
  const prefixes = new Map<string, WritePrefix>();
  const readOnly = new Set<string>();
  const deny = new Set<string>();
  const made = (path: string): string => { try { mkdirSync(path, { recursive: true, mode: 0o700 }); } catch { /* granted as named either way */ } return real(path); };
  const grant = (path: string, create = true) => { const at = grantFolder(path, create); if (at !== null) subpaths.add(at); };
  if (options.binding !== null) {
    const common = real(join(options.binding.main, ".git"));
    const gitdir = real(options.binding.gitdir);
    grant(gitdir, false);
    // The shared Git data a commit writes, and nothing Git reads as commands or settings: the shared config (filters,
    // hooks path, fsmonitor), hooks, info (attributes, excludes), other worktrees' data and submodules' stay as they are.
    const data = commitGitData(common);
    for (const path of data.subpaths) subpaths.add(path);
    for (const one of data.prefixes) prefixes.set(`${one.path}\0${one.suffix}`, one);
    for (const path of data.readOnly) readOnly.add(path);
    // This worktree's own settings file, present (empty) so it is held read-only everywhere, a bind included.
    const own = join(gitdir, "config.worktree");
    try { if (!existsSync(own)) writeFileSync(own, "", { mode: 0o644, flag: "wx" }); } catch { /* held read-only by name */ }
    readOnly.add(own);
  }
  if (options.launchFolder !== null) grant(options.launchFolder, false);
  if (options.cache !== null) grant(options.cache);
  if (options.provider === "claude") {
    const folder = claudeProjectFolder(home, worktree);
    if (folder.byPrefix) { made(dirname(folder.path)); prefixes.set(folder.path, { path: folder.path, suffix: CLAUDE_SHORTENED }); }
    else grant(folder.path);
    deny.add(join(home, ".claude", "sessions"));
  } else if (options.provider === "gemini") {
    for (const name of ["history", "tmp"]) grant(join(home, ".gemini", name));
    prefixes.set("gemini", { path: join(home, ".gemini", "projects.json"), suffix: ATOMIC_NAMES });
  } else if (Object.hasOwn(ACP_AGENTS, options.provider)) {
    // An ACP agent's configuration stays read-only whole (its MCP servers, hooks, plugins, agents and commands could
    // otherwise be planted for the operator's next session of it); only its known data folders are written (ACP_DATA).
    for (const name of ACP_AGENTS[options.provider as keyof typeof ACP_AGENTS].home) if (/^\.local\/(share|state)\//.test(name)) grant(join(home, name));
    for (const name of ACP_DATA[options.provider] ?? []) grant(join(home, name));
  }
  return { writes: { subpaths: [...subpaths].sort(), prefixes: [...prefixes.values()].sort((a, b) => a.path.localeCompare(b.path)) }, readOnly: [...readOnly].sort(), deny: [...deny].sort() };
}

/** Where a project's builds keep their package caches: one folder per project (one trust domain), never used by the
 * plane's own tools, below the user's cache folder. */
export function buildCacheFolder(repo: string, home: string = homedir(), platform: NodeJS.Platform = process.platform, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const root = platform === "darwin" ? join(home, "Library", "Caches") : env["XDG_CACHE_HOME"] !== undefined && isAbsolute(env["XDG_CACHE_HOME"]) ? env["XDG_CACHE_HOME"] : join(home, ".cache");
  return join(root, "toolroll-builds", createHash("sha256").update(real(repo)).digest("hex").slice(0, 16));
}

/** The environment that points a build's package managers at its project's cache folder, not the user's own. */
export function buildCacheEnv(folder: string): Record<string, string> {
  const at = (name: string) => join(folder, name);
  return {
    npm_config_cache: at("npm"), npm_config_store_dir: at("pnpm"), YARN_CACHE_FOLDER: at("yarn"), BUN_INSTALL_CACHE_DIR: at("bun"),
    COREPACK_HOME: at("corepack"), npm_config_devdir: at("node-gyp"), PIP_CACHE_DIR: at("pip"), UV_CACHE_DIR: at("uv"),
    GOCACHE: at("go-build"), GOMODCACHE: at("go-mod"), CARGO_HOME: at("cargo"), GRADLE_USER_HOME: at("gradle"),
    DENO_DIR: at("deno"), XDG_CACHE_HOME: at("xdg"),
  };
}

/**
 * A launch's network confinement (egress.ts, docs/plans/agent-baseline-hardening.md arc 1). `open`: the network as it
 * always was. `allowlist`: nothing leaves the machine but through the run's own proxy (`proxyPort`); the run's tool
 * broker (`brokerPorts`) stays reachable; on macOS this Mac's other local services are reachable only under
 * `loopback: "any"` (all of them: Seatbelt can't refuse one local port once it admits the rest); unix sockets only
 * under `socketRoots` (the run's own temp folder and checkout). On Linux the agent gets a network of its own and
 * reaches the proxy and broker through `bridge` (a folder of unix sockets the plane serves, and the forwarder that
 * carries them onto the namespace's own loopback).
 */
export type NetworkFence =
  | { mode: "open" }
  | { mode: "allowlist"; proxyPort: number; brokerPorts: number[]; loopback: LoopbackMode; socketRoots: string[];
      bridge?: { folder: string; forwarder: string; node: string };
      /** Linux: the run's own folders a private /tmp gives back (its checkout, its launch folder), when they are there. */
      keep?: string[] };

/**
 * Services a sandboxed process could ask to act outside the sandbox for it (macOS): open a URL in a browser (Launch
 * Services), script another application (Apple Events), fetch in the background (nsurlsessiond), look a name up
 * (the DNS service: a lookup is itself a message out), or read and write the clipboard. Denied when the network is
 * confined; the run's proxy resolves names for it.
 */
export const DELEGATION_SERVICES: readonly string[] = [
  "com.apple.coreservices.launchservicesd", "com.apple.coreservices.quarantine-resolver", "com.apple.lsd.mapdb", "com.apple.lsd.modifydb", "com.apple.lsd.open",
  "com.apple.coreservices.appleevents", "com.apple.nsurlsessiond", "com.apple.nsurlsessiond.NSURLSessionProxyService",
  "com.apple.dnssd.service", "com.apple.mDNSResponder", "com.apple.pasteboard.1",
];
export const NO_GRANTS: FenceGrants = { readOnly: [], readable: [], lookup: [] };

/**
 * The plane's checkout pools, denied whole: every project's worktrees, and any made there after launch. `agentFence`
 * drops a path at or above the checkout, so the deny lives here and each sandbox gives back, right after it, only
 * `own` (this build's checkout, read and written) and `lookup` (the folders between, looked up, never listed).
 */
export type CheckoutPool = { deny: string[]; own: string | null; lookup: string[]; gitPaths?: string[] };

/**
 * The pool deny for one launch. `roots` come from the plane's own records (the pool beside the database, and the one
 * the recorded checkout was made in), never from the checkout. A root that holds this checkout's own Git data (the
 * binding's gitdir or the repository's .git) is never denied whole: it is split around that data instead, entry by
 * entry, so it is denied as far as it can be (fail closed by denying more, never by refusing). A root inside the
 * checkout, the home folder, a folder above it or / is left alone: the first is the build's own work, the others the
 * whole machine.
 */
export function checkoutPool(options: { roots: readonly (string | null)[]; worktree: string | null; binding?: WorktreeBinding | null; home?: string },
  list: (path: string) => string[] = path => readdirSync(path)): CheckoutPool {
  const own = options.worktree === null ? null : real(options.worktree);
  const home = real(options.home ?? homedir());
  const binding = options.binding ?? null;
  const needed = binding === null ? [] : [realpathSync(binding.gitdir), realpathSync(join(binding.main, ".git"))];
  const deny = new Set<string>();
  const visited = new Set<string>();
  const split = (input: string): void => {
    const path = realpathSync(input);
    if (visited.has(path)) return;
    visited.add(path);
    if (!needed.some(target => target === path || inside(target, path))) { deny.add(path); return; }
    if (needed.includes(path)) return;
    const entries = list(path); // An unreadable pool must refuse preparation, never silently widen access.
    for (const entry of entries) split(join(path, entry));
  };
  for (const root of options.roots) {
    if (root === null || !existsSync(root)) continue;
    const path = real(root);
    if (path === dirname(path) || path === home || inside(home, path) || (own !== null && (path === own || inside(path, own)))) continue;
    split(path);
  }
  const holding = own === null ? [] : [...deny].filter(path => inside(own, path));
  const lookup = new Set<string>([...visited].filter(path => needed.some(target => inside(target, path))));
  for (const path of holding) for (let folder = dirname(own!); folder === path || inside(folder, path); folder = dirname(folder)) lookup.add(folder);
  return { deny: [...deny].sort(), own: holding.length === 0 ? null : own, lookup: [...lookup].sort(), ...(needed.length === 0 ? {} : { gitPaths: needed }) };
}

/** The grants for one build: its task boundary's git rules, the shared dependencies its checkout links, and the
 * checkout pools (`poolRoots`, from the plane's records) denied around its own checkout. */
export function fenceGrants(options: { databaseFile: string | null; worktree: string | null; boundary?: TaskBoundary | null; runFolders?: RunFolders;
  linked?: { repo: string; setupDigest: string | null } | null; poolRoots?: readonly (string | null)[]; binding?: WorktreeBinding | null; home?: string }): FenceGrants {
  const readable: string[] = [];
  const lookup = [...options.boundary?.lookup ?? []];
  if (options.databaseFile !== null && options.databaseFile !== "" && options.databaseFile !== ":memory:" && options.worktree !== null && options.linked != null) {
    // The link note names the copy as the plane wrote it; the sandbox sees real paths. The note is in the build's own
    // checkout, so it is only a hint: the copy must be a ready one the plane made for this run's project under the
    // setup it stamped on this checkout, or nothing is granted.
    const written = join(dirname(options.databaseFile), DEPS_FOLDER);
    const deps = join(dirname(real(options.databaseFile)), DEPS_FOLDER);
    const key = linkedKey(options.worktree, written) ?? linkedKey(options.worktree, deps);
    const linked = options.linked;
    const copy = key === null || !/^[0-9a-f]{24}$/.test(key) ? undefined : sharedCopies(deps).find(one => one.key === key);
    const ours = copy !== undefined && !copy.retired && copy.repo === linked.repo && linked.setupDigest !== null && readySetup(deps, key!) === linked.setupDigest && readyCopy(deps, key!) !== null;
    if (ours && key !== null && existsSync(join(deps, key, "node_modules"))) {
      lookup.push(deps, join(deps, key));
      readable.push(join(deps, key, "node_modules"));
    }
  }
  const pool = options.poolRoots === undefined ? undefined : checkoutPool({ roots: options.poolRoots, worktree: options.worktree, binding: options.binding ?? null, ...(options.home === undefined ? {} : { home: options.home }) });
  return { readOnly: [...options.boundary?.readOnly ?? []], readable, lookup: [...new Set(lookup)].sort(), ...(options.runFolders === undefined ? {} : { runFolders: options.runFolders }),
    ...(pool === undefined || pool.deny.length === 0 ? {} : { pool }) };
}

/** The setup a shared copy was installed by (its ready note), or null. */
function readySetup(deps: string, key: string): string | null {
  try { const setup = (JSON.parse(readFileSync(join(deps, key, "ready.json"), "utf8")) as { setup?: unknown }).setup; return typeof setup === "string" ? setup : null; } catch { return null; }
}

/**
 * Git settings every fenced build runs with (GIT_CONFIG_COUNT, after any the
 * caller already set): `git gc` never expires a reflog, so it never rewrites
 * another task's reflog, which the fence would refuse mid-collection.
 */
export function fencedGitEnv(base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const count = Number.parseInt(base["GIT_CONFIG_COUNT"] ?? "0", 10);
  const start = Number.isInteger(count) && count > 0 ? count : 0;
  const settings = [["gc.reflogExpire", "never"], ["gc.reflogExpireUnreachable", "never"]] as const;
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(start + settings.length) };
  settings.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${start + index}`] = key; env[`GIT_CONFIG_VALUE_${start + index}`] = value; });
  return env;
}

/** The repository a git worktree belongs to (its `.git` file names the main repository's git folder). */
function worktreeGitDir(worktree: string): string | null {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(worktree, ".git"), "utf8"))?.[1]?.trim();
    return pointer === undefined ? null : real(isAbsolute(pointer) ? pointer : join(worktree, pointer));
  } catch {
    return null;
  }
}

const toml = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Codex's own sandbox, fenced. Auto: the `:workspace` profile Codex's
 * `--sandbox workspace-write` already gives (workspace and temp writes, no
 * network). Full access: the same profile widened to write anywhere with
 * network on, instead of no sandbox at all. Either way the fenced paths are
 * denied, which in Codex outranks any write or read grant. The checkout pools
 * are never `flattened` (which leaves what is made after launch readable): see
 * `codexPool`, which denies them around the build's own checkout, written back.
 */
export function codexFenceArgv(fence: readonly string[], fullAccess: boolean, grants: FenceGrants = NO_GRANTS): string[] {
  const { deny, readOnly } = flattened(fence, grants);
  // Codex's harness reads its own launch files outside the command sandbox.
  // Deny the namespace, including folders created after this policy was built.
  if (grants.runFolders !== undefined) {
    for (const prefix of RUN_FOLDER_PREFIXES) {
      deny.push(join(grants.runFolders.root, `${prefix}*`), join(grants.runFolders.root, `${prefix}*`, "**"));
    }
  }
  // Launch folders can already be in the base fence when invoke appends them.
  // TOML forbids duplicate keys, even with identical values. Normalize aliases
  // at this boundary and apply stronger access restrictions last.
  const access = new Map<string, "write" | "read" | "deny">();
  const pool = grants.pool;
  // Codex lets the more specific path win: no read grant inside a pool, but the build's own checkout.
  const pooled = (path: string) => pool !== undefined && pool.deny.some(one => path === one || inside(path, one))
    && !(pool.own !== null && (path === pool.own || inside(path, pool.own)));
  // Full access writes anywhere its fence allows, unless the build writes only its workspace (arc 2): then exactly its
  // allowlist, in either mode, beside the workspace Codex's own profile gives.
  // Codex's own workspace profile also writes the shared temp folders; a workspace build starts from its read-only
  // profile instead, with exactly the allowlist (its checkout among it) written back.
  if (grants.writes !== undefined) for (const path of grants.writes.subpaths) access.set(real(path), "write");
  else if (fullAccess) access.set("/", "write");
  for (const path of readOnly) if (!pooled(real(path))) access.set(real(path), "read");
  if (pool !== undefined) {
    const held = codexPool(pool);
    for (const path of held.read) access.set(path, "read");
    for (const path of held.deny) access.set(path, "deny");
    for (const path of held.write) access.set(path, "write");
  }
  // Denies are keyed where they resolve; the console's run folder is also denied by its own pathname, so a link there
  // stays unreplaceable, not only its target.
  for (const path of deny) { access.set(real(path), "deny"); if (basename(path) === INSTANCE_DIR) access.set(path, "deny"); }
  const filesystem = [...access].map(([path, mode]) => `${toml(path)}=${toml(mode)}`);
  return [
    "-c", 'default_permissions="standing-orders"',
    "-c", `permissions.standing-orders.extends=${grants.writes === undefined ? '":workspace"' : '":read-only"'}`,
    "-c", `permissions.standing-orders.filesystem={${filesystem.join(",")}}`,
    // Codex's command sandbox can't route through a proxy: its commands reach the network only when the run's sealed
    // network is open (and Full access asked for it), and are offline otherwise.
    ...(fullAccess && (grants.network === undefined || grants.network.mode === "open") ? ["-c", "permissions.standing-orders.network.enabled=true"] : []),
    ...(fullAccess ? ["-c", 'approval_policy="never"'] : []),
  ];
}

/**
 * Codex cannot deny an ancestor and still traverse it to the own checkout. Deny existing
 * siblings individually, from the trusted pool roots and a fresh listing, never through
 * flattened or name patterns. A project added after launch is covered on the next launch;
 * Seatbelt and bubblewrap retain the stronger whole-pool rule for later-created projects.
 */
export function codexPool(pool: CheckoutPool, list: (path: string) => string[] = path => readdirSync(path)): { read: string[]; deny: string[]; write: string[] } {
  const deny = new Set<string>();
  const read = new Set(pool.lookup);
  const own = pool.own;
  const needed = [...pool.gitPaths ?? [], ...(own === null ? [] : [own])].map(path => realpathSync(path));
  const visited = new Set<string>();
  const split = (input: string): void => {
    let path: string;
    try { path = realpathSync(input); } catch { deny.add(resolve(input)); return; }
    if (visited.has(path)) return;
    visited.add(path);
    if (needed.some(target => path === target || inside(path, target))) return;
    if (!needed.some(target => inside(target, path))) { deny.add(path); return; }
    // Only ancestors needed for traversal stay readable, never writable in Full access.
    read.add(path);
    for (const entry of list(path)) split(join(path, entry));
  };
  for (const root of pool.deny) split(root);
  return { read: [...read].sort(), deny: [...deny].sort(), write: own === null ? [] : [own] };
}

/** Secret-looking names denied by pattern inside a folder `flattened` makes read-only, so one written there after
 * launch is denied too (the database and its journals, tokens, login and other text files). */
export const SPLIT_SECRET_PATTERNS = ["orders.db*", "*token*", "up-login*", "*.txt", "*secret*", "*password*", "*credential*", "*.pem", "*.key"] as const;

/**
 * A fence as plain denied and read-only paths, for a sandbox that can't
 * grant inside a denied folder (Codex: a deny outranks any grant): a denied
 * folder holding something readable becomes read-only, with each of its
 * entries not on the way to what is readable denied instead. Fails closed: a
 * folder that can't be listed stays denied whole and its grant is dropped.
 * Residual: an entry made after launch in a read-only folder is denied only
 * when its name matches SPLIT_SECRET_PATTERNS; any other new entry there is
 * readable (never writable) until the next launch. The macOS fence has no
 * such gap: it denies the folder and grants back only the readable path.
 */
export function flattened(fence: readonly string[], grants: FenceGrants = NO_GRANTS, list: (path: string) => string[] = path => readdirSync(path)): { deny: string[]; readOnly: string[] } {
  const deny: string[] = [];
  const readOnly = new Set(grants.readOnly);
  const split = (path: string): void => {
    const within = grants.readable.filter(one => inside(one, path));
    if (within.length === 0) { deny.push(path); return; }
    let entries: string[];
    try { entries = list(path); } catch (error) {
      deny.push(path);
      process.stderr.write(`toolroll: fence: couldn't list ${path} (${error instanceof Error ? error.message : String(error)}); it stays denied and the shared dependencies inside it aren't granted\n`);
      return;
    }
    readOnly.add(path);
    for (const pattern of SPLIT_SECRET_PATTERNS) deny.push(join(path, pattern));
    for (const entry of entries) {
      const child = join(path, entry);
      if (grants.readable.includes(child)) readOnly.add(child);
      else split(child);
    }
  };
  for (const path of fence) split(path);
  // Fail closed: a grant equal to or inside a denied path is dropped, so no read grant can outrank a deny (Codex lets
  // the more specific path win). Patterns stay as Codex patterns; they can't contain a grant here.
  const denied = deny.filter(path => !path.includes("*"));
  return { deny, readOnly: [...readOnly].filter(path => !denied.some(one => path === one || inside(path, one))) };
}

/** Claude's own file tools refuse the fenced paths in every mode (its shell is fenced by the macOS sandbox), and
 * never edit a read-only one. */
export function claudeFenceSettings(fence: readonly string[], readOnly: readonly string[] = []): string {
  const rules = [...fence.flatMap(path => [`Read(/${path})`, `Read(/${path}/**)`, `Edit(/${path})`, `Edit(/${path}/**)`]), ...readOnly.flatMap(path => [`Edit(/${path})`, `Edit(/${path}/**)`])];
  return JSON.stringify({ permissions: { deny: rules } });
}

const seatbelt = (path: string) => `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const seatbeltRegex = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The folders the user owns above each path (never `/`, nor the path itself), and each `roots` folder itself when the
 * user owns it. A Seatbelt path rule follows the name, not the folder: renaming one of these would bring a fenced path
 * back under a name no rule mentions. A folder the user doesn't own can't be renamed by a build anyway.
 */
export function ownedAncestors(paths: readonly string[], roots: readonly string[] = [], uid: number | undefined = process.getuid?.()): string[] {
  const out = new Set<string>();
  const owned = (path: string) => { try { return uid !== undefined && statSync(path).uid === uid; } catch { return false; } };
  const climb = (from: string) => {
    for (let folder = from; folder !== dirname(folder); folder = dirname(folder)) if (owned(folder)) out.add(folder);
  };
  for (const path of paths) climb(dirname(path));
  for (const root of roots) climb(root);
  return [...out].sort();
}

/**
 * A Seatbelt profile that allows everything except reading or writing the
 * fenced paths, less what `grants` gives back (a later Seatbelt rule
 * outranks an earlier one). Whatever the paths, the process can't read
 * another's arguments and environment (`kern.procargs`, which `ps -E` and
 * KERN_PROCARGS2 use) or inspect a process outside its own sandbox:
 * `process-info*` limited by target alone doesn't stop the sysctl. It can't
 * take another process's task port either (`task_for_pid`, what lldb attaches
 * with; a task name port too), so a tool server's or Toolroll's own memory
 * and environment stay out of reach. Last, every folder of the user's above
 * a fenced or read-only path and above the temp folder (and the temp folder
 * itself) can't be renamed or removed, though what is inside them stays
 * writable as before. The checkout pools are denied first, and the build's own
 * checkout given back right after, so every later deny still holds inside it.
 */
export function macosFenceProfile(fence: readonly string[], grants: FenceGrants = NO_GRANTS): string {
  const paths = (filter: "subpath" | "literal", list: readonly string[]) => list.map(path => `(${filter} ${seatbelt(path)})`).join(" ");
  const folders = grants.runFolders;
  const pool = grants.pool;
  const above = ownedAncestors([...fence, ...grants.readOnly, ...pool?.deny ?? []], [folders?.root ?? real(tmpdir())]);
  return [
    "(version 1)",
    "(allow default)",
    // A workspace build writes only its allowlist (and the terminal devices); every deny and read-only rule after this
    // still holds inside it.
    ...(grants.writes === undefined ? [] : [
      "(deny file-write*)",
      `(allow file-write* (subpath "/dev")${grants.writes.subpaths.length === 0 ? "" : ` ${paths("subpath", grants.writes.subpaths)}`}${grants.writes.prefixes.map(one => ` (regex #"^${seatbeltRegex(one.path)}${one.suffix}")`).join("")})`,
      // A granted folder itself can't be renamed, removed or replaced (by a link to anywhere, say): only what is in it.
      ...(grants.writes.subpaths.length === 0 ? [] : [`(deny file-write* ${paths("literal", grants.writes.subpaths)})`]),
    ]),
    ...(pool === undefined || pool.deny.length === 0 ? [] : [`(deny file-read* file-write* ${paths("subpath", pool.deny)})`]),
    ...(pool?.own == null ? [] : [
      `(allow file-read* file-write* ${paths("subpath", [pool.own])})`,
      `(deny file-write* ${paths("literal", [pool.own])})`,
    ]),
    ...(pool === undefined || pool.lookup.length === 0 ? [] : [`(allow file-read-metadata ${paths("literal", pool.lookup)})`]),
    ...(fence.length === 0 ? [] : [`(deny file-read* file-write* ${paths("subpath", fence)})`]),
    ...(grants.readOnly.length === 0 ? [] : [`(deny file-write* ${paths("subpath", grants.readOnly)})`]),
    ...(folders === undefined ? [] : [`(deny file-read* file-write* (regex #"^${seatbeltRegex(folders.root)}/(${RUN_FOLDER_PREFIXES.map(seatbeltRegex).join("|")})"))`]),
    ...(grants.lookup.length === 0 ? [] : [`(allow file-read-metadata ${paths("literal", grants.lookup)})`]),
    // Denied whole above, granted back narrowly here (a later rule wins): an entry made after launch beside it stays denied.
    ...(grants.readable.length === 0 ? [] : [`(allow file-read* file-test-existence ${paths("subpath", grants.readable)})`]),
    ...(folders?.own == null ? [] : [`(allow file-read* file-write* ${paths("subpath", [folders.own])})`]),
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
    "(deny process-info-pidinfo)",
    "(allow process-info-pidinfo (target same-sandbox))",
    "(deny mach-priv-task-port)",
    "(deny mach-task-name)",
    ...(above.length === 0 ? [] : [`(deny file-write* ${paths("literal", above)})`]),
    ...macosNetworkRules(grants.network),
    // A workspace build reaches no unix socket but its own (a container engine's, an agent's, a database's would act
    // outside its limits for it), whatever its network: a confined network has its own rule for this already.
    ...(grants.writes === undefined || grants.network?.mode === "allowlist" ? [] : [
      "(deny network-outbound (remote unix-socket))",
      ...(grants.writes.subpaths.length === 0 ? [] : [`(allow network-outbound ${grants.writes.subpaths.map(root => `(remote unix-socket (subpath ${seatbelt(root)}))`).join(" ")})`]),
    ]),
  ].join("\n");
}

/**
 * The network half of the macOS fence. Every outbound connection is denied, then loopback is given back as the launch
 * allows: every local port under `loopback: "any"`, else the run's proxy and broker alone. (Seatbelt admits a port an
 * allow names whatever a deny after it says, so a local port can't be refused once all are admitted: the choice is all
 * or none, plus the run's own.) Filters name the remote end only: a `local ip` filter would admit any outbound
 * connection.
 */
export function macosNetworkRules(network: NetworkFence | undefined): string[] {
  if (network === undefined || network.mode === "open") return [];
  const local = (port: number | "*") => `(remote ip "localhost:${port}")`;
  return [
    "(deny network-outbound)",
    `(allow network-outbound ${network.loopback === "any" ? local("*") : [network.proxyPort, ...network.brokerPorts].map(local).join(" ")})`,
    ...(network.socketRoots.length === 0 ? [] : [`(allow network-outbound ${network.socketRoots.map(root => `(remote unix-socket (subpath ${seatbelt(root)}))`).join(" ")})`]),
    `(deny mach-lookup ${DELEGATION_SERVICES.map(name => `(global-name ${seatbelt(name)})`).join(" ")})`,
  ];
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** A process already inside a Seatbelt sandbox (an agent's, or a flow check zone's) can't apply another: sandbox-exec says so. */
const NESTED_SANDBOX = /sandbox_apply: Operation not permitted/;
let seatbeltWorks: boolean | null = null;
/**
 * Whether this machine can run an agent inside the macOS fence (checked once). Not from inside another
 * sandbox: a Toolroll a fenced process starts (the end-to-end journeys a flow's check zone runs) can't nest
 * its fence, and would otherwise fail every launch. Its agents stay inside the outer fence, which every
 * child inherits, and are recorded with the fence they actually got. Any other probe failure keeps the
 * fence on, so a launch fails loudly rather than running unfenced.
 */
export function macosFenceAvailable(platform: NodeJS.Platform = process.platform, probe?: () => { status: number | null; stderr: string }): boolean {
  if (platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return false;
  const works = (check: () => { status: number | null; stderr: string }) => {
    try { const ran = check(); return !(ran.status !== 0 && NESTED_SANDBOX.test(ran.stderr)); } catch { return true; }
  };
  if (probe !== undefined) return works(probe);
  seatbeltWorks ??= works(() => {
    const ran = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { timeout: 5_000, encoding: "utf8" });
    return { status: ran.status, stderr: ran.stderr ?? "" };
  });
  return seatbeltWorks;
}

/** The spawn that runs `file args` inside the macOS fence (same process: sandbox-exec replaces itself with the agent). */
export function macosFenced(file: string, args: readonly string[], fence: readonly string[], grants: FenceGrants = NO_GRANTS): { file: string; args: string[] } {
  return { file: SANDBOX_EXEC, args: ["-p", macosFenceProfile(fence, grants), file, ...args] };
}

/** Whether bubblewrap runs here (checked once): installed, and allowed to make its namespace. */
let bubblewrapWorks: boolean | null = null;
export function linuxFenceAvailable(platform: NodeJS.Platform = process.platform, probe: () => boolean = () => spawnSync("bwrap", ["--dev-bind", "/", "/", "--", "true"], { timeout: 5_000, stdio: "ignore" }).status === 0): boolean {
  if (platform !== "linux") return false;
  if (bubblewrapWorks === null) { try { bubblewrapWorks = probe(); } catch { bubblewrapWorks = false; } }
  return bubblewrapWorks;
}

/** A secret-name pattern (SPLIT_SECRET_PATTERNS) as a test of one path segment. */
const patternTest = (pattern: string) => new RegExp(`^${pattern.split("*").map(seatbeltRegex).join(".*")}$`);
const SECRET_SEGMENT = SPLIT_SECRET_PATTERNS.map(patternTest);

/**
 * The grants bubblewrap may bind back over its masks: each existing read-only or readable path, never one that is a
 * fenced path itself, a read-only one inside a fenced path (only the shared install this run links is read inside
 * one), another launch's private folder, or one with a secret-looking name below its fenced folder. Bubblewrap can't
 * mask by pattern, so a grant a pattern would deny is dropped instead (fail closed).
 */
function linuxGrants(fence: readonly string[], grants: FenceGrants): string[] {
  const folders = grants.runFolders;
  const launchFolder = (path: string) => folders !== undefined && inside(path, folders.root) && path !== folders.own && !(folders.own != null && inside(path, folders.own))
    && RUN_FOLDER_PREFIXES.some(prefix => relative(folders.root, path).split(sep)[0]!.startsWith(prefix));
  const secretBelow = (path: string) => fence.some(one => inside(path, one) && relative(one, path).split(sep).some(segment => SECRET_SEGMENT.some(test => test.test(segment))));
  const ok = (path: string, readOnlyGrant: boolean) => existsSync(path) && !fence.includes(path) && !launchFolder(path) && !secretBelow(path)
    && !(readOnlyGrant && fence.some(one => inside(path, one)));
  return [...new Set([...grants.readOnly.filter(path => ok(path, true)), ...grants.readable.filter(path => ok(path, false))])];
}

/** The spawn that runs `file args` inside the Linux fence: the whole filesystem as it is, the checkout pools masked
 * and the build's own checkout bound back read-write over them, then every fenced path masked whole (an empty
 * folder, or /dev/null for a file), so what is made there after launch is masked too; then only the explicit grants
 * bound back read-only (bubblewrap binds from the original root, so a grant inside a mask still reaches its files). */
export function linuxFenced(file: string, args: readonly string[], fence: readonly string[], grants: FenceGrants = NO_GRANTS): { file: string; args: string[] } {
  const network = grants.network?.mode === "allowlist" ? grants.network : null;
  if (network !== null && network.bridge === undefined) throw new Error("A confined network on Linux needs its bridge");
  const mask = (path: string) => {
    let folder = true;
    try { folder = statSync(path).isDirectory(); } catch { folder = true; }
    return folder ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path];
  };
  const pool = grants.pool?.deny ?? [];
  const own = grants.pool?.own != null && existsSync(grants.pool.own) ? ["--bind", grants.pool.own, grants.pool.own] : [];
  const kept = linuxGrants([...fence, ...pool], grants).flatMap(path => ["--ro-bind", path, path]);
  // A confined network: a network and a process view of its own, the host's sockets out of reach (a socket in a
  // mounted folder is not network, so they are masked), and the run's proxy and broker carried in by the forwarder.
  const isolated = network === null ? [] : [
    "--unshare-net", "--unshare-pid", "--proc", "/proc",
    ...linuxHostSockets().flatMap(mask),
    "--ro-bind", network.bridge!.folder, network.bridge!.folder,
  ];
  // A confined build gets a /tmp of its own (other programs' sockets, other runs' folders and anything planted there
  // all out of sight at once), with only its own folders there given back; every mask and grant below still applies.
  // A workspace build (arc 2) sees the whole filesystem read-only, a /dev of its own and a /tmp of its own, with only
  // its allowlist bound back writable; its own checkout's Git data is in that list.
  const writes = grants.writes;
  const root = writes === undefined ? ["--dev-bind", "/", "/"] : ["--ro-bind", "/", "/", "--dev", "/dev"];
  const writable = writes === undefined ? [] : [...writes.subpaths, ...writes.prefixes.map(one => one.path)].filter(path => existsSync(path)).flatMap(path => ["--bind", path, path]);
  // What a private /tmp gives back is read-only for a workspace build (its writable part is bound again after): the
  // checkout's whole shared Git data among it must not come back writable.
  const privateTmp = network === null && writes === undefined ? [] : ["--tmpfs", "/tmp", ...(network?.keep ?? []).filter(path => inside(path, "/tmp") && existsSync(path)).flatMap(path => [writes === undefined ? "--bind" : "--ro-bind", path, path])];
  // A workspace build never reaches the host's own services either (a container engine would write anywhere for it),
  // whatever its network: confined networks mask them below already.
  const services = writes === undefined || network !== null ? [] : linuxHostSockets().flatMap(mask);
  const command = network === null ? [file, ...args]
    : [network.bridge!.node, network.bridge!.forwarder, network.bridge!.folder, ...[network.proxyPort, ...network.brokerPorts].map(String), "--", file, ...args];
  return { file: "bwrap", args: [...root, ...privateTmp, ...writable, ...pool.flatMap(mask), ...own, ...fence.flatMap(mask), ...kept, ...services, ...isolated, "--die-with-parent", "--", ...command] };
}

/** The host's own sockets a process in a mounted filesystem could still talk to (D-Bus, the display, container
 * engines), wherever they exist here. */
export function linuxHostSockets(uid: number | undefined = process.getuid?.(), home: string = homedir(), tmp: string = "/tmp"): string[] {
  // The system's own, root-owned: resolved (/var/run is a link to /run) so bubblewrap mounts over the real path, once.
  const system = [
    ...(uid === undefined ? [] : [`/run/user/${uid}`]), "/run/dbus", "/var/run/dbus", "/var/run/docker.sock", "/run/docker.sock", "/run/containerd", "/run/podman",
    "/var/run/podman", "/run/systemd/private", "/run/snapd.socket", "/run/screen",
  ];
  const masks = new Set<string>();
  for (const path of system) { try { masks.add(realpathSync(path)); } catch { /* not here */ } }
  // The user's own, in places a build could plant names: taken only as the real folders or sockets they are, never
  // through a link (a planted link would turn a mask onto any folder at all). Container engines
  // run per user (Docker Desktop and the docker CLI's folder whole, so a socket made there later is covered too;
  // Colima, OrbStack, Lima, Rancher Desktop, rootless containers); a terminal multiplexer takes commands from its
  // socket; an SSH agent signs as you; editors keep IPC sockets in /tmp (hidden by the build's private /tmp).
  // Masked whoever owns it (a folder `sudo docker` made is root's): only a link is never followed, since a link turns
  // a mask onto its target. A link there is a residual until builds can't write the home folder (arc 2).
  const owned = (path: string): boolean => {
    try { const held = lstatSync(path); return !held.isSymbolicLink() && (held.isDirectory() || held.isSocket()); } catch { return false; }
  };
  for (const path of [".docker", ".colima", ".orbstack", ".lima", ".rd", ".local/share/containers"].map(name => join(home, name))) if (owned(path)) masks.add(path);
  // /tmp's sockets (the display's, an SSH agent's, a multiplexer's, editors') go with the build's private /tmp.
  void tmp;
  return [...masks].sort();
}

/**
 * What each agent's fence gives it, by permission mode: the one table README's "What an agent can reach" shows
 * (fenceSummaryMarkdown; a test holds them equal).
 */
export const FENCE_SUMMARY: readonly { agent: string; auto: string; full: string }[] = [
  {
    agent: "**Codex / OpenRouter** (any OS)",
    auto: "Codex's sandbox with the fence: writes only the checkout, its Git data and the project's caches (anywhere outside the fence, under a project set to write anywhere); no network",
    full: "the same writes, with the fence; its commands reach the network only when the project's network is open",
  },
  {
    agent: "**Claude, Gemini, ACP agents**",
    auto: "macOS: inside a Seatbelt sandbox that denies the fence and writes only the checkout, its Git data, the project's caches, the run's temp folder and the agent's own session files. Linux: the same in bubblewrap, with a /tmp of its own. Neither (Windows, or Linux without bubblewrap): the build doesn't start, unless an instance operator allows unconfined agents",
    full: "same",
  },
];

/** FENCE_SUMMARY as README's markdown table. */
export function fenceSummaryMarkdown(): string {
  return ["| | Auto | Full access |", "|---|---|---|", ...FENCE_SUMMARY.map(row => `| ${row.agent} | ${row.auto} | ${row.full} |`)].join("\n");
}
