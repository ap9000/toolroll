/** What the lead promised to follow up on. A commitment records the promise in the lead's words, the condition
 * that completes it, when to look next, where to report and when it lapses. The follow pass reads open ones
 * without a model and says one short line when the condition is met, on the channel the promise was made on;
 * nothing otherwise.
 * The table is additive (no schema version bump), so a build that predates it still opens the store. */
import type { Notification, Store } from './store.js';
import { assignmentOf, type AssignmentSnapshot } from './assignment.js';
import { LEAD_SAY_KIND } from './lead-voice.js';
import { leadNameOf } from './lead-identity.js';

/** The table: `LEAD_COMMITMENT_SCHEMA` in store.ts (additive, no version bump). */
export const COMMITMENT_DAYS = 7;
const DAY_MS = 86_400_000;
/** How long an unmet condition waits before it is looked at again. */
const RECHECK_MS = 30_000;
const PASS_LIMIT = 50;

export type TaskState = AssignmentSnapshot['state'];
export const TASK_STATES: readonly TaskState[] = ['working', 'checking', 'needs-decision', 'ready-to-check', 'complete', 'cancelled'];
export const RUN_OUTCOMES = ['finished', 'built', 'failed'] as const;
export const CHECK_RESULTS = ['passed', 'failed', 'either'] as const;
/** Where a promise was made, and so where it is reported: `chat` is the console or terminal conversation; a phone
 * or team chat also gets the line as the lead's own message, on that chat only. */
export const COMMITMENT_CHANNELS = ['chat', 'telegram', 'slack', 'discord', 'teams'] as const;
export type CommitmentChannel = typeof COMMITMENT_CHANNELS[number];
const PROMISE_KEY = 'lead-promise:';

/** `afterRun`: only a result newer than the one there was when the promise was made counts. */
export type CommitmentCondition =
  | { kind: 'task'; task: string; states: TaskState[] }
  | { kind: 'run'; run: number; outcome: typeof RUN_OUTCOMES[number] }
  | { kind: 'check'; task: string; result: typeof CHECK_RESULTS[number]; afterRun: number }
  | { kind: 'check'; run: number; result: typeof CHECK_RESULTS[number] }
  | { kind: 'time'; at: string };

export type Commitment = {
  id: number; owner: string; repo: string | null; thread: number; turn: number | null; channel: string;
  what: string; condition: CommitmentCondition; checkAt: string; expiresAt: string;
  state: 'open' | 'done' | 'cancelled' | 'expired'; createdAt: string; checkedAt: string | null;
  closedAt: string | null; closedBy: string | null; outcome: string | null;
};

const STATE_WORDS: Record<TaskState, string> = { working: 'being worked on', checking: 'being checked', 'needs-decision': 'waiting for you',
  'ready-to-check': 'ready for you to check', complete: 'complete', cancelled: 'cancelled' };
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function readCondition(text: string): CommitmentCondition | null {
  try {
    const value = JSON.parse(text);
    if (value?.kind === 'task' && typeof value.task === 'string' && Array.isArray(value.states) && value.states.every((one: unknown) => TASK_STATES.includes(one as TaskState))) return value;
    if (value?.kind === 'run' && Number.isSafeInteger(value.run) && RUN_OUTCOMES.includes(value.outcome)) return value;
    if (value?.kind === 'check' && CHECK_RESULTS.includes(value.result) && (typeof value.task === 'string' && Number.isSafeInteger(value.afterRun) || Number.isSafeInteger(value.run))) return value;
    if (value?.kind === 'time' && typeof value.at === 'string' && STAMP.test(value.at)) return value;
  } catch { /* unreadable: the row stays visible and is never acted on */ }
  return null;
}

