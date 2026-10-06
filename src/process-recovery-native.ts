import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, release } from "node:os";
import { join } from "node:path";
import { darwinNativeCensusSchema, darwinProcessIdentitySchema, kernelIdInRange, type DarwinProcessIdentity } from "./contracts/native-census.js";

export type PreparedDarwinProcessCensus = { sourcePath: string; executablePath: string; sourceSha256: string; executableSha256: string };
export type { DarwinProcessIdentity } from "./contracts/native-census.js";
export type DarwinManagedService = { domain: string; label: string; pid: number; uniqueId: string; beforeUniqueId: string; afterUniqueId: string; identityBound: boolean };
export type DarwinPidDomain = { pid: number; domain: string; readable: boolean; identityBound: boolean; uniqueId: string | null; type: string | null; handle: number | null; originator: string | null; creatorPid: number | null };
export type DarwinProcessRecoverySnapshot = {
  schema: 1; host: string; bootId: string | null; osRelease: string; startedAt: string; finishedAt: string;
  elevation: "none" | "sudo-n"; complete: boolean; stable: boolean; processes: DarwinProcessIdentity[];
  managedServices: DarwinManagedService[]; collectorPids: number[];
  domainFailures: { domain: string; reason: string }[]; identityChanges: number[]; errors: string[];
  nativeSourceSha256: string; nativeExecutableSha256: string; pidDomains: DarwinPidDomain[];
};
type NativeSnapshot = { schema: 1; bootId: string | null; collectorPid: number; complete: boolean; processes: DarwinProcessIdentity[]; errors: string[] };
const digest = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const cleanEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", TZ: "UTC" };

/** Facts only. Public KERN_PROC_ALL supplies birth/UID/trace metadata without
 * reading argv or environments. XNU's flavor 17 supplies 64-bit identities:
 * https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h
 * p_puniqueid can change on orphan exec; original-parent version is diagnostic
 * only (32-bit wrap is possible). No recovery authority lives in this helper. */
