/**
 * Stopping what an old service left running (scripts/deploy-stop.mjs, the 2026-10-29 deploy): only processes proved,
 * by exact runtime path and argv, to be that service's supervisor, `up` or role child are ever signalled, and anything
 * that names the service but can't be proved refuses the whole stop. Real processes: a stuck `up` that ignores
 * SIGTERM, orphaned by a supervisor that exited, as in the incident.
 */
import { test, expect, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, listProcesses, serviceProcesses, serviceStopper, stopServiceProcesses } from "../scripts/deploy-stop.mjs";

type Row = { pid: number; ppid: number; start: string; command: string };
const node = process.execPath;
const dists = ["/state/staged-upgrades/a/runtime/node_modules/toolroll/dist", "/state/staged-upgrades/b/runtime/node_modules/toolroll/dist"];
const [prior, next] = dists as [string, string];
const database = "/state/orders.db";

test.each([
  [`${node} ${prior}/controller-service.js ${node} ${prior}/cli.js up --db ${database} --port 4180`, "supervisor"],
  [`${node} ${prior}/cli.js up --db ${database} --port 4180 --runner mac`, "up"],
  [`${node} ${next}/cli.js up --db ${database}`, "up"],
  [`${node} ${prior}/up-role-child.js worker`, "role"],
  [`${node} ${prior}/up-role-child.js console`, "role"],
  // The same runtime on another database (a sandbox or second install): provably not this service.
  [`${node} ${prior}/cli.js up --db /tmp/demo/orders.db --port 4999`, "foreign"],
  // Another runtime on this database, a shell wrapping it, an extra argument, a near-miss path: never proved, so refused.
  [`${node} /old/toolroll/dist/cli.js up --db ${database}`, "named"],
  [`/bin/sh -c ${node} ${prior}/cli.js up --db ${database}`, "named"],
  [`${node} ${prior}/up-role-child.js worker --extra`, "named"],
  [`${node} ${prior}/cli.js up --db ${database}.coding.sqlite`, "named"],
  // Unrelated: nothing of these runtimes or this database.
  [`${node} ${prior}2/cli.js status`, null],
  [`/usr/bin/vim notes.txt`, null],
] as const)("classify %s → %s", (command, kind) => {
  expect(classify(command, { dists, database })?.kind ?? null).toBe(kind);
});

test("a role child is the service's only under one of its own `up`s or when the journal recorded it", () => {
  const row = (pid: number, ppid: number, command: string): Row => ({ pid, ppid, start: "Thu Oct 29 13:00:00 2026", command });
  const rows = [
    row(100, 1, `${node} ${prior}/controller-service.js ${node} ${prior}/cli.js up --db ${database}`),
    row(101, 1, `${node} ${prior}/cli.js up --db ${database}`),
    row(102, 101, `${node} ${prior}/up-role-child.js worker`),
    row(200, 1, `${node} ${prior}/cli.js up --db /tmp/demo/orders.db`),
    row(201, 200, `${node} ${prior}/up-role-child.js worker`),
    row(300, 1, `${node} ${prior}/up-role-child.js console`),
  ];
  const found = serviceProcesses(rows, { dists, database, self: 1 });
  expect(found.targets.map(one => one.pid)).toEqual([100, 101, 102]);
  expect(found.unproven.map(one => one.pid)).toEqual([300]);
  expect(serviceProcesses(rows, { dists, database, recorded: [300], self: 1 }).targets.map(one => one.pid)).toEqual([100, 101, 102, 300]);
});

// ---- real processes ---------------------------------------------------------------------------------------------

