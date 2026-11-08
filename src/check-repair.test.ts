/** A failed check's road (docs/plans/fleet-follow-through.md, part 2): one owner, one repair per failure per revision, a
 * limit, and nothing that spends without a person's signature. The sealed evidence and the ledger are their own files'
 * subjects (builder.slow.test.ts runs this road end to end); here they are stubbed so each rule is one row. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { modeDigestOf, modeTermsJson, presetTerms } from "./modes.js";
import { addApprover, propose } from "./scope.js";
import { BUILT_IN, openStore, type Store } from "./store.js";

const hoisted = vi.hoisted(() => ({
  trigger: vi.fn(), failure: vi.fn(),
}));
// Whole, not a spread of the original: dispose.ts and check-repair.ts import each other.
vi.mock("./dispose.js", () => ({ maybeTriggerRepair: hoisted.trigger }));
vi.mock("./verification-evidence.js", async original => ({ ...(await original<typeof import("./verification-evidence.js")>()), failedVerificationEvidence: hoisted.failure }));

const { checkRepairOfRun, checkRepairsOfTask, failureKeyOf, resumeParkedRepairs, routeFailedCheck, settleCheckRepairs, startCheckRepair } = await import("./check-repair.js");

const T0 = new Date("2026-11-07T12:00:00.000Z");
const REPO = "/repo";
const HEAD = "a".repeat(40);
const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };
const receipt = JSON.stringify({ result: { exitCode: 1 } });
let store: Store, taskRef: number, opened: number[];

const failedRun = (head = HEAD, n = 1) => {
  const run = opened[n - 1]!;
  store.recordOutcomeFacts(run, { headRevision: head });
  store.finishRun(run, { outcome: "built", committed: true, now: T0 });
  store.saveProofVerdict(run, "refuted", ["the check failed"], T0, [], "refuted");
  return run;
};
const sign = (attempts: number) => {
  const terms = { ...presetTerms("standard", new Date(T0.getTime() + 86_400_000).toISOString()), repairAuto: attempts > 0, repairMaxAttempts: attempts };
  store.signMode({ repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, T0);
};
const notifications = (like: string) => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM notification WHERE dedupe_key LIKE ?").get(like)?.["n"]);

beforeEach(() => {
  store = openStore(":memory:");
  store.createTask({ id: "t-1", title: "the work" }, T0);
  taskRef = store.refFor(BUILT_IN, "t-1").id;
  store.placeTask(taskRef, REPO);
  store.handle.exec("PRAGMA foreign_keys = OFF");
  // Opened before the plan: a run under a plan needs a whole agent route, which isn't what these rows are about.
  opened = [1, 2, 3].map(n => store.startRun({ taskRef, leaseId: `lease-${n}`, runner: "builder-1", branch: "feat/a", worktree: "/w", now: T0, ...legacy }));
  propose(store, { taskId: "t-1", goal: "the goal", touches: [], acceptance: [], now: T0 });
  addApprover(store, "alex", T0);
  hoisted.failure.mockReturnValue({ kind: "failed", digest: "x", receipt, log: "FAIL src/a.test.ts\nTests 1 failed\n" });
  hoisted.trigger.mockReset();
  hoisted.trigger.mockReturnValue({ kind: "drafted", draftTaskId: "t-1-v2", attempt: 1, approved: true });
});
afterEach(() => store.close());

describe("routing a failed check", () => {
  test("with no signed mode nothing is drafted and nothing spends: it waits for a person", () => {
    const run = failedRun();
    expect(routeFailedCheck(store, REPO, "/ev", run, T0)).toMatchObject({ state: "waiting", ownerTask: "t-1" });
    expect(hoisted.trigger).not.toHaveBeenCalled();
    expect(notifications("check-repair:%")).toBe(1);
  });

  test("a mode a person signed drafts through the ledger; the same failure on the same revision starts nothing more", () => {
    sign(2);
    const run = failedRun();
    expect(routeFailedCheck(store, REPO, "/ev", run, T0)).toMatchObject({ state: "repairing", repairTask: "t-1-v2", attempt: 1 });
    expect(hoisted.trigger).toHaveBeenCalledTimes(1);
    expect(hoisted.trigger.mock.calls[0]!.slice(5)).toEqual([T0, "verification", true]);
    routeFailedCheck(store, REPO, "/ev", run, T0);
    routeFailedCheck(store, REPO, "/ev", failedRun(HEAD, 2), T0);
    expect(hoisted.trigger).toHaveBeenCalledTimes(1);
    expect(checkRepairsOfTask(store, "t-1")).toHaveLength(1);
  });

  test("a different failure on the same revision is its own row; the same failure on a new revision is too", () => {
    const run = failedRun();
    routeFailedCheck(store, REPO, "/ev", run, T0);
    hoisted.failure.mockReturnValue({ kind: "failed", digest: "y", receipt, log: "FAIL src/b.test.ts\nTests 1 failed\n" });
    routeFailedCheck(store, REPO, "/ev", failedRun(HEAD, 2), T0);
    routeFailedCheck(store, REPO, "/ev", failedRun("b".repeat(40), 3), T0);
    expect(checkRepairsOfTask(store, "t-1")).toHaveLength(3);
    expect(failureKeyOf(receipt, "FAIL src/a.test.ts\nTests 1 failed\n")).not.toBe(failureKeyOf(receipt, "FAIL src/b.test.ts\nTests 1 failed\n"));
  });

  test("the limit goes to a person, with no draft", () => {
    sign(1);
    store.handle.prepare("INSERT INTO repair_chain (root_task, source_run, attempt, draft_task, basis, unresolved_json, outcome, created_at) VALUES ('t-1', 999, 1, 'x', 'human', '[]', 'drafted', ?)").run(T0.toISOString());
    expect(routeFailedCheck(store, REPO, "/ev", failedRun(), T0)).toMatchObject({ state: "with-person" });
    expect(hoisted.trigger).not.toHaveBeenCalled();
    expect(notifications("check-repair:%")).toBe(1);
  });

  test.each([
    ["a prepared candidate", () => propose(store, { taskId: "t-1", goal: "the goal", touches: [], acceptance: [], candidate: HEAD, now: T0 })],
  ])("%s: the plan doesn't cover a repair, so it asks a person", (_what, arrange) => {
    sign(3);
    arrange();
    expect(routeFailedCheck(store, REPO, "/ev", failedRun(), T0)).toMatchObject({ state: "with-person" });
    expect(hoisted.trigger).not.toHaveBeenCalled();
  });

  test("parked work stays quiet, and takes its step once it isn't parked", () => {
    sign(2);
    const run = failedRun();
    const hold = store.handle.prepare("INSERT INTO hold (task_ref, owner_kind, owner_id, reason, held_at) VALUES (?, 'operator', 'alex', 'wait', ?)").run(taskRef, T0.toISOString());
    expect(routeFailedCheck(store, REPO, "/ev", run, T0)).toMatchObject({ state: "parked" });
    expect(hoisted.trigger).not.toHaveBeenCalled();
    expect(notifications("check-repair:%")).toBe(0);
    expect(resumeParkedRepairs(store, "/ev", T0)).toBe(0);
    store.handle.prepare("DELETE FROM hold WHERE rowid = ?").run(hold.lastInsertRowid);
    expect(resumeParkedRepairs(store, "/ev", T0)).toBe(1);
    expect(checkRepairOfRun(store, run)).toMatchObject({ state: "repairing" });
  });

  test("a passing result ends the family's rows", () => {
    routeFailedCheck(store, REPO, "/ev", failedRun(), T0);
    settleCheckRepairs(store, "t-1", "refuted", T0);
    expect(checkRepairsOfTask(store, "t-1")[0]?.state).toBe("waiting");
    settleCheckRepairs(store, "t-1", "verified", T0);
    expect(checkRepairsOfTask(store, "t-1")[0]?.state).toBe("fixed");
  });
});

describe("a person starts the repair", () => {
  test("they ask for a draft, and it is not automatic: the ledger is told a person asked", () => {
    const run = failedRun();
    routeFailedCheck(store, REPO, "/ev", run, T0);
    hoisted.trigger.mockReturnValue({ kind: "drafted", draftTaskId: "t-1-v2", attempt: 1, approved: false });
    expect(startCheckRepair(store, "/ev", run, T0)).toEqual({ ok: true, draft: "t-1-v2", attempt: 1, approved: false });
    expect(hoisted.trigger.mock.calls[0]!.slice(5)).toEqual([T0, "verification", false]);
    expect(startCheckRepair(store, "/ev", run, T0)).toMatchObject({ ok: false, message: expect.stringContaining("already exists") });
    expect(hoisted.trigger).toHaveBeenCalledTimes(1);
  });

  test("a result with no failed check on record has nothing to start", () => {
    expect(startCheckRepair(store, "/ev", 12345, T0)).toMatchObject({ ok: false, reason: "unknown" });
  });
});
