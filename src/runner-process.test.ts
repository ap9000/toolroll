/**
 * The record of who holds a runner's credential (runner-process.ts): a stale holder is proved gone only by identity
 * (no such process, or a process with that id started at another time), and only for the exact registration the plane
 * holds. Everything else proves nothing.
 */
import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialDigest, holderProvedGone, parseProcessStart, processGone, processStart, readRunnerProcessRecord, runnerProcessFile, writeRunnerProcessRecord, type ProcessProbe, type RunnerProcessRecord } from "./runner-process.js";
import type { Runner } from "./runner.js";

const runner: Runner = { name: "w-1", host: "here", capacity: 1, repos: [], agents: [], registeredAt: "2026-10-29T12:00:00.000Z", heartbeatAt: "2026-10-29T12:00:30.000Z", retiredAt: null };
const holder = { runner, credentialHash: "a".repeat(64) };
const record = (patch: Partial<RunnerProcessRecord> = {}): RunnerProcessRecord => ({
  v: 1, runner: "w-1", host: "here", registeredAt: runner.registeredAt, credential: credentialDigest(holder.credentialHash),
  processes: [{ pid: 4242, role: "up", started: "2026-10-29T11:59:59.000Z" }, { pid: 4243, role: "worker", started: "2026-10-29T12:00:01.000Z" }], ...patch,
});
/** Each pid: absent, present with this start, present with an unreadable start, or unknown to the probe. */
const probe = (world: Record<number, string | null | "unknown">): ProcessProbe => ({
  exists: pid => !(pid in world) ? "absent" : world[pid] === "unknown" ? "unknown" : "present",
  start: pid => { const one = world[pid]; return one === undefined || one === "unknown" ? null : one; },
});

test.each([
  ["every process exited", {}, record(), true],
  ["a pid reused by a process started later", { 4242: "2026-10-29T13:00:00.000Z", 4243: "2026-10-29T13:00:01.000Z" }, record(), true],
  ["the `up` still runs", { 4242: "2026-10-29T11:59:59.000Z" }, record(), false],
  ["a role still runs", { 4243: "2026-10-29T12:00:01.000Z" }, record(), false],
  ["a process whose start can't be read", { 4242: null }, record(), false],
  ["a pid the probe can't answer for", { 4242: "unknown" }, record(), false],
  ["a record from an earlier start", {}, record({ registeredAt: "2026-10-29T11:00:00.000Z" }), false],
  ["a record for another credential", {}, record({ credential: credentialDigest("b".repeat(64)) }), false],
  ["a record for another machine", {}, record({ host: "elsewhere" }), false],
  ["a record for another worker", {}, record({ runner: "w-2" }), false],
  ["a record that names no `up`", {}, record({ processes: [{ pid: 4243, role: "worker", started: "2026-10-29T12:00:01.000Z" }] }), false],
] as const)("holder proved gone: %s → %s", (_, world, one, gone) => {
  expect(holderProvedGone(one, holder, "here", probe(world)).gone).toBe(gone);
});

test("no record, or a record read on another host, proves nothing", () => {
  expect(holderProvedGone(null, holder, "here", probe({})).gone).toBe(false);
  expect(holderProvedGone(record(), holder, "elsewhere", probe({})).gone).toBe(false);
});

test("a record is read strictly: a link, a damaged file or a wrong shape is no record", () => {
  const dir = mkdtempSync(join(tmpdir(), "so-runner-process-"));
  try {
    const file = runnerProcessFile(join(dir, "orders.db"), "w-1");
    expect(file.startsWith(join(dir, "runner-processes"))).toBe(true);
    expect(file).not.toContain("w-1");
    writeRunnerProcessRecord(file, record());
    expect(readRunnerProcessRecord(file)).toEqual(record());
    const linked = `${file}.link`;
    symlinkSync(file, linked);
    expect(readRunnerProcessRecord(linked)).toBeNull();
    for (const bad of ["not json", JSON.stringify({ ...record(), v: 2 }), JSON.stringify({ ...record(), processes: [{ pid: 1, role: "up", started: "2026-10-29T11:59:59.000Z" }] }),
      JSON.stringify({ ...record(), processes: [{ pid: 4242, role: "builder", started: "2026-10-29T11:59:59.000Z" }] }), JSON.stringify({ ...record(), processes: [] })]) {
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
  expect(own).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
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
