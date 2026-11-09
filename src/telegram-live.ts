/**
 * The paired phone's live reply (docs/plans/responsive-chat.md §3.1): a 👀 on the owner's message as soon as it is
 * saved, and while the lead works one Bot API message draft (`sendMessageDraft`, private chats only) that shows the
 * status line and the reply as it is written.
 *
 * Nothing here is durable or authoritative. A draft is Telegram's "temporary 30-second preview": it disappears when the
 * bot sends a message or when it is not refreshed, so a draft that is never replaced is harmless. The answer itself is
 * still the planned, receipted `sendMessage` parts (telegram-lead.ts), sent only after this turn's sender has closed.
 * Drafts carry words only: no keyboard, no card, no token. Every draft that carries more than Telegram's own empty
 * "Thinking…" placeholder is sent only after the caller's full standing check (live pairing, approver, the project
 * ceiling the turn opened under, the turn still running under its generation, the row's claim).
 *
 * Rate: Telegram's own retry_after is shared with every other send (`telegramRetryAt` / `deferTelegram`). While it
 * holds, an ack waits and a draft is dropped (the answer and failure notices go first, acks next, drafts last); a
 * draft that is asked to pause widens this turn's spacing.
 */
import type { LeadProgress } from "./lead-progress.js";
import { createLiveReply, createLiveSender, LIVE_STATUS, type LiveView } from "./live-reply.js";
import { shapedWindow, telegramReply, type ShapeOptions, type TelegramEntity } from "./reply-shape.js";
import type { Store } from "./store.js";
import type { TelegramTransport } from "./telegram.js";

/** The acknowledgement on the owner's message: "seen, working on it". Removed once the answer or the failure notice is
 * delivered; never replaced by a "done" mark (an answer isn't finished work). */
export const ACK_EMOJI = "👀";
/** At most one reaction change per chat this often; a burst waits its turn, in order. */
export const ACK_GAP_MS = 1_000;
/** A reaction change that meets Telegram's pause waits it out when it is this short; a longer pause skips it. */
const ACK_MAX_WAIT_MS = 30_000;
/** Drafts start this far apart and widen (doubling, up to the cap) whenever Telegram asks for a pause. */
export const DRAFT_SPACING_MS = 1_200;
const DRAFT_MAX_SPACING_MS = 10_000;
/** Telegram keeps a draft about 30 seconds: one that has not changed is sent again after this long. */
export const DRAFT_KEEPALIVE_MS = 25_000;
/** Telegram's message limit, counted after entities (UTF-16 units, as JS strings are). */
export const TELEGRAM_TEXT_MAX = 4_096;

/** Test seams for the timings above (production uses the defaults). */
export type TelegramLiveTiming = { ackGapMs?: number; draftSpacingMs?: number; keepAliveMs?: number };

export type DraftEntity = TelegramEntity | { type: "italic"; offset: number; length: number };
export type DraftPayload = { text: string; entities: DraftEntity[] };

/** The body of a writing draft within `budget` characters once rendered: cut at a safe place in the shaped text first
 * (never inside code, a link, a bold anchor or an emoji), rendered, measured, and cut smaller if it still doesn't fit.
 * A body that can't fit (a single link longer than the budget) shows nothing. */
export function draftBody(shaped: string, budget: number): DraftPayload {
  if (budget <= 0) return { text: "", entities: [] };
  let size = budget;
  for (let attempt = 0; attempt < 8 && size >= 1; attempt += 1) {
    const window = shapedWindow(shaped, size);
    const cut = window.length < shaped.length;
    const rendered = telegramReply(cut ? window.trimEnd() : window);
    const text = cut ? `${rendered.text} …` : rendered.text;
    if (text.length <= budget) return { text, entities: rendered.entities };
    size = Math.min(size - 1, Math.floor(size * budget / text.length) - 2);
  }
  return { text: "", entities: [] };
}

/**
 * One live view as a draft: the status line in italics, then (once text exists) the partial reply as text plus
 * entities, never Markdown. Plain "Thinking…" is Telegram's own empty-text placeholder. Closed views send nothing.
 */
export function telegramDraftOf(view: LiveView): DraftPayload | null {
  if (view.phase === "closed") return null;
  if (view.phase === "queued") return { text: LIVE_STATUS.queued, entities: [{ type: "italic", offset: 0, length: LIVE_STATUS.queued.length }] };
  if (view.phase === "working") {
    if (view.status === LIVE_STATUS.thinking) return { text: "", entities: [] };
    return { text: view.status, entities: [{ type: "italic", offset: 0, length: view.status.length }] };
  }
  const head = view.status;
  const gap = "\n\n";
  const body = draftBody(view.text, TELEGRAM_TEXT_MAX - head.length - gap.length);
  if (body.text === "") return { text: head, entities: [{ type: "italic", offset: 0, length: head.length }] };
  const shift = head.length + gap.length;
  return {
    text: `${head}${gap}${body.text}`,
    entities: [{ type: "italic", offset: 0, length: head.length }, ...body.entities.map(one => ({ ...one, offset: one.offset + shift }))],
  };
}

