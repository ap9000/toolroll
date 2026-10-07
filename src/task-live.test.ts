/** The live task page (task-live.ts): the family's fingerprint moves with progress, activity and a lapsed worker;
 * a room nudges every page on a change, says who else is here, and drops a page whose access ends. */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { register } from "./runner.js";
import { openStore, type Store } from "./store.js";
import { createTaskRooms, taskFingerprint, type TaskViewer } from "./task-live.js";
import { presented, T0 } from "../test/serve-kit.js";

let store: Store;
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

beforeEach(() => {
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
});
afterEach(() => { store.close(); vi.useRealTimers(); });

/** A page's open stream, as the room sees it: what it was sent, and whether it was ended. */
class Page extends EventEmitter {
  sent: string[] = [];
  writableEnded = false;
  destroyed = false;
  write(chunk: string) { this.sent.push(chunk); return true; }
  end() { this.writableEnded = true; this.emit("close"); }
  events(name: string): unknown[] {
    return this.sent.filter(one => one.startsWith(`event: ${name}\n`)).map(one => JSON.parse(one.split("\ndata: ")[1]!.trim()));
  }
}
const viewer = (name: string, page: Page, valid = () => true): TaskViewer => ({ name, response: page as unknown as ServerResponse, valid });

describe("the task's fingerprint", () => {
  test("moves with progress, with what the agent did, with a revision, and when the worker stops answering", () => {
    register(store, { name: "builder-1", host: "here", capacity: 1, now: T0, newToken: () => "tok" });
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    const run = store.startRun({ taskRef: ref, leaseId: "l-1", runner: "builder-1", branch: "b", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    const print = (now = at(30)) => taskFingerprint(store, "t-1", now);
    const first = print();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(print()).toBe(first);

    store.recordRunActivity(run, "command", at(20));
    const acted = print();
    expect(acted).not.toBe(first);

    store.handle.exec("PRAGMA foreign_keys = OFF");
    store.handle.prepare("INSERT INTO run_checkpoint (run, task_ref, plan_revision, snapshot_json, created_at) VALUES (?, ?, 1, '{}', ?)").run(run, ref, at(25).toISOString());
    store.handle.exec("PRAGMA foreign_keys = ON");
    const progressed = print();
    expect(progressed).not.toBe(acted);

    // Same rows, later: the worker's heartbeat has lapsed.
    expect(print(at(10 * 60))).not.toBe(progressed);
    expect(taskFingerprint(store, "no-such-task", at(30))).toBeNull();
  });
});

describe("a task room", () => {
  test("a joining page hears where the task stands and who else is here, once per person", async () => {
    vi.useFakeTimers();
    let print = "a";
    const rooms = createTaskRooms(() => print, 1_000);
    const alex = new Page(), robin = new Page(), robinAgain = new Page();
    rooms.join("t-1", viewer("alex", alex));
    expect(alex.events("change")).toEqual([{ at: "a" }]);
    expect(alex.events("here")).toEqual([{ people: [] }]);
    rooms.join("t-1", viewer("robin", robin));
    rooms.join("t-1", viewer("robin", robinAgain));
    await vi.advanceTimersByTimeAsync(200);
    expect(alex.events("here").at(-1)).toEqual({ people: ["robin"] });
    expect(robin.events("here").at(-1)).toEqual({ people: ["alex"] });
    expect(rooms.size()).toBe(3);

    // A change nudges every page; the nudge carries no task data.
    print = "b";
    await vi.advanceTimersByTimeAsync(1_000);
    for (const page of [alex, robin, robinAgain]) expect(page.events("change").at(-1)).toEqual({ at: "b" });

    // Robin closes both pages: Alex hears they left.
    robin.end(); robinAgain.end();
    await vi.advanceTimersByTimeAsync(200);
    expect(alex.events("here").at(-1)).toEqual({ people: [] });
    rooms.close();
    expect(alex.writableEnded).toBe(true);
    expect(rooms.size()).toBe(0);
  });

  test("a page whose access ended hears gone and is dropped; a task that no longer reads ends every page", async () => {
    vi.useFakeTimers();
    let allowed = true, print: string | null = "a";
    const rooms = createTaskRooms(() => print, 1_000);
    const alex = new Page(), robin = new Page();
    rooms.join("t-1", viewer("alex", alex));
    rooms.join("t-1", viewer("robin", robin, () => allowed));
    allowed = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(robin.events("gone")).toHaveLength(1);
    expect(robin.writableEnded).toBe(true);
    expect(alex.writableEnded).toBe(false);
    print = null;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(alex.events("gone")).toHaveLength(1);
    expect(rooms.size()).toBe(0);
  });
});
