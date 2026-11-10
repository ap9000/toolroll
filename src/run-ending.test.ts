/** How a run ended, asked one way (run-ending.ts): both spellings of "interrupted" read the same wherever a check shows
 * or classes a run, and the roads that recover a draft keep to the spelling written today. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { agentFactsFor, agentGroupOf } from "./agents-board.js";
import { agentsLiveOf } from "./agents-live.js";
import { acquire, release } from "./claim.js";
import { endedInterrupted, wasInterrupted } from "./run-ending.js";
import { register } from "./runner.js";
import { openStore } from "./store.js";

test("either spelling is an interruption; no other ending is", () => {
  expect(wasInterrupted({ outcome: "failed", reason: "interrupted" })).toBe(true);
  expect(wasInterrupted({ outcome: "interrupted", reason: null })).toBe(true);
  expect(wasInterrupted({ outcome: "interrupted" })).toBe(true);
  for (const outcome of ["built", "failed", "refused", "parked", "no-change", null]) {
    expect(wasInterrupted({ outcome, reason: outcome === null ? "interrupted" : "timeout" })).toBe(false);
  }
  // A reason alone says nothing: only a failure carries it.
  expect(wasInterrupted({ outcome: "built", reason: "interrupted" })).toBe(false);
});

test("the recovery roads read only the spelling written today", () => {
  expect(endedInterrupted({ outcome: "failed", reason: "interrupted" })).toBe(true);
  expect(endedInterrupted({ outcome: "interrupted", reason: "interrupted" })).toBe(false);
  expect(endedInterrupted({ outcome: "failed", reason: "no-handoff" })).toBe(false);
});

test("an interrupted run shows as stopped on the live grid and the board, in either spelling; a failure still shows as failed", () => {
  const store = openStore(":memory:");
  try {
    const now = new Date("2026-11-09T12:00:00.000Z");
    register(store, { name: "mac", host: "t", capacity: 9, repos: ["/a"], now, newToken: () => "tok" });
    const ended = (id: string, end: (run: number) => void): number => {
      store.createTask({ id, title: id }, now);
      const ref = store.refFor("built-in", id).id;
      store.placeTask(ref, "/a");
      const took = acquire(store, ref, "mac", { now, token: "tok", newLeaseId: () => `lease-${id}`, ttlMs: 3_600_000 });
      if (!took.ok) throw new Error(took.reason);
      const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "mac", branch: id, worktree: `/w/${id}`, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: "m", chosen: "legacy" }, now });
      end(run);
      release(store, `lease-${id}`, now);
      return run;
    };
    const today = ended("today", run => store.finishRun(run, { outcome: "failed", reason: "interrupted", now }));
    const old = ended("old", run => store.finishRun(run, { outcome: "interrupted", now }));
    const failed = ended("failed", run => store.finishRun(run, { outcome: "failed", reason: "timeout", now }));

    const tiles = new Map(agentsLiveOf(store, now, { canSee: () => true, localRunner: "mac" }).map(tile => [tile.runId, tile.state]));
    expect(tiles.get(today)).toBe("stopped");
    expect(tiles.get(old)).toBe("stopped");
    expect(tiles.get(failed)).toBe("failed");

    const label = (run: number): string => agentGroupOf(agentFactsFor(store, run, { repos: null }, "alex")!, store.runActivity(run).at, now).label;
    expect(label(today)).toBe("Stopped");
    expect(label(old)).toBe("Stopped");
    expect(label(failed)).toBe("Failed");
  } finally { store.close(); }
});

test("no other file spells the check out: each one asks run-ending.ts", () => {
  const src = import.meta.dirname;
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []);
  const spelled = /\b(outcome|reason)\b[^;\n]{0,40}===\s*["']interrupted["']/;
  const found = files(src).flatMap(file => readFileSync(file, "utf8").split("\n").filter(line => spelled.test(line)).map(() => file.slice(src.length + 1)));
  // check-failure.ts tells an interruption from a refused candidate after endedInterrupted has already answered.
  expect(found.sort()).toEqual(["check-failure.ts", "run-ending.ts", "run-ending.ts"]);
});
