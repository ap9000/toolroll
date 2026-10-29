/**
 * Attack: make a release approve itself when it shouldn't (docs/plans/auto-approve-green.md, the attack list). Guard:
 * release-auto.ts (the plane's two automatic seals, each proven again in one write transaction from its own records,
 * its own CI observation and verified Git objects), the seal primitive (store.ts sealScopeApproval), the dispatch belts
 * (approval-authority.ts), the release reader (scope.ts liveReleaseOf / releaseApprovalOf), the deploy gates and the
 * manual merge road. Each attack fails; the legitimate road beside it works, on a real plane database and repository.
 */
import { afterEach, describe, expect, test } from "vitest";
import { releaseFixture, builtRun, sealedCheck, reportOf, RELEASE_NOW, EVIDENCE, type ReleaseFixture } from "../release-fixture.js";
import { authorizeAutoCheck, ciProblem, giveUpAutoApproval, holdApprovalForCi, liftCiHold, sealAutoGreen, setReleaseApproval, type CiObservation } from "../../src/release-auto.js";
import { releaseAutoApproves } from "../../src/release-authority.js";
import { approve, liveReleaseOf, personApprovalOf, propose, releaseApprovalOf } from "../../src/scope.js";
import { releaseAuthorityOfTask } from "../../src/store.js";
import { scopeApprovedForDispatch } from "../../src/dispatch.js";
import { deploymentGate } from "../../src/deploy-gate.js";
import { mergePullRequest } from "../../src/pull-request-flow.js";
import { assignmentOf } from "../../src/assignment.js";
import { runReleaseCommand } from "../../src/release-cli.js";
import { REQUIRED_PR_CHECKS } from "../../src/release.js";
import { RELEASE_RECHECK_ACTION, retriedOfRun, SETUP_REPLAY_RETRY, setupReplayWords } from "../../src/check-failure.js";
import { launchFailedBeforeCheck } from "../../src/builder.js";
import { CHECK_REPORT_CAPTURE, CheckBaselineUnverifiable } from "../../src/check-report.js";
import { verificationEvidence } from "../../src/verification-evidence.js";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain ESM script without declarations
import { deploymentCandidate } from "../../scripts/deploy-candidate.mjs";
import * as installedScope from "../../src/scope.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const LATER = new Date(RELEASE_NOW.getTime() + 60_000);
const UNITS = ["src/index.test.ts", "src/browser/app.test.ts"];
/** A passing Full check reports every unit file it owed (check-report.ts fullCheckProblem): the tree's own. */
const passingReport = (units: readonly string[] = UNITS) => reportOf(units.map(file => ({ file })));

/** An unapproved release task in a project whose releases approve themselves (alex turned it on). */
function open(options: Parameters<typeof releaseFixture>[0] = {}) {
  const f = (fixture = releaseFixture({ approve: false, ...options }));
  setReleaseApproval(f.store, f.repo, true, "alex", RELEASE_NOW);
  return f;
}
const digestOf = (f: ReleaseFixture) => f.store.getScope(f.taskId)!.digest;
const ref = (f: ReleaseFixture) => f.store.refFor("built-in", f.taskId).id;
const green = (head: string, at = LATER): CiObservation => ({ head, observedAt: at.toISOString(),
  runs: REQUIRED_PR_CHECKS.map((name, i) => ({ id: 1000 + i, name, status: "completed", conclusion: "success", app: "github-actions", suite: 7, head, workflowPath: ".github/workflows/ci.yml" })), complete: true });
