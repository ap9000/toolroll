/**
 * P2.2 must-refuse rules, against the real store and a real git repository: an automatic recheck runs only on a standing
 * check-only authorization, once per (commit, command digest), never on another commit or command, never wider than the
 * build's own access, and it starts no agent and seals nothing.
 */
import { allowWhereUnfenced } from "./unfenced-test-support.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { quickVerifyKey, recordRunCheckLevel, type CheckLevel } from "./check-levels.js";
import { followUpChecksOf, runFollowUpCheck } from "./result-follow-ups.js";
import { authorizeCheckOnly, claimRecheck, CHECK_ONLY_WINDOW_MS, RECHECK_ACTOR, requestMissingRechecks } from "./check-only.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

let dir: string, REPO: string, HEAD: string, root: string, file: string, password: string;
let store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-recheck-")));
  REPO = join(dir, "shop");
  execFileSync("mkdir", ["-p", REPO]);
  git(REPO, "init", "-q", "-b", "main");
  writeFileSync(join(REPO, "app.txt"), "v1\n");
  git(REPO, "add", ".");
  git(REPO, "commit", "-q", "-m", "first");
  HEAD = git(REPO, "rev-parse", "HEAD");
  root = join(dir, "evidence");
  file = join(dir, "orders.db");
  store = allowWhereUnfenced(openStore(file));
  register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok" });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
  const sam = addApprover(store, "sam", NOW);
  if (!sam.ok) throw new Error("approver");
  password = sam.token;
  store.setVerifyCommand({ repo: REPO, command: "test -f app.txt", timeoutMs: 60_000, approvedBy: "sam" }, NOW);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** A built result whose own check left no verdict, as a crash between the build and the check would. */
function built(id: string, options: { level?: CheckLevel; head?: string; approved?: boolean } = {}): { ref: number; run: number } {
  store.createTask({ id, title: id }, NOW);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, NOW);
  const proposed = propose(store, { taskId: id, goal: id, touches: ["src/"], acceptance: [{ id: "c1", statement: id, how: null, evidence: ["check"] }], now: NOW });
  const yes = approve(store, id, "sam", NOW, proposed.digest, password);
  if (!yes.ok) throw new Error(yes.reason);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: NOW });
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(run, { headRevision: options.head ?? HEAD, handoff: "Done." });
  store.finishRun(run, { outcome: "built", committed: true, now: NOW });
  store.setTaskState(id, "done", NOW);
  recordRunCheckLevel(store, { id: run, taskId: id, repo: REPO }, options.level ?? "full", "project", NOW);
  return { ref, run };
}
const auth = (run: number) => store.handle.prepare("SELECT * FROM check_authorization WHERE run = ?").get(run);

describe("writing one", () => {
  test("it comes from the approval that built this exact commit, and records its terms", () => {
    const { run, ref } = built("t");
    const id = authorizeCheckOnly(store, run, NOW);
    expect(id).not.toBeNull();
    expect(auth(run)).toMatchObject({ task_ref: ref, candidate: HEAD, command_digest: store.liveVerifyCommand(REPO)!.digest, level: "full", check_access: "sandboxed", scope_digest: store.getScope("t")!.digest,
      expires_at: later(CHECK_ONLY_WINDOW_MS).toISOString(), used_at: null });
  });

  test("a rewritten plan, an archived task, a level of Off or a run with no commit write nothing", () => {
    const rewritten = built("a");
    store.handle.prepare("UPDATE task_scope SET digest = 'other' WHERE task_id = 'a'").run();
    expect(authorizeCheckOnly(store, rewritten.run, NOW)).toBeNull();
    const off = built("b", { level: "off" });
    expect(authorizeCheckOnly(store, off.run, NOW)).toBeNull();
    const away = built("c");
    store.handle.prepare("INSERT INTO task_archive (task_ref, by, by_kind, reason, at) VALUES (?, 'sam', 'person', 'done', ?)").run(away.ref, NOW.toISOString());
    expect(authorizeCheckOnly(store, away.run, NOW)).toBeNull();
    const unbuilt = built("d");
    store.handle.prepare("UPDATE run SET head_revision = NULL WHERE id = ?").run(unbuilt.run);
    expect(authorizeCheckOnly(store, unbuilt.run, NOW)).toBeNull();
  });
});

