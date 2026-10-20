/**
 * A running attempt's files, on this computer (docs/plans/agents-cockpit.md phase E): the agent view offers the cd
 * command and Show in Finder only for a checkout proved local (live, this machine's runner, inside its pool); Show in
 * Finder proves it again and asks Finder to reveal exactly that path; a stale path, a viewer and a bearer are refused;
 * nothing is ever launched in it.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { attemptKeyOf, recordAgentTurn } from "./agent-board.js";
import type { BrowserAgentsView } from "./browser-workspace.js";
import { canReveal, cdCommandOf, localCheckoutOf, REVEAL_COMMAND, revealInFinder } from "./checkout-proof.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore, type Store } from "./store.js";
import { presented, T0, workspaceOf } from "../test/serve-kit.js";

let store: Store, server: Server, base: string, dir: string, pool: string, repo: string, token: string;
const revealed: string[] = [];
/** What the stand-in Finder answers (true: shown). */
let finderAnswers = true;
beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-reveal-")));
  pool = join(dir, "pool"); repo = join(dir, "shop"); mkdirSync(pool); mkdirSync(repo);
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  token = alex.token;
  register(store, { name: "builder-1", host: "here", capacity: 4, repos: [repo], now: new Date(), newToken: () => "tok-builder-1" });
  revealed.length = 0;
  finderAnswers = true;
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo], clock: () => new Date(), localRunner: "builder-1", poolRoot: pool,
    revealPath: path => { revealed.push(path); return finderAnswers; } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const login = async () => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
/** A running build whose checkout is a real directory in this machine's pool. */
function running(id: string, worktree = join(pool, `wt-${id}`)): number {
  mkdirSync(worktree, { recursive: true });
  store.createTask({ id, title: `Fix ${id}` }, T0);
  const ref = store.refFor("built-in", id, "ours").id;
  store.placeTask(ref, repo);
  const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
  if (!taken.ok) throw new Error("claim");
  const run = store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1", branch: `b-${id}`, worktree, now: new Date(), ...presented(store, ref, "builder") });
  store.saveWorktree({ path: worktree, repo, branch: `b-${id}`, runner: "builder-1", taskRef: ref, createdAt: new Date().toISOString(), leasedAt: new Date().toISOString(), releasedAt: null, verified: true, leaseEpoch: 1 } as never);
  recordAgentTurn(store, { run, attemptKey: attemptKeyOf(store, run)!, state: "busy", at: new Date() });
  return run;
}

test("the cd command is one single-quoted word, whatever the path holds", () => {
  expect(cdCommandOf("/pool/wt one")).toBe("cd '/pool/wt one'");
  expect(cdCommandOf("/pool/it's here")).toBe(`cd '/pool/it'\\''s here'`);
});

test("a local running checkout is offered and revealed exactly; a finished one is refused; a bearer can't", async () => {
  const cookie = await login();
  const run = running("t-files");
  const view = workspaceOf(await (await fetch(`${base}/agents?run=${run}`, { headers: { cookie } })).text()).view as BrowserAgentsView;
  expect(view.selected?.checkout).toEqual({ path: join(pool, "wt-t-files"), cd: `cd '${join(pool, "wt-t-files")}'`, reveal: `/r/${run}/reveal` });
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/settings`, { headers: { cookie } })).text())![1]!;
  const reveal = (headers: Record<string, string>) => fetch(`${base}/r/${run}/reveal`, { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ csrf, return: "agents" }).toString() });
  expect((await reveal({ cookie })).headers.get("location")).toBe(`/agents?run=${run}&said=revealed`);
  expect(revealed).toEqual([join(pool, "wt-t-files")]);
  // A bearer token never reaches it (a person's act in their own browser).
  expect((await reveal({ authorization: "Bearer so_not-a-real-token" })).status).not.toBe(303);
  // Once the attempt ends, nothing is offered and Finder is not asked.
  store.finishRun(run, { outcome: "built", committed: true, now: new Date() });
  expect((await reveal({ cookie })).headers.get("location")).toBe(`/agents?run=${run}&said=reveal-refused`);
  expect(revealed).toHaveLength(1);
  const after = workspaceOf(await (await fetch(`${base}/agents?run=${run}`, { headers: { cookie } })).text()).view as BrowserAgentsView;
  expect(after.selected?.checkout ?? null).toBeNull();
});

test("a checkout outside this machine's pool is never offered or revealed", async () => {
  const cookie = await login();
  const outside = join(dir, "elsewhere");
  const run = running("t-outside", outside);
  const view = workspaceOf(await (await fetch(`${base}/agents?run=${run}`, { headers: { cookie } })).text()).view as BrowserAgentsView;
  expect(view.selected?.checkout ?? null).toBeNull();
});

const csrfFor = async (cookie: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/settings`, { headers: { cookie } })).text())![1]!;
const revealAs = async (cookie: string, run: number) => fetch(`${base}/r/${run}/reveal`, { method: "POST", redirect: "manual",
  headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: await csrfFor(cookie), return: "agents" }).toString() });

