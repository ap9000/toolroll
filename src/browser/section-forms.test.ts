// @vitest-environment happy-dom
/**
 * The kit's section forms (browser/kit/section-forms.ts) on the real server markup (settings-groups-ui.ts,
 * settings-kit.ts kitSectionForm): Codex wave D r1 #2–#5. Posting is a mocked fetch or a recorded requestSubmit;
 * a reload is recorded and then played by rendering the page again.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { html, htmlString } from "../html.js";
import { requestContext, withFormToken } from "../server/request-context.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GuardedHtml } from "./guarded-html.js";
import { alertsGroup, approvalGroup, pushScriptOf, type SettingsFacts } from "../settings-groups-ui.js";
import { installKitBehavior } from "./kit/behavior.js";
import { kitSectionForm } from "../settings-kit.js";

const FACTS: SettingsFacts = {
  name: "alex", approver: true, operator: true, browser: true, installation: true, said: null, problem: null, theme: "system", accent: "#171717", version: null,
  permission: { mode: "auto", canManage: true, changed: null }, quality: { mode: "default", canManage: true, changed: null },
  providers: null, workers: null, updates: null, firstResult: null,
  chat: { mode: "quiet", digestAt: null, screenshots: "off", projects: [{ repo: "/r/shop", name: "shop", muted: false }] },
  messaging: null, push: { available: true, devices: [] }, digest: null, telegram: { state: "not set", current: "not set", delivery: null, failing: false },
  email: null, phone: null, projects: [], people: null, passwordless: false, sso: null, access: { sessions: 1, tokens: 0 }, backup: null,
};
const alerts = () => withFormToken("c".repeat(64), () => htmlString(alertsGroup(FACTS, {})));
const approval = () => withFormToken("c".repeat(64), () => htmlString(approvalGroup({ facts: { said: null, problem: null, permission: FACTS.permission, quality: FACTS.quality }, flags: {}, projects: [], chosen: "", rules: html``, mode: "Locked" } as never)));
const render = (page: string) => { document.body.innerHTML = page; window.dispatchEvent(new CustomEvent("standing-orders:workspace-rendered")); };
const form = (id: string) => document.getElementById(id) as HTMLFormElement;
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const pick = (selector: string) => { const input = document.querySelector<HTMLInputElement>(selector)!; input.click(); input.checked = true; input.dispatchEvent(new Event("change", { bubbles: true })); };
const save = (id: string) => form(id).querySelector<HTMLButtonElement>("[data-k-save]")!.click();
let reloads = 0, assigned: string[] = [];

beforeAll(() => installKitBehavior());
beforeEach(() => {
  reloads = 0; assigned = [];
  vi.spyOn(window.location, "reload").mockImplementation(() => { reloads += 1; });
  vi.spyOn(window.location, "assign").mockImplementation((to: string | URL) => { assigned.push(String(to)); });
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

test("r2 a: saving one section with another changed asks first, in place; Cancel posts nothing, Save this anyway posts once", async () => {
  render(alerts());
  pick('#reach-form input[name="mode"][value="all"]');
  const pings = document.querySelector<HTMLInputElement>('#mute--r-shop input[name="pings"]')!;
  pings.click();
  pings.dispatchEvent(new Event("change", { bubbles: true }));
  const fetched = vi.fn(async () => ({ url: `${location.origin}/settings/alerts?said=x`, redirected: true, ok: true, status: 200, text: async () => "" }));
  vi.stubGlobal("fetch", fetched);
  save("mute--r-shop");
  const ask = document.querySelector<HTMLElement>(".k-pop")!;
  expect(ask.textContent).toContain("You have unsaved changes in What reaches you. Saving this will discard them.");
  ask.querySelector<HTMLButtonElement>("[data-k-close]")!.click();
  await tick();
  expect(fetched).not.toHaveBeenCalled();
  expect(document.querySelector(".k-pop")).toBeNull();
  expect(form("reach-form").hasAttribute("data-dirty")).toBe(true);
  save("mute--r-shop");
  document.querySelector<HTMLButtonElement>(".k-pop [data-k-discard]")!.click();
  await tick();
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(assigned).toHaveLength(1);
  vi.unstubAllGlobals();
});

test("r2 c/d: an unconfirmed save opens the page again with ?unconfirmed=<form>; a /login landing is unconfirmed, a ?problem= is a refusal", async () => {
  for (const answer of [
    async () => { throw new TypeError("network"); },
    async () => ({ url: `${location.origin}/settings/alerts?said=x`, redirected: true, ok: false, status: 500, text: async () => "" }),
    async () => ({ url: `${location.origin}/login?return=%2Fsettings%2Falerts`, redirected: true, ok: true, status: 200, text: async () => "<h1>Sign in</h1>" }),
  ]) {
    assigned = [];
    render(alerts());
    pick('#reach-form input[name="mode"][value="all"]');
    vi.stubGlobal("fetch", vi.fn(answer));
    save("reach-form");
    await tick();
    expect(assigned).toEqual(["/?unconfirmed=reach-form#notifications"]);
    expect(document.body.textContent).not.toContain("nothing was saved");
    // Still pending: no retry from this page.
    expect(document.querySelector<HTMLButtonElement>("#reach-form [data-k-save]")!.classList.contains("busy")).toBe(true);
  }
  vi.stubGlobal("fetch", vi.fn(async () => ({ url: `${location.origin}/settings/alerts?problem=${encodeURIComponent("Choose a mode.")}`, redirected: true, ok: true, status: 200, text: async () => "" })));
  render(alerts());
  pick('#reach-form input[name="mode"][value="all"]');
  save("reach-form");
  await tick();
  expect(form("reach-form").querySelector(".k-ssave-err")!.textContent).toContain("Choose a mode. Your edits are still here.");
  expect(document.querySelector<HTMLInputElement>('#reach-form input[name="mode"][value="all"]')!.checked).toBe(true);
  vi.unstubAllGlobals();
});

test("r2 c: the server draws the unconfirmed note, and it survives the workspace mounting the page after the kit installs", async () => {
  const page = requestContext.run({ csrf: "c".repeat(64), returnTo: "/settings/alerts?unconfirmed=reach-form" }, () => htmlString(alertsGroup(FACTS, {})));
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(createElement(GuardedHtml, { html: page })); });
  window.dispatchEvent(new CustomEvent("standing-orders:workspace-rendered"));
  expect(form("reach-form").querySelector(".k-ssave-err")!.textContent).toContain("Couldn’t confirm whether this saved.");
  expect(form("mute--r-shop").querySelector(".k-ssave-err")!.textContent).toBe("");
  await act(async () => { root.unmount(); });
});

test("r2: section forms never touch Web Storage", async () => {
  expect(readFileSync(join(__dirname, "kit", "section-forms.ts"), "utf8")).not.toMatch(/sessionStorage|localStorage|indexedDB/);
  const touched = [vi.spyOn(Storage.prototype, "setItem"), vi.spyOn(Storage.prototype, "getItem"), vi.spyOn(Storage.prototype, "removeItem")];
  render(alerts());
  pick('#reach-form input[name="mode"][value="all"]');
  vi.stubGlobal("fetch", vi.fn(async () => ({ url: `${location.origin}/settings/alerts?said=x`, redirected: true, ok: true, status: 200, text: async () => "" })));
  save("reach-form");
  await tick();
  render(alerts());
  for (const spy of touched) expect(spy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test("#5: a conditional proof, once asked for, needs the password; nothing posts with it empty", async () => {
  render(approval());
  pick('#permission-form input[name="permission-mode"][value="bypassPermissions"]');
  const fetched = vi.fn(async () => ({ url: `${location.origin}/settings/approval?said=x`, redirected: true, ok: true, status: 200, text: async () => "" }));
  vi.stubGlobal("fetch", fetched);
  save("permission-form");
  const pop = document.querySelector<HTMLElement>(".k-pop")!;
  expect(pop).not.toBeNull();
  pop.querySelector<HTMLButtonElement>("[data-k-sconfirm]")!.click();
  await tick();
  expect(fetched).not.toHaveBeenCalled();
  pop.querySelector<HTMLInputElement>('input[name="password"]')!.value = "pw";
  pop.querySelector<HTMLButtonElement>("[data-k-sconfirm]")!.click();
  await tick();
  expect(fetched).toHaveBeenCalledTimes(1);
  const body = (fetched.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1].body;
  expect(body.get("permission-mode")).toBe("bypassPermissions");
  expect(body.get("password")).toBe("pw");
  // Back to Auto needs no password: no prompt.
  render(approval());
  vi.unstubAllGlobals();
});

test("#3: push enrolment posts exactly once, after the password and the subscription, under the pending guard", async () => {
  const keys = { p256dh: "a+b/c=", auth: "d+e/f=" };
  vi.stubGlobal("Notification", { requestPermission: async () => "granted" });
  vi.stubGlobal("PushManager", function PushManager() { /* present */ });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
    register: async () => ({}),
    ready: Promise.resolve({ pushManager: { subscribe: async () => ({ endpoint: "https://push.example/1", toJSON: () => ({ keys }) }) } }),
  } });
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ key: "AAAA" }) })));
  render(alerts());
  new Function(pushScriptOf(FACTS)!)();
  const push = form("push-form");
  expect(push.hasAttribute("data-k-prepare")).toBe(true);
  const posted: Record<string, string>[] = [];
  save("push-form");
  // From here on, a submit that the kit lets through is a post (recorded, not navigated).
  push.requestSubmit = () => { posted.push(Object.fromEntries(new FormData(push) as unknown as Iterable<[string, string]>)); };
  const pop = document.querySelector<HTMLElement>(".k-pop")!;
  pop.querySelector<HTMLInputElement>('input[name="token"]')!.value = "pw";
  pop.querySelector<HTMLButtonElement>("[data-k-sconfirm]")!.click();
  // A second press while the subscription is being made does nothing.
  push.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: push.querySelector<HTMLButtonElement>("[data-k-save]") }));
  await tick(20);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ endpoint: "https://push.example/1", p256dh: "a-b_c", auth: "d-e_f", token: "pw" });
  vi.unstubAllGlobals();
});

