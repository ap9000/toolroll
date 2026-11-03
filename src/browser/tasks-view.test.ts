/** The Tasks list (views/tasks-view.tsx): what needs you first, grouped by its ask, then Running, Queued and
 * Finished; the Needs-you count is the one ink count, with the scope it covers; the Board view is the same index as
 * columns. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { BrowserTaskRow, BrowserTasksView } from "../browser-workspace.js";
import { TasksView } from "./views/tasks-view.js";

const row = (id: string, ask: BrowserTaskRow["ask"], group: BrowserTaskRow["group"], rank: number, word: BrowserTaskRow["word"]): BrowserTaskRow => ({
  id, title: `Task ${id}`, href: `/t/${id}`, project: null, age: "4h ago", status: { label: word.word, tone: "neutral", token: "assignment-working" },
  word, ask, chip: null, group, rank, action: ask === null ? null : { label: "Open", href: `/t/${id}` }, detail: null, problem: null, notes: [],
});
const view = (over: Partial<BrowserTasksView> = {}): BrowserTasksView => ({
  kind: "tasks", layout: "list", layouts: { list: "/work", board: "/work?layout=board" }, scope: "in payments-api",
  tabs: [{ key: "all", label: "All", href: "/work", count: 6, active: true }, { key: "needs-you", label: "Needs you", href: "/work?view=needs-you", count: 3, active: false },
    { key: "running", label: "Running", href: "/work?view=running", count: 1, active: false }, { key: "queued", label: "Queued", href: "/work?view=queued", count: 1, active: false },
    { key: "completed", label: "Finished", href: "/work?view=completed", count: 1, active: false }],
  needsYou: 3,
  groups: [{ key: "decide", label: "Decide", count: 1 }, { key: "review", label: "Review", count: 1 }, { key: "unblock", label: "Unblock", count: 1 }, { key: "building", label: "Building", count: 1 }, { key: "rest", label: "Recent", count: 2 }],
  rows: [row("old", null, "rest", 3, { word: "Complete", tone: "done" }), row("plan", "decide", "decide", 0, { word: "Plan", tone: "ask" }),
    row("result", "review", "review", 0, { word: "Result", tone: "ask" }), row("live", null, "building", 1, { word: "Building", tone: "live" }),
    row("offline", "unblock", "unblock", 0, { word: "Builder offline", tone: "ask" }), row("next", null, "rest", 2, { word: "Queued", tone: "" })],
  empty: null, pages: { first: null, next: null }, tools: [], newTask: { label: "New task", href: "/tasks/new" }, limits: null,
  ...over,
});
const html = (one: BrowserTasksView) => renderToStaticMarkup(createElement(TasksView, { view: one }));

describe("the Tasks list", () => {
  test("Needs you comes first, grouped by the ask, then Running, Queued and Finished; only Needs you's count is ink", () => {
    const page = html(view());
    const groups = [...page.matchAll(/data-task-group="([a-z]+)"/g)].map(match => match[1]);
    expect(groups).toEqual(["decide", "review", "unblock", "running", "queued", "finished"]);
    expect(page.match(/k-count ink/g)).toHaveLength(1);
    expect(page).toContain("3 need you in payments-api");
    // One plain list where the filter isn't grouped.
    expect(html(view({ groups: null }))).not.toContain("data-task-group");
  });

  test("the Board view shows the same rows as columns, Needs you's column marked", () => {
    const board = html(view({ layout: "board", board: [
      { key: "needs", label: "Needs you", count: 1, href: "/work?view=needs-you", empty: "Nothing needs you.", rows: [row("plan", "decide", "decide", 0, { word: "Plan", tone: "ask" })] },
      { key: "queued", label: "Queued", count: 0, href: "/work?view=queued", empty: "Nothing queued.", rows: [] },
    ] }));
    expect(board).toContain('class="k-col-h needs"');
    expect(board).toContain("Nothing queued.");
    expect(board).not.toContain("data-task-group");
  });

  test("a column with more than it shows says so and opens the rest; a filter over a part says it is a part", () => {
    const one = row("plan", "decide", "decide", 0, { word: "Plan", tone: "ask" });
    const board = html(view({ layout: "board", board: [{ key: "needs", label: "Needs you", count: 57, href: "/work?view=needs-you", empty: "Nothing needs you.", rows: [one] }] }));
    expect(board).toMatch(/data-column-more="needs"><a class="k-link" href="\/work\?view=needs-you">View all 57<\/a>/);
  });

  test("on a phone the list keeps New task (the dock's primary), the text filter and the task tools", () => {
    const page = html(view({ tools: [{ label: "Recipes", href: "/recipes" }] }));
    const phone = /<div class="k-tbp">([\s\S]*?)<\/div><p/.exec(page)?.[1] ?? "";
    expect(phone).toContain('class="k-filter"');
    expect(phone).toContain('aria-label="More task tools"');
    expect(page).toMatch(/<div class="k-dock"><div class="k-dock-primary"><a class="k-btn k-btn-primary"[^>]*href="\/tasks\/new"/);
  });
});
