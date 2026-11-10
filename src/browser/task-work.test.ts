// @vitest-environment happy-dom
/** The task page's work panel (docs/plans/task-page-steps.md "Watch the work"): what it shows and what its box takes in
 * each state — live, mailbox, no notes, transcript off, no run; its reader asks for nothing while a password is on the
 * page or the password popover is open; and a note written for an attempt outlives it as that attempt's unsent note,
 * never the lead's message. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AssignmentCard } from "../assignment-ui.js";
import type { BrowserAgentControls, BrowserTaskView } from "../browser-workspace.js";
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

let root: Root | null = null, host: HTMLElement, fetched: string[];
beforeEach(() => {
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

  test("a card that asks for a password never renders inside the panel", async () => {
    await show(liveView({ thread: [{ key: "questions", at: at(-60), kind: "question", who: "agent", author: "", title: "Asked you a question", text: null, link: null,
      html: '<form method="post" action="/x"><input type="password" name="token"></form>', more: null }] }));
    expect(panel().querySelector('input[type="password"]')).toBeNull();
    expect(panel().querySelector('[data-thread-entry="questions"] a')?.textContent).toBe("Open it on the task page");
  });
});

describe("the reader on a page that asks for a password", () => {
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
