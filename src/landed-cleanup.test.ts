/**
 * Landed work: a result whose work is already in main is marked complete automatically, with a ledger entry saying
 * why, and its clean checkout and local build and plan branches go; nothing with changes or unlanded work is touched;
 * a teardown a crash cut short finishes at the next reconcile; `storage clean --landed` previews, and acts only with
 * --yes. Real git, a real store on disk; no remote, no model.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { run, type ExecResult } from "./exec.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { assignmentOf, owedAcceptance } from "./assignment.js";
import { assignmentTaskStatusOf } from "./assignment-presentation.js";
import { workIndexTask } from "./work-index.js";
import { telegramProgressCard } from "./telegram-progress.js";
import { finishedLine } from "./chat-voice.js";
import { runOperate, EXIT } from "./operate.js";
import { WorktreePool } from "./worktree.js";
import { COMPLETION_ACTION, LANDED_ACTOR } from "./result-completion.js";
import { LANDED_CLEANED_ACTION, finishLanded, gitOf, landedProof, landedResults, recordLandedIntent, type Git } from "./landed-cleanup.js";

const DAY = 86_400_000;
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const env = (date?: Date) => ({ ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() }) });
const sh = (cwd: string, args: string[], date?: Date) => execFileSync("git", args, { cwd, encoding: "utf8", env: env(date) }).trim();

let dir: string, file: string, repo: string, root: string, poolRoot: string, store: Store, pool: WorktreePool, password: string;
const git: Git = gitOf();
const access = { principal: "operator" as const, repos: null, includeUnplaced: true };

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-landed-")));
  file = join(dir, "orders.db");
  repo = join(dir, "shop");
  root = join(dir, "evidence");
  poolRoot = join(dir, "worktrees");
  mkdirSync(repo);
  sh(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  writeFileSync(join(repo, "old.txt"), "moving soon\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "first"], ago(30 * DAY));
  store = openStore(file);
  register(store, { name: "builder-1", host: "test", capacity: 4, repos: [repo], now: ago(30 * DAY), newToken: () => ["tok", "builder", "1"].join("-") });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", ago(30 * DAY));
  const sam = addApprover(store, "sam", ago(30 * DAY));
  if (!sam.ok) throw new Error("approver");
  password = sam.token;
  pool = new WorktreePool(store, { root: poolRoot });
});
afterEach(() => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

type Built = { runId: number; head: string; path: string; ref: number };
/** A finished build as the builder leaves it: an approved scope, a let-go checkout on toolroll/<id> with one commit,
 * a plan branch at its base, and the task done (Ready). `failedCheck`: its project check failed. */
async function built(id: string, files: Record<string, string | null>, at = ago(DAY), options: { failedCheck?: boolean; main?: string } = {}): Promise<Built> {
  const main = options.main ?? "main";
  store.createTask({ id, title: `Change ${id}` }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, repo, {}, at);
  const proposed = propose(store, { taskId: id, goal: `Change ${id}`, touches: ["src/"], acceptance: [{ id: "c1", statement: `Change ${id}`, how: null, evidence: ["check"] }], now: at });
  const ok = approve(store, id, "sam", at, proposed.digest, password);
  if (!ok.ok) throw new Error(ok.reason);
  const base = sh(repo, ["rev-parse", main]);
  sh(repo, ["branch", `toolroll-plan/${id}`, base]);
  const leased = await pool.lease({ repo, branch: `toolroll/${id}`, base: main, runner: "builder-1", taskRef: ref, now: at });
  if (!leased.ok) throw new Error(leased.message);
  const path = leased.worktree.path;
  for (const [name, text] of Object.entries(files)) {
    if (text === null) sh(path, ["rm", "-q", name]);
    else { mkdirSync(join(path, name, ".."), { recursive: true }); writeFileSync(join(path, name), text); sh(path, ["add", name]); }
  }
  sh(path, ["commit", "-qm", `change ${id}`], at);
  const head = sh(path, ["rev-parse", "HEAD"]);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: path, route: authority.stamp, now: at });
  store.stampRun(runId, { scopeDigest: store.getScope(id)!.digest, baseRevision: base });
  store.recordOutcomeFacts(runId, { headRevision: head, handoff: `Changed ${id}.` });
  if (options.failedCheck === true) {
    store.setVerifyCommand({ repo, command: "npm test", timeoutMs: 60_000, approvedBy: "sam" }, at);
    storeEvidence(store, root, runId, "check-log", "checks.txt", Buffer.from("1 failed\n"), "npm test", at, { captureStatus: "ok" });
    sealVerificationReceipt(store, root, runId, head, store.liveVerifyCommand(repo)!, { configured: true, ran: true, exitCode: 1 }, at);
    store.recordRunCheck(runId, { status: "failed", exitCode: 1, suites: [] }, at);
  }
  store.finishRun(runId, { outcome: "built", committed: true, now: at });
  store.setTaskState(id, "done", at);
  expect((await pool.release(path, at)).ok).toBe(true);
  return { runId, head, path, ref };
}
const branch = (name: string) => { try { return sh(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]); } catch { return null; } };
const merge = (name: string) => sh(repo, ["merge", "-q", "--no-ff", "-m", `merge ${name}`, name]);
const ledger = (action: string) => store.actionLedger({ repos: null }).filter(one => one.action === action);
const merged = (b: Built, number: number) => store.handle.prepare(`INSERT INTO publication (run, task_ref, github_repo, remote, base, head, head_sha, body_hash, draft, state, pr_number, pr_url, created_at, updated_at, remote_state)
  VALUES (?, ?, 'sam-shop/shop', 'origin', 'main', ?, ?, 'x', 0, 'opened', ?, ?, ?, ?, 'MERGED')`).run(b.runId, b.ref, `toolroll/${b.ref}`, b.head, number, `https://github.com/sam-shop/shop/pull/${number}`, NOW.toISOString(), NOW.toISOString());

