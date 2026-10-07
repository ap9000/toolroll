/** What a running agent did last (task-activity.ts, live.ts): recorded as a fixed kind only, read as the newer of that
 * and the latest progress, offline only on a lapsed heartbeat, and swept by the live log's own rules. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { liveActivityKind } from "./live.js";
import { register } from "./runner.js";
import { openStore, type Store } from "./store.js";
import { runActivityOf, withRunActivity } from "./task-activity.js";
import { presented, T0 } from "../test/serve-kit.js";

let store: Store;
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function startRun(id: string, runner = "builder-1"): number {
  store.createTask({ id, title: `work ${id}` }, T0);
  const ref = store.refFor("built-in", id).id;
  return store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner, branch: `b-${id}`, worktree: `/pool/${id}`, now: T0, ...presented(store, ref, "builder") });
}

/** A progress checkpoint row as the builder leaves one (its plan revision is not what this reads). */
function checkpoint(run: number, now: Date): void {
  const ref = Number(store.handle.prepare("SELECT task_ref FROM run WHERE id = ?").get(run)!["task_ref"]);
  store.handle.exec("PRAGMA foreign_keys = OFF");
  store.handle.prepare("INSERT INTO run_checkpoint (run, task_ref, plan_revision, snapshot_json, created_at) VALUES (?, ?, 1, '{}', ?)").run(run, ref, now.toISOString());
  store.handle.exec("PRAGMA foreign_keys = ON");
}

beforeEach(() => {
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
});
afterEach(() => store.close());

describe("what the agent did last", () => {
  test("a tool call becomes one fixed kind: never its arguments, never its own name", () => {
    const secret = "sk-ant-api03-" + "x".repeat(40);
    expect(liveActivityKind({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: `curl -H "Authorization: ${secret}"` } }] } })).toBe("command");
    expect(liveActivityKind({ type: "assistant", message: { content: [{ type: "tool_use", name: secret, input: {} }] } })).toBe("tool");
    expect(liveActivityKind({ type: "assistant", message: { content: [{ type: "text", text: "Running the tests now" }, { type: "tool_use", name: "Edit" }] } })).toBe("edit");
    expect(liveActivityKind({ type: "item.completed", item: { type: "command_execution", command: secret } })).toBe("command");
    expect(liveActivityKind({ type: "system", subtype: "init" })).toBe("session");
    // Results, deltas and a helper's own chatter say nothing about this run.
    expect(liveActivityKind({ type: "user", message: { content: [{ type: "tool_result", content: secret }] } })).toBeNull();
    expect(liveActivityKind({ type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [{ type: "tool_use", name: "Bash" }] } })).toBeNull();
    expect(liveActivityKind({ type: "message", role: "assistant", delta: true, content: "x" })).toBeNull();
  });

  test("the stream keeps one row per run: the kind and when, nothing else, at most once per few seconds while it repeats", () => {
    const run = startRun("t-1");
    const seen: unknown[] = [];
    let now = at(10);
    const watch = withRunActivity({ observe: event => seen.push(event), close: () => seen.push("closed") }, store, run, () => now);
    const bash = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test -- --token=hunter2" } }] } };
    watch.observe(bash);
    expect(store.handle.prepare("SELECT * FROM run_activity").all()).toEqual([{ run, kind: "command", at: at(10).toISOString() }]);
    now = at(12); watch.observe(bash);
    expect(store.runActivity(run)).toMatchObject({ kind: "command", at: at(10).toISOString() });
    now = at(13); watch.observe({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } });
    expect(store.runActivity(run)).toMatchObject({ kind: "read", at: at(13).toISOString() });
    now = at(30); watch.observe(bash);
    expect(store.runActivity(run)).toMatchObject({ kind: "command", at: at(30).toISOString() });
    // The live log still hears every event; a store that fails never touches the run.
    expect(seen).toHaveLength(4);
    const broken = withRunActivity(null, { recordRunActivity: () => { throw new Error("busy"); } }, run, () => now);
    expect(() => broken.observe(bash)).not.toThrow();
    watch.close();
    expect(seen.at(-1)).toBe("closed");
    expect(JSON.stringify(store.handle.prepare("SELECT * FROM run_activity").all())).not.toContain("hunter2");
  });

  test("the line reads the newer of the last activity and the last progress, else when the run started", () => {
    register(store, { name: "builder-1", host: "here", capacity: 1, now: at(100), newToken: () => "tok" });
    const run = startRun("t-2");
    const of = () => runActivityOf(store, { id: run, runner: "builder-1", startedAt: T0.toISOString() }, at(120));
    expect(of()).toEqual({ what: "Started", at: T0.toISOString(), worker: "online" });
    store.recordRunActivity(run, "edit", at(40));
    expect(of()).toEqual({ what: "Edited files", at: at(40).toISOString(), worker: "online" });
    checkpoint(run, at(60));
    expect(of()).toEqual({ what: "Reported progress", at: at(60).toISOString(), worker: "online" });
    store.recordRunActivity(run, "command", at(80));
    expect(of().what).toBe("Ran a command");
  });

  test("a worker whose heartbeat lapsed is offline; one that answers, or that isn't registered, is not", () => {
    register(store, { name: "builder-1", host: "here", capacity: 1, now: T0, newToken: () => "tok" });
    const run = startRun("t-3");
    const of = (runner: string, now: Date) => runActivityOf(store, { id: run, runner, startedAt: T0.toISOString() }, now).worker;
    expect(of("builder-1", at(60))).toBe("online");
    expect(of("builder-1", at(4 * 60))).toBe("offline");
    expect(of("somewhere-else", at(4 * 60))).toBe("online");
  });

  test("swept like the live log: a live run's row stays, a finished run's goes after a day or beyond the bound", () => {
    const live = startRun("t-live"), old = startRun("t-old"), recent = startRun("t-recent"), newest = startRun("t-newest");
    for (const [run, when] of [[live, at(0)], [old, at(10)], [recent, at(3_600)], [newest, at(7_200)]] as const) store.recordRunActivity(run, "command", when);
    for (const run of [old, recent, newest]) store.finishRun(run, { outcome: "built", now: at(7_200) });
    const day = 24 * 3_600_000, rows = () => (store.handle.prepare("SELECT run FROM run_activity ORDER BY run").all() as { run: number }[]).map(one => one.run);
    expect(store.sweepRunActivity(at(3_600 + day / 1000 - 60), day, 500)).toBe(1);
    expect(rows()).toEqual([live, recent, newest]);
    expect(store.sweepRunActivity(at(3_600), day, 1)).toBe(1);
    expect(rows()).toEqual([live, newest]);
    expect(store.sweepRunActivity(at(30 * day / 1000), day, 0)).toBe(1);
    expect(rows()).toEqual([live]);
  });
});
