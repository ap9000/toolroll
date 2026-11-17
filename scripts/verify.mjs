#!/usr/bin/env node
/** Stand-in-only runtime verification. Importing this module starts nothing. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { createServer } from 'node:net';
import { Screen } from './first-result-kit.mjs';
import { FILING_ANSWER } from './tui-e2e.mjs';
import { MARKER, SCENARIOS, assertAgentStandIns, checkedEnv, checkOutbound, createWorld, git, readConsole, run } from './verify-world.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const featureMap = JSON.parse(readFileSync(join(repo, 'docs/feature-map.json'), 'utf8'));
const word = s => `'${String(s).replace(/'/g, "'\\''")}'`;
const esc = '\x1b';
const keyBytes = { enter: '\r', 'ctrl-e': '\x05', 'ctrl-k': '\x0b', tab: '\t', backtab: '\x1b[Z' };

export function keymapSpecs(source) {
  return [...source.matchAll(/\w+ = "([^"]+)", \w+, \w+, "[^"]*", \[([^\n]*)\];/g)]
    .map(m => ({ action: m[1], keys: [...m[2].matchAll(/"([^"]*)"/g)].map(k => k[1]) }));
}
export function validateMap(map, source) {
  const specs = keymapSpecs(source), actions = new Map(specs.map(s => [s.action, s]));
  if (specs.length < 50) throw new Error('Could not read the Rust keymap');
  const covered = new Set(), ids = new Set();
  for (const entry of map.features) {
    if (ids.has(entry.id)) throw new Error(`Duplicate feature: ${entry.id}`);
    ids.add(entry.id);
    if (!SCENARIOS.includes(entry.scenario)) throw new Error(`Unknown scenario: ${entry.scenario}`);
    if (!entry.screen || !entry.reach || !entry.expected) throw new Error(`Incomplete feature: ${entry.id}`);
    new RegExp(entry.expected);
    for (const action of entry.actions) {
      if (!actions.has(action)) throw new Error(`Unknown action: ${action}`);
      covered.add(action);
    }
    for (const key of entry.keys) {
      if (!entry.actions.some(action => actions.get(action).keys.includes(key))) throw new Error(`Unknown key ${key} for ${entry.id}`);
    }
    for (const key of entry.dialogKeys ?? []) if (!map.dialogKeys[key]) throw new Error(`Undeclared dialog key: ${key}`);
  }
  for (const entry of map.intentionallyUnmapped) {
    const spec = actions.get(entry.action);
    if (!spec || !entry.reason || covered.has(entry.action)) throw new Error(`Invalid unmapped action: ${entry.action}`);
    if (JSON.stringify(spec.keys) !== JSON.stringify(entry.keys)) throw new Error(`Unmapped keys drifted: ${entry.action}`);
    covered.add(entry.action);
  }
  for (const spec of specs) if (!covered.has(spec.action)) throw new Error(`Unmapped keymap action: ${spec.action}`);
  return true;
}
export function parseArgs(args) {
  const options = { scenarios: [], features: [], keep: false, tarball: null, out: null };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--keep') { options.keep = true; continue; }
    if (!['--scenario', '--features', '--tarball', '--out'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${name}`);
    const value = args[++i];
    if (name === '--scenario') options.scenarios.push(value);
    if (name === '--features') options.features.push(...value.split(','));
    if (name === '--tarball') options.tarball = resolve(value);
    if (name === '--out') options.out = resolve(value);
  }
  for (const scenario of options.scenarios) if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
  for (const id of options.features) if (!featureMap.features.some(f => f.id === id)) throw new Error(`Unknown feature: ${id}`);
  return options;
}
export function finishReport(report) {
  report.ok = report.sessions.length > 0 && report.features.length > 0 && report.features.every(f => f.status === 'PASS')
    && report.sessions.every(s => s.outbound?.status === 'PASS' && !s.error && !s.cleanupError);
  return report;
}
export function reportMarkdown(report) {
  return `# Runtime verification\n\n${report.ok ? 'PASS' : 'FAIL'} · ${report.features.length} features\n\n`
    + report.sessions.map(s => `- ${s.scenario}: first text ${s.timings.firstTextMs ?? 'unseen'} ms; workbench ${s.timings.workbenchMs ?? 'unseen'} ms; outbound ${s.outbound?.status ?? 'FAIL'}${s.error ? `; ${s.error}` : ''}${s.cleanupError ? `; cleanup: ${s.cleanupError}` : ''}`).join('\n') + '\n\n'
    + report.features.map(f => `## ${f.id}: ${f.status}\n\n${f.error ?? f.state ?? ''}\n\n\`\`\`text\n${f.excerpt}\n\`\`\`\n`).join('\n');
}
/** Poll only until an observable fact holds. The ceiling bounds a starved CI runner; it is never a success delay. */
export async function until(fact, description, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (true) {
    const value = fact();
    if (value) return value;
    if (Date.now() >= end) throw new Error(`Timed out: ${description}`);
    await new Promise(done => setTimeout(done, 30));
  }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function freePort() {
  const port = await new Promise((done, fail) => { const server = createServer(); server.once('error', fail); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)); }); });
  return port === 4180 ? freePort() : port;
}
class Terminal {
  constructor(world, cli, binary, port, folder, cols) {
    Object.assign(this, { world, cli, binary, port, folder, cols, offset: 0, raw: '', answered: 0, started: Date.now(), steps: [], pids: new Set(), identities: new Map(), decoder: new StringDecoder('utf8'), screen: new Screen(40, cols) });
    mkdirSync(folder, { recursive: true });
    this.fifo = join(folder, 'keys'); this.log = join(folder, 'screen.log'); this.pidFile = join(folder, 'pid');
    run(world, 'mkfifo', [this.fifo]);
    this.keys = openSync(this.fifo, constants.O_RDWR);
    const command = ['python3', join(repo, 'scripts/fixtures/pty-host.py'), '40', String(cols), this.fifo, this.log, this.pidFile,
      process.execPath, cli, '--port', String(port), ...(binary ? ['--tui-binary', binary] : [])].map(word).join(' ');
    // Orphan the host, as tui-e2e does: a person's terminal has no coding agent ancestor.
    this.hostPidFile = join(folder, 'host-pid');
    this.launcher = spawn(join(world.tools, 'sh'), ['-c', `${command} > ${word(join(folder, 'host.log'))} 2>&1 < /dev/null & printf '%s' "$!" > ${word(this.hostPidFile)}`],
      { cwd: world.shop, env: checkedEnv(world), stdio: 'ignore', detached: true });
    this.launcherError = null;
    this.launcher.on('error', error => { this.launcherError = error; });
    if (this.launcher.pid) this.launcherPid = this.launcher.pid;
  }
  processRows() {
    return run(this.world, 'ps', ['-A', '-o', 'pid=,ppid=,stat=,lstart=']).trim().split('\n').map(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      return match ? { pid: Number(match[1]), parent: Number(match[2]), status: match[3], started: match[4] } : null;
    }).filter(Boolean);
  }
  recordPids() {
    const rows = this.processRows(), candidates = new Set();
    for (const path of [this.pidFile, this.hostPidFile]) if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf8')); if (Number.isSafeInteger(pid) && pid > 1) candidates.add(pid);
    }
    if (this.launcher.exitCode === null && this.launcherPid) candidates.add(this.launcherPid);
    for (const row of rows) if (candidates.has(row.pid) && !this.identities.has(row.pid)) {
      this.pids.add(row.pid); this.identities.set(row.pid, row.started);
    }
    // Only descendants of a recorded process with the same birth identity.
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        const parent = rows.find(p => p.pid === row.parent);
        if (parent && this.identities.get(parent.pid) === parent.started && !this.identities.has(row.pid)) {
          this.pids.add(row.pid); this.identities.set(row.pid, row.started); changed = true;
        }
      }
    }
  }
  livePids() { return this.processRows().filter(row => this.identities.get(row.pid) === row.started && !row.status.startsWith('Z')).map(row => row.pid); }
  text() {
    if (this.aborted) throw new Error(this.aborted);
    if (this.launcherError) throw this.launcherError;
    if (existsSync(this.log)) {
      const bytes = readFileSync(this.log);
      if (bytes.length > this.offset) {
        const more = this.decoder.write(bytes.subarray(this.offset)); this.offset = bytes.length;
        this.raw += more; this.screen.write(more);
        if (this.firstTextMs === undefined && /[A-Za-z]/.test(this.screen.text())) this.firstTextMs = Date.now() - this.started;
        const count = this.raw.split('\x1b[c').length - 1;
        while (this.answered < count) { this.send('\x1b[?62c'); this.answered++; }
      }
    }
    return this.screen.text();
  }
  send(text) { writeSync(this.keys, text); }
  async wait(pattern) {
    const shown = await until(() => { const text = this.text(); return pattern.test(text) && text; }, `screen ${pattern}`);
    this.steps.push({ expected: pattern.source, atMs: Date.now() - this.started, screen: shown });
    return shown;
  }
  async press(key, pattern) { this.send(keyBytes[key] ?? key); return this.wait(pattern); }
  async quit() {
    this.recordPids();
    this.send('q'); await this.wait(/Quit Toolroll\?/); this.send('s');
    const pid = Number(readFileSync(this.pidFile, 'utf8'));
    await until(() => !alive(pid), 'workbench exit');
  }
  async cleanup() {
    this.recordPids();
    const signal = kind => {
      const live = this.livePids();
      const pid = existsSync(this.pidFile) ? Number(readFileSync(this.pidFile, 'utf8')) : null;
      if (live.includes(pid)) { try { process.kill(-pid, kind); } catch {} }
      for (const one of live.reverse()) { try { process.kill(one, kind); } catch {} }
    };
    signal('SIGTERM');
    try { await until(() => this.livePids().length === 0, 'recorded process exit', 5_000); }
    catch { signal('SIGKILL'); await until(() => this.livePids().length === 0, 'killed process exit', 5_000); }
    closeSync(this.keys);
    writeFileSync(join(this.folder, 'pids.json'), JSON.stringify([...this.identities].map(([pid, started]) => ({ pid, started }))));
  }

}

