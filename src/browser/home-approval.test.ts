// @vitest-environment happy-dom
/**
 * Approve in place from Home (docs/plans/live-pages-and-home.md B2.1-B2.5). Home reads the selected task as data,
 * never minted; it offers its one Approve only for a one-click plan with no form control on a page that is not a password
 * page; anything else is the plan and one link that loads the task page as its own document. A press mints for exactly
 * what is shown, posts in place with no password field, and a moved digest posts nothing. A late read is dropped, a lost
 * answer is read again (never called a failure), and arrowing through a long list mints nothing. Home never shows a
 * password field. Stubbed fetches only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserHomeRow, BrowserHomeView, BrowserTaskView, BrowserWorkspace } from "../browser-workspace.js";
import { HomeView } from "./views/home-view.js";
import { FormToken } from "./ui/index.js";
import { WORKSPACE_NUDGE } from "./live-task.js";
import { holdsFormControl, postInPlace, REDRAW_HOLD_MS } from "./act.js";
import { SELECTION_SETTLE_MS } from "./views/home-approval.js";

const DIGEST = (n: number) => n.toString(16).padStart(32, "0");
const NONCE = "ab".repeat(16);
const SHEET = '<article class="plan-sheet" data-plan-sheet><p class="plan-sheet-lead">Dedupe the listings.</p></article>';

type Approve = NonNullable<BrowserTaskView["approve"]>;
const approveOf = (id: string, over: Partial<Approve> = {}, fields: Record<string, string> = {}): Approve => ({
  action: `/t/${id}/approve`, fields: { nonce: "unminted", digest: DIGEST(1), ...fields }, label: "Approve", heading: "Plan ready",
  text: "Approving starts the build.", kind: "standard", facts: { passwordless: true, remembered: false }, rememberedUntil: null,
  planHtml: `${SHEET}<details id="plan-editor"><textarea name="goal"></textarea></details>`, sheetHtml: SHEET, ...over });
const workspaceOf = (id: string, approve: Approve | null, over: Partial<BrowserWorkspace> = {}, view: Partial<BrowserTaskView> = {}): BrowserWorkspace => ({
  version: 1, path: `/t/${id}`, title: id, user: "alex", csrf: "csrf-1", sensitive: false, refreshUrl: `/t/${id}`, crewTruncated: false,
  catchUpHtml: "", controlsHtml: "", notices: [], pageHtml: null, navigation: [], projects: [], crew: [], focus: null, result: null, receipt: null,
  conversation: null, view: { kind: "task", id, approve, ...view }, ...over } as unknown as BrowserWorkspace);

const row = (id: string): BrowserHomeRow => ({ id, title: `Task ${id}`, href: `/t/${id}`, project: "shop", age: "4h ago", state: "needs", ask: "approve", reason: null,
  line: "Review the plan and approve it to start.", action: { label: "Approve plan", href: `/t/${id}#approve` }, question: null });
const homeOf = (ids: string[]): BrowserHomeView => ({
  kind: "home", say: `${ids.length} tasks need you`, project: null, scopes: null, counts: [],
  groups: [{ key: "approve", label: "Approve a plan", count: ids.length, rows: ids.map(row) }],
  working: [], finishedToday: { count: 0, rows: [], href: "/tasks" }, newTask: "/tasks/new", ask: null, lastLead: null, empty: null });

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
let calls: Call[] = [];
/** What each request answers: by path, method and read purpose. */
let answer: (call: Call) => Promise<Response> | Response;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const reads = () => calls.filter(one => one.method === "GET");
const minting = () => reads().filter(one => one.headers["x-toolroll-read"] === undefined);
const posts = () => calls.filter(one => one.method === "POST");

