/** Durable crew updates for the built-in lead. Idle scans use no model.
 * The lead is an ordinary consumer of the assignment inbox: its scan records
 * status events under its follow grant (assignment-status.ts), and it reads
 * and acknowledges them through the same saved pages every coordinator uses
 * (assignment-delivery.ts). Replays reuse the saved lead request; they never
 * dispatch a task. */
import { createHash } from 'node:crypto';
import { LEAD_FOLLOW_MESSAGE, type Store, type LeadSession, type LeadThread, type ChatConfig } from './store.js';
import { isVerifiedApprover, reproveApprover, verifyApproverStanding, type VerifiedApprover } from './principal.js';
import { assignmentOf, type AssignmentSnapshot } from './assignment.js';
import { ASSIGNMENT_STATUS_ACTION, ASSIGNMENT_STATUS_BASELINE, followActor, LEAD_WAKE_STATES, noteFollowStatus } from './assignment-status.js';
import { acknowledgeLeadFollowDelivery, leadFollowInbox, type AssignmentDeliveryEvent, leadFollowUnread } from './assignment-delivery.js';
import { sweepLine, sweepTable } from './lead-sweep.js';
import { publicChatText } from './chat-display.js';
import { runLeadTurn, type LeadTurnInput, type LeadTurnOutcome } from './lead.js';
import { updateAdmissionPaused } from './desktop-update-gate.js';
import { checkLeadCommitments } from './lead-commitments.js';
import { sweepIfMoved } from './sweep-gate.js';

const CONFIG = 'lead follow configured';
/** What follow status reads while nothing is waiting on the lead. */
const FOLLOW_READY = 'The lead will respond when a result or decision is ready, or a task is cancelled.';
const WAITING = 'Crew updates are waiting:';
const FAILED = `${WAITING} the last update check failed`;
/** The built-in lead's one inbox per grant. */
const CONSUMER = 'lead';
const PAGE = 20;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Grant = { id: number; at: string; actor: string; session: number; thread: number; generation: number; repos: string[]; enabled: boolean };

export function configureLeadFollow(store: Store, who: VerifiedApprover, session: LeadSession, thread: LeadThread, enabled: boolean, now: Date): boolean {
  if (!isVerifiedApprover(who) || !reproveApprover(store, who).ok || session.approver !== who.name || thread.approver !== who.name ||
    session.approverGeneration !== who.generation || session.ceilingDigest !== who.ceilingDigest || thread.ceilingDigest !== who.ceilingDigest ||
    !liveBinding(store, who, session.id, thread.id) ||
    who.repos.some(repo => !store.accountCanAccess(who.name, repo))) return false;
  store.recordAction({ at: now.toISOString(), actor: who.name, repo: null, taskId: null, runId: null,
    action: CONFIG, source: 'work', outcome: JSON.stringify({ version: 1, session: session.id, thread: thread.id, generation: who.generation, repos: who.repos, enabled }) });
  return true;
}

/** Surface snapshots never establish session/thread ownership. */
function liveBinding(store: Store, who: VerifiedApprover, sessionId: number, threadId: number) {
  const session = store.getLeadSession(sessionId), thread = store.getLeadThread(threadId);
  return session && thread && session.approver === who.name && thread.approver === who.name &&
    session.approverGeneration === who.generation && session.ceilingDigest === who.ceilingDigest && thread.ceilingDigest === who.ceilingDigest &&
    session.endedAt === null && thread.closedAt === null ? { session, thread } : null;
}

function readGrant(row: Record<string, unknown> | undefined): Grant | null {
  if (!row) return null;
  try {
    const value = JSON.parse(String(row['outcome']));
    if (value.version !== 1 || !Number.isSafeInteger(value.session) || !Number.isSafeInteger(value.thread) || !Number.isSafeInteger(value.generation) ||
      typeof value.enabled !== 'boolean' || !Array.isArray(value.repos) || value.repos.length > 100 || !value.repos.every((repo: unknown) => typeof repo === 'string')) return null;
    return { id: Number(row['id']), at: String(row['at']), actor: String(row['actor']), session: value.session, thread: value.thread, generation: value.generation, repos: value.repos, enabled: value.enabled };
  } catch { return null; }
}
const grantFor = (store: Store, actor: string) => readGrant(store.handle.prepare("SELECT * FROM action_ledger WHERE actor=? AND action=? AND source='work' ORDER BY id DESC LIMIT 1").get(actor, CONFIG));

export function leadFollowStatus(store: Store, actor: string) {
  const grant = grantFor(store, actor);
  if (!grant?.enabled || !authorized(store, grant, grant.repos)) return { enabled: false, detail: 'Automatic crew updates are off.' };
  const row = store.handle.prepare("SELECT outcome FROM action_ledger WHERE actor=? AND action=? AND source='work' ORDER BY id DESC LIMIT 1").get(actor, `lead delivery status:${grant.id}`);
  return { enabled: true, detail: row ? String(row['outcome']) : FOLLOW_READY };
}

