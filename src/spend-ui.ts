/**
 * The Spend page (docs/plans/spend-dashboard.md, slice 1), in the kit's Settings frame (group "spend"): the monthly
 * limits first (the one that needs you on top), then what agent work cost in a month, with API dollars, plan usage
 * and unknown cost kept apart and never added together, broken down by project and model (and, on demand, role,
 * person and the costliest runs), the plan windows, and what isn't recorded here. An instance operator's page.
 * A limit changes in place: Edit limit opens its form under the row (`?edit=<target>`), saved with a step-up.
 */
import { html, postForm, type Html } from "./html.js";
import { approvalAsk, termsOf, type ApprovalFacts } from "./design/kit.js";
import { acts, btn, chip, disclose, dock, empty, field, input, note, notice, segLinks, settingsShell } from "./server/kit.js";
import { budgetLabel, usd, type BudgetState, type SpendItem } from "./spend.js";
import type { SpendLine, SpendReport, SpendRole } from "./spend-report.js";
import type { BrowserLimits } from "./browser-workspace.js";
import { runHref, taskHref } from "./server/http.js";
import { notEnoughWords, pricesWords, sideWords, SAVINGS_LABEL, type SavingsReport, type SavingsRow, type SavingsSide } from "./route-savings.js";

const projectName = (repo: string) => repo.split("/").filter(Boolean).pop() ?? repo;

/** The page's own layout: the limit rows and meters, the summary figures and the quiet bars. Colour from tokens only. */
export const SPEND_CSS = `.spend{display:grid;gap:24px;min-width:0}.spend-sec{display:grid;gap:0}.spend-sec .k-secthead{margin-bottom:0}.spend-sec .k-secthead small{font-weight:400;color:var(--so-muted);font-size:12.5px}` +
  `.spend-lim{display:grid;gap:8px;padding:12px 0;border-bottom:1px solid var(--so-line)}.spend-lim-h{display:grid;grid-template-columns:minmax(0,1fr) auto 124px;gap:12px;align-items:center}` +
  `.spend-lim-l{display:grid;gap:2px;min-width:0}.spend-lim-t{font-weight:500;display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;overflow-wrap:anywhere}.spend-lim-x{font-size:12.5px;color:var(--so-muted)}` +
  `.spend-fig{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}.spend-lim-a{display:flex;justify-content:flex-end}.spend-lim-a .k-btn{min-width:108px}` +
  `.spend-meter{display:block;height:6px;border-radius:3px;background:var(--so-soft);overflow:hidden}.spend-meter>i{display:block;height:100%;border-radius:3px;background:var(--so-neutral-ink)}.spend-meter.over>i{background:var(--so-danger)}` +
  `.spend-edit{display:grid;gap:12px;padding:4px 0 4px}.spend-edit-row{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:flex-end}.spend-edit-row .k-field{flex:0 1 220px}.spend-edit-row .k-checks{min-height:32px}` +
  `.spend-edit>.k-field{max-width:300px}.spend-month{display:flex;align-items:center;gap:12px;flex-wrap:wrap}` +
  `.spend-sum{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--so-line);border-bottom:1px solid var(--so-line)}.spend-sum>div{display:grid;gap:4px;align-content:start;padding:16px 16px 16px 0;min-width:0}` +
  `.spend-sum>div+div{border-left:1px solid var(--so-line);padding-left:16px}.spend-sum-k{font-size:12px;color:var(--so-muted)}.spend-sum-v{font-size:20px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}.spend-sum-x{font-size:12px;color:var(--so-muted);line-height:1.45}` +
  `.spend-bars{display:grid}.spend-bar{display:grid;grid-template-columns:minmax(0,200px) minmax(0,1fr) 84px;gap:12px;align-items:center;min-height:40px;padding:6px 0;border-bottom:1px solid var(--so-line)}` +
  `.spend-bar.h{min-height:28px;font-size:11.5px;color:var(--so-muted)}.spend-bar.tot{font-weight:600;border-bottom:0}.spend-bar-n{min-width:0;overflow-wrap:anywhere}.spend-bar-n small{display:block;font-size:11.5px;color:var(--so-muted)}` +
  `.spend-lane{position:relative;height:14px}.spend-lane>i{position:absolute;left:0;top:4px;height:6px;border-radius:3px;background:var(--so-neutral-ink);min-width:3px}.spend-bar-v{text-align:right;font-variant-numeric:tabular-nums}` +
  `.spend-runs{display:grid}.spend-run{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:8px 0;border-bottom:1px solid var(--so-line)}.spend-run small{grid-column:1/-1;color:var(--so-muted);font-size:12px;overflow-wrap:anywhere}` +
  `.spend-wins{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;padding-top:12px}.spend-win{display:grid;gap:6px;min-width:0}.spend-win-h{display:flex;justify-content:space-between;gap:8px}.spend-win-h b{font-weight:500}` +
  `.spend-win.warning .spend-meter>i,.spend-win.danger .spend-meter>i{background:var(--so-danger)}.spend .k-disclose{padding-top:4px}.spend .k-disclose[open]>summary{margin-bottom:8px}` +
  `@media(max-width:760px){.spend-lim-h{grid-template-columns:minmax(0,1fr) auto}.spend-lim-a{grid-column:1/-1}.spend-lim-a .k-btn{width:100%}.spend-sum{grid-template-columns:minmax(0,1fr)}` +
  `.spend-sum>div+div{border-left:0;border-top:1px solid var(--so-line);padding-left:0}.spend-bar{grid-template-columns:minmax(0,120px) minmax(0,1fr) 68px;gap:8px;font-size:12.5px}` +
  `.spend-edit-row .k-field{flex:1 1 100%}.spend .k-btn.k-btn-primary.k-docked{display:none}}` +
  // Suggestions and rules (results-routing slice 4): each rule's two sides, side by side; stacked on a phone.
  `.spend-rr{display:grid;gap:10px;padding:14px 0;border-bottom:1px solid var(--so-line);min-width:0}.spend-rr-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;min-width:0}` +
  `.spend-rr-t{font-weight:500;overflow-wrap:anywhere;min-width:0}.spend-rr-x{font-size:12.5px;color:var(--so-muted);overflow-wrap:anywhere}` +
  `.spend-rr-g{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.spend-rr-s{display:grid;gap:4px;align-content:start;min-width:0;padding:12px;border:1px solid var(--so-line);border-radius:8px}` +
  `.spend-rr-k{font-size:12px;color:var(--so-muted);overflow-wrap:anywhere}.spend-rr-v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}.spend-rr-v small{font-size:12px;font-weight:400;color:var(--so-muted)}` +
  `.spend-rr-p{display:grid;gap:2px;margin:0;padding:0;list-style:none;font-size:12.5px;color:var(--so-muted)}.spend-rr .k-note{margin:0}` +
  `@media(max-width:760px){.spend-rr-g{grid-template-columns:minmax(0,1fr)}}`;

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

