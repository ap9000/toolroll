// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserFlowView } from "../browser-workspace.js";
import { flowFromSteps } from "../flows.js";
import { FlowView } from "./views/flow-view.js";

const definition = flowFromSteps([{ id: "build", title: "Build", kind: "task", instructions: "Fix checkout rounding" }, { id: "review", title: "Review", kind: "approval" }], null);
const view = (waiting: string, live: string): BrowserFlowView => ({
  kind: "flow", flow: { id: 1, name: "Checkout", project: "Shop", revision: 1, href: "/flows/1", owner: "alex" },
  chatHref: "/chat", triggers: [], triggerSetup: { kinds: [], githubRepo: null, linearKey: false, hooksBase: null, hooksPath: "/hooks", mailbox: null, otherFlows: [] },
  startTrigger: null, me: "alex", sortReady: false, emailReady: false, requestSecrets: [], tools: [], scripts: [],
  start: definition.start, stages: definition.stages, selectedCard: null, live, canEdit: false, approvers: [], kinds: [], colors: [],
  cards: [{ id: 1, title: "Fix checkout rounding", description: null, stage: "build", state: "active", waiting,
    task: { id: "checkout", href: "/t/checkout" }, createdBy: "alex", updatedAt: "2026-10-07T17:00:00Z", canDecide: false,
    outputs: [], history: [], source: null, owner: null, watchers: [], watching: false, mine: false, comments: [], sorted: null, draft: null }],
});

let root: Root | null = null;
let streams: FakeStream[] = [];
class FakeStream extends EventTarget {
  static CLOSED = 2;
  readyState = 1;
  constructor(_url: string) { super(); streams.push(this); }
  close() { this.readyState = 2; }
}
beforeEach(() => {
  document.body.innerHTML = ""; streams = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeStream);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each([false, true])("live task states replace the card line and keep its task reachable (phone=%s)", async phone => {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: phone && query === "(max-width: 767px)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const initial = view("Building · step 3 of 6", "first");
  await act(async () => root!.render(createElement(FlowView, { view: initial, csrf: "fixture" })));
  const card = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent?.startsWith("Fix checkout rounding"))!;
  expect(card()).toBeDefined();
  expect(card().textContent).toContain("Building · step 3 of 6");
  const empty = phone ? [...document.querySelectorAll("section")].find(one => one.querySelector("header")?.textContent === "Review") : document.querySelector('[data-zone="review"]');
  expect(empty).toBeDefined();
  expect(empty!.querySelectorAll("button")).toHaveLength(0);
  for (const [index, text] of ["Stuck: Staging is unavailable", "Waiting on you: Use the same rounding for refunds, including partial refunds and orders with multiple payments?", "Ready", "Task unavailable"].entries()) {
    const next = view(text, `state-${index}`);
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => next })); vi.stubGlobal("fetch", fetcher);
    await act(async () => { streams.at(-1)!.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ at: next.live }) })); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const status = [...card().querySelectorAll("div")].find(one => one.textContent === text)!;
    expect(status.classList.contains("truncate")).toBe(true);
    expect(card().textContent).not.toContain("Filed as a task");
  }
  await act(async () => card().click());
  const panel = document.querySelector("[data-flow-card-panel]")!;
  expect(panel).not.toBeNull();
  expect(panel.querySelector('a[href="/t/checkout"]')?.textContent).toBe("Open its task");
});

test("a nudge during a read is kept, a failed read retries on its own, and reload reads again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(createElement(FlowView, { view: view("Building · step 1 of 6", "first"), csrf: "fixture" })));
    const nudge = (at: string) => act(async () => { streams.at(-1)!.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ at, revision: "v1:9" }) })); });
    let release!: () => void;
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => view("Building · step 2 of 6", "second") }); }))
      .mockImplementation(async () => ({ ok: true, json: async () => view("Building · step 3 of 6", "third") }));
    vi.stubGlobal("fetch", fetcher);
    await nudge("second");
    await nudge("third");
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The nudge that arrived mid-read isn't dropped: one more read follows, and the page shows the newest state.
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Building · step 3 of 6");

    // A failed read doesn't leave the page stale until the next write.
    fetcher.mockImplementationOnce(async () => { throw new TypeError("offline"); });
    await nudge("fourth");
    expect(fetcher).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(fetcher).toHaveBeenCalledTimes(4);

    // The server's stream fell behind and caught up.
    await act(async () => { streams.at(-1)!.dispatchEvent(new MessageEvent("reload", { data: "{}" })); });
    expect(fetcher).toHaveBeenCalledTimes(5);
    // And the page reconciles on its own slow beat.
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetcher).toHaveBeenCalledTimes(6);
  } finally { vi.useRealTimers(); }
});