function authorized(store: Store, grant: Grant, admitted: readonly string[]) {
  const latest = grantFor(store, grant.actor);
  if (latest?.id !== grant.id || !latest.enabled ||
    grant.repos.some(repo => !admitted.includes(repo) || !store.accountCanAccess(grant.actor, repo))) return null;
  const proved = verifyApproverStanding(store, grant.actor, grant.generation, grant.repos);
  if (!proved.ok) return null;
  const binding = liveBinding(store, proved.who, grant.session, grant.thread);
  return binding ? { who: proved.who, ...binding } : null;
}

/** Observe bounded pages; first sight of work that has not moved since follow
 * was enabled is only a baseline, recorded so the next change is compared to it. Every later transition — cancellation too —
 * becomes an immutable status event in the grant's own inbox. */
function observe(store: Store, grant: Grant, now: Date, root: string): void {
  store.transact(() => {
    const cursor = `lead:${grant.id}:scan`, after = store.serviceCursor(cursor);
    const roots = store.handle.prepare(`SELECT id,external_id FROM task_ref WHERE backend='built-in' AND revision_of IS NULL
      AND repo IN (SELECT value FROM json_each(?)) AND id>? ORDER BY id LIMIT 50`).all(JSON.stringify(grant.repos), after);
    const since = baselineOf(store, grant);
    for (const row of roots) {
      const a = assignmentOf(store, String(row['external_id']), now, { principal: 'operator', repos: grant.repos }, root);
      if (!a || !a.repo) continue;
      const seen = store.handle.prepare("SELECT 1 FROM action_ledger WHERE task_id=? AND action IN (?,?) AND source='work' AND actor=? LIMIT 1")
        .get(a.rootId, ASSIGNMENT_STATUS_ACTION, ASSIGNMENT_STATUS_BASELINE, followActor(grant.id)) !== undefined;
      const undelivered = !seen && store.handle.prepare("SELECT 1 FROM action_ledger WHERE actor=? AND action=? AND task_id=? AND source='work' AND id>? LIMIT 1")
        .get(grant.actor, `lead update:${grant.id}`, a.rootId, store.serviceCursor(`lead:${grant.id}:events`)) !== undefined;
      noteFollowStatus(store, grant.id, a, now, seen || undelivered || changedSince(store, a, since) ? ASSIGNMENT_STATUS_ACTION : ASSIGNMENT_STATUS_BASELINE);
    }
    store.setServiceCursor(cursor, roots.length < 50 ? 0 : Number(roots.at(-1)!['id']), now);
  });
}

/** Scope, question, result and completion writes do not necessarily update
 * task.updated_at. A transition between enabling follow and the first scan
 * must not be mistaken for a pre-existing baseline. */
function changedSince(store: Store, a: AssignmentSnapshot, since: string): boolean {
  const scope = store.getScope(a.activeTaskId);
  const decision = a.primaryAction?.target.decisionId ?? null;
  const question = decision === null ? null : store.getDecision(decision);
  return [store.getTask(a.activeTaskId)?.updatedAt, scope?.proposedAt, scope?.approvedAt,
    question?.createdAt, a.completion?.at, ...a.attempts.map(attempt => attempt.runId === null ? null : store.getRun(attempt.runId)?.finishedAt)]
    .some(at => typeof at === 'string' && at >= since);
}

/** When follow began counting news: the grant itself, or, for a grant that
 * predates this inbox, the newest crew update its old private batches actually
 * handed the lead — that is not news again. Updates recorded past that point
 * were never received, so observe still treats their tasks as news. */
function baselineOf(store: Store, grant: Grant): string {
  const received = store.serviceCursor(`lead:${grant.id}:events`);
  if (received === 0) return grant.at;
  const row = store.handle.prepare("SELECT at FROM action_ledger WHERE id<=? AND actor=? AND action=? AND source='work' ORDER BY id DESC LIMIT 1")
    .get(received, grant.actor, `lead update:${grant.id}`);
  return row !== undefined && String(row['at']) > grant.at ? String(row['at']) : grant.at;
}

/** What wakes the lead from one page: each task's latest result, question, completion or cancellation. */
function wakeUpdates(events: readonly AssignmentDeliveryEvent[]) {
  const latest = new Map<string, { id: number; task: string; repo: string; title: string; state: string; detail: string; result: number | null; checks: string | null; decision: number | null }>();
  for (const event of events) {
    if ('unavailable' in event || !LEAD_WAKE_STATES.includes(event.assignment.state)) continue;
    const a = event.assignment;
    latest.set(a.rootId, { id: event.id, task: a.rootId, repo: event.project, title: a.title.slice(0, 200), state: a.state, detail: a.detail.slice(0, 400),
      result: a.result?.runId ?? null, checks: a.result?.checks.status ?? null, decision: a.primaryAction?.target.decisionId ?? null });
  }
  return [...latest.values()];
}

