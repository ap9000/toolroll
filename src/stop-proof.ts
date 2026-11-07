/**
 * Toolroll's own proof that a finished build stopped. Nobody is ever asked to "confirm it stopped": a person can't see
 * whether a process exited, and asking defeats unattended builds and releases.
 *
 * When a finished run's process record is missing or incomplete (a spawn whose process ID was never written, a lost
 * process-tree snapshot, an agent start with no witness, a workspace note that can't be read), Toolroll looks at this
 * computer itself, a grace period after the run finished:
 *
 *   - no process the run is known to have started is still that process (pid and birth time, never a pid alone);
 *   - no process works in the run's folder (its working directory) or names it in its command line;
 *   - this process still tracks no live child for the run.
 *
 * A leftover it finds is stopped (SIGTERM, then SIGKILL) only when it is proven the run's: in the run's folder, born
 * while the run ran, not this service or its ancestors, and orphaned or descended from the run's
 * own processes — or it descends from such a leftover. A pid now held by a process born after the run ended is never
 * the run's. Anything else in the folder (a person's shell or editor) is left alone and holds the proof, in plain
 * words. When this computer can't look (the process table or the folder listing can't be read, or the run's
 * processes belong to another computer), the stop stays unproven and the reason is shown; there is still nothing to
 * vouch for.
 *
 * Command lines are read only to match the folder's path in memory; they are never stored or shown.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { sep } from "node:path";
import { ownedProcessCount, runOwnerTag } from "./exec.js";
import { closeoutTargets, processCensus, protectedProcesses, stopProcesses, stoppedWords, type ProcessRow, type StopOptions, type Witness } from "./run-closeout.js";
import { localWitnessSql, recordStopProofBlocked, settleRunStopByObservation, storeMachine, type Store, type StopProofCause } from "./store.js";
import { worktreeProcessOccupancy } from "./worktree.js";

/** How long after a run finished its processes have to go on their own before Toolroll looks. */
export const STOP_PROOF_GRACE_MS = 60_000;
/** `ps` gives ages in whole seconds: a process born this close to the run's start or end still counts as during it. */
const BIRTH_SLACK_MS = 2_000;

export type StopProofOutcome =
  /** Proven stopped and settled, in the ledger with its evidence. */
  | "settled"
  /** Not yet: inside the grace period, a live child is still tracked here, or a leftover was just stopped. */
  | "waiting"
  /** This computer can't prove it (can't look, another computer's process, or something it didn't start is in the
   * folder). Recorded once, in plain words. */
  | "blocked"
  /** Nothing for this proof to do: already stopped, still open, alive on its own record, or a native sandbox. */
  | "skipped";
export type StopProofResult = { run: number; outcome: StopProofOutcome; words: string; stopped?: number };

export type StopProofOptions = StopOptions & {
  /** How long after the run finished before Toolroll looks (STOP_PROOF_GRACE_MS). `graceMs` is the SIGTERM grace. */
  afterFinishMs?: number;
  /** Which processes have their working directory inside each path; must throw when it can't tell. */
  cwds?: (paths: readonly string[]) => Map<string, number[]>;
  /** Every process's command line, by pid; must throw when it can't tell. */
  commandLines?: () => Map<number, string>;
  /** The live service's own pid (its ancestors are never targets). */
  self?: number;
  /** The worktree note check (worktree.ts); throws when the note can't be read. */
  occupancy?: (path: string) => { held: true; by: number } | { held: false };
  /** Called after processes were stopped: a cached look must be read again. */
  refresh?: () => void;
};

/** One pass's shared look at this computer: the process table, folders and command lines are read once for every
 * run the pass checks, and again after anything was stopped. */
export function sharedLook(options: StopProofOptions = {}): StopProofOptions {
  let census: ProcessRow[] | null = null, folders: { pid: number; cwd: string }[] | null = null, lines: Map<number, string> | null = null;
  return {
    ...options,
    census: () => (census ??= (options.census ?? (() => processCensus()))()),
    cwds: paths => options.cwds !== undefined ? options.cwds(paths) : processesInStrict(paths, folders ??= processFolders()),
    commandLines: () => (lines ??= (options.commandLines ?? processCommandLines)()),
    refresh: () => { census = null; folders = null; lines = null; options.refresh?.(); },
  };
}

/** Which processes work inside each path, from the OS: /proc on Linux, lsof on macOS. Unlike a best-effort listing,
 * it throws when the listing can't be read: no answer is never "nobody". */
