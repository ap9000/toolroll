/**
 * Suggestions and rules on the Spend page and in `toolroll spend` (docs/plans/results-routing.md, slice 4): the medians,
 * the completeness counts, the 5-a-side threshold, the amount kinds kept apart, remediation included, the price
 * snapshot, and the empty, stale and error states. Isolated databases; records are written through their one writer.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, BUILT_IN, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { recordCatalog } from "./model-catalog.js";
import { INSTALLATION_SCOPE } from "./agentconfig.js";
import { saveResultRecord, type RuleDoor } from "./route-store.js";
import type { RecordValue } from "./route-results.js";
import type { Selection } from "./contracts/route-results.js";
import { acceptSuggestion, startTrial, suggestionsFor, trialOffersFor, turnOffRule } from "./route-rules.js";
import {
  compare, medianOf, savingsLines, savingsReport, savingsReportOrError, sideOf, sideWords, SAVINGS_LABEL, type SavingsRecord,
} from "./route-savings.js";
import { savingsSection } from "./spend-ui.js";
import { runOperate } from "./operate.js";
import { htmlString, type Html } from "./html.js";
const renderToString = (value: Html | "") => value === "" ? "" : htmlString(value);

const T0 = new Date("2026-11-01T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const REPO = "/repo/shop";
const HAIKU = "claude-haiku-5-5", SONNET = "claude-sonnet-5-5", OPUS = "claude-opus-5-5";
let dir: string, store: Store, seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-route-savings-"));
  store = openStore(join(dir, "plane.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("alex");
  store.upsertProject(REPO, "shop", T0);
  store.setPhaseConfig(INSTALLATION_SCOPE, "plan", "claude", OPUS, "alex", T0);
  store.setPhaseConfig(INSTALLATION_SCOPE, "build", "claude", SONNET, "alex", T0);
  store.setPhaseTierConfig(INSTALLATION_SCOPE, "build", "light", "claude", SONNET, "alex", T0);
  store.setPhaseConfig(INSTALLATION_SCOPE, "review", "claude", OPUS, "alex", T0);
  prices(1);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function prices(haikuIn: number, when = T0): void {
  recordCatalog(store, [
    { source: "claude", id: HAIKU, name: "Claude Haiku 5.5", inputUsd: haikuIn, outputUsd: 5, context: null, tools: true, releasedAt: null },
    { source: "claude", id: SONNET, name: "Claude Sonnet 5.5", inputUsd: 3, outputUsd: 15, context: null, tools: true, releasedAt: null },
    { source: "claude", id: OPUS, name: "Claude Opus 5.5", inputUsd: 5, outputUsd: 25, context: null, tools: true, releasedAt: null },
  ], when);
}
const refOf = (id: string) => store.refFor(BUILT_IN, id).id;
const person = (): RuleDoor => ({ kind: "person", person: { actor: "alex", generation: store.accountOf("alex")!.generation, method: "password-now", live: () => true } });

type Seed = { model?: string; state?: RecordValue["state"]; size?: "small" | "medium"; api?: number; plan?: number; unknown?: number; remediation?: number; selections?: Selection[]; closed?: boolean; evaluated?: Date };
function seed(when: Date, over: Seed = {}): void {
  const id = `rec-${++seq}`;
  const state = over.state ?? "mature";
  store.createTask({ id, title: id }, T0);
  store.placeTask(refOf(id), REPO);
  const settled = state === "mature" || state === "rejected" || state === "not-counted";
  saveResultRecord(store, {
    taskRef: refOf(id), task: id, repo: REPO, cohortSize: over.size ?? "small", provider: "claude", model: over.model ?? SONNET, state,
    reason: state === "rejected" ? "check-failed" : state === "not-counted" ? "no-check" : null, resultRun: null, firstStartedAt: when.toISOString(),
    acceptedAt: null, decidedAt: null, modelFailures: 0, infraFailures: 0, apiMicrousd: over.api ?? 400_000, subscriptionRuns: over.plan ?? 0,
    subscriptionTokens: (over.plan ?? 0) * 1000, unknownRuns: over.unknown ?? 0, remediationRuns: over.remediation ?? 0, selections: over.selections ?? [], settled,
    personRevisions: 0, firstCheckPassed: null, agentTurns: 0, turnsUnknownRuns: 0, accumulationEnded: over.closed ?? true,
  }, over.evaluated ?? when);
}
/** A rule for Haiku on small tasks, accepted at T0 from ten accepted Haiku results a month earlier. */
function acceptHaiku(): number {
  for (let one = 0; one < 10; one++) seed(new Date(at(-30).getTime() + one * 3_600_000), { model: HAIKU, api: 100_000 });
  const [offer] = suggestionsFor(store, REPO, T0);
  if (offer === undefined) throw new Error("no suggestion");
  const accepted = acceptSuggestion(store, { repo: REPO, id: offer.id }, person(), T0);
  if (!accepted.ok) throw new Error(accepted.problem);
  return accepted.rule;
}
const underRule = (rule: number): Selection[] => [{ kind: "rule", rule, ruleGeneration: 1 }];
const record = (over: Partial<SavingsRecord>): SavingsRecord => ({ state: "mature", firstStartedAt: T0.toISOString(), apiMicrousd: 100, subscriptionRuns: 0, subscriptionTokens: 0,
  unknownRuns: 0, remediationRuns: 0, closed: true, evaluatedAt: T0.toISOString(), ...over });
