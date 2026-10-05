/**
 * Staged runtimes (`staged-upgrades/`): each deploy (scripts/deploy-browser.mjs, `browser-*`) and each `toolroll
 * update` (`release-*`) stages a whole runtime, a few hundred MB with its database backup. Oct 4: 9 of them, 2.2 GB.
 *
 * Kept: the current runtime (one the service, a `toolroll` command or this process runs from), the one before it
 * (its journal's way back), the newest stage, a deploy or update still under way (no finished journal) for a week,
 * and a stage holding a database a failed update kept aside. Everything else of those two kinds goes — after a deploy
 * and in the plane's daily storage sweep. `rollback-*` records and anything else in the folder are never touched.
 * With no current runtime found, nothing goes: which one is safe to remove is then unknown.
 */
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const DAY_MS = 86_400_000;
/** A deploy or update that never finished keeps its stage this long (it may be resumed). */
export const UNFINISHED_KEEP_MS = 7 * DAY_MS;
export const STAGED_FOLDER = "staged-upgrades";

export type Stage = { path: string; name: string; at: number; finished: boolean; prior: string | null; keptAside: boolean };
export type StageKeep = "current" | "previous" | "newest" | "under way" | "kept-aside database";
export type StagePlan = { keep: { path: string; why: StageKeep }[]; go: Stage[]; refused: string | null };

/** The canonical path, even of something that doesn't exist (yet): its nearest existing folder, resolved, plus the rest. */
function real(path: string): string {
  let at = resolve(path);
  const rest: string[] = [];
  for (let hops = 0; hops < 256; hops++) {
    try { return join(realpathSync(at), ...rest.reverse()); } catch { /* not there */ }
    const up = dirname(at);
    if (up === at) break;
    rest.push(basename(at));
    at = up;
  }
  return resolve(path);
}
const readJson = (file: string): Record<string, unknown> | null => {
  try { const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown; return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : null; } catch { return null; }
};

/** The `browser-*` and `release-*` stages: real folders directly in staged-upgrades, newest first. */
export function stagedRuntimes(stateDir: string): Stage[] {
  const root = real(join(stateDir, STAGED_FOLDER));
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  const stages: Stage[] = [];
  for (const name of names) {
    if (!/^(browser|release)-/.test(name)) continue;
    const path = join(root, name);
    try { if (!lstatSync(path).isDirectory()) continue; } catch { continue; }
    const deploy = name.startsWith("browser-") ? readJson(join(path, "deployment.json")) : null;
    const update = name.startsWith("release-") ? readJson(join(path, "update.json")) : null;
    const journal = deploy ?? update;
    const stamp = String(journal?.["deployedAt"] ?? journal?.["startedAt"] ?? journal?.["createdAt"] ?? "");
    let at = Date.parse(stamp);
    if (!Number.isFinite(at)) { try { at = statSync(path).mtimeMs; } catch { at = 0; } }
    const finished = deploy !== null ? deploy["phase"] === "deployed" : update !== null ? typeof update["finishedAt"] === "string" : false;
    const from = update?.["from"] as { dist?: unknown } | undefined;
    const prior = typeof deploy?.["priorRuntime"] === "string" ? deploy["priorRuntime"] : typeof from?.dist === "string" ? from.dist : null;
    let keptAside = false;
    try { keptAside = readdirSync(path).some(one => /^orders\.(?:kept|unreadable)\./.test(one)); } catch { keptAside = true; }
    stages.push({ path, name, at, finished, prior, keptAside });
  }
  return stages.sort((a, b) => b.at - a.at);
}

/**
 * Paths a runtime may be running from: the launchd services' definitions, every `toolroll` (or older
 * `standing-orders`) command on PATH or under nvm, this process, and `extra`.
 */
