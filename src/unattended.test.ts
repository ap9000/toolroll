/**
 * The M4 acceptance sentence, executable: queue twelve, sleep, wake to PRs —
 * with near-zero idle spend, every failure typed, and nothing lost between.
 *
 * One fake-clocked unattended stretch against real git: clean builds, a stated
 * no-change, a park answered by a person mid-stretch, three strikes and an
 * authenticated requeue, a transient timeout that backs off and recovers,
 * a dependency chain, a scope approved while the stretch runs, and a
 * duplicate pass that finds nothing to do twice. The zero-token invariant
 * is asserted as arithmetic: provider spawns == runs stamped before
 * spending, exactly.
 *
 * Built-in backend only, stated: external-backend dispatch is deferred in
 * writing (PROGRESS.md), so the twelve live in the built-in queue. The
 * Telegram disconnect path is proved in telegram.test.ts (the follower's
 * backoff); this stretch answers its park through the CLI.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec, type ExecResult, type RunOptions } from "./exec.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import { assignmentOf, assignmentEvidenceIntact } from "./assignment.js";


/** The exact route authority a fixture PRESENTS at admission (v48 authority repair): the
 * store dictates nothing, so a routed row presents the leg it holds, exactly
 * as a real dispatch would; absent authority presents nothing and the
 * admission says why. */
