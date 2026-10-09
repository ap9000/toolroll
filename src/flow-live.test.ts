import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flowTaskFixture } from "../test/flow-card-task.js";
import { createFlowRooms, flowFingerprint } from "./flow-live.js";
import { createLiveBus, followWorkspace, LiveConnection } from "./live-bus.js";
import { prepareWorkspaceRevision } from "./workspace-revision.js";
import { openStore, type Store } from "./store.js";

const now = new Date("2026-10-07T17:00:00Z");
let store: Store, fixture: ReturnType<typeof flowTaskFixture>;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); store = openStore(":memory:"); fixture = flowTaskFixture(store, now); });
afterEach(() => { vi.restoreAllMocks(); store.close(); vi.useRealTimers(); });
const fingerprint = () => flowFingerprint(store, fixture.flow);

function task(id: string, repo = fixture.repo): number {
  store.createTask({ id, title: id }, now);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, repo, {}, now);
  return ref;
}

function linkRevision(child: string, parent: string, source = parent, kind: "revision-brief" | "plan" = "revision-brief"): void {
  const run = store.startRun({ taskRef: store.lookupRef(source)!.id, leaseId: `source-${child}`, runner: "builder", branch: "fixture/revision", worktree: fixture.repo,
    role: "builder", route: source === fixture.id ? store.runRoute(fixture.run)! : { phase: "build", routeDigest: "legacy", provider: "claude", model: null, chosen: "legacy" }, now });
  store.finishRun(run, { outcome: "built", now });
  const brief = store.saveArtifact({ run, kind, key: `${child}.json`, sha256: "c".repeat(64), bytesOriginal: 0, bytesStored: 0, truncated: false, capture: "synthetic revision" }, now);
  store.markRevision(store.lookupRef(child)!.id, parent, brief);
}

function expectTaskTracked(id: string, tracked: boolean): void {
  const before = fingerprint();
  // Restore both the state and the ledger entries written by database triggers.
  store.handle.exec("SAVEPOINT progress_probe");
  try {
    store.handle.prepare("UPDATE task SET state = 'failed' WHERE id = ?").run(id);
    expect(fingerprint() !== before, `progress for ${id}`).toBe(tracked);
  } finally { store.handle.exec("ROLLBACK TO progress_probe; RELEASE progress_probe"); }
  expect(fingerprint()).toBe(before);
}

test("41 linked cards use one prepared statement, reused for every tick and flow", () => {
  for (let index = 0; index < 40; index += 1) {
    const id = `linked-${index}`;
    store.createTask({ id, title: `Checkout follow-up ${index}` }, now);
    store.placeTask(store.refFor("built-in", id).id, fixture.repo, {}, now);
    const card = store.addFlowCard({ flow: fixture.flow, title: id, description: "Synthetic linked task", stage: "build", by: "alex" }, now);
    store.updateFlowCard(card, { task: id }, now);
  }
  // Measure only the fingerprint, never fixture setup or task projection.
  const prepare = vi.spyOn(store.handle, "prepare");
  const first = fingerprint();
  expect(prepare).toHaveBeenCalledTimes(1);
  const read = vi.spyOn(prepare.mock.results[0]!.value, "get");
  expect(fingerprint()).toBe(first);
  expect(fingerprint()).toBe(first);
  expect(flowFingerprint(store, 999)).toBeNull();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(3);
});

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

test("a card linked to a revision tracks its root, siblings and descendants across the whole family", () => {
  for (const id of ["revision", "sibling", "grandchild", "unrelated"]) task(id);
  linkRevision("revision", fixture.id);
  linkRevision("sibling", fixture.id);
  linkRevision("grandchild", "revision");
  store.updateFlowCard(fixture.card, { task: "grandchild" }, now);
  const versions = store.taskFamilyOf("grandchild", [fixture.repo], false)!.versions.map(one => one.id);
  expect(versions).toEqual([fixture.id, "revision", "sibling", "grandchild"]);
  for (const id of versions) expectTaskTracked(id, true);
  expectTaskTracked("unrelated", false);
  // Query planner traversal order must not change any of the JSON aggregates.
  const before = fingerprint();
  store.handle.exec("PRAGMA reverse_unordered_selects = ON");
  expect(fingerprint()).toBe(before);
});

