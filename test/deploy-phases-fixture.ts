// The browser deployment fixture (scripts/deploy-phases.mjs run against a real orders database, coding catalog, journal
// and backups in a scratch folder, with recorded fakes for launchd, ps, pgrep and curl). Shared by
// src/deploy-coding.slow.test.ts and src/deploy-new-service-stop.slow.test.ts. Nothing here runs a real launchctl,
// ps, pgrep or curl, reads the person's LaunchAgents or state folder, or listens on a port.
import { expect, vi } from 'vitest';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.js';
import { CodingWorkspace } from '../src/coding-workspace.js';
import * as gate from '../src/desktop-update-gate.js';
import { durableJson } from '../src/desktop-update.js';
import { browserDeployment } from '../scripts/deploy-phases.mjs';
import { programArguments } from '../scripts/deploy-launchd.mjs';
import { commandKind } from '../scripts/deploy-stop.mjs';
import { acquireDeploymentLock } from '../src/deploy-lock.js';
import { fakePid } from './fake-pid.js';

/** A deployment run through deploy-browser's own phases (scripts/deploy-phases.mjs) against a real orders database,
 * coding catalog, journal and backups in a scratch folder. launchd, ps, pgrep, curl, the installed and staged
 * runtimes and the plane's records are recorded fakes. `log` holds what happened, in order: each journaled phase
 * once, and every service, custody, backup, migration and network effect. */
export type DeploymentOptions = {
  codingCatalog?: boolean;
  wrap?: (args: Record<string, any>) => Record<string, any>;
  /** The layout and launchd a stop of the new service reads (docs/plans/recovery-stops-silent-service.md): a state
   * folder named as Toolroll's own, the stage under its staged-upgrades/, a definition with ProgramArguments, a full
   * `launchctl print` block from the definition launchd loaded, and a `ps -A` listing built from the services. */
  launchd?: boolean;
  /** With launchd: the temp root's name prefix (the state folder's name). */
  rootName?: string;
  /** With launchd: the stage, relative to the root. */
  stageAt?: string;
  /** With launchd: the stage is a link to a folder beside it. */
  stageLink?: boolean;
};
/** The scrubbed shape of one `launchctl print gui/<uid>/<label>` block (as macOS prints a LaunchAgent). */
export function launchdBlock({ target, path, args, pid }: { target: string; path: string; args: string[]; pid: number | null }): string {
  return [
    `${target} = {`, '\tactive count = 1', `\tpath = ${path}`, '\ttype = LaunchAgent', `\tstate = ${pid === null ? 'waiting' : 'running'}`, '',
    `\tprogram = ${args[0]}`, '\targuments = {', ...args.map(arg => `\t\t${arg}`), '\t}', '',
    '\tworking directory = /tmp', '', '\tenvironment = {', '\t\tXPC_SERVICE_NAME => ' + target.split('/').pop(), '\t}', '',
    `\tdomain = ${target.split('/').slice(0, 2).join('/')} [100005]`, '\tasid = 100005', '\tminimum runtime = 10', '\texit timeout = 5', '\truns = 1',
    ...(pid === null ? [] : [`\tpid = ${pid}`]), '\timmediate reason = speculative', '\tlast exit code = (never exited)', '',
    '\tspawn type = daemon (3)', '\tproperties = keepalive | runatload', '}', '',
  ].join('\n');
}
export const NODE = '/usr/local/bin/node';
const START = 'Mon Nov 9 10:00:00 2026';
type Row = { pid: number; ppid: number; command: string };

