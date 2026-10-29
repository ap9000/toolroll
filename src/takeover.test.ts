/**
 * Arc 2's credentialed doors: takeover, authenticated leases and
 * heartbeats, fenced retirement, and the first-approver bootstrap. Every
 * test here is one of the review's interleavings, replayed deliberately.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { lifecycleOf, MAX_WATCH_LEASE_MS, openStore, type Store } from "./store.js";
import {
  acquireWatchLeaseAuthed,
  authenticate,
  DEFAULT_LIVENESS_MS,
  drainRunnerIfCurrent,
  heartbeat,
  heartbeatWatchLeaseAuthed,
  normalizeRunnerName,
  register,
  registerRunnerIfIdle,
  retireRunnerIfCurrent,
  RUNNER_NAME_MAX,
  validRunnerName,
} from "./runner.js";
import { acquire } from "./claim.js";
import { authenticateApprover, hashToken } from "./scope.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const T0 = new Date("2026-08-24T05:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const DEAD = later(DEFAULT_LIVENESS_MS + 60_000);

/** The runner gate (MCP spec v6): acquisitions authenticate the runner and
 * bind to the task's placed repo, so acquiring tests register against REPO
 * and place their tasks there. */
const REPO = "/repo/takeover";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});

describe("registerRunnerIfIdle — the atomic take-or-refuse door", () => {
  test("refuses a runner whose heartbeat is fresh", () => {
    register(store, { name: "w-1", host: "here", now: T0 });
    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: later(1_000) });
    expect(taken).toMatchObject({ ok: false, reason: "runner-alive" });
  });

  test("refuses while any watch lease is unexpired, even on a dead runner", () => {
    register(store, { name: "w-1", host: "here", now: T0 });
    store.acquireWatchLease("w-1", "/repo", "inc-a", 90_000, T0);
    // Heartbeat aged past liveness, lease TTL not yet expired at this instant.
    const during = new Date(T0.getTime() + 89_000);
    const runner = store.getRunner("w-1");
    expect(runner?.runner).toBeTruthy();
    // Force the heartbeat to look dead while the lease lives: use a long lease.
    store.acquireWatchLease("w-1", "/repo", "inc-a", DEFAULT_LIVENESS_MS + 120_000, during);
    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: DEAD });
    expect(taken).toMatchObject({ ok: false, reason: "watch-live" });
  });

  test("takes over a dead runner: open runs finish, the task requeues, the token rotates", () => {
    const first = register(store, { name: "w-1", host: "here", repos: [REPO], now: T0 });
    store.createTask({ id: "t-1", title: "left behind" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    store.placeTask(ref, REPO);
    store.acquireWatchLease("w-1", REPO, "inc-a", 60_000, T0);
    acquire(store, ref, "w-1", { token: first.token, now: T0, ttlMs: 60_000, newLeaseId: () => "lease-a", incarnation: "inc-a" });
    store.setTaskState("t-1", "running", T0);
    const runId = store.startRun({
      taskRef: ref, leaseId: "lease-a", runner: "w-1", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0,
    });

    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: DEAD });
    expect(taken).toMatchObject({ ok: true });
    if (!taken.ok) return;
    expect(taken.recoveredRuns).toBeGreaterThan(0);
    expect(store.getRun(runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.getTask("t-1")).toMatchObject({ state: "queued" });
    // The old credential is dead the moment the takeover commits.
    expect(heartbeat(store, "w-1", first.token, DEAD)).toMatchObject({ ok: false, reason: "bad-token" });
    expect(heartbeat(store, "w-1", taken.token, DEAD)).toMatchObject({ ok: true });
  });

  test("a reap-released claim's open run still recovers and requeues (finding 31)", () => {
    const reg = register(store, { name: "w-1", host: "here", repos: [REPO], now: T0 });
    store.createTask({ id: "t-r", title: "reaped mid-build" }, T0);
    const ref = store.refFor("built-in", "t-r").id;
    store.placeTask(ref, REPO);
    store.acquireWatchLease("w-1", REPO, "inc-r", 60_000, T0);
    acquire(store, ref, "w-1", { token: reg.token, now: T0, ttlMs: 60_000, newLeaseId: () => "lease-r", incarnation: "inc-r" });
    store.setTaskState("t-r", "running", T0);
    const runId = store.startRun({
      taskRef: ref, leaseId: "lease-r", runner: "w-1", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0,
    });
    // The reaper releases the claim WITHOUT finishing the run — the exact
    // evidence-destroying step the takeover must survive.
    store.releaseClaimsOf("w-1", later(120_000));

    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: DEAD });
    expect(taken).toMatchObject({ ok: true });
    expect(store.getRun(runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.getTask("t-r")).toMatchObject({ state: "queued" });
  });

  test("a retired runner is idle by definition — restart reuses the name instantly", () => {
    const first = register(store, { name: "w-1", host: "here", now: T0 });
    const retired = retireRunnerIfCurrent(store, "w-1", first.token, later(1_000));
    expect(retired).toMatchObject({ ok: true });
    const again = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: later(2_000) });
    expect(again).toMatchObject({ ok: true });
  });
});

