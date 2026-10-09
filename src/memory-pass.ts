/**
 * The backward pass over project memory (modelled on backpass, 2026-09-21):
 * sessions are the loss signal, the always-loaded instructions are the
 * weights, and nothing lands without verbatim evidence from at least two
 * distinct sessions and a person's accept. Four stages, all read-only until
 * apply: collect sessions (plane threads and crew runs from the database,
 * Claude Code and Codex session files on this machine), distil each to a
 * bounded trace, analyse each trace once per surface version, aggregate
 * gaps in a ledger that survives runs, then propose a few edits. `apply`
 * is the one writer, and it writes through the ordinary knowledge and
 * decision stores so every edit keeps its revision.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Store } from './store.js';
import { scanForSecrets, readVerifiedArtifact } from './evidence.js';
import { changeKnowledge, knowledgeView } from './project-knowledge.js';
import { listDecisions, recordDecision } from './project-memory.js';
import { composeLeadRequest, performLeadRequest, isDirectChatProvider, CHAT_KEY_ENV } from './converse.js';
import { performSubscriptionLeadRequest } from './subscription-chat.js';
import type { DirectChatProviderId, SubscriptionChatProviderId } from './store.js';
import { TEXT_LIMITS } from './text-limits.js';
import { contractError, parseContract } from './contracts/contract.js';
import { MEMORY_VERDICT_MODEL_SCHEMA, MEMORY_VERDICT_VERSION, memoryEvidenceSchema, memoryProposalSchema, memoryVerdictReadSchema, readSavedVerdict, savedVerdictSchema, type MemoryProposal, type Verdict } from './contracts/memory-pass.js';

export type { MemoryProposal, Verdict };

/** One session's trace, in characters (TEXT_LIMITS.memoryTrace). */
export const MEMORY_TRACE_BYTES = TEXT_LIMITS.memoryTrace;
export const MEMORY_MIN_SESSIONS = 2;
export const MEMORY_MAX_PROPOSALS = 6;
/** The project instructions' budget: the same limit knowledge holds them to. */
export const INSTRUCTION_BUDGET_BYTES = TEXT_LIMITS.knowledgeInstructionsBytes;
/** How many claims of each kind one verdict keeps. */
const VERDICT_ITEMS = 20;
export const MEMORY_GAP_MAX_AGE_MS = 90 * 24 * 3_600_000;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

// ---- 1. collect ------------------------------------------------------------------

export type MemorySource = { id: string; repo: string; kind: 'claude' | 'codex' | 'lead' | 'crew'; source: string; at: string; trace: () => string };

/** The Claude Code project directory for a checkout: the path with every slash turned into a dash. */
export const claudeProjectDir = (cwd: string, home = homedir()): string => join(home, '.claude', 'projects', cwd.replaceAll('/', '-'));

