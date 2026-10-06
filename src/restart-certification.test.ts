/**
 * Restart certification (plan acceptance 7): the baseline records boot,
 * runtime, service and custody without a secret; verification against the
 * same database reports the boot identity as the OS gives it, demands a
 * FRESH heartbeat over a merely loaded service, settles what a verified
 * previous boot left pending by the controller's own rules, refuses to
 * force what it cannot prove, and never reboots anything.
 */

import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { injectBootIdentity } from "./boot-identity.js";
import { installedServiceDefinition, planDaemon, type DaemonPlan } from "./daemon.js";
import { assertNoSecret, recordRestartBaseline as recordBaseline, RESTART_LIMITS, restartRuntimeDigest, verifyRestartRecovery as verifyRecovery, type BaselineInputs, type VerifyInputs } from "./restart-certification.js";
import { fakePid } from "../test/fake-pid.js";

const BOOT_A = "4cdea6bb-1ac8-4e7c-bfcf-646f89b8a8a7";
const BOOT_B = "9b1d0e2f-3a4b-4c5d-8e6f-a1b2c3d4e5f6";
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const REPO = resolve("/repo");
// The witness is this live process: anchor its whole fixture timeline after
// the real process birth, including observation, finish and heartbeat times.
const T0 = new Date();
const host = hostname();
const servicePid = fakePid(1), restartedServicePid = fakePid(2);

function scripted(answers: Record<string, { code?: number; stdout?: string }>) {
  return async (file: string, args: readonly string[]) => {
    const key = `${file} ${args.join(" ")}`;
    const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    return { ...OK, ...(match?.[1] ?? {}) };
  };
}

