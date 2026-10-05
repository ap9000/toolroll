/** Batch checks: like a merge queue, for projects that run the full check after every build.
 *
 * With batching on (a per-project setting, off by default), a Full build doesn't run its check
 * inline. It asks for a batch check on its exact commit, and waits up to the window (10 minutes)
 * for another result of the same project and the same approved command. The batch pass then
 * merges the waiting results onto the recorded project base in a temporary, detached checkout
 * and runs the approved check once:
 *
 * - it passes: every result gets its own sealed receipt, "checked together with" the others,
 *   naming the exact batch commit it tested;
 * - it fails: the batch is split in halves and each half checked, down to single results, so the
 *   one that breaks it is found and the others still pass on their own;
 * - the results conflict when merged: each is checked on its own.
 *
 * Nothing is merged into a real branch. The batch commit exists only in the temporary checkout,
 * which is always removed; each result still lands on its own.
 *
 * The queue is the follow-up check ledger (result-follow-ups.ts), with `batch` requests: the same
 * claim, receipts, abandoned-check reading, status projection and Merge gate. The policy is an
 * append-only ledger entry, like the check level. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./backend.js";
import type { Store, VerifyCommand } from "./store.js";
import type { ExecResult } from "./exec.js";
import { run as execRun } from "./exec.js";
import { approvedCommandShell, SETUP_ENV_ALLOWLIST, SETUP_ENV_DENYLIST } from "./builder.js";
import { runWithIsolatedDatabase } from "./child-database.js";
import { boundStreamHeadTail, redactSecretLines, scanForSecrets, storeEvidence } from "./evidence.js";
import { repoClause } from "./check-levels.js";
import { projectBatchChecks } from "./batch-policy.js";
import {
  CHECKS_FINISHED, CHECKS_REQUESTED, CHECKS_STARTED, FOLLOW_UP_LOG, FOLLOW_UP_RECEIPT, followUpChecksOf, waitingRequestsOfAnyKind,
  type BatchFacts, type CheckRunDeps, type FollowUpCheck,
} from "./result-follow-ups.js";

/** Queue a finished build's commit for a batch check, bound to the exact approved command. Once per commit. */
export function queueBatchCheck(store: Store, input: { runId: number; taskId: string; repo: string; head: string; base: string | null; command: VerifyCommand }, now: Date): number {
  return store.transact(() => {
    const [where, params] = repoClause(input.repo);
    const existing = store.handle.prepare(`SELECT id FROM action_ledger WHERE ${where} AND run_id = ? AND action = ? AND detail LIKE ? ORDER BY id LIMIT 1`)
      .get(...params, input.runId, CHECKS_REQUESTED, `${input.head} · batch · %`);
    if (existing !== undefined) return Number(existing["id"]);
    const id = store.recordAction({ at: now.toISOString(), actor: "system", repo: input.repo, taskId: input.taskId, runId: input.runId, action: CHECKS_REQUESTED, outcome: "full",
      source: "work", detail: `${input.head} · batch · ${input.command.digest} · ${input.base !== null && /^[a-f0-9]{40}$/.test(input.base) ? input.base : ""}` });
    store.bumpWake();
    return id;
  });
}

type Member = { request: number; runId: number; task: string; head: string; base: string | null; at: string };
type Outcome = { ran: true; exitCode: number } | { ran: false; failure: string };
type Attempt = { members: string[]; tested: string | null; outcome: "passed" | "failed" | "conflict" | "not-run" };

