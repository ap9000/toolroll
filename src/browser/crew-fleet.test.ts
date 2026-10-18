// @vitest-environment happy-dom
/** The Crew rail and the fleet line in the sidebar stay readable at twenty running tasks, and their counts are honest. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { BrowserCrewItem, BrowserWorkspace } from "../browser-workspace.js";
import { CREW_RUNNING_SHOWN, FleetStatus, crewGroupOf } from "./app.js";

const item = (id: string, label: string, tone: BrowserCrewItem["tone"], extra: Partial<BrowserCrewItem> = {}): BrowserCrewItem =>
  ({ id, title: `Task ${id}`, project: null, state: "working", label, tone, href: `/t/${id}`, resultHref: null, action: null, updatedAt: "2026-10-05T10:00:00.000Z", ...extra });
const workspace = (crew: BrowserCrewItem[], crewTruncated = false) => ({ crew, crewTruncated }) as unknown as BrowserWorkspace;
const fleet = (crew: BrowserCrewItem[], truncated = false) => renderToStaticMarkup(createElement(FleetStatus, { workspace: workspace(crew, truncated) }));

test("a task needing a person, an agent at work and one waiting land in their own Crew group", () => {
  expect([item("a", "Needs you", "attention"), item("b", "Failed", "problem"), item("c", "Ready for review", "ready"),
    item("d", "Building", "live"), item("e", "Queued", "neutral")].map(crewGroupOf)).toEqual(["needs", "needs", "needs", "running", "waiting"]);
});

test("the fleet line counts what the Crew holds, says + when the Crew is trimmed, and reports the worker", () => {
  const running = Array.from({ length: 20 }, (_, n) => item(`r${n}`, "Building", "live", { activity: { what: "Ran tests", at: "2026-10-05T10:00:00.000Z", worker: "online" } }));
  const page = fleet([item("a", "Needs you", "attention"), item("b", "Failed", "problem"), item("q", "Queued", "neutral"), ...running, item("z", "Complete", "done")]);
  expect([...page.matchAll(/data-fleet="([a-z]+)">(?:<svg[^]*?<\/svg>)?([^<]+)</g)].map(m => [m[1], m[2]]))
    .toEqual([["needs", "2 need you"], ["running", "20 running"], ["waiting", "1 waiting"], ["worker", "Worker online"]]);
  expect(fleet([item("a", "Needs you", "attention")], true)).toContain("1+ need you");
  expect(fleet([item("r", "Building", "live", { activity: { what: "Ran tests", at: "2026-10-05T10:00:00.000Z", worker: "offline" } })])).toContain("Worker offline");
  // Nothing active: no line at all, never a row of zeros.
  expect(fleet([item("z", "Complete", "done")])).toBe("");
  expect(CREW_RUNNING_SHOWN).toBe(5);
});
