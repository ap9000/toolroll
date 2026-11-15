/**
 * Process custody for Flexible threads (flexible-custody.ts; enable gate 1): which processes are a launch's, how they
 * are stopped, and when an exit counts as verified. The rules first, against a stand-in process table (pid reuse, the
 * group, witnesses, namespaces, the thread's folder, a reboot, freeze-before-kill); then real processes on this
 * machine (macOS and Linux alike, no sandbox: the native rows through the thread fence are
 * test/attacks/flexible-thread-custody.slow.test.ts): a setsid + double-forked survivor is found and stopped, one that
 * left the thread's folder is found by what the holder saw while it ran, and a program older than the launch working
 * in the thread's folder is never signalled and keeps custody unresolved.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { custodySettled, observeCustody, realCustodyIO, scanCustody, startIdentityOf, stopCustody, type CustodyIO, type LaunchCustody, type ProcRow } from "./flexible-custody.js";

const BOOT = "11111111-1111-4111-8111-111111111111";

/** A stand-in OS: a mutable process table, signals that freeze and kill rows, and a log of every signal. */
function fakeOS(rows: ProcRow[], options: { platform?: NodeJS.Platform; namespaces?: Record<number, string>; holders?: number[] | null; boot?: string | null; immortal?: number[] } = {}) {
  const table = new Map(rows.map(row => [row.pid, { ...row }]));
  const stopped = new Set<number>();
  const log: string[] = [];
  const io: CustodyIO = {
    platform: options.platform ?? "darwin",
    self: 1000,
    table: () => [...table.values()].map(row => ({ ...row })),
    namespaceOf: pid => pid === 1000 || table.has(pid) ? options.namespaces?.[pid] ?? "pid:[1]" : null,
    holdersOf: () => options.holders === null ? null : (options.holders ?? []).filter(pid => table.has(pid)),
    signal: (pid, signal, group = false) => {
      log.push(`${signal} ${group ? "-" : ""}${pid}`);
      const targets = group ? [...table.values()].filter(row => row.pgid === pid).map(row => row.pid) : table.has(pid) ? [pid] : [];
      if (targets.length === 0) return "gone";
      for (const target of targets) {
        if (signal === "SIGSTOP") stopped.add(target);
        if (signal === "SIGCONT") stopped.delete(target);
        if (signal === "SIGKILL" && !options.immortal?.includes(target)) table.delete(target);
      }
      return "sent";
    },
    bootId: () => options.boot === undefined ? BOOT : options.boot,
    sleep: async () => {},
  };
  return { io, table, stopped, log };
}
const row = (pid: number, over: Partial<ProcRow> = {}): ProcRow => ({ pid, ppid: 1, pgid: pid, uid: 501, start: "s1000", zombie: false, ...over });
const custody = (over: Partial<LaunchCustody> = {}): LaunchCustody => ({ host: "here", machineId: null, bootId: BOOT, leader: { pid: 500, start: "s1000" }, namespaces: [], witnesses: [], folder: "/state/threads/t", ...over });
const pids = (rows: readonly { pid: number }[]) => rows.map(one => one.pid);

