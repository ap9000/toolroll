import { describe, expect, test, vi } from "vitest";
import { LIVE_STATUS } from "./live-reply.js";
import type { Store } from "./store.js";
import type { TelegramTransport } from "./telegram.js";
import { createTelegramLiveDraft, telegramAck, telegramDraftOf, TELEGRAM_TEXT_MAX } from "./telegram-live.js";

/** Just the shared pause the live reply reads and writes. */
function pauseStore(): Store & { until: string } {
  const state = { until: "" };
  return Object.assign(state, {
    telegramRetryAt: () => state.until,
    deferTelegram: (_bot: string, until: string) => { if (until > state.until) state.until = until; },
  }) as unknown as Store & { until: string };
}

const T0 = new Date("2026-11-08T12:00:00.000Z");

/** Entities a client can apply: inside the text, and never starting or ending between an emoji's two halves. */
function entitiesValid(text: string, entities: { offset: number; length: number }[]): boolean {
  const high = (at: number) => /[\uD800-\uDBFF]/.test(text[at] ?? "");
  const low = (at: number) => /[\uDC00-\uDFFF]/.test(text[at] ?? "");
  return entities.every(one => one.offset >= 0 && one.length > 0 && one.offset + one.length <= text.length && !low(one.offset) && !high(one.offset + one.length - 1));
}

describe("Telegram drafts: what a draft may carry", () => {
  test("words only: the status in italics, Telegram's own empty Thinking…, nothing for a closed view", () => {
    expect(telegramDraftOf({ phase: "working", status: LIVE_STATUS.thinking })).toEqual({ text: "", entities: [] });
    expect(telegramDraftOf({ phase: "queued" })).toEqual({ text: LIVE_STATUS.queued, entities: [{ type: "italic", offset: 0, length: LIVE_STATUS.queued.length }] });
    for (const why of ["answered", "failed", "blocked"] as const) expect(telegramDraftOf({ phase: "closed", why })).toBeNull();
    const draft = telegramDraftOf({ phase: "writing", status: "Writing…", text: "See [the task](https://so.example.com/t) **now**" })!;
    expect(Object.keys(draft).sort()).toEqual(["entities", "text"]);
    expect(draft.text).toBe("Writing…\n\nSee the task now");
  });

  // A table of long partials: each is cut before rendering, fits Telegram's limit after entities, and keeps every
  // entity whole and off an emoji's halves.
  const emoji = "😀";
  test.each([
    ["emoji at every boundary", `${"word ".repeat(10)}${emoji.repeat(3000)}`],
    ["bold anchors and links", `**Ready** see https://docs.example.org/a?b=1 ${"x ".repeat(3000)}**tail** ${emoji}`],
    ["emoji right at the limit", `${"a".repeat(4085)}${emoji}${emoji} more words`],
    ["code spans", `\`${"code ".repeat(900)}\` after`],
    ["one long line, no gaps", `${emoji}${"b".repeat(6000)}`],
  ])("a long partial (%s) is cut before entities are built", (_name, text) => {
    const draft = telegramDraftOf({ phase: "writing", status: "Writing…", text })!;
    expect(draft.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expect(entitiesValid(draft.text, draft.entities)).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(draft.text)).toBe(false);
    expect(draft.text.startsWith("Writing…")).toBe(true);
  });
});

describe("Telegram drafts: the sender", () => {
  const started = { kind: "started" as const, turn: 7 };
  const text = (value: string) => ({ kind: "text" as const, turn: 7, step: 1, text: value });

  test("a draft with words waits for the full standing; without it only the empty Thinking… goes", async () => {
    const calls: Record<string, unknown>[] = [];
    const transport: TelegramTransport = async (_method, params) => { calls.push(params); return { ok: true, result: true }; };
    let standing = false;
    const live = createTelegramLiveDraft({ store: pauseStore(), botId: "1", transport, clock: () => T0, chatId: "42", binding: 1, draftId: 9, shape: {}, standing: async () => standing, paired: () => true, timing: { draftSpacingMs: 0 } });
    live.onProgress(started);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    live.onProgress(text("Hello there friend "));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls.map(one => one["text"])).toEqual([""]);
    standing = true;
    live.onProgress(text("Hello there friend again "));
    await vi.waitFor(() => expect(calls.map(one => one["text"])).toEqual(["", "Writing…\n\nHello there friend again"]));
    await live.close();
  });

  test("close waits for the draft in flight, and nothing is sent after it", async () => {
    const methods: string[] = [];
    let release: () => void = () => {};
    const transport: TelegramTransport = async method => {
      methods.push(method);
      if (methods.length === 1) await new Promise<void>(resolve => { release = resolve; });
      return { ok: true, result: true };
    };
    const live = createTelegramLiveDraft({ store: pauseStore(), botId: "1", transport, clock: () => T0, chatId: "42", binding: 1, draftId: 9, shape: {}, standing: async () => true, paired: () => true, timing: { draftSpacingMs: 0 } });
    live.onProgress(started);
    await vi.waitFor(() => expect(methods).toHaveLength(1));
    live.onProgress(text("Late words here "));
    let closed = false;
    const closing = live.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    release();
    await closing;
    live.onProgress(text("Later still words "));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(methods).toEqual(["sendMessageDraft"]);
  });

  test("Telegram's pause on a draft is recorded for every sender, and drafts stop while it holds", async () => {
    const store = pauseStore();
    const sent: string[] = [];
    const transport: TelegramTransport = async (_method, params) => {
      sent.push(String(params["text"]));
      return sent.length === 1 ? { ok: false, description: "Too Many Requests", parameters: { retry_after: 5 } } : { ok: true, result: true };
    };
    const live = createTelegramLiveDraft({ store, botId: "1", transport, clock: () => T0, chatId: "42", binding: 1, draftId: 9, shape: {}, standing: async () => true, paired: () => true, timing: { draftSpacingMs: 0 } });
    live.onProgress(started);
    await vi.waitFor(() => expect(store.until).toBe(new Date(T0.getTime() + 5_000).toISOString()));
    live.onProgress(text("Words while paused "));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    await live.close();
  });
});

describe("the 👀 acknowledgement", () => {
  test("on and off go out in order on the chat's lane, spaced; an unpaired chat gets nothing", async () => {
    const calls: { at: number; reaction: unknown }[] = [];
    const transport: TelegramTransport = async (_method, params) => { calls.push({ at: Date.now(), reaction: params["reaction"] }); return { ok: true, result: true }; };
    const base = { store: pauseStore(), botId: "1", transport, clock: () => T0, chatId: "42", messageId: "5", paired: () => true, gapMs: 40 };
    const on = telegramAck({ ...base, on: true });
    const off = telegramAck({ ...base, on: false });
    await Promise.all([on, off]);
    expect(calls.map(one => one.reaction)).toEqual([[{ type: "emoji", emoji: "👀" }], []]);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(35);
    await telegramAck({ ...base, chatId: "43", on: true, paired: () => false });
    expect(calls).toHaveLength(2);
  });
});
