/**
 * Spend (v105): what agent work cost, priced for every provider, and who and
 * what it counts toward. Work on a subscription (a Claude or Codex login)
 * costs nothing extra and counts as $0 (its limits are what bind it; see
 * provider-limits.ts). Work billed to an API key costs what its provider
 * reported; otherwise its tokens at the model's catalogue price (Settings →
 * Models), or at the provider's highest listed price when the model isn't
 * listed; work with no tokens and no cost is "unpriced" and said so.
 *
 * Spend counts toward a project (a run's task, a subagent's, a project chat),
 * a person (who filed the task, or had the chat), a subagent (its turns, and
 * tasks it filed), and the whole installation. Budgets are per calendar
 * month (UTC).
 */
import type { Database } from "./store.js";
import { SUBSCRIPTION_CAPABLE, readAuthMode } from "./keys.js";
import type { ProviderId } from "./provider.js";

export type PriceSource = "reported" | "estimated" | "unpriced" | "subscription";
export type Billing = "subscription" | "api-key";

/** How a provider's work is billed right now: an API key when Toolroll is set to use one, or when the CLI
 * itself was last seen billing a key (a key helper, a Console login, Bedrock or Vertex, `codex login --with-api-key`);
 * otherwise its plan. `db` supplies what was seen (provider_account); without it, the setting alone. */
export function billingOf(provider: string, db?: Database): Billing {
  const base = provider.replace(/-(subscription|api)$/, "");
  if (provider.endsWith("-api")) return "api-key";
  const setting: Billing = provider.endsWith("-subscription") ? "subscription"
    : Object.hasOwn(SUBSCRIPTION_CAPABLE, provider) ? readAuthMode(provider as ProviderId) : "api-key";
  if (setting === "api-key" || db === undefined) return setting;
  return seenBilling(db, base) ?? setting;
}

/** How a provider's CLI was last seen billing (provider_account), or null. */
export function seenBilling(db: Database, provider: string): Billing | null {
  const row = db.prepare("SELECT billing FROM provider_account WHERE provider = ?").get(provider);
  return row?.["billing"] === "api-key" || row?.["billing"] === "subscription" ? row["billing"] : null;
}

/** How a Claude turn was really billed, from its own stream. Only a plan reports its usage windows (Claude Code 2.1
 * does on every turn), so that is the one sign of the plan; a named key source or a cloud model id (Bedrock, Vertex)
 * is a key, and so is "none" without windows (a gateway's bearer token or a cloud provider says "none" too). Null when
 * the stream said nothing. */
export function claudeBillingFrom(seen: { keySource: string | null; model: string | null; planWindows: boolean }): Billing | null {
  if (seen.keySource !== null && seen.keySource !== "none") return "api-key";
  if (seen.model !== null && /^arn:|(^|\.)anthropic\.|@/.test(seen.model)) return "api-key";
  if (seen.planWindows) return "subscription";
  return seen.keySource === "none" ? "api-key" : null;
}

/** How Claude bills on this computer when Toolroll gives it no key (subagent turns, drafts): as its keyless runs
 * were last seen, and its plan until one has been. */
export function claudeMachineBilling(db: Database): Billing {
  return seenBilling(db, "claude") ?? "subscription";
}

/** Providers whose own output says what a turn cost (Claude's total_cost_usd; OpenRouter's usage.cost). */
const REPORTS_COST = new Set(["claude", "openrouter", "anthropic-api", "openrouter-api"]);
/** Whether API work on this provider can be priced: it reports its cost, or the catalogue has its prices. */
export function canPrice(db: Database, provider: string): boolean {
  return REPORTS_COST.has(provider) || ceilingPriceFor(db, provider) !== null;
}
export type Price = { inputUsd: number; outputUsd: number; model: string };

const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku", "fable"];
const catalogSource = (provider: string): string | null =>
  provider === "claude" || provider === "claude-subscription" || provider === "anthropic-api" ? "claude"
    : provider === "codex" || provider === "codex-subscription" ? "codex"
    : provider === "gemini" ? "gemini"
    : provider === "openrouter" || provider === "openrouter-api" ? "openrouter" : null;

