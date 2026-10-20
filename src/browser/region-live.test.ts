// @vitest-environment happy-dom
/** A server-rendered region on a workspace page follows the page's one live stream (cockpit §2): it asks that stream for
 * the workspace room and opens none of its own; on a page with no workspace it keeps its own stream. It hears only its
 * room's events, never the summary room's. */
import { afterEach, expect, test } from "vitest";
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
