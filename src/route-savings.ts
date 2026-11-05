/**
 * What earned rules and trials observed (docs/plans/results-routing.md, slice 4): the Spend page's "Suggestions and
 * rules" block and the matching lines of `toolroll spend [--json]`. Read-only: it reads saved result records and rules,
 * and never suggests, accepts, routes or switches anything.
 *
 * For each project and size, each live or recently ended rule or trial (and each standing suggestion) compares two
 * sides over matched 90-day windows:
 * - a rule or trial: the configured model's results in the 90 days before it was accepted, against the results built
 *   under that rule or trial (their sealed selection names it) in the 90 days from acceptance, to its end or now;
 * - a suggestion: the configured model's results and the cheaper model's, over the same last 90 days.
 *
 * Cost rules (item 10): API dollars, plan usage and unknown cost are kept apart and never added together. The median is
 * of API dollars a task over results priced wholly in API dollars, with "API-priced N of M" beside it; it is hidden
 * (null, shown "—") unless each side has at least 5 such results. A result's spending includes its revision and repair
 * runs (remediation). Prices are the snapshot sealed at acceptance (a suggestion's are the listed prices now). Unknown
 * is never $0. The label is "observed, not a promise".
 */
import { modelName, rulesOf, suggestionsFor, trialsOf, type Prices, type RuleRow } from "./route-rules.js";
import { selectionSchema } from "./contracts/route-results.js";
import type { Store } from "./store.js";

const DAY = 24 * 60 * 60_000;
/** The window on each side, the priced results each side needs before a median shows, and when an open result's
 * last evaluation reads as stale. */
export const SAVINGS_TERMS = Object.freeze({ windowDays: 90, minPriced: 5, staleAfterHours: 24 });
export const SAVINGS_LABEL = "observed, not a promise";

/** One result record as this view reads it. */
export type SavingsRecord = {
  state: string; firstStartedAt: string; apiMicrousd: number; subscriptionRuns: number; subscriptionTokens: number;
  unknownRuns: number; remediationRuns: number; closed: boolean; evaluatedAt: string;
};

/** One side of a comparison. Every amount kind is counted on its own. */
export type SavingsSide = {
  provider: string; model: string | null; name: string;
  /** The window, [from, to). */
  from: string; to: string;
  /** Results with an answer (accepted and waiting, counted, counted against); pending and not counted ones apart. */
  results: number; mature: number; rejected: number; provisional: number; pending: number; notCounted: number;
  /** Results whose every run was priced in API dollars, and their median API dollars a task (null: hidden). */
  apiPriced: number; medianApiMicrousd: number | null;
  /** Results with work on a plan (usage, not billed), with their runs and tokens. */
  planResults: number; planRuns: number; planTokens: number;
  /** Results with a run whose cost is unknown, and how many runs. Never $0. */
  unknownResults: number; unknownRuns: number;
  /** Revision and repair runs, whose spending is included in their results'. */
  remediationRuns: number;
};

export type SavingsKind = "rule" | "trial" | "suggestion";
export type SavingsRow = {
  kind: SavingsKind; id: string; repo: string; project: string; size: "small" | "medium";
  state: string; status: string;
  /** The configured model's side (before, for a rule or trial) and the cheaper model's (after). */
  configured: SavingsSide; cheaper: SavingsSide;
  /** Both sides have at least SAVINGS_TERMS.minPriced API-priced results, so the medians show. */
  enough: boolean;
  prices: Prices | null; pricesFrom: "accepted" | "listed-now";
  words: string[];
};
export type SavingsReport = {
  label: typeof SAVINGS_LABEL; windowDays: number; minPriced: number;
  rows: SavingsRow[];
  /** The oldest last evaluation of an open result shown, when it is older than SAVINGS_TERMS.staleAfterHours. */
  staleSince: string | null;
};

// ---- the figures (pure) --------------------------------------------------------------------------------------------

const ANSWERED = new Set(["provisional", "mature", "rejected"]);

/** Whether a result was priced wholly in API dollars: no plan run, no unknown run, and a recorded charge. */
export const apiPriced = (one: Pick<SavingsRecord, "apiMicrousd" | "subscriptionRuns" | "unknownRuns">): boolean =>
  one.unknownRuns === 0 && one.subscriptionRuns === 0 && one.apiMicrousd > 0;

