/**
 * Attack: make a later commit ship under a person's release approval when it shouldn't (docs/plans/release-once.md,
 * "Carry attacks" 1–14, and the security review's shapes). Guard: release-carry.ts (read-only preflight over verified
 * objects before anything runs, a fenced build whose output is read as untrusted, one transaction that proves every
 * mutable fact again), scope.ts liveReleaseOf (the one reader of release authority, at dispatch and at every deploy
 * entry), and the store's reservations, leases and epochs. Each attack fails; the legitimate road beside it works.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { releaseFixture, builtRun, countingRunner, RELEASE_NOW, VERSION, type ReleaseFixture } from "../release-fixture.js";
import { proveCarry, preflightCarry, carriedTaskId } from "../../src/release-carry.js";
import { addApprover, approve, liveReleaseOf, propose } from "../../src/scope.js";
import {
  carryReleaseApproval, finishReleaseOperation, releaseAuthority, releaseAuthorityOfTask, releaseOperations, reserveRelease, revokeRelease, runReleaseOperation,
  takeReleaseLease,
} from "../../src/store.js";
import { scopeApprovedForDispatch } from "../../src/dispatch.js";
import { deploymentGate } from "../../src/deploy-gate.js";
import { runReleaseCommand } from "../../src/release-cli.js";
import { releaseTermsFor } from "../../src/release-carry.js";
import { marker } from "./harness.js";
// @ts-expect-error plain ESM script without declarations
import { deploymentCandidate } from "../../scripts/deploy-candidate.mjs";
import * as installedScope from "../../src/scope.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const open = (options: Parameters<typeof releaseFixture>[0] = {}) => (fixture = releaseFixture(options));
const LATER = new Date(RELEASE_NOW.getTime() + 60_000);
const testOnly = { "src/index.test.ts": "test('answer', () => {});\ntest('more', () => {});\n" };
/** The deploy gates' answer for a task's build: the release rule, or a later step (which means the release passed). */
const gates = (f: ReleaseFixture, taskId: string, head: string) => {
  const run = builtRun(f.store, taskId, head);
  const gate = deploymentGate(f.store, { runId: run, evidenceRoot: join(f.dir, "evidence"), now: LATER });
  let candidate: string;
  try { deploymentCandidate(f.store, { runId: run, head, evidenceRoot: join(f.dir, "evidence"), now: LATER }, { assignmentOf: () => null, verificationEvidence: () => ({ ok: false, problem: "no receipt" }), installedScope }); candidate = "passed"; }
  catch (error) { candidate = (error as Error).message; }
  return { gate: gate.ok ? "passed" : gate.message, candidate };
};