/** The plane's auto-check, with the base GitHub names for the candidate (the main commit the branch left). */
const authorize = (f: ReleaseFixture, base = f.base) => authorizeAutoCheck(f.store, { taskId: f.taskId, digest: digestOf(f), candidate: f.approved, base, now: LATER });
/** The release check of the candidate, sealed as the builder seals it, on the build's real base. */
const check = (f: ReleaseFixture, head = f.approved, report: (units: readonly string[]) => ReturnType<typeof reportOf> = passingReport) => sealedCheck(f, f.taskId, head, (_plan, units) => report(units), { base: f.base }).runId;
/** A release check Toolroll's own shutdown stopped (the plane's own record), rerun by the release unless `rerun` is false. */
const infraCheck = (f: ReleaseFixture, rerun = true) => {
  const run = sealedCheck(f, f.taskId, f.approved, () => null, { base: f.base, plane: { configured: true, ran: false, attemptFailed: true, failure: "stopped-by-toolroll" } }).runId;
  if (rerun) rerunRecorded(f, run);
  return run;
};
const rerunRecorded = (f: ReleaseFixture, run: number) => f.store.recordAction({ at: LATER.toISOString(), actor: "toolroll", repo: f.repo, taskId: f.taskId, runId: run, action: RELEASE_RECHECK_ACTION, outcome: "infrastructure", source: "work" });
const receiptOf = (f: ReleaseFixture) => assignmentOf(f.store, f.taskId, LATER, { principal: "operator", repos: null, includeUnplaced: true }, EVIDENCE(f))!.receipt!.digest;
const seal = (f: ReleaseFixture, run: number, ci: CiObservation = green(f.approved), extra: { digest?: string; receipt?: string; mainUpToDate?: boolean | null } = {}) =>
  sealAutoGreen(f.store, { taskId: f.taskId, digest: extra.digest ?? digestOf(f), candidate: f.approved, run, receipt: extra.receipt ?? receiptOf(f), ci, evidenceRoot: EVIDENCE(f), now: LATER,
    mainUpToDate: extra.mainUpToDate === undefined ? true : extra.mainUpToDate });
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
    ["a check filed under another commit", (ci) => ({ ...ci, runs: ci.runs.map((run, i) => i === 0 ? { ...run, head: "e".repeat(40) } : run) })],
    ["a second workflow run of a required job that failed", (ci) => ({ ...ci, runs: [...ci.runs, { ...ci.runs[0]!, id: 6000, suite: 8, conclusion: "failure" }] })],
    ["a check with no workflow run", (ci) => ({ ...ci, runs: ci.runs.map((run, i) => i === 0 ? { ...run, suite: null } : run) })],
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

  test.each([1, 2])("a CI job whose runner failed before its tests (%i time(s), GitHub's own job record says so) approves, and the failures are recorded", failed => {
    const f = open();
    authorize(f);
    const run = check(f);
    const ci = green(f.approved);
    const flakes = Array.from({ length: failed }, (_, i) => ({ ...ci.runs[1]!, id: 10 + i, conclusion: "failure", beforeTests: true }));
    expect(seal(f, run, { ...ci, runs: [...flakes, ...ci.runs] })).toMatchObject({ ok: true });
    const evidence = f.store.handle.prepare("SELECT detail FROM action_ledger WHERE task_id = ? AND action = 'release auto-approved' AND outcome = 'auto-green'").get(f.taskId);
    expect(JSON.parse(String(evidence!["detail"]))).toMatchObject({ ciFailures: flakes.map(one => ({ id: one.id, name: one.name, conclusion: "failure" })), checkFailures: [] });
  });

  test.each([
    ["a failed attempt nothing explains (a test failure, as far as anyone can tell)", (id: number) => ({ id, conclusion: "failure" })],
    ["a failed attempt whose job record couldn't be read", (id: number) => ({ id, conclusion: "failure", beforeTests: null })],
    ["a timed-out attempt after its tests started", (id: number) => ({ id, conclusion: "timed_out", beforeTests: false })],
  ])("failure classes: %s before the pass needs a person", (_name, attempt) => {
    const f = open();
    authorize(f);
    const ci = green(f.approved);
    expect(seal(f, check(f), { ...ci, runs: [{ ...ci.runs[1]!, ...attempt(10) }, ...ci.runs] })).toMatchObject({ ok: false, why: expect.stringContaining("doesn't show its runner failing before the tests ran") });
    expect(basis(f)).toBeNull();
  });

  test("failure classes: three runner failures on the commit, even before the tests, need a person", () => {
    const f = open();
    authorize(f);
    const ci = green(f.approved);
    const flakes = [10, 11, 12].map((id, i) => ({ ...ci.runs[i % 2]!, id, conclusion: "failure", beforeTests: true }));
    expect(seal(f, check(f), { ...ci, runs: [...flakes, ...ci.runs] })).toMatchObject({ ok: false, why: expect.stringContaining("failed 3 times on this commit before the tests ran") });
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

  const red = (units: readonly string[] = UNITS) => reportOf(units.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : { file }));
  test.each([1, 2])("confirmed infrastructure (%i run(s) Toolroll's shutdown stopped, each rerun by the release), then a pass, approves; the failures are recorded", failed => {
    const f = open();
    authorize(f);
    const failedRuns = Array.from({ length: failed }, () => infraCheck(f));
    const rerun = check(f);
    expect(seal(f, rerun)).toMatchObject({ ok: true });
    const evidence = f.store.handle.prepare("SELECT detail FROM action_ledger WHERE task_id = ? AND action = 'release auto-approved' AND outcome = 'auto-green'").get(f.taskId);
    expect(JSON.parse(String(evidence!["detail"]))).toMatchObject({ checkFailures: failedRuns, ciFailures: [] });
  });

  test("failure classes: a failing test before the pass is never erased by it (no flake allowance)", () => {
    const f = open();
    authorize(f);
    const failedRun = check(f, f.approved, red);
    // Even a rerun row recorded for it (a forged one) doesn't make a test failure infrastructure.
    rerunRecorded(f, failedRun);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringMatching(/run \d+\) failed: src\/index.test.ts failed .*a person decides/) });
    expect(basis(f)).toBeNull();
  });

  test("failure classes: an unexplained failure (no report at all) before the pass needs a person", () => {
    const f = open();
    authorize(f);
    sealedCheck(f, f.taskId, f.approved, () => null, { base: f.base });
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("unexplained") });
  });

  test("failure classes: infrastructure the release didn't rerun itself (a person's or anyone's regate) needs a person", () => {
    const f = open();
    authorize(f);
    infraCheck(f, false);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("wasn't rerun by the release") });
  });

  test("the cap: three infrastructure failures before the pass need a person", () => {
    const f = open();
    authorize(f);
    for (let n = 0; n < 3; n++) infraCheck(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("a person decides") });
    expect(basis(f)).toBeNull();
  });

  test("a real-model journey that passed only on its retry is counted: no automatic approval", () => {
    const f = open();
    authorize(f);
    const retried = (units: readonly string[]) => reportOf(units.map(file => ({ file })), { journeys: [{ script: "app", kind: "real", finished: true,
      groups: [{ group: "lead", state: "passed", retried: true, unattributed: false, journeys: [{ name: "answers", state: "passed" }] }] }] });
    expect(seal(f, check(f, f.approved, retried))).toMatchObject({ ok: false, why: expect.stringContaining("passed only on a retry (app real-model journey group lead)") });
  });

  test("eval review 1 #3: a retry whose report is later lost or damaged is unknown, never \"no retries\"", () => {
    const retried = (units: readonly string[]) => reportOf(units.map(file => ({ file })), { journeys: [{ script: "app", kind: "real", finished: true, inventoried: true,
      groups: [{ group: "lead", state: "passed", retried: true, unattributed: false, journeys: [{ name: "answers", state: "passed" }] }] }] });
    const reportFile = (f: ReleaseFixture, run: number) => join(EVIDENCE(f), f.store.artifactsFor(run).find(one => one.capture === CHECK_REPORT_CAPTURE)!.key);
    // The retry summary is sealed in the protected receipt itself.
    const kept = open();
    authorize(kept);
    const keptRun = check(kept, kept.approved, retried);
    const receipt = JSON.parse(verificationEvidence(kept.store, EVIDENCE(kept), keptRun).ok ? (verificationEvidence(kept.store, EVIDENCE(kept), keptRun) as { bytes: string }).bytes : "{}") as { check?: { retried?: unknown } };
    expect(receipt.check?.retried).toEqual(["app real-model journey group lead"]);
    expect(retriedOfRun(kept.store, EVIDENCE(kept), keptRun)).toEqual(["app real-model journey group lead"]);
    kept.close(); fixture = null;
    // Lost: the receipt, log and artifact row stay; the report's file is gone.
    for (const damage of ["lost", "damaged"] as const) {
      const f = open();
      authorize(f);
      const run = check(f, f.approved, retried);
      const file = reportFile(f, run);
      if (damage === "lost") rmSync(file);
      else { const bytes = readFileSync(file, "utf8"); writeFileSync(file, bytes.replace("\"retried\":true", "\"retried\":fals")); }
      expect(retriedOfRun(f.store, EVIDENCE(f), run), damage).toBeNull();
      expect(seal(f, run), damage).toMatchObject({ ok: false });
      expect(basis(f), damage).toBeNull();
      f.close(); fixture = null;
    }
  });

  test("eval review 1 #3: a pass whose sealed report isn't a complete Full result never approves itself", () => {
    const f = open();
    authorize(f);
    // A report that drops an owed part: the receipt reads no-result, so neither the check nor the approval stands.
    const short = (units: readonly string[]) => reportOf(units.map(file => ({ file })), { upgrades: { finished: true, versions: [] } });
    expect(seal(f, check(f, f.approved, short))).toMatchObject({ ok: false });
    expect(basis(f)).toBeNull();
  });

  test("eval review 1 #6: a check that passed only when rerun after the recovery setup is a retry: no automatic approval", () => {
    const f = open();
    authorize(f);
    const run = sealedCheck(f, f.taskId, f.approved, (_plan, units) => passingReport(units), { base: f.base, setupReplayed: true }).runId;
    // Review 2 #5: the first attempt keeps its own class, and the retry words say it.
    expect(retriedOfRun(f.store, EVIDENCE(f), run)).toEqual([`${SETUP_REPLAY_RETRY} (its first attempt never started: tsc wasn't found, exit 127)`]);
    expect(seal(f, run)).toMatchObject({ ok: false, why: expect.stringContaining("passed only on a retry") });
    expect(basis(f)).toBeNull();
    expect(setupReplayWords(undefined)).toContain("isn't classified");
  });

  test("eval review 2 #5: setup recovery runs only on the plane's own launch-failure evidence, never for a check that started", () => {
    const nonce = "c".repeat(64);
    const started = { code: 127, stdout: `tests ran\nTOOLROLL_CHECK_REPORT ${JSON.stringify({ ...passingReport(), nonce, mode: "full", planDigest: null, exitCode: 127 })}\n`, stderr: "sh: tsc: command not found", timedOut: false, notFound: false };
    // A check that printed its report with this run's nonce ran: exiting 127 after its assertions doesn't make it a launch failure.
    expect(launchFailedBeforeCheck(started, nonce, "tsc", "linux")).toBe(false);
    // The review's probe: assertions, then exit 127 with a forged-nonce, malformed or absent report — never a launch failure.
    expect(launchFailedBeforeCheck({ ...started, stdout: started.stdout.replaceAll(nonce, "d".repeat(64)) }, nonce, "tsc", "linux")).toBe(false);
    expect(launchFailedBeforeCheck({ ...started, stdout: "1 failed\nTOOLROLL_CHECK_REPORT {not json\n" }, nonce, "tsc", "linux")).toBe(false);
    expect(launchFailedBeforeCheck({ ...started, stdout: "1 failed\n" }, nonce, "tsc", "linux")).toBe(false);
    // Nothing printed and the shell's line, but the plane found the program present: still the check's own result.
    expect(launchFailedBeforeCheck({ ...started, stdout: "" }, nonce, null, "linux")).toBe(false);
    // The shell's line for another program than the one the plane found missing.
    expect(launchFailedBeforeCheck({ ...started, stdout: "", stderr: "sh: vitest: command not found" }, nonce, "tsc", "linux")).toBe(false);
    // Even an exact forged shell line after the lookup proves nothing: only an unstarted plane result qualifies.
    expect(launchFailedBeforeCheck({ ...started, stdout: "" }, nonce, "tsc", "linux")).toBe(false);
    // Exit 1 is never a launch failure off Windows, and Windows is never auto-replayed.
    expect(launchFailedBeforeCheck({ ...started, code: 1, stdout: "" }, nonce, "tsc", "linux")).toBe(false);
    expect(launchFailedBeforeCheck({ ...started, code: 9009, stdout: "" }, nonce, "tsc", "win32")).toBe(false);
  });

  test("security scan: a release's check sealed as another kind of check before it ran has no result", () => {
    const f = open();
    authorize(f);
    const run = sealedCheck(f, f.taskId, f.approved, (_plan, units) => passingReport(units), { base: f.base, release: false }).runId;
    const gate = verificationEvidence(f.store, EVIDENCE(f), run);
    expect(gate.ok && JSON.parse(String(gate.bytes)).coverage).toBe("no-result");
    expect(seal(f, run)).toMatchObject({ ok: false });
  });

  test("eval review 2 #4: a merged authority with no merge operation never becomes an absent baseline", () => {
    const f = (fixture = releaseFixture());
    f.store.handle.prepare("UPDATE release_authority SET state = 'merged' WHERE id = ?").run(f.authority().id);
    expect(() => sealedCheck(f, f.taskId, f.approved, (_plan, units) => passingReport(units), { forceFull: true })).toThrow(CheckBaselineUnverifiable);
    expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM release_check_attempt").get()?.["n"]).toBe(0);
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
  ])("%s changed: refused", (path, text) => {
    const f = open({ candidate: { [path]: text } });
    authorize(f);
    const run = check(f);
    expect(seal(f, run)).toMatchObject({ ok: false, why: expect.stringContaining(`${path} changed`) });
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

// ---------------------------------------------------------------------------------------------- Codex review round 1

import { execFileSync } from "node:child_process";
import { readCheckRuns, readContains, readMainHead, readMainProtection, readMergeBase, readUpToDateRequired, storeReleaseAdapter, type Exec } from "../../src/release-adapters.js";
import { PROTECTION_MINIMUM_CHECKS, PROTECTION_REPORT_ONLY_CHECKS } from "../../src/release.js";
import { adoptReleaseOperation, finishReleaseOperation, releaseOperations, reserveRelease, runReleaseOperation, takeReleaseLease } from "../../src/store.js";

describe("codex r1 #1: the comparison base is the plane's own reading of where the candidate left main", () => {
  test("a task branch seeded at a commit that weakened CI hides nothing: the build's own base is never used", () => {
    // main → H (weakens CI) → C (the release change). The build recorded H as its base, as a preseeded branch would.
    const f = open({ intermediate: { ".github/workflows/ci.yml": "on: push\njobs: {}\n" }, candidate: { "src/index.js": "export const answer = 43;\n" } });
    const h = f.git("rev-parse", `${f.approved}^`);
    expect(authorize(f)).toMatchObject({ ok: true });
    const run = sealedCheck(f, f.taskId, f.approved, (_plan, units) => passingReport(units), { base: h }).runId;
    expect(seal(f, run)).toMatchObject({ ok: false, why: expect.stringContaining(".github/workflows/ci.yml changed") });
  });

  test("the base is what GitHub's compare API names, read through the real request", async () => {
    const calls: string[][] = [];
    const run: Exec = async (_cmd, args) => { calls.push([...args]); return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" }; };
    expect(await readMergeBase(run, "/usr/bin/gh", "ap9000/toolroll", "main", "b".repeat(40))).toBe("a".repeat(40));
    expect(calls[0]).toEqual(["api", "--hostname", "github.com", `repos/ap9000/toolroll/compare/main...${"b".repeat(40)}`, "--jq", ".merge_base_commit.sha"]);
    await expect(readMergeBase(async () => ({ code: 0, stdout: "null\n", stderr: "" }), "/usr/bin/gh", "ap9000/toolroll", "main", "b".repeat(40))).rejects.toThrow();
    await expect(readMergeBase(run, "/usr/bin/gh", "ap9000/toolroll", "main..x", "b".repeat(40))).rejects.toThrow();
  });

  test("eval review 1 #4: nothing approves itself unless GitHub refuses a branch behind main (read, never set)", () => {
    for (const mainUpToDate of [false, null] as const) {
      const f = open();
      authorize(f);
      expect(seal(f, check(f), green(f.approved), { mainUpToDate }), String(mainUpToDate)).toMatchObject({ ok: false, why: expect.stringMatching(/up to date|branch protection/) });
      expect(basis(f)).toBeNull();
      f.close(); fixture = null;
    }
  });

  test("eval review 1 #4: main's head, the comparison and the protection come from GitHub's API, strictly read", async () => {
    const calls: string[][] = [];
    const answer = (stdout: string, code = 0, stderr = ""): Exec => async (_gh, args) => { calls.push([...args]); return { code, stdout, stderr }; };
    expect(await readMainHead(answer(`commit ${"a".repeat(40)}\n`), "/usr/bin/gh", "ap9000/toolroll")).toBe("a".repeat(40));
    expect(calls.at(-1)).toEqual(["api", "--hostname", "github.com", "repos/ap9000/toolroll/git/ref/heads/main", "--jq", ".object.type + \" \" + .object.sha"]);
    await expect(readMainHead(answer(`tag ${"a".repeat(40)}\n`), "/usr/bin/gh", "ap9000/toolroll")).rejects.toThrow();
    await expect(readMainHead(answer("", 1, "HTTP 502"), "/usr/bin/gh", "ap9000/toolroll")).rejects.toThrow();
    expect(await readContains(answer('["ahead",0]'), "/usr/bin/gh", "ap9000/toolroll", "b".repeat(40), "a".repeat(40))).toBe(true);
    expect(await readContains(answer('["identical",0]'), "/usr/bin/gh", "ap9000/toolroll", "b".repeat(40), "a".repeat(40))).toBe(true);
    expect(await readContains(answer('["diverged",2]'), "/usr/bin/gh", "ap9000/toolroll", "b".repeat(40), "a".repeat(40))).toBe(false);
    expect(await readContains(answer('["behind",1]'), "/usr/bin/gh", "ap9000/toolroll", "b".repeat(40), "a".repeat(40))).toBe(false);
    await expect(readContains(answer("null"), "/usr/bin/gh", "ap9000/toolroll", "b".repeat(40), "a".repeat(40))).rejects.toThrow();
    // Protection (review 2 #1): effective and non-bypassable for the account that merges, or not at all.
    const P = protectionWorld(calls);
    expect(await readUpToDateRequired(P.exec(), "/usr/bin/gh", "ap9000/toolroll")).toBe(true);
    expect(await readUpToDateRequired(P.exec({ classic: { code: 1, stdout: "", stderr: "HTTP 403" }, rules: { code: 1, stdout: "", stderr: "HTTP 502" } }), "/usr/bin/gh", "ap9000/toolroll")).toBeNull();
    // Only reads: no call this makes writes to GitHub.
    expect(calls.flat()).not.toContain("-X");
  });

  test("a base that isn't in the project's own Git directory refuses the auto-check", () => {
    const f = open();
    expect(authorize(f, "0".repeat(40))).toMatchObject({ ok: false, why: expect.stringContaining("isn't in the project's own Git directory") });
    expect(basis(f)).toBeNull();
  });
});

describe("codex r1 #2: only product code, tests, docs, the changelog and a version bump ship without a person", () => {
  const lock = (version: string, deps: Record<string, string> = {}) => JSON.stringify({ name: "fixture-app", version, lockfileVersion: 3, requires: true, packages: { "": { name: "fixture-app", version, ...(Object.keys(deps).length === 0 ? {} : { dependencies: deps }) } } }, null, 2) + "\n";
  const pkg = (version: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "fixture-app", version, type: "module", files: ["dist"], scripts: { build: "node build.mjs" }, ...extra }, null, 2) + "\n";
  test.each([
    ["scripts/check-results.mjs", "// reports\n"],
    ["scripts/postbuild.mjs", "// build\n"],
    ["scripts/app-e2e.mjs", "// journeys, changed\n"],
    ["test/helpers.ts", "export {};\n"],
    ["test/attacks/vitest.config.ts", "export default {};\n"],
    ["test/release-fixture.ts", "export {};\n"],
    ["test/fixtures/sample.test.ts", "test('x', () => {});\n"],
    ["test/attacks/harness.ts", "export {};\n"],
    ["docs/testing.md", "# Testing\n"],
    ["docs/plans/next.md", "# Plan\n"],
    ["src/fixtures/sample.json", "{}\n"],
    ["src/test-temp.ts", "export {};\n"],
    ["src/unfenced-test-support.ts", "export {};\n"],
    ["tsconfig.json", "{}\n"],
    ["src/browser/vite.config.ts", "export default {};\n"],
    [".npmrc", "registry=https://example.invalid\n"],
    ["CLAUDE.md", "# anything\n"],
    ["Makefile", "all:\n"],
  ])("%s changed: a person approves", (path, text) => {
    const f = open({ candidate: { [path]: text } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining(`${path} changed`) });
  });

  test.each([
    ["a dependency added to package.json", { "package.json": pkg("0.9.71", { dependencies: { vitest: "^9.9.9" } }) }],
    ["a dependency swapped in the lockfile", { "package-lock.json": lock("0.9.71", { vitest: "npm:fake-vitest@1.0.0" }) }],
    ["package.json scripts changed", { "package.json": pkg("0.9.71", { scripts: { build: "node build.mjs", test: "true" } }) }],
  ])("%s: a person approves", (_name, files) => {
    const f = open({ candidate: files });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("beyond its version") });
  });

  test("a version bump of package.json and the lockfile, product code, its tests and docs ship", () => {
    const f = open({ candidate: { "package.json": pkg("0.9.72"), "package-lock.json": lock("0.9.72"), "src/index.js": "export const answer = 44;\n", "src/index.test.ts": "test('answer', () => {});\ntest('more', () => {});\n", "docs/guide.md": "# Guide 3\n", "CHANGELOG.md": "## 0.9.72\n" } });
    authorize(f);
    const sealed = seal(f, check(f));
    expect(sealed.ok ? "" : sealed.why).toBe("");
  });
});

