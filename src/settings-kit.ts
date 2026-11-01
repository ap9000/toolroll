/**
 * The settings kit (docs/plans/settings-revamp.md §4): the frame's breadcrumb, and the pieces every settings page is
 * rebuilt from — a section, its own sticky Save, the step-up dialog drawn from the action's own proof contract
 * (settings-proofs.ts), field errors, secret inputs and choice groups. Server-rendered HTML that works without
 * JavaScript; settings-kit-script.ts only turns the inline proof field into a dialog.
 *
 * Rules the helpers keep (and settings-kit.test.ts pins):
 * - the proof field is written into the form's own server HTML, named as its handler reads it, labelled, and
 *   `current-password`; so sensitivity (serve.ts sendScreen) and the identity-provider swap (ssoStepUps) still see it;
 * - a step-up field renders through `reauth`, so Passwordless leaves it out exactly as today; a credential or typed
 *   password field always renders;
 * - a CSRF-only action renders no proof field and no dialog;
 * - nothing here ever sets `value` on a proof or secret field;
 * - handlers never read any of this: it only draws.
 */
import { attributes, html, htmlString, joinHtml, postForm, reauth, type Html, type HtmlValue } from "./html.js";
import { isSettingsFrame } from "./settings-kit-script.js";
import { contractReads, proofRow, type ProofRow } from "./settings-proofs.js";

export { isSettingsFrame };

// ---- the frame ---------------------------------------------------------------------------------------------------

/** One breadcrumb: a link, or (the last) the page itself. */
export type Crumb = { label: string; href: string | null };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };
/** The text of a page's first h1 (tags dropped, the common entities read), or null. */
export function headingText(page: string): string | null {
  const found = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(page);
  if (found === null) return null;
  const text = found[1]!.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_whole, name: string) => ENTITIES[name] ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? null : text.slice(0, 80);
}

/** The breadcrumb for a settings-frame page: "Settings / <this page>", or nothing on the hub and outside the frame. */
export function settingsCrumbs(pathname: string, title: string, page: string): Crumb[] | undefined {
  if (!isSettingsFrame(pathname) || pathname === "/settings") return undefined;
  const name = headingText(page) ?? (title.charAt(0).toUpperCase() + title.slice(1));
  return [{ label: "Settings", href: "/settings" }, { label: name, href: null }];
}

/** The breadcrumb as server HTML (the page before scripts, and without them). */
export function crumbsHtml(crumbs: readonly Crumb[]): Html {
  return html`<nav class="kit-crumbs" aria-label="Breadcrumb"><ol>${crumbs.map(one => one.href === null
    ? html`<li aria-current="page">${one.label}</li>`
    : html`<li><a href="${one.href}">${one.label}</a></li>`)}</ol></nav>`;
}

// ---- fields --------------------------------------------------------------------------------------------------------

/** The password-manager opt-outs every secret input carries (a service's key is not the person's sign-in). */
export const SECRET_OPT_OUTS = { "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": true, "data-form-type": "other" } as const;

const errorId = (id: string) => `${id}-error`;

/** A field's message under it: tied to the field with aria-describedby, announced, and the field focused. */
export function fieldError(id: string, message: string): Html {
  return html`<p class="kit-field-error" id="${errorId(id)}" role="alert">${message}</p>`;
}

export type TextField = {
  id: string; name: string; label: string;
  type?: "text" | "number" | "url" | "email";
  /** What the person typed (kept after a validation error). Never a secret: secrets use secretInput. */
  value?: string | null;
  hint?: string; error?: string | null;
  attrs?: Readonly<Record<string, string | number | boolean | null | undefined>>;
};

/** A labelled text field; with an error it is aria-invalid, names its message and takes focus. */
export function textField(field: TextField): Html {
  const hint = field.hint === undefined ? null : `${field.id}-hint`;
  const described = [hint, field.error ? errorId(field.id) : null].filter(Boolean).join(" ");
  return html`<div class="kit-field"><label for="${field.id}">${field.label}</label>\
${field.hint === undefined ? "" : html`<p class="kit-hint" id="${hint}">${field.hint}</p>`}\
<input${attributes({ id: field.id, name: field.name, type: field.type ?? "text", value: field.value ?? null, ...(field.attrs ?? {}),
    "aria-invalid": field.error ? "true" : null, "aria-describedby": described === "" ? null : described, autofocus: field.error ? true : null })}>\
${field.error ? fieldError(field.id, field.error) : ""}</div>`;
}

/** A secret that is not the person's own password (an API key, a bot token, a client secret): masked, never given a
 * value, kept out of password managers. The field name is the handler's own wire name. */
