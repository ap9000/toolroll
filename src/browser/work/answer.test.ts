// @vitest-environment happy-dom
/**
 * Answering a question on its own page, in both forms a page can get it (docs/plans/task-page-in-app.md §5): the page
 * script string a document ships (`decisionAnswerScript`) and the app's version (`answerWork`). One table runs against
 * both, so they cannot drift: the urlencoded POST to the form's own action, the landed-page check, the card-local
 * receipt. The cases below the table are the app's alone: its listener ends when the page is replaced.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { decisionAnswerScript } from "../../server/render-tasks.js";
import { answerWork } from "./answer.js";

const PAGE = (id: number, extra = ""): string =>
  `<form class="card" id="capture"><input type="text" id="qc" name="title"></form>` +
  `<div class="decide-card" data-decision-id="${id}">` +
  `<p class="q">Which way?</p>` +
  `<div class="decide-options">` +
  `<form class="decide-option decide-inline" method="post" action="/d/${id}/answer">` +
  `<input type="hidden" name="csrf" value="deadbeef">` +
  `<input type="hidden" name="choice" value="keep">${extra}` +
  `<button type="submit">Keep and backfill</button>` +
  `</form></div></div>`;
const RECEIPT = `<html><body><div class="answered">Answered: <strong>keep</strong> by alex</div></body></html>`;

type Call = { url: string; init: RequestInit };
type Answer = { ok: boolean; url: string; text: () => Promise<string> };
type Fetcher = (url: string, init: RequestInit) => Promise<Answer>;
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const answer = (path: string, body = RECEIPT, ok = true): Answer => ({ ok, url: `${location.origin}${path}`, text: () => Promise.resolve(body) });

/** One form of the behaviour, started on the page now in the document; `stop` leaves no listener behind. */
type Form = { name: string; start(fetcher: Fetcher): { stop(): void; loads: string[] | null } };

const asString: Form = {
  name: "the page script string",
  start(fetcher) {
    vi.stubGlobal("fetch", fetcher);
    // The string adds an anonymous document listener it never removes: keep hold of it, so one case cannot answer for the next.
    const added: [string, EventListenerOrEventListenerObject][] = [];
    const add = document.addEventListener;
    document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      added.push([type, listener]);
      add.call(document, type, listener, options);
    }) as typeof document.addEventListener;
    try { new Function(decisionAnswerScript())(); } finally { document.addEventListener = add; }
    return { stop: () => { for (const [type, listener] of added) document.removeEventListener(type, listener); }, loads: null };
  },
};
const asApp: Form = {
  name: "the app",
  start(fetcher) {
    const loads: string[] = [];
    const page = new AbortController();
    answerWork(page.signal, { fetch: fetcher as unknown as typeof fetch, load: href => { loads.push(href); } });
    return { stop: () => page.abort(), loads };
  },
};

let running: { stop(): void } | null = null;
afterEach(() => { running?.stop(); running = null; document.body.innerHTML = ""; vi.unstubAllGlobals(); });

const submit = (selector = "form.decide-inline"): Event => {
  const form = document.querySelector(selector);
  if (form === null) throw new Error("no form");
  const event = new Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
};
const posts = (calls: Call[]): Call[] => calls.filter(one => one.init?.method === "POST");