/** The composer scrolls horizontally: its final words, not its hidden prefix, acknowledge input. */
export async function taskApproval(term) {
  if (/Build approves exactly this:/.test(term.text())) return;
  await term.press('n', /New task:[^\n]*Send[^\n]*Cancel[^\n]*\n[^\n]*╰/);
  term.send('Add a subtract(a, b) function next to add in src/math.js, with a test.');
  await term.wait(/New task:[^\n]*with a test\.[^\n]*Send[^\n]*Cancel/);
  const answer = await term.press('enter', FILING_ANSWER);
  if (/Refused: /.test(answer)) throw new Error(`Filing refused: ${answer}`);
}

/** Only confirm after the end of the terms and the actionable Build control were drawn. */
export async function confirmBuild(term) {
  let shown = await term.wait(/Build approves exactly this:[\s\S]*Esc files nothing\./);
  while (/more lines: j or Space/.test(shown)) {
    const remaining = /\d+ more lines: j or Space reads on/.exec(shown)?.[0];
    term.send(' ');
    await until(() => {
      const next = term.text();
      return /Esc files nothing\./.test(next) && !next.includes(remaining) && next;
    }, 'next approval terms');
    shown = term.text();
  }
  await term.wait(/Build approves exactly this:[\s\S]*Enter\s+Build[^\n]*\n[\s\S]*Esc files nothing\./);
  return term.press('enter', /Building it\.|Ready|Result/);
}