/**
 * GitHub's check-runs endpoint as it behaves: `filter=latest` (its default) lists only the newest attempt of each job;
 * `filter=all` lists every attempt. Answers as gh does with --paginate --jq (one JSON object per line).
 */
function fakeGitHub(attempts: { id: number; name: string; conclusion: string; suite?: number; app?: string; head?: string; steps?: { number: number; name: string; status: string; conclusion: string | null }[] }[], sha: string,
  /** Each suite's workflow-run row (codex round 1, inherited CI limitation): ci.yml for the default suite 7. */
  flows: { suite: number; workflow: number; path: string; event?: string; branch?: string; bases?: string[]; prs?: number[] }[] = [{ suite: 7, workflow: 3, path: ".github/workflows/ci.yml" }]) {
  const calls: string[][] = [];
  const run: Exec = async (_cmd, args) => {
    calls.push([...args]);
    // GitHub's job record (a check run's id is its job's): its steps as the runner recorded them.
    const job = args.find(arg => /\/actions\/jobs\/\d+$/.test(arg));
    if (job !== undefined) {
      const one = attempts.find(attempt => job.endsWith(`/${attempt.id}`));
      return one === undefined ? { code: 1, stdout: "", stderr: "not found" } : { code: 0, stdout: JSON.stringify({ id: one.id, status: "completed", conclusion: one.conclusion, steps: one.steps ?? [] }), stderr: "" };
    }
    // The workflow-run listing: which suite is a run of which workflow, and that workflow's file.
    if (args.some(arg => arg.includes("/actions/runs"))) return { code: 0, stdout: flows.map(one => `${JSON.stringify({ event: "pull_request", branch: "release-x", bases: ["main"], ...one, prs: (one.prs ?? [254]).map(number => ({ number, repo: number === 777 ? "https://api.github.com/repos/someone/fork" : "https://api.github.com/repos/ap9000/toolroll" })), head: sha })}\n`).join(""), stderr: "" };
    // A pull request's timeline events (the retarget check): none by default; "retargeted-<n>" names one that was.
    const timeline = args.find(arg => /\/issues\/\d+\/timeline/.test(arg));
    if (timeline !== undefined) {
      const pr = Number(/\/issues\/(\d+)\//.exec(timeline)![1]);
      if (pr === 999) return { code: 1, stdout: "", stderr: "not found" };
      return { code: 0, stdout: pr === 666 ? "labeled\nbase_ref_changed\n" : "labeled\n", stderr: "" };
    }
    const url = args.find(arg => arg.includes("/check-runs")) ?? "";
    const all = /[?&]filter=all(&|$)/.test(url);
    const rows = attempts.map(one => ({ id: one.id, name: one.name, status: "completed", conclusion: one.conclusion, app: one.app ?? "github-actions", suite: one.suite ?? 7, head: one.head ?? sha }));
    const shown = all ? rows : rows.filter(row => !rows.some(other => other.name === row.name && other.suite === row.suite && other.id > row.id));
    return { code: 0, stdout: shown.map(row => JSON.stringify(row)).join("\n") + "\n", stderr: "" };
  };
  return { run, calls };
}

describe("codex r1 #3: the cap counts every attempt GitHub holds, read through the real request", () => {
  test("the request asks for every attempt, every page, from github.com only, with no caller PATH or host override", async () => {
    const { run, calls } = fakeGitHub([{ id: 1, name: "x", conclusion: "success" }], "a".repeat(40));
    let env: NodeJS.ProcessEnv | undefined;
    const spy: Exec = async (cmd, args, options) => { env = options?.env; return run(cmd, args, options); };
    const saved = process.env["GH_HOST"]; process.env["GH_HOST"] = "evil.example";
    try { expect(await readCheckRuns(spy, "/usr/bin/gh", "ap9000/toolroll", "a".repeat(40))).toHaveLength(1); }
    finally { if (saved === undefined) delete process.env["GH_HOST"]; else process.env["GH_HOST"] = saved; }
    expect(calls[0]).toEqual(["api", "--hostname", "github.com", "--paginate", `repos/ap9000/toolroll/commits/${"a".repeat(40)}/check-runs?filter=all&per_page=100`,
      "--jq", ".check_runs[] | {id, name, status, conclusion, app: .app.slug, suite: .check_suite.id, head: .head_sha}"]);
    expect(env).toMatchObject({ GH_HOST: "github.com", PATH: "/usr/bin:/bin" });
    expect(env?.["GH_CONFIG_DIR"]).toBeUndefined();
  });

  test("a row GitHub answers that can't be read, or the same run twice, stops the read", async () => {
    const bad: Exec = async () => ({ code: 0, stdout: `{"id":"x","name":"a","status":"completed"}\n`, stderr: "" });
    await expect(readCheckRuns(bad, "/usr/bin/gh", "ap9000/toolroll", "a".repeat(40))).rejects.toThrow();
    const twice: Exec = async () => ({ code: 0, stdout: `{"id":1,"name":"a","status":"completed"}\n{"id":1,"name":"a","status":"completed"}\n`, stderr: "" });
    await expect(readCheckRuns(twice, "/usr/bin/gh", "ap9000/toolroll", "a".repeat(40))).rejects.toThrow();
  });

  /** Steps as GitHub records them: only its own "Set up job" ran (the runner failed before the tests), or the tests too. */
  const RUNNER_LOST = [{ number: 1, name: "Set up job", status: "completed", conclusion: "failure" }, { number: 2, name: "Run tests", status: "completed", conclusion: "skipped" }, { number: 3, name: "Complete job", status: "completed", conclusion: "success" }];
  const TESTS_FAILED = [{ number: 1, name: "Set up job", status: "completed", conclusion: "success" }, { number: 2, name: "Set up job", status: "completed", conclusion: "failure" }, { number: 3, name: "Complete job", status: "completed", conclusion: "success" }];
  test.each([[2, RUNNER_LOST, true], [3, RUNNER_LOST, false], [1, TESTS_FAILED, false], [1, [], true]] as const)("%i failed attempts of one job before its pass, end to end through the store adapter (steps %j): approved=%s", async (failed, steps, approved) => {
    const f = open();
    const attempts = [
      // A step the candidate named like GitHub's own "Set up job" still counts as a step that ran: numbers, not names.
      ...Array.from({ length: failed }, (_, i) => ({ id: 10 + i, name: REQUIRED_PR_CHECKS[0], conclusion: "failure", steps: [...steps] })),
      ...REQUIRED_PR_CHECKS.map((name, i) => ({ id: 100 + i, name, conclusion: "success" })),
    ];
    const gh = fakeGitHub(attempts, f.approved);
    const rel = storeReleaseAdapter(() => f.store, () => {}, () => LATER, undefined, {
      observe: async sha => ({ head: sha, observedAt: LATER.toISOString(), complete: true, runs: (await readCheckRuns(gh.run, "/usr/bin/gh", "ap9000/toolroll", sha)).map(one => ({ id: one.id ?? null, name: one.name, status: one.status, conclusion: one.conclusion, app: one.app ?? null, suite: one.suite ?? null, head: one.head ?? null, workflowPath: one.workflowPath ?? null, beforeTests: one.beforeTests ?? null })) }),
      mergeBase: async () => f.base, upToDateRequired: async () => true, evidenceRoot: EVIDENCE(f), reportsProtected: true,
    });
    expect(await rel.auto!.authorizeCheck({ taskId: f.taskId, digest: digestOf(f), candidate: f.approved })).toEqual({ ok: true });
    const run = check(f);
    const answer = await rel.auto!.approve({ taskId: f.taskId, digest: digestOf(f), candidate: f.approved, run, receipt: receiptOf(f) });
    expect(answer.ok).toBe(approved);
    if (!approved) expect(answer).toMatchObject({ why: expect.stringMatching(/failed 3 times|doesn't show its runner failing/) });
  });

  test.each([false, undefined])("candidate-writable or unknown report provenance (%s) cannot authorize or approve automatically", async reportsProtected => {
    const f = open();
    const rel = storeReleaseAdapter(() => f.store, () => {}, () => LATER, undefined, {
      observe: async () => green(f.approved), mergeBase: async () => f.base, upToDateRequired: async () => true,
      evidenceRoot: EVIDENCE(f), ...(reportsProtected === undefined ? {} : { reportsProtected }),
    });
    const input = { taskId: f.taskId, digest: digestOf(f), candidate: f.approved };
    expect(await rel.auto!.authorizeCheck(input)).toMatchObject({ ok: false, why: expect.stringContaining("reports") });
    expect(basis(f)).toBeNull();
    // A check authorized before this guard was installed cannot turn its passing report into a release seal.
    authorize(f);
    const run = check(f);
    expect(await rel.auto!.approve({ ...input, run, receipt: receiptOf(f) })).toMatchObject({ ok: false, why: expect.stringContaining("reports") });
    expect(basis(f)).toBeNull();
    // The fallback still waits for exact-head CI, then lets a person decide.
    holdApprovalForCi(f.store, { taskId: f.taskId, candidate: f.approved, now: LATER });
    expect(await rel.auto!.ciPassed!(f.taskId, f.approved, true)).toEqual({ ok: true });
    expect(approve(f.store, f.taskId, "alex", LATER, digestOf(f), f.password)).toMatchObject({ ok: true });
  });
});

describe("codex r1 #6: lowering the setting stops an unissued merge for good", () => {
  /** An auto-approved release taken to `merge-reserved`, its deploy settled; `issue` starts the merge too. */
  const toMerge = (f: ReleaseFixture, issue: boolean) => {
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: true });
    const a = releaseAuthorityOfTask(f.store, f.taskId)!.authority;
    const lease = takeReleaseLease(f.store, a.id, "coordinator", LATER);
    if (!lease.ok) throw new Error(lease.why);
    const deploy = reserveRelease(f.store, { authority: a.id, kind: "deploy", taskId: f.taskId, candidate: f.approved, epoch: lease.epoch, operationId: "d1", now: LATER, secret: "s" });
    expect(deploy.ok).toBe(true);
    expect(runReleaseOperation(f.store, "d1", lease.epoch, LATER)).toBe(true);
    expect(finishReleaseOperation(f.store, "d1", "succeeded", {}, LATER, lease.epoch)).toBe(true);
    expect(reserveRelease(f.store, { authority: a.id, kind: "merge", taskId: f.taskId, candidate: f.approved, epoch: lease.epoch, operationId: "m1", now: LATER })).toMatchObject({ ok: true });
    if (issue) expect(runReleaseOperation(f.store, "m1", lease.epoch, LATER)).toBe(true);
    return { a, epoch: lease.epoch };
  };

  test("reserved, never issued: off then on again, nothing of it stands or starts", () => {
    const f = open();
    const { a, epoch } = toMerge(f, false);
    setReleaseApproval(f.store, f.repo, false, "alex", LATER);
    setReleaseApproval(f.store, f.repo, true, "alex", LATER);
    expect(releaseAuthorityOfTask(f.store, f.taskId)!.authority.state).toBe("revoked");
    expect(releaseApprovalOf(f.store, f.taskId, LATER)).toMatchObject({ ok: false });
    expect(liveReleaseOf(f.store, f.taskId, "merge", LATER)).toMatchObject({ ok: false });
    expect(runReleaseOperation(f.store, "m1", epoch, LATER)).toBe(false);
    // The evidence is withdrawn for good: even a seal written back by hand stands on nothing.
    const evidence = f.store.handle.prepare("SELECT id FROM action_ledger WHERE task_id = ? AND action = 'release auto-approved' AND outcome = 'auto-green'").get(f.taskId)!;
    f.store.handle.prepare("UPDATE task_scope SET approved_at = ?, approved_by = 'alex', approved_digest = digest, approval_basis = 'auto-green', mode_digest = ? WHERE task_id = ?").run(LATER.toISOString(), `auto:${evidence["id"]}`, f.taskId);
    expect(scopeApprovedForDispatch(f.store, ref(f), LATER)).toBe(false);
    expect(installedScope.autoReleaseApprovalOf(f.store, f.taskId, "auto-green")).toMatchObject({ ok: false });
    void a;
  });

  test("a merge already issued is in flight: it is left to finish through its reconciliation", () => {
    const f = open();
    toMerge(f, true);
    setReleaseApproval(f.store, f.repo, false, "alex", LATER);
    expect(releaseAuthorityOfTask(f.store, f.taskId)!.authority.state).toBe("merge-reserved");
    expect(releaseOperations(f.store, releaseAuthorityOfTask(f.store, f.taskId)!.authority.id).find(op => op.id === "m1")?.state).toBe("running");
  });
});

describe("codex r1 #7 and the scan: flake retries as the builder and regate really record them", () => {
  /** A build commit of the candidate's tree on `parent`, as the builder commits a prepared candidate. */
  const buildCommit = (f: ReleaseFixture, parent: string) => {
    const tree = f.git("rev-parse", `${f.approved}^{tree}`);
    return execFileSync("git", ["-C", f.repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit-tree", tree, "-p", parent, "-m", `Release ${f.taskId}`], { encoding: "utf8" }).trim();
  };
  const red = () => reportOf(UNITS.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : { file }));

  test("a release rerun (confirmed infrastructure) starting at the first attempt's build commit, then passing, approves", () => {
    const f = open({ candidate: { "src/index.js": "export const answer = 43;\n" } });
    authorize(f);
    const b1 = buildCommit(f, f.base);
    const first = sealedCheck(f, f.taskId, b1, () => null, { base: f.base, plane: { configured: true, ran: false, attemptFailed: true, failure: "custody-lost" } }).runId;
    rerunRecorded(f, first);
    // The regate's attempt starts at B1 (the previous build commit) and commits B2 on it.
    const b2 = buildCommit(f, b1);
    const rerun = sealedCheck(f, f.taskId, b2, (_plan, units) => passingReport(units), { base: b1 }).runId;
    expect(seal(f, rerun)).toMatchObject({ ok: true });
  });

  test("every unsuccessful build counts: an interrupted build before the pass needs a person", () => {
    const f = open();
    authorize(f);
    const interrupted = builtRun(f.store, f.taskId, f.approved, f.base);
    f.store.handle.prepare("UPDATE run SET outcome = 'interrupted' WHERE id = ?").run(interrupted);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("its build ended interrupted") });
  });

  test("a build that never recorded a check counts too: unexplained, a person decides", () => {
    const f = open();
    authorize(f);
    rerunRecorded(f, builtRun(f.store, f.taskId, f.approved, f.base));
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("unexplained") });
  });
});

