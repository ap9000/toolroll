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

  test("the controls offer what the attempt takes: Pause or Resume and Stop for the exact run, and words where notes can't go", () => {
    const requests: [string, string, string] = ["web-a", "web-b", "web-c"];
    render(board(detail({ question: null, controls: { send: "live", words: "Notes reach the agent right away.",
      pause: { action: "/t/t-7/pause", run: 7, state: null, requests, until: null }, stop: { action: "/t/t-7/stop", run: 7, label: "Stop" } } })));
    expect(host.querySelector("[data-agent-capability]")?.textContent).toBe("Notes reach the agent right away.");
    const pause = host.querySelector<HTMLFormElement>("[data-agent-pause]")!;
    expect([...pause.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map(one => [one.name, one.value])).toEqual(expect.arrayContaining([["run", "7"], ["request", "web-a"], ["return", "agents"]]));
    expect(host.querySelector<HTMLFormElement>('[data-agent-stop="7"]')?.getAttribute("action")).toBe("/t/t-7/stop");
    expect(host.querySelector('[data-agent-composer="steer"]')).not.toBeNull();
    // Paused: Resume instead of Pause.
    act(() => root?.render(createElement(AgentsView, { view: board(detail({ question: null, controls: { send: "live", words: "Notes reach the agent right away.",
      pause: { action: "/t/t-7/pause", run: 7, state: "paused", requests, until: null }, stop: { action: "/t/t-7/stop", run: 7, label: "Stop" } } })) })));
    expect(host.querySelector("[data-agent-pause]")).toBeNull();
    expect(host.querySelector<HTMLFormElement>("[data-agent-resume]")?.querySelector<HTMLInputElement>('input[name="mode"]')?.value).toBe("resume");
    // Repairing its handoff: no box, the words say why, and Stop names the owning attempt.
    act(() => root?.render(createElement(AgentsView, { view: board(detail({ question: null, steer: null, controls: { send: null,
      words: "It's repairing its handoff and reads no notes now. Stop this attempt to change its course.", pause: null, stop: { action: "/t/t-7/stop", run: 7, label: "Stop this attempt" } } })) })));
    expect(host.querySelector("[data-agent-composer]")).toBeNull();
    expect(host.querySelector("[data-agent-unsent]")).toBeNull();
    expect(host.querySelector('[data-agent-stop="7"]')?.textContent).toBe("Stop this attempt");
    // A viewer gets no controls.
    act(() => root?.render(createElement(AgentsView, { view: board(detail({ canAct: false, controls: { send: "mailbox", words: "x", pause: null, stop: { action: "/t/t-7/stop", run: 7, label: "Stop" } } })) })));
    expect(host.querySelector("[data-agent-controls]")).toBeNull();
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

describe("the opened agent's conversation", () => {
  const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
  const answer = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

  test("the terminal view: the same records, one dense line each, output tails, notes inline, markup never rendered; the choice is kept", async () => {
    try { localStorage.removeItem("toolroll.agent.view"); } catch { /* none */ }
    const notes = [{ id: 5, author: "alex", mine: true, at: at(12), text: "Skip the flaky test", standing: "Read by the agent at", readAt: at(13) }];
    const out = Array.from({ length: 20 }, (_, n) => `line ${n + 1}`);
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async () => reads++ > 0 ? answer({ records: [], nextOffset: 400, gen: "records:1:2", final: false, notes, older: 0 }) : answer({ nextOffset: 400, gen: "records:1:2", final: false, older: 0, notes, records: [
      { k: "open", at: at(0), detail: "commands" },
      { k: "say", at: at(1), t: ["Looking at <b>the form</b>"] },
      { k: "step", at: at(2), id: "s1", kind: "read", target: "src/form.ts" },
      { k: "done", at: at(3), id: "s1", ok: true },
      { k: "step", at: at(10), id: "s2", kind: "command", target: "npm test" },
      { k: "done", at: at(14), id: "s2", ok: false, out },
      { k: "step", at: at(20), id: "s3", kind: "command", target: "npm run lint" },
    ] })));
    await act(async () => { root = createRoot(host); root.render(createElement(AgentsView, { view: board(detail({ question: null, transcript: "/r/7?fragment=transcript&shape=records" })) })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const toTerminal = [...host.querySelectorAll<HTMLButtonElement>('[data-conversation-view] button')].find(one => one.textContent === "Terminal")!;
    await act(async () => { toTerminal.click(); });
    const terminal = host.querySelector("[data-terminal]")!;
    expect([...terminal.querySelectorAll("[data-terminal-step]")].map(one => one.firstChild?.textContent)).toEqual(["› Read src/form.ts", "$ npm test", "$ npm run lint"]);
    const failed = terminal.querySelectorAll("[data-terminal-step]")[1]!;
    expect(failed.textContent).toContain("[failed]");
    expect(failed.querySelector("[data-terminal-output]")?.textContent).toBe(`… 8 earlier lines\n${out.slice(-12).join("\n")}`);
    expect(terminal.querySelectorAll("[data-terminal-step]")[2]!.textContent).toContain("[running]");
    expect(terminal.querySelector("[data-terminal-note]")?.textContent).toContain("» you: Skip the flaky test");
    // The note sits between the steps it came between.
    const order = [...terminal.children].map(one => one.hasAttribute("data-terminal-note") ? "note" : one.getAttribute("data-terminal-step") ?? "say");
    expect(order).toEqual(["say", "read", "command", "note", "command"]);
    // The agent's words are text, never markup.
    expect(terminal.querySelector("b")).toBeNull();
    expect(terminal.querySelector("[data-terminal-say]")?.textContent).toBe("Looking at <b>the form</b>");
    expect(localStorage.getItem("toolroll.agent.view")).toBe("terminal");
    localStorage.removeItem("toolroll.agent.view");
  });

  test("the terminal view keeps the project's command consent: a run that hid commands shows no command or output, and says so", async () => {
    localStorage.setItem("toolroll.agent.view", "terminal");
    let reads = 0;
    // The recorder kept no command text for a base-tier run: its steps arrive without targets or output.
    vi.stubGlobal("fetch", vi.fn(async () => reads++ > 0 ? answer({ records: [], nextOffset: 200, gen: "records:1:2", final: false, notes: [], older: 0 }) : answer({ nextOffset: 200, gen: "records:1:2", final: false, older: 0, notes: [], records: [
      { k: "open", at: at(0), detail: "base" },
      { k: "step", at: at(1), id: "s1", kind: "command" },
      { k: "done", at: at(2), id: "s1", ok: true },
      { k: "cut", at: at(3) },
    ] })));
    await act(async () => { root = createRoot(host); root.render(createElement(AgentsView, { view: board(detail({ question: null, transcript: "/r/7?fragment=transcript&shape=records" })) })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const terminal = host.querySelector("[data-terminal]")!;
    expect(terminal).not.toBeNull();
    expect(terminal.querySelector("[data-terminal-step]")?.textContent).not.toContain("$");
    expect(terminal.querySelector("[data-terminal-output]")).toBeNull();
    expect(terminal.querySelector("[data-terminal-marker]")).not.toBeNull();
    expect(host.querySelector('[data-conversation-detail="base"]')?.textContent).toContain("Commands were hidden for this run.");
    localStorage.removeItem("toolroll.agent.view");
  });

  test("steps show their target and how they ended, a failed command opens to its output, and notes sit in time order with their standing", async () => {
    const fetched: string[] = [];
    const notes = [
      { id: 5, author: "alex", mine: true, at: at(12), text: "Skip the flaky test", standing: "Read by the agent at", readAt: at(13) },
      { id: 6, author: "robin", mine: false, at: at(30), text: "Ping me when done", standing: "Waiting for the agent to read it", readAt: null },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      fetched.push(input);
      // Every answer carries the run's notes whole.
      if (fetched.length > 1) return answer({ records: [], nextOffset: 400, gen: "records:1:2", final: false, notes, older: 0 });
      return answer({ nextOffset: 400, gen: "records:1:2", final: false, older: 0, records: [
        { k: "open", at: at(0), detail: "commands" },
        { k: "say", at: at(1), t: ["Looking at <b>the form</b>"] },
        { k: "step", at: at(2), id: "s1", kind: "read", target: "src/form.ts" },
        { k: "done", at: at(3), id: "s1", ok: true },
        { k: "step", at: at(10), id: "s2", kind: "command", target: "npm test" },
        { k: "done", at: at(14), id: "s2", ok: false, out: ["FAIL src/form.test.ts", "1 failed"] },
        { k: "step", at: at(20), id: "s3", kind: "command", target: "npm run lint" },
      ], notes });
    }));
    render(board(detail({ question: null, transcript: "/r/7?fragment=transcript&shape=records" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const pane = host.querySelector("[data-agent-transcript]")!;
    expect(fetched[0]).toBe("/r/7?fragment=transcript&shape=records&from=0");
    // Text stays text.
    expect(pane.querySelector("b")).toBeNull();
    expect(pane.textContent).toContain("Looking at <b>the form</b>");
    const steps = [...pane.querySelectorAll("[data-step]")];
    expect(steps.map(one => [one.querySelector("[data-step-target]")?.textContent, one.querySelector("[data-step-status]")?.getAttribute("data-step-status")]))
      .toEqual([["src/form.ts", "ok"], ["npm test", "failed"], ["npm run lint", "running"]]);
    expect(steps[1]!.querySelector("[data-step-output]")?.textContent).toBe("FAIL src/form.test.ts\n1 failed");
    // Notes merge by time: Alex's after the failing command started, Robin's last; "You" only for one's own.
    const order = [...pane.querySelectorAll("[data-step], [data-conversation-note]")].map(one => one.getAttribute("data-conversation-note") ?? one.querySelector("[data-step-target]")?.textContent);
    expect(order).toEqual(["src/form.ts", "npm test", "5", "npm run lint", "6"]);
    expect(pane.querySelector('[data-conversation-note="5"]')?.textContent).toContain("You");
    expect(pane.querySelector('[data-conversation-note="6"]')?.textContent).toContain("robin");
    expect(pane.querySelector('[data-conversation-note="6"] [data-note-standing]')?.textContent).toBe("Waiting for the agent to read it");
    expect(host.querySelector("[data-conversation-detail]")).toBeNull();
    // The next read carries the offset and the file it belongs to.
    expect(fetched[1]).toBe("/r/7?fragment=transcript&shape=records&from=400&gen=records%3A1%3A2");
  });

  test("a run that hid commands says so; another machine's run still shows its notes; an unknown end is never success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer({ error: "off", older: 0, notes: [{ id: 1, author: "alex", mine: true, at: at(1), text: "Hello", standing: "Waiting for the agent to read it", readAt: null }] })));
    render(board(detail({ question: null, transcript: "/r/7?fragment=transcript&shape=records" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.querySelector('[data-conversation-note="1"]')).not.toBeNull();
    expect(host.querySelector('[data-conversation-state="off"]')).not.toBeNull();
    await act(async () => root?.unmount());
    root = null;

    vi.stubGlobal("fetch", vi.fn(async () => answer({ nextOffset: 9, gen: "g", final: true, older: 0, notes: [], records: [
      { k: "open", at: at(0), detail: "base" },
      { k: "step", at: at(1), id: "s1", kind: "command" },
      { k: "done", at: at(2), id: "s1", ok: null },
      { k: "step", at: at(3), id: "s2", kind: "command" },
    ] })));
    render(board(detail({ question: null, live: false, steer: null, transcript: "/r/7?fragment=transcript&shape=records" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect([...host.querySelectorAll("[data-step-status]")].map(one => one.getAttribute("data-step-status"))).toEqual(["muted", "muted"]);
    expect(host.querySelector("[data-agent-transcript]")?.textContent).not.toContain("Done");
    expect(host.querySelector('[data-conversation-detail="base"]')).not.toBeNull();
  });
});

describe("the conversation's failures and the steering draft", () => {
  test("a read that fails after content keeps what was shown and says it is retrying", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, status: 200, json: async () => ({ nextOffset: 10, gen: "g", final: false, notes: [], older: 0, records: [{ k: "say", at: new Date(NOW).toISOString(), t: ["Working on it"] }] }) } as Response;
      throw new TypeError("network down");
    }));
    render(board(detail({ question: null, transcript: "/r/7?fragment=transcript&shape=records" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.querySelector("[data-agent-transcript]")?.textContent).toContain("Working on it");
    expect(host.querySelector('[data-conversation-state="error"]')).not.toBeNull();
  });

  test("a refused send keeps the draft and its key; only that draft's own successful send clears it", () => {
    sessionStorage.clear();
    const steer = () => host.querySelector<HTMLFormElement>('[data-agent-composer="steer"]')!;
    render(board(detail({ question: null })));
    const box = steer().querySelector("textarea")!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Check the retry path"); box.dispatchEvent(new Event("input", { bubbles: true })); });
    const key = steer().querySelector<HTMLInputElement>('input[name="key"]')!.value;
    expect(key).not.toBe("");
    // Back from a refusal: the same text under the same key, so sending again cannot file it twice.
    act(() => root?.unmount());
    render(board(detail({ question: null, said: { tone: "error", text: "That attempt ended" } })));
    expect(steer().querySelector("textarea")!.value).toBe("Check the retry path");
    expect(steer().querySelector<HTMLInputElement>('input[name="key"]')!.value).toBe(key);
    // Back from another draft's success: this one stays.
    act(() => root?.unmount());
    history.replaceState(null, "", "/agents?run=7&said=steered&sent=someone-else-key");
    render(board(detail({ question: null })));
    expect(steer().querySelector("textarea")!.value).toBe("Check the retry path");
    // Back from its own success: cleared, with a new key.
    act(() => root?.unmount());
    history.replaceState(null, "", `/agents?run=7&said=steered&sent=${key}`);
    render(board(detail({ question: null })));
    expect(steer().querySelector("textarea")!.value).toBe("");
    expect(steer().querySelector<HTMLInputElement>('input[name="key"]')!.value).not.toBe(key);
    history.replaceState(null, "", "/");
  });
});

describe("after the attempt ends", () => {
  test("an unsent note is shown with a way to send it to the next attempt; a notes-only failure still warns", async () => {
    sessionStorage.clear();
    sessionStorage.setItem("toolroll:steer-draft:7", JSON.stringify({ text: "Use the retry path", key: "k-12345678", submitted: true }));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    render(board(detail({ question: null, steer: null, live: false, said: { tone: "error", text: "That attempt ended" }, transcript: "/r/7?fragment=transcript&shape=records" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const unsent = host.querySelector<HTMLFormElement>("[data-agent-unsent]")!;
    expect(unsent.getAttribute("action")).toBe("/t/t-7/steer");
    expect(unsent.querySelector("[data-agent-unsent-text]")?.textContent).toBe("Use the retry path");
    // Sent to the task, not bound to the ended run: it names the run it came from and its draft key, never `run`.
    expect([...unsent.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map(one => [one.name, one.name === "csrf" ? "" : one.value]).sort())
      .toEqual([["after", "7"], ["csrf", ""], ["key", "k-12345678"], ["note", "Use the retry path"]]);
    // Sending does not clear it: only the page that comes back naming this draft as sent does.
    act(() => { unsent.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(JSON.parse(sessionStorage.getItem("toolroll:steer-draft:7")!)).toMatchObject({ text: "Use the retry path", key: "k-12345678" });
    expect(host.querySelector("[data-agent-composer]")).toBeNull();
    act(() => root?.unmount());
    root = null;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ records: [], nextOffset: 0, gen: "g", final: false, older: 0, notes: [{ id: 1, author: "alex", mine: true, at: new Date(NOW).toISOString(), text: "Hi", standing: "Waiting for the agent to read it", readAt: null }] }) } as Response)
      .mockRejectedValue(new TypeError("network down")));
    render(board(detail({ question: null, transcript: "/r/7?fragment=transcript&shape=records" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(host.querySelector('[data-conversation-note="1"]')).not.toBeNull();
    expect(host.querySelector('[data-conversation-state="error"]')).not.toBeNull();
  });
});

test("an answer that does not say whether a key block is open keeps the last answer's word", async () => {
  const { applyWindow, emptyConversation } = await import("./views/agent-conversation.js");
  const inside = applyWindow(emptyConversation("/r/7"), { records: [], nextOffset: 10, gen: "g", inKey: true, final: false, notes: [], older: 0 });
  expect(applyWindow(inside, { error: "off", notes: [], older: 0 }).inKey).toBe(true);
  expect(applyWindow(inside, { records: [], nextOffset: 10, gen: "g", final: false }).inKey).toBe(true);
  expect(applyWindow(inside, { records: [], nextOffset: 20, gen: "g", inKey: false, final: false }).inKey).toBe(false);
});

test("a key tail is carried only in the shape this code produces", async () => {
  const { applyWindow, emptyConversation } = await import("./views/agent-conversation.js");
  const base = emptyConversation("/r/7");
  expect(applyWindow(base, { records: [], nextOffset: 0, keyTail: "TOPSECRET" }).keyTail).toBe("");
  expect(applyWindow(base, { records: [], nextOffset: 0, keyTail: "-----BE|--||C" }).keyTail).toBe("-----BE|--||C");
});

test("past the kept limit, every row keeps its own identity: no duplicates as older rows drop", async () => {
  const { applyWindow, emptyConversation, KEEP_ITEMS } = await import("./views/agent-conversation.js");
  const at = new Date(NOW).toISOString();
  let conversation = emptyConversation("/r/7");
  for (let window = 0; window < 4; window += 1) {
    conversation = applyWindow(conversation, { nextOffset: window + 1, gen: "g", final: false, records: Array.from({ length: 600 }, () => ({ k: "say" as const, at, t: ["Review line"] })) });
  }
  expect(conversation.items).toHaveLength(KEEP_ITEMS);
  expect(new Set(conversation.items.map(item => item.key)).size).toBe(KEEP_ITEMS);
});
