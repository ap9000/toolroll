import { CHAT_ACTIONS, sharedActionAllowsChallenge, sharedActionPayload } from "./chat-actions.js";
import { taskInCeiling, mirrorToTaskChat, couldNotAnswerText, channelRepos as telegramConversationRepos, resolveChannelMate as resolveTelegramMate, tooLongText, whichTaskText, replyContextFor, NO_PHONE_LINK, NO_TASK_LINK, proposalLink, confirmedLink, proposalPreview, proposalOutcomeText, handoffCardText, confirmedCardText, type PhoneLink } from "./chat-channel.js";
export { channelRepos as telegramConversationRepos, resolveChannelMate as resolveTelegramMate, tooLongText, whichTaskText, replyContextFor, NO_PHONE_LINK, NO_TASK_LINK, proposalLink, confirmedLink, proposalPreview, proposalOutcomeText, handoffCardText, confirmedCardText, CHAT_ACTION_PARITY as TELEGRAM_ACTION_PARITY, parityGaps, type PhoneLink, type ResolvedMate, type ParitySupport } from "./chat-channel.js";
/**
 * The paired phone as one more way to use the same assistant.
 *
 * Transport only. An ordinary private Telegram message becomes a mate turn
 * through `runMateTurn` — the same saved thread, proposal rows, confirm
 * doors and result actions the console and `toolroll chat` use —
 * and every act is still a card the operator confirms. This module owns
 * what is specific to the wire: proving the pairing (chat AND immutable
 * sender AND approver generation AND the enrolled ceiling) before any
 * model call and again after every wait; the durable inbound row that
 * precedes polling acknowledgement; the request identity the engine
 * receipts a turn under so a replay or a restart never dispatches the
 * provider twice; concise previews with opaque one-tap tokens; and the
 * honest words for what a phone cannot do (a password, a cancel, a
 * console-only control).
 *
 * Nothing here mints authority: the principal comes from
 * `verifyApproverStanding` against the live binding row, the session is
 * the approver's own compatible one (or one minted under the same terms
 * the console and CLI state), and the door re-proves everything again.
 */
import { createHash, randomBytes } from "node:crypto";
import { MATE_MESSAGE_MAX_CHARS, mateFailureText, runMateTurn, type MateChannelProblem } from "./mate.js";
import { confirmMateProposal, dismissMateProposal, type DoorOptions, type DoorOutcome } from "./mate-doors.js";
import { ceilingDigestOf, verifyApproverStanding } from "./principal.js";
import { MATE_ASK_OTHER, type MateAsk, type MateProposal, type Store, type TelegramBinding, type TelegramConversation } from "./store.js";
import type { SubscriptionMateRunner } from "./subscription-chat.js";
import { phoneText } from "./telegram-status.js";
import { shapeReplyParts, telegramReply } from "./reply-shape.js";
import { WARM_EMOJI, warmTurn } from "./chat-warmth.js";
import { TeamLeads } from "./team-leads.js";
import { chatResultHref } from "./chat-controls.js";
import { resultImageFileName, safeResultImageCaption, verifyResultImage } from "./chat-evidence.js";
import type { TelegramTransport, TelegramUpload } from "./telegram.js";
import { telegramButton, type TelegramCallbackButton, type TelegramUpdate } from "./contracts/telegram-callback.js";

/** How long one claimed turn may go without a heartbeat before another poller may take it over. */
export const CONVERSATION_CLAIM_MS = 2 * 60_000;
/** A busy engine (one turn at a time) defers a queued message this long, up to the age bound below. */
export const CONVERSATION_RETRY_MS = 5_000;
export const CONVERSATION_MAX_AGE_MS = 10 * 60_000;
/** A card's buttons and an armed irreversible challenge live this long. */
export const CARD_TTL_MS = 24 * 3_600_000;
export const CHALLENGE_TTL_MS = 10 * 60_000;
/** Telegram's own message ceiling, with room for our part headers (the same bound telegram.ts splits at). */
export const PART_CAP = 3_900;

export type TelegramConversationOptions = {
  /** Where evidence lives — the same root the console and CLI read results from. */
  evidenceRoot: string;
  /** Injected by tests; production invokes the isolated local harness. */
  subscriptionRunner?: SubscriptionMateRunner;
  /** The held-session supervisor in this process, when there is one (a stop fences through it). */
  held?: DoorOptions["held"];
  /**
   * The https origin a phone link may open, read again on EVERY call (a
   * card is linked immediately before it is sent or edited, never from a
   * stored URL), or null when no trusted origin is configured. Production
   * wires `phoneOrigin` from webhooks.ts; absent, no card carries a link.
   */
  phoneOrigin?: () => string | null;
  /** Injected by tests: how a Merge tapped in chat reaches GitHub (production: mergePullRequest). */
  merge?: (input: { runId: number; by: string }) => Promise<{ ok: true } | { ok: false; message: string }>;
};

/** One Bot API call, the shape telegram.ts injects. */
export type Transport = TelegramTransport;

// ---- the ceiling and the principal --------------------------------------------

/**
 * The phone's project ceiling: the enrolled registry, canonicalized and
 * deduplicated IN ORDER exactly as the console's managed list is, then
 * narrowed to what this approver's account may access. Order matters —
 * `r1..rN` is an index and the ceiling digest hashes the order — so a
 * console session over the same enrollment shares its digest here.
 */
/** The engine's request identity for one inbound message: exact bot, binding and update, never text. */
export function telegramRequestId(botId: string, bindingId: number, updateId: number): string {
  return createHash("sha256").update(`telegram:${botId}:${bindingId}:${updateId}`).digest("hex").slice(0, 32);
}