/** The median of whole micro-dollars, rounded; null for none. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** One side's figures from its records. The median is computed here, and hidden by `compare` when either side is short. */
export function sideOf(who: { provider: string; model: string | null; name: string }, window: { from: string; to: string }, records: readonly SavingsRecord[]): SavingsSide {
  const answered = records.filter(one => ANSWERED.has(one.state));
  const priced = answered.filter(apiPriced);
  const plan = answered.filter(one => one.subscriptionRuns > 0);
  const unknown = answered.filter(one => one.unknownRuns > 0);
  const count = (state: string) => records.filter(one => one.state === state).length;
  return {
    ...who, ...window,
    results: answered.length, mature: count("mature"), rejected: count("rejected"), provisional: count("provisional"), pending: count("pending"), notCounted: count("not-counted"),
    apiPriced: priced.length, medianApiMicrousd: medianOf(priced.map(one => one.apiMicrousd)),
    planResults: plan.length, planRuns: plan.reduce((sum, one) => sum + one.subscriptionRuns, 0), planTokens: plan.reduce((sum, one) => sum + one.subscriptionTokens, 0),
    unknownResults: unknown.length, unknownRuns: unknown.reduce((sum, one) => sum + one.unknownRuns, 0),
    remediationRuns: answered.reduce((sum, one) => sum + one.remediationRuns, 0),
  };
}

/** Two sides compared: both medians show only when each side has enough API-priced results; otherwise neither does. */
export function compare(configured: SavingsSide, cheaper: SavingsSide): { configured: SavingsSide; cheaper: SavingsSide; enough: boolean } {
  const enough = configured.apiPriced >= SAVINGS_TERMS.minPriced && cheaper.apiPriced >= SAVINGS_TERMS.minPriced;
  return enough ? { configured, cheaper, enough } : { configured: { ...configured, medianApiMicrousd: null }, cheaper: { ...cheaper, medianApiMicrousd: null }, enough };
}

// ---- words -----------------------------------------------------------------------------------------------------------

/** Dollars a task: under a cent reads "<$0.01", never a false $0. */
export const dollars = (microusd: number): string => microusd > 0 && microusd < 10_000 ? "<$0.01" : `$${(microusd / 1_000_000).toFixed(2)}`;
const each = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sizeWord = (size: "small" | "medium") => size === "small" ? "small" : "routine";
const day = (iso: string) => iso.slice(0, 10);
const perMillion = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** A side's figures in words: the median (or —), then API-priced, plan usage and unknown cost, each apart. */
export function sideWords(side: SavingsSide): { median: string; parts: string[] } {
  return {
    median: side.medianApiMicrousd === null ? "—" : dollars(side.medianApiMicrousd),
    parts: [
      `API-priced ${side.apiPriced} of ${side.results}`,
      side.planResults === 0 ? "plan usage —" : `plan usage ${each(side.planResults, "result")} (${each(side.planRuns, "run")})`,
      side.unknownResults === 0 ? "unknown cost —" : `unknown cost ${each(side.unknownResults, "result")} (${each(side.unknownRuns, "run")})`,
      `${each(side.remediationRuns, "revision or repair run")} included`,
    ],
  };
}

/** The listed prices in words, per million tokens. */
export function pricesWords(row: Pick<SavingsRow, "prices" | "pricesFrom" | "configured" | "cheaper">): string {
  if (row.prices === null) return "Listed prices: not recorded.";
  const p = row.prices;
  return `${row.pricesFrom === "accepted" ? "Listed prices when accepted" : "Listed prices now"}, per million tokens in / out: ${row.cheaper.name} ${perMillion(p.model.in)} / ${perMillion(p.model.out)}, ${row.configured.name} ${perMillion(p.configured.in)} / ${perMillion(p.configured.out)}.`;
}

/** What not having enough priced results means, in words. */
export function notEnoughWords(row: Pick<SavingsRow, "configured" | "cheaper">): string {
  return `Not enough priced results yet: ${row.cheaper.apiPriced} and ${row.configured.apiPriced}; ${SAVINGS_TERMS.minPriced} on each side are needed before a median shows.`;
}

