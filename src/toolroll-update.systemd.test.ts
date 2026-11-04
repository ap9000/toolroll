/**
 * `toolroll update` on Linux with the laptop service (toolroll-up.service), scripted end to end: systemctl, ps, the
 * controller's process identity and the console proof are seams; the unit lives in a temporary HOME. The update finds
 * the unit, stops it, proves the controller's recorded processes exited (by start identity), switches the unit to the
 * new runtime, starts it again and checks its health. Nothing reaches this machine's systemd.
 */
import { expect, test } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { machineSystem, type MachineSeams } from "./toolroll-update.js";
import { register } from "./runner.js";
import { credentialDigest, runnerProcessFile, sealRunnerProcessRecord, writeRunnerProcessRecord } from "./runner-process.js";
import { openStore } from "./store.js";
import { fixture, SERVICE_PID } from "../test/toolroll-update-kit.js";
import { fakePid } from "../test/fake-pid.js";

const HOST = "update-test-host";
const CONSOLE = fakePid(7), WORKER = fakePid(8);
const STARTED = "2026-11-03T09:00:00.000Z";

/** The laptop unit naming the fixture's runtime and database, a signed record of its controller, and scripted systemctl. */
function laptopWorld(f: ReturnType<typeof fixture>, options: { neverExits?: boolean; console?: boolean } = {}) {
  const home = join(f.root, "home");
  const unit = join(home, ".config", "systemd", "user", "toolroll-up.service");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(unit, `[Service]\nExecStart=/usr/bin/node ${f.oldDist}/bin.js up --laptop --no-open --db ${f.databaseFile} --port 45999\nRestart=always\n`);
  const store = openStore(f.databaseFile);
  try {
    register(store, { name: "laptop", host: HOST, now: new Date() });
    const holder = store.getRunner("laptop")!;
    const record = { v: 1 as const, runner: "laptop", host: HOST, registeredAt: holder.runner.registeredAt, credential: credentialDigest(holder.credentialHash),
      processes: [{ pid: SERVICE_PID, role: "up" as const, started: STARTED }, { pid: CONSOLE, role: "console" as const, started: STARTED }, { pid: WORKER, role: "worker" as const, started: STARTED }] };
    writeRunnerProcessRecord(runnerProcessFile(f.databaseFile, "laptop"), sealRunnerProcessRecord(record, holder.credentialHash));
  } finally { store.close(); }
  const live = new Set([SERVICE_PID, CONSOLE, WORKER]);
  const state = { active: true, log: [] as string[], proofs: [] as string[] };
  const ok = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
  const run = (async (file: string, args: readonly string[]) => {
    if (file === "pgrep") return { ...ok, code: 1 };
    state.log.push(`${file} ${args.join(" ")}`);
    if (args[1] === "show") return { ...ok, stdout: `MainPID=${state.active ? SERVICE_PID : 0}\n` };
    if (args[1] === "is-active") return { ...ok, code: state.active ? 0 : 3, stdout: state.active ? "active\n" : "inactive\n" };
    // systemctl returns once the stop is under way; the controller's processes leave a moment later (unless told not to).
    if (args[1] === "stop") { state.active = false; if (!options.neverExits) setTimeout(() => live.clear(), 5); }
    if (args[1] === "start") state.active = true;
    return ok;
  }) as unknown as NonNullable<MachineSeams["run"]>;
  const seams: MachineSeams = {
    platform: "linux", run, host: HOST, sleep: async () => { await new Promise(resolve => setTimeout(resolve, 1)); },
    probe: { exists: pid => (live.has(pid) ? "present" : "absent"), start: pid => (live.has(pid) ? STARTED : null) },
    alive: pid => live.has(pid),
    exec: (command, args) => command === "/bin/ps" ? { status: 0, stdout: `/usr/bin/node ${readFileSync(unit, "utf8").match(/ExecStart=\S+ (\S+)/)?.[1] ?? ""} up --laptop\n`, stderr: "" }
      : { status: 0, stdout: `${String(readFileSync(String(args[0]), "utf8")).replace("// ", "")}\n`, stderr: "" },
    consoleProof: async (databaseFile, version) => { state.proofs.push(`${databaseFile}@${version}`); return options.console !== false; },
  };
  const machine = machineSystem(home, {}, seams);
  return { unit, state, live, machine };
}

test("systemd: the laptop service is stopped, its controller proved gone by its record, switched, restarted and proved live", async () => {
  const f = fixture();
  try {
    const world = laptopWorld(f);
    const { machine } = world;
    expect(machine.serviceUnit(f.current)).toBe(world.unit);
    const outcome = await f.start({
      serviceUnit: machine.serviceUnit, watchUnits: machine.watchUnits, servicePids: machine.servicePids, serviceLoaded: machine.serviceLoaded,
      stopService: machine.stopService, restartService: machine.restartService, processAlive: machine.processAlive, healthy: machine.healthy,
    });
    expect(outcome.phase, outcome.message).toBe("complete");
    // Every process the controller's record named had exited before anything was replaced.
    expect(world.live.size).toBe(0);
    expect(world.state.log).toEqual([
      "systemctl --user show --property=MainPID toolroll-up.service",
      "systemctl --user show --property=MainPID toolroll-up.service",
      "systemctl --user stop toolroll-up.service",
      "systemctl --user daemon-reload",
      "systemctl --user start toolroll-up.service",
      "systemctl --user is-active toolroll-up.service",
      "systemctl --user show --property=MainPID toolroll-up.service",
    ]);
    // The unit now runs the new runtime, and its console answered at the new version.
    const text = readFileSync(world.unit, "utf8");
    expect(text).not.toContain(f.oldDist);
    expect(text).toContain("/node_modules/toolroll/dist/bin.js up --laptop");
    expect(world.state.proofs).toEqual([`${f.databaseFile}@0.7.0`]);
  } finally { f.close(); }
});

test("systemd: a controller whose recorded processes never exit is never written under", async () => {
  const f = fixture();
  try {
    const world = laptopWorld(f, { neverExits: true });
    const { machine } = world;
    const outcome = await f.start({
      serviceUnit: machine.serviceUnit, watchUnits: machine.watchUnits, servicePids: machine.servicePids, serviceLoaded: machine.serviceLoaded,
      stopService: machine.stopService, restartService: machine.restartService, processAlive: machine.processAlive, healthy: machine.healthy,
    });
    expect(outcome.phase).not.toBe("complete");
    expect(outcome.message).toContain(`still running (process ${SERVICE_PID}, ${CONSOLE}, ${WORKER})`);
    expect(readFileSync(world.unit, "utf8")).toContain(f.oldDist);
    expect(f.tasks()).toEqual(["T-1"]);
  } finally { f.close(); }
});

test("systemd: a restarted service whose console doesn't prove itself fails its health check", async () => {
  const f = fixture();
  try {
    const world = laptopWorld(f, { console: false });
    const { machine } = world;
    const outcome = await f.start({
      serviceUnit: machine.serviceUnit, watchUnits: machine.watchUnits, servicePids: machine.servicePids, serviceLoaded: machine.serviceLoaded,
      stopService: machine.stopService, restartService: machine.restartService, processAlive: machine.processAlive, healthy: machine.healthy,
    });
    expect(outcome.phase).not.toBe("complete");
    expect(world.state.proofs.length).toBeGreaterThan(0);
    // Put back as it was: the unit names the previous runtime again.
    expect(readFileSync(world.unit, "utf8")).toContain(f.oldDist);
  } finally { f.close(); }
});
