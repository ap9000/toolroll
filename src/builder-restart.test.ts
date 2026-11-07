/**
 * P2.3 must-refuse rules, against the real store, a temporary HOME and a scripted supervisor: Toolroll restarts its own
 * service only on a recorded wish to run, never after `background off` or `stop`, during an update or drain, while the
 * process lives, on an identity mismatch, or past its attempts, and it never enables a disabled label.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, reportLifecycle, type Store } from "./store.js";
import { register, workerComponent } from "./runner.js";
import { admitBuilderRestart, databaseFormat, recordBuilderWish, RESTART_LIMIT, RESTART_WINDOW_MS } from "./builder-restart.js";
import { backgroundOff, laptopStop, restartOwnBuilder, type LaptopSeams } from "./laptop-background.js";
import { laptopServiceDefinition, LAPTOP_LABEL_DARWIN } from "./laptop-service.js";
import { RUNNER_PROCESS_DIR, runnerProcessFile, sealRunnerProcessRecord, writeRunnerProcessRecord, credentialDigest } from "./runner-process.js";
import type { SupervisorRunner } from "./daemon.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const BUILD = "1.2.3";
const ok = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

let dir: string, file: string, store: Store;
/** A launchd that answers for a loaded label, or says it's gone. */
let launchd: { loaded: boolean; running: boolean; disabled: boolean; log: string[] };

const supervisor = (async (name: string, args: readonly string[]) => {
  launchd.log.push([name, ...args].join(" "));
  if (name !== "launchctl") return { ...ok, code: 1 };
  if (args[0] === "print") return launchd.loaded ? { ...ok, stdout: launchd.running ? "\tstate = running\n\tpid = 4242\n" : "\tstate = not running\n" } : { ...ok, code: 113 };
  if (args[0] === "print-disabled") return { ...ok, stdout: `disabled services = {\n\t"${LAPTOP_LABEL_DARWIN}" => ${launchd.disabled ? "disabled" : "enabled"}\n}\n` };
  return ok;
}) as unknown as SupervisorRunner;

