import { test, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "./store.js";
import { updateAdmissionPaused, UPDATE_PAUSED } from "./desktop-update-gate.js";
import {
  abandonRuntimeUpdate, checkProvenance, findSigstoreVerifier, lastCompletedUpdate, launchRuntimeUpdate, machineSystem, prepareRuntimeUpdate, pruneRuntimes, readRuntimeUpdate, releaseNotes, requestRuntimeUpdateCancel, resumeRuntimeUpdate, runtimeUpdateStatus, markWhatsNewSeen,
  startRuntimeRollback, startRuntimeUpdate, PROVENANCE_ISSUER, PROVENANCE_REPOSITORY, PROVENANCE_WORKFLOW, UPDATE_JOB_LABEL, UPDATE_STEPS, type RuntimePhase, type UpdateSystem,
} from "./toolroll-update.js";
import { REGISTRY, setUpdateChecks } from "./releases.js";
import { runUpdateCommand } from "./toolroll-update-cli.js";
import { updatesHtml } from "./toolroll-update-ui.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { TARBALL, sha512, der, seq, oid, utf8, extension, SIGNING, OTHER_KEY, signingCertificate, provenance, fixture, scriptedLaunchctl, scriptedNpm, failingHealth, SERVICE_PID, RESTARTED_SERVICE_PID } from "../test/toolroll-update-kit.js";
import { fakePid } from "../test/fake-pid.js";

test("c1: a scripted update runs verify, drain, backup, rehearse, switch, restart and health in order", async () => {
  const f = fixture();
  try {
    const outcome = await f.start();
    expect(outcome.ok).toBe(true);
    const j = outcome.journal!;
    expect(j.phase).toBe("complete");
    expect(j.steps.map(s => s.phase)).toEqual([...UPDATE_STEPS, "complete"]);
    expect(f.phases.filter(p => (UPDATE_STEPS as readonly string[]).includes(p)).filter((p, i, all) => all.indexOf(p) === i)).toEqual([...UPDATE_STEPS]);
    expect(f.calls).toEqual(["install", "stop", "rehearse", "restart", "health"]);
    // Staged beside the current runtime, never over it.
    expect(j.to.dist.startsWith(join(f.stateDir, "staged-upgrades"))).toBe(true);
    expect(readFileSync(join(f.oldDist, "bin.js"), "utf8")).toBe("// 0.6.0");
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(j.to.dist, "bin.js"));
    expect(readFileSync(f.unit, "utf8")).toBe(f.unitText.replaceAll(f.oldDist, j.to.dist));
    expect(j.package).toMatchObject({ repository: PROVENANCE_REPOSITORY, workflow: PROVENANCE_WORKFLOW });
    expect(j.rehearsal?.rows).toBeGreaterThan(0);
    expect(existsSync(j.backupPath!)).toBe(true);
    expect(f.paused()).toBe(false);
    expect(f.ledger()).toEqual([{ action: "toolroll updated", outcome: "complete", detail: "0.6.0 → 0.7.0", actor: "ada" }]);
    expect(runtimeUpdateStatus(f.stateDir).whatsNew).toEqual({ version: "0.7.0", notes: ["Updates from the console", "Faster chat"] });
    markWhatsNewSeen(f.stateDir);
    expect(runtimeUpdateStatus(f.stateDir).whatsNew).toBeNull();
  } finally { f.close(); }
});

test("saved unknown phases and unchecked information keep status and recovery actions available", async () => {
  const f = fixture();
  try {
    const prepared = prepareRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, actor: "ada", version: "0.7.0", when: "now" }, f.system.now());
    if ("refused" in prepared) throw Error(prepared.refused);
    const info = { actor: null, detail: null, error: null, finishedAt: null, notes: { legacy: true }, seen: null };
    const step = { phase: "future-step", at: prepared.startedAt, laterField: true };
    const saved = { ...prepared, ...info, kind: "future-kind", when: "future-schedule", phase: "future-phase", steps: [step] };
    const bytes = JSON.stringify(saved, null, 2);
    const file = join(f.stateDir, "toolroll-update.json");
    writeFileSync(file, bytes);
    expect(readRuntimeUpdate(f.stateDir)).toEqual(saved);
    expect(runtimeUpdateStatus(f.stateDir).journal).toEqual(saved);
    expect(requestRuntimeUpdateCancel(f.stateDir, f.system.now())).toContain("past the point it can be cancelled (future-phase)");
    abandonRuntimeUpdate(f.stateDir, prepared.id, "Job did not start", f.system.now());
    const stale = await resumeRuntimeUpdate(f.stateDir, f.system, "a-different-update");
    expect(stale).toMatchObject({ ok: true, phase: "future-phase", journal: saved });
    const active = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, actor: "ada", when: "now" }, f.system);
    expect(active.message).toContain("already under way");
    expect(readFileSync(file, "utf8")).toBe(bytes);

    // An unknown phase keeps the legacy resume fallback; the old step survives the new transitions.
    writeFileSync(file, JSON.stringify({ ...saved, kind: "update" }));
    const resumed = await resumeRuntimeUpdate(f.stateDir, f.system, prepared.id);
    expect(resumed).toMatchObject({ ok: true, phase: "complete" });
    expect(resumed.journal!.steps[0]).toEqual(step);
    const completed = { ...resumed.journal!, ...info };
    writeFileSync(file, JSON.stringify(completed));
    writeFileSync(join(f.stateDir, "toolroll-update.last.json"), JSON.stringify(completed));
    expect(lastCompletedUpdate(f.stateDir)).toEqual(completed);
    const rollback = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: resumed.journal!.to, actor: "ada", when: "now" }, f.system);
    expect(rollback).toMatchObject({ ok: true, phase: "complete" });
  } finally { f.close(); }
});

