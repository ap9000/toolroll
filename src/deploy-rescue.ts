/**
 * `toolroll release --recover-deploy [--stage <dir>] [--yes]`: one command for a browser deployment that stopped half
 * way and could not put itself back (the 2026-10-29 deploy stuck at "stopping": an `up` left running under launchd
 * that ignored SIGTERM, a restart refused while its stale heartbeat lapsed, and every resume refusing "not proved
 * stopped"). It does what was done by hand, through the deployment's own recovery (scripts/deploy-browser.mjs
 * --phase recover, run from the recorded commit's pristine extraction exactly as `toolroll release` resumes one):
 *
 *   - the journal is verified (one unfinished deployment of this database, its run recorded) under the deployment lock
 *   - when the journal says the old service must be stopped, recovery requires proof it already exited; historical
 *     PIDs and argv never authorize signals or booting out a currently loaded service. Remaining processes must be
 *     stopped through their owner before recovery can resume.
 *   - the previous service is started again (the verified backup first when the database was migrated past it) and
 *     waited for past a stale worker heartbeat's window, then the deployment's update pause is lifted
 *
 * A journal at or past the new service's start is never touched here: the new service may be running, and the
 * release resumes it forward. Finished journals need nothing. Run again after a refusal or a failure: every step
 * re-proves itself, so a rerun does only what is still left.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { BEFORE_SWAP } from "./release-gate.js";

/** Phases where the new service may be running: recovery leaves them to the release, which resumes forward. */
export const FORWARD_ONLY = Object.freeze(["starting", "started", "healthy"]);
const FINISHED = Object.freeze(["released", "deployed"]);

export type RescueWorld = {
  /** The live database. */
  database: string;
  /** The installation's state folder: deployments stage under staged-upgrades/ there. */
  stateDir: string;
  /** Every deployment journal under staged-upgrades/: its stage and contents, null when unreadable. */
  journals(): { stage: string; journal: Record<string, unknown> | null }[];
  /** The builder run's worktree, from the plane's records (the deploy script's --source), or null. */
  runWorktree(run: number): string | null;
  /** The deployment's own recovery for that stage (release-adapters.ts recoverDeploy). */
  recover(input: { run: number; worktree: string; stage: string }): Promise<{ ok: true } | { ok: false; message: string }>;
};

export type RescueOutcome =
  | { ok: true; acted: boolean; stage: string | null; phase: string | null; words: string[] }
  | { ok: false; reason: "usage" | "conflict" | "damaged" | "forward" | "failed"; message: string };

const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

/** What recovery will do from a phase, in a few words. */
export function rescuePlan(phase: string, journal: Record<string, unknown>): string[] {
  const id = String(journal["id"] ?? "?"), prior = String(journal["priorRuntime"] ?? "?");
  if (BEFORE_SWAP.includes(phase)) return [`The service was never stopped. Lifts update pause ${id}, if this deployment holds it.`];
  if (phase === "restored") return [`The previous service is already running again. Lifts update pause ${id}.`];
  const words: string[] = [];
  if (phase === "stopping") {
    words.push("The old service must already be stopped. Recovery checks for remaining processes and refuses while any may still be running. Stop them through the service owner, then rerun recovery.");
  }
  if (["stopping", "stopped", "migrating", "migrated", "start-failed", "backup-restored"].includes(phase)) {
    if (["migrating", "migrated", "start-failed"].includes(phase)) words.push("Puts the verified backup back first when the previous runtime can't read the migrated database.");
    words.push(`Starts the previous service (${prior}) again and waits for it to answer, past a stopped worker's heartbeat window; then lifts update pause ${id}.`);
  }
  return words.length > 0 ? words : [`Journal phase ${phase}: the deployment's own recovery decides; it refuses anything it can't prove.`];
}

/** Find the one unfinished deployment (or the named stage), verify its journal, and recover it (with `yes`). */
export async function rescueDeployment(stageArg: string | undefined, yes: boolean, world: RescueWorld): Promise<RescueOutcome> {
  const all = world.journals();
  let chosen: { stage: string; journal: Record<string, unknown> | null } | undefined;
  if (stageArg !== undefined) {
    chosen = all.find(one => real(one.stage) === real(stageArg));
    if (chosen === undefined) return { ok: false, reason: "usage", message: `${stageArg} is not a deployment stage of this installation (under ${join(world.stateDir, "staged-upgrades")}).` };
  } else {
    const open = all.filter(one => one.journal === null || !FINISHED.includes(String(one.journal["phase"])));
    if (open.length === 0) return { ok: true, acted: false, stage: null, phase: null, words: ["Nothing to recover: every deployment finished or was already put back."] };
    if (open.length > 1) return { ok: false, reason: "conflict", message: `${open.length} deployments are unfinished: ${open.map(one => one.stage).join(", ")}. Name one with --stage <dir>.` };
    chosen = open[0]!;
  }
  const { stage, journal } = chosen;
  if (journal === null) return { ok: false, reason: "damaged", message: `${join(stage, "deployment.json")} can't be read; nothing was changed.` };
  const phase = journal["phase"], run = journal["builder"];
  if (typeof phase !== "string" || typeof journal["priorRuntime"] !== "string" || typeof journal["nextRuntime"] !== "string" || typeof journal["id"] !== "string") {
    return { ok: false, reason: "damaged", message: `${join(stage, "deployment.json")} is missing its phase, runtimes or update id; nothing was changed.` };
  }
  if (journal["database"] !== world.database) return { ok: false, reason: "conflict", message: `That deployment ran on ${String(journal["database"])}, not ${world.database}; nothing was changed.` };
  if (!Number.isSafeInteger(run) || (run as number) < 1) return { ok: false, reason: "damaged", message: `${join(stage, "deployment.json")} names no builder run, so its commit's recovery can't be found; nothing was changed.` };
  if (FINISHED.includes(phase)) return { ok: true, acted: false, stage, phase, words: [`Nothing to recover: that deployment is ${phase}.`] };
  if (FORWARD_ONLY.includes(phase)) {
    return { ok: false, reason: "forward", message: `That deployment is at ${phase}: the new service may be running, so nothing was stopped. Continue it forward with \`toolroll release <branch>\` (it resumes the deployment's finish).` };
  }
  const plan = rescuePlan(phase, journal);
  if (!yes) return { ok: true, acted: false, stage, phase, words: [`Deployment ${String(journal["id"])} stopped at ${phase} (${stage}).`, ...plan, "Run it: toolroll release --recover-deploy --yes"] };
  const worktree = world.runWorktree(run as number);
  if (worktree === null) return { ok: false, reason: "damaged", message: `Run ${String(run)} has no recorded worktree, so its commit's recovery can't run; nothing was changed.` };
  const recovered = await world.recover({ run: run as number, worktree, stage });
  const after = world.journals().find(one => one.stage === stage)?.journal ?? null;
  const now = typeof after?.["phase"] === "string" ? after["phase"] : null;
  if (!recovered.ok) return { ok: false, reason: "failed", message: `${recovered.message}${now === null ? "" : ` The journal is at ${now}.`} Fix what it names, then run \`toolroll release --recover-deploy --yes\` again.` };
  return { ok: true, acted: true, stage, phase: now, words: [now === "released" ? "The previous service is running and new work can start again." : `The deployment's recovery finished; its journal is at ${now ?? "an unreadable phase"}.`] };
}
