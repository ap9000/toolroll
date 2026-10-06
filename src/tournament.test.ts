import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openStore, contestantProfileOf, type Store } from "./store.js";
import { fakePid } from "../test/fake-pid.js";
import { canonicalProfileJson, profileDigestOf } from "./scope.js";
import {
  raceDigestOf,
  jointApprovalDigest,
  planTournament, planComparison, comparisonDigestOf,
  admitContest,
  finalizeContestant,
  recoverContests,
  contestBranch,
  buildPickView,
  computePickPlan,
  pickTupleDigest,
  finalizeContestPick,
  abandonContest,
  nonceHashOf,
} from "./contest.js";
import { storeEvidence } from "./evidence.js";
import { classify } from "./board.js";
import { acquire, release } from "./claim.js";
import { register } from "./runner.js";
import { writeFileSync } from "node:fs";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const T0 = new Date("2026-08-17T12:00:00.000Z");

/** The runner gate (MCP spec v6): every acquisition authenticates the runner
 * and requires the task's PLACED repo to be in its registered list — racing
 * tests enroll their runner and place the raced task before claiming. */
const RACE_REPO = "/repo/race";
const tok = (name: string) => `tok-${name}`;
function enroll(store: Store, name: string, repos: string[] = [RACE_REPO]): void {
  register(store, { name, host: "test", capacity: 9, repos, now: T0, newToken: () => tok(name) });
}

describe("the v14 migration", () => {
  test("a pre-v14 database is really upgraded: old hold shape rebuilt, new columns added, rows kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v14-migrate-"));
    const file = join(dir, "orders.db");
    try {
      // Create current, then DOCTOR the file back to the v13 shape the
      // upgrade must recognize — this is the regression the live console
      // caught: a migration tail that never ran while the version stamp
      // said it had.
      let store = openStore(file);
      store.createTask({ id: "held-one", title: "held work" }, T0);
      const ref = store.refFor("built-in", "held-one", "ours").id;
      store.hold(ref, "waiting on a vendor", null, T0);
      store.close();

      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(file);
      raw.exec("PRAGMA foreign_keys = OFF");
      raw.exec(`CREATE TABLE hold_old (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_ref INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('operator','decision','incident','backoff')),
        owner_id TEXT NOT NULL, reason TEXT NOT NULL, until TEXT, held_at TEXT NOT NULL,
        UNIQUE (owner_kind, owner_id))`);
      raw.exec("INSERT INTO hold_old SELECT * FROM hold");
      raw.exec("DROP TABLE hold");
      raw.exec("ALTER TABLE hold_old RENAME TO hold");
      raw.exec("DROP TABLE service_cursor; UPDATE schema_version SET version = 13");
      raw.close();

      store = openStore(file);

      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
      const holds = store.activeHolds(ref, T0);
      expect(holds).toHaveLength(1);
      expect(holds[0]?.reason).toBe("waiting on a vendor");
      // The widened rule now admits tournament ownership — prove it by DDL.
      const raw2 = new DatabaseSync(file);
      const ddl = raw2.prepare("SELECT sql AS s FROM sqlite_master WHERE name = 'hold'").get() as { s: string };
      raw2.close();
      expect(ddl.s).toContain("'contest'");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tournament terms — immutable rows, one active pointer", () => {
  let store: Store;
  let taskRef: number;

  const AGENTS = [
    { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
    { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5" },
  ];

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    store.createTask({ id: "race-me", title: "the raced work" }, T0);
    taskRef = store.refFor("built-in", "race-me", "ours").id;
  });

  afterEach(() => store.close());

  const file = (digest = "race-digest-1") =>
    store.fileTournamentTerms(
      {
        taskRef,
        raceDigest: digest,
        agents: AGENTS,
        perAgentBudgetMicrousd: 5_000_000,
        overrunReserveMicrousd: 1_760_000,
        totalBudgetMicrousd: 13_520_000,
        priceVersion: 1,
        publicationPolicy: "none",
      },
      T0,
    );

  test("filing again moves the active pointer; the old row survives, deactivated", () => {
    const first = file("digest-a");
    const second = file("digest-b");
    const active = store.activeTournamentTerms(taskRef);
    expect(active?.id).toBe(second);
    expect(active?.generation).toBe(2);
    expect(active?.raceDigest).toBe("digest-b");
    expect(first).not.toBe(second);
  });

  test("approval binds to the exact digest of the active row", () => {
    const id = file("digest-a");
    expect(store.approveTournamentTerms(id, "alex", "some-other-digest", T0)).toBe(false);
    expect(store.approveTournamentTerms(id, "alex", "digest-a", T0)).toBe(true);
    expect(store.activeTournamentTerms(taskRef)?.approvedBy).toBe("alex");
  });
});

