import { execFileSync } from "node:child_process";

type HistoricalWitness = { observedAt: unknown; finishedAt: unknown; exitedAt?: unknown };

/** Only the exact UTC millisecond format stored by the writer is evidence. */
function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

/** A whole `ps` lstart (locale C, UTC) as the earliest moment that process can have started, or null. The displayed
 * second is a lower bound, not a rounded millisecond identity. Never lets Date.parse guess a locale, a timezone or an
 * invalid calendar date. */
function birthOf(lstart: string): number | null {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(lstart.trim().replace(/ +/g, " "));
  if (match === null) return null;
  const utc = `${match[1]}, ${match[3]!.padStart(2, "0")} ${match[2]} ${match[5]} ${match[4]} GMT`;
  const start = Date.parse(utc);
  return !Number.isFinite(start) || new Date(start).toUTCString() !== utc || start > Date.now() ? null : start;
}

function newerMacProcess(pid: number, witness: HistoricalWitness | undefined): boolean {
  if (process.platform !== "darwin" || witness === undefined) return false;
  const observed = timestamp(witness.observedAt), finished = timestamp(witness.finishedAt);
  if (observed === null || finished === null) return false;
  try {
    const start = birthOf(execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024,
      // Bound only this owned diagnostic child, never an agent or task.
      // A stalled/oversized lookup throws and leaves the witness occupied.
      timeout: 1_000, killSignal: "SIGKILL",
    }));
    // Same-second observations are ambiguous. Reservations can precede
    // spawn, so also require birth AFTER the owning run ended.
    return start !== null && start > Math.max(observed, finished);
  } catch { return false; }
}

/** How long a run must have been over before a number its group once held can be read as someone else's. */
export const REUSED_GROUP_AFTER_MS = 10 * 60_000;

/**
 * Whether a group whose exit is recorded is now a different group under the same number (macOS; run 3313's pid-less
 * witness waited on three numbers MTLCompilerService and dataaccessd had taken). A recorded group exit was proved when
 * it was written (no member left, a newer process holding the number, or a reboot), so the proof here only has to
 * show that whoever holds the number came later: the run is over and old, and every process now in the group was
 * born after that exit, or after the run ended if the exit was recorded later than that. A member older than that,
 * an empty or unreadable table, or any line that can't be read leaves the group occupied. Nothing is signalled.
 */
function groupTakenSinceExit(pgid: number, witness: HistoricalWitness | undefined): boolean {
  if (process.platform !== "darwin" || witness === undefined) return false;
  const observed = timestamp(witness.observedAt), finished = timestamp(witness.finishedAt), exited = timestamp(witness.exitedAt);
  if (observed === null || finished === null || exited === null || Date.now() - finished < REUSED_GROUP_AFTER_MS) return false;
  const since = Math.max(observed, Math.min(exited, finished));
  try {
    const table = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,lstart="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024, timeout: 5_000, killSignal: "SIGKILL",
    });
    let members = 0;
    for (const line of table.split("\n")) {
      if (line.trim() === "") continue;
      const row = /^\s*\d+\s+(\d+)(?:\s+(.*))?$/.exec(line);
      if (row === null) return false;
      if (Number(row[1]) !== pgid) continue;
      const start = birthOf(row[2] ?? "");
      if (start === null || start <= since) return false;
      members += 1;
    }
    return members > 0;
  } catch { return false; }
}

/** Read-only checks of retained process witnesses. Saved PIDs authorize no
 * signal. ESRCH or proven macOS PID reuse establishes absence; everything
 * unknown stays occupied. This concerns the historical identity, not whether
 * the numeric PID/PGID is currently populated by unrelated processes. */
export function processMayBeAlive(pid: number, group: boolean, witness?: HistoricalWitness): boolean {
  // A recorded single-process exit is final: this number can now belong to
  // someone else, even before the run ends. A leader's exit proves nothing
  // about its group's remaining members, so groups keep the OS probe.
  if (!group && witness?.exitedAt != null) return false;
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (group && process.platform !== "win32") {
    let absent = false;
    try { process.kill(-pid, 0); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") absent = true;
      else if (code !== "EPERM") return true;
    }
    // Darwin's forkproc excludes existing PIDs, PGIDs and session IDs under
    // proc_list_lock. A proven newer PID EQUAL to the saved PGID therefore
    // implies the old group ended before allocation, even if a new group now
    // uses that number. A new member or an absent leader proves nothing,
    // unless the group's exit is already on record (groupTakenSinceExit).
    // See docs/assessments/UPDATE_PID_REUSE_2026-09-15.md, recovery attempt 2.
    if (!absent) return !newerMacProcess(pid, witness) && !groupTakenSinceExit(pid, witness);
  }
  try { process.kill(pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code !== "EPERM") return true;
    // Signal permission and readable birth identity are independent. EPERM
    // alone proves nothing; a failed/ambiguous ps read still stays occupied.
  }
  return !newerMacProcess(pid, witness);
}
