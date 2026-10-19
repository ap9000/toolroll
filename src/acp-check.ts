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
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACP_AGENTS, isAcpProvider } from "./acp-agents.js";
import { ACP_CONFORMANCE_VERSION, launchOf } from "./acp-attest.js";
import { inspectAcpAgent } from "./acp-inspect.js";
import { acquireForCheck, release } from "./claim.js";
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
/** How long the agent has to answer the cancel. */
const CANCEL_ANSWER_MS = 15_000;

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

/** Close what no live watch holds any more, let go of what finished checks still hold, then run this runner's next
 * check, if one is waiting. */
export async function runAcpChecks(job: AcpCheckJob): Promise<void> {
  const clock = job.clock ?? (() => new Date());
  job.store.expireAcpChecks(clock());
  for (const abandoned of job.store.abandonedAcpChecks(job.runner, clock())) job.store.failAcpCheck(abandoned.id, "interrupted", clock());
  await settleChecks(job, clock);
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
  await settleChecks(job, clock);
}

/**
 * Let go of what finished checks hold — their own claim, their checkout, their task — once nothing of theirs can
 * still be running. A check is settled only when all of it is let go; anything that can't be yet (a run still open,
 * a process not proved gone, a checkout that wouldn't discard) is retried on the next pass. Nothing another holder
 * owns is touched: only the claim the check recorded as its own, and only its own branch's checkout, and only while
 * no one else holds the task.
 */
