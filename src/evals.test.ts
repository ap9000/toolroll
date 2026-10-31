/**
 * The eval runner (docs/plans/evals-nightly.md, part C1): cases, admission and the reservation ledger, one attempt's
 * world from child process to settlement, and the dispatch gate every provider call in a world goes through. Worlds
 * here are made by the test (test/eval-worlds.ts) with a stand-in child process; no provider is ever called and
 * nothing is spent. Real processes (a race between two admissions, lingering process trees, the package's contents)
 * are in src/evals.slow.test.ts.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { performLeadRequest } from "./converse.js";
import { evalHookProblem } from "./eval-hooks.js";
import { EVAL_GATE_ENV, evalGateSlots, evalLeadAllowanceMicrousd, inEvalWorld, openEvalGate, takeEvalDispatch } from "./eval-gate.js";
import {
  admitEvalCampaign, attemptWorstMicrousd, campaignWorstMicrousd, EVALS_ROOT, exactModelProblem, finishEvalCampaign, loadEvalSet, planCampaign, runEvalAttempt, runEvalCampaign,
  type AttemptDeps, type EvalCase,
} from "./evals.js";
import { addApprover } from "./scope.js";
import { openStore, type Store } from "./store.js";
import { performSubscriptionLeadRequest } from "./subscription-chat.js";
import { claudeSizer } from "./task-sizing.js";
import { NOW, paginate, SET, worldDeps, child, makeWorld, type WorldSpec } from "../test/eval-worlds.js";

let dir: string;
let store: Store;
let password: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-evals-")));
  store = openStore(join(dir, "plane.db"));
  const added = addApprover(store, "alex", NOW);
  if (!added.ok) throw new Error("no approver");
  password = added.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

const month = () => ({ ...store.handle.prepare("SELECT reserved_microusd, settled_microusd FROM eval_spend_month WHERE month = '2026-10'").get() });

describe("the shipped eval set", () => {
  test("ten versioned cases, every one a draft awaiting a person: canonical refuses, a diagnostic runs, and pins must be exact", () => {
    expect(SET.cases.map(one => one.id)).toEqual(["paginate", "dedupe", "catalog", "endpoint", "csv-quoting", "merge-config", "math-subtract", "math-divide", "math-multiply", "round2-asks"]);
    expect(SET.cases.every(one => one.validatedBy === null && /^[0-9a-f]{64}$/.test(one.version))).toBe(true);
    const again = loadEvalSet();
    expect(again.ok && again.manifestDigest).toBe(SET.manifestDigest);
    expect(planCampaign(SET, {})).toEqual({ ok: false, problem: expect.stringMatching(/canonical campaign counts only cases a person validated, and every case is still a draft/) });
    const diagnostic = planCampaign(SET, { diagnostic: true });
    expect(diagnostic.ok && diagnostic.plan.canonical).toBe(false);
    // Validated (in a release a person approved), the same set is canonical; one draft left still refuses.
    const validated = { ...SET, cases: SET.cases.map(one => ({ ...one, validatedBy: "alex" })) };
    expect(planCampaign(validated, {})).toMatchObject({ ok: true, plan: { canonical: true, k: 3 } });
    expect(planCampaign({ ...validated, cases: validated.cases.map((one, at) => at === 3 ? { ...one, validatedBy: null } : one) }, {})).toMatchObject({ ok: false, problem: expect.stringMatching(/endpoint is still a draft/) });
  });

  test.each([
    ["sonnet", "an alias"], ["default", "an alias"], ["claude-sonnet", "no version"], ["", "empty"], ["claude-sonnet-4-5 --dangerous", "not an id"],
  ])("a pin of %j (%s) refuses every campaign", model => {
    expect(exactModelProblem({ provider: "claude", model })).not.toBeNull();
    const set = { ...SET, cases: SET.cases.map(one => one.id === "dedupe" ? { ...one, pin: { provider: "claude" as const, model } } : one) };
    expect(planCampaign(set, { diagnostic: true })).toMatchObject({ ok: false, problem: expect.stringMatching(/^case dedupe: /) });
  });

  test("every listed enforcement hook is in place in this tree (a release that drops one needs a person)", () => {
    const root = join(EVALS_ROOT, "..");
    expect(evalHookProblem(file => { try { return readFileSync(join(root, file)); } catch { return null; } })).toBeNull();
  });

  test("a link or an unlisted folder in the eval set refuses the whole set", () => {
    const copy = join(dir, "evals");
    cpSync(EVALS_ROOT, copy, { recursive: true });
    expect(loadEvalSet(copy).ok).toBe(true);
    symlinkSync("/etc/hosts", join(copy, "cases", "paginate", "fixture", "hosts"));
    expect(loadEvalSet(copy)).toEqual({ ok: false, problem: expect.stringMatching(/link or not a regular file/) });
    rmSync(join(copy, "cases", "paginate", "fixture", "hosts"));
    mkdirSync(join(copy, "cases", "extra"));
    expect(loadEvalSet(copy)).toEqual({ ok: false, problem: expect.stringMatching(/which the manifest doesn't list/) });
  });

});

const admit = (over: Partial<Parameters<typeof admitEvalCampaign>[1]> = {}) => admitEvalCampaign(store, {
  kind: "eval", canonical: false, manifestDigest: SET.manifestDigest, buildDigest: "build-a", version: "0.9.82", k: 1, sealed: {}, reservedMicrousd: 130_000_000,
  as: "alex", token: password, now: NOW, ...over,
});

describe("admission and the month's ledger", () => {
  test("a person's proof, the ceiling and one campaign of a kind at a time; reviewer campaigns share the ledger", () => {
    expect(admit({ token: "wrong-password" })).toMatchObject({ ok: false, reason: "person-only" });
    expect(admit({ reservedMicrousd: 200_000_001 })).toMatchObject({ ok: false, reason: "over-ceiling" });
    const first = admit();
    expect(first.ok).toBe(true);
    expect(month()).toEqual({ reserved_microusd: 130_000_000, settled_microusd: 0 });
    expect(admit({ reservedMicrousd: 1 })).toMatchObject({ ok: false, reason: "already-running" });
    // A reviewer campaign is held by the same month: $54 fits beside $130, $80 doesn't.
    expect(admit({ kind: "reviewer", reservedMicrousd: 80_000_000 })).toMatchObject({ ok: false, reason: "over-ceiling" });
    expect(admit({ kind: "reviewer", reservedMicrousd: 54_000_000 }).ok).toBe(true);
    expect(month()).toEqual({ reserved_microusd: 184_000_000, settled_microusd: 0 });
    expect(campaignWorstMicrousd({ canonical: true, k: 3, cases: SET.cases })).toBe(SET.cases.reduce((sum, one) => sum + attemptWorstMicrousd(one) * 3, 0) + 3 * 1_500_000);
  });

  test("no campaign starts while a release is deploying or merging", () => {
    store.handle.exec("PRAGMA foreign_keys = OFF");
    store.handle.prepare("INSERT INTO release_operation (id, authority, kind, task_id, candidate, epoch, state, reserved_at) VALUES ('op-1', 1, 'deploy', 't', 'c', 1, 'reserved', ?)").run(NOW.toISOString());
    expect(admit()).toMatchObject({ ok: false, reason: "release-busy" });
    expect(month()).toEqual({});
  });

});

// ------------------------------------------------------------------ worlds

const attempt = async (spec: WorldSpec, script?: string, one: EvalCase = paginate(), over: Partial<AttemptDeps> = {}) => {
  const admitted = admit({ reservedMicrousd: 10_000_000 });
  if (!admitted.ok) throw new Error(admitted.message);
  const d = worldDeps(dir, spec, script, over);
  const ran = await runEvalAttempt(store, { campaign: admitted.id, one, n: 1, replaces: 0 }, d);
  if (ran.attempt === null) throw new Error(ran.why);
  const invocations = store.handle.prepare("SELECT kind, world_ref, reserved_microusd, settled_microusd, unknown FROM eval_invocation WHERE attempt = ? ORDER BY id").all(ran.attempt).map(row => ({ ...row }));
  return { ...ran, campaign: admitted.id, invocations, graded: d.graded };
};

describe("an attempt, from its world's child process to settlement", () => {
  test("a build graded from its built commit; its dispatch carved from the campaign and settled once into the month", async () => {
    const ran = await attempt({ runs: [{ api: 300_000 }] });
    expect(ran.result).toMatchObject({ outcome: "pass", why: null, modelReported: paginate().pin.model, apiMicrousd: 300_000, usageUnknown: false });
    expect(ran.invocations).toEqual([{ kind: "builder", world_ref: expect.stringMatching(/^run:\d+$/), reserved_microusd: 750_000, settled_microusd: 300_000, unknown: 0 }]);
    // Admission reserved $10; the attempt carved its $1.50 from that (never from the month again) and settled $0.30.
    expect(month()).toEqual({ reserved_microusd: 10_000_000 - 1_500_000, settled_microusd: 300_000 });
    finishEvalCampaign(store, ran.campaign, "complete", null, NOW);
    expect(month()).toEqual({ reserved_microusd: 0, settled_microusd: 300_000 });
    // Settling and finishing again change nothing.
    finishEvalCampaign(store, ran.campaign, "complete", null, NOW);
    expect(month()).toEqual({ reserved_microusd: 0, settled_microusd: 300_000 });
  });

  test.each<[string, WorldSpec, string, { outcome: string; why: RegExp }, number]>([
    ["a wrong build fails on the hidden check", { runs: [{}], source: "export const paginate = (items, offset, limit) => items.splice(offset || 0, limit || 10);\n" }, "process.exit(0)", { outcome: "fail", why: /wrong answer/ }, 300_000],
    ["an unknown cost settles at the dispatch's full cap", { runs: [{ api: null }] }, "process.exit(0)", { outcome: "pass", why: /^$/ }, 750_000],
    ["a reported model other than the pin is unevaluated", { runs: [{ model: "claude-opus-4-1-20250805" }] }, "process.exit(0)", { outcome: "unevaluated", why: /not the pinned/ }, 300_000],
    ["a model the provider never reported is unevaluated", { runs: [{ model: null }] }, "process.exit(0)", { outcome: "unevaluated", why: /no model/ }, 300_000],
    ["a dispatch the gate refused past the case's limit makes the attempt a fail", { runs: [{}, {}, { started: false }] }, "process.exit(0)", { outcome: "fail", why: /past its limit of 2/ }, 600_000],
    ["a dispatch past the limit that went around the gate is an error", { runs: [{}, {}, { gated: false }] }, "process.exit(0)", { outcome: "error", why: /without the eval gate/ }, 900_000],
    ["a dispatch that bypassed the gate is an error, settled at its cap", { runs: [{ gated: false, api: 100_000 }] }, "process.exit(0)", { outcome: "error", why: /without the eval gate/ }, 100_000],
    ["a crashed world whose agent ran but built nothing fails", { runs: [{ built: false }] }, "process.exit(3)", { outcome: "fail", why: /no build finished/ }, 300_000],
    ["a world that failed before the agent started is an error", { database: false }, "console.log(JSON.stringify({ evalStage: 'world-start', why: 'git init failed' }))", { outcome: "error", why: /failed before the agent started: git init failed/ }, 0],
    ["a world that claims it failed to start after a provider ran is still graded", { runs: [{}] }, "console.log(JSON.stringify({ evalStage: 'world-start', why: 'made up' }))", { outcome: "pass", why: /^$/ }, 300_000],
    ["a provider refused before the agent started is an error", { runs: [{ started: false }] }, "process.exit(0)", { outcome: "error", why: /provider refused or was unavailable/ }, 0],
    ["a world with no database whose dispatches took slots settles each at its cap", { database: false }, `const fs = require("fs"); fs.writeFileSync(process.env.${EVAL_GATE_ENV} + "/slots/1.json", JSON.stringify({ kind: "run:1", pid: 1, at: "" })); process.exit(0);`, { outcome: "error", why: /records can't be read/ }, 750_000],
  ])("%s", async (_name, spec, script, expected, settled) => {
    const ran = await attempt(spec, script);
    expect(ran.result.outcome).toBe(expected.outcome);
    expect(ran.result.why ?? "").toMatch(expected.why);
    expect(ran.invocations.reduce((sum, one) => sum + Number(one["settled_microusd"]), 0)).toBe(settled);
    // Only a finished build reaches the oracle.
    if (expected.outcome !== "pass" && !/wrong answer/.test(ran.result.why ?? "")) expect(ran.graded).toEqual([]);
  });

  test("lead requests that bypass invokeAgent are each a dispatch: subscription usage kept apart, a slot with no record settled at its cap", async () => {
    const ran = await attempt({ runs: [{ api: 200_000 }], chats: 1, chatSlots: 1 }, undefined, paginate({ maxDispatches: 3 }));
    expect(ran.result).toMatchObject({ outcome: "pass", apiMicrousd: 200_000, subscriptionMicrousd: 20_000 });
    expect(ran.invocations.map(one => [one["kind"], one["settled_microusd"], one["unknown"]])).toEqual([["builder", 200_000, 0], ["lead", 0, 0]]);
    const unrecorded = await (async () => { store.handle.exec("UPDATE eval_campaign SET state = 'complete' WHERE state = 'running'"); return attempt({ runs: [{ api: 200_000 }], chats: 0, chatSlots: 1 }, undefined, paginate({ maxDispatches: 3 })); })();
    expect(unrecorded.invocations.map(one => [one["kind"], one["settled_microusd"], one["unknown"]])).toEqual([["builder", 200_000, 0], ["unrecorded", 750_000, 1]]);
    expect(unrecorded.result).toMatchObject({ usageUnknown: true, apiMicrousd: null });
  });

});

describe("a campaign", () => {
  test("a build change mid-campaign stops it incomplete and releases what it didn't carve; an error gets one replacement", async () => {
    const admitted = admit({ reservedMicrousd: 20_000_000, k: 3 });
    if (!admitted.ok) throw new Error(admitted.message);
    let digests = 0;
    const one = paginate();
    // First attempt: a world that fails to start (an error, replaced once); then the build changes.
    let worlds = 0;
    const ended = await runEvalCampaign(store, admitted.id, [one], {
      ...worldDeps(dir, { runs: [{}] }),
      concurrency: 1,
      command: input => { worlds++; if (worlds === 1) return child("console.log(JSON.stringify({ evalStage: 'world-start', why: 'boom' }))"); makeWorld(input, { runs: [{}] }); return child("process.exit(0)"); },
      buildDigest: () => (digests++ < 2 ? "build-a" : "build-b"),
    });
    expect(ended).toEqual({ state: "incomplete", why: "the installed build changed during the campaign" });
    const rows = store.handle.prepare("SELECT n, replaces, outcome FROM eval_attempt ORDER BY id").all().map(row => ({ ...row }));
    expect(rows).toEqual([{ n: 1, replaces: 0, outcome: "error" }, { n: 1, replaces: expect.any(Number), outcome: "pass" }]);
    expect(Number(rows[1]!["replaces"])).toBeGreaterThan(0);
    expect(month()).toEqual({ reserved_microusd: 0, settled_microusd: 300_000 });
    expect(store.handle.prepare("SELECT state, released FROM eval_campaign WHERE id = ?").get(admitted.id)).toMatchObject({ state: "incomplete", released: 1 });
  }, 30_000);
});

// ------------------------------------------------------------------ the dispatch gate in a world

describe("every provider dispatch in an eval world takes a slot and runs under its cap", () => {
  let gateDir: string;
  beforeEach(() => {
    gateDir = join(dir, "gate");
    mkdirSync(gateDir);
    openEvalGate(gateDir, { v: 1, max: 2, capMicrousd: 750_000 });
  });

  test("slots are numbered, exclusive and limited; an unreadable gate refuses everything; outside a world nothing changes", () => {
    const env = { [EVAL_GATE_ENV]: gateDir };
    expect(takeEvalDispatch("run:1", {})).toEqual({ active: false });
    expect(evalLeadAllowanceMicrousd(env)).toBe(1_500_000);
    expect(takeEvalDispatch("run:1", env)).toMatchObject({ active: true, ok: true, n: 1, capUsd: 0.75 });
    expect(evalLeadAllowanceMicrousd(env)).toBe(750_000);
    expect(takeEvalDispatch("lead:anthropic-api", env)).toMatchObject({ ok: true, n: 2 });
    expect(takeEvalDispatch("run:3", env)).toMatchObject({ ok: false, why: expect.stringMatching(/limit of 2 provider dispatches/) });
    expect(evalGateSlots(gateDir)?.map(slot => slot.kind)).toEqual(["run:1", "lead:anthropic-api"]);
    expect(takeEvalDispatch("run:4", { [EVAL_GATE_ENV]: join(dir, "nowhere") })).toMatchObject({ active: true, ok: false });
    // A gate whose terms are a link isn't read.
    const linked = join(dir, "linked-gate");
    mkdirSync(linked);
    symlinkSync(join(gateDir, "gate.json"), join(linked, "gate.json"));
    expect(takeEvalDispatch("run:5", { [EVAL_GATE_ENV]: linked })).toMatchObject({ active: true, ok: false });
  });

  test("a subscription lead request is capped with --max-budget-usd and counted; past the limit nothing spawns; Codex can't be capped", async () => {
    vi.stubEnv(EVAL_GATE_ENV, gateDir);
    const calls: string[][] = [];
    const runner = async (command: string, args: readonly string[]) => { calls.push([command, ...args]); return { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify({ reply: "ok", calls: [] }), structured_output: { reply: "ok", calls: [] } }), stderr: "", timedOut: false, notFound: false }; };
    const request = { provider: "claude-subscription" as const, model: "claude-sonnet-4-5-20250929", system: "s", dataDocument: "d", history: [{ role: "operator" as const, text: "hi" }], tools: [], timeoutMs: 5_000 };
    await performSubscriptionLeadRequest(request, runner);
    await performSubscriptionLeadRequest(request, runner);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.slice(call.indexOf("--max-budget-usd"), call.indexOf("--max-budget-usd") + 2)).toEqual(["--max-budget-usd", "0.75"]);
    expect(await performSubscriptionLeadRequest(request, runner)).toEqual({ ok: false, problem: "status-eval-dispatch-limit" });
    expect(calls).toHaveLength(2);
    rmSync(join(gateDir, "slots"), { recursive: true });
    mkdirSync(join(gateDir, "slots"));
    expect(await performSubscriptionLeadRequest({ ...request, provider: "codex-subscription" }, runner)).toEqual({ ok: false, problem: "status-eval-uncapped" });
    expect(calls).toHaveLength(2);
  });

  test("a direct lead request (it bypasses invokeAgent) takes a slot; past the limit nothing is sent", async () => {
    vi.stubEnv(EVAL_GATE_ENV, gateDir);
    let sent = 0;
    const fetcher = (async () => { sent++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    const signal = new AbortController().signal;
    for (let at = 0; at < 2; at++) await performLeadRequest({ url: "https://api.anthropic.com/v1/messages", headers: {}, body: "{}" }, "anthropic-api", signal, fetcher);
    expect(sent).toBe(2);
    expect(await performLeadRequest({ url: "https://api.anthropic.com/v1/messages", headers: {}, body: "{}" }, "anthropic-api", signal, fetcher)).toEqual({ ok: false, problem: "status-eval-dispatch-limit" });
    expect(sent).toBe(2);
    expect(evalGateSlots(gateDir)?.map(slot => slot.kind)).toEqual(["lead:anthropic-api", "lead:anthropic-api"]);
  });

  test("helpers that would call a provider without a record (task sizing) don't, in an eval world", async () => {
    vi.stubEnv(EVAL_GATE_ENV, gateDir);
    expect(inEvalWorld()).toBe(true);
    let spawned = 0;
    const sizer = claudeSizer(async () => { spawned++; return { code: 0, stdout: "{}", stderr: "", timedOut: false, notFound: false }; });
    expect(await sizer({ title: "a task" }, new AbortController().signal)).toBeNull();
    expect(spawned).toBe(0);
  });
});

