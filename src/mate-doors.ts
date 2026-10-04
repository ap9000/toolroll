import { executeSharedAction, sharedActionPayload, sharedActionAllowsChallenge, sharedActionNeedsReview, type SharedActionOptions } from './chat-actions.js';
/**
 * The confirm doors (mate arc §2, ruling 7; v3 §9): a pending proposal —
 * the mate's, or a coordinator's over the gateway — becomes an act only
 * here, as the operator's own act through the plane's existing
 * primitives, in ONE transaction that re-proves everything the card was
 * rendered under. The console and the CLI both call these; the HTTP edge
 * adds csrf and the cookie, the CLI adds the password — neither adds
 * authority the door does not check itself.
 *
 * The door's answer is typed and rendered on the card: `done` with the
 * plain words of what happened, or `refused` with the reason the primitive
 * gave. A stale proposal (the queue moved, the hold changed hands, the
 * scope was rewritten, the decision answered) is a refusal, never a
 * silent re-read.
 */
import { isCheckLevel, setTaskCheckLevel } from "./check-levels.js";
import { verifiedAuthor, type CoordinatorProposal, type MateProposal, type Store } from "./store.js";
import type { VerifiedApprover } from "./principal.js";
import { isVerifiedApprover, reproveApprover } from "./principal.js";
import { TeamLeads } from './team-leads.js';
import { fileTaskProposal } from "./proposal.js";
import { proposeGuarded } from "./scope.js";
import { isRiskLevel, isTaskSize, PHASES, riskTitle, specWords } from "./phase-routing.js";
import { isProviderId } from "./provider.js";
import type { Phase, ProviderId } from "./provider.js";
import { applyChatReview, type ReviewRequest } from "./chat-review.js";
import { applyChatTaskAction } from "./chat-task-actions.js";

export type ProposalKind = MateProposal["kind"];

export type DoorOutcome =
  | { ok: true; kind: ProposalKind; said: string; taskId: string | null; href?: string }
  | { ok: false; kind: ProposalKind | null; reason: DoorRefusal; said: string };

export type DoorRefusal =
  | "standing"
  | "not-yours"
  | "ceiling-changed"
  | "not-pending"
  | "session-ended"
  | "turn-not-answered"
  | "not-confirmable"
  | "needs-confirm"
  | "stale"
  | "claimed"
  | "not-queued"
  | "contest-open"
  | "unknown-task"
  | "unknown-decision"
  | "already-answered"
  | "expired"
  | "outside-ceiling"
  | "refused";

export type DoorOptions = {
  evidenceRoot?: string;
  /** Only the secure human review endpoint supplies this; never saved or model-authored. */
  actionReview?: SharedActionOptions["review"];
  held?: import("./task-control.js").StopRequest["held"];
  /** The existing ceremony for an irreversible decision option: `confirm=yes`, typed explicitly (ruling 12). */
  confirm?: boolean;
  /** Which surface answered — recorded on the decision, the stop and the
   * proposal's outcome. Named by the caller, never defaulted (v3 review,
   * finding 1); `telegram` is the paired phone, never relabelled as the CLI. */
  via: "web" | "cli" | "telegram" | "slack" | "discord" | "teams";
  /**
   * A composing caller already inside a transaction (the Telegram bridge
   * applies a tap in the update's own transaction) hands the door its
   * commit hook: the stop's process signal then fires after THAT commit,
   * never before it, exactly as the door's own transaction would order it.
   */
  deferSignal?: ((signal: () => void) => void) | undefined;
};

/** A coordinator proposal lives seven days (§9); the door refuses an older one whatever the sweep did (v3 review, finding 3). */
export const COORDINATOR_PROPOSAL_TTL_MS = 7 * 24 * 3_600_000;

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}
function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function payloadStrings(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
}

function payloadPlanning(payload: Record<string, unknown>): "auto" | "required" | "skip" | null {
  const value = payload["planning"] ?? "auto";
  return value === "auto" || value === "required" || value === "skip" ? value : null;
}

/**
 * Confirm one of the mate's proposals as `who`. The whole check-and-act
 * is one transaction: brand and standing (re-proved inside); the
 * proposal's thread is this approver's; a LIVE session minted by this
 * generation under this ceiling; its turn answered; `pending →
 * confirming` CAS; the primitive; `confirming → confirmed | refused`.
 */
