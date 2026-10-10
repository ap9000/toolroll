/** Check levels: how much of the project check runs after a build.
 *
 * - Quick: a fast check while work is in progress (typecheck plus the tests
 *   near the change). New projects start here.
 * - Full: the project's approved check, as before. Projects that already
 *   had a check keep it.
 * - Off: no check. The result reads Ready for review, with "Checks: Off for this project" underneath.
 *
 * Nothing here needs a new table. A project's level and a task's choice are
 * append-only ledger entries (the newest one wins, and the ledger already
 * says who changed what, when). The quick command is a second approved
 * verification grant with its own digest, kept under a `quick:` key beside
 * the full one, so approving it is the same ceremony as `verify set`. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store, VerifyCommand } from "./store.js";
import { approvalOf } from "./scope.js";

export const CHECK_LEVELS = ["quick", "full", "off"] as const;
export type CheckLevel = (typeof CHECK_LEVELS)[number];
export const isCheckLevel = (value: unknown): value is CheckLevel => typeof value === "string" && (CHECK_LEVELS as readonly string[]).includes(value);
export const CHECK_LEVEL_WORDS: Readonly<Record<CheckLevel, string>> = { quick: "Quick", full: "Full", off: "Off" };
export const CHECK_LEVEL_HINTS: Readonly<Record<CheckLevel, string>> = {
  quick: "A fast check while building: typecheck and the tests near the change.",
  full: "The project's full check after every build.",
  off: "No check. Results are Ready for review, and say no check ran.",
};

/** Ledger actions. The ledger is append-only, so the newest entry is the setting. */
export const PROJECT_LEVEL_ACTION = "check level changed";
export const TASK_LEVEL_ACTION = "task checks chosen";
export const RUN_LEVEL_ACTION = "checks used";

/** The quick command's grant lives beside the full one under its own key. */
export const quickVerifyKey = (repo: string): string => `quick:${repo}`;

export function liveQuickCommand(store: Store, repo: string): VerifyCommand | null {
  return store.liveVerifyCommand(quickVerifyKey(repo));
}

type LedgerRow = { actor: string; at: string; outcome: string };
/** Ledger reads go through the repo index: `repo = ?` (or IS NULL for unplaced work). */
export const repoClause = (repo: string | null): [string, string[]] => repo === null ? ["repo IS NULL", []] : ["repo = ?", [repo]];
export function repoOfRun(store: Store, runId: number): string | null {
  const run = store.getRun(runId);
  return run === null ? null : store.refById(run.taskRef)?.repo ?? null;
}
function newest(store: Store, sql: string, ...params: (string | number)[]): LedgerRow | null {
  const row = store.handle.prepare(sql).get(...params);
  return row === undefined ? null : { actor: String(row["actor"]), at: String(row["at"]), outcome: String(row["outcome"]) };
}

export type ProjectCheckLevel = { level: CheckLevel; setBy: string | null; at: string | null };

/** A project's level. With nothing recorded it is Full: a project that existed
 * before levels keeps exactly the check it had. New projects are stamped Quick
 * when they are added (stampNewProjectLevel). */
export function projectCheckLevel(store: Store, repo: string): ProjectCheckLevel {
  const row = newest(store, "SELECT actor, at, outcome FROM action_ledger WHERE repo = ? AND task_id IS NULL AND action = ? ORDER BY id DESC LIMIT 1", repo, PROJECT_LEVEL_ACTION);
  if (row === null || !isCheckLevel(row.outcome)) return { level: "full", setBy: null, at: null };
  return { level: row.outcome, setBy: row.actor, at: row.at };
}

/** An approver's act: set the project's level. The ledger keeps before → after. */
export function setProjectCheckLevel(store: Store, repo: string, level: CheckLevel, by: string, now: Date): { changed: boolean; before: CheckLevel } {
  const before = projectCheckLevel(store, repo);
  if (before.level === level && before.setBy !== null) return { changed: false, before: before.level };
  store.recordAction({ at: now.toISOString(), actor: by, repo, taskId: null, runId: null, action: PROJECT_LEVEL_ACTION, outcome: level, source: "policy",
    detail: `${CHECK_LEVEL_WORDS[before.level]} → ${CHECK_LEVEL_WORDS[level]}` });
  return { changed: before.level !== level, before: before.level };
}

/** A project added from now on starts on Quick. One that already has a level,
 * or an approved check from before levels existed, is left exactly as it is. */
export function stampNewProjectLevel(store: Store, repo: string, now: Date): boolean {
  const known = newest(store, "SELECT actor, at, outcome FROM action_ledger WHERE repo = ? AND task_id IS NULL AND action = ? LIMIT 1", repo, PROJECT_LEVEL_ACTION);
  if (known !== null) return false;
  const hadCheck = store.handle.prepare("SELECT 1 FROM verify_command WHERE repo = ? LIMIT 1").get(repo) !== undefined;
  if (hadCheck) return false;
  store.recordAction({ at: now.toISOString(), actor: "system", repo, taskId: null, runId: null, action: PROJECT_LEVEL_ACTION, outcome: "quick", source: "policy",
    detail: "New project → Quick" });
  return true;
}

/** A task's own choice, if it made one; a revision inherits the task it revises. */
export function taskCheckLevel(store: Store, taskId: string): CheckLevel | null {
  let id: string | null = taskId;
  for (let depth = 0; id !== null && depth < 64; depth++) {
    const ref = store.lookupRef(id);
    const [where, params] = repoClause(ref?.repo ?? null);
    const row = newest(store, `SELECT actor, at, outcome FROM action_ledger WHERE ${where} AND task_id = ? AND action = ? ORDER BY id DESC LIMIT 1`, ...params, id, TASK_LEVEL_ACTION);
    if (row !== null && isCheckLevel(row.outcome)) return row.outcome;
    id = ref?.revisionOf ?? null;
  }
  return null;
}

