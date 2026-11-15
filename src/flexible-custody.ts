/**
 * Process custody for Flexible threads (the Flexible plan v2 §5 and Codex round 2 item 10; F2 breakdown, enable gate 1
 * "full process custody", slice F2c): finding every process a thread's agent left behind, stopping them, and proving
 * the whole tree has exited before a relaunch, a lowered level, a removal or a project's deletion goes on.
 *
 * A launch is known by a durable identity, never a bare pid: the boot it started in (boot-identity.ts), the leader's
 * pid AND start identity (a reused number never reads as the agent), the Linux pid namespaces the sandbox made for it,
 * and every descendant seen while it ran (pid and start identity, recorded as they appear). A process is the launch's
 * when any of these holds:
 *   - it is in the leader's process group (while the leader is the launch's own, or its number is free: a group's
 *     number can't be reused while the group has a member), and it was born no earlier than the leader;
 *   - Linux: it is in one of the launch's pid namespaces (bubblewrap --unshare-pid). A setsid or double-forked process
 *     can't leave a pid namespace, and when the namespace's first process dies the kernel kills every other member,
 *     so a namespace with no member left is a verified exit of everything inside it;
 *   - it is a recorded witness (the same pid with the same start identity);
 *   - its parent is one of the above (a setsid child whose parent still runs);
 *   - its working folder, or a file it holds open, is inside the thread's own folder (which no other launch can reach,
 *     agent-fence.ts denies the threads root to all of them) and it was born no earlier than the leader. One that is
 *     older is somebody else's program (a person's shell in that folder): it is never signalled, and custody refuses
 *     until it is gone.
 *
 * macOS has no pid namespace or cgroup Toolroll can use, and the environment of another process isn't readable there,
 * so a descendant that double-forks between two observations, leaves the thread's folder and closes every file in it is
 * not found (the same residual containment.ts names for builds). It stays inside the thread's Seatbelt fence (no
 * keychain, writes only to the thread's own folders), and the thread's proxy and relay are closed before anything is
 * stopped, so it has no network. Everything that can be found is found, and custody refuses while any of it survives.
 *
 * Nothing here decides who may stop a thread; it is the mechanism flexible-launch.ts calls under the thread's lock.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { provenDeadByBootChange } from "./boot-identity.js";

// ---- what custody knows about a launch -------------------------------------------------------------------------------

/** A process as the OS can name it again: its pid and when it started (Linux: start ticks since boot, `t<ticks>`;
 * macOS: ps lstart in UTC, `s<epoch seconds>`). */
export type ProcessWitness = { pid: number; start: string };
export type LaunchCustody = {
  host: string; machineId: string | null; bootId: string | null;
  /** The process group leader Toolroll spawned; null while the launch never got one (its start gate never opened). */
  leader: ProcessWitness | null;
  /** Linux pid namespaces seen in the launch (`pid:[inode]`). */
  namespaces: readonly string[];
  witnesses: readonly ProcessWitness[];
  /** The thread's own folder (its repository, temp and caches are inside it). */
  folder: string;
};

export type ProcRow = { pid: number; ppid: number; pgid: number; uid: number; start: string | null; zombie: boolean };

/** How custody reads and signals processes: the real OS (realCustodyIO), or a test's stand-in. */
export type CustodyIO = {
  platform: NodeJS.Platform;
  /** This process (never a member, never signalled). */
  self: number;
  /** Every process, or null when the table can't be read whole. */
  table(): ProcRow[] | null;
  /** Linux: the pid namespace a process is in (`pid:[inode]`); null when it is gone, "unreadable" when it can't be
   * read. Elsewhere always null. */
  namespaceOf(pid: number): string | null | "unreadable";
  /** Processes whose working folder or an open file is inside `folder`, or null when that can't be listed. */
  holdersOf(folder: string): number[] | null;
  /** Send a signal to a process (or, with group, its group): "gone" when there is none, "denied" when it isn't ours. */
  signal(pid: number, signal: NodeJS.Signals, group?: boolean): "sent" | "gone" | "denied";
  /** This boot's identity, or null when it can't be read. */
  bootId(): string | null;
  sleep(ms: number): Promise<void>;
};

