import { provableCandidate } from "../test/deploy-candidate-fixture.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { installUpdateGate } from "./desktop-update-gate.js";
import { BRANCH_GONE_LOOKS, BRANCH_GONE_PAUSE_MS, bumpFormula, cliRuntimes, deployedRuntime, gateStateOf, githubSlug, releaseAdapters, releaseAdapters as quietAdapters, serviceRuntimes, stageGate, workflowRunsOnChange, type Exec, type ReleaseRepo, type ReleaseTools } from "./release-adapters.js";
import { openStore, type Database } from "./store.js";
import { fakePid } from "../test/fake-pid.js";

const root = () => mkdtempSync(join(tmpdir(), "so-release-adapters-"));
const SHA = "a".repeat(40);
/** The repository as the plane records it and the programs by absolute path (release-adapters.ts recordedReleaseRepo). */
const REPO: ReleaseRepo = { checkout: "/rv", gitDir: "/rv/.git", remote: "https://github.com/ap9000/toolroll.git", slug: "ap9000/toolroll", ssh: false };
const TOOLS: ReleaseTools = { git: "/usr/bin/git", gh: "/opt/homebrew/bin/gh", ssh: "/usr/bin/ssh" };

describe("the release adapters", () => {
  test("read a GitHub remote, https or ssh", () => {
    expect(githubSlug("https://github.com/ap9000/toolroll.git\n")).toBe("ap9000/toolroll");
    expect(githubSlug("git@github.com:ap9000/toolroll.git")).toBe("ap9000/toolroll");
    expect(githubSlug("https://gitlab.com/ap9000/toolroll.git")).toBeNull();
  });

  test("read the release task from `task show --json`: approval provenance, the sealed result, and its completion", () => {
    const show = {
      ok: true, command: "task show",
      scope: { candidate: SHA, digest: "d1", approvedAt: "2026-10-08T09:00:00.000Z", approvedBy: "alex", approvedDigest: "d1", approvalBasis: "password" },
      runs: [{ id: 7, role: "builder", outcome: "built", finishedAt: "x", worktree: "/w/7" }, { id: 8, role: "reviewer", outcome: null, finishedAt: null }],
      assignment: { state: "complete", result: { digest: "r1", runId: 7, head: SHA, checks: { status: "passed", level: "full" } }, completion: { actor: "lead:alex", at: "y", digest: "r1" } },
    };
    expect(gateStateOf(show, [{ name: "alex", role: "approver", revokedAt: null }])).toEqual({
      exists: true, candidate: SHA, scopeDigest: "d1",
      approval: { by: "alex", at: "2026-10-08T09:00:00.000Z", digest: "d1", basis: "password", role: "approver", active: true },
      result: { run: 7, head: SHA, check: "passed", level: "full", receipt: "r1", worktree: "/w/7" }, failed: null, pending: false,
      completion: { actor: "lead:alex", at: "y", digest: "r1" },
    });
    // A follow-up check still running on that commit is not a result yet.
    expect(gateStateOf({ ...show, assignment: { ...show.assignment, result: { ...show.assignment.result, checks: { status: "passed", running: "full" } } } }).result?.check).toBe("running");
    // A newer build that ended without a result failed before its check.
    expect(gateStateOf({ ...show, runs: [...show.runs, { id: 9, role: "builder", outcome: "failed", finishedAt: "z" }] }).failed).toBe("run 9 ended failed");
    expect(gateStateOf({ ok: false, command: "task show", reason: "unknown-task" })).toMatchObject({ exists: false });
    // Queued again (a regate) or building past the result: that result is the one before the rerun.
    expect(gateStateOf({ ...show, task: { state: "queued" } }).pending).toBe(true);
    expect(gateStateOf({ ...show, task: { state: "running" } }).pending).toBe(true);
    expect(gateStateOf({ ...show, task: { state: "done" }, runs: [...show.runs, { id: 9, role: "builder", outcome: null, finishedAt: null }] }).pending).toBe(true);
    expect(gateStateOf({ ...show, task: { state: "done" } }).pending).toBe(false);
  });

  test("find which runtime the services and both CLI names run", () => {
    const home = root();
    const agents = join(home, "LaunchAgents"), dist = join(home, "stage", "dist"), bin = join(home, "bin");
    mkdirSync(agents); mkdirSync(dist, { recursive: true }); mkdirSync(bin);
    writeFileSync(join(agents, "com.toolroll.browser.plist"), `<array><string>/usr/bin/node</string><string>${dist}/cli.js</string></array>`);
    writeFileSync(join(agents, "com.other.thing.plist"), `<string>/elsewhere/dist/cli.js</string>`);
    writeFileSync(join(dist, "bin.js"), "");
    symlinkSync(join(dist, "bin.js"), join(bin, "toolroll"));
    writeFileSync(join(bin, "standing-orders"), "#!/bin/sh\n");
    expect(serviceRuntimes(agents)).toEqual([expect.stringMatching(/stage\/dist$/)]);
    expect(cliRuntimes(bin)).toEqual([{ name: "toolroll", runtime: expect.stringMatching(/stage\/dist$/) }, { name: "standing-orders", runtime: null }]);
  });

  test.each([["quick", "passed", "not-full"], ["off", "not-run", "not-run"], [null, "passed", "not-full"]])("keeps %s checks from becoming a Full pass", (level, status, check) => {
    expect(gateStateOf({ ok: true, assignment: { result: { runId: 7, digest: "r1", checks: { level, status } } } }).result).toMatchObject({ level, check });
  });

  test.each([{ role: "viewer", revokedAt: null, active: true }, { role: "approver", revokedAt: "yesterday", active: false }])("reads the current approving account: %j", async ({ role, revokedAt, active }) => {
    const run: Exec = async (_command, args) => ({ code: 0, stderr: "", stdout: JSON.stringify(args[0] === "people"
      ? { ok: true, accounts: [{ name: "alex", role, revokedAt }] }
      : { ok: true, scope: { approvedBy: "alex", approvedAt: "today", approvedDigest: "d1", approvalBasis: "password" } }) });
    const gate = await releaseAdapters({ checkout: "/rv", run }).toolroll.gate("release-1");
    expect(gate.approval).toMatchObject({ by: "alex", role, active });
  });

  test("files the candidate with Full checks before scoping it, regardless of the project default", async () => {
    const calls: (readonly string[])[] = [];
    const run: Exec = async (_command, args) => {
      calls.push(args);
      return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, scope: { digest: "d1" } }) };
    };
    expect(await releaseAdapters({ checkout: "/rv", run }).toolroll.fileGate({ taskId: "release-1", title: "Release 1", checkout: "/rv", candidate: SHA, goal: "Verify", acceptance: "passes|check" })).toEqual({ scopeDigest: "d1" });
    expect(calls[0]).toEqual(["task", "add", "Release 1", "--id", "release-1", "--repo", "/rv", "--checks", "full", "--json"]);
    expect(calls[1]).toContain(SHA);
  });

  test("an unfinished run without a live claim keeps release busy and names its task", async () => {
    const database = join(root(), "orders.db"), store = openStore(database), db = store.handle;
    const run: Exec = async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ ok: true, running: { count: 0, tasks: [] } }) });
    const adapter = releaseAdapters({ checkout: "/rv", database, run }).toolroll;
    try {
      db.exec("INSERT INTO task_ref(id,backend,external_id) VALUES(1,'built-in','unclaimed-build')");
      db.exec("INSERT INTO run(task_ref,lease_id,runner,branch,worktree,started_at) VALUES(1,'lost-lease','fixture','feature','/w','2026-10-09T00:00:00Z')");
      expect(db.prepare("SELECT count(*) n FROM claim WHERE released_at IS NULL").get()?.["n"]).toBe(0);
      expect(await adapter.busy()).toEqual({ running: 1, tasks: ["unclaimed-build"] });
      // Observing the unfinished run does not recover or otherwise change it.
      expect(db.prepare("SELECT outcome FROM run").get()?.["outcome"]).toBeNull();
      db.exec("UPDATE run SET outcome='built', finished_at='2026-10-09T01:00:00Z'");
      expect(await adapter.busy()).toEqual({ running: 0, tasks: [] });
    } finally { store.close(); }
  });

  test("unreleased claims and unsettled stops keep release busy after the run finishes", async () => {
    const database = join(root(), "orders.db"), store = openStore(database), db = store.handle;
    const adapter = releaseAdapters({ checkout: "/rv", database }).toolroll;
    try {
      db.exec("INSERT INTO task_ref(id,backend,external_id) VALUES(1,'built-in','claimed-task'),(2,'built-in','stopping-task')");
      db.exec("INSERT INTO claim(task_ref,lease_id,lease_generation,runner,acquired_at,expires_at,heartbeat_at) VALUES(1,'lease',1,'fixture','2000-01-01','2000-01-02','2000-01-01')");
      db.exec("INSERT INTO run(id,task_ref,lease_id,runner,branch,worktree,started_at,outcome,finished_at) VALUES(1,2,'other-lease','fixture','feature','/w','2000-01-01','built','2000-01-02')");
      db.exec("INSERT INTO run_stop(run,task_ref,requested_by,requested_via,requested_at) VALUES(1,2,'alex','cli','2000-01-02')");
      expect(await adapter.busy()).toEqual({ running: 2, tasks: ["claimed-task", "stopping-task"] });
      db.exec("UPDATE claim SET released_at='2000-01-03'");
      expect(await adapter.busy()).toEqual({ running: 1, tasks: ["stopping-task"] });
      db.exec("UPDATE run_stop SET settled_at='2000-01-03', settlement='finished'");
      expect(await adapter.busy()).toEqual({ running: 0, tasks: [] });
    } finally { store.close(); }
  });

  test("active conversations keep release busy even without task work", async () => {
    const database = join(root(), "orders.db"), store = openStore(database), db = store.handle;
    const adapter = releaseAdapters({ checkout: "/rv", database }).toolroll;
    try {
      db.exec("INSERT INTO chat_turn(approver,credential_key,provider,model,state,created_at,reserved_microusd) VALUES('alex','fixture','codex-subscription','fixture','queued','2000-01-01',0)");
      expect(await adapter.busy()).toEqual({ running: 1, tasks: [] });
      db.exec("UPDATE chat_turn SET state='answered'");
      expect(await adapter.busy()).toEqual({ running: 0, tasks: [] });
    } finally { store.close(); }
  });

  test("a missing database cannot be mistaken for idle or created by the quiet check", async () => {
    const database = join(root(), "missing.db");
    await expect(releaseAdapters({ checkout: "/rv", database }).toolroll.busy()).rejects.toThrow();
    expect(existsSync(database)).toBe(false);
  });

  test("bump only the formula's url and sha256", () => {
    const formula = `class Toolroll < Formula\n  desc "x"\n  url "https://registry.npmjs.org/toolroll/-/toolroll-0.9.51.tgz"\n  sha256 "${"0".repeat(64)}"\n  depends_on "node"\nend\n`;
    expect(bumpFormula(formula, "https://registry.npmjs.org/toolroll/-/toolroll-0.9.52.tgz", "f".repeat(64)))
      .toBe(`class Toolroll < Formula\n  desc "x"\n  url "https://registry.npmjs.org/toolroll/-/toolroll-0.9.52.tgz"\n  sha256 "${"f".repeat(64)}"\n  depends_on "node"\nend\n`);
    expect(() => bumpFormula("class Toolroll < Formula\nend\n", "u", "f".repeat(64))).toThrow(/no url and sha256/);
  });

  test("reads the deployed commit from the runtime manifest, never the package version", async () => {
    const runtime = join(root(), "runtime"), pkg = join(runtime, "node_modules", "toolroll"), dist = join(pkg, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.9.52" }));
    const adapter = releaseAdapters({ checkout: "/rv" }).toolroll;
    expect(await adapter.runtimeCommit(dist)).toBeNull();
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ candidate: SHA }));
    expect(await adapter.runtimeCommit(dist)).toBe(SHA);
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ candidate: "0.9.52" }));
    expect(await adapter.runtimeCommit(dist)).toBeNull();
  });

  test("deploy and recovery run the approved commit's own script, extracted by the release, with the persisted stage and bounded runtime", async () => {
    const stage = root(), database = join(stage, "orders.db"), { project, head: approved } = projectAt(stage);
    const { runId, head } = provableCandidate(database, "deploy-me", "person", approved, project);
    const input = { stage, run: runId, worktree: "/w/7" };
    const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
    const run: Exec = async (command, args, options) => {
      calls.push({ command, args, options });
      return extracting(command, args) ?? { code: 0, stdout: JSON.stringify({ runtime: "/new/dist" }), stderr: "" };
    };
    const adapter = releaseAdapters({ checkout: "/rv", run, deployMinutes: 3, database, processes: () => [] }).toolroll;
    // A crash before preparation installed any gate needs no rollback.
    expect(await adapter.recoverDeploy(input)).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
    expect(await adapter.deploy(input)).toEqual({ ok: true, runtime: "/new/dist" });
    writeFileSync(join(stage, "deployment.json"), "{}");
    expect(await adapter.recoverDeploy(input)).toEqual({ ok: true });
    const gitDir = realpathSync(join(project, ".git"));
    const scripts = calls.filter(one => one.command === process.execPath);
    expect(scripts.map(one => one.args.slice(1))).toEqual([
      ["--run", String(runId), "--stage", stage, "--source", "/w/7", "--head", head, "--git-dir", gitDir, "--yes"],
      ["--run", String(runId), "--stage", stage, "--source", "/w/7", "--head", head, "--git-dir", gitDir, "--phase", "recover"],
    ]);
    for (const call of scripts) {
      // The script is the release's own extraction of the commit, run from there, never from the checkout.
      const cwd = (call.options as { cwd: string }).cwd;
      expect(call.args[0]).toBe(join(cwd, "scripts", "deploy-browser.mjs"));
      expect(cwd).not.toBe("/w/7");
      expect(call.options).toMatchObject({ timeoutMs: 180_000 });
    }
    // The extraction is this runtime's own (no git or tar through the stand-in), and only the node runs go out.
    expect(calls.every(one => one.command === process.execPath)).toBe(true);
    const failed = releaseAdapters({ checkout: "/rv", database, processes: () => [], run: async (command, args) => extracting(command, args) ?? { code: 124, stdout: "", stderr: "recovery timed out" } }).toolroll;
    expect(await failed.recoverDeploy(input)).toEqual({ ok: false, message: expect.stringMatching(/^recovery timed out \(the deployment journal is at an unreadable phase;/) });
  });

  test("reads the runtime from the deployer's last JSON line, and only a dist folder", () => {
    expect(deployedRuntime(`• healthy\n{"deployed":"${SHA}","runtime":"/s/runtime/node_modules/toolroll/dist","at":"x"}\n`)).toBe("/s/runtime/node_modules/toolroll/dist");
    expect(deployedRuntime(`{"runtime":"/old/dist"}\n• note\n{"runtime":"/new/dist"}`)).toBe("/new/dist");
    expect(deployedRuntime(`{"runtime":"/s/runtime"}`)).toBeNull();
    expect(deployedRuntime("✗ The new service did not come up.")).toBeNull();
  });

  test("an exit 0 without a runtime is a stop, not a deployment", async () => {
    const stage = root(), database = join(stage, "orders.db");
    const { project, head } = projectAt(stage);
    const { runId } = provableCandidate(database, "deploy-me", "person", head, project);
    const run: Exec = async (command, args) => extracting(command, args) ?? { code: 0, stdout: "Add --yes to drain the plane, back up the database, and swap the service.", stderr: "" };
    expect(await releaseAdapters({ checkout: "/rv", run, database }).toolroll.deploy({ stage, run: runId, worktree: "/w/7" }))
      .toEqual({ ok: false, message: "Add --yes to drain the plane, back up the database, and swap the service." });
  });

  describe("a deployment that stopped before its swap", () => {
    const ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const paused = (phase: string, owned: boolean) => {
      const stage = root(), database = join(stage, "orders.db");
      const { project, head } = projectAt(stage);
      const { runId } = provableCandidate(database, "deploy-me", "person", head, project);
      if (owned) { const db = new DatabaseSync(database) as unknown as Database; try { installUpdateGate(db, ID); } finally { db.close(); } }
      writeFileSync(join(stage, "deployment.json"), JSON.stringify({ id: ID, phase }));
      return { stage, database, input: { stage, run: runId, worktree: "/w/7" } };
    };
    const exit1: Exec = async (command, args) => extracting(command, args) ?? { code: 1, stdout: "", stderr: "The deployment stopped at preparing" };

    test("names its pause only when the journal is before the swap and the live pause is that deployment's", () => {
      expect(stageGate(paused("preparing", true).stage, () => ID)).toEqual({ id: ID, phase: "preparing" });
      expect(stageGate(paused("rehearsed", true).stage, () => ID)).toEqual({ id: ID, phase: "rehearsed" });
      expect(stageGate(paused("stopping", true).stage, () => ID)).toBeNull();
      expect(stageGate(paused("preparing", false).stage, () => null)).toBeNull();
      expect(stageGate(root(), () => ID)).toBeNull();
    });

    test("recovery offers the guided gate release for a held pause, and passes one never installed", async () => {
      const held = paused("preparing", true);
      expect(await releaseAdapters({ checkout: "/rv", database: held.database, processes: () => [], run: exit1 }).toolroll.recoverDeploy(held.input))
        .toMatchObject({ ok: false, gate: { id: ID, phase: "preparing" } });
      const never = paused("preparing", false);
      expect(await releaseAdapters({ checkout: "/rv", database: never.database, processes: () => [], run: exit1 }).toolroll.recoverDeploy(never.input)).toEqual({ ok: true });
      const failedDeploy = await releaseAdapters({ checkout: "/rv", database: held.database, processes: () => [], run: exit1 }).toolroll.deploy(held.input);
      expect(failedDeploy).toMatchObject({ ok: false, gate: { id: ID } });
    });

    test("never recovers under a deployment that is still running", async () => {
      const held = paused("frozen", true);
      const calls: unknown[] = [];
      const run: Exec = async (...args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
      const processes = () => [{ pid: fakePid(1), command: `node scripts/deploy-browser.mjs --run 7 --stage ${held.stage} --yes` }];
      expect(await releaseAdapters({ checkout: "/rv", database: held.database, processes, run }).toolroll.recoverDeploy(held.input))
        .toMatchObject({ ok: false, message: expect.stringContaining(`still running (process ${fakePid(1)})`) });
      expect(calls).toEqual([]);
    });
  });

  test("merge with the head pinned, list check attempts oldest first, and find a missing tag as none", async () => {
    const calls: string[][] = [];
    const run: Exec = async (command, args) => {
      calls.push([command, ...args]);
      const joined = args.join(" ");
      if (joined.includes("/pulls/170/merge")) return { code: 0, stdout: JSON.stringify({ sha: "m".repeat(40), merged: true }), stderr: "" };
      // Which workflow each suite is a run of (the CI reader asks): none here.
      if (joined.includes("/actions/runs")) return { code: 0, stdout: "", stderr: "" };
      if (joined.includes("check-runs")) return { code: 0, stdout: `{"id":9,"name":"x","status":"completed","conclusion":"success","app":"github-actions"}\n{"id":3,"name":"x","status":"completed","conclusion":"failure","app":null}\n`, stderr: "" };
      if (joined.includes("git/ref/tags/v0.9.52")) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const adapters = releaseAdapters({ checkout: "/rv", run, tools: TOOLS });
    expect(await adapters.github.merge("ap9000/toolroll", 170, SHA)).toBe("m".repeat(40));
    expect(calls[0]).toEqual([TOOLS.gh, "api", "-X", "PUT", "repos/ap9000/toolroll/pulls/170/merge", "-f", "merge_method=squash", "-f", `sha=${SHA}`]);
    expect((await adapters.github.checks("ap9000/toolroll", SHA)).map(one => [one.conclusion, one.app])).toEqual([["failure", null], ["success", "github-actions"]]);
    expect(await adapters.github.tag("ap9000/toolroll", "v0.9.52")).toBeNull();
  });

  test("ask npm for the exact version", async () => {
    const fetchFor = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await releaseAdapters({ checkout: "/rv", fetch: fetchFor(200, { version: "0.9.52" }) }).registry.published("toolroll", "0.9.52")).toBe(true);
    expect(await releaseAdapters({ checkout: "/rv", fetch: fetchFor(404, {}) }).registry.published("toolroll", "0.9.52")).toBe(false);
    await expect(releaseAdapters({ checkout: "/rv", fetch: fetchFor(503, {}) }).registry.published("toolroll", "0.9.52")).rejects.toThrow(/503/);
  });

  test.each([SHA, null, "b".repeat(40)])("deletes only the merged remote head, with a lease (%s)", async head => {
    const calls: (readonly string[])[] = [];
    const run: Exec = async (_command, args) => {
      calls.push(args);
      return { code: 0, stderr: "", stdout: args.includes("ls-remote") && head !== null ? `${head}\trefs/heads/release-me\n` : "" };
    };
    const deletion = releaseAdapters({ checkout: "/rv", run, releaseRepo: REPO, tools: TOOLS }).repo.deleteBranch("release-me", SHA);
    if (head !== null && head !== SHA) await expect(deletion).rejects.toThrow(/not deleted/);
    else await deletion;
    // The recorded URL, never the checkout's origin, with the hardened settings ahead of the push.
    expect(calls.filter(one => one.includes("push")).map(one => one.slice(one.indexOf("push")))).toEqual(head === SHA
      ? [["push", "--no-verify", `--force-with-lease=refs/heads/release-me:${SHA}`, "toolroll-release", ":refs/heads/release-me"]] : []);
    expect(calls.filter(one => one.includes("push")).every(one => one[0] === "--git-dir=/rv/.git" && one.includes("protocol.allow=never") && one.includes(`remote.toolroll-release.pushurl=${REPO.remote}`))).toBe(true);
  });

  test.each([[null, "resolves"], [SHA, "rejects"]] as const)("a failed delete is fine only when the branch is gone after it (%s)", async (after, outcome) => {
    let looks = 0;
    const run: Exec = async (_command, args) => {
      if (args.includes("push")) return { code: 1, stderr: "error: unable to delete 'release-me': remote ref does not exist", stdout: "" };
      if (args.includes("config")) return { code: 0, stderr: "", stdout: "" };
      looks += 1;
      const head = looks === 1 ? SHA : after;
      return { code: 0, stderr: "", stdout: head === null ? "" : `${head}\trefs/heads/release-me\n` };
    };
    const paused: number[] = [];
    const deletion = releaseAdapters({ checkout: "/rv", run, releaseRepo: REPO, tools: TOOLS, sleep: async ms => { paused.push(ms); } }).repo.deleteBranch("release-me", SHA);
    if (outcome === "resolves") await deletion;
    else await expect(deletion).rejects.toThrow(/deleting merged branch release-me failed: error: unable to delete/);
    expect(looks).toBe(outcome === "resolves" ? 2 : 1 + BRANCH_GONE_LOOKS);
    expect(paused).toEqual(outcome === "resolves" ? [] : Array(BRANCH_GONE_LOOKS - 1).fill(BRANCH_GONE_PAUSE_MS));
  });

  test("a branch GitHub deleted itself, whose ref lags a few seconds, counts as deleted", async () => {
    // Releases 0.9.66 and 0.9.67 both stopped here: the push lost the race, and the next look still saw the old ref.
    let looks = 0;
    const run: Exec = async (_command, args) => {
      if (args.includes("push")) return { code: 1, stderr: "! [remote rejected] release-me (cannot lock ref 'refs/heads/release-me': unable to resolve reference)", stdout: "" };
      if (args.includes("config")) return { code: 0, stderr: "", stdout: "" };
      looks += 1;
      return { code: 0, stderr: "", stdout: looks <= 3 ? `${SHA}\trefs/heads/release-me\n` : "" };
    };
    await releaseAdapters({ checkout: "/rv", run, releaseRepo: REPO, tools: TOOLS, sleep: async () => {} }).repo.deleteBranch("release-me", SHA);
    expect(looks).toBe(4);
  });

  test.each([
    ["on:\n  schedule:\n    - cron: \"17 */6 * * *\"\n  workflow_dispatch:\njobs:\n  bump:\n    steps:\n      - run: git push\n", false],
    ["on: [push, workflow_dispatch]\n", true],
    ["on: pull_request\n", true],
    ["\"on\":\n  pull_request_target:\n    branches: [main]\n", true],
    ["on:\n  schedule: # not a push\n    - cron: x\n", false],
    ["on:\n  merge_group:\n", true],
    ["name: nothing here\njobs: {}\n", true],
    ["on:\n- pull_request\n- push\n", true],
    ["on:\n  workflow_dispatch:\n    inputs:\n      why:\n        description: push the formula\n", false],
    ["on: [unclosed\n", true],
    ["on:\n  - 3\n", true],
  ] as const)("reads a workflow's own triggers, never its steps (%#)", (yaml, runs) => {
    expect(workflowRunsOnChange(yaml)).toBe(runs);
  });

  const SCHEDULED = "on:\n  schedule:\n    - cron: x\njobs:\n  a:\n    steps:\n      - run: git push\n";
  /** A tap whose workflow folder, per ref, holds these files (null: no folder at that ref). */
  const tapWith = (refs: Record<string, Record<string, string> | null>, calls: (readonly string[])[] = []): Exec => async (_command, args) => {
    calls.push(args);
    const url = args.find(one => one.startsWith("repos/")) ?? "";
    if (url === "repos/ap9000/homebrew-toolroll") return { code: 0, stderr: "", stdout: "main\n" };
    const [path, query] = url.split("?") as [string, string];
    const files = refs[decodeURIComponent(query.replace(/^ref=/, ""))];
    if (files === null || files === undefined) return { code: 1, stderr: "gh: Not Found (HTTP 404)", stdout: "" };
    if (path.endsWith("/contents/.github/workflows")) return { code: 0, stderr: "", stdout: Object.keys(files).map(one => `.github/workflows/${one}\n`).join("") };
    const name = path.split("/").pop()!;
    return { code: 0, stderr: "", stdout: `${Buffer.from(files[name] ?? "").toString("base64")}\n` };
  };

  test.each([
    ["the real tap: a scheduled bump only", { [SHA]: { "bump.yml": SCHEDULED }, main: { "bump.yml": SCHEDULED } }, false],
    ["no workflows anywhere", { [SHA]: null, main: null }, false],
    ["the change itself adds a pull_request workflow", { [SHA]: { "bump.yml": SCHEDULED, "ci.yml": "on: pull_request\n" }, main: { "bump.yml": SCHEDULED } }, true],
    ["the base has a pull_request_target workflow", { [SHA]: { "bump.yml": SCHEDULED }, main: { "t.yaml": "on:\n  pull_request_target:\n" } }, true],
    ["a non-workflow file is skipped", { [SHA]: { "README.md": "push pull_request" }, main: null }, false],
  ] as const)("a tap owes checks only when a workflow at the change or its base runs on a change (%s)", async (_name, refs, checked) => {
    expect(await releaseAdapters({ checkout: "/rv", run: tapWith(refs as never) }).homebrew.checked(SHA)).toBe(checked);
  });

  test("a tap whose workflows can't be listed stops; one it can't read counts as checked", async () => {
    // A 5xx is asked again (release-net.ts) before it stops; no real pauses here.
    const releaseAdapters = (options: Parameters<typeof quietAdapters>[0]) => quietAdapters({ ...options, sleep: async () => {} });
    const unlisted: Exec = async (_command, args) => args.includes("repos/ap9000/homebrew-toolroll") ? { code: 0, stderr: "", stdout: "main\n" } : { code: 1, stderr: "HTTP 502", stdout: "" };
    await expect(releaseAdapters({ checkout: "/rv", run: unlisted }).homebrew.checked(SHA)).rejects.toThrow(/listing .*workflows at/);
    const unreadable: Exec = async (_command, args) => {
      const url = args.find(one => one.startsWith("repos/")) ?? "";
      if (url.includes("/contents/.github/workflows?")) return { code: 0, stderr: "", stdout: ".github/workflows/x.yml\n" };
      return url === "repos/ap9000/homebrew-toolroll" ? { code: 0, stderr: "", stdout: "main\n" } : { code: 1, stderr: "HTTP 500", stdout: "" };
    };
    expect(await releaseAdapters({ checkout: "/rv", run: unreadable }).homebrew.checked(SHA)).toBe(true);
  });

  test("reads the change's commit statuses as check runs, oldest first", async () => {
    const calls: (readonly string[])[] = [];
    const run: Exec = async (_command, args) => {
      calls.push(args);
      return { code: 0, stderr: "", stdout: ['{"context":"ci","state":"failure"}', '{"context":"ci","state":"pending"}', '{"context":"lint","state":"success"}', '{"context":"x","state":"error"}'].join("\n") };
    };
    expect(await releaseAdapters({ checkout: "/rv", run }).homebrew.statuses(SHA)).toEqual([
      { name: "status: x", status: "completed", conclusion: "failure" },
      { name: "status: lint", status: "completed", conclusion: "success" },
      { name: "status: ci", status: "in_progress", conclusion: null },
      { name: "status: ci", status: "completed", conclusion: "failure" },
    ]);
    expect(calls[0]).toEqual(expect.arrayContaining(["--paginate", `repos/ap9000/homebrew-toolroll/commits/${SHA}/statuses?per_page=100`]));
  });

  test("a successful HTTP response that refuses the tap merge is not a completed release", async () => {
    const run: Exec = async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ merged: false, message: "Required check is pending" }) });
    await expect(releaseAdapters({ checkout: "/rv", run }).homebrew.merge(12, SHA)).rejects.toThrow(/did not merge.*Required check is pending/);
  });
});