/** The one channel problem that is transient: the registry could not be read now. Retried, never a refusal. */
export const UNREADABLE_REGISTRY = "current project access could not be read";

/**
 * Is the channel still what a turn opened under? The live binding must be
 * the SAME row and generation, its approver still an approver, and the
 * enrolled ceiling (reloaded now) still the exact list the principal
 * holds — or, for a reply recovered after a restart, the ceiling digest
 * its session was minted under. A string names what changed; null means
 * nothing did.
 */
export async function telegramChannelProblem(
  store: Store,
  expected: { botId: string; bindingId: number; approverGeneration: number } & ({ repos: readonly string[] } | { ceilingDigest: string }),
  readProjects: () => Promise<readonly string[]>,
): Promise<string | null> {
  let registry: readonly string[];
  try {
    registry = await readProjects();
  } catch {
    return UNREADABLE_REGISTRY;
  }
  const binding = store.liveTelegramBindingById(expected.bindingId);
  if (binding === null || binding.botId !== expected.botId || binding.approverGeneration !== expected.approverGeneration) return "this chat is no longer paired";
  if (store.accountOf(binding.approver)?.role !== "approver") return "the paired account is no longer an approver";
  const repos = telegramConversationRepos(store, binding.approver, registry);
  const same = "repos" in expected
    ? repos.length === expected.repos.length && repos.every((one, index) => one === expected.repos[index])
    : ceilingDigestOf(repos) === expected.ceilingDigest;
  if (!same) return "the connected projects changed";
  return null;
}

// ---- words ---------------------------------------------------------------------

export function phoneLinkButton(origin: string | null, link: PhoneLink | null): InlineButton[] | null {
  if (origin === null || link === null) return null;
  return [{ text: link.label, url: `${origin}${link.path}` }];
}

/** Why a card that wanted a link carries none — null when it carries one. */
function linkNote(origin: string | null, link: PhoneLink | null): string | null {
  if (origin === null) return NO_PHONE_LINK;
  return link === null ? NO_TASK_LINK : null;
}

/** The keyboard as sent: the persisted callback rows, then the link row minted now. */
function keyboardWith(callbacks: CallbackKeyboard | null, link: InlineButton[] | null): Keyboard | undefined {
  const rows: Keyboard = [...(callbacks ?? []), ...(link === null ? [] : [link])];
  return rows.length === 0 ? undefined : rows;
}

// ---- proposal cards on the wire ------------------------------------------------------

/** One inline button: an opaque callback token (a real in-chat act) or a url (navigation, never authority). */
/** The buttons under the lead's question: options two to a row, then "Something else". Each names the turn and the
 * option's place, nothing more; a tap re-proves that the question is still open and is the tapper's own. */
export function askKeyboard(ask: MateAsk): CallbackKeyboard {
  const rows: CallbackKeyboard = [];
  for (let at = 0; at < ask.options.length; at += 2) rows.push(ask.options.slice(at, at + 2).map((label, offset) => telegramButton(label.slice(0, 60), `ask:${ask.turn}:${at + offset}`)));
  rows.push([telegramButton(MATE_ASK_OTHER, `ask:${ask.turn}:x`)]);
  return rows;
}

export type InlineButton = TelegramCallbackButton | { text: string; url: string };
type Keyboard = InlineButton[][];
/** What a part persists: callback tokens only. A url is minted at send time, never stored. */
type CallbackKeyboard = TelegramCallbackButton[][];

/** Mint the card's tokens before the send, so a tap can never name a token that does not exist. */
export function mintCardTokens(store: Store, binding: TelegramBinding, proposal: number, now: Date, messageId?: string, chatId = binding.chatId): { keyboard: CallbackKeyboard; tokens: string[] } {
  const confirm = randomBytes(16).toString("hex");
  const dismiss = randomBytes(16).toString("hex");
  for (const [token, phase] of [[confirm, "confirm"], [dismiss, "dismiss"]] as const) {
    store.createTelegramProposalAction({ token, binding: binding.id, proposal, phase, chatId, ttlMs: CARD_TTL_MS, ...(messageId === undefined ? {} : { messageId }) }, now);
  }
  return { keyboard: [[telegramButton("Confirm", confirm), telegramButton("Dismiss", dismiss)]], tokens: [confirm, dismiss] };
}

export type CardEffect =
  | { kind: "ack"; text: string }
  | { kind: "edit"; text: string; keyboard?: Keyboard }
  | { kind: "signal"; run: () => void };

/**
 * One tap on a proposal card, applied inside the update's own transaction
 * by the bridge (which already proved the live binding, the exact sender
 * and the exact chat). Returns what to tell Telegram afterwards. The
 * principal is minted from the binding row against the CURRENT enrolled
 * ceiling; the door re-proves standing, ceiling, session and the
 * proposal's own terms again inside its transaction.
 */