async function settleChecks(job: AcpCheckJob, clock: () => Date): Promise<void> {
  const { store } = job;
  for (const request of store.unsettledAcpChecks(job.runner)) {
    try {
      if (request.taskRef === null) { store.settleAcpCheck(request.id, clock()); continue; }
      const ref = request.taskRef;
      const open = store.runsFor(ref).some(run => run.outcome === null || store.openRunProcessCount(run.id, clock()) > 0);
      if (open) continue;
      const lease = store.currentLiveLease(ref, clock());
      if (lease !== null && lease !== request.leaseId) continue; // someone else holds the task now: not ours to touch
      if (lease !== null) release(store, lease, clock());
      const branch = `toolroll/agent-check-${request.id}`;
      let discarded = true;
      for (const row of store.listWorktrees().filter(one => one.taskRef === ref && one.branch === branch && one.repo === (request.watch?.repo ?? one.repo))) {
        if (row.releasedAt === null) await job.pool.release(row.path, clock());
        if (!(await job.pool.discard(row.path, clock())).ok) discarded = false;
      }
      if (!discarded) continue;
      const taskId = store.refForId(ref)?.externalId;
      if (taskId !== undefined) store.setTaskState(taskId, request.state === "passed" ? "done" : "failed", clock());
      store.settleAcpCheck(request.id, clock());
    } catch {
      // Retried on the next pass.
    }
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
  const took = acquireForCheck(store, ref, job.runner, { now: clock(), token: job.token, newLeaseId: () => leaseId, ttlMs: 30 * 60_000, incarnation: job.watch.owner });
  if (!took.ok) { store.setTaskState(taskId, "failed", clock()); return fail(`the check couldn't claim its task (${took.reason})`); }
  if (!store.bindAcpCheck(request.id, { taskRef: ref, launchJson: JSON.stringify(launch), leaseId }, clock())) {
    release(store, leaseId, clock());
    store.setTaskState(taskId, "failed", clock());
    return fail("the check lost its watch before it began");
  }
  // From here on, what the check holds is let go by settleChecks, whatever happens.
  const leased = await job.pool.lease({ repo: job.watch.repo, branch: `toolroll/${taskId}`, base: "HEAD", runner: job.runner, taskRef: ref, now: clock() });
  if (!leased.ok) return fail(`the check's checkout couldn't be made: ${leased.message}`);
  const worktree = leased.worktree.path;
  const stateDir = dirname(realpathSync(store.databaseFile() ?? "."));
  // Named as a secret is, beside the database: fenced whether the state folder is Toolroll's own or shared.
  const canaryFile = join(stateDir, `acp-check-secret-${request.id}`);
  let verdict: string | null = null;
  try {
    verdict = await steps(job, request, { ref, leaseId, worktree, canaryFile }, clock);
  } finally {
    rmSync(canaryFile, { force: true });
  }
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
  // The checkout carries the project's HEAD: anything already named done.txt goes first, so only the agent's own
  // write can make it say ok.
  rmSync(join(at.worktree, "done.txt"), { force: true, recursive: true });
  /** The tool calls the runner saw, by id: their kind, and whether they completed. */
  const calls = new Map<string, { kind: string | null; done: boolean }>();
  const first = await invokeAgent(store, run1, spec, ask(CHECK_PROMPTS.ok), options({
    env: { ANTHROPIC_API_KEY: envValue },
    acpCheck: { requestId: request.id, step: 1, isolation: { file: at.canaryFile, fileCanary, envValue } },
    onStreamEvent: event => {
      const update = event["acp"] as Record<string, unknown> | undefined;
      const id = update?.["toolCallId"];
      if (typeof id !== "string" || (update?.["sessionUpdate"] !== "tool_call" && update?.["sessionUpdate"] !== "tool_call_update")) return;
      const before = calls.get(id) ?? { kind: null, done: false };
      calls.set(id, { kind: typeof update["kind"] === "string" ? update["kind"] : before.kind, done: before.done || update["status"] === "completed" });
    },
  }));
  finish(run1);
  // An edit (or a command) the runner saw complete: a read can't make done.txt.
  const wrote = [...calls.values()].some(one => one.done && (one.kind === "edit" || one.kind === "execute"));
  const one = gradeOk(first, at.worktree, wrote);
  if (one.verdict !== null) return `session-ok: ${one.verdict}`;
  if (!store.passAcpCheckStep(request.id, 1, run1, clock())) return "the check stopped admitting its first step's result";

  // Step 2: session-stop.
  const held2 = budget();
  if (held2 !== null) return held2;
  const run2 = startRun();
  if (!store.consumeAcpCheckStep(request.id, 2, run2, clock())) { finish(run2); return "the check stopped admitting its second step"; }
  let witnessed: { pid: number; group: number }[] = [];
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
        if (Date.now() > until) { clearInterval(poll); control.cancel(CANCEL_ANSWER_MS); return; }
        if (!started) return;
        const live = control.liveDescendants();
        if (live !== null && live.length > 0) { witnessed = live; clearInterval(poll); control.cancel(CANCEL_ANSWER_MS); }
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
  if (!toolDone) return { verdict: "no edit or command was seen to complete" };
  if (smallFile(join(worktree, "done.txt"))?.trim() !== "ok") return { verdict: "done.txt doesn't say ok" };
  return { verdict: null };
}

function gradeStop(result: InvokeResult, witnessed: readonly { pid: number; group: number }[]): string | null {
  const facts = result.kind === "ran" ? result.outcome.acp : result.acp;
  if (witnessed.length === 0) return "no command the agent started was seen alive before the cancel";
  if (facts === undefined) return "the runner recorded no conversation";
  // The expected end, and only it: answered cancelled in time (the runner stops an unanswered cancel and the
  // conversation fails), no protocol breach, no timeout, and an ending the runner itself saw.
  if (facts.protocolError !== null) return `the agent broke the protocol: ${facts.protocolError}`;
  if (facts.stop !== "cancelled") return `the prompt ended ${facts.stop ?? "without an answer"}, not cancelled`;
  if (facts.exit === null || facts.exit.timedOut || facts.exit.how === "error") return "the agent's process didn't end cleanly after the cancel";
  if (result.kind === "refused" && result.reason !== "provider-protocol") return `the run was refused: ${result.diagnostic ?? result.reason}`;
  // Its whole process tree ended with it, proved: nothing left for the runner to kill, and no containment in doubt.
  if (facts.exit.leftover) return "the agent left processes running after the cancel";
  if (result.kind === "ran" && result.outcome.code === 126) return "the runner couldn't prove the agent's processes all ended";
  // Every process alive at the cancel is gone — and so is every process group it was in: a leader that exited after
  // forking leaves its group behind, which is no stop at all.
  for (const { pid, group } of witnessed) {
    try { process.kill(pid, 0); return `process ${pid}, alive at the cancel, is still running`; } catch { /* gone */ }
    try { process.kill(-group, 0); return `process group ${group}, alive at the cancel, still has members`; } catch { /* gone */ }
  }
  return null;
}

/** A file the agent wrote, read only if it is a plain file (no link followed, no FIFO or device) and tiny. */
function smallFile(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64) return null;
    const buffer = Buffer.alloc(64);
    return buffer.subarray(0, readSync(fd, buffer, 0, 64, 0)).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