/** A stand-in for the release's extraction of the approved commit: git archive and tar succeed (writing nothing). */
function extracting(command: string, args: readonly string[]): { code: number; stdout: string; stderr: string } | null {
  if (command === "git" && args.includes("archive")) return { code: 0, stdout: "", stderr: "" };
  if (command === "tar") return { code: 0, stdout: "", stderr: "" };
  return null;
}

/** A real project repository with an approved deployment script committed; its own Git directory is what the release
 * reads the approved commit from. */
function projectAt(stage: string): { project: string; head: string } {
  const project = join(stage, "project");
  mkdirSync(join(project, "scripts"), { recursive: true });
  writeFileSync(join(project, "scripts", "deploy-browser.mjs"), "console.log('approved');\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd: project, encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", HOME: stage, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "approved");
  return { project, head: git("rev-parse", "HEAD") };
}

describe("the tap's formula version (pipeline-speed.md, P1: an older release never overwrites a newer formula)", () => {
  test("reads the version the formula's tarball names, and orders versions numerically", async () => {
    const { formulaVersion, versionAfter } = await import("./release-adapters.js");
    expect(formulaVersion('class Toolroll < Formula\n  url "https://registry.npmjs.org/toolroll/-/toolroll-0.9.78.tgz"\n  sha256 "' + "a".repeat(64) + '"\n')).toBe("0.9.78");
    expect(formulaVersion("no url here")).toBeNull();
    expect(versionAfter("0.9.10", "0.9.9")).toBe(true);
    expect(versionAfter("0.9.9", "0.9.10")).toBe(false);
    expect(versionAfter("0.9.77", "0.9.77")).toBe(false);
    expect(versionAfter("1.0.0", "0.99.99")).toBe(true);
  });
});

