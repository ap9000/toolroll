/**
 * Running external commands.
 *
 * Two rules define this module. Arguments are passed as an array and never
 * through a shell, so a directory named `; rm -rf ~` is a string and not a
 * command. And nothing here rejects: a failed command is a value. Discovery
 * walks repos it has never seen, and one broken repo must not end the scan.
 */

import { linuxFenceAvailable, linuxFenced, macosFenceAvailable, macosFenced } from "./agent-fence.js";
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { observeProcessTree, stopProcessTree, type ProcessTreeObserver } from "./process-tree.js";
import { jsonlDiscriminants } from "./jsonl-discriminants.js";
import { createContainer, currentContainment, type AttachOutcome, type Container, type ContainmentBackendId } from "./containment.js";
import type { Store } from "./store.js";
import { claudeLimitsOf, noteLimits } from "./provider-limits.js";

export type ExecResult = {
  /** Process exit code, or one of the synthetic codes below. */
  code: number;
  stdout: string;
  stderr: string;
  /** Killed for exceeding its timeout. */
  timedOut: boolean;
  /** Binary is not on PATH — distinct from "ran and failed", and worth saying so. */
  notFound: boolean;
  /**
   * The OS containment this spawn had (OS containment plan). Absent under
   * observed containment. `refused` = required containment could not be
   * established and the target NEVER ran. Otherwise the backend, the exact
   * OS object, and whether the OS proved it empty before this result was
   * returned — a transport exit alone never proves that.
   */
  containment?: ContainmentOutcome;
};

export type ContainmentOutcome =
  | { refused: string }
  | { backend: ContainmentBackendId; id: string; empty: boolean };

/** Shell convention for "could not be executed": the refusal before any target ran. */
export const CONTAINMENT_REFUSED_CODE = 126;

export type RunOptions = ProcessTreeObserver & {
  cwd?: string;
  /** The agent fence (agent-fence.ts): on macOS the spawned process tree runs
   * inside a sandbox that denies these paths. Applied here, at the one spawn
   * road, so an injected test runner still sees the provider's own argv. */
  fence?: readonly string[];
  /** UTF-8 input for JSONL or buffered process-group transports; closed after delivery. */
  stdin?: string;
  /**
   * Absolute wall-clock ceiling. Keep this for bounded commands and repair
   * turns. Long-running provider sessions use idleTimeoutMs instead: useful
   * work should not be killed merely because it has been running a while.
   */
  timeoutMs?: number;
  /**
   * No-progress watchdog for streaming children. It is re-armed whenever
   * stdout or stderr produces bytes. When this is supplied without
   * timeoutMs there is deliberately no absolute wall-clock ceiling.
   */
  idleTimeoutMs?: number;
  /** Ends a process-group run early, exactly as its timeout does: the whole group is killed and the result reads timed out. */
  signal?: AbortSignal;
  maxBuffer?: number;
  /**
   * Extra environment, merged over the process's own. A capability probe is a
   * question about an environment, and a test has to be able to construct the
   * environment the question is about.
   */
  env?: Record<string, string>;
  /**
   * Names removed from the child's environment after the merge. This exists
   * for exactly one class of variable: a secret the parent holds that the
   * child must never see — the Telegram bot token in an agent's process
   * would let the agent read and answer the operator's own decisions.
   */
  omitEnv?: readonly string[];
  /**
   * When set, the child's environment is EXACTLY these names, taken from
   * the parent where present, plus whatever `env` merges on top (audit
   * IV-5): the approved worktree setup sees an allowlist, never a clone
   * of the operator's shell with two names scrubbed.
   */
  envAllowlist?: readonly string[];
  /**
   * Run the child in its own process group and register it as a live
   * provider (M6.12). Set by the invocation gateway and nowhere else: an
   * agent harness spawns shells and tools of its own, and stopping "the
   * provider" must mean the whole tree — a kill that orphans the
   * grandchildren stops nothing. Timeout kills become group kills too.
   */
  processGroup?: boolean;
  /**
   * Who OWNS this child (v52, safe task stop): an opaque tag — the
   * invocation gateway and the builder's check/setup legs pass
   * `run:<id>` — under which the live child is registered, so an
   * operator's stop on one exact attempt can end THAT attempt's process
   * tree through the handle this process holds, and nothing else's. A
   * kill by tag reaches only children this process spawned and still
   * tracks: never a pid read back from durable state.
   */
  owner?: string;
  /** Rechecked at each actual spawn, including transient spawn retries. */
  beforeSpawn?: () => boolean;
  /**
   * Live stdout for a process-group run, chunk by chunk as it arrives (the
   * full buffer is still returned). A listener error never affects the run.
   */
  onStdout?: (chunk: string) => void;
  /** Live stderr for a process-group run, with the same observational rules. */
  onStderr?: (chunk: string) => void;
  /**
   * Called the moment the stream announces its session (codex:
   * thread.started), so a crash mid-turn cannot lose the id (M6.9 —
   * currently only the streaming transport can deliver this early).
   */
  onSessionId?: (id: string) => void;
  /** Fires once the child exists, with its pid (the process-group id when
   * processGroup is set) — the slot ledger records it (v14 finding 26). */
  onSpawn?: (pid: number) => void;
  /** Fires instead of onSpawn when a spawn that beforeSpawn admitted made no
   * process at all (the OS call threw — ENOENT, EAGAIN — returned no pid, or
   * its OS object could not be made), so its reserved witness can be settled
   * as never started in the same step. Never fires once a child exists. */
  onSpawnFailed?: () => void;
  /** Fires before any target spawn, so a crash cannot lose its OS object. */
  onContainer?: (info: { backend: ContainmentBackendId; id: string; identity?: string }) => void;
  /** Fires once the OS proved this spawn's object empty (every member
   * gone, including detached helpers). Never fires on a transport exit
   * alone; a spawn whose object could not be proven empty reports
   * onUnknown instead and its custody stays unproven. */
  onContainerEmpty?: () => void;
  /**
   * Every parsed stream event, as it arrives (claude's streaming transport
   * only). Purely observational: exceptions are caught and counted, and
   * nothing about the run — retention, timeout, exit — changes because a
   * listener misbehaved. The live window renders these; nothing else may.
   */
  onStreamEvent?: (event: Record<string, unknown>) => void;
  /**
   * Fires ONCE, the moment the stream proves the prompt reached the agent
   * (arc 1 finding 11): the first top-level assistant event, or a
   * successful primary result when no assistant event preceded it. Error
   * results never fire it — a startup death is not a delivery. Latched
   * before invocation, so a throwing listener cannot make it fire twice.
   */
  onReceipt?: () => void;
};

/** Live provider children, for the deterministic stop. Registered only when `processGroup` was set. */
const liveProviders = new Set<import("node:child_process").ChildProcess>();

/** Live children by owner tag (v52): the exact-attempt stop's handle. A
 * child is registered here beside liveProviders when its options named an
 * owner, and dropped the moment it closes. */
const ownedChildren = new Map<string, Set<import("node:child_process").ChildProcess>>();

function registerOwned(owner: string | undefined, child: import("node:child_process").ChildProcess): void {
  if (owner === undefined) return;
  let set = ownedChildren.get(owner);
  if (set === undefined) {
    set = new Set();
    ownedChildren.set(owner, set);
  }
  set.add(child);
  child.once("close", () => {
    const owned = ownedChildren.get(owner);
    if (owned === undefined) return;
    owned.delete(child);
    if (owned.size === 0) ownedChildren.delete(owner);
  });
}

/** The native OS object behind a live child, when it has one. */
const containers = new WeakMap<import("node:child_process").ChildProcess, Container>();

/** Thrown BEFORE any spawn when required containment cannot be had. */
export class ContainmentRefusal extends Error {
  override readonly name = "ContainmentRefusal";
}

/** A spawn callback refused custody AFTER the child existed: the caller
 * must reap exactly this child before answering. */
