import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { provenDeadByBootChange } from './boot-identity.js';
import { containerEmptiness } from './container-state.js';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteRuntime } from './sqlite-runtime.js';
import { run } from './exec.js';
import { processMayBeAlive } from './process-liveness.js';
import { createCodexCodingProvider, type CodingProvider, type CodingProviderEvent, type CodingCustody } from './coding-provider.js';
import { verifyCodingContext, type CodingContext } from './coding-context.js';
import { codingSessionDocument, parseCodingSessionDocument } from './contracts/coding-workspace.js';
import type { CodingChanges, CodingItem, CodingQuestion, CodingRequest, CodingSession, CodingSnapshot } from './coding-types.js';

export type CodingActor = { name: string; generation: number };
export type CodingDelivery = 'rejected' | 'pending' | 'unknown';
export type CodingExpected = { revision: number; nativeThreadId: string | null; turnId: string | null };
export type CodingCommandReceipt = { status: 'accepted' | 'pending' | 'rejected' | 'uncertain'; sessionId: string | null; message: string | null };
export class CodingActionError extends Error {
  constructor(message: string, readonly delivery: CodingDelivery, readonly sessionId?: string) {
    super(message); this.name = 'CodingActionError';
  }
}
export class CodingStateConflictError extends CodingActionError {
  constructor(id: string) { super('This session changed. Inspect its latest activity before acting again.', 'rejected', id); }
}
type Options = { database: string; worktreeRoot: string; provider?: () => CodingProvider; admissionPaused?: () => boolean; authorize?: (actor: CodingActor, repo: string) => boolean; context?: (input: { repo: string; actor: string; baseRevision: string; prompt: string }) => CodingContext };
const object = (v: unknown): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const now = (): string => new Date().toISOString();
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const keyPattern = /^[a-zA-Z0-9_-]{16,100}$/;
const CODING_INSTRUCTIONS = 'Work in this dedicated project checkout. Keep the conversation concise, inspect the result, and run focused checks for changed behavior. Do not publish, push, merge, deploy, or change other projects unless the user explicitly asks. Report unverified behavior honestly.';
const busy = new Set(['starting', 'working', 'needs-input', 'stopping']);
function actionError(error: unknown, fallback: CodingDelivery, sessionId?: string): CodingActionError {
  if (error instanceof CodingActionError) return error;
  const outcome = object(error)['outcomeUnknown'];
  return new CodingActionError(error instanceof Error ? error.message : 'The coding action could not finish.', outcome === true ? 'unknown' : outcome === false ? 'rejected' : fallback, sessionId);
}

