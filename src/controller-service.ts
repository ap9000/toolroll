/** Service entry for CLI controllers; the engine remains the watch child. */
import { superviseController } from "./controller-supervisor.js";
const [file, ...argv] = process.argv.slice(2);
if (!file) throw new Error("Controller service needs an executable.");
const stopping = new AbortController();
const stop = (): void => stopping.abort();
process.on("SIGTERM", stop); process.on("SIGINT", stop);
try {
  // A stop is forwarded to the controller (SIGTERM) and waited for. Past 55 s its whole tree is stopped outright: before
  // launchd's own ExitTimeOut (60 s) kills this process and could leave the controller running without it. `up` signs
  // off within 50 s at its default grace and stops itself if this process dies first (operate.ts upCommand).
  await superviseController({ file, argv, signal: stopping.signal, shutdownMs: 55_000, onState: state => {
    if (state.phase === "backoff") process.stderr.write(`Controller exited (${state.exit?.signal ?? state.exit?.code ?? "unknown"}); restart in ${state.retryMs} ms.\n`);
  } });
} finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
