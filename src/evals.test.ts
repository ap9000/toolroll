/**
 * The eval runner (docs/plans/evals-nightly.md, part C1): cases, admission and the reservation ledger, one attempt's
 * world from child process to settlement, and the dispatch gate every provider call in a world goes through. Worlds
 * here are made by the test (test/eval-worlds.ts) with a stand-in child process; no provider is ever called and
 * nothing is spent. Real processes (a race between two admissions, lingering process trees, the package's contents)
 * are in src/evals.slow.test.ts.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { performChatRequest, performLeadRequest } from "./converse.js";
import { defaultAnalyzer } from "./memory-pass.js";
import { evalHookProblem } from "./eval-hooks.js";
import { EVAL_GATE_ENV, evalGateSlots, inEvalWorld, openEvalGate, takeEvalDispatch } from "./eval-gate.js";
import {
  abandonEvalCampaign, admitEvalCampaign, campaignSpending, EVALS_ROOT, exactModelProblem, installedBuildDigest, loadEvalSet, planCampaign, processStartOf, recoverEvalCampaigns, runEvalAttempt,
  runEvalCampaign, startEvalAttempt, type AttemptDeps, type EvalCase,
} from "./evals.js";
import { runOperate } from "./operate.js";
import { addApprover } from "./scope.js";
import { openStore, type Store } from "./store.js";
import { performSubscriptionLeadRequest } from "./subscription-chat.js";
import { claudeSizer } from "./task-sizing.js";
import { NOW, paginate, SET, worldDeps, child, makeWorld, type WorldSpec } from "../test/eval-worlds.js";

// A world whose process ancestry the observer loses (PR #263 review #4): set per test, through the real observer.
const tree = vi.hoisted(() => ({ unknown: false }));
vi.mock("./process-tree.js", async original => {
  const real = await original<typeof import("./process-tree.js")>();
  return { ...real, observeProcessTree: (...args: Parameters<typeof real.observeProcessTree>) => { real.observeProcessTree(...args); if (tree.unknown) args[1].onUnknown?.(); } };
});

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
afterEach(() => { tree.unknown = false; store.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });


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
  kind: "eval", canonical: false, manifestDigest: SET.manifestDigest, buildDigest: "build-a", version: "0.9.82", k: 1, sealed: {},
  as: "alex", token: password, now: NOW, ...over,
});

describe("admission", () => {
  test("a person's proof; one canonical campaign at a time (settlement order); no money limit", () => {
    expect(admit({ token: "wrong-password" })).toMatchObject({ ok: false, reason: "person-only" });
    expect(admit({ canonical: true }).ok).toBe(true);
    expect(admit({ canonical: true })).toMatchObject({ ok: false, reason: "already-running" });
    // Diagnostic and reviewer campaigns aren't held by it, and nothing is held for money (the owner, 2026-10-30).
    expect(admit().ok).toBe(true);
    expect(admit({ kind: "reviewer" }).ok).toBe(true);
    expect({ ...store.handle.prepare("SELECT runner_host, runner_pid FROM eval_campaign LIMIT 1").get() }).toEqual({ runner_host: hostname(), runner_pid: process.pid });
  });

  test("no campaign starts while a release is deploying or merging", () => {
    store.handle.exec("PRAGMA foreign_keys = OFF");
    store.handle.prepare("INSERT INTO release_operation (id, authority, kind, task_id, candidate, epoch, state, reserved_at) VALUES ('op-1', 1, 'deploy', 't', 'c', 1, 'reserved', ?)").run(NOW.toISOString());
    expect(admit()).toMatchObject({ ok: false, reason: "release-busy" });
  });
});

// ------------------------------------------------------------------ worlds

const invocationsOf = (attempt: number) => store.handle.prepare("SELECT kind, world_ref, recorded, amount, api_microusd, subscription_microusd, model_reported FROM eval_invocation WHERE attempt = ? ORDER BY id")
  .all(attempt).map(row => ({ ...row }));
const attempt = async (spec: WorldSpec, script?: string, one: EvalCase = paginate(), over: Partial<AttemptDeps> = {}) => {
  const admitted = admit();
  if (!admitted.ok) throw new Error(admitted.message);
  const d = worldDeps(dir, spec, script, over);
  const ran = await runEvalAttempt(store, { campaign: admitted.id, one, n: 1, replaces: 0 }, d);
  if (ran.attempt === null) throw new Error(ran.why);
  return { ...ran, campaign: admitted.id, invocations: invocationsOf(ran.attempt), graded: d.graded };
};
const apiOf = (rows: Record<string, unknown>[]) => rows.map(one => [one["kind"], one["amount"], one["api_microusd"]]);

describe("an attempt, from its world's child process to its record", () => {
  test("a build graded from its built commit; each dispatch recorded as it was billed, with its model", async () => {
    const ran = await attempt({ runs: [{ api: 300_000 }] });
    expect(ran.result).toMatchObject({ outcome: "pass", why: null, modelReported: paginate().pin.model, dispatches: 1, apiMicrousd: 300_000, subscriptionMicrousd: 0, usageUnknown: false });
    expect(ran.invocations).toEqual([{ kind: "builder", world_ref: expect.stringMatching(/^run:\d+$/), recorded: 1, amount: "api", api_microusd: 300_000, subscription_microusd: null, model_reported: paginate().pin.model }]);
    expect(campaignSpending(store, ran.campaign)).toEqual({ apiMicrousd: 300_000, subscriptionMicrousd: 0, unknownAttempts: 0, attempts: 1 });
  });

  test.each<[string, WorldSpec, string, { outcome: string; why: RegExp }, (string | number | null)[][]]>([
    ["a wrong build fails on the hidden check", { runs: [{}], source: "export const paginate = (items, offset, limit) => items.splice(offset || 0, limit || 10);\n" }, "process.exit(0)", { outcome: "fail", why: /wrong answer/ }, [["builder", "api", 300_000]]],
    ["a cost the provider never reported is unknown, never measured", { runs: [{ api: null }] }, "process.exit(0)", { outcome: "pass", why: /^$/ }, [["builder", "unknown", null]]],
    ["a billing this computer only guessed is unknown (Codex round 1 #4)", { runs: [{ basis: "default" }] }, "process.exit(0)", { outcome: "pass", why: /^$/ }, [["builder", "unknown", null]]],
    ["a reported model other than the pin is unevaluated", { runs: [{ model: "claude-opus-4-1-20250805" }] }, "process.exit(0)", { outcome: "unevaluated", why: /not the pinned/ }, [["builder", "api", 300_000]]],
    ["a model the provider never reported is unevaluated", { runs: [{ model: null }] }, "process.exit(0)", { outcome: "unevaluated", why: /no model/ }, [["builder", "api", 300_000]]],
    ["a dispatch the gate refused past the case's limit makes the attempt a fail", { runs: [{}, {}, { started: false }] }, "process.exit(0)", { outcome: "fail", why: /more than its limit of 2/ }, [["builder", "api", 300_000], ["builder", "api", 300_000]]],
    ["a dispatch that went around the gate is an error, its record kept", { runs: [{ gated: false, api: 100_000 }] }, "process.exit(0)", { outcome: "error", why: /don't agree/ }, [["builder", "api", 100_000]]],
    ["a crashed world whose agent ran but built nothing fails", { runs: [{ built: false }] }, "process.exit(3)", { outcome: "fail", why: /process crashed/ }, [["builder", "api", 300_000]]],
    ["a crashed world cannot pass using an earlier finished build", { runs: [{}] }, "process.exit(3)", { outcome: "fail", why: /process crashed/ }, [["builder", "api", 300_000]]],
    ["a world that failed before the agent started is an error", { database: false }, "console.log(JSON.stringify({ evalStage: 'world-start', why: 'git init failed' }))", { outcome: "error", why: /failed before the agent started: git init failed/ }, [["unrecorded", "unknown", null]]],
    ["a world that claims it failed to start after a provider ran is still graded", { runs: [{}] }, "console.log(JSON.stringify({ evalStage: 'world-start', why: 'made up' }))", { outcome: "pass", why: /^$/ }, [["builder", "api", 300_000]]],
    ["a provider refused before the agent started is an error", { runs: [{ started: false }] }, "process.exit(0)", { outcome: "error", why: /provider refused or was unavailable/ }, []],
    ["a world with no database whose dispatches took slots records each as unknown", { database: false }, `const fs = require("fs"); fs.writeFileSync(process.env.${EVAL_GATE_ENV} + "/slots/1.json", JSON.stringify({ kind: "run:1", pid: 1, at: "" })); process.exit(0);`, { outcome: "error", why: /records can't be read/ }, [["unrecorded", "unknown", null]]],
  ])("%s", async (_name, spec, script, expected, dispatches) => {
    const ran = await attempt(spec, script);
    expect(ran.result.outcome).toBe(expected.outcome);
    expect(ran.result.why ?? "").toMatch(expected.why);
    expect(apiOf(ran.invocations)).toEqual(dispatches);
    // Unknown is never shown as measured: one unknown dispatch makes the attempt's API total unknown.
    if (dispatches.some(one => one[1] === "unknown")) expect(ran.result).toMatchObject({ usageUnknown: true, apiMicrousd: null });
    // Only a finished build reaches the oracle.
    if (expected.outcome !== "pass" && !/wrong answer/.test(ran.result.why ?? "")) expect(ran.graded).toEqual([]);
  });

  test("lead requests are each a dispatch: subscription usage kept apart; a slot with no record is an error with unknown spending and model (Codex round 1 #8)", async () => {
    const ran = await attempt({ runs: [{ api: 200_000 }], chats: 1, chatSlots: 1 }, undefined, paginate({ maxDispatches: 3 }));
    expect(ran.result).toMatchObject({ outcome: "pass", apiMicrousd: 200_000, subscriptionMicrousd: 20_000 });
    expect(apiOf(ran.invocations)).toEqual([["builder", "api", 200_000], ["lead", "subscription", null]]);
    const unrecorded = await attempt({ runs: [{ api: 200_000 }], chats: 0, chatSlots: 1 }, undefined, paginate({ maxDispatches: 3 }));
    expect(apiOf(unrecorded.invocations)).toEqual([["builder", "api", 200_000], ["unrecorded", "unknown", null]]);
    expect(unrecorded.result).toMatchObject({ outcome: "error", usageUnknown: true, apiMicrousd: null, modelReported: null, tokensIn: null });
    // A chat request whose own events didn't say how it was billed is unknown money, never plan usage (#4).
    const silent = await attempt({ runs: [{ api: 200_000 }], chats: 1, chatSlots: 1, chatBilling: null }, undefined, paginate({ maxDispatches: 3 }));
    expect(apiOf(silent.invocations)).toEqual([["builder", "api", 200_000], ["lead", "unknown", null]]);
    expect(silent.result).toMatchObject({ usageUnknown: true, apiMicrousd: null, subscriptionMicrousd: null });
  });

  test("the runner failing mid-attempt still records what the world dispatched (Codex round 1 #1)", async () => {
    const ran = await attempt({}, undefined, paginate(), { command: input => { makeWorld(input, { runs: [{ api: 400_000 }] }); throw new Error("spawn exploded"); } });
    expect(ran.result).toMatchObject({ outcome: "error", why: expect.stringMatching(/spawn exploded/), apiMicrousd: 400_000 });
    expect(apiOf(ran.invocations)).toEqual([["builder", "api", 400_000]]);
  });

  test.each(["chat table", "gate slots", "null slot"])("unreadable %s keeps known charges and records unknown metadata", async broken => {
    const ran = await attempt({}, undefined, paginate(), { command: input => {
      makeWorld(input, { runs: [{ api: 400_000 }] });
      if (broken === "chat table") {
        const world = openStore(input.databaseFile);
        try { world.handle.exec("ALTER TABLE chat_turn RENAME COLUMN state TO missing_state"); } finally { world.close(); }
      } else if (broken === "null slot") writeFileSync(join(input.gateDir, "slots", "1.json"), "null");
      else rmSync(join(input.gateDir, "slots"), { recursive: true });
      return child("process.exit(0)");
    } });
    expect(ran.result).toMatchObject({ outcome: "error", apiMicrousd: null, usageUnknown: true, modelReported: null, tokensIn: null });
    expect(apiOf(ran.invocations)).toEqual([["builder", "api", 400_000], ["unrecorded", "unknown", null]]);
  });

  test("an attempt whose world can't even be made is recorded, never thrown (Codex round 1 #12)", async () => {
    writeFileSync(join(dir, "not-a-folder"), "");
    const ran = await attempt({ runs: [{}] }, undefined, paginate(), { workRoot: join(dir, "not-a-folder", "worlds") });
    expect(ran.result).toMatchObject({ outcome: "error", why: expect.stringMatching(/eval runner failed/), usageUnknown: true });
  });

  test("tool calls come from the world's step records before it is removed (Codex round 1 #13)", async () => {
    const steps = [{ k: "open", at: NOW.toISOString(), detail: "base" }, ...["read", "edit", "command"].flatMap((kind, at) => [
      { k: "step", at: new Date(NOW.getTime() + at * 1000).toISOString(), id: `s${at + 1}`, kind }, { k: "done", at: new Date(NOW.getTime() + at * 1000 + 500).toISOString(), id: `s${at + 1}`, ok: true }])];
    const ran = await attempt({}, undefined, paginate(), { command: input => {
      makeWorld(input, { runs: [{}] });
      mkdirSync(join(input.worldDir, "toolroll", "evidence", "live"), { recursive: true });
      writeFileSync(join(input.worldDir, "toolroll", "evidence", "live", "1.jsonl"), steps.map(one => JSON.stringify(one)).join("\n") + "\n");
      return child("process.exit(0)");
    } });
    expect(ran.result).toMatchObject({ outcome: "pass", toolCalls: 3 });
    // No step records: unknown, never 0.
    expect((await attempt({ runs: [{}] })).result.toolCalls).toBeNull();
  });
});

describe("a campaign", () => {
  test("a build change mid-campaign stops it incomplete; an error gets one replacement", async () => {
    const admitted = admit({ k: 3 });
    if (!admitted.ok) throw new Error(admitted.message);
    let digests = 0;
    let worlds = 0;
    const ended = await runEvalCampaign(store, admitted.id, [paginate()], {
      ...worldDeps(dir, { runs: [{}] }),
      concurrency: 1,
      command: input => { worlds++; if (worlds === 1) return child("console.log(JSON.stringify({ evalStage: 'world-start', why: 'boom' }))"); makeWorld(input, { runs: [{}] }); return child("process.exit(0)"); },
      buildDigest: () => (digests++ < 2 ? "build-a" : "build-b"),
    });
    expect(ended).toEqual({ state: "incomplete", why: "the installed build changed during the campaign" });
    const rows = store.handle.prepare("SELECT n, replaces, outcome FROM eval_attempt ORDER BY id").all().map(row => ({ ...row }));
    expect(rows).toEqual([{ n: 1, replaces: 0, outcome: "error" }, { n: 1, replaces: expect.any(Number), outcome: "pass" }]);
    expect(Number(rows[1]!["replaces"])).toBeGreaterThan(0);
  }, 30_000);

  test("a change during the last attempt still leaves the campaign incomplete (Codex round 1 #9)", async () => {
    const admitted = admit({ k: 1 });
    if (!admitted.ok) throw new Error(admitted.message);
    let digests = 0;
    const ended = await runEvalCampaign(store, admitted.id, [paginate()], { ...worldDeps(dir, { runs: [{}] }), buildDigest: () => (digests++ < 1 ? "build-a" : "build-b") });
    expect(ended).toEqual({ state: "incomplete", why: "the installed build changed during the campaign" });
    expect(store.handle.prepare("SELECT outcome FROM eval_attempt").get()).toMatchObject({ outcome: "pass" });
  }, 30_000);

  test("a failed admission read waits for already-started attempts before ending the campaign", async () => {
    const admitted = admit({ k: 2 });
    if (!admitted.ok) throw new Error(admitted.message);
    let reads = 0;
    let stateWhileGrading: unknown;
    const ended = await runEvalCampaign(store, admitted.id, [paginate()], {
      ...worldDeps(dir, { runs: [{}] }), concurrency: 2,
      buildDigest: () => { if (++reads > 1) throw new Error("identity unreadable"); return "build-a"; },
      oracle: async () => {
        stateWhileGrading = store.handle.prepare("SELECT state FROM eval_campaign WHERE id = ?").get(admitted.id)?.["state"];
        return { outcome: "pass", why: null };
      },
    });
    expect(stateWhileGrading).toBe("running");
    expect(ended).toEqual({ state: "incomplete", why: "the eval runner failed: identity unreadable" });
    expect(store.handle.prepare("SELECT outcome FROM eval_attempt").get()).toMatchObject({ outcome: "pass" });
  });

  test("a world not proven stopped makes its spending unknown, never the part its records show, and ends the campaign incomplete (PR #263 review)", async () => {
    const admitted = admit({ k: 2 });
    if (!admitted.ok) throw new Error(admitted.message);
    tree.unknown = true;
    const ended = await runEvalCampaign(store, admitted.id, [paginate()], { ...worldDeps(dir, { runs: [{ api: 250_000 }] }), concurrency: 1, buildDigest: () => "build-a" });
    expect(ended).toEqual({ state: "incomplete", why: expect.stringMatching(/couldn't be proven stopped, so what it spent is unknown/) });
    // One attempt, no replacement and no second attempt: an error whose money is unknown, its known dispatch still kept.
    expect(store.handle.prepare("SELECT outcome, api_microusd, subscription_microusd, usage_unknown FROM eval_attempt").all().map(row => ({ ...row })))
      .toEqual([{ outcome: "error", api_microusd: null, subscription_microusd: null, usage_unknown: 1 }]);
    expect(store.handle.prepare("SELECT world_ref, amount, api_microusd FROM eval_invocation ORDER BY id").all().map(row => [row["world_ref"], row["amount"], row["api_microusd"]]))
      .toEqual([[expect.stringMatching(/^run:/), "api", 250_000], ["tree:unstopped", "unknown", null]]);
    expect(campaignSpending(store, admitted.id)).toMatchObject({ apiMicrousd: null, subscriptionMicrousd: null, unknownAttempts: 1 });
  }, 30_000);

  test("a runner's pid held by a process that started at another time isn't the runner (PR #263 review)", () => {
    const started = processStartOf(process.pid);
    expect(started).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
    // This test's own process stands in for a later process that reuses the runner's pid: same number, another start.
    const reused = admit({ canonical: true, runner: { host: "this-mac", pid: process.pid, started: "Thu Jan 1 00:00:00 2015" } });
    if (!reused.ok) throw new Error(reused.message);
    expect(recoverEvalCampaigns(store, NOW, { host: "this-mac" })).toEqual([{ id: reused.id, recovered: true, why: "0 unfinished attempts recorded as interrupted" }]);
    // The same process, its start matching: still the runner.
    const live = admit({ canonical: true, runner: { host: "this-mac", pid: process.pid, started } });
    if (!live.ok) throw new Error(live.message);
    expect(recoverEvalCampaigns(store, NOW, { host: "this-mac" })).toEqual([{ id: live.id, recovered: false, why: "its runner is still running" }]);
    // No start recorded: a held pid can't be told apart, so it is left running (a person abandons it).
    store.handle.prepare("UPDATE eval_campaign SET runner_started = NULL WHERE id = ?").run(live.id);
    expect(recoverEvalCampaigns(store, NOW, { host: "this-mac" })[0]).toMatchObject({ recovered: false });
  });

  test("a stuck campaign is abandoned only by a person's password: unfinished attempts unknown, nothing signalled (PR #263 review)", async () => {
    const admitted = admit({ canonical: true, runner: { host: hostname(), pid: process.pid, started: processStartOf(process.pid) } });
    if (!admitted.ok) throw new Error(admitted.message);
    const done = startEvalAttempt(store, { campaign: admitted.id, caseId: "paginate", caseVersion: "v", n: 1, replaces: 0, modelPinned: paginate().pin.model, now: NOW });
    const stuck = startEvalAttempt(store, { campaign: admitted.id, caseId: "paginate", caseVersion: "v", n: 2, replaces: 0, modelPinned: paginate().pin.model, now: NOW });
    if (!done.ok || !stuck.ok) throw new Error("not started");
    store.handle.prepare("UPDATE eval_attempt SET outcome = 'pass', api_microusd = 100, subscription_microusd = 0 WHERE id = ?").run(done.attempt);
    // Its world's group is this test's own (alive): recovery can't settle it, and abandoning signals nothing.
    store.handle.prepare("UPDATE eval_attempt SET world_pgid = ? WHERE id = ?").run(process.pid, stuck.attempt);
    expect(recoverEvalCampaigns(store, NOW)[0]).toMatchObject({ recovered: false });
    const lines: string[] = [];
    const cli = (args: string[]) => runOperate("evals", ["recover", ...args, "--json"], line => { lines.push(line); }, { databaseFile: join(dir, "plane.db") });
    expect(await cli(["--abandon", admitted.id, "--as", "alex", "--token", "wrong-password-0000"])).not.toBe(0);
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", "lt_x");
    expect(await cli(["--abandon", admitted.id, "--as", "alex", "--token", password])).not.toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: false, reason: "person-only" });
    vi.unstubAllEnvs();
    expect(abandonEvalCampaign(store, { id: "ev-nothing", as: "alex", token: password, now: NOW })).toMatchObject({ ok: false, reason: "not-running" });
    expect(store.handle.prepare("SELECT state FROM eval_campaign WHERE id = ?").get(admitted.id)).toMatchObject({ state: "running" });
    expect(await cli(["--abandon", admitted.id, "--as", "alex", "--token", password])).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: true, campaign: admitted.id, state: "incomplete", attempts: 1, spending: "unknown" });
    expect(store.handle.prepare("SELECT state, why FROM eval_campaign WHERE id = ?").get(admitted.id)).toMatchObject({ state: "incomplete", why: expect.stringMatching(/abandoned by alex/) });
    expect(store.handle.prepare("SELECT outcome, usage_unknown, api_microusd FROM eval_attempt WHERE id = ?").get(stuck.attempt)).toMatchObject({ outcome: "error", usage_unknown: 1, api_microusd: null });
    // The finished attempt keeps what it recorded; the campaign's spending is unknown all the same.
    expect(store.handle.prepare("SELECT outcome, api_microusd FROM eval_attempt WHERE id = ?").get(done.attempt)).toMatchObject({ outcome: "pass", api_microusd: 100 });
    expect(campaignSpending(store, admitted.id)).toMatchObject({ apiMicrousd: null, subscriptionMicrousd: null });
    // This process (the "world") was never signalled, and its place is free.
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    expect(admit({ canonical: true }).ok).toBe(true);
  });

  test("the build identity includes the service definition a deploy rewrites (Codex round 1 #9)", () => {
    const home = join(dir, "home");
    const agents = join(home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "com.toolroll.browser.plist"), "<string>/runtimes/release-a/dist/bin.js</string>");
    const before = installedBuildDigest("0.9.82", home);
    expect(installedBuildDigest("0.9.82", home)).toBe(before);
    writeFileSync(join(agents, "com.toolroll.browser.plist"), "<string>/runtimes/release-b/dist/bin.js</string>");
    expect(installedBuildDigest("0.9.82", home)).not.toBe(before);
  });

  test("an interrupted campaign is recovered once its runner and worlds are gone, recording what its worlds dispatched (Codex round 1 #12)", async () => {
    const admitted = admit({ canonical: true, runner: { host: "this-mac", pid: 999_999 } });
    if (!admitted.ok) throw new Error(admitted.message);
    const started = startEvalAttempt(store, { campaign: admitted.id, caseId: "paginate", caseVersion: "v", n: 1, replaces: 0, modelPinned: paginate().pin.model, now: NOW });
    if (!started.ok) throw new Error(started.why);
    const worldDir = join(dir, "interrupted-world");
    mkdirSync(join(worldDir, "toolroll", "eval-gate"), { recursive: true });
    openEvalGate(join(worldDir, "toolroll", "eval-gate"), { v: 2, max: 2 });
    makeWorld({ worldDir, databaseFile: join(worldDir, "toolroll", "orders.db"), gateDir: join(worldDir, "toolroll", "eval-gate") }, { runs: [{ api: 250_000 }] });
    store.handle.prepare("UPDATE eval_attempt SET world_dir = ?, world_pgid = ? WHERE id = ?").run(worldDir, process.pid, started.attempt);
    // Its runner alive, or on another computer: left as it is.
    expect(recoverEvalCampaigns(store, NOW, { host: "this-mac", alive: () => true })).toEqual([{ id: admitted.id, recovered: false, why: "its runner is still running" }]);
    expect(recoverEvalCampaigns(store, NOW, { host: "other-mac", alive: () => false })).toEqual([{ id: admitted.id, recovered: false, why: "its runner is on this-mac" }]);
    // Its world's process group still alive (this test's own): left as it is.
    expect(recoverEvalCampaigns(store, NOW, { host: "this-mac", alive: () => false })[0]).toMatchObject({ recovered: false, why: expect.stringMatching(/still running/) });
    store.handle.prepare("UPDATE eval_attempt SET world_pgid = NULL WHERE id = ?").run(started.attempt);
    // A dead original group is insufficient: a saved detached descendant may still be alive, or observation lost.
    for (const saved of [null, { state: "starting", witnesses: [] }, { state: "unknown", witnesses: [] },
      { state: "watching", witnesses: [[process.pid, false]] }]) {
      store.handle.prepare("UPDATE eval_attempt SET world_processes_json = ? WHERE id = ?").run(JSON.stringify(saved), started.attempt);
      expect(recoverEvalCampaigns(store, NOW, { host: "this-mac", alive: () => false })[0]).toMatchObject({ recovered: false, why: expect.stringMatching(/isn't proven stopped/) });
    }
    store.handle.prepare("UPDATE eval_attempt SET world_processes_json = ? WHERE id = ?").run(JSON.stringify({ state: "stopped", witnesses: [] }), started.attempt);
    expect(recoverEvalCampaigns(store, NOW, { host: "this-mac", alive: () => false })).toEqual([{ id: admitted.id, recovered: true, why: "1 unfinished attempt recorded as interrupted" }]);
    expect(store.handle.prepare("SELECT outcome, error_why, api_microusd FROM eval_attempt").get()).toMatchObject({ outcome: "error", error_why: expect.stringMatching(/interrupted/), api_microusd: 250_000 });
    expect(store.handle.prepare("SELECT state FROM eval_campaign WHERE id = ?").get(admitted.id)).toMatchObject({ state: "incomplete" });
    // Its place is free again.
    expect(admit({ canonical: true }).ok).toBe(true);
  });
});

// ------------------------------------------------------------------ the dispatch gate in a world

describe("every provider dispatch in an eval world takes a slot", () => {
  let gateDir: string;
  beforeEach(() => {
    gateDir = join(dir, "gate");
    mkdirSync(gateDir);
    openEvalGate(gateDir, { v: 2, max: 2 });
  });

  test("slots are numbered, exclusive and limited; an unreadable gate refuses everything; outside a world nothing changes", () => {
    const env = { [EVAL_GATE_ENV]: gateDir };
    expect(takeEvalDispatch("run:1", {})).toEqual({ active: false });
    expect(takeEvalDispatch("run:1", env)).toEqual({ active: true, ok: true, n: 1 });
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

  test("a subscription lead request takes a slot, with no dollar cap; past the limit nothing spawns", async () => {
    vi.stubEnv(EVAL_GATE_ENV, gateDir);
    const calls: string[][] = [];
    const runner = async (command: string, args: readonly string[]) => { calls.push([command, ...args]); return { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify({ reply: "ok", calls: [] }), structured_output: { reply: "ok", calls: [] } }), stderr: "", timedOut: false, notFound: false }; };
    const request = { provider: "claude-subscription" as const, model: "claude-sonnet-5-5", system: "s", dataDocument: "d", history: [{ role: "operator" as const, text: "hi" }], tools: [], timeoutMs: 5_000 };
    await performSubscriptionLeadRequest(request, runner);
    await performSubscriptionLeadRequest(request, runner);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).not.toContain("--max-budget-usd");
    expect(await performSubscriptionLeadRequest(request, runner)).toEqual({ ok: false, problem: "status-eval-dispatch-limit" });
    expect(calls).toHaveLength(2);
  });

  test.each([
    ["a direct lead request", (fetcher: typeof fetch) => performLeadRequest({ url: "https://api.anthropic.com/v1/messages", headers: {}, body: "{}" }, "anthropic-api", new AbortController().signal, fetcher)],
    // Codex round 1 #3: fleet chat's request went to the network without a slot.
    ["a fleet chat request", (fetcher: typeof fetch) => performChatRequest({ provider: "anthropic-api", model: "claude-sonnet-5-5", key: "k", dataDocument: "d", userMessage: "hi", signal: new AbortController().signal }, fetcher)],
  ])("%s (outside the gateway) takes a slot; past the limit, or with an unreadable gate, nothing is sent", async (_name, send) => {
    vi.stubEnv(EVAL_GATE_ENV, gateDir);
    let sent = 0;
    const fetcher = (async () => { sent++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    await send(fetcher);
    await send(fetcher);
    expect(sent).toBe(2);
    expect(await send(fetcher)).toEqual({ ok: false, problem: "status-eval-dispatch-limit" });
    vi.stubEnv(EVAL_GATE_ENV, join(dir, "no-gate"));
    expect(await send(fetcher)).toEqual({ ok: false, problem: "status-eval-dispatch-limit" });
    expect(sent).toBe(2);
  });

  test("helpers that would call a provider without a record (task sizing, the memory pass) don't, in an eval world", async () => {
    vi.stubEnv(EVAL_GATE_ENV, gateDir);
    expect(inEvalWorld()).toBe(true);
    let spawned = 0;
    const sizer = claudeSizer(async () => { spawned++; return { code: 0, stdout: "{}", stderr: "", timedOut: false, notFound: false }; });
    expect(await sizer({ title: "a task" }, new AbortController().signal)).toBeNull();
    const analyzer = defaultAnalyzer(store, { runner: async () => { spawned++; return { code: 0, stdout: "{}", stderr: "", timedOut: false, notFound: false }; } });
    expect(await analyzer({ surface: "lead", kind: "lead", trace: "t", openGaps: [] } as unknown as Parameters<typeof analyzer>[0])).toMatchObject({ ok: false });
    expect(spawned).toBe(0);
    expect(evalGateSlots(gateDir)).toEqual([]);
  });
});
