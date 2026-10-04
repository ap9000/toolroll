import { execFileSync } from "node:child_process";

type HistoricalWitness = { observedAt: unknown; finishedAt: unknown; exitedAt?: unknown };

/** Only the exact UTC millisecond format stored by the writer is evidence. */
function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function newerMacProcess(pid: number, witness: HistoricalWitness | undefined): boolean {
  if (process.platform !== "darwin" || witness === undefined) return false;
  const observed = timestamp(witness.observedAt), finished = timestamp(witness.finishedAt);
  if (observed === null || finished === null) return false;
  try {
    // lstart has whole-second precision. Fix locale AND timezone; never let
    // Date.parse guess either, or normalize an invalid calendar date.
    const raw = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024,
      // Bound only this owned diagnostic child, never an agent or task.
      // A stalled/oversized lookup throws and leaves the witness occupied.
      timeout: 1_000, killSignal: "SIGKILL",
    }).trim().replace(/ +/g, " ");
    const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(raw);
    if (match === null) return false;
    const utc = `${match[1]}, ${match[3]!.padStart(2, "0")} ${match[2]} ${match[5]} ${match[4]} GMT`;
    const start = Date.parse(utc);
    if (!Number.isFinite(start) || new Date(start).toUTCString() !== utc || start > Date.now()) return false;
    // The displayed second is a lower bound, not a rounded millisecond
    // identity. Same-second observations are ambiguous. Reservations can
    // precede spawn, so also require birth AFTER the owning run ended.
    return start > Math.max(observed, finished);
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
    // uses that number. A new member or an absent leader proves nothing.
    // See docs/assessments/UPDATE_PID_REUSE_2026-09-15.md, recovery attempt 2.
    if (!absent) return !newerMacProcess(pid, witness);
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
