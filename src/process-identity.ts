/**
 * Which process holds a pid: an identity that tells it from a later process that reuses the number. Shared by the
 * runner's credential record (runner-process.ts), a build's leftover cleanup (bounded-spawn.ts) and an eval campaign's
 * runner (evals.ts).
 *
 * Two providers, each with its own tagged format, and a recorded identity is only ever compared with one read by the
 * SAME provider now:
 *
 * - "proc" (Linux): `proc:<boot id>:<start ticks>` — /proc/sys/kernel/random/boot_id and field 22 of /proc/<pid>/stat
 *   (the start time in clock ticks since boot). Nothing is converted to wall time, so the tick rate never matters. The
 *   command name in field 2 is parenthesized and may hold spaces and ")" itself: fields are read after the LAST ")".
 * - "ps": `ps -o lstart=` (C locale, UTC) as an ISO second — macOS, and Linux where /proc can't be read. Legacy records
 *   hold exactly this ISO form (runner-process.ts) or ps's raw lstart words (bounded-spawn.ts, evals.ts); both are "ps".
 *
 * Unknown stays conservative: a recorded identity of an unknown format, or one whose provider can't be read now, never
 * proves the process gone (the caller treats it as possibly alive). Busybox `ps` has no `-o lstart`, so without /proc
 * (or with it unreadable) the identity is unknown; `toolroll doctor` says so (processIdentityProblem).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type IdentityProvider = "proc" | "ps";

/** What the providers read; real by default, supplied by tests. */
export type IdentityIo = {
  platform?: NodeJS.Platform;
  procRoot?: string;
  read?: (file: string) => string;
  /** `ps -p <pid> -o <field>=` (C locale, UTC): its output, or null when it fails. */
  ps?: (pid: number, field: string) => string | null;
};

const LSTART = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROC_ID = /^proc:[0-9a-f-]{36}:\d{1,20}$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `ps -o lstart=` words (LC_ALL=C, TZ=UTC) as an ISO second, or null when they aren't exactly that shape. */
export function lstartToIso(raw: string): string | null {
  const match = LSTART.exec(raw.trim().replace(/ +/g, " "));
  if (match === null) return null;
  const utc = `${match[1]}, ${match[3]!.padStart(2, "0")} ${match[2]} ${match[5]} ${match[4]} GMT`;
  const at = Date.parse(utc);
  if (!Number.isFinite(at) || new Date(at).toUTCString() !== utc) return null;
  return new Date(at).toISOString();
}

/** Which provider made a recorded identity: "proc", "ps" (ISO, or ps's raw lstart words), or null for anything else. */
export function identityProvider(recorded: string): IdentityProvider | null {
  if (PROC_ID.test(recorded)) return "proc";
  if (ISO.test(recorded) || lstartToIso(recorded) !== null) return "ps";
  return null;
}

/** /proc/<pid>/stat's fields from field 3 on (state first), read after the command name's last ")"; null when it isn't
 * that shape. */
export function procStatFields(stat: string): string[] | null {
  const close = stat.lastIndexOf(")");
  if (close < 0 || stat.indexOf("(") < 0 || stat.indexOf("(") > close) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  return fields.length >= 20 && /^[A-Za-z]$/.test(fields[0]!) ? fields : null;
}

const defaultRead = (file: string): string => readFileSync(file, "utf8");
const defaultPs = (pid: number, field: string): string | null => {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4096, timeout: 2_000, killSignal: "SIGKILL",
    });
  } catch { return null; }
};

/** The process's stat fields (field 3 on) from /proc, or null where /proc can't be read or isn't Linux's. */
function procFields(pid: number, io: IdentityIo): string[] | null {
  if ((io.platform ?? process.platform) !== "linux") return null;
  try { return procStatFields((io.read ?? defaultRead)(join(io.procRoot ?? "/proc", String(pid), "stat"))); } catch { return null; }
}

/** The identity of the process holding `pid` now, by `provider` (by default the best this system has: proc, then ps),
 * or null when there is no such process or it can't be read. */
export function processIdentity(pid: number, provider?: IdentityProvider, io: IdentityIo = {}): string | null {
  const platform = io.platform ?? process.platform;
  if (!Number.isSafeInteger(pid) || pid <= 1 || platform === "win32") return null;
  if (provider !== "ps" && platform === "linux") {
    const fields = procFields(pid, io);
    let boot: string | null = null;
    try { boot = (io.read ?? defaultRead)(join(io.procRoot ?? "/proc", "sys", "kernel", "random", "boot_id")).trim(); } catch { boot = null; }
    const ticks = fields?.[19];
    if (fields !== null && boot !== null && BOOT_ID.test(boot) && ticks !== undefined && /^\d{1,20}$/.test(ticks)) return `proc:${boot}:${ticks}`;
    if (provider === "proc") return null;
  }
  const raw = (io.ps ?? defaultPs)(pid, "lstart");
  return raw === null ? null : lstartToIso(raw);
}