// ---- start identities ----------------------------------------------------------------------------------------------------

/** A start identity as a number in its own unit (ticks on Linux, seconds on macOS), or null when it isn't one. */
function startValue(start: string | null): number | null {
  if (start === null) return null;
  const match = /^[ts](\d{1,20})$/.exec(start);
  return match === null ? null : Number(match[1]);
}
/** Whether `row` was born no earlier than the launch's leader (same unit: both come from this OS). Unknown is false:
 * a process whose age can't be read is never taken as the agent's by age alone. */
function bornSinceLeader(row: ProcRow, leader: ProcessWitness | null): boolean {
  if (leader === null) return false;
  const born = startValue(row.start), since = startValue(leader.start);
  return born !== null && since !== null && born >= since && row.start!.charAt(0) === leader.start.charAt(0);
}

// ---- finding the launch's processes ---------------------------------------------------------------------------------------

export type CustodyScan = {
  /** Live processes that are the launch's (never this process, never a zombie). */
  members: ProcRow[];
  /** Processes using the thread's folder that are provably older than the launch: somebody else's, never signalled. */
  outsiders: number[];
  /** Why the scan can't be complete (an unreadable process table or listing), or null. */
  incomplete: string | null;
  /** Namespaces and witnesses newly seen (to be recorded). */
  namespaces: string[];
  witnesses: ProcessWitness[];
};

/** The launch's processes now, by every rule above. Read-only. */
export function scanCustody(custody: LaunchCustody, io: CustodyIO, options: { holders?: boolean } = {}): CustodyScan {
  const rows = io.table();
  if (rows === null) return { members: [], outsiders: [], incomplete: "the process table couldn't be read", namespaces: [], witnesses: [] };
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const live = (row: ProcRow | undefined): row is ProcRow => row !== undefined && !row.zombie && row.pid !== io.self && row.pid > 1;
  const members = new Map<number, ProcRow>();
  const leader = custody.leader;
  // The leader's group: the leader is the launch's own (same start), or its number is free (no process holds it, so
  // no other group can have taken the number while the launch's group still has a member).
  if (leader !== null) {
    const holder = byPid.get(leader.pid);
    const groupOurs = holder === undefined || holder.start === leader.start;
    if (groupOurs) for (const row of rows) if (live(row) && row.pgid === leader.pid && (row.pid === leader.pid ? row.start === leader.start : bornSinceLeader(row, leader))) members.set(row.pid, row);
  }
  for (const witness of custody.witnesses) {
    const row = byPid.get(witness.pid);
    if (live(row) && row.start === witness.start) members.set(row.pid, row);
  }
  let incomplete: string | null = null;
  const namespaces = new Set(custody.namespaces);
  if (io.platform === "linux" && namespaces.size > 0) {
    for (const row of rows) {
      if (!live(row) || members.has(row.pid)) continue;
      const ns = io.namespaceOf(row.pid);
      if (ns === "unreadable") {
        // A process of this user whose namespace can't be read, born since the launch: it may be inside.
        if (row.uid === process.getuid?.() && bornSinceLeader(row, leader)) incomplete ??= `process ${row.pid}'s namespace couldn't be read`;
        continue;
      }
      if (ns !== null && namespaces.has(ns)) members.set(row.pid, row);
    }
  }
  // Descendants of members, through live parents (a setsid child whose parent still runs).
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (live(row) && !members.has(row.pid) && members.has(row.ppid)) { members.set(row.pid, row); grew = true; }
  }
  const outsiders: number[] = [];
  if (options.holders !== false) {
    const holding = io.holdersOf(custody.folder);
    if (holding === null) incomplete ??= "the programs using the thread's folder couldn't be listed";
    else {
      for (const pid of holding) {
        const row = byPid.get(pid);
        if (!live(row) || members.has(pid)) continue;
        if (bornSinceLeader(row, leader)) members.set(pid, row);
        else outsiders.push(pid);
      }
    }
  }
  // What to record: every member's identity, and on Linux every namespace a member is in other than this process's own.
  const known = new Set(custody.witnesses.map(one => `${one.pid}:${one.start}`));
  const witnesses = [...members.values()].filter(row => row.start !== null && !known.has(`${row.pid}:${row.start}`)).map(row => ({ pid: row.pid, start: row.start! }));
  const freshNamespaces: string[] = [];
  if (io.platform === "linux") {
    const own = io.namespaceOf(io.self);
    for (const row of members.values()) {
      const ns = io.namespaceOf(row.pid);
      if (typeof ns === "string" && ns !== "unreadable" && ns !== own && !namespaces.has(ns)) { namespaces.add(ns); freshNamespaces.push(ns); }
    }
  }
  return { members: [...members.values()].sort((a, b) => a.pid - b.pid), outsiders: outsiders.sort((a, b) => a - b), incomplete, namespaces: freshNamespaces, witnesses };
}

