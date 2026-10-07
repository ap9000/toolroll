/**
 * People → a person: their API tokens, each with its standing and last use, and their recent remote actions
 * (remote-audit.ts). A token's name filters the actions to it (`token-name`: a `token` query is always refused). Read-only: making, revoking and rotating tokens stay
 * in Settings → Sessions & tokens. Never a token's secret or a ledger line's raw detail.
 */
import { basename } from "node:path";
import { tokenStatus, type AuditAction } from "./remote-audit.js";
import type { ApiTokenRow } from "./store.js";

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const stamp = (value: string) => `${value.slice(0, 16).replace("T", " ")} UTC`;

export const PEOPLE_AUDIT_CSS = `.person-audit{max-width:820px;min-width:0;overflow-wrap:anywhere}.person-audit h2{font-size:1.05rem;margin:1.25rem 0 8px}` +
  `.person-audit .rows{display:grid;border:1px solid var(--so-line);border-radius:10px;overflow:hidden}.person-audit .row-item{padding:10px 14px;border-bottom:1px solid var(--so-line);min-width:0}` +
  `.person-audit .row-item:last-child{border-bottom:0}.person-audit .row-item p{margin:0}.person-audit .row-item .meta{font-size:.85rem}` +
  `.person-audit a{display:inline-flex;align-items:center;min-height:44px}.person-audit .row-item a{min-height:32px}.person-audit a:focus-visible{outline:2px solid var(--so-accent);outline-offset:2px;border-radius:4px}` +
  `.person-audit .outcome{display:inline-block;font-size:.8rem;font-weight:600;padding:1px 8px;border-radius:999px;margin-right:8px}` +
  `.person-audit .outcome-ok{background:var(--so-success-soft);color:var(--so-success)}.person-audit .outcome-refused{background:var(--so-warning-soft);color:var(--so-ink)}` +
  `.person-audit .outcome-error{background:var(--so-danger-soft);color:var(--so-danger)}` +
  `@media(max-width:600px){.person-audit .row-item a{min-height:44px}}`;

export type PersonAuditView = {
  name: string;
  tokens: readonly ApiTokenRow[];
  actions: readonly AuditAction[];
  /** The token name the actions are filtered to, if any. */
  token: string | null;
  nextCursor: string | null;
  now: Date;
};

export const personHref = (name: string, more: Record<string, string> = {}) => `/people?${new URLSearchParams({ person: name, ...more }).toString()}`;

export function personAuditHtml(view: PersonAuditView): string {
  const tokens = view.tokens.length === 0 ? `<p class="meta">No API tokens.</p>` : `<div class="rows">${view.tokens.map(one => {
    const status = tokenStatus(one, view.now);
    return `<div class="row-item" data-token-name="${e(one.name)}"><p><a href="${e(personHref(view.name, { "token-name": one.name }))}">${e(one.name)}</a></p>` +
      `<p class="meta">${status === "active" ? "Active" : status === "expired" ? "Expired" : "Revoked"} · ${one.access === "act" ? "Can act" : "Read only"} · ` +
      `last used ${one.lastUsedAt === null ? "never" : e(stamp(one.lastUsedAt))}</p></div>`;
  }).join("")}</div>`;
  const filtered = view.token === null ? "" : `<p class="meta">With ${e(view.token)}</p><p><a href="${e(personHref(view.name))}">All tokens</a></p>`;
  const actions = view.actions.length === 0 ? `<p class="meta">No remote actions${view.token === null ? "" : " with this token"}.</p>` : `<div class="rows">${view.actions.map(actionHtml).join("")}</div>`;
  const older = view.nextCursor === null ? "" : `<p><a href="${e(personHref(view.name, { ...(view.token === null ? {} : { "token-name": view.token }), before: view.nextCursor }))}">Older actions</a></p>`;
  return `<p><a href="/people">People</a></p><h1>${e(view.name)}</h1><section class="person-audit"><h2>API tokens</h2>${tokens}` +
    `<h2>Remote activity</h2>${filtered}${actions}${older}</section>`;
}

function actionHtml(action: AuditAction): string {
  const label = action.outcome === "ok" ? "OK" : action.outcome === "refused" ? "Refused" : "Error";
  const detail = [stamp(action.at), action.token ?? "unknown token", action.source === "mcp" ? "Agent (MCP)" : "CLI",
    ...(action.repo === null ? [] : [basename(action.repo)]), ...(action.reason === null ? [] : [action.reason])];
  return `<div class="row-item" data-action="${action.id}"><p><span class="outcome outcome-${action.outcome}">${label}</span>${e(action.name)}` +
    `${action.taskId === null ? "" : ` · <a href="/t/${encodeURIComponent(action.taskId)}">${e(action.taskId)}</a>`}</p><p class="meta">${detail.map(e).join(" · ")}</p></div>`;
}
