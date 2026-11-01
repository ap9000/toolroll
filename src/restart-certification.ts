/**
 * Restart certification (plan acceptance 7): a BASELINE of the boot, the
 * runtime, the installed service and the database's live custody, taken
 * before a login or reboot; and a VERIFICATION afterwards against the same
 * database — boot identity as the OS reports it, service liveness by a
 * fresh heartbeat, recovery of what the old boot left pending, task
 * completion — without printing a secret and without rebooting anything.
 *
 * The precise limits, written into every baseline so nobody reads more
 * into a pass than it proves:
 *   - macOS LaunchAgents resume at USER LOGIN after a reboot, not before
 *     FileVault unlock / login; a machine that sits at the login window
 *     runs nothing.
 *   - Linux user services depend on a login session or `loginctl
 *     enable-linger`; without linger the user manager stops at logout.
 *   - The Windows Task Scheduler logon trigger is a LOGON trigger, not a
 *     boot service.
 *   - This tool never reboots, logs out, or restarts a service itself. A
 *     physical reboot that has not happened is not claimed: `bootChanged`
 *     is the OS's own word, and `unknown` stays unknown.
 */

import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { bootIdentity, provenDeadByBootChange, type BootIdentity } from "./boot-identity.js";
import { containmentStatus, currentContainment } from "./containment.js";
import { daemonStatus, type ServiceDefinition, type ServiceStatus, type SupervisorRunner } from "./daemon.js";
import { isAlive } from "./runner.js";
import { SCHEMA_VERSION, type Store } from "./store.js";

export const RESTART_LIMITS: readonly string[] = [
  "macOS LaunchAgents resume at user login after a reboot, not before FileVault unlock/login; a machine at the login window runs nothing",
  "Linux user services depend on a login session or loginctl enable-linger; without linger the user manager stops at logout",
  "the Windows Task Scheduler logon trigger is a logon trigger, not a boot service",
  "this tool never reboots, logs out, or restarts a service; bootChanged is the OS's own boot identity, and unknown stays unknown",
  "a pass here certifies this database, this service label and this boot — not a physical reboot that did not happen",
  "task recovery means earlier running attempts moved on; only explicitly named completion tasks must reach done",
];

export type RestartBaseline = {
  version: 2;
  runnerName: string | null;
  completionTasks: string[];
  recordedAt: string;
  host: string;
  boot: { id: string | null; source: string | null; problem: string | null };
  runtime: { digest: string; nodeVersion: string; execPath: string; platform: NodeJS.Platform; packageVersion: string | null };
  containment: Record<string, unknown>;
  service: (ServiceStatus & { label: string; platform: string }) | null;
  database: {
    identity: string;
    schemaVersion: number;
    runners: { name: string; host: string; heartbeatAt: string; alive: boolean; retired: boolean }[];
    pendingStops: { run: number; taskRef: number; requestedAt: string; problem: string | null }[];
    openRuns: { id: number; taskRef: number; role: string; runner: string; leaseId: string }[];
    runningTasks: string[];
    witnesses: { run: number; pid: number | null; host: string; bootId: string | null; containment: string | null; open: boolean }[];
  };
  limits: readonly string[];
};

export type BaselineInputs = {
  store: Store;
  service?: { definition: ServiceDefinition; run: SupervisorRunner } | undefined;
  now?: Date;
  packageVersion?: string | null;
  boot?: BootIdentity;
  runnerName?: string;
  completionTasks?: string[];
  /** Injectable reader for runtime fixtures; production re-reads its actual files. */
  runtimeDigest?: () => string;
};

function bootFacts(identity: BootIdentity): RestartBaseline["boot"] {
  return identity.ok ? { id: identity.id, source: identity.source, problem: null } : { id: null, source: null, problem: identity.detail };
}

