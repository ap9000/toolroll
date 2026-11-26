/**
 * The record of who holds a runner's credential (runner-process.ts): a stale holder is proved gone only by identity
 * (no such process, or a process with that id started at another time), and only for the exact registration the plane
 * holds. Everything else proves nothing.
 */
import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialDigest, holderProvedGone, recordedHolderProvedGone, parseProcessStart, processGone, processStart, readRunnerProcessRecord, runnerProcessFile, sealRunnerProcessRecord, writeRunnerProcessRecord, type ProcessProbe, type RunnerProcessRecord } from "./runner-process.js";
import type { Runner } from "./runner.js";
import { fakePid } from "../test/fake-pid.js";

const runner: Runner = { name: "w-1", host: "here", capacity: 1, repos: [], agents: [], registeredAt: "2026-10-29T12:00:00.000Z", heartbeatAt: "2026-10-29T12:00:30.000Z", retiredAt: null };
const holder = { runner, credentialHash: "a".repeat(64) };
const record = (patch: Partial<RunnerProcessRecord> = {}): RunnerProcessRecord => sealRunnerProcessRecord({
  v: 1, runner: "w-1", host: "here", registeredAt: runner.registeredAt, credential: credentialDigest(holder.credentialHash),
  processes: [{ pid: fakePid(42), role: "up", started: "2026-10-29T11:59:59.000Z" }, { pid: fakePid(43), role: "worker", started: "2026-10-29T12:00:01.000Z" }], ...patch,
}, holder.credentialHash);
/** Each pid: absent, present with this start, present with an unreadable start, unknown to the probe, or present with
 * what each identity provider reads now (a provider missing reads null). */
type Seen = string | null | "unknown" | { proc?: string; ps?: string };
const probe = (world: Record<number, Seen>): ProcessProbe => ({
  exists: pid => !(pid in world) ? "absent" : world[pid] === "unknown" ? "unknown" : "present",
  start: (pid, provider) => {
    const one = world[pid];
    if (one === undefined || one === "unknown" || one === null) return null;
    return typeof one === "string" ? one : provider === undefined ? one.proc ?? one.ps ?? null : one[provider] ?? null;
  },
});
const BOOT = "0f6a3c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b";

test.each([
  ["every process exited", {}, record(), true],
  ["a pid reused by a process started later", { [fakePid(42)]: "2026-10-29T13:00:00.000Z", [fakePid(43)]: "2026-10-29T13:00:01.000Z" }, record(), true],
  ["the `up` still runs", { [fakePid(42)]: "2026-10-29T11:59:59.000Z" }, record(), false],
  ["a role still runs", { [fakePid(43)]: "2026-10-29T12:00:01.000Z" }, record(), false],
  ["a process whose start can't be read", { [fakePid(42)]: null }, record(), false],
  ["a pid the probe can't answer for", { [fakePid(42)]: "unknown" }, record(), false],
  ["a record from an earlier start", {}, record({ registeredAt: "2026-10-29T11:00:00.000Z" }), false],
  ["a record for another credential", {}, record({ credential: credentialDigest("b".repeat(64)) }), false],
  ["a record for another machine", {}, record({ host: "elsewhere" }), false],
  ["a record for another worker", {}, record({ runner: "w-2" }), false],
  ["a record that names no `up`", {}, record({ processes: [{ pid: fakePid(43), role: "worker", started: "2026-10-29T12:00:01.000Z" }] }), false],
  // Identity providers (process-identity.ts): only a reading by the record's own provider counts.
  ["a legacy ISO record, the `up` alive, ps gone and only /proc readable now", { [fakePid(42)]: { proc: `proc:${BOOT}:4242` } }, record(), false],
  ["a legacy ISO record, the pid reused, read by ps", { [fakePid(42)]: { proc: `proc:${BOOT}:9999`, ps: "2026-10-29T13:00:00.000Z" } }, record({ processes: [{ pid: fakePid(42), role: "up", started: "2026-10-29T11:59:59.000Z" }] }), true],
  ["a /proc record, the `up` alive, /proc unreadable now", { [fakePid(42)]: { ps: "2026-10-29T11:59:59.000Z" } }, record({ processes: [{ pid: fakePid(42), role: "up", started: `proc:${BOOT}:4242` }] }), false],
  ["a /proc record, the `up` alive", { [fakePid(42)]: { proc: `proc:${BOOT}:4242` } }, record({ processes: [{ pid: fakePid(42), role: "up", started: `proc:${BOOT}:4242` }] }), false],
  ["a /proc record, the pid reused after a reboot", { [fakePid(42)]: { proc: "11111111-2222-4333-8444-555555555555:4242".replace(/^/, "proc:") } }, record({ processes: [{ pid: fakePid(42), role: "up", started: `proc:${BOOT}:4242` }] }), true],
  ["a record of a format this build doesn't know, its pid held", { [fakePid(42)]: "2026-10-29T13:00:00.000Z" }, record({ processes: [{ pid: fakePid(42), role: "up", started: "boot:7:4242" }] }), false],
] as const)("holder proved gone: %s → %s", (_, world, one, gone) => {
  expect(holderProvedGone(one, holder, "here", probe(world)).gone).toBe(gone);
});

