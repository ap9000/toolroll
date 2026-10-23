/**
 * `toolroll update`: preview first, `--yes` to act (toolroll-update.ts does
 * the work). `--now` refuses while work runs; `--when-idle` (the default)
 * pauses new work and waits for running work; `--at HH:MM` waits for that
 * time first. `--rollback` returns to the previous runtime and its backup.
 */
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { installMethod } from "./install-method.js";
import { isNewer, latestVersionNow } from "./releases.js";
import { databasePath } from "./store.js";
import { PACKAGE_VERSION } from "./version.js";
import {
  currentRuntime, lastCompletedUpdate, machineSystem, readRuntimeUpdate, requestRuntimeUpdateCancel, resumeRuntimeUpdate, retireUpdateJob,
  startRuntimeRollback, startRuntimeUpdate, type RuntimeRef, type UpdateSystem, type When,
} from "./toolroll-update.js";

/** Loaded on first use (as backup.ts and store.ts do), so modules that only import this one (the console,
 * and tests that load it in a browser-like environment) never need `node:sqlite` itself. */
function sqlite(): typeof import("node:sqlite") {
  return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
}


export const UPDATE_HELP = `toolroll update                 preview updating to the latest release
toolroll update --yes           update: verify, let running work finish, back up, rehearse, switch, restart, check
  --version X                   a specific release instead of the latest
  --when-idle                   pause new work and wait for running work (the default)
  --now                         refuse if any work is running
  --at HH:MM                    wait until then (e.g. --at 03:00)
  --allow-downgrade             with --version, go back to an older release
toolroll update --rollback [--yes]   return to the previous version and its database backup
toolroll update --status | --resume | --cancel`;

export type UpdateCliDeps = {
  system?: UpdateSystem;
  current?: RuntimeRef;
  method?: ReturnType<typeof installMethod>;
  latest?: () => Promise<{ version: string }>;
  databaseFile?: string;
  /** Where the console's one-off update job's definition lives (tests). */
  home?: string;
};

export async function runUpdateCommand(args: readonly string[], write: (line: string) => void, deps: UpdateCliDeps = {}): Promise<number> {
  const has = (name: string) => args.includes(`--${name}`);
  const value = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
  const known = new Set(["--yes", "--now", "--when-idle", "--at", "--version", "--rollback", "--resume", "--cancel", "--status", "--by", "--db", "--id", "--allow-downgrade", "--help"]);
  const unknown = args.filter((arg, i) => arg.startsWith("--") && !known.has(arg) && !["--at", "--version", "--by", "--db", "--id"].includes(args[i - 1] ?? ""));
  if (has("help")) { write(UPDATE_HELP); return 0; }
  if (unknown.length > 0) { write(`Unknown option ${unknown[0]}.\n${UPDATE_HELP}`); return 2; }
  const modes = ["now", "when-idle", "at"].filter(has);
  if (modes.length > 1) { write("Choose one of --now, --when-idle or --at."); return 2; }
  const at = value("at");
  if (has("at") && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at ?? "")) { write("--at takes a time like 03:00."); return 2; }
  const when: When = has("now") ? "now" : has("at") ? "at" : "when-idle";
  const databaseFile = deps.databaseFile ?? value("db") ?? databasePath(process.env, homedir());
  const stateDir = dirname(databaseFile);
  const actor = value("by") ?? userInfo().username;
  const current = deps.current ?? currentRuntime(PACKAGE_VERSION);
  const system = () => deps.system ?? machineSystem();

  if (has("status")) {
    const j = readRuntimeUpdate(stateDir);
    write(j ? `${j.kind === "update" ? "Update" : "Rollback"} ${j.from.version} → ${j.to.version}: ${j.phase}. ${j.detail}` : "No update has run here.");
    return 0;
  }
  if (has("cancel")) { write(requestRuntimeUpdateCancel(stateDir)); return 0; }
  if (has("resume")) {
    // The console's job names its journal: it resumes that update or nothing, then removes its own definition.
    const id = value("id");
    if (has("id") && !/^[a-f0-9-]{36}$/.test(id ?? "")) { write("--id takes the update's id."); return 2; }
    try {
      const outcome = await resumeRuntimeUpdate(stateDir, system(), id);
      write(outcome.message); return outcome.ok ? 0 : 1;
    } finally { if (id !== undefined) retireUpdateJob(id, deps.home); }
  }

  const method = deps.method ?? installMethod(join(current.dist, "bin.js"));
  if (method.kind === "npx") { write("npx runs the latest Toolroll each time, so this one is current. Nothing to update."); return 0; }
  if (method.kind === "source") { write("This Toolroll runs from a source checkout. Update it with git; toolroll update replaces installed releases only."); return 1; }
  if (method.kind === "desktop") { write("This Toolroll is the Toolroll app, which updates as a whole app. Update it from the Toolroll app."); return 1; }

  if (has("rollback")) {
    const last = lastCompletedUpdate(stateDir);
    if (!last) { write("There is no completed update to roll back."); return 1; }
    if (!has("yes")) {
      write(`Roll back ${last.to.version} → ${last.from.version}, with the database as it was before the update (${last.finishedAt?.slice(0, 16).replace("T", " ") ?? "unknown"} UTC).`);
      const since = recordsSince(databaseFile, last.finishedAt ?? last.updatedAt);
      if (since > 0) write(`${since} ledger ${since === 1 ? "entry was" : "entries were"} recorded since then. They are set aside in a backup of the current database, not merged back.`);
      write("New work pauses and running work finishes first. Add --yes to roll back.");
      return 0;
    }
    const outcome = await startRuntimeRollback({ stateDir, databaseFile, current, actor, when }, system());
    write(outcome.message); return outcome.ok ? 0 : 1;
  }

  let version = value("version");
  if (version === undefined) {
    try { version = (await (deps.latest ?? latestVersionNow)()).version; }
    catch (error) { write(`Could not read the latest release: ${(error as Error).message}`); return 1; }
  }
  if (version === current.version) { write(`Toolroll ${version} is current.`); return 0; }
  const downgrade = !isNewer(version, current.version);
  if (downgrade && !has("allow-downgrade")) { write(`Toolroll ${version} is older than ${current.version}. Add --allow-downgrade to go back to it.`); return 1; }
  if (!has("yes")) {
    write(`Update Toolroll ${current.version} → ${version}.`);
    write(`${when === "now" ? "Refuses if any work is running" : when === "at" ? `Waits until ${at}, then pauses new work and lets running work finish` : "Pauses new work and lets running work finish"}; verifies the package came from ap9000/toolroll's publish workflow; backs up and rehearses the database; keeps ${current.version} for toolroll update --rollback.`);
    write("Add --yes to update.");
    return 0;
  }
  if (when === "at") write(`Waiting until ${at}. Keep this running, or schedule it from Settings → Updates in the console.`);
  const outcome = await startRuntimeUpdate({ stateDir, databaseFile, current, actor, version, when, at: at ?? null, allowDowngrade: downgrade }, system());
  write(outcome.message);
  return outcome.ok ? 0 : 1;
}

function recordsSince(databaseFile: string, since: string): number {
  try {
    const db = new (sqlite().DatabaseSync)(databaseFile, { readOnly: true });
    try { return Number(db.prepare("SELECT count(*) n FROM action_ledger WHERE at > ? AND action NOT LIKE 'toolroll %'").get(since)?.["n"] ?? 0); } finally { db.close(); }
  } catch { return 0; }
}
