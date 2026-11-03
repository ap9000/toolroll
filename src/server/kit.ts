/**
 * The revamp kit for server pages: the same markup the React kit (src/browser/kit/) renders, as `Html`, so a
 * server page and a React view built from the kit look and behave alike. Rules: src/design/KIT.md. Look:
 * src/design/kit.css (served with console.css). Words and approval rules: src/design/kit.ts.
 *
 * Everything here escapes by construction (html.ts): strings are text, only `Html` is markup. Behaviour (the
 * composer growing, Stop, the keyboard, overlays, switches) comes from the workspace bundle's kit behaviour
 * (src/browser/kit/behavior.ts), which wires any kit markup the workspace places; every control here still works
 * as plain HTML without it.
 */
import { attributes, html, joinHtml, passwordlessRendering, postForm, type AttributeValue, type Html, type HtmlValue, type PostFormOptions } from "../html.js";
import {
  KIT_ICONS, NOT_FOUND, SETTINGS_GROUPS, STATUS, STEP_WORDS, TIMING_WORDS, approvalAsk, chipOfHeadline, dur, needsWords, stepsFill, termsOf, timingBars,
  type ApprovalFacts, type ApprovalKind, type ChipTone, type IconShape, type KitIcon, type StatusKey, type StepItem, type TimingRow,
} from "../design/kit.js";
import type { Headline } from "../task-status.js";

type Attrs = Readonly<Record<string, AttributeValue>>;
const cls = (...names: ReadonlyArray<string | false | null | undefined>): string => names.filter(Boolean).join(" ");

// ---- text and icons ---------------------------------------------------------------------------------------------

export function icon(name: KitIcon, small = false): Html {
  const shapes = (KIT_ICONS[name] as readonly IconShape[]).map(shape =>
    shape[0] === "path" ? html`<path${attributes(shape[1])}/>` : shape[0] === "circle" ? html`<circle${attributes(shape[1])}/>` : html`<rect${attributes(shape[1])}/>`);
  return html`<svg class="${cls("k-i", small && "k-i-sm")}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${shapes}</svg>`;
}

// ---- buttons ----------------------------------------------------------------------------------------------------

export type BtnVariant = "primary" | "outline" | "ghost" | "danger";
export type BtnOptions = {
  variant?: BtnVariant;
  sm?: boolean;
  /** Icon-only: give it `label` (read aloud and shown as the tooltip). */
  iconOnly?: KitIcon;
  lead?: KitIcon;
  /** A link styled as a button (navigation is never the primary act). */
  href?: string;
  type?: "button" | "submit";
  /** The screen's one primary, which the phone dock also carries: hidden in the card on a phone. */
  docked?: boolean;
  attrs?: Attrs;
  className?: string;
};
export function btn(label: string, options: BtnOptions = {}): Html {
  const variant = options.variant ?? "outline";
  const className = cls("k-btn", `k-btn-${variant}`, options.sm && "k-btn-sm", options.iconOnly && "k-btn-icon", options.docked && "k-docked", options.className);
  const face = options.iconOnly ? icon(options.iconOnly) : html`<span class="k-face">${options.lead ? icon(options.lead, true) : ""}${label}</span>`;
  const named = options.iconOnly ? { "aria-label": label, title: label } : {};
  if (options.href !== undefined) return html`<a class="${className}" href="${options.href}"${attributes({ ...named, ...options.attrs })}>${face}</a>`;
  return html`<button class="${className}" type="${options.type ?? "button"}"${attributes({ ...named, ...options.attrs })}>${face}</button>`;
}

// ---- status -----------------------------------------------------------------------------------------------------

export function chip(word: string, tone: ChipTone = "", options: { dot?: boolean } = {}): Html {
  return html`<span class="${cls("k-chip", tone, options.dot === false && "nodot")}">${word}</span>`;
}
/** One of the five status words in its tone. */
export const status = (key: StatusKey): Html => chip(STATUS[key].word, STATUS[key].tone);
/** A task's headline (task-status.ts) as its chip. */
export function headlineChip(headline: Headline): Html {
  const { word, tone } = chipOfHeadline(headline);
  return chip(word, tone);
}
/** A count pill: ink only for a Needs-you count; zero is muted. */
export function count(n: number, options: { ink?: boolean } = {}): Html {
  return html`<span class="${cls("k-count", options.ink && n > 0 && "ink", n === 0 && "zero")}">${n}</span>`;
}

// ---- tabs and filters -------------------------------------------------------------------------------------------

export type TabItem = { key: string; label: string; href: string; count?: Html };
/** Sections of one object as addresses: a <nav> of links, the current one aria-current="page". */
export function linkTabs(label: string, current: string, items: readonly TabItem[]): Html {
  return html`<nav class="k-tabs" aria-label="${label}">${items.map(item => html`<a href="${item.href}"${item.key === current ? html` aria-current="page"` : ""}>${item.label}${item.count ?? ""}</a>`)}</nav>`;
}
/** Filters or views of a list as addresses: the segmented track. */
export function segLinks(label: string, current: string, items: readonly TabItem[]): Html {
  return html`<nav class="k-seg" aria-label="${label}">${items.map(item => html`<a href="${item.href}"${item.key === current ? html` aria-current="page"` : ""}>${item.label}${item.count ?? ""}</a>`)}</nav>`;
}