const VIA_WORDS: Record<DoorOptions["via"], string> = {
  web: "From the lead chat", cli: "From the command line", telegram: "From Telegram", slack: "From Slack", discord: "From Discord", teams: "From Teams",
};
const CARD_WORDS: Partial<Record<ProposalKind, string>> = {
  task: "New task", next: "Queue priority", reserve: "Worker assignment", hold: "Pause work", unhold: "Resume work",
  steer: "Guidance for the next attempt", scope: "Scope revision", answer: "Decision answer", repair: "Waiting task",
  agents: "Agents change", task_action: "Task update", action: "Action",
};

/** A card about a task, confirmed anywhere but that task's own chat (the
 * lead chat, a project chat, a phone), is recorded in the task's chat too,
 * so each task keeps the whole story of what was asked of it. */
function recordInTaskChat(store: Store, who: VerifiedApprover, proposal: NonNullable<ReturnType<Store["getMateProposal"]>>, outcome: Extract<DoorOutcome, { ok: true }>, via: DoorOptions["via"], now: Date): void {
  const target = typeof proposal.payload["task"] === "string" ? proposal.payload["task"] : proposal.kind === "task" ? outcome.taskId : null;
  if (target === null) return;
  const root = store.taskFamilyOf(target, who.repos, false)?.root.id ?? target;
  const source = store.getMateThread(proposal.thread);
  if (source === null || (source.scope.kind === "task" && source.scope.key === root)) return;
  const where = via !== "web" ? VIA_WORDS[via] : source.scope.kind === "project" ? "From the project chat" : VIA_WORDS.web;
  const label = proposal.kind === "review" ? (proposal.payload["operation"] === "revise" ? "Changes to make" : "Note for later") : CARD_WORDS[proposal.kind] ?? "Action";
  const said = outcome.said.charAt(0).toUpperCase() + outcome.said.slice(1);
  const thread = store.openMateThread(who.name, who.ceilingDigest, now, { kind: "task", key: root }).thread;
  store.appendMateMessage({ thread: thread.id, turn: null, role: "assistant", text: `${where} — ${label}: ${said}` }, now);
}

