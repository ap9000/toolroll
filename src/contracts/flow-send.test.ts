import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFlowSend } from "../flow-send.js";
import { assertContract, type SampleVerdict } from "./contract-test.js";
import {
  flowChoiceAnswerSchema, flowChoosePayloadSchema, flowSendForStore, flowSendPayloadSchema, readFlowChoiceAnswer, readFlowItems, readFlowSendPayload, type FlowSendContent,
} from "./flow-send.js";

type Recorded = { name: string; source: string; raw: string; reads: FlowSendContent | null };
const recorded = (JSON.parse(readFileSync(new URL("../../test/fixtures/stages/flow-send.json", import.meta.url), "utf8")) as { samples: Recorded[] }).samples;
const verdict = (parsed: { ok: true } | { ok: false; issues: { line: string }[] }): SampleVerdict => parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(issue => issue.line) };
const json = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return undefined; } };

const send = { version: 1, title: "Fix the total · Build", from: "Build", summary: "Totals now round half-up.", links: [{ label: "Result", path: "/t/fix-total" }, { label: "Pull request", url: "https://github.com/example/shop/pull/12" }], shots: { taskId: "fix-total", run: 3 } };
const choose = { ...send, shots: null, options: [{ choice: 0, label: "Ship it" }, { choice: 1, label: "Ignore" }], reply: true };
const legacy = (name: string) => json(recorded.find(one => one.name === name)!.raw);

describe("what a Send to me visit sends", () => {
  it("holds: the round trip loses nothing, kept sends of every age read, and a bad one is refused by path", () => {
    assertContract({
      schema: flowSendPayloadSchema,
      read: input => verdict(readFlowSendPayload(input)),
      valid: [
        { name: "version 1", input: send },
        { name: "version 1, research items", input: { ...send, items: [{ title: "Pattern", why: "Fits.", url: "https://example.com/p", source: "Example", plug: "Beside the form", shot: null }] } },
        { name: "saved before versions: a build's result", input: legacy("a build's result, with its pull request and screenshots") },
        { name: "saved before versions: research", input: legacy("research, with its items") },
        { name: "saved before versions: research, one item unreadable", input: legacy("research, one item unreadable") },
      ],
      invalid: [
        { name: "no summary", input: { ...send, summary: undefined }, paths: ["summary"] },
        { name: "a link that is neither", input: { ...send, links: [{ label: "Elsewhere", url: "http://example.com" }] }, paths: ["links[0].url"] },
        { name: "no items is no list", input: { ...send, items: [] }, paths: ["items"] },
        { name: "an item's link", input: { ...send, items: [{ title: "t", why: "w", url: "ftp://x", source: "s", plug: "", shot: null }] }, paths: ["items[0].url"] },
        { name: "a key it doesn't know", input: { ...send, extra: true }, paths: ["payload"] },
        { name: "a newer Toolroll's", input: { ...send, version: 2 }, paths: ["version"] },
        { name: "saved before versions, no title", input: legacy("no title"), paths: ["title"] },
      ],
    });
  });
});

describe("what a Person chooses visit sends", () => {
  it("holds: options as offered and whether a reply is taken, of every age", () => {
    assertContract({
      schema: flowChoosePayloadSchema,
      read: input => verdict(readFlowSendPayload(input)),
      valid: [
        { name: "version 1", input: choose },
        { name: "saved before versions: with a reply", input: legacy("a choice, with a reply taken") },
        { name: "saved before versions: no reply path", input: legacy("a choice without a reply path") },
      ],
      invalid: [
        { name: "no reply flag", input: { ...choose, reply: undefined }, paths: ["reply"] },
        { name: "an option out of place", input: { ...choose, options: [{ choice: -1, label: "x" }] }, paths: ["options[0].choice"] },
      ],
    });
  });
});

describe("kept sends read exactly as before", () => {
  it("every recorded one reads as 0.9.36's readFlowSend read it", () => {
    for (const one of recorded) expect(readFlowSend(one.raw), one.name).toEqual(one.reads);
  });

  it("is kept with its version and reads back the same", () => {
    const content: FlowSendContent = { title: "t", summary: "s", links: [{ label: "Card", path: "/flows/1?card=2" }], shots: null, options: [{ choice: 0, label: "Go" }], reply: false };
    expect(JSON.parse(flowSendForStore(content))).toEqual({ version: 1, ...content });
    expect(readFlowSend(flowSendForStore(content))).toEqual(content);
    expect(readFlowSend(JSON.stringify({ ...send, version: 2 }))).toBeNull();
  });

  it("items read as before: a whole-number screenshot id or none, and a web link", () => {
    expect(readFlowItems([{ title: "t", why: "w", url: "http://example.com", source: "s", plug: "p", shot: 2.5, extra: 1 }, { title: "no link" }, "x"]))
      .toEqual([{ title: "t", why: "w", url: "http://example.com", source: "s", plug: "p", shot: null }]);
    expect(readFlowItems("not a list")).toEqual([]);
  });
});

describe("a person's choice", () => {
  it("holds: an option by place, or a reply as the note", () => {
    assertContract({
      schema: flowChoiceAnswerSchema,
      read: input => verdict(readFlowChoiceAnswer(input)),
      valid: [
        { name: "an option, by its place and words", input: { card: 3, entry: 2, choice: 0, label: "Ship it", note: null } },
        { name: "a reply", input: { card: 3, choice: null, note: "Make it blue." } },
      ],
      invalid: [
        { name: "a place before the first", input: { card: 3, choice: -1, note: null }, paths: ["choice"] },
        { name: "a place that isn't one", input: { card: 3, choice: Number.NaN, note: null }, paths: ["choice"] },
        { name: "no card", input: { choice: 0, note: null }, paths: ["card"] },
      ],
    });
  });
});
