import { expect, test } from "vitest";
import { assessDarwinObserverRecovery, type ProcessRecoveryAnchor } from "./process-recovery.js";
import type { DarwinProcessIdentity, DarwinProcessRecoverySnapshot } from "./process-recovery-native.js";
import { fakePid } from "../test/fake-pid.js";

const boot = "0774c645-ad9a-4d83-9efb-eca6506656c5";
const boundary = "2026-09-20T12:23:00.315Z";
const anchorPid = fakePid(1), otherPid = fakePid(2), childPid = fakePid(3), grandchildPid = fakePid(4), orphanPid = fakePid(5), laterPid = fakePid(6), missingPid = fakePid(7);
const old = Date.parse("2026-09-20T11:00:00.000Z"), young = Date.parse("2026-09-20T12:24:00.000Z");
const row = (pid: number, ppid: number, birthMs: number | null, uniqueId = String(pid), parentUniqueId = String(ppid)): DarwinProcessIdentity => ({ pid, ppid, uid: 501, birthMs, uniqueId, parentUniqueId, traced: false, executable: null, originalParentVersion: 7 });
const snapshot = (...processes: DarwinProcessIdentity[]): DarwinProcessRecoverySnapshot => ({
  schema: 1, host: "test-host", bootId: boot, osRelease: "test", startedAt: "2026-09-20T12:30:00.000Z", finishedAt: "2026-09-20T12:30:01.000Z",
  elevation: "none", complete: true, stable: true, processes: [row(1, 0, old), row(anchorPid, 1, old), ...processes], managedServices: [],
  collectorPids: [], domainFailures: [], identityChanges: [], errors: [], nativeSourceSha256: "a".repeat(64), nativeExecutableSha256: "b".repeat(64), pidDomains: [],
});
const preRun: ProcessRecoveryAnchor[] = [{ pid: 1, uniqueId: "1" }, { pid: anchorPid, uniqueId: String(anchorPid) }];
const assess = (s: DarwinProcessRecoverySnapshot, anchors: { preRunIdentities?: readonly ProcessRecoveryAnchor[]; trustedExternalManagedServiceIdentities?: readonly ProcessRecoveryAnchor[] } = {}) => assessDarwinObserverRecovery({
  host: "test-host", bootId: boot, boundary, runFinishedAt: "2026-09-20T12:27:00.000Z", snapshot: s,
  preRunIdentities: anchors.preRunIdentities ?? preRun,
  trustedExternalManagedServiceIdentities: anchors.trustedExternalManagedServiceIdentities ?? [],
});