describe("contest and contestant state moves are compare-and-swap, generation-bumped", () => {
  let store: Store;
  let contest: number;
  let contestants: number[];

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    store.createTask({ id: "race-me", title: "raced" }, T0);
    const taskRef = store.refFor("built-in", "race-me", "ours").id;
    const terms = store.fileTournamentTerms(
      {
        taskRef,
        raceDigest: "d1",
        agents: [
          { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
          { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5" },
        ],
        perAgentBudgetMicrousd: 5_000_000,
        overrunReserveMicrousd: 1_000_000,
        totalBudgetMicrousd: 12_000_000,
        priceVersion: 1,
        publicationPolicy: "none",
      },
      T0,
    );
    contest = store.createContest({ taskRef, terms, scopeDigest: "s1", raceDigest: "d1" }, T0);
    contestants = store.createContestants(contest, [
      { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5", branch: `standing-orders/race-me/contest-${contest}/c1`, budgetMicrousd: 5_000_000, reserveMicrousd: 1_000_000 },
      { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5", branch: `standing-orders/race-me/contest-${contest}/c2`, budgetMicrousd: 5_000_000, reserveMicrousd: 1_000_000 },
    ]);
  });

  afterEach(() => store.close());

  test("a stale generation loses and changes nothing — whoever wins the race, wins alone", () => {
    const fresh = store.getContest(contest);
    expect(fresh?.state).toBe("dispatching");
    expect(store.casContestState(contest, ["dispatching"], "racing", 1)).toBe(true);
    // The loser (same expected generation) fails cleanly.
    expect(store.casContestState(contest, ["dispatching", "racing"], "interrupted", 1)).toBe(false);
    expect(store.getContest(contest)?.state).toBe("racing");
    expect(store.getContest(contest)?.generation).toBe(2);
  });

  test("exactly one live run per agent: the ADMISSION binds the lane's pointer inside the insert — a held lane admits no second run, a released lane admits the next, and a lane stamp that is not the lane's opens nothing", () => {
    const [first] = contestants;
    if (first === undefined) throw new Error("setup");
    const ref = store.refFor("built-in", "race-me").id;
    const rows = () => Number((store.raw().prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n);
    // THE LANE ADMISSION (atomic authority closure): the contest's live
    // custody — lease, runner, incarnation — is stamped first, exactly as
    // admitContest does, and every lane run opens through admitContestLane
    // under it; a refusal is words and zero rows.
    // The contest's stamped lease is the task's CURRENT live claim (final
    // authority closure): each lease the fixture stamps supersedes the
    // last as a newer claim generation, exactly as a real dispatch holds it.
    let generation = 0;
    const holdClaim = (lease: string) =>
      store
        .raw()
        .prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, ?, 'night-shift-1', ?, ?, ?)")
        .run(lease, ref, ++generation, T0.toISOString(), new Date(T0.getTime() + 900_000).toISOString(), T0.toISOString());
    const runOf = (lease: string, over: Record<string, unknown> = {}) => {
      store.stampContestLease(contest, lease, "night-shift-1", null);
      if (store.currentLiveLease(ref, T0) !== lease) holdClaim(lease);
      const admitted = store.admitContestLane({ taskRef: ref, leaseId: lease, runner: "night-shift-1", incarnation: null, branch: "standing-orders/race-me", worktree: "/pool/x", contestant: first, route: store.laneAuthorityFor(first)!, now: T0, ...over } as Parameters<Store["admitContestLane"]>[0]);
      if (!admitted.ok) throw new Error(admitted.problem);
      return admitted.runId;
    };
    // The generic admission opens nothing on a lane; a foreign digest, the
    // sealed route's leg instead of the lane's profile, a lane that is not
    // this task's: refused before any row.
    const before = rows();
    expect(() => store.startRun({ taskRef: ref, leaseId: "l-0", runner: "night-shift-1", branch: "standing-orders/race-me", worktree: "/pool/x", contestant: first, route: store.laneAuthorityFor(first)!, now: T0 } as never)).toThrow(/a contest lane's run is admitted by admitContestLane/);
    expect(() => runOf("l-0", { route: { ...store.laneAuthorityFor(first)!, routeDigest: "profile:" + "0".repeat(32) } })).toThrow(/a contest lane spends under its race-approved profile, not profile:0{32}/);
    expect(() => runOf("l-0", { route: { ...store.laneAuthorityFor(first)!, chosen: "recommended" } })).toThrow(/a contest lane spends under its race-approved profile \(a legacy stamp\)/);
    expect(() => runOf("l-0", { contestant: 9999, route: store.laneAuthorityFor(first)! })).toThrow(/contestant 9999 is not one of this task's racing agents/);
    // Live contest custody, exactly: a foreign runner, a lease the contest
    // does not hold, or another watch incarnation opens nothing.
    expect(() => runOf("l-0", { runner: "other-machine" })).toThrow(/the contest runs on night-shift-1 — a lane run on other-machine is another machine's/);
    expect(() => runOf("l-0", { leaseId: "l-foreign" })).toThrow(/the contest holds lease l-0 — a lane run under lease l-foreign is not its custody/);
    expect(() => runOf("l-0", { incarnation: "inc-b" })).toThrow(/the contest was dispatched by watch incarnation none, not inc-b/);
    // The STORED lane profile, exactly: a lane pinned to bypassPermissions
    // does not spend under the synthesized auto profile, and a lane whose
    // stored profile is gone has nothing to present.
    const laneRow = store.getContestant(first)!;
    const synthesized = `profile:${profileDigestOf(contestantProfileOf(laneRow.provider, laneRow.model, laneRow.repairModel))}`;
    store.raw().prepare("UPDATE contestant SET profile_json = ? WHERE id = ?").run(canonicalProfileJson(contestantProfileOf(laneRow.provider, laneRow.model, laneRow.repairModel, "bypassPermissions")), first);
    expect(store.laneAuthorityFor(first)!.routeDigest).not.toBe(synthesized);
    expect(() => runOf("l-0", { route: { ...store.laneAuthorityFor(first)!, routeDigest: synthesized } })).toThrow(/a contest lane spends under its race-approved profile, not profile:/);
    const pinnedStamp = store.laneAuthorityFor(first)!;
    store.raw().prepare("UPDATE contestant SET profile_json = NULL WHERE id = ?").run(first);
    expect(store.laneAuthorityFor(first)).toBeNull();
    expect(() => runOf("l-0", { route: pinnedStamp })).toThrow(/carries no sealed profile — nothing spends on the lane/);
    store.raw().prepare("UPDATE contestant SET profile_json = ? WHERE id = ?").run(canonicalProfileJson(laneRow.profile!), first);
    expect(rows()).toBe(before);
    // PROFILE-TO-COLUMNS PARITY (final authority closure): a profile_json
    // copied from another agent beside this lane's own provider and model
    // columns is a row two authorities wrote — the lane presents nothing,
    // and a stamp derived from it earlier is refused in words, no row.
    const [, second] = contestants;
    const secondRow = store.getContestant(second!)!;
    const laneStampBefore = store.laneAuthorityFor(first)!;
    store.raw().prepare("UPDATE contestant SET profile_json = ? WHERE id = ?").run(canonicalProfileJson(secondRow.profile!), first);
    expect(store.laneAuthorityFor(first)).toBeNull();
    expect(() => runOf("l-0", { route: { ...laneStampBefore, routeDigest: `profile:${profileDigestOf(secondRow.profile!)}` } })).toThrow(/stored profile \(claude · claude-haiku-4-5, repair claude-haiku-4-5\) is not the lane's own agent \(claude · claude-sonnet-5, repair claude-sonnet-5\)/);
    expect(() => runOf("l-0", { route: laneStampBefore })).toThrow(/is not the lane's own agent/);
    store.raw().prepare("UPDATE contestant SET repair_model = 'claude-opus-4-1' WHERE id = ?").run(first);
    store.raw().prepare("UPDATE contestant SET profile_json = ? WHERE id = ?").run(canonicalProfileJson(laneRow.profile!), first);
    expect(store.laneAuthorityFor(first)).toBeNull();
    expect(() => runOf("l-0", { route: laneStampBefore })).toThrow(/repair claude-sonnet-5\) is not the lane's own agent \(claude · claude-sonnet-5, repair claude-opus-4-1\)/);
    store.raw().prepare("UPDATE contestant SET repair_model = 'claude-sonnet-5' WHERE id = ?").run(first);
    expect(store.laneAuthorityFor(first)).toEqual(laneStampBefore);
    // A lane that has ended admits nothing, and presents nothing.
    store.raw().prepare("UPDATE contestant SET state = 'failed' WHERE id = ?").run(first);
    expect(store.laneAuthorityFor(first)).toBeNull();
    expect(() => runOf("l-0", { route: laneStampBefore })).toThrow(/is failed — a lane that has ended admits nothing/);
    store.raw().prepare("UPDATE contestant SET state = 'pending' WHERE id = ?").run(first);
    // CURRENT CUSTODY: the contest's stamped lease must be the task's live
    // claim right now — a lease nobody holds, or one a newer claim
    // superseded, opens nothing.
    store.stampContestLease(contest, "l-stale", "night-shift-1", null);
    expect(store.admitContestLane({ taskRef: ref, leaseId: "l-stale", runner: "night-shift-1", incarnation: null, branch: "standing-orders/race-me", worktree: "/pool/x", contestant: first, route: laneStampBefore, now: T0 })).toMatchObject({ ok: false, problem: expect.stringMatching(/the contest's lease l-stale is not this task's current live claim \(l-0 does\) — a lane run opens under live custody only/) });
    expect(rows()).toBe(before);
    expect(store.getContestant(first)).toMatchObject({ activeRun: null, generation: 1 });
    const runA = runOf("l-a");
    expect(store.getContestant(first)).toMatchObject({ activeRun: runA, generation: 2 });
    // The lane is held: a second admission refuses, no row.
    expect(() => runOf("l-b")).toThrow(/already holds run #\d+ — one live run per racing agent/);
    expect(rows()).toBe(before + 1);
    store.releaseContestantRun(first, runA);
    const runC = runOf("l-c");
    expect(store.getContestant(first)).toMatchObject({ activeRun: runC, generation: 3 });
    // A run on a contest that is no longer dispatching or racing: refused.
    store.releaseContestantRun(first, runC);
    const contestRow = store.getContestant(first)!;
    store.casContestState(contestRow.contest, ["dispatching"], "interrupted", store.getContest(contestRow.contest)!.generation);
    expect(() => runOf("l-d")).toThrow(/the contest is interrupted — its lanes admit nothing/);
  });

  test("money accumulates across the lineage; the latch charges the FULL reservation", () => {
    const [first] = contestants;
    if (first === undefined) throw new Error("setup");
    store.recordContestantSpend(first, 400_000); // the first invocation
    store.recordContestantSpend(first, 250_000); // its resume — real money too
    let row = store.getContestant(first);
    expect(row?.measuredMicrousd).toBe(650_000);
    expect(row?.accountedMicrousd).toBe(650_000);
    expect(row?.unknownSpend).toBe(false);
    // The invocation dies without reporting: charge budget + reserve, flag it.
    store.latchContestantUnknownSpend(first);
    row = store.getContestant(first);
    expect(row?.accountedMicrousd).toBe(6_000_000);
    expect(row?.measuredMicrousd).toBe(650_000); // the truth stays the truth
    expect(row?.unknownSpend).toBe(true);
  });
});

describe("worker-process slots and durable ceremony nonces", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
  });

  afterEach(() => store.close());

  test("a slot's whole life: reserved before spawn, running with its process group, released on exit", () => {
    store.createTask({ id: "slot-task", title: "work" }, T0);
    const ref = store.refFor("built-in", "slot-task", "ours").id;
    const run = store.startRun({ taskRef: ref, leaseId: "l-slot", runner: "night-shift-1", branch: "b", worktree: "/pool/s", ...bareLegacy("build", "claude", null), now: T0 });
    const [slot] = store.reserveExecutionSlots("night-shift-1", 1, T0);
    if (slot === undefined) throw new Error("setup");
    const group = fakePid(1), regrouped = fakePid(2), late = fakePid(3);
    expect(store.liveSlotCount("night-shift-1")).toBe(1);
    expect(store.markSlotRunning(slot, { run, processGroup: group, incarnation: "inc-1" }, T0)).toBe(true);
    expect(store.markSlotRunning(slot, { run }, T0)).toBe(false); // once
    expect(store.getExecutionSlot(slot)?.processGroup).toBe(group);
    expect(store.refreshSlotProcess(slot, { run, processGroup: regrouped, incarnation: "wrong" })).toBe(false);
    expect(store.refreshSlotProcess(slot, { run: run + 1, processGroup: regrouped, incarnation: "inc-1" })).toBe(false);
    expect(store.refreshSlotProcess(slot, { run, processGroup: regrouped, incarnation: "inc-1" })).toBe(true);
    expect(store.getExecutionSlot(slot)?.processGroup).toBe(regrouped);
    store.finishRun(run, { outcome: "no-change", now: T0 });
    expect(store.refreshSlotProcess(slot, { run, processGroup: late, incarnation: "inc-1" })).toBe(false);
    expect(store.releaseExecutionSlot(slot, T0)).toBe(true);
    expect(store.refreshSlotProcess(slot, { run, processGroup: late, incarnation: "inc-1" })).toBe(false);
    expect(store.releaseExecutionSlot(slot, T0)).toBe(false); // once
    expect(store.liveSlotCount("night-shift-1")).toBe(0);
  });

  test("a ceremony nonce is single-use, exact-match, and expires", () => {
    const minted = store.mintCeremonyNonce(
      { hash: "h1", approver: "alex", subject: "contest-pick", subjectId: 5, digest: "tuple-digest", ttlMs: 60_000 },
      T0,
    );
    expect(minted).toMatchObject({ ok: true });
    // Wrong digest: no.
    expect(store.consumeCeremonyNonce("h1", "alex", "contest-pick", 5, "tampered", T0)).toBe(false);
    // Right everything: once.
    expect(store.consumeCeremonyNonce("h1", "alex", "contest-pick", 5, "tuple-digest", T0)).toBe(true);
    expect(store.consumeCeremonyNonce("h1", "alex", "contest-pick", 5, "tuple-digest", T0)).toBe(false);
    // Expired ones refuse and sweep away.
    store.mintCeremonyNonce({ hash: "h2", approver: "alex", subject: "contest-pick", subjectId: 5, digest: "d", ttlMs: 1_000 }, T0);
    const later = new Date(T0.getTime() + 3_600_000);
    expect(store.consumeCeremonyNonce("h2", "alex", "contest-pick", 5, "d", later)).toBe(false);
    expect(store.sweepCeremonyNonces(later)).toBeGreaterThanOrEqual(1);
  });
});

describe("stage 3a — digests, planning, admission, children, recovery", () => {
  test("the race digest is order-sensitive; the joint digest covers both documents", () => {
    const base = {
      perAgentBudgetMicrousd: 5_000_000,
      totalBudgetMicrousd: 20_000_000,
      priceVersion: 1,
      publicationPolicy: "none",
    };
    const ab = raceDigestOf({ ...base, agents: [
      { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
      { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5" },
    ]});
    const ba = raceDigestOf({ ...base, agents: [
      { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5" },
      { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
    ]});
    expect(ab).not.toBe(ba);
    expect(jointApprovalDigest("s", ab)).not.toBe(jointApprovalDigest("s", ba));
  });

  test("planning refuses what money cannot bound, and the total must cover the TRUE worst case", () => {
    const codex = planTournament({
      agents: [{ provider: "codex", model: "gpt-5.2" }, { provider: "claude", model: "claude-sonnet-5" }],
      perAgentBudgetUsd: 5,
      totalBudgetUsd: 100,
    });
    expect(codex).toMatchObject({ ok: false, reason: "provider-ineligible" });
    expect(planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "mystery" }],
      perAgentBudgetUsd: 5, totalBudgetUsd: 100,
    })).toMatchObject({ ok: false, reason: "unpriced-model" });
    // sonnet tail = 200k*4 + 64k*15 = 1.76M microusd; two agents at $5:
    // true worst = 2 * (5 + 1.76) = 13.52 — a $13 total refuses, $14 admits.
    expect(planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "claude-sonnet-5" }],
      perAgentBudgetUsd: 5, totalBudgetUsd: 13,
    })).toMatchObject({ ok: false, reason: "over-total" });
    const good = planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "claude-sonnet-5" }],
      perAgentBudgetUsd: 5, totalBudgetUsd: 14,
    });
    if (!good.ok) throw new Error(good.reason);
    expect(good.plan.perAgentReserveMicrousd).toEqual([1_760_000, 1_760_000]);
  });

  const setUpApproved = (store: Store) => {
    enroll(store, "night-shift-1");
    store.createTask({ id: "race-3a", title: "raced" }, T0);
    const taskRef = store.refFor("built-in", "race-3a", "ours").id;
    store.placeTask(taskRef, RACE_REPO);
    const planned = planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "claude-haiku-4-5" }],
      perAgentBudgetUsd: 5,
      totalBudgetUsd: 20,
    });
    if (!planned.ok) throw new Error(planned.reason);
    const termsId = store.fileTournamentTerms(
      {
        taskRef,
        raceDigest: planned.plan.raceDigest,
        agents: planned.plan.agents,
        perAgentBudgetMicrousd: planned.plan.perAgentBudgetMicrousd,
        overrunReserveMicrousd: planned.plan.overrunReserveMicrousd,
        totalBudgetMicrousd: planned.plan.totalBudgetMicrousd,
        priceVersion: planned.plan.priceVersion,
        publicationPolicy: "none",
      },
      T0,
    );
    store.approveTournamentTerms(termsId, "alex", planned.plan.raceDigest, T0);
    const taken = acquire(store, taskRef, "night-shift-1", { token: tok("night-shift-1"), now: T0, ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim");
    return { taskRef, leaseId: taken.claim.leaseId };
  };

  const admit = (store: Store, taskRef: number, leaseId: string, overrides: Record<string, unknown> = {}) =>
    admitContest(
      store,
      {
        taskId: "race-3a",
        taskRef,
        runner: "night-shift-1",
        leaseId,
        incarnation: null,
        scopeDigest: "scope-d",
        scopeApproved: true,
        capacity: 8,
        quotaBlocked: () => null,
        ...overrides,
      } as never,
      T0,
    );

  test("admission is all or none: a capacity shortfall persists NOTHING", () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const { taskRef, leaseId } = setUpApproved(store);
    const refused = admit(store, taskRef, leaseId, { capacity: 1 });
    expect(refused).toMatchObject({ ok: false, reason: "capacity" });
    expect(store.openContestFor(taskRef)).toBeNull();
    expect(store.liveSlotCount("night-shift-1")).toBe(0);
    store.close();
  });

  test("admission proves quota per distinct key and refuses a doubled half-open key", () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const { taskRef, leaseId } = setUpApproved(store);
    expect(admit(store, taskRef, leaseId, { quotaBlocked: () => "exhausted" })).toMatchObject({ ok: false, reason: "quota" });
    expect(store.openContestFor(taskRef)).toBeNull();
    store.close();
  });

  test("the happy path creates the whole skeleton, slots bound to agents", () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const { taskRef, leaseId } = setUpApproved(store);
    const admitted = admit(store, taskRef, leaseId);
    if (!admitted.ok) throw new Error(admitted.reason);
    const contest = store.getContest(admitted.contestId);
    expect(contest?.state).toBe("dispatching");
    expect(contest?.currentLeaseId).toBe(leaseId);
    const agents = store.contestants(admitted.contestId);
    expect(agents).toHaveLength(2);
    expect(agents[0]?.branch).toBe(contestBranch("race-3a", admitted.contestId, 1));
    expect(agents[0]?.reserveMicrousd).toBe(1_760_000);
    expect(store.liveSlotCount("night-shift-1")).toBe(2);
    expect(store.getExecutionSlot(admitted.slotIds[0] as number)?.contestant).toBe(agents[0]?.id);
    // A second admission refuses: one tournament per task.
    expect(admit(store, taskRef, leaseId)).toMatchObject({ ok: false, reason: "contest-open" });
    store.close();
  });

  const raceToRacing = (store: Store) => {
    const { taskRef, leaseId } = setUpApproved(store);
    const admitted = admit(store, taskRef, leaseId);
    if (!admitted.ok) throw new Error(admitted.reason);
    const contest = store.getContest(admitted.contestId);
    if (contest === null) throw new Error("contest");
    for (const agent of store.contestants(admitted.contestId)) {
      store.casContestantState(agent.id, ["pending"], "ready", agent.generation);
    }
    store.casContestState(admitted.contestId, ["dispatching"], "racing", contest.generation);
    for (const agent of store.contestants(admitted.contestId)) {
      store.casContestantState(agent.id, ["ready"], "building", agent.generation);
    }
    return { taskRef, leaseId, contestId: admitted.contestId, slotIds: admitted.slotIds };
  };

  test("REGRESSION of the round-1 hole: the first agent finishing must NOT release the parent claim", () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const { taskRef, leaseId, contestId, slotIds } = raceToRacing(store);
    const [first, second] = store.contestants(contestId);
    if (first === undefined || second === undefined) throw new Error("setup");
    const run = store.startRun({ taskRef, leaseId, runner: "night-shift-1", branch: first.branch, worktree: "/pool/c1", ...bareLegacy("build", "claude", null), now: T0 });
    const one = finalizeContestant(
      store,
      { contestId, contestantId: first.id, runId: run, outcome: "built", measuredMicrousd: 900_000, slotId: slotIds[0] ?? null },
      T0,
    );
    expect(one.aggregated).toBeNull(); // the race is still on
    expect(store.liveClaimByLease(leaseId, T0)).not.toBeNull(); // THE claim survives
    expect(store.getContest(contestId)?.state).toBe("racing");
    // The second finishes: NOW the boundary crosses, once.
    const run2 = store.startRun({ taskRef, leaseId, runner: "night-shift-1", branch: second.branch, worktree: "/pool/c2", ...bareLegacy("build", "claude", null), now: T0 });
    const two = finalizeContestant(
      store,
      { contestId, contestantId: second.id, runId: run2, outcome: "failed", measuredMicrousd: 300_000, slotId: slotIds[1] ?? null },
      T0,
    );
    expect(two.aggregated).toBe("pick-wait");
    expect(store.liveClaimByLease(leaseId, T0)).toBeNull(); // released exactly here
    expect(store.getContest(contestId)?.state).toBe("pick-wait");
    // The contest-owned hold explains the stillness in plain words.
    const holds = store.activeHolds(taskRef, T0);
    expect(holds.some(hold => hold.reason.includes("compare the results and pick"))).toBe(true);
    store.close();
  });

  test("all agents failing ends in 'exhausted', never an automatic selection", () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const { taskRef, leaseId, contestId, slotIds } = raceToRacing(store);
    const agents = store.contestants(contestId);
    for (const [index, agent] of agents.entries()) {
      const run = store.startRun({ taskRef, leaseId, runner: "night-shift-1", branch: agent.branch, worktree: `/pool/c${index}`, ...bareLegacy("build", "claude", null), now: T0 });
      finalizeContestant(
        store,
        { contestId, contestantId: agent.id, runId: run, outcome: "failed", measuredMicrousd: null, slotId: slotIds[index] ?? null },
        T0,
      );
    }
    expect(store.getContest(contestId)?.state).toBe("exhausted");
    // measured-null latched the FULL reservation, honestly flagged.
    const after = store.contestants(contestId);
    expect(after[0]?.unknownSpend).toBe(true);
    expect(after[0]?.accountedMicrousd).toBe(after[0]!.budgetMicrousd + after[0]!.reserveMicrousd);
    store.close();
  });

  test("recovery: a dead lease interrupts the tournament; never-started agents stay at zero", () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const { taskRef, leaseId, contestId } = raceToRacing(store);
    const [first] = store.contestants(contestId);
    if (first === undefined) throw new Error("setup");
    // One agent actually started (run with provider start); the other never did.
    const laneAdmitted = store.admitContestLane({ taskRef, leaseId, runner: "night-shift-1", incarnation: null, branch: first.branch, worktree: "/pool/c1", contestant: first.id, route: store.laneAuthorityFor(first.id)!, now: T0 });
    if (!laneAdmitted.ok) throw new Error(laneAdmitted.problem);
    const run = laneAdmitted.runId;
    store.stampProviderStart(run, T0);
    release(store, leaseId, T0); // the daemon died; the reaper let go
    expect(recoverContests(store, T0)).toBe(1);
    expect(store.getContest(contestId)?.state).toBe("interrupted");
    const after = store.contestants(contestId);
    const started = after.find(one => one.id === first.id);
    const neverStarted = after.find(one => one.id !== first.id);
    expect(started?.unknownSpend).toBe(true);
    expect(neverStarted?.unknownSpend).toBe(false);
    expect(neverStarted?.accountedMicrousd).toBe(0);
    expect(store.liveSlotCount("night-shift-1")).toBe(0);
    store.close();
  });
});

