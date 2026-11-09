import { describe, expect, test } from "vitest";
import { shapeReply } from "./reply-shape.js";
import { replyVoice, summarizeVoice } from "./reply-voice.js";

describe("how a lead reply reads", () => {
  test("a short plain answer: its sentences counted, nothing internal, no narrated opening", () => {
    expect(replyVoice("The login fix is ready and its checks passed. Approve it below.")).toEqual({ characters: 63, sentences: 2, internalWords: [], narratedOpening: false });
  });

  test("measured on the shaped text a person sees, not the raw reply", () => {
    const raw = "## Status\n\n\n\nThe **login fix** is ready.";
    expect(replyVoice(raw).characters).toBe(shapeReply(raw).length);
    expect(replyVoice(raw).characters).toBeLessThan(raw.length);
    expect(replyVoice(raw).sentences).toBe(2);
  });

  test("internal words count in the lead's own sentences, never inside code", () => {
    expect(replyVoice("I rewrote the scope and the operator can approve it.").internalWords).toEqual(["scope", "operator"]);
    expect(replyVoice("The field is `scope` in the file:\n```\noperator: true\n```").internalWords).toEqual([]);
    expect(replyVoice("The owner can approve it.").internalWords).toEqual(["owner"]);
    expect(replyVoice("You are the task's owner now.").internalWords).toEqual([]);
  });

  test.each(["I checked the task and it is ready.", "I looked at the log.", "Let me find that.", "Certainly. It is ready.", "Sure, it is ready."])("a narrated opening: %s", reply => {
    expect(replyVoice(reply).narratedOpening).toBe(true);
  });

  test("a summary over answers: median length, the long share, internal words and narrated openings", () => {
    const long = `${"The checks passed. ".repeat(20)}`;
    const summary = summarizeVoice([replyVoice("It is ready."), replyVoice("Let me look. The scope changed."), replyVoice(long)]);
    expect(summary).toEqual({ answers: 3, medianCharacters: 31, longShare: 1 / 3, internalWords: 1, narratedOpenings: 1 });
    expect(summarizeVoice([])).toEqual({ answers: 0, medianCharacters: 0, longShare: 0, internalWords: 0, narratedOpenings: 0 });
  });
});
