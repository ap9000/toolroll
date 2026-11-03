/**
 * Settings section forms (form.k-sform; server markup: settings-kit.ts kitSectionForm). Rules: src/design/KIT.md
 * "Focus, overlays, outcomes" and "An approval covers exactly what was shown". Without this script each one is a plain
 * form: its proof field shows in place and Save posts. With it:
 *
 * - A settings section (`data-k-gate`) shows Save only once something in it changed, and its bar says what changed.
 *   The section edited last carries the one ink Save; another changed section keeps an outline Save.
 * - Save takes ONE validated snapshot of the form when it is pressed. The password popover's terms and the posted
 *   values both come from that snapshot, never from live fields.
 * - The password is asked only when the form carries a proof field (the server leaves it out when the rules don't need
 *   one: Passwordless, a CSRF-only act) and, for a conditional proof (`data-k-proof-if`), only when the snapshot posts
 *   that value. However the popover goes away it settles as cancelled and releases the form.
 * - One pending save per form: a second press does nothing until the first settles.
 * - The snapshot is posted with fetch (same origin, the form's own CSRF field). A handler's refusal shows next to Save,
 *   the edits stay, and Save is free again; success opens the page the server answered with. Anything that proves
 *   nothing (a network failure, a server error, a sign-in page) is unconfirmed: the form stays pending and the page
 *   opens again with ?unconfirmed=<form id>, where the server says so in that section. A form whose answer is a page
 *   of its own (`data-k-native`: a one-time secret, a review) posts as a navigation instead.
 * - A save that opens a new page while other sections have unsaved changes asks first, in place ("Saving this will
 *   discard them"); leaving the page any other way with changes asks through the browser. Nothing is kept in Web
 *   Storage.
 *
 * Nothing here decides anything: the server proves the person, the freshness and the exact terms when the post arrives.
 */
import { KIT_ICONS, type IconShape } from "../../design/kit.js";
import { openOverlay } from "./behavior.js";

type SForm = HTMLFormElement & {
  kPrepped?: boolean;
  kInit?: Map<string, string[]>;
  kPending?: boolean;
  kSent?: boolean;
  kGo?: boolean;
  kClose?: (() => void) | null;
  kSnapshot?: [string, string][];
  kSubmitter?: HTMLElement | null;
};
const FORM = "form.k-sform";
/** A form's own id and action, read from its attributes: a field named "id" or "action" (an invite's id, a settings
 * act) shadows the form's properties of that name. */
const idOf = (form: HTMLFormElement): string => HTMLFormElement.prototype.getAttribute.call(form, "id") ?? "";
/** The form's controls, through the prototype's getter: a field named "elements" shadows `form.elements`. */
const elementsOf = (form: HTMLFormElement): HTMLFormControlsCollection => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "elements")!.get!.call(form) as HTMLFormControlsCollection;
const SVG = "http://www.w3.org/2000/svg";

const proofOf = (form: HTMLFormElement): HTMLElement | null => form.querySelector<HTMLElement>("[data-k-proof]");
const saveOf = (form: HTMLFormElement): HTMLButtonElement | null => form.querySelector<HTMLButtonElement>("[data-k-save]");
const proofNames = (form: HTMLFormElement): Set<string> =>
  new Set(Array.from(proofOf(form)?.querySelectorAll<HTMLInputElement>("input[name]") ?? []).map(input => input.name));