/** The leader's descendants by ancestry alone, as the holder watches a live launch (cheap: no listing of open files).
 * Returns what to record. */
export function observeCustody(custody: LaunchCustody, io: CustodyIO): { namespaces: string[]; witnesses: ProcessWitness[] } {
  const scan = scanCustody(custody, io, { holders: false });
  return { namespaces: scan.namespaces, witnesses: scan.witnesses };
}

// ---- stopping, and proving the exit ---------------------------------------------------------------------------------------

export type CustodyOutcome =
  | { verified: true; how: "boot-changed" | "none-left"; namespaces: string[]; witnesses: ProcessWitness[] }
  | { verified: false; survivors: number[]; outsiders: number[]; why: string; namespaces: string[]; witnesses: ProcessWitness[] };

/** Whether this boot is provably not the launch's (a reboot ends every process of the old one). */
function bootChanged(custody: LaunchCustody, io: CustodyIO): boolean {
  return provenDeadByBootChange({ host: custody.host, bootId: custody.bootId, machineId: custody.machineId }, { bootId: io.bootId() });
}

/** Whether every process of the launch has exited, without signalling anything. */
export function custodySettled(custody: LaunchCustody, io: CustodyIO): CustodyOutcome {
  if (bootChanged(custody, io)) return { verified: true, how: "boot-changed", namespaces: [], witnesses: [] };
  const scan = scanCustody(custody, io);
  if (scan.members.length === 0 && scan.outsiders.length === 0 && scan.incomplete === null) return { verified: true, how: "none-left", namespaces: scan.namespaces, witnesses: scan.witnesses };
  return { verified: false, survivors: scan.members.map(row => row.pid), outsiders: scan.outsiders, why: why(scan), namespaces: scan.namespaces, witnesses: scan.witnesses };
}

function why(scan: CustodyScan): string {
  if (scan.incomplete !== null) return scan.incomplete;
  if (scan.members.length > 0) return `${scan.members.length === 1 ? "1 of the agent's processes is" : `${scan.members.length} of the agent's processes are`} still running`;
  return `a program that isn't the agent's (process ${scan.outsiders.join(", ")}) is using the thread's folder`;
}

/**
 * Stop every process of the launch and prove they are gone. Freezes first (SIGSTOP, parents before their children are
 * read again, so nothing forks between the last look and the kill), looks again until nothing new appears, then kills
 * them all (SIGKILL; the leader's group as a whole while it is the launch's), and waits until a scan finds none, at
 * most `deadlineMs`. A process found only by the folder rule that is older than the launch is never signalled.
 */
