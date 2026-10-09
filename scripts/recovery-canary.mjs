#!/usr/bin/env node
/** Repeated real-process occupancy and draft-preservation checks. No model calls. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let rounds = 100;
let output = resolve("output/certification/recovery.json");
let keep = false;
const usage = "npm run certify:recovery -- [--rounds 100] [--output <file>] [--keep]";
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "--help") { console.log(usage); process.exit(0); }
  else if (arg === "--keep") keep = true;
  else if (arg === "--rounds" || arg === "--output") {
    const value = process.argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value; ${usage}`);
    if (arg === "--rounds") rounds = Number(value);
    else output = resolve(value);
  } else throw new Error(`unknown option ${arg}; ${usage}`);
}
assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 1000, "rounds must be an integer from 1 to 1000");
const { openStore } = await import(pathToFileURL(join(root, "dist/store.js")));
const { register, recoverDead, DEFAULT_LIVENESS_MS } = await import(pathToFileURL(join(root, "dist/runner.js")));
const { acquire, finalize } = await import(pathToFileURL(join(root, "dist/claim.js")));
const { WorktreePool } = await import(pathToFileURL(join(root, "dist/worktree.js")));
const { run } = await import(pathToFileURL(join(root, "dist/exec.js")));
const { HANDOFF_PREFIX } = await import(pathToFileURL(join(root, "dist/evidence.js")));

const base = await realpath(await mkdtemp(join(tmpdir(), "standing-orders-recovery-canary-")));
const started = Date.now();
const cases = [];
let failure = null;
const git = async (repo, args) => {
  const result = await run("git", args, { cwd: repo, timeoutMs: 10000 });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
};
const revision = await git(root, ["rev-parse", "HEAD"]);
try {
  for (let index = 0; index < rounds; index++) {
    const round = join(base, String(index));
    const repo = join(round, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "canary@standing-orders.local"]);
    await git(repo, ["config", "user.name", "Recovery Canary"]);
    await writeFile(join(repo, "README.md"), "disposable recovery fixture\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-qm", "seed"]);
    const store = openStore(join(round, "orders.db"));
    let writer = null;
    let exited = null;
    try {
      const now = new Date();
      const expired = new Date(now.getTime() + DEFAULT_LIVENESS_MS + 1000);
      const old = register(store, { name: "old", host: "fixture", repos: [repo], now });
      store.createTask({ id: "work", title: "preserve an interrupted draft" }, now);
      const ref = store.refFor("built-in", "work").id;
      store.placeTask(ref, repo);
      const claim = acquire(store, ref, "old", { token: old.token, now, newLeaseId: () => "old-lease" });
      assert.equal(claim.ok, true);
      store.setTaskState("work", "running", now);
      const pool = new WorktreePool(store, { root: join(round, "pool") });
      const leased = await pool.lease({ repo, branch: "draft", base: "main", runner: "old", taskRef: ref, now });
      assert.equal(leased.ok, true, leased.message);
      const path = leased.worktree.path;
      const runId = store.startRun({ taskRef: ref, runner: "old", leaseId: "old-lease", branch: "draft", worktree: path, now,
        route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
      const scenario = ["partial-draft", "completed-handoff", "committed-with-late-writer"][index % 3];
      if (scenario === "completed-handoff") {
        await writeFile(join(path, `${HANDOFF_PREFIX}0123456789abcdef.json`), JSON.stringify({ version: 1, status: "completed", conclusion: "A finished draft before control-plane interruption." }));
      }
      if (scenario === "committed-with-late-writer") {
        await writeFile(join(path, "finished.txt"), "a commit already exists\n");
        await git(path, ["add", "finished.txt"]);
        await git(path, ["commit", "-qm", "finished work before interruption"]);
      }
      const head = await git(path, ["rev-parse", "HEAD"]);
      // A real live process keeps writing after the controller's liveness
      // expires. The clock injection is deliberate: this is an occupancy
      // fence canary, not a claim to have killed the entire product worker.
      writer = spawn(process.execPath, ["-e", "const fs=require('node:fs');let n=0;const write=()=>fs.writeFileSync('draft.txt','preserved '+(++n)+'\\n');write();console.log('ready');setInterval(write,10)"],
        { cwd: path, stdio: ["ignore", "pipe", "ignore"] });
      exited = once(writer, "exit");
      await once(writer.stdout, "data");
      assert.equal(pool.markProviderOccupancy(path, "old", writer.pid), true);
      const recovered = recoverDead(store, expired);
      assert.equal(store.getRun(runId).outcome, "failed");
      assert.equal(store.getRun(runId).reason, "interrupted");
      assert.deepEqual(recovered[0].requeued, ["work"]);
      const next = register(store, { name: "next", host: "fixture", repos: [repo], now: expired });
      const successor = acquire(store, ref, "next", { token: next.token, now: expired, newLeaseId: () => "new-lease" });
      assert.equal(successor.ok, true);
      const request = { repo, branch: "draft", runner: "next", taskRef: ref, now: expired, reclaim: { evidenceRoot: join(round, "evidence") } };
      const blocked = await pool.lease(request);
      assert.equal(blocked.ok, false);
      assert.equal(blocked.reason, "in-use");
      assert.equal(finalize(store, "old-lease", { kind: "complete", state: "done", now: expired }).ok, false);
      assert.notEqual(store.getTask("work").state, "done");
      writer.kill("SIGKILL");
      await exited;
      writer = null;
      const draft = await readFile(join(path, "draft.txt"), "utf8");
      const resumed = await pool.lease(request);
      assert.equal(resumed.ok, true, resumed.message);
      assert.equal(resumed.resumedFromRun, runId);
      assert.equal(resumed.recoveryKind, scenario === "completed-handoff" ? "completed" : "partial");
      assert.equal(await readFile(join(path, "draft.txt"), "utf8"), draft);
      assert.equal(await git(path, ["rev-parse", "HEAD"]), head);
      assert((await readFile(resumed.reclaimed, "utf8")).includes(draft.trim()));
      assert.equal(finalize(store, "new-lease", { kind: "complete", state: "failed", now: expired }).ok, true);
      await pool.release(path, expired);
      cases.push({ round: index + 1, scenario, passed: true, oldCompletion: "fenced", liveWriter: "refused-reuse", draft: "preserved", commit: "preserved" });
    } finally {
      if (writer !== null) { writer.kill("SIGKILL"); await exited.catch(() => {}); }
      store.close();
    }
    if ((index + 1) % 10 === 0) process.stdout.write(`${index + 1}/${rounds} recovery cases passed\n`);
  }
} catch (error) { failure = error instanceof Error ? error.stack : String(error); }
const certificate = { version: 1, passed: failure === null, sourceCommit: revision, platform: process.platform, node: process.versions.node,
  roundsRequested: rounds, roundsPassed: cases.length, durationSeconds: (Date.now() - started) / 1000,
  scope: "Real writer processes with injected controller liveness expiry: no reuse while the writer is alive; stale completion fenced; draft, handoff and existing commit preserved after writer exit.",
  exclusions: ["actual controller crash at every transition", "process trees with detached descendants", "Windows reboot", "provider session resume", "interrupted verification receipt reuse"],
  cases, error: failure, retainedAt: failure === null && !keep ? null : base };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(certificate, null, 2) + "\n");
if (failure === null && !keep) await rm(base, { recursive: true, force: true });
if (failure !== null) { process.stderr.write(failure + "\n"); process.exitCode = 1; }
