// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserWorkspace } from "../browser-workspace.js";
import { CommandMenu, CrewRows, GuardedHtml, useWorkspace, workspaceCommands } from "./app.js";
import {
  carryDraft, DRAFT_TTL, editDraft, emptyDraft, isWorkspace, readWorkspace, receiveDraft,
  restoreDraft, sameConversation, saveDraft, sendMessage, submitDraft, WorkspaceAuthError,
} from "./workspace-client.js";

const a = "a".repeat(32), b = "b".repeat(32), c = "c".repeat(32);
const scope = { user: "alex", session: 7, task: "task-a" };
const now = 1_790_000_000_000;
const fixture = (): BrowserWorkspace => ({
  version: 1, path: "/chat?task=task-a&result=9", title: "Lead", user: "alex", csrf: "csrf", sensitive: true,
  refreshUrl: "/chat?task=task-a&result=9", receipt: null, projects: [], crew: [], crewTruncated: false,
  conversation: { sessionId: 7, user: "alex", version: "v1", messages: [], pendingTurnId: null, requestId: a, maxChars: 2000, taskId: "task-a", resultRunId: 9 },
  focus: null, result: null, catchUpHtml: "", controlsHtml: "", notices: [], pageHtml: null,
  navigation: [{ label: "Chat", href: "/chat", active: true }],
});
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
let root: Root | null = null;

test("Crew reasons disclose plain text separately from navigation, without repeating the lead", async () => {
  const workspace = fixture();
  const detail = 'Checks failed on payout rounding. Maya is on it. <script>not markup</script>';
  const item = { id: 'payouts', title: 'Fix payout rounding', state: 'failed' as const, label: 'Failed', tone: 'problem' as const,
    updatedAt: '2026-10-05T10:00:00Z', project: '/projects/payments', href: '/chat?task=payouts',
    resultHref: '/chat?task=payouts&result=9', action: null, detail, lead: 'Maya is on it.' };
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = async (items: BrowserWorkspace['crew']) => act(async () => root!.render(createElement(CrewRows, { workspace, items })));
  await render([item]);
  const disclosure = host.querySelector('details')!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('summary')?.title).toBe(detail);
  expect(disclosure.textContent).toBe(detail);
  expect(disclosure.closest('a')).toBeNull();
  expect(host.querySelector('script')).toBeNull();
  expect(host.querySelector('[data-crew-lead]')).toBeNull();
  expect(host.querySelector('a')?.getAttribute('href')).toBe(item.resultHref);
  // A server update must not retain an expanded disclosure or stale reason.
  disclosure.open = true;
  await render([{ ...item, detail: 'Waiting for a worker.' }]);
  expect(host.querySelector('details')?.open).toBe(false);
  expect(host.querySelector('[data-crew-lead]')?.textContent).toBe(item.lead);
  const { detail: _detail, ...withoutReason } = item;
  await render([withoutReason]);
  expect(host.querySelector('details')).toBeNull();
});

test("the whole Crew row taps through to the task, while the reason toggles in place", async () => {
  const workspace = fixture();
  const item = { id: 'payouts', title: 'Fix payout rounding', state: 'failed' as const, label: 'Failed', tone: 'problem' as const,
    updatedAt: '2026-10-05T10:00:00Z', project: '/projects/payments', href: '/chat?task=payouts',
    resultHref: '/chat?task=payouts&result=9', action: null, detail: 'Checks failed on payout rounding.', lead: 'Maya is on it.' };
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(CrewRows, { workspace, items: [item] })));
  const row = host.querySelector('.so-work-row')!;
  // One link per row; its overlay covers the row, so the lead and project lines tap through to it.
  expect(row.querySelectorAll('a.so-work-link')).toHaveLength(1);
  expect(row.querySelector('[data-crew-lead]')?.closest('.so-work-row')).toBe(row);
  expect([...row.querySelectorAll('.so-work-project')].map(line => line.textContent)).toEqual(['Maya is on it.', 'payments']);
  const css = readFileSync(join(import.meta.dirname, "workspace.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css).toMatch(/\.so-work-row \{[^}]*position: relative/);
  expect(css).toMatch(/\.so-work-link::after \{[^}]*position: absolute; inset: 0/);
  // The reason sits above that overlay, so tapping it expands it without navigating.
  expect(css).toMatch(/\.so-work-reason \{[^}]*position: relative; z-index: 1/);
  const disclosure = row.querySelector('details')!;
  expect(disclosure.closest('a')).toBeNull();
  disclosure.querySelector('summary')!.click();
  expect(disclosure.open).toBe(true);
});

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("draft persistence is bounded by account, session, task and expiry", () => {
  const draft = editDraft(emptyDraft(a, now), "Preserve the approval terms", () => b, now);
  expect(saveDraft(sessionStorage, scope, draft)).toBe(true);
  expect(restoreDraft(sessionStorage, scope, c, 2000, now).text).toBe(draft.text);
  expect(restoreDraft(sessionStorage, { ...scope, user: "other" }, c, 2000, now).text).toBe("");
  expect(restoreDraft(sessionStorage, { ...scope, session: 8 }, c, 2000, now).text).toBe("");
  expect(restoreDraft(sessionStorage, { ...scope, task: "other" }, c, 2000, now).text).toBe("");
  expect(restoreDraft(sessionStorage, scope, c, 2000, now + DRAFT_TTL + 1).text).toBe("");
});