const memoryIdentities = new WeakMap<Store, string>();
function databaseIdentity(store: Store): string {
  const file = store.raw().prepare("PRAGMA database_list").all().find(row => row["name"] === "main")?.["file"];
  if (typeof file !== "string" || file === "") {
    let id = memoryIdentities.get(store); if (!id) { id = randomUUID(); memoryIdentities.set(store, id); } return id;
  }
  const path = realpathSync(file), stat = statSync(path);
  return createHash("sha256").update(JSON.stringify([path, stat.dev, stat.ino])).digest("hex");
}
export function restartRuntimeDigest(executable = process.execPath, root = dirname(fileURLToPath(import.meta.url))): string {
  const hash = createHash("sha256").update(readFileSync(executable));
  for (const name of readdirSync(root).filter(name => /\.(js|ts|ps1)$/.test(name)).sort()) hash.update(name).update(readFileSync(join(root, name)));
  return hash.digest("hex");
}

/** Everything a person needs to compare later, none of what they must not see. */
export async function recordRestartBaseline(inputs: BaselineInputs): Promise<RestartBaseline> {
  const { store } = inputs;
  const now = inputs.now ?? new Date();
  const raw = store.raw();
  const service = inputs.service === undefined ? null : { ...(await daemonStatus(inputs.service.definition, inputs.service.run)), label: inputs.service.definition.label, platform: inputs.service.definition.platform };
  const pendingStops = raw.prepare("SELECT run, task_ref, requested_at FROM run_stop WHERE settled_at IS NULL ORDER BY run").all()
    .map(row => ({ run: Number(row["run"]), taskRef: Number(row["task_ref"]), requestedAt: String(row["requested_at"]), problem: store.stopQuiescenceProblem(Number(row["run"])) }));
  const openRuns = raw.prepare("SELECT id, task_ref, role, runner, lease_id FROM run WHERE outcome IS NULL ORDER BY id").all()
    .map(row => ({ id: Number(row["id"]), taskRef: Number(row["task_ref"]), role: String(row["role"]), runner: String(row["runner"]), leaseId: String(row["lease_id"]) }));
  const witnesses = raw.prepare("SELECT run, pid, host, boot_id, containment, exited_at FROM run_process WHERE exited_at IS NULL ORDER BY id").all()
    .map(row => ({ run: Number(row["run"]), pid: row["pid"] === null ? null : Number(row["pid"]), host: String(row["host"]), bootId: row["boot_id"] === null ? null : String(row["boot_id"]), containment: row["containment"] === null ? null : String(row["containment"]), open: true }));
  return {
    version: 2,
    runnerName: inputs.runnerName ?? null,
    completionTasks: [...(inputs.completionTasks ?? [])],
    recordedAt: now.toISOString(),
    host: hostname(),
    boot: bootFacts(inputs.boot ?? bootIdentity()),
    runtime: { digest: (inputs.runtimeDigest ?? restartRuntimeDigest)(), nodeVersion: process.version, execPath: process.execPath, platform: process.platform, packageVersion: inputs.packageVersion ?? readPackageVersion() },
    containment: containmentStatus(currentContainment()),
    service,
    database: {
      identity: databaseIdentity(store),
      schemaVersion: SCHEMA_VERSION,
      runners: store.listRunners().map(one => ({ name: one.name, host: one.host, heartbeatAt: one.heartbeatAt, alive: isAlive(one, now), retired: one.retiredAt !== null })),
      pendingStops,
      openRuns,
      runningTasks: store.listTasks("running").map(task => task.id),
      witnesses,
    },
    limits: RESTART_LIMITS,
  };
}