class SpawnCustodyFailure extends Error {
  override readonly name = "SpawnCustodyFailure";
  constructor(readonly child: import("node:child_process").ChildProcess, readonly reason: unknown) {
    super(String(reason));
  }
}

/** The child a failed spawn road left behind, if any. */
function rejectedChild(error: unknown, child: import("node:child_process").ChildProcess | undefined): import("node:child_process").ChildProcess | undefined {
  return error instanceof SpawnCustodyFailure ? error.child : child;
}

type ContainedSpawn = {
  child: import("node:child_process").ChildProcess;
  container: Container | null;
  /** Settles once the target is inside its object (before it executes) or the prelude failed (the target never ran). */
  attached: Promise<AttachOutcome>;
};

/**
 * The ONE spawn road for containable children (buffered and streaming
 * transports): consult the pinned policy, make this spawn's OS
 * object, spawn the target INSIDE it, and register the object beside the
 * handle. Under observed containment this is exactly the old spawn. A
 * required policy that cannot be met throws ContainmentRefusal here —
 * nothing has been spawned, so the caller's reap is a no-op and its
 * result says `refused` in the policy's words.
 */
function spawnContained(
  file: string,
  args: readonly string[],
  spawnOptions: { cwd?: string | undefined; env?: Record<string, string | undefined> | undefined; stdio: ("pipe" | "ignore")[]; detached: boolean },
  label: string,
  bag: { beforeSpawn?: (() => boolean) | undefined; onSpawn?: ((pid: number) => void) | undefined; onSpawnFailed?: (() => void) | undefined; onContainer?: RunOptions["onContainer"]; onContainerEmpty?: RunOptions["onContainerEmpty"]; onUnknown?: RunOptions["onUnknown"]; fence?: readonly string[] | undefined },
  contain = true,
): ContainedSpawn {
  // The agent fence wraps the target itself (sandbox-exec then execs it, same pid).
  if (bag.fence !== undefined && bag.fence.length > 0 && macosFenceAvailable()) ({ file, args } = macosFenced(file, args, bag.fence));
  else if (bag.fence !== undefined && bag.fence.length > 0 && linuxFenceAvailable()) ({ file, args } = linuxFenced(file, args, bag.fence));
  // The policy refusal comes first: nothing is reserved, recorded or
  // spawned for a spawn that cannot be contained as required.
  const effective = contain ? currentContainment() : null;
  if (effective !== null && effective.refusal !== null) throw new ContainmentRefusal(effective.refusal);
  if (bag.beforeSpawn?.() === false) throw new Error("the attempt stopped before this process could spawn");
  // From here a witness may be reserved: every road that makes no process
  // says so through onSpawnFailed before it returns or throws.
  const neverStarted = (): void => { try { bag.onSpawnFailed?.(); } catch { /* the reservation stays unproven */ } };
  let made: ReturnType<typeof createContainer>;
  try { made = effective === null ? { container: null } : createContainer(effective, label); }
  catch (error) { neverStarted(); throw error; }
  if ("refused" in made) { neverStarted(); throw new ContainmentRefusal(made.refused); }
  const container = made.container;
  try { if (container !== null) bag.onContainer?.({ backend: container.backend, id: container.id, ...(container.identity ? { identity: container.identity } : {}) }); }
  catch (error) { container?.release(); neverStarted(); throw error; }
  let launch: ReturnType<Container["launch"]> | null;
  try { launch = container === null ? null : container.launch(file, args); }
  catch (error) { container?.release(); neverStarted(); throw error; }
  let child: import("node:child_process").ChildProcess;
  try {
    child = spawn(launch === null ? file : launch.file, launch === null ? [...args] : launch.args, {
      shell: false,
      windowsHide: true,
      detached: spawnOptions.detached,
      stdio: [...spawnOptions.stdio, ...(launch === null ? [] : launch.extraStdio)],
      ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
      ...(spawnOptions.env === undefined ? {} : { env: spawnOptions.env }),
    });
  } catch (error) {
    // The OS spawn itself threw: this invocation made no target process.
    try { if (container !== null) bag.onContainerEmpty?.(); } catch {}
    container?.release();
    neverStarted();
    throw error;
  }
  if (container !== null) {
    containers.set(child, container);
    // A descendant may keep stdout/stderr open after the root exits. Begin
    // cleanup at root exit; waiting for `close` would wait for that descendant.
    child.once("exit", () => { void settleContainer(container, bag).then(empty => {
      if (!empty) { child.stdout?.destroy(); child.stderr?.destroy(); }
    }); });
    child.once("error", () => { void settleContainer(container, bag); });
  }
  try {
    if (child.pid !== undefined) {
      bag.onSpawn?.(child.pid);
    } else if (container === null) {
      // No pid: the OS refused the spawn (ENOENT, EACCES) and only an
      // 'error' event follows. A contained spawn settles once its object is
      // proven empty, and its transport's return finishes the witness.
      neverStarted();
    }
  } catch (error) {
    throw new SpawnCustodyFailure(child, error);
  }
  const attached = launch === null || child.pid === undefined ? Promise.resolve<AttachOutcome>({ ok: true }) : launch.attach(child);
  return { child, container, attached };
}

/**
 * The settlement every containable transport runs at the root's exit:
 * members that outlived the root (a setsid'd helper, a double fork) are
 * killed and the OS asked for its empty state, bounded. The answer is
 * the proof the custody record keeps — `false` leaves the record
 * unproven and every stop/resume fence closed.
 */
const containerSettlements = new WeakMap<Container, Promise<boolean>>();
function settleContainer(container: Container, bag: { onContainerEmpty?: (() => void) | undefined; onUnknown?: (() => void) | undefined }, timeoutMs = 5_000): Promise<boolean> {
  const existing = containerSettlements.get(container);
  if (existing !== undefined) return existing;
  const settling = finishContainer(container, bag, timeoutMs);
  containerSettlements.set(container, settling);
  return settling;
}
async function finishContainer(container: Container, bag: { onContainerEmpty?: (() => void) | undefined; onUnknown?: (() => void) | undefined }, timeoutMs: number): Promise<boolean> {
  let empty = container.populated() === false;
  try { if (!empty) empty = await container.kill(timeoutMs); } catch { empty = false; }
  try {
    if (empty) bag.onContainerEmpty?.();
    else bag.onUnknown?.();
  } catch {
    // Custody that cannot be written stays unproven; the fences hold.
    empty = false;
  }
  try { container.release(); } catch { /* proof already determines the result */ }
  return empty;
}

/** The result's containment field for a spawn that ran inside an object. */
function containmentOf(container: Container | null, empty: boolean | null, attachFailure: string | null): { containment?: ContainmentOutcome } {
  if (attachFailure !== null) return { containment: { refused: attachFailure } };
  if (container === null || empty === null) return {};
  return { containment: { backend: container.backend, id: container.id, empty } };
}

/** The streaming transports' spawn: contained when the spawn is a provider (process group), plain otherwise. */
function spawnStream(
  file: string,
  args: readonly string[],
  options: RunOptions,
  stdio: ("pipe" | "ignore")[],
  childEnv: Record<string, string | undefined> | undefined,
): ContainedSpawn {
  return spawnContained(
    file,
    args,
    { cwd: options.cwd, env: childEnv, stdio, detached: options.processGroup === true && process.platform !== "win32" },
    options.owner ?? "stream",
    { beforeSpawn: options.beforeSpawn, onSpawn: options.onSpawn, onSpawnFailed: options.onSpawnFailed, onContainer: options.onContainer, onContainerEmpty: options.onContainerEmpty, onUnknown: options.onUnknown, fence: options.fence },
    options.processGroup === true,
  );
}

