/** `toolroll memory …`: the project's decisions and one search over its
 * memory, from the terminal. Reads use the remembered local login; writes
 * record who did them. Nothing here starts a model. */
import { envelopeJson } from './envelope.js';
import { decisionHistory, getDecision, listDecisions, recordDecision, retireDecision, searchMemory, type Decision } from './project-memory.js';
import { decideProposal, defaultAnalyzer, listProposals, memoryStatus, runMemoryPass, type MemoryAnalyzer, type MemoryProposal } from './memory-pass.js';
import type { Store } from './store.js';

const flags = [
  { name: 'repo', takesValue: true, meaning: 'admitted project checkout root' },
  { name: 'why', takesValue: true, meaning: 'the reason behind a decision' },
  { name: 'reason', takesValue: true, meaning: 'why a decision no longer holds' },
  { name: 'supersedes', takesValue: true, meaning: 'the decision id this one replaces' },
  { name: 'source', takesValue: true, meaning: 'where the decision came from (conversation, task, result)' },
  { name: 'all', takesValue: false, meaning: 'include superseded and retired decisions' },
  { name: 'json', takesValue: false, meaning: 'versioned structured response' },
  { name: 'db', takesValue: true, meaning: 'local Toolroll database' },
  { name: 'decision', takesValue: true, meaning: 'accept or reject, for memory apply' },
  { name: 'sessions', takesValue: true, meaning: 'at most this many newest sessions for one pass (default 100)' },
  { name: 'no-local', takesValue: false, meaning: 'read only the plane\'s own transcripts, not local Claude Code or Codex session files' },
] as const;
export const MEMORY_DESCRIPTORS = [
  { action: 'search', synopsis: 'search decisions, instructions, references, lessons and your conversations', mutation: 'none', takesQuery: true, flags },
  { action: 'decisions', synopsis: "list a project's active decisions (--all for history)", mutation: 'none', takesQuery: false, flags },
  { action: 'show', synopsis: 'read one decision with its reason and history', mutation: 'none', takesQuery: true, flags },
  { action: 'decide', synopsis: 'record a settled choice: memory decide "<choice>" --why "<reason>" --repo PATH', mutation: 'unkeyed', takesQuery: true, flags, audience: 'operator' },
  { action: 'retire', synopsis: 'retire a decision that no longer holds: memory retire <id> --reason "<why>"', mutation: 'unkeyed', takesQuery: true, flags, audience: 'operator' },
  { action: 'propose', synopsis: 'the backward pass: read recent sessions, keep a ledger of evidenced gaps, propose a few edits (writes nothing to memory)', mutation: 'unkeyed', takesQuery: false, flags },
  { action: 'review', synopsis: 'list pending memory proposals with their evidence', mutation: 'none', takesQuery: false, flags },
  { action: 'apply', synopsis: 'decide one proposal: memory apply <id> --decision accept|reject — the only writer', mutation: 'unkeyed', takesQuery: true, flags, audience: 'operator' },
  { action: 'status', synopsis: 'surface version, instruction budget, sessions analysed, open gaps and pending proposals', mutation: 'none', takesQuery: false, flags },
] as const;
export type MemoryCliContext = { store: Store; write: (line: string) => void; json: boolean; now: Date; actor: string | null; repos: readonly string[]; evidenceRoot?: string; configDir?: string; analyzer?: MemoryAnalyzer; home?: string };

const line = (d: Decision) => `#${d.id} ${d.claim} — ${d.decidedBy}, ${d.decidedAt.slice(0, 10)}${d.status === 'active' ? '' : ` (${d.status})`}`;

