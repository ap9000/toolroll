import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { run } from "./exec.js";
import { ENV, ENV_ALLOWLIST } from "./remote-main.js";
import { checkoutGit, refusal, TEARDOWN_FLAGS, viewedGitSync } from "./teardown-git.js";

const execFileAsync = promisify(execFile);

const EXTRA_DIRECT_CHAT_GIT_FLAGS: readonly string[] = [
  ...TEARDOWN_FLAGS,
  "-c", "diff.external=",
  "-c", "core.attributesfile=/dev/null",
  "-c", "transfer.fsckObjects=true",
];

function cleanGitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: homedir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

export function sha256Buffer(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Buffer(readFileSync(path));
}

export function pinnedConfigBackupPath(realGitDir: string): string {
  return `${realGitDir}.pinned-config`;
}

function hasCommonDirEntry(realGitDir: string): boolean {
  try {
    lstatSync(join(realGitDir, "commondir"));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * Single containment guard called by EVERY write/mutating Direct Chat operation.
 * Proves `clonePath` is a non-empty real directory strictly inside
 * `<stateRoot>/direct-chat/clones` (never the user's real repo checkout).
 */
export function assertManagedClonePath(stateRoot: string, clonePath: string): { ok: true; realClone: string } | { ok: false; error: string } {
  if (!clonePath || clonePath.trim() === "") {
    return { ok: false, error: "This chat has no isolated clone workspace (read-only)." };
  }
  const clonesRoot = join(stateRoot, "direct-chat", "clones");
  if (!existsSync(clonesRoot) || !existsSync(clonePath)) {
    return { ok: false, error: "This chat's isolated clone workspace does not exist." };
  }
  try {
    const st = lstatSync(clonePath);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return { ok: false, error: "Chat workspace must be a real directory, not a symlink." };
    }
    const realRoot = realpathSync(clonesRoot);
    const realClone = realpathSync(clonePath);
    const rel = relative(realRoot, realClone);
    if (rel === "" || rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..${"\\"}`) || isAbsolute(rel)) {
      return { ok: false, error: "Chat workspace path is outside Toolroll's isolated clones folder." };
    }
    return { ok: true, realClone };
  } catch {
    return { ok: false, error: "Could not verify chat workspace location." };
  }
}

export type TrustedCloneBinding = {
  stateRoot: string;
  clonePath: string;
  gitDir: string;
  configSha256: string;
};

/**
 * Verifies the separate git-dir binding AND pinned `<gitDir>/config` SHA-256
 * before Toolroll runs ANY `git` subprocess against a chat clone.
 * Blocks `.git/config` command execution (`diff.external`, `filter.*.clean`,
 * `include.path`, `core.hooksPath`, `core.fsmonitor`, etc.) even if an agent
 * tampers with the clone's `.git` pointer or tries to edit the config file.
 */
export function assertTrustedCloneGit(binding: TrustedCloneBinding): { ok: true; realClone: string; realGitDir: string } | { ok: false; error: string } {
  const managed = assertManagedClonePath(binding.stateRoot, binding.clonePath);
  if (!managed.ok) return managed;

  if (!binding.gitDir || !binding.configSha256) {
    return { ok: false, error: "Chat clone is missing its trusted separate git-dir or pinned config hash." };
  }
  const gitDirsRoot = join(binding.stateRoot, "direct-chat", "gitdirs");
  if (!existsSync(gitDirsRoot) || !existsSync(binding.gitDir)) {
    return { ok: false, error: "Chat clone's separate git-dir is missing." };
  }
  try {
    const gdStat = lstatSync(binding.gitDir);
    if (!gdStat.isDirectory() || gdStat.isSymbolicLink()) {
      return { ok: false, error: "Chat git-dir must be a real directory, not a symlink." };
    }
    const realGdRoot = realpathSync(gitDirsRoot);
    const realGitDir = realpathSync(binding.gitDir);
    const relGd = relative(realGdRoot, realGitDir);
    if (relGd === "" || relGd === ".." || relGd.startsWith(`..${"/"}`) || relGd.startsWith(`..${"\\"}`) || isAbsolute(relGd)) {
      return { ok: false, error: "Chat git-dir is outside Toolroll's managed gitdirs folder." };
    }

    // Refuse if `<gitDir>/commondir` exists (file, directory, or symlink): git would redirect
    // config lookups to an unchecked folder outside the pinned `<gitDir>/config`.
    if (hasCommonDirEntry(realGitDir)) {
      return { ok: false, error: "Chat git-dir contains an unexpected commondir redirect; repair the workspace git binding to continue." };
    }

    // Verify `<clonePath>/.git` is a regular file pointing strictly at `realGitDir`.
    const dotGit = join(managed.realClone, ".git");
    const dgStat = lstatSync(dotGit);
    if (!dgStat.isFile() || dgStat.isSymbolicLink()) {
      return { ok: false, error: "Chat clone's .git pointer was replaced or tampered with; repair the workspace git binding to continue." };
    }
    const pointerText = readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointerText);
    if (match === null) {
      return { ok: false, error: "Chat clone's .git pointer is malformed; repair the workspace git binding to continue." };
    }
    const pointedReal = realpathSync(resolve(managed.realClone, match[1]!.trim()));
    if (pointedReal !== realGitDir) {
      return { ok: false, error: "Chat clone's .git pointer no longer matches Toolroll's trusted git-dir; repair the workspace git binding to continue." };
    }

    // Verify `<gitDir>/config` is a regular file matching the pinned SHA-256.
    const configPath = join(realGitDir, "config");
    const cfgStat = lstatSync(configPath);
    if (!cfgStat.isFile() || cfgStat.isSymbolicLink()) {
      return { ok: false, error: "Chat git config was replaced with a non-file; repair the workspace git binding to continue." };
    }
    if (sha256File(configPath) !== binding.configSha256) {
      return { ok: false, error: "Chat git config changed since clone creation; repair the workspace git binding to continue." };
    }
    return { ok: true, realClone: managed.realClone, realGitDir };
  } catch {
    return { ok: false, error: "Could not verify chat git-dir binding." };
  }
}

/**
 * Restores a tampered chat clone's `.git` pointer and `<gitDir>/config` from
 * the pinned backup (verified against the SQLite `configSha256`), and removes
 * any planted `<gitDir>/commondir` redirect.
 */
export function repairCloneGitBinding(binding: TrustedCloneBinding): { ok: true } | { ok: false; error: string } {
  const managed = assertManagedClonePath(binding.stateRoot, binding.clonePath);
  if (!managed.ok) return managed;
  if (!binding.gitDir || !binding.configSha256) {
    return { ok: false, error: "Chat clone has no recorded trusted git-dir or pinned config hash." };
  }
  const gitDirsRoot = join(binding.stateRoot, "direct-chat", "gitdirs");
  if (!existsSync(gitDirsRoot) || !existsSync(binding.gitDir)) {
    return { ok: false, error: "Chat clone's separate git-dir is missing." };
  }
  try {
    const gdStat = lstatSync(binding.gitDir);
    if (!gdStat.isDirectory() || gdStat.isSymbolicLink()) {
      return { ok: false, error: "Chat git-dir must be a real directory, not a symlink." };
    }
    const realGdRoot = realpathSync(gitDirsRoot);
    const realGitDir = realpathSync(binding.gitDir);
    const relGd = relative(realGdRoot, realGitDir);
    if (relGd === "" || relGd === ".." || relGd.startsWith(`..${"/"}`) || relGd.startsWith(`..${"\\"}`) || isAbsolute(relGd)) {
      return { ok: false, error: "Chat git-dir is outside Toolroll's managed gitdirs folder." };
    }

    // Verify the saved pinned config text matches the hash recorded in SQLite before restoring it.
    const backupPath = pinnedConfigBackupPath(realGitDir);
    const backupStat = lstatSync(backupPath);
    if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
      return { ok: false, error: "Pinned git config backup is missing or invalid; start a new chat instead." };
    }
    const pinnedBytes = readFileSync(backupPath);
    if (sha256Buffer(pinnedBytes) !== binding.configSha256) {
      return { ok: false, error: "Pinned git config backup does not match the recorded hash; start a new chat instead." };
    }

    // Remove any planted commondir redirect (file or symlink).
    const commonDirPath = join(realGitDir, "commondir");
    if (hasCommonDirEntry(realGitDir)) {
      const cdStat = lstatSync(commonDirPath);
      if (cdStat.isDirectory() && !cdStat.isSymbolicLink()) {
        return { ok: false, error: "Chat git-dir has an unexpected commondir directory; start a new chat instead." };
      }
      unlinkSync(commonDirPath);
    }

    // Restore `<gitDir>/config` (unlinking first if replaced with a symlink).
    const configPath = join(realGitDir, "config");
    try {
      const cfgStat = lstatSync(configPath);
      if (cfgStat.isDirectory() && !cfgStat.isSymbolicLink()) {
        return { ok: false, error: "Chat git config was replaced with a directory; start a new chat instead." };
      }
      unlinkSync(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeFileSync(configPath, pinnedBytes, { mode: 0o600 });

    // Restore `<clonePath>/.git` pointer file (refuse if replaced with a real directory).
    const dotGit = join(managed.realClone, ".git");
    try {
      const dgStat = lstatSync(dotGit);
      if (dgStat.isDirectory() && !dgStat.isSymbolicLink()) {
        return { ok: false, error: "Chat clone's .git was replaced with a directory; start a new chat instead." };
      }
      unlinkSync(dotGit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeFileSync(dotGit, `gitdir: ${realGitDir}\n`, { mode: 0o600 });

    const recheck = assertTrustedCloneGit(binding);
    if (!recheck.ok) return recheck;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Could not repair chat git binding: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Git in the project's own repository (the one the chat was opened on), which builds and other agents can write: its
 * config, hooks and info are theirs too. Every command runs through the plane's hardened checkout git (teardown-git.ts
 * viewedGitSync / checkoutGit): a view of the repository whose config is read once and refused when it includes a
 * file or names a command (filters, an fsmonitor, URL rewrites, diff programs), no hooks, no system or global config,
 * the repository bound to the project's record. Reads take the read flags (attributes from the empty tree, no
 * network); `write` is for commands that write only objects and refs (a fetch from the chat's clone, a branch delete).
 * Throws when git fails or the repository is refused (`status` is git's exit code, null for a refusal).
 */
const MAIN_GIT_BUFFER = 16 * 1024 * 1024;

export function runHardenedMainGit(args: readonly string[], repoCwd: string, options: { write?: true } = {}): string {
  let ran: { status: number | null; stdout: string; stderr: string };
  try {
    ran = viewedGitSync(repoCwd, args, { maxBuffer: MAIN_GIT_BUFFER, binding: { repo: repoCwd }, timeoutMs: 120_000, ...(options.write === true ? { write: true as const } : {}) });
  } catch (error) {
    throw Object.assign(new Error(`Toolroll won't run git in this project: ${error instanceof Error ? error.message : String(error)}`), { status: null });
  }
  if (ran.status !== 0) {
    const said = ran.stderr.trim().split("\n").find(line => line.trim() !== "") ?? `git ${args[0] ?? ""} failed`;
    throw Object.assign(new Error(said), { status: ran.status });
  }
  return ran.stdout;
}

export async function runHardenedMainGitAsync(args: readonly string[], repoCwd: string): Promise<string> {
  const ran = await checkoutGit(run, "read", { repo: repoCwd })("git", [...args], { cwd: repoCwd, envAllowlist: ENV_ALLOWLIST, env: { ...ENV }, maxBuffer: MAIN_GIT_BUFFER, timeoutMs: 120_000 });
  const refused = refusal(ran);
  if (refused !== null) throw new Error(`Toolroll won't run git in this project: ${refused}`);
  if (ran.code !== 0) throw new Error(ran.stderr.trim().split("\n").find(line => line.trim() !== "") ?? `git ${args[0] ?? ""} failed`);
  return ran.stdout;
}

/** Settings fixed on a local clone of the project, beside the teardown flags: the project's own repository is read by
 * the clone's upload-pack with its config, so nothing there that names a command may stand (checked just before, by
 * the hardened rev-parse, and overridden here). */
const CLONE_SOURCE_FLAGS: readonly string[] = ["-c", "core.alternateRefsCommand=", "-c", "uploadpack.packObjectsHook=", "-c", "protocol.file.allow=always"];

/**
 * Runs hardened `git` against a chat clone ONLY after verifying the separate
 * git-dir pointer, absence of `commondir`, and pinned config SHA-256, passing
 * `--git-dir`, `--work-tree`, and `GIT_COMMON_DIR` explicitly so git never
 * follows an attacker-planted `.git` or `commondir` redirect.
 */
export function runTrustedCloneGit(binding: TrustedCloneBinding, args: readonly string[], input?: string): string {
  const verified = assertTrustedCloneGit(binding);
  if (!verified.ok) {
    throw new Error(verified.error);
  }
  return execFileSync(
    "git",
    [
      ...EXTRA_DIRECT_CHAT_GIT_FLAGS,
      `--git-dir=${verified.realGitDir}`,
      `--work-tree=${verified.realClone}`,
      ...args,
    ],
    {
      cwd: verified.realClone,
      encoding: "utf8",
      env: cleanGitEnv({ GIT_COMMON_DIR: verified.realGitDir }),
      input,
      maxBuffer: 16 * 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    },
  );
}

function pinCloneGitConfig(realGitDir: string): string {
  const configPath = join(realGitDir, "config");
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // Best-effort permission tightening.
  }
  const configBytes = readFileSync(configPath);
  writeFileSync(pinnedConfigBackupPath(realGitDir), configBytes, { mode: 0o600 });
  return sha256Buffer(configBytes);
}

/**
 * Creates an isolated local clone using `--separate-git-dir` inside Toolroll's
 * state folder, strips `origin`, checks out `branch`, saves the pinned config
 * backup, and returns the pinned `configSha256` of `<gitDir>/config`.
 */
export function cloneIsolatedRepo(input: {
  stateRoot: string;
  repo: string;
  clonePath: string;
  gitDir: string;
  branch: string;
}): { baseSha: string; gitDir: string; configSha256: string; mainDirtyFiles: string[] } {
  mkdirSync(dirname(input.clonePath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(input.gitDir), { recursive: true, mode: 0o700 });

  const baseSha = runHardenedMainGit(["rev-parse", "HEAD"], input.repo).trim();
  let mainDirtyFiles: string[] = [];
  try {
    const status = runHardenedMainGit(["status", "--porcelain"], input.repo);
    mainDirtyFiles = status
      .split("\n")
      .map(line => line.slice(3).trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    mainDirtyFiles = [];
  }

  execFileSync(
    "git",
    [
      ...EXTRA_DIRECT_CHAT_GIT_FLAGS,
      ...CLONE_SOURCE_FLAGS,
      "clone", "--local",
      `--separate-git-dir=${input.gitDir}`,
      "--",
      input.repo,
      input.clonePath,
    ],
    {
      cwd: dirname(input.clonePath),
      encoding: "utf8",
      env: cleanGitEnv(),
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const realClone = realpathSync(input.clonePath);
  const realGitDir = realpathSync(input.gitDir);
  const cloneEnv = cleanGitEnv({ GIT_COMMON_DIR: realGitDir });

  try {
    execFileSync(
      "git",
      [...EXTRA_DIRECT_CHAT_GIT_FLAGS, `--git-dir=${realGitDir}`, `--work-tree=${realClone}`, "remote", "remove", "origin"],
      { cwd: realClone, encoding: "utf8", env: cloneEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    // Clone may have no origin remote.
  }

  execFileSync(
    "git",
    [...EXTRA_DIRECT_CHAT_GIT_FLAGS, `--git-dir=${realGitDir}`, `--work-tree=${realClone}`, "checkout", "-b", input.branch, baseSha],
    { cwd: realClone, encoding: "utf8", env: cloneEnv, stdio: ["ignore", "pipe", "pipe"] },
  );

  const configSha256 = pinCloneGitConfig(realGitDir);
  return { baseSha, gitDir: realGitDir, configSha256, mainDirtyFiles };
}

/**
 * Non-blocking async variant of `cloneIsolatedRepo` used during chat creation
 * so `POST /engine/direct-chats` never blocks Node's event loop.
 */
export async function cloneIsolatedRepoAsync(input: {
  stateRoot: string;
  repo: string;
  clonePath: string;
  gitDir: string;
  branch: string;
}): Promise<{ baseSha: string; gitDir: string; configSha256: string; mainDirtyFiles: string[] }> {
  mkdirSync(dirname(input.clonePath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(input.gitDir), { recursive: true, mode: 0o700 });

  const baseSha = (await runHardenedMainGitAsync(["rev-parse", "HEAD"], input.repo)).trim();
  let mainDirtyFiles: string[] = [];
  try {
    const status = await runHardenedMainGitAsync(["status", "--porcelain"], input.repo);
    mainDirtyFiles = status
      .split("\n")
      .map(line => line.slice(3).trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    mainDirtyFiles = [];
  }

  await execFileAsync(
    "git",
    [
      ...EXTRA_DIRECT_CHAT_GIT_FLAGS,
      ...CLONE_SOURCE_FLAGS,
      "clone", "--local",
      `--separate-git-dir=${input.gitDir}`,
      "--",
      input.repo,
      input.clonePath,
    ],
    {
      cwd: dirname(input.clonePath),
      encoding: "utf8",
      env: cleanGitEnv(),
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  const realClone = realpathSync(input.clonePath);
  const realGitDir = realpathSync(input.gitDir);
  const cloneEnv = cleanGitEnv({ GIT_COMMON_DIR: realGitDir });

  try {
    await execFileAsync(
      "git",
      [...EXTRA_DIRECT_CHAT_GIT_FLAGS, `--git-dir=${realGitDir}`, `--work-tree=${realClone}`, "remote", "remove", "origin"],
      { cwd: realClone, encoding: "utf8", env: cloneEnv },
    );
  } catch {
    // Clone may have no origin remote.
  }

  await execFileAsync(
    "git",
    [...EXTRA_DIRECT_CHAT_GIT_FLAGS, `--git-dir=${realGitDir}`, `--work-tree=${realClone}`, "checkout", "-b", input.branch, baseSha],
    { cwd: realClone, encoding: "utf8", env: cloneEnv },
  );

  const configSha256 = pinCloneGitConfig(realGitDir);
  return { baseSha, gitDir: realGitDir, configSha256, mainDirtyFiles };
}

/**
 * Fetches a frozen commit from a verified chat git-dir into the main repo with
 * `transfer.fsckObjects=true` and `--no-tags`.
 */
export function fetchTrustedSnapshotIntoMainRepo(input: {
  binding: TrustedCloneBinding;
  repo: string;
  candidateSha: string;
  targetRef: string;
}): void {
  const verified = assertTrustedCloneGit(input.binding);
  if (!verified.ok) {
    throw new Error(verified.error);
  }
  runHardenedMainGit(
    [
      "-c", "protocol.file.allow=always",
      "-c", "transfer.fsckObjects=true",
      "fetch", "--no-tags", "--no-write-fetch-head",
      verified.realGitDir,
      `${input.candidateSha}:${input.targetRef}`,
    ],
    input.repo,
    { write: true },
  );
}
