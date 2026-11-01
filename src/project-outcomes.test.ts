import { afterEach, expect, test } from 'vitest';
import { openStore, type Store } from './store.js';
import { projectOutcomes } from './project-outcomes.js';
import { outcomeFixture } from '../test/project-outcomes-fixture.js';
import { COMPLETION_ACTION } from './result-completion.js';
import { LEAD_TOOLS, toolResultBytes } from './lead-tools.js';
import { LEAD_TOOL_RESULT_CAP_BYTES } from './converse.js';
import { projectOutcomesPage } from './project-outcomes.js';
import { verifyApproverByPassword } from './principal.js';
import { workIndexPage } from './work-index.js';

const now = new Date('2026-10-28T12:00:00.000Z'), repo = '/projects/activity';
const access = { principal: 'operator' as const, repos: [repo] };
let store: Store;
afterEach(() => store?.close());

test('one family once: retries, explicit revisions, failed checks, scouts, actors, unknown costs and project isolation', () => {
  store = openStore(':memory:');
  const f = outcomeFixture(store, repo, now);
  const original = f.built('rounding', { cost: 2 });
  // Retry is a second attempt on the same task, not a revision.
  const authority = store.routeAuthorityFor(original.ref, 'builder');
  if (!authority?.ok) throw new Error('No retry route');
  const retry = store.startRun({ taskRef: original.ref, leaseId: 'retry', runner: 'fixture', branch: 'toolroll/retry', worktree: '/tmp/activity/retry', route: authority.stamp, now: original.at });
  store.finishRun(retry, { outcome: 'failed', committed: false, now: original.at });
  f.bill(retry, 3);
  const child = f.built('rounding-revision', { cost: 5, hours: 2, check: 'failed' });
  // A stored revision brief must belong to the parent's run for admission.
  store.handle.prepare("INSERT INTO artifact(run,kind,key,bytes_original,bytes_stored,sha256,capture,created_at) VALUES (?,'revision-brief','brief.json',2,2,?,'synthetic fixture',?)").run(original.run, 'c'.repeat(64), original.at.toISOString());
  const artifact = Number(store.handle.prepare('SELECT MAX(id) id FROM artifact').get()!['id']);
  store.markRevision(child.ref, original.id, artifact);
  f.complete(child, 'operator:inspector', original.id);
  f.complete(child, 'operator:inspector', original.id); // duplicate ledger event
  const scout = f.built('research', { role: 'scout', cost: null }); f.complete(scout, 'operator:inspector', scout.id, 1, true);
  store.noteTaskAct(scout.ref, 'completed', new Date(now.getTime() - 3600000), undefined, { account: 'inspector', lead: true });
  const landed = f.built('landed', { cost: 4 }); f.complete(landed, 'system:landed');
  const ready = f.built('ready', { hours: 4 });
  const other = f.built('secret', { repo: '/projects/other', cost: 900 }); f.complete(other);
  const old = f.built('old', { hours: 24 * 70 }); f.complete(old, 'operator:inspector', old.id, 24 * 69);
  const broken = f.built('broken'); store.handle.prepare("UPDATE task_ref SET revision_of='missing' WHERE id=?").run(broken.ref);
  const report = projectOutcomes(store, repo, now, access);
  expect(report.completed).toEqual({ count: 3, actors: { human: 1, lead: 1, landed: 1, 'machine-or-unknown': 0 }, scouts: 1, failedChecks: 1 });
  expect(report.ready).toEqual({ count: 1, oldestFinishedAgeMs: 4 * 3600000, dated: 1 });
  expect(report.revisions).toEqual({ count: 1, perCompletedFamily: 1 / 3, samples: 3 });
  expect(report.finishedToDecision).toEqual({ meanMs: 5 * 3600000 / 3, samples: 3 });
  expect(report.cost).toEqual({ recordedUsd: 14, recordedPerCompletedFamilyUsd: 14 / 3, runs: 5, knownRuns: 4, subscriptionRuns: 0, subscriptionReportedUsd: null, fullyCostedFamilies: 2, families: 3 });
  expect(report.incompleteHistory).toBe(1);
  expect(report.families.find(one => one.root === 'research')?.totalUsd).toBeNull();
  expect(report.families.map(one => one.root)).not.toContain('secret');
  expect(report.families.map(one => one.root)).not.toContain('old');
  expect(report.families.find(one => one.root === ready.id)?.href).toContain(`result=${ready.run}`);
  expect(workIndexPage(store, now, access).totals.completed).toBe(report.completed.count + 1);
  expect(() => projectOutcomes(store, '/projects/other', now, access)).toThrow();
  const who = verifyApproverByPassword(store, 'inspector', f.password, [repo]);
  if (!who.ok) throw new Error(who.reason);
  const tool = LEAD_TOOLS.find(one => one.name === 'get_project_activity')!;
  expect(tool.handle({ store, now, who: who.who, draft: () => null, step: 0, readDecisions: new Map() }, { repo: 'r1' })).toEqual({ ok: true, body: projectOutcomesPage(report) });
  expect(tool.handle({ store, now, who: who.who, draft: () => null, step: 0, readDecisions: new Map() }, { repo: 'r2' }).ok).toBe(false);
  expect(store.handle.prepare('SELECT COUNT(*) n FROM action_ledger WHERE action=?').get(COMPLETION_ACTION)!['n']).toBe(6);
});

