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
  unattended: { active: null, canSign: false, problem: "Only an approver can change this.", maxDays: 7, scheduled: false, terms: { head: [], rules: [] }, schedules: [], schedulesDigest: "d0" },
  cards: [{ id: 1, title: "Fix checkout rounding", description: null, stage: "build", state: "active", waiting,
    task: { id: "checkout", href: "/t/checkout" }, createdBy: "alex", updatedAt: "2026-10-07T17:00:00Z", canDecide: false,
    outputs: [], history: [], source: null, owner: null, watchers: [], watching: false, mine: false, comments: [], sorted: null, draft: null }],
});

let root: Root | null = null;
let streams: FakeStream[] = [];
class FakeStream extends EventTarget {
  static CLOSED = 2;
  readyState = 1;
  constructor(readonly url: string) { super(); streams.push(this); }
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
    expect([...card().querySelectorAll("div")].some(one => one.textContent === text)).toBe(true);
  }
  await act(async () => card().click());
  const panel = document.querySelector("[data-flow-card-panel]")!;
  expect(panel).not.toBeNull();
  expect(panel.querySelector('a[href="/t/checkout"]')?.textContent).toBe("Open its task");
});

test("a nudge during a read is kept, a failed read retries on its own, reload reads again, and nothing reads on a timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(createElement(FlowView, { view: view("Building · step 1 of 6", "first"), csrf: "fixture" })));
    // The page's one stream, joined to this flow's room.
    expect(streams.at(-1)!.url).toBe("/live?room=flow%3A1");
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
    // Without a write, the room says nothing and the page reads nothing.
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(fetcher).toHaveBeenCalledTimes(5);
  } finally { vi.useRealTimers(); }
});

const menu = () => document.querySelector<HTMLButtonElement>("[data-flow-menu]")!;
/** The way in to sign: the canvas's ⋯ menu on a desktop, a disclosure under the title on a phone. */
async function openSigning(phone: boolean): Promise<void> {
  if (phone) { await act(async () => document.querySelector<HTMLElement>('details[data-flow-unattended="off"] summary')!.click()); return; }
  await act(async () => { menu().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); menu().click(); });
  await act(async () => document.querySelector<HTMLElement>('[data-flow-unattended="off"]')!.click());
}

const TERMS = { head: ["Cards this flow's own schedule adds file their work approved by alex, without waiting in Needs you.", "Builds use safe permissions: routine project commands and edits proceed; risky acts stop for approval."],
  rules: ["Never covered: Person decides steps, pull request merges, publish or deploy scripts, and anything it sends. Cards people add and other triggers wait as usual."] };
const SCHEDULES = [{ id: 4, words: "“Weekly upkeep”, Mondays at 09:00", optional: null }, { id: 5, words: "the issues script, daily at 07:00", optional: "Its cards come from what the script prints, which can be outside text." }];