describe("one automatic run", () => {
  test("a missing verdict asks once, the check runs on the exact commit, and it starts no agent and seals nothing", async () => {
    const { run, ref } = built("t");
    authorizeCheckOnly(store, run, NOW);
    const sealed = store.handle.prepare("SELECT approved_at, approved_digest, approved_by FROM task_scope WHERE task_id = 't'").get();
    const runs = () => store.handle.prepare("SELECT COUNT(*) AS n FROM run").get()?.["n"];
    const before = runs();
    expect(requestMissingRechecks(store, root, later(1))).toBe(1);
    expect(requestMissingRechecks(store, root, later(2))).toBe(0);
    const [asked] = followUpChecksOf(store, run, later(2));
    expect(asked).toMatchObject({ why: "recheck", head: HEAD, actor: RECHECK_ACTOR, state: "waiting" });
    expect(await runFollowUpCheck(store, root, asked!.request, { now: () => later(3) })).toMatchObject({ state: "passed", exitCode: 0 });
    expect(runs()).toBe(before);
    expect(store.currentLiveLease(ref, later(3))).toBeNull();
    expect(store.getTask("t")?.state).toBe("done");
    expect(store.handle.prepare("SELECT approved_at, approved_digest, approved_by FROM task_scope WHERE task_id = 't'").get()).toEqual(sealed);
    expect(requestMissingRechecks(store, root, later(4))).toBe(0);
  });

  test("concurrent workers: one claim wins, on two connections", () => {
    const { run } = built("t");
    const id = authorizeCheckOnly(store, run, NOW)!;
    const other = openStore(file);
    try {
      expect(claimRecheck(store, id, later(1))).not.toBeNull();
      expect(claimRecheck(other, id, later(1))).toBeNull();
    } finally { other.close(); }
    expect(followUpChecksOf(store, run, later(1))).toHaveLength(1);
  });

  test("a crash after the claim spends it: the need stays with the person", async () => {
    const { run } = built("t");
    authorizeCheckOnly(store, run, NOW);
    expect(requestMissingRechecks(store, root, later(1))).toBe(1);
    const [asked] = followUpChecksOf(store, run, later(1));
    store.recordAction({ at: later(2).toISOString(), actor: "system", repo: REPO, taskId: "t", runId: run, action: "checks started", outcome: String(asked!.request), source: "work", detail: "limit 1000" });
    // The worker died mid-check: its time and grace pass, and it reads as not run.
    const much = later(60 * 60_000);
    expect(followUpChecksOf(store, run, much)[0]).toMatchObject({ state: "not-run" });
    expect(requestMissingRechecks(store, root, much)).toBe(0);
    expect(followUpChecksOf(store, run, much)).toHaveLength(1);
  });

  test("a crash inside the claim leaves it whole", () => {
    const { run } = built("t");
    const id = authorizeCheckOnly(store, run, NOW)!;
    expect(() => store.transact(() => { claimRecheck(store, id, later(1)); throw new Error("power cut"); })).toThrow("power cut");
    expect(auth(run)).toMatchObject({ used_at: null });
    expect(followUpChecksOf(store, run, later(1))).toHaveLength(0);
    expect(claimRecheck(store, id, later(2))).not.toBeNull();
  });

  test("a verdict on the result closes it: nothing runs", () => {
    const { run } = built("t");
    authorizeCheckOnly(store, run, NOW);
    store.recordRunCheck(run, { status: "failed", exitCode: 1, suites: [] }, NOW);
    expect(requestMissingRechecks(store, root, later(1))).toBe(0);
    expect(auth(run)?.["closed_at"]).not.toBeNull();
  });

  test("expired: nothing runs", () => {
    const { run } = built("t");
    authorizeCheckOnly(store, run, NOW);
    expect(requestMissingRechecks(store, root, later(CHECK_ONLY_WINDOW_MS + 1))).toBe(0);
  });
});