const who = { provider: "claude", model: HAIKU, name: "Claude Haiku 5.5" };
const window = { from: at(-90).toISOString(), to: T0.toISOString() };

describe("the figures", () => {
  test("the median of whole micro-dollars: odd, even (rounded), none", () => {
    expect(medianOf([5, 1, 3])).toBe(3);
    expect(medianOf([1, 2, 4, 8])).toBe(3);
    expect(medianOf([1, 2])).toBe(2);
    expect(medianOf([])).toBeNull();
  });

  test("kinds are never added: plan and unknown results stay out of the median and are counted apart", () => {
    const side = sideOf(who, window, [
      record({ apiMicrousd: 100 }), record({ apiMicrousd: 300 }),
      record({ apiMicrousd: 200, subscriptionRuns: 2, subscriptionTokens: 5000 }),
      record({ apiMicrousd: 50_000_000, unknownRuns: 1 }),
      record({ apiMicrousd: 0, subscriptionRuns: 1, subscriptionTokens: 10 }),
    ]);
    expect(side).toMatchObject({ results: 5, apiPriced: 2, medianApiMicrousd: 200, planResults: 2, planRuns: 3, planTokens: 5010, unknownResults: 1, unknownRuns: 1 });
  });

  test("pending and not-counted records are not results; rejected and provisional ones are", () => {
    const side = sideOf(who, window, [record({ state: "pending" }), record({ state: "not-counted" }), record({ state: "rejected" }), record({ state: "provisional" }), record({})]);
    expect(side).toMatchObject({ results: 3, pending: 1, notCounted: 1, mature: 1, rejected: 1, provisional: 1, apiPriced: 3 });
  });

  test("revision and repair runs are included: their spending is in the result's, and they are counted", () => {
    const side = sideOf(who, window, [record({ apiMicrousd: 900, remediationRuns: 2 }), record({ apiMicrousd: 100, remediationRuns: 1 }), record({ apiMicrousd: 500 })]);
    expect(side).toMatchObject({ remediationRuns: 3, medianApiMicrousd: 500 });
  });

  test("hidden below 5 API-priced results on either side; both show at 5 and 5", () => {
    const five = Array.from({ length: 5 }, (_, n) => record({ apiMicrousd: 100 * (n + 1) }));
    const four = five.slice(0, 4);
    const short = compare(sideOf(who, window, five), sideOf(who, window, [...four, record({ unknownRuns: 1 }), record({ subscriptionRuns: 1 })]));
    expect(short.enough).toBe(false);
    expect(short.configured.medianApiMicrousd).toBeNull();
    expect(short.cheaper.medianApiMicrousd).toBeNull();
    expect(short.cheaper).toMatchObject({ results: 6, apiPriced: 4 });
    const both = compare(sideOf(who, window, five), sideOf(who, window, five));
    expect(both).toMatchObject({ enough: true, configured: { medianApiMicrousd: 300 }, cheaper: { medianApiMicrousd: 300 } });
  });

  test("unknown is never $0: a hidden median and an empty side read —", () => {
    const words = sideWords(sideOf(who, window, []));
    expect(words.median).toBe("—");
    expect(words.parts).toEqual(["API-priced 0 of 0", "plan usage —", "unknown cost —", "0 revision or repair runs included"]);
    expect(JSON.stringify(words)).not.toContain("$0");
    expect(sideWords({ ...sideOf(who, window, [record({ apiMicrousd: 5 })]), medianApiMicrousd: 5 }).median).toBe("<$0.01");
  });
});

