/** Local convenience only: a selected project and optional credential reference.
 * Every action still authenticates against the current database. */
import { lstatSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { configPath, loadRepos } from './repos.js';
import { authenticateCoordinator } from './coordinator.js';
import { canonicalProject } from './project.js';
import { envelopeJson } from './envelope.js';
import { projectOutcomes } from './project-outcomes.js';
import type { Store } from './store.js';

export type ProjectProfile = { version: 1; repo: string; tokenFile: string | null };
export const projectProfilePath = (databaseFile: string) => join(dirname(databaseFile), 'cli-project.json');
export function readProjectProfile(databaseFile: string): ProjectProfile | null {
  const file = projectProfilePath(databaseFile);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 16_384) throw new Error('The saved CLI project is not a readable profile. Select it again with project use.');
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('The saved CLI project is invalid. Select it again with project use.');
  const p = value as Record<string, unknown>;
  if (p['version'] !== 1 || typeof p['repo'] !== 'string' || !isAbsolute(p['repo']) || /[\x00-\x1f]/.test(p['repo']) ||
      (p['tokenFile'] !== null && (typeof p['tokenFile'] !== 'string' || !isAbsolute(p['tokenFile']) || /[\x00-\x1f]/.test(p['tokenFile'])))) throw new Error('The saved CLI project is invalid. Select it again with project use.');
  return { version: 1, repo: p['repo'], tokenFile: p['tokenFile'] as string | null };
}

function proveCredential(store: Store, tokenFile: string, repo: string): { reason: string; message: string } | null {
  let token: string;
  try {
    const info = statSync(tokenFile);
    if (!info.isFile() || info.size > 16_384) return { reason: 'unauthenticated', message: 'The scoped credential file is unavailable.' };
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch { return { reason: 'unauthenticated', message: 'The scoped credential file is unavailable.' }; }
  const auth = authenticateCoordinator(store, token);
  if (!auth.ok) return { reason: 'unauthenticated', message: 'The scoped credential is invalid or revoked.' };
  if (!auth.who.repos.includes(repo)) return { reason: 'not-found', message: 'That project is unavailable to this credential.' };
  return null;
}

export async function runProjectCommand(positional: readonly string[], flags: Map<string, string | true>, context: {
  store: Store; databaseFile: string; write: (line: string) => void; json: boolean; registryFile?: string; now?: Date;
}): Promise<number> {
  const action = positional[0] ?? 'show', command = `project ${action}`;
  const fail = (reason: string, message: string) => { context.write(context.json ? envelopeJson({ ok: false, command, reason, message }) : message); return reason === 'usage' ? 2 : 3; };
  if (!['use', 'show', 'activity'].includes(action) || positional.length > (action === 'use' ? 2 : 1)) return fail('usage', 'Use project use <saved checkout path> [--token-file PATH], project show, or project activity [--json].');
  const allowed = new Set(['db', 'json', ...(action === 'use' ? ['token-file'] : [])]);
  for (const name of flags.keys()) if (!allowed.has(name)) return fail('usage', `--${name} is not a project ${action} option.`);
  const registry = await loadRepos(context.registryFile ?? configPath(process.env, homedir()));
  if ('error' in registry) return fail('configuration', registry.error);
  const repos = [...new Set([...registry.repos, ...context.store.knownRepos()].map(repo => canonicalProject(repo) ?? repo))];
  let profile: ProjectProfile | null;
  if (action === 'use') {
    const path = positional[1];
    if (!path || /[\x00-\x1f]/.test(path)) return fail('usage', 'Choose the exact saved checkout path.');
    const repo = canonicalProject(path) ?? resolve(path);
    if (!repos.includes(repo)) return fail('not-found', 'That checkout is not a saved project. Use repos to see or connect projects.');
    try { if (!statSync(repo).isDirectory()) return fail('not-found', 'That checkout is unavailable.'); } catch { return fail('not-found', 'That checkout is unavailable.'); }
    const credential = flags.get('token-file');
    if (credential !== undefined && (typeof credential !== 'string' || !credential || /[\x00-\x1f]/.test(credential))) return fail('usage', '--token-file requires a path.');
    const tokenFile = typeof credential === 'string' ? resolve(credential) : null;
    const refused = tokenFile === null ? null : proveCredential(context.store, tokenFile, repo);
    if (refused) return fail(refused.reason, refused.message);
    profile = { version: 1, repo, tokenFile };
    const file = projectProfilePath(context.databaseFile), temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } else profile = readProjectProfile(context.databaseFile);
  if (action === 'activity') {
    if (profile === null || !repos.includes(profile.repo)) return fail('not-found', 'Select a saved project with project use first.');
    const refused = profile.tokenFile === null ? null : proveCredential(context.store, profile.tokenFile, profile.repo);
    if (refused) return fail(refused.reason, refused.message);
    // Like assignment brief, an uncredentialed local database read has the
    // local operator's access. A saved scoped credential is always re-proved.
    const result = projectOutcomes(context.store, profile.repo, context.now ?? new Date(), { principal: 'operator', repos: [profile.repo] });
    context.write(context.json ? envelopeJson({ ok: true, command, result }) : JSON.stringify(result, null, 2));
    return 0;
  }
  const result = { profile, saved: profile !== null && repos.includes(profile.repo) };
  context.write(context.json ? envelopeJson({ ok: true, command, result }) : profile === null ? 'No project selected. Use project use <saved checkout path>.' : `${profile.repo}${result.saved ? '' : ' (no longer saved)'}\n${profile.tokenFile === null ? 'Uses your existing local sign-in for operator actions.' : `Scoped credential reference: ${profile.tokenFile}`}`);
  return 0;
}

/** Only known credential-aware adapters consume the remembered reference.
 * Explicit credentials always win; no legacy action gains implicit authority. */
export function applyProjectProfile(command: string, positional: readonly string[], flags: Map<string, string | true>, databaseFile: string): void {
  const scoped = command === 'assignment' || command === 'knowledge' || (command === 'brief' && !flags.has('history')) ||
    (command === 'task' && ['complete', 'revise'].includes(positional[0] ?? ''));
  const repoDefault = command === 'knowledge' || command === 'brief' || (command === 'assignment' && positional[0] === 'brief');
  if (!scoped && !repoDefault) return;
  const profile = readProjectProfile(databaseFile);
  if (!profile) return;
  if (repoDefault && !flags.has('repo')) flags.set('repo', profile.repo);
  if (scoped && profile.tokenFile && !['token-file', 'token-env', 'token', 'as'].some(name => flags.has(name))) flags.set('token-file', profile.tokenFile);
}
