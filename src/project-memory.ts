/**
 * Project memory (2026-09-21): the durable "why" beside project knowledge
 * and lessons, in the same database. A decision is one settled choice with
 * its rationale, who made it, when, and where it came from; it is never
 * an instruction or a permission. One search index (SQLite FTS5) spans
 * instructions, references, lessons, decisions and the conversations a
 * person may read, scoped per project and audience. Nothing here calls a
 * model; the backward pass that proposes edits lives in memory-pass.ts.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { Store } from './store.js';
import { scanForSecrets } from './evidence.js';
import { learningIdentity } from './project-learning.js';
import { TEXT_LIMITS } from './text-limits.js';
import { contractError } from './contracts/contract.js';
import { DECISION_CHANGE_VERSION, decisionChangeSchema, decisionRecordSchema, decisionSchema, type Decision, type DecisionChange, type DecisionDraft, type DecisionLine, type DecisionRecord } from './contracts/project-memory.js';

export type { Decision, DecisionDraft, DecisionLine };

export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS project_decision (
 id INTEGER PRIMARY KEY, repo TEXT NOT NULL, identity TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 claim TEXT NOT NULL, why TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','superseded','retired')),
 supersedes INTEGER REFERENCES project_decision(id),
 decided_by TEXT NOT NULL, decided_at TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('conversation','task','result','manual','backward-pass')),
 source_ref TEXT, recorded_by TEXT NOT NULL, sha TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_decision_repo ON project_decision(repo, status, id);
CREATE TABLE IF NOT EXISTS decision_change (
 id INTEGER PRIMARY KEY, decision INTEGER NOT NULL REFERENCES project_decision(id), revision INTEGER NOT NULL,
 actor TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, sha TEXT NOT NULL,
 UNIQUE(decision, revision)
);
CREATE TRIGGER IF NOT EXISTS decision_change_no_update BEFORE UPDATE ON decision_change BEGIN SELECT RAISE(ABORT,'Decision history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS decision_change_no_delete BEFORE DELETE ON decision_change BEGIN SELECT RAISE(ABORT,'Decision history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS project_decision_no_delete BEFORE DELETE ON project_decision BEGIN SELECT RAISE(ABORT,'Decisions are retired, never deleted'); END;
CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(kind UNINDEXED, ref UNINDEXED, repo UNINDEXED, scope UNINDEXED, title, body, tokenize='unicode61');
-- The backward pass (memory-pass.ts): sessions analysed once per surface
-- version, gaps that accumulate corroboration across runs, and the
-- proposals a person accepts or rejects. Rejections are remembered.
CREATE TABLE IF NOT EXISTS memory_session (
 id TEXT PRIMARY KEY, repo TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('claude','codex','lead','crew')),
 source TEXT NOT NULL, seen_at TEXT NOT NULL, surface TEXT NOT NULL, trace_sha TEXT NOT NULL,
 analyzed_at TEXT, verdict TEXT, problem TEXT
);
CREATE INDEX IF NOT EXISTS memory_session_repo ON memory_session(repo, seen_at);
CREATE TABLE IF NOT EXISTS memory_gap (
 id INTEGER PRIMARY KEY, repo TEXT NOT NULL, key TEXT NOT NULL, mistake TEXT NOT NULL, proposed TEXT NOT NULL,
 domain TEXT NOT NULL CHECK(domain IN ('project','orchestration')), first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
 retired_at TEXT, retired_reason TEXT, UNIQUE(repo, key)
);
CREATE TABLE IF NOT EXISTS memory_sighting (
 gap INTEGER NOT NULL REFERENCES memory_gap(id), session TEXT NOT NULL REFERENCES memory_session(id),
 at TEXT NOT NULL, quote TEXT NOT NULL, PRIMARY KEY(gap, session)
);
CREATE TABLE IF NOT EXISTS memory_proposal (
 id INTEGER PRIMARY KEY, repo TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('instruction-add','instruction-remove','decision-add')),
 fingerprint TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL, before_text TEXT, after_text TEXT NOT NULL,
 evidence TEXT NOT NULL, sessions INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','stale')),
 created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, surface TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_proposal_pending ON memory_proposal(repo, status, fingerprint);
CREATE TABLE IF NOT EXISTS memory_rejection (
 repo TEXT NOT NULL, fingerprint TEXT NOT NULL, rejected_at TEXT NOT NULL, rejected_by TEXT NOT NULL, sessions INTEGER NOT NULL, PRIMARY KEY(repo, fingerprint)
);
`;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
function clean(value: string, bytes: number, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw Error(`${label} is required.`);
  if (Buffer.byteLength(trimmed) > bytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f�]/u.test(trimmed)) throw Error(`${label} is too long or is not readable text.`);
  if (scanForSecrets(trimmed).length) throw Error('Remove credentials or secrets before saving.');
  return trimmed;
}
function admission(store: Store, repo: string, actor: string, write = false): string {
  if (!store.schemaCurrent() || !store.accountCanAccess(actor, repo) || (write && store.accountOf(actor)?.role !== 'approver')) throw Error('Project memory is outside your access.');
  return learningIdentity(repo);
}
/** A decision row through its schema; null when the row does not read as one (it is then unverifiable). */
function decisionOf(row: Record<string, unknown>): Decision | null {
  const read = decisionSchema.safeParse({ id: Number(row['id']), repo: String(row['repo']), revision: Number(row['revision']), claim: String(row['claim']), why: String(row['why']),
    status: row['status'], supersedes: row['supersedes'] === null ? null : Number(row['supersedes']),
    decidedBy: String(row['decided_by']), decidedAt: String(row['decided_at']), sourceKind: row['source_kind'],
    sourceRef: row['source_ref'] === null ? null : String(row['source_ref']), recordedBy: String(row['recorded_by']) });
  return read.success ? read.data : null;
}
const digestOf = (d: DecisionRecord): string => sha(JSON.stringify([d.repo, d.revision, d.claim, d.why, d.status, d.supersedes, d.decidedBy, d.decidedAt, d.sourceKind, d.sourceRef, d.recordedBy]));
/** A record or history entry through its schema before it is written; a refusal names the field. */
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const read = schema.safeParse(value);
  if (!read.success) throw Error(`This decision could not be saved: ${contractError(read.error).join('; ')}`);
  return read.data;
}
const history = (payload: Omit<DecisionChange, 'version'>): string => JSON.stringify(checked(decisionChangeSchema, { version: DECISION_CHANGE_VERSION, ...payload }));