function readCommitment(row: Record<string, unknown>): Commitment | null {
  const condition = readCondition(String(row['condition_json']));
  if (condition === null) return null;
  const text = (key: string) => row[key] == null ? null : String(row[key]);
  return { id: Number(row['id']), owner: String(row['owner']), repo: text('repo'), thread: Number(row['thread']), turn: row['turn'] == null ? null : Number(row['turn']),
    channel: String(row['channel']), what: String(row['what']), condition, checkAt: String(row['check_at']), expiresAt: String(row['expires_at']),
    state: String(row['state']) as Commitment['state'], createdAt: String(row['created_at']), checkedAt: text('checked_at'),
    closedAt: text('closed_at'), closedBy: text('closed_by'), outcome: text('outcome') };
}

/** The condition in a few words, for Settings and for the lead's own catch-up. */
export function conditionWords(store: Store, condition: CommitmentCondition): string {
  const title = (task: string) => `“${store.getTask(task)?.title ?? task}”`;
  if (condition.kind === 'task') return `when ${title(condition.task)} is ${condition.states.map(one => STATE_WORDS[one]).join(' or ')}`;
  if (condition.kind === 'run') return `when the attempt on ${attemptOf(store, condition.run)} ${condition.outcome === 'finished' ? 'finishes' : condition.outcome === 'built' ? 'finishes with a result' : 'fails'}`;
  if (condition.kind === 'check') {
    const on = `the checks on ${'task' in condition ? title(condition.task) : attemptOf(store, condition.run)}`;
    return `when ${on} ${condition.result === 'either' ? 'finish' : condition.result === 'passed' ? 'pass' : 'fail'}`;
  }
  return `at ${condition.at.slice(0, 16).replace('T', ' ')} UTC`;
}

/** The task an attempt belongs to, by title. */
function attemptOf(store: Store, run: number): string {
  const task = store.refById(store.getRun(run)?.taskRef ?? -1)?.externalId;
  return task === undefined ? 'that attempt' : `“${store.getTask(task)?.title ?? task}”`;
}

export type CommitInput = { owner: string; repo: string | null; thread: number; turn: number | null; channel?: string; what: string;
  condition: CommitmentCondition; checkAt?: string | null };

