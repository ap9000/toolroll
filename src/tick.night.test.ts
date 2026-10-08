/**
 * The M1 acceptance test, the night: the outbox, the morning briefing, a park
 * that survives the night, and the decision or phone tap that resumes it.
 *
 * End to end against real git: the store on disk, the claim and its fence,
 * the worktree pool running actual git, the builder's gates and the commit.
 * Only the agent is a stub — it writes a real file into the real worktree it
 * was given and answers in the CLI's output envelope.
 */

import { saveRepos } from "./repos.js";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { isLifecycleNotification, openStore } from "./store.js";
import type { Runner } from "./builder.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { OK, T0, AGENT_SAID, registerRunner, concludeDone } from "../test/tick-kit.js";

describe("the outbox", () => {
  let base: string;
  let repo: string;
  let db: string;
  let lines: string[] = [];

  const run = (argv: string[]) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now: T0 });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-outbox-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    await mkdir(repo, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("a gap nags once per episode, and again after it recurs", async () => {
    const store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const enqueue = () =>
      store.enqueueNotification(
        { dedupeKey: `gap:${repo}:env:KEY`, kind: "gap", subject: "env:KEY blocks work", body: "…" },
        T0,
      );

    expect(enqueue()).toBe(true);
    expect(enqueue()).toBe(false); // same episode: the cron firing again is not news

    // The gap fills — verification closes the episode…
    store.saveCapability({
      repo, kind: "env", name: "KEY", probe: 'test -n "$KEY"', status: "unprobed",
      addedBy: "alex", createdAt: T0.toISOString(), lastVerifiedAt: null,
      verifiedBy: null, lastResult: null, expiresAt: null,
    });
    store.markCapability(repo, "env", "KEY", { status: "verified", by: "b1" }, T0);

    // …so a recurrence is a new fact, allowed to say so.
    expect(enqueue()).toBe(true);
    store.close();
  });

  test("the outbox only lists: pending facts by default, resolved ones with --all; there is no shell deliverer", async () => {
    const store = openStore(db);
    store.enqueueNotification({ dedupeKey: "n-1", kind: "build-failed", subject: "first", body: "…" }, T0);
    store.enqueueNotification({ dedupeKey: "decision:2", kind: "decision", subject: "second", body: "…" }, T0);
    store.resolveEpisode("decision:2", T0);
    store.close();

    expect(await run(["outbox", "deliver", "--cmd", "true", "--json"])).toBe(EXIT.usage);
    expect(payload()).toMatchObject({ ok: false, command: "outbox", reason: "usage" });

    expect(await run(["outbox", "list", "--json"])).toBe(EXIT.ok);
    expect((payload().notifications as { dedupeKey: string }[]).map(one => one.dedupeKey).filter(key => !key.startsWith("life:"))).toEqual(["n-1"]);
    expect(await run(["outbox", "list", "--all"])).toBe(EXIT.ok);
    expect(lines.join("\n")).toContain("      pending");
    expect(lines.join("\n")).toContain(`      resolved ${T0.toISOString()}`);
  });

  test("a failing build leaves a durable notification with the canonical reason", async () => {
    // Wire the whole path: tick fails a build, the outbox holds the fact.
    await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.email", "t@e.com"], { cwd: repo });
    await exec("git", ["config", "user.name", "T"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "x\n");
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["commit", "-qm", "first"], { cwd: repo });

    const broken: Runner = async () => ({ ...OK, code: 1, stdout: JSON.stringify({ type: "system", subtype: "init" }), stderr: "the model refused" });
    const runWith = (argv: string[]) => {
      const [command = "", ...rest] = argv;
      lines = [];
      return runOperate(command, rest, line => lines.push(line), {
        databaseFile: db,
        now: T0,
        agentRunner: broken,
      });
    };

    const token = registerRunner(db, "builder-1", repo);
    await runWith(["approver", "add", "alex", "--json"]);
    const approver = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await runWith(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approver, "--json"]);
    await runWith(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approver, "--json"]); // v47: every phase names an exact model
    await runWith(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approver, "--json"]);
    await runWith(["task", "add", "the work", "--id", "t-1", "--repo", repo]);
    await runWith(["task", "scope", "t-1", "--goal", "add a guard", "--acceptance", "It is fixed and verified.|manual-review"]);
    await runWith(["task", "approve", "t-1", "--json"]);
    const digest = payload().scope.digest as string;
    await runWith(["task", "approve", "t-1", "--yes", "--digest", digest, "--as", "alex", "--token", approver]);
    await runWith(["tick", "--runner", "builder-1", "--token", token, "--repo", repo, "--pool", join(base, "pool"), "--json"]);

    await run(["outbox", "list", "--json"]);
    // The task's own progress facts (filed, approved, started, phases) sit beside the one page.
    const pages = (payload().notifications as { dedupeKey: string }[]).filter(one => !one.dedupeKey.startsWith("life:"));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      kind: "build-failed",
      subject: "t-1: attempt failed (unknown), retry 1/3",
    });
  });
});

