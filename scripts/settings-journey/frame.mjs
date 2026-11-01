/** Settings revamp S2: the one frame and the settings kit. The frame's own checks on real settings pages (single h1,
 * breadcrumb, the picker naming the open project, no Crew sheet), and the kit's step-up dialog on a kit form drawn by
 * the built helpers (dist/settings-kit.js) beside the real stylesheet. The dialog's POST is caught in the browser
 * (page.route), so nothing reaches the fixture's server: Cancel must post nothing, Confirm must post once with the
 * pressed button and every hidden term, and without JavaScript the field shows inline and Save posts directly. */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./fixture.mjs";

export const about = "One frame on settings pages, and the kit's step-up dialog";
export const fixture = "lived-in";

const dist = name => import(pathToFileURL(join(ROOT, "dist", name)).href);
const KIT_PATH = "/__journey/kit";
const POST_PATH = "/spend/budget";

/** A kit form under the spend-budget row: a typed field with a forced validation error, a pressed button with its own
 * name=value, and hidden terms. Rendered by the built helpers, styled by the console's own sheet. */
async function kitPage() {
  const { stepUpForm, textField, kitSection } = await dist("settings-kit.js");
  const { SETTINGS_KIT_SCRIPT } = await dist("settings-kit-script.js");
  const { withFormToken } = await dist("server/request-context.js");
  const { WORKSPACE_STYLE } = await dist("server/chrome.js");
  const { htmlString } = await dist("html.js");
  const body = withFormToken("journey-csrf", () => kitSection({
    id: "limit", title: "Monthly limit", state: "No limit set.",
    body: stepUpForm({ proof: "spend-budget", action: POST_PATH, id: "limit-form", hidden: { target: "installation:*", nonce: "n-123" },
      save: { label: "Save limit", name: "action", value: "set" },
      body: textField({ id: "limit-usd", name: "usd", label: "Monthly limit in dollars", type: "number", value: "12x", error: "Enter a whole number of dollars." }) }),
  }));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kit</title>
<link rel="stylesheet" href="${WORKSPACE_STYLE.path}"></head><body><main id="workspace-main" class="so-page-content" style="max-width:760px">${htmlString(body)}</main>
<script>${SETTINGS_KIT_SCRIPT}</script></body></html>`;
}

/** Serves the kit page and catches its POST; answers the bodies posted. */
async function serveKit(page, fixture) {
  const posted = [];
  const html = await kitPage();
  await page.route(fixture.base + KIT_PATH, route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
  await page.route(fixture.base + POST_PATH, route => { posted.push(route.request().postData() ?? ""); return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Posted</title><h1>Posted</h1>" }); });
  return posted;
}

const fail = (probe, detail) => [{ probe, detail }];

export const actions = [
  {
    name: "frame-settings",
    async run({ page, goto, shot, probes }) {
      const out = [];
      for (const path of ["/settings/telegram", "/settings/retention", "/people", "/spend", "/mode"]) {
        await goto(path);
        const facts = await page.evaluate(() => ({
          h1: document.querySelectorAll("h1").length,
          crew: document.querySelectorAll("[data-workspace-crew]").length,
          crumbs: [...document.querySelectorAll(".so-workspace-header .kit-crumbs li")].map(li => li.textContent.trim()),
          picker: document.querySelector(".so-project-switch select")?.selectedOptions?.[0]?.textContent ?? null,
        }));
        if (facts.h1 !== 1) out.push({ probe: "one-h1", detail: `${path}: ${facts.h1} h1s` });
        if (facts.crew !== 0) out.push({ probe: "frame", detail: `${path}: the Crew sheet is on a settings page` });
        if (facts.crumbs[0] !== "Settings" || facts.crumbs.length !== 2) out.push({ probe: "frame", detail: `${path}: breadcrumb ${JSON.stringify(facts.crumbs)}` });
        if (facts.picker !== null && facts.picker !== "shop") out.push({ probe: "frame", detail: `${path}: the picker says ${facts.picker}, not the open project` });
        out.push(...await probes.noOverflow(page));
      }
      await shot("telegram");
      return out;
    },
  },
  {
    name: "kit-dialog",
    async run({ page, fixture, shot, probes }) {
      const posted = await serveKit(page, fixture);
      await page.goto(fixture.base + KIT_PATH, { waitUntil: "load" });
      const out = [...await probes.expectFieldError(page)];
      await shot("error");
      // Save opens the dialog: nothing posts, the password field is in it and has focus.
      await page.fill("#limit-usd", "40");
      await page.click("button.kit-save");
      if (!await page.locator("dialog[data-kit-dialog][open]").isVisible()) return [...out, ...fail("kit-dialog", "Save didn't open the dialog")];
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("name"));
      if (focused !== "password") out.push({ probe: "kit-dialog", detail: `focus is on ${focused}, not the password field` });
      await shot("dialog");
      // Cancel closes it, posts nothing, and focus comes back visibly.
      await page.click("[data-kit-cancel]");
      await page.waitForTimeout(150);
      if (await page.locator("dialog[data-kit-dialog][open]").count() > 0) out.push({ probe: "kit-dialog", detail: "Cancel left the dialog open" });
      if (posted.length > 0) out.push({ probe: "kit-dialog", detail: "Cancel posted the form" });
      await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
      out.push(...await probes.focusVisibleNow(page));
      // Confirm with nothing typed asks again and posts nothing.
      await page.click("button.kit-save");
      await page.click("[data-kit-confirm]");
      if (posted.length > 0) out.push({ probe: "kit-dialog", detail: "Confirm with an empty password posted" });
      // Typed, then Enter in the field: one post with the pressed button, the hidden terms, the form token and the
      // password (the dialog's own submit event finishes first, then the form posts with the original button).
      await page.fill("dialog[data-kit-dialog] input[name=password]", "correct-horse-1");
      await page.press("dialog[data-kit-dialog] input[name=password]", "Enter");
      await page.waitForURL(url => url.pathname === POST_PATH, { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(200);
      if (posted.length !== 1) return [...out, ...fail("kit-dialog", `Confirm posted ${posted.length} time(s)`)];
      const sent = new URLSearchParams(posted[0]);
      for (const [name, value] of [["action", "set"], ["target", "installation:*"], ["nonce", "n-123"], ["csrf", "journey-csrf"], ["password", "correct-horse-1"], ["usd", "40"]])
        if (sent.get(name) !== value) out.push({ probe: "kit-dialog", detail: `the post sent ${name}=${sent.get(name)}, not ${value}` });
      // While a post is on its way (slowed here), another Confirm or Save posts nothing more.
      await page.route(fixture.base + POST_PATH, async route => { await new Promise(resolve => setTimeout(resolve, 800)); posted.push(route.request().postData() ?? ""); return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Posted</title><h1>Posted</h1>" }); });
      await page.goto(fixture.base + KIT_PATH, { waitUntil: "load" });
      await page.fill("#limit-usd", "41");
      await page.click("button.kit-save");
      await page.fill("dialog[data-kit-dialog] input[name=password]", "correct-horse-1");
      await page.evaluate(() => {
        const form = document.querySelector("form.kit-form"), save = form.querySelector("button.kit-save");
        form.querySelector("[data-kit-confirm]").click();
        setTimeout(() => { form.querySelector("[data-kit-confirm]").click(); form.requestSubmit(save); }, 100);
      });
      await page.waitForURL(url => url.pathname === POST_PATH, { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(300);
      if (posted.length !== 2) out.push({ probe: "kit-dialog", detail: `a second submit while the first was on its way posted (${posted.length - 1} posts)` });
      return out;
    },
  },
  {
    name: "kit-dialog-nojs",
    noJs: true,
    async run({ page, fixture, shot }) {
      const posted = await serveKit(page, fixture);
      await page.goto(fixture.base + KIT_PATH, { waitUntil: "load" });
      const out = [];
      if (!await page.locator(".kit-form > .kit-proof input[name=password]").isVisible()) out.push({ probe: "kit-dialog", detail: "without JavaScript the password field isn't inline" });
      await shot("inline");
      await page.fill("#limit-usd", "40");
      await page.fill(".kit-form > .kit-proof input[name=password]", "correct-horse-1");
      await Promise.all([page.waitForLoadState("load"), page.click("button.kit-save")]);
      await page.waitForTimeout(200);
      const sent = new URLSearchParams(posted[0] ?? "");
      if (posted.length !== 1 || sent.get("action") !== "set" || sent.get("nonce") !== "n-123" || sent.get("password") !== "correct-horse-1") out.push({ probe: "kit-dialog", detail: `without JavaScript Save posted ${JSON.stringify(posted)}` });
      return out;
    },
  },
];