/** sent; paused (Telegram asked for a pause, or one holds); lost (the wire failed: this view is dropped); refused. */
type DraftOutcome = "sent" | "paused" | "lost" | "refused";

/** One draft on the wire, under the shared pause. A retry_after is recorded for every sender of this bot. */
async function sendDraft(store: Store, botId: string, transport: TelegramTransport, clock: () => Date, chatId: string, draftId: number, payload: DraftPayload): Promise<DraftOutcome> {
  if (store.telegramRetryAt(botId) > clock().toISOString()) return "paused";
  let answer: Awaited<ReturnType<TelegramTransport>>;
  try {
    answer = await transport("sendMessageDraft", { chat_id: Number(chatId), draft_id: draftId, text: payload.text, ...(payload.entities.length === 0 ? {} : { entities: payload.entities }) });
  } catch {
    return "lost";
  }
  if (answer.ok) return "sent";
  const retry = answer.parameters?.retry_after;
  if (typeof retry === "number" && Number.isFinite(retry) && retry > 0) {
    store.deferTelegram(botId, new Date(clock().getTime() + Math.ceil(retry) * 1_000).toISOString());
    return "paused";
  }
  return answer.uncertain === true ? "lost" : "refused";
}

// ---- the 👀 acknowledgement ----------------------------------------------------------

/** One lane per chat: reaction changes go out in order (an ack never lands after its own removal), spaced. */
const ackLanes = new Map<string, { tail: Promise<void>; lastAt: number }>();
const pause = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); (timer as { unref?: () => void }).unref?.(); });

/**
 * Put 👀 on the owner's message (`on`) or take it off. Best effort and never awaited by the caller's durable work: a
 * missing pairing, a failure or a long pause skips it silently. `paired` is re-checked at the moment of sending; a
 * reaction carries no project data, so the pairing alone fences it. Resolves once this change was tried.
 */
export function telegramAck(args: {
  store: Store; botId: string; transport: TelegramTransport; clock: () => Date;
  chatId: string; messageId: string; on: boolean; paired: () => boolean; gapMs?: number;
}): Promise<void> {
  const key = `${args.botId}:${args.chatId}`;
  const lane = ackLanes.get(key) ?? { tail: Promise.resolve(), lastAt: Number.NEGATIVE_INFINITY };
  ackLanes.set(key, lane);
  const gap = args.gapMs ?? ACK_GAP_MS;
  // Never throws: a store closed meanwhile (a stop) or anything else skips the change.
  const run = (): Promise<void> => change().catch(() => undefined);
  const change = async (): Promise<void> => {
    const spaced = lane.lastAt + gap - Date.now();
    if (spaced > 0) await pause(spaced);
    const held = Date.parse(args.store.telegramRetryAt(args.botId)) - args.clock().getTime();
    if (Number.isFinite(held) && held > 0) {
      if (held > ACK_MAX_WAIT_MS) return;
      await pause(held);
    }
    if (!args.paired()) return;
    lane.lastAt = Date.now();
    try {
      const answer = await args.transport("setMessageReaction", {
        chat_id: Number(args.chatId), message_id: Number(args.messageId), reaction: args.on ? [{ type: "emoji", emoji: ACK_EMOJI }] : [],
      });
      const retry = answer.ok ? undefined : answer.parameters?.retry_after;
      if (typeof retry === "number" && Number.isFinite(retry) && retry > 0) args.store.deferTelegram(args.botId, new Date(args.clock().getTime() + Math.ceil(retry) * 1_000).toISOString());
    } catch { /* skipped silently */ }
  };
  const done = lane.tail.then(run, run);
  lane.tail = done;
  // A finished lane is forgotten; the next change starts a fresh one (spacing restarts from now).
  void done.then(() => { if (ackLanes.get(key) === lane && lane.tail === done && Date.now() - lane.lastAt >= gap) ackLanes.delete(key); });
  return done;
}

// ---- the draft --------------------------------------------------------------------------

/** Chats (bot:binding) whose turn has a live draft in this process: a waiting message's draft never covers it. */
const liveChats = new Set<string>();
/** When each waiting message last had its "Waiting for your earlier messages…" draft (bot:row). */
const waitingDrafts = new Map<string, number>();