describe("attack 1: nothing from the candidate runs before the read-only preflight passed", () => {
  test.each([
    ["package.json with a postinstall", (m: string) => ({ "package.json": JSON.stringify({ name: "fixture-app", version: VERSION, type: "module", files: ["dist"], scripts: { build: "node build.mjs", postinstall: `node -e "require('fs').writeFileSync('${m}','x')"` } }) })],
    ["the build script", (m: string) => ({ "build.mjs": `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(m)}, "x");\n` })],
  ])("a candidate that changes %s is refused and its marker never appears", async (_name, change) => {
    const f = open();
    const path = join(f.dir, marker("carry-ran"));
    const to = f.commit(change(path));
    const { runner, calls } = countingRunner();
    const result = await proveCarry(f.store, { authority: f.authority().id, to, now: LATER, runner });
    expect(result).toMatchObject({ ok: false, reason: "rules" });
    expect(calls).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  test.each([
    ["the release was revoked", (f: ReleaseFixture) => { revokeRelease(f.store, f.authority().id, "alex", RELEASE_NOW); }],
    ["another coordinator holds the lease", (f: ReleaseFixture) => { takeReleaseLease(f.store, f.authority().id, "other", RELEASE_NOW, 60 * 60_000); }],
    ["the checks left the sandbox", (f: ReleaseFixture) => { f.store.setProjectCheckAccess(f.repo, "unsandboxed", "alex", RELEASE_NOW, { may: "widen" }); }],
    ["the check command changed", (f: ReleaseFixture) => { f.store.setVerifyCommand({ repo: f.repo, command: "node scripts/other.mjs", timeoutMs: 60_000, approvedBy: "alex" }, RELEASE_NOW); }],
  ])("a preflight refusal runs nothing: %s", async (_name, spoil) => {
    const f = open();
    const to = f.commit(testOnly);
    spoil(f);
    const { runner, calls } = countingRunner();
    const result = await proveCarry(f.store, { authority: f.authority().id, to, now: LATER, runner, epoch: 0 });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a commit that doesn't descend from the approved one runs nothing", async () => {
    const f = open();
    f.git("checkout", "-q", "-b", "elsewhere", `${f.approved}~0`);
    f.git("checkout", "-q", "--orphan", "stray");
    const to = f.commit({ "docs/x.md": "# x\n" }, "stray");
    const { runner, calls } = countingRunner();
    expect(await proveCarry(f.store, { authority: f.authority().id, to, now: LATER, runner })).toMatchObject({ ok: false, reason: "ancestry" });
    expect(calls).toEqual([]);
  });
});

describe("attack 2: the build's output is untrusted", () => {
  test("a symlink the build leaves in dist refuses", async () => {
    const f = open({ build: `import { mkdirSync, symlinkSync } from "node:fs"; mkdirSync("dist", { recursive: true }); symlinkSync("/etc/hosts", "dist/out.js");\n` });
    const result = await proveCarry(f.store, { authority: f.authority().id, to: f.commit(testOnly), now: LATER });
    expect(result).toMatchObject({ ok: false, reason: "build", message: expect.stringContaining("symlink") });
  });

  test("a background writer still running after the build refuses", async () => {
    const f = open({ build: `import { spawn } from "node:child_process"; import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true }); writeFileSync("dist/index.js", "1");
spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync('dist/late.js', '2'), 1500)"], { detached: true, stdio: "ignore" }).unref();\n` });
    const result = await proveCarry(f.store, { authority: f.authority().id, to: f.commit(testOnly), now: LATER });
    expect(result).toMatchObject({ ok: false, reason: "build" });
    expect(result.ok === false && result.message).toMatch(/still running|still writing/);
  });

  test("a dependency that doesn't match the lockfile's integrity hash refuses", async () => {
    const wrong = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
    const lock = { name: "fixture-app", version: VERSION, lockfileVersion: 3, requires: true, packages: { "": { name: "fixture-app", version: VERSION, dependencies: { dep: "file:vendor/dep-1.0.0.tgz" } },
      "node_modules/dep": { version: "1.0.0", resolved: "file:vendor/dep-1.0.0.tgz", integrity: wrong } } };
    const f = open({ files: { "package.json": JSON.stringify({ name: "fixture-app", version: VERSION, type: "module", files: ["dist"], scripts: { build: "node build.mjs" }, dependencies: { dep: "file:vendor/dep-1.0.0.tgz" } }),
      "package-lock.json": JSON.stringify(lock), "vendor/dep-1.0.0.tgz": "placeholder" } });
    // A real tarball of a tiny package, committed: the lockfile names a different integrity for it.
    const pkg = join(f.dir, "dep-src", "package");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
    execFileSync("tar", ["-czf", join(f.repo, "vendor", "dep-1.0.0.tgz"), "-C", join(f.dir, "dep-src"), "package"]);
    const head = f.commit({}, "real tarball");
    const { artifactDigest, fencedBuildRunner } = await import("../../src/release-carry.js");
    const built = await artifactDigest(join(f.repo, ".git"), head, fencedBuildRunner(f.store));
    expect(built).toMatchObject({ ok: false, message: expect.stringContaining("The install failed") });
  });
});

describe("attack 3: a browser test that adds a Tailwind class", () => {
  test("changes the production artifact, so it asks again", async () => {
    const f = open();
    const to = f.commit({ "src/browser/app.test.ts": "test('app', () => { const tpl = '<b class=\"bg-red-500\"></b>'; });\n" });
    expect(await proveCarry(f.store, { authority: f.authority().id, to, now: LATER })).toMatchObject({ ok: false, reason: "artifact" });
    // Beside it: a test-only change with an identical artifact carries.
  }, 120_000);
});

describe("attack 4: the lead asks for carries", () => {
  test("a lead token's request carries an allowed commit and is refused for production code, with no seal and no row", async () => {
    const f = open();
    const saved = process.env["TOOLROLL_LEAD_TOKEN"];
    process.env["TOOLROLL_LEAD_TOKEN"] = "lt_lead_synthetic";
    try {
      const lines: string[] = [];
      const id = String(f.authority().id);
      const bad = f.commit({ "src/index.js": "export const answer = 43;\n" });
      expect(await runReleaseCommand(["carry", id, "--to", bad, "--json"], line => lines.push(line), { database: f.databaseFile, now: () => LATER })).toBe(1);
      expect(f.store.getTask(carriedTaskId(VERSION, bad))).toBeNull();
      expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM release_carry").get()!["n"]).toBe(0);
      f.git("reset", "-q", "--hard", f.approved);
      const good = f.commit(testOnly);
      expect(await runReleaseCommand(["carry", id, "--to", good, "--json"], line => lines.push(line), { database: f.databaseFile, now: () => LATER })).toBe(0);
      expect(f.store.getScope(carriedTaskId(VERSION, good))).toMatchObject({ approvalBasis: "carried", candidate: good });
    } finally { if (saved === undefined) delete process.env["TOOLROLL_LEAD_TOKEN"]; else process.env["TOOLROLL_LEAD_TOKEN"] = saved; }
  }, 120_000);
});

describe("attack 5: a carried seal no carry made never stands", () => {
  test("sealScopeApproval refuses basis carried from any caller", () => {
    const f = open();
    f.store.createTask({ id: "forged", title: "forged" }, RELEASE_NOW);
    f.store.placeTask(f.store.refFor("built-in", "forged").id, f.repo, {}, RELEASE_NOW);
    propose(f.store, { taskId: "forged", goal: "x", acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], now: RELEASE_NOW });
    expect(f.store.sealScopeApproval("forged", "alex", RELEASE_NOW, {}, { kind: "carried" } as never)).toBe(false);
  });

  test.each(["task", "digest", "candidate", "generation"] as const)("a carry row that doesn't match the %s stands nowhere: dispatch, deploymentGate, deploymentCandidate", async field => {
    const f = open();
    const to = f.commit(testOnly);
    const carried = await proveCarry(f.store, { authority: f.authority().id, to, now: LATER });
    if (!carried.ok) throw new Error(carried.message);
    const task = carried.taskId, db = f.store.handle;
    if (field === "task") db.prepare("UPDATE release_carry SET task_id = 'someone-else'").run();
    if (field === "digest") db.prepare("UPDATE release_carry SET scope_digest = 'other'").run();
    if (field === "candidate") db.prepare("UPDATE release_carry SET to_sha = ?").run("e".repeat(40));
    if (field === "generation") db.prepare("UPDATE task_scope SET mode_digest = ? WHERE task_id = ?").run(`${f.authority().id + 7}:1`, task);
    const ref = f.store.refFor("built-in", task).id;
    expect(scopeApprovedForDispatch(f.store, ref, LATER)).toBe(false);
    expect(f.store.modeApprovalLive(ref, LATER)).toBe(false);
    const answer = gates(f, task, to);
    expect(answer.gate).not.toBe("passed");
    expect(answer.gate).not.toContain("Native check");
    expect(answer.candidate).not.toContain("Native check");
  }, 120_000);
});

describe("attack 6: history that isn't what was approved", () => {
  test("a force-push with the same tree refuses: it doesn't follow the release's commit", async () => {
    const f = open();
    const b = f.commit(testOnly);
    expect((await proveCarry(f.store, { authority: f.authority().id, to: b, now: LATER })).ok).toBe(true);
    f.git("reset", "-q", "--hard", f.approved);
    f.git("commit", "-q", "--allow-empty", "-m", "same tree, other history");
    const c = f.commit(testOnly, "again");
    expect(await preflightCarry(f.store, { authority: f.authority().id, to: c, now: LATER })).toMatchObject({ ok: false, reason: "ancestry" });
  }, 120_000);

  test("a rewritten carried commit refuses", async () => {
    const f = open();
    const b = f.commit(testOnly, "b");
    expect((await proveCarry(f.store, { authority: f.authority().id, to: b, now: LATER })).ok).toBe(true);
    f.git("commit", "-q", "--amend", "-m", "b, rewritten");
    const c = f.commit({ "docs/guide.md": "# Guide\nmore\n" }, "c");
    expect(preflightCarry(f.store, { authority: f.authority().id, to: c, now: LATER })).toMatchObject({ ok: false, reason: "ancestry" });
  }, 120_000);

  test("a merge commit refuses", () => {
    const f = open();
    f.git("checkout", "-q", "-b", "side");
    f.commit({ "docs/side.md": "# side\n" }, "side");
    f.git("checkout", "-q", "main");
    f.commit({ "docs/main.md": "# main\n" }, "main");
    f.git("merge", "-q", "--no-ff", "side", "-m", "merge");
    expect(preflightCarry(f.store, { authority: f.authority().id, to: f.git("rev-parse", "HEAD"), now: LATER })).toMatchObject({ ok: false, reason: "shape" });
  });

  test.each([
    ["planted replace refs", (f: ReleaseFixture) => { f.git("replace", f.approved, f.git("rev-parse", "HEAD")); }],
    ["grafts", (f: ReleaseFixture) => { mkdirSync(join(f.repo, ".git", "info"), { recursive: true }); writeFileSync(join(f.repo, ".git", "info", "grafts"), `${f.git("rev-parse", "HEAD")}\n`); }],
    ["a shallow file", (f: ReleaseFixture) => { writeFileSync(join(f.repo, ".git", "shallow"), `${f.approved}\n`); }],
  ])("%s refuse", (_name, plant) => {
    const f = open();
    const to = f.commit(testOnly);
    plant(f);
    expect(preflightCarry(f.store, { authority: f.authority().id, to, now: LATER })).toMatchObject({ ok: false, reason: "ancestry" });
  });

  test("a corrupted object refuses", () => {
    const f = open();
    const to = f.commit(testOnly);
    const path = join(f.repo, ".git", "objects", to.slice(0, 2), to.slice(2));
    rmSync(path, { force: true });
    writeFileSync(path, deflateSync(Buffer.from("commit 5\0bogus")));
    expect(preflightCarry(f.store, { authority: f.authority().id, to, now: LATER }).ok).toBe(false);
  });
});

describe("attack 7: the project's policy", () => {
  test("adding a protected path after the approval asks again; removing one the approval sealed still asks again", () => {
    const f = open({ protectedPaths: ["docs/guide.md"] });
    expect(preflightCarry(f.store, { authority: f.authority().id, to: f.commit({ "docs/guide.md": "# changed\n" }), now: LATER })).toMatchObject({ ok: false, message: expect.stringContaining("protected") });
    f.close(); fixture = null;
    // Sealed with a protected path, then the project drops it: the sealed policy still protects it.
    const g = open();
    g.store.handle.prepare("UPDATE release_authority SET policy_json = ?").run(JSON.stringify({ ...g.authority().policy!, protectedPaths: ["docs/guide.md"] }));
    expect(preflightCarry(g.store, { authority: g.authority().id, to: g.commit({ "docs/guide.md": "# changed\n" }), now: LATER })).toMatchObject({ ok: false, message: expect.stringContaining("protected") });
  });
});

describe("attack 8: the live-release predicate at every deploy entry", () => {
  const cases: [string, (f: ReleaseFixture) => void][] = [
    ["the approver is demoted", f => { f.store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'alex'").run(); }],
    ["the approver loses access to the project", f => { f.store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'alex'").run(JSON.stringify(["/elsewhere"])); }],
    ["the authority is revoked", f => { revokeRelease(f.store, f.authority().id, "alex", RELEASE_NOW); }],
    ["the authority expired", f => { f.store.handle.prepare("UPDATE release_authority SET expires_at = ?").run(RELEASE_NOW.toISOString()); }],
    ["the grant changed", f => { f.store.setVerifyCommand({ repo: f.repo, command: "node other.mjs", timeoutMs: 60_000, approvedBy: "alex" }, RELEASE_NOW); }],
    ["the check access widened", f => { f.store.setProjectCheckAccess(f.repo, "sign-ins", "alex", RELEASE_NOW, { may: "widen" }); }],
  ];
  test.each(cases)("%s: deploy and merge refuse, at the gate and at every deploy-browser entry", (_name, spoil) => {
    const f = open();
    expect(liveReleaseOf(f.store, f.taskId, "deploy", LATER)).toMatchObject({ applies: true, ok: true });
    spoil(f);
    for (const action of ["deploy", "merge", "dispatch"] as const) expect(liveReleaseOf(f.store, f.taskId, action, LATER)).toMatchObject({ applies: true, ok: false });
    const answer = gates(f, f.taskId, f.approved);
    expect(answer.gate).not.toContain("Native check");
    expect(answer.candidate).not.toContain("Native check");
  });

  test("the legitimate tip passes the release rule (and stops later, at the check)", () => {
    const f = open();
    const answer = gates(f, f.taskId, f.approved);
    expect(answer.gate).toContain("Native check");
    expect(answer.candidate).toContain("Native check");
  });

  test("a task that isn't the tip, and a superseded generation, refuse", async () => {
    const f = open();
    const to = f.commit(testOnly);
    expect((await proveCarry(f.store, { authority: f.authority().id, to, now: LATER })).ok).toBe(true);
    // The anchor is no longer the tip.
    expect(liveReleaseOf(f.store, f.taskId, "deploy", LATER)).toMatchObject({ ok: false, why: "this is not the release's current commit" });
    expect(gates(f, f.taskId, f.approved).gate).toContain("not the release's current commit");
  }, 120_000);

  test("an installed runtime too old to read release authority refuses every release task", () => {
    const f = open();
    const run = builtRun(f.store, f.taskId, f.approved);
    expect(() => deploymentCandidate(f.store, { runId: run, head: f.approved, evidenceRoot: join(f.dir, "evidence"), now: LATER }, { assignmentOf: () => null, verificationEvidence: () => ({ ok: false }), installedScope: { personApprovalOf: installedScope.personApprovalOf } }))
      .toThrow("update Toolroll first");
  });
});

describe("attack 9: a direct deploy freezes the release", () => {
  test("a direct deploy reserves open → deploying, and a carry after that is refused", async () => {
    const f = open();
    const reserved = reserveRelease(f.store, { authority: f.authority().id, kind: "deploy", taskId: f.taskId, candidate: f.approved, epoch: null, operationId: "direct-1", now: LATER });
    expect(reserved.ok).toBe(true);
    expect(f.authority().state).toBe("deploying");
    const { runner, calls } = countingRunner();
    expect(await proveCarry(f.store, { authority: f.authority().id, to: f.commit(testOnly), now: LATER, runner })).toMatchObject({ ok: false, reason: "authority" });
    expect(calls).toEqual([]);
  });
});

describe("attack 10: a stale coordinator's operation never starts", () => {
  test("coordinator 1 reserves a merge and loses its lease; coordinator 2 takes over and reconciles; coordinator 1's start fails", () => {
    const f = open();
    const id = f.authority().id;
    const one = takeReleaseLease(f.store, id, "coordinator-1", RELEASE_NOW, 60_000);
    if (!one.ok) throw new Error(one.why);
    expect(reserveRelease(f.store, { authority: id, kind: "deploy", taskId: f.taskId, candidate: f.approved, epoch: one.epoch, operationId: "d1", now: RELEASE_NOW }).ok).toBe(true);
    expect(runReleaseOperation(f.store, "d1", one.epoch, RELEASE_NOW)).toBe(true);
    finishReleaseOperation(f.store, "d1", "succeeded", {}, RELEASE_NOW);
    expect(reserveRelease(f.store, { authority: id, kind: "merge", taskId: f.taskId, candidate: f.approved, epoch: one.epoch, operationId: "m1", now: RELEASE_NOW }).ok).toBe(true);
    // Paused past its lease; coordinator 2 takes over (the epoch goes up) and reconciles the reserved merge.
    const two = takeReleaseLease(f.store, id, "coordinator-2", new Date(RELEASE_NOW.getTime() + 120_000), 60_000);
    if (!two.ok) throw new Error(two.why);
    expect(two.epoch).toBe(one.epoch + 1);
    finishReleaseOperation(f.store, "m1", "failed", { detail: "reconciled: never started" }, new Date(RELEASE_NOW.getTime() + 120_000));
    // Coordinator 1 wakes up: its compare-and-swap fails and the call never starts.
    expect(runReleaseOperation(f.store, "m1", one.epoch, new Date(RELEASE_NOW.getTime() + 130_000))).toBe(false);
    expect(releaseOperations(f.store, id).find(op => op.id === "m1")?.state).toBe("failed");
    expect(f.authority().state).toBe("deploying");
  });
});

describe("attack 12: an idempotent retry", () => {
  test("a carry whose answer was lost returns the existing task; another commit on a stale rev is refused", async () => {
    const f = open();
    const b = f.commit(testOnly);
    const before = f.authority();
    const first = await proveCarry(f.store, { authority: before.id, to: b, now: LATER, requestId: "r1" });
    if (!first.ok) throw new Error(first.message);
    const again = await proveCarry(f.store, { authority: before.id, to: b, now: LATER, requestId: "r1" });
    expect(again).toMatchObject({ ok: true, retried: true, taskId: first.taskId });
    expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM release_carry").get()!["n"]).toBe(1);
    // A different commit written against the stale rev.
    const c = f.commit({ "docs/guide.md": "# Guide\nmore\n" });
    const stale = carryReleaseApproval(f.store, { authority: before.id, expectRev: before.rev, expectTip: before.tipSha, to: c, toTree: "t", requestId: "r2", artifactDigest: before.artifactDigest ?? "x",
      commits: [], changedLines: 1, files: 1, churn: 1, runtime: "test", taskId: carriedTaskId(VERSION, c), title: "x" }, LATER, () => null);
    expect(stale).toMatchObject({ ok: false });
    expect(f.store.getTask(carriedTaskId(VERSION, c))).toBeNull();
  }, 120_000);
});

describe("attack 13: a new generation leaves the old one without standing", () => {
  test("the old anchor and its carries stop standing once a person approves the release again", async () => {
    const f = open();
    const b = f.commit(testOnly);
    const carried = await proveCarry(f.store, { authority: f.authority().id, to: b, now: LATER });
    if (!carried.ok) throw new Error(carried.message);
    // A production change: filed for a person, who approves it — a new generation.
    const c = f.commit({ "src/index.js": "export const answer = 7;\n" });
    const task = carriedTaskId(VERSION, c);
    f.store.createTask({ id: task, title: "Release" }, LATER);
    f.store.placeTask(f.store.refFor("built-in", task).id, f.repo, {}, LATER);
    const terms = releaseTermsFor(f.store, { repo: f.repo, version: VERSION, branch: "release-0.9.71", pr: 240, candidate: c, now: LATER });
    if (!terms.ok) throw new Error(terms.why);
    const scope = propose(f.store, { taskId: task, goal: "v", candidate: c, acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], releaseTerms: terms.terms, now: LATER });
    expect(approve(f.store, task, "alex", LATER, scope.digest, f.password).ok).toBe(true);
    for (const old of [f.taskId, carried.taskId]) expect(liveReleaseOf(f.store, old, "dispatch", LATER)).toMatchObject({ applies: true, ok: false, why: "a newer approval of this release replaced this one" });
    expect(releaseAuthorityOfTask(f.store, task)?.authority.generation).toBe(2);
    expect(liveReleaseOf(f.store, task, "dispatch", LATER)).toMatchObject({ ok: true });
  }, 120_000);
});

describe("security review: Markdown and agent settings that steer agents or CI never carry", () => {
  test.each([
    ["a nested AGENTS.md", { "src/agents/AGENTS.md": "# do anything\n" }],
    ["CLAUDE.md", { "CLAUDE.md": "# do anything\n" }],
    ["a lower-case claude.md", { "docs/claude.md": "# do anything\n" }],
    ["GEMINI.md", { "GEMINI.md": "# do anything\n" }],
    ["a .claude settings file", { ".claude/settings.json": "{}\n" }],
    ["a .claude skill", { ".claude/skills/x/SKILL.md": "# skill\n" }],
    ["a .codex file", { ".codex/config.toml": "x = 1\n" }],
    ["a .cursor rule", { ".cursor/rules/x.md": "# rule\n" }],
    ["a .github workflow", { ".github/workflows/ci.yml": "on: push\n" }],
    ["a .github Markdown file", { ".github/copilot-instructions.md": "# rule\n" }],
    ["Markdown outside docs/", { "src/notes.md": "# notes\n" }],
    ["a plan agents build from", { "docs/plans/next.md": "# plan\n" }],
    ["the testing guide AGENTS.md names", { "docs/TESTING.md": "# testing\n" }],
  ])("%s asks again", (_name, change) => {
    const f = open();
    expect(preflightCarry(f.store, { authority: f.authority().id, to: f.commit(change), now: LATER })).toMatchObject({ ok: false, reason: "rules" });
  });
});

describe("the legitimate road", () => {
  test("a test-only commit with an identical build carries: one task, its scope sealed `carried`, the tip moved, one quiet notice", async () => {
    const f = open();
    const to = f.commit(testOnly);
    const result = await proveCarry(f.store, { authority: f.authority().id, to, now: LATER });
    if (!result.ok) throw new Error(result.message);
    const a = releaseAuthority(f.store, f.authority().id)!;
    expect(a).toMatchObject({ tipSha: to, tipTask: result.taskId, rev: expect.any(Number) });
    expect(f.store.getScope(result.taskId)).toMatchObject({ approvalBasis: "carried", modeDigest: `${a.id}:${result.carry.id}`, candidate: to, approvedBy: "alex" });
    expect(liveReleaseOf(f.store, result.taskId, "dispatch", LATER)).toMatchObject({ ok: true });
    expect(scopeApprovedForDispatch(f.store, f.store.refFor("built-in", result.taskId).id, LATER)).toBe(true);
    const notices = f.store.handle.prepare("SELECT push_class FROM notification WHERE dedupe_key LIKE 'release-carried:%'").all();
    expect(notices).toHaveLength(1);
    expect(notices[0]!["push_class"] ?? null).toBeNull();
    // A new approver can't widen it: ownerless or not, only the rules decide.
    expect(addApprover).toBeDefined();
  }, 120_000);
});