test.each([false, true])("runs on its own: the live line with one-click Revoke, and every term before the password (phone=%s)", async phone => {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: phone && query === "(max-width: 767px)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const off: BrowserFlowView = { ...view("Ready", "off"), canEdit: true, unattended: { active: null, canSign: true, problem: null, maxDays: 7, scheduled: true, terms: TERMS, schedules: SCHEDULES, schedulesDigest: "d1" } };
  const on: BrowserFlowView = { ...off, live: "on", unattended: { ...off.unattended, active: { until: "2026-10-15T08:00:00.000Z", untilWords: "Oct 15, 08:00 UTC", signedBy: "alex", budgetMicrousd: null, dailyRunCap: 3, runsToday: 1, words: [], covers: ["“Weekly upkeep”, Mondays at 09:00"] } } };
  const posted: Array<{ path: string; body: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: { body: URLSearchParams }) => {
    posted.push({ path, body: String(init.body) });
    return { ok: true, json: async () => path.endsWith("/unattended") ? { ok: true, said: "Runs on its own until Oct 15, 08:00 UTC.", view: on } : { ok: true, said: "It no longer runs on its own. New cards wait for you.", view: off } };
  }));
  await act(async () => root!.render(createElement(FlowView, { view: off, csrf: "fixture" })));
  await openSigning(phone);
  const panel = document.querySelector("[data-flow-unattended-panel]")!;
  expect(panel).not.toBeNull();
  const terms = () => [...panel.querySelectorAll("[data-flow-unattended-terms] li")].map(one => one.textContent);
  const covers = (words: string[]) => `It covers ${words.length === 1 ? "this schedule" : "these schedules"} when ${words.length === 1 ? "it fires" : "they fire"} on time: ${words.join("; ")}. Run now, and schedules added or changed later, wait for you.`;
  expect(terms()).toEqual([...TERMS.head, covers(["“Weekly upkeep”, Mondays at 09:00"]), "No dollar cap per attempt.", "No daily limit on runs.", ...TERMS.rules, "Ends 1 day after you sign. Revoking it earlier is one click."]);
  // A script's schedule is covered only when picked, and the terms say so as it is.
  const script = panel.querySelector<HTMLInputElement>("[data-flow-unattended-schedules] input[type=checkbox]")!;
  expect(script.labels![0]!.textContent).toBe("the issues script, daily at 07:00Its cards come from what the script prints, which can be outside text.");
  await act(async () => script.click());
  expect(terms()[TERMS.head.length]).toBe(covers(["“Weekly upkeep”, Mondays at 09:00", "the issues script, daily at 07:00"]));
  await act(async () => script.click());
  const runs = panel.querySelector<HTMLInputElement>("[data-flow-unattended-runs]")!;
  const type = (input: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await type(runs, "3");
  expect(terms()).toContain("At most 3 runs a day (UTC); after that, cards wait for you.");
  const sign = [...panel.querySelectorAll("button")].find(one => one.textContent === "Sign")!;
  expect(sign.disabled).toBe(true);
  await type(panel.querySelector<HTMLInputElement>('input[type="password"]')!, "correct horse");
  await act(async () => sign.click());
  expect(posted[0]!.path).toBe("/flows/1/unattended");
  expect(Object.fromEntries(new URLSearchParams(posted[0]!.body))).toEqual({ csrf: "fixture", days: "1", budget: "", runs: "3", include: "", schedules: "d1", password: "correct horse", revision: "1" });
  const line = document.querySelector('[data-flow-unattended="on"]')!;
  expect(line.textContent).toBe("Runs on its own until Oct 15" + "Revoke");
  expect(line.querySelector("[title]")?.getAttribute("title")).toBe("Ends Oct 15, 08:00 UTC · covers “Weekly upkeep”, Mondays at 09:00");
  await act(async () => line.querySelector<HTMLButtonElement>("[data-flow-unattended-revoke]")!.click());
  expect(posted[1]).toMatchObject({ path: "/flows/1/unattended-off", body: "csrf=fixture" });
  expect(document.querySelector('[data-flow-unattended="on"]')).toBeNull();
});

test("a person who can't sign reads why, and a flow without a schedule shows nothing", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const refused: BrowserFlowView = { ...view("Ready", "x"), canEdit: true, unattended: { active: null, canSign: false, problem: "This project is protected: a person approves its work.", maxDays: 7, scheduled: true, terms: TERMS, schedules: SCHEDULES, schedulesDigest: "d1" } };
  await act(async () => root!.render(createElement(FlowView, { view: refused, csrf: "fixture" })));
  await openSigning(false);
  expect(document.querySelector("[data-flow-unattended-problem]")?.textContent).toBe("This project is protected: a person approves its work.");
  expect(document.querySelector('[data-flow-unattended-panel] input[type="password"]')).toBeNull();
  // The canvas keeps its own copy of the view: a fresh page for the flow with no schedule.
  await act(async () => root!.unmount());
  root = createRoot(host);
  await act(async () => root!.render(createElement(FlowView, { view: { ...refused, unattended: { ...refused.unattended, scheduled: false } }, csrf: "fixture" })));
  await act(async () => { menu().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); menu().click(); });
  expect(document.querySelector('[data-flow-unattended="off"]')).toBeNull();
});
