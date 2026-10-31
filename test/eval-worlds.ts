/**
 * Eval worlds for tests (src/evals.test.ts, src/evals.slow.test.ts): what a world's installed code would leave behind
 * (its database, its repository at the built commit, the gate slots its dispatches took), a stand-in world child, and
 * the probe in a plain child process (the oracle's own tests prove the fence). No provider is called.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { EVAL_GATE_ENV, takeEvalDispatch } from "../src/eval-gate.js";
import { gradeCase, type GradeRunner } from "../src/eval-oracle.js";
import { loadEvalSet, type AttemptDeps, type EvalCase } from "../src/evals.js";
import { openStore } from "../src/store.js";

export const NOW = new Date("2026-10-30T12:00:00.000Z");
export const SET = (() => { const set = loadEvalSet(); if (!set.ok) throw new Error(set.problem); return set; })();
export const paginate = (over: Partial<EvalCase> = {}): EvalCase => ({ ...SET.cases.find(one => one.id === "paginate")!, ...over });

/** A run as a world's gateway would leave it: `basis` how its billing was known (default: its own evidence). */
export type RunSpec = { role?: string; started?: boolean; built?: boolean; model?: string | null; api?: number | null; subscriptionUsd?: number; gated?: boolean; basis?: "evidence" | "default" };
/** `chatBilling`: how each chat request's own events said it was billed (default: the plan). */
export type WorldSpec = { runs?: RunSpec[]; chats?: number; chatSlots?: number; chatBilling?: "subscription" | "api-key" | null; source?: string; database?: boolean };

/** What a world's installed code would leave behind: its database (runs, chat requests), its repository at the built
 * commit, and the slots its dispatches took. */
export function makeWorld(input: { worldDir: string; databaseFile: string; gateDir: string }, spec: WorldSpec): void {
  if (spec.database === false) return;
  const repo = join(input.worldDir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8", env: { PATH: process.env["PATH"]!, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "paginate.js"), spec.source ?? "export const paginate = (items, offset = 0, limit = 10) => { const from = Math.max(0, offset); return items.slice(from, from + limit); };\n");
  git("add", "-A");
  git("commit", "-q", "-m", "built");
  const head = git("rev-parse", "HEAD");
  const world = openStore(input.databaseFile);
  const env = { [EVAL_GATE_ENV]: input.gateDir };
  try {
    world.upsertProject(repo, "world", NOW);
    world.createTask({ id: "work", title: "work" }, NOW);
    const taskRef = world.refFor("built-in", "work").id;
    for (const [at, run] of (spec.runs ?? []).entries()) {
      const authority = world.routeAuthorityFor(taskRef, "builder") ?? world.routeAuthorityFor(taskRef, "builder", { provider: "claude", model: null });
      const id = world.startRun({ taskRef, leaseId: `l-${at}`, runner: "worker", branch: "b", worktree: `/w/${at}`, now: NOW, ...(authority?.ok ? { route: authority.stamp } : {}) });
      if (run.gated !== false) expect(takeEvalDispatch(`run:${id}`, env).active).toBe(true);
      if (run.started === false) { world.handle.prepare("UPDATE run SET outcome = 'refused', reason = 'provider-unattested', finished_at = ? WHERE id = ?").run(NOW.toISOString(), id); continue; }
      world.handle.prepare("UPDATE run SET role = ?, provider_started_at = ?, outcome = ?, finished_at = ?, head_revision = ?, model_reported = ?, cost_usd = ?, billing_basis = ? WHERE id = ?")
        .run(run.role ?? "builder", NOW.toISOString(), run.built === false ? "failed" : "built", NOW.toISOString(), run.built === false ? null : head, run.model === undefined ? paginate().pin.model : run.model,
          run.subscriptionUsd ?? null, run.basis ?? "evidence", id);
      if (run.subscriptionUsd !== undefined) world.handle.prepare("INSERT INTO run_spend (run, microusd, source, billing, priced_at) VALUES (?, 0, 'subscription', 'subscription', ?)").run(id, NOW.toISOString());
      else if (run.api !== null) world.handle.prepare("INSERT INTO run_spend (run, microusd, source, billing, priced_at) VALUES (?, ?, 'reported', 'api-key', ?)").run(id, run.api ?? 300_000, NOW.toISOString());
    }
    for (let at = 0; at < (spec.chats ?? 0); at++) {
      world.handle.prepare(`INSERT INTO chat_turn (approver, credential_key, provider, model, state, created_at, reserved_microusd, settled_microusd, tokens_in, tokens_out, model_reported, reported_cost_usd, billing_reported)
        VALUES ('eval', 'k', 'claude-subscription', 'sonnet', 'answered', ?, 0, 0, 10, 2, ?, 0.02, ?)`).run(NOW.toISOString(), paginate().pin.model, spec.chatBilling === undefined ? "subscription" : spec.chatBilling);
    }
    for (let at = 0; at < (spec.chatSlots ?? spec.chats ?? 0); at++) expect(takeEvalDispatch("chat:claude-subscription", env).active).toBe(true);
  } finally { world.close(); }
}

/** A stand-in world child: node running `script` (CommonJS), in its own process group as the runner starts it. */
export const child = (script: string) => ({ file: process.execPath, args: ["-e", script], env: { PATH: process.env["PATH"]! } });

/** Test only: the probe in a plain child process (the oracle's own tests prove the fence). */
export const plain: GradeRunner = ({ cwd, stdin, timeoutMs }) => new Promise(done => {
  const proc = execFile(process.execPath, ["probe.mjs"], { cwd, timeout: timeoutMs }, (error, stdout) => done({ code: error === null ? 0 : 1, stdout: String(stdout), timedOut: error?.killed === true }));
  proc.stdin?.end(stdin);
});

/** An attempt's dependencies with a test world: worlds under `dir`, the oracle through the plain runner (each grading's time recorded). */
export function worldDeps(dir: string, spec: WorldSpec, script = "process.exit(0)", over: Partial<AttemptDeps> = {}): AttemptDeps & { graded: number[] } {
  const graded: number[] = [];
  return {
    graded,
    workRoot: join(dir, "worlds"),
    settleMs: 5_000,
    now: () => NOW,
    command: input => { makeWorld(input, spec); return child(script); },
    oracle: async input => { graded.push(Date.now()); return gradeCase({ ...input, runner: plain }); },
    ...over,
  };
}

