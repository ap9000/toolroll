import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import {
  desktopUpdateJournalSchema, readDesktopRecoveryView, readDesktopUpdateJournal, readRuntimeUpdateJournal, runtimeUpdateJournalSchema,
  stagedStartedAt, supervisorPidsOf, updateRequestIs, updaterStartingOf, type JournalRead,
} from "./update-journal.js";
import { codingItemSchema, codingRequestSchema, readCodingCustodyWitness, readCodingItem, readCodingRequest, readCodingRpcId } from "./coding-activity.js";
import { parseDarwinNativeSnapshot } from "../process-recovery-native.js";

const verdict = (read: JournalRead<unknown>): SampleVerdict => read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) };
const id = "8b0c6a1e-3f7d-4a52-9c1e-2d4f6b8a0c1e";
const bundle = (version: string, buildId: string) => ({ path: "/Applications/Standing Orders.app", hash: "a".repeat(64), buildId, version, bundleId: "com.standing-orders.desktop", schemaVersion: 1, development: false, providerBin: "/usr/local/bin/codex" });

/** A desktop update as 0.9.12 saved it (no recovery protocol, no stopped pids), and one from the current writer. */
const desktopLegacy = { version: 1, id, workDir: `/Applications/.standing-orders-updates/${id}`, old: bundle("0.9.11", "11111111-1111-4111-8111-111111111111"), next: bundle("0.9.12", "22222222-2222-4222-8222-222222222222"), configHash: "b".repeat(64), label: "com.standing-orders.desktop", stateDir: "/state", databaseFile: "/state/orders.db", wasRunning: true, phase: "complete", intended: "install", startedAt: "2026-10-02T10:00:00.000Z", updatedAt: "2026-10-02T10:05:00.000Z", detail: "Updated." };
const desktopCurrent = { ...desktopLegacy, next: { ...desktopLegacy.next, recoveryProtocol: 1 }, codingCatalogExpected: true, stoppedPids: [612, 613], waiting: { run: 7, on: "Run #7 is still running", action: null, since: "2026-10-02T10:01:00.000Z" }, codingOwnerReleased: { pid: 612, nativePid: null }, serviceInterrupted: true, replacementOccurred: false, retryableRecovery: true };