test("stable kernel ancestry to an authenticated pre-run identity is external", () => {
  expect(assess(snapshot(row(childPid, anchorPid, young), row(grandchildPid, childPid, young)))).toMatchObject({ ok: true, external: expect.arrayContaining([{ pid: grandchildPid, basis: "ancestry", anchor: anchorPid }]) });
});
test("wall birth alone cannot establish a pre-run anchor, including a rollback birth", () => {
  expect(assess(snapshot(row(childPid, 1, old)))).toMatchObject({ ok: false, unresolved: [childPid] });
  expect(assess(snapshot(), { preRunIdentities: [] })).toMatchObject({ ok: false, unresolved: [1, anchorPid] });
  const changedWallClock = snapshot();
  changedWallClock.processes[1]!.birthMs = young;
  expect(assess(changedWallClock)).toMatchObject({ ok: true });
});
test("pre-run anchors bind the exact PID and unique64, not a reused PID", () => {
  const s = snapshot(row(childPid, anchorPid, young, "200", "100"));
  s.processes[1]!.uniqueId = "100";
  expect(assess(s)).toMatchObject({ ok: false, unresolved: [anchorPid, childPid] });
});
test("an orphan, including orphan exec with launchd parent64 and matching version32, remains unresolved", () => {
  expect(assess(snapshot(row(childPid, 1, young)))).toMatchObject({ ok: false, unresolved: [childPid] });
});
test("a launchd service requires an independent exact external identity as well as service binding", () => {
  const s = snapshot(row(childPid, 1, young), row(grandchildPid, childPid, young));
  const trustedExternalManagedServiceIdentities = [{ pid: childPid, uniqueId: String(childPid) }];
  expect(assess(s, { trustedExternalManagedServiceIdentities })).toMatchObject({ ok: false, unresolved: [childPid, grandchildPid] });
  s.managedServices = [{ domain: "system", label: "test.service", pid: childPid, uniqueId: String(childPid), beforeUniqueId: String(childPid), afterUniqueId: String(childPid), identityBound: true }];
  // A task-delegated job is also managed by launchd; its listing is insufficient.
  expect(assess(s)).toMatchObject({ ok: false, unresolved: [childPid, grandchildPid] });
  expect(assess(s, { trustedExternalManagedServiceIdentities: [{ pid: childPid, uniqueId: "2000" }] })).toMatchObject({ ok: false, unresolved: [childPid, grandchildPid] });
  expect(assess(s, { trustedExternalManagedServiceIdentities })).toMatchObject({ ok: true });
  s.managedServices[0]!.afterUniqueId = "2000";
  expect(assess(s, { trustedExternalManagedServiceIdentities })).toMatchObject({ ok: false, unresolved: [childPid, grandchildPid] });
});
test.each(["pre-run", "managed", "probe"])("a traced %s root cannot anchor external descendants", variant => {
  const s = snapshot(row(childPid, anchorPid, young), row(grandchildPid, childPid, young));
  s.processes[2]!.traced = true;
  const anchors: Parameters<typeof assess>[1] = {};
  if (variant === "pre-run") anchors.preRunIdentities = [...preRun, { pid: childPid, uniqueId: String(childPid) }];
  if (variant === "managed") {
    s.managedServices = [{ domain: "system", label: "test.service", pid: childPid, uniqueId: String(childPid), beforeUniqueId: String(childPid), afterUniqueId: String(childPid), identityBound: true }];
    anchors.trustedExternalManagedServiceIdentities = [{ pid: childPid, uniqueId: String(childPid) }];
  }
  if (variant === "probe") s.collectorPids = [childPid];
  expect(assess(s, anchors)).toMatchObject({ ok: false, unresolved: [childPid, grandchildPid] });
});
test("parent creation identity must precede its child even after detach and exec changed parent64", () => {
  expect(assess(snapshot(row(laterPid, anchorPid, young), row(childPid, laterPid, young)))).toMatchObject({ ok: false, unresolved: [childPid] });
  // Compare full uint64 values, not rounded JS numbers or decimal strings.
  expect(assess(snapshot(row(childPid, anchorPid, young, "9007199254740993"), row(grandchildPid, childPid, young, "9007199254740992", "9007199254740993")))).toMatchObject({ ok: false, unresolved: [grandchildPid] });
  expect(assess(snapshot(row(childPid, anchorPid, young, "9000000"), row(grandchildPid, childPid, young, "9000001", "9000000")))).toMatchObject({ ok: true });
});
test.each(["preRunIdentities", "trustedExternalManagedServiceIdentities"] as const)("%s rejects malformed or ambiguous anchors", field => {
  for (const anchors of [[{ pid: anchorPid, uniqueId: "18446744073709551616" }], [...preRun, { pid: anchorPid, uniqueId: "11" }], [...preRun, { pid: otherPid, uniqueId: String(anchorPid) }]]) {
    expect(assess(snapshot(), { [field]: anchors }).ok).toBe(false);
  }
});
test.each(["reused-parent", "missing-parent", "traced", "unknown-birth", "same-second"])("%s cannot be an externality shortcut", variant => {
  const child = row(childPid, anchorPid, young);
  if (variant === "reused-parent") child.parentUniqueId = "10000";
  if (variant === "missing-parent") child.ppid = missingPid;
  if (variant === "traced") child.traced = true;
  if (variant === "unknown-birth") { child.ppid = 1; child.birthMs = null; }
  if (variant === "same-second") { child.ppid = 1; child.birthMs = Date.parse(boundary) - 1; }
  expect(assess(snapshot(child))).toMatchObject({ ok: false, unresolved: [childPid] });
});
test("cycles and PID domains without a managed-service PID are not proof", () => {
  const s = snapshot(row(childPid, grandchildPid, young), row(grandchildPid, childPid, young));
  expect(assess(s)).toMatchObject({ ok: false, unresolved: [childPid, grandchildPid] });
  const orphan = snapshot(row(orphanPid, 1, young));
  orphan.pidDomains = [{ pid: orphanPid, domain: `pid/${orphanPid}`, readable: true, identityBound: true, uniqueId: String(orphanPid), type: "pid", handle: orphanPid, originator: "/System/test.xpc", creatorPid: 1 }];
  expect(assess(orphan)).toMatchObject({ ok: false, unresolved: [orphanPid] });
});
test.each(["different-boot", "different-host", "incomplete", "changed", "error", "duplicate", "before-finish"])("%s census cannot authorize recovery", variant => {
  const s = snapshot();
  if (variant === "different-boot") s.bootId = "1774c645-ad9a-4d83-9efb-eca6506656c5";
  if (variant === "different-host") s.host = "another-host";
  if (variant === "incomplete") s.complete = false;
  if (variant === "changed") s.identityChanges = [anchorPid];
  if (variant === "error") s.errors = ["unreadable-process"];
  if (variant === "duplicate") s.processes.push({ ...s.processes[0]! });
  if (variant === "before-finish") s.startedAt = boundary;
  expect(assess(s).ok).toBe(false);
});
