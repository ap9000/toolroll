// Observations used to refuse recovery while a service may still be running. Historical PIDs, argv and ps birth
// times cannot authorize signals: argv is spoofable and lookup/kill races PID reuse. Normal launchd shutdown remains
// with the current service owner. Recovery waits for that owner to stop any leftovers before proving exit.
import { realpathSync } from "node:fs";
import { sleepSync } from "./deploy-recovery.mjs";

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A runtime as its definition names it and as Node resolves it: `up` starts its role children by its module's real
 * path, so a runtime reached through a symlink shows under both. */
const real = new Map();
export const spellings = dists => [...new Set(dists.flatMap(dist => {
  if (!real.has(dist)) { try { real.set(dist, realpathSync(dist)); } catch { real.set(dist, dist); } }
  return [dist, real.get(dist)];
}))];
const LINE = /^\s*(\d+)\s+(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})(?:\s+(.*))?$/;

/** Every process: pid, parent, start (as ps prints it) and full command; null when the list can't be read whole. */
export function listProcesses(spawnSync) {
  const listed = spawnSync("/bin/ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,command="], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, maxBuffer: 32 * 1024 * 1024 });
  if (listed.status !== 0 || typeof listed.stdout !== "string") return null;
  const rows = [];
  for (const line of listed.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const match = LINE.exec(line);
    if (match === null) return null;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), start: match[3].replace(/ +/g, " "), command: (match[4] ?? "").trimEnd() });
  }
  return rows;
}

/** What a command is to this service, by exact runtime path and argv: a kind and its runtime; "foreign" for one of
 * these runtimes' `up` (or its supervisor) on another database, provably not this service's; "named" when it only
 * mentions this service's runtimes or database (so it can't be proved either way); null when it is unrelated. */
export function classify(command, { dists: named, database }) {
  const db = escape(database);
  const dists = spellings(named);
  for (const dist of dists) {
    const d = escape(dist);
    if (new RegExp(`^\\S+ ${d}/controller-service\\.js \\S+ ${d}/cli\\.js up --db ${db}(?: |$)`).test(command)) return { kind: "supervisor", dist };
    if (new RegExp(`^\\S+ ${d}/cli\\.js up --db ${db}(?: |$)`).test(command)) return { kind: "up", dist };
    const role = new RegExp(`^\\S+ ${d}/up-role-child\\.js (console|worker)$`).exec(command);
    if (role !== null) return { kind: "role", role: role[1], dist };
    // The same runtime serving a different database (a sandbox, another install): one plain path that isn't this one.
    const other = new RegExp(`^\\S+ (?:${d}/controller-service\\.js \\S+ )?${d}/cli\\.js up --db (\\S+)(?: |$)`).exec(command);
    if (other !== null && other[1] !== database && !command.includes(` ${database}`)) return { kind: "foreign", dist };
  }
  const mentions = [...dists.flatMap(dist => [`${dist}/controller-service.js`, `${dist}/up-role-child.js`, `${dist}/cli.js up`]), `up --db ${database}`];
  return mentions.some(one => command.includes(one)) ? { kind: "named" } : null;
}

/**
 * This service's processes among `rows`: `targets` resemble its supervisor, `up` or role children (a role only
 * when its parent resembles an `up` or the journal recorded its pid); `unproven` name its runtimes or database but are
 * none of these provably. `self` (this process) is never either.
 */
export function serviceProcesses(rows, { dists, database, recorded = [], self = process.pid }) {
  const targets = [], unproven = [];
  const kinds = rows.filter(row => row.pid !== self && row.pid > 1).map(row => ({ row, what: classify(row.command, { dists, database }) })).filter(one => one.what !== null);
  const ups = new Set(kinds.filter(one => one.what.kind === "up").map(one => one.row.pid));
  const foreign = new Set(kinds.filter(one => one.what.kind === "foreign").map(one => one.row.pid));
  for (const { row, what } of kinds) {
    if (what.kind === "foreign") continue;
    if (what.kind === "named") { unproven.push({ ...row, why: "it names this service's runtime or database but isn't one of its processes" }); continue; }
    if (what.kind === "role" && foreign.has(row.ppid) && !recorded.includes(row.pid)) continue;
    if (what.kind === "role" && !ups.has(row.ppid) && !recorded.includes(row.pid)) { unproven.push({ ...row, why: "a role child whose `up` can't be shown to be this service's" }); continue; }
    targets.push({ ...row, kind: what.kind, ...(what.role === undefined ? {} : { role: what.role }), dist: what.dist });
  }
  return { targets, unproven };
}