/** A limit's row: a saved limit, or a target with none yet (Everything, a project) and what it spent so far. */
export type LimitRowView = { target: string; label: string; budget: BudgetState | null; spentMicrousd: number };
/** The open limit form: whose, the draft the person typed, and a refusal next to the field or under the form. */
export type LimitEdit = { target: string; usd?: string | null; stop?: boolean | null; fieldError?: string | null; problem?: string | null };

export type SpendView = {
  month: string; previous: string; next: string | null;
  report: SpendReport;
  /** This month's saved limits (what the budget gate counts today), whichever month is shown. */
  budgets: BudgetState[] | null;
  /** Everything and each project with no limit yet, with what it spent this month. */
  unlimited?: LimitRowView[];
  /** People and subagents a limit can be added for (Add a limit). */
  targets?: { value: string; label: string; group: "People" | "Subagents" }[];
  /** The plan windows as their providers last reported them (limits-ui.ts limitsView), or nothing. */
  windows: BrowserLimits | null;
  subagentNames: Map<number, string>;
  /** The limit form that is open, if any. */
  edit?: LimitEdit | null;
  /** What this request's approval shows (approvalFactsNow): a step-up asks for the password unless Passwordless is on. */
  facts?: ApprovalFacts;
  /** This month's name (YYYY-MM): the limits are this month's. */
  current?: string;
  /** Suggestions and rules (route-savings.ts): what each rule, trial and suggestion observed, or that it can't be read. */
  savings?: SavingsReport | { error: string } | null;
};

/** Dollars for the page: a positive amount under a cent reads "<$0.01", never a false $0. */
export const money = (microusd: number): string => microusd > 0 && microusd < 10_000 ? "<$0.01" : usd(microusd);