test("explicit reconnect carries only words for the same account and task, with a fresh receipt key", () => {
  carryDraft(sessionStorage, scope, "Keep this unsent", now);
  expect(restoreDraft(sessionStorage, { ...scope, user: "other", session: 8 }, b, 2000, now).text).toBe("");
  const recovered = restoreDraft(sessionStorage, { ...scope, session: 8 }, b, 2000, now);
  expect(recovered).toMatchObject({ text: "Keep this unsent", request: b, submitted: false, pending: null });
  expect(restoreDraft(sessionStorage, { ...scope, session: 8 }, c, 2000, now).text).toBe("");
});

test("an interrupted send survives reload and an exact receipt clears only the submitted draft", () => {
  const sent = submitDraft(editDraft(emptyDraft(a, now), "Review the result", () => b, now), now);
  saveDraft(sessionStorage, scope, sent);
  const recovered = restoreDraft(sessionStorage, scope, c, 2000, now);
  expect(recovered.pending).toEqual({ request: a, text: "Review the result" });
  expect(receiveDraft(recovered, a, { request: a, received: true }, () => b, now)).toEqual(emptyDraft(b, now));
});

test("late receipts never erase a new draft or settle a different in-flight request", () => {
  const sent = submitDraft(editDraft(emptyDraft(a, now), "First message", () => b, now), now);
  const edited = editDraft(sent, "Next message", () => b, now);
  expect(edited.pending?.request).toBe(a);
  expect(receiveDraft(edited, null, { request: a, received: true }, () => c, now)).toBe(edited);
  expect(receiveDraft(edited, b, { request: a, received: true }, () => c, now)).toBe(edited);
  expect(receiveDraft(edited, a, { request: a, received: false }, () => c, now)).toBe(edited);
  expect(receiveDraft(edited, a, { request: a, received: true }, () => c, now)).toMatchObject({ text: "Next message", request: b, pending: null, submitted: false });
  expect(submitDraft(edited, now)).toBe(edited);
});

test("send submits once with the exact existing form identity and never retries a lost response", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection closed"));
  await expect(sendMessage(fixture(), { request: a, text: "Check result 9" }, fetcher)).rejects.toThrow("connection closed");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("/chat");
  expect(init?.method).toBe("POST");
  expect(init?.credentials).toBe("same-origin");
  expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({ csrf: "csrf", message: "Check result 9", request: a, "request-session": "7", task: "task-a", result: "9" });
});

test("a normal HTML redirect response is not mistaken for confirmed delivery", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>Chat</html>", { headers: { "content-type": "text/html" } }));
  await expect(sendMessage(fixture(), { request: a, text: "Check result 9" }, fetcher)).resolves.toEqual({ refused: false, message: null });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("snapshot checks use same-origin read transport and reject incomplete data before receipts", async () => {
  const complete = fixture(); complete.receipt = { request: a, received: true };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(complete));
  await expect(readWorkspace(fixture(), a, fetcher)).resolves.toEqual({ kind: "changed", workspace: complete, etag: null });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toContain("task=task-a&result=9&format=workspace&request=" + a);
  expect(init?.method).toBeUndefined();
  expect(init?.credentials).toBe("same-origin");
  const incomplete = { ...complete, conversation: { ...complete.conversation, messages: [{}] } };
  expect(isWorkspace(incomplete)).toBe(false);
  fetcher.mockResolvedValue(json(incomplete));
  await expect(readWorkspace(fixture(), a, fetcher)).rejects.toThrow("incomplete");
});

