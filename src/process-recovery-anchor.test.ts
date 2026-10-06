import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteRuntime } from "./sqlite-runtime.js";
import type { DatabaseSync } from "node:sqlite";
import type { DarwinCoalitionProcessIdentity, DarwinCoalitionRecoverySnapshot } from "./process-recovery-native.js";
const controls = vi.hoisted(() => ({ fingerprint: "9641efcb3b46717a7f122aa025e3945a08fa55ca046605276825a9d69eefd01d",
  command: vi.fn(), capture: vi.fn() }));
vi.mock("node:crypto", () => ({ createHash: () => ({ update() { return this; }, digest: () => controls.fingerprint }) }));
vi.mock("node:child_process", () => ({ execFileSync: (...args: unknown[]) => controls.command(...args) }));
vi.mock("./process-recovery-native.js", async original => ({ ...await original<typeof import("./process-recovery-native.js")>(), collectDarwinCoalitionSnapshot: (...args: unknown[]) => controls.capture(...args) }));
import { collectDarwinServiceAnchor, SERVICE_ANCHOR_RUNTIME_V1_SHA256, type DarwinServiceAnchorInput } from "./process-recovery-anchor.js";
import { fakePid } from "../test/fake-pid.js";

let directory: string, writer: DatabaseSync, reader: DatabaseSync, input: DarwinServiceAnchorInput;
const boot = "0774c645-ad9a-4d83-9efb-eca6506656c5", owner = "e2091c58-4b9a-4e64-83a7-1184a731f88e";
const supervisorPid = fakePid(1), workerPid = fakePid(2), collectorPid = fakePid(3), strangerPid = fakePid(4);
const time = (ago: number) => new Date(Date.now() - ago).toISOString();
const row = (pid: number): DarwinCoalitionProcessIdentity => ({ pid, ppid: pid === workerPid ? supervisorPid : 1, uniqueId: String(pid * 10),
  parentUniqueId: pid === workerPid ? String(supervisorPid * 10) : "1", uid: 501, birthMs: 1, traced: false,
  executable: "/usr/local/bin/node", originalParentVersion: 7, resourceCoalitionId: "500" });