describe("registerRunnerIfIdle — a holder proved gone signs off (2026-10-29 deploy)", () => {
  /** A holder `up` killed outright: fresh heartbeat, live lease, an open run. */
  const killedHolder = () => {
    const first = register(store, { name: "w-1", host: "here", repos: [REPO], now: T0 });
    store.acquireWatchLease("w-1", REPO, "inc-a", 90_000, later(1_000));
    store.createTask({ id: "t-k", title: "in flight when killed" }, T0);
    const ref = store.refFor("built-in", "t-k").id;
    store.placeTask(ref, REPO);
    store.acquireWatchLease("w-1", REPO, "inc-a", 60_000, T0);
    acquire(store, ref, "w-1", { token: first.token, now: T0, ttlMs: 60_000, newLeaseId: () => "lease-k", incarnation: "inc-a" });
    store.setTaskState("t-k", "running", T0);
    const runId = store.startRun({ taskRef: ref, leaseId: "lease-k", runner: "w-1", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0 });
    return { first, runId };
  };

  test("the holder's processes proved gone: retired, its lease lapsed and its work recovered in the same door", () => {
    const { first, runId } = killedHolder();
    const asked: string[] = [];
    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", repos: [REPO], now: later(2_000),
      previousGone: holder => { asked.push(`${holder.runner.name}@${holder.runner.registeredAt}`); return { gone: true, detail: "w-1: process 4242 (up) proved gone" }; } });
    expect(taken).toMatchObject({ ok: true, signedOff: "w-1: process 4242 (up) proved gone" });
    if (!taken.ok) return;
    expect(asked).toEqual([`w-1@${first.runner.registeredAt}`]);
    expect(taken.recoveredRuns).toBeGreaterThan(0);
    expect(store.getRun(runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(heartbeat(store, "w-1", first.token, later(2_000))).toMatchObject({ ok: false, reason: "bad-token" });
    expect(store.liveWatchLeaseOf("w-1", later(2_000))).toBeNull();
    // The lapsed lease is taken over like any crashed one: the superseded incarnation is recovered.
    expect(acquireWatchLeaseAuthed(store, { runner: "w-1", token: taken.token, repo: REPO, owner: "inc-b", ttlMs: 90_000 }, later(3_000)))
      .toMatchObject({ ok: true, superseded: "inc-a" });
    expect(store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE action = 'worker signed off'").get())
      .toEqual({ outcome: "processes proved gone", detail: "w-1: process 4242 (up) proved gone" });
  });

  test("two live holders stay impossible: an unproved holder still refuses, and nothing changes", () => {
    const { first } = killedHolder();
    for (const proof of [{ gone: false as const, why: "process 4242 is still running" }]) {
      expect(registerRunnerIfIdle(store, { name: "w-1", host: "here", now: later(2_000), previousGone: () => proof }))
        .toMatchObject({ ok: false, reason: "runner-alive" });
    }
    // Without a proof function the door is exactly as before.
    expect(registerRunnerIfIdle(store, { name: "w-1", host: "here", now: later(2_000) })).toMatchObject({ ok: false, reason: "runner-alive" });
    expect(heartbeat(store, "w-1", first.token, later(2_000))).toMatchObject({ ok: true });
    expect(store.liveWatchLeaseOf("w-1", later(2_000))).not.toBeNull();
  });

  test("the proof is asked only while the holder blocks the name", () => {
    register(store, { name: "w-1", host: "here", now: T0 });
    let asked = 0;
    expect(registerRunnerIfIdle(store, { name: "w-1", host: "here", now: DEAD, previousGone: () => { asked++; return { gone: true, detail: "x" }; } }))
      .toMatchObject({ ok: true, signedOff: null });
    expect(asked).toBe(0);
  });
});

describe("authenticated heartbeats and leases", () => {
  test("the lease door refuses a stale credential after rotation", () => {
    const first = register(store, { name: "w-1", host: "here", repos: ["/repo"], now: T0 });
    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", repos: ["/repo"], now: DEAD });
    if (!taken.ok) throw new Error("takeover failed in setup");
    const stale = acquireWatchLeaseAuthed(
      store,
      { runner: "w-1", token: first.token, repo: "/repo", owner: "inc-old", ttlMs: 90_000 },
      later(DEFAULT_LIVENESS_MS + 61_000),
    );
    expect(stale).toMatchObject({ ok: false, reason: "bad-token" });
    const fresh = acquireWatchLeaseAuthed(
      store,
      { runner: "w-1", token: taken.token, repo: "/repo", owner: "inc-new", ttlMs: 90_000 },
      later(DEFAULT_LIVENESS_MS + 61_000),
    );
    expect(fresh).toMatchObject({ ok: true });
  });

  test("taking over an EXPIRED lease recovers the superseded incarnation in the same call", () => {
    const reg = register(store, { name: "w-1", host: "here", repos: [REPO], now: T0 });
    store.createTask({ id: "t-s", title: "superseded work" }, T0);
    const ref = store.refFor("built-in", "t-s").id;
    store.placeTask(ref, REPO);
    store.acquireWatchLease("w-1", REPO, "inc-a", 60_000, T0);
    acquire(store, ref, "w-1", { token: reg.token, now: T0, ttlMs: 30 * 60_000, newLeaseId: () => "lease-s", incarnation: "inc-a" });
    store.setTaskState("t-s", "running", T0);
    const runId = store.startRun({
      taskRef: ref, leaseId: "lease-s", runner: "w-1", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0,
    });
    store.acquireWatchLease("w-1", REPO, "inc-a", 90_000, T0);

    // inc-a's lease expires; inc-b (same runner, still-valid token) takes over.
    const afterExpiry = later(5 * 60_000);
    const took = acquireWatchLeaseAuthed(
      store,
      { runner: "w-1", token: reg.token, repo: REPO, owner: "inc-b", ttlMs: 90_000 },
      afterExpiry,
    );
    expect(took).toMatchObject({ ok: true, superseded: "inc-a" });
    if (took.ok) expect(took.recovered).toBeGreaterThan(0);
    expect(store.getRun(runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.getTask("t-s")).toMatchObject({ state: "queued" });
  });

  test("identity is proven INSIDE the claim transaction — an earlier authenticate carries no authority across a rotation", () => {
    // The runner gate's first leg (MCP spec v6): a stale process checks its
    // credential, the check passes, and THEN the takeover lands. If acquire
    // trusted the earlier answer, the stale process would claim under its
    // successor's authority; instead the row is re-read and the hash
    // re-compared inside the claim's own transaction.
    const first = register(store, { name: "w-1", host: "here", repos: [REPO], now: T0, newToken: () => "tok-old" });
    store.createTask({ id: "t-race", title: "auth/acquire race" }, T0);
    const ref = store.refFor("built-in", "t-race").id;
    store.placeTask(ref, REPO);

    // The stale process's own auth check — genuinely good at this instant.
    expect(authenticate(store, "w-1", first.token)).toMatchObject({ ok: true });

    // The takeover: re-registering the name reclaims and rotates the credential.
    const successor = register(store, { name: "w-1", host: "elsewhere", repos: [REPO], now: later(1_000), newToken: () => "tok-new" });

    // The stale token rides into acquire anyway — refused in-transaction.
    const stale = acquire(store, ref, "w-1", { token: first.token, now: later(2_000), ttlMs: 60_000 });
    expect(stale).toMatchObject({ ok: false, reason: "unauthenticated", detail: "bad-token" });
    // Nothing was claimed for the stale process.
    expect(store.hasLiveClaim(ref, later(2_000))).toBe(false);

    // The successor's fresh credential claims the same task fine.
    const fresh = acquire(store, ref, "w-1", { token: successor.token, now: later(3_000), ttlMs: 60_000 });
    expect(fresh).toMatchObject({ ok: true });
  });

  test("renewal answers false the moment the credential rotates — the caller must stop", () => {
    const first = register(store, { name: "w-1", host: "here", repos: ["/repo"], now: T0 });
    acquireWatchLeaseAuthed(store, { runner: "w-1", token: first.token, repo: "/repo", owner: "inc-a", ttlMs: 90_000 }, T0);
    expect(
      heartbeatWatchLeaseAuthed(store, { runner: "w-1", token: first.token, repo: "/repo", owner: "inc-a", ttlMs: 90_000 }, later(30_000)),
    ).toBe(true);
    expect(store.getRunner("w-1")?.runner.heartbeatAt).toBe(later(30_000).toISOString());
    expect(heartbeatWatchLeaseAuthed(store, { runner: "w-1", token: first.token, repo: "/repo", owner: "wrong-incarnation", ttlMs: 90_000 }, later(40_000))).toBe(false);
    expect(store.getRunner("w-1")?.runner.heartbeatAt).toBe(later(30_000).toISOString());
    // The lease must expire before a takeover may rotate.
    const gone = later(DEFAULT_LIVENESS_MS + 120_000);
    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: gone });
    expect(taken).toMatchObject({ ok: true });
    expect(
      heartbeatWatchLeaseAuthed(store, { runner: "w-1", token: first.token, repo: "/repo", owner: "inc-a", ttlMs: 90_000 }, later(DEFAULT_LIVENESS_MS + 121_000)),
    ).toBe(false);
  });
});