test("auth and changed conversation identities require explicit reconnection", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("Sign in", { status: 401 }));
  await expect(readWorkspace(fixture(), null, fetcher)).rejects.toBeInstanceOf(WorkspaceAuthError);
  const changed = fixture(); changed.conversation!.sessionId = 8;
  expect(sameConversation(fixture(), changed)).toBe(false);
  const otherRun = fixture(); otherRun.conversation!.resultRunId = 10;
  expect(sameConversation(fixture(), otherRun)).toBe(false);
});

test("conditional reads preserve an unchanged view without parsing a body, and still honor auth failures", async () => {
  const response = new Response(null, { status: 304, headers: { etag: '"revision-1"' } });
  const parse = vi.spyOn(response, "json");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  await expect(readWorkspace(fixture(), null, fetcher, { etag: '"revision-1"' })).resolves.toEqual({ kind: "unchanged", etag: '"revision-1"' });
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("if-none-match")).toBe('"revision-1"');
  expect(parse).not.toHaveBeenCalled();
  await expect(readWorkspace(fixture(), null, fetcher)).rejects.toThrow("incomplete");
  fetcher.mockResolvedValue(new Response(null, { status: 403 }));
  await expect(readWorkspace(fixture(), null, fetcher, { etag: '"revision-1"' })).rejects.toBeInstanceOf(WorkspaceAuthError);
});

test("receipt and forced reads omit the validator and keep the exact receipt identity", async () => {
  const complete = fixture(); complete.receipt = { request: a, received: true };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(complete), { headers: { etag: '"revision-2"' } }));
  await expect(readWorkspace(fixture(), a, fetcher, { etag: '"revision-1"' })).resolves.toEqual({ kind: "changed", workspace: complete, etag: '"revision-2"' });
  await readWorkspace(fixture(), null, fetcher, { etag: '"revision-1"', force: true });
  for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).has("if-none-match")).toBe(false);
  expect(String(fetcher.mock.calls[0]![0])).toContain(`request=${a}`);
});

async function workspaceProbe(initial = fixture()) {
  let current!: ReturnType<typeof useWorkspace>;
  let renders = 0;
  function Probe() { current = useWorkspace(initial); renders++; return null; }
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(createElement(Probe)));
  return { current: () => current, renders: () => renders };
}
const tagged = (workspace = fixture()) => new Response(JSON.stringify(workspace), { headers: { etag: '"revision-1"' } });
const unchanged = () => new Response(null, { status: 304, headers: { etag: '"revision-1"' } });

test("idle polling backs off to a bounded interval without replacing or rendering unchanged workspace", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(tagged()).mockImplementation(async () => unchanged());
  vi.stubGlobal("fetch", fetcher);
  const probe = await workspaceProbe();
  const view = probe.current().workspace, renders = probe.renders();
  for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000]) {
    const count = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
    expect(fetcher).toHaveBeenCalledTimes(count);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetcher).toHaveBeenCalledTimes(count + 1);
  }
  expect(probe.current().workspace).toBe(view);
  expect(probe.renders()).toBe(renders);
  const updated = fixture(); updated.crewTruncated = true;
  fetcher.mockResolvedValueOnce(tagged(updated));
  await act(async () => probe.current().check(true));
  expect(probe.current().workspace.crewTruncated).toBe(true);
  expect(new Headers(fetcher.mock.calls.at(-1)![1]?.headers).has("if-none-match")).toBe(false);
  const count = fetcher.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(fetcher).toHaveBeenCalledTimes(count + 1);
  await act(async () => root!.unmount()); root = null;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetcher).toHaveBeenCalledTimes(count + 1);
});