test('costs follow the shared accounting: unreported charges and guessed billing stay unknown, subscription usage is never dollars', () => {
  store = openStore(':memory:');
  const f = outcomeFixture(store, repo, now);
  const capped = f.built('capped'); f.bill(capped.run, 12, 'unreported'); f.complete(capped);
  const plan = f.built('plan'); f.bill(plan.run, 4, 'subscription'); f.complete(plan);
  const api = f.built('api', { cost: 2 }); f.complete(api);
  const guessed = f.built('guessed', { cost: 7 }); store.handle.prepare("UPDATE run SET billing_basis='default' WHERE id=?").run(guessed.run); f.complete(guessed);
  const report = projectOutcomes(store, repo, now, access);
  expect(report.cost).toEqual({ recordedUsd: 2, recordedPerCompletedFamilyUsd: 2 / 4, runs: 4, knownRuns: 2, subscriptionRuns: 1, subscriptionReportedUsd: 4, fullyCostedFamilies: 1, families: 4 });
  const family = (root: string) => report.families.find(one => one.root === root)!;
  expect([family('capped').recordedUsd, family('capped').totalUsd, family('capped').knownCostRuns]).toEqual([null, null, 0]);
  expect([family('plan').recordedUsd, family('plan').totalUsd, family('plan').subscriptionReportedUsd]).toEqual([null, null, 4]);
  expect([family('guessed').recordedUsd, family('guessed').totalUsd]).toEqual([null, null]);
  expect(family('api').totalUsd).toBe(2);
});

test('the lead reads every aggregate and pages of family rows that always fit the tool-result cap', () => {
  store = openStore(':memory:');
  const f = outcomeFixture(store, repo, now);
  const title = 'Ünïcødé "quoted" title that runs long '.repeat(20);
  for (let i = 0; i < 40; i++) { const one = f.built(`${'x'.repeat(60)}-${String(i).padStart(3, '0')}`, { title }); f.complete(one); }
  const report = projectOutcomes(store, repo, now, access);
  expect(report.completed.count).toBe(40);
  const who = verifyApproverByPassword(store, 'inspector', f.password, [repo]);
  if (!who.ok) throw new Error(who.reason);
  const tool = LEAD_TOOLS.find(one => one.name === 'get_project_activity')!;
  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = tool.handle({ store, now, who: who.who, draft: () => null, step: 0, readDecisions: new Map() }, { repo: 'r1', offset });
    if (!result.ok) throw new Error(result.message);
    expect(toolResultBytes(JSON.stringify(result.body))).toBeLessThanOrEqual(LEAD_TOOL_RESULT_CAP_BYTES);
    const body = result.body as ReturnType<typeof projectOutcomesPage>;
    expect([body.completed, body.cost, body.familiesTotal]).toEqual([report.completed, report.cost, 40]);
    seen.push(...body.families.map(one => one.root));
    offset = body.nextOffset;
  }
  expect(seen).toEqual(report.families.map(one => one.root));
});

test('empty history has zero samples and unknown averages, never a zero-dollar success', () => {
  store = openStore(':memory:');
  const report = projectOutcomes(store, repo, now, access);
  expect(report.completed.count).toBe(0);
  expect(report.ready.oldestFinishedAgeMs).toBeNull();
  expect(report.finishedToDecision).toEqual({ samples: 0, meanMs: null });
  expect(report.revisions.perCompletedFamily).toBeNull();
  expect(report.cost.recordedPerCompletedFamilyUsd).toBeNull();
});

test('bounded partial history is explicit and foreign revision edges never join families', () => {
  store = openStore(':memory:');
  for (let i = 0; i < 501; i++) {
    const id = `broken-${i}`;
    store.createTask({ id, title: id }, now);
    const ref = store.refFor('built-in', id).id;
    store.placeTask(ref, repo, {}, now);
    store.handle.prepare("UPDATE task_ref SET revision_of='foreign-parent' WHERE id=?").run(ref);
  }
  store.createTask({ id: 'foreign-parent', title: 'Hidden parent' }, now);
  store.placeTask(store.refFor('built-in', 'foreign-parent').id, '/projects/other', {}, now);
  const report = projectOutcomes(store, repo, now, access);
  expect(report.truncated).toBe(true);
  expect(report.families).toHaveLength(500);
  expect(report.incompleteHistory).toBe(500);
  expect(report.completed.count).toBe(0);
  expect(report.cost.families).toBe(0);
  expect(report.families.every(one => one.revisions === null)).toBe(true);
});
