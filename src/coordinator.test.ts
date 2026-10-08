import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import {
  mintCoordinator,
  authenticateCoordinator,
  revokeCoordinator,
  listCoordinators,
  fileCoordinatorProposal,
  statusFor,
  listTasksFor,
  taskDetailFor,
  PER_CID_OUTSTANDING,
  GLOBAL_OUTSTANDING,
  type VerifiedCoordinator,
} from "./coordinator.js";
import { register } from "./runner.js";
import { acquire, acquireIfReady } from "./claim.js";
import { addApprover, fileAndSealUnderMode, type AcceptanceCriterion } from "./scope.js";

import { presetTerms, modeTermsJson, modeDigestOf } from "./modes.js";

const RUBRIC: AcceptanceCriterion[] = [{ id: "c1", statement: "the change is reviewed", how: null, evidence: ["manual-review"] }];


const T0 = new Date("2026-08-30T12:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const REPO = "/repo/mcp";

describe("the coordinator credential", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    // v47: a routed scope seals only when every phase names an exact agent.
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
  });
  afterEach(() => store.close());

  const mint = (over: Partial<Parameters<typeof mintCoordinator>[1]> = {}) =>
    mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0, ...over });

  test("mint validates name, rate, and repos; the token authenticates; the cid is the identity", () => {
    expect(mint({ name: "Bad Name!" })).toMatchObject({ ok: false, reason: "bad-name" });
    expect(mint({ perHour: 0 })).toMatchObject({ ok: false, reason: "bad-rate" });
    expect(mint({ perHour: 61 })).toMatchObject({ ok: false, reason: "bad-rate" });
    expect(mint({ repos: [] })).toMatchObject({ ok: false, reason: "no-repos" });

    const made = mint();
    expect(made).toMatchObject({ ok: true });
    if (!made.ok) throw new Error("unreachable");
    const auth = authenticateCoordinator(store, made.token);
    expect(auth).toMatchObject({ ok: true });
    if (auth.ok) {
      expect(auth.who.cid).toBe(made.cid);
      expect(auth.who.repos).toEqual([REPO]);
    }
    expect(authenticateCoordinator(store, "not-a-token")).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("names are unique among the LIVING; revoke-and-remint mints a fresh cid — generations never conflate", () => {
    const first = mint();
    if (!first.ok) throw new Error("mint failed");
    expect(mint()).toMatchObject({ ok: false, reason: "name-taken" });

    expect(revokeCoordinator(store, first.cid, "alex", later(1_000))).toMatchObject({ ok: true });
    expect(revokeCoordinator(store, first.cid, "alex", later(2_000))).toMatchObject({ ok: false, reason: "already-revoked" });
    expect(authenticateCoordinator(store, first.token)).toMatchObject({ ok: false, reason: "revoked" });

    const second = mint();
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error("unreachable");
    expect(second.cid).not.toBe(first.cid);
    const rows = listCoordinators(store);
    expect(rows).toHaveLength(2);
    expect(rows.filter(one => one.revokedAt === null)).toHaveLength(1);
  });

  test("filing is one transaction: door + cid stamp + idempotency + event; replay charges no slot; conflict refuses", () => {
    const made = mint();
    if (!made.ok) throw new Error("mint failed");
    const input = { repo: REPO, title: "Fix flaky auth test", intent: "the test flakes", idempotencyKey: "key-0001" };

    const filed = fileCoordinatorProposal(store, made.token, input, T0);
    expect(filed).toMatchObject({ ok: true, replayed: false });
    if (!filed.ok) throw new Error("unreachable");
    const ref = store.refFor("built-in", filed.id);
    expect(ref.coordinatorCid).toBe(made.cid);
    const via = store.handle.prepare("SELECT filed_via FROM task_ref WHERE id = ?").get(ref.id);
    expect(via?.["filed_via"]).toBe("mcp:planner-bot");

    const again = fileCoordinatorProposal(store, made.token, input, later(1_000));
    expect(again).toMatchObject({ ok: true, replayed: true, id: filed.id });

    const conflicting = fileCoordinatorProposal(
      store,
      made.token,
      { ...input, title: "A DIFFERENT title" },
      later(2_000),
    );
    expect(conflicting).toMatchObject({ ok: false, reason: "idempotency-conflict" });

    // The replay charged no rate slot: with per-hour 6, five more distinct
    // filings still fit.
    for (let i = 1; i <= 5; i++) {
      expect(
        fileCoordinatorProposal(store, made.token, { repo: REPO, title: `task ${i}`, idempotencyKey: `key-000${i + 1}` }, later(3_000 + i)),
      ).toMatchObject({ ok: true });
    }
    expect(
      fileCoordinatorProposal(store, made.token, { repo: REPO, title: "one too many", idempotencyKey: "key-9999" }, later(9_000)),
    ).toMatchObject({ ok: false, reason: "rate-limited" });
  });

  test("the sliding window opens a slot when the oldest filing ages out", () => {
    const made = mint({ perHour: 2 });
    if (!made.ok) throw new Error("mint failed");
    fileCoordinatorProposal(store, made.token, { repo: REPO, title: "a", idempotencyKey: "key-aaaa" }, T0);
    fileCoordinatorProposal(store, made.token, { repo: REPO, title: "b", idempotencyKey: "key-bbbb" }, later(60_000));
    expect(
      fileCoordinatorProposal(store, made.token, { repo: REPO, title: "c", idempotencyKey: "key-cccc" }, later(120_000)),
    ).toMatchObject({ ok: false, reason: "rate-limited" });
    expect(
      fileCoordinatorProposal(store, made.token, { repo: REPO, title: "c", idempotencyKey: "key-cccc" }, later(3_600_001)),
    ).toMatchObject({ ok: true });
  });

  test("the ceiling holds at the door: a repo outside the allowlist — or none — refuses", () => {
    const made = mint();
    if (!made.ok) throw new Error("mint failed");
    expect(
      fileCoordinatorProposal(store, made.token, { repo: "/somewhere/else", title: "x", idempotencyKey: "key-else" }, T0),
    ).toMatchObject({ ok: false, reason: "outside-ceiling" });
    expect(
      fileCoordinatorProposal(store, made.token, { repo: "", title: "x", idempotencyKey: "key-none" }, T0),
    ).toMatchObject({ ok: false, reason: "outside-ceiling" });
  });

  test("revocation is re-checked inside the filing transaction, and outstanding caps count unsealed non-terminal filings — failed included", () => {
    const made = mint({ perHour: 60 });
    if (!made.ok) throw new Error("mint failed");

    for (let i = 0; i < PER_CID_OUTSTANDING; i++) {
      const one = fileCoordinatorProposal(
        store,
        made.token,
        { repo: REPO, title: `filing ${i}`, idempotencyKey: `key-cap-${String(i).padStart(2, "0")}` },
        later(i),
      );
      expect(one).toMatchObject({ ok: true });
      // A FAILED unsealed filing still counts (spec: dead unsealed filings
      // pressure cleanup) — fail one and the cap must not open.
      if (i === 0 && one.ok) store.setTaskState(one.id, "failed", later(500));
    }
    expect(
      fileCoordinatorProposal(store, made.token, { repo: REPO, title: "over", idempotencyKey: "key-cap-over" }, later(100)),
    ).toMatchObject({ ok: false, reason: "outstanding-cap" });

    revokeCoordinator(store, made.cid, "alex", later(200));
    expect(
      fileCoordinatorProposal(store, made.token, { repo: REPO, title: "post-revoke", idempotencyKey: "key-cap-rev" }, later(300)),
    ).toMatchObject({ ok: false, reason: "revoked" });
  });
});

