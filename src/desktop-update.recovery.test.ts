/** Desktop update: automatic recovery, the controlled update's phases, cancellation and locks. Fixtures: test/desktop-update-kit.ts. */
import { test, expect, vi } from "vitest";
import * as childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, renameSync, existsSync, statSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION } from "./store.js";
import { loadOrCreateDesktopConfig, writeDesktopConfig, pairDesktopLogin, desktopServiceCommand } from "./desktop-host.js";
import { bundleHash } from "./desktop-bundle.js";
import { previewDesktopUpdate, prepareDesktopUpdate, runDesktopUpdate, readUpdateJournal, desktopUpdateStatus, requestUpdateRestore, requestUpdateStop, durableJson, desktopUpdateWaitingOf, type UpdateHooks, type UpdateJournal } from "./desktop-update.js";
import { superviseDesktopUpdate, runUpdateAttempt, updateRecoveryDefinition, armUpdateRecovery } from "./desktop-update-recovery.js";
import { launchdPlist } from "./daemon.js";
import { installUpdateGate, removeUpdateGate, updateAdmissionPaused, freezeUpdateGate, UPDATE_PAUSED } from "./desktop-update-gate.js";
import { CodingWorkspace } from "./coding-workspace.js";
import { runOperate } from "./operate.js";
import { fixture, armFixture, codingFixture } from "../test/desktop-update-kit.js";
import { fakePid } from "../test/fake-pid.js";

vi.mock("node:child_process", { spy: true });

test("ordinary service rendering remains byte-compatible when updater-only options are absent", () => {
  const value = launchdPlist({ label: "fixture", command: ["/fixture/node", "/fixture/host.js"], workingDirectory: "/fixture", pathEnv: "/usr/bin", logPath: "/fixture/log" });
  expect(value).toContain("<key>KeepAlive</key>\n  <true/>\n  <key>ThrottleInterval</key>");
  expect(value).not.toContain("StartInterval");
});

test("a damaged primary receipt suspends its exact OS job without restoring stale metadata", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(); armFixture(j); let cleaned = false;
    writeFileSync(join(f.state, "desktop-update.json"), "broken-json");
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, { receiptDir: j.workDir, cleanup: async record => { expect(record.id).toBe(j.id); cleaned = true; }, attempt: async () => { throw Error("must not launch"); } });
    expect(cleaned).toBe(true); expect(readFileSync(join(f.state, "desktop-update.json"), "utf8")).toBe("broken-json");
    expect(existsSync(join(j.workDir, "recovery-failure.json"))).toBe(true);
  } finally { f.close(); }
});

test("Stop still disables automatic recovery when its intent cannot be saved", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(); writeFileSync(join(f.state, "desktop-update.json"), "broken-json");
    const recorded: string[][] = [];
    await desktopServiceCommand("service-stop", f.state, f.config, ["--label", j.label, "--node", process.execPath, "--helper", join(f.root, "helper.js")], async (_file, args) => { recorded.push([...args]); return { code: args[0] === "print" ? 113 : 0, stdout: "", stderr: "", timedOut: false, notFound: false }; });
    expect(recorded.filter(args => args[0] === "disable").map(args => args[1]?.split("/").at(-1))).toEqual([j.label + ".update", j.label]);
  } finally { f.close(); }
});

test("temporary SQLite contention retries automatically instead of stranding admission", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(), record = armFixture(j); let busy = true;
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, { sleep: async () => {}, cleanup: async () => {}, attempt: async () => runDesktopUpdate(f.state, { ...f.hooks, checkpoint: phase => { if (busy && phase === "backing-up") { busy = false; throw Object.assign(Error("database is locked"), { errcode: 5 }); } } }) });
    expect(readUpdateJournal(f.state)?.phase).toBe("complete"); expect(record()).toMatchObject({ state: "done", attempts: 2 });
  } finally { f.close(); }
});

test.each(["draining", "backing-up", "stopping", "installing", "verifying", "releasing"])("automatic recovery heals one interruption at %s with no Resume call", async phase => {
  const f = fixture();
  try {
    const j = await f.prepare(), record = armFixture(j); let interrupted = false, cleaned = false;
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, { sleep: async () => {}, cleanup: async () => { cleaned = true; }, attempt: async () => {
      await runDesktopUpdate(f.state, { ...f.hooks, checkpoint: at => { if (!interrupted && at === phase) { interrupted = true; throw Object.assign(Error("unexpected death"), { simulatedCrash: true }); } } });
    } });
    expect(interrupted).toBe(true); expect(cleaned).toBe(true);
    expect(readUpdateJournal(f.state)?.phase).toBe("complete"); expect(record()).toMatchObject({ state: "done", attempts: 2, repairs: 0 });
    expect(f.calls.filter(c => c === "swap")).toHaveLength(1);
  } finally { f.close(); }
});

