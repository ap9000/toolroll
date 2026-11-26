/**
 * "Also install on this computer" — syncs Toolroll's global skill library into the user's own local Claude Code,
 * Codex and Gemini CLI skills folders, written ONLY where each tool is actually seen to read.
 *
 * Safety invariants:
 * - Never invents a home folder for a tool that isn't present on this computer.
 * - Never writes through a symlink (every ancestor and target folder is verified real & non-symlink).
 * - Never overwrites or deletes a user's own hand-written skill folder (tracks Toolroll-owned folders with a
 *   `.toolroll-managed.json` marker, and skips any folder that already exists without that marker).
 * - Never touches the reserved `toolroll` / `standing-orders` operator skill folders managed by `toolroll onboard`.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SavedSkill } from "./project-skills.js";
import { within } from "./skills-manifest.js";
import type { Store } from "./store.js";

export type LocalSkillTool = "claude" | "codex" | "gemini";
export const LOCAL_SKILL_TOOLS: readonly LocalSkillTool[] = ["claude", "codex", "gemini"];
export const LOCAL_TOOL_LABELS: Record<LocalSkillTool, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
};

const MANAGED_MARKER_FILE = ".toolroll-managed.json";
const RESERVED_NAMES = new Set(["toolroll", "standing-orders"]);

type ManagedMarker = {
  managedBy: "toolroll-skill-library";
  version: 1;
  name: string;
  sha: string;
  files: string[];
};

export type DetectedLocalTool = {
  tool: LocalSkillTool;
  label: string;
  detected: boolean;
  toolHome: string;
  skillsDir: string | null;
  enabled: boolean;
  syncedRevision: number;
  syncedAt: string | null;
  installedCount: number;
};

export type LocalSyncOutcome = {
  tool: LocalSkillTool;
  targetDir: string;
  written: string[];
  removed: string[];
  skippedForeign: string[];
};

function isRealDir(path: string): boolean {
  try {
    const held = lstatSync(path);
    return held.isDirectory() && !held.isSymbolicLink();
  } catch {
    return false;
  }
}

function noSymlinkBelow(base: string, target: string): boolean {
  if (target !== base && !within(target, base)) return false;
  let at = base;
  if (!isRealDir(at)) return false;
  if (target === base) return true;
  const rel = target.slice(base.length + 1).split("/");
  for (const part of rel) {
    at = join(at, part);
    if (existsSync(at)) {
      try {
        const held = lstatSync(at);
        if (held.isSymbolicLink()) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

/** Resolve where each tool is seen to read skills on this computer. Returns null `skillsDir` when not seen. */
export function detectLocalSkillDirs(
  home = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<LocalSkillTool, { toolHome: string; skillsDir: string | null; detected: boolean }> {
  const realHome = existsSync(home) ? realpathSync(home) : resolve(home);
  const envDir = (key: string, fallback: string): string => {
    const raw = env[key]?.trim();
    if (!raw) return join(realHome, fallback);
    return isAbsolute(raw) ? resolve(raw) : resolve(realHome, raw);
  };
  const homes: Record<LocalSkillTool, string> = {
    claude: envDir("CLAUDE_CONFIG_DIR", ".claude"),
    codex: envDir("CODEX_HOME", ".codex"),
    gemini: envDir("GEMINI_CLI_HOME", ".gemini"),
  };
  const out = {} as Record<LocalSkillTool, { toolHome: string; skillsDir: string | null; detected: boolean }>;
  for (const tool of LOCAL_SKILL_TOOLS) {
    const toolHome = homes[tool];
    const detected = isRealDir(toolHome);
    const skillsDir = detected ? join(realpathSync(toolHome), "skills") : null;
    // Refuse if `<toolHome>/skills` exists as a symlink or non-directory.
    const validSkills = skillsDir !== null && (!existsSync(skillsDir) || isRealDir(skillsDir));
    out[tool] = {
      toolHome,
      skillsDir: validSkills ? skillsDir : null,
      detected: detected && validSkills,
    };
  }
  return out;
}

function readManagedMarker(skillDir: string): ManagedMarker | null {
  const markerPath = join(skillDir, MANAGED_MARKER_FILE);
  try {
    const held = lstatSync(markerPath);
    if (!held.isFile() || held.isSymbolicLink() || held.size > 256 * 1024) return null;
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<ManagedMarker>;
    if (
      parsed.managedBy !== "toolroll-skill-library" ||
      parsed.version !== 1 ||
      typeof parsed.name !== "string" ||
      typeof parsed.sha !== "string" ||
      !Array.isArray(parsed.files) ||
      parsed.files.some((f) => typeof f !== "string")
    ) {
      return null;
    }
    return parsed as ManagedMarker;
  } catch {
    return null;
  }
}

function removeEmptyAncestors(from: string, stopAt: string): void {
  let at = from;
  while (at !== stopAt && within(at, stopAt)) {
    try {
      if (!isRealDir(at)) break;
      if (readdirSync(at).length > 0) break;
      rmdirSync(at);
      at = dirname(at);
    } catch {
      break;
    }
  }
}

function removeManagedSkillDir(skillsDir: string, skillName: string): boolean {
  const skillDir = join(skillsDir, skillName);
  if (!existsSync(skillDir) || !isRealDir(skillDir)) return false;
  const marker = readManagedMarker(skillDir);
  if (marker === null) return false;
  for (const rel of marker.files) {
    const full = join(skillDir, rel);
    if (!within(full, skillDir)) continue;
    try {
      const held = lstatSync(full);
      if (held.isFile() && !held.isSymbolicLink()) {
        unlinkSync(full);
        removeEmptyAncestors(dirname(full), skillDir);
      }
    } catch {
      /* already gone */
    }
  }
  try {
    unlinkSync(join(skillDir, MANAGED_MARKER_FILE));
  } catch {
    /* already gone */
  }
  removeEmptyAncestors(skillDir, skillsDir);
  return true;
}

/**
 * Sync an exact list of enabled global skills into one tool's detected skills folder.
 * Only writes/removes folders carrying `.toolroll-managed.json`. Foreign folders are never touched.
 */
export function syncSkillsToDirectory(
  tool: LocalSkillTool,
  skillsDir: string,
  skills: readonly SavedSkill[],
  previouslyInstalled: Record<string, { sha: string; files: string[] }>,
): { outcome: LocalSyncOutcome; installed: Record<string, { sha: string; files: string[] }> } {
  const parent = dirname(skillsDir);
  if (!isRealDir(parent)) throw Error(`${LOCAL_TOOL_LABELS[tool]} home folder was not found on this computer.`);
  if (existsSync(skillsDir) && !isRealDir(skillsDir)) {
    throw Error(`${skillsDir} is not a real folder — refusing to sync skills there.`);
  }
  if (!existsSync(skillsDir)) mkdirSync(skillsDir, { mode: 0o700 });
  const realSkillsDir = realpathSync(skillsDir);

  const written: string[] = [];
  const removed: string[] = [];
  const skippedForeign: string[] = [];
  const nextInstalled: Record<string, { sha: string; files: string[] }> = {};
  const wantedNames = new Set<string>();

  for (const skill of skills) {
    if (RESERVED_NAMES.has(skill.name)) continue;
    wantedNames.add(skill.name);
    const skillDir = join(realSkillsDir, skill.name);
    if (!within(skillDir, realSkillsDir)) continue;
    if (existsSync(skillDir)) {
      if (!isRealDir(skillDir) || readManagedMarker(skillDir) === null) {
        skippedForeign.push(skill.name);
        continue;
      }
    }
    const existingMarker = existsSync(skillDir) ? readManagedMarker(skillDir) : null;
    if (existingMarker !== null && existingMarker.sha === skill.sha) {
      nextInstalled[skill.name] = { sha: skill.sha, files: existingMarker.files };
      continue;
    }
    // Remove stale managed files from an earlier version before writing the new ones.
    if (existingMarker !== null) {
      for (const oldRel of existingMarker.files) {
        const oldPath = join(skillDir, oldRel);
        if (!within(oldPath, skillDir)) continue;
        try {
          const held = lstatSync(oldPath);
          if (held.isFile() && !held.isSymbolicLink()) {
            unlinkSync(oldPath);
            removeEmptyAncestors(dirname(oldPath), skillDir);
          }
        } catch {
          /* gone */
        }
      }
    }
    if (!existsSync(skillDir)) mkdirSync(skillDir, { mode: 0o700 });
    if (!noSymlinkBelow(realSkillsDir, skillDir)) {
      skippedForeign.push(skill.name);
      continue;
    }
    const fileList: string[] = [];
    for (const file of skill.files) {
      const target = join(skillDir, file.path);
      if (!within(target, skillDir) || !noSymlinkBelow(skillDir, dirname(target))) continue;
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) continue;
      writeFileSync(target, Buffer.from(file.base64, "base64"), { mode: 0o600 });
      fileList.push(file.path);
    }
    const marker: ManagedMarker = {
      managedBy: "toolroll-skill-library",
      version: 1,
      name: skill.name,
      sha: skill.sha,
      files: fileList.sort(),
    };
    writeFileSync(join(skillDir, MANAGED_MARKER_FILE), JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 });
    nextInstalled[skill.name] = { sha: skill.sha, files: marker.files };
    written.push(skill.name);
  }

  // Clean up any previously managed skills no longer in the enabled global library.
  for (const oldName of Object.keys(previouslyInstalled)) {
    if (wantedNames.has(oldName) || RESERVED_NAMES.has(oldName)) continue;
    if (removeManagedSkillDir(realSkillsDir, oldName)) removed.push(oldName);
  }
  // Also catch any orphaned Toolroll-managed directories inside realSkillsDir.
  for (const entry of readdirSync(realSkillsDir)) {
    if (wantedNames.has(entry) || RESERVED_NAMES.has(entry)) continue;
    if (removeManagedSkillDir(realSkillsDir, entry) && !removed.includes(entry)) removed.push(entry);
  }

  return {
    outcome: { tool, targetDir: realSkillsDir, written, removed, skippedForeign },
    installed: nextInstalled,
  };
}

