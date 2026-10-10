import { currentClaim } from "./claim.js";
import * as projectSkills from "./project-skills.js";
/**
 * Planning mode, end to end against real git: the operator asks for a plan,
 * a planner interrogates and drafts, the operator approves the proposed
 * scope, and only then does a builder spend — with the plan in its brief.
 *
 * Only the agent is a stub. The workspace-proof ordering (Codex planning
 * review, finding 1) is exercised adversarially: a planner that touches the
 * tree gets nothing ingested, question included.
 */

import { routeDigestOf } from "./phase-routing.js";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import { approve, propose, type AcceptanceCriterion } from "./scope.js";
import type { Runner } from "./builder.js";
import { createDecisionServer } from "./serve.js";
import { readVerifiedArtifact, storeEvidence } from "./evidence.js";
import { changeLearning, learningContext, learningView } from "./project-learning.js";
import { decodePlanContractRecord, decodePlannerSource, PLANNER_SOURCE_LIMITS } from "./planner-source.js";
import { diagnoseTaskDispatch } from "./dispatch.js";
import { PLAN_MODEL_SCHEMA } from "./contracts/plan.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-08-12T22:00:00.000Z");
const SAID = JSON.stringify({ result: "planning" });
const saidInSession = (sessionId: string) => JSON.stringify({ result: "planning", session_id: sessionId });

const PLAN_FILE = /STANDING-ORDERS-PLAN-[0-9a-f]{16}\.json/;
const PARK_FILE = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/;