describe("stage 3a — the CLI: filing with --race, one yes for both documents, the racing guard", () => {
  let dir: string;
  let db: string;
  let lines: string[];

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    dir = mkdtempSync(join(tmpdir(), "race-cli-"));
    db = join(dir, "orders.db");
    lines = [];
    const store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const { addApprover } = await import("./scope.js");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    store.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (line: string) => lines.push(line);
  const run = async (argv: string[]) => {
    const { runOperate } = await import("./operate.js");
    return runOperate(argv[0] as string, argv.slice(1), write, { databaseFile: db, now: T0 });
  };
  const payload = () => JSON.parse(lines.join("\n"));

  test("scope --race files both documents; the approval takes the JOINT fingerprint or refuses", async () => {
    const { EXIT } = await import("./operate.js");
    expect(await run(["task", "add", "race-cli", "--id", "race-cli", "--json"])).toBe(EXIT.ok);
    lines = [];
    const scoped = await run([
      "task", "scope", "race-cli",
      "--goal", "Build the export twice and let me pick", "--acceptance", "It is fixed and verified.|manual-review",
      "--race", "claude:claude-sonnet-5,claude:claude-haiku-4-5",
      "--race-per-usd", "5",
      "--race-total-usd", "20",
      "--json",
    ]);
    expect(scoped).toBe(EXIT.ok);
    const filed = payload();
    expect(filed.race.agents).toHaveLength(2);

    // Approving with the SCOPE digest alone refuses, naming the joint one.
    lines = [];
    const wrongDigest = await run([
      "task", "approve", "race-cli", "--yes",
      "--digest", filed.scope.digest,
      "--as", "alex", "--token", "wrong-not-checked-yet",
      "--json",
    ]);
    expect(wrongDigest).toBe(EXIT.refused);
    const refusal = payload().message as string;
    expect(refusal).toContain("joint fingerprint");
    const joint = /joint fingerprint ([0-9a-f]{64})/.exec(refusal)?.[1] as string;

    // The joint fingerprint, the password, one yes: both documents approve.
    lines = [];
    const approved = await run([
      "task", "approve", "race-cli", "--yes",
      "--digest", joint,
      "--as", "alex", "--token", "not-the-real-password",
      "--json",
    ]);
    // The token is wrong here (we never kept the minted one), so approval
    // refuses on CREDENTIALS — proving the digest gate passed first.
    expect(approved).toBe(EXIT.refused);
    expect(payload().reason).not.toBe("changed");

    // A codex agent is refused at filing, in words about turn-end usage.
    lines = [];
    const codex = await run([
      "task", "scope", "race-cli",
      "--goal", "g", "--acceptance", "It is fixed and verified.|manual-review",
      "--race", "codex:gpt-5.2,claude:claude-sonnet-5",
      "--race-per-usd", "5", "--race-total-usd", "50",
      "--json",
    ]);
    expect(codex).toBe(EXIT.refused);
    expect(payload().reason).toBe("provider-ineligible");
  });
});