const presented = (
  s: Pick<import("./store.js").Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
  spend: { provider: string; model: string | null } = { provider: "claude", model: null },
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  // A task with no scope presents the bare word `legacy` for the pair it
  // spends as (atomic authority closure): the default claude pair, or the
  // exact pair a fixture names.
  const authority = s.routeAuthorityFor(taskRef, role) ?? s.routeAuthorityFor(taskRef, role, spend);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

type Runner = (file: string, args: readonly string[], options?: RunOptions) => Promise<ExecResult>;

const T0 = new Date("2026-08-12T22:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

const TASKS = Array.from({ length: 12 }, (_, index) => `t-${String(index + 1).padStart(2, "0")}`);

describe("the night: twelve tasks, one fake clock", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  let spawns = 0;
  const failuresSoFar = new Map<string, number>();

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  /** One agent for the whole fleet, its behavior chosen by the task in its brief. */
  const nightAgent: Runner = async (_file, args, options) => {
    spawns++;
    const cwd = options?.cwd ?? "";
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const taskId = /\bt-\d\d\b/.exec(prompt)?.[0] ?? "?";
    const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    const mailbox = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];

    const conclude = async (status: "completed" | "no-change") => {
      if (done !== undefined && cwd !== "") {
        await writeFile(join(cwd, done), JSON.stringify({ version: 1, status, conclusion: `${taskId}: ${status}.` }));
      }
    };

    // t-05 concludes honestly that nothing needed changing.
    if (taskId === "t-05") {
      await conclude("no-change");
      return { ...OK, stdout: "{}" };
    }

    // t-06 parks once — a judgement call for a person — then builds on resume.
    if (taskId === "t-06" && !failuresSoFar.has("t-06-parked")) {
      failuresSoFar.set("t-06-parked", 1);
      if (mailbox !== undefined && cwd !== "") {
        await writeFile(
          join(cwd, mailbox),
          JSON.stringify({
            urgency: "blocking",
            recap: "The cache can be keyed by user or by tenant.",
            question: "Key the cache by user, or by tenant?",
            options: [
              { id: "user", label: "By user", consequence: "More entries, simpler invalidation.", reversible: true },
              { id: "tenant", label: "By tenant", consequence: "Fewer entries, broader invalidation.", reversible: true },
            ],
            recommendation: "tenant",
          }),
        );
      }
      return { ...OK, stdout: "{}" };
    }

    // t-07 reports failure three times before the person intervenes.
    if (taskId === "t-07" && (failuresSoFar.get("t-07") ?? 0) < 3) {
      failuresSoFar.set("t-07", (failuresSoFar.get("t-07") ?? 0) + 1);
      return { ...OK, code: 1, stderr: "the model refused to cooperate" };
    }

    // t-08 times out once — infrastructure, not the work — then recovers.
    if (taskId === "t-08" && !failuresSoFar.has("t-08")) {
      failuresSoFar.set("t-08", 1);
      return { ...OK, code: 124, timedOut: true };
    }

    if (cwd !== "") await writeFile(join(cwd, `${taskId}.ts`), `export const built = "${taskId}";\n`);
    await conclude("completed");
    return { ...OK, stdout: JSON.stringify({ result: `${taskId} built.` }) };
  };

  const run = (argv: string[], now: Date) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now,
      agentRunner: nightAgent,
    });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-night-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    spawns = 0;
    failuresSoFar.clear();
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

  test("queue twelve, sleep, wake to PRs", async () => {
    // -- Evening: credentials, twelve tasks, eleven approved scopes, one
    // dependency, one publication grant with its terms agreed to.
    // The runner gate (MCP spec v6): the tick's claims authenticate the
    // runner and require each task's placed repo in its registered repos
    // list — the CLI register cannot bind repos, so builder-1 enrolls
    // directly against the store, and every task is placed when filed.
    const boot = openStore(db);
    register(boot, { name: "builder-1", host: "test", capacity: 12, repos: [repo], now: T0, newToken: () => "tok-builder-1" });
    boot.close();
    const runnerToken = "tok-builder-1";
    await run(["approver", "add", "alex", "--json"], T0);
    const approverToken = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"], T0);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"], T0); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"], T0);
    for (const id of TASKS) {
      await run(["task", "add", `night work ${id}`, "--id", id, "--repo", repo], T0);
      await run(["task", "scope", id, "--goal", `do exactly ${id}`, "--acceptance", "It is fixed and verified.|manual-review"], T0);
    }
    // t-10's approval deliberately waits until the night is underway.
    for (const id of TASKS.filter(one => one !== "t-10")) {
      await run(["task", "approve", id, "--json"], T0);
      const digest = payload().scope.digest as string;
      await run(["task", "approve", id, "--yes", "--digest", digest, "--as", "alex", "--token", approverToken], T0);
    }
    await run(["task", "block", "t-09", "--on", "t-01"], T0);
    await run([
      "publish", "grant", "--github", "alex/thing", "--repo", repo,
      "--yes", "--as", "alex", "--token", approverToken, "--json",
    ], T0);
    expect(payload().granted).toBe(true);

    const tick = (minutes: number) =>
      run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--max", "12", "--json"], at(minutes));

    // -- The night, tick by tick, the clock advancing between.
    await tick(0);      // most build; t-05 no-change; t-06 parks; t-07 and t-08 strike once and back off
    await tick(3);      // backoffs (1m) lapsed: t-08 recovers, t-07 strikes again; t-09 follows t-01
    await run(["decide", "--json"], at(4));
    const decisionId = payload().waiting[0].id as number;
    await run(["decide", String(decisionId), "--choose", "tenant", "--as", "alex", "--token", approverToken], at(4));
    await tick(7);      // t-06 resumes with the answer in its brief; t-07's third strike stalls it
    await tick(12);     // whatever backoff remains lapses; nothing for t-07 — it is held, not looping

    // The stall is a typed incident, not a mystery.
    const mid = openStore(db);
    const stalled = mid.openIncidents().find(one => one.taskId === "t-07");
    expect(stalled?.kind).toBe("attempts-exhausted");
    mid.close();

    // -- The person, briefly awake: requeue the stall, approve the late scope.
    await run(["task", "requeue", "t-07", "--as", "alex", "--token", approverToken, "--json"], at(15));
    expect(payload().ok).toBe(true);
    await run(["task", "approve", "t-10", "--json"], at(15));
    const digest10 = payload().scope.digest as string;
    await run(["task", "approve", "t-10", "--yes", "--digest", digest10, "--as", "alex", "--token", approverToken], at(15));

    await tick(16);     // t-07 (strikes reset) and t-10 build

    // -- Duplicate pass: an empty queue refuses, idempotently — twice.
    expect(await tick(20)).toBe(EXIT.refused);
    expect(payload().reason).toBe("empty");
    expect(await tick(21)).toBe(EXIT.refused);

    // -- Morning. Every task finished; the ledger can say how.
    const store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    try {
      for (const id of TASKS) {
        expect(store.getTask(id)?.state, id).toBe("done");
      }

      // The zero-token invariant, as arithmetic: every provider spawn was
      // stamped before it spent, and nothing spent unstamped.
      const stamped = store.handle
        .prepare("SELECT COUNT(*) AS n FROM run WHERE provider_started_at IS NOT NULL")
        .get();
      expect(Number(stamped?.["n"])).toBe(spawns);

      // Eleven publications owed — the no-change honestly published nothing.
      const pending = store.pendingPublications();
      expect(pending).toHaveLength(11);
      expect(pending.every(one => one.state === "intended")).toBe(true);
    } finally {
      store.close();
    }

    // -- The PRs, against a scripted gh: push each exact SHA, open each PR.
    let prNumber = 100;
    const publishExec = async (file: string, args: readonly string[]) => {
      if (file === "gh" && args[1] === "list") return { ...OK, stdout: "[]" };
      if (file === "gh" && args[1] === "create") {
        prNumber++;
        return { ...OK, stdout: `https://github.com/alex/thing/pull/${prNumber}\n` };
      }
      return { ...OK };
    };
    lines = [];
    const published = await runOperate(
      "publish",
      ["--repo", repo, "--json"],
      line => lines.push(line),
      { databaseFile: db, now: at(30), publishExec },
    );
    expect(published).toBe(EXIT.ok);
    expect(payload().report).toMatchObject({ pushed: 11, opened: 11, failed: 0 });

    // -- The brief tells the same story from the same rows.
    await run(["brief", "--local", "--repo", repo, "--since", T0.toISOString(), "--json"], at(31));
    const brief = payload();
    expect(brief.tally.built).toHaveLength(12); // 11 commits + 1 honest no-change
    expect(brief.decide).toHaveLength(0);
    expect(brief.incidents).toHaveLength(0);
    expect(brief.stranded).toHaveLength(0);
  }, 120_000);
});

