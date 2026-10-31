/**
 * Work that reads a project's own folder synchronously, run in a process of its own and killed at a deadline, so a
 * folder that doesn't answer (a disconnected drive, an iCloud folder macOS is holding) costs that one piece of work,
 * never the console's thread: learning recovery (learning-child.ts) and Chat's first-task suggestions
 * (first-tasks-child.ts).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type FirstTaskSuggestion } from "./first-run.js";

/** How long one project's recovery may take before it is stopped (the next pass tries again). */
export const LEARNING_LOOK_MS = 60_000;
/** How long reading one project's first-task suggestions may take. */
export const FIRST_TASKS_LOOK_MS = 20_000;

export type LearningOutcome = "done" | "failed" | "no-answer";
export type LearningRunner = (input: { databaseFile: string; evidenceRoot: string; repo: string }, deadlineMs: number) => Promise<LearningOutcome>;

/** Only what git and gh need from the environment (no NODE_OPTIONS, no other secrets). */
const CHILD_ENV = ["PATH", "HOME", "TMPDIR", "LANG", "USER", "XDG_CONFIG_HOME", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR"];

/** One of this build's own child entries, given `input` as JSON, killed at the deadline. Its stdout, bounded. */
function ownChild(name: string, input: unknown, deadlineMs: number): Promise<{ outcome: LearningOutcome; stdout: string }> {
  return new Promise(resolveOutcome => {
    const source = import.meta.url.endsWith(".ts");
    const entry = fileURLToPath(new URL(source ? `./${name}.ts` : `./${name}.js`, import.meta.url));
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
    for (const one of CHILD_ENV) if (process.env[one] !== undefined) env[one] = process.env[one];
    const child = spawn(process.execPath, [...(source ? ["--import", import.meta.resolve("tsx")] : []), entry, JSON.stringify(input)], {
      stdio: ["ignore", "pipe", "ignore"], env, killSignal: "SIGKILL",
    });
    child.unref();
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (outcome: LearningOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      resolveOutcome({ outcome, stdout: Buffer.concat(chunks).toString("utf8") });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); settle("no-answer"); }, deadlineMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(chunk); });
    child.once("error", () => settle("failed"));
    child.once("close", code => settle(code === 0 ? "done" : "failed"));
  });
}

/** The production learning runner: learning-child in its own process. */
export const learningChild: LearningRunner = async (input, deadlineMs) => (await ownChild("learning-child", input, deadlineMs)).outcome;

/** Recover learning for each project in turn, each in its own bounded process. */
export async function recoverLearningOffThread(input: { databaseFile: string; evidenceRoot: string; repos: readonly string[] },
  options: { runner?: LearningRunner; deadlineMs?: number } = {}): Promise<Map<string, LearningOutcome>> {
  const outcomes = new Map<string, LearningOutcome>();
  for (const repo of input.repos) {
    outcomes.set(repo, await (options.runner ?? learningChild)({ databaseFile: input.databaseFile, evidenceRoot: input.evidenceRoot, repo }, options.deadlineMs ?? LEARNING_LOOK_MS));
  }
  return outcomes;
}

/** One project's first-task suggestions (first-run.ts findFirstTasks: its issues through gh, its TODOs through the
 * hardened git) read in a process of its own. Rejects when it failed or didn't answer: the caller keeps the generic ones. */
export async function firstTasksOffThread(repo: string, deadlineMs = FIRST_TASKS_LOOK_MS): Promise<FirstTaskSuggestion[]> {
  const ran = await ownChild("first-tasks-child", { repo }, deadlineMs);
  if (ran.outcome !== "done") throw new Error(`the first-task read ${ran.outcome === "no-answer" ? "didn't answer" : "failed"}`);
  const parsed = JSON.parse(ran.stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("the first-task read answered something else");
  return parsed.flatMap((one: unknown) => {
    const row = one as { source?: unknown; label?: unknown; draft?: unknown } | null;
    return row !== null && typeof row === "object" && (row.source === "issue" || row.source === "todo" || row.source === "generic") && typeof row.label === "string" && typeof row.draft === "string"
      ? [{ source: row.source, label: row.label.slice(0, 500), draft: row.draft.slice(0, 4000) }] : [];
  });
}