export function secretInput(field: { id: string; name: string; label: string; hint?: string; required?: boolean; error?: string | null }): Html {
  const described = [field.hint === undefined ? null : `${field.id}-hint`, field.error ? errorId(field.id) : null].filter(Boolean).join(" ");
  return html`<div class="kit-field"><label for="${field.id}">${field.label}</label>\
${field.hint === undefined ? "" : html`<p class="kit-hint" id="${field.id}-hint">${field.hint}</p>`}\
<input${attributes({ id: field.id, name: field.name, type: "password", autocomplete: "off", spellcheck: "false", autocapitalize: "none", "data-so-secret": true, ...SECRET_OPT_OUTS,
    required: field.required === true, "aria-invalid": field.error ? "true" : null, "aria-describedby": described === "" ? null : described, autofocus: field.error ? true : null })}>\
${field.error ? fieldError(field.id, field.error) : ""}</div>`;
}

/** A choice group: a fieldset with its legend, each option's detail tied to it. Nothing saves until Save. */
export function choiceGroup(group: { id: string; name: string; legend: string; checked: string | null; options: readonly { value: string; label: string; detail?: string }[]; error?: string | null }): Html {
  return html`<fieldset class="kit-choices"${group.error ? html` aria-describedby="${errorId(group.id)}"` : ""}><legend>${group.legend}</legend>\
${group.options.map((one, at) => {
    const id = `${group.id}-${at}`;
    return html`<label class="kit-choice" for="${id}"><input${attributes({ type: "radio", id, name: group.name, value: one.value, checked: one.value === group.checked, "aria-describedby": one.detail === undefined ? null : `${id}-detail` })}>\
<span>${one.label}</span>${one.detail === undefined ? "" : html`<span class="kit-choice-detail" id="${id}-detail">${one.detail}</span>`}</label>`;
  })}${group.error ? fieldError(group.id, group.error) : ""}</fieldset>`;
}

// ---- proof ---------------------------------------------------------------------------------------------------------

/** The proof field a row's handler reads, as today's forms write it; empty for a CSRF-only row. A step-up field goes
 * through `reauth` (Passwordless leaves it out); a credential or typed-password field always shows. Never a value. */
export function proofField(row: ProofRow, options: { label?: string } = {}): Html {
  if (row.field === null || row.proof === "none") return html``;
  if (!contractReads(row, row.field)) throw new Error(`${row.id}: its form doesn't read ${row.field}`);
  const field = html`<label>${options.label ?? "Your Toolroll password"}<input type="password" name="${row.field}" autocomplete="current-password" required></label>`;
  return row.proof === "step-up" ? reauth(field) : field;
}

/** How the dialog explains a proof that Passwordless doesn't cover, in words; null where nothing needs saying. */
export function proofNote(row: ProofRow): string | null {
  if (row.proof === "credential") return "This changes a way in, so it always takes your password.";
  if (row.proof === "typed-password") return "This always takes your password, typed.";
  if (row.proof === "typed-now-operator") return "Widening this takes an instance operator's password, typed now.";
  return null;
}

export type StepUpForm = {
  /** The proof inventory row this form posts under. */
  proof: string;
  /** The exact route (one of the row's). */
  action: string;
  /** Unique on the page: the form, its dialog and its section hang from it. */
  id: string;
  /** The section's own fields. */
  body: HtmlValue;
  /** Hidden terms posted back unchanged (nonce, digest, fingerprint, the shown project…). */
  hidden?: Readonly<Record<string, string | number | null | undefined>>;
  /** The Save bar's words before anything changes, and its button. */
  save?: { label?: string; idle?: string; name?: string; value?: string };
  /** What the dialog says the person is agreeing to (the action's own words by default). */
  confirm?: string;
};

/**
 * A section's form, posted to its existing route with its existing fields, and its sticky Save. When the row needs a
 * proof, the proof field sits in the form's own HTML — inline (as today, which is how it works without JavaScript) and
 * moved into a `<dialog>` inside the same form by settings-kit-script.ts, which opens it on submit, keeps the pressed
 * button, and posts nothing on Cancel. The server still proves everything.
 */