describe("planning mode, against real git", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  let prompts: string[] = [];
  let plannerArgv: string[][] = [];

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const payload = () => JSON.parse(lines.join("\n"));

  const validPlanPayload = () => ({
    goal: "Guard the payout endpoint with a rate limiter",
    outOfScope: "No schema changes",
    touches: ["src/payouts.ts"],
    acceptance: [{ id: "c1", statement: "The payout endpoint is rate limited.", evidence: ["check"] }],
    plan: [
      "## Approach",
      "Wrap the existing handler in a sliding-window limiter.",
      "## Milestones",
      "1. Add the limiter at the payout boundary.",
      "2. Cover allowed and rejected requests.",
      "## Dependencies",
      "- The existing payout handler remains the request boundary.",
      "## Risks",
      "- Shared state may leak across tenants; key the limiter by tenant.",
      "## Proof",
      "- c1 — run the payout endpoint checks and capture their passing output.",
    ].join("\n"),
  });

  const run = (argv: string[], runner: Runner, now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now,
      agentRunner: runner,
    });
  };

  /** A planner that concludes with a well-formed plan. */
  const planningAgent: Runner = async (_file, args, options) => {
    plannerArgv.push([...args]);
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    const name = PLAN_FILE.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") {
      await writeFile(
        join(cwd, name),
        JSON.stringify(validPlanPayload()),
      );
    }
    return { ...OK, stdout: SAID };
  };

  /** A planner that needs the operator first. */
  const askingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    const name = PARK_FILE.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") {
      await writeFile(
        join(cwd, name),
        JSON.stringify({
          urgency: "blocking",
          recap: "Two rate-limiter shapes fit.",
          question: "Per-user or per-tenant?",
          options: [
            { id: "user", label: "Per-user", consequence: "Fairer, more state.", reversible: true },
            { id: "tenant", label: "Per-tenant", consequence: "Simpler, coarser.", reversible: true },
          ],
          recommendation: "user",
        }),
      );
    }
    return { ...OK, stdout: SAID };
  };

  /** A planner that edits the repo — the one thing it must never do. */
  const vandalAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    const park = PARK_FILE.exec(prompt)?.[0];
    if (cwd !== "") {
      await writeFile(join(cwd, "sneaky.ts"), "export const smuggled = true;\n");
      if (park !== undefined) {
        await writeFile(
          join(cwd, park),
          JSON.stringify({
            urgency: "blocking",
            recap: "r",
            question: "q?",
            options: [
              { id: "a", label: "a", consequence: "c", reversible: true },
              { id: "b", label: "b", consequence: "c", reversible: true },
            ],
            recommendation: "a",
          }),
        );
      }
    }
    return { ...OK, stdout: SAID };
  };

  /** The builder for the final leg: writes real work, concludes done. */
  const buildingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (cwd !== "") {
      await writeFile(join(cwd, "limiter.ts"), "export const limited = true;\n");
      if (done !== undefined) {
        await writeFile(
          join(cwd, done),
          JSON.stringify({ version: 1, status: "completed", conclusion: "Limiter in place." }),
        );
      }
    }
    return { ...OK, stdout: SAID };
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-plan-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    prompts = [];
    plannerArgv = [];
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const setup = async () => {
    // CLI runner register is now a password ceremony (MCP spec v6) — the
    // fixture mints at store level below with a fixed token instead.
    const runnerToken = "tok-builder-1";
    // The runner gate (MCP spec v6): authority derives from the runner's
    // REGISTERED repos, not the --repo flag — bind this repo to the same
    // name and token the CLI just minted.
    {
      const store = openStore(db);
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => runnerToken });
      // v47: every phase names an exact model — the planner included.
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0);
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
      store.close();
    }
    await run(["approver", "add", "alex", "--json"], planningAgent);
    const approverToken = payload().token as string;
    await run(["task", "add", "rate limiter", "--id", "limiter", "--repo", repo, "--json"], planningAgent);
    return { runnerToken, approverToken };
  };

  const tick = (runnerToken: string, agent: Runner, now = T0) =>
    run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      agent,
      now,
    );

  test("unreadable skill context settles a failed attempt without provider spend", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    const failure = vi.spyOn(projectSkills, "skillsContext").mockImplementationOnce(() => { throw Error("Saved skill package failed verification."); });
    try {
      await tick(runnerToken, planningAgent);
      expect(prompts).toHaveLength(0);
      const saved = openStore(db);
      try {
        const ref = saved.refFor("built-in", "limiter");
        const run = saved.runsFor(ref.id)[0];
        expect(run).toMatchObject({ outcome: "failed", reason: "Project skills could not be loaded: Saved skill package failed verification.", providerStartedAt: null });
        expect(run?.finishedAt).not.toBeNull();
        expect(currentClaim(saved, ref.id, T0)).toBeNull();
      } finally { saved.close(); }
    } finally { failure.mockRestore(); }
  });

  test("the whole negotiation: ask, answer, draft, approve, build — in that order, never earlier", async () => {
    const { runnerToken, approverToken } = await setup();

    // A prior accepted review supplies plan-only advice. The new task still
    // has no scope: exercise the real requested-planner prompt before approval.
    const seeded = openStore(db);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const evidenceRoot = join(base, "evidence");
    seeded.createTask({ id: "lesson-source", title: "Document the boundary" }, T0);
    const sourceRef = seeded.refFor("built-in", "lesson-source").id;
    seeded.placeTask(sourceRef, repo);
    const source = seeded.startRun({taskRef:sourceRef,leaseId:"lesson-source",runner:"builder-1",role:"builder",branch:"fixture",worktree:repo,provider:"claude",model:"sonnet",now:T0,route:{routeDigest:"legacy",phase:"build",provider:"claude",model:"sonnet",chosen:"legacy"}});
    seeded.stampRun(source,{baseRevision:head});
    const artifact = storeEvidence(seeded,evidenceRoot,source,"terminal-diff","diff.patch",Buffer.from("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n+hello\n"),"fixture",T0,{captureStatus:"ok"});
    seeded.finishRun(source,{outcome:"built",now:T0});
    seeded.handle.prepare("UPDATE task SET state='done' WHERE id='lesson-source'").run();
    const askedReview = seeded.requestReview(source,"alex",T0);
    if (!askedReview.ok) throw Error(askedReview.reason);
    const admitted = seeded.admitReview(askedReview.id,{runner:"builder-1",token:runnerToken,provider:"claude",model:"sonnet"},T0);
    if (!admitted.ok) throw Error(admitted.reason);
    learningContext(seeded,evidenceRoot,admitted.reviewerRunId,"review",T0);
    seeded.stampProviderStart(admitted.reviewerRunId,T0);
    const diffSha = seeded.getArtifact(artifact)!.sha256;
    seeded.ingestReview({reviewerRunId:admitted.reviewerRunId,runId:source,evidenceRoot,artifactId:artifact,author:"reviewer:claude",comments:[],judgements:[],learning:[{kind:"project",observation:"The readme identifies the project boundary.",action:"Read the project boundary before drafting a plan.",paths:["README.md"],phases:["plan"],evidence:[{artifactId:artifact,sha256:diffSha,excerpt:"+hello"}]}],bindings:{diffSha,scopeDigest:null,headSha:head,proof:null,checkLog:null,screenshots:[]}},T0);
    let learning = learningView(seeded,evidenceRoot,repo,"alex");
    const lesson = learning.lessons[0]!;
    changeLearning(seeded,evidenceRoot,{repo,actor:"alex",identity:learning.identity,revision:learning.revision,action:"adopt",lesson:lesson.id,version:lesson.version,sha:lesson.sha},T0);
    learning = learningView(seeded,evidenceRoot,repo,"alex");
    changeLearning(seeded,evidenceRoot,{repo,actor:"alex",identity:learning.identity,revision:learning.revision,action:"enable"},T0);
    expect(seeded.getScope("limiter")).toBeNull();
    seeded.close();

    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    expect(payload().ok).toBe(true);

    // Round one: the planner asks. The question lands as a decision; no
    // scope exists; nothing built.
    const asked = await tick(runnerToken, askingAgent);
    expect(asked).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "parked" }));

    const store = openStore(db);

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const decision = store.listDecisions("unanswered")[0];
    expect(decision).toBeDefined();
    expect(decision?.question).toBe("Per-user or per-tenant?");
    store.close();

    // The operator answers from wherever they are.
    await run(
      ["decide", String(decision?.id), "--choose", "user", "--as", "alex", "--token", approverToken, "--json"],
      planningAgent,
      new Date(T0.getTime() + 60_000),
    );

    // Round two: the planner is redispatched with the answer in its brief
    // and concludes with a plan. The scope lands PROPOSED, never approved.
    const planned = await tick(runnerToken, planningAgent, new Date(T0.getTime() + 2 * 60_000));
    expect(planned).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "planned" }));
    expect(prompts.some(one => one.includes("Per-user or per-tenant?") && one.includes("user"))).toBe(true);
    expect(
      prompts.some(one =>
        one.includes("Each id is capped at 40 UTF-8 bytes, each statement at 1000,") &&
        one.includes("each non-null how at 500") &&
        one.includes("Validate those byte limits"),
      ),
    ).toBe(true);
    expect(plannerArgv.some(args => args[args.indexOf("--permission-mode") + 1] === "acceptEdits")).toBe(true);

    const after = openStore(db);
    const scope = after.getScope("limiter");
    expect(scope?.goal).toBe("Guard the payout endpoint with a rate limiter");
    expect(scope?.approvedAt).toBeNull();
    const ref = after.refFor("built-in", "limiter");
    expect(ref.plan).toBe("drafted");
    expect(after.latestPlanArtifact(ref.id)).not.toBeNull();
    after.close();

    // A pass before approval spends nothing: the promise is not made, and
    // a pass with nothing dispatchable says so with its refusal exit.
    const premature = await tick(runnerToken, buildingAgent, new Date(T0.getTime() + 3 * 60_000));
    expect(premature).toBe(EXIT.refused);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "skipped", reason: "unapproved" }));

    // The operator approves exactly the drafted scope.
    const approving = openStore(db);
    const digest = approving.getScope("limiter")?.digest as string;
    approving.close();
    await run(
      ["task", "approve", "limiter", "--as", "alex", "--token", approverToken, "--digest", digest, "--yes", "--json"],
      planningAgent,
      new Date(T0.getTime() + 4 * 60_000),
    );
    expect(payload().ok).toBe(true);

    // And only now a builder runs — with the plan quoted in its brief.
    const built = await tick(runnerToken, buildingAgent, new Date(T0.getTime() + 5 * 60_000));
    expect(built).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "built" }));
    expect(prompts.some(one => one.includes("BEGIN APPROVED PLAN") && one.includes("sliding-window limiter"))).toBe(true);

    // The builder's branch is its own — the planner's disposable branch is
    // not an ancestor and the smoke-test file never existed there.
    const log = await git(["log", "--oneline", "toolroll/limiter"]);
    expect(log.stdout).toContain("limiter");

    // Route provenance (v47): every phase's run names the route it spent
    // under and the actual provider and model — the planner, which ran
    // before any scope existed, under the bare word `legacy` for the exact
    // pair the live recommendation resolved (final authority closure: a
    // task with no scope holds no filed route to spend as a routed leg),
    // the builder under the sealed route the approval copied.
    const proved = openStore(db);
    const provedRef = proved.refFor("built-in", "limiter");
    const runs = proved.runsFor(provedRef.id);
    const plannerRuns = runs.filter(one => one.role === "planner");
    expect(plannerRuns.length).toBeGreaterThan(0);
    for (const plannerRun of plannerRuns) {
      expect(proved.runRoute(plannerRun.id)).toMatchObject({ phase: "plan", provider: "claude", chosen: "legacy", routeDigest: "legacy" });
    }
    const builderRun = runs.find(one => one.role === "builder")!;
    expect(proved.runRoute(builderRun.id)).toMatchObject({ phase: "build", provider: "claude", model: "sonnet", chosen: "recommended", routeDigest: routeDigestOf(proved.approvedRouteOf("limiter")!) });
    // Actual unscoped planner prompts contain the exact adopted advice. Build
    // remains approval-gated and excludes the plan-only lesson.
    for (const one of [...plannerRuns, builderRun]) {
      const frozen = proved.handle.prepare("SELECT payload FROM learning_snapshot WHERE run=?").get(one.id)?.["payload"];
      expect(typeof frozen).toBe("string");
      expect(prompts.some(prompt => prompt.includes(String(frozen)))).toBe(true);
      const supplied = JSON.parse(String(frozen).trim().split("\n").at(-1)!);
      if (one.role === "planner") {
        expect(supplied.scopeDigest).toBe("");
        expect(supplied.lessons).toMatchObject([{id:lesson.id,phases:["plan"]}]);
      } else expect(supplied.lessons).toEqual([]);
    }
    proved.close();
  });

  test("the planner's claim re-proves the strict scope projection (final authority closure): a filed scope whose risk the route was not recommended for is skipped in words before any claim — no run, no lease, no provider — and the restored scope plans", async () => {
    const { runnerToken, approverToken } = await setup();
    // A scope filed (unapproved) — the planner would run under its WORKING route.
    {
      const store = openStore(db);
      propose(store, { taskId: "limiter", goal: "a sliding-window limiter", acceptance: [{ id: "c1", statement: "limits", how: null, evidence: ["check"] }], now: T0 });
      store.close();
    }
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    expect(payload().ok).toBe(true);
    // The reproduction: the row's risk is rewritten under the route that
    // was recommended for routine risk.
    {
      const store = openStore(db);
      store.raw().prepare("UPDATE task_scope SET risk_level = 'high' WHERE task_id = 'limiter'").run();
      store.close();
    }
    let spawned = false;
    const neverSpawns: Runner = async () => {
      spawned = true;
      throw new Error("nothing spawns on a scope that does not prove");
    };
    expect(await tick(runnerToken, neverSpawns)).toBe(EXIT.refused);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "skipped", reason: "agent-config", detail: expect.stringMatching(/holds no plan authority \(the route was recommended for routine risk but the scope's risk level is high\)/) }));
    expect(spawned).toBe(false);
    {
      const store = openStore(db);
      const ref = store.refFor("built-in", "limiter");
      expect(store.runsFor(ref.id)).toHaveLength(0);
      expect(store.currentLiveLease(ref.id, T0)).toBeNull();
      expect(store.raw().prepare("SELECT COUNT(*) AS n FROM claim").get()).toEqual({ n: 0 });
      // Restored, the planner runs under the working route it proves.
      store.raw().prepare("UPDATE task_scope SET risk_level = 'routine' WHERE task_id = 'limiter'").run();
      store.close();
    }
    expect(await tick(runnerToken, askingAgent)).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "parked" }));
    const store = openStore(db);
    const planner = store.runsFor(store.refFor("built-in", "limiter").id).find(one => one.role === "planner")!;
    expect(store.runRoute(planner.id)).toMatchObject({ phase: "plan", provider: "claude", model: "sonnet", chosen: "recommended" });
    store.close();
  });

  test("pass flags cannot reroute the planner (v47): a flag that contradicts the task's plan leg is refused in words; one that restates it runs; a plan pin needs an exact model", async () => {
    const { runnerToken, approverToken } = await setup();
    // A plan pin with no model binds nothing exact.
    expect(await run(["task", "plan", "limiter", "--provider", "codex", "--as", "alex", "--token", approverToken, "--json"], planningAgent)).toBe(EXIT.usage);
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    expect(payload().ok).toBe(true);
    // The pass names another model for the planner: refused, nothing spends.
    const contradicted = await run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--plan-model", "opus", "--json"],
      askingAgent,
    );
    expect(contradicted).toBe(EXIT.refused);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "skipped", reason: "agent-config" }));
    expect(String(payload().dispatched[0]?.detail)).toContain("flags cannot reroute a task");
    {
      const store = openStore(db);
      expect(store.runsFor(store.refFor("built-in", "limiter").id)).toHaveLength(0);
      store.close();
    }
    // A flag that restates the leg exactly is fine, and the planner run
    // names its route: the exact pair the live recommendation resolved,
    // presented as the bare word `legacy` — a task with no scope holds no
    // filed route (final authority closure).
    const restated = await run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--plan-provider", "claude", "--plan-model", "sonnet", "--json"],
      askingAgent,
    );
    expect(restated).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "parked" }));
    const store = openStore(db);
    const planner = store.runsFor(store.refFor("built-in", "limiter").id).find(one => one.role === "planner")!;
    expect(planner).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(store.runRoute(planner.id)).toMatchObject({ phase: "plan", provider: "claude", model: "sonnet", chosen: "legacy", routeDigest: "legacy" });
    store.close();
  });

  test("a planner that touches the tree gets nothing ingested — question included", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);

    const failed = await tick(runnerToken, vandalAgent);
    expect(failed).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "dirty-tree" }),
    );

    const store = openStore(db);

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    // No decision was ingested from the dirty workspace.
    expect(store.listDecisions("unanswered")).toHaveLength(0);
    // The failure took a PLANNING strike and left a backoff hold — never a
    // builder strike.
    const ref = store.refFor("built-in", "limiter");
    expect(ref.planStrikes).toBe(1);
    expect(ref.strikes).toBe(0);
    expect(ref.plan).toBe("requested");
    store.close();
  });

  test("a Claude planner gets the plan contract as --json-schema, its plan correction does too, and the repair names the path", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    const seen: string[][] = [];
    const prompts: string[] = [];
    const agent: Runner = async (_file, args, options) => {
      seen.push([...args]);
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      prompts.push(prompt);
      const name = PLAN_FILE.exec(prompt)?.[0];
      const cwd = options?.cwd ?? "";
      if (name !== undefined && cwd !== "") {
        const body = seen.length === 1 ? { version: 1, ...validPlanPayload(), plan: "not a sectioned plan", amendment: "a".repeat(1_001) } : { version: 1, ...validPlanPayload() };
        await writeFile(join(cwd, name), JSON.stringify(body));
      }
      return { ...OK, stdout: saidInSession("schema-session") };
    };
    expect(await tick(runnerToken, agent)).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "planned" }));
    expect(seen).toHaveLength(2);
    for (const args of seen) expect(args[args.indexOf("--json-schema") + 1]).toBe(JSON.stringify(PLAN_MODEL_SCHEMA));
    expect(prompts[1]).toContain("The validation problems, each naming its path:\n- amendment: over 1,000 characters\n- plan: plan must start with ## Approach");
  });

  test("Claude's structured output is the plan when no plan file was written", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    const agent: Runner = async () => ({ ...OK, stdout: JSON.stringify({ result: "planning", session_id: "structured-session", structured_output: { version: 1, ...validPlanPayload() } }) });
    expect(await tick(runnerToken, agent)).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "planned" }));
    const store = openStore(db);
    expect(store.getScope("limiter")).toMatchObject({ goal: validPlanPayload().goal, touches: validPlanPayload().touches, approvedAt: null });
    store.close();
  });

  test("a question still comes through the mailbox: the structured output beside it is discarded unread", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    const agent: Runner = async (file, args, options) => {
      await askingAgent(file, args, options);
      return { ...OK, stdout: JSON.stringify({ result: "planning", session_id: "asking-session", structured_output: { version: 1, ...validPlanPayload() } }) };
    };
    expect(await tick(runnerToken, agent)).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "parked" }));
    const store = openStore(db);
    expect(store.listDecisions("unanswered")[0]?.question).toBe("Per-user or per-tenant?");
    expect(store.getScope("limiter")).toBeNull();
    store.close();
  });

  test("a planner on a harness without --json-schema reads the schema in its brief and is not given the flag", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    const store = openStore(db);
    store.setPhaseConfig("installation", "plan", "codex", "gpt-5.5", "test", T0);
    store.close();
    const seen: string[][] = [];
    const agent: Runner = async (_file, args, options) => {
      seen.push([...args]);
      const prompt = args.join("\n");
      const name = PLAN_FILE.exec(prompt)?.[0];
      const cwd = options?.cwd ?? "";
      if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), JSON.stringify(validPlanPayload()));
      return { ...OK, stdout: SAID };
    };
    await tick(runnerToken, agent);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.flat()).not.toContain("--json-schema");
    expect(seen.flat().join("\n")).toContain(JSON.stringify(PLAN_MODEL_SCHEMA));
  });

  test("a malformed plan is corrected in the same session with frozen authority and a truthful child run", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);

    let calls = 0;
    const seen: { args: string[]; timeoutMs: number | undefined }[] = [];
    const repairingAgent: Runner = async (_file, args, options) => {
      calls += 1;
      seen.push({ args: [...args], timeoutMs: options?.timeoutMs });
      const cwd = options?.cwd ?? "";
      options?.onSpawn?.(1_000_000 + calls);
      // The note may also carry this host's boot identity (v53).
      expect(readFileSync(join(cwd, ".standing-orders-lease"), "utf8")).toMatch(new RegExp(`^${1_000_000 + calls} builder-1 group ([0-9a-f-]{36}|unknown) \\S+\\n$`));
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        if (calls === 1) {
          await writeFile(join(cwd, name), JSON.stringify({ ...validPlanPayload(), plan: "not a sectioned plan" }));
        } else {
          expect(prompt).toContain('"reason": "plan-preamble"');
          expect(prompt).toContain("goal, outOfScope, touches, and acceptance values are");
          await writeFile(join(cwd, name), JSON.stringify(validPlanPayload()));
        }
      }
      return { ...OK, stdout: saidInSession("planner-session-1") };
    };

    const planned = await tick(runnerToken, repairingAgent);
    expect(planned).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "planned" }));
    expect(calls).toBe(2);
    expect(seen[0]?.args).not.toContain("--resume");
    expect(seen[1]?.args).toEqual(
      expect.arrayContaining(["--resume", "planner-session-1", "--max-turns", "4"]),
    );
    expect(seen[1]?.timeoutMs).toBe(5 * 60_000);

    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ role: "planner", outcome: "built", reason: "plan-drafted", sessionId: "planner-session-1" });
    expect(runs[1]).toMatchObject({
      role: "planner",
      parentRun: runs[0]?.id,
      outcome: "no-change",
      reason: "structured planner output repaired",
      sessionId: "planner-session-1",
    });
    expect(runs[1]?.baseRevision).toBe(runs[0]?.baseRevision);
    const initialEvidence = store.artifactsFor(runs[0]?.id ?? -1).filter(one => one.kind === "structured-output");
    const repairEvidence = store.artifactsFor(runs[1]?.id ?? -1).filter(one => one.kind === "structured-output");
    expect(initialEvidence).toHaveLength(1);
    expect(initialEvidence[0]?.capture).toContain("not accepted");
    expect(repairEvidence).toHaveLength(1);
    expect(repairEvidence[0]?.capture).toContain("accepted");
    expect(store.getScope("limiter")).toMatchObject({
      goal: validPlanPayload().goal,
      outOfScope: validPlanPayload().outOfScope,
      touches: validPlanPayload().touches,
    });
    store.close();
  });

  test("two malformed corrections exhaust the fixed bound and form one linear causal trail", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);

    let calls = 0;
    const prompts: string[] = [];
    const brokenAgent: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      prompts.push(prompt);
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        const body = validPlanPayload();
        await writeFile(
          join(cwd, name),
          JSON.stringify({
            ...body,
            plan: calls === 1 ? "not a sectioned plan" : "## Approach\nStill missing the required sections.",
          }),
        );
      }
      if (calls > 1) {
        expect(args).toEqual(expect.arrayContaining(["--max-turns", "4"]));
        expect(options?.timeoutMs).toBe(5 * 60_000);
      }
      return { ...OK, stdout: saidInSession("broken-session-1") };
    };

    const failed = await tick(runnerToken, brokenAgent);
    expect(failed).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    expect(calls).toBe(3);
    expect(prompts[1]).toContain('"reason": "plan-preamble"');
    expect(prompts[2]).toContain('"reason": "plan-missing-milestones"');

    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs).toHaveLength(3);
    expect(runs.map(one => one.parentRun)).toEqual([null, runs[0]?.id, runs[1]?.id]);
    expect(runs.map(one => one.outcome)).toEqual(["failed", "failed", "failed"]);
    expect(runs.map(one => store.artifactsFor(one.id).filter(artifact => artifact.kind === "structured-output").length)).toEqual([1, 1, 1]);
    store.close();
  });

  test("a correction that emits no bytes stops instead of spending a second repair turn", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const silentCorrection: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (calls === 1 && name !== undefined && cwd !== "") {
        await writeFile(join(cwd, name), JSON.stringify({ ...validPlanPayload(), plan: "not a sectioned plan" }));
      }
      return { ...OK, stdout: saidInSession("silent-repair-session") };
    };

    expect(await tick(runnerToken, silentCorrection)).toBe(EXIT.failed);
    expect(calls).toBe(2);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    const store = openStore(db);
    const runs = store.runsFor(store.refFor("built-in", "limiter").id).filter(one => one.role === "planner");
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ outcome: "failed", reason: "malformed-plan" });
    store.close();
  });

  test("repair cannot rewrite a parseable plan's authority fields", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const authorityProbe: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (calls === 3) expect(prompt).toContain('"reason": "authority-changed"');
      if (name !== undefined && cwd !== "") {
        const body = validPlanPayload();
        await writeFile(
          join(cwd, name),
          JSON.stringify(
            calls === 1
              ? { ...body, plan: "bad plan shape" }
              : calls === 2
                ? { ...body, goal: "A broader replacement goal" }
                : body,
          ),
        );
      }
      return { ...OK, stdout: saidInSession("authority-session-1") };
    };

    expect(await tick(runnerToken, authorityProbe)).toBe(EXIT.ok);
    expect(calls).toBe(3);
    const store = openStore(db);
    expect(store.getScope("limiter")?.goal).toBe(validPlanPayload().goal);
    const runs = store.runsFor(store.refFor("built-in", "limiter").id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs.map(one => one.parentRun)).toEqual([null, runs[0]?.id, runs[1]?.id]);
    expect(runs[1]).toMatchObject({ outcome: "failed", reason: "malformed-plan" });
    expect(runs[2]).toMatchObject({ outcome: "no-change", reason: "structured planner output repaired" });
    store.close();
  });

  test("planner-handoff: a correction that does not re-announce the exact session is rejected, its payload sealed — and the retry, after the planning backoff, is a FRESH root in a fresh session, never a second resume of the doomed identity", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const resumeFlags: string[] = [];
    const switchedSession: Runner = async (_file, args, options) => {
      calls += 1;
      resumeFlags.push(args.includes("--resume") ? String(args[args.indexOf("--resume") + 1]) : "fresh");
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(
          join(cwd, name),
          JSON.stringify(calls === 1 ? { ...validPlanPayload(), plan: "not a sectioned plan" } : validPlanPayload()),
        );
      }
      // Turn 1 plans in the original session; turn 2 RESUMES it but the
      // harness answers as a different session (a fork — protocol broken);
      // turn 3 is the next attempt's own fresh root.
      return { ...OK, stdout: calls === 1 ? saidInSession("original-session") : calls === 2 ? SAID : saidInSession("fresh-session") };
    };

    expect(await tick(runnerToken, switchedSession)).toBe(EXIT.failed);
    expect(calls).toBe(2);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "provider-protocol" }),
    );
    let store = openStore(db);
    let runs = store.runsFor(store.refFor("built-in", "limiter").id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs[1]).toMatchObject({ role: "planner", outcome: "refused", reason: "provider-protocol", sessionId: "original-session" });
    const rejected = store.artifactsFor(runs[1]?.id ?? -1).filter(one => one.kind === "structured-output");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.capture).toContain("not accepted");
    expect(store.getScope("limiter")).toBeNull();
    store.close();

    // The doomed identity is NOT resumed again: the planning backoff holds
    // the task for a minute, then the next pass opens a fresh root that
    // starts its own session and ingests the plan.
    expect(await tick(runnerToken, switchedSession)).toBe(EXIT.refused);
    expect(calls).toBe(2); // held: nothing dispatched inside the backoff
    expect(await tick(runnerToken, switchedSession, new Date(T0.getTime() + 61_000))).toBe(EXIT.ok);
    expect(calls).toBe(3);
    expect(resumeFlags).toEqual(["fresh", "original-session", "fresh"]);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "planned" }));
    store = openStore(db);
    runs = store.runsFor(store.refFor("built-in", "limiter").id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs).toHaveLength(3);
    expect(runs[2]).toMatchObject({ parentRun: null, outcome: "built", reason: "plan-drafted", sessionId: "fresh-session" });
    expect(store.getScope("limiter")?.goal).toBe(validPlanPayload().goal);
    store.close();
  });

  test("planner-handoff: a resume the harness never initializes for (an argv it rejects, exit 2, no thread echoed) ends the attempt as provider-protocol — the recorded identity unconfirmed — and the retry is a fresh root", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const resumeFlags: string[] = [];
    const rejectedResume: Runner = async (_file, args, options) => {
      calls += 1;
      resumeFlags.push(args.includes("--resume") ? String(args[args.indexOf("--resume") + 1]) : "fresh");
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (calls === 2) {
        // The harness exits 2 before initializing — no init, nothing said.
        return { ...OK, code: 2, stdout: "", stderr: "error: unexpected argument '--sandbox' found" };
      }
      if (name !== undefined && cwd !== "") {
        await writeFile(
          join(cwd, name),
          JSON.stringify(calls === 1 ? { ...validPlanPayload(), plan: "not a sectioned plan" } : validPlanPayload()),
        );
      }
      return { ...OK, stdout: calls === 1 ? saidInSession("original-session") : saidInSession("fresh-session") };
    };

    expect(await tick(runnerToken, rejectedResume)).toBe(EXIT.failed);
    expect(calls).toBe(2);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "failed", reason: "provider-protocol" }));
    let store = openStore(db);
    let runs = store.runsFor(store.refFor("built-in", "limiter").id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs[1]).toMatchObject({ outcome: "refused", reason: "provider-protocol", sessionId: "original-session" });
    expect(store.getScope("limiter")).toBeNull();
    store.close();
    expect(await tick(runnerToken, rejectedResume, new Date(T0.getTime() + 61_000))).toBe(EXIT.ok);
    expect(calls).toBe(3);
    expect(resumeFlags).toEqual(["fresh", "original-session", "fresh"]);
    store = openStore(db);
    runs = store.runsFor(store.refFor("built-in", "limiter").id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs[2]).toMatchObject({ parentRun: null, outcome: "built", reason: "plan-drafted", sessionId: "fresh-session" });
    expect(store.getScope("limiter")?.goal).toBe(validPlanPayload().goal);
    store.close();
  });

  test("a malformed planner reply without a session id does not start a fresh correction", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const noSession: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(join(cwd, name), JSON.stringify({ ...validPlanPayload(), plan: "not a sectioned plan" }));
      }
      return { ...OK, stdout: SAID };
    };

    expect(await tick(runnerToken, noSession)).toBe(EXIT.failed);
    expect(calls).toBe(1);
    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    expect(store.runsFor(ref.id).filter(one => one.parentRun !== null)).toHaveLength(0);
    expect(store.artifactsFor(store.runsFor(ref.id)[0]?.id ?? -1).filter(one => one.kind === "structured-output")).toHaveLength(1);
    store.close();
  });

  test("an unparseable plan is preserved but never reconstructed as a formatting correction", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const unparseable: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), "{ definitely not JSON");
      return { ...OK, stdout: saidInSession("unparseable-session") };
    };

    expect(await tick(runnerToken, unparseable)).toBe(EXIT.failed);
    expect(calls).toBe(1);
    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id);
    expect(runs.filter(one => one.parentRun !== null)).toHaveLength(0);
    expect(store.artifactsFor(runs[0]?.id ?? -1).filter(one => one.kind === "structured-output")).toHaveLength(1);
    store.close();
  });

  test.each([
    ["an invalid goal", (body: ReturnType<typeof validPlanPayload>) => ({ ...body, goal: 42 })],
    ["an empty acceptance rubric", (body: ReturnType<typeof validPlanPayload>) => ({ ...body, acceptance: [] })],
  ])("%s is authority failure and never enters structured repair", async (_label, malformed) => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const invalidAuthority: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(join(cwd, name), JSON.stringify(malformed(validPlanPayload())));
      }
      return { ...OK, stdout: saidInSession("invalid-authority-session") };
    };

    expect(await tick(runnerToken, invalidAuthority)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    expect(calls).toBe(1);
    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id).filter(one => one.role === "planner");
    expect(runs).toHaveLength(1);
    expect(store.artifactsFor(runs[0]?.id ?? -1).filter(one => one.kind === "structured-output")).toHaveLength(1);
    expect(store.getScope("limiter")).toBeNull();
    store.close();
  });

  test("pathologically deep authority is a typed malformed plan, never a planner crash", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const hostileShape: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        // This remains under the mailbox byte cap, but recursive authority
        // canonicalization would overflow the JS stack without its boundary.
        const nested = `${"[".repeat(20_000)}0${"]".repeat(20_000)}`;
        await writeFile(
          join(cwd, name),
          `{"goal":${nested},"outOfScope":null,"touches":[],"acceptance":[],"plan":"bad"}`,
        );
      }
      return { ...OK, stdout: saidInSession("deep-authority-session") };
    };

    expect(await tick(runnerToken, hostileShape)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    expect(calls).toBe(1);
    const store = openStore(db);
    const runs = store.runsFor(store.refFor("built-in", "limiter").id);
    expect(runs.filter(one => one.parentRun !== null)).toHaveLength(0);
    expect(store.artifactsFor(runs[0]?.id ?? -1).filter(one => one.kind === "structured-output")).toHaveLength(1);
    store.close();
  });

  test("invalid UTF-8 is preserved as evidence and is never repaired as invented text", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const invalidUtf8: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
      return { ...OK, stdout: saidInSession("invalid-utf8-session") };
    };

    expect(await tick(runnerToken, invalidUtf8)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    expect(calls).toBe(1);
    const store = openStore(db);
    const runs = store.runsFor(store.refFor("built-in", "limiter").id);
    expect(runs.filter(one => one.parentRun !== null)).toHaveLength(0);
    expect(store.artifactsFor(runs[0]?.id ?? -1).find(one => one.kind === "structured-output")).toMatchObject({
      bytesOriginal: 5,
      bytesStored: 5,
      captureStatus: "failed",
    });
    store.close();
  });

  test("a non-file decision path fails closed without asking the session to invent a question", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const nonFileDecision: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PARK_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") await mkdir(join(cwd, name));
      return { ...OK, stdout: saidInSession("non-file-decision-session") };
    };

    expect(await tick(runnerToken, nonFileDecision)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-decision" }),
    );
    expect(calls).toBe(1);
    const store = openStore(db);
    const runs = store.runsFor(store.refFor("built-in", "limiter").id);
    expect(runs.filter(one => one.parentRun !== null)).toHaveLength(0);
    expect(store.artifactsFor(runs[0]?.id ?? -1).filter(one => one.kind === "structured-output")).toHaveLength(0);
    store.close();
  });

  test("an oversized plan keeps a bounded evidence prefix and its true byte count", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    const bytes = 64 * 1024 + 137;
    const oversized: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), "x".repeat(bytes));
      return { ...OK, stdout: saidInSession("oversized-session") };
    };

    expect(await tick(runnerToken, oversized)).toBe(EXIT.failed);
    const store = openStore(db);
    const plannerRun = store.runsFor(store.refFor("built-in", "limiter").id)[0];
    const attempt = store.artifactsFor(plannerRun?.id ?? -1).find(one => one.kind === "structured-output");
    expect(attempt).toMatchObject({ bytesOriginal: bytes, bytesStored: 64 * 1024, truncated: true, captureStatus: "failed" });
    store.close();
  });

  test("a whole-payload JSON fence is normalized without spending a correction turn", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const fenced: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(join(cwd, name), `\uFEFF\`\`\`json\n${JSON.stringify(validPlanPayload())}\n\`\`\``);
      }
      return { ...OK, stdout: SAID };
    };

    expect(await tick(runnerToken, fenced)).toBe(EXIT.ok);
    expect(calls).toBe(1);
    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id);
    expect(runs.filter(one => one.parentRun !== null)).toHaveLength(0);
    const structured = store.artifactsFor(runs.find(one => one.role === "planner")?.id ?? -1).filter(one => one.kind === "structured-output");
    expect(structured).toHaveLength(1);
    expect(structured[0]?.capture).toContain("accepted, syntax normalized");
    store.close();
  });

  test("a malformed decision repairs in-session and links a canonical parent payload", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const decision = {
      urgency: "blocking",
      recap: "The repository supports two safe limiter keys.",
      question: "Which key should the limiter use?",
      options: [
        { id: "user", label: "Per user", consequence: "Finer fairness.", reversible: true },
        { id: "tenant", label: "Per tenant", consequence: "Less state.", reversible: true },
      ],
      recommendation: "user",
    };
    const agentWithRepair: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PARK_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(
          join(cwd, name),
          JSON.stringify(calls === 1 ? { ...decision, options: decision.options.slice(0, 1) } : decision),
        );
      }
      return { ...OK, stdout: saidInSession("decision-session-1") };
    };

    expect(await tick(runnerToken, agentWithRepair)).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "limiter", outcome: "parked" }));
    expect(calls).toBe(2);
    const store = openStore(db);
    const ref = store.refFor("built-in", "limiter");
    const runs = store.runsFor(ref.id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
    expect(runs[1]).toMatchObject({
      role: "planner",
      parentRun: runs[0]?.id,
      outcome: "no-change",
      reason: "structured planner output repaired",
    });
    const parentPayload = store.artifactsFor(runs[0]?.id ?? -1).find(one => one.kind === "park-payload");
    expect(parentPayload?.capture).toContain(`canonical validated planner decision repaired by run ${runs[1]?.id}`);
    expect(store.artifactsFor(runs[1]?.id ?? -1).filter(one => one.kind === "park-payload")).toHaveLength(0);
    expect(store.listDecisions("unanswered")[0]?.question).toBe(decision.question);
    store.close();
  });

  test("writing both a question and a plan is malformed instead of silently prioritizing either", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);
    let calls = 0;
    const both: Runner = async (_file, args, options) => {
      calls += 1;
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const planName = PLAN_FILE.exec(prompt)?.[0];
      const parkName = PARK_FILE.exec(prompt)?.[0];
      if (cwd !== "" && planName !== undefined && parkName !== undefined) {
        await writeFile(join(cwd, planName), JSON.stringify(validPlanPayload()));
        await writeFile(
          join(cwd, parkName),
          JSON.stringify({
            urgency: "blocking",
            recap: "There is a choice.",
            question: "Proceed?",
            options: [
              { id: "yes", label: "Yes", consequence: "Continue.", reversible: true },
              { id: "no", label: "No", consequence: "Stop.", reversible: true },
            ],
            recommendation: "yes",
          }),
        );
      }
      return { ...OK, stdout: saidInSession("ambiguous-session") };
    };

    expect(await tick(runnerToken, both)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(
      expect.objectContaining({ id: "limiter", outcome: "failed", reason: "malformed-plan" }),
    );
    expect(calls).toBe(1);
    const store = openStore(db);
    expect(store.getScope("limiter")).toBeNull();
    expect(store.listDecisions("unanswered")).toHaveLength(0);
    const plannerRun = store.runsFor(store.refFor("built-in", "limiter").id).find(one => one.role === "planner");
    expect(store.artifactsFor(plannerRun?.id ?? -1).find(one => one.kind === "structured-output")?.capture).toContain("not accepted");
    store.close();
  });

  test("a malformed plan is a durable incident, not a silent retry", async () => {
    const { runnerToken, approverToken } = await setup();
    await run(["task", "plan", "limiter", "--as", "alex", "--token", approverToken, "--json"], planningAgent);

    const malformedAgent: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      const name = PLAN_FILE.exec(prompt)?.[0];
      if (name !== undefined && cwd !== "") {
        await writeFile(join(cwd, name), JSON.stringify({ goal: "", plan: 42 }));
      }
      return { ...OK, stdout: SAID };
    };

    const failed = await tick(runnerToken, malformedAgent);
    expect(failed).toBe(EXIT.failed);

    const store = openStore(db);

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const incidents = store.openIncidents();
    expect(incidents.some(one => one.kind === "malformed-plan")).toBe(true);
    // The incident's hold blocks redispatch until a person resolves it —
    // the pass refuses rather than spending on a broken protocol again.
    const again = await tick(runnerToken, planningAgent, new Date(T0.getTime() + 60_000));
    expect(again).toBe(EXIT.refused);
    // The held task never re-enters the ready set — no planner spends on a
    // protocol a person has not looked at.
    const redispatched = (JSON.parse(lines.join("\n")).dispatched ?? []) as { outcome: string }[];
    expect(redispatched.filter(one => one.outcome === "planned" || one.outcome === "parked")).toHaveLength(0);
    store.close();
  });
});