export async function runMemoryCommand(positional: readonly string[], options: Map<string, string | true>, context: MemoryCliContext): Promise<number> {
  const action = positional[0];
  const command = action ? `memory ${action}` : 'memory';
  const fail = (reason: 'usage' | 'unauthenticated' | 'not-found' | 'refused', message: string) => { context.write(context.json ? envelopeJson({ ok: false, command, reason, message }) : message); return reason === 'usage' ? 2 : 1; };
  const ok = (result: Record<string, unknown>, lines: string[]) => { context.write(context.json ? envelopeJson({ ok: true, command, ...result }) : lines.join('\n')); return 0; };
  if (!MEMORY_DESCRIPTORS.some(d => d.action === action)) return fail('usage', 'Use memory search <query> | decisions | show <id> | decide "<choice>" --why "<reason>" | retire <id> --reason "<why>" | propose | review | apply <id> --decision accept|reject | status, with --repo PATH.');
  if (context.actor === null) return fail('unauthenticated', 'Sign in first: the remembered local login drives memory commands.');
  const text = (key: string): string | null => { const v = options.get(key); return typeof v === 'string' ? v : null; };
  const repo = text('repo') ?? (context.repos.length === 1 ? context.repos[0]! : null);
  if (action === 'search') {
    const query = positional.slice(1).join(' ').trim();
    if (!query) return fail('usage', 'Give a search query.');
    const hits = searchMemory(context.store, { actor: context.actor, repos: repo === null ? context.repos : [repo], query, limit: 20 });
    return ok({ hits }, hits.length === 0 ? ['Nothing in project memory matches.'] : hits.map(h => `${h.kind}${h.kind === 'decision' || h.kind === 'lesson' ? ` #${h.ref}` : ''} · ${h.title}\n  ${h.snippet}`));
  }
  if (repo === null) return fail('usage', 'Use --repo with the project checkout root.');
  if (!context.repos.includes(repo)) return fail('not-found', 'That project is outside your access.');
  try {
    if (action === 'decisions') {
      const decisions = listDecisions(context.store, repo, context.actor, { status: options.has('all') ? 'all' : 'active', limit: 100 });
      return ok({ decisions }, decisions.length === 0 ? ['No decisions recorded for this project.'] : decisions.map(line));
    }
    if (action === 'show') {
      const id = Number(positional[1]);
      if (!Number.isSafeInteger(id) || id < 1) return fail('usage', 'memory show <decision id>');
      const decision = getDecision(context.store, repo, context.actor, id);
      if (decision === null) return fail('not-found', 'No such decision in this project.');
      const history = decisionHistory(context.store, repo, context.actor, id);
      return ok({ decision, history }, [line(decision), `Why: ${decision.why}`, `Source: ${decision.sourceKind}${decision.sourceRef ? ` · ${decision.sourceRef}` : ''}`, ...history.map(h => `  v${h.revision} ${h.action} by ${h.actor} at ${h.at.slice(0, 16).replace('T', ' ')}`)]);
    }
    if (action === 'decide') {
      const claim = positional.slice(1).join(' ').trim(), why = text('why') ?? '';
      if (!claim || !why) return fail('usage', 'memory decide "<choice in one sentence>" --why "<reason>" [--supersedes <id>] [--source <ref>]');
      const supersedes = text('supersedes');
      const decision = recordDecision(context.store, { repo, actor: context.actor, draft: { claim, why, sourceKind: 'manual', ...(text('source') === null ? {} : { sourceRef: text('source') }), ...(supersedes === null ? {} : { supersedes: Number(supersedes) }) } }, context.now);
      return ok({ decision }, [`Recorded ${line(decision)}`]);
    }
    if (action === 'status') {
      const status = memoryStatus(context.store, repo, context.actor);
      return ok({ status }, [`Surface ${status.surface} · instructions ${status.instructionBytes}/${status.budgetBytes} bytes`, `Sessions: ${status.sessions.total} seen, ${status.sessions.analyzed} analysed, ${status.sessions.failed} failed`, `Open gaps: ${status.openGaps} · pending proposals: ${status.pending}`, ...status.included.map(one => `${one.kind} ${one.title}: ${one.words}`), ...(status.included.length === 0 ? [] : ['Last included is counted in runs; lead chats aren\'t counted.'])]);
    }
    const proposalLine = (p: MemoryProposal) => `#${p.id} ${p.kind} · ${p.title} (${p.sessions} sessions${p.status === 'pending' ? '' : `, ${p.status}`})\n  ${p.rationale}${p.afterText ? `\n  → ${p.afterText}` : ''}${p.beforeText ? `\n  ← ${p.beforeText}` : ''}${p.evidence.map(e => `\n  "${e.quote.slice(0, 160)}" — ${e.session.split(':')[0]}`).join('')}`;
    if (action === 'review') {
      const proposals = listProposals(context.store, repo, options.has('all') ? 'all' : 'pending');
      return ok({ proposals }, proposals.length === 0 ? ['No proposals waiting. Run memory propose after more sessions.'] : proposals.map(proposalLine));
    }
    if (action === 'propose') {
      const sessions = text('sessions');
      const max = sessions === null ? 100 : Number(sessions);
      if (!Number.isSafeInteger(max) || max < 1 || max > 1000) return fail('usage', '--sessions takes a whole number from 1 to 1000.');
      const analyzer = context.analyzer ?? defaultAnalyzer(context.store, { ...(context.configDir === undefined ? {} : { configDir: context.configDir }) });
      const report = await runMemoryPass(context.store, { repo, actor: context.actor, analyzer, maxSessions: max, local: !options.has('no-local'), ...(context.evidenceRoot === undefined ? {} : { evidenceRoot: context.evidenceRoot }), ...(context.home === undefined ? {} : { home: context.home }) }, context.now);
      return ok({ report }, [`Sessions: ${report.sessions} found, ${report.analyzed} analysed now, ${report.cached} already analysed, ${report.failed} failed`, `Open gaps: ${report.gaps} · new proposals: ${report.proposals}`, ...report.problems.slice(0, 5).map(p => `  problem: ${p}`), report.proposals > 0 ? 'Review them with memory review, then memory apply <id> --decision accept|reject.' : 'Nothing to propose yet: a gap needs the same mistake in two distinct sessions.']);
    }
    if (action === 'apply') {
      const id = Number(positional[1]), decision = text('decision');
      if (!Number.isSafeInteger(id) || id < 1 || (decision !== 'accept' && decision !== 'reject')) return fail('usage', 'memory apply <proposal id> --decision accept|reject');
      const proposal = decideProposal(context.store, { repo, actor: context.actor, id, decision }, context.now);
      return ok({ proposal }, [`${decision === 'accept' ? 'Applied' : 'Rejected'} ${proposalLine(proposal)}`]);
    }
    const id = Number(positional[1]), reason = text('reason') ?? '';
    if (!Number.isSafeInteger(id) || id < 1 || !reason) return fail('usage', 'memory retire <decision id> --reason "<why it no longer holds>"');
    const decision = retireDecision(context.store, { repo, actor: context.actor, id, reason }, context.now);
    return ok({ decision }, [`Retired ${line(decision)}`]);
  } catch (error) {
    return fail('refused', error instanceof Error ? error.message : 'Project memory refused the change.');
  }
}
