/**
 * Settings → Sign-in (v100): the identity provider, the groups that may sign
 * in and what each may do, and who may still use a password. An instance
 * operator's page; changes take their password.
 */
import type { OidcSettings } from "./oidc.js";
import { html, postForm, type Html } from "./html.js";


export const SSO_CSS = `.sign-in{max-width:780px;min-width:0}.sign-in form{display:grid;gap:12px;margin:0}.sign-in label{display:grid;gap:6px}.sign-in input,.sign-in select{box-sizing:border-box;width:100%;max-width:100%;min-width:0}` +
  `.sign-in .card{padding:16px 18px;margin:12px 0}.sign-in .card h2{font-size:1.05rem;margin:0 0 6px}.sign-in .redirect code{user-select:all;overflow-wrap:anywhere}.sign-in button{justify-self:start;min-height:44px}` +
  `.sign-in .rules{display:grid;gap:8px}.sign-in .rule{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,2fr);gap:8px;align-items:start}.sign-in .rule select[multiple]{min-height:5.5rem}` +
  `.sign-in .row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.sign-in fieldset{border:0;padding:0;margin:0;display:grid;gap:6px}.sign-in fieldset label{display:flex;gap:8px;align-items:center}.sign-in fieldset input{width:auto}` +
  `@media(max-width:600px){.sign-in .rule{grid-template-columns:1fr}.sign-in input,.sign-in select{font-size:16px}}`;

export type SsoSettingsView = {
  settings: OidcSettings | null;
  /** The address to register with the provider as this app's sign-in redirect. */
  redirect: string | null;
  projects: { path: string; name: string }[];
  /** Whether the person looking is linked to the provider already. */
  linked: boolean;
};

const password = html`<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>`;

function ruleRow(index: number, rule: OidcSettings["rules"][number] | null, projects: SsoSettingsView["projects"]): Html {
  const chosen = rule === null ? [] : rule.projects === "all" ? ["all"] : rule.projects;
  return html`<div class="rule"><label>Group<input type="text" name="group-${index}" value="${rule?.group ?? ""}" placeholder="${index === 0 ? "for example: engineering" : ""}" autocomplete="off"></label>\
<label>Role<select name="role-${index}"><option value="operator"${rule?.role === "operator" ? " selected" : ""}>Operator</option><option value="viewer"${rule?.role === "viewer" ? " selected" : ""}>Viewer</option></select></label>\
<label>Projects<select name="projects-${index}" multiple><option value="all"${chosen.includes("all") ? " selected" : ""}>All projects</option>${projects.map(one => html`<option value="${one.path}"${chosen.includes(one.path) ? " selected" : ""}>${one.name}</option>`)}</select></label></div>`;
}

export function ssoSettingsHtml(view: SsoSettingsView, notice: { said?: string | null; problem?: string | null }): Html {
  const s = view.settings;
  const rows = [...(s?.rules ?? []), null, null].slice(0, Math.max(3, (s?.rules.length ?? 0) + 1)).map((rule, index) => ruleRow(index, rule, view.projects));
  const note = notice.problem ? html`<p class="problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";
  const redirect = view.redirect === null
    ? html`<p class="meta">Open this page from the address people use (your https address) to see the redirect address to register.</p>`
    : html`<p class="redirect">Register this redirect address with the provider: <code>${view.redirect}</code></p>`;
  const form = postForm("/settings/sign-in", html`\
<label>Provider address (issuer)<input type="url" name="issuer" value="${s?.issuer ?? ""}" placeholder="https://acme.okta.com/oauth2/default" required inputmode="url" autocomplete="off"></label>\
<label>Client ID<input type="text" name="client-id" value="${s?.clientId ?? ""}" required autocomplete="off"></label>\
<label>Client secret<input type="password" name="client-secret" autocomplete="off" placeholder="${s?.clientSecret ? "Saved. Leave blank to keep it" : "Leave blank for a public client"}"></label>\
<details><summary>More</summary><label>Button says “Sign in with …”<input type="text" name="label" value="${s?.label ?? ""}" placeholder="Okta"></label>\
<label>Scopes<input type="text" name="scopes" value="${s?.scopes ?? "openid email profile"}"></label><label>Groups claim<input type="text" name="groups-claim" value="${s?.groupsClaim ?? "groups"}"></label></details>\
<h2>Who may sign in</h2><p class="meta">A person's first matching group sets their role and projects, again at every sign-in. No match, no entry. Use * for everyone.</p><div class="rules">${rows}</div>\
<fieldset><legend>Passwords</legend><label><input type="radio" name="passwords" value="everyone"${s?.passwords !== "operators" ? " checked" : ""}> Everyone may still use a password</label>\
<label><input type="radio" name="passwords" value="operators"${s?.passwords === "operators" ? " checked" : ""}> Only instance operators (a way in if the provider is down)</label></fieldset>\
${password}<button>${s === null ? "Turn on sign-in with the provider" : "Save"}</button>`, { hidden: { action: "save" } });
  const test = s === null ? "" : postForm("/settings/sign-in", html`<button class="secondary">Check the provider</button>`, { attrs: { class: "row" }, hidden: { action: "test" } });
  const link = s === null ? "" : view.linked
    ? html`<p class="meta">You sign in with ${s.label}.</p>`
    : html`<section class="card"><h2>Your account</h2><p>Sign in with ${s.label} as this account from now on.</p><p><a class="button-link" href="/login/sso?link=1">Link to ${s.label}</a></p></section>`;
  const off = s === null ? "" : html`<details class="card"><summary>Turn off</summary>${postForm("/settings/sign-in", html`<p>People who signed in with ${s.label} can't sign in until it's on again, unless they have a password.</p>${password}<button class="danger">Turn off sign-in with ${s.label}</button>`, { hidden: { action: "remove" } })}</details>`;
  return html`<section class="sign-in">${note}<p>People sign in with your organisation's identity provider (Okta, Microsoft Entra, Google, anything that speaks OpenID Connect), and its groups decide what they may do.</p>\
${redirect}<section class="card">${form}</section>${test}${link}${off}</section>`;
}
