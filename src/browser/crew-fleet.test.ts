// @vitest-environment happy-dom
/** The Crew (the Ask panel's second tab) groups tasks by who they wait on. */
import { expect, test } from "vitest";
import type { BrowserCrewItem } from "../browser-workspace.js";
import { CREW_RUNNING_SHOWN, crewGroupOf } from "./app.js";

const item = (id: string, label: string, tone: BrowserCrewItem["tone"], extra: Partial<BrowserCrewItem> = {}): BrowserCrewItem =>
  ({ id, title: `Task ${id}`, project: null, state: "working", label, tone, href: `/t/${id}`, resultHref: null, action: null, updatedAt: "2026-10-05T10:00:00.000Z", ...extra });

test("a task needing a person, an agent at work and one waiting land in their own Crew group", () => {
  expect([item("a", "Needs you", "attention"), item("b", "Failed", "problem"), item("c", "Ready for review", "ready"),
    item("d", "Building", "live"), item("e", "Queued", "neutral")].map(crewGroupOf)).toEqual(["needs", "needs", "needs", "running", "waiting"]);
});

test("the Crew folds running work after its first rows", () => {
  expect(CREW_RUNNING_SHOWN).toBe(5);
});
