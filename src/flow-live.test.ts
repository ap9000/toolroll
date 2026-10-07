import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flowTaskFixture } from "../test/flow-card-task.js";
import { createFlowRooms, flowFingerprint } from "./flow-live.js";
import { openStore, type Store } from "./store.js";

const now = new Date("2026-10-07T17:00:00Z");
let store: Store, fixture: ReturnType<typeof flowTaskFixture>;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); store = openStore(":memory:"); fixture = flowTaskFixture(store, now); });
afterEach(() => { store.close(); vi.useRealTimers(); });
const fingerprint = () => flowFingerprint(store, fixture.flow);

test("task checkpoints change the fingerprint even when no card or task timestamp changes", () => {
  const card = store.getFlowCard(fixture.card), task = store.getTask(fixture.id), before = fingerprint();
  fixture.checkpoint(["current", "pending"]);
  const first = fingerprint();
  expect(first).not.toBe(before);
  fixture.checkpoint(["completed", "current"]);
  expect(fingerprint()).not.toBe(first);
  expect(store.getFlowCard(fixture.card)).toEqual(card);
  expect(store.getTask(fixture.id)).toEqual(task);
  expect(fingerprint()).toBe(fingerprint());
  expect(flowFingerprint(store, 999)).toBeNull();
});

test("waiting questions, task outcomes and failed checks each nudge the canvas", () => {
  const before = fingerprint();
  fixture.question();
  const waiting = fingerprint();
  expect(waiting).not.toBe(before);
  fixture.finish();
  const ready = fingerprint();
  expect(ready).not.toBe(waiting);
  store.recordRunCheck(fixture.run, { status: "failed", exitCode: 1, suites: [] }, now);
  expect(fingerprint()).not.toBe(ready);
});

test("a revision's progress updates its original card, while unrelated work does not", () => {
  fixture.finish();
  store.createTask({ id: "revision", title: "Also round refunds" }, now);
  const ref = store.refFor("built-in", "revision").id;
  store.placeTask(ref, fixture.repo, {}, now);
  const brief = store.saveArtifact({ run: fixture.run, kind: "revision-brief", key: "revision.json", sha256: "c".repeat(64), bytesOriginal: 0, bytesStored: 0, truncated: false, capture: "synthetic revision" }, now);
  store.markRevision(ref, fixture.id, brief);
  const run = store.startRun({ taskRef: ref, leaseId: "revision-lease", runner: "builder", branch: "fixture/revision", worktree: fixture.repo,
    role: "builder", route: { phase: "build", routeDigest: "legacy", provider: "claude", model: null, chosen: "legacy" }, now });
  const before = fingerprint();
  store.insertRunCheckpoint({ run, taskRef: ref, planRevision: fixture.planRevision, snapshot: { revisionHash: "a".repeat(64), milestones: [{ id: "m1", state: "current", note: null }] } }, now);
  expect(fingerprint()).not.toBe(before);
  const after = fingerprint();
  store.createTask({ id: "unrelated", title: "Update the guide" }, now);
  store.placeTask(store.refFor("built-in", "unrelated").id, fixture.repo, {}, now);
  store.setTaskState("unrelated", "done", now);
  expect(fingerprint()).toBe(after);
});

test("lease expiry changes the fingerprint without a task or card write", () => {
  expect(flowFingerprint(store, fixture.flow, new Date(now.getTime() + 3_600_001))).not.toBe(fingerprint());
});

test("the existing stream sends one opaque change event on the next one-second tick", () => {
  const rooms = createFlowRooms(() => fingerprint());
  const write = vi.fn();
  const response = Object.assign(new EventEmitter(), { write, end: vi.fn(), writableEnded: false, destroyed: false });
  try {
    rooms.join(fixture.flow, { name: "alex", card: null, editing: false, response: response as unknown as ServerResponse, valid: () => true });
    write.mockClear();
    fixture.checkpoint(["blocked"], "private diagnostic");
    vi.advanceTimersByTime(1_000);
    const changes = write.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("event: change"));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^event: change\ndata: \{"at":"[a-f0-9]{16}"\}\n\n$/);
    expect(changes[0]).not.toContain("private diagnostic");
    vi.advanceTimersByTime(1_000);
    expect(write.mock.calls.filter(call => String(call[0]).startsWith("event: change"))).toHaveLength(1);
  } finally { rooms.close(); }
});
