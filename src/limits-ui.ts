/**
 * Limits on the Tasks page (v105): each subscription's usage windows, as the
 * provider last said, and each monthly budget, one tile each. A subscription
 * costs nothing per run, so its windows are what bind it; budgets bind work
 * billed to an API key. An instance operator's view.
 */
import type { BrowserLimitTile, BrowserLimits } from "./browser-workspace.js";
import { windowLabel } from "./provider-limits.js";
import { usd, type BudgetState } from "./spend.js";

const PROVIDER_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
/** Plan names worth showing; anything else (an internal billing name) is left off. */
const PLAN_NAMES: Record<string, string> = { free: "Free", plus: "Plus", pro: "Pro", max: "Max", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };

/** "in 25 min", "in 2 h 10 min", or a day and hour ("Fri 11 PM") beyond a day. */
export function resetWords(resetsAt: string, now: Date): string {
  const minutes = Math.max(1, Math.round((Date.parse(resetsAt) - now.getTime()) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 24 * 60) return `in ${Math.floor(minutes / 60)} h${minutes % 60 === 0 ? "" : ` ${minutes % 60} min`}`;
  return new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric" }).format(new Date(resetsAt)).replace(",", "");
}

const ago = (iso: string, now: Date) => {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  return minutes < 60 ? `${minutes}m ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
};

const toneOf = (percent: number, reached: boolean): BrowserLimitTile["tone"] => reached || percent >= 100 ? "danger" : percent >= 80 ? "warning" : "neutral";

export function limitsView(
  windows: readonly { provider: string; window: string; usedPercent: number; windowMinutes: number | null; resetsAt: string | null; reached: boolean; plan: string | null; observedAt: string }[],
  budgets: readonly BudgetState[],
  names: { project: (repo: string) => string; subagent: (id: number) => string },
  now: Date,
): BrowserLimits | null {
  const tiles: BrowserLimitTile[] = [];
  for (const one of windows) {
    // A window that has turned over since the reading starts again from nothing.
    const turned = one.resetsAt !== null && Date.parse(one.resetsAt) <= now.getTime();
    const percent = turned ? 0 : one.usedPercent;
    const reached = !turned && one.reached;
    const stale = now.getTime() - Date.parse(one.observedAt) > 30 * 60_000;
    const provider = PROVIDER_NAMES[one.provider] ?? one.provider;
    const plan = one.plan === null ? "" : Object.hasOwn(PLAN_NAMES, one.plan.toLowerCase()) ? ` ${PLAN_NAMES[one.plan.toLowerCase()]}` : "";
    tiles.push({
      key: `${one.provider}:${one.window}`, name: `${provider}${plan}`, window: windowLabel(one.window, one.windowMinutes),
      value: String(Math.round(percent)), unit: "%", percent, tone: toneOf(percent, reached), marks: [], href: null,
      detail: turned ? "New window" : `${reached ? "Used up · resets" : "Resets"} ${one.resetsAt === null ? "later" : resetWords(one.resetsAt, now)}${stale ? ` · read ${ago(one.observedAt, now)}` : ""}`,
      title: `${provider} said this ${ago(one.observedAt, now)}`,
    });
  }
  for (const budget of budgets) {
    const over = budget.spentMicrousd >= budget.limitMicrousd;
    const name = budget.scope === "installation" ? "Everything" : budget.scope === "project" ? names.project(budget.key)
      : budget.scope === "subagent" ? names.subagent(Number(budget.key)) : budget.key;
    tiles.push({
      key: `budget:${budget.id}`, name, window: "Budget", value: usd(budget.spentMicrousd), unit: `of ${usd(budget.limitMicrousd)}`,
      percent: budget.percent, tone: over ? (budget.hardStop ? "danger" : "warning") : budget.percent >= 80 ? "warning" : "neutral", marks: [50, 80], href: "/spend",
      detail: over && budget.hardStop ? "Used up · API work waits" : budget.hardStop ? "Stops API work at 100%" : "Alerts only",
      title: `This month's spend billed to API keys${budget.unpriced > 0 ? `; ${budget.unpriced} without a price` : ""}`,
    });
  }
  return tiles.length === 0 ? null : { tiles };
}

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The same tiles for the page without scripts. */
export function limitsHtml(limits: BrowserLimits | null): string {
  if (limits === null) return "";
  return `<section class="limits" aria-label="Limits"><ul>${limits.tiles.map(tile => {
    const body = `<p class="limit-name"><strong>${e(tile.name)}</strong> ${e(tile.window)}</p><p class="limit-value"><strong>${e(tile.value)}</strong> ${e(tile.unit)}</p>` +
      `<span class="limit-bar" aria-hidden="true"><span style="width:${Math.min(100, Math.max(0, tile.percent))}%"></span></span><p class="limit-detail">${e(tile.detail)}</p>`;
    return `<li class="limit limit-${tile.tone}" data-limit="${e(tile.key)}"${tile.title === null ? "" : ` title="${e(tile.title)}"`}>${tile.href === null ? body : `<a href="${e(tile.href)}">${body}</a>`}</li>`;
  }).join("")}</ul></section>`;
}

export const LIMITS_CSS = `.limits ul{list-style:none;margin:0 0 16px;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:8px}` +
  `.limit{border:1px solid var(--border);border-radius:10px;background:var(--card);padding:12px 14px;min-width:0}.limit a{color:inherit;text-decoration:none;display:block}` +
  `.limit p{margin:0}.limit-name{font-size:12px;color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.limit-name strong{color:var(--foreground);font-weight:500}` +
  `.limit-value{margin-top:8px!important;font-size:12px;color:var(--muted-foreground);font-variant-numeric:tabular-nums}.limit-value strong{font-size:22px;font-weight:600;color:var(--foreground);letter-spacing:-.02em}` +
  `.limit-bar{display:block;height:6px;border-radius:3px;background:var(--muted);overflow:hidden;margin-top:10px}.limit-bar span{display:block;height:100%;border-radius:3px;background:var(--foreground)}` +
  `.limit-warning .limit-bar span{background:var(--warning)}.limit-danger .limit-bar span{background:var(--danger)}.limit-danger .limit-value strong{color:var(--danger)}` +
  `.limit-detail{margin-top:8px!important;font-size:11.5px;color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`;
