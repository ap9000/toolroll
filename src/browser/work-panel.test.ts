// @vitest-environment happy-dom
/**
 * Acts in Work's panel (the one-workspace plan S2a, "Approval safety in the panel" criteria 1-6), first as Home had them
 * (docs/plans/live-pages-and-home.md B2.1-B2.5). Work reads the selected task as data,
 * never minted; it offers its one Approve only for a one-click plan with no form control on a page that is not a password
 * page; anything else is the plan and one link that loads the task page as its own document. A press mints for exactly
 * what is shown, posts in place with no password field, and a moved digest posts nothing. A late read is dropped, a lost
 * answer is read again (never called a failure), and arrowing through a long list mints nothing. Home never shows a
 * password field. Stubbed fetches only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserHomeRow, BrowserTasksView, BrowserTaskView, BrowserWorkspace, BrowserWorkView } from "../browser-workspace.js";
import { forgetPendingActs, WorkView } from "./views/work-view.js";
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
const resultRow = (id: string): BrowserHomeRow => ({ ...row(id), ask: "review", group: "review", line: "Checks passed. Review the change, then accept it.", action: { label: "Open result", href: `/t/${id}?tab=result&run=7` } });
const listOf = (needs: number): BrowserTasksView => ({
  kind: "tasks", layout: "list", tabs: [{ key: "needs-you", label: "Needs you", href: "/?view=needs-you", count: needs, active: false }, { key: "all", label: "All", href: "/", count: needs, active: true }],
  projects: null, layouts: { list: "/", board: "/?view=board" }, needsYou: needs, groups: null, rows: [], empty: null, pages: { first: null, next: null }, tools: [],
  newTask: { label: "New task", href: "/tasks/new" }, limits: null });
/** Work with these rows under Decide (plans) and, after them, these under Review (results). */
const homeOf = (ids: string[], review: string[] = []): BrowserWorkView => ({
  kind: "work", list: listOf(ids.length + review.length), project: null, projectName: "All projects", setup: null, empty: null, needsCount: ids.length + review.length,
  needs: [...(ids.length === 0 ? [] : [{ key: "decide" as const, label: "Decide", count: ids.length, rows: ids.map(row) }]),
    ...(review.length === 0 ? [] : [{ key: "review" as const, label: "Review", count: review.length, rows: review.map(resultRow) }])] });

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
let calls: Call[] = [];
/** What each request answers: by path, method and read purpose. */
let answer: (call: Call) => Promise<Response> | Response;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const reads = () => calls.filter(one => one.method === "GET");
const taskOf = (workspace: BrowserWorkspace) => workspace.view as BrowserTaskView;
const minting = () => reads().filter(one => one.headers["x-toolroll-read"] === undefined);
const posts = () => calls.filter(one => one.method === "POST");

let root: Root | null = null;
const mount = async (view: BrowserWorkView) => {
  window.history.replaceState(null, "", "/");
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(FormToken.Provider, { value: "csrf-1" }, createElement(WorkView, { view }))));
};
const wait = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** Let a selection read land, and the Approve hold run out. */
const settle = async () => { await wait(SELECTION_SETTLE_MS + 10); await wait(REDRAW_HOLD_MS + 10); };
const pane = () => document.querySelector("[data-work-panel]")!;
const selectedRow = () => document.querySelector("[data-row][data-selected]")?.getAttribute("data-row");
const said = () => document.querySelector("[data-work-said]")?.textContent ?? null;
const approveButton = () => pane().querySelector<HTMLButtonElement>("[data-home-approve]");
const press = async () => { await act(async () => { approveButton()!.click(); }); await wait(0); await wait(0); };
const noPasswordField = () => expect(document.querySelector('input[type="password"]')).toBeNull();