export async function stopCustody(custody: LaunchCustody, io: CustodyIO, options: { deadlineMs?: number } = {}): Promise<CustodyOutcome> {
  if (bootChanged(custody, io)) return { verified: true, how: "boot-changed", namespaces: [], witnesses: [] };
  const deadline = Date.now() + (options.deadlineMs ?? 10_000);
  let current: LaunchCustody = custody;
  const seenNamespaces: string[] = [], seenWitnesses: ProcessWitness[] = [];
  const learn = (scan: CustodyScan) => {
    seenNamespaces.push(...scan.namespaces);
    seenWitnesses.push(...scan.witnesses);
    current = { ...current, namespaces: [...current.namespaces, ...scan.namespaces], witnesses: [...current.witnesses, ...scan.witnesses] };
  };
  const frozen = new Set<number>();
  // Listing every open file is slow (lsof on a Mac): the first look and the last are full; the looks between follow the
  // group, the namespaces, the ancestry and every process already found (each found one is a witness from then on).
  let full = true;
  for (;;) {
    const scan = scanCustody(current, io, { holders: full });
    learn(scan);
    const fresh = scan.members.filter(row => !frozen.has(row.pid));
    if (scan.members.length === 0) {
      if (!full) { full = true; continue; }
      if (scan.outsiders.length === 0 && scan.incomplete === null) return { verified: true, how: "none-left", namespaces: seenNamespaces, witnesses: seenWitnesses };
      return { verified: false, survivors: [], outsiders: scan.outsiders, why: why(scan), namespaces: seenNamespaces, witnesses: seenWitnesses };
    }
    full = false;
    if (fresh.length > 0) {
      // Freeze what is new, then look again: a process born during this look is caught by the next one.
      for (const row of fresh) if (io.signal(row.pid, "SIGSTOP") !== "denied") frozen.add(row.pid);
    } else {
      // Nothing new while everything is frozen: nothing can fork now. Kill all of it.
      const leader = current.leader;
      if (leader !== null && scan.members.some(row => row.pgid === leader.pid)) io.signal(leader.pid, "SIGKILL", true);
      for (const row of scan.members) io.signal(row.pid, "SIGKILL");
    }
    if (Date.now() >= deadline) {
      const last = scanCustody(current, io);
      learn(last);
      if (last.members.length === 0 && last.outsiders.length === 0 && last.incomplete === null) return { verified: true, how: "none-left", namespaces: seenNamespaces, witnesses: seenWitnesses };
      // Nothing is left frozen: a process custody couldn't end gets to run (and keeps the thread unresolved).
      for (const pid of frozen) io.signal(pid, "SIGCONT");
      return { verified: false, survivors: last.members.map(row => row.pid), outsiders: last.outsiders, why: why(last), namespaces: seenNamespaces, witnesses: seenWitnesses };
    }
    await io.sleep(fresh.length > 0 ? 20 : 100);
  }
}

// ---- the real OS ------------------------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** macOS: `ps` lstart (locale C, UTC) as epoch seconds, or null. */
function lstartSeconds(text: string): number | null {
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(text.trim());
  if (match === null) return null;
  const ms = Date.UTC(Number(match[6]), MONTHS.indexOf(match[1]!), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function macTable(): ProcRow[] | null {
  let text: string;
  try {
    text = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,uid=,stat=,lstart="], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    });
  } catch { return null; }
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (match === null) return null;
    const seconds = lstartSeconds(match[6]!);
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), uid: Number(match[4]), zombie: match[5]!.startsWith("Z"), start: seconds === null ? null : `s${seconds}` });
  }
  return rows;
}

function linuxRow(name: string): ProcRow | null | "gone" {
  let stat: string;
  try { stat = readFileSync(`/proc/${name}/stat`, "utf8"); }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ESRCH" ? "gone" : null; }
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  // After "(comm) ": state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime
  // priority nice num_threads itrealvalue starttime …
  if (close < 0 || fields.length < 20) return null;
  let uid: number;
  try { uid = statSync(`/proc/${name}`).uid; } catch { return "gone"; }
  return { pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), uid, zombie: fields[0] === "Z" || fields[0] === "X", start: /^\d+$/.test(fields[19]!) ? `t${fields[19]}` : null };
}