test("a page without a docked chat reads on the beat its latest read asks for, and never while hidden", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const page = (seconds: number): BrowserWorkspace => ({ ...fixture(), path: "/work", refreshUrl: "/work", conversation: null, pageHtml: "<h1>Tasks</h1>", refreshSeconds: seconds });
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => tagged(page(10))).mockImplementation(async () => unchanged());
  vi.stubGlobal("fetch", fetcher);
  await workspaceProbe(page(30));
  await act(async () => vi.advanceTimersByTimeAsync(29_999));
  expect(fetcher).toHaveBeenCalledTimes(0);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetcher).toHaveBeenCalledTimes(1);
  // Something started building: the next read comes 10 s later.
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fetcher).toHaveBeenCalledTimes(2);
  hidden.mockReturnValue(true);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("visibility refresh queues once behind an active read, pauses hidden/offline, and stops on auth expiry", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
    .mockImplementation(async () => tagged());
  vi.stubGlobal("fetch", fetcher);
  const probe = await workspaceProbe();
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => resolve(tagged()));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(new Headers(fetcher.mock.calls[1]![1]?.headers).has("if-none-match")).toBe(false);
  hidden.mockReturnValue(true);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetcher).toHaveBeenCalledTimes(2);
  hidden.mockReturnValue(false); online.mockReturnValue(false);
  await act(async () => { window.dispatchEvent(new Event("offline")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  online.mockReturnValue(true);
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(probe.current().stale).toBe(true);
  expect(new Headers(fetcher.mock.calls[2]![1]?.headers).has("if-none-match")).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test("pending receipt and lead work stay at five seconds and only the exact receipt settles the draft", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const sent = submitDraft(editDraft(emptyDraft(a), "Keep my message"));
  saveDraft(sessionStorage, scope, sent);
  const working = fixture(); working.conversation!.pendingTurnId = 10;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => tagged(working));
  vi.stubGlobal("fetch", fetcher);
  const probe = await workspaceProbe();
  for (let i = 0; i < 3; i++) await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(probe.current().draft.pending?.request).toBe(a);
  for (const [url, init] of fetcher.mock.calls) {
    expect(String(url)).toContain(`request=${a}`);
    expect(new Headers(init?.headers).has("if-none-match")).toBe(false);
  }
  const received = { ...working, receipt: { request: a, received: true } };
  fetcher.mockResolvedValueOnce(tagged(received));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(probe.current().draft.pending).toBeNull();
  fetcher.mockImplementation(async () => unchanged());
  const count = fetcher.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(fetcher).toHaveBeenCalledTimes(count + 3);
});

test("a send during a conditional read queues its receipt read without another POST or overlapping GET", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  let resolve!: (response: Response) => void;
  let reads = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    if (init?.method === "POST") return json({ ok: true });
    reads++;
    if (reads === 2) return new Promise(done => { resolve = done; });
    const next = fixture();
    if (reads === 3) next.receipt = { request: a, received: true };
    return tagged(next);
  });
  vi.stubGlobal("fetch", fetcher);
  const probe = await workspaceProbe();
  await act(async () => probe.current().edit("Review this result"));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  await act(async () => probe.current().send({ preventDefault() {} } as Parameters<ReturnType<typeof useWorkspace>["send"]>[0]));
  expect(reads).toBe(2);
  expect(probe.current().draft.pending?.request).toBe(a);
  await act(async () => resolve(unchanged()));
  expect(reads).toBe(3);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  const [url, init] = fetcher.mock.calls.at(-1)!;
  expect(String(url)).toContain(`request=${a}`);
  expect(new Headers(init?.headers).has("if-none-match")).toBe(false);
  expect(probe.current().draft.pending).toBeNull();
});

test("a changed session stops refreshes and retains the old view and unsent draft until reconnect", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  saveDraft(sessionStorage, scope, editDraft(emptyDraft(a), "Preserve this draft"));
  const changed = fixture(); changed.conversation!.sessionId = 8;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(tagged(changed));
  vi.stubGlobal("fetch", fetcher);
  const original = fixture(), probe = await workspaceProbe(original);
  expect(probe.current().workspace).toBe(original);
  expect(probe.current().stale).toBe(true);
  expect(probe.current().draft.text).toBe("Preserve this draft");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); await probe.current().check(true); });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