/** Filters or views as addresses with icons (List / Board): each item an icon, its label read aloud. */
export function iconSegLinks(label: string, current: string, items: ReadonlyArray<{ key: string; label: string; href: string; icon: KitIcon }>): Html {
  return html`<nav class="k-seg k-seg-icons" aria-label="${label}">${items.map(item => html`<a href="${item.href}" aria-label="${item.label}" title="${item.label}"${item.key === current ? html` aria-current="page"` : ""}>${icon(item.icon)}</a>`)}</nav>`;
}
/** A list's text filter (the workspace narrows the rows on the page as it is typed; without it, a GET form). */
export function filterInput(options: { label: string; name?: string; value?: string; placeholder?: string }): Html {
  return html`<label class="k-filter">${icon("search", true)}<input type="search"${attributes({ name: options.name, value: options.value, placeholder: options.placeholder ?? options.label, "aria-label": options.label })}></label>`;
}

// ---- fields -----------------------------------------------------------------------------------------------------

/** A field: label, control, one hint line, and the error slot tied to the control (aria-describedby). */
export function field(options: { id: string; label: string; control: Html; hint?: string; error?: string | null }): Html {
  return html`<div class="k-field"><label class="k-label" for="${options.id}">${options.label}</label>${options.control}\
${options.hint ? html`<p class="k-hint" id="${options.id}-hint">${options.hint}</p>` : ""}\
<span class="k-err" id="${options.id}-err" role="alert">${options.error ?? ""}</span></div>`;
}
/** A text input; `error` marks it invalid and points it at its error line. */
export function input(options: { id: string; name: string; value?: string; type?: "text" | "number" | "url" | "email" | "search" | "password" | "time"; error?: boolean; hint?: boolean; attrs?: Attrs }): Html {
  const describedBy = [options.hint && `${options.id}-hint`, `${options.id}-err`].filter(Boolean).join(" ");
  return html`<input class="k-input" id="${options.id}" name="${options.name}" type="${options.type ?? "text"}"${attributes({ value: options.value, "aria-invalid": options.error ? "true" : undefined, "aria-describedby": describedBy, ...options.attrs })}>`;
}
export function textarea(options: { id: string; name: string; value?: string; rows?: number; error?: boolean; attrs?: Attrs }): Html {
  return html`<textarea class="k-textarea" id="${options.id}" name="${options.name}" rows="${options.rows ?? 3}"${attributes({ "aria-invalid": options.error ? "true" : undefined, "aria-describedby": `${options.id}-err`, ...options.attrs })}>${options.value ?? ""}</textarea>`;
}
/** A native select in the field family, with the chevron: 36px, `sm` 28px in a toolbar, 44px and 16px text on a phone.
 * `chip` draws it as a composer's filled pill (a project inside the message box): still a native select, so it works
 * without script. */
export function select(options: { id?: string; name?: string; label?: string; items: ReadonlyArray<readonly [value: string, label: string] | string>; current?: string; sm?: boolean; wide?: boolean; chip?: boolean; attrs?: Attrs }): Html {
  const opts = options.items.map(item => {
    const [value, label] = typeof item === "string" ? [item, item] : item;
    return html`<option value="${value}"${value === options.current ? html` selected` : ""}>${label}</option>`;
  });
  return html`<span class="${cls("k-selw", options.sm && "sm", options.wide && "wide", options.chip && "k-selw-chip")}"><select class="k-sel"${attributes({ id: options.id, name: options.name, "aria-label": options.label, ...options.attrs })}>${opts}</select></span>`;
}
/** An on/off setting in a form: a checkbox with role=switch and a visible label (posts `name=on` when on). */
export function switchInput(options: { id: string; name: string; label: string; on: boolean; attrs?: Attrs }): Html {
  return html`<label class="k-switch"><input class="k-switch-input" type="checkbox" role="switch" id="${options.id}" name="${options.name}"${options.on ? html` checked` : ""}${attributes(options.attrs ?? {})}><span class="k-trk" aria-hidden="true"></span><span>${options.label}</span></label>`;
}
/** An on/off choice inside a composer, drawn as a filled pill chip whose mark fills when on: a checkbox with
 * role=switch (posts `name=value` when on), so it works without script. Its longer words go under the box (`note`). */