/** A model's catalogue price (US dollars per million tokens), or null when the catalogue doesn't list one. A
 * Claude short name ("sonnet") is priced as the newest of its family, as the Claude CLI runs it. */
export function priceFor(db: Database, provider: string, model: string | null): Price | null {
  const source = catalogSource(provider);
  if (source === null || model === null || model === "" || model === "default") return null;
  const priced = (row: Record<string, unknown> | undefined): Price | null =>
    row === undefined || row["input_usd"] == null || row["output_usd"] == null ? null
      : { inputUsd: Number(row["input_usd"]), outputUsd: Number(row["output_usd"]), model: String(row["id"]) };
  const exact = priced(db.prepare("SELECT id, input_usd, output_usd FROM model_seen WHERE source = ? AND id = ?").get(source, model));
  if (exact !== null || source !== "claude" || !CLAUDE_FAMILIES.includes(model)) return exact;
  return priced(db.prepare(`SELECT id, input_usd, output_usd FROM model_seen WHERE source = 'claude' AND id LIKE ? AND last_seen_at = (SELECT MAX(last_seen_at) FROM model_seen WHERE source = 'claude')
    ORDER BY COALESCE(released_at, '') DESC, id DESC LIMIT 1`).get(`claude-${model}-%`));
}

/** The provider's highest listed price, for API work whose model the catalogue doesn't list (or that ran the CLI's
 * default): a budget that stops work must never see it as free. */
export function ceilingPriceFor(db: Database, provider: string): Price | null {
  const source = catalogSource(provider);
  if (source === null) return null;
  const row = db.prepare(`SELECT MAX(input_usd) AS input_usd, MAX(output_usd) AS output_usd FROM model_seen WHERE source = ? AND input_usd IS NOT NULL AND output_usd IS NOT NULL
    AND last_seen_at = (SELECT MAX(last_seen_at) FROM model_seen WHERE source = ?)`).get(source, source);
  return row === undefined || row["input_usd"] == null || row["output_usd"] == null ? null
    : { inputUsd: Number(row["input_usd"]), outputUsd: Number(row["output_usd"]), model: "highest listed price" };
}

/** What a piece of work cost, in micro-dollars: nothing on a subscription; otherwise reported, or tokens at the
 * catalogue price (usd per million tokens times tokens is micro-dollars), or unpriced. */
export function priceWork(db: Database, work: { provider: string; model: string | null; costUsd: number | null; tokensIn: number | null; tokensOut: number | null; billing: Billing }):
  { microusd: number | null; source: PriceSource; price: Price | null } {
  if (work.billing === "subscription") return { microusd: 0, source: "subscription", price: null };
  if (work.costUsd !== null && Number.isFinite(work.costUsd)) return { microusd: Math.round(work.costUsd * 1_000_000), source: "reported", price: null };
  if (work.tokensIn === null && work.tokensOut === null) return { microusd: null, source: "unpriced", price: null };
  const price = priceFor(db, work.provider, work.model) ?? ceilingPriceFor(db, work.provider);
  if (price === null) return { microusd: null, source: "unpriced", price: null };
  return { microusd: Math.round((work.tokensIn ?? 0) * price.inputUsd + (work.tokensOut ?? 0) * price.outputUsd), source: "estimated", price };
}

