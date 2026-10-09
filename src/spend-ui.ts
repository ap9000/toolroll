/**
 * The Spend page (v105): what agent work cost this month, where it went, and
 * the monthly budgets that alert at 50/80/100 % and (unless set to alert
 * only) stop new work at 100 %. An instance operator's page; budgets change
 * with a step-up.
 */
import { html, postForm, type Html } from "./html.js";
import { budgetLabel, usd, type BudgetState, type SpendItem } from "./spend.js";

const projectName = (repo: string) => repo.split("/").filter(Boolean).pop() ?? repo;

export const SPEND_CSS = `.spend{max-width:960px;min-width:0}.spend-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.spend-head h1{margin:0}` +
  `.spend-month{display:flex;gap:10px;align-items:baseline;font-size:.875rem}.spend-total{font-size:1.5rem;font-weight:600;margin:12px 0 2px;font-variant-numeric:tabular-nums}` +
  `.spend h2{font-size:.9375rem;margin:24px 0 8px}.spend table{width:100%;border-collapse:collapse;font-size:.8125rem}.spend th,.spend td{text-align:left;padding:6px 8px 6px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere}` +
  `.spend th{font-weight:500;color:var(--muted-foreground)}.spend td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.spend-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:0 24px}` +
  `.budget{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:10px 0;border-bottom:1px solid var(--border)}.budget .name{font-weight:500;font-size:.875rem}` +
  `.budget .figures{font-size:.8125rem;font-variant-numeric:tabular-nums;text-align:right}.budget .bar{grid-column:1/-1;height:6px;border-radius:3px;background:var(--muted);overflow:hidden}` +
  `.budget .bar span{display:block;height:100%;background:var(--foreground)}.budget.over .bar span{background:var(--danger)}.budget.over .figures{color:var(--danger)}.budget .meta{grid-column:1/-1}` +
  `.budget details{grid-column:1/-1}.spend form.budget-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 12px;align-items:end;margin:8px 0}` +
  `.spend form.budget-form label{display:grid;gap:4px;font-size:.8125rem}.spend form.budget-form .choice{display:flex;gap:8px;align-items:center}.spend form.budget-form button{justify-self:start}`;

export type SpendView = {
  month: string; previous: string; next: string | null;
  items: SpendItem[]; budgets: BudgetState[];
  targets: { value: string; label: string; group: "Everything" | "Projects" | "People" | "Teammates" }[];
  teammateNames: Map<number, string>;
  csrf: string;
};

/** The rows of a breakdown: spend and count by a key, biggest first. */
function breakdown(items: readonly SpendItem[], keyOf: (item: SpendItem) => string | null, top = 12): { key: string; microusd: number; count: number; unpriced: number }[] {
  const rows = new Map<string, { key: string; microusd: number; count: number; unpriced: number }>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const row = rows.get(key) ?? { key, microusd: 0, count: 0, unpriced: 0 };
    row.microusd += item.microusd ?? 0;
    row.count++;
    if (item.microusd === null && item.source === "unpriced") row.unpriced++;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.microusd - a.microusd || b.count - a.count).slice(0, top);
}

function table(title: string, rows: ReturnType<typeof breakdown>, name: (key: string) => string): Html | "" {
  if (rows.length === 0) return "";
  return html`<section><h2>${title}</h2><table><tbody>${rows.map(row => html`<tr><td>${name(row.key)}</td><td class="n">${row.count}</td><td class="n">${usd(row.microusd)}${row.unpriced > 0 ? html` <span class="meta">+${row.unpriced} unpriced</span>` : ""}</td></tr>`)}</tbody></table></section>`;
}