test("c1: a failed health check restores the previous runtime and database on its own", async () => {
  const f = fixture();
  try {
    const outcome = await f.start({
      // The new service writes to the database, then never becomes healthy.
      restartService: async () => { f.calls.push("restart"); if (f.calls.filter(c => c === "restart").length > 1) return; const d = f.db(); try { d.prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES('T-new','Written by 0.7.0','queued',?,?)").run("x", "x"); } finally { d.close(); } },
      healthy: async () => { f.calls.push("health"); return false; },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.phase).toBe("restored");
    expect(outcome.message).toMatch(/did not pass its health check.*0\.6\.0 and its database were restored/);
    expect(outcome.journal!.steps.map(s => s.phase)).toEqual([...UPDATE_STEPS, "rolling-back", "restored"]);
    expect(f.calls.slice(-2)).toEqual(["stop", "restart"]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
    expect(f.tasks()).toEqual(["T-1"]);
    expect(f.paused()).toBe(false);
    expect(f.ledger().map(e => [e.action, e.outcome])).toEqual([["toolroll update failed", "restored"]]);
  } finally { f.close(); }
});

test("c1: an updater that dies at any step resumes from its journal and finishes", async () => {
  for (const crashAt of ["draining", "backing-up", "switching", "restarting", "health"] as const) {
    const f = fixture();
    try {
      await expect(f.start({ checkpoint: phase => { if (phase === crashAt) throw Object.assign(Error("crash"), { simulatedCrash: true }); } })).rejects.toThrow("crash");
      expect(readRuntimeUpdate(f.stateDir)?.phase).toBe(crashAt);
      const outcome = await resumeRuntimeUpdate(f.stateDir, f.system);
      expect(outcome.phase).toBe("complete");
      expect(f.paused()).toBe(false);
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(outcome.journal!.to.dist, "bin.js"));
      expect(readFileSync(f.unit, "utf8")).toBe(f.unitText.replaceAll(f.oldDist, outcome.journal!.to.dist));
    } finally { f.close(); }
  }
});

test("c2: a wrongly attributed package is refused before anything changes", async () => {
  for (const wrong of [{ repository: "https://github.com/someone/toolroll" }, { workflow: ".github/workflows/other.yml" }, { bytes: new TextEncoder().encode("other bytes") }, { version: "0.6.9" }]) {
    const f = fixture();
    try {
      const before = readFileSync(f.databaseFile);
      const outcome = await f.start({ attestations: async () => provenance(wrong) });
      expect(outcome.phase).toBe("refused");
      expect(outcome.message).toMatch(/Nothing was changed/);
      expect(f.calls).toEqual([]);
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
      expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
      expect(f.paused()).toBe(false);
      expect(existsSync(join(outcome.journal!.stageDir, "runtime"))).toBe(false);
      expect(outcome.journal!.backupPath).toBeUndefined();
      expect(f.ledger().map(e => [e.action, e.outcome])).toEqual([["toolroll update refused", "refused"]]);
      expect(before.length).toBeGreaterThan(0);
    } finally { f.close(); }
  }
});

test("c2: an unverifiable package is refused: no provenance, wrong checksum, or no signatures", async () => {
  const cases: Partial<UpdateSystem>[] = [
    { release: async version => ({ version, tarball: "https://registry.npmjs.org/x.tgz", integrity: `sha512-${sha512(TARBALL).toString("base64")}`, attestations: null }) },
    { attestations: async () => ({ attestations: [] }) },
    { download: async () => new TextEncoder().encode("tampered") },
    { install: async () => { throw Object.assign(new (class Refusal extends Error {})("npm could not verify the package signatures. Nothing was changed.")); } },
  ];
  for (const overrides of cases) {
    const f = fixture();
    try {
      const outcome = await f.start(overrides);
      expect(outcome.ok).toBe(false);
      expect(["refused"]).toContain(outcome.phase);
      expect(f.calls).not.toContain("restart");
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
      expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
      expect(f.paused()).toBe(false);
      expect(f.ledger()).toHaveLength(1);
    } finally { f.close(); }
  }
  expect(() => checkProvenance(provenance(), "0.7.0", sha512(TARBALL).toString("hex"))).not.toThrow();
  expect(() => checkProvenance(provenance({ repository: "https://github.com/ap9000/toolroll-fork" }), "0.7.0", sha512(TARBALL).toString("hex"))).toThrow(/not ap9000\/toolroll/);
});

test("a rehearsal that would change historical rows is refused and new work resumes", async () => {
  const f = fixture();
  try {
    const outcome = await f.start({ rehearse: async (_dist, copy) => { const d = new DatabaseSync(copy); try { d.exec("UPDATE task SET title='rewritten'"); } finally { d.close(); } } });
    expect(outcome.phase).toBe("refused");
    expect(outcome.message).toMatch(/would change saved history in task/);
    expect(f.paused()).toBe(false);
    // The service stopped for the backup starts again, unchanged.
    expect(f.calls).toEqual(["install", "stop", "restart"]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
  } finally { f.close(); }
});

test("c3: --now refuses while work runs and names it; a ledger entry records the refusal", async () => {
  const f = fixture();
  try {
    f.startRun();
    const outcome = await f.start({}, "now");
    expect(outcome.phase).toBe("refused");
    expect(outcome.message).toMatch(/Work is running: running T-1 \(Keep my work\)/);
    expect(f.calls).toEqual(["install"]);
    expect(f.paused()).toBe(false);
    expect(f.ledger().map(e => [e.action, e.outcome])).toEqual([["toolroll update refused", "refused"]]);
  } finally { f.close(); }
});

test("c3: --when-idle pauses new work, waits for running work, then updates", async () => {
  const f = fixture();
  try {
    const run = f.startRun();
    const waits: string[] = [];
    const outcome = await f.start({ sleep: async () => {
      waits.push(readRuntimeUpdate(f.stateDir)!.detail);
      expect(f.paused()).toBe(true);
      const d = f.db(); try { expect(() => d.exec("INSERT INTO claim(task_ref, lease_id) VALUES (1, 'x')")).toThrow(UPDATE_PAUSED); } finally { d.close(); }
      if (waits.length === 2) f.finishRun(run);
    } }, "when-idle");
    expect(waits).toHaveLength(2);
    expect(waits[0]).toMatch(/New work is paused\. Waiting for running T-1/);
    expect(outcome.phase).toBe("complete");
    expect(f.ledger().map(e => e.action)).toEqual(["toolroll updated"]);
  } finally { f.close(); }
});

test("c3: --at waits for its time, and a scheduled update can be cancelled", async () => {
  const f = fixture();
  try {
    let slept = 0;
    const outcome = await f.start({ sleep: async () => { slept++; if (slept === 1) expect(requestRuntimeUpdateCancel(f.stateDir)).toMatch(/Cancelling/); } }, "at", "03:00");
    expect(outcome.phase).toBe("cancelled");
    expect(f.calls).toEqual([]);
    expect(f.ledger().map(e => e.action)).toEqual(["toolroll update scheduled", "toolroll update cancelled"]);
  } finally { f.close(); }
});

test("c3: --rollback returns to the previous runtime and its backup, keeping a copy of the current database", async () => {
  const f = fixture();
  try {
    const update = await f.start();
    expect(update.phase).toBe("complete");
    const d = f.db(); try { d.prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES('T-2','After the update','queued','x','x')").run(); } finally { d.close(); }
    const outcome = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(outcome.phase).toBe("complete");
    expect(outcome.journal!.steps.map(s => s.phase)).toEqual([...UPDATE_STEPS, "complete"]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
    expect(f.tasks()).toEqual(["T-1"]);
    const safety = new DatabaseSync(outcome.journal!.backupPath!, { readOnly: true });
    try { expect(safety.prepare("SELECT count(*) n FROM task WHERE id='T-2'").get()!["n"]).toBe(1); } finally { safety.close(); }
    expect(f.paused()).toBe(false);
    // The pre-update backup has no update entries; the rollback records itself afterwards.
    expect(f.ledger().map(e => [e.action, e.detail])).toEqual([["toolroll rolled back", "0.7.0 → 0.6.0 (back)"]]);
    expect(runtimeUpdateStatus(f.stateDir).whatsNew).toBeNull();
    const again = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, actor: "ada", when: "when-idle" }, f.system);
    expect(again.message).toBe("There is no completed update to roll back.");
  } finally { f.close(); }
});

test("toolroll update: npx is current, previews change nothing, --now and --when-idle choose the mode", async () => {
  const f = fixture();
  try {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const deps = { system: f.system, current: f.current, databaseFile: f.databaseFile, latest: async () => ({ version: "0.7.0" }) };
    expect(await runUpdateCommand([], write, { ...deps, method: { kind: "npx", updateCommand: "npx toolroll@latest" } })).toBe(0);
    expect(lines.pop()).toMatch(/npx runs the latest Toolroll each time, so this one is current/);
    expect(await runUpdateCommand([], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(0);
    expect(lines.join("\n")).toMatch(/Update Toolroll 0\.6\.0 → 0\.7\.0[\s\S]*Add --yes to update/);
    expect(f.calls).toEqual([]);
    expect(await runUpdateCommand(["--now", "--at", "03:00"], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(2);
    f.startRun();
    expect(await runUpdateCommand(["--yes", "--now"], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(1);
    expect(lines.pop()).toMatch(/Work is running: running T-1/);
    expect(await runUpdateCommand(["--yes", "--version", "0.6.0"], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(0);
    expect(lines.pop()).toBe("Toolroll 0.6.0 is current.");
    expect(await runUpdateCommand(["--yes", "--version", "0.5.0"], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(1);
    expect(lines.pop()).toBe("Toolroll 0.5.0 is older than 0.6.0. Add --allow-downgrade to go back to it.");
    expect(await runUpdateCommand(["--rollback"], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(1);
  } finally { f.close(); }
});

test("release notes are the version's changelog headlines", () => {
  expect(releaseNotes("## Unreleased\n\n## 0.7.0 — x\n\n- **One.** a\n- **Two** b\n\n## 0.6.0\n- **Old.**", "0.7.0")).toEqual(["One", "Two"]);
  expect(releaseNotes("## 0.6.0\n- **Old.**", "0.7.0")).toEqual([]);
});

test("Settings → Updates: three buttons behind the password, --now refused while work runs, live steps, then What's new once", async () => {
  const f = fixture();
  const store = openStore(f.databaseFile);
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("alex");
  const launched: { databaseFile: string; id: string }[] = [];
  const configDir = join(f.root, "config"); mkdirSync(configDir); setUpdateChecks(configDir, true);
  const checksEnv = process.env["TOOLROLL_NO_UPDATE_CHECK"]; delete process.env["TOOLROLL_NO_UPDATE_CHECK"];
  const server = createDecisionServer({ store, evidenceRoot: join(f.root, "evidence"), configDir, updates: {
    latest: async () => ({ version: "0.7.0" }), method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" }, current: "0.6.0", dist: f.oldDist,
    // The job resumes the journal the console prepared, by id.
    launch: async args => { launched.push(args); await resumeRuntimeUpdate(f.stateDir, f.system, args.id); },
  } });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const get = async (path = "/settings/updates") => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
    let page = await get();
    expect(page).toContain("Toolroll 0.7.0 is available");
    for (const label of ["Update now", "When idle", "Tonight (03:00)"]) expect(page).toContain(`>${label}</button>`);
    expect(page).toContain('type="password" name="password"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const post = async (fields: Record<string, string>, path = "/settings/updates") => decodeURIComponent((await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, version: "0.7.0", ...fields }), redirect: "manual" })).headers.get("location") ?? "");
    expect(await post({ when: "now", password: "wrong" })).toContain("problem=Enter your Toolroll password");
    const run = f.startRun();
    expect(await post({ when: "now", password: alex.token })).toMatch(/problem=Work is running: running T-1 \(Keep my work\)/);
    expect(launched).toEqual([]);
    f.finishRun(run);
    expect(await post({ when: "now", password: alex.token, version: "0.5.0" })).toContain("problem=Toolroll 0.5.0 is not newer than 0.6.0");
    expect(launched).toEqual([]);
    expect(await post({ when: "now", password: alex.token })).toContain("said=Updating to 0.7.0.");
    expect(launched[0]).toMatchObject({ databaseFile: f.databaseFile, id: readRuntimeUpdate(f.stateDir)!.id });
    expect(readRuntimeUpdate(f.stateDir)).toMatchObject({ when: "now", actor: "alex", to: { version: "0.7.0" } });
    page = await get();
    expect(page).toContain("What’s new in 0.7.0");
    expect(page).toContain("<li>Updates from the console</li>");
    expect(await get("/settings/updates?fragment=steps")).toMatch(/data-done="1".*data-step="health" data-state="done"/s);
    await post({}, "/settings/updates/seen");
    expect(await get()).not.toContain("What’s new in 0.7.0");
    expect(f.ledger().map(e => [e.action, e.actor])).toEqual([["toolroll updated", "alex"]]);
  } finally {
    if (checksEnv !== undefined) process.env["TOOLROLL_NO_UPDATE_CHECK"] = checksEnv;
    await new Promise<void>(done => server.close(() => done()));
    store.close(); f.close();
  }
}, 30_000);

// ---- the rework: coding catalog, the one-off job, stopping, provenance, kept writes, refusals, Settings ----

test("c1: a failed update leaves the coding catalog ungated and restored with the database", async () => {
  const f = fixture({ coding: true });
  try {
    let restarts = 0;
    const outcome = await f.start({
      restartService: async () => {
        f.calls.push("restart");
        if (++restarts > 1) return;
        // The new version writes to both files while it runs, then fails its health check.
        f.write("T-new");
        const d = new DatabaseSync(f.codingFile); try { d.exec("INSERT INTO coding_item(session,id,payload) VALUES('coding-before','item-new','{}')"); } finally { d.close(); }
      },
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("restored");
    const j = outcome.journal!;
    expect(j.codingBackupPath && existsSync(j.codingBackupPath)).toBe(true);
    expect(f.tasks()).toEqual(["T-1"]);
    expect(f.coding("SELECT id FROM coding_item ORDER BY id")).toEqual(["item-before"]);
    expect(f.gates()).toEqual([]);
    expect(f.paused()).toBe(false);
  } finally { f.close(); }
});

test("c1: a rollback restores the coding catalog with the database and leaves it ungated", async () => {
  const f = fixture({ coding: true });
  try {
    const update = await f.start();
    expect(update.phase).toBe("complete");
    expect(f.gates()).toEqual([]);
    const d = new DatabaseSync(f.codingFile); try { d.exec("INSERT INTO coding_session(id,owner,generation,repo,document) VALUES('coding-after','fixture',1,'/repo','{}')"); } finally { d.close(); }
    const outcome = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(outcome.phase).toBe("complete");
    expect(f.coding("SELECT id FROM coding_session ORDER BY id")).toEqual(["coding-before"]);
    expect(f.gates()).toEqual([]);
    // The rollback's own backup keeps the catalog as it was, coding-after included.
    const kept = new DatabaseSync(outcome.journal!.codingBackupPath!, { readOnly: true });
    try { expect(kept.prepare("SELECT count(*) n FROM coding_session WHERE id='coding-after'").get()!["n"]).toBe(1); } finally { kept.close(); }
  } finally { f.close(); }
});

test("c1: a rollback that fails its health check puts the catalog back as it was before the rollback, ungated", async () => {
  const f = fixture({ coding: true });
  try {
    const update = await f.start();
    const d = new DatabaseSync(f.codingFile); try { d.exec("INSERT INTO coding_session(id,owner,generation,repo,document) VALUES('coding-after','fixture',1,'/repo','{}')"); } finally { d.close(); }
    const outcome = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, { ...f.system, healthy: async () => false });
    expect(outcome.phase).toBe("restored");
    expect(f.coding("SELECT id FROM coding_session ORDER BY id")).toEqual(["coding-after", "coding-before"]);
    expect(f.gates()).toEqual([]);
  } finally { f.close(); }
});

test("an update over a runtime killed before releasing the coding workspace releases its record once its processes are gone, and completes", async () => {
  // Oct 2: 0.9.11 was stopped, every pid was gone, and the catalog still named its `up` child: every swap refused.
  const f = fixture({ coding: true }), agent = fakePid(3);
  try {
    const d = new DatabaseSync(f.codingFile); try { d.prepare("UPDATE coding_owner SET token=?, pid=?, native_pid=?, clean=0").run(randomUUID(), SERVICE_PID, agent); } finally { d.close(); }
    const outcome = await f.start();
    expect(outcome.phase, outcome.message).toBe("complete");
    expect(f.coding("SELECT token, pid, native_pid, clean FROM coding_owner")).toEqual([",0,,1"]);
    expect(outcome.journal!.codingOwnerReleased).toEqual({ pid: SERVICE_PID, nativePid: agent });
    expect(f.ledger().map(e => [e.action, e.outcome])).toEqual([["toolroll coding owner released", "released"], ["toolroll updated", "complete"]]);
    expect(f.paused()).toBe(false);
  } finally { f.close(); }
});

test("a stale coding owner the update did not stop, or whose agent still runs, is never released: the service starts again unchanged", async () => {
  // The agent runs detached, in its own process group: a killed service can leave it behind.
  const agent = spawn("sleep", ["30"], { detached: true, stdio: "ignore" }), unstopped = fakePid(3);
  try {
    for (const stale of [{ pid: unstopped, agent: null }, { pid: SERVICE_PID, agent: agent.pid! }]) {
      const f = fixture({ coding: true });
      try {
        const d = new DatabaseSync(f.codingFile); try { d.prepare("UPDATE coding_owner SET token=?, pid=?, native_pid=?, clean=0").run(randomUUID(), stale.pid, stale.agent); } finally { d.close(); }
        const outcome = await f.start();
        expect(outcome.phase).toBe("refused");
        expect(outcome.message).toMatch(stale.agent === null ? new RegExp(`process ${unstopped} is not one this update stopped`) : /the agent process \d+ is still running/);
        expect(f.coding("SELECT pid FROM coding_owner")).toEqual([String(stale.pid)]);
        expect(f.calls).toEqual(["install", "stop", "restart"]);
        expect(f.paused()).toBe(false);
      } finally { f.close(); }
    }
  } finally { agent.kill(); }
});

test("c2: the one-off update job has no RunAtLoad, starts by kickstart, and resumes only its journal id", async () => {
  const f = fixture();
  try {
    const launchctl: string[][] = [];
    const run = async (file: string, args: readonly string[]) => { if (file === "launchctl") launchctl.push([...args]); return { code: args[0] === "print" ? 113 : 0, stdout: "", stderr: "", timedOut: false }; };
    const home = join(f.root, "home");
    const id = randomUUID();
    await launchRuntimeUpdate({ databaseFile: f.databaseFile, id, dist: f.oldDist }, { home, run: run as never, platform: "darwin" });
    const plist = readFileSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`), "utf8");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
    expect(plist).toContain(`<string>--resume</string>\n    <string>--id</string>\n    <string>${id}</string>`);
    expect(plist).not.toContain("--yes");
    expect(plist).not.toContain("--version");
    expect(launchctl.map(args => args[0])).toEqual(["print", "enable", "bootstrap", "kickstart"]);
    // Run at a login with no saved update: the job starts nothing and removes its own definition.
    const lines: string[] = [];
    expect(await runUpdateCommand(["--resume", "--id", id, "--db", f.databaseFile], line => lines.push(line), { system: f.system, current: f.current, home })).toBe(0);
    expect(lines).toEqual(["The update this job was started for is no longer the saved one. Nothing was changed."]);
    expect(f.calls).toEqual([]);
    expect(readRuntimeUpdate(f.stateDir)).toBeNull();
    expect(existsSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`))).toBe(false);
  } finally { f.close(); }
});

test("c2: a rolled-back release is not re-applied when its job runs again", async () => {
  const f = fixture();
  try {
    const prepared = prepareRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, actor: "ada", version: "0.7.0", when: "now" }, f.system.now());
    if ("refused" in prepared) throw Error(prepared.refused);
    const home = join(f.root, "home"); mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    const job = () => runUpdateCommand(["--resume", "--id", prepared.id], () => {}, { system: f.system, current: f.current, databaseFile: f.databaseFile, home });
    expect(await job()).toBe(0);
    expect(readRuntimeUpdate(f.stateDir)).toMatchObject({ id: prepared.id, phase: "complete" });
    const rollback = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: readRuntimeUpdate(f.stateDir)!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(rollback.phase).toBe("complete");
    const calls = f.calls.length;
    // The same job, started again (a login, a stray kickstart): the saved record is the rollback, so nothing runs.
    writeFileSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`), `<plist><string>${prepared.id}</string></plist>`);
    expect(await job()).toBe(0);
    expect(f.calls).toHaveLength(calls);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(readRuntimeUpdate(f.stateDir)).toMatchObject({ kind: "rollback", phase: "complete" });
    expect(existsSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`))).toBe(false);
    // And a finished update's job does nothing either.
    expect((await resumeRuntimeUpdate(f.stateDir, f.system, readRuntimeUpdate(f.stateDir)!.id)).message).toBe("No update is in progress.");
  } finally { f.close(); }
});

/** A scripted launchctl: bootout returns before the label is gone, as it does on a real Mac. */
test("c3: restoreDatabase runs only after the stopped service's process is gone (scripted launchctl)", async () => {
  const f = fixture();
  try {
    const launchctl = scriptedLaunchctl();
    let exitsAfter = 0, checkedWhileAlive = 0, stops = 0;
    const machine = machineSystem(join(f.root, "home"), {}, { run: launchctl.run as never, alive: pid => {
      if (pid !== SERVICE_PID && pid !== RESTARTED_SERVICE_PID) return false;
      // Each stop leaves its process running for a few more checks; the database must not change meanwhile.
      if (exitsAfter-- > 0) { checkedWhileAlive++; if (stops > 1) expect(f.tasks()).toContain("T-new"); return true; }
      return false;
    } });
    const outcome = await f.start({
      servicePids: machine.servicePids,
      stopService: async unit => { stops++; exitsAfter = 3; await machine.stopService(unit); },
      restartService: async unit => { await machine.restartService(unit); if (stops === 1) f.write("T-new"); },
      processAlive: machine.processAlive,
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("restored");
    expect(checkedWhileAlive).toBe(6);
    expect(f.tasks()).toEqual(["T-1"]);
    expect(launchctl.state.log.filter(verb => verb !== "print")).toEqual(["disable", "bootout", "enable", "bootstrap", "kickstart", "disable", "bootout", "enable", "bootstrap", "kickstart"]);
    // The waits happened at the launchd boundary too: print was polled until the label disappeared.
    expect(launchctl.state.log.filter(verb => verb === "print").length).toBeGreaterThanOrEqual(6);
  } finally { f.close(); }
});

test("the stopped service's processes include its `up` child, the one that owns the coding catalog", async () => {
  const f = fixture(), service = fakePid(1), up = fakePid(2);
  try {
    const run = async (file: string, args: readonly string[]) => file === "pgrep"
      ? { code: 0, stdout: `${args[1] === String(service) ? `${up}\n` : ""}`, stderr: "", timedOut: false }
      : { code: 0, stdout: `com.toolroll.browser = {\n\tstate = running\n\tpid = ${service}\n}`, stderr: "", timedOut: false };
    const machine = machineSystem(join(f.root, "home"), {}, { run: run as never });
    expect(await machine.servicePids(f.unit)).toEqual([service, up]);
  } finally { f.close(); }
});

test("c3: a service process that never exits is never written under: the database is not replaced", async () => {
  const f = fixture();
  try {
    const launchctl = scriptedLaunchctl();
    let stops = 0;
    const machine = machineSystem(join(f.root, "home"), {}, { run: launchctl.run as never, alive: pid => stops > 1 && pid === RESTARTED_SERVICE_PID });
    const outcome = await f.start({
      servicePids: machine.servicePids, processAlive: machine.processAlive, exitTimeoutMs: 5000,
      stopService: async unit => { stops++; await machine.stopService(unit); },
      restartService: async unit => { await machine.restartService(unit); if (stops === 1) f.write("T-new"); },
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("needs-attention");
    expect(outcome.message).toContain(`still running (process ${RESTARTED_SERVICE_PID}) after it was stopped. Nothing was replaced`);
    expect(f.tasks()).toEqual(["T-1", "T-new"]);
  } finally { f.close(); }
});

test("c3: every rename is fsynced first, and its directory after (update, restore and rollback)", async () => {
  const f = fixture({ coding: true });
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
  const paths = new Map<number, string>(), events: { kind: "fsync" | "rename"; path: string; to?: string }[] = [];
  fs.openSync = ((path: string, ...rest: unknown[]) => { const fd = (real.openSync as (...a: unknown[]) => number)(path, ...rest); paths.set(fd, String(path)); return fd; }) as typeof fs.openSync;
  fs.fsyncSync = ((fd: number) => { events.push({ kind: "fsync", path: paths.get(fd) ?? "?" }); real.fsyncSync(fd); }) as typeof fs.fsyncSync;
  fs.renameSync = ((from: string, to: string) => { events.push({ kind: "rename", path: String(from), to: String(to) }); real.renameSync(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    expect((await f.start({ healthy: async () => false })).phase).toBe("restored");
    const update = await f.start();
    expect((await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system)).phase).toBe("complete");
    const renames = events.map((event, i) => ({ event, i })).filter(({ event }) => event.kind === "rename" && event.path.startsWith(f.root));
    expect(renames.map(({ event }) => event.to)).toEqual(expect.arrayContaining([f.databaseFile, f.codingFile, f.unit, ...f.links]));
    for (const { event, i } of renames) {
      const before = events[i - 1]!, after = events[i + 1]!;
      expect(before.kind).toBe("fsync");
      expect([event.path, dirname(event.path)]).toContain(before.path);
      expect(after).toEqual({ kind: "fsync", path: dirname(event.to!) });
    }
  } finally {
    Object.assign(fs, real); syncBuiltinESMExports();
    f.close();
  }
});

/** npm, scripted: installs the named release from the registry, writes its lockfile, and reports its signatures. */
test("c4: the release is installed from the registry under npm's signature check, and a tampered or wrong-repository package is refused before anything changes", async () => {
  const good = fixture();
  try {
    const npm = scriptedNpm();
    const outcome = await good.start({ install: machineSystem(join(good.root, "home"), {}, { exec: npm.exec }).install });
    expect(outcome.phase).toBe("complete");
    // By name from the registry, never a local tarball npm would not check; then npm audit signatures on it.
    expect(npm.calls.map(call => call.args.slice(0, 2))).toEqual([["install", "--omit=dev"], ["audit", "signatures"]]);
    expect(npm.calls[0]!.spec).toEqual({ toolroll: "0.7.0" });
    expect(npm.calls[0]!.args).toContain(`--registry=${REGISTRY}/`);
  } finally { good.close(); }
  const tampered: [string, Partial<UpdateSystem>, RegExp][] = [
    ["installed bytes differ", { install: machineSystem(tmpdir(), {}, { exec: scriptedNpm({ integrity: "sha512-c29tZXRoaW5nIGVsc2U=" }).exec }).install }, /npm installed different bytes than the verified Toolroll 0\.7\.0/],
    ["no verified attestation", { install: machineSystem(tmpdir(), {}, { exec: scriptedNpm({ audit: { status: 0, stdout: "1 package has a verified registry signature\n" } }).exec }).install }, /did not verify Toolroll 0\.7\.0's provenance attestation/],
    ["a bad signature", { install: machineSystem(tmpdir(), {}, { exec: scriptedNpm({ audit: { status: 1, stdout: "1 package has an invalid registry signature" } }).exec }).install }, /could not verify the package signatures/],
    ["a tampered tarball", { download: async () => new TextEncoder().encode("tampered") }, /does not match the registry's checksum/],
    ["another repository", { attestations: async () => provenance({ repository: "https://github.com/someone/toolroll" }) }, /built by https:\/\/github.com\/someone\/toolroll/],
  ];
  for (const [label, overrides, message] of tampered) {
    const f = fixture();
    try {
      const outcome = await f.start(overrides);
      expect(outcome.phase, label).toBe("refused");
      expect(outcome.message, label).toMatch(message);
      expect(outcome.message, label).toMatch(/Nothing was changed/);
      expect(f.calls.filter(call => call !== "install"), label).toEqual([]);
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
      expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
      expect(f.paused()).toBe(false);
      expect(outcome.journal!.backupPath, label).toBeUndefined();
    } finally { f.close(); }
  }
});

test("c4: verification adds no runtime dependency: the updater uses Node's own modules and npm", () => {
  const source = readFileSync(join(dirname(new URL(import.meta.url).pathname), "toolroll-update.ts"), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1]!);
  expect(imports.filter(spec => !spec.startsWith("node:") && !spec.startsWith("./"))).toEqual([]);
  const manifest = JSON.parse(readFileSync(join(dirname(new URL(import.meta.url).pathname), "..", "package.json"), "utf8")) as { dependencies: Record<string, string> };
  expect(Object.keys(manifest.dependencies).filter(name => /sigstore|tuf|in-toto|x509|asn1/i.test(name))).toEqual([]);
});

test("c5: nothing written before the stop is lost, and what the new version wrote during health is kept and named", async () => {
  const f = fixture();
  try {
    let restarts = 0;
    const outcome = await f.start({
      // The old service's last write as it shuts down: before the backup, so the restore keeps it.
      stopService: async () => { f.calls.push("stop"); if (f.calls.filter(c => c === "stop").length === 1) f.write("T-late"); },
      restartService: async () => { f.calls.push("restart"); if (++restarts === 1) f.write("T-new"); },
      healthy: async () => false,
      processAlive: () => false,
    });
    expect(outcome.phase).toBe("restored");
    expect(f.calls.indexOf("stop")).toBeLessThan(f.calls.indexOf("rehearse"));
    expect(f.tasks()).toEqual(["T-1", "T-late"]);
    const kept = outcome.journal!.keptAside!;
    expect(outcome.message).toContain(`Anything written since the backup is kept in ${kept}.`);
    expect(f.tasks(kept)).toEqual(["T-1", "T-late", "T-new"]);
  } finally { f.close(); }
});

test("c5: a retried restore never puts the backup back twice: what was written between attempts survives", async () => {
  const f = fixture();
  try {
    let restarts = 0;
    const flaky = {
      stopService: async () => { f.calls.push("stop"); },
      // 1: the new version starts (and writes); 2: the restore's restart fails, as launchd's "Bootstrap failed: 5" can.
      restartService: async () => { f.calls.push("restart"); restarts++; if (restarts === 1) f.write("T-new"); if (restarts === 2) throw new Error("Bootstrap failed: 5"); },
      healthy: async () => false,
      processAlive: () => false,
    };
    const first = await f.start(flaky);
    expect(first.phase).toBe("needs-attention");
    expect(first.journal!.restoredDatabase).toBe(true);
    // The restored version's own CLI writes while the person reads the message.
    f.write("T-between");
    const resumed = await resumeRuntimeUpdate(f.stateDir, { ...f.system, ...flaky, restartService: async () => { f.calls.push("restart"); } });
    expect(resumed.phase).toBe("restored");
    expect(f.tasks()).toContain("T-between");
    expect(f.tasks()).not.toContain("T-new");
  } finally { f.close(); }
});

test("c5: a foreground toolroll up blocks an update, with or without a service", async () => {
  for (const service of [true, false]) {
    const f = fixture();
    try {
      const d = f.db(); try { d.prepare("INSERT INTO watch_lease(runner,repo,owner,generation,started_at,expires_at,heartbeat_at) VALUES('laptop','/code/app','fg',1,'x','2999-01-01T00:00:00Z','x')").run(); } finally { d.close(); }
      const outcome = await f.start(service ? {} : { serviceUnit: () => null });
      expect(outcome.phase).toBe("refused");
      expect(outcome.message).toMatch(/toolroll up is running for \/code\/app \(laptop\)\. Stop it first/);
      // With a service it was stopped for the check and started again, unchanged.
      expect(f.calls).toEqual(service ? ["install", "stop", "restart"] : ["install"]);
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
      expect(f.paused()).toBe(false);
    } finally { f.close(); }
  }
});

test("c5: a shimmed or foreign toolroll on PATH refuses the update before anything changes", async () => {
  const f = fixture();
  try {
    const shim = join(f.root, "shims", "toolroll"); mkdirSync(dirname(shim)); writeFileSync(shim, "#!/bin/sh\nexec node /elsewhere/toolroll \"$@\"\n");
    const other = join(f.root, "other", "standing-orders"); mkdirSync(dirname(other)); mkdirSync(join(f.root, "elsewhere")); writeFileSync(join(f.root, "elsewhere", "bin.js"), ""); symlinkSync(join(f.root, "elsewhere", "bin.js"), other);
    const env = { PATH: [dirname(f.links[0]!), dirname(shim), dirname(other)].join(":") };
    const found = machineSystem(join(f.root, "home"), env).commands(f.current);
    expect(found).toEqual([...f.links, shim, other]);
    for (const [commands, message] of [[[...f.links, shim], /shims\/toolroll is not a link Toolroll can switch/], [[...f.links, other], /other\/standing-orders runs a different Toolroll/]] as const) {
      const outcome = await f.start({ commands: () => [...commands] });
      expect(outcome.phase).toBe("refused");
      expect(outcome.message).toMatch(message);
      expect(f.calls).toEqual(["install"]);
      expect(f.paused()).toBe(false);
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
      f.calls.length = 0;
    }
  } finally { f.close(); }
});

test("c6: a downgrade is refused unless asked for, and only two release runtimes are kept", async () => {
  const f = fixture();
  try {
    const refused = await startRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, actor: "ada", version: "0.5.0", when: "now" }, f.system);
    expect(refused).toMatchObject({ ok: false, phase: "refused" });
    expect(refused.message).toMatch(/0\.5\.0 is not newer than 0\.6\.0.*--allow-downgrade/);
    expect(f.calls).toEqual([]);
    // Two earlier release runtimes, a deploy-browser runtime and a rollback record already on disk.
    const staged = join(f.stateDir, "staged-upgrades");
    for (const [name, startedAt] of [["release-0.6.8-aaaaaaaa", "2026-01-01T00:00:00Z"], ["release-0.6.9-bbbbbbbb", "2026-02-01T00:00:00Z"], ["browser-abc-123", ""], ["rollback-0.6.8-cccccccc", ""]] as const) {
      mkdirSync(join(staged, name), { recursive: true }); if (startedAt) writeFileSync(join(staged, name, "update.json"), JSON.stringify({ startedAt }));
    }
    const outcome = await f.start();
    expect(outcome.phase).toBe("complete");
    const left = readdirSync(staged).sort();
    expect(left.filter(name => name.startsWith("release-"))).toEqual(["release-0.6.9-bbbbbbbb", basename(outcome.journal!.stageDir)].sort());
    expect(left).toEqual(expect.arrayContaining(["browser-abc-123", "rollback-0.6.8-cccccccc"]));
    // What a rollback needs is never pruned, however old.
    expect(pruneRuntimes(f.stateDir, [join(staged, "release-0.6.9-bbbbbbbb", "runtime", "dist")])).toEqual([]);
  } finally { f.close(); }
});

test("c6: Settings → Updates asks npm nothing while update checks are off, until Check now", async () => {
  const f = fixture();
  const store = openStore(f.databaseFile);
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("alex");
  const configDir = join(f.root, "config"); mkdirSync(configDir); setUpdateChecks(configDir, false);
  const checksEnv = process.env["TOOLROLL_NO_UPDATE_CHECK"]; delete process.env["TOOLROLL_NO_UPDATE_CHECK"];
  let asked = 0;
  const server = createDecisionServer({ store, evidenceRoot: join(f.root, "evidence"), configDir, updates: {
    latest: async () => { asked++; return { version: "0.7.0" }; }, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" }, current: "0.6.0", dist: f.oldDist, launch: async () => {},
  } });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
    const off = await get("/settings/updates");
    expect(asked).toBe(0);
    expect(off).toContain("Update checks are off.");
    expect(off).toContain('<input type="hidden" name="check" value="now"><button type="submit">Check now</button>');
    expect(off).not.toContain("Update now");
    const checked = await get("/settings/updates?check=now");
    expect(asked).toBe(1);
    expect(checked).toContain("Toolroll 0.7.0 is available");
    await get("/settings/updates");
    expect(asked).toBe(1);
  } finally {
    if (checksEnv !== undefined) process.env["TOOLROLL_NO_UPDATE_CHECK"] = checksEnv;
    await new Promise<void>(done => server.close(() => done()));
    store.close(); f.close();
  }
}, 30_000);

// ---- 0.8.0 re-review follow-ups: provenance identity and the recovery paths ----