test.each(["foreign-project", "borrowed-source", "wrong-kind", "missing-brief", "missing-parent", "external-parent", "cycle"])(
  "a %s revision stays isolated, just as in the Store projection", problem => {
    task("parent", problem === "foreign-project" ? "/other-project" : fixture.repo);
    task("child"); task("descendant"); task("unrelated");
    linkRevision("child", "parent", problem === "borrowed-source" ? "unrelated" : "parent", problem === "wrong-kind" ? "plan" : "revision-brief");
    linkRevision("descendant", "child");
    if (problem === "missing-brief") store.handle.prepare("UPDATE task_ref SET revision_brief_artifact = NULL WHERE external_id = 'child'").run();
    if (problem === "missing-parent") store.handle.prepare("UPDATE task_ref SET revision_of = 'absent' WHERE external_id = 'child'").run();
    if (problem === "external-parent") store.handle.prepare("UPDATE task_ref SET backend = 'external' WHERE external_id = 'parent'").run();
    if (problem === "cycle") linkRevision("parent", "child");
    store.updateFlowCard(fixture.card, { task: "child" }, now);
    const family = store.taskFamilyOf("child", [fixture.repo], false)!;
    expect(family.problem).not.toBeNull();
    expect(family.versions.map(one => one.id)).toEqual(["child"]);
    expectTaskTracked("child", true);
    for (const id of ["parent", "descendant", "unrelated", fixture.id]) expectTaskTracked(id, false);
    // Invalid descendants must not be folded into a valid parent's family either.
    if (problem !== "cycle") {
      store.updateFlowCard(fixture.card, { task: "parent" }, now);
      expectTaskTracked("child", false);
      expectTaskTracked("descendant", false);
    }
  },
);

test("the 63-edge bound includes the last valid revision and isolates deeper linked tasks", () => {
  let parent = fixture.id;
  for (let index = 1; index <= 64; index += 1) {
    const id = `depth-${index}`;
    task(id); linkRevision(id, parent); parent = id;
  }
  expectTaskTracked("depth-63", true);
  expectTaskTracked("depth-64", false);
  store.updateFlowCard(fixture.card, { task: "depth-63" }, now);
  expect(store.taskFamilyOf("depth-63", [fixture.repo], false)!.versions).toHaveLength(64);
  expectTaskTracked(fixture.id, true);
  expectTaskTracked("depth-63", true);
  expectTaskTracked("depth-64", false);
  store.updateFlowCard(fixture.card, { task: "depth-64" }, now);
  expect(store.taskFamilyOf("depth-64", [fixture.repo], false)!.versions.map(one => one.id)).toEqual(["depth-64"]);
  expectTaskTracked("depth-64", true);
  expectTaskTracked("depth-63", false);
  expectTaskTracked(fixture.id, false);
});

test("only active cards with placed built-in tasks contribute progress", () => {
  task("foreign", "/other-project");
  store.updateFlowCard(fixture.card, { task: "foreign" }, now);
  expectTaskTracked("foreign", true); // The stream is opaque; the page enforces access.
  store.handle.prepare("UPDATE flow_card SET state = 'done' WHERE id = ?").run(fixture.card);
  expectTaskTracked("foreign", false);
  store.handle.prepare("UPDATE flow_card SET state = 'active' WHERE id = ?").run(fixture.card);
  store.handle.prepare("UPDATE task_ref SET repo = NULL WHERE external_id = 'foreign'").run();
  expectTaskTracked("foreign", false);
  store.handle.prepare("UPDATE task_ref SET repo = ?, backend = 'external' WHERE external_id = 'foreign'").run(fixture.repo);
  expectTaskTracked("foreign", false);
});

test("cached statements remain local to each database handle", () => {
  const other = openStore(":memory:");
  try {
    const otherFixture = flowTaskFixture(other, now);
    const first = fingerprint();
    const prepare = vi.spyOn(other.handle, "prepare");
    const otherFirst = flowFingerprint(other, otherFixture.flow);
    expect(otherFirst).not.toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1);
    fixture.checkpoint(["current"]);
    expect(fingerprint()).not.toBe(first);
    expect(flowFingerprint(other, otherFixture.flow)).toBe(otherFirst);
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally { other.close(); }
});

test("lease expiry changes the fingerprint without a task or card write", () => {
  expect(flowFingerprint(store, fixture.flow, new Date(now.getTime() + 3_600_001))).not.toBe(fingerprint());
});

test("a write reaches the open stream at once as one opaque change; nothing written, nothing sent", () => {
  const bus = createLiveBus();
  const revision = prepareWorkspaceRevision(store);
  const follower = followWorkspace(store, () => revision.current(), bus);
  const rooms = createFlowRooms(() => fingerprint(), { bus });
  const write = vi.fn();
  const response = Object.assign(new EventEmitter(), { write, end: vi.fn(), writableEnded: false, destroyed: false, writableLength: 0 });
  try {
    rooms.join(fixture.flow, { name: "alex", card: null, editing: false, room: "", connection: new LiveConnection(response as unknown as ServerResponse), valid: () => true });
    write.mockClear();
    fixture.checkpoint(["blocked"], "private diagnostic");
    vi.advanceTimersByTime(1);
    const changes = write.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("event: change"));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^event: change\ndata: \{"room":"","at":"[a-f0-9]{16}","revision":"v1:\d+"\}\n\n$/);
    expect(changes[0]).not.toContain("private diagnostic");
    vi.advanceTimersByTime(10_000);
    expect(write.mock.calls.filter(call => String(call[0]).startsWith("event: change"))).toHaveLength(1);
  } finally { rooms.close(); follower.close(); }
});