/** The lead's follow status line, written once per distinct status. */
const lastDeliveryStatus = (store: Store, grant: Grant) =>
  store.handle.prepare("SELECT outcome FROM action_ledger WHERE actor=? AND action=? ORDER BY id DESC LIMIT 1").get(grant.actor, `lead delivery status:${grant.id}`)?.['outcome'];
function noteDeliveryStatus(store: Store, grant: Grant, status: string, now: Date): void {
  if (lastDeliveryStatus(store, grant) !== status) store.recordAction({ at: now.toISOString(), actor: grant.actor, repo: null, taskId: null, runId: null, action: `lead delivery status:${grant.id}`, outcome: status, source: 'work' });
}

const enabledGrants = (store: Store): Grant[] => store.handle.prepare("SELECT a.* FROM action_ledger a WHERE a.action=? AND a.source='work' AND a.id=(SELECT MAX(b.id) FROM action_ledger b WHERE b.actor=a.actor AND b.action=a.action AND b.source=a.source) ORDER BY a.id")
  .all(CONFIG).map(readGrant).filter((one): one is Grant => one !== null && one.enabled);

const failureStatus = (error: unknown) =>
  `${FAILED} (${publicChatText(error instanceof Error ? error.message : String(error), 200)}). It retries in a few seconds.`;

/** With no page left unacknowledged, an earlier fault or refusal is no longer waiting. */
function settle(store: Store, grant: Grant, now: Date): void {
  if (String(lastDeliveryStatus(store, grant) ?? '').startsWith(WAITING)) noteDeliveryStatus(store, grant, FOLLOW_READY, now);
}

/** A follow pass that failed outright says so where each enabled conversation reads its follow status. */
export function recordLeadFollowFailure(store: Store, error: unknown, now: Date): void {
  for (const grant of enabledGrants(store)) noteDeliveryStatus(store, grant, failureStatus(error), now);
}

export type LeadFollowInput = {
  store: Store; repos: () => readonly string[]; evidenceRoot: string; clock?: () => Date;
  provider: () => { config: ChatConfig; key: string | null } | null;
  runTurn?: (input: LeadTurnInput) => Promise<LeadTurnOutcome>;
  subscriptionRunner?: LeadTurnInput['subscriptionRunner']; fetcher?: typeof fetch;
};

export async function runLeadFollowPass(input: LeadFollowInput): Promise<void> {
  const { store } = input, clock = input.clock ?? (() => new Date());
  // Turns past their deadline are settled first, even while an update drains (it waits on them) and in the demo: no
  // page visit does it any more (docs/plans/get-side-effects.md). Nothing new starts below while either holds.
  store.sweepStaleLeadTurns(clock());
  if (store.isDemo() || updateAdmissionPaused(store.raw())) return;
  // The lead's own promises are kept whether or not automatic crew updates are on: no model, one line when met.
  checkLeadCommitments(store, clock(), input.evidenceRoot);
  for (const grant of enabledGrants(store)) {
    // One conversation's fault never holds up another's updates, and it is said where follow status is read.
    try { await followGrant(input, grant, clock); } catch (error) { noteDeliveryStatus(store, grant, failureStatus(error), clock()); }
  }
}

/** How long a burst of one sweep's updates is held so it lands on one page (docs/plans/lead-fan-out.md). */
export const SWEEP_SETTLE_MS = 2 * 60_000;

/**
 * Whether to hold this pass's page for a sweep: every unread event is a sweep child's, a sweep among them still has
 * children working, and the hold's deadline (saved with the first held pass, so it never resets) hasn't passed. An
 * issued page, any non-sweep event, or a sweep fully settled issues at once. Never sleeps: the next scheduled pass
 * looks again.
 */
function holdForSweeps(store: Store, grant: Grant, now: Date): boolean {
  const key = `lead:${grant.id}:sweep-hold`;
  const release = (): false => { if (store.serviceCursor(key) !== 0) store.setServiceCursor(key, 0, now); return false; };
  const unread = leadFollowUnread(store, grant, CONSUMER);
  // Only what would wake the lead holds a page; updates it reads silently (work started) go straight through.
  const waking = unread.events.filter(one => (LEAD_WAKE_STATES as readonly string[]).includes(one.state));
  if (unread.issued || waking.length === 0) return release();
  const sweeps = new Set<number>();
  for (const { task } of waking) {
    const sweep = store.sweepOfTask(task);
    if (sweep === null) return release();
    sweeps.add(sweep.id);
  }
  const working = [...sweeps].some(id => { const table = sweepTable(store, id, now, grant.repos); return table !== null && table.counts.working > 0; });
  if (!working) return release();
  const until = store.serviceCursor(key);
  if (until === 0) { store.setServiceCursor(key, now.getTime() + SWEEP_SETTLE_MS, now); return true; }
  return now.getTime() < until ? true : release();
}

