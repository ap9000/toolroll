/**
 * The Spend page's reader (docs/plans/spend-dashboard.md, slice 1): one row per piece of agent work in a month, with
 * three things kept apart that today's budget sum folds together:
 *
 * - `billing`: what the work's own records prove about how it was billed. A machine default, a login mode or a
 *   setting is never proof: an unproved login is `unproved`, never a confirmed subscription.
 * - `amount`: API dollars, subscription usage or unknown, exactly as the eval collector reads it (reported-usage.ts
 *   `runAmountOf` / `chatTurnAmountOf`, the same inputs `runAccounting` / `chatTurnAccounting` read).
 * - `charge`: the saved amount a limit could count, with its basis (reported, settled or estimated). It is what was
 *   saved when the work settled, never re-priced at today's catalogue, and a guessed-subscription zero is never one.
 *
 * Attribution follows spend.ts `spendItems`: runs at their start, a lead turn's requests at the turn's creation,
 * everything else at its own time. Evals are read from their own tables, per invocation, and never count toward a
 * limit. This module reads only; it changes nothing the budget gate counts.
 */
import type { Database } from "./store.js";
import { chatTurnAmountOf, reportedCostUsdOf, runAmountOf, type ReportedAmount } from "./reported-usage.js";
import { filersOf, subagentFilers, type Billing } from "./spend.js";

export type SpendSource = "run" | "chat" | "lead" | "subagent" | "draft" | "sort" | "eval";
export type SpendRole = "builder" | "repair" | "planner" | "reviewer" | "scout" | "lead" | "chat" | "subagent" | "flow" | "evals";
/** What the work's own records prove about its billing. */
export type BillingEvidence = Billing | "unproved";
export type ChargeBasis = "reported" | "settled" | "estimated";
export type SpendCharge = { microusd: number; basis: ChargeBasis };

export type SpendRow = {
  /** The record behind the row, as `table:id` (run:12, chat_turn:5, mate_turn:3, eval_invocation:9, ...). */
  ref: string;
  at: string;
  source: SpendSource;
  role: SpendRole;
  project: string | null;
  person: string | null;
  subagent: number | null;
  taskId: string | null;
  runId: number | null;
  provider: string;
  modelChosen: string | null;
  modelReported: string | null;
  billing: BillingEvidence;
  /** Null only for a lead turn's held reservation beyond its requests' own charges (a saved charge, no request). */
  amount: ReportedAmount | null;
  charge: SpendCharge | null;
};

