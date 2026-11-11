// @vitest-environment happy-dom
/**
 * Reviewing a result on its task page, in both forms a page can get it (docs/plans/task-page-in-app.md §4, §5): the
 * page script string a document ships (`reviewEvidenceScript` + `RESULT_REVIEW_SCRIPT`) and the app's version
 * (`resultWork`). One table runs against both, so they cannot drift: the sections and the address, the diff's modes,
 * the pins, screenshot feedback, the draft and the request's identity, the submit latch. The cases below the table are
 * the app's alone: it is bound to its own panel, and it leaves nothing behind when the page is replaced.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RESULT_REVIEW_SCRIPT } from "../../result-review.js";
import { reviewEvidenceScript } from "../../server/render-results.js";
import { resultWork } from "./result.js";

const ORIGIN = "http://127.0.0.1:4999";
const TOKEN = "a".repeat(32);
const KEY = "standing-orders:review-draft:u1:t-1:7";
const SHOT = JSON.stringify({ run: 7, artifact: "shot-1", sha256: "ab" });
const setURL = (path: string): void => { (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`${ORIGIN}${path}`); };

type PageOptions = { param?: "section"; batch?: string; recorded?: string; open?: boolean; limit?: number | null; panel?: boolean };
/** The hooks a result gives its script, as the task page draws them: the sections, a diff, the pins, a screenshot, the form. */
const PAGE = (o: PageOptions = {}): string => {
  const form = `<section id="request-changes"><details class="result-request-open result-request-form"${o.open ? " open" : ""}><summary>What should change?</summary>` +
    `<form id="comment-form" method="post" action="/r/7/comment"><input type="hidden" name="csrf" value="deadbeef">` +
    `<input type="hidden" name="tab" value="summary"><input type="hidden" name="request" value="${TOKEN}">` +
    `<input type="hidden" name="batch" value="${o.batch ?? ""}"><input type="hidden" data-recorded-requests value="${o.recorded ?? ""}">` +
    `<input type="hidden" name="image" value=""><figure data-feedback-image hidden><img alt="Selected screenshot" hidden><figcaption></figcaption><button type="button" data-remove-image>Remove image</button></figure>` +
    `<textarea name="note"${o.limit === null ? "" : ` maxlength="${o.limit ?? 4000}"`}></textarea><span id="comment-note-limit">up to 4000 characters</span>` +
    `<details class="result-pin"><summary>Attach to a file or line</summary><input type="text" name="path"><input type="text" name="line"></details>` +
    `<button type="submit" name="intent" value="revise" data-request-changes>Send back</button><button type="submit" name="intent" value="note" data-save-feedback>Save for later</button>` +
    `</form></details></section>`;
  const panel = `<div id="result" data-result-panel data-result-user="u1" data-result-task="t-1" data-result-run="7"${o.param === "section" ? ` data-result-param="section"` : ""}>` +
    `<a role="tab" data-result-tab="summary" href="?x=summary" aria-selected="true" tabindex="0">Summary</a>` +
    `<a role="tab" data-result-tab="changes" href="?x=changes" aria-selected="false" tabindex="-1">Changes</a>` +
    `<a role="tab" data-result-tab="checks" href="?x=checks" aria-selected="false" tabindex="-1">Checks</a>` +
    `<div data-result-view="summary">Summary</div>` +
    `<div data-result-view="changes" hidden><div data-review-diff>` +
    `<button type="button" data-diff-mode="view" aria-pressed="true">View</button><button type="button" data-diff-mode="annotate" aria-pressed="false">Annotate</button>` +
    `<button type="button" class="pick-file" data-path="src/a.ts">Annotate file</button>` +
    `<button type="button" class="diff-annotate pick-line" data-path="src/a.ts" data-line="12">Annotate line</button>` +
    `<button type="button" class="pick-line" id="finding" data-path="src/b.ts" data-line="3" data-review-note="Reviewer: handle the empty list">Use this note</button>` +
    `</div></div>` +
    `<div data-result-view="checks" hidden><button type="button" data-comment-image='${SHOT}' data-image-caption="Home page">Comment</button></div>` +
    `<a class="result-feedback-link" href="#request-changes">Send back</a>${form}</div>`;
  return `<a data-open-evidence href="?tab=checks">Review the evidence</a>${o.panel === false ? "" : panel}`;
};