let root: Root | null = null;
const mount = async (view: BrowserHomeView) => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(FormToken.Provider, { value: "csrf-1" }, createElement(HomeView, { view }))));
};
const wait = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** Let a selection read land, and the Approve hold run out. */
const settle = async () => { await wait(SELECTION_SETTLE_MS + 10); await wait(REDRAW_HOLD_MS + 10); };
const pane = () => document.querySelector(".so-tri-open")!;
const approveButton = () => pane().querySelector<HTMLButtonElement>("[data-home-approve]");
const press = async () => { await act(async () => { approveButton()!.click(); }); await wait(0); await wait(0); };
const noPasswordField = () => expect(document.querySelector('input[type="password"]')).toBeNull();

beforeEach(() => {
  document.body.innerHTML = "";
  calls = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: Call = { url, method: init.method ?? "GET", headers: { ...(init.headers as Record<string, string> | undefined) }, body: init.body === undefined ? "" : String(init.body) };
    calls.push(call);
    return answer(call);
  }));
  // By default: the selection read is unminted, the press's read mints, and the post is approved.
  answer = call => call.method === "POST" ? json({ outcome: "approved", words: "Approved." })
    : json(workspaceOf(call.url.split("?")[0]!.slice(3), approveOf(call.url.split("?")[0]!.slice(3), {}, call.headers["x-toolroll-read"] === "prefetch" ? {} : { nonce: NONCE })));
});
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("a one-click plan: the plan under the title, the terms line, one ink Approve and one link to the task's chat; read without minting", async () => {
  await mount(homeOf(["a", "b"]));
  noPasswordField();
  // Before the read lands: no Approve.
  expect(approveButton()).toBeNull();
  await settle();
  expect(reads()).toHaveLength(1);
  expect(reads()[0]!.url).toBe("/t/a?format=workspace");
  expect(reads()[0]!.headers["x-toolroll-read"]).toBe("prefetch");
  expect(pane().querySelector("[data-plan-sheet]")?.textContent).toBe("Dedupe the listings.");
  // Only the sheet: never the task page's editor.
  expect(pane().querySelector("textarea, input, select, form")).toBeNull();
  expect(pane().querySelector("[data-home-terms]")?.textContent).toBe("Approving starts the build. No password needed: Passwordless is on for your account.");
  expect(pane().querySelectorAll(".k-btn-primary")).toHaveLength(1);
  expect(approveButton()?.textContent).toBe("Approve");
  expect(pane().querySelector("[data-home-changes]")?.getAttribute("href")).toBe("/chat?task=a");
  expect(pane().querySelector("[data-home-review]")).toBeNull();
  noPasswordField();
});

test("a password ask, a plan with a form control, a password page and an unread task each show the link that loads the task page as a document", async () => {
  const cases: [string, (id: string, call: Call) => Response, boolean][] = [
    ["password", id => json(workspaceOf(id, approveOf(id, { facts: { passwordless: false, remembered: false } }))), true],
    ["form control", id => json(workspaceOf(id, approveOf(id, { sheetHtml: `${SHEET}<form action="/x"><button>Go</button></form>` }))), false],
    ["no sheet", id => json(workspaceOf(id, approveOf(id, { sheetHtml: undefined }))), false],
    ["sensitive", id => json(workspaceOf(id, approveOf(id), { sensitive: true })), true],
    ["prefetch refused (204)", () => new Response(null, { status: 204 }), false],
    ["error", () => new Response("no", { status: 500 }), false],
  ];
  for (const [name, reply, planShown] of cases) {
    answer = call => reply(call.url.split("?")[0]!.slice(3), call);
    await mount(homeOf(["a"]));
    await settle();
    expect(approveButton(), name).toBeNull();
    const link = pane().querySelector<HTMLAnchorElement>("[data-home-review]");
    expect(link?.textContent, name).toBe("Review the plan");
    expect(link?.getAttribute("href"), name).toBe("/t/a");
    expect(link?.hasAttribute("data-full-load"), name).toBe(true);
    expect(pane().querySelector("[data-plan-sheet]") !== null, name).toBe(planShown);
    expect(pane().querySelector("form, button[type=submit]"), name).toBeNull();
    noPasswordField();
    expect(minting(), name).toHaveLength(0);
    await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; calls = [];
  }
  expect(holdsFormControl("<p>Plain</p>")).toBe(false);
  expect(holdsFormControl("<p>a</p><INPUT type=hidden>")).toBe(true);
  expect(holdsFormControl("< textarea>")).toBe(true);
});