/** A `toolroll update` as 0.8.1 saved it (watches without `loaded`), and a rollback with every later field. */
const runtimeLegacy = { version: 1, id, kind: "update", stateDir: "/state", databaseFile: "/state/orders.db", stageDir: `/state/staged-upgrades/release-0.8.1-${id.slice(0, 8)}`, from: { version: "0.8.0", dist: "/rt/0.8.0/dist" }, to: { version: "0.8.1", dist: "/rt/0.8.1/dist" }, when: "now", at: null, actor: "operator", phase: "complete", detail: "Updated.", steps: [{ phase: "verifying", at: "2026-09-01T00:00:00.000Z" }, { phase: "complete", at: "2026-09-01T00:03:00.000Z" }], startedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:03:00.000Z", finishedAt: "2026-09-01T00:03:00.000Z", watches: [{ unit: "/LaunchAgents/watch.plist", pids: [700] }] };
const runtimeCurrent = { ...runtimeLegacy, kind: "rollback", phase: "needs-attention", restoreFrom: { path: "/b/orders.backup.db", hash: "c", updateId: id }, rehearsal: { tables: 40, rows: 1200 }, service: { unit: "/LaunchAgents/service.plist", pids: [701] }, watches: [{ unit: "/w.plist", pids: [], loaded: true }], switched: { links: [{ path: "/bin/toolroll", previous: "/rt/0.8.1/bin.js" }], unit: null, watches: [], databaseRestored: true }, kept: [{ path: "/k/orders.kept.db", unreadable: false }], keptAside: "/k/orders.kept.db", restoredDatabase: true, seen: true, waiting: { run: 3, on: "Run #3 hasn't finished shutting down", action: "toolroll run settle 3", since: "2026-09-01T00:01:00.000Z" } };

describe("the update journal contracts", () => {
  it("desktop: saved and current journals read, unknown keys are ignored, a newer or malformed one is refused by path", () => {
    assertContract({
      read: input => verdict(readDesktopUpdateJournal(input)),
      valid: [
        { name: "saved by 0.9.12", input: desktopLegacy },
        { name: "current writer", input: desktopCurrent },
        { name: "a key a newer release added under version 1", input: { ...desktopCurrent, laterField: { kept: true } } },
      ],
      invalid: [
        { name: "newer version", input: { ...desktopLegacy, version: 2 }, paths: ["version"] },
        { name: "no next bundle", input: { ...desktopLegacy, next: undefined }, paths: ["next"] },
        { name: "unknown phase", input: { ...desktopLegacy, phase: "paused" }, paths: ["phase"] },
        { name: "wasRunning as text", input: { ...desktopLegacy, wasRunning: "yes" }, paths: ["wasRunning"] },
        { name: "stopped pids as text", input: { ...desktopLegacy, stoppedPids: ["612"] }, paths: ["stoppedPids[0]"] },
      ],
    });
    expect(readDesktopUpdateJournal({ ...desktopLegacy, version: 2 })).toMatchObject({ ok: false, issues: [{ line: expect.stringContaining("made by a newer Toolroll") }] });
    expect(Object.keys(desktopUpdateJournalSchema.shape)).toContain("codingOwnerReleased");
  });

  it("runtime: 0.8.1 and current journals read; partial and newer ones are refused by path", () => {
    assertContract({
      read: input => verdict(readRuntimeUpdateJournal(input)),
      valid: [
        { name: "saved by 0.8.1", input: runtimeLegacy },
        { name: "current rollback", input: runtimeCurrent },
        { name: "a key a newer release added under version 1 (read by a rolled-back runtime)", input: { ...runtimeCurrent, laterField: 1 } },
      ],
      invalid: [
        { name: "newer version", input: { ...runtimeLegacy, version: 2 }, paths: ["version"] },
        { name: "a stage's partial file", input: { version: 1, id, startedAt: runtimeLegacy.startedAt }, paths: ["stateDir", "stageDir", "steps"] },
        { name: "not an object", input: null, paths: ["payload"] },
      ],
    });
    expect(Object.keys(runtimeUpdateJournalSchema.shape)).toContain("waiting");
  });

  it("returns the saved object itself, so a journal saved again keeps its bytes and key order", () => {
    for (const saved of [desktopCurrent, { ...runtimeCurrent, laterField: 1 }]) {
      const bytes = JSON.stringify(saved, null, 2);
      const input = JSON.parse(bytes) as unknown;
      const read = "old" in saved ? readDesktopUpdateJournal(input) : readRuntimeUpdateJournal(input);
      expect(read.ok && read.value).toBe(input);
      expect(JSON.stringify(read.ok && read.value, null, 2)).toBe(bytes);
    }
  });

  it("small control records read exactly as the old casts did", () => {
    expect(updaterStartingOf({ id, state: "launched", at: "2026-10-02T10:00:00.000Z" })).toEqual({ id, at: Date.parse("2026-10-02T10:00:00.000Z") });
    expect(updaterStartingOf(null)).toBeNull();
    expect(updaterStartingOf({ id })!.at).toBeNaN();
    expect(updateRequestIs({ id, action: "stop", extra: 1 }, id, "stop")).toBe(true);
    expect(updateRequestIs({ id, action: "restore" }, id, "stop")).toBe(false);
    expect(updateRequestIs([], id, "stop")).toBe(false);
    expect(supervisorPidsOf({ supervisorPid: 612, controllerPid: 1, buildId: "x" })).toEqual([612]);
    expect(supervisorPidsOf("not a status")).toEqual([]);
    expect(readDesktopRecoveryView({ id, state: "armed", attempts: 2, extra: true })).toEqual({ id, state: "armed", attempts: 2 });
    expect(readDesktopRecoveryView({ id, attempts: "2" })).toEqual({ id });
    expect(readDesktopRecoveryView(null)).toBeNull();
  });

  it("a staged release's partial update.json still says when it started; null and non-JSON fall back to the mtime", () => {
    expect(stagedStartedAt({ startedAt: "2026-10-02T10:00:00.000Z" })).toBe("2026-10-02T10:00:00.000Z");
    expect(stagedStartedAt({ version: 1 })).toBe("");
    expect(stagedStartedAt({ startedAt: 5 })).toBe("5");
    expect(stagedStartedAt([])).toBe("");
    expect(stagedStartedAt(null)).toBeNull();
  });
});

describe("the coding activity contracts", () => {
  const item = { id: "item-1", type: "userMessage", text: "Run the tests", status: null, clientId: "k".repeat(16) };
  const request = { id: "t", kind: "questions", method: "item/tool/requestUserInput", title: "The agent needs your answer", detail: "", questions: [{ id: "q", header: "H", question: "Which?", options: [{ label: "A", description: "" }] }] };
  it("item and request rows are read as saved, without a version, and a mismatch is logged rather than refused", () => {
    assertContract({ schema: codingItemSchema, read: input => codingItemSchema.safeParse(input).success ? { ok: true } : { ok: false, lines: ["payload: invalid"] }, valid: [{ name: "user message", input: item }, { name: "agent message in progress", input: { id: "a", type: "agentMessage", text: "", status: "inProgress" } }], invalid: [] });
    assertContract({ schema: codingRequestSchema, read: input => codingRequestSchema.safeParse(input).success ? { ok: true } : { ok: false, lines: ["payload: invalid"] }, valid: [{ name: "questions", input: request }], invalid: [] });
    const bytes = JSON.stringify(item);
    expect(JSON.stringify(readCodingItem(bytes))).toBe(bytes);
    expect(readCodingRequest(JSON.stringify(request))).toEqual(request);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readCodingItem('{"id":"old","retired":true}')).toEqual({ id: "old", retired: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("type: required"));
    } finally { warn.mockRestore(); }
    expect(() => readCodingItem("{")).toThrow(SyntaxError);
    expect(readCodingRpcId("7")).toBe(7);
    expect(readCodingRpcId('"req-1"')).toBe("req-1");
  });
  it("a custody witness without the fields recovery checks proves nothing", () => {
    const witness = { pid: 5, group: true, descendants: [], observationUnknown: false, host: "h", bootId: null };
    expect(readCodingCustodyWitness(JSON.stringify(witness))).toEqual(witness);
    expect(readCodingCustodyWitness(JSON.stringify({ ...witness, descendants: null }))).toBeNull();
    expect(readCodingCustodyWitness("null")).toBeNull();
  });
});

