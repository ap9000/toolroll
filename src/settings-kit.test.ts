/**
 * The settings kit and its proof inventory (docs/plans/settings-revamp.md §4, S2), as contract tables:
 * - every inventory row agrees with its form contract (console-api.ts) and the route table (role, step-up scope), and
 *   every settings step-up route has a row;
 * - the kit renders each row's own proof field — named as its handler reads it — and nothing for a CSRF-only row;
 *   Passwordless leaves only a step-up field out; the identity-provider swap still finds the field;
 * - secret and proof fields never carry a value, and the dialog keeps the pressed button and every hidden term;
 * - over HTTP, one row of each kind: Passwordless stands in for a step-up only, never for a credential or typed act.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { CONSOLE_FORMS } from "./contracts/console-api.js";
import { htmlString } from "./html.js";
import { passwordlessOn } from "./passwordless.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { ssoStepUps } from "./server/render-people.js";
import { requestContext } from "./server/request-context.js";
import { matchRoute, ROUTES } from "./server/route-table.js";
import { choiceGroup, crumbsHtml, headingText, isSettingsFrame, secretInput, settingsCrumbs, stepUpForm, textField } from "./settings-kit.js";
import { SETTINGS_KIT_SCRIPT } from "./settings-kit-script.js";
import { PROOF_INVENTORY, proofRow } from "./settings-proofs.js";
import { openStore, type Store } from "./store.js";
import { T0 } from "../test/serve-kit.js";

/** Render as a browser request would: a form token, and Passwordless as given. */
const render = <T>(passwordless: boolean, run: () => T): T => requestContext.run({ csrf: "c-1", returnTo: "/settings", passwordless }, run);
const formOf = (id: string, route: string, passwordless = false) => render(passwordless, () => htmlString(stepUpForm({ proof: id, action: route, id: `f-${id}`, body: "" })));
const GUARD = CONSOLE_FORMS.mutationGuard.fields;

describe("the proof inventory agrees with the handlers' contracts", () => {
  test.each(PROOF_INVENTORY.map(row => [row.id, row] as const))("%s", (_id, row) => {
    const fields = CONSOLE_FORMS[row.form].fields;
    if (row.field !== null) expect(fields).toContain(row.field);
    expect(row.proof === "none").toBe(row.field === null);
    for (const secret of row.secrets) expect(fields).toContain(secret);
    for (const term of row.terms) expect([...fields, ...GUARD]).toContain(term);
    // The Passwordless and identity-provider columns follow from the prover (scope.ts proveAccountNow, guards.ts).
    expect(row.passwordless).toBe(row.proof === "none" ? "n/a" : row.proof === "step-up" ? "accepted" : "refused");
    expect(row.sso).toBe(row.proof === "none" ? "n/a" : row.proof === "step-up" || row.proof === "credential" ? "accepted" : "refused");
    for (const path of row.routes) {
      const route = matchRoute("POST", path, "console");
      expect(route, path).not.toBeNull();
      expect(route!.role, path).toBe(row.role);
      expect(route!.callers).toContain("cookie");
      // A proof the handler always asks for is a step-up route: cookie callers only, never a token.
      if (row.proof !== "none" && row.when === undefined) expect(route!.scope, path).toBe("step-up");
    }
  });

  test("every route has one row, and every settings step-up route has a row", () => {
    const routes = PROOF_INVENTORY.flatMap(row => row.routes);
    expect(new Set(routes).size).toBe(routes.length);
    // Step-up routes the kit doesn't draw: they post no proof field a settings form renders.
    const elsewhere = new Set(["/settings/telegram/retry", "/mode/confirm", "/settings/project/concurrency"]);
    const stepUps = ROUTES.filter(one => one.method === "POST" && one.stage === "console" && one.scope === "step-up"
      && /^\^\\\/(settings|people|mode|control|spend|push|chat\\\/config)/.test(one.pattern)).map(one => one.sample);
    expect(stepUps.length).toBeGreaterThan(40);
    const missing = stepUps.filter(path => !routes.includes(path) && !elsewhere.has(path));
    expect(missing).toEqual([]);
  });
});