/** Coarse by design: a line that trips the secret scanner is dropped whole, named by pattern. */
function redact(text: string): string {
  const hits = new Map(scanForSecrets(text).map(hit => [hit.line, hit.name]));
  if (hits.size === 0) return text;
  return text.split('\n').map((line, index) => hits.has(index + 1) ? `[redacted ${hits.get(index + 1)}]` : line).join('\n');
}
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);
const jsonLines = (path: string): unknown[] => readFileSync(path, 'utf8').split('\n').flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Claude Code: one JSONL per session; user/assistant text verbatim, tool calls one line, results clipped, thinking dropped. */
export function distillClaude(path: string): string {
  const lines: string[] = [];
  for (const raw of jsonLines(path)) {
    const row = obj(raw), message = obj(row['message']);
    if (row['type'] !== 'user' && row['type'] !== 'assistant') continue;
    const content = message['content'];
    if (typeof content === 'string') { lines.push(`${row['type']}: ${clip(content, 4000)}`); continue; }
    for (const block of Array.isArray(content) ? content.map(obj) : []) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') lines.push(`${row['type']}: ${clip(block['text'], 4000)}`);
      else if (block['type'] === 'tool_use') lines.push(`tool ${String(block['name'])}: ${clip(JSON.stringify(block['input'] ?? {}), 160)}`);
      else if (block['type'] === 'tool_result') { const c = block['content']; lines.push(`result: ${clip(typeof c === 'string' ? c : JSON.stringify(c ?? ''), 200)}`); }
    }
  }
  return redact(lines.join('\n'));
}
/** Codex: rollout JSONL; messages and custom tool calls, outputs clipped. */
export function distillCodex(path: string): string {
  const lines: string[] = [];
  for (const raw of jsonLines(path)) {
    const row = obj(raw), payload = obj(row['payload']);
    if (row['type'] !== 'response_item') continue;
    if (payload['type'] === 'message' && (payload['role'] === 'user' || payload['role'] === 'assistant')) {
      const text = (Array.isArray(payload['content']) ? payload['content'].map(obj) : []).map(c => typeof c['text'] === 'string' ? c['text'] : '').join(' ').trim();
      if (text && !text.startsWith('<environment_context>')) lines.push(`${payload['role']}: ${clip(text, 4000)}`);
    } else if (payload['type'] === 'custom_tool_call') lines.push(`tool ${String(payload['name'])}: ${clip(String(payload['input'] ?? ''), 160)}`);
    else if (payload['type'] === 'custom_tool_call_output') lines.push(`result: ${clip(String(payload['output'] ?? ''), 200)}`);
  }
  return redact(lines.join('\n'));
}

function fileSources(repo: string, kind: 'claude' | 'codex', home: string): MemorySource[] {
  const out: MemorySource[] = [];
  if (kind === 'claude') {
    const dir = claudeProjectDir(repo, home);
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name), st = statSync(path);
      out.push({ id: `claude:${sha(path)}:${st.mtimeMs}:${st.size}`, repo, kind, source: path, at: st.mtime.toISOString(), trace: () => distillClaude(path) });
    }
    return out;
  }
  const root = join(home, '.codex', 'sessions');
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(path); } };
  const files: string[] = [];
  walk(root);
  for (const path of files) {
    const first = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
    let meta: Record<string, unknown>;
    try { meta = obj(obj(JSON.parse(first))['payload']); } catch { continue; }
    if (meta['cwd'] !== repo) continue;
    const st = statSync(path);
    out.push({ id: `codex:${sha(path)}:${st.mtimeMs}:${st.size}`, repo, kind, source: path, at: st.mtime.toISOString(), trace: () => distillCodex(path) });
  }
  return out;
}

