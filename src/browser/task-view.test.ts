/** The task page's thread (views/task-view.tsx): an entry with no words shows none. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { BrowserTaskThreadItem, BrowserTaskView } from "../browser-workspace.js";
import { TaskView } from "./views/task-view.js";

const reply = (key: string, title: string, text: string | null): BrowserTaskThreadItem =>
  ({ key, at: "2026-10-02T10:00:00.000Z", kind: "reply", who: "person", author: "You", title, text, link: null, html: "", more: null });
const view = (thread: BrowserTaskThreadItem[]): BrowserTaskView => ({
  kind: "task", id: "t-1", title: "Guard the payout path", project: null, scout: false, tabs: [], version: null,
  status: null, statusHtml: "", approval: "", lead: [], questions: "", facts: [], sections: [], manage: [], cancel: null, thread,
});

describe("the task thread", () => {
  test("an entry with no text shows its line and nothing else: never an empty bubble", () => {
    const page = renderToStaticMarkup(createElement(TaskView, { view: view([
      reply("repair", "Asked for a repair", ""),
      reply("blank", "Note to the agent", "  \n "),
      reply("none", "Answered", null),
      reply("words", "Asked for changes", "Also refuse a zero payout."),
    ]), details: false }));
    expect(page.match(/bg-user-bubble/g)).toHaveLength(1);
    expect(page).toContain("Also refuse a zero payout.</p>");
    expect(page).toContain(">Asked for a repair</span>");
  });
});
