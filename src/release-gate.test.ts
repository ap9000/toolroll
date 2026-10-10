import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { installUpdateGate, updateAdmissionPaused } from "./desktop-update-gate.js";
import { gateOwner, proveBeforeSwap, releaseGate, type GateReleaseWorld } from "./release-gate.js";
import { openStore, SCHEMA_VERSION, type Database } from "./store.js";
import { fakePid } from "../test/fake-pid.js";
import { deploymentChild } from "../test/deploy-process.js";
import { acquireDeploymentLock } from "./deploy-lock.js";

const ID = "0f1e2d3c-4b5a-4968-8776-655443322110", OTHER_ID = "11111111-2222-4333-8444-555555555555";

/** A paused installation: its database (owned by ID), one deployment stage, the service definition and processes. */
function paused(phase = "preparing") {
  const state = mkdtempSync(join(tmpdir(), "so-release-gate-"));
  const database = join(state, "orders.db");
  openStore(database).close();
  const db = new DatabaseSync(database) as unknown as Database;
  try { installUpdateGate(db, ID); } finally { db.close(); }
  const prior = join(state, "staged-upgrades", "browser-old", "runtime", "node_modules", "toolroll", "dist");
  const stage = join(state, "staged-upgrades", "browser-new-1");
  const next = join(stage, "runtime", "node_modules", "toolroll", "dist");
  mkdirSync(prior, { recursive: true }); mkdirSync(stage, { recursive: true });
  const plist = `<plist><array><string>/usr/bin/node</string><string>${prior}/cli.js</string><string>serve</string></array></plist>`;
  const journal: Record<string, unknown> = { id: ID, phase, database, schema: SCHEMA_VERSION, nextSchema: SCHEMA_VERSION, priorRuntime: prior, nextRuntime: next, candidate: "a".repeat(40) };
  const writeJournal = () => writeFileSync(join(stage, "deployment.json"), JSON.stringify(journal));
  writeJournal();
  const w = {
    state, database, stage, prior, next, journal, writeJournal,
    plists: [{ path: join(state, "com.toolroll.browser.plist"), text: plist }],
    processes: [
      { pid: fakePid(1), command: `/usr/bin/node ${prior}/controller-service.js` },
      { pid: fakePid(2), command: `/usr/bin/node ${prior}/cli.js up --db ${database} --runner local` },
    ],
  };
  const world: GateReleaseWorld = {
    database, stateDir: state, now: () => new Date("2026-10-09T12:00:00.000Z"),
    open: () => new DatabaseSync(database) as unknown as Database,
    servicePlists: () => w.plists, processes: () => w.processes,
  };
  return { ...w, world };
}
const stillPaused = (database: string) => {
  const db = new DatabaseSync(database, { readOnly: true }) as unknown as Database;
  try { return gateOwner(db); } finally { db.close(); }
};