test("automatic recovery recognizes a swap whose completion receipt was interrupted", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(); armFixture(j); let crashed = false;
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, { sleep: async () => {}, cleanup: async () => {}, attempt: async () => runDesktopUpdate(f.state, { ...f.hooks, swap: async j => { await f.hooks.swap!(j); if (!crashed) { crashed = true; throw Object.assign(Error("after atomic exchange"), { simulatedCrash: true }); } } }) });
    expect(readUpdateJournal(f.state)?.phase).toBe("complete"); expect(f.calls.filter(c => c === "swap")).toHaveLength(1);
  } finally { f.close(); }
});

test("a crash during rollback resumes rollback, never retries the rejected candidate", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(), record = armFixture(j); let crashed = false;
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, { sleep: async () => {}, cleanup: async () => {}, attempt: async () => runDesktopUpdate(f.state, { ...f.hooks, healthy: async app => app.buildId === j.old.buildId, checkpoint: phase => { if (!crashed && phase === "rolling-back") { crashed = true; throw Object.assign(Error("rollback died"), { simulatedCrash: true }); } } }) });
    expect(readUpdateJournal(f.state)?.phase).toBe("restored"); expect(record()).toMatchObject({ attempts: 1, repairs: 1 });
    expect(f.calls.filter(c => c === `start:${j.next.buildId}`)).toHaveLength(1);
  } finally { f.close(); }
});

test("repeated candidate crashes automatically return to the old app within a fixed attempt budget", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(), record = armFixture(j);
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, { sleep: async () => {}, cleanup: async () => {}, attempt: async () => runDesktopUpdate(f.state, { ...f.hooks, checkpoint: phase => { if (phase === "verifying") throw Object.assign(Error("candidate keeps crashing"), { simulatedCrash: true }); } }) });
    expect(record()).toMatchObject({ state: "done", attempts: 3, repairs: 1 }); expect(readUpdateJournal(f.state)?.phase).toBe("restored");
    expect(bundleHash(f.installed)).toBe(j.old.hash);
  } finally { f.close(); }
});

test("temporary failure to start the old service is automatically retried", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(), record = armFixture(j); let failure = true;
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, { sleep: async () => {}, cleanup: async () => {}, attempt: async () => runDesktopUpdate(f.state, { ...f.hooks, healthy: async app => app.buildId === j.old.buildId, service: async (action, app, journal) => { if (failure && action === "start" && app.buildId === j.old.buildId) { failure = false; throw Error("temporary service outage"); } await f.hooks.service!(action, app, journal); } }) });
    expect(record()).toMatchObject({ state: "done", attempts: 1, repairs: 1 }); expect(readUpdateJournal(f.state)?.phase).toBe("restored");
  } finally { f.close(); }
});

test("exhausted recovery stops clearly and cannot reset its budget by restarting the guardian", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(), record = armFixture(j); let calls = 0;
    const hooks = { sleep: async () => {}, cleanup: async () => {}, attempt: async () => { calls++; throw Error("cannot start updater"); } };
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, hooks);
    expect(calls).toBe(6); expect(record()).toMatchObject({ state: "attention", attempts: 3, repairs: 3 });
    expect(readUpdateJournal(f.state)?.phase).toBe("needs-attention");
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, hooks); expect(calls).toBe(6);
  } finally { f.close(); }
});

test("permanent changed-settings failure stops automatic retries without undoing the user's settings", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(), record = armFixture(j); let attempts = 0;
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, { sleep: async () => {}, cleanup: async () => {}, attempt: async () => { attempts++; await runDesktopUpdate(f.state, { ...f.hooks, healthy: async () => { writeDesktopConfig(f.state, { ...f.config, port: f.config.port + 1 }); return false; } }); } });
    expect(attempts).toBe(1); expect(record().state).toBe("attention"); expect(readUpdateJournal(f.state)?.phase).toBe("needs-attention");
  } finally { f.close(); }
});

test("an explicit Stop while the candidate starts wins over automatic recovery", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(); armFixture(j);
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, { sleep: async () => {}, cleanup: async () => {}, attempt: async () => runDesktopUpdate(f.state, { ...f.hooks, healthy: async () => { requestUpdateStop(f.state); return false; } }) });
    expect(readUpdateJournal(f.state)?.phase).toBe("restored"); expect(bundleHash(f.installed)).toBe(j.old.hash);
    expect(f.calls).not.toContain(`start:${j.old.buildId}`); expect(f.calls.at(-1)).toBe(`stop:${j.old.buildId}`);
    expect(desktopUpdateStatus(f.state).wasRunning).toBe(false);
  } finally { f.close(); }
});

