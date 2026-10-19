/**
 * An ACP agent's conformance check (docs/plans/acp-adapter.md § Layer E): what admits an agent to run on this runner.
 *
 * A person asks for it (`toolroll agents check`, with a password); a watch of the named runner runs it, under that
 * watch's own lease and custody, as a real task of the watch's project with two real runs through the one gateway —
 * the same fence, environment shedding, containment, stop watch and spend as any build. Each run is admitted by the
 * check request (never by an attestation), and graded only on evidence the plane observed itself:
 *
 * 1. session-ok: the plane's own isolation probes inside the exact fence and environment the agent gets (a canary
 *    file in the fenced state unreadable, a canary key absent); a tool call the runner saw complete; the prompt's
 *    `end_turn`; the agent leaving on stdin's end with nothing of its group left; and done.txt saying ok.
 * 2. session-stop: a live descendant of the agent, seen by the plane's own reading, before the cancel; the
 *    `cancelled` answer; and every process alive at the cancel gone after.
 *
 * Only when both passed is the attestation recorded — in the same transaction that marks the request passed, while
 * it is unexpired and its watch still holds its lease. Anything else fails the request, in words, and admits nothing.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACP_AGENTS, isAcpProvider } from "./acp-agents.js";
import { ACP_CONFORMANCE_VERSION, launchOf } from "./acp-attest.js";
import { inspectAcpAgent } from "./acp-inspect.js";
import { acquire, release } from "./claim.js";
import type { AcpControl, RunOptions } from "./exec.js";
import { invokeAgent, type InvokeResult } from "./invoke.js";
import type { ProviderRunner } from "./provider.js";
import { BUILT_IN, type AcpCheckRequest, type Store } from "./store.js";
import type { WorktreePool } from "./worktree.js";

export const CHECK_PROMPTS = {
  ok: "Create a file named done.txt in the current folder containing exactly the word ok. Then stop. Do nothing else.",
  stop: "Run the shell command `sleep 120` and wait for it to finish.",
} as const;

/** How long the stop step waits for the agent to start its command, and for the cancel to be answered. */
const STOP_WAIT_MS = 60_000;

export type AcpCheckJob = {
  store: Store;
  runner: string;
  token: string;
  /** The watch running it: its project and its lease's owner. */
  watch: { repo: string; owner: string };
  pool: WorktreePool;
  clock?: () => Date;
  keyHome?: string;
  /** Tests only: a stand-in agent runner. */
  agent?: ProviderRunner;
  /** Tests only: a PATH to find the agent on. */
  env?: Readonly<Record<string, string | undefined>>;
  progress?: (line: string) => void;
};

/** Close what no live watch holds any more, then run this runner's next check, if one is waiting. */
export async function runAcpChecks(job: AcpCheckJob): Promise<void> {
  const clock = job.clock ?? (() => new Date());
  job.store.expireAcpChecks(clock());
  for (const abandoned of job.store.abandonedAcpChecks(job.runner, clock())) {
    // Only a check whose runs are all finished is closed here; one still running is a person's (its worktree stays).
    const open = [abandoned.step1Run, abandoned.step2Run].filter((one): one is number => one !== null).some(run => job.store.getRun(run)?.outcome === null);
    job.store.failAcpCheck(abandoned.id, open ? "interrupted while a step was running — its checkout was left for a person" : "interrupted", clock());
  }
  if (process.platform === "win32") return;
  const request = job.store.claimAcpCheck(job.runner, job.watch, clock());
  if (request === null) return;
  const name = isAcpProvider(request.provider) ? ACP_AGENTS[request.provider].name : request.provider;
  job.progress?.(`agents: checking ${name} (${request.model}) on ${job.runner}`);
  try {
    const verdict = await check(job, request, clock);
    job.progress?.(`agents: ${name} ${verdict === null ? "passed its check" : `failed its check — ${verdict}`}`);
  } catch (error) {
    job.store.failAcpCheck(request.id, `the check stopped: ${error instanceof Error ? error.message : String(error)}`, clock());
  }
}

