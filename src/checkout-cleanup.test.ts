/**
 * Checkout cleanup (Settings → Storage, `toolroll storage`): a finished task's clean checkout goes as the setting
 * says (by default when its task is complete or cancelled), its branch stays, Toolroll's own files don't count as a
 * person's work, a clean-up by hand previews first, and every removal is in the ledger.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import { run } from "./exec.js";
import { COMPLETION_ACTION } from "./result-completion.js";
import { WorktreePool } from "./worktree.js";
import { checkoutPlan, cleanCheckouts, deployedRelease, releaseOf, slimKeptCheckouts, taskStatuses, whyWords } from "./checkout-cleanup.js";
import { parseCleanup } from "./storage.js";
import { lockDigest, promoteInstall } from "./shared-deps.js";

const DAY = 86_400_000;
let dir: string, file: string, repo: string, store: Store, pool: WorktreePool;
const T0 = new Date(Date.now() - 60_000);
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-cleanup-"));
  file = join(dir, "orders.db");
  repo = join(dir, "repo");
  mkdirSync(repo);
  store = openStore(file);
  register(store, { name: "builder-1", host: "test", now: T0 });
  const git = (args: string[]) => run("git", args, { cwd: repo });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "first"]);
  pool = new WorktreePool(store, { root: join(dir, "worktrees") });
});
afterEach(() => { try { store.close(); } catch { /* closed by the test */ } rmSync(dir, { recursive: true, force: true }); });

type Finish = "completed" | "ready" | "cancelled" | "queued";
/** A task whose build left a let-go checkout on `toolroll/<id>`, then finished as `finish` says. */
async function task(id: string, finish: Finish, when = T0): Promise<string> {
  store.createTask({ id, title: id }, when);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, repo);
  const leased = await pool.lease({ repo, branch: `toolroll/${id}`, base: "main", runner: "builder-1", taskRef: ref, now: when });
  if (!leased.ok) throw new Error(leased.message);
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: leased.worktree.path,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: when });
  store.finishRun(runId, { outcome: "built", now: when });
  expect((await pool.release(leased.worktree.path, when)).ok).toBe(true);
  if (finish === "completed" || finish === "ready") store.setTaskState(id, "done", when);
  if (finish === "cancelled") store.setTaskState(id, "cancelled", when);
  if (finish === "completed") store.recordAction({ at: when.toISOString(), actor: "operator:alex", repo, taskId: id, runId, action: COMPLETION_ACTION, outcome: "a".repeat(64), source: "work" });
  return leased.worktree.path;
}
const branchExists = async (branch: string) => (await run("git", ["branch", "--list", branch], { cwd: repo })).stdout.includes(branch);
const removals = () => store.actionLedger({ repos: null }).filter(one => one.action === "checkout removed");

test("a finished task's clean checkout holding only Toolroll's own progress file is removed, and one with a person's change is kept", async () => {
  const own = await task("progress-only", "completed");
  const person = await task("person-edit", "completed");
  const edited = await task("person-tracked", "completed");
  writeFileSync(join(own, "STANDING-ORDERS-PROGRESS-0123456789abcdef.json"), '{"step":"done"}\n');
  writeFileSync(join(person, "STANDING-ORDERS-PROGRESS-fedcba9876543210.json"), "{}\n");
  writeFileSync(join(person, "notes.txt"), "a person's note\n");
  writeFileSync(join(edited, "README.md"), "changed by hand\n");

  const done = await cleanCheckouts(store, pool, () => at(1000), { manual: false, actor: "worker", repo });
  expect(done.removed.map(one => one.path)).toEqual([own]);
  expect(done.kept.map(one => [one.path, one.why]).sort()).toEqual([[edited, "has changes"], [person, "has changes"]].sort());
  expect(existsSync(own)).toBe(false);
  expect(existsSync(join(person, "notes.txt"))).toBe(true);
  expect(existsSync(edited)).toBe(true);
  expect(removals()).toHaveLength(1);
  expect(removals()[0]).toMatchObject({ actor: "worker", taskId: "progress-only", source: "work", repo });
});

