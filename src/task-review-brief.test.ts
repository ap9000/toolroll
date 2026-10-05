import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Artifact, type Store } from './store.js';
import { addApprover, propose, approve } from './scope.js';
import { storeEvidence, parseNumstat, budgetedStatJson } from './evidence.js';
import { renderExecutionPlanDocument } from './plan.js';
import { CheckProgressTracker } from './check-progress.js';
import { sealVerificationReceipt } from './verification-evidence.js';
import { runOperate } from './operate.js';
import { renderReviewBrief, type ReviewBrief } from './task-review-brief.js';

const START = new Date('2026-10-05T18:00:00Z'), END = new Date('2026-10-05T18:05:00Z');
const REPO = '/projects/review-brief', BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);

describe('task review --brief', () => {
  let dir: string, db: string, root: string, store: Store, lead: string, password: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'so-review-brief-'));
    db = join(dir, 'orders.db'); root = join(dir, 'evidence');
    store = openStore(db);
    for (const phase of ['build', 'plan', 'review'] as const) store.setPhaseConfig('installation', phase, 'claude', 'sonnet', 'test', START);
    store.upsertProject(REPO, 'Review packet', START);
    const added = addApprover(store, 'alex', START);
    if (!added.ok) throw Error('fixture sign-in failed');
    password = added.token;
    lead = store.mintLeadCredential('alex', 'alex', START).token;
  });
  afterEach(() => { vi.unstubAllEnvs(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  function task(id = 'labels', repo = REPO) {
    store.createTask({ id, title: 'Save the edited label' }, START);
    const ref = store.refFor('built-in', id).id;
    store.placeTask(ref, repo, {}, START);
    const scope = propose(store, { taskId: id, goal: 'Keep saved labels after reload.', acceptance: [{ id: 'c1', statement: 'The saved label survives reload.', evidence: ['check'], how: null }], now: START });
    expect(approve(store, id, 'alex', START, scope.digest, password)).toMatchObject({ ok: true });
    store.setTaskState(id, 'done', END);
    return ref;
  }
  function run(ref: number, role = 'builder', outcome: string | null = 'built') {
    return Number(store.handle.prepare(`INSERT INTO run
      (task_ref,lease_id,runner,branch,worktree,role,provider,model,base_revision,head_revision,outcome,committed,started_at,finished_at,scope_digest)
      VALUES (?,'test-lease','test-worker','toolroll/labels','/unavailable/worktree',?,'codex','test-model',?,?,?,1,?,?,?)`)
      .run(ref, role, BASE, HEAD, outcome, START.toISOString(), outcome === null ? null : END.toISOString(), store.getScope(store.externalIdFor(ref)!)!.digest).lastInsertRowid);
  }
  function artifact(run: number, kind: Artifact['kind'], value: unknown, capture = 'saved by fixture', name = `${kind}.json`) {
    return storeEvidence(store, root, run, kind, name, Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), capture, END, { captureStatus: 'ok' });
  }
  async function cli(id: string, flags: string[] = [], token = lead) {
    const lines: string[] = [];
    const code = await runOperate('task', ['review', id, '--brief', ...(token ? ['--token', token] : []), ...flags], line => lines.push(line), { databaseFile: db, now: END });
    return { code, text: lines.join('\n') };
  }
  async function packet(id = 'labels', flags: string[] = []) {
    const result = await cli(id, ['--json', ...flags]);
    expect(result.code, result.text).toBe(0);
    return JSON.parse(result.text).brief as ReviewBrief;
  }
  function findings(runId: number, many = false) {
    const rows = many ? Array.from({ length: 40 }, (_, i) => ({ severity: i < 20 ? 'HIGH' : i < 35 ? 'MEDIUM' : 'LOW', file: `src/file-${i}.ts`, line: 4, scenario: `A saved label can be lost in case ${i}.` })) : [
      { severity: 'LOW', file: 'src/labels.ts', line: 2, scenario: 'An optional hint could be shorter.' },
      { severity: 'MEDIUM', file: 'src/labels.ts', line: 5, scenario: 'An empty label has no error message.' },
      { severity: 'HIGH', file: 'src/labels.ts', line: 9, scenario: 'Reload loses the saved label.' },
    ];
    store.handle.prepare(`INSERT INTO build_review (run,task_id,repo,state,findings_json,queued_at,finished_at) VALUES (?,'labels',?,'reviewed',?,?,?)`)
      .run(runId, REPO, JSON.stringify({ version: 1, findings: rows }), START.toISOString(), END.toISOString());
  }
  function plan(ref: number, milestones = ['Keep the edited label after reload.', 'Check empty labels.']) {
    const planner = run(ref, 'planner');
    artifact(planner, 'plan', renderExecutionPlanDocument({ approach: 'Use the saved label in the form.', milestones, dependencies: ['None found.'], risks: ['None found.'], proof: ['Reload the form.'] }));
    return planner;
  }

  test('one planned build packet uses the lead token, saved counts, findings and screenshot paths in both formats', async () => {
    const ref = task(); plan(ref);
    const id = run(ref);
    artifact(id, 'handoff', { conclusion: 'Edited labels now survive reload.', changes: ['not part of the compact conclusion'] });
    artifact(id, 'diff-stat', budgetedStatJson(parseNumstat(Array.from({ length: 18 }, (_, i) => `${i + 1}\t1\tsrc/label-${i}.ts\0`).join(''), BASE, HEAD)));
    artifact(id, 'screenshot', Buffer.from('fixture image bytes'), 'agent-claimed screenshot at evidence/label-phone.png (validated png)', 'shot.png');
    artifact(id, 'terminal-diff', 'RAW_DIFF_MUST_NOT_APPEAR');
    artifact(id, 'check-log', 'RAW_LOG_MUST_NOT_APPEAR');
    store.recordRunCheck(id, { status: 'passed', exitCode: 0, suites: [{ name: 'unit', status: 'passed', exitCode: 0 }] }, END);
    findings(id);
    const brief = await packet();
    const printed = await cli('labels');
    expect(printed.code).toBe(0);
    expect(printed.text).toBe(renderReviewBrief(brief).join('\n'));
    expect(printed.text.split('\n').length).toBeLessThan(60);
    expect(brief.header).toMatchObject({ task: 'labels', run: id, provider: 'codex', model: 'test-model', minutes: 5, outcome: 'built', base: BASE.slice(0, 12), head: HEAD.slice(0, 12) });
    expect(brief.conclusion).toBe('Edited labels now survive reload.');
    expect(brief.changedFiles).toMatchObject({ total: 18, omitted: 3, files: expect.arrayContaining([{ path: 'src/label-17.ts', additions: 18, deletions: 1 }]) });
    expect(printed.text).toContain('and 3 more');
    expect(brief.check).toEqual({ status: 'passed', exit: 0, failed: [] });
    expect(brief.review).toMatchObject({ findings: [{ severity: 'HIGH' }, { severity: 'MEDIUM' }], counts: { HIGH: 1, MEDIUM: 1, LOW: 1 }, omitted: { HIGH: 0, MEDIUM: 0, LOW: 1 } });
    expect(printed.text).not.toContain('An optional hint');
    expect((await packet('labels', ['--all'])).review).toMatchObject({ findings: [{ severity: 'HIGH' }, { severity: 'MEDIUM' }, { severity: 'LOW' }] });
    expect(brief.screenshots).toEqual({ files: [{ path: 'evidence/label-phone.png', bytes: 19 }], omitted: 0 });
    expect(brief.plan).toMatchObject({ titles: ['Keep the edited label after reload.', 'Check empty labels.'] });
    expect(printed.text).toContain('Complete: toolroll task complete labels --digest ');
    expect(printed.text).toContain(`Revise: toolroll task revise labels --run ${id}`);
    expect(printed.text).toContain('merge into a release');
    expect(printed.text).not.toMatch(/RAW_|fixture image bytes|not part of the compact conclusion/);
  });

  test('a scout summary stays attached to its selected report and saved image', async () => {
    const ref = task(), id = run(ref, 'scout');
    const shotId = artifact(id, 'screenshot', Buffer.from('report image'), 'scout screenshot screen.png (validated png)', 'screen.png');
    const shot = store.getArtifact(shotId)!;
    artifact(id, 'report', { title: 'Label behavior', summary: 'The form forgets the edited label after reload.', report: 'RAW_REPORT_BODY', followUps: [], images: [{ file: 'screen.png', caption: 'The form', url: 'https://example.com', artifact: shotId, sha256: shot.sha256 }] });
    const brief = await packet();
    expect(brief.conclusion).toBe('The form forgets the edited label after reload.');
    expect(brief.changedFiles).toBe('not recorded');
    expect(brief.review).toBe('not recorded');
    expect(brief.screenshots).toMatchObject({ files: [{ path: `evidence/${shot.key}`, bytes: 12 }] });
    expect(renderReviewBrief(brief).join('\n')).not.toMatch(/RAW_REPORT_BODY|merge into a release/);
    const newer = run(ref, 'scout');
    artifact(newer, 'report', { title: 'New report', summary: 'A later summary.', report: 'Later report.' });
    expect((await packet('labels', ['--run', String(id)])).conclusion).toBe(brief.conclusion);
  });

  test('a failed machine check reports the failing parts without printing log output', async () => {
    const id = run(task(), 'builder', 'failed');
    store.recordRunCheck(id, { status: 'failed', exitCode: 1, suites: [{ name: 'typecheck', status: 'passed', exitCode: 0 }, { name: 'unit: containment c1', status: 'failed', exitCode: 1 }] }, END);
    artifact(id, 'check-log', 'password=never-show-this\nRAW_CHECK_LOG');
    const brief = await packet();
    expect(brief.check).toEqual({ status: 'failed', exit: 1, failed: ['unit: containment c1'] });
    const text = renderReviewBrief(brief).join('\n');
    expect(text).toContain('Check: failed · exit 1 · failed: unit: containment c1');
    expect(text).not.toMatch(/never-show-this|RAW_CHECK_LOG|Complete:|merge into a release/);
    expect(text).toContain('Revision unavailable');
    artifact(id, 'terminal-diff', 'RAW_DIFF');
    const progress = new CheckProgressTracker(() => {});
    progress.feed('Test Files 1 failed | 8 passed (9)\n');
    store.saveCheckProgress(id, progress.finish()!, END);
    const withProgress = await packet();
    expect(withProgress.check.failed).toEqual(['unit: containment c1', 'unit: 1 failed']);
    expect(withProgress.nextActions).toContain(`Revise: toolroll task revise labels --run ${id} --feedback "requested change"`);
  });

  test('no review and missing data are explicit; numeric task ids stay tasks and future planners are excluded', async () => {
    const ref = task('42'), id = run(ref);
    store.handle.prepare('UPDATE run SET model=NULL,base_revision=NULL,head_revision=NULL WHERE id=?').run(id);
    plan(ref);
    const brief = await packet('42');
    expect(brief.header).toMatchObject({ task: '42', run: id, model: 'not recorded', base: 'not recorded', head: 'not recorded' });
    expect(brief).toMatchObject({ conclusion: 'not recorded', changedFiles: 'not recorded', review: 'not recorded', screenshots: 'not recorded', plan: 'not recorded' });
    expect(renderReviewBrief(brief).join('\n')).toContain('Automatic review: not recorded');
    task('unbuilt');
    expect((await packet('unbuilt')).header.run).toBe('not recorded');
  });

  test('latest finished attempt ignores live and reviewer runs; explicit history refuses foreign and unfinished results', async () => {
    const ref = task(), older = run(ref), newer = run(ref);
    artifact(older, 'handoff', { conclusion: 'First saved result.' });
    artifact(newer, 'handoff', { conclusion: 'Second saved result.' });
    run(ref, 'planner');
    const live = run(ref, 'builder', null), foreign = run(task('other'));
    expect((await packet()).header.run).toBe(newer);
    const old = await packet('labels', ['--run', String(older)]);
    expect(old.conclusion).toBe('First saved result.');
    expect(old.nextActions.join(' ')).not.toMatch(/Complete:|Revise:/);
    for (const id of [foreign, live]) expect((await cli('labels', ['--run', String(id), '--json'])).code).toBe(3);
    for (const flag of ['0', '1x', '9007199254740992']) expect((await cli('labels', ['--run', flag, '--json'])).code).toBe(2);
  });

  test('an older run reads its own sealed check when no compact check index was recorded', async () => {
    const ref = task(), older = run(ref);
    store.setVerifyCommand({ repo: REPO, command: 'npm test', timeoutMs: 300_000, approvedBy: 'alex' }, START);
    artifact(older, 'check-log', 'RAW_OLD_LOG');
    sealVerificationReceipt(store, root, older, HEAD, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 2 }, END);
    const newer = run(ref);
    store.recordRunCheck(newer, { status: 'passed', exitCode: 0, suites: [] }, END);
    expect(store.runCheckFor(older)).toBeNull();
    const brief = await packet('labels', ['--run', String(older)]);
    expect(brief.check).toEqual({ status: 'failed', exit: 2, failed: 'not recorded' });
    expect(brief.header.state).toBe('Earlier result');
    expect(renderReviewBrief(brief).join('\n')).not.toContain('RAW_OLD_LOG');
    expect((await packet()).check.status).toBe('passed');
  });

  test('the lead token also works from the environment and respects project access', async () => {
    run(task());
    vi.stubEnv('TOOLROLL_LEAD_TOKEN', lead);
    expect((await cli('labels', ['--json'], '')).code).toBe(0);
    const foreign = '/projects/private';
    store.upsertProject(foreign, 'Private', START);
    run(task('hidden', foreign));
    expect(addApprover(store, 'bob', START, { name: 'alex', token: password }).ok).toBe(true);
    expect(store.setAccountProjects('alex', [REPO], 'alex', END).ok).toBe(true);
    lead = store.mintLeadCredential('alex', 'alex', END).token;
    vi.stubEnv('TOOLROLL_LEAD_TOKEN', lead);
    expect((await cli('labels', ['--json'])).code).toBe(0);
    const denied = await cli('hidden', ['--json']);
    expect(denied.code).toBe(3);
    expect(denied.text).not.toContain('Private');
    store.revokeLeadCredentials('alex', 'alex', END);
    expect((await cli('labels', ['--json'])).code).toBe(3);
  });

  test('redacts credentials and terminal controls in every untrusted field before truncation, in JSON too', async () => {
    const ref = task(), id = run(ref), key = `sk-${'z'.repeat(40)}`;
    artifact(id, 'handoff', { conclusion: `${'a'.repeat(580)} ${key}` });
    artifact(id, 'diff-stat', budgetedStatJson(parseNumstat(`1\t0\t${key}\0`, BASE, HEAD)));
    store.recordRunCheck(id, { status: 'failed', exitCode: 1, suites: [{ name: 'token=private-test-value', status: 'failed', exitCode: 1 }] }, END);
    store.handle.prepare(`INSERT INTO build_review (run,task_id,repo,state,findings_json,reason,queued_at) VALUES (?,'labels',?,'reviewed',?,?,?)`)
      .run(id, REPO, JSON.stringify({ findings: [{ severity: 'HIGH', file: key, line: 2, scenario: lead }, { severity: 'LOW', file: 'safe.ts', line: 3, scenario: '\u001b[31mUse a shorter hint.\nKeep it clear.' }] }), 'Authorization: Bearer example-secret', START.toISOString());
    artifact(id, 'screenshot', Buffer.from('image'), `agent-claimed screenshot at evidence/${key}.png (validated png)`);
    const result = await cli('labels', ['--json', '--all']);
    expect(result.code).toBe(0);
    expect(result.text).not.toContain(key);
    expect(result.text).not.toContain(lead);
    expect(result.text).not.toMatch(/private-test-value|example-secret|\\u001b|\\nKeep/);
    expect(result.text).toContain('[redacted]');
    expect(JSON.parse(result.text).brief.conclusion).toBe('[redacted]');
  });

  test('damaged evidence reads as not recorded and a large packet stays below 60 lines even with --all', async () => {
    const ref = task(); plan(ref, Array.from({ length: 12 }, (_, i) => `Check form ${i}.`));
    const id = run(ref); findings(id, true);
    artifact(id, 'handoff', { conclusion: 'The saved labels now survive reload. '.repeat(20) });
    const stat = artifact(id, 'diff-stat', budgetedStatJson(parseNumstat(Array.from({ length: 40 }, (_, i) => `1\t1\tsrc/form-${i}.ts\0`).join(''), BASE, HEAD)));
    for (let i = 0; i < 10; i++) artifact(id, 'screenshot', Buffer.from('image'), `agent-claimed screenshot at evidence/form-${i}.png (validated png)`, `shot-${i}.png`);
    for (const flags of [[], ['--all']]) {
      const brief = await packet('labels', flags);
      expect(renderReviewBrief(brief).length).toBeLessThan(60);
      expect(brief.review).toMatchObject({ counts: { HIGH: 20, MEDIUM: 15, LOW: 5 }, omitted: { HIGH: 8, MEDIUM: 15, LOW: 5 } });
    }
    writeFileSync(join(root, store.getArtifact(stat)!.key), 'damaged');
    expect((await packet()).changedFiles).toBe('not recorded');
  });

  test('the original run-only automatic review command still works', async () => {
    const id = run(task()); findings(id);
    const lines: string[] = [];
    expect(await runOperate('task', ['review', String(id), '--json', '--token', lead], line => lines.push(line), { databaseFile: db, now: END })).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ ok: true, run: id, review: { state: 'reviewed' } });
  });
});