const STATUS_WORDS: Record<string, string> = {
  active: "In use", trialling: "Trial running", paused: "Paused", "switched-off": "Switched itself off", "turned-off": "Turned off",
  expired: "Ended", dropped: "Dropped", finished: "Trial finished", suggested: "Suggested",
};
export const statusWords = (state: string): string => STATUS_WORDS[state] ?? state;

/** The row's own lines, as the command line prints them. */
export function rowLines(row: SavingsRow): string[] {
  const sideLine = (label: string, side: SavingsSide) => {
    const words = sideWords(side);
    return `    ${label.padEnd(10)} ${side.name}, ${day(side.from)} to ${day(side.to)}: median ${words.median} a task · ${words.parts.join(" · ")}`;
  };
  const before = row.kind === "suggestion" ? "configured" : "before";
  const after = row.kind === "suggestion" ? "suggested" : "after";
  return [
    `  ${row.project} · ${sizeWord(row.size)} tasks · ${row.cheaper.name} instead of ${row.configured.name} · ${row.status}`,
    sideLine(before, row.configured), sideLine(after, row.cheaper),
    ...(row.enough ? [] : [`    ${notEnoughWords(row)}`]),
    `    ${pricesWords(row)}`,
  ];
}

/** The spend report's lines for this block: a heading and each row, or one line when there is nothing yet. */
export function savingsLines(report: SavingsReport | { error: string }): string[] {
  if ("error" in report) return ["  Suggestions and rules can't be read right now."];
  if (report.rows.length === 0) return [`  ${"suggestions and rules".padEnd(24)} none yet`];
  return [
    `Suggestions and rules (${report.label}; ${report.windowDays} days a side; a median shows from ${report.minPriced} API-priced results a side)`,
    ...(report.staleSince === null ? [] : [`  Some results were last checked on ${day(report.staleSince)}; they update while Toolroll runs.`]),
    ...report.rows.flatMap(rowLines),
  ];
}

// ---- reading -----------------------------------------------------------------------------------------------------

type Row = SavingsRecord & { provider: string; model: string | null; selections: { kind: string; rule?: number }[] };

function recordsOf(store: Store, repo: string, size: "small" | "medium", from: string, to: string): Row[] {
  return store.handle.prepare(`SELECT state, first_started_at, api_microusd, subscription_runs, subscription_tokens, unknown_runs, remediation_runs, closed, evaluated_at,
      provider, model, provenance_json FROM route_record WHERE repo = ? AND cohort_size = ? AND first_started_at >= ? AND first_started_at < ?`).all(repo, size, from, to)
    .map(row => {
      let selections: Row["selections"] = [];
      try { selections = (JSON.parse(String(row["provenance_json"] ?? "[]")) as unknown[]).flatMap(one => { const read = selectionSchema.safeParse(one); return read.success ? [read.data] : []; }); } catch { selections = []; }
      return {
        state: String(row["state"]), firstStartedAt: String(row["first_started_at"]), apiMicrousd: Number(row["api_microusd"] ?? 0),
        subscriptionRuns: Number(row["subscription_runs"] ?? 0), subscriptionTokens: Number(row["subscription_tokens"] ?? 0), unknownRuns: Number(row["unknown_runs"] ?? 0),
        remediationRuns: Number(row["remediation_runs"] ?? 0), closed: Number(row["closed"]) === 1, evaluatedAt: String(row["evaluated_at"]),
        provider: String(row["provider"] ?? ""), model: row["model"] == null ? null : String(row["model"]), selections,
      };
    });
}

const underRuleOrTrial = (one: Row) => one.selections.some(s => s.kind === "rule" || s.kind === "trial");
const projectName = (repo: string) => repo.split("/").filter(Boolean).pop() ?? repo;
const iso = (ms: number) => new Date(ms).toISOString();

