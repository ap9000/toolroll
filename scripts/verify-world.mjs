/** Runtime verification's throwaway computer. No processes start on import. */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_CLIS, assertIsolated, isolatedEnvironment } from './isolated-env.mjs';
import { SAFE_GIT_BASE } from './deploy-git.mjs';
import { scriptedProvider } from './fixtures/scripted-provider.mjs';
import { scriptedConsoleEnv } from './tui-e2e.mjs';

export const MARKER = 'VERIFY_AGENT_WORDS_7f3a';
export const SCENARIOS = ['smoke', 'success', 'agent-error', 'never-initialized', 'signed-out', 'narrow'];
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
  Object.assign(world, { provider, shop, prefix, scenario });
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
