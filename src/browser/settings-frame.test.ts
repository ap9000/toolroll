// @vitest-environment happy-dom
/** The settings frame's sidebar (docs/plans/settings-revamp.md S2): a sensitive page keeps the same slots as any other
 * page — the live parts become static text, with no states, no forms and no summary room — and the project picker
 * names the session's open project. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { NO_COUNTS } from "../agent-state-words.js";
import type { BrowserWorkspace } from "../browser-workspace.js";
import { currentProjectOf, Navigation } from "./app.js";

const shop = { name: "shop", path: "/r/shop", href: "/work?project=%2Fr%2Fshop", knowledgeHref: "/settings/knowledge?repo=%2Fr%2Fshop" };
const ops = { name: "ops", path: "/r/ops", href: "/work?project=%2Fr%2Fops", knowledgeHref: "/settings/knowledge?repo=%2Fr%2Fops" };
const workspace = (over: Partial<BrowserWorkspace>): BrowserWorkspace => ({
  version: 1, path: "/settings/retention", title: "Retention", user: "alex", csrf: "c", sensitive: false, refreshUrl: "/settings/retention", receipt: null,
  projects: [shop, ops], crew: [], crewTruncated: false, conversation: null, focus: null, result: null, catchUpHtml: "", controlsHtml: "", notices: [], pageHtml: "",
  navigation: [{ label: "Settings", href: "/settings", active: true }], openProject: "/r/shop", ...over,
});
const live = workspace({
  projectStates: [{ path: "/r/shop", name: "shop", href: shop.href, state: "needs-you", counts: { ...NO_COUNTS, "needs-you": 2 }, tasks: [], more: 0, asks: [] }],
  fresh: { minutes: 9, forget: "/session/forget-password" },
});
const sensitive = workspace({ sensitive: true });

/** The sidebar's rows outside its live slots, as the journey's probe reads them. */
function rows(markup: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return [...host.querySelectorAll("a[href], summary, button")].filter(el => el.closest("[data-live]") === null)
    .map(el => `${el.tagName.toLowerCase()} ${el.getAttribute("href") ?? ""} ${(el.textContent ?? "").trim()}`);
}

test("a sensitive page keeps the same slots: project names as text, no live states, no forms", () => {
  const ordinary = renderToStaticMarkup(createElement(Navigation, { workspace: live }));
  const quiet = renderToStaticMarkup(createElement(Navigation, { workspace: sensitive }));
  expect(rows(quiet)).toEqual(rows(ordinary));
  // The live slot holds the project names, static, on the sensitive page; the states and counts only on the other.
  expect(quiet).toMatch(/data-live="true" data-sidebar-slot="projects"/);
  expect(quiet).not.toContain("data-project-state=");
  expect(quiet).toContain("so-project-states--inert");
  expect(ordinary).toContain('data-project-state="needs-you"');
  // No form in the sensitive sidebar but sign-out; the remembered-password chip's Forget is only on the other.
  expect(quiet.match(/<form/g)?.length).toBe(1);
  expect(quiet).not.toContain("forget-password");
  expect(ordinary).toContain("forget-password");
});

test("the picker names the open project; a page about another project names that one", () => {
  expect(currentProjectOf(workspace({}))?.name).toBe("shop");
  expect(currentProjectOf(workspace({ path: "/settings/tools?repo=%2Fr%2Fops" }))?.name).toBe("ops");
  expect(currentProjectOf(workspace({ openProject: null }))).toBeUndefined();
  expect(currentProjectOf(workspace({ openProject: "/r/gone" }))).toBeUndefined();
  expect(renderToStaticMarkup(createElement(Navigation, { workspace: sensitive }))).toMatch(/<option value="\/work\?project=%2Fr%2Fshop" selected="">shop<\/option>/);
});