describe("the kit renders each action's own proof", () => {
  test.each(PROOF_INVENTORY.map(row => [row.id, row] as const))("%s", (_id, row) => {
    const route = row.routes[0]!;
    const page = formOf(row.id, route);
    const proofs = [...page.matchAll(/<input type="password" name="([^"]+)" autocomplete="current-password"/g)].map(m => m[1]);
    if (row.field === null) {
      // CSRF only: no proof field, no dialog.
      expect(proofs).toEqual([]);
      expect(page).not.toContain("<dialog");
    } else {
      expect(proofs).toEqual([row.field]);
      expect(page).toMatch(/<dialog class="kit-dialog"[^>]*data-kit-dialog>/);
      // The proof sits in the form's own HTML (inline without JavaScript), never with a value.
      expect(page).toMatch(new RegExp(`<div class="kit-proof" data-kit-proof><label>[^<]+<input type="password" name="${row.field}" autocomplete="current-password" required></label></div>`));
      // Passwordless leaves out only a step-up field; a credential or typed act still asks.
      const passwordless = formOf(row.id, route, true);
      expect(passwordless.includes(`name="${row.field}"`)).toBe(row.proof !== "step-up");
      expect(passwordless.includes("<dialog")).toBe(row.proof !== "step-up");
      // Signed in with an identity provider: the field becomes its one-use re-check, inside the same proof slot.
      const sso = htmlString(ssoStepUps(stepUpFormHtml(row.id, route), { label: "Okta", fresh: false }, "/settings"));
      expect(sso).toMatch(new RegExp(`data-kit-proof><input type="hidden" name="${row.field}" value=""><a class="sso-step-up"`));
    }
    expect(page).toContain('<input type="hidden" name="csrf" value="c-1">');
    expect(page).not.toMatch(/type="password"[^>]*\svalue=/);
  });

  test("the dialog keeps the pressed button and every hidden term; Cancel and Confirm never submit by themselves", () => {
    const page = render(false, () => htmlString(stepUpForm({ proof: "mode-sign", action: "/mode/sign", id: "sign", body: "",
      hidden: { nonce: "n-1", digest: "d-1" }, save: { label: "Sign", name: "act", value: "sign" } })));
    expect(page).toMatch(/<button type="submit" class="kit-save" name="act" value="sign">Sign<\/button>/);
    expect(page).toContain('<input type="hidden" name="nonce" value="n-1"><input type="hidden" name="digest" value="d-1">');
    expect(page).toMatch(/<button type="button" class="kit-cancel" data-kit-cancel>/);
    expect(page).toMatch(/<button type="button" class="kit-confirm" data-kit-confirm>/);
    // The dialog sits inside the form, so the field it shows is still the form's.
    expect(page.indexOf("<dialog")).toBeGreaterThan(page.indexOf("<form"));
    expect(page.indexOf("</dialog>")).toBeLessThan(page.indexOf("</form>"));
    // The script posts with that button (requestSubmit) and never fetches.
    expect(SETTINGS_KIT_SCRIPT).toContain("requestSubmit(by)");
    expect(SETTINGS_KIT_SCRIPT).not.toMatch(/fetch\(|XMLHttpRequest|\.value\s*=[^=]/);
  });

  test("a proof or secret is never a hidden value, and a form only posts to its row's routes", () => {
    expect(() => render(false, () => stepUpForm({ proof: "spend-budget", action: "/spend/budget", id: "x", body: "", hidden: { password: "p" } }))).toThrow();
    expect(() => render(false, () => stepUpForm({ proof: "lead-config", action: "/chat/config", id: "x", body: "", hidden: { key: "k" } }))).toThrow();
    expect(() => render(false, () => stepUpForm({ proof: "spend-budget", action: "/settings/retention", id: "x", body: "" }))).toThrow();
    expect(() => proofRow("no-such-row")).toThrow();
  });

  test("secret inputs are masked, value-free and kept out of password managers; field errors are tied to their field", () => {
    const secret = htmlString(secretInput({ id: "k", name: "value", label: "API key" }));
    for (const attr of ['autocomplete="off"', "data-1p-ignore", 'data-lpignore="true"', "data-bwignore", 'data-form-type="other"', "data-so-secret", 'type="password"'])
      expect(secret).toContain(attr);
    expect(secret).not.toMatch(/\svalue=/);
    const field = htmlString(textField({ id: "usd", name: "usd", label: "Limit", value: "12x", error: "Enter a whole number." }));
    expect(field).toMatch(/value="12x" aria-invalid="true" aria-describedby="usd-error" autofocus>/);
    expect(field).toContain('<p class="kit-field-error" id="usd-error" role="alert">Enter a whole number.</p>');
    const group = htmlString(choiceGroup({ id: "q", name: "quality-mode", legend: "Quality", checked: "b", options: [{ value: "a", label: "A", detail: "first" }, { value: "b", label: "B" }] }));
    expect(group).toMatch(/^<fieldset class="kit-choices"><legend>Quality<\/legend>/);
    expect(group).toContain('aria-describedby="q-0-detail"');
    expect(group).toMatch(/value="b" checked>/);
  });
});

describe("the frame", () => {
  test("which pages wear it, and their breadcrumb", () => {
    for (const path of ["/settings", "/settings/retention", "/setup", "/setup/agent", "/people", "/mode", "/control", "/spend"]) expect(isSettingsFrame(path), path).toBe(true);
    for (const path of ["/chat", "/work", "/settingsx", "/spend/budget", "/peoplex", "/system"]) expect(isSettingsFrame(path), path).toBe(false);
    expect(settingsCrumbs("/settings", "Settings", "<h1>Settings</h1>")).toBeUndefined();
    expect(settingsCrumbs("/work", "Tasks", "<h1>Tasks</h1>")).toBeUndefined();
    expect(settingsCrumbs("/people", "people", '<h1 class="x">People &amp; access</h1>')).toEqual([{ label: "Settings", href: "/settings" }, { label: "People & access", href: null }]);
    expect(settingsCrumbs("/mode", "mode", "<p>no heading</p>")).toEqual([{ label: "Settings", href: "/settings" }, { label: "Mode", href: null }]);
    expect(headingText("<h1><span>Pair</span> Telegram</h1>")).toBe("Pair Telegram");
    expect(htmlString(crumbsHtml([{ label: "Settings", href: "/settings" }, { label: "<b>", href: null }]))).toContain('<li aria-current="page">&lt;b&gt;</li>');
  });
});

function stepUpFormHtml(id: string, route: string) {
  return render(false, () => stepUpForm({ proof: id, action: route, id: `f-${id}`, body: "" }));
}

describe("over HTTP: Passwordless stands in for a step-up only", () => {
  let home: string, store: Store, server: Server, base: string, password: string;
  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "so-settings-kit-")));
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    password = added.token;
    server = createDecisionServer({ store, evidenceRoot: home, repos: [home], terminalHost: null, configDir: home } as Parameters<typeof createDecisionServer>[0]);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const post = async (cookie: string, path: string, fields: Record<string, string>) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(fields), redirect: "manual" });
    return { status: response.status, location: decodeURIComponent(response.headers.get("location") ?? "") };
  };

  test("one row of each kind, with Passwordless on and the proof field left empty", async () => {
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${base}/settings/passwordless`, { headers: { cookie } })).text())?.[1] ?? "";
    expect((await post(cookie, "/settings/passwordless", { csrf, action: "on", password })).location).toMatch(/Passwordless is on/);
    expect(passwordlessOn(store)).toBe(true);
    // step-up (retention): the session stands in.
    expect(proofRow("retention").proof).toBe("step-up");
    expect((await post(cookie, "/settings/retention", { csrf })).location).toMatch(/said=Nothing changed/);
    // credential (making an invite): refused, no invite made.
    expect(proofRow("people-invite").proof).toBe("credential");
    expect((await post(cookie, "/people/invite", { csrf, role: "viewer", token: "" })).status).toBe(403);
    expect(store.openInvites(new Date())).toEqual([]);
    // typed password (the lead's setup): refused before anything is read.
    expect(proofRow("lead-config").proof).toBe("typed-password");
    expect((await post(cookie, "/chat/config", { csrf, token: "", off: "1" })).location).toMatch(/takes your password, typed again/);
    // typed password (this device's alerts): refused the same way.
    expect((await post(cookie, "/push/subscribe", { csrf, token: "" })).location).toMatch(/takes your password, typed again/);
  });
});