/** The form's values as posted, without its proof (and with the pressed button's name=value). */
function entriesOf(form: HTMLFormElement, submitter: HTMLElement | null = null): [string, string][] {
  const skip = proofNames(form);
  let data: FormData;
  try { data = submitter ? new FormData(form, submitter) : new FormData(form); } catch { data = new FormData(form); }
  const out: [string, string][] = [];
  data.forEach((value, name) => { if (!skip.has(name) && typeof value === "string") out.push([name, value]); });
  return out;
}
function grouped(entries: readonly [string, string][]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [name, value] of entries) map.set(name, [...(map.get(name) ?? []), value]);
  return map;
}
/** The named controls a person sees (hidden terms and the proof are not "changes"). */
function visibleNames(form: HTMLFormElement): string[] {
  const skip = proofNames(form);
  const names: string[] = [];
  for (const element of Array.from(elementsOf(form)) as HTMLInputElement[]) {
    if (!element.name || element.type === "hidden" || element.type === "submit" || element.type === "button" || skip.has(element.name)) continue;
    if (!names.includes(element.name)) names.push(element.name);
  }
  return names;
}
const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
function firstNamed(form: HTMLFormElement, name: string): HTMLInputElement | null {
  return form.querySelector<HTMLInputElement>(`[name="${CSS.escape(name)}"]`);
}
/** How a control is called on the page: its aria-label, its group's legend, its row's title, its label. */
function labelOf(form: HTMLFormElement, name: string): string {
  const element = firstNamed(form, name);
  if (element === null) return name;
  const aria = element.getAttribute("aria-label");
  if (aria) return clean(aria);
  if (element.type === "radio" || (element.type === "checkbox" && element.getAttribute("role") !== "switch")) {
    const legend = element.closest("fieldset")?.querySelector("legend");
    if (legend) return clean(legend.textContent);
  }
  const row = element.closest(".k-frow")?.querySelector(".k-frow-t");
  if (row) return clean(row.textContent);
  const label = element.labels?.[0];
  if (label) return clean(label.querySelector(".k-sl-t, b")?.textContent ?? label.textContent);
  return name;
}
/** A value as the page shows it: an option's words, a choice's label, On or Off. */
function shownOf(form: HTMLFormElement, name: string, values: readonly string[]): string {
  const element = firstNamed(form, name);
  if (element instanceof HTMLSelectElement) return clean(Array.from(element.options).find(one => one.value === values[0])?.textContent ?? values[0]);
  if (element?.type === "radio" || element?.type === "checkbox") {
    const all = Array.from(form.querySelectorAll<HTMLInputElement>(`[name="${CSS.escape(name)}"]`));
    if (element.type === "checkbox" && element.getAttribute("role") === "switch") return values.length > 0 ? "On" : "Off";
    const words = all.filter(one => values.includes(one.value)).map(one => clean(one.labels?.[0]?.querySelector("b")?.textContent ?? one.labels?.[0]?.textContent ?? one.value));
    return words.length === 0 ? "none" : words.join(", ");
  }
  const text = values[0] ?? "";
  if (element?.type === "password") return text === "" ? "unchanged" : "a new value";
  const line = text.split("\n")[0]!.trim();
  return line === "" ? "empty" : line.length > 40 ? `${line.slice(0, 39)}…` : `${line}${text.includes("\n") ? "…" : ""}`;
}
const same = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
function changedNames(form: SForm): string[] {
  const now = grouped(entriesOf(form));
  return visibleNames(form).filter(name => !same(form.kInit?.get(name), now.get(name)));
}
/** What a snapshot says: the changed fields (a section) or every field (an act), in the page's own words. */
function summaryOf(form: SForm, snapshot: readonly [string, string][]): string {
  const values = grouped(snapshot);
  const names = form.hasAttribute("data-k-gate") ? changedNames(form) : visibleNames(form);
  if (names.length > 3) return `${names.length} changes`;
  return names.map(name => `${labelOf(form, name)}: ${shownOf(form, name, values.get(name) ?? [])}`).join(" · ");
}
function proofApplies(form: HTMLFormElement, snapshot: readonly [string, string][]): boolean {
  const when = form.dataset["kProofIf"];
  if (!when) return true;
  const at = when.indexOf("=");
  return snapshot.some(([name, value]) => name === when.slice(0, at) && value === when.slice(at + 1));
}
const asksPassword = (proof: HTMLElement | null): boolean => proof !== null && proof.querySelector('input[type="password"], a.sso-step-up') !== null;

