/**
 * Process custody for Flexible threads (flexible-custody.ts; enable gate 1): which processes are proven a launch's (and
 * may be signalled), which only block, how they are stopped, and when an exit counts as verified. The rules first,
 * against a stand-in process table (pid reuse, the group and its leader's continuity, witnesses, namespaces, the
 * thread's folder, a reboot, freeze-before-kill, a pid replaced between the scan and the signal); then real processes
 * on this machine (macOS and Linux alike, no sandbox: the native rows through the thread fence are
 * test/attacks/flexible-thread-custody.slow.test.ts): signals bound to identity, a survivor that left the group found as
 * a witness and stopped, and a program in the thread's folder (older or younger than the launch) never signalled.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePid } from "../test/fake-pid.js";
import { custodySettled, observeCustody, realCustodyIO, scanCustody, startIdentityOf, stopCustody, trustedPython, type CustodyIO, type LaunchCustody, type ProcRow, type ProcessWitness, type SignalResult } from "./flexible-custody.js";

const BOOT = "11111111-1111-4111-8111-111111111111";
/** A fake process by its place in the fixture: never a pid a real process can hold (test/fake-pid.ts). */
const P = (n: number) => fakePid(n);

/** A stand-in OS: a mutable process table, identity-bound signals that freeze and kill rows, and a log of every signal. */
function fakeOS(rows: ProcRow[], options: { platform?: NodeJS.Platform; namespaces?: Record<number, string>; holders?: number[] | null; boot?: string | null; immortal?: number[];
  /** Before a signal reaches it, this pid is replaced by a new process with this start identity (pid reuse). */
  replaceBeforeSignal?: { pid: number; start: string }; noIdentitySignals?: boolean; identityBound?: boolean } = {}) {
  const table = new Map(rows.map(row => [row.pid, { ...row }]));
  const stopped = new Set<number>();
  const log: string[] = [];
  const io: CustodyIO = {
    platform: options.platform ?? "darwin",
    self: P(1000),
    identityBound: options.identityBound ?? true,
    table: () => [...table.values()].map(row => ({ ...row })),
    namespaceOf: pid => pid === P(1000) || table.has(pid) ? options.namespaces?.[pid] ?? "pid:[4026531836]" : null,
    holdersOf: () => options.holders === null ? null : (options.holders ?? []).filter(pid => table.has(pid)),
    signal: (targets: readonly ProcessWitness[], signal) => {
      const results = new Map<number, SignalResult>();
      for (const target of targets) {
        if (options.noIdentitySignals) { results.set(target.pid, "unavailable"); continue; }
        const swap = options.replaceBeforeSignal;
        if (swap?.pid === target.pid && table.get(target.pid)?.start !== swap.start) table.set(target.pid, { ...table.get(target.pid)!, start: swap.start, pgid: P(9999), ppid: 1 });
        const now = table.get(target.pid);
        if (now === undefined) { results.set(target.pid, "gone"); continue; }
        if (now.start !== target.start) { results.set(target.pid, "changed"); continue; }
        log.push(`${signal} ${target.pid}`);
        if (signal === "SIGSTOP") stopped.add(target.pid);
        if (signal === "SIGCONT") stopped.delete(target.pid);
        if (signal === "SIGKILL" && !options.immortal?.includes(target.pid)) table.delete(target.pid);
        results.set(target.pid, "sent");
      }
      return results;
    },
    bootId: () => options.boot === undefined ? BOOT : options.boot,
    sleep: async () => {},
  };
  return { io, table, stopped, log };
}
const row = (pid: number, over: Partial<ProcRow> = {}): ProcRow => ({ pid, ppid: 1, pgid: pid, uid: 501, start: "s1000", zombie: false, ...over });
const custody = (over: Partial<LaunchCustody> = {}): LaunchCustody => ({ host: "here", machineId: null, bootId: BOOT, leader: { pid: P(500), start: "s1000" }, namespaces: [], witnesses: [], folder: "/state/threads/t", ...over });
const pids = (rows: readonly { pid: number }[]) => rows.map(one => one.pid);

