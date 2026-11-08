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
const emit = async (steps: unknown[], ended = false, extra: Record<string, unknown> = {}) => act(async () => {
  Events.latest.dispatchEvent(new MessageEvent("turn", { data: JSON.stringify({ room: "chat", steps, done: ended, ok: ended, ...extra }) }));
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

// Before the disconnect cases: a stream the hub gave up on stays given up for the rest of this file.
test("a lost connection dims what was written and asks for the saved state", async () => {
  await emit([step([call("pending", "running"), call("done", "succeeded")])], false, { status: "Writing…", text: "Partway there" });
  await act(async () => { Events.latest.readyState = Events.CLOSED; Events.latest.dispatchEvent(new Event("error")); });
  // An unresolved call becomes unknown; the line says so and reloads, never reading as working or finished.
  expect(rows().map(row => row.dataset.state)).toEqual(["unknown", "succeeded"]);
  expect(document.querySelector("[data-live-status]")!.textContent).toBe("Connection lost — reloading");
  expect(document.querySelector("[data-live-reply]")!.hasAttribute("data-live-lost")).toBe(true);
  expect(document.querySelector("[data-live-text]")!.textContent).toBe("Partway there");
  expect(done).toHaveBeenCalledOnce();
});

test.each(["ended"])("an unresolved call becomes unknown when the stream is %s", async how => {
  const steps = [step([call("pending", "running"), call("done", "succeeded")])];
  await emit(steps);
  if (how === "ended") await emit(steps, true);
  else await act(async () => { Events.latest.readyState = Events.CLOSED; Events.latest.dispatchEvent(new Event("error")); });
  expect(rows().map(row => row.dataset.state)).toEqual(["unknown", "succeeded"]);
  // A lost stream says so and reloads; it never reads as still working or as finished.
  expect(document.querySelector("[data-live-status]")?.textContent ?? null).toBe(how === "ended" ? null : "Connection lost — reloading");
});

test("running, done and failed steps render together with the full long reason", async () => {
  const reason = "The saved changes could not be verified. The result is still available for you to inspect, but this step could not read its saved changes. Open the result to see which files and checks were saved before deciding what to do next.";
  await emit([
    step([call("pending", "running"), call("finished", "succeeded"), call("failed", "failed", reason)]),
    { tools: [] },
  ], false, { status: "Writing…", text: "I am still checking the remaining work." });
  expect(document.querySelector("ul[aria-label='Tool steps']")).not.toBeNull();
  expect(rows().map(row => row.dataset.state)).toEqual(["running", "succeeded", "failed"]);
  expect(rows().map(row => row.dataset.done)).toEqual(["false", "true", "false"]);
  expect(rows().map(row => row.querySelector(".so-tool-status")!.textContent)).toEqual([" · Running", " · Done", " · Failed"]);
  expect(document.querySelectorAll(".so-tool-reason")).toHaveLength(1);
  expect(rows()[2]!.querySelector(".so-tool-reason")!.textContent).toBe(reason);
  expect(document.querySelector(".so-live-text")!.textContent).toBe("I am still checking the remaining work.");
});

test("one status line, the steps behind a closed disclosure, and shaped partial text drawn as React text", async () => {
  await emit([step([call("one", "running")])], false, { status: "Reading the flows…", text: "" });
  expect(document.querySelectorAll("[data-live-status]")).toHaveLength(1);
  expect(document.querySelector("[data-live-status]")!.textContent).toBe("Reading the flows…");
  const steps = document.querySelector<HTMLDetailsElement>("details.k-disclose")!;
  expect(steps.open).toBe(false);
  expect(steps.querySelector("summary")!.textContent).toBe("Steps (1)");
  await emit([step([call("one", "succeeded")])], false, { status: "Writing…", text: "Two are **ready**, see [example.com](https://example.com/x) and <b>this</b>" });
  const text = document.querySelector("[data-live-text]")!;
  expect(text.querySelector("strong")!.textContent).toBe("ready");
  expect(text.querySelector("a")!.getAttribute("href")).toBe("https://example.com/x");
  expect(text.querySelector("b")).toBeNull();
  expect(text.textContent).toContain("<b>this</b>");
  expect(document.querySelector(".so-live-caret")).not.toBeNull();
});

test("a reply that ends failed drops its partial text at once; one that answered keeps it until the saved message", async () => {
  await emit([step([])], false, { status: "Writing…", text: "Half of an answer" });
  await emit([step([])], true, { ok: false, text: "" });
  expect(document.querySelector("[data-live-text]")).toBeNull();
  expect(done).toHaveBeenCalledOnce();
  await act(async () => root.render(createElement(WatchedReply, { key: "again" })));
  await emit([step([])], false, { status: "Writing…", text: "The whole answer" });
  await emit([step([])], true, { ok: true, text: "" });
  expect(document.querySelector("[data-live-text]")!.textContent).toBe("The whole answer");
});