/** Read current local sync state merged with live tool directory detection. */
export function localSyncStatus(
  store: Store,
  options: { home?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): DetectedLocalTool[] {
  const detected = detectLocalSkillDirs(options.home, options.env);
  const rows = new Map<string, Record<string, unknown>>();
  for (const row of store.handle.prepare("SELECT * FROM skill_local_sync").all()) {
    rows.set(String(row["tool"]), row);
  }
  return LOCAL_SKILL_TOOLS.map((tool) => {
    const found = detected[tool];
    const row = rows.get(tool);
    let installedCount = 0;
    if (row && typeof row["installed_json"] === "string") {
      try {
        installedCount = Object.keys(JSON.parse(row["installed_json"]) as Record<string, unknown>).length;
      } catch {
        installedCount = 0;
      }
    }
    return {
      tool,
      label: LOCAL_TOOL_LABELS[tool],
      detected: found.detected,
      toolHome: found.toolHome,
      skillsDir: found.skillsDir,
      enabled: row !== undefined && Number(row["enabled"]) === 1,
      syncedRevision: row !== undefined ? Number(row["synced_revision"]) : 0,
      syncedAt: row !== undefined && typeof row["synced_at"] === "string" ? row["synced_at"] : null,
      installedCount,
    };
  });
}

/** Toggle "Also install on this computer" for one tool, syncing immediately when enabled or cleaning managed skills when disabled. */
export function setLocalSkillSync(
  store: Store,
  args: {
    tool: LocalSkillTool;
    enabled: boolean;
    actor: string;
    skills: readonly SavedSkill[];
    libraryRevision: number;
    home?: string;
    env?: Readonly<Record<string, string | undefined>>;
  },
  now = new Date(),
): LocalSyncOutcome | null {
  if (!LOCAL_SKILL_TOOLS.includes(args.tool)) throw Error("Choose Claude Code, Codex, or Gemini CLI.");
  const detected = detectLocalSkillDirs(args.home, args.env)[args.tool];
  const existing = store.handle.prepare("SELECT * FROM skill_local_sync WHERE tool=?").get(args.tool);
  const previousInstalled: Record<string, { sha: string; files: string[] }> = (() => {
    if (!existing || typeof existing["installed_json"] !== "string") return {};
    try {
      return JSON.parse(existing["installed_json"]) as Record<string, { sha: string; files: string[] }>;
    } catch {
      return {};
    }
  })();

  if (args.enabled) {
    if (!detected.detected || detected.skillsDir === null) {
      throw Error(`${LOCAL_TOOL_LABELS[args.tool]} was not detected at ${detected.toolHome}. Install or open ${LOCAL_TOOL_LABELS[args.tool]} first so Toolroll only writes where it reads.`);
    }
    const { outcome, installed } = syncSkillsToDirectory(args.tool, detected.skillsDir, args.skills, previousInstalled);
    const when = now.toISOString();
    store.handle
      .prepare(
        `INSERT INTO skill_local_sync (tool, enabled, target_dir, installed_json, synced_revision, synced_at, updated_by, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tool) DO UPDATE SET enabled=1, target_dir=excluded.target_dir, installed_json=excluded.installed_json,
           synced_revision=excluded.synced_revision, synced_at=excluded.synced_at, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      )
      .run(args.tool, outcome.targetDir, JSON.stringify(installed), args.libraryRevision, when, args.actor, when);
    return outcome;
  }

  // Disabling: cleanly remove only Toolroll-managed skill folders if the target dir is still present.
  const targetDir = detected.skillsDir ?? (typeof existing?.["target_dir"] === "string" ? existing["target_dir"] : null);
  let outcome: LocalSyncOutcome | null = null;
  if (targetDir !== null && isRealDir(targetDir)) {
    const synced = syncSkillsToDirectory(args.tool, targetDir, [], previousInstalled);
    outcome = synced.outcome;
  }
  const when = now.toISOString();
  store.handle
    .prepare(
      `INSERT INTO skill_local_sync (tool, enabled, target_dir, installed_json, synced_revision, synced_at, updated_by, updated_at)
       VALUES (?, 0, ?, '{}', 0, NULL, ?, ?)
       ON CONFLICT(tool) DO UPDATE SET enabled=0, installed_json='{}', synced_revision=0, synced_at=NULL, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    )
    .run(args.tool, targetDir, args.actor, when);
  return outcome;
}

/** Re-sync every enabled local tool to the current global skill library revision. */
export function syncEnabledLocalTools(
  store: Store,
  args: {
    actor: string;
    skills: readonly SavedSkill[];
    libraryRevision: number;
    home?: string;
    env?: Readonly<Record<string, string | undefined>>;
  },
  now = new Date(),
): LocalSyncOutcome[] {
  const rows = store.handle.prepare("SELECT * FROM skill_local_sync WHERE enabled=1").all();
  const outcomes: LocalSyncOutcome[] = [];
  for (const row of rows) {
    const tool = String(row["tool"]) as LocalSkillTool;
    if (!LOCAL_SKILL_TOOLS.includes(tool)) continue;
    const detected = detectLocalSkillDirs(args.home, args.env)[tool];
    if (!detected.detected || detected.skillsDir === null) continue;
    let previousInstalled: Record<string, { sha: string; files: string[] }> = {};
    if (typeof row["installed_json"] === "string") {
      try {
        previousInstalled = JSON.parse(row["installed_json"]) as Record<string, { sha: string; files: string[] }>;
      } catch {
        previousInstalled = {};
      }
    }
    const { outcome, installed } = syncSkillsToDirectory(tool, detected.skillsDir, args.skills, previousInstalled);
    const when = now.toISOString();
    store.handle
      .prepare(
        `UPDATE skill_local_sync SET target_dir=?, installed_json=?, synced_revision=?, synced_at=?, updated_by=?, updated_at=? WHERE tool=?`,
      )
      .run(outcome.targetDir, JSON.stringify(installed), args.libraryRevision, when, args.actor, when, tool);
    outcomes.push(outcome);
  }
  return outcomes;
}
