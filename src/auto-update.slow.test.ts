/**
 * An automatic update end to end, through the same scripted updater the manual road's tests drive
 * (test/toolroll-update-kit.ts: a stand-in registry and a fixture-signed provenance, scripted service, no network):
 * the pass reserves the version, prepares its journal and launches the independent job (here, the job's own resume of
 * that journal id), which verifies, drains, backs up, rehearses, switches and checks health; the new version records
 * it as complete. A release whose provenance names another repository is refused before anything changes, and a failed
 * health check restores the previous version and database — each recorded once, never attempted automatically again,
 * while a person can still update by hand.
 */
import { test, expect } from "vitest";
import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { autoUpdateAttempts, autoUpdatePass, reconcileAutoUpdates, setAutoUpdatePolicy } from "./auto-update.js";
import { prepareRuntimeUpdate, readRuntimeUpdate, resumeRuntimeUpdate, startRuntimeRollback, type UpdateSystem } from "./toolroll-update.js";
import { failingHealth, fixture, provenance } from "../test/toolroll-update-kit.js";
import { runUpdateCommand } from "./toolroll-update-cli.js";
import { autoUpdatePolicy } from "./auto-update.js";

type Fixture = ReturnType<typeof fixture>;
/** The console's store with automatic updates turned on by alex. */
function turnedOn(f: Fixture): Store {
  const store = openStore(f.databaseFile);
  const alex = addApprover(store, "alex", f.system.now());
  if (!alex.ok) throw new Error("alex");
  setAutoUpdatePolicy(store, true, "alex", f.system.now());
  return store;
}
/** One pass; the launcher starts the job (the journal's own resume) the way launchd would: apart from the pass. */
async function passOnce(f: Fixture, store: Store, system: UpdateSystem = f.system) {
  let job: Promise<unknown> | null = null;
  const result = await autoUpdatePass(store, { stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, kind: "managed", latest: "0.7.0", now: () => system.now(),
    launch: async args => { job = resumeRuntimeUpdate(f.stateDir, system, args.id); } });
  if (job !== null) await job;
  return result;
}

test("a newer release installs by itself through the verified, journaled update, and the new version records it", async () => {
  const f = fixture();
  let store = turnedOn(f);
  try {
    expect(await passOnce(f, store)).toMatchObject({ started: "0.7.0" });
    const j = readRuntimeUpdate(f.stateDir)!;
    expect(j).toMatchObject({ phase: "complete", actor: "automatic update (turned on by alex)", package: { repository: "https://github.com/ap9000/toolroll", workflow: ".github/workflows/publish.yml" } });
    expect(f.calls).toEqual(["install", "stop", "rehearse", "restart", "health"]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(j.to.dist, "bin.js"));
    // The console restarts on 0.7.0 and its first pass settles the attempt.
    store.close(); store = openStore(f.databaseFile);
    expect(reconcileAutoUpdates(store, { stateDir: f.stateDir, current: "0.7.0", now: f.system.now() }).map(one => one.outcome)).toEqual(["complete"]);
    expect(f.ledger().map(e => [e.action, e.outcome, e.actor])).toEqual([
      ["toolroll automatic update", "started", "automatic update (turned on by alex)"],
      ["toolroll updated", "complete", "automatic update (turned on by alex)"],
      ["toolroll automatic update", "complete", "automatic update (turned on by alex)"],
    ]);
    // `toolroll update --status` reads the switch and the last attempt; it changes nothing.
    const lines: string[] = [];
    expect(await runUpdateCommand(["--status"], line => lines.push(line), { databaseFile: f.databaseFile })).toBe(0);
    expect(lines.slice(1)).toEqual(["Automatic updates: on (turned on by alex). Change it in Settings → Updates.", expect.stringMatching(/^Last automatic update: Updated to 0\.7\.0 at \d\d:\d\d\.$/)]);
    expect(autoUpdatePolicy(store)).toMatchObject({ on: true, revision: 1 });
  } finally { store.close(); f.close(); }
});