/**
 * Whether the process holding `pid` now is the one `recorded` names: "same", "other" (the pid was reused), or
 * "unknown" (a recorded identity of an unknown format, or its provider can't read this process now). Only a reading by
 * the recorded identity's own provider counts; a raw lstart record is compared as its ISO second.
 */
export function sameProcess(pid: number, recorded: string, io: IdentityIo = {}): "same" | "other" | "unknown" {
  const provider = identityProvider(recorded);
  if (provider === null) return "unknown";
  const now = processIdentity(pid, provider, io);
  if (now === null) return "unknown";
  const was = provider === "ps" && !ISO.test(recorded) ? lstartToIso(recorded) : recorded;
  return now === was ? "same" : "other";
}

/** The parent of `pid` (field 4 of /proc/<pid>/stat on Linux, else `ps -o ppid=`), or null. Busybox `ps` has neither
 * `-p` nor `-o ppid`, so /proc is what answers on Alpine. */
export function processParentId(pid: number, io: IdentityIo = {}): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 1 || (io.platform ?? process.platform) === "win32") return null;
  const fields = procFields(pid, io);
  const raw = fields !== null ? fields[1]! : (io.ps ?? defaultPs)(pid, "ppid")?.trim() ?? "";
  const parent = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(parent) && parent > 0 ? parent : null;
}

/** The process group of `pid` (field 5 of /proc/<pid>/stat on Linux, else `ps -o pgid=`), or null. */
export function processGroupId(pid: number, io: IdentityIo = {}): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 1 || (io.platform ?? process.platform) === "win32") return null;
  const fields = procFields(pid, io);
  const raw = fields !== null ? fields[2]! : (io.ps ?? defaultPs)(pid, "pgid")?.trim() ?? "";
  const group = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(group) && group > 1 ? group : null;
}

/**
 * The resident memory of every process in group `pgid`, in bytes: on Linux from /proc (each process's stat field 5 for
 * its group, its status VmRSS in kB), else `ps -A -o pgid=,rss=`; null when neither can be read.
 */
export function processGroupRss(pgid: number, io: IdentityIo & { list?: (dir: string) => string[] } = {}): number | null {
  if ((io.platform ?? process.platform) === "linux") {
    const root = io.procRoot ?? "/proc";
    const read = io.read ?? defaultRead;
    let names: string[] | null;
    try { names = (io.list ?? readdirSync)(root).filter(name => /^\d+$/.test(name)); } catch { names = null; }
    if (names !== null && names.length > 0) {
      let kilobytes = 0;
      for (const name of names) {
        try {
          const fields = procStatFields(read(join(root, name, "stat")));
          if (fields === null || Number(fields[2]) !== pgid) continue;
          const rss = /^VmRSS:\s+(\d+) kB$/m.exec(read(join(root, name, "status")));
          if (rss !== null) kilobytes += Number(rss[1]);
        } catch { /* gone between the list and the read */ }
      }
      return kilobytes * 1024;
    }
  }
  let out: string | null;
  try {
    out = execFileSync("/bin/ps", ["-A", "-o", "pgid=,rss="], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024, timeout: 2_000, killSignal: "SIGKILL" });
  } catch { out = null; }
  if (out === null) return null;
  let kilobytes = 0;
  for (const line of out.split("\n")) {
    const [group, rss] = line.trim().split(/\s+/);
    if (Number(group) === pgid) kilobytes += Number(rss) || 0;
  }
  return kilobytes * 1024;
}

/** Why this system can't tell one process from a later one with the same id (neither /proc nor `ps -o lstart` works),
 * with what to install; null when it can. */
export function processIdentityProblem(io: IdentityIo = {}): string | null {
  const platform = io.platform ?? process.platform;
  if (platform === "win32") return "Toolroll can't read when a process started on Windows, so it can't start its worker here";
  if (processIdentity(process.pid, undefined, io) !== null) return null;
  return platform === "linux"
    ? "Toolroll can't read when a process started here: /proc can't be read and this `ps` has no `-o lstart` (busybox). Install procps (Debian, Ubuntu, Alpine: procps; Fedora: procps-ng), or make /proc readable"
    : "Toolroll can't read when a process started here: `ps -o lstart` doesn't work";
}
