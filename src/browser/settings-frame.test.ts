// @vitest-environment happy-dom
/** The settings frame's sidebar (docs/plans/settings-revamp.md S2): a sensitive page keeps the same slots as any other
 * page — the live parts become static text, with no states, no forms and no summary room — and the project picker
 * names the session's open project. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { NO_COUNTS } from "../agent-state-words.js";
import type { BrowserWorkspace } from "../browser-workspace.js";
import { currentProjectOf, Navigation } from "./app.js";
import { SETTINGS_KIT_SCRIPT } from "../settings-kit-script.js";

const shop = { name: "shop", path: "/r/shop", href: "/work?project=%2Fr%2Fshop", knowledgeHref: "/settings/knowledge?repo=%2Fr%2Fshop" };
const ops = { name: "ops", path: "/r/ops", href: "/work?project=%2Fr%2Fops", knowledgeHref: "/settings/knowledge?repo=%2Fr%2Fops" };
const workspace = (over: Partial<BrowserWorkspace>): BrowserWorkspace => ({
  version: 1, path: "/settings/retention", title: "Retention", user: "alex", csrf: "c", sensitive: false, refreshUrl: "/settings/retention", receipt: null,
  projects: [shop, ops], crew: [], crewTruncated: false, conversation: null, focus: null, result: null, catchUpHtml: "", controlsHtml: "", notices: [], pageHtml: "",
  navigation: [{ label: "Settings", href: "/settings", active: true }], openProject: "/r/shop", ...over,
});
const live = workspace({
  projectStates: [{ path: "/r/shop", name: "shop", href: shop.href, state: "needs-you", counts: { ...NO_COUNTS, "needs-you": 2 }, tasks: [], more: 0, asks: [] }],
  fresh: { minutes: 9, forget: "/session/forget-password" },
});
const sensitive = workspace({ sensitive: true });

/** The sidebar's rows outside its live slots, as the journey's probe reads them. */
function rows(markup: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return [...host.querySelectorAll("a[href], summary, button")].filter(el => el.closest("[data-live]") === null)
    .map(el => `${el.tagName.toLowerCase()} ${el.getAttribute("href") ?? ""} ${(el.textContent ?? "").trim()}`);
}

test("a sensitive page keeps the same slots: project names as text, no live states, no forms", () => {
  const ordinary = renderToStaticMarkup(createElement(Navigation, { workspace: live }));
  const quiet = renderToStaticMarkup(createElement(Navigation, { workspace: sensitive }));
  expect(rows(quiet)).toEqual(rows(ordinary));
  // The live slot holds the project names, static, on the sensitive page; the states and counts only on the other.
  expect(quiet).toMatch(/data-live="true" data-sidebar-slot="projects"/);
  expect(quiet).not.toContain("data-project-state=");
  expect(quiet).toContain("so-project-states--inert");
  expect(ordinary).toContain('data-project-state="needs-you"');
  // No form in the sensitive sidebar but sign-out; the remembered-password chip's Forget is only on the other.
  expect(quiet.match(/<form/g)?.length).toBe(1);
  expect(quiet).not.toContain("forget-password");
  expect(ordinary).toContain("forget-password");
});

test("the picker names the open project; a page about another project names that one", () => {
  expect(currentProjectOf(workspace({}))?.name).toBe("shop");
  expect(currentProjectOf(workspace({ path: "/settings/tools?repo=%2Fr%2Fops" }))?.name).toBe("ops");
  expect(currentProjectOf(workspace({ openProject: null }))).toBeUndefined();
  expect(currentProjectOf(workspace({ openProject: "/r/gone" }))).toBeUndefined();
  expect(renderToStaticMarkup(createElement(Navigation, { workspace: sensitive }))).toMatch(/<option value="\/work\?project=%2Fr%2Fshop" selected="">shop<\/option>/);
});

/** The kit's script on a kit form (settings-kit.ts as rendered, minus the server's form token), with posting
 * recorded instead of navigating. */
