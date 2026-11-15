/**
 * Process custody for Flexible threads (the Flexible plan v2 §5 and Codex round 2 item 10; F2 breakdown, enable gate 1
 * "full process custody", slice F2c): finding every process a thread's agent left behind, stopping the ones proven to
 * be its own, and proving the whole tree has exited before a relaunch, a lowered level, a removal or a project's
 * deletion goes on.
 *
 * A launch is known by a durable identity, never a bare pid: the boot it started in (boot-identity.ts), the leader's
 * pid AND start identity (a reused number never reads as the agent), the Linux pid namespaces the sandbox made for it,
 * and every descendant seen while it ran (pid and start identity, recorded as they appear).
 *
 * Proven the launch's (and only these are ever signalled):
 *   - the leader itself (its pid with its start identity);
 *   - a member of the leader's process group while the leader is alive with its start identity (continuity is proven
 *     by the leader, never by its pid being free: a free number may have been reused for another group), born no
 *     earlier than the leader;
 *   - Linux: a process in one of the launch's pid namespaces (bubblewrap --unshare-pid). A setsid or double-forked
 *     process can't leave a pid namespace, and when the namespace's first process dies the kernel kills every other
 *     member, so a namespace with no member left is a verified exit of everything inside it;
 *   - a recorded witness (the same pid with the same start identity);
 *   - a process whose live parent is one of the above (a setsid child whose parent still runs).
 * Not proven, so never signalled, but blocking (custody stays unresolved and says which process, until it is gone): a
 * process working in or holding a file in the thread's own folder (it may be a person's shell or editor), and a member
 * of the leader's group once the leader is gone (the group number may have been reused).
 *
 * Every signal is bound to the identity it was scanned with. Linux: a pidfd (pidfd_open, the start identity checked
 * through it, pidfd_send_signal), so a reused pid can't be hit; where this computer can't do that, nothing is signalled
 * and custody is unresolved. macOS has no identity-bound handle: each target's start identity is read again
 * immediately before its signal, and a mismatch is "not ours". The window between that read and the signal remains (an
 * unrelated process is hit only if its pid was recycled in that instant), so a macOS stop that sent any such signal is
 * recorded "best-effort", never fully verified (the owner's decision: macOS custody is best effort); any pid custody
 * signalled that later shows another start identity is a race seen, and the exit is unresolved. The leader itself is
 * signalled through the child handle Toolroll holds, where this process spawned it.
 *
 * macOS has no pid namespace or cgroup Toolroll can use, and another process's environment isn't readable there, so a
 * descendant that double-forks between two observations, leaves the thread's folder and closes every file in it is not
 * found (the same residual containment.ts names for builds). It stays inside the thread's Seatbelt fence, and the
 * thread's proxy and relay are closed before anything is stopped. Whether that residual is acceptable is the owner's
 * decision (Codex round 1 on F2c, finding 1); until then a scan that couldn't be complete (an unreadable table, an
 * lsof listing that wasn't whole) is never a verified exit.
 *
 * Nothing here decides who may stop a thread; it is the mechanism flexible-launch.ts calls under the thread's lock.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
/** What a signal bound to an identity did: sent to exactly that process; it was gone; its pid now names another process
 * (nothing sent); not allowed; or this computer can't send an identity-bound signal (nothing sent). */
export type SignalResult = "sent" | "gone" | "changed" | "denied" | "unavailable";

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
  /** Processes whose working folder or an open file is inside `folder`, or null when that can't be listed whole. */
  holdersOf(folder: string): number[] | null;
  /** Send `signal` to each process, checked against its identity (pid AND start identity) first. */
  signal(targets: readonly ProcessWitness[], signal: NodeJS.Signals): Map<number, SignalResult>;
  /** Whether `signal` is bound to the identity through the signal itself (Linux pidfd), or only checked just before a
   * signal sent to the bare pid (macOS: a stop that needed one is best effort, never fully verified). */
  identityBound: boolean;
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
/** Whether `row` was born no earlier than the launch's leader (same unit: both come from this OS). Unknown is false. */
function bornSinceLeader(row: ProcRow, leader: ProcessWitness | null): boolean {
  if (leader === null) return false;
  const born = startValue(row.start), since = startValue(leader.start);
  return born !== null && since !== null && born >= since && row.start!.charAt(0) === leader.start.charAt(0);
}

