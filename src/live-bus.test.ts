/** Live views push on write (live-bus.ts): a committed write reaches every open task and flow page at once as one
 * opaque change; a rolled-back or quiet write says nothing; an idle open page does no database work; a slow page gets
 * one reload and closes; and the 30 s safety net heals a signal that never came. */
import { EventEmitter, once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flowTaskFixture } from "../test/flow-card-task.js";
import { createFlowRooms, flowFingerprint } from "./flow-live.js";
import { createLiveBus, followWorkspace, LiveStream, STREAM_LIMIT_BYTES, type LiveBus, type WorkspaceFollower } from "./live-bus.js";
import { heartbeat } from "./runner.js";
import { openStore, type Store } from "./store.js";
import { createTaskRooms, taskFingerprint } from "./task-live.js";
import { prepareWorkspaceRevision } from "./workspace-revision.js";

const now = new Date("2026-10-07T17:00:00Z");
let store: Store, fixture: ReturnType<typeof flowTaskFixture>, bus: LiveBus, follower: WorkspaceFollower, heard: string[];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  store = openStore(":memory:");
  fixture = flowTaskFixture(store, now);
  const revision = prepareWorkspaceRevision(store);
  bus = createLiveBus();
  follower = followWorkspace(store, () => revision.current(), bus);
  heard = [];
  bus.subscribe(change => heard.push(change.revision));
});
afterEach(() => { follower.close(); store.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

/** A page's open stream, as the room sees it. `writableLength` is what it holds unsent. */
class Page extends EventEmitter {
  sent: string[] = [];
  writableEnded = false;
  destroyed = false;
  writableLength = 0;
  write(chunk: string) { this.sent.push(chunk); return true; }
  end(chunk?: string) { if (chunk !== undefined) this.sent.push(chunk); this.writableEnded = true; this.emit("close"); }
  events(name: string): unknown[] {
    return this.sent.filter(one => one.startsWith(`event: ${name}\n`)).map(one => JSON.parse(one.split("\ndata: ")[1]!.trim()));
  }
}
const response = (page: Page) => page as unknown as ServerResponse;

describe("the bus", () => {
  test("publishes once after the outer commit, never for a rollback, and also for a write outside a transaction", () => {
    store.transact(() => {
      store.recordRunActivity(fixture.run, "command", now);
      store.transact(() => store.recordRunActivity(fixture.run, "edit", now));
      // Nothing is said before COMMIT.
      vi.advanceTimersByTime(1);
      expect(heard).toEqual([]);
    });
    vi.advanceTimersByTime(20);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/^v1:\d+$/);

    expect(() => store.transact(() => { store.recordRunActivity(fixture.run, "command", now); throw new Error("no"); })).toThrow("no");
    vi.advanceTimersByTime(1);
    expect(heard).toHaveLength(1);

    // An autocommit statement in this process (no transact) still reaches the bus.
    store.handle.prepare("UPDATE flow_card SET waiting = 'Moved' WHERE id = ?").run(fixture.card);
    vi.advanceTimersByTime(1);
    expect(heard).toHaveLength(2);
    expect(heard[1]).not.toBe(heard[0]);
  });

  test("a quiet write (a routine worker heartbeat) says nothing", () => {
    vi.advanceTimersByTime(1);
    const before = heard.length;
    expect(heartbeat(store, "builder", "fixture-runner", new Date(now.getTime() + 1_000)).ok).toBe(true);
    vi.advanceTimersByTime(1);
    expect(heard).toHaveLength(before);
  });

  test("another process's write is heard through the database's write-ahead log", () => {
    let wal: (() => void) | null = null;
    const revision = prepareWorkspaceRevision(store);
    const other = createLiveBus(), got: string[] = [];
    other.subscribe(change => got.push(change.revision));
    const watched = followWorkspace(store, () => revision.current(), other, { file: "/db/orders.db",
      watchFile: (path, listener) => { expect(path).toBe("/db/orders.db-wal"); wal = listener; return null; } });
    try {
      // Stand-in for the worker's commit: a raw write with this process's signal switched off.
      store.handle.exec("DROP TRIGGER temp.toolroll_live_written_update");
      store.handle.prepare("UPDATE flow_card SET waiting = 'From the worker' WHERE id = ?").run(fixture.card);
      vi.advanceTimersByTime(1);
      expect(got).toEqual([]);
      wal!();
      vi.advanceTimersByTime(1);
      expect(got).toHaveLength(1);
    } finally { watched.close(); }
  });
});

describe("rooms on the bus", () => {
  test("task and flow pages hear one change per write that touches them, without data, within the same turn", () => {
    const tasks = createTaskRooms(root => taskFingerprint(store, root, new Date()), { bus });
    const flows = createFlowRooms(flow => flowFingerprint(store, flow), { bus });
    const taskPage = new Page(), flowPage = new Page();
    try {
      tasks.join(fixture.id, { name: "alex", response: response(taskPage), valid: () => true });
      flows.join(fixture.flow, { name: "alex", card: null, editing: false, response: response(flowPage), valid: () => true });
      // Each kind of write the pages show: activity, progress, a question, a card moving, a comment.
      // What the agent did last shows on the task page only; progress shows on both.
      const writes: [string, () => void, boolean, boolean][] = [
        ["activity", () => store.recordRunActivity(fixture.run, "command", new Date()), true, false],
        ["progress", () => fixture.checkpoint(["completed", "current"]), true, true],
        ["card moved", () => store.handle.prepare("UPDATE flow_card SET stage = 'review', updated_at = ? WHERE id = ?").run(new Date(Date.now() + 1).toISOString(), fixture.card), false, true],
        ["comment", () => store.addFlowComment({ card: fixture.card, author: "alex", body: "Looks right", mentions: [] }, new Date()), false, true],
      ];
      for (const [what, write, task, flow] of writes) {
        const before = [taskPage.events("change").length, flowPage.events("change").length];
        vi.advanceTimersByTime(5);
        write();
        vi.advanceTimersByTime(1);
        expect(flowPage.events("change").length, `flow: ${what}`).toBe(before[1]! + (flow ? 1 : 0));
        expect(taskPage.events("change").length, `task: ${what}`).toBe(before[0]! + (task ? 1 : 0));
      }
      for (const page of [taskPage, flowPage]) for (const one of page.events("change").slice(1)) expect(Object.keys(one as object)).toEqual(["at", "revision"]);
    } finally { tasks.close(); flows.close(); }
  });

  test("an open page with nothing written does no database work for ten seconds", () => {
    let fingerprints = 0;
    const tasks = createTaskRooms(root => { fingerprints += 1; return taskFingerprint(store, root, new Date()); }, { bus });
    const flows = createFlowRooms(flow => { fingerprints += 1; return flowFingerprint(store, flow); }, { bus });
    const pages = [new Page(), new Page()];
    try {
      tasks.join(fixture.id, { name: "alex", response: response(pages[0]!), valid: () => { fingerprints += 1; return true; } });
      flows.join(fixture.flow, { name: "alex", card: null, editing: false, response: response(pages[1]!), valid: () => { fingerprints += 1; return true; } });
      vi.advanceTimersByTime(1_000);
      const prepare = vi.spyOn(store.handle, "prepare");
      const exec = vi.spyOn(store.handle, "exec");
      fingerprints = 0;
      vi.advanceTimersByTime(10_000);
      expect(prepare).toHaveBeenCalledTimes(0);
      expect(exec).toHaveBeenCalledTimes(0);
      expect(fingerprints).toBe(0);
      expect(heard).toEqual([]);
    } finally { tasks.close(); flows.close(); }
  });

  test("the 30 s safety net heals a change whose signal never came", () => {
    let print = "a";
    const rooms = createTaskRooms(() => print, { bus: createLiveBus() });
    const page = new Page();
    rooms.join("t-1", { name: "alex", response: response(page), valid: () => true });
    print = "b"; // written, but the signal was dropped
    vi.advanceTimersByTime(29_000);
    expect(page.events("change")).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(page.events("change").at(-1)).toEqual({ at: "b", revision: null });
    // Between checks the page hears keep-alives, not changes.
    expect(page.sent.filter(one => one === ": keep-alive\n\n")).toHaveLength(1);
    rooms.close();
  });

  test("a paused real socket ends below Node's drain threshold, leaves the room, and never blocks a fast peer", async () => {
    vi.useRealTimers();
    let print = "a";
    const limit = STREAM_LIMIT_BYTES;
    const rooms = createTaskRooms(() => print, { bus, limitBytes: limit });
    const responses = new Map<string, ServerResponse>();
    const server = createServer((request, reply) => {
      reply.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      reply.flushHeaders();
      const name = request.url!.slice(1);
      responses.set(name, reply);
      rooms.join("t-1", { name, response: reply, valid: () => true });
    });
    // Keep the slow reader paused, with almost no user-space receive buffer.
    const slow = new Socket({ readableHighWaterMark: 1 });
    const quick = new Socket();
    let quickText = "";
    quick.on("data", chunk => { quickText = (quickText + chunk.toString()).slice(-65_536); });
    const quickSaw = async (text: string) => {
      while (!quickText.includes(text)) await once(quick, "data");
    };
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no loopback address");
      slow.connect(address.port, "127.0.0.1");
      await once(slow, "connect");
      slow.write("GET /alex HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await once(slow, "readable");
      slow.pause();
      expect(slow.isPaused()).toBe(true);
      quick.connect(address.port, "127.0.0.1");
      await once(quick, "connect");
      quick.write("GET /robin HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await quickSaw('"people":["alex"]');

      const reply = responses.get("alex")!;
      expect(limit).toBeLessThan(reply.writableHighWaterMark);
      const writes = vi.spyOn(reply, "write"), ends = vi.spyOn(reply, "end");
      // Each update fits the application cap. Wait for the fast socket's
      // receipt before the next, so only the paused reader builds a backlog.
      // Bound generated traffic to 16 MiB; no sleeps or synthetic drain.
      for (let index = 0; index < 8_192 && !reply.writableEnded; index += 1) {
        print = `${index}:${"x".repeat(2_000)}`;
        bus.publish({ revision: `v1:${index}` });
        await quickSaw(`"at":"${print}"`);
      }
      expect(reply.writableEnded).toBe(true);
      expect(reply.writableLength).toBeLessThan(reply.writableHighWaterMark);
      expect(writes.mock.results.length).toBeGreaterThan(1);
      expect(writes.mock.results.every(result => result.value === true)).toBe(true);
      expect(reply.listenerCount("drain")).toBe(0);
      expect(ends).toHaveBeenCalledExactlyOnceWith("event: reload\ndata: {}\n\n");
      expect(rooms.size()).toBe(1); // leave before the slow reader resumes
      const sent = writes.mock.calls.length;
      print = "after-overflow";
      bus.publish({ revision: "v1:after" });
      await quickSaw('"at":"after-overflow"');
      await quickSaw('"people":[]');
      expect(writes).toHaveBeenCalledTimes(sent);
      expect(ends).toHaveBeenCalledTimes(1);

      // Resume only after proving the stream ended without a drain. The
      // response's terminal frame and EOF arrive through the actual socket.
      let slowText = "";
      slow.on("data", chunk => { slowText += chunk.toString(); });
      const closed = once(slow, "end");
      slow.resume();
      await closed;
      expect(slowText.match(/event: reload\n/g)).toHaveLength(1);
      expect(slowText).not.toContain("after-overflow");
      rooms.close();
      expect(rooms.size()).toBe(0);
      expect(bus.listeners()).toBe(1); // only the fixture's observer remains
    } finally {
      slow.destroy(); quick.destroy(); rooms.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe("the bounded write path", () => {
  test.each(["event", "keep-alive"] as const)("%s checks the cap both before and after writing, and ends only once", kind => {
    for (const alreadyOver of [false, true]) {
      const page = new Page(), closed = vi.fn();
      const stream = new LiveStream(response(page), 32, closed);
      page.writableLength = alreadyOver ? 33 : 32;
      const write = vi.spyOn(page, "write").mockImplementation(chunk => {
        page.sent.push(chunk); page.writableLength += Buffer.byteLength(chunk); return true;
      });
      if (kind === "event") stream.send("change", {}); else stream.keepAlive();
      expect(write).toHaveBeenCalledTimes(alreadyOver ? 0 : 1);
      expect(page.events("reload")).toEqual([{}]);
      expect(stream.open).toBe(false);
      expect(page.writableEnded).toBe(true);
      stream.send("change", {}); stream.keepAlive();
      expect(write).toHaveBeenCalledTimes(alreadyOver ? 0 : 1);
      expect(page.events("reload")).toEqual([{}]);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(page.listenerCount("drain")).toBe(0);
    }
  });

  test("overflow during the first frame releases the new room and its subscription", () => {
    const rooms = createTaskRooms(() => "a", { bus, limitBytes: 1 });
    const page = new Page();
    page.writableLength = 2;
    rooms.join("t-1", { name: "alex", response: response(page), valid: () => true });
    expect(page.events("reload")).toEqual([{}]);
    expect(rooms.size()).toBe(0);
    expect(bus.listeners()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(page.sent).toHaveLength(1);
  });
});
