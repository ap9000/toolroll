/**
 * Attack: make a release approve itself when it shouldn't (docs/plans/auto-approve-green.md, the attack list). Guard:
 * release-auto.ts (the plane's two automatic seals, each proven again in one write transaction from its own records,
 * its own CI observation and verified Git objects), the seal primitive (store.ts sealScopeApproval), the dispatch belts
 * (approval-authority.ts), the release reader (scope.ts liveReleaseOf / releaseApprovalOf), the deploy gates and the
 * manual merge road. Each attack fails; the legitimate road beside it works, on a real plane database and repository.
 */
import { afterEach, describe, expect, test } from "vitest";
import { releaseFixture, builtRun, sealedCheck, reportOf, RELEASE_NOW, EVIDENCE, type ReleaseFixture } from "../release-fixture.js";
import { authorizeAutoCheck, ciProblem, sealAutoGreen, setReleaseApproval, type CiObservation } from "../../src/release-auto.js";
import { releaseAutoApproves } from "../../src/release-authority.js";
import { approve, liveReleaseOf, personApprovalOf, propose, releaseApprovalOf } from "../../src/scope.js";
import { releaseAuthorityOfTask } from "../../src/store.js";
import { scopeApprovedForDispatch } from "../../src/dispatch.js";
import { deploymentGate } from "../../src/deploy-gate.js";
import { mergePullRequest } from "../../src/pull-request-flow.js";
import { assignmentOf } from "../../src/assignment.js";
import { runReleaseCommand } from "../../src/release-cli.js";
import { REQUIRED_PR_CHECKS } from "../../src/release.js";
// @ts-expect-error plain ESM script without declarations
import { deploymentCandidate } from "../../scripts/deploy-candidate.mjs";
import * as installedScope from "../../src/scope.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const LATER = new Date(RELEASE_NOW.getTime() + 60_000);
const UNITS = ["src/index.test.ts", "src/browser/app.test.ts"];
const passingReport = () => reportOf(UNITS.map(file => ({ file })));

/** An unapproved release task in a project whose releases approve themselves (alex turned it on). */
function open(options: Parameters<typeof releaseFixture>[0] = {}) {
  const f = (fixture = releaseFixture({ approve: false, ...options }));
  setReleaseApproval(f.store, f.repo, true, "alex", RELEASE_NOW);
  return f;
}
const digestOf = (f: ReleaseFixture) => f.store.getScope(f.taskId)!.digest;
const ref = (f: ReleaseFixture) => f.store.refFor("built-in", f.taskId).id;
const green = (head: string, at = LATER): CiObservation => ({ head, observedAt: at.toISOString(),
  runs: REQUIRED_PR_CHECKS.map((name, i) => ({ id: 1000 + i, name, status: "completed", conclusion: "success", app: "github-actions" })) });
const authorize = (f: ReleaseFixture) => authorizeAutoCheck(f.store, { taskId: f.taskId, digest: digestOf(f), candidate: f.approved, now: LATER });
/** The release check of the candidate, sealed as the builder seals it, on the build's real base. */
const check = (f: ReleaseFixture, head = f.approved, report = passingReport) => sealedCheck(f, f.taskId, head, () => report(), { base: f.base }).runId;
const receiptOf = (f: ReleaseFixture) => assignmentOf(f.store, f.taskId, LATER, { principal: "operator", repos: null, includeUnplaced: true }, EVIDENCE(f))!.receipt!.digest;
const seal = (f: ReleaseFixture, run: number, ci: CiObservation = green(f.approved), extra: { digest?: string; receipt?: string } = {}) =>
  sealAutoGreen(f.store, { taskId: f.taskId, digest: extra.digest ?? digestOf(f), candidate: f.approved, run, receipt: extra.receipt ?? receiptOf(f), ci, evidenceRoot: EVIDENCE(f), now: LATER });
const basis = (f: ReleaseFixture) => f.store.getScope(f.taskId)!.approvalBasis ?? null;