let root: string;
const started: ChildProcess[] = [];
afterEach(() => {
  // Kill anything a test started, whatever happened.
  for (const pid of ours()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const child of started.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});
/** Every process whose command names this test's folder. */
function ours(): number[] {
  if (root === undefined) return [];
  return (listProcesses(spawnSync) ?? []).filter(row => row.command.includes(root)).map(row => row.pid);
}

/** A fake runtime whose entries behave like the incident's: `up` and its role ignore SIGTERM; the supervisor forwards
 * SIGTERM to `up` and exits at once, leaving it running without a parent. */
function runtime(name: string): string {
  const dist = join(root, name, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "controller-service.js"), `
    const { spawn } = require('node:child_process');
    const child = spawn(process.argv[2], process.argv.slice(3), { stdio: 'ignore' });
    process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
    setInterval(() => {}, 1000);`);
  writeFileSync(join(dist, "cli.js"), `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    spawn(process.execPath, [__dirname + '/up-role-child.js', 'worker'], { stdio: 'ignore' });
    setInterval(() => {}, 1000);`);
  writeFileSync(join(dist, "up-role-child.js"), `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  return dist;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(what: string, probe: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  for (const deadline = Date.now() + ms; ;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const run = (args: string[]) => { const child = spawn(node, args, { stdio: "ignore" }); started.push(child); return child; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const roleOf = (parent: number) => until(`a role child of ${parent}`, () => listProcesses(spawnSync)?.find(row => row.ppid === parent && row.command.endsWith("up-role-child.js worker")));
/** The incident's service: a supervisor, its `up` and the `up`'s worker. */
async function service(dist: string, db: string) {
  const supervisor = run([join(dist, "controller-service.js"), node, join(dist, "cli.js"), "up", "--db", db, "--port", "4180"]);
  const up = await until("its up", () => listProcesses(spawnSync)?.find(row => row.ppid === supervisor.pid && row.command.includes("cli.js up")));
  const role = await roleOf(up.pid);
  return { supervisor: supervisor.pid!, up: up.pid, role: role.pid };
}
const world = { list: () => listProcesses(spawnSync), kill: (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal) };

test("a stuck `up` orphaned by its supervisor is stopped with SIGKILL; another database's and unrelated processes are never touched", async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-stop-")));
  const priorDist = runtime("prior"), nextDist = runtime("next"), db = join(root, "orders.db");
  const old = await service(priorDist, db);
  // The same runtime serving a sandbox's database, and a process that only shares a folder name: both stay.
  const sandbox = await service(priorDist, join(root, "demo.db"));
  const unrelated = run(["-e", "setInterval(() => {}, 1000)", join(root, "prior", "notes.txt")]);
  // The incident: the supervisor exits on its stop, its `up` ignores SIGTERM and keeps running without it.
  process.kill(old.supervisor, "SIGTERM");
  await until("the supervisor to exit", () => !alive(old.supervisor));
  await sleep(200);
  expect([alive(old.up), alive(old.role)]).toEqual([true, true]);
  const said: string[] = [];
  const result = stopServiceProcesses({ dists: [priorDist, nextDist], database: db, recorded: [old.supervisor, old.up, old.role], termMs: 500, killMs: 5_000 }, { ...world, say: line => said.push(line) });
  expect(result.stopped.sort()).toEqual([old.up, old.role].sort());
  expect(result.killed.sort()).toEqual([old.up, old.role].sort());
  expect([alive(old.up), alive(old.role)]).toEqual([false, false]);
  expect([alive(sandbox.supervisor), alive(sandbox.up), alive(sandbox.role), alive(unrelated.pid!)]).toEqual([true, true, true, true]);
  expect(said.join("\n")).toMatch(/ignored SIGTERM; stopping it with SIGKILL/);
  // Idempotent: nothing of the service is left, so a second run stops nothing.
  expect(stopServiceProcesses({ dists: [priorDist, nextDist], database: db, termMs: 100, killMs: 100 }, world)).toEqual({ stopped: [], killed: [] });
}, 30_000);

test("a process it can't prove refuses the whole stop: a healthy service of another runtime on the database, or an orphaned role", async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-stop-")));
  const priorDist = runtime("prior"), otherDist = runtime("other"), db = join(root, "orders.db");
  const old = await service(priorDist, db);
  // A currently loaded, healthy service from a runtime this deployment never recorded, on the same database.
  const healthy = await service(otherDist, db);
  const scope = { dists: [priorDist], database: db, termMs: 200, killMs: 200 };
  expect(() => stopServiceProcesses(scope, world)).toThrow(`Process ${healthy.supervisor}`);
  // Nothing was signalled: SIGTERM is ignored by these, but SIGTERM to the supervisor would have ended it.
  expect([old.supervisor, old.up, old.role, healthy.supervisor, healthy.up, healthy.role].every(alive)).toBe(true);
  for (const pid of [healthy.role, healthy.up, healthy.supervisor]) process.kill(pid, "SIGKILL");
  await until("the other service to end", () => ![healthy.role, healthy.up, healthy.supervisor].some(alive));

  // A role child whose `up` is gone and that the journal never recorded can't be shown to be this service's.
  process.kill(old.supervisor, "SIGKILL");
  process.kill(old.up, "SIGKILL");
  await until("the orphaned role", () => listProcesses(spawnSync)?.find(row => row.pid === old.role && row.ppid !== old.up));
  expect(() => stopServiceProcesses(scope, world)).toThrow("whose `up` can't be shown to be this service's");
  expect(alive(old.role)).toBe(true);
  // Recorded by the journal, it is: stopped.
  expect(stopServiceProcesses({ ...scope, recorded: [old.role], killMs: 5_000 }, world).killed).toEqual([old.role]);
  expect(alive(old.role)).toBe(false);
}, 30_000);

test("the deployment's stop proof stops a stuck `up` after its grace instead of waiting for a person", async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-stop-")));
  const priorDist = runtime("prior"), db = join(root, "orders.db");
  const old = await service(priorDist, db);
  const stopper = serviceStopper({ database: db, spawnSync, kill: world.kill, sleep, loaded: () => false, graceMs: 300, termMs: 300, killMs: 5_000 });
  process.kill(old.supervisor, "SIGTERM");
  await stopper.verifyServiceStopped([old.supervisor, old.up, old.role], priorDist);
  expect([old.supervisor, old.up, old.role].some(alive)).toBe(false);
  expect(stopper.leftFrom(priorDist)).toEqual([]);
  // A recorded value that isn't a process id never proves the stop.
  await expect(stopper.verifyServiceStopped([old.up, "unrecorded" as unknown as number], priorDist)).rejects.toThrow("has not exited: unrecorded");
}, 30_000);
