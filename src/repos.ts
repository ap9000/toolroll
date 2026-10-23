/**
 * Which repositories the operator has actually committed to.
 *
 * Discovery is total and costs nothing, so it stays the way you find things.
 * Enrollment is the smaller, deliberate list: what gets reported by default,
 * and later what may be written to. Keeping the two separate is what lets the
 * first run need no configuration while the tenth run stays quiet.
 *
 * The file is plain JSON in a conventional location because someone will want
 * to edit it by hand or check it into their dotfiles — which also means it is
 * untrusted input and gets validated like any other.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configBase, namedPath } from "./names.js";
import { sleep } from "./sleep.js";

export const CONFIG_VERSION = 2;
const FILE_NAME = "repos.json";

export type ProjectRegistry = { repos: string[]; roots: string[] };
export type LoadResult = { repos: string[] } | { error: string };
export type RegistryLoadResult = ProjectRegistry | { error: string };
type RegistryUpdateFailure = { ok: false; reason: "locked" | "registry" | "abandoned"; message: string };

export function configPath(env: Record<string, string | undefined>, home: string): string {
  // Rename continuity: an enrolled list under an older name keeps working
  // until one exists under the new one.
  return namedPath(configBase(env, home), [FILE_NAME]);
}

export async function loadProjectRegistry(file: string): Promise<RegistryLoadResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    // ONLY the missing file is the ordinary first-run state (round-3
    // finding 6): a permission or I/O failure is an unreadable registry,
    // never an empty one — the MCP gateway fails closed on it.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { repos: [], roots: [] };
    return { error: `${file} could not be read (${String((cause as Error).message)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `${file} is not valid JSON — fix or delete it` };
  }

  const registry = readProjectRegistry(parsed);
  if (registry === null) {
    return { error: `${file} does not look like a Toolroll config — fix or delete it` };
  }
  return { repos: sortUnique(registry.repos), roots: sortUnique(registry.roots) };
}

/** Compatibility view for reports, CLI enrollment, and the MCP surface. */
export async function loadRepos(file: string): Promise<LoadResult> {
  const loaded = await loadProjectRegistry(file);
  return "error" in loaded ? loaded : { repos: loaded.repos };
}