describe("the legitimate road", () => {
  test("auto-check lets the check run; after it passed and CI is green on the exact commit, auto-green is the release approval", () => {
    const f = open();
    expect(authorize(f)).toEqual({ ok: true, already: false });
    expect(basis(f)).toBe("auto-check");
    expect(scopeApprovedForDispatch(f.store, ref(f), LATER)).toBe(true);
    // Checking is no approval of the release: no authority, never a person's.
    expect(releaseAuthorityOfTask(f.store, f.taskId)).toBeNull();
    expect(personApprovalOf(f.store, f.taskId)).toMatchObject({ ok: false });
    const run = check(f);
    const sealed = seal(f, run);
    expect(sealed.ok ? "" : sealed.why).toBe("");
    expect(sealed).toMatchObject({ ok: true, by: "alex", ci: REQUIRED_PR_CHECKS.map((name, i) => ({ id: 1000 + i, name })) });
    expect(basis(f)).toBe("auto-green");
    expect(releaseApprovalOf(f.store, f.taskId, LATER)).toMatchObject({ ok: true, by: "alex", method: "auto-green" });
    expect(personApprovalOf(f.store, f.taskId)).toMatchObject({ ok: false, why: "approved automatically, not by a person" });
    expect(liveReleaseOf(f.store, f.taskId, "complete", LATER)).toMatchObject({ applies: true, ok: true });
    // The evidence says exactly what proved it.
    const evidence = f.store.handle.prepare("SELECT detail FROM action_ledger WHERE task_id = ? AND action = 'release auto-approved' AND outcome = 'auto-green'").get(f.taskId);
    expect(JSON.parse(String(evidence!["detail"]))).toMatchObject({ v: 1, by: "alex", candidate: f.approved, digest: digestOf(f), run, ci: expect.any(Array), observedAt: LATER.toISOString() });
    // The owner is told, not asked.
    const told = f.store.handle.prepare("SELECT subject FROM notification WHERE kind = 'release-auto'").all().map(row => String(row["subject"]));
    expect(told).toEqual(["Release 0.9.71 approved automatically"]);
  });
});

describe("attack 1: a lead token, a remembered login or a machine turns the setting on", () => {
  const cli = async (f: ReleaseFixture, args: string[], env: Record<string, string> = {}) => {
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    const lines: string[] = [];
    try { return { code: await runReleaseCommand(["auto-approve", ...args, "--repo", f.repo, "--json"], line => lines.push(line), { database: f.databaseFile, now: () => LATER }), lines }; }
    finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  };
  test.each([
    ["the lead's token in the environment", (f: ReleaseFixture) => ["--as", "alex", "--token", f.password], { TOOLROLL_LEAD_TOKEN: "lt_lead_synthetic" }],
    ["a remote API token in the environment", (f: ReleaseFixture) => ["--as", "alex", "--token", f.password], { TOOLROLL_REMOTE_TOKEN: "rt_synthetic" }],
    ["no password", () => ["--as", "alex"], {}],
    ["an empty password", () => ["--as", "alex", "--token", ""], {}],
    ["a wrong password", () => ["--as", "alex", "--token", "not-it"], {}],
  ] as const)("%s: refused, and the setting stays off", async (_name, args, env) => {
    const f = (fixture = releaseFixture({ approve: false }));
    const result = await cli(f, ["on", ...args(f)], env);
    expect(result.code).not.toBe(0);
    expect(releaseAutoApproves(f.store, f.repo)).toBe(false);
  });

  test("the person's typed password turns it on; turning it off needs none and takes the automatic seals back", async () => {
    const f = (fixture = releaseFixture({ approve: false }));
    expect((await cli(f, ["on", "--as", "alex", "--token", f.password])).code).toBe(0);
    expect(releaseAutoApproves(f.store, f.repo)).toBe(true);
    expect(authorize(f)).toMatchObject({ ok: true });
    expect((await cli(f, ["off"])).code).toBe(0);
    expect(releaseAutoApproves(f.store, f.repo)).toBe(false);
    expect(basis(f)).toBeNull();
  });

  test("an unreadable or unknown setting is Ask me", () => {
    const f = (fixture = releaseFixture({ approve: false }));
    f.store.recordAction({ at: LATER.toISOString(), actor: "alex", repo: f.repo, taskId: null, runId: null, action: "release approval changed", outcome: "yes-please", source: "policy" });
    expect(releaseAutoApproves(f.store, f.repo)).toBe(false);
    expect(authorize(f)).toMatchObject({ ok: false });
  });
});