export const DARWIN_PROCESS_CENSUS_SOURCE = String.raw`
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
#include <libproc.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
struct identity_info {
  unsigned char uuid[16]; uint64_t uniqueid, parent_uniqueid;
  int32_t idversion, original_parent_version; uint64_t reserved[2];
};
_Static_assert(sizeof(struct identity_info) == 56, "identity ABI size");
struct coalition_info { uint64_t resource, jetsam, reserved[3]; };
struct usage_prefix { uint64_t started, exited, time_nonempty, cpu_time; };
extern int coalition_info_resource_usage(uint64_t, struct usage_prefix *, size_t);
static uint64_t target_coalition = 0;
static int anchor_pids[8] = {0}, anchor_count = 0;
static int is_anchor(pid_t pid) { for (int i = 0; i < anchor_count; i++) if (anchor_pids[i] == pid) return 1; return 0; }
static int read_usage(struct usage_prefix *usage) {
  return coalition_info_resource_usage(target_coalition, usage, sizeof(*usage)) == 0 && usage->started >= usage->exited;
}
static void quoted(const char *s) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32 || *p >= 127) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static void capture(void) {
  struct usage_prefix usage_before = {0}, usage_after = {0};
  int usage_before_ok = !target_coalition || read_usage(&usage_before);
  unsigned int membership_unreadable = 0, target_count = 0, anchors_seen = 0;
  int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0 };
  size_t bytes = 0; int ok = sysctl(mib, 4, NULL, &bytes, NULL, 0) == 0;
  size_t capacity = bytes + 256 * sizeof(struct kinfo_proc);
  struct kinfo_proc *rows = ok ? calloc(1, capacity) : NULL;
  if (!rows) ok = 0;
  bytes = capacity;
  if (ok && sysctl(mib, 4, rows, &bytes, NULL, 0) != 0) ok = 0;
  if (ok && bytes % sizeof(struct kinfo_proc) != 0) ok = 0;
  char boot[128] = {0}; size_t bootlen = sizeof(boot);
  int boot_ok = sysctlbyname("kern.bootsessionuuid", boot, &bootlen, NULL, 0) == 0 && bootlen > 1 && bootlen <= sizeof(boot);
  boot[sizeof(boot)-1] = 0;
  printf("{\"schema\":1,\"bootId\":"); if (boot_ok) quoted(boot); else printf("null");
  printf(",\"collectorPid\":%d,\"processes\":[", getpid());
  int first = 1, identities_ok = 1;
  size_t count = ok ? bytes / sizeof(struct kinfo_proc) : 0;
  for (size_t i = 0; i < count; ++i) {
    struct kinfo_proc *r = &rows[i]; pid_t pid = r->kp_proc.p_pid;
    /* PID 0 is the kernel. SZOMB is positive kernel exit state, not a
       membership read failure; flavor 20 deliberately cannot query zombies. */
    if (pid <= 0 || r->kp_proc.p_stat == SZOMB) continue;
    struct identity_info id = {0}; uint64_t row_resource = 0; int anchor = is_anchor(pid);
    int identified = proc_pidinfo(pid, 17, 0, &id, sizeof(id)) == sizeof(id) && id.uniqueid != 0;
    if (target_coalition) {
      struct coalition_info coalition = {0};
      errno = 0;
      if (proc_pidinfo(pid, 20, 0, &coalition, sizeof(coalition)) != sizeof(coalition)) {
        /* Never infer that an unreadable PID is foreign from aggregate task
           counts: a retiring task may retain its coalition ID after removal.
           Only fresh positive absence, not EPERM or a failed read, is safe. */
        int membership_errno = errno;
        struct identity_info still_live = {0};
        errno = 0;
        if (membership_errno == ESRCH && proc_pidinfo(pid, 17, 0, &still_live, sizeof(still_live)) <= 0 && errno == ESRCH) continue;
        membership_unreadable++; continue;
      }
      row_resource = coalition.resource;
      if (row_resource != target_coalition && !anchor) continue;
      if (row_resource == target_coalition) target_count++;
      if (anchor) anchors_seen++;
      struct identity_info after_id = {0};
      struct coalition_info after_coalition = {0};
      if (proc_pidinfo(pid, 17, 0, &after_id, sizeof(after_id)) != sizeof(after_id) ||
          proc_pidinfo(pid, 20, 0, &after_coalition, sizeof(after_coalition)) != sizeof(after_coalition) ||
          after_id.uniqueid != id.uniqueid || after_id.parent_uniqueid != id.parent_uniqueid ||
          after_coalition.resource != row_resource) identified = 0;
    }
    if (!identified) identities_ok = 0;
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int path_ok = proc_pidpath(pid, path, sizeof(path)) > 0;
    if (!first) putchar(','); first = 0;
    printf("{\"pid\":%d,\"ppid\":%d,\"uid\":%u,\"birthMs\":%.3f,\"traced\":%s,\"uniqueId\":", pid, r->kp_eproc.e_ppid, r->kp_eproc.e_ucred.cr_uid,
      (double)r->kp_proc.p_starttime.tv_sec * 1000.0 + (double)r->kp_proc.p_starttime.tv_usec / 1000.0,
      (r->kp_proc.p_flag & P_TRACED) ? "true" : "false");
    if (identified) printf("\"%" PRIu64 "\"", id.uniqueid); else printf("null");
    printf(",\"parentUniqueId\":"); if (identified) printf("\"%" PRIu64 "\"", id.parent_uniqueid); else printf("null");
    printf(",\"pidVersion\":%" PRIu32, (uint32_t)id.idversion);
    printf(",\"originalParentVersion\":"); if (identified) printf("%" PRIu32, (uint32_t)id.original_parent_version); else printf("null");
    printf(",\"executable\":"); if (path_ok) quoted(path); else printf("null"); if (target_coalition) printf(",\"resourceCoalitionId\":\"%" PRIu64 "\"", row_resource); putchar('}');
  }
  int usage_after_ok = !target_coalition || read_usage(&usage_after);
  int counters_stable = !target_coalition || (usage_before_ok && usage_after_ok && usage_before.started == usage_after.started && usage_before.exited == usage_after.exited);
  int anchors_readable = anchors_seen == (unsigned int)anchor_count;
  int count_matches = !target_coalition || (usage_before_ok && usage_before.started - usage_before.exited == target_count);
  printf("]");
  if (target_coalition) {
    printf(",\"anchorPids\":[");
    for (int i = 0; i < anchor_count; i++) printf("%s%d", i ? "," : "", anchor_pids[i]);
    printf("]");
    printf(",\"resourceCoalitionId\":\"%" PRIu64 "\",\"counterBefore\":", target_coalition);
    if (usage_before_ok) printf("{\"tasksStarted\":\"%" PRIu64 "\",\"tasksExited\":\"%" PRIu64 "\"}", usage_before.started, usage_before.exited); else printf("null");
    printf(",\"counterAfter\":");
    if (usage_after_ok) printf("{\"tasksStarted\":\"%" PRIu64 "\",\"tasksExited\":\"%" PRIu64 "\"}", usage_after.started, usage_after.exited); else printf("null");
    printf(",\"kernelTableRead\":%s,\"unreadableMembershipCount\":%u", ok ? "true" : "false", membership_unreadable);
  }
  printf(",\"complete\":%s,\"errors\":[", ok && identities_ok && boot_ok && counters_stable && count_matches && anchors_readable && !membership_unreadable ? "true" : "false");
  int comma = 0;
  if (!ok) { printf("\"kernel-process-table-unreadable\""); comma = 1; }
  if (membership_unreadable) { printf("%s\"process-membership-unreadable\"", comma ? "," : ""); comma = 1; }
  if (!identities_ok) { printf("%s\"process-identity-unreadable\"", comma ? "," : ""); comma = 1; }
  if (!boot_ok) { printf("%s\"boot-identity-unreadable\"", comma ? "," : ""); comma = 1; }
  if (!usage_before_ok || !usage_after_ok) { printf("%s\"coalition-counters-unreadable\"", comma ? "," : ""); comma = 1; }
  if (!counters_stable) { printf("%s\"coalition-counters-changed\"", comma ? "," : ""); comma = 1; }
  if (!anchors_readable) { printf("%s\"anchor-identity-unreadable\"", comma ? "," : ""); comma = 1; }
  if (!count_matches) printf("%s\"coalition-count-mismatch\"", comma ? "," : "");
  printf("]}\n"); fflush(stdout); free(rows);
}
int main(int argc, char **argv) {
  if (argc != 1) {
    if (argc < 3 || argc > 11 || strcmp(argv[1], "--coalition") != 0 || !argv[2][0] || argv[2][0] == '0') return 2;
    for (char *p = argv[2]; *p; ++p) if (*p < '0' || *p > '9') return 2;
    errno = 0; char *end = NULL; target_coalition = strtoull(argv[2], &end, 10);
    if (errno || !end || *end || !target_coalition) return 2;
    for (int i = 3; i < argc; i++) {
      if (!argv[i][0] || argv[i][0] == '0') return 2;
      for (char *p = argv[i]; *p; ++p) if (*p < '0' || *p > '9') return 2;
      errno = 0; long pid = strtol(argv[i], &end, 10);
      if (errno || !end || *end || pid <= 0 || pid > INT_MAX || is_anchor((pid_t)pid)) return 2;
      anchor_pids[anchor_count++] = (int)pid;
    }
  }
  capture();
  char command[32] = {0};
  if (!fgets(command, sizeof(command), stdin) || strcmp(command, "recheck\n") != 0) return 2;
  capture(); return 0;
}
`;