describe("v40: a drafted, unapproved repair moves the idle-spend invariant not at all", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let evidenceRoot: string;
  let lines: string[] = [];
  let spawns = 0;

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const zeroSpendAgent: Runner = async (_file, args, options) => {
    spawns++;
    const cwd = options?.cwd ?? "";
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (done !== undefined && cwd !== "") {
      await writeFile(join(cwd, "guarded.ts"), "export const guarded = true;\n");
      await writeFile(join(cwd, done), JSON.stringify({ version: 1, status: "completed", conclusion: "guarded it." }));
    }
    return { ...OK, stdout: JSON.stringify({ result: "built." }) };
  };
  const run = (argv: string[], now: Date) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: zeroSpendAgent, evidenceRoot });
  };
  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-repair-idle-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    evidenceRoot = join(base, "evidence");
    spawns = 0;
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

  test("a chain drafted (via the real trigger, no mode) dispatches nothing on the next tick — it waits for a person", async () => {
    const boot = openStore(db);
    register(boot, { name: "builder-1", host: "test", capacity: 4, repos: [repo], now: T0, newToken: () => "tok-builder-1" });
    boot.close();
    await run(["approver", "add", "alex", "--json"], T0);
    const approverToken = payload().token as string;
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"], T0);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"], T0); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"], T0);
    // Seed a short-verdict run and let the REAL trigger draft a repair —
    // the same function a review pass calls, exercised directly here so
    // the test stays about the tick's spend, not about faking a reviewer.
    const store = openStore(db);
    store.createTask({ id: "t-guard", title: "guard the thing" }, T0);
    const ref = store.refFor("built-in", "t-guard");
    store.placeTask(ref.id, repo);
    const { propose, approve: approveScope } = await import("./scope.js");
    const { maybeTriggerRepair } = await import("./dispose.js");
    propose(store, { taskId: "t-guard", goal: "guard it", acceptance: [{ id: "c1", statement: "it is guarded", how: null, evidence: ["manual-review"] }], now: T0 });
    // v48: the source attempt ran under a sealed route — approve before it opens.
    const sealed = approveScope(store, "t-guard", "alex", T0, store.getScope("t-guard")!.digest, approverToken);
    if (!sealed.ok) throw new Error(`the fixture approval was refused: ${sealed.reason}`);
    const sourceRun = store.startRun({ taskRef: ref.id, leaseId: "l-1", runner: "builder-1", branch: "b", worktree: "/wt", now: T0, ...presented(store, ref.id, "builder") });
    store.stampRun(sourceRun, { scopeDigest: store.getScope("t-guard")!.digest });
    store.recordOutcomeFacts(sourceRun, { headRevision: (await git(["rev-parse", "HEAD"])).stdout.trim() });
    store.finishRun(sourceRun, { outcome: "built", committed: true, now: T0 });
    // The source task delivered (its short proof is what drafts the repair);
    // only the DRAFT could dispatch on the next tick.
    store.setTaskState("t-guard", "done", T0);
    store.saveProofVerdict(sourceRun, "short", ["needs a look"], T0, [
      { id: "c1", statement: "it is guarded", requiredEvidence: ["manual-review"], state: "missing", detail: ['criterion "c1" needs work'], answered: [], review: null },
    ]);
    const trigger = maybeTriggerRepair(store, repo, evidenceRoot, sourceRun, "short", T0);
    if (trigger.kind !== "drafted") throw new Error(`expected a draft, got ${trigger.kind}`);
    expect(trigger.approved).toBe(false);
    store.close();

    // The idle tick: an unapproved draft is not dispatchable — it must
    // move zero agent spawns, exactly the M4 invariant this file proves
    // for the twelve-task night, now proved for the repair loop's own
    // "waits for a person" promise.
    const ticked = await run(["tick", "--runner", "builder-1", "--token", "tok-builder-1", "--repo", repo, "--pool", pool, "--max", "4", "--json"], at(1));
    expect(ticked).toBe(EXIT.refused);
    expect(payload().reason).toBe("nothing-dispatched");
    expect(spawns).toBe(0);

    // Approving it is the one act that makes it dispatchable — and ONLY
    // that act; nothing here spent unattended.
    const approve = await run(["task", "repair", String(sourceRun), "--yes", "--as", "alex", "--token", approverToken, "--json"], at(1));
    expect(approve).toBe(EXIT.ok);
    expect(spawns).toBe(0);

    const afterApproval = await run(["tick", "--runner", "builder-1", "--token", "tok-builder-1", "--repo", repo, "--pool", pool, "--max", "4", "--json"], at(2));
    expect(afterApproval).toBe(EXIT.ok);
    expect(spawns).toBe(1); // one dispatch — the approved draft, and only it
  });
  test("missing observation hands one checked build to the lead without an evidence follow-up", async () => {
    const { addApprover, propose, approve } = await import("./scope.js");
    const { presetTerms, modeTermsJson, modeDigestOf } = await import("./modes.js");
    const log = join(base, "gate-count.txt");
    await writeFile(log, "0");
    await writeFile(join(repo, ".gitignore"), "node_modules\n");
    await writeFile(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "vitest run" } }));
    await writeFile(join(repo, "package-lock.json"), "{}\n");
    await writeFile(join(repo, "value.ts"), "export const value = 'map';\n");
    await writeFile(join(repo, "gate-count.cjs"), `const fs = require('node:fs'); const log = ${JSON.stringify(log)}; fs.writeFileSync(log, String(Number(fs.readFileSync(log,'utf8'))+1));`);
    await git(["add", "."]); await git(["commit", "-qm", "original value and verification"]);
    const store = openStore(db), who = addApprover(store, "alex", T0);
    if (!who.ok) throw Error("approver");
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
    register(store, { name: "builder-1", host: "test", capacity: 4, repos: [repo], now: T0, newToken: () => "tok-builder-1" });
    store.createTask({ id: "t-observe", title: "Restore the earned draft" }, T0);
    store.placeTask(store.lookupRef("t-observe")!.id, repo);
    propose(store, { taskId: "t-observe", goal: "Restore the earned draft after reload", touches: ["value.ts", "value.test.ts"], acceptance: [{ id: "c1", statement: "The regression fails on the original and passes on the saved candidate", how: null, evidence: ["check"] }], now: T0 });
    expect(approve(store, "t-observe", "alex", T0, store.getScope("t-observe")!.digest, who.token).ok).toBe(true);
    store.setVerifyCommand({ repo, command: "npm test -- --reporter=dot && node gate-count.cjs", timeoutMs: 30000, approvedBy: "alex" }, T0);
    const terms = { ...presetTerms("standard", at(60).toISOString()), repairAuto: true, repairMaxAttempts: 3, reviewAuto: true };
    store.signMode({ repo, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, T0);
    store.close();
    let builds = 0, reviews = 0;
    const provider: Runner = async (_file, args, options) => {
      const cwd = options!.cwd!, prompt = args[args.indexOf("-p") + 1]!;
      if (prompt.includes("You are a REVIEWER")) reviews++;
      expect(prompt).not.toContain("You are a REVIEWER");
      builds++;
      expect(builds).toBe(1); // No proof repair, evidence follow-up or resubmission.
      if (!existsSync(join(cwd, "node_modules"))) symlinkSync(realpathSync(resolve("node_modules")), join(cwd, "node_modules"), "junction");
      await writeFile(join(cwd, "value.ts"), "export const value = 'augment_draft';\n");
      await writeFile(join(cwd, "value.test.ts"), "import {test,expect} from 'vitest'; import {value} from './value'; test('restored reward opens draft',()=>expect(value).toBe('augment_draft'));\n");
      const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)![0];
      await writeFile(join(cwd, done), JSON.stringify({ version: 1, status: "completed", conclusion: "Synthetic candidate regression; original-base control was not run" }));
      return { ...OK, stdout: JSON.stringify({ result: "Synthetic original/candidate regression" }) };
    };
    const tick = async (now: Date, expected: number = EXIT.ok) => {
      const output: string[] = [];
      expect(await runOperate("tick", ["--runner", "builder-1", "--token", "tok-builder-1", "--repo", repo, "--pool", pool, "--max", "1", "--json"], line => output.push(line), { databaseFile: db, evidenceRoot, now, agentRunner: provider }), output.join("\n")).toBe(expected);
      return JSON.parse(output.join("\n"));
    };
    await tick(at(1));
    const first = openStore(db);
    const runs = first.runsFor(first.lookupRef("t-observe")!.id);
    expect(runs).toHaveLength(1);
    const result = runs[0]!;
    expect(result).toMatchObject({ role: "builder", outcome: "built" });
    const proof = first.proofVerdictFor(result.id);
    // Passing the candidate check does not invent the missing base comparison.
    expect(proof).toMatchObject({ verdict: "short", machineVerdict: "verified", matrix: [{ state: "missing" }] });
    expect(assignmentOf(first, "t-observe", at(1), { principal: "operator", repos: [repo] }, evidenceRoot)).toMatchObject({
      state: "ready-to-check", handoff: { kind: "result", acknowledged: false },
      receipt: { runId: result.id, completionKind: "checked-build", checks: { status: "passed", exitCode: 0 } },
    });
    expect(first.repairChainForRoot("t-observe")).toHaveLength(0);
    expect(first.reviewRetryStateOf(result.id)?.state).toBe("unrequested");
    expect(first.openReviewRequests()).toHaveLength(0);
    first.close();
    expect((await tick(at(2), EXIT.refused)).dispatched).toHaveLength(0);
    expect((await tick(at(3), EXIT.refused)).dispatched).toHaveLength(0);
    const final = openStore(db);
    expect(final.runsFor(final.lookupRef("t-observe")!.id)).toEqual(runs);
    expect(final.proofVerdictFor(result.id)).toEqual(proof);
    expect(final.repairChainForRoot("t-observe")).toHaveLength(0);
    expect(final.proofAcceptance(result.id)).toBeNull();
    expect(final.openReviewRequests()).toHaveLength(0);
    final.close();
    expect({ builds, reviews, fullGates: await readFile(log, "utf8") }).toEqual({ builds: 1, reviews: 0, fullGates: "1" });
  });

  // Synthetic providers, real CLI dispatch, Git worktrees, verification command,
  // receipts and lead handoff. Historical automatic mode terms must not revive
  // the retired review/repair loop, even when another gate might pass.
  test.each(["fix", "no-change", "changed-evidence", "no-proof-fix", "no-proof-no-change", "evidence-missing", "goal-fails"])("failed checks reach the lead once without automatic repair or review (%s)", scenario => {
    const direct = ["no-proof-fix", "no-proof-no-change", "evidence-missing", "goal-fails"].includes(scenario);
    const noChange = ["no-change", "no-proof-no-change", "evidence-missing", "goal-fails"].includes(scenario);
    return (async () => {
      const { addApprover, propose, approve } = await import("./scope.js");
      const { presetTerms, modeTermsJson, modeDigestOf } = await import("./modes.js");
      const log = join(base, "gate-count.txt");
      await writeFile(log, "0");
      await writeFile(join(repo, "value.txt"), "initial");
      await writeFile(join(repo, "check.cjs"), `const fs = require('node:fs'); const log = ${JSON.stringify(log)};
const attempt = Number(fs.readFileSync(log, 'utf8')) + 1; fs.writeFileSync(log, String(attempt));
const passed = ${noChange ? "attempt > 1" : "fs.readFileSync('value.txt','utf8') === 'fixed'"};
if (!passed) { console.error('balance probe timed out; 163 passed, 1 failed'); process.exitCode = 1; }
`);
      await git(["add", "."]);
      await git(["commit", "-qm", "synthetic verification fixture"]);
      const store = openStore(db);
      const who = addApprover(store, "alex", T0);
      if (!who.ok) throw Error("approver");
      for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
      register(store, { name: "builder-1", host: "test", capacity: 4, repos: [repo], now: T0, newToken: () => "tok-builder-1" });
      store.createTask({ id: "t-check", title: "Repair saved state" }, T0);
      const ref = store.refFor("built-in", "t-check");
      store.placeTask(ref.id, repo);
      const statement = direct ? "Saved values are correct after reload" : "The project check succeeds";
      propose(store, { taskId: "t-check", goal: "Fix value.txt and verify it", touches: ["value.txt"], acceptance: [{ id: "c1", statement, how: null, evidence: scenario === "evidence-missing" ? ["check", "screenshot"] : ["check"] }], now: T0 });
      expect(approve(store, "t-check", "alex", T0, store.getScope("t-check")!.digest, who.token).ok).toBe(true);
      store.setVerifyCommand({ repo, command: "node check.cjs", timeoutMs: 5000, approvedBy: "alex" }, T0);
      const terms = { ...presetTerms("standard", at(60).toISOString()), repairAuto: true, repairMaxAttempts: 3, reviewAuto: true };
      store.signMode({ repo, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, T0);
      store.close();
      let builds = 0, reviews = 0;
      const provider: Runner = async (_file, args, options) => {
        const cwd = options!.cwd!;
        const prompt = args[args.indexOf("-p") + 1]!;
        if (prompt.includes("You are a REVIEWER")) reviews++;
        expect(prompt).not.toContain("You are a REVIEWER");
        builds++;
        expect(builds).toBe(1); // No provider call may repair the failed check or optional proof.
        await writeFile(join(cwd, "value.txt"), "broken");
        expect((await exec(process.execPath, ["--check", "check.cjs"], { cwd })).code).toBe(0);
        const done = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)![0];
        const proof = /STANDING-ORDERS-PROOF-[0-9a-f]{16}\.json/.exec(prompt)![0];
        await writeFile(join(cwd, done), JSON.stringify({ version: 1, status: "completed", conclusion: "Synthetic saved result; project check still needs attention" }));
        if (!direct) await writeFile(join(cwd, proof), JSON.stringify({ version: 1, criteria: [{ id: "c1", statement, verdict: "pending-verification", how: "Awaiting the native check", evidence: [{ kind: "check", ref: "node --check check.cjs" }] }], checks: [{ command: "node --check check.cjs", exitCode: 0, summary: "Syntax checked" }], changed: ["value.txt"], caveats: [], screenshots: [] }));
        return { ...OK, stdout: JSON.stringify({ result: "Synthetic recovery result" }) };
      };
      const tick = async (now: Date, expected: number = EXIT.ok) => {
        const output: string[] = [];
        const code = await runOperate("tick", ["--runner", "builder-1", "--token", "tok-builder-1", "--repo", repo, "--pool", pool, "--max", "1", "--json"], line => output.push(line), { databaseFile: db, evidenceRoot, now, agentRunner: provider });
        expect(code, output.join("\n")).toBe(expected);
        return JSON.parse(output.join("\n"));
      };
      await tick(at(1));
      const first = openStore(db);
      const runs = first.runsFor(ref.id);
      expect(runs).toHaveLength(1);
      const result = runs[0]!;
      expect(result).toMatchObject({ role: "builder", outcome: "built" });
      const proof = first.proofVerdictFor(result.id);
      // Older authored receipts retain their raw verdict shape; the handoff
      // reads the native check receipt instead of inferring a check from it.
      expect(proof).toMatchObject({ verdict: "refuted", machineVerdict: direct ? "refuted" : null });
      const ready = assignmentOf(first, "t-check", at(1), { principal: "operator", repos: [repo] }, evidenceRoot)!;
      expect(ready).toMatchObject({ state: "ready-to-check", detail: "Checks failed (exit 1).",
        handoff: { kind: "result", acknowledged: false },
        receipt: { runId: result.id, completionKind: "finished-build", checks: { status: "failed", exitCode: 1, command: "node check.cjs" } } });
      expect(first.artifactsFor(result.id).some(a => a.kind === "proof")).toBe(!direct);
      expect(first.repairChainForRoot("t-check")).toHaveLength(0);
      expect(first.reviewRetryStateOf(result.id)?.state).toBe("unrequested");
      expect(first.openReviewRequests()).toHaveLength(0);
      const failedLog = first.artifactsFor(result.id).find(a => a.kind === "check-log")!;
      first.close();
      if (scenario === "changed-evidence") {
        await writeFile(join(evidenceRoot, failedLog.key), "changed after the failed check was saved");
        const damaged = openStore(db);
        const current = assignmentOf(damaged, "t-check", at(2), { principal: "operator", repos: [repo] }, evidenceRoot)!;
        expect(current).toMatchObject({ state: "ready-to-check", receipt: { checks: { status: "unavailable" } } });
        expect(current.attention).toContainEqual(expect.stringContaining("unavailable or changed"));
        expect(assignmentEvidenceIntact(damaged, evidenceRoot, current.receipt!)).toBe(false);
        damaged.close();
      }
      expect((await tick(at(2), EXIT.refused)).dispatched).toHaveLength(0);
      const final = openStore(db);
      expect(final.runsFor(ref.id)).toEqual(runs);
      expect(final.proofVerdictFor(result.id)).toEqual(proof);
      expect(final.repairChainForRoot("t-check")).toHaveLength(0);
      expect(final.lookupRef("t-check-fix-1")).toBeNull();
      expect(final.openReviewRequests()).toHaveLength(0);
      expect(final.proofAcceptance(result.id)).toBeNull();
      final.close();
      expect({ builds, reviews, fullGates: await readFile(log, "utf8") }).toEqual({ builds: 1, reviews: 0, fullGates: "1" });

    })();
  });

});
