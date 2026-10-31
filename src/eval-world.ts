/**
 * One eval attempt's world (docs/plans/evals-nightly.md, part C, "Where it runs"): what `toolroll evals attempt` does
 * in its own child process of the installed binary. Everything is throwaway and the world's own — its database, its
 * repository made from the case's fixture, its worktrees, its approver and worker — driven through the installed CLI
 * exactly as a person's project is (the real-model pilot's choreography, scripts/pilot.mjs). The world never learns
 * the plane's database: every command names the world's own (`--db`).
 *
 * Its builds run under the project's own fence, with the installed eval set (the hidden checks) and anything else the
 * runner names unreadable (`project sandbox --read-deny`), and every provider dispatch takes a slot of the runner's
 * gate (eval-gate.ts) through TOOLROLL_EVAL_GATE, which the runner set and this process never changes.
 *
 * The last line on stdout says how far it got: `world-start` (the world failed before the agent could start: the
 * runner records an error only if the world's database agrees nothing reached a provider), or `done`.
 */
import { closeSync, constants, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./exec.js";
import { EVALS_ROOT, worldSecret, type EvalCase } from "./evals.js";

/** The installed CLI, as the world's commands run it (the sources under a test). */
export function evalCliEntry(): { file: string; args: string[] } {
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(source ? "./bin.ts" : "./bin.js", import.meta.url));
  return { file: process.execPath, args: [...(source ? ["--import", import.meta.resolve("tsx")] : []), entry] };
}

/** Git for the world's own fixture repository, before any agent exists: no system or global config, no hooks. */
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.email=eval@toolroll.invalid", "-c", "user.name=Toolroll eval"];

function writeNew(path: string, body: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeSync(fd, body); } finally { closeSync(fd); }
}

export type WorldReport = { evalStage: "world-start" | "done"; why: string | null };

/** Make the world and run its build to the end. Never throws: a failure is the report. */
export async function runEvalWorld(one: EvalCase, input: { worldDir: string; databaseFile: string; deny: readonly string[]; timeoutMs: number }): Promise<WorldReport> {
  const { worldDir, databaseFile } = input;
  const repo = join(worldDir, "repo"), pool = join(worldDir, "pool");
  const cli = evalCliEntry();
  const say = async (argv: string[], timeoutMs = 120_000): Promise<Record<string, unknown>> => {
    const result = await run(cli.file, [...cli.args, ...argv, "--db", databaseFile, "--json"], { cwd: worldDir, timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(result.stdout) as Record<string, unknown>; } catch { /* below */ }
    if (result.code !== 0 || body["ok"] === false) throw new Error(`${argv.slice(0, 2).join(" ")}: ${String(body["message"] ?? result.stderr).slice(0, 300)}`);
    return body;
  };
  try {
    mkdirSync(repo, { recursive: true });
    for (const [path, body] of Object.entries(one.fixture)) writeNew(join(repo, ...path.split("/")), body);
    for (const argv of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", `Eval fixture ${one.id}`]]) {
      const git = await run("git", [...GIT_ARGS, ...argv], { cwd: repo, env: GIT_ENV, timeoutMs: 30_000 });
      if (git.code !== 0) throw new Error(`git ${argv[0]}: ${git.stderr.slice(0, 200)}`);
    }
    const password = worldSecret();
    const auth = ["--as", "eval", "--token", password];
    await say(["approver", "add", "eval", "--password", password]);
    const registered = await say(["runner", "register", "worker", "--repo", repo, ...auth]);
    if (typeof registered["token"] !== "string") throw new Error("the world's worker got no token");
    for (const phase of ["plan", "build", "repair"]) await say(["config", "set", phase, "--provider", one.pin.provider, "--model", one.pin.model, ...auth]);
    await say(["mode", "set", "--repo", repo, "--name", "standard", "--days", "1", ...auth]);
    await say(["task", "add", one.title, "--id", "work", "--repo", repo]);
    // The hidden checks and the plane's own state stay out of the agent's reach (sealed into the scope filed next).
    await say(["project", "sandbox", "--repo", repo, "--read-deny", [EVALS_ROOT.replace(/\/$/, ""), ...input.deny].join(","), ...auth]);
    await say(["verify", "set", "--repo", repo, "--command", "node --test", "--timeout-seconds", "120", "--yes", ...auth]);
    await say(["task", "scope", "work", "--goal", one.goal, "--touches", one.touches.join(","), "--acceptance", `${one.goal.replace(/[|;]/g, ",").slice(0, 600)}|check`,
      "--not", "Changing package or dependency files, or anything the goal doesn't ask for."]);
    const shown = await say(["task", "show", "work"]);
    const digest = (shown["scope"] as Record<string, unknown> | undefined)?.["digest"];
    if (typeof digest !== "string") throw new Error("the world's task has no scope to approve");
    await say(["task", "approve", "work", "--yes", "--digest", digest, ...auth]);
    writeNew(join(dirname(databaseFile), "worker-token"), String(registered["token"]), 0o600);
  } catch (error) {
    return { evalStage: "world-start", why: error instanceof Error ? error.message : String(error) };
  }
  // The agent's part: the worker builds (or parks with its question) until there is nothing left to do. Its outcome is
  // read from the world's records by the runner, never from here.
  await run(cli.file, [...cli.args, "watch", "--runner", "worker", "--token-file", join(dirname(databaseFile), "worker-token"), "--repo", repo, "--pool", pool,
    "--for", "1000", "--tick-every", "200", "--reconcile-every", "1000", "--bridge-every", "3600000", "--db", databaseFile, "--json"],
  { cwd: worldDir, timeoutMs: input.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return { evalStage: "done", why: null };
}