describe("the morning briefing", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  const agent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
    await concludeDone(cwd, args);
    return { ...OK, stdout: AGENT_SAID };
  };
  const broken: Runner = async () => ({ ...OK, code: 1, stdout: JSON.stringify({ type: "system", subtype: "init" }), stderr: "the model refused" });

  const run = (argv: string[], runner: Runner = agent) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now: T0,
      agentRunner: runner,
    });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-brief-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await exec("git", ["config", "user.email", "t@e.com"], { cwd: repo });
    await exec("git", ["config", "user.name", "T"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "x\n");
    await exec("git", ["add", "."], { cwd: repo });
    await exec("git", ["commit", "-qm", "first"], { cwd: repo });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const setup = async () => {
    const token = registerRunner(db, "builder-1", repo);
    await run(["approver", "add", "alex", "--json"]);
    const approver = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approver, "--json"]);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approver, "--json"]); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approver, "--json"]);
    return { token, approver };
  };

  const approvedTask = async (id: string, approver: string) => {
    await run(["task", "add", "the work", "--id", id, "--repo", repo]);
    await run(["task", "scope", id, "--goal", "add a guard", "--acceptance", "It is fixed and verified.|manual-review"]);
    await run(["task", "approve", id, "--json"]);
    const digest = payload().scope.digest as string;
    await run(["task", "approve", id, "--yes", "--digest", digest, "--as", "alex", "--token", approver]);
  };

  test("reports the run tally from the run table, offline, honestly", async () => {
    const { token, approver } = await setup();
    await approvedTask("t-good", approver);
    await approvedTask("t-bad", approver);

    // t-good builds; t-bad fails — two ticks so each outcome lands.
    await run(["tick", "--runner", "builder-1", "--token", token, "--repo", repo, "--pool", pool, "--json"]);
    await run(["tick", "--runner", "builder-1", "--token", token, "--repo", repo, "--pool", pool, "--json"], broken);

    const code = await run(["brief", "--repo", repo, "--local", "--json"]);

    expect(code).toBe(EXIT.ok);
    const report = payload();
    // Both tasks share a frozen creation instant, so which ran first is not
    // promised — one built, one failed, and both are on the record.
    expect(report.tally.built).toHaveLength(1);
    expect(report.tally.built[0]).toMatchObject({ committed: true });
    expect(report.tally.failed).toHaveLength(1);
    expect(report.tally.failed[0]).toMatchObject({ reason: "unknown" });
    const seen = [report.tally.built[0].taskId, report.tally.failed[0].taskId].sort();
    expect(seen).toEqual(["t-bad", "t-good"]);
    // REVIEW was not read, and says so — not "zero PRs".
    expect(report.review).toEqual({ state: "not-read", why: "--local, the network was not asked" });
    // The failed build's notification is waiting.
    expect(report.outboxPending).toBe(1);
  });

  test("the blocked section is the gaps view, ranked", async () => {
    const { approver } = await setup();
    await run(["cap", "add", "MISSING_KEY", "--repo", repo]);
    await approvedTask("t-1", approver);
    await run(["task", "require", "t-1", "--cap", "env:MISSING_KEY"]);

    await run(["brief", "--repo", repo, "--local", "--json"]);

    expect(payload().gaps).toHaveLength(1);
    expect(payload().gaps[0]).toMatchObject({ key: "env:MISSING_KEY", unblocks: ["t-1"] });
  });
});