export function confirmMateProposal(store: Store, who: VerifiedApprover, proposalId: number, now: Date, options: DoorOptions): DoorOutcome {
  if (!isVerifiedApprover(who)) return { ok: false, kind: null, reason: "standing", said: "your approver standing changed — sign in again" };
  const signals: (() => void)[] = [];
  const defer = options.deferSignal ?? ((signal: () => void) => signals.push(signal));
  const result = store.transact(() => {
    if (!reproveApprover(store, who).ok) return { ok: false, kind: null, reason: "standing", said: "your approver standing changed — sign in again" } as const;
    const proposal = store.getMateProposal(proposalId);
    if (proposal === null) return { ok: false, kind: null, reason: "not-yours", said: "no such proposal" } as const;
    const thread = store.getMateThread(proposal.thread);
    const shared = thread !== null && store.handle.prepare("SELECT id,lead FROM team_conversation WHERE thread=?").get(thread.id);
    if (thread === null || (shared ? !store.canUseTeamMateThread(who.name, who.generation, thread.id) : thread.approver !== who.name)) return { ok: false, kind: null, reason: "not-yours", said: "no such proposal" } as const;
    const session = shared ? store.teamMateSession(who.name, thread.id) : store.activeMateSession(who.name);
    if (session === null || session.approverGeneration !== who.generation) {
      return { ok: false, kind: proposal.kind, reason: "session-ended", said: "the mate session this was proposed in has ended — its cards cannot be confirmed" } as const;
    }
    if (proposal.ceilingDigest !== who.ceilingDigest || session.ceilingDigest !== who.ceilingDigest) {
      return { ok: false, kind: proposal.kind, reason: "ceiling-changed", said: "the admitted projects changed since this was proposed — it cannot be confirmed" } as const;
    }
    const turn = store.getMateTurn(proposal.turn);
    if (turn === null || turn.state !== "answered") {
      return { ok: false, kind: proposal.kind, reason: "turn-not-answered", said: "this proposal's turn did not finish — it cannot be confirmed" } as const;
    }
    if (proposal.kind === "cancel") {
      return { ok: false, kind: proposal.kind, reason: "not-confirmable", said: "cancelling is armed on the task itself — open the task" } as const;
    }
    if (proposal.kind === "control") return { ok: false, kind: proposal.kind, reason: "not-confirmable", said: "Open the linked control to complete this action." } as const;
    if (proposal.kind === "action") {
      if (proposal.state !== "pending") return {ok:false,kind:proposal.kind,reason:"not-pending",said:"This proposal was already acted on."} as const;
      const action = sharedActionPayload(proposal.payload);
      if (action === null) return { ok: false, kind: proposal.kind, reason: "refused", said: "This action is incomplete." } as const;
      const challenged = options.via !== "web" && options.via !== "cli" && options.confirm === true && sharedActionAllowsChallenge(action);
      if (sharedActionNeedsReview(action) && !challenged && (options.via !== "web" || options.actionReview === undefined || options.confirm !== true)) return { ok: false, kind: proposal.kind, reason: "needs-confirm", said: "Review this action in the secure confirmation screen." } as const;
    }
    // An irreversible answer takes the explicit field BEFORE the CAS: a
    // missing confirmation leaves the card pending, not refused.
    const needsConfirm = proposal.kind === "answer" && proposal.payload["reversible"] === false && options.confirm !== true;
    if (needsConfirm) return { ok: false, kind: proposal.kind, reason: "needs-confirm", said: "an irreversible choice must be confirmed explicitly" } as const;
    if (!store.casMateProposal(proposalId, "pending", "confirming", who.name, null, now)) {
      return { ok: false, kind: proposal.kind, reason: "not-pending", said: "this proposal was already acted on" } as const;
    }
    const outcome: DoorOutcome = proposal.kind === "action"
      ? { ...executeSharedAction(store, who, proposal.id, sharedActionPayload(proposal.payload)!, now, {via:options.via, ...(options.evidenceRoot===undefined?{}:{root:options.evidenceRoot}), ...(options.actionReview===undefined?{}:{review:options.actionReview}), ...(options.confirm===undefined?{}:{confirm:options.confirm})}), kind: proposal.kind }
      : executeProposal(store, who, proposal.kind, proposal.payload, now, { ...options, deferSignal: defer });
    if (!outcome.ok && outcome.reason === "needs-confirm") {
      store.casMateProposal(proposalId, "confirming", "pending", null, null, now);
      return outcome;
    }
    // The recorded outcome names the surface that confirmed — the audit a
    // card shows on every other surface afterwards.
    store.casMateProposal(proposalId, "confirming", outcome.ok ? "confirmed" : "refused", who.name, { ...outcome, via: options.via }, now);
    if (outcome.ok && !shared) recordInTaskChat(store, who, proposal, outcome, options.via, now);
    if(shared){
      if(outcome.ok&&outcome.kind==='task'&&outcome.taskId) new TeamLeads(store,()=>store.handle.prepare('SELECT project FROM team_lead_project WHERE lead=?').all(shared['lead']).map(row=>String(row['project']))).recordTaskOwner(outcome.taskId,String(shared['lead']),String(shared['id']),{name:who.name,generation:who.generation},now);
      store.handle.prepare('INSERT INTO team_event(lead,conversation,kind,actor,created_at) VALUES(?,?,?,?,?)').run(shared['lead'],shared['id'],'proposal-changed',who.name,now.toISOString());
    }
    return outcome;
  });
  for (const signal of signals) signal();
  return result;
}

/** The operator declines the mate's card: `pending → dismissed`. */
export function dismissMateProposal(store: Store, who: VerifiedApprover, proposalId: number, now: Date): boolean {
  if (!isVerifiedApprover(who)) return false;
  return store.transact(() => {
    if (!reproveApprover(store, who).ok) return false;
    const proposal = store.getMateProposal(proposalId);
    const thread = proposal === null ? null : store.getMateThread(proposal.thread);
    const shared=thread&&store.handle.prepare('SELECT id,lead FROM team_conversation WHERE thread=?').get(thread.id);
    if (proposal === null || thread === null || (shared ? !store.canUseTeamMateThread(who.name, who.generation, thread.id) : thread.approver !== who.name)) return false;
    const changed=store.casMateProposal(proposalId, "pending", "dismissed", who.name, null, now);
    if(changed&&shared)store.handle.prepare('INSERT INTO team_event(lead,conversation,kind,actor,created_at) VALUES(?,?,?,?,?)').run(shared['lead'],shared['id'],'proposal-changed',who.name,now.toISOString());
    return changed;
  });
}