/** Every git command reconcile ran, through the same runner the CLI uses. */
let ran: string[][] = [];
const recording = (file: string, args: readonly string[], options?: Parameters<typeof run>[2]): Promise<ExecResult> => { ran.push([...args]); return run(file, args, options); };
let out: string[] = [];
async function cli(command: string, argv: string[]): Promise<{ code: number; text: string }> {
  store.close();
  out = [];
  try {
    const code = await runOperate(command, argv, line => { out.push(line); }, { databaseFile: file, evidenceRoot: root, now: NOW, gitRunner: recording });
    return { code, text: out.join("\n") };
  } finally { store = openStore(file); pool = new WorktreePool(store, { root: poolRoot }); }
}
const reconcile = () => cli("reconcile", ["--repo", repo, "--pool", poolRoot, "--json"]);

describe("the landing proof fails closed", () => {
  test("merged pull request, commits in main, content in main (renames and deletes on both sides), and every doubt", async () => {
    const work = await built("rename", { "new.txt": "moving soon\n", "old.txt": null, "src/a.ts": "export const a = 1;\n" });
    expect(await landedProof(git, repo, work.head)).toEqual({ landed: false, why: "its changes aren't all in main" });
    expect(await landedProof(git, repo, work.head, { merged: true, headSha: work.head, number: 7 })).toEqual({ landed: true, how: "merged", reason: "pull request #7 merged" });
    // A merged pull request for another commit proves nothing about this one.
    expect((await landedProof(git, repo, work.head, { merged: true, headSha: "f".repeat(40), number: 7 })).landed).toBe(false);
    // Only the added side of the rename in main: the old path is still there, so it didn't land.
    sh(repo, ["checkout", "-q", "toolroll/rename", "--", "new.txt", "src/a.ts"]);
    sh(repo, ["commit", "-qm", "half"]);
    expect(await landedProof(git, repo, work.head)).toEqual({ landed: false, why: "its changes aren't all in main" });
    sh(repo, ["rm", "-q", "old.txt"]);
    sh(repo, ["commit", "-qm", "other half"]);
    expect(await landedProof(git, repo, work.head)).toEqual({ landed: true, how: "content-in-main", reason: "its changes are already in main" });
    // A later change in main to a file it changed: no longer the same entry.
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    sh(repo, ["commit", "-qam", "moved on"]);
    expect((await landedProof(git, repo, work.head)).landed).toBe(false);

    const ancestor = await built("ancestor", { "src/b.ts": "b\n" });
    merge("toolroll/ancestor");
    expect(await landedProof(git, repo, ancestor.head)).toEqual({ landed: true, how: "in-main", reason: "its commits are in main" });

    expect(await landedProof(git, repo, null)).toEqual({ landed: false, why: "it has no saved commit" });
    expect(await landedProof(git, repo, "nope")).toEqual({ landed: false, why: "it has no saved commit" });
    expect(await landedProof(git, repo, "e".repeat(40))).toEqual({ landed: false, why: "its commit isn't in the repository" });
    const broken: Git = async () => ({ code: 128, stdout: "", stderr: "fatal", timedOut: false, notFound: false });
    expect(await landedProof(broken, repo, ancestor.head)).toEqual({ landed: false, why: "git couldn't read main" });
    const noMain = join(dir, "trunk");
    mkdirSync(noMain);
    sh(noMain, ["init", "-q", "-b", "trunk"]);
    writeFileSync(join(noMain, "x"), "x\n");
    sh(noMain, ["add", "."]);
    sh(noMain, ["commit", "-qm", "x"]);
    expect(await landedProof(git, noMain, sh(noMain, ["rev-parse", "HEAD"]))).toEqual({ landed: false, why: "the project has no local main branch" });
    expect((await landedProof(git, join(dir, "missing"), ancestor.head)).landed).toBe(false);
  });
});

