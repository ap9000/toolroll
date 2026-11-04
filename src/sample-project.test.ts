/**
 * The welcome's sample project (sample-project.ts): a real repository made with hardened git, found again when it is
 * ours, and never anything in a folder that isn't.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { run, type ExecResult, type RunOptions } from "./exec.js";
import { createSampleProject } from "./sample-project.js";

let dir: string, root: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-sample-"));
  root = join(dir, "Projects");
  mkdirSync(root);
  // Its own HOME, with a global git config that would run a hook and sign commits if anything read it.
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), `[core]\n\thooksPath = ${join(dir, "planted-hooks")}\n[user]\n\tname = Someone Else\n[commit]\n\tgpgsign = true\n`);
  mkdirSync(join(dir, "planted-hooks"));
  writeFileSync(join(dir, "planted-hooks", "pre-commit"), `#!/bin/sh\ntouch ${join(dir, "hook-ran")}\n`, { mode: 0o755 });
  vi.stubEnv("HOME", home);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

describe("createSampleProject", () => {
  test("makes a README, one function and its test, committed on main with hardened git", async () => {
    const calls: { args: readonly string[]; options: RunOptions }[] = [];
    const spy = (file: string, args: readonly string[], options: RunOptions): Promise<ExecResult> => { calls.push({ args, options }); return run(file, args, options); };
    const made = await createSampleProject(root, spy);
    expect(made).toEqual({ ok: true, path: join(root, "toolroll-sample"), created: true });
    const repo = join(root, "toolroll-sample");
    expect(git(repo, "ls-files").split("\n").sort()).toEqual([".gitignore", "README.md", "package.json", "src/price.js", "test/price.test.js"]);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(repo, "log", "-1", "--format=%an")).toBe("Toolroll");
    expect(git(repo, "status", "--porcelain")).toBe("");
    // No hook ran, none was copied in from a template, and every command ran with the hardened settings.
    expect(existsSync(join(dir, "hook-ran"))).toBe(false);
    expect(existsSync(join(repo, ".git", "hooks")) ? readdirSync(join(repo, ".git", "hooks")) : []).toEqual([]);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.args).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null", "core.fsmonitor=false", "commit.gpgsign=false", "credential.helper="]));
      expect(call.options.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
      expect(call.options.envAllowlist).toBeDefined();
    }
    // Its test passes as made.
    expect(() => execFileSync(process.execPath, ["--test"], { cwd: repo, stdio: "ignore" })).not.toThrow();
  });

  test("finds its own sample again without touching it", async () => {
    await createSampleProject(root);
    const head = git(join(root, "toolroll-sample"), "rev-parse", "HEAD");
    expect(await createSampleProject(root)).toEqual({ ok: true, path: join(root, "toolroll-sample"), created: false });
    expect(git(join(root, "toolroll-sample"), "rev-parse", "HEAD")).toBe(head);
  });

  test("refuses a folder by that name that isn't ours, and changes nothing in it", async () => {
    const theirs = join(root, "toolroll-sample");
    mkdirSync(theirs);
    writeFileSync(join(theirs, "notes.txt"), "mine\n");
    expect(await createSampleProject(root)).toMatchObject({ ok: false, reason: "exists" });
    expect(readdirSync(theirs)).toEqual(["notes.txt"]);
    // A repository with a forged marker that isn't a plain file, or a link to one of ours, is not ours either.
    rmSync(theirs, { recursive: true });
    await createSampleProject(join(dir, "home"));
    symlinkSync(join(dir, "home", "toolroll-sample"), theirs);
    expect(await createSampleProject(root)).toMatchObject({ ok: false, reason: "exists" });
  });

  test("a failure removes the folder it made; no project folder is refused", async () => {
    const failing = async (): Promise<ExecResult> => ({ code: 1, stdout: "", stderr: "no", timedOut: false, notFound: false });
    expect(await createSampleProject(root, failing)).toMatchObject({ ok: false, reason: "failed" });
    expect(existsSync(join(root, "toolroll-sample"))).toBe(false);
    expect(await createSampleProject(null)).toMatchObject({ ok: false, reason: "no-root" });
    expect(await createSampleProject("relative/path")).toMatchObject({ ok: false, reason: "no-root" });
    expect(await createSampleProject(join(dir, "missing"))).toMatchObject({ ok: false, reason: "no-root" });
  });
});
