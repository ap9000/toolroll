// @vitest-environment happy-dom
/** The sidebar's project states (docs/plans/agents-cockpit.md §2): each project with its state and counts in words, the
 * open project's live, asking, failed or unread tasks beneath it (and how many more), work with no project as its own
 * entry, one snapshot shared by every part of the page, and a summary snapshot read strictly. */
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { NO_COUNTS } from "../agent-state-words.js";
import type { BrowserProjectState, BrowserRailTask, BrowserWorkspace } from "../browser-workspace.js";
import { ProjectStates, projectCountWords, readProjectStates, SUMMARY_REJOIN_MS, useProjectStates } from "./app.js";

const task = (id: string, state: BrowserRailTask["state"], line = "Ran tests"): BrowserRailTask => ({ id, title: `Task ${id}`, href: `/t/${id}`, state, line });
const project = (path: string | null, over: Partial<BrowserProjectState["counts"]>, top: BrowserProjectState["state"], tasks: BrowserRailTask[] = [], more = 0): BrowserProjectState =>
  ({ path, name: path === null ? "No project" : path.split("/").pop()!, href: path === null ? "/work" : `/work?project=${encodeURIComponent(path)}`, state: top, counts: { ...NO_COUNTS, ...over }, tasks, more });

test("counts read strongest first, zeros left out, and an idle project says nothing", () => {
  expect(projectCountWords(project("/r/shop", { working: 2, "needs-you": 1, done: 1 }, "needs-you"))).toBe("1 needs you · 2 working · 1 done");
  expect(projectCountWords(project("/r/shop", { "needs-you": 3 }, "needs-you"))).toBe("3 need you");
  expect(projectCountWords(project("/r/ops", {}, "idle"))).toBe("");
});

test("each project shows its state; the open one lists its tasks, unread ones included, and how many more", () => {
  const states = [project("/r/shop", { "needs-you": 1, working: 1, done: 1 }, "needs-you", [task("ask", "needs-you", "Needs you"), task("run", "working"), task("new", "done", "Done")], 4),
    project("/r/ops", { working: 1 }, "working", [task("elsewhere", "working")]), project(null, { "needs-you": 1 }, "needs-you", [task("loose", "needs-you", "Needs you")])];
  const page = renderToStaticMarkup(createElement(ProjectStates, { states, current: "/r/shop" }));
  expect([...page.matchAll(/data-project-state="([a-z-]+)"/g)].map(m => m[1])).toEqual(["needs-you", "working", "needs-you"]);
  expect(page).toContain("1 needs you · 1 working · 1 done");
  // The open project's rows and the unplaced entry's; never another project's.
  expect([...page.matchAll(/href="\/t\/([a-z]+)"/g)].map(m => m[1])).toEqual(["ask", "run", "new", "loose"]);
  expect([...page.matchAll(/data-rail-task="([a-z-]+)"/g)].map(m => m[1])).toEqual(["needs-you", "working", "done", "needs-you"]);
  expect(page).toContain("Ran tests");
  expect(page).toContain(">4 more<");
  expect(page).toContain("No project");
});

test("a summary snapshot is read strictly: anything malformed is no snapshot", () => {
  const good = [project("/r/shop", { working: 1 }, "working", [task("a", "working")], 2), project(null, { failed: 1 }, "failed")];
  expect(readProjectStates(JSON.stringify(good))).toEqual(good);
  const bad = (over: Record<string, unknown>) => JSON.stringify([{ ...project("/r", {}, "idle"), ...over }]);
  for (const raw of ["", "{}", "[1]", bad({ state: "on-fire" }), bad({ counts: { ...NO_COUNTS, working: -1 } }), bad({ path: 3 }), bad({ href: "javascript:alert(1)" }),
    bad({ more: -1 }), bad({ tasks: [{ ...task("a", "working"), href: "https://elsewhere" }] }), bad({ tasks: [{ ...task("a", "working"), state: "x" }] }), bad({ tasks: "no" })])
    expect(readProjectStates(raw)).toBeNull();
  expect(readProjectStates(undefined)).toBeNull();
});

/** A stand-in for the browser's EventSource: the page's one stream, whose events the test sends. */
class FakeStream {
  static all: FakeStream[] = [];
  static readonly CLOSED = 2;
  readyState = 1;
  readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
  constructor(readonly url: string) { FakeStream.all.push(this); }
  addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  close() { this.readyState = FakeStream.CLOSED; }
  send(name: string, data: Record<string, unknown>) { for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) }); }
}

test("every part of the page shows one snapshot: a newer one reaches the chip and a sheet opened later; gone clears both", async () => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeStream;
  const workspace = { sensitive: false, projectStates: [project("/r/shop", { "needs-you": 1 }, "needs-you")] } as unknown as BrowserWorkspace;
  const seen: Record<string, number | null> = {};
  const Part = ({ name }: { name: string }) => { const states = useProjectStates(workspace); seen[name] = states === null ? null : states[0]!.counts["needs-you"]; return null; };
  const root = createRoot(document.createElement("div"));
  await act(async () => { root.render(createElement(Part, { name: "chip" })); });
  await act(async () => { await Promise.resolve(); });
  expect(seen["chip"]).toBe(1);
  const stream = FakeStream.all.find(one => one.url.includes("room=summary") && one.readyState !== FakeStream.CLOSED)!;
  expect(stream).toBeDefined();
  await act(async () => { stream.send("change", { room: "summary", at: JSON.stringify([project("/r/shop", { "needs-you": 2 }, "needs-you")]) }); });
  expect(seen["chip"]).toBe(2);
  // A sheet opened after it shows the same newer snapshot, not the page's first read; still one stream.
  await act(async () => { root.render(createElement(Fragment, null, createElement(Part, { name: "chip" }), createElement(Part, { name: "sheet" }))); });
  expect([seen["chip"], seen["sheet"]]).toEqual([2, 2]);
  expect(FakeStream.all.filter(one => one.readyState !== FakeStream.CLOSED)).toHaveLength(1);
  await act(async () => { stream.send("gone", { room: "summary" }); });
  expect([seen["chip"], seen["sheet"]]).toEqual([null, null]);
  await act(async () => { root.unmount(); });
});

