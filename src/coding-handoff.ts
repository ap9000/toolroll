/** A committed native session enters the existing review flow, never another executor. */
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteRuntime } from './sqlite-runtime.js';
import { codingCatalogPath } from './coding-update.js';
import { updateAdmissionPaused } from './desktop-update-gate.js';
import { acceptedIdentities, learningIdentity, learningSha } from './project-learning.js';
import { fileTaskProposal } from './proposal.js';
import { parseAcceptanceCriteria, proposeGuarded } from './scope.js';
import { validateTaskText } from './task-text.js';
import { PROOF_LIMITS } from './proof.js';
import { readPreparedEvidence } from './prepared-evidence.js';
import type { CodingSession } from './coding-types.js';
import { parseCodingHandoffReceipt, type CodingHandoffReceipt } from './contracts/coding-handoff.js';
import { parseCodingSessionDocument } from './contracts/coding-workspace.js';
import type { Store } from './store.js';
import { BRANCH_PREFIXES, taskBranch } from './names.js';

const PREFIX = 'coding:';
const SHA = /^[a-f0-9]{40}$/;
const EXCLUSIONS = 'Verify the saved candidate only. Further code changes need a new review task.';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS coding_handoff (id TEXT PRIMARY KEY, payload TEXT NOT NULL, sha TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS coding_handoff_scope (id TEXT PRIMARY KEY REFERENCES coding_handoff(id), payload TEXT NOT NULL, sha TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS coding_handoff_no_update BEFORE UPDATE ON coding_handoff BEGIN SELECT RAISE(ABORT,'Coding handoff receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS coding_handoff_no_delete BEFORE DELETE ON coding_handoff BEGIN SELECT RAISE(ABORT,'Coding handoff receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS coding_handoff_scope_no_update BEFORE UPDATE ON coding_handoff_scope BEGIN SELECT RAISE(ABORT,'Coding handoff seals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS coding_handoff_scope_no_delete BEFORE DELETE ON coding_handoff_scope BEGIN SELECT RAISE(ABORT,'Coding handoff seals are immutable'); END;
`;

export type { CodingHandoffReceipt } from './contracts/coding-handoff.js';
export type CodingHandoffPreview = Pick<CodingHandoffReceipt, 'sessionId' | 'repo' | 'base' | 'candidate' | 'title' | 'originalPrompt' | 'changedPaths'>;
type ReceiptTerms = Omit<CodingHandoffReceipt, 'id' | 'taskId' | 'branch'>;
export type CodingHandoffInput = {
  sessionId: string; repo: string; base: string; candidate: string; title: string;
  goal: string; acceptance: unknown; actor: string;
};
type Handoff = { taskId: string; scopeDigest: string; receipt: CodingHandoffReceipt };

function catalog(store: Store, readOnly: boolean): DatabaseSync {
  const path = codingCatalogPath(store.handle);
  if (path === null) throw Error('This installation has no saved coding catalog.');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Not a regular catalog.');
  } catch { throw Error('The coding catalog is missing or linked. Preserve the session and restore its catalog.'); }
  const db = new (sqliteRuntime().DatabaseSync)(path, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=3000');
    for (const table of ['coding_session', 'coding_item', 'coding_submission', 'coding_request']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw Error('The coding catalog is incomplete.');
    }
    if (!readOnly) db.exec(SCHEMA);
    return db;
  } catch (error) { db.close(); throw error; }
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync('git', ['--no-optional-locks', '--no-replace-objects', '--no-lazy-fetch', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 1_048_576,
    }).trimEnd();
  } catch { throw Error('The committed coding result could not be verified in Git. Check the project and try again.'); }
}
function branchHead(repo: string, branch: string): string | null {
  try { return execFileSync('git', ['--no-optional-locks', '--no-replace-objects', '-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { if ((error as { status?: number }).status === 1) return null; throw Error('The review branch could not be inspected.'); }
}
function actorGeneration(store: Store, actor: string, repo: string): number {
  const account = store.accountOf(actor);
  if (!store.schemaCurrent() || !account || !store.isInstanceOperator(actor) || !store.accountCanAccess(actor, repo)) throw Error('An installation operator must review this coding result.');
  if (updateAdmissionPaused(store.handle)) throw Error('Toolroll is updating. Create the review task after the update finishes.');
  return account.generation;
}
function sessionFor(db: DatabaseSync, store: Store, sessionId: string, actor: string): CodingSession {
  if (!/^[a-f0-9]{32}$/.test(sessionId)) throw Error('Choose a saved coding session.');
  const row = db.prepare('SELECT owner,generation,repo,document FROM coding_session WHERE id=?').get(sessionId);
  if (!row || row['owner'] !== actor) throw Error('This coding session is not available to your account.');
  const session = parseCodingSessionDocument(String(row['document']));
  const generation = actorGeneration(store, actor, String(row['repo']));
  if (row['generation'] !== generation || session.id !== sessionId || session.owner !== actor || session.generation !== generation || session.repo !== row['repo']) throw Error('The coding session no longer matches your account or project.');
  return session;
}
function preview(db: DatabaseSync, store: Store, sessionId: string, actor: string): CodingHandoffPreview {
  const session = sessionFor(db, store, sessionId, actor);
  if (!['ready', 'interrupted', 'failed'].includes(session.status) || session.turnId !== null || session.deliveryReviewRequired ||
      db.prepare("SELECT 1 FROM coding_submission WHERE session=? AND status IN ('preparing','pending','uncertain')").get(sessionId) ||
      db.prepare("SELECT 1 FROM coding_request WHERE session=? AND status='pending'").get(sessionId)) throw Error('Finish the current coding action and resolve uncertain delivery before creating a review task.');
  if (!SHA.test(session.base)) throw Error('The coding session has no exact starting commit.');
  learningIdentity(session.repo);
  if (git(session.worktree, ['symbolic-ref', '--short', 'HEAD']) !== session.branch ||
      realpathSync(git(session.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== realpathSync(git(session.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']))) throw Error('The coding checkout no longer matches its saved project and branch.');
  if (git(session.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) !== '') throw Error('Commit the coding changes before creating a review task. Uncommitted work stays in the coding session.');
  const candidate = git(session.worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!SHA.test(candidate)) throw Error('The coding result has no exact commit.');
  git(session.repo, ['merge-base', '--is-ancestor', session.base, candidate]);
  const changedPaths = git(session.repo, ['diff', '--name-only', '--no-renames', '-z', session.base, candidate]).split('\0').filter(Boolean);
  if (!changedPaths.length) throw Error('There are no committed changes to review.');
  if (changedPaths.length > PROOF_LIMITS.changed || changedPaths.some(path => Buffer.byteLength(path) > PROOF_LIMITS.changedPath || /[\x00-\x1f\x7f]/.test(path))) throw Error('The complete coding change exceeds the current evidence limits. Split it into explicitly scoped changes before review.');
  const first = db.prepare("SELECT payload FROM coding_item WHERE session=? AND json_extract(payload,'$.type')='userMessage' ORDER BY position LIMIT 1").get(sessionId);
  const originalPrompt: unknown = first ? JSON.parse(String(first['payload'])).text : null;
  if (typeof originalPrompt !== 'string' || !originalPrompt.trim()) throw Error('The session’s original request is unavailable. Restore its conversation before creating a review task.');
  return { sessionId, repo: session.repo, base: session.base, candidate, title: session.title, originalPrompt, changedPaths };
}

export function codingHandoffPreview(store: Store, input: { sessionId: string; actor: string }): CodingHandoffPreview {
  const db = catalog(store, true);
  try { return preview(db, store, input.sessionId, input.actor); } finally { db.close(); }
}

function makeReceipt(terms: ReceiptTerms): CodingHandoffReceipt {
  const id = learningSha(JSON.stringify(terms)).slice(0, 32), taskId = `coding-review-${id}`;
  return { ...terms, id, taskId, branch: taskBranch(taskId) };
}
/** The saved bytes are verified before they are parsed; identity and branch are checked on the parsed terms. */
export function parseReceipt(row: Record<string, unknown>): CodingHandoffReceipt {
  const payload = String(row['payload']);
  if (learningSha(payload) !== row['sha']) throw Error('The coding handoff receipt could not be verified.');
  const read = parseCodingHandoffReceipt(payload);
  if (!read.ok) throw Error(`The coding handoff receipt could not be read: ${read.issues.map(issue => issue.line).join('; ')}`);
  const receipt = read.value;
  const { id, taskId, branch, ...terms } = receipt;
  const expected = makeReceipt(terms);
  if (row['id'] !== id || id !== expected.id || taskId !== expected.taskId || !BRANCH_PREFIXES.some(prefix => branch === `${prefix}${taskId}`) || !SHA.test(receipt.base) || !SHA.test(receipt.candidate)) throw Error('The coding handoff receipt identity could not be verified.');
  return receipt;
}
export function sealPayload(receipt: CodingHandoffReceipt, scopeDigest: string): string {
  return JSON.stringify({ version: 1, id: receipt.id, receiptSha256: learningSha(JSON.stringify(receipt)), scopeDigest });
}
function verifySeal(db: DatabaseSync, receipt: CodingHandoffReceipt, digest: string): void {
  const seal = db.prepare('SELECT payload,sha FROM coding_handoff_scope WHERE id=?').get(receipt.id);
  if (!seal || seal['payload'] !== sealPayload(receipt, digest) || learningSha(String(seal['payload'])) !== seal['sha']) throw Error('The coding review scope changed or its saved receipt is missing. Create a new review task for the current terms.');
}

/** Returns null only for ordinary tasks. A coding marker always requires its receipt. */
export function readCodingHandoff(store: Store, taskId: string): Handoff | null {
  const provenance = store.filedViaOf(taskId);
  if (!provenance?.startsWith(PREFIX)) return null;
  if (!/^coding:[a-f0-9]{32}$/.test(provenance)) throw Error('The coding handoff identity is invalid.');
  const db = catalog(store, true);
  try {
    const row = db.prepare('SELECT * FROM coding_handoff WHERE id=?').get(provenance.slice(PREFIX.length));
    if (!row) throw Error('The coding handoff receipt is missing. Restore it before review.');
    const receipt = parseReceipt(row), scope = store.getScope(taskId), ref = store.lookupRef(taskId);
    if (receipt.taskId !== taskId || ref?.repo !== receipt.repo || !acceptedIdentities(store, receipt.repo).has(receipt.identity) || !scope || scope.termsProblem != null || scope.candidate !== receipt.candidate) throw Error('The coding review no longer matches its saved project, candidate or scope.');
    verifySeal(db, receipt, scope.digest);
    return { taskId, scopeDigest: scope.digest, receipt };
  } finally { db.close(); }
}

/** No agent dispatch, approval, push, or modification of an existing Git ref. */
export function createCodingHandoff(store: Store, input: CodingHandoffInput): Handoff {
  const invalid = validateTaskText({ title: input.title, goal: input.goal });
  if (invalid) throw Error(invalid.message);
  if (!input.goal.trim()) throw Error('Describe what this result should achieve.');
  const parsed = parseAcceptanceCriteria(input.acceptance);
  if (parsed.problems.length || !parsed.criteria.length) throw Error(parsed.problems.map(problem => problem.message).join(' ') || 'Add at least one acceptance criterion.');
  const db = catalog(store, false);
  try {
    const shown = preview(db, store, input.sessionId, input.actor);
    if (shown.repo !== input.repo || shown.base !== input.base || shown.candidate !== input.candidate) throw Error('The coding result changed. Review the current committed result before creating its task.');
    if (parsed.criteria.some(criterion => criterion.evidence.includes('screenshot'))) readPreparedEvidence(shown.repo, shown.candidate, true);
    const receipt = makeReceipt({ ...shown, version: 1, identity: learningIdentity(input.repo), actor: input.actor,
      generation: actorGeneration(store, input.actor, input.repo), title: input.title.trim(), goal: input.goal.trim(), acceptance: parsed.criteria, outOfScope: EXCLUSIONS });
    const payload = JSON.stringify(receipt), sha = learningSha(payload);
    db.exec('BEGIN IMMEDIATE');
    let reserved = false;
    try {
      const prior = db.prepare('SELECT * FROM coding_handoff WHERE id=?').get(receipt.id);
      if (prior) {
        if (JSON.stringify(parseReceipt(prior)) !== payload) throw Error('This coding handoff conflicts with its saved receipt.');
        reserved = true;
      } else {
        if (store.lookupRef(receipt.taskId) || branchHead(input.repo, receipt.branch) !== null) throw Error('The review task or branch already exists. It has been preserved.');
        db.prepare('INSERT INTO coding_handoff VALUES(?,?,?,?)').run(receipt.id, payload, sha, new Date().toISOString());
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }

    if (store.lookupRef(receipt.taskId)) {
      const existing = readCodingHandoff(store, receipt.taskId);
      if (!reserved || !existing || JSON.stringify(existing.receipt) !== payload) throw Error('This task belongs to another handoff. It has been preserved.');
      const head = branchHead(input.repo, receipt.branch);
      if (head === null) throw Error('The saved review branch is missing. Restore it before continuing.');
      verifyCodingHandoffBase(store, { taskId: receipt.taskId, taskRef: store.lookupRef(receipt.taskId)!.id, repo: receipt.repo, branch: receipt.branch, head });
      return existing;
    }
    const current = branchHead(input.repo, receipt.branch);
    const refMessage = `Toolroll coding handoff ${sha}`;
    if (current === null) git(input.repo, ['update-ref', '--create-reflog', '-m', refMessage, `refs/heads/${receipt.branch}`, input.base, '0'.repeat(40)]);
    else if (!reserved || current !== input.base || git(input.repo, ['reflog', 'show', '-1', '--format=%gs', `refs/heads/${receipt.branch}`]) !== refMessage) throw Error('The reserved review branch changed. It has been preserved; create a new handoff.');
    // No checked-out/leased branch is adopted, even if its HEAD happens to match.
    if (git(input.repo, ['worktree', 'list', '--porcelain']).split('\n').includes(`branch refs/heads/${receipt.branch}`)) throw Error('The review branch is already checked out. Its work has been preserved.');

    return store.transact(() => {
      if (actorGeneration(store, input.actor, input.repo) !== receipt.generation) throw Error('Your account changed. Sign in again.');
      if (branchHead(input.repo, receipt.branch) !== receipt.base) throw Error('The review branch moved before filing. Its work has been preserved.');
      const made = fileTaskProposal(store, { id: receipt.taskId, title: receipt.title, repo: receipt.repo, goal: receipt.goal,
        outOfScope: receipt.outOfScope, acceptance: receipt.acceptance, filedVia: PREFIX + receipt.id, filedBy: { name: input.actor, kind: "person" as const }, planning: 'skip', admittedRepos: [receipt.repo] }, new Date());
      if (!made.ok) throw Error(made.message);
      const ref = store.lookupRef(made.id)!;
      const proposed = proposeGuarded(store, { taskId: made.id, author: input.actor, taskRef: ref.id, sawDigest: store.getScope(made.id)!.digest,
        goal: receipt.goal, outOfScope: receipt.outOfScope, acceptance: receipt.acceptance, candidate: receipt.candidate, now: new Date() });
      if (!proposed.ok) throw Error(proposed.message || 'The prepared review scope could not be saved.');
      const seal = sealPayload(receipt, proposed.scope.digest);
      const prior = db.prepare('SELECT 1 FROM coding_handoff_scope WHERE id=?').get(receipt.id);
      if (prior) verifySeal(db, receipt, proposed.scope.digest);
      else db.prepare('INSERT INTO coding_handoff_scope VALUES(?,?,?)').run(receipt.id, seal, learningSha(seal));
      // The durable sidecar seal precedes the main transaction commit. Failure
      // here rolls back the ordinary task; receipt and branch remain recoverable.
      return { taskId: made.id, scopeDigest: proposed.scope.digest, receipt };
    });
  } finally { db.close(); }
}

/** Called before setup and immediately before recording the attempt's base. */
export function verifyCodingHandoffBase(store: Store, input: { taskId: string; taskRef: number; repo: string; branch: string; head: string }): void {
  const handoff = readCodingHandoff(store, input.taskId);
  if (!handoff) return;
  const { receipt } = handoff;
  if (store.lookupRef(input.taskId)?.id !== input.taskRef || input.repo !== receipt.repo || input.branch !== receipt.branch) throw Error('The coding review is assigned to a different task, project or branch.');
  const pinned = store.firstBuilderBase(input.taskRef, input.branch);
  if (!SHA.test(input.head) || (pinned ?? input.head) !== receipt.base) throw Error('The review branch no longer starts at the coding session’s original commit. Its work has been preserved; create a new review task.');
  if (pinned !== null) git(receipt.repo, ['merge-base', '--is-ancestor', receipt.base, input.head]);
}