describe("which processes are proven the launch's, and which only block", () => {
  test("the live leader's group, its descendants and its witnesses; never a reused pid, a process older than the leader, this process or a zombie", () => {
    const { io } = fakeOS([
      row(P(500)), // the leader
      row(P(501), { ppid: P(500), pgid: P(500), start: "s1001" }), // in its group
      row(P(502), { ppid: 1, pgid: P(500), start: "s0999" }), // in its group but older than the leader: not the agent's
      row(P(600), { ppid: P(501), pgid: P(600), start: "s1002" }), // left the group (setsid) while its parent lives
      row(P(700), { ppid: 1, pgid: P(700), start: "s1003" }), // a witness: seen while it ran, now reparented
      row(P(701), { ppid: 1, pgid: P(701), start: "s0500" }), // a witness's pid, reused by an older process
      row(P(1000), { ppid: P(501), pgid: P(500), start: "s1004" }), // this process
      row(P(503), { ppid: P(500), pgid: P(500), start: "s1005", zombie: true }),
    ]);
    const scan = scanCustody(custody({ witnesses: [{ pid: P(700), start: "s1003" }, { pid: P(701), start: "s1003" }] }), io);
    expect(pids(scan.members)).toEqual([P(500), P(501), P(600), P(700)]);
    expect(scan.blockers).toEqual([]);
  });

  test("a leader's number taken by another process: its group is no longer the launch's, and nothing in it is signalled", async () => {
    const os = fakeOS([row(P(500), { start: "s2000" }), row(P(501), { ppid: P(500), pgid: P(500), start: "s2001" })]);
    expect(pids(scanCustody(custody(), os.io).members)).toEqual([]);
    expect(await stopCustody(custody(), os.io)).toMatchObject({ verified: false, blockers: [{ pid: P(500), why: "orphaned-group" }, { pid: P(501), why: "orphaned-group" }] });
    expect(os.log).toEqual([]);
  });

  test("a leader gone with its group left: the group can't be proven the launch's (its number may have been reused), so it blocks and is never signalled", async () => {
    const os = fakeOS([row(P(501), { ppid: 1, pgid: P(500), start: "s1001" })]);
    const outcome = await stopCustody(custody(), os.io);
    expect(outcome).toMatchObject({ verified: false, survivors: [], blockers: [{ pid: P(501), why: "orphaned-group" }], why: expect.stringContaining(`process ${P(501)} is left in the agent's process group`) });
    expect(os.log).toEqual([]);
    // A witness of it, though, is proven: then it is stopped.
    expect(await stopCustody(custody({ witnesses: [{ pid: P(501), start: "s1001" }] }), os.io)).toMatchObject({ verified: true });
  });

  test("Linux: every process in the launch's pid namespace, setsid and double-forked ones included; new namespaces are learned", () => {
    const { io } = fakeOS([row(P(500)), row(P(510), { ppid: P(500), pgid: P(500), start: "s1001" }), row(P(800), { ppid: 1, pgid: P(800), start: "s1002" }), row(P(900), { ppid: 1, pgid: P(900), start: "s1002" })],
      { platform: "linux", namespaces: { [P(1000)]: "pid:[4026531836]", [P(500)]: "pid:[4026531836]", [P(510)]: "pid:[4026532042]", [P(800)]: "pid:[4026532042]", [P(900)]: "pid:[4026532007]" } });
    const first = scanCustody(custody(), io);
    expect(pids(first.members)).toEqual([P(500), P(510)]);
    expect(first.namespaces).toEqual(["pid:[4026532042]"]);
    expect(pids(scanCustody(custody({ namespaces: ["pid:[4026532042]"] }), io).members)).toEqual([P(500), P(510), P(800)]);
  });

  test("the thread's folder: anything working there that isn't proven the launch's blocks and is never signalled, whatever its age (a person's new shell)", async () => {
    const os = fakeOS([row(P(600), { start: "s1002" }), row(P(601), { start: "s0001" })], { holders: [P(600), P(601)] });
    const outcome = await stopCustody(custody({ leader: null }), os.io);
    expect(outcome).toMatchObject({ verified: false, survivors: [], blockers: [{ pid: P(600), why: "in-folder" }, { pid: P(601), why: "in-folder" }], why: expect.stringContaining("isn't proven to be the agent's") });
    expect(os.log).toEqual([]);
    expect([...os.table.keys()].sort()).toEqual([P(600), P(601)]);
  });

  test("two looks that disagree (a process in the folder the table didn't have) are never a verified exit", () => {
    const os = fakeOS([], { holders: [P(600)] });
    os.io.holdersOf = () => [P(600)]; // listed by lsof, absent from the process table read just before
    expect(custodySettled(custody({ leader: null }), os.io)).toMatchObject({ verified: false, why: `process ${P(600)} appeared while the scan ran` });
  });

  test("a table or listing that can't be read whole is never a verified exit", () => {
    expect(custodySettled(custody(), { ...fakeOS([]).io, table: () => null })).toMatchObject({ verified: false, why: "the process table couldn't be read" });
    expect(custodySettled(custody(), fakeOS([], { holders: null }).io)).toMatchObject({ verified: false, why: expect.stringContaining("couldn't all be listed") });
  });
});

