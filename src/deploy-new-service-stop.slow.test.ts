// Recovery stops a new service that never started completely (docs/plans/recovery-stops-silent-service.md, T1–T21 but
// T21's release-gate rows, which are in src/release-gate.test.ts, and T22, src/deploy-launchd.test.ts). Every launchd,
// ps, pgrep and curl call is the deployment fixture's recorded fake (test/deploy-phases-fixture.ts) in a temp root with
// its own home: nothing here runs a real launchctl, reads the person's LaunchAgents or state folder, or uses port 4180.
import { test, expect } from 'vitest';
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeUpdateGate } from './desktop-update-gate.js';
import { durableJson } from './desktop-update.js';
import { DEPLOY_PHASES } from '../scripts/deploy-phase-table.mjs';
import { HEALTH_WAIT_MS } from '../scripts/deploy-recovery.mjs';
import { killedAtStarting, migratedRows, NODE, quietly, type DeploymentOptions } from '../test/deploy-phases-fixture.js';
import { fakePid } from '../test/fake-pid.js';

type D = Awaited<ReturnType<typeof killedAtStarting>>;
const manual = (uid = 501) => `The new service is still loaded or still has processes, so the previous one was not put back. Nothing was stopped and the journal stays at starting. If it is running, run the release again to finish the deployment. If it never answers, stop it (launchctl bootout gui/${uid}/com.toolroll.browser), then run the release again.`;
const because = (why: string, uid = 501) => `${manual(uid)} Recovery did not stop it itself because ${why}.`;
const COMPLETED = 'The new service started all its processes while recovery was waiting. Nothing was stopped and the journal stays at starting. Run the release again to finish the deployment.';
const WHY = {
  record: 'the deployment journal does not name this service',
  placement: "the deployment folder is not in Toolroll's own folder",
  link: 'a deployment file is a link or not a plain file',
  definition: 'the installed service definition is not the one this deployment installed',
  job: "launchd's loaded job is not this deployment's definition",
  noProcess: 'launchd shows no running process for the service',
  notLoaded: 'launchd does not have the service loaded, but some of its processes have not exited',
  notOurs: "the running process is not the new runtime's service on this database",
  tree: "the service's processes could not all be listed",
  runtime: 'a runtime folder could not be read',
  sameRuntime: 'the new and previous runtimes are the same folder',
  prior: 'a process of the previous version is still running',
  pause: 'new work is no longer paused by this deployment',
  changed: 'the service changed while recovery was checking it',
  answered: 'its console answered http://127.0.0.1:4180/healthz',
  unsure: 'a check of the service did not finish or could not run',
  late: 'the checks took longer than recovery allows',
  unwritten: 'its record of the stop could not be written',
};
const STOPPING = (pid: number) => `Stopping the new service: it is loaded but has not started all its processes for ${HEALTH_WAIT_MS / 1000} seconds (process ${pid}).`;
const STOPPED = 'Stopped the new service. Putting the previous version back.';
const LATER = 'Mon Nov 9 10:07:00 2026';

/** A deployment killed while it waited for a new service that never starts completely, in Toolroll's own layout, on a
 * clock the fake sleep moves. `sleeps` counts the seconds slept. */
