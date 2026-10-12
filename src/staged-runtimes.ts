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
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { quarantine, quarantineEntries, claimQuarantine, releaseQuarantine, restoreQuarantine, deleteQuarantineSync, type Quarantine } from "./sweep-quarantine.js";
import { processCensus, type ProcessRow } from "./run-closeout.js";

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
    stages.push(readStage(path, name));
  }
  return stages.sort((a, b) => b.at - a.at);
}

function readStage(path: string, name: string, fallbackAt?: number): Stage {
  const deploy = name.startsWith("browser-") ? readJson(join(path, "deployment.json")) : null;
  const update = name.startsWith("release-") ? readJson(join(path, "update.json")) : null;
  const journal = deploy ?? update;
  const stamp = String(journal?.["deployedAt"] ?? journal?.["startedAt"] ?? journal?.["createdAt"] ?? "");
  let at = Date.parse(stamp);
  if (!Number.isFinite(at)) { try { at = fallbackAt ?? statSync(path).mtimeMs; } catch { at = 0; } }
  const finished = deploy !== null ? deploy["phase"] === "deployed" : update !== null ? typeof update["finishedAt"] === "string" : false;
  const from = update?.["from"] as { dist?: unknown } | undefined;
  const prior = typeof deploy?.["priorRuntime"] === "string" ? deploy["priorRuntime"] : typeof from?.dist === "string" ? from.dist : null;
  let keptAside = false;
  try { keptAside = readdirSync(path).some(one => /^orders\.(?:kept|unreadable)\./.test(one)); } catch { keptAside = true; }
  return { path, name, at, finished, prior, keptAside };
}

/** Where the CLI links usually are (link.ts, an npm or Homebrew global), on PATH or not: a launchd worker's PATH is short. */
function linkFolders(home: string): string[] {
  return [join(home, ".local", "bin"), join(home, "bin"), "/usr/local/bin", "/opt/homebrew/bin"];
}

/**
 * Paths a runtime may be running from: the launchd services' definitions, every `toolroll` (or older
 * `standing-orders`) command on PATH, in the usual link folders or under nvm (a link counts by its target), this
 * process, and `extra`.
 */
export function runtimesInUse(extra: readonly string[] = [], home = homedir(), path = process.env["PATH"] ?? "", stateDir?: string): string[] {
  const found = [...extra];
  const agents = join(home, "Library", "LaunchAgents");
  try {
    for (const name of readdirSync(agents).filter(one => one.startsWith("com.toolroll.") || one.startsWith("com.standing-orders."))) {
      for (const match of readFileSync(join(agents, name), "utf8").matchAll(/<string>([^<]*staged-upgrades[^<]*)<\/string>/g)) found.push(match[1]!);
    }
  } catch { /* no launch agents here */ }
  const commands = [...new Set([...path.split(":").filter(Boolean), ...linkFolders(home)])].flatMap(dir => ["toolroll", "standing-orders"].map(bin => join(dir, bin)));
  try { for (const version of readdirSync(join(home, ".nvm", "versions", "node"))) for (const bin of ["toolroll", "standing-orders"]) commands.push(join(home, ".nvm", "versions", "node", version, "bin", bin)); } catch { /* no nvm */ }
  for (const command of commands) {
    try { lstatSync(command); found.push(command); } catch { continue; /* not there */ }
    // A link counts by its target, even one that doesn't resolve now.
    try { found.push(resolve(dirname(command), readlinkSync(command))); } catch { /* not a link */ }
  }
  if (process.argv[1] !== undefined) found.push(process.argv[1]);
  if (stateDir !== undefined) found.push(...runtimeScriptPaths(stateDir));
  return found;
}

/** Retain only recognized Toolroll entry scripts in candidate stages, never complete argv. ps is asked only
 * for Node/Toolroll processes; /proc supplies NUL-separated argv on Linux. Fail closed with a fixed message,
 * since an execFileSync exception can otherwise contain private argument text in stdout/stderr. */