describe("codex r1: a direct deploy can't pass for the coordinator's", () => {
  test("only the reserved operation's own secret adopts it; a guessed id or secret is refused", () => {
    const f = open();
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: true });
    const a = releaseAuthorityOfTask(f.store, f.taskId)!.authority;
    const lease = takeReleaseLease(f.store, a.id, "coordinator", LATER);
    if (!lease.ok) throw new Error(lease.why);
    expect(reserveRelease(f.store, { authority: a.id, kind: "deploy", taskId: f.taskId, candidate: f.approved, epoch: lease.epoch, operationId: "d1", now: LATER, secret: "the-secret" })).toMatchObject({ ok: true });
    expect(runReleaseOperation(f.store, "d1", lease.epoch, LATER)).toBe(true);
    expect(adoptReleaseOperation(f.store, { id: "d1", authority: a.id, candidate: f.approved, secret: "guess", now: LATER })).toMatchObject({ ok: false });
    expect(adoptReleaseOperation(f.store, { id: "d2", authority: a.id, candidate: f.approved, secret: "the-secret", now: LATER })).toMatchObject({ ok: false });
    expect(adoptReleaseOperation(f.store, { id: "d1", authority: a.id, candidate: f.approved, secret: "the-secret", now: LATER })).toEqual({ ok: true });
  });
});