test("a hung updater process is killed by its owned handle, then the operation self-heals", async () => {
  const f = fixture();
  try {
    cpSync(process.execPath, join(f.candidate, "Contents/Resources/runtime/node"));
    writeFileSync(join(f.candidate, "Contents/Resources/dist/desktop-host.js"), "setInterval(() => {}, 1000);\n");
    const j = await f.prepare(), record = armFixture(j); let calls = 0, hungPid: number | null = null;
    await superviseDesktopUpdate(f.state, j.id, new AbortController().signal, { sleep: async () => {}, cleanup: async () => {}, attempt: async (journal, signal, onPid) => {
      if (calls++ === 0) await runUpdateAttempt(journal, signal, pid => { if (pid) hungPid = pid; onPid(pid); }, { pollMs: 10, staleMs: 40 });
      else await runDesktopUpdate(f.state, f.hooks);
    } });
    expect(hungPid).not.toBeNull(); expect(() => process.kill(hungPid!, 0)).toThrow();
    expect(record()).toMatchObject({ state: "done", attempts: 2 }); expect(readUpdateJournal(f.state)?.phase).toBe("complete");
  } finally { f.close(); }
});

test("the updater wakeup is bound to one operation, uses staged code, and contains no credentials", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(), definition = updateRecoveryDefinition(j, f.root);
    expect(definition.label).toBe(j.label + ".update"); expect(definition.entry).toContain("Updater.app");
    expect(definition.unitContent).toContain("update-supervise"); expect(definition.unitContent).toContain(j.id);
    expect(definition.unitContent).toMatch(/<key>StartInterval<\/key>\s*<integer>15<\/integer>/);
    expect(definition.unitContent).not.toContain("retained-fixture-login");
    armFixture(j); let attempts = 0;
    await superviseDesktopUpdate(f.state, randomUUID(), new AbortController().signal, { cleanup: async () => {}, attempt: async () => { attempts++; } });
    expect(attempts).toBe(0);
  } finally { f.close(); }
});

test.skipIf(process.platform !== "darwin")("failed OS registration leaves a clear retry action instead of pretending automatic recovery is active", async () => {
  const f = fixture();
  try {
    await f.prepare();
    await expect(armUpdateRecovery(f.state, false, async () => ({ code: 1, stdout: "", stderr: "activation unavailable", timedOut: false, notFound: false }), f.root)).rejects.toThrow(/activation unavailable/);
    expect(desktopUpdateStatus(f.state)).toMatchObject({ automaticRecovery: false, canResume: true });
    expect(desktopUpdateStatus(f.state).detail).toBeTruthy();
  } finally { f.close(); }
});

