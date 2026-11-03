/**
 * Settings → Sessions & tokens: each token's request limits in its line, and — for an instance operator — one
 * disclosure to change them for everyone's tokens or for one token (request-budget.ts). Saving takes the operator's
 * password (or a fresh identity-provider sign-in), in a browser only.
 */
import type { ApiTokenRow, Database } from "./store.js";
import { html, joinHtml, type Html } from "./html.js";
import { btn, disclose, formRow, input, note, select, settingsSection } from "./server/kit.js";
import { kitSectionForm } from "./settings-kit.js";
import { effectiveLimits, limitOverrides, PER_DAY_MAX, PER_MINUTE_MAX, REQUEST_BUDGET_DEFAULTS, type LimitOverride } from "./request-budget.js";

const n = (value: number) => value.toLocaleString("en-US");

/** The old card look; the section is built from the kit now. Kept for chrome.ts, which still concatenates it. */
export const REQUEST_LIMITS_CSS = "";

/** "120 requests a minute · 10,000 a day" for one token's line. */
export function tokenLimitWords(db: Database, token: ApiTokenRow): string {
  const limits = effectiveLimits(db, token.id, token.access);
  return `${n(limits.perMinute)} requests a minute · ${n(limits.perDay)} a day`;
}

/** The operator's section: everyone's tokens, or one token. Blank fields use the default shown. Saving takes the
 * operator's password (or Passwordless, or a fresh identity-provider sign-in). */
export function requestLimitsHtml(db: Database, tokens: readonly ApiTokenRow[], now: number): Html {
  const overrides = limitOverrides(db);
  const everyone: LimitOverride = overrides.get("*") ?? { readPerMinute: null, actPerMinute: null, perDay: null };
  const number = (id: string, name: string, label: string, value: number | null, placeholder: string, max: number) =>
    input({ id, name, type: "number", value: value === null ? "" : String(value), attrs: { min: 1, max, step: 1, inputmode: "numeric", placeholder, "aria-label": label } });
  const installation = kitSectionForm({ proof: "request-limits", action: "/settings/request-limits", id: "limits-everyone", gate: true, hidden: { target: "*", action: "save" },
    save: { label: "Save limits" }, confirm: "Change request limits for everyone's tokens",
    body: joinHtml([
      formRow("Read tokens, a minute", `Default ${n(REQUEST_BUDGET_DEFAULTS.read)}.`, number("limits-read", "read-per-minute", "Read tokens, a minute", everyone.readPerMinute, String(REQUEST_BUDGET_DEFAULTS.read), PER_MINUTE_MAX)),
      formRow("Act tokens, a minute", `Default ${n(REQUEST_BUDGET_DEFAULTS.act)}.`, number("limits-act", "act-per-minute", "Act tokens, a minute", everyone.actPerMinute, String(REQUEST_BUDGET_DEFAULTS.act), PER_MINUTE_MAX)),
      formRow("Each token, a day", `Default ${n(REQUEST_BUDGET_DEFAULTS.day)}.`, number("limits-day", "per-day", "Each token, a day", everyone.perDay, String(REQUEST_BUDGET_DEFAULTS.day), PER_DAY_MAX)),
    ]) });
  const reset = kitSectionForm({ proof: "request-limits", action: "/settings/request-limits", id: "limits-everyone-clear", hidden: { target: "*", action: "clear" },
    save: { label: "Use defaults for everyone", variant: "outline" }, confirm: "Put everyone's tokens back on the default limits", body: html`` });
  const live = tokens.filter(one => one.revokedAt === null && Date.parse(one.expiresAt) > now);
  const one = live.length === 0 ? "" : disclose("Limits for one token", kitSectionForm({ proof: "request-limits", action: "/settings/request-limits", id: "limits-one",
    save: { label: "Save limits", name: "action", value: "save" }, confirm: "Change one token's request limits",
    body: joinHtml([
      formRow("Token", null, select({ id: "limits-target", name: "target", label: "Token", wide: true, items: live.map(row => {
        const set = overrides.get(row.id);
        return [row.id, `${row.name} (${row.account}, ${row.access === "act" ? "act" : "read"})${set === undefined ? "" : " · own limits"}`] as const;
      }) })),
      formRow("A minute", "Blank uses everyone's.", number("limits-one-minute", "per-minute", "A minute", null, "Everyone's", PER_MINUTE_MAX)),
      formRow("A day", "Blank uses everyone's.", number("limits-one-day", "per-day", "A day", null, "Everyone's", PER_DAY_MAX)),
      html`<div class="k-acts">${btn("Use everyone's limits", { sm: true, type: "submit", attrs: { name: "action", value: "clear" } })}</div>`,
    ]) }));
  return settingsSection({ id: "request-limits", title: "Request limits", lead: "How many requests each API token may make. A token over its limit is refused until the minute or day resets, and nothing it asked for runs.",
    body: joinHtml([installation, reset, one, note("Only an instance operator sees and changes these.")]) });
}
