import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flowTaskFixture } from "../test/flow-card-task.js";
import { flowCardTaskLine } from "./flow-card-task.js";
import { openStore, type Store } from "./store.js";

const now = new Date("2026-10-07T17:00:00Z");
let store: Store, fixture: ReturnType<typeof flowTaskFixture>;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); store = openStore(":memory:"); fixture = flowTaskFixture(store, now); });
afterEach(() => { store.close(); vi.useRealTimers(); });
const line = (secrets: string[] = []) => flowCardTaskLine(store, fixture.id, fixture.repo, now, secrets);

test("shows the live build's step count, and Building before any progress was saved", () => {
  expect(line()).toBe("Building");
  fixture.checkpoint(["completed", "completed", "current", "pending", "pending", "pending"]);
  expect(line()).toBe("Building · step 3 of 6");
  fixture.checkpoint(["completed", "completed"]);
  expect(line()).toBe("Building · step 2 of 2");
});

test("says why a step is stuck, in one short line, with a numbered fallback", () => {
  fixture.checkpoint(["completed", "blocked"], "Staging is unavailable.\nRetry after the deploy.");
  expect(line()).toBe("Stuck: Staging is unavailable. Retry after the deploy");
  fixture.checkpoint(["completed", "blocked"]);
  expect(line()).toBe("Stuck: step 2 of 2");
  fixture.checkpoint(["blocked"], "Waiting for the staging service to accept connections. ".repeat(12));
  expect(line().length).toBeLessThanOrEqual(107);
  expect(line()).toMatch(/…$/);
});

test("an open question takes priority over build progress", () => {
  fixture.checkpoint(["current", "pending"]);
  fixture.question();
  expect(line()).toBe("Waiting on you: Use banker's rounding for refunds too?");
});

test("an unapproved plan names the action, without pretending work is running", () => {
  fixture.finish();
  store.setTaskState(fixture.id, "queued", now);
  store.handle.prepare("UPDATE task_scope SET approved_digest = NULL, approved_at = NULL WHERE task_id = ?").run(fixture.id);
  expect(line()).toBe("Waiting on you: Approve plan");
});

test("finished work is Ready without optional historical proof, while a failed check stays visible", () => {
  fixture.finish();
  expect(line()).toBe("Ready");
  store.recordRunCheck(fixture.run, { status: "failed", exitCode: 1, suites: [] }, now);
  expect(line()).toMatch(/^Stuck: .*check/i);
});

test("does not read a different attempt's later checkpoint", () => {
  fixture.checkpoint(["current", "pending"]);
  const prior = store.startRun({ taskRef: fixture.ref, leaseId: "old-lease", runner: "builder", branch: "fixture/old", worktree: fixture.repo,
    role: "builder", route: store.runRoute(fixture.run)!, now });
  store.finishRun(prior, { outcome: "refused", reason: "plan-changed", now });
  fixture.checkpoint(["completed", "blocked"], "Old attempt stopped", prior);
  expect(line()).toBe("Building · step 1 of 2");
});

test.each([
  '{"command":"cat private.txt","arguments":{"token":"private-value"}}',
  "Run curl --header Authorization=private-value",
  "API_KEY=private-value", "DATABASE_PASSWORD=private-value", "--path /private/input.txt", "Bearer abcdefghijklmnop", `sk-${"a".repeat(40)}`,
  "The service returned private-value", `Long reason ${"a".repeat(250)} ghp_${"a".repeat(36)}`,
])("does not show tool arguments or credentials: %s", reason => {
  fixture.checkpoint(["blocked"], reason);
  expect(line(["private-value"])).toBe("Stuck: step 1 of 1");
});

test("unsafe questions fall back to an action, and foreign or missing tasks disclose no state", () => {
  fixture.question('{"tool_input":{"password":"private-value"}}');
  expect(line()).toBe("Waiting on you: Answer the question");
  expect(flowCardTaskLine(store, fixture.id, "/another-project", now)).toBe("Task unavailable");
  expect(flowCardTaskLine(store, "missing", fixture.repo, now)).toBe("Task unavailable");
});