const each = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const monthWords = (name: string, style: "long" | "short" = "long"): string =>
  new Intl.DateTimeFormat("en-US", { month: style, year: "numeric", timeZone: "UTC" }).format(new Date(`${name}-01T00:00:00.000Z`));

/** A limit Settings flags as Needs you: one that pauses work and is at or near its limit. */
export const limitNeedsYou = (budget: BudgetState): boolean => budget.hardStop && budget.percent >= 90;

/** A line's plan usage in words: the reported usage, or that none was reported. Never $0 for unreported usage. */
const usageWords = (line: SpendLine): string =>
  line.usageCount === 0 ? "—" : line.usageMicrousd > 0 ? `${money(line.usageMicrousd)}${line.usageUnreported > 0 ? ` + ${line.usageUnreported} not reported` : ""}` : "not reported";
/** A line's unknown cost in words: how many, and a saved charge as an estimate. Never $0. */
const unknownWords = (line: SpendLine): string => {
  const counted = line.estimatedMicrousd > 0 ? `${money(line.estimatedMicrousd)} estimated` : "";
  return line.unknown > 0 ? `${line.unknown}${counted === "" ? "" : ` · ${counted}`}` : counted === "" ? "—" : counted;
};
const apiWords = (line: SpendLine): string => line.apiMicrousd > 0 ? money(line.apiMicrousd) : "—";

const sec = (id: string, title: string, state: string, body: Html, attrs: Html | "" = ""): Html =>
  html`<section class="k-sec spend-sec" aria-labelledby="spend-${id}"${attrs}><div class="k-secthead"><h3 id="spend-${id}">${title}${state ? html` <small>· ${state}</small>` : ""}</h3></div>${body}</section>`;

/** A breakdown as quiet bars of API dollars; plan usage and unknown cost stay on the line, never added in. */
function bars(head: string, lines: readonly SpendLine[], name: (key: string) => string, max: number, top = 12, detail: (line: SpendLine) => string = () => ""): Html {
  const rows = lines.slice(0, top).map(line => {
    const sub = [detail(line), line.usageCount > 0 ? `plan usage ${usageWords(line)}` : "", line.unknown > 0 || line.estimatedMicrousd > 0 ? `unknown ${unknownWords(line)}` : ""].filter(Boolean).join(" · ");
    const width = max > 0 ? Math.max(0, Math.min(100, (line.apiMicrousd / max) * 100)) : 0;
    return html`<div class="spend-bar" role="row"><span class="spend-bar-n" role="cell">${name(line.key)}${sub === "" ? "" : html`<small data-amount-kind="${line.usageCount > 0 ? "subscription" : "unknown"}">${sub}</small>`}</span>\
<span class="spend-lane" role="cell" aria-hidden="true">${line.apiMicrousd > 0 ? html`<i style="width:${width.toFixed(1)}%"></i>` : ""}</span><span class="spend-bar-v" role="cell" data-amount-kind="api">${apiWords(line)}</span></div>`;
  });
  const total = lines.reduce((sum, line) => sum + line.apiMicrousd, 0);
  return html`<div class="spend-bars" role="table" aria-label="${head}"><div class="spend-bar h" role="row"><span role="columnheader">${head}</span><span role="columnheader"></span><span class="spend-bar-v" role="columnheader">API dollars</span></div>${rows}\
<div class="spend-bar tot" role="row"><span role="cell">Total</span><span role="cell"></span><span class="spend-bar-v" role="cell">${total > 0 ? money(total) : "—"}</span></div></div>`;
}

const editHref = (target: string, month: string, current: string): string =>
  `/spend?${month === current ? "" : `month=${month}&`}edit=${encodeURIComponent(target)}`;

/** The open limit form, under its row: amount and pause, validated next to the field before any password; saving
 * is a step-up (/spend/budget proves the password again, in the write). */
