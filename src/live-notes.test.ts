/**
 * Which steering notes a run's conversation shows (live-notes.ts): the notes
 * that reached that run, kept as they happened even after a later attempt
 * takes them over, credited as read only to the run that read them; "You"
 * only for the person who wrote it.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { runNotes } from "./live-notes.js";
import { BUILT_IN, openStore, verifiedAuthor, type Store } from "./store.js";

const T0 = new Date("2026-10-18T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };

let store: Store, taskRef: number;
beforeEach(() => {
  store = openStore(":memory:");
  store.createTask({ id: "t-1", title: "the work" }, T0);
  taskRef = store.refFor(BUILT_IN, "t-1").id;
});
afterEach(() => store.close());

const start = (lease: string, when: Date) => store.startRun({ taskRef, leaseId: lease, runner: "builder-1", branch: "b", worktree: "/pool/wt", now: when, ...legacy });
const file = (author: string, note: string, when: Date) => {
  const filed = store.fileSteerNote("t-1", verifiedAuthor(author), note, when);
  if (!filed.ok) throw new Error(filed.reason);
  return filed.id;
};

test("a note mailed to one attempt and read by the next shows on both, credited to the one that read it", () => {
  const first = start("lease-1", T0);
  const note = file("alex", "start with the retry path", at(1));
  expect(store.markSteerMailed(note, first, at(2))).toBe(true);
  store.finishRun(first, { outcome: "failed", reason: "agent", now: at(3) });
  // An unrelated note filed after the first attempt ended never shows on it.
  const later = file("robin", "and the docs", at(4));

  const second = start("lease-2", at(5));
  expect(store.attachSteerNotes(taskRef, second, at(5)).map(one => one.id)).toEqual([note, later]);
  expect(store.settleSteerDelivered(second, at(6))).toBe(2);

  const onFirst = runNotes(store, { id: first, taskRef }, "alex", at(7));
  expect(onFirst.notes).toEqual([{ id: note, author: "alex", mine: true, at: at(1).toISOString(), text: "start with the retry path", standing: "Read in another attempt", readAt: null }]);
  const onSecond = runNotes(store, { id: second, taskRef }, "robin", at(7));
  expect(onSecond.notes.map(one => [one.id, one.mine, one.standing, one.readAt])).toEqual([
    [note, false, "Read by the agent at", at(6).toISOString()],
    [later, true, "Read by the agent at", at(6).toISOString()],
  ]);
});

test("an attempt that ended without reading a note says the next one gets it", () => {
  const first = start("lease-1", T0);
  const note = file("alex", "check the logs", at(1));
  store.attachSteerNotes(taskRef, first, at(1));
  store.finishRun(first, { outcome: "failed", reason: "agent", now: at(2) });
  expect(runNotes(store, { id: first, taskRef }, "alex", at(3)).notes).toEqual([
    expect.objectContaining({ id: note, standing: "Not read in this attempt — the next one gets it", readAt: null }),
  ]);
});