function prep(form: SForm): void {
  if (form.kPrepped) return;
  form.kPrepped = true;
  form.kInit = grouped(entriesOf(form));
  // The proof is asked in the popover: a hidden required field would block the post before Save is even pressed.
  for (const input of Array.from(proofOf(form)?.querySelectorAll<HTMLInputElement>("input[required]") ?? [])) {
    input.removeAttribute("required");
    input.dataset["kRequired"] = "";
  }
  const button = saveOf(form);
  if (button) button.dataset["kVariant"] = button.classList.contains("k-btn-danger") ? "danger" : button.classList.contains("k-btn-outline") ? "outline" : "primary";
}
function prepAll(): void { for (const form of Array.from(document.querySelectorAll<SForm>(FORM))) prep(form); }

function setVariant(button: HTMLButtonElement, variant: string): void {
  button.classList.remove("k-btn-primary", "k-btn-outline", "k-btn-danger");
  button.classList.add(`k-btn-${variant}`);
}
/** The one ink Save: the section edited last; any other changed section keeps an outline Save. */
function placePrimary(last: SForm | null): void {
  for (const form of Array.from(document.querySelectorAll<SForm>(`${FORM}[data-k-gate]`))) {
    const button = saveOf(form);
    if (!button || button.dataset["kVariant"] !== "primary") continue;
    setVariant(button, form === last || last === null ? "primary" : "outline");
  }
}
function sync(form: SForm, edited: boolean): void {
  if (!form.hasAttribute("data-k-gate")) return;
  const names = changedNames(form);
  const said = form.querySelector<HTMLElement>(".k-ssave-said");
  form.toggleAttribute("data-dirty", names.length > 0);
  if (said) {
    if (said.dataset["kIdle"] === undefined) said.dataset["kIdle"] = said.textContent ?? "";
    if (names.length === 0) said.textContent = said.dataset["kIdle"] ?? "";
    else {
      const snapshot = entriesOf(form);
      const terms = proofOf(form) !== null && asksPassword(proofOf(form)) && proofApplies(form, snapshot) ? " · Asks for your password." : "";
      said.textContent = `${summaryOf(form, snapshot)}${terms}`;
    }
  }
  if (edited) placePrimary(names.length > 0 ? form : document.querySelector<SForm>(`${FORM}[data-k-gate][data-dirty]`));
}

