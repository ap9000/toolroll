// @vitest-environment happy-dom
/** The sidebar's project states (docs/plans/agents-cockpit.md §2): each project with its state and counts in words, the
 * open project's live or asking tasks beneath it, and a summary snapshot read strictly. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { NO_COUNTS } from "../agent-state-words.js";
import type { BrowserCrewItem, BrowserProjectState, BrowserWorkspace } from "../browser-workspace.js";
import { ProjectStates, projectCountWords, readProjectStates } from "./app.js";

const state = (path: string, over: Partial<BrowserProjectState["counts"]>, top: BrowserProjectState["state"]): BrowserProjectState =>
  ({ path, state: top, counts: { ...NO_COUNTS, ...over } });
const item = (id: string, project: string, label: string, tone: BrowserCrewItem["tone"], extra: Partial<BrowserCrewItem> = {}): BrowserCrewItem =>
  ({ id, title: `Task ${id}`, project, state: "working", label, tone, href: `/t/${id}`, resultHref: null, action: null, updatedAt: "2026-10-05T10:00:00.000Z", ...extra });
const workspace = (crew: BrowserCrewItem[]) => ({
  projects: [{ name: "shop", path: "/r/shop", href: "/work?project=%2Fr%2Fshop", knowledgeHref: "" }, { name: "ops", path: "/r/ops", href: "/work?project=%2Fr%2Fops", knowledgeHref: "" }],
  crew, crewTruncated: false }) as unknown as BrowserWorkspace;

test("counts read strongest first, zeros left out, and an idle project says nothing", () => {
  expect(projectCountWords(state("/r/shop", { working: 2, "needs-you": 1, done: 1 }, "needs-you"))).toBe("1 needs you · 2 working · 1 done");
  expect(projectCountWords(state("/r/shop", { "needs-you": 3 }, "needs-you"))).toBe("3 need you");
  expect(projectCountWords(state("/r/ops", {}, "idle"))).toBe("");
});

test("each project shows its state; only the open one lists its live and asking tasks", () => {
  const states = [state("/r/shop", { "needs-you": 1, working: 1 }, "needs-you"), state("/r/ops", {}, "idle")];
  const crew = [item("ask", "/r/shop", "Needs you", "attention"), item("run", "/r/shop", "Building", "live", { activity: { what: "Ran tests", at: "2026-10-05T10:00:00.000Z", worker: "online" } }),
    item("queued", "/r/shop", "Queued", "neutral"), item("done", "/r/shop", "Complete", "done"), item("elsewhere", "/r/ops", "Building", "live")];
  const page = renderToStaticMarkup(createElement(ProjectStates, { workspace: workspace(crew), states, current: "/r/shop" }));
  expect([...page.matchAll(/data-project-state="([a-z-]+)"/g)].map(m => m[1])).toEqual(["needs-you", "idle"]);
  expect(page).toContain("1 needs you · 1 working");
  expect([...page.matchAll(/href="\/t\/([a-z]+)"/g)].map(m => m[1])).toEqual(["ask", "run"]);
  expect(page).toContain("Ran tests");
  expect(renderToStaticMarkup(createElement(ProjectStates, { workspace: workspace(crew), states, current: null }))).not.toContain('href="/t/');
});

test("a summary snapshot is read strictly: anything malformed changes nothing", () => {
  const good = [state("/r/shop", { working: 1 }, "working")];
  expect(readProjectStates(JSON.stringify(good))).toEqual(good);
  for (const bad of ["", "{}", "[1]", JSON.stringify([{ path: "/r", state: "on-fire", counts: NO_COUNTS }]),
    JSON.stringify([{ path: "/r", state: "idle", counts: { ...NO_COUNTS, working: -1 } }]), JSON.stringify([{ path: 3, state: "idle", counts: NO_COUNTS }])])
    expect(readProjectStates(bad)).toBeNull();
  expect(readProjectStates(undefined)).toBeNull();
});