function linuxTable(): ProcRow[] | null {
  let names: string[];
  try { names = readdirSync("/proc").filter(name => /^\d+$/.test(name)); } catch { return null; }
  const rows: ProcRow[] = [];
  for (const name of names) {
    const row = linuxRow(name);
    if (row === "gone") continue;
    if (row === null) return null;
    rows.push(row);
  }
  return rows;
}

function linuxNamespace(pid: number): string | null | "unreadable" {
  try { return readlinkSync(`/proc/${pid}/ns/pid`); }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ESRCH" ? null : "unreadable"; }
}

const insideOf = (folder: string) => (path: string) => path === folder || path.startsWith(`${folder}/`);

function linuxHolders(folder: string): number[] | null {
  const inside = insideOf(folder);
  let names: string[];
  try { names = readdirSync("/proc").filter(name => /^\d+$/.test(name)); } catch { return null; }
  const found: number[] = [];
  const uid = process.getuid?.();
  for (const name of names) {
    const links: string[] = [];
    try {
      links.push(readlinkSync(`/proc/${name}/cwd`));
      for (const fd of readdirSync(`/proc/${name}/fd`)) { try { links.push(readlinkSync(`/proc/${name}/fd/${fd}`)); } catch { /* closed meanwhile */ } }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") continue;
      // Another user's process can't be read, and can't be the agent (it runs as this user).
      try { if (statSync(`/proc/${name}`).uid !== uid) continue; } catch { continue; }
      // A process of this user's that can't be read: the namespace rule covers a sandboxed one; one outside every
      // sandbox can't be inside the thread's folder without reading it, which the fence denies to everyone else.
      continue;
    }
    if (links.some(inside)) found.push(Number(name));
  }
  return found;
}

function macHolders(folder: string): number[] | null {
  const inside = insideOf(folder);
  // Every open file and working folder of this user's processes (-u), names only, no network or user lookups.
  const out = spawnSync("/usr/sbin/lsof", ["-n", "-P", "-w", "-u", String(process.getuid?.() ?? ""), "-F", "pn"], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C" }, timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024 * 1024,
  });
  // lsof exits 1 when it couldn't read some file; anything else (a signal, a timeout, an overflow) is no listing.
  if (out.error !== undefined || out.signal !== null || (out.status !== 0 && out.status !== 1)) return null;
  const found = new Set<number>();
  let pid = 0;
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0 && inside(line.slice(1))) found.add(pid);
  }
  return [...found];
}

/** The OS as custody sees it, on macOS and Linux. Elsewhere every read fails, so custody never verifies an exit. */
export function realCustodyIO(bootId: () => string | null): CustodyIO {
  const platform = process.platform;
  return {
    platform,
    self: process.pid,
    table: () => platform === "linux" ? linuxTable() : platform === "darwin" ? macTable() : null,
    namespaceOf: pid => platform === "linux" ? linuxNamespace(pid) : null,
    holdersOf: folder => platform === "linux" ? linuxHolders(folder) : platform === "darwin" ? macHolders(folder) : null,
    signal: (pid, signal, group = false) => {
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return "denied";
      try { process.kill(group ? -pid : pid, signal); return "sent"; }
      catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === "ESRCH" ? "gone" : "denied"; }
    },
    bootId,
    sleep: ms => new Promise(done => setTimeout(done, ms)),
  };
}

/** One process's start identity, read now (the leader's, as it is registered), or null when it can't be read. */
export function startIdentityOf(pid: number, io: Pick<CustodyIO, "table">): string | null {
  return io.table()?.find(row => row.pid === pid && !row.zombie)?.start ?? null;
}