export async function deployment({ codingCatalog = true, wrap = (args: Record<string, any>) => args, launchd = false, rootName = 'toolroll-phases-', stageAt = 'staged-upgrades/browser-ccccccc-a1b2c3', stageLink = false }: DeploymentOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), launchd ? rootName : 'so-browser-phases-'));
  const stage = launchd ? join(root, stageAt) : join(root, 'stage');
  const database = join(root, 'orders.db'), plist = join(root, 'browser.plist');
  const priorDist = join(root, 'installed', 'dist'), nextDist = join(stage, 'runtime', 'node_modules', 'toolroll', 'dist');
  const journalFile = join(stage, 'deployment.json'), codingBackup = join(stage, 'coding.backup.sqlite');
  if (!launchd) mkdirSync(stage);
  else {
    if (stageLink) { const real = join(dirname(stage), `real-${basename(stage)}`); mkdirSync(real, { recursive: true }); symlinkSync(real, stage); }
    else mkdirSync(stage, { recursive: true });
    mkdirSync(priorDist, { recursive: true }); mkdirSync(nextDist, { recursive: true }); mkdirSync(join(root, 'home'));
  }
  openStore(database).close();
  // A real coding catalog, kept aside so a test can make one appear partway through.
  const catalog = join(root, 'catalog.sqlite');
  await new CodingWorkspace({ database: catalog, worktreeRoot: join(root, 'worktrees'), permissions: () => ({ sandbox: 'workspace-write' }) }).close();
  const appearCatalog = () => copyFileSync(catalog, `${database}.coding.sqlite`);
  if (codingCatalog) appearCatalog();
  const serviceArgs = (dist: string) => [NODE, `${dist}/controller-service.js`, NODE, `${dist}/cli.js`, 'up', '--db', database, '--runner', 'worker'];
  const livePlist = launchd
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>com.toolroll.browser</string>\n\t<key>ProgramArguments</key>\n\t<array>\n${serviceArgs(priorDist).map(arg => `\t\t<string>${arg}</string>`).join('\n')}\n\t</array>\n\t<key>KeepAlive</key>\n\t<true/>\n</dict>\n</plist>\n`
    : `<string>${priorDist}/cli.js</string><string>--runner</string><string>worker</string>`;
  writeFileSync(plist, livePlist);
  writeFileSync(join(root, 'repos.json'), JSON.stringify({ repos: ['/repo'] }));
  writeFileSync(join(stage, 'candidate.tgz'), 'packed candidate');
  const schema = (() => { const db = new DatabaseSync(database, { readOnly: true }); try { return Number(db.prepare('SELECT version FROM schema_version').get()?.version); } finally { db.close(); } })();

  const log: string[] = [];
  const journals: Record<string, Record<string, any>> = {};
  const hooks: { spawn?: (name: string, args: string[]) => Record<string, any> | undefined; printText?: (text: string) => string; durable?: (file: string, r: Record<string, any>, write: () => void) => void; service?: (dist: string) => void;
    stopped?: (pids: number[]) => void; sleep?: (ms?: number) => void; print?: () => void; fetch?: () => void; now?: () => number; install?: () => void; installed?: () => void; freeze?: () => void; owned?: () => void; codingBackup?: () => void; facts?: (db: DatabaseSync) => void; reserve?: (proven: unknown) => void } = {};
  const current = { completion: { digest: 'complete', actor: 'lead' }, gateDigest: 'check', taskId: 'task', repo: '/repo', scopeDigest: 'scope' };
  const services = {
    old: { supervisor: fakePid(1), children: [fakePid(2)], commands: [] as string[] },
    new: { supervisor: fakePid(4), children: [fakePid(5)], commands: ['node cli.js up'] },
    failed: [fakePid(6), fakePid(7)],
    running: 'old' as 'old' | 'new' | 'failed' | null,
    starts: true,
    /** Whether launchd has the label, when that differs from "something of it runs": loaded with no process, or
     * processes left with the label gone. Unset, the label is loaded exactly while something runs. */
    loaded: undefined as boolean | undefined,
    /** The database the new service's `up` was started on, when not this deployment's. */
    newDatabase: undefined as string | undefined,
    /** With launchd: the definition launchd loaded (kept at bootstrap) and the path it loaded it from. */
    definition: null as string | null,
    loadedPath: plist,
    /** With launchd: the failed supervisor's command and parent, when not this runtime's on this database under launchd. */
    failedCommand: undefined as string | undefined,
    failedParent: 1,
    /** The failed service's structure became complete (its `up` and roles are all there). */
    failedComplete: false,
    /** With launchd: start times by pid (ps -A's lstart); unset, one fixed time. */
    startOf: {} as Record<number, string>,
    /** With launchd: commands that replace a listed process's own. */
    commandOf: {} as Record<number, string>,
    /** With launchd: processes of the failed service still listed after its label is gone. */
    lingering: [] as number[],
    /** With launchd: more rows in every listing. */
    extraRows: [] as Row[],
  };
  /** With launchd: every process the listing shows, built from the services. */
  const rows = (): Row[] => {
    const out: Row[] = [{ pid: 1, ppid: 0, command: '/sbin/launchd' }];
    const definedArgs = services.definition === null ? null : programArguments(services.definition);
    if (services.running === 'old') out.push({ pid: services.old.supervisor, ppid: 1, command: serviceArgs(priorDist).join(' ') }, ...services.old.children.map(pid => ({ pid, ppid: services.old.supervisor, command: serviceArgs(priorDist).slice(2).join(' ') })));
    if (services.running === 'new') out.push({ pid: services.new.supervisor, ppid: 1, command: serviceArgs(nextDist).join(' ') }, ...services.new.children.map(pid => ({ pid, ppid: services.new.supervisor, command: serviceArgs(nextDist).slice(2).join(' ') })));
    const [top, child] = services.failed;
    const failed = [{ pid: top!, ppid: services.failedParent, command: services.failedCommand ?? (definedArgs ?? serviceArgs(nextDist)).join(' ') }, { pid: child!, ppid: top!, command: serviceArgs(nextDist).slice(2).join(' ') }];
    out.push(...failed.filter(row => services.running === 'failed' || services.lingering.includes(row.pid)));
    out.push(...services.extraRows);
    return out.map(row => ({ ...row, command: services.commandOf[row.pid] ?? row.command }));
  };
  const listing = () => rows().map(row => `${String(row.pid).padStart(7)} ${String(row.ppid).padStart(7)} ${services.startOf[row.pid] ?? START} ${row.command}`).join('\n') + '\n';
  const labelLoaded = () => services.loaded ?? services.running !== null;
  const coding = (who: string) => ({
    backupCodingCatalog: async (from: string, to: string) => { log.push(`${who} backs up coding`); hooks.codingBackup?.(); copyFileSync(from, to); },
    assertCodingUpdateStopped: () => { log.push(`${who} custody`); },
    releaseStaleCodingOwner: () => { log.push(`${who} releases stale owner`); return null; },
  });
  const installed = coding('installed'), candidate = coding('candidate');
  const gateEffects = {
    ...gate,
    updateGateOwned: (db: DatabaseSync, id: string) => { hooks.owned?.(); return gate.updateGateOwned(db, id); },
    installUpdateGate: (db: DatabaseSync, id: string) => { hooks.install?.(); gate.installUpdateGate(db, id); hooks.installed?.(); },
    freezeUpdateGate: (db: DatabaseSync, id: string) => { const frozen = gate.freezeUpdateGate(db, id); hooks.freeze?.(); return frozen; },
  };
  const paused = () => { const db = new DatabaseSync(database); try { return gate.updateAdmissionPaused(db) ? ' while paused' : ''; } finally { db.close(); } };
  let lastPhase = '';
  const deploymentLock = acquireDeploymentLock(journalFile);
  const cancellation = new AbortController();
  const args = wrap({
    deploymentLock, signal: cancellation.signal,
    database, stageDir: stage, stateDir: root, journalFile, plist, livePlist, priorDist, nextDist, uid: 501, label: 'com.toolroll.browser', servicePort: '4180',
    runId: 7, candidateHead: 'c'.repeat(40), publicUrl: null, script: 'scripts/deploy-browser.mjs --phase',
    oldRt: { gate: gateEffects, update: { durableJson: (file: string, r: Record<string, any>) => hooks.durable ? hooks.durable(file, r, () => durableJson(file, r)) : durableJson(file, r) }, coding: installed },
    ...(launchd ? { home: join(root, 'home') } : {}),
    facts: (db: DatabaseSync) => { hooks.facts?.(db); return structuredClone(current); },
    reserve: (proven: unknown) => { hooks.reserve?.(proven); },
    quiet: () => {},
    service: (dist: string) => {
      hooks.service?.(dist);
      if (dist === nextDist && services.running === 'failed' && services.failedComplete) return { supervisor: services.failed[0], children: [services.failed[1]], commands: [], roles: [] };
      if (dist === nextDist && services.running === 'new') {
        // Told as deploy-browser.mjs tells it: by the commands, exact runtime and exact database.
        const up = `/usr/bin/node ${nextDist}/cli.js up --db ${services.newDatabase ?? database} --port 4180`;
        return commandKind(`/usr/bin/node ${nextDist}/controller-service.js ${up}\n`, { dist, database }) === 'supervisor' && commandKind(`${up}\n`, { dist, database }) === 'up' ? services.new : null;
      }
      return dist === priorDist && services.running === 'old' ? services.old : null;
    },
    leftFrom: (dist: string) => (dist === priorDist && services.running === "old") || (dist === nextDist && services.running !== null && services.running !== "old") ? [999] : [],
    proveStaged: () => ({ distFiles: 1 }),
    verifyServiceStopped: async (pids: number[]) => { log.push(`proved stopped ${pids.join(' ')}`); hooks.stopped?.(pids); },
    load: async () => ({ SCHEMA_VERSION: schema, openStore: (file: string) => { log.push('migrate'); const db = new DatabaseSync(file); db.exec('CREATE TABLE candidate_only(value)'); return db; } }),
    loadCodingDeploymentRuntime: async (dist: string) => dist === nextDist ? candidate : installed,
    spawnSync: (command: string, args: string[]) => {
      const name = `${basename(command)} ${args[0]}`;
      const hooked = hooks.spawn?.(name, args);
      if (hooked !== undefined) return hooked;
      if (name === 'launchctl bootout') { log.push('bootout'); services.running = null; services.loaded = undefined; services.definition = null; if (launchd) return { status: 0, stdout: '', stderr: '' }; }
      if (name === 'launchctl bootstrap') {
        // launchd refuses a label it already has.
        if (labelLoaded()) return { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
        const next = readFileSync(plist, 'utf8').includes(nextDist);
        services.definition = readFileSync(plist, 'utf8'); services.loadedPath = plist;
        log.push(next ? 'bootstrap candidate' : `bootstrap previous${paused()}`);
        services.running = !next ? 'old' : services.starts ? 'new' : 'failed';
        services.loaded = undefined;
        return { status: 0, stderr: '' };
      }
      if (name === 'launchctl print') {
        hooks.print?.();
        if (!labelLoaded()) return { status: 113, stdout: '' };
        // A loaded label with no process prints no pid.
        const pid = services.running === 'failed' ? services.failed[0] : services.running === 'new' ? services.new.supervisor : services.running === 'old' ? services.old.supervisor : null;
        if (launchd) {
          const text = launchdBlock({ target: args[1]!, path: services.loadedPath, args: programArguments(services.definition ?? livePlist) ?? [], pid: pid ?? null });
          return { status: 0, stdout: hooks.printText ? hooks.printText(text) : text };
        }
        return { status: 0, stdout: pid === null ? '\n\tstate = waiting' : `\n\tstate = running\n\tpid = ${pid}` };
      }
      if (name === 'pgrep -P') return { status: 0, stdout: `${services.failed[1]}\n` };
      if (name === 'ps -A' && launchd) return { status: 0, stdout: listing() };
      // Nothing answers on the port while only the failed service runs, or nothing at all.
      if (name === 'curl -fsS' && launchd && (services.running === 'failed' || services.running === null)) return { status: 7, stdout: '' };
      if (name === 'curl -fsS') { log.push(`healthz${paused()}`); return { status: 0, stdout: '{"status":"ok"}' }; }
      return { status: 1, stdout: '' };
    },
    fetch: async (url: string) => { log.push(`fetch ${url}`); hooks.fetch?.(); return { ok: true, status: 200 }; },
    sleep: async (ms?: number) => { hooks.sleep?.(ms); },
    now: () => hooks.now?.() ?? Date.now(),
    say: (message: unknown) => {
      if (typeof message !== 'string') { log.push('summary'); return; }
      const phase = message.replace(/^• /, '');
      if (phase === lastPhase) return;
      lastPhase = phase; log.push(phase);
      journals[phase] ??= JSON.parse(readFileSync(journalFile, 'utf8'));
    },
    requireTrue: (okay: unknown, message: string) => { if (!okay) throw Error(message); },
    pruneStaged: async () => [],
  });
  const phases = browserDeployment(args);
  /** Another run of the deploy script on this installation: its own process, so its own reading of the service
   * definition. Every phase but recover reads the installed one (after the swap that names the new runtime, so this
   * run's "previous" runtime IS the new one); recover with --stage reads the one saved at preparation. */
  const definitionRuntime = (text: string) => (text.match(/<string>([^<]*\/dist)\/cli\.js<\/string>/) ?? [])[1]!;
  const freshRun = (definition: string) => browserDeployment({ ...args, livePlist: definition, priorDist: definitionRuntime(definition) });
  const asFinish = () => freshRun(readFileSync(plist, 'utf8'));
  const asRecover = (overrides: Record<string, any> = {}) => browserDeployment({ ...args, livePlist: readFileSync(join(stage, 'browser.saved.plist'), 'utf8'), priorDist: definitionRuntime(readFileSync(join(stage, 'browser.saved.plist'), 'utf8')), ...overrides });
  const journal = () => JSON.parse(readFileSync(journalFile, 'utf8')) as Record<string, any>;
  const orders = () => new DatabaseSync(database);
  const gateOwned = () => { const db = orders(); try { return gate.updateGateOwned(db, journal().id); } finally { db.close(); } };
  /** Prepared, then rehearsed as a candidate whose schema the previous runtime cannot be assumed to read. */
  const rehearsed = async () => {
    await phases.prepare({ packageSha256: createHash('sha256').update('packed candidate').digest('hex') });
    const r = journal();
    durableJson(journalFile, { ...r, phase: 'rehearsed', rehearsal: { integrity: 'ok', previousRuntimeCompatible: false } });
    log.length = 0; lastPhase = '';
  };
  return {
    deploymentLock, cancellation, root, database, stage, plist, livePlist, priorDist, nextDist, codingBackup, log, journals, hooks, current, services, phases, asFinish, asRecover, journal, orders, gateOwned, rehearsed, appearCatalog, rows, serviceArgs,
    reset: () => { log.length = 0; lastPhase = ''; for (const key of Object.keys(journals)) delete journals[key]; },
    close: () => { deploymentLock.release(); rmSync(root, { recursive: true, force: true }); },
  };
}
export const tamper = (file: string) => writeFileSync(file, 'changed after it was verified');
export const quietly = <T>(run: () => T) => { const spy = vi.spyOn(console, 'error').mockImplementation(() => {}); try { return run(); } finally { spy.mockRestore(); } };
/** What a run printed to stderr, and what it returned. */
export const said = <T>(run: () => T) => { const spy = vi.spyOn(console, 'error').mockImplementation(() => {}); try { const result = run(); return { result, words: spy.mock.calls.map(call => call.join(' ')).join('\n') }; } finally { spy.mockRestore(); } };


/** A swap killed in its wait for the new service: the journal is left at "starting". */
export async function killedAtStarting({ starts = true, ...options }: { starts?: boolean } & NonNullable<Parameters<typeof deployment>[0]> = {}) {
  const d = await deployment(options);
  await d.rehearsed();
  d.services.starts = starts;
  d.hooks.sleep = () => { throw Error('killed'); };
  await expect(d.phases.swap()).rejects.toThrow('killed');
  delete d.hooks.sleep;
  expect(d.journal().phase).toBe('starting');
  d.reset();
  return d;
}
export const migratedRows = (d: Awaited<ReturnType<typeof deployment>>) => { const db = d.orders(); try { return db.prepare("SELECT name FROM sqlite_master WHERE name='candidate_only'").get() !== undefined; } finally { db.close(); } };