/** One form of the behaviour, started on the page now in the document; `stop` leaves no listener behind. */
type Form = { name: string; start(confirm: (text: string) => boolean): { stop(): void } };

const asString: Form = {
  name: "the page script string",
  start(confirm) {
    vi.stubGlobal("confirm", confirm);
    // The string listens on the document and the window and never stops: keep hold of those listeners, so one case
    // cannot act for the next. (What it adds to the page's own elements goes with the page.)
    const added: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
    const restore: (() => void)[] = [];
    for (const target of [document, window] as const) {
      const add = target.addEventListener;
      target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        added.push([target, type, listener]);
        add.call(target, type, listener, options);
      }) as typeof target.addEventListener;
      restore.push(() => { target.addEventListener = add; });
    }
    try { new Function(`${reviewEvidenceScript()}${RESULT_REVIEW_SCRIPT}`)(); } finally { for (const one of restore) one(); }
    return { stop: () => { for (const [target, type, listener] of added) target.removeEventListener(type, listener); } };
  },
};
const asApp: Form = {
  name: "the app",
  start(confirm) {
    const page = new AbortController();
    // Outside the workspace (no navigation installed), the address is written as the string writes it.
    resultWork(page.signal, { replaceAddress: url => { window.history.replaceState(window.history.state, "", url); }, confirm });
    return { stop: () => page.abort() };
  },
};

let running: { stop(): void } | null = null;
beforeEach(() => {
  setURL("/t/t-1");
  // Not laid out here: where a control is scrolled to is the browser's own.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  running?.stop(); running = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  sessionStorage.clear();
  Reflect.deleteProperty(document, "readyState");
});

const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
};
const noteBox = (): HTMLTextAreaElement => $<HTMLTextAreaElement>("#comment-form [name=note]");
const field = (name: string): HTMLInputElement => $<HTMLInputElement>(`#comment-form [name=${name}]`);
const shell = (): HTMLDetailsElement => $<HTMLDetailsElement>("details.result-request-open");
const typeNote = (text: string): void => { noteBox().value = text; noteBox().dispatchEvent(new Event("input", { bubbles: true })); };
const draft = (): Record<string, unknown> | null => JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Record<string, unknown> | null;
const keep = (value: Record<string, unknown>, key = KEY): void => sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), ...value }));
/** A click as a person makes it. Says whether the behaviour took it over; the browser's own answer never runs here. */
const click = (selector: string, init: MouseEventInit = {}): boolean => {
  let taken = false;
  const seen = (event: Event): void => { taken = event.defaultPrevented; event.preventDefault(); };
  window.addEventListener("click", seen, { once: true });
  $(selector).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  window.removeEventListener("click", seen);
  return taken;
};
const key = (selector: string, name: string): boolean => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  $(selector).dispatchEvent(event);
  return event.defaultPrevented;
};
const submit = (): Event => {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  $("#comment-form").dispatchEvent(event);
  return event;
};
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));
const selected = (): string[] => [...document.querySelectorAll("[data-result-tab]")].filter(tab => tab.getAttribute("aria-selected") === "true").map(tab => tab.getAttribute("data-result-tab") ?? "");
const shown = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-result-view]")].filter(view => !view.hidden).map(view => view.getAttribute("data-result-view") ?? "");

