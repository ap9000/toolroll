/**
 * Reviewing a result on its task page, run by the app (docs/plans/task-page-in-app.md §4). It is the app's version of
 * `reviewEvidenceScript` (server/render-results.ts) and the task-page arm of `RESULT_REVIEW_SCRIPT` (result-review.ts),
 * kept the same by one test table that runs against both: the result's sections, the diff's two modes, the line and
 * file pins, screenshot feedback, the feedback draft (the same storage keys and shapes, so a draft written by one form
 * is read by the other) and the request's identity.
 *
 * Bound once, to the result the page opened with: the task view never swaps a newer result in under the person's
 * hands, and a re-read never restarts this (a draft, a request identity and the open section are never reset by one).
 * Where the string listens on the whole document, this listens on that result's panel, and every listener and timer
 * ends with `signal`, so the next page shown in place is never acted on by this one.
 *
 * Not here, on purpose: the reading position (the workspace scrolls an inner pane, and navigation keeps each history
 * entry's place there), and the chat page's arm (chat pages keep the string). The mark that arm reads is still left
 * on the way out, so a conversation opened from a result finds it whichever form the result page had.
 */
import { replaceAddress } from "../navigate.js";

export type ResultDeps = { replaceAddress: (url: string) => void; confirm: (text: string) => boolean };

const DRAFT = "standing-orders:review-draft:";
const SCROLL = "standing-orders:result-scroll:";
const DAY = 86_400_000;

type Kept = Record<string, unknown>;
type Field = HTMLInputElement | HTMLTextAreaElement;