test("with the default setting a checkout goes when its task is complete or cancelled, and its branch stays", async () => {
  expect(store.checkoutCleanup()).toBe("finished");
  const completed = await task("shipped", "completed");
  const cancelled = await task("dropped", "cancelled");
  const ready = await task("in-review", "ready");
  const queued = await task("again", "queued");

  const plan = await checkoutPlan(store, pool, at(1000), { manual: false });
  expect(plan.go.map(one => one.path).sort()).toEqual([cancelled, completed].sort());
  expect(Object.fromEntries(plan.stay.map(one => [one.path, one.why]))).toEqual({ [ready]: "waiting for review", [queued]: "task not finished" });
  expect(plan.waitingReview).toBe(1);

  const done = await cleanCheckouts(store, pool, () => at(1000), { manual: false, actor: "worker", repo });
  expect(done.removed.map(one => one.path).sort()).toEqual([cancelled, completed].sort());
  for (const path of [completed, cancelled]) { expect(existsSync(path)).toBe(false); expect(store.getWorktree(path)).toBeNull(); }
  for (const path of [ready, queued]) expect(existsSync(path)).toBe(true);
  expect(await branchExists("toolroll/shipped")).toBe(true);
  expect(await branchExists("toolroll/dropped")).toBe(true);
  // A later lease of the branch makes a new checkout of it, as it stands.
  expect(await pool.lease({ repo, branch: "toolroll/shipped", base: "main", reuseBranch: true, runner: "builder-1", now: at(2000) })).toMatchObject({ ok: true, created: true });
});

test("after 2 days, after a week, or never: the setting delays or stops the worker's pass, never a clean-up by hand", async () => {
  expect(["finished", "2d", "week", "never", "soon"].map(parseCleanup)).toEqual(["finished", "2d", "7d", "never", undefined]);
  const path = await task("waits", "completed");
  store.setCheckoutCleanup("2d", "alex", T0);
  expect(store.actionLedger({ repos: null }).find(one => one.action === "checkout cleanup changed")).toMatchObject({ source: "policy", actor: "alex",
    detail: "when its task is complete or cancelled → 2 days after its task is complete or cancelled" });
  expect((await checkoutPlan(store, pool, at(DAY), { manual: false })).stay).toMatchObject([{ path, why: "not due yet" }]);
  expect((await cleanCheckouts(store, pool, () => at(DAY), { manual: false, actor: "worker", repo })).removed).toEqual([]);
  store.setCheckoutCleanup("never", "alex", T0);
  expect((await cleanCheckouts(store, pool, () => at(30 * DAY), { manual: false, actor: "worker", repo })).removed).toEqual([]);
  expect((await checkoutPlan(store, pool, at(DAY), { manual: true })).go.map(one => one.path)).toEqual([path]);
  store.setCheckoutCleanup("2d", "alex", T0);
  expect((await cleanCheckouts(store, pool, () => at(2 * DAY + 1000), { manual: false, actor: "worker", repo })).removed.map(one => one.path)).toEqual([path]);
});

test("a checkout with commits on no branch, one in use, and a revision's ancestors under way are kept", async () => {
  const detached = await task("detached", "completed");
  await run("git", ["checkout", "-q", "--detach"], { cwd: detached });
  writeFileSync(join(detached, "late.txt"), "committed after detaching\n");
  await run("git", ["add", "late.txt"], { cwd: detached });
  await run("git", ["commit", "-qm", "detached work"], { cwd: detached });
  const parent = await task("parent", "completed");
  await task("child", "ready");
  store.handle.prepare("UPDATE task_ref SET revision_of = 'parent' WHERE external_id = 'child'").run();
  const busy = await task("busy", "completed");
  const leased = await pool.lease({ repo, branch: "toolroll/busy", runner: "builder-1", now: at(500) });
  expect(leased.ok).toBe(true);

  const plan = await checkoutPlan(store, pool, at(1000), { manual: true });
  expect(Object.fromEntries(plan.stay.map(one => [one.path, one.why]))).toMatchObject({ [detached]: "has commits", [parent]: "waiting for review", [busy]: "in use" });
  expect(plan.go).toEqual([]);
  expect(taskStatuses(store, at(1000)).byBranch.get("toolroll/parent")?.keep).toBe("waiting for review");
});