/** A rule's or trial's two sides: the configured model before acceptance, and its own results after. */
function ruleRow(store: Store, rule: RuleRow, now: Date, seen: Row[]): SavingsRow {
  const accepted = Date.parse(rule.acceptedAt);
  const window = SAVINGS_TERMS.windowDays * DAY;
  const beforeWindow = { from: iso(accepted - window), to: iso(accepted) };
  const end = Math.min(rule.endedAt === null ? now.getTime() : Date.parse(rule.endedAt), accepted + window, now.getTime());
  const afterWindow = { from: iso(accepted), to: iso(Math.max(accepted, end)) };
  const before = recordsOf(store, rule.repo, rule.cohortSize, beforeWindow.from, beforeWindow.to)
    .filter(one => one.provider === rule.configured.provider && one.model === rule.configured.model && !underRuleOrTrial(one));
  // The results built under this rule or trial: their sealed selection names it.
  const after = recordsOf(store, rule.repo, rule.cohortSize, afterWindow.from, afterWindow.to)
    .filter(one => one.selections.some(s => (s.kind === "rule" || s.kind === "trial") && s.rule === rule.id));
  seen.push(...before, ...after);
  const configuredName = rule.configured.model === null ? "the configured model" : modelName(store, rule.configured.model);
  const compared = compare(
    sideOf({ provider: rule.configured.provider, model: rule.configured.model, name: configuredName }, beforeWindow, before),
    sideOf({ provider: rule.provider, model: rule.model, name: modelName(store, rule.model) }, afterWindow, after));
  const row: SavingsRow = { kind: rule.kind, id: String(rule.id), repo: rule.repo, project: projectName(rule.repo), size: rule.cohortSize, state: rule.state, status: statusWords(rule.state),
    ...compared, prices: rule.prices, pricesFrom: "accepted", words: [] };
  return { ...row, words: rowLines(row) };
}

/** A project's rows: its rules and trials (live, and those that ended in the last 30 days), then what it suggests now. */
function projectRows(store: Store, repo: string, now: Date, seen: Row[]): SavingsRow[] {
  const rows = [...rulesOf(store, repo, now), ...trialsOf(store, repo, now)].map(rule => ruleRow(store, rule, now, seen));
  const window = { from: iso(now.getTime() - SAVINGS_TERMS.windowDays * DAY), to: now.toISOString() };
  for (const suggestion of suggestionsFor(store, repo, now)) {
    const all = recordsOf(store, repo, suggestion.cohortSize, window.from, window.to).filter(one => one.provider === "claude");
    const mine = all.filter(one => one.model === suggestion.model), standing = all.filter(one => one.model === suggestion.configured.model);
    seen.push(...mine, ...standing);
    const compared = compare(sideOf({ ...suggestion.configured }, window, standing), sideOf({ provider: suggestion.provider, model: suggestion.model, name: suggestion.name }, window, mine));
    const row: SavingsRow = { kind: "suggestion", id: suggestion.id, repo, project: projectName(repo), size: suggestion.cohortSize, state: "suggested", status: statusWords("suggested"),
      ...compared, prices: suggestion.prices, pricesFrom: "listed-now", words: [] };
    rows.push({ ...row, words: rowLines(row) });
  }
  const order = (one: SavingsRow) => (one.kind === "suggestion" ? 2 : ["active", "trialling", "paused"].includes(one.state) ? 0 : 1);
  return rows.sort((a, b) => (a.size === b.size ? 0 : a.size === "small" ? -1 : 1) || order(a) - order(b) || Number(b.id) - Number(a.id));
}

/** The block for these projects, by project then size. */
export function savingsReport(store: Store, repos: readonly string[], now: Date): SavingsReport {
  const seen: Row[] = [];
  const rows = [...new Set(repos)].sort((a, b) => projectName(a).localeCompare(projectName(b)) || a.localeCompare(b)).flatMap(repo => projectRows(store, repo, now, seen));
  const staleBefore = now.getTime() - SAVINGS_TERMS.staleAfterHours * 60 * 60_000;
  const stale = seen.filter(one => !one.closed && Date.parse(one.evaluatedAt) < staleBefore).map(one => one.evaluatedAt).sort();
  return { label: SAVINGS_LABEL, windowDays: SAVINGS_TERMS.windowDays, minPriced: SAVINGS_TERMS.minPriced, rows, staleSince: stale[0] ?? null };
}

/** The block, or that it can't be read: an unreadable block never fails the Spend page or `toolroll spend`. */
export function savingsReportOrError(store: Store, repos: readonly string[], now: Date): SavingsReport | { error: string } {
  try { return savingsReport(store, repos, now); } catch { return { error: "unreadable" }; }
}