/**
 * Historical PIDs and argv are observations, never signalling authority. argv is writable by the process, ps birth
 * times have only second precision, and even a fresh read races PID reuse before kill(2). Without an OS-held process
 * handle this path must refuse. Normal launchd shutdown still runs; recovery resumes once exit is proved.
 */
export function stopServiceProcesses({ dists, database, recorded = [] }, { list }) {
  const rows = list();
  if (rows === null) throw Error("The process list couldn't be read, so no process was stopped.");
  const found = serviceProcesses(rows, { dists, database, recorded });
  const left = [...found.targets, ...found.unproven];
  if (left.length > 0) throw Error(`Service exit is not proved: process ${left.map(one => one.pid).join(", ")}. Historical PIDs and command lines cannot safely authorize signals; nothing was stopped. Stop the service through its owner, then rerun recovery.`);
  return { stopped: [], killed: [] };
}

/** A present recorded PID is ambiguous: argv may have changed, and the journal has no process birth identity. */
export function recordedStillRunning(rows, pid, _scope) {
  return rows.some(one => one.pid === pid);
}

/**
 * The deployment's stop proof over the real process list (deploy-browser.mjs), with its effects supplied so a test can
 * run it against real processes: spawnSync (ps), kill(pid, signal), sleep(ms) (a promise), signal (cancellation),
 * say, loaded() (whether launchd still has the service). `graceMs` is how long the service gets to end by itself
 * after its bootout (launchd's own ExitTimeOut is 60 s); an elapsed grace period refuses without escalation.
 */
export function serviceStopper({ database, spawnSync, kill, sleep, signal, say = () => {}, loaded, graceMs = 60_000, termMs = 10_000, killMs = 10_000, sleepSync: pause = sleepSync }) {
  const processes = () => listProcesses(spawnSync);
  const fail = message => { throw Error(message); };
  /** Processes still running this runtime's `up` on this database, its supervisor or role children, or anything that
   * names them and can't be told apart (never another database's `up` or its roles); unreadable is a process left. */
  const leftFrom = dist => {
    if (typeof dist !== "string" || dist === "") return ["(the runtime is unknown)"];
    const rows = processes();
    if (rows === null) return ["(the process list couldn't be read)"];
    const found = serviceProcesses(rows, { dists: [dist], database });
    return [...found.targets, ...found.unproven].map(row => row.pid);
  };
  const stopProcesses = scope => stopServiceProcesses({ termMs, killMs, ...scope }, { list: processes, kill, sleep: pause, say });
  /** Every recorded process of the stopped service, and anything else of its runtime on this database, has exited and
   * launchd no longer has it. A process that outlives `graceMs` refuses; nothing is signalled here. */
  async function verifyServiceStopped(pids, dist) {
    const scope = { dists: [dist], database };
    // A recorded value that isn't a process id never proves anything (round 1, finding 3).
    const recorded = pid => Number.isInteger(pid) && pid > 1;
    const gone = () => { const rows = processes(); return rows !== null && pids.every(pid => recorded(pid) && !recordedStillRunning(rows, pid, scope)) && leftFrom(dist).length === 0; };
    for (let waited = 0; waited < graceMs && !gone(); waited += 1000) { signal?.throwIfAborted(); await sleep(Math.min(1000, graceMs - waited)); }
    signal?.throwIfAborted();
    if (!gone()) stopProcesses({ ...scope, recorded: pids.filter(recorded) });
    const rows = processes();
    if (rows === null) fail("The process list couldn't be read, so the old service's exit isn't proved.");
    for (const pid of pids) if (!recorded(pid) || recordedStillRunning(rows, pid, scope)) fail(`Service process has not exited: ${pid}`);
    // Belt to the recorded pids (round 1, finding 3): no `up` of this database and no role child of this runtime is left,
    // whatever pid a restarted role got after the record was taken.
    const left = leftFrom(dist);
    if (left.length > 0) fail(`Service process has not exited: ${left.join(", ")}`);
    if (loaded()) fail("The service is still loaded.");
  }
  return { processes, leftFrom, stopProcesses, verifyServiceStopped };
}
