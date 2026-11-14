/** Everyday task verbs over the existing completion and revision boundaries. */
import { createHash } from 'node:crypto';
import { assignmentOf, checkAssignmentAsOperator, completeAsLocalOwner } from './assignment.js';
import { currentLocalOwner, localActNow, localModeOn, LOCAL_OWNER_LAPSED } from './local-owner.js';
import { validateNote } from './decision.js';
import { assignmentForCoordinator, coordinatorToken } from './assignment-adapters.js';
import { authenticateCoordinator } from './coordinator.js';
import { reproveApprover, verifyApproverStanding, type VerifiedApprover } from './principal.js';
import { authenticateApprover, localWorkEligible, machineActing, personProof } from './scope.js';
import { currentActor } from './actor.js';
import { requestResultChanges } from './result-actions.js';
import { commentSourceKey, revisionSourceOf } from './result-review.js';
import { envelopeJson } from './envelope.js';
import { completeAndOpenPullRequest, mergeAsPerson, MERGE_NEEDS_PERSON, newestPullRequestOf, publishingOf, pullRequestViewOf, type PullRequestView } from './pull-request-flow.js';
import type { PublishExec } from './publish.js';
import type { Store } from './store.js';
import { proveRunStopped } from './stop-proof.js';
import { familyChangedFiles } from './result-completion.js';
import { activeRemote } from './remote-run.js';
import { underAgent } from './prompt.js';

