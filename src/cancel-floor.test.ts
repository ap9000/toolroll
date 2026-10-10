import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN, openStore, type Store } from "./store.js";

/**
 * The cancellation floor (MCP gateway spec v6, Codex round-5 finding 2):
 * one function is the only writer of state='cancelled', so no road can
 * cancel without a typed reason — and, once coordinator filings exist,
 * without their durable event.
 */
describe("cancellation floor", () => {
  test("ARCH: exactly one statement in src/ writes state='cancelled'", () => {
    const src = join(import.meta.dirname);
    const hits: string[] = [];
    for (const name of readdirSync(src)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(src, name), "utf8");
      let at = -1;
      // The floor is a task's: the lead's own promises (lead_commitment) close with their own cancelled state.
      while ((at = text.indexOf("SET state = 'cancelled'", at + 1)) !== -1) if (!text.slice(Math.max(0, at - 40), at).includes("UPDATE lead_commitment")) hits.push(name);
    }
    expect(hits).toEqual(["store.ts"]);
  });

  test("the floor honors admitted-from states and reports unknown tasks as unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "cancel-floor-"));
    const store = openStore(join(dir, "t.db"));
    const now = new Date("2026-08-30T12:00:00Z");
    expect(store.applyCancellation("nope", { kind: "operator", text: null }, now, null)).toEqual({
      changed: false,
    });
    const made = store.createConsoleTask({ title: "cancel me", filedVia: "console" }, now);
    if (!made.ok) throw new Error("filing failed");
    // done is not in the admitted set — the floor refuses to cancel it.
    const forced = store.setTaskState(made.id, "done", now);
    expect(forced).toMatchObject({ ok: true });
    expect(
      store.applyCancellation(made.id, { kind: "machine", code: "mirror-latched" }, now, [
        "queued",
        "failed",
        "running",
      ]),
    ).toEqual({ changed: false });
    // admittedFrom null cancels from any state (the state verb's law).
    expect(store.applyCancellation(made.id, { kind: "operator", text: "wrong task" }, now, null)).toEqual({
      changed: true,
    });
    store.close();
  });

  /** A task with questions on one run each: open, expired, and one already answered. */
  const OPTIONS = [{ id: "a", label: "A", consequence: "a", reversible: true }, { id: "b", label: "B", consequence: "b", reversible: true }];
  const route = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };
  function asking(store: Store, id: string, now: Date) {
    store.createTask({ id, title: id }, now);
    const taskRef = store.refFor(BUILT_IN, id).id;
    const ask = (state: "open" | "expired" | "answered") => {
      const run = store.startRun({ taskRef, leaseId: `${id}-${state}`, runner: "r", branch: "b", worktree: "/w", ...route, now });
      const decision = store.saveDecision({ run, urgency: "blocking", recap: "r", question: `${state}?`, options: OPTIONS, recommendation: "a" }, now);
      store.holdOwned({ taskRef, ownerKind: "decision", ownerId: String(decision), reason: "waiting on an answer", until: null }, now);
      store.enqueueNotification({ source: { run }, dedupeKey: `decision:${decision}`, kind: "decision", subject: "a question", body: "q" }, now);
      if (state === "expired") store.raw().prepare("UPDATE decision SET state = 'expired' WHERE id = ?").run(decision);
      if (state === "answered") store.answerDecision({ id: decision, choice: "b", by: "alex", via: "cli", note: "keep it" }, now);
      return decision;
    };
    return { taskRef, open: ask("open"), expired: ask("expired"), answered: ask("answered") };
  }
  const waiting = (store: Store, taskRef: number) => ({
    queue: store.listDecisions("unanswered").filter(one => store.lookupRef(one.taskId)?.id === taskRef).length,
    holds: Number(store.raw().prepare("SELECT count(*) AS n FROM hold WHERE task_ref = ? AND owner_kind = 'decision'").get(taskRef)!["n"]),
    pages: Number(store.raw().prepare("SELECT count(*) AS n FROM notification WHERE task_ref = ? AND dedupe_key LIKE 'decision:%' AND resolved_at IS NULL").get(taskRef)!["n"]),
  });

  test.each([
    ["an ordinary cancellation", (store: Store, id: string, now: Date) => store.setTaskState(id, "cancelled", now, { idempotencyKey: `cancel-${id}` })],
    ["a replacement", (store: Store, id: string, now: Date) => store.setTaskState(id, "cancelled", now, {}, undefined, "other")],
    ["the cancel verb", (store: Store, id: string, now: Date) => store.cancelTask(id, now, "not needed")],
    ["a machine cancellation", (store: Store, id: string, now: Date) => store.applyCancellation(id, { kind: "machine", code: "mirror-latched" }, now, null)],
  ] as const)("%s closes the task's open and expired questions — holds and pages with them — and leaves answered and unrelated ones alone", (_road, cancel) => {
    const dir = mkdtempSync(join(tmpdir(), "cancel-questions-"));
    const store = openStore(join(dir, "t.db"));
    const now = new Date("2026-10-09T12:00:00Z"), later = new Date("2026-10-09T12:05:00Z");
    try {
      const task = asking(store, "doomed", now), other = asking(store, "other", now);
      expect(waiting(store, task.taskRef)).toEqual({ queue: 2, holds: 2, pages: 2 });
      cancel(store, "doomed", later);
      expect(store.getTask("doomed")?.state).toBe("cancelled");
      for (const id of [task.open, task.expired]) {
        expect(store.getDecision(id)).toMatchObject({ state: "answered", answeredAt: later.toISOString(), choice: null, note: null, supersededReason: "cancelled" });
      }
      // The answered question's hold and page were already the answer's to settle; it keeps its answer.
      expect(store.getDecision(task.answered)).toMatchObject({ state: "answered", choice: "b", note: "keep it", answeredBy: "alex", supersededReason: null });
      expect(store.raw().prepare("SELECT action, outcome FROM action_ledger WHERE task_id = 'doomed' AND action IN ('decision answered','decision closed') ORDER BY id").all()).toEqual([
        { action: "decision answered", outcome: "answered" },
        { action: "decision closed", outcome: "cancelled" },
        { action: "decision closed", outcome: "cancelled" },
      ]);
      expect(waiting(store, task.taskRef)).toEqual({ queue: 0, holds: 0, pages: 0 });
      // The other task's questions are untouched.
      expect(waiting(store, other.taskRef)).toEqual({ queue: 2, holds: 2, pages: 2 });
      expect(store.getDecision(other.open)).toMatchObject({ state: "open", supersededReason: null });
      expect(store.getDecision(other.expired)).toMatchObject({ state: "expired", supersededReason: null });
      // A replayed or repeated cancellation changes nothing more, and the ledger chain holds.
      cancel(store, "doomed", new Date("2026-10-09T12:10:00Z"));
      expect(store.getDecision(task.open)).toMatchObject({ answeredAt: later.toISOString(), supersededReason: "cancelled" });
      expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true });
    } finally {
      store.close();
    }
  });
});