describe.each([asString, asApp])("reviewing a result: $name", form => {
  const begin = (options: PageOptions = {}, confirm: (text: string) => boolean = () => true) => {
    document.body.innerHTML = PAGE(options);
    running = form.start(confirm);
    return running;
  };

  test("a section opens in place: its view, its tab, the form's own field, and the address under `section` on a task page", () => {
    setURL("/t/t-1?tab=result&section=summary#request-changes");
    begin({ param: "section" });
    expect(click('[data-result-tab="changes"]')).toBe(true);
    expect(shown()).toEqual(["changes"]);
    expect(selected()).toEqual(["changes"]);
    expect($('[data-result-tab="changes"]').tabIndex).toBe(0);
    expect($('[data-result-tab="summary"]').tabIndex).toBe(-1);
    // A note sent from here comes back to this section.
    expect(field("tab").value).toBe("changes");
    // The task's own tab is kept; the result's section is named beside it, and the fragment goes.
    expect(`${location.pathname}${location.search}${location.hash}`).toBe("/t/t-1?tab=result&section=changes");
  });

  test("on the result's own page the section is named `tab`", () => {
    setURL("/r/7");
    begin();
    click('[data-result-tab="checks"]');
    expect(`${location.pathname}${location.search}`).toBe("/r/7?tab=checks");
    expect(shown()).toEqual(["checks"]);
  });

  test("a click meant for the browser (a new tab, a new window) is left to it", () => {
    begin({ param: "section" });
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) expect(click('[data-result-tab="changes"]', init)).toBe(false);
    expect(shown()).toEqual(["summary"]);
    expect(location.search).toBe("");
  });

  test("the sections are a keyboard tab list: arrows wrap, Home and End go to the ends", () => {
    begin({ param: "section" });
    expect(key('[data-result-tab="summary"]', "ArrowRight")).toBe(true);
    expect(selected()).toEqual(["changes"]);
    expect(document.activeElement).toBe($('[data-result-tab="changes"]'));
    key('[data-result-tab="changes"]', "End");
    expect(selected()).toEqual(["checks"]);
    key('[data-result-tab="checks"]', "ArrowRight");
    expect(selected()).toEqual(["summary"]);
    key('[data-result-tab="summary"]', "ArrowLeft");
    expect(selected()).toEqual(["checks"]);
    key('[data-result-tab="checks"]', "Home");
    expect(selected()).toEqual(["summary"]);
    expect(location.search).toBe("?section=summary");
    // Any other key is the browser's.
    expect(key('[data-result-tab="summary"]', "a")).toBe(false);
  });

  test("the review act above the result opens Checks", () => {
    begin({ param: "section" });
    expect(click("[data-open-evidence]")).toBe(true);
    expect(shown()).toEqual(["checks"]);
    expect(location.search).toBe("?section=checks");
  });

  test("the diff starts in View; its switch moves it to Annotate and back", () => {
    begin();
    const review = $("[data-review-diff]");
    expect(review.getAttribute("data-mode")).toBe("view");
    click('[data-diff-mode="annotate"]');
    expect(review.getAttribute("data-mode")).toBe("annotate");
    expect($('[data-diff-mode="annotate"]').getAttribute("aria-pressed")).toBe("true");
    expect($('[data-diff-mode="view"]').getAttribute("aria-pressed")).toBe("false");
    click('[data-diff-mode="view"]');
    expect(review.getAttribute("data-mode")).toBe("view");
    expect($('[data-diff-mode="view"]').getAttribute("aria-pressed")).toBe("true");
  });

  test("the form waits closed; the address's own fragment opens it, and so does the result's link", () => {
    begin();
    expect(shell().open).toBe(false);
    click('a[href="#request-changes"]');
    expect(shell().open).toBe(true);
    running?.stop(); running = null;
    setURL("/t/t-1?tab=result#request-changes");
    begin();
    expect(shell().open).toBe(true);
  });

  test("a line pin fills the file and the line, opens the form on them and keeps the draft", () => {
    begin();
    click("button.diff-annotate");
    expect(field("path").value).toBe("src/a.ts");
    expect(field("line").value).toBe("12");
    expect($<HTMLDetailsElement>("details.result-pin").open).toBe(true);
    expect(shell().open).toBe(true);
    expect(document.activeElement).toBe(noteBox());
    expect(draft()).toMatchObject({ note: "", path: "src/a.ts", line: "12", image: "", request: TOKEN, sent: null });
    // A file pin names the file alone.
    click("button.pick-file");
    expect(field("path").value).toBe("src/a.ts");
    expect(field("line").value).toBe("");
    expect(draft()).toMatchObject({ path: "src/a.ts", line: "" });
  });

  test("a reviewer's note is taken as the draft; a draft already typed is replaced only on a yes", () => {
    const asked: string[] = [];
    let yes = false;
    begin({}, text => { asked.push(text); return yes; });
    // Nothing typed: nothing to ask.
    click("#finding");
    expect(asked).toEqual([]);
    expect(noteBox().value).toBe("Reviewer: handle the empty list");
    expect(field("path").value).toBe("src/b.ts");
    expect(field("line").value).toBe("3");
    typeNote("my own words");
    field("path").value = "kept.ts";
    click("#finding");
    expect(asked).toEqual(["Replace the feedback draft with this note?"]);
    // No: the words and the pin stay as they were.
    expect(noteBox().value).toBe("my own words");
    expect(field("path").value).toBe("kept.ts");
    yes = true;
    click("#finding");
    expect(noteBox().value).toBe("Reviewer: handle the empty list");
    expect(field("path").value).toBe("src/b.ts");
    // A plain pin never asks: it leaves the words alone.
    click("button.diff-annotate");
    expect(asked.length).toBe(2);
    expect(noteBox().value).toBe("Reviewer: handle the empty list");
  });

  test("a screenshot joins the feedback with its own picture, and leaves again", () => {
    begin();
    const preview = $("[data-feedback-image]");
    expect(click("[data-comment-image]")).toBe(true);
    expect(field("image").value).toBe(SHOT);
    expect(preview.hidden).toBe(false);
    const img = $<HTMLImageElement>("[data-feedback-image] img");
    expect(img.hidden).toBe(false);
    expect(img.getAttribute("src")).toBe("/r/7/evidence/shot-1");
    expect(img.alt).toBe("Home page");
    expect($("[data-feedback-image] figcaption").textContent).toBe("Home page · Screenshot shot-1");
    expect(shell().open).toBe(true);
    expect(document.activeElement).toBe(noteBox());
    expect(draft()).toMatchObject({ image: SHOT });
    expect(click("[data-remove-image]")).toBe(true);
    expect(field("image").value).toBe("");
    expect(preview.hidden).toBe(true);
    // Nothing is left to keep.
    expect(draft()).toBeNull();
  });

  test("a kept screenshot this result no longer offers says so, and shows no picture", () => {
    keep({ note: "see the header", path: "", line: "", image: JSON.stringify({ run: 7, artifact: "gone", sha256: "cd" }), request: TOKEN, sent: null });
    begin();
    expect($("[data-feedback-image]").hidden).toBe(false);
    expect($<HTMLImageElement>("[data-feedback-image] img").hidden).toBe(true);
    expect($("[data-feedback-image] img").hasAttribute("src")).toBe(false);
    expect($("[data-feedback-image] figcaption").textContent).toBe("This screenshot is unavailable. Restore it or remove it from your feedback.");
  });

  test("Send back and Save for later wait for words; saved notes alone can be sent back", () => {
    begin();
    const send = $<HTMLButtonElement>("[data-request-changes]"), save = $<HTMLButtonElement>("[data-save-feedback]");
    expect([send.disabled, save.disabled]).toEqual([true, true]);
    typeNote("   ");
    expect([send.disabled, save.disabled]).toEqual([true, true]);
    typeNote("tighten the copy");
    expect([send.disabled, save.disabled]).toEqual([false, false]);
    running?.stop(); running = null;
    sessionStorage.clear();
    begin({ batch: "b-1" });
    expect([$<HTMLButtonElement>("[data-request-changes]").disabled, $<HTMLButtonElement>("[data-save-feedback]").disabled]).toEqual([false, true]);
  });

  test("the note's limit line counts against the box's own limit", () => {
    begin({ limit: 120 });
    const limit = $("#comment-note-limit");
    expect(limit.textContent).toBe("up to 120 characters");
    typeNote("12345");
    expect(limit.textContent).toBe("5 of 120 characters");
    typeNote("");
    expect(limit.textContent).toBe("up to 120 characters");
    running?.stop(); running = null;
    // No limit on the box: the server's own words stay.
    begin({ limit: null });
    typeNote("12345");
    expect($("#comment-note-limit").textContent).toBe("up to 4000 characters");
  });

  test("what this tab kept is pruned: anything a day old, unreadable, or another account's", () => {
    const old = Date.now() - 86_400_000 - 1000;
    keep({ note: "mine, fresh" }, "standing-orders:review-draft:u1:t-2:9");
    keep({ note: "mine, old", at: old }, "standing-orders:review-draft:u1:t-3:1");
    keep({ note: "theirs" }, "standing-orders:review-draft:u2:t-1:7");
    keep({ y: 40 }, "standing-orders:result-scroll:u1:t-1:7:summary");
    keep({ y: 40, at: old }, "standing-orders:result-scroll:u1:t-4:return");
    sessionStorage.setItem("standing-orders:review-draft:u1:t-5:2", "not json");
    sessionStorage.setItem("standing-orders:review-draft:u1:t-6:2", JSON.stringify({ note: "no time" }));
    sessionStorage.setItem("someone-else", "kept");
    begin();
    expect(Object.keys(sessionStorage).sort()).toEqual(["someone-else", "standing-orders:result-scroll:u1:t-1:7:summary", "standing-orders:review-draft:u1:t-2:9"]);
  });

  test("with no result on the page only the pruning runs", () => {
    keep({ note: "old", at: 5 }, "standing-orders:review-draft:u1:t-3:1");
    keep({ note: "fresh, whoever's" }, "standing-orders:review-draft:u2:t-1:7");
    begin({ panel: false });
    // No account to compare against, so only age decides.
    expect(Object.keys(sessionStorage)).toEqual(["standing-orders:review-draft:u2:t-1:7"]);
    expect(click("[data-open-evidence]")).toBe(false);
  });

  test("a kept draft comes back: the words, the pin, the screenshot and the request it was typed under", () => {
    const kept = "b".repeat(32);
    keep({ note: "tighten the copy", path: "src/a.ts", line: "12", image: SHOT, request: kept, sent: null });
    begin();
    expect(noteBox().value).toBe("tighten the copy");
    expect(field("path").value).toBe("src/a.ts");
    expect(field("line").value).toBe("12");
    expect(field("image").value).toBe(SHOT);
    expect(field("request").value).toBe(kept);
    expect(shell().open).toBe(true);
    expect($<HTMLDetailsElement>("details.result-pin").open).toBe(true);
    expect($("[data-feedback-image]").hidden).toBe(false);
    expect($<HTMLButtonElement>("[data-request-changes]").disabled).toBe(false);
    // The same words keep the same identity.
    typeNote("tighten the copy");
    expect(field("request").value).toBe(kept);
  });

  test("a kept draft is refused when it could not be the form's: too long, or a request that is not one", () => {
    keep({ note: "x".repeat(50), path: "src/a.ts", line: "", image: "", request: TOKEN, sent: null });
    begin({ limit: 20 });
    expect(noteBox().value).toBe("");
    expect(field("path").value).toBe("");
    running?.stop(); running = null;
    keep({ note: "fine", path: "", line: "", image: "i".repeat(250), request: "<script>", sent: null });
    begin();
    expect(noteBox().value).toBe("fine");
    expect(field("request").value).toBe(TOKEN);
    expect(field("image").value).toBe("");
  });

  test("a draft the server already recorded is not offered again", () => {
    const kept = "c".repeat(32);
    keep({ note: "already sent", path: "", line: "", image: "", request: kept, sent: null });
    begin({ recorded: `${"d".repeat(32)},${kept}` });
    expect(noteBox().value).toBe("");
    expect(draft()).toBeNull();
  });

  test("the receipt of the note just sent clears its draft and readies the box for the next", async () => {
    const kept = "c".repeat(32);
    keep({ note: "sent a moment ago", path: "", line: "", image: "", request: kept, sent: null });
    setURL(`/t/t-1?tab=result&noted=${kept}#request-changes`);
    begin();
    expect(draft()).toBeNull();
    expect(noteBox().value).toBe("");
    expect(shell().open).toBe(true);
    await tick();
    expect(document.activeElement).toBe(noteBox());
  });

  test("on a document still loading, the receipt's focus waits for the load", async () => {
    Object.defineProperty(document, "readyState", { value: "loading", configurable: true });
    setURL(`/t/t-1?tab=result&noted=${"c".repeat(32)}#request-changes`);
    begin();
    await tick();
    expect(document.activeElement).not.toBe(noteBox());
    window.dispatchEvent(new Event("load"));
    await tick();
    expect(document.activeElement).toBe(noteBox());
  });

  test("a refused request keeps the words and gets a new identity", () => {
    const kept = "c".repeat(32);
    keep({ note: "say it again", path: "", line: "", image: "", request: kept, sent: JSON.stringify(["say it again", "", "", ""]) });
    setURL(`/t/t-1?tab=result&conflict=${kept}#request-changes`);
    // Even one the server lists as recorded: the refusal is about exactly this identity.
    begin({ recorded: kept });
    expect(noteBox().value).toBe("say it again");
    const fresh = field("request").value;
    expect(fresh).toMatch(/^[a-f0-9]{32}$/);
    expect(fresh).not.toBe(kept);
    expect(draft()).toMatchObject({ note: "say it again", request: fresh, sent: null });
  });

  test("the request's identity follows what would be sent: new words, a new pin or a new screenshot each get a new one", () => {
    begin();
    const seen = new Set([TOKEN]);
    const moved = (): void => { const now = field("request").value; expect(now).toMatch(/^[a-f0-9]{32}$/); expect(seen.has(now)).toBe(false); seen.add(now); };
    // The first words are sent under the identity the page came with.
    typeNote("tighten");
    expect(field("request").value).toBe(TOKEN);
    expect(draft()).toMatchObject({ note: "tighten", request: TOKEN, sent: null });
    typeNote("tighten the copy");
    moved();
    click("button.diff-annotate");
    moved();
    field("line").value = "14";
    field("line").dispatchEvent(new Event("input", { bubbles: true }));
    moved();
    click("[data-comment-image]");
    moved();
    expect(draft()).toMatchObject({ note: "tighten the copy", path: "src/a.ts", line: "14", image: SHOT, request: field("request").value });
  });

  test("sending binds the identity to exactly what was sent; anything else afterwards is a new request", () => {
    begin();
    typeNote("tighten the copy");
    submit();
    const sent = JSON.stringify(["tighten the copy", "", "", ""]);
    expect(draft()).toMatchObject({ note: "tighten the copy", request: TOKEN, sent });
    // The same words again (a retry of the same post) are the same request.
    typeNote("tighten the copy");
    expect(field("request").value).toBe(TOKEN);
    expect(draft()).toMatchObject({ sent });
    typeNote("tighten the copy, and the title");
    expect(field("request").value).not.toBe(TOKEN);
    expect(draft()).toMatchObject({ note: "tighten the copy, and the title", sent: null });
  });

  test("what was sent is remembered across a reload: the same words stay one request, other words do not", () => {
    const kept = "c".repeat(32);
    keep({ note: "tighten the copy", path: "", line: "", image: "", request: kept, sent: JSON.stringify(["tighten the copy", "", "", ""]) });
    begin();
    typeNote("tighten the copy");
    expect(field("request").value).toBe(kept);
    typeNote("something else");
    expect(field("request").value).not.toBe(kept);
  });

  test("a draft emptied is a draft forgotten", () => {
    begin();
    typeNote("a thought");
    expect(draft()).not.toBeNull();
    typeNote("");
    expect(draft()).toBeNull();
  });

  test("when this tab cannot keep a draft, the limit line says the draft is this page's alone", () => {
    begin();
    // (A stand-in for the whole store: this environment's own is a proxy that a spy cannot be taken off again.)
    const real = sessionStorage;
    vi.stubGlobal("sessionStorage", { getItem: (name: string) => real.getItem(name), removeItem: (name: string) => { real.removeItem(name); }, setItem: () => { throw new Error("full"); } });
    typeNote("a thought");
    expect($("#comment-note-limit").textContent).toBe("Draft stays on this page only. Browser storage is unavailable.");
  });

  test("leaving the result marks the way back for the conversation it was opened from", () => {
    begin();
    expect(sessionStorage.getItem("standing-orders:result-scroll:u1:t-1:return")).toBeNull();
    const before = Date.now();
    window.dispatchEvent(new Event("pagehide"));
    const mark = JSON.parse(sessionStorage.getItem("standing-orders:result-scroll:u1:t-1:return") ?? "null") as { at: number } | null;
    expect(mark?.at).toBeGreaterThanOrEqual(before);
  });

  test("a second press while the first is being sent posts nothing more; coming back to the page frees the form", () => {
    begin();
    typeNote("tighten the copy");
    const formElement = $("#comment-form");
    expect(submit().defaultPrevented).toBe(false);
    expect(formElement.getAttribute("aria-busy")).toBe("true");
    expect(submit().defaultPrevented).toBe(true);
    window.dispatchEvent(new Event("pageshow"));
    expect(formElement.hasAttribute("aria-busy")).toBe(false);
    expect(submit().defaultPrevented).toBe(false);
  });
});

