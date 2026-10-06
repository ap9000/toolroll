// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserConversation } from "../browser-workspace.js";
import { LiveReplyBubble, useLiveReply } from "./live-reply.js";

class Events extends EventTarget {
  static latest: Events;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(_url: string) { super(); Events.latest = this; }
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
  Events.latest.dispatchEvent(new MessageEvent("turn", { data: JSON.stringify({ steps, done: ended, ok: ended }) }));
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
  expect(Events.latest.close).toHaveBeenCalled();
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
  else await act(async () => Events.latest.onerror?.());
  expect(rows().map(row => row.dataset.state)).toEqual(["unknown", "succeeded"]);
  expect(document.querySelector(".so-working")).toBeNull();
});

test("empty progress has no tool status", async () => {
  await emit([{ tools: [], toolCalls: [], text: "" }]);
  expect(rows()).toHaveLength(0);
  expect(document.body.textContent).toContain("Thinking…");
});