describe("stage 3b — a whole tournament through the real tick, against real git", () => {
  test("two agents race, both finish, the pick-wait hold takes over, the money flags were real", async () => {
    const { mkdtemp, rm, mkdir, writeFile } = await import("node:fs/promises");
    const { runOperate } = await import("./operate.js");
    const { run: exec } = await import("./exec.js");
    const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

    const base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-race-e2e-")));
    const repo = join(base, "repo");
    const db = join(base, "queue.db");
    const pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    const git = (args: string[]) => exec("git", args, { cwd: repo });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "T"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);

    let lines: string[] = [];
    const seenArgv: string[][] = [];
    const agent = async (_file: string, args: readonly string[], options?: { cwd?: string }) => {
      seenArgv.push([...args]);
      const cwd = options?.cwd ?? "";
      await writeFile(join(cwd, `work-${seenArgv.length}.ts`), "export const raced = true;\n");
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      const name = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(join(cwd, name), JSON.stringify({ version: 1, status: "completed", conclusion: "did the thing" }));
      }
      return { ...OK, stdout: JSON.stringify({ result: "done", total_cost_usd: 0.42, usage: { input_tokens: 100, output_tokens: 50 } }) };
    };
    const run = (argv: string[], now = T0) => {
      const [command = "", ...rest] = argv;
      lines = [];
      return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: agent as never });
    };
    const payload = () => JSON.parse(lines.join("\n"));

    try {
      // The runner gate (MCP spec v6): the tick's claims authenticate the
      // runner and require the task's placed repo in its registered repos
      // list — the CLI register cannot bind repos, so builder-1 enrolls
      // against the store, and the task is placed at filing time.
      const boot = openStore(db);
      register(boot, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => tok("builder-1") });
      boot.close();
      const runnerToken = tok("builder-1");
      await run(["approver", "add", "alex", "--json"]);
      const approverToken = payload().token as string;
      // v24: approvals bind exact routing — the install names its model once.
      await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
      await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
      await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);

      await run(["task", "add", "the raced work", "--id", "race-e2e", "--repo", repo]);
      await run([
        "task", "scope", "race-e2e",
        "--goal", "add the guard twice and let me pick", "--acceptance", "It is fixed and verified.|manual-review",
        "--race", "claude:claude-sonnet-5,claude:claude-haiku-4-5",
        "--race-per-usd", "5", "--race-total-usd", "20",
        "--json",
      ]);
      const filed = payload();
      const joint = jointApprovalDigest(filed.scope.digest as string, filed.race.raceDigest as string);
      await run([
        "task", "approve", "race-e2e", "--yes",
        "--digest", joint, "--as", "alex", "--token", approverToken, "--json",
      ]);
      expect(payload().race.n).toBe(2);

      await run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"]);
      const ticked = payload();
      expect(ticked.dispatched[0]).toMatchObject({ id: "race-e2e", outcome: "contest", reason: "pick-wait" });

      const store = openStore(db);

      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
      const ref = store.refFor("built-in", "race-e2e").id;
      const contest = store.openContestFor(ref) ?? store.contestsInStates(["pick-wait"])[0];
      if (contest === undefined || contest === null) throw new Error("no contest");
      expect(contest.state).toBe("pick-wait");
      expect(contest.baseSha).toMatch(/^[0-9a-f]{40}$/);

      const agents = store.contestants(contest.id);
      expect(agents.map(one => one.state)).toEqual(["built", "built"]);
      // The provider reported $0.42 each; measured is the truth, in micro-dollars.
      expect(agents.map(one => one.measuredMicrousd)).toEqual([420_000, 420_000]);
      expect(agents.every(one => !one.unknownSpend)).toBe(true);

      // The parent claim is gone, the contest-owned hold explains the wait.
      expect(store.liveClaimByLease(contest.currentLeaseId as string, T0)).toBeNull();
      const holds = store.activeHolds(ref, T0);
      expect(holds.some(hold => hold.reason.includes("compare the results"))).toBe(true);

      // Each agent's run carries its identity and evidence — and its route
      // provenance, written at its insert (v48 integrity): the lane's own
      // race-approved profile, the exact pair it spent as.
      const { contestantProfileOf } = await import("./store.js");
      const { profileDigestOf } = await import("./scope.js");
      for (const racer of agents) {
        const runs = store.runsFor(ref).filter(one => one.branch === racer.branch);
        expect(runs).toHaveLength(1);
        const artifacts = store.artifactsFor(runs[0]!.id);
        expect(artifacts.some(one => one.kind === "terminal-diff")).toBe(true);
        expect(store.runRoute(runs[0]!.id)).toMatchObject({
          phase: "build", chosen: "legacy", provider: racer.provider, model: racer.model,
          routeDigest: `profile:${profileDigestOf(racer.profile ?? contestantProfileOf(racer.provider, racer.model, racer.repairModel))}`,
        });
        expect(runs[0]).toMatchObject({ chainCycle: null, contestant: racer.id });
      }

      // Both branches exist in the real repository, distinctly named.
      const branches = await git(["branch", "--list"]);
      expect(branches.stdout).toContain(`contest-${contest.id}/c1`);
      expect(branches.stdout).toContain(`contest-${contest.id}/c2`);

      // The native dollar cap rode BOTH spawns.
      expect(seenArgv).toHaveLength(2);
      for (const argv of seenArgv) {
        const at = argv.indexOf("--max-budget-usd");
        expect(at).toBeGreaterThan(-1);
        expect(argv[at + 1]).toBe("5");
      }
      // Worker-process slots all came home.
      expect(store.liveSlotCount("builder-1")).toBe(0);
      store.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("stage 4 — a racing agent parks, the answer resumes it, the tournament completes", () => {
  test("park → decision-wait → answer → resume on the SAME checkout → pick-wait; the answer reaches only its agent", async () => {
    const { mkdtemp, rm, mkdir, writeFile } = await import("node:fs/promises");
    const { runOperate } = await import("./operate.js");
    const { run: exec } = await import("./exec.js");
    const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

    // Keep `c1` in the parent path so lane detection must use the worktree's
    // contestant segment rather than accidentally matching a temp prefix.
    const base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-race-park-c1-")));
    const repo = join(base, "repo");
    const db = join(base, "queue.db");
    const pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    const git = (args: string[]) => exec("git", args, { cwd: repo });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "T"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);

    let lines: string[] = [];
    const prompts: string[] = [];
    const DECISION = {
      urgency: "blocking",
      recap: "Two export formats are possible and the scope names neither.",
      question: "CSV or JSON lines?",
      options: [
        { id: "csv", label: "CSV", consequence: "spreadsheet-friendly", reversible: true },
        { id: "jsonl", label: "JSON lines", consequence: "machine-friendly", reversible: true },
      ],
      recommendation: "jsonl",
    };
    // c1 parks on its first sight of the worktree, completes after that;
    // c2 completes immediately.
    const parkedOnce = new Set<string>();
    const agent = async (_file: string, args: readonly string[], options?: { cwd?: string }) => {
      const cwd = options?.cwd ?? "";
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      prompts.push(prompt);
      // Match the contestant segment, not an arbitrary `c1` in the random
      // temp-directory prefix (which can otherwise make every lane park).
      const isFirstAgent = /-c1-[0-9a-f]{8}$/.test(basename(cwd));
      if (isFirstAgent && !parkedOnce.has(cwd)) {
        parkedOnce.add(cwd);
        const name = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
        if (name === undefined) throw new Error("no mailbox named");
        await writeFile(join(cwd, name), JSON.stringify(DECISION));
        return { ...OK, stdout: JSON.stringify({ result: "parked", total_cost_usd: 0.1, usage: { input_tokens: 10, output_tokens: 5 } }) };
      }
      await writeFile(join(cwd, `work-${isFirstAgent ? "one" : "two"}.ts`), "export const raced = true;\n");
      const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
      if (done !== undefined) {
        await writeFile(join(cwd, done), JSON.stringify({ version: 1, status: "completed", conclusion: "picked a lane and finished" }));
      }
      return { ...OK, stdout: JSON.stringify({ result: "done", total_cost_usd: 0.3, usage: { input_tokens: 30, output_tokens: 15 } }) };
    };
    const run = (argv: string[], now = T0) => {
      const [command = "", ...rest] = argv;
      lines = [];
      return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: agent as never });
    };
    const payload = () => JSON.parse(lines.join("\n"));

    try {
      // The runner gate (MCP spec v6): builder-1 enrolls against the store
      // with the repo in its registered list; the task is placed at filing.
      const boot = openStore(db);
      register(boot, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => tok("builder-1") });
      boot.close();
      const runnerToken = tok("builder-1");
      await run(["approver", "add", "alex", "--json"]);
      const approverToken = payload().token as string;
      // v24: approvals bind exact routing — the install names its model once.
      await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
      await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
      await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
      await run(["task", "add", "the parked race", "--id", "race-park", "--repo", repo]);
      await run([
        "task", "scope", "race-park",
        "--goal", "export the data", "--acceptance", "It is fixed and verified.|manual-review",
        "--race", "claude:claude-sonnet-5,claude:claude-haiku-4-5",
        "--race-per-usd", "5", "--race-total-usd", "20", "--json",
      ]);
      const filed = payload();
      const joint = jointApprovalDigest(filed.scope.digest as string, filed.race.raceDigest as string);
      await run(["task", "approve", "race-park", "--yes", "--digest", joint, "--as", "alex", "--token", approverToken, "--json"]);

      // First pass: c1 parks its question, c2 finishes → decision-wait.
      await run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"]);
      expect(payload().dispatched[0]).toMatchObject({ id: "race-park", outcome: "contest", reason: "decision-wait" });

      const store = openStore(db);

      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
      const ref = store.refFor("built-in", "race-park").id;
      const contest = store.contestsInStates(["decision-wait"])[0];
      if (contest === undefined) throw new Error("no waiting tournament");
      const [c1] = store.contestants(contest.id);
      expect(c1?.state).toBe("parked");
      expect(c1?.custody).toContain("builder-1"); // custody recorded at park
      const question = store.openDecisionForContestant(c1!.id);
      expect(question).not.toBeNull();
      store.close();

      // The operator answers; the next pass resumes ONLY that agent.
      await run(["decide", String(question), "--choose", "jsonl", "--as", "alex", "--token", approverToken, "--json"]);
      const before = prompts.length;
      await run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"], new Date(T0.getTime() + 60_000));
      const resumedReport = payload();
      expect(resumedReport.dispatched[0]).toMatchObject({ id: "race-park", outcome: "contest", reason: "pick-wait" });
      // Exactly one new spawn (the resumed agent), and its brief carried the answer.
      expect(prompts.length).toBe(before + 1);
      expect(prompts[prompts.length - 1]).toContain("JSON lines");

      const after = openStore(db);
      const finished = after.contestsInStates(["pick-wait"])[0];
      if (finished === undefined) throw new Error("not pick-wait");
      const racers = after.contestants(finished.id);
      expect(racers.map(one => one.state)).toEqual(["built", "built"]);
      // c1's money spans its lineage: the park's $0.10 plus the resume's $0.30.
      expect(racers[0]?.measuredMicrousd).toBe(400_000);
      expect(after.liveSlotCount("builder-1")).toBe(0);
      after.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  test("the exclude ceremony: a question nobody will answer stops its agent and un-sticks the race", () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    store.createTask({ id: "race-x", title: "raced" }, T0);
    const taskRef = store.refFor("built-in", "race-x", "ours").id;
    const terms = store.fileTournamentTerms(
      {
        taskRef,
        raceDigest: "d",
        agents: [
          { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
          { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5" },
        ],
        perAgentBudgetMicrousd: 5_000_000,
        overrunReserveMicrousd: 1_000_000,
        totalBudgetMicrousd: 20_000_000,
        priceVersion: 1,
        publicationPolicy: "none",
      },
      T0,
    );
    const contest = store.createContest({ taskRef, terms, scopeDigest: "s", raceDigest: "d" }, T0);
    const ids = store.createContestants(contest, [
      { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5", branch: "b1", budgetMicrousd: 5_000_000, reserveMicrousd: 1_000_000 },
      { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5", branch: "b2", budgetMicrousd: 5_000_000, reserveMicrousd: 1_000_000 },
    ]);
    // c2 already built; c1 parked with an open question → decision-wait.
    store.stampContestLease(contest, "l1", "r", null);
    store.raw().prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES ('l1', ?, 1, 'r', ?, ?, ?)").run(taskRef, T0.toISOString(), new Date(T0.getTime() + 900_000).toISOString(), T0.toISOString());
    const lane1 = store.admitContestLane({ taskRef, leaseId: "l1", runner: "r", incarnation: null, branch: "b1", worktree: "/p/1", contestant: ids[0]!, route: store.laneAuthorityFor(ids[0]!)!, now: T0 });
    if (!lane1.ok) throw new Error(lane1.problem);
    const run1 = lane1.runId;
    store.saveDecision(
      { run: run1, contestant: ids[0], urgency: "blocking", recap: "r", question: "q?", options: [{ id: "a", label: "A", consequence: "c", reversible: true }], recommendation: "a" },
      T0,
    );
    store.casContestantState(ids[0]!, ["pending"], "parked", 1);
    store.casContestantState(ids[1]!, ["pending"], "built", 1);
    store.casContestState(contest, ["dispatching"], "decision-wait", 1);

    const question = store.openDecisionForContestant(ids[0]!);
    expect(question).not.toBeNull();
    expect(store.excludeDecision(question!, "alex", T0)).toBe(true);
    const c1 = store.getContestant(ids[0]!);
    store.casContestantState(ids[0]!, ["parked"], "stopped", c1!.generation);
    // Aggregation now sees no waiting question and one built agent.
    store.casContestState(contest, ["decision-wait"], "pick-wait", store.getContest(contest)!.generation);
    expect(store.getContest(contest)?.state).toBe("pick-wait");
    // The closure is typed, never a fake option.
    expect(store.getDecision(question!)?.state).toBe("answered");
    store.close();
  });
});

describe("v15 — dollar thresholds: per-task terms, global defaults, real enforcement", () => {
  let dir: string;
  let db: string;
  let lines: string[];
  let alexToken: string;

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    dir = mkdtempSync(join(tmpdir(), "budgets-"));
    db = join(dir, "orders.db");
    lines = [];
    const store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const { addApprover } = await import("./scope.js");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    alexToken = added.token;
    store.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (line: string) => lines.push(line);
  const run = async (argv: string[]) => {
    const { runOperate } = await import("./operate.js");
    return runOperate(argv[0] as string, argv.slice(1), write, { databaseFile: db, now: T0 });
  };
  const payload = () => JSON.parse(lines.join("\n"));

  test("a per-task budget is a digest-bound scope term the description says out loud", async () => {
    const { EXIT } = await import("./operate.js");
    await run(["task", "add", "capped", "--id", "capped", "--json"]);
    lines = [];
    expect(await run(["task", "scope", "capped", "--goal", "do the thing", "--acceptance", "It is fixed and verified.|manual-review", "--budget-usd", "3.50", "--json"])).toBe(EXIT.ok);
    const scoped = payload().scope;
    expect(scoped.budgetMicrousd).toBe(3_500_000);
    // Editing the budget changes the digest — the old approval strands.
    lines = [];
    await run(["task", "scope", "capped", "--goal", "do the thing", "--acceptance", "It is fixed and verified.|manual-review", "--budget-usd", "9", "--json"]);
    expect(payload().scope.digest).not.toBe(scoped.digest);
    // And a scope WITHOUT a budget digests exactly as it always did.
    lines = [];
    await run(["task", "add", "plain", "--id", "plain", "--json"]);
    lines = [];
    await run(["task", "scope", "plain", "--goal", "do the thing", "--acceptance", "It is fixed and verified.|manual-review", "--json"]);
    expect(payload().scope.budgetMicrousd).toBeNull();
  });

  test("global defaults pre-fill filings; explicit flags always win", async () => {
    lines = [];
    await run(["config", "set", "budgets", "--build-usd", "2", "--race-per-usd", "4", "--race-total-usd", "16", "--as", "alex", "--token", alexToken, "--json"]);
    expect(payload().budgets.buildPerRunMicrousd).toBe(2_000_000);

    // A filing with no flags inherits; the race digest binds the numbers.
    await run(["task", "add", "defaulted", "--id", "defaulted", "--json"]);
    lines = [];
    await run(["task", "scope", "defaulted", "--goal", "g", "--acceptance", "It is fixed and verified.|manual-review", "--race", "claude:claude-sonnet-5,claude:claude-haiku-4-5", "--json"]);
    const filed = payload();
    expect(filed.scope.budgetMicrousd).toBe(2_000_000);
    expect(filed.race.perAgentBudgetMicrousd).toBe(4_000_000);
    expect(filed.race.totalBudgetMicrousd).toBe(16_000_000);

    // Explicit beats default.
    await run(["task", "add", "explicit", "--id", "explicit", "--json"]);
    lines = [];
    await run(["task", "scope", "explicit", "--goal", "g", "--acceptance", "It is fixed and verified.|manual-review", "--budget-usd", "7", "--json"]);
    expect(payload().scope.budgetMicrousd).toBe(7_000_000);
  });
});

describe("stage 5 — pickability, the tuple digest, and the pick/abandon ceremonies", () => {
  let store: Store;
  let root: string;

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    root = mkdtempSync(join(tmpdir(), "standing-orders-pick-"));
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Drive a two-agent tournament to 'racing' with real terms and a claim. */
  const toRacing = (taskId = "race-5") => {
    enroll(store, "night-shift-1");
    store.createTask({ id: taskId, title: "raced work" }, T0);
    const taskRef = store.refFor("built-in", taskId, "ours").id;
    store.placeTask(taskRef, RACE_REPO);
    const planned = planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "claude-haiku-4-5" }],
      perAgentBudgetUsd: 5,
      totalBudgetUsd: 20,
    });
    if (!planned.ok) throw new Error(planned.reason);
    const termsId = store.fileTournamentTerms(
      {
        taskRef,
        raceDigest: planned.plan.raceDigest,
        agents: planned.plan.agents,
        perAgentBudgetMicrousd: planned.plan.perAgentBudgetMicrousd,
        overrunReserveMicrousd: planned.plan.overrunReserveMicrousd,
        totalBudgetMicrousd: planned.plan.totalBudgetMicrousd,
        priceVersion: planned.plan.priceVersion,
        publicationPolicy: "none",
      },
      T0,
    );
    store.approveTournamentTerms(termsId, "alex", planned.plan.raceDigest, T0);
    const taken = acquire(store, taskRef, "night-shift-1", { token: tok("night-shift-1"), now: T0, ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim");
    const admitted = admitContest(
      store,
      {
        taskId,
        taskRef,
        runner: "night-shift-1",
        leaseId: taken.claim.leaseId,
        incarnation: null,
        scopeDigest: "scope-d",
        scopeApproved: true,
        capacity: 8,
        quotaBlocked: () => null,
      } as never,
      T0,
    );
    if (!admitted.ok) throw new Error(admitted.reason);
    store.stampContestDispatch(admitted.contestId, "base-sha-000", null);
    const contest = store.getContest(admitted.contestId);
    if (contest === null) throw new Error("contest");
    for (const agent of store.contestants(admitted.contestId)) {
      store.casContestantState(agent.id, ["pending"], "ready", agent.generation);
    }
    store.casContestState(admitted.contestId, ["dispatching"], "racing", contest.generation);
    for (const agent of store.contestants(admitted.contestId)) {
      store.casContestantState(agent.id, ["ready"], "building", agent.generation);
    }
    return { taskId, taskRef, leaseId: taken.claim.leaseId, contestId: admitted.contestId, slotIds: admitted.slotIds };
  };

  /** Finish one agent the way the builder would: run, evidence, facts, finalize. */
  const finish = (
    race: { taskRef: number; leaseId: string; contestId: number; slotIds: number[] },
    contestant: { id: number; branch: string },
    spec: {
      outcome: "built" | "failed" | "no-change";
      committed?: boolean;
      head?: string;
      handoff?: string;
      measured?: number;
      slot?: number | null;
      evidence?: "ok" | "failed-capture" | "none";
    },
  ) => {
    const laneAdmitted = store.admitContestLane({
      taskRef: race.taskRef,
      leaseId: race.leaseId,
      runner: "night-shift-1",
      incarnation: null,
      branch: contestant.branch,
      worktree: `/pool/${contestant.id}`,
      contestant: contestant.id,
      // The lane's authority, presented — the admission proves and binds
      // the lane inside the insert (raw authority repair).
      route: store.laneAuthorityFor(contestant.id)!,
      now: T0,
    });
    if (!laneAdmitted.ok) throw new Error(laneAdmitted.problem);
    const runId = laneAdmitted.runId;
    if (spec.evidence !== "none") {
      const failed = spec.evidence === "failed-capture";
      storeEvidence(store, root, runId, "terminal-diff", "terminal-diff.patch",
        Buffer.from("diff --git a/x b/x\n+won\n", "utf8"), "git diff (exit 0)", T0,
        { captureStatus: failed ? "failed" : "ok" });
      storeEvidence(store, root, runId, "diff-stat", "terminal-diff-stat.json",
        Buffer.from(JSON.stringify({ base: "base-sha-000", head: spec.head ?? "base-sha-000", fileCount: 1, additions: 1, deletions: 0, binaryCount: 0, filesTruncated: false, files: [] }), "utf8"),
        "git diff --numstat (exit 0)", T0, { captureStatus: "ok" });
    }
    store.recordOutcomeFacts(runId, { headRevision: spec.head ?? "base-sha-000", handoff: spec.handoff ?? "done" });
    store.finishRun(runId, {
      outcome: spec.outcome,
      ...(spec.committed === undefined ? {} : { committed: spec.committed }),
      now: T0,
    });
    finalizeContestant(
      store,
      {
        contestId: race.contestId,
        contestantId: contestant.id,
        runId,
        // A verified no-change concludes the AGENT as 'built' — the run's
        // own outcome keeps the distinction the pick predicate reads.
        outcome: spec.outcome === "no-change" ? "built" : spec.outcome,
        ...(spec.committed === undefined ? {} : { committed: spec.committed }),
        measuredMicrousd: spec.measured ?? 400_000,
        slotId: spec.slot ?? null,
      } as never,
      T0,
    );
    return runId;
  };

  test("pickability is the evidence predicate, stated in plain words when it refuses", () => {
    const race = toRacing();
    const [first, second] = store.contestants(race.contestId);
    if (first === undefined || second === undefined) throw new Error("setup");
    // First: a real committed result with verified evidence.
    finish(race, first, { outcome: "built", committed: true, head: "head-aaa", slot: race.slotIds[0] });
    // Second: finished but never committed — unpickable, and it says why.
    finish(race, second, { outcome: "built", committed: false, slot: race.slotIds[1] });
    expect(store.getContest(race.contestId)?.state).toBe("pick-wait");
    const view = buildPickView(store, root, race.contestId);
    if (view === null) throw new Error("view");
    expect(view.agents[0]?.pickable).toBe(true);
    expect(view.agents[1]?.pickable).toBe(false);
    expect(view.agents[1]?.unpickableReason).toContain("without committing");
    // The pick-wait boundary paged, once, with the contest address.
    const paged = store.listNotifications("pending").find(one => one.kind === "contest-finished");
    expect(paged?.body).toContain(`/contest/${race.contestId}`);
  });

  test("a verified no-change is pickable only while the branch really did not move", () => {
    const race = toRacing();
    const [first, second] = store.contestants(race.contestId);
    if (first === undefined || second === undefined) throw new Error("setup");
    finish(race, first, { outcome: "no-change", committed: false, head: "base-sha-000", slot: race.slotIds[0] });
    finish(race, second, { outcome: "no-change", committed: false, head: "moved-sha", slot: race.slotIds[1] });
    const view = buildPickView(store, root, race.contestId);
    expect(view?.agents[0]?.pickable).toBe(true);
    expect(view?.agents[1]?.pickable).toBe(false);
    expect(view?.agents[1]?.unpickableReason).toContain("branch moved");
  });

  test("evidence decides: a failed capture or tampered bytes make a result unpickable", () => {
    const race = toRacing();
    const [first, second] = store.contestants(race.contestId);
    if (first === undefined || second === undefined) throw new Error("setup");
    const runId = finish(race, first, { outcome: "built", committed: true, head: "head-aaa", slot: race.slotIds[0] });
    finish(race, second, { outcome: "built", committed: true, head: "head-bbb", slot: race.slotIds[1], evidence: "failed-capture" });
    expect(buildPickView(store, root, race.contestId)?.agents[1]?.pickable).toBe(false);
    // Now tamper the first agent's stored patch: bytes stop verifying.
    writeFileSync(join(root, String(runId), "terminal-diff.patch"), "not what was hashed");
    const after = buildPickView(store, root, race.contestId);
    expect(after?.agents[0]?.pickable).toBe(false);
    expect(after?.agents[0]?.unpickableReason).toContain("no longer verify");
  });

  const toPickWait = () => {
    const race = toRacing();
    const [first, second] = store.contestants(race.contestId);
    if (first === undefined || second === undefined) throw new Error("setup");
    const winnerRun = finish(race, first, { outcome: "built", committed: true, head: "head-aaa", handoff: "swapped the guard", measured: 700_000, slot: race.slotIds[0] });
    finish(race, second, { outcome: "built", committed: false, slot: race.slotIds[1] });
    return { ...race, first, second, winnerRun };
  };

  test("the whole pick, one transaction: nonce consumed, winner stamped, hold lifted, task done — and a replay refuses", () => {
    const race = toPickWait();
    const view = buildPickView(store, root, race.contestId);
    if (view === null) throw new Error("view");
    const plan = computePickPlan(store, view, race.first.id, null, "ours");
    if (!plan.ok) throw new Error(plan.message);
    const nonceValue = "nonce-value-1";
    const minted = store.mintCeremonyNonce(
      { hash: nonceHashOf(nonceValue), approver: "alex", subject: "contest-pick", subjectId: race.contestId, digest: plan.digest, ttlMs: 900_000 },
      T0,
    );
    expect(minted.ok).toBe(true);
    const picked = finalizeContestPick(store, {
      contestId: race.contestId, contestantId: race.first.id, approver: "alex",
      nonceValue, evidenceRoot: root, repo: null, taskId: race.taskId, refOrigin: "ours",
    }, T0);
    expect(picked).toMatchObject({ ok: true, state: "picked", publicationIntent: null });
    const contest = store.getContest(race.contestId);
    expect(contest?.state).toBe("picked");
    expect(contest?.winnerContestant).toBe(race.first.id);
    expect(contest?.pickedBy).toBe("alex");
    expect(store.getTask(race.taskId)?.state).toBe("done");
    expect(store.activeHolds(race.taskRef, T0)).toHaveLength(0);
    for (const agent of store.contestants(race.contestId)) expect(agent.cleanup).toBe("pending");
    // Replay: the nonce is gone, and so is the pick-wait state.
    const again = finalizeContestPick(store, {
      contestId: race.contestId, contestantId: race.first.id, approver: "alex",
      nonceValue, evidenceRoot: root, repo: null, taskId: race.taskId, refOrigin: "ours",
    }, T0);
    expect(again).toMatchObject({ ok: false, reason: "not-waiting" });
  });

  test("the nonce binds the exact selection: minted for one agent, it will not pick another", () => {
    const race = toPickWait();
    // Make the second agent pickable too, so only the digest can refuse.
    const view0 = buildPickView(store, root, race.contestId);
    if (view0 === null) throw new Error("view");
    const plan = computePickPlan(store, view0, race.first.id, null, "ours");
    if (!plan.ok) throw new Error(plan.message);
    store.mintCeremonyNonce(
      { hash: nonceHashOf("nonce-x"), approver: "alex", subject: "contest-pick", subjectId: race.contestId, digest: plan.digest, ttlMs: 900_000 },
      T0,
    );
    const wrong = finalizeContestPick(store, {
      contestId: race.contestId, contestantId: race.second.id, approver: "alex",
      nonceValue: "nonce-x", evidenceRoot: root, repo: null, taskId: race.taskId, refOrigin: "ours",
    }, T0);
    expect(wrong.ok).toBe(false);
  });

  test("evidence tampered between the confirmation screen and the yes: the pick refuses", () => {
    const race = toPickWait();
    const view = buildPickView(store, root, race.contestId);
    if (view === null) throw new Error("view");
    const plan = computePickPlan(store, view, race.first.id, null, "ours");
    if (!plan.ok) throw new Error(plan.message);
    store.mintCeremonyNonce(
      { hash: nonceHashOf("nonce-t"), approver: "alex", subject: "contest-pick", subjectId: race.contestId, digest: plan.digest, ttlMs: 900_000 },
      T0,
    );
    writeFileSync(join(root, String(race.winnerRun), "terminal-diff.patch"), "tampered after the screen");
    const refused = finalizeContestPick(store, {
      contestId: race.contestId, contestantId: race.first.id, approver: "alex",
      nonceValue: "nonce-t", evidenceRoot: root, repo: null, taskId: race.taskId, refOrigin: "ours",
    }, T0);
    expect(refused.ok).toBe(false);
    expect(store.getContest(race.contestId)?.state).toBe("pick-wait"); // nothing moved
  });

  test("a committed winner under a live grant creates the publication intent — the same predicate as an ordinary build", () => {
    const race = toPickWait();
    store.placeTask(race.taskRef, "/repos/thing");
    store.savePublicationGrant(
      { repo: "/repos/thing", githubRepo: "ap9000/thing", remote: "origin", headPrefix: "standing-orders/", base: "main", capabilities: ["pr"], selector: "all", draft: true, grantedBy: "alex" },
      T0,
    );
    const view = buildPickView(store, root, race.contestId);
    if (view === null) throw new Error("view");
    const plan = computePickPlan(store, view, race.first.id, "/repos/thing", "ours");
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.publishable).toBe(true);
    store.mintCeremonyNonce(
      { hash: nonceHashOf("nonce-g"), approver: "alex", subject: "contest-pick", subjectId: race.contestId, digest: plan.digest, ttlMs: 900_000 },
      T0,
    );
    const picked = finalizeContestPick(store, {
      contestId: race.contestId, contestantId: race.first.id, approver: "alex",
      nonceValue: "nonce-g", evidenceRoot: root, repo: "/repos/thing", taskId: race.taskId, refOrigin: "ours",
    }, T0);
    if (!picked.ok) throw new Error(picked.message);
    expect(picked.publicationIntent).not.toBeNull();
  });

  test("abandon: password-and-nonce like the pick — the task fails requeueably, everything is kept", () => {
    const race = toPickWait();
    const view = buildPickView(store, root, race.contestId);
    if (view === null) throw new Error("view");
    const digest = pickTupleDigest(view, { abandon: true }, { grant: null, head: null });
    store.mintCeremonyNonce(
      { hash: nonceHashOf("nonce-a"), approver: "alex", subject: "contest-abandon", subjectId: race.contestId, digest, ttlMs: 900_000 },
      T0,
    );
    const gone = abandonContest(store, { contestId: race.contestId, approver: "alex", nonceValue: "nonce-a", evidenceRoot: root, taskId: race.taskId }, T0);
    expect(gone.ok).toBe(true);
    expect(store.getContest(race.contestId)?.state).toBe("abandoned");
    expect(store.getTask(race.taskId)?.state).toBe("failed");
    expect(store.activeHolds(race.taskRef, T0)).toHaveLength(0);
    expect(store.runsFor(race.taskRef).length).toBeGreaterThan(0); // nothing deleted
  });

  test("the board reads a finished tournament as needs-you, addressed at the comparison screen", () => {
    const race = toPickWait();
    const facts = store.boardScoped(null, T0, 200, null).tasks.find(one => one.taskId === race.taskId);
    if (facts === undefined) throw new Error("no board row");
    expect(facts.contest).toMatchObject({ state: "pick-wait", agents: 2 });
    const card = classify(facts, T0);
    expect(card.lane).toBe("attention");
    expect(card.href).toBe(`/contest/${race.contestId}`);
    expect(card.reason).toContain("compare");
  });
});

