/** Everyday task verbs over the existing completion and revision boundaries. */
import { createHash } from 'node:crypto';
import { assignmentOf, checkAssignmentAsOperator } from './assignment.js';
import { assignmentForCoordinator, coordinatorToken } from './assignment-adapters.js';
import { authenticateCoordinator } from './coordinator.js';
import { reproveApprover, type VerifiedApprover } from './principal.js';
import { authenticateApprover } from './scope.js';
import { requestResultChanges } from './result-actions.js';
import { commentSourceKey, revisionSourceOf } from './result-review.js';
import { envelopeJson } from './envelope.js';
import { completeAndOpenPullRequest, mergeAsPerson, newestPullRequestOf, publishingOf, pullRequestViewOf, type PullRequestView } from './pull-request-flow.js';
import type { PublishExec } from './publish.js';
import type { Store } from './store.js';

export async function runTaskOutcomeCommand(action: 'complete' | 'revise', positional: readonly string[], flags: Map<string, string | true>, context: {
  store: Store; evidenceRoot: string; json: boolean; write: (line: string) => void; now: Date;
  operator: () => Promise<VerifiedApprover | null>;
}): Promise<number> {
  const command = `task ${action}`;
  const emit = (result: { ok: boolean; reason?: string; message?: string; result?: unknown; pullRequest?: unknown }, lines?: string[]) => {
    context.write(context.json ? envelopeJson({ ...result, command }) : result.ok ? (lines ?? []).join('\n') : result.message ?? 'The action was refused.');
    return result.ok ? 0 : result.reason === 'usage' ? 2 : 3;
  };
  const fail = (reason: string, message: string) => emit({ ok: false, reason, message });
  const allowed = new Set(['json', 'db', 'as', 'token', 'token-env', 'token-file', ...(action === 'complete' ? ['digest', 'pull-request'] : ['feedback', 'run', 'source', 'key'])]);
  for (const key of flags.keys()) if (!allowed.has(key)) return fail('usage', `--${key} is not a task ${action} option.`);
  const task = positional[0];
  if (positional.length !== 1 || !task || task.length > 64 || /[\x00-\x1f]/.test(task)) return fail('usage', `Use task ${action} <task>${action === 'complete' ? ' --digest <receipt> [--pull-request]' : ' --feedback "requested change"'}.`);
  const pullRequest = flags.has('pull-request');
  const credential = coordinatorToken(flags, process.env);
  if ('ok' in credential) return emit(credential);
  if (credential.token !== null && (flags.has('as') || flags.has('token'))) return fail('usage', 'Choose a scoped credential or your operator sign-in.');
  if (credential.token !== null && pullRequest) return fail('unauthenticated', 'Opening a pull request is an approver\'s act. Use your operator sign-in (--as and --token), not a scoped credential.');
  const operator = credential.token === null ? await context.operator() : null;
  if (credential.token === null && operator === null) return fail('unauthenticated', 'Sign in with up, or supply --as and --token. Agents can use --token-file or --token-env with a scoped credential.');
  const { store, now, evidenceRoot } = context;
  return store.transact(() => {
    const coordinator = credential.token === null ? null : authenticateCoordinator(store, credential.token);
    if (coordinator !== null && !coordinator.ok) return fail('unauthenticated', 'The scoped credential is invalid or revoked.');
    if (operator !== null && !reproveApprover(store, operator).ok) return fail('unauthenticated', 'Your sign-in is no longer valid.');
    const repos = coordinator?.ok ? coordinator.who.repos : operator!.repos;
    const current = assignmentOf(store, task, now, { principal: coordinator === null ? 'operator' : 'coordinator', repos }, evidenceRoot);
    if (current === null) return fail('not-found', 'That task is unavailable in your projects.');
    if (action === 'complete') {
      const supplied = flags.get('digest');
      if (supplied !== undefined && (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied))) return fail('usage', '--digest requires the exact receipt from assignment show.');
      if (supplied === undefined && (context.json || coordinator !== null)) return fail('usage', 'Read assignment show <task>, then pass its exact --digest to mark that result complete.');
      const digest = typeof supplied === 'string' ? supplied : current.receipt?.digest;
      if (!digest) return fail('not-ready', 'This task has no finished result to mark complete.');
      if (pullRequest) {
        // The console's "Complete and open a pull request": the same exact-receipt completion and owed PR, one transaction.
        const repo = store.lookupRef(current.activeTaskId)?.repo ?? null;
        const publishing = publishingOf(store, repo);
        if (!publishing.on) return fail('pull-requests-off', `Pull requests aren't set up for this project. Turn them on with: toolroll publish setup --repo ${repo ?? '<path>'} --yes`);
        if (publishing.legacy) return fail('pull-requests-off', 'This project opens a pull request for every build. Complete without --pull-request.');
        const runId = current.receipt?.runId;
        if (runId === undefined) return fail('not-ready', 'This task has no finished result to mark complete.');
        const opened = completeAndOpenPullRequest(store, { taskId: task, digest, runId, who: operator!, root: evidenceRoot }, now);
        if (!opened.ok) return emit(opened);
        const link = opened.publication.prUrl;
        return emit({ ok: true, result: assignmentOf(store, task, now, { principal: 'operator', repos }, evidenceRoot), pullRequest: pullRequestViewOf(store, runId) }, [
          `${current.rootId} · Complete`,
          `Result: ${current.activeTaskId} · run ${runId} · ${opened.publication.headSha}`,
          link === null ? `Pull request: opening from ${opened.publication.headSha.slice(0, 12)} into ${publishing.githubRepo} ${publishing.base}. toolroll task show ${current.rootId} prints its link.` : `Pull request: ${link}`,
          `Next: CI is watched on GitHub. Merge when green: toolroll task merge ${current.rootId}`,
        ]);
      }
      const changed = credential.token !== null
        ? assignmentForCoordinator(store, credential.token, 'check', { ref: task, digest }, now, evidenceRoot)
        : checkAssignmentAsOperator(store, task, digest, operator!, now, evidenceRoot);
      if (!changed.ok) return emit(changed);
      const assignment = 'body' in changed ? changed.body : changed.assignment;
      // Checks deliberately Off: nothing to say about them here.
      return emit({ ok: true, result: assignment }, [`${current.rootId} · Complete`, `Result: ${current.activeTaskId} · run ${current.receipt!.runId} · ${current.receipt!.head ?? 'no commit'}`,
        ...(current.readiness?.checksOff ? [] : [current.receipt!.checks.detail])]);
    }
    const feedback = flags.get('feedback'), runFlag = flags.get('run'), sourceFlag = flags.get('source'), keyFlag = flags.get('key');
    if (typeof feedback !== 'string' || !feedback.trim()) return fail('usage', 'Describe the requested change with --feedback.');
    if (runFlag !== undefined && (typeof runFlag !== 'string' || !/^[1-9]\d*$/.test(runFlag) || !Number.isSafeInteger(Number(runFlag)))) return fail('usage', '--run requires an exact run number.');
    if (sourceFlag !== undefined && (typeof sourceFlag !== 'string' || !/^(?:[a-f0-9]{32}|none)$/.test(sourceFlag))) return fail('usage', '--source requires the exact source scope digest.');
    if (keyFlag !== undefined && (typeof keyFlag !== 'string' || !/^[a-f0-9]{32}$/.test(keyFlag))) return fail('usage', '--key requires 32 lowercase hexadecimal characters.');
    const runId = runFlag === undefined ? current.receipt?.runId : Number(runFlag);
    const run = runId === undefined ? null : store.getRun(runId);
    const runTask = run === null ? null : store.externalIdFor(run.taskRef);
    const family = runTask === null ? null : store.taskFamilyOf(runTask, repos, false);
    if (run === null || runTask === null || family?.root.id !== current.rootId || run.outcome === null) return fail('not-found', 'That finished result is unavailable for this task.');
    const source = typeof sourceFlag === 'string' ? sourceFlag : revisionSourceOf(store.getScope(runTask)?.digest ?? null);
    const actor = coordinator?.ok ? `coordinator:${coordinator.who.cid}` : operator!.name;
    const key = typeof keyFlag === 'string' ? keyFlag : createHash('sha256').update(JSON.stringify([actor, run.id, source, feedback])).digest('hex').slice(0, 32);
    const previous = store.diffCommentBySourceKey(commentSourceKey(actor, key)!);
    if ((family.current.id !== runTask || (current.receipt !== null && current.receipt.runId !== run.id)) && previous?.consumedBy == null) return fail('stale-result', 'A newer version is current. Read its result before requesting another revision.');
    // The shared action returns exact replays before stale-family checks. An
    // older result cannot create another child once a newer revision is current.
    const revised = requestResultChanges(store, evidenceRoot, { run: run.id, source, actor, repos,
      batch: '', note: feedback, path: '', line: '', request: key, allowMode: operator !== null }, now);
    if (!revised.ok) return fail(revised.status === 400 ? 'usage' : 'stale-result', revised.message);
    const scope = store.getScope(revised.id);
    const approved = scope?.approvedDigest != null && scope.approvedDigest === scope.digest;
    const planning = store.lookupRef(revised.id)?.plan === 'requested';
    return emit({ ok: true, result: { id: revised.id, rootId: current.rootId, sourceRun: run.id, source, key, approved, planning } },
      [`${current.rootId} · Revision created`, `Execution: ${revised.id}`, approved ? 'Covered by your existing operating mode.' : planning ? 'Updating the plan with your notes; approve it when it is ready.' : 'The revision is waiting for approval.']);
  });
}