async function stuck(options: DeploymentOptions = {}) {
  const d = await killedAtStarting({ starts: false, launchd: true, ...options });
  let clock = Date.parse('2026-11-09T10:00:00Z');
  const counter = { sleeps: 0 };
  d.hooks.now = () => clock;
  d.hooks.sleep = ms => { clock += ms ?? 1000; counter.sleeps++; };
  expect([d.journal().phase, d.services.running, d.journal().launchd]).toEqual(['starting', 'failed', { uid: 501, label: 'com.toolroll.browser', plist: d.plist, nextPlistSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  return Object.assign(d, { counter });
}
const failure = async (run: Promise<unknown>) => run.then(() => null, (error: Error) => error.message);
const effects = (d: D) => d.log.filter(line => /bootout|bootstrap|healthz/.test(line));
const editJournal = (d: D, change: (r: Record<string, any>) => void) => { const r = d.journal(); change(r); durableJson(join(d.stage, 'deployment.json'), r); };
const lease = (d: D) => { const db = d.orders(); try { const now = new Date().toISOString(); db.prepare("INSERT OR REPLACE INTO watch_lease VALUES('worker','/repo','owner',1,?,?,?)").run(now, new Date(Date.now() + 3_600_000).toISOString(), now); } finally { db.close(); } };
const nextPlist = (d: D) => readFileSync(join(d.stage, 'browser.next.plist'), 'utf8');
/** Every process the fixture's listing shows with this command line (a row the test adds). */
const row = (pid: number, ppid: number, command: string) => ({ pid, ppid, command });

test('T1: a new service loaded that never started completely is stopped once, then journaled a failed start and undone', async () => {
  const d = await stuck();
  try {
    const [supervisor, child] = d.services.failed;
    const recover = d.asRecover();
    expect(await recover.proveStartFailed()).toBe(true);
    // The whole wait, watched by this run, before the one act.
    expect(d.counter.sleeps).toBeGreaterThanOrEqual(HEALTH_WAIT_MS / 1000);
    expect(d.log).toEqual([STOPPING(supervisor!), 'bootout', STOPPED, 'starting', 'candidate custody', 'start-failed']);
    expect(d.journal().newServiceStop).toMatchObject({ state: 'stopped', label: 'com.toolroll.browser', attempts: 1, pids: [{ pid: supervisor, start: expect.any(String) }, { pid: child, start: expect.any(String) }] });
    expect(d.journal().timeline.map((one: { name: string }) => one.name)).toEqual(expect.arrayContaining(['stopping the new service', 'stopped the new service']));
    const recovering = d.log.length;
    expect(quietly(() => recover.recoverJournal())).toBe(true);
    expect(d.log.slice(recovering)).toEqual(['bootstrap previous while paused', 'healthz while paused']);
    expect(readFileSync(d.plist, 'utf8')).toBe(d.livePlist);
    expect([d.journal().phase, d.gateOwned(), d.services.running, migratedRows(d)]).toEqual(['released', false, 'old', false]);
  } finally { d.close(); }
});

type Row = { name: string; options?: DeploymentOptions; arrange?: (d: D) => void; run?: Record<string, any>; why: string; uid?: number };
const otherDb = (d: D, database: string) => d.serviceArgs(d.nextDist).map(arg => arg === d.database ? database : arg).join(' ');
const linked = (d: D, name: string) => { const file = join(d.stage, name); renameSync(file, `${file}.real`); symlinkSync(`${file}.real`, file); };
const T2: Row[] = [
  { name: 'a journal without the launchd record', arrange: d => editJournal(d, r => { delete r.launchd; }), why: WHY.record },
  { name: 'a journal naming another uid', arrange: d => editJournal(d, r => { r.launchd.uid = 502; }), why: WHY.record },
  { name: 'a journal naming another label', arrange: d => editJournal(d, r => { r.launchd.label = 'com.toolroll.other'; }), why: WHY.record },
  { name: 'a journal naming another definition file', arrange: d => editJournal(d, r => { r.launchd.plist = join(d.root, 'other.plist'); }), why: WHY.record },
  { name: 'a run in another user\'s domain', run: { uid: 502 }, uid: 502, why: WHY.record },
  { name: 'a stage outside staged-upgrades', options: { stageAt: 'stage' }, why: WHY.placement },
  { name: 'a stage two levels below staged-upgrades', options: { stageAt: 'staged-upgrades/nested/browser-ccccccc-a1b2c3' }, why: WHY.placement },
  { name: 'a stage that is a link', options: { stageLink: true }, why: WHY.link },
  { name: 'a journal that is a link', arrange: d => linked(d, 'deployment.json'), why: WHY.link },
  { name: 'a new definition that is a link', arrange: d => linked(d, 'browser.next.plist'), why: WHY.link },
  { name: 'a saved definition that is a link', arrange: d => linked(d, 'browser.saved.plist'), why: WHY.link },
  { name: 'a state folder that is not Toolroll\'s own', options: { rootName: 'so-phases-' }, why: WHY.placement },
  { name: 'a state folder that is a Git repository', arrange: d => mkdirSync(join(d.root, '.git')), why: WHY.placement },
  { name: 'an installed definition changed since the swap', arrange: d => writeFileSync(d.plist, `${readFileSync(d.plist, 'utf8')}<!-- edited -->\n`), why: WHY.definition },
  { name: 'no new definition in the stage', arrange: d => rmSync(join(d.stage, 'browser.next.plist')), why: WHY.definition },
  { name: 'a recorded hash that differs', arrange: d => editJournal(d, r => { r.launchd.nextPlistSha256 = 'a'.repeat(64); }), why: WHY.definition },
  { name: 'a launchctl print status other than 0 or 113', arrange: d => { d.hooks.spawn = name => name === 'launchctl print' ? { status: 5, stdout: '' } : undefined; }, why: WHY.unsure },
  { name: 'no pid', arrange: d => { d.hooks.printText = text => text.replace(/\tpid = \d+\n/, ''); }, why: WHY.noProcess },
  { name: 'two pid lines', arrange: d => { d.hooks.printText = text => text.replace(/(\tpid = \d+\n)/, `$1\tpid = ${fakePid(30)}\n`); }, why: WHY.job },
  { name: 'no path', arrange: d => { d.hooks.printText = text => text.replace(/\tpath = .*\n/, ''); }, why: WHY.job },
  { name: 'another loaded path', arrange: d => { d.services.loadedPath = join(d.root, 'other.plist'); }, why: WHY.job },
  { name: 'loaded arguments that differ while the file on disk is unchanged', arrange: d => { d.services.definition = nextPlist(d).replace('<string>worker</string>', '<string>local</string>'); }, why: WHY.job },
  { name: 'a process list that cannot be read', arrange: d => { d.hooks.spawn = name => name === 'ps -A' ? { status: 1, stdout: '' } : undefined; }, why: WHY.tree },
  { name: 'the previous runtime\'s command line', arrange: d => { d.services.failedCommand = d.serviceArgs(d.priorDist).join(' '); }, why: WHY.notOurs },
  { name: 'this runtime on another database', arrange: d => { d.services.failedCommand = otherDb(d, join(d.root, 'demo.db')); }, why: WHY.notOurs },
  { name: 'this runtime on a database whose path only begins with this one\'s', arrange: d => { d.services.failedCommand = otherDb(d, `${d.database}-other`); }, why: WHY.notOurs },
  { name: 'a parent other than launchd', arrange: d => { d.services.failedParent = fakePid(31); }, why: WHY.notOurs },
  { name: 'a pause that is not this journal\'s', arrange: d => { const db = d.orders(); try { removeUpdateGate(db, d.journal().id); } finally { db.close(); } }, why: WHY.pause },
  { name: 'new and previous runtimes that are one folder through a link', arrange: d => { rmSync(d.nextDist, { recursive: true }); symlinkSync(d.priorDist, d.nextDist); }, why: WHY.sameRuntime },
  { name: 'a runtime whose real path cannot be read', arrange: d => rmSync(d.nextDist, { recursive: true }), why: WHY.runtime },
  { name: 'a process of the previous runtime', arrange: d => { d.services.extraRows.push(row(fakePid(32), 1, d.serviceArgs(d.priorDist).slice(2).join(' '))); }, why: WHY.prior },
  // F6 excuses only the observed new service's own supervisor and `up`: anything else naming this database refuses.
  { name: 'a process on this database whose command shows no runtime folder', arrange: d => { d.services.extraRows.push(row(fakePid(40), 1, `${NODE} cli.js up --db ${d.database}`)); }, why: WHY.prior },
  { name: 'a child of the new service that names this database but is not its `up`', arrange: d => { d.services.extraRows.push(row(fakePid(41), d.services.failed[0]!, `/bin/sh -c exec ${NODE} cli.js up --db ${d.database}`)); }, why: WHY.prior },
  { name: 'a console that answers /healthz', arrange: d => { d.hooks.spawn = name => name === 'curl -fsS' ? { status: 0, stdout: '{"status":"ok"}' } : undefined; }, why: WHY.answered },
];

test('T2: each single failed fact stops nothing, writes nothing and keeps today\'s message, with the fact', async () => {
  for (const one of T2) {
    const d = await stuck(one.options);
    try {
      one.arrange?.(d);
      const before = readFileSync(d.database), definition = readFileSync(d.plist, 'utf8');
      const recover = d.asRecover(one.run ?? {});
      expect([one.name, await failure(recover.proveStartFailed())]).toEqual([one.name, because(one.why, one.uid)]);
      expect([one.name, effects(d)]).toEqual([one.name, []]);
      expect([one.name, readFileSync(d.database).equals(before), readFileSync(d.plist, 'utf8') === definition]).toEqual([one.name, true, true]);
      expect([one.name, d.journal().phase, d.journal().newServiceStop, d.services.running]).toEqual([one.name, 'starting', undefined, 'failed']);
      // And the recovery that follows it in --phase recover puts nothing back.
      expect([one.name, quietly(() => recover.recoverJournal())]).toEqual([one.name, false]);
      expect([one.name, effects(d)]).toEqual([one.name, []]);
    } finally { d.close(); }
  }
}, 120_000);

test('T3: a structure that completes during the wait is not stopped, and a later finish reaches started', async () => {
  const d = await stuck();
  try {
    let prints = 0;
    d.hooks.spawn = name => { if (name === 'launchctl print' && ++prints === 30) d.services.failedComplete = true; return undefined; };
    expect(await failure(d.asRecover().proveStartFailed())).toBe(COMPLETED);
    expect([effects(d), d.journal().phase, d.journal().newServiceStop]).toEqual([[], 'starting', undefined]);
    delete d.hooks.spawn;
    lease(d);
    await d.asFinish().finish();
    expect(d.journals['started']).toMatchObject({ phase: 'started' });
    expect([d.journal().phase, effects(d)]).toEqual(['deployed', []]);
  } finally { d.close(); }
});

test('T4: a structure completing at the last structure read, or a new child at the last listing, stops nothing and records why', async () => {
  for (const [name, late, words] of [
    ['complete at the last check', (d: D) => { d.services.failedComplete = true; }, COMPLETED],
    ['a new child', (d: D) => { d.services.extraRows.push(row(fakePid(33), d.services.failed[0]!, `${NODE} ${d.nextDist}/up-role-child.js console`)); }, because(WHY.changed)],
  ] as const) {
    const d = await stuck();
    try {
      d.hooks.durable = (_file, r, write) => { write(); if (r.newServiceStop?.state === 'requested') late(d); };
      expect([name, await failure(d.asRecover().proveStartFailed())]).toEqual([name, words]);
      expect([name, effects(d), d.journal().phase]).toEqual([name, [], 'starting']);
      expect(d.journal().newServiceStop).toMatchObject({ state: 'failed', acted: false, reason: name === 'a new child' ? WHY.changed : 'the service started all its processes' });
    } finally { d.close(); }
  }
});

test('T5: a supervisor restarted with a new pid during the wait, or between the last structure read and launchd\'s answer, is not stopped', async () => {
  const during = await stuck();
  try {
    let prints = 0;
    during.hooks.spawn = name => { if (name === 'launchctl print' && ++prints === 40) during.services.failed[0] = fakePid(34); return undefined; };
    expect(await failure(during.asRecover().proveStartFailed())).toBe(because(WHY.changed));
    expect([effects(during), during.journal().newServiceStop]).toEqual([[], undefined]);
  } finally { during.close(); }
  const between = await stuck();
  try {
    let requested = false;
    between.hooks.durable = (_file, r, write) => { write(); if (r.newServiceStop?.state === 'requested') requested = true; };
    // The last structure read (C6) is the last call to service(); the restart lands after it, before launchd's answer.
    between.hooks.service = () => { if (requested) between.services.failed[0] = fakePid(35); };
    expect(await failure(between.asRecover().proveStartFailed())).toBe(because(WHY.changed));
    expect(effects(between)).toEqual([]);
    expect(between.journal().newServiceStop).toMatchObject({ state: 'failed', acted: false, reason: WHY.changed });
  } finally { between.close(); }
});

test('T6: another deployment\'s job, or the previous version loaded by hand, under the label is left alone', async () => {
  const other = await stuck();
  try {
    other.services.definition = nextPlist(other).replaceAll(other.nextDist, join(other.root, 'staged-upgrades', 'browser-ddddddd-000000', 'runtime', 'node_modules', 'toolroll', 'dist'));
    expect(await failure(other.asRecover().proveStartFailed())).toBe(because(WHY.job));
    expect([effects(other), other.journal().newServiceStop]).toEqual([[], undefined]);
  } finally { other.close(); }
  const previous = await stuck();
  try {
    previous.services.running = 'old';
    previous.services.definition = previous.livePlist;
    expect(await failure(previous.asRecover().proveStartFailed())).toBe(because(WHY.job));
    expect([effects(previous), previous.services.running]).toEqual([[], 'old']);
  } finally { previous.close(); }
});

test('T7: the same definition unloaded and loaded again by hand is stopped (plan §5: launchd says nothing of who loaded it)', async () => {
  const d = await stuck();
  try {
    // By hand: bootout, then bootstrap of the identical bytes: a new supervisor of the same job.
    d.services.failed[0] = fakePid(36);
    expect(await d.asRecover().proveStartFailed()).toBe(true);
    expect(d.log.filter(line => line === 'bootout')).toHaveLength(1);
    expect(d.journal()).toMatchObject({ phase: 'start-failed', newServiceStop: { state: 'stopped', pids: expect.arrayContaining([{ pid: fakePid(36), start: expect.any(String) }]) } });
  } finally { d.close(); }
});

test('T8: a journal copied from another stage, or with its launchd record or pause id edited, stops nothing', async () => {
  const cases: [string, (d: D) => void, string][] = [
    ['copied from another stage', d => editJournal(d, r => { r.nextRuntime = join(d.root, 'staged-upgrades', 'browser-eeeeeee-000000', 'runtime', 'node_modules', 'toolroll', 'dist'); }), "This recovery does not match the deployment's recorded runtimes, database or commit. Nothing was stopped and the journal stays at starting."],
    ['its launchd record edited', d => editJournal(d, r => { r.launchd.label = 'com.toolroll.up'; }), because(WHY.record)],
    ['its pause id edited', d => editJournal(d, r => { r.id = randomUUID(); }), because(WHY.pause)],
  ];
  for (const [name, arrange, words] of cases) {
    const d = await stuck();
    try {
      arrange(d);
      expect([name, await failure(d.asRecover().proveStartFailed())]).toEqual([name, words]);
      expect([name, effects(d), d.journal().newServiceStop, d.services.running]).toEqual([name, [], undefined, 'failed']);
    } finally { d.close(); }
  }
});

test('T9: a listing that can\'t be read after the wait, or a tree deeper than four levels, refuses before anything is written', async () => {
  const unreadable = await stuck();
  try {
    let listings = 0;
    unreadable.hooks.spawn = name => name === 'ps -A' && ++listings === 2 ? { status: null, signal: 'SIGKILL', stdout: '' } : undefined;
    expect(await failure(unreadable.asRecover().proveStartFailed())).toBe(because(WHY.tree));
    expect([effects(unreadable), unreadable.journal().newServiceStop]).toEqual([[], undefined]);
  } finally { unreadable.close(); }
  const deep = await stuck();
  try {
    const [, child] = deep.services.failed;
    deep.services.extraRows.push(row(fakePid(37), child!, '/bin/sh -c a'), row(fakePid(38), fakePid(37), '/bin/sh -c b'), row(fakePid(39), fakePid(38), '/bin/sh -c c'));
    expect(await failure(deep.asRecover().proveStartFailed())).toBe(because(WHY.tree));
    expect([effects(deep), deep.journal().newServiceStop]).toEqual([[], undefined]);
  } finally { deep.close(); }
});

test('T10: a crash right after the intent is written leaves it requested; the next run proves everything again, keeps the old pids and stops', async () => {
  const d = await stuck();
  try {
    const [supervisor, child] = d.services.failed;
    d.hooks.durable = (_file, r, write) => { write(); if (r.newServiceStop?.state === 'requested') throw Error('killed'); };
    expect(await failure(d.asRecover().proveStartFailed())).toBe(because(WHY.unwritten));
    expect([effects(d), d.journal().phase, d.journal().newServiceStop.state, d.services.running]).toEqual([[], 'starting', 'requested', 'failed']);
    delete d.hooks.durable;
    // Its child restarted with a new pid since.
    d.services.failed[1] = fakePid(40);
    d.counter.sleeps = 0;
    expect(await d.asRecover().proveStartFailed()).toBe(true);
    expect(d.counter.sleeps).toBeGreaterThanOrEqual(HEALTH_WAIT_MS / 1000);
    expect(d.journal().newServiceStop).toMatchObject({ state: 'stopped', attempts: 2 });
    expect(d.journal().newServiceStop.pids.map((one: { pid: number }) => one.pid)).toEqual([supervisor, child, fakePid(40)]);
  } finally { d.close(); }
});

test('T11: a crash right after the bootout leaves the intent requested; the next run does not stop again, proves the recorded set gone and goes on', async () => {
  const d = await stuck();
  try {
    let requested: Record<string, any> | null = null;
    d.hooks.durable = (_file, r, write) => { write(); if (r.newServiceStop?.state === 'requested') requested = structuredClone(r); };
    expect(await d.asRecover().proveStartFailed()).toBe(true);
    // As a crash right after the act leaves it: the intent written, the label gone, nothing after.
    delete d.hooks.durable;
    durableJson(join(d.stage, 'deployment.json'), requested!);
    expect([d.journal().phase, d.journal().newServiceStop.state, d.services.running]).toEqual(['starting', 'requested', null]);
    d.reset();
    expect(await d.asRecover().proveStartFailed()).toBe(true);
    expect(d.log).toEqual(['starting', 'candidate custody', 'start-failed']);
  } finally { d.close(); }
});

test('T12: an outcome write that fails after the act leaves the intent requested; the next run goes on without a second bootout', async () => {
  const d = await stuck();
  try {
    d.hooks.durable = (_file, r, write) => { if (r.newServiceStop?.state === 'stopped') throw Error('disk full'); write(); };
    expect(await failure(d.asRecover().proveStartFailed())).toBe('The new service stopped, but recovery could not record that. Nothing was put back and the journal stays at starting. Run the release again.');
    expect([d.journal().phase, d.journal().newServiceStop.state, d.services.running, effects(d)]).toEqual(['starting', 'requested', null, ['bootout']]);
    delete d.hooks.durable;
    d.reset();
    expect(await d.asRecover().proveStartFailed()).toBe(true);
    expect(d.log).toEqual(['starting', 'candidate custody', 'start-failed']);
  } finally { d.close(); }
});

test('T13: a bootout that returns an error does nothing more; when it did remove the job the next run restores', async () => {
  const d = await stuck();
  try {
    d.hooks.spawn = name => { if (name !== 'launchctl bootout') return undefined; d.log.push('bootout'); d.services.running = null; d.services.definition = null; return { status: 5, stdout: '', stderr: 'Boot-out failed: 5: Input/output error' }; };
    expect(await failure(d.asRecover().proveStartFailed())).toBe('launchctl bootout returned an error (exit 5), so it is not known whether the new service stopped. Recovery did nothing more and the journal stays at starting. Run the release again: it checks again before doing anything.');
    expect(d.journal().newServiceStop).toMatchObject({ state: 'failed', acted: true, exitStatus: 5 });
    expect(quietly(() => d.asRecover().recoverJournal())).toBe(false);
    expect([effects(d), d.journal().phase]).toEqual([['bootout'], 'starting']);
    delete d.hooks.spawn;
    const recover = d.asRecover();
    expect(await recover.proveStartFailed()).toBe(true);
    expect(quietly(() => recover.recoverJournal())).toBe(true);
    expect([effects(d), d.journal().phase]).toEqual([['bootout', 'bootstrap previous while paused', 'healthz while paused'], 'released']);
  } finally { d.close(); }
});

test('T14: a bootout that returns an error and left the job: the next run proves everything again before a second one', async () => {
  const d = await stuck();
  try {
    d.hooks.spawn = name => { if (name !== 'launchctl bootout') return undefined; d.log.push('bootout'); return { status: 5, stdout: '' }; };
    expect(await failure(d.asRecover().proveStartFailed())).toMatch(/^launchctl bootout returned an error \(exit 5\)/);
    expect(d.journal().newServiceStop).toMatchObject({ state: 'failed', acted: true });
    d.counter.sleeps = 0;
    let sleptBeforeAct = -1;
    d.hooks.spawn = name => { if (name === 'launchctl bootout') sleptBeforeAct = d.counter.sleeps; return undefined; };
    expect(await d.asRecover().proveStartFailed()).toBe(true);
    expect(sleptBeforeAct).toBeGreaterThanOrEqual(HEALTH_WAIT_MS / 1000);
    expect(d.log.filter(line => line === 'bootout')).toHaveLength(2);
    expect(d.journal().newServiceStop).toMatchObject({ state: 'stopped', attempts: 2 });
  } finally { d.close(); }
});

test('T15, T16: still there after the bootout is uncertain and restores nothing; a recorded pid reused by another process counts as gone', async () => {
  const cases: [string, (d: D) => void, string[] | null][] = [
    ['the label still loaded', d => { d.hooks.spawn = name => name === 'launchctl bootout' ? (d.log.push('bootout'), { status: 0, stdout: '' }) : undefined; }, ['launchd still has it loaded', `process ${fakePid(6)}`, `process ${fakePid(7)}`]],
    ['a recorded child still listed with its start time', d => { d.services.lingering.push(d.services.failed[1]!); d.services.commandOf[d.services.failed[1]!] = '/bin/sleep 600'; }, [`process ${fakePid(7)}`]],
    // The child exits with the bootout and its pid goes to an unrelated process started later.
    ['a recorded pid now another process', d => { const child = d.services.failed[1]!; d.services.lingering.push(child); d.hooks.spawn = name => { if (name === 'launchctl bootout') { d.services.commandOf[child] = '/usr/libexec/unrelated'; d.services.startOf[child] = LATER; } return undefined; }; }, null],
  ];
  for (const [name, arrange, left] of cases) {
    const d = await stuck();
    try {
      arrange(d);
      const outcome = await failure(d.asRecover().proveStartFailed());
      if (left === null) {
        expect([name, outcome, d.journal().newServiceStop.state]).toEqual([name, null, 'stopped']);
        continue;
      }
      const words = left.map(one => one.startsWith('process ') ? `${one} is still running` : one).join('; ');
      expect([name, outcome]).toEqual([name, `The new service was asked to stop, but it is not proved stopped (${words}). Nothing was put back and the journal stays at starting. Run the release again once it has stopped.`]);
      expect(d.journal().newServiceStop).toMatchObject({ state: 'uncertain', acted: true, left });
      expect([name, d.journal().phase, effects(d)]).toEqual([name, 'starting', ['bootout']]);
      expect([name, quietly(() => d.asRecover().recoverJournal()), effects(d)]).toEqual([name, false, ['bootout']]);
    } finally { d.close(); }
  }
});

test('T17: a surviving descendant whose command no longer names the runtime blocks the next run through the recorded set', async () => {
  const d = await stuck();
  try {
    const child = d.services.failed[1]!;
    d.services.lingering.push(child);
    d.services.commandOf[child] = '/bin/sleep 600';
    expect(await failure(d.asRecover().proveStartFailed())).toMatch(/not proved stopped/);
    d.reset();
    // The label is gone and nothing names the runtime any more; the recorded child is still running.
    expect(await failure(d.asRecover().proveStartFailed())).toBe(because(WHY.notLoaded));
    expect([d.log, d.journal().phase]).toEqual([[], 'starting']);
    d.services.lingering.length = 0;
    expect(await d.asRecover().proveStartFailed()).toBe(true);
    expect(d.log).toEqual(['starting', 'candidate custody', 'start-failed']);
  } finally { d.close(); }
});

test('T18: a spawn error, a signal or a timeout refuses before the act and is uncertain after it; nothing is restored', async () => {
  const outcomes: [string, Record<string, unknown>][] = [
    ['a signal', { status: null, signal: 'SIGTERM', stdout: '' }],
    ['a timeout', { status: null, signal: 'SIGTERM', error: Object.assign(Error('spawnSync /bin/launchctl ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '' }],
    ['a spawn error', { status: null, signal: null, error: Object.assign(Error('spawnSync ENOENT'), { code: 'ENOENT' }), stdout: '' }],
  ];
  for (const [what, out] of outcomes) {
    for (const [call, why] of [['launchctl print', WHY.unsure], ['ps -A', WHY.tree], ['curl -fsS', WHY.unsure]] as const) {
      const d = await stuck();
      try {
        d.hooks.spawn = name => name === call ? out : undefined;
        expect([what, call, await failure(d.asRecover().proveStartFailed())]).toEqual([what, call, because(why)]);
        expect([what, call, effects(d), d.journal().newServiceStop]).toEqual([what, call, [], undefined]);
      } finally { d.close(); }
    }
    // After the act: the bootout itself, then launchd's answer and the listing during the absence proof.
    const after: [string, (d: D) => void, string][] = [
      ['launchctl bootout', d => { d.hooks.spawn = name => name === 'launchctl bootout' ? (d.log.push('bootout'), out) : undefined; }, 'launchctl bootout did not finish'],
      ['launchctl print', d => { let acted = false; d.hooks.spawn = name => { if (name === 'launchctl bootout') acted = true; return acted && name === 'launchctl print' ? out : undefined; }; }, "launchd's answer could not be read"],
      ['ps -A', d => { let acted = false; d.hooks.spawn = name => { if (name === 'launchctl bootout') acted = true; return acted && name === 'ps -A' ? out : undefined; }; }, 'the process list could not be read'],
    ];
    for (const [call, arrange, detail] of after) {
      const d = await stuck();
      try {
        arrange(d);
        expect([what, call, await failure(d.asRecover().proveStartFailed())]).toEqual([what, call, `The new service was asked to stop, but it is not proved stopped (${detail}). Nothing was put back and the journal stays at starting. Run the release again once it has stopped.`]);
        expect(d.journal().newServiceStop).toMatchObject({ state: 'uncertain', acted: true });
        expect([what, call, d.journal().phase, quietly(() => d.asRecover().recoverJournal()), effects(d)]).toEqual([what, call, 'starting', false, ['bootout']]);
      } finally { d.close(); }
    }
  }
}, 120_000);

test('T19: no other phase, and no finish, ever stops the new service', async () => {
  for (const phase of DEPLOY_PHASES.filter((one: string) => one !== 'starting')) {
    const d = await stuck();
    try {
      editJournal(d, r => { r.phase = phase; });
      const recover = d.asRecover();
      expect([phase, await recover.proveStartFailed().catch(() => 'refused')]).toEqual([phase, expect.anything()]);
      quietly(() => recover.recoverJournal());
      expect([phase, d.log.filter(line => line === 'bootout')]).toEqual([phase, []]);
    } finally { d.close(); }
  }
  const d = await stuck();
  try {
    await expect(d.asFinish().finish()).rejects.toThrow('The new service is not running from the new runtime. Nothing was stopped and the journal stays at starting.');
    await expect(d.phases.finish()).rejects.toThrow('The new service is not running from the new runtime.');
    expect([d.log.filter(line => line === 'bootout'), d.journal().phase, d.journal().newServiceStop]).toEqual([[], 'starting', undefined]);
  } finally { d.close(); }
}, 60_000);

test('T20: finish keeps its contract: a starting journal without the launchd record whose new service is complete is deployed', async () => {
  const d = await killedAtStarting({ launchd: true });
  try {
    editJournal(d, r => { delete r.launchd; });
    lease(d);
    await d.asFinish().finish();
    expect(d.journals['started']).toMatchObject({ phase: 'started', newService: d.services.new });
    expect([d.journal().phase, d.gateOwned(), d.services.running, effects(d)]).toEqual(['deployed', false, 'new', []]);
  } finally { d.close(); }
});

test('T23: time running out during the last checks stops nothing; no call begins past the deadline and each is cut to the time left', async () => {
  // After the wait 135 s are left (the bootout's 75 s and a margin of 60 s).
  for (const [name, at, jump, ran] of [
    ['before the last checks', null, 600_000, []],
    ['past the deadline during the listing', 'ps -A', 600_000, ['ps -A']],
    ['less than a bootout left at launchd\'s answer', 'launchctl print', 70_000, ['ps -A', 'curl -fsS', 'launchctl print']],
  ] as const) {
    const d = await stuck();
    try {
      const clock = d.hooks.now!, after: string[] = [];
      let ahead = 0, requested = false;
      d.hooks.now = () => clock()! + ahead;
      d.hooks.durable = (_file, r, write) => { write(); if (r.newServiceStop?.state === 'requested') { requested = true; if (at === null) ahead = jump; } };
      d.hooks.spawn = name => { if (requested) { after.push(name); if (name === at) ahead = jump; } return undefined; };
      expect([name, await failure(d.asRecover().proveStartFailed())]).toEqual([name, because(WHY.late)]);
      expect([name, after, effects(d), d.journal().phase]).toEqual([name, ran, [], 'starting']);
      expect(d.journal().newServiceStop).toMatchObject({ state: 'failed', acted: false, reason: WHY.late });
    } finally { d.close(); }
  }
  // Five seconds left: the calls that still begin may run no longer than that.
  const d = await stuck();
  try {
    const clock = d.hooks.now!, timeouts: [string, number][] = [];
    let ahead = 0, requested = false;
    d.hooks.now = () => clock()! + ahead;
    d.hooks.durable = (_file, r, write) => { write(); if (r.newServiceStop?.state === 'requested') requested = true; };
    d.hooks.spawn = (name, _args, options) => { if (requested) { timeouts.push([name, options?.timeout]); if (name === 'ps -A') ahead = 130_000; } return undefined; };
    expect(await failure(d.asRecover().proveStartFailed())).toBe(because(WHY.late));
    expect(timeouts).toEqual([['ps -A', 10_000], ['curl -fsS', 5_000], ['launchctl print', 5_000]]);
    expect(effects(d)).toEqual([]);
  } finally { d.close(); }
});

test('T24: recovery interrupted while the intent is written, or during launchd\'s last answer, stops nothing', async () => {
  // The abort here happens in the same turn: this shows the checks exist and where, not that a real signal is delivered
  // during the event-loop turn the stop takes before them.
  for (const [at, ran] of [['the intent', []], ['launchctl print', ['ps -A', 'curl -fsS', 'launchctl print']]] as const) {
    const d = await stuck();
    try {
      const after: string[] = [];
      let requested = false;
      const interrupt = () => d.cancellation.abort(Error('Deployment interrupted by SIGTERM.'));
      d.hooks.durable = (_file, r, write) => { write(); if (r.newServiceStop?.state === 'requested' && !requested) { requested = true; if (at === 'the intent') interrupt(); } };
      d.hooks.spawn = name => { if (requested) { after.push(name); if (name === at) interrupt(); } return undefined; };
      expect([at, await failure(d.asRecover().proveStartFailed())]).toEqual([at, 'Deployment interrupted by SIGTERM.']);
      expect([at, after, effects(d), d.journal().phase]).toEqual([at, ran, [], 'starting']);
      expect(d.journal().newServiceStop).toMatchObject({ state: 'failed', acted: false, reason: 'recovery was interrupted' });
    } finally { d.close(); }
  }
});
