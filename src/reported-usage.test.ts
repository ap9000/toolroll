/**
 * What a provider itself reported (docs/plans/evals-nightly.md, B1): kept per run and per chat request, with unknown as
 * null (never 0), and API dollars, subscription usage and unknown never added together.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { parseLeadProviderWrapper, parseProviderWrapper } from "./converse.js";
import { chatTurnAccounting, openStore, recordRunModelReported, runAccounting, type Store } from "./store.js";
import { MODELS_JOIN, chatTurnAmountOf, combineReportedModels, runAmountOf } from "./reported-usage.js";

const T0 = new Date("2026-10-30T12:00:00.000Z");
let store: Store;
beforeEach(() => { store = openStore(":memory:"); });
afterEach(() => store.close());

function run(id: string, provider = "claude"): number {
  store.createTask({ id, title: id }, T0);
  const taskRef = store.refFor("built-in", id).id;
  return store.startRun({ taskRef, leaseId: `l-${id}`, runner: "runner-a", branch: `b/${id}`, worktree: `/w/${id}`, now: T0,
    route: { routeDigest: "legacy", phase: "build", provider, model: null, chosen: "legacy" } });
}

test("a run's reported model: written once, and a resumed turn adds its own — unknown if either is, all named if they differ", () => {
  const cases: [first: string | null, then: string | null, kept: string | null][] = [
    ["claude-sonnet-4-5", "claude-sonnet-4-5", "claude-sonnet-4-5"],
    ["claude-sonnet-4-5", "claude-opus-4-1", `claude-opus-4-1${MODELS_JOIN}claude-sonnet-4-5`],
    ["claude-sonnet-4-5", null, null],
    [null, "claude-sonnet-4-5", null],
  ];
  for (const [index, [first, then, kept]] of cases.entries()) {
    const id = run(`t-${index}`);
    recordRunModelReported(store, id, first, false);
    expect(store.getRun(id)?.modelReported).toBe(first);
    recordRunModelReported(store, id, then, true);
    expect(store.getRun(id)?.modelReported).toBe(kept);
  }
  // A malformed id is unknown, never stored; joined models never equal any one model.
  const odd = run("t-odd");
  recordRunModelReported(store, odd, "claude sonnet\n", false);
  expect(store.getRun(odd)?.modelReported).toBeNull();
  expect(combineReportedModels(`a${MODELS_JOIN}b`, "c")).toBe(`a${MODELS_JOIN}b${MODELS_JOIN}c`);
});

test("a run's accounting keeps API dollars, subscription usage and unknown apart, with cache-aware tokens", () => {
  const cached = JSON.stringify({ input_tokens: 10, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, output_tokens: 5 });
  // Subscription work: its provider's reported cost is usage, never dollars (run_spend prices it at $0 for limits).
  const plan = run("t-plan");
  store.recordUsage(plan, { tokensIn: 10, tokensOut: 5, costUsd: 1.5, usageJson: cached, agentTurns: 4 });
  store.fixRunBilling(plan, "subscription", T0);
  recordRunModelReported(store, plan, "claude-sonnet-4-5-20250929", false);
  expect(runAccounting(store, plan)).toEqual({ provider: "claude", model: null, modelReported: "claude-sonnet-4-5-20250929", agentTurns: 4,
    usage: { in: 350, out: 5, cacheRead: 300, cacheWrite: 40 }, amount: { kind: "subscription", reportedUsd: 1.5 } });
  // Billed by use with a reported cost: API dollars.
  const billed = run("t-billed");
  store.recordUsage(billed, { tokensIn: 10, tokensOut: 5, costUsd: 0.25, usageJson: cached });
  store.fixRunBilling(billed, "api-key", T0);
  expect(runAccounting(store, billed)?.amount).toEqual({ kind: "api", microusd: 250_000 });
  // Billed by use with nothing reported or priced, and a run with no billing at all: unknown, never $0.
  const blank = run("t-blank");
  store.fixRunBilling(blank, "api-key", T0);
  expect(runAccounting(store, blank)).toMatchObject({ modelReported: null, agentTurns: null, usage: { in: null, cacheRead: null, cacheWrite: null }, amount: { kind: "unknown" } });
  expect(runAmountOf({ billing: null, spendMicrousd: 0, costUsd: 0.1 })).toEqual({ kind: "unknown" });
  expect(runAmountOf({ billing: "subscription", spendMicrousd: 0, costUsd: null })).toEqual({ kind: "subscription", reportedUsd: null });
  expect(runAccounting(store, 999)).toBeNull();
});

test("a chat request's amount: a subscription's reported cost is usage, an API's settled charge is dollars, unknown spend is unknown", () => {
  expect(chatTurnAmountOf({ provider: "claude-subscription", settledMicrousd: 0, unknownSpend: false, reportedCostUsd: 0.02 })).toEqual({ kind: "subscription", reportedUsd: 0.02 });
  expect(chatTurnAmountOf({ provider: "codex-subscription", settledMicrousd: 0, unknownSpend: false, reportedCostUsd: null })).toEqual({ kind: "subscription", reportedUsd: null });
  expect(chatTurnAmountOf({ provider: "openrouter-api", settledMicrousd: 1200, unknownSpend: false, reportedCostUsd: 0.0012 })).toEqual({ kind: "api", microusd: 1200 });
  expect(chatTurnAmountOf({ provider: "anthropic-api", settledMicrousd: 5000, unknownSpend: true, reportedCostUsd: null })).toEqual({ kind: "unknown" });
  expect(chatTurnAmountOf({ provider: "anthropic-api", settledMicrousd: null, unknownSpend: false, reportedCostUsd: null })).toEqual({ kind: "unknown" });
});

test("a chat request's row keeps what was reported and refuses what wasn't a report", () => {
  const opened = store.openChatTurn({ approver: "alex", credentialKey: "k", provider: "openrouter-api", model: "anthropic/claude-sonnet-4.5", reservedMicrousd: 10_000,
    dailyTurns: 50, weeklyCeilingMicrousd: 1_000_000, deadlineMs: 60_000 }, T0);
  if (!opened.ok) throw new Error(opened.reason);
  const started = store.startChatTurn(opened.id, T0);
  if (!started.ok) throw new Error("not started");
  // Malformed values are not reports: they are kept as unknown.
  store.finalizeChatTurn(opened.id, started.generation, { state: "answered", tokensIn: 9, tokensOut: 3, settledMicrousd: 1200,
    modelReported: "anthropic/claude sonnet", providerTurns: -2, reportedCostUsd: Number.NaN }, T0);
  expect(chatTurnAccounting(store, opened.id)).toMatchObject({ modelReported: null, providerTurns: null, reportedCostUsd: null, amount: { kind: "api", microusd: 1200 } });
});

test("the direct API answers name their model; only a cost the body reported counts, never a null read as 0", () => {
  const anthropic = parseLeadProviderWrapper("anthropic-api", Buffer.from(JSON.stringify({ type: "message", model: "claude-sonnet-4-5-20250929",
    content: [{ type: "text", text: "hi" }], usage: { input_tokens: 4, output_tokens: 1 } })));
  expect(anthropic).toMatchObject({ ok: true, answer: { modelReported: "claude-sonnet-4-5-20250929", providerTurns: null, reportedCostUsd: null } });
  const routed = (cost: unknown) => parseLeadProviderWrapper("openrouter-api", Buffer.from(JSON.stringify({ model: "anthropic/claude-sonnet-4.5",
    choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 4, completion_tokens: 1, ...(cost === undefined ? {} : { cost }) } })));
  expect(routed(0.0021)).toMatchObject({ ok: true, answer: { modelReported: "anthropic/claude-sonnet-4.5", reportedCostUsd: 0.0021, reportedCostMicrousd: 2100 } });
  expect(routed(undefined)).toMatchObject({ ok: true, answer: { reportedCostUsd: null, reportedCostMicrousd: null } });
  expect(routed(null)).toMatchObject({ ok: true, answer: { reportedCostUsd: null } });
  // Fleet chat's answer too: an unreported cost stays unknown.
  const fleet = (usage: Record<string, unknown>) => parseProviderWrapper("openrouter-api", Buffer.from(JSON.stringify({ model: "openai/gpt-5", choices: [{ message: { content: "{}" } }], usage })));
  expect(fleet({ prompt_tokens: 4, completion_tokens: 1, cost: null })).toMatchObject({ ok: true, answer: { modelReported: "openai/gpt-5", reportedCostUsd: null } });
  expect(fleet({ prompt_tokens: 4, completion_tokens: 1, cost: 0.5 })).toMatchObject({ ok: true, answer: { reportedCostUsd: 0.5 } });
});
