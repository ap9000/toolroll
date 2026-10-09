/**
 * A stale approval is a deterministic refusal (setup review): the first
 * real install retried one every pass and wrote a thousand refused runs in
 * minutes. Now the task is HELD under a backoff the approval door lifts,
 * the operator is paged once per approval, and the next pass leaves it
 * alone.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import type { Runner } from "./builder.js";
import { routeDigestOf } from "./phase-routing.js";
import { digestOf } from "./scope.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-09-03T00:00:00.000Z");

describe("a stale approval holds the task instead of retrying every pass", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const payload = () => JSON.parse(lines.join("\n"));
  const neverCalled: Runner = async () => {
    throw new Error("no agent should ever spawn on a stale approval");
  };
  const run = (argv: string[], now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: neverCalled });
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-stale-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("refused once, held, paged once; a fresh approval lifts the hold and closes the page", async () => {
    const runnerToken = "tok-builder-1";
    {
      const store = openStore(db);
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => runnerToken });
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
      store.close();
    }
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    await run(["task", "add", "dedupe listings", "--id", "dedupe", "--repo", repo, "--json"]);
    await run(["task", "scope", "dedupe", "--goal", "Dedupe the listings", "--acceptance", "Duplicate listings no longer appear.|manual-review", "--json"]);
    const before = openStore(db);
    const digest = before.getScope("dedupe")?.digest as string;
    before.close();
    await run(["task", "approve", "dedupe", "--as", "alex", "--token", approverToken, "--digest", digest, "--yes", "--json"]);
    expect(payload().ok).toBe(true);

    // The routing moves under the approval: what was signed no longer
    // matches. Since v47 a ROUTED approval seals its build leg and cannot
    // be rerouted by configuration at all (see the describe below), so this
    // exercises the pre-routing row: the approval is rewritten to the shape
    // a v46 file carries — no route era, a profile-only digest — and then
    // the installation's build row changes underneath it.
    {
      const store = openStore(db);
      const scope = store.getScope("dedupe")!;
      const legacyDigest = digestOf({ goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, budgetMicrousd: scope.budgetMicrousd, acceptance: scope.acceptance }, scope.approvedProfile ?? null);
      store.raw().prepare("UPDATE task_scope SET route_era = NULL, proposed_route_json = NULL, approved_route_json = NULL, digest = ?, approved_digest = ? WHERE task_id = 'dedupe'").run(legacyDigest, legacyDigest);
      store.setPhaseConfig("installation", "build", "claude", "opus", "test", new Date("2026-09-02T00:00:00.000Z"));
      store.close();
    }
    const tick = (now: Date) => run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"], now);

    const first = await tick(new Date(T0.getTime() + 60_000));
    expect(first).toBe(EXIT.refused);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "dedupe", outcome: "skipped", reason: "stale-approval" }));

    const store = openStore(db);
    const ref = store.refFor("built-in", "dedupe");
    // v48 integrity: the refusal happens BEFORE any row — no refused run
    // exists; the task is held and paged exactly as before.
    expect(store.runsFor(ref.id)).toHaveLength(0);
    const held = store.activeHolds(ref.id, new Date(T0.getTime() + 60_000));
    expect(held.some(one => one.ownerKind === "backoff" && one.reason.startsWith("stale-approval"))).toBe(true);
    const paged = store.listNotifications("pending").filter(one => one.kind === "stale-approval");
    expect(paged).toHaveLength(1);
    expect(paged[0]?.pushClass).toBe("attention");
    store.close();

    // The next pass leaves it alone: no second run, no second page.
    const second = await tick(new Date(T0.getTime() + 120_000));
    expect(second).toBe(EXIT.refused);
    const again = openStore(db);
    expect(again.runsFor(ref.id)).toHaveLength(0);
    expect(again.listNotifications("all").filter(one => one.kind === "stale-approval")).toHaveLength(1);
    again.close();

    // A pre-routing row cannot take a NEW yes (v48): an approval now names
    // exactly which agents run, and this row names none. The road is to
    // re-file the scope — routing it under today's agents — and approve THAT.
    const current = openStore(db);
    const legacyNow = current.getScope("dedupe")?.digest as string;
    current.close();
    await run(["task", "approve", "dedupe", "--as", "alex", "--token", approverToken, "--digest", legacyNow, "--yes", "--json"], new Date(T0.getTime() + 170_000));
    expect(payload()).toMatchObject({ ok: false, reason: "unrouted" });
    await run(["task", "scope", "dedupe", "--goal", "Dedupe the listings", "--acceptance", "Duplicate listings no longer appear.|manual-review", "--json"], new Date(T0.getTime() + 175_000));
    const refiled = openStore(db);
    const currentDigest = refiled.getScope("dedupe")?.digest as string;
    expect(refiled.getScope("dedupe")?.routeEra).not.toBeNull();
    refiled.close();
    await run(["task", "approve", "dedupe", "--as", "alex", "--token", approverToken, "--digest", currentDigest, "--yes", "--json"], new Date(T0.getTime() + 180_000));
    expect(payload().ok).toBe(true);
    const after = openStore(db);
    expect(after.activeHolds(ref.id, new Date(T0.getTime() + 180_000)).some(one => one.reason.startsWith("stale-approval"))).toBe(false);
    expect(after.listNotifications("pending").filter(one => one.kind === "stale-approval")).toHaveLength(0);
    after.close();
  });
});

describe("a sealed route governs dispatch (v47)", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const payload = () => JSON.parse(lines.join("\n"));
  const neverCalled: Runner = async () => {
    throw new Error("no agent should ever spawn here");
  };
  const run = (argv: string[], now: Date = T0, agent: Runner = neverCalled) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: agent });
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-routed-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("a provider the runner reports unavailable halts before any claim or run — nothing substitutes; a fresh READY report lets it dispatch on the sealed leg", async () => {
    const runnerToken = "tok-builder-1";
    {
      const store = openStore(db);
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => runnerToken });
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
      store.setPhaseTierConfig("installation", "build", "strong", "claude", "opus", "test", T0);
      store.close();
    }
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    await run(["task", "add", "harden payouts", "--id", "payouts", "--repo", repo, "--json"]);
    {
      // A large change: its route builds on the strong tier.
      const store = openStore(db);
      store.writeSizing(store.refFor("built-in", "payouts").id, { size: "large", risky: false, source: "person", reason: "set by alex" });
      store.close();
    }
    await run(["task", "scope", "payouts", "--goal", "Harden the payouts", "--acceptance", "c1: guarded | check", "--json"]);
    const before = openStore(db);
    const digest = before.getScope("payouts")?.digest as string;
    before.close();
    await run(["task", "approve", "payouts", "--as", "alex", "--token", approverToken, "--digest", digest, "--yes", "--json"]);
    expect(payload().ok).toBe(true);

    // The runner reports claude unavailable.
    {
      const store = openStore(db);
      store.recordProviderReadiness("builder-1", [{ provider: "claude", state: "unavailable", reason: "`claude` is not installed on this runner's PATH", probe: "version" }], T0);
      store.close();
    }
    const tick = (now: Date, agent: Runner = neverCalled) => run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"], now, agent);
    await tick(new Date(T0.getTime() + 60_000));
    const halted = payload().dispatched.find((one: { id: string }) => one.id === "payouts");
    expect(halted).toMatchObject({ outcome: "skipped", reason: "provider-unavailable" });
    expect(halted.detail).toContain("claude is reported unavailable on builder-1");
    expect(halted.detail).toContain("nothing substitutes");
    {
      const store = openStore(db);
      const ref = store.refFor("built-in", "payouts");
      expect(store.runsFor(ref.id)).toHaveLength(0);
      expect(store.hasLiveClaim(ref.id, new Date(T0.getTime() + 60_000))).toBe(false);
      // The route projection says HALTED with the runner's own words.
      store.close();
    }
    await run(["task", "route", "payouts"]);
    expect(lines.join("\n")).toContain("build  claude · opus  [recommended · strong] — UNAVAILABLE — `claude` is not installed");

    // A fresh report clears it; the sealed STRONG leg (opus) dispatches
    // even though the routine configuration says sonnet — the sealed route
    // is the authority, never today's configuration.
    {
      const store = openStore(db);
      store.recordProviderReadiness("builder-1", [{ provider: "claude", state: "unknown", reason: "installed; no non-spending login check exists", probe: "version" }], new Date(T0.getTime() + 90_000));
      store.setPhaseConfig("installation", "build", "claude", "haiku", "test", new Date(T0.getTime() + 90_000));
      store.setPhaseConfig("installation", "plan", "claude", "haiku", "test", new Date(T0.getTime() + 90_000)); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "haiku", "test", new Date(T0.getTime() + 90_000));
      store.close();
    }
    const spawned: string[][] = [];
    const seeingAgent: Runner = async (_file, args) => {
      spawned.push([...args]);
      return { ...OK, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "nothing to do", session_id: "s1" }) };
    };
    await tick(new Date(T0.getTime() + 120_000), seeingAgent);
    const dispatched = payload().dispatched.find((one: { id: string }) => one.id === "payouts");
    expect(dispatched.reason).not.toBe("stale-approval");
    expect(dispatched.reason).not.toBe("provider-unavailable");
    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned[0]?.[spawned[0].indexOf("--model") + 1]).toBe("opus");
    const store = openStore(db);
    const ref = store.refFor("built-in", "payouts");
    const build = store.runsFor(ref.id).find(one => one.role === "builder")!;
    expect(build).toMatchObject({ provider: "claude", model: "opus" });
    // Provenance: the run names the sealed route and its exact leg.
    expect(store.runRoute(build.id)).toMatchObject({ phase: "build", provider: "claude", model: "opus", chosen: "recommended", routeDigest: routeDigestOf(store.approvedRouteOf("payouts")!) });
    store.close();
  });
});
