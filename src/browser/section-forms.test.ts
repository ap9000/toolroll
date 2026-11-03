// @vitest-environment happy-dom
/**
 * The kit's section forms (browser/kit/section-forms.ts) on the real server markup (settings-groups-ui.ts,
 * settings-kit.ts kitSectionForm): Codex wave D r1 #2–#5. Posting is a mocked fetch or a recorded requestSubmit;
 * a reload is recorded and then played by rendering the page again.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { html, htmlString } from "../html.js";
import { withFormToken } from "../server/request-context.js";
import { alertsGroup, approvalGroup, pushScriptOf, type SettingsFacts } from "../settings-groups-ui.js";
import { installKitBehavior } from "./kit/behavior.js";

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
  sessionStorage.clear();
  vi.spyOn(window.location, "reload").mockImplementation(() => { reloads += 1; });
  vi.spyOn(window.location, "assign").mockImplementation((to: string | URL) => { assigned.push(String(to)); });
});
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

test("#4: saving one section keeps another changed section's draft across the page that follows", async () => {
  render(alerts());
  pick('#reach-form input[name="mode"][value="all"]');
  const pings = document.querySelector<HTMLInputElement>('#mute--r-shop input[name="pings"]')!;
  pings.click();
  pings.dispatchEvent(new Event("change", { bubbles: true }));
  expect(form("reach-form").hasAttribute("data-dirty")).toBe(true);
  expect(form("mute--r-shop").hasAttribute("data-dirty")).toBe(true);
  const fetched = vi.fn(async () => ({ url: `${location.origin}/settings/alerts?said=x`, redirected: true, ok: true, status: 200, text: async () => "" }));
  vi.stubGlobal("fetch", fetched);
  save("mute--r-shop");
  await tick();
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(assigned).toHaveLength(1);
  // The page comes back from the server (Chat messages still "quiet" there): the unsaved choice is back, still changed.
  render(alerts());
  expect(document.querySelector<HTMLInputElement>('#reach-form input[name="mode"][value="all"]')!.checked).toBe(true);
  expect(form("reach-form").hasAttribute("data-dirty")).toBe(true);
  // Kept once: another visit shows the stored values.
  render(alerts());
  expect(form("reach-form").hasAttribute("data-dirty")).toBe(false);
  vi.unstubAllGlobals();
});

test("#2: a post whose answer never arrives is unconfirmed, never 'nothing was saved': the page reloads and says so", async () => {
  render(alerts());
  pick('#reach-form input[name="mode"][value="all"]');
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
  save("reach-form");
  await tick();
  expect(reloads).toBe(1);
  expect(document.body.textContent).not.toContain("nothing was saved");
  render(alerts());
  const note = form("reach-form").querySelector(".k-ssave-err")!.textContent!;
  expect(note).toContain("Couldn’t confirm whether What reaches you saved");
  // A server error after the post (the redirected page failing) is unconfirmed too.
  pick('#reach-form input[name="mode"][value="all"]');
  vi.stubGlobal("fetch", vi.fn(async () => ({ url: `${location.origin}/settings/alerts?said=x`, redirected: true, ok: false, status: 500, text: async () => "" })));
  save("reach-form");
  await tick();
  expect(reloads).toBe(2);
  // A handler's own refusal is a refusal: said in place, the edit kept, no reload.
  vi.stubGlobal("fetch", vi.fn(async () => ({ url: `${location.origin}/settings/alerts?problem=${encodeURIComponent("Choose a mode.")}`, redirected: true, ok: true, status: 200, text: async () => "" })));
  render(alerts());
  pick('#reach-form input[name="mode"][value="all"]');
  save("reach-form");
  await tick();
  expect(reloads).toBe(2);
  expect(form("reach-form").querySelector(".k-ssave-err")!.textContent).toContain("Choose a mode. Your edits are still here.");
  expect(document.querySelector<HTMLInputElement>('#reach-form input[name="mode"][value="all"]')!.checked).toBe(true);
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