export async function retryAttempt(term, lastRun, taskId, waitFor = until) {
  const previous = lastRun();
  const shown = await term.press('r', / Retry [\s\S]*Retry: starts a new attempt[\s\S]*Enter\s+Retry it[\s\S]*Any other key cancels\./);
  await term.press('enter', /Retrying: a new attempt starts/);
  await waitFor(() => {
    const next = lastRun();
    return next?.id > previous.id && next.task_id === taskId && next;
  }, 'retry builder attempt started for the same task');
  return shown;
}

/** Back to the workbench's own screen between features: Esc out of any screen or dialog a feature left open (the
 * Agents screen, help, the palette, Settings, a composer), waiting on the screen fact each time, never a fixed sleep. */
const OVERLAY = /Esc\s+back|New task:|New thread:| Commands | Keys | Settings |Send back .*saying|Esc\s+cancel/;
async function toBase(term) {
  for (let tries = 0; tries < 4 && OVERLAY.test(term.text()); tries++) {
    const before = term.text();
    // The Agents screen closes on A as well as Esc; use it when that screen is the one showing.
    term.send(/check again\s+Esc\s+back/.test(before) && tries > 0 ? 'A' : esc);
    await until(() => term.text() !== before, 'the screen answered', 10_000).catch(() => {});
  }
  if (OVERLAY.test(term.text())) throw new Error('Could not return to the workbench screen between features');
}

