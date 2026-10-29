/**
 * Which processes hold a runner's credential, kept beside the plane's database so a later `up` can prove the previous
 * holder is gone (docs: the 2026-10-29 deploy incident). `toolroll up` registers its runner, then records itself and
 * every role child it hands the token to, each by process id AND start time, before the child receives the token.
 *
 * A fresh `up` whose runner name is still held (its heartbeat looks fresh, or its watch lease has not lapsed) asks
 * this record whether that holder is gone: the record must be for exactly the registration the plane holds (name,
 * host, registration time and credential), and every process in it must have exited, each proved by identity (no
 * such process, or a process with that id started at a different time). Then the plane retires the stale holder in
 * the same transaction that proved it (runner.ts registerRunnerIfIdle). Anything missing, unreadable or ambiguous
 * proves nothing, and the door keeps refusing until the heartbeat ages out, exactly as before.
 *
 * The record is the plane's own state (the folder that holds the database). It grants nothing by itself: it can
 * only let a name whose every recorded holder has exited be taken over early.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, fsyncSync, constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Runner } from "./runner.js";

export type RunnerProcessRole = "up" | "console" | "worker";
export type RunnerProcess = { pid: number; role: RunnerProcessRole; started: string };
export type RunnerProcessRecord = {
  v: 1;
  runner: string;
  host: string;
  registeredAt: string;
  /** A digest of the plane's credential hash for this registration: it names the incarnation, it proves nothing. */
  credential: string;
  processes: RunnerProcess[];
  /** Authenticated with the plane's stored credential hash; legacy/forged records prove nothing. */
  signature?: string;
};

export const RUNNER_PROCESS_DIR = "runner-processes";

/** The namespace is created before builds launch and denied by name, including in a shared state folder. */
export function ensureRunnerProcessFolder(folder: string): void {
  try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid()) || realpathSync(folder) !== resolve(folder)) throw Error("Untrusted runner process folder");
}

export function sealRunnerProcessRecord(record: RunnerProcessRecord, credentialHash: string): RunnerProcessRecord {
  const { signature: _signature, ...plain } = record;
  return { ...plain, signature: createHmac("sha256", credentialHash).update(JSON.stringify(plain)).digest("hex") };
}

const MAX_RECORD = 64 * 1024;
const MAX_PROCESSES = 64;
const ROLES = new Set<RunnerProcessRole>(["up", "console", "worker"]);

/** Where a runner's record lives: beside the database, under a name derived from the runner's (never the name itself). */
export function runnerProcessFile(databaseFile: string, runner: string): string {
  let database = databaseFile;
  try { database = realpathSync(databaseFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return join(realpathSync(dirname(database)), RUNNER_PROCESS_DIR, `${createHash("sha256").update(runner, "utf8").digest("hex").slice(0, 32)}.json`);
}

/** The incarnation's name in a record: a digest of the stored credential hash, so the record never holds that hash. */
export function credentialDigest(credentialHash: string): string {
  return createHash("sha256").update(`runner-process:${credentialHash}`, "utf8").digest("hex").slice(0, 32);
}

const LSTART = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/;

/** `ps -o lstart=` (LC_ALL=C, TZ=UTC) as an ISO second, or null when it isn't exactly that shape. */
export function parseProcessStart(raw: string): string | null {
  const match = LSTART.exec(raw.trim().replace(/ +/g, " "));
  if (match === null) return null;
  const utc = `${match[1]}, ${match[3]!.padStart(2, "0")} ${match[2]} ${match[5]} ${match[4]} GMT`;
  const at = Date.parse(utc);
  if (!Number.isFinite(at) || new Date(at).toUTCString() !== utc) return null;
  return new Date(at).toISOString();
}

/** When a process started (whole seconds), or null when there is no such process or it can't be read. */
export function processStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 1 || process.platform === "win32") return null;
  try {
    const raw = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024, timeout: 2_000, killSignal: "SIGKILL",
    });
    return parseProcessStart(raw);
  } catch { return null; }
}

/** The probes a proof uses; real by default, supplied by tests. */
export type ProcessProbe = { exists: (pid: number) => "absent" | "present" | "unknown"; start: (pid: number) => string | null };
export const realProcessProbe: ProcessProbe = {
  exists: pid => {
    try { process.kill(pid, 0); return "present"; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ESRCH" ? "absent" : code === "EPERM" ? "present" : "unknown";
    }
  },
  start: processStart,
};

/** Proved gone: no process has this id, or the one that has it started at another time (the id was reused). */
export function processGone(entry: RunnerProcess, probe: ProcessProbe = realProcessProbe): boolean {
  const exists = probe.exists(entry.pid);
  if (exists === "absent") return true;
  if (exists === "unknown") return false;
  const started = probe.start(entry.pid);
  if (started === null) return probe.exists(entry.pid) === "absent";
  return started !== entry.started;
}

