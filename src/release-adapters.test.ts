import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { installUpdateGate } from "./desktop-update-gate.js";
import { bumpFormula, cliRuntimes, deployedRuntime, gateStateOf, githubSlug, releaseAdapters, serviceRuntimes, stageGate, type Exec } from "./release-adapters.js";
import { openStore, type Database } from "./store.js";
import { fakePid } from "../test/fake-pid.js";

const root = () => mkdtempSync(join(tmpdir(), "so-release-adapters-"));
const SHA = "a".repeat(40);

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
      result: { run: 7, head: SHA, check: "passed", level: "full", receipt: "r1", worktree: "/w/7" }, failed: null,
      completion: { actor: "lead:alex", at: "y", digest: "r1" },
    });
    // A follow-up check still running on that commit is not a result yet.
    expect(gateStateOf({ ...show, assignment: { ...show.assignment, result: { ...show.assignment.result, checks: { status: "passed", running: "full" } } } }).result?.check).toBe("running");
    // A newer build that ended without a result failed before its check.
    expect(gateStateOf({ ...show, runs: [...show.runs, { id: 9, role: "builder", outcome: "failed", finishedAt: "z" }] }).failed).toBe("run 9 ended failed");
    expect(gateStateOf({ ok: false, command: "task show", reason: "unknown-task" })).toMatchObject({ exists: false });
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

  test("deploy and recovery invoke the candidate script with the persisted stage and bounded runtime", async () => {
    const stage = root(), input = { stage, run: 7, worktree: "/w/7" };
    const calls: { args: readonly string[]; options: unknown }[] = [];
    const run: Exec = async (_command, args, options) => {
      calls.push({ args, options });
      return { code: 0, stdout: JSON.stringify({ runtime: "/new/dist" }), stderr: "" };
    };
    const database = join(stage, "no-such.db");
    const adapter = releaseAdapters({ checkout: "/rv", run, deployMinutes: 3, database, processes: () => [] }).toolroll;
    // A crash before preparation installed any gate needs no rollback.
    expect(await adapter.recoverDeploy(input)).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
    expect(await adapter.deploy(input)).toEqual({ ok: true, runtime: "/new/dist" });
    writeFileSync(join(stage, "deployment.json"), "{}");
    expect(await adapter.recoverDeploy(input)).toEqual({ ok: true });
    expect(calls.map(one => one.args)).toEqual([
      ["scripts/deploy-browser.mjs", "--run", "7", "--stage", stage, "--yes"],
      ["scripts/deploy-browser.mjs", "--run", "7", "--stage", stage, "--phase", "recover"],
    ]);
    for (const call of calls) expect(call.options).toMatchObject({ cwd: "/w/7", timeoutMs: 180_000 });
    const failed = releaseAdapters({ checkout: "/rv", database, processes: () => [], run: async () => ({ code: 124, stdout: "", stderr: "recovery timed out" }) }).toolroll;
    expect(await failed.recoverDeploy(input)).toEqual({ ok: false, message: expect.stringMatching(/^recovery timed out \(the deployment journal is at an unreadable phase;/) });
  });

  test("reads the runtime from the deployer's last JSON line, and only a dist folder", () => {
    expect(deployedRuntime(`• healthy\n{"deployed":"${SHA}","runtime":"/s/runtime/node_modules/toolroll/dist","at":"x"}\n`)).toBe("/s/runtime/node_modules/toolroll/dist");
    expect(deployedRuntime(`{"runtime":"/old/dist"}\n• note\n{"runtime":"/new/dist"}`)).toBe("/new/dist");
    expect(deployedRuntime(`{"runtime":"/s/runtime"}`)).toBeNull();
    expect(deployedRuntime("✗ The new service did not come up.")).toBeNull();
  });

  test("an exit 0 without a runtime is a stop, not a deployment", async () => {
    const stage = root();
    const run: Exec = async () => ({ code: 0, stdout: "Add --yes to drain the plane, back up the database, and swap the service.", stderr: "" });
    expect(await releaseAdapters({ checkout: "/rv", run, database: join(stage, "none.db") }).toolroll.deploy({ stage, run: 7, worktree: "/w/7" }))
      .toEqual({ ok: false, message: "Add --yes to drain the plane, back up the database, and swap the service." });
  });

  describe("a deployment that stopped before its swap", () => {
    const ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const paused = (phase: string, owned: boolean) => {
      const stage = root(), database = join(stage, "orders.db");
      openStore(database).close();
      if (owned) { const db = new DatabaseSync(database) as unknown as Database; try { installUpdateGate(db, ID); } finally { db.close(); } }
      writeFileSync(join(stage, "deployment.json"), JSON.stringify({ id: ID, phase }));
      return { stage, database, input: { stage, run: 7, worktree: "/w/7" } };
    };
    const exit1: Exec = async () => ({ code: 1, stdout: "", stderr: "The deployment stopped at preparing" });

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
      if (joined.includes("check-runs")) return { code: 0, stdout: `{"id":9,"name":"x","status":"completed","conclusion":"success"}\n{"id":3,"name":"x","status":"completed","conclusion":"failure"}\n`, stderr: "" };
      if (joined.includes("git/ref/tags/v0.9.52")) return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const adapters = releaseAdapters({ checkout: "/rv", run });
    expect(await adapters.github.merge("ap9000/toolroll", 170, SHA)).toBe("m".repeat(40));
    expect(calls[0]).toEqual(["gh", "api", "-X", "PUT", "repos/ap9000/toolroll/pulls/170/merge", "-f", "merge_method=squash", "-f", `sha=${SHA}`]);
    expect((await adapters.github.checks("ap9000/toolroll", SHA)).map(one => one.conclusion)).toEqual(["failure", "success"]);
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
    const deletion = releaseAdapters({ checkout: "/rv", run }).repo.deleteBranch("release-me", SHA);
    if (head !== null && head !== SHA) await expect(deletion).rejects.toThrow(/not deleted/);
    else await deletion;
    expect(calls.filter(one => one.includes("push"))).toEqual(head === SHA
      ? [["-C", "/rv", "push", `--force-with-lease=refs/heads/release-me:${SHA}`, "origin", ":refs/heads/release-me"]] : []);
  });

  test("a successful HTTP response that refuses the tap merge is not a completed release", async () => {
    const run: Exec = async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ merged: false, message: "Required check is pending" }) });
    await expect(releaseAdapters({ checkout: "/rv", run }).homebrew.merge(12, SHA)).rejects.toThrow(/did not merge.*Required check is pending/);
  });
});
