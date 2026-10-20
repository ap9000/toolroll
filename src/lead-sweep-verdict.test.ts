/** A sweep child's verdict is its conclusion's first line, read strictly: anything else is no verdict, never a guess. */
import { expect, test } from "vitest";
import { verdictOf } from "./lead-sweep.js";

test("the four verdicts, with their one line why", () => {
  expect(verdictOf("Verdict: fixed — the retry loop reset the deadline.\nMore detail.")).toEqual({ verdict: "fixed", why: "the retry loop reset the deadline." });
  expect(verdictOf("Verdict: not reproducible — tried three ways on main.")).toEqual({ verdict: "not reproducible", why: "tried three ways on main." });
  expect(verdictOf("verdict: Not-Reproducible: no crash on 1.4.2")).toEqual({ verdict: "not reproducible", why: "no crash on 1.4.2" });
  expect(verdictOf("Verdict: blocked - needs the staging key")).toEqual({ verdict: "blocked", why: "needs the staging key" });
  expect(verdictOf("Verdict: done — renamed.")).toMatchObject({ verdict: "done" });
});

test("anything else is no verdict", () => {
  for (const one of [null, undefined, "", "Fixed it.", "Verdict: fixed", "Verdict: maybe — unsure", "I think the Verdict: fixed — x", "Verdict: fixed — " + "x".repeat(400)]) {
    expect(verdictOf(one as string | null)).toBeNull();
  }
});
