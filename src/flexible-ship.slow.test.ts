/**
 * Ship for Flexible threads (flexible-ship.ts, the Flexible plan v2 §7), with the build's constant replaced (vi.mock),
 * against real git repositories and a scripted GitHub (never the network): Send for checks is its own exact-terms
 * approval (`flexible-ship`) bound through the approval summary's key, so a stale press refuses; it imports, files and
 * seals the verify-only task in order, or leaves an imported branch with no task that can be removed; Complete and
 * merge needs a green check on the exact head and arms a merge that a moved head cancels for good; no other road merges
 * a Flexible result; Send back reopens the thread and the next send is n+1.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareFlexibleThread, type FlexibleThreadPaths, type FlexibleThreadRow } from "./flexible-thread.js";
import { completeAndMergeFlexible, flexibleShipsOf, flexibleShipTaskId, flexibleShipTerms, HISTORY_WORDS, mergeArmedFlexible, removeFlexibleImport, sendBackFlexible, sendFlexibleForChecks } from "./flexible-ship.js";
import { flexibleImportRef } from "./flexible-import.js";
import { enableFlexible, proposedFlexibleTerms } from "./flexible.js";
import { addApprover, approvalOf, APPROVAL_PROOF } from "./scope.js";
import { allowWhereUnfenced } from "./unfenced-test-support.js";
import { register } from "./runner.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { assignmentOf } from "./assignment.js";
import { recordRunCheckLevel } from "./check-levels.js";
import { publishPass, type PublishExec } from "./publish.js";
import { mergePullRequest, savePublishing } from "./pull-request-flow.js";
import { taskBranch } from "./names.js";
import type { Store } from "./store.js";
import { tgit, threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";

vi.mock("./flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));

const NOW = new Date("2026-11-15T12:00:00.000Z");
let world: ThreadWorld, store: Store, token: string, samToken: string, root: string;
let thread: FlexibleThreadRow, paths: FlexibleThreadPaths;

beforeEach(async () => {
  world = threadWorld();
  store = allowWhereUnfenced(world.store);
  root = join(world.dir, "evidence");
  mkdirSync(root);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  token = alex.token; samToken = sam.token;
  register(store, { name: "worker-1", host: "test", capacity: 4, repos: [world.project], now: NOW, newToken: () => "tok-worker-1" });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", NOW);
  store.setVerifyCommand({ repo: world.project, command: "test -f README.md", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
  const proposed = proposedFlexibleTerms(store, world.project, "alex");
  if (!proposed.ok) throw new Error(proposed.message);
  const on = enableFlexible(store, { repo: world.project, by: "alex", proof: "password-now", shownDigest: proposed.digest, now: NOW });
  if (!on.ok) throw new Error(on.message);
  const made = await prepareFlexibleThread(store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  ({ thread, paths } = made);
});
afterEach(() => { store.close(); rmSync(world.dir, { recursive: true, force: true }); });

function commit(files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(paths.repo, name, ".."), { recursive: true });
    writeFileSync(join(paths.repo, name), text);
    tgit(paths.repo, "add", "-f", "--", name);
  }
  tgit(paths.repo, "commit", "-qm", "thread work");
  return tgit(paths.repo, "rev-parse", "HEAD");
}
const projectRefs = () => tgit(world.project, "for-each-ref", "--format=%(refname) %(objectname)");
const sends = () => store.handle.prepare("SELECT seq, state, reason, task_id FROM flexible_ship ORDER BY seq").all().map(row => ({ ...row }));
async function terms(by = "alex") {
  const shown = await flexibleShipTerms(store, { thread: thread.id, by });
  if (!shown.ok) throw new Error(shown.message);
  return shown;
}
const send = (shown: { digest: string; summary: { key: string } }, as: { by?: string; token?: string } = {}) =>
  sendFlexibleForChecks(store, { thread: thread.id, by: as.by ?? "alex", token: as.token ?? token, shownDigest: shown.digest, shownKey: shown.summary.key, now: NOW });

describe("Send for checks", () => {
  test("the person's yes to exactly the terms shown: imported, then the verify-only task filed and sealed under flexible-ship", async () => {
    const candidate = commit({ "src/feature.js": "export const feature = 1;\n" });
    const shown = await terms();
    expect(shown.terms).toMatchObject({ kind: "flexible-ship", seq: 1, base: world.second, candidate, changedPaths: ["src/feature.js"], check: { command: "test -f README.md" }, history: "beyond-base",
      outOfScope: "Verify the imported candidate only. Further code changes need a new send." });
    // The disclosure is shown before consent, never folded, and is part of what the key binds.
    expect(shown.summary.warnings.map(one => one.words)).toContain(HISTORY_WORDS);
    expect(shown.summary.decisions.map(row => row.label)).toEqual(["Task", "Sends", "Starts from", "Goal", "Done when", "Checks", "After the checks"]);
    const sent = await send(shown);
    expect(sent).toMatchObject({ ok: true, ship: shown.digest, seq: 1, taskId: flexibleShipTaskId(shown.digest), importRef: flexibleImportRef(thread.id, 1) });
    if (!sent.ok) return;
    expect(sends()).toEqual([{ seq: 1, state: "sent", reason: null, task_id: sent.taskId }]);
    // The task: filed as this send's (immutable provenance), its scope the imported candidate, sealed by this person.
    expect(store.filedViaOf(sent.taskId)).toBe(`flexible:${shown.digest}`);
    const scope = store.getScope(sent.taskId)!;
    expect(scope).toMatchObject({ candidate, outOfScope: shown.terms.outOfScope, approvedBy: "alex" });
    expect(approvalOf(scope)).toMatchObject({ approved: true, by: "alex" });
    expect(store.handle.prepare("SELECT outcome FROM action_ledger WHERE task_id = ? AND action = ?").all(sent.taskId, APPROVAL_PROOF).map(row => row["outcome"])).toEqual(["password-now"]);
    // Its branch starts at the thread's base; the import and the thread's branch hold the candidate; the default branch didn't move.
    expect(tgit(world.project, "rev-parse", `refs/heads/${taskBranch(sent.taskId)}`)).toBe(world.second);
    expect(tgit(world.project, "rev-parse", `refs/heads/toolroll/code-${thread.id}`)).toBe(candidate);
    expect(tgit(world.project, "rev-parse", "refs/heads/main")).toBe(world.second);
    expect(store.handle.prepare("SELECT action, outcome FROM action_ledger WHERE action LIKE 'flexible ship%' OR action = 'flexible import' ORDER BY id").all().map(row => ({ ...row })))
      .toEqual([{ action: "flexible ship approved", outcome: "flexible-ship" }, { action: "flexible import", outcome: "imported" }, { action: "flexible ship sent", outcome: "flexible-ship" }]);
  });

  test("a stale press refuses and writes nothing: another key, terms from before a new commit, or the same terms pressed twice", async () => {
    commit({ "a.txt": "one\n" });
    const shown = await terms();
    const before = projectRefs();
    expect(await sendFlexibleForChecks(store, { thread: thread.id, by: "alex", token, shownDigest: shown.digest, shownKey: "0".repeat(32), now: NOW })).toMatchObject({ ok: false, reason: "changed" });
    expect(await sendFlexibleForChecks(store, { thread: thread.id, by: "alex", token, shownDigest: "0".repeat(32), shownKey: shown.summary.key, now: NOW })).toMatchObject({ ok: false, reason: "changed" });
    commit({ "a.txt": "two\n" });
    expect(await send(shown)).toMatchObject({ ok: false, reason: "changed" });
    // Different words for the task are different terms too.
    const fresh = await terms();
    expect(await sendFlexibleForChecks(store, { thread: thread.id, by: "alex", token, shownDigest: fresh.digest, shownKey: fresh.summary.key, text: { title: "Another title" }, now: NOW })).toMatchObject({ ok: false, reason: "changed" });
    expect(sends()).toEqual([]);
    expect(projectRefs()).toBe(before);
    expect(await send(fresh)).toMatchObject({ ok: true });
    expect(await send(fresh)).toMatchObject({ ok: false, reason: "changed" });
    expect(sends()).toHaveLength(1);
  });

  test("only the thread's owner, with their password typed now: an empty or wrong password, or another approver, sends nothing", async () => {
    commit({ "a.txt": "one\n" });
    const shown = await terms();
    expect(await send(shown, { token: "" })).toMatchObject({ ok: false, reason: "password-now" });
    expect(await send(shown, { token: "not-the-password" })).toMatchObject({ ok: false, reason: "not-an-approver" });
    expect(await send(shown, { by: "sam", token: samToken })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(await flexibleShipTerms(store, { thread: thread.id, by: "sam" })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(sends()).toEqual([]);
  });

  test("a project with no check command can't ship, and an import the quarantine refuses ends the send refused, with no task", async () => {
    commit({ ".envrc": "echo hi\n" });
    const shown = await terms();
    const before = projectRefs();
    expect(await send(shown)).toMatchObject({ ok: false, reason: "import-refused", check: "protected" });
    expect(sends()).toEqual([{ seq: 1, state: "refused", reason: "protected", task_id: null }]);
    expect(projectRefs()).toBe(before);
    store.clearVerifyCommand(world.project, "alex", NOW);
    expect(await flexibleShipTerms(store, { thread: thread.id, by: "alex" })).toMatchObject({ ok: false, reason: "no-check" });
  });

  test("a failure after the import leaves an imported branch with no task: shown, removable, and the next send works", async () => {
    const first = commit({ "a.txt": "one\n" });
    const shown = await terms();
    store.createTask({ id: flexibleShipTaskId(shown.digest), title: "in the way" }, NOW);
    expect(await send(shown)).toMatchObject({ ok: false, reason: "handoff-failed" });
    const listed = flexibleShipsOf(store, thread.id);
    expect(listed.ok && listed.sends.map(one => ({ seq: one.seq, state: one.state, taskId: one.taskId, detail: one.detail }))).toEqual([{ seq: 1, state: "imported", taskId: null, detail: expect.stringContaining("already exists") }]);
    expect(tgit(world.project, "rev-parse", `refs/heads/toolroll/code-${thread.id}`)).toBe(first);
    expect(await removeFlexibleImport(store, { ship: shown.digest, by: { name: "sam", generation: store.accountOf("sam")!.generation }, now: NOW })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(await removeFlexibleImport(store, { ship: shown.digest, by: { name: "alex", generation: store.accountOf("alex")!.generation }, now: NOW })).toEqual({ ok: true });
    expect(projectRefs()).not.toMatch(/toolroll\/code-|refs\/toolroll\/import\//);
    expect(sends()).toEqual([{ seq: 1, state: "removed", reason: null, task_id: null }]);
    const again = await terms();
    expect(again.terms.seq).toBe(2);
    expect(await send(again)).toMatchObject({ ok: true, seq: 2, importRef: flexibleImportRef(thread.id, 2) });
  });

  test("an approval refused at the seal files nothing: the task, its scope and its branch all roll back, the import stays", async () => {
    commit({ "a.txt": "one\n" });
    const shown = await terms();
    // The organisation now allows only another provider: the ordinary approve() checks refuse this task's terms.
    store.setOrgPolicy({ providers: ["codex"], models: null, tools: null, ceiling: "escalated" }, "alex", NOW);
    const refused = await send(shown);
    expect(refused).toMatchObject({ ok: false });
    expect(["approval-refused", "handoff-failed"]).toContain(refused.ok === false ? refused.reason : "");
    expect(store.lookupRef(flexibleShipTaskId(shown.digest))).toBeNull();
    expect(projectRefs()).not.toContain(taskBranch(flexibleShipTaskId(shown.digest)));
    expect(sends()).toEqual([{ seq: 1, state: "imported", reason: null, task_id: null }]);
  });
});

describe("Complete and merge, and send back", () => {
  const rollup = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/alex/shop/actions/runs/1/job/1" }];
  /** A scripted gh: the PR opens, reads open on `head` until merged, then merged. */
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
      if (line.startsWith("gh pr view")) return ok(JSON.stringify({ state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: head, statusCheckRollup: rollup, mergeCommit: merged ? { oid: "c".repeat(40) } : null }));
      return ok();
    };
    return { exec, calls };
  }
  /** A finished run of the send's task at `head` with its check `status`, and its exact receipt. */
  function built(taskId: string, head: string, status: "passed" | "failed" = "passed"): { runId: number; digest: string } {
    const ref = store.lookupRef(taskId)!.id;
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    const runId = store.startRun({ taskRef: ref, leaseId: `l-${taskId}-${head.slice(0, 6)}`, runner: "worker-1", branch: taskBranch(taskId), worktree: `/pool/${taskId}`, route: authority.stamp, now: NOW });
    store.stampRun(runId, { scopeDigest: store.getScope(taskId)!.digest, baseRevision: world.second });
    store.recordOutcomeFacts(runId, { headRevision: head, handoff: "Installed the imported candidate and checked it." });
    store.finishRun(runId, { outcome: "built", committed: true, now: NOW });
    store.setTaskState(taskId, "done", NOW);
    store.saveProofVerdict(runId, "verified", [], NOW, [{ id: "c1", statement: "The project's checks pass on this exact commit.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }] as never, "verified");
    storeEvidence(store, root, runId, "terminal-diff", "diff.patch", Buffer.from("--- a/a.txt\n+++ b/a.txt\n"), "git diff (exit 0)", NOW, { captureStatus: "ok" });
    storeEvidence(store, root, runId, "check-log", "checks.txt", Buffer.from("ok"), "test -f README.md", NOW, { captureStatus: "ok" });
    sealVerificationReceipt(store, root, runId, head, store.liveVerifyCommand(world.project)!, { configured: true, ran: true, exitCode: status === "passed" ? 0 : 1 }, NOW);
    recordRunCheckLevel(store, { id: runId, taskId, repo: world.project }, "full", "project", NOW);
    store.recordRunCheck(runId, { status, exitCode: status === "passed" ? 0 : 1, suites: [] }, NOW);
    const receipt = assignmentOf(store, taskId, NOW, { principal: "operator", repos: [world.project] }, root)?.receipt;
    return { runId, digest: receipt?.digest ?? "0".repeat(64) };
  }
  async function sentOne(files: Record<string, string> = { "a.txt": "one\n" }) {
    const candidate = commit(files);
    const sent = await send(await terms());
    if (!sent.ok) throw new Error(sent.message);
    return { candidate, taskId: sent.taskId, ship: sent.ship };
  }
  beforeEach(() => {
    savePublishing(store, { repo: world.project, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", { mergeMethod: "squash", mergeWhenGreen: true }, NOW);
  });
  const complete = (taskId: string, run: { runId: number; digest: string }, head: string, as: { token?: string } = {}) =>
    completeAndMergeFlexible(store, { taskId, runId: run.runId, digest: run.digest, head, by: "alex", token: as.token ?? token, root, now: NOW });
  const state = (ship: string) => store.handle.prepare("SELECT state FROM flexible_ship WHERE id = ?").get(ship)?.["state"];

  test("only on a green check for the exact head: a red check, another head, or files that aren't the candidate's arm nothing", async () => {
    const { candidate, taskId, ship } = await sentOne();
    const red = built(taskId, candidate, "failed");
    expect(await complete(taskId, red, candidate)).toMatchObject({ ok: false, reason: "check-not-green" });
    const other = built(taskId, world.first);
    expect(await complete(taskId, other, world.first)).toMatchObject({ ok: false, reason: "head-changed" });
    const green = built(taskId, candidate);
    expect(await complete(taskId, green, world.first)).toMatchObject({ ok: false, reason: "head-changed" });
    // Another commit with exactly the candidate's files is still not the head that was checked.
    const twin = tgit(world.project, "commit-tree", `${candidate}^{tree}`, "-p", world.second, "-m", "same files, another commit");
    expect(await complete(taskId, green, twin)).toMatchObject({ ok: false, reason: "head-changed" });
    expect(await complete(taskId, red, candidate)).toMatchObject({ ok: false, reason: "head-changed" }); // no longer the newest run
    expect(await complete(taskId, green, candidate, { token: "" })).toMatchObject({ ok: false, reason: "password-now" });
    expect(state(ship)).toBe("sent");
    expect(store.pendingPublications()).toEqual([]);
  });

  test("green: completes, opens the pull request and arms one merge of that head, which merges only through the send's authority", async () => {
    const { candidate, taskId, ship } = await sentOne();
    const run = built(taskId, candidate);
    const armed = await complete(taskId, run, candidate);
    expect(armed).toMatchObject({ ok: true, ship });
    expect(state(ship)).toBe("merge-armed");
    const gh = github(candidate);
    await publishPass(store, { repo: world.project, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    // No other road merges it: not `anyway`, not a plain merge, not merge-when-green.
    expect(await mergePullRequest(store, { runId: run.runId, by: "alex", anyway: true, exec: gh.exec, clock: () => NOW })).toMatchObject({ ok: false, reason: "flexible" });
    expect(await mergePullRequest(store, { runId: run.runId, by: "merge when checks pass", exec: gh.exec, clock: () => NOW })).toMatchObject({ ok: false, reason: "flexible" });
    expect(await mergePullRequest(store, { runId: run.runId, by: "alex", flexibleShip: "f".repeat(32), exec: gh.exec, clock: () => NOW })).toMatchObject({ ok: false, reason: "flexible" });
    expect(gh.calls.filter(line => line.startsWith("gh pr merge"))).toEqual([]);
    expect(await mergeArmedFlexible(store, { taskId, exec: gh.exec, clock: () => NOW })).toEqual({ ok: true, commit: "c".repeat(40) });
    expect(gh.calls.filter(line => line.startsWith("gh pr merge"))).toEqual([`gh pr merge 7 --repo alex/shop --squash --match-head-commit ${candidate} --delete-branch`]);
    expect(state(ship)).toBe("merged");
    expect(store.handle.prepare("SELECT action FROM action_ledger WHERE task_id = ? AND action LIKE 'flexible%' ORDER BY id").all(taskId).map(row => row["action"]))
      .toEqual(["flexible ship sent", "flexible complete and merge", "flexible merged"]);
  });

  test("a head that moved after Complete and merge cancels the armed merge for good", async () => {
    const { candidate, taskId, ship } = await sentOne();
    const run = built(taskId, candidate);
    expect(await complete(taskId, run, candidate)).toMatchObject({ ok: true });
    built(taskId, world.first);
    const gh = github(candidate);
    expect(await mergeArmedFlexible(store, { taskId, exec: gh.exec, clock: () => NOW })).toMatchObject({ ok: false, reason: "head-changed" });
    expect(state(ship)).toBe("cancelled");
    expect(await mergeArmedFlexible(store, { taskId, exec: gh.exec, clock: () => NOW })).toMatchObject({ ok: false, reason: "wrong-state" });
    expect(gh.calls.filter(line => line.startsWith("gh pr merge"))).toEqual([]);
  });

  test("send back reopens the thread with the feedback; the next send is a new import, n+1, from exactly the last one", async () => {
    const first = await sentOne();
    expect(sendBackFlexible(store, { taskId: first.taskId, by: { name: "sam", generation: store.accountOf("sam")!.generation }, feedback: "Rename it.", now: NOW })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(sendBackFlexible(store, { taskId: first.taskId, by: { name: "alex", generation: store.accountOf("alex")!.generation }, feedback: "Rename the helper, please.", now: NOW }))
      .toEqual({ ok: true, thread: thread.id, feedback: "Rename the helper, please." });
    expect(state(first.ship)).toBe("sent-back");
    expect(store.getTask(first.taskId)?.state).toBe("cancelled");
    const run = built(first.taskId, first.candidate);
    expect(await complete(first.taskId, run, first.candidate)).toMatchObject({ ok: false, reason: "wrong-state" });
    const second = commit({ "a.txt": "renamed\n" });
    const shown = await terms();
    expect(shown.terms).toMatchObject({ seq: 2, importRef: flexibleImportRef(thread.id, 2), candidate: second });
    const sent = await send(shown);
    expect(sent).toMatchObject({ ok: true, seq: 2 });
    expect(tgit(world.project, "rev-parse", `refs/heads/toolroll/code-${thread.id}`)).toBe(second);
    expect(tgit(world.project, "rev-parse", flexibleImportRef(thread.id, 1))).toBe(first.candidate);
    expect(sends().map(row => [row["seq"], row["state"]])).toEqual([[1, "sent-back"], [2, "sent"]]);
  });
});
