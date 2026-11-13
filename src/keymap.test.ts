// @vitest-environment happy-dom
/** One keymap (docs/plans/plain-toolroll.md P1.7): one table for the console and the terminal UI, and the console's
 * script run against a page: a key presses only a control the page rendered and shows, exactly as a click; a submit
 * whose form isn't complete (an empty password) is never sent; nothing happens in text fields, with a modifier, or
 * while the list is open. The real-browser half is scripts/app-e2e.mjs ("Keyboard only: …"). */
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { SHORTCUTS, keyWords } from "./keymap.js";
import { chromeScript, KBD_HELP } from "./server/chrome.js";
import { htmlString } from "./html.js";
import { HELP_LINES } from "./tui/app.js";

describe("one table", () => {
  test("the plan's keys, each with a console act and a terminal act or a named gap", () => {
    expect(SHORTCUTS.map(one => one.keys)).toEqual(["n", "a", "b", "r", "p", "/", "g h", "g t", "?"]);
    for (const one of SHORTCUTS) {
      expect(one.web.kind, one.keys).toMatch(/^(go|press|search|help)$/);
      if (typeof one.tui !== "string") expect(one.tui.none, one.keys).not.toBe("");
    }
  });

  test("the console's list and the terminal's keys are read from it", () => {
    for (const one of SHORTCUTS) expect(htmlString(KBD_HELP), one.keys).toContain(one.says);
    for (const one of SHORTCUTS.filter(row => typeof row.tui === "string")) expect(HELP_LINES.some(line => line.split(/\s{2,}/)[0]!.split(", ").includes(keyWords(one.keys))), one.keys).toBe(true);
    // Each thing is said once: no two lines name the same act.
    const says = HELP_LINES.map(line => line.split(/\s{2,}/).slice(1).join(" "));
    expect(new Set(says).size).toBe(says.length);
  });
});

describe("the console's keys, on a page", () => {
  let clicks: string[] = [];
  let submits = 0;
  const stage = () => document.getElementById("stage")!;
  const key = (k: string, init: KeyboardEventInit = {}, on: EventTarget = document.body) => on.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  beforeAll(() => {
    // Rendered and shown: what a person could see. A [data-unshown] subtree has no boxes, as display:none would.
    Element.prototype.getClientRects = function (this: Element) { return (this.closest("[data-unshown]") ? [] : [{}]) as unknown as DOMRectList; };
    document.body.innerHTML = `<script type="application/json" id="palette-index">[]</script>${htmlString(KBD_HELP)}<div id="stage"></div>`;
    new Function(chromeScript())();
    document.addEventListener("click", event => { const t = event.target as Element; if (t.closest?.("#stage")) clicks.push(t.getAttribute("data-name") ?? t.tagName); }, { capture: true });
  });
  beforeEach(() => {
    clicks = []; submits = 0;
    stage().innerHTML = "";
  });
  const listen = () => stage().querySelectorAll("form").forEach(form => form.addEventListener("submit", event => { event.preventDefault(); submits++; }));

  test("a with no Approve or Accept on the page presses nothing", () => {
    stage().innerHTML = `<button data-name="other">Other</button>`;
    key("a");
    expect(clicks).toEqual([]);
  });

  test("a presses the page's own Approve, the first one shown", () => {
    stage().innerHTML = `<div data-unshown><button data-ink-approve data-name="docked">Approve</button></div><button data-ink-approve data-name="inline">Approve</button>`;
    key("a");
    expect(clicks).toEqual(["inline"]);
  });

  test("a hidden, disabled or unshown control is never pressed", () => {
    stage().innerHTML = `<div hidden><button data-ink-approve data-name="hidden">Approve</button></div><button data-ink-approve disabled data-name="disabled">Approve</button><div data-unshown><button data-ink-act="accept" data-name="unshown">Accept</button></div>`;
    key("a");
    expect(clicks).toEqual([]);
  });

  test("a submit whose form needs a password isn't sent without it; once typed, the same press sends it", () => {
    stage().innerHTML = `<form><input type="password" name="token" required><button type="submit" data-ink-act="accept" data-name="accept">Accept</button></form>`;
    listen();
    key("a");
    expect(submits).toBe(0);
    (stage().querySelector('input[name="token"]') as HTMLInputElement).value = "secret";
    key("a");
    expect(submits).toBe(1);
  });

  test("r presses Retry; b opens Send back's note, never its submit", () => {
    stage().innerHTML = `<form data-retry><button type="submit" data-name="retry">Retry</button></form><a href="#request-changes" class="result-feedback-link" data-name="send-back">Send back</a><button type="submit" data-request-changes data-name="submit">Send back</button>`;
    listen();
    key("r");
    expect(submits).toBe(1);
    key("b");
    expect(clicks.filter(one => one !== "retry")).toEqual(["send-back"]);
  });

  test("keys sleep in a text field, with a modifier held, and while the list is open", () => {
    stage().innerHTML = `<input id="field"><button data-ink-approve data-name="approve">Approve</button>`;
    key("a", {}, document.getElementById("field")!);
    key("a", { metaKey: true });
    key("a", { ctrlKey: true });
    expect(clicks).toEqual([]);
    key("?");
    expect((document.querySelector(".kbd-help") as HTMLElement).hidden).toBe(false);
    key("a");
    expect(clicks).toEqual([]);
    key("Escape");
    expect((document.querySelector(".kbd-help") as HTMLElement).hidden).toBe(true);
    key("a");
    expect(clicks).toEqual(["approve"]);
  });
});