export function runtimesInUse(extra: readonly string[] = [], home = homedir(), path = process.env["PATH"] ?? ""): string[] {
  const found = [...extra];
  const agents = join(home, "Library", "LaunchAgents");
  try {
    for (const name of readdirSync(agents).filter(one => one.startsWith("com.toolroll.") || one.startsWith("com.standing-orders."))) {
      for (const match of readFileSync(join(agents, name), "utf8").matchAll(/<string>([^<]*staged-upgrades[^<]*)<\/string>/g)) found.push(match[1]!);
    }
  } catch { /* no launch agents here */ }
  const commands = path.split(":").filter(Boolean).flatMap(dir => ["toolroll", "standing-orders"].map(bin => join(dir, bin)));
  try { for (const version of readdirSync(join(home, ".nvm", "versions", "node"))) for (const bin of ["toolroll", "standing-orders"]) commands.push(join(home, ".nvm", "versions", "node", version, "bin", bin)); } catch { /* no nvm */ }
  for (const command of commands) { try { lstatSync(command); found.push(command); } catch { /* not there */ } }
  if (process.argv[1] !== undefined) found.push(process.argv[1]);
  return found;
}

/** The stage `path` lies in, or null. */
function stageOf(stages: readonly Stage[], path: string | null | undefined): Stage | null {
  if (path === null || path === undefined || path === "") return null;
  for (const at of new Set([resolve(path), real(path)])) {
    for (const stage of stages) for (const base of new Set([stage.path, real(stage.path)])) {
      if (at === base || at.startsWith(base + sep)) return stage;
    }
  }
  return null;
}

/** What stays and what goes now, and why. */
export function stagePlan(stateDir: string, inUse: readonly string[], now: Date): StagePlan {
  const stages = stagedRuntimes(stateDir);
  const keep = new Map<string, StageKeep>();
  const current = inUse.map(path => stageOf(stages, path)).filter((one): one is Stage => one !== null);
  if (stages.length > 0 && current.length === 0) return { keep: [], go: [], refused: "no staged runtime is in use, so which one runs now is unknown" };
  for (const one of current) keep.set(one.path, "current");
  for (const one of current) {
    const prior = stageOf(stages, one.prior) ?? stages.find(other => other.finished && other.path !== one.path && other.at < one.at) ?? null;
    if (prior !== null && !keep.has(prior.path)) keep.set(prior.path, "previous");
  }
  if (stages[0] !== undefined && !keep.has(stages[0].path)) keep.set(stages[0].path, "newest");
  for (const one of stages) {
    if (keep.has(one.path)) continue;
    if (one.keptAside) keep.set(one.path, "kept-aside database");
    else if (!one.finished && now.getTime() - one.at < UNFINISHED_KEEP_MS) keep.set(one.path, "under way");
  }
  return { keep: [...keep].map(([path, why]) => ({ path, why })), go: stages.filter(one => !keep.has(one.path)), refused: null };
}

export type StagePrune = { removed: string[]; failed: string[]; refused: string | null };

/**
 * Remove the stages that go. Right before each goes, the plan is made again (what's in use now) and the stage must
 * still be a real folder directly in staged-upgrades.
 */
export function pruneStagedRuntimes(stateDir: string, now: Date, options: { inUse?: () => string[]; remove?: (path: string) => void } = {}): StagePrune {
  const inUse = options.inUse ?? (() => runtimesInUse());
  const first = stagePlan(stateDir, inUse(), now);
  if (first.refused !== null) return { removed: [], failed: [], refused: first.refused };
  const root = real(join(stateDir, STAGED_FOLDER));
  const removed: string[] = [];
  const failed: string[] = [];
  for (const one of first.go) {
    const again = stagePlan(stateDir, inUse(), now);
    if (again.refused !== null || !again.go.some(other => other.path === one.path)) continue;
    try {
      if (lstatSync(one.path).isSymbolicLink() || dirname(one.path) !== root) continue;
      (options.remove ?? (path => rmSync(path, { recursive: true, force: true, maxRetries: 3 })))(one.path);
      removed.push(one.path);
    } catch { failed.push(one.path); }
  }
  return { removed, failed, refused: null };
}