function icon(name: keyof typeof KIT_ICONS): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "k-i");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const shape of KIT_ICONS[name] as readonly IconShape[]) {
    const node = document.createElementNS(SVG, shape[0]);
    for (const [key, value] of Object.entries(shape[1])) node.setAttribute(key, String(value));
    svg.append(node);
  }
  return svg;
}
function button(label: string, variant: string, attrs: Record<string, string>): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `k-btn k-btn-${variant}`;
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  const face = document.createElement("span");
  face.className = "k-face";
  face.textContent = label;
  element.append(face);
  return element;
}
function busy(form: SForm, on: boolean): void {
  const save = saveOf(form);
  if (!save) return;
  const face = save.querySelector<HTMLElement>(".k-face");
  if (face && save.dataset["kLabel"] === undefined) save.dataset["kLabel"] = face.textContent ?? "";
  save.classList.toggle("busy", on);
  save.toggleAttribute("aria-busy", on);
  if (face) {
    face.replaceChildren();
    if (on) { const spin = document.createElement("span"); spin.className = "k-spin"; spin.setAttribute("aria-hidden", "true"); face.append(spin, save.dataset["kBusy"] ?? "Saving…"); }
    else face.textContent = save.dataset["kLabel"] ?? "Save";
  }
}
function clearError(form: HTMLFormElement): void {
  const slot = form.querySelector<HTMLElement>(".k-ssave-err");
  if (slot && slot.childElementCount > 0) slot.replaceChildren();
  saveOf(form)?.removeAttribute("aria-describedby");
}
/** A refusal next to Save: what happened, that the edits are still here. Save is free again; focus stays on it. */
function refused(form: SForm, message: string): void {
  form.kPending = false;
  form.kSent = false;
  busy(form, false);
  for (const input of Array.from(proofOf(form)?.querySelectorAll<HTMLInputElement>('input[type="password"]') ?? [])) input.value = "";
  const slot = form.querySelector<HTMLElement>(".k-ssave-err");
  if (slot) {
    const notice = document.createElement("p");
    notice.className = "k-notice";
    notice.setAttribute("role", "alert");
    notice.append(icon("alert"));
    const words = document.createElement("span");
    words.textContent = message;
    notice.append(words);
    slot.replaceChildren(notice);
    if (!slot.id) slot.id = `${idOf(form) || "k-sform"}-err`;
    saveOf(form)?.setAttribute("aria-describedby", slot.id);
    (form.querySelector(".k-ssave") ?? slot).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  }
  saveOf(form)?.focus({ preventScroll: true });
}
const sentence = (text: string): string => { const t = clean(text); return t === "" ? t : `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`; };
const kept = (message: string): string => `${sentence(message)} Your edits are still here.`;
/** The words of a refusal page (chrome.ts refuse, or a page that answered with its own problem). */
function problemIn(page: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(page, "text/html");
    const found = doc.querySelector(".k-notice[role=alert] span, .problem, .k-notice[role=alert], [role=alert]");
    const text = clean(found?.textContent);
    return text === "" ? null : text.slice(0, 400);
  } catch { return null; }
}

// ---- leaving the page --------------------------------------------------------------------------------------------
// Saving a section opens the page the server answered with, which drops every other section's unsaved changes. So a
// save with other changed sections asks first, in place (discardFirst), and leaving the page any other way with
// changes asks through the browser (beforeunload). Nothing is ever kept in Web Storage.
let leaving = false;
const sectionName = (form: HTMLFormElement): string => clean(form.closest("section")?.querySelector("h3")?.childNodes[0]?.textContent ?? form.closest("section")?.querySelector("h3")?.textContent) || "a section";
const otherChanged = (form: HTMLFormElement): SForm[] => Array.from(document.querySelectorAll<SForm>(`${FORM}[data-k-gate][data-dirty]`)).filter(one => one !== form);
/** The same page again, saying the save of `form` couldn't be confirmed: the server draws that note in the section. */
function unconfirmedHref(form: HTMLFormElement): string {
  const here = new URL(window.location.href);
  for (const key of ["said", "problem", "unconfirmed"]) here.searchParams.delete(key);
  here.searchParams.set("unconfirmed", idOf(form));
  const anchor = form.closest("section[id]")?.id;
  return `${here.pathname}${here.search}${anchor ? `#${anchor}` : ""}`;
}

/** Where the post goes: the pressed button's own formaction (Check again, Remove), else the form's. Read from the
 * attribute: a form with a field named "action" (many settings forms post one) shadows `form.action` with that field. */
export const actionOf = (form: HTMLFormElement, submitter: HTMLElement | null): string =>
  submitter instanceof HTMLButtonElement && submitter.form === form && submitter.hasAttribute("formaction") ? submitter.formAction
    : new URL(HTMLFormElement.prototype.getAttribute.call(form, "action") ?? "", window.location.href).href;

/** The post may have landed but its answer never arrived (a network failure, a server error, the page after the
 * redirect failing, a sign-in page): never "nothing was saved". The form stays pending and the same page opens again
 * with ?unconfirmed=<form id>, where the server says so in this section and shows what is stored now. */
function unconfirmed(form: SForm): void {
  leaving = true;
  window.location.assign(idOf(form) ? unconfirmedHref(form) : window.location.href);
}

