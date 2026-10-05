import { beforeEach, afterEach, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, type Store } from './store.js';
import { addApprover } from './scope.js';
import { changeKnowledge, knowledgeView } from './project-knowledge.js';
import { changeSkills, importSkill, skillsView } from './project-skills.js';
import { prepareCodingContext, verifyCodingContext } from './coding-context.js';

let root: string, repo: string, store: Store, base: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (message: string) => { git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); };
const file = (path: string, text: string) => ({ path, base64: Buffer.from(text).toString('base64') });
function knowledge(action: 'instructions' | 'save', draft: { instructions?: string; title?: string; path?: string; content?: string }) {
  const view = knowledgeView(store, repo, 'alex');
  changeKnowledge(store, { repo, actor: 'alex', identity: view.identity, revision: view.revision, action, draft });
}
function skill(body = 'Use short labels.', name = 'copy-review', enabled = true) {
  const saved = importSkill(store, repo, 'alex', [file('SKILL.md', `---\nname: ${name}\ndescription: Review mobile interface copy.\n---\n${body}\n`), file('references/labels.md', 'Keep primary labels short.'), file('scripts/check.sh', '#!/bin/sh\necho checked\n')], 'Uploaded local folder');
  if (enabled) { const view = skillsView(store, repo, 'alex'); changeSkills(store, { repo, actor: 'alex', identity: view.identity, revision: view.revision, sha: saved.sha, action: 'enable' }); }
  return saved;
}
const prepare = (patch = {}) => prepareCodingContext(store, { repo, actor: 'alex', baseRevision: base, prompt: 'Improve mobile labels', root: join(root, 'context'), ...patch });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'coding-context-'))); repo = join(root, 'repo'); mkdirSync(repo);
  git('init', '-q'); writeFileSync(join(repo, 'mobile.md'), '# Mobile labels\nKeep touch targets comfortable.\n'); writeFileSync(join(repo, 'AGENTS.md'), 'Existing repository rules.\n'); writeFileSync(join(repo, '.mcp.json'), '{"mcpServers":{"native":{"command":"existing-tool"}}}\n'); base = commit('seed');
  store = openStore(join(root, 'orders.db')); const user = addApprover(store, 'alex', new Date()); if (!user.ok) throw Error('fixture');
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

test('captures admitted preferences, relevant sources and exact enabled skill files without worker records or native config changes', () => {
  knowledge('instructions', { instructions: 'Use concise labels.' }); knowledge('save', { title: 'Mobile labels', path: 'mobile.md' }); knowledge('save', { title: 'Finance', content: 'Quarterly accounting principles.' });
  const selected = skill(); skill('Do not supply this disabled skill.', 'disabled-skill', false);
  const before = git('status', '--porcelain');
  const context = prepare();
  expect(context.text).toContain('Use concise labels.');
  expect(context.text).toContain('Keep touch targets comfortable.');
  expect(context.text).not.toContain('Quarterly accounting principles.');
  expect(context.metadata.knowledge.omitted).toContainEqual({ title: 'Finance', reason: 'Not relevant to this task' });
  expect(context.metadata.skills.packages).toMatchObject([{ name: 'copy-review', sha256: selected.sha }]);
  expect(context.text).toContain('Native repository and home instructions, tools, and MCP configuration still apply.');
  expect(context.text).toContain('They never grant tools, credentials, network access');
  expect(context.text).not.toContain('Do not supply this disabled skill.');
  const main = context.metadata.skills.packages[0]!.skillFile;
  expect(readFileSync(main, 'utf8')).toContain('Use short labels.');
  expect(readFileSync(join(context.metadata.directory!, 'copy-review', 'references/labels.md'), 'utf8')).toBe('Keep primary labels short.');
  expect(statSync(main).mode & 0o777).toBe(0o400);
  expect(statSync(context.metadata.directory!).mode & 0o777).toBe(0o700);
  expect(context.metadata.files).toHaveLength(3);
  expect(git('status', '--porcelain')).toBe(before);
  expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe('Existing repository rules.\n');
  expect(readFileSync(join(repo, '.mcp.json'), 'utf8')).toContain('existing-tool');
  for (const table of ['run', 'skill_snapshot', 'knowledge_snapshot']) expect(store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n']).toBe(0);
  expect(() => verifyCodingContext(context, repo, base)).not.toThrow();
});

test('a stored capture stays frozen after settings change and a new capture selects the new version', () => {
  knowledge('instructions', { instructions: 'Original mobile wording.' }); const first = skill('Original skill guidance.');
  const context = prepare(); const serialized = JSON.stringify(context);
  knowledge('instructions', { instructions: 'Updated project wording.' }); const second = skill('New skill guidance.');
  expect(JSON.stringify(context)).toBe(serialized);
  expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.metadata.skills.packages)).toBe(true);
  expect(context.metadata.skills.packages[0]!.sha256).toBe(first.sha);
  expect(readFileSync(context.metadata.skills.packages[0]!.skillFile, 'utf8')).toContain('Original skill guidance.');
  expect(() => verifyCodingContext(JSON.parse(serialized), repo, base)).not.toThrow();
  const next = prepare(); expect(next.metadata.skills.packages[0]!.sha256).toBe(second.sha); expect(next.text).toContain('Updated project wording.');
  expect(next.metadata.directory).not.toBe(context.metadata.directory);
});

