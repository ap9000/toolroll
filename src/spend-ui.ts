/**
 * The Spend page (docs/plans/spend-dashboard.md, slice 1): what agent work cost this month, with API dollars, plan
 * usage and unknown cost kept apart and never added together, broken down by project, model, role and person, the
 * runs that cost most, and what isn't recorded here. An instance operator's page. Monthly limits show read-only here
 * and change on Settings → Spend, with a step-up.
 */
import { html, postForm, type Html, reauth } from "./html.js";
import { budgetLabel, usd, type BudgetState, type SpendItem } from "./spend.js";
import type { SpendLine, SpendReport, SpendRole } from "./spend-report.js";
import { runHref, taskHref } from "./server/http.js";

const projectName = (repo: string) => repo.split("/").filter(Boolean).pop() ?? repo;

export const SPEND_CSS = `.spend{max-width:960px;min-width:0}.spend-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.spend-head h1{margin:0}` +
  `.spend-month{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:.875rem;margin:0}` +
  `.spend h2{font-size:.9375rem;margin:24px 0 8px}.spend table{width:100%;border-collapse:collapse;font-size:.8125rem}.spend th,.spend td{text-align:left;padding:6px 8px 6px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere}` +
  `.spend th{font-weight:500;color:var(--muted-foreground)}.spend td.n,.spend th.n{text-align:right;font-variant-numeric:tabular-nums}.spend td.n,.spend th.n{white-space:nowrap}.spend table.lines td:first-child{overflow-wrap:break-word;width:40%}` +
  `.spend-figures{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:16px 0 4px}.spend-figure{border:1px solid var(--border);border-radius:10px;padding:12px 14px;min-width:0}` +
  `.spend-figure h2{margin:0;font-size:.8125rem;font-weight:500;color:var(--muted-foreground)}.spend-figure .value{margin:6px 0 0;font-size:1.5rem;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}` +
  `.spend-figure .meta{margin:4px 0 0}.spend-not-counted ul{margin:0;padding-left:20px;font-size:.8125rem}.spend-not-counted li{margin:2px 0}` +
  `.budget{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:10px 0;border-bottom:1px solid var(--border)}.budget .name{font-weight:500;font-size:.875rem}` +
  `.budget .figures{font-size:.8125rem;font-variant-numeric:tabular-nums;text-align:right}.budget .bar{grid-column:1/-1;height:6px;border-radius:3px;background:var(--muted);overflow:hidden}` +
  `.budget .bar span{display:block;height:100%;background:var(--foreground)}.budget.over .bar span{background:var(--danger)}.budget.over .figures{color:var(--danger)}.budget .meta{grid-column:1/-1}` +
  `.budget details{grid-column:1/-1}.spend form.budget-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 12px;align-items:end;margin:8px 0}` +
  `.spend form.budget-form label{display:grid;gap:4px;font-size:.8125rem}.spend form.budget-form .choice{display:flex;gap:8px;align-items:center}.spend form.budget-form button{justify-self:start}` +
  `.spend-models dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 16px;margin:0 0 8px;font-size:.875rem}.spend-models dt{color:var(--muted-foreground)}.spend-models dd{margin:0;overflow-wrap:anywhere}` +
  `@media(max-width:640px){.spend-figures{grid-template-columns:minmax(0,1fr)}.spend table.lines thead{display:none}.spend table.lines tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px 12px;padding:8px 0;border-bottom:1px solid var(--border)}` +
  `.spend table.lines td{border:0;padding:0;white-space:normal}.spend table.lines td:first-child{grid-column:1/-1;font-weight:500;width:auto}.spend table.lines td.n{text-align:left;color:var(--muted-foreground)}.spend table.lines td.n::before{content:attr(data-label);display:block;font-size:.6875rem}}`;

const ROLE_WORDS: Record<SpendRole, string> = {
  builder: "Builds", repair: "Repairs", planner: "Plans", reviewer: "Reviews", scout: "Scouting",
  lead: "Lead chat", chat: "Chat", subagent: "Subagents", flow: "Flows", evals: "Evals",
};

