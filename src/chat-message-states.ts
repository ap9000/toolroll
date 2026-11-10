/**
 * An incoming chat message (a `chat_event` row of kind 'message'): what its states mean, the result words it is
 * settled with, and the one question "which replies have not reached the person yet".
 *
 * States (contracts/chat-tables.ts): queued, running, done, failed, dropped.
 *
 * What `done` means differs by app, and nothing should read more into it than this:
 *  - Telegram: done after every planned part of the reply was sent (or dropped as moot, such as a card whose
 *    proposal was already answered elsewhere). It is written by `ChatMessages.finishMessage`, only by the claim
 *    holder and only from 'running'.
 *  - Slack, Discord and Teams: done as soon as the reply is planned, before any of it is sent. `ChatState.plan`
 *    writes the parts and then `ChatState.finish` marks the row done in the same transaction; the parts go out
 *    later, part by part, through `chat_part`.
 * So `done` means "the message needs no more work from the lead", never "the person has the reply". To ask whether
 * a reply has reached the person, use `unsent()` / `unsentPart()` below, which look at the parts themselves and
 * give the same answer on every app.
 *
 * `failed` is used by Telegram only. `dropped` means the chat was disconnected (or an app gave the event up) while
 * it waited; Telegram rows read a dropped row as failed.
 */
import type { ResolvedLead } from "./chat-channel.js";
import type { LeadFailure, LeadRefusal } from "./lead.js";

/**
 * Every fixed result word a message row can be written with. These are stored in `chat_event.result`, so each one
 * must stay byte-identical: renaming one would change what older rows mean.
 */
export const CHAT_MESSAGE_OUTCOMES = [
  // done: the reply was sent (Telegram)
  "answered", // a fresh turn's reply
  "replayed", // the reply of a turn found again after a restart, or sent on a later pass
  "typed-start", // Toolroll's own reply to a typed yes on a Start card
  // queued: waiting for the lead, with no age bound or the bounds in telegram-lead.ts
  "busy", // the lead is answering something else
  "backlog", // the person's own earlier messages wait first
  "replayed:running", // a turn was already admitted for it and is still working
  "registry-unavailable", // the project records could not be read
  "registry-unavailable:admitted", // the same, but a turn already took the message
  // queued: the reply is planned and only sending remains
  "delivering",
  "answered:sending", // a fresh turn's reply, handed to the bridge's cycle to send
  // failed
  "unpaired", // the chat's pairing changed before the turn
  "unsent:no-session", // the session ended before the reply went out
  "replayed:missing", // the turn its receipt names is gone
  "typed-start:not-counted", // a typed yes whose card's turn is gone
  // dropped: the chat was disconnected while the message waited (chat-core.ts)
  "revoked",
] as const;
export type ChatMessageFixedOutcome = (typeof CHAT_MESSAGE_OUTCOMES)[number];

/** Words a message is queued under while it waits for another attempt (telegram-lead.ts `requeue`). */
export const CHAT_WAIT_OUTCOMES = ["busy", "backlog", "replayed:running", "registry-unavailable", "registry-unavailable:admitted"] as const satisfies readonly ChatMessageFixedOutcome[];
export type ChatWaitOutcome = (typeof CHAT_WAIT_OUTCOMES)[number];

/** Waiting for the lead itself (it is answering, or earlier messages wait first): the two-hour bound applies. */
export const CHAT_LEAD_WAITS = ["busy", "backlog"] as const satisfies readonly ChatWaitOutcome[];
export type ChatLeadWait = (typeof CHAT_LEAD_WAITS)[number];

/** Waiting on a turn that was already admitted: no age bound (the turn's own deadline ends it). */
export const CHAT_ADMITTED_WAITS = ["replayed:running", "registry-unavailable:admitted"] as const satisfies readonly ChatWaitOutcome[];

/** The words a row is marked done with (the reply was sent). */
export type ChatDoneOutcome = "answered" | "replayed" | "typed-start";

type RefusedReason = LeadRefusal | Extract<ResolvedLead, { ok: false }>["reason"];

/**
 * Every result word, including the forms that carry a detail after a prefix or a suffix. Build the detailed forms
 * with `chatOutcome` below, never by joining strings at the call site.
 */
export type ChatMessageOutcome =
  | ChatMessageFixedOutcome
  | `${ChatWaitOutcome}:gave-up`
  | `refused:${RefusedReason}`
  | `failed:${LeadFailure}`
  | `replayed:${string}`
  | `unsent:gave-up:${string}`
  | `unsent:${string}`;

/** Builders for the result words that carry a detail. The stored text is exactly what the old string joins wrote. */
export const chatOutcome = {
  /** A wait that ran past its age bound. */
  gaveUp: <W extends ChatWaitOutcome>(wait: W): `${W}:gave-up` => `${wait}:gave-up`,
  /** The lead refused the turn, or no session could be resolved for it. */
  refused: <R extends RefusedReason>(reason: R): `refused:${R}` => `refused:${reason}`,
  /** The turn ran and failed. */
  failed: <R extends LeadFailure>(reason: R): `failed:${R}` => `failed:${reason}`,
  /** The recovered turn had ended without an answer: its failure reason as the turn row stores it ("failed" when none). */
  replayedFailed: (reason: string | null): `replayed:${string}` => `replayed:${reason ?? "failed"}`,
  /** The reply could not go out: the chat or its projects changed (the problem in words). */
  unsent: (problem: string): `unsent:${string}` => `unsent:${problem}`,
  /** The reply was still unsent a day after it was planned (the last send error, or "unsent"). */
  unsentGaveUp: (error: string | null): `unsent:gave-up:${string}` => `unsent:gave-up:${error ?? "unsent"}`,
} as const;

/** Is this word one of the waits for the lead itself (busy or backlog)? */
export function isLeadWait(outcome: string | null): outcome is ChatLeadWait {
  return (CHAT_LEAD_WAITS as readonly string[]).includes(outcome ?? "");
}

/** Is this word a wait on a turn that was already admitted (no age bound)? */
export function isAdmittedWait(outcome: string | null): boolean {
  return (CHAT_ADMITTED_WAITS as readonly string[]).includes(outcome ?? "");
}

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;
function alias(name: string): string {
  if (!SQL_ALIAS.test(name)) throw new Error(`not a table alias: ${name}`);
  return name;
}

/** SQL: this `chat_part` row (by its alias) has not reached the person: planned and neither sent nor dropped. */
export function unsentPart(part: string): string {
  return `${alias(part)}.state = 'pending'`;
}

/**
 * SQL: the `chat_event` row (by its alias or table name) has a reply part that has not reached the person yet.
 * The one answer to "is anything of this reply unsent?" on every app; wrap it in NOT for "everything reached them
 * or was dropped". `part` names the inner alias when the caller's query already uses the default.
 */
export function unsent(event: string, part = "unsent_part"): string {
  const e = alias(event), p = alias(part);
  return `EXISTS (SELECT 1 FROM chat_part ${p} WHERE ${p}.provider = ${e}.provider AND ${p}.event = ${e}.id AND ${unsentPart(p)})`;
}
