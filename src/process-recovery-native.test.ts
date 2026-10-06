import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn() }));
import {
  DARWIN_PROCESS_CENSUS_SOURCE, collectDarwinCoalitionSnapshot,
  changedDarwinProcessIdentities, parseDarwinLaunchdServices, parseDarwinNativeSnapshot,
  parseDarwinPidDomain, parseDarwinCoalitionNativeSnapshot, compareDarwinCoalitionSnapshots, type DarwinProcessIdentity,
} from "./process-recovery-native.js";
import { fakePid } from "../test/fake-pid.js";

const formerParent = fakePid(1), newParent = fakePid(2), member = fakePid(3), peer = fakePid(4), creator = fakePid(5), outsider = fakePid(6);
const service = fakePid(7), application = fakePid(8), spoofed = fakePid(9), anchor = fakePid(10);

const processRow = (pid: number, extra: Partial<DarwinProcessIdentity> = {}): DarwinProcessIdentity => ({
  pid, ppid: 1, uid: 501, birthMs: 1_789_900_000_123.456,
  uniqueId: `${9_007_199_254_740_991n + BigInt(pid)}`, parentUniqueId: "1", traced: false,
  executable: "/usr/bin/example", originalParentVersion: 7, ...extra,
});
const native = (processes: unknown[], extra = {}) => JSON.stringify({ schema: 1, bootId: "0774c645-ad9a-4d83-9efb-eca6506656c5", collectorPid: member, complete: true, processes, errors: [], ...extra });