describe("stopping, by identity, and proving the exit", () => {
  test("everything is frozen before anything is killed, each by its identity, then a scan finds none", async () => {
    const os = fakeOS([row(P(500)), row(P(501), { ppid: P(500), pgid: P(500), start: "s1001" }), row(P(600), { ppid: P(501), pgid: P(600), start: "s1002" })]);
    expect(await stopCustody(custody(), os.io)).toMatchObject({ verified: true, how: "none-left" });
    const firstKill = os.log.findIndex(line => line.startsWith("SIGKILL"));
    expect(os.log.slice(0, firstKill).sort()).toEqual([`SIGSTOP ${P(500)}`, `SIGSTOP ${P(501)}`, `SIGSTOP ${P(600)}`]);
    expect(os.log.filter(line => line.startsWith("SIGKILL")).sort()).toEqual([`SIGKILL ${P(500)}`, `SIGKILL ${P(501)}`, `SIGKILL ${P(600)}`]);
    expect(os.table.size).toBe(0);
  });

  test("a pid replaced by another process between the scan and the signal: the new one is never signalled", async () => {
    const os = fakeOS([row(P(500)), row(P(600), { ppid: P(500), pgid: P(600), start: "s1002" })], { replaceBeforeSignal: { pid: P(600), start: "s5000" } });
    const outcome = await stopCustody(custody(), os.io);
    expect(os.log.some(line => line.endsWith(` ${P(600)}`))).toBe(false);
    expect(os.table.get(P(600))?.start).toBe("s5000"); // the other process lives on
    expect(outcome.verified).toBe(true); // the scanned P(600) is gone; the newcomer was never the launch's
  });

  test("a pid signalled and later showing another start identity: a race was possible, so the exit is never called verified", async () => {
    const os = fakeOS([row(P(500)), row(P(600), { ppid: P(500), pgid: P(600), start: "s1002" })]);
    const real = os.io.signal;
    os.io.signal = (targets, signal) => {
      const results = real(targets, signal);
      // Right after the kill, the number is taken by an unrelated newer process.
      if (signal === "SIGKILL" && results.get(P(600)) === "sent") os.table.set(P(600), row(P(600), { start: "s6000", pgid: P(600) }));
      return results;
    };
    expect(await stopCustody(custody(), os.io)).toMatchObject({ verified: false, why: `process ${P(600)} was replaced by another while it was being stopped, so the stop can't be proven` });
  });

  test("macOS: a stop that signalled anything by a bare pid (start identity checked just before) is best effort, never fully verified; the leader through its own handle isn't", async () => {
    const os = fakeOS([row(P(500)), row(P(600), { ppid: P(500), pgid: P(600), start: "s1002" })], { identityBound: false });
    expect(await stopCustody(custody(), os.io)).toMatchObject({ verified: true, how: "best-effort" });
    const leaderOnly = fakeOS([row(P(500))], { identityBound: false });
    const handled: string[] = [];
    const outcome = await stopCustody(custody(), leaderOnly.io, { leaderSignal: signal => { handled.push(signal); if (signal === "SIGKILL") leaderOnly.table.delete(P(500)); return "sent"; } });
    expect(outcome).toMatchObject({ verified: true, how: "none-left" });
    expect(handled).toEqual(["SIGSTOP", "SIGKILL"]);
    expect(leaderOnly.log).toEqual([]); // nothing went to its pid
  });

  test("where no identity-bound signal can be sent, nothing is signalled and custody stays unresolved", async () => {
    const os = fakeOS([row(P(500))], { noIdentitySignals: true });
    expect(await stopCustody(custody(), os.io)).toMatchObject({ verified: false, why: expect.stringContaining("can't send a signal bound to a process's identity") });
    expect(os.table.has(P(500))).toBe(true);
  });

  test("a process that can't be killed keeps custody unresolved, and is left running rather than frozen", async () => {
    const os = fakeOS([row(P(500)), row(P(600), { ppid: P(500), pgid: P(600), start: "s1002" })], { immortal: [P(600)] });
    const outcome = await stopCustody(custody(), os.io, { deadlineMs: 200 });
    expect(outcome).toMatchObject({ verified: false, survivors: [P(600)] });
    expect(os.stopped.has(P(600))).toBe(false);
  });

  test("a reboot since the launch is a verified exit without a look; an unknown boot never is", async () => {
    const host = (await import("node:os")).hostname();
    const after = fakeOS([row(P(500))], { boot: "22222222-2222-4222-8222-222222222222" });
    expect(await stopCustody(custody({ host }), after.io)).toMatchObject({ verified: true, how: "boot-changed" });
    expect(after.log).toEqual([]);
    expect(custodySettled(custody({ host }), fakeOS([row(P(500))], { boot: null }).io)).toMatchObject({ verified: false });
  });
});