test("the press: a minting read, then one post with the form token, that nonce, the digest shown and return=next; never a password", async () => {
  const nudges: Event[] = [];
  window.addEventListener(WORKSPACE_NUDGE, event => nudges.push(event));
  await mount(homeOf(["a", "b"]));
  await settle();
  await press();
  expect(minting().map(one => one.url)).toEqual(["/t/a?format=workspace"]);
  expect(posts()).toHaveLength(1);
  const post = posts()[0]!;
  expect(post.url).toBe("/t/a/approve");
  expect(post.headers["x-toolroll-act"]).toBe("in-place");
  expect(post.headers["accept"]).toBe("application/json");
  expect([...new URLSearchParams(post.body)]).toEqual([["csrf", "csrf-1"], ["nonce", NONCE], ["digest", DIGEST(1)], ["return", "next"]]);
  expect(post.body).not.toContain("token");
  // Approved: the row leaves, the next is selected, "Approved." shows above the list. Home reads itself again only
  // once the row has gone, so a read that lands first cannot leave a still-waiting task hidden.
  expect(document.querySelector("[data-home-approved]")?.textContent).toBe("Approved.");
  expect(document.querySelector('[data-row="a"]')?.classList.contains("so-ti-leave")).toBe(true);
  expect(document.querySelector('[aria-selected="true"]')?.getAttribute("data-row")).toBe("b");
  expect(nudges).toHaveLength(0);
  await wait(250);
  expect(document.querySelector('[data-row="a"]')).toBeNull();
  expect(nudges.length).toBeGreaterThan(0);
  // The line stays until the person selects another row.
  await settle();
  expect(document.querySelector("[data-home-approved]")).not.toBeNull();
  noPasswordField();
});

test("a rebuild named by the snapshot rides the post", async () => {
  answer = call => call.method === "POST" ? json({ outcome: "approved", words: "Approved." })
    : json(workspaceOf("a", approveOf("a", {}, { rebuild: "42", ...(call.headers["x-toolroll-read"] ? {} : { nonce: NONCE }) })));
  await mount(homeOf(["a"]));
  await settle();
  await press();
  expect([...new URLSearchParams(posts()[0]!.body)]).toEqual([["csrf", "csrf-1"], ["nonce", NONCE], ["digest", DIGEST(1)], ["rebuild", "42"], ["return", "next"]]);
});

test("a digest that moved by the press posts nothing: the plan is drawn again, the line says so, and Approve waits", async () => {
  answer = call => call.method === "POST" ? json({ outcome: "approved", words: "Approved." })
    : json(workspaceOf("a", call.headers["x-toolroll-read"] ? approveOf("a") : approveOf("a", { sheetHtml: SHEET.replace("Dedupe", "Rewrite") }, { nonce: NONCE, digest: DIGEST(2) })));
  await mount(homeOf(["a"]));
  await settle();
  await press();
  expect(posts()).toHaveLength(0);
  expect(pane().querySelector("[data-home-changed]")?.textContent).toBe("The plan changed. Read it again.");
  expect(pane().querySelector("[data-plan-sheet]")?.textContent).toBe("Rewrite the listings.");
  // Held after the redraw: a press now does nothing at all.
  await act(async () => { approveButton()!.click(); });
  await wait(0);
  expect(minting()).toHaveLength(1);
  expect(posts()).toHaveLength(0);
  // After the hold, the newer plan is approved only by a new press, for its own digest.
  answer = call => call.method === "POST" ? json({ outcome: "approved", words: "Approved." })
    : json(workspaceOf("a", approveOf("a", {}, { nonce: NONCE, digest: DIGEST(2) })));
  await wait(REDRAW_HOLD_MS + 10);
  await press();
  expect(new URLSearchParams(posts()[0]!.body).get("digest")).toBe(DIGEST(2));
});