function limitForm(row: LimitRowView | null, edit: LimitEdit, view: SpendView, targets: SpendView["targets"]): Html {
  const id = `limit-${edit.target.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "new"}`;
  const facts = view.facts ?? { passwordless: false, remembered: false };
  const amount = edit.usd ?? (row?.budget ? String(Math.round(row.budget.limitMicrousd / 1_000_000)) : "");
  const stop = edit.stop ?? row?.budget?.hardStop ?? true;
  const choose = row === null && targets !== undefined
    ? field({ id: `${id}-for`, label: "For", control: html`<span class="k-selw wide"><select class="k-sel" id="${id}-for" name="target" required>${(["People", "Subagents"] as const).map(group => {
      const members = targets.filter(one => one.group === group);
      return members.length === 0 ? "" : html`<optgroup label="${group}">${members.map(one => html`<option value="${one.value}"${one.value === edit.target ? html` selected` : ""}>${one.label}</option>`)}</optgroup>`;
    })}</select></span>` })
    : "";
  const password = approvalAsk("step-up", facts) === "password"
    ? field({ id: `${id}-pw`, label: "Your password", control: input({ id: `${id}-pw`, name: "password", type: "password", attrs: { autocomplete: "current-password", required: true } }) })
    : "";
  const back = view.month === view.current ? "/spend" : `/spend?month=${view.month}`;
  const body = html`${choose}<div class="spend-edit-row">${field({ id: `${id}-usd`, label: "Monthly limit (US dollars)", error: edit.fieldError ?? null,
    control: input({ id: `${id}-usd`, name: "usd", value: amount, error: Boolean(edit.fieldError), attrs: { inputmode: "numeric", autocomplete: "off", "data-spend-usd": "", autofocus: true } }) })}\
<div class="k-checks"><label><input type="checkbox" name="stop" value="1"${stop ? html` checked` : ""}>Pause new API work at the limit</label></div></div>\
${note(`Unchecked means alerts only. Plan usage never counts toward a limit. ${termsOf("step-up", facts)}`)}${password}\
${acts(btn("Save limit", { variant: "primary", type: "submit", docked: true, attrs: { name: "action", value: "save" } }),
    row?.budget ? btn("Remove limit", { variant: "ghost", type: "submit", attrs: { name: "action", value: "remove", formnovalidate: true, "data-spend-remove": "" } }) : "",
    btn("Cancel", { variant: "ghost", href: back }))}${edit.problem ? notice(edit.problem) : ""}`;
  return postForm("/spend/budget", body, { attrs: { class: "spend-edit", id, "data-spend-limit": "", novalidate: true }, hidden: row === null ? {} : { target: row.target } });
}

function limitRow(row: LimitRowView, view: SpendView, current: string, open: LimitEdit | null): Html {
  const budget = row.budget;
  const hot = budget !== null && limitNeedsYou(budget);
  const over = budget !== null && budget.spentMicrousd >= budget.limitMicrousd;
  const hint = budget === null ? "No limit." : over && budget.hardStop ? "Used up: new API work waits until next month or a higher limit."
    : `${budget.hardStop ? "Pauses new API work at the limit." : "Alerts only."}${budget.unpriced > 0 ? ` ${each(budget.unpriced, "piece")} of work without a price.` : ""}`;
  const fig = budget === null ? `${money(row.spentMicrousd)} so far` : `${money(budget.spentMicrousd)} of ${usd(budget.limitMicrousd)} · ${budget.percent}%`;
  const action = open !== null ? "" : btn(budget === null ? "Set a limit" : "Edit limit", { sm: true, href: editHref(row.target, view.month, current) });
  const meter = budget === null ? "" : html`<span class="spend-meter${over ? " over" : ""}" role="meter" aria-valuemin="0" aria-valuemax="${budget.limitMicrousd}" aria-valuenow="${budget.spentMicrousd}" aria-label="${row.label}: ${fig}"><i style="width:${Math.min(100, Math.max(0, budget.percent))}%"></i></span>`;
  return html`<div class="spend-lim"${budget === null ? "" : html` data-budget="${budget.id}"`}><div class="spend-lim-h"><span class="spend-lim-l"><span class="spend-lim-t">${row.label}${hot ? chip("Needs you", "needs") : ""}</span><span class="spend-lim-x">${hint}</span></span>\
<span class="spend-fig">${fig}</span><span class="spend-lim-a">${action}</span></div>${meter}${open === null ? "" : limitForm(row, open, view, undefined)}</div>`;
}

