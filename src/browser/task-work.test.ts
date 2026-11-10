// @vitest-environment happy-dom
/** The task page's work panel (docs/plans/task-page-steps.md "Watch the work"): what it shows and what its box takes in
 * each state — live, mailbox, no notes, transcript off, no run; its reader asks for nothing while a password is on the
 * page or the password popover is open; a note written for an attempt outlives it as that attempt's unsent note, never
 * the lead's message; no card with a control renders in it; and below 1100px, where it lies over the page, it is an
 * overlay: nothing under it can be reached, and a link to the page closes it. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { AssignmentCard } from "../assignment-ui.js";
import type { BrowserAgentControls, BrowserTaskView } from "../browser-workspace.js";
import { installKitBehavior, useConversation } from "./kit/index.js";
import { TaskView, type ThreadChat } from "./views/task-view.js";
import { saveDraft } from "./views/steer-composer.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
const card: AssignmentCard = {
  token: "assignment-working", tone: "info", label: "Building",
  status: { headline: "Building", tone: "info", sentence: "Step 2 of 3: Add the test", details: [], primaryAction: null, why: [] },
  action: null, reasons: [], diagnostics: [], notices: null, attempts: [], lead: null,
};
const RECORDS = "/r/5?fragment=transcript&shape=records";
const controls = (over: Partial<BrowserAgentControls> = {}): BrowserAgentControls => ({ send: "live", words: "Notes reach the agent right away.",
  pause: { action: "/t/t-1/pause", run: 5, state: null, requests: ["web-a", "web-b", "web-c"], until: null }, stop: { action: "/t/t-1/stop", run: 5, label: "Stop" }, ...over });
/** A live build of run 5 by Claude Sonnet, with the panel asked for by the address. */
const liveView = (over: Partial<BrowserTaskView> = {}): BrowserTaskView => ({
  kind: "task", id: "t-1", title: "Add subtract", project: null, scout: false, tabs: [], version: null,
  status: card, statusHtml: "", approval: "", lead: [], questions: "", facts: [], sections: [], manage: [], cancel: null, tab: "activity",
  thread: [{ key: "filed", at: at(-600), kind: "filed", who: "person", author: "alex", title: "Filed the task", text: "Add subtract", link: null, html: "", more: null }],
  work: { run: 5, live: true, agent: "Claude Sonnet", transcript: RECORDS },
  stop: { action: "/t/t-1/stop", run: 5 },
  steering: { controls: controls(), steer: { action: "/t/t-1/steer", run: 5 } },
  activity: { what: "edit", at: at(-30), worker: "online" },
  ...over,
});
const ended = (over: Partial<BrowserTaskView> = {}): BrowserTaskView => liveView({
  work: { run: 5, live: false, agent: "Claude Sonnet", transcript: RECORDS }, stop: null, steering: null, steerRecent: [5], activity: null, ...over,
});
const leadChat: ThreadChat = { entries: [], footer: createElement("form", { "data-lead-box": "", action: "/chat" },
  createElement("label", { htmlFor: "lead" }, "Message the lead"), createElement("textarea", { id: "lead", name: "message" })) };

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
const answer = (body: unknown): Answer => ({ ok: true, status: 200, json: async () => body });
const window1 = { nextOffset: 300, gen: "records:1:2", final: false, older: 0, records: [
  { k: "open", at: at(0), detail: "commands" },
  { k: "say", at: at(1), t: ["I'll add subtract next to add, then a test."] },
  { k: "step", at: at(2), id: "s1", kind: "read", target: "src/math.js" },
  { k: "done", at: at(3), id: "s1", ok: true },
  { k: "step", at: at(4), id: "s2", kind: "edit", target: "test/math.test.js" },
], notes: [{ id: 9, author: "alex", mine: true, at: at(3), text: "Also test negative numbers.", standing: "Picked up at", readAt: at(4) }] };

/** The screen as the page asks about it: `narrow` is below 1100px, where the panel lies over the page. */
const screen = (narrow: boolean, phone = false) => vi.spyOn(window, "matchMedia").mockImplementation(query => ({
  matches: query.includes("max-width: 1099px") ? narrow : query.includes("min-width: 1100px") ? !narrow : query.includes("max-width: 760px") ? phone : false, media: query,
  onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as MediaQueryList);
const frame = () => act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(null))); await vi.advanceTimersByTimeAsync(0); });

