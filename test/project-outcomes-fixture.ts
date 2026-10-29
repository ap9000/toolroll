/** Synthetic stored history for Activity's contract and browser inspection. */
import type { Store } from '../src/store.js';
import { addApprover, propose, approve } from '../src/scope.js';
import { COMPLETION_ACTION, COMPLETION_BY_PERSON } from '../src/result-completion.js';

export function outcomeFixture(store: Store, repo: string, now: Date, by?: { name: string; token: string }) {
  const before = (hours: number) => new Date(now.getTime() - hours * 3600000);
  for (const phase of ['build', 'plan', 'review'] as const) store.setPhaseConfig('installation', phase, 'claude', 'sonnet', 'fixture', before(24));
  const added = addApprover(store, 'inspector', before(24), by);
  if (!added.ok) throw new Error(added.reason);
  function built(id: string, options: { repo?: string; role?: 'builder' | 'scout'; cost?: number | null; hours?: number; check?: 'passed' | 'failed'; title?: string } = {}) {
    const at = before(options.hours ?? 3);
    store.createTask({ id, title: options.title ?? id }, at);
    const ref = store.refFor('built-in', id).id;
    store.placeTask(ref, options.repo ?? repo, {}, at);
    const scope = propose(store, { taskId: id, goal: id, touches: ['src/'], acceptance: [{ id: 'c1', statement: 'Inspect the saved result', how: null, evidence: ['check'] }], now: at });
    const approved = approve(store, id, 'inspector', at, scope.digest, added.ok ? added.token : '');
    if (!approved.ok) throw new Error(approved.reason);
    const role = options.role ?? 'builder';
    const authority = store.routeAuthorityFor(ref, role);
    if (!authority?.ok) throw new Error('No route');
    const run = store.startRun({ taskRef: ref, leaseId: `fixture-${id}`, runner: 'fixture', branch: `toolroll/${id}`, worktree: `/tmp/activity/${id}`, role, route: authority.stamp, now: at });
    store.stampRun(run, { scopeDigest: store.getScope(id)!.digest });
    store.recordOutcomeFacts(run, { headRevision: 'b'.repeat(40), handoff: 'Synthetic saved result for Activity inspection.' });
    store.finishRun(run, { outcome: 'built', committed: true, now: at });
    store.setTaskState(id, 'done', at);
    store.recordRunCheck(run, { status: options.check ?? 'passed', exitCode: options.check === 'failed' ? 1 : 0, suites: [] }, at);
    store.handle.prepare('UPDATE run SET cost_usd=? WHERE id=?').run(options.cost === undefined ? 1 : options.cost, run);
    return { id, ref, run, at };
  }
  function complete(task: ReturnType<typeof built>, actor = 'operator:inspector', root = task.id, hours = 1, machine = false) {
    store.recordAction({ at: before(hours).toISOString(), actor, repo: store.lookupRef(task.id)!.repo, taskId: root, runId: task.run,
      action: COMPLETION_ACTION, outcome: 'd'.repeat(64), source: 'work', detail: machine ? 'proof machine' : actor.startsWith('operator:') ? COMPLETION_BY_PERSON : 'its work landed' });
  }
  return { built, complete, password: added.token };
}