export function toggleChip(options: { id: string; name: string; label: string; on: boolean; attrs?: Attrs }): Html {
  return html`<label class="k-tchip"><input class="k-switch-input" type="checkbox" role="switch" id="${options.id}" name="${options.name}"${options.on ? html` checked` : ""}${attributes(options.attrs ?? {})}><span class="k-tchip-mark" aria-hidden="true"></span><span>${options.label}</span></label>`;
}
/** Two columns: label and one muted line | the control. `inline` keeps the control beside the label on a phone. */
export function formRow(label: string, hint: string | null, control: Html, variant: "" | "inline" | "top" | "wide" = ""): Html {
  return html`<div class="${cls("k-frow", variant)}"><div class="k-frow-l"><span class="k-frow-t">${label}</span>${hint ? html`<span class="k-frow-h">${hint}</span>` : ""}</div><div class="k-frow-c">${control}</div></div>`;
}
/** Radio cards: one choice from a few, each with a bold label and one muted line. */
export function radios(options: { name: string; legend: string; current: string; items: ReadonlyArray<{ value: string; label: string; text?: string; tag?: Html }> }): Html {
  return html`<fieldset class="k-radios"><legend class="k-sr">${options.legend}</legend>${options.items.map(item => html`<label class="k-opt"><input type="radio" name="${options.name}" value="${item.value}"${item.value === options.current ? html` checked` : ""}><span><b>${item.label}</b>${item.text ? html`<span>${item.text}</span>` : ""}</span>${item.tag ?? ""}</label>`)}</fieldset>`;
}

// ---- blocks -----------------------------------------------------------------------------------------------------

export const acts = (...buttons: HtmlValue[]): Html => html`<div class="k-acts">${buttons}</div>`;
export function facts(rows: ReadonlyArray<readonly [key: string, value: HtmlValue]>): Html {
  return html`<dl class="k-facts">${rows.map(([key, value]) => html`<dt>${key}</dt><dd>${value}</dd>`)}</dl>`;
}
export const note = (text: HtmlValue): Html => html`<p class="k-note">${text}</p>`;
/** A refusal or problem, where it happened (role=alert): what went wrong and what didn't change. */
export const notice = (text: HtmlValue): Html => html`<p class="k-notice" role="alert">${icon("alert", true)}<span>${text}</span></p>`;
/** One neutral system line (a builder offline, an update): not a failure, never amber. */
export const infoLine = (text: HtmlValue): Html => html`<p class="k-notice info">${text}</p>`;
export function empty(options: { title: string; text?: string; action?: Html }): Html {
  return html`<div class="k-empty"><p class="k-empty-t">${options.title}</p>${options.text ? html`<p class="k-empty-x">${options.text}</p>` : ""}${options.action ?? ""}</div>`;
}
/** A disclosure for secondary detail. */
export const disclose = (summary: string, body: HtmlValue, open = false): Html =>
  html`<details class="k-disclose"${open ? html` open` : ""}><summary>${summary}</summary>${body}</details>`;

// ---- lists ------------------------------------------------------------------------------------------------------

/** A group heading with its count; `right` puts one quiet tool at its end. */
export const group = (label: string, n?: Html, right?: Html): Html => html`<h2 class="k-grp">${label}${n ?? ""}${right ? html`<span class="k-grow"></span>${right}` : ""}</h2>`;
/** A list row: chip · title (the whole row is the link) · one muted line · meta · one action, always in one column. */
export function row(options: { href?: string; chip: Html; title: string; desc?: HtmlValue; meta?: HtmlValue; action?: Html; wait?: boolean; message?: Html; attrs?: Attrs }): Html {
  // No href: a thing with no page of its own (a computer); its title is text and its action is the way in.
  const title = options.href === undefined ? html`<span class="k-row-t">${options.title}</span>` : html`<a class="k-row-t" href="${options.href}">${options.title}</a>`;
  return html`<div class="${cls("k-row", options.wait && "wait", options.href === undefined && "k-row-static")}"${attributes(options.attrs ?? {})}><span class="k-row-c">${options.chip}</span>\
${title}<span class="k-row-d">${options.desc ?? ""}</span>\
<span class="k-row-m">${options.meta ?? ""}</span><span class="k-row-a">${options.action ?? ""}</span>${options.message ? html`<div class="k-row-msg">${options.message}</div>` : ""}</div>`;
}

// ---- page headers -----------------------------------------------------------------------------------------------

/** The phone header: back (or nothing), the title, one trailing action. Hidden at a desk. */
export function phoneHeader(title: string, options: { back?: string; trailing?: Html } = {}): Html {
  return html`<header class="k-ph">${options.back ? btn("Back", { variant: "ghost", iconOnly: "back", href: options.back }) : ""}<p class="k-ph-t">${title}</p>${options.trailing ?? ""}</header>`;
}
/** A list page's header: the phone header and the desk top bar (title · muted context · spacer · tools). */
export function pageHeader(title: string, options: { ctx?: HtmlValue; right?: Html; back?: string; phoneTitle?: string; trailing?: Html } = {}): Html {
  const phone = phoneHeader(options.phoneTitle ?? title, { ...(options.back ? { back: options.back } : {}), ...(options.trailing ? { trailing: options.trailing } : {}) });
  return html`${phone}<div class="k-tb"><h1>${title}</h1>${options.ctx ? html`<span class="k-tb-ctx">${options.ctx}</span>` : ""}${options.right ? html`<span class="k-grow"></span>${options.right}` : ""}</div>`;
}
/** A reading page's header: a back link, the one h1, a meta line. `same` when the phone header already shows the
 * title: the h1 stays for assistive tech and is drawn once. */
