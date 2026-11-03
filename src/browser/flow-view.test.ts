// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserFlowView } from "../browser-workspace.js";
import { flowFromSteps } from "../flows.js";
import { FlowView } from "./views/flow-view.js";
import { installKitBehavior } from "./kit/index.js";

const definition = flowFromSteps([{ id: "build", title: "Build", kind: "task", instructions: "Fix checkout rounding" }, { id: "review", title: "Review", kind: "approval" }], null);
const view = (waiting: string, live: string): BrowserFlowView => ({
  kind: "flow", flow: { id: 1, name: "Checkout", project: "Shop", revision: 1, href: "/flows/1", owner: "alex" },
  chatHref: "/chat", triggers: [], triggerSetup: { kinds: [], githubRepo: null, linearKey: false, hooksBase: null, hooksPath: "/hooks", mailbox: null, otherFlows: [] },
  startTrigger: null, me: "alex", sortReady: false, emailReady: false, requestSecrets: [], tools: [], scripts: [],
  start: definition.start, stages: definition.stages, selectedCard: null, live, canEdit: false, approvers: [], kinds: [], colors: [],
  unattended: { active: null, canSign: false, problem: "Only an approver can change this.", maxDays: 7, scheduled: false, terms: { head: [], rules: [] }, schedules: [], schedulesDigest: "d0" },
  browser: null,
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
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: phone && query === "(max-width: 760px)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const initial = view("Building · step 3 of 6", "first");
  await act(async () => root!.render(createElement(FlowView, { view: initial, csrf: "fixture" })));
  const card = () => document.querySelector<HTMLButtonElement>('[data-card="1"]')!;
  expect(card()).not.toBeNull();
  expect(card().textContent).toContain("Building · step 3 of 6");
  const empty = document.querySelector(phone ? '[data-step="review"]' : '[data-zone="review"]');
  expect(empty).toBeDefined();
  expect(empty!.querySelectorAll("button")).toHaveLength(0);
  for (const [index, text] of ["Stuck: Staging is unavailable", "Waiting on you: Use the same rounding for refunds, including partial refunds and orders with multiple payments?", "Ready", "Task unavailable"].entries()) {
    const next = view(text, `state-${index}`);
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => next })); vi.stubGlobal("fetch", fetcher);
    await act(async () => { streams.at(-1)!.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ at: next.live }) })); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([...card().querySelectorAll("span")].some(one => one.textContent === text)).toBe(true);
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
/** The flow's ⋯ menu (a popover at a desk, a sheet on a phone), and one of its items. */
const menuItem = async (label: string): Promise<HTMLButtonElement | undefined> => {
  await act(async () => menu().click());
  return [...document.querySelectorAll<HTMLButtonElement>(".k-menu button")].find(one => one.textContent === label);
};
/** The way in to sign: "Run on its own…" in the ⋯ menu opens its drawer, on a desk and a phone alike. */
async function openSigning(): Promise<void> {
  const item = await menuItem("Run on its own…");
  await act(async () => item!.click());
}
const typeInto = (input: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
/** A step-up's password popover (KApprove): type the password and press its button. */
async function confirmWithPassword(label: string, password: string): Promise<void> {
  const field = document.querySelector<HTMLInputElement>('.k-pop input[name="token"]')!;
  expect(field).not.toBeNull();
  await typeInto(field, password);
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.k-pop button[type="submit"]')].find(one => one.textContent === label)!.click());
}

const TERMS = { head: ["Cards this flow's own schedule adds file their work approved by alex, without waiting in Needs you.", "Builds use safe permissions: routine project commands and edits proceed; risky acts stop for approval."],
  rules: ["Never covered: Person decides steps, pull request merges, publish or deploy scripts, and anything it sends. Cards people add and other triggers wait as usual."] };
const SCHEDULES = [{ id: 4, words: "“Weekly upkeep”, Mondays at 09:00", optional: null }, { id: 5, words: "the issues script, daily at 07:00", optional: "Its cards come from what the script prints, which can be outside text." }];

test.each([false, true])("runs on its own: the live line with one-click Revoke, and every term before the password (phone=%s)", async phone => {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: phone && query === "(max-width: 760px)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const off: BrowserFlowView = { ...view("Ready", "off"), canEdit: true, unattended: { active: null, canSign: true, problem: null, maxDays: 7, scheduled: true, terms: TERMS, schedules: SCHEDULES, schedulesDigest: "d1" } };
  const on: BrowserFlowView = { ...off, live: "on", unattended: { ...off.unattended, active: { until: "2026-10-15T08:00:00.000Z", untilWords: "Oct 15, 08:00 UTC", signedBy: "alex", budgetMicrousd: null, dailyRunCap: 3, runsToday: 1, words: [], covers: ["“Weekly upkeep”, Mondays at 09:00"] } } };
  const posted: Array<{ path: string; body: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: { body: URLSearchParams }) => {
    posted.push({ path, body: String(init.body) });
    return { ok: true, json: async () => path.endsWith("/unattended") ? { ok: true, said: "Runs on its own until Oct 15, 08:00 UTC.", view: on } : { ok: true, said: "It no longer runs on its own. New cards wait for you.", view: off } };
  }));
  await act(async () => root!.render(createElement(FlowView, { view: off, csrf: "fixture" })));
  await openSigning();
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
  // Each limit field is its label's control.
  expect(document.querySelector(`label[for="${CSS.escape(runs.id)}"]`)?.textContent).toBe("Runs a day");
  expect(document.querySelector(`label[for="${CSS.escape(panel.querySelector<HTMLInputElement>("[data-flow-unattended-budget]")!.id)}"]`)?.textContent).toBe("Budget per attempt ($)");
  // An invalid limit is refused next to its field, before any password: the terms keep the last valid reading.
  await typeInto(runs, "3.5");
  expect(runs.getAttribute("aria-invalid")).toBe("true");
  expect(terms()).toContain("No daily limit on runs.");
  const sign = [...panel.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Sign")!;
  await act(async () => sign.click());
  expect(document.querySelector('.k-pop input[name="token"]')).toBeNull();
  expect(posted).toHaveLength(0);
  await typeInto(runs, "3");
  expect(terms()).toContain("At most 3 runs a day (UTC); after that, cards wait for you.");
  await act(async () => sign.click());
  await confirmWithPassword("Sign", "correct horse");
  expect(posted[0]!.path).toBe("/flows/1/unattended");
  expect(Object.fromEntries(new URLSearchParams(posted[0]!.body))).toEqual({ csrf: "fixture", days: "1", budget: "", runs: "3", include: "", schedules: "d1", password: "correct horse", revision: "1" });
  const line = document.querySelector('[data-flow-unattended="on"]')!;
  expect(line.textContent).toBe("Runs on its own until Oct 15" + "Revoke");
  expect(line.querySelector("[title]")?.getAttribute("title")).toBe("Ends Oct 15, 08:00 UTC · covers “Weekly upkeep”, Mondays at 09:00");
  await act(async () => line.querySelector<HTMLButtonElement>("[data-flow-unattended-revoke]")!.click());
  expect(posted[1]).toMatchObject({ path: "/flows/1/unattended-off", body: "csrf=fixture" });
  expect(document.querySelector('[data-flow-unattended="on"]')).toBeNull();
});