export function spendHtml(view: SpendView, said: { said?: string | null; problem?: string | null }): Html {
  const current = view.current ?? view.month;
  const nameOfSubagent = (key: string) => view.subagentNames.get(Number(key)) ?? `Subagent ${key}`;
  const edit = view.edit ?? null;
  const saved: LimitRowView[] = (view.budgets ?? []).map(budget => ({ target: `${budget.scope}:${budget.key}`, budget, spentMicrousd: budget.spentMicrousd,
    label: budget.scope === "installation" ? "Everything" : budget.scope === "project" ? projectName(budget.key) : budgetLabel(budget, budget.scope === "subagent" ? nameOfSubagent(budget.key) : undefined).replace(/'s$/, "") }));
  // The limit Settings flags (Needs you) sits first; then the saved limits, then what has none yet.
  const rows = [...saved.filter(one => one.budget !== null && limitNeedsYou(one.budget)), ...saved.filter(one => one.budget === null || !limitNeedsYou(one.budget)), ...(view.unlimited ?? [])];
  const openFor = (row: LimitRowView) => edit !== null && edit.target === row.target ? edit : null;
  const targets = view.targets ?? [];
  const adding = edit !== null && !rows.some(row => row.target === edit.target) && targets.length > 0 ? edit : null;
  const add = targets.length === 0 ? "" : html`<div class="spend-lim"><div class="spend-lim-h"><span class="spend-lim-l"><span class="spend-lim-t">A person or a subagent</span><span class="spend-lim-x">A limit for one person’s or one subagent’s work.</span></span><span></span>\
<span class="spend-lim-a">${adding === null ? btn("Add a limit", { sm: true, href: editHref("new", view.month, current) }) : ""}</span></div>${adding === null ? "" : limitForm(null, adding, view, targets)}</div>`;
  const status = said.problem ? notice(said.problem) : said.said ? html`<p class="k-note" role="status">${said.said}</p>` : "";
  const limits = view.budgets === null ? "" : sec("limits", "Monthly limits", monthWords(current, "long").split(" ")[0]!, html`${status}${rows.map(row => limitRow(row, view, current, openFor(row)))}${add}`);

  const { totals } = view.report;
  const usageValue = totals.usageCount === 0 ? "None" : totals.usageMicrousd > 0 ? money(totals.usageMicrousd) : "Not reported";
  const usageMeta = totals.usageCount === 0 ? "No plan usage recorded"
    : totals.usageMicrousd > 0 ? `of usage at API prices${totals.usageUnreported > 0 ? ` · ${each(totals.usageUnreported, "piece")} of work not reported` : ""}` : `${each(totals.usageCount, "piece")} of work`;
  const unknownValue = totals.unknown === 0 ? "None" : String(totals.unknown);
  const unknownMeta = [totals.unknown > 0 ? `${totals.unknown === 1 ? "piece" : "pieces"} of work with billing not proved or cost not recorded` : "Nothing with an unknown cost",
    ...(totals.estimatedMicrousd > 0 ? [`counted as ${money(totals.estimatedMicrousd)} (estimated)`] : [])].join(" · ");
  const label = monthWords(view.month, "long");
  const figures = html`<section class="spend-sum" aria-label="${label}">\
<div data-amount-kind="api" data-microusd="${totals.apiMicrousd}"><span class="spend-sum-k">API dollars · ${label}${view.month === current ? " so far" : ""}</span><span class="spend-sum-v">${money(totals.apiMicrousd)}</span><span class="spend-sum-x">Recorded charges to API keys</span></div>\
<div data-amount-kind="subscription" data-microusd="${totals.usageMicrousd}" data-unreported="${totals.usageUnreported}"><span class="spend-sum-k">Plan usage</span><span class="spend-sum-v">${usageValue}</span><span class="spend-sum-x">${usageMeta}</span></div>\
<div data-amount-kind="unknown" data-count="${totals.unknown}" data-estimated-microusd="${totals.estimatedMicrousd}"><span class="spend-sum-k">Unknown</span><span class="spend-sum-v">${unknownValue}</span><span class="spend-sum-x">${unknownMeta}</span></div></section>`;
  const monthItems = [{ key: view.previous, label: monthWords(view.previous, "short"), href: `/spend?month=${view.previous}` }, { key: view.month, label: monthWords(view.month, "short"), href: `/spend?month=${view.month}` },
    ...(view.next === null ? [] : [{ key: view.next, label: monthWords(view.next, "short"), href: `/spend?month=${view.next}` }])];
  const monthBar = html`<div class="spend-month">${segLinks("Month", view.month, monthItems)}${btn("Download CSV", { variant: "ghost", sm: true, href: `/spend?month=${view.month}&format=csv`, attrs: { download: "" } })}</div>`;

  const nothing = view.report.byProject.length === 0 && view.report.byModel.length === 0 && totals.unknown === 0 && totals.usageCount === 0;
  const max = Math.max(0, ...view.report.byProject.map(line => line.apiMicrousd), ...view.report.byModel.map(line => line.apiMicrousd));
  const runs = view.report.topRuns.length === 0 ? "" : html`<div class="spend-runs">${view.report.topRuns.map(run => html`<div class="spend-run" data-run="${run.runId}"><span><a class="k-link" href="${taskHref(run.taskId)}">${run.taskId}</a> · <a class="k-link" href="${runHref(run.runId)}">${ROLE_WORDS[run.role]} ${run.runId}</a></span>\
<span class="k-num">${money(run.microusd)}</span><small>${run.project === null ? "" : `${projectName(run.project)} · `}<span class="k-mono">${run.provider} · ${run.model}</span></small></div>`)}</div>`;
  const more = view.report.byRole.length === 0 && view.report.byPerson.length === 0 && runs === "" ? "" : disclose("By role, by person and the costliest runs", html`${
    view.report.byRole.length === 0 ? "" : bars("Role", view.report.byRole, key => ROLE_WORDS[key as SpendRole] ?? key, max)}${
    view.report.byPerson.length === 0 ? "" : bars("Person", view.report.byPerson, key => key, max)}${runs}`);
  const breakdowns = nothing ? empty({ title: `Nothing spent in ${label}.` }) : html`${
    view.report.byProject.length === 0 ? "" : sec("by-project", "By project", "", bars("Project", view.report.byProject, projectName, max))}${
    view.report.byModel.length === 0 ? "" : sec("by-model", "By model", "", bars("Model", view.report.byModel, key => key, max, 12, line => line.chosen.length === 0 ? "" : `chosen as ${line.chosen.join(", ")}`))}${more}`;

  const windows = view.windows === null || view.windows.tiles.length === 0 ? "" : sec("windows", "Plan windows", "", html`<div class="spend-wins">${view.windows.tiles.map(tile => html`<div class="spend-win ${tile.tone}" data-limit="${tile.key}"${tile.title === null ? "" : html` title="${tile.title}"`}>\
<div class="spend-win-h"><b>${tile.name} ${tile.window}</b><span class="k-num">${tile.value}${tile.unit}</span></div><span class="spend-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(tile.percent)}" aria-label="${tile.name} ${tile.window}: ${tile.value}${tile.unit}"><i style="width:${Math.min(100, Math.max(0, tile.percent))}%"></i></span><span class="k-note">${tile.detail}</span></div>`)}</div>`);
  const notCounted = html`<p class="k-note" data-not-counted>Not counted here: ${NOT_COUNTED.map(one => one.charAt(0).toLowerCase() + one.slice(1)).join("; ")}. Evals never count toward a limit.</p>`;

  const docked = edit !== null && (rows.some(row => row.target === edit.target) || adding !== null)
    ? dock(btn("Save limit", { variant: "primary", type: "submit", attrs: { form: `limit-${edit.target.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "new"}`, name: "action", value: "save" } }))
    : "";
  const body = html`<div class="spend">${limits}${monthBar}${figures}${breakdowns}${windows}${savingsSection(view.savings ?? null)}${notCounted}</div>${docked}`;
  return settingsShell({ group: "spend", title: "Spend", lead: "What agents cost, by project and by model, with the limits that stop them. Dates are UTC months.", body,
    flags: { spend: saved.some(one => one.budget !== null && limitNeedsYou(one.budget)) } });
}

const sizeWords = (size: "small" | "medium") => size === "small" ? "Small tasks" : "Routine tasks";
const dateWords = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
const STATUS_TONE: Record<string, "" | "live" | "needs"> = { active: "live", trialling: "live", paused: "needs" };

/** One side of a rule's comparison: its model and window, the median API dollars a task (— when hidden), and the
 * completeness, plan usage, unknown cost and remediation counts, each on its own line. */
function savingsSide(label: string, side: SavingsSide): Html {
  const words = sideWords(side);
  const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  return html`<div class="spend-rr-s" role="group" aria-label="${label}: ${side.name}" data-side="${label.toLowerCase()}"><span class="spend-rr-k">${label} · ${side.name} · ${dateWords(side.from)} to ${dateWords(side.to)}</span>\
<span class="spend-rr-v" data-amount-kind="api" data-microusd="${side.medianApiMicrousd ?? ""}">${words.median} <small>median API dollars a task</small></span>\
<ul class="spend-rr-p"><li data-priced="${side.apiPriced}" data-results="${side.results}">${words.parts[0]!}</li><li data-amount-kind="subscription">${cap(words.parts[1]!)}</li><li data-amount-kind="unknown">${cap(words.parts[2]!)}</li><li>${cap(words.parts[3]!)}</li></ul></div>`;
}

function savingsRow(row: SavingsRow): Html {
  const suggestion = row.kind === "suggestion";
  const what = `${row.cheaper.name} instead of ${row.configured.name}${row.kind === "trial" ? " (a trial)" : suggestion ? " (suggested, not in use)" : ""}`;
  const href = `/settings/models?scope=${encodeURIComponent(row.repo)}#models-suggested`;
  return html`<article class="spend-rr" data-savings-row data-kind="${row.kind}" data-state="${row.state}" data-enough="${row.enough ? "yes" : "no"}">\
<div class="spend-rr-h"><span class="spend-rr-t">${row.project} · ${sizeWords(row.size)}</span>${chip(row.status, STATUS_TONE[row.state] ?? "")}</div><span class="spend-rr-x">${what}</span>\
<div class="spend-rr-g">${savingsSide(suggestion ? "Configured" : "Before", row.configured)}${savingsSide(suggestion ? "Suggested" : "After", row.cheaper)}</div>\
${row.enough ? "" : html`<p class="k-note" data-not-enough>${notEnoughWords(row)}</p>`}<p class="k-note" data-prices>${pricesWords(row)}</p>\
<span><a class="k-link" href="${href}">${suggestion ? "Review in Models settings" : "Open Models settings"}</a></span></article>`;
}

/** Suggestions and rules (docs/plans/results-routing.md, slice 4): per project and size, each live or recently ended
 * rule or trial, and each standing suggestion, with what it observed over matched 90-day windows. Labelled "observed,
 * not a promise"; a median shows only from 5 API-priced results a side; unknown is "—", never $0. Read-only. */
export function savingsSection(savings: SavingsReport | { error: string } | null): Html | "" {
  if (savings === null) return "";
  const state = `${SAVINGS_LABEL} · 90 days a side`;
  if ("error" in savings) return sec("savings", "Suggestions and rules", state, notice("Suggestions and rules can't be read right now. Nothing else on this page is affected."), html` data-savings="error"`);
  if (savings.rows.length === 0) {
    return sec("savings", "Suggestions and rules", state, empty({ title: "No suggestions or rules yet.",
      text: "When a cheaper model does as well on a project's small or routine tasks, its suggestion shows here, and once it's in use, what it cost before and after." }), html` data-savings="empty"`);
  }
  const stale = savings.staleSince === null ? "" : html`<p class="k-note" data-savings-stale>Some results were last checked on ${dateWords(savings.staleSince)}; they update while Toolroll runs.</p>`;
  const lead = html`<p class="k-note">Median API dollars a task, including revision and repair runs. Plan usage and unknown cost are counted apart, never added in. A median shows once each side has ${savings.minPriced} results priced in API dollars.</p>`;
  return sec("savings", "Suggestions and rules", state, html`${lead}${stale}${savings.rows.map(savingsRow)}`, html` data-savings="rows"`);
}

/** Checks the amount next to its field before any password is asked or the form leaves the page; the server checks
 * it again. Remove skips it. */
export function spendScript(): string {
  return `(function(){document.addEventListener("submit",function(e){var f=e.target;if(!f||!f.matches||!f.matches("form[data-spend-limit]"))return;
var s=e.submitter;if(s&&s.hasAttribute("data-spend-remove"))return;var u=f.querySelector("[data-spend-usd]");if(!u)return;
var v=u.value.replace(/[$,\\s]/g,""),ok=/^\\d+$/.test(v)&&+v>=1&&+v<=10000000,err=document.getElementById(u.id+"-err");
if(ok){u.removeAttribute("aria-invalid");if(err)err.textContent="";u.value=v;return;}
e.preventDefault();u.setAttribute("aria-invalid","true");if(err)err.textContent="Use a whole number of dollars, at least $1, like 40. Nothing changed.";u.focus();},true);})();`;
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
