/** Contracts and isolation boundaries; no workbench or model runs in this file. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, expect, test } from 'vitest';
import { excludedFolders, resolveLaunch, statusProbe } from './status-probe.js';
// @ts-expect-error shared scripted provider contracts
import { pickRule } from '../scripts/fixtures/scripted-provider.mjs';
// @ts-expect-error plain ESM verification command
import { confirmBuild, featureMap, finishReport, keymapSpecs, parseArgs, reportMarkdown, retryAttempt, taskApproval, validateMap, expectedFailureReason, reportSummary, runFeatures, usage } from '../scripts/verify.mjs';
// @ts-expect-error plain ESM world builder
import { assertAgentStandIns, checkedEnv, checkOutbound, createWorld, readConsole } from '../scripts/verify-world.mjs';

const root = mkdtempSync(join(tmpdir(), 'verify-contract-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const keymap = readFileSync(new URL('../tui/crates/toolroll-tui/src/keys.rs', import.meta.url), 'utf8');

/** A screen-driven terminal: a wait remains pending until a matching frame is drawn. No PTY or timers. */
function terminalSteps() {
  let screen = '', pending: { pattern: RegExp; resolve: (screen: string) => void } | undefined;
  const sent: string[] = [];
  const term = {
    text: () => screen,
    send: (key: string) => { sent.push(key); },
    wait: (pattern: RegExp) => {
      if (pattern.test(screen)) return Promise.resolve(screen);
      return new Promise<string>(resolve => { pending = { pattern, resolve }; });
    },
    press: (key: string, pattern: RegExp) => { term.send(key); return term.wait(pattern); },
  };
  const draw = async (next: string) => {
    screen = next;
    if (pending?.pattern.test(screen)) { const done = pending; pending = undefined; done.resolve(screen); }
    // Drain only the promise continuations of the driver step, without a wall-clock delay.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return { term, sent, draw };
}

test('filing waits for the composer echo even when the task prefix is scrolled out, then draws approval before Build', async () => {
  const { term, sent, draw } = terminalSteps();
  const filing = taskApproval(term);
  await draw('New task:');
  expect(sent).toEqual(['n']);
  await draw('New task: ▏ Send ⏎ Cancel Esc\n╰────╯');
  expect(sent).toHaveLength(2);
  expect(sent[1]).toContain('subtract(a, b)');
  // The old predicate waited forever: subtract(a, b) is outside the visible input.
  await draw('subtract(a, b) elsewhere\nNew task: nction next to add');
  expect(sent).toHaveLength(2);
  await draw('New task: nction next to add in src/math.js, with a test.▏ Send ⏎ Cancel Esc\n╰────╯');
  expect(sent).toHaveLength(3);
  expect(sent[2]).toBe('enter');
  let filed = false;
  void filing.then(() => { filed = true; });
  await draw('Build approves exactly this:');
  expect(filed).toBe(false);
  const card = 'Build approves exactly this:\nGoal subtract\nEnter  Build\np Plan it first\nEsc files nothing.';
  await draw(card);
  await filing;
  const building = confirmBuild(term);
  await draw(card);
  expect(sent.filter(key => key === 'enter')).toHaveLength(2);
  await draw('Building it.');
  await building;

  // Direct filing is also a completed submission; it needs no second Enter.
  const direct = terminalSteps();
  const filedDirectly = taskApproval(direct.term);
  await direct.draw('New task: ▏ Send ⏎ Cancel Esc\n╰────╯');
  await direct.draw('New task: with a test.▏ Send ⏎ Cancel Esc\n╰────╯');
  await direct.draw('Filed. Just code: no plan step.');
  await filedDirectly;
  expect(direct.sent.filter(key => key === 'enter')).toHaveLength(1);
});

test('Build cannot be confirmed while the approval terms or its final controls are undrawn', async () => {
  const { term, sent, draw } = terminalSteps();
  const building = confirmBuild(term);
  await draw('Build approves exactly this:\nEnter builds once you\'ve read to the end.');
  expect(sent).toEqual([]);
  // Space exposes the next page; unrelated changes must not release the wait.
  const page = 'Build approves exactly this:\n↓ 12 more lines: j or Space reads on\nEsc files nothing.';
  term.send = (key: string) => {
    sent.push(key);
    if (key === ' ') void draw('Build approves exactly this:\nLast terms\nEsc files nothing.');
  };
  await draw(page);
  expect(sent).toEqual([' ']);
  await draw('Build approves exactly this:\nLast terms\nEnter  Build\nEsc files nothing.');
  expect(sent).toEqual([' ', 'enter']);
  await draw('Building it.');
  await building;
});

test('retry waits for the whole confirmation and a different builder run on the same task', async () => {
  const { term, sent, draw } = terminalSteps();
  let run = { id: 5, task_id: 'task-one' }, checked = false;
  const retry = retryAttempt(term, () => run, 'task-one', async (fact: () => unknown) => {
    expect(fact()).toBe(false); // The success notice alone is not an attempt.
    run = { id: 6, task_id: 'other-task' };
    expect(fact()).toBe(false);
    run = { id: 7, task_id: 'task-one' };
    expect(fact()).toEqual(run);
    checked = true;
  });
  await draw(' Retry \nRetry: starts a new attempt after attempt 1.');
  expect(sent).toEqual(['r']);
  await draw(' Retry \nRetry: starts a new attempt after attempt 1.\nEnter  Retry it\nAny other key cancels.');
  expect(sent).toEqual(['r', 'enter']);
  expect(checked).toBe(false);
  await draw('Retrying: a new attempt starts after attempt 1.');
  await retry;
  expect(checked).toBe(true);
});

test('every keymap action is mapped or deliberately excluded, and every mapped key belongs to its action', () => {
  expect(validateMap(featureMap, keymap)).toBe(true);
  expect(keymapSpecs(keymap).length).toBeGreaterThan(50);
  expect(() => validateMap(featureMap, keymap.replace('"new-task"', '"another-action"'))).toThrow();
  // Dialog keys deliberately live outside the remappable action table.
  const app = readFileSync(new URL('../tui/crates/toolroll-tui/src/app.rs', import.meta.url), 'utf8');
  expect(app).toMatch(/KeyCode::Char\('f'\) =>[\s\S]*?build_unfold = !self.build_unfold/);
  const changed = structuredClone(featureMap);
  changed.features[0].keys = ['invented-key'];
  expect(() => validateMap(changed, keymap)).toThrow(/Unknown key/);
  expect(() => validateMap(featureMap, keymap.replace('actions! {', 'actions! {\nExtra = "extra", Global, Act, "Extra", ["F12"];'))).toThrow(/Unmapped/);
});

test('world ignores caller HOME, credentials and editor, and refuses an escaped agent executable at point of use', () => {
  const world = createWorld(join(root, 'world'), 'smoke', { PATH: process.env['PATH'], HOME: '/home/me', OPENAI_API_KEY: 'never-copy', EDITOR: '/home/me/editor' });
  expect(world.env.HOME).toBe(join(world.root, 'home'));
  expect(world.env.TOOLROLL_SECRET_STORE).toBe('files');
  expect(JSON.stringify(world.env)).not.toMatch(/\/home\/me|never-copy/);
  expect(checkedEnv(world)).toBe(world.env);
  const escaped = join(root, 'real-agent'); writeFileSync(escaped, '#!/bin/sh\nexit 99\n'); chmodSync(escaped, 0o755);
  rmSync(join(world.bin, 'claude')); symlinkSync(escaped, join(world.bin, 'claude'));
  expect(() => assertAgentStandIns(world)).toThrow(/not a stand-in|outside the world/);
  world.env.HOME = '/home/me';
  expect(() => checkedEnv(world)).toThrow(/HOME/);
});

test('a real CLI on a foreign PATH is refused before a lookup process starts', () => {
  const world = createWorld(join(root, 'foreign-path'));
  const foreign = join(root, 'person-bin'); mkdirSync(foreign);
  writeFileSync(join(foreign, 'claude'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  world.env.PATH = `${foreign}:${world.env.PATH}`;
  expect(() => assertAgentStandIns(world)).toThrow(/PATH entry/);
});

test('console state excludes neither the scripted install nor HOME, and the error rule covers retry', async () => {
  const world = createWorld(join(root, 'dispatch'), 'agent-error');
  const env = checkedEnv(world);
  const untrusted = await excludedFolders({ databaseFile: env.TOOLROLL_DB }, [world.shop]);
  expect(untrusted).not.toBeNull();
  const trust = { path: env.PATH, uid: process.getuid?.(), untrusted: untrusted!, acl: null };
  expect(resolveLaunch('claude', trust).ok).toBe(true);
  // Reproduce the old layout: placing state at the world root refuses the shim.
  expect(resolveLaunch('claude', { ...trust, untrusted: [...untrusted!, world.root] }).ok).toBe(false);
  expect(dirname(env.TOOLROLL_DB)).not.toBe(world.root);
  // The real status probe, including fresh trust checks and its reduced child
  // environment, must see the scripted login. No PTY, worker or model starts.
  const status = await statusProbe({ env, databaseFile: env.TOOLROLL_DB, timeoutMs: 3_000 })('claude', ['auth', 'status', '--json']);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout).loggedIn).toBe(true);
  const { rules } = JSON.parse(readFileSync(join(world.provider.dir, 'rules.json'), 'utf8'));
  const turn = { role: 'builder', provider: 'claude', text: 'Add a subtract(a, b) function', call: { resume: null } };
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(pickRule(world.provider.dir, rules, turn)).toMatchObject({ journey: 'runtime-verification', answer: { fail: expect.stringContaining('VERIFY_AGENT_WORDS_7f3a') } });
  }
  expect(pickRule(world.provider.dir, rules, { ...turn, text: 'Unrelated work' })).toBeNull();
});

