/**
 * The mate's turn engine (mate arc §3): one reservation for the whole
 * loop, one `chat_turn` step per provider request, tools executed
 * in-process under the branded approver, results through `mateView`, and
 * only operator text and assistant text kept (ruling 11). The console
 * and the CLI drive this and render from the rows it writes.
 *
 * Slice-1 review, folded in: the session, thread, and credential are
 * bound to the principal inside the store's admission (finding 2); the
 * principal is re-proved after every network wait and the turn's own
 * row is re-read, so a revocation mid-flight ends the loop before any
 * tool runs (finding 5); a step whose cost is unknown charges the whole
 * reservation (finding 1); the latch is re-checked before every dispatch
 * (finding 11); usage that cannot be true is malformed, never a discount
 * (finding 8); and everything the model sees passed `mateView` (finding 9).
 */
import type { CommitmentChannel } from "./lead-commitments.js";
import { Buffer } from "node:buffer";
import { mateToolLabel, type MateProgress } from "./mate-progress.js";
import { createHash } from "node:crypto";
import type { ChatConfig, DirectChatProviderId, MateProposalKind, MateSession, MateThread, MateTurnEvidence, Store, SubscriptionChatProviderId } from "./store.js";
import { RESULT_IMAGES_PER_TURN_CAP } from "./chat-evidence.js";
import type { Integration } from "./integrations.js";
import type { VerifiedApprover } from "./principal.js";
import { isVerifiedApprover, reproveApprover } from "./principal.js";
import {
  MATE_MAX_CALLS_PER_STEP,
  MATE_MAX_STEPS,
  MATE_TOOL_RESULT_CAP_BYTES,
  TURN_WALL_CLOCK_MS,
  composeMateRequest,
  credentialKeyOf,
  isDirectChatProvider,
  mateWorstCaseForPrice,
  performMateRequest,
  priceForConfig,
  settleForPrice,
  subscriptionCredentialKey,
  type MateHistoryMessage,
} from "./converse.js";
import { redactSecretLines, scanForSecrets } from "./evidence.js";
import { redactSecretAssignments } from "./builder.js";
import { MATE_CONTRACT } from "./mate-contract.js";
import { MATE_MAX_PROPOSALS_PER_TURN, MATE_TOOL_SCHEMAS, executeMateTool, isMateTool, mateViewContextFor, projectLabelForMate, redactForMate, toolResultBytes } from "./mate-tools.js";
import type { ReviewSnapshot } from "./chat-review.js";
import { composeSubscriptionMatePrompt, performSubscriptionMateRequest, type SubscriptionMateRunner } from "./subscription-chat.js";
import { LEAD_REPLY_LIMITS, leadContext, type LeadChannel } from './lead-context.js';
import { shortenAsk } from './text-limits.js';
import { envValue } from "./names.js";
import { deliverableClaim, deliverableRepair, dropDeliverableClaims, replyCarriesDeliverable } from "./reply-shape.js";

export const MATE_MESSAGE_MAX_CHARS = 2_000;
/** Where a promise made this turn is reported: the chat app it arrived on, or this conversation for the console and terminal. */
function promiseChannelOfTurn(channel: LeadChannel | undefined): CommitmentChannel | undefined {
  return channel === undefined ? undefined : channel === "console" || channel === "terminal" ? "chat" : channel;
}

/** The thread's recent history the model sees, most recent first until the cap. */
export const MATE_HISTORY_CAP_BYTES = 16_384;
export const MATE_HISTORY_MAX_MESSAGES = 40;

export type MateTurnInput = {
  store: Store;
  who: VerifiedApprover;
  session: MateSession;
  thread: MateThread;
  /** The installation's chat configuration: provider, model, pinned price, caps. */
  config: ChatConfig;
  /** Direct API key; subscription providers use their cached harness login. */
  key: string | null;
  message: string;
  /** Stable browser send identity. A retry returns the original turn,
   * including a failed one; it never dispatches the provider again. */
  requestId?: string;
  /** A central conversation saved this operator message before acknowledging
   * delivery. Bind it to this turn instead of inserting a second copy. */
  queuedMessageId?: number;
  /** Called inside turn admission. A failed queue fence rolls admission back. */
  onAdmitted?: (turn: number) => void;
  /** Safe, server-authored context for this turn only. Kept out of the
   * visible thread so a task-scoped composer still reads like a normal
   * conversation. */
  context?: string;
  fetcher?: typeof fetch;
  /** Injected by tests; production invokes the isolated local harness. */
  subscriptionRunner?: SubscriptionMateRunner;
  /** Live progress for someone watching (chat streaming): the steps, the
   * tools in plain words, and the reply as it is written. Display only;
   * never called with text that looks like a secret. */
  onProgress?: (event: MateProgress) => void;
  clock?: () => Date;
  /** Where evidence lives — get_task reads a scout's report from here. */
  evidenceRoot?: string;
  /** Where this conversation happens, so the lead fits its replies to it. */
  channel?: LeadChannel;
  /** A shared team conversation's own lead name, in place of this person's (Settings → Lead). */
  leadName?: string;
  /** How this surface delivers the images a turn selects: Telegram sends them as documents after the reply; absent means identity only. */
  mediaDelivery?: "documents";
  /** The integrations as Settings → Integrations shows them (get_integrations); absent: read from the files beside the database. */
  integrations?: () => readonly Integration[];
  /**
   * A channel's own standing, re-proved where the approver's is: before
   * admission, before every provider dispatch, after every provider wait,
   * and before any tool runs. The
   * paired Telegram chat uses it to prove the binding, its generation and
   * the enrolled ceiling are still what the turn opened under — account
   * generation alone cannot see an unpairing or a project removed from
   * enrollment. A refusal ends the turn with nothing kept.
   */
  revalidate?: () => Promise<{ ok: true } | { ok: false; reason: MateChannelProblem }>;
};