/** Compilation is explicit, local, and separate from read-only collection. */
export function prepareDarwinProcessCensus(directory: string): PreparedDarwinProcessCensus {
  if (process.platform !== "darwin") throw new Error("Darwin process census is unavailable on this platform.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const location = mkdtempSync(join(realpathSync(directory), "process-census-"));
  chmodSync(location, 0o700);
  const sourcePath = join(location, "census.c"), executablePath = join(location, "census");
  writeFileSync(sourcePath, DARWIN_PROCESS_CENSUS_SOURCE, { mode: 0o600, flag: "wx" });
  try { execFileSync("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", executablePath, "-lproc"], { env: cleanEnv, stdio: "pipe", timeout: 30_000 }); }
  catch { throw new Error("Darwin census compilation failed; no process recovery was attempted."); }
  chmodSync(executablePath, 0o500);
  return { sourcePath, executablePath, sourceSha256: digest(DARWIN_PROCESS_CENSUS_SOURCE), executableSha256: digest(readFileSync(executablePath)) };
}
function validateNative(native: PreparedDarwinProcessCensus): void {
  for (const path of [native.sourcePath, native.executablePath]) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || realpathSync(path) !== path) throw new Error("untrusted-census-file");
  }
  if (native.sourceSha256 !== digest(DARWIN_PROCESS_CENSUS_SOURCE) || digest(readFileSync(native.sourcePath)) !== native.sourceSha256 || digest(readFileSync(native.executablePath)) !== native.executableSha256) throw new Error("census-file-changed");
}
const isInt = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const isId = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const nullable = <T>(value: unknown, test: (v: unknown) => v is T): value is T | null => value === null || test(value);
const safeText = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
/** Strict parser also strips every field not in the facts contract. */
export function parseDarwinNativeSnapshot(text: string): NativeSnapshot {
  const read = darwinNativeCensusSchema.safeParse(JSON.parse(text));
  if (!read.success) throw new Error("malformed-native-census");
  const v = read.data;
  const pids = new Set<number>(), ids = new Set<string>();
  const processes: DarwinProcessIdentity[] = v.processes.map((r: unknown) => {
    const row = darwinProcessIdentitySchema.safeParse(r);
    if (!row.success) throw new Error("malformed-process-identity");
    const p = row.data;
    if (pids.has(p.pid) || (p.uniqueId !== null && !kernelIdInRange(p.uniqueId)) || p.uniqueId === "0" || (p.uniqueId !== null && ids.has(p.uniqueId)) || (p.parentUniqueId !== null && !kernelIdInRange(p.parentUniqueId))) throw new Error("malformed-process-identity");
    pids.add(p.pid); if (p.uniqueId !== null) ids.add(p.uniqueId);
    return { pid: p.pid, ppid: p.ppid, uid: p.uid, birthMs: p.birthMs, uniqueId: p.uniqueId, parentUniqueId: p.parentUniqueId, traced: p.traced, executable: p.executable, originalParentVersion: p.originalParentVersion, ...(p.pidVersion === undefined ? {} : { pidVersion: p.pidVersion }) };
  });
  if (v.complete && (v.bootId === null || v.errors.length || !pids.has(1) || !pids.has(v.collectorPid) || processes.some(p => p.uniqueId === null))) throw new Error("incomplete-native-census");
  return { schema: 1, bootId: v.bootId, collectorPid: v.collectorPid, complete: v.complete, processes, errors: v.errors };
}
/** PID reuse, orphan exec, tracing, UID and birth changes all invalidate a seal. */
export function changedDarwinProcessIdentities(before: DarwinProcessIdentity[], after: DarwinProcessIdentity[]): number[] {
  const old = new Map(before.map(p => [p.pid, p])), next = new Map(after.map(p => [p.pid, p]));
  const keys: (keyof DarwinProcessIdentity)[] = ["uniqueId", "parentUniqueId", "ppid", "uid", "birthMs", "traced", "executable", "originalParentVersion", "pidVersion"];
  return [...new Set([...old.keys(), ...next.keys()])].filter(pid => {
    const a = old.get(pid), b = next.get(pid);
    return !a || !b || keys.some(key => a[key] !== b[key]);
  }).sort((a, b) => a - b);
}
/** Parse only the launchd domain's direct service table; never return raw print
 * output, environment, arguments or nested service-like text. */