export function applyProposalTap(
  store: Store,
  binding: TelegramBinding,
  token: string,
  message: NonNullable<NonNullable<TelegramUpdate["callback_query"]>["message"]>,
  repos: readonly string[] | null,
  options: TelegramConversationOptions,
  now: Date,
): { effects: CardEffect[]; confirmed: boolean; ignored: boolean } {
  const effects: CardEffect[] = [];
  const ack = (text: string): void => { effects.push({ kind: "ack", text }); };
  const edit = (text: string, keyboard?: Keyboard): void => { effects.push({ kind: "edit", text, ...(keyboard === undefined ? {} : { keyboard }) }); };
  const action = store.getTelegramProposalAction(token);
  // The tap must land where the card was placed. In a paired private chat
  // that is the tapper's own binding; in a group that follows a team
  // conversation any paired member may tap, and the door then proves that
  // person's own membership and consent.
  const tapChatId = message.chat === undefined ? binding.chatId : String(message.chat.id);
  const selected = store.telegramTeamChat(binding.botId, tapChatId);
  const groupCard = tapChatId !== binding.chatId && selected?.kind === "group";
  if (action === null || action.chatId !== tapChatId ||
    (tapChatId !== binding.chatId && !groupCard) ||
    (action.binding !== binding.id && (!groupCard || action.phase === "yes" || action.phase === "cancel")) ||
    (action.messageId !== null && action.messageId !== String(message.message_id))) {
    ack("that button is stale — send /status to see what still waits");
    return { effects, confirmed: false, ignored: true };
  }
  const proposal = store.getMateProposal(action.proposal);
  if (proposal === null) {
    store.consumeTelegramProposalAction(token, now);
    ack("that card no longer exists");
    edit("This card no longer exists.");
    return { effects, confirmed: false, ignored: true };
  }
  // A card belongs to the selected conversation, not merely the same
  // Telegram group. Check the tapper before rendering even an outcome or a
  // challenge: a paired outsider must learn none of the proposal's details.
  let actionRepos = repos;
  const shared = store.handle.prepare("SELECT id FROM team_conversation WHERE thread = ?").get(proposal.thread);
  if (groupCard || shared !== undefined) {
    let allowed = false;
    if (repos !== null && selected !== null && shared !== undefined && String(shared["id"]) === selected.conversation) {
      try {
        const domain = new TeamLeads(store, () => repos);
        const member = domain.access({ name: binding.approver, generation: binding.approverGeneration }, selected.conversation, "contributor");
        actionRepos = member.conversation.projects;
        const grant = store.liveTelegramBindingById(selected.binding);
        if (grant !== null && grant.botId === binding.botId && grant.approver === selected.boundBy) {
          const audience = domain.access({ name: grant.approver, generation: grant.approverGeneration }, selected.conversation, groupCard ? "manager" : "viewer");
          allowed = groupCard ? audience.conversation.visibility === "team" : grant.id === binding.id;
        }
      } catch { /* Refuse without disclosing a proposal outside current access. */ }
    }
    if (!allowed) {
      ack("that button is no longer available in this conversation");
      return { effects, confirmed: false, ignored: true };
    }
  }
  if (proposal.state !== "pending") {
    // Already acted on — here, on the console, or from the terminal. The
    // card shows the recorded outcome; nothing runs twice.
    store.consumeTelegramProposalActions(proposal.id, now);
    ack(proposal.state === "confirmed" ? "already done" : proposal.state === "dismissed" ? "already dismissed" : "already acted on");
    edit(proposalOutcomeText(proposal));
    return { effects, confirmed: false, ignored: true };
  }
  if (actionRepos === null) {
    // The registry could not be read: the token stays live for a retry.
    ack("project access could not be read — tap again in a moment");
    return { effects, confirmed: false, ignored: true };
  }
  const verified = verifyApproverStanding(store, binding.approver, binding.approverGeneration, actionRepos);
  if (!verified.ok) {
    ack("this chat no longer answers as an approver");
    return { effects, confirmed: false, ignored: true };
  }
  const who = verified.who;
  const preview = proposalPreview(store, proposal, actionRepos, "telegram");
  const origin = options.phoneOrigin?.() ?? null;

  if (action.phase === "dismiss") {
    if (!store.consumeTelegramProposalAction(token, now)) { ack("that button was already used"); return { effects, confirmed: false, ignored: true }; }
    const done = dismissMateProposal(store, who, proposal.id, now);
    store.consumeTelegramProposalActions(proposal.id, now);
    ack(done ? "dismissed" : "that proposal was already acted on");
    edit(done ? "Dismissed." : proposalOutcomeText(store.getMateProposal(proposal.id) ?? proposal));
    return { effects, confirmed: false, ignored: !done };
  }
  if (action.phase === "cancel") {
    // Cancel means cancelled: the armed yes dies with it and the card is restored.
    store.consumeTelegramProposalAction(token, now);
    store.consumeTelegramProposalActions(proposal.id, now, ["yes", "cancel"]);
    const fresh = mintCardTokens(store, binding, proposal.id, now, String(message.message_id), tapChatId);
    ack("cancelled");
    edit(preview.text, fresh.keyboard);
    return { effects, confirmed: false, ignored: false };
  }
  if (!preview.buttons) {
    // A forged keyboard on a handoff card: nothing acts; the card is
    // repainted with its current link (or the honest absence of one).
    store.consumeTelegramProposalActions(proposal.id, now);
    const wanted = proposalLink(store, proposal, actionRepos, "telegram");
    const link = phoneLinkButton(origin, wanted);
    ack(link === null ? "this step finishes on the computer" : "open the button below to finish this step");
    edit(handoffCardText(preview.text, linkNote(origin, wanted)), keyboardWith(null, link));
    return { effects, confirmed: false, ignored: true };
  }
  const irreversible = proposal.kind === "answer" && proposal.payload["reversible"] === false;
  const sharedAction = proposal.kind === "action" ? sharedActionPayload(proposal.payload) : null;
  const challenged = sharedAction !== null && sharedActionAllowsChallenge(sharedAction);
  // The arm: two fresh one-time tokens make a real challenge, exactly as a
  // decision button does. Nothing is answered or recorded here.
  const arm = (): void => {
    store.consumeTelegramProposalActions(proposal.id, now, ["yes", "cancel"]);
    const yes = randomBytes(16).toString("hex");
    const cancel = randomBytes(16).toString("hex");
    const placedOn = String(message.message_id);
    store.createTelegramProposalAction({ token: yes, binding: binding.id, proposal: proposal.id, phase: "yes", chatId: tapChatId, messageId: placedOn, ttlMs: CHALLENGE_TTL_MS }, now);
    store.createTelegramProposalAction({ token: cancel, binding: binding.id, proposal: proposal.id, phase: "cancel", chatId: tapChatId, messageId: placedOn, ttlMs: CHALLENGE_TTL_MS }, now);
    const body = preview.text.split("\n\nConfirm or Dismiss below")[0];
    if (challenged) {
      ack("confirm it");
      edit(`${body}\n\nThis records that you handled this exact result. Confirm?`, [
        [telegramButton(`✓ Yes, ${CHAT_ACTIONS[sharedAction!.operation].label.toLowerCase()}`, yes)],
        [telegramButton("Cancel", cancel)],
      ]);
      return;
    }
    ack("irreversible — confirm it");
    edit(`${body}\n\n⚠ Last step: this answer can't be undone. Confirm?`, [
      [telegramButton("⚠ Yes, answer it", yes)],
      [telegramButton("Cancel", cancel)],
    ]);
  };
  if (action.phase === "confirm" && (irreversible || challenged)) {
    if (!store.consumeTelegramProposalAction(token, now)) { ack("that button was already used"); return { effects, confirmed: false, ignored: true }; }
    arm();
    return { effects, confirmed: false, ignored: false };
  }
  if (!store.consumeTelegramProposalAction(token, now)) {
    ack(action.phase === "yes" ? "that confirmation expired — start again from Confirm" : "that button was already used");
    return { effects, confirmed: false, ignored: true };
  }
  const outcome = confirmMateProposal(store, who, proposal.id, now, {
    via: "telegram",
    evidenceRoot: options.evidenceRoot,
    confirm: action.phase === "yes",
    ...(options.held === undefined ? {} : { held: options.held }),
    deferSignal: signal => effects.push({ kind: "signal", run: signal }),
  });
  if (!outcome.ok && outcome.reason === "needs-confirm") {
    // Not armed yet (a card drafted without the reversible mark): arm now, the tap is not lost.
    arm();
    return { effects, confirmed: false, ignored: false };
  }
  store.consumeTelegramProposalActions(proposal.id, now);
  ack(outcome.ok ? "✓ done" : "not done");
  const wanted = confirmedLink(store, outcome, proposal, actionRepos);
  const link = phoneLinkButton(origin, wanted);
  edit(confirmedCardText(store, outcome, proposal, linkNote(origin, wanted)), keyboardWith(null, link));
  return { effects, confirmed: outcome.ok, ignored: false };
}

