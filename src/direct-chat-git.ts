import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TEARDOWN_FLAGS } from "./teardown-git.js";

const EXTRA_DIRECT_CHAT_GIT_FLAGS: readonly string[] = [
  ...TEARDOWN_FLAGS,
  "-c", "diff.external=",
  "-c", "core.attributesfile=/dev/null",
  "-c", "transfer.fsckObjects=true",
];

function cleanGitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: homedir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

    // Verify `<clonePath>/.git` is a regular file pointing strictly at `realGitDir`.
    const dotGit = join(managed.realClone, ".git");
    const dgStat = lstatSync(dotGit);
    if (!dgStat.isFile() || dgStat.isSymbolicLink()) {
      return { ok: false, error: "Chat clone's .git pointer was replaced or tampered with." };
    }
    const pointerText = readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointerText);
    if (match === null) {
      return { ok: false, error: "Chat clone's .git pointer is malformed." };
    }
    const pointedReal = realpathSync(resolve(managed.realClone, match[1]!.trim()));
    if (pointedReal !== realGitDir) {
      return { ok: false, error: "Chat clone's .git pointer no longer matches Toolroll's trusted git-dir." };
    }

    // Verify `<gitDir>/config` is a regular file matching the pinned SHA-256.
    const configPath = join(realGitDir, "config");
    const cfgStat = lstatSync(configPath);
    if (!cfgStat.isFile() || cfgStat.isSymbolicLink()) {
      return { ok: false, error: "Chat git config was replaced with a non-file." };
    }
    if (sha256File(configPath) !== binding.configSha256) {
      return { ok: false, error: "Chat git config changed since clone creation; refusing to run git." };
    }
    return { ok: true, realClone: managed.realClone, realGitDir };
  } catch {
    return { ok: false, error: "Could not verify chat git-dir binding." };
  }
}

export function runHardenedMainGit(args: readonly string[], repoCwd: string, input?: string): string {
  return execFileSync(
    "git",
    [...EXTRA_DIRECT_CHAT_GIT_FLAGS, ...args],
    {
      cwd: repoCwd,
      encoding: "utf8",
      env: cleanGitEnv(),
      input,
      maxBuffer: 16 * 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    },
  );
}

/**
 * Runs hardened `git` against a chat clone ONLY after verifying the separate
 * git-dir pointer and pinned config SHA-256, passing `--git-dir` and `--work-tree`
 * explicitly so git never discovers an attacker-planted `.git`.
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
      env: cleanGitEnv(),
      input,
      maxBuffer: 16 * 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    },
  );
}

/**
 * Creates an isolated local clone using `--separate-git-dir` inside Toolroll's
 * state folder, strips `origin`, checks out `branch`, and returns the pinned
 * `configSha256` of `<gitDir>/config` so every subsequent git call verifies it.
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

  // Clone with --separate-git-dir so `.git` metadata lives under Toolroll's gitdirs/.
  execFileSync(
    "git",
    [
      ...EXTRA_DIRECT_CHAT_GIT_FLAGS,
      "-c", "protocol.file.allow=always",
      "clone", "--local",
      `--separate-git-dir=${input.gitDir}`,
      "--",
      input.repo,
      input.clonePath,
    ],
    {
      encoding: "utf8",
      env: cleanGitEnv(),
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const realClone = realpathSync(input.clonePath);
  const realGitDir = realpathSync(input.gitDir);

  try {
    execFileSync(
      "git",
      [...EXTRA_DIRECT_CHAT_GIT_FLAGS, `--git-dir=${realGitDir}`, `--work-tree=${realClone}`, "remote", "remove", "origin"],
      { cwd: realClone, encoding: "utf8", env: cleanGitEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    // Clone may have no origin remote.
  }

  execFileSync(
    "git",
    [...EXTRA_DIRECT_CHAT_GIT_FLAGS, `--git-dir=${realGitDir}`, `--work-tree=${realClone}`, "checkout", "-b", input.branch, baseSha],
    { cwd: realClone, encoding: "utf8", env: cleanGitEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );

  const configPath = join(realGitDir, "config");
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // Best-effort permission tightening.
  }
  const configSha256 = sha256File(configPath);
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
      "fetch", "--no-tags",
      verified.realGitDir,
      `${input.candidateSha}:${input.targetRef}`,
    ],
    input.repo,
  );
}
