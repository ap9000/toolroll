/** Local source retrieval uses local-file authority. Explicit coordinator credentials narrow it. */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { authenticateCoordinator } from './coordinator.js';
import { envelopeJson } from './envelope.js';
import { repositoryContext, type RepositoryContext } from './repository-context.js';
import type { Store } from './store.js';
import { namedPath } from './names.js';
import { applySavedKnowledge } from './project-knowledge.js';

const flags = [
  { name: 'repo', takesValue: true, meaning: 'admitted project checkout root' },
  { name: 'base', takesValue: true, meaning: 'exact committed task base; defaults to current HEAD' },
  { name: 'json', takesValue: false, meaning: 'versioned structured response' },
  { name: 'db', takesValue: true, meaning: 'local Toolroll database' },
  { name: 'token-file', takesValue: true, meaning: 'explicit scoped coordinator credential file' },
  { name: 'token-env', takesValue: true, meaning: 'environment variable containing a scoped coordinator token' },
] as const;
const applyFlags = [
  { name: 'repo', takesValue: true, meaning: 'admitted project checkout root' },
  { name: 'as', takesValue: true, meaning: 'approver account name' },
  { name: 'token', takesValue: true, meaning: "the approver's password (never a lead token)" },
  { name: 'json', takesValue: false, meaning: 'versioned structured response' },
  { name: 'db', takesValue: true, meaning: 'local Toolroll database' },
] as const;
export const KNOWLEDGE_DESCRIPTORS = [
  { action: 'search', synopsis: 'find bounded source excerpts and relevant code symbols', mutation: 'none', takesQuery: true, flags },
  { action: 'impact', synopsis: 'inspect static imports affected by one file or unambiguous symbol', mutation: 'none', takesQuery: true, flags },
  { action: 'refresh', synopsis: 'refresh the optional local code index; never starts a model or task', mutation: 'identity-idempotent', takesQuery: false, flags },
  // A person's action: the approver carries saved knowledge from before a project change forward.
  { action: 'apply', synopsis: "carry this project's saved knowledge from before a change forward as a new revision; an approver's --as/--token", mutation: 'identity-idempotent', takesQuery: false, flags: applyFlags, audience: 'operator' },
] as const;
/** `knowledge apply`: the caller has verified `actor` as an approver of `repo` (never the lead). */
export function runKnowledgeApply(options: Map<string, string | true>, context: KnowledgeCliContext & { actor: string | null }): number {
  const command = 'knowledge apply';
  const fail = (reason: 'usage' | 'unauthenticated' | 'failed', message: string) => { context.write(context.json ? envelopeJson({ ok: false, command, reason, message }) : message); return reason === 'usage' ? 2 : 3; };
  for (const key of options.keys()) if (!applyFlags.some(flag => flag.name === key)) return fail('usage', `--${key} is not a knowledge apply option.`);
  const repo = options.get('repo');
  if (typeof repo !== 'string' || !repo.trim() || repo.length > 4096 || /[\x00-\x1f]/.test(repo)) return fail('usage', 'Use --repo with the project checkout root.');
  if (context.actor === null) return fail('unauthenticated', 'An approver of this project applies saved knowledge: --as <you> --token <password>.');
  let revision: number | null;
  try { revision = applySavedKnowledge(context.store, resolve(repo), context.actor, context.now); }
  catch (error) { return fail('failed', error instanceof Error ? error.message : 'Saved knowledge could not be applied.'); }
  const message = revision === null ? 'Nothing to apply.' : `Applied saved knowledge as version ${revision}.`;
  context.write(context.json ? envelopeJson({ ok: true, command, result: { revision, message } }) : message);
  return 0;
}
export type KnowledgeCliContext = { store: Store; write: (line: string) => void; json: boolean; now: Date; evidenceRoot?: string; env?: NodeJS.ProcessEnv };