describe("attack 2: a forged or stale CI observation", () => {
  const spoiled: [string, (ci: CiObservation, f: ReleaseFixture) => CiObservation][] = [
    ["another commit's checks", (ci) => ({ ...ci, head: "e".repeat(40) })],
    ["a required check missing", (ci) => ({ ...ci, runs: ci.runs.slice(1) })],
    ["a check named alike by another app", (ci) => ({ ...ci, runs: ci.runs.map((run, i) => i === 0 ? { ...run, app: "some-other-app" } : run) })],
    ["a commit status posing as a check (no app)", (ci) => ({ ...ci, runs: ci.runs.map((run, i) => i === 0 ? { ...run, app: null } : run) })],
    ["a pending check", (ci) => ({ ...ci, runs: ci.runs.map((run, i) => i === 0 ? { ...run, status: "in_progress", conclusion: null } : run) })],
    ["a skipped check", (ci) => ({ ...ci, runs: ci.runs.map((run, i) => i === 0 ? { ...run, conclusion: "skipped" } : run) })],
    ["a check that failed three times before passing", (ci) => ({ ...ci, runs: [1, 2, 3].map(id => ({ ...ci.runs[0]!, id, conclusion: "failure" })).concat(ci.runs) })],
    ["a re-run that is still running after a pass", (ci) => ({ ...ci, runs: [...ci.runs, { ...ci.runs[0]!, id: 5000, status: "in_progress", conclusion: null }] })],
    ["a re-run that failed after a pass", (ci) => ({ ...ci, runs: [...ci.runs, { ...ci.runs[0]!, id: 5000, conclusion: "failure" }] })],
    ["an earlier attempt by another app", (ci) => ({ ...ci, runs: [{ ...ci.runs[0]!, id: 1, conclusion: "failure", app: "some-other-app" }, ...ci.runs] })],
    ["an extra failing check", (ci) => ({ ...ci, runs: [...ci.runs, { id: 2000, name: "lint", status: "completed", conclusion: "failure", app: "github-actions" }] })],
    ["a check run with no id", (ci) => ({ ...ci, runs: ci.runs.map((run, i) => i === 0 ? { ...run, id: null } : run) })],
    ["an observation an hour old", (ci) => ({ ...ci, observedAt: new Date(LATER.getTime() - 60 * 60_000).toISOString() })],
    ["an observation from the future", (ci) => ({ ...ci, observedAt: new Date(LATER.getTime() + 60 * 60_000).toISOString() })],
  ];
  test.each(spoiled)("%s: refused, nothing is approved, and the task asks a person", (_name, spoil) => {
    const f = open();
    authorize(f);
    const run = check(f);
    const result = seal(f, run, spoil(green(f.approved), f));
    expect(result).toMatchObject({ ok: false, why: expect.stringMatching(/^CI: /) });
    expect(basis(f)).toBeNull();
    expect(releaseAuthorityOfTask(f.store, f.taskId)).toBeNull();
    expect(f.store.handle.prepare("SELECT subject FROM notification WHERE kind = 'release-auto'").all().map(row => String(row["subject"]))).toEqual(["Release 0.9.71 needs you"]);
  });

  test.each([1, 2])("a flaky CI check (%i failed attempt(s), latest a GitHub Actions success) approves, and the failures are recorded", failed => {
    const f = open();
    authorize(f);
    const run = check(f);
    const ci = green(f.approved);
    const flakes = Array.from({ length: failed }, (_, i) => ({ ...ci.runs[1]!, id: 10 + i, conclusion: "failure" }));
    expect(seal(f, run, { ...ci, runs: [...flakes, ...ci.runs] })).toMatchObject({ ok: true });
    const evidence = f.store.handle.prepare("SELECT detail FROM action_ledger WHERE task_id = ? AND action = 'release auto-approved' AND outcome = 'auto-green'").get(f.taskId);
    expect(JSON.parse(String(evidence!["detail"]))).toMatchObject({ ciFailures: flakes.map(one => ({ id: one.id, name: one.name, conclusion: "failure" })), checkFailures: [] });
  });

  test("the rule itself: only a fresh, complete, latest-attempt-success GitHub Actions reading of the exact head passes", () => {
    expect(ciProblem(green("a".repeat(40)), "a".repeat(40), LATER)).toBeNull();
    for (const [name, spoil] of spoiled) expect(ciProblem(spoil(green("a".repeat(40)), null as never), "a".repeat(40), LATER), name).not.toBeNull();
  });
});

