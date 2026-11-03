/**
 * The server kit's security rules (src/design/KIT.md "Approval"): the approval form carries the password field
 * exactly when the rules ask for one (a way in always does, Passwordless or not), an automatic approval renders
 * nothing to press, the form always carries the request's CSRF field, and text from records is escaped.
 */
import { describe, expect, test } from "vitest";
import { htmlString } from "../html.js";
import { approvalFactsNow, approveForm, composer, row, slots, chip } from "./kit.js";
import { requestContext } from "./request-context.js";
import type { ApprovalFacts, ApprovalKind } from "../design/kit.js";

const render = <T>(passwordless: boolean, run: () => T): T => requestContext.run({ csrf: "c-1", returnTo: "/work", passwordless }, run);
const form = (kind: ApprovalKind, facts: Omit<ApprovalFacts, "passwordless">, passwordless = false): string =>
  render(passwordless, () => htmlString(approveForm({ action: "/t/x/approve", kind, facts: approvalFactsNow(facts), label: "Approve and start" })));
const PASSWORD = /<input[^>]*type="password"[^>]*name="token"[^>]*autocomplete="current-password"[^>]*required/;

describe("the approval form", () => {
  test.each<[ApprovalKind, Omit<ApprovalFacts, "passwordless">, boolean, boolean]>([
    ["standard", { remembered: false }, false, true],
    ["standard", { remembered: true }, false, false],
    ["standard", { remembered: false }, true, false],
    ["step-up", { remembered: true }, false, true],
    ["step-up", { remembered: false }, true, false],
    ["none", { remembered: false }, false, false],
    ["way-in", { remembered: true }, false, true],
    ["way-in", { remembered: true, automatic: true }, true, true],
  ])("%s %j, passwordless %s: password field %s", (kind, facts, passwordless, field) => {
    const markup = form(kind, facts, passwordless);
    expect(PASSWORD.test(markup)).toBe(field);
    expect(markup).toMatch(/<form method="post" action="\/t\/x\/approve"[^>]*class="k-approve"/);
    expect(markup).toContain('<input type="hidden" name="csrf" value="c-1">');
  });

  test("an automatic approval renders nothing to press", () => {
    expect(form("standard", { remembered: false, automatic: true })).toBe("");
    expect(form("none", { remembered: false, automatic: true })).toBe("");
  });
});

test("words from records are text, never markup", () => {
  const hostile = `"><script>alert(1)</script>`;
  const markup = render(false, () => htmlString(row({ href: "/t/x", chip: chip(hostile), title: hostile, desc: hostile }))
    + htmlString(slots({ status: chip(hostile), text: hostile, acts: "", terms: hostile, err: hostile }))
    + htmlString(composer({ id: "ask", name: "text", label: hostile, value: hostile, placeholder: hostile, send: chip("x"), project: { current: hostile, items: [hostile] } })));
  expect(markup).not.toContain("<script>");
  expect(markup).toContain("&lt;script&gt;");
});
