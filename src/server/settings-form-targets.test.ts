/**
 * Every form on every Settings page posts where it should (0.9.87: section-forms read `form.action`, which a hidden
 * field named "action" shadows, and some saves went to "/settings/[object HTMLInputElement]"). Each GET page under
 * /settings, /mode, /people, /spend and /models is rendered by the real server in a fixture world, signed in as the
 * operator with the project open. For each <form>, and each button with its own formaction, the effective target (the
 * attribute, resolved against the page) must be a route the route table declares for the form's method. Then the
 * kit's section-forms code must compute that same target with fields named action, id, method, submit and elements
 * added, standing in for a real browser's named form properties (happy-dom doesn't draw them).
 */
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import { openQuietWorld, type QuietWorld } from "../../test/quiet-world.js";
import { ROUTES, matchRoute } from "./route-table.js";

const SETTINGS = /^\/(settings|mode|people|spend|models)(\/|\?|$)/;
const CLOBBERS = ["action", "id", "method", "submit", "elements"] as const;

let world: QuietWorld, cookie: string;
beforeAll(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("no network in this test"); });
  world = await openQuietWorld(() => {});
  ({ cookie } = await world.signIn());
});
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await world.close(); });

/** The same form, as a real browser shows it: a field named like a form property shadows that property. */
function clobber(form: HTMLFormElement): void {
  for (const name of CLOBBERS) {
    const field = form.ownerDocument.createElement("input");
    field.type = "hidden"; field.name = name; field.value = `clobbered-${name}`;
    form.append(field);
    Object.defineProperty(form, name, { configurable: true, get: () => field });
  }
}

test("every Settings form posts to a declared route with its method, and the kit computes the same target under clobbering", async () => {
  const project = encodeURIComponent(world.repo);
  const paths = [...new Set([
    ...ROUTES.filter(row => row.method !== "POST" && row.stage === "console" && SETTINGS.test(row.sample)).map(row => row.sample),
    // The project-scoped sections, with the project named.
    ...["pull-requests", "knowledge", "tools", "project", "skills", "learning", "flows"].map(one => `/settings/${one}?repo=${project}`),
    // Spend's limit form, open: its buttons post a field named "action" (the shadowing case itself).
    "/spend?edit=new",
  ])];
  expect(paths.length).toBeGreaterThan(30);
  const wrong: string[] = [];
  const rendered: string[] = [];
  let forms = 0, clobbered = 0;
  const targets = new Set<string>();
  for (const path of paths) {
    const answer = await world.send(path, "GET", { cookie });
    if (answer.status !== 200 || !String(answer.headers["content-type"] ?? "").includes("text/html")) continue;
    rendered.push(path);
    const page = `${world.origin}${path}`;
    const win = new Window({ url: page });
    try {
      // Markup only: page scripts never run here. The page's data (the workspace JSON) carries the same sections as
      // HTML the browser draws; every such string with a form in it is drawn too.
      const data = /<script type="application\/json" id="standing-orders-workspace-data"[^>]*>([\s\S]*?)<\/script>/.exec(answer.body)?.[1];
      const drawn: string[] = [];
      const walk = (value: unknown): void => {
        if (typeof value === "string") { if (/<form\b/i.test(value)) drawn.push(value); }
        else if (Array.isArray(value)) value.forEach(walk);
        else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
      };
      if (data !== undefined) walk(JSON.parse(data));
      win.document.body.innerHTML = answer.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "") + drawn.map(one => `<div data-from-data>${one}</div>`).join("");
      vi.stubGlobal("window", win); vi.stubGlobal("document", win.document);
      vi.stubGlobal("HTMLFormElement", win.HTMLFormElement); vi.stubGlobal("HTMLButtonElement", win.HTMLButtonElement);
      const { actionOf } = await import("../browser/kit/section-forms.js");
      for (const form of Array.from(win.document.querySelectorAll("form")) as unknown as HTMLFormElement[]) {
        forms += 1;
        targets.add(`${(form.getAttribute("method") ?? "get").toUpperCase()} ${new URL(form.getAttribute("action") ?? "", page).pathname}`);
        const method = (form.getAttribute("method") ?? "get").toUpperCase();
        const target = new URL(form.getAttribute("action") ?? "", page);
        const label = `${path}: <form${form.getAttribute("id") ? ` id="${form.getAttribute("id")}"` : ""} action="${form.getAttribute("action")}" method="${method}">`;
        if (method !== "GET" && method !== "POST") wrong.push(`${label}: method ${method}`);
        if (target.origin !== world.origin) wrong.push(`${label}: leaves the console (${target.href})`);
        else if (matchRoute(method, target.pathname) === null) wrong.push(`${label}: no ${method} route for ${target.pathname}`);
        if (target.pathname.includes("[object")) wrong.push(`${label}: ${target.pathname}`);
        const buttons = (Array.from(form.querySelectorAll("button[formaction]")) as unknown as HTMLButtonElement[]);
        for (const button of buttons) {
          const own = new URL(button.getAttribute("formaction") ?? "", page);
          const ownMethod = (button.getAttribute("formmethod") ?? method).toUpperCase();
          if (own.origin !== world.origin || matchRoute(ownMethod, own.pathname) === null) wrong.push(`${label}: button formaction ${own.href} (${ownMethod}) isn't a route`);
        }
        // What the kit's section forms post to, with every property a field could shadow shadowed.
        clobber(form);
        clobbered += 1;
        expect(form.action as unknown, label).toBeInstanceOf(win.HTMLInputElement);
        if (actionOf(form, null) !== target.href) wrong.push(`${label}: the kit posts to ${actionOf(form, null)}, not ${target.href}`);
        for (const button of buttons) {
          const own = new URL(button.getAttribute("formaction") ?? "", page).href;
          if (actionOf(form, button) !== own) wrong.push(`${label}: the kit posts the button's press to ${actionOf(form, button)}, not ${own}`);
        }
      }
    } finally {
      vi.unstubAllGlobals();
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("no network in this test"); });
      await win.happyDOM.close();
    }
  }
  expect(wrong).toEqual([]);
  // The pages really rendered and carried their forms (no redirect or refusal hid them).
  for (const one of ["/settings", "/settings/alerts", "/settings/models", "/settings/lead", "/mode", "/people", "/spend", "/spend?edit=new", "/settings/tools"]) expect(rendered, one).toContain(one);
  expect(forms).toBeGreaterThan(100);
  // Among them, the forms that carry a field named "action" (the 0.9.87 case) and the kit's own section forms.
  for (const one of ["POST /spend/budget", "POST /settings/notifications", "POST /settings/email", "POST /people/invite", "POST /mode/confirm", "POST /settings/models/agent"]) expect([...targets], one).toContain(one);
  expect(clobbered).toBe(forms);
});