describe("the app's own: bound to its page, gone with it", () => {
  const start = (deps: Partial<Parameters<typeof resultWork>[1]> = {}): AbortController => {
    const page = new AbortController();
    resultWork(page.signal, { replaceAddress: url => { window.history.replaceState(window.history.state, "", url); }, confirm: () => true, ...deps });
    running = { stop: () => page.abort() };
    return page;
  };

  test("once the page is replaced nothing of it listens: sections, pins, screenshots, the draft, the latch", () => {
    document.body.innerHTML = PAGE({ param: "section" });
    const page = start();
    typeNote("kept so far");
    page.abort();
    expect(click('[data-result-tab="changes"]')).toBe(false);
    expect(shown()).toEqual(["summary"]);
    expect(key('[data-result-tab="summary"]', "ArrowRight")).toBe(false);
    expect(click("[data-open-evidence]")).toBe(false);
    click('[data-diff-mode="annotate"]');
    expect($("[data-review-diff]").getAttribute("data-mode")).toBe("view");
    click("button.diff-annotate");
    expect(field("path").value).toBe("");
    expect(click("[data-comment-image]")).toBe(false);
    expect(field("image").value).toBe("");
    typeNote("typed after the page left");
    expect(draft()).toMatchObject({ note: "kept so far" });
    expect($("#comment-note-limit").textContent).toBe("11 of 4000 characters");
    submit();
    expect($("#comment-form").hasAttribute("aria-busy")).toBe(false);
    expect(location.search).toBe("");
  });

  test("a page left in place leaves the same mark a departing document does, once", () => {
    document.body.innerHTML = PAGE();
    const page = start();
    expect(sessionStorage.getItem("standing-orders:result-scroll:u1:t-1:return")).toBeNull();
    page.abort();
    expect(JSON.parse(sessionStorage.getItem("standing-orders:result-scroll:u1:t-1:return") ?? "null")).toMatchObject({ at: expect.any(Number) as number });
    sessionStorage.clear();
    window.dispatchEvent(new Event("pagehide"));
    expect(sessionStorage.length).toBe(0);
  });

  test("a page already replaced starts nothing, not even the pruning", () => {
    keep({ note: "old", at: 5 }, "standing-orders:review-draft:u1:t-3:1");
    document.body.innerHTML = PAGE();
    const page = new AbortController();
    page.abort();
    resultWork(page.signal);
    expect(sessionStorage.length).toBe(1);
    expect($("[data-review-diff]").hasAttribute("data-mode")).toBe(false);
  });

  test("the receipt's focus is dropped when the page leaves first", async () => {
    setURL(`/t/t-1?tab=result&noted=${"c".repeat(32)}#request-changes`);
    document.body.innerHTML = PAGE();
    const page = start();
    page.abort();
    await tick();
    expect(document.activeElement).not.toBe(noteBox());
    // And the load it would have waited for is not listened to either.
    Object.defineProperty(document, "readyState", { value: "loading", configurable: true });
    const next = start();
    next.abort();
    window.dispatchEvent(new Event("load"));
    await tick();
    expect(document.activeElement).not.toBe(noteBox());
  });

  test("only its own result's controls: a pin or a screenshot button elsewhere on the page is not its", () => {
    document.body.innerHTML = `${PAGE()}<button type="button" class="pick-line" id="stray" data-path="other.ts" data-line="1">Elsewhere</button>` +
      `<button type="button" id="stray-shot" data-comment-image='${SHOT}'>Elsewhere</button><a id="stray-link" href="#request-changes">Elsewhere</a>`;
    start();
    click("#stray");
    expect(field("path").value).toBe("");
    expect(click("#stray-shot")).toBe(false);
    expect(field("image").value).toBe("");
    click("#stray-link");
    expect(shell().open).toBe(false);
  });

  test("a section change goes through navigation's own address write, with the whole address", () => {
    setURL("/t/t-1?tab=result#request-changes");
    document.body.innerHTML = PAGE({ param: "section" });
    const written: string[] = [];
    start({ replaceAddress: url => { written.push(url); } });
    click('[data-result-tab="changes"]');
    expect(written).toEqual([`${ORIGIN}/t/t-1?tab=result&section=changes`]);
    // The section is shown whatever navigation did with the address.
    expect(shown()).toEqual(["changes"]);
  });

  test("a screenshot whose identity cannot be read shows as unavailable instead of failing", () => {
    document.body.innerHTML = PAGE();
    $("[data-comment-image]").setAttribute("data-comment-image", "not json");
    start();
    click("[data-comment-image]");
    expect(field("image").value).toBe("not json");
    expect($<HTMLImageElement>("[data-feedback-image] img").hidden).toBe(true);
    expect($("[data-feedback-image] figcaption").textContent).toBe("This screenshot is unavailable. Restore it or remove it from your feedback.");
  });
});