export function spendHtml(view: SpendView, notice: { said?: string | null; problem?: string | null }): Html {
  const note = notice.problem ? html`<p class="problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";
  const total = view.items.reduce((sum, item) => sum + (item.microusd ?? 0), 0);
  const unpriced = view.items.filter(item => item.microusd === null && (item.tokensIn !== null || item.kind !== "run")).length;
  const counts = { run: view.items.filter(item => item.kind === "run").length, teammate: view.items.filter(item => item.kind === "teammate").length, chat: view.items.filter(item => item.kind === "chat").length, sort: view.items.filter(item => item.kind === "sort").length };
  const parts = [`${counts.run} ${counts.run === 1 ? "run" : "runs"}`, ...(counts.teammate > 0 ? [`${counts.teammate} teammate turns`] : []), ...(counts.chat > 0 ? [`${counts.chat} chat turns`] : []), ...(counts.sort > 0 ? [`${counts.sort} ${counts.sort === 1 ? "sort" : "sorts"}`] : [])];
  const nameOfTeammate = (key: string) => view.teammateNames.get(Number(key)) ?? `Teammate ${key}`;
  const budgets = view.budgets.map(budget => {
    const width = Math.min(100, Math.max(0, budget.percent));
    const over = budget.spentMicrousd >= budget.limitMicrousd;
    const label = budgetLabel(budget, budget.scope === "teammate" ? nameOfTeammate(budget.key) : undefined).replace(/'s$/, "");
    return html`<div class="budget${over ? " over" : ""}" data-budget="${budget.id}"><span class="name">${label}</span><span class="figures">${usd(budget.spentMicrousd)} of ${usd(budget.limitMicrousd)} · ${budget.percent}%</span><span class="bar" aria-hidden="true"><span style="width:${width}%"></span></span><span class="meta">${over && budget.hardStop ? "Used up: new API work waits until next month or a higher budget." : budget.hardStop ? "Stops API work at 100%." : "Alerts only."}${budget.unpriced > 0 ? ` ${budget.unpriced} unpriced` : ""}</span><details><summary>Change</summary>${
      postForm("/spend/budget", html`<label>Monthly limit (US dollars)<input type="number" name="usd" min="1" step="1" value="${Math.round(budget.limitMicrousd / 1_000_000)}" required></label><label class="choice"><input type="checkbox" name="stop" value="1"${budget.hardStop ? html` checked` : ""}> Stop new work at 100%</label><label>Your Toolroll password<input type="password" name="password" autocomplete="current-password"></label><button type="submit" name="action" value="save">Save</button> <button type="submit" name="action" value="remove">Remove</button>`,
        { attrs: { class: "budget-form" }, hidden: { target: `${budget.scope}:${budget.key}` } })}</details></div>`;
  });
  const groups = ["Everything", "Projects", "People", "Teammates"] as const;
  const options = groups.map(group => {
    const members = view.targets.filter(one => one.group === group);
    return members.length === 0 ? "" : html`<optgroup label="${group}">${members.map(one => html`<option value="${one.value}">${one.label}</option>`)}</optgroup>`;
  });
  const add = html`<details${view.budgets.length === 0 ? html` open` : ""}><summary>Add a budget</summary>${postForm("/spend/budget", html`<label>For<select name="target" required>${options}</select></label><label>Monthly limit (US dollars)<input type="number" name="usd" min="1" step="1" required></label><label class="choice"><input type="checkbox" name="stop" value="1" checked> Stop new work at 100%</label><label>Your Toolroll password<input type="password" name="password" autocomplete="current-password"></label><button type="submit" name="action" value="save">Add budget</button>`, { attrs: { class: "budget-form" } })}</details>`;
  return html`<article class="spend"><div class="spend-head"><h1>Spend</h1><p class="spend-month"><a href="/spend?month=${view.previous}">← ${view.previous}</a><strong>${view.month}</strong>${view.next === null ? "" : html`<a href="/spend?month=${view.next}">${view.next} →</a>`}<a href="/spend?month=${view.month}&amp;format=csv" download>CSV</a></p></div>${note}<p class="spend-total" data-spend-total="${total}">${usd(total)}</p><p class="meta">${parts.join(" · ")}${unpriced > 0 ? ` · ${unpriced} unpriced (no reported cost or catalogue price)` : ""} · UTC month</p><section><h2>Budgets</h2>${budgets.length === 0 ? html`<p class="meta">No budgets yet.</p>` : budgets}${add}</section><div class="spend-grid">${
    table("By project", breakdown(view.items, item => item.project), projectName)}${
    table("By person", breakdown(view.items, item => item.person), key => key)}${
    table("By teammate", breakdown(view.items, item => item.teammate === null ? null : String(item.teammate)), nameOfTeammate)}${
    table("By model", breakdown(view.items, item => `${item.provider}${item.model === null ? "" : ` · ${item.model}`}`), key => key)}</div><p class="meta">Subscription work is $0; its limits are on Tasks. API work is what the provider reported, or its tokens at the prices in Settings → Models.</p></article>`;
}

/** One row per piece of spend, for a spreadsheet. */
export function spendCsv(items: readonly SpendItem[], teammateNames: Map<number, string>): string {
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ["time_utc", "kind", "project", "person", "teammate", "task", "run", "provider", "model", "tokens_in", "tokens_out", "cost_usd", "priced_by", "billing"];
  const rows = items.map(item => [item.at, item.kind, item.project, item.person, item.teammate === null ? null : teammateNames.get(item.teammate) ?? item.teammate,
    item.taskId, item.runId, item.provider, item.model, item.tokensIn, item.tokensOut, item.microusd === null ? null : (item.microusd / 1_000_000).toFixed(6), item.source, item.authMode].map(cell).join(","));
  return `﻿${head.join(",")}\r\n${rows.map(row => `${row}\r\n`).join("")}`;
}
