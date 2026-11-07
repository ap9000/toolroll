/**
 * What `toolroll release <branch>` does before its journal's next step (docs/plans/plain-toolroll.md P2.6): one command,
 * so a person never chooses between --recover-deploy, --release-gate and rerunning.
 *
 * - **Another run**: a run lock per branch, by host and pid. A live one is waited for, named; two coordinators never act
 *   on one release at once. A lock whose process is proved gone on this host is taken over.
 * - **A deployment left open**: the journal decides. Before the swap: its pause is lifted, once proved. Past the new
 *   service's start: forward, by the release. Between: rolled back through its own recovery. Each of those re-proves
 *   itself, so a crash at any phase ends the same on the next run.
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { FORWARD_ONLY, rescueDeployment, type RescueWorld } from "./deploy-rescue.js";
import { BEFORE_SWAP, releaseGate, type GateReleaseWorld } from "./release-gate.js";
import { journalFile, readJournal, type ReleaseJournal } from "./release.js";
import { autoPublishHeld, PUBLISH_ALLOWED_ACTION } from "./release-auto.js";
import type { Store } from "./store.js";
import { sameMachineHost } from "./machine-identity.js";

const lockFile = (stateDir: string, branch: string): string => journalFile(stateDir, branch).replace(/\.json$/, ".running");
/** How long a run waits for another before it says so and stops. */
export const RELEASE_WAIT_MS = 30 * 60_000;

export type RunHolder = { host: string; pid: number };
export type RunLockSeams = { host?: string; pid?: number; alive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void>; now?: () => number; waitMs?: number; pollMs?: number };

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

function readHolder(file: string): RunHolder | null {
  try {
    const read = JSON.parse(readFileSync(file, "utf8")) as { host?: unknown; pid?: unknown };
    return typeof read.host === "string" && Number.isSafeInteger(read.pid) ? { host: read.host, pid: read.pid as number } : null;
  } catch { return null; }
}

/** Take this branch's run lock, waiting for a live holder. Answers how to give it back, or who kept it. */
export async function takeReleaseRun(stateDir: string, branch: string, say: (line: string) => void, seams: RunLockSeams = {}): Promise<{ ok: true; release: () => void } | { ok: false; holder: RunHolder }> {
  const file = lockFile(stateDir, branch);
  const host = seams.host ?? hostname(), pid = seams.pid ?? process.pid;
  const alive = seams.alive ?? processAlive, sleep = seams.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const now = seams.now ?? Date.now;
  const deadline = now() + (seams.waitMs ?? RELEASE_WAIT_MS);
  mkdirSync(dirname(file), { recursive: true });
  let said = false;
  for (;;) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try { writeSync(fd, JSON.stringify({ host, pid })); } finally { closeSync(fd); }
      return { ok: true, release: () => { const mine = readHolder(file); if (mine?.pid === pid && mine.host === host) rmSync(file, { force: true }); } };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const holder = readHolder(file);
    // A lock with no readable holder, or a process proved gone on this computer, holds nothing. Another computer's can't
    // be proved gone from here, so it is waited for.
    if (holder === null || (sameMachineHost(holder.host, host) && !alive(holder.pid))) { rmSync(file, { force: true }); continue; }
    if (!said) { say(`Waiting: another release of ${branch} is running on ${holder.host} (process ${holder.pid}).`); said = true; }
    if (now() >= deadline) return { ok: false, holder };
    await sleep(seams.pollMs ?? 5_000);
  }
}

export type SettleWorld = { rescue: RescueWorld; gate: GateReleaseWorld };
export type DeployAction = "none" | "lift-pause" | "forward" | "roll-back" | "refuse";

/** The one action a deployment's journal calls for. */
export function deployActionOf(phase: unknown): DeployAction {
  if (typeof phase !== "string") return "refuse";
  if (phase === "released" || phase === "deployed") return "none";
  if (BEFORE_SWAP.includes(phase)) return "lift-pause";
  if (FORWARD_ONLY.includes(phase)) return "forward";
  return "roll-back";
}

/** Settle what a stopped deployment left, saying what was done. A refusal stops the release before it does anything. */
export async function settleDeployment(world: SettleWorld, say: (line: string) => void): Promise<{ ok: true } | { ok: false; message: string }> {
  const open = world.rescue.journals().filter(one => deployActionOf(one.journal?.["phase"]) !== "none");
  if (open.length === 0) return { ok: true };
  if (open.length > 1) return { ok: false, message: `${open.length} deployments are unfinished: ${open.map(one => one.stage).join(", ")}. Nothing was changed.` };
  const { stage, journal } = open[0]!;
  const action = deployActionOf(journal?.["phase"]);
  if (action === "refuse") return { ok: false, message: `The deployment journal in ${stage} can't be read. Nothing was changed.` };
  if (action === "forward") { say("Finishing the deployment that was under way."); return { ok: true }; }
  if (action === "lift-pause") {
    const lifted = releaseGate(String(journal?.["id"] ?? ""), world.gate, true);
    if (!lifted.ok) return { ok: false, message: lifted.message };
    say("Lifted the pause an unfinished deployment left before its swap.");
    return { ok: true };
  }
  const back = await rescueDeployment(stage, true, world.rescue);
  if (!back.ok) return { ok: false, message: back.message };
  say("Put back the deployment that stopped half way.");
  return { ok: true };
}

// ---- a held release resumes itself -----------------------------------------------------------------------------------

export const RELEASE_RESUMED_ACTION = "release resumed";

/**
 * A person let a held release go on (release-auto.ts allowAutoPublish; the Release sheet's button or `publish-ok`): each
 * sweep, its journal goes on from where it stopped, once per that person's act, under the same run lock. It was merged
 * already, so only the tag, publication and Homebrew are left, and each re-proves itself.
 */
export async function resumeAllowedReleases(store: Store, stateDir: string, run: (journal: ReleaseJournal) => Promise<unknown>, now: Date): Promise<number> {
  let folder: string[];
  try { folder = readdirSync(join(stateDir, "releases")).filter(name => name.endsWith(".json") && !name.includes(".superseded-")); } catch { return 0; }
  let resumed = 0;
  for (const name of folder) {
    const journal = readJournal(join(stateDir, "releases", name));
    if (journal === null || !["tag", "publish", "homebrew"].includes(journal.step) || autoPublishHeld(store, journal.task.id) !== null) continue;
    const allowed = store.handle.prepare("SELECT id FROM action_ledger WHERE task_id = ? AND action = ? ORDER BY id DESC LIMIT 1").get(journal.task.id, PUBLISH_ALLOWED_ACTION);
    if (allowed === undefined) continue;
    // Once per act: a resume that stops again waits for a person, never for the next sweep.
    const done = store.handle.prepare("SELECT 1 AS hit FROM action_ledger WHERE task_id = ? AND action = ? AND outcome = ?").get(journal.task.id, RELEASE_RESUMED_ACTION, String(allowed["id"]));
    if (done !== undefined) continue;
    const taken = await takeReleaseRun(stateDir, journal.branch, () => {}, { waitMs: 0 });
    if (!taken.ok) continue;
    try {
      store.recordAction({ at: now.toISOString(), actor: "system", repo: store.lookupRef(journal.task.id)?.repo ?? null, taskId: journal.task.id, runId: null, action: RELEASE_RESUMED_ACTION, outcome: String(allowed["id"]), source: "work", detail: journal.tag });
      await run(journal);
      resumed++;
    } finally { taken.release(); }
  }
  return resumed;
}