/** The refusal-before-spawn shape shared by every containable transport. */
function refusedResult(error: unknown): ExecResult {
  if (error instanceof ContainmentRefusal) {
    return { code: CONTAINMENT_REFUSED_CODE, stdout: "", stderr: error.message, timedOut: false, notFound: false, containment: { refused: error.message } };
  }
  return { code: 1, stdout: "", stderr: String(error instanceof SpawnCustodyFailure ? error.reason : error), timedOut: false, notFound: false };
}

const databaseOwners = new WeakMap<object, string>();
let memoryDatabaseOwner = 0;

/** Run IDs are local to a database. Connections to the same file share
 * custody; separate files and separate in-memory databases never do. */
export function runOwnerTag(store: Store, runId: number): string {
  let owner = databaseOwners.get(store.handle);
  if (owner === undefined) {
    const main = store.handle.prepare("PRAGMA database_list").all().find(row => row["name"] === "main");
    const file = main?.["file"];
    owner = typeof file === "string" && file !== "" ? `file:${realpathSync(file)}` : `memory:${++memoryDatabaseOwner}`;
    databaseOwners.set(store.handle, owner);
  }
  return JSON.stringify([owner, runId]);
}

/** How many live children this process still tracks under an owner tag. */
// Zero is local to this process registry. Recovery must also inspect durable
// witnesses and its authenticated OS census; this count is not an absence proof.
export function ownedProcessCount(owner: string): number {
  return ownedChildren.get(owner)?.size ?? 0;
}

/**
 * The exact-attempt stop (v52): SIGKILL the process group of every live
 * child registered under the owner tag — and only those. Returns how many
 * were signalled. Idempotent: a child already gone was dropped at close,
 * and a tag nobody registered kills nothing. This is the ONLY kill road a
 * task action may take; the global sweep below is the watch's shutdown.
 */
export function terminateOwnedProcesses(owner: string): number {
  const owned = ownedChildren.get(owner);
  if (owned === undefined) return 0;
  let terminated = 0;
  for (const child of owned) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    killGroup(child);
    terminated += 1;
  }
  return terminated;
}

/** SIGKILL the child's whole process group; fall back to the child alone. */
function killGroup(child: import("node:child_process").ChildProcess): void {
  const container = containers.get(child);
  if (container !== undefined) {
    // The OS object reaches every member at once — detached helpers
    // included — and its empty state is awaited by the transport's
    // settlement, never assumed here.
    void container.kill().catch(() => {});
    // The Windows helper is the job's owner and reporter: it terminates the
    // job on the order above and answers "empty"; killing it instead would
    // close the handle (kill-on-close still ends the job) but lose the proof.
    if (container.backend !== "job-object") { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    return;
  }
  if (stopProcessTree(child)) return;
  const pid = child.pid;
  if (pid !== undefined && process.platform === "win32") {
    // Windows has no process groups to signal (Codex M5-M8 audit, IV-6):
    // taskkill /T walks the tree, so a harness's shell grandchildren die
    // with it instead of writing to the worktree after "stopped". Untested
    // on physical Windows, like the daemon — stated, not hidden.
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } catch {
      // taskkill missing or refused — the direct kill below still runs.
    }
  }
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // No group of ours (not detached, or already gone) — fall through.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * The hard stop (M6.12): SIGKILL every live provider's process group.
 * Called by the watch when its stop grace expires — never on the first
 * signal, which stays graceful. Late output cannot commit or publish:
 * the killed process exits nonzero, the build finalizes as the failure
 * it is, and every commit sits behind fences the corpse cannot pass.
 */
export function terminateLiveProviders(): number {
  let terminated = 0;
  for (const child of liveProviders) {
    killGroup(child);
    terminated += 1;
  }
  return terminated;
}

/** The one place a child's environment is decided (audit IV-5). */
/**
 * Chat credentials never reach a child process (Codex chat v3 review,
 * change 10): ANTHROPIC_API_KEY is the chat key AND would silently flip
 * the claude harness from subscription auth to API billing if inherited.
 * A caller that genuinely needs it re-supplies it via `env` explicitly.
 * (OPENROUTER_API_KEY is not listed: the openrouter BUILD adapter reads
 * it from the child env by design, and the agent-facing shell excludes
 * it separately via the provider's own config.)
 */
const CHAT_KEYS_NEVER_INHERITED: readonly string[] = ["ANTHROPIC_API_KEY"];

function resolveChildEnv(options: RunOptions): Record<string, string | undefined> | undefined {
  const { env, omitEnv, envAllowlist } = options;
  if (envAllowlist !== undefined) {
    const picked: Record<string, string | undefined> = {};
    for (const name of envAllowlist) {
      const value = process.env[name];
      if (value !== undefined) picked[name] = value;
    }
    Object.assign(picked, env ?? {});
    for (const name of omitEnv ?? []) delete picked[name];
    for (const name of CHAT_KEYS_NEVER_INHERITED) {
      if (env?.[name] === undefined) delete picked[name];
    }
    return picked;
  }
  const merged: Record<string, string | undefined> = { ...process.env, ...(env ?? {}) };
  for (const name of omitEnv ?? []) delete merged[name];
  for (const name of CHAT_KEYS_NEVER_INHERITED) {
    if (env?.[name] === undefined) delete merged[name];
  }
  return merged;
}

/** Conventions from the shell and from coreutils `timeout(1)`. */
export const NOT_FOUND_CODE = 127;
export const TIMEOUT_CODE = 124;
/** Output too large to hold. Not a timeout, and must not be reported as one. */
/** A spawn callback records custody after the child exists. If that write
 * fails, stop and reap the owned child before reporting failure; otherwise
 * an unrecorded provider could keep writing after its caller retries. */
function reapRejectedSpawn(child: ReturnType<typeof spawn> | undefined, group: boolean): Promise<void> {
  if (child === undefined) return Promise.resolve();
  return new Promise(resolve => {
    if (group) liveProviders.add(child);
    child.once("close", () => {
      liveProviders.delete(child);
      const container = containers.get(child);
      if (container === undefined) resolve();
      else void settleContainer(container, {}).then(() => resolve());
    });
    child.on("error", () => {});
    child.stdout?.resume();
    child.stderr?.resume();
    if (group) killGroup(child);
    else { try { child.kill("SIGKILL"); } catch { /* The child must still exit before failure is returned. */ } }
  });
}

export const OVERFLOW_CODE = 125;

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * A streaming process may run for hours while it is making observable
 * progress. This controller keeps the ordinary hard timeout available for
 * bounded work, while allowing provider callers to choose an activity-based
 * watchdog with no wall-clock deadline. Both roads share the same kill and
 * settlement semantics.
 */
function streamWatchdog(
  options: RunOptions,
  onTimeout: () => void,
): { touch: () => void; stop: () => void } {
  const hardMs = options.timeoutMs ?? (options.idleTimeoutMs === undefined ? DEFAULT_TIMEOUT_MS : undefined);
  const idleMs = options.idleTimeoutMs;
  let fired = false;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const fire = (): void => {
    if (fired) return;
    fired = true;
    onTimeout();
  };
  const armIdle = (): void => {
    if (idleMs === undefined) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(fire, idleMs);
    idleTimer.unref?.();
  };
  if (hardMs !== undefined) {
    hardTimer = setTimeout(fire, hardMs);
    hardTimer.unref?.();
  }
  armIdle();

  return {
    touch: armIdle,
    stop: () => {
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    },
  };
}

const MAX_BUFFER_ERROR = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

type ExecError = Error & {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

/**
 * A spawn the OS refused for the moment — no free process slot or file
 * descriptor (a loaded machine, a fork storm from a parallel test suite) —
 * is not the command failing: the command never ran. Left as an exit 1, a
 * `git symbolic-ref` that never started reads as "no branch checked out"
 * and an unattended pass refuses on a lie. So the two buffered transports
 * retry EXACTLY this class, bounded, before answering.
 */
const TRANSIENT_SPAWN_CODES: ReadonlySet<string> = new Set(["EAGAIN", "EMFILE", "ENFILE"]);
export const SPAWN_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800];

export function isTransientSpawnFailure(error: { code?: number | string } | null | undefined): boolean {
  return error !== null && error !== undefined && typeof error.code === "string" && TRANSIENT_SPAWN_CODES.has(error.code);
}

/** One attempt's answer, with whether the process never started at all. */
export type SpawnAttempt = { result: ExecResult; transient: boolean };

/**
 * Retry `attempt` while it reports a transient spawn failure, sleeping the
 * given delays between tries; the last answer stands when they run out.
 * A non-transient answer — success, a real exit code, not found, timeout —
 * is returned at once: only the never-started case is retried.
 */
export async function retryTransientSpawn(
  attempt: () => Promise<SpawnAttempt>,
  delays: readonly number[] = SPAWN_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<ExecResult> {
  let last = await attempt();
  for (const delay of delays) {
    if (!last.transient) return last.result;
    await sleep(delay);
    last = await attempt();
  }
  return last.result;
}

export function run(file: string, args: readonly string[], options: RunOptions = {}): Promise<ExecResult> {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER } = options;
  const childEnv = resolveChildEnv(options);

  // A provider run needs its own process group; execFile cannot give one,
  // so the buffered path detours through spawn with identical semantics.
  if (options.processGroup === true) {
    return retryTransientSpawn(() =>
      runBufferedGroup(file, args, {
        timeoutMs,
        maxBuffer,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(childEnv === undefined ? {} : { childEnv }),
        ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
        ...(options.onSpawnFailed === undefined ? {} : { onSpawnFailed: options.onSpawnFailed }),
        ...(options.owner === undefined ? {} : { owner: options.owner }),
        ...(options.beforeSpawn === undefined ? {} : { beforeSpawn: options.beforeSpawn }),
        ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
        ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
        ...(options.fence === undefined ? {} : { fence: options.fence }),
        ...(options.onDescendant === undefined ? {} : { onDescendant: options.onDescendant }),
        ...(options.onDescendantWriteFailure === undefined ? {} : { onDescendantWriteFailure: options.onDescendantWriteFailure }),
        ...(options.onDescendantExit === undefined ? {} : { onDescendantExit: options.onDescendantExit }),
        ...(options.onUnknown === undefined ? {} : { onUnknown: options.onUnknown }),
        ...(options.onObservationFailure === undefined ? {} : { onObservationFailure: options.onObservationFailure }),
        ...(options.onContainer === undefined ? {} : { onContainer: options.onContainer }),
        ...(options.onContainerEmpty === undefined ? {} : { onContainerEmpty: options.onContainerEmpty }),
      }),
    );
  }

  return retryTransientSpawn(
    () =>
      new Promise<SpawnAttempt>(resolve => {
        execFile(
          file,
          [...args],
          {
            cwd,
            timeout: timeoutMs,
            maxBuffer,
            encoding: "utf8",
            shell: false,
            windowsHide: true,
            ...(childEnv === undefined ? {} : { env: childEnv }),
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({ result: { code: 0, stdout, stderr, timedOut: false, notFound: false }, transient: false });
              return;
            }
            resolve({
              result: describeFailure(error as ExecError, stdout, stderr),
              transient: isTransientSpawnFailure(error as ExecError),
            });
          },
        );
      }),
  );
}

