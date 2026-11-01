// @vitest-environment happy-dom
/** A server-rendered region on a workspace page follows the page's one live stream (cockpit §2): it asks that stream for
 * the workspace room and opens none of its own; on a page with no workspace it keeps its own stream. It hears only its
 * room's events, never the summary room's. */
import { afterEach, expect, test, vi } from "vitest";
import { regionScript } from "../server/chrome.js";

const opened: string[] = [];
class CountingStream { readyState = 1; constructor(url: string) { opened.push(url); } addEventListener() {} close() {} }
afterEach(() => { document.body.innerHTML = ""; opened.length = 0; delete (window as unknown as { __soLiveRooms?: unknown }).__soLiveRooms; });

const run = (script: string) => new Function(script)();

test("on a workspace page the region asks the page's stream for its room and opens none", () => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = CountingStream;
  document.body.innerHTML = `<div id="standing-orders-workspace"><div id="board-region"></div></div>`;
  run(regionScript("board-region", "board"));
  expect(opened).toEqual([]);
  expect((window as unknown as { __soLiveRooms: unknown }).__soLiveRooms).toEqual(["workspace"]);
});

test("on a page with no workspace it keeps its own stream", () => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = CountingStream;
  document.body.innerHTML = `<div id="board-region"></div>`;
  run(regionScript("board-region", "board"));
  expect(opened).toEqual(["/live?room=workspace"]);
});

test("a stream that ended because it was refused closes, and listens again 30 s later instead of at once", () => {
  vi.useFakeTimers();
  try {
    const streams: Array<{ listeners: Map<string, () => void>; closed: boolean }> = [];
    class EndingStream {
      listeners = new Map<string, () => void>(); closed = false; readyState = 1;
      constructor(url: string) { opened.push(url); streams.push(this); }
      addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
      close() { this.closed = true; }
    }
    (globalThis as unknown as { EventSource: unknown }).EventSource = EndingStream;
    document.body.innerHTML = `<div id="board-region"></div>`;
    run(regionScript("board-region", "board"));
    streams[0]!.listeners.get("ended")!();
    expect(streams[0]!.closed).toBe(true);
    vi.advanceTimersByTime(29_000);
    expect(opened).toEqual(["/live?room=workspace"]);
    vi.advanceTimersByTime(1_000);
    expect(opened).toEqual(["/live?room=workspace", "/live?room=workspace"]);
  } finally { vi.useRealTimers(); }
});

test("a retry the server refuses (an error the browser gives up on) is tried again 30 s later too", () => {
  vi.useFakeTimers();
  try {
    const streams: Array<{ listeners: Map<string, () => void>; closed: boolean; readyState: number }> = [];
    class RefusedStream {
      listeners = new Map<string, () => void>(); closed = false; readyState = 1;
      constructor(url: string) { opened.push(url); streams.push(this); }
      addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
      close() { this.closed = true; this.readyState = 2; }
    }
    (globalThis as unknown as { EventSource: unknown }).EventSource = RefusedStream;
    document.body.innerHTML = `<div id="board-region"></div>`;
    run(regionScript("board-region", "board"));
    streams[0]!.listeners.get("ended")!();
    vi.advanceTimersByTime(30_000);
    // Still signed out: the browser closes the retry with an error.
    streams[1]!.readyState = 2;
    streams[1]!.listeners.get("error")!();
    vi.advanceTimersByTime(30_000);
    expect(opened).toHaveLength(3);
    // A passing error while the browser reconnects by itself is left to it.
    streams[2]!.listeners.get("error")!();
    vi.advanceTimersByTime(60_000);
    expect(opened).toHaveLength(3);
  } finally { vi.useRealTimers(); }
});