export function parseDarwinLaunchdServices(output: string): { pid: number; label: string }[] {
  const result: { pid: number; label: string }[] = [];
  let inServices = false, found = false;
  for (const line of output.split("\n")) {
    if (!inServices) { if (/^\tservices = \{$/.test(line)) { if (found) throw new Error("duplicate-service-table"); found = true; inServices = true; } continue; }
    if (line === "\t}") { inServices = false; continue; }
    if (!line.trim()) continue;
    const match = /^\t\t[ \t]*([0-9-]+)\s+([-A-Za-z0-9?()]+)\s+([^\x00-\x1f\x7f]+?)\s*$/.exec(line);
    if (!match) throw new Error("malformed-service-table");
    const pid = Number(match[1]);
    if (match[1] === "-" || pid === 0) continue;
    if (!isInt(pid, 1) || !safeText(match[3])) throw new Error("malformed-service-table");
    result.push({ pid, label: match[3] });
  }
  if (!found || inServices) throw new Error("service-table-unavailable");
  return result;
}
export function parseDarwinPidDomain(output: string): Pick<DarwinPidDomain, "type" | "handle" | "originator" | "creatorPid"> {
  const field = (name: string): string | null => {
    const matches = [...output.matchAll(new RegExp(`^\\t${name} = ([^\\r\\n]+)$`, "gm"))];
    return matches.length === 1 && safeText(matches[0]![1]) ? matches[0]![1]! : null;
  };
  const numeric = (value: string | null): number | null => value !== null && /^[0-9]+$/.test(value) && isInt(Number(value)) ? Number(value) : null;
  return { type: field("type"), handle: numeric(field("handle")), originator: field("originator"), creatorPid: numeric(field("creator")?.match(/^(?:[^\[\]\r\n]+\[)?([0-9]+)\]?$/)?.[1] ?? null) };
}
function launchctl(domain: string, elevation: "none" | "sudo-n"): string {
  if (!/^(system|gui\/[0-9]+|user\/[0-9]+|pid\/[0-9]+)$/.test(domain)) throw new Error("invalid-launchd-domain");
  const command = elevation === "sudo-n" ? "/usr/bin/sudo" : "/bin/launchctl";
  const args = elevation === "sudo-n" ? ["-n", "/bin/launchctl", "print", domain] : ["print", domain];
  return execFileSync(command, args, { encoding: "utf8", env: cleanEnv, timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: "pipe" });
}
function domainFailure(error: unknown): string {
  if (error instanceof Error && ["duplicate-service-table", "malformed-service-table", "service-table-unavailable"].includes(error.message)) return error.message;
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
  if (status === 113) return "domain-not-found";
  const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
  if (/password is required|not privileged|not permitted|permission denied/i.test(stderr)) return "permission-required";
  return "domain-unreadable";
}
function beginNative<T extends { collectorPid: number }>(native: PreparedDarwinProcessCensus, argv: string[], parse: (text: string) => T): { first: Promise<T>; finish: () => Promise<{ second: T; exited: boolean }> } {
  // libproc identities and KERN_PROC_ALL need no elevation. Never run the
  // caller-owned compiled executable as root; sudo-n applies only to the
  // fixed /bin/launchctl read below.
  const child = spawn(native.executablePath, argv, { env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", bytes = 0;
  let firstResolve!: (value: T) => void, firstReject!: (error: Error) => void;
  let secondResolve!: (value: T) => void, secondReject!: (error: Error) => void;
  const first = new Promise<T>((resolve, reject) => { firstResolve = resolve; firstReject = reject; });
  const second = new Promise<T>((resolve, reject) => { secondResolve = resolve; secondReject = reject; });
  // Attach handlers immediately; a failed helper can reject before finish().
  void first.catch(() => {}); void second.catch(() => {});
  let lines = 0, failure = false, closeObserved = false;
  const fail = (): void => {
    const firstFailure = !failure;
    failure = true;
    const error = new Error("native-census-unavailable"); firstReject(error); secondReject(error);
    // A signal request is not exit evidence. Retain this handle until close,
    // including when kill fails or an error event precedes eventual exit.
    if (firstFailure && !closeObserved && child.pid !== undefined) { try { child.kill("SIGTERM"); } catch {} }
  };
  const timeout = setTimeout(fail, 120_000);
  const closed = new Promise<boolean>(resolve => {
    child.once("error", fail);
    child.once("close", code => { closeObserved = true; clearTimeout(timeout); if (code !== 0 || lines !== 2 || buffer.trim()) fail(); resolve(code === 0 && !failure && lines === 2); });
  });
  child.stderr.resume(); // Diagnostics are deliberately not copied to output.
  child.stdin.on("error", fail);
  child.stdout.on("data", (data: Buffer) => {
    if (failure) return;
    bytes += data.length;
    if (bytes > 32 * 1024 * 1024) { fail(); return; }
    buffer += data.toString("utf8");
    for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { const value = parse(line); if (value.collectorPid !== child.pid) throw new Error("collector-identity-mismatch"); lines++; if (lines === 1) firstResolve(value); else if (lines === 2) secondResolve(value); else fail(); } catch { fail(); }
    }
  });
  let finishing: Promise<{ second: T; exited: boolean }> | undefined;
  return { first, finish: () => finishing ??= (async () => {
    try { if (!failure) child.stdin.end("recheck\n"); } catch { fail(); }
    // Await close BEFORE propagating a parse/stream/timeout rejection. Both
    // collectors call finish during cleanup, so neither retry nor return can
    // abandon a failed child. Repeated cleanup shares this same observation.
    const exited = await closed;
    return { second: await second, exited };
  })() };

}

/** Does not write a recovery receipt, clear custody, signal task processes, or
 * infer that an unreadable service/domain is safe. sudo-n is explicit and can
 * only fail closed; this function never requests or reads a password. */
export async function collectDarwinProcessRecoverySnapshot(args: {
  native: PreparedDarwinProcessCensus; elevation?: "none" | "sudo-n"; boundary: string; maxAttempts?: number;
}): Promise<DarwinProcessRecoverySnapshot> {
  const time = Date.parse(args.boundary), attempts = args.maxAttempts ?? 1, elevation = args.elevation ?? "none";
  if (!Number.isFinite(time) || new Date(time).toISOString() !== args.boundary || !isInt(attempts, 1) || attempts > 3 || !["none", "sudo-n"].includes(elevation)) throw new Error("invalid-census-options");
  validateNative(args.native);
  let last!: DarwinProcessRecoverySnapshot;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const report: DarwinProcessRecoverySnapshot = { schema: 1, host: hostname(), bootId: null, osRelease: release(), startedAt: new Date().toISOString(), finishedAt: "", elevation, complete: false, stable: false, processes: [], managedServices: [], collectorPids: [], domainFailures: [], identityChanges: [], errors: [], nativeSourceSha256: args.native.sourceSha256, nativeExecutableSha256: args.native.executableSha256, pidDomains: [] };
    let running: ReturnType<typeof beginNative<NativeSnapshot>> | undefined, finished = false;
    try {
      if (process.platform !== "darwin") throw new Error("unsupported-platform");
      running = beginNative(args.native, [], parseDarwinNativeSnapshot);
      const before = await running.first;
      report.bootId = before.bootId; report.processes = before.processes; report.errors.push(...before.errors);
      const domains = new Set(["system"]);
      for (const uid of new Set(before.processes.flatMap(p => p.uid === null || p.ppid !== 1 || (p.birthMs !== null && p.birthMs < Math.floor(time / 1000) * 1000) ? [] : [p.uid]))) { domains.add(`gui/${uid}`); domains.add(`user/${uid}`); }
      const services: { domain: string; pid: number; label: string }[] = [];
      for (const domain of domains) {
        try { services.push(...parseDarwinLaunchdServices(launchctl(domain, elevation)).map(row => ({ domain, ...row }))); }
        catch (error) { report.domainFailures.push({ domain, reason: domainFailure(error) }); }
      }
      const servicePids = new Set(services.map(s => s.pid));
      for (const process of before.processes) {
        if (process.ppid !== 1 || process.birthMs === null || process.birthMs < Math.floor(time / 1000) * 1000 || servicePids.has(process.pid)) continue;
        const domain = `pid/${process.pid}`;
        const facts: DarwinPidDomain = { pid: process.pid, domain, readable: false, identityBound: false, uniqueId: process.uniqueId, type: null, handle: null, originator: null, creatorPid: null };
        try { Object.assign(facts, parseDarwinPidDomain(launchctl(domain, elevation))); facts.readable = true; }
        catch (error) { report.domainFailures.push({ domain, reason: domainFailure(error) }); }
        report.pidDomains.push(facts);
      }
      const done = await running.finish(); finished = true;
      const after = done.second;
      report.identityChanges = changedDarwinProcessIdentities(before.processes, after.processes);
      report.errors.push(...after.errors);
      if (before.bootId !== after.bootId || before.collectorPid !== after.collectorPid) report.errors.push("census-context-changed");
      if (!done.exited) report.errors.push("collector-exit-unconfirmed");
      if (report.identityChanges.length) report.errors.push("process-census-changed");
      const old = new Map(before.processes.map(p => [p.pid, p])), current = new Map(after.processes.map(p => [p.pid, p]));
      for (const service of services) {
        const a = old.get(service.pid), b = current.get(service.pid);
        if (!a?.uniqueId || !b?.uniqueId) continue;
        report.managedServices.push({ ...service, uniqueId: a.uniqueId, beforeUniqueId: a.uniqueId, afterUniqueId: b.uniqueId, identityBound: a.uniqueId === b.uniqueId && !report.identityChanges.includes(service.pid) });
      }
      for (const domain of report.pidDomains) domain.identityBound = domain.readable && domain.uniqueId !== null && current.get(domain.pid)?.uniqueId === domain.uniqueId && !report.identityChanges.includes(domain.pid);
      report.complete = before.complete && after.complete && done.exited;
      report.stable = report.complete && report.errors.length === 0 && report.identityChanges.length === 0;
      // Exclusion is only for this exact facts-only child after its owned handle
      // reports successful exit. No generic disappeared PID becomes an exclusion.
      if (done.exited && old.get(before.collectorPid)?.uniqueId === current.get(after.collectorPid)?.uniqueId && old.get(before.collectorPid)?.uniqueId) report.collectorPids = [before.collectorPid];
    } catch { report.errors.push("census-collection-failed"); }
    finally {
      if (running && !finished) { try { await running.finish(); } catch {} }
      report.finishedAt = new Date().toISOString(); report.errors = [...new Set(report.errors)];
    }
    last = report;
    if (report.stable) break;
  }
  return last;
}

export type DarwinCoalitionCounters = { tasksStarted: string; tasksExited: string };
export type DarwinCoalitionProcessIdentity = DarwinProcessIdentity & { resourceCoalitionId: string };
export type DarwinCoalitionNativeSnapshot = Omit<NativeSnapshot, "processes"> & {
  resourceCoalitionId: string; processes: DarwinCoalitionProcessIdentity[];
  anchorPids: number[]; anchors: DarwinCoalitionProcessIdentity[];
  counterBefore: DarwinCoalitionCounters | null; counterAfter: DarwinCoalitionCounters | null;
  kernelTableRead: boolean; unreadableMembershipCount: number;
};
export type DarwinCoalitionRecoverySnapshot = {
  schema: 1; host: string; bootId: string | null; osRelease: string; startedAt: string; finishedAt: string;
  resourceCoalitionId: string; complete: boolean; stable: boolean;
  anchorPids: number[]; anchors: DarwinCoalitionProcessIdentity[]; anchorIdentityChanges: number[];
  processes: DarwinCoalitionProcessIdentity[]; counterBefore: DarwinCoalitionCounters | null;
  counterAfter: DarwinCoalitionCounters | null; countersStable: boolean; kernelTableRead: boolean;
  unreadableMembershipCount: number; identityChanges: number[]; errors: string[];
  collector: { pid: number; uniqueId: string; exited: true } | null;
  nativeSourceSha256: string; nativeExecutableSha256: string;
};
export const prepareDarwinCoalitionCensus = prepareDarwinProcessCensus;
function readCounters(value: unknown): DarwinCoalitionCounters | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) throw new Error("malformed-coalition-counters");
  const v = value as Record<string, unknown>;
  if (!isId(v.tasksStarted) || !isId(v.tasksExited) || BigInt(v.tasksStarted) < BigInt(v.tasksExited)) throw new Error("malformed-coalition-counters");
  return { tasksStarted: v.tasksStarted, tasksExited: v.tasksExited };
}
const sameCounters = (a: DarwinCoalitionCounters | null, b: DarwinCoalitionCounters | null): boolean => a !== null && b !== null && a.tasksStarted === b.tasksStarted && a.tasksExited === b.tasksExited;
/** Counts corroborate membership; they cannot classify unreadable processes.
 * Every non-zombie table row must have a readable coalition or fresh ESRCH.
 * Fork adopts a coalition before publishing the child PID, then makes it
 * runnable. An in-construction child therefore also requires a live producer;
 * separate historical provenance and absence of owned producers are mandatory.
 * Exec shadows share a PID; changed task counters still invalidate the seal. */