const RUN_ROLES = new Set<SpendRole>(["builder", "repair", "planner", "reviewer", "scout"]);
const DIRECT_CHAT = new Set(["anthropic-api", "openrouter-api"]);
const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const count = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);
const micro = (value: unknown): number | null => {
  const n = count(value);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const usdMicro = (value: unknown): number | null => {
  const usd = reportedCostUsdOf(typeof value === "number" ? value : value === null || value === undefined ? null : Number(value));
  return usd === null ? null : Math.round(usd * 1_000_000);
};
/** A charge on work that isn't measured API dollars must be a positive saved amount; a zero there proves nothing. */
const chargeOf = (amount: ReportedAmount | null, microusd: number | null, basis: ChargeBasis): SpendCharge | null =>
  microusd === null || (amount?.kind !== "api" && microusd <= 0) ? null : { microusd, basis };

/** Every piece of work in [from, to), one row each. */
export function spendRows(db: Database, from: string, to: string): SpendRow[] {
  const rows: SpendRow[] = [];
  const subagentOf = subagentFilers(db);
  const filerOf = filersOf(db);

  // Runs: the columns runAccounting reads, with their task's project and filer.
  for (const row of db.prepare(`SELECT run.id, run.task_ref, run.role, run.provider, run.model, run.model_reported, run.cost_usd, run.started_at, run.billing_basis, run.cost_unknown,
      r.external_id AS task, r.repo, r.filed_by, r.filed_by_kind, r.revision_of, s.microusd, s.source, s.billing
    FROM run JOIN task_ref r ON r.id = run.task_ref LEFT JOIN run_spend s ON s.run = run.id
    WHERE run.started_at >= ? AND run.started_at < ? ORDER BY run.id`).all(from, to)) {
    const settledBilling = row["billing"] === "subscription" || row["billing"] === "api-key" ? row["billing"] : null;
    const basis = row["billing_basis"] === "evidence" || row["billing_basis"] === "default" ? row["billing_basis"] : null;
    const costUnknown = Number(row["cost_unknown"] ?? 1) !== 0;
    const amount = runAmountOf({ billing: settledBilling, spendMicrousd: count(row["microusd"]), costUsd: count(row["cost_usd"]), basis, costUnknown });
    // Only the run's own evidence proves its billing; a guess (`default`) or no basis at all is unproved.
    const billing: BillingEvidence = basis === "evidence" && settledBilling !== null ? settledBilling : "unproved";
    let charge: SpendCharge | null = null;
    if (billing !== "subscription") {
      const settled = micro(row["microusd"]);
      if (settled !== null && (row["source"] === "reported" || row["source"] === "estimated")) {
        // A run whose cost wasn't reported holds its cap in cost_usd, settled as "reported": that is a conservative estimate.
        charge = chargeOf(amount, settled, billing === "unproved" || costUnknown || row["source"] === "estimated" ? "estimated" : "reported");
      } else {
        charge = chargeOf(amount, usdMicro(row["cost_usd"]), "estimated");
      }
    }
    const filer = row["filed_by"] == null && row["revision_of"] != null ? filerOf(Number(row["task_ref"]))
      : { repo: text(row["repo"]), filedBy: text(row["filed_by"]), kind: text(row["filed_by_kind"]) };
    const role = String(row["role"]) as SpendRole;
    rows.push({
      ref: `run:${Number(row["id"])}`, at: String(row["started_at"]), source: "run", role: RUN_ROLES.has(role) ? role : "builder",
      project: text(row["repo"]), person: filer.kind === "person" || filer.kind === "coordinator" ? filer.filedBy : null,
      subagent: subagentOf(filer.repo, filer.filedBy, filer.kind), taskId: String(row["task"]), runId: Number(row["id"]),
      provider: String(row["provider"]), modelChosen: text(row["model"]), modelReported: text(row["model_reported"]), billing, amount, charge,
    });
  }

  // One chat request (fleet chat, or one request of a lead turn), as chatTurnAccounting reads it.
  const chatRequest = (row: Record<string, unknown>): { amount: ReportedAmount; billing: BillingEvidence; charge: SpendCharge | null } => {
    const provider = String(row["provider"]);
    const reportedCostUsd = count(row["reported_cost_usd"]);
    const billingReported = row["billing_reported"] === "subscription" || row["billing_reported"] === "api-key" ? row["billing_reported"] : null;
    const unknownSpend = Number(row["unknown_spend"]) === 1;
    const amount = chatTurnAmountOf({ provider, settledMicrousd: count(row["settled_microusd"]), unknownSpend, reportedCostUsd, billingReported });
    if (DIRECT_CHAT.has(provider)) {
      // Toolroll sent its own key: billed to it. The settlement is the charge (a held reservation when the cost is unknown).
      return { amount, billing: "api-key", charge: chargeOf(amount, micro(row["settled_microusd"]), unknownSpend ? "estimated" : "settled") };
    }
    // A subscription harness settles at zero whatever it billed; its own events are the evidence.
    const billing: BillingEvidence = billingReported ?? "unproved";
    const reported = usdMicro(reportedCostUsd);
    return { amount, billing, charge: billing === "subscription" ? null : chargeOf(amount, reported, billing === "api-key" ? "reported" : "estimated") };
  };

  for (const row of db.prepare(`SELECT id, created_at, approver, provider, model, model_reported, settled_microusd, unknown_spend, reported_cost_usd, billing_reported
      FROM chat_turn WHERE mate_turn IS NULL AND created_at >= ? AND created_at < ? ORDER BY id`).all(from, to)) {
    const request = chatRequest(row);
    rows.push({ ref: `chat_turn:${Number(row["id"])}`, at: String(row["created_at"]), source: "chat", role: "chat", project: null, person: text(row["approver"]), subagent: null,
      taskId: null, runId: null, provider: String(row["provider"]), modelChosen: text(row["model"]), modelReported: text(row["model_reported"]), ...request });
  }

  // A lead turn: each request at the turn's creation, and whatever the turn settled beyond its requests' charges (a held
  // reservation) once, as an estimate attributed to the turn.
  const turns = new Map<number, { at: string; person: string | null; project: string | null; settled: number | null; provider: string | null; model: string | null; charged: number; unknown: boolean }>();
  for (const row of db.prepare(`SELECT t.id AS turn, t.created_at, t.approver, t.settled_microusd AS turn_settled,
        CASE th.scope_kind WHEN 'project' THEN th.scope_key WHEN 'task' THEN (SELECT r.repo FROM task_ref r WHERE r.external_id = th.scope_key ORDER BY r.id DESC LIMIT 1) END AS project,
        c.id, c.provider, c.model, c.model_reported, c.settled_microusd, c.unknown_spend, c.reported_cost_usd, c.billing_reported
      FROM mate_turn t LEFT JOIN lead_thread th ON th.id = t.thread LEFT JOIN chat_turn c ON c.mate_turn = t.id
      WHERE t.created_at >= ? AND t.created_at < ? ORDER BY t.id, c.id`).all(from, to)) {
    const id = Number(row["turn"]);
    const turn = turns.get(id) ?? { at: String(row["created_at"]), person: text(row["approver"]), project: text(row["project"]), settled: micro(row["turn_settled"]),
      provider: null, model: null, charged: 0, unknown: false };
    turns.set(id, turn);
    if (row["id"] === null || row["id"] === undefined) continue;
    const request = chatRequest(row);
    turn.provider ??= String(row["provider"]);
    turn.model ??= text(row["model"]);
    turn.charged += micro(row["settled_microusd"]) ?? 0;
    if (request.amount.kind === "unknown") turn.unknown = true;
    rows.push({ ref: `chat_turn:${Number(row["id"])}`, at: turn.at, source: "lead", role: "lead", project: turn.project, person: turn.person, subagent: null,
      taskId: null, runId: null, provider: String(row["provider"]), modelChosen: text(row["model"]), modelReported: text(row["model_reported"]), ...request });
  }
  for (const [id, turn] of turns) {
    const held = turn.settled === null ? 0 : turn.settled - turn.charged;
    if (held <= 0) continue;
    // The turn's uncertainty is counted once: by its unknown request when it has one, otherwise by this row.
    const amount: ReportedAmount | null = turn.unknown ? null : { kind: "unknown" };
    rows.push({ ref: `mate_turn:${id}`, at: turn.at, source: "lead", role: "lead", project: turn.project, person: turn.person, subagent: null, taskId: null, runId: null,
      provider: turn.provider ?? "lead", modelChosen: turn.model, modelReported: null, billing: "api-key", amount, charge: { microusd: held, basis: "estimated" } });
  }

  // A subagent's turns and a flow's drafts run on this computer's Claude sign-in with no key from Toolroll: their billing
  // stamp is a machine default, so it is unproved, and a cost they report is an estimate.
  for (const row of db.prepare(`SELECT t.id, t.at, t.subagent, t.model, t.cost_usd, m.repo FROM subagent_turn t JOIN subagent m ON m.id = t.subagent
      WHERE t.at >= ? AND t.at < ? ORDER BY t.id`).all(from, to)) {
    const amount: ReportedAmount = { kind: "unknown" };
    rows.push({ ref: `subagent_turn:${Number(row["id"])}`, at: String(row["at"]), source: "subagent", role: "subagent", project: text(row["repo"]), person: null,
      subagent: Number(row["subagent"]), taskId: null, runId: null, provider: "claude", modelChosen: text(row["model"]), modelReported: null, billing: "unproved",
      amount, charge: chargeOf(amount, usdMicro(row["cost_usd"]), "estimated") });
  }
  for (const row of db.prepare("SELECT id, at, repo, provider, model, cost_usd FROM side_spend WHERE at >= ? AND at < ? ORDER BY id").all(from, to)) {
    const amount: ReportedAmount = { kind: "unknown" };
    rows.push({ ref: `side_spend:${Number(row["id"])}`, at: String(row["at"]), source: "draft", role: "flow", project: text(row["repo"]), person: null, subagent: null,
      taskId: null, runId: null, provider: String(row["provider"]), modelChosen: text(row["model"]), modelReported: null, billing: "unproved",
      amount, charge: chargeOf(amount, usdMicro(row["cost_usd"]), "estimated") });
  }

  // A flow's Sort step asks Jev on OpenRouter with Toolroll's key: its reported cost, or unknown.
  for (const row of db.prepare(`SELECT fs.card, fs.entry, fs.stage, fs.started_at AS at, json_extract(fs.decision_json, '$.cost') AS cost, json_extract(fs.decision_json, '$.model') AS model, f.repo
      FROM flow_step_run fs JOIN flow_card c ON c.id = fs.card JOIN flow f ON f.id = c.flow
      WHERE fs.kind = 'sort' AND fs.decision_json IS NOT NULL AND fs.started_at >= ? AND fs.started_at < ? ORDER BY fs.started_at, fs.card, fs.entry`).all(from, to)) {
    const cost = typeof row["cost"] === "number" ? usdMicro(row["cost"]) : null;
    const amount: ReportedAmount = cost === null ? { kind: "unknown" } : { kind: "api", microusd: cost };
    rows.push({ ref: `flow_step_run:${Number(row["card"])}:${Number(row["entry"])}:${String(row["stage"])}`, at: String(row["at"]), source: "sort", role: "flow", project: text(row["repo"]), person: null, subagent: null,
      taskId: null, runId: null, provider: "openrouter", modelChosen: text(row["model"]), modelReported: null, billing: "api-key", amount, charge: chargeOf(amount, cost, "reported") });
  }

  // Evals, from their own records: one row per provider invocation, kinds kept apart; a campaign whose spending was
  // left unknown adds one unknown. Never counted toward a limit, so never a charge.
  for (const row of db.prepare(`SELECT i.id, i.amount, i.api_microusd, i.subscription_microusd, i.model_reported, a.started_at, a.model_pinned, c.started_by
      FROM eval_invocation i JOIN eval_attempt a ON a.id = i.attempt JOIN eval_campaign c ON c.id = a.campaign
      WHERE a.started_at >= ? AND a.started_at < ? ORDER BY i.id`).all(from, to)) {
    const api = micro(row["api_microusd"]);
    const subscription = micro(row["subscription_microusd"]);
    const amount: ReportedAmount = row["amount"] === "api" && api !== null ? { kind: "api", microusd: api }
      : row["amount"] === "subscription" ? { kind: "subscription", reportedUsd: subscription === null ? null : subscription / 1_000_000 } : { kind: "unknown" };
    rows.push({ ref: `eval_invocation:${Number(row["id"])}`, at: String(row["started_at"]), source: "eval", role: "evals", project: null, person: text(row["started_by"]), subagent: null,
      taskId: null, runId: null, provider: "evals", modelChosen: text(row["model_pinned"]), modelReported: text(row["model_reported"]),
      billing: row["amount"] === "api" ? "api-key" : row["amount"] === "subscription" ? "subscription" : "unproved", amount, charge: null });
  }
  for (const row of db.prepare("SELECT id, admitted_at, started_by FROM eval_campaign WHERE spending_unknown = 1 AND admitted_at >= ? AND admitted_at < ? ORDER BY admitted_at, id").all(from, to)) {
    rows.push({ ref: `eval_campaign:${String(row["id"])}`, at: String(row["admitted_at"]), source: "eval", role: "evals", project: null, person: text(row["started_by"]), subagent: null,
      taskId: null, runId: null, provider: "evals", modelChosen: null, modelReported: null, billing: "unproved", amount: { kind: "unknown" }, charge: null });
  }
  return rows;
}

/** One line of a breakdown: the three amounts kept apart. */
export type SpendLine = {
  key: string;
  count: number;
  apiMicrousd: number;
  /** Subscription usage the providers reported (at API prices), and how many subscription pieces reported none. */
  usageMicrousd: number;
  usageUnreported: number;
  usageCount: number;
  unknown: number;
  /** Saved charges on work that isn't measured API dollars (estimates). */
  estimatedMicrousd: number;
};

export type SpendReport = {
  totals: SpendLine;
  byProject: SpendLine[];
  byModel: SpendLine[];
  byRole: SpendLine[];
  byPerson: SpendLine[];
  /** The runs with the most API dollars, biggest first. */
  topRuns: { runId: number; taskId: string; role: SpendRole; project: string | null; provider: string; model: string; microusd: number }[];
};

const empty = (key: string): SpendLine => ({ key, count: 0, apiMicrousd: 0, usageMicrousd: 0, usageUnreported: 0, usageCount: 0, unknown: 0, estimatedMicrousd: 0 });

function add(line: SpendLine, row: SpendRow): void {
  line.count++;
  const amount = row.amount;
  if (amount?.kind === "api") line.apiMicrousd += amount.microusd;
  else if (row.charge !== null) line.estimatedMicrousd += row.charge.microusd;
  if (amount?.kind === "subscription") {
    line.usageCount++;
    if (amount.reportedUsd === null) line.usageUnreported++;
    else line.usageMicrousd += Math.round(amount.reportedUsd * 1_000_000);
  }
  if (amount?.kind === "unknown") line.unknown++;
}

/** A floating choice (an alias such as `opus`, or the CLI's default) names no version: it has no digit. */
const floating = (model: string): boolean => !/\d/.test(model);

/** The model a row ran on, in words: the reported model; a floating choice beside what it ran as (no verdict); the
 * chosen model "not reported" when the provider said nothing. */
export function modelLabel(row: Pick<SpendRow, "modelChosen" | "modelReported">): string {
  const chosen = row.modelChosen === null || row.modelChosen === "" ? null : row.modelChosen;
  if (row.modelReported === null) return `${chosen ?? "default"} (not reported)`;
  if (chosen === null || chosen === row.modelReported) return row.modelReported;
  return floating(chosen) ? `floating choice ${chosen} → ${row.modelReported}` : `${row.modelReported} (chose ${chosen})`;
}

/** The month's totals, breakdowns and most expensive runs, from `spendRows`. Pure. */
export function spendReport(rows: readonly SpendRow[], top = 10): SpendReport {
  const totals = empty("");
  const by = (keyOf: (row: SpendRow) => string | null): SpendLine[] => {
    const lines = new Map<string, SpendLine>();
    for (const row of rows) {
      const key = keyOf(row);
      if (key === null) continue;
      const line = lines.get(key) ?? empty(key);
      add(line, row);
      lines.set(key, line);
    }
    return [...lines.values()].sort((a, b) => b.apiMicrousd - a.apiMicrousd || b.estimatedMicrousd - a.estimatedMicrousd || b.usageMicrousd - a.usageMicrousd || b.count - a.count || a.key.localeCompare(b.key));
  };
  for (const row of rows) add(totals, row);
  const topRuns = rows.filter(row => row.source === "run" && row.amount?.kind === "api" && row.runId !== null && row.taskId !== null)
    .map(row => ({ runId: row.runId!, taskId: row.taskId!, role: row.role, project: row.project, provider: row.provider, model: modelLabel(row), microusd: (row.amount as { microusd: number }).microusd }))
    .sort((a, b) => b.microusd - a.microusd || b.runId - a.runId).slice(0, top);
  return {
    totals,
    byProject: by(row => row.project),
    byModel: by(row => `${row.provider} · ${modelLabel(row)}`),
    byRole: by(row => row.role),
    byPerson: by(row => row.person),
    topRuns,
  };
}

/** One CSV row per piece of work, the same rows the page adds up. */
export function spendReportCsv(rows: readonly SpendRow[], subagentNames: Map<number, string>): string {
  const cell = (value: unknown) => {
    const value_ = value === null || value === undefined ? "" : String(value);
    const safe = /^[=+\-@\t\r]/.test(value_) ? `'${value_}` : value_;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const dollars = (microusd: number | null) => microusd === null ? null : (microusd / 1_000_000).toFixed(6);
  const head = ["time_utc", "source", "role", "project", "person", "subagent", "task", "run", "provider", "model", "model_reported", "billing", "amount_kind", "api_usd", "usage_usd", "charge_usd", "charge_basis"];
  const lines = rows.map(row => [
    row.at, row.source, row.role, row.project, row.person, row.subagent === null ? null : subagentNames.get(row.subagent) ?? row.subagent, row.taskId, row.runId,
    row.provider, row.modelChosen, row.modelReported, row.billing, row.amount?.kind ?? "held",
    row.amount?.kind === "api" ? dollars(row.amount.microusd) : null,
    row.amount?.kind === "subscription" && row.amount.reportedUsd !== null ? row.amount.reportedUsd.toFixed(6) : null,
    dollars(row.charge?.microusd ?? null), row.charge?.basis ?? null,
  ].map(cell).join(","));
  return `﻿${head.join(",")}\r\n${lines.map(line => `${line}\r\n`).join("")}`;
}
