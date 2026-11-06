/**
 * Toolroll proves a finished build stopped itself (stop-proof.ts): nobody is asked to "confirm it stopped". The
 * release check 3312 case first (an unrecorded spawn plus an exited process group whose number an unrelated process
 * now holds), then the attacks: a leftover holding the folder is found and stopped; a reused pid is never signalled;
 * something Toolroll didn't start holds the proof without being touched; another computer's run stays blocked with
 * nothing to vouch for.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, STOP_PROOF_BLOCKED, STOP_PROOF_SETTLED, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { NEEDS, processNeedOf } from "./needs-you.js";
import { namesPath, proveFinishedRunsStopped, proveRunStopped, type StopProofOptions } from "./stop-proof.js";
import type { ProcessRow } from "./run-closeout.js";
import { writeStoreSeed } from "../test/store-seed.js";
import { fakePid } from "../test/fake-pid.js";

const roots: string[] = [];
const stores: Store[] = [];
const started: number[] = [];
let templateRoot: string | undefined;
let templateFile: string;
beforeAll(async () => {
  templateRoot = mkdtempSync(join(tmpdir(), "so-stop-proof-template-"));
  templateFile = join(templateRoot, "orders.db");
  await writeStoreSeed(templateFile);
});
afterAll(() => { if (templateRoot !== undefined) rmSync(templateRoot, { recursive: true, force: true }); });
afterEach(() => {
  // Only processes this file started, by exact pid.
  for (const pid of started.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const MIN = 60_000;
/** A finished run with a folder, started at `start` and finished 10 minutes later. */
function fixture(start = new Date(Date.now() - 20 * MIN)) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-stop-proof-")));
  roots.push(root);
  const file = join(root, "orders.db");
  copyFileSync(templateFile, file);
  const store = openStore(file);
  stores.push(store);
  const worktree = join(root, "checkout");
  mkdirSync(worktree);
  register(store, { name: "worker", host: "fixture", capacity: 2, repos: [root], now: start, newToken: () => "fixture-only" });
  store.createTask({ id: "release-check", title: "Release check" }, start);
  const ref = store.refFor("built-in", "release-check").id;
  store.placeTask(ref, root);
  const claim = acquire(store, ref, "worker", { token: "fixture-only", now: start });
  if (!claim.ok) throw new Error(JSON.stringify(claim));
  const id = store.startRun({ taskRef: ref, runner: "worker", leaseId: claim.claim.leaseId, worktree, branch: "release", now: start,
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
  const finish = (at = new Date(start.getTime() + 10 * MIN)) => store.finishRun(id, { outcome: "built", now: at });
  return { root, store, ref, id, worktree, start, finish, end: new Date(start.getTime() + 10 * MIN) };
}

/** A look at a made-up computer: the given processes, their folders and command lines; signals recorded, never sent. */
function computer(rows: ProcessRow[], folders: Record<number, string> = {}, lines: Record<number, string> = {}) {
  const signals: [number, string][] = [];
  let table = rows;
  const options: StopProofOptions = {
    afterFinishMs: 60_000,
    census: () => table,
    cwds: paths => {
      const found = new Map<string, number[]>();
      for (const [pid, cwd] of Object.entries(folders)) for (const path of paths) {
        if ((cwd === path || cwd.startsWith(`${path}/`)) && table.some(row => row.pid === Number(pid))) found.set(path, [...(found.get(path) ?? []), Number(pid)]);
      }
      return found;
    },
    commandLines: () => new Map(Object.entries(lines).filter(([pid]) => table.some(row => row.pid === Number(pid))).map(([pid, line]) => [Number(pid), line])),
    occupancy: () => ({ held: false }),
    // A signalled process goes, as a real one would.
    signal: (pid, name) => { signals.push([pid, name]); table = table.filter(row => row.pid !== pid); },
    sleep: async () => {},
    graceMs: 10,
    self: process.pid,
  };
  return { options, signals, set: (next: ProcessRow[]) => { table = next; } };
}
const service: ProcessRow = { pid: process.pid, ppid: 1, pgid: process.pid, bornAt: 0, name: "node", terminal: false };
const ledger = (store: Store, action: string) => store.actionLedger({ repos: null }).filter(one => one.action === action);

describe("release check 3312: an unrecorded spawn no longer asks anyone to confirm it stopped", () => {
  test("an exited group whose number an unrelated process now holds plus a pid-less witness: unprovable, then proven by Toolroll itself", async () => {
    const f = fixture();
    const group = fakePid(1);
    // The check's process group, recorded and proven gone during the run…
    f.store.recordRunProcess(f.id, group, new Date(f.start.getTime() + MIN), true);
    f.store.handle.prepare("UPDATE run_process SET exited_at = ? WHERE run = ? AND pid = ?").run(new Date(f.start.getTime() + 5 * MIN).toISOString(), f.id, group);
    // …and a process-tree snapshot that failed under load, leaving a witness with no pid.
    f.store.reserveRunProcess(f.id, new Date(f.start.getTime() + 2 * MIN));
    // An unrelated long-lived process took the group's number during the 40-minute suite: the automatic witness
    // settlement keeps its conservative group probe, so before this fix the run asked a person to vouch.
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && Math.abs(pid) === group) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }) as typeof process.kill);
    f.finish();
    expect(f.store.settleUnspawnedWitnesses(new Date())).toBe(0);
    const fact = f.store.stopQuiescenceFact(f.id);
    expect(fact).toMatchObject({ run: f.id, kind: "unprovable", cause: "incomplete-spawn" });
    // Nobody is asked: it waits on Toolroll's own check.
    expect(processNeedOf(fact)).toEqual({ wait: "build-checking", build: f.id });
    const reused: ProcessRow = { pid: group, ppid: 1, pgid: group, bornAt: f.start.getTime() + 7 * MIN, name: "Dock", terminal: false };
    const look = computer([service, reused]);
    const proved = await proveRunStopped(f.store, f.id, () => new Date(), look.options);
    expect(proved.outcome).toBe("settled");
    // The process holding the old number was never signalled: it isn't in the folder and isn't the run's.
    expect(look.signals).toEqual([]);
    expect(f.store.stopQuiescenceFact(f.id)).toBeNull();
    expect(ledger(f.store, STOP_PROOF_SETTLED)).toEqual([expect.objectContaining({ runId: f.id, actor: "system", detail: expect.stringContaining(hostname()) })]);
  });

  test("a run that started its agent with no witness at all settles on the same proof", async () => {
    const f = fixture();
    f.store.handle.prepare("UPDATE run SET provider_started_at = ? WHERE id = ?").run(new Date(f.start.getTime() + MIN).toISOString(), f.id);
    f.finish();
    expect(f.store.stopQuiescenceFact(f.id)).toMatchObject({ kind: "unprovable", cause: "no-witness" });
    const results = await proveFinishedRunsStopped(f.store, () => new Date(), computer([service]).options);
    expect(results).toEqual([expect.objectContaining({ run: f.id, outcome: "settled" })]);
    expect(f.store.stopQuiescenceFact(f.id)).toBeNull();
    expect(f.store.processesSummarized(f.id)).toBe(true);
  });

  test("inside the grace after it finished, Toolroll waits and looks at nothing", async () => {
    const f = fixture(new Date(Date.now() - 10 * MIN - 5_000));
    f.store.reserveRunProcess(f.id, new Date(f.start.getTime() + MIN));
    f.finish();
    const census = vi.fn(() => [service]);
    expect(await proveRunStopped(f.store, f.id, () => new Date(), { ...computer([service]).options, census })).toMatchObject({ outcome: "waiting" });
    expect(census).not.toHaveBeenCalled();
    expect(await proveFinishedRunsStopped(f.store, () => new Date(), { ...computer([service]).options, census })).toEqual([]);
  });

  test("a machine-run check never claims an agent start", () => {
    // The prepared-candidate road spawns no provider: only the gateway stamps provider_started_at (invoke.ts).
    const f = fixture();
    expect(f.store.getRun(f.id)?.providerStartedAt).toBeNull();
  });
});

