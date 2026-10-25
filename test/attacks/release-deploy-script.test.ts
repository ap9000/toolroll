/**
 * Attack: the candidate's checkout decides what the release's deployment runs — a rewritten deploy script, hidden from
 * `git status` (skip-worktree), an untracked helper the script imports, a swap after the release looked, or a `.git`
 * pointer aimed at another repository. Guard: `toolroll release` proves the candidate in its OWN runtime
 * (deploy-gate.ts), then extracts the approved commit itself — `git archive <sha>` from the project's own Git directory
 * as Toolroll records it, hardened — into a fresh folder and runs the deployment script from there. Nothing in the
 * checkout changes what runs; an unapproved candidate runs nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { exec, releaseAdapters, type Exec } from "../../src/release-adapters.js";
import { provableCandidate } from "../deploy-candidate-fixture.js";
import { git, useScratch } from "./harness.js";

describe("attack: the candidate's checkout changes the deployment the release runs", () => {
  const scratch = useScratch("release-deploy");
  /** The project (its own .git, as Toolroll records it) with the approved script, and a linked worktree of it. */
  const plane = (dir: string, approval: "person" | "lead" = "person") => {
    const project = join(dir, "project"), worktree = join(dir, "candidate"), marker = join(dir, "what-ran");
    mkdirSync(join(project, "scripts"), { recursive: true });
    // The approved script: says it ran pristine, and would run a helper only if one were beside it.
    writeFileSync(join(project, "scripts", "deploy-browser.mjs"), [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(marker)}, "pristine");`,
      `await import("./helper.mjs").then(helper => helper.run()).catch(() => {});`,
      `console.log(JSON.stringify({ runtime: "/staged/dist" }));`, ""].join("\n"));
    git(project, "init", "-q");
    git(project, "add", ".");
    git(project, "commit", "-q", "-m", "approved");
    const head = git(project, "rev-parse", "HEAD");
    git(project, "worktree", "add", "-q", "--detach", worktree, head);
    const database = join(dir, "orders.db");
    const { runId } = provableCandidate(database, "deploy-me", approval, head, project);
    const stage = join(dir, "stage");
    mkdirSync(stage);
    const evil = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "evil");\nconsole.log(JSON.stringify({ runtime: "/evil/dist" }));\n`;
    return { project, worktree, marker, head, database, runId, stage, evil };
  };
  const deploy = (p: ReturnType<typeof plane>, run: Exec = exec) =>
    releaseAdapters({ checkout: p.worktree, database: p.database, processes: () => [], run }).toolroll.deploy({ run: p.runId, worktree: p.worktree, stage: p.stage });
  const ran = (p: ReturnType<typeof plane>) => existsSync(p.marker) ? readFileSync(p.marker, "utf8") : null;

  test("an unapproved candidate runs nothing", async () => {
    const p = plane(scratch(), "lead");
    expect(await deploy(p)).toMatchObject({ ok: false, message: "A person has to approve this candidate's scope: approved by the lead, not by a person." });
    expect(ran(p)).toBeNull();
  });

  test("a script changed in the checkout and hidden from git status (skip-worktree) never runs", async () => {
    const p = plane(scratch());
    git(p.worktree, "update-index", "--skip-worktree", "scripts/deploy-browser.mjs");
    writeFileSync(join(p.worktree, "scripts", "deploy-browser.mjs"), p.evil);
    expect(git(p.worktree, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(await deploy(p)).toEqual({ ok: true, runtime: "/staged/dist" });
    expect(ran(p)).toBe("pristine");
  });

  test("an untracked helper the script would import is never there to import", async () => {
    const p = plane(scratch());
    writeFileSync(join(p.worktree, "scripts", "helper.mjs"), `import { writeFileSync } from "node:fs";\nexport function run() { writeFileSync(${JSON.stringify(p.marker)}, "evil"); }\n`);
    expect(await deploy(p)).toEqual({ ok: true, runtime: "/staged/dist" });
    expect(ran(p)).toBe("pristine");
  });

  test("a script swapped after the release looked never runs", async () => {
    const p = plane(scratch());
    const swapping: Exec = async (command, args, options) => {
      if (command === process.execPath) writeFileSync(join(p.worktree, "scripts", "deploy-browser.mjs"), p.evil);
      return exec(command, args, options);
    };
    expect(await deploy(p, swapping)).toEqual({ ok: true, runtime: "/staged/dist" });
    expect(ran(p)).toBe("pristine");
  });

  test("a .git pointer aimed at another repository is never followed", async () => {
    const dir = scratch();
    const p = plane(dir);
    const other = join(dir, "other");
    mkdirSync(join(other, "scripts"), { recursive: true });
    writeFileSync(join(other, "scripts", "deploy-browser.mjs"), p.evil);
    git(other, "init", "-q");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "other");
    writeFileSync(join(p.worktree, ".git"), `gitdir: ${join(other, ".git")}\n`);
    writeFileSync(join(p.worktree, "scripts", "deploy-browser.mjs"), p.evil);
    expect(await deploy(p)).toEqual({ ok: true, runtime: "/staged/dist" });
    expect(ran(p)).toBe("pristine");
  });
});