function snapshot(): DarwinCoalitionRecoverySnapshot {
  return { schema: 1, host: "test-host", bootId: boot, osRelease: "25.5.0", startedAt: time(100), finishedAt: time(0),
    resourceCoalitionId: "591", complete: true, stable: true, anchorPids: [workerPid, supervisorPid], anchors: [row(workerPid), row(supervisorPid)], anchorIdentityChanges: [],
    processes: [], counterBefore: { tasksStarted: "1", tasksExited: "0" }, counterAfter: { tasksStarted: "1", tasksExited: "0" },
    countersStable: true, kernelTableRead: true, unreadableMembershipCount: 0, identityChanges: [], errors: [],
    collector: { pid: collectorPid, uniqueId: "9999", exited: true }, nativeSourceSha256: SERVICE_ANCHOR_RUNTIME_V1_SHA256, nativeExecutableSha256: "b".repeat(64) };
}
beforeEach(() => {
  vi.stubGlobal("process", new Proxy(process, { get(target, property) { return property === "platform" ? "darwin" : Reflect.get(target, property); } }));
  directory = realpathSync(mkdtempSync(join(tmpdir(), "watch-anchor-")));
  const runtime = join(directory, "dist"), repo = join(directory, "repo"), databasePath = join(directory, "orders.db");
  mkdirSync(runtime); mkdirSync(repo); writeFileSync(join(runtime, "cli.js"), "fixture");
  const { DatabaseSync } = sqliteRuntime(); writer = new DatabaseSync(databasePath);
  writer.exec(`CREATE TABLE run(id INTEGER PRIMARY KEY, task_ref INTEGER, runner TEXT, watch_incarnation TEXT, role TEXT, parent_run INTEGER, started_at TEXT, finished_at TEXT, outcome TEXT);
    CREATE TABLE task_ref(id INTEGER PRIMARY KEY,repo TEXT);
    CREATE TABLE watch_lease(runner TEXT,repo TEXT,owner TEXT,generation INTEGER,heartbeat_at TEXT,expires_at TEXT);
    CREATE TABLE watch_episode(id INTEGER,repo TEXT,runner TEXT,incarnation TEXT,started_at TEXT,ended_at TEXT);
    CREATE TABLE runner(name TEXT,host TEXT,credential_hash TEXT,registered_at TEXT,retired_at TEXT,repos TEXT);
    CREATE TABLE proof_verdict(run INTEGER,verdict TEXT);
    CREATE TABLE criterion_review(reviewer_run INTEGER,source_run INTEGER,judgement TEXT);
    CREATE TABLE run_process(run INTEGER,host TEXT,boot_id TEXT);`);
  writer.prepare("INSERT INTO task_ref VALUES(1,?)").run(repo);
  writer.prepare("INSERT INTO run VALUES(10,1,'worker',?,'reviewer',9,?,?,'no-change')").run(owner, time(600_000), time(500_000));
  writer.prepare("INSERT INTO run VALUES(20,1,'other',NULL,'builder',NULL,?,?,'built')").run(time(400_000), time(300_000));
  writer.prepare("INSERT INTO watch_lease VALUES('worker',?,?,14,?,?)").run(repo, owner, time(15_000), time(-75_000));
  writer.prepare("INSERT INTO watch_episode VALUES(8,?,'worker',?,?,NULL)").run(repo, owner, time(700_000));
  writer.prepare("INSERT INTO runner VALUES('worker','test-host','PRIVATE_CREDENTIAL_HASH',?,NULL,?)").run(time(800_000), JSON.stringify([repo]));
  writer.exec("INSERT INTO proof_verdict VALUES(9,'verified'); INSERT INTO criterion_review VALUES(10,9,'upholds');");
  writer.prepare("INSERT INTO run_process VALUES(20,'test-host',?)").run(boot);
  reader = new DatabaseSync(databasePath, { readOnly: true });
  const workerArgv = ["/usr/local/bin/node", join(runtime, "cli.js"), "up", "--db", databasePath, "--repo", repo, "--runner", "worker", "--host", "127.0.0.1", "--port", "4180"];
  input = { databasePath, targetRun: 20, anchorReviewerRun: 10, runtime, runtimeSha256: SERVICE_ANCHOR_RUNTIME_V1_SHA256,
    runner: "worker", repo, host: "test-host", bootId: boot, resourceCoalitionId: "591", service: "gui/501/test.service",
    workerPid, supervisorPid, port: 4180, workerArgv,
    supervisorArgv: ["/usr/local/bin/node", join(runtime, "controller-service.js"), ...workerArgv],
    native: { sourcePath: "/private/source.c", executablePath: "/private/census", sourceSha256: SERVICE_ANCHOR_RUNTIME_V1_SHA256, executableSha256: "b".repeat(64) }, maxWaitMs: 0 };
  controls.fingerprint = SERVICE_ANCHOR_RUNTIME_V1_SHA256;
  controls.command.mockReset().mockImplementation((file: string, args: string[]) => {
    if (file.endsWith("launchctl")) return `gui/501/test.service = {\n\tstate = running\n\tpid = ${supervisorPid}\n\tenvironment = {\n\t\tSECRET = PRIVATE_ENV\n\t}\n}\n`;
    if (file.endsWith("ps")) return (args[2] === String(supervisorPid) ? input.supervisorArgv : input.workerArgv).join(" ") + "\n";
    if (file.endsWith("lsof")) return `p${workerPid}\nn127.0.0.1:4180\n`;
    throw Error("unexpected probe");
  });
  controls.capture.mockReset().mockImplementation(async () => {
    writer.prepare("UPDATE watch_lease SET heartbeat_at=?,expires_at=?").run(time(1), time(-89_999));
    return snapshot();
  });
});
afterEach(() => { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe("read-only authenticated watch continuity", () => {
  it("binds a saved earlier review through fresh renewal to the exact managed kernel identity without exposing credentials", async () => {
    const answer = await collectDarwinServiceAnchor(reader, input);
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
    if (!answer.ok) return;
    expect(answer.receipt).toMatchObject({ owner, generation: 14, episode: 8, targetRun: 20, anchorReviewerRun: 10, worker: { pid: workerPid, uniqueId: String(workerPid * 10) } });
    expect(Date.parse(answer.receipt.heartbeatAfter)).toBeGreaterThan(Date.parse(answer.receipt.heartbeatBefore));
    expect(JSON.stringify(answer)).not.toMatch(/PRIVATE|credential|Argv|up --/);
    expect(controls.capture).toHaveBeenCalledTimes(2);
    expect(reader.prepare("SELECT count(*) count FROM run").get()?.count).toBe(2);
  });
  it("refuses a current lease without the exact saved watch owner, a completed earlier review, and admitted repo", async () => {
    writer.exec("UPDATE run SET watch_incarnation='different' WHERE id=10");
    expect(await collectDarwinServiceAnchor(reader, input)).toEqual({ ok: false, reason: "watch-history-unproven" });
    expect(controls.capture).not.toHaveBeenCalled();
    writer.prepare("UPDATE run SET watch_incarnation=?,finished_at=? WHERE id=10").run(owner, time(200_000));
    expect((await collectDarwinServiceAnchor(reader, input)).ok).toBe(false);
    writer.prepare("UPDATE run SET finished_at=? WHERE id=10").run(time(500_000));
    writer.exec("UPDATE runner SET repos='[]'");
    expect((await collectDarwinServiceAnchor(reader, input)).ok).toBe(false);
  });
  it.each(["credential_hash='REPLACEMENT_SECRET'", "registered_at='2026-01-01T00:00:00.000Z'", "retired_at='2026-01-01T00:00:00.000Z'"])("rejects a credential epoch replacement during observation: %s", async change => {
    controls.capture.mockImplementationOnce(async () => {
      writer.exec("UPDATE runner SET " + change);
      writer.prepare("UPDATE watch_lease SET heartbeat_at=?").run(time(1));
      return snapshot();
    });
    const answer = await collectDarwinServiceAnchor(reader, input);
    expect(answer.ok).toBe(false);
    expect(JSON.stringify(answer)).not.toContain("SECRET");
  });
  it("refuses lease generation changes and never treats an unchanged heartbeat as liveness", async () => {
    controls.capture.mockImplementationOnce(async () => { writer.exec("UPDATE watch_lease SET generation=15"); return snapshot(); });
    expect(await collectDarwinServiceAnchor(reader, input)).toEqual({ ok: false, reason: "watch-incarnation-changed" });
    controls.capture.mockImplementation(async () => snapshot());
    expect(await collectDarwinServiceAnchor(reader, input)).toEqual({ ok: false, reason: "watch-renewal-not-observed" });
  });
  it("rejects PID reuse, parent changes, foreign boot and incomplete anchors", async () => {
    for (const alter of [
      (s: DarwinCoalitionRecoverySnapshot) => { s.anchors[0]!.uniqueId = "2001"; },
      (s: DarwinCoalitionRecoverySnapshot) => { s.anchors[0]!.parentUniqueId = "9000"; },
      (s: DarwinCoalitionRecoverySnapshot) => { s.bootId = "11111111-1111-1111-1111-111111111111"; },
      (s: DarwinCoalitionRecoverySnapshot) => { s.complete = false; },
    ]) {
      let call = 0;
      controls.capture.mockImplementation(async () => {
        writer.prepare("UPDATE watch_lease SET heartbeat_at=?").run(time(1));
        const s = snapshot(); if (++call === 2) alter(s); return s;
      });
      writer.prepare("UPDATE watch_lease SET heartbeat_at=?").run(time(15_000));
      expect((await collectDarwinServiceAnchor(reader, input)).ok).toBe(false);
    }
  });
  it("requires exact managed PID, command, listener and audited runtime bytes", async () => {
    const normal = controls.command.getMockImplementation()!;
    for (const [file, output] of [["launchctl", `\tstate = running\n\tpid = ${strangerPid}\n`], ["ps", "different command\n"], ["lsof", `p${strangerPid}\nn127.0.0.1:4180\n`]]) {
      controls.command.mockImplementation((path: string, args: string[]) => path.endsWith(file!) ? output : normal(path, args));
      expect((await collectDarwinServiceAnchor(reader, input)).ok).toBe(false);
    }
    controls.command.mockImplementation(normal);
    controls.capture.mockImplementation(async () => { controls.fingerprint = "0".repeat(64); return snapshot(); });
    expect(await collectDarwinServiceAnchor(reader, input)).toEqual({ ok: false, reason: "runtime-changed" });
  });
  it("returns fixed errors, even if an OS failure carries raw launchd secrets", async () => {
    controls.command.mockImplementation(() => { throw Error("PRIVATE_ENV PRIVATE_CREDENTIAL_HASH"); });
    expect(await collectDarwinServiceAnchor(reader, input)).toEqual({ ok: false, reason: "service-observation-unproven" });
  });
  it("rejects an invented database/boot binding and unsafe arguments before OS observation", async () => {
    writer.exec("UPDATE run_process SET host='another-host'");
    expect(await collectDarwinServiceAnchor(reader, input)).toEqual({ ok: false, reason: "database-binding-unproven" });
    expect(controls.command).not.toHaveBeenCalled();
    expect((await collectDarwinServiceAnchor(reader, { ...input, maxWaitMs: 60_001 })).ok).toBe(false);
    expect((await collectDarwinServiceAnchor(reader, { ...input, workerArgv: [...input.workerArgv, "ambiguous argument"] })).ok).toBe(false);
  });
});