export function processesInStrict(paths: readonly string[], listing: readonly { pid: number; cwd: string }[] = processFolders()): Map<string, number[]> {
  const found = new Map<string, number[]>();
  const roots = paths.map(path => { let real = path; try { real = realpathSync(path); } catch { /* gone */ } return { path, real }; });
  for (const { pid, cwd } of listing) {
    for (const one of roots) if ([one.path, one.real].some(root => cwd === root || cwd.startsWith(root + sep))) found.set(one.path, [...(found.get(one.path) ?? []), pid]);
  }
  return found;
}

/** Every process's working directory, from the OS; throws when the listing can't be read. */
export function processFolders(): { pid: number; cwd: string }[] {
  const found: { pid: number; cwd: string }[] = [];
  const note = (pid: number, cwd: string) => { found.push({ pid, cwd }); };
  if (process.platform === "linux" && existsSync("/proc")) {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      // Gone, or another user's (never a process this user's run started).
      try { note(Number(name), readlinkSync(`/proc/${name}/cwd`)); } catch { /* not readable */ }
    }
    if (found.length === 0) throw new Error("no process folder could be read");
    return found;
  }
  if (process.platform !== "darwin") throw new Error("this computer's process folders can't be listed");
  let text: string;
  try { text = execFileSync("lsof", ["-nP", "-d", "cwd", "-Fpn"], { encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch (error) {
    // lsof exits 1 when some process can't be inspected (another user's) yet still lists every one it can.
    // A timeout, a signal or an overflow leaves a partial listing, which is no answer at all.
    const failure = error as { stdout?: unknown; status?: unknown; signal?: unknown; code?: unknown };
    if (failure.status !== 1 || failure.signal != null || typeof failure.code === "string") throw new Error("the process folder listing could not be read");
    text = String(failure.stdout ?? "");
  }
  if (!/^p\d+$/m.test(text)) throw new Error("the process folder listing was empty");
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) note(pid, line.slice(1));
  }
  return found;
}

/** Every process's command line, by pid. Read to match a folder's path in memory only; never stored or shown. */
export function processCommandLines(): Map<number, string> {
  if (process.platform === "win32") throw new Error("command lines can't be read here");
  const text = execFileSync("/bin/ps", ["-axww", "-o", "pid=,args="], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  const lines = new Map<number, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match !== null) lines.set(Number(match[1]), match[2]!);
  }
  if (lines.size === 0) throw new Error("the process list was empty");
  return lines;
}

