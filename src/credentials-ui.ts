/**
 * Settings → Sessions & tokens (v101): where you're signed in (sign any of
 * them out), and your API tokens (make one, revoke one). An instance operator
 * can see and end everyone's.
 */
import type { ApiTokenRow, WebSessionRow } from "./store.js";
import { daysLeft, expiryNoticeDue, TOKEN_DAYS, tokenLive } from "./api-tokens.js";
import { projectName } from "./project.js";
import { html, postForm, type Html } from "./html.js";


export const CREDENTIALS_CSS = `.credentials{max-width:820px;min-width:0}.credentials .card{padding:14px 16px;margin:12px 0}.credentials h2{font-size:1.05rem;margin:0 0 8px}` +
  `.credentials .rows{display:grid;gap:0;border:1px solid var(--so-line);border-radius:10px;overflow:hidden}.credentials .row-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--so-line)}` +
  `.credentials .row-item:last-child{border-bottom:0}.credentials .row-item p{margin:0}.credentials .row-item .meta{font-size:.85rem}.credentials form{margin:0}.credentials button{min-height:40px;white-space:nowrap}` +
  `.credentials .create{display:grid;gap:10px}.credentials .create label{display:grid;gap:6px}.credentials .create input,.credentials .create select{box-sizing:border-box;width:100%}.credentials .badge-here{font-size:.75rem;padding:1px 6px;border-radius:999px;background:var(--so-success-soft);color:var(--so-success);margin-left:6px}` +
  `.credentials .row-item>div{min-width:0}.credentials .row-item p{overflow-wrap:anywhere}.credentials .soon{color:var(--so-warning,#9a6700);font-weight:600}` +
  `@media(max-width:600px){.credentials .row-item{flex-wrap:wrap}.credentials .create input,.credentials .create select{font-size:16px}}`;

/** "Chrome on macOS", from a user agent, for a person to recognise a session. */
export function deviceWords(agent: string | null): string {
  if (agent === null || agent === "") return "Unknown device";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : /curl|node|undici|python|Go-http/i.test(agent) ? "A script" : "A browser";
  const system = /iPhone|iPad/.test(agent) ? "iPhone or iPad" : /Android/.test(agent) ? "Android" : /Mac OS X|Macintosh/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : null;
  return system === null ? browser : `${browser} on ${system}`;
}

