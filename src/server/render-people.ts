/** Sign-in, sign-up, join and wrong-host pages. */
import { BRAND_HTML,shell } from "./chrome.js";
import { html, joinHtml, postForm, replaceMarkup, type Html } from "../html.js";

/** The invite's front door: cookie-free, script-free, sensitive by shape.
 * Rendered only for a LIVE token — everything dead gets joinDeadPage. */
export function joinFormPage(token: string, problem: string | null, name: string): Html {
  return shell("Join Toolroll", joinHtml([
    html`<div class="login-viewport"><div class="login-shell">`,
    html`<h1 class="so-wordmark login-brand">${BRAND_HTML}</h1>`,
    html`<p class="meta hint">You were invited. Pick a name and a password to sign in.</p>`,
    html`<div class="login-card">`,
    problem === null ? "" : html`<div class="problem" role="alert">${problem}</div>`,
    postForm(`/join/${token}`, joinHtml([
      html`<label>Username<input type="text" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${name}" autofocus></label>`,
      html`<label>Password<input type="password" name="password" autocomplete="new-password"></label>`,
      html`<button type="submit">Create my sign-in</button>`,
    ], "\n"), { signedOut: true }),
    html`</div>`,
    html`<p class="login-foot">This link works once, for you.</p>`,
    html`</div></div>`,
  ], "\n"), { nav: false });
}

/** Unknown, expired, revoked, consumed, attempts spent: ONE page (D6). */
export function joinDeadPage(): Html {
  return shell("Join Toolroll", html`<div class="login-viewport"><div class="login-shell">
<h1 class="so-wordmark login-brand">${BRAND_HTML}</h1>
<div class="login-card">
<p>This invite link can't be used.</p>
<p class="meta">Links work once and expire. Ask the person who invited you for a fresh one.</p>
</div>
</div></div>`, { nav: false });
}

/**
 * v100: for someone signed in with the identity provider, every step-up
 * password field (autocomplete="current-password"; a secret like a bot token
 * is never one) becomes that sign-in: confirmed, when the provider checked
 * them in the last ten minutes, or a link to be checked again, then back here.
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

export function loginPage(problem: string | null, returnTo = "/", sso: { label: string; operatorsOnly: boolean } | null = null): Html {
  // v100: with an identity provider, its button comes first and passwords wait behind "Use a password".
  const provider = sso === null ? "" : html`<a class="button-link login-sso" href="/login/sso${returnTo === "/" ? "" : `?return=${encodeURIComponent(returnTo)}`}">Sign in with ${sso.label}</a>`;
  return shell("Toolroll", joinHtml([
    html`<div class="login-viewport"><div class="login-shell">`,
    html`<h1 class="so-wordmark login-brand">${BRAND_HTML}</h1>`,
    problem === null || sso === null ? "" : html`<div class="problem" role="alert">${problem}</div>`,
    provider,
    sso === null ? "" : html`<details class="login-password"><summary>${sso.operatorsOnly ? "Instance operators: use a password" : "Use a password"}</summary>`,
    html`<div class="login-card">`,
    problem === null || sso !== null ? "" : html`<div class="problem" role="alert">${problem}</div>`,
    postForm("/login", joinHtml([
      html`<label>Username<input type="text" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>`,
      html`<label>Password<input type="password" name="token" autocomplete="current-password"></label>`,
      html`<button type="submit">Sign in</button>`,
    ], "\n"), { signedOut: true, returnTo: returnTo === "/" ? null : returnTo }),
    html`</div>`,
    sso === null ? "" : html`</details>`,
    html`<p class="login-foot">${sso === null ? html`Your login was shown when Toolroll first started, and saved beside its database as <code>up-login.txt</code>.<br>` : ""}No account? Ask whoever runs it for an invite link.</p>`,
    html`</div></div>`,
  ], "\n"), { nav: false });
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

/** The first-account page (setup review): shown only while no approver exists. */
export function signupPage(problem: string | null, attemptsLeft: number): Html {
  return shell("Toolroll", joinHtml([
    html`<div class="login-viewport"><div class="login-shell">`,
    html`<h1 class="so-wordmark login-brand">${BRAND_HTML}</h1>`,
    html`<div class="login-card">`,
    html`<p><strong>Create the first account</strong></p>`,
    html`<p class="meta">There are no accounts yet. The terminal that started Toolroll printed a setup code; enter it here with the username and password you want.</p>`,
    problem === null ? "" : html`<div class="problem">${problem}</div>`,
    attemptsLeft <= 0
      ? ""
      : postForm("/signup", joinHtml([
          html`<label>Setup code<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus></label>`,
          html`<label>Username<input type="text" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>`,
          html`<label>Password<input type="password" name="password" autocomplete="new-password"></label>`,
          html`<button type="submit">Create account and sign in</button>`,
        ], "\n"), { signedOut: true }),
    html`</div>`,
    html`</div></div>`,
  ], "\n"), { nav: false });
}