describe("toolroll release --release-gate", () => {
  test.each(["preparing", "admission-paused", "frozen", "backup-verified", "rehearsed"])("proves a pause left at %s, before the swap, and lifts only that one with --yes", phase => {
    const p = paused(phase);
    writeFileSync(join(p.stage, "browser.saved.plist"), p.plists[0]!.text);
    const shown = releaseGate(ID, p.world, false);
    expect(shown).toMatchObject({ ok: true, released: false, stage: p.stage });
    expect(shown.ok && shown.proof.join("\n")).toContain(`stopped at ${phase}, before the swap`);
    expect(stillPaused(p.database)).toBe(ID);
    expect(existsSync(join(p.stage, "deployment.json.lock.sqlite"))).toBe(false);

    expect(releaseGate(ID, p.world, true)).toMatchObject({ ok: true, released: true });
    const db = new DatabaseSync(p.database, { readOnly: true }) as unknown as Database;
    try { expect(updateAdmissionPaused(db)).toBe(false); } finally { db.close(); }
    expect(JSON.parse(readFileSync(join(p.stage, "deployment.json"), "utf8"))).toMatchObject({ id: ID, phase: "released", releasedBeforeSwap: { from: phase, by: "toolroll release --release-gate" } });
  });

  const refusals: [string, string, (p: ReturnType<typeof paused>) => void][] = [
    ["a journal naming another update", "no-journal", p => { p.journal["id"] = OTHER_ID; p.writeJournal(); }],
    ["no journal", "no-journal", p => { rmSync(join(p.stage, "deployment.json")); }],
    ["a damaged journal", "damaged", p => { writeFileSync(join(p.stage, "deployment.json"), "{\"id\": \"0f1e"); }],
    ["a journal missing its runtimes", "damaged", p => { delete p.journal["priorRuntime"]; p.writeJournal(); }],
    ["two journals naming the id", "conflict", p => { mkdirSync(join(p.state, "staged-upgrades", "browser-new-2")); writeFileSync(join(p.state, "staged-upgrades", "browser-new-2", "deployment.json"), JSON.stringify(p.journal)); }],
    ["a journal past the swap", "after-swap", p => { p.journal["phase"] = "stopping"; p.writeJournal(); }],
    ["a released journal with the pause still held", "after-swap", p => { p.journal["phase"] = "released"; p.writeJournal(); }],
    ["a pre-swap phase that records a stop", "conflict", p => { p.journal["stoppingService"] = { supervisor: fakePid(1), children: [fakePid(2)] }; p.writeJournal(); }],
    ["a pre-swap phase that records a migration", "conflict", p => { p.journal["migration"] = { from: 1, to: 2 }; p.writeJournal(); }],
    ["a staged new service definition", "conflict", p => { writeFileSync(join(p.stage, "browser.next.plist"), ""); }],
    ["a migrated database", "conflict", p => { p.journal["schema"] = SCHEMA_VERSION - 1; p.writeJournal(); }],
    ["another database", "conflict", p => { p.journal["database"] = "/elsewhere/orders.db"; p.writeJournal(); }],
    ["a service definition naming the staged runtime", "conflict", p => { p.plists[0]!.text = p.plists[0]!.text.replaceAll(p.prior, p.next); }],
    ["a definition that differs from the saved one", "conflict", p => { writeFileSync(join(p.stage, "browser.saved.plist"), "<plist>older</plist>"); }],
    ["no service definition", "conflict", p => { p.plists.length = 0; }],
    ["a service that is not running", "conflict", p => { p.processes.length = 0; }],
    ["a process running from the staged runtime", "after-swap", p => { p.processes.push({ pid: fakePid(3), command: `/usr/bin/node ${p.next}/controller-service.js` }); }],
    ["a deployment still running", "deploying", p => { p.processes.push({ pid: fakePid(4), command: `node scripts/deploy-browser.mjs --run 7 --stage ${p.stage} --yes` }); }],
  ];
  test.each(refusals)("refuses %s and leaves the pause", (_what, reason, change) => {
    const p = paused();
    change(p);
    for (const yes of [false, true]) expect(releaseGate(ID, p.world, yes)).toMatchObject({ ok: false, reason, message: expect.stringContaining("left as it is") });
    expect(stillPaused(p.database)).toBe(ID);
  });

  test("refuses an id that isn't an update id, another update's id, and a database with no pause", () => {
    const p = paused();
    expect(proveBeforeSwap("release-0.9.54-abc1234", p.world)).toMatchObject({ ok: false, reason: "usage" });
    expect(releaseGate(OTHER_ID, p.world, true)).toMatchObject({ ok: false, reason: "not-owner", message: expect.stringContaining(`belongs to ${ID}`) });
    expect(stillPaused(p.database)).toBe(ID);
    const fresh = mkdtempSync(join(tmpdir(), "so-release-gate-"));
    openStore(join(fresh, "orders.db")).close();
    expect(proveBeforeSwap(ID, { ...p.world, database: join(fresh, "orders.db"), stateDir: fresh, open: () => new DatabaseSync(join(fresh, "orders.db")) as unknown as Database })).toMatchObject({ ok: false, reason: "not-paused" });
    expect(existsSync(join(fresh, "staged-upgrades"))).toBe(false);
  });

  test("a guided release racing a deploy waits for exclusion and refuses its newly starting phase", async () => {
    const p = paused(), journal = join(p.stage, "deployment.json");
    const deploy = deploymentChild(`
      import { acquireDeploymentLock } from ${JSON.stringify(new URL("../dist/deploy-lock.js", import.meta.url).href)};
      import { readFileSync, writeFileSync } from 'node:fs';
      const file = ${JSON.stringify(journal)}, lock = acquireDeploymentLock(file);
      process.on('message', () => {
        const r = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, JSON.stringify({ ...r, phase: 'starting' }));
        lock.release(); process.disconnect();
      });
      process.send('held');`);
    try {
      expect(await deploy.message()).toBe("held");
      let observed = false;
      p.world.processes = () => {
        if (!observed) { observed = true; deploy.child.send("advance"); }
        return p.processes;
      };
      expect(releaseGate(ID, p.world, true)).toMatchObject({ ok: false, reason: "after-swap" });
      expect((await deploy.closed).code).toBe(0);
      expect(stillPaused(p.database)).toBe(ID);
      expect(JSON.parse(readFileSync(journal, "utf8")).phase).toBe("starting");
    } finally { await deploy.stop(); rmSync(p.state, { recursive: true, force: true }); }
  });

  test("release holds exclusion through repeated proof and refuses service or phase changes at removal", () => {
    for (const change of ["service", "journal", "none"]) {
      const p = paused(), journal = join(p.stage, "deployment.json");
      let proofs = 0;
      p.world.processes = () => {
        proofs++;
        if (proofs > 1) expect(() => acquireDeploymentLock(journal, 0)).toThrow("busy");
        if (proofs === 2 && change === "service") p.plists[0]!.text = p.plists[0]!.text.replaceAll(p.prior, p.next);
        if (proofs === 3 && change === "journal") { p.journal["phase"] = "starting"; p.writeJournal(); }
        return p.processes;
      };
      try {
        expect(releaseGate(ID, p.world, true).ok).toBe(change === "none");
        expect(stillPaused(p.database)).toBe(change === "none" ? null : ID);
        acquireDeploymentLock(journal, 0).release();
      } finally { rmSync(p.state, { recursive: true, force: true }); }
    }
  });

  test("SIGKILL leaves an owned gate that one guided command can safely release", async () => {
    const p = paused(), journal = join(p.stage, "deployment.json");
    const deploy = deploymentChild(`
      import { acquireDeploymentLock } from ${JSON.stringify(new URL("../dist/deploy-lock.js", import.meta.url).href)};
      const lock = acquireDeploymentLock(${JSON.stringify(journal)});
      process.on('message', () => {});
      process.send('held');`);
    try {
      expect(await deploy.message()).toBe("held");
      await deploy.stop();
      expect((await deploy.closed).signal).toBe("SIGKILL");
      expect(stillPaused(p.database)).toBe(ID);
      expect(releaseGate(ID, p.world, true)).toMatchObject({ ok: true, released: true });
      expect(stillPaused(p.database)).toBeNull();
      expect(JSON.parse(readFileSync(journal, "utf8"))).toMatchObject({ phase: "released", releasedBeforeSwap: { from: "preparing" } });
    } finally { await deploy.stop(); rmSync(p.state, { recursive: true, force: true }); }
  });
});