export const SPEND_SCHEMA = `
CREATE TABLE IF NOT EXISTS run_spend (
  run         INTEGER PRIMARY KEY,
  microusd    INTEGER,
  source      TEXT NOT NULL CHECK (source IN ('reported', 'estimated', 'unpriced', 'subscription')),
  billing     TEXT NOT NULL CHECK (billing IN ('subscription', 'api-key')),
  -- 1 once the run's own evidence set it (a key it was given, what its CLI said); a later turn can only make it a key.
  billing_fixed INTEGER NOT NULL DEFAULT 0,
  price_model TEXT,
  input_usd   REAL,
  output_usd  REAL,
  priced_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('installation', 'project', 'person', 'subagent')),
  scope_key   TEXT NOT NULL,
  limit_microusd INTEGER NOT NULL CHECK (limit_microusd > 0),
  hard_stop   INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  removed_by  TEXT,
  removed_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_live ON budget (scope_kind, scope_key) WHERE removed_at IS NULL;
CREATE TABLE IF NOT EXISTS provider_limit (
  provider       TEXT NOT NULL,
  window         TEXT NOT NULL,
  used_percent   REAL NOT NULL,
  window_minutes INTEGER,
  resets_at      TEXT,
  reached        INTEGER NOT NULL DEFAULT 0,
  plan           TEXT,
  observed_at    TEXT NOT NULL,
  PRIMARY KEY (provider, window)
);
-- Spend that isn't a run, a subagent turn or a chat: a flow's Claude draft.
CREATE TABLE IF NOT EXISTS side_spend (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL CHECK (kind IN ('draft')),
  repo      TEXT,
  provider  TEXT NOT NULL,
  model     TEXT,
  cost_usd  REAL,
  billing   TEXT NOT NULL CHECK (billing IN ('subscription', 'api-key')),
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS side_spend_at ON side_spend (at);
CREATE TABLE IF NOT EXISTS provider_account (
  provider    TEXT PRIMARY KEY,
  billing     TEXT NOT NULL CHECK (billing IN ('subscription', 'api-key')),
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_turn_created ON chat_turn (created_at);
CREATE INDEX IF NOT EXISTS mate_turn_created ON mate_turn (created_at);
CREATE INDEX IF NOT EXISTS subagent_turn_at ON subagent_turn (at);
`;

export type BudgetScope = "installation" | "project" | "person" | "subagent";
export type Budget = { id: number; scope: BudgetScope; key: string; limitMicrousd: number; hardStop: boolean; updatedBy: string; updatedAt: string };

/** One piece of spend, whatever made it, with what it counts toward. */
export type SpendItem = {
  at: string; kind: "run" | "subagent" | "chat" | "sort" | "draft"; microusd: number | null; source: PriceSource;
  project: string | null; person: string | null; subagent: number | null; provider: string; model: string | null;
  tokensIn: number | null; tokensOut: number | null; taskId: string | null; runId: number | null; authMode: string | null;
};

/** The calendar month (UTC) `at` falls in: [start, end) as ISO strings, and its name (YYYY-MM). */
export function monthOf(at: Date): { from: string; to: string; name: string } {
  const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const to = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString(), name: from.toISOString().slice(0, 7) };
}

/** A month by its name (YYYY-MM), or null. */
export function monthNamed(name: string | null): { from: string; to: string; name: string } | null {
  if (name === null || !/^\d{4}-(0[1-9]|1[0-2])$/.test(name)) return null;
  return monthOf(new Date(`${name}-01T00:00:00.000Z`));
}

/** The subagent behind a filing: tasks a subagent files are filed as its name ("Maya (AI)", from its soul file), in
 * its project. A later subagent with the same name and project wins, as it would read on the card. */
/** A subagent's name as its soul file gives it ("Maya"), or null. */
const soulName = (soul: unknown): string | null => {
  const front = /^---\s*\n([\s\S]*?)\n---/.exec(String(soul ?? ""));
  return front === null ? null : /^name:\s*(.+?)\s*$/m.exec(front[1]!)?.[1] ?? null;
};

/** Every subagent's name by id (its handle when its soul file names none). */
export function subagentNames(db: Database): Map<number, string> {
  return new Map(db.prepare("SELECT id, handle, soul FROM subagent").all().map(row => [Number(row["id"]), soulName(row["soul"]) ?? String(row["handle"])]));
}

export function subagentFilers(db: Database): (repo: string | null, filedBy: string | null, kind: string | null) => number | null {
  const byName = new Map<string, number>();
  for (const row of db.prepare("SELECT id, repo, handle, soul FROM subagent ORDER BY id").all()) {
    const name = soulName(row["soul"]);
    for (const one of [String(row["handle"]), ...(name === null ? [] : [name])]) byName.set(`${String(row["repo"])}\n${one} (AI)`, Number(row["id"]));
  }
  return (repo, filedBy, kind) => kind !== "subagent" || repo === null || filedBy === null ? null : byName.get(`${repo}\n${filedBy}`) ?? null;
}