export function parseDarwinCoalitionNativeSnapshot(text: string): DarwinCoalitionNativeSnapshot {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (!value || !isId(value.resourceCoalitionId) || value.resourceCoalitionId === "0" || typeof value.complete !== "boolean" || typeof value.kernelTableRead !== "boolean" || !isInt(value.unreadableMembershipCount)) throw new Error("malformed-coalition-census");
  const common = parseDarwinNativeSnapshot(JSON.stringify({ ...value, complete: false }));
  const counterBefore = readCounters(value.counterBefore), counterAfter = readCounters(value.counterAfter);
  const anchorPids = value.anchorPids;
  if (!Array.isArray(anchorPids) || anchorPids.length > 8 || anchorPids.some(pid => !isInt(pid, 1) || pid > 0x7fffffff) || new Set(anchorPids).size !== anchorPids.length) throw new Error("malformed-anchor-request");
  const raw = value.processes as Record<string, unknown>[];
  const rows = common.processes.map((p, i) => {
    const resourceCoalitionId = raw[i]!.resourceCoalitionId;
    if (!isId(resourceCoalitionId) || resourceCoalitionId === "0" || (resourceCoalitionId !== value.resourceCoalitionId && !anchorPids.includes(p.pid))) throw new Error("coalition-membership-mismatch");
    return { ...p, resourceCoalitionId };
  });
  const processes = rows.filter(p => p.resourceCoalitionId === value.resourceCoalitionId);
  const anchors = rows.filter(p => anchorPids.includes(p.pid));
  if (value.complete && (value.unreadableMembershipCount !== 0 || !value.kernelTableRead || common.bootId === null || common.errors.length || rows.some(p => p.uniqueId === null) || anchors.length !== anchorPids.length || !sameCounters(counterBefore, counterAfter) || BigInt(counterBefore!.tasksStarted) - BigInt(counterBefore!.tasksExited) !== BigInt(processes.length))) throw new Error("incomplete-coalition-census");
  return { ...common, complete: value.complete, processes, anchorPids, anchors, resourceCoalitionId: value.resourceCoalitionId, counterBefore, counterAfter, kernelTableRead: value.kernelTableRead, unreadableMembershipCount: value.unreadableMembershipCount };
}
/** Validates the two seals without trusting a numeric PID intersection. Exported
 * so the same malformed/racing native response receives deterministic checks. */