/**
 * The buffered transport for process-group providers (claude): spawn
 * detached so the harness and everything it launches share one killable
 * group, collect output up to the same maxBuffer contract as execFile,
 * and register as a live provider for the watch's hard stop.
 */
function runBufferedGroup(
  file: string,
  args: readonly string[],
  bag: ProcessTreeObserver & { cwd?: string; stdin?: string; timeoutMs: number; signal?: AbortSignal; maxBuffer: number; childEnv?: Record<string, string | undefined>; onSpawn?: (pid: number) => void; onSpawnFailed?: () => void; owner?: string; beforeSpawn?: () => boolean; onContainer?: RunOptions["onContainer"]; onContainerEmpty?: RunOptions["onContainerEmpty"]; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; fence?: readonly string[] },
): Promise<SpawnAttempt> {
  return new Promise(resolve => {
    let child!: ReturnType<typeof spawn>;
    let container: Container | null = null;
    let attached: Promise<AttachOutcome>;
    try {
      const spawned = spawnContained(
        file,
        args,
        { cwd: bag.cwd, env: bag.childEnv, stdio: [bag.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: process.platform !== "win32" },
        bag.owner ?? "buffered",
        { beforeSpawn: bag.beforeSpawn, onSpawn: bag.onSpawn, onSpawnFailed: bag.onSpawnFailed, onContainer: bag.onContainer, onContainerEmpty: bag.onContainerEmpty, onUnknown: bag.onUnknown, fence: bag.fence },
      );
      child = spawned.child;
      container = spawned.container;
      attached = spawned.attached;
    } catch (error) {
      const left = rejectedChild(error, child);
      void reapRejectedSpawn(left, true).then(() => {
        resolve({
          result: refusedResult(error),
          transient: left === undefined && isTransientSpawnFailure(error as ExecError),
        });
      });
      return;
    }
    liveProviders.add(child);
    registerOwned(bag.owner, child);
    if (container === null) observeProcessTree(child, bag);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflowed = false;
    let inputFailed = false;
    let notFound = false;
    let attachFailure: string | null = null;
    void attached.then(outcome => { if (!outcome.ok) attachFailure = outcome.detail; });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, bag.timeoutMs);
    // The caller's deadline, when it owns one: the same group kill as the timer.
    const aborted = (): void => {
      timedOut = true;
      killGroup(child);
    };
    if (bag.signal?.aborted === true) aborted();
    else bag.signal?.addEventListener("abort", aborted, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > bag.maxBuffer) {
        overflowed = true;
        killGroup(child);
      }
      try { bag.onStdout?.(chunk); } catch { /* a listener never breaks the run */ }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < bag.maxBuffer) stderr += chunk.slice(0, bag.maxBuffer - stderr.length);
      try { bag.onStderr?.(chunk); } catch { /* a listener never breaks the run */ }
    });

    let settled = false;
    let transient = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bag.signal?.removeEventListener("abort", aborted);
      liveProviders.delete(child);
      // The OS object is settled BEFORE the answer: a root that exited is
      // not an empty container until the OS says so.
      const settlement = container === null ? Promise.resolve<boolean | null>(null) : settleContainer(container, bag);
      void settlement.then(empty => {
        resolve({
          result: {
            code: notFound ? NOT_FOUND_CODE : overflowed ? OVERFLOW_CODE : timedOut ? TIMEOUT_CODE : inputFailed ? 1 : attachFailure !== null || empty === false ? CONTAINMENT_REFUSED_CODE : (code ?? 1),
            stdout,
            stderr: empty === false ? `${stderr}\nNative process containment could not prove all descendants exited.`.trim() : attachFailure !== null && stderr === "" ? attachFailure : stderr,
            // Overflow also killed the child; it is not a timeout and must not read as one.
            timedOut: timedOut && !overflowed,
            notFound,
            ...containmentOf(container, empty, attachFailure),
          },
          transient,
        });
      });
    };
    child.on("error", error => {
      notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      transient = isTransientSpawnFailure(error as NodeJS.ErrnoException);
      if (stderr === "") stderr = String(error);
      finish(null);
    });
    child.on("close", code => finish(code));
    if (bag.stdin !== undefined && child.stdin !== null) {
      child.stdin.on("error", () => {
        inputFailed = true;
        stderr = "prompt input failed: the provider closed its input before delivery completed";
        killGroup(child);
      });
      child.stdin.end(bag.stdin, "utf8");
    }
  });
}

/**
 * Turn an execFile error into a result. The order matters: a maxBuffer overflow
 * also arrives with `killed: true`, so it has to be recognised before the
 * timeout check or a truncated `git log` reads as a hung one.
 */
