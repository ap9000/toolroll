/** Ship and Release progress on the task page (task-views.ts): the overall answer comes from what actually happened,
 * never from which rows happen to be there. */
import { describe, expect, test } from "vitest";
import { releaseStepsViewOf, shipViewOf } from "./task-views.js";
import type { ReleaseStepRow } from "../store.js";

const NOW = new Date("2026-11-02T10:30:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const step = (name: string, from: number, to: number | null, state: ReleaseStepRow["state"] = to === null ? "running" : "done"): ReleaseStepRow =>
  ({ step: name, state, startedAt: at(from), endedAt: to === null ? null : at(to), detail: null });
const progress = (steps: ReleaseStepRow[], stopped: { step: string; message: string; at: string } | null = null) =>
  ({ tag: "v0.9.87", version: "0.9.87", pr: 290, startedAt: steps[0]?.startedAt ?? at(30), updatedAt: at(0), steps, stopped, building: null as { run: number; startedAt: string } | null });

describe("Ship", () => {
  test("the overall status is the observation's own: a failing observation never reads passed", () => {
    const ship = shipViewOf({ githubRepo: "a/b", prNumber: 9, headSha: "abc1234def", observedAt: at(0), observed: "failing",
      checks: [{ name: "test", workflow: "unit", state: "passed", startedAt: at(3), completedAt: at(2), url: null }] }, NOW)!;
    expect(ship.state).toBe("failed");
    expect(ship.summary).toBe("Checks are failing on GitHub");
  });

  test("a closed or merged pull request's `none` observation never reads passed, whatever its old rows say", () => {
    const ship = shipViewOf({ githubRepo: "a/b", prNumber: 9, headSha: "abc1234def", observedAt: at(0), observed: "none",
      checks: [{ name: "test", workflow: "unit", state: "passed", startedAt: at(3), completedAt: at(2), url: null }] }, NOW)!;
    expect(ship.state).toBe("none");
    expect(ship.summary).not.toMatch(/passed/);
  });
});

describe("Release progress", () => {
  const later = ["complete", "quiet", "deploy", "link", "ci", "merge", "tree", "tag", "publish", "homebrew"];
  test("a carried release (it starts at its check) that finished reads Released, not Starting", () => {
    const view = releaseStepsViewOf(progress([step("check", 30, 25), ...later.map((name, index) => step(name, 24 - index, 23 - index))]), NOW)!;
    expect(view.state).toBe("done");
    expect(view.headline).toBe("Released 0.9.87");
    expect(view.rows.map(row => row.name)[0]).toBe("Release check");
  });

  test("a merge is not a release: merged with tag and publication still to come reads where it stands, never Released", () => {
    const view = releaseStepsViewOf(progress([step("deploy", 20, 18), step("ci", 10, 8), step("merge", 7, 6)]), NOW)!;
    expect(view.state).toBe("running");
    expect(view.headline).toBe("Merge into main done · the next step starts on its own");
    // Steps with no record are never painted as done: not between recorded ones, not after them.
    expect(view.rows.find(row => row.name === "Point the CLI at it")).toMatchObject({ st: "q", sub: "not recorded" });
    expect(view.rows.filter(row => ["Tag", "Publish to npm", "Homebrew"].includes(row.name)).every(row => row.st === "q")).toBe(true);
    // Published but Homebrew not yet recorded: still not Released.
    expect(releaseStepsViewOf(progress([step("merge", 9, 8), step("tag", 8, 7), step("publish", 7, 6)]), NOW)!.state).toBe("running");
  });

  test("a stop stays a stop, and a running step says which", () => {
    expect(releaseStepsViewOf(progress([step("gate", 9, 8), step("approval", 8, 7), step("check", 7, 6, "failed")], { step: "check", message: "1 test failed.", at: at(6) }), NOW)!)
      .toMatchObject({ state: "failed", headline: "Stopped at Release check" });
    expect(releaseStepsViewOf(progress([step("gate", 9, 8), step("approval", 8, 7), step("check", 7, null)]), NOW)!.headline).toBe("Release check · Step 3 of 13");
  });

  test.each([
    ["a build running since a stop at Approval", [step("gate", 9, 8), step("approval", 8, 7, "failed")], { run: 3327, startedAt: at(5) }],
    ["a build running since the check failed", [step("gate", 9, 8), step("approval", 8, 7), step("check", 7, 6, "failed")], { run: 3327, startedAt: at(5) }],
    ["a build running since a later step failed", [step("check", 9, 8), step("complete", 8, 7), step("deploy", 7, 6, "failed")], { run: 3327, startedAt: at(5) }],
    ["a release resumed past a stop, with its step left failed", [step("gate", 9, 8), step("approval", 8, 7, "failed"), step("check", 6, null)], null],
  ])("the panel says where it stands now: %s", (_, steps, building) => {
    const view = releaseStepsViewOf({ ...progress(steps), building }, NOW)!;
    expect(view).toMatchObject({ state: "running", stopped: null, at: { step: "check" } });
    expect(view.headline).toMatch(/^Release check · Step \d+ of \d+$/);
    expect(view.rows.find(row => row.name === "Release check")?.st).toBe("run");
    expect(view.rows.filter(row => row.st === "bad")).toEqual([]);
    expect(view.rows.filter(row => ["Deploy to this Mac", "Homebrew"].includes(row.name)).every(row => row.st === "q")).toBe(true);
  });
});