describe("c1: a merged result is completed automatically and torn down", () => {
  test("a merged pull request: one completion saying why, checks unchanged, checkout and local branches gone, remotes and tags untouched", async () => {
    const work = await built("cart", { "src/cart.ts": "export const cart = [];\n" }, ago(DAY), { failedCheck: true });
    merged(work, 12);
    sh(repo, ["tag", "v1", work.head]);
    sh(repo, ["update-ref", "refs/remotes/origin/toolroll/cart", work.head]);
    const before = assignmentOf(store, "cart", NOW, access, root)!;
    expect(before.state).toBe("ready-to-check");
    expect(before.receipt!.checks.status).toBe("failed");

    ran = [];
    const first = await reconcile();
    expect(first.code).toBe(EXIT.ok);
    expect(JSON.parse(first.text).landed.completed).toEqual(["cart"]);
    const second = await reconcile();
    expect(JSON.parse(second.text).landed).toEqual({ completed: [], steps: [] });

    const completions = ledger(COMPLETION_ACTION);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ actor: LANDED_ACTOR, taskId: "cart", runId: work.runId, outcome: before.receipt!.digest, source: "work", detail: "pull request #12 merged" });
    expect(existsSync(work.path)).toBe(false);
    expect(store.getWorktree(work.path)).toBeNull();
    expect(branch("toolroll/cart")).toBeNull();
    expect(branch("toolroll-plan/cart")).toBeNull();
    expect(branch("main")).not.toBeNull();
    expect(sh(repo, ["rev-parse", "v1"])).toBe(work.head);
    expect(sh(repo, ["rev-parse", "refs/remotes/origin/toolroll/cart"])).toBe(work.head);
    expect(ran.filter(args => !args.includes("symbolic-ref") && args.some(arg => ["push", "fetch", "pull", "tag", "remote"].includes(arg) || arg.startsWith("refs/tags") || arg.startsWith("refs/remotes")))).toEqual([]);
    expect(ledger("branch deleted").map(one => one.detail).sort()).toEqual([
      expect.stringMatching(/^toolroll-plan\/cart at [0-9a-f]{12}: its work landed \(pull request #12 merged\)$/),
      expect.stringMatching(/^toolroll\/cart at [0-9a-f]{12}: its work landed \(pull request #12 merged\)$/)]);
    expect(ledger("checkout removed")).toMatchObject([{ actor: LANDED_ACTOR, taskId: "cart", source: "work" }]);
    expect(ledger(LANDED_CLEANED_ACTION)).toMatchObject([{ outcome: "removed", detail: "pull request #12 merged: 3 removed" }]);

    // Every surface reads Complete, says why once, and keeps the failed check.
    const after = assignmentOf(store, "cart", NOW, access, root)!;
    expect(after.state).toBe("complete");
    expect(after.completion).toMatchObject({ actor: LANDED_ACTOR, landed: "pull request #12 merged" });
    expect(after.receipt!.checks).toEqual(before.receipt!.checks);
    expect(after.receipt!.digest).toBe(before.receipt!.digest);
    const status = assignmentTaskStatusOf(after);
    expect(status.headline).toBe("Complete");
    expect(status.sentence).toBe("Marked complete automatically: pull request #12 merged.");
    const indexed = workIndexTask(store, "cart", NOW, access, root)!;
    expect(indexed.status.label).toBe("Complete");
    expect(indexed.status.detail).toBe(status.sentence);
    expect(indexed.completion).toMatchObject({ actor: LANDED_ACTOR, landed: "pull request #12 merged" });
    const card = telegramProgressCard(store, store.getRun(work.runId)!, "cart", repo, NOW, root);
    expect(card.facts).toMatchObject({ landed: "pull request #12 merged", completedBy: null, checks: { status: "failed" } });
    expect(finishedLine({ summary: "Change cart", headline: "Complete", checks: "failed", report: false, completedBy: null, landed: card.facts.landed ?? null })).toBe("Change cart is done: pull request #12 merged.");
  });

  test("commits reachable from main, and content already in main, complete too", async () => {
    const ff = await built("fast", { "src/fast.ts": "fast\n" });
    const picked = await built("picked", { "src/picked.ts": "picked\n" });
    merge("toolroll/fast");
    sh(repo, ["cherry-pick", picked.head]);
    expect((await reconcile()).code).toBe(EXIT.ok);
    expect(Object.fromEntries(ledger(COMPLETION_ACTION).map(one => [one.taskId, one.detail]))).toEqual({ fast: "its commits are in main", picked: "its changes are already in main" });
    for (const one of [ff, picked]) expect(existsSync(one.path)).toBe(false);
    expect([branch("toolroll/fast"), branch("toolroll/picked"), branch("toolroll-plan/picked")]).toEqual([null, null, null]);
  });
});

describe("c2: changes, unlanded work and anything in doubt stay", () => {
  test("modified and untracked files, unlanded work, a live lease and a branch another unfinished task uses are never removed", async () => {
    const tracked = await built("tracked", { "src/t.ts": "t\n" });
    const untracked = await built("untracked", { "src/u.ts": "u\n" });
    const unlanded = await built("unlanded", { "src/n.ts": "n\n" });
    const leased = await built("leased", { "src/l.ts": "l\n" });
    const shared = await built("shared", { "src/s.ts": "s\n" });
    for (const name of ["tracked", "untracked", "leased", "shared"]) merge(`toolroll/${name}`);
    writeFileSync(join(tracked.path, "src", "t.ts"), "edited by hand\n");
    writeFileSync(join(untracked.path, "notes.txt"), "a person's note\n");
    const again = await pool.lease({ repo, branch: "toolroll/leased", runner: "builder-1", now: NOW });
    expect(again.ok).toBe(true);
    // Another task, still running, uses the shared result's plan branch.
    store.createTask({ id: "other", title: "Other" }, NOW);
    const otherRef = store.refFor("built-in", "other").id;
    store.placeTask(otherRef, repo, {}, NOW);
    store.startRun({ taskRef: otherRef, leaseId: "l-other", runner: "builder-1", branch: "toolroll-plan/shared", worktree: join(poolRoot, "other"), route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: NOW });

    await reconcile();
    const steps = JSON.parse((await reconcile()).text);
    expect(steps.ok).toBe(true);
    // Landed results are complete; unlanded work is not.
    expect(ledger(COMPLETION_ACTION).map(one => one.taskId).sort()).toEqual(["leased", "shared", "tracked", "untracked"]);
    expect(assignmentOf(store, "unlanded", NOW, access, root)!.state).toBe("ready-to-check");
    for (const one of [tracked, untracked, unlanded, leased]) expect(existsSync(one.path)).toBe(true);
    expect(existsSync(join(untracked.path, "notes.txt"))).toBe(true);
    expect(sh(tracked.path, ["status", "--porcelain"])).toContain("src/t.ts");
    for (const name of ["tracked", "untracked", "unlanded", "leased"]) expect(branch(`toolroll/${name}`)).not.toBeNull();
    expect(branch("toolroll-plan/shared")).not.toBeNull();
    const why = (target: string) => store.handle.prepare("SELECT state, why FROM landed_cleanup_item WHERE target = ?").get(target);
    expect(why(tracked.path)).toMatchObject({ state: "pending", why: "has changes" });
    expect(why(untracked.path)).toMatchObject({ state: "pending", why: "has changes" });
    expect(why(leased.path)).toMatchObject({ state: "pending", why: "in use" });
    expect(why("toolroll/tracked")).toMatchObject({ state: "pending", why: "its checkout goes first" });
    expect(why("toolroll-plan/shared")).toMatchObject({ state: "pending", why: "other uses it (its task isn't finished)" });
    // The shared result's own checkout and build branch, used by no one else, went.
    expect(existsSync(shared.path)).toBe(false);
    expect(branch("toolroll/shared")).toBeNull();
  });

  test("a branch that moved after its teardown was recorded is kept, and so is a project with no local main", async () => {
    const work = await built("moved", { "src/m.ts": "m\n" });
    merge("toolroll/moved");
    const found = await landedResults(store, git, repo, root, NOW);
    expect(found.found.map(one => one.taskId)).toEqual(["moved"]);
    expect(recordLandedIntent(store, found.found[0]!, NOW, root)).toMatchObject({ ok: true, completed: true });
    const lease = await pool.lease({ repo, branch: "toolroll/moved", runner: "builder-1", now: NOW });
    if (!lease.ok) throw new Error(lease.message);
    writeFileSync(join(work.path, "src", "late.ts"), "late\n");
    sh(work.path, ["add", "."]);
    sh(work.path, ["commit", "-qm", "after it landed"]);
    expect((await pool.release(work.path, NOW)).ok).toBe(true);
    const steps = await finishLanded(store, pool, git, () => NOW);
    expect(steps.map(one => [one.target.replace(dir, ""), one.outcome, one.why])).toEqual([
      ["/worktrees/shop/toolroll-moved-" + work.path.split("-").at(-1), "kept", "it has commits that didn't land"],
      ["toolroll/moved", "kept", "it moved since"],
      ["toolroll-plan/moved", "removed", null]]);
    expect(existsSync(join(work.path, "src", "late.ts"))).toBe(true);
    expect(branch("toolroll/moved")).not.toBeNull();
    expect(ledger(LANDED_CLEANED_ACTION)).toMatchObject([{ outcome: "partial", detail: "its commits are in main: 1 removed, 2 kept" }]);

    sh(repo, ["branch", "-m", "main", "trunk"]);
    await built("trunkless", { "src/x.ts": "x\n" }, ago(DAY), { main: "trunk" });
    expect((await landedResults(store, git, repo, root, NOW)).kept).toEqual([{ repo, what: "trunkless", why: "the project has no local main branch" }]);
  });
});

describe("review regressions: eligibility and teardown fences", () => {
  test.each(["no-change", "base-equal"])("%s results are never landed, including when recording an intent", async (kind) => {
    const work = await built("empty", { "src/empty.ts": "empty\n" });
    merge("toolroll/empty");
    const candidate = (await landedResults(store, git, repo, root, NOW)).found[0]!;
    if (kind === "no-change") store.handle.prepare("UPDATE run SET outcome = 'no-change' WHERE id = ?").run(work.runId);
    else store.handle.prepare("UPDATE run SET base_revision = ? WHERE id = ?").run(work.head, work.runId);
    const receipt = assignmentOf(store, "empty", NOW, access, root)!.receipt!;
    expect(recordLandedIntent(store, { ...candidate, receipt: receipt.digest }, NOW, root).ok).toBe(false);
    expect((await landedResults(store, git, repo, root, NOW)).found).toEqual([]);
    expect(ledger(COMPLETION_ACTION)).toEqual([]);
    expect(existsSync(work.path)).toBe(true);
    expect(branch("toolroll/empty")).toBe(work.head);
  });

  test("main rewound after intent keeps every item pending until the landing proof holds again", async () => {
    const work = await built("rewound", { "src/rewound.ts": "rewound\n" });
    const base = branch("main")!;
    merge("toolroll/rewound");
    const landed = branch("main")!;
    const candidate = (await landedResults(store, git, repo, root, NOW)).found[0]!;
    expect(recordLandedIntent(store, candidate, NOW, root).ok).toBe(true);
    // Move the local integration ref without touching the task's checkout.
    sh(repo, ["checkout", "-q", "--detach", base]);
    sh(repo, ["update-ref", "refs/heads/main", base, landed]);
    sh(repo, ["checkout", "-q", "main"]);
    const steps = await finishLanded(store, pool, git, () => NOW);
    expect(steps.every(one => one.outcome === "waits")).toBe(true);
    expect(existsSync(work.path)).toBe(true);
    expect(branch("toolroll/rewound")).toBe(work.head);
    expect(ledger(LANDED_CLEANED_ACTION)).toEqual([]);
    merge("toolroll/rewound");
    await reconcile();
    expect(existsSync(work.path)).toBe(false);
    expect(branch("toolroll/rewound")).toBeNull();
    expect(ledger(COMPLETION_ACTION)).toHaveLength(1);
    expect(ledger(LANDED_CLEANED_ACTION)).toHaveLength(1);
  });

  test.each(["checkout", "branch"])("the landing proof is refreshed after the %s inspection", async (kind) => {
    const work = await built("changed-proof", { "src/proof.ts": "proof\n" });
    merged(work, 9);
    const candidate = (await landedResults(store, git, repo, root, NOW)).found[0]!;
    expect(recordLandedIntent(store, candidate, NOW, root).ok).toBe(true);
    if (kind === "branch") await finishLanded(store, pool, git, () => NOW, { limit: 1 });
    let changed = false;
    const invalidate = () => {
      changed = true;
      store.handle.prepare("UPDATE publication SET remote_state = 'OPEN' WHERE run = ?").run(work.runId);
    };
    const duringInspection = new WorktreePool(store, { root: poolRoot, runner: async (file, args, options) => {
      const result = await run(file, args, options);
      if (!changed && kind === "checkout" && args.includes("rev-list")) invalidate();
      return result;
    } });
    const duringBranch: Git = async (cwd, args) => {
      const result = await git(cwd, args);
      if (!changed && kind === "branch" && args[0] === "rev-parse" && args.includes("refs/heads/toolroll/changed-proof^{commit}")) invalidate();
      return result;
    };
    const steps = await finishLanded(store, duringInspection, duringBranch, () => NOW);
    expect(changed).toBe(true);
    expect(steps.every(one => one.outcome === "waits")).toBe(true);
    expect(existsSync(work.path)).toBe(kind === "checkout");
    expect(branch("toolroll/changed-proof")).toBe(work.head);
    store.handle.prepare("UPDATE publication SET remote_state = 'MERGED' WHERE run = ?").run(work.runId);
    await finishLanded(store, pool, git, () => NOW);
    expect(branch("toolroll/changed-proof")).toBeNull();
  });

  test.each(["main", "feature/personal", "toolroll/someone-else"])("a run recorded on %s cannot add that branch to task teardown", async (name) => {
    const work = await built("names", { "src/names.ts": "names\n" });
    merge("toolroll/names");
    if (name !== "main") sh(repo, ["branch", name, work.head]);
    store.handle.prepare("UPDATE run SET branch = ? WHERE id = ?").run(name, work.runId);
    sh(repo, ["checkout", "-q", "--detach", "main"]);
    sh(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const candidate = (await landedResults(store, git, repo, root, NOW)).found[0]!;
    expect(candidate.targets.filter(one => one.kind === "branch").map(one => one.target).sort()).toEqual(["toolroll-plan/names", "toolroll/names"]);
    expect(recordLandedIntent(store, candidate, NOW, root).ok).toBe(true);
    // Old journals may already contain this unsafe target: execution must reject it too.
    const cleanup = store.handle.prepare("SELECT id FROM landed_cleanup WHERE run_id = ?").get(work.runId)!["id"];
    store.handle.prepare("INSERT INTO landed_cleanup_item (cleanup, kind, repo, target, expect) VALUES (?, 'branch', ?, ?, ?)")
      .run(cleanup, repo, name, branch(name));
    await finishLanded(store, pool, git, () => NOW);
    expect(branch(name)).not.toBeNull();
    expect(store.handle.prepare("SELECT state FROM landed_cleanup_item WHERE target = ?").get(name)).toMatchObject({ state: "kept" });
  });

  test("deleting a task branch never follows a symbolic ref into main", async () => {
    await built("symbolic", { "src/symbolic.ts": "symbolic\n" });
    merge("toolroll/symbolic");
    const main = branch("main");
    sh(repo, ["symbolic-ref", "refs/heads/toolroll-plan/symbolic", "refs/heads/main"]);
    const candidate = (await landedResults(store, git, repo, root, NOW)).found[0]!;
    expect(recordLandedIntent(store, candidate, NOW, root).ok).toBe(true);
    await finishLanded(store, pool, git, () => NOW);
    expect(branch("main")).toBe(main);
    expect(branch("toolroll-plan/symbolic")).toBeNull();
  });

  test("the repository default and a checkout switched to an arbitrary branch are kept", async () => {
    const work = await built("default", { "src/default.ts": "default\n" });
    merge("toolroll/default");
    const candidate = (await landedResults(store, git, repo, root, NOW)).found[0]!;
    expect(recordLandedIntent(store, candidate, NOW, root).ok).toBe(true);
    // Even an exact plan branch must stay when it is the recorded repository default.
    sh(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/toolroll-plan/default"]);
    sh(work.path, ["checkout", "-q", "-b", "feature/keep"]);
    await finishLanded(store, pool, git, () => NOW);
    expect(existsSync(work.path)).toBe(true);
    expect(branch("toolroll-plan/default")).not.toBeNull();
    expect(branch("feature/keep")).toBe(work.head);
    expect(store.handle.prepare("SELECT state FROM landed_cleanup_item WHERE target = 'toolroll-plan/default'").get()).toMatchObject({ state: "pending" });
    // Resolve the switched checkout, allowing the branch deletion guard itself to run.
    sh(work.path, ["checkout", "-q", "toolroll/default"]);
    await finishLanded(store, pool, git, () => NOW);
    expect(existsSync(work.path)).toBe(false);
    expect(branch("toolroll-plan/default")).not.toBeNull();
    expect(store.handle.prepare("SELECT state, why FROM landed_cleanup_item WHERE target = 'toolroll-plan/default'").get())
      .toMatchObject({ state: "kept", why: "it is the project's default branch" });
  });

  test.each(["failed", "missing", "person-check", "criteria", "high", "protected"])("a non-PR result with %s completion requirements stays for a person", async (kind) => {
    const work = await built("blocked", { "src/blocked.ts": "blocked\n" }, ago(DAY), { failedCheck: kind === "failed" });
    merge("toolroll/blocked");
    if (kind === "missing") store.setVerifyCommand({ repo, command: "npm test", timeoutMs: 60_000, approvedBy: "sam" }, NOW);
    if (kind === "person-check") store.saveProofVerdict(work.runId, "short",
      ['criterion "c1" requires manual-review evidence — an operator must accept it before this can verify'], NOW,
      [{ id: "c1", statement: "Inspect the change", state: "manual-review", requiredEvidence: ["manual-review"], detail: [], answered: [], review: null }]);
    if (kind === "criteria") store.saveProofVerdict(work.runId, "short", ["The requirement has no evidence."], NOW,
      [{ id: "c1", statement: "Inspect the change", state: "missing", requiredEvidence: ["check"], detail: [], answered: [], review: null }]);
    if (kind === "high") store.handle.prepare("INSERT INTO build_review (run, task_id, repo, state, findings_json, queued_at, finished_at) VALUES (?, 'blocked', ?, 'reviewed', ?, ?, ?)")
      .run(work.runId, repo, JSON.stringify({ version: 1, findings: [{ severity: "HIGH", file: "src/blocked.ts", line: 1, scenario: "The change drops saved work." }] }), NOW.toISOString(), NOW.toISOString());
    if (kind === "protected") store.setApprovalRules(repo, { notRequester: false, protectProject: false, protectedPaths: ["src/"] }, "sam", NOW);
    const current = assignmentOf(store, "blocked", NOW, access, root)!;
    expect(current.state).toBe("ready-to-check");
    if (kind === "person-check") expect(owedAcceptance(current.receipt, current.readiness?.blockers)).toBe("person-check");
    else if (kind !== "protected") expect(current.readiness?.blockers.length).toBeGreaterThan(0);
    expect((await landedResults(store, git, repo, root, NOW)).found).toEqual([]);
    await reconcile();
    expect(ledger(COMPLETION_ACTION)).toEqual([]);
    expect(existsSync(work.path)).toBe(true);
    expect(branch("toolroll/blocked")).toBe(work.head);
    // A durable merge for the exact result is the only exception; checks/proof stay recorded.
    merged(work, 41);
    store.handle.prepare("UPDATE publication SET head_sha = ? WHERE run = ?").run(store.getRun(work.runId)!.baseRevision, work.runId);
    expect((await landedResults(store, git, repo, root, NOW)).found).toEqual([]);
    store.handle.prepare("UPDATE publication SET head_sha = ? WHERE run = ?").run(work.head, work.runId);
    await reconcile();
    expect(ledger(COMPLETION_ACTION)).toHaveLength(1);
    expect(store.taskActs(work.ref).filter(one => one.act === "completed")).toMatchObject([{ account: LANDED_ACTOR, lead: false }]);
    expect(assignmentOf(store, "blocked", NOW, access, root)!.receipt!.checks).toEqual(current.receipt!.checks);
  });

  test("completion requirements are checked again inside the intent transaction", async () => {
    const work = await built("late-check", { "src/late.ts": "late\n" });
    merge("toolroll/late-check");
    const candidate = (await landedResults(store, git, repo, root, NOW)).found[0]!;
    store.setVerifyCommand({ repo, command: "npm test", timeoutMs: 60_000, approvedBy: "sam" }, NOW);
    // Re-reading the same result must not allow a missing required check to be bypassed.
    const receipt = assignmentOf(store, "late-check", NOW, access, root)!.receipt!;
    expect(recordLandedIntent(store, { ...candidate, receipt: receipt.digest }, NOW, root).ok).toBe(false);
    expect(ledger(COMPLETION_ACTION)).toEqual([]);
    expect(existsSync(work.path)).toBe(true);
  });

  test.each(["checkout", "run", "lease", "git-checkout"])("a branch claimed by a %s after its first Git inspection stays", async (kind) => {
    const work = await built("claimed", { "src/claimed.ts": "claimed\n" });
    merge("toolroll/claimed");
    const candidate = (await landedResults(store, git, repo, root, NOW)).found[0]!;
    expect(recordLandedIntent(store, candidate, NOW, root).ok).toBe(true);
    const saved = store.getWorktree(work.path)!;
    await finishLanded(store, pool, git, () => NOW, { limit: 1 });
    let claimed = false;
    const racing: Git = async (cwd, args) => {
      const result = await git(cwd, args);
      if (!claimed && args[0] === "worktree" && args[1] === "list") {
        claimed = true;
        // Another connection admits work after the first Git worktree snapshot was taken.
        const other = openStore(file);
        try {
          if (kind === "checkout") other.saveWorktree({ ...saved, path: join(poolRoot, "new-claim"), repo, branch: "toolroll/claimed", taskRef: null,
            runner: "builder-1", releasedAt: null });
          if (kind === "run") {
            const route = other.routeAuthorityFor(work.ref, "builder");
            if (!route?.ok) throw new Error("route");
            other.startRun({ taskRef: work.ref, leaseId: "new-run", runner: "builder-1", branch: "toolroll/claimed", worktree: work.path, route: route.stamp, now: NOW });
          }
          if (kind === "lease") other.handle.prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, 1, 'builder-1', ?, ?, ?)")
            .run("new-lease", work.ref, NOW.toISOString(), new Date(NOW.getTime() + DAY).toISOString(), NOW.toISOString());
          if (kind === "git-checkout") sh(repo, ["worktree", "add", "-q", join(poolRoot, "unrecorded"), "toolroll/claimed"]);
        } finally { other.close(); }
      }
      return result;
    };
    await finishLanded(store, pool, racing, () => NOW);
    expect(claimed).toBe(true);
    expect(branch("toolroll/claimed")).toBe(work.head);
    expect(store.handle.prepare("SELECT state FROM landed_cleanup_item WHERE target = 'toolroll/claimed'").get()).toMatchObject({ state: "pending" });
  });
});

describe("c3: an interrupted teardown finishes at the next reconcile", () => {
  async function intended(id: string): Promise<Built> {
    const work = await built(id, { [`src/${id}.ts`]: `${id}\n` });
    merge(`toolroll/${id}`);
    const found = (await landedResults(store, git, repo, root, NOW)).found.find(one => one.taskId === id)!;
    expect(recordLandedIntent(store, found, NOW, root)).toMatchObject({ ok: true, completed: true });
    return work;
  }
  const settled = (id: string) => {
    expect(ledger(COMPLETION_ACTION).filter(one => one.taskId === id)).toHaveLength(1);
    expect(ledger(LANDED_CLEANED_ACTION).filter(one => one.taskId === id)).toHaveLength(1);
    expect(store.handle.prepare("SELECT finished_at FROM landed_cleanup WHERE task_id = ?").get(id)?.["finished_at"]).not.toBeNull();
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM landed_cleanup_item i JOIN landed_cleanup c ON c.id = i.cleanup WHERE c.task_id = ? AND i.state <> 'done'").get(id)?.["n"]).toBe(0);
  };

  test("stopped after the intent, after the checkout went, and after the branch went: reconcile finishes each once", async () => {
    // 1. The intent committed, then the process died.
    const first = await intended("first");
    // 2. The checkout went, but its step was never recorded.
    const second = await intended("second");
    sh(repo, ["worktree", "remove", "--force", second.path]);
    // 3. The checkout step was recorded and the branch deleted, but that step never was.
    const third = await intended("third");
    await finishLanded(store, pool, git, () => NOW, { limit: 1, only: new Set([Number(store.handle.prepare("SELECT id FROM landed_cleanup WHERE task_id = 'third'").get()!["id"])]) });
    expect(existsSync(third.path)).toBe(false);
    sh(repo, ["branch", "-D", "toolroll/third"]);
    store.close();
    store = openStore(file);

    const once = await reconcile();
    expect(once.code).toBe(EXIT.ok);
    const ledgerSize = store.actionLedger({ repos: null, limit: 10_000 }).length;
    const twice = JSON.parse((await reconcile()).text);
    expect(twice.landed).toEqual({ completed: [], steps: [] });
    expect(ledger(COMPLETION_ACTION).length + ledger(LANDED_CLEANED_ACTION).length).toBe(6);
    expect(store.actionLedger({ repos: null, limit: 10_000 }).length).toBe(ledgerSize);
    for (const id of ["first", "second", "third"]) settled(id);
    for (const one of [first, second, third]) expect(existsSync(one.path)).toBe(false);
    for (const id of ["first", "second", "third"]) { expect(branch(`toolroll/${id}`)).toBeNull(); expect(branch(`toolroll-plan/${id}`)).toBeNull(); }
    // A resource already gone finished its item without a removal entry of its own.
    expect(ledger("checkout removed").map(one => one.taskId).sort()).toEqual(["first", "third"]);
    expect(ledger("branch deleted").filter(one => one.taskId === "third").map(one => one.detail)).toEqual([expect.stringMatching(/^toolroll-plan\/third/)]);
  });
});

describe("c4: storage clean --landed previews by default and acts only with --yes", () => {
  /** Everything a clean-up could change: every row of every table, every local ref, and the checkouts on disk. */
  const snapshot = () => {
    const tables = store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => String(row["name"]));
    const rows = tables.map(name => [name, store.handle.prepare(`SELECT * FROM "${name}"`).all()]);
    return JSON.stringify({ rows, refs: sh(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]), worktrees: sh(repo, ["worktree", "list", "--porcelain"]) });
  };

  test("a preview changes nothing; --yes needs an instance operator, records intents first and applies the week-old backlog", async () => {
    const old = await built("old-result", { "src/old.ts": "old\n" }, ago(9 * DAY));
    const recent = await built("new-result", { "src/new.ts": "new\n" }, ago(2 * DAY));
    const unlanded = await built("unlanded-old", { "src/u.ts": "u\n" }, ago(9 * DAY));
    merge("toolroll/old-result");
    merge("toolroll/new-result");
    // Branches no task names: one landed long ago, one never landed, one landed but new, one outside Toolroll's names.
    for (const [name, landed, when] of [["toolroll/orphan", true, ago(20 * DAY)], ["standing-orders/stray", false, ago(20 * DAY)], ["toolroll-plan/fresh", true, ago(DAY)], ["feature/mine", true, ago(20 * DAY)]] as const) {
      sh(repo, ["checkout", "-q", "-b", name, "main"]);
      writeFileSync(join(repo, `${name.replace(/\//g, "-")}.txt`), "x\n");
      sh(repo, ["add", "."]);
      sh(repo, ["commit", "-qm", name], when);
      sh(repo, ["checkout", "-q", "main"]);
      if (landed) sh(repo, ["merge", "-q", "--ff-only", name]);
      else sh(repo, ["checkout", "-q", "main"]);
    }
    store.recordAction({ at: NOW.toISOString(), actor: "operator:sam", repo, taskId: null, runId: null, action: "project seen", outcome: "recorded", source: "work" });
    const before = snapshot();

    const preview = await cli("storage", ["clean", "--landed"]);
    expect(preview.code).toBe(EXIT.ok);
    expect(preview.text).toContain("Would mark 1 landed result complete and remove 1 checkout and 3 local branches.");
    expect(preview.text).toContain("shop old-result: its commits are in main");
    expect(preview.text).toContain("shop toolroll/orphan: its commits are in main");
    expect(preview.text).toContain("shop new-result: finished less than 7 days ago");
    expect(preview.text).toContain("shop unlanded-old: its changes aren't all in main");
    expect(preview.text).toContain("shop standing-orders/stray: its changes aren't all in main");
    expect(preview.text).toContain("shop toolroll-plan/fresh: its last commit is less than 7 days old");
    expect(preview.text).not.toContain("feature/mine");
    // A result that stays says why once: its branches are not listed again.
    expect(preview.text).not.toContain("new-result uses it");
    expect(preview.text).toContain("Nothing was changed. Run toolroll storage clean --landed --yes to do it.");
    const json = JSON.parse((await cli("storage", ["clean", "--landed", "--json"])).text);
    expect(json).toMatchObject({ ok: true, preview: true, results: [{ taskId: "old-result", completes: true, how: "in-main" }], branches: [{ branch: "toolroll/orphan" }] });
    expect(snapshot()).toBe(before);

    expect((await cli("storage", ["clean", "--landed", "--yes"])).code).toBe(EXIT.refused);
    expect((await cli("storage", ["clean", "--landed", "--yes", "--as", "sam", "--token", "wrong"])).code).toBe(EXIT.refused);
    expect((await cli("storage", ["clean", "--landed", "extra"])).code).toBe(EXIT.usage);
    expect(snapshot()).toBe(before);

    const done = await cli("storage", ["clean", "--landed", "--yes", "--as", "sam", "--token", password]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.text).toContain("Marked 1 landed result complete. Removed 1 checkout and 3 local branches.");
    expect(ledger(COMPLETION_ACTION)).toMatchObject([{ actor: LANDED_ACTOR, taskId: "old-result", detail: "its commits are in main" }]);
    expect(store.handle.prepare("SELECT task_id, actor FROM landed_cleanup ORDER BY id").all()).toEqual([{ task_id: "old-result", actor: "sam" }, { task_id: null, actor: "sam" }]);
    expect(ledger("branch deleted").map(one => [one.actor, one.source])).toEqual([["sam", "request"], ["sam", "request"], ["sam", "request"]]);
    expect(existsSync(old.path)).toBe(false);
    for (const one of [recent, unlanded]) expect(existsSync(one.path)).toBe(true);
    expect([branch("toolroll/old-result"), branch("toolroll-plan/old-result"), branch("toolroll/orphan")]).toEqual([null, null, null]);
    for (const name of ["toolroll/new-result", "toolroll/unlanded-old", "standing-orders/stray", "toolroll-plan/fresh", "feature/mine"]) expect(branch(name)).not.toBeNull();
    // Reconcile would complete the recent one on its own; the one-time pass only takes the week-old backlog.
    expect(assignmentOf(store, "new-result", NOW, access, root)!.state).toBe("ready-to-check");
  });
});
