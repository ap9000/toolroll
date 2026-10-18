// @vitest-environment happy-dom
/** The Agents board in the browser (agents-view.tsx): groups in order with each row's facts, a chip only where it
 * says more than its heading, one composer (Reply while the agent asks, else a steering note), and the opened
 * agent's room nudging the workspace to read again. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserAgentDetail, BrowserAgentRow, BrowserAgentsView } from "../browser-workspace.js";
import { WORKSPACE_NUDGE } from "./live-task.js";
import { AgentsView } from "./views/agents-view.js";

class Events extends EventTarget {
  static latest: Events | null = null;
  static CLOSED = 2;
  readyState = 1;
  close = vi.fn(() => { this.readyState = 2; });
  constructor(readonly url: string) { super(); Events.latest = this; }
  emit(name: string, data: unknown) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) })); }
}

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const row = (runId: number, extra: Partial<BrowserAgentRow>): BrowserAgentRow => ({
  runId, taskId: `t-${runId}`, title: `Task ${runId}`, project: "shop-web", href: `/agents?run=${runId}`, group: "working", label: "Working",
  line: "Edited files · 1 min ago", quiet: false, startedAt: ago(12), endedAt: null, diff: "3 files changed", agent: "Claude", ...extra,
});
const detail = (extra: Partial<BrowserAgentDetail> = {}): BrowserAgentDetail => ({
  ...row(7, { group: "needs-you", label: "Question", line: "Keep the old button?" }), live: true,
  question: { id: 3, key: "keep-button", text: "Keep the old button?", action: "/t/t-7/reply" },
  transcript: null, peek: null, files: [], filesMore: 0, steer: { action: "/t/t-7/steer", run: 7 }, canAct: true, taskHref: "/t/t-7", resultHref: null,
  room: "agent:7", said: null, ...extra,
});
const board = (selected: BrowserAgentDetail | null): BrowserAgentsView => ({ kind: "agents", empty: null, selected, groups: [
  { key: "needs-you", label: "Needs you", rows: [row(7, { group: "needs-you", label: "Question", line: "Keep the old button?" })] },
  { key: "working", label: "Working", rows: [row(8, {})] },
  { key: "done", label: "Done", rows: [row(9, { group: "done", label: "No changes", startedAt: ago(90), endedAt: ago(30), diff: null })] },
] });

let root: Root | null = null, host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("EventSource", Events);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => {
  // Async, so the live hub settles its room list (a microtask) before the next test.
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  Events.latest = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const render = (view: BrowserAgentsView) => act(() => { root = createRoot(host); root.render(createElement(AgentsView, { view })); });

describe("the Agents board", () => {
  test("groups in order, each row with its task, project, line, elapsed time and diff", () => {
    render(board(null));
    expect([...host.querySelectorAll("[data-agent-group-section]")].map(one => one.getAttribute("data-agent-group-section"))).toEqual(["needs-you", "working", "done"]);
    const working = host.querySelector('[data-agent-row="8"]')!;
    expect(working.textContent).toContain("Task 8");
    expect(working.textContent).toContain("shop-web · Claude · Running 12 min");
    expect(working.querySelector("[data-agent-diff]")?.textContent).toBe("3 files changed");
    // Said once: the Working heading needs no Working chip; a Question or No changes chip says more.
    expect(working.querySelector("[data-agent-state]")).toBeNull();
    expect(host.querySelector('[data-agent-row="7"] [data-agent-state]')?.textContent).toBe("Question");
    // A finished row labels how long it ran and when it finished; a diff nobody could measure shows nothing at all.
    expect(host.querySelector('[data-agent-row="9"] [data-agent-time]')?.textContent).toBe("Ran 1 h · finished 30 min ago");
    expect(host.querySelector('[data-agent-row="9"] [data-agent-diff]')).toBeNull();
    expect(host.querySelector('[data-agent-row="9"]')?.textContent).not.toContain("—");
    expect(host.querySelector("[data-agent-detail]")).toBeNull();
  });

  test("while the agent asks, the one composer is Reply for that question; otherwise it steers", () => {
    render(board(detail()));
    const reply = host.querySelector<HTMLFormElement>('[data-agent-composer="reply"]')!;
    expect(reply.getAttribute("action")).toBe("/t/t-7/reply");
    expect(reply.querySelector<HTMLInputElement>('input[name="question"]')?.value).toBe("3");
    expect(reply.querySelector("textarea")?.getAttribute("name")).toBe("answer");
    expect(host.querySelector('[data-agent-question="keep-button"]')?.textContent).toContain("Keep the old button?");
    expect(host.querySelector('[aria-current="page"]')?.closest("[data-agent-row]")?.getAttribute("data-agent-row")).toBe("7");
    act(() => root?.render(createElement(AgentsView, { view: board(detail({ question: null })) })));
    const steer = host.querySelector<HTMLFormElement>('[data-agent-composer="steer"]')!;
    expect(steer.getAttribute("action")).toBe("/t/t-7/steer");
    expect([...steer.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map(one => [one.name, one.value])).toEqual(expect.arrayContaining([["return", "agents"], ["run", "7"]]));
    // A finished agent has nothing left to steer.
    act(() => root?.render(createElement(AgentsView, { view: board(detail({ question: null, steer: null, live: false })) })));
    expect(host.querySelector("[data-agent-composer]")).toBeNull();
    // A viewer sees the question but gets no composer: replying and steering are an approver's acts.
    act(() => root?.render(createElement(AgentsView, { view: board(detail({ canAct: false })) })));
    expect(host.querySelector('[data-agent-question="keep-button"]')?.textContent).toContain("Keep the old button?");
    expect(host.querySelector("[data-agent-composer]")).toBeNull();
  });

  test("the opened agent's room nudges the workspace to read again", async () => {
    const nudged = vi.fn();
    window.addEventListener(WORKSPACE_NUDGE, nudged);
    await act(async () => { root = createRoot(host); root.render(createElement(AgentsView, { view: board(detail()) })); });
    expect(Events.latest?.url).toBe(`/live?room=${encodeURIComponent("agent:7")}`);
    await act(async () => { Events.latest!.emit("change", { room: "agent:7", at: "x" }); });
    expect(nudged).toHaveBeenCalledTimes(1);
    window.removeEventListener(WORKSPACE_NUDGE, nudged);
  });
});
