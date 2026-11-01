/**
 * Attack: an enrolled or scanned project's report with `--dirty` (src/discover.ts) ran plain git `status` in the
 * project's repository, which every build shares and can write (Codex review of e48e9d8d): a planted fsmonitor or a
 * clean filter ran when the operator asked for the report. Discovery now goes through the hardened checkout git: the
 * project's config is inspected in a frozen view and a command-running one is refused, nothing run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { inspectRepo } from "../../src/discover.js";

let root: string, repo: string, marker: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { env, stdio: "pipe", encoding: "utf8" });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-discover-")));
  repo = join(root, "project"); marker = join(root, "ran");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "one");
  writeFileSync(join(repo, "a.txt"), "two\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("attack: `scan --dirty` on a project whose repository a build planted in", () => {
  test("an ordinary project still reports its uncommitted files", async () => {
    expect((await inspectRepo(repo, { dirty: true })).dirtyFiles).toBe(1);
  });

  test("a planted fsmonitor and clean filter never run", async () => {
    git("config", "core.fsmonitor", `sh -c 'touch ${marker}'`);
    git("config", "filter.x.clean", `sh -c 'touch ${marker}; cat'`);
    writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=x\n");
    const snapshot = await inspectRepo(repo, { dirty: true });
    expect(existsSync(marker)).toBe(false);
    expect(snapshot.dirtyFiles).toBeNull();
  });
});
