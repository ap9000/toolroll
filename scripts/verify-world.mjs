/** Runtime verification's throwaway computer. No processes start on import. */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
// Suppress only SQLite's experimental notice in this reader, preserving every other warning.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (String(warning).includes('SQLite is an experimental feature')
    && (args[0] === 'ExperimentalWarning' || args[0]?.type === 'ExperimentalWarning')) return;
  return emitWarning.call(this, warning, ...args);
};
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
finally { process.emitWarning = emitWarning; }
import { AGENT_CLIS, assertIsolated, isolatedEnvironment } from './isolated-env.mjs';
import { SAFE_GIT_BASE } from './deploy-git.mjs';
import { scriptedProvider } from './fixtures/scripted-provider.mjs';
import { scriptedConsoleEnv } from './tui-e2e.mjs';

export const MARKER = 'VERIFY_AGENT_WORDS_7f3a';
export const WORLD_NEEDS = ['threads-on'];
/** Literal replacement, including secrets containing regexp characters or terminal bytes. */
export function redactPasswords(text, secrets = []) {
  for (const secret of secrets) if (secret) {
    text = text.split(secret).join('[REDACTED]');
    // A rendered terminal may wrap an echoed password across rows. Match the whole secret across that whitespace too.
    const wrapped = [...secret].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    text = text.replace(new RegExp(wrapped, 'g'), '[REDACTED]');
  }
  return text;
}
export const SCENARIOS = ['smoke', 'success', 'agent-error', 'never-initialized', 'signed-out', 'narrow', 'plan-refused', 'plan-error'];
const word = s => `'${String(s).replace(/'/g, "'\\''")}'`;
export function checkedEnv(world) {
  assertIsolated(world.env, { root: world.root });
  return world.env;
}
export function run(world, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: world.root, encoding: 'utf8', timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024, ...options, env: checkedEnv(world) });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout;
}
/** Ask the world's profile-free shell, never a system login shell that rebuilds PATH. */
export function assertAgentStandIns(world) {
  checkedEnv(world);
  const agents = {};
  for (const name of AGENT_CLIS) {
    const found = run(world, join(world.tools, 'sh'), ['-c', 'command -v "$1" || true', 'verify', name]).trim();
    if (found && !realpathSync(found).startsWith(realpathSync(world.bin) + sep)) throw new Error(`${name} is not a stand-in`);
    agents[name] = found ? 'stand-in' : 'absent';
  }
  return agents;
}
/** All git calls, including fixture setup, use the same hardened flags and allowlisted environment. */
export function git(world, cwd, args) {
  return run(world, 'git', [...SAFE_GIT_BASE, '-c', 'submodule.recurse=false', ...args], { cwd });
}
export function createWorld(root, scenario = 'smoke', outer = process.env) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const prefix = join(root, 'prefix');
  // As in tui-e2e, state is separate from the provider install and HOME. The
  // status probe excludes the database's parent, not just the database file.
  for (const dir of [prefix, join(root, 'state'), join(root, 'npm-cache')]) mkdirSync(dir, { recursive: true });
  for (const name of ['npmrc', 'npmrc-global']) writeFileSync(join(root, name), '');
  const world = isolatedEnvironment({ root, outer, set: {
    TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ...scriptedConsoleEnv(join(root, 'state', 'orders.db')),
    npm_config_prefix: prefix, npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'npmrc-global'),
    npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
    GIT_AUTHOR_NAME: 'Runtime verifier', GIT_AUTHOR_EMAIL: 'verify@example.invalid',
    GIT_COMMITTER_NAME: 'Runtime verifier', GIT_COMMITTER_EMAIL: 'verify@example.invalid',
  } });
  const exe = (name, text) => { writeFileSync(join(world.bin, name), text, { mode: 0o755 }); chmodSync(join(world.bin, name), 0o755); };
  // Reuse the scripted provider's wire protocol, auth detection and fenced-build spool handling.
  const provider = scriptedProvider(join(root, 'provider'), { homes: [world.home] });
  // Bake the flag into the actual provider shim: fenced builds need not forward NODE_* variables.
  const shim = provider.shims.claude;
  writeFileSync(shim, readFileSync(shim, 'utf8').replace(word(process.execPath), `${word(process.execPath)} --no-warnings`));
  const math = 'export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\n';
  const test = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { subtract } from '../src/math.js';\ntest('subtracts', () => assert.equal(subtract(5, 2), 3));\n";
  provider.add('runtime-verification', { role: 'builder', when: [/subtract\(a, b\)/], times: scenario === 'agent-error' ? undefined : 1,
    answer: scenario === 'agent-error' ? { fail: `${MARKER}: synthetic agent error` }
      : { files: { 'src/math.js': math, 'test/math.test.js': test }, conclusion: `${MARKER}: Added subtract(a, b).` } });
  // Each revision changes real bytes, even when several inspection features share a session.
  if (scenario !== 'agent-error') for (let revision = 1; revision <= 4; revision++) provider.add('runtime-verification', { role: 'builder', when: [], times: 1, answer: {
    files: { 'src/math.js': math + `// Synthetic verification revision ${revision}.\n`,
      'test/math.test.js': test + "test('negative numbers', () => assert.equal(subtract(-2, 3), -5));\n" },
    conclusion: `${MARKER}: Added coverage for negative numbers.` } });
  provider.add('runtime-verification', { role: 'lead', when: [], answer: { text: 'The subtraction change is available for review.', calls: [] } });
  // A thread's turns (the threads scenarios): the agent answers in words and its turn finishes (not `unknown`).
  provider.add('runtime-verification', { role: 'thread', when: [/Review the (second )?subtraction change|explain the change/], answer: { text: 'I read the subtraction change; it does what it says.' } });
  // A plan that fails its checks, the first turn and its correction both (no "## Approach"): a planning incident.
  // Plan again then gets the scripted planner's own valid plan.
  if (scenario === 'plan-refused') provider.add('runtime-verification', { role: 'planner', when: [], times: 2, answer: { plan: { plan: `${MARKER}: no approach heading here.` } } });
  // A planner whose agent stops with its own error once: the planning backoff, with what it said.
  if (scenario === 'plan-error') provider.add('runtime-verification', { role: 'planner', when: [], times: 1, answer: { fail: `${MARKER}: synthetic planner error` } });
  for (const name of AGENT_CLIS) exe(name, '#!/bin/sh\necho "Not installed (stand-in)" >&2\nexit 127\n');
  exe('claude', `#!/bin/sh\n${scenario === 'never-initialized' ? `case "$1" in --version|--help|auth|mcp) ;; *) echo '${MARKER}: exited before initialization' >&2; exit 1 ;; esac\n` : ''}exec ${word(provider.shims.claude)} "$@"\n`);
  // Codex must never turn signed-in just because an auth probe returned zero.
  exe('codex', '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.99.0"; exit 0 ;; esac\necho "Not logged in" >&2\nexit 1\n');
  exe('verify-editor', `#!/bin/sh\ncat "$1" > ${word(join(root, 'editor.txt'))}\n`);
  world.env.EDITOR = join(world.bin, 'verify-editor');
  world.env.VISUAL = world.env.EDITOR;
  const shop = join(root, 'shop');
  mkdirSync(join(shop, 'src'), { recursive: true });
  writeFileSync(join(shop, 'src/math.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(shop, 'package.json'), JSON.stringify({ name: 'verify-shop', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(world.home, '.gitconfig'), '[user]\n name = Runtime verifier\n email = verify@example.invalid\n');
  Object.assign(world, { provider, shop, prefix, scenario, secrets: [] });
  for (const tool of ['node', 'sh', 'git', 'python3', 'mkfifo', 'ps']) {
    if (!existsSync(join(world.tools, tool))) throw new Error(`Runtime verification requires ${tool} on the approved tools PATH`);
  }
  assertAgentStandIns(world); // Before git, npm, the launcher or any provider can start.
  return world;
}

const quote = name => '"' + name.replaceAll('"', '""') + '"';
function withConsoleDatabase(world, read) {
  checkedEnv(world);
  const file = world.env.TOOLROLL_DB;
  if (!existsSync(file)) throw new Error('Console database was not created');
  // Use the console's SQLite runtime. macOS sqlite3 -readonly cannot reopen a
  // checkpointed WAL database after its last connection removes -wal/-shm.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    return read(query => db.prepare(query).all());
  } finally { db.close(); }
}
export function readConsole(world, query) {
  return withConsoleDatabase(world, sql => sql(query));
}
/** Scan every column, including BLOBs, of every outbound-family table; no schema allowlist can silently miss a new one. */
export function checkOutbound(world, markers = [MARKER]) {
  return withConsoleDatabase(world, sql => {
    const tables = sql("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name)
      .filter(name => /notification|delivery|push|chat|lead|team|mail|coordinator/i.test(name));
    if (!tables.some(name => /notification/i.test(name))) throw new Error('No notification tables: outbound check cannot establish coverage');
    const leaks = [];
    for (const table of tables) {
      const columns = sql(`PRAGMA table_info(${quote(table)})`).map(row => row.name);
      const clauses = columns.flatMap(column => markers.map(marker => `instr(CAST(${quote(column)} AS TEXT), '${marker.replaceAll("'", "''")}') > 0`));
      const count = sql(`SELECT count(*) AS n FROM ${quote(table)} WHERE ${clauses.join(' OR ')}`)[0]?.n;
      if (count > 0) leaks.push({ table, rows: count });
    }
    return { status: leaks.length ? 'FAIL' : 'PASS', tables, markers, leaks };
  });
}

/** Only product commands write preparation state. The console records discover this install's owner; they never
 * supply a password or bypass the product's own operator check. Called after first start, before a fresh workbench. */
export async function prepareWorld(world, cli, needs, runCli) {
  if (!needs.includes('threads-on')) return;
  const owners = readConsole(world, `SELECT a.name FROM local_mode m JOIN approver a ON a.name=m.owner
    WHERE m.id=1 AND m.enabled=1 AND a.revoked_at IS NULL AND a.role='approver'
      AND a.projects_json IS NULL AND a.password_set=0`);
  if (owners.length !== 1) throw new Error('Cannot prepare threads-on: this install has no unique passwordless local owner who is an instance operator. No settings were changed.');
  const password = randomBytes(32).toString('hex');
  world.secrets.push(password);
  // In memory only, for a later feature's own password prompt (the unread check completes a task as this person).
  Object.assign(world, { owner: owners[0].name, password });
  // askCredentials supports a hidden terminal prompt: never put the password in argv, env or a file.
  await runCli(['password', 'set'], [
    { prompt: /New password:/, answer: password },
    { prompt: /Type it again:/, answer: password },
  ]);
  await runCli(['config', 'set', 'flexible', 'on', '--as', owners[0].name], [
    { prompt: /password:/, answer: password },
  ]);
  const shown = JSON.parse(run(world, process.execPath, [cli, 'config', 'show', 'flexible', '--json']));
  if (shown.flexible?.on !== true) throw new Error('Cannot prepare threads-on: config show flexible did not report on.');
  // Threads start only in a Flexible project: the person reads its terms and agrees, as at a real terminal.
  await runCli(['project', 'flexible', 'enable', '--repo', world.shop, '--as', owners[0].name], [
    { prompt: /password:/, answer: password },
    { prompt: /Turn on Flexible with these terms\? \[y\/N\]/, answer: 'y' },
  ]);
  const project = JSON.parse(run(world, process.execPath, [cli, 'project', 'flexible', 'show', '--repo', world.shop, '--json']));
  if (project.flexible?.state !== 'on') {
    throw new Error(`Cannot prepare threads-on: the project did not become Flexible (${JSON.stringify(project).slice(0, 200)}).`);
  }
  // Threads run on the owner's own Claude sign-in: saved through the product's own door, as a person would.
  await saveStandInSignIn(world, runCli);
}

/** The owner's own Claude sign-in for threads, saved through the product: `toolroll config set flexible-sign-in
 * --no-check`, the password and then a stand-in token typed at its hidden prompts in a real terminal (never argv, env or
 * a file). The token is a random value in a setup-token's shape, never a real credential, redacted like the password.
 * --no-check reaches no model service; the relay would send it only on a call through it, which the stand-in agent never
 * makes (checkNoModelCalls). Fails unless the console's records then hold exactly one active sign-in for the owner. */
export async function saveStandInSignIn(world, runCli) {
  checkedEnv(world);
  if (world.env.TOOLROLL_SECRET_STORE !== 'files') throw new Error('The stand-in sign-in needs the files secret store');
  if (!world.owner || !world.password) throw new Error('Save the sign-in after the owner has a password');
  const value = ['sk', 'ant', 'oat01', randomBytes(24).toString('hex')].join('-');
  world.secrets.push(value);
  await runCli(['config', 'set', 'flexible-sign-in', '--no-check', '--as', world.owner], [
    { prompt: /password:/, answer: world.password },
    { prompt: /Paste the token from `claude setup-token`:/, answer: value },
  ]);
  const active = readConsole(world, `SELECT count(*) AS n FROM flexible_sign_in WHERE person='${world.owner.replaceAll("'", "''")}' AND state='active'`);
  if (active[0]?.n !== 1) throw new Error('Cannot prepare threads-on: the owner\'s Claude sign-in for threads was not saved.');
  return value;
}

/** No call went to a model: the threads' sign-in relay records every call it answers, refused or forwarded (thread_relay_call). */
export function checkNoModelCalls(world) {
  return withConsoleDatabase(world, sql => {
    const table = sql("SELECT name FROM sqlite_master WHERE type='table' AND name='thread_relay_call'");
    if (!table.length) throw new Error('No thread_relay_call table: the no-model-calls check cannot establish coverage');
    const calls = sql('SELECT count(*) AS n FROM thread_relay_call')[0].n;
    return { status: calls === 0 ? 'PASS' : 'FAIL', relayCalls: calls };
  });
}
