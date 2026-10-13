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
 * written. On macOS the agent also can't read another process's arguments
 * and environment (`kern.procargs`) or inspect a process outside its own
 * sandbox, so a tool server's or Toolroll's own secrets don't leak through
 * a process listing, and every other run's launch folder in the system temp
 * folder is denied, even one made after this launch began. Nor can it get
 * another process's task port (a debugger's way into its memory), or
 * rename or remove a folder of the user's above a fenced path or the temp
 * folder, which would reach the fenced path under a new name.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readMonitoring } from "./monitoring-settings.js";
import { existingFolders } from "./names.js";
import { DEPS_FOLDER, linkedKey, readyCopy, sharedCopies } from "./shared-deps.js";

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

/**
 * Every path an agent must not reach: the Toolroll state folder
 * beside the database (all of it, except the folder that holds this run's
 * own worktree), the database itself with its journal files, and
 * `~/.toolroll` or an older `~/.standing-orders` (provider keys and project tool secrets). When the
 * database sits anywhere else (a shared folder), only the database and
 * secret-looking entries there are fenced.
 */
export function agentFence(options: { databaseFile: string | null; worktree: string | null; home?: string; extra?: readonly string[]; boundary?: TaskBoundary | null; runFolders?: RunFolders }): string[] {
  const fence = new Set<string>();
  const home = real(options.home ?? homedir());
  const worktree = options.worktree === null ? null : real(options.worktree);
  if (options.databaseFile !== null && options.databaseFile !== "" && options.databaseFile !== ":memory:") {
    const database = real(options.databaseFile);
    const state = dirname(database);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) if (existsSync(database + suffix)) fence.add(database + suffix);
    // Only a folder that is Toolroll's own (~/.config/toolroll or an older name,
    // the desktop app's "Toolroll") is fenced whole: a database kept
    // in a shared folder (a projects folder, a test's temp folder) must not
    // fence its neighbours, the repositories agents build among them.
    const dedicated = state !== home && state !== sep && !existsSync(join(state, ".git")) && /standing[\s_-]?orders|toolroll|nightorders/i.test(basename(state));
    // The entries this run's worktree needs stay reachable: the one it lives
    // under, and the repository its git metadata belongs to.
    const keep = new Set<string>();
    for (const needed of [worktree, worktree === null ? null : mainRepositoryOf(worktree)]) {
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
  for (const path of options.boundary?.shell ?? []) fence.add(path);
  if (options.runFolders !== undefined) for (const path of otherRunFolders(options.runFolders)) fence.add(path);
  // Never fence the run's own worktree or anything above it.
  return [...fence].filter(path => worktree === null || (path !== worktree && !inside(worktree, path))).sort();
}

/**
 * Credentials and agent configuration in the home folder. A build is the
 * operator's own OS user, so without this it could read their SSH keys,
 * cloud logins or another agent's sign-in, or rewrite their own Claude or
 * Codex setup for the next interactive session.
 */
const HOME_CONFIGURATION = [".claude", ".claude.json", ".codex", ".gemini", ".ssh", ".aws", ".gnupg", ".netrc", ".git-credentials", ".kube", join(".config", "gh"), join(".docker", "config.json")];
/** What a provider's own CLI reads to sign in and keep its sessions. The OS fence around Claude and Gemini holds
 * their whole process, so those stay reachable there; Codex fences only its agent's commands, so it keeps none. */
const PROVIDER_HOME: Record<string, readonly string[]> = { claude: [".claude", ".claude.json"], gemini: [".gemini"], codex: [], openrouter: [] };
/** What Claude's own file tools refuse inside its home: the CLI reads these itself, its model never needs to. */
const CLAUDE_FILE_TOOL_HOME = [".claude.json", join(".claude", ".credentials.json"), join(".claude", "settings.json"), join(".claude", "settings.local.json"), ".npmrc"];

/** The task's boundary: `shell` joins the OS fence; `fileTools` only Claude's file-tool deny rules; `readOnly` and
 * `lookup` are other tasks' git metadata and checkout roots (see FenceGrants). */
export type TaskBoundary = { shell: string[]; fileTools: string[]; readOnly: string[]; lookup: string[] };

/**
 * Everything outside a task's own folders that a build could otherwise
 * reach: the home configuration above, the other repositories beside its
 * project (and other tasks' worktrees beside its own), and the project's
 * primary checkout — all but its `.git`, which the worktree's git needs.
 * The task's worktree, the files Toolroll makes for the run (in the
 * system temp folder) and everything else stay as they are.
 */
export function taskBoundary(options: { worktree: string; provider: string; home?: string }): TaskBoundary {
  const home = real(options.home ?? homedir());
  const worktree = real(options.worktree);
  const main = mainRepositoryOf(worktree);
  const own = new Set(PROVIDER_HOME[options.provider] ?? []);
  const present = (names: readonly string[]) => names.map(name => join(home, name)).filter(path => existsSync(path)).map(real);
  const shell = new Set(present(HOME_CONFIGURATION.filter(name => !own.has(name))));
  const repository = (path: string) => existsSync(join(path, ".git"));
  for (const parent of new Set([dirname(worktree), ...(main === null ? [] : [dirname(main)])])) {
    // Home contains toolchain clones such as .nvm and .oh-my-zsh. The
    // explicit configuration fence above owns home, not repository discovery.
    if (real(parent) === home) continue;
    let entries: string[] = [];
    try { entries = readdirSync(parent); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const path = join(parent, entry);
      if (path === worktree || path === main || inside(worktree, path) || !repository(path)) continue;
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
  const gitdir = worktreeGitDir(worktree);
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
  return { shell: [...shell].sort(), fileTools: fileTools.sort(), readOnly: [...readOnly].sort(), lookup: [...lookup].sort() };
}

/** Where launches keep their private folders (the system temp folder), and this launch's own tool folder. */
export type RunFolders = { root: string; own: string | null };
/** The prefixes of every launch's private folders: its tools' config and a Codex build's own home. */
export const RUN_FOLDER_PREFIXES = ["so-tools-", "so-codex-"] as const;

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
 * this launch's own (macOS: by pattern, so a later one is denied too).
 */
export type FenceGrants = { readOnly: string[]; readable: string[]; lookup: string[]; runFolders?: RunFolders };
export const NO_GRANTS: FenceGrants = { readOnly: [], readable: [], lookup: [] };

/** The grants for one build: its task boundary's git rules, and the shared dependencies its checkout links. */
export function fenceGrants(options: { databaseFile: string | null; worktree: string | null; boundary?: TaskBoundary | null; runFolders?: RunFolders;
  linked?: { repo: string; setupDigest: string | null } | null }): FenceGrants {
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
  return { readOnly: [...options.boundary?.readOnly ?? []], readable, lookup: [...new Set(lookup)].sort(), ...(options.runFolders === undefined ? {} : { runFolders: options.runFolders }) };
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

function mainRepositoryOf(worktree: string): string | null {
  const gitdir = worktreeGitDir(worktree);
  if (gitdir === null) return null;
  // <repo>/.git/worktrees/<name> → <repo>
  const at = gitdir.lastIndexOf(`${sep}.git${sep}worktrees${sep}`);
  return at < 0 ? null : gitdir.slice(0, at);
}

const toml = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Codex's own sandbox, fenced. Auto: the `:workspace` profile Codex's
 * `--sandbox workspace-write` already gives (workspace and temp writes, no
 * network). Full access: the same profile widened to write anywhere with
 * network on, instead of no sandbox at all. Either way the fenced paths are
 * denied, which in Codex outranks any write or read grant.
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
  if (fullAccess) access.set("/", "write");
  for (const path of readOnly) access.set(real(path), "read");
  for (const path of deny) access.set(real(path), "deny");
  const filesystem = [...access].map(([path, mode]) => `${toml(path)}=${toml(mode)}`);
  return [
    "-c", 'default_permissions="standing-orders"',
    "-c", 'permissions.standing-orders.extends=":workspace"',
    "-c", `permissions.standing-orders.filesystem={${filesystem.join(",")}}`,
    ...(fullAccess ? ["-c", "permissions.standing-orders.network.enabled=true", "-c", 'approval_policy="never"'] : []),
  ];
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
 * writable as before.
 */
export function macosFenceProfile(fence: readonly string[], grants: FenceGrants = NO_GRANTS): string {
  const paths = (filter: "subpath" | "literal", list: readonly string[]) => list.map(path => `(${filter} ${seatbelt(path)})`).join(" ");
  const folders = grants.runFolders;
  const above = ownedAncestors([...fence, ...grants.readOnly], [folders?.root ?? real(tmpdir())]);
  return [
    "(version 1)",
    "(allow default)",
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
  ].join("\n");
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

/** The spawn that runs `file args` inside the Linux fence: the whole filesystem as it is, every fenced path masked
 * whole (an empty folder, or /dev/null for a file), so what is made there after launch is masked too; then only the
 * explicit grants bound back read-only (bubblewrap binds from the original root, so a grant inside a mask still
 * reaches its files). */
export function linuxFenced(file: string, args: readonly string[], fence: readonly string[], grants: FenceGrants = NO_GRANTS): { file: string; args: string[] } {
  const masks = fence.flatMap(path => {
    let folder = true;
    try { folder = statSync(path).isDirectory(); } catch { folder = true; }
    return folder ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path];
  });
  const kept = linuxGrants(fence, grants).flatMap(path => ["--ro-bind", path, path]);
  return { file: "bwrap", args: ["--dev-bind", "/", "/", ...masks, ...kept, "--die-with-parent", "--", file, ...args] };
}