/** Whether a command line names `path` or something inside it (a whole path, never a longer folder's prefix). */
export function namesPath(line: string, path: string): boolean {
  for (let at = line.indexOf(path); at >= 0; at = line.indexOf(path, at + 1)) {
    const before = at === 0 ? " " : line[at - 1]!, after = line[at + path.length];
    if (/[\s"'=:]/.test(before) && (after === undefined || after === sep || /[\s"':]/.test(after))) return true;
  }
  return false;
}

type Look = { census: ProcessRow[]; targets: ProcessRow[]; blockers: ProcessRow[]; inFolder: number };

/**
 * One look at this computer for one finished run: which processes are its leftovers (`targets`) and which are in its
 * folder without being proven its (`blockers`). Throws when something can't be read.
 */
function look(store: Store, runId: number, options: StopProofOptions): Look {
  const run = store.getRun(runId)!;
  const census = (options.census ?? (() => processCensus()))();
  if (census.length === 0) throw new Error("the process table was empty");
  const guard = protectedProcesses(census, options.self);
  const byPid = new Map(census.map(row => [row.pid, row]));
  // Its recorded processes still open: still the same process (pid and birth), or a member of its open group.
  const open: Witness[] = store.handle.prepare(`SELECT pid, process_group, observed_at FROM run_process
    WHERE run = ? AND exited_at IS NULL AND pid IS NOT NULL AND containment IS NULL AND container IS NULL`).all(runId)
    .map(row => ({ pid: Number(row["pid"]), group: Number(row["process_group"]) === 1, observedAt: Date.parse(String(row["observed_at"])) }))
    .filter(one => Number.isFinite(one.observedAt));
  const recorded = new Set(closeoutTargets(census, open, guard).map(row => row.pid));
  // Its folder: working directory inside it, or named on the command line.
  const folder = new Set<number>();
  if (run.worktree !== null) {
    const paths = [run.worktree];
    try { const real = realpathSync(run.worktree); if (real !== run.worktree) paths.push(real); } catch { /* gone: only its name can match */ }
    for (const pids of (options.cwds ?? processesInStrict)(paths).values()) for (const pid of pids) folder.add(pid);
    for (const [pid, line] of (options.commandLines ?? processCommandLines)()) if (paths.some(path => namesPath(line, path))) folder.add(pid);
  }
  const started = Date.parse(run.startedAt) - BIRTH_SLACK_MS, ended = Date.parse(run.finishedAt!) + BIRTH_SLACK_MS;
  const during = (row: ProcessRow) => row.bornAt >= started && row.bornAt <= ended;
  const unguarded = (row: ProcessRow) => !guard.pids.has(row.pid) && !guard.groups.has(row.pgid);
  // A leftover in the folder: born while the run ran and orphaned (its starter gone). A terminal proves nothing either
  // way here: a worker started from a terminal hands its controlling terminal to everything its runs start.
  const orphans = new Set<number>();
  for (const pid of folder) {
    const row = byPid.get(pid);
    if (row !== undefined && during(row) && unguarded(row) && row.ppid === 1) orphans.add(pid);
  }
  // And whatever descends from a leftover, wherever it works: from the run's own recorded processes (proven by pid
  // and birth) or from an orphan found in its folder.
  const descendsFrom = (roots: ReadonlySet<number>, row: ProcessRow): boolean => {
    for (let at: ProcessRow | undefined = row, hops = 0; at !== undefined && at.pid > 1 && hops < 64; at = byPid.get(at.ppid), hops++) if (roots.has(at.pid)) return true;
    return false;
  };
  const targets = census.filter(row => unguarded(row) && (descendsFrom(recorded, row) || descendsFrom(orphans, row)));
  const chosen = new Set(targets.map(row => row.pid));
  // In the folder while the run ran but not proven its (a person's shell or editor: a live parent Toolroll didn't start):
  // left alone, and the proof waits for it. Born before the run or after it ended (and not a leftover's child) can't
  // be the run's, so it neither blocks nor is touched.
  const blockers = [...folder].map(pid => byPid.get(pid)).filter((row): row is ProcessRow => row !== undefined && !chosen.has(row.pid) && during(row) && !guard.pids.has(row.pid));
  // A run with no folder (a reviewer's): nothing names its processes but their groups. An orphan born while it ran
  // in one of its recorded process groups may be its own, or a newer group that took the number: never signalled,
  // it holds the proof.
  if (run.worktree === null) {
    const groups = new Set(store.handle.prepare("SELECT pid FROM run_process WHERE run = ? AND pid IS NOT NULL AND process_group = 1").all(runId).map(row => Number(row["pid"])));
    for (const row of census) if (!chosen.has(row.pid) && unguarded(row) && row.ppid === 1 && during(row) && groups.has(row.pgid)) blockers.push(row);
  }
  return { census, targets, blockers, inFolder: folder.size };
}

/**
 * Prove one finished run stopped, on this computer, without asking anyone (see the file's comment). Walks the run's
 * owned runs one unproven stop at a time. Never signals a process that isn't proven the run's.
 */
export async function proveRunStopped(store: Store, runId: number, clock: () => Date, options: StopProofOptions = {}): Promise<StopProofResult> {
  let stopped = 0;
  for (let pass = 0; pass < 8; pass++) {
    const fact = store.stopQuiescenceFact(runId);
    if (fact === null) return { run: runId, outcome: pass === 0 ? "skipped" : "settled", words: "stopped", ...(stopped > 0 ? { stopped } : {}) };
    // Already proven by the record (an unrecorded spawn whose run's every process is proven gone): settle it now.
    if (fact.kind === "settling" && store.settleUnspawnedWitnesses(clock(), fact.run) > 0) { store.settleQuiescentStops(clock()); continue; }
    const cause: StopProofCause | undefined = fact.cause;
    if (cause === undefined || (fact.kind !== "unprovable" && fact.kind !== "unknown")) return { run: fact.run, outcome: pass === 0 ? "skipped" : "waiting", words: fact.problem };
    const subject = fact.run, run = store.getRun(subject)!;
    const finished = Date.parse(run.finishedAt ?? "");
    const now = clock();
    if (!Number.isFinite(finished) || now.getTime() < finished + (options.afterFinishMs ?? STOP_PROOF_GRACE_MS)) return { run: subject, outcome: "waiting", words: "finishing" };
    if (ownedProcessCount(runOwnerTag(store, subject)) > 0) return { run: subject, outcome: "waiting", words: "a process of it is still tracked here" };
    if (process.platform === "win32") return block(store, subject, "can't be checked on this computer: Windows processes can't be listed by folder", "no folder listing on Windows", now);
    const local = localWitnessSql(storeMachine(store.handle));
    const foreign = store.handle.prepare(`SELECT host FROM run_process WHERE run = ? AND exited_at IS NULL AND NOT ${local.sql} LIMIT 1`).get(subject, ...local.params);
    if (foreign !== undefined) return block(store, subject, `ran on another computer (${String(foreign["host"])}); only that computer can check it stopped`, `an open witness belongs to ${String(foreign["host"])}`, now);
    if (run.worktree !== null) {
      try {
        const held = (options.occupancy ?? worktreeProcessOccupancy)(run.worktree);
        if (held.held) return { run: subject, outcome: "waiting", words: `its folder is still held by process ${held.by}` };
      } catch { /* an unreadable note: the look below decides */ }
    }
    let seen: Look;
    try { seen = look(store, subject, options); }
    catch (error) {
      return block(store, subject, "can't be checked on this computer: its process list could not be read", `look failed: ${error instanceof Error ? error.message : String(error)}`, now);
    }
    if (seen.targets.length > 0) {
      const done = await stopProcesses(seen.targets, options);
      options.refresh?.();
      stopped += done.stopped.length;
      const ref = store.refById(run.taskRef);
      store.recordAction({ at: clock().toISOString(), actor: "system", repo: ref?.repo ?? null, taskId: ref?.externalId ?? null, runId: subject,
        action: "run processes stopped", outcome: "stopped", source: "work", detail: `run #${subject} ended (${run.outcome ?? "?"}); its stop check found and stopped ${stoppedWords(done, options.graceMs)}` });
      try { seen = look(store, subject, options); }
      catch { return { run: subject, outcome: "waiting", words: "stopped what it left running; checking again", stopped }; }
      if (seen.targets.length > 0) return { run: subject, outcome: "waiting", words: "stopped what it left running; checking again", stopped };
    }
    if (seen.blockers.length > 0) {
      const one = seen.blockers[0]!;
      const others = seen.blockers.length - 1;
      return block(store, subject, `can't be proven stopped: ${one.name} (process ${one.pid})${others > 0 ? ` and ${others} more` : ""} is ${run.worktree === null ? "in one of its process groups" : "using its folder"}, and Toolroll didn't start it, so it left it alone`,
        `in its folder: ${seen.blockers.slice(0, 8).map(row => `${row.name} ${row.pid}`).join(", ")}`, now);
    }
    const evidence = `${hostname()}: ${seen.census.length} processes checked ${Math.round((now.getTime() - finished) / 1000)} s after it finished; none in ${run.worktree ?? "no folder"} or naming it (${seen.inFolder} seen there, none from the run), none of its recorded processes running${stopped > 0 ? `; stopped ${stopped} it left running` : ""}`;
    if (!settleRunStopByObservation(store, { runId: subject, cause, evidence }, clock())) return { run: subject, outcome: "waiting", words: "its record changed while checking" };
  }
  return { run: runId, outcome: "waiting", words: "more to check" };
}

function block(store: Store, runId: number, words: string, detail: string, now: Date): StopProofResult {
  recordStopProofBlocked(store, runId, words, detail, now);
  return { run: runId, outcome: "blocked", words };
}

/** The worker's pass (operate.ts reconcile): every finished run of this computer whose stop is unproven where
 * Toolroll's own look can prove it. A batch a pass, oldest first; a blocked run never holds newer ones back. */
export async function proveFinishedRunsStopped(store: Store, clock: () => Date, options: StopProofOptions & { batch?: number } = {}): Promise<StopProofResult[]> {
  const grace = options.afterFinishMs ?? STOP_PROOF_GRACE_MS;
  const before = new Date(clock().getTime() - grace).toISOString();
  const local = localWitnessSql(storeMachine(store.handle), "p");
  const runs = store.handle.prepare(`SELECT id FROM run r WHERE r.outcome IS NOT NULL AND r.finished_at IS NOT NULL AND r.finished_at <= ? AND (
      EXISTS (SELECT 1 FROM run_process p WHERE p.run = r.id AND p.exited_at IS NULL AND p.pid IS NULL AND p.containment IS NULL AND p.container IS NULL AND ${local.sql})
      OR (r.provider_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM run_process p WHERE p.run = r.id) AND NOT EXISTS (SELECT 1 FROM run_process_summary s WHERE s.run = r.id)))
    ORDER BY r.id LIMIT ?`).all(before, ...local.params, options.batch ?? 50).map(row => Number(row["id"]));
  const out: StopProofResult[] = [];
  const shared = sharedLook(options);
  for (const runId of runs) {
    try { out.push(await proveRunStopped(store, runId, clock, shared)); }
    catch { /* one run's failure never stops the pass; the next pass looks again */ }
  }
  return out;
}