async function kitForm(): Promise<{ form: HTMLFormElement; posts: { submitter: string | null }[] }> {
  document.documentElement.className = "";
  document.body.innerHTML = `<form method="post" action="/spend/budget" id="limit" class="kit-form" data-kit-form="spend-budget" data-kit-step-up="">
<input type="hidden" name="nonce" value="n-1"><input name="usd" value="40">
<div class="kit-proof" data-kit-proof><label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label></div>
<div class="kit-save-bar" data-kit-save-bar><span data-kit-state data-idle="No changes"></span><button type="submit" class="kit-save" name="action" value="set">Save</button></div>
<dialog class="kit-dialog" data-kit-dialog><div data-kit-slot></div><button type="button" data-kit-cancel>Cancel</button><button type="button" data-kit-confirm>Save</button></dialog></form>`;
  const form = document.querySelector("form")!;
  const posts: { submitter: string | null }[] = [];
  // Whatever submit reaches the page's own listeners un-cancelled is a post (a dispatched event never navigates).
  form.addEventListener("submit", event => { if (!event.defaultPrevented) posts.push({ submitter: (event.submitter as HTMLButtonElement | null)?.value ?? null }); });
  new Function(SETTINGS_KIT_SCRIPT)();
  await new Promise(resolve => setTimeout(resolve, 0));
  return { form, posts };
}
const submitWith = (form: HTMLFormElement, submitter: HTMLElement | null) =>
  form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter }));
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test("kit script: Enter inside the open dialog posts once, after its own submit event, with the original button", async () => {
  const { form, posts } = await kitForm();
  const save = form.querySelector<HTMLButtonElement>(".kit-save")!;
  const sent: (HTMLElement | null | undefined)[] = [];
  form.requestSubmit = (by?: HTMLElement | null) => { sent.push(by); submitWith(form, by ?? null); };
  submitWith(form, save);
  expect(posts).toEqual([]);
  expect(form.querySelector("dialog")!.open).toBe(true);
  form.querySelector<HTMLInputElement>("input[name=password]")!.value = "pw";
  // Implicit submission from the field: the default button is the submitter; the dialog is open.
  const enter = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: save });
  form.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(true);
  expect(sent).toEqual([]); // not re-entered while its own submit event runs
  await tick();
  expect(sent).toEqual([save]);
  expect(posts).toEqual([{ submitter: "set" }]);
});

test("kit script: a posted form stays pending (no timer releases it), so repeats post nothing; showing the page again releases it", async () => {
  const { form, posts } = await kitForm();
  vi.useFakeTimers();
  try {
    const save = form.querySelector<HTMLButtonElement>(".kit-save")!;
    form.requestSubmit = (by?: HTMLElement | null) => { submitWith(form, by ?? null); };
    submitWith(form, save);
    form.querySelector<HTMLInputElement>("input[name=password]")!.value = "pw";
    form.querySelector<HTMLButtonElement>("[data-kit-confirm]")!.click();
    vi.advanceTimersByTime(10);
    expect(posts).toHaveLength(1);
    expect(save.disabled).toBe(true);
    expect(form.querySelector("dialog")!.open).toBe(false);
    // Well past 15 s with the first post still on its way: still pending, and a repeat posts nothing.
    for (const after of [16_000, 60_000]) {
      vi.advanceTimersByTime(after);
      expect(save.disabled, `${after}`).toBe(true);
      const again = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: save });
      form.dispatchEvent(again);
      expect(again.defaultPrevented).toBe(true);
      vi.advanceTimersByTime(10);
      expect(posts).toHaveLength(1);
    }
    window.dispatchEvent(new Event("pageshow"));
    expect(save.disabled).toBe(false);
  } finally { vi.useRealTimers(); }
});

test("kit script: Cancel closes the dialog and posts nothing; an empty password posts nothing", async () => {
  const { form, posts } = await kitForm();
  const save = form.querySelector<HTMLButtonElement>(".kit-save")!;
  form.requestSubmit = (by?: HTMLElement | null) => { submitWith(form, by ?? null); };
  submitWith(form, save);
  form.querySelector<HTMLButtonElement>("[data-kit-cancel]")!.click();
  expect(form.querySelector("dialog")!.open).toBe(false);
  submitWith(form, save);
  form.querySelector<HTMLButtonElement>("[data-kit-confirm]")!.click();
  await tick();
  expect(posts).toEqual([]);
  expect(save.disabled).toBe(false);
});
