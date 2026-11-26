/**
 * Installation-wide Skill Library (schema v186):
 * - One global library enabled across all projects by default, with per-project opt-out (whole library or individual skills).
 * - GitHub repository bundle imports pinned to an exact 40-hex commit SHA (supports 59+ skills such as pstack).
 * - Daily auto-update sweep that applies clean updates automatically, holds suspicious updates with exact reasons,
 *   and provides one-step rollback to the previous pinned commit & library revision.
 * - Integrates with `skill-local-sync.ts` ("Also install on this computer" for Claude Code, Codex, Gemini CLI).
 */
import { createHash } from "node:crypto";
import { scanForSecrets } from "./evidence.js";
import { learningSha } from "./project-learning.js";
import {
  PROJECT_SKILLS_GUIDANCE,
  PROJECT_SKILLS_READ,
  validateSkill,
  type SavedSkill,
  type SkillFile,
  type SkillPackage,
} from "./project-skills.js";
import { savedSkillPackageSchema } from "./contracts/project-skills.js";
import {
  localSyncStatus,
  setLocalSkillSync,
  syncEnabledLocalTools,
  type DetectedLocalTool,
  type LocalSkillTool,
  type LocalSyncOutcome,
} from "./skill-local-sync.js";
import type { Store } from "./store.js";

/** Limits for the installation-wide skill library & GitHub repository bundle imports (supports 59+ skills like pstack). */
export const LIBRARY_LIMITS = Object.freeze({
  maxSkills: 200,
  maxBundleBytes: 24 * 1024 * 1024,
  maxBundleFiles: 2500,
  dailySweepMs: 24 * 60 * 60 * 1000,
  maxFetchConcurrency: 8,
});

export type LibrarySkillChoice = {
  sha: string;
  enabled: boolean;
  sourceId?: string | null;
};

export type LibrarySelection = Record<string, LibrarySkillChoice>;

export type SkillBundleRecord = {
  id: string;
  repoUrl: string;
  owner: string;
  repoName: string;
  branch: string;
  subpath: string;
  pinnedCommit: string;
  previousCommit: string | null;
  previousRevision: number | null;
  skillNames: string[];
  autoUpdate: boolean;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  heldCommit: string | null;
  heldReason: string | null;
  heldAt: string | null;
  actor: string;
  createdAt: string;
};

export type LibraryHistoryEntry = {
  revision: number;
  actor: string;
  at: string;
  source: "manual" | "bundle-import" | "auto-update" | "rollback";
  enabledCount: number;
};

export type SkillLibraryView = {
  revision: number;
  selection: LibrarySelection;
  skills: SavedSkill[];
  bundles: SkillBundleRecord[];
  localSync: DetectedLocalTool[];
  history: LibraryHistoryEntry[];
  projectOptOut: { all: boolean; names: string[] } | null;
};

function packageBySha(store: Store, sha: string): SavedSkill {
  const row = store.handle.prepare("SELECT payload FROM skill_package WHERE sha=?").get(sha);
  if (!row || typeof row["payload"] !== "string" || learningSha(row["payload"]) !== sha) {
    throw Error("Saved library skill could not be verified.");
  }
  const parsed = savedSkillPackageSchema.safeParse(JSON.parse(row["payload"]));
  if (!parsed.success) throw Error("Saved library skill could not be verified.");
  return { ...parsed.data, sha };
}

function parseLibrarySelection(payload: unknown, sha: unknown): LibrarySelection {
  if (typeof payload !== "string" || learningSha(payload) !== sha) {
    throw Error("Saved skill library selection could not be verified.");
  }
  const raw = JSON.parse(payload) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw Error("Saved skill library selection could not be verified.");
  }
  const out: LibrarySelection = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw Error("Saved skill library selection could not be verified.");
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj["sha"] !== "string" || typeof obj["enabled"] !== "boolean") {
      throw Error("Saved skill library selection could not be verified.");
    }
    out[name] = {
      sha: obj["sha"],
      enabled: obj["enabled"],
      ...(typeof obj["sourceId"] === "string" || obj["sourceId"] === null ? { sourceId: obj["sourceId"] } : {}),
    };
  }
  return out;
}

/** Current global library revision & verified selection. */
export function currentLibrary(store: Store): { revision: number; selection: LibrarySelection } {
  const row = store.handle
    .prepare("SELECT revision, payload, sha FROM skill_library_change ORDER BY revision DESC LIMIT 1")
    .get();
  if (!row) return { revision: 0, selection: {} };
  return {
    revision: Number(row["revision"]),
    selection: parseLibrarySelection(row["payload"], row["sha"]),
  };
}

/** Per-project opt-outs from the global skill library. */
export function projectSkillOptOuts(store: Store, repo: string): { all: boolean; names: Set<string> } {
  const rows = store.handle
    .prepare("SELECT skill_name FROM skill_project_opt_out WHERE repo=? ORDER BY skill_name")
    .all(repo);
  let all = false;
  const names = new Set<string>();
  for (const row of rows) {
    const name = String(row["skill_name"]);
    if (name === "*") all = true;
    else names.add(name);
  }
  return { all, names };
}