async function post(form: SForm, snapshot: readonly [string, string][], proof: readonly [string, string][], submitter: HTMLElement | null): Promise<void> {
  busy(form, true);
  const body = new URLSearchParams();
  for (const [name, value] of [...snapshot, ...proof]) body.append(name, value);
  const action = actionOf(form, submitter);
  let response: Response;
  try {
    response = await fetch(action, { method: "POST", body, credentials: "same-origin", redirect: "follow", headers: { accept: "text/html" } });
  } catch {
    unconfirmed(form);
    return;
  }
  const landed = new URL(response.url || action, window.location.href);
  // Landing anywhere unexpected (another site, the sign-in page) proves nothing about the post: unconfirmed.
  if (landed.origin !== window.location.origin || landed.pathname === "/login") { unconfirmed(form); return; }
  // A handler's own refusal: back with ?problem=, or a refusal page answered directly (4xx, no redirect).
  const problem = landed.searchParams.get("problem");
  if (problem) { refused(form, kept(problem)); return; }
  if (!response.redirected && response.status >= 400 && response.status < 500) {
    const words = problemIn(await response.text().catch(() => ""));
    refused(form, kept(words ?? `Toolroll refused this (${response.status}). Nothing changed`));
    return;
  }
  // Anything else that isn't a plain success (a server error, the page after a redirect failing) is unconfirmed.
  if (!response.ok) { unconfirmed(form); return; }
  // Saved: open what the server answered with, so the page shows what is stored now.
  const here = landed.pathname === window.location.pathname;
  const anchor = form.closest("section[id]")?.id;
  leaving = true;
  const target = `${landed.pathname}${landed.search}${here && anchor ? `#${anchor}` : ""}`;
  // Opening the page we're on with only a different #anchor would just scroll, showing what was there before the
  // save: put the anchor in place and load the page again instead.
  if (response.redirected && `${landed.pathname}${landed.search}` !== `${window.location.pathname}${window.location.search}`) window.location.assign(target);
  else {
    if (response.redirected) window.history.replaceState(window.history.state, "", target);
    window.location.reload();
  }
}

function submitNative(form: SForm, submitter: HTMLElement | null): void {
  const download = form.hasAttribute("data-k-download");
  if (!download) leaving = true;
  form.kGo = true;
  try { if (submitter instanceof HTMLButtonElement && submitter.form === form) form.requestSubmit(submitter); else form.requestSubmit(); } finally { form.kGo = false; }
  if (download) {
    // A download leaves the page where it is: nothing stays pending or busy, and the typed password is cleared.
    leaving = false;
    form.kPending = false;
    form.kSent = false;
    busy(form, false);
    for (const input of Array.from(proofOf(form)?.querySelectorAll<HTMLInputElement>('input[type="password"]') ?? [])) input.value = "";
  }
}

function send(form: SForm, snapshot: readonly [string, string][], proof: readonly [string, string][], submitter: HTMLElement | null): void {
  form.kPending = true;
  if (form.hasAttribute("data-k-native")) {
    // The answer is a page of its own: post as a navigation. The page behind the popover was inert, so the form
    // holds exactly the snapshot, plus the proof just typed.
    if (!form.hasAttribute("data-k-download")) busy(form, true);
    if (form.hasAttribute("data-k-prepare")) {
      // A page script fills fields the post needs (a push subscription) before it goes: it answers `done` once, with
      // null to post or with words to show as the refusal. The pending guard holds the whole time.
      let answered = false;
      const done = (problem: string | null): void => {
        if (answered) return;
        answered = true;
        if (problem === null) submitNative(form, submitter); else refused(form, kept(problem));
      };
      form.dispatchEvent(new CustomEvent("k-prepare", { detail: { done } }));
      return;
    }
    submitNative(form, submitter);
    return;
  }
  void post(form, snapshot, proof, submitter);
}