describe("which processes are the launch's", () => {
  test("the leader's group, its descendants and its witnesses; never a reused pid, a process older than the leader, this process or a zombie", () => {
    const { io } = fakeOS([
      row(500), // the leader
      row(501, { ppid: 500, pgid: 500, start: "s1001" }), // in its group
      row(502, { ppid: 1, pgid: 500, start: "s0999" }), // in its group but older than the leader: not the agent's
      row(600, { ppid: 501, pgid: 600, start: "s1002" }), // left the group (setsid) while its parent lives
      row(700, { ppid: 1, pgid: 700, start: "s1003" }), // a witness: seen while it ran, now reparented
      row(701, { ppid: 1, pgid: 701, start: "s0500" }), // a witness's pid, reused by an older process
      row(1000, { ppid: 501, pgid: 500, start: "s1004" }), // this process
      row(503, { ppid: 500, pgid: 500, start: "s1005", zombie: true }),
    ]);
    const scan = scanCustody(custody({ witnesses: [{ pid: 700, start: "s1003" }, { pid: 701, start: "s1003" }] }), io);
    expect(pids(scan.members)).toEqual([500, 501, 600, 700]);
    expect(scan.incomplete).toBeNull();
  });

  test("a leader's number taken by another process: its group is no longer the launch's", () => {
    const { io } = fakeOS([row(500, { start: "s2000" }), row(501, { ppid: 500, pgid: 500, start: "s2001" })]);
    expect(pids(scanCustody(custody(), io).members)).toEqual([]);
  });

  test("a leader gone with its group left: the group is still the launch's (a group's number can't be reused while it has a member)", () => {
    const { io } = fakeOS([row(501, { ppid: 1, pgid: 500, start: "s1001" })]);
    expect(pids(scanCustody(custody(), io).members)).toEqual([501]);
  });

  test("Linux: every process in the launch's pid namespace, setsid and double-forked ones included; new namespaces are learned", () => {
    const { io } = fakeOS([row(500), row(510, { ppid: 500, pgid: 500, start: "s1001" }), row(800, { ppid: 1, pgid: 800, start: "s1002" }), row(900, { ppid: 1, pgid: 900, start: "s1002" })],
      { platform: "linux", namespaces: { 1000: "pid:[1]", 500: "pid:[1]", 510: "pid:[42]", 800: "pid:[42]", 900: "pid:[7]" } });
    const first = scanCustody(custody(), io);
    expect(pids(first.members)).toEqual([500, 510]);
    expect(first.namespaces).toEqual(["pid:[42]"]);
    // Recorded, the namespace finds the double-forked one too (and never another launch's).
    expect(pids(scanCustody(custody({ namespaces: ["pid:[42]"] }), io).members)).toEqual([500, 510, 800]);
  });

  test("the thread's folder: a process of the launch's age working there is the launch's; an older one is somebody else's and is never signalled", async () => {
    const os = fakeOS([row(500), row(600, { start: "s1002" }), row(601, { start: "s0001" })], { holders: [600, 601] });
    const scan = scanCustody(custody(), os.io);
    expect(pids(scan.members)).toEqual([500, 600]);
    expect(scan.outsiders).toEqual([601]);
    const stopped = await stopCustody(custody(), os.io);
    expect(stopped).toMatchObject({ verified: false, survivors: [], outsiders: [601], why: expect.stringContaining("isn't the agent's") });
    expect(os.log.filter(line => line.endsWith(" 601"))).toEqual([]);
    expect([...os.table.keys()]).toEqual([601]);
  });

  test("a table or listing that can't be read is never a verified exit", () => {
    expect(custodySettled(custody(), { ...fakeOS([]).io, table: () => null })).toMatchObject({ verified: false, why: "the process table couldn't be read" });
    expect(custodySettled(custody(), fakeOS([], { holders: null }).io)).toMatchObject({ verified: false, why: expect.stringContaining("couldn't be listed") });
  });
});

describe("stopping and proving the exit", () => {
  test("everything is frozen before anything is killed, then killed, then a scan finds none", async () => {
    const os = fakeOS([row(500), row(501, { ppid: 500, pgid: 500, start: "s1001" }), row(600, { ppid: 501, pgid: 600, start: "s1002" })]);
    expect(await stopCustody(custody(), os.io)).toMatchObject({ verified: true, how: "none-left" });
    const firstKill = os.log.findIndex(line => line.startsWith("SIGKILL"));
    expect(os.log.slice(0, firstKill).sort()).toEqual(["SIGSTOP 500", "SIGSTOP 501", "SIGSTOP 600"]);
    expect(os.log).toContain("SIGKILL -500");
    expect(os.table.size).toBe(0);
  });

  test("a process that can't be killed keeps custody unresolved, and is left running rather than frozen", async () => {
    const os = fakeOS([row(500), row(600, { ppid: 500, pgid: 600, start: "s1002" })], { immortal: [600] });
    const outcome = await stopCustody(custody(), os.io, { deadlineMs: 200 });
    expect(outcome).toMatchObject({ verified: false, survivors: [600] });
    expect(os.stopped.has(600)).toBe(false);
  });

  test("a reboot since the launch is a verified exit without a look; an unknown boot never is", async () => {
    const after = fakeOS([row(500)], { boot: "22222222-2222-4222-8222-222222222222" });
    expect(await stopCustody(custody({ host: (await import("node:os")).hostname() }), after.io)).toMatchObject({ verified: true, how: "boot-changed" });
    expect(after.log).toEqual([]);
    const unknown = fakeOS([row(500)], { boot: null });
    expect(custodySettled(custody({ host: (await import("node:os")).hostname() }), unknown.io)).toMatchObject({ verified: false });
  });
});

// ---- real processes -------------------------------------------------------------------------------------------------------

