/**
 * Save as branch for interactive agent threads (flexible-save.ts, everyday 9 B1), against real git repositories: a
 * local project with no pull requests takes a thread's committed work as `toolroll/code-<id>` through the controlled
 * import (every check in quarantine first; a refused import moves no ref), only for the thread's owner at their current
 * generation and with the caller's proof held, never while a turn runs; the words name the exact git merge; a later
 * Ship follows from the saved branch; and removing the thread's copy keeps the branch the person saved.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareFlexibleThread, removeFlexibleThread, type FlexibleThreadPaths, type FlexibleThreadRow } from "./flexible-thread.js";
import { saveFlexibleBranch } from "./flexible-save.js";
import { flexibleShipTerms, shipFlexible } from "./flexible-ship.js";
import { enableFlexible, proposedFlexibleTerms } from "./flexible.js";
import { addApprover } from "./scope.js";
import { allowWhereUnfenced } from "./unfenced-test-support.js";
import { savePublishing } from "./pull-request-flow.js";
import { register } from "./runner.js";
import type { Store } from "./store.js";
import { tgit, threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";

const switched = vi.hoisted(() => ({ on: true }));
vi.mock("./flexible-available.js", async original => ({ ...await original<typeof import("./flexible-available.js")>(), flexibleAvailable: () => switched.on }));

const NOW = new Date("2026-11-25T12:00:00.000Z");
let world: ThreadWorld, store: Store, token: string;
let thread: FlexibleThreadRow, paths: FlexibleThreadPaths;

beforeEach(async () => {
  switched.on = true;
  world = threadWorld();
  store = allowWhereUnfenced(world.store);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  token = alex.token;
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  const proposed = proposedFlexibleTerms(store, world.project, "alex");
  if (!proposed.ok) throw new Error(proposed.message);
  const on = enableFlexible(store, { repo: world.project, by: "alex", proof: "password-now", shownDigest: proposed.digest, now: NOW });
  if (!on.ok) throw new Error(on.message);
  const made = await prepareFlexibleThread(store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  ({ thread, paths } = made);
});
afterEach(() => { store.close(); rmSync(world.dir, { recursive: true, force: true }); });

function commit(files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(paths.repo, name, ".."), { recursive: true });
    writeFileSync(join(paths.repo, name), text);
    tgit(paths.repo, "add", "-f", "--", name);
  }
  tgit(paths.repo, "commit", "-qm", "thread work");
  return tgit(paths.repo, "rev-parse", "HEAD");
}
const branch = () => `toolroll/code-${thread.id}`;
const branchAt = (): string | null => { try { return tgit(world.project, "rev-parse", "--verify", "--quiet", `refs/heads/${branch()}`); } catch { return null; } };
const generation = (name = "alex") => store.accountOf(name)!.generation;
const save = (as: { name?: string; generation?: number; prove?: () => boolean } = {}) =>
  saveFlexibleBranch(store, { thread: thread.id, by: { name: as.name ?? "alex", generation: as.generation ?? generation(as.name ?? "alex") }, now: NOW, prove: as.prove ?? (() => true) });
const rows = () => store.handle.prepare("SELECT seq, state, reason, json_extract(terms_json, '$.kind') AS kind FROM flexible_ship ORDER BY seq").all().map(row => ({ ...row }));

describe("Save as branch", () => {
  test("a local project takes the thread's work as its branch, with the exact merge to run; again is a no-op; more work moves it", async () => {
    const candidate = commit({ "math.js": "export const square = n => n * n;\n" });
    const saved = await save();
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, already: false, branch: branch(), candidate, seq: 1, changedPaths: ["math.js"] });
    expect(branchAt()).toBe(candidate);
    const head = tgit(world.project, "symbolic-ref", "--short", "HEAD");
    if (saved.ok) expect(saved.next).toBe(`To put it on ${head}: \`git -C ${world.project} merge --ff-only ${branch()}\`.`);
    expect(rows()).toEqual([{ seq: 1, state: "imported", reason: null, kind: "flexible-save" }]);
    // The same commit again: nothing new is recorded or moved.
    expect(await save()).toMatchObject({ ok: true, already: true, seq: null });
    expect(rows()).toHaveLength(1);
    const next = commit({ "math.js": "export const square = n => n * n;\nexport const cube = n => n ** 3;\n" });
    expect(await save()).toMatchObject({ ok: true, already: false, seq: 2, candidate: next });
    expect(branchAt()).toBe(next);
    // The person's merge really fast-forwards.
    tgit(world.project, "merge", "--ff-only", branch());
    expect(tgit(world.project, "rev-parse", "HEAD")).toBe(next);
  });

  test("the project's branch moved since the thread started: the words say so and give a real merge", async () => {
    commit({ "math.js": "x\n" });
    tgit(world.project, "commit", "-qm", "moved on");
    const saved = await save();
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.next).toMatch(/moved since the thread started, so it won't fast-forward\. To merge it: `git -C .* merge toolroll\/code-/);
  });

  test("only the owner, at their current generation, with the caller's proof held; never while a turn runs; nothing moves on a refusal", async () => {
    commit({ "math.js": "x\n" });
    expect(await save({ name: "sam" })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(await save({ generation: generation() + 1 })).toMatchObject({ ok: false, reason: "stale-generation" });
    expect(await save({ prove: () => false })).toMatchObject({ ok: false, reason: "stale-generation" });
    const at = NOW.toISOString();
    store.handle.prepare(`INSERT INTO thread_turn (id, thread, seq, repo, owner, owner_generation, terms_id, terms_digest, level, provider, model, billing,
      request_key, holder, admitted_at, utc_day, status, started_at) VALUES (?, ?, 1, ?, 'alex', 1, 1, 'd', 'supervised', 'claude', 'sonnet', 'subscription', 'k', 'h', ?, ?, 'running', ?)`)
      .run("c".repeat(32), thread.id, world.project, at, at.slice(0, 10), at);
    expect(await save()).toMatchObject({ ok: false, reason: "thread-running" });
    expect(rows()).toEqual([]);
    expect(branchAt()).toBeNull();
  });

  test("a commit the import refuses (a secret) moves no ref, and the save is recorded refused", async () => {
    commit({ "config.js": `const key = "${["AKIA", "Q7ZK", "M3XW", "P9TR", "B2NV"].join("")}";\n` });
    const saved = await save();
    expect(saved).toMatchObject({ ok: false, reason: "import-refused", check: "secret" });
    expect(branchAt()).toBeNull();
    expect(rows()).toEqual([{ seq: 1, state: "refused", reason: "secret", kind: "flexible-save" }]);
  });

  test("saving needs no switch (a person recovering past work), and a later Ship follows from the saved branch", async () => {
    commit({ "a.txt": "one\n" });
    switched.on = false;
    expect(await save()).toMatchObject({ ok: true, seq: 1 });
    switched.on = true;
    register(store, { name: "worker-1", host: "test", capacity: 4, repos: [world.project], now: NOW, newToken: () => "tok-worker-1" });
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", NOW);
    store.setVerifyCommand({ repo: world.project, command: "test -f README.md", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    savePublishing(store, { repo: world.project, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", { mergeMethod: "squash", mergeWhenGreen: true }, NOW);
    const shown = await flexibleShipTerms(store, { thread: thread.id, by: "alex" });
    if (!shown.ok) throw new Error(shown.message);
    expect(shown.terms.seq).toBe(2);
    const shipped = await shipFlexible(store, { thread: thread.id, by: "alex", proof: { kind: "password-now", password: token }, shownDigest: shown.digest, shownKey: shown.summary.key, now: NOW });
    expect(shipped, JSON.stringify(shipped)).toMatchObject({ ok: true, seq: 2 });
  });

  test("removing the thread's copy keeps the branch the person saved", async () => {
    const candidate = commit({ "a.txt": "one\n" });
    expect(await save()).toMatchObject({ ok: true });
    const removed = await removeFlexibleThread(store, { id: thread.id, by: "alex", now: NOW });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(branchAt()).toBe(candidate);
    expect(await save()).toMatchObject({ ok: false, reason: "thread-removed" });
  });
});