/** The batch pass: settle what can't be checked, then check every cohort that is ready. Returns how many results it settled. */
export async function runBatchChecks(store: Store, root: string, deps: CheckRunDeps & { shouldStop?: () => boolean } = {}): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const waiting = waitingRequestsOfAnyKind(store, now()).filter(one => one.why === "batch");
  const cohorts = new Map<string, Member[]>();
  let settled = 0;
  for (const one of waiting) {
    const run = store.getRun(one.runId);
    const ref = run === null ? null : store.refById(run.taskRef);
    if (run === null || ref === null || ref.repo === null) continue;
    // Not finished yet: the build is still sealing its result.
    if (run.finishedAt === null) continue;
    const finish = (detail: string) => { claim(store, one, ref.repo!, ref.externalId, 0, now()) && finishOne(store, one, ref.repo!, ref.externalId, "not-run", detail, now()); settled++; };
    if (run.role !== "builder" || run.outcome !== "built" || run.headRevision !== one.head) { finish("The result stopped or changed before its batch check."); continue; }
    const live = store.liveVerifyCommand(ref.repo);
    if (live === null || live.digest !== one.digest) { finish("The approved check changed while it waited. Run checks to check it now."); continue; }
    const key = `${ref.repo}\u0000${one.digest}`;
    cohorts.set(key, [...(cohorts.get(key) ?? []), { request: one.request, runId: one.runId, task: ref.externalId, head: one.head, base: one.base ?? null, at: one.at }]);
  }
  for (const [key, members] of cohorts) {
    if (deps.shouldStop?.() === true) break;
    const repo = key.split("\u0000")[0]!;
    const policy = projectBatchChecks(store, repo);
    const oldest = Math.min(...members.map(one => Date.parse(one.at)));
    // A cohort closes when a second result joins it, or when its oldest has waited the window.
    // Turned off while waiting: no point waiting any longer.
    if (members.length < 2 && policy.on && now().getTime() - oldest < policy.windowMs) continue;
    if (policy.on) settled += await checkCohort(store, root, repo, members, deps);
    else for (const one of members) settled += await checkCohort(store, root, repo, [one], deps);
  }
  return settled;
}

function claim(store: Store, one: Pick<FollowUpCheck, "request" | "runId">, repo: string, task: string, limitMs: number, at: Date): boolean {
  return store.transact(() => {
    if (store.handle.prepare("SELECT 1 FROM action_ledger WHERE run_id = ? AND action = ? AND outcome = ?").get(one.runId, CHECKS_STARTED, String(one.request)) !== undefined) return false;
    store.recordAction({ at: at.toISOString(), actor: "system", repo, taskId: task, runId: one.runId, action: CHECKS_STARTED, outcome: String(one.request), source: "work", detail: `limit ${limitMs} · batch` });
    return true;
  });
}

function finishOne(store: Store, one: Pick<FollowUpCheck, "request" | "runId">, repo: string, task: string, status: "passed" | "failed" | "not-run", detail: string, at: Date): true {
  store.recordAction({ at: at.toISOString(), actor: "system", repo, taskId: task, runId: one.runId, action: CHECKS_FINISHED, outcome: `${one.request}:${status}`, source: "work", detail });
  store.bumpWake();
  return true;
}

