import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.js";
import { guideNamed } from "./guides.js";
import {
  applyClaudeCodeInstall,
  applyInstall,
  CLAUDE_CODE_MANAGED_MARK,
  claudeCodeGuideContent,
  claudeCodeSkillContent,
  defaultClaudeCodeSkillDir,
  LEGACY_SKILL_DIR,
  legacyClaudeCodeSkillDir,
  planClaudeCodeInstall,
  planInstall,
  SKILL_DIR,
  SKILL_FILE,
} from "./skills.js";

describe("Claude Code skill install", () => {
  const roots: string[] = [];
  const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), "standing-orders-claude-skill-"));
    roots.push(root);
    return join(root, "standing-orders");
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("uses Claude Code's user skill location by default", () => {
    expect(defaultClaudeCodeSkillDir("/home/alex")).toBe(join("/home/alex", ".claude", "skills", "toolroll"));
    expect(legacyClaudeCodeSkillDir("/home/alex")).toBe(join("/home/alex", ".claude", "skills", "standing-orders"));
  });

  test("publishes the Claude Code mode in help and the command contract", async () => {
    let lines: string[] = [];
    expect(await main(["--help"], line => lines.push(line))).toBe(0);
    expect(lines.join("\n")).toContain("skills install --claude-code [--dir <path>]");

    lines = [];
    expect(await main(["contract", "--commands", "--json"], line => lines.push(line))).toBe(0);
    const row = JSON.parse(lines.join("\n")).commands.find((command: { invocation: string }) => command.invocation === "skills install");
    expect(row).toMatchObject({
      mutation: "identity-idempotent",
      flags: expect.arrayContaining([
        { name: "claude-code", takesValue: false, meaning: expect.any(String) },
        { name: "dir", takesValue: true, meaning: expect.any(String) },
      ]),
    });
  });

  test("previews every file without creating the directory", async () => {
    const directory = fresh();
    const lines: string[] = [];

    const code = await main(["skills", "install", "--claude-code", "--dir", directory, "--json"], line => lines.push(line));

    expect(code).toBe(3);
    expect(existsSync(directory)).toBe(false);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      ok: false,
      command: "skills install",
      reason: "unconfirmed",
      plan: {
        directory,
        files: [
          { name: "SKILL.md", action: "create" },
          { name: "console.md", action: "create" },
          { name: "operating.md", action: "create" },
          { name: "runner.md", action: "create" },
          { name: "release.md", action: "create" },
        ],
      },
    });
  });

  test("--yes writes SKILL.md and the four guides embedded in the binary", async () => {
    const directory = fresh();
    const lines: string[] = [];

    const code = await main(["skills", "install", "--claude-code", "--dir", directory, "--yes", "--json"], line => lines.push(line));

    expect(code).toBe(0);
    const skill = readFileSync(join(directory, "SKILL.md"), "utf8");
    expect(skill).toContain("name: toolroll");
    for (const name of ["console", "operating", "runner", "release"] as const) {
      expect(skill).toContain(`(${name}.md)`);
      expect(readFileSync(join(directory, `${name}.md`), "utf8")).toBe(claudeCodeGuideContent(name));
      expect(readFileSync(join(directory, `${name}.md`), "utf8")).toContain(guideNamed(name)?.content);
    }
  });

  test("re-running refreshes every managed file", () => {
    const directory = fresh();
    expect(applyClaudeCodeInstall(directory).ok).toBe(true);
    writeFileSync(join(directory, "operating.md"), `${CLAUDE_CODE_MANAGED_MARK}\n\nstale copy\n`);

    const refreshed = applyClaudeCodeInstall(directory);

    expect(refreshed.ok).toBe(true);
    expect(readFileSync(join(directory, "operating.md"), "utf8")).toBe(claudeCodeGuideContent("operating"));
    expect(planClaudeCodeInstall(directory).files.every(file => file.action === "replace")).toBe(true);
  });

  test("re-running leaves unrelated files untouched", () => {
    const directory = fresh();
    expect(applyClaudeCodeInstall(directory).ok).toBe(true);
    const notes = join(directory, "my-notes.md");
    writeFileSync(notes, "keep my notes\n");

    expect(applyClaudeCodeInstall(directory).ok).toBe(true);

    expect(readFileSync(notes, "utf8")).toBe("keep my notes\n");
  });

  test("a foreign target refuses the whole refresh", () => {
    const directory = fresh();
    expect(applyClaudeCodeInstall(directory).ok).toBe(true);
    const operating = join(directory, "operating.md");
    writeFileSync(operating, `${CLAUDE_CODE_MANAGED_MARK}\n\nstale but still managed\n`);
    writeFileSync(join(directory, "console.md"), "my custom guide\n");

    const result = applyClaudeCodeInstall(directory);

    expect(result).toMatchObject({ ok: false, reason: "foreign-file" });
    expect(readFileSync(join(directory, "console.md"), "utf8")).toBe("my custom guide\n");
    expect(readFileSync(operating, "utf8")).toContain("stale but still managed");
  });

  test("a preview names a foreign target without suggesting --yes", async () => {
    const directory = fresh();
    expect(applyClaudeCodeInstall(directory).ok).toBe(true);
    writeFileSync(join(directory, "console.md"), "my custom guide\n");
    const lines: string[] = [];

    expect(await main(["skills", "install", "--claude-code", "--dir", directory, "--json"], line => lines.push(line))).toBe(3);

    const answer = JSON.parse(lines.join("\n"));
    expect(answer.message).toContain("choose another --dir");
    expect(answer.message).not.toContain("Re-run with --yes");
  });

  test("--dir is specific to the Claude Code install", async () => {
    const lines: string[] = [];
    const code = await main(["skills", "install", "--dir", fresh(), "--json"], line => lines.push(line));
    expect(code).toBe(2);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, reason: "usage" });
  });
});