export function docHeader(options: { title: string; back?: readonly [href: string, label: string]; meta?: HtmlValue; right?: Html; same?: boolean }): Html {
  return html`${options.back ? html`<a class="k-backlink" href="${options.back[0]}">${icon("back", true)}${options.back[1]}</a>` : ""}\
<header class="k-dh"><div><h1${options.same ? html` class="k-same"` : ""}>${options.title}</h1>${options.meta ? html`<p class="k-dh-meta">${options.meta}</p>` : ""}</div>${options.right ?? ""}</header>`;
}
export const doc = (...parts: HtmlValue[]): Html => html`<div class="k-doc">${parts}</div>`;

// ---- approval ---------------------------------------------------------------------------------------------------

/** The four fixed slots: status (chip + heading) · supporting text · actions · terms, plus the error slot. The same
 * slots in every state (waiting, approved, automatic, refused), so nothing moves. `body`: the choice the act takes
 * (radio cards, a note), between the text and the actions. */
export function slots(options: { wait?: boolean; status: Html; text: HtmlValue; body?: HtmlValue; acts: HtmlValue; terms: HtmlValue; err?: HtmlValue; attrs?: Attrs }): Html {
  return html`<section class="${cls("k-slots", options.wait && "wait")}"${attributes(options.attrs ?? {})}><div class="k-slot-status">${options.status}</div>\
<p class="k-slot-text">${options.text}</p>${options.body === undefined ? "" : html`<div class="k-slot-body">${options.body}</div>`}<div class="k-slot-acts k-acts">${options.acts}</div><p class="k-slot-terms">${options.terms}</p>\
<div class="k-slot-err">${options.err ? notice(options.err) : ""}</div></section>`;
}

/** This request's approval facts: Passwordless as the request sees it, plus what the page read for this act. */
export function approvalFactsNow(read: Omit<ApprovalFacts, "passwordless"> = { remembered: false }): ApprovalFacts {
  return { ...read, passwordless: passwordlessRendering() };
}

/**
 * The control that approves one act, inside its slots: a POST form with the act's button and, only when the rules
 * say so, the password field (name `token`, as every ceremony reads it). Automatic approval renders nothing to
 * press. The page decides only what it shows: the server proves the person, the freshness and the scope again
 * when the form arrives.
 */