let root: Root | null = null, host: HTMLElement, fetched: string[];
beforeAll(() => installKitBehavior());
beforeEach(() => {
  // Wide unless a test says otherwise: the panel beside the rows.
  screen(false);
  Element.prototype.scrollIntoView = vi.fn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  try { localStorage.clear(); } catch { /* none */ }
  history.replaceState(null, "", "/t/t-1");
  fetched = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => { fetched.push(input); return answer(fetched.length === 1 ? window1 : { records: [], nextOffset: 300, gen: "records:1:2", final: false, older: 0, notes: window1.notes }); }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root !== null) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const show = async (view: BrowserTaskView, chat: ThreadChat | null = leadChat) => {
  await act(async () => root!.render(createElement(TaskView, { view, chat, csrf: "csrf" })));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
};
const panel = () => host.querySelector<HTMLElement>('[data-task-panel="activity"]')!;
const type = (box: HTMLTextAreaElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
  box.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("the work panel's states", () => {
  test("live: the agent's words, its actions as quiet lines, your note as a bubble; the box names the agent and can pause and send", async () => {
    await show(liveView());
    const work = panel();
    expect(work.hidden).toBe(false);
    expect(work.getAttribute("data-work-state")).toBe("live");
    expect(work.querySelector(".k-work-who")?.textContent).toBe("Claude Sonnet · working");
    expect(work.querySelector(".k-work-dot")).not.toBeNull();
    expect(fetched[0]).toBe(`${RECORDS}&from=0`);
    expect(work.querySelector("[data-work-say]")?.textContent).toBe("I'll add subtract next to add, then a test.");
    expect([...work.querySelectorAll("[data-step]")].map(one => [one.querySelector("[data-step-target]")?.textContent, one.querySelector("[data-step-status]")?.getAttribute("data-step-status")]))
      .toEqual([["src/math.js", "ok"], ["test/math.test.js", "running"]]);
    expect(work.querySelector('[data-conversation-note="9"] .k-work-bubble')?.textContent).toBe("Also test negative numbers.");
    // The note the records show isn't repeated by the thread; the thread follows the records.
    expect(work.querySelector('[data-task-thread] [data-thread-entry="filed"]')).not.toBeNull();
    // The box: the steer note to this exact run, named for the agent, with pause-and-send; it approves nothing.
    const form = work.querySelector<HTMLFormElement>('[data-steer-note="5"]')!;
    expect(form.getAttribute("action")).toBe("/t/t-1/steer");
    expect(form.querySelector("label")?.textContent).toBe("Message Claude Sonnet");
    expect(form.querySelector("[data-steer-pause-send]")?.getAttribute("formaction")).toBe("/t/t-1/pause");
    expect(form.querySelector(".k-composer-note")?.textContent).toBe("Notes reach the agent right away.");
    expect(work.querySelector('input[type="password"], .k-approve, [data-task-approval]')).toBeNull();
    // The page itself has no transcript box of its own.
    expect(host.querySelector("#live-transcript")).toBeNull();
  });

  test("mailbox: the box says the agent reads notes at its next check, and offers no pause", async () => {
    await show(liveView({ steering: { controls: controls({ send: "mailbox", words: "It reads notes at its next check.", pause: null }), steer: { action: "/t/t-1/steer", run: 5 } } }));
    expect(panel().getAttribute("data-work-state")).toBe("mailbox");
    expect(panel().querySelector(".k-composer-note")?.textContent).toBe("It reads notes at its next check.");
    expect(panel().querySelector("[data-steer-pause-send]")).toBeNull();
    expect(panel().querySelector('[data-steer-note="5"] textarea[name="note"]')).not.toBeNull();
  });

  test("an attempt that can't take notes: its own sentence instead of the box, and no box to the lead either", async () => {
    await show(liveView({ steering: { controls: controls({ send: null, words: "It's repairing its handoff and reads no notes now. Stop this attempt to change its course.", pause: null }), steer: null } }));
    expect(panel().getAttribute("data-work-state")).toBe("no-notes");
    expect(panel().querySelector("[data-work-no-notes]")?.textContent).toBe("It's repairing its handoff and reads no notes now. Stop this attempt to change its course.");
    expect(panel().querySelector("textarea")).toBeNull();
    expect(panel().querySelector("[data-lead-box]")).toBeNull();
  });

  test("transcript off: one sentence, the activity line and the thread, nothing invented", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => { fetched.push(input); return answer({ error: "off", older: 0, notes: [] }); }));
    await show(liveView());
    const work = panel();
    expect(work.getAttribute("data-work-state")).toBe("off");
    expect(work.querySelector("[data-transcript-empty]")?.textContent).toBe("The agent's words aren't shown here: it runs on another computer.");
    expect(work.querySelector("[data-activity]")).not.toBeNull();
    expect(work.querySelector('[data-thread-entry="filed"]')).not.toBeNull();
    expect(work.querySelectorAll("[data-step], [data-work-say]")).toHaveLength(0);
  });

  test("no run yet: no records at all, the thread and the conversation with the lead", async () => {
    await show(liveView({ work: null, stop: null, steering: null, activity: null }));
    const work = panel();
    expect(work.getAttribute("data-work-state")).toBe("none");
    expect(work.querySelector(".k-work-who")?.textContent).toBe("No build yet");
    expect(work.querySelector("[data-work-run]")).toBeNull();
    expect(fetched).toEqual([]);
    expect(work.querySelector("[data-lead-box] textarea")).not.toBeNull();
    expect(work.querySelector('[data-thread-entry="filed"]')).not.toBeNull();
  });

  test("open or closed is this viewer's, kept when it can be, and the page works when storage refuses", async () => {
    await show(liveView({ tab: undefined }));
    expect(panel().hidden).toBe(true);
    // A closed panel reads nothing.
    expect(fetched).toEqual([]);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-open-activity]")!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(panel().hidden).toBe(false);
    expect(localStorage.getItem("toolroll.task.work")).toBe("open");
    expect(fetched.length).toBeGreaterThan(0);
    await act(async () => panel().querySelector<HTMLButtonElement>("[data-close-activity]")!.click());
    expect(panel().hidden).toBe(true);
    expect(localStorage.getItem("toolroll.task.work")).toBe("closed");
    await act(async () => root!.unmount());
    // Left open: it comes back open beside the rows, never as a sheet over the page on a narrower screen.
    localStorage.setItem("toolroll.task.work", "open");
    const wide = (matches: boolean) => vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: matches && query.includes("min-width"), media: query,
      onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as MediaQueryList);
    wide(true);
    root = createRoot(host);
    await show(liveView({ tab: undefined }));
    expect(panel().hidden).toBe(false);
    await act(async () => root!.unmount());
    wide(false);
    root = createRoot(host);
    await show(liveView({ tab: undefined }));
    expect(panel().hidden).toBe(true);
    await act(async () => root!.unmount());
    vi.restoreAllMocks();
    // Storage that throws: the page still renders and the panel still opens.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    root = createRoot(host);
    await show(liveView({ tab: undefined }));
    expect(panel().hidden).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-open-activity]")!.click());
    expect(panel().hidden).toBe(false);
  });

  test("a card with a control never renders inside the panel, password or not: a link to the page stands in for it", async () => {
    const entry = (key: string, kind: "question" | "result" | "progress", html: string, more: string | null = null, link: { label: string; href: string } | null = null) =>
      ({ key, at: at(-60), kind, who: "agent" as const, author: "", title: key, text: null, link, html, more: more === null ? null : { summary: "More", html: more } });
    await show(liveView({ thread: [
      entry("asks", "question", '<form method="post" action="/x"><input type="password" name="token"></form>'),
      // Passwordless: an approval with no password field is still a decision.
      entry("approves", "progress", '<div class="card"><form method="post" action="/t/t-1/accept-revision"><button type="submit">Approve changes &amp; continue</button></form></div>'),
      entry("folded", "result", "<p>Built.</p>", '<form method="post" action="/t/t-1/merge"><button>Merge</button></form>'),
      entry("linked", "progress", "<button type=\"button\">Retry</button>", null, { label: "Decide on the task page", href: "#plan-revisions" }),
      entry("plain", "progress", '<p data-plain="">Step 2 of 3</p>'),
    ] }));
    const work = panel();
    expect(work.querySelector('[data-task-thread] :is(form, button, input, select, textarea)')).toBeNull();
    expect(work.textContent).not.toContain("Approve changes");
    const link = (key: string) => { const a = work.querySelector<HTMLAnchorElement>(`[data-thread-entry="${key}"] a`); return a === null ? null : [a.textContent, a.getAttribute("href")]; };
    expect(link("asks")).toEqual(["Open it on the task page", "/t/t-1"]);
    expect(link("approves")).toEqual(["Open it on the task page", "/t/t-1"]);
    expect(link("folded")).toEqual(["Open it on the task page", "/t/t-1?tab=result"]);
    // The server's own link is kept.
    expect(link("linked")).toEqual(["Decide on the task page", "#plan-revisions"]);
    // A card with nothing to press stays.
    expect(work.querySelector('[data-thread-entry="plain"] [data-plain]')?.textContent).toBe("Step 2 of 3");
  });
});