/** Run one claimed check; null when it passed (and was published), else why not. */
async function check(job: AcpCheckJob, request: AcpCheckRequest, clock: () => Date): Promise<string | null> {
  const { store } = job;
  const fail = (words: string): string => { store.failAcpCheck(request.id, words, clock()); return words; };
  if (!isAcpProvider(request.provider)) return fail("not an ACP agent");
  const env = job.env ?? process.env;

  // What runs: the binary on this runner's PATH, its launch pinned and every file it depends on bound.
  const seen = inspectAcpAgent(request.provider, env);
  if (!seen.found) return fail(`${ACP_AGENTS[request.provider].binary} isn't installed on ${job.runner}`);
  const launch = launchOf(seen.realpath, env["PATH"] ?? "");
  if ("problem" in launch) return fail(launch.problem);

  // A task of the watch's own project, placed and claimed like any other, bound to the request.
  const taskId = `agent-check-${request.id}`;
  store.createTask({ id: taskId, title: `Check ${ACP_AGENTS[request.provider].name} (${request.model})` }, clock());
  const ref = store.refFor(BUILT_IN, taskId).id;
  store.placeTask(ref, job.watch.repo);
  const leaseId = `agent-check-${request.id}-${randomBytes(4).toString("hex")}`;
  const took = acquire(store, ref, job.runner, { now: clock(), token: job.token, newLeaseId: () => leaseId, ttlMs: 30 * 60_000 });
  if (!took.ok) return fail(`the check couldn't claim its task (${took.reason})`);
  if (!store.bindAcpCheck(request.id, { taskRef: ref, launchJson: JSON.stringify(launch) }, clock())) {
    release(store, leaseId, clock());
    return fail("the check lost its watch before it began");
  }
  const leased = await job.pool.lease({ repo: job.watch.repo, branch: `toolroll/${taskId}`, base: "HEAD", runner: job.runner, taskRef: ref, now: clock() });
  if (!leased.ok) {
    release(store, leaseId, clock());
    store.setTaskState(taskId, "failed", clock());
    return fail(`the check's checkout couldn't be made: ${leased.message}`);
  }
  const worktree = leased.worktree.path;
  const stateDir = dirname(realpathSync(store.databaseFile() ?? "."));
  // Named as a secret is, beside the database: fenced whether the state folder is Toolroll's own or shared.
  const canaryFile = join(stateDir, `acp-check-secret-${request.id}`);
  let verdict: string | null = null;
  try {
    verdict = await steps(job, request, { ref, leaseId, worktree, canaryFile }, clock);
  } finally {
    rmSync(canaryFile, { force: true });
    release(store, leaseId, clock());
    await job.pool.release(worktree, clock());
    await job.pool.discard(worktree, clock());
  }
  store.setTaskState(taskId, verdict === null ? "done" : "failed", clock());
  if (verdict !== null) store.failAcpCheck(request.id, verdict, clock());
  return verdict;
}

type StepContext = { ref: number; leaseId: string; worktree: string; canaryFile: string };

