/**
 * One bounded child process tree, for work on a repository's untrusted bytes (docs/plans/code-map.md §1). What is
 * guaranteed depends on the platform, and the result says which:
 *
 *   Linux with a delegated cgroup, Windows   the OS object (containment.ts, policy `preferred`) holds the memory limit,
 *                                            and dies with the worker. `enforced: "system"`.
 *   macOS, Linux without a cgroup            no hard memory or descendant bound exists. Memory and disk are sampled every
 *                                            250 ms; a burst between samples can pass the limit before the kill, and a
 *                                            helper that left the process group can survive it. `enforced: "checked"`.
 *
 * `RLIMIT_FSIZE` applies to every POSIX spawn. The whole group is killed with SIGKILL on any limit, and again when the
 * root exits, so nothing the root started outlives it.
 */
import { spawn } from "node:child_process";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { processGroupId, processGroupRss, processIdentity, sameProcess } from "./process-identity.js";
import { createContainer, effectiveContainment, probeContainmentCapability, type Container, type EffectiveContainment } from "./containment.js";

export type BoundedStart = { pid: number; pgid: number; startedAt: string | null };
export type BoundedOptions = {
  cwd: string;
  /** The child's whole environment. */
  env: Record<string, string>;
  label: string;
  stdin?: Buffer;
  timeoutMs: number;
  /** Past this the tree is killed (`killed: "output"`). */
  maxStdout: number;
  /** Kept to this many bytes; more is dropped. */
  maxStderr: number;
  memoryBytes?: number;
  diskBytes?: number;
  /** The largest file any process may write (RLIMIT_FSIZE). */
  fileBytes?: number;
  /** The folder whose total `diskBytes` bounds. */
  folder?: string;
  onStart?: (started: BoundedStart) => void;
  sampleMs?: number;
};
export type BoundedResult = {
  code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: string;
  killed: "time" | "memory" | "disk" | "output" | null;
  enforced: "system" | "checked"; peakBytes: number;
};
export type BoundedRunner = (file: string, args: readonly string[], options: BoundedOptions) => Promise<BoundedResult>;

const SAMPLE_MS = 250;
const PIDS = 64;
/** Applies the file-size limit (bash counts it in 1024-byte blocks, POSIX shells in 512), then becomes the target with
 * argv untouched. */
const PRELUDE = 'if [ "$1" != none ]; then if [ -n "$BASH_VERSION" ]; then b=$(($1/1024)); else b=$(($1/512)); fi; ulimit -f "$b" 2>/dev/null || exit 126; fi\nshift\nexec "$@"';

let containment: EffectiveContainment | null = null;
const preferred = (): EffectiveContainment => containment ??= effectiveContainment("preferred", probeContainmentCapability());
/** Tests: forget the probed machine. */
export function resetBoundedContainmentForTests(): void { containment = null; }

/** A process's identity (process-identity.ts: `proc:<boot id>:<start ticks>` on Linux, else ps's start as an ISO
 * second): what tells a live process from a reused pid. Null when it can't be read. */
export function processStartedAt(pid: number): string | null {
  return processIdentity(pid);
}

/** The group's resident memory (process-identity.ts processGroupRss), read off the event loop's hot path. */
function groupRss(pgid: number): Promise<number | null> {
  return Promise.resolve().then(() => processGroupRss(pgid));
}

/** The folder's total size, without following a link. */
export function folderBytes(folder: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const held = lstatSync(path);
        if (held.isDirectory()) walk(path);
        else total += held.size;
      } catch { /* a temporary pack gone between the list and the look */ }
    }
  };
  walk(folder);
  return total;
}

const killGroup = (pgid: number): void => { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } };

