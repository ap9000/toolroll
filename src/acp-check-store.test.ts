/**
 * An ACP agent check's record (docs/plans/acp-adapter.md § Layer E): claimed by one watch of its runner, one running
 * per runner, two steps consumed in order and graded, and published — with its attestation — only while everything
 * still holds. Every write is a compare-and-swap: a stale, expired or foreign actor changes nothing.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { openStore, type Store } from "./store.js";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const RUNNER = "mac";
const REPO = "/checks";
const WATCH = { repo: REPO, owner: "watch-a" };
let store: Store;

beforeEach(() => {
  store = openStore(":memory:");
  register(store, { name: RUNNER, host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok" });
  const leased = store.acquireWatchLease(RUNNER, REPO, WATCH.owner, 60 * 60_000, T0);
  if (!leased.ok) throw new Error("watch");
});
afterEach(() => store.close());

const attestation = { provider: "opencode", runner: RUNNER, launch: { file: "/opt/oc", prefix: [], bindings: [{ role: "launcher" as const, path: "/opt/oc", sha256: "a".repeat(64), dev: 1, ino: 2, ctimeMs: 3, size: 4 }] }, agent: { name: "OpenCode", version: "1.18.18" }, cliVersion: "1.18.18", models: ["opencode/big-pickle"], checks: ["session-ok", "session-stop"], recordedBy: "alex" };

/** A task and two finished check runs bound to the request. */
function runs(id: number): [number, number] {
  store.createTask({ id: `check-${id}`, title: "Check OpenCode" }, T0);
  const ref = store.refFor("built-in", `check-${id}`).id;
  store.placeTask(ref, REPO);
  const took = acquire(store, ref, RUNNER, { now: T0, token: "tok", newLeaseId: () => `lease-${id}`, ttlMs: 3_600_000 });
  if (!took.ok) throw new Error(took.reason);
  expect(store.bindAcpCheck(id, { taskRef: ref, launchJson: JSON.stringify(attestation.launch) }, T0)).toBe(true);
  const start = () => store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: RUNNER, branch: "check", worktree: "/w", route: { routeDigest: "legacy", phase: "build", provider: "opencode", model: "opencode/big-pickle", chosen: "legacy" }, now: T0 });
  const one = start();
  expect(store.consumeAcpCheckStep(id, 2, one, T0)).toBe(false); // out of order
  expect(store.consumeAcpCheckStep(id, 1, one, T0)).toBe(true);
  expect(store.consumeAcpCheckStep(id, 1, one, T0)).toBe(false); // once
  store.finishRun(one, { outcome: "refused", reason: "agent-check", now: T0 });
  const two = start();
  expect(store.consumeAcpCheckStep(id, 2, two, T0)).toBe(false); // step 1 not passed yet
  expect(store.passAcpCheckStep(id, 1, two, T0)).toBe(false); // not step 1's run
  expect(store.passAcpCheckStep(id, 1, one, T0)).toBe(true);
  expect(store.consumeAcpCheckStep(id, 2, two, T0)).toBe(true);
  store.finishRun(two, { outcome: "refused", reason: "agent-check", now: T0 });
  return [one, two];
}

test("a check is claimed by one watch, one at a time per runner, and publishes its attestation only when both steps passed", () => {
  const first = store.requestAcpCheck({ provider: "opencode", runner: RUNNER, model: "opencode/big-pickle", by: "alex" }, T0);
  const second = store.requestAcpCheck({ provider: "opencode", runner: RUNNER, model: "opencode/big-pickle", by: "alex" }, T0);
  expect(store.claimAcpCheck(RUNNER, WATCH, T0)?.id).toBe(first);
  expect(store.claimAcpCheck(RUNNER, WATCH, T0)).toBeNull(); // one running per runner
  const [, two] = runs(first);
  expect(store.publishAcpCheck(first, attestation, T0)).toBe(false); // step 2 not passed
  expect(store.passAcpCheckStep(first, 2, two, T0)).toBe(true);
  expect(store.publishAcpCheck(first, { ...attestation, models: ["other/model"] }, T0)).toBe(false); // not the model checked
  expect(store.acpAttestationFor("opencode", RUNNER)).toBeNull();
  expect(store.publishAcpCheck(first, attestation, T0)).toBe(true);
  expect(store.acpCheck(first)).toMatchObject({ state: "passed" });
  expect(store.acpAttestationFor("opencode", RUNNER)).toMatchObject({ agent: { name: "OpenCode", version: "1.18.18" } });
  expect(store.publishAcpCheck(first, attestation, T0)).toBe(false); // once
  // With the first done, the next can run.
  expect(store.claimAcpCheck(RUNNER, WATCH, T0)?.id).toBe(second);
});

test("an expired check, or one whose watch no longer holds its lease, can't consume, pass or publish — and is recovered", () => {
  const id = store.requestAcpCheck({ provider: "opencode", runner: RUNNER, model: "opencode/big-pickle", by: "alex" }, T0);
  expect(store.claimAcpCheck(RUNNER, WATCH, T0)).not.toBeNull();
  const [, two] = runs(id);
  // Past its time: nothing more moves, and recovery sees it.
  expect(store.passAcpCheckStep(id, 2, two, at(31))).toBe(false);
  expect(store.publishAcpCheck(id, attestation, at(31))).toBe(false);
  expect(store.abandonedAcpChecks(RUNNER, at(31)).map(one => one.id)).toEqual([id]);
  // Within its time, but the watch lost its lease: the same.
  expect(store.abandonedAcpChecks(RUNNER, at(5))).toEqual([]);
  store.handle.prepare("UPDATE watch_lease SET expires_at = ? WHERE runner = ?").run(at(1).toISOString(), RUNNER);
  expect(store.passAcpCheckStep(id, 2, two, at(5))).toBe(false);
  expect(store.abandonedAcpChecks(RUNNER, at(5)).map(one => one.id)).toEqual([id]);
  expect(store.failAcpCheck(id, "interrupted", at(5))).toBe(true);
  expect(store.acpCheck(id)).toMatchObject({ state: "failed", result: "interrupted" });
  expect(store.acpAttestationFor("opencode", RUNNER)).toBeNull();
});

test("a pending check past its time expires untouched, and is never claimed", () => {
  const id = store.requestAcpCheck({ provider: "opencode", runner: RUNNER, model: "m", by: "alex" }, T0);
  expect(store.claimAcpCheck(RUNNER, WATCH, at(31))).toBeNull();
  expect(store.expireAcpChecks(at(31))).toBe(1);
  expect(store.acpCheck(id)).toMatchObject({ state: "expired" });
});
