import { describe, test, expect } from "vitest";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import { familyStartOf, freshBaseFor, taskBaseOf, wholeChangeBaseOf, type GitRead } from "./task-base.js";

const T0 = new Date("2026-10-12T16:00:00.000Z");
const OLD = "55caab73".padEnd(40, "0");
const MAIN = "9d087efe".padEnd(40, "1");
const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };

const seeded = () => {
  const store = openStore(":memory:");
  register(store, { name: "builder-1", host: "test", now: T0 });
  for (const id of ["t-1", "t-rev"]) {
    store.createTask({ id, title: id }, T0);
    store.placeTask(store.refFor("built-in", id).id, "/repo");
  }
  return store;
};

describe("fresh base, the task's view", () => {
  test("names the branch's recorded base, then the base a move to current main left for the next attempt", () => {
    const store = seeded();
    const ref = store.refFor("built-in", "t-1").id;
    const git: GitRead = (_cwd, args) => {
      return args[0] === "symbolic-ref" ? "main" : args[2] === `${OLD}..refs/heads/main` ? "2" : "0"; };
    expect(taskBaseOf(store, "t-1", git)).toBeNull();

    const run = store.startRun({ taskRef: ref, leaseId: "l-1", runner: "builder-1", branch: "toolroll/t-1", worktree: "/pool/t-1", ...legacy, now: T0 });
    store.stampRun(run, { baseRevision: OLD });
    expect(taskBaseOf(store, "t-1", git)).toEqual({ base: OLD, branch: "toolroll/t-1", main: "main", behind: 2, words: "Base 55caab73 · Behind main by 2 commits" });

    store.recordBranchBaseMove(ref, "toolroll/t-1", OLD, MAIN, T0);
    expect(taskBaseOf(store, "t-1", git)).toMatchObject({ base: MAIN, behind: 0, words: "Base 9d087efe · Up to date with main" });
    // Git that cannot answer leaves the base on its own, never a guessed count.
    expect(taskBaseOf(store, "t-1", () => null)).toMatchObject({ base: MAIN, main: null, behind: null, words: "Base 9d087efe" });
    store.close();
  });

  test("an ordinary attempt asks for current main; a revision keeps the head of the attempt it revises", () => {
    const store = seeded();
    const ref = store.refFor("built-in", "t-1").id;
    expect(freshBaseFor(store, "t-1", "toolroll/t-1", "main")).toEqual({ freshBase: { main: "main", recordedBase: null } });
    const run = store.startRun({ taskRef: ref, leaseId: "l-1", runner: "builder-1", branch: "toolroll/t-1", worktree: "/pool/t-1", ...legacy, now: T0 });
    store.stampRun(run, { baseRevision: OLD });
    expect(freshBaseFor(store, "t-1", "toolroll/t-1", "main")).toEqual({ freshBase: { main: "main", recordedBase: OLD } });

    store.handle.prepare("UPDATE task_ref SET revision_of = 't-1' WHERE external_id = 't-rev'").run();
    expect(freshBaseFor(store, "t-rev", "toolroll/t-rev", "main")).toEqual({});
    expect(freshBaseFor(store, "t-rev", "toolroll-plan/t-rev", "main")).toEqual({});
    store.close();
  });

  test("a revision's base is its family's original start on main, never the rejected head it builds on (everyday-9 A1)", () => {
    const store = seeded();
    const ref = store.refFor("built-in", "t-1").id, rev = store.refFor("built-in", "t-rev").id;
    const HEAD1 = "aaaaaaaa".padEnd(40, "2");
    const first = store.startRun({ taskRef: ref, leaseId: "l-1", runner: "builder-1", branch: "toolroll/t-1", worktree: "/pool/t-1", ...legacy, now: T0 });
    store.stampRun(first, { baseRevision: OLD });
    store.handle.prepare("UPDATE task_ref SET revision_of = 't-1' WHERE external_id = 't-rev'").run();
    const second = store.startRun({ taskRef: rev, leaseId: "l-2", runner: "builder-1", branch: "toolroll/t-rev", worktree: "/pool/t-rev", ...legacy, now: T0 });
    store.stampRun(second, { baseRevision: HEAD1 });
    expect(familyStartOf(store, ref)).toBeNull();
    expect(wholeChangeBaseOf(store, ref, "toolroll/t-1")).toBe(OLD);
    expect(familyStartOf(store, rev)).toBe(OLD);
    expect(wholeChangeBaseOf(store, rev, "toolroll/t-rev")).toBe(OLD);
    const git: GitRead = (_cwd, args) => args[0] === "symbolic-ref" ? "main" : args[2] === `${OLD}..refs/heads/main` ? "1" : "0";
    expect(taskBaseOf(store, "t-rev", git)).toMatchObject({ base: OLD, family: true, behind: 1,
      words: "Whole change since 55caab73 (includes earlier attempts' work that's still in it) · Behind main by 1 commit" });
    // Another project's task never lends its start.
    store.handle.prepare("UPDATE task_ref SET repo = '/elsewhere' WHERE external_id = 't-1'").run();
    expect(familyStartOf(store, rev)).toBeNull();
    store.close();
  });
});
