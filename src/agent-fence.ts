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
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readMonitoring } from "./monitoring-settings.js";
import { existingFolders } from "./names.js";

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
export function agentFence(options: { databaseFile: string | null; worktree: string | null; home?: string; extra?: readonly string[] }): string[] {
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
  // Never fence the run's own worktree or anything above it.
  return [...fence].filter(path => worktree === null || (path !== worktree && !inside(worktree, path))).sort();
}

/** The repository a git worktree belongs to (its `.git` file names the main repository's git folder). */
function mainRepositoryOf(worktree: string): string | null {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(worktree, ".git"), "utf8"))?.[1]?.trim();
    if (pointer === undefined) return null;
    const gitdir = real(isAbsolute(pointer) ? pointer : join(worktree, pointer));
    // <repo>/.git/worktrees/<name> → <repo>
    const marker = `${sep}.git${sep}worktrees${sep}`;
    const at = gitdir.lastIndexOf(marker);
    return at < 0 ? null : gitdir.slice(0, at);
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
 * denied, which in Codex outranks any write or read grant.
 */
export function codexFenceArgv(fence: readonly string[], fullAccess: boolean): string[] {
  const filesystem = [...(fullAccess ? ['"/"="write"'] : []), ...fence.map(path => `${toml(path)}="deny"`)];
  return [
    "-c", 'default_permissions="standing-orders"',
    "-c", 'permissions.standing-orders.extends=":workspace"',
    "-c", `permissions.standing-orders.filesystem={${filesystem.join(",")}}`,
    ...(fullAccess ? ["-c", "permissions.standing-orders.network.enabled=true", "-c", 'approval_policy="never"'] : []),
  ];
}

/** Claude's own file tools refuse the fenced paths in every mode (its shell is fenced by the macOS sandbox). */
export function claudeFenceSettings(fence: readonly string[]): string {
  const rules = fence.flatMap(path => [`Read(/${path})`, `Read(/${path}/**)`, `Edit(/${path})`, `Edit(/${path}/**)`]);
  return JSON.stringify({ permissions: { deny: rules } });
}

const seatbelt = (path: string) => `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** A Seatbelt profile that allows everything except reading or writing the fenced paths. */
export function macosFenceProfile(fence: readonly string[]): string {
  return ["(version 1)", "(allow default)", `(deny file-read* file-write* ${fence.map(path => `(subpath ${seatbelt(path)})`).join(" ")})`].join("\n");
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
export function macosFenced(file: string, args: readonly string[], fence: readonly string[]): { file: string; args: string[] } {
  return { file: SANDBOX_EXEC, args: ["-p", macosFenceProfile(fence), file, ...args] };
}

/** Whether bubblewrap runs here (checked once): installed, and allowed to make its namespace. */
let bubblewrapWorks: boolean | null = null;
export function linuxFenceAvailable(platform: NodeJS.Platform = process.platform, probe: () => boolean = () => spawnSync("bwrap", ["--dev-bind", "/", "/", "--", "true"], { timeout: 5_000, stdio: "ignore" }).status === 0): boolean {
  if (platform !== "linux") return false;
  if (bubblewrapWorks === null) { try { bubblewrapWorks = probe(); } catch { bubblewrapWorks = false; } }
  return bubblewrapWorks;
}

/** The spawn that runs `file args` inside the Linux fence: the whole filesystem as it is, except each fenced path masked. */
export function linuxFenced(file: string, args: readonly string[], fence: readonly string[]): { file: string; args: string[] } {
  const masks = fence.flatMap(path => {
    let folder = true;
    try { folder = statSync(path).isDirectory(); } catch { folder = true; }
    return folder ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path];
  });
  return { file: "bwrap", args: ["--dev-bind", "/", "/", ...masks, "--die-with-parent", "--", file, ...args] };
}