/** A handoff card as sent or repainted: its persisted words, plus the one line saying why no link rides it. */
// ---- the queued turn ---------------------------------------------------------------

export type ConversationReport = { answered: number; refused: number; problems: string[] };

/** A part's next attempt after a failed send: bounded backoff by attempt, or Telegram's own retry_after when it named a longer one. */
export const PART_RETRY_MS = [5_000, 15_000, 60_000, 300_000] as const;
/** Unsent parts are retried this long after the message arrived (the card's own lifetime); then the row fails, explicitly unsent. */
export const DELIVERY_MAX_AGE_MS = CARD_TTL_MS;

export function splitParts(text: string): string[] {
  if (text.length <= PART_CAP) return [text];
  const parts: string[] = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + PART_CAP, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts;
}

/**
 * Run every claimable queued message for this bot, one at a time, each
 * outside any SQLite transaction. The caller holds the poll lease and
 * renews it; the row's own claim is renewed here. Bounded per call so a
 * flood cannot pin one pass forever.
 *
 * `only` splits the work for the follower: "turns" runs the model and
 * persists the reply but leaves the sending to the bridge's own cycle,
 * which calls back with "replies" — so a reply goes out from the same
 * place, in the same order and over the same connection as notifications,
 * never beside a long poll. Absent, a row is answered and sent in one go.
 */