/** Why a chat's standing changed under a turn: each has its own plain words (MATE_CHANNEL_COPY). */
export type MateChannelProblem = "unpaired" | "not-approver" | "projects-changed" | "projects-unreadable" | "member-changed" | "access-changed";

export type MateRefusal =
  | "empty-message"
  | "secret-in-message"
  | "secret-in-context"
  | "standing"
  | "unpriced"
  | "ceiling-changed"
  | "not-yours"
  | "thread-closed"
  | "latched"
  | "concurrent"
  | "daily-cap"
  | "session-exhausted"
  | "session-ended"
  | "over-budget"
  | "monthly-budget"
  | "policy"
  | "invalid-request"
  | "request-changed"
  | "channel";

export type MateFailure = "provider-error" | "timeout" | "malformed-reply" | "secret-refused" | "latched" | "revoked" | "superseded";

export type MateTurnOutcome =
  | { ok: true; replayed?: false; turn: number; reply: string; activity: string; proposals: number; steps: number; stoppedAtCap: boolean; settledMicrousd: number }
  | { ok: true; replayed: true; turn: number }
  | { ok: false; refused: MateRefusal; message: string }
  | { ok: false; turn: number; failed: MateFailure; message: string; unknownSpend: boolean };

/** What happened, what it means, and one next step: plain words a person can act on, never internal terms. */
export const MATE_REFUSAL_COPY: Record<MateRefusal, string> = {
  "empty-message": `That message was empty or too long, so it wasn't sent. Write 1 to ${MATE_MESSAGE_MAX_CHARS} characters and send it again.`,
  "secret-in-message": "That message looks like it contains a password or key, so it wasn't sent or saved. Remove it and send the message again.",
  "secret-in-context": "Something saved in your projects looks like a password or key, so the lead can't read your projects safely. Remove it from the task or note it's in, then try again.",
  standing: "Your sign-in changed, so the lead can't act for you right now. Sign in again.",
  unpriced: "The chat model has no saved price, so its cost can't be tracked. Save the chat settings again to fix it.",
  "ceiling-changed": "Your projects changed since this chat started, so it can't go on. Start a new chat.",
  "not-yours": "This chat belongs to someone else, so you can't continue it. Start your own chat.",
  "thread-closed": "This conversation is closed. Start a new one to keep going.",
  latched: "An earlier reply stopped before its cost was known, so chat is paused. Acknowledge that reply on the Chat page, then send again.",
  concurrent: "The lead is still answering your last message. Wait for that reply, then send this one.",
  "daily-cap": "You've reached today's limit on chat replies, so this one wasn't sent. Try again tomorrow.",
  "session-exhausted": "This chat has used its spending limit. Start a new chat to keep going.",
  "session-ended": "This chat has ended. Start a new chat to keep going.",
  "over-budget": "This reply would go over this week's chat spending limit, so it wasn't sent. Raise the weekly limit in chat settings to keep going.",
  "monthly-budget": "A monthly budget this chat counts toward is used up, or its cost can't be worked out yet. Open the Spend page to see which.",
  policy: "Your organisation's policy doesn't allow this chat's provider or model. Open Settings → Policy to see what's allowed.",
  "invalid-request": "This message couldn't be matched to your conversation. Reload the conversation, then send it again.",
  "request-changed": "That send was already received with different text or task context. Reload the conversation before sending a new message.",
  channel: "This conversation's connection changed, so the message wasn't sent. Reconnect it, then send again.",
};