/** The plane's own sessions: lead threads that touched the project, and finished crew runs with their handoff and check output. */
function planeSources(store: Store, repo: string, evidenceRoot: string | undefined): MemorySource[] {
  const out: MemorySource[] = [];
  const threads = store.handle.prepare(`SELECT c.thread AS thread, c.id AS conversation, MAX(m.id) AS last, MAX(m.created_at) AS at FROM team_conversation c JOIN lead_message m ON m.thread=c.thread
    WHERE EXISTS (SELECT 1 FROM json_each(c.projects_json) WHERE value=?) GROUP BY c.thread`).all(repo);
  for (const row of threads) {
    const thread = Number(row['thread']);
    out.push({ id: `lead:${thread}:${Number(row['last'])}`, repo, kind: 'lead', source: `conversation:${String(row['conversation'])}`, at: String(row['at']), trace: () => redact(
      store.handle.prepare('SELECT role,text FROM lead_message WHERE thread=? ORDER BY id LIMIT 400').all(thread).map(m => `${m['role']}: ${clip(String(m['text']), 4000)}`).join('\n')) });
  }
  const runs = store.handle.prepare(`SELECT r.id, r.role, r.finished_at, r.handoff, t.external_id FROM run r JOIN task_ref t ON t.id=r.task_ref WHERE t.repo=? AND r.role IN ('builder','repair') AND r.outcome IS NOT NULL ORDER BY r.id DESC LIMIT 100`).all(repo);
  for (const row of runs) {
    const id = Number(row['id']);
    out.push({ id: `crew:${id}`, repo, kind: 'crew', source: `run:${id}`, at: String(row['finished_at'] ?? ''), trace: () => {
      const parts = [`task ${String(row['external_id'])} · ${String(row['role'])} run ${id}`, `handoff: ${clip(String(row['handoff'] ?? ''), 6000)}`];
      if (evidenceRoot !== undefined) for (const artifact of store.artifactsFor(id).filter(a => a.kind === 'check-log' || a.kind === 'report')) {
        const read = readVerifiedArtifact(evidenceRoot, artifact);
        if (read.ok) parts.push(`${artifact.kind}: ${clip(read.content.toString('utf8').slice(-6000), 6000)}`);
      }
      const proof = store.proofVerdictFor(id);
      if (proof) parts.push(`verdict: ${proof.verdict}${proof.reasons.length ? ` — ${proof.reasons.join('; ')}` : ''}`);
      return redact(parts.join('\n'));
    } });
  }
  return out;
}

export function collectSessions(store: Store, repo: string, options: { evidenceRoot?: string; home?: string; local?: boolean } = {}): MemorySource[] {
  const home = options.home ?? homedir();
  const sources = [...planeSources(store, repo, options.evidenceRoot), ...(options.local === false ? [] : [...fileSources(repo, 'claude', home), ...fileSources(repo, 'codex', home)])];
  return sources.sort((a, b) => b.at.localeCompare(a.at));
}

// ---- 2. the surface under audit -----------------------------------------------------

export type MemorySurface = { version: string; instructions: { id: string; text: string }[]; decisions: { id: string; claim: string }[] };
/** The always-loaded surface: instruction lines with stable ids, active decisions with theirs. Its hash keys the analysis cache. */
export function memorySurface(store: Store, repo: string, actor: string): MemorySurface {
  const view = knowledgeView(store, repo, actor);
  const instructions = view.knowledge.instructions.split('\n').map(line => line.trim()).filter(Boolean).map((text, index) => ({ id: `IN-${String(index + 1).padStart(3, '0')}`, text }));
  const decisions = listDecisions(store, repo, actor, { limit: 50 }).map(d => ({ id: `DE-${d.id}`, claim: d.claim }));
  return { version: sha(JSON.stringify({ instructions, decisions })).slice(0, 16), instructions, decisions };
}

// ---- 3. analyse --------------------------------------------------------------------

export type MemoryAnalyzer = (input: { trace: string; surface: MemorySurface; openGaps: { key: string; mistake: string }[]; kind: MemorySource['kind'] }) => Promise<{ ok: true; text: string } | { ok: false; problem: string }>;

export function analysisPrompt(surface: MemorySurface, openGaps: { key: string; mistake: string }[]): string {
  return [
    'You are auditing one past session of an agent working on this project against the project memory it was given. Do not review the code. Measure how the memory steered the session and spot mistakes an instruction or a recorded decision could have prevented.',
    'INSTRUCTIONS (refer to them ONLY by id):', ...surface.instructions.map(i => `[${i.id}] ${i.text}`),
    'DECISIONS on record (refer by id):', ...surface.decisions.map(d => `[${d.id}] ${d.claim}`),
    'GAPS ALREADY ON THE BOOKS (cite the key in matchesGap when the same underlying gap):', ...openGaps.map(g => `[${g.key}] ${g.mistake}`),
    `Return ONE JSON object and nothing else, matching this JSON Schema: ${JSON.stringify(MEMORY_VERDICT_MODEL_SCHEMA)}`,
    'Rules: every item needs a verbatim quote copied from the trace or it is discarded; negative evidence outranks positive; class harm means following the instruction caused damage, non-compliance means it was ignored; a mistake caused by the harness or task framing is domain orchestration; report nothing rather than something weak; an empty array is a good answer.',
  ].join('\n');
}