test.each([false, true])("browser use: a waiting card opens Allow browser, the panel carries the digest it showed, Turn off is one click (phone=%s)", async phone => {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: phone && query === "(max-width: 760px)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const drawn = flowFromSteps([{ id: "run", title: "Run journeys", kind: "check", script: "journeys", browser: true }], null);
  const base = view("Run journeys starts a browser, and no one has approved browser use for the Checkout flow, so it didn't run.", "w");
  const waiting: BrowserFlowView = { ...base, canEdit: true, start: drawn.start, stages: drawn.stages,
    cards: [{ ...base.cards[0]!, stage: "run", task: null, browserWait: true }],
    browser: { status: "none", words: "Browser: not allowed — runs will wait", signedBy: null, signedAt: null, zones: [{ zone: "run", title: "Run journeys", script: "journeys", version: 2, digest: "a".repeat(64) }],
      terms: ["Lets the journeys script (zone run) start Playwright's Chromium headless shell inside the flow's sandbox."], digest: "d".repeat(32), problem: null } };
  const allowed: BrowserFlowView = { ...waiting, live: "a", cards: [{ ...waiting.cards[0]!, browserWait: undefined } as BrowserFlowView["cards"][number]], browser: { ...waiting.browser!, status: "allowed", words: "Browser: allowed by alex, Nov 1", signedBy: "alex", signedAt: "2026-11-01T12:00:00Z" } };
  const posted: Array<{ path: string; body: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: { body: URLSearchParams }) => {
    posted.push({ path, body: String(init.body) });
    return { ok: true, json: async () => path.endsWith("/browser") ? { ok: true, said: "Browser allowed.", view: allowed } : { ok: true, said: "Browser turned off.", view: { ...waiting, live: "b" } } };
  }));
  await act(async () => root!.render(createElement(FlowView, { view: waiting, csrf: "fixture" })));
  // The decision frame is on the page itself: why it waits, and the scope you'd approve, before any password.
  const panel = document.querySelector('[data-flow-browser-panel][data-flow-browser="none"]')!;
  expect(panel.textContent).toContain("Allow browser for Run journeys?");
  const card = document.querySelector<HTMLButtonElement>('[data-card="1"]')!;
  await act(async () => card.click());
  await act(async () => document.querySelector<HTMLButtonElement>("[data-card-allow-browser]")!.click());
  expect(document.querySelector("[data-flow-card-panel]")).toBeNull();
  expect(panel.querySelector("[data-flow-browser-zones]")!.textContent).toBe(`Run journeys runs journeys v2${"a".repeat(64)}`);
  expect(panel.querySelector("[data-flow-browser-terms]")!.textContent).toContain(`Approval digest ${"d".repeat(32)}`);
  const allow = [...panel.querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Allow browser")!;
  await act(async () => allow.click());
  await confirmWithPassword("Allow browser", "correct horse");
  expect(posted[0]!.path).toBe("/flows/1/browser");
  expect(Object.fromEntries(new URLSearchParams(posted[0]!.body))).toEqual({ csrf: "fixture", digest: "d".repeat(32), password: "correct horse" });
  const line = document.querySelector('[data-flow-browser="allowed"]')!;
  expect(line.textContent).toBe("Browser: allowed by alex, Nov 1" + "Turn off");
  await act(async () => line.querySelector<HTMLButtonElement>("[data-flow-browser-off]")!.click());
  expect(posted[1]).toMatchObject({ path: "/flows/1/browser-off", body: "csrf=fixture" });
});

