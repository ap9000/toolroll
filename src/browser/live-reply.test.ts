// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserConversation } from "../browser-workspace.js";
import { LiveReplyBubble, useLiveReply } from "./live-reply.js";

class Events extends EventTarget {
  static latest: Events;
  static CLOSED = 2;
  readyState = 1;
  close = vi.fn(() => { this.readyState = 2; });
  constructor(readonly url: string) { super(); Events.latest = this; }
}
const chat = { sessionId: 1, taskId: null, project: null } as BrowserConversation;
const done = vi.fn();
function WatchedReply() {
  return createElement(LiveReplyBubble, { live: useLiveReply(chat, true, done), leadName: "Lead" });
}
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", Events);
  done.mockClear();
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(createElement(WatchedReply)));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const emit = async (steps: unknown[], ended = false) => act(async () => {
  Events.latest.dispatchEvent(new MessageEvent("turn", { data: JSON.stringify({ room: "chat", steps, done: ended, ok: ended }) }));
});
const step = (calls: unknown[], text = "") => ({ tools: calls.map(() => "Reading the flows"), toolCalls: calls, text });
const call = (id: string, state: string, reason?: string) => ({ id, label: "Reading the flows", state, ...(reason === undefined ? {} : { reason }) });
const rows = () => [...document.querySelectorAll<HTMLLIElement>(".so-live-steps li")];

test("a step followed by another tool and text stays running until its own success is reported", async () => {
  await emit([step([call("one", "running"), call("two", "succeeded")]), { tools: [], text: "I am still checking." }]);
  expect(rows().map(row => row.dataset.state)).toEqual(["running", "succeeded"]);
  expect(rows()[0]!.textContent).toContain("Running");
  expect(rows()[0]!.dataset.done).toBe("false");
  await emit([step([call("one", "succeeded"), call("two", "succeeded")])]);
  expect(rows().map(row => row.dataset.done)).toEqual(["true", "true"]);
  expect(rows()[0]!.textContent).toContain("Done");
});

test("a failed call keeps its reason when a same-label retry succeeds and the turn ends", async () => {
  const reason = "No such flow in your projects. <script>unsafe()</script>";
  const steps = [step([call("one", "failed", reason), call("two", "succeeded")], "I checked the list.")];
  await emit(steps, true);
  expect(rows().map(row => row.dataset.state)).toEqual(["failed", "succeeded"]);
  expect(rows()[0]!.textContent).toContain("Failed");
  expect(rows()[0]!.querySelector(".so-tool-reason")!.textContent).toBe(reason);
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector(".so-working, .so-live-caret")).toBeNull();
  expect(done).toHaveBeenCalledOnce();
  // The page's stream stays open for its other rooms (and the conversation's next reply).
  expect(Events.latest.url).toBe("/live?room=chat");
  expect(Events.latest.close).not.toHaveBeenCalled();
});

test("old snapshots and invalid outcomes never imply success from text, position or turn success", async () => {
  await emit([
    { tools: ["Reading the task", "Reading the result"], text: "Here is what I found." },
    step([call("missing-reason", "failed"), call("unsupported", "done"), { ...call("mismatch", "succeeded"), label: "Wrong label" }]),
  ], true);
  expect(rows()).toHaveLength(5);
  expect(rows().every(row => row.dataset.state === "unknown" && row.dataset.done === "false")).toBe(true);
  expect(rows().every(row => row.textContent!.includes("Outcome not reported"))).toBe(true);
});

test.each(["ended", "disconnected"])("an unresolved call becomes unknown when the stream is %s", async how => {
  const steps = [step([call("pending", "running"), call("done", "succeeded")])];
  await emit(steps);
  if (how === "ended") await emit(steps, true);
  else await act(async () => { Events.latest.readyState = Events.CLOSED; Events.latest.dispatchEvent(new Event("error")); });
  expect(rows().map(row => row.dataset.state)).toEqual(["unknown", "succeeded"]);
  expect(document.querySelector(".so-working")).toBeNull();
});

test("empty progress has no tool status", async () => {
  await emit([{ tools: [], toolCalls: [], text: "" }]);
  expect(rows()).toHaveLength(0);
  expect(document.body.textContent).toContain("Thinking…");
});

test("running, done and failed steps render together with the full long reason", async () => {
  const reason = "The saved changes could not be verified. The result is still available for you to inspect, but this step could not read its saved changes. Open the result to see which files and checks were saved before deciding what to do next.";
  await emit([
    step([call("pending", "running"), call("finished", "succeeded"), call("failed", "failed", reason)]),
    { tools: [], text: "I am still checking the remaining work." },
  ]);
  expect(document.querySelector("ul[aria-label='Tool steps']")).not.toBeNull();
  expect(rows().map(row => row.dataset.state)).toEqual(["running", "succeeded", "failed"]);
  expect(rows().map(row => row.dataset.done)).toEqual(["false", "true", "false"]);
  expect(rows().map(row => row.querySelector(".so-tool-status")!.textContent)).toEqual([" · Running", " · Done", " · Failed"]);
  expect(document.querySelectorAll(".so-tool-reason")).toHaveLength(1);
  expect(rows()[2]!.querySelector(".so-tool-reason")!.textContent).toBe(reason);
  expect(document.querySelector(".so-live-text")!.textContent).toBe("I am still checking the remaining work.");
});