export function stepUpForm(form: StepUpForm): Html {
  const row = proofRow(form.proof);
  if (!row.routes.includes(form.action)) throw new Error(`${row.id} doesn't post to ${form.action}`);
  for (const name of Object.keys(form.hidden ?? {})) if (row.field === name || row.secrets.includes(name)) throw new Error(`${row.id}: ${name} is never a hidden value`);
  const proof = proofField(row);
  const asks = htmlString(proof) !== "";
  const note = proofNote(row);
  const save = form.save ?? {};
  const submit = html`<button${attributes({ type: "submit", class: "kit-save", name: save.name ?? null, value: save.value ?? null })}>${save.label ?? "Save"}</button>`;
  const dialog = asks ? html`<dialog class="kit-dialog" id="${form.id}-dialog" aria-labelledby="${form.id}-dialog-title" data-kit-dialog>\
<h2 id="${form.id}-dialog-title">Confirm it's you</h2><p class="kit-dialog-terms">${form.confirm ?? row.action}${row.when === undefined ? "" : html` <span class="kit-hint">(${row.when})</span>`}</p>\
${note === null ? "" : html`<p class="kit-hint">${note}</p>`}<div class="kit-dialog-slot" data-kit-slot></div>\
<div class="kit-dialog-actions"><button type="button" class="kit-cancel" data-kit-cancel>Cancel</button><button type="button" class="kit-confirm" data-kit-confirm>${save.label ?? "Save"}</button></div></dialog>` : "";
  return postForm(form.action, joinHtml([
    form.body,
    asks ? html`<div class="kit-proof" data-kit-proof>${proof}</div>` : "",
    html`<div class="kit-save-bar" data-kit-save-bar><span class="kit-save-state" aria-live="polite" data-kit-state data-idle="${save.idle ?? "No changes"}"></span>${submit}</div>`,
    dialog,
  ]), { hidden: form.hidden ?? {}, attrs: { id: form.id, class: "kit-form", "data-kit-form": row.id, "data-kit-step-up": asks ? "" : null } });
}

/** A section: a heading, a one-line state, a problem the handler sent back (role=alert), then its form. */
export function kitSection(section: { id: string; title: string; state?: HtmlValue; problem?: string | null; said?: string | null; body: HtmlValue }): Html {
  return html`<section class="kit-section" id="${section.id}" aria-labelledby="${section.id}-title"><h2 id="${section.id}-title">${section.title}</h2>\
${section.state === undefined ? "" : html`<p class="kit-state">${section.state}</p>`}\
${section.problem ? html`<p class="kit-problem" role="alert">${section.problem}</p>` : ""}\
${section.said ? html`<p class="kit-said" role="status">${section.said}</p>` : ""}${section.body}</section>`;
}

/** The kit's look: one 760px column, sections with no nested wells, the sticky Save, the dialog. The needs-you colour
 * falls back to the warning token until S5 lands `--so-needs-you`. */
export const SETTINGS_KIT_CSS = ":root{--so-settings-width:760px}" +
  ".kit-crumbs ol{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0;padding:0;list-style:none;font-size:14px;color:var(--so-muted)}" +
  ".kit-crumbs li+li::before{content:'/';margin-right:6px;color:var(--so-muted)}.kit-crumbs a{color:var(--so-muted);text-decoration:none}.kit-crumbs a:hover{color:var(--so-ink);text-decoration:underline}" +
  ".kit-crumbs [aria-current]{color:var(--so-ink);font-weight:600}" +
  ".kit-section{margin:0 0 32px}.kit-section>h2{margin:0 0 4px;font-size:16px}.kit-state{margin:0 0 12px;color:var(--so-muted)}" +
  ".kit-problem{margin:0 0 12px;padding:10px 12px;border:1px solid var(--so-danger);border-radius:8px;color:var(--so-danger)}.kit-said{margin:0 0 12px;color:var(--so-muted)}" +
  ".kit-field{margin:0 0 14px}.kit-hint{margin:2px 0 0;font-size:13px;color:var(--so-muted)}" +
  ".kit-field-error{margin:4px 0 0;font-size:13px;color:var(--so-danger)}.kit-field [aria-invalid=true]{border-color:var(--so-danger)}" +
  ".kit-choices{margin:0 0 14px;padding:0;border:0}.kit-choices legend{padding:0;margin:0 0 6px;font-weight:600}" +
  ".kit-choice{display:grid;grid-template-columns:auto 1fr;column-gap:10px;align-items:start;min-height:44px;padding:8px 0;margin:0}.kit-choice input{margin:3px 0 0}.kit-choice-detail{grid-column:2;font-size:13px;color:var(--so-muted)}" +
  ".kit-save-bar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0 0;padding:10px 0;border-top:1px solid var(--so-line);background:var(--so-paper)}" +
  ".kit-save-state{color:var(--so-muted);font-size:14px}.kit-save-bar[data-changed] .kit-save-state{color:var(--so-ink)}" +
  ".kit-js .kit-form[data-kit-step-up]>.kit-proof{display:none}" +
  ".kit-dialog{max-width:min(440px,calc(100vw - 32px));padding:20px;border:1px solid var(--so-line);border-radius:12px;background:var(--so-paper);color:var(--so-ink)}" +
  ".kit-dialog::backdrop{background:rgb(0 0 0 / .35)}.kit-dialog h2{margin:0 0 6px;font-size:17px}.kit-dialog-slot .kit-proof{display:block}" +
  ".kit-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin:16px 0 0}" +
  "@media (max-width:900px){.kit-save-bar button,.kit-dialog-actions button,.kit-crumbs a{min-height:44px}.kit-crumbs a{display:inline-flex;align-items:center}}";