test("a password ask found at the press posts nothing and turns into the link", async () => {
  answer = call => json(workspaceOf("a", call.headers["x-toolroll-read"] ? approveOf("a") : approveOf("a", { facts: { passwordless: false, remembered: false } }, { nonce: NONCE })));
  await mount(homeOf(["a"]));
  await settle();
  await press();
  expect(posts()).toHaveLength(0);
  expect(approveButton()).toBeNull();
  expect(pane().querySelector("[data-home-review]")?.hasAttribute("data-full-load")).toBe(true);
  noPasswordField();
});

test("a late selection response is dropped: the pane shows the row selected now", async () => {
  let releaseA: (response: Response) => void = () => undefined;
  answer = call => call.url.startsWith("/t/a") ? new Promise<Response>(done => { releaseA = done; })
    : json(workspaceOf("b", approveOf("b", { sheetHtml: SHEET.replace("Dedupe", "Second") })));
  await mount(homeOf(["a", "b"]));
  await wait(SELECTION_SETTLE_MS + 10);
  await act(async () => document.querySelector<HTMLAnchorElement>('[data-row="b"]')!.click());
  await settle();
  expect(pane().querySelector("[data-plan-sheet]")?.textContent).toBe("Second the listings.");
  await act(async () => { releaseA(json(workspaceOf("a", approveOf("a")))); });
  await wait(0);
  expect(pane().querySelector("[data-plan-sheet]")?.textContent).toBe("Second the listings.");
  expect(pane().querySelector("[data-home-changes]")?.getAttribute("href")).toBe("/chat?task=b");
});

