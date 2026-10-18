/** The Tasks list (views/tasks-view.tsx): a visible title with what needs you,
 * Needs you grouped by its ask first, waiting rows in a solid ink chip naming
 * the ask, every other row quiet, and usage out of the list's way. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { BrowserTasksView } from "../browser-workspace.js";
import { TasksView } from "./views/tasks-view.js";

type Row = BrowserTasksView["rows"][number];
const row = (id: string, ask: Row["ask"], group: Row["group"], label: string, tone: Row["status"]["tone"], chip: Row["chip"] = null): Row => ({
  id, title: `Task ${id}`, href: `/t/${id}`, project: null, age: "4h ago", status: { label, tone, token: "assignment-working" },
  ask, chip, group, action: { label: "Open", href: `/t/${id}` }, detail: null, problem: null, notes: [],
});
const tile = (key: string, name: string, window: string, percent: number, tone: "neutral" | "warning" | "danger" = "neutral") =>
  ({ key, name, window, value: String(percent), unit: "%", percent, detail: "Resets soon", tone, marks: [], title: null, href: null });
const view = (over: Partial<BrowserTasksView> = {}): BrowserTasksView => ({
  kind: "tasks", tabs: [{ label: "All", href: "/work", count: 5, active: true }, { label: "Needs you", href: "/work?view=needs-you", count: 3, active: false }],
  needsYou: 4,
  groups: [{ key: "decide", label: "Decide", count: 2 }, { key: "review", label: "Review", count: 1 }, { key: "unblock", label: "Unblock", count: 1 }, { key: "building", label: "Building", count: 1 }, { key: "rest", label: "Recent", count: 1 }],
  rows: [row("plan", "decide", "decide", "Needs you", "attention", "Plan"), row("result", "review", "review", "Ready for review", "ready", "Result"),
    row("offline", "unblock", "unblock", "Needs you", "attention", "Builder offline"), row("answer", "decide", "decide", "Needs you", "attention"),
    row("live", null, "building", "Building", "live"), row("old", null, "rest", "Stopped", "attention")],
  empty: null, pages: { first: null, next: null }, tools: [], newTask: { label: "New task", href: "/tasks/new" },
  limits: { tiles: [tile("claude:5h", "Claude", "5-hour", 48), tile("claude:week", "Claude", "Weekly", 83, "warning"), tile("codex:week", "Codex", "Weekly", 12)] },
  ...over,
});
const html = (one: BrowserTasksView) => renderToStaticMarkup(createElement(TasksView, { view: one }));

describe("the Tasks list", () => {
  test("a visible title says how many need you, and Needs you comes first, grouped by the ask", () => {
    const page = html(view());
    expect(page).toMatch(/<h1 class="[^"]*">Tasks<\/h1>/);
    expect(page).not.toContain("sr-only\">Tasks");
    expect(page).toMatch(/data-needs-you-count[^>]*><span[^>]*>4<\/span> need you/);
    const groups = [...page.matchAll(/data-task-group="([a-z]+)"/g)].map(match => match[1]);
    expect(groups).toEqual(["decide", "review", "unblock", "building", "rest"]);
    expect(page).toMatch(/<h2[^>]*><svg[^>]*data-glyph="decide"[^]*?<\/svg>Decide<span[^>]*>2<\/span><\/h2>/);
    // One plain list where the view isn't grouped.
    expect(html(view({ groups: null }))).not.toContain("data-task-group");
  });
});
