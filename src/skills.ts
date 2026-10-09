/**
 * `toolroll skills install` (M7.13) — how a repository tells its
 * agents this queue exists.
 *
 * Two artifacts, both operator-invoked, previewed by default, and marked
 * as managed so nothing here ever overwrites a file it does not own:
 *
 *   - `.claude/skills/toolroll/SKILL.md` — the Agent Skills entry
 *     (the cross-vendor layout Claude Code, Codex, Gemini CLI, and
 *     opencode all read). Router-style: the description says when to
 *     reach for the CLI; the body carries the operating contract and
 *     defers to live `--help` for everything else, because a skill that
 *     duplicates the manual drifts from it.
 *   - a managed AGENTS.md block (CLAUDE.md-compatible), written only
 *     with --write-context, replaced only between its own markers.
 *
 * DESIGN's "nothing is ever installed for you" holds: this command runs
 * when the operator runs it, shows exactly what it would write, and
 * touches nothing without --yes.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { guideNamed } from "./guides.js";

export const SKILL_DIR = join(".claude", "skills", "toolroll");
/** Where installs before the rename to Toolroll put the skill: still found, and replaced by the new one. */
export const LEGACY_SKILL_DIR = join(".claude", "skills", "standing-orders");
export const SKILL_FILE = "SKILL.md";
export const MANAGED_MARK = "managed by toolroll — edits outside the markers survive reinstalls";
const LEGACY_MANAGED_MARK = "managed by standing-orders — edits outside the markers survive reinstalls";
/** Frontmatter a skill of ours starts with, under either name. */
const OWN_HEADERS = ["---\nname: toolroll\n", "---\nname: standing-orders\n"];
const ownHeader = (content: string) => OWN_HEADERS.some(header => content.startsWith(header));
export const CONTEXT_BEGIN = "<!-- standing-orders:begin -->";
export const CONTEXT_END = "<!-- standing-orders:end -->";

/** The skill, complete. The description is the routing contract. The body
 * is the binary-served `operating` guide (guides.ts) — ONE source, so the
 * installed snapshot and `skills get operating` cannot drift apart within
 * a version. The frontmatter prefix and the managed mark are the ownership
 * signature planInstall checks — do not reword them. */
export function skillContent(): string {
  const operating = guideNamed("operating");
  if (operating === null) throw new Error("the operating guide is missing from the build");
  return `---
name: toolroll
description: Operate this repository's unattended work queue via the toolroll CLI, and explain its console. Use when asked to file or inspect tasks (including scout tasks that deliver a report), check what is ready or blocked, peek at live agents, read run results and briefs, see what awaits a human decision, or tell the operator which screen or command does what. Not for pushing, merging, or approving anything — approvals are the operator's, always.
---

<!-- ${MANAGED_MARK} -->

${operating.content}
<!-- end ${MANAGED_MARK} -->
`;
}

/** The AGENTS.md block, marker-fenced so reinstalls replace only themselves. */
export function contextBlock(): string {
  return `${CONTEXT_BEGIN}
This repository's unattended work runs through the \`toolroll\` CLI
(work queue, decisions, runs). Machine answers: add \`--json\` — one
envelope per command, stable \`reason\` tokens, exit 3 means "no" not
"broken", every mutation takes an idempotency \`--key\`. Refusals like
\`held\`, \`fenced\`, \`reserved\`, \`unapproved\`, and \`external\` are
answers to branch on, not errors to retry. Details:
\`.claude/skills/toolroll/SKILL.md\`, or \`toolroll --help\`,
which is authoritative — and \`toolroll skills get <name>\` serves
version-matched guides straight from the binary (\`skills list\` names
them). Project memory (instructions, references, lessons, decisions) lives
in the plane: read \`skills get knowledge\`, search it with
\`toolroll memory search\`, and record settled choices with
\`memory decide\` instead of editing this file. Never approve, push, or
merge anything yourself.
${CONTEXT_END}`;
}