describe("the native census contract", () => {
  const row = { pid: 1, ppid: 0, uid: 0, birthMs: 1, uniqueId: "1", parentUniqueId: "0", traced: false, executable: "/sbin/launchd", originalParentVersion: 0 };
  const census = (extra: object = {}) => JSON.stringify({ schema: 1, bootId: "0774c645-ad9a-4d83-9efb-eca6506656c5", collectorPid: 2, complete: false, processes: [{ ...row, extra: "dropped" }, { ...row, pid: 2, uniqueId: "18446744073709551615", pidVersion: 4 }], errors: [], ...extra });
  it("keeps its reason codes and rebuilds each identity in its sealed key order", () => {
    const parsed = parseDarwinNativeSnapshot(census({ unknown: true }));
    expect(JSON.stringify(parsed.processes[0])).toBe(JSON.stringify(row));
    expect(Object.keys(parsed.processes[1]!)).toEqual([...Object.keys(row), "pidVersion"]);
    expect(() => parseDarwinNativeSnapshot(census({ schema: 2 }))).toThrow("malformed-native-census");
    expect(() => parseDarwinNativeSnapshot(census({ errors: ["new-error"] }))).toThrow("malformed-native-census");
    expect(() => parseDarwinNativeSnapshot(census({ processes: [row, { ...row, pid: 2, uniqueId: "18446744073709551616" }] }))).toThrow("malformed-process-identity");
    expect(() => parseDarwinNativeSnapshot(census({ processes: [row, row] }))).toThrow("malformed-process-identity");
    expect(() => parseDarwinNativeSnapshot(census({ processes: [row, { ...row, pid: 2, traced: undefined }] }))).toThrow("malformed-process-identity");
  });
});

describe("the zod revamp plan", () => {
  it("marks item 19 done in the wave 4 table, with one Done entry", () => {
    const plan = readFileSync(new URL("../../docs/plans/zod-revamp.md", import.meta.url), "utf8");
    expect(plan).toMatch(/^\| 19 ✅ \| \*\*Journals and recovery state\*\*/m);
    expect(plan.match(/^- \*\*19\. Journals and recovery state\*\*/gm)).toHaveLength(1);
  });
});
