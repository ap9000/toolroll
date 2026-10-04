import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { disposeBuildOutcome } from "./dispose.js";
import { run, runOwnerTag } from "./exec.js";
import { requestTaskStop, resumeTaskStop, taskControlOf, underStopWatch } from "./task-control.js";
import { witnessedRunner, preserveObservedProcesses } from "./process-custody.js";
import { WorktreePool } from "./worktree.js";
import { storeEvidence } from "./evidence.js";
import { writeStoreSeed } from "../test/store-seed.js";
import { addApprover } from "./scope.js";
import { runOperate } from "./operate.js";

const roots: string[] = [];
const stores: Store[] = [];
const children: ChildProcess[] = [];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let templateRoot: string | undefined;
let templateFile: string;
beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "so-stop-template-"));
  templateFile = join(templateRoot, "orders.db");
  await writeStoreSeed(templateFile);
});
afterAll(() => { if (templateRoot !== undefined) rmSync(templateRoot, { recursive: true, force: true }); });

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-stop-adversarial-")));
  roots.push(root);
  const file = join(root, "orders.db");
  copyFileSync(templateFile, file);
  const store = openStore(file);
  stores.push(store);
  const now = new Date();
  register(store, { name: "worker", host: "fixture", capacity: 2, repos: [root], now, newToken: () => "fixture-only" });
  store.createTask({ id: "draft", title: "Draft" }, now);
  const ref = store.refFor("built-in", "draft").id;
  store.placeTask(ref, root);
  const claim = acquire(store, ref, "worker", { token: "fixture-only", now, incarnation: "dead-watch" });
  if (!claim.ok) throw new Error(JSON.stringify(claim));
  const id = store.startRun({ taskRef: ref, runner: "worker", leaseId: claim.claim.leaseId,
    worktree: root, branch: "draft", now,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
  return { root, store, ref, id, leaseId: claim.claim.leaseId, now };
}

describe("operator review: cancellation cannot cross custody boundaries", () => {
  test("an unrecorded possible spawn stays stopping and cannot resume", () => {
    const f = fixture();
    f.store.raw().prepare("UPDATE run SET provider_started_at = ? WHERE id = ?").run(f.now.toISOString(), f.id);
    requestTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date());
    f.store.recoverIncarnation("worker", "dead-watch", new Date());
    expect(f.store.stopQuiescenceProblem(f.id)).toContain("witness");
    expect(f.store.stopOf(f.id)?.settledAt).toBeNull();
    expect(resumeTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date()).ok).toBe(false);
  });

  test("an earlier completed setup cannot hide a crash before the next spawn witness", () => {
    const f = fixture();
    const earlier = f.store.reserveRunProcess(f.id, new Date());
    f.store.finishUnspawnedProcess(earlier, new Date());
    f.store.reserveRunProcess(f.id, new Date());
    requestTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date());
    f.store.recoverIncarnation("worker", "dead-watch", new Date());
    expect(f.store.stopQuiescenceProblem(f.id)).toContain("incomplete spawn witness");
    expect(f.store.stopOf(f.id)?.settledAt).toBeNull();
  });

  test("a returning transport can close a reserved spawn that created no process", async () => {
    const f = fixture();
    const result = await witnessedRunner(f.store, f.id, () => new Date(), run)(join(f.root, "no-such-executable"), [], { processGroup: true });
    expect(result.notFound).toBe(true);
    requestTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date());
    f.store.recoverIncarnation("worker", "dead-watch", new Date());
    expect(f.store.stopQuiescenceProblem(f.id)).toBeNull();
    expect(f.store.stopOf(f.id)?.settledAt).not.toBeNull();
  });

  test("a final observation diagnostic keeps known custody and later positive exit probes settle it", async () => {
    const f = fixture();
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] }); children.push(child);
    await new Promise<void>(resolve => child.once("spawn", resolve));
    const transport = witnessedRunner(f.store, f.id, () => new Date(), async (_file, _args, options) => {
      options?.beforeSpawn?.(); options?.onSpawn?.(child.pid!);
      options?.onObservationFailure?.({ phase: "final-exit", operation: "snapshot", code: "EPERM", rootPid: child.pid!, at: new Date().toISOString(), identityUnknown: false });
      return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
    });
    await transport("unused", [], { processGroup: false });
    const witnesses = () => f.store.raw().prepare("SELECT pid,exited_at FROM run_process WHERE run=?").all(f.id);
    expect(witnesses()).toEqual([{ pid: child.pid, exited_at: null }]);
    const event = f.store.actionLedger({ repos: null }).find(one => one.action === "process observation failed");
    expect(event).toMatchObject({ runId: f.id, taskId: "draft", repo: f.root });
    expect(JSON.parse(event!.outcome)).toMatchObject({ phase: "final-exit", code: "EPERM", rootPid: child.pid, identityUnknown: false });
    const exited = new Promise<void>(resolve => child.once("close", resolve)); child.stdin!.end(); await exited;
    expect(f.store.recordRunProcessExits(f.id, new Date())).toBe(1);
    expect(witnesses()[0]!.exited_at).not.toBeNull();
  });

  test("known descendant fallback commits all IDs without changing an older unknown witness", () => {
    const f = fixture();
    const old = f.store.reserveRunProcess(f.id, new Date());
    expect(preserveObservedProcesses(f.store, f.id, new Date(), [{ pid: 100, group: true }, { pid: 200, group: false }])).toBe(true);
    const rows = f.store.raw().prepare("SELECT id,pid,process_group,exited_at FROM run_process WHERE run=? ORDER BY id").all(f.id);
    expect(rows).toEqual([
      { id: old, pid: null, process_group: 1, exited_at: null },
      { id: expect.any(Number), pid: 100, process_group: 1, exited_at: null },
      { id: expect.any(Number), pid: 200, process_group: 0, exited_at: null },
    ]);
  });

  test("a failed fallback transaction leaves its fresh guard and rolls back every partial identity", () => {
    const f = fixture();
    expect(() => preserveObservedProcesses(f.store, f.id, new Date(), [{ pid: 100, group: true }, { pid: -1, group: false }])).toThrow("valid spawned PID");
    expect(f.store.raw().prepare("SELECT pid,exited_at FROM run_process WHERE run=?").all(f.id)).toEqual([{ pid: null, exited_at: null }]);
  });

  test("all unspawned transient retries settle when their transport returns", async () => {
    const f = fixture();
    const transport = witnessedRunner(f.store, f.id, () => new Date(), async (_file, _args, options) => {
      options?.beforeSpawn?.();
      options?.beforeSpawn?.();
      return { code: 1, stdout: "", stderr: "no child", timedOut: false, notFound: true };
    });
    await transport("unused", [], { processGroup: true });
    requestTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date());
    f.store.recoverIncarnation("worker", "dead-watch", new Date());
    expect(f.store.stopQuiescenceProblem(f.id)).toBeNull();
    expect(f.store.stopOf(f.id)?.settledAt).not.toBeNull();
  });

  test("completion has no unlocked window where an accepted stop can lose", () => {
    const f = fixture();
    const other = openStore(join(f.root, "orders.db"));
    stores.push(other);
    const transact = f.store.transact.bind(f.store);
    let depth = 0, stopAccepted: boolean | null = null;
    // Model a second SQLite writer committing immediately after the first
    // transaction releases its lock. The completion transaction must re-read.
    f.store.transact = ((body: () => unknown) => {
      depth++;
      let value: unknown;
      try { value = transact(body); } finally { depth--; }
      if (depth === 0 && stopAccepted === null) {
        const alreadyEnded = other.getRun(f.id)?.outcome !== null;
        stopAccepted = other.requestRunStop({ runId: f.id, taskRef: f.ref, by: "operator", via: "cli" }, new Date()).ok;
        expect(stopAccepted).toBe(!alreadyEnded);
      }
      return value;
    }) as Store["transact"];
    const disposition = disposeBuildOutcome({ store: f.store, policy: "tick", leaseId: f.leaseId,
      runId: f.id, taskId: "draft", taskRef: f.ref, runner: "worker", repo: f.root,
      branch: "draft", origin: "ours", provider: "claude", model: null,
      worktreePath: f.root, clock: () => new Date() },
    { ok: true, committed: true, branch: "draft", summary: "late success" });
    expect(stopAccepted).not.toBeNull();
    if (stopAccepted) {
      expect(disposition.kind).toBe("stopped");
      expect(f.store.getTask("draft")?.state).toBe("queued");
      expect(f.store.getRun(f.id)).toMatchObject({ outcome: "failed", reason: "interrupted", committed: true });
    } else {
      expect(disposition.kind).toBe("built");
      expect(f.store.getTask("draft")?.state).toBe("done");
      expect(f.store.getRun(f.id)?.outcome).toBe("built");
      expect(f.store.stopOf(f.id)).toBeNull();
    }
    expect(f.store.publicationForRun(f.id)).toBeNull();
  });

  test("equal local run IDs in independent databases do not share process custody", async () => {
    const a = fixture(), b = fixture();
    expect(a.id).toBe(b.id);
    let readyA!: () => void, readyB!: () => void;
    const ready = Promise.all([new Promise<void>(r => { readyA = r; }), new Promise<void>(r => { readyB = r; })]);
    const target = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      owner: runOwnerTag(a.store, a.id), processGroup: true, timeoutMs: 2_000, onSpawn: readyA,
    });
    const independent = run(process.execPath, ["-e", "setTimeout(()=>console.log('independent success'),350)"], {
      owner: runOwnerTag(b.store, b.id), processGroup: true, timeoutMs: 2_000, onSpawn: readyB,
    });
    await ready;
    expect(requestTaskStop(a.store, { taskId: "draft", runId: a.id, by: "operator", via: "web" }, new Date()).ok).toBe(true);
    const [stopped, untouched] = await Promise.all([target, independent]);
    expect(stopped.code).not.toBe(0);
    expect(stopped.timedOut).toBe(false);
    expect(untouched).toMatchObject({ code: 0, timedOut: false, stdout: "independent success\n" });
    expect(b.store.stopOf(b.id)).toBeNull();
  });

  test("a stop observed before an asynchronous spawn still terminates that later child", async () => {
    const f = fixture();
    f.store.requestRunStop({ runId: f.id, taskRef: f.ref, by: "operator", via: "web" }, new Date());
    let notifications = 0;
    const result = await underStopWatch(f.store, f.id, async () => {
      await delay(60);
      return run(process.execPath, ["-e", "setInterval(()=>console.log('still writing'),25)"], {
        owner: runOwnerTag(f.store, f.id), processGroup: true, timeoutMs: 2_000,
      });
    }, { intervalMs: 20, onStop: () => { notifications++; } });
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(notifications).toBe(1);
  });

  test("recovering a dead controller keeps stop pending while its orphaned provider writes", async () => {
    const f = fixture();
    const file = join(f.root, "draft.txt");
    const child = spawn(process.execPath, ["--input-type=module", "-e", String.raw`
      import fs from 'node:fs';
      fs.writeFileSync(process.argv[1], 'draft\n');
      setInterval(() => fs.appendFileSync(process.argv[1], 'still writing\n'), 30);
      process.send('ready');
    `, file], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); });
    f.store.recordRunProcess(f.id, child.pid!, new Date());
    const stamp = f.now.toISOString();
    f.store.saveWorktree({ path: f.root, repo: f.root, branch: "draft", runner: "worker", taskRef: f.ref,
      createdAt: stamp, leasedAt: stamp, releasedAt: null, verified: true });
    writeFileSync(join(f.root, ".standing-orders-lease"), `${child.pid} worker group\n`);
    expect(requestTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "web" }, new Date()).ok).toBe(true);
    f.store.recoverIncarnation("worker", "dead-watch", new Date());
    const before = readFileSync(file, "utf8");
    await delay(100);
    expect(readFileSync(file, "utf8").length).toBeGreaterThan(before.length);
    const pool = new WorktreePool(f.store, { root: join(f.root, "pool") });
    expect(resumeTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "web", occupied: path => pool.inUse(path) }, new Date()).ok).toBe(false);
    expect(f.store.stopOf(f.id)?.settledAt).toBeNull();
    expect(f.store.stopOf(f.id)?.resumedAt).toBeNull();
    expect(taskControlOf(f.store, f.ref, new Date()).kind).toBe("stopping");
    // A removed worktree marker cannot erase the database's spawn witness.
    rmSync(join(f.root, ".standing-orders-lease"));
    expect(f.store.settleQuiescentStops(new Date())).toBe(0);
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
    expect(f.store.settleQuiescentStops(new Date())).toBe(1);
    expect(f.store.stopOf(f.id)?.settledAt).not.toBeNull();
    expect(resumeTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date()).ok).toBe(true);
  });

  test.skipIf(process.platform === "win32").each(["normal", "failed-write"])("recovery retains an observed detached descendant after its harness dies (%s)", async mode => {
    const f = fixture();
    const record = f.store.recordRunProcess.bind(f.store);
    let injected = false;
    f.store.recordRunProcess = (runId, pid, now, group, witness) => {
      if (mode === "failed-write" && witness === undefined && !injected) {
        injected = true;
        throw Object.assign(new Error("fixture database busy"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      }
      record(runId, pid, now, group, witness);
    };
    const ready = join(f.root, "detached.json"), release = join(f.root, "release");
    const helper = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0)},20)";
    const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(helper)},process.argv[1],process.argv[2]],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},50)`;
    let rootPid = 0;
    const execution = witnessedRunner(f.store, f.id, () => new Date(), run)(process.execPath, ["-e", parent, ready, release], {
      processGroup: true, owner: runOwnerTag(f.store, f.id), timeoutMs: 10_000, onSpawn: pid => { rootPid = pid; },
    });
    try {
      const end = Date.now() + 5000;
      let helperPid = 0;
      while (Date.now() < end) {
        if (existsSync(ready)) helperPid = Number(readFileSync(ready, "utf8"));
        if (helperPid && f.store.raw().prepare("SELECT id FROM run_process WHERE run = ? AND pid = ?").get(f.id, helperPid)) break;
        await delay(25);
      }
      expect(helperPid).toBeGreaterThan(0);
      expect(f.store.raw().prepare("SELECT id FROM run_process WHERE run = ? AND pid = ?").get(f.id, helperPid)).toBeDefined();
      if (mode === "failed-write") {
        expect(injected).toBe(true);
        expect(f.store.raw().prepare("SELECT id FROM run_process WHERE run=? AND pid IS NULL").all(f.id)).toEqual([]);
        const failure = f.store.actionLedger({ repos: null }).find(one => one.action === "process observation failed");
        expect(JSON.parse(failure!.outcome)).toMatchObject({ operation: "descendant-write", code: "SQLITE_BUSY", identityUnknown: false });
      }
      // Deliberately kill only the known harness handle's PID. Its separately
      // grouped child survives exactly as it does after an external crash.
      process.kill(rootPid, "SIGKILL");
      await execution;
      requestTaskStop(f.store, { taskId: "draft", runId: f.id, by: "operator", via: "cli" }, new Date());
      f.store.recoverIncarnation("worker", "dead-watch", new Date());
      expect(f.store.stopOf(f.id)?.settledAt).toBeNull();
      expect(f.store.stopQuiescenceProblem(f.id)).toContain(String(helperPid));
      writeFileSync(release, "release owned fixture");
      const exitedBy = Date.now() + 3000;
      while (Date.now() < exitedBy && f.store.stopQuiescenceProblem(f.id) !== null) await delay(25);
      expect(f.store.settleQuiescentStops(new Date())).toBe(1);
    } finally {
      writeFileSync(release, "fixture cleanup");
      await execution;
    }
  });

  test("a completed owned command retains its verified process exit", async () => {
    const f = fixture();
    const result = await witnessedRunner(f.store, f.id, () => new Date(), run)(process.execPath, ["-e", "process.exit(0)"], {
      processGroup: true, owner: runOwnerTag(f.store, f.id), timeoutMs: 10_000,
    });
    expect(result.code).toBe(0);
    const witnesses = f.store.raw().prepare("SELECT * FROM run_process WHERE run=? AND pid IS NOT NULL").all(f.id);
    expect(witnesses.length).toBeGreaterThan(0);
    expect(witnesses.every(row => typeof row.exited_at === "string")).toBe(true);
    expect(f.store.getRun(f.id)?.outcome).toBeNull();
  });

  test("review retry waits for an orphan even when that reviewer has no worktree", async () => {
    const f = fixture();
    f.store.finishRun(f.id, { outcome: "built", now: new Date() });
    storeEvidence(f.store, join(f.root, "evidence"), f.id, "terminal-diff", "diff.patch", Buffer.from("diff --git a/a b/a\n"), "fixture", new Date(), { captureStatus: "ok" });
    const inserted = f.store.raw().prepare("INSERT INTO run (task_ref,lease_id,runner,role,provider,parent_run,review_attempt,started_at) VALUES (?, 'review-lease', 'worker', 'reviewer', 'claude', ?, 1, ?)").run(f.ref, f.id, f.now.toISOString());
    const review = Number(inserted.lastInsertRowid);
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},100);process.send('ready')"], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); });
    f.store.recordRunProcess(review, child.pid!, new Date());
    expect(requestTaskStop(f.store, { taskId: "draft", runId: review, by: "operator", via: "cli" }, new Date()).ok).toBe(true);
    f.store.recoverRunnerWork("worker", new Date());
    expect(f.store.stopOf(review)?.settledAt).toBeNull();
    expect(f.store.requestReview(f.id, "operator", new Date())).toMatchObject({ ok: false, reason: "review-running" });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
    expect(f.store.settleQuiescentStops(new Date())).toBe(1);
    expect(f.store.requestReview(f.id, "operator", new Date())).toMatchObject({ ok: true, attempt: 2 });
  });
});

describe("a failed or interrupted spawn never leaves a run unprovable", () => {
  const witnesses = (f: ReturnType<typeof fixture>) => f.store.raw().prepare("SELECT id,pid,exited_at FROM run_process WHERE run=? ORDER BY id").all(f.id);
  const live = async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},100);process.send('ready')"], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); });
    return child;
  };
  const gone = async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", detached: true });
    await new Promise<void>(resolve => child.once("exit", () => resolve()));
    return child.pid!;
  };

  test("c1: a failed spawn settles its witness as never started, even when the transport then throws", async () => {
    const f = fixture();
    const crashing = witnessedRunner(f.store, f.id, () => new Date(), async (file, args, options) => {
      await run(file, args, options);
      throw new Error("the transport crashed after the spawn failed");
    });
    // ENOENT: the OS returned no pid.
    await expect(crashing(join(f.root, "no-such-executable"), [], { processGroup: true })).rejects.toThrow("transport crashed");
    // A throw from the spawn call itself.
    await expect(crashing(process.execPath, ["bad\0argument"], { processGroup: true })).rejects.toThrow("transport crashed");
    const rows = witnesses(f);
    expect(rows.length).toBe(2);
    expect(rows.every(row => row.pid === null && typeof row.exited_at === "string")).toBe(true);
    f.store.finishRun(f.id, { outcome: "failed", now: new Date() });
    expect(f.store.stopQuiescenceProblem(f.id)).toBeNull();
  });

  test("c2: run end settles a pid-less witness once its process groups are gone, with a ledger entry", async () => {
    const f = fixture();
    f.store.recordRunProcess(f.id, await gone(), new Date());
    const orphan = f.store.reserveRunProcess(f.id, new Date());
    // An open run never settles.
    expect(f.store.settleUnspawnedWitnesses(new Date())).toBe(0);
    f.store.finishRun(f.id, { outcome: "built", now: new Date() });
    expect(witnesses(f).every(row => typeof row.exited_at === "string")).toBe(true);
    expect(f.store.stopQuiescenceProblem(f.id)).toBeNull();
    const entry = f.store.actionLedger({ repos: null }).find(one => one.action === "process witness settled");
    expect(entry).toMatchObject({ runId: f.id, taskId: "draft", outcome: "never started", detail: expect.stringContaining(`witness ${orphan}`) });
    expect(f.store.settleUnspawnedWitnesses(new Date())).toBe(0);
    // An older finished run missed that immediate pass. Status and the
    // reconciliation use the same proof, without asking a person to act.
    f.store.raw().prepare("UPDATE run_process SET exited_at=NULL WHERE id=?").run(orphan);
    expect(f.store.stopQuiescenceFact(f.id)?.kind).toBe("settling");
    expect(f.store.settleUnspawnedWitnesses(new Date())).toBe(1);
    expect(f.store.stopQuiescenceProblem(f.id)).toBeNull();
  });

  test("c2: reconcile leaves a pid-less witness while a process group of the run lives, or when it is the run's only witness", async () => {
    const f = fixture();
    f.store.reserveRunProcess(f.id, new Date());
    f.store.finishRun(f.id, { outcome: "built", now: new Date() });
    expect(f.store.settleUnspawnedWitnesses(new Date())).toBe(0);
    const child = await live();
    f.store.recordRunProcess(f.id, child.pid!, new Date());
    expect(f.store.settleUnspawnedWitnesses(new Date())).toBe(0);
    expect(f.store.stopQuiescenceFact(f.id)?.kind).toBe("alive");
    // Automatic settlement keeps its group probe, even for a recorded exit.
    // Quiescence trusts that exit but retains the remaining unknown witness.
    f.store.raw().prepare("UPDATE run_process SET exited_at=? WHERE run=? AND pid=?").run(new Date().toISOString(), f.id, child.pid!);
    expect(f.store.settleUnspawnedWitnesses(new Date())).toBe(0);
    expect(f.store.stopQuiescenceFact(f.id)?.kind).toBe("unprovable");
  });

  test("c3: run settle records the approver's reason and refuses while a process of the run is alive", async () => {
    const f = fixture();
    const added = addApprover(f.store, "alex", new Date());
    if (!added.ok) throw new Error("approver");
    const child = await live();
    f.store.recordRunProcess(f.id, child.pid!, new Date());
    f.store.reserveRunProcess(f.id, new Date());
    f.store.finishRun(f.id, { outcome: "built", now: new Date() });
    let lines: string[] = [];
    const settle = async (...extra: string[]) => {
      lines = [];
      const code = await runOperate("run", ["settle", String(f.id), ...extra, "--json"], line => lines.push(line), { databaseFile: join(f.root, "orders.db") });
      return { code, body: JSON.parse(lines.join("\n")) as Record<string, unknown> };
    };
    const why = "The release check's runner crashed between reserving and recording its spawn; checked ps by hand.";
    expect((await settle("--why", why)).body).toMatchObject({ ok: false, reason: "usage" });
    expect((await settle("--why", why, "--as", "alex", "--token", "wrong")).body).toMatchObject({ ok: false, reason: "not-an-approver" });
    expect((await settle("--as", "alex", "--token", added.token)).body).toMatchObject({ ok: false, reason: "usage" });
    const refused = await settle("--why", why, "--as", "alex", "--token", added.token);
    expect(refused.body).toMatchObject({ ok: false, reason: "alive" });
    expect(f.store.stopQuiescenceProblem(f.id)).not.toBeNull();
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const settled = await settle("--why", why, "--as", "alex", "--token", added.token);
    expect(settled.code).toBe(0);
    expect(settled.body).toMatchObject({ ok: true, run: f.id, repeated: false });
    expect(f.store.stopQuiescenceProblem(f.id)).toBeNull();
    const entry = f.store.actionLedger({ repos: null }).find(one => one.action === "process witness settled by approver");
    expect(entry).toMatchObject({ actor: "alex", runId: f.id, detail: why });
    expect((await settle("--why", why, "--as", "alex", "--token", added.token)).body).toMatchObject({ ok: true, repeated: true });
  });
});