test('outbound check discovers every family and catches marker words in text and BLOB columns', () => {
  const world = createWorld(join(root, 'outbound'));
  const db = new DatabaseSync(world.env.TOOLROLL_DB);
  db.exec(`CREATE TABLE notification(body TEXT); CREATE TABLE coordinator_future(payload BLOB);
    INSERT INTO notification VALUES ('safe status'); INSERT INTO coordinator_future VALUES (CAST('VERIFY_AGENT_WORDS_7f3a' AS BLOB));`);
  const failed = checkOutbound(world);
  expect(failed.status).toBe('FAIL');
  expect(failed.leaks).toEqual([{ table: 'coordinator_future', rows: 1 }]);
  db.exec('DELETE FROM coordinator_future');
  expect(checkOutbound(world).status).toBe('PASS');
  db.exec('DROP TABLE notification');
  expect(() => checkOutbound(world)).toThrow(/No notification tables/);
  db.close();
  rmSync(world.env.TOOLROLL_DB);
  expect(() => checkOutbound(world)).toThrow(/not created/);
});

test('outbound reads WAL data before and after the console closes its last connection', () => {
  const world = createWorld(join(root, 'outbound-wal'));
  const db = new DatabaseSync(world.env.TOOLROLL_DB);
  try {
    db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE notification(body TEXT);
      INSERT INTO notification VALUES ('VERIFY_AGENT_WORDS_7f3a');`);
    expect(checkOutbound(world).leaks).toEqual([{ table: 'notification', rows: 1 }]);
  } finally { db.close(); }
  // The last writer checkpoints and removes the sidecars. This is the state
  // where macOS sqlite3 -readonly failed with SQLITE_CANTOPEN (14).
  expect(() => readFileSync(world.env.TOOLROLL_DB + '-wal')).toThrow();
  expect(() => readFileSync(world.env.TOOLROLL_DB + '-shm')).toThrow();
  expect(readConsole(world, 'SELECT body FROM notification')).toEqual([{ body: 'VERIFY_AGENT_WORDS_7f3a' }]);
  expect(checkOutbound(world).leaks).toEqual([{ table: 'notification', rows: 1 }]);
});

test('report fails closed on feature, outbound and cleanup failures, retaining excerpts and timing evidence', () => {
  const base = { version: 1, features: [{ id: 'welcome', status: 'PASS', elapsedMs: 20, excerpt: 'screen evidence' }],
    sessions: [{ scenario: 'smoke', timings: { firstTextMs: 10, workbenchMs: 20 }, outbound: { status: 'PASS', tables: ['notification'] } }] };
  expect(finishReport(structuredClone(base)).ok).toBe(true);
  for (const change of ['feature', 'outbound', 'cleanup', 'empty']) {
    const report = structuredClone(base) as any;
    if (change === 'feature') report.features[0].status = 'FAIL';
    if (change === 'outbound') report.sessions[0].outbound.status = 'FAIL';
    if (change === 'cleanup') report.sessions[0].cleanupError = 'process remains';
    if (change === 'empty') report.features = [];
    expect(finishReport(report).ok).toBe(false);
  }
  const md = reportMarkdown(finishReport(base));
  expect(md).toContain('welcome: PASS'); expect(md).toContain('screen evidence'); expect(md).toContain('first text 10 ms');
  expect(JSON.parse(JSON.stringify(base)).features[0].excerpt).toBe('screen evidence');
});

test('selection is explicit and rejects unknown features, scenarios and flags', () => {
  expect(parseArgs(['--scenario', 'smoke', '--scenario', 'narrow', '--features', 'welcome,new-task', '--keep']))
    .toMatchObject({ scenarios: ['smoke', 'narrow'], features: ['welcome', 'new-task'], keep: true });
  for (const args of [['--scenario', 'real'], ['--features', 'typo'], ['--out'], ['--real']]) expect(() => parseArgs(args)).toThrow();
});


test('help is accepted without selecting a runtime and lists every available selector', () => {
  for (const flag of ['--help', '-h']) expect(parseArgs([flag])).toMatchObject({ help: true });
  expect(parseArgs([]).help).toBe(false);
  const help = usage();
  for (const option of ['--help', '--scenario', '--features', '--tarball', '--out', '--keep']) expect(help).toContain(option);
  for (const feature of featureMap.features) {
    expect(help).toContain(feature.id);
    expect(help).toContain(feature.scenario);
  }
});

test.each([[18, 17], [35, 0], [0, 35], [0, 0]])('summary counts %i passes and %i failures separately', (passed, failed) => {
  const report = { features: [
    ...Array.from({ length: passed }, (_, i) => ({ id: `pass-${i}`, status: 'PASS' })),
    ...Array.from({ length: failed }, (_, i) => ({ id: `fail-${i}`, status: 'FAIL' })),
  ] };
  const summary = reportSummary(report);
  expect(summary.split('\n')[0]).toBe(`PASS ${passed} · FAIL ${failed} of ${passed + failed}`);
  if (failed) expect(summary.split('\n')[1]).toBe(`Failing ids: ${report.features.filter(f => f.status === 'FAIL').map(f => f.id).join(', ')}`);
  else expect(summary).not.toContain('Failing ids:');
});

test('only declared dependents fail with a prerequisite; independent features reset and run after failure', async () => {
  const features = [
    { id: 'result', scenario: 'success' },
    { id: 'accept', scenario: 'success', dependsOn: ['result'] },
    { id: 'threads', scenario: 'success' },
    { id: 'help', scenario: 'success' },
  ];
  const term = { screen: { text: () => 'failure evidence' } };
  const ran: string[] = [];
  let resets = 0;
  const exercise = async (feature: { id: string }) => {
    expect(resets).toBe(ran.length + 1);
    ran.push(feature.id);
    if (feature.id === 'result') throw new Error('result unavailable');
    return { excerpt: feature.id };
  };
  // A dependent selection runs its prerequisite even when the prerequisite was not selected.
  const results = await runFeatures(features.slice(1), { features }, { term }, exercise, async () => { resets++; });
  expect(ran).toEqual(['result', 'threads', 'help']);
  expect(results.map((r: any) => [r.id, r.status, r.error])).toEqual([
    ['accept', 'FAIL', 'Prerequisite failed: result'], ['threads', 'PASS', undefined], ['help', 'PASS', undefined],
  ]);
  const all = await runFeatures(features, { features }, { term }, async (f: { id: string }) => ({ excerpt: f.id }), async () => {});
  expect(all.map((r: any) => r.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
  expect(featureMap.features.find((f: any) => f.id === 'accept').dependsOn).toContain('result');
  for (const dependency of ['missing', 'accept']) {
    const invalid = structuredClone(featureMap);
    invalid.features.find((f: any) => f.id === 'result').dependsOn = [dependency];
    expect(() => validateMap(invalid, keymap)).toThrow(/dependency/);
  }
});

test.each([
  ['never-initialized', 'retryable-infra'],
  ['agent-error', 'agent-error'],
])('saved run failure reason for %s is %s', (scenario, reason) => {
  expect(expectedFailureReason(scenario)).toBe(reason);
  if (scenario === 'never-initialized') {
    const feature = featureMap.features.find((f: any) => f.id === scenario);
    expect(new RegExp(feature.expected).test('the provider harness never initialized — exited before initialization')).toBe(true);
  }
});