export function compareDarwinCoalitionSnapshots(before: DarwinCoalitionNativeSnapshot, after: DarwinCoalitionNativeSnapshot): { complete: boolean; stable: boolean; countersStable: boolean; identityChanges: number[]; anchorIdentityChanges: number[]; errors: string[] } {
  const identityChanges = changedDarwinProcessIdentities(before.processes, after.processes);
  const anchorIdentityChanges = [...new Set([
    ...changedDarwinProcessIdentities(before.anchors, after.anchors),
    ...before.anchors.filter(p => after.anchors.find(q => q.pid === p.pid)?.resourceCoalitionId !== p.resourceCoalitionId).map(p => p.pid),
    ...before.anchorPids.filter(pid => !before.anchors.some(p => p.pid === pid) || !after.anchors.some(p => p.pid === pid)),
  ])].sort((a, b) => a - b);
  const countersStable = sameCounters(before.counterBefore, before.counterAfter) && sameCounters(before.counterBefore, after.counterBefore) && sameCounters(before.counterBefore, after.counterAfter);
  const errors = [...new Set([...before.errors, ...after.errors])];
  if (before.unreadableMembershipCount || after.unreadableMembershipCount) errors.push("process-membership-unreadable");
  if (before.resourceCoalitionId !== after.resourceCoalitionId || before.bootId !== after.bootId || before.bootId === null || before.collectorPid !== after.collectorPid) errors.push("census-context-changed");
  if (!countersStable) errors.push("coalition-counters-changed");
  if (identityChanges.length) errors.push("process-census-changed");
  if ([...before.anchorPids].sort((a, b) => a - b).join(",") !== [...after.anchorPids].sort((a, b) => a - b).join(",")) errors.push("anchor-request-changed");
  if (anchorIdentityChanges.length) errors.push("anchor-identity-changed");
  const firstSelf = before.processes.find(p => p.pid === before.collectorPid), lastSelf = after.processes.find(p => p.pid === after.collectorPid);
  if (!firstSelf?.uniqueId || firstSelf.uniqueId !== lastSelf?.uniqueId) errors.push("collector-coalition-mismatch");
  const complete = before.complete && after.complete && errors.length === 0;
  return { complete, stable: complete && identityChanges.length === 0 && countersStable, countersStable, identityChanges, anchorIdentityChanges, errors: [...new Set(errors)] };
}