test("a checkout no task names waits for a clean-up by hand; one whose name an unfinished task's branch would give it stays", async () => {
  const adopt = async (branch: string) => {
    const leased = await pool.lease({ repo, branch, base: "main", runner: "builder-1", now: T0 });
    if (!leased.ok) throw new Error(leased.message);
    expect((await pool.release(leased.worktree.path, T0)).ok).toBe(true);
    // Adopted after a crash: the branch unknown, no task recorded.
    store.saveWorktree({ ...store.getWorktree(leased.worktree.path)!, branch: "unknown", taskRef: null });
    return leased.worktree.path;
  };
  const orphan = await adopt("scratch/orphan");
  store.createTask({ id: "comes-back", title: "queued again" }, T0);
  store.placeTask(store.refFor("built-in", "comes-back").id, repo);
  const returning = await adopt("toolroll/comes-back");

  const auto = await checkoutPlan(store, pool, at(1000), { manual: false });
  expect(Object.fromEntries(auto.stay.map(one => [one.path, one.why]))).toEqual({ [orphan]: "no task", [returning]: "task not finished" });
  expect((await cleanCheckouts(store, pool, () => at(1000), { manual: false, actor: "worker", repo })).removed).toEqual([]);
  const manual = await cleanCheckouts(store, pool, () => at(1000), { manual: true, actor: "alex" });
  expect(manual.removed.map(one => one.path)).toEqual([orphan]);
  expect(existsSync(returning)).toBe(true);
});