/** The production analyser: one call through the configured chat provider, no tools, no history. */
export function defaultAnalyzer(store: Store, options: { configDir?: string; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; timeoutMs?: number; runner?: Parameters<typeof performSubscriptionLeadRequest>[1] }): MemoryAnalyzer {
  return async input => {
    const config = store.getChatConfig();
    if (config === null) return { ok: false, problem: 'Chat is not configured; the backward pass uses the chat model.' };
    const system = analysisPrompt(input.surface, input.openGaps);
    const dataDocument = `TRACE (${input.kind} session):\n${input.trace}`;
    const history = [{ role: 'operator' as const, text: 'Audit the trace above and return the JSON object.' }];
    if (isDirectChatProvider(config.provider)) {
      const env = options.env ?? process.env;
      let key = env[CHAT_KEY_ENV[config.provider as DirectChatProviderId]] ?? '';
      if (!key && options.configDir !== undefined) { try { key = readFileSync(join(options.configDir, `chat-key-${config.provider}`), 'utf8').trim(); } catch { key = ''; } }
      if (!key) return { ok: false, problem: `No ${config.provider} key is available for the backward pass.` };
      const request = composeLeadRequest({ provider: config.provider as DirectChatProviderId, model: config.model, key, system, dataDocument, history, tools: [] });
      const answer = await performLeadRequest(request, config.provider as DirectChatProviderId, AbortSignal.timeout(options.timeoutMs ?? 120_000), options.fetcher);
      return answer.ok ? { ok: true, text: answer.answer.text } : { ok: false, problem: answer.problem };
    }
    // The verdict's own schema is the harness's structured output, so the answer is the verdict itself.
    const answer = await performSubscriptionLeadRequest({ provider: config.provider as SubscriptionChatProviderId, model: config.model, system, dataDocument, history, tools: [], outputSchema: MEMORY_VERDICT_MODEL_SCHEMA, timeoutMs: options.timeoutMs ?? 180_000 }, options.runner);
    return answer.ok ? { ok: true, text: answer.answer.text } : { ok: false, problem: answer.problem };
  };
}

const UNREADABLE = 'The analysis was not a readable verdict.';

/**
 * Read the analyser's answer with the tolerant parse-side schema, then keep only claims whose quote
 * is really in the trace and, for an instruction's effect, whose id is on the surface audited.
 */
export function parseVerdict(text: string, trace: string, surface: MemorySurface): { ok: true; verdict: Verdict } | { ok: false; problem: string } {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, problem: UNREADABLE };
  let raw: unknown;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return { ok: false, problem: UNREADABLE }; }
  const read = parseContract(memoryVerdictReadSchema, raw);
  if (!read.ok) return { ok: false, problem: `${UNREADABLE.slice(0, -1)}: ${read.issues.slice(0, 5).map(issue => issue.line).join('; ')}` };
  const ids = new Set(surface.instructions.map(i => i.id));
  const quoted = (item: { quote: string }): boolean => item.quote.trim().length >= 12 && trace.includes(item.quote.trim());
  const list = <T extends { quote: string }>(items: ({ quote: string; claim: T | null } | null)[]): T[] => items
    .filter(item => item !== null && quoted(item)).slice(0, VERDICT_ITEMS)
    .flatMap(item => item === null || item.claim === null ? [] : [{ ...item.claim, quote: item.quote.trim() }]);
  return { ok: true, verdict: {
    positive: list(read.value.positive).filter(i => ids.has(i.instruction)),
    negative: list(read.value.negative).filter(i => ids.has(i.instruction)),
    gaps: list(read.value.gaps),
  } };
}