describe("must refuse", () => {
  test("a different commit: a newer build on the task, or a changed head", () => {
    const { run } = built("t");
    const id = authorizeCheckOnly(store, run, NOW)!;
    store.handle.prepare("UPDATE run SET head_revision = ? WHERE id = ?").run("2".repeat(40), run);
    expect(claimRecheck(store, id, later(1))).toBeNull();
    expect(followUpChecksOf(store, run, later(1))).toHaveLength(0);
  });

  test("a different command digest: before asking, and between asking and running", async () => {
    const { run } = built("t");
    const id = authorizeCheckOnly(store, run, NOW)!;
    store.setVerifyCommand({ repo: REPO, command: "test -f other.txt", timeoutMs: 60_000, approvedBy: "sam" }, later(1));
    expect(claimRecheck(store, id, later(2))).toBeNull();
    store.setVerifyCommand({ repo: REPO, command: "test -f app.txt", timeoutMs: 60_000, approvedBy: "sam" }, later(3));
    const asked = claimRecheck(store, id, later(4));
    expect(asked).not.toBeNull();
    store.setVerifyCommand({ repo: REPO, command: "test -f other.txt", timeoutMs: 60_000, approvedBy: "sam" }, later(5));
    const runner = vi.fn();
    expect(await runFollowUpCheck(store, root, asked!.request, { now: () => later(6), runner: runner as never })).toMatchObject({ state: "not-run" });
    expect(runner).not.toHaveBeenCalled();
  });

  test("an approval that no longer stands", () => {
    const { run } = built("t");
    const id = authorizeCheckOnly(store, run, NOW)!;
    store.handle.prepare("UPDATE task_scope SET digest = 'moved' WHERE task_id = 't'").run();
    expect(claimRecheck(store, id, later(1))).toBeNull();
  });

  test("a run wider than the build's own access: every command refuses", async () => {
    const { run } = built("t");
    const id = authorizeCheckOnly(store, run, NOW)!;
    const asked = claimRecheck(store, id, later(1))!;
    // The stored level says the check ran narrower than the launch would now.
    store.handle.prepare("UPDATE run SET sandbox_access = 'unsandboxed' WHERE id = ?").run(run);
    store.handle.prepare("INSERT OR REPLACE INTO project_check_access (repo, level, updated_by, updated_at) VALUES (?, 'unsandboxed', 'sam', ?)").run(REPO, NOW.toISOString());
    const runner = vi.fn();
    expect(await runFollowUpCheck(store, root, asked.request, { now: () => later(2), runner: runner as never })).toMatchObject({ state: "not-run" });
    expect(runner).not.toHaveBeenCalled();
  });

  test("a missing record never means a run: an authorization that went away refuses at the run", async () => {
    const { run } = built("t");
    const id = authorizeCheckOnly(store, run, NOW)!;
    const asked = claimRecheck(store, id, later(1))!;
    store.handle.prepare("DELETE FROM check_authorization WHERE id = ?").run(id);
    const runner = vi.fn();
    expect(await runFollowUpCheck(store, root, asked.request, { now: () => later(2), runner: runner as never })).toMatchObject({ state: "not-run", note: "Its authorization couldn't be read." });
    expect(runner).not.toHaveBeenCalled();
  });

  test("a person's own request isn't spent as the automatic one, and a quick project keeps its own command", () => {
    store.setVerifyCommand({ repo: quickVerifyKey(REPO), command: "test -f app.txt", timeoutMs: 60_000, approvedBy: "sam" }, NOW);
    const { run } = built("t", { level: "quick" });
    authorizeCheckOnly(store, run, NOW);
    expect(auth(run)).toMatchObject({ level: "quick" });
  });
});