/** Check one cohort. Every member is claimed first; every claimed member ends with a sealed receipt. */
async function checkCohort(store: Store, root: string, repo: string, cohort: Member[], deps: CheckRunDeps & { shouldStop?: () => boolean }): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const runner = deps.runner ?? execRun;
  const git = deps.git ?? execRun;
  const command = store.liveVerifyCommand(repo);
  if (command === null) return 0;
  const setup = store.liveWorktreeSetup(repo);
  // The longest a full split could take: every subset checked once, with its setup.
  const limit = (command.timeoutMs + (setup?.timeoutMs ?? 0) + 240_000) * Math.max(1, 2 * cohort.length - 1);
  const members = cohort.filter(one => claim(store, one, repo, one.task, limit, now())).sort((a, b) => a.request - b.request);
  if (members.length === 0) return 0;
  // The project base: the oldest member's recorded base, else its own parent.
  const base = members[0]!.base;
  const logs = new Map<number, string[]>(members.map(one => [one.request, []]));
  const attempts = new Map<number, Attempt[]>(members.map(one => [one.request, []]));
  const bound = (text: string) => { const hits = scanForSecrets(text); return boundStreamHeadTail(hits.length > 0 ? redactSecretLines(text, hits) : text, 12 * 1024); };
  const section = (label: string, shown: string, result: ExecResult) =>
    `=== ${label} ===\n$ ${shown}\n(exit ${result.code}${result.notFound ? ", could not start" : ""}${result.timedOut ? ", timed out" : ""})\n\n--- stdout ---\n${bound(result.stdout)}\n\n--- stderr ---\n${bound(result.stderr)}`;
  const note = (set: Member[], text: string) => { for (const one of set) logs.get(one.request)!.push(text); };
  const attempt = (set: Member[], tested: string | null, outcome: Attempt["outcome"]) => { for (const one of set) attempts.get(one.request)!.push({ members: set.map(m => m.task), tested, outcome }); };

  /** One approved check of `set` in a temporary detached checkout: the merge of every member onto the base,
   * or a single member's own commit. Never a real ref: the checkout is detached and always removed. */
  const checkOnce = async (set: Member[]): Promise<{ conflict: true } | { conflict: false; tested: string | null; outcome: Outcome; setupFailed: boolean }> => {
    const folder = mkdtempSync(join(deps.scratch ?? tmpdir(), "toolroll-batch-"));
    const checkout = join(folder, "checkout");
    const label = set.length === 1 ? `${set[0]!.task} on its own` : `Batch of ${set.length}: ${set.map(one => one.task).join(", ")}`;
    try {
      const start = set.length === 1 ? set[0]!.head : base ?? `${set[0]!.head}^`;
      const added = await git("git", ["-C", repo, "worktree", "add", "--detach", checkout, start], { timeoutMs: 120_000 });
      if (added.code !== 0) {
        note(set, section(`${label} · checkout`, `git worktree add --detach <temporary folder> ${start}`, added));
        return { conflict: false, tested: null, outcome: { ran: false, failure: "The commit couldn't be checked out. It may have been removed from this computer." }, setupFailed: false };
      }
      if (set.length > 1) {
        for (const one of set) {
          // A local merge commit in the detached checkout only: no hooks, no signing, no branch.
          const merged = await git("git", ["-C", checkout, "-c", "user.name=Toolroll batch check", "-c", "user.email=batch-check@toolroll.invalid", "-c", "commit.gpgsign=false",
            "-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "--no-edit", "--no-verify", "-m", `Batch check: ${one.task}`, one.head], { timeoutMs: 120_000 });
          if (merged.code !== 0) {
            note(set, section(`${label} · merge ${one.task}`, `git merge --no-ff ${one.head}`, merged));
            await git("git", ["-C", checkout, "merge", "--abort"], { timeoutMs: 60_000 }).catch(() => null);
            return { conflict: true };
          }
        }
      }
      const head = await git("git", ["-C", checkout, "rev-parse", "HEAD"], { timeoutMs: 60_000 });
      const tested = head.code === 0 && /^[a-f0-9]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
      if (tested === null) return { conflict: false, tested: null, outcome: { ran: false, failure: "The batch commit couldn't be read." }, setupFailed: false };
      if (deps.shouldStop?.() === true) return { conflict: false, tested, outcome: { ran: false, failure: "Stopped before the check started." }, setupFailed: false };
      // The approvals are re-read before every spawn: a revoked or changed command never runs.
      const liveSetup = store.liveWorktreeSetup(repo);
      if ((liveSetup?.digest ?? null) !== (setup?.digest ?? null)) return { conflict: false, tested, outcome: { ran: false, failure: "The project's approved setup changed before the check started." }, setupFailed: false };
      if (liveSetup !== null) {
        const shell = approvedCommandShell(liveSetup.command);
        const prepared = await runWithIsolatedDatabase(runner, shell.file, shell.args, { cwd: checkout, timeoutMs: liveSetup.timeoutMs, processGroup: true, envAllowlist: SETUP_ENV_ALLOWLIST, omitEnv: SETUP_ENV_DENYLIST });
        note(set, section(`${label} · approved project setup on ${tested.slice(0, 7)}`, liveSetup.command, prepared));
        if (prepared.code !== 0 || prepared.timedOut || prepared.notFound) return { conflict: false, tested, outcome: { ran: false, failure: "The project's setup failed, so the check didn't run." }, setupFailed: true };
      }
      const live = store.liveVerifyCommand(repo);
      if (live === null || live.digest !== command.digest) return { conflict: false, tested, outcome: { ran: false, failure: "The approved check changed before it started." }, setupFailed: false };
      const shell = approvedCommandShell(live.command);
      const ran = await runWithIsolatedDatabase(runner, shell.file, shell.args, { cwd: checkout, timeoutMs: live.timeoutMs, processGroup: true, envAllowlist: SETUP_ENV_ALLOWLIST, omitEnv: SETUP_ENV_DENYLIST });
      note(set, section(`${label} · full check on ${tested.slice(0, 7)}`, live.command, ran));
      return { conflict: false, tested, setupFailed: false,
        outcome: ran.timedOut ? { ran: false, failure: "The check ran out of time." } : ran.notFound ? { ran: false, failure: "The check couldn't start." } : { ran: true, exitCode: ran.code } };
    } finally {
      await git("git", ["-C", repo, "worktree", "remove", "--force", checkout], { timeoutMs: 120_000 }).catch(() => null);
      rmSync(folder, { recursive: true, force: true });
    }
  };

  const seal = (one: Member, mode: BatchFacts["mode"], together: Member[], tested: string | null, outcome: Outcome) => {
    const at = now();
    const text = logs.get(one.request)!.length === 0 ? "No command started." : logs.get(one.request)!.join("\n\n");
    const logId = storeEvidence(store, root, one.runId, "structured-output", `batch-check-${one.request}.log`, Buffer.from(text, "utf8"), FOLLOW_UP_LOG, at, { captureStatus: "ok" });
    const logArtifact = store.getArtifact(logId)!;
    const batch = { mode, tested: tested ?? one.head, base, members: together.map(m => ({ task: m.task, run: m.runId, head: m.head })), attempts: attempts.get(one.request)! };
    const receipt = JSON.stringify({ version: 1, request: one.request, run: one.runId, head: one.head, tested, level: "full",
      command: { repo: command.repo, command: command.command, digest: command.digest, approvedBy: command.approvedBy },
      result: outcome, batch, log: { artifactId: logArtifact.id, sha256: logArtifact.sha256, bytesStored: logArtifact.bytesStored, truncated: logArtifact.truncated } }, null, 1);
    storeEvidence(store, root, one.runId, "structured-output", `batch-check-${one.request}.json`, Buffer.from(receipt, "utf8"), FOLLOW_UP_RECEIPT, at, { captureStatus: "ok" });
    const peers = together.filter(m => m.request !== one.request).map(m => m.task);
    const how = mode === "together" ? `together with ${peers.join(", ")}` : mode === "split" ? "on its own after its batch failed" : mode === "conflict" ? "on its own: it conflicted with another result" : "on its own";
    if (outcome.ran) finishOne(store, one, repo, one.task, outcome.exitCode === 0 ? "passed" : "failed", `Full checks ${how} on ${(tested ?? one.head).slice(0, 7)} · exit ${outcome.exitCode}`.slice(0, 300), at);
    else finishOne(store, one, repo, one.task, "not-run", outcome.failure, at);
  };

  const checkSet = async (set: Member[], mode: Exclude<BatchFacts["mode"], "together">): Promise<void> => {
    if (set.length === 1) {
      const one = set[0]!;
      const result = await checkOnce(set);
      const tested = result.conflict ? null : result.tested;
      const outcome: Outcome = result.conflict ? { ran: false, failure: "The commit couldn't be checked out." } : result.outcome;
      attempt(set, tested, outcome.ran ? outcome.exitCode === 0 ? "passed" : "failed" : "not-run");
      seal(one, mode, set, outcome.ran ? tested : null, outcome);
      return;
    }
    const result = await checkOnce(set);
    if (result.conflict) {
      attempt(set, null, "conflict");
      for (const one of set) await checkSet([one], "conflict");
      return;
    }
    const { tested, outcome } = result;
    if (outcome.ran && outcome.exitCode === 0) {
      attempt(set, tested, "passed");
      for (const one of set) seal(one, "together", set, tested, outcome);
      return;
    }
    if ((outcome.ran && outcome.exitCode !== 0) || result.setupFailed) {
      // Something in this batch breaks the check: split it until the result that breaks it is found.
      attempt(set, tested, "failed");
      const half = Math.ceil(set.length / 2);
      await checkSet(set.slice(0, half), "split");
      await checkSet(set.slice(half), "split");
      return;
    }
    // It couldn't run at all (time, approvals, a stop): nothing is known about any member.
    attempt(set, tested, "not-run");
    for (const one of set) seal(one, mode, [one], null, outcome);
  };

  await checkSet(members, "alone").catch(error => {
    // An unexpected failure still ends every claimed member, visibly.
    for (const one of members) if (followUpChecksOf(store, one.runId, now()).find(f => f.request === one.request)?.state === "running") finishOne(store, one, repo, one.task, "not-run", `The batch check failed to run: ${String(error).slice(0, 200)}`, now());
  });
  return members.length;
}