test("browser use: a live update never swaps the terms the password approves", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const drawn = flowFromSteps([{ id: "run", title: "Run journeys", kind: "check", script: "journeys", browser: true }], null);
  const browser = (version: number, digest: string): NonNullable<BrowserFlowView["browser"]> => ({ status: "none", words: "Browser: not allowed — runs will wait", signedBy: null, signedAt: null,
    zones: [{ zone: "run", title: "Run journeys", script: "journeys", version, digest: String(version).repeat(64) }], terms: ["Lets the journeys script start Chromium."], digest, problem: null });
  const first: BrowserFlowView = { ...view("Ready", "one"), canEdit: true, start: drawn.start, stages: drawn.stages, cards: [], browser: browser(1, "a".repeat(32)) };
  const swapped: BrowserFlowView = { ...first, live: "two", browser: browser(2, "b".repeat(32)) };
  await act(async () => root!.render(createElement(FlowView, { view: first, csrf: "fixture" })));
  const panel = () => document.querySelector("[data-flow-browser-panel]")!;
  await act(async () => [...panel().querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Allow browser")!.click());
  await typeInto(document.querySelector<HTMLInputElement>('.k-pop input[name="token"]')!, "correct horse");
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => swapped })); vi.stubGlobal("fetch", fetcher);
  await act(async () => { streams.at(-1)!.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ at: swapped.live }) })); });
  // Nothing to submit until the new terms are read; the password typed for the old ones is gone with its popover.
  expect(panel().querySelector("[data-flow-browser-moved]")).not.toBeNull();
  expect([...panel().querySelectorAll("button")].some(one => one.textContent === "Allow browser")).toBe(false);
  expect(document.querySelector('.k-pop input[name="token"]')).toBeNull();
  expect(panel().querySelector("[data-flow-browser-terms]")!.textContent).toContain(`Approval digest ${"a".repeat(32)}`);
  await act(async () => [...panel().querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Read the new terms")!.click());
  expect(panel().querySelector("[data-flow-browser-terms]")!.textContent).toContain(`Approval digest ${"b".repeat(32)}`);
  expect([...panel().querySelectorAll("button")].some(one => one.textContent === "Allow browser")).toBe(true);
});