/** Enabled global library packages (optionally filtered by per-project opt-outs when `repo` is provided). */
export function enabledLibrarySkills(store: Store, repo?: string | null): { revision: number; packages: SavedSkill[] } {
  const { revision, selection } = currentLibrary(store);
  const optOut = repo ? projectSkillOptOuts(store, repo) : { all: false, names: new Set<string>() };
  if (optOut.all) return { revision, packages: [] };
  const packages: SavedSkill[] = [];
  for (const [name, choice] of Object.entries(selection)) {
    if (!choice.enabled || optOut.names.has(name)) continue;
    packages.push(packageBySha(store, choice.sha));
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { revision, packages };
}

/**
 * Merge enabled global library skills (minus per-project opt-outs) with explicit per-project skill selection.
 * Per-project choices override a same-named global skill (enabling a different version, or disabling it for that project).
 */
export function mergeProjectAndLibrarySkills(
  store: Store,
  repo: string,
  projectSelection: Record<string, { sha: string; enabled: boolean }>,
): { libraryRevision: number; packages: SavedSkill[] } {
  const { revision: libraryRevision, packages: globalPackages } = enabledLibrarySkills(store, repo);
  const byName = new Map<string, SavedSkill>();
  for (const pkg of globalPackages) byName.set(pkg.name, pkg);
  for (const [name, choice] of Object.entries(projectSelection)) {
    if (choice.enabled) byName.set(name, packageBySha(store, choice.sha));
    else byName.delete(name);
  }
  const packages = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { libraryRevision, packages };
}

/** Format a materialized skill catalog as the shared brief block handed to every agent surface. */
export function formatSkillsBrief(
  catalog: readonly { name: string; description: string; version: string; requirements: string; warnings: string[]; skillFile: string }[],
  intro = "Project skills supplied for this run. ",
): string {
  if (catalog.length === 0) return "";
  return `\n${intro}${PROJECT_SKILLS_GUIDANCE}${PROJECT_SKILLS_READ}${JSON.stringify(catalog)}\n`;
}

function rowToBundle(row: Record<string, unknown>): SkillBundleRecord {
  let skillNames: string[] = [];
  try {
    const parsed = JSON.parse(String(row["skill_names_json"] ?? "[]")) as unknown;
    if (Array.isArray(parsed)) skillNames = parsed.map(String);
  } catch {
    skillNames = [];
  }
  return {
    id: String(row["id"]),
    repoUrl: String(row["repo_url"]),
    owner: String(row["owner"]),
    repoName: String(row["repo_name"]),
    branch: String(row["branch"]),
    subpath: String(row["subpath"] ?? ""),
    pinnedCommit: String(row["pinned_commit"]),
    previousCommit: typeof row["previous_commit"] === "string" ? row["previous_commit"] : null,
    previousRevision: typeof row["previous_revision"] === "number" ? row["previous_revision"] : null,
    skillNames,
    autoUpdate: Number(row["auto_update"]) === 1,
    lastCheckedAt: typeof row["last_checked_at"] === "string" ? row["last_checked_at"] : null,
    lastUpdatedAt: typeof row["last_updated_at"] === "string" ? row["last_updated_at"] : null,
    heldCommit: typeof row["held_commit"] === "string" ? row["held_commit"] : null,
    heldReason: typeof row["held_reason"] === "string" ? row["held_reason"] : null,
    heldAt: typeof row["held_at"] === "string" ? row["held_at"] : null,
    actor: String(row["actor"]),
    createdAt: String(row["created_at"]),
  };
}

export function listSkillBundles(store: Store): SkillBundleRecord[] {
  return store.handle
    .prepare("SELECT * FROM skill_bundle ORDER BY id")
    .all()
    .map((row) => rowToBundle(row));
}

function writeLibraryRevision(
  store: Store,
  selection: LibrarySelection,
  actor: string,
  source: "manual" | "bundle-import" | "auto-update" | "rollback",
  now: Date,
): number {
  const cur = currentLibrary(store);
  const enabledCount = Object.values(selection).filter((c) => c.enabled).length;
  if (enabledCount > LIBRARY_LIMITS.maxSkills) {
    throw Error(`Enable up to ${LIBRARY_LIMITS.maxSkills} skills in the global library.`);
  }
  const payload = JSON.stringify(selection);
  const nextRevision = cur.revision + 1;
  store.handle
    .prepare("INSERT INTO skill_library_change (revision, actor, at, payload, sha, source) VALUES (?,?,?,?,?,?)")
    .run(nextRevision, actor, now.toISOString(), payload, learningSha(payload), source);
  return nextRevision;
}

function storeSkillPackage(store: Store, pkg: SkillPackage, actor: string, now: Date): SavedSkill {
  const payload = JSON.stringify(pkg);
  const sha = learningSha(payload);
  store.handle.prepare("INSERT OR IGNORE INTO skill_package VALUES (?,?)").run(sha, payload);
  store.handle.prepare("INSERT OR IGNORE INTO skill_owner VALUES (?,?,?)").run(sha, actor, now.toISOString());
  return { ...pkg, sha };
}

/** Full view of the installation-wide skill library, tracked bundles, local sync state, and optional project opt-outs. */
export function skillLibraryView(
  store: Store,
  options: { repo?: string | null; home?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): SkillLibraryView {
  const { revision, selection } = currentLibrary(store);
  const shas = new Set<string>(Object.values(selection).map((c) => c.sha));
  const skills = [...shas]
    .map((sha) => packageBySha(store, sha))
    .sort((a, b) => a.name.localeCompare(b.name));
  const bundles = listSkillBundles(store);
  const localSync = localSyncStatus(store, options);
  const history = store.handle
    .prepare("SELECT revision, actor, at, payload, sha, source FROM skill_library_change ORDER BY revision DESC LIMIT 20")
    .all()
    .map((row) => {
      const sel = parseLibrarySelection(row["payload"], row["sha"]);
      return {
        revision: Number(row["revision"]),
        actor: String(row["actor"]),
        at: String(row["at"]),
        source: String(row["source"]) as LibraryHistoryEntry["source"],
        enabledCount: Object.values(sel).filter((c) => c.enabled).length,
      };
    });
  const optOut = options.repo ? projectSkillOptOuts(store, options.repo) : null;
  return {
    revision,
    selection,
    skills,
    bundles,
    localSync,
    history,
    projectOptOut: optOut === null ? null : { all: optOut.all, names: [...optOut.names].sort() },
  };
}

/** Add a single skill into the global library (optionally enabled immediately for all projects). */
export function importLibrarySkill(
  store: Store,
  args: { actor: string; files: SkillFile[]; source: string; enable?: boolean; home?: string; env?: Readonly<Record<string, string | undefined>> },
  now = new Date(),
): { skill: SavedSkill; revision: number; localSync: LocalSyncOutcome[] } {
  if (!store.schemaCurrent()) throw Error("Skill library needs the current database version.");
  const validated = validateSkill(args.files, args.source);
  const result = store.transact(() => {
    const saved = storeSkillPackage(store, validated, args.actor, now);
    const cur = currentLibrary(store);
    const next: LibrarySelection = {
      ...cur.selection,
      [saved.name]: { sha: saved.sha, enabled: args.enable !== false, sourceId: null },
    };
    const revision = writeLibraryRevision(store, next, args.actor, "manual", now);
    return { skill: saved, revision };
  });
  const enabled = enabledLibrarySkills(store).packages;
  const localSync = syncEnabledLocalTools(store, { actor: args.actor, skills: enabled, libraryRevision: result.revision, ...(args.home === undefined ? {} : { home: args.home }), ...(args.env === undefined ? {} : { env: args.env }) }, now);
  return { ...result, localSync };
}

/** Enable, disable, remove, or restore a revision in the global library. */
export function changeLibrarySkill(
  store: Store,
  args: {
    actor: string;
    revision: number;
    action: "enable" | "disable" | "remove" | "restore";
    name?: string;
    sha?: string;
    restore?: number;
    home?: string;
    env?: Readonly<Record<string, string | undefined>>;
  },
  now = new Date(),
): { revision: number; localSync: LocalSyncOutcome[] } {
  if (!store.schemaCurrent()) throw Error("Skill library needs the current database version.");
  const nextRevision = store.transact(() => {
    const cur = currentLibrary(store);
    if (cur.revision !== args.revision) {
      throw Error("Skill library changed in another window. Reload and try again.");
    }
    let next: LibrarySelection = { ...cur.selection };
    if (args.action === "restore") {
      if (!Number.isSafeInteger(args.restore) || (args.restore ?? 0) < 1) throw Error("Choose a valid library revision.");
      const row = store.handle
        .prepare("SELECT payload, sha FROM skill_library_change WHERE revision=?")
        .get(args.restore!);
      if (!row) throw Error("That library revision is unavailable.");
      next = parseLibrarySelection(row["payload"], row["sha"]);
      for (const choice of Object.values(next)) packageBySha(store, choice.sha);
      return writeLibraryRevision(store, next, args.actor, "rollback", now);
    }
    const name = args.name ?? (args.sha ? packageBySha(store, args.sha).name : "");
    if (!name) throw Error("Choose a skill to update.");
    if (args.action === "remove") {
      delete next[name];
    } else {
      const sha = args.sha || next[name]?.sha;
      if (!sha) throw Error("Choose a saved skill version.");
      const pkg = packageBySha(store, sha);
      next[pkg.name] = {
        sha: pkg.sha,
        enabled: args.action === "enable",
        sourceId: next[pkg.name]?.sourceId ?? null,
      };
    }
    return writeLibraryRevision(store, next, args.actor, "manual", now);
  });
  const enabled = enabledLibrarySkills(store).packages;
  const localSync = syncEnabledLocalTools(store, { actor: args.actor, skills: enabled, libraryRevision: nextRevision, ...(args.home === undefined ? {} : { home: args.home }), ...(args.env === undefined ? {} : { env: args.env }) }, now);
  return { revision: nextRevision, localSync };
}

/** Opt a project out of (or back into) the global skill library, whole (`*`) or for one named skill. */
export function setProjectSkillOptOut(
  store: Store,
  args: { repo: string; skillName: string; optOut: boolean; actor: string },
  now = new Date(),
): void {
  if (!store.schemaCurrent()) throw Error("Skill library needs the current database version.");
  const skillName = args.skillName.trim();
  if (skillName !== "*" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw Error("Choose a valid skill name or '*' for the whole library.");
  }
  store.transact(() => {
    if (args.optOut) {
      store.handle
        .prepare(
          `INSERT INTO skill_project_opt_out (repo, skill_name, actor, at) VALUES (?,?,?,?)
           ON CONFLICT(repo, skill_name) DO UPDATE SET actor=excluded.actor, at=excluded.at`,
        )
        .run(args.repo, skillName, args.actor, now.toISOString());
    } else {
      store.handle
        .prepare("DELETE FROM skill_project_opt_out WHERE repo=? AND skill_name=?")
        .run(args.repo, skillName);
    }
  });
}

// ---- GitHub Repository Bundle Import (pinned to 40-hex commit SHA; supports 59+ skills like pstack) -----------------

export type ParsedGithubBundleUrl = {
  id: string;
  repoUrl: string;
  owner: string;
  repoName: string;
  ref: string | null;
  subpath: string;
};

/** Parse `https://github.com/owner/repo` or `https://github.com/owner/repo/tree/<branch>[/<subpath>]`. */
export function parseGithubBundleUrl(rawUrl: string): ParsedGithubBundleUrl {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw Error("Enter a public github.com repository URL (for example https://github.com/owner/repo).");
  }
  if (
    u.protocol !== "https:" ||
    u.hostname !== "github.com" ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  ) {
    throw Error("Use a public https://github.com repository URL with no query parameters or credentials.");
  }
  const parts = u.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2 || parts.some((p) => !/^[a-zA-Z0-9_.-]+$/.test(p) || p === "." || p === "..")) {
    throw Error("Use https://github.com/owner/repo or https://github.com/owner/repo/tree/branch[/subfolder].");
  }
  const [owner, repoName, kind, ref, ...rest] = parts;
  if (kind !== undefined && (kind !== "tree" || !ref)) {
    throw Error("Use https://github.com/owner/repo or https://github.com/owner/repo/tree/branch[/subfolder].");
  }
  const subpath = rest.join("/");
  const id = subpath ? `${owner}/${repoName}/${subpath}` : `${owner}/${repoName}`;
  const repoUrl = subpath
    ? `https://github.com/${owner}/${repoName}/tree/${ref}/${subpath}`
    : `https://github.com/${owner}/${repoName}`;
  return { id, repoUrl, owner: owner!, repoName: repoName!, ref: ref ?? null, subpath };
}