test("Finder is the system's own open, by absolute path, from /, with a minimal environment and one path argument; a failure is reported", async () => {
  const calls: { file: string; args: readonly string[]; options: { cwd: string; env: Record<string, string>; timeout: number } }[] = [];
  expect(await revealInFinder("/pool/wt one; rm -rf ~", (file, args, options, done) => { calls.push({ file, args, options }); done(null); })).toBe(true);
  expect(calls).toEqual([{ file: "/usr/bin/open", args: ["-R", "/pool/wt one; rm -rf ~"], options: { cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 } }]);
  expect(REVEAL_COMMAND).toBe("/usr/bin/open");
  expect(await revealInFinder("/pool/x", (_file, _args, _options, done) => done(new Error("exit 1")))).toBe(false);
  expect(await revealInFinder("/pool/x", () => { throw new Error("spawn failed"); })).toBe(false);
  // Without a test's revealer, only a Mac offers it.
  expect(canReveal(false)).toBe(process.platform === "darwin");
  expect(canReveal(true)).toBe(true);
});

test("Finder's failure is said truthfully, never as shown", async () => {
  const cookie = await login();
  const run = running("t-fails");
  finderAnswers = false;
  expect((await revealAs(cookie, run)).headers.get("location")).toBe(`/agents?run=${run}&said=reveal-failed`);
});

test("a reassigned attempt, a run on another runner, the pool itself and a path outside it are each refused at Show in Finder", async () => {
  const cookie = await login();
  // Reassigned: the task's current claim is no longer this attempt's.
  const moved = running("t-moved");
  const lease = store.currentLiveLease.bind(store);
  vi.spyOn(store, "currentLiveLease").mockImplementation((ref, now) => lease(ref, now) === null ? null : "another-lease");
  expect((await revealAs(cookie, moved)).headers.get("location")).toBe(`/agents?run=${moved}&said=reveal-refused`);
  vi.restoreAllMocks();
  // The run names another runner while its worktree row names this one: inconsistent, so refused.
  const other = running("t-other");
  store.handle.prepare("UPDATE run SET runner = 'builder-2' WHERE id = ?").run(other);
  expect(localCheckoutOf(store, other, { runner: "builder-1", poolRoot: pool }, new Date())).toEqual({ ok: false, reason: "this attempt runs on another computer" });
  expect((await revealAs(cookie, other)).headers.get("location")).toBe(`/agents?run=${other}&said=reveal-refused`);
  // The pool directory itself is never a checkout.
  const root = running("t-root", pool);
  expect(localCheckoutOf(store, root, { runner: "builder-1", poolRoot: pool }, new Date()).ok).toBe(false);
  // Outside the pool: never revealed, even when asked directly.
  const outside = running("t-out", join(dir, "elsewhere"));
  expect((await revealAs(cookie, outside)).headers.get("location")).toBe(`/agents?run=${outside}&said=reveal-refused`);
  expect(revealed).toEqual([]);
});

test("a viewer can't ask Finder for anything", async () => {
  const run = running("t-viewer");
  const invite = store.mintInvite("viewer", "alex", new Date());
  const joined = await fetch(`${base}/join/${invite.token}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=casey&password=long-enough-pass" });
  expect(joined.status).toBeLessThan(400);
  const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "casey", token: "long-enough-pass" }), redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
  const answer = await revealAs(cookie, run);
  expect(answer.status).toBe(403);
  expect(revealed).toEqual([]);
});