describe("the park, end to end — a judgement call survives the night", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  /** Parks instead of guessing: reads its mailbox's name from its own brief. */
  const parkingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const mailbox = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (mailbox === undefined) throw new Error("the brief named no mailbox");
    // Work in progress first — the park must preserve it, uncommitted.
    await writeFile(join(cwd, "half-done.ts"), "// the part before the question\n");
    await writeFile(
      join(cwd, mailbox),
      JSON.stringify({
        urgency: "blocking",
        recap: "The guard can fail open or fail closed on timeout, and the scope does not say.",
        question: "Fail open or fail closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "Bad payouts slip through.", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "Payouts pause until retried.", reversible: true },
        ],
        recommendation: "closed",
      }),
    );
    return { ...OK, stdout: JSON.stringify({ result: "parked" }) };
  };

  /** Tries to park and cannot say what, in exactly the same words twice. */
  const babblingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const mailbox = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (mailbox !== undefined) {
      await writeFile(join(cwd, mailbox), JSON.stringify({ urgency: "blocking", recap: "er" }));
    }
    return { ...OK, stdout: JSON.stringify({ result: "tried" }) };
  };

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const run = (argv: string[], runner: Runner = parkingAgent, now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now,
      agentRunner: runner,
    });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-park-e2e-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
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
    const runnerToken = registerRunner(db, "builder-1", repo);
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["task", "add", "the work", "--id", "t-1", "--repo", repo]);
    await run(["task", "scope", "t-1", "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"]);
    await run(["task", "approve", "t-1", "--json"]);
    const digest = payload().scope.digest as string;
    await run([
      "task", "approve", "t-1", "--yes",
      "--digest", digest, "--as", "alex", "--token", approverToken,
    ]);
    return { runnerToken, approverToken };
  };

  const tick = (runnerToken: string, runner: Runner = parkingAgent) =>
    run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      runner,
    );

  test("a park is a pass that exits 0, holds the task, and pages once", async () => {
    const { runnerToken } = await setup();

    const code = await tick(runnerToken);

    // The pass succeeded: nothing broke, the question is where it belongs.
    expect(code).toBe(EXIT.ok);
    expect(payload()).toMatchObject({
      ok: true,
      command: "tick",
      dispatched: [{ id: "t-1", outcome: "parked", reason: "decision:1" }],
    });

    // The decision is real, open, and carries the machine's own evidence.
    const store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    try {
      const decision = store.getDecision(1);
      expect(decision).toMatchObject({ state: "open", recommendation: "closed" });
      const evidence = store.evidenceFor(1);
      expect(evidence.map(artifact => artifact.kind).sort()).toEqual(["diff", "park-payload", "status"]);
      // The task is held by the decision, out of every ready set.
      const holds = store.activeHolds(store.refFor("built-in", "t-1").id, new Date(T0.getTime() + 9e8));
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ ownerKind: "decision" });
      // The run record is canonical: parked, not built, not failed.
      expect(store.getRun(1)).toMatchObject({ outcome: "parked", reason: "decision:1", role: "builder" });
      // Exactly one page, episode-keyed to the decision (beside the task's own progress facts).
      const pending = store.listNotifications("pending").filter(one => !isLifecycleNotification(one));
      expect(pending.map(notification => notification.dedupeKey)).toEqual(["decision:1"]);
    } finally {
      store.close();
    }

    // main never moved, and no commit landed on the task branch.
    const main = await git(["log", "--oneline", "main"]);
    expect(main.stdout.trim().split("\n")).toHaveLength(1);
    const branch = await git(["log", "--oneline", "toolroll/t-1"]);
    expect(branch.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("the work in progress survives the park, uncommitted, where the resume will find it", async () => {
    const { runnerToken } = await setup();
    await tick(runnerToken);

    const store = openStore(db);

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const worktree = store.getRun(1)?.worktree;
    store.close();
    expect(worktree).toBeDefined();

    const status = await exec("git", ["status", "--porcelain"], { cwd: worktree as string });
    expect(status.stdout).toContain("half-done.ts");
    // And the mailbox is gone — ingested once, not left to confuse anyone.
    expect(status.stdout).not.toContain("STANDING-ORDERS-PARK-");
  });

  test("a second pass does not double-park: the held task is simply not ready", async () => {
    const { runnerToken } = await setup();
    await tick(runnerToken);

    const code = await tick(runnerToken);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });

    const store = openStore(db);

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    try {
      expect(store.listDecisions("all")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("a payload that never becomes a decision becomes an incident, holding the task", async () => {
    const { runnerToken } = await setup();

    const code = await tick(runnerToken, babblingAgent);

    // The attempt broke and the pass says so. (On a mismatch the pass's
    // own JSON is the assertion message — an exit code alone cannot say
    // which road refused.)
    expect(code, lines.join("\n")).toBe(EXIT.failed);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "failed", reason: "malformed-decision" }]);

    const store = openStore(db);

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    try {
      // No decision — an incident, held by it, paged once.
      expect(store.listDecisions("all")).toHaveLength(0);
      expect(store.openIncidents()).toMatchObject([{ kind: "malformed-decision", taskId: "t-1" }]);
      const holds = store.activeHolds(store.refFor("built-in", "t-1").id, new Date(T0.getTime() + 9e8));
      expect(holds[0]).toMatchObject({ ownerKind: "incident" });
      expect(store.getRun(1)).toMatchObject({ outcome: "failed", reason: "malformed-decision" });
      expect(store.listNotifications("pending").filter(one => !isLifecycleNotification(one)).map(notification => notification.dedupeKey)).toEqual([
        "malformed:1",
      ]);
      // The malformed payload is preserved for a person to read.
      expect(store.artifactsFor(1).map(artifact => artifact.kind)).toContain("park-payload");
    } finally {
      store.close();
    }
  });
});