const proofEntries = (proof: HTMLElement | null): [string, string][] =>
  Array.from(proof?.querySelectorAll<HTMLInputElement>("input[name]") ?? []).map(input => [input.name, input.value]);

function openProof(form: SForm, snapshot: [string, string][], submitter: HTMLElement | null): void {
  const proof = proofOf(form)!;
  const home = proof.nextElementSibling;
  const id = `${idOf(form) || "k-sform"}-pop`;
  const panel = document.createElement("div");
  panel.className = "k-pop";
  panel.id = id;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", `${id}-h`);
  panel.tabIndex = -1;
  const head = document.createElement("div");
  head.className = "k-pop-h";
  const title = document.createElement("h3");
  title.id = `${id}-h`;
  title.textContent = "Confirm with your password";
  const close = button("", "ghost", { "data-k-close": "", "aria-label": "Close", title: "Close" });
  close.classList.add("k-btn-sm", "k-btn-icon");
  close.replaceChildren(icon("x"));
  head.append(title, close);
  const terms = document.createElement("p");
  terms.className = "k-pop-terms";
  terms.textContent = summaryOf(form, snapshot) || clean(form.dataset["kConfirm"]);
  const why = document.createElement("p");
  why.textContent = [form.dataset["kConfirm"], form.dataset["kNote"]].filter(Boolean).map(one => sentence(one!)).join(" ");
  const acts = document.createElement("div");
  acts.className = "k-acts";
  const label = clean(saveOf(form)?.dataset["kLabel"] ?? saveOf(form)?.textContent) || "Save";
  acts.append(button(label, "primary", { "data-k-sconfirm": "" }), button("Cancel", "ghost", { "data-k-close": "" }));
  panel.append(head, terms, why, proof, acts);
  form.append(panel);
  form.kSnapshot = snapshot;
  form.kSubmitter = submitter;
  form.kPending = true;
  form.kSent = false;
  form.kClose = openOverlay(panel, submitter ?? saveOf(form), {
    onClose: () => {
      // Back where it was, whatever closed it; a cancel posts nothing and frees the form.
      if (home && home.parentElement === form) home.before(proof); else form.insertBefore(proof, form.querySelector(".k-ssave"));
      panel.remove();
      form.kClose = null;
      if (!form.kSent) {
        form.kPending = false;
        for (const input of Array.from(proof.querySelectorAll<HTMLInputElement>('input[type="password"]'))) { input.value = ""; input.setCustomValidity(""); }
      }
    },
  });
}

function confirmProof(form: SForm): void {
  const proof = proofOf(form);
  // The prompt is shown only when the proof applies, so its password is required, conditional row or not.
  const missing = Array.from(proof?.querySelectorAll<HTMLInputElement>('input[type="password"]') ?? []).find(input => input.value === "");
  if (missing) { missing.setCustomValidity("Enter your password."); missing.reportValidity(); missing.focus(); return; }
  const typed = proofEntries(proof);
  form.kSent = true;
  form.kClose?.();
  send(form, form.kSnapshot ?? [], typed, form.kSubmitter ?? null);
}

function save(form: SForm, submitter: HTMLElement | null): void {
  if (form.kPending) return;
  prep(form);
  if (form.hasAttribute("data-k-gate") && changedNames(form).length === 0 && !(submitter instanceof HTMLButtonElement && submitter.hasAttribute("formaction"))) return;
  const others = form.hasAttribute("data-k-download") ? [] : otherChanged(form);
  if (others.length > 0) { discardFirst(form, others, submitter); return; }
  go(form, submitter);
}