describe.each([asString, asApp])("answering a question in place: $name", form => {
  const begin = (fetcher: Fetcher, page = PAGE(7)) => {
    document.body.innerHTML = page;
    (document.getElementById("qc") as HTMLInputElement).value = "typed, not yet saved";
    const started = form.start(fetcher);
    running = started;
    return started;
  };

  test("a successful answer swaps only the card for the receipt; typed input survives", async () => {
    const calls: Call[] = [];
    begin((url, init) => { calls.push({ url, init }); return Promise.resolve(answer("/d/7")); });
    expect(submit().defaultPrevented).toBe(true);
    await flush();
    // The forms-only gate's exact transport: one urlencoded POST to the form's own action, fields intact.
    expect(posts(calls).length).toBe(1);
    expect(calls[0]?.url).toBe(`${location.origin}/d/7/answer`);
    expect(calls[0]?.init.credentials).toBe("same-origin");
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(String(calls[0]?.init.body)).toContain("choice=keep");
    expect(String(calls[0]?.init.body)).toContain("csrf=deadbeef");
    const card = document.querySelector('[data-decision-id="7"]');
    expect(card?.textContent).toContain("Answered:");
    expect(card?.querySelector("form")).toBeNull();
    expect(document.getElementById("capture")).not.toBeNull();
    expect((document.getElementById("qc") as HTMLInputElement).value).toBe("typed, not yet saved");
  });

  test("landing anywhere but the decision page inserts nothing", async () => {
    begin(() => Promise.resolve(answer("/login", `<html><body><div class="answered">forged</div></body></html>`)));
    submit();
    await flush();
    const card = document.querySelector('[data-decision-id="7"]');
    expect(card?.textContent).not.toContain("forged");
    expect(card?.querySelector("form.decide-inline")).not.toBeNull();
  });

  test("a refused answer inserts nothing", async () => {
    begin(() => Promise.resolve(answer("/d/7", `<html><body><div class="answered">forged</div></body></html>`, false)));
    submit();
    await flush();
    expect(document.querySelector('[data-decision-id="7"]')?.textContent).not.toContain("forged");
    expect(document.querySelector("form.decide-inline")).not.toBeNull();
  });

  test("an answer page with no receipt takes the card away", async () => {
    begin(() => Promise.resolve(answer("/d/7", "<html><body><p>Nothing to answer</p></body></html>")));
    submit();
    await flush();
    expect(document.querySelector('[data-decision-id="7"]')).toBeNull();
    expect(document.getElementById("capture")).not.toBeNull();
  });

  test("a field named action cannot send the answer somewhere else", async () => {
    const calls: Call[] = [];
    begin((url, init) => { calls.push({ url, init }); return Promise.resolve(answer("/d/7")); }, PAGE(7, `<input type="hidden" name="action" value="/elsewhere">`));
    submit();
    await flush();
    expect(posts(calls).map(one => one.url)).toEqual([`${location.origin}/d/7/answer`]);
  });

  test("any other form is left to the browser", async () => {
    const calls: Call[] = [];
    begin((url, init) => { calls.push({ url, init }); return Promise.resolve(answer("/d/7")); });
    expect(submit("#capture").defaultPrevented).toBe(false);
    await flush();
    expect(calls).toEqual([]);
  });
});

describe("the app's answer listener lasts only as long as its page", () => {
  const begin = (fetcher: Fetcher, page = PAGE(7)) => {
    document.body.innerHTML = page;
    const loads: string[] = [];
    const control = new AbortController();
    answerWork(control.signal, { fetch: fetcher as unknown as typeof fetch, load: href => { loads.push(href); } });
    running = { stop: () => control.abort() };
    return { loads, control };
  };

  test("an answer that does not land on its own page loads that page as a document", async () => {
    const { loads } = begin(() => Promise.resolve(answer("/login")));
    submit();
    await flush();
    expect(loads).toEqual([`${location.origin}/d/7`]);
  });

  test("a failed request loads the decision page", async () => {
    const { loads } = begin(() => Promise.reject(new Error("offline")));
    submit();
    await flush();
    expect(loads).toEqual([`${location.origin}/d/7`]);
  });

  test("once the page is replaced it answers nothing", async () => {
    const calls: Call[] = [];
    const { control } = begin((url, init) => { calls.push({ url, init }); return Promise.resolve(answer("/d/7")); });
    control.abort();
    expect(submit().defaultPrevented).toBe(false);
    await flush();
    expect(calls).toEqual([]);
  });

  test("an answer still under way when the page is replaced touches nothing and loads nothing", async () => {
    let land: (value: Answer) => void = () => undefined;
    const { loads, control } = begin(() => new Promise<Answer>(resolve => { land = resolve; }));
    submit();
    control.abort();
    // The next page, with a card of the same number: the late answer is not its.
    document.body.innerHTML = PAGE(7);
    land(answer("/login"));
    await flush();
    expect(loads).toEqual([]);
    expect(document.querySelector("form.decide-inline")).not.toBeNull();
    // A late failure loads nothing either.
    const again = begin(() => Promise.reject(new Error("offline")));
    submit();
    again.control.abort();
    await flush();
    expect(again.loads).toEqual([]);
  });

  test("two pages in a row: one press is one POST", async () => {
    const calls: Call[] = [];
    const fetcher: Fetcher = (url, init) => { calls.push({ url, init }); return Promise.resolve(answer("/d/8")); };
    const first = begin(fetcher, PAGE(7));
    first.control.abort();
    begin(fetcher, PAGE(8));
    submit();
    await flush();
    expect(posts(calls).map(one => one.url)).toEqual([`${location.origin}/d/8/answer`]);
    expect(document.querySelector('[data-decision-id="8"]')?.textContent).toContain("Answered:");
  });

  test("a page that was already replaced starts nothing", async () => {
    document.body.innerHTML = PAGE(7);
    const calls: Call[] = [];
    const control = new AbortController();
    control.abort();
    answerWork(control.signal, { fetch: ((url: string, init: RequestInit) => { calls.push({ url, init }); return Promise.resolve(answer("/d/7")); }) as unknown as typeof fetch, load: () => undefined });
    expect(submit().defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });
});
