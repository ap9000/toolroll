/**
 * A scripted Bot API for bridge tests: records every call, plays back queued updates, and reads a card back as the
 * phone shows it now (its last send or edit). No network; nothing here is a live Telegram proof.
 */
import type { TelegramTransport } from "../src/telegram.js";

export type ScriptButton = { text: string; callback_data?: string; url?: string };
export type ScriptCall = { method: string; params: Record<string, unknown>; messageId: number | null };

export function scriptedTelegram() {
  const calls: ScriptCall[] = [];
  const updates: unknown[][] = [];
  let next = 100;
  const transport: TelegramTransport = async (method, params) => {
    if (method === "getUpdates") {
      calls.push({ method, params, messageId: null });
      const offset = Number(params["offset"] ?? 0);
      return { ok: true, result: (updates.shift() ?? []).filter(one => Number((one as { update_id: number }).update_id) >= offset) };
    }
    if (method === "sendMessage") {
      const messageId = next++;
      calls.push({ method, params, messageId });
      return { ok: true, result: { message_id: messageId } };
    }
    calls.push({ method, params, messageId: method === "editMessageText" ? Number(params["message_id"]) : null });
    if (method === "editMessageText") return { ok: true, result: { message_id: params["message_id"] } };
    if (method === "sendMediaGroup") return { ok: true, result: [{ message_id: next++ }] };
    return { ok: true, result: true };
  };
  const inChat = (chat: number) => calls.filter(call => String(call.params["chat_id"]) === String(chat));
  const keyboard = (call: ScriptCall | undefined): ScriptButton[][] => (call?.params["reply_markup"] as { inline_keyboard?: ScriptButton[][] } | undefined)?.inline_keyboard ?? [];
  const buttons = (call: ScriptCall | undefined): ScriptButton[] => keyboard(call).flat();
  /** A message as it shows now: its last send or edit. */
  const current = (chat: number, messageId: number) => {
    const last = [...inChat(chat)].reverse().find(call => (call.method === "sendMessage" || call.method === "editMessageText") && call.messageId === messageId);
    if (last === undefined) throw new Error(`no message ${messageId} in ${chat}`);
    const rows = keyboard(last);
    const token = (label: RegExp): string => {
      const found = rows.flat().find(one => label.test(one.text) && one.callback_data !== undefined);
      if (found === undefined) throw new Error(`no ${label} button: ${JSON.stringify(rows)}`);
      return found.callback_data!;
    };
    return { messageId, text: String(last.params["text"]), rows, token, labels: rows.flat().map(one => one.url === undefined ? one.text : `${one.text} ↗`) };
  };
  /** The newest message in a chat carrying a button with this label, as it shows now. */
  const cardWith = (chat: number, label: RegExp) => {
    const sent = [...inChat(chat)].reverse().find(call => call.method === "sendMessage" && buttons(call).some(one => label.test(one.text)));
    if (sent === undefined) throw new Error(`no message in ${chat} with ${label}`);
    return current(chat, sent.messageId!);
  };
  const acks = () => calls.filter(call => call.method === "answerCallbackQuery").map(call => String(call.params["text"] ?? ""));
  const sends = (chat: number) => inChat(chat).filter(call => call.method === "sendMessage");
  return { transport, calls, updates, inChat, current, cardWith, acks, buttons, keyboard, sends };
}