/** What this page doesn't record, in plain words (docs/plans/spend-dashboard.md §2.2). */
export const NOT_COUNTED: readonly string[] = [
  "Sizing a new task (Claude or OpenRouter)",
  "Memory checks that read finished chat sessions",
  "Coding sessions in Code",
  "A flow draft that failed",
  "A Sort step that failed before saving its answer",
];

export type SpendView = {
  month: string; previous: string; next: string | null;
  report: SpendReport;
  /** This month's limits; null for a past month (a limit is this month's). */
  budgets: BudgetState[] | null;
  /** The plan windows as their providers last reported them (limits-ui.ts), or nothing. */
  windows: Html;
  subagentNames: Map<number, string>;
};

const each = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A line's plan usage in words: the reported usage, or that none was reported. Never $0 for unreported usage. */
const usageWords = (line: SpendLine): string =>
  line.usageCount === 0 ? "—" : line.usageMicrousd > 0 ? `${usd(line.usageMicrousd)}${line.usageUnreported > 0 ? ` + ${line.usageUnreported} not reported` : ""}` : "not reported";
/** A line's unknown cost in words: how many, and a saved charge as an estimate. Never $0. */
const unknownWords = (line: SpendLine): string => {
  const counted = line.estimatedMicrousd > 0 ? `${usd(line.estimatedMicrousd)} estimated` : "";
  return line.unknown > 0 ? `${line.unknown}${counted === "" ? "" : ` · ${counted}`}` : counted === "" ? "—" : counted;
};
const apiWords = (line: SpendLine): string => line.apiMicrousd > 0 ? usd(line.apiMicrousd) : "—";

function linesTable(title: string, lines: readonly SpendLine[], name: (key: string) => string, top = 12): Html | "" {
  if (lines.length === 0) return "";
  return html`<section><h2>${title}</h2><table class="lines"><thead><tr><th></th><th class="n">API dollars</th><th class="n">Plan usage</th><th class="n">Unknown</th></tr></thead><tbody>${
    lines.slice(0, top).map(line => html`<tr><td>${name(line.key)}</td><td class="n" data-label="API dollars" data-amount-kind="api">${apiWords(line)}</td><td class="n" data-label="Plan usage" data-amount-kind="subscription">${usageWords(line)}</td><td class="n" data-label="Unknown" data-amount-kind="unknown">${unknownWords(line)}</td></tr>`)
  }</tbody></table></section>`;
}

