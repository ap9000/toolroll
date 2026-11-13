/**
 * Local-owner slice 0 (docs/plans/local-owner-acts.md, Codex finding b): a laptop's local owner (no password) completes
 * and accepts ordinary results only. On every road that completes — the browser's plain completion, Accept and finish,
 * Complete and open a pull request, and chat's Accept card — a release result, protected work (declared in its scope,
 * or only actually changed by the build) and a coordinator's filing are refused, and the refusal leaves the result's
 * acceptance, completion, publication, approval and the task's state exactly as they were. The local owner never opens
 * a pull request; a person outside the local owner's chain still can. An ordinary result is still completed.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openLocalWorld, type LocalWorld, LOCAL_WORLD_SETUP_MS } from "../local-owner-world.js";
import { RESULT_T0, resultFixtures, type Kind } from "../local-owner-results.js";
import { verifyApproverStanding, type VerifiedApprover } from "../../src/principal.js";
import { acceptAndCompleteAsOperator, checkAssignmentAsOperator } from "../../src/assignment.js";
import { COMPLETION_ACTION } from "../../src/result-completion.js";
import { completeAndOpenPullRequest } from "../../src/pull-request-flow.js";
import { prepareSharedAction, mintSharedActionReview, type ChatAction } from "../../src/chat-actions.js";
import { confirmLeadProposal } from "../../src/lead-doors.js";
import { asLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "../../src/local-owner.js";

const T0 = RESULT_T0;
type Fixtures = ReturnType<typeof resultFixtures>;
let world: LocalWorld;
const evidence = () => `${world.root}/evidence`;

beforeEach(async () => {
  world = await openLocalWorld();
  const fixtures = resultFixtures(world, evidence());
  fixtures.prepare();
  ({ ready, stateOf, completed } = fixtures);
}, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });
let ready: Fixtures["ready"], stateOf: Fixtures["stateOf"], completed: Fixtures["completed"];

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

  test("with the person's own check owed, a release, release-record, protected or coordinator card writes no acceptance; an ordinary one records the owner's", () => {
    for (const kind of [...REFUSED, "release-record"] as const) {
      const { id, runId } = ready(kind, { owed: "person-check" });
      const card = proposal("result_accept", { task: id, run: runId });
      const before = stateOf(id, runId);
      expect(confirm(card), kind).toMatchObject({ ok: false });
      expect(stateOf(id, runId)).toBe(before);
      expect(world.store.proofAcceptance(runId)).toBeNull();
    }
    const { id, runId } = ready("ordinary", { owed: "person-check" });
    expect(confirm(proposal("result_accept", { task: id, run: runId }))).toMatchObject({ ok: true });
    expect(world.store.proofAcceptance(runId)).toMatchObject({ approver: "alex" });
    expect(completed(runId)).toBe(1);
  });

  test("a revision whose source's changes are unknown is refused; one whose source proves it committed nothing is accepted", () => {
    for (const owed of ["nothing", "person-check"] as const) {
      const { id, runId } = ready("ordinary", { inherited: "unknown", owed });
      const card = proposal("result_accept", { task: id, run: runId });
      const before = stateOf(id, runId);
      expect(confirm(card), owed).toMatchObject({ ok: false });
      expect(stateOf(id, runId)).toBe(before);
    }
    const { id, runId } = ready("ordinary", { inherited: "nothing", owed: "person-check" });
    expect(confirm(proposal("result_accept", { task: id, run: runId }))).toMatchObject({ ok: true });
    expect(completed(runId)).toBe(1);
  });
});

/** What the person's acceptance of a result recorded: who accepted it and with what reason. */
const acceptance = (runId: number) => world.store.handle.prepare("SELECT approver, note FROM proof_acceptance WHERE run = ?").all(runId);

