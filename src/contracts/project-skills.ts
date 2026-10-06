/**
 * Project skills (project-skills.ts): one schema for a skill package (`skill_package`), a project's selection of
 * versions (`project_skill_change`), and the versions a run is pinned to (`skill_snapshot`, and the snapshot a reviewer
 * reads). The rules JSON Schema cannot state — UTF-8 byte limits, base64, path safety, YAML metadata, secrets, the
 * selection's total size — run in plain code (`validateSkill`, `changeSkills`) when a skill is imported or chosen.
 *
 * Two payloads carry no envelope, on purpose. A package is content-addressed: its digest is its version, so the same
 * folder imported before and after this contract is the same version. A selection maps skill names to versions, and
 * `version` is itself a valid skill name, so a key there would collide with one; an older runtime also reads every
 * value in it as a choice. Both are read exactly as they have always been written.
 */

import { z } from "zod";
import { TEXT_LIMITS, type TextLimitKey } from "../text-limits.js";
import { limited, readVersioned, versioned, type ContractResult } from "./contract.js";

/** How many files a package holds, how many versions a project enables and a person's library keeps. Text limits live
 * in TEXT_LIMITS. */
export const SKILL_COUNTS = { files: 64, enabled: 8, library: 100 } as const;

/** Every skill limit by its long-standing name: the counts above and the byte limits from TEXT_LIMITS. */
export const SKILL_LIMITS = {
  files: SKILL_COUNTS.files,
  packageBytes: TEXT_LIMITS.skillPackageBytes,
  fileBytes: TEXT_LIMITS.skillFileBytes,
  bodyBytes: TEXT_LIMITS.skillBodyBytes,
  enabled: SKILL_COUNTS.enabled,
  selectionBytes: TEXT_LIMITS.skillSelectionBytes,
} as const;

/** A text field: bounded by its TEXT_LIMITS entry when written, read as saved (text-limits.ts: reading never
 * re-validates length, so an older runtime still reads text a newer one allowed). */
type Text = (field: string, key: TextLimitKey) => z.ZodString;
const written: Text = limited;
const saved: Text = () => z.string();

/** A skill name: lowercase words joined by hyphens. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const fileShape = (text: Text) => ({
  /** Relative to the skill folder; no hidden parts, `.` or `..`. */
  path: text("file path", "skillPath"),
  /** The file's bytes, base64 (each at most TEXT_LIMITS.skillFileBytes once decoded). */
  base64: z.string(),
});

const packageShape = (text: Text) => ({
  name: text("skill name", "skillNameBytes").regex(SKILL_NAME),
  description: text("description", "skillDescriptionBytes"),
  /** Where it was imported from: an uploaded folder or a GitHub folder pinned to a commit. */
  source: text("source", "skillSourceBytes"),
  /** SKILL.md's `compatibility`, or empty. */
  requirements: text("requirements", "skillRequirementsBytes"),
  warnings: z.array(z.string()),
  files: z.array(z.strictObject(fileShape(text))).min(1).max(SKILL_COUNTS.files),
});

export const skillFileSchema = z.strictObject(fileShape(written));
/** A package as it is imported. */
export const skillPackageSchema = z.strictObject(packageShape(written));
/** A package as it is read back. */
export const savedSkillPackageSchema = z.strictObject(packageShape(saved));
/** A package with its version (the digest of its bytes). */
export const savedSkillSchema = z.strictObject({ ...packageShape(saved), sha: z.string() });

export type SkillFile = z.infer<typeof skillFileSchema>;
export type SkillPackage = z.infer<typeof skillPackageSchema>;
export type SavedSkill = z.infer<typeof savedSkillSchema>;

/** One skill's chosen version, and whether it is on. */
export const skillChoiceSchema = z.strictObject({ sha: z.string(), enabled: z.boolean() });
/** A project's selection: each skill name and its chosen version. */
export const skillSelectionSchema = z.record(z.string(), skillChoiceSchema);

export type SkillChoice = z.infer<typeof skillChoiceSchema>;
export type SkillSelection = z.infer<typeof skillSelectionSchema>;

const snapshotFacts = {
  /** The selection revision the versions came from; 0 for none. */
  revision: z.int().min(0),
  /** The project identity they were chosen under, or `unconfigured`. */
  identity: z.string(),
  /** The run a reviewer or later attempt inherited them from. */
  inheritedFrom: z.int().nullable(),
  /** A skill test: the one package is the version under test. */
  test: z.boolean(),
};

export const SKILLS_SNAPSHOT_VERSION = 1;

/** The versions a run is pinned to, as frozen: the packages by digest. */
export const savedSkillsSnapshotSchema = versioned(SKILLS_SNAPSHOT_VERSION, { ...snapshotFacts, packageShas: z.array(z.string()) });
/** The same snapshot with each package read, as a run and its reviewer get it. */
export const skillsSnapshotSchema = versioned(SKILLS_SNAPSHOT_VERSION, { ...snapshotFacts, packages: z.array(savedSkillSchema) });

export type SavedSkillsSnapshot = z.infer<typeof savedSkillsSnapshotSchema>;
export type SkillsSnapshot = z.infer<typeof skillsSnapshotSchema>;

/** Read a frozen snapshot: version 1 (every snapshot ever frozen) as itself, a newer one refused plainly. */
export function readSkillsSnapshotPayload(input: unknown): ContractResult<SavedSkillsSnapshot> {
  return readVersioned(savedSkillsSnapshotSchema, input);
}