function describeFailure(error: ExecError, stdout: string, stderr: string): ExecResult {
  const notFound = error.code === "ENOENT";
  const overflowed = error.code === MAX_BUFFER_ERROR;
  const timedOut = !overflowed && error.killed === true;

  return {
    code: resolveCode(error, { notFound, overflowed, timedOut }),
    stdout,
    stderr: stderr === "" ? error.message : stderr,
    timedOut,
    notFound,
  };
}

function resolveCode(
  error: ExecError,
  flags: { notFound: boolean; overflowed: boolean; timedOut: boolean },
): number {
  if (typeof error.code === "number") return error.code;
  if (flags.notFound) return NOT_FOUND_CODE;
  if (flags.overflowed) return OVERFLOW_CODE;
  if (flags.timedOut) return TIMEOUT_CODE;
  return 1;
}

/**
 * The streaming transport for JSONL-emitting providers.
 *
 * A long agent session can write far more event stream than any fixed
 * buffer should hold, and the lines that matter — the session identity,
 * the terminal usage — arrive LAST. Buffering-and-overflowing would kill
 * the process at 8 MiB and lose exactly the facts a paid run must not
 * lose (Codex provider review, high finding 2). So stdout is consumed
 * incrementally and only the load-bearing lines are retained:
 *
 *   - a bounded identity witness for `thread.started` (first usable id,
 *     first conflicting id, and last event), plus the LAST `turn.completed`
 *     and `turn.failed` line
 *   - the LAST `item.completed` line carrying an agent_message
 *
 * each capped per line; everything else is counted and dropped. The
 * result's stdout is the retained lines joined — a synthetic, bounded
 * envelope the parser reads exactly like test fixtures.
 */
const JSONL_LINE_CAP = 64 * 1024;
const JSONL_STDERR_CAP = 64 * 1024;

/** Canonical identity at the transport boundary. Never persist or expose
 * provider framing whitespace as part of a resumable session id. */
function transportSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id === "" ? null : id;
}

/**
 * Provider replies are nested inside their JSONL envelope. A 64 KiB reply
 * therefore needs appreciably more than 64 KiB on the wire once quotes,
 * backslashes, and control characters are escaped. 512 KiB carries that
 * worst useful case while remaining a hard, per-event memory boundary.
 */
export const JSONL_EVENT_HARD_CAP = 512 * 1024;
const JSONL_OVERFLOW_PREFIX_CAP = 4 * 1024;

type BoundedJsonlLine = {
  /** A view into the framer's reusable buffer; consume it synchronously. */
  prefix: Buffer;
  bytesOriginal: number;
  overflowed: boolean;
  discriminants?: { type: string; itemType: string | null } | null;
};

/**
 * Split a byte stream into JSONL records without ever accumulating an
 * unbounded partial line. The callback is synchronous so the same fixed
 * storage can be reused for the next record. Counting the original bytes
 * (rather than JavaScript characters) makes the overflow receipt exact.
 */
function boundedJsonlFramer(
  cap: number,
  onLine: (line: BoundedJsonlLine) => void,
  inspectDiscriminants = false,
): { push: (chunk: Buffer) => void; finish: () => void } {
  const retained = Buffer.allocUnsafe(cap);
  let retainedBytes = 0;
  let originalBytes = 0;
  let nonWhitespace = false;
  let discriminants = inspectDiscriminants ? jsonlDiscriminants() : null;

  const append = (part: Buffer): void => {
    discriminants?.push(part);
    originalBytes += part.length;
    if (!nonWhitespace) {
      for (const byte of part) {
        if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) {
          nonWhitespace = true;
          break;
        }
      }
    }
    if (retainedBytes < cap) {
      retainedBytes += part.copy(retained, retainedBytes, 0, cap - retainedBytes);
    }
  };

  const emit = (): void => {
    onLine({
      prefix: retained.subarray(0, retainedBytes),
      bytesOriginal: originalBytes,
      overflowed: originalBytes > cap,
      ...(discriminants === null ? {} : { discriminants: discriminants.finish() }),
    });
    retainedBytes = 0;
    originalBytes = 0;
    nonWhitespace = false;
    discriminants = inspectDiscriminants ? jsonlDiscriminants() : null;
  };

  return {
    push(chunk: Buffer): void {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline === -1) {
          append(chunk.subarray(start));
          return;
        }
        append(chunk.subarray(start, newline));
        emit();
        start = newline + 1;
      }
    },
    finish(): void {
      // Match the old `partial.trim() !== ""` rule: a final unterminated
      // whitespace-only record is not an event and needs no receipt.
      if (originalBytes > 0 && nonWhitespace) emit();
    },
  };
}

type StreamOverflowTransport = "codex" | "claude" | "gemini";

function overflowReceiptText(transport: StreamOverflowTransport, line: BoundedJsonlLine): string {
  const rawPrefix = line.prefix.subarray(0, Math.min(line.prefix.length, JSONL_OVERFLOW_PREFIX_CAP));
  return JSON.stringify({
    type: "standing-orders.stream-event-overflow",
    transport,
    message: `The provider emitted a JSONL event larger than the ${JSONL_EVENT_HARD_CAP}-byte safety limit.`,
    eventBytesOriginal: line.bytesOriginal,
    hardCapBytes: JSONL_EVENT_HARD_CAP,
    prefixBytes: rawPrefix.length,
    prefix: rawPrefix.toString("utf8"),
    // The readable prefix can end halfway through a UTF-8 character. This
    // companion is the exact retained byte prefix for forensic evidence.
    prefixBase64: rawPrefix.toString("base64"),
  });
}

function malformedReceiptText(transport: StreamOverflowTransport, line: BoundedJsonlLine): string {
  const rawPrefix = line.prefix.subarray(0, Math.min(line.prefix.length, JSONL_OVERFLOW_PREFIX_CAP));
  return JSON.stringify({
    type: "standing-orders.stream-event-malformed",
    transport,
    message: "The provider emitted malformed JSON for a load-bearing stream event after initialization.",
    eventBytesOriginal: line.bytesOriginal,
    prefixBytes: rawPrefix.length,
    prefix: rawPrefix.toString("utf8"),
    prefixBase64: rawPrefix.toString("base64"),
  });
}

function codexOverflowLine(line: BoundedJsonlLine): string {
  return JSON.stringify({
    type: "turn.failed",
    error: {
      type: "standing-orders.stream-event-overflow",
      message: overflowReceiptText("codex", line),
    },
  });
}

function codexMalformedLine(line: BoundedJsonlLine): string {
  return JSON.stringify({
    type: "turn.failed",
    error: {
      type: "standing-orders.stream-event-malformed",
      message: malformedReceiptText("codex", line),
    },
  });
}

function claudeOverflowLine(line: BoundedJsonlLine): string {
  return JSON.stringify({
    type: "result",
    subtype: "standing-orders-stream-event-overflow",
    is_error: true,
    result: overflowReceiptText("claude", line),
  });
}

function geminiOverflowLine(line: BoundedJsonlLine): string {
  return JSON.stringify({
    type: "result",
    status: "standing-orders-stream-event-overflow",
    error: { message: overflowReceiptText("gemini", line) },
  });
}

function geminiMalformedLine(line: BoundedJsonlLine): string {
  return JSON.stringify({
    type: "result",
    status: "standing-orders-stream-event-malformed",
    error: { message: malformedReceiptText("gemini", line) },
  });
}

/**
 * Read only the leading, top-level `type` discriminant from an incomplete
 * JSON object. Provider JSONL dialects put `type` first. Anchoring the match
 * means content later in an oversized event can never spoof classification.
 */