describe("restart certification", () => {
  let store: Store;
  let dir: string;
  let token = "";

  // Exercise the real fresh-byte fingerprint without reopening the Node binary
  // and this entire source tree for every boot/custody assertion on Windows.
  const runtimeDigest = (): string => restartRuntimeDigest(join(dir, "node"), join(dir, "runtime"));
  const recordRestartBaseline = (inputs: BaselineInputs) => recordBaseline({ ...inputs, runtimeDigest });
  const verifyRestartRecovery = (inputs: VerifyInputs) => verifyRecovery({ ...inputs, runtimeDigest });

  afterEach(() => {
    injectBootIdentity(null);
    store?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  /** A runner, a running task with an open run under a live claim, and a stop pending on a witness of boot A. */
  function seed(): { runId: number; taskRef: number; plan: DaemonPlan } {
    dir = mkdtempSync(join(tmpdir(), "so-restart-cert-"));
    mkdirSync(join(dir, "runtime"));
    writeFileSync(join(dir, "node"), "fixture executable\n");
    writeFileSync(join(dir, "runtime", "controller.js"), "export const version = 1;\n");
    store = openStore(join(dir, "orders.db"));
    const registration = register(store, { name: "r", host, capacity: 1, repos: [REPO], now: T0 });
    token = registration.token;
    store.createTask({ id: "t", title: "t" }, T0);
    const taskRef = store.refFor("built-in", "t").id;
    store.placeTask(taskRef, REPO);
    const claimed = acquire(store, taskRef, "r", { token, now: T0, ttlMs: 3_600_000, newLeaseId: () => "lease" });
    if (!claimed.ok) throw new Error(claimed.reason);
    // The dispatcher moves a claimed task to running; a bare claim here does not.
    store.raw().prepare("UPDATE task SET state = 'running' WHERE id = 't'").run();
    const runId = store.startRun({ taskRef, leaseId: "lease", runner: "r", branch: "b", worktree: "/w", now: T0, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
    const asked = store.requestRunStop({ runId, taskRef, by: "alex", via: "cli" }, T0);
    if (!asked.ok) throw new Error(asked.reason);
    store.raw().prepare("INSERT INTO run_process (run, pid, host, process_group, observed_at, boot_id) VALUES (?, ?, ?, 1, ?, ?)").run(runId, process.pid, host, T0.toISOString(), BOOT_A);
    const plan = planDaemon({ platform: "darwin", bin: process.execPath, binArgs: [], runner: "r", repo: REPO, configDir: dir, watchFlags: [], home: dir, pathEnv: "/usr/bin" });
    if ("error" in plan) throw new Error(plan.error);
    return { runId, taskRef, plan };
  }

  test("c6: the baseline records boot, runtime, service, containment and live custody — and never a credential", async () => {
    const { runId, plan } = seed();
    injectBootIdentity({ ok: true, id: BOOT_A, source: "injected" });
    const baseline = await recordRestartBaseline({ store, now: T0, packageVersion: "0.4.3", service: { definition: plan, run: scripted({ "launchctl print gui": { code: 0, stdout: `pid = ${servicePid}\n` } }) } });
    expect(baseline).toMatchObject({
      version: 2,
      host,
      boot: { id: BOOT_A, source: "injected", problem: null },
      runtime: { nodeVersion: process.version, execPath: process.execPath, packageVersion: "0.4.3" },
      containment: { policy: "observed", mode: "observed" },
      service: { label: plan.label, state: "running", pid: servicePid },
      database: { schemaVersion: SCHEMA_VERSION, runningTasks: ["t"], openRuns: [{ id: runId, role: "builder", runner: "r" }], pendingStops: [{ run: runId, problem: expect.stringContaining("still open") }], witnesses: [{ run: runId, pid: process.pid, bootId: BOOT_A }] },
      limits: RESTART_LIMITS,
    });
    expect(baseline.runtime.digest).toBe(createHash("sha256")
      .update("fixture executable\n").update("controller.js").update("export const version = 1;\n").digest("hex"));
    // Cover the production default once as well: no injected reader, real Node
    // and module files. The remaining cases use the bounded runtime fixture.
    const actualRuntime = (await recordBaseline({ store, now: T0 })).runtime;
    expect(actualRuntime).toMatchObject({ execPath: process.execPath, nodeVersion: process.version });
    expect(actualRuntime.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(actualRuntime.digest).not.toBe(baseline.runtime.digest);
    expect(baseline.limits.join(" ")).toContain("FileVault");
    expect(baseline.limits.join(" ")).toContain("enable-linger");
    expect(baseline.limits.join(" ")).toContain("logon trigger");
    expect(baseline.limits.join(" ")).toContain("never reboots");
    const json = JSON.stringify(baseline);
    expect(json).not.toContain(token);
    const hash = String(store.raw().prepare("SELECT credential_hash FROM runner WHERE name = 'r'").get()?.["credential_hash"]);
    expect(json).not.toContain(hash);
    expect(() => assertNoSecret(json, [token, hash])).not.toThrow();
    expect(() => assertNoSecret(`${json}${token}`, [token])).toThrow(/credential/);
    // An unknown boot is recorded as exactly that.
    injectBootIdentity({ ok: false, reason: "unsupported-platform", detail: "win32 exposes no per-boot identity" });
    expect((await recordRestartBaseline({ store, now: T0 })).boot).toEqual({ id: null, source: null, problem: "win32 exposes no per-boot identity" });
  });

  test("c6: after a VERIFIED boot change the old boot's custody settles by the controller's own rules, and a fresh heartbeat plus a running service pass", async () => {
    const { runId, plan } = seed();
    injectBootIdentity({ ok: true, id: BOOT_A, source: "injected" });
    const baseline = await recordRestartBaseline({ store, now: T0, service: { definition: plan, run: scripted({ "launchctl print gui": { code: 0, stdout: `pid = ${servicePid}\n` } }) } });

    // The run ends under the OLD boot with its witness still a live pid: the
    // stop stays pending, exactly as a crashed worker leaves it.
    const later = new Date(T0.getTime() + 5 * 60_000);
    store.releaseClaimsOf("r", later);
    store.finishRun(runId, { outcome: "failed", reason: "interrupted", now: later });
    expect(store.stopOf(runId)?.settledAt).toBeNull();
    // "Reboot": a new boot id; the watch that came back beats afresh.
    injectBootIdentity({ ok: true, id: BOOT_B, source: "injected" });
    store.touchRunner("r", later);

    const digest = /<key>STANDING_ORDERS_SERVICE_DIGEST<\/key>\s*<string>([a-f0-9]{64})/.exec(plan.unitContent)?.[1];
    const verified = await verifyRestartRecovery({ store, baseline, now: later, expect: "reboot", service: { definition: plan, run: scripted({ "launchctl print gui": { code: 0, stdout: `pid = ${restartedServicePid}\nSTANDING_ORDERS_SERVICE_DIGEST => ${digest}\n` } }) } });
    const byName = Object.fromEntries(verified.checks.map(check => [check.name, check]));
    expect(verified.bootChanged).toBe(true);
    expect(byName["boot-identity"]).toMatchObject({ ok: true, detail: expect.stringContaining(`${BOOT_A} → ${BOOT_B}`) });
    expect(byName["service"]).toMatchObject({ ok: true });
    expect(byName["heartbeat"]).toMatchObject({ ok: true, detail: expect.stringContaining("fresh live heartbeat") });
    expect(byName["pending-stops"]).toMatchObject({ ok: true, detail: expect.stringContaining("every pending stop settled") });
    expect(byName["open-runs"]).toMatchObject({ ok: true });
    expect(byName["old-boot-custody"]).toMatchObject({ ok: true, detail: expect.stringContaining("proven gone by boot identity") });
    expect(byName["tasks"]).toMatchObject({ ok: true });
    expect(verified.ok).toBe(true);
    expect(store.stopOf(runId)?.settledAt).not.toBeNull();
    expect(store.stopOf(runId)?.settlement).toBe("recovered");
    const oldLoaded = await verifyRestartRecovery({ store, baseline, now: later, expect: "reboot", service: { definition: plan, run: scripted({ "launchctl print gui": { code: 0, stdout: `pid = ${restartedServicePid}\n` } }) } });
    expect(oldLoaded.checks.find(check => check.name === "service")?.ok).toBe(false);
    expect(oldLoaded.ok).toBe(false);
  });

  test("c6: the same boot is reported as such — a reboot expectation fails honestly, a login expectation passes — and a live pid keeps the stop pending, unforced", async () => {
    const { runId, plan } = seed();
    injectBootIdentity({ ok: true, id: BOOT_A, source: "injected" });
    const baseline = await recordRestartBaseline({ store, now: T0, service: { definition: plan, run: scripted({ "launchctl print gui": { code: 0, stdout: `pid = ${servicePid}\n` } }) } });
    const later = new Date(T0.getTime() + 60_000);
    store.releaseClaimsOf("r", later);
    store.finishRun(runId, { outcome: "failed", reason: "interrupted", now: later });
    store.touchRunner("r", later);

    const reboot = await verifyRestartRecovery({ store, baseline, now: later, expect: "reboot", service: { definition: plan, run: scripted({ "launchctl print gui": { code: 0, stdout: `pid = ${servicePid}\n` } }) } });
    const rebootChecks = Object.fromEntries(reboot.checks.map(check => [check.name, check]));
    expect(reboot.bootChanged).toBe(false);
    expect(rebootChecks["boot-identity"]).toMatchObject({ ok: false, detail: expect.stringContaining("has NOT happened") });
    // The witness is THIS process's pid — alive under the same boot — so the
    // stop stays pending with its exact reason; nothing forces it.
    expect(rebootChecks["pending-stops"]).toMatchObject({ ok: false, detail: expect.stringContaining("may still be running") });
    expect(rebootChecks["old-boot-custody"]).toMatchObject({ ok: true, detail: expect.stringContaining("judged by their probes") });
    expect(reboot.ok).toBe(false);
    expect(store.stopOf(runId)?.settledAt).toBeNull();

    const login = await verifyRestartRecovery({ store, baseline, now: later, expect: "login", service: { definition: plan, run: scripted({ "launchctl print gui": { code: 0, stdout: `pid = ${servicePid}\n` } }) } });
    expect(Object.fromEntries(login.checks.map(check => [check.name, check.ok]))["boot-identity"]).toBe(true);
  });

  test("c6: a loaded-but-not-running service, a stale heartbeat, a missing runtime and an unknown boot are each named, never glossed", async () => {
    const { runId, plan } = seed();
    injectBootIdentity({ ok: true, id: BOOT_A, source: "injected" });
    const baseline = await recordRestartBaseline({ store, now: T0, service: { definition: plan, run: scripted({ "launchctl print gui": { code: 0, stdout: `pid = ${servicePid}\n` } }) } });
    injectBootIdentity({ ok: false, reason: "unreadable", detail: "sysctl failed" });
    const later = new Date(T0.getTime() + 60_000);
    store.finishRun(runId, { outcome: "failed", reason: "interrupted", now: later });
    const broken = { ...plan, bin: join(dir, "no-such-node") };
    const verified = await verifyRestartRecovery({ store, baseline, now: later, service: { definition: broken, run: scripted({ "launchctl print gui": { code: 0, stdout: "state = waiting\n" } }) } });
    const byName = Object.fromEntries(verified.checks.map(check => [check.name, check]));
    expect(verified.bootChanged).toBeNull();
    expect(byName["boot-identity"]).toMatchObject({ ok: false, detail: expect.stringContaining("no reboot is claimed") });
    expect(byName["service"]).toMatchObject({ ok: false, detail: expect.stringContaining("loaded, not currently running") });
    expect(byName["service"]?.detail).toContain("runtime");
    expect(byName["heartbeat"]).toMatchObject({ ok: false, detail: expect.stringContaining("a loaded service is not a working controller") });
    expect(verified.ok).toBe(false);
  });

  test("a different database, changed runtime, missing stop, and incomplete completion task each refuse certification", async () => {
    const { runId } = seed();
    injectBootIdentity({ ok: true, id: BOOT_A, source: "injected" });
    const baseline = await recordRestartBaseline({ store, now: T0, runnerName: "r", completionTasks: ["t"] });
    const later = new Date(T0.getTime() + 60_000);
    const other = openStore(join(dir, "other.db"));
    try {
      const wrong = await verifyRestartRecovery({ store: other, baseline, now: later });
      expect(wrong.checks.find(check => check.name === "database")?.ok).toBe(false);
      expect(wrong.checks.find(check => check.name === "pending-stops")?.ok).toBe(false);
      expect(wrong.ok).toBe(false);
    } finally { other.close(); }
    // The same path and byte length now contain a different runtime. A cached
    // digest would miss this; verification must actually read the changed bytes.
    writeFileSync(join(dir, "runtime", "controller.js"), "export const version = 2;\n");
    const result = await verifyRestartRecovery({ store, baseline, now: later, recover: false });
    expect(result.checks.find(check => check.name === "runtime")?.ok).toBe(false);
    expect(result.checks.find(check => check.name === "completion:t")?.ok).toBe(false);
    expect(store.stopOf(runId)?.settledAt).toBeNull();
    register(store, { name: "unrelated", host, capacity: 1, repos: [REPO], now: later });
    const unrelated = await verifyRestartRecovery({ store, baseline, now: later, recover: false });
    expect(unrelated.checks.find(check => check.name === "heartbeat")?.ok).toBe(false);
  });

  test("c6: the installed definition is read back from the unit on disk for the certificate's service view", () => {
    dir = mkdtempSync(join(tmpdir(), "so-restart-cert-unit-"));
    store = openStore(":memory:");
    expect(installedServiceDefinition({ label: "com.standing-orders.watch.x", platform: "darwin", home: dir })).toBeNull();
    const plan = planDaemon({ platform: "darwin", bin: "/opt/node/bin/node", binArgs: ["/opt/so/dist/bin.js"], runner: "r", repo: REPO, configDir: dir, watchFlags: [], home: dir, pathEnv: "/usr/bin" });
    if ("error" in plan) throw new Error(plan.error);
    mkdirSync(join(dir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plan.unitPath, plan.unitContent);
    const installed = installedServiceDefinition({ label: plan.label, platform: "darwin", home: dir });
    expect(installed).toMatchObject({ label: plan.label, bin: process.execPath, entry: expect.stringContaining("controller-service.js"), logPath: plan.logPath, unitContent: plan.unitContent });
    const linux = planDaemon({ platform: "linux", bin: "/opt/node/bin/node", binArgs: ["/opt/so/dist/bin.js"], runner: "r", repo: REPO, configDir: dir, watchFlags: [], home: dir, pathEnv: "/usr/bin" });
    if ("error" in linux) throw new Error(linux.error);
    mkdirSync(join(dir, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(linux.unitPath, linux.unitContent);
    expect(installedServiceDefinition({ label: linux.label, platform: "linux", home: dir })).toMatchObject({ bin: "/opt/node/bin/node", entry: "/opt/so/dist/bin.js", logPath: linux.logPath });
  });
});