/** Who a task's work counts toward: its own filer, or, for a revision filed by automation (an automatic repair), the
 * filer of the task it revises, up its ancestry (bounded). */
export function filersOf(db: Database): (taskRef: number) => { repo: string | null; filedBy: string | null; kind: string | null } {
  const memo = new Map<number, { repo: string | null; filedBy: string | null; kind: string | null }>();
  const read = db.prepare("SELECT id, backend, repo, filed_by, filed_by_kind, revision_of FROM task_ref WHERE id = ?");
  const source = db.prepare("SELECT id, backend, repo, filed_by, filed_by_kind, revision_of FROM task_ref WHERE backend = ? AND external_id = ? ORDER BY id DESC LIMIT 1");
  return taskRef => {
    const known = memo.get(taskRef);
    if (known !== undefined) return known;
    let row = read.get(taskRef);
    const repo = row?.["repo"] == null ? null : String(row["repo"]);
    const seen = new Set<number>();
    while (row !== undefined && row["filed_by"] == null && row["revision_of"] != null && !seen.has(Number(row["id"])) && seen.size < 64) {
      seen.add(Number(row["id"]));
      row = source.get(row["backend"], row["revision_of"]);
    }
    const found = { repo, filedBy: row?.["filed_by"] == null ? null : String(row["filed_by"]), kind: row?.["filed_by_kind"] == null ? null : String(row["filed_by_kind"]) };
    memo.set(taskRef, found);
    return found;
  };
}

/** Every piece of spend in [from, to): runs (by when they started), subagent turns and chat turns. `modeOf` says how
 * a provider bills when a record doesn't (older rows): its current login or key. */
