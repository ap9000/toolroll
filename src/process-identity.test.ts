/**
 * Process identity (process-identity.ts): Linux reads /proc (boot id + start ticks, the command name parsed safely), ps
 * is the fallback, each identity is tagged by its provider, and anything unreadable or unknown stays "unknown", never
 * "other": a provider or format change can't prove a live process gone.
 */
import { expect, test } from "vitest";
import { identityProvider, processGroupId, processGroupRss, processIdentity, processIdentityProblem, procStatFields, sameProcess, type IdentityIo } from "./process-identity.js";
import { fakePid } from "../test/fake-pid.js";

const BOOT = "0f6a3c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b";
const PID = fakePid(7);
/** A /proc/<pid>/stat line: `comm` as the kernel prints it, group, start ticks. */
const stat = (comm: string, pgrp: number, ticks: string): string =>
  `${PID} (${comm}) S 1 ${pgrp} ${pgrp} 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 ${ticks} 1000000 200 18446744073709551615\n`;
/** A Linux whose /proc holds `files` (path → contents; missing throws) and whose ps prints `ps` (null: fails). */
const linux = (files: Record<string, string>, ps: Record<string, string | null> = {}): IdentityIo => ({
  platform: "linux", procRoot: "/proc",
  read: file => { const one = files[file]; if (one === undefined) throw Object.assign(Error("ENOENT"), { code: "ENOENT" }); return one; },
  ps: (_pid, field) => ps[field] ?? null,
});
const proc = (comm = "node", ticks = "123456", pgrp = PID) => ({ [`/proc/${PID}/stat`]: stat(comm, pgrp, ticks), "/proc/sys/kernel/random/boot_id": `${BOOT}\n` });

test("Linux: boot id and start ticks from /proc, the command name read safely even with spaces and parentheses", () => {
  expect(processIdentity(PID, undefined, linux(proc()))).toBe(`proc:${BOOT}:123456`);
  expect(processIdentity(PID, undefined, linux(proc("evil) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 99999 (x")))).toBe(`proc:${BOOT}:123456`);
  expect(processGroupId(PID, linux(proc("a b) c", "1", fakePid(9))))).toBe(fakePid(9));
});

test.each([
  ["no closing parenthesis", `${PID} (node S 1 2 3`],
  ["too few fields", `${PID} (node) S 1 2 3`],
  ["a start that isn't a number", stat("node", PID, "12x")],
  ["empty", ""],
])("a malformed stat (%s) is no /proc identity: ps is asked, and without it the identity is unknown", (_, line) => {
  const files = { ...proc(), [`/proc/${PID}/stat`]: line };
  expect(processIdentity(PID, undefined, linux(files))).toBeNull();
  expect(processIdentity(PID, undefined, linux(files, { lstart: "Thu Oct 29 13:11:05 2026\n" }))).toBe("2026-10-29T13:11:05.000Z");
  expect(processIdentity(PID, "proc", linux(files, { lstart: "Thu Oct 29 13:11:05 2026\n" }))).toBeNull();
});

test("stat fields are read after the last parenthesis, or not at all", () => {
  for (const line of [`${PID} (node S 1 2 3`, `${PID} (node) S 1 2 3`, ""]) expect(procStatFields(line)).toBeNull();
  expect(procStatFields(stat("a) b", PID, "77"))?.[19]).toBe("77");
});

test("unreadable /proc (or no boot id) falls back to ps; busybox ps (no lstart) leaves it unknown and doctor says what to install", () => {
  expect(processIdentity(PID, undefined, linux({}, { lstart: "Fri Oct  9 07:05:01 2026" }))).toBe("2026-10-09T07:05:01.000Z");
  expect(processIdentity(PID, undefined, linux({ [`/proc/${PID}/stat`]: stat("node", PID, "5") }, { lstart: "Fri Oct  9 07:05:01 2026" }))).toBe("2026-10-09T07:05:01.000Z");
  expect(processIdentity(PID, undefined, linux({}, { lstart: "ps: bad -o argument 'lstart'" }))).toBeNull();
  expect(processIdentityProblem(linux({}))).toMatch(/procps/);
  expect(processIdentityProblem({ ...linux({}), read: file => file.endsWith("boot_id") ? BOOT : stat("node", 1, "5") })).toBeNull();
});

test.each([
  ["the same process, by /proc", `proc:${BOOT}:123456`, linux(proc()), "same"],
  ["the pid reused (another start)", `proc:${BOOT}:100`, linux(proc()), "other"],
  ["the pid reused after a reboot", "proc:11111111-2222-4333-8444-555555555555:123456", linux(proc()), "other"],
  ["a /proc record, /proc unreadable now (ps works)", `proc:${BOOT}:123456`, linux({}, { lstart: "Thu Oct 29 13:11:05 2026" }), "unknown"],
  ["a legacy ISO record read by ps", "2026-10-29T13:11:05.000Z", linux(proc(), { lstart: "Thu Oct 29 13:11:05 2026" }), "same"],
  ["a legacy ISO record, ps gone (/proc only)", "2026-10-29T13:11:05.000Z", linux(proc()), "unknown"],
  ["a legacy raw lstart record (UTC) read by ps", "Thu Oct 29 13:11:05 2026", linux(proc(), { lstart: "Thu Oct 29 13:11:05 2026" }), "same"],
  ["a legacy ISO record, the pid reused", "2026-10-29T13:11:05.000Z", linux(proc(), { lstart: "Thu Oct 29 14:00:00 2026" }), "other"],
  ["an unknown format", "boot:7:4242", linux(proc(), { lstart: "Thu Oct 29 13:11:05 2026" }), "unknown"],
] as const)("same process? %s → %s", (_, recorded, io, verdict) => {
  expect(sameProcess(PID, recorded, io)).toBe(verdict);
});

test("providers are told apart by format; Windows has none", () => {
  expect(identityProvider(`proc:${BOOT}:1`)).toBe("proc");
  expect(identityProvider("2026-10-29T13:11:05.000Z")).toBe("ps");
  expect(identityProvider("Thu Oct 29 13:11:05 2026")).toBe("ps");
  expect(identityProvider("proc:not-a-boot-id:1")).toBeNull();
  expect(processIdentity(PID, undefined, { platform: "win32" })).toBeNull();
  expect(processIdentityProblem({ platform: "win32" })).toMatch(/Windows/);
});

test("a group's memory from /proc: every process of the group, VmRSS in kB", () => {
  const files: Record<string, string> = {};
  const add = (pid: number, pgrp: number, kb: number): void => {
    files[`/proc/${pid}/stat`] = stat("sh", pgrp, "1").replace(String(PID), String(pid));
    files[`/proc/${pid}/status`] = `Name:\tsh\nVmRSS:\t   ${kb} kB\n`;
  };
  add(fakePid(1), fakePid(1), 100);
  add(fakePid(2), fakePid(1), 50);
  add(fakePid(3), fakePid(3), 999);
  const io = { ...linux(files), list: () => [String(fakePid(1)), String(fakePid(2)), String(fakePid(3)), "self", String(fakePid(4))] };
  expect(processGroupRss(fakePid(1), io)).toBe(150 * 1024);
});