export function runtimeScriptPaths(stateDir: string, onlyPids?: readonly number[], observations: {
  census?: () => ProcessRow[]; argv?: (pids: readonly number[]) => string[];
} = {}): string[] {
  const stages = stagedRuntimes(stateDir);
  const trash = quarantineEntries<Stage>(real(join(stateDir, STAGED_FOLDER)));
  const bases = new Set(stages.flatMap(one => [one.path, join(stateDir, STAGED_FOLDER, one.name)]));
  for (const one of trash) { bases.add(one.path); bases.add(one.original); bases.add(join(stateDir, STAGED_FOLDER, one.journal.name)); }
  if (bases.size === 0 || process.platform === "win32") return [];
  const scripts = new Set<string>();
  const collect = (args: string) => {
    for (const base of bases) {
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // All supported installs: runtime/dist, runtime/node_modules/{toolroll,standing-orders}/dist,
      // or dist directly under a release stage. Matching a known base handles spaces without logging argv.
      const pattern = new RegExp(`(?:^|[\\s\\0"'])(${escaped}/(?:runtime/)?(?:node_modules/(?:toolroll|standing-orders)/)?dist/(?:cli|bin|storage-sweep-child)\\.js)(?=$|[\\s\\0"'])`, "g");
      for (const match of args.matchAll(pattern)) scripts.add(match[1]!);
    }
  };
  try {
    const pids = (observations.census ?? processCensus)().filter(row => /^(?:node(?:js)?|toolroll|standing-orders)(?:\.exe)?$/.test(row.name) &&
      (onlyPids === undefined || onlyPids.includes(row.pid))).map(row => row.pid);
    if (observations.argv !== undefined) {
      for (const args of observations.argv(pids)) collect(args);
    } else if (process.platform === "linux") {
      for (const pid of pids) {
        try { collect(readFileSync(`/proc/${pid}/cmdline`, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    } else {
      for (let at = 0; at < pids.length; at += 200) {
        try {
          collect(execFileSync("/bin/ps", ["-ww", "-p", pids.slice(at, at + 200).join(","), "-o", "args="], {
            encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
          }));
        } catch (error) {
          // ps exits 1 when every requested process has just gone. Any other failure keeps stages.
          if ((error as { status?: number }).status !== 1) throw error;
        }
      }
    }
  } catch { throw new Error("Toolroll runtime process paths could not be read"); }
  return [...scripts];
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
  const trash = quarantineEntries<Stage>(real(join(stateDir, STAGED_FOLDER)));
  // A renamed stage still has its original identity for current/previous/newest protection, including a CLI
  // symlink switched just before rename. Partial-delete journals retain this identity for the next retry.
  for (const one of trash) if (!stages.some(stage => stage.path === one.original)) {
    const facts = one.journal.deleting ? one.journal.data : readStage(one.path, one.journal.name, one.journal.data.at);
    stages.push({ ...facts, path: one.original });
  }
  stages.sort((a, b) => b.at - a.at);
  const paths = inUse.map(path => {
    const moved = trash.find(one => path === one.path || path.startsWith(one.path + sep));
    return moved === undefined ? path : moved.original + path.slice(moved.path.length);
  });
  const keep = new Map<string, StageKeep>();
  const current = paths.map(path => stageOf(stages, path)).filter((one): one is Stage => one !== null);
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
 * Remove the stages that go. Right before each goes, the plan is made again (what's in use now), nothing live may use
 * it (`spare`, storage-sweep.ts) and the stage must still be a real folder directly in staged-upgrades.
 */
export function pruneStagedRuntimes(stateDir: string, now: Date, options: {
  inUse?: () => string[]; remove?: (path: string) => void; spare?: (path: string) => boolean;
  /** Deterministic race seam, not supplied by production callers. */
  quarantined?: (original: string, trash: string) => void;
} = {}): StagePrune {
  const inUse = options.inUse ?? (() => runtimesInUse([], undefined, undefined, stateDir));
  const root = real(join(stateDir, STAGED_FOLDER));
  const removed: string[] = [];
  const failed: string[] = [];
  const finish = (trash: Quarantine<Stage>) => {
    try {
      options.quarantined?.(trash.original, trash.path);
      const again = stagePlan(stateDir, inUse(), now);
      if (again.refused !== null || !again.go.some(one => one.path === trash.original) || options.spare?.(trash.original) === true || options.spare?.(trash.path) === true) {
        if (!restoreQuarantine(trash)) failed.push(trash.original);
        return;
      }
      deleteQuarantineSync(trash, options.remove ?? (path => rmSync(path, { recursive: true, force: true, maxRetries: 3 })));
      removed.push(trash.original);
    } catch { failed.push(trash.original); }
    finally { releaseQuarantine(trash); }
  };
  for (const entry of quarantineEntries<Stage>(root)) {
    const claimed = claimQuarantine(entry);
    if (claimed !== null) finish(claimed);
  }
  const first = stagePlan(stateDir, inUse(), now);
  if (first.refused !== null) return { removed, failed, refused: first.refused };
  for (const one of first.go) {
    const again = stagePlan(stateDir, inUse(), now);
    if (again.refused !== null || !again.go.some(other => other.path === one.path) || options.spare?.(one.path) === true) continue;
    try {
      if (lstatSync(one.path).isSymbolicLink() || dirname(one.path) !== root) continue;
      const trash = quarantine(one.path, one);
      if (trash !== null) finish(trash);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed.push(one.path); }
  }
  return { removed, failed, refused: null };
}
