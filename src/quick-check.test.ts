/**
 * The Quick check's selection (scripts/quick-check.mjs): typecheck, the tests named after the changed files, and the
 * attack suite whenever a security-critical file or the suite itself changed. The real command runs against a
 * throwaway repository in --plan mode, so the changed-path discovery is covered too.
 */
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ATTACK_SUITE, changedSince, quickPlan, SECURITY_CRITICAL } from "../scripts/quick-check.mjs";

const root = resolve(import.meta.dirname, "..");
const list = (folder: string) => readdirSync(join(root, folder));

describe("the Quick check", () => {
  test("names the scope's nine guards (and the shared teardown helper); each exists here", () => {
    expect(SECURITY_CRITICAL).toEqual(expect.arrayContaining([
      "src/agent-fence.ts", "src/tool-broker.ts", "src/provider-home.ts", "src/invoke.ts", "src/project-tools.ts",
      "src/landed-cleanup.ts", "src/worktree.ts", "src/checkout-cleanup.ts", "src/flow-unattended.ts",
    ]));
    for (const file of SECURITY_CRITICAL) expect(list("src")).toContain(file.slice("src/".length));
    expect(ATTACK_SUITE).toEqual(["vitest", "run", "--config", "test/attacks/vitest.config.ts"]);
  });

  test.each(SECURITY_CRITICAL)("a change to %s runs the attack suite beside its own named tests", file => {
    const plan = quickPlan([file], list);
    expect(plan.attacks).toBe(`${file} is security-critical`);
    // Its own tests too, where it has a file named after it (project-tools.ts is covered elsewhere).
    if (list("src").includes(file.slice("src/".length).replace(/\.ts$/, ".test.ts"))) expect(plan.tests).toContain(file.replace(/\.ts$/, ".test.ts"));
    expect(plan.tests.some(one => one.startsWith("test/attacks/"))).toBe(false);
  });

  test("an unrelated change keeps the normal focused tests, without the attack suite", () => {
    expect(quickPlan(["src/check-levels.ts"], list)).toEqual({ tests: ["src/check-levels.test.ts"], attacks: null });
    // serve.ts's tests are split by area: every one of them is named after it.
    const serve = quickPlan(["src/serve.ts"], list).tests;
    expect(serve).toContain("src/serve.flow-unattended.test.ts");
    expect(serve.every(one => /^src\/serve(\.[^/]+)?\.test\.ts$/.test(one))).toBe(true);
    expect(quickPlan(["docs/PROGRESS.md", "README.md"], list)).toEqual({ tests: [], attacks: null });
    expect(quickPlan(["scripts/release-check.mjs"], list)).toEqual({ tests: ["src/release-check.test.ts"], attacks: null });
    // A changed test runs itself; a deleted one, or a source with no tests, names nothing.
    expect(quickPlan(["src/agent-fence.test.ts"], list)).toEqual({ tests: ["src/agent-fence.test.ts"], attacks: null });
    expect(quickPlan(["src/gone.test.ts", "src/no-tests-here.ts"], list)).toEqual({ tests: [], attacks: null });
  });

  test("a change to the attack suite runs it, through its own config only", () => {
    const plan = quickPlan(["test/attacks/harness.ts", "test/attacks/fence-rename-ancestor.test.ts"], list);
    expect(plan).toEqual({ tests: [], attacks: "test/attacks/harness.ts is part of the attack suite" });
  });

  test("changed paths come from Git between the base and the working tree, untracked included; --plan runs nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "quick-check-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "1\n");
      git("add", "."); git("commit", "-qm", "base");
      writeFileSync(join(dir, "src", "agent-fence.ts"), "2\n");
      git("add", "."); git("commit", "-qm", "change");
      writeFileSync(join(dir, "src", "a.ts"), "3\n");
      writeFileSync(join(dir, "src", "new file.ts"), "4\n");
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        expect(changedSince("HEAD~1")).toEqual(["src/a.ts", "src/agent-fence.ts", "src/new file.ts"]);
        expect(changedSince("HEAD")).toEqual(["src/a.ts", "src/new file.ts"]);
      } finally { process.chdir(cwd); }
      const planned = execFileSync(process.execPath, [join(root, "scripts", "quick-check.mjs"), "--plan"], { cwd: root, encoding: "utf8" });
      expect(planned).toMatch(/^Quick check against HEAD~1 \(\d+ changed\): typecheck; /);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
