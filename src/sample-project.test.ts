/**
 * The welcome's sample project (sample-project.ts): a real repository made with hardened git, found again when it is
 * ours, and never anything in a folder that isn't.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { run, type ExecResult, type RunOptions } from "./exec.js";
import { createSampleProject, registerSampleCheck, SAMPLE_CHECK_ACTOR, SAMPLE_CHECK_COMMAND } from "./sample-project.js";
import { openStore } from "./store.js";

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

describe("createSampleProject's guard", () => {
  test("asked before the claim and after each git step: a no stops it, and only the folder this call made is removed", async () => {
    expect(await createSampleProject(root, run, () => false)).toMatchObject({ ok: false, reason: "refused" });
    expect(existsSync(join(root, "toolroll-sample"))).toBe(false);
    // The folder made is swapped for a link to someone else's during git: the link is never followed, nothing of theirs goes.
    const theirs = join(dir, "theirs");
    mkdirSync(theirs);
    writeFileSync(join(theirs, "keep.txt"), "mine\n");
    let allowed = true;
    const swapping = async (file: string, args: readonly string[], options: RunOptions): Promise<ExecResult> => {
      const ran = await run(file, args, options);
      renameSync(join(root, "toolroll-sample"), join(dir, "moved"));
      symlinkSync(theirs, join(root, "toolroll-sample"));
      allowed = false;
      return ran;
    };
    expect(await createSampleProject(root, swapping, () => allowed)).toMatchObject({ ok: false, reason: "refused" });
    expect(readdirSync(theirs)).toEqual(["keep.txt"]);
    expect(existsSync(join(dir, "moved", "README.md"))).toBe(true);
    // Swapped for another real folder (not the one this call made): left exactly as it is.
    rmSync(join(root, "toolroll-sample"));
    allowed = true;
    const replacing = async (file: string, args: readonly string[], options: RunOptions): Promise<ExecResult> => {
      const ran = await run(file, args, options);
      renameSync(join(root, "toolroll-sample"), join(dir, "moved-again"));
      mkdirSync(join(root, "toolroll-sample"));
      writeFileSync(join(root, "toolroll-sample", "keep.txt"), "mine\n");
      allowed = false;
      return ran;
    };
    expect(await createSampleProject(root, replacing, () => allowed)).toMatchObject({ ok: false, reason: "refused" });
    expect(readdirSync(join(root, "toolroll-sample"))).toEqual(["keep.txt"]);
  });
});

describe("registerSampleCheck", () => {
  const T0 = new Date("2026-11-04T12:00:00.000Z");
  test("the sample's own fixed check, recorded as Toolroll's, set once, and its one test passes under it", async () => {
    const made = await createSampleProject(root);
    if (!made.ok) throw new Error("sample");
    const store = openStore(join(dir, "orders.db"));
    try {
      expect(registerSampleCheck(store, made, made.path, "alex", T0)).toBe(true);
      expect(store.liveVerifyCommand(made.path)).toMatchObject({ command: SAMPLE_CHECK_COMMAND, approvedBy: SAMPLE_CHECK_ACTOR });
      expect(SAMPLE_CHECK_ACTOR).toBe("toolroll");
      const line = store.actionLedger({ repos: [made.path], instance: false, limit: 10 }).find(one => one.action === "check approved");
      expect(line).toMatchObject({ actor: "toolroll", source: "policy" });
      expect(line?.detail).toMatch(/sample project's own test .* when alex added the sample/);
      // Again: nothing changes (one live check, not a second approval).
      const first = store.liveVerifyCommand(made.path)!;
      expect(registerSampleCheck(store, made, made.path, "alex", T0)).toBe(false);
      expect(store.liveVerifyCommand(made.path)).toEqual(first);
      // The command really is the sample's test.
      const ran = await run("/bin/sh", ["-c", SAMPLE_CHECK_COMMAND], { cwd: made.path, env: { PATH: process.env["PATH"] ?? "" }, timeoutMs: 60_000 });
      expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    } finally { store.close(); }
  }, 60_000);

  test("a sample found again (not made by this call) is never armed", async () => {
    const first = await createSampleProject(root);
    const again = await createSampleProject(root);
    if (!first.ok || !again.ok) throw new Error("sample");
    expect(again.created).toBe(false);
    const store = openStore(join(dir, "orders.db"));
    try {
      expect(registerSampleCheck(store, again, again.path, "alex", T0)).toBe(false);
      expect(store.liveVerifyCommand(again.path)).toBeNull();
    } finally { store.close(); }
  });

  test("a check that was cleared stays cleared; one someone approved is never replaced", async () => {
    const made = await createSampleProject(root);
    if (!made.ok) throw new Error("sample");
    const store = openStore(join(dir, "orders.db"));
    try {
      store.setVerifyCommand({ repo: made.path, command: "npm test", timeoutMs: 120_000, approvedBy: "sam" }, T0);
      expect(registerSampleCheck(store, made, made.path, "alex", T0)).toBe(false);
      expect(store.liveVerifyCommand(made.path)).toMatchObject({ command: "npm test", approvedBy: "sam" });
      store.clearVerifyCommand(made.path, "sam", T0);
      expect(registerSampleCheck(store, made, made.path, "alex", T0)).toBe(false);
      expect(store.liveVerifyCommand(made.path)).toBeNull();
      // A cleared quick check counts too.
      const other = openStore(join(dir, "other.db"));
      try {
        other.setVerifyCommand({ repo: `quick:${made.path}`, command: "npm test", timeoutMs: 60_000, approvedBy: "sam" }, T0);
        other.clearVerifyCommand(`quick:${made.path}`, "sam", T0);
        expect(registerSampleCheck(other, made, made.path, "alex", T0)).toBe(false);
        expect(other.liveVerifyCommand(made.path)).toBeNull();
      } finally { other.close(); }
    } finally { store.close(); }
  });

  test("only for the sample this made: any other folder, a link to the sample, or a relative path sets nothing", async () => {
    const made = await createSampleProject(root);
    if (!made.ok) throw new Error("sample");
    const other = join(root, "shop");
    mkdirSync(join(other, ".git"), { recursive: true });
    symlinkSync(made.path, join(root, "linked"));
    const store = openStore(join(dir, "orders.db"));
    try {
      for (const repo of [other, join(root, "linked"), "toolroll-sample", join(root, "missing")]) {
        expect(registerSampleCheck(store, made, repo, "alex", T0), repo).toBe(false);
        expect(store.liveVerifyCommand(repo), repo).toBeNull();
      }
    } finally { store.close(); }
  });
});