/** Facts-only same-coalition census; this does not establish that any historical
 * run inherited this coalition or lacked privileged/delegated spawn authority.
 * Unlike the full-host reader, no launchctl child is spawned between seals.
 * Native task counters include fork AND exec, so transient exec copies refuse. */
export async function collectDarwinCoalitionSnapshot(args: {
  native: PreparedDarwinProcessCensus; resourceCoalitionId: string; maxAttempts?: number; anchorPids?: number[];
}): Promise<DarwinCoalitionRecoverySnapshot> {
  const attempts = args.maxAttempts ?? 1, anchorPids = args.anchorPids ?? [];
  if (anchorPids.length > 8 || anchorPids.some(pid => !isInt(pid, 1) || pid > 0x7fffffff) || new Set(anchorPids).size !== anchorPids.length) throw new Error("invalid-anchor-pids");
  if (!isId(args.resourceCoalitionId) || args.resourceCoalitionId === "0" || !isInt(attempts, 1) || attempts > 3) throw new Error("invalid-coalition-census-options");
  validateNative(args.native);
  let last!: DarwinCoalitionRecoverySnapshot;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const report: DarwinCoalitionRecoverySnapshot = { schema: 1, host: hostname(), bootId: null, osRelease: release(), startedAt: new Date().toISOString(), finishedAt: "", resourceCoalitionId: args.resourceCoalitionId, anchorPids: [...anchorPids], anchors: [], anchorIdentityChanges: [], complete: false, stable: false, processes: [], counterBefore: null, counterAfter: null, countersStable: false, kernelTableRead: false, unreadableMembershipCount: 0, identityChanges: [], errors: [], collector: null, nativeSourceSha256: args.native.sourceSha256, nativeExecutableSha256: args.native.executableSha256 };
    let running: ReturnType<typeof beginNative<DarwinCoalitionNativeSnapshot>> | undefined, finished = false;
    try {
      if (process.platform !== "darwin") throw new Error("unsupported-platform");
      running = beginNative(args.native, ["--coalition", args.resourceCoalitionId, ...anchorPids.map(String)], parseDarwinCoalitionNativeSnapshot);
      const before = await running.first;
      const done = await running.finish(); finished = true;
      const after = done.second;
      Object.assign(report, compareDarwinCoalitionSnapshots(before, after));
      report.bootId = before.bootId; report.processes = before.processes; report.anchors = before.anchors;
      if ([...before.anchorPids].sort((a, b) => a - b).join(",") !== [...anchorPids].sort((a, b) => a - b).join(",")) report.errors.push("anchor-request-mismatch");
      report.counterBefore = before.counterBefore; report.counterAfter = after.counterAfter;
      report.kernelTableRead = before.kernelTableRead && after.kernelTableRead;
      report.unreadableMembershipCount = before.unreadableMembershipCount + after.unreadableMembershipCount;
      if (before.resourceCoalitionId !== args.resourceCoalitionId || after.resourceCoalitionId !== args.resourceCoalitionId) report.errors.push("coalition-request-mismatch");
      const firstSelf = before.processes.find(p => p.pid === before.collectorPid), lastSelf = after.processes.find(p => p.pid === after.collectorPid);
      if (done.exited && firstSelf?.uniqueId && firstSelf.uniqueId === lastSelf?.uniqueId) report.collector = { pid: before.collectorPid, uniqueId: firstSelf.uniqueId, exited: true };
      if (!done.exited || report.collector === null) report.errors.push("collector-exit-unconfirmed");
      if (report.errors.length) { report.complete = false; report.stable = false; }
    } catch { report.complete = false; report.stable = false; report.errors.push("census-collection-failed"); }
    finally {
      if (running && !finished) { try { await running.finish(); } catch {} }
      report.finishedAt = new Date().toISOString(); report.errors = [...new Set(report.errors)];
    }
    last = report;
    if (report.stable) break;
  }
  return last;
}
