/**
 * Automatic updates' durable state (auto-update.ts): one reservation per version, made atomically with the checks that
 * allow it, and each attempt's outcome read from the update's own journal and recorded once with its ledger row —
 * restored, refused, cancelled, rolled back by a person, never started, or no longer on this computer. Unreadable
 * history or journals record nothing and reserve nothing. Isolated temp stores and state folders; no updater runs.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableJson } from "./desktop-update.js";
import { addApprover } from "./scope.js";
import { openStore, type Store } from "./store.js";
import { prepareRuntimeUpdate, readRuntimeUpdate, type RuntimeUpdateJournal } from "./toolroll-update.js";
import { autoUpdateAttempts, linkAutoUpdateJournal, reconcileAutoUpdates, reserveAutoUpdate, setAutoUpdatePolicy, AUTO_UPDATE_STALE_MS } from "./auto-update.js";

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