const when = (value: string | number | null, now: number) => {
  if (value === null) return "never";
  const at = typeof value === "number" ? value : Date.parse(value);
  const minutes = Math.round((now - at) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 60 * 24 ? `${Math.round(minutes / 60)} h ago` : new Date(at).toISOString().slice(0, 10);
};

export type CredentialsView = {
  who: string; everyone: boolean; canSeeEveryone: boolean;
  sessions: (WebSessionRow & { here: boolean })[];
  tokens: ApiTokenRow[];
  now: number;
  /** Request limits (request-budget-ui.ts): words for each token's line, and the operator's disclosure. */
  limits?: { note: (token: ApiTokenRow) => string; section: Html };
};

export function credentialsHtml(view: CredentialsView, notice: { said?: string | null; problem?: string | null }): Html {
  const post = (fields: Record<string, string>, label: string, style = "secondary") => postForm("/settings/sessions", html`<button class="${style}">${label}</button>`, { hidden: { ...fields, ...(view.everyone ? { everyone: "1" } : {}) } });
  const note = notice.problem ? html`<p class="problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";
  const toggle = view.canSeeEveryone ? html`<p class="meta"><a href="/settings/sessions${view.everyone ? "" : "?everyone=1"}">${view.everyone ? "Show only mine" : "Show everyone's"}</a></p>` : "";
  const sessions = view.sessions.length === 0 ? html`<p class="meta">No one else is signed in.</p>` : html`<div class="rows">${view.sessions.map(one =>
    html`<div class="row-item" data-session="${one.idHash.slice(0, 12)}"><div><p>${view.everyone ? html`<strong>${one.account}</strong> · ` : ""}${deviceWords(one.agent)}${one.here ? html`<span class="badge-here">This browser</span>` : ""}</p>\
<p class="meta">${one.ssoAt === null ? "Password" : "Identity provider"} · ${one.address ?? "unknown address"} · active ${when(one.lastSeen, view.now)} · signed in ${when(one.createdAt, view.now)}</p></div>\
${one.here ? "" : post({ action: "end-session", session: one.idHash }, "Sign out")}</div>`)}</div>`;
  const others = view.sessions.filter(one => !one.here && one.account === view.who).length;
  const endOthers = others > 0 && !view.everyone ? post({ action: "end-others" }, `Sign out everywhere else (${others})`) : "";
  const live = view.tokens.filter(one => tokenLive(one, view.now));
  // v111: its projects, and one state: when it stops (soon, said once and marked) or, once replaced, when it ends.
  const ends = (one: ApiTokenRow): Html => {
    if (one.replacedBy !== null && one.overlapUntil !== null) return html`<span class="soon">Replaced · stops ${one.overlapUntil.slice(11, 16)} UTC</span>`;
    if (expiryNoticeDue(one, view.now) === null) return html`Expires ${one.expiresAt.slice(0, 10)}`;
    const days = daysLeft(one.expiresAt, view.now);
    return html`<span class="soon">Expires ${days <= 1 ? "within a day" : `in ${days} days`}</span>`;
  };
  const scope = (one: ApiTokenRow) => one.projects === null ? "All projects" : one.projects.length === 0 ? "No projects" : one.projects.map(repo => projectName(repo)).join(", ");
  const tokens = live.length === 0 ? html`<p class="meta">No API tokens.</p>` : html`<div class="rows">${live.map(one =>
    html`<div class="row-item" data-token="${one.id}"><div><p>${view.everyone ? html`<strong>${one.account}</strong> · ` : ""}${one.name} · ${one.access === "act" ? "Can act" : "Read only"}</p>\
<p class="meta">${scope(one)} · ${ends(one)} · last used ${when(one.lastUsedAt, view.now)}${view.limits === undefined ? "" : ` · ${view.limits.note(one)}`}</p></div>${post({ action: "revoke-token", token: one.id }, "Revoke")}</div>`)}</div>`;
  const create = html`<details class="card"><summary>New API token</summary>${postForm("/settings/sessions", html`\
<label>Name<input type="text" name="name" maxlength="60" required placeholder="for example: CI"></label>\
<label>It can<select name="access"><option value="read">Read (tasks, results, the ledger)</option><option value="act">Act as you (file and manage work; never approve)</option></select></label>\
<label>Expires in<select name="days">${TOKEN_DAYS.map(days => html`<option value="${days}"${days === 90 ? " selected" : ""}>${days} days</option>`)}</select></label>\
<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label><button>Make the token</button>`, { attrs: { class: "create" }, hidden: { action: "create-token" } })}</details>`;
  return html`<section class="credentials">${note}${toggle}<h2>Signed in</h2>${sessions}${endOthers}<h2 style="margin-top:1.5rem">API tokens</h2>\
<p class="meta">For scripts and CI: send <code>Authorization: Bearer &lt;token&gt;</code>. A token can't approve anything.</p>${tokens}${view.everyone ? "" : create}${view.limits?.section ?? ""}</section>`;
}

/** The token, once: a focused page with no script. */
export function tokenShownHtml(name: string, token: string, access: "read" | "act", expiresAt: string): Html {
  return html`<h1>${name}</h1><div class="card"><p>Your API token, shown once. Only a hash is kept, so copy it now.</p><p class="mono secret-value">${token}</p>\
<p class="meta">${access === "act" ? "It acts as you (never approves)" : "It reads"} until ${expiresAt.slice(0, 10)}. Revoke it any time on Sessions &amp; tokens.</p></div><p class="meta"><a href="/settings/sessions">Back to Sessions &amp; tokens</a></p>`;
}