/** Other sections have unsaved changes and this save opens a new page: say which, in place; Cancel posts nothing. */
function discardFirst(form: SForm, others: readonly SForm[], submitter: HTMLElement | null): void {
  const names = [...new Set(others.map(sectionName))];
  const id = `${idOf(form) || "k-sform"}-discard`;
  const panel = document.createElement("div");
  panel.className = "k-pop";
  panel.id = id;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", `${id}-h`);
  panel.tabIndex = -1;
  const head = document.createElement("div");
  head.className = "k-pop-h";
  const title = document.createElement("h3");
  title.id = `${id}-h`;
  title.textContent = "Unsaved changes";
  head.append(title);
  const words = document.createElement("p");
  words.textContent = `You have unsaved changes in ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}. Saving this will discard them.`;
  const acts = document.createElement("div");
  acts.className = "k-acts";
  const yes = button("Save this anyway", "primary", { "data-k-discard": "" });
  acts.append(yes, button("Cancel", "ghost", { "data-k-close": "" }));
  panel.append(head, words, acts);
  form.append(panel);
  form.kPending = true;
  let go_ = false;
  const close = openOverlay(panel, submitter ?? saveOf(form), {
    onClose: () => {
      panel.remove();
      form.kPending = false;
      if (go_) go(form, submitter);
    },
  });
  yes.addEventListener("click", event => { event.preventDefault(); go_ = true; close(); });
  yes.focus();
}

function go(form: SForm, submitter: HTMLElement | null): void {
  clearError(form);
  const snapshot = entriesOf(form, submitter);
  // A button with its own formaction (Check again) is its own act: no Save gate, no proof of the section's.
  if (submitter instanceof HTMLButtonElement && submitter.hasAttribute("formaction")) { send(form, snapshot, [], submitter); return; }
  const proof = proofOf(form);
  if (proof !== null && proofApplies(form, snapshot) && asksPassword(proof)) { openProof(form, snapshot, submitter); return; }
  // No password to ask: an identity-provider re-check already confirmed stays in the post as its empty field.
  send(form, snapshot, proof !== null && !asksPassword(proof) ? proofEntries(proof) : [], submitter);
}

let installed = false;
/** Wire the section forms once: delegated listeners, so forms the workspace places later work too. */
export function installSectionForms(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.documentElement.classList.add("k-js");
  const prepAt = (event: Event): void => { const form = (event.target as Element | null)?.closest?.(FORM); if (form) prep(form as SForm); };
  document.addEventListener("focusin", prepAt, true);
  document.addEventListener("pointerdown", prepAt, true);
  const changed = (event: Event): void => {
    const target = event.target as HTMLInputElement | null;
    const form = target?.form as SForm | null | undefined;
    if (!form || !form.matches(FORM) || target!.closest("[data-k-proof], .k-pop")) {
      if (target?.type === "password") target.setCustomValidity("");
      return;
    }
    prep(form);
    clearError(form);
    sync(form, true);
  };
  document.addEventListener("input", changed);
  document.addEventListener("change", changed);
  document.addEventListener("submit", event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches(FORM)) return;
    const own = form as SForm;
    if (own.kGo) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // Enter in the popover's password field confirms it.
    if (own.kClose) { confirmProof(own); return; }
    save(own, (event as SubmitEvent).submitter ?? null);
  }, true);
  document.addEventListener("click", event => {
    const confirm = (event.target as Element | null)?.closest?.("[data-k-sconfirm]");
    if (!confirm) return;
    const form = confirm.closest(FORM) as SForm | null;
    if (form) { event.preventDefault(); confirmProof(form); }
  });
  // Back to this page from the history: nothing is pending any more.
  window.addEventListener("pageshow", () => {
    leaving = false;
    for (const form of Array.from(document.querySelectorAll<SForm>(FORM))) { form.kPending = false; form.kSent = false; busy(form, false); }
  });
  window.addEventListener("standing-orders:workspace-rendered", prepAll);
  // Leaving with sections changed and not saved asks first (the page's own saves keep them instead).
  window.addEventListener("beforeunload", event => {
    if (leaving || document.querySelector(`${FORM}[data-k-gate][data-dirty]`) === null) return;
    event.preventDefault();
  });
  prepAll();
}
