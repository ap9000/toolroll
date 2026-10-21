/**
 * Runs the personal lead queue (docs/plans/lead-message-queue.md): one message per turn, in order, through the engine's
 * own admission. Each claim is re-proved from its row — the person's standing at the generation it was sent under, the
 * session it was sent under (never a newer one), the project set it was sent under, its task and result still there —
 * and re-checked before every model step. A refusal before admission waits with its words and wakes when what refused
 * it changes; anything after admission is settled from the turn's own record and never sent again.
 */
import { AsyncResource } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { runLeadTurn, type LeadTurnInput, type LeadTurnOutcome } from "./lead.js";
import { PersonalQueue, type LeadQueueClaim, type LeadQueueContext, type LeadQueueRow } from "./lead-queue.js";
import type { LeadProgress } from "./lead-progress.js";
import { verifyApproverStanding } from "./principal.js";
import type { ChatConfig, Store } from "./store.js";
import { updateAdmissionPaused } from "./desktop-update-gate.js";
import { TURN_WALL_CLOCK_MS } from "./converse.js";

/** The words a task composer's mode adds to a turn (render-chat.ts TASK_COMPOSER_MODES), by mode. */
export type ComposerModes = Readonly<Record<string, string>>;

/** The context a lead turn is given for what the person was looking at: the same words for a message sent now and one
 * that waited. Null when the message was sent from the lead's own chat. */
export function leadTurnContext(store: Store, context: LeadQueueContext | null, names: { project: (path: string) => string; modes: ComposerModes }): string | undefined {
  if (context === null) return undefined;
  if (context.task !== undefined) {
    const viewed = context.result === undefined ? null : store.getRun(context.result);
    const result = viewed === null ? "" : ` The operator is viewing result #${viewed.id} from execution ${store.externalIdFor(viewed.taskRef)}. Use get_result for that exact execution and run when responding to feedback; do not substitute another result.`;
    const mode = context.mode === undefined ? "" : ` ${names.modes[context.mode] ?? ""}`;
    return `Current task: ${context.task}. Read it with get_task before answering or proposing changes. Read its currentExecution next and bind new actions to that exact execution. Never replace the target of a prior proposal with a newer revision. Keep this turn about that task unless the operator explicitly asks to broaden it.${result}${mode}`;
  }
  if (context.project !== undefined) return `Current project: ${names.project(context.project)} (${context.project}). Keep this conversation about that project unless the operator explicitly asks to broaden it; use it as the repo for project tools.`;
  return undefined;
}

/** Refusals before admission that wait (with their words) rather than end the message: what wakes each one is in its
 * stamp (a turn ends, the day or week or month rolls, the cost is confirmed, a budget is raised). */
const WAITS = new Set(["concurrent", "backlog", "daily-cap", "over-budget", "monthly-budget", "latched"]);
const UPDATE_WAIT = "Waiting: Toolroll is updating. It runs once the update is done.";

export type PersonalQueueRuntimeOptions = {
  store: Store;
  evidenceRoot: string;
  /** The chat provider now (null when chat is off: messages wait). */
  provider: () => { config: ChatConfig; key: string | null } | null;
  /** The projects the console admits for this person, computed as that person (never from a live request). */
  admittedReposFor: (account: string) => string[];
  /** Whether the task (or result run) a message was sent about is still there for this person. */
  contextStands: (account: string, context: LeadQueueContext) => boolean;
  names: { project: (path: string) => string; modes: ComposerModes };
  /** The console's live reply display: started per turn, ended with the progress handle it returned. */
  live?: { begin: (thread: number) => (event: LeadProgress) => void; end: (thread: number, ok: boolean, progress: (event: LeadProgress) => void) => void };
  subscriptionRunner?: LeadTurnInput["subscriptionRunner"];
  fetcher?: typeof fetch;
  clock?: () => Date;
  everyMs?: number;
};