/**
 * Whether a repository has the Toolroll skill: a SKILL.md in the current
 * folder, or in the one installs before the rename used. The setup guide
 * and the console's first-run checklist both ask this, so they agree.
 */
export function projectSkillInstalled(repo: string): boolean {
  return [SKILL_DIR, LEGACY_SKILL_DIR].some(dir => existsSync(join(repo, dir, SKILL_FILE)));
}

export type InstallPlan = {
  skillPath: string;
  skillAction: "create" | "replace" | "refuse-foreign";
  /** A skill of ours under the old folder name, removed once the new one is written. */
  legacySkillPath: string | null;
  contextPath: string | null;
  contextAction: "create" | "insert" | "replace" | "skip";
};

export type InstallResult =
  | { ok: true; plan: InstallPlan; wrote: string[] }
  | { ok: false; reason: "foreign-skill" | "broken-markers"; message: string };

/** What install would do, computed without writing anything. */
export function planInstall(repo: string, writeContext: boolean): InstallPlan {
  const skillPath = join(repo, SKILL_DIR, SKILL_FILE);
  let skillAction: InstallPlan["skillAction"] = "create";
  if (existsSync(skillPath)) {
    const current = readFileSync(skillPath, "utf8");
    // Ownership is the exact header AND the managed mark — a foreign file
    // that merely quotes the mark somewhere is not ours (audit C-10).
    const ours = ownHeader(current) && (current.includes(MANAGED_MARK) || current.includes(LEGACY_MANAGED_MARK));
    skillAction = ours ? "replace" : "refuse-foreign";
  }
  const legacy = join(repo, LEGACY_SKILL_DIR, SKILL_FILE);
  const legacySkillPath = realFolder(join(repo, ".claude")) && realFolder(join(repo, ".claude", "skills")) && realFolder(join(repo, LEGACY_SKILL_DIR)) && isOwnFile(legacy, current => ownHeader(current) && (current.includes(MANAGED_MARK) || current.includes(LEGACY_MANAGED_MARK))) ? legacy : null;

  const contextPath = writeContext ? join(repo, "AGENTS.md") : null;
  let contextAction: InstallPlan["contextAction"] = "skip";
  if (contextPath !== null) {
    if (!existsSync(contextPath)) contextAction = "create";
    else {
      const current = readFileSync(contextPath, "utf8");
      contextAction = current.includes(CONTEXT_BEGIN) ? "replace" : "insert";
    }
  }
  return { skillPath, skillAction, legacySkillPath, contextPath, contextAction };
}

/** Apply the plan. Refuses a foreign skill file rather than eating it. */
export function applyInstall(repo: string, writeContext: boolean): InstallResult {
  const plan = planInstall(repo, writeContext);
  if (plan.skillAction === "refuse-foreign") {
    return {
      ok: false,
      reason: "foreign-skill",
      message: `${plan.skillPath} exists and was not written by this installer — refusing to overwrite a file that is not mine`,
    };
  }
  // EVERY validation happens before EITHER file is touched — "nothing was
  // written" must be true when it is said (arc-5 review, finding 6; the
  // old order wrote the skill first and then refused on damaged markers).
  let contextNext: string | null = null;
  if (plan.contextPath !== null && plan.contextAction !== "create") {
    const current = readFileSync(plan.contextPath, "utf8");
    if (plan.contextAction === "replace") {
      // Exactly one well-ordered pair, or a typed refusal — a half block
      // must never produce a silent false success (audit C-10).
      const begins = current.split(CONTEXT_BEGIN).length - 1;
      const ends = current.split(CONTEXT_END).length - 1;
      const begin = current.indexOf(CONTEXT_BEGIN);
      const end = current.indexOf(CONTEXT_END);
      if (begins !== 1 || ends !== 1 || end <= begin) {
        return {
          ok: false,
          reason: "broken-markers",
          message: `${plan.contextPath} carries a damaged managed block (${begins} begin, ${ends} end marker(s)) — repair or remove it by hand; nothing was written`,
        };
      }
      contextNext = current.slice(0, begin) + contextBlock() + current.slice(end + CONTEXT_END.length);
    } else {
      // insert: append after existing content, never rewriting a word of it.
      contextNext = `${current.replace(/\n*$/, "\n\n")}${contextBlock()}\n`;
    }
  }

  const wrote: string[] = [];
  mkdirSync(dirname(plan.skillPath), { recursive: true });
  writeFileSync(plan.skillPath, skillContent());
  wrote.push(plan.skillPath);
  if (plan.legacySkillPath !== null) removeOwn([plan.legacySkillPath]);

  if (plan.contextPath !== null) {
    writeFileSync(plan.contextPath, contextNext ?? `${contextBlock()}\n`);
    wrote.push(plan.contextPath);
  }
  return { ok: true, plan, wrote };
}