test("toolroll storage clean previews without removing anything, and --yes removes and records each removal in the ledger", async () => {
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  const first = await task("one", "completed");
  const second = await task("two", "cancelled");
  const kept = await task("three", "completed");
  writeFileSync(join(kept, "draft.md"), "unfinished thought\n");
  store.setCheckoutCleanup("never", "alex", T0);
  store.close();
  // Leftover test temp folders: two nothing touched for two days, one still in use, and somebody else's.
  const temp = join(dir, "temp");
  const old = new Date(Date.now() - 2 * DAY);
  for (const name of ["so-route-cli-a1b2c3", "playwright_chromiumdev_profile-Xy12", "no-wt-fresh1", "someone-elses-folder"]) {
    mkdirSync(join(temp, name), { recursive: true });
    writeFileSync(join(temp, name, "file"), "x\n");
    if (name !== "no-wt-fresh1") { utimesSync(join(temp, name, "file"), old, old); utimesSync(join(temp, name), old, old); }
  }
  let lines: string[] = [];
  const cli = async (argv: string[]) => { lines = []; const code = await runOperate("storage", argv, line => { lines.push(line); }, { databaseFile: file, evidenceRoot: join(dir, "evidence"), tempRoots: [temp] }); return { code, out: lines.join("\n") }; };
  try {
    const preview = await cli(["clean"]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("Would remove 2 checkouts");
    expect(preview.out).toContain(first);
    expect(preview.out).toContain(second);
    expect(preview.out).toContain(`${kept}  (has changes)`);
    expect(preview.out).toContain("Nothing was removed.");
    for (const path of [first, second, kept]) expect(existsSync(path)).toBe(true);
    expect(JSON.parse((await cli(["clean", "--json"])).out)).toMatchObject({ ok: true, preview: true, go: [{}, {}], stay: [{ path: kept, why: "has changes" }] });
    expect(preview.out).toMatch(/Would remove 2 test temp folders older than a day, about \d+ KB\./);
    const summary = await cli([]);
    expect(summary.out).toContain("1 kept because they have changes");
    expect(summary.out).toContain("Test temp folders: 3; 2 older than a day: toolroll storage clean removes them.");
    expect(JSON.parse((await cli(["--json"])).out)).toMatchObject({ testTemp: { count: 3, stale: 2 } });
    expect(summary.out).toMatch(/A clean up now would free about .+ \(2 checkouts\)/);

    expect((await cli(["clean", "--yes"])).code).toBe(3);
    for (const path of [first, second]) expect(existsSync(path)).toBe(true);
    const removed = await cli(["clean", "--yes", "--as", "alex", "--token", alex.token]);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain("Removed 2 checkouts");
    for (const path of [first, second]) expect(existsSync(path)).toBe(false);
    expect(existsSync(join(kept, "draft.md"))).toBe(true);
    expect(removed.out).toMatch(/Removed 2 test temp folders older than a day/);
    expect(["so-route-cli-a1b2c3", "playwright_chromiumdev_profile-Xy12", "no-wt-fresh1", "someone-elses-folder"].map(name => existsSync(join(temp, name)))).toEqual([false, false, true, true]);

    expect((await cli(["cleanup", "7d", "--as", "alex", "--token", alex.token])).out).toContain("a week after its task is complete or cancelled");
    expect((await cli(["discard", kept])).code).toBe(2);
    expect((await cli(["discard", kept, "--yes", "--as", "alex", "--token", alex.token])).out).toContain("its branch stays");
    expect(existsSync(kept)).toBe(false);
  } finally {
    store = openStore(file);
  }
  expect(removals().map(one => [one.taskId, one.actor, one.source]).sort()).toEqual([["one", "alex", "request"], ["two", "alex", "request"]]);
  expect(store.actionLedger({ repos: null }).filter(one => one.action === "checkout discarded").map(one => one.taskId)).toEqual(["three"]);
  expect(store.actionLedger({ repos: null }).find(one => one.action === "test temp folders removed")).toMatchObject({ actor: "alex", source: "request", detail: expect.stringContaining("2 older than a day") });
  expect(store.checkoutCleanup()).toBe("7d");
  expect(await branchExists("toolroll/three")).toBe(true);
});

test("toolroll storage lists shared dependencies and how many checkouts use each; storage clean removes one no checkout uses", async () => {
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  writeFileSync(join(repo, "package.json"), '{"name":"thing"}\n');
  writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-qm", "lockfile"], { cwd: repo });
  const finished = await task("finished", "completed");
  const working = await task("working", "queued");
  const deps = join(dir, "deps");
  const install = (checkout: string) => { mkdirSync(join(checkout, "node_modules", "pad"), { recursive: true }); writeFileSync(join(checkout, "node_modules", ".package-lock.json"), "{}"); };
  // The finished task's checkout made one copy; the working one links a copy of its own key.
  install(finished);
  expect(promoteInstall({ root: deps, repo, worktree: finished, key: "1".repeat(24), lock: lockDigest(finished)!, node: "v22", setupDigest: "s", now: T0 })).toBe("link");
  install(working);
  expect(promoteInstall({ root: deps, repo, worktree: working, key: "2".repeat(24), lock: lockDigest(working)!, node: "v24", setupDigest: "s", now: T0 })).toBe("link");
  // Nothing has linked either for a while: only use keeps a copy now.
  for (const key of ["1", "2"]) utimesSync(join(deps, key.repeat(24), "ready.json"), new Date(0), new Date(0));
  store.close();
  let lines: string[] = [];
  const cli = async (argv: string[]) => { lines = []; const code = await runOperate("storage", argv, line => { lines.push(line); }, { databaseFile: file, evidenceRoot: join(dir, "evidence") }); return { code, out: lines.join("\n") }; };
  try {
    const summary = await cli([]);
    expect(summary.out).toMatch(/Shared dependencies +\S+ \S+ +\(2\)/);
    expect(summary.out).toContain("11111111: 1 checkout uses it");
    expect(summary.out).toContain("22222222: 1 checkout uses it");
    expect(JSON.parse((await cli(["--json"])).out).shared).toMatchObject([{ checkouts: 1 }, { checkouts: 1 }]);
    // The finished checkout goes, and with it the only use of the copy it linked.
    expect((await cli(["clean"])).out).toContain("Would remove 1 shared dependency install no checkout uses");
    const removed = await cli(["clean", "--yes", "--as", "alex", "--token", alex.token]);
    expect(removed.out).toContain("Removed 1 checkout");
    expect(removed.out).toContain("Removed 1 shared dependency install no checkout used");
    expect(existsSync(join(deps, "1".repeat(24)))).toBe(false);
    expect(existsSync(join(deps, "2".repeat(24), "node_modules", "pad"))).toBe(true);
    // A checkout whose lockfile a copy was installed from uses it even without the link.
    rmSync(join(working, "node_modules"), { recursive: true });
    expect((await cli(["clean"])).out).not.toContain("shared dependency");
  } finally {
    store = openStore(file);
    await run("chmod", ["-R", "u+w", deps]);
  }
  expect(store.actionLedger({ repos: null }).filter(one => one.action === "shared dependencies removed").map(one => one.detail)).toEqual([expect.stringContaining("1".repeat(24))]);
});

test("a checkout in use can't be discarded", async () => {
  const path = await task("live", "queued");
  writeFileSync(join(path, "draft.md"), "x\n");
  expect((await pool.lease({ repo, branch: "toolroll/live", runner: "builder-1", now: at(500), taskRef: store.refFor("built-in", "live").id, reclaim: { evidenceRoot: join(dir, "evidence") } })).ok).toBe(true);
  expect(await pool.discardChanges(path)).toMatchObject({ ok: false });
  expect(existsSync(path)).toBe(true);
});

test("Settings → Storage shows checkout space and what a clean-up frees; Clean up removes what the preview showed behind the password", async () => {
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  const goes = await task("gone", "completed");
  const stays = await task("edited", "completed");
  writeFileSync(join(stays, "notes.txt"), "keep\n");
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo, poolRoot: join(dir, "worktrees") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const page = await (await fetch(`${base}/settings/storage`, { headers: { cookie } })).text();
    expect(page).toContain("<h1>Storage</h1>");
    expect(page).toMatch(/Checkouts use \d/);
    expect(page).toContain("1 kept for their changes");
    expect(page).toMatch(/Cleaning up now frees about/);
    expect(page).toContain("<summary>Clean up</summary>");
    expect(page).toContain(goes);
    expect(page).toContain("Remove 1 checkout");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const preview = /name="preview" value="([0-9a-f]+)"/.exec(page)![1]!;
    const post = (path: string, fields: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
    expect((await post("/settings/storage/clean", { preview, password: "wrong" })).headers.get("location")).toContain("problem=");
    expect(existsSync(goes)).toBe(true);
    expect((await post("/settings/storage/clean", { preview: "0".repeat(32), password: alex.token })).headers.get("location")).toContain("problem=");
    expect((await post("/settings/storage/clean", { preview, password: alex.token })).headers.get("location")).toContain("said=Removed%201%20checkout");
    expect(existsSync(goes)).toBe(false);
    expect(existsSync(stays)).toBe(true);
    expect(removals()).toMatchObject([{ actor: "alex", taskId: "gone" }]);
    expect((await post("/settings/storage", { cleanup: "never", password: alex.token })).headers.get("location")).toContain("said=");
    expect(store.checkoutCleanup()).toBe("never");
    expect((await post("/settings/storage/discard", { path: stays, password: alex.token })).headers.get("location")).toContain("said=Discarded");
    expect(existsSync(stays)).toBe(false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

/** A release gate: a task whose scope names a prepared candidate commit. */
async function gate(id: string, finish: Finish, head: string, when = T0): Promise<string> {
  const path = await task(id, finish, when);
  store.handle.prepare("INSERT INTO task_scope (task_id, goal, proposed_at, digest, candidate) VALUES (?, 'Verify the release check passes.', ?, 'd', ?)").run(id, T0.toISOString(), head);
  return path;
}

test("a complete release check's checkout goes, except the one deployed now and the newest one still waiting for its deploy", async () => {
  expect(releaseOf("release-xb", new Set(["release-x", "release-xb"]))).toBe("release-x");
  expect(releaseOf("release-lean-plane", new Set(["release-lean-plane"]))).toBe("release-lean-plane");
  store.setCheckoutCleanup("7d", "alex", T0);
  const failedFirst = await gate("release-one", "queued", "sha-1a");
  const older = await gate("release-oneb", "completed", "sha-1b");
  const deployed = await gate("release-two", "completed", "sha-2a");
  const cancelled = await gate("release-three", "cancelled", "sha-3a");
  // The deploy journal beside the database names what runs now: deployed after all of those were complete.
  mkdirSync(join(dir, "staged-upgrades", "browser-2a"), { recursive: true });
  writeFileSync(join(dir, "staged-upgrades", "browser-2a", "deployment.json"), JSON.stringify({ phase: "deployed", candidate: "sha-2a", builder: 9999, deployedAt: at(500).toISOString() }));
  mkdirSync(join(dir, "staged-upgrades", "browser-1b"), { recursive: true });
  writeFileSync(join(dir, "staged-upgrades", "browser-1b", "deployment.json"), JSON.stringify({ phase: "rehearse", candidate: "sha-1b", builder: 9998 }));
  expect(deployedRelease(dir)).toEqual({ head: "sha-2a", run: 9999, at: at(500).toISOString() });
  // Complete after that deploy: the newest, which a deploy may be about to install.
  const waiting = await gate("release-four", "completed", "sha-4a", at(600));
  const waitingEarlier = await gate("release-five", "completed", "sha-5a", at(550));

  const plan = await checkoutPlan(store, pool, at(1000), { manual: false });
  expect(plan.go.map(one => one.path).sort()).toEqual([cancelled, failedFirst, older, waitingEarlier].sort());
  const stay = Object.fromEntries(plan.stay.map(one => [one.path, whyWords(one)]));
  expect(stay[deployed]).toBe("the deployed release candidate");
  expect(stay[waiting]).toMatch(/^newest release candidate, kept for its deploy until \d{4}-\d{2}-\d{2}$/);
  const done = await cleanCheckouts(store, pool, () => at(1000), { manual: false, actor: "worker", repo });
  expect(done.removed.map(one => one.path).sort()).toEqual([cancelled, failedFirst, older, waitingEarlier].sort());
  // Deployed stays past the week; the one still waiting goes after it.
  const later = await checkoutPlan(store, pool, at(8 * DAY), { manual: false });
  expect(later.go.map(one => one.path)).toEqual([waiting]);
  expect(later.stay.map(one => one.path)).toEqual([deployed]);
  // Once it is deployed, the one deployed before it goes.
  writeFileSync(join(dir, "staged-upgrades", "browser-1b", "deployment.json"), JSON.stringify({ phase: "deployed", candidate: "sha-4a", builder: 9998, deployedAt: at(900).toISOString() }));
  const after = await checkoutPlan(store, pool, at(1000), { manual: false });
  expect(after.go.map(one => one.path)).toEqual([deployed]);
  expect(after.stay.map(one => [one.path, whyWords(one)])).toEqual([[waiting, "the deployed release candidate"]]);
});

test("a kept checkout drops its dependencies and build output once its run ends; the next run's setup restores them", async () => {
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\n");
  await run("git", ["add", ".gitignore"], { cwd: repo });
  await run("git", ["commit", "-qm", "ignore build output"], { cwd: repo });
  const review = await task("in-review", "ready");
  const changed = await task("hand-edited", "completed");
  const shipped = await task("shipped", "completed");
  const unfinished = await task("unfinished", "queued");
  const candidate = await gate("release-four", "completed", "sha-4a");
  for (const path of [review, changed, shipped, unfinished, candidate]) {
    mkdirSync(join(path, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(path, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    mkdirSync(join(path, "dist"));
    writeFileSync(join(path, "dist", "app.js"), "built\n");
    store.stampWorktreeSetup(path, "setup-1");
  }
  writeFileSync(join(changed, "notes.md"), "a person's change\n");
  store.setCheckoutCleanup("never", "alex", T0);
  store.setWorktreeSetup({ repo, command: "npm ci", timeoutMs: 600_000, approvedBy: "alex" }, T0);

  const done = await slimKeptCheckouts(store, pool, () => at(1000), { actor: "worker", repo });
  expect(done.slimmed.map(one => one.path).sort()).toEqual([changed, review].sort());
  for (const path of [review, changed]) {
    expect(existsSync(join(path, "node_modules"))).toBe(false);
    expect(existsSync(join(path, "dist"))).toBe(false);
    expect(existsSync(join(path, "README.md"))).toBe(true);
    // No setup stamp: the next lease runs the project's setup again.
    expect(store.getWorktree(path)?.setupDigest).toBeNull();
  }
  expect(existsSync(join(changed, "notes.md"))).toBe(true);
  // A clean finished checkout (cleanup removes it whole), an unfinished task's and a release candidate's stay as they are.
  for (const path of [shipped, unfinished, candidate]) {
    expect(existsSync(join(path, "node_modules", "left-pad", "index.js"))).toBe(true);
    expect(store.getWorktree(path)?.setupDigest).toBe("setup-1");
  }
  const entries = store.actionLedger({ repos: null }).filter(one => one.action === "checkout slimmed");
  expect(entries.map(one => one.taskId).sort()).toEqual(["hand-edited", "in-review"]);
  expect(entries[0]!.detail).toMatch(/dropped (dist, node_modules|node_modules, dist).*the next run's setup restores them/);
  // Once per let-go.
  expect((await slimKeptCheckouts(store, pool, () => at(2000), { actor: "worker", repo })).slimmed).toEqual([]);
});

test("without a setup to restore them, a kept checkout keeps its dependencies and drops only build output", async () => {
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\n");
  await run("git", ["add", ".gitignore"], { cwd: repo });
  await run("git", ["commit", "-qm", "ignore build output"], { cwd: repo });
  const review = await task("no-setup", "ready");
  mkdirSync(join(review, "node_modules"));
  writeFileSync(join(review, "node_modules", "x.js"), "1\n");
  mkdirSync(join(review, "dist"));
  writeFileSync(join(review, "dist", "x.js"), "1\n");
  expect((await slimKeptCheckouts(store, pool, () => at(1000), { actor: "worker", repo })).slimmed).toMatchObject([{ path: review, dropped: ["dist"] }]);
  expect(existsSync(join(review, "node_modules", "x.js"))).toBe(true);
  expect(existsSync(join(review, "dist"))).toBe(false);
});
