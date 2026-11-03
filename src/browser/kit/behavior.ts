/**
 * The revamp kit's behaviour (src/design/KIT.md), one implementation for both kinds of page: the React kit
 * (./k-*.tsx) calls these functions, and installKitBehavior wires the same behaviour onto kit markup a server
 * page renders (server/kit.ts) once the workspace places it. Every control still works as plain HTML without it.
 *
 * - The composer grows from its rows to its max rows, then scrolls, and keeps "has text" (the send's ink state).
 * - A gated send (a message box) does nothing while the box is empty.
 * - The phone keyboard: html.kb-open and --kb from the visual viewport, so a docked composer rides above it.
 * - Overlays (popover, drawer, sheet, menu): role=dialog, the page behind inert, Tab kept inside, Escape and the
 *   labelled Close and the scrim close the top one, focus returns to the trigger (or a visible stand-in).
 *   A popover or menu becomes a bottom sheet on a phone. One at a time, except an approval asked from inside an
 *   open overlay, which stacks over it.
 * - A button switch (button.k-switch[role=switch][data-k-switch]) flips and says its new state.
 */

const PHONE = "(max-width: 760px)";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
export const isPhone = (): boolean => typeof window !== "undefined" && window.matchMedia(PHONE).matches;
const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- composer ---------------------------------------------------------------------------------------------------