function leadingJsonObjectType(prefix: Buffer): string | null {
  const match = /^\s*\{\s*"type"\s*:\s*"([A-Za-z0-9._-]+)"/.exec(prefix.toString("utf8", 0, Math.min(prefix.length, 256)));
  return match?.[1] ?? null;
}

/** Codex emits `item` immediately after the outer type. Only an agent
 * message is load-bearing; completed command/tool telemetry is droppable. */
function leadingCodexCompletedItemType(prefix: Buffer): string | null {
  const match = /^\s*\{\s*"type"\s*:\s*"item\.completed"\s*,\s*"item"\s*:\s*\{\s*"type"\s*:\s*"([A-Za-z0-9._-]+)"/.exec(
    prefix.toString("utf8", 0, Math.min(prefix.length, 512)),
  );
  return match?.[1] ?? null;
}

function leadingClaudeSystemSubtype(prefix: Buffer): string | null {
  const match = /^\s*\{\s*"type"\s*:\s*"system"\s*,\s*"subtype"\s*:\s*"([A-Za-z0-9._-]+)"/.exec(
    prefix.toString("utf8", 0, Math.min(prefix.length, 512)),
  );
  return match?.[1] ?? null;
}

function malformedCodexEventIsLoadBearing(prefix: Buffer): boolean {
  const type = leadingJsonObjectType(prefix);
  if (type === "thread.started" || type === "turn.completed" || type === "turn.failed") return true;
  if (type !== "item.completed") return false;
  const itemType = leadingCodexCompletedItemType(prefix);
  return itemType === null || itemType === "agent_message";
}

function malformedGeminiEventIsLoadBearing(prefix: Buffer): boolean {
  const type = leadingJsonObjectType(prefix);
  // These two records authorize the session and the successful terminal.
  // Malformed messages remain diagnostics only; startup prose, tool traffic,
  // and warnings retain the transport's established noise tolerance.
  return type === "init" || type === "result";
}

export function runStreamJsonl(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  const { cwd } = options;
  const childEnv = resolveChildEnv(options);

  return new Promise(resolve => {
    let child!: ReturnType<typeof spawn>;
    let container: Container | null = null;
    let attachFailure: string | null = null;
    try {
      const spawned = spawnStream(file, args, options, [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], childEnv);
      child = spawned.child;
      container = spawned.container;
      void spawned.attached.then(outcome => { if (!outcome.ok) attachFailure = outcome.detail; });
    } catch (error) {
      void reapRejectedSpawn(rejectedChild(error, child), options.processGroup === true).then(() => resolve(refusedResult(error)));
      return;
    }
    if (options.processGroup === true) liveProviders.add(child);
    registerOwned(options.owner, child);
    if (options.processGroup === true && container === null) observeProcessTree(child, options);

    let startedLine: string | null = null;
    let startedIdentityLine: string | null = null;
    let conflictingStartedLine: string | null = null;
    let startedSessionId: string | null = null;
    let completedLine: string | null = null;
    let failedLine: string | null = null;
    let overflowLine: string | null = null;
    let malformedLine: string | null = null;
    let lastMessage: string | null = null;
    let stderr = "";
    let timedOut = false;
    let notFound = false;
    let inputFailed = false;

    const keep = (framed: BoundedJsonlLine): void => {
      if (framed.overflowed) {
        // Inspect structural keys across the complete byte stream, including
        // keys AFTER discarded command output. Quoted or nested types cannot
        // spoof these discriminants, and malformed/ambiguous input stays red.
        const type = framed.discriminants?.type ?? null;
        if (type !== null && !["thread.started", "turn.completed", "turn.failed", "item.completed"].includes(type)) {
          return;
        }
        if (type === "item.completed") {
          const itemType = framed.discriminants?.itemType;
          if (itemType !== undefined && itemType !== null && ["command_execution", "mcp_tool_call", "web_search", "file_change", "todo_list"].includes(itemType)) return;
        }
        // A load-bearing or unclassifiable hard-cap breach is independently
        // retained as failure. Once those bytes were discarded, a later
        // ordinary message must never turn the run green.
        if (overflowLine === null) overflowLine = codexOverflowLine(framed);
        return;
      }
      const line = framed.prefix.toString("utf8");
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const type = String(event["type"] ?? "");
        if (type === "thread.started") {
          // Keep the last init for the existing transport contract and a
          // bounded pair of earlier witnesses so a conflict cannot hide.
          startedLine = line;
          const id = transportSessionId(event["thread_id"]);
          if (id !== null) {
            // Retain only enough events to prove the identity contract:
            // one usable id when the first init was blank, and one conflict.
            if (startedSessionId === null) {
              startedSessionId = id;
              startedIdentityLine = line;
            } else if (id !== startedSessionId && conflictingStartedLine === null) {
              conflictingStartedLine = line;
            }
            if (options.onSessionId !== undefined) {
              try {
                options.onSessionId(id);
              } catch {
                // A registry that cannot be written must not kill the turn.
              }
            }
          }
        } else if (type === "turn.completed") {
          completedLine = line;
        } else if (type === "turn.failed") {
          // Retain failure independently from completion: seeing either at
          // any point is load-bearing, while one slot per kind stays bounded.
          failedLine = line;
        } else if (type === "item.completed") {
          const item = event["item"] as Record<string, unknown> | undefined;
          if (item !== undefined && String(item["type"] ?? "") === "agent_message") {
            lastMessage = line;
          }
        }
        if (options.onStreamEvent !== undefined) {
          try {
            options.onStreamEvent(event);
          } catch {
            // Observational only: a broken listener never touches the run.
          }
        }
      } catch {
        // Startup prose and ordinary malformed telemetry remain ignorable.
        // Once initialization is proven, however, a recognizable control or
        // answer record cannot disappear merely because its JSON was cut.
        if (
          startedLine !== null &&
          malformedLine === null &&
          malformedCodexEventIsLoadBearing(framed.prefix)
        ) {
          malformedLine = codexMalformedLine(framed);
        }
      }
    };

    const framing = boundedJsonlFramer(JSONL_EVENT_HARD_CAP, keep, true);

    const watchdog = streamWatchdog(options, () => {
      timedOut = true;
      if (options.processGroup === true) killGroup(child);
      else child.kill("SIGKILL");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      watchdog.touch();
      framing.push(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      watchdog.touch();
      if (stderr.length < JSONL_STDERR_CAP) stderr += chunk.slice(0, JSONL_STDERR_CAP - stderr.length);
    });

    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      liveProviders.delete(child);
      framing.finish();
      const lines = [
        startedIdentityLine,
        conflictingStartedLine,
        startedLine,
        completedLine,
        failedLine,
        overflowLine,
        malformedLine,
        lastMessage,
      ]
        .filter((line): line is string => line !== null)
        .filter((line, index, all) => all.indexOf(line) === index);
      const settlement = container === null ? Promise.resolve<boolean | null>(null) : settleContainer(container, options);
      void settlement.then(empty => resolve({
        code: notFound ? NOT_FOUND_CODE : timedOut ? TIMEOUT_CODE : inputFailed ? 1 : attachFailure !== null || empty === false ? CONTAINMENT_REFUSED_CODE : (code ?? 1),
        stdout: lines.join("\n"),
        stderr: empty === false ? `${stderr}\nNative process containment could not prove all descendants exited.`.trim() : attachFailure !== null && stderr === "" ? attachFailure : stderr,
        timedOut,
        notFound,
        ...containmentOf(container, empty, attachFailure),
      }));
    };

    // A failed spawn fires 'error' and may never fire 'close' — both routes
    // settle, exactly once.
    child.on("error", error => {
      notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (stderr === "") stderr = String(error);
      finish(null);
    });
    child.on("close", code => finish(code));
    if (options.stdin !== undefined && child.stdin !== null) {
      // Even an exit-0 child cannot prove a review if prompt delivery failed.
      // Handle EPIPE without crashing the supervisor, then wait for close.
      child.stdin.on("error", error => {
        inputFailed = true;
        stderr = `review prompt input failed: ${String(error)}`.slice(0, JSONL_STDERR_CAP);
        if (options.processGroup === true) killGroup(child);
        else child.kill("SIGKILL");
      });
      child.stdin.end(options.stdin, "utf8");
    }

  });
}

/**
 * The streaming transport for gemini's stream-json dialect (Phase 3 D1/A7).
 *
 * Retention: a bounded `init` identity witness (the first init signal, first
 * usable session id, and first conflicting id), the FIRST
 * `severity:"error"` error event (diagnostics),
 * the LAST `result` event (tokens + structural status), and the assistant's
 * text — which gemini emits only as many `message` delta lines — ASSEMBLED
 * into one line of a dedicated internal schema the real CLI cannot emit:
 *
 *   {"type":"synthetic_message","content":"...","truncated":true?}
 *
 * Assembly rules (round-3 f9): only `role:"assistant"` events with
 * `delta === true` concatenate; a non-delta assistant message REPLACES the
 * buffer (full-message semantics); non-string content is dropped; the cap
 * is enforced on the SERIALIZED UTF-8 BYTES of the complete synthetic line
 * (marker included), so it can never violate the runner's own line
 * discipline. Everything else — user echoes, tool_use, tool_result,
 * warnings — is dropped. Timeout, process-group, kill, and spawn
 * semantics match `runStreamJsonl`.
 */
export function runGeminiStreamJsonl(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  const { cwd } = options;
  const childEnv = resolveChildEnv(options);

  return new Promise(resolve => {
    let child!: ReturnType<typeof spawn>;
    let container: Container | null = null;
    let attachFailure: string | null = null;
    try {
      const spawned = spawnStream(file, args, options, ["ignore", "pipe", "pipe"], childEnv);
      child = spawned.child;
      container = spawned.container;
      void spawned.attached.then(outcome => { if (!outcome.ok) attachFailure = outcome.detail; });
    } catch (error) {
      void reapRejectedSpawn(rejectedChild(error, child), options.processGroup === true).then(() => resolve(refusedResult(error)));
      return;
    }
    if (options.processGroup === true) liveProviders.add(child);
    registerOwned(options.owner, child);
    if (options.processGroup === true && container === null) observeProcessTree(child, options);

    let initLine: string | null = null;
    let initIdentityLine: string | null = null;
    let conflictingInitLine: string | null = null;
    let initSessionId: string | null = null;
    let errorLine: string | null = null;
    let resultLine: string | null = null;
    let message = "";
    let messageTruncated = false;
    let stderr = "";
    let timedOut = false;
    let notFound = false;
    let overflowLine: string | null = null;
    let malformedLine: string | null = null;

    const keep = (framed: BoundedJsonlLine): void => {
      if (framed.overflowed) {
        const type = leadingJsonObjectType(framed.prefix);
        // Tool plumbing is never a terminal or answer. All load-bearing and
        // unknown oversized events latch a terminal protocol failure so a
        // later small success cannot hide discarded provider bytes.
        if (type !== "tool_use" && type !== "tool_result") {
          if (overflowLine === null) overflowLine = geminiOverflowLine(framed);
        }
        return;
      }
      const line = framed.prefix.toString("utf8");
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        if (
          initLine !== null &&
          malformedLine === null &&
          malformedGeminiEventIsLoadBearing(framed.prefix)
        ) {
          malformedLine = geminiMalformedLine(framed);
        }
        return; // startup prose and non-load-bearing malformed noise are dropped
      }
      if (event === null || typeof event !== "object") return;
      const type = String(event["type"] ?? "");
      if (type === "init") {
        if (initLine === null) initLine = line;
        const id = transportSessionId(event["session_id"]);
        let identityWitness = false;
        if (id !== null) {
          if (initSessionId === null) {
            initSessionId = id;
            initIdentityLine = line;
            identityWitness = true;
          } else if (id !== initSessionId && conflictingInitLine === null) {
            conflictingInitLine = line;
            identityWitness = true;
          }
          if (identityWitness && options.onSessionId !== undefined) {
            try {
              options.onSessionId(id);
            } catch {
              // A registry that cannot be written must not kill the turn.
            }
          }
        }
      } else if (type === "result") {
        resultLine = line; // last one wins
      } else if (type === "error") {
        if (errorLine === null && String(event["severity"] ?? "") === "error") errorLine = line;
      } else if (type === "message" && String(event["role"] ?? "") === "assistant") {
        const content = event["content"];
        if (typeof content !== "string") return; // non-string content: dropped
        if (event["delta"] === true) {
          if (!messageTruncated) {
            message += content;
            if (Buffer.byteLength(message, "utf8") > JSONL_LINE_CAP) messageTruncated = true;
          }
        } else {
          // A full (non-delta) assistant message replaces the buffer.
          message = content;
          messageTruncated = Buffer.byteLength(message, "utf8") > JSONL_LINE_CAP;
        }
      }
      if (options.onStreamEvent !== undefined) {
        try {
          options.onStreamEvent(event);
        } catch {
          // Observational only: a broken listener never touches the run.
        }
      }
    };

    const framing = boundedJsonlFramer(JSONL_EVENT_HARD_CAP, keep);

    const watchdog = streamWatchdog(options, () => {
      timedOut = true;
      if (options.processGroup === true) killGroup(child);
      else child.kill("SIGKILL");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      watchdog.touch();
      framing.push(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      watchdog.touch();
      if (stderr.length < JSONL_STDERR_CAP) stderr += chunk.slice(0, JSONL_STDERR_CAP - stderr.length);
    });

    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      liveProviders.delete(child);
      framing.finish();
      const lines: string[] = [initLine, initIdentityLine, conflictingInitLine]
        .filter((line): line is string => line !== null)
        .filter((line, index, all) => all.indexOf(line) === index);
      if (errorLine !== null) lines.push(errorLine);
      if (message !== "") lines.push(syntheticMessageLine(message, messageTruncated));
      if (resultLine !== null) lines.push(resultLine);
      // Keep the overflow last: gemini's contract is last-result-wins, and
      // no later small event may erase evidence that a record was discarded.
      if (overflowLine !== null) lines.push(overflowLine);
      // A recognizable, malformed terminal is just as conclusive as an
      // oversized one. Keep it last so last-result-wins cannot erase it.
      if (malformedLine !== null) lines.push(malformedLine);
      const settlement = container === null ? Promise.resolve<boolean | null>(null) : settleContainer(container, options);
      void settlement.then(empty => resolve({
        code: notFound ? NOT_FOUND_CODE : timedOut ? TIMEOUT_CODE : attachFailure !== null || empty === false ? CONTAINMENT_REFUSED_CODE : (code ?? 1),
        stdout: lines.join("\n"),
        stderr: empty === false ? `${stderr}\nNative process containment could not prove all descendants exited.`.trim() : attachFailure !== null && stderr === "" ? attachFailure : stderr,
        timedOut,
        notFound,
        ...containmentOf(container, empty, attachFailure),
      }));
    };

    child.on("error", error => {
      notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (stderr === "") stderr = String(error);
      finish(null);
    });
    child.on("close", code => finish(code));
  });
}

const TRUNCATION_MARKER = "…[truncated]";

/**
 * One serialized synthetic line, guaranteed ≤ JSONL_LINE_CAP in UTF-8
 * bytes — the trim loop measures the COMPLETE serialized line (escaping
 * and marker included), so pathological escaping cannot smuggle it past
 * the cap (round-3 f9).
 */
function syntheticMessageLine(content: string, truncated: boolean): string {
  let body = content;
  let marked = truncated;
  for (;;) {
    const line = JSON.stringify(
      marked
        ? { type: "synthetic_message", content: body + TRUNCATION_MARKER, truncated: true }
        : { type: "synthetic_message", content: body },
    );
    const over = Buffer.byteLength(line, "utf8") - JSONL_LINE_CAP;
    if (over <= 0) return line;
    marked = true;
    // Cut at least the overage in UTF-16 units; the loop re-measures.
    const cut = Math.max(1, over);
    body = body.slice(0, Math.max(0, body.length - cut));
  }
}

/**
 * The streaming transport for claude's stream-json dialect (arc 1).
 *
 * Same rationale as `runStreamJsonl`: a long agent session writes far more
 * event stream than any fixed buffer should hold, and the line that matters
 * — the terminal result carrying session, usage, and dollars — arrives
 * LAST. The 8 MiB buffered kill would destroy exactly that accounting
 * envelope, so stdout is consumed incrementally and only the load-bearing
 * lines are retained:
 *
 *   - a bounded identity witness for `system`/`init`: the first init signal,
 *     the first usable session id, and one conflicting id
 *   - the FIRST primary `result` event, selected STRUCTURALLY (finding 10):
 *     origin absent or `origin.kind === "human"` — an allowlist, so a
 *     background task's result (or any future origin kind) can never be
 *     mistaken for the main query's accounting. Later results are dropped.
 *
 * The result's stdout is the retained lines joined — a synthetic, bounded
 * envelope `claudeParse` reads exactly like test fixtures. Timeout,
 * process-group, kill, and spawn semantics match `runStreamJsonl`.
 */
function primaryResultOrigin(event: Record<string, unknown>): boolean {
  const origin = event["origin"];
  if (origin === undefined || origin === null) return true;
  if (typeof origin === "object" && String((origin as Record<string, unknown>)["kind"] ?? "") === "human") return true;
  return false; // task-notification, channel, peer, coordinator, unknown: never the envelope
}

export function runClaudeStreamJsonl(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  const { cwd } = options;
  const childEnv = resolveChildEnv(options);

  return new Promise(resolve => {
    let child!: ReturnType<typeof spawn>;
    let container: Container | null = null;
    let attachFailure: string | null = null;
    try {
      const spawned = spawnStream(file, args, options, ["ignore", "pipe", "pipe"], childEnv);
      child = spawned.child;
      container = spawned.container;
      void spawned.attached.then(outcome => { if (!outcome.ok) attachFailure = outcome.detail; });
    } catch (error) {
      void reapRejectedSpawn(rejectedChild(error, child), options.processGroup === true).then(() => resolve(refusedResult(error)));
      return;
    }
    if (options.processGroup === true) liveProviders.add(child);
    registerOwned(options.owner, child);
    if (options.processGroup === true && container === null) observeProcessTree(child, options);

    let initLine: string | null = null;
    let initIdentityLine: string | null = null;
    let conflictingInitLine: string | null = null;
    let initSessionId: string | null = null;
    let resultLine: string | null = null;
    let overflowLine: string | null = null;
    let receiptFired = false;
    let stderr = "";
    let timedOut = false;
    let notFound = false;

    // Latch BEFORE invoking (finding 13): a throwing listener has already
    // consumed its one firing, and the stream goes on unharmed.
    const fireReceipt = (): void => {
      if (receiptFired || options.onReceipt === undefined) {
        receiptFired = true;
        return;
      }
      receiptFired = true;
      try {
        options.onReceipt();
      } catch {
        // A receipt that cannot be recorded must not alter the run; the
        // note stays honestly unreceipted and re-attaches later.
      }
    };

    const keep = (framed: BoundedJsonlLine): void => {
      if (framed.overflowed) {
        // An oversized result is the first primary candidate and therefore
        // closes the slot fail-closed; an oversized non-result is merely a
        // fallback that a later parseable primary result can supersede.
        // Claude's parser trusts the first primary result. When a line is
        // too large to classify, reserve that first slot fail-closed rather
        // than let a later small result hide emitted bytes we discarded.
        const type = leadingJsonObjectType(framed.prefix);
        if (type !== null && type !== "result") {
          if (type !== "system") return;
          const subtype = leadingClaudeSystemSubtype(framed.prefix);
          if (subtype !== null && subtype !== "init") return;
          // An init too large to inspect may conceal a conflicting session
          // identity. Latch it independently from the primary result so the
          // same event set fails regardless of whether it arrived before or
          // after the terminal, while a normal terminal can still account
          // for the turn's usage.
          if (overflowLine === null) overflowLine = claudeOverflowLine(framed);
          return;
        }
        if (resultLine === null) resultLine = claudeOverflowLine(framed);
        else if (overflowLine === null) overflowLine = claudeOverflowLine(framed);
        return;
      }
      const line = framed.prefix.toString("utf8");
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // not JSON: not an event; dropped
      }
      if (event === null || typeof event !== "object") return;
      const type = String(event["type"] ?? "");
      if (type === "system" && String(event["subtype"] ?? "") === "init") {
        if (initLine === null) initLine = line;
        const id = transportSessionId(event["session_id"]);
        let identityWitness = false;
        if (id !== null) {
          if (initSessionId === null) {
            initSessionId = id;
            initIdentityLine = line;
            identityWitness = true;
          } else if (id !== initSessionId && conflictingInitLine === null) {
            conflictingInitLine = line;
            identityWitness = true;
          }
          if (identityWitness && options.onSessionId !== undefined) {
            try {
              options.onSessionId(id);
            } catch {
              // A registry that cannot be written must not kill the turn.
            }
          }
        }
      } else if (type === "assistant") {
        // Top-level only (finding 11): assistant events carry no origin;
        // parent_tool_use_id is the correlation field, and a subagent's
        // words prove nothing about the main prompt.
        const parent = event["parent_tool_use_id"];
        if (parent === undefined || parent === null) fireReceipt();
      } else if (type === "rate_limit_event") {
        // v105: the plan's usage windows, as Claude says them each turn (the Tasks page's limits).
        noteLimits(claudeLimitsOf(event));
      } else if (type === "result" && resultLine === null && primaryResultOrigin(event)) {
        resultLine = line;
        // Fallback receipt (finding 11): a SUCCESSFUL main-query completion
        // entails the prompt ran even if the stream elided assistant
        // events. Error results never fire — startup death is not delivery.
        if (event["is_error"] !== true && String(event["subtype"] ?? "") === "success") fireReceipt();
      }
      if (options.onStreamEvent !== undefined) {
        try {
          options.onStreamEvent(event);
        } catch {
          // Observational only: a broken listener never touches the run.
        }
      }
    };

    const framing = boundedJsonlFramer(JSONL_EVENT_HARD_CAP, keep);

    const watchdog = streamWatchdog(options, () => {
      timedOut = true;
      if (options.processGroup === true) killGroup(child);
      else child.kill("SIGKILL");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      watchdog.touch();
      framing.push(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      watchdog.touch();
      if (stderr.length < JSONL_STDERR_CAP) stderr += chunk.slice(0, JSONL_STDERR_CAP - stderr.length);
    });

    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      liveProviders.delete(child);
      framing.finish();
      const lines = [initLine, initIdentityLine, conflictingInitLine, resultLine, overflowLine]
        .filter((one): one is string => one !== null)
        .filter((line, index, all) => all.indexOf(line) === index);
      const settlement = container === null ? Promise.resolve<boolean | null>(null) : settleContainer(container, options);
      void settlement.then(empty => resolve({
        code: notFound ? NOT_FOUND_CODE : timedOut ? TIMEOUT_CODE : attachFailure !== null || empty === false ? CONTAINMENT_REFUSED_CODE : (code ?? 1),
        stdout: lines.join("\n"),
        stderr: empty === false ? `${stderr}\nNative process containment could not prove all descendants exited.`.trim() : attachFailure !== null && stderr === "" ? attachFailure : stderr,
        timedOut,
        notFound,
        ...containmentOf(container, empty, attachFailure),
      }));
    };

    child.on("error", error => {
      notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (stderr === "") stderr = String(error);
      finish(null);
    });
    child.on("close", code => finish(code));
  });
}
