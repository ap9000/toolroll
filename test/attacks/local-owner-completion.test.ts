/**
 * Local-owner slice 0 (docs/plans/local-owner-acts.md, Codex finding b): a laptop's local owner (no password) completes
 * and accepts ordinary results only. On every road that completes — the browser's plain completion, Accept and finish,
 * Complete and open a pull request, and chat's Accept card — a release result, protected work (declared in its scope,
 * or only actually changed by the build) and a coordinator's filing are refused, and the refusal leaves the result's
 * acceptance, completion, publication, approval and the task's state exactly as they were. The local owner never opens
 * a pull request; a person outside the local owner's chain still can. An ordinary result is still completed.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openLocalWorld, type LocalWorld } from "../local-owner-world.js";
import { propose } from "../../src/scope.js";
import { storeEvidence } from "../../src/evidence.js";
import { sealVerificationReceipt } from "../../src/verification-evidence.js";
import { verifyApproverStanding, type VerifiedApprover } from "../../src/principal.js";
import { acceptAndCompleteAsOperator, assignmentOf, checkAssignmentAsOperator } from "../../src/assignment.js";
import { register } from "../../src/runner.js";
import { COMPLETION_ACTION } from "../../src/result-completion.js";
import { completeAndOpenPullRequest, savePublishing } from "../../src/pull-request-flow.js";
import { prepareSharedAction, mintSharedActionReview, type ChatAction } from "../../src/chat-actions.js";
import { confirmLeadProposal } from "../../src/lead-doors.js";
import { asLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "../../src/local-owner.js";
import type { ReleaseCheckPurpose } from "../../src/contracts/release-terms.js";

const T0 = new Date("2026-11-03T12:00:00.000Z");
const HEAD = "a".repeat(40);
let world: LocalWorld, serial = 0;
const evidence = () => `${world.root}/evidence`;

beforeEach(async () => {
  world = await openLocalWorld();
  world.store.setVerifyCommand({ repo: world.repo, command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, T0);
  register(world.store, { name: "worker-1", host: "test", capacity: 4, repos: [world.repo], now: T0, newToken: () => "tok-worker-1" });
  // Pull requests set up for the project, so "Complete and open a pull request" would otherwise go through.
  // A second approver, whose earlier yes is the other pair of eyes on protected work.
  // (Written straight in: on a laptop nobody vouches for another approver without a password.)
  world.store.handle.prepare("INSERT INTO approver (name, credential_hash, added_at) VALUES ('robin', 'x', ?)").run(T0.toISOString());
  savePublishing(world.store, { repo: world.repo, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", {}, T0);
});
afterEach(async () => { await world.close(); });

type Kind = "ordinary" | "release" | "declared-protected" | "changed-protected" | "coordinator";
/** A finished, checked result on its own branch, Ready, with its exact receipt: the kind of work it is decides the rest. */
function ready(kind: Kind): { id: string; runId: number; digest: string } {
  const store = world.store, id = `result-${++serial}`;
  store.createTask({ id, title: "Fix the checkout total" }, T0);
  store.placeTask(store.refFor("built-in", id).id, world.repo, {}, T0);
  // A release's check purpose, signed in its scope (pipeline-speed.md P0): the scope alone says this is release work.
  const releaseCheck: ReleaseCheckPurpose | undefined = kind !== "release" ? undefined : { version: 1, purpose: "release-check", repo: world.repo, packageVersion: "1.2.3",
    branch: "release/1.2.3", pr: 7, base: "main", approvedSha: "c".repeat(40), approvedTree: "d".repeat(40), grant: { id: 1, digest: "g" }, access: "sandboxed" } as ReleaseCheckPurpose;
  propose(store, { taskId: id, goal: "Fix the checkout total", touches: [kind === "declared-protected" ? "infra/main.tf" : "src/total.ts"],
    acceptance: [{ id: "c1", statement: "Totals add up.", how: null, evidence: ["check"] }], now: T0, ...(releaseCheck === undefined ? {} : { releaseCheck }) });
  if (kind === "coordinator") {
    store.handle.exec("PRAGMA foreign_keys = OFF");
    store.handle.prepare("UPDATE task_ref SET coordinator_cid = 'c-1' WHERE external_id = ?").run(id);
    store.handle.exec("PRAGMA foreign_keys = ON");
  }
  // A person approved it with a password, earlier (the local owner could not have).
  if (!store.sealScopeApproval(id, "alex", T0)) throw Error(`seal ${kind}`);
  if (kind === "declared-protected" || kind === "changed-protected") {
    // The project protects infra/ (since the seal): its scope declares infra/ ("declared"), or only its build changed
    // it ("changed"), where a second person's yes on record makes today's two-person rule let the owner complete it.
    store.setApprovalRules(world.repo, { notRequester: false, protectProject: false, protectedPaths: ["infra/"] }, "alex", T0);
    if (kind === "changed-protected") store.recordApprovalVote(id, store.getScope(id)!.digest, "robin", T0, "password-now");
  }
  const ref = store.lookupRef(id)!.id;
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw Error("route fixture");
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "worker-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: T0 });
  store.stampRun(runId, { scopeDigest: store.getScope(id)!.digest, baseRevision: "b".repeat(40) });
  store.recordOutcomeFacts(runId, { headRevision: HEAD, handoff: "Totals now include tax." });
  store.finishRun(runId, { outcome: "built", committed: true, now: T0 });
  store.setTaskState(id, "done", T0);
  store.saveProofVerdict(runId, "verified", [], T0, [{ id: "c1", statement: "Totals add up.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }] as never, "verified");
  // What the build actually changed: a protected file only in the "changed" case, whatever the scope declared.
  const changed = kind === "changed-protected" ? "infra/main.tf" : "src/total.ts";
  storeEvidence(store, evidence(), runId, "terminal-diff", "diff.patch", Buffer.from(`--- a/${changed}\n+++ b/${changed}\n`), "git diff (exit 0)", T0, { captureStatus: "ok" });
  storeEvidence(store, evidence(), runId, "diff-stat", "diff-stat.json", Buffer.from(JSON.stringify({ filesTruncated: false, files: [{ path: changed }] })), "git diff --numstat (exit 0)", T0, { captureStatus: "ok" });
  storeEvidence(store, evidence(), runId, "check-log", "checks.txt", Buffer.from("1 test passed"), "npm test", T0, { captureStatus: "ok" });
  sealVerificationReceipt(store, evidence(), runId, HEAD, store.liveVerifyCommand(world.repo)!, { configured: true, ran: true, exitCode: 0 }, T0);
  const current = assignmentOf(store, id, T0, { principal: "operator", repos: [world.repo] }, evidence())!;
  if (current.state !== "ready-to-check" || current.receipt?.runId !== runId) throw Error(`${kind}: ${current.state} ${current.detail}`);
  return { id, runId, digest: current.receipt.digest };
}

/** Everything a completion, an acceptance or a pull request would write, and what the task's approval and state are. */
function stateOf(id: string, runId: number): string {
  const store = world.store;
  return JSON.stringify([
    store.handle.prepare("SELECT actor, outcome FROM action_ledger WHERE action = ? AND run_id = ?").all(COMPLETION_ACTION, runId),
    store.handle.prepare("SELECT * FROM proof_acceptance WHERE run = ?").all(runId),
    store.handle.prepare("SELECT * FROM publication WHERE run = ?").all(runId),
    store.handle.prepare("SELECT digest, approved_digest, approved_by, approval_basis FROM task_scope WHERE task_id = ?").all(id),
    store.handle.prepare("SELECT state FROM task WHERE id = ?").all(id),
    store.handle.prepare("SELECT outcome, finished_at FROM run WHERE id = ?").all(runId),
  ]);
}
const completed = (runId: number) => world.store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = ? AND run_id = ?").get(COMPLETION_ACTION, runId)?.["n"];

const REFUSED: readonly Kind[] = ["release", "declared-protected", "changed-protected", "coordinator"];
const BRANCHES = {
  "plain completion": {},
  "Accept and finish": { accept: "1" },
  "Complete and open a pull request": { publish: "1" },
  "Accept and finish, with a pull request": { accept: "1", publish: "1" },
} as const;

describe("the browser's completion, as the local owner", () => {
  for (const [branch, extra] of Object.entries(BRANCHES)) {
    for (const kind of REFUSED) {
      test(`${branch}: a ${kind} result is refused, and nothing about it changes`, async () => {
        const { cookie, csrf } = await world.localSession();
        const { id, runId, digest } = ready(kind);
        const before = stateOf(id, runId);
        const answer = await world.post(`/t/${id}/complete`, cookie, { csrf, receipt: digest, run: String(runId), ...extra });
        // Admitted (the row is the local owner's), refused at the completion itself, in words that say what to do.
        expect(answer.headers["x-toolroll-refused"]).toBeUndefined();
        expect(answer.status).toBe(409);
        expect(answer.body).toMatch(/password/);
        expect(answer.body).toContain("toolroll password set");
        expect(stateOf(id, runId)).toBe(before);
        expect(completed(runId)).toBe(0);
      });
    }
  }

  test("an ordinary result is still completed by the local owner, plainly and with Accept and finish", async () => {
    const { cookie, csrf } = await world.localSession();
    const plain = ready("ordinary");
    const done = await world.post(`/t/${plain.id}/complete`, cookie, { csrf, receipt: plain.digest, run: String(plain.runId) });
    expect(done.status).toBe(303);
    expect(world.store.handle.prepare("SELECT actor FROM action_ledger WHERE action = ? AND run_id = ?").all(COMPLETION_ACTION, plain.runId)).toEqual([{ actor: "operator:alex" }]);
    const accepted = ready("ordinary");
    const finished = await world.post(`/t/${accepted.id}/complete`, cookie, { csrf, receipt: accepted.digest, run: String(accepted.runId), accept: "1" });
    expect(finished.status).toBe(303);
    expect(completed(accepted.runId)).toBe(1);
  });

  test("an ordinary result's pull request is refused to the local owner: nothing is completed and nothing is owed", async () => {
    const { cookie, csrf } = await world.localSession();
    for (const extra of [{ publish: "1" }, { accept: "1", publish: "1" }]) {
      const { id, runId, digest } = ready("ordinary");
      const before = stateOf(id, runId);
      const answer = await world.post(`/t/${id}/complete`, cookie, { csrf, receipt: digest, run: String(runId), ...extra });
      expect(answer.status).toBe(409);
      expect(answer.body).toContain("Opening a pull request needs your password.");
      expect(stateOf(id, runId)).toBe(before);
      expect(world.store.pendingPublications()).toEqual([]);
    }
  });
});

/** The local owner as a terminal command or the console's admission binds it, in one act. */
const owner = (act: LocalOwnerAct, transport: LocalPrincipal["transport"] = "terminal"): LocalPrincipal =>
  ({ account: "alex", localGeneration: 1, accountGeneration: world.store.accountOf("alex")!.generation, transport, act, sessionHash: null, request: null });
function person(): VerifiedApprover {
  const standing = verifyApproverStanding(world.store, "alex", world.store.accountOf("alex")!.generation, [world.repo]);
  if (!standing.ok) throw Error("standing");
  return standing.who;
}

describe("the shared completion boundaries, as the local owner", () => {
  test("each boundary refuses ineligible work and the wrong act; a person outside the local chain still completes and opens the pull request", () => {
    const who = person(), root = evidence();
    for (const kind of REFUSED) {
      const { id, runId, digest } = ready(kind);
      const before = stateOf(id, runId);
      for (const act of ["complete-task", "file-task"] as const) {
        expect(asLocalOwner(owner(act), () => checkAssignmentAsOperator(world.store, id, digest, who, T0, root)), `${kind} ${act}`).toMatchObject({ ok: false, reason: "local-owner" });
        expect(asLocalOwner(owner(act), () => acceptAndCompleteAsOperator(world.store, id, { runId, receiptDigest: digest, note: null }, who, T0, root))).toMatchObject({ ok: false, reason: "local-owner" });
        expect(asLocalOwner(owner(act), () => completeAndOpenPullRequest(world.store, { taskId: id, digest, runId, who, root }, T0))).toMatchObject({ ok: false, reason: "local-owner" });
      }
      expect(stateOf(id, runId)).toBe(before);
    }
    // The wrong act refuses even ordinary work; work that outlived its request proves nothing.
    const plain = ready("ordinary");
    expect(asLocalOwner(owner("file-task"), () => checkAssignmentAsOperator(world.store, plain.id, plain.digest, who, T0, root))).toMatchObject({ ok: false, reason: "local-owner" });
    expect(asLocalOwner({ ...owner("complete-task"), request: { ended: true } }, () => checkAssignmentAsOperator(world.store, plain.id, plain.digest, who, T0, root))).toMatchObject({ ok: false });
    expect(completed(plain.runId)).toBe(0);
    expect(asLocalOwner(owner("complete-task"), () => checkAssignmentAsOperator(world.store, plain.id, plain.digest, who, T0, root))).toMatchObject({ ok: true });
    // A person outside any local owner's chain (a password session's road) completes protected work it may complete,
    // and opens a pull request under the project's grant.
    const pr = ready("ordinary");
    expect(completeAndOpenPullRequest(world.store, { taskId: pr.id, digest: pr.digest, runId: pr.runId, who, root }, T0)).toMatchObject({ ok: true, publication: { run: pr.runId } });
    expect(asLocalOwner(owner("complete-task"), () => completeAndOpenPullRequest(world.store, { taskId: pr.id, digest: pr.digest, runId: pr.runId, who, root }, T0))).toMatchObject({ ok: false, reason: "local-owner" });
  });
});

describe("chat's Accept card, as the local owner", () => {
  let who: VerifiedApprover, thread: number, session: number;
  beforeEach(() => {
    who = person();
    session = world.store.mintLeadSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "local-fixture", ceilingMicrousd: 10_000_000,
      ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, T0);
    thread = world.store.openLeadThread(who.name, who.ceilingDigest, T0).thread.id;
  });
  function proposal(operation: ChatAction, input: Record<string, unknown>) {
    const store = world.store;
    const payload = prepareSharedAction(store, who, operation, input, evidence(), T0);
    const turn = store.openLeadTurn({ approver: who.name, session, thread, credentialKey: "local-fixture", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, T0);
    if (!turn.ok) throw Error(turn.reason);
    const started = store.startLeadTurn(turn.id, T0);
    if (!started.ok) throw Error("start");
    const id = store.draftLeadProposal({ thread, turn: turn.id, kind: "action", payload: { ...payload }, ceilingDigest: who.ceilingDigest }, T0);
    store.finalizeLeadTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Review it.", activity: "" } }, T0);
    return id;
  }
  /** The chat review's secure confirm, as the browser's local owner on the confirm row (nothing typed). */
  function confirm(id: number) {
    const review = mintSharedActionReview(world.store, who, id, evidence(), T0);
    return asLocalOwner(owner("lead-send", "browser"), () => confirmLeadProposal(world.store, who, id, T0,
      { authority: "local-owner", via: "web", evidenceRoot: evidence(), confirm: true, actionReview: { nonce: review.nonce, password: "" } }));
  }

  test("a release, protected or coordinator result's card is refused and changes nothing; an ordinary one is accepted", () => {
    for (const kind of REFUSED) {
      const { id, runId } = ready(kind);
      const card = proposal("result_accept", { task: id, run: runId });
      const before = stateOf(id, runId);
      expect(confirm(card), kind).toMatchObject({ ok: false });
      expect(stateOf(id, runId)).toBe(before);
      expect(completed(runId)).toBe(0);
    }
    const { id, runId } = ready("ordinary");
    expect(confirm(proposal("result_accept", { task: id, run: runId }))).toMatchObject({ ok: true });
    expect(completed(runId)).toBe(1);
  });
});