export type FetchedSkillBundle = {
  id: string;
  repoUrl: string;
  owner: string;
  repoName: string;
  branch: string;
  subpath: string;
  commit: string;
  skills: SkillPackage[];
  skipped: { folder: string; reason: string }[];
};

/** Why GitHub couldn't be reached, in plain words (a fetch that never got an answer: offline, blocked, slow). */
function unreachableWhy(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") return "it didn't answer within 20 seconds";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "its address couldn't be looked up (this computer may be offline)";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPERM" || code === "EACCES") return "the connection was refused or blocked";
  return "the connection failed (this computer may be offline, or a firewall blocks it)";
}

async function githubJson<T>(
  owner: string,
  repoName: string,
  path: string,
  fetcher: typeof fetch,
  budget: { remaining: number },
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`https://api.github.com/repos/${owner}/${repoName}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
  } catch (error) {
    throw Error(`Couldn't reach GitHub: ${unreachableWhy(error)}.`);
  }
  if (!response.ok) {
    throw Error(`GitHub returned ${response.status} for ${owner}/${repoName}${path.split("?")[0]}.`);
  }
  const text = await response.text();
  budget.remaining -= Buffer.byteLength(text);
  if (budget.remaining < 0) throw Error("GitHub bundle response exceeded the 24 MB size limit.");
  return JSON.parse(text) as T;
}