describe("coordinator: test files under test/ ship like src's tests", () => {
  test("an added and a modified attack test, with product code, are approved", () => {
    const f = open({ candidate: { "test/attacks/fence.test.ts": "test('fence', () => {});\ntest('more fence', () => {});\n", "test/attacks/new-guard.test.ts": "test('guard', () => {});\n", "src/index.js": "export const answer = 45;\n" } });
    authorize(f);
    const sealed = seal(f, check(f));
    expect(sealed.ok ? "" : sealed.why).toBe("");
  });

  test.each([["test/attacks/fence.test.ts"], ["src/index.test.ts"]])("deleting %s needs a person", path => {
    const f = open({ candidate: { [path]: null } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining(`${path} was deleted`) });
  });

  test.each([
    ["an assertion removed", "test('guard', () => {});\ntest('second', () => expect(false).toBe(false));\n"],
    ["a case removed", "test('guard', () => expect(true).toBe(true));\n"],
    ["an assertion replaced with a tautology", "test('guard', () => expect(1).toBe(1));\ntest('second', () => expect(false).toBe(false));\n"],
    ["existing cases commented out", "/*\ntest('guard', () => expect(true).toBe(true));\ntest('second', () => expect(false).toBe(false));\n*/\ntest('green', () => {});\n"],
    ["an existing case skipped", "test.skip('guard', () => expect(true).toBe(true));\ntest('second', () => expect(false).toBe(false));\n"],
  ])("%s needs a person even with passing reports", (_name, candidate) => {
    const path = "src/guard.test.ts";
    const f = open({ files: { [path]: "test('guard', () => expect(true).toBe(true));\ntest('second', () => expect(false).toBe(false));\n" }, candidate: { [path]: candidate } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("existing test code") });
    expect(basis(f)).toBeNull();
  });

  test("renaming an existing test needs a person even when its replacement passes", () => {
    const f = open({ candidate: { "src/index.test.ts": null, "src/renamed.test.ts": "test('answer', () => {});\n" } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("src/index.test.ts was deleted") });
  });
});

// ---------------------------------------------------------------------------------------------- Codex review round 2

import { testInfrastructure } from "../../src/test-infra.js";
import { readSuitesComplete } from "../../src/release-adapters.js";
import { allowAutoPublish, autoPublishHeld, holdAutoPublish } from "../../src/release-auto.js";

/** A project with a product entry (src/bin.ts → src/app.ts), a shared test helper only tests import, and its test. */
const PROJECT = {
  "src/bin.ts": "import { main } from \"./app.js\";\nmain();\n",
  "src/app.ts": "export const main = () => 42;\n",
  "src/contracts/contract-test.ts": "export const assertContract = (ok: boolean) => { if (!ok) throw new Error('contract'); };\n",
  "src/contracts/receipt.test.ts": "import { assertContract } from \"./contract-test.js\";\ntest('receipt', () => assertContract(true));\n",
};

describe("codex r2 #1: test infrastructure is found from the import graph, not from file names", () => {
  test("a helper only tests import (src/contracts/contract-test.ts) needs a person; product code beside it ships", () => {
    const f = open({ files: PROJECT, candidate: { "src/contracts/contract-test.ts": "export const assertContract = (_ok: boolean) => {};\n" } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("src/contracts/contract-test.ts changed (tests import it and the product doesn't") });
    fixture?.close(); fixture = null;
    const g = open({ files: PROJECT, candidate: { "src/app.ts": "export const main = () => 43;\n" } });
    authorize(g);
    const sealed = seal(g, check(g));
    expect(sealed.ok ? "" : sealed.why).toBe("");
  });

  test("the scan: dynamic imports count, commented-out ones don't, tsconfig path aliases resolve, vitest setup files are roots", () => {
    const files = new Map(Object.entries({
      "package.json": JSON.stringify({ name: "p", devDependencies: { vitest: "1" } }),
      "tsconfig.json": "{ // comments allowed\n \"compilerOptions\": { \"baseUrl\": \".\", \"paths\": { \"@helpers/*\": [\"src/helpers/*\"] } } }",
      "vitest.config.ts": "import { defineConfig } from \"vitest/config\";\nexport default defineConfig({ test: { setupFiles: [\"./src/setup-hook.ts\"] } });\n",
      "src/bin.ts": "export {};\n",
      "src/setup-hook.ts": "export {};\n",
      "src/dyn.ts": "export {};\n",
      "src/commented.ts": "export {};\n",
      "src/helpers/alias.ts": "export {};\n",
      "src/a.test.ts": "// import \"./commented.js\";\n/* import { x } from \"./commented.js\" */\nconst m = await import(\"./dyn.js\");\nimport { y } from \"@helpers/alias.js\";\nimport { test } from \"vitest\";\n",
    }));
    const found = testInfrastructure(files);
    expect([...found.infra].sort()).toEqual(["src/dyn.ts", "src/helpers/alias.ts", "src/setup-hook.ts", "vitest.config.ts"]);
    expect(found.infra.has("src/commented.ts")).toBe(false);
    expect(found.unresolved).toEqual([]);
  });

  test("an import the tests make that can't be resolved refuses a change it might name", () => {
    const f = open({ files: { ...PROJECT, "src/loader.test.ts": "const name = process.env.WHICH ?? \"x\";\nconst m = await import(name);\ntest('l', () => {});\n" },
      candidate: { "src/new-orphan.ts": "export const x = 1;\n" } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("which couldn't be resolved and might name it") });
  });

  test("an unresolved relative import names exactly its target", () => {
    const files = new Map(Object.entries({ "src/bin.ts": "export {};\n", "src/x.test.ts": "import \"./missing.js\";\n" }));
    expect(testInfrastructure(files).unresolved).toEqual([{ from: "src/x.test.ts", specifier: "./missing.js", prefix: "src/missing.js" }]);
  });

  test("security scan: deny rules run before the test-file allowance", () => {
    const f = open({ candidate: { "test/attacks/.github/a.test.ts": "test('a', () => {});\n" } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("test/attacks/.github/a.test.ts changed") });
  });
});