describe("decide, end to end — the morning answers and the machine hears it", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  const parkingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const mailbox = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (mailbox === undefined) throw new Error("the brief named no mailbox");
    await writeFile(
      join(cwd, mailbox),
      JSON.stringify({
        urgency: "blocking",
        recap: "The guard can fail open or fail closed on timeout.",
        question: "Fail open or fail closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "Bad payouts slip through.", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "Payouts pause.", reversible: true },
        ],
        recommendation: "closed",
      }),
    );
    return { ...OK, stdout: JSON.stringify({ result: "parked" }) };
  };

  const buildingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
    await concludeDone(cwd, args);
    return { ...OK, stdout: AGENT_SAID };
  };

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const run = (argv: string[], runner: Runner = parkingAgent, now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now,
      agentRunner: runner,
    });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-decide-e2e-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
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
    const runnerToken = registerRunner(db, "builder-1", repo);
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["task", "add", "the work", "--id", "t-1", "--repo", repo]);
    await run(["task", "scope", "t-1", "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"]);
    await run(["task", "approve", "t-1", "--json"]);
    const digest = payload().scope.digest as string;
    await run([
      "task", "approve", "t-1", "--yes",
      "--digest", digest, "--as", "alex", "--token", approverToken,
    ]);
    return { runnerToken, approverToken };
  };

  const tick = (runnerToken: string, runner: Runner) =>
    run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      runner,
    );

  test("park → decide → the task is ready again, and the answer is on the record", async () => {
    const { runnerToken, approverToken } = await setup();
    await tick(runnerToken, parkingAgent);

    // The list shows the question; exit 3 says attention is wanted.
    let code = await run(["decide", "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(payload().waiting).toMatchObject([{ id: 1, taskId: "t-1", question: "Fail open or fail closed?" }]);

    // The single view carries the whole screen: recap, options, evidence.
    await run(["decide", "1", "--json"]);
    expect(payload().decision).toMatchObject({ recommendation: "closed", state: "open" });
    expect(payload().evidence.map((a: { kind: string }) => a.kind).sort()).toEqual(["diff", "park-payload", "status"]);

    // Answering without authority is refused — an agent cannot decide for you.
    code = await run(["decide", "1", "--choose", "closed", "--as", "alex", "--token", "not-the-token", "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(payload().reason).toBe("not-an-approver");

    // Answering with authority works once.
    code = await run(["decide", "1", "--choose", "closed", "--as", "alex", "--token", approverToken, "--json"]);
    expect(code).toBe(EXIT.ok);
    expect(payload().decision).toMatchObject({ state: "answered", choice: "closed", answeredBy: "alex" });

    // A different answer afterwards is refused — decided is not negotiable.
    code = await run(["decide", "1", "--choose", "open", "--as", "alex", "--token", approverToken, "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(payload().reason).toBe("already-answered");

    // The hold is gone: the next pass takes the task again.
    code = await tick(runnerToken, buildingAgent);
    expect(code).toBe(EXIT.ok);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "built", committed: true }]);
  });


  test("the resumed agent is handed the answer — fenced, with the rules after it", async () => {
    const { runnerToken, approverToken } = await setup();
    await tick(runnerToken, parkingAgent);
    await run(["decide", "1", "--choose", "closed", "--as", "alex", "--token", approverToken, "--note", "pause is fine, retry hourly"]);

    let prompt = "";
    const capturing: Runner = async (_file, args, options) => {
      prompt = args[args.indexOf("-p") + 1] ?? "";
      const cwd = options?.cwd ?? "";
      await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
      await concludeDone(cwd, args);
      return { ...OK, stdout: AGENT_SAID };
    };
    const code = await tick(runnerToken, capturing);
    expect(code).toBe(EXIT.ok);

    // The answer arrived: question, chosen option, consequence, and the note,
    // every line fenced as data before the rules.
    expect(prompt).toContain("--- BEGIN ANSWERED DECISIONS ---");
    expect(prompt).toContain("| Decision 1 — question: Fail open or fail closed?");
    expect(prompt).toContain("| Chosen option: closed — Fail closed");
    expect(prompt).toContain("| Operator note: pause is fine, retry hourly");
    // The trusted directive names only ids, and the rules bound the quotes.
    expect(prompt).toContain('The operator chose option "closed" for decision 1');
    expect(prompt).toContain("park again rather than widening it");
    // And the rules still come after the quoted block.
    expect(prompt.indexOf("--- END ANSWERED DECISIONS ---")).toBeLessThan(
      prompt.indexOf("Rules, which are not negotiable"),
    );

    // The causal record: the resume run was given exactly this answer.
    const store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    try {
      expect(store.answersFor(2)).toMatchObject([{ choice: "closed", note: "pause is fine, retry hourly" }]);
    } finally {
      store.close();
    }
  });

  test("the brief carries DECIDE while a decision waits, and stops when it is answered", async () => {
    const { runnerToken, approverToken } = await setup();
    await tick(runnerToken, parkingAgent);

    await run(["brief", "--repo", repo, "--local", "--json"]);
    expect(payload().decide).toMatchObject([{ id: 1, taskId: "t-1" }]);

    await run(["decide", "1", "--choose", "closed", "--as", "alex", "--token", approverToken]);
    await run(["brief", "--repo", repo, "--local", "--json"]);
    expect(payload().decide).toEqual([]);
    // The outbox no longer pages about it either: resolved, receipts kept.
    expect(payload().outboxPending).toBe(0);
  });

  test("the brief counts a task update the phone failed to receive, and never quiet progress", async () => {
    await setup();
    // Filing and approving t-1 recorded routine lifecycle facts: progress, not attention.
    await run(["brief", "--repo", repo, "--local", "--json"]);
    expect(payload().outboxPending).toBe(0);

    const at = new Date("2026-08-11T00:00:00.000Z");
    const store = openStore(db);
    try {
      const code = mintPairingCode();
      store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, at);
      expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: "777000", chatId: "4242", userId: "31337", updateId: 1 }, at).ok).toBe(true);
      // The pairing starts from now (earlier facts are skipped history); a hold recorded after it is a real update.
      store.hold(store.refFor("built-in", "t-1").id, "waiting on the vendor", null, new Date(at.getTime() + 1_000));
      const answer = { current: { ok: false, description: "offline" } as { ok: boolean; description?: string; result?: unknown } };
      const transport: TelegramTransport = async method => method === "getUpdates" ? { ok: true, result: [] } : answer.current as never;
      const pass = () => bridgePass(store, { botId: "777000", transport, clock: () => new Date(at.getTime() + 2_000), readProjects: async () => [repo] });
      expect(await pass()).toMatchObject({ ok: true, report: { sent: 0, problems: [expect.stringMatching(/: offline$/)] } });
    } finally {
      store.close();
    }
    // The wire refused the hold's message: that is delivery trouble, and the brief says so.
    await run(["brief", "--repo", repo, "--local", "--json"]);
    expect(payload().outboxPending).toBe(1);

    const again = openStore(db);
    try {
      const transport: TelegramTransport = async method => method === "getUpdates" ? { ok: true, result: [] } : { ok: true, result: { message_id: 100 } };
      expect(await bridgePass(again, { botId: "777000", transport, clock: () => new Date(at.getTime() + 5_000), readProjects: async () => [repo] })).toMatchObject({ ok: true, report: { sent: 1, problems: [] } });
    } finally {
      again.close();
    }
    // Delivered: nothing is owed, and no success line is added for it.
    await run(["brief", "--repo", repo, "--local", "--json"]);
    expect(payload().outboxPending).toBe(0);
  });

  test("an incident outlives the briefing window and only an authenticated resolve frees the task", async () => {
    const { runnerToken, approverToken } = await setup();
    const babbling: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      const prompt = args[args.indexOf("-p") + 1] ?? "";
      const mailbox = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
      if (mailbox !== undefined) await writeFile(join(cwd, mailbox), "not even json");
      return { ...OK, stdout: JSON.stringify({ result: "tried" }) };
    };
    await tick(runnerToken, babbling);

    // A week later, the incident is still in the brief — no window hides it.
    const aWeekOn = new Date(T0.getTime() + 7 * 24 * 60 * 60_000);
    await run(["brief", "--repo", repo, "--local", "--json"], parkingAgent, aWeekOn);
    expect(payload().incidents).toMatchObject([{ id: 1, taskId: "t-1", kind: "malformed-decision" }]);

    // task unhold cannot lift it: the hold belongs to the incident.
    await run(["task", "unhold", "t-1", "--json"]);
    await run(["ready", "--json"]);
    expect(payload().tasks ?? []).toEqual([]);

    // An authenticated resolve can.
    const code = await run(["incident", "resolve", "1", "--as", "alex", "--token", approverToken, "--json"]);
    expect(code).toBe(EXIT.ok);
    await run(["brief", "--repo", repo, "--local", "--json"]);
    expect(payload().incidents).toEqual([]);
    await run(["ready", "--json"]);
    expect((payload().tasks ?? []).map((t: { id: string }) => t.id)).toEqual(["t-1"]);
  });
});