describe("an owed acceptance, as the local owner", () => {
  // Each owed acceptance with the form Accept and finish posts for it: an exception is only ever accepted with its reason.
  const OWED = { "person-check": {}, exception: { note: "The phone layout is unchanged by this fix." } } as const;
  const ACCEPTING = { "Accept and finish": { accept: "1" }, "Accept and finish, with a pull request": { accept: "1", publish: "1" } } as const;
  const KINDS: readonly Kind[] = [...REFUSED, "release-record"];

  for (const [owed, reason] of Object.entries(OWED) as [keyof typeof OWED, (typeof OWED)[keyof typeof OWED]][]) {
    for (const [branch, extra] of Object.entries(ACCEPTING)) {
      for (const kind of KINDS) {
        test(`${branch}, owing a ${owed}: a ${kind} result is refused before any acceptance is written`, async () => {
          const { cookie, csrf } = await world.localSession();
          const { id, runId, digest } = ready(kind, { owed });
          const before = stateOf(id, runId);
          const answer = await world.post(`/t/${id}/complete`, cookie, { csrf, receipt: digest, run: String(runId), ...extra, ...reason });
          expect(answer.status).toBe(409);
          expect(answer.body).toContain("toolroll password set");
          expect(stateOf(id, runId)).toBe(before);
          expect(acceptance(runId)).toEqual([]);
          expect(completed(runId)).toBe(0);
        });
      }
    }
  }

  test("the shared boundary refuses each kind with its acceptance owed, and writes nothing", () => {
    const who = person(), root = evidence();
    for (const owed of ["person-check", "exception"] as const) {
      for (const kind of KINDS) {
        const { id, runId, digest } = ready(kind, { owed });
        const before = stateOf(id, runId);
        const note = owed === "exception" ? "The phone layout is unchanged by this fix." : null;
        expect(asLocalOwner(owner("complete-task"), () => acceptAndCompleteAsOperator(world.store, id, { runId, receiptDigest: digest, note }, who, T0, root)), `${kind} ${owed}`)
          .toMatchObject({ ok: false, reason: "local-owner" });
        expect(asLocalOwner(owner("complete-task"), () => acceptAndCompleteAsOperator(world.store, id, { runId, receiptDigest: digest, note }, who, T0, root,
          accepted => completeAndOpenPullRequest(world.store, { taskId: id, digest: accepted, runId, who, root }, T0)))).toMatchObject({ ok: false, reason: "local-owner" });
        expect(stateOf(id, runId)).toBe(before);
        expect(acceptance(runId)).toEqual([]);
      }
    }
  });

  test("a result that belongs to a release through its release records, not its scope, is refused on every road", async () => {
    const { cookie, csrf } = await world.localSession();
    const who = person(), root = evidence();
    for (const extra of Object.values(BRANCHES)) {
      const { id, runId, digest } = ready("release-record");
      const before = stateOf(id, runId);
      const answer = await world.post(`/t/${id}/complete`, cookie, { csrf, receipt: digest, run: String(runId), ...extra });
      expect(answer.status).toBe(409);
      expect(stateOf(id, runId)).toBe(before);
      expect(completed(runId)).toBe(0);
    }
    const { id, runId, digest } = ready("release-record");
    const before = stateOf(id, runId);
    expect(asLocalOwner(owner("complete-task"), () => acceptAndCompleteAsOperator(world.store, id, { runId, receiptDigest: digest, note: null }, who, T0, root)))
      .toMatchObject({ ok: false, reason: "local-owner", message: expect.stringContaining("release") });
    expect(asLocalOwner(owner("complete-task"), () => checkAssignmentAsOperator(world.store, id, digest, who, T0, root))).toMatchObject({ ok: false });
    expect(stateOf(id, runId)).toBe(before);
  });

  test("an ordinary result owing the person's own check is accepted by the local owner, and the acceptance is theirs", async () => {
    const { cookie, csrf } = await world.localSession();
    const { id, runId, digest } = ready("ordinary", { owed: "person-check" });
    const answer = await world.post(`/t/${id}/complete`, cookie, { csrf, receipt: digest, run: String(runId), accept: "1" });
    expect(answer.status).toBe(303);
    expect(acceptance(runId)).toEqual([{ approver: "alex", note: null }]);
    expect(completed(runId)).toBe(1);
    // An exception is accepted with its reason, the same way.
    const exception = ready("ordinary", { owed: "exception" });
    const reasoned = await world.post(`/t/${exception.id}/complete`, cookie, { csrf, receipt: exception.digest, run: String(exception.runId), accept: "1", note: "The phone layout is unchanged by this fix." });
    expect(reasoned.status).toBe(303);
    expect(acceptance(exception.runId)).toEqual([{ approver: "alex", note: "The phone layout is unchanged by this fix." }]);
    expect(completed(exception.runId)).toBe(1);
  });
});