/**
 * The user-level Claude Code skill is separate from the repository-local
 * skill above. The former teaches one Claude Code installation how to use
 * this exact Toolroll binary; the latter remains part of the shared
 * project setup flow.
 */
export const CLAUDE_CODE_MANAGED_MARK = "<!-- standing-orders:claude-code-skill:v1 -->";
export const CLAUDE_CODE_GUIDES = ["console", "operating", "runner", "release"] as const;
/** The thin user-level skill `toolroll onboard` writes (agent-onboard.ts). */
export const OPERATOR_SKILL_MARK = "<!-- toolroll:operator-skill:v1";

export type ClaudeCodeSkillFile = {
  name: string;
  path: string;
  action: "create" | "replace" | "refuse-foreign";
};

export type ClaudeCodeInstallPlan = {
  directory: string;
  directoryAction: "create" | "use" | "refuse-foreign";
  files: ClaudeCodeSkillFile[];
  /** Managed files left under the old folder name, removed once the new ones are written. */
  legacyFiles: string[];
};

export type ClaudeCodeInstallResult =
  | { ok: true; plan: ClaudeCodeInstallPlan; wrote: string[] }
  | { ok: false; reason: "foreign-file"; message: string; plan: ClaudeCodeInstallPlan };

export function defaultClaudeCodeSkillDir(home = homedir()): string {
  return join(home, ".claude", "skills", "toolroll");
}

/** Where installs before the rename put the Claude Code skill. */
export function legacyClaudeCodeSkillDir(home = homedir()): string {
  return join(home, ".claude", "skills", "standing-orders");
}

/** A regular file (not a link) whose text says it is ours. */
function isOwnFile(path: string, ours: (content: string) => boolean): boolean {
  if (!existsSync(path)) return false;
  const entry = lstatSync(path);
  return !entry.isSymbolicLink() && entry.isFile() && entry.size <= 2_000_000 && ours(readFileSync(path, "utf8"));
}

/** A folder that is itself, not a link to somewhere else. */
function realFolder(path: string): boolean {
  try { const entry = lstatSync(path); return entry.isDirectory() && !entry.isSymbolicLink(); } catch { return false; }
}

/** Remove files of ours, then their folder only if nothing else is left in it. */
function removeOwn(paths: readonly string[]): void {
  for (const path of paths) unlinkSync(path);
  const folders = new Set(paths.map(path => dirname(path)));
  for (const folder of folders) if (readdirSync(folder).length === 0) rmdirSync(folder);
}

/** SKILL.md links to the full guides instead of copying their detail. */
export function claudeCodeSkillContent(): string {
  return `---
name: toolroll
description: Use this machine's Toolroll installation from Claude Code. Use when the user asks about its console, tasks, approvals, results, or runner workflow.
---

${CLAUDE_CODE_MANAGED_MARK}

# Toolroll

Use the installed \`toolroll\` command. Its live help is authoritative.

- [Console guide](console.md) — where a person can review and act.
- [Operating guide](operating.md) — the command contract and safe workflow.
- [Runner guide](runner.md) — claims, leases, heartbeats, and fencing.
- [Release guide](release.md) — releasing Toolroll itself with \`toolroll release <branch>\`.
`;
}

