import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { stopProcessTree } from "./process-tree.js";

export type ControllerState = {
  phase: "starting" | "running" | "backoff" | "stopped";
  generation: number;
  controllerPid: number | null;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  retryMs?: number;
};

/** A service process supervises exactly one controller. It knows nothing
 * about tasks, credentials, claims, or retries: those remain in `up`.
 *
 * This closes a Node-controller crash without depending on launchd starting
 * another process. It does not claim to survive its own SIGKILL or bypass an
 * OS policy that defers a LaunchAgent. Children share the service's process
 * group so launchd can also clean up the controller when this process dies.
 */
export async function superviseController(args: {
  file: string;
  argv: readonly string[];
  signal: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onState?: (state: ControllerState) => void;
  retryMs?: number;
  maxRetryMs?: number;
  stableMs?: number;
  shutdownMs?: number;
  /** An IPC channel to each controller (fd 3), for a parent that speaks to it (`toolroll up`'s console and worker). */
  ipc?: boolean;
  /** Prefix every line the controller writes, sent to this process's stderr: two controllers' logs stay apart. An
   * empty label sends its lines there unprefixed (a JSON log keeps one object a line). */
  label?: string;
  /** Each spawned controller's handle, before it runs: the caller listens to its messages and may signal it. */
  onSpawn?: (child: ChildProcess, generation: number) => void;
}): Promise<void> {
  const retryMs = args.retryMs ?? 1_000;
  const maxRetryMs = args.maxRetryMs ?? 30_000;
  const stableMs = args.stableMs ?? 30_000;
  const shutdownMs = args.shutdownMs ?? 45_000;
  for (const value of [retryMs, maxRetryMs, stableMs, shutdownMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Invalid controller supervision interval.");
  }
  if (maxRetryMs < retryMs) throw new Error("Controller restart ceiling must cover its initial delay.");
  let generation = 0;
  let failures = 0;
  let child: ChildProcess | null = null;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const emit = (state: ControllerState): void => {
    // Telemetry cannot interrupt a graceful stop or orphan the owned child.
    try { args.onState?.(state); }
    catch { process.stderr.write("Controller supervisor could not record its status.\n"); }
  };
  const stop = (): void => {
    const owned = child;
    if (owned === null || owned.exitCode !== null || owned.signalCode !== null) return;
    owned.kill("SIGTERM");
    if (escalation !== null) return;
    escalation = setTimeout(() => {
      // Signals come only from the still-owned ChildProcess, never status PIDs.
      if (owned.exitCode === null && owned.signalCode === null && !stopProcessTree(owned)) owned.kill("SIGKILL");
    }, shutdownMs);
  };
  args.signal.addEventListener("abort", stop);
  try {
    while (!args.signal.aborted) {
      generation++;
      const started = performance.now();
      emit({ phase: "starting", generation, controllerPid: null });
      // The callback above can synchronously cancel before the OS spawn.
      if (args.signal.aborted) break;
      const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
        const output = args.label === undefined ? "inherit" : "pipe";
        const owned = spawn(args.file, [...args.argv], {
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.env === undefined ? {} : { env: args.env }),
          stdio: args.ipc === true ? ["ignore", output, output, "ipc"] : args.label === undefined ? "inherit" : ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        child = owned;
        if (args.label !== undefined) for (const stream of [owned.stdout, owned.stderr]) labelLines(stream, args.label);
        try { args.onSpawn?.(owned, generation); }
        catch { process.stderr.write("Controller supervisor could not attach to its controller.\n"); }
        owned.once("spawn", () => {
          emit({ phase: "running", generation, controllerPid: owned.pid ?? null });
          if (args.signal.aborted) stop();
        });
        // `close` follows both a spawn error and ordinary exit; await it so
        // the next generation cannot overlap the previous controller handle.
        owned.once("error", () => {});
        owned.once("close", (code, signal) => done({ code, signal }));
        if (args.signal.aborted) stop();
      });
      child = null;
      if (escalation !== null) { clearTimeout(escalation); escalation = null; }
      if (args.signal.aborted) break;
      failures = performance.now() - started >= stableMs ? 0 : Math.min(failures + 1, 20);
      const delay = Math.min(maxRetryMs, retryMs * 2 ** Math.max(0, failures - 1));
      emit({ phase: "backoff", generation, controllerPid: null, exit: exited, retryMs: delay });
      await new Promise<void>(done => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = (): void => { clearTimeout(timer); args.signal.removeEventListener("abort", finish); done(); };
        timer = setTimeout(finish, delay);
        args.signal.addEventListener("abort", finish, { once: true });
        if (args.signal.aborted) finish();
      });
    }
  } finally {
    args.signal.removeEventListener("abort", stop);
    if (escalation !== null) clearTimeout(escalation);
    emit({ phase: "stopped", generation, controllerPid: null });
  }
}

/** Each whole line of a controller's output, prefixed with its label, on this process's stderr. */
function labelLines(stream: NodeJS.ReadableStream | null, label: string): void {
  if (stream === null) return;
  const prefix = label === "" ? "" : `${label} `;
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    // Bounded: a controller that never ends a line still reaches the log.
    if (pending.length > 64 * 1024) { lines.push(pending); pending = ""; }
    for (const line of lines) process.stderr.write(`${prefix}${line}\n`);
  });
  stream.on("end", () => { if (pending !== "") process.stderr.write(`${prefix}${pending}\n`); pending = ""; });
  stream.on("error", () => {});
}
