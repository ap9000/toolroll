/**
 * The laptop Ship road end to end (the owner's D1; Codex review of the build, round 1, finding 6), over the real console
 * with the workbench's own local-owner session: the terms, the one-key press, the sealed check task dispatched to a
 * worker (the real acquire, which reads the local seal), its check on the exact candidate, the armed completion and the
 * merge's reservation, with a scripted GitHub (never the network) and a stand-in check command. And the install
 * stopping being one where nobody has a password part way: during the armed pass's asynchronous read (the cancellation
 * is committed: a fresh read finds it cancelled and nothing merges), and between completion and the merge's
 * reservation (refused there, cancelled for good). Never a real model or agent.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { tgit } from "../flexible-thread-world.js";
import { prepareFlexibleThread } from "../../src/flexible-thread.js";
import { mergeArmedFlexible } from "../../src/flexible-ship.js";
import { enableFlexible, proposedFlexibleTerms } from "../../src/flexible.js";
import { setFlexibleSetting } from "../../src/flexible-available.js";
import { hashPassword } from "../../src/scope.js";
import { register } from "../../src/runner.js";
import { acquireIfReady, release } from "../../src/claim.js";
import { savePublishing } from "../../src/pull-request-flow.js";
import { publishPass, type PublishExec } from "../../src/publish.js";
import { storeEvidence } from "../../src/evidence.js";
import { sealVerificationReceipt } from "../../src/verification-evidence.js";
import { recordRunCheckLevel } from "../../src/check-levels.js";
import { taskBranch } from "../../src/names.js";
import { run } from "../../src/exec.js";
import { allowWhereUnfenced } from "../../src/unfenced-test-support.js";
import type { Runner } from "../../src/worktree.js";

const NOW = new Date();
let world: LocalWorld, root: string, threadId: string, repo: string;

beforeEach(async () => {
  world = await openLocalWorld();
  const store = allowWhereUnfenced(world.store);
  root = join(world.root, "evidence");
  mkdirSync(root, { recursive: true });
  store.upsertProject(world.repo, "shop", NOW);
  register(store, { name: "worker-1", host: "test", capacity: 4, repos: [world.repo], now: NOW, newToken: () => "tok-worker-1" });
  // A stand-in check command, and a publication grant to a scripted GitHub.
  store.setVerifyCommand({ repo: world.repo, command: "test -f README.md", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
  savePublishing(store, { repo: world.repo, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", { mergeMethod: "squash", mergeWhenGreen: true }, NOW);
  setFlexibleSetting(store, true, "alex", NOW);
  const proposed = proposedFlexibleTerms(store, world.repo, "alex");
  if (!proposed.ok) throw new Error(proposed.message);
  const on = enableFlexible(store, { repo: world.repo, by: "alex", proof: "password-now", shownDigest: proposed.digest, now: NOW });
  if (!on.ok) throw new Error(on.message);
  tgit(world.repo, "branch", "-M", "main");
  const made = await prepareFlexibleThread(store, { repo: world.repo, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  threadId = made.thread.id;
  repo = made.paths.repo;
}, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

const ships = () => world.store.handle.prepare("SELECT state, proof, task_id, detail FROM flexible_ship ORDER BY seq").all().map(row => ({ ...row }));
function commit(): string {
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "feature.js"), "export const feature = 1;\n");
  tgit(repo, "add", "-f", "--", "src/feature.js");
  tgit(repo, "commit", "-qm", "thread work");
  return tgit(repo, "rev-parse", "HEAD");
}
/** A scripted gh: the pull request opens as #7 and reads open on `head` until merged, then merged. */
function github(head: string) {
  let merged = false;
  const calls: string[] = [];
  const exec: PublishExec = async (file, args) => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false, notFound: false });
    if (line.startsWith("gh pr list")) return ok("[]");
    if (line.startsWith("gh pr create")) return ok("https://github.com/alex/shop/pull/7\n");
    if (line.startsWith("gh pr merge")) { merged = true; return ok(); }
    if (line.startsWith("gh pr view")) return ok(JSON.stringify({ state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: head, baseRefName: "main",
      statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/alex/shop/actions/runs/1/job/1" }],
      mergeCommit: merged ? { oid: "c".repeat(40) } : null, url: "https://github.com/alex/shop/pull/7" }));
    if (line.startsWith("gh api")) return { code: 1, stdout: "", stderr: "HTTP 404", timedOut: false, notFound: false };
    return ok();
  };
  return { exec, merges: () => calls.filter(one => one.startsWith("gh pr merge")) };
}
/** The press from the workbench: its terms read, then the one key, over the console with the local owner's session. */
async function pressFromWorkbench(): Promise<string> {
  const { cookie, csrf } = await world.localSession();
  const post = (fields: Record<string, string>) => world.send(`/agents/live/thread/${threadId}/ship`, "POST", { cookie, origin: world.origin,
    "content-type": "application/x-www-form-urlencoded", "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" }, new URLSearchParams({ csrf, ...fields }).toString());
  const shown = JSON.parse((await post({})).body) as { outcome: string; key: string; digest: string; laptop: boolean };
  expect(shown).toMatchObject({ outcome: "ship-terms", laptop: true });
  const pressed = await post({ terms: shown.key, digest: shown.digest });
  expect(JSON.parse(pressed.body)).toMatchObject({ outcome: "done", words: expect.stringMatching(/^Shipping: checks run on commit/) });
  const task = String(ships()[0]?.["task_id"]);
  expect(ships()).toEqual([expect.objectContaining({ state: "armed", proof: "local-owner" })]);
  return task;
}
/** The worker takes the check task through the real dispatch (its local seal read by acquire), and it is built at `head`
 * with the stand-in check passed on that exact commit. */