export function spendItems(db: Database, from: string, to: string, modeOf: (provider: string) => Billing = provider => billingOf(provider, db)): SpendItem[] {
  const subagentOf = subagentFilers(db);
  const filerOf = filersOf(db);
  const text = (value: unknown) => value == null ? null : String(value);
  const count = (value: unknown) => value == null ? null : Number(value);
  const runs = db.prepare(`SELECT run.id, run.task_ref, run.provider, run.model, run.cost_usd, run.tokens_in, run.tokens_out, run.started_at, run.auth_mode,
      r.external_id AS task, r.repo, r.filed_by, r.filed_by_kind, r.revision_of, s.microusd, s.source, s.billing
    FROM run JOIN task_ref r ON r.id = run.task_ref LEFT JOIN run_spend s ON s.run = run.id
    WHERE run.started_at >= ? AND run.started_at < ? ORDER BY run.id`).all(from, to);
  const items: SpendItem[] = runs.map(row => {
    const provider = String(row["provider"]);
    const billing: Billing = row["billing"] === "subscription" || row["billing"] === "api-key" ? row["billing"]
      : row["auth_mode"] === "subscription" || row["auth_mode"] === "api-key" ? row["auth_mode"] : modeOf(provider);
    const settled = row["source"] != null;
    const priced = settled ? null : priceWork(db, { provider, model: text(row["model"]), costUsd: count(row["cost_usd"]), tokensIn: count(row["tokens_in"]), tokensOut: count(row["tokens_out"]), billing });
    // Most tasks name their filer; only an automation-filed revision walks to its source's.
    const filer = row["filed_by"] == null && row["revision_of"] != null ? filerOf(Number(row["task_ref"]))
      : { repo: text(row["repo"]), filedBy: text(row["filed_by"]), kind: text(row["filed_by_kind"]) };
    const kind = filer.kind;
    return {
      at: String(row["started_at"]), kind: "run", microusd: settled ? count(row["microusd"]) : priced!.microusd,
      source: settled ? String(row["source"]) as PriceSource : priced!.source,
      project: text(row["repo"]),
      person: kind === "person" || kind === "coordinator" ? filer.filedBy : null,
      subagent: subagentOf(filer.repo, filer.filedBy, kind), provider, model: text(row["model"]),
      tokensIn: count(row["tokens_in"]), tokensOut: count(row["tokens_out"]),
      taskId: String(row["task"]), runId: Number(row["id"]), authMode: billing,
    };
  });
  // A subagent's own turns get no key from Toolroll (subagents.ts claudeTurnRunner): they bill as this computer's
  // Claude sign-in was seen billing when the turn ran (a plan, or a Console login, key helper or gateway).
  for (const row of db.prepare(`SELECT t.at, t.subagent, t.model, t.cost_usd, t.tokens_in, t.tokens_out, t.billing, m.repo FROM subagent_turn t JOIN subagent m ON m.id = t.subagent
      WHERE t.at >= ? AND t.at < ? ORDER BY t.id`).all(from, to)) {
    const billing: Billing = row["billing"] === "api-key" ? "api-key" : "subscription";
    const priced = priceWork(db, { provider: "claude", model: text(row["model"]), costUsd: count(row["cost_usd"]), tokensIn: count(row["tokens_in"]), tokensOut: count(row["tokens_out"]), billing });
    items.push({ at: String(row["at"]), kind: "subagent", microusd: priced.microusd, source: priced.source, project: String(row["repo"]), person: null,
      subagent: Number(row["subagent"]), provider: "claude", model: text(row["model"]),
      tokensIn: count(row["tokens_in"]), tokensOut: count(row["tokens_out"]), taskId: null, runId: null, authMode: billing });
  }
  // A chat turn that mirrors a project chat's turn is that turn: counted once, as the project chat's. A task's chat
  // counts toward the task's project.
  for (const row of db.prepare(`SELECT created_at AS at, approver, provider, model, settled_microusd, tokens_in, tokens_out, NULL AS project
      FROM chat_turn WHERE mate_turn IS NULL AND created_at >= ? AND created_at < ?
    UNION ALL SELECT t.created_at, t.approver, COALESCE((SELECT c.provider FROM chat_turn c WHERE c.mate_turn = t.id ORDER BY c.id LIMIT 1), 'lead'),
        (SELECT c.model FROM chat_turn c WHERE c.mate_turn = t.id ORDER BY c.id LIMIT 1), t.settled_microusd, t.tokens_in, t.tokens_out,
        CASE th.scope_kind WHEN 'project' THEN th.scope_key WHEN 'task' THEN (SELECT r.repo FROM task_ref r WHERE r.external_id = th.scope_key ORDER BY r.id DESC LIMIT 1) END
      FROM mate_turn t LEFT JOIN lead_thread th ON th.id = t.thread WHERE t.created_at >= ? AND t.created_at < ?`).all(from, to, from, to)) {
    const provider = String(row["provider"]);
    const subscription = provider.endsWith("-subscription") && modeOf(provider) === "subscription";
    const settled = count(row["settled_microusd"]);
    items.push({ at: String(row["at"]), kind: "chat", microusd: subscription ? 0 : settled, source: subscription ? "subscription" : settled === null ? "unpriced" : "reported",
      project: text(row["project"]), person: text(row["approver"]), subagent: null, provider, model: text(row["model"]),
      tokensIn: count(row["tokens_in"]), tokensOut: count(row["tokens_out"]), taskId: null, runId: null, authMode: subscription ? "subscription" : "api-key" });
  }
  // A flow's Claude drafts: like a subagent's turns, billed as the sign-in was.
  for (const row of db.prepare("SELECT at, kind, repo, provider, model, cost_usd, billing FROM side_spend WHERE at >= ? AND at < ? ORDER BY id").all(from, to)) {
    const billing: Billing = row["billing"] === "api-key" ? "api-key" : "subscription";
    const priced = priceWork(db, { provider: String(row["provider"]), model: text(row["model"]), costUsd: count(row["cost_usd"]), tokensIn: null, tokensOut: null, billing });
    items.push({ at: String(row["at"]), kind: "draft", microusd: priced.microusd, source: priced.source, project: text(row["repo"]), person: null, subagent: null,
      provider: String(row["provider"]), model: text(row["model"]), tokensIn: null, tokensOut: null, taskId: null, runId: null, authMode: billing });
  }
  // A flow's Sort zone asks Jev on OpenRouter (the key's credit): what it cost is kept with its answer.
  for (const row of db.prepare(`SELECT fs.started_at AS at, json_extract(fs.decision_json, '$.cost') AS cost, json_extract(fs.decision_json, '$.model') AS model, f.repo
      FROM flow_step_run fs JOIN flow_card c ON c.id = fs.card JOIN flow f ON f.id = c.flow
      WHERE fs.kind = 'sort' AND fs.decision_json IS NOT NULL AND fs.started_at >= ? AND fs.started_at < ? ORDER BY fs.started_at`).all(from, to)) {
    const cost = typeof row["cost"] === "number" && Number.isFinite(row["cost"]) && row["cost"] >= 0 ? row["cost"] : null;
    items.push({ at: String(row["at"]), kind: "sort", microusd: cost === null ? null : Math.round(cost * 1_000_000), source: cost === null ? "unpriced" : "reported",
      project: text(row["repo"]), person: null, subagent: null, provider: "openrouter", model: text(row["model"]), tokensIn: null, tokensOut: null, taskId: null, runId: null, authMode: "api-key" });
  }
  return items;
}