describe("codex r2 #3: a held publication is the plane's, and only a person releases it", () => {
  test("held stays held until a person allows it; the CLI refuses the lead", async () => {
    const f = open();
    holdAutoPublish(f.store, { taskId: f.taskId, why: "Checks stopped passing after the merge", now: LATER });
    expect(autoPublishHeld(f.store, f.taskId)).toContain("stopped passing");
    const saved = process.env["TOOLROLL_LEAD_TOKEN"]; process.env["TOOLROLL_LEAD_TOKEN"] = "lt_lead_synthetic";
    try { expect(await runReleaseCommand(["publish-ok", f.taskId, "--as", "alex", "--token", f.password, "--json"], () => {}, { database: f.databaseFile, now: () => LATER })).not.toBe(0); }
    finally { if (saved === undefined) delete process.env["TOOLROLL_LEAD_TOKEN"]; else process.env["TOOLROLL_LEAD_TOKEN"] = saved; }
    expect(autoPublishHeld(f.store, f.taskId)).not.toBeNull();
    expect(await runReleaseCommand(["publish-ok", f.taskId, "--as", "alex", "--token", "wrong", "--json"], () => {}, { database: f.databaseFile, now: () => LATER })).not.toBe(0);
    expect(await runReleaseCommand(["publish-ok", f.taskId, "--as", "alex", "--token", f.password, "--json"], () => {}, { database: f.databaseFile, now: () => LATER })).toBe(0);
    expect(autoPublishHeld(f.store, f.taskId)).toBeNull();
    expect(allowAutoPublish(f.store, { taskId: f.taskId, by: "alex", now: LATER })).toMatchObject({ ok: false });
  });
});

describe("codex r2 #4: an issued merge that later fails never regains the automatic approval", () => {
  test("issued merge → off → the merge reconciles as failed → on: nothing stands", () => {
    const f = open();
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: true });
    const a = releaseAuthorityOfTask(f.store, f.taskId)!.authority;
    const lease = takeReleaseLease(f.store, a.id, "coordinator", LATER);
    if (!lease.ok) throw new Error(lease.why);
    reserveRelease(f.store, { authority: a.id, kind: "deploy", taskId: f.taskId, candidate: f.approved, epoch: lease.epoch, operationId: "d1", now: LATER, secret: "s" });
    runReleaseOperation(f.store, "d1", lease.epoch, LATER);
    finishReleaseOperation(f.store, "d1", "succeeded", {}, LATER, lease.epoch);
    reserveRelease(f.store, { authority: a.id, kind: "merge", taskId: f.taskId, candidate: f.approved, epoch: lease.epoch, operationId: "m1", now: LATER });
    expect(runReleaseOperation(f.store, "m1", lease.epoch, LATER)).toBe(true);
    setReleaseApproval(f.store, f.repo, false, "alex", LATER);
    expect(finishReleaseOperation(f.store, "m1", "failed", { detail: "GitHub didn't merge" }, LATER, lease.epoch)).toBe(true);
    expect(releaseAuthorityOfTask(f.store, f.taskId)!.authority.state).toBe("deploying");
    setReleaseApproval(f.store, f.repo, true, "alex", LATER);
    expect(installedScope.autoReleaseApprovalOf(f.store, f.taskId, "auto-green")).toMatchObject({ ok: false });
    expect(releaseApprovalOf(f.store, f.taskId, LATER)).toMatchObject({ ok: false });
    expect(liveReleaseOf(f.store, f.taskId, "merge", LATER)).toMatchObject({ ok: false });
  });
});