export async function processTelegramConversations(args: {
  store: Store;
  botId: string;
  transport: Transport;
  owner: string;
  clock: () => Date;
  readProjects: () => Promise<readonly string[]>;
  options: TelegramConversationOptions;
  report: ConversationReport;
  signal?: AbortSignal;
  limit?: number;
  only?: "turns" | "replies";
}): Promise<void> {
  const limit = args.limit ?? 20;
  for (let count = 0; count < limit && args.signal?.aborted !== true; count++) {
    const row = args.store.claimTelegramConversation(args.botId, args.owner, CONVERSATION_CLAIM_MS, args.clock(), args.only);
    if (row === null) return;
    try {
      await runTelegramConversation(row, args);
    } catch (error) {
      // The claim lapses on its own; the receipt and the persisted parts make the retry safe.
      args.report.problems.push(`telegram chat for update ${row.updateId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
}

class PlanRefused extends Error {}

type TurnArgs = { store: Store; botId: string; transport: Transport; owner: string; clock: () => Date; readProjects: () => Promise<readonly string[]>; options: TelegramConversationOptions; report: ConversationReport; only?: "turns" | "replies" };

/** The outcome a planned reply waits under until the bridge's cycle sends it. */
const ANSWERED_SENDING = "answered:sending";

/**
 * One claimed message, in order of what is already known about it:
 *
 * 1. Unsent parts exist — the turn already answered; send what remains.
 *    No registry resolution beyond the fence, no model, no proposal.
 * 2. A session was bound before a dispatch — read the engine's receipt
 *    THERE. A receipt names the original turn: recover its outcome, even
 *    if that session has since been ended and replaced from the console.
 * 3. Otherwise resolve the session and thread, bind the session to the
 *    row BEFORE dispatching, run the turn, persist its reply and cards
 *    as parts in one transaction, then send them.
 *
 * Every outgoing part is fenced on the row's claim, the live pairing and
 * the ceiling the turn opened under; only a confirmed message id counts.
 */
async function runTelegramConversation(row: TelegramConversation, args: TurnArgs): Promise<void> {
  const { store, botId, transport, owner, clock, readProjects, options, report, only } = args;
  const finish = (result: Parameters<Store["finishTelegramConversation"]>[2]): boolean => store.finishTelegramConversation(row.id, owner, result, clock());
  const held = (): boolean => store.renewTelegramConversation(row.id, owner, CONVERSATION_CLAIM_MS, clock());
  const ageMs = clock().getTime() - Date.parse(row.createdAt);
  const requeue = async (outcome: string): Promise<void> => {
    if (ageMs > CONVERSATION_MAX_AGE_MS) {
      await notify(couldNotAnswerText(outcome === "registry-unavailable" ? "your projects couldn't be read" : "the assistant stayed busy with another message"));
      finish({ state: "failed", outcome: `${outcome}:gave-up` });
      report.refused++;
      return;
    }
    finish({ state: "queued", outcome, nextAttemptAt: new Date(clock().getTime() + CONVERSATION_RETRY_MS).toISOString() });
  };

  // 1. The exact binding the message arrived under must still be the live one.
  const binding = store.liveTelegramBindingById(row.binding);
  if (binding === null || binding.botId !== botId || binding.approverGeneration !== row.approverGeneration || store.accountOf(binding.approver)?.role !== "approver") {
    finish({ state: "failed", outcome: "unpaired" });
    report.refused++;
    return;
  }
  const chatId = binding.chatId;
  const pairingProblem = (): string | null => {
    const live = store.liveTelegramBindingById(binding.id);
    if (live === null || live.approverGeneration !== binding.approverGeneration) return "this chat is no longer paired";
    if (store.accountOf(live.approver)?.role !== "approver") return "the paired account is no longer an approver";
    return null;
  };
  /** A notice that carries no project data — "this changed, nothing happened" — sent once, best effort, under the pairing fence alone. */
  const notify = async (text: string, keyboard?: Keyboard): Promise<void> => {
    if (pairingProblem() !== null || !held()) return;
    try {
      const answer = await transport("sendMessage", {
        chat_id: chatId, text, link_preview_options: { is_disabled: true }, reply_parameters: { message_id: Number(row.messageId) },
        ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }),
      });
      if (!answer.ok) report.problems.push(`telegram chat notice for update ${row.updateId} could not be sent: ${answer.description ?? "sendMessage failed"}`);
    } catch {
      report.problems.push(`telegram chat notice for update ${row.updateId} could not be sent: Telegram transport failed`);
    }
  };

  /** The outbound half: send every pending part in order, each fenced; done only when every part is sent or moot. */
  const deliver = async (outcomeWord: string): Promise<void> => {
    // The row as it is NOW: the session was bound after this claim read it.
    const bound = store.getTelegramConversation(row.id)?.session ?? null;
    const session = bound === null ? null : store.getMateSession(bound);
    if (session === null) {
      await notify("This conversation was restarted before my reply went out, so it wasn't sent. Nothing was changed. Send your message again.");
      finish({ state: "failed", outcome: "unsent:no-session" });
      report.refused++;
      return;
    }
    const defer = (until: Date, why: string): void => {
      report.problems.push(`telegram chat reply for update ${row.updateId} is waiting to be sent: ${why}`);
      finish({ state: "queued", outcome: "delivering", nextAttemptAt: until.toISOString() });
    };
    for (const part of store.listTelegramConversationParts(row.id)) {
      if (part.state !== "pending") continue;
      const now = clock();
      if (part.kind === "card") {
        const proposal = part.proposal === null ? null : store.getMateProposal(part.proposal);
        if (proposal === null || proposal.state !== "pending") {
          // Confirmed or dismissed from the console or the terminal before the card went out: moot, not lost.
          if (!store.dropTelegramConversationPart(row.id, part.ordinal, owner, proposal === null ? "the proposal is gone" : `the proposal was already ${proposal.state}`, now)) return;
          continue;
        }
      }
      if (now.getTime() - Date.parse(row.createdAt) > DELIVERY_MAX_AGE_MS) {
        report.problems.push(`telegram chat reply for update ${row.updateId} was not sent within a day: ${part.lastError ?? "unsent"}`);
        await notify(couldNotAnswerText("my reply couldn't be sent for a day"));
        finish({ state: "failed", outcome: `unsent:gave-up:${part.lastError ?? "unsent"}` });
        report.refused++;
        return;
      }
      // Telegram's own retry_after, shared with the outbox: nothing goes out while it holds.
      const limitedUntil = store.telegramRetryAt(botId);
      if (limitedUntil > now.toISOString()) { defer(new Date(limitedUntil), "Telegram asked for a pause"); return; }
      // The channel the reply was composed under, re-proved after ONE registry read; then the claim.
      let registry: readonly string[] | null = null;
      try { registry = await readProjects(); } catch { registry = null; }
      const read = registry;
      const problem = read === null ? UNREADABLE_REGISTRY : await telegramChannelProblem(store, { botId, bindingId: binding.id, approverGeneration: binding.approverGeneration, ceilingDigest: session.ceilingDigest }, async () => read);
      if (problem === UNREADABLE_REGISTRY) { defer(new Date(clock().getTime() + PART_RETRY_MS[0]), problem); return; }
      if (problem !== null) {
        report.problems.push(`telegram chat reply for update ${row.updateId} was not sent: ${problem}`);
        await notify(`${problem.charAt(0).toUpperCase()}${problem.slice(1)}, so the assistant's reply was not sent. Nothing was changed. Send your message again if you still want it.`);
        finish({ state: "failed", outcome: `unsent:${problem}` });
        report.refused++;
        return;
      }
      if (!held()) return;
      const repos = telegramConversationRepos(store, binding.approver, read ?? []);
      const backoff = new Date(clock().getTime() + PART_RETRY_MS[Math.min(part.attempts, PART_RETRY_MS.length - 1)]!);
      let send: () => ReturnType<Transport>;
      let method: "sendMessage" | "sendDocument";
      /** What Telegram's confirmed message id makes of the part: sent (the reply, a card, an image), or dropped (an image whose refusal notice is now confirmed). */
      let confirm: (messageId: string) => boolean = messageId => store.settleTelegramConversationPart(row.id, part.ordinal, owner, { ok: true, messageId }, clock());
      if (part.kind === "image") {
        // The image, re-proved NOW — after the registry await, under the
        // held claim, immediately before the upload, on every attempt: the
        // task still in this phone's projects, the run still its own, the
        // artifact row still the one planned from, the bytes read again and
        // still a bounded PNG/JPEG. Anything less is refused in plain words
        // and never sent; the exact result is one button away when a
        // trusted origin can carry it. The original bytes travel untouched.
        const image = part.taskId === null || part.run === null || part.artifact === null || part.sha256 === null
          ? { ok: false as const, problem: "the saved file's record changed" }
          : verifyResultImage(store, options.evidenceRoot, repos, { taskId: part.taskId, run: part.run, artifact: part.artifact, sha256: part.sha256 });
        // The caption as persisted, checked again on every attempt: a row
        // that carries a credential-shaped task id is rebuilt from its typed
        // identity before a word of it reaches Telegram.
        const caption = safeResultImageCaption(part.text, part.taskId ?? "", part.run ?? 0);
        if (!image.ok) {
          // The refusal is the part's own message now: it rides the same
          // pending row, retry schedule and uncertain count as the upload
          // it replaces, and the part is dropped only once Telegram confirms
          // the notice. A lost or failed notice is retried after a restart
          // like any part; the image is re-verified first each time, so a
          // file repaired meanwhile is sent and one still wrong is refused
          // again. The row is never done while the notice is unconfirmed.
          report.problems.push(`telegram chat image for update ${row.updateId} was not sent: ${image.problem}`);
          const link = part.taskId !== null && part.run !== null && taskInCeiling(store, part.taskId, repos) ? { label: "Open result", path: chatResultHref(part.taskId, part.run) } : null;
          const button = phoneLinkButton(options.phoneOrigin?.() ?? null, link);
          const problem = image.problem;
          method = "sendMessage";
          send = () => transport("sendMessage", {
            chat_id: chatId,
            text: phoneText(`${caption} was not sent: ${problem}. Open the result to view it.`, 1_000),
            link_preview_options: { is_disabled: true },
            reply_parameters: { message_id: Number(row.messageId) },
            ...(button === null ? {} : { reply_markup: { inline_keyboard: [button] } }),
          });
          confirm = () => store.dropTelegramConversationPart(row.id, part.ordinal, owner, problem, clock());
        } else {
          const upload: TelegramUpload = {
            field: "document",
            fileName: resultImageFileName(part.taskId as string, part.run as number, part.artifact as number, image.format),
            contentType: image.format === "png" ? "image/png" : "image/jpeg",
            bytes: image.bytes,
          };
          method = "sendDocument";
          send = () => transport("sendDocument", { chat_id: chatId, caption }, undefined, upload);
        }
      } else {
        // A card's link is minted NOW, from the persisted proposal and the
        // origin configured at this moment: a retry after the setting changed
        // or went away carries the current truth, never a stored URL.
        const proposal = part.kind === "card" && part.proposal !== null ? store.getMateProposal(part.proposal) : null;
        const origin = proposal === null ? null : options.phoneOrigin?.() ?? null;
        const wanted = proposal === null ? null : proposalLink(store, proposal, repos);
        const keyboard = keyboardWith(part.keyboard, phoneLinkButton(origin, wanted));
        // The lead's own words carry their bold anchors and labelled links as entities, never as Markdown characters.
        const voiced = part.kind === "reply" ? telegramReply(part.text) : null;
        const text = proposal !== null && part.keyboard === null ? handoffCardText(part.text, linkNote(origin, wanted)) : voiced?.text ?? part.text;
        method = "sendMessage";
        send = () => transport("sendMessage", {
          chat_id: chatId,
          text,
          ...(voiced === null || voiced.entities.length === 0 ? {} : { entities: voiced.entities }),
          link_preview_options: { is_disabled: true },
          ...(part.replyTo === null ? {} : { reply_parameters: { message_id: Number(part.replyTo) } }),
          ...(keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } }),
        });
      }
      // The first time the answer itself fails to go out, the person hears so once,
      // in plain words; the reply itself keeps being retried and shows as
      // unsent in status and the console after two minutes.
      const firstFailure = part.kind === "reply" && store.listTelegramConversationParts(row.id).every(one => one.attempts <= (one.state === "sent" ? 1 : 0));
      const failed = async (until: Date, error: string, uncertain: boolean): Promise<void> => {
        if (!store.settleTelegramConversationPart(row.id, part.ordinal, owner, { ok: false, error, uncertain, retryAt: until.toISOString() }, clock())) return;
        if (firstFailure) await notify(couldNotAnswerText(uncertain ? "my reply may not have reached Telegram" : "Telegram didn't accept my reply"));
        defer(until, error);
      };
      let answer: Awaited<ReturnType<Transport>>;
      try {
        answer = await send();
      } catch {
        // The answer was lost: Telegram may or may not have the message. Said so, retried, counted.
        await failed(backoff, "Telegram transport failed; delivery may be uncertain", true);
        return;
      }
      if (!answer.ok) {
        const retry = answer.parameters?.retry_after;
        const retryAfter = typeof retry === "number" && Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : null;
        const uncertain = answer.uncertain === true;
        const error = `${answer.description ?? `${method} failed`}${uncertain ? "; delivery may be uncertain" : ""}${retryAfter === null ? "" : ` (retry after ${retryAfter}s)`}`;
        let until = backoff;
        if (retryAfter !== null) {
          const paused = new Date(clock().getTime() + retryAfter * 1_000);
          store.deferTelegram(botId, paused.toISOString());
          if (paused > until) until = paused;
        }
        await failed(until, error, uncertain);
        return;
      }
      const id = (answer.result as { message_id?: number } | undefined)?.message_id;
      if (!Number.isSafeInteger(id) || id! <= 0) {
        await failed(backoff, "Telegram returned no confirmed message identity", true);
        return;
      }
      const messageId = String(id);
      if (!confirm(messageId)) return;
      // Placement names the persisted callback tokens only; a url row is not a token.
      if (part.keyboard !== null) store.placeTelegramProposalActions(part.keyboard.flat().map(one => one.callback_data), messageId);
    }
    if (finish({ state: "done", outcome: outcomeWord })) report.answered++;
  };

  /** The reply, one image per screenshot the ANSWERED turn selected (typed identity only — bytes are read and re-verified at send time), and one card per pending proposal, persisted with the cards' tokens in ONE transaction before any send. */
  const plan = (session: number, turn: number, reply: string, proposals: readonly MateProposal[], repos: readonly string[]): boolean => {
    try {
      return store.transact(() => {
        const now = clock();
        const parts: Parameters<Store["planTelegramConversationParts"]>[3][number][] = shapeReplyParts(reply, PART_CAP, { asked: row.text, appOrigin: options.phoneOrigin?.() ?? null }, shaped => telegramReply(shaped).text.length).map((text, index) => ({ kind: "reply", text, replyTo: index === 0 ? row.messageId : null }));
        // The lead's question to its owner: one tap per option, then "Something else".
        const ask = store.mateAsk(turn);
        if (ask !== null) parts.push({ kind: "reply", text: phoneText(ask.question, 1_000), keyboard: askKeyboard(ask) });
        // Only a turn that answered may have its selection sent: a failed or revoked turn's rows were deleted with its drafts, and the state is read again here.
        const selected = store.getMateTurn(turn)?.state === "answered" ? store.listMateTurnEvidence(turn) : [];
        for (const image of selected) parts.push({ kind: "image", text: image.caption, taskId: image.taskId, run: image.run, artifact: image.artifact, sha256: image.sha256 });
        for (const proposal of proposals) {
          const preview = proposalPreview(store, proposal, repos, "telegram");
          const keyboard = preview.buttons ? mintCardTokens(store, binding, proposal.id, now).keyboard : null;
          parts.push({ kind: "card", text: preview.text, proposal: proposal.id, keyboard });
        }
        // A lapsed claim (or parts already planned by another claimant) keeps nothing minted here.
        if (!store.planTelegramConversationParts(row.id, owner, { session, turn }, parts, now)) throw new PlanRefused();
        return true;
      });
    } catch (error) {
      if (error instanceof PlanRefused) return false;
      throw error;
    }
  };

  /** The recorded turn's outcome — nothing dispatched — from the session it was receipted under. */
  const recover = async (session: number, turnId: number, repos: readonly string[]): Promise<void> => {
    // A turn that died past its deadline is swept to failed first, so a
    // restart reports the truth instead of waiting on a ghost.
    store.sweepStaleMateTurns(clock());
    const turn = store.getMateTurn(turnId);
    if (turn === null) { finish({ state: "failed", outcome: "replayed:missing" }); report.refused++; return; }
    store.bindTelegramConversationTurn(row.id, owner, session, turnId);
    if (turn.state === "queued" || turn.state === "running") { await requeue("replayed:running"); return; }
    if (turn.state !== "answered") {
      await notify(mateFailureText(turn.failureReason));
      finish({ state: "failed", outcome: `replayed:${turn.failureReason ?? "failed"}` });
      report.refused++;
      return;
    }
    const reply = store.listMateMessages(turn.thread, 200).find(one => one.turn === turn.id && one.role === "assistant")?.text ?? "(the reply text is no longer in the thread)";
    const proposals = store.listMateProposals(turn.thread, ["pending"]).filter(one => one.turn === turn.id);
    if (!plan(session, turnId, reply, proposals, repos) && store.listTelegramConversationParts(row.id).length === 0) return;
    await sendOrHandOff("replayed");
  };

  /** Send now, or — for the follower's turn worker — leave it to the bridge's cycle, which sends it next. */
  const sendOrHandOff = async (outcomeWord: string): Promise<void> => {
    if (only !== "turns") { await deliver(outcomeWord); return; }
    finish({ state: "queued", outcome: outcomeWord === "answered" ? ANSWERED_SENDING : "delivering", nextAttemptAt: clock().toISOString() });
  };

  // 2. Parts already planned: the turn answered; only the sending remains.
  if (store.listTelegramConversationParts(row.id).length > 0) { await deliver(row.outcome === ANSWERED_SENDING ? "answered" : "replayed"); return; }

  // 3. The ceiling, reloaded now.
  let registry: readonly string[];
  try {
    registry = await readProjects();
  } catch {
    report.problems.push("telegram chat could not read the current project records");
    await requeue("registry-unavailable");
    return;
  }
  const repos = telegramConversationRepos(store, binding.approver, registry);

  // 4. A session bound before an earlier dispatch: the receipt lives there,
  // whatever session is live today.
  if (row.session !== null) {
    const receipt = store.mateRequestReceipt(row.session, row.request);
    if (receipt !== null) { await recover(row.session, receipt.turn, repos); return; }
  }

  // 5. The session and thread — shared with the console and the CLI.
  const resolved = resolveTelegramMate(store, binding, repos, clock());
  if (!resolved.ok && resolved.reason === "busy") { await requeue("busy"); return; }
  if (!resolved.ok) {
    if (resolved.said !== null) await notify(resolved.said);
    finish({ state: "failed", outcome: `refused:${resolved.reason}` });
    report.refused++;
    return;
  }
  const { who, session, thread, config } = resolved;
  const revalidate = async (): Promise<{ ok: true } | { ok: false; reason: MateChannelProblem }> => {
    const problem = await telegramChannelProblem(store, { botId, bindingId: binding.id, approverGeneration: binding.approverGeneration, repos: who.repos }, readProjects);
    if (problem === null) return { ok: true };
    const reason: MateChannelProblem = problem === UNREADABLE_REGISTRY ? "projects-unreadable"
      : problem === "this chat is no longer paired" ? "unpaired"
        : problem === "the paired account is no longer an approver" ? "not-approver"
          : problem === "the connected projects changed" ? "projects-changed" : "access-changed";
    return { ok: false, reason };
  };
  // Bound BEFORE the dispatch, under the claim: a crash from here on finds
  // the receipt in this session, not in whichever session is live later.
  if (!store.bindTelegramConversationSession(row.id, owner, session.id)) return;

  // 6. The turn. The claim is renewed while the model works; the poll lease
  // is the caller's. The request id is the receipt: a second pass after a
  // crash gets the original turn back, never a second dispatch.
  const heartbeat = setInterval(() => { held(); }, 30_000);
  heartbeat.unref?.();
  // Once the turn reaches a tool step: a 👍 on the owner's message, and "typing…" while the lead works.
  const warm = warmTurn({
    react: () => transport("setMessageReaction", { chat_id: chatId, message_id: Number(row.messageId), reaction: [{ type: "emoji", emoji: WARM_EMOJI }] }),
    typing: () => transport("sendChatAction", { chat_id: chatId, action: "typing" }),
  });
  let outcome: Awaited<ReturnType<typeof runMateTurn>>;
  try {
    outcome = await runMateTurn({
      store, who, session, thread, config, key: null, message: row.text, requestId: row.request,
      ...(row.context === null ? {} : { context: row.context }),
      ...(options.subscriptionRunner === undefined ? {} : { subscriptionRunner: options.subscriptionRunner }),
      clock, evidenceRoot: options.evidenceRoot, revalidate, mediaDelivery: "documents", channel: "telegram", onProgress: warm.onProgress,
    });
  } finally {
    clearInterval(heartbeat);
    warm.stop();
  }
  const receipt = store.mateRequestReceipt(session.id, row.request);
  if (receipt !== null) store.bindTelegramConversationTurn(row.id, owner, session.id, receipt.turn);

  if (!outcome.ok && "refused" in outcome) {
    if (outcome.refused === "concurrent") { await requeue("busy"); return; }
    await notify(phoneText(outcome.message, 1_000));
    finish({ state: "failed", outcome: `refused:${outcome.refused}` });
    report.refused++;
    return;
  }
  if (!outcome.ok) {
    // Truthful: what failed, that nothing was kept, and that a new message
    // is a new turn. A failed turn's drafts are already gone.
    await notify(phoneText(outcome.message, 1_000));
    finish({ state: "failed", outcome: `failed:${outcome.failed}` });
    report.refused++;
    return;
  }
  if (outcome.replayed) { await recover(session.id, outcome.turn, who.repos); return; }
  if (row.taskId !== null) mirrorToTaskChat(store, who, row.taskId, "Telegram", row.text, outcome.reply, clock());

  // 7. The reply and its cards: durable first, then sent.
  const proposals = store.listMateProposals(thread.id, ["pending"]).filter(one => one.turn === outcome.turn);
  if (!plan(session.id, outcome.turn, outcome.reply, proposals, who.repos) && store.listTelegramConversationParts(row.id).length === 0) return;
  await sendOrHandOff("answered");
}