async function exercise(feature, context) {
  const { world, term } = context;
  const wait = pattern => term.wait(pattern);
  const press = (key, pattern) => term.press(key, pattern);
  const normal = async () => { term.send(esc); await until(() => !/New task:|New thread:| Commands | Keys | Settings |Send back .*saying/.test(term.text()), 'dialog closed'); };
  const palette = async label => { await press(':', /Commands/); term.send(label); await wait(new RegExp(label.split(' ')[0], 'i')); await press('enter', /Toolroll/); };
  const viewFile = join(world.env.XDG_STATE_HOME, 'toolroll/view.json');
  const view = () => { try { return JSON.parse(readFileSync(viewFile, 'utf8')); } catch { return null; } };
  const sql = query => readConsole(world, query);
  const task = () => sql('SELECT id, state FROM task ORDER BY rowid DESC LIMIT 1')[0];
  const lastRun = () => sql("SELECT r.id, ref.external_id AS task_id, r.outcome, r.reason, r.finished_at FROM run r JOIN task_ref ref ON ref.id=r.task_ref WHERE r.role='builder' ORDER BY r.id DESC LIMIT 1")[0];
  const projectView = () => Object.values(view()?.projects ?? {})[0];
  const stableView = () => { const v = structuredClone(view()); for (const project of Object.values(v?.projects ?? {})) delete project.at; return v; };
  const approval = async () => {
    if (context.built) return;
    await taskApproval(term);
  };
  const build = async () => {
    if (context.built) return;
    const previousTask = task()?.id;
    await approval();
    // Like tui-e2e: Just code may file directly; only a terms card needs Build.
    if (/Build approves exactly this:/.test(term.text())) await confirmBuild(term);
    await until(() => task() && task().id !== previousTask, 'new task saved'); context.task = task().id;
    await until(() => lastRun()?.task_id === context.task && lastRun(), 'builder run appeared for the filed task');
    context.built = true;
  };
  const ready = async () => {
    if (context.finished) { context.built = false; context.finished = false; }
    await build(); await until(() => lastRun()?.finished_at && ['built', 'no-change'].includes(lastRun()?.outcome), 'scripted build result');
    await wait(/Ready|Result/); await press('enter', /src\/math.js|test\/math.test.js/); context.task = task().id;
  };
  const failed = async () => {
    await build(); await until(() => lastRun()?.finished_at && lastRun()?.outcome === 'failed', 'failed provider run');
    const tab = world.scenario === 'agent-error' ? 'live' : 'steps';
    while (projectView()?.tab !== tab) {
      const before = projectView()?.tab;
      term.send('\t'); await until(() => projectView()?.tab !== before, 'failure tab changed');
    }
    const expected = world.scenario === 'agent-error' ? 'agent-error' : 'provider-init';
    if (!lastRun().reason?.includes(expected)) throw new Error(`Expected ${expected}, got ${lastRun().reason}`);
  };
  let shown, state;
  switch (feature.id) {
    case 'welcome': case 'narrow': shown = await wait(new RegExp(feature.expected)); state = `${term.cols} columns`; break;
    case 'new-task': shown = await press('n', /New task:/); await normal(); break;
    case 'agents': case 'signed-out': shown = await press('A', new RegExp(feature.expected)); await normal(); break;
    case 'palette': shown = await press(':', /Commands/); await normal(); break;
    case 'help': shown = await press('?', /Press s for settings/); await normal(); break;
    case 'settings': await press('?', /Press s for settings/); shown = await press('s', / Settings /); await normal(); break;
    case 'approval': await approval(); shown = term.text(); break;
    case 'approval-fold': {
      await approval();
      while (!/f shows all/.test(term.text()) && /more lines: j or Space/.test(term.text())) {
        const before = term.text(); term.send(' '); await until(() => term.text() !== before, 'read to Usual settings');
      }
      await wait(/f shows all/); term.send('f'); await until(() => !/f shows all/.test(term.text()), 'unfold Usual');
      shown = term.text(); term.send('f'); await wait(/f shows all/); break;
    }
    case 'build': await build(); shown = term.text(); break;
    case 'result': await ready(); shown = term.text(); break;
    case 'search': await ready(); shown = await press('/', /Search:/); term.send('subtract'); await wait(/subtract/); term.send('\r'); await normal(); break;
    case 'export': await ready(); term.send('\x05'); await until(() => existsSync(join(world.root, 'editor.txt')) && /subtract/.test(readFileSync(join(world.root, 'editor.txt'), 'utf8')), 'editor export'); shown = term.text(); state = 'editor contains subtract'; break;
    case 'take-over': await ready(); shown = await press('t', / Take over /); await press('t', /back to the workbench/); term.send('printf \"VERIFY_TERMINAL_OK\\n\"\r'); await wait(/VERIFY_TERMINAL_OK/); term.send('\x1d'); await wait(/Toolroll/); break;
    case 'send-back': await ready(); await press('r', /Send back/); term.send('Please add a test for negative numbers.'); shown = await press('enter', /Build #.*goes back/); await press('enter', /Sent back\. The revision is filed\./); context.built = true; await until(() => task().id !== context.task, 'revision task saved'); context.task = task().id; break;
    case 'accept': await ready(); shown = await press('a', /Accept the result of/); await press('enter', /Marked complete\.|Accepted\./); await until(() => task()?.state === 'done', 'task completion'); context.finished = true; break;
    case 'agent-error':
      await failed();
      shown = await wait(new RegExp(`The agent stopped with an error\\.[\\s\\S]*What the agent said[\\s\\S]*${MARKER}`));
      break;
    case 'never-initialized': case 'retry-wait': await failed(); shown = await wait(new RegExp(feature.expected)); break;
    case 'stop-resume': await failed(); await press('x', /Stop retrying this task\?/); await press('enter', /Stopped retrying|Resume retrying/); shown = await press('x', /Resume retrying this task\?/); await press('enter', /Resumed|[Rr]etrying/); break;
    case 'retry': await failed(); await wait(/The agent stopped with an error\.[\s\S]*What the agent said/); shown = await retryAttempt(term, lastRun, context.task); break;
    case 'cancel': await failed(); shown = await press('X', /Cancel/); await press('enter', /[Cc]ancelled|[Cc]anceled/); break;
    case 'threads': shown = await press('T', /New thread:/); term.send('Review the subtraction change.'); await press('enter', /The thread started\./); break;
    case 'task-show': await ready(); shown = run(world, process.execPath, [context.cli, 'task', 'show', context.task]); if (!shown.includes(context.task)) throw new Error('task show did not identify the selected task'); break;
    case 'restore': {
      const before = JSON.stringify(stableView()); term.send('L');
      await until(() => JSON.stringify(stableView()) !== before, 'changed layout saved');
      const saved = stableView(); await term.quit(); await context.relaunch();
      shown = await context.term.wait(/Toolroll/);
      const restored = () => { try { const v = JSON.parse(readFileSync(viewFile, 'utf8')); for (const p of Object.values(v.projects)) delete p.at; return v; } catch { return null; } };
      if (JSON.stringify(restored()) !== JSON.stringify(saved)) throw new Error('Relaunch changed saved selection or layout');
      // Quit forces a fresh write from the actual restored app state, rather than merely reading the old file.
      await context.term.quit();
      if (JSON.stringify(restored()) !== JSON.stringify(saved)) throw new Error('Relaunch failed to restore selection or layout');
      await context.relaunch(); state = 'selection and layout restored after relaunch'; break;
    }
    case 'jumps': {
      await ready();
      await press('T', /New thread:/); term.send('Review the subtraction change.'); await press('enter', /The thread started\./);
      await until(() => projectView()?.task && projectView().task !== context.task, 'thread selected');
      const origin = projectView().task;
      term.send('!'); await until(() => projectView()?.task === context.task, 'next needs-you selects result');
      term.send('@'); await wait(/waiting on you/);
      term.send("'"); await until(() => projectView()?.task === origin, 'jump returns to thread');
      shown = term.text(); state = 'jump returned to original thread'; break;
    }
    case 'unread': {
      // A second task gives the first result a stable place to leave from. No timed provider delays.
      context.built = false; await build();
      await press('T', /New thread:/); term.send('Review the second subtraction change.'); await press('enter', /The thread started\./);
      await until(() => projectView()?.unread?.includes(context.task), 'task became unread while another thread was selected');
      shown = await wait(/[●•·]/); term.send('!');
      await until(() => projectView()?.task === context.task && !projectView()?.unread?.includes(context.task), 'visiting task clears unread dot');
      state = 'unread task id saved then cleared on visit'; break;
    }
    default: {
      const action = feature.actions[0]; const before = JSON.stringify(stableView()), screenBefore = term.text();
      if (feature.keys.length) term.send(keyBytes[feature.keys[0]] ?? feature.keys[0]);
      else await palette('Move the list to the other side');
      await until(() => action === 'zoom' ? term.text() !== screenBefore : JSON.stringify(stableView()) !== before, `${action} changed the view`);
      shown = await wait(new RegExp(feature.expected)); state = 'saved view changed';
    }
  }
  if (!new RegExp(feature.expected).test(shown)) throw new Error(`Expected ${feature.expected}`);
  return { excerpt: shown, ...(state ? { state } : {}) };
}

export async function verify(options) {
  validateMap(featureMap, readFileSync(join(repo, featureMap.keymap), 'utf8'));
  const selected = featureMap.features.filter(f => (!options.scenarios.length || options.scenarios.includes(f.scenario)) && (!options.features.length || options.features.includes(f.id)));
  if (!selected.length) throw new Error('No features selected');
  const out = options.out ?? join(repo, 'evidence', `verify-${Date.now()}-${process.pid}`);
  if (relative(join(repo, 'evidence'), out).startsWith('..') && !relative(repo, out).startsWith('..')) throw new Error('--out inside the checkout must be under evidence/');
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length) throw new Error('--out must be empty');
  const report = { version: 1, source: options.tarball ?? 'built checkout', startedAt: new Date().toISOString(), features: [], sessions: [], png: 'No existing terminal PNG renderer; screen text retained.' };
  // Short root: macOS Unix socket paths have a small ceiling. Evidence survives root removal.
  const root = mkdtempSync('/tmp/trv-');
  report.keptRoot = options.keep ? root : null;
  const terms = [];
  let interrupted = null;
  const abort = signal => { interrupted = signal; for (const term of terms) { term.aborted = signal; } };
  const sigint = () => abort('SIGINT'), sigterm = () => abort('SIGTERM');
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  try {
    for (const scenario of [...new Set(selected.map(f => f.scenario))]) {
      const session = { scenario, timings: {}, outbound: { status: 'FAIL' } }; report.sessions.push(session);
      const features = selected.filter(f => f.scenario === scenario);
      let world, context;
      try {
        if (interrupted) throw new Error(interrupted);
        world = createWorld(join(root, scenario), scenario);
        session.preflight = assertAgentStandIns(world);
        git(world, world.shop, ['init', '-q', '-b', 'main']); git(world, world.shop, ['add', '--', 'src/math.js', 'package.json']); git(world, world.shop, ['commit', '-qm', 'Verification fixture']);
        let cli = join(repo, 'dist/bin.js'), binary = join(repo, 'tui/target/release/toolroll-tui');
        if (options.tarball) {
          run(world, 'npm', ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', options.tarball], { timeout: 300_000 });
          cli = join(world.prefix, 'lib/node_modules/toolroll/dist/bin.js'); binary = null;
          if (!existsSync(join(dirname(cli), 'tui', `${process.platform}-${process.arch}`, 'toolroll-tui'))) throw new Error('Tarball has no bundled workbench for this platform');
        }
        // A checkout whose workbench is bundled into dist/tui (as CI's bundle job and npm pack do) needs no developer
        // build: the launcher finds the bundled binary exactly as an installed package would.
        const bundled = join(repo, 'dist/tui', `${process.platform}-${process.arch}`, 'toolroll-tui');
        if (binary && !existsSync(binary) && existsSync(bundled)) binary = null;
        if (!existsSync(cli) || (binary && !existsSync(binary))) throw new Error('Build the checkout and workbench (cargo build --release, or tui-build --bundle) before verification');
        const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
        session.candidate = { cliSha256: hash(cli), workbenchSha256: hash(binary ?? join(dirname(cli), 'tui', `${process.platform}-${process.arch}`, 'toolroll-tui')),
          ...(options.tarball ? { tarballSha256: hash(options.tarball) } : {}) };
        const port = await freePort(); let launches = 0;
        context = { world, cli, relaunch: async () => {
          if (interrupted) throw new Error(interrupted);
          const term = new Terminal(world, cli, binary, port, join(root, scenario, `terminal-${launches++}`), scenario === 'narrow' ? 60 : 140);
          context.term = term; terms.push(term);
          await term.wait(/Toolroll/); await term.wait(/What would you like|Needs you|Working|Nothing yet/);
          term.recordPids(); if (!session.timings.workbenchMs) session.timings = { firstTextMs: term.firstTextMs, workbenchMs: Date.now() - term.started };
        } };
        await context.relaunch();
        for (const feature of features) {
          const start = Date.now();
          try {
            if (interrupted) throw new Error(interrupted);
            if (features.indexOf(feature) > 0) await toBase(context.term);
            const evidence = await exercise(feature, context);
            report.features.push({ id: feature.id, scenario, status: 'PASS', elapsedMs: Date.now() - start, ...evidence });
          } catch (error) {
            report.features.push({ id: feature.id, scenario, status: 'FAIL', elapsedMs: Date.now() - start, excerpt: context.term.screen.text(), error: error.message });
            // Preserve truthful failures without typing dependent actions into an unknown dialog.
            for (const pending of features.slice(features.indexOf(feature) + 1)) report.features.push({ id: pending.id, scenario, status: 'FAIL', excerpt: '', error: `Prerequisite failed: ${feature.id}` });
            break;
          }
        }
        await context.term.quit();
      } catch (error) {
        session.error = error.message;
        for (const f of features) if (!report.features.some(r => r.id === f.id)) report.features.push({ id: f.id, scenario, status: 'FAIL', excerpt: '', error: error.message });
      } finally {
        for (const term of terms.filter(t => t.world === world)) {
          try { await term.cleanup(); } catch (error) { session.cleanupError = error.message; }
          session.steps = [...(session.steps ?? []), ...term.steps];
          const folder = join(out, `${scenario}-${terms.indexOf(term)}`); mkdirSync(folder);
          for (const name of ['screen.log', 'pids.json', 'host.log']) if (existsSync(join(term.folder, name))) writeFileSync(join(folder, name), readFileSync(join(term.folder, name)));
        }
        try { session.outbound = checkOutbound(world); } catch (error) { session.outbound = { status: 'FAIL', error: error.message }; }
      }
    }
  } finally {
    process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
    if (report.sessions.some(s => s.cleanupError)) report.keptRoot = root;
    finishReport(report);
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(out, 'report.md'), reportMarkdown(report));
    writeFileSync(join(out, 'screens.txt'), report.features.map(f => `===== ${f.id}: ${f.status} =====\n${f.excerpt}\n`).join('\n'));
    if (!options.keep && !report.sessions.some(s => s.cleanupError)) rmSync(root, { recursive: true, force: true });
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await verify(parseArgs(process.argv.slice(2))); console.log(`${report.ok ? 'PASS' : 'FAIL'}: ${report.features.length} features`); process.exitCode = report.ok ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