/** Grow the box with its text (rows → max rows, then scroll) and keep "has text" and a gated send in step. */
export function composerSync(textarea: HTMLTextAreaElement): void {
  const box = textarea.closest<HTMLElement>(".k-composer");
  if (box === null) return;
  const style = getComputedStyle(textarea);
  const line = parseFloat(style.lineHeight) || 21;
  const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const max = line * (Number(textarea.dataset["max"]) || 8) + pad;
  const min = line * (Number(textarea.dataset["min"]) || 1) + pad;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(min, Math.min(textarea.scrollHeight, max))}px`;
  textarea.style.overflowY = textarea.scrollHeight > max + 1 ? "auto" : "hidden";
  const on = textarea.value.trim() !== "";
  box.classList.toggle("has-text", on);
  for (const send of box.querySelectorAll<HTMLButtonElement>(".k-send[data-gate]:not(:disabled)")) send.setAttribute("aria-disabled", String(!on));
}

/** Show or clear the composer's refusal under the whole box; the words stay in it. */
export function composerError(id: string, message: string | null): void {
  const slot = document.getElementById(`${id}-err`);
  const textarea = document.getElementById(`${id}-text`);
  if (slot) slot.textContent = message ?? "";
  if (textarea) {
    if (message) textarea.setAttribute("aria-invalid", "true");
    else textarea.removeAttribute("aria-invalid");
  }
}

/** Swap the send for Stop while the work runs (the icon morphs; nothing fades). */
export function composerWorking(id: string, working: boolean): void {
  const box = document.querySelector<HTMLElement>(`[data-k-composer="${CSS.escape(id)}"]`);
  if (!box) return;
  if (box.classList.contains("working") && !working) box.classList.add("was-working");
  box.classList.toggle("working", working);
}

// ---- the phone keyboard -----------------------------------------------------------------------------------------

/** The visual viewport shrinks when the on-screen keyboard opens: --kb is how much of the layout it covers. */
export function trackKeyboard(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
  document.documentElement.style.setProperty("--kb", `${covered}px`);
  document.documentElement.classList.toggle("kb-open", covered > 80);
}

// ---- overlays ---------------------------------------------------------------------------------------------------

type Open = {
  panel: HTMLElement;
  scrim: HTMLElement;
  trigger: HTMLElement | null;
  inerted: HTMLElement[];
  /** The panel and ancestors an overlay underneath had made inert: released while this one is open, inert again after. */
  released: HTMLElement[];
  onClose: ((how: "close" | "escape" | "scrim" | "removed") => void) | undefined;
};
const stack: Open[] = [];

/** Place a popover beside its trigger at a desk (below, or above when there is no room). */
export function anchor(panel: HTMLElement, trigger: HTMLElement | null): void {
  if (trigger === null || !trigger.isConnected) return;
  const at = trigger.getBoundingClientRect();
  const width = panel.offsetWidth || 336;
  const height = panel.offsetHeight || 200;
  const left = Math.min(Math.max(8, at.right - width), window.innerWidth - width - 8);
  const below = at.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, at.top - height - 6) : below;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.setProperty("--origin", `${at.right - left}px ${top >= below ? 0 : height}px`);
}

/**
 * Open a kit overlay panel (.k-pop, .k-drawer, .k-sheet; a menu is a .k-pop.k-pop-menu). Returns a function that
 * closes it. `stacked` opens it over an overlay already open (an approval asked from inside a drawer).
 */
export function openOverlay(panel: HTMLElement, trigger: HTMLElement | null, options: { dim?: boolean; onClose?: Open["onClose"] } = {}): () => void {
  const stacked = stack.length > 0;
  if (stacked && !panel.classList.contains("k-pop")) closeAll("close");
  const floating = panel.classList.contains("k-pop");
  const phone = isPhone();
  // The panel stays where it is (a server approval form inside a GuardedHtml region stays guarded); the scrim sits
  // just before it, in the same stacking context. A panel not yet in the document goes to the body.
  if (!panel.isConnected) document.body.append(panel);
  const scrim = document.createElement("div");
  scrim.className = `k-scrim${options.dim ?? (!floating || phone) ? " dim" : ""}${stack.length > 0 ? " stacked" : ""}`;
  panel.before(scrim);
  panel.hidden = false;
  panel.setAttribute("role", panel.getAttribute("role") ?? "dialog");
  panel.setAttribute("aria-modal", "true");
  if (!panel.hasAttribute("tabindex")) panel.tabIndex = -1;
  panel.classList.toggle("stacked", stack.length > 0);
  panel.classList.toggle("as-sheet", floating && phone);
  if (floating && !phone) anchor(panel, trigger);
  if (!reducedMotion()) { panel.classList.remove("k-grow-in"); void panel.offsetWidth; panel.classList.add("k-grow-in"); }
  // A panel an overlay underneath made inert (a pre-rendered sibling, or inside an inert ancestor) is released first.
  const released: HTMLElement[] = [];
  for (let node: HTMLElement | null = panel; node && node !== document.body; node = node.parentElement) {
    if (node.inert) { node.inert = false; released.push(node); }
  }
  // Everything but the panel goes inert: the siblings of the panel and of each of its ancestors up to the body.
  const inerted: HTMLElement[] = [];
  for (let node: HTMLElement = panel; node !== document.body && node.parentElement; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children) as HTMLElement[]) {
      if (sibling === node || sibling === scrim || sibling.inert) continue;
      sibling.inert = true;
      inerted.push(sibling);
    }
  }
  const entry: Open = { panel, scrim, trigger, inerted, released, onClose: options.onClose };
  watchRemovals();
  stack.push(entry);
  scrim.addEventListener("click", () => close(entry, "scrim"));
  (panel.querySelector<HTMLElement>("[autofocus]") ?? panel.querySelector<HTMLElement>(`input:not([type="hidden"]), textarea, select`) ?? panel).focus();
  return () => close(entry, "close");
}

function close(entry: Open, how: "close" | "escape" | "scrim" | "removed"): void {
  const at = stack.indexOf(entry);
  if (at < 0) return;
  // Anything stacked over this one goes with it, and settles as cancelled.
  for (const over of stack.slice(at + 1).reverse()) close(over, "removed");
  stack.splice(at, 1);
  if (stack.length === 0) { observer?.disconnect(); observer = null; }
  for (const element of entry.inerted) element.inert = false;
  for (const element of entry.released) if (element.isConnected) element.inert = true;
  entry.scrim.remove();
  entry.panel.hidden = true;
  entry.panel.classList.remove("k-grow-in", "as-sheet", "stacked");
  restoreFocus(entry.trigger);
  entry.onClose?.(how);
}

/** An overlay whose panel a re-render or navigation removed settles as cancelled and gives the page back: its scrim
 * goes and nothing stays inert. Checked on every DOM change while an overlay is open, and on workspace-rendered. */
export function releaseRemoved(): void {
  for (const entry of stack.slice().reverse()) if (!entry.panel.isConnected) close(entry, "removed");
  if (stack.length === 0) { observer?.disconnect(); observer = null; }
}
let observer: MutationObserver | null = null;
function watchRemovals(): void {
  if (observer !== null || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver(() => { if (stack.some(entry => !entry.panel.isConnected)) releaseRemoved(); });
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Close every open overlay (a navigation, a re-render): each settles as cancelled. */
export function closeAll(how: "close" | "removed" = "removed"): void {
  for (const entry of stack.slice().reverse()) close(entry, how);
}

function visible(element: HTMLElement | null | undefined): element is HTMLElement {
  return element !== null && element !== undefined && element.isConnected && element.getClientRects().length > 0;
}
/** Focus goes back to the trigger; if it is gone or hidden at this width, to a visible match, then the dock's primary. */
function restoreFocus(trigger: HTMLElement | null): void {
  const open = trigger?.getAttribute("data-k-open");
  if (visible(trigger)) { trigger.focus(); return; }
  const twin = open ? Array.from(document.querySelectorAll<HTMLElement>(`[data-k-open="${CSS.escape(open)}"]`)).find(visible) : undefined;
  (twin ?? Array.from(document.querySelectorAll<HTMLElement>(".k-dock .k-btn")).find(visible))?.focus();
}

function trapTab(event: KeyboardEvent): void {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (event.key === "Escape") { event.preventDefault(); close(top, "escape"); return; }
  if (event.key !== "Tab") return;
  const items = Array.from(top.panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
  if (items.length === 0) { event.preventDefault(); top.panel.focus(); return; }
  const first = items[0]!, last = items[items.length - 1]!;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === top.panel)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

// ---- menus a composer builds ------------------------------------------------------------------------------------

/** A menu of actions: a popover by its trigger at a desk, a bottom sheet on a phone. */
export function openMenu(trigger: HTMLElement, title: string, items: ReadonlyArray<{ label: string; current?: boolean; act: () => void }>): () => void {
  const phone = isPhone();
  const panel = document.createElement("div");
  const titleId = `k-menu-${Math.random().toString(36).slice(2, 8)}`;
  panel.className = phone ? "k-sheet" : "k-pop k-pop-menu";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", titleId);
  const head = document.createElement("div");
  head.className = phone ? "k-sheet-h" : "k-pop-h";
  const heading = document.createElement(phone ? "h2" : "h3");
  heading.id = titleId;
  heading.textContent = title;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "k-btn k-btn-ghost k-btn-sm k-btn-icon";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.setAttribute("data-k-close", "");
  closeButton.textContent = "×";
  head.append(heading, closeButton);
  const menu = document.createElement("div");
  menu.className = "k-menu";
  let done: () => void = () => {};
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.current ? `${item.label} · current` : item.label;
    if (item.current) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => { done(); item.act(); });
    menu.append(button);
  }
  panel.append(head, menu);
  done = openOverlay(panel, trigger, { onClose: () => panel.remove() });
  return done;
}

function composerMenus(event: MouseEvent): boolean {
  const target = event.target as Element | null;
  const chip = target?.closest<HTMLButtonElement>("[data-k-composer-project]");
  const plus = target?.closest<HTMLButtonElement>("[data-k-composer-plus]");
  const id = chip?.dataset["kComposerProject"] ?? plus?.dataset["kComposerPlus"];
  if (id === undefined) return false;
  event.preventDefault();
  const hidden = document.getElementById(`${id}-project`) as HTMLInputElement | null;
  const chooseProject = (trigger: HTMLElement): void => {
    if (!hidden) return;
    let items: string[] = [];
    try { const parsed: unknown = JSON.parse(hidden.dataset["items"] ?? "[]"); if (Array.isArray(parsed)) items = parsed.filter((one): one is string => typeof one === "string"); } catch { items = []; }
    openMenu(trigger, "Project", items.map(name => ({ label: name, current: name === hidden.value, act: () => {
      hidden.value = name;
      const label = document.querySelector(`[data-k-composer-project="${CSS.escape(id)}"] [data-k-project-name]`);
      if (label) label.textContent = name;
      document.querySelector(`[data-k-composer-project="${CSS.escape(id)}"]`)?.setAttribute("aria-label", `Project: ${name}. Change`);
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    } })));
  };
  if (chip) { chooseProject(chip); return true; }
  const attach = document.querySelector<HTMLInputElement>(`input[type="file"][data-k-attach="${CSS.escape(id)}"]`);
  const items: Array<{ label: string; act: () => void }> = [];
  if (attach) items.push({ label: "Attach a file", act: () => attach.click() });
  if (hidden) items.push({ label: "Choose project", act: () => chooseProject(document.querySelector<HTMLElement>(`[data-k-composer-project="${CSS.escape(id)}"]`) ?? plus!) });
  if (items.length > 0) openMenu(plus!, "Add to your message", items);
  return true;
}

// ---- ideas ------------------------------------------------------------------------------------------------------

/** An idea (`[data-k-draft]`, server kit `ideas`) adds its words to its composer in place, after anything already typed,
 * never instead of it. Without its composer on the page the idea stays a link (it opens the page with the words). */
export function draftIdea(target: Element, event: Event): boolean {
  const idea = target.closest<HTMLElement>("[data-k-draft]");
  if (idea === null) return false;
  const box = document.getElementById(`${idea.dataset["kInto"] ?? ""}-text`);
  if (!(box instanceof HTMLTextAreaElement) || box.disabled) return true;
  event.preventDefault();
  const words = idea.dataset["kDraft"] ?? "";
  const typed = box.value;
  box.value = typed.trim() === "" ? words : typed.includes(words) ? typed : `${typed.trimEnd()}\n${words}`;
  composerSync(box);
  box.focus();
  return true;
}

// ---- install ----------------------------------------------------------------------------------------------------

let installed = false;
/** Wire the kit's behaviour onto the document once: delegated listeners, so markup placed later works too. */
export function installKitBehavior(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("input", event => {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement && target.classList.contains("k-composer-ta")) composerSync(target);
  });
  document.addEventListener("click", event => {
    const target = event.target as Element | null;
    if (target === null) return;
    const gated = target.closest<HTMLButtonElement>('.k-send[data-gate][aria-disabled="true"]');
    if (gated) { event.preventDefault(); return; }
    if (draftIdea(target, event)) return;
    if (composerMenus(event)) return;
    const opener = target.closest<HTMLElement>("[data-k-open]");
    if (opener) {
      const panel = document.getElementById(opener.dataset["kOpen"] ?? "");
      if (panel) { event.preventDefault(); openOverlay(panel, opener); }
      return;
    }
    if (target.closest("[data-k-close]")) {
      const top = stack[stack.length - 1];
      if (top && top.panel.contains(target)) { event.preventDefault(); close(top, "close"); }
      return;
    }
    const toggle = target.closest<HTMLButtonElement>("button.k-switch[role=switch][data-k-switch]");
    if (toggle) {
      const on = toggle.getAttribute("aria-checked") !== "true";
      toggle.setAttribute("aria-checked", String(on));
      const [onWord, offWord] = (toggle.dataset["kSwitch"] || "On|Off").split("|");
      const words = toggle.querySelector("[data-k-words]");
      if (words) words.textContent = (on ? onWord : offWord) ?? "";
      toggle.dispatchEvent(new CustomEvent("k-switch", { bubbles: true, detail: { on } }));
    }
  });
  document.addEventListener("keydown", trapTab, true);
  const syncAll = (): void => { releaseRemoved(); for (const textarea of document.querySelectorAll<HTMLTextAreaElement>(".k-composer-ta")) composerSync(textarea); };
  window.addEventListener("standing-orders:workspace-rendered", syncAll);
  window.visualViewport?.addEventListener("resize", trackKeyboard);
  window.visualViewport?.addEventListener("scroll", trackKeyboard);
  syncAll();
}