test("arrowing through 600 rows mints nothing and reads only where the selection settles", async () => {
  const ids = Array.from({ length: 600 }, (_, n) => `r${n}`);
  await mount(homeOf(ids));
  const list = document.querySelector<HTMLElement>(".so-tri-list")!;
  for (let n = 0; n < 599; n++) await act(async () => { list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  await settle();
  expect(document.querySelector('[aria-selected="true"]')?.getAttribute("data-row")).toBe("r599");
  expect(minting()).toHaveLength(0);
  expect(posts()).toHaveLength(0);
  expect(reads().every(one => one.headers["x-toolroll-read"] === "prefetch")).toBe(true);
  expect(reads().length).toBeLessThanOrEqual(2);
  noPasswordField();
});

test("a refusal says the server's words and that nothing changed, and the task is read again", async () => {
  answer = call => call.method === "POST" ? json({ outcome: "refused", words: "that approval form is stale — read it again" }, 409)
    : json(workspaceOf("a", approveOf("a", {}, call.headers["x-toolroll-read"] ? {} : { nonce: NONCE })));
  await mount(homeOf(["a"]));
  await settle();
  const before = reads().length;
  await press();
  await wait(0);
  expect(pane().querySelector("[data-home-said]")?.textContent).toBe("That approval form is stale — read it again. Nothing changed.");
  expect(reads().length).toBeGreaterThan(before + 1);
  expect(reads().at(-1)!.headers["x-toolroll-read"]).toBe("prefetch");
  expect(document.querySelector('[data-row="a"]')).not.toBeNull();
  noPasswordField();
});

test("a vote and an approval that did not rebuild show the server's words in the pane", async () => {
  for (const [outcome, words] of [["vote", "your yes is recorded — one more approver is needed"], ["approved-not-rebuilt", "Approved, but building again didn't start (busy). Use Build again."]] as const) {
    answer = call => call.method === "POST" ? json({ outcome, words })
      : json(workspaceOf("a", approveOf("a", {}, call.headers["x-toolroll-read"] ? {} : { nonce: NONCE })));
    await mount(homeOf(["a"]));
    await settle();
    await press();
    expect(pane().querySelector("[data-home-said]")?.textContent, outcome).toBe(words.charAt(0).toUpperCase() + words.slice(1).replace(/([^.])$/, "$1."));
    expect(document.querySelector("[data-home-approved]"), outcome).toBeNull();
    await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; calls = [];
  }
});

test("no answer is never called a failure: Checking…, the task read again, and what it now says", async () => {
  // The post is lost; the task, read again, has been approved.
  let approvedNow = false;
  answer = call => {
    if (call.method === "POST") { approvedNow = true; return Promise.reject(new TypeError("network")); }
    const prefetch = call.headers["x-toolroll-read"] === "prefetch";
    return json(workspaceOf("a", approvedNow && prefetch ? null : approveOf("a", {}, prefetch ? {} : { nonce: NONCE }), {}, approvedNow ? { approved: { by: "alex", at: "2026-11-10T10:00:00.000Z", automatic: false, rule: null, how: "", version: "abc" } } : {}));
  };
  await mount(homeOf(["a", "b"]));
  await settle();
  await press();
  await wait(0);
  expect(document.body.textContent).not.toMatch(/fail/i);
  expect(document.querySelector("[data-home-approved]")?.textContent).toBe("Approved.");
  expect(document.querySelector('[aria-selected="true"]')?.getAttribute("data-row")).toBe("b");

  // Lost again, and the task still waits: it says so, and Approve comes back only once that read landed.
  await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; calls = [];
  let releaseRead: (response: Response) => void = () => undefined;
  let lost = false;
  answer = call => {
    if (call.method === "POST") { lost = true; return new Response("{", { status: 200, headers: { "content-type": "application/json" } }); }
    if (lost && call.headers["x-toolroll-read"] === "prefetch") return new Promise<Response>(done => { releaseRead = done; });
    return json(workspaceOf("a", approveOf("a", {}, call.headers["x-toolroll-read"] ? {} : { nonce: NONCE })));
  };
  await mount(homeOf(["a"]));
  await settle();
  await press();
  expect(pane().querySelector("[data-home-said]")?.textContent).toBe("Checking…");
  expect(approveButton()?.getAttribute("aria-disabled")).toBe("true");
  await act(async () => { approveButton()!.click(); });
  expect(posts()).toHaveLength(1);
  await act(async () => { releaseRead(json(workspaceOf("a", approveOf("a")))); });
  await wait(0);
  expect(pane().querySelector("[data-home-said]")?.textContent).toBe("Not approved yet: it still waits for your approval.");
  expect(document.body.textContent).not.toMatch(/fail/i);
  noPasswordField();
});

test("an answer that is not the route's own (signed out, a refused key) loads the task page as a document", async () => {
  const assign = vi.fn();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
  answer = call => call.method === "POST" ? new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } })
    : json(workspaceOf("a", approveOf("a", {}, call.headers["x-toolroll-read"] ? {} : { nonce: NONCE })));
  await mount(homeOf(["a"]));
  await settle();
  await press();
  expect(assign).toHaveBeenCalledWith("/t/a");
});

test("postInPlace reads only the route's exact answer", async () => {
  const send = (response: Response | Error) => postInPlace({ action: "/t/a/approve", digest: DIGEST(1), rebuild: null }, "c", NONCE,
    (async () => { if (response instanceof Error) throw response; return response; }) as typeof fetch);
  expect(await send(json({ outcome: "approved", words: "Approved." }))).toEqual({ kind: "answer", outcome: "approved", words: "Approved." });
  expect(await send(json({ outcome: "refused", words: "no" }, 403))).toEqual({ kind: "answer", outcome: "refused", words: "no" });
  // A kept yes is only ever a 200.
  expect(await send(json({ outcome: "approved", words: "Approved." }, 500))).toEqual({ kind: "elsewhere" });
  expect(await send(json({ outcome: "done", words: "x" }))).toEqual({ kind: "elsewhere" });
  expect(await send(new Response("<p>x</p>", { status: 403, headers: { "content-type": "text/html" } }))).toEqual({ kind: "elsewhere" });
  expect(await send(new TypeError("network"))).toEqual({ kind: "lost" });
  expect(await send(new Response("{", { status: 200, headers: { "content-type": "application/json" } }))).toEqual({ kind: "lost" });
});