describe("rules, trials and suggestions over matched 90-day windows", () => {
  test("a rule: the configured model's 90 days before acceptance against the results built under it, with the price snapshot", () => {
    const rule = acceptHaiku();
    // Before: Sonnet small results in the 90 days before acceptance (one older, one under another rule: not counted).
    for (const [n, api] of [700_000, 1_100_000, 900_000, 1_300_000, 1_000_000].entries()) seed(at(-60 + n), { api });
    seed(at(-91), { api: 99_000_000 });
    seed(at(-10), { api: 99_000_000, selections: [{ kind: "rule", rule: 999, ruleGeneration: 1 }] });
    // After: Haiku results whose sealed selection names this rule; one Haiku result picked another way doesn't count.
    for (const [n, api] of [300_000, 500_000, 400_000, 600_000].entries()) seed(at(1 + n), { model: HAIKU, api, selections: underRule(rule), remediation: n === 0 ? 2 : 0 });
    seed(at(6), { model: HAIKU, api: 99_000_000, selections: [{ kind: "override" }] });
    seed(at(7), { model: HAIKU, api: 0, unknown: 1, selections: underRule(rule) });
    seed(at(8), { model: HAIKU, api: 0, plan: 3, selections: underRule(rule) });
    prices(2, at(9)); // a later listed price never changes what was snapshotted at acceptance

    let report = savingsReport(store, [REPO], at(10));
    let row = report.rows.find(one => one.kind === "rule")!;
    expect(report.label).toBe(SAVINGS_LABEL);
    expect(row).toMatchObject({ id: String(rule), project: "shop", size: "small", state: "active", status: "In use", enough: false, pricesFrom: "accepted",
      prices: { model: { in: 1, out: 5 }, configured: { in: 3, out: 15 } } });
    expect(row.configured).toMatchObject({ model: SONNET, results: 5, apiPriced: 5, medianApiMicrousd: null, from: at(-90).toISOString(), to: T0.toISOString() });
    expect(row.cheaper).toMatchObject({ model: HAIKU, results: 6, apiPriced: 4, unknownResults: 1, planResults: 1, planRuns: 3, remediationRuns: 2, medianApiMicrousd: null });
    expect(row.words.join("\n")).toContain("Not enough priced results yet: 4 and 5");

    seed(at(9), { model: HAIKU, api: 450_000, selections: underRule(rule) });
    report = savingsReport(store, [REPO], at(10));
    row = report.rows.find(one => one.kind === "rule")!;
    expect(row.enough).toBe(true);
    expect(row.configured.medianApiMicrousd).toBe(1_000_000);
    expect(row.cheaper.medianApiMicrousd).toBe(450_000);
    expect(row.words.join("\n")).toContain("median $0.45 a task · API-priced 5 of 7 · plan usage 1 result (3 runs) · unknown cost 1 result (1 run) · 2 revision or repair runs included");
    expect(row.words.join("\n")).toContain("Listed prices when accepted, per million tokens in / out: Claude Haiku 5.5 $1 / $5, Claude Sonnet 5.5 $3 / $15.");
  });

  test("an ended rule's after side stops at its end", () => {
    const rule = acceptHaiku();
    expect(turnOffRule(store, rule, person(), at(5)).ok).toBe(true);
    seed(at(2), { model: HAIKU, selections: underRule(rule) });
    seed(at(6), { model: HAIKU, selections: underRule(rule) });
    const row = savingsReport(store, [REPO], at(10)).rows.find(one => one.kind === "rule")!;
    expect(row).toMatchObject({ state: "turned-off", status: "Turned off", cheaper: { results: 1, to: at(5).toISOString() } });
  });

  test("a trial compares its own results; a standing suggestion compares both models over the same last 90 days at today's prices", () => {
    for (let one = 0; one < 10; one++) seed(new Date(at(-30).getTime() + one * 3_600_000), { size: "medium", api: 900_000 });
    const [offer] = trialOffersFor(store, REPO, T0).filter(one => one.cohortSize === "medium");
    const started = startTrial(store, { repo: REPO, id: offer!.id }, person(), T0);
    if (!started.ok) throw new Error(started.problem);
    seed(at(1), { model: HAIKU, size: "medium", api: 200_000, selections: [{ kind: "trial", rule: started.trial, reservation: 1 }] });
    for (let one = 0; one < 10; one++) seed(new Date(at(-20).getTime() + one * 3_600_000), { model: HAIKU, api: 100_000 });
    const rows = savingsReport(store, [REPO], at(2)).rows;
    expect(rows.map(one => [one.kind, one.size])).toEqual([["suggestion", "small"], ["trial", "medium"]]);
    expect(rows[1]).toMatchObject({ status: "Trial running", configured: { results: 10, apiPriced: 10 }, cheaper: { results: 1 }, enough: false });
    expect(rows[0]).toMatchObject({ pricesFrom: "listed-now", configured: { model: SONNET, results: 0 }, cheaper: { model: HAIKU, results: 10, apiPriced: 10 }, enough: false });
    expect(rows[0]!.configured.from).toBe(rows[0]!.cheaper.from);
  });
});