/** A turn stopped because its chat's standing changed: what happened, what it means, one next step. */
export const MATE_CHANNEL_COPY: Record<MateChannelProblem, string> = {
  unpaired: "This chat is no longer connected to your account, so the reply was stopped. Nothing it proposed was kept. Connect the chat again in Settings, then send your message again.",
  "not-approver": "Your account can no longer approve work here, so the reply was stopped. Nothing it proposed was kept. Ask an owner to restore your access, then send your message again.",
  "projects-changed": "The projects this chat can see changed while the lead was answering, so the reply was stopped. Nothing it proposed was kept. Send your message again.",
  "projects-unreadable": "Your project list couldn't be read just now, so the reply was stopped. Nothing it proposed was kept. Send your message again in a minute.",
  "member-changed": "Your account in this chat app no longer has access, so the reply was stopped. Nothing it proposed was kept. Ask the app's admin to add you back, then send your message again.",
  "access-changed": "This chat's access changed while the lead was answering, so the reply was stopped. Nothing it proposed was kept. Reconnect the chat, then send your message again.",
};

/** Why a reply did not finish, in the same three parts: what happened, what it means, one next step. */
export const MATE_FAILURE_COPY = {
  stopped: "This reply was stopped before it finished, from another window or by a newer message. Nothing it proposed was kept. Send your message again if you still need an answer.",
  ended: "Your sign-in or this conversation ended while the lead was answering. Nothing it proposed was kept. Sign in again or start a new chat, then send your message again.",
  tooLong: "The reply took too long and was stopped. Nothing it proposed was kept. Send your message again, or ask for less at once.",
  secretRead: "Something the lead read looked like a password or key, so it stopped before sending it anywhere. Nothing was kept. Remove the password or key from that task or note, then ask again.",
  secretReply: "The lead's reply contained something that looked like a password or key, so it was thrown away. Nothing was kept. Ask again, without asking for a password or key.",
  paused: "An earlier reply stopped before its cost was known, so chat is paused. This message wasn't answered. Confirm that earlier reply on the Chat page, then send again.",
  notStarted: "The reply couldn't be started. Nothing was kept or charged. Send your message again.",
  notInstalled: "The chat app the lead uses isn't installed on this computer, so it couldn't answer. Nothing was kept. Install it, or choose another provider in Settings → Lead.",
  unreadable: "The chat provider sent back an answer that couldn't be read, so it was thrown away. Nothing was kept. Send your message again.",
  signIn: "The chat provider couldn't answer; its sign-in may have expired. Nothing was kept. Sign in to it again on this computer, then send your message again.",
  refused: "The chat provider turned the request down. Nothing was kept or charged. Try again in a minute; if it keeps happening, check the provider in Settings → Lead.",
  tooLongUnknownCost: "The reply took too long and was stopped, and its cost isn't known yet, so chat is paused. Nothing it proposed was kept. Confirm the cost on the Chat page to turn chat back on.",
  lostUnknownCost: "The chat provider stopped responding partway through, and the cost isn't known, so chat is paused. Nothing it proposed was kept. Confirm the cost on the Chat page to turn chat back on.",
  unreadableUnknownCost: "The chat provider sent back an answer that couldn't be read, and its cost isn't known, so chat is paused. Nothing it proposed was kept. Confirm the cost on the Chat page to turn chat back on.",
  empty: "The lead sent back an empty answer. Nothing was kept. Send your message again.",
  unusable: "The lead's answer couldn't be used, so it was thrown away. Nothing was kept. Send your message again.",
} as const;

/** A failed turn's saved reason as plain words, for a surface that reads the turn back later (a restart, a delivery retry). */
export function mateFailureText(reason: string | null): string {
  switch (reason) {
    case "timeout": return MATE_FAILURE_COPY.tooLong;
    case "malformed-reply": return MATE_FAILURE_COPY.unreadable;
    case "secret-refused": return MATE_FAILURE_COPY.secretReply;
    case "latched": return MATE_FAILURE_COPY.paused;
    case "revoked": return MATE_FAILURE_COPY.ended;
    case "superseded": return MATE_FAILURE_COPY.stopped;
    case "provider-error": return MATE_FAILURE_COPY.refused;
    default: return "The lead's reply didn't finish. Nothing it proposed was kept. Send your message again.";
  }
}

const READ_TOOLS = new Set(["get_brief", "get_project_context", "get_actions", "get_action_status", "get_skills", "get_acceptance_evidence", "recap", "list_repos", "list_tasks", "get_task", "get_result", "get_result_images", "get_controls", "get_agents", "get_project_knowledge", "get_task_conversation", "get_diff", "get_check_log", "get_project_tools", "get_flows", "get_flow_insights", "list_decisions", "get_decision", "queue"]);

/** The last messages of the thread as provider-neutral history, newest kept first until the byte cap. */
export function historyFor(store: Store, thread: number, queuedMessageId?: number): MateHistoryMessage[] {
  const rows = store.listMateMessages(thread, MATE_HISTORY_MAX_MESSAGES);
  const kept: MateHistoryMessage[] = [];
  let bytes = 0;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    // Other teammates may have already queued later messages. They do not
    // enter model history until admitted, and the current message appears once.
    if (queuedMessageId !== undefined && (row.id === queuedMessageId || row.role === 'operator' && row.turn === null)) continue;
    bytes += Buffer.byteLength(row.text, "utf8");
    if (bytes > MATE_HISTORY_CAP_BYTES) break;
    const author = queuedMessageId !== undefined && row.role === 'operator' && row.turn !== null ? store.getMateTurn(row.turn)?.approver : undefined;
    kept.unshift(row.role === "operator" ? { role: "operator", text: author ? `From ${author}:\n${row.text}` : row.text } : { role: "assistant", text: row.text, calls: [] });
  }
  // A history must open with the operator: a leading assistant reply without its question is dropped.
  while (kept[0]?.role === "assistant") kept.shift();
  return kept;
}

