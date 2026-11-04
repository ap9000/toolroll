/** Sign-in, sign-up, join and wrong-host pages: pages outside the shell, built from the kit (server/kit.ts outPage).
 * They carry no script and no session; every refusal names the field it is about. */
import { BRAND_HTML,shell } from "./chrome.js";
import { html, joinHtml, postForm, replaceMarkup, type Html } from "../html.js";
import { btn, disclose, facts, notice, outField, outPage } from "./kit.js";
import { projectName } from "../project.js";

/** What a live invite grants, said on its join page ("Your access"). Project names only, never paths. */
export type InviteTerms = { role: "approver" | "viewer"; mintedBy: string; expiresAt: string; projects: readonly string[] | null };
/** Which join field a refusal is about. */
export type JoinProblem = { field: "name" | "password"; text: string };

const ACCESS_WORDS = { approver: ["Can manage and approve", "Create, manage and approve work."], viewer: ["Can view", "Read work and results."] } as const;

/** The invite's front door: cookie-free, script-free, sensitive by shape. Rendered only for a LIVE token — everything
 * dead gets joinDeadPage. A live token's holder reads what it grants before choosing a name and a password. */
export function joinFormPage(token: string, problem: JoinProblem | null, name: string, terms: InviteTerms | null = null): Html {
  const [access, accessLine] = terms === null ? [null, null] : ACCESS_WORDS[terms.role];
  const grants = terms === null ? "" : facts([
    ["Your access", html`${access} · <span class="k-muted">${accessLine}</span>`],
    ["Projects", terms.projects === null ? "Every project" : terms.projects.length === 0 ? "None yet" : terms.projects.map(one => projectName(one)).join(", ")],
    ["Expires", `${expiryWords(terms.expiresAt)} · works once`],
  ]);
  const form = postForm(`/join/${token}`, joinHtml([
    outField({ id: "join-name", label: "Choose a username", name: "name", value: name, error: problem?.field === "name" ? problem.text : null,
      attrs: { autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: true, ...(problem === null ? { autofocus: true } : {}) } }),
    outField({ id: "join-password", label: "Choose a password", name: "password", type: "password", hint: "At least 8 characters.", error: problem?.field === "password" ? problem.text : null,
      attrs: { autocomplete: "new-password" } }),
    btn("Join", { variant: "primary", type: "submit", className: "k-wide" }),
  ]), { signedOut: true, attrs: { class: "k-form" } });
  return shell("Join Toolroll", outPage({
    brand: BRAND_HTML, brandHref: "/login", title: "Join Toolroll",
    sub: terms === null ? "You were invited. Choose a username and a password to sign in." : html`<b>${terms.mintedBy}</b> invited you. This is what the invite grants:`,
    body: joinHtml([grants, form]),
    foot: "This link works once, for you. Joining creates your own account; whoever runs this Toolroll can change what it can do later.",
  }), { nav: false });
}

/** Unknown, expired, revoked, consumed, attempts spent: ONE page (D6). */
export function joinDeadPage(): Html {
  return shell("Join Toolroll", outPage({
    brand: BRAND_HTML, brandHref: "/login", title: "This invite link can't be used",
    sub: "Links work once and expire. Ask the person who invited you for a fresh one.",
    body: html`<div class="k-acts">${btn("Sign in instead", { href: "/login" })}</div>`,
  }), { nav: false });
}

/**
 * v100: for someone signed in with the identity provider, every step-up
 * password field (autocomplete="current-password"; a secret like a bot token
 * is never one) becomes that sign-in: confirmed, when an explicit re-check
 * made on request awaits its one step-up (cockpit B2), or a link to be
 * checked again, then back here. An ordinary sign-in never confirms.
 */
export function ssoStepUps(page: Html, sso: { label: string; fresh: boolean }, returnTo: string): Html {
  const stepUp = (attributes: string) => /\btype="password"/.test(attributes) && /\bautocomplete="current-password"/.test(attributes);
  const swap = (attributes: string): Html => {
    const name = /\bname="([^"]+)"/.exec(attributes)?.[1] ?? "token";
    return html`<input type="hidden" name="${name}" value="">${sso.fresh
      ? html`<span class="sso-step-up" data-sso-step-up="confirmed">Confirmed with ${sso.label}</span>`
      : html`<a class="sso-step-up" data-sso-step-up="confirm" href="/login/sso?reauth=1&amp;return=${encodeURIComponent(returnTo)}">Confirm with ${sso.label}</a>`}`;
  };
  const labelled = replaceMarkup(page, /<label>[^<]*<input\b([^>]*)>\s*<\/label>/g, (_whole, attributes) => stepUp(attributes) ? swap(attributes) : null);
  return replaceMarkup(labelled, /<input\b([^>]*)>/g, (_whole, attributes) => stepUp(attributes) ? swap(attributes) : null);
}