export function createPersonalQueueRuntime(options: PersonalQueueRuntimeOptions) {
  const { store } = options, clock = options.clock ?? (() => new Date());
  const queue = new PersonalQueue(store);
  const runner = `personal:${process.pid}:${randomUUID()}`;
  /** A deferred message's admission stamp: it is not tried again until something that refused it changes. */
  const waiting = new Map<number, string>();
  let timer: ReturnType<typeof setInterval> | null = null, closed = false, passing = false;
  /** The server's own async context, captured at start (no request in it). A wake from inside a browser request runs
   * its pass from here, so no request's session facts (its actor, form token or Passwordless session) ever reach a
   * queued turn — the queue re-proves each message's person itself. */
  let detached: AsyncResource | null = null;
  const active = new Set<Promise<void>>();

  /** What openLeadTurn checks for this person, and the chat configuration (its caps and budget), with a minute bucket
   * as the belt for what is not named here (weekly and monthly spend roll over within it): a change wakes a waiting message. */
  function stamp(row: LeadQueueRow): string {
    const now = clock();
    const live = store.handle.prepare("SELECT id, state FROM mate_turn WHERE approver = ? AND state IN ('queued','running') ORDER BY id").all(row.approver);
    const liveChat = store.handle.prepare("SELECT id, state FROM chat_turn WHERE approver = ? AND state IN ('queued','running') ORDER BY id").all(row.approver);
    const session = store.getLeadSession(row.session);
    const latched = store.handle.prepare("SELECT COUNT(*) AS n FROM chat_turn WHERE approver = ? AND unknown_spend = 1 AND acknowledged_at IS NULL").get(row.approver);
    return createHash("sha256").update(JSON.stringify([live, liveChat, store.chatTurnsToday(row.approver, now), session?.spentMicrousd ?? null,
      session?.ceilingMicrousd ?? null, latched?.["n"] ?? 0, updateAdmissionPaused(store.raw()), options.provider()?.config ?? null, Math.floor(now.getTime() / 60_000)])).digest("hex");
  }

  /** The person as the row was sent: same generation, same session (live, theirs), same projects. Null: it can't run. */
  function standing(row: LeadQueueRow): { ok: true; who: ReturnType<typeof verifiedWho> } | { ok: false; why: string } {
    const session = store.getLeadSession(row.session);
    if (session === null || session.endedAt !== null || session.approver !== row.approver) return { ok: false, why: "Not sent: this conversation ended before it ran." };
    const verified = verifyApproverStanding(store, row.approver, row.approverGeneration, options.admittedReposFor(row.approver));
    if (!verified.ok) return { ok: false, why: "Not sent: your access changed before it ran." };
    if (verified.who.ceilingDigest !== row.ceilingDigest || session.ceilingDigest !== row.ceilingDigest) return { ok: false, why: "Not sent: your projects changed before it ran." };
    const thread = store.getLeadThread(row.thread);
    if (thread === null || thread.closedAt !== null) return { ok: false, why: "Not sent: this conversation was closed before it ran." };
    if (row.context !== null && !options.contextStands(row.approver, row.context)) return { ok: false, why: "Not sent: the task it was about is no longer available." };
    return { ok: true, who: verified.who };
  }
  const verifiedWho = (who: Extract<ReturnType<typeof verifyApproverStanding>, { ok: true }>["who"]) => who;

  async function run(claim: LeadQueueClaim): Promise<void> {
    let progress: ((event: LeadProgress) => void) | undefined;
    let outcome: LeadTurnOutcome | undefined;
    try {
      const proof = standing(claim);
      if (!proof.ok) { queue.finish(claim, { status: "failed", error: proof.why }, clock()); return; }
      const provider = options.provider();
      if (provider === null) { if (queue.defer(claim, "Waiting: chat is off. It runs once chat is on again.")) waiting.set(claim.message, stamp(claim)); return; }
      // An update is being installed (or the console is stopping): the message waits for the next start, words kept.
      const holding = () => closed || updateAdmissionPaused(store.raw());
      if (holding()) { if (queue.defer(claim, UPDATE_WAIT)) waiting.set(claim.message, stamp(claim)); return; }
      let held = false;
      const session = store.getLeadSession(claim.session)!, thread = store.getLeadThread(claim.thread)!;
      const context = leadTurnContext(store, claim.context, options.names);
      outcome = await runLeadTurn({
        store, who: proof.who, session, thread, config: provider.config, key: provider.key, message: claim.text, requestId: claim.requestId,
        queuedMessageId: claim.message, queueClaim: { message: claim.message, runner: claim.runner, generation: claim.generation },
        // The live reply display starts only once this message holds the turn: a refused attempt never blanks the display
        // of a turn that is still running in the same conversation.
        onAdmitted: turn => {
          if (!queue.bindTurn(claim, turn)) throw new Error("The queued message changed before admission.");
          progress = options.live?.begin(claim.thread);
        },
        ...(context === undefined ? {} : { context }), channel: "console", clock, evidenceRoot: options.evidenceRoot,
        ...(options.live === undefined ? {} : { onProgress: (event: LeadProgress) => progress?.(event) }),
        // Before every step: still this claim, still this person at this generation and session, still the same projects.
        revalidate: async () => {
          if (holding()) { held = true; return { ok: false as const, reason: "access-changed" as const }; }
          return queue.current(claim) && standing(claim).ok ? { ok: true as const } : { ok: false as const, reason: "access-changed" as const };
        },
        ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        ...(options.subscriptionRunner === undefined ? {} : { subscriptionRunner: options.subscriptionRunner }),
      });
      if (outcome.ok) { queue.finish(claim, { status: "answered", turnId: outcome.turn }, clock()); return; }
      if ("refused" in outcome) {
        // Refused before admission because an update paused it: that is a wait too (the words stay; the pause ending wakes it).
        if (outcome.refused === "channel" && held) { if (queue.defer(claim, UPDATE_WAIT)) waiting.set(claim.message, stamp(claim)); }
        else if (WAITS.has(outcome.refused)) { if (queue.defer(claim, `Waiting: ${outcome.message}`)) waiting.set(claim.message, stamp(claim)); }
        else queue.finish(claim, { status: "failed", error: `Not sent: ${outcome.message}` }, clock());
        return;
      }
      // After admission: settled from the turn's record; an unknown outcome is never sent again.
      queue.finish(claim, { status: "unknownSpend" in outcome && outcome.unknownSpend ? "uncertain" : "failed", error: outcome.message, ...("turn" in outcome ? { turnId: outcome.turn } : {}) }, clock());
    } catch {
      queue.finish(claim, { status: "uncertain", error: "Delivery could not be confirmed. Nothing was sent again." }, clock());
    } finally {
      if (progress !== undefined) options.live?.end(claim.thread, outcome?.ok === true, progress);
    }
  }

  async function pass(): Promise<void> {
    if (closed || passing || store.isDemo()) return;
    passing = true;
    try {
      queue.reconcile(clock(), TURN_WALL_CLOCK_MS + 60_000);
      for (;;) {
        const claim = queue.claimNext(runner, clock(), row => waiting.get(row.message) !== stamp(row));
        if (claim === null) break;
        waiting.delete(claim.message);
        const work = run(claim);
        active.add(work);
        void work.finally(() => active.delete(work)).catch(() => undefined);
      }
    } finally { passing = false; }
  }

  return {
    queue,
    /** Look now (a turn just ended, a message was just queued): the next message of each person may start. Safe to call
     * from a request: the pass runs in the server's own context, never the caller's. Before start, the timer will look. */
    kick(): void {
      const scope = detached;
      if (scope === null || closed) return;
      scope.runInAsyncScope(() => { setImmediate(() => { void pass(); }); });
    },
    start(): void {
      if (timer !== null || closed) return;
      detached = new AsyncResource("lead-queue-runtime");
      detached.runInAsyncScope(() => { timer = setInterval(() => { void pass(); }, options.everyMs ?? 2_000); timer.unref(); });
    },
    async close(): Promise<void> { closed = true; if (timer !== null) clearInterval(timer); timer = null; await Promise.allSettled([...active]); },
  };
}