describe("below 1100px the panel lies over the page", () => {
  const decision = '<div class="card" id="plan-revisions"><h2>Plan change</h2><form method="post" action="/t/t-1/accept-revision"><button type="submit">Approve changes &amp; continue</button></form></div>';
  const asksToDecide = () => liveView({ lead: [{ key: "plan-revisions", html: decision }], thread: [
    { key: "plan-revisions", at: at(-60), kind: "progress", who: "agent", author: "", title: "Recommends a plan change", text: "Use the read replica.", link: { label: "Decide on the task page", href: "#plan-revisions" }, html: "", more: null }] });
  const closedState = (doc: HTMLElement) => ({ hidden: panel().hidden, scrim: host.querySelector(".k-scrim") !== null, inert: doc.inert, modal: panel().hasAttribute("aria-modal") });

  test("it is an overlay: a scrim, the page under it inert, and Escape, the scrim and Close each close it and give the focus back", async () => {
    screen(true);
    // happy-dom lays nothing out; the kit asks for an element's boxes to know it can take the focus back.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    await show(liveView({ tab: undefined }));
    const open = host.querySelector<HTMLButtonElement>("[data-open-activity]")!;
    const doc = host.querySelector<HTMLElement>(".k-doc")!;
    expect(closedState(doc)).toEqual({ hidden: true, scrim: false, inert: false, modal: false });
    const opened = async () => {
      await act(async () => open.click());
      expect(panel().hidden).toBe(false);
      expect(panel().getAttribute("role")).toBe("dialog");
      expect(panel().getAttribute("aria-modal")).toBe("true");
      expect(panel().previousElementSibling?.className).toContain("k-scrim dim");
      // The rows, the header and the dock are out of reach: nothing under the panel takes Tab or a press.
      expect(doc.inert).toBe(true);
      // Close has the focus, never the message box (a phone would raise its keyboard over the work).
      expect(document.activeElement).toBe(panel().querySelector("[data-close-activity]"));
    };
    const closed = () => {
      expect(closedState(doc)).toEqual({ hidden: true, scrim: false, inert: false, modal: false });
      expect(document.activeElement).toBe(open);
    };
    await opened();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    closed();
    await opened();
    await act(async () => host.querySelector<HTMLElement>(".k-scrim")!.click());
    closed();
    await opened();
    await act(async () => panel().querySelector<HTMLButtonElement>("[data-close-activity]")!.click());
    closed();
    expect(localStorage.getItem("toolroll.task.work")).toBe("closed");
  });

  test("beside the rows it is part of the page: no scrim, nothing inert, no dialog", async () => {
    await show(liveView());
    expect(panel().hidden).toBe(false);
    expect(host.querySelector(".k-scrim")).toBeNull();
    expect(host.querySelector<HTMLElement>(".k-doc")!.inert).toBe(false);
    expect(panel().hasAttribute("aria-modal")).toBe(false);
  });

  test("a link in the panel to a place on the page closes the panel, shows the place and gives it the focus", async () => {
    screen(true);
    await show(asksToDecide());
    const doc = host.querySelector<HTMLElement>(".k-doc")!;
    expect(panel().hidden).toBe(false);
    expect(doc.inert).toBe(true);
    // The decision is on the page, never in the panel.
    expect(panel().querySelector("form")?.getAttribute("action") ?? "").not.toContain("accept-revision");
    const place = doc.querySelector<HTMLElement>("#plan-revisions")!;
    expect(place.querySelector("form")!.getAttribute("action")).toBe("/t/t-1/accept-revision");
    await act(async () => panel().querySelector<HTMLAnchorElement>('[data-thread-entry="plan-revisions"] a')!.click());
    await frame();
    expect(closedState(doc)).toEqual({ hidden: true, scrim: false, inert: false, modal: false });
    expect(window.location.hash).toBe("#plan-revisions");
    expect(new URL(window.location.href).searchParams.get("tab")).toBeNull();
    // The place itself has the focus, never its button: a stray Enter approves nothing.
    expect(document.activeElement).toBe(place);
    expect(place.scrollIntoView).toHaveBeenCalled();
  });

  test("beside the rows the same link shows the place and the panel stays", async () => {
    await show(asksToDecide());
    await act(async () => panel().querySelector<HTMLAnchorElement>('[data-thread-entry="plan-revisions"] a')!.click());
    await frame();
    expect(panel().hidden).toBe(false);
    expect(window.location.hash).toBe("#plan-revisions");
    expect(host.querySelector<HTMLElement>("#plan-revisions")!.scrollIntoView).toHaveBeenCalled();
  });

  test("the link that stands in for a card kept out of the panel closes it too: the page it names is this one", async () => {
    screen(true);
    await show(liveView({ thread: [{ key: "approves", at: at(-60), kind: "progress", who: "agent", author: "", title: "Plan change", text: null, link: null,
      html: '<form method="post" action="/t/t-1/accept-revision"><button type="submit">Approve</button></form>', more: null }] }));
    expect(panel().hidden).toBe(false);
    await act(async () => panel().querySelector<HTMLAnchorElement>('[data-thread-entry="approves"] a')!.click());
    await frame();
    expect(panel().hidden).toBe(true);
    expect(host.querySelector(".k-scrim")).toBeNull();
    expect(host.querySelector<HTMLElement>(".k-doc")!.inert).toBe(false);
  });

  test("a link in the panel to another version of this task is another page: it is left to load, and nothing closes", async () => {
    screen(true);
    await show(liveView({ thread: [
      { key: "older", at: at(-60), kind: "progress", who: "agent", author: "", title: "Earlier version", text: null, html: "", more: null, link: { label: "Version 1", href: "/t/t-1?version=1" } },
      { key: "same", at: at(-50), kind: "progress", who: "agent", author: "", title: "This page", text: null, html: "", more: null, link: { label: "The task page", href: "/t/t-1" } }] }));
    // What the page's own handler decided, read after it ran; the test then stops the load itself.
    const taken: boolean[] = [];
    const after = (event: Event) => { taken.push(event.defaultPrevented); event.preventDefault(); };
    document.addEventListener("click", after);
    try {
      await act(async () => panel().querySelector<HTMLAnchorElement>('[data-thread-entry="older"] a')!.click());
      await frame();
      expect(taken).toEqual([false]);
      expect(panel().hidden).toBe(false);
      expect(host.querySelector(".k-scrim")).not.toBeNull();
      // The same address with no other version is this page: taken, and the panel closes.
      await act(async () => panel().querySelector<HTMLAnchorElement>('[data-thread-entry="same"] a')!.click());
      await frame();
      expect(taken).toEqual([false, true]);
      expect(panel().hidden).toBe(true);
    } finally { document.removeEventListener("click", after); }
  });
});