/** A record read strictly: a regular private file of bounded size, every field its exact type, or null. */
export function readRunnerProcessRecord(file: string): RunnerProcessRecord | null {
  let fd: number | null = null;
  try {
    const folder = lstatSync(dirname(file));
    if (!folder.isDirectory() || folder.isSymbolicLink() || (folder.mode & 0o077) !== 0
      || (process.getuid && folder.uid !== process.getuid()) || realpathSync(dirname(file)) !== resolve(dirname(file))) return null;
    const link = lstatSync(file);
    if (!link.isFile() || link.isSymbolicLink() || link.size > MAX_RECORD) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD || stat.ino !== link.ino || stat.dev !== link.dev || (stat.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) { const n = readSync(fd, buffer, read, stat.size - read, read); if (n === 0) break; read += n; }
    return parseRecord(JSON.parse(buffer.subarray(0, read).toString("utf8")));
  } catch { return null; }
  finally { if (fd !== null) closeSync(fd); }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function parseRecord(value: unknown): RunnerProcessRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = (one: unknown, max = 512): one is string => typeof one === "string" && one !== "" && one.length <= max && !one.includes("\0");
  if (v["v"] !== 1 || !text(v["runner"]) || !text(v["host"]) || !text(v["registeredAt"]) || !ISO.test(v["registeredAt"]) || !text(v["credential"], 64)) return null;
  const list = v["processes"];
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PROCESSES) return null;
  const processes: RunnerProcess[] = [];
  for (const one of list) {
    if (typeof one !== "object" || one === null) return null;
    const p = one as Record<string, unknown>;
    if (!Number.isSafeInteger(p["pid"]) || (p["pid"] as number) <= 1 || !ROLES.has(p["role"] as RunnerProcessRole) || !text(p["started"], 32) || !ISO.test(p["started"])) return null;
    processes.push({ pid: p["pid"] as number, role: p["role"] as RunnerProcessRole, started: p["started"] });
  }
  return { v: 1, runner: v["runner"], host: v["host"], registeredAt: v["registeredAt"], credential: v["credential"], processes,
    ...(typeof v["signature"] === "string" ? { signature: v["signature"] } : {}) };
}

/** Replace the record atomically: a private temp file in a private folder, renamed into place. */
export function writeRunnerProcessRecord(file: string, record: RunnerProcessRecord): void {
  ensureRunnerProcessFolder(dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

/**
 * Whether the plane's current holder of a runner name is proved gone: the record is for exactly that registration,
 * on this host, and every process it names has exited (by identity). `detail` says which processes, for the ledger.
 */
export function holderProvedGone(record: RunnerProcessRecord | null, holder: { runner: Runner; credentialHash: string }, host: string,
  probe: ProcessProbe = realProcessProbe): { gone: true; detail: string } | { gone: false; why: string } {
  if (record === null) return { gone: false, why: "no readable record of its processes" };
  const expected = sealRunnerProcessRecord(record, holder.credentialHash).signature!;
  if (typeof record.signature !== "string" || !/^[a-f0-9]{64}$/.test(record.signature)
    || !timingSafeEqual(Buffer.from(record.signature, "hex"), Buffer.from(expected, "hex"))) return { gone: false, why: "its process record is not authenticated" };
  if (record.runner !== holder.runner.name || record.host !== holder.runner.host || record.host !== host) return { gone: false, why: "its record is for another worker or machine" };
  if (record.registeredAt !== holder.runner.registeredAt || record.credential !== credentialDigest(holder.credentialHash)) return { gone: false, why: "its record is from an earlier start" };
  if (!record.processes.some(one => one.role === "up")) return { gone: false, why: "its record names no `up` process" };
  const left = record.processes.filter(one => !processGone(one, probe));
  if (left.length > 0) return { gone: false, why: `process ${left.map(one => one.pid).join(", ")} is still running` };
  return { gone: true, detail: `${record.runner}: process ${record.processes.map(one => `${one.pid} (${one.role})`).join(", ")} proved gone` };
}

/** Re-read after observing exit: an up may append a child between the first read and its own exit. */
export function recordedHolderProvedGone(file: string, holder: { runner: Runner; credentialHash: string }, host: string,
  probe: ProcessProbe = realProcessProbe): { gone: true; detail: string } | { gone: false; why: string } {
  const record = readRunnerProcessRecord(file);
  const proof = holderProvedGone(record, holder, host, probe);
  if (!proof.gone) return proof;
  const after = readRunnerProcessRecord(file);
  if (after === null || JSON.stringify(after) !== JSON.stringify(record)) return { gone: false, why: "its process record changed during the exit proof" };
  return proof;
}