function readPackageVersion(): string | null {
  try {
    const url = new URL("../package.json", import.meta.url);
    if (!existsSync(url)) return null;
    const parsed = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export type RestartCheck = { name: string; ok: boolean; detail: string };
export type RestartVerification = {
  ok: boolean;
  /** The OS's word: true = a different verified boot, false = the same boot, null = unknown either side. */
  bootChanged: boolean | null;
  expectation: "reboot" | "login" | "either";
  checks: RestartCheck[];
  current: RestartBaseline;
  limits: readonly string[];
};

export type VerifyInputs = BaselineInputs & {
  baseline: RestartBaseline;
  /** What the operator did: a reboot must show a changed boot; a login (no reboot) the same one. */
  expect?: "reboot" | "login" | "either";
  /** Settle what the old boot left behind before judging recovery (the watch does this on its own; the certificate does it explicitly). */
  recover?: boolean;
};

/**
 * Compare now against the baseline. Recovery is judged by the SAME rules
 * the controller uses (stopQuiescenceProblem, settleQuiescentStops): a
 * stop the old boot left pending settles only when its witnesses are
 * proven gone — by the verified boot change, or by the probes — and a
 * stop that still cannot settle is reported with the exact reason, never
 * forced.
 */
export async function verifyRestartRecovery(inputs: VerifyInputs): Promise<RestartVerification> {
  const { store, baseline } = inputs;
  const expectation = inputs.expect ?? "either";
  const checks: RestartCheck[] = [];
  const identity = inputs.boot ?? bootIdentity();
  const current = await recordRestartBaseline({ ...inputs, ...(baseline.runnerName ? { runnerName: baseline.runnerName } : {}), completionTasks: baseline.completionTasks ?? [], boot: identity });
  const sameDatabase = baseline.version === 2 && baseline.database.identity === current.database.identity;
  checks.push({ name: "database", ok: sameDatabase, detail: sameDatabase ? "same database file identity" : "database identity differs or baseline predates identity verification; no recovery mutations performed" });

  // 1. Boot identity, as the OS reports it.
  const sameHost = baseline.host === current.host;
  const bootChanged = !sameHost || baseline.boot.id === null || current.boot.id === null
    ? null
    : provenDeadByBootChange({ host: current.host, bootId: baseline.boot.id }, { host: current.host, bootId: current.boot.id });
  checks.push({ name: "host", ok: sameHost, detail: sameHost ? `same host ${current.host}` : `baseline was taken on ${baseline.host}, this is ${current.host} — nothing here certifies that machine` });
  checks.push({
    name: "boot-identity",
    ok: bootChanged !== null && (expectation === "either" || (expectation === "reboot") === bootChanged),
    detail: bootChanged === null
      ? `boot identity unknown (baseline ${baseline.boot.id ?? baseline.boot.problem ?? "none"}, now ${current.boot.id ?? current.boot.problem ?? "none"}) — no reboot is claimed`
      : bootChanged
        ? `verified boot change ${baseline.boot.id} → ${current.boot.id}${expectation === "login" ? " — but a login without reboot was expected" : ""}`
        : `same boot ${current.boot.id}${expectation === "reboot" ? " — the reboot has NOT happened" : ""}`,
  });

  // 2. Runtime identity.
  const sameRuntime = baseline.runtime.digest === current.runtime.digest && baseline.runtime.execPath === current.runtime.execPath && baseline.runtime.nodeVersion === current.runtime.nodeVersion && baseline.runtime.packageVersion === current.runtime.packageVersion;
  checks.push({ name: "runtime", ok: sameRuntime, detail: sameRuntime ? `same runtime node ${current.runtime.nodeVersion} at ${current.runtime.execPath}, package ${current.runtime.packageVersion ?? "?"}` : `runtime changed: ${baseline.runtime.nodeVersion}@${baseline.runtime.execPath} (${baseline.runtime.packageVersion ?? "?"}) → ${current.runtime.nodeVersion}@${current.runtime.execPath} (${current.runtime.packageVersion ?? "?"})` });
  checks.push({ name: "schema", ok: current.database.schemaVersion === baseline.database.schemaVersion, detail: `schema v${baseline.database.schemaVersion} → v${current.database.schemaVersion}` });

  // 3. Service liveness: loaded is not working; a working controller shows a running process AND a fresh heartbeat.
  if (baseline.service !== null || current.service !== null) {
    const service = current.service;
    if (service === null) checks.push({ name: "service", ok: false, detail: "no service definition was given to verify against" });
    else {
      const problems = service.problems.length === 0 ? "" : ` — ${service.problems.join("; ")}`;
      checks.push({ name: "service", ok: service.state === "running" && service.problems.length === 0 && !service.stale && baseline.service?.label === service.label, detail: `${service.label}: ${service.detail}${service.stale ? " (installed definition is stale: reinstall to load the current one)" : ""}${problems}` });
    }
  }
  const baselineBeats = new Map(baseline.database.runners.map(one => [one.name, one.heartbeatAt]));
  const liveRunners = current.database.runners.filter(one => !one.retired);
  const fresh = liveRunners.filter(one => one.host === current.host && one.alive && (baseline.runnerName === null || one.name === baseline.runnerName) && baselineBeats.has(one.name) && one.heartbeatAt > baselineBeats.get(one.name)!);
  checks.push({
    name: "heartbeat",
    ok: fresh.length > 0,
    detail: fresh.length > 0
      ? `fresh live heartbeat from ${fresh.map(one => `${one.name} at ${one.heartbeatAt}`).join(", ")}`
      : liveRunners.length === 0
        ? "no live runner is registered — the controller has not come back"
        : `no runner has beaten since the baseline (${liveRunners.map(one => `${one.name}: ${one.heartbeatAt}${one.alive ? "" : " (stale)"}`).join(", ")}) — a loaded service is not a working controller`,
  });

  // 4. Recovery of what the old boot left pending.
  if (sameDatabase && inputs.recover !== false) store.settleQuiescentStops(inputs.now ?? new Date());
  const remaining = baseline.database.pendingStops.map(stop => ({ run: stop.run, settled: store.stopOf(stop.run)?.settledAt != null, problem: store.stopQuiescenceProblem(stop.run) }));
  const unsettled = remaining.filter(one => !one.settled);
  checks.push({
    name: "pending-stops",
    ok: unsettled.length === 0,
    detail: baseline.database.pendingStops.length === 0
      ? "no stop was pending at the baseline"
      : unsettled.length === 0
        ? `every pending stop settled (${remaining.map(one => `#${one.run}`).join(", ")})`
        : `still pending: ${unsettled.map(one => `#${one.run} — ${one.problem ?? "unsettled"}`).join("; ")}`,
  });
  const staleOpen = current.database.openRuns.filter(run => baseline.database.openRuns.some(old => old.id === run.id));
  checks.push({
    name: "open-runs",
    ok: staleOpen.length === 0,
    detail: baseline.database.openRuns.length === 0
      ? "no run was open at the baseline"
      : staleOpen.length === 0
        ? `every run open at the baseline has ended (${baseline.database.openRuns.map(run => `#${run.id}`).join(", ")})`
        : `still open from before: ${staleOpen.map(run => `#${run.id} (${run.role}, ${run.runner})`).join(", ")} — recovery has not run, or its lease is still live`,
  });
  const oldWitnesses = baseline.database.witnesses.filter(one => one.bootId !== null && current.boot.id !== null && one.host === current.host);
  const survivors = oldWitnesses.filter(one => !provenDeadByBootChange({ host: one.host, bootId: one.bootId }, { host: current.host, bootId: current.boot.id }));
  checks.push({
    name: "old-boot-custody",
    ok: bootChanged !== true || survivors.length === 0,
    detail: bootChanged === true
      ? `${oldWitnesses.length} witness(es) of the previous boot are proven gone by boot identity`
      : `${baseline.database.witnesses.length} open witness(es) at the baseline are judged by their probes, not by a boot change`,
  });

  // 5. Task completion since the baseline.
  const stillRunning = current.database.runningTasks.filter(id => baseline.database.runningTasks.includes(id));
  checks.push({
    name: "tasks",
    ok: stillRunning.length === 0,
    detail: baseline.database.runningTasks.length === 0
      ? "no task was running at the baseline"
      : stillRunning.length === 0
        ? `every task running at the baseline moved on (${baseline.database.runningTasks.join(", ")})`
        : `still running from before: ${stillRunning.join(", ")}`,
  });

  for (const taskId of baseline.completionTasks ?? []) {
    const task = store.getTask(taskId);
    checks.push({ name: `completion:${taskId}`, ok: task?.state === "done", detail: task ? `${taskId}: ${task.state}` : `${taskId}: missing` });
  }
  return { ok: checks.every(check => check.ok), bootChanged, expectation, checks, current, limits: RESTART_LIMITS };
}

/** The baseline and verification are meant to be printed; this keeps a secret from ever entering them. */
export function assertNoSecret(json: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret !== "" && json.includes(secret)) throw new Error("the certification output would contain a credential; refusing to write it");
  }
}