describe("the interpreter that sends Linux's identity-bound signals", () => {
  test("only from a fixed list of places, never PATH; a program anyone else can change is refused; none found means none", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "so-python-")));
    try {
      const planted = join(scratch, "bin");
      mkdirSync(planted, { mode: 0o755 });
      writeFileSync(join(planted, "python3"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(planted, "python3"), 0o755);
      const path = process.env["PATH"];
      process.env["PATH"] = `${planted}:${path ?? ""}`;
      try { expect(trustedPython([join(scratch, "nowhere", "python3")])).toBeNull(); } finally { process.env["PATH"] = path; }
      // A program in the list, but group-writable: refused.
      chmodSync(join(planted, "python3"), 0o775);
      expect(trustedPython([join(planted, "python3")])).toBeNull();
      // Owned by this user, writable by no one else, in a folder no one else can change: accepted.
      chmodSync(join(planted, "python3"), 0o755);
      expect(trustedPython([join(planted, "python3")])).toBe(join(planted, "python3"));
      chmodSync(planted, 0o777);
      expect(trustedPython([join(planted, "python3")])).toBeNull();
      chmodSync(planted, 0o755);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
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

  /** A process in a group of its own (as a thread launch is), running `script` in the thread's repository. */
  function leader(script: string, cwd = join(folder, "repo")): { pid: number; closed: Promise<void> } {
    const child = spawn("/bin/sh", ["-c", script], { cwd, detached: true, stdio: "ignore", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } });
    children.push(child);
    return { pid: child.pid!, closed: new Promise(done => child.once("close", () => done())) };
  }
  const until = async (test: () => boolean) => { for (let i = 0; i < 100 && !test(); i++) await new Promise(done => setTimeout(done, 100)); expect(test()).toBe(true); };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const readPid = (file: string) => Number(readFileSync(file, "utf8"));

  test("signals are bound to identity: a stale start identity is \"changed\" and nothing is sent; the right one is sent", async () => {
    const target = leader("sleep 30", dir);
    const start = startIdentityOf(target.pid, io)!;
    expect(start).toMatch(/^[ts]\d+$/);
    const stale = start.replace(/\d+$/, digits => String(Number(digits) - 5));
    const wrong = io.signal([{ pid: target.pid, start: stale }], "SIGKILL").get(target.pid);
    if (wrong === "unavailable") return void expect(process.platform).toBe("linux"); // no python3 3.9+: nothing sent, as required
    expect(wrong).toBe("changed");
    await new Promise(done => setTimeout(done, 200));
    expect(alive(target.pid)).toBe(true);
    expect(io.signal([{ pid: target.pid, start }], "SIGKILL").get(target.pid)).toBe("sent");
    await target.closed;
    expect(io.signal([{ pid: target.pid, start }], "SIGKILL").get(target.pid)).toBe("gone");
  }, 30_000);

  test("a setsid + double-forked survivor left in the thread's folder blocks custody (named) but is never signalled; once it's gone, the exit is verified", async () => {
    const file = join(dir, "survivor.pid");
    const lead = leader(`perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; open(my $f, ">", "${file}"); print $f $$; close $f; sleep 30'; sleep 0.5`);
    await until(() => existsSync(file) && readPid(file) > 0);
    const launch = custody({ host: "here", bootId: null, leader: { pid: lead.pid, start: startIdentityOf(lead.pid, io)! }, folder });
    await lead.closed;
    const pid = readPid(file);
    const outcome = await stopCustody(launch, io);
    expect(outcome).toMatchObject({ verified: false, survivors: [], blockers: [{ pid, why: "in-folder" }] });
    expect(alive(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
    await until(() => !alive(pid));
    expect(await stopCustody(launch, io)).toMatchObject({ verified: true, how: "none-left" });
  }, 30_000);

  test("one that left its group, the thread's folder and every open file is found as a witness of what the holder saw, and stopped", async () => {
    const file = join(dir, "far.pid");
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
    expect(pids(scanCustody(launch, io).members)).not.toContain(pid);
    expect(pids(scanCustody(seen, io).members)).toContain(pid);
    expect(await stopCustody(seen, io)).toMatchObject({ verified: true });
    await until(() => !alive(pid));
  }, 30_000);

  test("a person's program working in the thread's folder, opened after the launch began, is never signalled", async () => {
    const lead = leader("sleep 0.3");
    const launch = custody({ host: "here", bootId: null, leader: { pid: lead.pid, start: startIdentityOf(lead.pid, io)! }, folder });
    await new Promise(done => setTimeout(done, 1_100));
    const person = leader("sleep 30"); // younger than the launch, not its descendant
    await lead.closed;
    const outcome = await stopCustody(launch, io);
    expect(outcome).toMatchObject({ verified: false, blockers: [{ pid: person.pid, why: "in-folder" }] });
    expect(alive(person.pid)).toBe(true);
    process.kill(-person.pid, "SIGKILL");
    await person.closed;
    expect(custodySettled(launch, io)).toMatchObject({ verified: true });
  }, 30_000);
});