export const boundedRun: BoundedRunner = async (file, args, options) => {
  const windows = process.platform === "win32";
  const effective = preferred();
  const made = createContainer(effective, options.label);
  const container: Container | null = "container" in made ? made.container : null;
  let enforced: BoundedResult["enforced"] = "checked";
  if (container !== null && options.memoryBytes !== undefined && container.limit?.({ memoryBytes: options.memoryBytes, pids: PIDS }) === true) enforced = "system";
  const target = windows ? { file, args: [...args] } : { file: "/bin/sh", args: ["-c", PRELUDE, "so-bounded", options.fileBytes === undefined ? "none" : String(options.fileBytes), file, ...args] };
  const launch = container?.launch(target.file, target.args) ?? null;
  const child = spawn(launch?.file ?? target.file, launch?.args ?? target.args, {
    cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: !windows,
    stdio: ["pipe", "pipe", "pipe", ...(launch?.extraStdio ?? [])],
  });
  const stdout: Buffer[] = [];
  let stdoutBytes = 0, stderr = "", killed: BoundedResult["killed"] = null, peakBytes = 0, sampling = false;
  const pid = child.pid;
  const kill = (why: NonNullable<BoundedResult["killed"]>): void => {
    killed ??= why;
    if (pid !== undefined && !windows) killGroup(pid);
    if (container !== null) void container.kill();
    else if (windows) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  };
  if (pid !== undefined) {
    try { options.onStart?.({ pid, pgid: pid, startedAt: processStartedAt(pid) }); }
    catch (error) { kill("time"); throw error; }
    if (launch !== null) {
      const attached = await launch.attach(child);
      if (!attached.ok) kill("time");
    }
  }
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > options.maxStdout) { kill("output"); return; }
    stdout.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < options.maxStderr) stderr += chunk.toString("utf8").slice(0, options.maxStderr - stderr.length); });
  child.stdin?.on("error", () => { /* it stopped reading */ });
  child.stdin?.end(options.stdin);
  const timer = setTimeout(() => kill("time"), options.timeoutMs);
  const sampler = setInterval(() => {
    if (sampling || pid === undefined) return;
    sampling = true;
    void (async () => {
      try {
        if (options.memoryBytes !== undefined && enforced === "checked" && !windows) {
          const rss = await groupRss(pid);
          if (rss !== null) { peakBytes = Math.max(peakBytes, rss); if (rss > options.memoryBytes) kill("memory"); }
        }
        if (options.diskBytes !== undefined && options.folder !== undefined && folderBytes(options.folder) > options.diskBytes) kill("disk");
      } finally { sampling = false; }
    })();
  }, options.sampleMs ?? SAMPLE_MS);
  const finished = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => { if (!settled) { settled = true; done({ code, signal }); } };
    child.once("error", () => settle(127, null));
    child.once("close", (code, signal) => settle(code, signal));
    // A helper that left the group can hold the pipes open past the root's exit: the root's exit is the answer.
    child.once("exit", (code, signal) => {
      if (pid !== undefined && !windows) killGroup(pid);
      setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); settle(code, signal); }, 2_000).unref?.();
    });
  });
  clearTimeout(timer); clearInterval(sampler);
  if (container !== null) { await container.kill(2_000); container.release(); }
  return { code: finished.code, signal: finished.signal, stdout: Buffer.concat(stdout), stderr, killed, enforced, peakBytes };
};

export type SpawnRecord = { pid: number | null; pgid: number | null; startedAt: string | null; folder: string | null };

/**
 * What a crashed build left: its group is killed only if the leader is still the process recorded (the pid and its start
 * time, so a reused pid isn't killed), and its folder goes if it sits under `root`. On Linux the cgroup janitor has
 * done this already.
 */
export function cleanupLeftover(record: SpawnRecord, root: string): { killed: boolean; removed: boolean } {
  let killed = false, removed = false;
  // Killed only when the leader is proved the recorded process by its identity's own provider; unknown is never a kill.
  // (A record from before identities were tagged holds ps's local-time lstart, which reads as another process: not
  // killed, as unknown; on Linux the cgroup janitor ends it.)
  if (record.pid !== null && record.pgid !== null && record.startedAt !== null && sameProcess(record.pid, record.startedAt) === "same" && processGroupId(record.pid) === record.pgid) {
    killGroup(record.pgid);
    killed = true;
  }
  if (record.folder !== null) {
    const inner = relative(root, record.folder);
    if (inner !== "" && !inner.startsWith("..") && !isAbsolute(inner)) {
      try { rmSync(record.folder, { recursive: true, force: true }); removed = true; } catch { /* the next takeover tries again */ }
    }
  }
  return { killed, removed };
}
