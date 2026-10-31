/**
 * The Spend page's reader (docs/plans/spend-dashboard.md, slice 1). Contract: a run's and a chat request's amount is
 * exactly what runAccounting / chatTurnAccounting read, row for row. Billing is proved only by the work's own records
 * (an unproved login or a machine default is never a confirmed subscription), saved charges keep their basis, a lead
 * turn's held reservation counts once, and API dollars, plan usage and unknown are never added together.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatTurnAccounting, openStore, runAccounting, type Store } from "./store.js";
import { setAuthMode } from "./keys.js";
import { monthOf, spendItems } from "./spend.js";
import { spendReport, spendReportCsv, spendRows, type SpendRow } from "./spend-report.js";
import { money, spendHtml } from "./spend-ui.js";
import type { Database } from "./store.js";
import { html, htmlString } from "./html.js";

let dir: string, store: Store, home: string | undefined;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const AT = NOW.toISOString();
const REPO = "/repo/shop";
const MONTH = monthOf(NOW);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-spend-report-"));
  home = process.env["HOME"];
  process.env["HOME"] = dir;
  // The login mode says "subscription": it must never make a run read as confirmed plan usage on its own.
  setAuthMode("claude", "subscription");
  store = openStore(join(dir, "orders.db"));
});
afterEach(() => { store.close(); process.env["HOME"] = home; rmSync(dir, { recursive: true, force: true }); });

let serial = 0;
type RunFixture = {
  role?: string; provider?: string; model?: string | null; modelReported?: string | null; costUsd?: number | null; costUnknown?: 0 | 1;
  basis?: "evidence" | "default" | null; spend?: { microusd: number | null; source: string; billing: string } | null; at?: string;
};
function run(fixture: RunFixture): number {
  const id = `t-${++serial}`;
  const at = new Date(fixture.at ?? AT);
  store.createTask({ id, title: id, filedBy: { name: "alex", kind: "person" } }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO);
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${serial}`, runner: "b1", branch: `standing-orders/${id}`, worktree: `/w/${id}`,
    route: { routeDigest: "legacy", phase: "build", provider: fixture.provider ?? "claude", model: fixture.model ?? null, chosen: "legacy" }, now: at });
  store.finishRun(runId, { outcome: "built", now: at });
  store.handle.prepare("UPDATE run SET role = ?, provider = ?, model = ?, model_reported = ?, cost_usd = ?, cost_unknown = ?, billing_basis = ? WHERE id = ?")
    .run(fixture.role ?? "builder", fixture.provider ?? "claude", fixture.model ?? null, fixture.modelReported ?? null, fixture.costUsd ?? null, fixture.costUnknown ?? 0, fixture.basis ?? null, runId);
  store.handle.prepare("DELETE FROM run_spend WHERE run = ?").run(runId);
  if (fixture.spend != null) {
    store.handle.prepare("INSERT INTO run_spend (run, microusd, source, billing, billing_fixed, priced_at) VALUES (?, ?, ?, ?, 1, ?)").run(runId, fixture.spend.microusd, fixture.spend.source, fixture.spend.billing, AT);
  }
  return runId;
}

type ChatFixture = { provider: string; settled: number | null; unknown?: 0 | 1; reportedCostUsd?: number | null; billingReported?: string | null; modelReported?: string | null; mateTurn?: number; createdAt?: string };
function chat(fixture: ChatFixture): number {
  return Number(store.handle.prepare(`INSERT INTO chat_turn (approver, credential_key, provider, model, state, created_at, deadline_at, reserved_microusd, settled_microusd, unknown_spend,
      reported_cost_usd, billing_reported, model_reported, kind, mate_turn) VALUES ('alex', 'k', ?, 'm', 'answered', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`)
    .run(fixture.provider, fixture.createdAt ?? AT, AT, fixture.settled, fixture.unknown ?? 0, fixture.reportedCostUsd ?? null, fixture.billingReported ?? null, fixture.modelReported ?? null,
      fixture.mateTurn === undefined ? "chat" : "mate-step", fixture.mateTurn ?? null).lastInsertRowid);
}

function leadTurn(settled: number, createdAt = AT, scope: { kind: "project" | "task"; key: string } = { kind: "project", key: REPO }): number {
  const session = Number(store.handle.prepare(`INSERT INTO lead_session (approver, approver_generation, credential_key, ceiling_microusd, ceiling_digest, terms_digest, minted_at) VALUES ('sam', 1, 'k', 9000000, 'c', 't', ?)`)
    .run(AT).lastInsertRowid);
  const thread = Number(store.handle.prepare(`INSERT INTO lead_thread (approver, ceiling_digest, opened_at, scope_kind, scope_key) VALUES ('sam', 'c', ?, ?, ?)`).run(AT, scope.kind, scope.key).lastInsertRowid);
  return Number(store.handle.prepare(`INSERT INTO mate_turn (approver, session, thread, credential_key, state, created_at, deadline_at, reserved_microusd, settled_microusd) VALUES ('sam', ?, ?, 'k', 'answered', ?, ?, ?, ?)`)
    .run(session, thread, createdAt, AT, settled, settled).lastInsertRowid);
}

function evalAttempt(invocations: { amount: "api" | "subscription" | "unknown"; api?: number | null; subscription?: number | null }[], spendingUnknown: 0 | 1): void {
  store.handle.prepare(`INSERT INTO eval_campaign (id, canonical, manifest_digest, build_digest, version, k, sealed_json, started_by, started_proof, runner_host, runner_pid, admitted_at, state, spending_unknown)
    VALUES ('c1', 0, 'm', 'b', '1', 1, '{}', 'alex', 'p', 'h', 1, ?, 'complete', ?)`).run(AT, spendingUnknown);
  const attempt = Number(store.handle.prepare(`INSERT INTO eval_attempt (campaign, case_id, case_version, n, model_pinned, started_at) VALUES ('c1', 'case', '1', 1, 'claude-opus-5-5', ?)`).run(AT).lastInsertRowid);
  invocations.forEach((one, at) => store.handle.prepare(`INSERT INTO eval_invocation (attempt, kind, world_ref, recorded, amount, api_microusd, subscription_microusd, model_reported) VALUES (?, 'agent', ?, 1, ?, ?, ?, 'claude-opus-5-5')`)
    .run(attempt, `w${at}`, one.amount, one.api ?? null, one.subscription ?? null));
}

const rowFor = (rows: SpendRow[], ref: string) => {
  const found = rows.find(row => row.ref === ref);
  if (found === undefined) throw new Error(`no row ${ref}`);
  return found;
};

test("runs and chat requests read exactly as runAccounting and chatTurnAccounting; billing is proved only by the work's own records; charges keep their basis", () => {
  const runs = {
    apiReported: run({ basis: "evidence", spend: { microusd: 1_250_000, source: "reported", billing: "api-key" }, costUsd: 1.25, modelReported: "claude-opus-5-5", model: "opus" }),
    // Cost never reported: cost_usd holds the cap, settled as "reported". It is a conservative estimate, not a measurement.
    apiCostUnknown: run({ basis: "evidence", spend: { microusd: 5_000_000, source: "reported", billing: "api-key" }, costUsd: 5, costUnknown: 1 }),
    apiCatalogue: run({ basis: "evidence", provider: "codex", spend: { microusd: 700_000, source: "estimated", billing: "api-key" }, model: "gpt-6" }),
    // A guessed billing (this computer's default) settled as a plan at $0: the zero is no evidence of zero spend.
    guessedWithCost: run({ basis: "default", spend: { microusd: 0, source: "subscription", billing: "subscription" }, costUsd: 0.8 }),
    guessedNoCost: run({ basis: "default", spend: { microusd: 0, source: "subscription", billing: "subscription" }, provider: "codex" }),
    // No basis at all (older rows): unproved too, whatever the login mode says.
    noBasis: run({ basis: null, spend: { microusd: 0, source: "subscription", billing: "subscription" }, costUsd: 0.4 }),
    planWithUsage: run({ basis: "evidence", spend: { microusd: 0, source: "subscription", billing: "subscription" }, costUsd: 0.8, role: "planner" }),
    planNoUsage: run({ basis: "evidence", spend: { microusd: 0, source: "subscription", billing: "subscription" }, provider: "codex", role: "scout" }),
    unsettled: run({ basis: "evidence", spend: null }),
    twoModels: run({ basis: "evidence", spend: { microusd: 300_000, source: "reported", billing: "api-key" }, modelReported: "claude-haiku-5-5 + claude-opus-5-5", role: "repair" }),
  };
  const chats = {
    direct: chat({ provider: "openrouter-api", settled: 250_000 }),
    directUnknown: chat({ provider: "anthropic-api", settled: 400_000, unknown: 1 }),
    harnessKey: chat({ provider: "claude-subscription", settled: 0, reportedCostUsd: 0.3, billingReported: "api-key" }),
    harnessUnproved: chat({ provider: "claude-subscription", settled: 0, reportedCostUsd: 0.2, billingReported: null }),
    harnessPlan: chat({ provider: "codex-subscription", settled: 0, reportedCostUsd: 0.1, billingReported: "subscription", modelReported: "gpt-6" }),
  };
  // A lead turn with two direct requests: the first settled, the second's cost unknown; the turn holds its reservation.
  const turn = leadTurn(900_000, "2026-10-20T11:00:00.000Z");
  const steps = { settled: chat({ provider: "anthropic-api", settled: 100_000, mateTurn: turn }), unknown: chat({ provider: "anthropic-api", settled: null, unknown: 1, mateTurn: turn }) };
  // A turn that crashed before any request was recorded, holding its reservation.
  const bare = leadTurn(500_000);
  // A subscription lead turn: the harness settles at zero, nothing held.
  const planTurn = leadTurn(0);
  const planStep = chat({ provider: "claude-subscription", settled: 0, reportedCostUsd: 0.05, billingReported: "subscription", mateTurn: planTurn });
  store.createSubagent({ repo: REPO, handle: "maya", soul: "---\nname: Maya\n---\nHelpful.\n", model: null, manager: "alex", by: "alex" }, NOW);
  const mate = store.subagents([REPO])[0]!.id;
  store.addSubagentTurn({ subagent: mate, card: null, model: "sonnet", ok: true, ms: 10, costUsd: 0.5 }, NOW);
  store.addSubagentTurn({ subagent: mate, card: null, model: "sonnet", ok: true, ms: 10, costUsd: null }, NOW);
  store.recordDraftSpend({ repo: REPO, model: null, costUsd: 0.25 }, NOW);
  evalAttempt([{ amount: "api", api: 1_000_000 }, { amount: "subscription", subscription: null }, { amount: "unknown" }], 1);

  const rows = spendRows(store.handle, MONTH.from, MONTH.to);

  // The contract, row for row.
  for (const row of rows.filter(one => one.source === "run")) {
    const accounting = runAccounting(store, row.runId!)!;
    expect({ amount: row.amount, provider: row.provider, model: row.modelChosen, modelReported: row.modelReported })
      .toEqual({ amount: accounting.amount, provider: accounting.provider, model: accounting.model, modelReported: accounting.modelReported });
  }
  const chatRows = rows.filter(one => one.ref.startsWith("chat_turn:"));
  expect(chatRows).toHaveLength(Object.keys(chats).length + 3);
  for (const row of chatRows) {
    const accounting = chatTurnAccounting(store, Number(row.ref.split(":")[1]))!;
    expect({ amount: row.amount, provider: row.provider, modelReported: row.modelReported }).toEqual({ amount: accounting.amount, provider: accounting.provider, modelReported: accounting.modelReported });
  }

  const pick = (ref: string) => { const row = rowFor(rows, ref); return { billing: row.billing, amount: row.amount, charge: row.charge }; };
  expect.soft(pick(`run:${runs.apiReported}`)).toEqual({ billing: "api-key", amount: { kind: "api", microusd: 1_250_000 }, charge: { microusd: 1_250_000, basis: "reported" } });
  expect.soft(pick(`run:${runs.apiCostUnknown}`)).toEqual({ billing: "api-key", amount: { kind: "unknown" }, charge: { microusd: 5_000_000, basis: "estimated" } });
  expect.soft(pick(`run:${runs.apiCatalogue}`)).toEqual({ billing: "api-key", amount: { kind: "api", microusd: 700_000 }, charge: { microusd: 700_000, basis: "estimated" } });
  expect.soft(pick(`run:${runs.guessedWithCost}`)).toEqual({ billing: "unproved", amount: { kind: "unknown" }, charge: { microusd: 800_000, basis: "estimated" } });
  expect.soft(pick(`run:${runs.guessedNoCost}`)).toEqual({ billing: "unproved", amount: { kind: "unknown" }, charge: null });
  expect.soft(pick(`run:${runs.noBasis}`)).toEqual({ billing: "unproved", amount: { kind: "unknown" }, charge: { microusd: 400_000, basis: "estimated" } });
  expect.soft(pick(`run:${runs.planWithUsage}`)).toEqual({ billing: "subscription", amount: { kind: "subscription", reportedUsd: 0.8 }, charge: null });
  expect.soft(pick(`run:${runs.planNoUsage}`)).toEqual({ billing: "subscription", amount: { kind: "subscription", reportedUsd: null }, charge: null });
  expect.soft(pick(`run:${runs.unsettled}`)).toEqual({ billing: "unproved", amount: { kind: "unknown" }, charge: null });
  expect.soft(rowFor(rows, `run:${runs.twoModels}`)).toMatchObject({ role: "repair", modelReported: "claude-haiku-5-5 + claude-opus-5-5" });
  expect.soft(pick(`chat_turn:${chats.direct}`)).toEqual({ billing: "api-key", amount: { kind: "api", microusd: 250_000 }, charge: { microusd: 250_000, basis: "settled" } });
  expect.soft(pick(`chat_turn:${chats.directUnknown}`)).toEqual({ billing: "api-key", amount: { kind: "unknown" }, charge: { microusd: 400_000, basis: "estimated" } });
  expect.soft(pick(`chat_turn:${chats.harnessKey}`)).toEqual({ billing: "api-key", amount: { kind: "api", microusd: 300_000 }, charge: { microusd: 300_000, basis: "reported" } });
  expect.soft(pick(`chat_turn:${chats.harnessUnproved}`)).toEqual({ billing: "unproved", amount: { kind: "unknown" }, charge: { microusd: 200_000, basis: "estimated" } });
  expect.soft(pick(`chat_turn:${chats.harnessPlan}`)).toEqual({ billing: "subscription", amount: { kind: "subscription", reportedUsd: 0.1 }, charge: null });

  // A lead turn's requests count at the turn's creation, each once; what the turn holds beyond them counts once more,
  // as an estimate on the turn, and its uncertainty is counted once (by the unknown request).
  const lead = rows.filter(row => row.source === "lead");
  expect(lead.every(row => row.role === "lead" && row.project === REPO && row.person === "sam")).toBe(true);
  expect.soft(rowFor(rows, `chat_turn:${steps.settled}`)).toMatchObject({ at: "2026-10-20T11:00:00.000Z", charge: { microusd: 100_000, basis: "settled" } });
  expect.soft(pick(`chat_turn:${steps.unknown}`)).toEqual({ billing: "api-key", amount: { kind: "unknown" }, charge: null });
  expect.soft(pick(`mate_turn:${turn}`)).toEqual({ billing: "api-key", amount: null, charge: { microusd: 800_000, basis: "estimated" } });
  expect.soft(pick(`mate_turn:${bare}`)).toEqual({ billing: "api-key", amount: { kind: "unknown" }, charge: { microusd: 500_000, basis: "estimated" } });
  expect.soft(rows.some(row => row.ref === `mate_turn:${planTurn}`)).toBe(false);
  expect.soft(pick(`chat_turn:${planStep}`)).toEqual({ billing: "subscription", amount: { kind: "subscription", reportedUsd: 0.05 }, charge: null });

  // Subagent turns and drafts carry the machine-default stamp: not proved, never plan usage.
  const machine = rows.filter(row => row.source === "subagent" || row.source === "draft").map(row => [row.source, row.billing, row.amount, row.charge]);
  expect.soft(machine).toEqual([
    ["subagent", "unproved", { kind: "unknown" }, { microusd: 500_000, basis: "estimated" }],
    ["subagent", "unproved", { kind: "unknown" }, null],
    ["draft", "unproved", { kind: "unknown" }, { microusd: 250_000, basis: "estimated" }],
  ]);

  // Evals: each invocation's kind kept apart, the campaign's unknown spending once more, never a charge.
  const evals = rows.filter(row => row.source === "eval").map(row => [row.billing, row.amount, row.charge]);
  expect.soft(evals).toEqual([
    ["api-key", { kind: "api", microusd: 1_000_000 }, null],
    ["subscription", { kind: "subscription", reportedUsd: null }, null],
    ["unproved", { kind: "unknown" }, null],
    ["unproved", { kind: "unknown" }, null],
  ]);

  // The three totals are never added together.
  const report = spendReport(rows);
  const apiSum = rows.reduce((sum, row) => sum + (row.amount?.kind === "api" ? row.amount.microusd : 0), 0);
  expect(report.totals.apiMicrousd).toBe(apiSum);
  expect(report.totals.apiMicrousd).toBe(1_250_000 + 700_000 + 300_000 + 250_000 + 300_000 + 100_000 + 1_000_000);
  expect(report.totals.usageMicrousd).toBe(800_000 + 100_000 + 50_000);
  expect(report.totals.usageUnreported).toBe(2);
  expect(report.totals.unknown).toBe(rows.filter(row => row.amount?.kind === "unknown").length);
  expect(report.totals.estimatedMicrousd).toBe(5_000_000 + 800_000 + 400_000 + 400_000 + 200_000 + 800_000 + 500_000 + 500_000 + 250_000);
  // The roles include the lead's chat and evals; the top runs are API dollars only, biggest first.
  expect(report.byRole.map(line => line.key)).toEqual(expect.arrayContaining(["builder", "planner", "scout", "repair", "lead", "chat", "subagent", "flow", "evals"]));
  expect(report.topRuns.map(one => one.runId)).toEqual([runs.apiReported, runs.apiCatalogue, runs.twoModels]);
  expect(report.byModel.find(line => line.key === "claude · claude-opus-5-5")?.chosen).toEqual(["opus"]);
  expect(report.topRuns[0]!.model).toBe("floating choice opus → claude-opus-5-5");

  // The CSV is the same rows: its API column adds up to the page's figure.
  const csv = spendReportCsv(rows, new Map()).replace(/^﻿/, "").trim().split("\r\n");
  const head = csv[0]!.split(",");
  expect(csv).toHaveLength(rows.length + 1);
  const apiColumn = head.indexOf("api_usd");
  expect(Math.round(csv.slice(1).reduce((sum, line) => sum + Number(line.split(",")[apiColumn] || 0), 0) * 1_000_000)).toBe(report.totals.apiMicrousd);
});

test("attribution is spendItems': runs by start, a lead turn at its parent's time, and the month's edges", () => {
  run({ basis: "evidence", spend: { microusd: 1_000_000, source: "reported", billing: "api-key" }, at: "2026-09-30T23:59:59.000Z" });
  const inside = run({ basis: "evidence", spend: { microusd: 2_000_000, source: "reported", billing: "api-key" }, at: MONTH.from });
  const turn = leadTurn(100_000, "2026-10-31T23:59:00.000Z");
  // The request was written after midnight; it still counts at its turn's time, in October.
  chat({ provider: "anthropic-api", settled: 100_000, mateTurn: turn, createdAt: "2026-11-01T00:00:01.000Z" });
  chat({ provider: "openrouter-api", settled: 10, createdAt: "2026-11-01T00:00:00.000Z" });
  const rows = spendRows(store.handle, MONTH.from, MONTH.to);
  const items = spendItems(store.handle, MONTH.from, MONTH.to);
  expect(rows.filter(row => row.source === "run").map(row => [row.runId, row.at])).toEqual(items.filter(item => item.kind === "run").map(item => [item.runId, item.at]));
  expect(rows.filter(row => row.source === "run").map(row => row.runId)).toEqual([inside]);
  expect(rows.filter(row => row.source === "lead").map(row => row.at)).toEqual(["2026-10-31T23:59:00.000Z"]);
  expect(items.filter(item => item.kind === "chat").map(item => item.at)).toEqual(["2026-10-31T23:59:00.000Z"]);
  expect(rows.some(row => row.source === "chat")).toBe(false);
});

test("the page never shows unknown cost or unreported plan usage as $0", () => {
  run({ basis: "default", spend: { microusd: 0, source: "subscription", billing: "subscription" } });
  run({ basis: "evidence", spend: { microusd: 0, source: "subscription", billing: "subscription" }, provider: "codex" });
  chat({ provider: "claude-subscription", settled: 0, billingReported: null });
  const report = spendReport(spendRows(store.handle, MONTH.from, MONTH.to));
  const page = htmlString(spendHtml({ month: MONTH.name, previous: "2026-09", next: null, report, budgets: [], windows: html``, subagentNames: new Map() }, {}));
  const kinds = [...page.matchAll(/data-amount-kind="(subscription|unknown)"[^>]*>(.*?)<\/(div|td)>/g)];
  expect(kinds.length).toBeGreaterThanOrEqual(2);
  for (const [, , inner] of kinds) expect(inner).not.toMatch(/\$0(\.0+)?(?!\d|\.\d*[1-9])/);
  expect(page).toContain('data-amount-kind="unknown" data-count="2"');
  expect(page).toContain("data-not-counted");
});

test.each([[1, "<$0.01"], [9_999, "<$0.01"], [10_000, "$0.01"], [1_250_000, "$1.25"], [0, "$0"]])("a positive amount under a cent never reads $0: %i micro-dollars → %s", (microusd, words) => {
  expect(money(microusd)).toBe(words);
});

test("sub-cent plan usage and estimates show as under a cent on the page, in the figures and the breakdowns", () => {
  run({ basis: "evidence", spend: { microusd: 0, source: "subscription", billing: "subscription" }, costUsd: 0.001 });
  run({ basis: "default", spend: { microusd: 0, source: "subscription", billing: "subscription" }, costUsd: 0.001 });
  const report = spendReport(spendRows(store.handle, MONTH.from, MONTH.to));
  expect(report.totals).toMatchObject({ usageMicrousd: 1_000, estimatedMicrousd: 1_000 });
  const page = htmlString(spendHtml({ month: MONTH.name, previous: "2026-09", next: null, report, budgets: [], windows: html``, subagentNames: new Map() }, {}));
  expect(page).not.toMatch(/\$0\.00/);
  expect(page).toContain("counted as &lt;$0.01 (estimated)");
  expect(page.match(/&lt;\$0\.01/g)!.length).toBeGreaterThanOrEqual(4);
});

test("models group by what the work ran on; how it was chosen is detail on the line", () => {
  run({ basis: "evidence", spend: { microusd: 1_000_000, source: "reported", billing: "api-key" }, model: "opus", modelReported: "claude-opus-5-5" });
  run({ basis: "evidence", spend: { microusd: 2_000_000, source: "reported", billing: "api-key" }, model: "claude-opus-5-5", modelReported: "claude-opus-5-5" });
  run({ basis: "evidence", spend: { microusd: 500_000, source: "reported", billing: "api-key" }, model: "sonnet" });
  const lines = spendReport(spendRows(store.handle, MONTH.from, MONTH.to)).byModel.map(line => [line.key, line.apiMicrousd, line.count, line.chosen]);
  expect(lines).toEqual([["claude · claude-opus-5-5", 3_000_000, 2, ["opus"]], ["claude · sonnet (not reported)", 500_000, 1, []]]);
});

test("the month's reads stay bounded: no scan of every task, chat request or eval invocation, and a task thread finds its project once", () => {
  store.createTask({ id: "other-backend", title: "x", filedBy: { name: "alex", kind: "person" } }, NOW);
  store.handle.prepare("INSERT INTO task_ref (backend, external_id, repo) VALUES ('github', 'gh-7', '/repo/desk')").run();
  const turn = leadTurn(0, AT, { kind: "task", key: "gh-7" });
  chat({ provider: "anthropic-api", settled: 100, mateTurn: turn });
  evalAttempt([{ amount: "api", api: 5 }], 0);
  const statements: string[] = [];
  const watched = { prepare: (sql: string) => { statements.push(sql); return store.handle.prepare(sql); } } as unknown as Database;
  const rows = spendRows(watched, MONTH.from, MONTH.to);
  expect(rows.find(row => row.source === "lead")).toMatchObject({ project: "/repo/desk" });
  const scans = statements.flatMap(sql => store.handle.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(step => String(step["detail"])))
    .filter(detail => /^SCAN (task_ref|chat_turn|eval_invocation|r|c|i)\b/.test(detail));
  expect(scans).toEqual([]);
});
