/**
 * Settings → Sessions & tokens: each token's request limits in its line, and — for an instance operator — one
 * disclosure to change them for everyone's tokens or for one token (request-budget.ts). Saving takes the operator's
 * password (or a fresh identity-provider sign-in), in a browser only.
 */
import type { ApiTokenRow, Database } from "./store.js";
import { effectiveLimits, limitOverrides, PER_DAY_MAX, PER_MINUTE_MAX, REQUEST_BUDGET_DEFAULTS, type LimitOverride } from "./request-budget.js";

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const n = (value: number) => value.toLocaleString("en-US");

export const REQUEST_LIMITS_CSS = `.credentials .limits{display:grid;gap:14px}.credentials .limits form{display:grid;gap:10px}.credentials .limits label{display:grid;gap:6px}` +
  `.credentials .limits input,.credentials .limits select{box-sizing:border-box;width:100%;min-width:0}.credentials .limits .pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}.credentials .limits .actions{display:flex;flex-wrap:wrap;gap:8px}` +
  `.credentials .limits h3{font-size:.95rem;margin:4px 0 0}@media(max-width:600px){.credentials .limits .pair{grid-template-columns:1fr}.credentials .limits input,.credentials .limits select{font-size:16px}}`;

/** "120 requests a minute · 10,000 a day" for one token's line. */
export function tokenLimitWords(db: Database, token: ApiTokenRow): string {
  const limits = effectiveLimits(db, token.id, token.access);
  return `${n(limits.perMinute)} requests a minute · ${n(limits.perDay)} a day`;
}

/** The operator's disclosure: everyone's tokens, or one token. Blank fields use the default shown. */
export function requestLimitsHtml(db: Database, tokens: readonly ApiTokenRow[], csrf: string, now: number): string {
  const overrides = limitOverrides(db);
  const everyone: LimitOverride = overrides.get("*") ?? { readPerMinute: null, actPerMinute: null, perDay: null };
  const field = (name: string, label: string, value: number | null, placeholder: string, max: number) =>
    `<label>${label}<input type="number" name="${name}" min="1" max="${max}" step="1" inputmode="numeric" value="${value === null ? "" : value}" placeholder="${placeholder}"></label>`;
  const password = `<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password"></label>`;
  const buttons = `<div class="actions"><button name="action" value="save">Save limits</button><button class="secondary" name="action" value="clear">Use defaults</button></div>`;
  const live = tokens.filter(one => one.revokedAt === null && Date.parse(one.expiresAt) > now);
  const installation = `<form method="post" action="/settings/request-limits"><input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="target" value="*">` +
    `<h3>Everyone's tokens</h3><div class="pair">${field("read-per-minute", "Read tokens, a minute", everyone.readPerMinute, String(REQUEST_BUDGET_DEFAULTS.read), PER_MINUTE_MAX)}` +
    `${field("act-per-minute", "Act tokens, a minute", everyone.actPerMinute, String(REQUEST_BUDGET_DEFAULTS.act), PER_MINUTE_MAX)}</div>` +
    `${field("per-day", "Each token, a day", everyone.perDay, String(REQUEST_BUDGET_DEFAULTS.day), PER_DAY_MAX)}${password}${buttons}</form>`;
  const one = live.length === 0 ? "" : `<form method="post" action="/settings/request-limits"><input type="hidden" name="csrf" value="${e(csrf)}">` +
    `<h3>One token</h3><label>Token<select name="target">${live.map(row => {
      const set = overrides.get(row.id);
      return `<option value="${e(row.id)}">${e(row.name)} (${e(row.account)}, ${row.access === "act" ? "act" : "read"})${set === undefined ? "" : " · own limits"}</option>`;
    }).join("")}</select></label>` +
    `<div class="pair">${field("per-minute", "A minute", null, "Everyone's", PER_MINUTE_MAX)}${field("per-day", "A day", null, "Everyone's", PER_DAY_MAX)}</div>${password}${buttons}</form>`;
  return `<details class="card"><summary>Request limits</summary><div class="limits">${installation}${one}</div></details>`;
}