async function steps(job: AcpCheckJob, request: AcpCheckRequest, at: StepContext, clock: () => Date): Promise<string | null> {
  const { store } = job;
  const spec = { provider: request.provider as Parameters<typeof invokeAgent>[2]["provider"], model: request.model };
  const ask = (brief: string) => ({ phase: "build" as const, brief, maxTurns: 1, permissionMode: "bypassPermissions", skipPermissions: true, resumeSession: null });
  const budget = (): string | null => {
    const agent = store.agentFor(request.provider, request.model, job.runner);
    if (store.budgetGate(clock())({ ...store.budgetSubject(at.ref), agents: [agent] }).over !== null) return "a monthly budget holds metered work, and this model is metered here";
    if (agent.billing === "api-key" && store.getSpendDefaults()?.buildPerRunMicrousd != null) return "a per-run dollar cap is set, and this metered model can't hold one (budget-unenforceable)";
    return null;
  };
  const startRun = () => store.startRun({ taskRef: at.ref, leaseId: at.leaseId, runner: job.runner, branch: `toolroll/agent-check-${request.id}`, worktree: at.worktree,
    route: { routeDigest: "legacy", phase: "build", provider: request.provider, model: request.model, chosen: "legacy" }, now: clock() });
  const finish = (run: number) => store.finishRun(run, { outcome: "refused", reason: "agent-check", now: clock() });
  const options = (extra: Partial<RunOptions>): Parameters<typeof invokeAgent>[4] => ({
    cwd: at.worktree, idleTimeoutMs: 60_000, timeoutMs: 300_000, clock,
    ...(job.keyHome === undefined ? {} : { keyHome: job.keyHome }),
    ...(job.agent === undefined ? {} : { runner: job.agent }),
    ...extra,
  });

  // Step 1: session-ok.
  const held1 = budget();
  if (held1 !== null) return held1;
  const run1 = startRun();
  if (!store.consumeAcpCheckStep(request.id, 1, run1, clock())) { finish(run1); return "the check stopped admitting its first step (expired, or its watch lost the lease)"; }
  const fileCanary = randomBytes(18).toString("hex");
  const envValue = `sk-ant-canary-${randomBytes(18).toString("hex")}`;
  writeFileSync(at.canaryFile, fileCanary, { mode: 0o600 });
  let toolDone = false;
  const first = await invokeAgent(store, run1, spec, ask(CHECK_PROMPTS.ok), options({
    env: { ANTHROPIC_API_KEY: envValue },
    acpCheck: { requestId: request.id, step: 1, isolation: { file: at.canaryFile, fileCanary, envValue } },
    onStreamEvent: event => {
      const update = event["acp"] as Record<string, unknown> | undefined;
      if (update?.["sessionUpdate"] === "tool_call_update" && update["status"] === "completed") toolDone = true;
      if (update?.["sessionUpdate"] === "tool_call" && update["status"] === "completed") toolDone = true;
    },
  }));
  finish(run1);
  const one = gradeOk(first, at.worktree, toolDone);
  if (one.verdict !== null) return `session-ok: ${one.verdict}`;
  if (!store.passAcpCheckStep(request.id, 1, run1, clock())) return "the check stopped admitting its first step's result";

  // Step 2: session-stop.
  const held2 = budget();
  if (held2 !== null) return held2;
  const run2 = startRun();
  if (!store.consumeAcpCheckStep(request.id, 2, run2, clock())) { finish(run2); return "the check stopped admitting its second step"; }
  let witnessed: number[] = [];
  let started = false;
  const second = await invokeAgent(store, run2, spec, ask(CHECK_PROMPTS.stop), options({
    acpCheck: { requestId: request.id, step: 2 },
    onStreamEvent: event => {
      const update = event["acp"] as Record<string, unknown> | undefined;
      if ((update?.["sessionUpdate"] === "tool_call" || update?.["sessionUpdate"] === "tool_call_update") && update["kind"] !== "read" && update["status"] === "in_progress") started = true;
    },
    acp: { prompt: "", model: "", expect: null, onControl: (control: AcpControl) => {
      // The agent's word only times the cancel: what the plane itself sees alive is what is graded.
      const until = Date.now() + STOP_WAIT_MS;
      const poll = setInterval(() => {
        if (Date.now() > until) { clearInterval(poll); control.cancel(); return; }
        if (!started) return;
        const live = control.liveDescendants();
        if (live !== null && live.length > 0) { witnessed = live; clearInterval(poll); control.cancel(); }
      }, 200);
      poll.unref?.();
    } },
  }));
  finish(run2);
  const two = gradeStop(second, witnessed);
  if (two !== null) return `session-stop: ${two}`;
  if (!store.passAcpCheckStep(request.id, 2, run2, clock())) return "the check stopped admitting its second step's result";

  // Both passed: publish, in one transaction with the attestation.
  const facts = first.kind === "ran" ? first.outcome.acp : undefined;
  if (facts?.agent == null) return "the agent never said who it is";
  const published = store.publishAcpCheck(request.id, {
    provider: request.provider, runner: job.runner, launch: JSON.parse(store.acpCheck(request.id)?.launchJson ?? "null"),
    agent: facts.agent, cliVersion: facts.agent.version, models: facts.offered, checks: [`conformance v${ACP_CONFORMANCE_VERSION}`, "isolation", "session-ok", "session-stop"],
    recordedBy: request.requestedBy,
  }, clock());
  return published ? null : "the check couldn't be published (expired, or its watch lost the lease)";
}

function gradeOk(result: InvokeResult, worktree: string, toolDone: boolean): { verdict: string | null } {
  if (result.kind !== "ran") return { verdict: `the run was refused: ${result.diagnostic ?? result.reason}` };
  const facts = result.outcome.acp;
  if (facts === undefined) return { verdict: "the runner recorded no conversation" };
  if (facts.isolation === undefined) return { verdict: "the plane's isolation probes didn't run (no OS fence?)" };
  if (!facts.isolation.fileDenied) return { verdict: "a file in the fenced state was readable inside the fence" };
  if (!facts.isolation.envClear) return { verdict: "a key the launch should shed reached the agent's environment" };
  if (facts.stop !== "end_turn") return { verdict: `the prompt ended ${facts.stop ?? "without an answer"}, not end_turn` };
  if (result.outcome.code !== 0) return { verdict: `the agent exited ${result.outcome.code}` };
  if (facts.exit?.how !== "eof") return { verdict: `the agent didn't leave on its own when its input closed (${facts.exit?.how ?? "unknown"})` };
  if (facts.exit.leftover) return { verdict: "the agent left processes running" };
  if (!toolDone) return { verdict: "no tool call was seen to complete" };
  const done = join(worktree, "done.txt");
  if (!existsSync(done) || readFileSync(done, "utf8").trim() !== "ok") return { verdict: "done.txt doesn't say ok" };
  return { verdict: null };
}

function gradeStop(result: InvokeResult, witnessed: readonly number[]): string | null {
  const facts = result.kind === "ran" ? result.outcome.acp : result.acp;
  if (witnessed.length === 0) return "no command the agent started was seen alive before the cancel";
  if (facts === undefined) return "the runner recorded no conversation";
  if (facts.stop !== "cancelled") return `the prompt ended ${facts.stop ?? "without an answer"}, not cancelled`;
  for (const pid of witnessed) {
    try { process.kill(pid, 0); return `process ${pid}, alive at the cancel, is still running`; } catch { /* gone */ }
  }
  return null;
}
