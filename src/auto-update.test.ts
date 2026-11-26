/**
 * Automatic updates' durable state (auto-update.ts): one reservation per version, made atomically with the checks that
 * allow it, and each attempt's outcome read from the update's own journal and recorded once with its ledger row —
 * restored, refused, cancelled, rolled back by a person, never started, or no longer on this computer. Unreadable
 * history or journals record nothing and reserve nothing. Isolated temp stores and state folders; no updater runs.
 */
import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableJson } from "./desktop-update.js";
import { addApprover } from "./scope.js";
import { openStore, type Store } from "./store.js";
import { prepareLockFile, prepareRuntimeUpdate, readRuntimeUpdate, resumeRuntimeUpdate, type RuntimeUpdateJournal, type UpdateSystem } from "./toolroll-update.js";
import { lockHeld, sqliteLock } from "./desktop-update.js";
import { autoUpdateAttempts, autoUpdateDecision, autoUpdatePass, cancelAutomaticUpdate, type AutoUpdateFacts, linkAutoUpdateJournal, reconcileAutoUpdates, reserveAutoUpdate, setAutoUpdatePolicy, AUTO_UPDATE_STALE_MS } from "./auto-update.js";

const T0 = new Date("2026-11-26T03:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const worlds: { dir: string; store: Store }[] = [];
afterEach(() => { for (const one of worlds.splice(0)) { one.store.close(); rmSync(one.dir, { recursive: true, force: true }); } });

function world(): { dir: string; store: Store; databaseFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-auto-"));
  const databaseFile = join(dir, "orders.db");
  const store = openStore(databaseFile);
  worlds.push({ dir, store });
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  setAutoUpdatePolicy(store, true, "alex", T0);
  return { dir, store, databaseFile };
}
/** A prepared update journal for `version` (as the automatic pass prepares one), then moved to `phase`. */
function journal(w: { dir: string; databaseFile: string }, version: string, phase?: RuntimeUpdateJournal["phase"], more: Partial<RuntimeUpdateJournal> = {}): RuntimeUpdateJournal {
  const j = prepareRuntimeUpdate({ stateDir: w.dir, databaseFile: w.databaseFile, current: { version: "0.9.120", dist: join(w.dir, "dist") }, actor: "automatic update", version, when: "when-idle" }, T0);
  if ("refused" in j) throw new Error(j.refused);
  if (phase !== undefined) save({ ...j, ...more, phase, detail: `${phase} detail` });
  return readRuntimeUpdate(w.dir)!;
}
function save(j: RuntimeUpdateJournal): void { durableJson(join(j.stageDir, "update.json"), j); durableJson(join(j.stateDir, "toolroll-update.json"), j); }
const ledger = (store: Store) => store.handle.prepare("SELECT actor, outcome FROM action_ledger WHERE action = 'toolroll automatic update' ORDER BY id").all().map(row => ({ ...row }));

describe("reserving a version", () => {
  test("once per version, only while the switch is on and the person who turned it on still stands", () => {
    const w = world();
    const first = reserveAutoUpdate(w.store, { version: "0.9.121", from: "0.9.120", now: T0 });
    expect(first).toMatchObject({ ok: true, attempt: { version: "0.9.121", from: "0.9.120", enabledBy: "alex", policyRevision: 1, journalId: null, outcome: null } });
    expect(reserveAutoUpdate(w.store, { version: "0.9.121", from: "0.9.120", now: T0 })).toEqual({ ok: false, why: "attempted" });
    expect(reserveAutoUpdate(w.store, { version: "0.9.122-beta.1", from: "0.9.120", now: T0 })).toEqual({ ok: false, why: "prerelease" });
    setAutoUpdatePolicy(w.store, false, "alex", T0);
    expect(reserveAutoUpdate(w.store, { version: "0.9.122", from: "0.9.120", now: T0 })).toEqual({ ok: false, why: "off" });
    setAutoUpdatePolicy(w.store, true, "alex", T0);
    // alex becomes project-limited: the standing yes no longer stands.
    w.store.handle.prepare("UPDATE approver SET projects_json = '[\"/elsewhere\"]' WHERE name = 'alex'").run();
    expect(reserveAutoUpdate(w.store, { version: "0.9.122", from: "0.9.120", now: T0 })).toEqual({ ok: false, why: "enabler-gone" });
    expect(autoUpdateAttempts(w.store)?.map(one => one.version)).toEqual(["0.9.121"]);
  });

  test("unreadable history or policy reserves nothing", () => {
    const w = world();
    w.store.handle.exec("DROP TRIGGER auto_update_attempt_no_delete; DROP TRIGGER auto_update_attempt_write_once; ALTER TABLE auto_update_attempt RENAME TO auto_update_attempt_gone");
    expect(reserveAutoUpdate(w.store, { version: "0.9.121", from: "0.9.120", now: T0 })).toEqual({ ok: false, why: "history-unreadable" });
    expect(autoUpdateAttempts(w.store)).toBeNull();
    w.store.handle.exec("ALTER TABLE auto_update_policy RENAME TO auto_update_policy_gone");
    expect(reserveAutoUpdate(w.store, { version: "0.9.121", from: "0.9.120", now: T0 })).toEqual({ ok: false, why: "policy-unreadable" });
  });
});

describe("recording how an attempt ended", () => {
  const reserved = (w: { store: Store }, version: string) => { const r = reserveAutoUpdate(w.store, { version, from: "0.9.120", now: T0 }); if (!r.ok) throw new Error(r.why); return r.attempt; };

  test.each([["restored", "restored"], ["refused", "refused"], ["cancelled", "cancelled"]] as const)("the journal's %s, once, with its ledger row", (phase, outcome) => {
    const w = world();
    const attempt = reserved(w, "0.9.121");
    const j = journal(w, "0.9.121");
    expect(linkAutoUpdateJournal(w.store, attempt.id, j.id)).toBe(true);
    expect(linkAutoUpdateJournal(w.store, attempt.id, j.id)).toBe(false);
    // Under way: nothing to record yet.
    save({ ...j, phase: "draining" });
    expect(reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.120", now: later(1000) })).toEqual([]);
    save({ ...j, phase, detail: "It didn't pass its health check.", ...(phase === "restored" ? { error: "Toolroll 0.9.121 did not pass its health check." } : {}) });
    const recorded = reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.120", now: later(2000) });
    expect(recorded.map(one => one.outcome)).toEqual([outcome]);
    expect(reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.120", now: later(3000) })).toEqual([]);
    expect(autoUpdateAttempts(w.store)?.[0]).toMatchObject({ outcome, detail: phase === "restored" ? "Toolroll 0.9.121 did not pass its health check." : "It didn't pass its health check." });
    expect(ledger(w.store)).toEqual([{ actor: "automatic update (turned on by alex)", outcome }]);
  });

  test("complete is recorded by the version it installed, not by an older one still running", () => {
    const w = world();
    const attempt = reserved(w, "0.9.121");
    const j = journal(w, "0.9.121", "complete");
    linkAutoUpdateJournal(w.store, attempt.id, j.id);
    expect(reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.120", now: later(1000) })).toEqual([]);
    expect(reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.121", now: later(1000) }).map(one => one.outcome)).toEqual(["complete"]);
  });

  test("a person's rollback since is recorded as rolled back; a later manual update reads the attempt's own stage copy", () => {
    const w = world();
    const attempt = reserved(w, "0.9.121");
    const j = journal(w, "0.9.121", "complete");
    linkAutoUpdateJournal(w.store, attempt.id, j.id);
    // The rollback replaced the saved journal and names the update it undid.
    save({ ...j, id: "f".repeat(8) + "-ffff-ffff-ffff-" + "f".repeat(12), kind: "rollback", phase: "complete", from: j.to, to: j.from, restoreFrom: { path: "/kept", hash: "0", updateId: j.id } });
    expect(reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.120", now: later(1000) })).toMatchObject([{ outcome: "rolled-back", detail: "Rolled back to 0.9.120." }]);
    // Another attempt, replaced by a later manual update: its own stage copy says how it ended.
    const second = reserved(w, "0.9.122");
    const k = journal(w, "0.9.122", "refused");
    linkAutoUpdateJournal(w.store, second.id, k.id);
    journal(w, "0.9.123");
    expect(reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.120", now: later(1000) })).toMatchObject([{ outcome: "refused" }]);
  });

  test("a reservation that never got a journal is settled as not started, only once it is stale; a lost record is unknown", () => {
    const w = world();
    reserved(w, "0.9.121");
    expect(reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.120", now: later(AUTO_UPDATE_STALE_MS - 1) })).toEqual([]);
    expect(reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.120", now: later(AUTO_UPDATE_STALE_MS) })).toMatchObject([{ outcome: "not-started" }]);
    const lost = reserved(w, "0.9.122");
    linkAutoUpdateJournal(w.store, lost.id, "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12));
    expect(reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.120", now: later(1000) })).toMatchObject([{ outcome: "unknown" }]);
  });

  test("an unreadable saved journal records nothing", () => {
    const w = world();
    const attempt = reserved(w, "0.9.121");
    const j = journal(w, "0.9.121", "refused");
    linkAutoUpdateJournal(w.store, attempt.id, j.id);
    writeFileSync(join(w.dir, "toolroll-update.json"), "{ not json");
    expect(reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.120", now: later(1000) })).toEqual([]);
    expect(autoUpdateAttempts(w.store)?.[0]?.outcome).toBeNull();
  });
});

describe("one update at a time, and Off", () => {
  const options = (w: { dir: string; databaseFile: string }, version: string) => ({ stateDir: w.dir, databaseFile: w.databaseFile, current: { version: "0.9.120", dist: join(w.dir, "dist") }, actor: "alex", version, when: "when-idle" as const });

  test("the reservation and the journal are made under the one prepare lock every caller takes; a second preparer is refused, not raced", () => {
    const w = world();
    let heldDuringReserve = false;
    const j = prepareRuntimeUpdate(options(w, "0.9.121"), T0, { reserve: () => { heldDuringReserve = lockHeld(prepareLockFile(w.dir)); return null; } });
    expect("refused" in j).toBe(false);
    expect(heldDuringReserve).toBe(true);
    expect(lockHeld(prepareLockFile(w.dir))).toBe(false);
    // Another preparer (another process) holds the lock: refused, nothing saved.
    save({ ...readRuntimeUpdate(w.dir)!, phase: "refused" });
    const other = sqliteLock(prepareLockFile(w.dir))!;
    try { expect(prepareRuntimeUpdate(options(w, "0.9.122"), T0, { lockWaitMs: 0 })).toEqual({ refused: "Another update is being prepared right now. Nothing was changed." }); }
    finally { other.close(); }
    expect(readRuntimeUpdate(w.dir)?.to.version).toBe("0.9.121");
  });

  test("any update under way blocks the next, manual or automatic; a refusing reservation saves no journal; a failed bind refuses the journal", () => {
    const w = world();
    const first = journal(w, "0.9.121");
    let reserved = 0;
    expect(prepareRuntimeUpdate(options(w, "0.9.122"), T0, { reserve: () => { reserved++; return null; } })).toMatchObject({ refused: expect.stringMatching(/^An update to 0.9.121 is already scheduled/) });
    expect(reserved).toBe(0);
    save({ ...first, phase: "refused" });
    expect(prepareRuntimeUpdate(options(w, "0.9.122"), T0, { reserve: () => "Automatic updates are off." })).toEqual({ refused: "Automatic updates are off." });
    expect(readRuntimeUpdate(w.dir)?.id).toBe(first.id);
    expect(prepareRuntimeUpdate(options(w, "0.9.122"), T0, { prepared: () => { throw new Error("the history can't be written"); } })).toEqual({ refused: "The update could not start: the history can't be written" });
    expect(readRuntimeUpdate(w.dir)).toMatchObject({ phase: "refused", to: { version: "0.9.122" } });
    // An unreadable saved journal refuses every new update.
    writeFileSync(join(w.dir, "toolroll-update.json"), "{ not json");
    expect("refused" in prepareRuntimeUpdate(options(w, "0.9.123"), T0)).toBe(true);
  });

  test("Off cancels the automatic update while that is safe, never a person's own update; past that point it says so", () => {
    const w = world();
    // A person's own update under way: Off leaves it alone.
    const manual = journal(w, "0.9.121");
    expect(cancelAutomaticUpdate(w.store, w.dir, T0)).toBeNull();
    expect(readRuntimeUpdate(w.dir)?.phase).toBe("scheduled");
    save({ ...manual, phase: "refused" });
    // The automatic one, not yet started by its updater: cancelled here.
    const reserved = reserveAutoUpdate(w.store, { version: "0.9.122", from: "0.9.120", now: T0 });
    if (!reserved.ok) throw new Error(reserved.why);
    const auto = journal(w, "0.9.122");
    linkAutoUpdateJournal(w.store, reserved.attempt.id, auto.id);
    expect(cancelAutomaticUpdate(w.store, w.dir, T0)).toBe("Cancelled the update to 0.9.122. Nothing was switched; new work resumes.");
    expect(readRuntimeUpdate(w.dir)?.phase).toBe("cancelled");
    expect(reconcileAutoUpdates(w.store, { stateDir: w.dir, current: "0.9.120", now: later(1000) }).map(one => one.outcome)).toEqual(["cancelled"]);
    // Another, already stopping the service: too late to cancel; it finishes or restores on its own.
    const third = reserveAutoUpdate(w.store, { version: "0.9.123", from: "0.9.120", now: T0 });
    if (!third.ok) throw new Error(third.why);
    const late = journal(w, "0.9.123", "backing-up");
    linkAutoUpdateJournal(w.store, third.attempt.id, late.id);
    expect(cancelAutomaticUpdate(w.store, w.dir, T0)).toBe("The update to 0.9.123 is past the point it can be cancelled (backing-up); it will finish or restore on its own.");
    expect(readRuntimeUpdate(w.dir)?.phase).toBe("backing-up");
  });

  test("an updater that finds its update cancelled before it started downloads nothing", async () => {
    const w = world();
    const j = journal(w, "0.9.121");
    writeFileSync(join(j.stageDir, "cancel-request.json"), JSON.stringify({ id: j.id, action: "cancel" }));
    let asked = 0;
    const system = { now: () => T0, sleep: async () => undefined, release: async () => { asked++; throw new Error("no registry in this test"); } } as unknown as UpdateSystem;
    const outcome = await resumeRuntimeUpdate(w.dir, system, j.id);
    expect(outcome).toMatchObject({ ok: true, phase: "cancelled" });
    expect(asked).toBe(0);
    expect(existsSync(join(j.stageDir, "runtime"))).toBe(false);
  });
});

describe("the decision", () => {
  const ON = { on: true, revision: 1, by: "alex", at: T0.toISOString() };
  const base: AutoUpdateFacts = { policy: ON, enablerStands: true, kind: "managed", current: "0.9.120", latest: "0.9.121", attempted: false, journal: "none" };
  test.each([
    ["on, managed, a newer stable release, never tried, nothing under way", {}, { go: true, version: "0.9.121" }],
    ["an earlier update finished", { journal: "terminal" }, { go: true, version: "0.9.121" }],
    ["off", { policy: { ...ON, on: false } }, { go: false, why: "off" }],
    ["a policy that can't be read", { policy: null }, { go: false, why: "policy-unreadable" }],
    ["the person who turned it on no longer stands", { enablerStands: false }, { go: false, why: "enabler-gone" }],
    ["an npm install", { kind: "npm" }, { go: false, why: "not-managed" }],
    ["a Homebrew install", { kind: "homebrew" }, { go: false, why: "not-managed" }],
    ["the desktop app", { kind: "desktop" }, { go: false, why: "not-managed" }],
    ["a source checkout", { kind: "source" }, { go: false, why: "not-managed" }],
    ["no release known (checks off or offline)", { latest: null }, { go: false, why: "no-release" }],
    ["a prerelease", { latest: "0.9.121-beta.1" }, { go: false, why: "prerelease" }],
    ["a nightly", { latest: "0.9.121-nightly.20261126" }, { go: false, why: "prerelease" }],
    ["the same version", { latest: "0.9.120" }, { go: false, why: "not-newer" }],
    ["an older version (never a downgrade)", { latest: "0.9.119" }, { go: false, why: "not-newer" }],
    ["tried before (failed, restored or rolled back)", { attempted: true }, { go: false, why: "attempted" }],
    ["history that can't be read", { attempted: null }, { go: false, why: "history-unreadable" }],
    ["an update under way (manual or automatic)", { journal: "active" }, { go: false, why: "update-active" }],
    ["a journal that can't be read", { journal: "unreadable" }, { go: false, why: "journal-unreadable" }],
  ] as [string, Partial<AutoUpdateFacts>, ReturnType<typeof autoUpdateDecision>][])("%s", (_name, change, want) => {
    expect(autoUpdateDecision({ ...base, ...change })).toEqual(want);
  });
});

describe("the pass", () => {
  const pass = (w: { dir: string; databaseFile: string; store: Store }, more: Partial<Parameters<typeof autoUpdatePass>[1]> = {}) => {
    const launched: string[] = [];
    const result = autoUpdatePass(w.store, { stateDir: w.dir, databaseFile: w.databaseFile, current: { version: "0.9.120", dist: join(w.dir, "dist") }, kind: "managed", latest: "0.9.121",
      now: () => T0, launch: async args => { launched.push(args.id); }, ...more });
    return { result, launched };
  };

  test("starts the prepared journal through the independent launcher once; a restart or a second pass never starts another", async () => {
    const w = world();
    const first = pass(w);
    const started = await first.result;
    expect(started).toMatchObject({ started: "0.9.121" });
    const j = readRuntimeUpdate(w.dir)!;
    expect(first.launched).toEqual([j.id]);
    expect(j).toMatchObject({ phase: "scheduled", when: "when-idle", at: null, actor: "automatic update (turned on by alex)", to: { version: "0.9.121" }, from: { version: "0.9.120" } });
    expect(autoUpdateAttempts(w.store)?.[0]).toMatchObject({ version: "0.9.121", journalId: j.id, launchedAt: T0.toISOString(), outcome: null, policyRevision: 1 });
    expect(ledger(w.store)).toEqual([{ actor: "automatic update (turned on by alex)", outcome: "started" }]);
    // The console restarted with the update still journaled: nothing new starts.
    const again = pass(w);
    expect(await again.result).toEqual({ held: "attempted" });
    expect(await pass(w, { latest: "0.9.122" }).result).toEqual({ held: "update-active" });
    expect(again.launched).toEqual([]);
  });

  test("a launch that fails refuses the journal and settles the attempt as not started; the version is not tried again", async () => {
    const w = world();
    expect(await pass(w, { launch: async () => { throw new Error("launchctl said no"); } }).result).toEqual({ failed: "The update could not start: launchctl said no", version: "0.9.121" });
    expect(readRuntimeUpdate(w.dir)).toMatchObject({ phase: "refused" });
    expect(autoUpdateAttempts(w.store)?.[0]).toMatchObject({ outcome: "not-started", detail: "The update could not start: launchctl said no" });
    expect(await pass(w).result).toEqual({ held: "attempted" });
    // A person can still update to it by hand: the manual road never reads the attempts.
    expect("refused" in prepareRuntimeUpdate({ stateDir: w.dir, databaseFile: w.databaseFile, current: { version: "0.9.120", dist: join(w.dir, "dist") }, actor: "alex", version: "0.9.121", when: "when-idle" }, T0)).toBe(false);
  });

  test("a crash after the reservation never makes the version eligible again", async () => {
    const w = world();
    // The console stopped between reserving and preparing.
    const reserved = reserveAutoUpdate(w.store, { version: "0.9.121", from: "0.9.120", now: T0 });
    expect(reserved.ok).toBe(true);
    expect(await pass(w).result).toEqual({ held: "attempted" });
    expect(readRuntimeUpdate(w.dir)).toBeNull();
    expect(await pass(w, { now: () => later(AUTO_UPDATE_STALE_MS) }).result).toEqual({ held: "attempted" });
    expect(autoUpdateAttempts(w.store)?.[0]).toMatchObject({ outcome: "not-started" });
  });

  test("off, unsupported installs, prereleases and old versions start nothing; a person's update under way holds it", async () => {
    const w = world();
    expect(await pass(w, { kind: "npm" }).result).toEqual({ held: "not-managed" });
    expect(await pass(w, { latest: "0.9.121-beta.1" }).result).toEqual({ held: "prerelease" });
    expect(await pass(w, { latest: "0.9.119" }).result).toEqual({ held: "not-newer" });
    journal(w, "0.9.121");
    expect(await pass(w, { latest: "0.9.122" }).result).toEqual({ held: "update-active" });
    setAutoUpdatePolicy(w.store, false, "alex", T0);
    expect(await pass(w).result).toEqual({ held: "off" });
    expect(autoUpdateAttempts(w.store)).toEqual([]);
  });
});

describe("what a person is told", () => {
  const notices = (store: Store) => store.handle.prepare("SELECT dedupe_key, subject, push_class FROM notification WHERE kind = 'auto-update' ORDER BY id").all().map(row => ({ ...row }));
  const run = (w: { dir: string; databaseFile: string; store: Store }, current: string, now = later(1000)) =>
    autoUpdatePass(w.store, { stateDir: w.dir, databaseFile: w.databaseFile, current: { version: current, dist: join(w.dir, "dist") }, kind: "managed", latest: null, now: () => now, launch: async () => undefined });

  test("each outcome is told to each instance operator once; a person's own cancel or rollback is not", async () => {
    const w = world();
    const reserved = reserveAutoUpdate(w.store, { version: "0.9.121", from: "0.9.120", now: T0 });
    if (!reserved.ok) throw new Error(reserved.why);
    const j = journal(w, "0.9.121", "restored", { error: "Toolroll 0.9.121 did not pass its health check." });
    linkAutoUpdateJournal(w.store, reserved.attempt.id, j.id);
    await run(w, "0.9.120");
    await run(w, "0.9.120");
    expect(notices(w.store)).toEqual([{ dedupe_key: "auto-update:0.9.121:restored:alex", push_class: "attention",
      subject: "Couldn't update to 0.9.121: Toolroll 0.9.121 did not pass its health check. Still on 0.9.120; its database was put back from the backup, so automatic updates are off until you turn them on again. It won't be tried again by itself; you can still update by hand." }]);
    const second = reserveAutoUpdate(w.store, { version: "0.9.122", from: "0.9.120", now: T0 });
    if (!second.ok) throw new Error(second.why);
    const k = journal(w, "0.9.122", "cancelled");
    linkAutoUpdateJournal(w.store, second.attempt.id, k.id);
    await run(w, "0.9.120");
    expect(notices(w.store)).toHaveLength(1);
  });

  test("a restore that needs a person is told once, as needing attention; an installed release is told with its notes", async () => {
    const w = world();
    const reserved = reserveAutoUpdate(w.store, { version: "0.9.121", from: "0.9.120", now: T0 });
    if (!reserved.ok) throw new Error(reserved.why);
    const j = journal(w, "0.9.121", "needs-attention");
    linkAutoUpdateJournal(w.store, reserved.attempt.id, j.id);
    await run(w, "0.9.120");
    await run(w, "0.9.120");
    expect(notices(w.store)).toMatchObject([{ dedupe_key: "auto-update:0.9.121:needs-attention:alex", push_class: "attention" }]);
    save({ ...readRuntimeUpdate(w.dir)!, phase: "complete" });
    await run(w, "0.9.121", new Date(2026, 10, 26, 3, 4));
    expect(notices(w.store)[1]).toEqual({ dedupe_key: "auto-update:0.9.121:complete:alex", subject: "Updated to 0.9.121 at 03:04 — what's new", push_class: null });
  });
});

describe("versions never tried again, whatever database is put back", () => {
  const run = (w: { dir: string; databaseFile: string; store: Store }, latest: string, current = "0.9.120", launch: (args: { id: string }) => Promise<void> = async () => undefined) =>
    autoUpdatePass(w.store, { stateDir: w.dir, databaseFile: w.databaseFile, current: { version: current, dist: join(w.dir, "dist") }, kind: "managed", latest, now: () => T0, launch });
  /** A database put back from before `version` was attempted: its row is gone (as a restore or rollback leaves it). */
  const restoredWithout = (store: Store, version: string) => {
    store.handle.exec("DROP TRIGGER auto_update_attempt_no_delete");
    store.handle.prepare("DELETE FROM auto_update_attempt WHERE version = ?").run(version);
  };

  test("A installs, automatic B fails, a rollback to A's backup drops B's row: the next pass still refuses B", async () => {
    const w = world();
    expect(await run(w, "0.9.121")).toMatchObject({ started: "0.9.121" });
    save({ ...readRuntimeUpdate(w.dir)!, phase: "complete" });
    expect(await run(w, "0.9.122", "0.9.121", async () => { throw new Error("launchctl said no"); })).toMatchObject({ failed: expect.any(String) });
    restoredWithout(w.store, "0.9.122");
    expect(await run(w, "0.9.122", "0.9.121")).toEqual({ held: "attempted" });
    expect(readRuntimeUpdate(w.dir)?.to.version).toBe("0.9.122");
  });

  test("a list beside the journal that can't be read holds every automatic update", async () => {
    const w = world();
    writeFileSync(join(w.dir, "toolroll-update.never-automatic.json"), "{ not json", { mode: 0o600 });
    expect(await run(w, "0.9.121")).toEqual({ held: "history-unreadable" });
    writeFileSync(join(w.dir, "toolroll-update.never-automatic.json"), "[]");
    chmodSync(join(w.dir, "toolroll-update.never-automatic.json"), 0o644);
    expect(await run(w, "0.9.121")).toEqual({ held: "history-unreadable" });
    expect(autoUpdateAttempts(w.store)).toEqual([]);
  });
});