/**
 * Fetch every skill folder (each containing `SKILL.md`) in a public GitHub repository pinned to an exact 40-hex commit SHA.
 * Uses the immutable Git Trees + Git Blobs API so a branch moving mid-import can never mix two commits.
 */
export async function fetchGithubSkillBundle(
  url: string,
  fetcher: typeof fetch = fetch,
  explicitCommit?: string,
): Promise<FetchedSkillBundle> {
  const parsed = parseGithubBundleUrl(url);
  const budget = { remaining: LIBRARY_LIMITS.maxBundleBytes };
  let branch = parsed.ref ?? "";
  if (!branch) {
    const repoInfo = await githubJson<{ default_branch?: string }>(parsed.owner, parsed.repoName, "", fetcher, budget);
    branch = typeof repoInfo.default_branch === "string" && repoInfo.default_branch.trim() ? repoInfo.default_branch.trim() : "main";
  }
  let commit: string;
  if (explicitCommit !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(explicitCommit)) throw Error("Pinned commit must be a 40-character SHA.");
    commit = explicitCommit;
  } else {
    const commitObj = await githubJson<{ sha?: string }>(
      parsed.owner,
      parsed.repoName,
      `/commits/${encodeURIComponent(branch)}`,
      fetcher,
      budget,
    );
    if (typeof commitObj.sha !== "string" || !/^[0-9a-f]{40}$/.test(commitObj.sha)) {
      throw Error("GitHub did not return a pinned commit SHA for that branch.");
    }
    commit = commitObj.sha;
  }

  const treeObj = await githubJson<{
    truncated?: boolean;
    tree?: Array<{ path?: string; mode?: string; type?: string; sha?: string; size?: number }>;
  }>(parsed.owner, parsed.repoName, `/git/trees/${commit}?recursive=1`, fetcher, budget);
  if (treeObj.truncated === true || !Array.isArray(treeObj.tree)) {
    throw Error("Repository tree is truncated or unreadable; specify a narrower subfolder URL.");
  }

  const prefix = parsed.subpath ? `${parsed.subpath}/` : "";
  type TreeBlob = { path: string; relPath: string; sha: string; size: number };
  const blobs: TreeBlob[] = [];
  for (const entry of treeObj.tree) {
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) continue;
    if (typeof entry.path !== "string" || typeof entry.sha !== "string" || !/^[0-9a-f]{40}$/.test(entry.sha)) continue;
    if (prefix && !entry.path.startsWith(prefix)) continue;
    const relPath = prefix ? entry.path.slice(prefix.length) : entry.path;
    if (!relPath) continue;
    blobs.push({ path: entry.path, relPath, sha: entry.sha, size: Number(entry.size ?? 0) });
  }

  // Locate every skill folder by finding every `SKILL.md` (either root `SKILL.md` or `<folder>/SKILL.md`).
  const skillRoots = blobs
    .filter((b) => b.relPath === "SKILL.md" || b.relPath.endsWith("/SKILL.md"))
    .map((b) => (b.relPath === "SKILL.md" ? "" : b.relPath.slice(0, -"/SKILL.md".length)))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));

  if (skillRoots.length === 0) {
    throw Error("No SKILL.md files were found in that GitHub repository or subfolder.");
  }
  if (skillRoots.length > LIBRARY_LIMITS.maxSkills) {
    throw Error(`Repository contains ${skillRoots.length} skills, above the ${LIBRARY_LIMITS.maxSkills}-skill limit.`);
  }

  // Group files per skill folder (excluding hidden dotfiles/folders and nested child skill roots).
  const bySkill = new Map<string, TreeBlob[]>();
  for (const root of skillRoots) bySkill.set(root, []);
  let totalFiles = 0;
  for (const blob of blobs) {
    // Find the deepest matching skill root for this blob.
    let ownerRoot: string | null = null;
    for (const root of skillRoots) {
      if (root === "" || blob.relPath.startsWith(`${root}/`)) {
        if (ownerRoot === null || root.length > ownerRoot.length) ownerRoot = root;
      }
    }
    if (ownerRoot === null) continue;
    const inner = ownerRoot === "" ? blob.relPath : blob.relPath.slice(ownerRoot.length + 1);
    if (inner.split("/").some((seg) => seg.startsWith("."))) continue;
    totalFiles += 1;
    if (totalFiles > LIBRARY_LIMITS.maxBundleFiles) {
      throw Error(`Bundle exceeds the ${LIBRARY_LIMITS.maxBundleFiles}-file limit.`);
    }
    bySkill.get(ownerRoot)!.push({ ...blob, relPath: inner });
  }

  // Fetch all needed blobs with bounded concurrency, verifying git blob SHA-1 on every downloaded blob.
  const uniqueBlobs = new Map<string, TreeBlob>();
  for (const list of bySkill.values()) {
    for (const b of list) uniqueBlobs.set(b.sha, b);
  }
  const blobBytes = new Map<string, Buffer>();
  const queue = [...uniqueBlobs.keys()];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const sha = queue.shift()!;
      const body = await githubJson<{ content?: string; encoding?: string; sha?: string }>(
        parsed.owner,
        parsed.repoName,
        `/git/blobs/${sha}`,
        fetcher,
        budget,
      );
      if (body.encoding !== "base64" || typeof body.content !== "string") {
        throw Error(`GitHub blob ${sha.slice(0, 12)} was not returned as base64.`);
      }
      const raw = Buffer.from(body.content.replace(/\s+/g, ""), "base64");
      const verified = createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex");
      if (verified !== sha) {
        throw Error(`GitHub blob ${sha.slice(0, 12)} failed SHA-1 verification.`);
      }
      blobBytes.set(sha, raw);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIBRARY_LIMITS.maxFetchConcurrency, Math.max(1, queue.length)) }, () => worker()));

  const skills: SkillPackage[] = [];
  const skipped: { folder: string; reason: string }[] = [];
  const seenNames = new Set<string>();
  for (const [folder, list] of bySkill) {
    const files: SkillFile[] = list.map((b) => ({
      path: b.relPath,
      base64: blobBytes.get(b.sha)!.toString("base64"),
    }));
    const sourceLabel = `github:${parsed.owner}/${parsed.repoName}${folder ? `/${parsed.subpath ? `${parsed.subpath}/` : ""}${folder}` : parsed.subpath ? `/${parsed.subpath}` : ""}@${commit.slice(0, 12)}`;
    try {
      const pkg = validateSkill(files, sourceLabel);
      if (seenNames.has(pkg.name)) {
        skipped.push({ folder: folder || ".", reason: `Duplicate skill name "${pkg.name}"` });
        continue;
      }
      seenNames.add(pkg.name);
      skills.push(pkg);
    } catch (error) {
      skipped.push({ folder: folder || ".", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (skills.length === 0) {
    const first = skipped[0] ? `: ${skipped[0].reason}` : "";
    throw Error(`No valid skills could be imported from that repository${first}`);
  }
  return {
    id: parsed.id,
    repoUrl: parsed.repoUrl,
    owner: parsed.owner,
    repoName: parsed.repoName,
    branch,
    subpath: parsed.subpath,
    commit,
    skills,
    skipped,
  };
}

/** Import (or refresh) a pinned GitHub repository bundle into the global skill library. */
export async function importGithubSkillBundle(
  store: Store,
  args: {
    url: string;
    actor: string;
    autoUpdate?: boolean;
    home?: string;
    env?: Readonly<Record<string, string | undefined>>;
  },
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<{ bundle: SkillBundleRecord; importedCount: number; skipped: { folder: string; reason: string }[]; revision: number; localSync: LocalSyncOutcome[] }> {
  if (!store.schemaCurrent()) throw Error("Skill library needs the current database version.");
  const fetched = await fetchGithubSkillBundle(args.url, fetcher);
  const when = now.toISOString();
  const res = store.transact(() => {
    const prevRow = store.handle.prepare("SELECT * FROM skill_bundle WHERE id=?").get(fetched.id);
    const prevBundle = prevRow ? rowToBundle(prevRow) : null;
    const cur = currentLibrary(store);
    const next: LibrarySelection = { ...cur.selection };
    // Remove skills previously owned by this bundle that no longer exist in the new commit.
    if (prevBundle !== null) {
      for (const oldName of prevBundle.skillNames) {
        if (next[oldName]?.sourceId === fetched.id) delete next[oldName];
      }
    }
    const savedNames: string[] = [];
    for (const pkg of fetched.skills) {
      const saved = storeSkillPackage(store, pkg, args.actor, now);
      next[saved.name] = { sha: saved.sha, enabled: true, sourceId: fetched.id };
      savedNames.push(saved.name);
    }
    savedNames.sort();
    const revision = writeLibraryRevision(store, next, args.actor, "bundle-import", now);
    const autoUpdate = args.autoUpdate === undefined ? (prevBundle?.autoUpdate ?? true) : args.autoUpdate;
    store.handle
      .prepare(
        `INSERT INTO skill_bundle
          (id, repo_url, owner, repo_name, branch, subpath, pinned_commit, previous_commit, previous_revision,
           skill_names_json, auto_update, last_checked_at, last_updated_at, held_commit, held_reason, held_at, actor, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)
         ON CONFLICT(id) DO UPDATE SET
           repo_url=excluded.repo_url, branch=excluded.branch, subpath=excluded.subpath,
           previous_commit=skill_bundle.pinned_commit,
           previous_revision=?,
           pinned_commit=excluded.pinned_commit,
           skill_names_json=excluded.skill_names_json,
           auto_update=excluded.auto_update,
           last_checked_at=excluded.last_checked_at,
           last_updated_at=excluded.last_updated_at,
           held_commit=NULL, held_reason=NULL, held_at=NULL`,
      )
      .run(
        fetched.id,
        fetched.repoUrl,
        fetched.owner,
        fetched.repoName,
        fetched.branch,
        fetched.subpath,
        fetched.commit,
        prevBundle?.pinnedCommit ?? null,
        prevBundle !== null ? cur.revision : null,
        JSON.stringify(savedNames),
        autoUpdate ? 1 : 0,
        when,
        when,
        args.actor,
        prevBundle?.createdAt ?? when,
        cur.revision,
      );
    const savedBundle = rowToBundle(store.handle.prepare("SELECT * FROM skill_bundle WHERE id=?").get(fetched.id)!);
    return { bundle: savedBundle, revision };
  });
  const enabled = enabledLibrarySkills(store).packages;
  const localSync = syncEnabledLocalTools(store, { actor: args.actor, skills: enabled, libraryRevision: res.revision, ...(args.home === undefined ? {} : { home: args.home }), ...(args.env === undefined ? {} : { env: args.env }) }, now);
  return { bundle: res.bundle, importedCount: fetched.skills.length, skipped: fetched.skipped, revision: res.revision, localSync };
}

// ---- Daily Auto-Update Sweep, Suspicious Update Hold, and One-Step Rollback -----------------------------------------

const HIGH_RISK_TEXT_RULES: readonly [RegExp, string][] = [
  [/\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:ba|z|da)?sh\b/i, "pipes remote content directly into a shell"],
  [/\b(?:cat|less|head|tail|cp|scp|curl)\b[^\n]{0,160}(?:~\/\.ssh|id_rsa|id_ed25519|up-login\.txt|orders\.db|\.toolroll)/i, "references local secrets or Toolroll state files"],
  [/\bignore\s+(?:all\s+)?(?:previous|prior|earlier)\s+instructions\b/i, "contains prompt-injection override phrasing"],
  [/\boverride\s+(?:the\s+)?system\s+prompt\b/i, "contains system-prompt override phrasing"],
  [/\bapprove\s+this\s+task\s+automatically\b/i, "attempts to direct task approval"],
];

function decodeSkillText(pkg: SkillPackage): string {
  return pkg.files.map((f) => Buffer.from(f.base64, "base64").toString("utf8")).join("\n");
}

/**
 * Deterministic suspicion assessment comparing a bundle's currently pinned skills against an incoming commit's skills.
 * Clean doc/instruction refinements pass automatically; newly introduced scripts, secrets, provider hooks, high-risk
 * shell/override patterns, or mass deletions hold the update for the owner to review.
 */
export function assessBundleUpdateSuspicion(
  previousSkills: readonly SkillPackage[],
  nextSkills: readonly SkillPackage[],
): { suspicious: false } | { suspicious: true; reasons: string[] } {
  const reasons: string[] = [];
  const prevByName = new Map(previousSkills.map((s) => [s.name, s]));
  const nextByName = new Map(nextSkills.map((s) => [s.name, s]));

  // Mass deletion check: removing more than half of a bundle with >= 4 skills.
  if (prevByName.size >= 4) {
    const removed = [...prevByName.keys()].filter((name) => !nextByName.has(name));
    if (removed.length * 2 > prevByName.size) {
      reasons.push(`removes ${removed.length} of ${prevByName.size} skills in one update`);
    }
  }

  for (const next of nextSkills) {
    const prev = prevByName.get(next.name);
    const prevScripts = new Set((prev?.files ?? []).filter((f) => f.path.startsWith("scripts/")).map((f) => f.path));
    const newScripts = next.files.filter((f) => f.path.startsWith("scripts/") && !prevScripts.has(f.path));
    if (newScripts.length > 0) {
      reasons.push(`${next.name}: adds new script file(s) (${newScripts.map((f) => f.path).join(", ")})`);
    }
    const prevWarnings = new Set(prev?.warnings ?? []);
    const newWarnings = next.warnings.filter((w) => !prevWarnings.has(w));
    for (const warning of newWarnings) {
      reasons.push(`${next.name}: ${warning}`);
    }
    const nextText = decodeSkillText(next);
    const prevText = prev ? decodeSkillText(prev) : "";
    if (scanForSecrets(nextText).length > 0) {
      reasons.push(`${next.name}: contains secret-like material`);
    }
    for (const [pattern, label] of HIGH_RISK_TEXT_RULES) {
      if (pattern.test(nextText) && !pattern.test(prevText)) {
        reasons.push(`${next.name}: ${label}`);
      }
    }
  }

  return reasons.length > 0 ? { suspicious: true, reasons } : { suspicious: false };
}

export type BundleSweepResult = {
  id: string;
  status: "up-to-date" | "updated" | "held" | "skipped-recent" | "error";
  commit?: string;
  previousCommit?: string;
  reasons?: string[];
  error?: string;
};

/**
 * Daily update sweep across all auto-updating GitHub skill bundles:
 * - Resolves each bundle's tracked branch to its latest 40-hex commit.
 * - Clean updates apply automatically (recording `previous_commit` & `previous_revision` for one-step rollback).
 * - Suspicious updates are held (`held_commit`, `held_reason`, `held_at`) without changing active skills.
 */
export async function sweepSkillBundleUpdates(
  store: Store,
  options: {
    actor: string;
    now?: Date;
    fetcher?: typeof fetch;
    force?: boolean;
    onlyBundleId?: string;
    allowSuspiciousForId?: string;
    home?: string;
    env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<BundleSweepResult[]> {
  if (!store.schemaCurrent()) return [];
  const now = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  const bundles = listSkillBundles(store).filter((b) =>
    options.onlyBundleId !== undefined ? b.id === options.onlyBundleId : b.autoUpdate,
  );
  const results: BundleSweepResult[] = [];
  let anyUpdated = false;
  let latestRevision = currentLibrary(store).revision;

  for (const bundle of bundles) {
    if (!options.force && bundle.lastCheckedAt !== null) {
      const elapsed = now.getTime() - Date.parse(bundle.lastCheckedAt);
      if (Number.isFinite(elapsed) && elapsed < LIBRARY_LIMITS.dailySweepMs) {
        results.push({ id: bundle.id, status: "skipped-recent", commit: bundle.pinnedCommit });
        continue;
      }
    }
    const when = now.toISOString();
    try {
      const budget = { remaining: 2 * 1024 * 1024 };
      const latest = await githubJson<{ sha?: string }>(
        bundle.owner,
        bundle.repoName,
        `/commits/${encodeURIComponent(bundle.branch)}`,
        fetcher,
        budget,
      );
      if (typeof latest.sha !== "string" || !/^[0-9a-f]{40}$/.test(latest.sha)) {
        throw Error("GitHub returned no commit SHA for bundle branch.");
      }
      if (latest.sha === bundle.pinnedCommit) {
        store.handle.prepare("UPDATE skill_bundle SET last_checked_at=? WHERE id=?").run(when, bundle.id);
        results.push({ id: bundle.id, status: "up-to-date", commit: bundle.pinnedCommit });
        continue;
      }

      const incoming = await fetchGithubSkillBundle(bundle.repoUrl, fetcher, latest.sha);
      const cur = currentLibrary(store);
      const prevSkills: SkillPackage[] = [];
      for (const name of bundle.skillNames) {
        const entry = cur.selection[name];
        if (entry) prevSkills.push(packageBySha(store, entry.sha));
      }

      const check = assessBundleUpdateSuspicion(prevSkills, incoming.skills);
      if (check.suspicious && options.allowSuspiciousForId !== bundle.id) {
        store.handle
          .prepare(
            "UPDATE skill_bundle SET last_checked_at=?, held_commit=?, held_reason=?, held_at=? WHERE id=?",
          )
          .run(when, incoming.commit, check.reasons.join("; "), when, bundle.id);
        results.push({ id: bundle.id, status: "held", commit: incoming.commit, previousCommit: bundle.pinnedCommit, reasons: check.reasons });
        continue;
      }

      // Apply clean (or explicitly owner-approved) update atomically, recording rollback pointers.
      latestRevision = store.transact(() => {
        const current = currentLibrary(store);
        const next: LibrarySelection = { ...current.selection };
        for (const oldName of bundle.skillNames) {
          if (next[oldName]?.sourceId === bundle.id) delete next[oldName];
        }
        const savedNames: string[] = [];
        for (const pkg of incoming.skills) {
          const saved = storeSkillPackage(store, pkg, options.actor, now);
          const wasEnabled = current.selection[saved.name]?.enabled ?? true;
          next[saved.name] = { sha: saved.sha, enabled: wasEnabled, sourceId: bundle.id };
          savedNames.push(saved.name);
        }
        savedNames.sort();
        const rev = writeLibraryRevision(store, next, options.actor, "auto-update", now);
        store.handle
          .prepare(
            `UPDATE skill_bundle
             SET previous_commit=?, previous_revision=?, pinned_commit=?, skill_names_json=?,
                 last_checked_at=?, last_updated_at=?, held_commit=NULL, held_reason=NULL, held_at=NULL
             WHERE id=?`,
          )
          .run(bundle.pinnedCommit, current.revision, incoming.commit, JSON.stringify(savedNames), when, when, bundle.id);
        return rev;
      });
      anyUpdated = true;
      results.push({ id: bundle.id, status: "updated", commit: incoming.commit, previousCommit: bundle.pinnedCommit });
    } catch (error) {
      store.handle.prepare("UPDATE skill_bundle SET last_checked_at=? WHERE id=?").run(when, bundle.id);
      results.push({ id: bundle.id, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (anyUpdated) {
    const enabled = enabledLibrarySkills(store).packages;
    syncEnabledLocalTools(store, { actor: options.actor, skills: enabled, libraryRevision: latestRevision, ...(options.home === undefined ? {} : { home: options.home }), ...(options.env === undefined ? {} : { env: options.env }) }, now);
  }
  return results;
}

/** One-step rollback of a bundle to its previous pinned commit and library revision. */
export function rollbackSkillBundle(
  store: Store,
  args: { id: string; actor: string; home?: string; env?: Readonly<Record<string, string | undefined>> },
  now = new Date(),
): { bundle: SkillBundleRecord; revision: number; localSync: LocalSyncOutcome[] } {
  if (!store.schemaCurrent()) throw Error("Skill library needs the current database version.");
  const res = store.transact(() => {
    const row = store.handle.prepare("SELECT * FROM skill_bundle WHERE id=?").get(args.id);
    if (!row) throw Error("That skill bundle was not found.");
    const bundle = rowToBundle(row);
    if (bundle.previousCommit === null || bundle.previousRevision === null) {
      throw Error("No previous version is available to roll back to.");
    }
    const revRow = store.handle
      .prepare("SELECT payload, sha FROM skill_library_change WHERE revision=?")
      .get(bundle.previousRevision);
    if (!revRow) throw Error("The previous skill library revision could not be loaded.");
    const previousSelection = parseLibrarySelection(revRow["payload"], revRow["sha"]);
    for (const choice of Object.values(previousSelection)) packageBySha(store, choice.sha);

    const cur = currentLibrary(store);
    const next: LibrarySelection = { ...cur.selection };
    // Restore only this bundle's skills from the previous revision (leaving unrelated manual/other-bundle edits intact).
    for (const name of bundle.skillNames) {
      if (next[name]?.sourceId === bundle.id) delete next[name];
    }
    const restoredNames: string[] = [];
    for (const [name, choice] of Object.entries(previousSelection)) {
      if (choice.sourceId === bundle.id) {
        next[name] = choice;
        restoredNames.push(name);
      }
    }
    restoredNames.sort();
    const revision = writeLibraryRevision(store, next, args.actor, "rollback", now);
    const when = now.toISOString();
    store.handle
      .prepare(
        `UPDATE skill_bundle
         SET pinned_commit=?, previous_commit=NULL, previous_revision=NULL, skill_names_json=?,
             last_updated_at=?, held_commit=NULL, held_reason=NULL, held_at=NULL
         WHERE id=?`,
      )
      .run(bundle.previousCommit, JSON.stringify(restoredNames), when, bundle.id);
    const updated = rowToBundle(store.handle.prepare("SELECT * FROM skill_bundle WHERE id=?").get(bundle.id)!);
    return { bundle: updated, revision };
  });
  const enabled = enabledLibrarySkills(store).packages;
  const localSync = syncEnabledLocalTools(store, { actor: args.actor, skills: enabled, libraryRevision: res.revision, ...(args.home === undefined ? {} : { home: args.home }), ...(args.env === undefined ? {} : { env: args.env }) }, now);
  return { ...res, localSync };
}

/** Dismiss a held suspicious update without applying it. */
export function dismissHeldBundleUpdate(store: Store, id: string): void {
  store.handle.prepare("UPDATE skill_bundle SET held_commit=NULL, held_reason=NULL, held_at=NULL WHERE id=?").run(id);
}

/** Toggle automatic daily updates for one tracked bundle. */
export function setBundleAutoUpdate(store: Store, id: string, enabled: boolean): void {
  const res = store.handle.prepare("UPDATE skill_bundle SET auto_update=? WHERE id=?").run(enabled ? 1 : 0, id);
  if (Number(res.changes) === 0) throw Error("That skill bundle was not found.");
}

export { localSyncStatus, setLocalSkillSync, syncEnabledLocalTools, type LocalSkillTool, type LocalSyncOutcome };
