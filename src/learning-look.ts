/**
 * Learning recovery for one project, off the console's thread (learning-child.ts in a process of its own), killed at
 * a deadline. A project whose folder doesn't answer (a disconnected drive, an iCloud folder macOS is holding) costs
 * that one project's recovery this pass, never the console.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** How long one project's recovery may take before it is stopped (the next pass tries again). */
export const LEARNING_LOOK_MS = 60_000;

export type LearningOutcome = "done" | "failed" | "no-answer";
export type LearningRunner = (input: { databaseFile: string; evidenceRoot: string; repo: string }, deadlineMs: number) => Promise<LearningOutcome>;

/** The production runner: this build's learning-child in its own process, with only what git needs from the
 * environment (no secrets, no NODE_OPTIONS). */
export const learningChild: LearningRunner = (input, deadlineMs) => new Promise(resolveOutcome => {
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(source ? "./learning-child.ts" : "./learning-child.js", import.meta.url));
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "USER"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  const child = spawn(process.execPath, [...(source ? ["--import", import.meta.resolve("tsx")] : []), entry, JSON.stringify(input)], {
    stdio: "ignore", env, killSignal: "SIGKILL",
  });
  child.unref();
  let settled = false;
  const settle = (outcome: LearningOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolveOutcome(outcome); } };
  const timer = setTimeout(() => { child.kill("SIGKILL"); settle("no-answer"); }, deadlineMs);
  timer.unref();
  child.once("error", () => settle("failed"));
  child.once("exit", code => settle(code === 0 ? "done" : "failed"));
});

/** Recover learning for each project in turn, each in its own bounded process. */
export async function recoverLearningOffThread(input: { databaseFile: string; evidenceRoot: string; repos: readonly string[] },
  options: { runner?: LearningRunner; deadlineMs?: number } = {}): Promise<Map<string, LearningOutcome>> {
  const outcomes = new Map<string, LearningOutcome>();
  for (const repo of input.repos) {
    outcomes.set(repo, await (options.runner ?? learningChild)({ databaseFile: input.databaseFile, evidenceRoot: input.evidenceRoot, repo }, options.deadlineMs ?? LEARNING_LOOK_MS));
  }
  return outcomes;
}