describe("attack 3: a check that isn't of this commit, this scope, or the first one", () => {
  test("a build of another commit (different files) is refused", () => {
    const f = open();
    authorize(f);
    const other = f.commit({ "src/index.js": "export const answer = 41;\n" }, "other");
    const run = check(f, other);
    expect(seal(f, run)).toMatchObject({ ok: false, why: expect.stringContaining("doesn't hold exactly") });
    expect(basis(f)).toBeNull();
  });

  test("another task's run is refused", () => {
    const f = open();
    authorize(f);
    check(f);
    f.store.createTask({ id: "elsewhere", title: "Other" }, LATER);
    f.store.placeTask(f.store.refFor("built-in", "elsewhere").id, f.repo, {}, LATER);
    const filed = propose(f.store, { taskId: "elsewhere", goal: "Other", acceptance: [{ id: "c1", statement: "x", how: null, evidence: ["check"] }], now: LATER });
    expect(approve(f.store, "elsewhere", "alex", LATER, filed.digest, f.password)).toMatchObject({ ok: true });
    const stranger = builtRun(f.store, "elsewhere", f.approved, f.base);
    expect(seal(f, stranger)).toMatchObject({ ok: false, why: expect.stringContaining("isn't a finished build of this release task") });
  });

  const red = () => reportOf(UNITS.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : { file }));
  test.each([1, 2])("a flaky release check (%i failed run(s), then a pass on the same commit and digest) approves, and the failures are recorded", failed => {
    const f = open();
    authorize(f);
    const failedRuns = Array.from({ length: failed }, () => check(f, f.approved, red));
    const rerun = check(f);
    expect(seal(f, rerun)).toMatchObject({ ok: true });
    const evidence = f.store.handle.prepare("SELECT detail FROM action_ledger WHERE task_id = ? AND action = 'release auto-approved' AND outcome = 'auto-green'").get(f.taskId);
    expect(JSON.parse(String(evidence!["detail"]))).toMatchObject({ checkFailures: failedRuns, ciFailures: [] });
  });

  test("the cap: three failed release-check runs before the pass need a person", () => {
    const f = open();
    authorize(f);
    for (let n = 0; n < 3; n++) check(f, f.approved, red);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("failed 3 times before it passed") });
    expect(basis(f)).toBeNull();
  });

  test("an earlier failed check on different scope text needs a person", () => {
    const f = open();
    authorize(f);
    const failedRun = check(f, f.approved, red);
    f.store.handle.prepare("UPDATE run SET scope_digest = 'other' WHERE id = ?").run(failedRun);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("different scope text") });
  });

  test("a failing check is refused", () => {
    const f = open();
    authorize(f);
    const run = check(f, f.approved, () => reportOf(UNITS.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : { file })));
    expect(seal(f, run)).toMatchObject({ ok: false });
    expect(basis(f)).toBeNull();
  });

  test("a receipt that isn't this build's is refused", () => {
    const f = open();
    authorize(f);
    const run = check(f);
    expect(seal(f, run, green(f.approved), { receipt: "0".repeat(64) })).toMatchObject({ ok: false, why: expect.stringContaining("isn't this build's") });
  });
});

describe("attack 4: the scope changes after the check", () => {
  test("a re-proposed scope (new digest) is refused, and its old auto-check stands at dispatch for nothing", () => {
    const f = open();
    authorize(f);
    const run = check(f);
    const before = digestOf(f);
    const terms = f.store.getScope(f.taskId)!.releaseTerms!;
    propose(f.store, { taskId: f.taskId, goal: "Something else entirely", candidate: f.approved, acceptance: [{ id: "c1", statement: "The release check passes", how: null, evidence: ["check"] }], releaseTerms: terms, now: LATER });
    expect(digestOf(f)).not.toBe(before);
    expect(scopeApprovedForDispatch(f.store, ref(f), LATER)).toBe(false);
    expect(seal(f, run, green(f.approved), { digest: before })).toMatchObject({ ok: false, why: "the release scope changed after it was filed" });
    expect(seal(f, run)).toMatchObject({ ok: false });
    expect(basis(f)).not.toBe("auto-green");
  });
});