test("a release built by another repository is refused before anything changes, and is not tried again", async () => {
  const f = fixture();
  let store = turnedOn(f);
  try {
    const system = { ...f.system, attestations: async () => provenance({ certificate: { repository: "https://github.com/someone/else" } }) };
    expect(await passOnce(f, store, system)).toMatchObject({ started: "0.7.0" });
    expect(readRuntimeUpdate(f.stateDir)).toMatchObject({ phase: "refused" });
    expect(f.calls).toEqual([]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    store.close(); store = openStore(f.databaseFile);
    expect(reconcileAutoUpdates(store, { stateDir: f.stateDir, current: "0.6.0", now: f.system.now() })).toMatchObject([{ outcome: "refused", detail: expect.stringContaining("not ap9000/toolroll") }]);
    expect(await passOnce(f, store, system)).toEqual({ held: "attempted" });
  } finally { store.close(); f.close(); }
});

test("a failed health check restores the previous version and database on its own; recorded once, never retried automatically, a person may retry", async () => {
  const f = fixture();
  let store = turnedOn(f);
  try {
    const system = { ...f.system, ...failingHealth(f), healthy: async () => false };
    expect(await passOnce(f, store, system)).toMatchObject({ started: "0.7.0" });
    expect(readRuntimeUpdate(f.stateDir)).toMatchObject({ phase: "restored" });
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    // The restored database still holds the reservation (it was made before the backup).
    store.close(); store = openStore(f.databaseFile);
    expect(autoUpdateAttempts(store)?.map(one => one.version)).toEqual(["0.7.0"]);
    // …and comes back with automatic updates off, until a person turns them on again.
    expect(autoUpdatePolicy(store)).toMatchObject({ on: false, revision: 2 });
    expect(reconcileAutoUpdates(store, { stateDir: f.stateDir, current: "0.6.0", now: f.system.now() })).toMatchObject([{ outcome: "restored", detail: expect.stringContaining("did not pass its health check") }]);
    expect(await passOnce(f, store)).toEqual({ held: "off" });
    setAutoUpdatePolicy(store, true, "alex", f.system.now());
    expect(await passOnce(f, store)).toEqual({ held: "attempted" });
    expect(f.tasks()).toEqual(["T-1"]);
    // A person's manual retry is still theirs to make.
    expect("refused" in prepareRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, actor: "alex", version: "0.7.0", when: "when-idle" }, f.system.now())).toBe(false);
  } finally { store.close(); f.close(); }
});

test("a rollback puts back a backup taken while automatic updates were on: they come back off, so a later Off is never undone", async () => {
  const f = fixture();
  let store = turnedOn(f);
  try {
    expect(await passOnce(f, store)).toMatchObject({ started: "0.7.0" });
    store.close(); store = openStore(f.databaseFile);
    setAutoUpdatePolicy(store, false, "alex", f.system.now());
    store.close();
    expect(await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: readRuntimeUpdate(f.stateDir)!.to, actor: "alex", when: "when-idle" }, f.system)).toMatchObject({ ok: true, phase: "complete" });
    store = openStore(f.databaseFile);
    expect(autoUpdatePolicy(store)?.on).toBe(false);
    expect(store.handle.prepare("SELECT actor, outcome, detail FROM action_ledger WHERE action = 'automatic updates' ORDER BY id DESC LIMIT 1").get()).toEqual({ actor: "alex", outcome: "off", detail: "a database backup was put back: off until a person turns them on again" });
  } finally { store.close(); f.close(); }
});

test("a version a person installed by hand and then rolled back is never installed again automatically", async () => {
  const f = fixture();
  let store: Store | null = null;
  try {
    const update = await f.start();
    expect(update).toMatchObject({ ok: true, phase: "complete" });
    expect(await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system)).toMatchObject({ ok: true, phase: "complete" });
    store = turnedOn(f);
    expect(await passOnce(f, store)).toEqual({ held: "attempted" });
    expect(readRuntimeUpdate(f.stateDir)).toMatchObject({ kind: "rollback", phase: "complete" });
  } finally { store?.close(); f.close(); }
});