beforeEach(() => {
  document.body.innerHTML = "";
  // A selection lives in the address (`?task=`), a pending act outside the panel: every test starts clean on Work.
  window.history.replaceState(null, "", "/");
  forgetPendingActs();
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
  expect(said()).toBe("Task a Approved.");
  expect(document.querySelector('[data-row="a"]')?.classList.contains("so-ti-leave")).toBe(true);
  expect(selectedRow()).toBe("b");
  expect(nudges).toHaveLength(0);
  await wait(250);
  expect(document.querySelector('[data-row="a"]')).toBeNull();
  expect(nudges.length).toBeGreaterThan(0);
  // The line stays until the person selects another row.
  await settle();
  expect(said()).not.toBeNull();
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
  expect(selectedRow()).toBe("r599");
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
    expect(said(), outcome).toBeNull();
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
  expect(said()).toBe("Task a Approved.");
  expect(selectedRow()).toBe("b");

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
  expect(said()).toBeNull();
  expect(document.querySelector('[data-row="a"]')).not.toBeNull();
  await act(async () => { approveButton()!.dispatchEvent(click(true)); });
  await wait(0); await wait(0);
  expect(minting()).toHaveLength(1);
  expect(posts()).toHaveLength(1);
  expect(said()).toBe("Task a Approved.");
  noPasswordField();
});