describe("the coordinator quarantine", () => {
  let store: Store;
  let cid: string;
  let token: string;
  let taskId: string;
  let taskRef: number;

  beforeEach(() => {
    store = openStore(":memory:");
    // v47: a routed scope seals only when every phase names an exact agent.
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    const made = mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0 });
    if (!made.ok) throw new Error("mint failed");
    cid = made.cid;
    token = made.token;
    const filed = fileCoordinatorProposal(store, token, { repo: REPO, title: "quarantined", idempotencyKey: "key-quar" }, T0);
    if (!filed.ok) throw new Error("filing failed");
    taskId = filed.id;
    taskRef = store.refFor("built-in", taskId).id;
    register(store, { name: "b-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-b-1" });
    // A concrete scope row to seal — the primitive tests drive
    // sealScopeApproval directly, the way claim.test's approveScopeFor does.
    store.saveScope({
      taskId, goal: "the work", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: `dg-${taskId}`,
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
  });
  afterEach(() => store.close());

  test("nothing claims a coordinator-filed task before the password seal — and everything does after", () => {
    const refused = acquire(store, taskRef, "b-1", { now: T0, token: "tok-b-1" });
    expect(refused).toMatchObject({ ok: false, reason: "coordinator-filed" });

    // The password seal (basis undefined = password) admits it.
    expect(store.sealScopeApproval(taskId, "alex", later(1_000))).toBe(true);
    expect(acquire(store, taskRef, "b-1", { now: later(2_000), token: "tok-b-1" })).toMatchObject({ ok: true });
  });

  test("mode coverage cannot seal a coordinator-filed task — the primitive refuses for every caller", () => {
    expect(
      store.sealScopeApproval(taskId, "mode:standard", later(1_000), {}, { kind: "mode", modeDigest: "d1" }),
    ).toBe(false);
    // An ordinary task seals under the same basis just fine — proving the
    // refusal above is the GUARD, not a missing row.
    const ordinary = store.createConsoleTask({ title: "ordinary", repo: REPO, filedVia: "console" }, T0);
    if (!ordinary.ok) throw new Error("filing failed");
    store.saveScope({
      taskId: ordinary.id, goal: "ordinary work", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: `dg-${ordinary.id}`,
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    expect(
      store.sealScopeApproval(ordinary.id, "mode:standard", later(1_500), {}, { kind: "mode", modeDigest: "d1" }),
    ).toBe(true);
    expect(store.scopeSealed(taskId)).toBe(false);
    void cid;
  });

  test("dismissing a coordinator-filed task writes the durable event in the same transaction", () => {
    const cancelled = store.cancelTask(taskId, later(1_000), "not this week");
    expect(cancelled).toMatchObject({ ok: true });
    const events = store.handle
      .prepare("SELECT kind, task_id, detail FROM coordinator_event WHERE cid = ? ORDER BY id")
      .all(cid);
    expect(events.map(one => one["kind"])).toEqual(["filed", "dismissed"]);
    expect(events[1]?.["detail"]).toBe("not this week");
  });

  test.each([undefined, "", " \n\t ", "x".repeat(501), "hidden\u001btext", "hidden\u202etext"])(
    "coordinator cancellation rejects an absent or invalid human reason: %j",
    reason => {
      const before = store.getTask(taskId);
      const refusal = reason === undefined || reason.trim() === "" ? "reason-required" : "bad-reason";
      expect(store.cancelTask(taskId, later(1_000), reason)).toMatchObject({ ok: false, reason: refusal });
      expect(store.setTaskState(taskId, "cancelled", later(1_000), {}, reason)).toMatchObject({ ok: false, reason: refusal });
      expect(store.applyCancellation(taskId, { kind: "operator", text: reason ?? null }, later(1_000), null))
        .toEqual({ changed: false, reason: refusal });
      expect(store.getTask(taskId)).toEqual(before);
      expect(store.handle.prepare("SELECT kind FROM coordinator_event WHERE cid = ? ORDER BY id").all(cid))
        .toEqual([{ kind: "filed" }]);
    },
  );

  test("a refused state cancellation can retry the same key with a real reason", () => {
    const mutation = { idempotencyKey: "cancel-retry", at: later(1_000) };
    expect(store.setTaskState(taskId, "cancelled", later(1_000), mutation)).toMatchObject({ ok: false, reason: "reason-required" });
    expect(store.setTaskState(taskId, "cancelled", later(1_000), mutation, "superseded by the smaller task")).toEqual({ ok: true });
    expect(store.getTask(taskId)?.state).toBe("cancelled");
    expect(store.handle.prepare("SELECT detail FROM coordinator_event WHERE cid = ? AND kind = 'dismissed'").all(cid))
      .toEqual([{ detail: "superseded by the smaller task" }]);
  });

  test("the PLANNER road shares the quarantine: a plan-requested filing dispatches for nobody before the seal", () => {
    expect(store.requestPlan(taskRef, T0)).toMatchObject({ ok: true });
    const refused = acquireIfReady(store, taskRef, "b-1", { now: later(1_000), token: "tok-b-1", dispatchRole: "planner" });
    // The reason is the quarantine's own — not "not-ready": the planner arm's
    // readiness (plan requested, scope unapproved) all passed, and the shared
    // primitive still shut the door.
    expect(refused).toEqual({ ok: false, reason: "coordinator-filed" });

    // Control: an ordinary console filing with the same plan request
    // dispatches a planner just fine — the refusal above is the quarantine,
    // not a broken planner fixture.
    const ordinary = store.createConsoleTask({ title: "ordinary plan", repo: REPO, filedVia: "console" }, T0);
    if (!ordinary.ok) throw new Error("filing failed");
    const ordinaryRef = store.refFor("built-in", ordinary.id).id;
    expect(store.requestPlan(ordinaryRef, T0)).toMatchObject({ ok: true });
    expect(
      acquireIfReady(store, ordinaryRef, "b-1", { now: later(2_000), token: "tok-b-1", dispatchRole: "planner" }),
    ).toMatchObject({ ok: true });
  });

  test("fileAndSealUnderMode refuses a coordinator-filed task in words, while the same live mode covers an ordinary filing", () => {
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap failed");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    const terms = { ...presetTerms("standard", later(24 * 3_600_000).toISOString()), autoApproveFiling: true };
    store.signMode(
      {
        repo: REPO,
        name: terms.name,
        termsJson: modeTermsJson(terms),
        digest: modeDigestOf(terms),
        signedBy: "alex",
        absoluteExpiry: terms.absoluteExpiry,
        publication: terms.publication,
      },
      T0,
    );

    const refused = fileAndSealUnderMode(store, {
      taskId, goal: "auto-approved?", outOfScope: null, touches: [], acceptance: RUBRIC, now: later(1_000), repo: REPO, actor: "alex",
    });
    expect(refused).toEqual({ ok: false, reason: "coordinator-filed" });
    expect(store.scopeSealed(taskId)).toBe(false);

    // Control: the same mode, the same signer, an ordinary filing — sealed,
    // basis 'mode'. The refusal above is the quarantine speaking through the
    // caller, not a dead mode.
    const ordinary = store.createConsoleTask({ title: "covered", repo: REPO, filedVia: "console" }, T0);
    if (!ordinary.ok) throw new Error("filing failed");
    const sealed = fileAndSealUnderMode(store, {
      taskId: ordinary.id, goal: "covered work", outOfScope: null, touches: [], acceptance: RUBRIC, now: later(1_500), repo: REPO, actor: "alex",
    });
    expect(sealed).toMatchObject({ ok: true, basis: "mode" });
    expect(store.scopeSealed(ordinary.id)).toBe(true);
  });
});

describe("coordinator events on machine roads", () => {
  let store: Store;
  let cid: string;
  let taskId: string;

  beforeEach(() => {
    store = openStore(":memory:");
    const made = mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0 });
    if (!made.ok) throw new Error("mint failed");
    cid = made.cid;
    const filed = fileCoordinatorProposal(store, made.token, { repo: REPO, title: "machine-cancelled", idempotencyKey: "key-mach" }, T0);
    if (!filed.ok) throw new Error("filing failed");
    taskId = filed.id;
  });
  afterEach(() => store.close());

  const eventsFor = () =>
    store.handle
      .prepare("SELECT kind, task_id, detail FROM coordinator_event WHERE cid = ? ORDER BY id")
      .all(cid);

  test("the mirror latch's machine cancellation writes 'dismissed' with detail 'mirror-latched'", () => {
    // The mirror row itself is fixture plumbing — the latch method is the
    // road under test. An idle (unclaimed, uncontested) mirror latches to a
    // cancellation, and the filer's ledger must say WHY in the same breath.
    store.handle
      .prepare(
        `INSERT INTO external_mirror
           (local_task_id, backend, remote_repo, remote_id, provenance, established_by, established_at, remote_state, sync_generation, dispatch_ok)
         VALUES (?, 'github', 'octo/mcp', '7', 'local-create', 'test', ?, 'open', 1, 1)`,
      )
      .run(taskId, T0.toISOString());

    store.latchMirror(taskId, "closed", 2, later(1_000));

    expect(store.getTask(taskId)?.state).toBe("cancelled");
    const events = eventsFor();
    expect(events.map(one => one["kind"])).toEqual(["filed", "dismissed"]);
    expect(events[1]).toMatchObject({ task_id: taskId, detail: "mirror-latched" });
  });

  test("a disowned completion's machine cancellation writes detail 'disowned-completion'", () => {
    // finalize's complete ending, disowned arm (claim.ts), drives exactly this call —
    // the floor is the one writer, so pinning the floor pins the road.
    const done = store.applyCancellation(taskId, { kind: "machine", code: "disowned-completion" }, later(1_000), null);
    expect(done).toEqual({ changed: true });
    expect(store.getTask(taskId)?.state).toBe("cancelled");
    const events = eventsFor();
    expect(events.map(one => one["kind"])).toEqual(["filed", "dismissed"]);
    expect(events[1]).toMatchObject({ task_id: taskId, detail: "disowned-completion" });
  });

  test("the event insert is atomic with the state write: if the event cannot land, the cancellation rolls back", () => {
    // Take the coordinator_event table out from under the transaction: the
    // INSERT must fail, and the task's state='cancelled' UPDATE — which ran
    // FIRST inside the same transaction — must roll back with it.
    store.handle.exec("ALTER TABLE coordinator_event RENAME TO coordinator_event_hidden");
    expect(() =>
      store.applyCancellation(taskId, { kind: "operator", text: "atomicity probe" }, later(1_000), null),
    ).toThrow();
    expect(store.getTask(taskId)?.state).toBe("queued");

    // Restored, the same cancellation lands whole: state AND event together.
    store.handle.exec("ALTER TABLE coordinator_event_hidden RENAME TO coordinator_event");
    expect(store.applyCancellation(taskId, { kind: "operator", text: "atomicity probe" }, later(2_000), null)).toEqual({
      changed: true,
    });
    expect(store.getTask(taskId)?.state).toBe("cancelled");
    const events = eventsFor();
    expect(events.map(one => one["kind"])).toEqual(["filed", "dismissed"]);
    expect(events[1]?.["detail"]).toBe("atomicity probe");
  });
});