export function resultWork(signal: AbortSignal, deps: ResultDeps = { replaceAddress: url => { replaceAddress(url); }, confirm: text => window.confirm(text) }): void {
  if (signal.aborted) return;
  const panel = document.querySelector<HTMLElement>("[data-result-panel]");
  const user = panel?.getAttribute("data-result-user") || "";
  const task = panel?.getAttribute("data-result-task") || "";
  const run = panel?.getAttribute("data-result-run") || "";
  // The address parameter that holds the result's own view: 'tab' on its page, 'section' on a task page's Result tab.
  const viewParam = panel?.getAttribute("data-result-param") === "section" ? "section" : "tab";
  let storage = true;
  const read = (key: string): Kept | null => {
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(key) || "null");
      return typeof value === "object" && value !== null ? value as Kept : null;
    } catch { return null; }
  };
  const write = (key: string, value: Kept | null): void => {
    try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); } catch { storage = false; }
  };
  // Prune: anything older than a day, and anything another account left on this tab.
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (!key || !(key.startsWith(DRAFT) || key.startsWith(SCROLL))) continue;
      const item = read(key), owner = key.split(":")[2] || "";
      if (item === null || typeof item["at"] !== "number" || item["at"] < Date.now() - DAY || (user && owner !== user)) sessionStorage.removeItem(key);
    }
  } catch { storage = false; }
  if (panel === null) return;

  const timers = new Set<ReturnType<typeof setTimeout>>();
  signal.addEventListener("abort", () => { for (const timer of timers) clearTimeout(timer); timers.clear(); }, { once: true });
  // Leaving the result marks the way back, as the string's `pagehide` does: a conversation opened from here reads the
  // mark to return the reader to their place in it. In the app a page is also left without the document going, so the
  // mark is left then too. (A time and nothing else: no position is taken at the moment of leaving.)
  if (user !== "" && task !== "") {
    const mark = (): void => { write(`${SCROLL}${user}:${task}:return`, { at: Date.now() }); };
    window.addEventListener("pagehide", mark, { signal });
    signal.addEventListener("abort", mark, { once: true });
  }
  const later = (run: () => void): void => {
    const timer = setTimeout(() => { timers.delete(timer); if (!signal.aborted) run(); }, 0);
    timers.add(timer);
  };
  const within = (event: Event, selector: string): HTMLElement | null => {
    const found = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
    return found !== null && panel.contains(found) ? found : null;
  };
  const reduced = (): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- sections ---------------------------------------------------------------------------------------------------
  const tabs = [...panel.querySelectorAll<HTMLElement>("[data-result-tab]")];
  const views = [...panel.querySelectorAll<HTMLElement>("[data-result-view]")];
  const show = (name: string): void => {
    const tabField = panel.querySelector<HTMLInputElement>('#comment-form input[name="tab"]');
    if (tabField !== null) tabField.value = name;
    for (const view of views) view.hidden = view.getAttribute("data-result-view") !== name;
    for (const tab of tabs) {
      const on = tab.getAttribute("data-result-tab") === name;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
    }
  };
  for (const tab of tabs) {
    tab.addEventListener("click", event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      const name = tab.getAttribute("data-result-tab") || "";
      show(name);
      // The address names the section, so a reload and Back land on it. Through navigation: the entry and its saved
      // place stay this page's.
      try { const url = new URL(window.location.href); url.searchParams.set(viewParam, name); url.hash = ""; deps.replaceAddress(url.toString()); } catch { /* the section is shown either way */ }
    }, { signal });
    tab.addEventListener("keydown", event => {
      const at = tabs.indexOf(tab);
      const next = event.key === "ArrowRight" ? tabs[(at + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(at - 1 + tabs.length) % tabs.length]
        : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
      if (next === undefined) return;
      event.preventDefault();
      next.focus();
      next.click();
    }, { signal });
  }
  // The primary review act opens the Checks section it names (reviewEvidenceScript).
  const evidence = document.querySelector<HTMLElement>("[data-open-evidence]");
  const checks = panel.querySelector<HTMLElement>('[data-result-tab="checks"]');
  if (evidence !== null && checks !== null) {
    evidence.addEventListener("click", event => {
      event.preventDefault();
      checks.click();
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }, { signal });
  }

  // ---- diff modes and line pins -----------------------------------------------------------------------------------
  const review = panel.querySelector<HTMLElement>("[data-review-diff]");
  if (review !== null) {
    review.setAttribute("data-mode", "view");
    review.addEventListener("click", event => {
      const mode = event.target instanceof Element ? event.target.closest("button[data-diff-mode]") : null;
      if (mode === null) return;
      review.setAttribute("data-mode", mode.getAttribute("data-diff-mode") === "annotate" ? "annotate" : "view");
      for (const one of review.querySelectorAll("button[data-diff-mode]")) one.setAttribute("aria-pressed", String(one === mode));
    }, { signal });
  }
  // The feedback form waits behind "Request changes"; anything that points at it (a line pin, the result's own link, a
  // saved draft) opens it first.
  const form = panel.querySelector<HTMLFormElement>("#comment-form");
  const formShell = form?.closest<HTMLDetailsElement>("details.result-request-open") ?? null;
  const openForm = (): void => { if (formShell !== null && !formShell.open) formShell.open = true; };
  if (formShell !== null && window.location.hash === "#request-changes") openForm();
  panel.addEventListener("click", event => { if (within(event, 'a[href="#request-changes"]') !== null) openForm(); }, { signal });
  if (form === null) return;

  const noteBox = form.querySelector<Field>("[name=note]"), pathBox = form.querySelector<Field>("[name=path]"), lineBox = form.querySelector<Field>("[name=line]");
  const pin = form.querySelector<HTMLDetailsElement>("details.result-pin");
  const imageBox = form.querySelector<Field>("[name=image]"), imagePreview = form.querySelector<HTMLElement>("[data-feedback-image]");
  const limit = panel.querySelector<HTMLElement>("#comment-note-limit"), requestBox = form.querySelector<Field>("[name=request]");
  const showImage = (): void => {
    if (imageBox === null || imagePreview === null) return;
    imagePreview.hidden = !imageBox.value;
    const img = imagePreview.querySelector("img"), caption = imagePreview.querySelector("figcaption");
    if (img === null || caption === null) return;
    // Only a screenshot this result itself offers: the address is built from that button's own identity.
    let selected: Element | null = null, identity: { run?: unknown; artifact?: unknown } | null = null;
    for (const button of panel.querySelectorAll("[data-comment-image]")) if (button.getAttribute("data-comment-image") === imageBox.value) selected = button;
    if (selected !== null) { try { identity = JSON.parse(imageBox.value) as { run?: unknown; artifact?: unknown }; } catch { selected = null; } }
    img.hidden = selected === null;
    if (selected !== null && identity !== null) {
      img.src = `/r/${String(identity.run)}/evidence/${String(identity.artifact)}`;
      img.alt = selected.getAttribute("data-image-caption") ?? "";
      caption.textContent = `${img.alt} · Screenshot ${String(identity.artifact)}`;
    } else {
      img.removeAttribute("src");
      caption.textContent = "This screenshot is unavailable. Restore it or remove it from your feedback.";
    }
  };
  panel.addEventListener("click", event => {
    const button = within(event, "[data-comment-image],[data-remove-image]");
    if (button === null || imageBox === null) return;
    event.preventDefault();
    imageBox.value = button.getAttribute("data-comment-image") || "";
    showImage();
    openForm();
    save();
    if (noteBox !== null) {
      noteBox.dispatchEvent(new Event("input", { bubbles: true }));
      noteBox.scrollIntoView({ block: "center", behavior: "instant" });
      noteBox.focus();
    }
  }, { signal });
  const updateActions = (): void => {
    const typed = noteBox !== null && noteBox.value.trim() !== "", batch = form.querySelector<Field>("[name=batch]");
    const requestAction = form.querySelector<HTMLButtonElement>("[data-request-changes]"), saveAction = form.querySelector<HTMLButtonElement>("[data-save-feedback]");
    if (requestAction !== null) requestAction.disabled = !typed && !(batch !== null && batch.value !== "");
    if (saveAction !== null) saveAction.disabled = !typed;
  };
  updateActions();
  noteBox?.addEventListener("input", updateActions, { signal });
  if (noteBox !== null && limit !== null && noteBox.maxLength > 0) {
    const tally = (): void => {
      limit.textContent = noteBox.value.length === 0 ? `up to ${noteBox.maxLength} characters` : `${noteBox.value.length} of ${noteBox.maxLength} characters`;
    };
    tally();
    noteBox.addEventListener("input", tally, { signal });
  }
  panel.addEventListener("click", event => {
    const button = within(event, "button.pick-file,button.pick-line");
    if (button === null) return;
    const reviewNote = button.getAttribute("data-review-note");
    if (reviewNote !== null && noteBox !== null && noteBox.value && !deps.confirm("Replace the feedback draft with this note?")) return;
    if (reviewNote !== null && noteBox !== null) noteBox.value = reviewNote;
    if (pathBox !== null) pathBox.value = button.getAttribute("data-path") || "";
    if (lineBox !== null) lineBox.value = button.getAttribute("data-line") || "";
    if (pin !== null) pin.open = true;
    openForm();
    save();
    form.scrollIntoView({ behavior: reduced() ? "instant" : "smooth", block: "center" });
    if (noteBox !== null) { noteBox.dispatchEvent(new Event("input", { bubbles: true })); noteBox.focus(); }
  }, { signal });

  // The bounded draft: this account, this task, this run.
  const draftKey = `${DRAFT}${user}:${task}:${run}`;
  let noted: string | null = null, conflict: string | null = null;
  try { const here = new URL(window.location.href); noted = here.searchParams.get("noted"); conflict = here.searchParams.get("conflict"); } catch { /* no receipt to read */ }
  let saved = read(draftKey);
  const recorded = form.querySelector<Field>("[data-recorded-requests]");
  if (saved !== null && saved["request"] !== conflict && recorded !== null && recorded.value.split(",").includes(String(saved["request"]))) { write(draftKey, null); saved = null; }
  if (saved !== null && noted && saved["request"] === noted) { write(draftKey, null); saved = null; }
  // A fresh request identity: 16 random bytes as hex, the server's own shape.
  const mint = (): string => {
    const bytes = new Uint8Array(16);
    try { crypto.getRandomValues(bytes); } catch { for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256); }
    return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  };
  const payload = (): string => JSON.stringify([noteBox?.value ?? "", pathBox?.value ?? "", lineBox?.value ?? "", imageBox?.value ?? ""]);
  // What the current identity was last submitted with (null: never sent), and what it was last shown with.
  let sent: string | null = null, bound: string | null = null;
  // The server refused this identity for a different note or another result: the words stay, the identity does not.
  if (saved !== null && conflict && saved["request"] === conflict) { saved = { ...saved, request: mint(), sent: null }; write(draftKey, saved); }
  // The receipt lands with a fragment: browsers skip autofocus on a fragment address and move focus to the fragment's
  // target on load, so the just-posted form's note box is focused after that step. A page opened in place has no load
  // to wait for.
  if (noted && noteBox !== null && !noteBox.value) {
    openForm();
    const focusNote = (): void => later(() => noteBox.focus({ preventScroll: true }));
    if (document.readyState === "complete") focusNote(); else window.addEventListener("load", focusNote, { signal, once: true });
  }
  if (saved !== null && typeof saved["note"] === "string" && saved["note"].length <= (noteBox !== null ? noteBox.maxLength : 4000)) {
    if (noteBox !== null && !noteBox.value) noteBox.value = saved["note"];
    if (saved["note"]) openForm();
    if (pathBox !== null && !pathBox.value && typeof saved["path"] === "string") pathBox.value = saved["path"];
    if (lineBox !== null && !lineBox.value && typeof saved["line"] === "string") lineBox.value = saved["line"];
    if (pin !== null && ((pathBox !== null && pathBox.value) || (lineBox !== null && lineBox.value))) pin.open = true;
    if (typeof saved["request"] === "string" && /^[a-f0-9]{32}$/.test(saved["request"]) && requestBox !== null) requestBox.value = saved["request"];
    if (typeof saved["sent"] === "string") sent = saved["sent"];
    if (imageBox !== null && typeof saved["image"] === "string" && saved["image"].length < 250) imageBox.value = saved["image"];
    showImage();
    bound = JSON.stringify([saved["note"], saved["path"] || "", saved["line"] || "", saved["image"] || ""]);
    noteBox?.dispatchEvent(new Event("input"));
  }
  function save(): void {
    const note = noteBox?.value ?? "", path = pathBox?.value ?? "", line = lineBox?.value ?? "";
    // Bind every payload seen, including FormData sent without a submit event. A changed note, file, line or screenshot
    // always gets a new identity.
    const current = payload();
    if ((bound !== null && current !== bound) || (sent !== null && current !== sent)) { sent = null; if (requestBox !== null) requestBox.value = mint(); }
    bound = current;
    if (!note && !path && !line && !(imageBox !== null && imageBox.value)) { write(draftKey, null); return; }
    write(draftKey, { note, path, line, image: imageBox?.value ?? "", request: requestBox?.value ?? "", sent, at: Date.now() });
    if (!storage && limit !== null) limit.textContent = "Draft stays on this page only. Browser storage is unavailable.";
  }
  form.addEventListener("input", save, { signal });
  // A double click never posts twice; a refused post keeps the draft. Beside a conversation's own composer its latch
  // owns the busy mark, as in the string.
  const chatLatch = document.querySelector(".composer[data-chat-session]") !== null;
  form.addEventListener("submit", event => {
    save();
    // Bind the identity to exactly what is being sent.
    sent = payload();
    const draft = read(draftKey);
    if (draft !== null) write(draftKey, { ...draft, sent });
    if (chatLatch) return;
    if (form.getAttribute("aria-busy") === "true") { event.preventDefault(); return; }
    form.setAttribute("aria-busy", "true");
  }, { signal });
  window.addEventListener("pageshow", () => form.removeAttribute("aria-busy"), { signal });
}
