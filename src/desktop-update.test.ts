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
import { previewDesktopUpdate, prepareDesktopUpdate, runDesktopUpdate, readUpdateJournal, desktopUpdateStatus, requestUpdateRestore, requestUpdateStop, durableJson, type UpdateHooks, type UpdateJournal } from "./desktop-update.js";
import { superviseDesktopUpdate, runUpdateAttempt, updateRecoveryDefinition, armUpdateRecovery } from "./desktop-update-recovery.js";
import { launchdPlist } from "./daemon.js";
import { installUpdateGate, removeUpdateGate, updateAdmissionPaused, freezeUpdateGate, UPDATE_PAUSED } from "./desktop-update-gate.js";
import { CodingWorkspace } from "./coding-workspace.js";
import { fixture, armFixture, codingFixture } from "../test/desktop-update-kit.js";

vi.mock("node:child_process", { spy: true });

test('coding sessions drain before update, new submissions wait, and SQLite backup retains WAL history and custody', async () => {
  const f = fixture(), coding = codingFixture(f, 'working');
  try {
    const plan = await previewDesktopUpdate(f.state, f.installed, f.candidate, 'com.standing-orders.test.update', f.hooks);
    expect(plan.active.coding).toBe(1);
    const j = await f.prepare(); let drains = 0;
    await runDesktopUpdate(f.state, { ...f.hooks,
      sleep: async () => {
        drains++;
        expect(f.calls).toEqual([]);
        expect(() => coding.db.prepare("INSERT INTO coding_submission VALUES('coding-one','next-message','digest','pending',NULL)").run()).toThrow('updating');
        expect(() => coding.db.prepare('INSERT INTO coding_session(id,owner,generation,repo,document) VALUES(?,?,?,?,?)').run('new', 'fixture', 1, f.root, JSON.stringify({ status: 'starting' }))).toThrow('updating');
        // Same-id UPSERT is how native events finish the accepted turn.
        coding.db.prepare('INSERT INTO coding_session(id,owner,generation,repo,document) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(coding.session.id, 'fixture', 1, f.root, JSON.stringify({ ...coding.session, status: 'ready', turnId: null }));
      },
      service: async (action, app, journal) => { if (action === 'stop') await coding.workspace.close(); await f.hooks.service!(action, app, journal); },
    });
    expect(drains).toBe(1);
    const done = readUpdateJournal(f.state)!;
    expect(done.phase).toBe('complete'); expect(done.codingBackupHash).toMatch(/^[a-f0-9]{64}$/);
    expect(done.codingBackupPath).toBe(join(j.workDir, 'coding.backup.sqlite'));
    const copied = new DatabaseSync(done.codingBackupPath!, { readOnly: true });
    try {
      expect(copied.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
      expect(copied.prepare('SELECT payload FROM coding_item').get()?.payload).toContain('committed WAL transcript');
      expect(copied.prepare('SELECT payload FROM coding_custody').get()?.payload).toContain('observationUnknown');
      expect(copied.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_coding_update_*'").get()?.n).toBe(0);
    } finally { copied.close(); }
    if (process.platform !== 'win32') expect(statSync(done.codingBackupPath!).mode & 0o777).toBe(0o600);
    expect(f.calls.filter(call => call === 'swap')).toHaveLength(1);
    expect(coding.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_coding_update_*'").get()?.n).toBe(0);
  } finally { await coding.close(); f.close(); }
});

test('an apparently stopped service cannot update until coding process cleanup is verified', async () => {
  const f = fixture(), coding = codingFixture(f);
  try {
    coding.db.prepare('UPDATE coding_owner SET clean=0,native_pid=2147483647').run();
    await f.prepare();
    await runDesktopUpdate(f.state, f.hooks);
    expect(f.calls).not.toContain('swap');
    expect(readUpdateJournal(f.state)?.error).toContain('coding server has not verified');
    expect(coding.db.prepare('SELECT clean,native_pid FROM coding_owner').get()).toMatchObject({ clean: 0, native_pid: 2147483647 });
    expect(coding.db.prepare('SELECT payload FROM coding_item').get()?.payload).toContain('committed WAL transcript');
  } finally { await coding.close(); f.close(); }
});

test('an update over an app killed before releasing the coding workspace releases its record once the service processes are gone, and completes', async () => {
  // Fake pids above macOS's 99999 limit: a real process can never hold them (4243 was a Brave tab after a restart).
  // Oct 2: a stopped 0.9.11 left its owner record naming its dead controller, and every swap refused.
  const f = fixture(), coding = codingFixture(f); let closed = false;
  try {
    await coding.close(); closed = true;
    const db = new DatabaseSync(coding.file);
    try {
      db.prepare('UPDATE coding_owner SET token=?,pid=999982,native_pid=999991,clean=0').run(randomUUID());
      db.prepare('UPDATE coding_custody SET payload=?').run(JSON.stringify({ pid: 999991, group: true, descendants: [{ pid: 999992, group: false }], observationUnknown: false, host: hostname() }));
    } finally { db.close(); }
    writeFileSync(join(f.state, 'controller-supervisor.json'), JSON.stringify({ version: 1, supervisorPid: 999981, controllerPid: 999982, phase: 'running' }));
    await f.prepare();
    const alive = new Set([999981, 999982]);
    await runDesktopUpdate(f.state, { ...f.hooks, processAlive: pid => alive.has(pid),
      service: async (action, app, journal) => { if (action === 'stop') alive.clear(); await f.hooks.service!(action, app, journal); } });
    const done = readUpdateJournal(f.state)!;
    expect(done.phase, done.error).toBe('complete');
    expect(done.stoppedPids).toEqual([999981, 999982]);
    expect(done.codingOwnerReleased).toEqual({ pid: 999982, nativePid: 999991 });
    const after = new DatabaseSync(coding.file, { readOnly: true });
    try { expect(after.prepare('SELECT token,pid,native_pid,clean FROM coding_owner').get()).toEqual({ token: '', pid: 0, native_pid: null, clean: 1 }); } finally { after.close(); }
    const orders = f.db();
    try { expect(orders.prepare("SELECT action,outcome FROM action_ledger WHERE action='coding owner released'").all()).toEqual([{ action: 'coding owner released', outcome: 'released' }]); } finally { orders.close(); }
    expect(f.calls.filter(call => call === 'swap')).toHaveLength(1);
  } finally { if (!closed) await coding.close(); f.close(); }
});

test('a retained coding backup changed after an interrupted update is not overwritten', async () => {
  const f = fixture(), coding = codingFixture(f);
  try {
    await f.prepare();
    await expect(runDesktopUpdate(f.state, { ...f.hooks, checkpoint: phase => { if (phase === 'stopping') throw Object.assign(Error('fixture interruption'), { simulatedCrash: true }); } })).rejects.toThrow('fixture interruption');
    const before = readUpdateJournal(f.state)!;
    const copy = new DatabaseSync(before.codingBackupPath!);
    copy.prepare("UPDATE coding_item SET payload='changed retained backup'").run(); copy.close();
    await runDesktopUpdate(f.state, f.hooks);
    expect(f.calls).not.toContain('swap');
    expect(readUpdateJournal(f.state)?.error).toContain('retained coding backup is missing, linked or changed');
    const preserved = new DatabaseSync(before.codingBackupPath!, { readOnly: true });
    expect(preserved.prepare('SELECT payload FROM coding_item').get()?.payload).toBe('changed retained backup'); preserved.close();
    expect(coding.db.prepare('SELECT payload FROM coding_item').get()?.payload).toContain('committed WAL transcript');
  } finally { await coding.close(); f.close(); }
});

test.each(['signature', 'install health', 'restore health'] as const)('a first catalog at %s is backed up before the next replacement or admission release', async boundary => {
  const f = fixture(); let coding: ReturnType<typeof codingFixture> | undefined;
  const createCatalog = async () => { if (!coding) { coding = codingFixture(f); await coding.close(); } };
  try {
    const j = await f.prepare();
    await runDesktopUpdate(f.state, { ...f.hooks,
      verify: async () => { if (boundary === 'signature') await createCatalog(); },
      healthy: async app => {
        if (boundary === 'restore health' && app.buildId === j.next.buildId) return false;
        if (boundary !== 'signature') await createCatalog();
        return true;
      },
      swap: async journal => {
        if (coding) expect(journal.codingBackupHash).toMatch(/^[a-f0-9]{64}$/);
        await f.hooks.swap!(journal);
      },
    });
    const result = readUpdateJournal(f.state)!;
    expect(result.phase).toBe(boundary === 'restore health' ? 'restored' : 'complete');
    expect(result.replacementOccurred).toBe(true);
    expect(result.codingCatalogExpected).toBe(true);
    const backup = new DatabaseSync(result.codingBackupPath!, { readOnly: true });
    try { expect(backup.prepare('SELECT payload FROM coding_item').get()?.payload).toContain('committed WAL transcript'); } finally { backup.close(); }
    const db = f.db(); try { expect(updateAdmissionPaused(db)).toBe(false); } finally { db.close(); }
  } finally { f.close(); }
});

test.each(['missing', 'changed', 'linked'] as const)('a %s retained coding backup blocks final swap, restore and completion boundaries', async damage => {
  for (const boundary of ['signature', 'restore', 'completion'] as const) {
    const f = fixture(), coding = codingFixture(f); await coding.close();
    try {
      const j = await f.prepare(); let damaged = false;
      const damageBackup = () => {
        if (damaged) return; damaged = true;
        const target = readUpdateJournal(f.state)!.codingBackupPath!;
        if (damage === 'changed') writeFileSync(target, 'preserve changed bytes');
        else { renameSync(target, target + '.preserved'); if (damage === 'linked') symlinkSync(target + '.preserved', target); }
      };
      await runDesktopUpdate(f.state, { ...f.hooks,
        verify: async () => { if (boundary === 'signature') damageBackup(); },
        healthy: async app => { if (app.buildId === j.next.buildId) { damageBackup(); return boundary !== 'restore'; } return true; },
      });
      const result = readUpdateJournal(f.state)!;
      expect(result.detail).toContain('retained coding backup is missing, linked or changed');
      expect(result.phase).toBe(boundary === 'signature' ? 'restored' : 'needs-attention');
      expect(f.calls.filter(c => c === 'swap')).toHaveLength(boundary === 'signature' ? 0 : 1);
      const db = f.db(); try { expect(updateAdmissionPaused(db)).toBe(boundary !== 'signature'); } finally { db.close(); }
      expect(bundleHash(f.installed)).toBe(boundary === 'signature' ? j.old.hash : j.next.hash);
    } finally { f.close(); }
  }
});

test('a harmless cancellation before replacement needs no catalog backup', async () => {
  const f = fixture(); let coding: ReturnType<typeof codingFixture> | undefined;
  try {
    await f.prepare();
    await runDesktopUpdate(f.state, { ...f.hooks, checkpoint: phase => {
      if (phase === 'draining') { coding = codingFixture(f, 'working'); requestUpdateRestore(f.state); }
    } });
    expect(readUpdateJournal(f.state)).toMatchObject({ phase: 'cancelled', codingCatalogExpected: true });
    expect(readUpdateJournal(f.state)?.codingBackupPath).toBeUndefined();
    expect(f.calls).not.toContain('swap');
    const db = f.db(); try { expect(updateAdmissionPaused(db)).toBe(false); } finally { db.close(); }
  } finally { await coding?.close(); f.close(); }
});

test('crash recovery remembers a performed swap before restoring and refuses a lost backup at release', async () => {
  const f = fixture(), coding = codingFixture(f); await coding.close();
  try {
    const j = await f.prepare();
    await expect(runDesktopUpdate(f.state, { ...f.hooks, swap: async journal => {
      await f.hooks.swap!(journal); throw Object.assign(Error('after swap'), { simulatedCrash: true });
    } })).rejects.toThrow('after swap');
    expect(readUpdateJournal(f.state)?.replacementOccurred).toBeUndefined();
    requestUpdateRestore(f.state);
    await runDesktopUpdate(f.state, { ...f.hooks, healthy: async () => {
      expect(readUpdateJournal(f.state)?.replacementOccurred).toBe(true);
      rmSync(readUpdateJournal(f.state)!.codingBackupPath!); return true;
    } });
    expect(bundleHash(f.installed)).toBe(j.old.hash);
    expect(readUpdateJournal(f.state)).toMatchObject({ phase: 'needs-attention', replacementOccurred: true });
    const db = f.db(); try { expect(updateAdmissionPaused(db)).toBe(true); } finally { db.close(); }
  } finally { f.close(); }
});

test.each(['install', 'restore'] as const)('a coding catalog disappearing after backup blocks the %s swap and preserves the pause', async direction => {
  const f = fixture(), coding = codingFixture(f); let closed = false;
  try {
    const j = await f.prepare(); let stops = 0;
    await runDesktopUpdate(f.state, { ...f.hooks,
      service: async (action, app, journal) => {
        await f.hooks.service!(action, app, journal);
        if (action !== 'stop') return;
        stops++;
        if (!closed) { await coding.close(); closed = true; }
        if (stops === (direction === 'install' ? 1 : 2)) renameSync(coding.file, `${coding.file}.preserved`);
      },
      healthy: async app => direction === 'install' || app.buildId === j.old.buildId,
    });
    const result = readUpdateJournal(f.state)!;
    expect(result.phase).toBe('needs-attention');
    expect(result.detail).toContain('coding catalog disappeared');
    expect(result.codingBackupPath).toBeTruthy();
    expect(f.calls.filter(call => call === 'swap')).toHaveLength(direction === 'install' ? 0 : 1);
    expect(bundleHash(f.installed)).toBe(direction === 'install' ? j.old.hash : j.next.hash);
    const db = f.db(); try { expect(updateAdmissionPaused(db)).toBe(true); } finally { db.close(); }
    expect(existsSync(coding.file)).toBe(false);
    const backup = new DatabaseSync(result.codingBackupPath!, { readOnly: true });
    try { expect(backup.prepare('SELECT payload FROM coding_item').get()?.payload).toContain('committed WAL transcript'); } finally { backup.close(); }
  } finally { if (!closed) await coding.close(); f.close(); }
});

test('a coding catalog observed while preparing cannot disappear before backup and become a legacy update', async () => {
  const f = fixture(), coding = codingFixture(f); let closed = false;
  try {
    await f.prepare();
    await coding.close(); closed = true; renameSync(coding.file, `${coding.file}.preserved`);
    await runDesktopUpdate(f.state, f.hooks);
    expect(readUpdateJournal(f.state)?.error).toContain('coding catalog disappeared');
    const paused = f.db(); try { expect(updateAdmissionPaused(paused)).toBe(true); } finally { paused.close(); }
    expect(f.calls).toEqual([]);
    expect(existsSync(coding.file)).toBe(false);
  } finally { if (!closed) await coding.close(); f.close(); }
});

test.each(['controllers', 'signature', 'install health', 'restore health'] as const)('desktop custody is rechecked after awaited %s work', async boundary => {
  const f = fixture(), coding = codingFixture(f); let closed = false, removed = false;
  try {
    const j = await f.prepare(); await coding.close(); closed = true;
    const loseCatalog = async () => { await Promise.resolve(); if (!removed) { renameSync(coding.file, `${coding.file}.preserved`); removed = true; } };
    await runDesktopUpdate(f.state, { ...f.hooks,
      otherControllers: async () => { if (boundary === 'controllers' && f.calls.some(call => call.startsWith('stop:'))) await loseCatalog(); return false; },
      verify: async () => { if (boundary === 'signature') await loseCatalog(); },
      healthy: async app => {
        if (boundary === 'install health' || (boundary === 'restore health' && app.buildId === j.old.buildId)) await loseCatalog();
        return boundary !== 'restore health' || app.buildId === j.old.buildId;
      },
    });
    expect(removed).toBe(true);
    const result = readUpdateJournal(f.state)!;
    expect(result.phase).toBe('needs-attention');
    expect(result.detail).toContain('coding catalog disappeared');
    const swaps = boundary === 'install health' ? 1 : boundary === 'restore health' ? 2 : 0;
    expect(f.calls.filter(call => call === 'swap')).toHaveLength(swaps);
    const db = f.db(); try { expect(updateAdmissionPaused(db)).toBe(true); } finally { db.close(); }
    expect(existsSync(coding.file)).toBe(false);
  } finally { if (!closed) await coding.close(); f.close(); }
});

test('a catalog first observed during drain remains required across the wait and error cleanup', async () => {
  const f = fixture(); let coding: ReturnType<typeof codingFixture> | undefined, closed = false;
  try {
    const j = await f.prepare(); expect(j.codingCatalogExpected).toBe(false);
    await runDesktopUpdate(f.state, { ...f.hooks,
      checkpoint: phase => { if (phase === 'draining' && !coding) coding = codingFixture(f, 'working'); },
      sleep: async () => {
        expect(readUpdateJournal(f.state)?.codingCatalogExpected).toBe(true);
        await coding!.close(); closed = true; renameSync(coding!.file, `${coding!.file}.preserved`);
      },
    });
    expect(readUpdateJournal(f.state)?.phase).toBe('needs-attention');
    const db = f.db(); try { expect(updateAdmissionPaused(db)).toBe(true); } finally { db.close(); }
    expect(f.calls).toEqual([]);
  } finally { if (coding && !closed) await coding.close(); f.close(); }
});

test('desktop swap rechecks native shutdown after asynchronous signature verification', async () => {
  const f = fixture(), coding = codingFixture(f); let closed = false;
  try {
    await f.prepare(); await coding.close(); closed = true;
    await runDesktopUpdate(f.state, { ...f.hooks, verify: async () => {
      await Promise.resolve();
      const db = new DatabaseSync(coding.file); try { db.prepare('UPDATE coding_owner SET clean=0,native_pid=2147483647').run(); } finally { db.close(); }
    } });
    expect(f.calls).not.toContain('swap');
    expect(readUpdateJournal(f.state)?.error).toContain('coding server has not verified');
  } finally { if (!closed) await coding.close(); f.close(); }
});

test('desktop swap repeats whole worker quiescence after signature verification', async () => {
  const f = fixture();
  try {
    await f.prepare();
    await runDesktopUpdate(f.state, { ...f.hooks, verify: async () => {
      await Promise.resolve();
      const db = f.db(), now = new Date().toISOString();
      try { db.prepare('INSERT INTO watch_lease VALUES(?,?,?,?,?,?,?)').run('racing-worker', f.root, 'fixture', 1, now, new Date(Date.now() + 60_000).toISOString(), now); } finally { db.close(); }
    } });
    expect(f.calls).not.toContain('swap');
    expect(readUpdateJournal(f.state)?.error).toContain('worker or active operation');
  } finally { f.close(); }
});

test.each(['install', 'restore'] as const)('desktop final %s stop cannot release admission with unverified native shutdown', async direction => {
  const f = fixture(), coding = codingFixture(f); let closed = false;
  try {
    const j = await f.prepare({ serviceStatus: async () => ({ state: 'disabled' }) }); let stops = 0;
    await runDesktopUpdate(f.state, { ...f.hooks,
      service: async (action, app, journal) => {
        await f.hooks.service!(action, app, journal);
        if (action !== 'stop') return;
        stops++;
        if (!closed) { await coding.close(); closed = true; }
        if (stops === (direction === 'install' ? 2 : 3)) {
          const db = new DatabaseSync(coding.file); try { db.prepare('UPDATE coding_owner SET clean=0,native_pid=2147483647').run(); } finally { db.close(); }
        }
      },
      healthy: async app => direction === 'install' || app.buildId === j.old.buildId,
    });
    expect(readUpdateJournal(f.state)?.phase).toBe('needs-attention');
    expect(readUpdateJournal(f.state)?.detail).toContain('coding server has not verified');
    const db = f.db(); try { expect(updateAdmissionPaused(db)).toBe(true); } finally { db.close(); }
  } finally { if (!closed) await coding.close(); f.close(); }
});

test('a missing legacy coding catalog is allowed but a dangling catalog link blocks the update', async () => {
  const f = fixture();
  try {
    const plan = await previewDesktopUpdate(f.state, f.installed, f.candidate, 'com.standing-orders.test.update', f.hooks);
    expect(plan.active.coding).toBe(0); expect(plan.active.codingDeliveries).toBe(0);
    expect(existsSync(`${f.config.databaseFile}.coding.sqlite`)).toBe(false);
    symlinkSync(join(f.root, 'missing.sqlite'), `${f.config.databaseFile}.coding.sqlite`);
    await expect(previewDesktopUpdate(f.state, f.installed, f.candidate, 'com.standing-orders.test.update', f.hooks)).rejects.toThrow('linked or not a regular');
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});

test('an existing coding catalog with missing ownership is not treated as a legacy installation', async () => {
  const f = fixture(), coding = codingFixture(f);
  try {
    coding.db.prepare('DELETE FROM coding_owner').run();
    await expect(previewDesktopUpdate(f.state, f.installed, f.candidate, 'com.standing-orders.test.update', f.hooks)).rejects.toThrow('no process ownership record');
    expect(f.calls).toEqual([]);
    expect(coding.db.prepare('SELECT payload FROM coding_item').get()?.payload).toContain('committed WAL transcript');
  } finally { await coding.close(); f.close(); }
});