/** "read 3 · proposed 1 · 2 steps" — counts only, never results (ruling 11). */
export function activitySummary(reads: number, proposals: number, steps: number): string {
  return [`read ${reads}`, `proposed ${proposals}`, `${steps} step${steps === 1 ? "" : "s"}`].join(" · ");
}

/** A tool result as the model sees it, measured as embedded; over the cap it becomes a typed refusal. */
function capped(value: unknown): string {
  const text = JSON.stringify(value);
  if (toolResultBytes(text) <= MATE_TOOL_RESULT_CAP_BYTES) return text;
  return JSON.stringify({ ok: false, message: "that result is over the size cap — ask for less: one project, one state, or a smaller limit" });
}

export async function runMateTurn(input: MateTurnInput): Promise<MateTurnOutcome> {
  const { store, who, session, thread, config } = input;
  const clock = input.clock ?? (() => new Date());
  const fetcher = input.fetcher ?? fetch;
  const refuse = (refused: MateRefusal): MateTurnOutcome => ({ ok: false, refused, message: MATE_REFUSAL_COPY[refused] });

  const message = input.message.trim();
  if (message === "" || message.length > MATE_MESSAGE_MAX_CHARS) return refuse("empty-message");
  // Secrets refuse BEFORE any row or request exists — nothing stored, nothing sent.
  if (scanForSecrets(message).length > 0) return refuse("secret-in-message");
  // Ruling 3 + 10: a minted, intact principal, re-proved against the current row.
  if (!isVerifiedApprover(who) || !reproveApprover(store, who).ok || who.generation !== session.approverGeneration) return refuse("standing");
  // Ruling 9: the session and the thread are bound to the ceiling this surface holds.
  if (session.ceilingDigest !== who.ceilingDigest || thread.ceilingDigest !== who.ceilingDigest) return refuse("ceiling-changed");
  // Sprint 8: the lead and project chats run on a provider and model the organisation policy allows, or not at all.
  const disallowed = store.agentPolicyRefusal(config.provider, config.model);
  if (disallowed !== null) return { ok: false, refused: "policy", message: disallowed };
  const directProvider = isDirectChatProvider(config.provider) ? config.provider : null;
  const subscriptionProvider = directProvider === null ? config.provider as SubscriptionChatProviderId : null;
  const direct = directProvider !== null;
  const price = direct ? priceForConfig(config) : null;
  if (direct && price === null) return refuse("unpriced");
  if (direct && input.key === null) return refuse("unpriced");
  // API accounting binds to the secret credential. A subscription has no
  // API credential or dollar ledger, but changing harness still ends the
  // old session through a stable provider-specific identity.
  const credentialKey = direct
    ? credentialKeyOf(directProvider, input.key as string)
    : subscriptionCredentialKey(subscriptionProvider as SubscriptionChatProviderId);

  const request = input.requestId;
  if (request !== undefined && !/^[a-f0-9]{32}$/.test(request)) return refuse("invalid-request");
  // Replays are read-only, but still require today's authority, not the
  // session/thread snapshots supplied by a previous browser page.
  const liveSession = store.getMateSession(session.id);
  const liveThread = store.getMateThread(thread.id);
  const sharedThread = liveThread !== null && store.canUseTeamMateThread(who.name, who.generation, liveThread.id);
  if (liveSession?.approver !== who.name || (liveThread?.approver !== who.name && !sharedThread) || liveSession.credentialKey !== credentialKey) return refuse("not-yours");
  if (input.queuedMessageId !== undefined && (!sharedThread || !Number.isSafeInteger(input.queuedMessageId) || input.onAdmitted === undefined)) return refuse('invalid-request');
  if (liveSession.endedAt !== null) return refuse("session-ended");
  if (liveThread.closedAt !== null) return refuse("thread-closed");
  if (liveSession.ceilingDigest !== who.ceilingDigest || liveThread.ceilingDigest !== who.ceilingDigest) return refuse("ceiling-changed");
  const digest = createHash("sha256").update(JSON.stringify([thread.id, message, input.context ?? null])).digest("hex");
  const receipt = request === undefined ? null : store.mateRequestReceipt(session.id, request);
  if (receipt !== null) return receipt.digest === digest ? { ok: true, replayed: true, turn: receipt.turn } : refuse("request-changed");
  // The channel's standing, proved before anything is admitted or sent.
  if (input.revalidate !== undefined && !(await input.revalidate()).ok) return refuse("channel");

  let now = clock();
  store.sweepStaleMateTurns(now);

  const view = mateViewContextFor(store, who);
  // Names in the bundle are deliberate (the lead's, the person's first name, project labels); everything else is scrubbed.
  const document = leadContext(store, who.repos, now, { owner: who.name, thread: thread.id, redact: text => redactForMate(text, view),
    projectName: (path, index) => projectLabelForMate(path, index, view.names),
    ...(input.evidenceRoot === undefined ? {} : { evidenceRoot: input.evidenceRoot }), ...(input.channel === undefined ? {} : { channel: input.channel }), ...(input.leadName === undefined ? {} : { leadName: input.leadName }) });
  const authoredMessage = input.queuedMessageId === undefined ? message : `From ${who.name}:\n${message}`;
  const historyMessage = input.context === undefined ? authoredMessage : `${redactForMate(input.context, view)}\n\n${authoredMessage}`;
  const history: MateHistoryMessage[] = [...historyFor(store, thread.id, input.queuedMessageId), { role: "operator", text: historyMessage }];
  const composeDirect = (key: string): { url: string; headers: Record<string, string>; body: string } => {
    if (!direct) throw new Error("not a direct chat provider");
    return composeMateRequest({ provider: directProvider as DirectChatProviderId, model: config.model, key, system: MATE_CONTRACT, dataDocument: document, history, tools: MATE_TOOL_SCHEMAS });
  };
  const composeSubscription = (): string =>
    composeSubscriptionMatePrompt({ system: MATE_CONTRACT, dataDocument: document, history, tools: MATE_TOOL_SCHEMAS });
  // The exact outbound base is scanned whole. Only direct API traffic needs
  // a worst-case dollar reservation; subscription traffic records zero.
  const base = direct ? composeDirect("").body : composeSubscription();
  if (scanForSecrets(base).length > 0) return refuse("secret-in-context");
  // Fit the bounded tool loop to the already-authorized remaining allowance.
  // Context/history growth must not demand a larger budget for a simple reply.
  // Each chosen step retains the same worst-case call/output accounting.
  let maxSteps = MATE_MAX_STEPS;
  const baseBytes = Buffer.byteLength(base, "utf8");
  const reserveFor = (steps: number) => direct ? mateWorstCaseForPrice(price as NonNullable<typeof price>, baseBytes, { steps }) : 0;
  if (direct) {
    const remaining = Math.min(liveSession.ceilingMicrousd - liveSession.spentMicrousd,
      config.weeklyCeilingMicrousd - store.chatWeeklySpendMicrousd(credentialKey, now));
    while (maxSteps > 1 && reserveFor(maxSteps) > remaining) maxSteps--;
  }
  const reserved = reserveFor(maxSteps);

  const admitted = store.transact(() => {
    const existing = request === undefined ? null : store.mateRequestReceipt(session.id, request);
    if (existing !== null) return existing.digest === digest
      ? { ok: true as const, replayed: true as const, turnId: existing.turn }
      : { ok: false as const, reason: "request-changed" as const };
    const opened = store.openMateTurn(
      {
        approver: who.name,
        session: session.id,
        thread: thread.id,
        credentialKey,
        reservedMicrousd: reserved,
        dailyTurns: config.dailyTurns,
        weeklyCeilingMicrousd: config.weeklyCeilingMicrousd,
        deadlineMs: TURN_WALL_CLOCK_MS + 10_000,
        provider: config.provider,
      },
      now,
    );
    if (!opened.ok) return opened;
    const turnId = opened.id;
    const started = store.startMateTurn(turnId, now);
    if (!started.ok) throw new Error("new mate turn could not start");
    if (input.queuedMessageId === undefined) store.appendMateMessage({ thread: thread.id, turn: turnId, role: "operator", text: message }, now);
    else {
      const bound = store.handle.prepare("UPDATE mate_message SET turn=? WHERE id=? AND thread=? AND role='operator' AND turn IS NULL AND text=?")
        .run(turnId, input.queuedMessageId, thread.id, message);
      if (Number(bound.changes) !== 1) throw new Error('The queued message changed before admission.');
    }
    input.onAdmitted?.(turnId);
    if (request !== undefined) store.replay({ idempotencyKey: `mate-send:${session.id}:${request}`, actor: who.name, at: now }, "mate-send", () => ({ digest, turn: turnId }));
    return { ok: true as const, turnId, generation: started.generation };
  });
  if (!admitted.ok) return refuse(admitted.reason);
  if ("replayed" in admitted) return { ok: true, replayed: true, turn: admitted.turnId };
  const turnId = admitted.turnId;
  const started = { generation: admitted.generation };
  const turnStartedAt = now.getTime();
  const progress = (event: MateProgress): void => { try { input.onProgress?.(event); } catch { /* a watcher never breaks the turn */ } };
  progress({ kind: "started", turn: turnId });

  let proposals = 0;
  let reads = 0;
  let steps = 0;
  const readDecisions = new Map<number, number>();
  const readResults = new Map<number, { step: number; snapshot: ReviewSnapshot }>();
  const searchedMemory = new Map<string, number>();
  const checkedCapabilities = new Map<string, number>();
  /** The turn's one question to its owner: shown with the reply only once the turn answers; a failed turn drops it. */
  const ask = (question: string, options: readonly string[]): boolean => store.recordMateAsk({ turn: turnId, thread: thread.id, question, options }, clock());
  let tokensIn = 0;
  let tokensOut = 0;
  let settled = 0;
  const draft = (kind: MateProposalKind, payload: Record<string, unknown>): number | null => {
    if (proposals >= MATE_MAX_PROPOSALS_PER_TURN) return null;
    proposals++;
    return store.draftMateProposal({ thread: thread.id, turn: turnId, kind, payload, ceilingDigest: who.ceilingDigest }, clock());
  };
  /** The screenshots a tool selected, kept under THIS turn: a failed turn deletes them with its drafts; a channel plans sends only from an answered turn. */
  const selectEvidence = (rows: readonly Omit<MateTurnEvidence, "turn" | "ordinal" | "createdAt">[]): readonly number[] => {
    store.recordMateTurnEvidence(turnId, rows, RESULT_IMAGES_PER_TURN_CAP, clock());
    if (store.getMateTurn(turnId)?.state !== "running") return [];
    return store.listMateTurnEvidence(turnId).map(one => one.artifact);
  };

  /** The turn ends failed: its drafts are deleted, its cost settled — the whole reservation when any of it is unknown. */
  const fail = (failed: MateFailure, message: string, unknownSpend: boolean): MateTurnOutcome => {
    now = clock();
    store.finalizeMateTurn(turnId, started.generation, { state: "failed", settledMicrousd: settled, unknownSpend, tokensIn, tokensOut, failureReason: failed }, now);
    store.dropMateAsk(turnId);
    return { ok: false, turn: turnId, failed, message, unknownSpend };
  };
  /** The turn's own row, re-read: still running under our generation, or someone ended it under us. */
  const stillOurs = (): boolean => {
    const row = store.getMateTurn(turnId);
    return row !== null && row.state === "running" && row.generation === started.generation;
  };
  // The channel lookup can await external state. Re-read all local authority
  // AFTER it resolves, immediately before sending context or using a tool.
  const guard = (channel: { ok: true } | { ok: false; reason: MateChannelProblem }): MateTurnOutcome | null => {
    if (!stillOurs()) return { ok: false, turn: turnId, failed: "superseded", message: MATE_FAILURE_COPY.stopped, unknownSpend: false };
    if (!channel.ok) return fail("revoked", MATE_CHANNEL_COPY[channel.reason] ?? MATE_CHANNEL_COPY["access-changed"], false);
    const standing = reproveApprover(store, who);
    const liveSession = store.getMateSession(session.id);
    const liveThread = store.getMateThread(thread.id);
    if (!standing.ok || liveSession === null || liveSession.endedAt !== null || liveThread === null || liveThread.closedAt !== null) {
      return fail("revoked", MATE_FAILURE_COPY.ended, false);
    }
    return null;
  };

  let reply: string | null = null;
  let stoppedAtCap = false;
  let lastText = "";
  /** A page shown this turn (show_control): a reply may say it links one. */
  let shownControl = false;
  /** The turn's one repair step for a reply that claims an attachment it does not carry. */
  let repaired = false;
  /** The turn's one shorten step for a reply over its channel's message limit (LEAD_REPLY_LIMITS); still over, it is split. */
  let shortened = false;
  const replyLimit = input.channel === undefined ? null : LEAD_REPLY_LIMITS[input.channel];
  const unbacked = (text: string): string | null => {
    const claim = deliverableClaim(text);
    if (claim === null || shownControl || replyCarriesDeliverable(text) || store.listMateTurnEvidence(turnId).length > 0) return null;
    return claim;
  };
  while (steps < maxSteps) {
    const blocked = guard(input.revalidate === undefined ? { ok: true } : await input.revalidate());
    if (blocked !== null) return blocked;
    now = clock();
    const remainingMs = TURN_WALL_CLOCK_MS - (now.getTime() - turnStartedAt);
    if (remainingMs <= 0) return fail("timeout", MATE_FAILURE_COPY.tooLong, false);
    const request = direct ? composeDirect(input.key as string) : composeSubscription();
    // Tool results join the outbound body: scanned again before every dispatch.
    const outbound = typeof request === "string" ? request : request.body;
    if (scanForSecrets(outbound).length > 0) {
      return fail("secret-refused", MATE_FAILURE_COPY.secretRead, false);
    }
    const step = store.openMateStep(
      { mateTurn: turnId, generation: started.generation, approver: who.name, credentialKey, provider: config.provider, model: config.model, deadlineMs: remainingMs + 10_000 },
      now,
    );
    if (!step.ok) {
      if (step.reason === "latched") return fail("latched", MATE_FAILURE_COPY.paused, false);
      return { ok: false, turn: turnId, failed: "superseded", message: MATE_FAILURE_COPY.stopped, unknownSpend: false };
    }
    const stepStarted = store.startChatTurn(step.id, now);
    if (!stepStarted.ok) return fail("provider-error", MATE_FAILURE_COPY.notStarted, false);
    steps++;
    progress({ kind: "step", turn: turnId, step: steps });
    const requestBytes = Buffer.byteLength(outbound, "utf8");
    let result: Awaited<ReturnType<typeof performMateRequest>>;
    if (direct) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);
      try {
        result = await performMateRequest(request as { url: string; headers: Record<string, string>; body: string }, directProvider, controller.signal, fetcher);
      } catch {
        result = { ok: false, problem: "network" };
      } finally {
        clearTimeout(timer);
      }
    } else {
      const runner = input.subscriptionRunner ?? performSubscriptionMateRequest;
      try {
        result = await runner({
          provider: subscriptionProvider as SubscriptionChatProviderId,
          model: config.model,
          system: MATE_CONTRACT,
          dataDocument: document,
          history,
          tools: MATE_TOOL_SCHEMAS,
          timeoutMs: remainingMs,
          // The reply as it is written; text that looks like a secret is
          // never shown (the finished reply is scanned again before saving).
          ...(input.onProgress === undefined ? {} : { onText: (text: string) => { if (scanForSecrets(text).length === 0) progress({ kind: "text", turn: turnId, step: steps, text }); } }),
        });
      } catch {
        result = { ok: false, problem: "provider-error" };
      }
    }
    now = clock();
    const finishStep = (outcome: Parameters<Store["finalizeChatTurn"]>[2]): boolean => store.finalizeChatTurn(step.id, stepStarted.generation, outcome, now);
    if (!result.ok) {
      if (!direct) {
        finishStep({ state: "failed", failureReason: result.problem === "timeout" ? "timeout" : result.problem === "malformed-reply" ? "malformed-reply" : "provider-error", settledMicrousd: 0 });
        const message =
          result.problem === "not-found"
            ? MATE_FAILURE_COPY.notInstalled
            : result.problem === "timeout"
              ? MATE_FAILURE_COPY.tooLong
              : result.problem === "malformed-reply"
                ? MATE_FAILURE_COPY.unreadable
                : MATE_FAILURE_COPY.signIn;
        return fail(result.problem === "timeout" ? "timeout" : result.problem === "malformed-reply" ? "malformed-reply" : "provider-error", message, false);
      }
      if (result.problem.startsWith("status-")) {
        // The provider ANSWERED with an error: nothing billed for this step.
        finishStep({ state: "failed", failureReason: "provider-error", settledMicrousd: 0 });
        return fail("provider-error", MATE_FAILURE_COPY.refused, false);
      }
      if (result.problem === "timeout") {
        finishStep({ state: "failed", failureReason: "timeout", settledMicrousd: null, unknownSpend: true });
        return fail("timeout", MATE_FAILURE_COPY.tooLongUnknownCost, true);
      }
      if (result.problem === "network") {
        finishStep({ state: "failed", failureReason: "provider-error", settledMicrousd: null, unknownSpend: true });
        return fail("provider-error", MATE_FAILURE_COPY.lostUnknownCost, true);
      }
      finishStep({ state: "failed", failureReason: "malformed-reply", settledMicrousd: null, unknownSpend: true });
      return fail("malformed-reply", MATE_FAILURE_COPY.unreadableUnknownCost, true);
    }
    const answer = result.answer;
    // Usage that cannot be true — more input tokens than bytes sent — is a
    // malformed reply with unknown cost, never a number to settle by.
    if (direct && answer.tokensIn > requestBytes) {
      finishStep({ state: "failed", failureReason: "malformed-reply", settledMicrousd: null, unknownSpend: true });
      return fail("malformed-reply", MATE_FAILURE_COPY.unreadableUnknownCost, true);
    }
    // The pinned math, or the provider's own reported charge when HIGHER.
    const stepSettled = direct
      ? Math.max(settleForPrice(price as NonNullable<typeof price>, answer.tokensIn, answer.tokensOut), answer.reportedCostMicrousd ?? 0)
      : 0;
    finishStep({ state: "answered", tokensIn: answer.tokensIn, tokensOut: answer.tokensOut, settledMicrousd: stepSettled, replyBytes: Buffer.byteLength(answer.text, "utf8") });
    tokensIn += answer.tokensIn;
    tokensOut += answer.tokensOut;
    settled += stepSettled;
    lastText = answer.text;

    // After the wait (finding 5): the row may have been failed under us by
    // a revocation or the sweep — then nothing the model said runs; and the
    // approver must still stand before any tool runs as them.
    const changed = guard(input.revalidate === undefined ? { ok: true } : await input.revalidate());
    if (changed !== null) return changed;

    if (answer.calls.length === 0) {
      if (answer.text.trim() === "") return fail("malformed-reply", MATE_FAILURE_COPY.empty, false);
      // "Here's the screenshot" with nothing attached or linked: one repair step to attach it or drop the claim; never the claim alone.
      const claim = unbacked(answer.text);
      if (claim !== null && !repaired && steps < maxSteps) {
        repaired = true;
        history.push({ role: "assistant", text: answer.text, calls: [] });
        history.push({ role: "operator", text: deliverableRepair(claim) });
        continue;
      }
      const candidate = claim === null ? answer.text : dropDeliverableClaims(answer.text);
      if (replyLimit !== null && candidate.length > replyLimit && !shortened && steps < maxSteps) {
        shortened = true;
        history.push({ role: "assistant", text: answer.text, calls: [] });
        history.push({ role: "operator", text: shortenAsk([{ field: "Your reply", limit: replyLimit, length: candidate.length }]) });
        continue;
      }
      reply = candidate;
      break;
    }
    if (answer.calls.length > MATE_MAX_CALLS_PER_STEP) return fail("malformed-reply", MATE_FAILURE_COPY.unusable, false);
    for (const call of answer.calls) {
      if (!isMateTool(call.name)) return fail("malformed-reply", MATE_FAILURE_COPY.unusable, false);
    }
    history.push({ role: "assistant", text: answer.text, calls: answer.calls });
    for (const [index, call] of answer.calls.entries()) {
      if (index > 0) {
        const changed = guard(input.revalidate === undefined ? { ok: true } : await input.revalidate());
        if (changed !== null) return changed;
      }
      progress({ kind: "tool", turn: turnId, step: steps, label: mateToolLabel(call.name) });
      const outcome = executeMateTool({ store, who, now: clock(), draft, selectEvidence, step: steps, readDecisions, readResults, searchedMemory, checkedCapabilities, ask, ...(input.integrations === undefined ? {} : { integrations: input.integrations }), thread: thread.id, turn: turnId, ...(promiseChannelOfTurn(input.channel) === undefined ? {} : { channel: promiseChannelOfTurn(input.channel)! }), ...(input.evidenceRoot === undefined ? {} : { evidenceRoot: input.evidenceRoot }), ...(input.mediaDelivery === undefined ? {} : { mediaDelivery: input.mediaDelivery }) }, call.name, call.args, view);
      if (READ_TOOLS.has(call.name)) reads++;
      if (call.name === "show_control" && outcome.ok) shownControl = true;
      // Opt-in, local diagnostics for end-to-end runs: what the lead asked of each tool and what came back (its start), keys
      // blanked. Each line stays whole JSON so a run can assert on what a tool returned rather than on the model's words.
      if (envValue(process.env, "MATE_TRACE") === "1") {
        const blanked = (_: string, value: unknown) => typeof value === "string" ? redactSecretAssignments(redactSecretLines(value, scanForSecrets(value))) : value;
        const args = JSON.stringify(call.args, blanked).slice(0, 1500);
        const result = JSON.stringify(outcome.ok ? outcome.body : null, blanked)?.slice(0, 2000) ?? null;
        process.stderr.write(`mate-trace ${JSON.stringify({ turn: turnId, step: steps, tool: call.name, args: args.length < 1500 ? call.args : args, ok: outcome.ok, ...(outcome.ok ? { result } : { message: outcome.message }) }, blanked)}\n`);
      }
      history.push({ role: "tool", callId: call.id, name: call.name, result: capped(outcome.ok ? outcome.body : { ok: false, message: outcome.message }) });
    }
  }
  if (reply === null) {
    stoppedAtCap = true;
    const last = lastText.trim() === "" || unbacked(lastText) === null ? lastText.trim() : dropDeliverableClaims(lastText);
    reply = `${last === "" ? "" : `${last}\n\n`}(I stopped here: this answer needed more steps than ${maxSteps < MATE_MAX_STEPS ? "this conversation's remaining spending allows" : "one reply allows"}. Ask me to carry on.)`;
  }
  // Ruling 11: model text is scanned before it becomes durable.
  if (scanForSecrets(reply).length > 0) return fail("secret-refused", MATE_FAILURE_COPY.secretReply, false);

  now = clock();
  const activity = activitySummary(reads, proposals, steps);
  // One write (finding 12): settle, debit, promote the drafts, append the assistant text.
  const finalized = store.finalizeMateTurn(turnId, started.generation, { state: "answered", settledMicrousd: settled, tokensIn, tokensOut, message: { text: reply, activity } }, now);
  if (!finalized) return { ok: false, turn: turnId, failed: "superseded", message: MATE_FAILURE_COPY.stopped, unknownSpend: false };
  return { ok: true, turn: turnId, reply, activity, proposals, steps, stoppedAtCap, settledMicrousd: settled };
}