async function renderHtml(html: string, immutable = false) {
  if (!root) { const node = document.createElement("div"); document.body.append(node); root = createRoot(node); }
  await act(async () => root!.render(createElement(GuardedHtml, { html, immutable })));
}

test("same result run retains its exact native form, feedback and listeners on refresh", async () => {
  await renderHtml('<form id="comment-form"><input name="request" value="old"><textarea name="note"></textarea></form>', true);
  const original = document.getElementById("comment-form");
  const note = document.querySelector("textarea")!; note.value = "Keep the error recovery visible";
  await renderHtml('<form id="comment-form"><input name="request" value="new"><textarea name="note"></textarea></form>', true);
  expect(document.getElementById("comment-form")).toBe(original);
  expect(document.querySelector("textarea")?.value).toBe("Keep the error recovery visible");
  expect(document.querySelector<HTMLInputElement>('[name="request"]')?.value).toBe("old");
});

test("native initialization is delivered to window after all guarded fragments are inserted", async () => {
  const observations: boolean[] = [];
  const initialized = () => observations.push(document.querySelector("#native-result") !== null && document.querySelector("#native-plan") !== null);
  window.addEventListener("standing-orders:workspace-rendered", initialized);
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(createElement("div", {},
    createElement(GuardedHtml, { html: '<section id="native-plan">Plan</section>' }),
    createElement(GuardedHtml, { html: '<section id="native-result">Result</section>', immutable: true }),
  )));
  window.removeEventListener("standing-orders:workspace-rendered", initialized);
  expect(observations).toEqual([true]);
});

test("a changed approval preserves entered credentials but blocks stale consent", async () => {
  const form = (digest: string) => `<section data-approval="${digest}"><form class="approve-form"><input type="password" name="token"><button type="submit">Approve and start</button></form></section>`;
  await renderHtml(form("first"));
  const password = document.querySelector("input")!; password.value = "entered-password"; password.focus();
  await renderHtml(form("changed"));
  expect(document.querySelector("input")).toBe(password);
  expect(password.value).toBe("entered-password");
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(document.body.textContent).toContain("The plan changed.");
});

test("focused native drafts are preserved and deferred non-form updates apply after focus leaves", async () => {
  await renderHtml('<label>Decision note<input name="note" value="old"></label>');
  const field = document.querySelector("input")!; field.focus();
  await renderHtml('<p>Decision recorded</p>');
  expect(document.querySelector("input")).toBe(field);
  await act(async () => field.blur());
  expect(document.querySelector("input")).toBeNull();
  expect(document.body.textContent).toContain("Decision recorded");
});

test("command search keeps exact admitted destinations and filters task state", () => {
  const workspace = fixture();
  workspace.projects = [{ name: "Docs", path: "/repo/docs", href: "/work?project=%2Frepo%2Fdocs", knowledgeHref: "/settings/knowledge?repo=%2Frepo%2Fdocs" }];
  workspace.crew = [{ id: "task-a", title: "Improve recovery", project: "/repo/docs", state: "ready-to-check", label: "Ready to check", tone: "ready", href: "/chat?task=task-a", resultHref: "/chat?task=task-a&result=9", action: null }];
  expect(workspaceCommands(workspace, " DOCS ")).toEqual([{ label: "Docs", detail: "Project", href: "/work?project=%2Frepo%2Fdocs" }]);
  expect(workspaceCommands(workspace, "ready")).toEqual([{ label: "Improve recovery", detail: "Ready to check", href: "/chat?task=task-a&result=9" }]);
  expect(workspaceCommands(workspace, "missing")).toEqual([]);
});

test("command shortcut opens outside editors and stays absent on sensitive pages", async () => {
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  const workspace = fixture(); workspace.sensitive = false;
  await act(async () => root!.render(createElement(CommandMenu, { workspace })));
  const editor = document.createElement("textarea"); document.body.append(editor); editor.focus();
  await act(async () => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); });
  expect(document.querySelector("[data-workspace-command]")).toBeNull();
  editor.blur();
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => root!.render(createElement(CommandMenu, { workspace: { ...workspace, sensitive: true } })));
  expect(document.querySelector("[data-workspace-command]")).toBeNull();
  expect(node.textContent).toBe("");
});
