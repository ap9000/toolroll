// @vitest-environment happy-dom
/**
 * The server kit's security rules (src/design/KIT.md "Approval"): the approval form carries the password field
 * exactly when the rules ask for one (a way in always does, Passwordless or not), an automatic approval renders
 * nothing to press, the form always carries the request's CSRF field, and text from records is escaped.
 */
import { describe, expect, test } from "vitest";
import { html, htmlString } from "../html.js";
import { approvalFactsNow, approveForm, composer, row, select, sendButton, slots, chip, toggleChip } from "./kit.js";
import { requestContext } from "./request-context.js";
import type { ApprovalFacts, ApprovalKind } from "../design/kit.js";

const render = <T>(passwordless: boolean, run: () => T): T => requestContext.run({ csrf: "c-1", returnTo: "/tasks", passwordless }, run);
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

  test("an approval form always carries CSRF and the k-approve guard marker, whatever a caller passes", () => {
    const at = (form: object) => render(false, () => htmlString(approveForm({ action: "/t/x/approve", kind: "way-in", facts: approvalFactsNow({ remembered: false }), label: "Create invite link", form: form as never })));
    expect(() => at({ signedOut: true })).toThrow(/CSRF/);
    const extra = at({ attrs: { class: "extra wide", "data-approval-kind": "none" } });
    expect(extra).toMatch(/class="k-approve extra wide"/);
    expect(extra).toContain('data-approval-kind="way-in"');
    expect(extra).toContain('name="csrf" value="c-1"');
    // Outside a signed-in request there is no CSRF to give, so no approval form renders at all.
    expect(() => htmlString(approveForm({ action: "/t/x/approve", kind: "standard", facts: { passwordless: false, remembered: false }, label: "Approve" }))).toThrow();
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
    + htmlString(composer({ id: "ask", name: "text", label: hostile, value: hostile, placeholder: hostile, send: chip("x"), project: { current: hostile, items: [hostile], sub: hostile } })));
  expect(markup).not.toContain("<script>");
  expect(markup).toContain("&lt;script&gt;");
});

test("the composer is one filled object: chips inside, its note and refusal under the box", () => {
  const markup = render(false, () => htmlString(composer({ id: "nt", name: "title", label: "What should change?", send: sendButton({ label: "File task" }), error: "Name the change.",
    project: { current: "payments-api", items: ["payments-api"], sub: "Lead" },
    before: html`${select({ id: "nt-project", name: "repo", label: "Project", items: [["/r/a", "payments-api"]], current: "/r/a", chip: true })}${toggleChip({ id: "nt-plan", name: "plan-first", label: "Read code before planning", on: true, attrs: { value: "1" } })}`,
    note: "The agent reads the code first." })));
  const host = new DOMParser().parseFromString(`<body>${markup}</body>`, "text/html").body;
  const field = host.querySelector(".k-composer-field")!;
  const box = field.querySelector(".k-composer")!;
  // The chip: the primary word, then the dimmer secondary word; no chevron box.
  expect(box.querySelector(".k-composer-chip [data-k-project-name]")!.textContent).toBe("payments-api");
  expect(box.querySelector(".k-composer-chip .k-chip-sub")!.textContent).toBe("Lead");
  // A project chosen without script is a native select drawn as a pill; an on/off choice is a toggle chip (role=switch).
  expect(box.querySelector(".k-selw-chip select[name=repo]")).not.toBeNull();
  const toggle = box.querySelector<HTMLInputElement>(".k-tchip input#nt-plan")!;
  expect(toggle.getAttribute("role")).toBe("switch");
  expect(toggle.hasAttribute("checked")).toBe(true);
  // Words never sit inside the box: the note and the refusal follow it.
  expect(box.querySelector(".k-composer-note, .k-composer-err")).toBeNull();
  expect(field.querySelector(":scope > .k-composer-note")!.textContent).toBe("The agent reads the code first.");
  expect(field.querySelector(":scope > #nt-err")!.textContent).toBe("Name the change.");
  expect(box.querySelector("textarea")!.getAttribute("aria-describedby")).toBe("nt-err");
});