describe("security scan: only the tap's own branch is a Homebrew change", () => {
  test("a fork's pull request of the same branch name never counts", async () => {
    const { tapOwnHead } = await import("./release-adapters.js");
    const own = { isCrossRepository: false, headRepository: { name: "homebrew-toolroll" }, headRepositoryOwner: { login: "ap9000" } };
    expect(tapOwnHead(own, "ap9000/homebrew-toolroll")).toBe(true);
    expect(tapOwnHead({ ...own, isCrossRepository: true }, "ap9000/homebrew-toolroll")).toBe(false);
    expect(tapOwnHead({ ...own, headRepositoryOwner: { login: "mallory" } }, "ap9000/homebrew-toolroll")).toBe(false);
    expect(tapOwnHead({ ...own, headRepository: { name: "homebrew-other" } }, "ap9000/homebrew-toolroll")).toBe(false);
    expect(tapOwnHead({ number: 1 }, "ap9000/homebrew-toolroll")).toBe(false);
  });
});

describe("security scan: only exactly the formula bump is ever merged into the tap", () => {
  const base = "b".repeat(40), head = "c".repeat(40), sha256 = "d".repeat(64);
  const formula = "Formula/toolroll.rb";
  const expected = `url "https://registry.npmjs.org/toolroll/-/toolroll-0.9.78.tgz"\nsha256 "${sha256}"\n`;
  const view = { number: 12, headRefOid: head, headRefName: "toolroll-0.9.78", baseRefName: "main", state: "OPEN", isCrossRepository: false, headRepository: { name: "homebrew-toolroll" }, headRepositoryOwner: { login: "ap9000" } };
  const compare = { status: "ahead", ahead_by: 1, behind_by: 0, merge_base_commit: { sha: base }, files: [{ filename: formula, status: "modified" }] };
  const input = { tap: "ap9000/homebrew-toolroll", pr: 12, head, version: "0.9.78", formula, defaultBranch: "main", baseHead: base, baseVersion: "0.9.77", view, compare, expected, atHead: expected, sha256 };

  test.each([
    ["exactly the bump", {}, null],
    ["a newer version landed since the state check", { baseVersion: "0.9.79" }, /already names newer/],
    ["an unreadable current formula version", { baseVersion: null }, /current version/],
    ["a change that also touches another file", { compare: { ...compare, files: [...compare.files, { filename: ".github/workflows/x.yml", status: "added" }] } }, /changes more than/],
    ["a branch with an extra commit", { compare: { ...compare, ahead_by: 2 } }, /exactly one commit/],
    ["a branch not on the default branch's head", { compare: { ...compare, merge_base_commit: { sha: "e".repeat(40) } } }, /isn't on main's head/],
    ["a pull request into another base", { view: { ...view, baseRefName: "release" } }, /merges into release/],
    ["a fork's pull request", { view: { ...view, isCrossRepository: true } }, /isn't the tap's own/],
    ["a moved head", { view: { ...view, headRefOid: "f".repeat(40) } }, /isn't the tap's own/],
    ["a formula with another sha256", { atHead: expected.replace(sha256, "a".repeat(64)) }, /sha256/],
  ] as const)("%s", async (_name, over, why) => {
    const { tapChangeProblem } = await import("./release-adapters.js");
    const problem = tapChangeProblem({ ...input, ...over } as typeof input);
    if (why === null) expect(problem).toBeNull(); else expect(problem).toMatch(why);
  });
});