describe("attacks on the automatic stop proof", () => {
  test("a leftover holding the build's folder is found and stopped, then the run settles", async () => {
    const f = fixture();
    f.store.reserveRunProcess(f.id, new Date(f.start.getTime() + MIN));
    f.finish();
    const leftover: ProcessRow = { pid: fakePid(2), ppid: 1, pgid: fakePid(2), bornAt: f.start.getTime() + 3 * MIN, name: "vite", terminal: false };
    const child: ProcessRow = { pid: fakePid(3), ppid: fakePid(2), pgid: fakePid(2), bornAt: f.end.getTime() + 5 * MIN, name: "esbuild", terminal: false };
    const look = computer([service, leftover, child], { [leftover.pid]: join(f.worktree, "web") });
    const proved = await proveRunStopped(f.store, f.id, () => new Date(), look.options);
    expect(proved).toMatchObject({ outcome: "settled", stopped: 2 });
    expect(look.signals.map(([pid]) => pid).sort()).toEqual([leftover.pid, child.pid].sort());
    expect(ledger(f.store, "run processes stopped")).toEqual([expect.objectContaining({ runId: f.id, detail: expect.stringContaining("vite") })]);
    expect(f.store.stopQuiescenceFact(f.id)).toBeNull();
  });

  test("a leftover found only by its command line naming the folder is stopped; a longer folder's name is not the run's", async () => {
    expect(namesPath(`node /w/checkout/node_modules/.bin/vitest`, "/w/checkout")).toBe(true);
    expect(namesPath(`node /w/checkout-2/x.js`, "/w/checkout")).toBe(false);
    expect(namesPath(`cd=/w/checkout`, "/w/checkout")).toBe(true);
    const f = fixture();
    f.store.reserveRunProcess(f.id, new Date(f.start.getTime() + MIN));
    f.finish();
    const leftover: ProcessRow = { pid: fakePid(4), ppid: 1, pgid: fakePid(4), bornAt: f.start.getTime() + 4 * MIN, name: "node", terminal: false };
    const neighbour: ProcessRow = { pid: fakePid(5), ppid: 1, pgid: fakePid(5), bornAt: f.start.getTime() + 4 * MIN, name: "node", terminal: false };
    const look = computer([service, leftover, neighbour], {}, { [leftover.pid]: `node ${f.worktree}/node_modules/.bin/vitest run`, [neighbour.pid]: `node ${f.worktree}-other/server.js` });
    expect(await proveRunStopped(f.store, f.id, () => new Date(), look.options)).toMatchObject({ outcome: "settled" });
    expect(look.signals.map(([pid]) => pid)).toEqual([leftover.pid]);
  });

  test("a pid reused by an unrelated process is never signalled, in the folder or not", async () => {
    const f = fixture();
    const old = fakePid(6);
    // A recorded process of the run, still open; its number now belongs to a process born after the run ended.
    f.store.recordRunProcess(f.id, old, new Date(f.start.getTime() + MIN), false);
    f.store.reserveRunProcess(f.id, new Date(f.start.getTime() + 2 * MIN));
    f.finish();
    const reuser: ProcessRow = { pid: old, ppid: 1, pgid: old, bornAt: f.end.getTime() + 2 * MIN, name: "zsh", terminal: false };
    const later: ProcessRow = { pid: fakePid(7), ppid: 1, pgid: fakePid(7), bornAt: f.end.getTime() + 3 * MIN, name: "node", terminal: false };
    const look = computer([service, reuser, later], { [reuser.pid]: f.worktree, [later.pid]: f.worktree });
    // The liveness probe sees the reused number alive; the proof itself never trusts a pid alone.
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && pid === old) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }) as typeof process.kill);
    await proveRunStopped(f.store, f.id, () => new Date(), look.options);
    expect(look.signals).toEqual([]);
  });

  test("something Toolroll didn't start in the folder is left alone: held, plainly, with Check again and nothing to vouch for", async () => {
    const f = fixture();
    f.store.reserveRunProcess(f.id, new Date(f.start.getTime() + MIN));
    f.finish();
    // A person's shell at a terminal, opened in the folder while the check ran, and an editor with a live parent.
    const shell: ProcessRow = { pid: fakePid(8), ppid: fakePid(9), pgid: fakePid(8), bornAt: f.start.getTime() + 2 * MIN, name: "zsh", terminal: true };
    const terminal: ProcessRow = { pid: fakePid(9), ppid: 1, pgid: fakePid(9), bornAt: f.start.getTime() - 60 * MIN, name: "Terminal", terminal: false };
    const editor: ProcessRow = { pid: fakePid(10), ppid: fakePid(9), pgid: fakePid(10), bornAt: f.start.getTime() + 3 * MIN, name: "code", terminal: false };
    const look = computer([service, terminal, shell, editor], { [shell.pid]: f.worktree, [editor.pid]: f.worktree });
    const proved = await proveRunStopped(f.store, f.id, () => new Date(), look.options);
    expect(proved.outcome).toBe("blocked");
    expect(look.signals).toEqual([]);
    const fact = f.store.stopQuiescenceFact(f.id);
    expect(fact).toMatchObject({ kind: "unknown", problem: expect.stringContaining("Toolroll didn't start it") });
    const need = processNeedOf(fact);
    expect(need).toEqual({ need: "stop-unproven", build: f.id });
    expect(NEEDS["stop-unproven"].action).toEqual({ code: "recheck-stopped", label: "Check again" });
    expect(NEEDS["stop-unproven"].sentence({ build: f.id })).not.toMatch(/confirm|vouch|nothing from it is running/i);
    // The same block is recorded once, however often it looks.
    await proveRunStopped(f.store, f.id, () => new Date(), look.options);
    expect(ledger(f.store, STOP_PROOF_BLOCKED)).toHaveLength(1);
    // The person closes their shell and editor: the next look proves it.
    look.set([service, terminal]);
    expect(await proveRunStopped(f.store, f.id, () => new Date(), look.options)).toMatchObject({ outcome: "settled" });
    expect(f.store.stopQuiescenceFact(f.id)).toBeNull();
  });

  test("when this computer can't look, the stop stays held with its reason; nothing is signalled or settled", async () => {
    const f = fixture();
    f.store.reserveRunProcess(f.id, new Date(f.start.getTime() + MIN));
    f.finish();
    const look = computer([service]);
    const proved = await proveRunStopped(f.store, f.id, () => new Date(), { ...look.options, cwds: () => { throw new Error("lsof timed out"); } });
    expect(proved.outcome).toBe("blocked");
    expect(f.store.stopQuiescenceFact(f.id)).toMatchObject({ kind: "unknown", problem: expect.stringContaining("can't be checked on this computer") });
    expect(processNeedOf(f.store.stopQuiescenceFact(f.id))).toEqual({ need: "stop-unproven", build: f.id });
    expect(ledger(f.store, STOP_PROOF_SETTLED)).toEqual([]);
  });

  test("another computer's run stays blocked here: a wait for that computer, no vouch, nothing signalled", async () => {
    const f = fixture();
    f.store.handle.prepare("INSERT INTO run_process (run,host,process_group,observed_at) VALUES (?,?,1,?)").run(f.id, "other-mac", new Date(f.start.getTime() + MIN).toISOString());
    f.finish();
    const fact = f.store.stopQuiescenceFact(f.id);
    expect(fact?.kind).toBe("elsewhere");
    expect(processNeedOf(fact)).toEqual({ wait: "other-computer", build: f.id });
    const look = computer([service]);
    expect((await proveRunStopped(f.store, f.id, () => new Date(), look.options)).outcome).toBe("skipped");
    expect(look.signals).toEqual([]);
    expect(f.store.stopQuiescenceFact(f.id)?.kind).toBe("elsewhere");
    // Its pid-less witness on another host with a local one: still another computer's word, never settled here.
    f.store.reserveRunProcess(f.id, new Date(f.start.getTime() + 2 * MIN));
    expect(await proveFinishedRunsStopped(f.store, () => new Date(), look.options)).toEqual([expect.objectContaining({ outcome: "skipped" })]);
    expect(f.store.stopQuiescenceFact(f.id)?.kind).toBe("elsewhere");
  });

  test("a run with no folder: an orphan born while it ran in one of its process groups holds it, untouched; none, and it settles", async () => {
    const f = fixture();
    const group = fakePid(11);
    f.store.handle.prepare("UPDATE run SET role = 'reviewer', branch = NULL, worktree = NULL WHERE id = ?").run(f.id);
    f.store.recordRunProcess(f.id, group, new Date(f.start.getTime() + MIN), true);
    f.store.handle.prepare("UPDATE run_process SET exited_at = ? WHERE run = ? AND pid = ?").run(new Date(f.start.getTime() + 2 * MIN).toISOString(), f.id, group);
    f.store.reserveRunProcess(f.id, new Date(f.start.getTime() + MIN));
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && Math.abs(pid) === group) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }) as typeof process.kill);
    f.finish();
    const member: ProcessRow = { pid: fakePid(12), ppid: 1, pgid: group, bornAt: f.start.getTime() + 3 * MIN, name: "node", terminal: false };
    const look = computer([service, member]);
    expect((await proveRunStopped(f.store, f.id, () => new Date(), look.options)).outcome).toBe("blocked");
    expect(look.signals).toEqual([]);
    look.set([service]);
    expect((await proveRunStopped(f.store, f.id, () => new Date(), look.options)).outcome).toBe("settled");
    expect(f.store.stopQuiescenceFact(f.id)).toBeNull();
  });

  test("a real orphaned leftover working in the folder is found with this computer's own process list and stopped", async () => {
    if (process.platform === "win32") return;
    const f = fixture(new Date(Date.now() - 5 * MIN));
    f.store.reserveRunProcess(f.id, new Date(f.start.getTime() + 1_000));
    // The leftover: a background process the check's shell left behind, reparented once that shell exited. Its own
    // process group, as every check command runs in (never this service's group, which is never a target).
    const shell = spawn("/bin/sh", ["-c", `cd "${f.worktree}" && (sleep 300 >/dev/null 2>&1 & echo $!)`], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    const pid = await new Promise<number>((resolve, reject) => {
      let out = "";
      shell.stdout!.on("data", chunk => { out += String(chunk); });
      shell.once("exit", () => resolve(Number(out.trim())));
      shell.once("error", reject);
    });
    started.push(pid);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    f.finish(new Date());
    const proved = await proveRunStopped(f.store, f.id, () => new Date(Date.now() + 2 * MIN), { graceMs: 2_000 });
    expect(proved, proved.words).toMatchObject({ outcome: "settled", stopped: 1 });
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
    expect(f.store.stopQuiescenceFact(f.id)).toBeNull();
  }, 60_000);
});