describe("a revision whose source build saved no diff inventory, as the local owner", () => {
  test("when the source's record doesn't prove it committed nothing, its changes are unknown: refused on every branch, and nothing changes", async () => {
    const { cookie, csrf } = await world.localSession();
    for (const extra of Object.values(BRANCHES)) {
      const { id, runId, digest } = ready("ordinary", { inherited: "unknown" });
      const before = stateOf(id, runId);
      const answer = await world.post(`/t/${id}/complete`, cookie, { csrf, receipt: digest, run: String(runId), ...extra });
      expect(answer.status, JSON.stringify(extra)).toBe(409);
      expect(answer.body).toContain("toolroll password set");
      expect(stateOf(id, runId)).toBe(before);
      expect(completed(runId)).toBe(0);
    }
    const who = person(), root = evidence();
    for (const owed of ["nothing", "person-check"] as const) {
      const { id, runId, digest } = ready("ordinary", { inherited: "unknown", owed });
      const before = stateOf(id, runId);
      expect(asLocalOwner(owner("complete-task"), () => checkAssignmentAsOperator(world.store, id, digest, who, T0, root))).toMatchObject({ ok: false, reason: "local-owner" });
      expect(asLocalOwner(owner("complete-task"), () => acceptAndCompleteAsOperator(world.store, id, { runId, receiptDigest: digest, note: null }, who, T0, root))).toMatchObject({ ok: false, reason: "local-owner" });
      expect(stateOf(id, runId)).toBe(before);
      expect(acceptance(runId)).toEqual([]);
    }
  });

  test("when the source's record proves it committed nothing, the result is ordinary and the local owner completes it", async () => {
    const { cookie, csrf } = await world.localSession();
    const plain = ready("ordinary", { inherited: "nothing" });
    expect((await world.post(`/t/${plain.id}/complete`, cookie, { csrf, receipt: plain.digest, run: String(plain.runId) })).status).toBe(303);
    expect(completed(plain.runId)).toBe(1);
    const accepted = ready("ordinary", { inherited: "nothing", owed: "person-check" });
    expect((await world.post(`/t/${accepted.id}/complete`, cookie, { csrf, receipt: accepted.digest, run: String(accepted.runId), accept: "1" })).status).toBe(303);
    expect(acceptance(accepted.runId)).toEqual([{ approver: "alex", note: null }]);
    expect(completed(accepted.runId)).toBe(1);
  });
});

describe("the result page, as the local owner: never a plain Accept or Mark complete the completion then refuses", () => {
  type Selected = { complete: unknown; decision: { ready: boolean } | null; acts: { primary: string | null; line: string | null } };
  const selectedOf = async (cookie: string, id: string, runId: number): Promise<Selected> =>
    (JSON.parse((await world.send(`/review?result=${id}&run=${runId}&format=workspace`, "GET", { cookie })).body) as { view: { selected: Selected } }).view.selected;

  for (const kind of REFUSED) {
    test(`a ${kind} result with its check passed and every requirement met: no completion offered, and the line says what to do`, async () => {
      const { cookie, csrf } = await world.localSession();
      const { id, runId, digest } = ready(kind);
      const selected = await selectedOf(cookie, id, runId);
      expect(selected.complete).toBeNull();
      expect(selected.decision?.ready ?? false).toBe(false);
      expect(selected.acts.primary).not.toBe("accept");
      expect(selected.acts.line ?? "").toContain("toolroll password set");
      const task = await world.send(`/t/${id}?tab=result&run=${runId}`, "GET", { cookie });
      expect(task.body).not.toContain(`/t/${id}/complete`);
      // What the page says is what the completion says when it is pressed anyway.
      const answer = await world.post(`/t/${id}/complete`, cookie, { csrf, receipt: digest, run: String(runId) });
      expect(answer.status).toBe(409);
      expect(answer.body.replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')).toContain(selected.acts.line!.split(" Set a password first")[0]!);
    });
  }

  test("an ordinary result still reads plain Accept, ready, with its completion", async () => {
    const { cookie } = await world.localSession();
    const { id, runId } = ready("ordinary");
    const selected = await selectedOf(cookie, id, runId);
    expect(selected.complete).not.toBeNull();
    expect(selected.decision?.ready).toBe(true);
    expect(selected.acts.primary).toBe("accept");
  });
});