/** `task merge <task>`: the console's Merge — the newest pull request any version of the task opened through
 * Complete, merged behind the approver's password once a fresh read shows its checks passing. */
export async function runTaskMergeCommand(positional: readonly string[], flags: Map<string, string | true>, context: {
  store: Store; json: boolean; write: (line: string) => void; clock: () => Date; exec?: PublishExec; demo: boolean;
  credentials: () => Promise<{ name: string; token: string } | null>;
}): Promise<number> {
  const command = 'task merge';
  const emit = (result: { ok: boolean; reason?: string; message?: string; [key: string]: unknown }, lines?: string[]) => {
    context.write(context.json ? envelopeJson({ ...result, command }) : result.ok ? (lines ?? []).join('\n') : result.message ?? 'The merge was refused.');
    return result.ok ? 0 : result.reason === 'usage' ? 2 : 3;
  };
  const fail = (reason: string, message: string) => emit({ ok: false, reason, message });
  const allowed = new Set(['json', 'db', 'as', 'token', 'anyway']);
  for (const key of flags.keys()) if (!allowed.has(key)) return fail('usage', `--${key} is not a task merge option.`);
  const task = positional[0];
  if (positional.length !== 1 || !task || task.length > 64 || /[\x00-\x1f]/.test(task)) return fail('usage', 'Use task merge <task> --as <you> --token <password>.');
  if (context.demo) return fail('demo', 'The demo merges nothing.');
  const acting = await context.credentials();
  if (acting === null) return fail('unauthenticated', 'Merging takes your password: --as <you> --token <password>.');
  const { store } = context;
  if (!authenticateApprover(store, acting.name, acting.token).ok) return fail('not-an-approver', 'That password didn\'t work, or you can\'t merge.');
  const family = store.taskFamilyOf(task, store.knownRepos().filter(repo => store.accountCanAccess(acting.name, repo)), false);
  if (family === null) return fail('not-found', 'That task is unavailable in your projects.');
  const view = newestPullRequestOf(store, family.versions.map(one => one.id));
  if (view === null) return fail('no-pr', 'This task has no pull request. Open one with task complete --pull-request.');
  const merged = await mergeAsPerson(store, { runId: view.runId, name: acting.name, password: acting.token, ...(flags.get('anyway') === true ? { anyway: true } : {}), ...(context.exec === undefined ? {} : { exec: context.exec }), clock: context.clock });
  if (!merged.ok) return emit({ ...merged, reason: merged.reason === 'password' ? 'not-an-approver' : merged.reason, pullRequest: view });
  const after = newestPullRequestOf(store, family.versions.map(one => one.id));
  return emit({ ok: true, pullRequest: after }, [
    `${family.root.id} · Merged`,
    `Pull request: ${after?.prUrl ?? view.prUrl ?? `#${view.prNumber}`}`,
    `Merge commit: ${merged.commit ?? 'recorded by GitHub'} (${after?.mergeMethod ?? view.mergeMethod}, branch deleted)`,
  ]);
}

/** The lines `task show` prints for a task's pull request. */
export function pullRequestLines(view: PullRequestView | null): string[] {
  if (view === null) return [];
  return [`  pull request: ${view.prUrl ?? 'opening'} · ${view.label}`, `    ${view.detail}`, ...(view.mergeCommit === null ? [] : [`    merge commit: ${view.mergeCommit}`])];
}