export function approveForm(options: {
  action: string;
  kind: ApprovalKind;
  facts: ApprovalFacts;
  label: string;
  /** The screen's one primary (ink); otherwise outline. */
  primary?: boolean;
  docked?: boolean;
  /** Hidden fields, return path, project revision, extra attributes. Never `signedOut`: an approval always carries the
   * request's CSRF field. Extra classes are added to `k-approve`, never instead of it. */
  form?: Omit<PostFormOptions, "signedOut">;
  /** Extra controls before the button (a note field, a confirm checkbox). */
  before?: Html;
}): Html {
  const ask = approvalAsk(options.kind, options.facts);
  if (ask === "automatic") return html``;
  const fieldId = `k-reauth-${options.action.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
  const password = ask === "password"
    ? html`<div class="k-reauth k-field"><label class="k-label" for="${fieldId}">Your password</label><input class="k-input" id="${fieldId}" type="password" name="token" autocomplete="current-password" required></div>`
    : html``;
  const button = btn(options.label, { variant: options.primary === false ? "outline" : "primary", type: "submit", ...(options.docked ? { docked: true } : {}) });
  // An approval is made inside a signed-in request: its CSRF field is not optional, whatever a caller passes.
  if (options.form !== undefined && "signedOut" in options.form) throw new Error("approveForm: an approval form always carries the request's CSRF field");
  // The k-approve class is GuardedHtml's stale-approval marker: a caller's classes join it, never replace it.
  const extra = options.form?.attrs ?? {};
  const classes = ["k-approve", ...(typeof extra["class"] === "string" ? extra["class"].split(/\s+/).filter(name => name !== "" && name !== "k-approve") : [])].join(" ");
  const formOptions: PostFormOptions = { ...options.form, attrs: { ...extra, class: classes, "data-approval-kind": options.kind } };
  return postForm(options.action, html`${options.before ?? ""}${password}<div class="k-acts">${button}</div>`, formOptions);
}
/** The terms line for an act, from the same rules. */
export const approvalTerms = (kind: ApprovalKind, facts: ApprovalFacts): string => termsOf(kind, facts);

/** Waits that aren't tasks, on their own page (a spend limit, a failed backup): one amber outline, a count, items
 * split by hairlines, each with its one action. They never join the global Needs-you count. */
export function needsPanel(items: ReadonlyArray<{ title: string; text?: string; action?: Html }>, label = "Needs you"): Html {
  if (items.length === 0) return html``;
  return html`<section class="k-needs" aria-label="${label}"><h2 class="k-needs-h">${label} ${count(items.length, { ink: true })}</h2>\
${items.map(item => html`<div class="k-needs-item"><div><b>${item.title}</b>${item.text ? html`<p>${item.text}</p>` : ""}</div>${item.action ? html`<div class="k-acts">${item.action}</div>` : ""}</div>`)}</section>`;
}

// ---- timing -----------------------------------------------------------------------------------------------------

/** A run's steps on one elapsed-time axis (Release, a flow's run, a pull request's checks). */
export function timing(options: { label?: string; chip?: Html; rows: readonly TimingRow[]; scale?: number; foot?: HtmlValue; head?: string }): Html {
  const bars = timingBars(options.rows, options.scale);
  const mark = (st: TimingRow["st"]): Html => st === "wait" ? html`<span class="k-wd"></span>` : st === "q" ? html`<span class="k-qd"></span>` : st === "run" ? html`<span class="k-rund"></span>` : icon(st === "ok" ? "check" : "x", true);
  const rows = options.rows.map((row, index) => {
    const bar = bars[index];
    const now = row.st === "run" || row.st === "bad" || row.st === "wait";
    return html`<div class="${cls("k-crow", row.st, now && "now")}"><span class="k-crow-i">${mark(row.st)}</span>\
<span class="k-crow-n">${row.name}<span class="k-crow-sub">${row.sub ?? (row.st === "q" ? "not reached" : "")}</span></span>\
<span class="k-crow-lane">${bar ? html`<i class="k-crow-bar" style="left:${bar.left.toFixed(2)}%;width:${bar.width.toFixed(2)}%"></i>` : ""}</span>\
<span class="k-crow-w">${TIMING_WORDS[row.st]}</span><span class="k-crow-s k-num">${row.st === "q" ? "–" : dur(row.dur)}</span></div>`;
  });
  return html`<section class="k-timing" aria-label="${options.label ?? "Steps"}"><header class="k-timing-h"><h2>${options.label ?? "Steps"}</h2><span class="k-timing-state">${options.chip ?? ""}</span></header>\
<div class="k-timing-b"><div class="k-crow head" aria-hidden="true"><span></span><span>${options.head ?? "Step"}</span><span class="k-crow-lane">Elapsed time</span><span>Status</span><span class="k-crow-s">Time</span></div>${rows}</div>\
<div class="k-timing-f">${options.foot ?? ""}</div></section>`;
}

// ---- progress line and board -----------------------------------------------------------------------------------

/** A few named steps on one line, filled up to where the work is. */
export function steps(items: readonly StepItem[], label = "Progress"): Html {
  return html`<ol class="k-steps" aria-label="${label}" style="--k-n:${items.length};--k-fill:${stepsFill(items).toFixed(3)}"><span class="k-steps-fill" aria-hidden="true"></span>\
${items.map(step => html`<li class="k-step ${step.state}"${step.state === "now" || step.state === "live" || step.state === "failed" ? html` aria-current="step"` : ""} aria-label="${step.label}: ${STEP_WORDS[step.state]}${step.sub ? `, ${step.sub}` : ""}"><b aria-hidden="true"></b><span class="k-step-l" aria-hidden="true">${step.label}</span><span class="k-step-s" aria-hidden="true">${step.sub ?? ""}</span></li>`)}</ol>`;
}
/** The board's columns; on a phone one at a time (`on`). */
export const board = (label: string, ...columns: HtmlValue[]): Html => html`<div class="k-board" role="region" aria-label="${label}">${columns}</div>`;
export function boardCol(options: { label: string; count?: Html; needs?: boolean; on?: boolean; empty: string; cards: readonly Html[] }): Html {
  return html`<section class="${cls("k-col", options.on && "on")}" aria-label="${options.label}"><h2 class="${cls("k-col-h", options.needs && "needs")}">${options.label}${options.count ?? ""}</h2>\
${options.cards.length > 0 ? options.cards : html`<p class="k-col-e">${options.empty}</p>`}</section>`;
}
export const card = (options: { href: string; title: string; meta: HtmlValue }): Html =>
  html`<a class="k-card" href="${options.href}"><span class="k-card-t">${options.title}</span><span class="k-card-m">${options.meta}</span></a>`;

// ---- pages ------------------------------------------------------------------------------------------------------

/** The not-found page, inside the shell: what was asked for and two ways on. */
export function notFound(path: string, options: { title?: string; text?: string } = {}): Html {
  return html`${pageHeader("Not found")}<div class="k-nf">${empty({
    title: options.title ?? NOT_FOUND.title(path), text: options.text ?? NOT_FOUND.text,
    action: acts(btn("Go to Home", { sm: true, href: "/" }), btn("Open Tasks", { sm: true, variant: "ghost", href: "/work" })),
  })}</div>`;
}

/** The Settings frame: Overview and the eight groups, a desk breadcrumb, a phone back header, one column. */
export function settingsShell(options: { group: string; title: string; lead?: string; body: HtmlValue; sub?: boolean; back?: string; flags?: Readonly<Record<string, boolean>> }): Html {
  const flags = options.flags ?? {};
  const own = SETTINGS_GROUPS.find(([, slug]) => slug === options.group);
  const hub = options.group === "hub" || own === undefined;
  const nav = html`<a class="k-nav k-nav-top" href="/settings"${hub ? html` aria-current="page"` : ""}><span class="k-nav-l">Overview</span></a>\
${SETTINGS_GROUPS.map(([label, slug, href]) => html`<a class="k-nav" href="${href}"${slug === options.group ? html` aria-current="page"` : ""}><span class="k-nav-l">${label}</span>${flags[slug] ? html`<span class="k-nav-flag" aria-hidden="true"></span><span class="k-sr"> (needs you)</span>` : ""}</a>`)}`;
  const back = options.back ?? (hub ? undefined : options.sub ? own![2] : "/settings");
  const crumbs = hub ? html`` : options.sub
    ? html`<nav class="k-tb-ctx k-crumbs" aria-label="Breadcrumb"><a href="${own![2]}">${own![0]}</a><span class="k-sep" aria-hidden="true">/</span><b aria-current="page">${options.title}</b></nav>`
    : html`<nav class="k-tb-ctx k-crumbs" aria-label="Breadcrumb"><b aria-current="page">${options.title}</b></nav>`;
  return html`${phoneHeader(hub ? "Settings" : options.title, back ? { back } : {})}<div class="k-tb"><h1>Settings</h1>${crumbs}</div>\
<div class="k-settings"><nav class="k-snav" aria-label="Settings">${nav}</nav><div class="k-sbody"><header><h2 class="${hub ? "k-sr" : "k-same"}">${options.title}</h2>${options.lead ? html`<p>${options.lead}</p>` : ""}</header>${options.body}</div></div>`;
}

// ---- composer ---------------------------------------------------------------------------------------------------

/** The round send, an arrow up; with `stop` it carries its Stop twin (the composer's .working class swaps them).
 * `gate` (a message box) marks it aria-disabled while the box is empty. */
export function sendButton(options: { label?: string; name?: string; gate?: boolean; empty?: boolean; stop?: { label?: string; attrs?: Attrs }; attrs?: Attrs } = {}): Html {
  const label = options.label ?? "Send";
  const gated = options.gate === true && options.empty !== false;
  return html`<span class="k-send-slot"><button class="k-send" type="submit" aria-label="${label}" title="${label}"${attributes({ name: options.name, "data-gate": options.gate ? "1" : undefined, "aria-disabled": gated ? "true" : undefined, ...options.attrs })}>${icon("send")}</button>\
${options.stop ? html`<button class="k-send k-stop" type="button" aria-label="${options.stop.label ?? "Stop"}" title="${options.stop.label ?? "Stop"}"${attributes(options.stop.attrs ?? {})}>${icon("stop")}</button>` : ""}</span>`;
}

/**
 * The message box: one filled rounded object, the textarea grows from `rows` to `maxRows` lines then scrolls,
 * one bottom row inside (+ menu, the project as a filled pill chip, toggle chips, the round send); its note and its
 * refusal sit under the box (all inside `.k-composer-field`). Textarea
 * `<id>-text` (named `name`), refusal slot `<id>-err`, chosen project a hidden input `<id>-project` (named
 * `projectName`). A refused send keeps the words in the box with the reason in the error slot.
 */
export function composer(options: {
  id: string;
  name: string;
  label: string;
  placeholder?: string;
  value?: string;
  rows?: number;
  maxRows?: number;
  plus?: boolean;
  project?: { current: string; items: readonly string[]; name?: string; sub?: string };
  before?: Html;
  send: Html;
  note?: HtmlValue;
  error?: string | null;
  disabled?: boolean;
  line?: boolean;
  working?: boolean;
  /** Extra attributes for the textarea (maxlength, required, autofocus). */
  textAttrs?: Attrs;
}): Html {
  const value = options.value ?? "";
  const textId = `${options.id}-text`;
  const project = options.project
    ? html`<button class="k-composer-chip" type="button" data-k-composer-project="${options.id}" aria-haspopup="dialog" aria-label="Project: ${options.project.current}. Change"${options.disabled ? html` disabled` : ""}><span data-k-project-name>${options.project.current}</span>${options.project.sub ? html`<span class="k-chip-sub">${options.project.sub}</span>` : ""}</button>\
<input type="hidden" id="${options.id}-project" name="${options.project.name ?? "project"}" value="${options.project.current}" data-items="${JSON.stringify(options.project.items)}">`
    : html``;
  const plus = options.plus
    ? html`<button class="k-composer-plus" type="button" data-k-composer-plus="${options.id}" aria-haspopup="dialog" aria-label="Add to your message"${options.disabled ? html` disabled` : ""}>${icon("plus")}</button>`
    : html``;
  return html`<div class="k-composer-field"><div class="${cls("k-composer", options.line && "line", options.disabled && "off", value.trim() && "has-text", options.working && "working")}" data-k-composer="${options.id}">\
<label class="k-sr" for="${textId}">${options.label}</label><div class="k-composer-files" data-k-files="${options.id}"></div>\
<textarea class="k-composer-ta" id="${textId}" name="${options.name}" rows="${options.rows ?? 1}" data-min="${options.rows ?? 1}" data-max="${options.maxRows ?? 8}"${attributes({ placeholder: options.placeholder, disabled: options.disabled === true, "aria-invalid": options.error ? "true" : undefined, "aria-describedby": `${options.id}-err`, ...options.textAttrs })}>${value}</textarea>\
<div class="k-composer-bar">${plus}${project}${options.before ?? ""}<span class="k-grow"></span>${options.send}</div></div>\
${options.note ? html`<p class="k-note k-composer-note">${options.note}</p>` : ""}<div class="k-composer-err k-err" id="${options.id}-err" role="alert">${options.error ?? ""}</div></div>`;
}

// ---- overlays (markup; the workspace's kit behaviour opens them) -------------------------------------------------

export type OverlayKind = "popover" | "drawer" | "sheet" | "menu";
/** A floating panel, hidden until its trigger (`overlayTrigger`) opens it: role=dialog, a labelled Close, Escape
 * and the scrim close it, Tab stays inside, focus returns to the trigger. A popover and a menu become a bottom
 * sheet on a phone. */
export function overlay(options: { id: string; kind: OverlayKind; title: string; sub?: string; body: HtmlValue }): Html {
  const titleId = `${options.id}-title`;
  const close = btn("Close", { variant: "ghost", iconOnly: "x", sm: options.kind === "popover" || options.kind === "menu", attrs: { "data-k-close": "" } });
  const head = options.kind === "drawer"
    ? html`<header class="k-drawer-h"><h2 id="${titleId}">${options.title}</h2>${close}</header>`
    : options.kind === "sheet"
      ? html`<div class="k-sheet-h"><div class="k-sheet-ht"><h2 id="${titleId}">${options.title}</h2>${options.sub ? note(options.sub) : ""}</div>${close}</div>`
      : html`<div class="k-pop-h"><h3 id="${titleId}">${options.title}</h3>${close}</div>`;
  const body = options.kind === "menu" ? html`<div class="k-menu">${options.body}</div>` : options.body;
  const className = options.kind === "drawer" ? "k-drawer" : options.kind === "sheet" ? "k-sheet" : cls("k-pop", options.kind === "menu" && "k-pop-menu");
  const inner = options.kind === "drawer" ? html`${head}<div class="k-drawer-b">${body}</div>` : options.kind === "sheet" ? html`${head}<div class="k-sheet-b">${body}</div>` : html`${head}${body}`;
  return html`<div class="${className}" id="${options.id}" role="dialog" aria-modal="true" aria-labelledby="${titleId}" data-k-overlay="${options.kind}" tabindex="-1" hidden>${inner}</div>`;
}
/** The button that opens an overlay. */
export function overlayTrigger(label: string, overlayId: string, options: Omit<BtnOptions, "href" | "type"> = {}): Html {
  return btn(label, { ...options, attrs: { "data-k-open": overlayId, "aria-haspopup": "dialog", "aria-controls": overlayId, ...options.attrs } });
}

// ---- phone dock -------------------------------------------------------------------------------------------------

/** The phone dock: this screen's one primary (the same act the card hides on a phone). */
export function dock(primary: Html | null): Html {
  return primary === null ? html`` : html`<div class="k-dock"><div class="k-dock-primary">${primary}</div></div>`;
}

/** Several kit parts joined. */
export const parts = (...values: HtmlValue[]): Html => joinHtml(values);

// ---- pages outside the shell (Wave E) ---------------------------------------------------------------------------

/**
 * A page outside the shell (sign in, the first account, an invite, signed out, an error): the brand, one narrow
 * column with the one h1, then an optional foot line under a hairline. `brand` is the product mark (chrome.ts
 * BRAND_HTML). These pages carry no script: everything on them works as plain HTML.
 */
export function outPage(options: { brand: Html; brandHref?: string; title: string; sub?: HtmlValue; note?: HtmlValue; body?: HtmlValue; foot?: HtmlValue }): Html {
  return html`<div class="k-out"><div class="k-out-c"><a class="k-out-brand" href="${options.brandHref ?? "/"}">${options.brand}</a>\
<h1>${options.title}</h1>${options.note ? html`<p class="k-out-note" role="status">${options.note}</p>` : ""}${options.sub ? html`<p class="k-out-sub">${options.sub}</p>` : ""}${options.body ?? ""}</div>\
${options.foot ? html`<p class="k-out-f">${options.foot}</p>` : ""}</div>`;
}

/** A form field outside the shell: label, input, one hint line, and its error line (the field is aria-invalid, described
 * by both and focused when the error is about it). The error is a server's refusal; nothing here validates. */
export function outField(options: { id: string; label: string; name: string; type?: "text" | "password"; value?: string; hint?: string; error?: string | null; attrs?: Attrs }): Html {
  const describedBy = [options.hint ? `${options.id}-hint` : null, options.error ? `${options.id}-err` : null].filter(Boolean).join(" ");
  const control = html`<input class="k-input" id="${options.id}" name="${options.name}" type="${options.type ?? "text"}"${attributes({
    value: options.value, "aria-invalid": options.error ? "true" : undefined, "aria-describedby": describedBy || undefined, ...(options.error ? { autofocus: true } : {}), ...options.attrs,
  })}>`;
  return html`<div class="k-field"><label class="k-label" for="${options.id}">${options.label}</label>${control}\
${options.hint ? html`<p class="k-hint" id="${options.id}-hint">${options.hint}</p>` : ""}${options.error ? html`<p class="k-err" id="${options.id}-err" role="alert">${options.error}</p>` : ""}</div>`;
}

// ---- guided steps (Wave E) --------------------------------------------------------------------------------------

export type CheckStep = { key: string; title: string; text: HtmlValue; state: "done" | "open" | "checking"; action?: Html | null };
/** A short list of steps: a mark, the step and one line, its one action. Done steps read muted with a check; a step
 * being checked shows a static ring (running state never animates). The state is also said in words. */
export function checklist(steps: readonly CheckStep[], label = "Steps"): Html {
  const word = { done: "Done", open: "Not done", checking: "Checking" } as const;
  return html`<ol class="k-check" aria-label="${label}">${steps.map(step => html`<li class="${cls("k-check-row", step.state === "done" && "done")}" data-step="${step.key}">\
<span class="${cls("k-check-mark", step.state === "done" && "ok", step.state === "checking" && "run")}" aria-hidden="true">${step.state === "done" ? icon("check", true) : ""}</span>\
<span class="k-check-t"><b>${step.title}</b><span>${step.text}</span><span class="k-sr">${word[step.state]}</span></span>\
<span class="k-check-a">${step.state === "done" ? "" : step.action ?? ""}</span></li>`)}</ol>`;
}

// ---- ideas (Wave E) ---------------------------------------------------------------------------------------------

/** Ideas that draft words into a composer: each is a link that opens the page with the words in the box (no script),
 * and with the kit behaviour it adds them to the box in place (`data-k-draft`, `data-k-into` = the composer id). */
export function ideas(options: { label: HtmlValue; into: string; items: ReadonlyArray<{ label: string; draft: string; href: string }> }): Html {
  if (options.items.length === 0) return html``;
  return html`<section class="k-sec"><h3>${options.label}</h3><div class="k-ideas">${options.items.map(item =>
    html`<a class="k-btn k-btn-outline k-idea" href="${item.href}" data-k-draft="${item.draft}" data-k-into="${options.into}">${item.label}</a>`)}</div></section>`;
}

// ---- settings pages (wave D) ------------------------------------------------------------------------------------

/** A settings section: its heading (with an optional muted state after it), one muted lead line, then its rows.
 * No nested wells. `id` is also the anchor other pages link to. */
export function settingsSection(options: { id: string; title: string; state?: HtmlValue; lead?: HtmlValue; right?: Html; body: HtmlValue }): Html {
  const head = `${options.id}-h`;
  return html`<section class="k-ssec" id="${options.id}" aria-labelledby="${head}"><div class="k-secthead"><h3 id="${head}">${options.title}\
${options.state ? html`<span class="k-ssec-state">${options.state}</span>` : ""}</h3>${options.right ?? ""}</div>\
${options.lead ? html`<p class="k-ssec-lead">${options.lead}</p>` : ""}${options.body}</section>`;
}

/** One row that opens a settings page: icon, title (with "1 item needs you" when something waits), one status line,
 * anything on the right, a chevron. The whole row is the link. */
export function settingsLink(options: { href: string; title: string; status?: HtmlValue; icon?: KitIcon; needs?: number; right?: Html }): Html {
  const flag = options.needs ? html`<span class="k-sflag">${needsWords(options.needs)}</span>` : "";
  return html`<a class="${cls("k-slink", !options.icon && "noico")}" href="${options.href}">${options.icon ? icon(options.icon) : ""}\
<span class="k-sl"><span class="k-sl-t"><span>${options.title}</span>${flag}</span>${options.status ? html`<span class="k-sl-h">${options.status}</span>` : ""}</span>\
<span class="k-slink-r">${options.right ?? ""}</span><span class="k-chev" aria-hidden="true"></span></a>`;
}

/** A list of settings links under a section heading ("In this group"), or the overview's unlabelled list. */
export function settingsLinks(title: string | null, links: readonly Html[], options: { label?: string } = {}): Html {
  return html`<section class="k-ssec"${title === null ? html` aria-label="${options.label ?? "All settings"}"` : ""}>${title === null ? "" : html`<div class="k-secthead"><h3>${title}</h3></div>`}\
<div class="k-slinks">${links}</div></section>`;
}

/** A record row (a session, a token, a person, a device, a provider): title and one muted line · when · one action,
 * and anything opened under it (a form, a refusal). */
export function settingsRecord(options: { title: HtmlValue; sub?: HtmlValue; when?: HtmlValue; action?: HtmlValue; more?: HtmlValue; attrs?: Attrs }): Html {
  return html`<div class="k-srec"${attributes(options.attrs ?? {})}><div class="k-sl"><span class="k-sl-t">${options.title}</span>${options.sub ? html`<span class="k-sl-h">${options.sub}</span>` : ""}</div>\
<span class="k-srec-when">${options.when ?? ""}</span><span class="k-srec-a">${options.action ?? ""}</span>${options.more ? html`<div class="k-srec-more">${options.more}</div>` : ""}</div>`;
}

/** A command or path to copy by hand: monospace, selectable. */
export const codeLine = (text: string): Html => html`<code class="k-scode">${text}</code>`;
