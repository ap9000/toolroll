/**
 * Telegram (telegram.ts): one schema for an update as Telegram sends it — polled, or pushed to /hooks/telegram and kept
 * in the inbox until applied — and one for the data a Toolroll button carries.
 *
 * The update is Telegram's: only the fields Toolroll reads are described, and any others are ignored. A button's data
 * is Toolroll's: one of the forms it mints, within Telegram's 64 bytes. A tap whose data isn't one of them is
 * answered, after the sender and chat are proved, with the line that says why, and nothing is done.
 */

import { z } from "zod";
import { lengthIn, TEXT_LIMITS } from "../text-limits.js";
import { limited, parseContract, type ContractResult } from "./contract.js";

const chat = z.object({ id: z.int(), type: z.string().optional() });
const sender = z.object({ id: z.int(), username: z.string().optional(), first_name: z.string().optional() });

export const telegramMessageSchema = z.object({
  message_id: z.int(),
  text: z.string().optional(),
  chat: chat.optional(),
  from: sender.optional(),
  reply_to_message: z.object({ message_id: z.int() }).optional(),
  /** Presence of any of these disqualifies a note: only direct, initial, plain text counts as authored-and-confirmed
   * by the paired operator. */
  forward_origin: z.unknown().optional(),
  forward_date: z.unknown().optional(),
  via_bot: z.unknown().optional(),
  sender_chat: z.unknown().optional(),
  caption: z.string().optional(),
});

export const telegramCallbackQuerySchema = z.object({
  id: z.string(),
  /** Read by `readTelegramButtonData`, after the sender and chat are proved. */
  data: z.string().optional(),
  from: z.object({ id: z.int() }).optional(),
  message: z.object({ message_id: z.int(), chat: z.object({ id: z.int() }).optional(), text: z.string().optional(), entities: z.array(z.unknown()).optional() }).optional(),
});

export const telegramUpdateSchema = z.object({
  update_id: z.int().min(1),
  message: telegramMessageSchema.optional(),
  callback_query: telegramCallbackQuerySchema.optional(),
});

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

/** One update, as Telegram sent it (refused by path: `callback_query.message.chat.id: must be a number`). */
export function readTelegramUpdate(input: unknown): ContractResult<TelegramUpdate> {
  return parseContract(telegramUpdateSchema, input);
}

/** An inbox row's saved update: JSON first, then the schema. */
export function parseTelegramUpdate(raw: string): ContractResult<TelegramUpdate> {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, issues: [{ path: "payload", kind: "invalid", line: "payload: not JSON" }] };
  }
  return readTelegramUpdate(body);
}

/**
 * Every form of data a Toolroll button carries: a one-time token (16 random bytes as hex) for a proposal, decision,
 * flow, choice or question button; a decide token (chat-decide.ts); a task from /tasks, or back to the lead; and an
 * option of the lead's question to its owner (by index, or `x` for "Something else").
 */
export const TELEGRAM_BUTTON_DATA = /^(?:[a-f0-9]{32}|d:[a-f0-9]{24}|pick:(?:lead|[1-9][0-9]{0,14})|ask:[1-9][0-9]{0,14}:(?:[0-3]|x))$/;

export const telegramButtonDataSchema = limited("callback_data", "telegramCallbackDataBytes")
  .regex(TELEGRAM_BUTTON_DATA, { error: "not a Toolroll button" });

/** A button that calls back (the other kind opens a link). */
export const telegramCallbackButtonSchema = z.strictObject({ text: z.string(), callback_data: telegramButtonDataSchema });
export type TelegramCallbackButton = z.infer<typeof telegramCallbackButtonSchema>;

/** The byte bound, which counts UTF-8 bytes where the schema counts characters. */
function withinBytes(data: string): ContractResult<string> {
  const limit = TEXT_LIMITS.telegramCallbackDataBytes, bytes = lengthIn(data, "bytes");
  return bytes <= limit ? { ok: true, value: data } : { ok: false, issues: [{ path: "callback_data", kind: "too-long", line: `callback_data: over ${limit} bytes (${bytes})` }] };
}

/** A tapped button's data: one Toolroll mints, or the path-named reason it isn't (`callback_data: required`). */
export function readTelegramButtonData(data: unknown): ContractResult<string> {
  const read = parseContract(z.strictObject({ callback_data: telegramButtonDataSchema }), { callback_data: data });
  return read.ok ? withinBytes(read.value.callback_data) : read;
}

/**
 * A button as Toolroll sends it. Data Telegram would refuse (over 64 bytes) or that a tap could not be read back is a
 * fault in the code that made it, so it throws before anything is sent.
 */
export function telegramButton(text: string, data: string): TelegramCallbackButton {
  const read = parseContract(telegramCallbackButtonSchema, { text, callback_data: data });
  const bytes = read.ok ? withinBytes(read.value.callback_data) : read;
  if (!read.ok || !bytes.ok) throw new Error(`a Telegram button: ${(read.ok ? bytes.ok ? [] : bytes.issues : read.issues).map(issue => issue.line).join("; ")}`);
  return read.value;
}

/** A /tasks pick: the task's ref id, or back to the lead (null); null for anything else. */
export function pickOf(data: string): { ref: number | null } | null {
  if (data === "pick:lead") return { ref: null };
  const ref = /^pick:([1-9][0-9]{0,14})$/.exec(data)?.[1];
  return ref === undefined ? null : { ref: Number(ref) };
}

/** An option of the lead's question to its owner: its turn and index, or `x` for "Something else"; null for anything else. */
export function askOf(data: string): { turn: number; option: number | "x" } | null {
  const tap = /^ask:([1-9][0-9]{0,14}):([0-3]|x)$/.exec(data);
  return tap === null ? null : { turn: Number(tap[1]), option: tap[2] === "x" ? "x" : Number(tap[2]) };
}
