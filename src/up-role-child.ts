/**
 * Started only by `toolroll up` (up-processes.ts): one of its two roles, the console or the worker, in a process of
 * its own. It takes its whole start from the parent over the IPC channel (never from arguments or the environment, so
 * the runner token is in no process listing), and stops when the parent says so or goes away.
 */
import { parentMessage, startMessage, type ParentToRole, type RolePort, type RoleToParent } from "./up-processes.js";

if (process.send === undefined || !process.connected) {
  process.stderr.write("This process is started by `toolroll up`; run `toolroll up` instead.\n");
  process.exit(2);
}

// node:sqlite still says it is experimental; the CLI hushes exactly that notice, and so does a role.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" && (warning instanceof Error ? warning.message : String(warning)).includes("SQLite")) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const handlers: ((message: ParentToRole) => void)[] = [];
const stops: ((hard: boolean) => void)[] = [];
let stopRequested = false;
const stop = (hard: boolean): void => {
  stopRequested = true;
  for (const one of stops) one(hard);
};
const port: RolePort = {
  send: (message: RoleToParent) => { if (process.connected) { try { process.send?.(message); } catch { /* the parent is gone; its loss stops this role */ } } },
  onMessage: handler => { handlers.push(handler); },
  onStop: handler => { stops.push(handler); if (stopRequested) handler(false); },
};

// A terminal's Ctrl-C reaches the whole process group: the parent decides what a signal means (drain, then a hard
// stop on the second), so a role never acts on SIGINT itself. SIGTERM (the supervisor's stop) drains, once.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => stop(false));
// The parent gone (its channel closed): drain, as a stop would. The worker's own grace timer bounds it; past a minute
// with nobody left to stop it, the role stops its work outright and ends, never running on as an orphan.
process.once("disconnect", () => {
  stop(false);
  setTimeout(() => { stop(true); setTimeout(() => process.exit(1), 5_000).unref(); }, 60_000).unref();
});

const start = await new Promise<unknown>(resolve => {
  const timer = setTimeout(() => resolve(null), 60_000);
  process.once("message", value => { clearTimeout(timer); resolve(value); });
});
const checked = startMessage(start);
// The role named on the command line (for a process listing) and the one started must be the same.
if (checked === null || checked.role !== process.argv[2]) {
  process.stderr.write("The start message from `toolroll up` was not understood.\n");
  process.exit(2);
}
process.on("message", value => {
  const message = parentMessage(value);
  if (message === null) return;
  if (message.type === "hard-stop") { stop(true); return; }
  for (const one of handlers) one(message);
});

const { runUpRole } = await import("./operate.js");
let code = 1;
try { code = await runUpRole(checked, port); }
catch (error) { port.send({ type: "fatal", detail: error instanceof Error ? error.message : String(error) }); }
// Everything this role owned is closed; leave promptly even if a stray handle lingers.
if (process.connected) process.disconnect?.();
setTimeout(() => process.exit(code), 200).unref();
process.exitCode = code;