describe("stage 6 — the agent count knob, per-run routine caps, cleanup, and the 14-day escalation", () => {
  test("--race-count replicates one named agent; a contradictory count refuses; count without --race refuses", async () => {
    const { mkdtempSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "race-count-"));
    const db = join(dir, "orders.db");
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const { runOperate, EXIT } = await import("./operate.js");
    const run = (argv: string[]) => runOperate(argv[0] as string, argv.slice(1), write, { databaseFile: db, now: T0 });
    try {
      const bootstrap = openStore(db);
      const { addApprover } = await import("./scope.js");
      if (!addApprover(bootstrap, "alex", T0).ok) throw new Error("bootstrap");
      bootstrap.close();
      expect(await run(["task", "add", "count-cli", "--id", "count-cli", "--json"])).toBe(EXIT.ok);

      lines.length = 0;
      expect(await run([
        "task", "scope", "count-cli", "--goal", "g", "--acceptance", "It is fixed and verified.|manual-review",
        "--race", "claude:claude-sonnet-5", "--race-count", "3",
        "--race-per-usd", "5", "--race-total-usd", "30", "--json",
      ])).toBe(EXIT.ok);
      expect(JSON.parse(lines.join("\n")).race.agents).toHaveLength(3);

      lines.length = 0;
      expect(await run([
        "task", "scope", "count-cli", "--goal", "g", "--acceptance", "It is fixed and verified.|manual-review",
        "--race", "claude:claude-sonnet-5,claude:claude-haiku-4-5", "--race-count", "3",
        "--race-per-usd", "5", "--race-total-usd", "30", "--json",
      ])).toBe(EXIT.usage);
      expect(JSON.parse(lines.join("\n")).message).toContain("make them agree");

      lines.length = 0;
      expect(await run(["task", "scope", "count-cli", "--goal", "g", "--acceptance", "It is fixed and verified.|manual-review", "--race-count", "3", "--json"])).toBe(EXIT.usage);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the configured default count replicates a single named agent — an explicit lineup is always itself", async () => {
    const { mkdtempSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "race-default-"));
    const db = join(dir, "orders.db");
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const { runOperate, EXIT } = await import("./operate.js");
    const run = (argv: string[]) => runOperate(argv[0] as string, argv.slice(1), write, { databaseFile: db, now: T0 });
    try {
      const bootstrap = openStore(db);
      const { addApprover } = await import("./scope.js");
      const added = addApprover(bootstrap, "alex", T0);
      if (!added.ok) throw new Error("bootstrap");
      bootstrap.close();
      expect(await run([
        "config", "set", "budgets", "--race-agents", "3",
        "--race-per-usd", "5", "--race-total-usd", "30",
        "--as", "alex", "--token", added.token, "--json",
      ])).toBe(EXIT.ok);
      expect(await run(["task", "add", "default-cli", "--id", "default-cli", "--json"])).toBe(EXIT.ok);

      // One named agent, no count: the default replicates it to three.
      lines.length = 0;
      expect(await run([
        "task", "scope", "default-cli", "--goal", "g", "--acceptance", "It is fixed and verified.|manual-review",
        "--race", "claude:claude-sonnet-5", "--json",
      ])).toBe(EXIT.ok);
      expect(JSON.parse(lines.join("\n")).race.agents).toHaveLength(3);

      // An explicit two-agent lineup stays two — the default never edits it.
      lines.length = 0;
      expect(await run([
        "task", "scope", "default-cli", "--goal", "g", "--acceptance", "It is fixed and verified.|manual-review",
        "--race", "claude:claude-sonnet-5,claude:claude-haiku-4-5", "--json",
      ])).toBe(EXIT.ok);
      expect(JSON.parse(lines.join("\n")).race.agents).toHaveLength(2);

      // config clear budgets resets the agent count too — the store nulls
      // every omitted key (round-4 finding 11 recast as this regression):
      // after the clear, one named agent no longer replicates to three, so
      // the filing refuses for being a one-agent tournament.
      lines.length = 0;
      expect(await run(["config", "clear", "budgets", "--as", "alex", "--token", added.token, "--json"])).toBe(EXIT.ok);
      lines.length = 0;
      expect(await run([
        "task", "scope", "default-cli", "--goal", "g", "--acceptance", "It is fixed and verified.|manual-review",
        "--race", "claude:claude-sonnet-5", "--race-per-usd", "5", "--race-total-usd", "30", "--json",
      ])).toBe(EXIT.refused);
      expect(JSON.parse(lines.join("\n")).message).toContain("2 to 4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing race budget names the missing flag and the way to default it; a bad budgets value names its flag", async () => {
    const { mkdtempSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "race-budget-msg-"));
    const db = join(dir, "orders.db");
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const { runOperate, EXIT } = await import("./operate.js");
    const run = (argv: string[]) => runOperate(argv[0] as string, argv.slice(1), write, { databaseFile: db, now: T0 });
    try {
      const bootstrap = openStore(db);
      const { addApprover } = await import("./scope.js");
      const added = addApprover(bootstrap, "alex", T0);
      if (!added.ok) throw new Error("bootstrap");
      bootstrap.close();
      expect(await run(["task", "add", "msg-cli", "--id", "msg-cli", "--json"])).toBe(EXIT.ok);

      // No --race-per-usd and no default: the refusal names the flag and
      // the config command that would fill it — not the generic
      // "positive dollar budget" riddle (round-4 finding 11).
      lines.length = 0;
      expect(await run([
        "task", "scope", "msg-cli", "--goal", "g", "--acceptance", "It is fixed and verified.|manual-review",
        "--race", "claude:claude-sonnet-5,claude:claude-opus-5", "--json",
      ])).toBe(EXIT.usage);
      let refusal = JSON.parse(lines.join("\n"));
      expect(refusal.reason).toBe("bad-budget");
      expect(refusal.message).toContain("--race-per-usd is missing");
      expect(refusal.message).toContain("config set budgets");

      // Per-agent present, total absent: the OTHER flag is named.
      lines.length = 0;
      expect(await run([
        "task", "scope", "msg-cli", "--goal", "g", "--acceptance", "It is fixed and verified.|manual-review",
        "--race", "claude:claude-sonnet-5,claude:claude-opus-5", "--race-per-usd", "5", "--json",
      ])).toBe(EXIT.usage);
      refusal = JSON.parse(lines.join("\n"));
      expect(refusal.message).toContain("--race-total-usd is missing");

      // A bad value on config set budgets names the offending flag.
      lines.length = 0;
      expect(await run([
        "config", "set", "budgets", "--race-per-usd", "-1",
        "--as", "alex", "--token", added.token, "--json",
      ])).toBe(EXIT.usage);
      expect(JSON.parse(lines.join("\n")).message).toContain("--race-per-usd is a positive dollar amount");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a routine's per-run cap lands in each instance's scope, digest-bound; a routine without one digests as before", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    try {
      const { routineDigestOf, approveRoutine, fireRoutine } = await import("./routine.js");
      const { fileRoutineProposal } = await import("./proposal.js");
      const { addApprover } = await import("./scope.js");
      const added = addApprover(store, "alex", T0);
      if (!added.ok) throw new Error("bootstrap");

      // The conditional-inclusion rule: absent term, identical digest.
      const bare = { repo: "/r", goal: "g", outOfScope: null, touches: [], acceptance: [], requirements: [], schedule: "every:60", singleFlight: true, costCeilingUsd: null };
      expect(routineDigestOf({ ...bare, budgetPerRunMicrousd: null })).toBe(routineDigestOf(bare));
      expect(routineDigestOf({ ...bare, budgetPerRunMicrousd: 2_000_000 })).not.toBe(routineDigestOf(bare));

      const filed = fileRoutineProposal(
        store,
        { name: "capped", repo: "/r", goal: "keep deps fresh", outOfScope: null, touches: [], acceptance: [{ id: "c1", statement: "Deps stay fresh.", evidence: ["manual-review"] }], requirements: [], schedule: "every:60", costCeilingUsd: null, budgetPerRunMicrousd: 2_500_000, filedVia: "cli" },
        T0,
      );
      if (!filed.ok) throw new Error(filed.reason);
      const routine = store.getRoutine(filed.id);
      expect(routine?.budgetPerRunMicrousd).toBe(2_500_000);
      const okd = approveRoutine(store, filed.id, "alex", T0, filed.digest, added.token);
      if (!okd.ok) throw new Error(okd.reason);
      const fired = fireRoutine(store, filed.id, new Date(T0.getTime() + 3_600_000));
      if (!fired.ok) throw new Error(fired.reason);
      const scope = store.getScope(fired.taskId);
      expect(scope?.budgetMicrousd).toBe(2_500_000);
      expect(scope?.approvedDigest).toBe(scope?.digest); // instance born approved, cap inside the digest
    } finally {
      store.close();
    }
  });

  test("cleanup: a decided tournament's checkouts go home; one that will not release cleanly is flagged and paged, not forced", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    try {
      const { sweepContestCleanup } = await import("./contest.js");
      // Two contestants of a picked contest, worktrees recorded to this runner.
      store.createTask({ id: "clean-me", title: "cleaned" }, T0);
      const taskRef = store.refFor("built-in", "clean-me", "ours").id;
      const terms = store.fileTournamentTerms(
        { taskRef, raceDigest: "d", agents: [
          { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
          { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5" },
        ], perAgentBudgetMicrousd: 5_000_000, overrunReserveMicrousd: 1_760_000, totalBudgetMicrousd: 20_000_000, priceVersion: 1, publicationPolicy: "none" },
        T0,
      );
      store.saveRunner(
        { name: "night-shift-1", host: "here", capacity: 4, capacityMode: "tasks", repos: [], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null },
        "hash",
      );
      const contest = store.createContest({ taskRef, terms, scopeDigest: "s", raceDigest: "d" }, T0);
      const [a, b] = store.createContestants(contest, [
        { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5", branch: "b/c1", budgetMicrousd: 5_000_000, reserveMicrousd: 1_760_000 },
        { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5", branch: "b/c2", budgetMicrousd: 5_000_000, reserveMicrousd: 1_760_000 },
      ]) as [number, number];
      store.casContestState(contest, ["dispatching"], "picked", 1);
      for (const [id, path] of [[a, "/pool/c1"], [b, "/pool/c2"]] as const) {
        store.setContestantWorktree(id, path);
        store.setContestantCleanup(id, "pending");
        store.saveWorktree({ path, repo: "/r", branch: `b/${id}`, runner: "night-shift-1", taskRef, createdAt: T0.toISOString(), leasedAt: T0.toISOString(), releasedAt: null, verified: false, setupDigest: null, setupAt: null });
      }
      const released: string[] = [];
      const outcome = await sweepContestCleanup(
        store,
        async path => {
          released.push(path);
          return path === "/pool/c1" ? { ok: true } : { ok: false, reason: "dirty", message: "uncommitted work" };
        },
        "night-shift-1",
        T0,
      );
      expect(outcome).toEqual({ released: 1, attention: 1 });
      expect(store.getContestant(a)?.cleanup).toBe("done");
      expect(store.getContestant(b)?.cleanup).toBe("attention");
      const paged = store.listNotifications("pending").find(one => one.kind === "contest-cleanup");
      expect(paged?.body).toContain("/pool/c2");
      // Another machine's custody is left alone entirely.
      store.setContestantCleanup(b, "pending");
      const foreign = await sweepContestCleanup(store, async () => ({ ok: true }), "other-machine", T0);
      expect(foreign.released).toBe(0);
      expect(store.getContestant(b)?.cleanup).toBe("pending");
    } finally {
      store.close();
    }
  });

  test("a tournament waiting fourteen days pages exactly once, and never abandons itself", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    try {
      const { escalateOverdueContests } = await import("./contest.js");
      store.createTask({ id: "slow-pick", title: "waiting" }, T0);
      const taskRef = store.refFor("built-in", "slow-pick", "ours").id;
      const terms = store.fileTournamentTerms(
        { taskRef, raceDigest: "d", agents: [
          { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
          { provider: "claude", model: "claude-haiku-4-5", repairModel: "claude-haiku-4-5" },
        ], perAgentBudgetMicrousd: 5_000_000, overrunReserveMicrousd: 1_760_000, totalBudgetMicrousd: 20_000_000, priceVersion: 1, publicationPolicy: "none" },
        T0,
      );
      const contest = store.createContest({ taskRef, terms, scopeDigest: "s", raceDigest: "d" }, T0);
      store.casContestState(contest, ["dispatching"], "racing", 1);
      store.casContestState(contest, ["racing"], "pick-wait", 2);
      store.holdOwned({ taskRef, ownerKind: "contest", ownerId: String(contest), reason: "tournament finished — compare the results and pick one", until: null }, T0);

      const thirteenDays = new Date(T0.getTime() + 13 * 86_400_000);
      expect(escalateOverdueContests(store, thirteenDays)).toBe(0);
      const fifteenDays = new Date(T0.getTime() + 15 * 86_400_000);
      expect(escalateOverdueContests(store, fifteenDays)).toBe(1);
      expect(store.getContest(contest)?.overduePaged).toBe(true);
      expect(store.getContest(contest)?.state).toBe("pick-wait"); // never auto-abandoned
      const paged = store.listNotifications("pending").find(one => one.kind === "contest-overdue");
      expect(paged?.body).toContain(`/contest/${contest}`);
      // Once, ever.
      expect(escalateOverdueContests(store, new Date(T0.getTime() + 30 * 86_400_000))).toBe(0);
    } finally {
      store.close();
    }
  });
});


describe("labeled comparisons (Phase 3 slice B): planning, filing, admission, money honesty", () => {
  const MIXED = [
    { provider: "claude", model: "claude-sonnet-5" },
    { provider: "codex", model: "gpt-5-codex" },
    { provider: "gemini", model: "gemini-2.5-pro" },
    { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
  ];

  test("all four providers plan together, each lane worded honestly", () => {
    const planned = planComparison({ agents: MIXED });
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.plan.agents).toHaveLength(4);
    expect(planned.plan.laneWords[0]).toContain("measured in dollars");
    expect(planned.plan.laneWords[1]).toContain("tokens only");
    expect(planned.plan.laneWords[2]).toContain("tokens only");
    expect(planned.plan.laneWords[3]).toContain("tokens only");
  });

  test("the discipline gate: every-lane-raceable refuses toward the tournament road", () => {
    const refused = planComparison({
      agents: [
        { provider: "claude", model: "claude-sonnet-5" },
        { provider: "claude", model: "claude-haiku-4-5" },
      ],
    });
    expect(refused).toMatchObject({ ok: false, reason: "all-lanes-raceable" });
    expect((refused as { message: string }).message).toContain("not a budget bypass");
  });

  test("lanes are validated: unknown providers, missing models, and bad counts refuse", () => {
    expect(planComparison({ agents: [{ provider: "gemini", model: "gemini-2.5-pro" }] })).toMatchObject({ ok: false, reason: "bad-count" });
    expect(
      planComparison({ agents: [{ provider: "watson", model: "x" }, { provider: "claude", model: "m" }] }),
    ).toMatchObject({ ok: false, reason: "unknown-provider" });
    expect(
      planComparison({ agents: [{ provider: "codex", model: "" }, { provider: "gemini", model: "gemini-2.5-pro" }] }),
    ).toMatchObject({ ok: false, reason: "bad-model" });
  });

  test("the comparison fingerprint is its own domain — it can never collide with a race", () => {
    const lanes = [
      { provider: "claude", model: "claude-sonnet-5", repairModel: "claude-sonnet-5" },
      { provider: "gemini", model: "gemini-2.5-pro", repairModel: "gemini-2.5-pro" },
    ];
    const comparison = comparisonDigestOf({ agents: lanes, publicationPolicy: "none" });
    expect(comparison).toMatch(/^[0-9a-f]{64}$/);
    // order-sensitive
    expect(comparisonDigestOf({ agents: [...lanes].reverse(), publicationPolicy: "none" })).not.toBe(comparison);
  });

  test("filing and admission: kind rides the terms, the contest, and the lanes' money zeros", () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    enroll(store, "night-shift-1");
    store.createTask({ id: "cmp-1", title: "compared" }, T0);
    const taskRef = store.refFor("built-in", "cmp-1", "ours").id;
    store.placeTask(taskRef, RACE_REPO);
    const planned = planComparison({
      agents: [
        { provider: "claude", model: "claude-sonnet-5" },
        { provider: "gemini", model: "gemini-2.5-pro" },
        { provider: "codex", model: "gpt-5-codex" },
      ],
    });
    if (!planned.ok) throw new Error(planned.message);
    const termsId = store.fileTournamentTerms(
      {
        taskRef,
        kind: "comparison",
        raceDigest: planned.plan.comparisonDigest,
        agents: planned.plan.agents,
        perAgentBudgetMicrousd: 0,
        overrunReserveMicrousd: 0,
        totalBudgetMicrousd: 0,
        priceVersion: 0,
        publicationPolicy: "none",
      },
      T0,
    );
    const terms = store.activeTournamentTerms(taskRef);
    expect(terms).toMatchObject({ kind: "comparison", perAgentBudgetMicrousd: 0 });
    store.approveTournamentTerms(termsId, "alex", planned.plan.comparisonDigest, T0);
    const taken = acquire(store, taskRef, "night-shift-1", { token: tok("night-shift-1"), now: T0, ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim");
    const admitted = admitContest(
      store,
      {
        taskId: "cmp-1",
        taskRef,
        runner: "night-shift-1",
        leaseId: taken.claim.leaseId,
        incarnation: null,
        scopeDigest: "scope-d",
        scopeApproved: true,
        capacity: 8,
        quotaBlocked: () => null,
      },
      T0,
    );
    if (!admitted.ok) throw new Error(admitted.message);
    const contest = store.getContest(admitted.contestId);
    expect(contest?.kind).toBe("comparison");
    const lanes = store.contestants(admitted.contestId);
    expect(lanes).toHaveLength(3);
    // Every lane: no dollar terms; unmeasured lanes pre-latched as a FACT.
    for (const lane of lanes) expect(lane.budgetMicrousd).toBe(0);
    expect(lanes.map(one => one.unknownSpend)).toEqual([false, true, true]);
    // The gemini lane's sealed profile is gemini-shaped — before slice B a
    // gemini string flowed into the codex profile via the fallthrough.
    expect(lanes[1]?.profile).toMatchObject({ provider: "gemini", approvalArgv: "auto_edit" });
    store.close();
  });

  test("a race with zeroed money cannot exist, and a comparison with money cannot either — the CHECK is kind-aware", () => {
    const store = openStore(":memory:");
    store.createTask({ id: "cmp-2", title: "shape" }, T0);
    const taskRef = store.refFor("built-in", "cmp-2", "ours").id;
    expect(() =>
      store.fileTournamentTerms(
        {
          taskRef,
          raceDigest: "d".repeat(64),
          agents: [
            { provider: "claude", model: "m", repairModel: "m" },
            { provider: "claude", model: "n", repairModel: "n" },
          ],
          perAgentBudgetMicrousd: 0,
          overrunReserveMicrousd: 0,
          totalBudgetMicrousd: 0,
          priceVersion: 1,
          publicationPolicy: "none",
        },
        T0,
      ),
    ).toThrow();
    expect(() =>
      store.fileTournamentTerms(
        {
          taskRef,
          kind: "comparison",
          raceDigest: "e".repeat(64),
          agents: [
            { provider: "claude", model: "m", repairModel: "m" },
            { provider: "gemini", model: "g", repairModel: "g" },
          ],
          perAgentBudgetMicrousd: 5,
          overrunReserveMicrousd: 5,
          totalBudgetMicrousd: 10,
          priceVersion: 1,
          publicationPolicy: "none",
        },
        T0,
      ),
    ).toThrow();
    store.close();
  });
});


describe("slice B e2e — a mixed comparison through the real tick: claude, codex, and an attested gemini", () => {
  test("three lanes build; the gemini lane parks, the answer RESUMES it (no budget exists to exhaust); money lands honest per lane", async () => {
    const { mkdtemp, rm, mkdir, writeFile } = await import("node:fs/promises");
    const { writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
    const { delimiter } = await import("node:path");
    const { runOperate } = await import("./operate.js");
    const { run: exec } = await import("./exec.js");
    const { resetAttestationCache } = await import("./attest.js");
    const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

    const base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-compare-e2e-")));
    const repo = join(base, "repo");
    const db = join(base, "queue.db");
    const pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    const git = (args: string[]) => exec("git", args, { cwd: repo });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "T"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);

    // The attested fake: the tick's pre-claim walk and the gateway both
    // probe THIS binary.
    const bin = join(base, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gemini"), `#!/bin/sh\necho "0.57.0"\n`);
    chmodSync(join(bin, "gemini"), 0o755);
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${bin}${delimiter}${savedPath ?? ""}`;
    resetAttestationCache();

    const DECISION = {
      urgency: "blocking",
      recap: "Two shapes are possible and the scope names neither.",
      question: "CSV or JSON lines?",
      options: [
        { id: "csv", label: "CSV", consequence: "spreadsheet-friendly", reversible: true },
        { id: "jsonl", label: "JSON lines", consequence: "machine-friendly", reversible: true },
      ],
      recommendation: "jsonl",
    };

    let lines: string[] = [];
    const laneCalls: string[] = [];
    const parkedOnce = new Set<string>();
    let geminiSession: string | null = null;
    /** One stub, three dialects — detected off the argv the plane rendered. */
    const agent = async (_file: string, args: readonly string[], options?: { cwd?: string }) => {
      const cwd = options?.cwd ?? "";
      const dialect = args[0] === "exec" ? "codex" : args.includes("--approval-mode") ? "gemini" : "claude";
      laneCalls.push(dialect);
      const prompt = dialect === "codex" ? String(args[args.length - 1] ?? "") : (args[args.indexOf("-p") + 1] ?? "");
      if (dialect === "gemini" && !parkedOnce.has(cwd)) {
        // The gemini lane parks its question on first sight of the tree.
        parkedOnce.add(cwd);
        const mailbox = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
        if (mailbox === undefined) throw new Error("no mailbox named in the gemini brief");
        await writeFile(join(cwd, mailbox), JSON.stringify(DECISION));
        const sessionFlag = args.indexOf("--session-id");
        const minted = sessionFlag < 0 ? undefined : args[sessionFlag + 1];
        if (minted === undefined || minted === "") throw new Error("the first gemini turn did not receive a minted session id");
        geminiSession = minted;
        return { ...OK, stdout: [
          JSON.stringify({ type: "init", session_id: minted, model: "gemini-2.5-pro" }),
          JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 40, output_tokens: 9 } }),
        ].join("\n") };
      }
      await writeFile(join(cwd, `work-${dialect}.ts`), `export const ${dialect} = true;\n`);
      const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
      if (done !== undefined) {
        await writeFile(join(cwd, done), JSON.stringify({ version: 1, status: "completed", conclusion: `${dialect} finished` }));
      }
      if (dialect === "codex") {
        return { ...OK, stdout: [
          JSON.stringify({ type: "thread.started", thread_id: `thread-${laneCalls.length}` }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex finished" } }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 900, output_tokens: 80 } }),
        ].join("\n") };
      }
      if (dialect === "gemini") {
        const resumeFlag = args.indexOf("--resume");
        const resumed = resumeFlag < 0 ? undefined : args[resumeFlag + 1];
        if (resumed === undefined || resumed === "") throw new Error("the next gemini turn did not receive a session to resume");
        if (resumed !== geminiSession) throw new Error("the gemini lane resumed a session other than the one it parked");
        return { ...OK, stdout: [
          JSON.stringify({ type: "init", session_id: resumed, model: "gemini-2.5-pro" }),
          JSON.stringify({ type: "synthetic_message", content: "gemini finished" }),
          JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 700, output_tokens: 60 } }),
        ].join("\n") };
      }
      return { ...OK, stdout: JSON.stringify({ result: "claude finished", total_cost_usd: 0.42, usage: { input_tokens: 100, output_tokens: 50 } }) };
    };
    const run = (argv: string[], now = T0) => {
      const [command = "", ...rest] = argv;
      lines = [];
      return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: agent as never });
    };
    const payload = () => JSON.parse(lines.join("\n"));

    try {
      // The runner gate (MCP spec v6): builder-1 enrolls against the store
      // with the repo in its registered list; the task is placed at filing.
      const boot = openStore(db);
      register(boot, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => tok("builder-1") });
      boot.close();
      const runnerToken = tok("builder-1");
      await run(["approver", "add", "alex", "--json"]);
      const approverToken = payload().token as string;
      await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
      await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
      await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
      await run(["task", "add", "the compared work", "--id", "cmp-e2e", "--repo", repo]);
      await run([
        "task", "scope", "cmp-e2e",
        "--goal", "export the data three ways and let me pick", "--acceptance", "It is fixed and verified.|manual-review",
        "--compare", "claude:claude-sonnet-5,codex:gpt-5-codex,gemini:gemini-2.5-pro",
        "--json",
      ]);
      const filed = payload();
      expect(filed.comparison.laneWords).toHaveLength(3);
      const joint = jointApprovalDigest(filed.scope.digest as string, filed.comparison.comparisonDigest as string);
      await run(["task", "approve", "cmp-e2e", "--yes", "--digest", joint, "--as", "alex", "--token", approverToken, "--json"]);

      // Pass 1: claude and codex finish; gemini parks → decision-wait.
      await run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"]);
      expect(payload().dispatched[0]).toMatchObject({ id: "cmp-e2e", outcome: "contest", reason: "decision-wait" });

      let store = openStore(db);
      const contest = store.contestsInStates(["decision-wait"])[0];
      if (contest === undefined) throw new Error("no waiting comparison");
      expect(contest.kind).toBe("comparison");
      const geminiLane = store.contestants(contest.id).find(one => one.provider === "gemini");
      if (geminiLane === undefined) throw new Error("no gemini lane");
      expect(geminiLane.state).toBe("parked");
      const question = store.openDecisionForContestant(geminiLane.id);
      expect(question).not.toBeNull();
      store.close();

      // The answer RESUMES the lane (E1): with the v1 design the resume
      // pass would have stopped it as budget-exhausted — a comparison
      // lane's budget is 0 BY DESIGN, and zero is not exhaustion.
      await run(["decide", String(question), "--choose", "jsonl", "--as", "alex", "--token", approverToken, "--json"]);
      await run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"]);

      store = openStore(db);
      const finished = store.contestsInStates(["pick-wait"])[0];
      if (finished === undefined) throw new Error("the comparison never reached pick-wait");
      const lanes = store.contestants(finished.id);
      expect(lanes.map(one => one.state)).toEqual(["built", "built", "built"]);
      // Money honesty per lane: claude measured; codex and gemini stay
      // pre-latched with zero accounted — no reservation ever existed.
      const byProvider = new Map(lanes.map(one => [one.provider, one]));
      expect(byProvider.get("claude")).toMatchObject({ unknownSpend: false, measuredMicrousd: 420_000 });
      expect(byProvider.get("codex")).toMatchObject({ unknownSpend: true, accountedMicrousd: 0 });
      expect(byProvider.get("gemini")).toMatchObject({ unknownSpend: true, accountedMicrousd: 0 });
      // The attested version rode every gemini run.
      const geminiRuns = store
        .raw()
        .prepare("SELECT provider_version FROM run WHERE provider = 'gemini'")
        .all();
      expect(geminiRuns.length).toBeGreaterThanOrEqual(2); // park + resume
      for (const one of geminiRuns) expect(one["provider_version"]).toBe("0.57.0");
      // Every dialect really spoke: the stub saw all three argv shapes.
      expect(new Set(laneCalls)).toEqual(new Set(["claude", "codex", "gemini"]));
      store.close();
    } finally {
      process.env["PATH"] = savedPath ?? "";
      resetAttestationCache();
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);
});