test("an answer that lands after the selection moved touches nothing in the pane shown now, and is said against its own task", async () => {
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
    expect(selectedRow(), name).toBe("b");
    expect(pane().querySelector(".so-open-t")?.textContent, name).toBe("Task b");
    expect(pane().querySelector("[data-plan-sheet]")?.textContent, name).toBe("Second the listings.");
    expect(pane().querySelector("[data-home-said]"), name).toBeNull();
    expect(pane().querySelector("[data-home-changed]"), name).toBeNull();
    // What became of A is said above the list, against A (criterion 4), never in B's pane.
    expect(said(), name).toMatch(/^Task a /);
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

// ---- Accept and Send back in the panel (criteria 1-6 for a result) ------------------------------------------------

const RECEIPT = "cd".repeat(32);
const REQUEST = (n: number) => n.toString(16).padStart(32, "0");
type Selected = NonNullable<BrowserTaskView["result"]>["selected"];
/** A task whose current result waits: accepting it is its one act and it is ready; Send back is beside it. */
const resultOf = (id: string, over: { revision?: string; receipt?: string; youCheck?: boolean; sensitive?: boolean; request?: number; accept?: boolean; batch?: string;
  attention?: string[]; limits?: string[]; mismatch?: Selected["mismatch"]; problem?: string | null; complete?: boolean; build?: number } = {}): BrowserWorkspace => {
  const selected = {
    taskId: id, title: `Task ${id}`, project: "shop", build: over.build ?? 7, taskHref: `/t/${id}`, chatHref: `/chat?task=${id}`, status: { label: "Ready for review", tone: "ready", token: "ready" },
    problem: over.problem ?? null, next: null, decision: { label: "Accept", ready: true, why: null, effect: "", sentence: "" }, checks: { detail: "Checks passed.", problem: false, logHref: null },
    mismatch: over.mismatch ?? null, acts: { primary: over.complete ? null : over.accept === false ? "request-changes" : "accept", secondary: "request-changes", line: null }, runChecks: null, record: null, intent: null, noRun: null, notes: [],
    complete: over.accept === false || over.complete ? null : { action: `/t/${id}/complete`, receipt: over.receipt ?? RECEIPT, run: 7, accept: null },
    panel: { outcome: "Rounds every line at cent precision.", attention: over.attention ?? ["Older payouts are not recomputed."], limits: over.limits ?? [], youCheck: over.youCheck ? { lines: [], items: [{ id: "c1" }], accept: null } : null,
      sendBack: { action: "/r/7/comment", batch: over.batch ?? "", source: "s1", request: REQUEST(over.request ?? 1) } },
  } as unknown as Selected;
  const status = over.complete ? { token: "assignment-complete", tone: "done", label: "Complete", status: { headline: "Complete", sentence: "Accepted." } } : null;
  return workspaceOf(id, null, over.sensitive ? { sensitive: true } : {}, { title: `Task ${id}`, status, result: { selected, current: true, attempts: [], revision: over.revision ?? "r1" } } as Partial<BrowserTaskView>);
};
const acceptButton = () => pane().querySelector<HTMLButtonElement>("[data-work-accept]");
const pressAccept = async () => { await act(async () => { acceptButton()!.click(); }); await wait(0); await wait(0); };
const typeNote = async (text: string) => {
  const box = pane().querySelector<HTMLTextAreaElement>("[data-work-send-back] textarea")!;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { set.call(box, text); box.dispatchEvent(new Event("input", { bubbles: true })); });
};

test("a ready result: its state, outcome, caveat and checks are on screen before Accept, which posts exactly the receipt read, in place, after reading the task again", async () => {
  answer = call => call.method === "POST" ? json({ outcome: "done", words: "Accepted. The task is complete." }) : json(resultOf(call.url.split("?")[0]!.slice(3)));
  await mount(homeOf([], ["a", "b"]));
  await settle();
  expect(pane().querySelector("[data-work-outcome]")?.textContent).toBe("Rounds every line at cent precision.");
  expect(pane().querySelector("[data-work-caveat]")?.textContent).toBe("Older payouts are not recomputed.");
  expect(pane().querySelector("[data-work-checks]")?.textContent).toBe("Checks passed.");
  expect(reads().every(one => one.headers["x-toolroll-read"] === "prefetch")).toBe(true);
  const before = reads().length;
  await pressAccept();
  // Read again (never minted) before the post, then one post of exactly the pinned terms.
  expect(reads().length).toBe(before + 1);
  expect(minting()).toHaveLength(0);
  expect(posts()).toHaveLength(1);
  const post = posts()[0]!;
  expect(post.url).toBe("/t/a/complete");
  expect(post.headers["x-toolroll-act"]).toBe("in-place");
  expect([...new URLSearchParams(post.body)]).toEqual([["csrf", "csrf-1"], ["receipt", RECEIPT], ["run", "7"]]);
  expect(said()).toBe("Task a Accepted. The task is complete.");
  expect(selectedRow()).toBe("b");
  noPasswordField();
});

test("the agent's report and a person's words read in the panel after the caveats and before Accept, as text (S5)", async () => {
  const reported = (id: string) => {
    const workspace = resultOf(id);
    const selected = taskOf(workspace).result!.selected as Selected & { agentReport: unknown; youSaid: unknown };
    selected.agentReport = { decisions: ["Rounded in settle()."], assumptions: [], notDone: [], risks: ["<img src=x onerror=alert(1)> old payouts"] };
    selected.youSaid = [{ kind: "sent-back", author: "robin", you: false, at: "2026-11-14T09:00:00.000Z", note: "Round half up." }];
    return workspace;
  };
  answer = call => json(reported(call.url.split("?")[0]!.slice(3)));
  await mount(homeOf([], ["a"]));
  await settle();
  const report = pane().querySelector<HTMLElement>("[data-agent-report]")!;
  expect(report).not.toBeNull();
  const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  expect(before(pane().querySelector("[data-work-caveat]")!, report)).toBe(true);
  expect(before(report, acceptButton()!)).toBe(true);
  expect(report.querySelector('[data-agent-says="Risk"]')?.textContent).toContain("<img src=x onerror=alert(1)> old payouts");
  expect(report.querySelector("img, a")).toBeNull();
  expect(report.querySelector("[data-you-said]")?.textContent).toContain("robin ·");
});

test("a result that changed by the press posts nothing: the new terms are drawn, the line says so, and Accept waits", async () => {
  let pressed = false;
  answer = call => call.method === "POST" ? json({ outcome: "done", words: "Accepted." }) : json(resultOf("a", pressed ? { revision: "r2", receipt: "ef".repeat(32) } : {}));
  await mount(homeOf([], ["a"]));
  await settle();
  pressed = true;
  await pressAccept();
  expect(posts()).toHaveLength(0);
  expect(pane().querySelector("[data-work-changed]")?.textContent).toBe("The result changed. Read it again.");
  expect(acceptButton()?.getAttribute("aria-disabled")).toBe("true");
  await act(async () => { acceptButton()!.click(); });
  await wait(0);
  expect(posts()).toHaveLength(0);
  // After the hold, the newer result is accepted only by a new press, for its own receipt.
  await wait(REDRAW_HOLD_MS + 10);
  await pressAccept();
  expect(new URLSearchParams(posts()[0]!.body).get("receipt")).toBe("ef".repeat(32));
});

test("no in-place Accept on a password page, with a check of the person's own still open, or for a run that isn't this task's: the link loads the task page as a document", async () => {
  for (const [name, read] of [["sensitive", resultOf("a", { sensitive: true })], ["open check", resultOf("a", { youCheck: true, accept: true })]] as const) {
    answer = () => json(read);
    await mount(homeOf([], ["a"]));
    await settle();
    if (name === "sensitive") {
      expect(acceptButton(), name).toBeNull();
      expect(pane().querySelector("[data-work-review]")?.hasAttribute("data-full-load"), name).toBe(true);
    } else expect(acceptButton(), name).toBeNull();
    noPasswordField();
    await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; calls = [];
  }
  // A read whose complete route isn't this task's own is no snapshot at all.
  const foreign = resultOf("a");
  (taskOf(foreign).result!.selected.complete as { action: string }).action = "/t/b/complete";
  (taskOf(foreign).result!.selected.panel as { sendBack: unknown }).sendBack = null;
  answer = () => json(foreign);
  await mount(homeOf([], ["a"]));
  await settle();
  expect(acceptButton()).toBeNull();
  expect(posts()).toHaveLength(0);
});

test("Send back posts the note with the diff it was shown and the fresh read's request token, and no saved notes; a changed result posts nothing", async () => {
  let reads_ = 0;
  answer = call => call.method === "POST" ? json({ outcome: "done", words: "Sent back. The revision is filed." }) : json(resultOf("a", { request: ++reads_ }));
  await mount(homeOf([], ["a"]));
  await settle();
  await typeNote("Round half-cents up.");
  await act(async () => { pane().querySelector<HTMLFormElement>("[data-work-send-back]")!.requestSubmit(); });
  await wait(0); await wait(0);
  expect(posts()).toHaveLength(1);
  expect(posts()[0]!.url).toBe("/r/7/comment");
  expect(posts()[0]!.headers["x-toolroll-act"]).toBe("in-place");
  expect([...new URLSearchParams(posts()[0]!.body)]).toEqual([["csrf", "csrf-1"], ["intent", "revise"], ["batch", ""], ["source", "s1"], ["request", REQUEST(2)], ["note", "Round half-cents up."]]);
  expect(said()).toBe("Task a Sent back. The revision is filed.");

  await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; calls = [];
  let pressed = false;
  answer = call => call.method === "POST" ? json({ outcome: "done", words: "x" }) : json(resultOf("a", pressed ? { revision: "r2" } : {}));
  await mount(homeOf([], ["a"]));
  await settle();
  await typeNote("Round half-cents up.");
  pressed = true;
  await act(async () => { pane().querySelector<HTMLFormElement>("[data-work-send-back]")!.requestSubmit(); });
  await wait(0); await wait(0);
  expect(posts()).toHaveLength(0);
  expect(pane().querySelector("[data-work-changed]")).not.toBeNull();
});

test("an Accept answered after the selection moved: B's pane is untouched and A's outcome is said against A", async () => {
  let release: (response: Response) => void = () => undefined;
  answer = call => call.method === "POST" ? new Promise<Response>(done => { release = done; }) : json(resultOf(call.url.split("?")[0]!.slice(3)));
  await mount(homeOf([], ["a", "b"]));
  await settle();
  await pressAccept();
  expect(posts().map(one => one.url)).toEqual(["/t/a/complete"]);
  await act(async () => document.querySelector<HTMLElement>('[data-row="b"]')!.click());
  await settle();
  expect(pane().querySelector(".so-open-t")?.textContent).toBe("Task b");
  await act(async () => { release(json({ outcome: "refused", words: "this result changed" }, 409)); });
  await wait(0); await wait(0);
  expect(selectedRow()).toBe("b");
  expect(pane().querySelector("[data-work-said-act]")).toBeNull();
  expect(said()).toBe("Task a This result changed. Nothing changed.");
  expect(posts()).toHaveLength(1);
});

test("a selected task the panel may not read (another project's, refused by its own page) shows nothing of it and no act", async () => {
  answer = () => new Response("<p class=problem>No such resource in your projects.</p>", { status: 404, headers: { "content-type": "text/html" } });
  await mount(homeOf([], ["a"]));
  await settle();
  expect(pane().querySelector("[data-work-unread]")).not.toBeNull();
  expect(acceptButton()).toBeNull();
  expect(pane().querySelector("[data-work-send-back]")).toBeNull();
  expect(reads()[0]!.url).toBe("/t/a?format=workspace");
});

test("saved notes the panel doesn't show are never sent from it: Send back is the result's own review, and a note saved meanwhile posts nothing", async () => {
  answer = call => call.method === "POST" ? json({ outcome: "done", words: "x" }) : json(resultOf("a", { batch: "4,9" }));
  await mount(homeOf([], ["a"]));
  await settle();
  // What is displayed: the notes waiting, and the way to read them; no message box that would seal them unseen.
  expect(pane().querySelector("[data-work-send-back]")).toBeNull();
  expect(pane().querySelector("[data-work-notes-waiting]")?.textContent).toContain("2 saved notes wait to go with a send back. Read them on the result first.");
  expect(pane().querySelector("[data-work-review-send]")?.getAttribute("href")).toBe("/t/a?tab=result#request-changes");
  // Accept is still offered: it carries no notes.
  expect(acceptButton()).not.toBeNull();

  await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; calls = [];
  let saved = false;
  answer = call => call.method === "POST" ? json({ outcome: "done", words: "x" }) : json(resultOf("a", saved ? { batch: "12" } : {}));
  await mount(homeOf([], ["a"]));
  await settle();
  await typeNote("Round half-cents up.");
  saved = true;
  await act(async () => { pane().querySelector<HTMLFormElement>("[data-work-send-back]")!.requestSubmit(); });
  await wait(0); await wait(0);
  expect(posts()).toHaveLength(0);
  expect(pane().querySelector("[data-work-changed]")).not.toBeNull();
  expect(pane().querySelector("[data-work-notes-waiting]")?.textContent).toContain("1 saved note waits");
});

test("every warning is on screen before Accept: the problem, each disagreement with its lines, every attention line and every limit", async () => {
  const mismatch = { headline: "The report doesn't match the changes.", said: [], rows: [
    { text: "Says it changed the rounding helper", path: "src/round.ts", lines: "4-9", href: null, absent: false, noteLabel: null },
    { text: "Names a file the changes don't have", path: "src/other.ts", lines: null, href: null, absent: true, noteLabel: null }] } as Selected["mismatch"];
  answer = () => json(resultOf("a", { problem: "1 requirement couldn't be verified.", mismatch, attention: ["Older payouts are not recomputed.", "Ledger fixtures cover USD only.", "Screenshots are from the desk only."],
    limits: ["The check log was shortened to its last 2,000 lines.", "The diff was shortened: 3 files are not shown."] }));
  await mount(homeOf([], ["a"]));
  await settle();
  const shown = [...pane().querySelectorAll("[data-work-caveat]")].map(one => one.textContent);
  expect(shown).toEqual(["1 requirement couldn't be verified.", "The report doesn't match the changes.", "Says it changed the rounding helper · src/round.ts:4-9", "Names a file the changes don't have · src/other.ts",
    "Older payouts are not recomputed.", "Ledger fixtures cover USD only.", "Screenshots are from the desk only.", "The check log was shortened to its last 2,000 lines.", "The diff was shortened: 3 files are not shown."]);
  // Many of them sit in one disclosure, open, above the act.
  const fold = pane().querySelector<HTMLDetailsElement>("details.k-disclose")!;
  expect(fold.open).toBe(true);
  expect(fold.querySelectorAll("[data-work-caveat]")).toHaveLength(9);
  expect(fold.compareDocumentPosition(acceptButton()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a lost Accept is done only when the task shows this very result complete; anything else is unconfirmed, the row stays and nothing more is pressed", async () => {
  const cases: [string, () => Response, boolean][] = [
    ["access changed (the task page refuses)", () => new Response("<p class=problem>No such resource in your projects.</p>", { status: 404, headers: { "content-type": "text/html" } }), false],
    ["a newer result", () => json(resultOf("a", { revision: "r2", build: 8 })), false],
    ["the acts went away", () => json(resultOf("a", { accept: false, batch: "3" })), false],
    ["complete, but a different run", () => json(resultOf("a", { complete: true, build: 8 })), false],
    ["this run, complete", () => json(resultOf("a", { complete: true })), true],
  ];
  for (const [name, after, done] of cases) {
    let lost = false;
    answer = call => {
      if (call.method === "POST") { lost = true; return Promise.reject(new TypeError("network")); }
      return lost ? after() : json(resultOf("a"));
    };
    await mount(homeOf([], ["a", "b"]));
    await settle();
    await pressAccept();
    await wait(0); await wait(0);
    expect(posts(), name).toHaveLength(1);
    if (done) {
      expect(said(), name).toBe("Task a Accepted. The task is complete.");
      expect(selectedRow(), name).toBe("b");
    } else {
      expect(said(), name).toBeNull();
      expect(document.body.textContent, name).not.toContain("Done");
      expect(selectedRow(), name).toBe("a");
      // A task this person may no longer read says so (and only links to it); any other says it couldn't confirm.
      if (name.startsWith("access")) expect(pane().querySelector("[data-work-unread]"), name).not.toBeNull();
      else {
        expect(pane().querySelector("[data-work-said-act=unconfirmed]")?.textContent, name).toBe("We couldn’t confirm this. Check the task before doing anything else.");
        expect(pane().querySelector("[data-work-check]")?.getAttribute("href"), name).toBe("/t/a");
      }
      expect(acceptButton(), name).toBeNull();
      expect(pane().querySelector("[data-work-send-back]"), name).toBeNull();
    }
    await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; calls = []; forgetPendingActs();
  }
});

test("a lost Send back stays pending outside the panel: away and back offers no second press, only the same request again, so exactly one revision is filed", async () => {
  const filed = new Map<string, string>();
  let lose = true;
  answer = call => {
    if (call.method === "POST") {
      const request = new URLSearchParams(call.body).get("request")!;
      // The server's own replay rule: one revision per request token.
      if (!filed.has(request)) filed.set(request, `a-v${filed.size + 2}`);
      if (lose) { lose = false; return Promise.reject(new TypeError("network")); }
      return json({ outcome: "done", words: "Sent back. The revision is filed." });
    }
    return json(resultOf(call.url.split("?")[0]!.slice(3), { request: reads().length }));
  };
  await mount(homeOf([], ["a", "b"]));
  await settle();
  await typeNote("Round half-cents up.");
  await act(async () => { pane().querySelector<HTMLFormElement>("[data-work-send-back]")!.requestSubmit(); });
  await wait(0); await wait(0); await wait(0);
  expect(posts()).toHaveLength(1);
  const first = new URLSearchParams(posts()[0]!.body).get("request");
  expect(pane().querySelector("[data-work-said-act=unconfirmed]")).not.toBeNull();
  // Away to B and back to A: the panel remounts, and still offers no new Send back, only the same request again.
  await act(async () => document.querySelector<HTMLElement>('[data-row="b"]')!.click());
  await settle();
  await act(async () => document.querySelector<HTMLElement>('[data-row="a"]')!.click());
  await settle();
  expect(pane().querySelector("[data-work-send-back]")).toBeNull();
  expect(acceptButton()).toBeNull();
  const again = pane().querySelector<HTMLButtonElement>("[data-work-replay]")!;
  expect(again.textContent).toBe("Send it again");
  const click = (trusted: boolean) => Object.defineProperty(new MouseEvent("click", { bubbles: true, cancelable: true }), "isTrusted", { value: trusted });
  await act(async () => { again.dispatchEvent(click(true)); });
  await wait(0); await wait(0);
  expect(posts()).toHaveLength(2);
  expect([...new URLSearchParams(posts()[1]!.body)]).toEqual([...new URLSearchParams(posts()[0]!.body)]);
  expect(new URLSearchParams(posts()[1]!.body).get("request")).toBe(first);
  expect(filed.size).toBe(1);
  expect(said()).toBe("Task a Sent back. The revision is filed.");
});

test("a Send back still on its way when the person leaves and comes back: no second press until its answer is in", async () => {
  let release: (response: Response) => void = () => undefined;
  answer = call => call.method === "POST" ? new Promise<Response>(done => { release = done; }) : json(resultOf(call.url.split("?")[0]!.slice(3)));
  await mount(homeOf([], ["a", "b"]));
  await settle();
  await typeNote("Round half-cents up.");
  await act(async () => { pane().querySelector<HTMLFormElement>("[data-work-send-back]")!.requestSubmit(); });
  await wait(0); await wait(0);
  await act(async () => document.querySelector<HTMLElement>('[data-row="b"]')!.click());
  await settle();
  await act(async () => document.querySelector<HTMLElement>('[data-row="a"]')!.click());
  await settle();
  expect(pane().querySelector("[data-work-said-act=in-flight]")?.textContent).toBe("Sending back… Wait for the answer.");
  expect(pane().querySelector("[data-work-send-back]")).toBeNull();
  await act(async () => { release(json({ outcome: "refused", words: "this result already has a newer version" }, 409)); });
  await wait(0); await wait(0);
  // Answered: the panel takes presses again, for the terms it reads now.
  expect(pane().querySelector("[data-work-said-act=in-flight]")).toBeNull();
  expect(posts()).toHaveLength(1);
});
