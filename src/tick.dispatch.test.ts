/**
 * The M1 acceptance test, dispatch: one task goes queued → branch → commit,
 * with nobody typing the steps; filling a gap starts every task it blocked.
 *
 * End to end against real git: the store on disk, the claim and its fence,
 * the worktree pool running actual git, the builder's gates and the commit.
 * Only the agent is a stub — it writes a real file into the real worktree it
 * was given and answers in the CLI's output envelope.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { delimiter } from "node:path";
import { resetAttestationCache } from "./attest.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import type { Runner } from "./builder.js";
import { AUTH_TRIAL_MS, authPauseOf, pauseForAuth } from "./provider-auth.js";
import { workIndexPage } from "./work-index.js";
import { OK, T0, AGENT_SAID, registerRunner, concludeDone, proveChangedPath } from "../test/tick-kit.js";

describe("tick, against real git", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];

  /** Where the stub agent was asked to work, one entry per invocation. */
  let agentRan: string[] = [];

  /** Stands where `claude` would: does real work in the worktree it was given. */
  const agent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    agentRan.push(cwd);
    await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
    await concludeDone(cwd, args);
    return { ...OK, stdout: AGENT_SAID };
  };

  // "Broken" means the AGENT failed, not the harness: the stream shows the
  // init event (the harness came up), then a nonzero exit. Without the init
  // line this would now honestly classify as provider-init (arc 1).
  const brokenAgent: Runner = async () => ({ ...OK, code: 1, stdout: JSON.stringify({ type: "system", subtype: "init" }), stderr: "the model refused" });

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const run = (argv: string[], runner: Runner = agent, now: Date = T0) => {
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
    // Real path up front: task placement canonicalizes through realpath, and
    // the tick pass compares its --repo against the placed repo by equality.
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-tick-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    agentRan = [];

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

  /** Registers the runner (repo-bound, per the runner gate) and an approver,
   * and returns their tokens. */
  const credentials = async () => {
    const runnerToken = registerRunner(db, "builder-1", repo);
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    return { runnerToken, approverToken };
  };

  const queueApproved = async (id: string, approverToken: string) => {
    await run(["task", "add", "the work", "--id", id, "--repo", repo]);
    await run(["task", "scope", id, "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"]);
    await run(["task", "approve", id, "--json"]);
    const digest = payload().scope.digest as string;
    await run([
      "task", "approve", id, "--yes",
      "--digest", digest, "--as", "alex", "--token", approverToken,
    ]);
  };

  const tickArgs = (runnerToken: string) => [
    "tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json",
  ];

  const tick = (runnerToken: string, extra: string[] = [], runner: Runner = agent) =>
    run(
      ["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json", ...extra],
      runner,
    );

  /** Phase 3: a fake gemini on PATH — the attestation probe runs THIS. */
  const fakeGeminiOnPath = (version: string): (() => void) => {
    const bin = join(base, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gemini"), `#!/bin/sh\necho "${version}"\n`);
    chmodSync(join(bin, "gemini"), 0o755);
    const saved = process.env["PATH"];
    process.env["PATH"] = `${bin}${delimiter}${saved ?? ""}`;
    resetAttestationCache();
    return () => {
      process.env["PATH"] = saved ?? "";
      resetAttestationCache();
    };
  };

  const geminiCredentials = async () => {
    const runnerToken = registerRunner(db, "builder-1", repo);
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    await run(["config", "set", "build", "--provider", "gemini", "--model", "gemini-2.5-pro", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["config", "set", "plan", "--provider", "gemini", "--model", "gemini-2.5-pro", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    return { runnerToken, approverToken };
  };

  /** Speaks the gemini stream dialect and echoes the minted session id. */
  const geminiAgent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    agentRan.push(cwd);
    const minted = args[args.indexOf("--session-id") + 1] ?? "never-minted";
    await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
    await concludeDone(cwd, args);
    return {
      ...OK,
      stdout: [
        JSON.stringify({ type: "init", session_id: minted, model: "gemini-2.5-pro" }),
        JSON.stringify({ type: "synthetic_message", content: "guarded the path" }),
        JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 120, output_tokens: 30 } }),
      ].join("\n"),
    };
  };

  test("an unattested gemini never claims: two passes, zero runs, zero churn (Phase 3 A3)", async () => {
    const restore = fakeGeminiOnPath("0.58.9");
    try {
      const { runnerToken, approverToken } = await geminiCredentials();
      await queueApproved("t-gem-skip", approverToken);

      // A pass whose only event is the skip reports "waiting on a person" —
      // the existing nothing-dispatched exit.
      expect(await tick(runnerToken)).toBe(EXIT.refused);
      expect(payload().dispatched[0]).toMatchObject({ id: "t-gem-skip", outcome: "skipped", reason: "provider-unattested" });

      expect(await tick(runnerToken)).toBe(EXIT.refused);
      expect(payload().dispatched[0]).toMatchObject({ outcome: "skipped", reason: "provider-unattested" });

      // The skip is BEFORE the claim: no run rows, no worktree lease, no
      // strike — the queue idles instead of churning (round-2 finding on
      // the hot loop).
      const store = openStore(db);
      expect(store.raw().prepare("SELECT COUNT(*) AS n FROM run").get()?.["n"]).toBe(0);
      expect(store.raw().prepare("SELECT COUNT(*) AS n FROM claim").get()?.["n"]).toBe(0);
      await run(["task", "show", "t-gem-skip", "--json"]);
      expect(payload().task.state).toBe("queued");
      store.close();
    } finally {
      restore();
    }
  });

  test("gemini ON THE MACHINE never hijacks dispatch: only explicit selection routes to it (trust-posture invariant)", async () => {
    // A fake, ATTESTED gemini sits on PATH — present and usable. But the
    // install is configured for claude, so the tick dispatches CLAUDE.
    // Gemini's mere availability is not a selection (Codex gemini verify
    // round 2, finding 1): the trust grant only ever rides an explicit choice.
    const restore = fakeGeminiOnPath("0.57.0");
    try {
      const { runnerToken, approverToken } = await credentials(); // config: claude/sonnet
      await queueApproved("t-not-gemini", approverToken);
      expect(await tick(runnerToken)).toBe(EXIT.ok);
      expect(payload().dispatched[0]).toMatchObject({ id: "t-not-gemini", outcome: "built" });
      const store = openStore(db);
      const row = store.raw().prepare("SELECT provider FROM run WHERE task_ref IN (SELECT id FROM task_ref WHERE external_id = 't-not-gemini')").get();
      expect(row).toMatchObject({ provider: "claude" });
      store.close();
    } finally {
      restore();
    }
  });

  test("an attested gemini builds end-to-end: minted identity echoed, tokens recorded, dollars honestly NULL", async () => {
    const restore = fakeGeminiOnPath("0.57.0");
    try {
      const { runnerToken, approverToken } = await geminiCredentials();
      await queueApproved("t-gem-build", approverToken);

      expect(await tick(runnerToken, [], geminiAgent)).toBe(EXIT.ok);
      expect(payload().dispatched[0]).toMatchObject({ id: "t-gem-build", outcome: "built" });

      const store = openStore(db);
      const row = store.raw().prepare("SELECT provider, provider_version, session_id, tokens_in, tokens_out, cost_usd, outcome FROM run LIMIT 1").get();
      expect(row).toMatchObject({ provider: "gemini", provider_version: "0.57.0", tokens_in: 120, tokens_out: 30, cost_usd: null, outcome: "built" });
      // The minted identity survived the round trip: the row's session is a
      // plane-minted uuid the stub read off its own argv.
      expect(String(row?.["session_id"])).toMatch(/^[0-9a-f-]{36}$/);
      store.close();
    } finally {
      restore();
    }
  });

  test("`task next` changes what the pass actually takes — the dispatch-order proof", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-first", approverToken);
    await queueApproved("t-second", approverToken);

    await run(["task", "next", "t-second"]);
    const code = await tick(runnerToken, ["--max", "1"]);

    expect(code).toBe(EXIT.ok);
    expect(payload().dispatched[0]).toMatchObject({ id: "t-second", outcome: "built" });
    // The promoted task was built; the earlier filing waits its turn.
    await run(["task", "show", "t-first", "--json"]);
    expect(payload().task.state).toBe("queued");
  });

  test("a reserved task is built only by its worker; the shared queue waits behind a private column", async () => {
    const { runnerToken, approverToken } = await credentials();
    const otherToken = registerRunner(db, "builder-2", repo);
    await queueApproved("t-shared", approverToken);
    await queueApproved("t-private", approverToken);
    await run(["task", "assign", "t-private", "--runner", "builder-1"]);

    // builder-2 sees only the shared queue — the reservation is absent.
    const other = await run([
      "tick", "--runner", "builder-2", "--token", otherToken, "--repo", repo, "--pool", pool, "--max", "2", "--json",
    ]);
    expect(other).toBe(EXIT.ok);
    expect(payload().dispatched.map((one: { id: string }) => one.id)).toEqual(["t-shared"]);

    // builder-1 drains its own column.
    const mine = await tick(runnerToken, ["--max", "2"]);
    expect(mine).toBe(EXIT.ok);
    expect(payload().dispatched.map((one: { id: string }) => one.id)).toEqual(["t-private"]);
  });

  test("one task goes queued → branch → commit, unattended", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);

    const code = await tick(runnerToken);

    if (payload().ok !== true) console.error("TICK SAID:", JSON.stringify(payload(), null, 2));
    expect(payload()).toMatchObject({
      ok: true,
      command: "tick",
      considered: 1,
      dispatched: [{ id: "t-1", outcome: "built", committed: true, branch: "toolroll/t-1" }],
    });
    expect(code).toBe(EXIT.ok);
    expect(agentRan).toHaveLength(1);

    // The commit is real, on the task's branch, containing the agent's work…
    const shown = await git(["show", "--stat", "--oneline", "toolroll/t-1"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("guard.ts");
    // …and main never moved.
    const main = await git(["log", "--oneline", "main"]);
    expect(main.stdout.trim().split("\n")).toHaveLength(1);

    // The ledger agrees: done, and the lease is not still held.
    await run(["task", "show", "t-1", "--json"]);
    expect(payload().task.state).toBe("done");

    // And the attempt survived as a record, not just as an exit code.
    expect(payload().runs).toHaveLength(1);
    expect(payload().runs[0]).toMatchObject({
      outcome: "built",
      committed: true,
      branch: "toolroll/t-1",
      runner: "builder-1",
    });
    expect(payload().runs[0].finishedAt).not.toBeNull();
  });

  test("a missing verification executable replays approved setup once, verifies, and never duplicates the build", async () => {
    const { runnerToken, approverToken } = await credentials();
    const criterion = "The task records its new dependency declaration.";

    // The setup is intentionally state-sensitive. Before the agent changes
    // the declaration it has nothing to hydrate; after the commit, replaying
    // the SAME approved command makes the requested tool available. All
    // counters live under ignored node_modules so the repair cannot become
    // part of the agent's commit or its sealed changed-path proof.
    await mkdir(join(repo, "scripts"), { recursive: true });
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await writeFile(join(repo, "scripts", "setup.mjs"), [
      'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
      'mkdirSync("node_modules", { recursive: true });',
      'const counter = "node_modules/setup-count";',
      'const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;',
      'writeFileSync(counter, String(count + 1));',
      'if (existsSync("dependency.request")) writeFileSync("node_modules/tool-ready", "ready\\n");',
      "",
    ].join("\n"));
    await writeFile(join(repo, "scripts", "verify.mjs"), [
      'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
      'mkdirSync("node_modules", { recursive: true });',
      'const counter = "node_modules/verify-count";',
      'const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;',
      'writeFileSync(counter, String(count + 1));',
      'if (!existsSync("node_modules/tool-ready")) process.exit(127);',
      "",
    ].join("\n"));
    await git(["add", ".gitignore", "scripts/setup.mjs", "scripts/verify.mjs"]);
    await git(["commit", "-qm", "add dependency repair fixture"]);

    await run([
      "setup", "set", "--repo", repo, "--command", "node scripts/setup.mjs",
      "--yes", "--as", "alex", "--token", approverToken, "--json",
    ]);
    const setupDigest = payload().digest as string;
    await run([
      "verify", "set", "--repo", repo, "--command", "node scripts/verify.mjs",
      "--self-heal", "--setup-digest", setupDigest,
      "--yes", "--as", "alex", "--token", approverToken, "--json",
    ]);
    await run(["task", "add", "declare the required tool", "--id", "t-heal", "--repo", repo]);
    await run([
      "task", "scope", "t-heal", "--goal", "record the dependency declaration",
      "--acceptance", `${criterion}|changed-path`,
    ]);
    await run(["task", "approve", "t-heal", "--json"]);
    const digest = payload().scope.digest as string;
    await run([
      "task", "approve", "t-heal", "--yes", "--digest", digest,
      "--as", "alex", "--token", approverToken,
    ]);

    const healingAgent: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      agentRan.push(cwd);
      await writeFile(join(cwd, "dependency.request"), "tool-ready\n");
      await concludeDone(cwd, args, "completed", "Recorded the dependency declaration.");
      await proveChangedPath(cwd, args, criterion, "dependency.request");
      return { ...OK, stdout: JSON.stringify({ result: "Recorded the dependency declaration." }) };
    };

    const healingExit = await tick(runnerToken, [], healingAgent);
    expect(healingExit, JSON.stringify(payload())).toBe(EXIT.ok);
    expect(payload().dispatched).toMatchObject([{ id: "t-heal", outcome: "built", committed: true }]);
    expect(agentRan).toHaveLength(1);

    const worktree = agentRan[0] as string;
    expect(readFileSync(join(worktree, "node_modules", "setup-count"), "utf8")).toBe("2");
    expect(readFileSync(join(worktree, "node_modules", "verify-count"), "utf8")).toBe("2");

    await run(["task", "show", "t-heal", "--json"]);
    expect(payload().task.state).toBe("done");
    expect(payload().proofVerdict).toBe("verified");
    expect(payload().runs).toHaveLength(1);

    // The accepted result is terminal. A later scheduler pass is empty and
    // cannot replay either the agent or the dependency repair.
    expect(await tick(runnerToken, [], healingAgent)).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });
    expect(agentRan).toHaveLength(1);
    expect(readFileSync(join(worktree, "node_modules", "setup-count"), "utf8")).toBe("2");
    expect(readFileSync(join(worktree, "node_modules", "verify-count"), "utf8")).toBe("2");
  });

  test("a stop fence admits nothing — ready work stays queued, no agent spawns (audit IV-1)", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-stop", approverToken);

    lines = [];
    const code = await runOperate(
      "tick",
      ["--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"],
      line => lines.push(line),
      { databaseFile: db, now: T0, agentRunner: agent, shouldStop: () => true },
    );

    // Nothing admitted, nothing spent, nothing dispatched — the pass is a
    // correct "no", and the task waits for the successor.
    expect(payload().dispatched).toEqual([]);
    expect(agentRan).toHaveLength(0);
    expect(code).toBe(EXIT.refused);
    await run(["task", "show", "t-stop", "--json"]);
    expect(payload().task.state).toBe("queued");
  });

  test("an empty queue is exit 3, not an error", async () => {
    const { runnerToken } = await credentials();

    const code = await tick(runnerToken);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });
  });

  test("a built task under a publication grant leaves as a pushed branch and a PR", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);

    // Terms first: without --yes nothing is granted, and status says so.
    // Unconfirmed answers like every other grant preview — ok:false,
    // reason "unconfirmed", exit 3 (round-4 preview normalization; this
    // one alone used to say ok:true).
    const preview = await run(["publish", "grant", "--github", "alex/thing", "--repo", repo, "--json"]);
    expect(preview).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "unconfirmed", granted: false });
    await run(["publish", "status", "--repo", repo, "--json"]);
    expect(payload().grant).toBeNull();

    await run([
      "publish", "grant", "--github", "alex/thing", "--repo", repo,
      "--yes", "--as", "alex", "--token", approverToken, "--json",
    ]);
    expect(payload().granted).toBe(true);

    await tick(runnerToken);
    expect(payload().dispatched[0]).toMatchObject({ id: "t-1", outcome: "built" });

    // The intent was written with the completion — the exact accepted SHA.
    await run(["publish", "status", "--repo", repo, "--json"]);
    expect(payload().pending).toHaveLength(1);
    const head = await git(["rev-parse", "toolroll/t-1"]);
    expect(payload().pending[0]).toMatchObject({
      state: "intended",
      head: "toolroll/t-1",
      headSha: head.stdout.trim(),
      githubRepo: "alex/thing",
    });

    // The pass, against a scripted git and gh: push the SHA, open the PR.
    const calls: { file: string; args: string[] }[] = [];
    const publishExec = async (file: string, args: readonly string[]) => {
      calls.push({ file, args: [...args] });
      if (file === "gh" && args[1] === "list") return { ...OK, stdout: "[]" };
      if (file === "gh" && args[1] === "create") {
        return { ...OK, stdout: "https://github.com/alex/thing/pull/12\n" };
      }
      return { ...OK };
    };
    lines = [];
    const code = await runOperate("publish", ["--repo", repo, "--json"], line => lines.push(line), {
      databaseFile: db,
      publishExec,
    });

    expect(code).toBe(EXIT.ok);
    expect(payload().report).toMatchObject({ pushed: 1, opened: 1 });
    expect(calls[0]).toMatchObject({
      file: "git",
      args: ["push", "origin", `${head.stdout.trim()}:refs/heads/toolroll/t-1`],
    });
    await run(["publish", "status", "--repo", repo, "--json"]);
    expect(payload().pending).toHaveLength(0);
  });

  test("a ready task nobody approved is reported, not built", async () => {
    const { runnerToken } = await credentials();
    await run(["task", "add", "the work", "--id", "t-1"]);

    const code = await tick(runnerToken);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({
      ok: false,
      reason: "nothing-dispatched",
      dispatched: [{ id: "t-1", outcome: "skipped", reason: "unapproved" }],
    });
    expect(agentRan).toHaveLength(0);
  });

  test("--max 1 builds one of two ready tasks and leaves the other queued", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);
    await queueApproved("t-2", approverToken);

    const code = await tick(runnerToken, ["--max", "1"]);

    expect(code).toBe(EXIT.ok);
    const report = payload();
    expect(report.considered).toBe(2);
    expect(report.dispatched).toHaveLength(1);

    await run(["task", "show", "t-2", "--json"]);
    expect(payload().task.state).toBe("queued");
  });

  test("a broken agent earns a strike and a backoff, not a terminal failure", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);

    const code = await tick(runnerToken, [], brokenAgent);

    expect(code).toBe(EXIT.failed);
    expect(payload()).toMatchObject({
      ok: false,
      reason: "build-failed",
      dispatched: [{ id: "t-1", outcome: "failed", reason: "unknown — retry 1/3" }],
    });

    // gnhf's shape: the task requeues behind a doubling backoff rather than
    // dying on the first unknown exit — and stays off the ready set until
    // the pause lapses.
    await run(["task", "show", "t-1", "--json"]);
    expect(payload().task.state).toBe("queued");
    expect(payload().runs).toHaveLength(1);
    expect(payload().runs[0]).toMatchObject({ outcome: "failed", reason: "unknown" });
    await run(["ready", "--json"]);
    expect((payload().tasks ?? []).map((t: { id: string }) => t.id)).toEqual([]);
  });

  // An agent whose sign-in expired: the harness comes up, then the turn fails
  // to authenticate — the 2026-09-29 incident's exact words.
  const signedOutAgent: Runner = async (_file, _args, options) => {
    agentRan.push(options?.cwd ?? "");
    return { ...OK, code: 1, stdout: [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" }),
    ].join("\n") };
  };

  test("an expired sign-in takes no strike and no retry, requeues the task, pauses Claude only, and resumes when a person says so", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);
    await queueApproved("t-2", approverToken);

    await tick(runnerToken, [], signedOutAgent);
    // One attempt, no strike: the second task is not even tried on a sign-in that is gone.
    expect(agentRan).toHaveLength(1);
    expect(payload().dispatched).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "failed", reason: "auth-expired — requeued, sign-in needed" }),
      expect.objectContaining({ outcome: "skipped", reason: "signed-out", detail: expect.stringContaining("Claude needs you to sign in again") }),
    ]));
    const failedId = (payload().dispatched as { id: string; outcome: string }[]).find(one => one.outcome === "failed")!.id;
    await run(["task", "show", failedId, "--json"]);
    expect(payload().task.state).toBe("queued");
    expect(payload().hold).toBeNull();
    expect(payload().runs[0]).toMatchObject({ outcome: "failed", reason: "auth-expired" });
    expect(payload().dispatch).toMatchObject({ code: "signed-out", summary: "Claude needs you to sign in again" });
    await run(["task", "show", failedId]);
    expect(lines.join("\n")).toContain("dispatch: Claude needs you to sign in again — This task starts again on its own once Claude works.");
    const store = openStore(db);
    try {
      expect(store.lookupRef(failedId)?.strikes).toBe(0);
      // The console's task list says the same, not "Ready to run" (the attempted task's scripted
      // runner leaves no process record here, so only the untried one is asserted).
      const untried = failedId === "t-1" ? "t-2" : "t-1";
      // The shared headline (task-status.ts): a sign-in is Needs you; the sentence names it.
      const row = workIndexPage(store, T0, { principal: "operator", repos: null, includeUnplaced: true }).items.find(one => one.activeTaskId === untried)?.status;
      expect(row?.label).toBe("Needs you");
      expect(row?.detail).toContain("Claude needs you to sign in again");
    } finally { store.close(); }

    // status and ready say it plainly, first.
    await run(["status"]);
    expect(lines.join("\n").split("\n")[0]).toBe("Claude needs you to sign in again — run `claude /login`. Its tasks wait until then.");
    expect(lines.join("\n")).toContain("t-1 (Claude needs you to sign in again)");
    await run(["ready"]);
    expect(lines.join("\n").split("\n")[0]).toContain("Claude needs you to sign in again. Run `claude /login` on this computer");
    await run(["ready", "--json"]);
    expect(payload().signIn).toMatchObject([{ provider: "claude" }]);
    expect((payload().tasks as { id: string }[]).map(one => one.id).sort()).toEqual(["t-1", "t-2"]);

    // Another pass spends nothing: no retry while the sign-in is gone.
    await tick(runnerToken);
    expect(agentRan).toHaveLength(1);
    expect(payload().dispatched.every((one: { reason?: string }) => one.reason === "signed-out")).toBe(true);

    // A person resumes it: both tasks build, and one short message says so.
    await run(["providers", "resume", "claude", "--json"]);
    expect(payload()).toMatchObject({ ok: true, provider: "claude", resumed: 1 });
    const built: string[] = [];
    for (let pass = 0; pass < 2; pass++) {
      await tick(runnerToken);
      built.push(...(payload().dispatched as { id: string; outcome: string }[]).filter(one => one.outcome === "built").map(one => one.id));
    }
    expect(built.sort()).toEqual(["t-1", "t-2"]);
    const after = openStore(db);
    try {
      expect(after.handle.prepare("SELECT subject FROM notification WHERE kind IN ('auth-expired', 'auth-restored') ORDER BY id").all().map(one => one["subject"]))
        .toEqual(["Claude needs you to sign in again", "Claude is signed in again, 1 task resumed"]);
    } finally { after.close(); }
  });

  test("a sign-in pause on one provider never holds another provider's work", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);
    const store = openStore(db);
    try {
      store.createTask({ id: "elsewhere", title: "a codex task" }, T0);
      const ref = store.refFor("built-in", "elsewhere").id;
      pauseForAuth(store, { provider: "codex", authMode: "subscription", runId: 0, taskRef: ref, now: T0 });
      expect(authPauseOf(store, "codex")).not.toBeNull();
    } finally { store.close(); }
    await tick(runnerToken);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "built" }]);
  });

  test("a sign-in trial whose task is skipped before its claim is given back, so the next pass still has it", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);
    const trialTime = () => {
      const read = openStore(db);
      try { return read.handle.prepare("SELECT last_trial_at FROM provider_auth_pause WHERE provider = 'claude'").get()?.["last_trial_at"]; } finally { read.close(); }
    };
    const store = openStore(db);
    try {
      pauseForAuth(store, { provider: "claude", authMode: "subscription", runId: 0, taskRef: store.refFor("built-in", "t-1").id, now: T0 });
      store.recordProviderReadiness("builder-1", [{ provider: "claude", state: "unavailable", reason: "`claude` is not installed on this runner's PATH", probe: "version" }], T0);
    } finally { store.close(); }
    // The trial is due and the task passes the sign-in gate, but it is skipped before it claims.
    const due = new Date(T0.getTime() + AUTH_TRIAL_MS);
    await run(tickArgs(runnerToken), agent, due);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "skipped", reason: "provider-unavailable" }]);
    expect(trialTime()).toBeNull();
    // Seconds later the provider is back: the trial runs now, not ten minutes on.
    const back = openStore(db);
    try {
      back.recordProviderReadiness("builder-1", [{ provider: "claude", state: "unknown", reason: "installed; no non-spending login check exists", probe: "version" }], due);
    } finally { back.close(); }
    await run(tickArgs(runnerToken), agent, new Date(due.getTime() + 5_000));
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "built" }]);
  });

  test("every task the sign-in gate skips says so in the work index, planners and configured providers included", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-built", approverToken);
    // A planner: no approved terms name its provider; configuration does.
    await run(["task", "add", "plan it first", "--id", "t-plan", "--repo", repo]);
    const store = openStore(db);
    try {
      store.requestPlan(store.refFor("built-in", "t-plan").id, T0);
      pauseForAuth(store, { provider: "claude", authMode: "subscription", runId: 0, taskRef: store.refFor("built-in", "t-built").id, now: T0 });
    } finally { store.close(); }

    await tick(runnerToken);
    const skipped = (payload().dispatched as { id: string; reason?: string }[]).filter(one => one.reason === "signed-out").map(one => one.id);
    expect(skipped.sort()).toEqual(["t-built", "t-plan"]);
    expect(agentRan).toEqual([]);
    const after = openStore(db);
    try {
      const items = workIndexPage(after, T0, { principal: "operator", repos: null, includeUnplaced: true }).items;
      for (const id of skipped) {
        expect(items.find(one => one.activeTaskId === id)?.status).toMatchObject({ label: "Needs you", detail: "Claude needs you to sign in again. It starts again on its own once Claude works." });
      }
    } finally { after.close(); }
    await run(["task", "show", "t-plan", "--json"]);
    expect(payload().dispatch).toMatchObject({ code: "signed-out", summary: "Claude needs you to sign in again" });

    // Resumed: the gate's note no longer holds anything.
    await run(["providers", "resume", "claude", "--json"]);
    const resumed = openStore(db);
    try {
      const items = workIndexPage(resumed, T0, { principal: "operator", repos: null, includeUnplaced: true }).items;
      // Waiting for a worker to draft its plan: Queued, and the sentence says what for.
      expect(items.find(one => one.activeTaskId === "t-plan")?.status).toMatchObject({ label: "Queued", detail: "A connected worker can draft the plan." });
    } finally { resumed.close(); }
  });

  test("three straight failures stall the task with an incident, not a fourth attempt", async () => {
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);

    // Each pass fails once; the backoff between them is waited out by
    // advancing the injected clock past the doubling pauses.
    await run(tickArgs(runnerToken), brokenAgent, T0);
    await run(tickArgs(runnerToken), brokenAgent, new Date(T0.getTime() + 5 * 60_000));
    const third = await run(tickArgs(runnerToken), brokenAgent, new Date(T0.getTime() + 15 * 60_000));

    expect(third).toBe(EXIT.failed);
    expect(payload().dispatched).toMatchObject([{ id: "t-1", outcome: "failed", reason: "unknown — stalled" }]);

    await run(["task", "show", "t-1", "--json"]);
    expect(payload().task.state).toBe("failed");
    await run(["incident", "list", "--json"]);
    expect(payload().incidents).toMatchObject([{ kind: "attempts-exhausted", taskId: "t-1" }]);

    // A fourth pass finds nothing to try: the stall holds.
    const fourth = await run(tickArgs(runnerToken), brokenAgent, new Date(T0.getTime() + 60 * 60_000));
    expect(fourth).toBe(EXIT.refused);
  });

  test("a second pass finds nothing left to do", async () => {
    // The fences holding is what makes running this from cron safe: the same
    // command again must converge, not build the same task twice.
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);
    await tick(runnerToken);

    const code = await tick(runnerToken);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });
    expect(agentRan).toHaveLength(1);
  });

  test("a task somebody else holds never enters the pass at all", async () => {
    // The ready set already excludes a live claim, so the other runner's task
    // is not even considered — losing a race this early is indistinguishable
    // from an empty queue, and both are exit 3.
    const { runnerToken, approverToken } = await credentials();
    await queueApproved("t-1", approverToken);
    const otherToken = registerRunner(db, "builder-2", repo);
    await run(["claim", "t-1", "--runner", "builder-2", "--token", otherToken]);

    const code = await tick(runnerToken);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "empty" });
    expect(agentRan).toHaveLength(0);
  });
});