describe("attack 5: the setting is lowered mid-flight", () => {
  test("while checking: the auto-check no longer dispatches, and nothing approves", () => {
    const f = open();
    authorize(f);
    const run = check(f);
    setReleaseApproval(f.store, f.repo, false, "alex", LATER);
    expect(scopeApprovedForDispatch(f.store, ref(f), LATER)).toBe(false);
    expect(seal(f, run)).toMatchObject({ ok: false, why: "this project's releases aren't approved automatically" });
    expect(basis(f)).toBeNull();
  });

  test("a stale auto-check left behind (no unseal) still stands on nothing once the setting is off", () => {
    const f = open();
    authorize(f);
    // A ledger row written past the setter, as if the unseal never ran.
    f.store.recordAction({ at: LATER.toISOString(), actor: "alex", repo: f.repo, taskId: null, runId: null, action: "release approval changed", outcome: "ask", source: "policy" });
    expect(basis(f)).toBe("auto-check");
    expect(scopeApprovedForDispatch(f.store, ref(f), LATER)).toBe(false);
    expect(installedScope.autoReleaseApprovalOf(f.store, f.taskId, "auto-check")).toMatchObject({ ok: false });
  });

  test("after the automatic approval: the release stops standing, and neither deploy gate accepts it", () => {
    const f = open();
    authorize(f);
    const run = check(f);
    expect(seal(f, run)).toMatchObject({ ok: true });
    const authority = releaseAuthorityOfTask(f.store, f.taskId)!.authority;
    setReleaseApproval(f.store, f.repo, false, "alex", LATER);
    expect(liveReleaseOf(f.store, f.taskId, "deploy", LATER)).toMatchObject({ applies: true, ok: false });
    expect(releaseAuthorityOfTask(f.store, f.taskId)!.authority).toMatchObject({ id: authority.id, state: "revoked" });
    expect(deploymentGate(f.store, { runId: run, evidenceRoot: EVIDENCE(f), now: LATER, releaseFlow: true })).toMatchObject({ ok: false });
    // And a fresh automatic road for this release now asks a person.
    setReleaseApproval(f.store, f.repo, true, "alex", LATER);
    expect(authorize(f)).toMatchObject({ ok: false, why: expect.stringContaining("was stopped before") });
  });
});