test("browser use: after an approval ends, the first unapproved terms are frozen; a newer script while the password is open only offers Reload", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const drawn = flowFromSteps([{ id: "run", title: "Run journeys", kind: "check", script: "journeys", browser: true }], null);
  const browser = (status: "allowed" | "ended", version: number, digest: string): NonNullable<BrowserFlowView["browser"]> => ({ status, words: status === "allowed" ? "Browser: allowed by alex, Nov 1" : "Browser approval ended: the script changed",
    signedBy: "alex", signedAt: "2026-11-01T12:00:00Z", zones: [{ zone: "run", title: "Run journeys", script: "journeys", version, digest: String(version).repeat(64) }], terms: ["Lets the journeys script start Chromium."], digest, problem: null });
  const at = (live: string, next: NonNullable<BrowserFlowView["browser"]>): BrowserFlowView => ({ ...view("Ready", live), canEdit: true, start: drawn.start, stages: drawn.stages, cards: [], browser: next });
  const views = [at("two", browser("ended", 2, "b".repeat(32))), at("three", browser("ended", 3, "c".repeat(32)))];
  const posted: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => { if (path.endsWith("/browser")) posted.push(path); return { ok: true, json: async () => views.shift() }; }));
  await act(async () => root!.render(createElement(FlowView, { view: at("one", browser("allowed", 1, "a".repeat(32))), csrf: "fixture" })));
  expect(document.querySelector("[data-flow-browser-panel]")).toBeNull();
  const nudge = (live: string) => act(async () => { streams.at(-1)!.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ at: live }) })); });
  await nudge("two");
  const panel = () => document.querySelector("[data-flow-browser-panel]")!;
  expect(panel().textContent).toContain("Browser approval expired");
  await act(async () => [...panel().querySelectorAll<HTMLButtonElement>("button")].find(one => one.textContent === "Allow browser")!.click());
  await typeInto(document.querySelector<HTMLInputElement>('.k-pop input[name="token"]')!, "correct horse");
  // Another script edit lands while the password is open: the terms read stay, and nothing can approve the new ones.
  await nudge("three");
  expect(panel().querySelector("[data-flow-browser-terms]")!.textContent).toContain(`Approval digest ${"b".repeat(32)}`);
  expect(panel().querySelector("[data-flow-browser-moved]")).not.toBeNull();
  expect(document.querySelector('.k-pop input[name="token"]')).toBeNull();
  expect([...panel().querySelectorAll("button")].some(one => one.textContent === "Allow browser")).toBe(false);
  expect(posted).toEqual([]);
});

test("phone: Expand gives the canvas the screen as a modal surface; Escape from any control in it comes back to Expand", async () => {
  installKitBehavior();
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: query === "(max-width: 760px)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(FlowView, { view: view("Ready", "x"), csrf: "fixture" })));
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".fl-viewsw button")].find(one => one.textContent === "Canvas")!.click());
  await act(async () => document.querySelector<HTMLButtonElement>("[data-flow-expand]")!.click());
  const surface = document.querySelector<HTMLElement>(".fl-canvas.expanded")!;
  expect(surface.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement).toBe(surface.querySelector("[data-flow-collapse]"));
  // The page behind is out of reach while it's expanded.
  expect(document.querySelector<HTMLElement>(".fl-head")!.closest<HTMLElement>("[inert]") ?? document.querySelector<HTMLElement>(".fl-head")!.parentElement!.querySelector(":scope > [inert]")).not.toBeNull();
  const zoomIn = surface.querySelector<HTMLButtonElement>('[aria-label="Zoom in (+)"]')!;
  zoomIn.focus();
  await act(async () => { zoomIn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise(resolve => requestAnimationFrame(() => resolve(null))); });
  expect(document.querySelector(".fl-canvas.expanded")).toBeNull();
  expect(document.querySelector<HTMLElement>(".fl-canvas")!.hidden).toBe(false);
  expect(document.activeElement).toBe(document.querySelector("[data-flow-expand]"));
  expect(document.querySelector("[inert]")).toBeNull();
});

test("a person who can't sign reads why, and a flow without a schedule shows nothing", async () => {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const refused: BrowserFlowView = { ...view("Ready", "x"), canEdit: true, unattended: { active: null, canSign: false, problem: "This project is protected: a person approves its work.", maxDays: 7, scheduled: true, terms: TERMS, schedules: SCHEDULES, schedulesDigest: "d1" } };
  await act(async () => root!.render(createElement(FlowView, { view: refused, csrf: "fixture" })));
  await openSigning();
  expect(document.querySelector("[data-flow-unattended-problem]")?.textContent).toBe("This project is protected: a person approves its work.");
  expect(document.querySelector('[data-flow-unattended-panel] button')).toBeNull();
  // The canvas keeps its own copy of the view: a fresh page for the flow with no schedule.
  await act(async () => root!.unmount());
  root = createRoot(host);
  await act(async () => root!.render(createElement(FlowView, { view: { ...refused, unattended: { ...refused.unattended, scheduled: false } }, csrf: "fixture" })));
  expect(await menuItem("Run on its own…")).toBeUndefined();
});