/**
 * Preserve the filed planning contract (contract handoff, task 1): the
 * operator's filed goal, exclusions, touches, rubric, terms, and answers
 * reach the planner whole as quoted data, the drafted plan either
 * reproduces them or states an amendment the approval shows and binds,
 * a source that moved while the planner ran is never overwritten, and
 * corrections and resumes carry the same source identity — with the
 * legacy (no scope), empty, and oversized inputs handled in words.
 */
describe("the filed contract reaches planning and survives it", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  let prompts: string[] = [];
  let server: Server | null = null;

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const payload = () => JSON.parse(lines.join("\n"));

  const rubric: AcceptanceCriterion[] = [
    { id: "c1", statement: "The settings page shows a dark-mode toggle on desktop and phone.", how: "Capture both viewports through the console's screenshot road; the machine reads the PNGs.", evidence: ["screenshot", "check"] },
    { id: "c2", statement: "The chosen theme persists across a reload.", how: null, evidence: ["check"] },
    { id: "c3", statement: "No new runtime dependency is added.", how: "Diff package.json.", evidence: ["changed-path"] },
  ];
  const filed = {
    goal: "Add a dark-mode toggle to the settings page, persisted per account",
    outOfScope: "No theme-engine rewrite; no new dependencies; the STANDING-ORDERS-DONE file format is untouched",
    touches: ["src/settings.ts", "src/theme.css"],
    acceptance: rubric,
  };

  const planDocument = (ids: readonly string[]) =>
    [
      "## Approach",
      "Add the toggle beside the existing settings and persist it with the account preferences.",
      "## Milestones",
      "1. Render the toggle.",
      "2. Persist the choice.",
      "## Dependencies",
      "- None found.",
      "## Risks",
      "- None found.",
      "## Proof",
      ...ids.map(id => `- ${id} — the check or screenshot that proves ${id}.`),
    ].join("\n");

  /** A plan that reproduces the filed terms exactly. */
  const preservingPlan = () => ({ ...filed, plan: planDocument(rubric.map(one => one.id)), amendment: null });

  const run = (argv: string[], runner: Runner, now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: runner });
  };

  /** A planner whose reply is chosen per call, with every prompt kept. */
  const replying = (replies: readonly ((prompt: string, call: number) => { file: "plan" | "park"; body: unknown } | null)[], sessionId: string | null = "planner-session-c"): Runner => {
    let calls = 0;
    return async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      const prompt = String(args[args.indexOf("-p") + 1] ?? "");
      prompts.push(prompt);
      const reply = replies[Math.min(calls, replies.length - 1)]?.(prompt, calls) ?? null;
      calls += 1;
      if (reply !== null && cwd !== "") {
        const name = (reply.file === "plan" ? PLAN_FILE : PARK_FILE).exec(prompt)?.[0];
        if (name !== undefined) await writeFile(join(cwd, name), JSON.stringify(reply.body));
      }
      return { ...OK, stdout: sessionId === null ? SAID : saidInSession(sessionId) };
    };
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-contract-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    prompts = [];
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
  });

  afterEach(async () => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = null;
    await rm(base, { recursive: true, force: true });
  });

  const setup = async (options: { scope?: boolean } = {}) => {
    const runnerToken = "tok-builder-1";
    {
      const store = openStore(db);
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => runnerToken });
      for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
      store.close();
    }
    await run(["approver", "add", "alex", "--json"], replying([]));
    const approverToken = payload().token as string;
    await run(["task", "add", "dark mode", "--id", "dark", "--repo", repo, "--json"], replying([]));
    if (options.scope !== false) {
      const store = openStore(db);
      propose(store, { taskId: "dark", ...filed, qualityMode: "strict", now: T0 });
      store.close();
    }
    await run(["task", "plan", "dark", "--as", "alex", "--token", approverToken, "--json"], replying([]));
    expect(payload().ok).toBe(true);
    return { runnerToken, approverToken };
  };

  const tick = (runnerToken: string, agent: Runner, now = T0) =>
    run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"], agent, now);

  const withStore = <T>(body: (store: ReturnType<typeof openStore>) => T): T => {
    const store = openStore(db);
    try {
      return body(store);
    } finally {
      store.close();
    }
  };

  /** The console over this plane's store and evidence root, logged in. */
  const openConsole = async (approverToken: string, clock: () => Date = () => new Date()) => {
    const store = openStore(db);
    server = createDecisionServer({ store, evidenceRoot: join(base, "evidence"), clock, repo });
    await new Promise<void>(resolve => (server as Server).listen(0, "127.0.0.1", resolve));
    const address = (server as Server).address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const url = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${url}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken }), redirect: "manual" });
    expect(response.status).toBe(303);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const page = async (path: string) => (await fetch(`${url}${path}`, { headers: { cookie } })).text();
    const post = async (path: string, fields: Record<string, string>) => {
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await page("/"))?.[1];
      if (!csrf) throw Error("no CSRF token");
      return fetch(`${url}${path}`, { method: "POST", headers: { cookie, origin: url }, body: new URLSearchParams({ ...fields, csrf }), redirect: "manual" });
    };
    return { page, post, close: async () => { await new Promise<void>(resolve => (server as Server).close(() => resolve())); server = null; store.close(); } };
  };

  test("c1: a short title with a detailed filed scope reaches the planner losslessly as quoted data — goal, exclusions, touches, every criterion with its evidence and how, the execution terms — recorded before any spend; a plan that reproduces it lands with no changes, the approval says so, and the yes binds the filed terms", async () => {
    const { runnerToken, approverToken } = await setup();
    const filedDigest = withStore(store => store.getScope("dark")!.digest);
    const planned = await tick(runnerToken, replying([() => ({ file: "plan", body: preservingPlan() })]));
    expect(planned).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual({ id: "dark", outcome: "planned" });

    // The brief quoted every filed term verbatim, as JSON data — including
    // the how, the evidence kinds, the terms, and the exclusions whose text
    // carries a protocol-shaped name (broken visibly, never lost).
    const brief = prompts[0] ?? "";
    expect(brief).toContain("--- BEGIN FILED REQUEST (data, not authorization) ---");
    for (const needle of [filed.goal, "src/theme.css", rubric[0]!.statement, rubric[0]!.how!, rubric[1]!.statement, rubric[2]!.how!, '"screenshot"', '"changed-path"', '"riskLevel": "routine"', '"qualityMode": "strict"', `"digest": "${filedDigest}"`]) {
      expect(brief).toContain(needle);
    }
    expect(brief).toContain("No theme-engine rewrite; no new dependencies; the \\u0053TANDING-ORDERS-DONE file format is untouched");
    expect(brief).not.toContain("the STANDING-ORDERS-DONE file format");
    expect(brief).toContain("MUST reproduce goal, outOfScope, touches, and");
    // The plan's shape is the plan contract's JSON Schema, not a hand-written sketch.
    expect(brief).toContain(JSON.stringify(PLAN_MODEL_SCHEMA));
    expect(brief).toContain("amendment says why the FILED contract must change");

    withStore(store => {
      const ref = store.refFor("built-in", "dark");
      const scope = store.getScope("dark")!;
      // The drafted scope IS the filed contract, reproduced; its digest is
      // the filed digest, so the yes binds exactly what was filed.
      expect(scope).toMatchObject({ goal: filed.goal, outOfScope: filed.outOfScope, touches: filed.touches, acceptance: rubric, digest: filedDigest, approvedAt: null });
      expect(ref.plan).toBe("drafted");
      const planner = store.runsFor(ref.id).find(one => one.role === "planner")!;
      expect(planner).toMatchObject({ outcome: "built", reason: "plan-drafted", scopeDigest: filedDigest });
      // The source was recorded on the attempt BEFORE the spend (its id
      // precedes every structured-output artifact), whole and unredacted.
      const source = store.plannerSourceArtifactFor(planner.id)!;
      const reply = store.artifactsFor(planner.id).find(one => one.kind === "structured-output")!;
      expect(source.id).toBeLessThan(reply.id);
      expect(source).toMatchObject({ kind: "plan-contract", truncated: false, captureStatus: "ok" });
      const recorded = decodePlannerSource((readVerifiedArtifact(join(base, "evidence"), source) as { ok: true; content: Buffer }).content)!;
      expect(recorded.contract.scope).toMatchObject({ goal: filed.goal, outOfScope: filed.outOfScope, touches: filed.touches, acceptance: rubric, digest: filedDigest, terms: { riskLevel: "routine", qualityMode: "strict" } });
      expect(recorded.title).toBe("dark mode");
      expect(brief).toContain(`Its source identity is ${recorded.sourceDigest}.`);
      // The ingestion record: filed = proposed, no changes, no amendment.
      const contract = store.latestPlanContractArtifact(ref.id)!;
      const record = decodePlanContractRecord((readVerifiedArtifact(join(base, "evidence"), contract) as { ok: true; content: Buffer }).content)!;
      expect(record).toMatchObject({ sourceDigest: recorded.sourceDigest, sourceArtifact: source.id, amendment: null, changes: [] });
      expect(record.filed).toEqual(filed);
      expect(record.proposed).toEqual(filed);
      expect(contract.capture).toContain("filed contract reproduced exactly");
    });

    // The terminal and the console both say the contract was preserved.
    await run(["task", "show", "dark"], replying([]));
    expect(lines.join("\n")).toContain("filed contract: preserved exactly by the plan — approval binds the terms you filed");
    const web = await openConsole(approverToken);
    const taskPage = await web.page("/t/dark");
    expect(taskPage).toContain("The plan keeps exactly what you filed.");
    expect(taskPage).not.toContain("amendment proposed");
    await web.close();

    // The ordinary approval binds exactly the filed digest.
    await run(["task", "approve", "dark", "--as", "alex", "--token", approverToken, "--digest", filedDigest, "--yes", "--json"], replying([]), new Date(T0.getTime() + 60_000));
    expect(payload().ok).toBe(true);
    withStore(store => expect(store.getScope("dark")).toMatchObject({ approvedDigest: filedDigest, digest: filedDigest, acceptance: rubric }));
  });

  test("a correction that goes back to exactly the filed terms is accepted, not refused as changed authority (a planner stuck on its own silent rewording, found in the real e2e)", async () => {
    const { runnerToken } = await setup();
    const filedDigest = withStore(store => store.getScope("dark")!.digest);
    const reworded = { ...preservingPlan(), goal: "Add a dark-mode toggle to the settings page, persisted per account, and check a reload" };
    const planned = await tick(
      runnerToken,
      replying([
        () => ({ file: "plan", body: reworded }),
        prompt => {
          expect(prompt).toContain('"reason": "silent-amendment"');
          expect(prompt).toContain("frozen as\nYOUR previous output wrote them");
          return { file: "plan", body: preservingPlan() };
        },
      ]),
    );
    expect(planned).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual({ id: "dark", outcome: "planned" });
    withStore(store => expect(store.getScope("dark")).toMatchObject({ digest: filedDigest, goal: filed.goal }));
  });

  test("c2: a plan that silently drops a criterion and rewords the goal is malformed; the same-session correction states the amendment, the approval shows every addition, change, and removal beside the reason, and the yes binds the amended terms", async () => {
    const { runnerToken, approverToken } = await setup();
    const filedDigest = withStore(store => store.getScope("dark")!.digest);
    const amended = {
      goal: "Add a dark-mode toggle to the settings page",
      outOfScope: filed.outOfScope,
      touches: ["src/settings.ts", "src/theme.css", "src/prefs.ts"],
      acceptance: [rubric[0]!, { ...rubric[1]!, evidence: ["check", "screenshot"] as AcceptanceCriterion["evidence"] }],
      plan: planDocument(["c1", "c2"]),
    };
    const reason = "The repository has no package manifest to diff, so c3 cannot be proven as filed; the toggle needs src/prefs.ts for persistence.";
    const planned = await tick(
      runnerToken,
      replying([
        () => ({ file: "plan", body: amended }),
        prompt => {
          expect(prompt).toContain('"reason": "silent-amendment"');
          expect(prompt).toContain("criterion c3 removed");
          expect(prompt).toContain("goal changed");
          expect(prompt).toContain("touch added: src/prefs.ts");
          expect(prompt).toContain("criterion c2 changed (evidence)");
          expect(prompt).toContain("State why");
          return { file: "plan", body: { ...amended, amendment: reason } };
        },
      ]),
    );
    expect(planned).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual({ id: "dark", outcome: "planned", detail: "4 contract changes proposed with an amendment" });
    expect(prompts).toHaveLength(2);

    const amendedDigest = withStore(store => {
      const ref = store.refFor("built-in", "dark");
      const scope = store.getScope("dark")!;
      expect(scope).toMatchObject({ goal: amended.goal, touches: amended.touches, acceptance: amended.acceptance });
      expect(scope.digest).not.toBe(filedDigest);
      const runs = store.runsFor(ref.id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({ outcome: "built", reason: "plan-drafted", scopeDigest: filedDigest });
      expect(runs[1]).toMatchObject({ parentRun: runs[0]!.id, outcome: "no-change", reason: "structured planner output repaired" });
      // The correction inherits its parent's source: no second record.
      expect(store.plannerSourceArtifactFor(runs[0]!.id)).not.toBeNull();
      expect(store.plannerSourceArtifactFor(runs[1]!.id)).toBeNull();
      const record = decodePlanContractRecord((readVerifiedArtifact(join(base, "evidence"), store.latestPlanContractArtifact(ref.id)!) as { ok: true; content: Buffer }).content)!;
      expect(record.amendment).toBe(reason);
      expect(record.sourceArtifact).toBe(store.plannerSourceArtifactFor(runs[0]!.id)!.id);
      expect(record.changes).toEqual([
        { field: "goal", kind: "changed", before: filed.goal, after: amended.goal },
        { field: "touches", kind: "added", path: "src/prefs.ts" },
        expect.objectContaining({ field: "acceptance", kind: "changed", id: "c2", moved: ["evidence"] }),
        expect.objectContaining({ field: "acceptance", kind: "removed", id: "c3" }),
      ]);
      return scope.digest;
    });

    // The terminal preview and the console name every change and the reason.
    await run(["task", "show", "dark"], replying([]));
    const shown = lines.join("\n");
    expect(shown).toContain("filed contract: AMENDED by the plan — 4 changes; approval binds the amended terms");
    expect(shown).toContain(`why: ${reason}`);
    expect(shown).toContain("criterion c3 removed");
    const web = await openConsole(approverToken);
    const taskPage = await web.page("/t/dark");
    expect(taskPage).toContain("The plan makes 4 changes to what you filed");
    expect(taskPage).toContain('id="contract-amendment"');
    expect(taskPage).toContain(reason);
    expect(taskPage).toContain("Drops a check:");
    expect(taskPage).toContain("No new runtime dependency is added.");
    expect(taskPage).toContain("src/prefs.ts");
    const next = await web.page("/next");
    expect(next).toContain("amendment proposed");
    expect(next).toContain(reason);
    await web.close();

    // Approving the filed digest refuses (it is not what is on the row);
    // approving the amended digest binds exactly the amended terms.
    await run(["task", "approve", "dark", "--as", "alex", "--token", approverToken, "--digest", filedDigest, "--yes", "--json"], replying([]), new Date(T0.getTime() + 60_000));
    expect(payload().ok).toBe(false);
    await run(["task", "approve", "dark", "--as", "alex", "--token", approverToken, "--digest", amendedDigest, "--yes", "--json"], replying([]), new Date(T0.getTime() + 60_000));
    expect(payload().ok).toBe(true);
    withStore(store => expect(store.getScope("dark")).toMatchObject({ approvedDigest: amendedDigest, acceptance: amended.acceptance }));
  });

  test("c2: a silent amendment with no session to correct in is a durable malformed-plan incident naming the changes — never a silently replaced contract", async () => {
    const { runnerToken } = await setup();
    const filedDigest = withStore(store => store.getScope("dark")!.digest);
    const failed = await tick(runnerToken, replying([() => ({ file: "plan", body: { ...preservingPlan(), acceptance: [rubric[0]!], plan: planDocument(["c1"]) } })], null));
    expect(failed).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "dark", outcome: "failed", reason: "malformed-plan" }));
    withStore(store => {
      expect(store.getScope("dark")).toMatchObject({ digest: filedDigest, acceptance: rubric });
      expect(store.openIncidents().some(one => one.kind === "malformed-plan")).toBe(true);
      const planner = store.runsFor(store.refFor("built-in", "dark").id).find(one => one.role === "planner")!;
      expect(planner).toMatchObject({ outcome: "failed", reason: "malformed-plan" });
      expect(store.artifactsFor(planner.id).find(one => one.kind === "structured-output")?.capture).toContain("not accepted");
    });
  });

  test("c3: a scope rewritten while the planner ran is the newer source — the old draft is refused atomically, nothing is overwritten, no strike is taken, and the next pass plans against the new terms", async () => {
    const { runnerToken } = await setup();
    const filedDigest = withStore(store => store.getScope("dark")!.digest);
    const rewritten = { ...filed, goal: "Add a dark-mode toggle AND a high-contrast mode", acceptance: [...rubric, { id: "c4", statement: "High-contrast mode is selectable.", how: null, evidence: ["screenshot"] as AcceptanceCriterion["evidence"] }] };
    const racing = replying([
      () => {
        // The operator rewrites the scope while the planner is still running.
        withStore(store => propose(store, { taskId: "dark", ...rewritten, qualityMode: "strict", now: new Date(T0.getTime() + 1_000) }));
        return { file: "plan", body: preservingPlan() };
      },
    ]);
    const stale = await tick(runnerToken, racing);
    expect(stale).toBe(EXIT.refused);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "dark", outcome: "skipped", reason: "stale-source", detail: expect.stringContaining("the filed scope was rewritten") }));
    const newDigest = withStore(store => {
      const ref = store.refFor("built-in", "dark");
      const scope = store.getScope("dark")!;
      expect(scope).toMatchObject({ goal: rewritten.goal, acceptance: rewritten.acceptance });
      expect(scope.digest).not.toBe(filedDigest);
      expect(ref).toMatchObject({ plan: "requested", planStrikes: 0 });
      const planner = store.runsFor(ref.id).find(one => one.role === "planner")!;
      expect(planner).toMatchObject({ outcome: "refused", reason: "stale-source", scopeDigest: filedDigest });
      expect(store.latestPlanArtifact(ref.id)).toBeNull();
      expect(store.latestPlanContractArtifact(ref.id)).toBeNull();
      expect(store.currentLiveLease(ref.id, new Date(T0.getTime() + 2_000))).toBeNull();
      expect(store.raw().prepare("SELECT COUNT(*) AS n FROM notification WHERE kind = 'plan-stale-source'").get()).toEqual({ n: 1 });
      return scope.digest;
    });
    // The next pass plans against the rewritten terms, quoted whole.
    prompts = [];
    const replanned = await tick(runnerToken, replying([() => ({ file: "plan", body: { ...rewritten, plan: planDocument(rewritten.acceptance.map(one => one.id)), amendment: null } })]), new Date(T0.getTime() + 5 * 60_000));
    expect(replanned).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual({ id: "dark", outcome: "planned" });
    expect(prompts[0]).toContain("High-contrast mode is selectable.");
    expect(prompts[0]).toContain(`"digest": "${newDigest}"`);
    withStore(store => expect(store.getScope("dark")).toMatchObject({ digest: newDigest, acceptance: rewritten.acceptance }));
  });

  test("c3: an authority change while the planner ran — the filed scope approved under it — refuses the draft and leaves the approval standing", async () => {
    const { runnerToken, approverToken } = await setup();
    const filedDigest = withStore(store => store.getScope("dark")!.digest);
    const racing = replying([
      () => {
        withStore(store => {
          const agreed = approve(store, "dark", "alex", new Date(T0.getTime() + 1_000), filedDigest, approverToken);
          if (!agreed.ok) throw new Error(`approval refused: ${agreed.reason}`);
        });
        return { file: "plan", body: { ...preservingPlan(), outOfScope: null, amendment: "the exclusions are implied" } };
      },
    ]);
    expect(await tick(runnerToken, racing)).toBe(EXIT.refused);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "dark", outcome: "skipped", reason: "stale-source", detail: expect.stringContaining("the scope's approval changed") }));
    withStore(store => {
      expect(store.getScope("dark")).toMatchObject({ digest: filedDigest, approvedDigest: filedDigest, outOfScope: filed.outOfScope });
      expect(store.runsFor(store.refFor("built-in", "dark").id).find(one => one.role === "planner")).toMatchObject({ outcome: "refused", reason: "stale-source" });
    });
  });

  test("c4: a parked question and its answer resume with the same source identity and the whole filed request quoted again; a same-session correction inherits it", async () => {
    const { runnerToken, approverToken } = await setup();
    const asking = replying([
      () => ({
        file: "park",
        body: {
          urgency: "blocking",
          recap: "Two persistence stores fit.",
          question: "Account preferences or local storage?",
          options: [
            { id: "account", label: "Account", consequence: "Roams.", reversible: true },
            { id: "local", label: "Local", consequence: "Simpler.", reversible: true },
          ],
          recommendation: "account",
        },
      }),
    ]);
    expect(await tick(runnerToken, asking)).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "dark", outcome: "parked" }));
    const firstIdentity = withStore(store => {
      const ref = store.refFor("built-in", "dark");
      const root = store.runsFor(ref.id).find(one => one.role === "planner")!;
      expect(root.outcome).toBe("parked");
      const source = store.plannerSourceArtifactFor(root.id)!;
      return decodePlannerSource((readVerifiedArtifact(join(base, "evidence"), source) as { ok: true; content: Buffer }).content)!.sourceDigest;
    });
    expect(prompts[0]).toContain(`Its source identity is ${firstIdentity}.`);
    const decision = withStore(store => store.listDecisions("unanswered")[0]!);
    await run(["decide", String(decision.id), "--choose", "account", "--as", "alex", "--token", approverToken, "--json"], replying([]), new Date(T0.getTime() + 60_000));

    // The resumed root: a malformed first reply corrected in-session.
    prompts = [];
    const resumed = await tick(
      runnerToken,
      replying([
        () => ({ file: "plan", body: { ...preservingPlan(), plan: "not a sectioned plan" } }),
        () => ({ file: "plan", body: preservingPlan() }),
      ]),
      new Date(T0.getTime() + 2 * 60_000),
    );
    expect(resumed).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual({ id: "dark", outcome: "planned" });
    expect(prompts).toHaveLength(2);
    // The resume was given the whole filed request again, with the same
    // identity, and the operator's answer beside it.
    expect(prompts[0]).toContain(`Its source identity is ${firstIdentity}.`);
    expect(prompts[0]).toContain(rubric[0]!.how!);
    expect(prompts[0]).toContain("Account preferences or local storage?");
    expect(prompts[0]).toContain("| A: account");
    withStore(store => {
      const ref = store.refFor("built-in", "dark");
      const runs = store.runsFor(ref.id).filter(one => one.role === "planner").sort((a, b) => a.id - b.id);
      expect(runs).toHaveLength(3);
      const [parked, root, correction] = runs as [typeof runs[0], typeof runs[0], typeof runs[0]];
      expect(parked.outcome).toBe("parked");
      expect(root).toMatchObject({ outcome: "built", reason: "plan-drafted" });
      expect(correction).toMatchObject({ parentRun: root.id, outcome: "no-change" });
      const rootSource = store.plannerSourceArtifactFor(root.id)!;
      const rootIdentity = decodePlannerSource((readVerifiedArtifact(join(base, "evidence"), rootSource) as { ok: true; content: Buffer }).content)!;
      expect(rootIdentity.sourceDigest).toBe(firstIdentity);
      expect(rootIdentity.answers).toEqual([{ question: "Account preferences or local storage?", choice: "account", note: null }]);
      expect(store.plannerSourceArtifactFor(correction.id)).toBeNull();
      const record = decodePlanContractRecord((readVerifiedArtifact(join(base, "evidence"), store.latestPlanContractArtifact(ref.id)!) as { ok: true; content: Buffer }).content)!;
      expect(record).toMatchObject({ sourceDigest: firstIdentity, sourceArtifact: rootSource.id, changes: [] });
      expect(store.getScope("dark")).toMatchObject({ acceptance: rubric, goal: filed.goal });
    });
  });

  test("c4: the legacy road — no scope filed — plans from the title alone, says so on the page, and files the planner's contract as new", async () => {
    const { runnerToken, approverToken } = await setup({ scope: false });
    const drafted = { goal: "Add a dark-mode toggle", outOfScope: null, touches: [], acceptance: [{ id: "c1", statement: "A toggle exists.", how: null, evidence: ["check"] }], plan: planDocument(["c1"]) };
    expect(await tick(runnerToken, replying([() => ({ file: "plan", body: drafted })]))).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual({ id: "dark", outcome: "planned" });
    expect(prompts[0]).toContain("No scope was filed");
    expect(prompts[0]).toContain('"scope": null');
    withStore(store => {
      const ref = store.refFor("built-in", "dark");
      expect(store.getScope("dark")).toMatchObject({ goal: drafted.goal, acceptance: drafted.acceptance });
      const planner = store.runsFor(ref.id).find(one => one.role === "planner")!;
      expect(planner.scopeDigest).toBe("");
      const record = decodePlanContractRecord((readVerifiedArtifact(join(base, "evidence"), store.latestPlanContractArtifact(ref.id)!) as { ok: true; content: Buffer }).content)!;
      expect(record).toMatchObject({ filed: null, changes: [], amendment: null });
    });
    await run(["task", "show", "dark"], replying([]));
    expect(lines.join("\n")).toContain("filed contract: none — the planner drafted every term from the title and repository");
    const web = await openConsole(approverToken);
    expect(await web.page("/t/dark")).toContain("Nothing was filed before planning");
    await web.close();
  });

  test("c4: an empty-shaped scope — no exclusions, no touches, no how — is preserved exactly, and an oversized filed request refuses in words before any lease, run, or spend", async () => {
    const { runnerToken, approverToken } = await setup({ scope: false });
    const sparse = { goal: "Add a toggle", outOfScope: null, touches: [], acceptance: [{ id: "c1", statement: "A toggle exists.", how: null, evidence: ["check"] as AcceptanceCriterion["evidence"] }] };
    withStore(store => propose(store, { taskId: "dark", ...sparse, now: T0 }));
    expect(await tick(runnerToken, replying([() => ({ file: "plan", body: { ...sparse, plan: planDocument(["c1"]), amendment: null } })]))).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual({ id: "dark", outcome: "planned" });
    withStore(store => {
      const ref = store.refFor("built-in", "dark");
      const record = decodePlanContractRecord((readVerifiedArtifact(join(base, "evidence"), store.latestPlanContractArtifact(ref.id)!) as { ok: true; content: Buffer }).content)!;
      expect(record).toMatchObject({ changes: [], amendment: null });
      expect(record.filed).toEqual(sparse);
    });

    // Oversized: a second task whose legacy-road goal is over the cap
    // refuses BEFORE any workspace, run, or provider — in words that name
    // the sizes — and the task page's diagnosis says the same.
    await run(["task", "add", "huge", "--id", "huge", "--repo", repo, "--json"], replying([]));
    withStore(store => propose(store, { taskId: "huge", goal: "x".repeat(PLANNER_SOURCE_LIMITS.bytes), acceptance: sparse.acceptance, now: T0 }));
    await run(["task", "plan", "huge", "--as", "alex", "--token", approverToken, "--json"], replying([]));
    expect(payload().ok).toBe(true);
    let spawned = false;
    const neverSpawns: Runner = async () => {
      spawned = true;
      throw new Error("nothing spawns on an oversized request");
    };
    expect(await tick(runnerToken, neverSpawns, new Date(T0.getTime() + 60_000))).toBe(EXIT.refused);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "huge", outcome: "skipped", reason: "planner-source-oversized", detail: expect.stringMatching(new RegExp(`over the ${PLANNER_SOURCE_LIMITS.bytes}-byte planner source cap \\(scope \\d+, revision brief 0\\)`)) }));
    expect(spawned).toBe(false);
    withStore(store => {
      const ref = store.refFor("built-in", "huge");
      expect(store.runsFor(ref.id)).toHaveLength(0);
      expect(store.currentLiveLease(ref.id, new Date(T0.getTime() + 61_000))).toBeNull();
      expect(ref).toMatchObject({ plan: "requested", planStrikes: 0 });
      expect(store.getScope("huge")!.goal).toHaveLength(PLANNER_SOURCE_LIMITS.bytes);
      expect(diagnoseTaskDispatch(store, "huge", new Date(T0.getTime() + 61_000))).toMatchObject({ code: "planner-source", detail: expect.stringContaining("planner source cap") });
    });
  });

  /** The operator rewrites a planned task's scope (v119): the filing primitive every scope edit goes through. */
  const rewritten = {
    goal: "Add a high-contrast theme to the settings page, chosen per device",
    outOfScope: "No dark-mode work; no new dependencies",
    touches: ["src/settings.ts", "src/contrast.css"],
    acceptance: [{ id: "h1", statement: "The settings page offers a high-contrast theme.", how: null, evidence: ["screenshot"] as AcceptanceCriterion["evidence"] }],
  };
  const rescope = (at: Date, terms: typeof rewritten = rewritten) => withStore(store => propose(store, { taskId: "dark", ...terms, qualityMode: "strict", now: at }));
  const asking = () => replying([
    () => ({
      file: "park",
      body: {
        urgency: "blocking",
        recap: "Two persistence stores fit.",
        question: "Account preferences or local storage?",
        options: [
          { id: "account", label: "Account", consequence: "Roams.", reversible: true },
          { id: "local", label: "Local", consequence: "Simpler.", reversible: true },
        ],
        recommendation: "account",
      },
    }),
  ]);

  test("c1: a re-scoped task gets a plan for its new goal — the old plan, contract record and answers leave the planner's context but stay on record, and an identical refile changes nothing", async () => {
    const { runnerToken, approverToken } = await setup();
    expect(await tick(runnerToken, asking())).toBe(EXIT.ok);
    const asked = withStore(store => store.listDecisions("unanswered")[0]!);
    await run(["decide", String(asked.id), "--choose", "account", "--as", "alex", "--token", approverToken, "--json"], replying([]), new Date(T0.getTime() + 60_000));
    expect(await tick(runnerToken, replying([() => ({ file: "plan", body: preservingPlan() })]), new Date(T0.getTime() + 2 * 60_000))).toBe(EXIT.ok);
    const old = withStore(store => {
      const ref = store.refFor("built-in", "dark");
      expect(ref).toMatchObject({ plan: "drafted", planningGeneration: 0 });
      expect(store.answeredDecisionsFor("dark")).toHaveLength(1);
      return { plan: store.latestPlanArtifact(ref.id)!.id, contract: store.latestPlanContractArtifact(ref.id)!.id, chain: store.ledgerChain({ full: true }) };
    });

    rescope(new Date(T0.getTime() + 3 * 60_000));
    withStore(store => {
      const ref = store.refFor("built-in", "dark");
      expect(ref).toMatchObject({ plan: "requested", planStrikes: 0, planningGeneration: 1 });
      // Nothing from the old goal is offered as the next plan, and its answer is not the next planner's memory…
      expect(store.latestPlanArtifact(ref.id)).toBeNull();
      expect(store.latestPlanContractArtifact(ref.id)).toBeNull();
      expect(store.answeredDecisionsFor("dark")).toEqual([]);
      // …but every record stays: the plan, the contract record, the answered question and the ledger chain.
      expect(store.getArtifact(old.plan)).not.toBeNull();
      expect(store.getArtifact(old.contract)).not.toBeNull();
      expect(store.getDecision(asked.id)).toMatchObject({ state: "answered", choice: "account", supersededReason: null });
      expect(store.ledgerChain({ full: true })).toMatchObject({ ok: true });
      expect(store.raw().prepare("SELECT outcome FROM action_ledger WHERE task_id = 'dark' AND action = 'planning restarted'").all()).toEqual([{ outcome: "scope changed" }]);
    });

    prompts = [];
    const replan = { ...rewritten, plan: planDocument(["h1"]), amendment: null };
    expect(await tick(runnerToken, replying([() => ({ file: "plan", body: replan })]), new Date(T0.getTime() + 10 * 60_000))).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual({ id: "dark", outcome: "planned" });
    expect(prompts[0]).toContain(rewritten.goal);
    expect(prompts[0]).not.toContain(filed.goal);
    expect(prompts[0]).not.toContain("Account preferences or local storage?");
    withStore(store => {
      const ref = store.refFor("built-in", "dark");
      expect(ref).toMatchObject({ plan: "drafted", planningGeneration: 1 });
      expect(store.getScope("dark")).toMatchObject({ goal: rewritten.goal, acceptance: rewritten.acceptance });
      const plan = store.latestPlanArtifact(ref.id)!;
      expect(plan.id).not.toBe(old.plan);
      expect(store.getRun(plan.run)).toMatchObject({ role: "planner", planningGeneration: 1 });
      const record = decodePlanContractRecord((readVerifiedArtifact(join(base, "evidence"), store.latestPlanContractArtifact(ref.id)!) as { ok: true; content: Buffer }).content)!;
      expect(record).toMatchObject({ changes: [], amendment: null, filed: { goal: rewritten.goal } });
      const source = decodePlannerSource((readVerifiedArtifact(join(base, "evidence"), store.plannerSourceArtifactFor(plan.run)!) as { ok: true; content: Buffer }).content)!;
      expect(source.answers).toEqual([]);
    });

    // The same terms filed again (whitespace aside) are not a new scope: the drafted plan stands.
    rescope(new Date(T0.getTime() + 11 * 60_000), { ...rewritten, goal: `  ${rewritten.goal}  `, touches: [...rewritten.touches].reverse() });
    withStore(store => expect(store.refFor("built-in", "dark")).toMatchObject({ plan: "drafted", planningGeneration: 1 }));
  });

  test("c1: re-scoping closes the old goal's open question — it leaves the queue with its hold and page, typed, never answered — and the next pass plans the new goal", async () => {
    const { runnerToken, approverToken } = await setup();
    expect(await tick(runnerToken, asking())).toBe(EXIT.ok);
    const asked = withStore(store => {
      const decision = store.listDecisions("unanswered")[0]!;
      expect(store.raw().prepare("SELECT count(*) AS n FROM hold WHERE owner_kind = 'decision' AND owner_id = ?").get(String(decision.id))).toEqual({ n: 1 });
      return decision;
    });

    rescope(new Date(T0.getTime() + 60_000));
    withStore(store => {
      expect(store.getDecision(asked.id)).toMatchObject({ state: "answered", choice: null, note: null, supersededReason: "scope-changed" });
      expect(store.listDecisions("unanswered")).toEqual([]);
      expect(store.countUnanswered()).toBe(0);
      expect(store.raw().prepare("SELECT count(*) AS n FROM hold WHERE owner_kind = 'decision'").get()).toEqual({ n: 0 });
      expect(store.raw().prepare("SELECT count(*) AS n FROM notification WHERE dedupe_key = ? AND resolved_at IS NULL").get(`decision:${asked.id}`)).toEqual({ n: 0 });
      // A closed question is not an answer anywhere.
      expect(store.answeredDecisionsFor("dark")).toEqual([]);
    });

    // Every surface says it closed and why, with no answer and nothing left to answer: a stale answer is refused in those words.
    await run(["decide", String(asked.id), "--choose", "account", "--as", "alex", "--token", approverToken, "--json"], replying([]), new Date(T0.getTime() + 2 * 60_000));
    expect(payload()).toMatchObject({ ok: false, reason: "closed", message: expect.stringContaining("Closed without an answer. The scope changed, so planning started again.") });
    withStore(store => expect(store.getDecision(asked.id)).toMatchObject({ choice: null, supersededReason: "scope-changed" }));
    await run(["decide", String(asked.id)], replying([]));
    expect(lines.join("\n")).toContain("Closed without an answer. The scope changed, so planning started again.");
    expect(lines.join("\n")).not.toContain("answered: null");
    expect(lines.join("\n")).toContain("dark — CLOSED");
    expect(lines.join("\n")).not.toContain("--choose");
    const web = await openConsole(approverToken);
    const question = await web.page(`/d/${asked.id}`);
    expect(question).toContain('badge-answered">closed</span>');
    expect(question).toContain("The scope changed, so planning started again.");
    expect(question).not.toContain(`/d/${asked.id}/answer`);
    const stale = await web.post(`/d/${asked.id}/answer`, { choice: "account" });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("Closed without an answer. The scope changed, so planning started again.");
    withStore(store => expect(store.getDecision(asked.id)).toMatchObject({ choice: null, supersededReason: "scope-changed" }));
    const task = await web.page("/t/dark");
    expect(task).toContain("Closed without an answer");
    expect(task).not.toContain("Answered");
    await web.close();

    prompts = [];
    expect(await tick(runnerToken, replying([() => ({ file: "plan", body: { ...rewritten, plan: planDocument(["h1"]), amendment: null } })]), new Date(T0.getTime() + 10 * 60_000))).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual({ id: "dark", outcome: "planned" });
    expect(prompts[0]).toContain(rewritten.goal);
    expect(prompts[0]).not.toContain("Account preferences or local storage?");
  });

  test("a goal too long for the planner's handoff is named before any lease, run or spend — no strike, no malformed-plan incident — and a shorter goal plans", async () => {
    const { runnerToken, approverToken } = await setup();
    rescope(T0, { ...rewritten, goal: "g".repeat(9_000) });
    let spawned = false;
    const neverSpawns: Runner = async () => {
      spawned = true;
      throw new Error("nothing spawns on a goal the planner cannot carry");
    };
    expect(await tick(runnerToken, neverSpawns, new Date(T0.getTime() + 60_000))).toBe(EXIT.refused);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "dark", outcome: "skipped", reason: "planner-source-too-long", detail: "The goal is 9,000 characters; the planner can carry at most 8,000. Shorten the goal and planning starts again." }));
    expect(spawned).toBe(false);
    withStore(store => {
      const ref = store.refFor("built-in", "dark");
      expect(store.runsFor(ref.id)).toHaveLength(0);
      expect(store.incidentsForTask(ref.id)).toEqual([]);
      expect(ref).toMatchObject({ plan: "requested", planStrikes: 0 });
      expect(diagnoseTaskDispatch(store, "dark", new Date(T0.getTime() + 61_000))).toMatchObject({ code: "planner-source", summary: "Scope too long to plan", detail: expect.stringContaining("9,000 characters") });
    });
    // The task page says it once: what to shorten and one action, with no "the agent is inspecting" card beside it.
    const web = await openConsole(approverToken, () => new Date(T0.getTime() + 61_000));
    const page = await web.page("/t/dark");
    expect(page).toContain("The goal is 9,000 characters; the planner can carry at most 8,000.");
    expect(page).toContain("Edit the request");
    expect(page).not.toContain("Planning requested");
    await web.close();

    rescope(new Date(T0.getTime() + 2 * 60_000));
    expect(await tick(runnerToken, replying([() => ({ file: "plan", body: { ...rewritten, plan: planDocument(["h1"]), amendment: null } })]), new Date(T0.getTime() + 3 * 60_000))).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual({ id: "dark", outcome: "planned" });
  });
});
