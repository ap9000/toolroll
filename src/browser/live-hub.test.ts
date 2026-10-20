// @vitest-environment happy-dom
/** The page's one live stream (browser/live.ts). A room the server refused (`gone`) has already left the open stream:
 * a page that drops just those rooms keeps it, and a stream that `ended` closes and listens again 30 s later — so a
 * sign-out never reconnects at once into a request that can't sign in. */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LiveHub } from "./live.js";

class FakeStream {
  static CLOSED = 2;
  static opened: FakeStream[] = [];
  readyState = 1; closed = false;
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  constructor(readonly url: string) { FakeStream.opened.push(this); }
  addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  close() { this.closed = true; this.readyState = 2; }
  emit(name: string, data: Record<string, unknown> = {}) { for (const one of this.listeners.get(name) ?? []) one({ data: JSON.stringify(data) }); }
}
const flush = () => new Promise<void>(done => queueMicrotask(done));

beforeEach(() => { vi.useFakeTimers(); FakeStream.opened = []; (globalThis as unknown as { EventSource: unknown }).EventSource = FakeStream; });
afterEach(() => { vi.useRealTimers(); });

test("dropping a room the server refused keeps the open stream; `ended` closes it and it listens again 30 s later", async () => {
  const hub = new LiveHub();
  const leaveSummary = hub.subscribe("summary", () => {}, true);
  hub.subscribe("workspace", () => {});
  await flush();
  expect(FakeStream.opened.map(one => one.url)).toEqual(["/live?room=summary&room=workspace"]);
  const stream = FakeStream.opened[0]!;
  // Signed out: the summary room hears `gone`, and the page drops it at once.
  stream.emit("gone", { room: "summary" });
  leaveSummary();
  await flush();
  expect(FakeStream.opened).toHaveLength(1);
  expect(stream.closed).toBe(false);
  // Then the workspace room goes and the stream ends: nothing reconnects until the retry.
  stream.emit("gone", { room: "workspace" });
  stream.emit("ended");
  expect(stream.closed).toBe(true);
  vi.advanceTimersByTime(29_000);
  expect(FakeStream.opened).toHaveLength(1);
  vi.advanceTimersByTime(1_000);
  expect(FakeStream.opened.map(one => one.url)).toEqual(["/live?room=summary&room=workspace", "/live?room=workspace"]);
});

test("dropping a room the server still holds reopens the stream without it, as before", async () => {
  const hub = new LiveHub();
  hub.subscribe("summary", () => {}, true);
  const leaveTask = hub.subscribe("task:7", () => {});
  await flush();
  leaveTask();
  await flush();
  expect(FakeStream.opened.map(one => one.url)).toEqual(["/live?room=summary&room=task%3A7", "/live?room=summary"]);
  expect(FakeStream.opened[0]!.closed).toBe(true);
});

test("a page that learns it is signed out stops its stream, and dropping its rooms opens none", async () => {
  const hub = new LiveHub();
  const leaveSummary = hub.subscribe("summary", () => {}, true);
  const leaveChat = hub.subscribe("chat", () => {});
  await flush();
  hub.stop();
  expect(FakeStream.opened[0]!.closed).toBe(true);
  leaveSummary();
  await flush();
  leaveChat();
  await flush();
  hub.subscribe("workspace", () => {});
  await flush();
  vi.advanceTimersByTime(60_000);
  expect(FakeStream.opened).toHaveLength(1);
});

test("a room refused while others are still wanted waits for the stream's verdict: `ended` means no reopen until the retry", async () => {
  const hub = new LiveHub();
  const leaveSummary = hub.subscribe("summary", () => {}, true);
  hub.subscribe("workspace", () => {});
  hub.subscribe("chat", () => {});
  await flush();
  const stream = FakeStream.opened[0]!;
  // The workspace room is refused but its part stays; the summary's part leaves: the room set changed.
  stream.emit("gone", { room: "workspace" });
  stream.emit("gone", { room: "summary" });
  leaveSummary();
  await flush();
  expect(FakeStream.opened).toHaveLength(1);
  stream.emit("gone", { room: "chat" });
  stream.emit("ended");
  vi.advanceTimersByTime(29_000);
  expect(FakeStream.opened).toHaveLength(1);
  vi.advanceTimersByTime(1_000);
  expect(FakeStream.opened.map(one => one.url)).toEqual(["/live?room=chat&room=summary&room=workspace", "/live?room=chat&room=workspace"]);
});

test("a room narrowed while the stream stays open reopens, after the wait, with the rooms still wanted", async () => {
  const hub = new LiveHub();
  hub.subscribe("summary", () => {}, true);
  const leaveTask = hub.subscribe("task:7", () => {});
  await flush();
  const stream = FakeStream.opened[0]!;
  stream.emit("gone", { room: "task:7" });
  hub.subscribe("task:8", () => {});
  leaveTask();
  await flush();
  expect(FakeStream.opened).toHaveLength(1);
  vi.advanceTimersByTime(2_000);
  expect(stream.closed).toBe(true);
  expect(FakeStream.opened.map(one => one.url)).toEqual(["/live?room=summary&room=task%3A7", "/live?room=summary&room=task%3A8"]);
});

test("after `ended`, a room the page drops or adds opens nothing until the retry (a sign-out's parts react before the page leaves)", async () => {
  const hub = new LiveHub();
  const leaveSummary = hub.subscribe("summary", () => {}, true);
  hub.subscribe("chat", () => {});
  await flush();
  const stream = FakeStream.opened[0]!;
  // The whole burst arrives before the page's parts react to it.
  stream.emit("gone", { room: "chat" });
  stream.emit("gone", { room: "summary" });
  stream.emit("ended");
  leaveSummary();
  await flush();
  hub.subscribe("task:9", () => {});
  await flush();
  vi.advanceTimersByTime(29_000);
  expect(FakeStream.opened).toHaveLength(1);
  vi.advanceTimersByTime(1_000);
  expect(FakeStream.opened.map(one => one.url)).toEqual(["/live?room=chat&room=summary", "/live?room=chat&room=task%3A9"]);
});

test("back online, a stream the browser gave up on reconnects at once", async () => {
  const hub = new LiveHub();
  hub.subscribe("chat", () => {});
  await flush();
  const stream = FakeStream.opened[0]!;
  stream.readyState = FakeStream.CLOSED;
  stream.emit("error");
  await flush();
  expect(FakeStream.opened).toHaveLength(1);
  window.dispatchEvent(new Event("online"));
  expect(FakeStream.opened).toHaveLength(2);
});