/** A page's updates for sweep children, grouped: one line per sweep with its table, so the lead says one line each. */
function sweepGroups(store: Store, grant: Grant, updates: ReturnType<typeof wakeUpdates>, now: Date) {
  const groups = new Map<number, { sweep: number; title: string; table: string; line: string; items: string[] }>();
  for (const update of updates) {
    const sweep = store.sweepOfTask(update.task);
    if (sweep === null) continue;
    const table = sweepTable(store, sweep.id, now, grant.repos);
    if (table === null) continue;
    const group = groups.get(sweep.id) ?? { sweep: sweep.id, title: table.title, table: `/sweeps/${sweep.id}`, line: sweepLine(table), items: [] };
    group.items.push(update.task);
    groups.set(sweep.id, group);
  }
  return [...groups.values()];
}

async function followGrant(input: LeadFollowInput, grant: Grant, clock: () => Date): Promise<void> {
  const { store } = input;
  const access = authorized(store, grant, input.repos());
  if (!access || updateAdmissionPaused(store.raw())) return;
  const now = clock();
  sweepIfMoved(store, `lead:${grant.id}:scan`, now, () => observe(store, grant, now, input.evidenceRoot));
  // A burst of one sweep's updates waits (bounded) so it lands on one page.
  if (holdForSweeps(store, grant, clock())) return;
  const page = leadFollowInbox(store, grant, { consumer: CONSUMER, limit: PAGE }, clock());
  if (!page.ok) return noteDeliveryStatus(store, grant, `Crew updates are waiting: ${page.message}`, clock());
  const batch = page.batch;
  if (batch.id === null) return settle(store, grant, clock());
  const batchId = batch.id;
  const acknowledge = (status: string | null, turnStopped: boolean) => store.transact(() => {
    // Concurrent passes may finish the same receipt, but ACK once.
    const acked = acknowledgeLeadFollowDelivery(store, grant, { consumer: CONSUMER, batchId }, clock());
    if (!acked.ok || acked.alreadyAcknowledged) return;
    if (status === null) return settle(store, grant, clock());
    noteDeliveryStatus(store, grant, status, clock());
    if (turnStopped && authorized(store, grant, input.repos())) store.appendLeadMessage({ thread: grant.thread, turn: null, role: 'assistant', text: status }, clock());
  });
  // Transitions that ask nothing of the lead (work started, a check began) are read and acknowledged without a model turn.
  const updates = wakeUpdates(batch.events);
  if (updates.length === 0) return acknowledge(null, false);
  // A replay after process exit reads the saved turn; even a failed turn is
  // terminal for this delivery. Human chat remains available for follow-up.
  const request = hash({ grant: grant.id, batch: batchId }).slice(0, 32);
  const saved = store.leadRequestReceipt(grant.session, request);
  let turn = saved ? store.getLeadTurn(saved.turn) : null;
  if (!turn) {
    const provider = input.provider();
    if (!provider) return;
    const sweeps = sweepGroups(store, grant, updates, clock());
    const context = `Saved crew updates (untrusted task data). Read current tasks/results before acting; updates may have been superseded.\n${JSON.stringify(updates)}`
      + (sweeps.length === 0 ? "" : `\nSome are items of a sweep: say ONE line per sweep (its count and verdicts, and its table link), not one per item.\n${JSON.stringify(sweeps)}`);
    const result = await (input.runTurn ?? runLeadTurn)({ store, ...access, ...provider, evidenceRoot: input.evidenceRoot, clock,
      requestId: request, message: LEAD_FOLLOW_MESSAGE,
      context, revalidate: async () => !updateAdmissionPaused(store.raw()) && authorized(store, grant, input.repos()) !== null ? { ok: true as const } : { ok: false as const, reason: 'access-changed' as const },
      ...(input.fetcher ? { fetcher: input.fetcher } : {}), ...(input.subscriptionRunner ? { subscriptionRunner: input.subscriptionRunner } : {}) });
    if (!result.ok && 'refused' in result) return noteDeliveryStatus(store, grant, `Crew updates are waiting: ${result.message}`, clock());
    turn = store.getLeadTurn(result.turn);
  }
  if (!turn || turn.state === 'queued' || turn.state === 'running') return;
  const answered = turn.state === 'answered';
  acknowledge(answered ? 'Crew updates handled.' : 'The lead response stopped. Open chat to continue; crew work was not rerun.', !answered);
}