/** Whether a piece of spend counts toward a budget. */
export function countsToward(item: SpendItem, budget: Pick<Budget, "scope" | "key">): boolean {
  if (budget.scope === "installation") return true;
  if (budget.scope === "project") return item.project === budget.key;
  if (budget.scope === "person") return item.person === budget.key;
  return item.subagent !== null && String(item.subagent) === budget.key;
}

export type BudgetState = Budget & { spentMicrousd: number; unpriced: number; percent: number };

/** A piece of work's agents as a budget sees them: which provider, billed how. */
export type BudgetAgent = { provider: string; billing: Billing };
/** What a budget gate says: nothing holds it, or the budget it's over (used up), or the budget that covers API work it
 * can't price (no reported cost, no catalogue prices yet: never counted as free). */
export type BudgetHold = { over: BudgetState | null; why: "used-up" | "unpriced" | null; unpricedProvider: string | null; remainingMicrousd: number | null };

const PROVIDER_WORDS: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", openrouter: "OpenRouter" };
/** Why work waits on a budget, in words. */
export function budgetHoldWords(hold: BudgetHold, month: string, subagentName?: string): string {
  if (hold.over === null) return "";
  const label = budgetLabel(hold.over, subagentName);
  return hold.why === "unpriced"
    ? `${label} budget can't price ${PROVIDER_WORDS[hold.unpricedProvider ?? ""] ?? hold.unpricedProvider} work on a key yet. Open Settings → Models to load prices`
    : `${label} budget is used up for ${month}`;
}

/** Each budget's month so far: what counted toward it, and how many pieces of work had no price. */
export function budgetStates(budgets: readonly Budget[], items: readonly SpendItem[]): BudgetState[] {
  return budgets.map(budget => {
    const mine = items.filter(item => countsToward(item, budget));
    const spent = mine.reduce((sum, item) => sum + (item.microusd ?? 0), 0);
    return { ...budget, spentMicrousd: spent, unpriced: mine.filter(item => item.microusd === null && item.source === "unpriced" && (item.tokensIn !== null || item.kind !== "run")).length,
      percent: Math.floor((spent / budget.limitMicrousd) * 100) };
  });
}

/** A budget in words: "The shop project's", "alex's", "Maya's (subagent)", "The whole installation's". */
export function budgetLabel(budget: Pick<Budget, "scope" | "key">, subagentName?: string): string {
  if (budget.scope === "installation") return "The whole installation's";
  if (budget.scope === "project") return `The ${budget.key.split("/").filter(Boolean).pop() ?? budget.key} project's`;
  if (budget.scope === "person") return `${budget.key}'s`;
  return `${subagentName ?? `Subagent ${budget.key}`}'s`;
}

export const usd = (microusd: number | null): string => microusd === null ? "unpriced" : `$${(microusd / 1_000_000).toFixed(microusd !== 0 && Math.abs(microusd) < 10_000_000 ? 2 : 0)}`;
