// @vitest-environment happy-dom
/** The live task page in the browser (live-task.tsx): a stream nudge reads the workspace again, a nudge for what the
 * page already shows does not, who else is here shows in the header, a stream that gives up leaves the workspace's own
 * beat, and the same last-activity line sits under the step, on Home Now and on Crew rows. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AssignmentCard } from "../assignment-ui.js";
import type { BrowserHome, BrowserTaskView, BrowserWorkspace } from "../browser-workspace.js";
import { CrewRows, useWorkspace } from "./app.js";
import { useLiveTask } from "./live-task.js";
import { Home } from "./views/home-view.js";
import { TaskView } from "./views/task-view.js";

class Events extends EventTarget {
  static latest: Events;
  static CLOSED = 2;
  readyState = 1;
  close = vi.fn(() => { this.readyState = 2; });
  constructor(readonly url: string) { super(); Events.latest = this; }
  emit(name: string, data: unknown) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) })); }
}

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const card: AssignmentCard = {
  token: "assignment-working", tone: "info", label: "Building",
  status: { headline: "Building", tone: "info", sentence: "Step 2 of 4: Add the guard", details: [], primaryAction: null, why: [] },
  action: null, reasons: [], diagnostics: [], notices: null, attempts: [], lead: null,
};
const taskView = (extra: Partial<BrowserTaskView> = {}): BrowserTaskView => ({
  kind: "task", id: "t-1", title: "Guard the payout path", project: null, scout: false, tabs: [], version: null,
  status: card, statusHtml: "", approval: "", lead: [], questions: "", facts: [], sections: [], manage: [], cancel: null, thread: [], ...extra,
});
const workspace = (view: BrowserTaskView, refreshSeconds?: number): BrowserWorkspace => ({
  version: 1, path: "/t/t-1", title: "Task", user: "alex", csrf: "csrf", sensitive: false, refreshUrl: "/t/t-1", receipt: null,
  projects: [], crew: [], crewTruncated: false, conversation: null, focus: null, result: null, catchUpHtml: "", controlsHtml: "",
  notices: [], pageHtml: null, navigation: [], view, ...(refreshSeconds === undefined ? {} : { refreshSeconds }),
});

let root: Root | null = null;
let host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", Events);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  if (root !== null) await act(async () => root!.unmount());
  root = null; document.body.innerHTML = "";
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("the task stream", () => {
  async function mount(initial: BrowserWorkspace) {
    let people: string[] = [];
    function Page() {
      const live = useWorkspace(initial);
      people = useLiveTask(live.workspace.view?.kind === "task" ? live.workspace.view.live : null);
      return null;
    }
    await act(async () => root!.render(createElement(Page)));
    return { people: () => people };
  }

  test("a change the page hasn't seen reads it again; one it has, or who's here, does not", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(workspace(taskView({ live: { href: "/t/t-1/live", at: "b" } }))), { headers: { etag: '"2"' } }));
    vi.stubGlobal("fetch", fetcher);
    const page = await mount(workspace(taskView({ live: { href: "/t/t-1/live", at: "a" } })));
    expect(Events.latest.url).toBe("/t/t-1/live");
    await act(async () => Events.latest.emit("change", { at: "a" }));
    await act(async () => Events.latest.emit("here", { people: ["robin"] }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(page.people()).toEqual(["robin"]);
    await act(async () => Events.latest.emit("change", { at: "b" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain("/t/t-1");
    // Without a beat of its own, the page waits for the next nudge rather than polling.
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("a stream that gives up clears who's here and leaves the workspace's own beat reading the page", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 304, headers: { etag: '"1"' } }));
    vi.stubGlobal("fetch", fetcher);
    const page = await mount(workspace(taskView({ live: { href: "/t/t-1/live", at: "a" } }), 10));
    await act(async () => Events.latest.emit("here", { people: ["robin", "sam"] }));
    expect(page.people()).toEqual(["robin", "sam"]);
    await act(async () => { Events.latest.readyState = Events.CLOSED; Events.latest.dispatchEvent(new Event("error")); });
    expect(page.people()).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("gone ends the stream; a page without a live address opens none", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    const page = await mount(workspace(taskView({ live: { href: "/t/t-1/live", at: "a" } })));
    const stream = Events.latest;
    await act(async () => stream.emit("here", { people: ["robin"] }));
    await act(async () => stream.dispatchEvent(new Event("gone")));
    expect(stream.close).toHaveBeenCalled();
    expect(page.people()).toEqual([]);
    await act(async () => root!.unmount());
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await mount(workspace(taskView()));
    expect(Events.latest).toBe(stream);
  });
});

describe("the last-activity line", () => {
  const text = () => [...host.querySelectorAll<HTMLElement>("[data-activity]")].map(one => `${one.dataset.activity}: ${one.textContent}`);

  test("sits under the step on the task page, counts on, and turns quiet after five minutes", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    await act(async () => root!.render(createElement(TaskView, { view: taskView({ activity: { what: "Ran a command", at: ago(40), worker: "online" } }), details: false })));
    expect(text()).toEqual(["fresh: Ran a command · 40 s ago"]);
    const step = host.querySelector("[data-task-status] p")!;
    expect(step.textContent).toContain("Step 2 of 4");
    expect(step.nextElementSibling?.hasAttribute("data-activity")).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(text()).toEqual(["quiet: No word for 5 min"]);
    await act(async () => root!.render(createElement(TaskView, { view: taskView({ activity: { what: "Ran a command", at: new Date(Date.now() - 40_000).toISOString(), worker: "offline" } }), details: false })));
    expect(text()).toEqual(["quiet: Worker offline · last word 40 s ago"]);
  });

  test("says who else is here in the task header, once", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    await act(async () => root!.render(createElement(TaskView, { view: taskView({ live: { href: "/t/t-1/live", at: "a" } }), details: false })));
    expect(host.querySelector("[data-also-viewing]")).toBeNull();
    await act(async () => Events.latest.emit("here", { people: ["Robin"] }));
    expect(host.querySelector("[data-also-viewing]")?.textContent).toBe("Robin is also here");
    await act(async () => Events.latest.emit("here", { people: ["Robin", "Sam", "Ana"] }));
    expect(host.querySelector("[data-also-viewing]")?.textContent).toBe("Robin and 2 others are also here");
  });

  test("Home Now and Crew rows show the same line for a running task, and nothing for others", async () => {
    const home: BrowserHome = { agents: [{ runId: 7, taskId: "t-1", title: "Guard the payout path", href: "/t/t-1", agent: "Claude on builder-1", phase: "Building",
      project: null, since: ago(600), activity: { what: "Edited files", at: ago(90), worker: "online" } }], counts: [], planUse: [], catchUp: [], allHref: "/work" };
    await act(async () => root!.render(createElement(Home, { home })));
    expect(text()).toEqual(["fresh: Edited files · 1 min ago"]);
    const base = { title: "Guard the payout path", project: null, state: "working" as const, label: "Building", tone: "info" as const,
      href: "/chat?task=t-1", resultHref: null, action: null, updatedAt: ago(60) };
    await act(async () => root!.render(createElement(CrewRows, { workspace: workspace(taskView()), items: [
      { ...base, id: "t-1", activity: { what: "Searched the code", at: ago(400), worker: "online" } },
      { ...base, id: "t-2", state: "ready-to-check" as const, label: "Ready for review", tone: "success" as const },
    ] })));
    expect(text()).toEqual(["quiet: No word for 6 min"]);
    expect(host.querySelector('[data-workspace-task="t-1"] [data-activity]')).not.toBeNull();
  });
});