describe("the outstanding caps and credential-scoped reads", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    // v47: a routed scope seals only when every phase names an exact agent.
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
  });
  afterEach(() => store.close());

  const whoOf = (token: string): VerifiedCoordinator => {
    const auth = authenticateCoordinator(store, token);
    if (!auth.ok) throw new Error("authentication failed");
    return auth.who;
  };

  test("the GLOBAL cap refuses across coordinators: fifty unresolved filings shut the door for a fresh cid too", () => {
    // Enough coordinators, each filled to its own per-cid ceiling, to reach
    // the installation-wide cap — disjoint repos so the allowlists never touch.
    const needed = Math.ceil(GLOBAL_OUTSTANDING / PER_CID_OUTSTANDING);
    for (let c = 0; c < needed; c++) {
      const made = mintCoordinator(store, { name: `bot-${c}`, repos: [`/repo/global-${c}`], perHour: 60, by: "alex", now: T0 });
      if (!made.ok) throw new Error("mint failed");
      for (let i = 0; i < PER_CID_OUTSTANDING; i++) {
        expect(
          fileCoordinatorProposal(
            store,
            made.token,
            { repo: `/repo/global-${c}`, title: `filing ${c}-${i}`, idempotencyKey: `key-glob-${c}-${String(i).padStart(2, "0")}` },
            later(c * 1_000 + i),
          ),
        ).toMatchObject({ ok: true });
      }
    }
    // A FRESH coordinator with ZERO outstanding filings of its own: the
    // per-cid check passes, the global one refuses — with the global reason.
    const fresh = mintCoordinator(store, { name: "bot-fresh", repos: ["/repo/global-fresh"], perHour: 60, by: "alex", now: T0 });
    if (!fresh.ok) throw new Error("mint failed");
    const refused = fileCoordinatorProposal(
      store,
      fresh.token,
      { repo: "/repo/global-fresh", title: "one over the world", idempotencyKey: "key-glob-fresh" },
      later(60_000),
    );
    expect(refused).toMatchObject({ ok: false, reason: "global-cap" });
  });

  test("outstanding is UNSEALED and non-terminal: a rewritten seal counts again, done stops counting, failed keeps counting", () => {
    const made = mintCoordinator(store, { name: "planner-bot", repos: [REPO], perHour: 60, by: "alex", now: T0 });
    if (!made.ok) throw new Error("mint failed");
    const file = (key: string, at: Date) =>
      fileCoordinatorProposal(store, made.token, { repo: REPO, title: `work ${key}`, idempotencyKey: key }, at);

    const ids: string[] = [];
    for (let i = 0; i < PER_CID_OUTSTANDING; i++) {
      const one = file(`key-mx-${String(i).padStart(2, "0")}`, later(i));
      expect(one).toMatchObject({ ok: true });
      if (one.ok) ids.push(one.id);
    }
    expect(file("key-mx-over-1", later(100))).toMatchObject({ ok: false, reason: "outstanding-cap" });

    // FAILED keeps counting: killing a filing does not open the cap.
    expect(store.setTaskState(ids[0] as string, "failed", later(200))).toMatchObject({ ok: true });
    expect(file("key-mx-over-2", later(300))).toMatchObject({ ok: false, reason: "outstanding-cap" });

    // DONE stops counting: one slot opens, exactly one filing fits.
    expect(store.setTaskState(ids[1] as string, "done", later(400))).toMatchObject({ ok: true });
    expect(file("key-mx-after-done", later(500))).toMatchObject({ ok: true });
    expect(file("key-mx-over-3", later(600))).toMatchObject({ ok: false, reason: "outstanding-cap" });

    // A live SEAL stops counting: scope + password seal on ids[2] opens a slot.
    const sealed = ids[2] as string;
    store.saveScope({
      taskId: sealed, goal: "sealed work", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: `dg-${sealed}`,
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    expect(store.sealScopeApproval(sealed, "alex", later(700))).toBe(true);
    expect(store.scopeSealed(sealed)).toBe(true);
    expect(file("key-mx-after-seal", later(800))).toMatchObject({ ok: true });
    expect(file("key-mx-over-4", later(900))).toMatchObject({ ok: false, reason: "outstanding-cap" });

    // REWRITING the sealed scope (saveScope again — the digest moves, the
    // approved digest goes stale) makes it outstanding AGAIN: the count is
    // now eleven, so even retiring one more task must not open the door.
    const current = store.getScope(sealed);
    if (current === null) throw new Error("scope vanished");
    store.saveScope({ ...current, goal: "rewritten after the seal", digest: `dg-rewritten-${sealed}` });
    expect(store.scopeSealed(sealed)).toBe(false);
    expect(store.setTaskState(ids[3] as string, "done", later(1_000))).toMatchObject({ ok: true });
    expect(file("key-mx-over-5", later(1_100))).toMatchObject({ ok: false, reason: "outstanding-cap" });
    // ...and retiring a SECOND one proves the arithmetic: 11 - 2 = 9 < cap.
    expect(store.setTaskState(ids[4] as string, "done", later(1_200))).toMatchObject({ ok: true });
    expect(file("key-mx-after-two", later(1_300))).toMatchObject({ ok: true });
  });

  test("a github-issues ref colliding with a foreign built-in task id never leaks that task through the reads", () => {
    const made = mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0 });
    if (!made.ok) throw new Error("mint failed");
    const who = whoOf(made.token);

    // A built-in task that lives OUTSIDE the allowlist...
    const foreign = store.createConsoleTask({ title: "foreign work", repo: "/repo/elsewhere", filedVia: "console" }, T0);
    if (!foreign.ok) throw new Error("filing failed");
    // ...and a colliding ref: backend 'github-issues', the SAME external id,
    // placed squarely INSIDE the coordinator's repo. A join that forgot the
    // backend qualifier would surface the foreign task through this row.
    store.handle
      .prepare("INSERT INTO task_ref (backend, external_id, repo) VALUES ('github-issues', ?, ?)")
      .run(foreign.id, REPO);

    expect(listTasksFor(store, who, {}, T0).tasks).toEqual([]);
    expect(taskDetailFor(store, who, foreign.id)).toBeNull();
    const status = statusFor(store, who, T0);
    expect(status.repos).toEqual([]);
    expect(status.waitsOnYou).toBe(0);
    expect(status.waits.approvals).toBe(0);
  });

  test("a task with NULL repo vanishes from every scoped read and count", () => {
    const made = mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0 });
    if (!made.ok) throw new Error("mint failed");
    const who = whoOf(made.token);
    const filed = fileCoordinatorProposal(store, made.token, { repo: REPO, title: "placed work", idempotencyKey: "key-null-01" }, T0);
    if (!filed.ok) throw new Error("filing failed");

    // Placed, the task is visible everywhere it should be.
    expect(listTasksFor(store, who, {}, T0).tasks.map(one => one.ref)).toEqual([filed.id]);
    expect(taskDetailFor(store, who, filed.id)).not.toBeNull();
    const placed = statusFor(store, who, T0);
    expect(placed.waits.approvals).toBe(1);
    expect(placed.repos).toEqual([{ repo: REPO, queued: 1, running: 0 }]);

    // Un-placed (repo NULL — "a task nobody has placed yet"), it is nobody's
    // to see: every scoped read and every count excludes it.
    store.handle
      .prepare("UPDATE task_ref SET repo = NULL WHERE backend = 'built-in' AND external_id = ?")
      .run(filed.id);
    expect(listTasksFor(store, who, {}, T0).tasks).toEqual([]);
    expect(taskDetailFor(store, who, filed.id)).toBeNull();
    const unplaced = statusFor(store, who, T0);
    expect(unplaced.waitsOnYou).toBe(0);
    expect(unplaced.waits.approvals).toBe(0);
    expect(unplaced.repos).toEqual([]);
  });
});
