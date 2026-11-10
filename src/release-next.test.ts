/**
 * `toolroll release <branch>` picks its own next act (plain-toolroll.md P2.6): two coordinators never act on one release;
 * each deployment phase has one action and a crash at any phase ends the same on the next run; a held release resumes
 * once per person's act.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { BEFORE_SWAP } from "./release-gate.js";
import { FORWARD_ONLY } from "./deploy-rescue.js";
import { deployActionOf, RELEASE_RESUMED_ACTION, resumeAllowedReleases, settleDeployment, takeReleaseRun, type SettleWorld } from "./release-next.js";
import { allowAutoPublish, holdAutoPublish } from "./release-auto.js";
import { fakePid } from "../test/fake-pid.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "so-relnext-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FIRST = fakePid(1), SECOND = fakePid(2), THIRD = fakePid(3);

describe("the run lock", () => {
  test("two coordinators: the second waits, naming the first, and stops at its limit", async () => {
    const first = await takeReleaseRun(dir, "rel", () => {}, { host: "one", pid: FIRST, alive: () => true });
    expect(first.ok).toBe(true);
    const said: string[] = [];
    let clock = 0;
    const second = await takeReleaseRun(dir, "rel", line => said.push(line), { host: "one", pid: SECOND, alive: () => true, sleep: async () => { clock += 10; }, now: () => clock, waitMs: 25 });
    expect(second).toEqual({ ok: false, holder: { host: "one", pid: FIRST } });
    expect(said).toEqual([`Waiting: another release of rel is running on one (process ${FIRST}).`]);
  });

  test("it goes on when the first finishes, and a process proved gone holds nothing", async () => {
    const first = await takeReleaseRun(dir, "rel", () => {}, { host: "one", pid: FIRST, alive: () => true });
    if (!first.ok) throw new Error("no lock");
    const waited = await takeReleaseRun(dir, "rel", () => {}, { host: "one", pid: SECOND, alive: () => true, sleep: async () => { first.release(); } });
    expect(waited.ok).toBe(true);
    const taken = await takeReleaseRun(dir, "rel", () => {}, { host: "one", pid: THIRD, alive: () => false });
    expect(taken.ok).toBe(true);
  });

  test("another computer's lock can't be proved gone from here", async () => {
    await takeReleaseRun(dir, "rel", () => {}, { host: "one", pid: FIRST });
    expect(await takeReleaseRun(dir, "rel", () => {}, { host: "two", pid: SECOND, alive: () => false, waitMs: 0 })).toMatchObject({ ok: false });
  });

  test("a coordinator gives back only its own lock", async () => {
    const first = await takeReleaseRun(dir, "rel", () => {}, { host: "one", pid: FIRST, alive: () => false });
    const second = await takeReleaseRun(dir, "rel", () => {}, { host: "one", pid: SECOND, alive: () => false });
    if (!first.ok || !second.ok) throw new Error("no lock");
    first.release();
    expect(existsSync(join(dir, "releases", "rel.running"))).toBe(true);
    second.release();
    expect(existsSync(join(dir, "releases", "rel.running"))).toBe(false);
  });
});

describe("each journal phase has one action", () => {
  const PHASES = ["stopping", "stopped", "migrating", "migrated", "start-failed", "backup-restored", "restored"];
  test("the table", () => {
    for (const phase of BEFORE_SWAP) expect(deployActionOf(phase), phase).toBe("lift-pause");
    for (const phase of FORWARD_ONLY) expect(deployActionOf(phase), phase).toBe("forward");
    for (const phase of PHASES) expect(deployActionOf(phase), phase).toBe("roll-back");
    for (const phase of ["released", "deployed"]) expect(deployActionOf(phase), phase).toBe("none");
    expect(deployActionOf(undefined)).toBe("refuse");
    // A word the table does not hold is never a roll-back.
    for (const word of ["no-such-phase", "Starting", "", "__proto__", 7, null, {}]) expect(deployActionOf(word), String(word)).toBe("refuse");
  });

  test("a step this version doesn't know is refused: nothing is rolled back, lifted or finished", async () => {
    for (const [phase, words] of [
      ["almost-started", "stopped at a step this version doesn't know (almost-started). Nothing was changed. Its own recovery can decide: `toolroll release --recover-deploy --yes`."],
      ["Starting", "doesn't know (not a plain word). Nothing was changed."],
      ["$(rm -rf ~)\n`x`", "doesn't know (not a plain word). Nothing was changed."],
      ["", "doesn't know (not a plain word). Nothing was changed."],
    ] as const) {
      const said: string[] = [];
      const world = worldAt(phase);
      const settled = await settleDeployment(world, line => said.push(line));
      expect(settled).toMatchObject({ ok: false, message: expect.stringContaining(words) });
      // Words from the journal reach the person only as a plain word.
      expect(!settled.ok && settled.message).not.toContain("rm -rf");
      expect(world.recover).not.toHaveBeenCalled();
      expect(said).toEqual([]);
    }
    // No phase at all, or one that is not text: the journal can't be read.
    for (const phase of [7, null, ["starting"]]) {
      const world = worldAt("stopped");
      world.rescue.journals = () => [{ stage: "/s/one", journal: { phase, id: "u1", builder: 1, priorRuntime: "a", nextRuntime: "b", database: "/db" } }];
      expect(await settleDeployment(world, () => {})).toEqual({ ok: false, message: "The deployment journal in /s/one can't be read. Nothing was changed." });
      expect(world.recover).not.toHaveBeenCalled();
    }
  });

  test("killed while the new service was starting goes forward too; a service already put back is still settled by recovery", async () => {
    const said: string[] = [];
    const starting = worldAt("starting");
    expect(await settleDeployment(starting, line => said.push(line))).toEqual({ ok: true });
    expect(starting.recover).not.toHaveBeenCalled();
    expect(said).toEqual(["Finishing the deployment that was under way."]);
    const restored = worldAt("restored");
    expect(await settleDeployment(restored, () => {})).toEqual({ ok: true });
    expect(restored.recover).toHaveBeenCalledTimes(1);
  });

  const worldAt = (phase: string | null, recover = vi.fn(async () => ({ ok: true as const }))): SettleWorld & { recover: typeof recover } => ({ recover,
    rescue: { database: "/db", stateDir: "/s", journals: () => [{ stage: "/s/one", journal: phase === null ? null : { phase, id: "u1", builder: 1, priorRuntime: "a", nextRuntime: "b", database: "/db" } }], runWorktree: () => "/w", recover },
    gate: { database: "/db", stateDir: "/nowhere", now: () => NOW, processes: () => [], open: () => { throw new Error("no"); }, servicePlists: () => [] } as never });

  test.each(["stopping", "stopped", "migrated", "start-failed"])("%s rolls back, and a crash mid-way converges: the same run again acts once more", async phase => {
    const said: string[] = [];
    const world = worldAt(phase);
    expect(await settleDeployment(world, line => said.push(line))).toEqual({ ok: true });
    expect(await settleDeployment(world, line => said.push(line))).toEqual({ ok: true });
    expect(world.recover).toHaveBeenCalledTimes(2);
    expect(said[0]).toBe("Put back the deployment that stopped half way.");
  });

  test("past the new service's start it goes forward: nothing is rolled back", async () => {
    const world = worldAt("healthy");
    expect(await settleDeployment(world, () => {})).toEqual({ ok: true });
    expect(world.recover).not.toHaveBeenCalled();
  });

  test("a journal that can't be read refuses, and so do two unfinished ones", async () => {
    expect(await settleDeployment(worldAt(null), () => {})).toMatchObject({ ok: false });
    const two = worldAt("stopped");
    two.rescue.journals = () => [{ stage: "/a", journal: { phase: "stopped" } }, { stage: "/b", journal: { phase: "stopped" } }];
    expect(await settleDeployment(two, () => {})).toMatchObject({ ok: false, message: expect.stringContaining("2 deployments") });
    expect(two.recover).not.toHaveBeenCalled();
  });

  test("a recovery that fails stops the release", async () => {
    const world = worldAt("stopped", vi.fn(async () => ({ ok: false as const, message: "still running" })) as never);
    expect(await settleDeployment(world, () => {})).toMatchObject({ ok: false });
  });
});

describe("a held release resumes itself", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(join(dir, "orders.db"));
    store.createTask({ id: "rel-task", title: "release" }, NOW);
    mkdirSync(join(dir, "releases"));
    writeFileSync(join(dir, "releases", "rel.json"), JSON.stringify({ version: 1, id: "j", github: "o/r", checkout: dir, branch: "rel", candidate: { sha: "a".repeat(40), tree: "b".repeat(40) }, packageName: "p", packageVersion: "1.0.0", tag: "v1.0.0", pr: 1, step: "tag",
      task: { id: "rel-task", scopeDigest: null }, approval: null, check: null, completion: null, deploy: null, ci: null, merge: { sha: "c".repeat(40), tree: null }, tagged: null, published: null, homebrew: null, intents: {}, stopped: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }));
  });
  afterEach(() => store.close());

  test("it waits for a person, then runs once per their act", async () => {
    const run = vi.fn(async () => {});
    holdAutoPublish(store, { taskId: "rel-task", why: "checks stopped passing", now: NOW });
    expect(await resumeAllowedReleases(store, dir, run, NOW)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(allowAutoPublish(store, { taskId: "rel-task", by: "owner", now: NOW }).ok).toBe(true);
    expect(await resumeAllowedReleases(store, dir, run, NOW)).toBe(1);
    expect(await resumeAllowedReleases(store, dir, run, NOW)).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = ?").get(RELEASE_RESUMED_ACTION)?.["n"]).toBe(1);
  });

  test("a release no person let go on never resumes", async () => {
    const run = vi.fn(async () => {});
    expect(await resumeAllowedReleases(store, dir, run, NOW)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
