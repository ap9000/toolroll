/**
 * Learning recovery runs in a process of its own (learning-look.ts), so a project folder that doesn't answer never
 * holds the console: it answers per project, and one that runs past its deadline is stopped and said.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learningChild, recoverLearningOffThread } from "./learning-look.js";
import { openStore } from "./store.js";

let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "so-learning-look-"))); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("each project is recovered in its own process: a real checkout is done, a missing one fails, one past its deadline is cut off", async () => {
  const databaseFile = join(base, "orders.db");
  openStore(databaseFile).close();
  const repo = join(base, "project");
  mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git(["init", "-q"]); writeFileSync(join(repo, "README.md"), "hi\n"); git(["add", "."]); git(["commit", "-qm", "first"]);
  const outcomes = await recoverLearningOffThread({ databaseFile, evidenceRoot: join(base, "evidence"), repos: [repo, join(base, "missing")] });
  expect(Object.fromEntries(outcomes)).toEqual({ [repo]: "done", [join(base, "missing")]: "failed" });
  // Past its deadline the process is stopped, and the console hears "no answer" at the deadline, not when it ends.
  const at = Date.now();
  expect(await learningChild({ databaseFile, evidenceRoot: join(base, "evidence"), repo }, 1)).toBe("no-answer");
  expect(Date.now() - at).toBeLessThan(1_000);
}, 60_000);