function lines(result: RepositoryContext): string {
  return [
    `Repository context: ${result.index.status}${result.index.engine === 'text-search' ? ' · source search' : ' · code relationships'}`,
    ...result.excerpts.flatMap(e => [`${e.file}:${e.line} · ${e.reason}`, e.text]),
    ...result.relationships.map(e => `${e.from}:${e.line} → ${e.to} (${e.kind})`),
    ...result.warnings,
    ...(result.omissions.excerpts || result.omissions.relationships ? [`Omitted: ${result.omissions.excerpts} excerpts, ${result.omissions.relationships} relationships.`] : []),
  ].join('\n');
}
export async function runKnowledgeCommand(positional: readonly string[], options: Map<string, string | true>, context: KnowledgeCliContext): Promise<number> {
  const spec = KNOWLEDGE_DESCRIPTORS.find(s => s.action === positional[0]);
  const command = spec ? `knowledge ${spec.action}` : 'knowledge';
  const fail = (reason: 'usage' | 'unauthenticated' | 'not-found', message: string) => { context.write(context.json ? envelopeJson({ ok: false, command, reason, message }) : message); return reason === 'usage' ? 2 : 3; };
  if (!spec || spec.action === 'apply') return fail('usage', 'Use knowledge search <query>, impact <file-or-symbol>, refresh or apply with --repo PATH.');
  if (positional.length !== (spec.takesQuery ? 2 : 1)) return fail('usage', spec.takesQuery ? 'Provide one quoted query or source path.' : 'knowledge refresh takes no query.');
  for (const key of options.keys()) if (!spec.flags.some(flag => flag.name === key)) return fail('usage', `--${key} is not a knowledge ${spec.action} option.`);
  const repo = options.get('repo'), base = options.get('base'), query = positional[1] ?? '';
  if (typeof repo !== 'string' || !repo.trim() || repo.length > 4096 || /[\x00-\x1f]/.test(repo)) return fail('usage', 'Use --repo with the project checkout root.');
  if (base !== undefined && (typeof base !== 'string' || !/^[a-f0-9]{40,64}$/.test(base))) return fail('usage', '--base requires an exact commit hash.');
  if (query.length > 1000 || (spec.takesQuery && !query.trim())) return fail('usage', 'Choose a nonempty query up to 1000 characters.');
  const tokenEnv = options.get('token-env'), tokenFile = options.get('token-file');
  let admittedToken: string | null = null;
  if (tokenEnv !== undefined && tokenFile !== undefined) return fail('usage', 'Choose either --token-env NAME or --token-file PATH.');
  if (tokenEnv !== undefined || tokenFile !== undefined) {
    let raw: string | undefined;
    if (tokenEnv !== undefined) {
      if (typeof tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) return fail('usage', '--token-env requires an environment variable name.');
      raw = (context.env ?? process.env)[tokenEnv];
    } else {
      try { if (typeof tokenFile !== 'string' || !statSync(tokenFile).isFile() || statSync(tokenFile).size > 16_384) return fail('unauthenticated', 'The explicit credential file is unavailable.'); raw = readFileSync(tokenFile, 'utf8'); }
      catch { return fail('unauthenticated', 'The explicit credential file is unavailable.'); }
    }
    const token = raw?.trim();
    if (!token || token.length > 4096 || /\s/.test(token)) return fail('unauthenticated', 'The explicit credential source must contain one coordinator token.');
    const auth = authenticateCoordinator(context.store, token);
    if (!auth.ok) return fail('unauthenticated', 'The coordinator credential is invalid or revoked.');
    // Compare admitted path identity before any repository/source filesystem read.
    if (!auth.who.repos.includes(resolve(repo))) return fail('not-found', 'That project is unavailable to this coordinator.');
    admittedToken = token;
  }
  const cacheRoot = context.evidenceRoot ? join(dirname(context.evidenceRoot), 'repository-context') : namedPath(join(homedir(), '.cache'), ['repository-context']);
  const result = await repositoryContext({ repo: resolve(repo), query, mode: spec.action === 'impact' ? 'impact' : 'search', refresh: spec.action === 'refresh', cacheRoot, ...(typeof base === 'string' ? { baseRevision: base } : {}) });
  if (admittedToken) {
    const current = authenticateCoordinator(context.store, admittedToken);
    if (!current.ok) return fail('unauthenticated', 'The coordinator credential is invalid or revoked.');
    if (!current.who.repos.includes(resolve(repo))) return fail('not-found', 'That project is unavailable to this coordinator.');
  }
  context.write(context.json ? envelopeJson({ ok: true, command, result }) : lines(result));
  return 0;
}