describe("the states", () => {
  test("empty: no rows, one line, and the page says how a suggestion comes", () => {
    const report = savingsReport(store, [REPO], T0);
    expect(report).toMatchObject({ rows: [], staleSince: null, windowDays: 90, minPriced: 5 });
    expect(savingsLines(report)).toEqual(["  suggestions and rules    none yet"]);
    const page = renderToString(savingsSection(report));
    expect(page).toContain("No suggestions or rules yet.");
    expect(page).toContain('data-savings="empty"');
  });

  test("stale: an open result not checked for a day says when it was last checked", () => {
    const rule = acceptHaiku();
    seed(at(1), { model: HAIKU, selections: underRule(rule), closed: false, state: "provisional", evaluated: at(1) });
    const report = savingsReport(store, [REPO], at(3));
    expect(report.staleSince).toBe(at(1).toISOString());
    expect(savingsLines(report).join("\n")).toContain(`last checked on ${at(1).toISOString().slice(0, 10)}`);
    expect(renderToString(savingsSection(report))).toContain("data-savings-stale");
    expect(savingsReport(store, [REPO], new Date(at(1).getTime() + 3_600_000)).staleSince).toBeNull();
  });

  test("error: an unreadable block is named and never throws", () => {
    const broken = { handle: { prepare() { throw new Error("disk"); } } } as unknown as Store;
    const report = savingsReportOrError(broken, [REPO], T0);
    expect(report).toEqual({ error: "unreadable" });
    expect(savingsLines(report)).toEqual(["  Suggestions and rules can't be read right now."]);
    expect(renderToString(savingsSection(report))).toContain("can&#39;t be read right now");
  });

  test("the page row: the label, both sides, — for a hidden median, never $0, and the Models link", () => {
    const rule = acceptHaiku();
    seed(at(1), { model: HAIKU, selections: underRule(rule), api: 0, unknown: 1 });
    const page = renderToString(savingsSection(savingsReport(store, [REPO], at(2))));
    expect(page).toContain("observed, not a promise");
    expect(page).toContain('data-side="before"');
    expect(page).toContain('data-side="after"');
    expect(page).toContain("—");
    expect(page).toContain("data-not-enough");
    expect(page).toContain("Unknown cost 1 result (1 run)");
    expect(page).not.toMatch(/\$0\.00/);
    expect(page).toContain(`/settings/models?scope=${encodeURIComponent(REPO)}#models-suggested`);
  });
});

describe("toolroll spend", () => {
  test("prints the block's lines and returns it under suggestions in --json", async () => {
    const rule = acceptHaiku();
    for (let one = 0; one < 5; one++) { seed(at(-40 + one), { api: 1_000_000 }); seed(at(1 + one), { model: HAIKU, api: 300_000, selections: underRule(rule) }); }
    const file = join(dir, "plane.db");
    store.close();
    const lines: string[] = [];
    try {
      expect(await runOperate("spend", [], line => { lines.push(line); }, { databaseFile: file, now: at(10) })).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("Suggestions and rules (observed, not a promise; 90 days a side; a median shows from 5 API-priced results a side)");
      expect(text).toContain("shop · small tasks · Claude Haiku 5.5 instead of Claude Sonnet 5.5 · In use");
      expect(text).toMatch(/before +Claude Sonnet 5\.5, 2026-08-03 to 2026-11-01: median \$1\.00 a task · API-priced 5 of 5/);
      expect(text).toMatch(/after +Claude Haiku 5\.5, 2026-11-01 to 2026-11-11: median \$0\.30 a task · API-priced 5 of 5/);
      lines.length = 0;
      await runOperate("spend", ["--json"], line => { lines.push(line); }, { databaseFile: file, now: at(10) });
      const json = JSON.parse(lines.join("\n")) as { suggestions: { label: string; rows: { kind: string; enough: boolean; cheaper: { medianApiMicrousd: number } }[] } };
      expect(json.suggestions.label).toBe("observed, not a promise");
      expect(json.suggestions.rows).toMatchObject([{ kind: "rule", enough: true, cheaper: { medianApiMicrousd: 300_000 } }]);
    } finally {
      store = openStore(file);
    }
  });
});