describe("codex r2 #6: GitHub's 1000-suite ceiling fails an automatic approval closed", () => {
  const answer = (stdout: string, code = 0): Exec => async () => ({ code, stdout, stderr: "" });
  test.each([["999\n", true], ["1000\n", false], ["5000\n", false], ["", false], ["nope\n", false]] as const)("total_count %j: whole=%s", async (stdout, whole) => {
    expect(await readSuitesComplete(answer(stdout), "/usr/bin/gh", "ap9000/toolroll", "a".repeat(40))).toBe(whole);
  });
  test("a failed read is not whole", async () => {
    expect(await readSuitesComplete(answer("12\n", 1), "/usr/bin/gh", "ap9000/toolroll", "a".repeat(40))).toBe(false);
  });
  test("an observation that isn't whole refuses the seal", () => {
    const f = open();
    authorize(f);
    expect(seal(f, check(f), { ...green(f.approved), complete: false })).toMatchObject({ ok: false, why: expect.stringContaining("can't be read whole") });
  });
  test("workflow identity comes from GitHub's workflow-run API, read through the real request", async () => {
    const sha = "a".repeat(40);
    const run: Exec = async (_cmd, args) => {
      const url = args.find(arg => arg.startsWith("repos/")) ?? "";
      if (url.includes("/actions/runs")) return { code: 0, stdout: `${JSON.stringify({ suite: 7, workflow: 3, path: ".github/workflows/ci.yml", head: sha, event: "pull_request", branch: "release-x", bases: ["main"], prs: [{ number: 254, repo: "https://api.github.com/repos/ap9000/toolroll" }] })}\n`, stderr: "" };
      return { code: 0, stdout: `${JSON.stringify({ id: 1, name: "x", status: "completed", conclusion: "success", app: "github-actions", suite: 7, head: sha })}\n`, stderr: "" };
    };
    expect(await readCheckRuns(run, "/usr/bin/gh", "ap9000/toolroll", sha)).toEqual([{ id: 1, name: "x", status: "completed", conclusion: "success", app: "github-actions", suite: 7, head: sha, workflow: 3, workflowPath: ".github/workflows/ci.yml" }]);
    // A workflow run GitHub answers without its file can't be read: no required check stands on an unnamed workflow.
    const pathless: Exec = async (_cmd, args) => (args.find(arg => arg.startsWith("repos/")) ?? "").includes("/actions/runs")
      ? { code: 0, stdout: `${JSON.stringify({ suite: 7, workflow: 3, head: sha })}\n`, stderr: "" } : run(_cmd, args);
    await expect(readCheckRuns(pathless, "/usr/bin/gh", "ap9000/toolroll", sha)).rejects.toThrow(/workflow run this can't read/);
  });

  test.each([
    ["a pull request into another branch", { event: "pull_request", bases: ["release-base"] }],
    ["a pull request with no base recorded", { event: "pull_request", bases: [] }],
    ["a push to another branch", { event: "push", branch: "feature" }],
    ["a manually dispatched run", { event: "workflow_dispatch", branch: "main" }],
  ])("security scan of the join: ci.yml run from %s never stands for a required check", async (_why, trigger) => {
    const f = open();
    const attempts = REQUIRED_PR_CHECKS.map((name, at) => ({ id: 100 + at, name, conclusion: "success" }));
    const gh = fakeGitHub(attempts, f.approved, [{ suite: 7, workflow: 3, path: ".github/workflows/ci.yml", ...trigger }]);
    const runs = await readCheckRuns(gh.run, "/usr/bin/gh", "ap9000/toolroll", f.approved);
    expect(runs.every(run => run.workflowPath === null)).toBe(true);
  });
  test.each([["was retargeted after it ran", 666], ["has a timeline GitHub won't show", 999], ["belongs to another repository", 777]])("security scan: a pull request into main that %s never stands for a required check", async (_why, pr) => {
    const f = open();
    const attempts = [{ id: 100, name: REQUIRED_PR_CHECKS[0]!, conclusion: "success" }];
    const runs = await readCheckRuns(fakeGitHub(attempts, f.approved, [{ suite: 7, workflow: 3, path: ".github/workflows/ci.yml", event: "pull_request", bases: ["main"], prs: [pr] }]).run, "/usr/bin/gh", "ap9000/toolroll", f.approved);
    expect(runs[0]!.workflowPath).toBeNull();
  });
  test("security scan of the join: a pull request into main and a push to main bind ci.yml", async () => {
    const f = open();
    const attempts = [{ id: 100, name: REQUIRED_PR_CHECKS[0]!, conclusion: "success" }];
    for (const trigger of [{ event: "pull_request", bases: ["main"] }, { event: "push", branch: "main" }]) {
      const runs = await readCheckRuns(fakeGitHub(attempts, f.approved, [{ suite: 7, workflow: 3, path: ".github/workflows/ci.yml", ...trigger }]).run, "/usr/bin/gh", "ap9000/toolroll", f.approved);
      expect(runs[0]!.workflowPath).toBe(".github/workflows/ci.yml");
    }
  });
  test("codex round 1 (inherited CI limitation): a lookalike job in another workflow never stands for a required check", async () => {
    // Every required job passes in ci.yml except the first, which is missing there; another workflow has a job of
    // exactly its name that passes. Read through the real request, the plane refuses it.
    const f = open();
    const attempts = REQUIRED_PR_CHECKS.map((name, i) => ({ id: 100 + i, name, conclusion: "success", suite: i === 0 ? 8 : 7 }));
    const gh = fakeGitHub(attempts, f.approved, [{ suite: 7, workflow: 3, path: ".github/workflows/ci.yml" }, { suite: 8, workflow: 4, path: ".github/workflows/lookalike.yml" }]);
    const runs = (await readCheckRuns(gh.run, "/usr/bin/gh", "ap9000/toolroll", f.approved)).map(one => ({ ...one, id: one.id ?? null, app: one.app ?? null }));
    const ci: CiObservation = { head: f.approved, observedAt: LATER.toISOString(), complete: true, runs };
    expect(ciProblem(ci, f.approved, LATER)).toMatch(new RegExp(`${REQUIRED_PR_CHECKS[0]} \\(from .github/workflows/lookalike.yml, not .github/workflows/ci.yml\\)`));
    // A required job whose workflow GitHub doesn't name is refused the same way.
    expect(ciProblem({ ...ci, runs: runs.map((one, i) => i === 0 ? { ...one, workflowPath: null } : one) }, f.approved, LATER)).toMatch(/a workflow GitHub doesn't name/);
    // The person's road judges the same: the plane doesn't lift a CI hold on a lookalike.
    holdApprovalForCi(f.store, { taskId: f.taskId, candidate: f.approved, now: RELEASE_NOW });
    expect(liftCiHold(f.store, { taskId: f.taskId, candidate: f.approved, ci, ask: true, now: LATER })).toMatchObject({ ok: false, why: expect.stringContaining("lookalike.yml") });
    // With the job in ci.yml it stands.
    expect(ciProblem({ ...ci, runs: runs.map(one => ({ ...one, workflowPath: ".github/workflows/ci.yml" })) }, f.approved, LATER)).toBeNull();
  });
});

describe("scan round 3: every way a test can load a module is an edge, or unresolved and refused", () => {
  const scan = (extra: Record<string, string>) => testInfrastructure(new Map(Object.entries({
    "package.json": JSON.stringify({ name: "fixture-app", devDependencies: { vitest: "1" } }),
    "src/bin.ts": "export {};\n", "src/target.ts": "export {};\n", ...extra,
  })));
  test.each([
    ["createRequire bound to a name", "import { createRequire } from \"node:module\";\nconst load = createRequire(import.meta.url);\nload(\"./target.js\");\n"],
    ["createRequire(...)(...) directly", "import { createRequire } from \"node:module\";\ncreateRequire(import.meta.url)(\"./target.js\");\n"],
    ["vi.importActual", "await vi.importActual(\"./target.js\");\n"],
    ["vitest.mock", "vitest.mock(\"./target.js\");\n"],
    ["vi.doMock", "vi.doMock(\"./target.js\", () => ({}));\n"],
    ["a path handed to any other call", "loadModule(\"./target.ts\");\n"],
  ])("%s is an edge", (_name, text) => {
    expect([...scan({ "src/x.test.ts": text }).infra]).toContain("src/target.ts");
  });

  test.each([
    ["a computed createRequire load", "import { createRequire } from \"node:module\";\nconst load = createRequire(import.meta.url);\nload(process.env.X!);\n"],
    ["a computed vi.importActual", "await vi.importActual(process.env.X!);\n"],
    ["an undeclared bare package", "import \"left-pad\";\n"],
    ["the package's own name", "import \"fixture-app/internal\";\n"],
  ])("%s is unresolved and might name anything", (_name, text) => {
    const found = scan({ "src/x.test.ts": text });
    expect(found.unresolved.some(one => one.prefix === null)).toBe(true);
  });

  test("vitest aliases resolve; one that can't be read statically is unresolved", () => {
    const readable = scan({
      "vitest.config.ts": "export default { resolve: { alias: { \"@kit\": \"./src/kit\" } }, test: { alias: [{ find: \"#t\", replacement: \"./src\" }] } };\n",
      "src/kit/helper.ts": "export {};\n",
      "src/x.test.ts": "import \"@kit/helper.js\";\nimport \"#t/target.js\";\n",
    });
    expect([...readable.infra].sort()).toEqual(["src/kit/helper.ts", "src/target.ts", "vitest.config.ts"]);
    expect(readable.unresolved).toEqual([]);
    const unreadable = scan({ "vitest.config.ts": "import { resolve } from \"node:path\";\nexport default { resolve: { alias: { \"@kit\": resolve(__dirname, \"src/kit\") } } };\n", "src/x.test.ts": "test('x', () => {});\n" });
    expect(unreadable.unresolved).toContainEqual({ from: "vitest.config.ts", specifier: null, prefix: null });
  });

  test("an unresolved import refuses a changed non-product file, and lets product code ship", () => {
    const files = { ...PROJECT, "src/loader.test.ts": "import \"left-pad\";\ntest('l', () => {});\n" };
    const f = open({ files, candidate: { "src/orphan.ts": "export const y = 2;\n" } });
    authorize(f);
    expect(seal(f, check(f))).toMatchObject({ ok: false, why: expect.stringContaining("might name it") });
    fixture?.close(); fixture = null;
    const g = open({ files, candidate: { "src/app.ts": "export const main = () => 44;\n" } });
    authorize(g);
    const sealed = seal(g, check(g));
    expect(sealed.ok ? "" : sealed.why).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------- Codex review round 2

type Answer = { code: number; stdout: string; stderr?: string };
/** GitHub's protection API, scripted: main's classic protection as ap9000/toolroll has it (2026-10-28), no rulesets. */
function protectionWorld(calls: string[][] = []) {
  const live = () => ({ required_status_checks: { strict: true, contexts: [...PROTECTION_MINIMUM_CHECKS], checks: PROTECTION_MINIMUM_CHECKS.map(context => ({ context, app_id: 15368 })) },
    enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false } });
  const json = (value: unknown): Answer => ({ code: 0, stdout: JSON.stringify(value) });
  const notProtected: Answer = { code: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
  const rule = (id: number, checks: readonly string[], strict = true) => JSON.stringify({ type: "required_status_checks", ruleset_id: id, ruleset_source_type: "Repository",
    parameters: { strict_required_status_checks_policy: strict, required_status_checks: checks.map(context => ({ context, integration_id: 15368 })) } });
  const ruleset = (extra: Record<string, unknown> = {}) => ({ enforcement: "active", target: "branch", current_user_can_bypass: "never", bypass_actors: [], ...extra });
  const exec = (o: { classic?: Answer; rules?: Answer; ruleset?: (id: number) => Answer } = {}): Exec => async (_gh, args) => {
    calls.push([...args]);
    const path = args.find(one => one.startsWith("repos/")) ?? "";
    if (path.endsWith("/branches/main/protection")) return { stderr: "", ...(o.classic ?? json(live())) };
    if (path.includes("/rules/branches/")) return { stderr: "", ...(o.rules ?? { code: 0, stdout: "" }) };
    const id = /\/rulesets\/(\d+)$/.exec(path);
    if (id !== null) return { stderr: "", ...(o.ruleset?.(Number(id[1])) ?? { code: 1, stdout: "", stderr: "HTTP 404" }) };
    throw new Error(`unexpected request ${path}`);
  };
  return { live, json, notProtected, rule, ruleset, exec };
}

describe("codex r2 #1: main's protection holds only when it is effective and nobody merging can bypass it", () => {
  const read = (exec: Exec) => readMainProtection(exec, "/usr/bin/gh", "ap9000/toolroll");
  const P = protectionWorld();

  test("the live settings (classic, strict, the five checks, no bypassing) hold, and the git lanes not yet required are named", async () => {
    expect(await read(P.exec())).toEqual({ effective: true, missing: [], notYetRequired: [...PROTECTION_REPORT_ONLY_CHECKS] });
    const all = { ...P.live(), required_status_checks: { strict: true, contexts: [...REQUIRED_PR_CHECKS], checks: REQUIRED_PR_CHECKS.map(context => ({ context, app_id: 15368 })) } };
    expect(await read(P.exec({ classic: P.json(all) }))).toEqual({ effective: true, missing: [], notYetRequired: [] });
    expect(PROTECTION_MINIMUM_CHECKS).toHaveLength(5);
  });

  test.each([
    ["strict with no required checks", (l: ReturnType<typeof P.live>) => ({ ...l, required_status_checks: { strict: true, contexts: [], checks: [] } }), /classic protection: no required status checks/],
    ...[null, -1, 42, "15368", undefined].map(app_id => [
      `a required check accepts source ${String(app_id)}`,
      (l: ReturnType<typeof P.live>) => ({ ...l, required_status_checks: { ...l.required_status_checks, checks: l.required_status_checks.checks.map((check, i) => i === 0 ? { ...check, app_id } : check) } }),
      /must require GitHub Actions/,
    ] as const),
    ["context names without app bindings", (l: ReturnType<typeof P.live>) => ({ ...l, required_status_checks: { ...l.required_status_checks, checks: [] } }), /must require GitHub Actions/],
    ["a minimum check missing", (l: ReturnType<typeof P.live>) => ({ ...l, required_status_checks: { strict: true, contexts: PROTECTION_MINIMUM_CHECKS.slice(1), checks: [] } }), /required checks lack node 22 · ubuntu-latest/],
    ["administrators exempt", (l: ReturnType<typeof P.live>) => ({ ...l, enforce_admins: { enabled: false } }), /"Do not allow bypassing the above settings" is off/],
    ["not up to date", (l: ReturnType<typeof P.live>) => ({ ...l, required_status_checks: { ...l.required_status_checks, strict: false } }), /"Require branches to be up to date before merging" is off/],
    ["status checks off", (l: ReturnType<typeof P.live>) => ({ ...l, required_status_checks: null }), /"Require status checks to pass before merging" is off/],
    ["the bypass setting unreadable", (l: ReturnType<typeof P.live>) => ({ required_status_checks: l.required_status_checks }), /classic protection couldn't be read/],
  ])("classic: %s doesn't hold, and says exactly what", async (_name, change, words) => {
    const answer = await read(P.exec({ classic: P.json(change(P.live())) }));
    expect(answer?.effective).toBe(false);
    expect(answer?.missing.join("; ")).toMatch(words);
  });

  test.each([
    ["strict with zero required checks", () => P.rule(7, []), () => P.ruleset(), /ruleset 7: no required status checks/],
    ...[null, -1, 42, "15368", undefined].map(integration_id => [
      `a required check accepts source ${String(integration_id)}`,
      () => { const rule = JSON.parse(P.rule(7, REQUIRED_PR_CHECKS)); rule.parameters.required_status_checks[0].integration_id = integration_id; return JSON.stringify(rule); },
      () => P.ruleset(), /must require GitHub Actions/,
    ] as const),
    ["not strict", () => P.rule(7, REQUIRED_PR_CHECKS, false), () => P.ruleset(), /up to date before merging" is off/],
    ["the merging account can bypass it", () => P.rule(7, REQUIRED_PR_CHECKS), () => P.ruleset({ current_user_can_bypass: "always" }), /can bypass it \(always\)/],
    ["bypass only on pull requests", () => P.rule(7, REQUIRED_PR_CHECKS), () => P.ruleset({ current_user_can_bypass: "pull_requests_only" }), /can bypass it/],
    ["the admin role bypasses it", () => P.rule(7, REQUIRED_PR_CHECKS), () => P.ruleset({ bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }] }), /bypass list names/],
    ["an organization admin bypasses it", () => P.rule(7, REQUIRED_PR_CHECKS), () => P.ruleset({ bypass_actors: [{ actor_id: null, actor_type: "OrganizationAdmin", bypass_mode: "always" }] }), /bypass list names/],
    ["its bypass list unreadable", () => P.rule(7, REQUIRED_PR_CHECKS), () => { const r = P.ruleset(); delete (r as Record<string, unknown>)["bypass_actors"]; return r; }, /bypass list couldn't be read/],
    ["whether the account bypasses unreadable", () => P.rule(7, REQUIRED_PR_CHECKS), () => P.ruleset({ current_user_can_bypass: undefined }), /couldn't be read/],
    ["evaluate mode", () => P.rule(7, REQUIRED_PR_CHECKS), () => P.ruleset({ enforcement: "evaluate" }), /isn't active/],
    ["its settings unreadable", () => P.rule(7, REQUIRED_PR_CHECKS), null, /ruleset 7: its settings couldn't be read/],
  ])("ruleset (no classic protection): %s doesn't hold", async (_name, rule, set, words) => {
    const answer = await read(P.exec({ classic: P.notProtected, rules: { code: 0, stdout: `${rule()}\n` }, ruleset: id => set === null ? { code: 1, stdout: "", stderr: "HTTP 403" } : P.json({ ...set(), id }) }));
    expect(answer?.effective).toBe(false);
    expect(answer?.missing.join("; ")).toMatch(words);
  });

  test("an active, strict, covering ruleset nobody merging can bypass holds; a deploy key's bypass doesn't matter", async () => {
    const answer = await read(P.exec({ classic: P.notProtected, rules: { code: 0, stdout: `${P.rule(9, PROTECTION_MINIMUM_CHECKS)}\n` },
      ruleset: () => P.json(P.ruleset({ bypass_actors: [{ actor_id: 3, actor_type: "DeployKey", bypass_mode: "always" }] })) }));
    expect(answer).toEqual({ effective: true, missing: [], notYetRequired: [...PROTECTION_REPORT_ONLY_CHECKS] });
  });

  test("no protection at all doesn't hold; nothing readable is null; a classic error never counts as unprotected", async () => {
    expect(await read(P.exec({ classic: P.notProtected }))).toEqual({ effective: false, missing: ["main has no branch protection or ruleset requiring status checks"], notYetRequired: [] });
    expect(await read(P.exec({ classic: { code: 1, stdout: "", stderr: "HTTP 403" }, rules: { code: 1, stdout: "", stderr: "HTTP 500" } }))).toBeNull();
    expect((await read(P.exec({ classic: { code: 1, stdout: "", stderr: "HTTP 403" } })))?.missing).toEqual(["classic protection couldn't be read"]);
    expect((await read(P.exec({ classic: { code: 0, stdout: "not json" } })))?.effective).toBe(false);
  });
});

describe("codex round 1 #4: a release filed while CI runs is approvable by nobody until the plane reads CI passing", () => {
  const notices = (f: ReleaseFixture) => f.store.handle.prepare("SELECT subject, body FROM notification WHERE kind = 'release-auto' ORDER BY id").all().map(row => `${String(row["subject"])}: ${String(row["body"])}`);
  test("the automatic road refuses with CI pending: no 'approve it yourself', and a person's, a chat's or a mode's yes is refused in words", () => {
    const f = open();
    holdApprovalForCi(f.store, { taskId: f.taskId, candidate: f.approved, now: RELEASE_NOW });
    // The automatic road refuses (as for unsandboxed checks without release terms): nobody is asked yet.
    giveUpAutoApproval(f.store, { taskId: f.taskId, why: "its checks run unsandboxed", now: LATER });
    expect(notices(f).join("\n")).not.toMatch(/Approve it yourself/);
    expect(notices(f)).toEqual([expect.stringContaining("you're asked to approve it once CI passes")]);
    // A person's typed password: refused, saying why, and nothing is sealed.
    const person = approve(f.store, f.taskId, "alex", LATER, digestOf(f), f.password);
    expect(person).toMatchObject({ ok: false, reason: "policy", message: expect.stringContaining(`GitHub CI is still running on ${f.approved.slice(0, 7)}`) });
    expect(basis(f)).toBeNull();
    expect(f.store.getScope(f.taskId)!.approvedBy ?? null).toBeNull();
    // The seal primitive itself: a chat card, a mode or a grant never seals it either.
    for (const kind of ["chat", "mode", "grant", "schedule"] as const) expect(f.store.sealScopeApproval(f.taskId, "alex", LATER, {}, { kind, modeDigest: "x" })).toBe(false);
    // The automatic road's check may still run beside CI.
    expect(authorize(f)).toMatchObject({ ok: true });
  });

  test("only the plane's reading of exact-head CI passing lifts it; then the person is asked and their yes seals", () => {
    const f = open();
    holdApprovalForCi(f.store, { taskId: f.taskId, candidate: f.approved, now: RELEASE_NOW });
    const pending: CiObservation = { ...green(f.approved), runs: green(f.approved).runs.map((run, i) => i === 0 ? { ...run, status: "in_progress", conclusion: null } : run) };
    for (const [ci, words] of [
      [pending, /hasn't finished/],
      [green("e".repeat(40)), /read for eeeeeee/],
      [{ ...green(f.approved), complete: false }, /can't be read whole/],
      [green(f.approved, new Date(LATER.getTime() - 3_600_000)), /isn't fresh/],
      [{ ...green(f.approved), runs: green(f.approved).runs.slice(1) }, /hasn't finished/],
    ] as const) {
      expect(liftCiHold(f.store, { taskId: f.taskId, candidate: f.approved, ci, ask: true, now: LATER })).toMatchObject({ ok: false, why: expect.stringMatching(words) });
      expect(approve(f.store, f.taskId, "alex", LATER, digestOf(f), f.password)).toMatchObject({ ok: false, reason: "policy" });
    }
    // A pass on another commit than the held one lifts nothing.
    expect(liftCiHold(f.store, { taskId: f.taskId, candidate: "e".repeat(40), ci: green("e".repeat(40)), ask: true, now: LATER })).toMatchObject({ ok: false });
    expect(notices(f).join("\n")).not.toMatch(/Approve it yourself/);
    expect(liftCiHold(f.store, { taskId: f.taskId, candidate: f.approved, ci: green(f.approved), ask: true, now: LATER })).toEqual({ ok: true });
    expect(notices(f).at(-1)).toMatch(/needs you: GitHub CI passed on .*Approve it yourself/);
    expect(approve(f.store, f.taskId, "alex", LATER, digestOf(f), f.password)).toMatchObject({ ok: true });
  });
});
