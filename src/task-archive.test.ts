/**
 * A put-away task (v144, docs/plans/task-tidy.md) fails closed at every door: it is not ready, not claimable, not
 * approvable and nudges nobody, until a person restores it; it leaves every list and count but its own page; and
 * putting away refuses while work is still going on. Isolated stores only.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolve } from "node:path";
import { openStore, archiveOf, archiveTaskFamily, restoreTaskFamily, type Store } from "./store.js";
import { acquire, acquireIfReady } from "./claim.js";
import { taskReadinessBlocker } from "./dispatch.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { workCountsByProject, workIndexPage, workIndexTask } from "./work-index.js";
import { refArchived } from "./task-archive.js";

const T0 = new Date("2026-11-01T10:00:00.000Z");
const REPO = resolve("/repo/main");
const ALL = { principal: "operator" as const, repos: null, includeUnplaced: true };
const BY = { by: "alex", byKind: "person" as const, rule: null, reason: "Done with it" };

let store: Store;
let token: string;
beforeEach(() => {
  store = openStore(":memory:");
  for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap failed");
  token = added.token;
  register(store, { name: "mac-mini", host: "here", capacity: 4, repos: [REPO], now: T0, newToken: () => "tok-mac-mini" });
});
afterEach(() => store.close());

/** A placed task with a proposed scope; approved unless asked not to. */
function seed(id: string, approved = true): number {
  store.createTask({ id, title: `Fix ${id}` }, T0);
  const ref = store.refFor("built-in", id, "ours").id;
  store.placeTask(ref, REPO);
  propose(store, { taskId: id, goal: `fix ${id}`, now: T0 });
  if (approved) {
    const agreed = approve(store, id, "alex", T0, store.getScope(id)!.digest, token);
    if (!agreed.ok) throw new Error(`approval refused: ${agreed.reason}`);
  }
  return ref;
}

describe("nothing dispatches, claims or approves a put-away task", () => {
  test("ready list, readiness, every claim road: refused while put away, back once restored", () => {
    const ref = seed("login");
    expect(store.listReady(T0).map(one => one.id)).toContain(ref);
    expect(archiveTaskFamily(store, "login", BY, T0)).toMatchObject({ ok: true, refs: [ref] });
    expect(store.listReady(T0).map(one => one.id)).not.toContain(ref);
    expect(taskReadinessBlocker(store, ref, T0)).toMatchObject({ code: "archived" });
    expect(acquire(store, ref, "mac-mini", { token: "tok-mac-mini", now: T0 })).toMatchObject({ ok: false, reason: "archived" });
    expect(acquireIfReady(store, ref, "mac-mini", { token: "tok-mac-mini", now: T0 })).toMatchObject({ ok: false });
    expect(store.handle.prepare("SELECT COUNT(*) n FROM claim").get()?.["n"]).toBe(0);
    expect(restoreTaskFamily(store, "login", "alex", T0)).toMatchObject({ ok: true });
    expect(acquire(store, ref, "mac-mini", { token: "tok-mac-mini", now: T0 })).toMatchObject({ ok: true });
  });

  test("approving its scope refuses, by the ceremony and by the primitive every road calls", () => {
    seed("signup", false);
    archiveTaskFamily(store, "signup", BY, T0);
    expect(approve(store, "signup", "alex", T0, store.getScope("signup")!.digest, token)).toEqual({ ok: false, reason: "archived" });
    expect(store.sealScopeApproval("signup", "alex", T0, {}, { kind: "mode", modeDigest: "m" })).toBe(false);
    expect(store.getScope("signup")!.approvedAt).toBeNull();
  });

  test("putting away refuses while an attempt holds the task, and changes nothing", () => {
    const ref = seed("busy");
    expect(acquire(store, ref, "mac-mini", { token: "tok-mac-mini", now: T0, ttlMs: 3_600_000 })).toMatchObject({ ok: true });
    expect(archiveTaskFamily(store, "busy", BY, T0)).toMatchObject({ ok: false, reason: "live" });
    expect(refArchived(store, ref)).toBe(false);
  });

  test("a guard re-read in the transaction can still refuse; a second put away and a restore of a kept task answer plainly", () => {
    seed("one");
    expect(archiveTaskFamily(store, "one", BY, T0, { guard: () => "alex can't put away or restore tasks in this project." })).toMatchObject({ ok: false, reason: "blocked" });
    expect(archiveTaskFamily(store, "one", BY, T0, { expect: [999] })).toMatchObject({ ok: false, reason: "blocked" });
    expect(restoreTaskFamily(store, "one", "alex", T0)).toMatchObject({ ok: false, reason: "not-archived" });
    expect(archiveTaskFamily(store, "one", BY, T0).ok).toBe(true);
    expect(archiveTaskFamily(store, "one", BY, T0)).toMatchObject({ ok: false, reason: "archived" });
    expect(archiveTaskFamily(store, "nope", BY, T0)).toMatchObject({ ok: false, reason: "unknown-task" });
  });
});