describe("a skill installed under the name before Toolroll", () => {
  const roots: string[] = [];
  const root = () => {
    const made = mkdtempSync(join(tmpdir(), "toolroll-legacy-skill-"));
    roots.push(made);
    return made;
  };
  /** What an install before the rename wrote: the same files under the old name. */
  const oldCopy = (content: string) => content.replace("name: toolroll", "name: standing-orders").replace("managed by toolroll", "managed by standing-orders");

  afterEach(() => {
    for (const one of roots.splice(0)) rmSync(one, { recursive: true, force: true });
  });

  test("a repository's managed .claude/skills/standing-orders copy is found and replaced by .claude/skills/toolroll", () => {
    const repo = root();
    const legacy = join(repo, LEGACY_SKILL_DIR);
    expect(applyInstall(repo, false)).toMatchObject({ ok: true });
    const current = readFileSync(join(repo, SKILL_DIR, SKILL_FILE), "utf8");
    rmSync(join(repo, SKILL_DIR), { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, SKILL_FILE), oldCopy(current));

    const plan = planInstall(repo, false);
    expect(plan).toMatchObject({ skillPath: join(repo, SKILL_DIR, SKILL_FILE), skillAction: "create", legacySkillPath: join(legacy, SKILL_FILE) });
    expect(applyInstall(repo, false)).toMatchObject({ ok: true });
    expect(readFileSync(join(repo, SKILL_DIR, SKILL_FILE), "utf8")).toContain("name: toolroll");
    expect(existsSync(legacy)).toBe(false);
  });

  test("a foreign file under the old folder name is left alone", () => {
    const repo = root();
    const legacy = join(repo, LEGACY_SKILL_DIR);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, SKILL_FILE), "---\nname: standing-orders\n---\nmy own notes\n");

    expect(planInstall(repo, false).legacySkillPath).toBeNull();
    expect(applyInstall(repo, false)).toMatchObject({ ok: true });
    expect(readFileSync(join(legacy, SKILL_FILE), "utf8")).toContain("my own notes");
  });

  test("the Claude Code skill's old folder is found; its managed files are replaced and anything else stays", () => {
    const home = root();
    const directory = join(home, ".claude", "skills", "toolroll"), legacy = join(home, ".claude", "skills", "standing-orders");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "SKILL.md"), oldCopy(claudeCodeSkillContent()));
    for (const name of ["console", "operating", "runner"] as const) writeFileSync(join(legacy, `${name}.md`), claudeCodeGuideContent(name));
    writeFileSync(join(legacy, "my-notes.md"), "keep\n");

    const plan = planClaudeCodeInstall(directory, legacy);
    expect(plan.legacyFiles.sort()).toEqual(["SKILL.md", "console.md", "operating.md", "runner.md"].map(name => join(legacy, name)).sort());
    expect(applyClaudeCodeInstall(directory, legacy)).toMatchObject({ ok: true });
    expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toContain("name: toolroll");
    expect(existsSync(join(legacy, "SKILL.md"))).toBe(false);
    expect(readFileSync(join(legacy, "my-notes.md"), "utf8")).toBe("keep\n");

    rmSync(join(legacy, "my-notes.md"));
    writeFileSync(join(legacy, "SKILL.md"), oldCopy(claudeCodeSkillContent()));
    expect(applyClaudeCodeInstall(directory, legacy)).toMatchObject({ ok: true });
    expect(existsSync(legacy)).toBe(false);
  });
});