describe("the bridge, end to end — a tap on a phone resumes the night", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  const BOT_TOKEN = "777000:AAExampleExampleExample123";

  const parkingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const mailbox = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (mailbox === undefined) throw new Error("the brief named no mailbox");
    await writeFile(
      join(cwd, mailbox),
      JSON.stringify({
        urgency: "blocking",
        recap: "The guard can fail open or fail closed.",
        question: "Fail open or fail closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "slips", reversible: true },
          { id: "closed", label: "Fail closed", consequence: "pauses", reversible: true },
        ],
        recommendation: "closed",
      }),
    );
    return { ...OK, stdout: JSON.stringify({ result: "parked" }) };
  };

  const buildingAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
    await concludeDone(cwd, args);
    return { ...OK, stdout: AGENT_SAID };
  };

  /** The scripted Bot API shared across `run` calls in one test. */
  const script = {
    calls: [] as { method: string; params: Record<string, unknown> }[],
    updates: [] as unknown[][],
    nextMessageId: 500,
  };
  const transport = async (method: string, params: Record<string, unknown>) => {
    script.calls.push({ method, params });
    if (method === "getUpdates") {
      return { ok: true, result: script.updates.shift() ?? [] };
    }
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: script.nextMessageId++ } };
    }
    if (method === "editMessageText") {
      return { ok: true, result: { message_id: params["message_id"] } };
    }
    return { ok: true, result: true };
  };

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const run = (argv: string[], runner: Runner = parkingAgent, now: Date = T0, shouldStop?: () => boolean) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now,
      agentRunner: runner,
      telegramTransport: transport,
      ...(shouldStop === undefined ? {} : { shouldStop }),
    });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-bridge-e2e-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    script.calls = [];
    script.updates = [];
    await saveRepos(join(base, "repos.json"), [repo]);
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

  test("token → pair → park → send → tap → the next tick builds", async () => {
    // Credentials and an approved task, exactly as a person would set up.
    const runnerToken = registerRunner(db, "builder-1", repo);
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["task", "add", "the work", "--id", "t-1", "--repo", repo]);
    await run(["task", "scope", "t-1", "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"]);
    await run(["task", "approve", "t-1", "--json"]);
    const digest = payload().scope.digest as string;
    await run(["task", "approve", "t-1", "--yes", "--digest", digest, "--as", "alex", "--token", approverToken]);

    // The bot token, set through the CLI, lands beside the database, 0600.
    let code = await run(["bridge", "telegram", "token", BOT_TOKEN, "--json"]);
    expect(code).toBe(EXIT.ok);

    // Pairing: mint the code locally, send it "from the phone".
    await run(["bridge", "telegram", "pair", "--as", "alex", "--token", approverToken, "--json"]);
    const pairCode = payload().code as string;
    script.updates.push([
      {
        update_id: 1,
        message: {
          message_id: 1,
          text: `/pair ${pairCode}`,
          chat: { id: 4242, type: "private" },
          from: { id: 31337 },
        },
      },
    ]);
    code = await run(["bridge", "telegram", "--json"]);
    expect(code).toBe(EXIT.ok);
    expect(payload().report).toMatchObject({ paired: 1 });

    // The park, for real, against real git.
    await run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      parkingAgent,
    );
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "parked" }]);

    // The bridge sends it — behind the attempt's own progress facts, in
    // order; the keyboard's buttons are opaque tokens.
    code = await run(["bridge", "telegram", "--json"]);
    expect(code).toBe(EXIT.ok);
    expect(payload().report).toMatchObject({ problems: [] });
    expect(payload().report.sent).toBeGreaterThanOrEqual(1);
    const keyboarded = script.calls.filter(
      call => call.method === "sendMessage" && call.params["reply_markup"] !== undefined,
    );
    const buttons = (
      keyboarded[keyboarded.length - 1]?.params["reply_markup"] as {
        inline_keyboard: { text: string; callback_data: string }[][];
      }
    ).inline_keyboard.flat();
    const closed = buttons.find(button => button.text.includes("Fail closed"));
    expect(closed?.callback_data).toMatch(/^[0-9a-f]{32}$/);

    // The tap, from the paired person, on the message the keyboard rode.
    const store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const placedOn = store.getTelegramAction(closed!.callback_data)?.messageId;
    store.close();
    script.updates.push([
      {
        update_id: 2,
        callback_query: {
          id: "cb-1",
          data: closed!.callback_data,
          from: { id: 31337 },
          message: { message_id: Number(placedOn), chat: { id: 4242 } },
        },
      },
    ]);
    code = await run(["bridge", "telegram", "--json"]);
    expect(code).toBe(EXIT.ok);
    expect(payload().report).toMatchObject({ answered: 1 });

    // The answer is on the record as the paired approver, via telegram…
    const after = openStore(db);
    expect(after.getDecision(1)).toMatchObject({
      state: "answered",
      choice: "closed",
      answeredBy: "alex",
      answeredVia: "telegram",
    });
    after.close();

    // …and the loop resumes: the next tick builds with the answer in hand.
    code = await run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      buildingAgent,
      new Date(T0.getTime() + 60_000),
    );
    expect(code).toBe(EXIT.ok);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "built", committed: true }]);
  });

  test("--follow applies a waiting tap without a second invocation", async () => {
    // Credentials, an approved task, a park, and a delivered keyboard —
    // the same road as the E2E above, compressed.
    const runnerToken = registerRunner(db, "builder-1", repo);
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["task", "add", "the work", "--id", "t-1", "--repo", repo]);
    await run(["task", "scope", "t-1", "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"]);
    await run(["task", "approve", "t-1", "--json"]);
    const digest = payload().scope.digest as string;
    await run(["task", "approve", "t-1", "--yes", "--digest", digest, "--as", "alex", "--token", approverToken]);
    await run(["bridge", "telegram", "token", BOT_TOKEN, "--json"]);
    await run(["bridge", "telegram", "pair", "--as", "alex", "--token", approverToken, "--json"]);
    const pairCode = payload().code as string;
    script.updates.push([
      {
        update_id: 1,
        message: { message_id: 1, text: `/pair ${pairCode}`, chat: { id: 4242, type: "private" }, from: { id: 31337 } },
      },
    ]);
    await run(["bridge", "telegram", "--json"]);
    await run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      parkingAgent,
    );
    await run(["bridge", "telegram", "--json"]);
    const keyboarded = script.calls.filter(
      call => call.method === "sendMessage" && call.params["reply_markup"] !== undefined,
    );
    const buttons = (
      keyboarded[keyboarded.length - 1]?.params["reply_markup"] as {
        inline_keyboard: { text: string; callback_data: string }[][];
      }
    ).inline_keyboard.flat();
    const closed = buttons.find(button => button.text.includes("Fail closed"));
    const before = openStore(db);
    const placedOn = before.getTelegramAction(closed!.callback_data)?.messageId;
    before.close();

    // The tap waits on Telegram's side; the follower picks it up — no
    // second cron firing anywhere. The follow ends when the answer is on the
    // record, not after a fixed window; --for only caps a regression.
    script.updates.push([
      {
        update_id: 2,
        callback_query: {
          id: "cb-1",
          data: closed!.callback_data,
          from: { id: 31337 },
          message: { message_id: Number(placedOn), chat: { id: 4242 } },
        },
      },
    ]);
    const answered = () => {
      const observer = openStore(db);
      try { return observer.getDecision(1)?.state === "answered"; } finally { observer.close(); }
    };
    const code = await run(["bridge", "telegram", "--follow", "--for", "60000", "--json"], parkingAgent, T0, answered);
    expect(code).toBe(EXIT.ok);
    expect(payload().report).toMatchObject({ answered: 1 });

    const after = openStore(db);
    expect(after.getDecision(1)?.state).toBe("answered");
    after.close();
  });
});