describe("a put-away task leaves every list and nudge, and keeps its history", () => {
  test("lists and counts: only Archived shows it, its own page still finds it", () => {
    seed("a", false);
    seed("b", false);
    const before = workIndexPage(store, T0, ALL, { view: "needs-you" }).totals;
    expect(before).toMatchObject({ all: 2, "needs-you": 2, archived: 0 });
    archiveTaskFamily(store, "a", BY, T0);
    const page = workIndexPage(store, T0, ALL, { view: "needs-you" });
    expect(page.totals).toMatchObject({ all: 1, "needs-you": 1, archived: 1 });
    expect(page.items.map(one => one.rootId)).toEqual(["b"]);
    expect(workIndexPage(store, T0, ALL, { view: "all" }).items.map(one => one.rootId)).toEqual(["b"]);
    const archived = workIndexPage(store, T0, ALL, { view: "archived" });
    expect(archived.items.map(one => [one.rootId, one.archived?.reason, one.status.views])).toEqual([["a", "Done with it", ["archived"]]]);
    expect(workIndexTask(store, "a", T0, ALL)?.archived).toMatchObject({ by: "alex", byKind: "person" });
    expect(workCountsByProject(store, T0, ALL)[0]!.totals).toMatchObject({ all: 1, "needs-you": 1, archived: 1 });
    expect(store.countInboxScoped(null, T0).count).toBe(1);
  });

  test("its open notifications are resolved and no new one is enqueued; restore records who", () => {
    const ref = seed("c", false);
    expect(store.enqueueNotification({ dedupeKey: "n1", kind: "attention", subject: "s", body: "b", pushClass: "attention", source: { taskRef: ref } }, T0)).toBe(true);
    archiveTaskFamily(store, "c", BY, T0);
    expect(store.handle.prepare("SELECT resolved_at FROM notification WHERE dedupe_key = 'n1'").get()?.["resolved_at"]).toBe(T0.toISOString());
    expect(store.enqueueNotification({ dedupeKey: "n2", kind: "attention", subject: "s", body: "b", pushClass: "attention", source: { taskRef: ref } }, T0)).toBe(false);
    expect(store.enqueueNotification({ dedupeKey: "n3", kind: "lead-on-it", subject: "s", body: "", source: { taskRef: ref } }, T0)).toBe(false);
    restoreTaskFamily(store, "c", "alex", T0);
    expect(archiveOf(store, "c")).toBeNull();
    const ledger = store.handle.prepare("SELECT actor, action, detail FROM action_ledger WHERE task_id = 'c' AND action IN ('task archived','task restored') ORDER BY id").all();
    expect(ledger).toEqual([{ actor: "operator:alex", action: "task archived", detail: "Done with it" }, { actor: "operator:alex", action: "task restored", detail: null }]);
  });

  test("its state, scope and approval bytes are untouched by putting away and restoring", () => {
    seed("d");
    const before = { task: store.getTask("d"), scope: store.getScope("d") };
    archiveTaskFamily(store, "d", BY, T0);
    restoreTaskFamily(store, "d", "alex", T0);
    expect({ task: store.getTask("d"), scope: store.getScope("d") }).toEqual(before);
  });
});