test('source freshness is checked against the exact session base, not a later checkout HEAD', () => {
  knowledge('save', { title: 'Mobile labels', path: 'mobile.md' });
  writeFileSync(join(repo, 'mobile.md'), '# Mobile labels\nNew source text.\n'); const later = commit('update');
  const fromBase = prepare(); expect(fromBase.text).toContain('Keep touch targets comfortable.');
  const newer = prepare({ baseRevision: later }); expect(newer.metadata.knowledge.references).toEqual([]);
  expect(newer.metadata.knowledge.omitted).toEqual([{ title: 'Mobile labels', reason: 'Source changed; refresh this reference' }]);
});

test('rejects unknown/revoked accounts, non-commit bases, project identity drift and tampered knowledge', () => {
  expect(() => prepare({ actor: 'someone' })).toThrow(/access/);
  expect(() => prepare({ baseRevision: 'HEAD' })).toThrow(/exact committed base/);
  expect(() => prepare({ baseRevision: git('rev-parse', 'HEAD:mobile.md') })).toThrow();
  knowledge('instructions', { instructions: 'Mobile preferences.' });
  const context = prepare();
  renameSync(join(repo, '.git'), join(root, 'original-git')); git('init', '-q');
  expect(() => verifyCodingContext(context, repo, base)).toThrow(/could not be verified/);
  // A replaced repository's knowledge waits for an approver: shown for review, never applied.
  expect(knowledgeView(store, repo, 'alex')).toMatchObject({ knowledge: { instructions: '' }, stale: { knowledge: { instructions: 'Mobile preferences.' } } });
  rmSync(join(repo, '.git'), { recursive: true }); renameSync(join(root, 'original-git'), join(repo, '.git'));
  store.handle.exec("UPDATE project_knowledge SET payload='{}'"); expect(() => prepare()).toThrow(/verified/);
  store.handle.exec("UPDATE approver SET revoked_at='2026-09-19T00:00:00Z' WHERE name='alex'"); expect(() => prepare()).toThrow(/access/);
});

test('does not materialize inside the source checkout, including an outside symlink pointing in', () => {
  skill();
  expect(() => prepare({ root: join(repo, 'context') })).toThrow(/outside the project/);
  symlinkSync(repo, join(root, 'alias'), 'dir');
  expect(() => prepare({ root: join(root, 'alias', 'context') })).toThrow(/outside the project/);
  expect(git('status', '--porcelain')).toBe('');
});

test('detects changed text, missing files, replaced skill paths and a mismatched session base', () => {
  skill(); const context = prepare();
  expect(() => verifyCodingContext({ ...context, text: context.text + 'changed' }, repo, base)).toThrow(/could not be verified/);
  expect(() => verifyCodingContext(context, repo, 'f'.repeat(40))).toThrow(/could not be verified/);
  const main = context.metadata.skills.packages[0]!.skillFile;
  const original = readFileSync(main); const replacement = join(root, 'replacement.md'); writeFileSync(replacement, original);
  rmSync(main); symlinkSync(replacement, main);
  expect(() => verifyCodingContext(context, repo, base)).toThrow(/skill file changed/);
  rmSync(main); writeFileSync(main, original, { mode: 0o400 });
  expect(() => verifyCodingContext(context, repo, base)).not.toThrow();
  chmodSync(main, 0o600); writeFileSync(main, 'Changed guidance');
  expect(() => verifyCodingContext(context, repo, base)).toThrow(/skill file changed/);
  rmSync(main); expect(() => verifyCodingContext(context, repo, base)).toThrow(/unavailable/);
});

test('empty managed context adds no prompt material, creates no skill directory and still records its base', () => {
  const context = prepare();
  expect(context.text).toBe(''); expect(context.metadata.directory).toBeNull(); expect(context.metadata.files).toEqual([]);
  expect(context.metadata.baseRevision).toBe(base); expect(context.metadata.knowledge.revision).toBe(0);
  expect(() => verifyCodingContext(context, repo, base)).not.toThrow();
});