/**
 * Confirm a coordinator's proposal (v3 §9) as `who`: any approver whose
 * ceiling admits the row's repo. One transaction: standing re-proved
 * inside; the repo inside this ceiling; `pending → confirming`; the shared
 * executor; `confirming → confirmed | refused`. No mate session is
 * involved — nothing here spends.
 */
export function confirmCoordinatorProposal(store: Store, who: VerifiedApprover, proposalId: number, now: Date, options: DoorOptions): DoorOutcome {
  if (!isVerifiedApprover(who)) return { ok: false, kind: null, reason: "standing", said: "your approver standing changed — sign in again" };
  const signals: (() => void)[] = [];
  const result = store.transact(() => {
    if (!reproveApprover(store, who).ok) return { ok: false, kind: null, reason: "standing", said: "your approver standing changed — sign in again" } as const;
    const proposal = store.getCoordinatorProposal(proposalId);
    if (proposal === null || !who.repos.includes(proposal.repo)) return { ok: false, kind: null, reason: "not-yours", said: "no such proposal in your projects" } as const;
    if (Date.parse(proposal.createdAt) + COORDINATOR_PROPOSAL_TTL_MS <= now.getTime()) {
      store.casCoordinatorProposal(proposalId, "pending", "expired", null, null, now);
      return { ok: false, kind: proposal.kind, reason: "expired", said: "this proposal is older than seven days — it expired" } as const;
    }
    if (proposal.kind === "cancel") {
      return { ok: false, kind: proposal.kind, reason: "not-confirmable", said: "cancelling is armed on the task itself — open the task" } as const;
    }
    const needsConfirm = proposal.kind === "answer" && proposal.payload["reversible"] === false && options.confirm !== true;
    if (needsConfirm) return { ok: false, kind: proposal.kind, reason: "needs-confirm", said: "an irreversible choice must be confirmed explicitly" } as const;
    if (!store.casCoordinatorProposal(proposalId, "pending", "confirming", who.name, null, now)) {
      return { ok: false, kind: proposal.kind, reason: "not-pending", said: "this proposal was already acted on" } as const;
    }
    const outcome = executeProposal(store, who, proposal.kind, proposal.payload, now, { ...options, scopeAuthor: "coordinator", deferSignal: signal => signals.push(signal) });
    store.casCoordinatorProposal(proposalId, "confirming", outcome.ok ? "confirmed" : "refused", who.name, { ...outcome }, now);
    return outcome;
  });
  for (const signal of signals) signal();
  return result;
}

export function dismissCoordinatorProposal(store: Store, who: VerifiedApprover, proposalId: number, now: Date): boolean {
  if (!isVerifiedApprover(who)) return false;
  return store.transact(() => {
    if (!reproveApprover(store, who).ok) return false;
    const proposal = store.getCoordinatorProposal(proposalId);
    if (proposal === null || !who.repos.includes(proposal.repo)) return false;
    return store.casCoordinatorProposal(proposalId, "pending", "dismissed", who.name, null, now);
  });
}

/** Which door renders a coordinator proposal for this reader: the repo must be admitted. */
export function coordinatorProposalVisible(who: { repos: readonly string[] }, proposal: CoordinatorProposal): boolean {
  return who.repos.includes(proposal.repo);
}

/**
 * The shared executor: one kind, one payload, the operator's own act
 * through the primitive that owns it. Module-private (v3 review, finding
 * 1): only the two doors above reach it, and it re-proves the brand and
 * the standing itself — a structural caller executes nothing.
 */