export async function runTaskOutcomeCommand(action: 'complete' | 'revise', positional: readonly string[], flags: Map<string, string | true>, context: {
  store: Store; evidenceRoot: string; json: boolean; write: (line: string) => void; now: Date;
  operator: () => Promise<VerifiedApprover | null>;
  /** The command it answers as: `task accept --finish` is this same completion under its own name. */
  command?: string;
  /** Who is running this shell command (a coding agent, a terminal), read only to word a password-free owner's refusal. */
  caller?: () => ShellCaller;
}): Promise<number> {
  const command = context.command ?? `task ${action}`;
  const emit = (result: { ok: boolean; reason?: string; message?: string; result?: unknown; pullRequest?: unknown }, lines?: string[]) => {
    context.write(context.json ? envelopeJson({ ...result, command }) : result.ok ? (lines ?? []).join('\n') : result.message ?? 'The action was refused.');
    return result.ok ? 0 : result.reason === 'usage' ? 2 : 3;
  };
  const fail = (reason: string, message: string) => emit({ ok: false, reason, message });
  const allowed = new Set(['json', 'db', 'as', 'token', 'token-env', 'token-file', ...(action === 'complete' ? ['digest', 'pull-request'] : ['feedback', 'run', 'source', 'key'])]);
  for (const key of flags.keys()) if (!allowed.has(key)) return fail('usage', `--${key} is not a ${command} option.`);
  const task = positional[0];
  if (positional.length !== 1 || !task || task.length > 64 || /[\x00-\x1f]/.test(task)) return fail('usage', `Use ${command} <task>${action === 'complete' ? `${command === 'task accept' ? ' --finish' : ''} --digest <receipt> [--pull-request]` : ' --feedback "requested change"'}.`);
  const pullRequest = flags.has('pull-request');
  const credential = coordinatorToken(flags, process.env);
  if ('ok' in credential) return emit(credential);
  if (credential.token !== null && (flags.has('as') || flags.has('token'))) return fail('usage', 'Choose your lead\'s credential or your own sign-in, not both.');
  if (credential.token !== null && pullRequest) return fail('unauthenticated', 'Opening a pull request is an approver\'s act. Use your own sign-in (--as and --token), not your lead\'s credential.');
  const key = action === 'complete' ? 'c' : 'b';
  // A password-free owner has nothing to sign in with here: refused before anything asks for a username or password
  // (which could never work, and would count a failed password), saying why and that the terminal UI is where they act.
  if (credential.token === null && passwordFreeShell(context.store)) return fail('local-owner', passwordFreeShellWords(key, shellCallerOf(context.json, context.caller)));
  const operator = credential.token === null ? await context.operator() : null;
  if (credential.token === null && operator === null) {
    return fail('unauthenticated', passwordFreeOwner(context.store)
      ? passwordFreeShellWords(key, shellCallerOf(context.json, context.caller))
      : 'Run this at a terminal to sign in when asked, or open `toolroll`. Your lead can use --token-file or --token-env with its own credential.');
  }
  const { store, now, evidenceRoot } = context;
  // A result whose build Toolroll hasn't yet proven stopped: it looks now (stop-proof.ts), so completing never waits
  // on a person to confirm it, only on Toolroll's own check (a refusal says "stopping" until it lands).
  if (action === 'complete') await proveTaskBuildsStopped(store, task, () => now);
  return store.transact(() => {
    const coordinator = credential.token === null ? null : authenticateCoordinator(store, credential.token);
    if (coordinator !== null && !coordinator.ok) return fail('unauthenticated', 'That credential is invalid or revoked.');
    if (operator !== null && !reproveApprover(store, operator).ok) return fail('unauthenticated', 'Your sign-in is no longer valid.');
    const repos = coordinator?.ok ? coordinator.who.repos : operator!.repos;
    const current = assignmentOf(store, task, now, { principal: coordinator === null ? 'operator' : 'coordinator', repos }, evidenceRoot);
    if (current === null) return fail('not-found', 'That task is unavailable in your projects.');
    if (action === 'complete') {
      const supplied = flags.get('digest');
      if (supplied !== undefined && (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied))) return fail('usage', '--digest needs the exact result version from assignment show.');
      if (supplied === undefined && (context.json || coordinator !== null)) return fail('usage', 'Read assignment show <task>, then pass its exact --digest to accept that result.');
      const digest = typeof supplied === 'string' ? supplied : current.receipt?.digest;
      if (!digest) return fail('not-ready', 'This task has no finished result to accept.');
      if (pullRequest) {
        // The console's "Complete and open a pull request": the same exact-receipt completion and owed PR, one transaction.
        const repo = store.lookupRef(current.activeTaskId)?.repo ?? null;
        const publishing = publishingOf(store, repo);
        if (!publishing.on) return fail('pull-requests-off', `Pull requests aren't set up for this project. Turn them on with: toolroll publish setup --repo ${repo ?? '<path>'} --yes`);
        if (publishing.legacy) return fail('pull-requests-off', 'This project opens a pull request for every build. Accept without --pull-request.');
        const runId = current.receipt?.runId;
        if (runId === undefined) return fail('not-ready', 'This task has no finished result to accept.');
        const opened = completeAndOpenPullRequest(store, { taskId: task, digest, runId, who: operator!, root: evidenceRoot }, now);
        if (!opened.ok) return emit(opened);
        const link = opened.publication.prUrl;
        return emit({ ok: true, result: assignmentOf(store, task, now, { principal: 'operator', repos }, evidenceRoot), pullRequest: pullRequestViewOf(store, runId) }, [
          `${current.rootId} · Accepted`,
          `Result: ${current.activeTaskId} · build #${runId} · ${opened.publication.headSha.slice(0, 7)}`,
          link === null ? `Pull request: opening from ${opened.publication.headSha.slice(0, 7)} into ${publishing.githubRepo} ${publishing.base}. toolroll task show ${current.rootId} prints its link.` : `Pull request: ${link}`,
          `Next: Toolroll follows its CI on GitHub. Merge when green: toolroll task merge ${current.rootId}`,
        ]);
      }
      const changed = credential.token !== null
        ? assignmentForCoordinator(store, credential.token, 'check', { ref: task, digest }, now, evidenceRoot)
        : checkAssignmentAsOperator(store, task, digest, operator!, now, evidenceRoot);
      if (!changed.ok) return emit(changed);
      const assignment = 'body' in changed ? changed.body : changed.assignment;
      // Checks deliberately Off: nothing to say about them here.
      return emit({ ok: true, result: assignment }, [`${current.rootId} · Accepted`, `Result: ${current.activeTaskId} · build #${current.receipt!.runId} · ${current.receipt!.head?.slice(0, 7) ?? 'no commit'}`,
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
      batch: '', note: feedback, path: '', line: '', request: key, allowMode: operator !== null,
      // A verified approver's own words; a scoped credential or the lead's token is the lead; a remote API run a machine.
      origin: coordinator !== null || currentActor()?.lead === true ? 'lead' : machineActing() ? 'machine' : 'person' }, now);
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
  const proved = authenticateApprover(store, acting.name, acting.token);
  if (!proved.ok) return fail('not-an-approver', 'That password didn\'t work, or you can\'t merge.');
  // A merge by hand is a person's (approval policy §1.7): refused before anything is read, --anyway included.
  if (!personProof(proved.method)) return fail('person-required', MERGE_NEEDS_PERSON);
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

/** Toolroll's own stop proof for every finished build of a task's family whose stop it can prove here. Best effort: a
 * failure leaves the completion's own refusal to say what is still unproven. */
export async function proveTaskBuildsStopped(store: Store, task: string, clock: () => Date): Promise<void> {
  try {
    const family = store.taskFamilyOf(task, null, true);
    const refs = family === null ? [store.lookupRef(task)?.id].filter((one): one is number => one !== undefined) : family.versions.map(version => version.refId);
    for (const ref of refs) for (const run of store.runsFor(ref)) {
      if (run.outcome !== null && store.stopQuiescenceFact(run.id)?.cause !== undefined) await proveRunStopped(store, run.id, clock);
    }
  } catch { /* the completion below refuses with what is still unproven */ }
}

/**
 * `task complete` for the laptop's local owner (local-owner slice 1; the terminal UI's Accept): the exact result the
 * screen read, accepted and completed with no password. Its own road: it never reaches a password check (so it never
 * moves the sign-in guard), and is chosen only inside the local owner's chain; there, an owner who no longer stands is
 * refused, never handed to another road. Everything is pinned: `--run` and `--digest` are required (never defaulted
 * to the current result), `--checked` is the person's explicit yes to a check they made, and `--reason` (trimmed, not
 * empty) is an exception's why. No pull request: that needs a password.
 */
export async function runLocalCompletion(positional: readonly string[], flags: Map<string, string | true>, context: {
  store: Store; evidenceRoot: string; json: boolean; write: (line: string) => void; now: Date;
}): Promise<number> {
  const command = 'task complete';
  const emit = (result: { ok: boolean; reason?: string; message?: string; [key: string]: unknown }, lines?: string[]) => {
    context.write(context.json ? envelopeJson({ ...result, command }) : result.ok ? (lines ?? []).join('\n') : result.message ?? 'The action was refused.');
    return result.ok ? 0 : result.reason === 'usage' ? 2 : 3;
  };
  const fail = (reason: string, message: string) => emit({ ok: false, reason, message });
  const usage = 'Use task complete <task> --run <build> --digest <result> [--checked] [--reason "why"].';
  const allowed = new Set(['json', 'db', 'run', 'digest', 'checked', 'reason', 'pull-request']);
  for (const key of flags.keys()) if (!allowed.has(key)) return fail('usage', `--${key} is not a ${command} option.`);
  if (flags.has('pull-request')) return fail('local-owner', `Opening a pull request needs your password. ${context.store.accountOf(currentLocalOwner()?.account ?? '')?.passwordSet === true ? 'Sign in with your password to do this.' : 'Set a password first: run `toolroll password set`.'}`);
  const task = positional[0];
  if (positional.length !== 1 || !task || task.length > 64 || /[\x00-\x1f]/.test(task)) return fail('usage', usage);
  const run = flags.get('run'), digest = flags.get('digest'), checked = flags.get('checked'), reason = flags.get('reason');
  if (typeof run !== 'string' || !/^[1-9]\d{0,14}$/.test(run)) return fail('usage', `--run needs the exact build number of the result you read. ${usage}`);
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return fail('usage', `--digest needs the exact result you read. ${usage}`);
  if (checked !== undefined && checked !== true) return fail('usage', '--checked takes no value.');
  let why: string | null = null;
  if (reason !== undefined) {
    // An exception's reason says something: trimmed here, at the command's edge, and never empty or only spaces.
    if (typeof reason !== 'string' || reason.trim() === '') return fail('usage', 'Say why you accept it anyway: --reason "<why>".');
    const validated = validateNote(reason);
    if (!validated.ok) return fail('usage', `--reason: ${validated.problem}.`);
    why = validated.note;
  }
  const { store, now, evidenceRoot } = context;
  // Toolroll's own stop proof first, as every completion (a build it hasn't proven stopped is refused below).
  await proveTaskBuildsStopped(store, task, () => now);
  const done = completeAsLocalOwner(store, task, { runId: Number(run), receiptDigest: digest, checked: checked === true, reason: why }, now, evidenceRoot);
  if (!done.ok) return emit(done);
  const { assignment } = done;
  const receipt = assignment.receipt!;
  return emit({ ok: true, replayed: done.replayed, accepted: done.accepted, result: assignment }, [
    `${assignment.rootId} · ${done.replayed ? 'Already accepted' : 'Accepted'}`,
    `Result: ${receipt.taskId} · build #${receipt.runId} · ${receipt.head?.slice(0, 7) ?? 'no commit'}`,
    ...(assignment.readiness?.checksOff ? [] : [receipt.checks.detail]),
  ]);
}

/** A send back by the local owner, as its writer answers: the revision made (or the one this same note already made), or
 * why not. */
export type LocalRevision =
  | { ok: true; id: string; rootId: string; sourceRun: number; source: string; key: string; approved: boolean; planning: boolean }
  | { ok: false; reason: string; message: string };

/**
 * The terminal's Send back (the eight plan, F-lite): the laptop's local owner, with no password, sends back the exact
 * build its screen read (`runId`, pinned when it pressed b) with its note, in one transaction. Accept's road
 * (completeAsLocalOwner) for a revision: never a password check, so the sign-in guard never moves; the owner is the one in
 * flight now, acting as exactly `request-revision`, still standing, and its approver standing re-proved from that; the
 * build must be this task's and still current (a newer version refuses, as the password road refuses it); completion's
 * work rule refuses release, protected (declared or changed) and coordinator work; and the revision is the person's
 * (`origin: "person"`, the browser's local-owner parity). The same note again returns the revision it made.
 */
export function reviseAsLocalOwner(store: Store, taskId: string, input: { runId: number; feedback: string }, now: Date, evidenceRoot: string): LocalRevision {
  const fail = (reason: string, message: string): LocalRevision => ({ ok: false, reason, message });
  try {
    return store.transact((): LocalRevision => {
      const local = localActNow(store, 'request-revision');
      if (local === null) return fail('local-owner', LOCAL_OWNER_LAPSED);
      const standing = verifyApproverStanding(store, local.account, local.accountGeneration, store.knownRepos().filter(repo => store.accountCanAccess(local.account, repo)));
      if (!standing.ok) return fail('local-owner', LOCAL_OWNER_LAPSED);
      const who = standing.who, repos = who.repos;
      const current = assignmentOf(store, taskId, now, { principal: 'operator', repos }, evidenceRoot);
      if (current === null || !store.accountCanAccess(who.name, current.repo)) return fail('not-found', 'That task is unavailable in your projects.');
      const run = store.getRun(input.runId);
      const runTask = run === null ? null : store.externalIdFor(run.taskRef);
      const family = runTask === null ? null : store.taskFamilyOf(runTask, repos, false);
      if (run === null || runTask === null || family?.root.id !== current.rootId || run.outcome === null) return fail('not-found', 'That finished result is unavailable for this task.');
      // Completion's work rule, read for every task named (the one asked, the build's own, the family's root), with
      // what the build actually changed (an unreadable inventory counts as protected).
      const changed = familyChangedFiles(store, runTask, run.id, evidenceRoot, { missing: 'unknown' });
      for (const one of new Set([taskId, runTask, current.rootId])) {
        const eligible = localWorkEligible(store, who.name, one, { act: 'revise', changed });
        if (!eligible.ok) return fail('local-owner', `${eligible.message} ${store.accountOf(who.name)?.passwordSet === true ? 'Sign in with your password to do this.' : 'Set a password first: run `toolroll password set`.'}`);
      }
      const source = revisionSourceOf(store.getScope(runTask)?.digest ?? null);
      const key = createHash('sha256').update(JSON.stringify([who.name, run.id, source, input.feedback])).digest('hex').slice(0, 32);
      const previous = store.diffCommentBySourceKey(commentSourceKey(who.name, key)!);
      if ((family.current.id !== runTask || (current.receipt !== null && current.receipt.runId !== run.id)) && previous?.consumedBy == null) return fail('stale-result', 'A newer version is current. Read its result before sending it back.');
      const revised = requestResultChanges(store, evidenceRoot, { run: run.id, source, actor: who.name, repos,
        batch: '', note: input.feedback, path: '', line: '', request: key, allowMode: true,
        // The person at this computer's own terminal, in their own words: the browser's local owner is the same.
        origin: 'person' }, now);
      if (!revised.ok) return fail(revised.status === 400 ? 'usage' : 'stale-result', revised.message);
      const scope = store.getScope(revised.id);
      return { ok: true, id: revised.id, rootId: current.rootId, sourceRun: run.id, source, key,
        approved: scope?.approvedDigest != null && scope.approvedDigest === scope.digest, planning: store.lookupRef(revised.id)?.plan === 'requested' };
    });
  } catch (error) {
    // Store.transact's own re-check found the bound owner no longer standing: the same refusal, said, never a crash.
    if (error instanceof Error && error.message === LOCAL_OWNER_LAPSED) return fail('local-owner', LOCAL_OWNER_LAPSED);
    throw error;
  }
}

/**
 * `task revise` for the laptop's local owner (the terminal UI's Send back): its own road, chosen only inside the local
 * owner's chain, as runLocalCompletion is for Accept. It never reaches a password check. Pinned: `--run` is required
 * (the build the screen read, never defaulted to the current one) and `--feedback` says something. No `--source` or
 * `--key` (Toolroll reads them itself), and no credential flags (runOperate refuses those for the local owner first).
 */
export async function runLocalRevision(positional: readonly string[], flags: Map<string, string | true>, context: {
  store: Store; evidenceRoot: string; json: boolean; write: (line: string) => void; now: Date;
}): Promise<number> {
  const command = 'task revise';
  const emit = (result: { ok: boolean; reason?: string; message?: string; [key: string]: unknown }, lines?: string[]) => {
    context.write(context.json ? envelopeJson({ ...result, command }) : result.ok ? (lines ?? []).join('\n') : result.message ?? 'The action was refused.');
    return result.ok ? 0 : result.reason === 'usage' ? 2 : 3;
  };
  const fail = (reason: string, message: string) => emit({ ok: false, reason, message });
  const usage = 'Use task revise <task> --run <build> --feedback "requested change".';
  const allowed = new Set(['json', 'db', 'run', 'feedback']);
  for (const key of flags.keys()) if (!allowed.has(key)) return fail('usage', `--${key} is not a ${command} option here.`);
  const task = positional[0];
  if (positional.length !== 1 || !task || task.length > 64 || /[\x00-\x1f]/.test(task)) return fail('usage', usage);
  const run = flags.get('run'), feedback = flags.get('feedback');
  if (typeof run !== 'string' || !/^[1-9]\d{0,14}$/.test(run)) return fail('usage', `--run needs the exact build number of the result you read. ${usage}`);
  if (typeof feedback !== 'string' || !feedback.trim()) return fail('usage', 'Describe the requested change with --feedback.');
  const done = reviseAsLocalOwner(context.store, task, { runId: Number(run), feedback }, context.now, context.evidenceRoot);
  if (!done.ok) return emit(done);
  const { ok: _ok, ...result } = done;
  return emit({ ok: true, result }, [`${done.rootId} · Revision created`, `Execution: ${done.id}`,
    done.approved ? 'Covered by your existing operating mode.' : done.planning ? 'Updating the plan with your notes; approve it when it is ready.' : 'The revision is waiting for approval.']);
}

/** Who runs a shell command, as a password-free owner's refusal words it: under --json, under a coding agent, at a terminal. */
export type ShellCaller = { json: boolean; agent: boolean; terminal: boolean };

/** This process's own caller facts (or a test's), read only when a refusal is worded: the agent check walks the
 * process's ancestors. */
export function shellCallerOf(json: boolean, seam?: () => ShellCaller): ShellCaller {
  return seam?.() ?? { json, agent: underAgent(process.env), terminal: process.stdin.isTTY === true && process.stdout.isTTY === true };
}

/**
 * Whether a shell command from this person can't sign in at all, so it is refused before it asks for a username or a
 * password (the eight plan, F-lite): a password-free install (passwordFreeOwner), and none of the roads that carry their
 * own authority — the terminal UI's local owner, a remote API run, the lead. It only ever refuses earlier a command that
 * would be refused anyway (no account has a password to check), and never grants anything.
 */
export function passwordFreeShell(store: Store): boolean {
  return currentLocalOwner() === null && activeRemote() === null && currentActor()?.lead !== true && passwordFreeOwner(store);
}

/** One line for a password-free owner's refused shell command: why it can't work from here (a coding agent ran it, it
 * runs under --json, or piped with no one to ask), and the fix, the terminal UI's key for the act. */
export function passwordFreeShellWords(key: 'a' | 'c' | 'b', caller: ShellCaller): string {
  const fix = `Open \`toolroll\` in your own terminal and press ${key} on the task.`;
  if (caller.agent) return `Your coding agent can't do this for you. ${fix}`;
  if (caller.json) return `With --json nothing can ask you, and you haven't set a password. ${fix}`;
  if (!caller.terminal) return `This can't ask you when it runs piped or in the background, and you haven't set a password. ${fix}`;
  return `You haven't set a password, so there's nothing to sign in with here. Open \`toolroll\` and press ${key} on the task.`;
}

/** Words only: local mode is on and no account has a password yet, so no sign-in from a shell can succeed (the terminal
 * UI's owner acts there). It decides what a refusal says, never what is allowed. A read that fails says no. */
export function passwordFreeOwner(store: Store): boolean {
  try {
    if (!localModeOn(store)) return false;
    return store.handle.prepare("SELECT 1 FROM approver WHERE password_set = 1 AND revoked_at IS NULL LIMIT 1").get() === undefined;
  } catch { return false; }
}