function dispatchedAndChecked(taskId: string, head: string): void {
  const store = world.store;
  const ref = store.lookupRef(taskId)!;
  const claimed = acquireIfReady(store, ref.id, "worker-1", { token: "tok-worker-1", now: NOW });
  expect(claimed).toMatchObject({ ok: true });
  if (!claimed.ok) return;
  release(store, claimed.claim.leaseId, NOW);
  const authority = store.routeAuthorityFor(ref.id, "builder");
  if (!authority?.ok) throw new Error("route");
  const runId = store.startRun({ taskRef: ref.id, leaseId: `l-${taskId}`, runner: "worker-1", branch: taskBranch(taskId), worktree: `/pool/${taskId}`, route: authority.stamp, now: NOW });
  store.stampRun(runId, { scopeDigest: store.getScope(taskId)!.digest, baseRevision: tgit(world.repo, "rev-parse", "main") });
  store.recordOutcomeFacts(runId, { headRevision: head, handoff: "Installed the imported candidate and checked it." });
  store.finishRun(runId, { outcome: "built", committed: true, now: NOW });
  store.setTaskState(taskId, "done", NOW);
  store.saveProofVerdict(runId, "verified", [], NOW, [{ id: "c1", statement: "The project's checks pass on this exact commit.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }] as never, "verified");
  storeEvidence(store, root, runId, "terminal-diff", "diff.patch", Buffer.from("--- a/src/feature.js\n+++ b/src/feature.js\n"), "git diff (exit 0)", NOW, { captureStatus: "ok" });
  storeEvidence(store, root, runId, "check-log", "checks.txt", Buffer.from("ok"), "test -f README.md", NOW, { captureStatus: "ok" });
  sealVerificationReceipt(store, root, runId, head, store.liveVerifyCommand(world.repo)!, { configured: true, ran: true, exitCode: 0 }, NOW);
  recordRunCheckLevel(store, { id: runId, taskId, repo: world.repo }, "full", "project", NOW);
  store.recordRunCheck(runId, { status: "passed", exitCode: 0, suites: [] }, NOW);
}
const step = (taskId: string, exec: PublishExec, runner?: Runner) => mergeArmedFlexible(world.store, { taskId, root, clock: () => NOW, exec, ...(runner === undefined ? {} : { runner }) });
const anotherWithPassword = () => { world.store.saveApprover("bob", hashPassword("bob-password-333"), NOW); };

describe("the laptop road, from the workbench to the merge", () => {
  test("pressed with one key, dispatched, checked on the exact candidate, completed and merged", async () => {
    const candidate = commit();
    const taskId = await pressFromWorkbench();
    dispatchedAndChecked(taskId, candidate);
    const gh = github(candidate);
    expect(await step(taskId, gh.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(world.store, { repo: world.repo, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    expect(await step(taskId, gh.exec)).toMatchObject({ ok: true, state: "merged" });
    expect(gh.merges()).toEqual([`gh pr merge 7 --repo alex/shop --squash --match-head-commit ${candidate} --delete-branch`]);
  });

  test("the install gains a password during the armed pass's own read: the cancellation is committed, and nothing merges", async () => {
    const candidate = commit();
    const taskId = await pressFromWorkbench();
    dispatchedAndChecked(taskId, candidate);
    const gh = github(candidate);
    // The armed pass reads the base asynchronously (merge-base) between its first look and the transaction that
    // completes: the install changes right there.
    let changed = false;
    const runner: Runner = async (file, args, options) => {
      if (!changed && args.includes("merge-base")) { changed = true; anotherWithPassword(); }
      return run(file, args, options);
    };
    expect(await step(taskId, gh.exec, runner)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(changed).toBe(true);
    // A fresh read: cancelled for good, with why, and a later pass can't complete or merge it.
    expect(world.store.handle.prepare("SELECT state, detail FROM flexible_ship").get()).toMatchObject({ state: "cancelled", detail: expect.stringMatching(/without a password/) });
    expect(await step(taskId, gh.exec)).toMatchObject({ ok: false, reason: "wrong-state" });
    expect(gh.merges()).toEqual([]);
  });

  test("the install gains a password after completion: the merge's reservation refuses it and cancels it for good", async () => {
    const candidate = commit();
    const taskId = await pressFromWorkbench();
    dispatchedAndChecked(taskId, candidate);
    const gh = github(candidate);
    expect(await step(taskId, gh.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(world.store, { repo: world.repo, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    anotherWithPassword();
    expect(await step(taskId, gh.exec)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(world.store.handle.prepare("SELECT state FROM flexible_ship").get()?.["state"]).toBe("cancelled");
    expect(gh.merges()).toEqual([]);
  });
});
