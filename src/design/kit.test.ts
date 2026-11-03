/**
 * The kit's rules (src/design/KIT.md): what an approval shows for each kind and set of facts, and which of the five
 * status words each task headline is. Approval asks are security rules: a way in always asks for the password typed
 * now, and nothing the page reads can turn that into one click or an automatic approval.
 */
import { describe, expect, test } from "vitest";
import { HEADLINES } from "../task-status.js";
import { APPROVAL_KINDS, approvalAsk, approvalHow, statusOfHeadline, termsOf, type ApprovalFacts, type ApprovalKind } from "./kit.js";

const facts = (over: Partial<ApprovalFacts> = {}): ApprovalFacts => ({ passwordless: false, remembered: false, ...over });
const EVERY_FACT: ApprovalFacts[] = [false, true].flatMap(passwordless => [false, true].flatMap(remembered => [false, true].map(automatic => facts({ passwordless, remembered, automatic }))));

describe("approval asks", () => {
  test.each<[ApprovalKind, Partial<ApprovalFacts>, ReturnType<typeof approvalAsk>]>([
    ["none", {}, "click"],
    ["none", { automatic: true }, "automatic"],
    ["standard", {}, "password"],
    ["standard", { remembered: true }, "click"],
    ["standard", { passwordless: true }, "click"],
    ["standard", { automatic: true }, "automatic"],
    ["step-up", {}, "password"],
    ["step-up", { remembered: true }, "password"],
    ["step-up", { passwordless: true }, "click"],
    ["step-up", { automatic: true }, "automatic"],
    ["way-in", {}, "password"],
  ])("%s with %j shows %s", (kind, over, ask) => {
    expect(approvalAsk(kind, facts(over))).toBe(ask);
  });

  test("a way in asks for the password typed now under every combination of facts, and says why", () => {
    for (const one of EVERY_FACT) {
      expect(approvalAsk("way-in", one), JSON.stringify(one)).toBe("password");
      expect(approvalHow("way-in", one)).toBe("password");
      expect(termsOf("way-in", one)).toMatch(/new way in/);
    }
  });

  test("a remembered password stands in for a standard approval only", () => {
    for (const kind of APPROVAL_KINDS) {
      const ask = approvalAsk(kind, facts({ remembered: true }));
      expect(ask === "click" && kind !== "none", kind).toBe(kind === "standard");
    }
  });

  test("the terms line never says no password is needed when the page asks for one", () => {
    for (const kind of APPROVAL_KINDS) for (const one of EVERY_FACT) {
      if (approvalAsk(kind, one) === "password") expect(termsOf(kind, one), `${kind} ${JSON.stringify(one)}`).not.toMatch(/No password needed/);
    }
  });
});

describe("status words", () => {
  test("every headline is one of the five, and only a wait on this person is Needs you", () => {
    const of = Object.fromEntries(HEADLINES.map(headline => [headline, statusOfHeadline(headline)]));
    expect(of).toEqual({
      Queued: "queued", Planning: "running", "Needs you": "needs", Waiting: "queued", Building: "running",
      "Ready for review": "needs", Complete: "finished", Failed: "failed", Stopped: "queued",
    });
  });
});