/** One linked file, generated from the guide embedded in this binary. */
export function claudeCodeGuideContent(name: typeof CLAUDE_CODE_GUIDES[number]): string {
  const guide = guideNamed(name);
  if (guide === null) throw new Error(`the ${name} guide is missing from the build`);
  return `${CLAUDE_CODE_MANAGED_MARK}\n\n${guide.content.replace(/\n*$/, "\n")}`;
}

function claudeCodeFiles(directory: string): { name: string; path: string; content: string }[] {
  return [
    { name: "SKILL.md", path: join(directory, "SKILL.md"), content: claudeCodeSkillContent() },
    ...CLAUDE_CODE_GUIDES.map(name => ({
      name: `${name}.md`,
      path: join(directory, `${name}.md`),
      content: claudeCodeGuideContent(name),
    })),
  ];
}

function isClaudeCodeManaged(name: string, content: string): boolean {
  if (name === "SKILL.md") {
    return ownHeader(content) && (content.includes(`\n${CLAUDE_CODE_MANAGED_MARK}\n`) || content.includes(`\n${OPERATOR_SKILL_MARK} `));
  }
  return content.startsWith(`${CLAUDE_CODE_MANAGED_MARK}\n\n`);
}

/** Compute the complete write set without changing the filesystem. */
export function planClaudeCodeInstall(directory = defaultClaudeCodeSkillDir(), legacyDirectory: string | null = directory === defaultClaudeCodeSkillDir() ? legacyClaudeCodeSkillDir() : null): ClaudeCodeInstallPlan {
  let directoryAction: ClaudeCodeInstallPlan["directoryAction"] = "create";
  if (existsSync(directory)) {
    const entry = lstatSync(directory);
    directoryAction = entry.isDirectory() && !entry.isSymbolicLink() ? "use" : "refuse-foreign";
  }

  const files = claudeCodeFiles(directory).map(({ name, path }): ClaudeCodeSkillFile => {
    if (directoryAction === "refuse-foreign" || !existsSync(path)) return {
      name,
      path,
      action: directoryAction === "refuse-foreign" ? "refuse-foreign" : "create",
    };
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 2_000_000) {
      return { name, path, action: "refuse-foreign" };
    }
    const current = readFileSync(path, "utf8");
    return { name, path, action: isClaudeCodeManaged(name, current) ? "replace" : "refuse-foreign" };
  });

  const legacyFiles = legacyDirectory === null || legacyDirectory === directory || !realFolder(legacyDirectory)
    ? []
    : claudeCodeFiles(legacyDirectory).filter(({ name, path }) => isOwnFile(path, content => isClaudeCodeManaged(name, content))).map(({ path }) => path);
  return { directory, directoryAction, files, legacyFiles };
}

/** Refresh every managed file, after validating the whole set first. */
export function applyClaudeCodeInstall(directory = defaultClaudeCodeSkillDir(), legacyDirectory: string | null = directory === defaultClaudeCodeSkillDir() ? legacyClaudeCodeSkillDir() : null): ClaudeCodeInstallResult {
  const plan = planClaudeCodeInstall(directory, legacyDirectory);
  const refused = plan.files.find(file => file.action === "refuse-foreign");
  if (refused !== undefined) {
    const message = plan.directoryAction === "refuse-foreign"
      ? `${plan.directory} is not a regular directory — refusing to replace it`
      : `${refused.path} exists and was not written by this installer — refusing to overwrite it`;
    return { ok: false, reason: "foreign-file", message, plan };
  }

  mkdirSync(directory, { recursive: true });
  const wrote: string[] = [];
  for (const file of claudeCodeFiles(directory)) {
    writeFileSync(file.path, file.content);
    wrote.push(file.path);
  }
  if (plan.legacyFiles.length > 0) removeOwn(plan.legacyFiles);
  return { ok: true, plan, wrote };
}