test("a click a script made approves nothing: no read is minted and nothing is posted; a press the browser raised approves", async () => {
  await mount(homeOf(["a", "b"]));
  await settle();
  // What every browser says of a click: `isTrusted` false for `button.click()` and a dispatched event, true for a press.
  const click = (trusted: boolean) => Object.defineProperty(new MouseEvent("click", { bubbles: true, cancelable: true }), "isTrusted", { value: trusted });
  await act(async () => { approveButton()!.dispatchEvent(click(false)); });
  await wait(0); await wait(0);
  expect(minting()).toHaveLength(0);
  expect(posts()).toHaveLength(0);
  expect(document.querySelector("[data-home-approved]")).toBeNull();
  expect(document.querySelector('[data-row="a"]')).not.toBeNull();
  await act(async () => { approveButton()!.dispatchEvent(click(true)); });
  await wait(0); await wait(0);
  expect(minting()).toHaveLength(1);
  expect(posts()).toHaveLength(1);
  expect(document.querySelector("[data-home-approved]")?.textContent).toBe("Approved.");
  noPasswordField();
});

test("an answer that lands after the selection moved touches nothing in the pane shown now: no words, no plan of the old task, no load, no Approved", async () => {
  const assign = vi.fn();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
  const late: Array<[string, () => Response]> = [
    ["refused", () => json({ outcome: "refused", words: "that approval form is stale — read it again" }, 409)],
    ["elsewhere", () => new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } })],
    ["approved", () => json({ outcome: "approved", words: "Approved." })],
    ["vote", () => json({ outcome: "vote", words: "your yes is recorded — one more approver is needed" })],
    ["lost", () => new Response("{", { status: 200, headers: { "content-type": "application/json" } })],
  ];
  for (const [name, respond] of late) {
    let release: (response: Response) => void = () => undefined;
    answer = call => {
      if (call.method === "POST") return new Promise<Response>(done => { release = done; });
      const id = call.url.split("?")[0]!.slice(3);
      const sheet = id === "b" ? SHEET.replace("Dedupe", "Second") : SHEET;
      return json(workspaceOf(id, approveOf(id, { sheetHtml: sheet }, call.headers["x-toolroll-read"] === "prefetch" ? {} : { nonce: NONCE })));
    };
    let nudges = 0;
    const nudged = () => { nudges += 1; };
    window.addEventListener(WORKSPACE_NUDGE, nudged);
    await mount(homeOf(["a", "b"]));
    await settle();
    await press();
    expect(posts(), name).toHaveLength(1);
    expect(posts()[0]!.url, name).toBe("/t/a/approve");
    // The person moves to B while A's answer is on its way.
    await act(async () => document.querySelector<HTMLAnchorElement>('[data-row="b"]')!.click());
    await settle();
    expect(pane().querySelector("[data-plan-sheet]")?.textContent, name).toBe("Second the listings.");
    const readsBefore = reads().length;
    await act(async () => { release(respond()); });
    await wait(0); await wait(0);
    // B's pane is B's: its title, its plan, its own Approve ready, nothing said, nothing read for A, no page loaded.
    expect(document.querySelector('[aria-selected="true"]')?.getAttribute("data-row"), name).toBe("b");
    expect(pane().querySelector(".so-open-t")?.textContent, name).toBe("Task b");
    expect(pane().querySelector("[data-plan-sheet]")?.textContent, name).toBe("Second the listings.");
    expect(pane().querySelector("[data-home-said]"), name).toBeNull();
    expect(pane().querySelector("[data-home-changed]"), name).toBeNull();
    expect(document.querySelector("[data-home-approved]"), name).toBeNull();
    expect(approveButton()?.getAttribute("aria-disabled"), name).toBeNull();
    expect(reads().slice(readsBefore).filter(one => one.url.startsWith("/t/a")), name).toHaveLength(0);
    expect(assign, name).not.toHaveBeenCalled();
    // Home is told to read its list again: where A stands is the list's to say.
    expect(nudges, name).toBe(1);
    expect(posts(), name).toHaveLength(1);
    window.removeEventListener(WORKSPACE_NUDGE, nudged);
    await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; calls = [];
  }
});
