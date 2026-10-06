/**
 * Closing out a run: when it ends, whatever is still in its process groups is stopped (SIGTERM, then SIGKILL after
 * the grace) and the ledger names it; never the live service, never a reused pid. Completing or cancelling a task
 * stops what still runs from its checkout. Real processes and real signals; the process listing is given (this
 * sandbox may refuse `ps`), built from what the processes report about themselves.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { run } from "./exec.js";
import { WorktreePool } from "./worktree.js";
import { COMPLETION_ACTION } from "./result-completion.js";
import { finishedCheckouts } from "./checkout-cleanup.js";
import { fakePid } from "../test/fake-pid.js";
import { checkoutTargets, closeOutCheckouts, closeOutRuns, closeoutTargets, parseCensus, processesIn, protectedProcesses, type ProcessRow } from "./run-closeout.js";

let dir: string, store: Store, repo: string;
const spawned: number[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-closeout-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  register(store, { name: "builder-1", host: "test", now: new Date() });
});
afterEach(() => {
  for (const pid of spawned.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Wait on the condition itself; the ceiling is generous because a loaded machine can take seconds to schedule or reap.
const until = async (done: () => boolean, ms = 30_000) => { const end = Date.now() + ms; while (!done() && Date.now() < end) await new Promise(next => setTimeout(next, 25)); return done(); };
const row = (pid: number, pgid: number, bornAt: number, name = "sleep"): ProcessRow => ({ pid, ppid: 1, pgid, bornAt, name, terminal: false });

test("the process listing is read with ages, groups and terminals, never arguments", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const node = fakePid(1), zsh = fakePid(2), helper = fakePid(3);
  const rows = parseCensus([
    `  ${node}     1   ${node} 1-02:03:04 ??       /usr/local/bin/node`,
    `  ${zsh}   ${node}   ${node}      00:07 ttys003  /bin/zsh`,
    `  ${helper}   ${node}   ${node}   02:00:07 ?        Google Chrome Helper`,
    "garbage",
  ].join("\n"), now);
  expect(rows).toEqual([
    { pid: node, ppid: 1, pgid: node, bornAt: now - (((1 * 24 + 2) * 60 + 3) * 60 + 4) * 1000, name: "node", terminal: false },
    { pid: zsh, ppid: node, pgid: node, bornAt: now - 7_000, name: "zsh", terminal: true },
    { pid: helper, ppid: node, pgid: node, bornAt: now - (2 * 3600 + 7) * 1000, name: "Google Chrome Helper", terminal: false },
  ]);
});

test("a run's targets: its processes and groups as they were seen, not a reused pid, never the live service", () => {
  const seen = 1_000_000;
  const provider = fakePid(1), joined = fakePid(2), reused = fakePid(3), member = fakePid(4), goneLeader = fakePid(5), serviceGroup = fakePid(6), serviceMate = fakePid(7);
  const census = [
    row(provider, provider, seen - 5_000),          // the provider, still there
    row(joined, provider, seen + 60_000),         // born later into its group: still the run's
    row(reused, reused, seen + 600_000),        // a pid the run saw, reused by a stranger since
    row(member, goneLeader, seen + 1_000),          // a member of a group whose leader is gone
    row(process.pid, serviceGroup, seen - 9_000, "node"), // the live service
    row(serviceMate, serviceGroup, seen, "node"),          // in the live service's group
  ];
  const witnesses = [
    { pid: provider, group: true, observedAt: seen }, { pid: reused, group: true, observedAt: seen },
    { pid: goneLeader, group: true, observedAt: seen }, { pid: process.pid, group: false, observedAt: seen }, { pid: serviceMate, group: false, observedAt: seen },
  ];
  expect(closeoutTargets(census, witnesses, protectedProcesses(census)).map(one => one.pid)).toEqual([provider, joined, member]);
});

test("from a finished checkout, only what a finished run started or an orphan is a target — never a deploy or a person's agent", () => {
  const seen = 1_000_000;
  const terminalApp = fakePid(1), shell = fakePid(2), agent = fakePid(3), toolShell = fakePid(4), deployScript = fakePid(5), finished = fakePid(6), runShell = fakePid(7), runServer = fakePid(8), leftServer = fakePid(9), leftChild = fakePid(10), editor = fakePid(11), languageServer = fakePid(12), vim = fakePid(13), serviceChild = fakePid(14);
  const at = (pid: number, ppid: number, name: string, terminal = false): ProcessRow => ({ pid, ppid, pgid: pid, bornAt: seen, name, terminal });
  const census = [
    at(process.pid, 1, "node"),            // the live service
    at(terminalApp, 1, "Terminal"), at(shell, terminalApp, "zsh", true), at(agent, shell, "claude", true),
    at(toolShell, agent, "bash"),                  // the lead's tool shell: no terminal of its own
    at(deployScript, toolShell, "node"),                  // deploy-browser.mjs, run by the lead from the checkout
    at(finished, 1, "node"),                    // a finished run's provider
    at(runShell, finished, "sh"), at(runServer, runShell, "node"), // a server the run started
    at(leftServer, 1, "node"), at(leftChild, leftServer, "esbuild"), // a server left behind (its run's process gone) and its child
    at(editor, 1, "Code"), at(languageServer, editor, "node"),  // a person's editor and its language server
    at(vim, 1, "vim", true),               // at a terminal
    at(serviceChild, process.pid, "node"),          // started by the live service, not by a run
  ];
  const inside = new Set([agent, toolShell, deployScript, runServer, leftServer, leftChild, languageServer, vim, serviceChild]);
  expect(checkoutTargets(census, inside, new Set([finished]), protectedProcesses(census)).map(one => one.pid)).toEqual([runServer, leftServer, leftChild]);
  // With no finished run alive, only orphans and their children go.
  expect(checkoutTargets(census, inside, new Set(), protectedProcesses(census)).map(one => one.pid)).toEqual([leftServer, leftChild]);
});

test("when a run ends, what is still in its process group is stopped — SIGTERM, then SIGKILL — and the ledger says what", async () => {
  store.createTask({ id: "leaves-servers", title: "leaves servers" }, new Date());
  const ref = store.refFor("built-in", "leaves-servers").id;
  store.placeTask(ref, repo);
  const runId = store.startRun({ taskRef: ref, leaseId: "l-1", runner: "builder-1", branch: "toolroll/leaves-servers", worktree: join(dir, "wt-1"),
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: new Date() });
  // The provider starts a server and one that ignores SIGTERM, then exits: they live on in its process group.
  // Each writes its pid only once it is set up, so the second is known to ignore SIGTERM before any signal is sent.
  const pidFiles = [join(dir, "server.pid"), join(dir, "stubborn.pid")];
  const startedAt = Date.now();
  const root = spawn("/bin/sh", ["-c", `sh -c 'echo $$ > "${pidFiles[0]}"; exec sleep 300' & sh -c 'trap "" TERM; echo $$ > "${pidFiles[1]}"; exec sleep 300' & exit 0`], { detached: true, stdio: "ignore" });
  store.recordRunProcess(runId, root.pid!, new Date(startedAt), true);
  await new Promise(done => root.once("exit", done));
  expect(await until(() => pidFiles.every(file => existsSync(file) && readFileSync(file, "utf8").endsWith("\n")))).toBe(true);
  const left = pidFiles.map(file => Number(readFileSync(file, "utf8").trim()));
  spawned.push(...left);
  expect(left.every(alive)).toBe(true);
  store.finishRun(runId, { outcome: "built", now: new Date() });

  const signals: [number, string][] = [];
  const census = () => [row(process.pid, process.pid, startedAt - 60_000, "node"), ...left.filter(alive).map(pid => row(pid, root.pid!, startedAt))];
  // Between looks, wait for the server to be gone (and reaped) rather than trusting the grace to be long enough.
  const sleep = async (ms: number) => { await until(() => !alive(left[0]!)); await new Promise(next => setTimeout(next, ms)); };
  const closed = await closeOutRuns(store, () => new Date(), { graceMs: 400, census, sleep, signal: (pid, name) => { signals.push([pid, name]); process.kill(pid, name); } });

  expect(closed.map(one => one.runId)).toEqual([runId]);
  expect(await until(() => !left.some(alive))).toBe(true);
  expect(signals.filter(([, name]) => name === "SIGTERM").map(([pid]) => pid).sort()).toEqual([...left].sort());
  expect(signals.filter(([, name]) => name === "SIGKILL").map(([pid]) => pid)).toEqual([left[1]]);
  expect(signals.some(([pid]) => pid === process.pid)).toBe(false);
  const entry = store.actionLedger({ repos: null }).find(one => one.action === "run processes stopped");
  expect(entry).toMatchObject({ runId, taskId: "leaves-servers", source: "work", actor: "worker" });
  expect(entry!.detail).toContain(`run #${runId} ended (built); stopped 2 processes in 1 group: sleep (${left[0]}), sleep (${left[1]}); 1 needed SIGKILL after 0.4 s`);
  // Once the group is gone, a second pass finds nothing to stop and the run's process witness is settled.
  expect(await closeOutRuns(store, () => new Date(), { graceMs: 400, census })).toEqual([]);
  expect(store.handle.prepare("SELECT exited_at FROM run_process WHERE run = ?").get(runId)?.["exited_at"]).not.toBeNull();
});

test("a run still open is left alone", async () => {
  store.createTask({ id: "still-going", title: "still going" }, new Date());
  const ref = store.refFor("built-in", "still-going").id;
  store.placeTask(ref, repo);
  const runId = store.startRun({ taskRef: ref, leaseId: "l-2", runner: "builder-1", branch: "toolroll/still-going", worktree: join(dir, "wt-2"),
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: new Date() });
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  spawned.push(child.pid!);
  store.recordRunProcess(runId, child.pid!, new Date(), true);
  expect(await closeOutRuns(store, () => new Date(), { graceMs: 100, census: () => [row(child.pid!, child.pid!, Date.now() - 1_000)] })).toEqual([]);
  expect(alive(child.pid!)).toBe(true);
});

test("completing a task stops what Toolroll left running from its checkout, once, and says so in the ledger; never a deploy run from it", async () => {
  const git = (args: string[]) => run("git", args, { cwd: repo });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "first"]);
  const pool = new WorktreePool(store, { root: join(dir, "worktrees") });
  const now = new Date();
  store.createTask({ id: "serves", title: "serves" }, now);
  const ref = store.refFor("built-in", "serves").id;
  store.placeTask(ref, repo);
  const leased = await pool.lease({ repo, branch: "toolroll/serves", base: "main", runner: "builder-1", taskRef: ref, now });
  if (!leased.ok) throw new Error(leased.message);
  const runId = store.startRun({ taskRef: ref, leaseId: "l-3", runner: "builder-1", branch: "toolroll/serves", worktree: leased.worktree.path,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now });
  store.finishRun(runId, { outcome: "built", now });
  expect((await pool.release(leased.worktree.path, now)).ok).toBe(true);
  const server = spawn("sleep", ["300"], { cwd: leased.worktree.path, detached: true, stdio: "ignore" });
  spawned.push(server.pid!);
  store.setTaskState("serves", "done", now);
  // Waiting for review: not finished yet, nothing is stopped.
  expect(finishedCheckouts(store, new Date(), repo)).toEqual([]);
  store.recordAction({ at: new Date().toISOString(), actor: "operator:alex", repo, taskId: "serves", runId, action: COMPLETION_ACTION, outcome: "a".repeat(64), source: "work" });
  const finished = finishedCheckouts(store, new Date(), repo);
  expect(finished.map(one => one.row.path)).toEqual([leased.worktree.path]);
  // lsof (or /proc) finds it by its working directory.
  expect(await until(() => (processesIn([leased.worktree.path]).get(leased.worktree.path) ?? []).includes(server.pid!))).toBe(true);

  // A deploy the lead runs from the same checkout: its parent is alive and not Toolroll's, so it stays.
  const deploy = spawn("sleep", ["300"], { cwd: leased.worktree.path, detached: true, stdio: "ignore" });
  spawned.push(deploy.pid!);
  expect(await until(() => (processesIn([leased.worktree.path]).get(leased.worktree.path) ?? []).includes(deploy.pid!))).toBe(true);

  const census = () => [{ ...row(deploy.pid!, deploy.pid!, Date.now() - 1_000), ppid: process.pid }, ...(alive(server.pid!) ? [row(server.pid!, server.pid!, Date.now() - 1_000)] : [])];
  const closed = await closeOutCheckouts(store, () => new Date(), finished, { graceMs: 2_000, census });
  expect(closed.map(one => one.path)).toEqual([leased.worktree.path]);
  expect(closed[0]!.done.stopped.map(one => one.pid)).toEqual([server.pid]);
  expect(await until(() => !alive(server.pid!))).toBe(true);
  expect(alive(deploy.pid!)).toBe(true);
  expect(store.actionLedger({ repos: null }).find(one => one.action === "checkout processes stopped")).toMatchObject({ taskId: "serves",
    detail: expect.stringContaining(`its task finished; stopped 1 process in 1 group: sleep (${server.pid})`) });
  // Looked at once per finish.
  expect(await closeOutCheckouts(store, () => new Date(), finished, { graceMs: 100, census, find: () => { throw new Error("looked again"); } })).toEqual([]);
});