test("controlled update verifies a private backup, swaps the app, verifies the worker, and resumes admission", async () => {
  const f = fixture();
  try {
    const j = await f.prepare(); const hash = bundleHash(f.candidate);
    await runDesktopUpdate(f.state, f.hooks);
    const done = readUpdateJournal(f.state)!;
    expect(done.phase).toBe("complete"); expect(done.checkedAt).toBeTruthy(); expect(bundleHash(f.installed)).toBe(hash);
    expect(bundleHash(join(j.workDir, "Standby.app"))).toBe(j.old.hash);
    const db = f.db();
    expect(updateAdmissionPaused(db)).toBe(false); expect(db.prepare("SELECT title FROM task WHERE id='retained'").get()?.title).toBe("Keep my work"); db.close();
    expect(done.backupPath).toBeTruthy();
    const copy = new DatabaseSync(done.backupPath!, { readOnly: true });
    expect(copy.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok"); expect(updateAdmissionPaused(copy)).toBe(false);
    expect(copy.prepare("SELECT count(*) n FROM approver").get()?.n).toBe(1); copy.close();
    if (process.platform !== "win32") expect(statSync(done.backupPath!).mode & 0o777).toBe(0o600);
    expect(f.calls.filter(call => call === "swap")).toHaveLength(1);
    await runDesktopUpdate(f.state, f.hooks); expect(f.calls.filter(call => call === "swap")).toHaveLength(1);
  } finally { f.close(); }
});

test("failed candidate health automatically restores the prior app without restoring an old database", async () => {
  const f = fixture();
  try {
    const j = await f.prepare();
    await runDesktopUpdate(f.state, { ...f.hooks, healthy: async app => {
      if (app.buildId === j.old.buildId) return true;
      const db = f.db(); db.prepare("UPDATE task SET title='New work recorded after backup' WHERE id='retained'").run(); db.close(); return false;
    } });
    expect(readUpdateJournal(f.state)?.phase).toBe("restored"); expect(bundleHash(f.installed)).toBe(j.old.hash);
    const db = f.db(); expect(db.prepare("SELECT title FROM task WHERE id='retained'").get()?.title).toBe("New work recorded after backup"); expect(updateAdmissionPaused(db)).toBe(false); db.close();
    expect(f.calls.filter(call => call === "swap")).toHaveLength(2);
  } finally { f.close(); }
});

test.each(["prepared", "draining", "backing-up", "stopping", "installing", "verifying", "releasing"])("an interruption at %s resumes without losing the installed path or duplicating the swap", async phase => {
  const f = fixture();
  try {
    const j = await f.prepare();
    if (phase !== "prepared") await expect(runDesktopUpdate(f.state, { ...f.hooks, checkpoint: at => { if (at === phase) throw Object.assign(Error("injected interruption"), { simulatedCrash: true }); } })).rejects.toThrow(/injected/);
    expect(existsSync(f.installed)).toBe(true); expect(desktopUpdateStatus(f.state).canResume).toBe(true);
    await runDesktopUpdate(f.state, f.hooks);
    expect(readUpdateJournal(f.state)?.phase).toBe("complete"); expect(bundleHash(f.installed)).toBe(j.next.hash);
    expect(f.calls.filter(call => call === "swap")).toHaveLength(1);
  } finally { f.close(); }
});

test("a crash immediately after the atomic swap is recognized by hashes on resume", async () => {
  const f = fixture();
  try {
    await f.prepare();
    await expect(runDesktopUpdate(f.state, { ...f.hooks, swap: async j => { await f.hooks.swap!(j); throw Object.assign(Error("after swap"), { simulatedCrash: true }); } })).rejects.toThrow(/after swap/);
    expect(readUpdateJournal(f.state)?.phase).toBe("installing");
    await runDesktopUpdate(f.state, f.hooks); expect(readUpdateJournal(f.state)?.phase).toBe("complete"); expect(f.calls.filter(call => call === "swap")).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["stopping", "verifying"])("cancelling during a resumed drain after %s restores the prior service", async phase => {
  const f = fixture();
  try {
    const j = await f.prepare();
    await expect(runDesktopUpdate(f.state, { ...f.hooks, checkpoint: at => { if (at === phase) throw Object.assign(Error("interrupted"), { simulatedCrash: true }); } })).rejects.toThrow();
    await runDesktopUpdate(f.state, { ...f.hooks, checkpoint: at => { if (at === "draining") requestUpdateRestore(f.state); } });
    expect(readUpdateJournal(f.state)?.phase).toBe("restored");
    expect(bundleHash(f.installed)).toBe(j.old.hash);
    expect(f.calls.at(-1)).toBe(`start:${j.old.buildId}`);
  } finally { f.close(); }
});

test("cancel while draining preserves in-flight work and clears only this update's admission pause", async () => {
  const f = fixture();
  try {
    const j = await f.prepare();
    const db = f.db();
    db.prepare("INSERT INTO task_ref(backend,external_id) VALUES('builtin','retained')").run();
    const ref = db.prepare("SELECT id FROM task_ref WHERE external_id='retained'").get()!.id;
    db.prepare("INSERT INTO claim(lease_id,task_ref,lease_generation,runner,acquired_at,expires_at,heartbeat_at) VALUES('active',?,1,'fixture',?,?,?)").run(ref, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString()); db.close();
    await runDesktopUpdate(f.state, { ...f.hooks, sleep: async () => { requestUpdateRestore(f.state); } });
    expect(readUpdateJournal(f.state)?.phase).toBe("cancelled"); expect(bundleHash(f.installed)).toBe(j.old.hash); expect(f.calls).toEqual([]);
    const after = f.db(); expect(after.prepare("SELECT released_at FROM claim WHERE lease_id='active'").get()?.released_at).toBeNull(); expect(updateAdmissionPaused(after)).toBe(false); after.close();
  } finally { f.close(); }
});

test("bad schema, changed preview, duplicate start and tampered staging fail without replacing the installation", async () => {
  const f = fixture();
  try {
    const before = bundleHash(f.installed);
    await expect(previewDesktopUpdate(f.state, f.installed, f.makeApp("Future", SCHEMA_VERSION + 1), "fixture", f.hooks)).rejects.toThrow(/migration/);
    const plan = await previewDesktopUpdate(f.state, f.installed, f.candidate, "fixture", f.hooks);
    writeFileSync(join(f.candidate, "Contents", "extra"), "changed after preview");
    await expect(prepareDesktopUpdate(f.state, f.installed, f.candidate, "fixture", plan.digest, f.hooks)).rejects.toThrow(/changed since preview/);
    const j = await f.prepare(); await expect(f.prepare()).rejects.toThrow(/already recorded/);
    writeFileSync(join(j.workDir, "Standby.app", "Contents", "extra"), "changed again");
    await runDesktopUpdate(f.state, f.hooks);
    expect(bundleHash(f.installed)).toBe(before); expect(f.calls.filter(call => call === "swap")).toHaveLength(0);
  } finally { f.close(); }
});

test("SQLite gate refuses racing admissions, lets an owned conversation finish, and freezes before swap", () => {
  const f = fixture(); const db = f.db(); const id = randomUUID();
  try {
    installUpdateGate(db, id); installUpdateGate(db, id);
    expect(updateAdmissionPaused(db)).toBe(true);
    expect(() => db.exec("INSERT INTO claim(lease_id) VALUES('new')")).toThrow(UPDATE_PAUSED);
    expect(() => db.exec("INSERT INTO mate_turn(id) VALUES(1)")).toThrow(UPDATE_PAUSED);
    expect(() => db.exec("INSERT INTO chat_turn(id) VALUES(1)")).toThrow(UPDATE_PAUSED);
    // A mate's follow-up step is permitted by the gate; ordinary NOT NULL
    // constraints still refuse this deliberately incomplete fixture row.
    expect(() => db.exec("INSERT INTO chat_turn(id,mate_turn) VALUES(1,1)")).not.toThrow(UPDATE_PAUSED);
    expect(() => removeUpdateGate(db, randomUUID())).toThrow(/does not own/);
    expect(freezeUpdateGate(db, id)).toBe(true);
    expect(() => db.exec("INSERT INTO chat_turn(id,mate_turn) VALUES(1,1)")).toThrow(UPDATE_PAUSED);
    expect(() => db.exec("INSERT INTO run(id,parent_run) VALUES(1,1)")).toThrow(UPDATE_PAUSED);
    removeUpdateGate(db, id); expect(updateAdmissionPaused(db)).toBe(false);
  } finally { db.close(); f.close(); }
});

test.each(["backing-up", "stopping"])("cancellation at %s never installs the candidate", async phase => {
  const f = fixture();
  try {
    const j = await f.prepare();
    await runDesktopUpdate(f.state, { ...f.hooks, checkpoint: at => { if (at === phase) requestUpdateRestore(f.state); } });
    expect(["cancelled", "restored"]).toContain(readUpdateJournal(f.state)?.phase);
    expect(bundleHash(f.installed)).toBe(j.old.hash); expect(f.calls).not.toContain("swap");
    if (phase === "backing-up") expect(f.calls).toEqual([]);
  } finally { f.close(); }
});

test("a duplicate updater cannot run while the current operation owns its OS lock", async () => {
  const f = fixture();
  let resume!: () => void; let reached!: () => void;
  const held = new Promise<void>(done => { resume = done; });
  const ready = new Promise<void>(done => { reached = done; });
  try {
    await f.prepare();
    const first = runDesktopUpdate(f.state, { ...f.hooks, healthy: async () => { reached(); await held; return true; } });
    await ready;
    expect(desktopUpdateStatus(f.state)).toMatchObject({ running: true, canResume: false });
    await runDesktopUpdate(f.state, f.hooks);
    expect(f.calls.filter(call => call === "swap")).toHaveLength(1);
    resume(); await first;
    expect(readUpdateJournal(f.state)?.phase).toBe("complete");
  } finally { resume?.(); f.close(); }
});

test("a brief status-probe lock cannot make the only resumed updater silently exit", async () => {
  const f = fixture();
  try {
    const j = await f.prepare();
    // Another process holds the same short lock used by Update status. It can
    // release while this process waits in SQLite's synchronous busy handler.
    // The fixture waits for the lock rather than failing if a probe holds it
    // for a moment (a loaded machine stretches those moments).
    const child = spawn(process.execPath, ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite'; import {chmodSync} from 'node:fs'; const db=new DatabaseSync(process.argv[1]); chmodSync(process.argv[1],0o600); db.exec('PRAGMA busy_timeout=10000; BEGIN EXCLUSIVE'); console.log('locked'); setTimeout(()=>db.close(),300);", join(j.workDir, "worker.sqlite")], { stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise<void>((done, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? done() : reject(Error("fixture lock process failed"))); });
    await new Promise<void>((done, reject) => { child.stdout.once("data", () => done()); child.once("error", reject); child.once("exit", code => { if (code !== 0) reject(Error("fixture exited before lock")); }); });
    await runDesktopUpdate(f.state, f.hooks); await exited;
    expect(readUpdateJournal(f.state)?.phase).toBe("complete");
    expect(f.calls.filter(call => call === "swap")).toHaveLength(1);
  } finally { f.close(); }
});

test("two installations cannot prepare competing updates for one app", async () => {
  const f = fixture();
  try {
    const state = join(f.root, "second-state");
    loadOrCreateDesktopConfig(state, true); writeDesktopConfig(state, f.config);
    await f.prepare();
    const preview = await previewDesktopUpdate(state, f.installed, f.candidate, "second", f.hooks);
    await expect(prepareDesktopUpdate(state, f.installed, f.candidate, "second", preview.digest, f.hooks)).rejects.toThrow(/Another installation/);
    expect(readUpdateJournal(state)).toBeNull();
  } finally { f.close(); }
});

test("another controller using this app blocks preview without changing the database", async () => {
  const f = fixture();
  try {
    await expect(f.prepare({ otherControllers: async () => true })).rejects.toThrow(/Another installation/);
    expect(f.calls).toEqual([]); expect(readUpdateJournal(f.state)).toBeNull();
    const db = f.db(); expect(updateAdmissionPaused(db)).toBe(false); db.close();
  } finally { f.close(); }
});

test("changed settings after swap keep work paused instead of starting recovery against a different configuration", async () => {
  const f = fixture();
  try {
    const j = await f.prepare();
    await runDesktopUpdate(f.state, { ...f.hooks, healthy: async () => { writeDesktopConfig(f.state, { ...f.config, port: f.config.port + 1 }); return false; } });
    expect(readUpdateJournal(f.state)?.phase).toBe("needs-attention");
    expect(f.calls.filter(call => call === "swap")).toHaveLength(1);
    const db = f.db(); expect(updateAdmissionPaused(db)).toBe(true); db.close();
    writeDesktopConfig(f.state, f.config);
    await runDesktopUpdate(f.state, f.hooks);
    expect(readUpdateJournal(f.state)?.phase).toBe("restored"); expect(bundleHash(f.installed)).toBe(j.old.hash);
  } finally { f.close(); }
});

test("a resumed update remembers shutdown even if a later backup pass fails", async () => {
  const f = fixture();
  try {
    const j = await f.prepare();
    await expect(runDesktopUpdate(f.state, { ...f.hooks, checkpoint: phase => { if (phase === "installing") throw Object.assign(Error("stopped before swap"), { simulatedCrash: true }); } })).rejects.toThrow();
    await runDesktopUpdate(f.state, { ...f.hooks, checkpoint: phase => { if (phase === "backing-up") writeDesktopConfig(f.state, { ...f.config, port: f.config.port + 1 }); } });
    expect(readUpdateJournal(f.state)?.phase).toBe("needs-attention");
    writeDesktopConfig(f.state, f.config);
    await runDesktopUpdate(f.state, f.hooks);
    expect(readUpdateJournal(f.state)?.phase).toBe("restored");
    expect(f.calls.at(-1)).toBe(`start:${j.old.buildId}`);
  } finally { f.close(); }
});

test("a stopped installation remains stopped after verifying its update", async () => {
  const f = fixture();
  try {
    await f.hooks.service!("stop", { buildId: "fixture" } as never, {} as never);
    await f.prepare(); await runDesktopUpdate(f.state, f.hooks);
    expect(readUpdateJournal(f.state)?.phase).toBe("complete");
    expect(f.calls.at(-1)).toMatch(/^stop:/);
    expect(readUpdateJournal(f.state)?.detail).toContain("remains stopped");
  } finally { f.close(); }
});

test("an ended run with a live process witness still drains, and cancellation never kills it", async () => {
  const f = fixture();
  try {
    await f.prepare();
    const db = f.db();
    db.exec("INSERT INTO task_ref(backend,external_id) VALUES('builtin','retained')");
    const ref = db.prepare("SELECT id FROM task_ref WHERE external_id='retained'").get()!.id;
    const now = new Date().toISOString();
    const id = db.prepare("INSERT INTO run(task_ref,lease_id,runner,role,started_at,finished_at,outcome) VALUES(?,'finished','fixture','reviewer',?,?,'interrupted')").run(ref, now, now).lastInsertRowid;
    db.prepare("INSERT INTO run_process(run,pid,host,process_group,observed_at) VALUES(?,?,?,0,?)").run(id, process.pid, hostname(), now); db.close();
    let waiting = false;
    await runDesktopUpdate(f.state, { ...f.hooks, sleep: async () => { waiting = true; expect(readUpdateJournal(f.state)?.detail).toMatch(/process|subprocess/); requestUpdateRestore(f.state); } });
    expect(waiting).toBe(true); expect(f.calls).toEqual([]);
    expect(readUpdateJournal(f.state)?.phase).toBe("cancelled");
  } finally { f.close(); }
});

test("a finished run's leftover record with no process id: the app update stops waiting within 2 minutes and says the one command", async () => {
  const f = fixture();
  try {
    const j = await f.prepare();
    const db = f.db();
    db.exec("INSERT INTO task_ref(backend,external_id) VALUES('builtin','retained')");
    const ref = db.prepare("SELECT id FROM task_ref WHERE external_id='retained'").get()!.id;
    const at = new Date().toISOString();
    const id = Number(db.prepare("INSERT INTO run(task_ref,lease_id,runner,role,started_at,finished_at,outcome) VALUES(?,'finished','fixture','reviewer',?,?,'failed')").run(ref, at, at).lastInsertRowid);
    db.prepare("INSERT INTO run_process(run,pid,host,process_group,observed_at) VALUES(?,NULL,?,1,?)").run(id, hostname(), at); db.close();
    let clock = Date.now(), waits = 0;
    await runDesktopUpdate(f.state, { ...f.hooks, now: () => new Date(clock), sleep: async ms => {
      waits++;
      expect(readUpdateJournal(f.state)?.detail).toContain(`toolroll run settle ${id} --why "it is not running"`);
      expect(desktopUpdateWaitingOf(f.config.databaseFile, () => true)).toMatchObject({ app: true, stopped: false, run: id,
        short: `App update to 0.4.3 is waiting on run #${id}. If nothing of it is running, run toolroll run settle ${id} --why "it is not running".` });
      clock += ms;
    } });
    const done = readUpdateJournal(f.state)!;
    expect(done.phase).toBe("cancelled");
    expect(waits).toBeLessThanOrEqual(120);
    expect(done.detail).toBe(`Stopped waiting after 2 minutes. Run #${id} finished, but Toolroll has no process ID for one of its processes, so it can't confirm that process ended. If nothing of it is running, run toolroll run settle ${id} --why "it is not running", then update again. New work resumed; nothing was changed.`);
    expect(done.detail).not.toMatch(/witness|unproven/i);
    expect(bundleHash(f.installed)).toBe(j.old.hash); expect(f.calls).toEqual([]);
    const after = f.db(); expect(updateAdmissionPaused(after)).toBe(false); after.close();
    // toolroll status names the stopped app update first, while the run is still in the way.
    const lines: string[] = [];
    expect(await runOperate("status", [], line => lines.push(line), { databaseFile: f.config.databaseFile, releaseIo: { fetch: async () => { throw new Error("offline"); } } } as never)).toBe(0);
    expect(lines.join("\n").split("\n")[0]).toBe(`App update to 0.4.3 stopped waiting: Run #${id} finished, but Toolroll has no process ID for one of its processes, so it can't confirm that process ended. If nothing of it is running, run toolroll run settle ${id} --why "it is not running", then update again.`);
    expect(desktopUpdateWaitingOf(f.config.databaseFile, () => true)?.short).toBe(`App update to 0.4.3 stopped: run #${id} is in the way. If nothing of it is running, run toolroll run settle ${id} --why "it is not running", then update again.`);
    expect(desktopUpdateWaitingOf(f.config.databaseFile, () => false)).toBeNull();
  } finally { f.close(); }
});

test("an app updater that ends while work finishes never leaves new work paused, and status says the update stopped", async () => {
  const f = fixture();
  try {
    await f.prepare();
    const db = f.db();
    db.exec("INSERT INTO task_ref(backend,external_id) VALUES('builtin','retained')");
    const ref = db.prepare("SELECT id FROM task_ref WHERE external_id='retained'").get()!.id;
    db.prepare("INSERT INTO run(task_ref,lease_id,runner,role,started_at) VALUES(?,'live','fixture','reviewer',?)").run(ref, new Date().toISOString()); db.close();
    await expect(runDesktopUpdate(f.state, { ...f.hooks, sleep: async () => {
      // Waiting on running work, said in status; never lifted under a live updater.
      expect(desktopUpdateWaitingOf(f.config.databaseFile, () => true)?.words).toBe("App update to 0.4.3 is waiting for running work to finish. New work is paused.");
      throw Object.assign(Error("crash"), { simulatedCrash: true });
    } })).rejects.toThrow("crash");
    const paused = f.db(); expect(updateAdmissionPaused(paused)).toBe(true); paused.close();
    const lines: string[] = [];
    expect(await runOperate("status", [], line => lines.push(line), { databaseFile: f.config.databaseFile, releaseIo: { fetch: async () => { throw new Error("offline"); } } } as never)).toBe(0);
    expect(lines.join("\n")).not.toMatch(/New work is paused/);
    const after = f.db(); expect(updateAdmissionPaused(after)).toBe(false); after.close();
    expect(readUpdateJournal(f.state)).toMatchObject({ phase: "cancelled", detail: "The app update to 0.4.3 stopped: its updater ended before running work finished. Nothing was changed; new work resumed. Update again from the app." });
    expect(bundleHash(f.installed)).not.toBe(bundleHash(f.candidate)); expect(f.calls).toEqual([]);
  } finally { f.close(); }
}, 30_000);

test.each([
  "single reused PID", "absent group", "populated group", "unknown group", "unknown birth",
  "reused populated group", "EPERM PID", "EPERM group", "orphan group", "denied birth group", "same-second group",
])("updater handles %s without rewriting the historical witness", async state => {
  const f = fixture();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let kill: ReturnType<typeof vi.spyOn> | undefined;
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  const ps = vi.mocked(childProcess.execFileSync);
  try {
    await f.prepare();
    const db = f.db();
    db.exec("INSERT INTO task_ref(backend,external_id) VALUES('builtin','reused')");
    const ref = db.prepare("SELECT id FROM task_ref WHERE external_id='reused'").get()!.id;
    const time = "2026-09-12T16:53:59.658Z";
    const id = db.prepare("INSERT INTO run(task_ref,lease_id,runner,role,started_at,finished_at,outcome) VALUES(?,'finished','fixture','reviewer',?,?,'interrupted')").run(ref, time, time).lastInsertRowid;
    db.prepare("INSERT INTO run_process(run,pid,host,process_group,observed_at) VALUES(?,?,?,?,?)").run(id, fakePid(1), hostname(), state.includes("group") ? 1 : 0, time);
    const before = db.prepare("SELECT * FROM run_process WHERE run=?").all(id); db.close();
    Object.defineProperty(process, "platform", { value: "darwin" });
    kill = vi.spyOn(process, "kill").mockImplementation(target => {
      if (state.startsWith("EPERM") || state === "denied birth group") throw Object.assign(new Error(state), { code: "EPERM" });
      if (target < 0 && (state === "absent group" || state === "unknown group")) throw Object.assign(new Error(state), { code: state === "unknown group" ? "EIO" : "ESRCH" });
      if (target > 0 && state === "orphan group") throw Object.assign(new Error(state), { code: "ESRCH" });
      return true;
    });
    const birth = state === "unknown birth" ? ""
      : state === "populated group" ? "Sat Sep 12 16:00:00 2026\n"
      : state === "same-second group" ? "Sat Sep 12 16:53:59 2026\n"
      : "Mon Sep 14 14:33:43 2026\n";
    ps.mockReturnValue(birth);
    if (state === "orphan group" || state === "denied birth group") ps.mockImplementation(() => { throw Object.assign(new Error(state), { code: state === "orphan group" ? "ESRCH" : "EPERM" }); });
    clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-15T00:00:00.000Z"));
    let waiting = false;
    await runDesktopUpdate(f.state, { ...f.hooks, sleep: async () => {
      waiting = true;
      expect(readUpdateJournal(f.state)?.detail).toContain("may still be running");
      requestUpdateRestore(f.state);
    } });
    const blocked = ["populated group", "unknown group", "unknown birth", "orphan group", "denied birth group", "same-second group"].includes(state);
    expect(waiting).toBe(blocked);
    expect(readUpdateJournal(f.state)?.phase).toBe(blocked ? "cancelled" : "complete");
    expect(f.calls.filter(call => call === "swap")).toHaveLength(blocked ? 0 : 1);
    const after = f.db();
    expect(after.prepare("SELECT * FROM run_process WHERE run=?").all(id)).toEqual(before); after.close();
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  } finally {
    kill?.mockRestore(); ps.mockReset(); clock?.mockRestore();
    Object.defineProperty(process, "platform", originalPlatform);
    f.close();
  }
});
