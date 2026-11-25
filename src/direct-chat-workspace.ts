import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertTrustedCloneGit,
  runHardenedMainGit,
  runTrustedCloneGit,
  type TrustedCloneBinding,
} from "./direct-chat-git.js";

const SKIPPED_DIR_SEGMENTS = new Set([
  ".git",
  ".venv",
  "venv",
  ".next",
  ".turbo",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  "dist",
  "build",
]);

const MAX_SYMLINK_SCAN_ENTRIES = 250_000;
const MAX_SYMLINK_SCAN_DEPTH = 48;

/**
 * Inspect a `node_modules` directory for symlinks that could write through into
 * the user's main checkout. Absolute symlinks are always rejected. Relative
 * symlinks must stay within `repoRoot` (when provided — allowing pnpm workspace
 * links like `../../packages/x` that resolve inside the clone after copying) or
 * within `nodeModulesDir` itself.
 */
export function scanNodeModulesSafety(
  nodeModulesDir: string,
  opts?: { maxEntries?: number; maxDepth?: number; repoRoot?: string },
): { safe: true; entries: number } | { safe: false; reason: string } {
  const maxEntries = opts?.maxEntries ?? MAX_SYMLINK_SCAN_ENTRIES;
  const maxDepth = opts?.maxDepth ?? MAX_SYMLINK_SCAN_DEPTH;
  let rootReal: string;
  let boundaryReal: string;
  try {
    rootReal = realpathSync(nodeModulesDir);
    boundaryReal = opts?.repoRoot ? realpathSync(opts.repoRoot) : rootReal;
  } catch {
    return { safe: false, reason: "Directory could not be resolved." };
  }

  let entries = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootReal, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > maxDepth) {
      return { safe: false, reason: "Directory nesting exceeds safety depth limit." };
    }
    let items: string[];
    try {
      items = readdirSync(current.dir);
    } catch {
      return { safe: false, reason: "Unreadable directory inside node_modules." };
    }
    for (const name of items) {
      entries += 1;
      if (entries > maxEntries) {
        return { safe: false, reason: "Dependency tree exceeds symlink scan cap." };
      }
      const full = join(current.dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        return { safe: false, reason: "Unreadable entry inside node_modules." };
      }
      if (st.isSymbolicLink()) {
        let linkTarget: string;
        try {
          linkTarget = readlinkSync(full);
        } catch {
          return { safe: false, reason: "Unreadable symlink inside node_modules." };
        }
        if (isAbsolute(linkTarget)) {
          return { safe: false, reason: `Absolute symlink (${name}) points outside node_modules.` };
        }
        const resolved = resolve(dirname(full), linkTarget);
        const rel = relative(boundaryReal, resolved);
        if (rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..${"\\"}`) || isAbsolute(rel)) {
          return { safe: false, reason: `Relative symlink (${name}) escapes allowed workspace boundary.` };
        }
      } else if (st.isDirectory()) {
        stack.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }
  return { safe: true, entries };
}

export type CloneNodeModulesResult = {
  cloned: string[];
  skipped: Array<{ path: string; reason: string }>;
};

export function discoverNodeModulesDirs(repo: string): string[] {
  let raw = "";
  try {
    raw = runHardenedMainGit(["ls-files", "-o", "-i", "--exclude-standard", "--directory"], repo);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim().replace(/\/+$/, "");
    if (trimmed === "") continue;
    const parts = trimmed.split("/");
    if (parts.at(-1) !== "node_modules") continue;
    if (parts.some(seg => seg === ".." || seg === "." || SKIPPED_DIR_SEGMENTS.has(seg))) continue;
    if (parts.slice(0, -1).includes("node_modules")) continue;
    found.push(trimmed);
  }
  return [...new Set(found)].sort();
}

/**
 * Safely copy-on-write clone `node_modules` directories from the main repo into
 * the isolated Direct Chat clone on macOS APFS (`cp -cR`). Skips `.venv`, build
 * caches, cross-volume destinations, and any tree containing absolute or
 * repo-escaping symlinks. Cleans up any partial destination if `cp -cR` fails or times out.
 */
export function cloneSafeNodeModules(input: {
  repo: string;
  clonePath: string;
  platform?: NodeJS.Platform;
  copyCoW?: (src: string, dst: string) => void;
}): CloneNodeModulesResult {
  const platform = input.platform ?? process.platform;
  const result: CloneNodeModulesResult = { cloned: [], skipped: [] };
  if (platform !== "darwin") {
    return result;
  }

  const dirs = discoverNodeModulesDirs(input.repo);
  if (dirs.length === 0) return result;

  let cloneDev: number;
  try {
    cloneDev = statSync(input.clonePath).dev;
  } catch {
    return result;
  }

  const copyFn = input.copyCoW ?? ((src: string, dst: string) => {
    execFileSync("/bin/cp", ["-cR", src, dst], {
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  for (const relPath of dirs) {
    const src = join(input.repo, relPath);
    const dst = join(input.clonePath, relPath);
    if (!existsSync(src)) continue;
    if (existsSync(dst)) {
      result.skipped.push({ path: relPath, reason: "Already exists in clone." });
      continue;
    }
    let srcStat;
    try {
      srcStat = lstatSync(src);
    } catch {
      result.skipped.push({ path: relPath, reason: "Source could not be read." });
      continue;
    }
    if (!srcStat.isDirectory() || srcStat.isSymbolicLink()) {
      result.skipped.push({ path: relPath, reason: "Not a real directory." });
      continue;
    }
    if (srcStat.dev !== cloneDev) {
      result.skipped.push({ path: relPath, reason: "Different filesystem volume (APFS clonefile unavailable)." });
      continue;
    }
    const safety = scanNodeModulesSafety(src, { repoRoot: input.repo });
    if (!safety.safe) {
      result.skipped.push({ path: relPath, reason: safety.reason });
      continue;
    }
    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFn(src, dst);
      result.cloned.push(relPath);
    } catch (error) {
      // Remove any partial copy left behind by a timeout or mid-copy failure.
      try {
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
      result.skipped.push({
        path: relPath,
        reason: error instanceof Error ? error.message.slice(0, 140) : "Copy-on-write clone failed.",
      });
    }
  }

  return result;
}

export type ApplyMainDirtyPatchResult =
  | { ok: true; appliedFiles: string[]; untrackedFiles: string[]; said: string }
  | { ok: false; status: number; error: string };

/**
 * Snapshot tracked uncommitted edits from the user's main checkout (`git diff --binary --no-ext-diff --no-textconv HEAD`)
 * and apply them non-destructively inside the verified isolated clone. Never modifies the main checkout.
 */
export function applyMainDirtyPatch(input: {
  repo: string;
  binding: TrustedCloneBinding;
}): ApplyMainDirtyPatchResult {
  if (!existsSync(input.repo)) {
    return { ok: false, status: 404, error: "Project directory is missing." };
  }
  const verified = assertTrustedCloneGit(input.binding);
  if (!verified.ok) {
    return { ok: false, status: 409, error: verified.error };
  }
  let patch = "";
  let changedTracked: string[] = [];
  let untrackedFiles: string[] = [];
  try {
    patch = runHardenedMainGit(["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"], input.repo);
    changedTracked = runHardenedMainGit(["diff", "--name-only", "--no-ext-diff", "--no-textconv", "HEAD"], input.repo)
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);
    untrackedFiles = runHardenedMainGit(["ls-files", "--others", "--exclude-standard"], input.repo)
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 50);
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `Could not read uncommitted changes from ${basename(input.repo)}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (patch.trim() === "") {
    if (untrackedFiles.length > 0) {
      return {
        ok: true,
        appliedFiles: [],
        untrackedFiles,
        said: `No tracked edits to apply (${untrackedFiles.length} untracked file${untrackedFiles.length === 1 ? "" : "s"} left in main checkout).`,
      };
    }
    return { ok: true, appliedFiles: [], untrackedFiles: [], said: "Main checkout has no uncommitted edits." };
  }

  try {
    runTrustedCloneGit(input.binding, ["apply", "--3way", "--whitespace=nowarn"], patch);
  } catch (error) {
    return {
      ok: false,
      status: 409,
      error: `Could not cleanly apply main checkout edits into this chat's clone: ${error instanceof Error ? error.message.slice(0, 240) : String(error)}`,
    };
  }

  const suffix = untrackedFiles.length > 0
    ? ` (${untrackedFiles.length} untracked file${untrackedFiles.length === 1 ? "" : "s"} stay in main checkout)`
    : "";
  return {
    ok: true,
    appliedFiles: changedTracked,
    untrackedFiles,
    said: `Brought in ${changedTracked.length} modified file${changedTracked.length === 1 ? "" : "s"} from main checkout${suffix}.`,
  };
}
