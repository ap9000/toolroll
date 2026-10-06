import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import type { ContractResult } from "./contract.js";
import {
  chatMessageBodySchema,
  chatPairBodySchema,
  chatProblemBodySchema,
  chatTokenBodySchema,
  heldWordsSchema,
  readChatActionBody,
  readChatMessageBody,
  readChatPairBody,
  readChatPart,
  readHeldWords,
  savedChatEventBody,
  savedChatPart,
  savedChatPartSchema,
} from "./chat-content.js";

type Saved = { name: string; payload: string; kind?: string; reads?: Record<string, unknown> };
const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/chat/chat-delivery.json", import.meta.url), "utf8")) as { parts: Saved[]; events: Saved[]; heldWords: Saved[] };

const verdict = <T>(read: ContractResult<T>): SampleVerdict => (read.ok ? { ok: true } : { ok: false, lines: read.issues.map(issue => issue.line) });
const json = (value: unknown) => JSON.stringify(value);

describe("a planned message part", () => {
  const current = { version: 1, text: "Pick a path", choose: { card: 12, entry: 4, options: [{ choice: 0, label: "Ship it" }] } };
  it("holds: round trip, saved and current parts read, malformed ones refused by path", () => {
    assertContract({
      schema: savedChatPartSchema,
      read: input => verdict(readChatPart(typeof input === "string" ? input : json(input))),
      valid: [...fixture.parts.map(one => ({ name: one.name, input: one.payload })), { name: "version 1", input: current }],
      invalid: [
        { name: "not JSON", input: "{", paths: ["payload"] },
        { name: "newer version", input: { ...current, version: 2 }, paths: ["version"] },
        { name: "version 1 is strict", input: { ...current, kind: "welcome" }, paths: ["payload"] },
        { name: "no text", input: { version: 1, proposal: 17 }, paths: ["text"] },
        { name: "an unknown flow action", input: { version: 1, text: "", flow: { card: 12, entry: 3, actions: ["merge"] } }, paths: ["flow.actions[0]"] },
        { name: "an option without its label", input: { ...current, choose: { card: 12, entry: 4, options: [{ choice: 0 }] } }, paths: ["choose.options[0].label"] },
        { name: "a question's choice is its id or null", input: { version: 1, text: "", question: { id: 4, choices: [{ choice: 1, label: "Yes" }] } }, paths: ["question.choices[0].choice"] },
      ],
    });
  });

  it("reads every saved part as before, and saves the same content with its version", () => {
    expect(fixture.parts).toHaveLength(12);
    for (const one of fixture.parts) {
      const read = readChatPart(one.payload);
      expect(read, one.name).toEqual({ ok: true, value: one.reads ?? JSON.parse(one.payload) });
      if (!read.ok) continue;
      expect(JSON.parse(savedChatPart(read.value)), one.name).toEqual({ version: 1, ...(one.reads ?? JSON.parse(one.payload)) });
      expect(readChatPart(savedChatPart(read.value)), one.name).toEqual(read);
    }
  });
});

describe("a received event's body", () => {
  it("holds for each kind: round trip, saved bodies read, malformed ones refused by path", () => {
    const of = (kind: string) => fixture.events.filter(one => one.kind === kind).map(one => ({ name: one.name, input: one.payload }));
    const read = (reader: (raw: string) => ContractResult<unknown>) => (input: unknown) => verdict(reader(typeof input === "string" ? input : json(input)));
    assertContract({
      schema: chatPairBodySchema,
      read: read(readChatPairBody),
      valid: [...of("pair"), { name: "version 1", input: { version: 1, hash: "4b".repeat(32) } }],
      invalid: [{ name: "no hash", input: { version: 1 }, paths: ["hash"] }, { name: "newer", input: { version: 2, hash: "x" }, paths: ["version"] }],
    });
    assertContract({
      schema: chatMessageBodySchema,
      read: read(readChatMessageBody),
      valid: [...of("message"), { name: "version 1", input: { version: 1, text: "Ship it?", originalLength: 8 } }],
      invalid: [
        { name: "a length is a count", input: { version: 1, text: "x", originalLength: -1 }, paths: ["originalLength"] },
        { name: "about names its task", input: { version: 1, text: "x", about: { run: 41 } }, paths: ["about.task"] },
        { name: "version 1 is strict", input: { version: 1, text: "x", words: "x" }, paths: ["payload"] },
      ],
    });
    assertContract({
      schema: chatTokenBodySchema,
      read: read(readChatActionBody),
      valid: [...of("action"), { name: "version 1", input: { version: 1, token: "0123456789abcdef0123456789abcdef" } }, { name: "a problem", input: { version: 1, problem: "actions[0].value: must be a Toolroll button token" } }],
      invalid: [
        { name: "a token Toolroll didn't mint", input: { version: 1, token: "nope" }, paths: ["token"] },
        { name: "an empty problem", input: { version: 1, problem: "" }, paths: ["problem"] },
      ],
    });
    assertContract({ schema: chatProblemBodySchema, read: read(readChatActionBody), valid: [], invalid: [] });
  });

  it("reads every saved body as before, and saves what a writer gives it with its version", () => {
    for (const one of fixture.events) {
      const reader = one.kind === "pair" ? readChatPairBody : one.kind === "action" ? readChatActionBody : one.kind === "message" ? readChatMessageBody : null;
      if (reader === null) continue;
      expect(reader(one.payload), one.name).toEqual({ ok: true, value: { version: 1, ...JSON.parse(one.payload) } });
    }
    expect(JSON.parse(savedChatEventBody({ text: "hi", originalLength: 2 }))).toEqual({ version: 1, text: "hi", originalLength: 2 });
    expect(JSON.parse(savedChatEventBody({}))).toEqual({ version: 1 });
    // A handled event's body is cleared to `{}`; a message reader reads that as no words.
    expect(readChatMessageBody("{}")).toEqual({ ok: true, value: { version: 1 } });
  });

  it("reads words held for a note", () => {
    assertContract({
      schema: heldWordsSchema,
      read: input => verdict(readHeldWords(typeof input === "string" ? input : json(input))),
      valid: fixture.heldWords.map(one => ({ name: one.name, input: one.payload })),
      invalid: [{ name: "no words", input: { originalLength: 3 }, paths: ["text"] }, { name: "not JSON", input: "{", paths: ["payload"] }],
    });
  });
});