// ---- finding the launch's processes ---------------------------------------------------------------------------------------

/** A process custody won't signal, and why it keeps custody unresolved. */
export type CustodyBlocker = { pid: number; why: "in-folder" | "orphaned-group" | "unidentified" };
export type CustodyScan = {
  /** Live processes proven the launch's (never this process, never a zombie, each with its start identity). */
  members: (ProcRow & { start: string })[];
  /** Live processes that may be the launch's or may be somebody else's: never signalled, never a verified exit. */
  blockers: CustodyBlocker[];
  /** Why the scan can't be complete (an unreadable process table or listing), or null. */
  incomplete: string | null;
  /** Namespaces and witnesses newly seen (to be recorded). */
  namespaces: string[];
  witnesses: ProcessWitness[];
  /** The table the scan read (to tell a replaced pid later). */
  table: ProcRow[];
};

/** The launch's processes now, by every rule above. Read-only. */
export function scanCustody(custody: LaunchCustody, io: CustodyIO, options: { holders?: boolean } = {}): CustodyScan {
  const rows = io.table();
  if (rows === null) return { members: [], blockers: [], incomplete: "the process table couldn't be read", namespaces: [], witnesses: [], table: [] };
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const live = (row: ProcRow | undefined): row is ProcRow => row !== undefined && !row.zombie && row.pid !== io.self && row.pid > 1;
  const members = new Map<number, ProcRow>();
  const blockers = new Map<number, CustodyBlocker["why"]>();
  const leader = custody.leader;
  if (leader !== null) {
    const holder = byPid.get(leader.pid);
    const leaderLives = live(holder) && holder.start === leader.start;
    for (const row of rows) {
      if (!live(row) || row.pgid !== leader.pid) continue;
      // The group is proven the launch's only while its leader is (same pid, same start identity).
      if (leaderLives && (row.pid === leader.pid || bornSinceLeader(row, leader))) members.set(row.pid, row);
      else if (!leaderLives && bornSinceLeader(row, leader)) blockers.set(row.pid, "orphaned-group");
    }
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
  if (options.holders !== false) {
    const holding = io.holdersOf(custody.folder);
    if (holding === null) incomplete ??= "the programs using the thread's folder couldn't all be listed";
    else for (const pid of holding) {
      if (pid === io.self) continue;
      const row = byPid.get(pid);
      // The two looks disagree (a process in the folder the table didn't have): it was born or the table was stale while
      // the scan ran, so the scan can't be called complete.
      if (row === undefined) { incomplete ??= `process ${pid} appeared while the scan ran`; continue; }
      if (live(row) && !members.has(pid)) blockers.set(pid, "in-folder");
    }
  }
  // A member whose start identity can't be read can't be signalled by identity: it blocks instead.
  for (const [pid, row] of members) if (row.start === null) { members.delete(pid); blockers.set(pid, "unidentified"); }
  for (const pid of members.keys()) blockers.delete(pid);
  const known = new Set(custody.witnesses.map(one => `${one.pid}:${one.start}`));
  const proven = [...members.values()] as (ProcRow & { start: string })[];
  const witnesses = proven.filter(row => !known.has(`${row.pid}:${row.start}`)).map(row => ({ pid: row.pid, start: row.start }));
  const freshNamespaces: string[] = [];
  if (io.platform === "linux") {
    const own = io.namespaceOf(io.self);
    for (const row of proven) {
      const ns = io.namespaceOf(row.pid);
      if (typeof ns === "string" && ns !== "unreadable" && ns !== own && !namespaces.has(ns)) { namespaces.add(ns); freshNamespaces.push(ns); }
    }
  }
  return { members: proven.sort((a, b) => a.pid - b.pid), blockers: [...blockers].map(([pid, why]) => ({ pid, why })).sort((a, b) => a.pid - b.pid), incomplete, namespaces: freshNamespaces, witnesses, table: rows };
}

/** The leader's descendants by ancestry alone, as the holder watches a live launch (cheap: no listing of open files).
 * Returns what to record. */
export function observeCustody(custody: LaunchCustody, io: CustodyIO): { namespaces: string[]; witnesses: ProcessWitness[] } {
  const scan = scanCustody(custody, io, { holders: false });
  return { namespaces: scan.namespaces, witnesses: scan.witnesses };
}

// ---- stopping, and proving the exit ---------------------------------------------------------------------------------------

export type CustodyOutcome =
  /** none-left: every process was stopped by identity-bound signals (or none needed one) and a full scan found none;
   * best-effort (macOS): the same, but a signal went to a bare pid after its start identity was checked, so an unrelated
   * process could have been hit only if that pid was recycled in the instant between the check and the signal. */
  | { verified: true; how: "boot-changed" | "none-left" | "best-effort"; namespaces: string[]; witnesses: ProcessWitness[] }
  | { verified: false; survivors: number[]; blockers: CustodyBlocker[]; why: string; namespaces: string[]; witnesses: ProcessWitness[] };

/** Whether this boot is provably not the launch's (a reboot ends every process of the old one). */
function bootChanged(custody: LaunchCustody, io: CustodyIO): boolean {
  return provenDeadByBootChange({ host: custody.host, bootId: custody.bootId, machineId: custody.machineId }, { bootId: io.bootId() });
}

const BLOCKER_WORDS: Readonly<Record<CustodyBlocker["why"], string>> = Object.freeze({
  "in-folder": "is using the thread's folder and isn't proven to be the agent's, so it wasn't stopped. Close it, then try again",
  "orphaned-group": "is left in the agent's process group after the agent ended, and can't be proven to be the agent's, so it wasn't stopped. Stop it, then try again",
  "unidentified": "couldn't be identified well enough to stop safely. Stop it, then try again",
});

/** Why custody isn't settled, in one line. */
function why(scan: Pick<CustodyScan, "members" | "blockers" | "incomplete">, problem: string | null): string {
  if (problem !== null) return problem;
  if (scan.incomplete !== null) return scan.incomplete;
  if (scan.members.length > 0) return `${scan.members.length === 1 ? "1 of the agent's processes is" : `${scan.members.length} of the agent's processes are`} still running`;
  const first = scan.blockers[0]!;
  return `process ${first.pid} ${BLOCKER_WORDS[first.why]}${scan.blockers.length > 1 ? ` (and ${scan.blockers.length - 1} more)` : ""}`;
}

/** Whether every process of the launch has exited, without signalling anything. */
export function custodySettled(custody: LaunchCustody, io: CustodyIO): CustodyOutcome {
  if (bootChanged(custody, io)) return { verified: true, how: "boot-changed", namespaces: [], witnesses: [] };
  const scan = scanCustody(custody, io);
  if (scan.members.length === 0 && scan.blockers.length === 0 && scan.incomplete === null) return { verified: true, how: "none-left", namespaces: scan.namespaces, witnesses: scan.witnesses };
  return { verified: false, survivors: scan.members.map(row => row.pid), blockers: scan.blockers, why: why(scan, null), namespaces: scan.namespaces, witnesses: scan.witnesses };
}

/**
 * Stop every process proven the launch's and prove they are gone. Freezes first (SIGSTOP, each bound to its identity),
 * looks again until nothing new appears, then kills them all (SIGKILL, each bound to its identity; never the group as a
 * number), and waits until a scan finds none, at most `deadlineMs`. A process that only blocks (in the thread's folder,
 * left in an ended leader's group) is never signalled. Unresolved, never verified, when: anything blocks, the scan
 * can't be complete, this computer can't send an identity-bound signal, or a pid custody signalled now names another
 * process (a race was possible).
 */
export async function stopCustody(custody: LaunchCustody, io: CustodyIO, options: { deadlineMs?: number;
  /** The leader's own handle, where this process spawned it: its signals go there, never to its pid. */
  leaderSignal?: (signal: NodeJS.Signals) => SignalResult } = {}): Promise<CustodyOutcome> {
  if (bootChanged(custody, io)) return { verified: true, how: "boot-changed", namespaces: [], witnesses: [] };
  const deadline = Date.now() + (options.deadlineMs ?? 10_000);
  let current: LaunchCustody = custody;
  const seenNamespaces: string[] = [], seenWitnesses: ProcessWitness[] = [];
  const learn = (scan: CustodyScan) => {
    seenNamespaces.push(...scan.namespaces);
    seenWitnesses.push(...scan.witnesses);
    current = { ...current, namespaces: [...current.namespaces, ...scan.namespaces], witnesses: [...current.witnesses, ...scan.witnesses] };
  };
  const frozen = new Map<number, string>();
  const signalled = new Map<number, string>();
  let problem: string | null = null;
  let bare = false;
  const send = (targets: readonly ProcessWitness[], signal: NodeJS.Signals): Map<number, SignalResult> => {
    const leader = custody.leader;
    const viaHandle = options.leaderSignal !== undefined && leader !== null ? targets.find(one => one.pid === leader.pid && one.start === leader.start) : undefined;
    const rest = viaHandle === undefined ? targets : targets.filter(one => one !== viaHandle);
    const results = rest.length > 0 ? io.signal(rest, signal) : new Map<number, SignalResult>();
    if (viaHandle !== undefined) results.set(viaHandle.pid, options.leaderSignal!(signal));
    for (const target of targets) {
      const result = results.get(target.pid) ?? "unavailable";
      if (result === "sent" && target !== viaHandle && !io.identityBound) bare = true;
      if (result === "sent") signalled.set(target.pid, target.start);
      if (result === "unavailable") problem ??= "this computer can't send a signal bound to a process's identity, so nothing was stopped";
    }
    return results;
  };
  /** A pid custody signalled that now names another process: a race was possible. */
  const raced = (table: readonly ProcRow[]): string | null => {
    for (const row of table) {
      const was = signalled.get(row.pid);
      if (was !== undefined && row.start !== was) return `process ${row.pid} was replaced by another while it was being stopped, so the stop can't be proven`;
    }
    return null;
  };
  const unresolved = (scan: CustodyScan): CustodyOutcome => {
    for (const [pid, start] of frozen) if (scan.members.some(row => row.pid === pid && row.start === start)) io.signal([{ pid, start }], "SIGCONT");
    return { verified: false, survivors: scan.members.map(row => row.pid), blockers: scan.blockers, why: why(scan, problem), namespaces: seenNamespaces, witnesses: seenWitnesses };
  };
  // Listing every open file is slow (lsof on a Mac): the first look and the last are full; the looks between follow the
  // group, the namespaces, the ancestry and every process already found (each found one is a witness from then on).
  let full = true;
  for (;;) {
    const scan = scanCustody(current, io, { holders: full });
    learn(scan);
    problem ??= raced(scan.table);
    if (problem !== null) return unresolved(scan);
    if (scan.members.length === 0) {
      if (!full) { full = true; continue; }
      if (scan.blockers.length === 0 && scan.incomplete === null) return { verified: true, how: bare ? "best-effort" : "none-left", namespaces: seenNamespaces, witnesses: seenWitnesses };
      return unresolved(scan);
    }
    full = false;
    const notYetFrozen = scan.members.filter(row => frozen.get(row.pid) !== row.start);
    if (notYetFrozen.length > 0) {
      // Freeze what is new, then look again: a process born during this look is caught by the next one.
      const results = send(notYetFrozen, "SIGSTOP");
      for (const row of notYetFrozen) if (results.get(row.pid) === "sent") frozen.set(row.pid, row.start);
    } else {
      // Nothing new while everything is frozen: nothing can fork now. Kill all of it, each by its identity.
      send(scan.members, "SIGKILL");
    }
    if (problem !== null) return unresolved(scan);
    if (Date.now() >= deadline) {
      const last = scanCustody(current, io);
      learn(last);
      problem ??= raced(last.table);
      if (problem === null && last.members.length === 0 && last.blockers.length === 0 && last.incomplete === null) return { verified: true, how: bare ? "best-effort" : "none-left", namespaces: seenNamespaces, witnesses: seenWitnesses };
      return unresolved(last);
    }
    await io.sleep(notYetFrozen.length > 0 ? 20 : 100);
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

/** The /proc reads a Linux table makes (the real ones by default; a test's stand-in). */
export type ProcFs = { readdir: (path: string) => string[]; readFile: (path: string) => string; statUid: (path: string) => number };
const REAL_PROC_FS: ProcFs = { readdir: path => readdirSync(path), readFile: path => readFileSync(path, "utf8"), statUid: path => statSync(path).uid };
/** Only these say a process is gone; any other error (EACCES, EIO, …) says nothing about it: unknown. */
const goneCode = (error: unknown): boolean => { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ESRCH"; };

function linuxRow(name: string, fs: ProcFs = REAL_PROC_FS): ProcRow | null | "gone" {
  let stat: string;
  try { stat = fs.readFile(`/proc/${name}/stat`); }
  catch (error) { return goneCode(error) ? "gone" : null; }
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  // After "(comm) ": state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime
  // priority nice num_threads itrealvalue starttime …
  if (close < 0 || fields.length < 20) return null;
  let uid: number;
  try { uid = fs.statUid(`/proc/${name}`); } catch (error) { return goneCode(error) ? "gone" : null; }
  return { pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), uid, zombie: fields[0] === "Z" || fields[0] === "X", start: /^\d+$/.test(fields[19]!) ? `t${fields[19]}` : null };
}

/** Every process from /proc, or null when it can't be read whole (a process that can't be read, for any reason but its
 * being gone, makes the whole table unreadable). */
export function linuxTable(fs: ProcFs = REAL_PROC_FS): ProcRow[] | null {
  let names: string[];
  try { names = fs.readdir("/proc").filter(name => /^\d+$/.test(name)); } catch { return null; }
  const rows: ProcRow[] = [];
  for (const name of names) {
    const row = linuxRow(name, fs);
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
  // Only a whole listing counts: lsof exits 1 when it couldn't read some process or file, and anything else (a signal, a
  // timeout, an overflow) is no listing. Either way the scan is incomplete, never a verified exit.
  if (out.error !== undefined || out.signal !== null || out.status !== 0) return null;
  const found = new Set<number>();
  let pid = 0;
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0 && inside(line.slice(1))) found.add(pid);
  }
  return [...found];
}

/** Linux: each signal through a pidfd, the start identity checked through it first (pidfd_open pins the process, so the
 * check and the signal are about the same one, whatever happens to the number). Node has no pidfd call, so a short
 * Python helper (3.9+, isolated mode) does it; without one, nothing is signalled ("unavailable"). */
const PIDFD_HELPER = `
import json, os, signal, sys
request = json.load(sys.stdin)
out = {}
for target in request["targets"]:
    pid, start = target["pid"], target["start"]
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        out[str(pid)] = "gone"; continue
    except OSError:
        out[str(pid)] = "denied"; continue
    try:
        try:
            with open("/proc/%d/stat" % pid) as handle: stat = handle.read()
        except OSError:
            out[str(pid)] = "gone"; continue
        fields = stat[stat.rindex(")") + 2:].split()
        if "t" + fields[19] != start:
            out[str(pid)] = "changed"; continue
        try:
            signal.pidfd_send_signal(fd, request["signal"]); out[str(pid)] = "sent"
        except ProcessLookupError:
            out[str(pid)] = "gone"
        except OSError:
            out[str(pid)] = "denied"
    finally:
        os.close(fd)
print(json.dumps(out))
`;
/** Where a trusted Python may be, in order: never found through PATH (which a build or a person's shell can change). */
export const TRUSTED_PYTHONS: readonly string[] = Object.freeze(["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]);
let pinnedPython: string | null | undefined;
/** The first of TRUSTED_PYTHONS that is a real program owned by root or this user, that no one else can change (the
 * file and its folder not group- or world-writable), resolved once per Toolroll process and pinned; null when none. */
export function trustedPython(candidates: readonly string[] = TRUSTED_PYTHONS): string | null {
  if (pinnedPython !== undefined && candidates === TRUSTED_PYTHONS) return pinnedPython;
  const uid = process.getuid?.();
  const safe = (path: string): boolean => { try { const held = statSync(path); return (held.uid === 0 || held.uid === uid) && (held.mode & 0o022) === 0; } catch { return false; } };
  let found: string | null = null;
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (statSync(real).isFile() && (statSync(real).mode & 0o111) !== 0 && safe(real) && safe(dirname(real))) { found = real; break; }
    } catch { /* not there */ }
  }
  if (candidates === TRUSTED_PYTHONS) pinnedPython = found;
  return found;
}

function linuxSignal(targets: readonly ProcessWitness[], signal: NodeJS.Signals): Map<number, SignalResult> {
  const results = new Map<number, SignalResult>(targets.map(one => [one.pid, "unavailable"]));
  if (targets.length === 0) return results;
  const python = trustedPython();
  if (python === null) return results;
  const ran = spawnSync(python, ["-I", "-c", PIDFD_HELPER], { input: JSON.stringify({ targets, signal: constants.signals[signal] }), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  if (ran.error !== undefined || ran.status !== 0) return results;
  try {
    const answer = JSON.parse(ran.stdout) as Record<string, unknown>;
    for (const one of targets) {
      const said = answer[String(one.pid)];
      if (said === "sent" || said === "gone" || said === "changed" || said === "denied") results.set(one.pid, said);
    }
  } catch { /* an unreadable answer: every target stays "unavailable" */ }
  return results;
}

/** macOS: no identity-bound handle exists. Each target's start identity is read again just before its signal and a
 * mismatch is "changed" (nothing sent). The window between that read and the signal remains (stopCustody refuses to
 * call an exit verified when a signalled pid later shows another start identity). */
function macSignal(targets: readonly ProcessWitness[], signal: NodeJS.Signals): Map<number, SignalResult> {
  const results = new Map<number, SignalResult>();
  for (const one of targets) {
    const ran = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(one.pid)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, timeout: 2_000, killSignal: "SIGKILL" });
    if (ran.error !== undefined || ran.signal !== null) { results.set(one.pid, "unavailable"); continue; }
    const seconds = ran.stdout.trim() === "" ? null : lstartSeconds(ran.stdout);
    if (ran.stdout.trim() === "") { results.set(one.pid, "gone"); continue; }
    if (seconds === null || `s${seconds}` !== one.start) { results.set(one.pid, "changed"); continue; }
    try { process.kill(one.pid, signal); results.set(one.pid, "sent"); }
    catch (error) { results.set(one.pid, (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "denied"); }
  }
  return results;
}

/** The OS as custody sees it, on macOS and Linux. Elsewhere every read fails, so custody never verifies an exit. */
export function realCustodyIO(bootId: () => string | null): CustodyIO {
  const platform = process.platform;
  return {
    platform,
    self: process.pid,
    identityBound: platform === "linux",
    table: () => platform === "linux" ? linuxTable() : platform === "darwin" ? macTable() : null,
    namespaceOf: pid => platform === "linux" ? linuxNamespace(pid) : null,
    holdersOf: folder => platform === "linux" ? linuxHolders(folder) : platform === "darwin" ? macHolders(folder) : null,
    signal: (targets, signal) => {
      const safe = targets.filter(one => Number.isSafeInteger(one.pid) && one.pid > 1 && one.pid !== process.pid);
      const results = platform === "linux" ? linuxSignal(safe, signal) : platform === "darwin" ? macSignal(safe, signal) : new Map(safe.map(one => [one.pid, "unavailable" as const]));
      for (const one of targets) if (!safe.includes(one)) results.set(one.pid, "denied");
      return results;
    },
    bootId,
    sleep: ms => new Promise(done => setTimeout(done, ms)),
  };
}

/** One process's start identity, read now (the leader's, as it is registered), or null when it can't be read. */
export function startIdentityOf(pid: number, io: Pick<CustodyIO, "table">): string | null {
  return io.table()?.find(row => row.pid === pid && !row.zombie)?.start ?? null;
}
