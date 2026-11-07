/** Local desktop readiness, not a permission grant or task execution. */
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, opendirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run, type ExecResult } from "./exec.js";
import { checkoutGitSync, checkoutTop } from "./teardown-git.js";

export type DesktopProjectAccess = { repo: string; state: "ready" | "permission-needed" | "missing" | "unavailable" | "checking"; message: string };
export type DesktopAccessReport = { version: 1; controllerPid: number; checkedAt: string; request: string; projects: DesktopProjectAccess[] };

export function accessFailure(repo: string, code: unknown): DesktopProjectAccess {
  if (code === "EROFS") return { repo, state: "permission-needed", message: "This project is on a read-only drive. Choose a writable copy; Privacy Settings cannot make a read-only drive writable." };
  if (code === "EPERM" || code === "EACCES") return { repo, state: "permission-needed", message: "The background worker cannot read or write this project. Check folder access in Privacy Settings, or the folder's read/write permissions." };
  if (code === "ENOSPC") return { repo, state: "unavailable", message: "There is not enough disk space to write to this project. Free some space, then check again." };
  if (code === "ENOENT" || code === "ENOTDIR") return { repo, state: "missing", message: "This folder is missing or its drive is disconnected. Reconnect it or choose the project's new location." };
  return { repo, state: "unavailable", message: "The worker could not check this Git project. Check that Git is installed and the folder is available, then check again." };
}

/** Probe only unique files we created, inside Git metadata, never tracked files.
 * Run in a bounded child of the real service, not the foreground shell. */
export function probeDesktopProject(repo: string): DesktopProjectAccess {
  let scratch: string | undefined;
  try {
    const directory = opendirSync(repo); directory.readSync(); directory.closeSync();
    // The project's own repository, read through a frozen view: a build's include naming a FIFO can't hang the probe.
    const top = checkoutTop(repo, 4000);
    if (top === null) throw Error("Not a readable Git checkout");
    const common = checkoutGitSync(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 4000, binding: { repo: top } }).trim();
    scratch = mkdtempSync(join(realpathSync(common), "standing-orders-access-"));
    const file = join(scratch, "check");
    writeFileSync(file, "Toolroll access check\n", { flag: "wx", mode: 0o600 });
    if (readFileSync(file, "utf8") !== "Toolroll access check\n") throw Error("Read-back failed");
    unlinkSync(file); rmdirSync(scratch); scratch = undefined;
    return { repo, state: "ready", message: "The worker can read this project and write its Git metadata." };
  } catch (error) {
    return accessFailure(repo, (error as NodeJS.ErrnoException).code);
  } finally {
    // No recursive deletion: only our own exact file and empty directory.
    if (scratch) { try { unlinkSync(join(scratch, "check")); } catch {} try { rmdirSync(scratch); } catch {} }
  }
}

export function interpretAccessProbe(repo: string, result: ExecResult): DesktopProjectAccess {
  if (result.timedOut) return { repo, state: "unavailable", message: "The access check did not finish. Unlock your Mac, handle any folder-access prompt, then check again." };
  try {
    const parsed = JSON.parse(result.stdout) as DesktopProjectAccess;
    if (result.code === 0 && parsed.repo === repo && ["ready", "permission-needed", "missing", "unavailable"].includes(parsed.state) && typeof parsed.message === "string") return parsed;
  } catch {}
  return accessFailure(repo, result.notFound ? "ENOEXEC" : null);
}

export async function checkDesktopProjects(repos: readonly string[]): Promise<DesktopProjectAccess[]> {
  const checked: DesktopProjectAccess[] = [];
  // Bound concurrency and each diagnostic; these are not task runtime caps.
  for (let offset = 0; offset < repos.length; offset += 4) {
    checked.push(...await Promise.all(repos.slice(offset, offset + 4).map(async repo => interpretAccessProbe(repo,
      await run(process.execPath, [fileURLToPath(import.meta.url), "probe", repo], { timeoutMs: 6500, maxBuffer: 8192 })))));
  }
  return checked;
}

/** A receipt from an old worker or old project selection is never readiness. */
export function currentDesktopAccess(report: DesktopAccessReport | null, supervisor: { phase?: string; controllerPid?: number | null; updatedAt?: string } | null, repos: readonly string[], request: string): { verified: boolean; projects: DesktopProjectAccess[] } {
  const matching = report?.version === 1 && Number.isFinite(Date.parse(report.checkedAt)) && report.request === request &&
    Array.isArray(report.projects) && report.projects.every(one => one && typeof one.repo === "string" && typeof one.message === "string" && ["ready", "permission-needed", "missing", "unavailable"].includes(one.state)) &&
    report.projects.length === repos.length && repos.every(repo => report.projects.some(one => one.repo === repo));
  const current = matching && supervisor?.phase === "running" && report.controllerPid === supervisor.controllerPid && report.checkedAt >= (supervisor.updatedAt ?? "~");
  const pending = (repo: string): DesktopProjectAccess => ({ repo, state: "checking", message: "Waiting for this background worker to check access." });
  // Retain an actionable failure while the controller backs off, but never
  // treat a stopped worker's successful probe as current readiness.
  const failed = matching && ["backoff", "stopped"].includes(supervisor?.phase ?? "") && report.projects.some(one => one.state !== "ready");
  const projects: DesktopProjectAccess[] = current ? report.projects : failed ? report.projects.map(one => one.state === "ready" ? pending(one.repo) : one) : repos.map(pending);
  return { verified: projects.length > 0 && projects.every(one => one.state === "ready"), projects };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url) && process.argv[2] === "probe" && process.argv[3]) {
  console.log(JSON.stringify(probeDesktopProject(process.argv[3])));
}