/** A verdict as a session keeps it: through its schema, with its version. */
const keptVerdict = (verdict: Verdict): string => JSON.stringify(savedVerdictSchema.parse({ version: MEMORY_VERDICT_VERSION, ...verdict }));

const gapKey = (mistake: string): string => sha(mistake.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).slice(0, 16);

export type PassReport = { repo: string; surface: string; sessions: number; analyzed: number; cached: number; failed: number; problems: string[]; gaps: number; proposals: number };

/**
 * Collect, distil, analyse and aggregate for one project. Never writes memory:
 * it fills the ledger and the proposal queue. Each session is analysed once
 * per surface version; a failed analysis is named and retried next run.
 */
export async function runMemoryPass(store: Store, args: { repo: string; actor: string; analyzer: MemoryAnalyzer; evidenceRoot?: string; home?: string; local?: boolean; maxSessions?: number }, now = new Date()): Promise<PassReport> {
  const surface = memorySurface(store, args.repo, args.actor);
  const sessions = collectSessions(store, args.repo, { ...(args.evidenceRoot === undefined ? {} : { evidenceRoot: args.evidenceRoot }), ...(args.home === undefined ? {} : { home: args.home }), ...(args.local === undefined ? {} : { local: args.local }) }).slice(0, args.maxSessions ?? 100);
  const report: PassReport = { repo: args.repo, surface: surface.version, sessions: sessions.length, analyzed: 0, cached: 0, failed: 0, problems: [], gaps: 0, proposals: 0 };
  const openGaps = () => store.handle.prepare("SELECT key, mistake FROM memory_gap WHERE repo=? AND retired_at IS NULL AND last_seen>=?").all(args.repo, new Date(now.getTime() - MEMORY_GAP_MAX_AGE_MS).toISOString()).map(row => ({ key: String(row['key']), mistake: String(row['mistake']) }));
  for (const session of sessions) {
    const existing = store.handle.prepare('SELECT surface, analyzed_at, verdict FROM memory_session WHERE id=?').get(session.id);
    if (existing && existing['surface'] === surface.version && existing['analyzed_at'] !== null && existing['verdict'] !== null) { report.cached++; continue; }
    let trace: string;
    try { trace = session.trace(); } catch (error) { report.failed++; report.problems.push(`${session.id}: ${error instanceof Error ? error.message : 'unreadable'}`); continue; }
    if (trace.length > MEMORY_TRACE_BYTES) trace = trace.slice(0, MEMORY_TRACE_BYTES);
    if (trace.trim().length < 40) continue;
    store.handle.prepare(`INSERT INTO memory_session(id,repo,kind,source,seen_at,surface,trace_sha) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET surface=excluded.surface, trace_sha=excluded.trace_sha, analyzed_at=NULL, verdict=NULL, problem=NULL`).run(session.id, args.repo, session.kind, session.source, session.at || now.toISOString(), surface.version, sha(trace));
    const gaps = openGaps();
    const answer = await args.analyzer({ trace, surface, openGaps: gaps, kind: session.kind });
    const parsed = answer.ok ? parseVerdict(answer.text, trace, surface) : null;
    if (parsed === null || !parsed.ok) {
      report.failed++;
      const problem = parsed === null ? (answer.ok ? UNREADABLE : answer.problem) : parsed.problem;
      report.problems.push(`${session.id}: ${problem}`);
      store.handle.prepare('UPDATE memory_session SET problem=? WHERE id=?').run(problem, session.id);
      continue;
    }
    const verdict = parsed.verdict;
    store.transact(() => {
      store.handle.prepare('UPDATE memory_session SET analyzed_at=?, verdict=?, problem=NULL WHERE id=?').run(now.toISOString(), keptVerdict(verdict), session.id);
      for (const gap of verdict.gaps) {
        if (gap.domain === 'orchestration') continue;
        const key = gap.matchesGap !== null && gaps.some(g => g.key === gap.matchesGap) ? gap.matchesGap : gapKey(gap.mistake);
        store.handle.prepare(`INSERT INTO memory_gap(repo,key,mistake,proposed,domain,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(repo,key) DO UPDATE SET last_seen=excluded.last_seen, retired_at=NULL, retired_reason=NULL`).run(args.repo, key, gap.mistake, gap.proposedInstruction, gap.domain, now.toISOString(), now.toISOString());
        const id = Number(store.handle.prepare('SELECT id FROM memory_gap WHERE repo=? AND key=?').get(args.repo, key)!['id']);
        store.handle.prepare('INSERT OR IGNORE INTO memory_sighting(gap,session,at,quote) VALUES (?,?,?,?)').run(id, session.id, now.toISOString(), gap.quote);
      }
    });
    report.analyzed++;
  }
  report.gaps = Number(store.handle.prepare('SELECT COUNT(*) AS n FROM memory_gap WHERE repo=? AND retired_at IS NULL').get(args.repo)?.['n'] ?? 0);
  report.proposals = synthesizeProposals(store, args.repo, args.actor, surface, now);
  return report;
}