export type TelegramLiveDraft = {
  /** The turn's progress listener (runLeadTurn's `onProgress`). */
  onProgress: (event: LeadProgress) => void;
  /** Stop: nothing more is sent, and the draft in flight has settled when this resolves. Durable delivery comes after. */
  close: () => Promise<void>;
  /** The turn the drafts follow, once it started. */
  readonly turn: number | null;
};

/**
 * One running turn's draft. `standing` is the caller's full proof for a draft that carries words (it may await; the
 * close is re-checked after it); `paired` is enough for Telegram's empty "Thinking…". A draft Telegram refuses outright
 * (not a pause, not a lost answer) turns this turn's drafts off; previews are best effort.
 */
export function createTelegramLiveDraft(args: {
  store: Store; botId: string; transport: TelegramTransport; clock: () => Date;
  chatId: string; binding: number; draftId: number; shape: ShapeOptions;
  standing: (turn: number) => Promise<boolean>; paired: () => boolean; timing?: TelegramLiveTiming;
}): TelegramLiveDraft {
  const reply = createLiveReply(args.shape);
  const keepAlive = args.timing?.keepAliveMs ?? DRAFT_KEEPALIVE_MS;
  const base = args.timing?.draftSpacingMs ?? DRAFT_SPACING_MS;
  const chat = `${args.botId}:${args.binding}`;
  let spacing = base;
  let lastSentAt = Date.now();
  let off = false;
  liveChats.add(chat);
  /** What the draft shows now: a preview closed as a possible password or key keeps only the status line. */
  const current = (): LiveView | null => {
    const view = reply.view();
    if (view.phase !== "closed") return view;
    return view.why === "blocked" ? { phase: "working", status: LIVE_STATUS.held } : null;
  };
  const sender = createLiveSender<LiveView>({
    spacingMs: () => spacing,
    send: async view => {
      if (off) return;
      const payload = telegramDraftOf(view);
      const turn = reply.turn;
      if (payload === null || turn === null) return;
      const allowed = payload.text === "" ? args.paired() : await args.standing(turn);
      if (!allowed || sender.closed) return;
      const outcome = await sendDraft(args.store, args.botId, args.transport, args.clock, args.chatId, args.draftId, payload);
      if (outcome === "sent") lastSentAt = Date.now();
      else if (outcome === "paused") spacing = Math.min(DRAFT_MAX_SPACING_MS, spacing * 2);
      else if (outcome === "refused") off = true;
    },
  });
  const timer = setInterval(() => {
    if (sender.closed || Date.now() - lastSentAt < keepAlive) return;
    const view = current();
    if (view !== null) sender.offer(view);
  }, Math.max(50, Math.min(keepAlive, 5_000)));
  (timer as { unref?: () => void }).unref?.();
  return {
    get turn() { return reply.turn; },
    onProgress: event => {
      // The first event names the turn: Telegram's "Thinking…" shows at once, even before the view changes.
      const first = reply.turn === null;
      if (!reply.push(event) && !first) return;
      const view = current();
      if (view !== null) sender.offer(view);
    },
    close: async () => {
      clearInterval(timer);
      liveChats.delete(chat);
      await sender.close();
    },
  };
}

/**
 * A message waiting for the lead (busy, or behind the owner's earlier messages): "Waiting for your earlier messages…"
 * as a draft, refreshed only after the keep-alive interval, and never while this chat's running turn has its own
 * draft. Carries no project data: the pairing and the claim fence it.
 */
export async function telegramWaitingDraft(args: {
  store: Store; botId: string; transport: TelegramTransport; clock: () => Date;
  chatId: string; binding: number; draftId: number; allowed: () => boolean; timing?: TelegramLiveTiming;
}): Promise<void> {
  const key = `${args.botId}:${args.draftId}`;
  if (liveChats.has(`${args.botId}:${args.binding}`)) return;
  const last = waitingDrafts.get(key);
  if (last !== undefined && Date.now() - last < (args.timing?.keepAliveMs ?? DRAFT_KEEPALIVE_MS)) return;
  if (!args.allowed()) return;
  const payload = telegramDraftOf({ phase: "queued" })!;
  if (await sendDraft(args.store, args.botId, args.transport, args.clock, args.chatId, args.draftId, payload) !== "sent") return;
  waitingDrafts.set(key, Date.now());
  // Bounded: the oldest entries go first.
  while (waitingDrafts.size > 500) waitingDrafts.delete(waitingDrafts.keys().next().value!);
}

/** The message is answered or failed: its waiting draft is forgotten. */
export function forgetWaitingDraft(botId: string, draftId: number): void {
  waitingDrafts.delete(`${botId}:${draftId}`);
}