/** A filing choice: this task's checks, overriding the project. Fixed once its
 * plan is approved, so what the approver saw is what runs. */
export function setTaskCheckLevel(store: Store, taskId: string, level: CheckLevel, by: string, now: Date): { ok: true } | { ok: false; message: string } {
  const ref = store.lookupRef(taskId);
  if (ref === null) return { ok: false, message: `No task ${taskId}.` };
  if (approvalOf(store.getScope(taskId)).approved) {
    return { ok: false, message: "This task's plan is already approved, so its checks are fixed. File a new task to change them." };
  }
  if (taskCheckLevel(store, taskId) === level) return { ok: true };
  store.recordAction({ at: now.toISOString(), actor: by, repo: ref.repo, taskId, runId: null, action: TASK_LEVEL_ACTION, outcome: level, source: "request",
    detail: `Checks for this task: ${CHECK_LEVEL_WORDS[level]}` });
  return { ok: true };
}

export type EffectiveCheckLevel = { level: CheckLevel; from: "task" | "project" };
export function effectiveCheckLevel(store: Store, repo: string | null, taskId: string | null): EffectiveCheckLevel {
  const own = taskId === null ? null : taskCheckLevel(store, taskId);
  if (own !== null) return { level: own, from: "task" };
  return { level: repo === null ? "full" : projectCheckLevel(store, repo).level, from: "project" };
}

/** The command a level runs. Quick without its own command runs the full one
 * (and says so: the level that ran is Full). Off runs nothing. */
export function checkCommandFor(store: Store, repo: string, level: CheckLevel): { level: CheckLevel; command: VerifyCommand | null } {
  if (level === "off") return { level: "off", command: null };
  if (level === "quick") {
    const quick = liveQuickCommand(store, repo);
    if (quick !== null) return { level: "quick", command: quick };
  }
  return { level: "full", command: store.liveVerifyCommand(repo) };
}

/** Readiness uses the result's level, falling back to the task/project for legacy
 * runs. Quick's approved command (or its Full fallback) is required; Off is not. */
export function requiredCheckCommandFor(store: Store, repo: string | null, taskId: string, level: CheckLevel | null | undefined): VerifyCommand | null {
  return repo === null ? null : checkCommandFor(store, repo, level ?? effectiveCheckLevel(store, repo, taskId).level).command;
}

/** The builder records which level a run used, so its result says it honestly. */
export function recordRunCheckLevel(store: Store, run: { id: number; taskId: string; repo: string | null }, level: CheckLevel, from: EffectiveCheckLevel["from"], now: Date): void {
  store.recordAction({ at: now.toISOString(), actor: "system", repo: run.repo, taskId: run.taskId, runId: run.id, action: RUN_LEVEL_ACTION, outcome: level, source: "work",
    detail: `${CHECK_LEVEL_WORDS[level]} checks (${from === "task" ? "this task's choice" : "project setting"})` });
}

/** The level a finished run's checks used; null for a run from before levels. */
export function runCheckLevel(store: Store, runId: number): CheckLevel | null {
  const [where, params] = repoClause(repoOfRun(store, runId));
  const row = newest(store, `SELECT actor, at, outcome FROM action_ledger WHERE ${where} AND run_id = ? AND action = ? ORDER BY id DESC LIMIT 1`, ...params, runId, RUN_LEVEL_ACTION);
  return row !== null && isCheckLevel(row.outcome) ? row.outcome : null;
}

/** A starting point for the quick command, from the project's own scripts.
 * It is only a suggestion: a person approves the exact command. */
export function suggestQuickCommand(repo: string): string | null {
  const file = join(repo, "package.json");
  if (!existsSync(file)) return null;
  let scripts: Record<string, unknown> = {};
  let deps: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
    deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
  } catch { return null; }
  const has = (name: string) => typeof scripts[name] === "string";
  const runner = existsSync(join(repo, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(repo, "yarn.lock")) ? "yarn" : "npm";
  const run = (name: string) => runner === "npm" ? `npm run ${name}` : `${runner} ${name}`;
  const exec = runner === "npm" ? "npx" : `${runner} exec`;
  const typecheck = ["typecheck", "type-check", "check-types", "tsc"].find(has) ?? null;
  const changed = "$(git diff --name-only HEAD~1)";
  const tests = "vitest" in deps ? `${exec} vitest related --run ${changed}`
    : "jest" in deps ? `${exec} jest --findRelatedTests --passWithNoTests ${changed}` : null;
  const parts = [typecheck === null ? null : run(typecheck), tests].filter((one): one is string => one !== null);
  if (parts.length > 0) return parts.join(" && ");
  return has("lint") ? run("lint") : null;
}

/** "skip the tests", "run the full checks": a filing request in chat, as a level. */
export function checkLevelFromWords(text: string): CheckLevel | null {
  const said = text.toLowerCase().replace(/[’']/g, "'");
  if (/\b(skip|without|no|don't run|do not run|turn off|switch off)\b[^.!?\n]{0,20}\b(the )?(tests|checks)\b/.test(said) || /\b(tests|checks) off\b/.test(said)) return "off";
  if (/\b(full|all the|every|complete)\s+(test|check)s?\b/.test(said)) return "full";
  if (/\bquick\s+(test|check)s?\b/.test(said)) return "quick";
  return null;
}