const seams = (extra: Partial<LaptopSeams> = {}): LaptopSeams => ({
  platform: "darwin", home: dir, supervisor, host: "fixture-host", proveConsole: async () => ({ ok: false, state: "none", message: "" }),
  probe: { exists: () => "absent", start: () => null }, buildAt: () => BUILD, ...extra,
});

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-restart-")));
  file = join(dir, "orders.db");
  store = openStore(file);
  launchd = { loaded: false, running: false, disabled: false, log: [] };
  const definition = laptopServiceDefinition({ platform: "darwin", home: dir, node: "/usr/local/bin/node", dist: join(dir, "pkg", "dist"), db: file, port: 4100, pathEnv: "/usr/bin" });
  if ("error" in definition) throw new Error(definition.error);
  mkdirSync(join(dir, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(definition.path, definition.text);
  // The recorded runtime: one runner on this computer, whose processes the probe proves gone.
  register(store, { name: "laptop", host: "fixture-host", capacity: 1, repos: [], now: NOW, newToken: () => "tok" });
  const holder = store.getRunner("laptop")!;
  mkdirSync(join(dir, RUNNER_PROCESS_DIR), { recursive: true, mode: 0o700 });
  writeRunnerProcessRecord(runnerProcessFile(file, "laptop"), sealRunnerProcessRecord({ v: 1, runner: "laptop", host: "fixture-host", registeredAt: holder.runner.registeredAt, credential: credentialDigest(holder.credentialHash),
    processes: [{ pid: 4_200_001, role: "up", started: "2026-11-06T11:00:00.000Z" }] }, holder.credentialHash));
  recordBuilderWish(store, "running", "up", BUILD, NOW);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const restart = (extra: Partial<LaptopSeams> = {}, at = NOW) => restartOwnBuilder(store, file, seams(extra), at);
const started = () => launchd.log.filter(line => /bootstrap|kickstart|enable/.test(line));

describe("restarting", () => {
  test("a recorded wish, a proven exit and the same build: it starts, and never enables anything", async () => {
    expect(await restart()).toEqual({ restarted: true });
    expect(started()).toHaveLength(1);
    expect(started()[0]).toContain("bootstrap");
    expect(launchd.log.some(line => / enable /.test(line))).toBe(false);
  });

  test("loaded but exited: kickstart", async () => {
    launchd.loaded = true;
    expect(await restart()).toEqual({ restarted: true });
    expect(started()[0]).toContain("kickstart");
  });
});

describe("must refuse", () => {
  test("after `background off`, even with the unit left behind", async () => {
    await backgroundOff(store, file, seams());
    writeFileSync(join(dir, "Library", "LaunchAgents", `${LAPTOP_LABEL_DARWIN}.plist`), "<plist/>");
    expect(await restart()).toMatchObject({ restarted: false });
    expect(started()).toEqual([]);
  });

  test("after `stop`", async () => {
    await laptopStop(store, file, seams());
    expect(await restart()).toMatchObject({ restarted: false, reason: "not-wanted" });
    expect(started()).toEqual([]);
  });

  test("with no recorded wish at all", async () => {
    store.handle.prepare("DELETE FROM builder_service").run();
    expect(await restart()).toMatchObject({ restarted: false, reason: "not-wanted" });
  });

  test("during an update or a drain", async () => {
    store.handle.exec("CREATE TRIGGER so_desktop_update_gate BEFORE INSERT ON claim BEGIN SELECT RAISE(ABORT, 'paused'); END");
    expect(await restart()).toMatchObject({ restarted: false, reason: "paused" });
    store.handle.exec("DROP TRIGGER so_desktop_update_gate");
    reportLifecycle(store, workerComponent("laptop"), "started", store.getRunner("laptop")!.runner.registeredAt, NOW);
    reportLifecycle(store, workerComponent("laptop"), "draining", store.getRunner("laptop")!.runner.registeredAt, NOW, { drainUntil: new Date(NOW.getTime() + 60_000) });
    expect(await restart()).toMatchObject({ restarted: false, reason: "paused" });
    expect(started()).toEqual([]);
  });

  test("while the process lives: the console answers, the supervisor runs it, or a recorded pid is alive", async () => {
    expect(await restart({ proveConsole: async () => ({ ok: true, url: "http://127.0.0.1:4100", port: 4100, pid: 1 }) as never })).toMatchObject({ reason: "running" });
    launchd.loaded = true; launchd.running = true;
    expect(await restart()).toMatchObject({ reason: "running" });
    launchd.running = false;
    expect(await restart({ probe: { exists: () => "present", start: () => "2026-11-06T11:00:00.000Z" } })).toMatchObject({ reason: "unproven" });
    expect(started()).toEqual([]);
  });

  test("when nothing proves the old process gone", async () => {
    rmSync(runnerProcessFile(file, "laptop"));
    expect(await restart()).toMatchObject({ restarted: false, reason: "unproven" });
    expect(await restart({ proveConsole: async () => ({ ok: false, state: "refused", message: "not ours" }) })).toMatchObject({ reason: "unproven" });
  });

  test("on an identity mismatch: another build, an unreadable one, or another database format", async () => {
    expect(await restart({ buildAt: () => "9.9.9" })).toMatchObject({ reason: "identity" });
    expect(await restart({ buildAt: () => null })).toMatchObject({ reason: "identity" });
    store.handle.prepare("UPDATE builder_service SET schema_version = ?").run((databaseFormat(store) ?? 0) - 1);
    expect(await restart()).toMatchObject({ reason: "identity" });
    expect(started()).toEqual([]);
  });

  test("a disabled label stays disabled", async () => {
    launchd.disabled = true;
    expect(await restart()).toMatchObject({ reason: "disabled" });
    expect(started()).toEqual([]);
  });

  test("past the attempt cap, and the cap counts tries that came to nothing", async () => {
    for (let one = 0; one < RESTART_LIMIT; one++) expect(await restart()).toEqual({ restarted: true });
    expect(await restart()).toMatchObject({ restarted: false, reason: "attempts" });
    expect(started()).toHaveLength(RESTART_LIMIT);
    expect(await restart({}, new Date(NOW.getTime() + RESTART_WINDOW_MS + 1))).toEqual({ restarted: true });
  });

  test("concurrent restarts can't both take the last attempt", () => {
    const other = openStore(file);
    try {
      for (let one = 0; one < RESTART_LIMIT - 1; one++) expect(admitBuilderRestart(store, NOW)).toBe("admitted");
      expect(admitBuilderRestart(store, NOW)).toBe("admitted");
      expect(admitBuilderRestart(other, NOW)).toBe("attempts");
    } finally { other.close(); }
  });
});
