/**
 * The console's folder gate (folder-gate.ts) and the git-incident check (teardown-git.ts settle). The console reads a
 * checkout's git pointers only while the folders they lead to answered a look lately. Its storage pass looks over every
 * checkout every 30 minutes and can outlast that answer, so the re-check after git ran used to find the gate shut on
 * the very folders the view was made from, read that as "the checkout no longer binds", and raise an incident: bursts
 * of false "Git incident" alerts every half hour (Nov 2026). The re-check now reads past the gate only for the folders
 * the view was made from. A pointer that names anywhere else is gated as before, and a real swap is still an incident.
 *
 * Attacks: a gate that shuts mid-run, combined with every way to move the checkout's repository while git runs.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { run } from "../../src/exec.js";
import { inFolderScope } from "../../src/folder-gate.js";
import { onGitIncident, recentGitIncident, type GitIncident } from "../../src/git-incident.js";
import { gitIncidentRecord, refusal, teardownGit } from "../../src/teardown-git.js";
import { WorktreePool, type Runner } from "../../src/worktree.js";
import { openStore } from "../../src/store.js";

let root: string, a: string, aLinked: string, b: string, bLinked: string, heard: GitIncident[], stop: () => void;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (at: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", at, ...args], { env, stdio: "pipe", encoding: "utf8" });
const repository = (path: string) => {
  execFileSync("git", ["init", "-q", "-b", "main", path], { env });
  writeFileSync(join(path, "a.txt"), "one\n");
  git(path, "add", "a.txt");
  git(path, "commit", "-qm", "one");
  return path;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-gitgate-")));
  // Its own HOME: the views folder and the incident record are this test's, never the person's.
  vi.stubEnv("HOME", join(root, "home"));
  execFileSync("mkdir", ["-p", join(root, "home")]);
  a = repository(join(root, "a")); b = repository(join(root, "b"));
  aLinked = join(root, "a-task"); bLinked = join(root, "b-task");
  git(a, "worktree", "add", "-q", "-b", "task", aLinked);
  git(b, "worktree", "add", "-q", "-b", "task", bLinked);
  heard = [];
  stop = onGitIncident(incident => heard.push(incident));
});
afterEach(() => { stop(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

/** A console gate that answers for every folder until `shut()`, as one whose answers went stale mid-pass. */
const consoleGate = () => {
  let open = true;
  return { gate: (_path: string, _pointer: boolean) => open, shut: () => { open = false; } };
};
/** Teardown git whose run shuts the gate (and does `meanwhile`) as git runs the command `when` names. */
const tidying = (shut: () => void, when: string, meanwhile: () => void = () => {}): ReturnType<typeof teardownGit> => {
  const inner: Runner = async (file, args, options) => {
    const result = await run(file, args, options);
    if (args.includes(when)) { shut(); meanwhile(); }
    return result;
  };
  return teardownGit(inner);
};
const STATUS = ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"];

describe("the folder gate shutting mid-run is not an incident", () => {
  test("control: with the gate open throughout, a tidy's status runs and nothing is told", async () => {
    const { gate } = consoleGate();
    const result = await inFolderScope(gate, () => teardownGit()(aLinked, STATUS));
    expect(result.code, result.stderr).toBe(0);
    expect(heard).toEqual([]);
  });

  test.each(["status", "rev-list", "symbolic-ref"])("the gate shuts while %s runs: the result stands and nothing is told (the Nov 2026 false alarms)", async when => {
    const { gate, shut } = consoleGate();
    const args = when === "status" ? STATUS : when === "rev-list" ? ["--no-optional-locks", "rev-list", "-1", "HEAD", "--not", "--branches"] : ["--no-optional-locks", "symbolic-ref", "-q", "HEAD"];
    const result = await inFolderScope(gate, () => tidying(shut, when)(aLinked, args));
    expect(refusal(result), result.stderr).toBeNull();
    expect(heard).toEqual([]);
  });
});