export function listDecisions(store: Store, repo: string, actor: string, options: { status?: Decision['status'] | 'all'; limit?: number } = {}): Decision[] {
  admission(store, repo, actor);
  const status = options.status ?? 'active', limit = Math.min(200, Math.max(1, options.limit ?? 50));
  return store.handle.prepare(`SELECT * FROM project_decision WHERE repo=? AND (?='all' OR status=?) ORDER BY id DESC LIMIT ?`).all(repo, status, status, limit)
    .flatMap(row => { const d = decisionOf(row as Record<string, unknown>); return d === null ? [] : [d]; })
    .filter(d => digestOf(d) === String((store.handle.prepare('SELECT sha FROM project_decision WHERE id=?').get(d.id) as Record<string, unknown>)['sha']));
}
export function getDecision(store: Store, repo: string, actor: string, id: number): Decision | null {
  admission(store, repo, actor);
  const row = store.handle.prepare('SELECT * FROM project_decision WHERE id=? AND repo=?').get(id, repo) as Record<string, unknown> | undefined;
  if (!row) return null;
  const d = decisionOf(row);
  if (d === null || digestOf(d) !== String(row['sha'])) throw Error('This decision could not be verified.');
  return d;
}

/** Record one settled choice. A superseding decision retires the older one in the same transaction. */
export function recordDecision(store: Store, args: { repo: string; actor: string; draft: DecisionDraft }, now = new Date()): Decision {
  const identity = admission(store, args.repo, args.actor, true);
  const claim = clean(args.draft.claim, TEXT_LIMITS.decisionClaimBytes, 'The decision'), why = clean(args.draft.why, TEXT_LIMITS.decisionWhyBytes, 'The reason');
  const decidedBy = args.draft.decidedBy === undefined ? args.actor : clean(args.draft.decidedBy, TEXT_LIMITS.decisionByBytes, 'Who decided');
  const decidedAt = args.draft.decidedAt ?? now.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(decidedAt)) throw Error('When it was decided must be an ISO timestamp.');
  const sourceKind = args.draft.sourceKind ?? 'manual';
  const sourceRef = args.draft.sourceRef === undefined || args.draft.sourceRef === null ? null : clean(String(args.draft.sourceRef), TEXT_LIMITS.decisionSourceBytes, 'The source');
  return store.transact(() => {
    let supersedes: number | null = null;
    if (args.draft.supersedes !== undefined && args.draft.supersedes !== null) {
      const older = getDecision(store, args.repo, args.actor, Number(args.draft.supersedes));
      if (older === null || older.status !== 'active') throw Error('The decision being replaced is not active.');
      supersedes = older.id;
    }
    const record = checked(decisionRecordSchema, { repo: args.repo, revision: 1, claim, why, status: 'active', supersedes, decidedBy, decidedAt, sourceKind, sourceRef, recordedBy: args.actor });
    const inserted = store.handle.prepare(`INSERT INTO project_decision(repo,identity,revision,claim,why,status,supersedes,decided_by,decided_at,source_kind,source_ref,recorded_by,sha)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(args.repo, identity, 1, claim, why, 'active', supersedes, decidedBy, decidedAt, sourceKind, sourceRef, args.actor, digestOf(record));
    const id = Number(inserted.lastInsertRowid);
    store.handle.prepare('INSERT INTO decision_change(decision,revision,actor,at,action,payload,sha) VALUES (?,?,?,?,?,?,?)').run(id, 1, args.actor, now.toISOString(), 'record', history(record), digestOf(record));
    if (supersedes !== null) changeStatus(store, args.repo, args.actor, supersedes, 'superseded', `Replaced by decision ${id}.`, now);
    reindexProjectMemory(store, args.repo);
    return { id, ...record };
  });
}
function changeStatus(store: Store, repo: string, actor: string, id: number, status: 'superseded' | 'retired', reason: string, now: Date): Decision {
  const existing = getDecision(store, repo, actor, id);
  if (existing === null) throw Error('That decision is unavailable.');
  if (existing.status !== 'active') throw Error('That decision is no longer active.');
  const { id: _id, ...was } = existing;
  const next: DecisionRecord = { ...was, revision: existing.revision + 1, status };
  store.handle.prepare('UPDATE project_decision SET revision=?,status=?,sha=? WHERE id=?').run(next.revision, status, digestOf(next), id);
  store.handle.prepare('INSERT INTO decision_change(decision,revision,actor,at,action,payload,sha) VALUES (?,?,?,?,?,?,?)').run(id, next.revision, actor, now.toISOString(), status, history({ reason }), digestOf(next));
  return { id, ...next };
}
/** Retire a decision that no longer holds; history keeps it. */
export function retireDecision(store: Store, args: { repo: string; actor: string; id: number; reason: string }, now = new Date()): Decision {
  admission(store, args.repo, args.actor, true);
  const reason = clean(args.reason, TEXT_LIMITS.decisionRetireBytes, 'The reason');
  return store.transact(() => { const d = changeStatus(store, args.repo, args.actor, args.id, 'retired', reason, now); reindexProjectMemory(store, args.repo); return d; });
}
export function decisionHistory(store: Store, repo: string, actor: string, id: number): { revision: number; actor: string; at: string; action: string }[] {
  admission(store, repo, actor);
  return store.handle.prepare('SELECT revision,actor,at,action FROM decision_change WHERE decision=? ORDER BY revision').all(id)
    .map(row => ({ revision: Number(row['revision']), actor: String(row['actor']), at: String(row['at']), action: String(row['action']) }));
}

// ---- context: the lean brief ----------------------------------------------------

const COMMON = new Set(['the','and','for','with','this','that','from','have','should','will','into','our','use','not','are','was']);
const tokens = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []).filter(t => !COMMON.has(t)));
/**
 * The decisions worth one line each in a brief: relevant to the query first,
 * then newest, within a byte budget. Bodies (the why) load on demand by id,
 * so a brief never repeats what the store already holds.
 */
export function decisionLines(store: Store, repo: string, query: string, options: { limit?: number; bytes?: number } = {}): DecisionLine[] {
  const rows = store.handle.prepare("SELECT id,claim,why,decided_at FROM project_decision WHERE repo=? AND status='active' ORDER BY id DESC LIMIT 200").all(repo);
  const q = tokens(query);
  const ranked = rows.map(row => { const claim = String(row['claim']); const score = [...tokens(claim)].reduce((n, t) => n + (q.has(t) ? 3 : 0), 0) + [...tokens(String(row['why']))].reduce((n, t) => n + (q.has(t) ? 1 : 0), 0);
    return { line: { id: Number(row['id']), claim, decidedAt: String(row['decided_at']) }, score }; })
    .sort((a, b) => b.score - a.score || b.line.id - a.line.id);
  const limit = options.limit ?? 8, bytes = options.bytes ?? TEXT_LIMITS.knowledgeDecisionsBytes, out: DecisionLine[] = [];
  for (const { line } of ranked) {
    if (out.length >= limit) break;
    if (Buffer.byteLength(JSON.stringify([...out, line])) > bytes) break;
    out.push(line);
  }
  return out;
}

// ---- search ------------------------------------------------------------------------

export type MemoryHit = { kind: 'instruction' | 'reference' | 'lesson' | 'decision' | 'conversation'; ref: string; repo: string; title: string; snippet: string };

/** Rebuild the index rows for one project from the stores of record. */
export function reindexProjectMemory(store: Store, repo: string): void {
  const insert = store.handle.prepare('INSERT INTO memory_search(kind,ref,repo,scope,title,body) VALUES (?,?,?,?,?,?)');
  store.transact(() => {
    store.handle.prepare("DELETE FROM memory_search WHERE repo=? AND kind IN ('instruction','reference','lesson','decision')").run(repo);
    const knowledge = store.handle.prepare('SELECT payload FROM project_knowledge WHERE repo=?').get(repo);
    if (knowledge) {
      try {
        const saved = JSON.parse(String(knowledge['payload'])) as { instructions?: string; references?: { id: string; title: string; content: string }[] };
        if (saved.instructions) insert.run('instruction', 'instructions', repo, 'project', 'Project instructions', saved.instructions);
        for (const ref of saved.references ?? []) insert.run('reference', ref.id, repo, 'project', ref.title, ref.content);
      } catch { /* unreadable knowledge is reported by its own page */ }
    }
    for (const row of store.handle.prepare("SELECT id,payload,status FROM project_lesson WHERE repo=? AND status IN ('proposed','adopted')").all(repo)) {
      try { const p = JSON.parse(String(row['payload'])) as { observation?: string; action?: string }; insert.run('lesson', String(row['id']), repo, 'project', String(p.observation ?? '').slice(0, 200), `${p.action ?? ''} [${row['status']}]`); } catch { /* skip */ }
    }
    for (const row of store.handle.prepare("SELECT id,claim,why FROM project_decision WHERE repo=? AND status='active'").all(repo)) insert.run('decision', String(row['id']), repo, 'project', String(row['claim']), String(row['why']));
  });
}

/** Index conversation messages incrementally: private threads under their person, team conversations under their id and each project they cover. */
export function reindexConversations(store: Store): void {
  const key = 'memory-search:messages';
  const cursor = store.serviceCursor(key);
  const rows = store.handle.prepare('SELECT m.id,m.thread,m.role,m.text,t.approver FROM lead_message m JOIN lead_thread t ON t.id=m.thread WHERE m.id>? ORDER BY m.id LIMIT 500').all(cursor);
  if (rows.length === 0) return;
  const insert = store.handle.prepare('INSERT INTO memory_search(kind,ref,repo,scope,title,body) VALUES (?,?,?,?,?,?)');
  const teamOf = store.handle.prepare('SELECT id, projects_json FROM team_conversation WHERE thread=?');
  store.transact(() => {
    let last = cursor;
    for (const row of rows) {
      last = Number(row['id']);
      const text = String(row['text']).trim();
      if (!text || text.length > 20_000) continue;
      const team = teamOf.get(Number(row['thread']));
      if (team) {
        let projects: string[] = [];
        try { projects = JSON.parse(String(team['projects_json'])) as string[]; } catch { projects = []; }
        for (const repo of projects.length ? projects : ['']) insert.run('conversation', `message:${last}`, repo, `conversation:${String(team['id'])}`, `${row['role']} in a team conversation`, text);
      } else insert.run('conversation', `message:${last}`, '', `approver:${String(row['approver'])}`, `${row['role']} in a private chat`, text);
    }
    store.setServiceCursor(key, last, new Date());
  });
}

const ftsQuery = (query: string): string => {
  const terms = (query.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).slice(0, 12).map(t => `"${t.replaceAll('"', '')}"`);
  return terms.join(' ');
};

/** Search what this person may read: project entries for their projects, their own private chats, and team conversations they are in. */
export function searchMemory(store: Store, args: { actor: string; repos: readonly string[]; query: string; limit?: number }): MemoryHit[] {
  const query = args.query.trim().slice(0, 300);
  if (!query) return [];
  reindexConversations(store);
  const repos = args.repos.filter(repo => store.accountCanAccess(args.actor, repo));
  // Project entries are few; rebuilding them per search keeps the index a
  // derived view of the stores of record rather than a second source.
  for (const repo of repos) reindexProjectMemory(store, repo);
  const conversations = store.handle.prepare('SELECT conversation FROM team_participant WHERE account=? AND active=1').all(args.actor).map(row => `conversation:${String(row['conversation'])}`);
  const scopes = ['project', `approver:${args.actor}`, ...conversations];
  const match = ftsQuery(query);
  if (!match) return [];
  const rows = store.handle.prepare(`SELECT kind, ref, repo, scope, title, snippet(memory_search, 5, '[', ']', '…', 24) AS snippet FROM memory_search
    WHERE memory_search MATCH ? AND scope IN (SELECT value FROM json_each(?)) AND (repo='' OR repo IN (SELECT value FROM json_each(?))) ORDER BY bm25(memory_search) LIMIT ?`)
    .all(match, JSON.stringify(scopes), JSON.stringify(repos), Math.min(50, Math.max(1, args.limit ?? 12)));
  return rows.map(row => ({ kind: row['kind'] as MemoryHit['kind'], ref: String(row['ref']), repo: String(row['repo']), title: String(row['title']).slice(0, 200), snippet: String(row['snippet']).slice(0, 400) }));
}