describe("fenced retirement (finding 28)", () => {
  test("a predecessor cannot retire its successor", () => {
    const first = register(store, { name: "w-1", host: "here", now: T0 });
    const successor = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: DEAD });
    if (!successor.ok) throw new Error("takeover failed in setup");
    const attempt = retireRunnerIfCurrent(store, "w-1", first.token, later(DEFAULT_LIVENESS_MS + 61_000));
    expect(attempt).toMatchObject({ ok: false, reason: "bad-token" });
    expect(store.getRunner("w-1")?.runner.retiredAt).toBeNull();
    const own = retireRunnerIfCurrent(store, "w-1", successor.token, later(DEFAULT_LIVENESS_MS + 62_000));
    expect(own).toMatchObject({ ok: true });
    expect(store.getRunner("w-1")?.runner.retiredAt).not.toBeNull();
  });
});

describe("the first-approver bootstrap (finding 2)", () => {
  test("inserts only while the table is empty; the winner's password authenticates", () => {
    // The hash recipe must match scope.ts's — proved by authenticating.
    const first = store.bootstrapApproverIfNone("alex", hashToken("hunter2hunter2"), T0);
    expect(first).toEqual({ ok: true });
    const second = store.bootstrapApproverIfNone("mallory", hashToken("stolen-password"), later(1));
    expect(second).toEqual({ ok: false, reason: "approvers-exist" });
    expect(store.listApprovers().map(one => one.name)).toEqual(["alex"]);
    expect(authenticateApprover(store, "alex", "hunter2hunter2").ok).toBe(true);
  });
});