// ---- 4. propose --------------------------------------------------------------------

/** A proposal row through its schema; one that does not read as a proposal names the field. */
function proposalOf(row: Record<string, unknown>): MemoryProposal {
  const read = memoryProposalSchema.safeParse({ id: Number(row['id']), repo: String(row['repo']), kind: row['kind'], fingerprint: String(row['fingerprint']), title: String(row['title']), rationale: String(row['rationale']),
    beforeText: row['before_text'] === null ? null : String(row['before_text']), afterText: String(row['after_text']), evidence: JSON.parse(String(row['evidence'])),
    sessions: Number(row['sessions']), status: String(row['status']), createdAt: String(row['created_at']), surface: String(row['surface']) }, { reportInput: true });
  if (!read.success) throw Error(`Memory proposal ${String(row['id'])} could not be read: ${contractError(read.error).join('; ')}`);
  return read.data;
}

/**
 * Turn corroborated gaps and harm into a few proposals: an addition needs
 * the gap seen in at least two distinct sessions; a removal needs harm from
 * following the instruction in two sessions. Under the instruction budget an
 * addition is proposed only when it fits; over it, the run says so instead
 * of growing the file. A rejected fingerprint is not proposed again until
 * more sessions corroborate it.
 */
export function synthesizeProposals(store: Store, repo: string, actor: string, surface: MemorySurface, now = new Date()): number {
  const view = knowledgeView(store, repo, actor);
  const budgetLeft = INSTRUCTION_BUDGET_BYTES - Buffer.byteLength(view.knowledge.instructions);
  let made = 0;
  store.transact(() => {
    store.handle.prepare("UPDATE memory_proposal SET status='stale' WHERE repo=? AND status='pending' AND surface<>?").run(repo, surface.version);
    const pendingFingerprints = new Set(store.handle.prepare("SELECT fingerprint FROM memory_proposal WHERE repo=? AND status='pending'").all(repo).map(row => String(row['fingerprint'])));
    const rejected = new Map(store.handle.prepare('SELECT fingerprint, sessions FROM memory_rejection WHERE repo=?').all(repo).map(row => [String(row['fingerprint']), Number(row['sessions'])]));
    const consider = (kind: MemoryProposal['kind'], fingerprint: string, title: string, rationale: string, beforeText: string | null, afterText: string, evidence: { session: string; quote: string }[]): void => {
      if (made >= MEMORY_MAX_PROPOSALS || pendingFingerprints.has(fingerprint)) return;
      const sessions = new Set(evidence.map(e => e.session)).size;
      if (sessions < MEMORY_MIN_SESSIONS || (rejected.get(fingerprint) ?? -1) >= sessions) return;
      store.handle.prepare('INSERT INTO memory_proposal(repo,kind,fingerprint,title,rationale,before_text,after_text,evidence,sessions,status,created_at,surface) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(repo, kind, fingerprint, title, rationale, beforeText, afterText, JSON.stringify(memoryEvidenceSchema.parse(evidence.slice(0, 6))), sessions, 'pending', now.toISOString(), surface.version);
      pendingFingerprints.add(fingerprint);
      made++;
    };
    // Additions from corroborated gaps.
    const gaps = store.handle.prepare("SELECT g.id, g.key, g.mistake, g.proposed FROM memory_gap g WHERE g.repo=? AND g.retired_at IS NULL AND g.domain='project' ORDER BY g.last_seen DESC").all(repo);
    for (const gap of gaps) {
      const sightings = store.handle.prepare('SELECT session, quote FROM memory_sighting WHERE gap=? ORDER BY at').all(Number(gap['id'])).map(row => ({ session: String(row['session']), quote: String(row['quote']) }));
      if (new Set(sightings.map(s => s.session)).size < MEMORY_MIN_SESSIONS) continue;
      const proposed = String(gap['proposed']).trim();
      const already = surface.instructions.some(i => i.text.toLowerCase() === proposed.toLowerCase());
      if (already) { store.handle.prepare("UPDATE memory_gap SET retired_at=?, retired_reason='covered by an instruction' WHERE id=?").run(now.toISOString(), Number(gap['id'])); continue; }
      if (Buffer.byteLength(proposed) + 1 > budgetLeft) { consider('decision-add', `budget:${String(gap['key'])}`, `Over budget: ${clip(proposed, 80)}`, `The instructions are at their 4 KB budget. Record this as a decision instead, or remove an instruction first. Mistake seen: ${String(gap['mistake'])}`, null, proposed, sightings); continue; }
      consider('instruction-add', `add:${String(gap['key'])}`, `Add: ${clip(proposed, 80)}`, `Mistake seen in ${new Set(sightings.map(s => s.session)).size} sessions: ${String(gap['mistake'])}`, null, proposed, sightings);
    }
    // Removals from harm.
    const harm = new Map<string, { session: string; quote: string }[]>();
    for (const row of store.handle.prepare("SELECT id, verdict FROM memory_session WHERE repo=? AND surface=? AND verdict IS NOT NULL").all(repo, surface.version)) {
      let kept: unknown; try { kept = JSON.parse(String(row['verdict'])); } catch { continue; }
      const verdict = readSavedVerdict(kept);
      if (!verdict.ok) continue;
      for (const item of verdict.value.negative) if (item.class === 'harm') harm.set(item.instruction, [...(harm.get(item.instruction) ?? []), { session: String(row['id']), quote: item.quote }]);
    }
    for (const [instruction, evidence] of harm) {
      const line = surface.instructions.find(i => i.id === instruction);
      if (line === undefined) continue;
      consider('instruction-remove', `remove:${sha(line.text).slice(0, 16)}`, `Remove: ${clip(line.text, 80)}`, `Following this instruction caused harm in ${new Set(evidence.map(e => e.session)).size} sessions.`, line.text, '', evidence);
    }
  });
  return made;
}

export function listProposals(store: Store, repo: string, status: 'pending' | 'all' = 'pending'): MemoryProposal[] {
  return store.handle.prepare(`SELECT * FROM memory_proposal WHERE repo=? AND (?='all' OR status=?) ORDER BY id DESC LIMIT 100`).all(repo, status, status).map(row => proposalOf(row as Record<string, unknown>));
}

/** The one writer: accept applies the edit through the knowledge or decision store as the person; reject remembers the fingerprint and its corroboration. */
export function decideProposal(store: Store, args: { repo: string; actor: string; id: number; decision: 'accept' | 'reject' }, now = new Date()): MemoryProposal {
  return store.transact(() => {
    const row = store.handle.prepare('SELECT * FROM memory_proposal WHERE id=? AND repo=?').get(args.id, args.repo) as Record<string, unknown> | undefined;
    if (!row) throw Error('That proposal is unavailable.');
    const proposal = proposalOf(row);
    if (proposal.status !== 'pending') throw Error('That proposal was already decided.');
    const surface = memorySurface(store, args.repo, args.actor);
    if (surface.version !== proposal.surface) { store.handle.prepare("UPDATE memory_proposal SET status='stale' WHERE id=?").run(proposal.id); throw Error('Project memory changed since this was proposed. Run the pass again.'); }
    if (args.decision === 'reject') {
      store.handle.prepare('INSERT INTO memory_rejection(repo,fingerprint,rejected_at,rejected_by,sessions) VALUES (?,?,?,?,?) ON CONFLICT(repo,fingerprint) DO UPDATE SET rejected_at=excluded.rejected_at, rejected_by=excluded.rejected_by, sessions=excluded.sessions')
        .run(args.repo, proposal.fingerprint, now.toISOString(), args.actor, proposal.sessions);
    } else {
      const view = knowledgeView(store, args.repo, args.actor);
      if (proposal.kind === 'instruction-add') changeKnowledge(store, { repo: args.repo, actor: args.actor, identity: view.identity, revision: view.revision, action: 'instructions', draft: { instructions: `${view.knowledge.instructions.trimEnd()}\n${proposal.afterText}`.trim() } }, now);
      else if (proposal.kind === 'instruction-remove') changeKnowledge(store, { repo: args.repo, actor: args.actor, identity: view.identity, revision: view.revision, action: 'instructions', draft: { instructions: view.knowledge.instructions.split('\n').filter(line => line.trim() !== (proposal.beforeText ?? '').trim()).join('\n').trim() } }, now);
      else recordDecision(store, { repo: args.repo, actor: args.actor, draft: { claim: proposal.afterText, why: proposal.rationale, sourceKind: 'backward-pass', sourceRef: `proposal:${proposal.id}` } }, now);
      const key = proposal.fingerprint.split(':').slice(1).join(':');
      store.handle.prepare("UPDATE memory_gap SET retired_at=?, retired_reason='accepted into memory' WHERE repo=? AND key=?").run(now.toISOString(), args.repo, key);
    }
    store.handle.prepare('UPDATE memory_proposal SET status=?, decided_by=?, decided_at=? WHERE id=?').run(args.decision === 'accept' ? 'accepted' : 'rejected', args.actor, now.toISOString(), proposal.id);
    return { ...proposal, status: args.decision === 'accept' ? 'accepted' : 'rejected' };
  });
}

export function memoryStatus(store: Store, repo: string, actor: string): { surface: string; instructionBytes: number; budgetBytes: number; sessions: { total: number; analyzed: number; failed: number }; openGaps: number; pending: number } {
  const surface = memorySurface(store, repo, actor);
  const view = knowledgeView(store, repo, actor);
  const counts = store.handle.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN analyzed_at IS NOT NULL THEN 1 ELSE 0 END) AS analyzed, SUM(CASE WHEN problem IS NOT NULL THEN 1 ELSE 0 END) AS failed FROM memory_session WHERE repo=?').get(repo)!;
  return { surface: surface.version, instructionBytes: Buffer.byteLength(view.knowledge.instructions), budgetBytes: INSTRUCTION_BUDGET_BYTES,
    sessions: { total: Number(counts['total'] ?? 0), analyzed: Number(counts['analyzed'] ?? 0), failed: Number(counts['failed'] ?? 0) },
    openGaps: Number(store.handle.prepare('SELECT COUNT(*) AS n FROM memory_gap WHERE repo=? AND retired_at IS NULL').get(repo)?.['n'] ?? 0),
    pending: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM memory_proposal WHERE repo=? AND status='pending'").get(repo)?.['n'] ?? 0) };
}