describe("the reader on a page that asks for a password", () => {
  test("a password field that appears between two windows stops the very next request, before React is told", async () => {
    // The reader alone, never told to pause: only what it finds on the page at the moment of asking can stop it.
    const Reader = () => createElement("p", { "data-read": useConversation(RECORDS, true, false).offset });
    const field = document.createElement("input");
    field.type = "password";
    // Every window says more waits (the reader would ask again at once); the field appears while the first is in flight.
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      fetched.push(input);
      if (fetched.length === 1) document.body.append(field);
      return answer({ records: [], nextOffset: 300 * fetched.length, gen: "records:1:2", final: false, older: 0, notes: [] });
    }));
    await act(async () => root!.render(createElement(Reader)));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetched).toEqual([`${RECORDS}&from=0`]);
    // The field gone: it reads on from where it stopped.
    await act(async () => { field.remove(); await vi.advanceTimersByTimeAsync(600); });
    expect(fetched.length).toBeGreaterThan(1);
    expect(fetched[1]).toBe(`${RECORDS}&from=300&gen=records%3A1%3A2`);
  });

  test("a password field on the page: no transcript request at all; it reads once the field is gone", async () => {
    const ceremony = document.createElement("form");
    ceremony.innerHTML = '<input type="password" name="token">';
    document.body.append(ceremony);
    await show(liveView());
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetched).toEqual([]);
    expect(panel().getAttribute("data-work-state")).toBe("paused");
    expect(panel().querySelector("[data-transcript-empty]")?.textContent).toBe("The live view waits while this page asks for your password.");
    await act(async () => { ceremony.remove(); await vi.advanceTimersByTimeAsync(0); });
    expect(fetched[0]).toBe(`${RECORDS}&from=0`);
  });

  test("the password popover open: no request while it is open, reading resumes from the same place when it closes", async () => {
    await show(liveView());
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const before = fetched.length;
    expect(before).toBeGreaterThanOrEqual(2);
    // The approve popover is drawn into the page (a portal) with its password field.
    const popover = document.createElement("div");
    popover.className = "k-pop";
    popover.innerHTML = '<input type="password" name="token" autocomplete="current-password">';
    await act(async () => { document.body.append(popover); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetched.length).toBe(before);
    await act(async () => { popover.remove(); await vi.advanceTimersByTimeAsync(0); });
    expect(fetched.length).toBe(before + 1);
    // From where it stopped, never from the start.
    expect(fetched.at(-1)).toBe(`${RECORDS}&from=300&gen=records%3A1%3A2`);
  });
});