describe("Darwin recovery census facts", () => {
  it("preserves identities above JS integer precision and drops unrelated data", () => {
    const result = parseDarwinNativeSnapshot(native([{ ...processRow(1), argv: "PRIVATE" }, processRow(member)], { environment: "PRIVATE" }));
    expect(result.processes[1]!.uniqueId).toBe("9007199258940998");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("rejects duplicate PID/unique identities and claims of completeness with missing rows", () => {
    expect(() => parseDarwinNativeSnapshot(native([processRow(1), processRow(member), processRow(member)]))).toThrow();
    expect(() => parseDarwinNativeSnapshot(native([processRow(1), processRow(member, { uniqueId: processRow(1).uniqueId })]))).toThrow();
    expect(() => parseDarwinNativeSnapshot(native([processRow(1)]))).toThrow();
    expect(() => parseDarwinNativeSnapshot(native([processRow(1), processRow(member, { uniqueId: null })]))).toThrow();
    expect(() => parseDarwinNativeSnapshot(native([processRow(1), processRow(member, { uniqueId: "18446744073709551616" })]))).toThrow();
  });
  it("retains unreadable process rows as incomplete rather than silently dropping them", () => {
    const result = parseDarwinNativeSnapshot(native([processRow(1), processRow(member, { uniqueId: null })], { complete: false, errors: ["process-identity-unreadable"] }));
    expect(result.processes).toHaveLength(2);
    expect(result.complete).toBe(false);
  });
  it("invalidates ancestry changes even when the 64-bit process identity survives exec", () => {
    const before = [processRow(1), processRow(member, { ppid: formerParent, parentUniqueId: "8000" })];
    expect(changedDarwinProcessIdentities(before, [before[0]!, processRow(member)])).toEqual([member]);
    for (const difference of [{ uid: 0 }, { traced: true }, { birthMs: 123 }, { uniqueId: "991" }]) {
      expect(changedDarwinProcessIdentities([processRow(member)], [processRow(member, difference)])).toEqual([member]);
    }
  });
  it("binds current exec version separately from unchanged original-parent version", () => {
    const first = parseDarwinNativeSnapshot(native([processRow(1), processRow(member, { pidVersion: 123 })]));
    expect(first.processes[1]!.pidVersion).toBe(123);
    expect(changedDarwinProcessIdentities(first.processes, [processRow(1), processRow(member, { pidVersion: 124 })])).toEqual([member]);
    expect(changedDarwinProcessIdentities(first.processes, [processRow(1), processRow(member)])).toEqual([member]);
    expect(() => parseDarwinNativeSnapshot(native([processRow(1), processRow(member, { pidVersion: -1 })]))).toThrow();
  });
  it("reports disappeared and newly born PIDs instead of declaring a stable intersection", () => {
    expect(changedDarwinProcessIdentities([processRow(1), processRow(member)], [processRow(1), processRow(peer)])).toEqual([member, peer]);
    expect(changedDarwinProcessIdentities([processRow(1), processRow(member)], [processRow(member), processRow(1)])).toEqual([]);
  });
  it("extracts only actual direct service rows, including launchctl's padded and pending forms", () => {
    const text = `system = {\n\tenvironment = {\n\t\tSECRET = PRIVATE\n\t}\n\tservices = {\n\t\t       0   (pe) \tcom.apple.pending\n\t\t     ${service}      - \tcom.apple.example\n\t\t     ${application}      1 \tApplication Name\n\t}\n\tother = {\n\t\tservices = {\n\t\t\t${spoofed} - spoofed\n\t\t}\n\t}\n}\n`;
    expect(parseDarwinLaunchdServices(text)).toEqual([{ pid: service, label: "com.apple.example" }, { pid: application, label: "Application Name" }]);
    expect(JSON.stringify(parseDarwinLaunchdServices(text))).not.toContain("PRIVATE");
    expect(() => parseDarwinLaunchdServices('\tservices = {\n\t\tbroken\n\t}\n')).toThrow();
    expect(() => parseDarwinLaunchdServices(`\tservices = {\n\t\t${service} - label\n`)).toThrow();
    expect(() => parseDarwinLaunchdServices(`\t\tservices = {\n\t\t\t${spoofed} - spoofed\n\t\t}\n`)).toThrow();
  });
  it("keeps PID-domain metadata diagnostic and omits nested identities and secrets", () => {
    const facts = parseDarwinPidDomain(`pid/${member} = {\n\ttype = pid\n\thandle = ${member}\n\toriginator = /System/Test.xpc\n\tcreator = launchctl[${creator}]\n\tenvironment = {\n\t\tSECRET = PRIVATE\n\t\ttype = spoofed\n\t}\n}\n`);
    expect(facts).toEqual({ type: "pid", handle: member, originator: "/System/Test.xpc", creatorPid: creator });
    expect(facts).not.toHaveProperty("identityBound");
    expect(facts).not.toHaveProperty("managedService");
    expect(JSON.stringify(facts)).not.toContain("PRIVATE");
  });
});


const coalition = (extra: Record<string, unknown> = {}) => JSON.stringify({
  schema: 1, bootId: "0774c645-ad9a-4d83-9efb-eca6506656c5", collectorPid: member,
  complete: true, resourceCoalitionId: "591", anchorPids: [], kernelTableRead: true, unreadableMembershipCount: 0,
  counterBefore: { tasksStarted: "9007199254741000", tasksExited: "9007199254740998" },
  counterAfter: { tasksStarted: "9007199254741000", tasksExited: "9007199254740998" },
  processes: [member, peer].map(pid => ({ ...processRow(pid), resourceCoalitionId: "591" })), errors: [], ...extra,
});
describe("resource coalition counter seal", () => {
  it("requires every membership read even when an unreadable process could be foreign and counts match", () => {
    expect(() => parseDarwinCoalitionNativeSnapshot(coalition({ unreadableMembershipCount: 1 }))).toThrow("incomplete-coalition-census");
    const unavailable = parseDarwinCoalitionNativeSnapshot(coalition({ complete: false, unreadableMembershipCount: 1, errors: ["process-membership-unreadable"] }));
    expect(compareDarwinCoalitionSnapshots(unavailable, unavailable)).toMatchObject({ complete: false, stable: false, errors: ["process-membership-unreadable"] });
    const parsed = parseDarwinCoalitionNativeSnapshot(coalition());
    expect(parsed.processes).toHaveLength(2);
    expect(parsed.counterBefore!.tasksStarted).toBe("9007199254741000");
    expect(compareDarwinCoalitionSnapshots(parsed, parsed)).toMatchObject({ complete: true, stable: true, countersStable: true });
    expect(parsed).not.toHaveProperty("historicalRun");
  });
  it("refuses hidden fork/exit or exec between individually complete observations", () => {
    const before = parseDarwinCoalitionNativeSnapshot(coalition());
    const after = parseDarwinCoalitionNativeSnapshot(coalition({
      counterBefore: { tasksStarted: "9007199254741001", tasksExited: "9007199254740999" },
      counterAfter: { tasksStarted: "9007199254741001", tasksExited: "9007199254740999" },
    }));
    expect(compareDarwinCoalitionSnapshots(before, after)).toMatchObject({ complete: false, stable: false, countersStable: false, errors: ["coalition-counters-changed"] });
  });
  it("rejects forged completeness with a missing member, foreign membership, or unreadable counters", () => {
    expect(() => parseDarwinCoalitionNativeSnapshot(coalition({ processes: [{ ...processRow(member), resourceCoalitionId: "591" }] }))).toThrow();
    expect(() => parseDarwinCoalitionNativeSnapshot(coalition({ processes: [member, peer].map(pid => ({ ...processRow(pid), resourceCoalitionId: "592" })) }))).toThrow();
    expect(() => parseDarwinCoalitionNativeSnapshot(coalition({ counterBefore: null }))).toThrow();
    expect(() => parseDarwinCoalitionNativeSnapshot(coalition({ kernelTableRead: false }))).toThrow();
    expect(() => parseDarwinCoalitionNativeSnapshot(coalition({ counterAfter: { tasksStarted: "18446744073709551616", tasksExited: "0" } }))).toThrow();
  });
  it("requires the same collector identity within the target coalition, not its numeric PID", () => {
    const before = parseDarwinCoalitionNativeSnapshot(coalition());
    const after = parseDarwinCoalitionNativeSnapshot(coalition({ processes: [
      { ...processRow(member, { uniqueId: "99999999999999" }), resourceCoalitionId: "591" },
      { ...processRow(peer), resourceCoalitionId: "591" },
    ] }));
    expect(compareDarwinCoalitionSnapshots(before, after)).toMatchObject({ stable: false, identityChanges: [member], errors: ["process-census-changed", "collector-coalition-mismatch"] });
    const outside = parseDarwinCoalitionNativeSnapshot(coalition({ collectorPid: outsider }));
    expect(compareDarwinCoalitionSnapshots(outside, outside)).toMatchObject({ complete: false, errors: ["collector-coalition-mismatch"] });
  });
  it("requires matching boot, coalition and unchanged ancestry independently of task counts", () => {
    const before = parseDarwinCoalitionNativeSnapshot(coalition());
    const after = parseDarwinCoalitionNativeSnapshot(coalition({ processes: [
      { ...processRow(member), resourceCoalitionId: "591" },
      { ...processRow(peer, { parentUniqueId: "10000", ppid: newParent }), resourceCoalitionId: "591" },
    ] }));
    expect(compareDarwinCoalitionSnapshots(before, after)).toMatchObject({ stable: false, identityChanges: [peer] });
    const reboot = parseDarwinCoalitionNativeSnapshot(coalition({ bootId: "0774c645-ad9a-4d83-9efb-eca6506656c6" }));
    expect(compareDarwinCoalitionSnapshots(before, reboot).errors).toContain("census-context-changed");
  });
});

describe("explicit cross-coalition identity anchors", () => {
  const anchored = (extra: Partial<DarwinProcessIdentity> & { resourceCoalitionId?: string } = {}) => coalition({
    anchorPids: [anchor],
    processes: [
      ...[member, peer].map(pid => ({ ...processRow(pid), resourceCoalitionId: "591" })),
      { ...processRow(anchor), resourceCoalitionId: "777", ...extra },
    ],
  });
  it("revalidates outside anchors without counting them as target members", () => {
    const value = parseDarwinCoalitionNativeSnapshot(anchored());
    expect(value.processes).toHaveLength(2);
    expect(value.anchors).toEqual([{ ...processRow(anchor), resourceCoalitionId: "777" }]);
    expect(compareDarwinCoalitionSnapshots(value, value)).toMatchObject({ complete: true, stable: true, anchorIdentityChanges: [] });
    expect(() => parseDarwinCoalitionNativeSnapshot(coalition({ anchorPids: [anchor] }))).toThrow();
    expect(() => parseDarwinCoalitionNativeSnapshot(coalition({ anchorPids: [member, member] }))).toThrow();
  });
  it("refuses changed anchor identity, ancestry or coalition despite unchanged target counters", () => {
    const before = parseDarwinCoalitionNativeSnapshot(anchored());
    for (const changes of [{ uniqueId: "9999999999" }, { resourceCoalitionId: "778" }, { parentUniqueId: "888" }, { uid: 0 }, { traced: true }]) {
      const after = parseDarwinCoalitionNativeSnapshot(anchored(changes));
      expect(compareDarwinCoalitionSnapshots(before, after)).toMatchObject({ stable: false, countersStable: true, anchorIdentityChanges: [anchor], errors: ["anchor-identity-changed"] });
    }
  });
});


describe("owned census cleanup", () => {
  it.each(["first response", "second response", "child error", "timeout"])("waits for positive close after %s failure before retry or return", async failure => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "so-census-cleanup-")));
    const sourcePath = join(directory, "census.c"), executablePath = join(directory, "census");
    writeFileSync(sourcePath, DARWIN_PROCESS_CENSUS_SOURCE, { mode: 0o600 });
    writeFileSync(executablePath, "mocked executable", { mode: 0o500 });
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const prepared = { sourcePath, executablePath, sourceSha256: sha(DARWIN_PROCESS_CENSUS_SOURCE), executableSha256: sha("mocked executable") };
    const children = [member, peer].map(pid => Object.assign(new EventEmitter(), {
      pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => false),
    }));
    vi.mocked(spawn).mockReset();
    for (const child of children) vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
    vi.useFakeTimers();
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    let returned = false;
    const result = collectDarwinCoalitionSnapshot({ native: prepared, resourceCoalitionId: "591", maxAttempts: 2 }).then(value => { returned = true; return value; });
    try {
      expect(spawn).toHaveBeenCalledTimes(1);
      if (failure === "second response") { children[0]!.stdout.write(coalition() + "\n"); await flush(); }
      if (failure === "child error") children[0]!.emit("error", new Error("owned child error"));
      else if (failure === "timeout") await vi.advanceTimersByTimeAsync(120_000);
      else children[0]!.stdout.write("malformed\n");
      await flush();
      expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(returned).toBe(false);
      children[0]!.emit("close", null, "SIGTERM");
      await flush();
      expect(spawn).toHaveBeenCalledTimes(2);
      const valid = coalition({ collectorPid: peer });
      children[1]!.stdout.write(valid + "\n"); await flush();
      children[1]!.stdout.write(valid + "\n"); await flush();
      expect(returned).toBe(false); // Two responses alone do not establish exit.
      children[1]!.emit("close", 0, null);
      expect(await result).toMatchObject({ complete: true, stable: true, collector: { pid: peer, exited: true } });
    } finally {
      for (const child of children) child.emit("close", 1, null);
      await result;
      vi.useRealTimers(); vi.unstubAllGlobals(); vi.mocked(spawn).mockReset();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
