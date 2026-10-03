import { currentClaim } from "./claim.js";
import * as projectSkills from "./project-skills.js";
/**
 * Scout tasks (mate arc §10), end to end against real git: a task filed
 * with --report, its scope approved like any other, a scout dispatched on
 * the planner's read-only road, and a report — never a branch — sealed as
 * evidence. Only the agent is a stub. The workspace proof is exercised
 * adversarially exactly as the planner's is: a scout that touches the tree
 * gets nothing ingested.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import { fileTaskProposal } from "./proposal.js";
import { parseReport, REPORT_LIMITS } from "./scout-report.js";
import { readVerifiedReport } from "./evidence.js";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { Runner } from "./builder.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-09-02T22:00:00.000Z");
const SAID = JSON.stringify({ result: "scouting" });

const REPORT_FILE = /STANDING-ORDERS-REPORT-[0-9a-f]{16}\.json/;
const PARK_FILE = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/;

describe("the report parser (422 rule)", () => {
  test("a well-formed report parses; every problem is reported at once; caps and controls refuse", () => {
    const good = parseReport(JSON.stringify({ title: "Login flakes on CI", summary: "The test races the session cookie.", report: "## Findings\n…", followUps: [{ title: "Await the cookie", goal: "Wait for the cookie before asserting." }] }));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.report.followUps).toHaveLength(1);

    const bad = parseReport(JSON.stringify({ title: "a\nb", summary: "", report: 7, followUps: [{ title: "x" }, "y"] }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const reasons = bad.problems.map(one => one.reason);
      expect(reasons).toContain("title-multiline");
      expect(reasons).toContain("missing-summary");
      expect(reasons).toContain("bad-report");
      expect(reasons).toContain("missing-followUps[0].goal");
      expect(reasons).toContain("followUps[1]-shape");
    }
    const tooMany = parseReport(JSON.stringify({ title: "t", summary: "s", report: "r", followUps: Array.from({ length: REPORT_LIMITS.followUps + 1 }, () => ({ title: "t", goal: "g" })) }));
    expect(tooMany.ok).toBe(false);
    const controls = parseReport(JSON.stringify({ title: "t", summary: "s\u001b[31m", report: "r" }));
    expect(controls.ok).toBe(false);
    expect(parseReport("not json").ok).toBe(false);
  });

  test("caps are bytes, not characters; a summary is one paragraph (v4 review, findings 11)", () => {
    // 30,000 CJK characters are ~90 KiB: under the character count, over the byte cap.
    const cjk = "漢".repeat(30_000);
    const overBytes = parseReport(JSON.stringify({ title: "t", summary: "s", report: cjk }));
    expect(overBytes.ok).toBe(false);
    if (!overBytes.ok) expect(overBytes.problems.map(one => one.reason)).toContain("report-too-long");
    const twoParagraphs = parseReport(JSON.stringify({ title: "t", summary: "first.\n\nsecond.", report: "r" }));
    expect(twoParagraphs.ok).toBe(false);
    if (!twoParagraphs.ok) expect(twoParagraphs.problems.map(one => one.reason)).toContain("summary-paragraphs");
    expect(parseReport(JSON.stringify({ title: "t", summary: "one line,\nwrapped.", report: "r" })).ok).toBe(true);
  });
});

describe("scout tasks, against real git", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  let prompts: string[] = [];

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });
  const payload = () => JSON.parse(lines.join("\n"));

  const run = (argv: string[], runner: Runner, now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, agentRunner: runner });
  };

  /** A scout that concludes with a well-formed report. */
  const reportingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    options?.onSpawn?.(1_000_001);
    // The note may also carry this host's boot identity (v53).
    expect(readFileSync(join(cwd, ".standing-orders-lease"), "utf8")).toMatch(/^1000001 builder-1 group ([0-9a-f-]{36}|unknown) \S+\n$/);
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    const name = REPORT_FILE.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") {
      await writeFile(
        join(cwd, name),
        JSON.stringify({
          title: "Login flakes because the cookie races the assertion",
          summary: "The login test reads the session cookie before the response sets it; under load the read wins.",
          report: "## Findings\nThe cookie is set asynchronously in src/session.ts.\n",
          followUps: [{ title: "Await the session cookie in the login test", goal: "The login test waits for the cookie before asserting; no more flakes in 50 runs." }],
        }),
      );
    }
    return { ...OK, stdout: SAID };
  };

  /** A scout that needs the operator first. */
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
          recap: "Two suites fail differently.",
          question: "Which suite matters?",
          options: [
            { id: "unit", label: "Unit", consequence: "Faster, narrower.", reversible: true },
            { id: "e2e", label: "End to end", consequence: "Slower, the real flake.", reversible: true },
          ],
          recommendation: "e2e",
        }),
      );
    }
    return { ...OK, stdout: SAID };
  };

  /** A scout that quotes a credential it found: redacted before anything stores or pages it. */
  const leakingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    const name = REPORT_FILE.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") {
      await writeFile(
        join(cwd, name),
        JSON.stringify({
          title: "A key sits in the fixture",
          summary: "The fixture carries AKIAIOSFODNN7EXAMPLE in plain text.",
          report: "## Finding\nline one\nthe key AKIAIOSFODNN7EXAMPLE again\nline three\n",
          followUps: [],
        }),
      );
    }
    return { ...OK, stdout: SAID };
  };

  /** A scout that writes an IGNORED file: invisible to plain status, foreign to the proof. */
  const ignoredVandal: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    const name = REPORT_FILE.exec(prompt)?.[0];
    if (cwd !== "") {
      mkdirSync(join(cwd, "build"), { recursive: true });
      await writeFile(join(cwd, "build", "out.txt"), "generated\n");
      if (name !== undefined) await writeFile(join(cwd, name), JSON.stringify({ title: "t", summary: "s", report: "r" }));
    }
    return { ...OK, stdout: SAID };
  };

  /** A scout that STAGES its own report: cleanup would leave it in the index. */
  const stagingVandal: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    const name = REPORT_FILE.exec(prompt)?.[0];
    if (cwd !== "" && name !== undefined) {
      await writeFile(join(cwd, name), JSON.stringify({ title: "t", summary: "s", report: "r" }));
      await exec("git", ["add", "-f", name], { cwd });
    }
    return { ...OK, stdout: SAID };
  };

  /** A scout whose park mailbox is not a decision. */
  const malformedParker: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    const name = PARK_FILE.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), JSON.stringify({ question: 7 }));
    return { ...OK, stdout: SAID };
  };

  /** A scout that edits the repo — the one thing it must never do. */
  const vandalAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    const name = REPORT_FILE.exec(prompt)?.[0];
    if (cwd !== "") {
      await writeFile(join(cwd, "sneaky.ts"), "export const smuggled = true;\n");
      if (name !== undefined) {
        await writeFile(join(cwd, name), JSON.stringify({ title: "t", summary: "s", report: "r" }));
      }
    }
    return { ...OK, stdout: SAID };
  };

  const malformedAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    const name = REPORT_FILE.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), JSON.stringify({ title: "", report: 42 }));
    return { ...OK, stdout: SAID };
  };

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-scout-")));
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
    await rm(base, { recursive: true, force: true });
  });

  const setup = async (provider: "claude" | "codex" = "claude") => {
    const runnerToken = "tok-builder-1";
    {
      const store = openStore(db);
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => runnerToken });
      const model = provider === "claude" ? "sonnet" : "gpt-5-codex";
      store.setPhaseConfig("installation", "build", provider, model, "test", new Date("2026-08-11T00:00:00.000Z"));
      store.setPhaseConfig("installation", "plan", provider, model, "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", provider, model, "test", new Date("2026-08-11T00:00:00.000Z"));
      store.close();
    }
    await run(["approver", "add", "alex", "--json"], reportingAgent);
    const approverToken = payload().token as string;
    await run(["task", "add", "why does login flake", "--id", "flaky", "--repo", repo, "--report", "--json"], reportingAgent);
    expect(payload().ok).toBe(true);
    await run(["task", "scope", "flaky", "--goal", "Find out why the login test flakes on CI and say what would fix it", "--acceptance", "It is fixed and verified.|manual-review", "--json"], reportingAgent);
    expect(payload().ok).toBe(true);
    const store = openStore(db);
    const digest = store.getScope("flaky")?.digest as string;
    expect(store.refFor("built-in", "flaky").deliverable).toBe("report");
    store.close();
    await run(["task", "approve", "flaky", "--as", "alex", "--token", approverToken, "--digest", digest, "--yes", "--json"], reportingAgent);
    expect(payload().ok).toBe(true);
    return { runnerToken, approverToken };
  };

  const tick = (runnerToken: string, agent: Runner, now = T0) =>
    run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"], agent, now);

  test("unreadable skill context settles a failed attempt without provider spend", async () => {
    const { runnerToken } = await setup();
    const failure = vi.spyOn(projectSkills, "skillsContext").mockImplementationOnce(() => { throw Error("Saved skill package failed verification."); });
    try {
      await tick(runnerToken, reportingAgent);
      expect(prompts).toHaveLength(0);
      const saved = openStore(db);
      try {
        const ref = saved.refFor("built-in", "flaky");
        const run = saved.runsFor(ref.id)[0];
        expect(run).toMatchObject({ outcome: "failed", reason: "Project skills could not be loaded: Saved skill package failed verification.", providerStartedAt: null });
        expect(run?.finishedAt).not.toBeNull();
        expect(currentClaim(saved, ref.id, T0)).toBeNull();
      } finally { saved.close(); }
    } finally { failure.mockRestore(); }
  });

  test("the whole road: filed --report, approved, scouted, reported — a report, never a branch; the follow-up files with the scout's authorship", async () => {
    const { runnerToken } = await setup();

    const reported = await tick(runnerToken, reportingAgent);
    expect(reported).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
    // The brief carried the goal as data and named the report protocol file.
    expect(prompts.some(one => one.includes("You are a SCOUT") && one.includes("Find out why the login test flakes"))).toBe(true);

    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    expect(store.getTask("flaky")?.state).toBe("done");
    const runs = store.runsFor(ref.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ role: "scout", outcome: "built", reason: "report-delivered" });
    expect(store.latestReportArtifact(ref.id)).not.toBeNull();
    const view = readVerifiedReport(store, join(base, "evidence"), ref.id);
    expect(view).not.toBeNull();
    if (view !== null && view.ok) {
      expect(view.report.title).toContain("cookie races");
      expect(view.report.followUps[0]?.title).toContain("Await the session cookie");
    }
    // Routine, not urgent: the outbox row carries the summary and no push class.
    const ready = store.listNotifications("all").find(one => one.kind === "report-ready");
    expect(ready).toBeDefined();
    expect(ready?.pushClass).toBeNull();
    expect(ready?.body).toContain("the session cookie");
    // No builder branch was ever created; the scout's disposable checkout
    // and branch are gone after the run (v4 review, finding 3).
    expect((await git(["rev-parse", "--verify", "--quiet", "refs/heads/standing-orders/flaky"])).code).not.toBe(0);
    const branches = (await git(["branch", "--list", "standing-orders-scout/*"])).stdout.trim();
    expect(branches).toBe("");
    expect(store.listWorktrees().filter(one => one.branch.startsWith("standing-orders-scout/"))).toHaveLength(0);
    expect(existsSync(join(pool, "flaky"))).toBe(false);
    expect(store.pendingPublications()).toHaveLength(0);

    // The follow-up files through the one door with the scout's authorship — mode coverage never seals it.
    const filed = fileTaskProposal(store, { title: "Await the session cookie", repo, goal: "wait first", acceptance: [{ id: "c1", statement: "The session cookie is awaited.", evidence: ["manual-review"] }], filedVia: "console", proposedVia: "scout" }, T0);
    expect(filed.ok).toBe(true);
    if (filed.ok) {
      expect(store.handle.prepare("SELECT proposed_via FROM task_scope WHERE task_id = ?").get(filed.id)?.["proposed_via"]).toBe("scout");
      expect(store.refFor("built-in", filed.id).deliverable).toBe("branch");
    }
    store.close();

    // task show prints the report's title and summary.
    await run(["task", "show", "flaky"], reportingAgent);
    expect(lines.join("\n")).toContain("report: Login flakes because the cookie races the assertion");
    expect(lines.join("\n")).toContain("follow-up 1: Await the session cookie");
  });

  test("a scout that touches the tree gets nothing ingested; the task takes a strike and backs off; the deliverable never changes after filing", async () => {
    const { runnerToken } = await setup();
    const failed = await tick(runnerToken, vandalAgent);
    expect(failed).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "failed", reason: "dirty-tree" }));
    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    expect(ref.strikes).toBe(1);
    expect(ref.planStrikes).toBe(0);
    expect(store.getTask("flaky")?.state).toBe("queued");
    expect(store.latestReportArtifact(ref.id)).toBeNull();
    expect(store.activeHolds(ref.id, T0).some(one => one.ownerKind === "backoff")).toBe(true);
    store.close();
    // No API changes a deliverable after filing; --report on a tracker backend refuses up front.
    await run(["task", "add", "x", "--backend", "github-issues", "--report", "--json"], reportingAgent);
    expect(payload()).toMatchObject({ ok: false, reason: "usage" });
  });

  test("the proof sees ignored writes and staged protocol files (v4 review, finding 4)", async () => {
    const { runnerToken } = await setup();
    // A committed .gitignore: the ignored write is invisible to plain status.
    await writeFile(join(repo, ".gitignore"), "build/\n");
    await git(["add", ".gitignore"]);
    await git(["commit", "-qm", "ignore build"]);
    const ignored = await tick(runnerToken, ignoredVandal);
    expect(ignored).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "failed", reason: "dirty-tree" }));
    const staged = await tick(runnerToken, stagingVandal, new Date(T0.getTime() + 5 * 60_000));
    expect(staged).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "failed", reason: "dirty-tree" }));
    const store = openStore(db);
    expect(store.latestReportArtifact(store.refFor("built-in", "flaky").id)).toBeNull();
    expect(store.refFor("built-in", "flaky").strikes).toBe(2);
    store.close();
  });

  test("a report that cannot be stored is a failed attempt, never a finished task (v4 review, finding 1)", async () => {
    const { runnerToken } = await setup();
    const evidence = join(base, "evidence");
    mkdirSync(evidence, { recursive: true });
    chmodSync(evidence, 0o500);
    try {
      const failed = await tick(runnerToken, reportingAgent);
      expect(failed).toBe(EXIT.failed);
      expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "failed", reason: "capture-failed" }));
      const store = openStore(db);
      expect(store.getTask("flaky")?.state).toBe("queued");
      expect(store.refFor("built-in", "flaky").strikes).toBe(1);
      expect(store.listNotifications("all").some(one => one.kind === "report-ready")).toBe(false);
      store.close();
    } finally {
      chmodSync(evidence, 0o700);
    }
  });

  test("a credential the scout quotes is redacted before it is stored or paged (v4 review, finding 8)", async () => {
    const { runnerToken } = await setup();
    const reported = await tick(runnerToken, leakingAgent);
    expect(reported).toBe(EXIT.ok);
    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    const artifact = store.latestReportArtifact(ref.id);
    expect(artifact?.redacted).toBe(true);
    const view = readVerifiedReport(store, join(base, "evidence"), ref.id);
    expect(view !== null && view.ok).toBe(true);
    if (view !== null && view.ok) {
      expect(view.report.summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(view.report.report).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(view.report.report).toContain("line one");
    }
    const ready = store.listNotifications("all").find(one => one.kind === "report-ready");
    expect(ready?.body).not.toContain("AKIAIOSFODNN7EXAMPLE");
    store.close();
  });

  test("a malformed park mailbox is a malformed-decision incident, not a malformed report (v4 review, finding 12)", async () => {
    const { runnerToken } = await setup();
    const failed = await tick(runnerToken, malformedParker);
    expect(failed).toBe(EXIT.failed);
    const store = openStore(db);
    const kinds = store.openIncidents().map(one => one.kind);
    expect(kinds).toContain("malformed-decision");
    expect(kinds).not.toContain("malformed-report");
    expect(store.listNotifications("all").some(one => one.kind === "malformed-decision")).toBe(true);
    store.close();
  });

  test("a malformed report is a durable incident, not a silent retry", async () => {
    const { runnerToken } = await setup();
    const failed = await tick(runnerToken, malformedAgent);
    expect(failed).toBe(EXIT.failed);
    const store = openStore(db);
    expect(store.openIncidents().some(one => one.kind === "malformed-report")).toBe(true);
    expect(store.refFor("built-in", "flaky").strikes).toBe(0);
    store.close();
    const again = await tick(runnerToken, reportingAgent, new Date(T0.getTime() + 60_000));
    expect(again).toBe(EXIT.refused);
  });

  test("a scout may park a question; the answer rides the next brief and the report lands", async () => {
    const { runnerToken, approverToken } = await setup();
    const asked = await tick(runnerToken, askingAgent);
    expect(asked).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "parked" }));
    const store = openStore(db);
    const decision = store.listDecisions("unanswered")[0];
    expect(decision?.question).toBe("Which suite matters?");
    store.close();
    await run(["decide", String(decision?.id), "--choose", "e2e", "--as", "alex", "--token", approverToken, "--json"], reportingAgent, new Date(T0.getTime() + 60_000));
    const reported = await tick(runnerToken, reportingAgent, new Date(T0.getTime() + 2 * 60_000));
    expect(reported).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
    expect(prompts.some(one => one.includes("Which suite matters?") && one.includes("e2e"))).toBe(true);
    const after = openStore(db);
    expect(after.getTask("flaky")?.state).toBe("done");
    expect(after.runsFor(after.refFor("built-in", "flaky").id).map(one => one.role).sort()).toEqual(["scout", "scout"]);
    after.close();
  });

  /** Run 2334's Claude: plan mode refuses every write but its own plan file, so the report rides structured output. */
  const FOUND = {
    title: "Login flakes because the cookie races the assertion",
    summary: "The login test reads the session cookie before the response sets it.",
    report: "## Findings\nThe cookie is set asynchronously in src/session.ts.\n",
    followUps: [{ title: "Await the session cookie", goal: "The login test waits for the cookie before asserting." }],
  };
  const planWrite = (options: Parameters<Runner>[2]) =>
    options?.onStreamEvent?.({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/Users/someone/.claude/plans/you-are-a-scout-quiet-otter.md", content: "# Findings" } }] } });
  let argvSeen: string[] = [];
  const planModeAgent = (structured: unknown): Runner => async (_file, args, options) => {
    argvSeen = [...args];
    prompts.push(String(args[args.indexOf("-p") + 1] ?? ""));
    planWrite(options);
    const result = structured === undefined
      ? { type: "result", subtype: "success", is_error: false, result: "I wrote my findings to the plan file." }
      : { type: "result", subtype: "success", is_error: false, result: "", structured_output: structured };
    return { ...OK, stdout: JSON.stringify(result) };
  };

  test("a Claude scout under plan mode returns its report as structured output and the run succeeds", async () => {
    const { runnerToken } = await setup();
    const reported = await tick(runnerToken, planModeAgent(FOUND));
    expect(reported).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
    // Plan mode is unchanged; the report schema rides beside it.
    expect(argvSeen[argvSeen.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(argvSeen).not.toContain("--dangerously-skip-permissions");
    expect(JSON.parse(argvSeen[argvSeen.indexOf("--json-schema") + 1] ?? "{}")).toMatchObject({ required: ["title", "summary", "report"] });
    expect(prompts.at(-1)).toContain("final structured");
    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    expect(store.getTask("flaky")?.state).toBe("done");
    const view = readVerifiedReport(store, join(base, "evidence"), ref.id);
    expect(view !== null && view.ok && view.report.title).toBe(FOUND.title);
    store.close();
  });

  test("structured output never skips the clean-tree proof", async () => {
    const { runnerToken } = await setup();
    const sneaky: Runner = async (file, args, options) => {
      await writeFile(join(options?.cwd ?? "", "sneaky.ts"), "export const smuggled = true;\n");
      return planModeAgent(FOUND)(file, args, options);
    };
    expect(await tick(runnerToken, sneaky)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "failed", reason: "dirty-tree" }));
    const store = openStore(db);
    expect(store.latestReportArtifact(store.refFor("built-in", "flaky").id)).toBeNull();
    store.close();
  });

  test("a structured report over the caps is still refused", async () => {
    const { runnerToken } = await setup();
    const failed = await tick(runnerToken, planModeAgent({ ...FOUND, report: "x".repeat(REPORT_LIMITS.document + 1) }));
    expect(failed).toBe(EXIT.failed);
    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    expect(store.latestReportArtifact(ref.id)).toBeNull();
    expect(store.openIncidents().some(one => one.kind === "malformed-report")).toBe(true);
    expect(store.getTask("flaky")?.state).not.toBe("done");
    store.close();
  });

  test("a session that ends with only a plan file fails in plain words; once stalled, task requeue retries it", async () => {
    const { runnerToken, approverToken } = await setup();
    let at = T0.getTime();
    for (let strike = 1; strike <= 3; strike++) {
      expect(await tick(runnerToken, planModeAgent(undefined), new Date(at))).toBe(EXIT.failed);
      expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "failed", reason: "plan-file-only" }));
      at += 30 * 60_000;
    }
    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    const last = store.runsFor(ref.id).at(-1);
    expect(last?.reason).toContain("The scout's findings were written to a plan file it couldn't hand back");
    expect(last?.reason).not.toContain("silence");
    expect(store.getTask("flaky")?.state).toBe("failed");
    expect(store.openIncidents().some(one => one.kind === "attempts-exhausted")).toBe(true);
    store.close();

    await run(["task", "requeue", "flaky", "--as", "alex", "--token", approverToken, "--json"], reportingAgent, new Date(at));
    expect(payload().ok).toBe(true);
    expect(await tick(runnerToken, planModeAgent(FOUND), new Date(at + 60_000))).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
  });

  test("codex has no structured output and keeps the mailbox file", async () => {
    const { runnerToken } = await setup("codex");
    const codexScout: Runner = async (_file, args, options) => {
      argvSeen = [...args];
      const prompt = String(args.at(-1) ?? "");
      prompts.push(prompt);
      const name = REPORT_FILE.exec(prompt)?.[0];
      if (name !== undefined) await writeFile(join(options?.cwd ?? "", name), JSON.stringify(FOUND));
      const lines = [
        { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
        { type: "item.completed", item: { type: "agent_message", text: "Report written." } },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      ];
      return { ...OK, stdout: lines.map(one => JSON.stringify(one)).join("\n") + "\n" };
    };
    expect(await tick(runnerToken, codexScout)).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
    expect(argvSeen[0]).toBe("exec");
    expect(argvSeen).not.toContain("--json-schema");
    expect(prompts.at(-1)).toMatch(/write JSON to a file named exactly\n`STANDING-ORDERS-REPORT-/);
    expect(prompts.at(-1)).not.toContain("structured");
  });

  test("a scout with no plan file and no report keeps the no-op failure", async () => {
    const { runnerToken } = await setup();
    const silent: Runner = async () => ({ ...OK, stdout: SAID });
    expect(await tick(runnerToken, silent)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "failed", reason: "no-op" }));
  });

  test("a builder never takes a report task: the claim gate refuses the role", async () => {
    const { runnerToken } = await setup();
    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    const { acquireIfReady } = await import("./claim.js");
    const refused = acquireIfReady(store, ref.id, "builder-1", { now: T0, ttlMs: 60_000, dispatchRole: "builder", token: runnerToken });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("delivers a report");
    store.close();
  });
});