describe("the shared runner-name rule", () => {
  test("validation and normalization agree with the console form", () => {
    expect(validRunnerName("builder-1")).toBe(true);
    expect(validRunnerName("")).toBe(false);
    expect(validRunnerName("a".repeat(RUNNER_NAME_MAX + 1))).toBe(false);
    expect(validRunnerName("hasbell")).toBe(false);
    expect(normalizeRunnerName("Alekseys-MacBook.Pro.local")).toBe("alekseys-macbook-pro-local");
    expect(normalizeRunnerName("!!!")).toBe("worker");
    expect(normalizeRunnerName("x".repeat(90)).length).toBe(RUNNER_NAME_MAX);
  });
});

describe("lifecycle: draining holds custody until sign-off or proved exit", () => {
  test("a draining holder stays exclusive past its deadline until its exit is proved", () => {
    const first = register(store, { name: "w-1", host: "here", repos: ["/repo"], now: T0 });
    acquireWatchLeaseAuthed(store, { runner: "w-1", token: first.token, repo: "/repo", owner: "inc-a", ttlMs: 60_000 }, T0);
    expect(drainRunnerIfCurrent(store, "w-1", first.token, later(1_000), later(30_000))).toBe(true);
    expect(lifecycleOf(store, "worker:w-1")).toMatchObject({ state: "draining", drainUntil: later(30_000).toISOString() });
    // Its heartbeat and lease are both fresh: still two live holders are impossible, and the answer says why at once.
    const early = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: later(10_000) });
    expect(early).toMatchObject({ ok: false, reason: "runner-draining", until: later(30_000).toISOString() });
    if (!early.ok) expect(early.detail).toContain("Toolroll is restarting (draining)");
    // A stop timer can be delayed: the deadline alone must not retire a live holder.
    expect(registerRunnerIfIdle(store, { name: "w-1", host: "here", now: later(31_000) })).toMatchObject({ ok: false, reason: "runner-draining" });
    expect(authenticate(store, "w-1", first.token).ok).toBe(true);
    const taken = registerRunnerIfIdle(store, { name: "w-1", host: "here", now: later(31_000), previousGone: () => ({ gone: true, detail: "all holders exited" }) });
    expect(taken).toMatchObject({ ok: true, signedOff: "all holders exited" });
    expect(store.liveWatchLeaseOf("w-1", later(31_000))).toBeNull();
    expect(lifecycleOf(store, "worker:w-1")).toMatchObject({ state: "started" });
  });

  test("a stopped (retired) holder's live lease no longer blocks: retiring lapses it", () => {
    const first = register(store, { name: "w-1", host: "here", repos: ["/repo"], now: T0 });
    acquireWatchLeaseAuthed(store, { runner: "w-1", token: first.token, repo: "/repo", owner: "inc-a", ttlMs: 60_000 }, T0);
    expect(retireRunnerIfCurrent(store, "w-1", first.token, later(1_000))).toEqual({ ok: true });
    expect(registerRunnerIfIdle(store, { name: "w-1", host: "here", now: later(2_000) })).toMatchObject({ ok: true });
  });

  test("a draining runner admits no new claim; a stale process can't mark its successor draining", () => {
    const first = register(store, { name: "w-1", host: "here", repos: [REPO], now: T0 });
    store.createTask({ id: "t-d", title: "queued during a restart" }, T0);
    const ref = store.refFor("built-in", "t-d").id;
    store.placeTask(ref, REPO);
    expect(drainRunnerIfCurrent(store, "w-1", first.token, later(1_000), later(60_000))).toBe(true);
    expect(acquire(store, ref, "w-1", { token: first.token, now: later(2_000), ...bareLegacy("build") })).toMatchObject({ ok: false, reason: "draining" });
    const successor = registerRunnerIfIdle(store, { name: "w-1", host: "here", repos: [REPO], now: later(61_000) });
    if (!successor.ok) throw new Error("takeover failed in setup");
    expect(drainRunnerIfCurrent(store, "w-1", first.token, later(62_000), later(90_000))).toBe(false);
    expect(lifecycleOf(store, "worker:w-1")).toMatchObject({ state: "started" });
    expect(acquire(store, ref, "w-1", { token: successor.token, now: later(63_000), ...bareLegacy("build") })).toMatchObject({ ok: true });
  });

  test("a watch lease is never taken or renewed for longer than a minute", () => {
    store.acquireWatchLease("w-1", "/repo", "inc-a", 10 * 60_000, T0);
    expect(store.liveWatchLeaseOf("w-1", later(MAX_WATCH_LEASE_MS - 1))).not.toBeNull();
    expect(store.liveWatchLeaseOf("w-1", later(MAX_WATCH_LEASE_MS))).toBeNull();
    store.acquireWatchLease("w-1", "/repo", "inc-b", 60_000, later(MAX_WATCH_LEASE_MS));
    expect(store.heartbeatWatchLease("w-1", "/repo", "inc-b", 10 * 60_000, later(MAX_WATCH_LEASE_MS + 1_000))).toBe(true);
    expect(store.liveWatchLeaseOf("w-1", later(2 * MAX_WATCH_LEASE_MS + 1_000))).toBeNull();
  });
});

test.each(["expired", "superseded", "missing"])("a %s watch cannot acquire another task before its next heartbeat", state => {
  const first = register(store, { name: "w-1", host: "here", repos: [REPO], now: T0 });
  store.createTask({ id: "late", title: "late dispatch" }, T0);
  const ref = store.refFor("built-in", "late").id;
  store.placeTask(ref, REPO);
  if (state !== "missing") store.acquireWatchLease("w-1", REPO, "inc-old", 60_000, T0);
  if (state === "superseded") store.acquireWatchLease("w-1", REPO, "inc-new", 60_000, later(61_000));
  expect(acquire(store, ref, "w-1", { token: first.token, now: later(61_001), incarnation: "inc-old" })).toMatchObject({ ok: false, reason: "watch-custody" });
  expect(store.hasLiveClaim(ref, later(61_001))).toBe(false);
});