test("editing a process list or replaying an unsigned record never proves a holder gone", () => {
  const signed = record();
  for (const forged of [{ ...signed, signature: undefined }, { ...signed, processes: [{ pid: fakePid(99), role: "up" as const, started: "2026-10-29T11:59:59.000Z" }] }]) {
    expect(holderProvedGone(forged, holder, "here", probe({})).gone).toBe(false);
  }
});

test("no record, or a record read on another host, proves nothing", () => {
  expect(holderProvedGone(null, holder, "here", probe({})).gone).toBe(false);
  expect(holderProvedGone(record(), holder, "elsewhere", probe({})).gone).toBe(false);
});

test.each(["linked folder", "public file", "public folder"])("untrusted runner record storage: %s", kind => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-runner-storage-")));
  try {
    const file = runnerProcessFile(join(dir, "orders.db"), "w-1");
    writeRunnerProcessRecord(file, record());
    if (kind === "public file") chmodSync(file, 0o666);
    if (kind === "public folder") chmodSync(join(dir, "runner-processes"), 0o777);
    if (kind === "linked folder") {
      rmSync(join(dir, "runner-processes"), { recursive: true });
      mkdirSync(join(dir, "agent"));
      symlinkSync(join(dir, "agent"), join(dir, "runner-processes"));
      writeFileSync(file, JSON.stringify(record()), { mode: 0o600 });
    }
    expect(readRunnerProcessRecord(file)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a record is read strictly: a link, a damaged file or a wrong shape is no record", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-runner-process-")));
  try {
    const file = runnerProcessFile(join(dir, "orders.db"), "w-1");
    expect(file.startsWith(join(dir, "runner-processes"))).toBe(true);
    expect(file).not.toContain("w-1");
    writeRunnerProcessRecord(file, record());
    expect(readRunnerProcessRecord(file)).toEqual(record());
    // Both identity formats read back; the tag is part of what is sealed.
    const tagged = record({ processes: [{ pid: fakePid(42), role: "up", started: `proc:${BOOT}:4242` }] });
    writeRunnerProcessRecord(file, tagged);
    expect(readRunnerProcessRecord(file)).toEqual(tagged);
    writeRunnerProcessRecord(file, record());
    const linked = `${file}.link`;
    symlinkSync(file, linked);
    expect(readRunnerProcessRecord(linked)).toBeNull();
    for (const bad of ["not json", JSON.stringify({ ...record(), v: 2 }), JSON.stringify({ ...record(), processes: [{ pid: 1, role: "up", started: "2026-10-29T11:59:59.000Z" }] }),
      JSON.stringify({ ...record(), processes: [{ pid: fakePid(42), role: "builder", started: "2026-10-29T11:59:59.000Z" }] }), JSON.stringify({ ...record(), processes: [] }),
      JSON.stringify({ ...record(), processes: [{ pid: fakePid(42), role: "up", started: "boot:7:4242" }] }), JSON.stringify({ ...record(), processes: [{ pid: fakePid(42), role: "up", started: "Thu Oct 29 13:11:05 2026" }] })]) {
      writeFileSync(file, bad);
      expect(readRunnerProcessRecord(file)).toBeNull();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ps start times parse exactly, and a real process is gone only once it has exited", async () => {
  expect(parseProcessStart("Fri Oct  9 07:05:01 2026")).toBe("2026-10-09T07:05:01.000Z");
  expect(parseProcessStart("Thu Oct 29 13:11:05 2026")).toBe("2026-10-29T13:11:05.000Z");
  expect(parseProcessStart("Thu Oct  9 07:05:01 2026")).toBeNull();
  expect(parseProcessStart("Feb 30 2026")).toBeNull();
  const own = processStart(process.pid);
  expect(own).toMatch(process.platform === "linux" ? /^proc:[0-9a-f-]{36}:\d+$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  expect(processGone({ pid: process.pid, role: "up", started: own! })).toBe(false);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const started = await new Promise<string>((resolve, reject) => {
      child.once("spawn", () => { const at = processStart(child.pid!); if (at === null) reject(Error("no start")); else resolve(at); });
    });
    const entry = { pid: child.pid!, role: "worker" as const, started };
    expect(processGone(entry)).toBe(false);
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("exit", resolve));
    expect(processGone(entry)).toBe(true);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});

test("a child registered during its parent's exit prevents takeover from an earlier record", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-runner-race-")));
  try {
    const file = runnerProcessFile(join(dir, "orders.db"), "w-1");
    writeRunnerProcessRecord(file, record({ processes: [record().processes[0]!] }));
    const racing: ProcessProbe = { exists: () => { writeRunnerProcessRecord(file, record()); return "absent"; }, start: () => null };
    expect(recordedHolderProvedGone(file, holder, "here", racing).gone).toBe(false);
    expect(recordedHolderProvedGone(file, holder, "here", probe({})).gone).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a database alias stores takeover evidence beside the actual fenced database", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-runner-db-link-")));
  try {
    mkdirSync(join(dir, "state"));
    const file = join(dir, "state", "orders.db"), alias = join(dir, "alias.db");
    writeFileSync(file, ""); symlinkSync(file, alias);
    expect(runnerProcessFile(alias, "w-1")).toBe(runnerProcessFile(file, "w-1"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
