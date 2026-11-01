/** The Settings journey's accessibility probes (Settings revamp S1, docs/plans/settings-revamp.md). Each probe takes a
 * Playwright page and answers a list of findings `{ probe, detail }`; an empty list is a pass. The runner calls the
 * page probes on every captured page; a step file calls the action probes (`expectFieldError`, `focusVisibleNow`,
 * `contrast`) from its own actions, after it has driven the page into the state they check.
 *
 * Probes read the page. The arrow-key probe is the one that presses keys, and it runs last. */

/** The page probes, in the order the runner runs them. `phoneOnly` probes run at phone widths only; `desktopOnly`
 * ones at desktop widths only. */
export const PAGE_PROBES = [
  { name: "one-h1", about: "exactly one h1" },
  { name: "no-overflow", about: "no sideways scroll, on the document or inside the main region" },
  { name: "targets", about: "main-region controls are at least 44px tall", phoneOnly: true },
  { name: "field-errors", about: "every aria-invalid field names its message with aria-describedby" },
  { name: "secrets", about: "secret inputs carry autocomplete=off and the password-manager opt-outs" },
  { name: "focus-visible", about: "every control reached with Tab shows a focus indicator" },
  { name: "sticky-overlap", about: "a sticky or fixed bar never covers the focused control" },
  { name: "sidebar", about: "the sidebar has the same rows on every page", desktopOnly: true },
  { name: "arrow-keys", about: "arrow keys in a choice group send no request" },
];
export const PROBE_NAMES = PAGE_PROBES.map(one => one.name);
export const TARGET_MIN = 44;
export const PHONE_MAX = 600;

/** Secret fields that aren't proofs, by form action and field name (docs/plans/settings-revamp.md §4's inventory).
 * The kit marks new ones with `data-so-secret`; a password input that isn't `current-password`/`new-password` counts
 * too. A proof field (the person's own password) is left for the password manager. */
export const SECRET_FIELDS = [
  { action: "^/settings/provider-key$", name: "value" },
  { action: "^/settings/telegram-token$", name: "token" },
  { action: "^/settings/email", name: "password" },
  { action: "^/settings/google$", name: "clientSecret" },
  { action: "^/chat/config$", name: "key" },
  { action: "^/settings/tools/", name: "value" },
];
export const PASSWORD_MANAGER_OPT_OUTS = [["data-1p-ignore", null], ["data-lpignore", "true"], ["data-bwignore", null], ["data-form-type", "other"]];

