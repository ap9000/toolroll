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
import { SCOUT_BROWSER, scoutBrowser, scrubUrl } from "./scout.js";
import * as projectTools from "./project-tools.js";
import { request as httpRequest } from "node:http";
import { readVerifiedReport } from "./evidence.js";
import { chmodSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
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

  test("items and images: capped, cited with http(s) URLs, and an item's picture names one of the images", () => {
    const item = (index: number) => ({ title: `Finding ${index}`, why: "It matters.", url: `https://example.com/${index}` });
    const good = parseReport(JSON.stringify({ title: "t", summary: "s", report: "r",
      items: [{ ...item(1), image: "home.png" }, item(2)], images: [{ file: "home.png", caption: "The home page", url: "https://example.com/" }] }));
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.report.items).toEqual([{ ...item(1), image: "home.png" }, { ...item(2), image: null }]);
      expect(good.report.images).toEqual([{ file: "home.png", caption: "The home page", url: "https://example.com/" }]);
    }
    const old = parseReport(JSON.stringify({ title: "t", summary: "s", report: "r" }));
    expect(old.ok && old.report.items.length === 0 && old.report.images.length === 0).toBe(true);
    const reasons = (body: Record<string, unknown>) => { const read = parseReport(JSON.stringify({ title: "t", summary: "s", report: "r", ...body })); return read.ok ? [] : read.problems.map(one => one.reason); };
    expect(reasons({ items: Array.from({ length: REPORT_LIMITS.items + 1 }, (_, index) => item(index)) })).toContain("items-too-many");
    expect(reasons({ images: Array.from({ length: REPORT_LIMITS.images + 1 }, (_, index) => ({ file: `${index}.png`, caption: "c", url: "https://example.com/" })) })).toContain("images-too-many");
    expect(reasons({ items: [{ ...item(1), image: "nowhere.png" }] })).toContain("items[0]-image");
    expect(reasons({ items: [{ ...item(1), url: "file:///etc/passwd" }] })).toContain("items[0].url-not-a-link");
    expect(reasons({ images: [{ file: "a.png", caption: "two\nlines", url: "https://example.com/" }] })).toContain("images[0]-caption-multiline");
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
  const ASKED = {
    urgency: "blocking",
    recap: "Two suites fail differently.",
    question: "Which suite matters?",
    options: [
      { id: "unit", label: "Unit", consequence: "Faster, narrower.", reversible: true },
      { id: "e2e", label: "End to end", consequence: "Slower, the real flake.", reversible: true },
    ],
    recommendation: "e2e",
  };
  const planModeAgent = (structured: unknown, files: { report?: unknown } = {}): Runner => async (_file, args, options) => {
    argvSeen = [...args];
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    planWrite(options);
    // The fallback channel a session could still use outside plan mode.
    const name = REPORT_FILE.exec(prompt)?.[0];
    if (files.report !== undefined && name !== undefined) await writeFile(join(options?.cwd ?? "", name), JSON.stringify(files.report));
    const result = structured === undefined
      ? { type: "result", subtype: "success", is_error: false, result: "I wrote my findings to the plan file." }
      : { type: "result", subtype: "success", is_error: false, result: "", structured_output: structured };
    return { ...OK, stdout: JSON.stringify(result) };
  };

  test("a Claude scout returns its report as structured output and the run succeeds", async () => {
    const { runnerToken } = await setup();
    const reported = await tick(runnerToken, planModeAgent({ kind: "report", report: FOUND }));
    expect(reported).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
    // Read-only by permission (dontAsk, no edit tools allowed); the report schema rides beside it.
    expect(argvSeen[argvSeen.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(argvSeen).not.toContain("--dangerously-skip-permissions");
    const schema = JSON.parse(argvSeen[argvSeen.indexOf("--json-schema") + 1] ?? "{}");
    expect(schema).toMatchObject({ required: ["kind"], properties: { kind: { enum: ["report", "question"] } } });
    expect(schema.properties.report.required).toEqual(["title", "summary", "report"]);
    expect(schema.properties.decision.required).toEqual(["urgency", "recap", "question", "options", "recommendation"]);
    expect(prompts.at(-1)).toContain("final structured");
    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    expect(store.getTask("flaky")?.state).toBe("done");
    const view = readVerifiedReport(store, join(base, "evidence"), ref.id);
    expect(view !== null && view.ok && view.report.title).toBe(FOUND.title);
    store.close();
  });

  /** A real-enough PNG: signature and IHDR, so it sniffs and measures like a screenshot. */
  const png = (width = 1280, height = 800, size = 2_048) => {
    const bytes = Buffer.alloc(size);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  };
  let folderSeen = "";
  /** The scout browser's launch arguments, from the launch's own MCP config (none when it has no browser). */
  const browserLaunch = (args: readonly string[]): string[] => {
    for (const [at, arg] of args.entries()) {
      if (arg !== "--mcp-config" || !String(args[at + 1]).startsWith("{")) continue;
      const browser = JSON.parse(String(args[at + 1])).mcpServers?.[SCOUT_BROWSER];
      if (browser !== undefined) return (browser.args as unknown[]).map(String);
    }
    return [];
  };
  /** Where the scout's browser saves its screenshots: its `--output-dir`. */
  const browserFolder = (args: readonly string[]): string => {
    const launch = browserLaunch(args);
    return launch.includes("--output-dir") ? String(launch[launch.indexOf("--output-dir") + 1]) : "";
  };
  /** A scout that saves screenshots in its output folder, some of which the runner must refuse. */
  const imagingAgent = (images: Record<string, Buffer | { link: string }>, report: Record<string, unknown>, outside?: Buffer): Runner => async (_file, args, options) => {
    const prompt = String(args[args.indexOf("-p") + 1] ?? "");
    prompts.push(prompt);
    argvSeen = [...args];
    folderSeen = browserFolder(args);
    expect(prompt).toContain(folderSeen);
    expect(folderSeen.startsWith(realpathSync(options?.cwd ?? ""))).toBe(false);
    for (const [name, content] of Object.entries(images)) {
      if (Buffer.isBuffer(content)) await writeFile(join(folderSeen, name), content);
      else symlinkSync(content.link, join(folderSeen, name));
    }
    if (outside !== undefined) await writeFile(join(folderSeen, "..", "outside.png"), outside);
    const result = { type: "result", subtype: "success", is_error: false, result: "", structured_output: { kind: "report", report } };
    return { ...OK, stdout: JSON.stringify(result) };
  };

  test("a scout's items and screenshots arrive: each image verified and stored as evidence, the tree proof intact, refused images named", async () => {
    const { runnerToken } = await setup();
    const shot = png();
    const secret = join(base, "secret.png");
    await writeFile(secret, png());
    const items = [
      { title: "The pricing page hides the annual plan", why: "Visitors only see monthly prices.", url: "https://example.com/pricing", image: "pricing.png" },
      { title: "The sign-up form asks for a phone number", why: "It is required and unexplained.", url: "https://example.com/signup", image: "huge.png" },
      { title: "Docs link to a dead page", why: "The quick start 404s.", url: "https://example.com/docs", image: "notes.png" },
      { title: "Footer copy is out of date", why: "It says 2024.", url: "https://example.com/", image: "linked.png" },
      { title: "A file outside the folder", why: "Must not be read.", url: "https://example.com/x", image: "../outside.png" },
    ];
    const images = [
      { file: "pricing.png", caption: "The pricing page", url: "https://example.com/pricing" },
      { file: "huge.png", caption: "The sign-up form", url: "https://example.com/signup" },
      { file: "notes.png", caption: "Not an image", url: "https://example.com/docs" },
      { file: "linked.png", caption: "A link elsewhere", url: "https://example.com/" },
      { file: "../outside.png", caption: "Outside", url: "https://example.com/x" },
    ];
    const agent = imagingAgent(
      { "pricing.png": shot, "huge.png": png(1280, 800, 5 * 1024 * 1024 + 1), "notes.png": Buffer.from("just text, named like a picture"), "linked.png": { link: secret } },
      { ...FOUND, items, images }, png());
    expect(await tick(runnerToken, agent)).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
    expect(prompts.at(-1)).toContain("Never download anything else, and never run downloaded code");
    expect(prompts.at(-1)).not.toContain("plan file");
    expect(prompts.at(-1)).toContain("Cite the URL");
    // The real scout can take them: research and screenshot tools allowed, nothing that edits or runs commands.
    expect(argvSeen[argvSeen.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    const allowed = String(argvSeen[argvSeen.indexOf("--allowedTools") + 1]).split(",");
    expect(allowed).toEqual(expect.arrayContaining(["WebSearch", "WebFetch", `mcp__${SCOUT_BROWSER}__browser_navigate`, `mcp__${SCOUT_BROWSER}__browser_take_screenshot`]));
    expect(allowed.some(tool => /^(Bash|Write|Edit|NotebookEdit)\b/.test(tool))).toBe(false);
    expect(argvSeen).toContain("--strict-mcp-config");
    // Its browser goes through the public-web-only proxy, loopback included, and never opens files.
    const launch = browserLaunch(argvSeen);
    expect(launch[launch.indexOf("--proxy-server") + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(launch[launch.indexOf("--proxy-bypass") + 1]).toBe("<-loopback>");
    expect(launch).not.toContain("--allow-unrestricted-file-access");
    expect(argvSeen).not.toContain("--dangerously-skip-permissions");
    // The folder was the run's own, outside the checkout, and is gone afterwards.
    expect(folderSeen).not.toBe("");
    expect(existsSync(folderSeen)).toBe(false);

    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    expect(store.runsFor(ref.id)[0]).toMatchObject({ role: "scout", outcome: "built", reason: "report-delivered" });
    const view = readVerifiedReport(store, join(base, "evidence"), ref.id);
    expect(view?.ok).toBe(true);
    if (view !== null && view.ok) {
      const sha = createHash("sha256").update(shot).digest("hex");
      expect(view.report.images).toEqual([expect.objectContaining({ file: "pricing.png", caption: "The pricing page", url: "https://example.com/pricing", sha256: sha })]);
      const artifact = store.artifactsFor(view.run).find(one => one.id === view.report.images[0]!.artifact);
      expect(artifact).toMatchObject({ kind: "screenshot", sha256: sha });
      expect(artifact?.capture).toContain("https://example.com/pricing");
      expect(store.artifactsFor(view.run).filter(one => one.kind === "screenshot")).toHaveLength(1);
      expect(view.shots).toEqual([expect.objectContaining({ file: "pricing.png", artifactId: artifact!.id, problem: null })]);
      // Every item arrives; only the verified picture stays tied to its item.
      expect(view.report.items.map(one => one.image)).toEqual(["pricing.png", null, null, null, null]);
      expect(view.report.report).toContain("huge.png (over 5 MB)");
      expect(view.report.report).toContain("notes.png (not a PNG or JPEG)");
      expect(view.report.report).toContain("linked.png (a link, not a file)");
      expect(view.report.report).toContain("../outside.png (not a PNG or JPEG file name in the screenshot folder)");
    }
    store.close();
  });

  test("while the scout runs, its browser's proxy refuses this machine and private addresses", async () => {
    const { runnerToken } = await setup();
    const answers: number[] = [];
    const probing: Runner = async (_file, args, options) => {
      const launch = browserLaunch(args);
      const proxy = new URL(String(launch[launch.indexOf("--proxy-server") + 1]));
      const through = (path: string, method = "GET") => new Promise<number>((done, fail) => {
        const sent = httpRequest({ host: proxy.hostname, port: Number(proxy.port), method, path, headers: { host: "x" } });
        sent.on("connect", (answer, socket) => { socket.destroy(); done(answer.statusCode ?? 0); });
        sent.on("response", answer => { answer.resume(); done(answer.statusCode ?? 0); });
        sent.on("error", fail);
        sent.end();
      });
      answers.push(await through("http://127.0.0.1:9/"), await through("http://localhost/"), await through("http://10.0.0.1/"),
        await through("169.254.169.254:443", "CONNECT"), await through("[::1]:443", "CONNECT"));
      return planModeAgent({ kind: "report", report: FOUND })(_file, args, options);
    };
    expect(await tick(runnerToken, probing)).toBe(EXIT.ok);
    expect(answers).toEqual([403, 403, 403, 403, 403]);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
  });

  test("with no Playwright entry the scout researches without a browser instead of failing", async () => {
    const { runnerToken } = await setup();
    const missing = vi.spyOn(projectTools, "catalogTool").mockImplementation(() => null);
    try {
      expect(await tick(runnerToken, planModeAgent({ kind: "report", report: FOUND }))).toBe(EXIT.ok);
    } finally {
      missing.mockRestore();
    }
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
    expect(browserLaunch(argvSeen)).toEqual([]);
    expect(String(argvSeen[argvSeen.indexOf("--allowedTools") + 1]).split(",")).toEqual(["WebSearch", "WebFetch"]);
    expect(prompts.at(-1)).toContain("No browser is available for screenshots in this run");
    expect(prompts.at(-1)).not.toContain(SCOUT_BROWSER);
    expect(scoutBrowser(null, "/tmp/shots", "http://127.0.0.1:1")).toBeNull();
  });

  test("secrets are scrubbed from item and image URLs, captions and file names before they are stored or passed on", async () => {
    const { runnerToken } = await setup();
    const token = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5";
    const secretFile = `${token}.png`;
    const items = [
      { title: "The callback leaks its token", why: "It is in the address bar.", url: `https://app.example.com/callback?access_token=${token}&page=2#id_token=abc`, image: secretFile },
      { title: "A signed download link", why: "It is shared publicly.", url: `https://files.example.com/${token}/report.pdf?X-Amz-Signature=deadbeef`, image: null },
    ];
    const images = [{ file: secretFile, caption: `Signed in with ${token}`, url: `https://app.example.com/callback?code=1234&state=ok` }];
    expect(await tick(runnerToken, imagingAgent({ [secretFile]: png() }, { ...FOUND, items, images }))).toBe(EXIT.ok);
    const store = openStore(db);
    const ref = store.refFor("built-in", "flaky");
    const view = readVerifiedReport(store, join(base, "evidence"), ref.id);
    expect(view?.ok).toBe(true);
    if (view !== null && view.ok) {
      expect(view.report.items.map(one => one.url)).toEqual([
        "https://app.example.com/callback?access_token=REDACTED&page=2",
        "https://files.example.com/REDACTED/report.pdf?X-Amz-Signature=REDACTED",
      ]);
      expect(view.report.images).toEqual([expect.objectContaining({ file: "screenshot-1.png", url: "https://app.example.com/callback?code=REDACTED&state=ok" })]);
      expect(view.report.images[0]!.caption).toContain("[redacted");
      expect(view.report.items[0]!.image).toBe("screenshot-1.png");
      const stored = store.artifactsFor(view.run);
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(readFileSync(join(base, "evidence", String(view.run), "report.json"), "utf8")).not.toContain(token);
    }
    store.close();
    expect(scrubUrl("https://example.com/pricing?plan=annual").url).toBe("https://example.com/pricing?plan=annual");
  });

  test("structured output never skips the clean-tree proof", async () => {
    const { runnerToken } = await setup();
    const sneaky: Runner = async (file, args, options) => {
      await writeFile(join(options?.cwd ?? "", "sneaky.ts"), "export const smuggled = true;\n");
      return planModeAgent({ kind: "report", report: FOUND })(file, args, options);
    };
    expect(await tick(runnerToken, sneaky)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "failed", reason: "dirty-tree" }));
    const store = openStore(db);
    expect(store.latestReportArtifact(store.refFor("built-in", "flaky").id)).toBeNull();
    store.close();
  });

  test("a structured report over the caps is still refused", async () => {
    const { runnerToken } = await setup();
    const failed = await tick(runnerToken, planModeAgent({ kind: "report", report: { ...FOUND, report: "x".repeat(REPORT_LIMITS.document + 1) } }));
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
    expect(await tick(runnerToken, planModeAgent({ kind: "report", report: FOUND }), new Date(at + 60_000))).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
  });

  test("a Claude scout parks a question through structured output; the task waits on that decision", async () => {
    const { runnerToken, approverToken } = await setup();
    expect(await tick(runnerToken, planModeAgent({ kind: "question", decision: ASKED }))).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "parked" }));
    expect(argvSeen[argvSeen.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(prompts.at(-1)).toContain('kind "question"');
    const store = openStore(db);
    const decision = store.listDecisions("unanswered")[0];
    expect(decision?.question).toBe("Which suite matters?");
    expect(store.getTask("flaky")?.state).not.toBe("done");
    store.close();
    await run(["decide", String(decision?.id), "--choose", "e2e", "--as", "alex", "--token", approverToken, "--json"], reportingAgent, new Date(T0.getTime() + 60_000));
    expect(await tick(runnerToken, planModeAgent({ kind: "report", report: FOUND }), new Date(T0.getTime() + 2 * 60_000))).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
    expect(prompts.at(-1)).toContain("Which suite matters?");
  });

  test("a structured question that is not a decision is refused like a bad park file", async () => {
    const { runnerToken } = await setup();
    expect(await tick(runnerToken, planModeAgent({ kind: "question", decision: { ...ASKED, recommendation: "nope" } }))).toBe(EXIT.failed);
    const store = openStore(db);
    expect(store.listDecisions("unanswered")).toHaveLength(0);
    expect(store.openIncidents().some(one => one.kind === "malformed-decision")).toBe(true);
    store.close();
  });

  test.each([
    ["over the caps", { kind: "report", report: { ...FOUND, title: "x".repeat(REPORT_LIMITS.title + 1) } }],
    ["missing its body", { kind: "report" }],
    ["an invalid question", { kind: "question", decision: { ...ASKED, options: [] } }],
  ])("an invalid structured payload (%s) falls back to a valid report file", async (_label, structured) => {
    const { runnerToken } = await setup();
    expect(await tick(runnerToken, planModeAgent(structured, { report: FOUND }))).toBe(EXIT.ok);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "reported" }));
    const store = openStore(db);
    const view = readVerifiedReport(store, join(base, "evidence"), store.refFor("built-in", "flaky").id);
    expect(view !== null && view.ok && view.report.title).toBe(FOUND.title);
    expect(store.listDecisions("unanswered")).toHaveLength(0);
    store.close();
  });

  test("only structured_output counts: a report spoken as prose JSON is not a handback", async () => {
    const { runnerToken } = await setup();
    const prose: Runner = async (_file, args) => {
      prompts.push(String(args[args.indexOf("-p") + 1] ?? ""));
      return { ...OK, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ kind: "report", report: FOUND }) }) };
    };
    expect(await tick(runnerToken, prose)).toBe(EXIT.failed);
    expect(payload().dispatched).toContainEqual(expect.objectContaining({ id: "flaky", outcome: "failed", reason: "no-op" }));
    const store = openStore(db);
    expect(store.latestReportArtifact(store.refFor("built-in", "flaky").id)).toBeNull();
    store.close();
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
