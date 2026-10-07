/**
 * Settings → Sessions & tokens (v101): where you're signed in (sign any of
 * them out), and your API tokens (make one, revoke one). An instance operator
 * can see and end everyone's.
 */
import type { ApiTokenRow, WebSessionRow } from "./store.js";
import { daysLeft, expiryNoticeDue, TOKEN_DAYS, tokenLive } from "./api-tokens.js";
import { projectName } from "./project.js";

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

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
  limits?: { note: (token: ApiTokenRow) => string; section: string };
};

export function credentialsHtml(view: CredentialsView, csrf: string, notice: { said?: string | null; problem?: string | null }): string {
  const hidden = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join("");
  const post = (fields: Record<string, string>, label: string, style = "secondary") => `<form method="post" action="/settings/sessions">${hidden({ csrf, ...fields, ...(view.everyone ? { everyone: "1" } : {}) })}<button class="${style}">${label}</button></form>`;
  const note = notice.problem ? `<p class="problem" role="alert">${e(notice.problem)}</p>` : notice.said ? `<p role="status">${e(notice.said)}</p>` : "";
  const toggle = view.canSeeEveryone ? `<p class="meta"><a href="/settings/sessions${view.everyone ? "" : "?everyone=1"}">${view.everyone ? "Show only mine" : "Show everyone's"}</a></p>` : "";
  const sessions = view.sessions.length === 0 ? `<p class="meta">No one else is signed in.</p>` : `<div class="rows">${view.sessions.map(one =>
    `<div class="row-item" data-session="${e(one.idHash.slice(0, 12))}"><div><p>${view.everyone ? `<strong>${e(one.account)}</strong> · ` : ""}${e(deviceWords(one.agent))}${one.here ? `<span class="badge-here">This browser</span>` : ""}</p>` +
    `<p class="meta">${one.ssoAt === null ? "Password" : "Identity provider"} · ${e(one.address ?? "unknown address")} · active ${e(when(one.lastSeen, view.now))} · signed in ${e(when(one.createdAt, view.now))}</p></div>` +
    `${one.here ? "" : post({ action: "end-session", session: one.idHash }, "Sign out")}</div>`).join("")}</div>`;
  const others = view.sessions.filter(one => !one.here && one.account === view.who).length;
  const endOthers = others > 0 && !view.everyone ? post({ action: "end-others" }, `Sign out everywhere else (${others})`) : "";
  const live = view.tokens.filter(one => tokenLive(one, view.now));
  // v111: its projects, and one state: when it stops (soon, said once and marked) or, once replaced, when it ends.
  const ends = (one: ApiTokenRow) => {
    if (one.replacedBy !== null && one.overlapUntil !== null) return `<span class="soon">Replaced · stops ${e(one.overlapUntil.slice(11, 16))} UTC</span>`;
    if (expiryNoticeDue(one, view.now) === null) return `Expires ${e(one.expiresAt.slice(0, 10))}`;
    const days = daysLeft(one.expiresAt, view.now);
    return `<span class="soon">Expires ${days <= 1 ? "within a day" : `in ${days} days`}</span>`;
  };
  const scope = (one: ApiTokenRow) => one.projects === null ? "All projects" : one.projects.length === 0 ? "No projects" : one.projects.map(repo => e(projectName(repo))).join(", ");
  const tokens = live.length === 0 ? `<p class="meta">No API tokens.</p>` : `<div class="rows">${live.map(one =>
    `<div class="row-item" data-token="${e(one.id)}"><div><p>${view.everyone ? `<strong>${e(one.account)}</strong> · ` : ""}${e(one.name)} · ${one.access === "act" ? "Can act" : "Read only"}</p>` +
    `<p class="meta">${scope(one)} · ${ends(one)} · last used ${e(when(one.lastUsedAt, view.now))}${view.limits === undefined ? "" : ` · ${e(view.limits.note(one))}`}</p></div>${post({ action: "revoke-token", token: one.id }, "Revoke")}</div>`).join("")}</div>`;
  const create = `<details class="card"><summary>New API token</summary><form method="post" action="/settings/sessions" class="create">${hidden({ csrf, action: "create-token" })}` +
    `<label>Name<input type="text" name="name" maxlength="60" required placeholder="for example: CI"></label>` +
    `<label>It can<select name="access"><option value="read">Read (tasks, results, the ledger)</option><option value="act">Act as you (file and manage work; never approve)</option></select></label>` +
    `<label>Expires in<select name="days">${TOKEN_DAYS.map(days => `<option value="${days}"${days === 90 ? " selected" : ""}>${days} days</option>`).join("")}</select></label>` +
    `<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label><button>Make the token</button></form></details>`;
  return `<section class="credentials">${note}${toggle}<h2>Signed in</h2>${sessions}${endOthers}<h2 style="margin-top:1.5rem">API tokens</h2>` +
    `<p class="meta">For scripts and CI: send <code>Authorization: Bearer &lt;token&gt;</code>. A token can't approve anything.</p>${tokens}${view.everyone ? "" : create}${view.limits?.section ?? ""}</section>`;
}

/** The token, once: a focused page with no script. */
export function tokenShownHtml(name: string, token: string, access: "read" | "act", expiresAt: string): string {
  return `<h1>${e(name)}</h1><div class="card"><p>Your API token, shown once. Only a hash is kept, so copy it now.</p><p class="mono secret-value">${e(token)}</p>` +
    `<p class="meta">${access === "act" ? "It acts as you (never approves)" : "It reads"} until ${e(expiresAt.slice(0, 10))}. Revoke it any time on Sessions &amp; tokens.</p></div><p class="meta"><a href="/settings/sessions">Back to Sessions &amp; tokens</a></p>`;
}