/** An expiry as a person reads it: "Thu 5 Nov, 10:42". */
function expiryWords(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso.slice(0, 16).replace("T", " ");
  return at.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function loginPage(problem: string | null, returnTo = "/", sso: { label: string; operatorsOnly: boolean } | null = null): Html {
  const form = postForm("/login", joinHtml([
    outField({ id: "login-name", label: "Username", name: "name", attrs: { autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: true, ...(sso === null ? { autofocus: true } : {}) } }),
    outField({ id: "login-password", label: "Password", name: "token", type: "password", attrs: { autocomplete: "current-password" } }),
    btn("Sign in", { variant: sso === null ? "primary" : "outline", type: "submit", className: "k-wide" }),
  ]), { signedOut: true, returnTo: returnTo === "/" ? null : returnTo, attrs: { class: "k-form" } });
  // v100: with an identity provider, its button comes first and passwords wait behind "Use a password".
  const body = sso === null
    ? joinHtml([problem === null ? "" : html`<div class="k-refusal">${notice(problem)}</div>`, form])
    : joinHtml([
        problem === null ? "" : html`<div class="k-refusal">${notice(problem)}</div>`,
        btn(`Sign in with ${sso.label}`, { variant: "primary", href: `/login/sso${returnTo === "/" ? "" : `?return=${encodeURIComponent(returnTo)}`}`, className: "k-wide" }),
        disclose(sso.operatorsOnly ? "Instance operators: use a password" : "Use a password", form),
      ]);
  return shell("Sign in · Toolroll", outPage({
    brand: BRAND_HTML, brandHref: "/login", title: "Sign in", body,
    foot: html`${sso === null ? html`Forgot it? Your first login was shown when Toolroll started, and saved beside its database in <code>.toolroll-secrets/up-login.txt</code> on the computer running it.<br>` : ""}No account? Ask whoever runs this Toolroll for an invite link.`,
  }), { nav: false });
}

/**
 * The page for an address the console doesn't answer to (onboarding): what was opened, where it answers, and the exact
 * command that admits this address. It stands alone (styles inline, no script, no font), because every other asset
 * would be refused at this address too; and it holds nothing a stranger's page doesn't already know.
 */
export function wrongHostPage(facts: { opened: string | null; served: string; command: string | null }): Html {
  const code = (text: string) => html`<code>${text}</code>`;
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Toolroll isn't set up for this address</title>
<style>
:root{color-scheme:light dark;--ground:#efefef;--paper:#fff;--ink:#171717;--muted:#666;--line:#e6e6e6;--soft:#f2f2f2}
@media (prefers-color-scheme:dark){:root{--ground:#0b0b0b;--paper:#161616;--ink:#ededed;--muted:#a1a1a1;--line:#262626;--soft:#1f1f1f}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--ground);color:var(--ink);
font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:520px;background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:28px}
.mark{font-weight:600;letter-spacing:-.01em;color:var(--muted);margin:0 0 16px}h1{font-size:18px;line-height:1.375;margin:0 0 8px;letter-spacing:-.01em}
p{margin:0 0 12px}code{font:12.5px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:var(--soft);border-radius:5px;padding:1px 5px;overflow-wrap:anywhere}
pre{margin:0 0 16px;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px 14px;white-space:pre-wrap;overflow-wrap:anywhere}pre code{background:none;padding:0}
.meta{color:var(--muted);font-size:13px;margin:0}
</style></head><body><main>
<p class="mark">Toolroll</p>
<h1>Toolroll isn't set up for this address</h1>
${facts.opened === null
    ? html`<p>It answers at ${code(facts.served)} on the computer running it.</p>`
    : html`<p>You opened it at ${code(facts.opened)}. It answers at ${code(facts.served)} on the computer running it.</p>`}
${facts.command === null ? "" : html`<p>To use this address, stop Toolroll (Ctrl-C) and start it again with:</p><pre><code>${facts.command}</code></pre>`}
<p class="meta">On that computer, ${code(`http://${facts.served}/`)} always works. Other addresses need your say-so, so no other website can reach it.</p>
</main></body></html>`;
}

/** Which field a first-account refusal is about (null: the page itself, as when the tries are spent). */
export type SignupProblem = { field: "code" | "name" | "password" | null; text: string };

/** The username rule, said once for the server's check, the input's `pattern` (anchored by the browser; `\-` so the
 * v-flag parse accepts it) and the hint. */
export const SIGNUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SIGNUP_NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}";
export const SIGNUP_PASSWORD_MIN = 8;

/** The first-account page (setup review): shown only while no approver exists. Rules are stated up front and match
 * the inputs' own constraints. On a refusal the typed username comes back; the setup code and the password never do.
 * The message sits under the field it is about, announced (role="alert"), with that field aria-invalid, described by
 * it and focused, so it works without script (this page has none). */
export function signupPage(problem: SignupProblem | string | null, attemptsLeft: number, typedName = ""): Html {
  const open = attemptsLeft > 0;
  // Out of tries, the page always says why and what to do, also when it is simply opened again.
  const said: SignupProblem | null = typeof problem === "string" ? { field: null, text: problem }
    : problem ?? (open ? null : { field: null, text: "Too many wrong setup codes. Restart Toolroll to get a new code." });
  const field = open ? said?.field ?? null : null;
  const error = (which: SignupProblem["field"]): string | null => field === which && said !== null ? said.text : null;
  const tries = attemptsLeft === 1 ? "1 try left" : `${attemptsLeft} tries left`;
  const pageProblem = !open || field === null ? (said === null ? "" : notice(said.text)) : "";
  const form = !open ? "" : postForm("/signup", joinHtml([
    outField({ id: "signup-code", label: "Setup code", name: "code", hint: `Printed in the terminal that started Toolroll. ${tries}.`, error: error("code"),
      attrs: { inputmode: "numeric", autocomplete: "one-time-code", autocapitalize: "none", spellcheck: "false", required: true, ...(field === null ? { autofocus: true } : {}) } }),
    outField({ id: "signup-name", label: "Username", name: "name", value: typedName, hint: "Letters, digits, dots, dashes or underscores, starting with a letter or digit. Up to 64.", error: error("name"),
      attrs: { autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: true, maxlength: 64, pattern: SIGNUP_NAME_PATTERN } }),
    outField({ id: "signup-password", label: "Password", name: "password", type: "password", hint: `At least ${SIGNUP_PASSWORD_MIN} characters. You'll type it again to approve work.`, error: error("password"),
      attrs: { autocomplete: "new-password", required: true, minlength: SIGNUP_PASSWORD_MIN } }),
    btn("Create account", { variant: "primary", type: "submit", className: "k-wide" }),
  ]), { signedOut: true, attrs: { class: "k-form" } });
  return shell("Create the first account · Toolroll", outPage({
    brand: BRAND_HTML, brandHref: "/login", title: "Create the first account",
    sub: "This Toolroll has no accounts yet. The first one can approve work and invite others.",
    body: joinHtml([pageProblem, form]),
    foot: "Lost the code? Restart Toolroll and it prints a new one.",
  }), { nav: false });
}