/** A monthly limit's row; `editor` is Settings → Spend's change form, nothing on the Spend page. */
function limitRow(budget: BudgetState, nameOfSubagent: (key: string) => string, editor: Html | ""): Html {
  const width = Math.min(100, Math.max(0, budget.percent));
  const over = budget.spentMicrousd >= budget.limitMicrousd;
  const label = budgetLabel(budget, budget.scope === "subagent" ? nameOfSubagent(budget.key) : undefined).replace(/'s$/, "");
  return html`<div class="budget${over ? " over" : ""}" data-budget="${budget.id}"><span class="name">${label}</span><span class="figures">${usd(budget.spentMicrousd)} of ${usd(budget.limitMicrousd)} · ${budget.percent}%</span><span class="bar" aria-hidden="true"><span style="width:${width}%"></span></span><span class="meta">${over && budget.hardStop ? "Used up: new API work waits until next month or a higher limit." : budget.hardStop ? "Pauses new API work at 100%." : "Alerts only."}${budget.unpriced > 0 ? ` ${budget.unpriced} without a price.` : ""}</span>${editor}</div>`;
}

export function spendHtml(view: SpendView, notice: { said?: string | null; problem?: string | null }): Html {
  const note = notice.problem ? html`<p class="problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";
  const { totals } = view.report;
  const nameOfSubagent = (key: string) => view.subagentNames.get(Number(key)) ?? `Subagent ${key}`;
  const usageValue = totals.usageCount === 0 ? "None" : totals.usageMicrousd > 0 ? usd(totals.usageMicrousd) : "Not reported";
  const usageMeta = totals.usageCount === 0 ? "No plan usage recorded"
    : totals.usageMicrousd > 0 ? `of usage at API prices${totals.usageUnreported > 0 ? ` · ${each(totals.usageUnreported, "piece")} of work not reported` : ""}` : `${each(totals.usageCount, "piece")} of work`;
  const unknownValue = totals.unknown === 0 ? "None" : String(totals.unknown);
  const unknownMeta = [totals.unknown > 0 ? `${totals.unknown === 1 ? "piece" : "pieces"} of work with billing not proved or cost not recorded` : "Nothing with an unknown cost",
    ...(totals.estimatedMicrousd > 0 ? [`counted as ${usd(totals.estimatedMicrousd)} (estimated)`] : [])].join(" · ");
  const figures = html`<section class="spend-figures" aria-label="This month">\
<div class="spend-figure" data-amount-kind="api" data-microusd="${totals.apiMicrousd}"><h2>API dollars</h2><p class="value">${usd(totals.apiMicrousd)}</p><p class="meta">Recorded charges to API keys</p></div>\
<div class="spend-figure" data-amount-kind="subscription" data-microusd="${totals.usageMicrousd}" data-unreported="${totals.usageUnreported}"><h2>Plan usage</h2><p class="value">${usageValue}</p><p class="meta">${usageMeta}</p></div>\
<div class="spend-figure" data-amount-kind="unknown" data-count="${totals.unknown}" data-estimated-microusd="${totals.estimatedMicrousd}"><h2>Unknown</h2><p class="value">${unknownValue}</p><p class="meta">${unknownMeta}</p></div></section>`;
  const limits = view.budgets === null ? "" : html`<section><h2>Monthly limits</h2>${view.budgets.length === 0 ? html`<p class="meta">No monthly limits. <a href="/settings/spend">Set a limit</a></p>`
    : html`${view.budgets.map(budget => limitRow(budget, nameOfSubagent, ""))}<p class="meta"><a href="/settings/spend">Change limits</a> · Evals never count toward a limit.</p>`}${view.windows}</section>`;
  const runs = view.report.topRuns.length === 0 ? "" : html`<section><h2>Most expensive runs</h2><table><thead><tr><th>Task</th><th>Run</th><th>Model</th><th class="n">API dollars</th></tr></thead><tbody>${
    view.report.topRuns.map(run => html`<tr data-run="${run.runId}"><td><a href="${taskHref(run.taskId)}">${run.taskId}</a>${run.project === null ? "" : html` <span class="meta">${projectName(run.project)}</span>`}</td><td><a href="${runHref(run.runId)}">${ROLE_WORDS[run.role]} ${run.runId}</a></td><td>${run.provider} · ${run.model}</td><td class="n">${usd(run.microusd)}</td></tr>`)
  }</tbody></table></section>`;
  const notCounted = html`<section class="spend-not-counted" data-not-counted><h2>Not counted here</h2><ul>${NOT_COUNTED.map(one => html`<li>${one}</li>`)}</ul></section>`;
  return html`<article class="spend"><div class="spend-head"><h1>Spend</h1><p class="spend-month"><a href="/spend?month=${view.previous}">← ${view.previous}</a><strong>${view.month}</strong>${view.next === null ? "" : html`<a href="/spend?month=${view.next}">${view.next} →</a>`}<span class="meta">UTC month</span><a href="/spend?month=${view.month}&amp;format=csv" download>CSV</a></p></div>${note}${figures}${limits}${
    linesTable("By project", view.report.byProject, projectName)}${
    linesTable("By model", view.report.byModel, key => key)}${
    linesTable("By role", view.report.byRole, key => ROLE_WORDS[key as SpendRole] ?? key)}${
    linesTable("By person", view.report.byPerson, key => key)}${runs}${notCounted}</article>`;
}

export type SpendSettingsView = {
  budgets: BudgetState[];
  targets: { value: string; label: string; group: "Everything" | "Projects" | "People" | "Subagents" }[];
  subagentNames: Map<number, string>;
  /** Each role's model at the installation, in words. */
  models: { role: string; model: string }[];
};

/** Settings → Spend: the monthly limits editor (moved from the Spend page) and a summary of the models in use. */
export function spendSettingsHtml(view: SpendSettingsView, notice: { said?: string | null; problem?: string | null }): Html {
  const note = notice.problem ? html`<p class="problem" role="alert">${notice.problem}</p>` : notice.said ? html`<p role="status">${notice.said}</p>` : "";
  const nameOfSubagent = (key: string) => view.subagentNames.get(Number(key)) ?? `Subagent ${key}`;
  const password = reauth(html`<label>Your Toolroll password<input type="password" name="password" autocomplete="current-password"></label>`);
  const budgets = view.budgets.map(budget => limitRow(budget, nameOfSubagent, html`<details><summary>Change</summary>${
    postForm("/spend/budget", html`<label>Monthly limit (US dollars)<input type="number" name="usd" min="1" step="1" value="${Math.round(budget.limitMicrousd / 1_000_000)}" required></label><label class="choice"><input type="checkbox" name="stop" value="1"${budget.hardStop ? html` checked` : ""}> Pause new API work at 100%</label>${password}<button type="submit" name="action" value="save">Save</button> <button type="submit" name="action" value="remove">Remove</button>`,
      { attrs: { class: "budget-form" }, hidden: { target: `${budget.scope}:${budget.key}` } })}</details>`));
  const groups = ["Everything", "Projects", "People", "Subagents"] as const;
  const options = groups.map(group => {
    const members = view.targets.filter(one => one.group === group);
    return members.length === 0 ? "" : html`<optgroup label="${group}">${members.map(one => html`<option value="${one.value}">${one.label}</option>`)}</optgroup>`;
  });
  const add = html`<details${view.budgets.length === 0 ? html` open` : ""}><summary>Add a limit</summary>${postForm("/spend/budget", html`<label>For<select name="target" required>${options}</select></label><label>Monthly limit (US dollars)<input type="number" name="usd" min="1" step="1" required></label><label class="choice"><input type="checkbox" name="stop" value="1" checked> Pause new API work at 100%</label>${password}<button type="submit" name="action" value="save">Add limit</button>`, { attrs: { class: "budget-form" } })}</details>`;
  const models = html`<section class="spend-models"><h2>Models</h2>${view.models.length === 0 ? "" : html`<dl>${view.models.map(one => html`<dt>${one.role}</dt><dd>${one.model}</dd>`)}</dl>`}<p><a href="/settings/models">Change models</a></p></section>`;
  return html`<article class="spend"><div class="spend-head"><h1>Spend</h1><p class="spend-month"><a href="/spend">See this month's spend</a></p></div>${note}<section><h2>Monthly limits</h2>${budgets.length === 0 ? html`<p class="meta">No monthly limits yet.</p>` : budgets}${add}</section>${models}</article>`;
}

/** One row per piece of spend, for a spreadsheet (the command line's `spend --csv`). */
export function spendCsv(items: readonly SpendItem[], subagentNames: Map<number, string>): string {
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ["time_utc", "kind", "project", "person", "subagent", "task", "run", "provider", "model", "tokens_in", "tokens_out", "cost_usd", "priced_by", "billing"];
  const rows = items.map(item => [item.at, item.kind, item.project, item.person, item.subagent === null ? null : subagentNames.get(item.subagent) ?? item.subagent,
    item.taskId, item.runId, item.provider, item.model, item.tokensIn, item.tokensOut, item.microusd === null ? null : (item.microusd / 1_000_000).toFixed(6), item.source, item.authMode].map(cell).join(","));
  return `﻿${head.join(",")}\r\n${rows.map(row => `${row}\r\n`).join("")}`;
}
