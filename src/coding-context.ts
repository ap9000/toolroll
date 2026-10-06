/** Managed context captured once for a native coding session; no synthetic worker runs. */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { KNOWLEDGE_GUIDANCE, selectProjectKnowledge } from './project-knowledge.js';
import { materializeProjectSkills, PROJECT_SKILLS_GUIDANCE, selectProjectSkills } from './project-skills.js';
import { identityMatches, learningIdentity, learningSha } from './project-learning.js';
import type { Store } from './store.js';
import { CODING_CONTEXT_VERSION, type CodingContext, type CodingContextMetadata } from './contracts/coding-context.js';

export type { CodingContext, CodingContextMetadata } from './contracts/coding-context.js';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const digest = (text: string, metadata: CodingContextMetadata): string => learningSha(JSON.stringify({ text, metadata }));
const fileDigest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function futureRealPath(path: string): string {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) { suffix.unshift(basename(existing)); existing = dirname(existing); }
  if (!statSync(existing).isDirectory()) throw Error('Choose a directory for managed coding context.');
  return resolve(realpathSync(existing), ...suffix);
}

/**
 * Call before thread/start with the canonical project and the exact worktree
 * base. Persist the returned object with the coding session and reuse it on
 * resume; calling this again intentionally selects a new context version.
 * root is a coordinator-owned directory outside repository worktrees.
 */
export function prepareCodingContext(store: Store, args: {
  repo: string;
  actor: string;
  baseRevision: string;
  prompt: string;
  root: string;
}): CodingContext {
  const captured = store.transact(() => {
    const knowledge = selectProjectKnowledge(store, { repo: args.repo, actor: args.actor, query: args.prompt, baseRevision: args.baseRevision });
    const skills = selectProjectSkills(store, args.repo, args.actor);
    return { identity: learningIdentity(args.repo), knowledge, skills };
  });
  // The materialized package must not become an agent-authored repository
  // change or replace native .agents, .codex, AGENTS.md, or MCP configuration.
  const root = futureRealPath(args.root);
  const fromRepo = relative(args.repo, root);
  if (!fromRepo || (!fromRepo.startsWith('..' + sep) && !isAbsolute(fromRepo) && fromRepo !== '..')) throw Error('Store managed coding context outside the project worktree.');
  const supplied = materializeProjectSkills(captured.skills, root, 'coding');
  const directory = supplied.directory === null ? null : realpathSync(supplied.directory);
  const parts: string[] = [];
  if (captured.knowledge.revision > 0) parts.push(KNOWLEDGE_GUIDANCE, JSON.stringify(captured.knowledge));
  if (supplied.catalog.length) parts.push('Project skills supplied for this coding session. ' + PROJECT_SKILLS_GUIDANCE, JSON.stringify(supplied.catalog));
  const text = parts.length ? '\nToolroll project context, frozen when this coding session started. Native repository and home instructions, tools, and MCP configuration still apply.\n' + parts.join('\n') + '\n' : '';
  const metadata: CodingContextMetadata = {
    version: 1,
    repo: args.repo,
    identity: captured.identity,
    baseRevision: args.baseRevision,
    knowledge: {
      revision: captured.knowledge.revision,
      selectionSha256: learningSha(JSON.stringify(captured.knowledge)),
      references: captured.knowledge.references.map(({ id, title, path, sourceSha, sourceRevision }) => ({ id, title, path, sourceSha, sourceRevision })),
      omitted: captured.knowledge.omitted,
    },
    skills: {
      revision: captured.skills.revision,
      packages: supplied.catalog.map(skill => ({ name: skill.name, sha256: skill.version, skillFile: skill.skillFile })),
    },
    directory,
    files: captured.skills.packages.flatMap(skill => skill.files.map(file => ({ path: `${skill.name}/${file.path}`, sha256: fileDigest(Buffer.from(file.base64, 'base64')) }))),
  };
  return freeze({ version: CODING_CONTEXT_VERSION, text, metadata, sha256: digest(text, metadata) });
}

/** Integrity check for a persisted capture. The caller must separately recheck current account access. */
export function verifyCodingContext(context: CodingContext, repo: string, baseRevision: string): void {
  if (context.metadata.version !== 1 || context.metadata.repo !== repo || context.metadata.baseRevision !== baseRevision || !identityMatches(repo, context.metadata.identity) || context.sha256 !== digest(context.text, context.metadata)) throw Error('The coding session context could not be verified.');
  if (context.metadata.files.length && context.metadata.directory === null) throw Error('The coding session skill files are unavailable.');
  try {
    for (const file of context.metadata.files) {
      const directory = context.metadata.directory!;
      const path = join(directory, file.path);
      if (file.path.split('/').some(segment => !segment || segment === '.' || segment === '..') || isAbsolute(file.path) || realpathSync(path) !== path || !statSync(path).isFile() || fileDigest(readFileSync(path)) !== file.sha256) throw Error('Changed skill file.');
    }
  } catch (cause) { throw Error('A coding session skill file changed or is unavailable.', { cause }); }
}