/** Record a promise. The caller has already proved the task, attempt or project is within the owner's access. */
export function recordCommitment(store: Store, input: CommitInput, now: Date): Commitment {
  const what = input.what.trim().replace(/\s+/g, ' ');
  if (what.length < 3 || what.length > 240) throw Error('Say what you promised in one short sentence.');
  const channel = input.channel ?? 'chat';
  if (!(COMMITMENT_CHANNELS as readonly string[]).includes(channel)) throw Error('Report on a chat this conversation uses.');
  if (readCondition(JSON.stringify(input.condition)) === null) throw Error('Choose a task, attempt, check or time to wait for.');
  const expiresAt = new Date(now.getTime() + COMMITMENT_DAYS * DAY_MS).toISOString();
  let checkAt = input.checkAt ?? now.toISOString();
  if (input.condition.kind === 'time') {
    if (input.condition.at > expiresAt) throw Error(`A promise lasts ${COMMITMENT_DAYS} days; choose a time before then.`);
    checkAt = input.condition.at > checkAt ? input.condition.at : checkAt;
  }
  if (!STAMP.test(checkAt) || checkAt > expiresAt) throw Error(`Check within the next ${COMMITMENT_DAYS} days.`);
  const id = Number(store.handle.prepare(`INSERT INTO lead_commitment (owner, repo, thread, turn, channel, what, condition_json, check_at, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.owner, input.repo, input.thread, input.turn, channel, what, JSON.stringify(input.condition), checkAt, expiresAt, now.toISOString()).lastInsertRowid);
  return getCommitment(store, id)!;
}

export function getCommitment(store: Store, id: number): Commitment | null {
  const row = store.handle.prepare('SELECT * FROM lead_commitment WHERE id = ?').get(id);
  return row === undefined ? null : readCommitment(row);
}

/** The reply that made a promise was shown: its turn is over, and it was answered or its text reached the conversation
 * before it failed. A turn still running has shown nothing yet, whatever it has written so far. */
const SHOWN = (turn: string) => `EXISTS (SELECT 1 FROM mate_turn t WHERE t.id = ${turn} AND (t.state = 'answered'
  OR t.state = 'failed' AND EXISTS (SELECT 1 FROM lead_message m WHERE m.turn = t.id AND m.role = 'assistant')))`;
/** A promise only counts once the reply that made it was shown: one from a reply still being written, or one that
 * failed without reaching the owner, was never heard. */
const HEARD = `(c.turn IS NULL OR ${SHOWN('c.turn')})`;

/** The owner's open promises that they heard, oldest first. */
export function openCommitments(store: Store, owner: string, limit = 20): Commitment[] {
  return store.handle.prepare(`SELECT c.* FROM lead_commitment c WHERE c.owner = ? AND c.state = 'open' AND ${HEARD} ORDER BY c.id LIMIT ?`).all(owner, limit)
    .map(readCommitment).filter((one): one is Commitment => one !== null);
}

/** The phone or team chat a lead message is for, when it is a met promise (`lead-promise:<channel>:<id>`); null for
 * every other notification, which goes wherever it always went. */
export function promiseChannelOf(row: Pick<Notification, 'dedupeKey'>): string | null {
  return row.dedupeKey.startsWith(PROMISE_KEY) ? row.dedupeKey.slice(PROMISE_KEY.length).split(':')[0] ?? null : null;
}

/** Stop following up. Only the owner (from Settings or through their lead) cancels; a closed one stays as it was. */
export function cancelCommitment(store: Store, owner: string, id: number, by: string, reason: string, now: Date): boolean {
  const changed = store.handle.prepare("UPDATE lead_commitment SET state = 'cancelled', closed_at = ?, closed_by = ?, outcome = ? WHERE id = ? AND owner = ? AND state = 'open'")
    .run(now.toISOString(), by, reason.trim().slice(0, 240) || 'Cancelled.', id, owner);
  return Number(changed.changes) === 1;
}

/** The newest result run for a task, for a check condition's baseline. */
export function latestResultRun(store: Store, task: string, repos: readonly string[], now: Date): number {
  return assignmentOf(store, task, now, { principal: 'operator', repos })?.receipt?.runId ?? 0;
}

/** What was observed when the condition is met, in one sentence; null while it is not. */
function observe(store: Store, one: Commitment, now: Date, root: string | undefined): string | null {
  const c = one.condition, repos = one.repo === null ? [] : [one.repo];
  const title = (task: string) => `“${store.getTask(task)?.title ?? task}”`;
  if (c.kind === 'time') return now.toISOString() >= c.at ? 'It is time.' : null;
  if (c.kind === 'task') {
    const a = assignmentOf(store, c.task, now, { principal: 'operator', repos }, root);
    return a !== null && c.states.includes(a.state) ? `${title(a.rootId)} is ${STATE_WORDS[a.state]}.` : null;
  }
  if (c.kind === 'run') {
    const run = store.getRun(c.run);
    if (run === null || run.outcome === null) return null;
    const ended = run.outcome === 'built' ? 'finished with a result' : run.outcome === 'failed' ? 'failed' : `ended (${run.outcome})`;
    if (c.outcome === 'built' && run.outcome !== 'built' || c.outcome === 'failed' && run.outcome !== 'failed') return null;
    return `The attempt on ${attemptOf(store, run.id)} ${ended}.`;
  }
  const matches = (status: string) => (status === 'passed' || status === 'failed') && (c.result === 'either' || c.result === status);
  if ('task' in c) {
    const a = assignmentOf(store, c.task, now, { principal: 'operator', repos }, root);
    const receipt = a?.receipt;
    if (!a || !receipt || receipt.runId <= c.afterRun || !matches(receipt.checks.status)) return null;
    return `The checks on ${title(a.rootId)} ${receipt.checks.status}.`;
  }
  const check = store.runCheckFor(c.run);
  if (check === null || !matches(check.status)) return null;
  return `The checks on ${attemptOf(store, c.run)} ${check.status}.`;
}

/** The promise as the end of "I said I would …": "I'll tell you when…" and "Tell you when…" both read "tell you when…". */
function promised(what: string): string {
  const bare = what.replace(/^I(?:'ll| will)\s+/i, '').replace(/[.!]+$/, '');
  return /^[A-Z][a-z]/.test(bare) ? bare.charAt(0).toLowerCase() + bare.slice(1) : bare;
}

/** One deterministic pass over due promises (no model): expire, drop what can no longer be delivered or seen,
 * and report a met condition once — the state change and the message share one transaction. Returns how many reported. */
export function checkLeadCommitments(store: Store, now: Date, root?: string): number {
  const at = now.toISOString();
  let reported = 0;
  store.handle.prepare("UPDATE lead_commitment SET state = 'expired', closed_at = ?, outcome = 'Expired after 7 days without the condition being met.' WHERE state = 'open' AND expires_at <= ?").run(at, at);
  // A promise made in a reply that was not delivered (it failed before any text was shown, or its turn is gone) was
  // never heard: drop it now, whenever it was next due, so nothing waits on it. An interrupted reply whose text was
  // shown keeps its promises.
  store.handle.prepare(`UPDATE lead_commitment SET state = 'cancelled', closed_at = ?, closed_by = 'lead', outcome = 'The reply that made this promise was not delivered.'
    WHERE state = 'open' AND turn IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mate_turn t WHERE t.id = lead_commitment.turn AND t.state IN ('queued', 'running'))
      AND NOT ${SHOWN('lead_commitment.turn')}`).run(at);
  const due = store.handle.prepare("SELECT * FROM lead_commitment WHERE state = 'open' AND check_at <= ? ORDER BY check_at, id LIMIT ?").all(at, PASS_LIMIT);
  for (const row of due) {
    const one = readCommitment(row);
    const id = Number(row['id']);
    const close = (state: 'done' | 'cancelled', outcome: string) =>
      Number(store.handle.prepare("UPDATE lead_commitment SET state = ?, closed_at = ?, closed_by = 'lead', outcome = ?, checked_at = ? WHERE id = ? AND state = 'open'").run(state, at, outcome, at, id).changes) === 1;
    if (one === null) { close('cancelled', 'Its condition could not be read.'); continue; }
    // A reply still being written may yet be delivered; one that was not is dropped above.
    const turn = one.turn === null ? null : store.getLeadTurn(one.turn);
    if (turn !== null && (turn.state === 'queued' || turn.state === 'running')) continue;
    const account = store.accountOf(one.owner);
    if (account === null || account.revokedAt !== null || one.repo !== null && !store.accountCanAccess(one.owner, one.repo)) { close('cancelled', 'Access to this project ended.'); continue; }
    const thread = store.getLeadThread(one.thread);
    if (thread === null || thread.approver !== one.owner || thread.closedAt !== null) { close('cancelled', 'The conversation it was promised in was closed.'); continue; }
    let seen: string | null;
    try { seen = observe(store, one, now, root); } catch { seen = null; }
    if (seen === null) {
      store.handle.prepare("UPDATE lead_commitment SET checked_at = ?, check_at = ? WHERE id = ? AND state = 'open'").run(at, new Date(now.getTime() + RECHECK_MS).toISOString(), id);
      continue;
    }
    const line = `${seen} (I said I would ${promised(one.what)}.)`;
    store.transact(() => {
      if (!close('done', seen!)) return;
      // The shared conversation always keeps the line; a promise made on a phone or team chat is also said there, as
      // the lead's own message to its owner, on that chat alone (the usual delivery receipts apply).
      store.appendLeadMessage({ thread: one.thread, turn: null, role: 'assistant', text: line }, now);
      if (one.channel !== 'chat') store.enqueueNotification({ dedupeKey: `${PROMISE_KEY}${one.channel}:${one.id}`, kind: LEAD_SAY_KIND, subject: leadNameOf(store, one.owner),
        body: line.slice(0, 300), recipient: one.owner, source: { installation: true } }, now);
      reported++;
    });
  }
  return reported;
}