describe("fill one gap, three tasks start — the M2 sentence, executable", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  let agentRan: string[] = [];

  const agent: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    agentRan.push(cwd);
    await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
    await concludeDone(cwd, args);
    return { ...OK, stdout: AGENT_SAID };
  };

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const run = (argv: string[]) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), {
      databaseFile: db,
      now: T0,
      agentRunner: agent,
    });
  };

  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-m2-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    await mkdir(repo, { recursive: true });
    agentRan = [];

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

  test("three blocked tasks dispatch the moment their one gap is supplied", async () => {
    // -- Setup: a runner, an approver, and one capability the machine lacks.
    const runnerToken = registerRunner(db, "builder-1", repo);
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);

    // The probe is written once and never edited again: supplying the
    // capability, not redefining it, is what must open the gate.
    await run([
      "cap", "add", "granted", "--kind", "other",
      "--probe", "test -f granted.txt", "--repo", repo,
    ]);

    for (const id of ["t-1", "t-2", "t-3"]) {
      await run(["task", "add", "the work", "--id", id, "--repo", repo]);
      await run(["task", "scope", id, "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"]);
      await run(["task", "approve", id, "--json"]);
      const digest = payload().scope.digest as string;
      await run([
        "task", "approve", id, "--yes",
        "--digest", digest, "--as", "alex", "--token", approverToken,
      ]);
      await run(["task", "require", id, "--cap", "other:granted"]);
    }

    const tick = () =>
      run([
        "tick", "--runner", "builder-1", "--token", runnerToken,
        "--repo", repo, "--pool", pool, "--max", "3", "--json",
      ]);

    // -- Night one: the machine lacks the capability. Nothing runs, nothing
    // is claimed, and every skip names the gap.
    const blocked = await tick();
    expect(blocked).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "nothing-dispatched", considered: 3 });
    expect(payload().dispatched).toEqual([
      { id: "t-1", outcome: "skipped", reason: "capability", detail: "needs other:granted — not verified" },
      { id: "t-2", outcome: "skipped", reason: "capability", detail: "needs other:granted — not verified" },
      { id: "t-3", outcome: "skipped", reason: "capability", detail: "needs other:granted — not verified" },
    ]);
    expect(agentRan).toHaveLength(0);

    // -- The operator fills the gap. The probe is untouched; the world now
    // satisfies it. (In life this is pasting a key; here it is a file.)
    await writeFile(join(repo, "granted.txt"), "supplied\n");

    // -- Night two: tick re-probes at its own checkpoint and all three start.
    const opened = await tick();
    expect(opened).toBe(EXIT.ok);
    const report = payload();
    expect(report.ok).toBe(true);
    expect(report.dispatched).toHaveLength(3);
    for (const entry of report.dispatched) expect(entry.outcome).toBe("built");
    expect(agentRan).toHaveLength(3);

    // Three real branches, three real commits, and main never moved.
    for (const id of ["t-1", "t-2", "t-3"]) {
      const shown = await git(["show", "--stat", "--oneline", `toolroll/${id}`]);
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain("guard.ts");
    }
    const main = await git(["log", "--oneline", "main"]);
    expect(main.stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe("gaps", () => {
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
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-gaps-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    await mkdir(repo, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const approvedTask = async (id: string, approverToken: string, caps: string) => {
    await run(["task", "add", "the work", "--id", id, "--repo", repo]);
    await run(["task", "scope", id, "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"]);
    await run(["task", "approve", id, "--json"]);
    const digest = payload().scope.digest as string;
    await run([
      "task", "approve", id, "--yes",
      "--digest", digest, "--as", "alex", "--token", approverToken,
    ]);
    await run(["task", "require", id, "--cap", caps]);
  };

  test("ranks by what filling would actually free, and counts honestly", async () => {
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["cap", "add", "ALPHA", "--repo", repo]);
    await run(["cap", "add", "BETA", "--repo", repo]);

    // Three tasks held by ALPHA alone; one held by ALPHA and BETA together —
    // that one starts only when both fill, so it must not inflate either.
    await approvedTask("t-1", approverToken, "env:ALPHA");
    await approvedTask("t-2", approverToken, "env:ALPHA");
    await approvedTask("t-3", approverToken, "env:ALPHA");
    await approvedTask("t-4", approverToken, "env:ALPHA,env:BETA");

    const code = await run(["gaps", "--repo", repo, "--json"]);

    expect(code).toBe(EXIT.refused);
    const { gaps } = payload();
    expect(gaps[0]).toMatchObject({
      key: "env:ALPHA",
      unblocks: ["t-1", "t-2", "t-3"],
      alsoBlocks: ["t-4"],
    });
    expect(gaps[1]).toMatchObject({ key: "env:BETA", unblocks: [], alsoBlocks: ["t-4"] });
  });

  test("a requirement nobody recorded is a gap the moment a task names it", async () => {
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    // v24: approvals bind exact routing — the install names its model once.
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["config", "set", "plan", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]); // v47: every phase names an exact model
    await run(["config", "set", "review", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await approvedTask("t-1", approverToken, "mcp:supabase");

    await run(["gaps", "--repo", repo, "--json"]);

    expect(payload().gaps[0]).toMatchObject({
      key: "mcp:supabase",
      state: `unrecorded for ${repo}`,
      unblocks: ["t-1"],
    });
  });

  test("no gaps is exit 0 and says so", async () => {
    const code = await run(["gaps", "--repo", repo, "--json"]);

    expect(code).toBe(EXIT.ok);
    expect(payload().gaps).toEqual([]);
  });
});