/** The page a browser sees when answering broke (Wave E): what happened, whether anything changed, a reference for the
 * log, and two ways on. `read`: the request only read, so nothing can have changed. Holds no error text. */
export function serverErrorPage(options: { updating: boolean; read: boolean; reference: string; at: Date; retry: string | null }): Html {
  if (options.updating) {
    return shell("Toolroll is updating", outPage({
      brand: BRAND_HTML, title: "Toolroll is updating",
      sub: "Work that is running can finish. New work starts again after the update, usually within two minutes.",
      body: html`<div class="k-acts">${options.retry === null ? "" : btn("Try again", { variant: "primary", href: options.retry })}${btn("Go to Home", { href: "/" })}</div>`,
    }), { nav: false });
  }
  return shell("Something went wrong", outPage({
    brand: BRAND_HTML, title: "Something went wrong on our side",
    sub: options.read ? "Toolroll couldn't load this page. Nothing you did was lost, and nothing was approved or sent."
      : "Toolroll couldn't finish that. Open the page again to see what changed before you try again.",
    body: joinHtml([
      facts([["Reference", html`<span class="k-mono">${options.reference}</span>`], ["When", options.at.toISOString().slice(0, 16).replace("T", " ")]]),
      html`<div class="k-acts">${options.retry === null ? "" : btn("Try again", { variant: "primary", href: options.retry })}${btn("Go to Home", { href: "/" })}</div>`,
    ]),
    foot: "If it keeps happening, the reference helps whoever runs this Toolroll find it in the log.",
  }), { nav: false });
}