/** A native session catalog, separate from the unattended task/proof ledger. */
export class CodingWorkspace {
  private db: DatabaseSync;
  private owner = randomUUID();
  private provider: CodingProvider | null = null;
  private unsubscribe: (() => void) | null = null;
  private operations = new Set<string>();
  private commands = new Set<string>();
  private commandWaiters = new Set<() => void>();
  private operationWaiters = new Set<() => void>();
  private loaded = new Set<string>();
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private recoveryRequired = false;
  private recovering = false;
  private persistenceFailed = false;
  private pendingItems = new Map<string, { session: string; item: CodingItem }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private options: Options) {
    mkdirSync(dirname(options.database), { recursive: true, mode: 0o700 });
    this.db = new (sqliteRuntime().DatabaseSync)(options.database);
    chmodSync(options.database, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS coding_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, pid INTEGER NOT NULL, native_pid INTEGER, clean INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS coding_session (id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL, repo TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS coding_item (session TEXT NOT NULL, id TEXT NOT NULL, position INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, UNIQUE(session,id));
      CREATE TABLE IF NOT EXISTS coding_request (token TEXT PRIMARY KEY, session TEXT NOT NULL, rpc_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coding_submission (session TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, error TEXT, PRIMARY KEY(session,key));`);
    this.db.exec('CREATE TABLE IF NOT EXISTS coding_custody (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS coding_command (owner TEXT NOT NULL, generation INTEGER NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, session TEXT, message TEXT, PRIMARY KEY(owner,generation,key))');
    this.db.exec("CREATE INDEX IF NOT EXISTS coding_native_thread ON coding_session(json_extract(document,'$.nativeThreadId'))");
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT * FROM coding_owner WHERE singleton=1').get();
      if (prior && prior['token'] !== '' && processMayBeAlive(Number(prior['pid']), false)) throw Error('Another Toolroll server owns the coding workspace. Use that server or stop it first.');
      const clean = !prior || prior['clean'] === 1;
      this.recoveryRequired = !clean;
      this.db.prepare('INSERT OR REPLACE INTO coding_owner VALUES(1,?,?,?,?)').run(this.owner, process.pid, prior?.['native_pid'] as number ?? null, clean ? 1 : 0);
      for (const row of this.db.prepare('SELECT document FROM coding_session').all()) {
        const session = parseCodingSessionDocument(String(row['document']));
        if (session.status !== 'closed' && (!clean || busy.has(session.status))) this.save({ ...session, status: clean ? 'interrupted' : 'uncertain', turnId: null, error: clean ? null : 'The previous server stopped without a verified process exit. Work is preserved; session recovery needs a process check before resuming.' });
      }
      this.db.prepare("UPDATE coding_request SET status='withdrawn' WHERE status='pending'").run();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }

  private authorize(actor: CodingActor, repo: string): void {
    if (this.options.authorize && !this.options.authorize(actor, repo)) throw Error('Your access to this project changed. Sign in again.');
  }

  private read(id: string): CodingSession {
    const row = this.db.prepare('SELECT document FROM coding_session WHERE id=?').get(id);
    if (!row) throw Error('Coding session unavailable.');
    return parseCodingSessionDocument(String(row['document']));
  }

  private admit(): void {
    if (this.closed || this.closing || this.persistenceFailed) throw new CodingActionError('The coding server is closing or cannot save activity. Reopen it after recovery.', 'rejected');
    if (this.options.admissionPaused?.()) throw new CodingActionError('Toolroll is preparing an update. Finish or stop current work; new coding turns can start after the update.', 'rejected');
  }

  private releaseOperation(id: string): void {
    this.operations.delete(id);
    if (!this.operations.size) { for (const resolve of this.operationWaiters) resolve(); this.operationWaiters.clear(); }
  }

  list(actor: CodingActor): CodingSession[] {
    return this.db.prepare('SELECT document FROM coding_session WHERE owner=? AND generation=? ORDER BY rowid DESC').all(actor.name, actor.generation).map(row => parseCodingSessionDocument(String(row['document'])));
  }

  /** Inspect a fixed metadata window before loading admitted documents.
   * A filtered window can be short without proving the entire list empty. */
  listBounded(actor: CodingActor, options: { limit: number; repo?: string; authorized: (repo: string) => boolean }): { sessions: CodingSession[]; truncated: boolean } {
    const rows = options.repo === undefined
      ? this.db.prepare('SELECT id,repo FROM coding_session WHERE owner=? AND generation=? ORDER BY rowid DESC LIMIT 101').all(actor.name, actor.generation)
      : this.db.prepare('SELECT id,repo FROM coding_session WHERE owner=? AND generation=? AND repo=? ORDER BY rowid DESC LIMIT 101').all(actor.name, actor.generation, options.repo);
    const window = rows.slice(0, 100);
    const admitted = window.filter(row => options.authorized(String(row['repo'])));
    const selected = admitted.slice(0, Math.min(100, Math.max(1, options.limit)));
    return { sessions: selected.map(row => this.get(String(row['id']), actor)), truncated: rows.length > window.length || admitted.length > selected.length };
  }

  get(id: string, actor: CodingActor): CodingSession {
    const row = this.db.prepare('SELECT document FROM coding_session WHERE id=? AND owner=? AND generation=?').get(id, actor.name, actor.generation);
    if (!row) throw Error('This coding session is not available to your account.');
    const session = parseCodingSessionDocument(String(row['document']));
    this.authorize(actor, session.repo);
    return session;
  }

  snapshot(id: string, actor: CodingActor): CodingSnapshot {
    const session = this.get(id, actor);
    const items = this.db.prepare('SELECT payload FROM coding_item WHERE session=? ORDER BY position').all(id).map(row => JSON.parse(String(row['payload'])) as CodingItem);
    const requests = this.db.prepare("SELECT payload FROM coding_request WHERE session=? AND status='pending' ORDER BY rowid").all(id).map(row => JSON.parse(String(row['payload'])) as CodingRequest);
    const revision = Number(this.db.prepare('SELECT revision FROM coding_session WHERE id=?').get(id)?.['revision']);
    return { session, items, requests, revision };
  }

  /** Bounded transport read: query only the recent window plus one row
   * for omission detection. The browser's full snapshot remains unchanged. */
  snapshotBounded(id: string, actor: CodingActor): CodingSnapshot & { truncated: boolean } {
    const session = this.get(id, actor);
    const itemRows = this.db.prepare('SELECT payload FROM coding_item WHERE session=? ORDER BY position DESC LIMIT 101').all(id);
    const requestRows = this.db.prepare("SELECT payload FROM coding_request WHERE session=? AND status='pending' ORDER BY rowid LIMIT 51").all(id);
    const items = itemRows.slice(0, 100).reverse().map(row => JSON.parse(String(row['payload'])) as CodingItem);
    const requests = requestRows.slice(0, 50).map(row => JSON.parse(String(row['payload'])) as CodingRequest);
    const revision = Number(this.db.prepare('SELECT revision FROM coding_session WHERE id=?').get(id)?.['revision']);
    return { session, items, requests, revision, truncated: itemRows.length > items.length || requestRows.length > requests.length };
  }

  revision(id: string, actor: CodingActor): number {
    this.get(id, actor);
    return Number(this.db.prepare('SELECT revision FROM coding_session WHERE id=?').get(id)?.['revision']);
  }

  assertExpected(id: string, actor: CodingActor, expected?: CodingExpected): void {
    const session = this.get(id, actor);
    if (expected && (expected.revision !== this.revision(id, actor) || expected.nativeThreadId !== session.nativeThreadId || expected.turnId !== session.turnId)) throw new CodingStateConflictError(id);
  }

  /** Persist acceptance before calling the native owner. Repeating a key only
   * reads its receipt; it never repeats a mutation, including after restart. */
  async command(actor: CodingActor, key: string, request: string, check: () => void, perform: () => Promise<string>): Promise<CodingCommandReceipt> {
    if (!keyPattern.test(key)) throw Error('This operation needs a valid request ID.');
    check();
    const fingerprint = digest(request), active = `${actor.name}:${actor.generation}:${key}`;
    const row = this.db.prepare('SELECT * FROM coding_command WHERE owner=? AND generation=? AND key=?').get(actor.name, actor.generation, key);
    if (row) {
      if (row['digest'] !== fingerprint) throw Error('This request ID was already used for a different operation.');
      const status = String(row['status']) as CodingCommandReceipt['status'];
      return { status: status === 'pending' && !this.commands.has(active) ? 'uncertain' : status, sessionId: row['session'] === null ? null : String(row['session']), message: row['message'] === null ? null : String(row['message']) };
    }
    if (this.closed || this.closing || this.persistenceFailed) throw Error('The coding server cannot save activity.');
    this.db.prepare("INSERT INTO coding_command VALUES(?,?,?,?,'pending',NULL,NULL)").run(actor.name, actor.generation, key, fingerprint);
    this.commands.add(active);
    try {
      const sessionId = await perform();
      this.db.prepare("UPDATE coding_command SET status='accepted',session=?,message=NULL WHERE owner=? AND generation=? AND key=?").run(sessionId, actor.name, actor.generation, key);
      return { status: 'accepted', sessionId, message: null };
    } catch (error) {
      const failure = actionError(error, 'unknown');
      const status = failure.delivery === 'rejected' ? 'rejected' : 'uncertain';
      this.db.prepare('UPDATE coding_command SET status=?,session=?,message=? WHERE owner=? AND generation=? AND key=?').run(status, failure.sessionId ?? null, failure.message, actor.name, actor.generation, key);
      return { status, sessionId: failure.sessionId ?? null, message: failure.message };
    } finally {
      this.commands.delete(active);
      if (!this.commands.size) { for (const done of this.commandWaiters) done(); this.commandWaiters.clear(); }
    }
  }

  private save(session: CodingSession): void {
    session.updatedAt = now();
    this.db.prepare('INSERT INTO coding_session(id,owner,generation,repo,document) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,revision=revision+1').run(session.id, session.owner, session.generation, session.repo, codingSessionDocument(session));
  }

  private byThread(thread: unknown): CodingSession | null {
    if (typeof thread !== 'string') return null;
    const row = this.db.prepare("SELECT document FROM coding_session WHERE json_extract(document,'$.nativeThreadId')=?").get(thread);
    return row ? parseCodingSessionDocument(String(row['document'])) : null;
  }

  private putItem(session: string, item: CodingItem): void {
    // Re-reading unchanged native history must not invalidate the request
    // that loaded it. New or changed history still requires a fresh look.
    const saved = this.db.prepare('INSERT INTO coding_item(session,id,payload) VALUES(?,?,?) ON CONFLICT(session,id) DO UPDATE SET payload=excluded.payload WHERE coding_item.payload <> excluded.payload').run(session, item.id, JSON.stringify(item));
    if (saved.changes) this.db.prepare('UPDATE coding_session SET revision=revision+1 WHERE id=?').run(session);
    if (item.type === 'userMessage' && item.clientId) this.db.prepare("UPDATE coding_submission SET status='accepted',error=NULL WHERE session=? AND key=? AND digest=?").run(session, item.clientId, digest(item.text));
  }

  private flush(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const { session, item } of this.pendingItems.values()) this.putItem(session, item);
    this.pendingItems.clear();
  }

  private item(raw: unknown): CodingItem | null {
    const item = object(raw), id = string(item['id']), type = string(item['type']);
    if (!id || !type) return null;
    if (type === 'reasoning') return null;
    let text = string(item['text']);
    if (type === 'userMessage') text = (Array.isArray(item['content']) ? item['content'] : []).map(part => string(object(part)['text'])).filter(Boolean).join('\n');
    if (type === 'commandExecution') text = [string(item['command']), string(item['aggregatedOutput'])].filter(Boolean).join('\n\n');
    if (type === 'fileChange') text = (Array.isArray(item['changes']) ? item['changes'] : []).map(change => string(object(change)['path'])).join('\n');
    if (!text) text = string(item['summary']) || type.replace(/([a-z])([A-Z])/g, '$1 $2');
    // Detailed command output stays in native history. The workspace is a bounded projection.
    if (text.length > 100_000) text = text.slice(0, 100_000) + '\n[More output is available in the native session.]';
    const clientId = string(item['clientId']) || string(item['clientUserMessageId']);
    return { id, type, text, status: string(item['status']) || null, ...(type === 'userMessage' && clientId ? { clientId } : {}) };
  }

  private native(): CodingProvider {
    if (this.closed || this.closing || this.persistenceFailed) throw Error('The coding server cannot save activity. Reopen the workspace after the server recovers.');
    if (this.recoveryRequired) throw Error('The previous agent process needs a recovery check before starting more coding work. Its saved process record has been preserved.');
    if (this.provider === null) {
      this.provider = (this.options.provider ?? (() => createCodexCodingProvider()))();
      this.unsubscribe = this.provider.subscribe(event => this.event(event));
    }
    return this.provider;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const provider = this.native();
    this.db.prepare('UPDATE coding_owner SET clean=0 WHERE token=?').run(this.owner);
    try {
      const pending = provider.request(method, params);
      this.db.prepare('UPDATE coding_owner SET native_pid=? WHERE token=?').run(provider.processId(), this.owner);
      return await pending;
    }
    catch (error) {
      if (error instanceof Error && /^thread [a-f0-9-]+ already has an active writer$/.test(error.message)) throw Error('This conversation is open in another Codex app. Close it there, then resume here. Your changes and draft are preserved.', { cause: error });
      throw error;
    }
    finally { this.db.prepare('UPDATE coding_owner SET native_pid=? WHERE token=?').run(provider.processId(), this.owner); }
  }

  private event(event: CodingProviderEvent): void {
    if (this.closed) return;
    this.db.prepare('UPDATE coding_owner SET native_pid=? WHERE token=?').run(this.provider?.processId() ?? null, this.owner);
    if (event.kind === 'exit') {
      this.flush(); this.loaded.clear();
      for (const row of this.db.prepare('SELECT document FROM coding_session').all()) {
        const session = parseCodingSessionDocument(String(row['document']));
        if (busy.has(session.status)) this.save({ ...session, status: 'uncertain', error: 'The agent connection closed. Work is preserved; delivery and process exit need to be checked before continuing.' });
      }
      this.db.prepare("UPDATE coding_request SET status='withdrawn' WHERE status='pending'").run();
      return;
    }
    if (event.kind === 'custody') {
      this.db.prepare('INSERT OR REPLACE INTO coding_custody VALUES(1,?)').run(JSON.stringify(event.custody));
      return;
    }
    const p = event.params;
    const session = this.byThread(p['threadId']);
    if (event.kind === 'request') {
      if (!session) { this.native().reject(event.id, -32602, 'The requested coding session is not registered.'); return; }
      const kind = event.method === 'item/commandExecution/requestApproval' ? 'command' : event.method === 'item/fileChange/requestApproval' ? 'files' : event.method === 'item/tool/requestUserInput' ? 'questions' : null;
      if (kind === null) { this.native().reject(event.id, -32601, 'This interaction is not supported by the coding workspace.'); this.save({ ...session, error: `This agent requested an unsupported interaction: ${event.method}.` }); return; }
      const token = randomUUID();
      const questions: CodingQuestion[] = (Array.isArray(p['questions']) ? p['questions'] : []).map(raw => {
        const q = object(raw); return { id: string(q['id']), header: string(q['header']), question: string(q['question']), options: (Array.isArray(q['options']) ? q['options'] : []).map(rawOption => { const o = object(rawOption); return { label: string(o['label']), description: string(o['description']) }; }) };
      });
      const request: CodingRequest = { id: token, kind, method: event.method, title: kind === 'command' ? 'Allow this command?' : kind === 'files' ? 'Allow these file changes?' : 'The agent needs your answer', detail: kind === 'questions' ? '' : JSON.stringify(p, null, 2), questions };
      this.db.prepare("INSERT INTO coding_request VALUES(?,?,?,?,'pending')").run(token, session.id, JSON.stringify(event.id), JSON.stringify(request));
      this.save({ ...session, status: 'needs-input' }); return;
    }
    if (!session) return;
    if (event.method === 'serverRequest/resolved') {
      this.db.prepare("UPDATE coding_request SET status='withdrawn' WHERE session=? AND rpc_id=? AND status='pending'").run(session.id, JSON.stringify(p['requestId']));
      const pending = this.db.prepare("SELECT 1 FROM coding_request WHERE session=? AND status='pending'").get(session.id);
      this.save({ ...session, status: session.status === 'needs-input' && !pending ? 'working' : session.status });
    } else if (event.method === 'turn/started') this.save({ ...session, turnId: string(object(p['turn'])['id']) || session.turnId, status: 'working', error: null });
    else if (event.method === 'turn/completed') {
      this.flush(); const turn = object(p['turn']), status = string(turn['status']);
      this.db.prepare("UPDATE coding_request SET status='withdrawn' WHERE session=? AND status='pending'").run(session.id);
      this.save({ ...session, turnId: null, status: status === 'completed' ? 'ready' : status === 'interrupted' ? 'interrupted' : 'failed', error: status === 'failed' ? string(object(turn['error'])['message']) || 'The agent could not finish this turn.' : null });
    } else if (event.method === 'item/started' || event.method === 'item/completed') {
      const item = this.item(p['item']); if (item) { this.pendingItems.delete(`${session.id}:${item.id}`); this.putItem(session.id, item); }
    } else if (event.method === 'item/agentMessage/delta') {
      const id = string(p['itemId']), key = `${session.id}:${id}`;
      const prior = this.pendingItems.get(key)?.item ?? (() => { const row = this.db.prepare('SELECT payload FROM coding_item WHERE session=? AND id=?').get(session.id, id); return row ? JSON.parse(String(row['payload'])) as CodingItem : { id, type: 'agentMessage', text: '', status: 'inProgress' }; })();
      prior.text += string(p['delta']);
      if (prior.text.length > 100_000) prior.text = prior.text.slice(0, 100_000);
      this.pendingItems.set(key, { session: session.id, item: prior });
      if (this.flushTimer === null) this.flushTimer = setTimeout(() => {
        try { this.flush(); }
        catch { this.persistenceFailed = true; this.recoveryRequired = true; void this.provider?.close().catch(() => {}); }
      }, 50);
    }
  }

  private async git(repo: string, args: string[]): Promise<string> {
    const result = await run('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, timeoutMs: 60_000, maxBuffer: 1_048_576 });
    if (result.code !== 0) throw Error('Git could not complete this workspace operation. Check the repository and try again.');
    return result.stdout;
  }

  async start(actor: CodingActor, input: { repo: string; title: string; model: string | null; prompt: string; requestId: string }): Promise<CodingSession> {
    this.validateMessage(input.prompt, input.requestId);
    if (input.model !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.model)) throw new CodingActionError('Enter a valid model name or leave the model blank.', 'rejected');
    const title = input.title.trim().slice(0, 160) || input.prompt.trim().split('\n')[0]!.slice(0, 100);
    const id = digest(`${actor.name}:${actor.generation}:${input.requestId}`).slice(0, 32);
    const previous = this.list(actor).find(s => s.id === id);
    if (previous) {
      this.authorize(actor, previous.repo);
      const receipt = this.db.prepare('SELECT * FROM coding_submission WHERE session=? AND key=?').get(id, input.requestId);
      if (previous.repo !== realpathSync(input.repo) || previous.title !== title || previous.model !== input.model || receipt?.['digest'] !== digest(input.prompt)) throw new CodingActionError('This submission ID was already used for a different request.', 'rejected', id);
      if (receipt['status'] === 'accepted') return previous;
      throw this.receiptError(id, receipt);
    }
    if (this.operations.has(id)) throw new CodingActionError('This session is still starting. Check its delivery again shortly.', 'pending');
    this.admit();
    if (this.recoveryRequired || this.recovering) throw new CodingActionError('The coding workspace needs recovery before another session can start. Existing work is preserved.', 'unknown');
    this.operations.add(id);
    let session: CodingSession | null = null;
    let saved = false, nativeStartupAttempted = false;
    try {
      const repo = realpathSync(input.repo);
      this.authorize(actor, repo);
      const root = (await this.git(repo, ['rev-parse', '--show-toplevel'])).trim();
      if (realpathSync(root) !== repo) throw Error('Choose the root of a Git project.');
      const base = (await this.git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      const branch = `toolroll/code-${id}`, worktree = join(this.options.worktreeRoot, id);
      session = { id, owner: actor.name, generation: actor.generation, repo, title, provider: 'codex', model: input.model, branch, base, worktree, nativeThreadId: null, turnId: null, status: 'starting', error: null, createdAt: now(), updatedAt: now(), initialRequest: { requestId: input.requestId, prompt: input.prompt } };
      this.authorize(actor, repo);
      const context = this.options.context?.({ repo, actor: actor.name, baseRevision: base, prompt: input.prompt });
      if (context) { verifyCodingContext(context, repo, base); session.context = context; }
      this.save(session); saved = true;
      this.db.prepare("INSERT INTO coding_submission VALUES(?,?,?,'preparing',NULL)").run(id, input.requestId, digest(input.prompt));
      mkdirSync(this.options.worktreeRoot, { recursive: true, mode: 0o700 });
      await this.git(repo, ['worktree', 'add', '-b', branch, '--', worktree, base]);
      this.authorize(actor, repo);
      this.admit();
      nativeStartupAttempted = true;
      const result = object(await this.request('thread/start', { cwd: worktree, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', ...(input.model ? { model: input.model } : {}), developerInstructions: CODING_INSTRUCTIONS + (context?.text ?? ''), persistExtendedHistory: true }));
      const thread = object(result['thread']), nativeThreadId = string(thread['id']);
      if (!nativeThreadId) throw Error('The agent did not return a session identity.');
      session = { ...session, nativeThreadId, status: 'ready' }; this.save(session); this.loaded.add(id);
      await this.sendMessage(id, actor, input.prompt, input.requestId, true);
      return this.get(id, actor);
    } catch (error) {
      const accepted = saved && this.db.prepare("SELECT 1 FROM coding_submission WHERE session=? AND key=? AND status='accepted'").get(id, input.requestId);
      const failure = accepted ? new CodingActionError(error instanceof Error ? error.message : 'The response could not be confirmed. Check the saved session.', 'unknown', id) : actionError(error, nativeStartupAttempted && !session?.nativeThreadId ? 'unknown' : 'rejected', saved ? id : undefined);
      if (saved) {
        this.db.prepare("UPDATE coding_submission SET status=?,error=? WHERE session=? AND key=? AND status!='accepted'").run(failure.delivery === 'rejected' ? 'failed' : 'uncertain', failure.message, id, input.requestId);
        const current = this.read(id);
        this.save({ ...current, status: accepted ? current.status : failure.delivery === 'unknown' || current.status === 'uncertain' ? 'uncertain' : 'failed', error: failure.message });
      }
      throw failure;
    } finally { this.releaseOperation(id); }
  }

  private validateMessage(prompt: string, key: string): void {
    if (!prompt.trim() || Buffer.byteLength(prompt) > 64_000) throw new CodingActionError('Write a request of up to 64 KB.', 'rejected');
    if (!keyPattern.test(key)) throw new CodingActionError('This message needs a valid submission ID. Reload the page.', 'rejected');
  }

  private receiptError(id: string, receipt: Record<string, unknown> | undefined): CodingActionError {
    const status = receipt?.['status'];
    if (status === 'failed') return new CodingActionError(string(receipt?.['error']) || 'The agent rejected this request. Retry explicitly with a new message ID.', 'rejected', id);
    if ((status === 'pending' || status === 'preparing') && this.operations.has(id)) return new CodingActionError('This request is still in progress. Check its delivery again shortly.', 'pending', id);
    return new CodingActionError(string(receipt?.['error']) || 'Delivery has not been confirmed. Inspect the saved session before continuing; this request will not be sent again automatically.', 'unknown', id);
  }

  private async load(session: CodingSession): Promise<void> {
    if (session.status === 'uncertain') throw Error(session.error || 'Resolve the uncertain delivery before continuing.');
    if (this.loaded.has(session.id)) return;
    if (!session.nativeThreadId) throw Error('This session has no native conversation to resume. Start a new session.');
    await this.verifyWorktree(session);
    this.authorize({ name: session.owner, generation: session.generation }, session.repo);
    if (session.context) verifyCodingContext(session.context, session.repo, session.base);
    const result = object(await this.request('thread/resume', { threadId: session.nativeThreadId, cwd: session.worktree, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', ...(session.model ? { model: session.model } : {}), developerInstructions: CODING_INSTRUCTIONS + (session.context?.text ?? ''), persistExtendedHistory: true }));
    const thread = object(result['thread']);
    if (thread['id'] !== session.nativeThreadId) throw Error('The agent returned a different conversation. Continuity could not be verified.');
    this.importHistory(session.id, thread);
    this.authorize({ name: session.owner, generation: session.generation }, session.repo);
    this.loaded.add(session.id);
  }

  private importHistory(id: string, thread: Record<string, unknown>): void {
    for (const rawTurn of Array.isArray(thread['turns']) ? thread['turns'] : []) for (const raw of Array.isArray(object(rawTurn)['items']) ? object(rawTurn)['items'] as unknown[] : []) { const item = this.item(raw); if (item) this.putItem(id, item); }
  }

  private async verifyWorktree(session: CodingSession): Promise<void> {
    const [branch, common, original] = await Promise.all([
      this.git(session.worktree, ['symbolic-ref', '--short', 'HEAD']),
      this.git(session.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      this.git(session.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    if (branch.trim() !== session.branch || realpathSync(common.trim()) !== realpathSync(original.trim())) throw Error('This checkout no longer matches the saved project and branch. Restore that checkout before resuming.');
    await this.git(session.worktree, ['merge-base', '--is-ancestor', session.base, 'HEAD']);
  }

  private priorProcessesGone(): boolean {
    const row = this.db.prepare('SELECT payload FROM coding_custody WHERE singleton=1').get();
    if (!row) return false;
    try {
      const c = JSON.parse(String(row['payload'])) as CodingCustody;
      if (c.host !== hostname() || !Array.isArray(c.descendants) || typeof c.observationUnknown !== 'boolean') return false;
      if (provenDeadByBootChange(c)) return true;
      if (c.container) return containerEmptiness(c.container.backend, c.container.id, process.platform, c.container.identity) === 'empty';
      if (c.observationUnknown || !Number.isSafeInteger(c.pid) || Number(c.pid) <= 0) return false;
      return !processMayBeAlive(Number(c.pid), c.group) && c.descendants.every(p => !processMayBeAlive(p.pid, p.group));
    } catch { return false; }
  }

  /** Reconnect the exact native conversation. An absent receipt never proves
   * non-delivery, so an unmatched message requires an explicit review action. */
  async recover(id: string, actor: CodingActor, expected?: CodingExpected): Promise<void> {
    this.admit();
    this.assertExpected(id, actor, expected);
    const session = this.get(id, actor);
    if (session.status !== 'uncertain' || this.operations.size || this.recovering || this.closed || this.closing || this.persistenceFailed) throw new CodingActionError('Recovery is not available while another session operation is active.', 'rejected', id);
    this.recovering = true; this.operations.add(id);
    try {
      if (this.provider) {
        const active = this.db.prepare('SELECT document FROM coding_session').all().some(row => busy.has(parseCodingSessionDocument(String(row['document'])).status));
        if (active) throw new CodingActionError('Another coding turn is still active. Wait for it to finish or stop it before reconnecting the agent.', 'rejected', id);
        await this.provider.close(); this.unsubscribe?.(); this.unsubscribe = null; this.provider = null; this.loaded.clear();
      } else if (this.recoveryRequired && !this.priorProcessesGone()) throw Error('The previous agent may still be running. Its process exit could not be verified; work remains preserved.');
      this.recoveryRequired = false;
      this.db.prepare('UPDATE coding_owner SET clean=1,native_pid=NULL WHERE token=?').run(this.owner);
      await this.verifyWorktree(session);
      this.authorize(actor, session.repo);
      if (!session.nativeThreadId) {
        this.save({ ...this.get(id, actor), turnId: null, status: 'uncertain', deliveryReviewRequired: true, error: 'Codex startup could not be confirmed. Its processes are stopped. Inspect Changes, then keep the work and close this session. The original request will not be resent.' });
        return;
      }
      const result = object(await this.request('thread/read', { threadId: session.nativeThreadId, includeTurns: true }));
      const thread = object(result['thread']);
      if (thread['id'] !== session.nativeThreadId) throw Error('The saved conversation could not be verified.');
      this.importHistory(id, thread);
      const unresolved = this.db.prepare("SELECT 1 FROM coding_submission WHERE session=? AND status IN ('preparing','pending','uncertain')").get(id);
      this.save({ ...this.get(id, actor), turnId: null, status: unresolved ? 'uncertain' : 'interrupted', deliveryReviewRequired: Boolean(unresolved), error: unresolved ? 'The saved conversation is loaded, but the last message has no matching delivery receipt. Review the activity before continuing. It will not be resent.' : null });
    } finally { this.recovering = false; this.releaseOperation(id); }
  }

  async continueSaved(id: string, actor: CodingActor): Promise<void> {
    this.admit();
    const session = this.get(id, actor);
    if (!session.deliveryReviewRequired || session.status !== 'uncertain' || this.recoveryRequired || this.recovering) throw Error('Check the saved conversation before continuing.');
    this.db.prepare("UPDATE coding_submission SET status='not-retried',error=NULL WHERE session=? AND status IN ('preparing','pending','uncertain')").run(id);
    if (!session.nativeThreadId) {
      this.save({ ...session, status: 'closed', turnId: null, deliveryReviewRequired: false, error: 'Session closed without confirming startup. Your original request and checkout are preserved; nothing was resent.' });
      return;
    }
    this.save({ ...session, status: 'interrupted', deliveryReviewRequired: false, error: null });
    await this.resume(id, actor);
  }

  async send(id: string, actor: CodingActor, prompt: string, requestId: string, expected?: CodingExpected): Promise<void> {
    return this.sendMessage(id, actor, prompt, requestId, false, expected);
  }

  private async sendMessage(id: string, actor: CodingActor, prompt: string, requestId: string, initial: boolean, expected?: CodingExpected): Promise<void> {
    this.validateMessage(prompt, requestId);
    let session = this.get(id, actor);
    const receipt = this.db.prepare('SELECT * FROM coding_submission WHERE session=? AND key=?').get(id, requestId);
    if (receipt) {
      if (receipt['digest'] !== digest(prompt)) throw new CodingActionError('This message ID was already used with different text.', 'rejected', id);
      if (receipt['status'] === 'accepted') return;
      if (!(initial && receipt['status'] === 'preparing')) throw this.receiptError(id, receipt);
    }
    this.assertExpected(id, actor, expected);
    this.admit();
    if ((!initial && this.operations.has(id)) || this.recovering) throw new CodingActionError('A session operation is still in progress. Your draft is preserved.', 'rejected', id);
    if (session.status === 'uncertain') throw new CodingActionError(session.error || 'Resolve the uncertain delivery before continuing.', 'unknown', id);
    if (session.status === 'closed') throw new CodingActionError('This session is closed. Its request and checkout are preserved; start a new session to continue.', 'rejected', id);
    if (session.status === 'stopping' || session.status === 'needs-input') throw new CodingActionError(session.error || 'Finish the current action before sending another message.', 'rejected', id);
    this.operations.add(id);
    let transmissionAttempted = false;
    try {
      await this.load(session);
      this.admit();
      this.assertExpected(id, actor, expected);
      session = this.get(id, actor);
      const steering = session.status === 'working' && session.turnId !== null;
      if (initial) this.db.prepare("UPDATE coding_submission SET status='pending',error=NULL WHERE session=? AND key=? AND status='preparing'").run(id, requestId);
      else this.db.prepare("INSERT INTO coding_submission VALUES(?,?,?,'pending',NULL)").run(id, requestId, digest(prompt));
      this.save({ ...session, status: 'working', error: null });
      transmissionAttempted = true;
      const result = object(await this.request(steering ? 'turn/steer' : 'turn/start', { threadId: session.nativeThreadId, input: [{ type: 'text', text: prompt }], clientUserMessageId: requestId, ...(steering ? { expectedTurnId: session.turnId } : {}) }));
      this.db.prepare("UPDATE coding_submission SET status='accepted' WHERE session=? AND key=?").run(id, requestId);
      const current = this.get(id, actor), turnId = string(result['turnId']) || string(object(result['turn'])['id']);
      if (current.status === 'working' && turnId) this.save({ ...current, turnId });
    } catch (error) {
      if (error instanceof CodingStateConflictError) throw error;
      const accepted = this.db.prepare("SELECT 1 FROM coding_submission WHERE session=? AND key=? AND status='accepted'").get(id, requestId);
      const failure = accepted ? new CodingActionError(error instanceof Error ? error.message : 'The response could not be confirmed. Check the saved session.', 'unknown', id) : actionError(error, transmissionAttempted ? 'unknown' : 'rejected', id);
      const uncertain = failure.delivery !== 'rejected';
      const message = uncertain && !accepted ? 'The connection closed before delivery was confirmed. Your message may have reached the agent; it will not be sent again automatically.' : failure.message;
      this.db.prepare("UPDATE coding_submission SET status=?,error=? WHERE session=? AND key=? AND status!='accepted'").run(uncertain ? 'uncertain' : 'failed', message, id, requestId);
      const current = this.read(id);
      // A refused draft does not fail the saved turn. Unknown reconnects still
      // require reconciliation even when this message never reached transport.
      this.save({ ...current, status: accepted || (!transmissionAttempted && !uncertain) ? current.status : uncertain ? 'uncertain' : current.turnId ? current.status : 'failed', error: message });
      throw new CodingActionError(message, failure.delivery, id);
    } finally { if (!initial) this.releaseOperation(id); }
  }

  async resume(id: string, actor: CodingActor, expected?: CodingExpected): Promise<void> {
    this.admit();
    this.assertExpected(id, actor, expected);
    const session = this.get(id, actor);
    if (session.status === 'closed') throw new CodingActionError('This session is closed. Its request and checkout are preserved; start a new session to continue.', 'rejected', id);
    if (busy.has(session.status) || this.operations.has(id) || this.recovering) throw new CodingActionError('The session is already active.', 'rejected', id);
    this.operations.add(id);
    try { await this.load(session); this.save({ ...this.get(id, actor), status: 'ready', error: null }); }
    finally { this.releaseOperation(id); }
  }

  async stop(id: string, actor: CodingActor, expected?: CodingExpected): Promise<void> {
    this.assertExpected(id, actor, expected);
    const session = this.get(id, actor);
    if (!session.nativeThreadId || !session.turnId || !busy.has(session.status)) throw new CodingActionError('There is no running turn to stop.', 'rejected', id);
    for (const row of this.db.prepare("SELECT token,rpc_id,payload FROM coding_request WHERE session=? AND status='pending'").all(id)) {
      const request = JSON.parse(String(row['payload'])) as CodingRequest;
      this.native().respond(JSON.parse(String(row['rpc_id'])) as string | number, request.kind === 'questions' ? { answers: {} } : { decision: 'cancel' });
      this.db.prepare("UPDATE coding_request SET status='withdrawn' WHERE token=?").run(String(row['token']));
    }
    this.save({ ...session, status: 'stopping' });
    await this.request('turn/interrupt', { threadId: session.nativeThreadId, turnId: session.turnId });
  }

  answer(id: string, actor: CodingActor, token: string, decision: string, answers: unknown): void {
    const session = this.get(id, actor);
    const row = this.db.prepare("SELECT * FROM coding_request WHERE session=? AND token=? AND status='pending'").get(id, token);
    if (!row || session.status !== 'needs-input' || !this.loaded.has(id)) throw Error('This request is no longer waiting for an answer.');
    const request = JSON.parse(String(row['payload'])) as CodingRequest;
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw Error('Choose an available decision.');
    const result: Record<string, unknown> = request.kind === 'questions' ? { answers: decision === 'accept' ? this.validateAnswers(request, answers) : {} } : { decision };
    this.native().respond(JSON.parse(String(row['rpc_id'])) as string | number, result);
    this.db.prepare("UPDATE coding_request SET status='answered' WHERE token=?").run(token);
    const remaining = this.db.prepare("SELECT 1 FROM coding_request WHERE session=? AND status='pending'").get(id);
    this.save({ ...session, status: remaining ? 'needs-input' : 'working' });
  }

  private validateAnswers(request: CodingRequest, raw: unknown): Record<string, { answers: string[] }> {
    const answers = object(raw), result: Record<string, { answers: string[] }> = {};
    for (const q of request.questions) {
      const values = object(answers[q.id])['answers'];
      if (!Array.isArray(values) || values.length < 1 || values.length > 10 || values.some(v => typeof v !== 'string' || v.length > 16_000)) throw Error('Answer each question before continuing.');
      result[q.id] = { answers: values as string[] };
    }
    return result;
  }

  async changes(id: string, actor: CodingActor): Promise<CodingChanges> {
    const session = this.get(id, actor);
    const [head, status, tracked, untracked] = await Promise.all([
      this.git(session.worktree, ['rev-parse', 'HEAD']), this.git(session.worktree, ['status', '--short']),
      run('git', ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', session.base, '--'], { cwd: session.worktree, timeoutMs: 60_000, maxBuffer: 1_048_576 }),
      this.git(session.worktree, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    let diff = tracked.stdout, truncated = tracked.code !== 0;
    // git's no-index diff describes symlinks themselves; it does not follow a
    // new link out of the checkout to display its target's contents.
    const paths = untracked.split('\0').filter(Boolean);
    for (let index = 0; index < paths.length; index++) {
      if (index >= 100 || Buffer.byteLength(diff) >= 1_048_576) { truncated = true; break; }
      const part = await run('git', ['--no-optional-locks', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', paths[index]!], { cwd: session.worktree, timeoutMs: 60_000, maxBuffer: 131_072 });
      diff += part.stdout;
      if (part.code !== 0 && part.code !== 1) truncated = true;
    }
    if (Buffer.byteLength(diff) > 1_048_576) { diff = Buffer.from(diff).subarray(0, 1_048_576).toString('utf8'); truncated = true; }
    this.authorize(actor, session.repo);
    return { head: head.trim(), status, diff, truncated };
  }

  close(): Promise<void> {
    return this.closePromise ??= this.closeOnce();
  }

  private async closeOnce(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    let persistenceError: unknown;
    try { this.flush(); }
    catch (error) { persistenceError = error; this.persistenceFailed = true; this.recoveryRequired = true; }
    let shutdownError: unknown;
    try { if (this.provider) await this.provider.close(); }
    catch (error) { shutdownError = error; }
    if (this.operations.size) await new Promise<void>(resolve => this.operationWaiters.add(resolve));
    if (this.commands.size) await new Promise<void>(resolve => this.commandWaiters.add(resolve));
    // Saving the last delta must never be a prerequisite for stopping the
    // owned agent. A failed save still fences installation and clean release.
    if (persistenceError || this.persistenceFailed) throw Error('Coding activity could not be saved. Agent cleanup was attempted; preserve the catalog and repair storage before restarting.', { cause: persistenceError });
    if (shutdownError) throw shutdownError;
    // Closing this new server cannot establish the exit of a previous runtime.
    if (this.recoveryRequired) {
      this.db.prepare("UPDATE coding_owner SET token='',pid=0 WHERE token=?").run(this.owner);
      this.closed = true; this.db.close(); return;
    }
    for (const row of this.db.prepare('SELECT document FROM coding_session').all()) {
      const session = parseCodingSessionDocument(String(row['document']));
      const uncertain = this.db.prepare("SELECT 1 FROM coding_submission WHERE session=? AND status IN ('preparing','pending','uncertain')").get(session.id);
      if (!uncertain && (busy.has(session.status) || session.status === 'uncertain')) this.save({ ...session, status: 'interrupted', turnId: null, error: null });
    }
    this.closed = true; this.unsubscribe?.();
    this.db.prepare("UPDATE coding_owner SET token='',pid=0,native_pid=NULL,clean=1 WHERE token=?").run(this.owner);
    this.db.close();
  }
}