describe.runIf(process.platform === "darwin" || process.platform === "linux")("real processes on this machine", () => {
  let dir: string, folder: string;
  const children: ChildProcess[] = [];
  const io = realCustodyIO(() => null);
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-custody-")));
    folder = join(dir, "threads", "t");
    mkdirSync(join(folder, "repo"), { recursive: true });
  });
  afterEach(async () => {
    for (const child of children.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });

  /** A leader in a group of its own (as a thread launch is), running `script` in the thread's repository. */
  function leader(script: string): { pid: number; closed: Promise<void> } {
    const child = spawn("/bin/sh", ["-c", script], { cwd: join(folder, "repo"), detached: true, stdio: "ignore", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } });
    children.push(child);
    return { pid: child.pid!, closed: new Promise(done => child.once("close", () => done())) };
  }
  const until = async (test: () => boolean) => { for (let i = 0; i < 100 && !test(); i++) await new Promise(done => setTimeout(done, 100)); expect(test()).toBe(true); };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  /** setsid + double fork; the survivor writes its pid to `file`, then sleeps (in `cwd`, files closed when `leave`). */
  const survivor = (file: string, leave: boolean, delay = 0) =>
    `perl -MPOSIX -e 'sleep ${delay}; exit if fork; POSIX::setsid(); exit if fork; ${leave ? 'chdir "/"; POSIX::close($_) for 0..255; ' : ""}open(my $f, ">", "${file}"); print $f $$; close $f; sleep 30'`;
  const readPid = (file: string) => Number(readFileSync(file, "utf8"));

  test("a setsid + double-forked survivor left in the thread's folder is found after the agent exits, stopped, and the exit verified", async () => {
    const file = join(dir, "survivor.pid");
    const lead = leader(`${survivor(file, false)}; sleep 0.5`);
    await until(() => existsSync(file) && readPid(file) > 0);
    const start = startIdentityOf(lead.pid, io)!;
    expect(start).toMatch(/^[ts]\d+$/);
    const launch = custody({ host: "here", bootId: null, leader: { pid: lead.pid, start }, folder });
    await lead.closed; // the agent's own process is gone; the survivor isn't
    const pid = readPid(file);
    expect(alive(pid)).toBe(true);
    const found = custodySettled(launch, io);
    expect(found).toMatchObject({ verified: false });
    expect(found.verified === false && found.survivors).toContain(pid);
    expect(await stopCustody(launch, io)).toMatchObject({ verified: true, how: "none-left" });
    await until(() => !alive(pid));
  }, 30_000);

  test("one that left the thread's folder and closed every file is found by what the holder saw while it ran", async () => {
    const file = join(dir, "far.pid");
    // The survivor is visible as the agent's descendant for a while before it leaves (the holder looks every half second).
    // It forks off (in the agent's group for a second and a half, which the holder sees), then leaves the group (setsid),
    // the thread's folder and every open file.
    const lead = leader(`perl -MPOSIX -e 'exit if fork; sleep 1.5; POSIX::setsid(); chdir "/"; POSIX::close($_) for 0..255; open(my $f, ">", "${file}"); print $f $$; close $f; sleep 30'; sleep 3`);
    const launch = custody({ host: "here", bootId: null, leader: { pid: lead.pid, start: startIdentityOf(lead.pid, io)! }, folder });
    let seen = launch;
    const watch = setInterval(() => { const more = observeCustody(seen, io); seen = { ...seen, witnesses: [...seen.witnesses, ...more.witnesses] }; }, 100);
    try {
      await until(() => existsSync(file) && readPid(file) > 0);
      await lead.closed;
    } finally { clearInterval(watch); }
    const pid = readPid(file);
    expect(alive(pid)).toBe(true);
    // Not by the group (setsid), the folder (it left) or ancestry (reparented): only as a witness.
    expect(pids(scanCustody(launch, io).members)).not.toContain(pid);
    expect(pids(scanCustody(seen, io).members)).toContain(pid);
    expect(await stopCustody(seen, io)).toMatchObject({ verified: true });
    await until(() => !alive(pid));
  }, 30_000);

  test("a program older than the launch working in the thread's folder is never signalled, and custody stays unresolved until it's gone", async () => {
    const outsider = leader("sleep 30");
    await new Promise(done => setTimeout(done, 1_100)); // a whole second older than the launch
    const lead = leader("sleep 0.2");
    const launch = custody({ host: "here", bootId: null, leader: { pid: lead.pid, start: startIdentityOf(lead.pid, io)! }, folder });
    await lead.closed;
    const outcome = await stopCustody(launch, io);
    expect(outcome).toMatchObject({ verified: false, outsiders: [outsider.pid] });
    expect(alive(outsider.pid)).toBe(true);
    process.kill(-outsider.pid, "SIGKILL");
    await outsider.closed;
    expect(custodySettled(launch, io)).toMatchObject({ verified: true });
  }, 30_000);
});
