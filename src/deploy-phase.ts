/**
 * The phases of a browser deployment's journal, and what a stopped deployment at each one calls for.
 *
 * The rows are data: deploy-phase-data.json beside this file, the one authored list (the build copies it into dist,
 * scripts/postbuild.mjs). The deploy scripts read the same file through scripts/deploy-phase-table.mjs, where each
 * column is described. Both sides check its shape the same way; deploy-phase.test.ts holds them to each other and to
 * its own hand-written expectations.
 */
import { readFileSync } from "node:fs";

/** What `toolroll release` does with a deployment that stopped at a phase; "refuse" for a word that is no phase. */
export type DeployAction = "none" | "lift-pause" | "forward" | "roll-back" | "refuse";
type RowAction = Exclude<DeployAction, "refuse">;
type Flag = "beforeSwap" | "beforePause" | "migrationStarted" | "restartable" | "deployed";
type Row = { readonly phase: string; readonly action: RowAction; readonly flags: readonly Flag[] };

const ACTIONS: readonly string[] = ["none", "lift-pause", "forward", "roll-back"];
const FLAGS: readonly string[] = ["beforeSwap", "beforePause", "migrationStarted", "restartable", "deployed"];

/** The rows of a parsed data file, or an Error naming what is wrong with it. Never a partial table. */
export function deployPhaseRows(data: unknown): readonly Row[] {
  const rows = (data as { phases?: unknown } | null)?.phases;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("The deployment phase table has no rows.");
  const seen = new Set<string>();
  return Object.freeze(rows.map((row: unknown) => {
    const { phase, action, flags } = (row ?? {}) as { phase?: unknown; action?: unknown; flags?: unknown };
    if (typeof phase !== "string" || !/^[a-z]+(-[a-z]+)*$/.test(phase) || seen.has(phase)) throw new Error(`The deployment phase table has a bad or repeated phase: ${String(phase)}.`);
    if (typeof action !== "string" || !ACTIONS.includes(action)) throw new Error(`The deployment phase ${phase} has no known action.`);
    if (!Array.isArray(flags) || flags.some(flag => typeof flag !== "string" || !FLAGS.includes(flag)) || new Set(flags).size !== flags.length) throw new Error(`The deployment phase ${phase} has an unknown or repeated flag.`);
    seen.add(phase);
    return Object.freeze({ phase, action: action as RowAction, flags: Object.freeze([...flags] as Flag[]) });
  }));
}

const ROWS = deployPhaseRows(JSON.parse(readFileSync(new URL("./deploy-phase-data.json", import.meta.url), "utf8")));
const rowOf = (phase: unknown): Row | undefined => typeof phase === "string" ? ROWS.find(row => row.phase === phase) : undefined;
const withFlag = (flag: Flag): readonly string[] => Object.freeze(ROWS.filter(row => row.flags.includes(flag)).map(row => row.phase));
const withAction = (action: RowAction): readonly string[] => Object.freeze(ROWS.filter(row => row.action === action).map(row => row.phase));

/** Every phase, in journal order. */
export const DEPLOY_PHASES: readonly string[] = Object.freeze(ROWS.map(row => row.phase));
export const isDeployPhase = (phase: unknown): phase is string => rowOf(phase) !== undefined;
/** The one action a journal's phase calls for; "refuse" for anything that is not a phase. */
export const deployActionOf = (phase: unknown): DeployAction => rowOf(phase)?.action ?? "refuse";
/** The word itself, or an Error: a journal is never written with a word the table does not hold. */
export function assertDeployPhase(phase: string): string {
  if (!isDeployPhase(phase)) throw new Error(`"${String(phase)}" is not a deployment phase; the journal was not written.`);
  return phase;
}

/** The service was never stopped. */
export const BEFORE_SWAP = withFlag("beforeSwap");
/** Before the swap, with the pause in place. */
export const PAUSED_BEFORE_SWAP: readonly string[] = Object.freeze(ROWS.filter(row => row.flags.includes("beforeSwap") && !row.flags.includes("beforePause")).map(row => row.phase));
/** The candidate's store opened the live database, or the new service ran on it. */
export const MIGRATION_STARTED = withFlag("migrationStarted");
/** The old service is proved stopped: the previous definition may be started again. */
export const RESTARTABLE = withFlag("restartable");
/** The new service may be running: never rolled back by a journal alone. */
export const FORWARD_ONLY = withAction("forward");
/** Nothing is left to recover. Not the same as deployed: a released deployment never installed its runtime. */
export const NEEDS_NO_RECOVERY = withAction("none");
/** The deployment finished and its runtime is the installed one. */
export const isDeployed = (phase: unknown): boolean => rowOf(phase)?.flags.includes("deployed") === true;
/** Stopped where nothing was changed (before its pause), or with nothing left to do. */
export const stoppedWhereNothingChanged = (phase: unknown): boolean => { const row = rowOf(phase); return row !== undefined && (row.flags.includes("beforePause") || row.action === "none"); };
/** The phase a lifted pause leaves behind (release-gate.ts). */
export const RELEASED = assertDeployPhase("released");