export async function saveRepos(file: string, repos: readonly string[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const config = { version: CONFIG_VERSION, repos: sortUnique(repos), roots: [] };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}


/**
 * The ONE locked registry update (onboarding findings 9/17/19/25/29/30):
 * every writer — CLI add/remove, the console, up's enrollment — goes
 * through here. The lock is an exclusive-create file whose body carries
 * {pid, token, at}; a LIVE owner's lock is never touched; stale recovery
 * runs only after kill(pid, 0) proves the owner dead, serialized through
 * a second exclusive reaper lock that re-reads the exact snapshot it
 * observed before unlinking. The owner releases only while its hold is
 * under 25s — past that it abandons WITHOUT unlinking and reports so; the
 * deadline is checked BEFORE publication, so a committed rename is never
 * reported as failed. Reads: only ENOENT means an empty registry —
 * malformed JSON, wrong shape, EACCES, and I/O errors REFUSE.
 */
export async function updateRepos(
  file: string,
  transform: (repos: string[]) => string[],
): Promise<{ ok: true; repos: string[] } | RegistryUpdateFailure> {
  const updated = await updateProjectRegistry(file, current => ({
    ...current,
    repos: transform(current.repos),
  }));
  return updated.ok ? { ok: true, repos: updated.registry.repos } : updated;
}

/** Persist project roots through the same lock as repo enrollment. */
export async function updateProjectRoots(
  file: string,
  transform: (roots: string[]) => string[],
): Promise<{ ok: true; roots: string[] } | RegistryUpdateFailure> {
  const updated = await updateProjectRegistry(file, current => ({
    ...current,
    roots: transform(current.roots),
  }));
  return updated.ok ? { ok: true, roots: updated.registry.roots } : updated;
}

/** Atomically update repositories and roots without either writer erasing the other. */
export async function updateProjectRegistry(
  file: string,
  transform: (registry: ProjectRegistry) => ProjectRegistry,
): Promise<{ ok: true; registry: ProjectRegistry } | RegistryUpdateFailure> {
  const { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync: exists, mkdirSync, renameSync } = await import("node:fs");
  const { randomBytes } = await import("node:crypto");
  mkdirSync(dirname(file), { recursive: true });
  const lockPath = `${file}.lock`;
  const reaperPath = `${file}.reaper.lock`;
  const token = randomBytes(16).toString("hex");
  const body = JSON.stringify({ pid: process.pid, token, at: Date.now() });

  const tryReap = (): void => {
    // Recovery only for PROVEN-dead owners, serialized by the reaper lock,
    // which re-reads the exact snapshot before unlinking (finding 29). An
    // orphaned reaper lock is itself reaped by the same dead-pid rule.
    let snapshot: { pid?: number; token?: string } | null = null;
    try {
      snapshot = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; token?: string };
    } catch {
      return;
    }
    if (typeof snapshot?.pid !== "number") return;
    try {
      process.kill(snapshot.pid, 0);
      return; // alive: never touched
    } catch {
      // ESRCH — dead; continue under the reaper lock
    }
    try {
      const before = readFileSync(reaperPath, "utf8");
      const parsed = JSON.parse(before) as { pid?: number };
      if (typeof parsed?.pid === "number") {
        try {
          process.kill(parsed.pid, 0);
          return; // a live reaper is working
        } catch {
          try { unlinkSync(reaperPath); } catch { /* raced */ }
        }
      }
    } catch {
      // no reaper lock — proceed to claim it
    }
    let reaperFd: number;
    try {
      reaperFd = openSync(reaperPath, "wx");
    } catch {
      return; // another reaper won
    }
    try {
      writeSync(reaperFd, JSON.stringify({ pid: process.pid }));
      // Re-read and require the EXACT observed snapshot + a repeated
      // dead-pid proof before unlinking (finding 29).
      const now = readFileSync(lockPath, "utf8");
      const again = JSON.parse(now) as { pid?: number; token?: string };
      if (again?.pid === snapshot.pid && again?.token === snapshot.token) {
        try {
          process.kill(snapshot.pid, 0);
        } catch {
          try { unlinkSync(lockPath); } catch { /* raced */ }
        }
      }
    } catch {
      // lock vanished or changed — nothing to do
    } finally {
      closeSync(reaperFd);
      try { unlinkSync(reaperPath); } catch { /* already gone */ }
    }
  };

  let held = false;
  const acquiredAt = () => Date.now() - start;
  let start = 0;
  for (let attempt = 0; attempt < 6 && !held; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, body);
      closeSync(fd);
      held = true;
      start = Date.now();
    } catch {
      tryReap();
      await sleep(100);
    }
  }
  if (!held) return { ok: false, reason: "locked", message: `${file} is busy — another enrollment holds its lock; try again` };

  try {
    let current: ProjectRegistry;
    if (!exists(file)) {
      current = { repos: [], roots: [] }; // ONLY the missing-file case is an empty registry
    } else {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        return { ok: false, reason: "registry", message: `${file} could not be read (${String((error as Error).message)}) — refusing to replace it` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, reason: "registry", message: `${file} is not valid JSON — fix or delete it; refusing to replace it` };
      }
      const registry = readProjectRegistryStrict(parsed);
      if (registry === null) {
        return { ok: false, reason: "registry", message: `${file} does not look like a Toolroll config — refusing to replace it` };
      }
      current = registry;
    }
    const transformed = transform({ repos: [...current.repos], roots: [...current.roots] });
    const next = { repos: sortUnique(transformed.repos), roots: sortUnique(transformed.roots) };
    // Deadline BEFORE publication (finding 30): a rename past the hold
    // window would commit while the lock may already be reaped.
    if (acquiredAt() > 20_000) {
      held = false; // abandon: no unlink, no publication
      return { ok: false, reason: "abandoned", message: "the registry lock aged out before the update could publish — nothing changed; try again" };
    }
    const temp = `${file}.${process.pid}.${token.slice(0, 8)}.tmp`;
    const fd = openSync(temp, "wx");
    writeSync(fd, `${JSON.stringify({ version: CONFIG_VERSION, ...next }, null, 2)}
`);
    closeSync(fd);
    renameSync(temp, file);
    return { ok: true, registry: next };
  } finally {
    if (held && acquiredAt() < 25_000) {
      try { unlinkSync(lockPath); } catch { /* reaped despite liveness rules */ }
    }
  }
}

/** Strict shape for the locked path (finding 36): non-string entries REFUSE. */
function readProjectRegistryStrict(parsed: unknown): ProjectRegistry | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const { repos, roots } = parsed as { repos?: unknown; roots?: unknown };
  if (!Array.isArray(repos)) return null;
  if (!repos.every((repo): repo is string => typeof repo === "string")) return null;
  if (roots !== undefined && (!Array.isArray(roots) || !roots.every((root): root is string => typeof root === "string"))) return null;
  return { repos, roots: roots ?? [] };
}

export function addRepos(existing: readonly string[], incoming: readonly string[]): string[] {
  return sortUnique([...existing, ...incoming]);
}

export function removeRepos(existing: readonly string[], targets: readonly string[]): string[] {
  const unwanted = new Set(targets);
  return existing.filter(repo => !unwanted.has(repo));
}

/** null when the shape is wrong; non-string entries are dropped, not trusted. */
function readProjectRegistry(parsed: unknown): ProjectRegistry | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const { repos, roots } = parsed as { repos?: unknown; roots?: unknown };
  if (!Array.isArray(repos)) return null;
  if (roots !== undefined && !Array.isArray(roots)) return null;
  return {
    repos: repos.filter((repo): repo is string => typeof repo === "string"),
    roots: (roots ?? []).filter((root): root is string => typeof root === "string"),
  };
}

function sortUnique(repos: readonly string[]): string[] {
  return [...new Set(repos)].sort();
}