/** Everything that runs inside the page, in one function so Playwright can send it whole (no eval: pages keep CSP). */
function inPage({ which, opts }) {
  const describe = el => {
    if (el === null || el === undefined) return "(none)";
    const name = el.getAttribute?.("name"), id = el.id, label = el.getAttribute?.("aria-label");
    const text = (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const form = el.closest?.("form")?.getAttribute("action");
    return `${el.tagName.toLowerCase()}${id ? `#${id}` : ""}${name ? `[name=${name}]` : ""}${label ? `[aria-label="${label}"]` : ""}${text ? ` "${text}"` : ""}${form ? ` (form ${form})` : ""}`;
  };
  const visible = el => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    for (let at = el; at !== null; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.display === "none" || style.visibility === "hidden" || at.hasAttribute("inert") || at.getAttribute("aria-hidden") === "true") return false;
      if (at.tagName === "DETAILS" && !at.open && at !== el && !el.closest("summary")) return false;
    }
    return true;
  };
  const main = document.querySelector("#workspace-main") ?? document.querySelector("main") ?? document.querySelector(".so-main-column") ?? document.body;
  const sidebar = document.querySelector(".so-sidebar") ?? document.querySelector("aside.side");
  const CONTROLS = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=switch], [role=radio], [role=checkbox], [tabindex]:not([tabindex='-1'])";

  if (which === "one-h1") {
    const all = [...document.querySelectorAll("h1")];
    return all.length === 1 ? [] : [{ detail: all.length === 0 ? "no h1" : `${all.length} h1s: ${all.map(describe).join(", ")}` }];
  }
  if (which === "no-overflow") {
    const width = document.documentElement.clientWidth;
    const out = [];
    if (document.documentElement.scrollWidth > width + 1) out.push({ detail: `the page scrolls sideways (${document.documentElement.scrollWidth}px wide in ${width}px)` });
    // Content past the edge of the window inside the main region, unless it sits in a scroller made for that (a table
    // or code block with overflow-x auto/scroll). The workspace's sheet clips with overflow:hidden, so this is the
    // check that sees what the person can't reach.
    const meant = el => { for (let at = el.parentElement; at !== null && at !== main.parentElement; at = at.parentElement) { const x = getComputedStyle(at).overflowX; if ((x === "auto" || x === "scroll") && at.scrollWidth > at.clientWidth) return true; } return false; };
    const wide = [...main.querySelectorAll("*")].filter(el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.right > width + 1 && visible(el) && !meant(el); });
    const leaves = wide.filter(el => !wide.some(other => other !== el && el.contains(other)));
    if (leaves.length > 0) out.push({ detail: `${leaves.length} element(s) run past the right edge: ${leaves.slice(0, 4).map(el => `${describe(el)} → ${Math.round(el.getBoundingClientRect().right)}px`).join("; ")}` });
    return out;
  }
  if (which === "targets") {
    const min = opts.min;
    const target = el => {
      if (el.tagName === "INPUT" && (el.type === "radio" || el.type === "checkbox")) return el.closest("label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null) ?? el;
      return el;
    };
    const inlineInText = el => el.tagName === "A" && getComputedStyle(el).display === "inline" && [...(el.parentElement?.childNodes ?? [])].some(node => node.nodeType === 3 && node.textContent.trim() !== "");
    const short = [...new Set([...main.querySelectorAll(CONTROLS)].map(target))].filter(el => visible(el) && !inlineInText(el) && el.getBoundingClientRect().height < min - 0.5);
    return short.length === 0 ? [] : [{ detail: `${short.length} control(s) under ${min}px: ${short.slice(0, 6).map(el => `${describe(el)} ${Math.round(el.getBoundingClientRect().height)}px`).join("; ")}` }];
  }
  if (which === "field-errors" || which === "expect-field-error") {
    const invalid = [...document.querySelectorAll("[aria-invalid=true]")];
    const out = [];
    for (const el of invalid) {
      const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      const text = ids.map(id => document.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim();
      if (text === "") out.push({ detail: `${describe(el)} is aria-invalid with no aria-describedby message` });
    }
    if (which === "expect-field-error") {
      if (invalid.length === 0) out.push({ detail: "no field is aria-invalid after the validation error" });
      else if (!invalid.some(el => el === document.activeElement)) out.push({ detail: `focus is on ${describe(document.activeElement)}, not the invalid field` });
    }
    return out;
  }
  if (which === "secrets") {
    const known = (form, name) => opts.secretFields.some(one => new RegExp(one.action).test(form) && one.name === name);
    const out = [];
    for (const input of document.querySelectorAll("input")) {
      const form = input.form?.getAttribute("action") ?? "";
      const name = input.getAttribute("name") ?? "";
      const ac = (input.getAttribute("autocomplete") ?? "").trim();
      const secret = input.hasAttribute("data-so-secret") || known(form, name) || (input.type === "password" && ac !== "current-password" && ac !== "new-password");
      if (secret) {
        const missing = [...(ac === "off" ? [] : [`autocomplete="off" (has "${ac}")`]), ...opts.optOuts.filter(([attr, value]) => !input.hasAttribute(attr) || (value !== null && input.getAttribute(attr) !== value)).map(([attr, value]) => value === null ? attr : `${attr}="${value}"`)];
        if (missing.length > 0) out.push({ detail: `${describe(input)} misses ${missing.join(", ")}` });
      }
      // The SMTP username sits next to a secret: it mustn't ask the password manager for the Toolroll sign-in.
      if (/^\/settings\/email/.test(form) && /^(user|username)$/.test(name) && ac === "username") out.push({ detail: `${describe(input)} asks for autocomplete="username" (the Toolroll sign-in)` });
    }
    return out;
  }
  if (which === "focus-now") {
    // The focused element right now: inside main, visible, and painted with an indicator.
    const el = document.activeElement;
    if (el === null || el === document.body) return [{ detail: "nothing has focus" }];
    const style = getComputedStyle(el);
    const ring = (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || (style.boxShadow !== "none" && style.boxShadow !== "");
    return [{ detail: describe(el), ring, matches: el.matches(":focus-visible"), inMain: main.contains(el), box: (({ x, y, width, height }) => ({ x, y, width, height }))(el.getBoundingClientRect()) }];
  }
  if (which === "covering") {
    // Sticky or fixed elements whose box covers the given rectangle, except the focused control's own ancestors.
    const { box } = opts;
    const el = document.activeElement;
    const covers = [];
    for (const one of document.querySelectorAll("body *")) {
      const position = getComputedStyle(one).position;
      if (position !== "sticky" && position !== "fixed") continue;
      if (one.contains(el) || el.contains(one) || !visible(one)) continue;
      const r = one.getBoundingClientRect();
      const w = Math.min(r.right, box.x + box.width) - Math.max(r.left, box.x), h = Math.min(r.bottom, box.y + box.height) - Math.max(r.top, box.y);
      if (w > 2 && h > 2) covers.push(describe(one));
    }
    return covers;
  }
  if (which === "choice-groups") {
    // One focus target per radio group (native or role=radiogroup) and per select in main, marked so Playwright can
    // find it again.
    const marks = [];
    const names = new Set();
    for (const radio of main.querySelectorAll("input[type=radio]")) {
      if (names.has(radio.name) || !visible(radio.closest("label") ?? radio)) continue;
      names.add(radio.name);
      const pick = main.querySelector(`input[type=radio][name="${CSS.escape(radio.name)}"]:checked`) ?? radio;
      pick.setAttribute("data-journey-choice", String(marks.length));
      marks.push(describe(pick));
    }
    for (const group of main.querySelectorAll("[role=radiogroup]")) {
      const pick = group.querySelector("[role=radio][aria-checked=true]") ?? group.querySelector("[role=radio]");
      if (pick === null || !visible(pick)) continue;
      pick.setAttribute("data-journey-choice", String(marks.length));
      marks.push(describe(pick));
    }
    for (const select of main.querySelectorAll("select")) {
      if (!visible(select)) continue;
      select.setAttribute("data-journey-choice", String(marks.length));
      marks.push(describe(select));
    }
    return marks.slice(0, opts.limit);
  }
  if (which === "sidebar") {
    if (sidebar === null) return null;
    return [...sidebar.querySelectorAll("a[href], summary, button")].filter(el => !el.closest("[data-live], .so-nav-count")).map(el => `${el.tagName.toLowerCase()} ${(el.getAttribute("href") ?? "").split("?")[0]} ${(el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim()}`);
  }
  if (which === "contrast") {
    const parse = value => { const m = value.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = "1"] = m[1].split(/[,\s/]+/).filter(Boolean); return [Number(r), Number(g), Number(b), Number(a)]; };
    const lum = ([r, g, b]) => { const f = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const backdrop = el => { for (let at = el; at !== null; at = at.parentElement) { const c = parse(getComputedStyle(at).backgroundColor); if (c !== null && c[3] > 0.5) return c; } return [255, 255, 255, 1]; };
    const out = [];
    for (const el of document.querySelectorAll(opts.selector)) {
      const style = getComputedStyle(el);
      const fg = parse(opts.property === "border" ? style.borderTopColor : opts.property === "outline" ? style.outlineColor : style.color);
      const bg = backdrop(opts.property === "text" ? el : el.parentElement ?? el);
      if (fg === null) continue;
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio + 1e-9 < opts.min) out.push({ detail: `${describe(el)} ${opts.property} contrast ${ratio.toFixed(2)}:1 under ${opts.min}:1` });
    }
    return out;
  }
  if (which === "unroll") {
    // Full-length capture: every element that scrolls its own content vertically (the workspace sheet,
    // .so-main-column's inner scroller) and its ancestors give up their fixed heights, so the document grows to the
    // content's length. Only for the extra full-page shot; the real-scroller shots and checks run before this.
    const scrollers = [...document.querySelectorAll("*")].filter(el => { const y = getComputedStyle(el).overflowY; return (y === "auto" || y === "scroll" || y === "hidden") && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 150; });
    const loosen = el => { el.style.setProperty("overflow", "visible", "important"); el.style.setProperty("height", "auto", "important"); el.style.setProperty("max-height", "none", "important"); };
    // A phone workspace is position:fixed to the window; it goes back into the flow so the document can grow.
    const ancestor = at => { at.style.setProperty("height", "auto", "important"); at.style.setProperty("max-height", "none", "important"); at.style.setProperty("overflow", "visible", "important"); if (getComputedStyle(at).position === "fixed") { at.style.setProperty("position", "relative", "important"); at.style.setProperty("inset", "auto", "important"); } };
    for (const el of scrollers) { loosen(el); for (let at = el.parentElement; at !== null; at = at.parentElement) ancestor(at); }
    return scrollers.length;
  }
  if (which === "scroll-end") {
    // The real scroller: the deepest element that scrolls the most, else the document. Scrolls it to the end.
    const scrollers = [...document.querySelectorAll("*")].filter(el => { const y = getComputedStyle(el).overflowY; return (y === "auto" || y === "scroll") && el.scrollHeight > el.clientHeight + 1; });
    const best = scrollers.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    if (best === undefined) { const moved = document.documentElement.scrollHeight > innerHeight + 1; window.scrollTo(0, document.documentElement.scrollHeight); return moved ? "document" : null; }
    best.scrollTop = best.scrollHeight;
    return describe(best).slice(0, 80);
  }
  throw new Error(`unknown in-page probe ${which}`);
}

const run = (page, which, opts = {}) => page.evaluate(inPage, { which, opts });
const tag = (probe, findings) => findings.map(one => ({ probe, detail: one.detail }));

export const oneH1 = async page => tag("one-h1", await run(page, "one-h1"));
export const noOverflow = async page => tag("no-overflow", await run(page, "no-overflow"));
export const targets = async (page, { min = TARGET_MIN } = {}) => tag("targets", await run(page, "targets", { min }));
export const fieldErrors = async page => tag("field-errors", await run(page, "field-errors"));
export const secrets = async page => tag("secrets", await run(page, "secrets", { secretFields: SECRET_FIELDS, optOuts: PASSWORD_MANAGER_OPT_OUTS }));
/** The sidebar's rows (links, groups, buttons; counts and query strings masked), or null where the page has none. */
export const sidebarRows = page => run(page, "sidebar");

/** Tabs through the page (up to `limit` stops) and answers two probes at once: each focused control shows a focus
 * indicator (`focus-visible`), and no sticky or fixed element covers it (`sticky-overlap`). */
export async function tabWalk(page, { limit = 40 } = {}) {
  await page.evaluate(() => { document.activeElement?.blur?.(); window.getSelection?.()?.removeAllRanges(); });
  await page.locator("body").focus().catch(() => {});
  const unseen = [], covered = [];
  const seen = new Set();
  for (let at = 0; at < limit; at += 1) {
    await page.keyboard.press("Tab");
    const [now] = await run(page, "focus-now");
    if (now === undefined || now.ring === undefined) break;
    if (seen.has(now.detail + JSON.stringify(now.box))) break;
    seen.add(now.detail + JSON.stringify(now.box));
    if (!now.ring && now.matches) unseen.push(now.detail);
    if (now.inMain) { const over = await run(page, "covering", { box: now.box }); if (over.length > 0) covered.push(`${now.detail} under ${over.join(", ")}`); }
  }
  return [
    ...(unseen.length === 0 ? [] : [{ probe: "focus-visible", detail: `${unseen.length} control(s) with no focus indicator: ${unseen.slice(0, 5).join("; ")}` }]),
    ...(covered.length === 0 ? [] : [{ probe: "sticky-overlap", detail: `${covered.length} focused control(s) covered: ${covered.slice(0, 4).join("; ")}` }]),
  ];
}

/** Presses ArrowDown in each radio group and select of the main region (up to `limit`) and answers a finding for
 * every request that isn't a plain GET of a page asset, or a navigation. Leaves the page where it found it. */
export async function arrowKeys(page, { limit = 8, settleMs = 400 } = {}) {
  const url = page.url();
  const groups = await run(page, "choice-groups", { limit });
  const out = [];
  for (let at = 0; at < groups.length; at += 1) {
    const sent = [];
    const listen = request => { if (request.method() !== "GET" || request.isNavigationRequest()) sent.push(`${request.method()} ${new URL(request.url()).pathname}`); };
    page.on("request", listen);
    const target = page.locator(`[data-journey-choice="${at}"]`).first();
    if (await target.count() === 0) { page.off("request", listen); continue; }
    await target.focus().catch(() => {});
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(settleMs);
    page.off("request", listen);
    if (sent.length > 0) {
      out.push({ probe: "arrow-keys", detail: `ArrowDown on ${groups[at]} sent ${[...new Set(sent)].join(", ")}` });
      await page.goto(url).catch(() => {});
      break; // the page moved; the next groups are in a fresh page the person never saw
    }
  }
  return out;
}

/** After a forced validation error: some field is aria-invalid, names its message, and has focus. */
export const expectFieldError = async page => tag("field-errors", await run(page, "expect-field-error"));
/** Right after a dialog closes (or any action): the focused control is visible and shows a focus indicator. */
export async function focusVisibleNow(page) {
  const [now] = await run(page, "focus-now");
  if (now.ring === undefined) return [{ probe: "focus-visible", detail: now.detail }];
  return now.ring ? [] : [{ probe: "focus-visible", detail: `${now.detail} has focus with no indicator` }];
}
/** Contrast of `property` ("text", "border" or "outline") on every element matching `selector`, against the
 * nearest opaque background, at least `min`:1. */
export const contrast = async (page, { selector, property = "text", min = 4.5, probe = "contrast" }) => tag(probe, await run(page, "contrast", { selector, property, min }));

/** Scrolls the real scroller to its end (for the end-of-sheet shot); answers which element scrolled, or null. */
export const scrollToEnd = page => run(page, "scroll-end");
/** Unrolls inner scrollers for the full-length shot; answers how many it loosened. Run after every real-scroller check. */
export const unroll = page => run(page, "unroll");

/** The read-only page probes for one page at one width, in order. `sidebar` is compared across pages by the runner,
 * and `arrowKeys` says whether the runner should press keys last, on a freshly loaded copy of the page. */
export async function probePage(page, { width, skip = [] }) {
  const want = name => !skip.includes(name) && PAGE_PROBES.some(one => one.name === name && !(one.phoneOnly && width > PHONE_MAX) && !(one.desktopOnly && width <= PHONE_MAX));
  const out = [];
  if (want("one-h1")) out.push(...await oneH1(page));
  if (want("no-overflow")) out.push(...await noOverflow(page));
  if (want("targets")) out.push(...await targets(page));
  if (want("field-errors")) out.push(...await fieldErrors(page));
  if (want("secrets")) out.push(...await secrets(page));
  if (want("focus-visible") || want("sticky-overlap")) out.push(...(await tabWalk(page)).filter(one => want(one.probe)));
  const sidebar = want("sidebar") ? await sidebarRows(page) : null;
  return { findings: out, sidebar, arrowKeys: want("arrow-keys") };
}