function executeProposal(
  store: Store,
  actor: VerifiedApprover,
  kind: ProposalKind,
  payload: Record<string, unknown>,
  now: Date,
  options: DoorOptions & { scopeAuthor?: "mate" | "coordinator"; deferSignal: NonNullable<import("./task-control.js").StopRequest["deferSignal"]> },
): DoorOutcome {
  if (!isVerifiedApprover(actor) || !reproveApprover(store, actor).ok) return { ok: false, kind, reason: "standing", said: "your approver standing changed — sign in again" };
  const taskId = payloadString(payload, "task");
  const admitted = (repo: string | null): boolean => repo !== null && actor.repos.includes(repo);
  const refuse = (reason: DoorRefusal, said: string): DoorOutcome => ({ ok: false, kind, reason, said });

  if (kind === "task") {
    const repo = payloadString(payload, "repo");
    const title = payloadString(payload, "title");
    const goal = payloadString(payload, "goal");
    const planning = payloadPlanning(payload);
    if (!admitted(repo) || title === null || goal === null) return refuse("outside-ceiling", "that project is not one of yours");
    if (planning === null) return refuse("refused", "that proposal carries an invalid planning choice");
    const filed = fileTaskProposal(
      store,
      {
        title,
        repo: repo as string,
        goal,
        outOfScope: payloadString(payload, "not"),
        touches: payloadStrings(payload, "touches"),
        acceptance: payload["acceptance"],
        ...(payload["report"] === true ? { deliverable: "report" as const } : {}),
        planning,
        filedVia: "mate", filedBy: { name: actor.name, kind: "person" as const },
        proposedVia: "mate",
        admittedRepos: [...actor.repos],
      },
      now,
    );
    if (!filed.ok) return refuse("refused", `not filed: ${filed.message}`);
    const checks = payload["checks"];
    if (isCheckLevel(checks)) setTaskCheckLevel(store, filed.id, checks, actor.name, now);
    return {
      ok: true,
      kind,
      said: filed.planning
        ? `filed ${filed.id} — the planner is reading the project before you approve anything`
        : `filed ${filed.id} — review and approve its scope to start work`,
      taskId: filed.id,
    };
  }

  if (kind === "answer") {
    const decisionId = payloadNumber(payload, "decision");
    const option = payloadString(payload, "option");
    const decision = decisionId === null ? null : store.getDecision(decisionId);
    if (decision === null || option === null) return refuse("unknown-decision", "no such decision");
    const run = store.getRun(decision.run);
    const ref = run === null ? null : store.refById(run.taskRef);
    if (ref === null || !admitted(ref.repo)) return refuse("unknown-decision", "no such decision in your projects");
    const chosen = decision.options.find(one => one.id === option);
    if (chosen === undefined) return refuse("stale", "that option no longer exists on the decision");
    // The proposal contract is "open": a decision past its deadline — swept
    // or not — is not answered through a card (v3 review, finding 7).
    if (decision.state === "answered") return refuse("already-answered", "already answered — somebody got there first");
    if (decision.state !== "open" || (decision.deadline !== null && Date.parse(decision.deadline) <= now.getTime())) {
      return refuse("stale", "this decision is no longer open — answer it on its own page if you still mean to");
    }
    if (!chosen.reversible && options.confirm !== true) return refuse("needs-confirm", "an irreversible choice must be confirmed explicitly");
    const answered = store.answerDecision({ id: decision.id, choice: chosen.id, by: actor.name, via: options.via }, now);
    // The same choice landed first from somewhere else: the decision keeps
    // its first answerer, and this card did not answer it (finding 5).
    if (!answered.ok || answered.duplicate === true) {
      return !answered.ok && answered.reason !== "already-answered"
        ? refuse("refused", `not answered: ${answered.reason}`)
        : refuse("already-answered", "already answered — somebody got there first");
    }
    return { ok: true, kind, said: `decision #${decision.id} answered: ${chosen.label}`, taskId: ref.externalId };
  }

  if (taskId === null) return refuse("unknown-task", "no such task");
  const ref = store.lookupRef(taskId);
  if (ref === null || !admitted(ref.repo)) return refuse("unknown-task", "no such task in your projects");
  if (kind === "task_action") {
    // An attended surface (the console, the paired phone) honours the
    // operator's own automatic-approval mode; the CLI keeps its ceremony.
    const result = applyChatTaskAction(store, actor, payload, now, options.via !== "cli", { held: options.held, deferSignal: options.deferSignal, via: options.via, ...(options.evidenceRoot === undefined ? {} : { evidenceRoot: options.evidenceRoot }) });
    return result.ok ? { ok: true, kind, taskId: result.taskId, said: result.said } : refuse("stale", result.message);
  }

  if (kind === "review") {
    if (options.evidenceRoot === undefined) return refuse("refused", "The saved result is not available on this connection.");
    const request = payload as unknown as ReviewRequest;
    if (request.snapshot == null || request.snapshot.task !== taskId || (request.operation !== "note" && request.operation !== "revise")) return refuse("refused", "This feedback card is incomplete. Ask again.");
    const result = applyChatReview(store, actor, options.evidenceRoot, request, now, options.via !== "cli");
    return result.ok ? { ok: true, kind, taskId: result.taskId, said: result.said } : refuse("stale", result.message);
  }

  // The place the proposer saw must be the place the task holds now
  // (round-2 ruling 10; round-3 ruling 6): the revision alone misses a
  // neighbour leaving the queue by a state change.
  const placeUnchanged = (): boolean => {
    const here = store.queuePosition(taskId);
    const sawPosition = payloadNumber(payload, "position");
    const sawColumn = payload["column"];
    return here !== null && here.position === sawPosition && (here.column ?? null) === (typeof sawColumn === "string" ? sawColumn : null);
  };

  if (kind === "next") {
    const sawRevision = payloadNumber(payload, "queueRevision");
    if (sawRevision === null || sawRevision !== store.queueRevision() || !placeUnchanged()) return refuse("stale", "the queue moved since this was proposed — look again");
    const moved = store.moveTaskNext(taskId, now);
    if (!moved.ok) return refuseFromReason(kind, moved.reason);
    return { ok: true, kind, said: `${taskId} moved to the front of its column`, taskId };
  }

  if (kind === "reserve") {
    const sawRevision = payloadNumber(payload, "queueRevision");
    const worker = payload["worker"];
    if (sawRevision === null || (worker !== null && typeof worker !== "string")) return refuse("stale", "this proposal is missing what it saw");
    if (!placeUnchanged()) return refuse("stale", "the queue moved since this was proposed — look again");
    const moved = store.moveTask({ taskId, toRunner: worker as string | null, beforeTaskId: null, queueRevision: sawRevision }, now);
    if (!moved.ok) return refuseFromReason(kind, moved.reason);
    return { ok: true, kind, said: worker === null ? `${taskId} released to the shared queue` : `${taskId} reserved for ${worker as string}`, taskId };
  }

  if (kind === "hold") {
    const reason = payloadString(payload, "reason");
    if (reason === null) return refuse("refused", "this proposal carries no reason");
    const standing = store.activeHolds(ref.id, now).find(one => one.ownerKind === "operator") ?? null;
    const sawHold = payload["sawHold"];
    if ((standing?.id ?? null) !== (typeof sawHold === "number" ? sawHold : null)) {
      return refuse("stale", "the hold on this task changed since this was proposed — look again");
    }
    store.hold(ref.id, reason, null, now);
    return { ok: true, kind, said: `${taskId} held: ${reason}`, taskId };
  }

  if (kind === "unhold") {
    const holdId = payloadNumber(payload, "holdId");
    const standing = store.activeHolds(ref.id, now).find(one => one.ownerKind === "operator") ?? null;
    if (standing === null || standing.id !== holdId) return refuse("stale", "that hold is no longer the one standing — look again");
    store.unhold(ref.id);
    return { ok: true, kind, said: `${taskId} released from its hold`, taskId };
  }

  if (kind === "steer") {
    const note = payloadString(payload, "note");
    if (note === null) return refuse("refused", "this proposal carries no guidance");
    const filed = store.fileSteerNote(taskId, verifiedAuthor(actor.name), note, now);
    if (!filed.ok) {
      const said =
        filed.reason === "contest-open"
          ? "agents are racing on this task — guidance can be added after the comparison finishes"
          : filed.reason === "task-finished"
            ? "this task is finished — guidance has no next attempt to reach"
            : filed.reason === "invalid-note"
              ? (filed.problem ?? "that guidance could not be saved")
              : "no such task";
      return refuse(filed.reason === "contest-open" ? "contest-open" : "refused", said);
    }
    const taskName = payloadString(payload, "taskTitle") ?? taskId;
    return { ok: true, kind, said: `Guidance saved for ${taskName}'s next attempt`, taskId };
  }

  if (kind === "repair") {
    const blocker = payloadString(payload, "blocker");
    const operation = payloadString(payload, "operation");
    const sawBlockerState = payloadString(payload, "sawBlockerState");
    const taskName = payloadString(payload, "taskTitle") ?? taskId;
    const blockerName = payloadString(payload, "blockerTitle") ?? blocker ?? "that task";
    if (blocker === null || !store.blockers(taskId).includes(blocker)) {
      return refuse("stale", "this task no longer waits for that work — look again");
    }
    const blockerTask = store.getTask(blocker);
    if (
      blockerTask === null ||
      blockerTask.state !== sawBlockerState ||
      (blockerTask.state !== "failed" && blockerTask.state !== "cancelled")
    ) {
      return refuse("stale", "the task it was waiting for changed since this was proposed — look again");
    }
    if (store.openContestFor(ref.id) !== null) {
      return refuse("contest-open", "a tournament is running on the dependent task — let it finish first");
    }
    if (operation === "retry") {
      const blockerRef = store.lookupRef(blocker);
      if (blockerTask.state !== "failed" || blockerRef === null || !admitted(blockerRef.repo)) {
        return refuse("stale", "that failed task cannot be tried again from this conversation");
      }
      const retried = store.requeueTask(blocker, actor.name, now);
      if (!retried.ok) return refuseFromReason(kind, retried.reason);
      return { ok: true, kind, said: `${blockerName} was queued again; ${taskName} will follow when it finishes`, taskId };
    }
    if (operation === "unlink") {
      const removed = store.removeEdge(taskId, blocker);
      if (!removed.ok) return refuse("stale", "this task no longer waits for that work — look again");
      return { ok: true, kind, said: `${taskName} can now continue without ${blockerName}`, taskId };
    }
    if (operation === "replace") {
      const replacement = payloadString(payload, "replacement");
      const replacementName = payloadString(payload, "replacementTitle") ?? replacement ?? "the selected task";
      const replacementRef = replacement === null ? null : store.lookupRef(replacement);
      const replacementTask = replacement === null ? null : store.getTask(replacement);
      if (
        replacement === null ||
        replacementRef === null ||
        !admitted(replacementRef.repo) ||
        replacementTask === null ||
        (replacementTask.state !== "queued" && replacementTask.state !== "running")
      ) {
        return refuse("stale", "the selected task is no longer unfinished work in your projects — look again");
      }
      const replaced = store.replaceEdge(taskId, blocker, replacement);
      if (!replaced.ok) return refuse("stale", `this task could not wait for the selected work — ${replaced.reason}`);
      return { ok: true, kind, said: `${taskName} will now wait for ${replacementName} instead of ${blockerName}`, taskId };
    }
    return refuse("refused", "this request does not say how the waiting task should continue");
  }

  if (kind === "agents") {
    // THE AGENTS CHANGE (v48): the operator's own act through the ONE
    // authenticated route-edit transaction — the same door the task page
    // uses. Re-proved here, inside it: the actor's standing (the edit's
    // own authenticate hook), the digest the card was drafted against
    // (CAS — a scope rewritten meanwhile refuses), a live claim or open
    // contest (refused inside the store), and — for an agent — that the
    // pair is STILL one of the configured, role-valid choices right now.
    // Nothing the mate wrote becomes authority: only a configured pair,
    // recorded under the operator's name, ever reaches the route.
    const risk = payload["risk"];
    const phase = payload["phase"];
    const clear = payload["clear"] === true;
    const provider = payloadString(payload, "provider");
    const model = payloadString(payload, "model");
    const size = payload["size"];
    const risky = payload["risky"];
    if (risk !== undefined && !isRiskLevel(risk)) return refuse("refused", "this proposal carries an unknown risk level");
    if (size !== undefined && (!isTaskSize(size) || typeof risky !== "boolean")) return refuse("refused", "this proposal carries an unknown size");
    if (phase !== undefined && (typeof phase !== "string" || !PHASES.includes(phase as Phase))) return refuse("refused", "this proposal names an unknown role");
    if (risk === undefined && phase === undefined && size === undefined) return refuse("refused", "this proposal changes nothing about the agents");
    let override: { phase: Phase; provider: ProviderId; model: string } | { phase: Phase; clear: true } | undefined;
    if (typeof phase === "string") {
      if (clear) {
        override = { phase: phase as Phase, clear: true };
      } else {
        if (provider === null || model === null || !isProviderId(provider)) return refuse("refused", "this proposal names no exact agent");
        override = { phase: phase as Phase, provider, model };
      }
    }
    const edited = store.editTaskRoute(
      ref.id,
      {
        by: actor.name,
        authenticate: () => {
          const standing = reproveApprover(store, actor);
          return standing.ok ? { ok: true } : { ok: false, reason: `your approver standing changed (${standing.reason}) — sign in again` };
        },
        ...(isRiskLevel(risk) ? { risk } : {}),
        ...(isTaskSize(size) && typeof risky === "boolean" ? { size: { size, risky } } : {}),
        ...(override === undefined ? {} : { override }),
        expectDigest: payloadString(payload, "sawDigest"),
        // The pair is re-proved against the role's configured choices
        // INSIDE the edit transaction — a card drafted against an earlier
        // configuration mutates nothing.
        configured: true,
      },
      now,
    );
    if (!edited.ok) {
      if (edited.reason === "not-configured") return refuse("stale", `${specWords({ provider: provider as string, model: model as string })} is no longer one of the configured agents for that role — look again`);
      if (edited.reason === "changed") return refuse("stale", "the scope was rewritten since this was proposed — look again");
      if (edited.reason === "live-claim") return refuse("claimed", "this task is being built right now");
      if (edited.reason === "contest-open") return refuse("contest-open", "a tournament is running on this task — let it finish first");
      if (edited.reason === "unauthenticated") return refuse("standing", edited.detail);
      if (edited.reason === "no-task") return refuse("unknown-task", "no such task");
      return refuse("refused", edited.detail);
    }
    // v102: changing how a task runs is authoring it — the requester rule then refuses this person too.
    const routed = taskId === null ? null : store.getScope(taskId);
    if (routed !== null && taskId !== null) store.recordScopeAuthor(taskId, routed.digest, actor.name, now);
    const taskName = payloadString(payload, "taskTitle") ?? taskId;
    const roleWord = typeof phase === "string" ? ({ plan: "planner", build: "builder", repair: "repair", review: "reviewer" } as Record<string, string>)[phase] ?? phase : null;
    const changed = [
      ...(isRiskLevel(risk) ? [`risk is now ${riskTitle(risk).toLowerCase()}`] : []),
      ...(isTaskSize(size) ? [`it is now a ${size}${risky === true ? ", risky" : ""} change`] : []),
      ...(roleWord === null ? [] : clear ? [`the ${roleWord} choice was cleared — the recommendation stands again`] : [`the ${roleWord} is now ${specWords({ provider: provider as string, model: model as string })}`]),
    ];
    return {
      ok: true,
      kind,
      said: `Agents changed for ${taskName}: ${changed.join("; ")}${edited.staled ? " — the earlier approval no longer covers this task; approve it again" : ""}${edited.replanned ? " — a new plan was requested" : ""}`,
      taskId,
    };
  }

  if (kind === "scope") {
    const goal = payloadString(payload, "goal");
    if (goal === null) return refuse("refused", "this proposal carries no goal");
    const proposed = proposeGuarded(store, {
      taskId, author: actor.name,
      goal,
      outOfScope: payloadString(payload, "not"),
      touches: payloadStrings(payload, "touches"),
      acceptance: payload["acceptance"],
      sawDigest: payloadString(payload, "sawDigest"),
      taskRef: ref.id,
      proposedVia: options.scopeAuthor ?? "mate",
      now,
    });
    if (!proposed.ok) return refuseFromReason(kind, proposed.reason);
    return { ok: true, kind, said: `${taskId}'s scope rewritten — approve it with your password on the task`, taskId };
  }

  return refuse("not-confirmable", "this kind of proposal has no door");
}

function refuseFromReason(kind: ProposalKind, reason: string): DoorOutcome {
  const known: Record<string, { reason: DoorRefusal; said: string }> = {
    stale: { reason: "stale", said: "the queue moved since this was proposed — look again" },
    changed: { reason: "stale", said: "the scope was rewritten since this was proposed — look again" },
    claimed: { reason: "claimed", said: "this task is being built right now" },
    "not-queued": { reason: "not-queued", said: "only queued work can move — this task is not waiting in the queue" },
    "contest-open": { reason: "contest-open", said: "a tournament is running on this task — let it finish first" },
    "unknown-task": { reason: "unknown-task", said: "no such task" },
  };
  const typed = known[reason];
  return typed === undefined ? { ok: false, kind, reason: "refused", said: `refused: ${reason}` } : { ok: false, kind, ...typed };
}
