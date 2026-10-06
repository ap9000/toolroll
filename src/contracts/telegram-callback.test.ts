import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import type { ContractResult } from "./contract.js";
import { askOf, parseTelegramUpdate, pickOf, readTelegramButtonData, telegramButton, telegramCallbackButtonSchema, telegramUpdateSchema } from "./telegram-callback.js";
import { TEXT_LIMITS } from "../text-limits.js";

type Saved = { name: string; payload: string };
const fixture = (JSON.parse(readFileSync(new URL("../../test/fixtures/chat/channel-callbacks.json", import.meta.url), "utf8")) as { telegram: { inbox: Saved[]; buttonData: string[] } }).telegram;
const verdict = <T>(read: ContractResult<T>): SampleVerdict => (read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) });

describe("a Telegram update", () => {
  it("holds: round trip, every kept update reads, Telegram's other fields are ignored, a malformed one is refused by path", () => {
    assertContract({
      schema: telegramUpdateSchema,
      read: input => verdict(parseTelegramUpdate(typeof input === "string" ? input : JSON.stringify(input))),
      valid: fixture.inbox.map(one => ({ name: one.name, input: one.payload })),
      invalid: [
        { name: "not JSON", input: "{", paths: ["payload"] },
        { name: "no update id", input: { message: { message_id: 1 } }, paths: ["update_id"] },
        { name: "an update id is positive", input: { update_id: 0 }, paths: ["update_id"] },
        { name: "a chat id is a number", input: { update_id: 9, callback_query: { id: "1", message: { message_id: 1, chat: { id: "424242" } } } }, paths: ["callback_query.message.chat.id"] },
      ],
    });
  });

  it("reads each kept update to the fields the bridge reads, as they were sent", () => {
    for (const one of fixture.inbox) {
      const read = parseTelegramUpdate(one.payload);
      if (!read.ok) throw Error(one.name);
      const sent = JSON.parse(one.payload) as { update_id: number; message?: { text?: string; chat?: { id: number } }; callback_query?: { data?: string } };
      expect(read.value.update_id).toBe(sent.update_id);
      expect(read.value.message?.text).toBe(sent.message?.text);
      expect(read.value.message?.chat?.id).toBe(sent.message?.chat?.id);
      expect(read.value.callback_query?.data).toBe(sent.callback_query?.data);
    }
  });
});

describe("a Telegram button's data", () => {
  it("holds: every form Toolroll makes reads; anything else is refused by name, within 64 bytes", () => {
    expect(TEXT_LIMITS.telegramCallbackDataBytes).toBe(64);
    assertContract({
      schema: telegramCallbackButtonSchema,
      read: input => verdict(readTelegramButtonData((input as { callback_data?: unknown }).callback_data)),
      valid: fixture.buttonData.map(data => ({ name: data, input: { text: "x", callback_data: data } })),
      invalid: [
        { name: "none", input: {}, paths: ["callback_data"] },
        { name: "a command", input: { callback_data: "/approve" }, paths: ["callback_data"] },
        { name: "a pick that isn't a task", input: { callback_data: "pick:abc" }, paths: ["callback_data"] },
        { name: "an option past the fourth", input: { callback_data: "ask:55:4" }, paths: ["callback_data"] },
        { name: "a token too short", input: { callback_data: "f".repeat(31) }, paths: ["callback_data"] },
        { name: "over Telegram's 64 bytes", input: { callback_data: "é".repeat(33) }, paths: ["callback_data"] },
      ],
    });
  });

  it("every button Toolroll makes is within 64 bytes, and one that wouldn't be is never sent", () => {
    for (const data of fixture.buttonData) expect(Buffer.byteLength(telegramButton("Go", data).callback_data)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(telegramButton("Go", `pick:${"9".repeat(15)}`).callback_data)).toBeLessThanOrEqual(64);
    expect(() => telegramButton("Go", "x".repeat(65))).toThrow("a Telegram button: callback_data: over 64 bytes");
    expect(() => telegramButton("Go", "approve")).toThrow("callback_data: not a Toolroll button");
  });

  it("reads a pick and an owner's answer", () => {
    expect(pickOf("pick:lead")).toEqual({ ref: null });
    expect(pickOf("pick:41")).toEqual({ ref: 41 });
    expect(pickOf("0123456789abcdef0123456789abcdef")).toBeNull();
    expect(askOf("ask:55:3")).toEqual({ turn: 55, option: 3 });
    expect(askOf("ask:55:x")).toEqual({ turn: 55, option: "x" });
    expect(askOf("pick:41")).toBeNull();
  });

  it("no Telegram keyboard is drawn from a hand-made button object", () => {
    for (const file of ["telegram.ts", "telegram-mate.ts", "telegram-flow.ts", "telegram-team.ts", "telegram-status.ts", "telegram-progress.ts", "teammate-question.ts"]) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source.match(/callback_data:\s/g) ?? [], file).toEqual([]);
    }
  });
});