test("a form with fields named action and id posts to its own action and keeps its own id (they never shadow the form's)", async () => {
  render(withFormToken("c".repeat(64), () => htmlString(kitSectionForm({ proof: "email", action: "/settings/email", id: "shadowed", hidden: { action: "save", id: "7" }, body: html`<input name="host" value="h">` }))));
  // A real browser's named form properties (happy-dom doesn't draw them): the fields stand in for form.action and form.id.
  const shadow = () => { const it = form("shadowed"); for (const name of ["action", "id"]) Object.defineProperty(it, name, { configurable: true, get: () => it.querySelector(`input[name="${name}"]`) }); };
  shadow();
  const fetched = vi.fn(async (_to: string) => ({ url: `${location.origin}/settings/alerts?said=x`, redirected: true, ok: true, status: 200, text: async () => "" }));
  vi.stubGlobal("fetch", fetched);
  save("shadowed");
  await tick();
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(new URL(String(fetched.mock.calls[0]![0])).pathname).toBe("/settings/email");
  expect(assigned).toEqual(["/settings/alerts?said=x"]);
  // Refused: the refusal slot is the form's own, named by its id attribute.
  render(withFormToken("c".repeat(64), () => htmlString(kitSectionForm({ proof: "email", action: "/settings/email", id: "shadowed", hidden: { action: "save", id: "7" }, body: html`<input name="host" value="h">` }))));
  shadow();
  vi.stubGlobal("fetch", vi.fn(async () => ({ url: `${location.origin}/settings/email`, redirected: false, ok: false, status: 400, text: async () => "<p role=alert>No.</p>" })));
  save("shadowed");
  await tick();
  expect(document.getElementById("shadowed-err")!.textContent).toContain("No.");
  vi.unstubAllGlobals();
});

test("a save that lands on the page already open (only its #anchor differs) loads the page again instead of only scrolling", async () => {
  window.history.replaceState(null, "", "/settings/alerts");
  render(alerts());
  pick('#reach-form input[name="mode"][value="all"]');
  vi.stubGlobal("fetch", vi.fn(async () => ({ url: `${location.origin}/settings/alerts`, redirected: true, ok: true, status: 200, text: async () => "" })));
  save("reach-form");
  await tick();
  expect(assigned).toEqual([]);
  expect(reloads).toBe(1);
  expect(`${location.pathname}${location.hash}`).toBe("/settings/alerts#notifications");
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});