test("a large snapshot fits one live frame with every count kept: tasks become more, then quiet projects fold together", async () => {
  const { boundProjectSummary, SUMMARY_BUDGET } = await import("../browser-workspace.js");
  // The frame as the summary room writes it, in UTF-8 bytes: inside the stream's 32 KiB limit, always.
  const frame = (value: unknown) => new TextEncoder().encode(`event: change\ndata: ${JSON.stringify({ room: "summary", at: JSON.stringify(value), revision: "v1:1234567890" })}\n\n`).length;
  const size = (value: unknown) => { expect(frame(value)).toBeLessThan(32_768); return frame(value); };
  const total = (rows: BrowserProjectState[]) => rows.reduce((sum, one) => sum + one.counts.working + one.counts["needs-you"], 0);
  // Wide characters: three bytes each on the wire, and quotes that grow when escaped.
  const long = "漢字\"かな".repeat(40);
  const many = Array.from({ length: 20 }, (_, p) => project(`/r/p${p}`, { working: 6 }, "working",
    Array.from({ length: 6 }, (_, t) => ({ ...task(`t${p}-${t}`, "working", long), title: long }))));
  const bounded = boundProjectSummary(many);
  expect(size(bounded)).toBeLessThanOrEqual(SUMMARY_BUDGET);
  expect(bounded).toHaveLength(20);
  // Every task is listed or counted.
  expect(bounded.reduce((sum, one) => sum + one.tasks.length + one.more, 0)).toBe(120);
  expect(readProjectStates(JSON.stringify(bounded))).toEqual(bounded);
  // Far more projects than fit: the quietest fold into one entry whose counts carry theirs.
  const huge = Array.from({ length: 2_000 }, (_, p) => project(`/r/${p}-${"y".repeat(60)}`, p === 0 ? { "needs-you": 1 } : { working: 1 }, p === 0 ? "needs-you" : "working"));
  const folded = boundProjectSummary(huge);
  expect(size(folded)).toBeLessThanOrEqual(SUMMARY_BUDGET);
  expect(total(folded)).toBe(total(huge));
  expect(folded.at(-1)).toMatchObject({ others: true, href: "/projects" });
  expect(folded.some(one => one.counts["needs-you"] === 1 && !one.others)).toBe(true);
  expect(readProjectStates(JSON.stringify(folded))).toEqual(folded);
});

test("after gone, the page joins the summary room again on its own", async () => {
  vi.useFakeTimers();
  try {
    FakeStream.all = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource = FakeStream;
    const workspace = { sensitive: false, projectStates: [project("/r/shop", {}, "idle")] } as unknown as BrowserWorkspace;
    const Part = () => { useProjectStates(workspace); return null; };
    const root = createRoot(document.createElement("div"));
    await act(async () => { root.render(createElement(Part)); });
    await act(async () => { await Promise.resolve(); });
    const live = () => FakeStream.all.filter(one => one.readyState !== FakeStream.CLOSED && one.url.includes("room=summary"));
    expect(live()).toHaveLength(1);
    await act(async () => { live()[0]!.send("gone", { room: "summary" }); });
    await act(async () => { await Promise.resolve(); });
    expect(live()).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(SUMMARY_REJOIN_MS); });
    await act(async () => { await Promise.resolve(); });
    expect(live()).toHaveLength(1);
    await act(async () => { root.unmount(); });
  } finally { vi.useRealTimers(); }
});

test("the tab's title carries the count while something needs this person, and only then", async () => {
  const { titleWithCount, needsYouTotal } = await import("./app.js");
  expect(titleWithCount("Agents — Toolroll", 2)).toBe("(2) Agents — Toolroll");
  expect(titleWithCount("(2) Agents — Toolroll", 5)).toBe("(5) Agents — Toolroll");
  expect(titleWithCount("(5) Agents — Toolroll", 0)).toBe("Agents — Toolroll");
  expect(titleWithCount("Agents", 140)).toBe("(99+) Agents");
  expect(needsYouTotal([project("/a", { "needs-you": 2 }, "needs-you"), project(null, { "needs-you": 1 }, "needs-you")])).toBe(3);
  expect(needsYouTotal(null)).toBe(0);
});

test("a hidden tab keeps only the summary room: the count stays live, and nothing else is watched", async () => {
  FakeStream.all = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeStream;
  const { useLiveRoom } = await import("./live.js");
  let hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  const Parts = () => { useLiveRoom("summary", () => {}, true); useLiveRoom("agent:7", () => {}); return null; };
  const root = createRoot(document.createElement("div"));
  await act(async () => { root.render(createElement(Parts)); });
  await act(async () => { await Promise.resolve(); });
  const open = () => FakeStream.all.filter(one => one.readyState !== FakeStream.CLOSED).map(one => decodeURIComponent(one.url));
  expect(open()).toEqual(["/live?room=agent:7&room=summary"]);
  hidden = true;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(open()).toEqual(["/live?room=summary"]);
  hidden = false;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(open()).toEqual(["/live?room=agent:7&room=summary"]);
  await act(async () => { root.unmount(); });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});
