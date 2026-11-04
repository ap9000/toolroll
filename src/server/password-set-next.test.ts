/**
 * Easy-start C4: a refusal's "Set a password" link carries the refused page on (`/password/set?next=…`), built by the
 * server from the request, and /password/set goes there once the password is set. Hostile values go home.
 */
import { describe, expect, test } from "vitest";
import { localOwnerRefusal } from "../local-owner.js";
import { PASSWORD_SET_NEXT_MAX, passwordSetNext, refusalNext } from "./http.js";
import { html, htmlString, type Html } from "../html.js";
import { localOwnerStepUps } from "./render-people.js";

describe("passwordSetNext", () => {
  test("a page of this console, as path and query", () => {
    expect(passwordSetNext("/flows")).toBe("/flows");
    expect(passwordSetNext("/settings/models")).toBe("/settings/models");
    expect(passwordSetNext("/settings/models?scope=installation")).toBe("/settings/models?scope=installation");
    expect(passwordSetNext("/t/round-prices")).toBe("/t/round-prices");
    // A fragment is never part of it.
    expect(passwordSetNext("/flows#examples")).toBe("/flows");
  });

  test("hostile values go home", () => {
    const hostile = [
      null, undefined, "", "flows", "https://evil.example/", "//evil.example/x", "///evil.example", "/\\evil.example", "/%5Cevil.example",
      "/%2F%2Fevil.example", "/%2f/evil.example", "javascript:alert(1)", "/javascript:alert(1)", " /flows", "/flows\n", "/flows\r\nSet-Cookie: x=1",
      "/fl\u0000ows", "/%00", "/%E0%A4%A", "/login", "/login/once/abc", "/logout", "/signup", "/join/abc", "/password/set", "/password/set?next=%2Fflows",
      "/chat?fragment=1", "/no-such-page", "/flows/example", "/settings/models/apply", `/${"a".repeat(PASSWORD_SET_NEXT_MAX)}`, "/http://evil.example",
    ];
    for (const one of hostile) expect(passwordSetNext(one as string | null | undefined), String(one)).toBe("/");
  });

  test("a query key that could carry a secret is dropped; the rest stays", () => {
    expect(passwordSetNext("/settings/models?scope=installation&token=abc&csrf=1&password=x")).toBe("/settings/models?scope=installation");
  });
});

describe("refusalNext: the page a refused request was on", () => {
  const at = (path: string) => new URL(path, "http://127.0.0.1:4180");
  test("a page read is itself", () => {
    expect(refusalNext("GET", at("/settings/models?scope=installation"))).toBe("/settings/models?scope=installation");
    expect(refusalNext("GET", at("//evil.example/x"))).toBe("/");
  });
  test("a refused form is its own page when a browser can open it, else the nearest page above it", () => {
    expect(refusalNext("POST", at("/settings/passwordless"))).toBe("/settings/passwordless");
    expect(refusalNext("POST", at("/flows/example"))).toBe("/flows");
    expect(refusalNext("POST", at("/settings/models/apply"))).toBe("/settings/models");
    expect(refusalNext("POST", at("/t/round-prices/retry"))).toBe("/t/round-prices");
    // Nothing above it a browser can open: home.
    expect(refusalNext("POST", at("/lead/check"))).toBe("/");
    expect(refusalNext("POST", at("/x"))).toBe("/");
  });
  test("the refusal's link carries it as next, encoded", () => {
    expect(localOwnerRefusal(false, refusalNext("POST", at("/flows/example")))).toEqual({ message: "Set a password to do this.", action: "Set a password", href: "/password/set?next=%2Fflows" });
    expect(localOwnerRefusal(false, "/")).toMatchObject({ href: "/password/set" });
    expect(localOwnerRefusal(true, "/flows")).toMatchObject({ message: "Sign in with your password to do this.", href: "/login?return=%2Fflows" });
  });
});

/** Markup as written (a template with no holes is taken as it is). */
const raw = (markup: string): Html => html(Object.assign([markup], { raw: [markup] }) as unknown as TemplateStringsArray);

describe("localOwnerStepUps: a step-up field becomes the way to set a password", () => {
  const swap = (markup: string) => htmlString(localOwnerStepUps(raw(markup), "/password/set?next=%2Fsettings%2Fmodels"));
  const said = '<p class="k-note" data-local-step-up>Set a password to do this. <a class="k-link" href="/password/set?next=%2Fsettings%2Fmodels">Set a password</a></p>';
  test("a kit field, a labelled input and a bare input, label and hint going with it", () => {
    expect(swap('<form><div class="k-field"><label class="k-label" for="pw">Your password</label><input class="k-input" id="pw" name="password" type="password" aria-describedby="pw-err" autocomplete="current-password" required><span class="k-err" id="pw-err" role="alert"></span></div><button>Apply</button></form>'))
      .toBe(`<form>${said}<button>Apply</button></form>`);
    expect(swap('<label>Your password<input type="password" name="password" autocomplete="current-password" required></label>')).toBe(said);
    expect(swap('<label>Your password <span class="meta">only to widen</span><input type="password" name="password" autocomplete="current-password"></label>')).toBe(said);
    expect(swap('<input type="password" name="token" data-so-typed autocomplete="current-password" required>')).toBe(said);
  });
  test("a new password, a secret or any other field is left as it is", () => {
    for (const markup of ['<input type="password" name="password" autocomplete="new-password">', '<input type="password" name="bot" autocomplete="off">', '<input type="text" name="title">']) {
      expect(swap(markup)).toBe(markup);
    }
  });
});
