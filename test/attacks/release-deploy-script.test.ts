/**
 * Attack: the candidate rewrites its own scripts/deploy-browser.mjs so the deployment skips every check — the release
 * runs that script from the candidate's checkout. Guard: `toolroll release` proves the candidate in its OWN runtime
 * (deploy-gate.ts: a person's approval, the passing check, the exact completed result) and that the checkout is exactly
 * that commit with nothing tracked changed, before it starts anything from the checkout. An unapproved candidate, or a
 * replaced script, never runs; an approved, unchanged candidate's script does.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { releaseAdapters } from "../../src/release-adapters.js";
import { provableCandidate } from "../deploy-candidate-fixture.js";
import { git, useScratch } from "./harness.js";

describe("attack: a candidate replaces the deployment script the release runs", () => {
  const scratch = useScratch("release-deploy");
  /** A candidate checkout whose deployment script only leaves a marker and claims a deployed runtime. */
  const checkout = (dir: string) => {
    const worktree = join(dir, "candidate");
    mkdirSync(join(worktree, "scripts"), { recursive: true });
    const marker = join(dir, "script-ran");
    writeFileSync(join(worktree, "scripts", "deploy-browser.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nconsole.log(JSON.stringify({ runtime: "/staged/dist" }));\n`);
    git(worktree, "init", "-q");
    git(worktree, "add", ".");
    git(worktree, "commit", "-q", "-m", "candidate");
    return { worktree, marker, head: git(worktree, "rev-parse", "HEAD").trim() };
  };

  test("an unapproved candidate's script never runs, whatever it says", async () => {
    const dir = scratch();
    const { worktree, marker, head } = checkout(dir);
    const database = join(dir, "orders.db");
    const { runId } = provableCandidate(database, "lead-sealed", "lead", head);
    const stage = join(dir, "stage");
    mkdirSync(stage);
    const answer = await releaseAdapters({ checkout: worktree, database, processes: () => [] }).toolroll.deploy({ run: runId, worktree, stage });
    expect(answer).toMatchObject({ ok: false, message: "A person has to approve this candidate's scope: approved by the lead, not by a person." });
    expect(existsSync(marker)).toBe(false);
  });

  test("a script changed after the approved commit never runs; the approved, unchanged one does", async () => {
    const dir = scratch();
    const { worktree, marker, head } = checkout(dir);
    const database = join(dir, "orders.db");
    const { runId } = provableCandidate(database, "approved", "person", head);
    const stage = join(dir, "stage");
    mkdirSync(stage);
    const adapter = releaseAdapters({ checkout: worktree, database, processes: () => [] }).toolroll;
    writeFileSync(join(worktree, "scripts", "deploy-browser.mjs"), `console.log(JSON.stringify({ runtime: "/evil/dist" }));\n`);
    expect(await adapter.deploy({ run: runId, worktree, stage })).toMatchObject({ ok: false, message: expect.stringContaining("has tracked changes") });
    expect(existsSync(marker)).toBe(false);
    git(worktree, "checkout", "-q", "--", ".");
    expect(await adapter.deploy({ run: runId, worktree, stage })).toEqual({ ok: true, runtime: "/staged/dist" });
    expect(existsSync(marker)).toBe(true);
  });
});