test("a draft outlives its attempt: never sent to the lead, kept as that attempt's unsent note with Send to the next attempt", async () => {
  await show(liveView());
  const box = panel().querySelector<HTMLTextAreaElement>('[data-steer-note="5"] textarea')!;
  type(box, "check the migration first");
  const key = panel().querySelector<HTMLInputElement>('[data-steer-note="5"] input[name="key"]')!.value;
  // The attempt ends while the page is open: the box becomes the lead's, empty; the words stay run 5's.
  await show(ended());
  const work = panel();
  expect(work.querySelector("[data-steer-note]")).toBeNull();
  const lead = work.querySelector<HTMLTextAreaElement>("[data-lead-box] textarea")!;
  expect(lead.value).toBe("");
  const unsent = work.querySelector<HTMLFormElement>('[data-steer-unsent="5"]')!;
  expect(unsent.querySelector("[data-steer-unsent-text]")?.textContent).toBe("check the migration first");
  expect(unsent.getAttribute("action")).toBe("/t/t-1/steer");
  expect(Object.fromEntries([...unsent.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].filter(one => one.name !== "csrf").map(one => [one.name, one.value])))
    .toEqual({ note: "check the migration first", after: "5", key, return: "task" });
  expect(unsent.textContent).toContain("Send to the next attempt");
  // It sits at the end of what scrolls, never in the fixed foot: a long note can't push Send, Discard or the box off the screen.
  expect(unsent.closest(".k-work-body")).not.toBeNull();
  expect(work.querySelector(".k-work-foot [data-steer-unsent]")).toBeNull();
  expect(work.querySelector(".k-work-foot [data-lead-box]")).not.toBeNull();
  // One place at a time: the status box shows it only while the panel is closed.
  expect(host.querySelectorAll("[data-steer-unsent]")).toHaveLength(1);
});

test("a note saved for an earlier attempt shows in the status box while the panel is closed", async () => {
  saveDraft(4, { text: "use the read replica", key: "k-unsent-0004", submitted: true });
  await show(ended({ tab: undefined, steerRecent: [5, 4] }));
  expect(panel().hidden).toBe(true);
  expect(host.querySelectorAll('[data-steer-unsent="4"]')).toHaveLength(1);
  expect(panel().querySelector("[data-steer-unsent]")).toBeNull();
});
