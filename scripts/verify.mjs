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
import { MARKER, SCENARIOS, WORLD_NEEDS, prepareWorld, redactPasswords, saveStandInSignIn, assertAgentStandIns, checkedEnv, checkNoModelCalls, checkOutbound, createWorld, git, readConsole, run } from './verify-world.mjs';

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
    if (entry.needs !== undefined && (!Array.isArray(entry.needs) || entry.needs.some(need => !WORLD_NEEDS.includes(need)))) {
      throw new Error(`Invalid world needs for ${entry.id}`);
    }
    for (const action of entry.actions) {
      if (!actions.has(action)) throw new Error(`Unknown action: ${action}`);
      covered.add(action);
    }
    for (const key of entry.keys) {
      if (!entry.actions.some(action => actions.get(action).keys.includes(key))) throw new Error(`Unknown key ${key} for ${entry.id}`);
    }
    for (const key of entry.dialogKeys ?? []) if (!map.dialogKeys[key]) throw new Error(`Undeclared dialog key: ${key}`);
  }
  const checked = new Set(), visiting = new Set();
  const visit = entry => {
    if (visiting.has(entry.id)) throw new Error(`Cyclic dependency: ${entry.id}`);
    if (checked.has(entry.id)) return;
    visiting.add(entry.id);
    for (const id of entry.dependsOn ?? []) {
      const dependency = map.features.find(f => f.id === id);
      if (!dependency || dependency.scenario !== entry.scenario) throw new Error(`Invalid dependency ${id} for ${entry.id}`);
      visit(dependency);
    }
    visiting.delete(entry.id); checked.add(entry.id);
  };
  for (const entry of map.features) visit(entry);
  for (const entry of map.intentionallyUnmapped) {
    const spec = actions.get(entry.action);
    if (!spec || !entry.reason || covered.has(entry.action)) throw new Error(`Invalid unmapped action: ${entry.action}`);
    if (JSON.stringify(spec.keys) !== JSON.stringify(entry.keys)) throw new Error(`Unmapped keys drifted: ${entry.action}`);
    covered.add(entry.action);
  }
  for (const spec of specs) if (!covered.has(spec.action)) throw new Error(`Unmapped keymap action: ${spec.action}`);
  return true;
}
/** Include needs of prerequisites that run even when their own feature is not selected. */
export function selectedNeeds(selected, map = featureMap) {
  const needs = new Set(), visited = new Set();
  const visit = feature => {
    if (visited.has(feature.id)) return;
    visited.add(feature.id);
    for (const need of feature.needs ?? []) needs.add(need);
    for (const id of feature.dependsOn ?? []) visit(map.features.find(f => f.id === id));
  };
  for (const feature of selected) visit(feature);
  return [...needs];
}
export function parseArgs(args) {
  const options = { scenarios: [], features: [], keep: false, help: false, tarball: null, out: null };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--help' || name === '-h') { options.help = true; continue; }
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
export function usage() {
  return `Usage: node scripts/verify.mjs [options]

  --help, -h          Show this help without starting verification
  --scenario <name>   Select a scenario (repeatable)
  --features <ids>    Select comma-separated feature ids (repeatable)
  --tarball <path>    Install and verify this package with scripts disabled
  --out <folder>      Write evidence to an empty folder (in-repo: evidence/)
  --keep              Retain the temporary world after stopping its processes

Scenarios: ${SCENARIOS.join(', ')}
Features by scenario:
${SCENARIOS.map(s => `  ${s}: ${featureMap.features.filter(f => f.scenario === s).map(f => f.id).join(', ')}`).join('\n')}

No selectors runs every feature. Both selectors run their intersection.
Dependencies run as needed; only selected features receive verdicts.
Example: node scripts/verify.mjs --features welcome,new-task,help
`;
}
export function reportSummary(report) {
  const failed = report.features.filter(f => f.status !== 'PASS');
  return `PASS ${report.features.length - failed.length} · FAIL ${failed.length} of ${report.features.length}`
    + (failed.length ? `\nFailing ids: ${failed.map(f => f.id).join(', ')}` : '');
}
export const expectedFailureReason = scenario => scenario === 'agent-error' ? 'agent-error' : 'retryable-infra';

/** Run declared prerequisites once, but never let one failure suppress independent checks. */
export async function runFeatures(selected, map, context, exerciseFeature = exercise, reset = toBase) {
  const results = new Map();
  const visit = async feature => {
    if (results.has(feature.id)) return results.get(feature.id);
    const start = Date.now();
    let result;
    for (const id of feature.dependsOn ?? []) {
      const prerequisite = await visit(map.features.find(f => f.id === id));
      if (prerequisite.status !== 'PASS') {
        result = { status: 'FAIL', excerpt: '', error: `Prerequisite failed: ${id}` };
        break;
      }
    }
    if (!result) try {
      await reset(context.term, context.world);
      result = { status: 'PASS', ...await exerciseFeature(feature, context) };
    } catch (error) {
      result = { status: 'FAIL', excerpt: context.term.screen.text(), error: error.message };
    }
    result = { id: feature.id, scenario: feature.scenario, elapsedMs: Date.now() - start, ...result };
    results.set(feature.id, result);
    return result;
  };
  for (const feature of selected) await visit(feature);
  return selected.map(f => results.get(f.id));
}
export function finishReport(report) {
  report.ok = report.sessions.length > 0 && report.features.length > 0 && report.features.every(f => f.status === 'PASS')
    && report.sessions.every(s => s.outbound?.status === 'PASS' && s.modelCalls?.status !== 'FAIL' && !s.error && !s.cleanupError);
  return report;
}
export function reportMarkdown(report) {
  return `# Runtime verification\n\n${reportSummary(report)}\n\nOverall: ${report.ok ? 'PASS' : 'FAIL'}\n\n`
    + report.sessions.map(s => `- ${s.scenario}: first text ${s.timings.firstTextMs ?? 'unseen'} ms; workbench ${s.timings.workbenchMs ?? 'unseen'} ms; outbound ${s.outbound?.status ?? 'FAIL'}; model calls ${s.modelCalls?.relayCalls ?? s.modelCalls?.status ?? 'unchecked'}${s.error ? `; ${s.error}` : ''}${s.cleanupError ? `; cleanup: ${s.cleanupError}` : ''}`).join('\n') + '\n\n'
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
/** The workbench's fatal dialog (view.rs): any key closes it and the workbench with it, so q never asks to quit. */
const FATAL = /Press any key to close\./;
export function fatalWords(text) {
  const box = /╭ Toolroll ─[^\n]*\n([\s\S]*?)Press any key to close\./.exec(text)?.[1] ?? '';
  return box.split('\n').map(line => { const a = line.indexOf('│'), b = line.lastIndexOf('│'); return a >= 0 && b > a ? line.slice(a + 1, b).trim() : ''; })
    .filter(Boolean).join(' ') || 'its words could not be read';
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function freePort() {
  const port = await new Promise((done, fail) => { const server = createServer(); server.once('error', fail); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)); }); });
  return port === 4180 ? freePort() : port;
}
class Terminal {
  constructor(world, cli, binary, port, folder, cols, args = null) {
    Object.assign(this, { world, cli, binary, port, folder, cols, offset: 0, raw: '', answered: 0, started: Date.now(), steps: [], pids: new Set(), identities: new Map(), decoder: new StringDecoder('utf8'), screen: new Screen(40, cols) });
    mkdirSync(folder, { recursive: true });
    this.fifo = join(folder, 'keys'); this.log = join(folder, 'screen.log'); this.pidFile = join(folder, 'pid');
    run(world, 'mkfifo', [this.fifo]);
    this.keys = openSync(this.fifo, constants.O_RDWR);
    this.exitFile = join(folder, 'exit-status');
    const command = ['python3', join(repo, 'scripts/fixtures/pty-host.py'), '40', String(cols), this.fifo, this.log, this.pidFile,
      process.execPath, cli, ...(args ?? ['--port', String(port), ...(binary ? ['--tui-binary', binary] : [])])].map(word).join(' ');
    // Orphan the host, as tui-e2e does: a person's terminal has no coding agent ancestor.
    this.hostPidFile = join(folder, 'host-pid');
    const hosted = `${command} > ${word(join(folder, 'host.log'))} 2>&1 < /dev/null`;
    const background = args === null ? hosted : `(${hosted}; printf '%s' "$?" > ${word(this.exitFile)})`;
    this.launcher = spawn(join(world.tools, 'sh'), ['-c', `${background} & printf '%s' "$!" > ${word(this.hostPidFile)}`],
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
    return redactPasswords(this.screen.text(), this.world.secrets);
  }
  send(text) { writeSync(this.keys, text); }
  async wait(pattern) {
    const shown = await until(() => {
      const text = this.text();
      if (pattern.test(text)) return text;
      if (existsSync(this.exitFile)) throw new Error(`Terminal exited before ${pattern}: ${text}`);
      // A fatal dialog ends the workbench on the next key: nothing waited for can come, so say what it said now.
      if (FATAL.test(text)) throw new Error(`The workbench stopped with an error before ${pattern}: ${fatalWords(text)}`);
      return false;
    }, `screen ${pattern}`);
    this.steps.push({ expected: pattern.source, atMs: Date.now() - this.started, screen: shown });
    return shown;
  }
  async press(key, pattern) { this.send(keyBytes[key] ?? key); return this.wait(pattern); }
  async quit() {
    this.recordPids();
    if (FATAL.test(this.text())) throw new Error(`The workbench stopped with an error: ${fatalWords(this.text())}`);
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

/** Same orphaned PTY host, isolation checks and recorded-process cleanup as the workbench. */
async function runCliInTerminal(world, cli, args, answers, folder, terms) {
  const term = new Terminal(world, cli, null, null, folder, 140, args);
  terms.push(term); // Also cleaned up on interruption or a failed prompt.
  for (const { prompt, answer } of answers) {
    await term.wait(prompt);
    term.recordPids();
    term.send(answer + '\r');
  }
  await until(() => {
    term.text();
    return existsSync(term.exitFile);
  }, 'CLI PTY exit');
  const code = readFileSync(term.exitFile, 'utf8');
  if (code !== '0') throw new Error(`Preparation CLI exited ${code}: ${term.text()}`);
}

/** The composer scrolls horizontally: its final words, not its hidden prefix, acknowledge input. */
export const TASK_TEXT = 'Add a subtract(a, b) function next to add in src/math.js, with a test.';
/** A second, separately named task (its list row reads differently): the scripted provider writes the same change. */
export const FRESH_TASK_TEXT = 'Add a multiply(a, b) function next to add in src/math.js, with a test.';
export const UNREAD_TASK_TEXT = 'Add a divide(a, b) function next to add in src/math.js, with a test.';
export async function taskApproval(term, text = TASK_TEXT) {
  if (/Build approves exactly this:/.test(term.text())) return;
  await term.press('n', /New task:[^\n]*Send[^\n]*Cancel[^\n]*\n[^\n]*╰/);
  term.send(text);
  await term.wait(/New task:[^\n]*with a test\.[^\n]*Send[^\n]*Cancel/);
  const answer = await term.press('enter', FILING_ANSWER);
  // The filing's own answer: a terms card or "Filed." is no refusal, whatever an older status line still says.
  if (!/Build approves exactly this:|Filed\. /.test(answer)) throw new Error(`Filing refused: ${/Refused: [^\n]*/.exec(answer)?.[0] ?? answer}`);
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

/** A thread starts only after its terms card was read to the end (thread.rs start_key): read on, then Enter. */
/** A dialog's own words, as one line: on each screen line, only what sits between its first and last border (the list
 * beside it is left out), wrapped lines joined. */
export function dialogText(screen) {
  return screen.split('\n').map(line => { const first = line.indexOf('│'), last = line.lastIndexOf('│'); return first >= 0 && last > first ? line.slice(first + 1, last) : ''; })
    .join(' ').replace(/\s+/g, ' ');
}
export async function startThread(term, message, card = null) {
  await term.press('T', /New thread:/);
  term.send(message);
  await term.wait(new RegExp(`New thread:[^\\n]*${message.split(' ').slice(-2).join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // With a card to check, an earlier refusal may still be on the status line: only the card (or a start) answers.
  let shown = await term.press('enter', card === null ? /The thread started\.|already started\.|Starting this thread agrees to exactly this:|Refused: / : /The thread started\.|already started\.|Starting this thread agrees to exactly this:/);
  let read = shown;
  while (/Starting this thread agrees to exactly this:/.test(shown) && !/Enter\s+Start the thread/.test(shown)) {
    const remaining = /\d+ more lines: j or Space reads on/.exec(shown)?.[0];
    if (!remaining) throw new Error('The thread terms card shows neither more lines nor its Start control');
    term.send(' ');
    shown = await until(() => { const next = term.text(); return !next.includes(remaining) && next; }, 'the thread terms read on');
    read += shown;
  }
  // What the card must have said, somewhere in it, before the yes.
  if (card !== null && /Starting this thread agrees to exactly this:/.test(read) && !card.test(dialogText(read))) throw new Error(`The thread terms card never said ${card}`);
  if (/Starting this thread agrees to exactly this:/.test(shown)) shown = await term.press('enter', /The thread started\.|already started\.|Refused: /);
  // The same message under the same terms is the same start: it answers that it already started, and starts nothing.
  if (!/The thread started\./.test(shown)) throw new Error(`No thread started: ${/Refused: [^\n]*|[^\n]*already started\./.exec(shown)?.[0]}`);
  return shown;
}

/** Whether this workbench approves a sent-back revision (its Accept also approves a plan: keys.rs, branch revision-approve). */
export function revisionApproval(source = readFileSync(join(repo, featureMap.keymap), 'utf8')) {
  return /Accept = "accept", \w+, \w+, "[^"]*approve[^"]*"/.test(source);
}

/** Back to the workbench's own screen between features: Esc out of any screen or dialog a feature left open (the
 * Agents screen, help, the palette, Settings, a composer), waiting on the screen fact each time, never a fixed sleep. */
const OVERLAY = /Search: |Esc\s+back|New task:|New thread:|Before a thread can start| Commands | Keys | Settings |Send back .*saying|Esc\s+cancel|Build approves exactly this:|Any other key cancels|Esc starts nothing\./;
async function toBase(term, world = null) {
  if (FATAL.test(term.text())) throw new Error(`The workbench stopped with an error: ${fatalWords(term.text())}`);
  for (let tries = 0; tries < 4 && OVERLAY.test(term.text()); tries++) {
    const before = term.text();
    // The Agents screen closes on A as well as Esc; use it when that screen is the one showing.
    term.send(/check again\s+Esc\s+back/.test(before) && tries > 0 ? 'A' : esc);
    await until(() => term.text() !== before, 'the screen answered', 10_000).catch(() => {});
  }
  if (OVERLAY.test(term.text())) throw new Error('Could not return to the workbench screen between features');
  // Every feature starts on the Live tab: the Diff review keeps its own keys (Esc and n stay there).
  if (!world) return;
  const tab = () => { try { return Object.values(JSON.parse(readFileSync(join(world.env.XDG_STATE_HOME, 'toolroll/view.json'), 'utf8')).projects ?? {})[0]?.tab; } catch { return undefined; } };
  for (let presses = 0; tab() !== undefined && tab() !== 'live'; presses++) {
    if (presses >= 6) throw new Error('The Live tab never came back into focus between features');
    const before = tab();
    term.send('\t'); await until(() => tab() !== before, 'the tab moved', 10_000);
  }
}

async function exercise(feature, context) {
  const { world, term } = context;
  // Every wait here also ends at a fatal dialog, with its words: nothing waited for comes after one.
  const seen = (fact, description) => until(() => {
    const text = term.text();
    if (FATAL.test(text)) throw new Error(`The workbench stopped with an error while waiting for ${description}: ${fatalWords(text)}`);
    return fact();
  }, description);
  const wait = pattern => term.wait(pattern);
  const press = (key, pattern) => term.press(key, pattern);
  const normal = async () => { term.send(esc); await seen(() => !/New task:|New thread:| Commands | Keys | Settings |Send back .*saying/.test(term.text()), 'dialog closed'); };
  // Enter picks the palette's top match only once the whole query was echoed on its line (": <query>▏").
  const palette = async label => {
    await press(':', / Commands /); term.send(label);
    await wait(new RegExp(`: ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}▏`));
    term.send('\r'); await seen(() => !/ Commands /.test(term.text()), 'the palette closed');
  };
  /** Open a task or thread by its title's first words, as a person finds it in the palette, and wait for its selection. */
  const open = async (title, id) => {
    if (projectView()?.task === id) return;
    await palette(title.split(' ').slice(0, 3).join(' '));
    await seen(() => projectView()?.task === id, `${title.split(' ').slice(0, 3).join(' ')} selected`);
  };
  const newestThread = () => sql('SELECT id FROM flexible_thread ORDER BY rowid DESC LIMIT 1')[0]?.id;
  const viewFile = join(world.env.XDG_STATE_HOME, 'toolroll/view.json');
  const view = () => { try { return JSON.parse(readFileSync(viewFile, 'utf8')); } catch { return null; } };
  const sql = query => readConsole(world, query);
  const task = () => sql('SELECT id, state FROM task ORDER BY rowid DESC LIMIT 1')[0];
  const lastRun = () => sql("SELECT r.id, ref.external_id AS task_id, r.outcome, r.reason, r.finished_at FROM run r JOIN task_ref ref ON ref.id=r.task_ref WHERE r.role='builder' ORDER BY r.id DESC LIMIT 1")[0];
  /** The newest builder run of one task (another task's run may be newer). */
  const runOf = id => sql(`SELECT r.id, r.outcome, r.finished_at FROM run r JOIN task_ref ref ON ref.id=r.task_ref WHERE r.role='builder' AND ref.external_id='${id}' ORDER BY r.id DESC LIMIT 1`)[0];
  const projectView = () => Object.values(view()?.projects ?? {})[0];
  const stableView = () => { const v = structuredClone(view()); for (const project of Object.values(v?.projects ?? {})) delete project.at; return v; };
  const approval = async (text = TASK_TEXT) => {
    if (context.built) return;
    await taskApproval(term, text);
  };
  const build = async (text = TASK_TEXT) => {
    if (context.built) return;
    const previousTask = task()?.id;
    await approval(text);
    // Like tui-e2e: Just code may file directly; only a terms card needs Build.
    if (/Build approves exactly this:/.test(term.text())) await confirmBuild(term);
    await seen(() => task() && task().id !== previousTask, 'new task saved'); context.task = task().id;
    await seen(() => runOf(context.task), 'builder run appeared for the filed task');
    context.built = true;
  };
  const focusTab = async name => {
    for (let presses = 0; projectView()?.tab !== name; presses++) {
      if (presses >= 6) throw new Error(`The ${name} tab never came into focus`);
      const before = projectView()?.tab;
      term.send('\t'); await seen(() => projectView()?.tab !== before, `the tab moved toward ${name}`);
    }
  };
  const ready = async (text = TASK_TEXT) => {
    if (context.finished) { context.built = false; context.finished = false; }
    await build(text);
    await seen(() => runOf(context.task)?.finished_at && ['built', 'no-change'].includes(runOf(context.task).outcome), 'scripted build result');
    // Enter opens the selected row: this task's, which a later feature may have moved away from.
    await open(text, context.task);
    // A finished run is not yet a result to review: until its build process is recorded as exited, the row still reads
    // Building and Enter opens Live (app.rs Action::Open opens Diff only for a review ask). The pipeline's "Ready" stage
    // is drawn on every row, and the title names src/math.js: wait for this task's own list row to read Result, as a
    // person would, then open it and wait for its change list.
    await wait(new RegExp(`●\\s+${text.slice(0, 14).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\sResult\\b`));
    await press('enter', /\d+ files?\s+\+\d+/);
    await seen(() => projectView()?.tab === 'diff', 'Enter opened the result on the Diff tab');
  };
  const failed = async () => {
    await build(); await seen(() => lastRun()?.finished_at && lastRun()?.outcome === 'failed', 'failed provider run');
    await focusTab(world.scenario === 'agent-error' ? 'live' : 'steps');
    const expected = expectedFailureReason(world.scenario);
    if (!lastRun().reason?.includes(expected)) throw new Error(`Expected ${expected}, got ${lastRun().reason}`);
  };
  let shown, state;
  switch (feature.id) {
    case 'welcome': case 'narrow': shown = await wait(new RegExp(feature.expected)); state = `${term.cols} columns`; break;
    case 'new-task': shown = await press('n', /New task:/); await normal(); break;
    case 'agents': case 'signed-out': {
      shown = await press('A', new RegExp(feature.expected));
      // The expected text names the Agents screen itself (the first-run screen also says "Agents" on its button), so
      // Esc here meets the open screen; wait for it to go.
      term.send(esc); await seen(() => !/check again\s+Esc\s+back/.test(term.text()), 'the Agents screen closed');
      break;
    }
    case 'palette': shown = await press(':', /Commands/); await normal(); break;
    case 'help': shown = await press('?', /Press s for settings/); await normal(); break;
    case 'settings': await press('?', /Press s for settings/); shown = await press('s', / Settings /); await normal(); break;
    case 'approval': await approval(); shown = term.text(); break;
    case 'approval-fold': {
      await approval();
      while (!/f shows all/.test(term.text()) && /more lines: j or Space/.test(term.text())) {
        const before = term.text(); term.send(' '); await seen(() => term.text() !== before, 'read to Usual settings');
      }
      await wait(/f shows all/); term.send('f'); await seen(() => !/f shows all/.test(term.text()), 'unfold Usual');
      shown = term.text(); term.send('f'); await wait(/f shows all/); break;
    }
    case 'build': await build(); shown = term.text(); break;
    case 'result': await ready(); shown = term.text(); break;
    case 'search': {
      // The result's own text says subtract: wait for the search line's echo and count, never the pane, at each step.
      // Esc sent right before another key reads as Alt-<key>, so each key waits for its own effect first.
      await ready(); await press('/', /Search: ▏/); term.send('subtract');
      shown = await wait(/Search: subtract▏\s+\d+ of \d+/);
      await press('enter', /Search: subtract\s+\d+ of \d+\s+n next/);
      term.send(esc); await seen(() => !/Search: /.test(term.text()), 'search closed'); break;
    }
    case 'export': {
      await ready();
      // Multiple visible panes do not imply the Diff is focused. A single panel and an acknowledged Diff tab do.
      await palette('Focused: one panel');
      for (let presses = 0; projectView()?.tab !== 'diff'; presses++) {
        if (presses >= 6) throw new Error('The Diff tab never came into focus');
        const before = projectView()?.tab;
        term.send('\t'); await seen(() => projectView()?.tab !== before, 'export tab changed');
      }
      await wait(/src\/math.js|test\/math.test.js/);
      const output = join(world.root, 'editor.txt');
      rmSync(output, { force: true });
      term.send('\x05');
      await seen(() => {
        if (/Nothing here to open in an editor/.test(term.text())) throw new Error('Focused pane refused editor export');
        return existsSync(output) && /subtract/.test(readFileSync(output, 'utf8'));
      }, 'editor export output file');
      // The editor runs with the workbench's screen handed over: a key sent before it is back goes to the editor.
      shown = await wait(/Back from your editor/); state = 'editor contains subtract';
      // Leave the Live tab focused again, as every later feature expects (n does not open the composer from Diff).
      for (let presses = 0; projectView()?.tab !== 'live'; presses++) {
        if (presses >= 6) throw new Error('The Live tab never came back into focus');
        const before = projectView()?.tab;
        term.send('\t'); await seen(() => projectView()?.tab !== before, 'export tab restored');
      }
      break;
    }
    case 'take-over': await ready(); shown = await press('t', / Open build shell /); await press('t', /back to the workbench/); term.send('printf \"VERIFY_TERMINAL_OK\\n\"\r'); await wait(/VERIFY_TERMINAL_OK/); term.send('\x1d'); await wait(/Toolroll/); break;
    case 'send-back': {
      await ready(); await press('r', /Send back/); term.send('Please add a test for negative numbers.');
      shown = await press('enter', /Build #.*goes back/); await press('enter', /Sent back\. The revision is filed\./);
      const original = context.task;
      await seen(() => task().id !== original && task(), 'revision task saved'); context.task = task().id;
      // The task's row now stands for its family (the revision under the original's place, or beside it): with it still
      // selected, the workbench reads the revision's steps. Wait until it has (a fatal answer fails here).
      await seen(() => [original, context.task].includes(projectView()?.task), "the task's family is selected");
      await focusTab('steps');
      await seen(() => !/Reading…/.test(term.text()), "the revision's steps were read");
      // A sent-back revision waits for its person's yes. Approving it in the workbench is newer than some builds
      // (keys.rs: Accept also approves a plan); with it, approve exactly as a person would and wait for its build.
      if (revisionApproval()) {
        await focusTab('live'); await wait(/a\s+approve/);
        await press('a', /Approve exactly this:/);
        while (!/Enter\s+Approve/.test(term.text())) {
          const before = term.text(); term.send(' ');
          await seen(() => term.text() !== before, 'the approval terms read on');
        }
        await press('enter', /Approved\./);
        await seen(() => runOf(context.task)?.finished_at && ['built', 'no-change'].includes(runOf(context.task).outcome), 'the approved revision built');
        state = 'revision filed, approved and built';
      } else state = "revision filed; it waits for a person's approval, which this workbench doesn't offer yet";
      // Nothing later reuses the revision (accept takes a fresh task: the revision's requirement needs project checks).
      context.built = false; context.finished = false;
      break;
    }
    case 'accept': {
      // A fresh task's result: a revision's rewritten requirement needs the project's checks, which this world has none of.
      const kept = { task: context.task, built: context.built, finished: context.finished };
      try {
        context.built = false; context.finished = false;
        await ready(FRESH_TASK_TEXT);
        shown = await press('a', /Accept the result of/); await press('enter', /Marked complete\.|Accepted\./);
        await seen(() => sql(`SELECT state FROM task WHERE id='${context.task}'`)[0]?.state === 'done', 'the fresh task completed');
      } finally { Object.assign(context, kept); } // Later features keep working on the first result.
      break;
    }
    case 'agent-error':
      await failed();
      shown = await wait(new RegExp(`The agent stopped with an error\\.[\\s\\S]*What the agent said[\\s\\S]*${MARKER}`));
      break;
    case 'never-initialized': case 'retry-wait': await failed(); shown = await wait(new RegExp(feature.expected)); break;
    case 'stop-resume': await failed(); await press('x', /Stop retrying this task\?/); await press('enter', /Stopped retrying|Resume retrying/); shown = await press('x', /Resume retrying this task\?/); await press('enter', /Resumed|[Rr]etrying/); break;
    case 'retry': await failed(); await wait(/The agent stopped with an error\.[\s\S]*What the agent said/); shown = await retryAttempt(term, lastRun, context.task); break;
    case 'cancel': await failed(); shown = await press('X', /Cancel/); await press('enter', /[Cc]ancelled|[Cc]anceled/); break;
    case 'threads': {
      shown = await startThread(term, 'Review the subtraction change.');
      // The thread it started is selected (not the task that was selected before).
      await seen(() => newestThread() && projectView()?.task === newestThread(), 'the new thread selected');
      context.thread = newestThread();
      break;
    }
    case 'thread-reply': {
      // Reply in the thread `threads` started: once its first turn is over the row reads Ready, s opens the reply box,
      // and Enter sends the next message as turn 2.
      await open('Review the subtraction change.', context.thread);
      await wait(/Review the subtraction[^\n]*\sReady\b/);
      await press('s', /Reply:/);
      term.send('Now explain the change.');
      await wait(/Reply:[^\n]*explain the change\./);
      shown = await press('enter', /Sent\. Turn 2 started|Refused: /);
      if (!/Sent\. Turn 2 started/.test(shown)) throw new Error(`The reply was not sent: ${/Refused: [^\n]*/.exec(shown)?.[0]}`);
      await seen(() => sql(`SELECT COUNT(*) AS n FROM thread_turn WHERE thread = '${context.thread}' AND request_key LIKE 'reply:%'`)[0]?.n === 1, 'one reply turn on the record');
      break;
    }
    case 'thread-ship': {
      // a on the thread asks for its Ship terms. This world's project has no check command, so Toolroll says it can't
      // ship yet, in its own words (the whole press, laptop road and password road, is flexible-ship*.slow.test.ts).
      await open('Review the subtraction change.', context.thread);
      shown = await press('a', /Ship approves exactly this:|no check command|Refused: /);
      if (!/Ship approves exactly this:|no check command/.test(shown)) throw new Error(`Ship said neither its terms nor why: ${/Refused: [^\n]*/.exec(shown)?.[0]}`);
      if (/Ship approves exactly this:/.test(shown)) term.send(esc);
      if (sql("SELECT COUNT(*) AS n FROM flexible_ship")[0]?.n !== 0) throw new Error('Asking for the terms recorded a Ship');
      break;
    }
    case 'thread-end': {
      // X on the thread, asked first; y ends it for good: it moves to Recent as Ended and takes no reply.
      await open('Review the subtraction change.', context.thread);
      await press('X', /End this thread\?/);
      shown = await press('y', /Ended\.|This thread had already ended\.|Refused: /);
      if (!/Ended\./.test(shown)) throw new Error(`The thread did not end: ${/Refused: [^\n]*/.exec(shown)?.[0]}`);
      await wait(/Review the subtraction[^\n]*\sEnded\b/);
      await seen(() => sql(`SELECT ended_at FROM flexible_thread_meta WHERE thread = '${context.thread}'`)[0]?.ended_at, 'the end on the record');
      shown = await press('s', /This thread has ended/);
      break;
    }
    case 'threads-sign-in': {
      // Your own Claude sign-in for threads, end to end through the product: removed at a terminal; T then names the
      // missing step and its command; the command saves it at a terminal (hidden prompts); T again shows the card saying
      // whose plan powers it, and the thread starts. The world keeps a saved sign-in afterwards. It is the map's last
      // feature: the thread it starts would otherwise take one of the project's three live threads from a later one.
      await context.runCli(['config', 'clear', 'flexible-sign-in', '--as', world.owner], [{ prompt: /password:/, answer: world.password }]);
      await term.press('T', /New thread:/);
      const message = 'Check the sign-in, then review the subtraction change.';
      term.send(message);
      await term.wait(/New thread:[^\n]*subtraction change\./);
      const refused = await term.press('enter', /Before a thread can start/);
      if (!/claude setup-token/.test(refused.replace(/\s+/g, ' '))) throw new Error('The refusal did not name `claude setup-token`');
      if (!/copies the command/.test(refused)) throw new Error('The refusal offered no command to copy');
      term.send(esc);
      await until(() => !/Before a thread can start/.test(term.text()) && term.text(), 'the next-step dialog closed');
      await saveStandInSignIn(world, context.runCli);
      shown = await startThread(term, message, /powers only threads you start/);
      state = 'refused without a sign-in, saved through the CLI, then started on it';
      break;
    }
    case 'task-show': await ready(); shown = run(world, process.execPath, [context.cli, 'task', 'show', context.task]); if (!shown.includes(context.task)) throw new Error('task show did not identify the selected task'); break;
    case 'restore': {
      const before = JSON.stringify(stableView()); term.send('L');
      await seen(() => JSON.stringify(stableView()) !== before, 'changed layout saved');
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
      // A thread's start keeps the selection where it was (no thread id comes back): open it, as a person would.
      const message = 'Review the subtraction change, then jump.';
      await startThread(term, message);
      const origin = newestThread(); await open(message, origin);
      term.send('!'); await seen(() => projectView()?.task === context.task, 'next needs-you selects result');
      term.send('@'); await wait(/waiting on you/);
      term.send("'"); await seen(() => projectView()?.task === origin, 'jump returns to thread');
      shown = term.text(); state = 'jump returned to original thread'; break;
    }
    case 'unread': {
      // A change the person didn't see: with a thread open, a finished task is completed from the command line (as
      // from another terminal: the local owner's own road). Nothing races a build; every step waits on its fact.
      const message = 'Review the second subtraction change.';
      await startThread(term, message);
      const thread = newestThread();
      const kept = { task: context.task, built: context.built, finished: context.finished };
      try {
        context.built = false; context.finished = false;
        await ready(UNREAD_TASK_TEXT);
        const result = JSON.parse(run(world, process.execPath, [context.cli, 'task', 'show', context.task, '--json'])).assignment?.result;
        if (!result?.digest || !result?.runId) throw new Error('task show named no result to complete');
        await open(message, thread);
        // The person's own sign-in, typed at the prompt as at a real terminal (never in argv or the environment).
        await context.runCli(['task', 'complete', context.task, '--digest', result.digest, '--as', world.owner], [{ prompt: /password:/, answer: world.password }]);
        await seen(() => projectView()?.unread?.includes(context.task), 'the completed task became unread while the thread was open');
        shown = await wait(/[●•·]/);
        await open(UNREAD_TASK_TEXT, context.task);
        await seen(() => !projectView()?.unread?.includes(context.task), 'visiting task clears unread dot');
      } finally { Object.assign(context, kept); }
      state = 'unread task id saved then cleared on visit'; break;
    }
    case 'equalize': {
      // Assert the saved outcome: equal splits can already be the current state.
      term.send('=');
      await seen(() => projectView()?.ratioX === 50 && projectView()?.ratioY === 50
        && /Even splits, and the list at its usual width/.test(term.text()), 'equal splits restored');
      shown = await wait(new RegExp(feature.expected)); state = 'saved splits are 50%'; break;
    }
    default: {
      const action = feature.actions[0]; const before = JSON.stringify(stableView()), screenBefore = term.text();
      if (feature.keys.length) term.send(keyBytes[feature.keys[0]] ?? feature.keys[0]);
      else await palette('Move the list to the other side');
      await seen(() => action === 'zoom' ? term.text() !== screenBefore : JSON.stringify(stableView()) !== before, `${action} changed the view`);
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
        const port = await freePort(); let launches = 0, commands = 0;
        context = { world, cli, runCli: (args, answers) => runCliInTerminal(world, cli, args, answers, join(root, scenario, `command-${commands++}`), terms), relaunch: async () => {
          if (interrupted) throw new Error(interrupted);
          const term = new Terminal(world, cli, binary, port, join(root, scenario, `terminal-${launches++}`), scenario === 'narrow' ? 60 : 140);
          context.term = term; terms.push(term);
          await term.wait(/Toolroll/); await term.wait(/What would you like|Needs you|Working|Nothing yet/);
          term.recordPids(); if (!session.timings.workbenchMs) session.timings = { firstTextMs: term.firstTextMs, workbenchMs: Date.now() - term.started };
        } };
        await context.relaunch();
        const needs = selectedNeeds(features);
        if (needs.length) {
          // First start creates the laptop's owner via the product. Enrollment invalidates sessions, so stop and
          // relaunch the workbench after preparation instead of driving a stale local-owner session.
          await context.term.quit();
          let preparations = 0;
          await prepareWorld(world, cli, needs, (args, answers) => runCliInTerminal(world, cli, args, answers,
            join(root, scenario, `prepare-${preparations++}`), terms));
          session.prepared = needs;
          await context.relaunch();
        }
        report.features.push(...await runFeatures(features, featureMap, context));
        // Quit from the workbench's own screen: q typed into a search, composer or dialog is text, not Quit.
        await toBase(context.term);
        await context.term.quit();
      } catch (error) {
        session.error = error.message;
        for (const f of features) if (!report.features.some(r => r.id === f.id)) report.features.push({ id: f.id, scenario, status: 'FAIL', excerpt: '', error: error.message });
      } finally {
        for (const term of terms.filter(t => t.world === world)) {
          try { await term.cleanup(); } catch (error) { session.cleanupError = error.message; }
          session.steps = [...(session.steps ?? []), ...term.steps];
          const folder = join(out, `${scenario}-${terms.indexOf(term)}`); mkdirSync(folder);
          for (const name of ['screen.log', 'pids.json', 'host.log']) if (existsSync(join(term.folder, name))) writeFileSync(join(folder, name), redactPasswords(readFileSync(join(term.folder, name), 'utf8'), world.secrets));
        }
        try { session.outbound = checkOutbound(world); } catch (error) { session.outbound = { status: 'FAIL', error: error.message }; }
        try { session.modelCalls = checkNoModelCalls(world); } catch (error) { session.modelCalls = { status: 'FAIL', error: error.message }; }
      }
    }
  } finally {
    process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
    if (report.sessions.some(s => s.cleanupError)) report.keptRoot = root;
    // Redact every string (errors and captured steps included), even if a product failure echoed a password.
    const secrets = terms.flatMap(term => term.world.secrets);
    Object.assign(report, JSON.parse(JSON.stringify(report, (_key, value) => typeof value === 'string' ? redactPasswords(value, secrets) : value)));
    finishReport(report);
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(out, 'report.md'), reportMarkdown(report));
    writeFileSync(join(out, 'screens.txt'), report.features.map(f => `===== ${f.id}: ${f.status} =====\n${f.excerpt}\n`).join('\n'));
    if (!options.keep && !report.sessions.some(s => s.cleanupError)) rmSync(root, { recursive: true, force: true });
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage());
    else { const report = await verify(options); console.log(reportSummary(report)); if (!report.ok) console.log('Overall: FAIL (see report for session checks)'); process.exitCode = report.ok ? 0 : 1; }
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