describe("attack 6: auto-green outside the release flow", () => {
  test("never sealed on an ordinary task, directly through the seal primitive", () => {
    const f = open();
    f.store.createTask({ id: "everyday", title: "Everyday" }, LATER);
    f.store.placeTask(f.store.refFor("built-in", "everyday").id, f.repo, {}, LATER);
    propose(f.store, { taskId: "everyday", goal: "Everyday work", acceptance: [{ id: "c1", statement: "x", how: null, evidence: ["check"] }], now: LATER });
    for (const kind of ["auto-check", "auto-green"] as const) expect(f.store.sealScopeApproval("everyday", "alex", LATER, {}, { kind, modeDigest: "auto:1" }, "automation"), kind).toBe(false);
    // Nor on the release task without its own evidence row.
    expect(f.store.sealScopeApproval(f.taskId, "alex", LATER, {}, { kind: "auto-green", modeDigest: "auto:1" }, "automation")).toBe(false);
  });

  test("a hand-written auto-green row stands nowhere and never merges by hand", async () => {
    const f = open();
    f.store.createTask({ id: "everyday", title: "Everyday" }, LATER);
    const everyday = f.store.refFor("built-in", "everyday").id;
    f.store.placeTask(everyday, f.repo, {}, LATER);
    const filed = propose(f.store, { taskId: "everyday", goal: "Everyday work", acceptance: [{ id: "c1", statement: "x", how: null, evidence: ["check"] }], now: LATER });
    expect(approve(f.store, "everyday", "alex", LATER, filed.digest, f.password)).toMatchObject({ ok: true });
    const run = builtRun(f.store, "everyday", f.approved, f.base);
    // The person's seal swapped, by hand, for an automatic one with no evidence behind it.
    f.store.handle.prepare("UPDATE task_scope SET approved_at = ?, approved_by = 'alex', approved_digest = digest, approval_basis = 'auto-green', mode_digest = 'auto:1' WHERE task_id = 'everyday'").run(LATER.toISOString());
    expect(scopeApprovedForDispatch(f.store, everyday, LATER)).toBe(false);
    expect(personApprovalOf(f.store, "everyday")).toMatchObject({ ok: false });
    expect(releaseApprovalOf(f.store, "everyday", LATER)).toMatchObject({ ok: false });
    expect(await mergePullRequest(f.store, { runId: run, by: "alex" })).toMatchObject({ ok: false, reason: "release" });
  });

  test("an automatically checked release task never merges by hand", async () => {
    const f = open();
    authorize(f);
    const run = check(f);
    expect(await mergePullRequest(f.store, { runId: run, by: "alex" })).toMatchObject({ ok: false, reason: "release" });
  });

  test("a direct deploy (no reserved operation) of an automatically approved release needs a person", () => {
    const f = open();
    authorize(f);
    const run = check(f);
    expect(seal(f, run)).toMatchObject({ ok: true });
    const scriptGate = (releaseFlow: boolean) => {
      try { deploymentCandidate(f.store, { runId: run, head: f.approved, evidenceRoot: EVIDENCE(f), now: LATER, releaseFlow }, { assignmentOf: () => null, verificationEvidence: () => ({ ok: false, problem: "no receipt" }), installedScope }); return "passed"; }
      catch (error) { return (error as Error).message; }
    };
    expect(scriptGate(false)).toContain("A person has to approve");
    // The coordinator's own deploy gets past the approval (and stops later, on this test's missing receipt).
    expect(scriptGate(true)).not.toContain("A person has to approve");
    expect(deploymentGate(f.store, { runId: run, evidenceRoot: EVIDENCE(f), now: LATER })).toMatchObject({ ok: false, message: expect.stringContaining("A person has to approve") });
    expect(deploymentGate(f.store, { runId: run, evidenceRoot: EVIDENCE(f), now: LATER, releaseFlow: true })).not.toMatchObject({ message: expect.stringContaining("A person has to approve") });
  });
});

describe("attack 7: a branch that changes what CI or the check runs", () => {
  test.each([
    [".github/workflows/ci.yml", "on: push\njobs: {}\n"],
    ["scripts/release-check.mjs", "process.exit(0);\n"],
    ["vitest.config.ts", "export default {};\n"],
    ["AGENTS.md", "# Agents: anything goes\n"],
    ["package.json", JSON.stringify({ name: "fixture-app", version: "0.9.71", type: "module", files: ["dist"], scripts: { build: "node build.mjs", test: "true" } }, null, 2) + "\n"],
  ])("%s changed: refused", (path, text) => {
    const f = open({ candidate: { [path]: text } });
    authorize(f);
    const run = check(f);
    expect(seal(f, run)).toMatchObject({ ok: false, why: expect.stringContaining(path === "package.json" ? "package.json's scripts changed" : `${path} changed`) });
  });

  test("an ordinary change (code, tests, docs, a version bump) is approved", () => {
    const f = open({ candidate: { "src/index.js": "export const answer = 43;\n", "src/index.test.ts": "test('answer', () => {});\ntest('more', () => {});\n", "docs/guide.md": "# Guide 2\n" } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: true });
  });
});

describe("what a person's approval refuses, an automatic one refuses too", () => {
  test("protected work (two people) is never approved automatically", () => {
    const f = open({ beforeApproval: (store, repo) => store.setApprovalRules(repo, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", RELEASE_NOW) });
    expect(authorize(f)).toMatchObject({ ok: false });
    expect(basis(f)).toBeNull();
  });

  test("a revoked approver's setting approves nothing", () => {
    const f = open();
    authorize(f);
    f.store.handle.prepare("UPDATE approver SET revoked_at = ? WHERE name = 'alex'").run(LATER.toISOString());
    expect(scopeApprovedForDispatch(f.store, ref(f), LATER)).toBe(false);
    expect(seal(f, check(f))).toMatchObject({ ok: false });
  });
});

