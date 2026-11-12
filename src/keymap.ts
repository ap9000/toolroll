/** One keymap for the console and the terminal UI (docs/plans/plain-toolroll.md P1.7). A shortcut only ever presses a
 * control the page already rendered, the same press a person's click makes, so any password field or confirm it opens
 * still appears; with no such control on the page the key does nothing. Shortcuts sleep in text fields, with a
 * modifier held, and while the shortcuts list is open. Navigation keys go to a page and post nothing. */

/** What a key does in the console. `press`: the first visible, enabled control matching these, in order. */
export type WebShortcut = { kind: "go"; href: string } | { kind: "press"; selectors: readonly string[] } | { kind: "search" } | { kind: "help" };
/** What a key does in the terminal UI, or null with the reason it has none there (a named gap). */
export type TuiShortcut = "new" | "ink" | "send-back" | "retry" | "plan" | "list" | "help";
export type Shortcut = { keys: string; says: string; web: WebShortcut; tui: TuiShortcut | { none: string } };

/** The page's ink act: Approve (the approve control itself, password popover and all) or Accept. */
export const INK_ACT_SELECTORS = ["[data-ink-approve]", '[data-ink-act="accept"]', "[data-accept-result][data-primary-action]"] as const;
/** Send back: the control that opens the Send back form (never its submit: the note comes first). */
export const SEND_BACK_SELECTORS = ['[data-act="request-changes"]', '[data-act="revise"]', 'a.result-feedback-link[href="#request-changes"]'] as const;
/** Retry: the result's Retry, or the failed box's own Retry form. */
export const RETRY_SELECTORS = ['[data-act="retry"]', 'form[data-retry] button[type="submit"]', 'form[data-rebuild] button[type="submit"]'] as const;
/** Plan it: the task page's own plan button (local-owner slice 2). */
export const PLAN_SELECTORS = ['form[action$="/plan"] button[type="submit"]'] as const;

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: "n", says: "new task", web: { kind: "go", href: "/tasks/new" }, tui: "new" },
  { keys: "a", says: "Approve or Accept (presses the button on the page)", web: { kind: "press", selectors: INK_ACT_SELECTORS }, tui: "ink" },
  { keys: "b", says: "Send back (opens its note)", web: { kind: "press", selectors: SEND_BACK_SELECTORS }, tui: "send-back" },
  { keys: "r", says: "Retry (presses the button on the page)", web: { kind: "press", selectors: RETRY_SELECTORS }, tui: "retry" },
  { keys: "p", says: "Ask for a plan (presses the button on the page)", web: { kind: "press", selectors: PLAN_SELECTORS }, tui: "plan" },
  { keys: "/", says: "search", web: { kind: "search" }, tui: { none: "The terminal has no search; press w to open the console." } },
  { keys: "g h", says: "go Home", web: { kind: "go", href: "/" }, tui: "list" },
  { keys: "g t", says: "go to Tasks", web: { kind: "go", href: "/tasks" }, tui: "list" },
  { keys: "?", says: "these shortcuts", web: { kind: "help" }, tui: "help" },
];

/** The keys typed, as the help list shows them: "g h" reads "g then h". */
export const keyWords = (keys: string): string => keys.split(" ").join(" then ");

/**
 * The console's key routing, as an inline script (it runs inside chromeScript's closure, which defines `show` for the
 * jump-to palette, `toggleHelp`, `helpOpen`, `close` and `go`). Generated from SHORTCUTS, so the table is the only
 * place a key is defined.
 */
export function webKeymapScript(): string {
  const single: Record<string, WebShortcut> = {}, after: Record<string, WebShortcut> = {};
  for (const one of SHORTCUTS) {
    const parts = one.keys.split(" ");
    if (parts.length === 1) single[parts[0]!] = one.web;
    else if (parts[0] === "g") after[parts[1]!] = one.web;
  }
  return `var KEYS=${JSON.stringify(single)},GKEYS=${JSON.stringify(after)};` +
    // A control a person could press right now: rendered, shown, and not disabled.
    `function pressable(el){if(!el||el.disabled||el.getAttribute("aria-disabled")==="true")return false;` +
    `if(el.closest("[hidden],[inert]"))return false;var r=el.getClientRects();return r.length>0;}` +
    // Press it exactly as a click would; a submit whose form isn't complete (an empty password, a required reason)
    // shows the browser's own prompt for it instead of posting.
    `function press(selectors){for(var s=0;s<selectors.length;s++){var all=document.querySelectorAll(selectors[s]);` +
    `for(var i=0;i<all.length;i++){var el=all[i];if(!pressable(el))continue;` +
    `var form=el.form||null;var submits=el.tagName.toLowerCase()==="button"&&(el.type==="submit"||el.getAttribute("type")===null)&&form;` +
    `if(submits&&!form.checkValidity()){form.reportValidity();return true;}` +
    `el.click();return true;}}return false;}` +
    `function search(){if(document.querySelector("[data-workspace-shell]")){window.dispatchEvent(new CustomEvent("so:open-search",{detail:document.activeElement}));return;}show();}` +
    `function run(act){if(act.kind==="go"){go(act.href);return true;}if(act.kind==="press")return press(act.selectors);` +
    `if(act.kind==="search"){search();return true;}if(act.kind==="help"){toggleHelp();return true;}return false;}`;
}
