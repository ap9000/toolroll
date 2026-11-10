// The phases of a browser deployment's journal, and what a stopped deployment at each one calls for.
//
// The rows are data: src/deploy-phase-data.json, the one authored list. This file reads it for the deploy scripts
// (which run from a commit's own source, without a build); src/deploy-phase.ts reads the same file for the runtime.
// Both check its shape the same way, and src/deploy-phase.test.ts holds them to each other and to its own
// hand-written expectations.
//
//   action      what `toolroll release` does with a deployment that stopped there:
//               "lift-pause" (nothing was stopped), "roll-back" (the previous service goes back),
//               "forward" (the new service may be running: finish it), "none" (nothing is left to do)
//   beforeSwap        the service was never stopped
//   beforePause       journaled before the pause was installed: it may not be in place
//   migrationStarted  the candidate's store opened the live database, or the new service ran on it
//   restartable       the old service is proved stopped: the previous definition may be started again
//   deployed          the deployment finished and its runtime is the installed one
import { readFileSync } from "node:fs";

const ACTIONS = ["none", "lift-pause", "forward", "roll-back"];
const FLAGS = ["beforeSwap", "beforePause", "migrationStarted", "restartable", "deployed"];

/** The rows of a parsed data file, or an Error naming what is wrong with it. Never a partial table. */
export function deployPhaseRows(data) {
  const rows = data?.phases;
  if (!Array.isArray(rows) || rows.length === 0) throw Error("The deployment phase table has no rows.");
  const seen = new Set();
  return Object.freeze(rows.map(row => {
    const { phase, action, flags } = row ?? {};
    if (typeof phase !== "string" || !/^[a-z]+(-[a-z]+)*$/.test(phase) || seen.has(phase)) throw Error(`The deployment phase table has a bad or repeated phase: ${String(phase)}.`);
    if (!ACTIONS.includes(action)) throw Error(`The deployment phase ${phase} has no known action.`);
    if (!Array.isArray(flags) || flags.some(flag => !FLAGS.includes(flag)) || new Set(flags).size !== flags.length) throw Error(`The deployment phase ${phase} has an unknown or repeated flag.`);
    seen.add(phase);
    return Object.freeze({ phase, action, flags: Object.freeze([...flags]) });
  }));
}

const ROWS = deployPhaseRows(JSON.parse(readFileSync(new URL("../src/deploy-phase-data.json", import.meta.url), "utf8")));
const rowOf = phase => typeof phase === "string" ? ROWS.find(row => row.phase === phase) : undefined;
const withFlag = flag => Object.freeze(ROWS.filter(row => row.flags.includes(flag)).map(row => row.phase));
const withAction = action => Object.freeze(ROWS.filter(row => row.action === action).map(row => row.phase));

/** Every phase, in journal order. */
export const DEPLOY_PHASES = Object.freeze(ROWS.map(row => row.phase));
export const isDeployPhase = phase => rowOf(phase) !== undefined;
/** The one action a journal's phase calls for; "refuse" for anything that is not a phase. */
export const deployActionOf = phase => rowOf(phase)?.action ?? "refuse";
/** The word itself, or an Error: a journal is never written with a word the table does not hold. */
export function assertDeployPhase(phase) {
  if (!isDeployPhase(phase)) throw Error(`"${String(phase)}" is not a deployment phase; the journal was not written.`);
  return phase;
}

export const BEFORE_SWAP = withFlag("beforeSwap");
/** Before the swap, with the pause in place. */
export const PAUSED_BEFORE_SWAP = Object.freeze(ROWS.filter(row => row.flags.includes("beforeSwap") && !row.flags.includes("beforePause")).map(row => row.phase));
export const MIGRATION_STARTED = withFlag("migrationStarted");
export const RESTARTABLE = withFlag("restartable");
/** The new service may be running: never rolled back by a journal alone. */
export const FORWARD_ONLY = withAction("forward");
/** Nothing is left to recover. Not the same as deployed: a released deployment never installed its runtime. */
export const NEEDS_NO_RECOVERY = withAction("none");
export const isDeployed = phase => rowOf(phase)?.flags.includes("deployed") === true;
/** Stopped where nothing was changed (before its pause), or with nothing left to do. */
export const stoppedWhereNothingChanged = phase => { const row = rowOf(phase); return row !== undefined && (row.flags.includes("beforePause") || row.action === "none"); };