describe("attack: a real move while the gate is shut is still caught", () => {
  test("the checkout's .git re-pointed at another repository's worktree: an incident (rebound), and the command refused", async () => {
    const { gate, shut } = consoleGate();
    const repoint = () => writeFileSync(join(aLinked, ".git"), `gitdir: ${join(b, ".git", "worktrees", "b-task")}\n`);
    const result = await inFolderScope(gate, () => tidying(shut, "status", repoint)(aLinked, STATUS));
    expect(refusal(result), result.stderr).toContain("changed while git ran");
    // A status runs in the checkout's view and its target's (teardown-git.ts): each view tells what it saw.
    expect(heard.length).toBeGreaterThan(0);
    for (const one of heard) expect(one).toMatchObject({ cause: "rebound", doing: "tidying an old checkout" });
  });

  test("the worktree's commondir rewritten to another repository: an incident, and the command refused", async () => {
    const { gate, shut } = consoleGate();
    const rewrite = () => writeFileSync(join(a, ".git", "worktrees", "a-task", "commondir"), `${join(b, ".git")}\n`);
    const result = await inFolderScope(gate, () => tidying(shut, "status", rewrite)(aLinked, STATUS));
    expect(refusal(result), result.stderr).toContain("changed while git ran");
    expect(heard.length).toBeGreaterThan(0);
  });

  test("the same pointer spelled through a link elsewhere is gated as ever: an incident, never read past the gate", async () => {
    const { gate, shut } = consoleGate();
    const elsewhere = join(root, "elsewhere");
    symlinkSync(join(a, ".git", "worktrees", "a-task"), elsewhere);
    const respell = () => writeFileSync(join(aLinked, ".git"), `gitdir: ${elsewhere}\n`);
    const result = await inFolderScope(gate, () => tidying(shut, "status", respell)(aLinked, STATUS));
    expect(refusal(result), result.stderr).toContain("changed while git ran");
    expect(heard.length).toBeGreaterThan(0);
  });

  test("a folder of the repository swapped for a link: an incident (swapped), gate shut or not", async () => {
    const { gate, shut } = consoleGate();
    const swap = () => { renameSync(join(a, ".git", "refs"), join(root, "refs-moved")); symlinkSync(join(b, ".git", "refs"), join(a, ".git", "refs")); };
    const result = await inFolderScope(gate, () => tidying(shut, "status", swap)(aLinked, STATUS));
    expect(refusal(result), result.stderr).toContain("changed while git ran");
    expect(heard.length).toBeGreaterThan(0);
    for (const one of heard) expect(one.cause).toBe("swapped");
  });

  test("a removal: the checkout it removed is no incident, but a folder swapped while it ran is", async () => {
    const plain = await teardownGit()(a, ["worktree", "remove", "--force", aLinked]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(heard).toEqual([]);
    const swap = () => { renameSync(join(b, ".git", "logs"), join(root, "logs-moved")); symlinkSync(join(a, ".git", "logs"), join(b, ".git", "logs")); };
    const result = await tidying(() => {}, "remove", swap)(b, ["worktree", "remove", "--force", bLinked]);
    expect(refusal(result), result.stderr).toContain("changed while git ran");
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ cause: "swapped", doing: "removing an old checkout" });
  });
});

describe("a checkout with a recent incident is left alone", () => {
  test("the record names it for a day; another checkout, an older line or an unreadable record does not", async () => {
    const { gate, shut } = consoleGate();
    const repoint = () => writeFileSync(join(aLinked, ".git"), `gitdir: ${join(b, ".git", "worktrees", "b-task")}\n`);
    await inFolderScope(gate, () => tidying(shut, "status", repoint)(aLinked, STATUS));
    const record = gitIncidentRecord();
    const now = Date.now();
    expect(recentGitIncident(record, realpathSync(aLinked), new Date(now - 60_000))).toBe(true);
    expect(recentGitIncident(record, realpathSync(bLinked), new Date(now - 60_000))).toBe(false);
    expect(recentGitIncident(record, realpathSync(aLinked), new Date(now + 60_000))).toBe(false);
    expect(recentGitIncident(join(root, "no-such-record.jsonl"), realpathSync(aLinked), new Date(0))).toBe(false);
  });

  test("tidying leaves such a checkout alone, so a sweep that meets it every half hour runs no git there and tells nobody again", async () => {
    const { gate, shut } = consoleGate();
    const original = execFileSync("cat", [join(aLinked, ".git")], { encoding: "utf8" });
    const repoint = () => writeFileSync(join(aLinked, ".git"), `gitdir: ${join(b, ".git", "worktrees", "b-task")}\n`);
    await inFolderScope(gate, () => tidying(shut, "status", repoint)(aLinked, STATUS));
    // Put right afterwards (a person checked it by hand): still left alone for the day, with no git run there.
    writeFileSync(join(aLinked, ".git"), original);
    const told = heard.length;
    const ran: string[] = [];
    const counting: Runner = async (file, args, options) => { ran.push(String(options?.cwd ?? "")); return run(file, args, options); };
    const store = openStore(":memory:");
    try {
      const pool = new WorktreePool(store, { root, runner: counting });
      expect(await pool.inspect(aLinked, teardownGit(counting))).toBe("unreadable");
      expect(ran).toEqual([]);
      expect(await pool.inspect(bLinked, teardownGit(counting))).toBe("clean");
      expect(ran.length).toBeGreaterThan(0);
      expect(heard.length).toBe(told);
    } finally { store.close(); }
  });
});
