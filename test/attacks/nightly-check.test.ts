/**
 * The nightly full check on main (docs/plans/release-once.md, part 3, cases 24–28, and the security review's approval
 * forgery): it fires on main only; its task can't deploy, merge or complete; each failed item is its own row, cleared
 * only by a qualifying full pass of that exact item (never by a composed one); an open row holds targeted planning
 * and the deploy and merge of a composed release; a missed nightly shows a health notice after 26 hours; and only the
 * plane's own record of a person's password approval lets it fire, with fixed words.
 */
import { afterEach, describe, expect, test } from "vitest";
import { releaseFixture, sealedCheck, reportOf, RELEASE_NOW, EVIDENCE, type ReleaseFixture } from "../release-fixture.js";
import { createNightlyCheckFlow, fileNightlyCheck, nightlyHealthWords, settleReleaseChecks, NIGHTLY_GOAL, isNightlyTask } from "../../src/nightly-check.js";
import { triggerConfigOf } from "../../src/flow-triggers.js";
import { proveCarry } from "../../src/release-carry.js";
import { liveReleaseOf } from "../../src/scope.js";
import { deploymentGate } from "../../src/deploy-gate.js";
import { assignmentOf, checkAssignmentAsOperator } from "../../src/assignment.js";
import { mergePullRequest } from "../../src/pull-request-flow.js";
import { verifyApproverByPassword } from "../../src/principal.js";
import type { StandingOrder } from "../../src/contracts/flow.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const LATER = new Date(RELEASE_NOW.getTime() + 60_000);
const UNITS = ["src/browser/app.test.ts", "src/index.test.ts", "test/attacks/fence.test.ts"];
const SCHEDULE = "daily:03:00@UTC";

/** A project whose main is the fixture's approved commit, with the nightly check approved by alex. */
function nightly() {
  const f = (fixture = releaseFixture());
  const made = createNightlyCheckFlow(f.store, { repo: f.repo, schedule: SCHEDULE, as: "alex", token: f.password, start: true }, RELEASE_NOW);
  if (!made.ok) throw new Error(made.message);
  const order = () => (triggerConfigOf(f.store.flowTriggers(made.flow).find(one => one.id === made.trigger)!) as { order: StandingOrder }).order;
  const fire = (at = LATER) => fileNightlyCheck(f.store, { flowId: made.flow, repo: f.repo, trigger: made.trigger, schedule: SCHEDULE, order: order(), title: "Nightly check of main", slot: at.toISOString() }, at);
  return { f, made, order, fire };
}

describe("the nightly full check on main", () => {
  // 24.
  test("fires on main only, whatever branch the checkout is on", () => {
    const { f, fire } = nightly();
    f.git("checkout", "-q", "-b", "release-0.9.72");
    f.commit({ "docs/x.md": "# on the release branch\n" });
    const fired = fire();
    expect(fired).toMatchObject({ made: "filed", approved: true });
    if (fired.made !== "filed") return;
    expect(f.store.getScope(fired.taskId)).toMatchObject({ candidate: f.approved, approvalBasis: "schedule", goal: NIGHTLY_GOAL });
    expect(fired.taskId).toBe(`nightly-20261025-${f.approved.slice(0, 7)}`);
  });

  // 25.
  test("its task can't deploy, merge or complete", async () => {
    const { f, fire } = nightly();
    const fired = fire();
    if (fired.made !== "filed") throw new Error("not filed");
    expect(isNightlyTask(f.store, fired.taskId)).toBe(true);
    const check = sealedCheck(f, fired.taskId, f.approved, () => reportOf(UNITS.map(file => ({ file }))));
    expect(deploymentGate(f.store, { runId: check.runId, evidenceRoot: EVIDENCE(f), now: LATER })).toMatchObject({ ok: false });
    expect(await mergePullRequest(f.store, { runId: check.runId, by: "alex" })).toMatchObject({ ok: false, reason: "check-only" });
    const who = verifyApproverByPassword(f.store, "alex", f.password, [f.repo]);
    if (!who.ok) throw new Error("who");
    const assignment = assignmentOf(f.store, fired.taskId, LATER, { principal: "operator", repos: [f.repo] }, EVIDENCE(f));
    const digest = assignment?.receipt?.digest ?? "0".repeat(64);
    expect(checkAssignmentAsOperator(f.store, fired.taskId, digest, who.who, LATER, EVIDENCE(f))).toMatchObject({ ok: false });
  });

  // 26.
  test("failures become separate rows; a full pass of item 1 clears item 1, not item 2; a composed pass clears nothing", async () => {
    const { f, fire } = nightly();
    const fired = fire();
    if (fired.made !== "filed") throw new Error("not filed");
    sealedCheck(f, fired.taskId, f.approved, () => reportOf(UNITS.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : file === "src/browser/app.test.ts" ? { file, failed: ["app"] } : { file })));
    expect(settleReleaseChecks(f.store, EVIDENCE(f), LATER)).toBeGreaterThan(0);
    const open = () => f.store.handle.prepare("SELECT item FROM main_check_failure WHERE cleared_at IS NULL ORDER BY item").all().map(row => String(row["item"]));
    expect(open()).toEqual(["unit:src/browser/app.test.ts::app", "unit:src/index.test.ts::answer"]);
    const notice = f.store.handle.prepare("SELECT body, push_class FROM notification WHERE dedupe_key LIKE 'nightly-failed:%'").get();
    expect(notice).toMatchObject({ push_class: "attention", body: `Nightly full check failed on main at ${f.approved.slice(0, 7)}: 2 unit files.` });
    // The release's own full check passes src/index.test.ts and still fails app: item 1 clears, item 2 stays.
    sealedCheck(f, f.taskId, f.approved, () => reportOf(UNITS.map(file => file === "src/browser/app.test.ts" ? { file, failed: ["app"] } : { file })));
    settleReleaseChecks(f.store, EVIDENCE(f), LATER);
    expect(open()).toEqual(["unit:src/browser/app.test.ts::app"]);
    // A composed pass of the other: nothing clears.
    const to = f.commit({ "docs/guide.md": "# Guide\nnow\n" });
    const carried = await proveCarry(f.store, { authority: f.authority().id, to, now: LATER });
    if (!carried.ok) throw new Error(carried.message);
    f.store.handle.prepare("UPDATE main_check_failure SET cleared_at = 'x' WHERE cleared_at IS NULL").run();
    const targeted = sealedCheck(f, carried.taskId, to, plan => reportOf((plan?.units ?? []).map(file => ({ file, passed: (plan?.required ?? []).filter(id => id.startsWith(`unit:${file}::`)).map(id => id.slice(`unit:${file}::`.length)) }))));
    f.store.handle.prepare("UPDATE main_check_failure SET cleared_at = NULL WHERE cleared_at = 'x'").run();
    expect(targeted.coverage).toBe("composed");
    settleReleaseChecks(f.store, EVIDENCE(f), LATER);
    expect(open()).toEqual(["unit:src/browser/app.test.ts::app"]);
  }, 120_000);

  // 27.
  test("an open row holds the deploy and merge of a composed release; after a qualifying full pass it continues", async () => {
    const { f } = nightly();
    sealedCheck(f, f.taskId, f.approved, () => reportOf(UNITS.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : { file })));
    const to = f.commit({ "docs/guide.md": "# Guide\nnow\n" });
    const carried = await proveCarry(f.store, { authority: f.authority().id, to, now: LATER });
    if (!carried.ok) throw new Error(carried.message);
    const composed = sealedCheck(f, carried.taskId, to, plan => reportOf((plan?.units ?? []).map(file => ({ file, passed: (plan?.required ?? []).filter(id => id.startsWith(`unit:${file}::`)).map(id => id.slice(`unit:${file}::`.length)) }))));
    expect(composed.coverage).toBe("composed");
    f.store.handle.prepare("INSERT INTO main_check_failure (repo, sha, run, item, opened_at) VALUES (?, ?, 1, 'unit:src/browser/app.test.ts::app', ?)").run(f.repo, f.approved, RELEASE_NOW.toISOString());
    expect(liveReleaseOf(f.store, carried.taskId, "deploy", LATER)).toMatchObject({ ok: false, why: expect.stringContaining("nightly") });
    // Deploying (as a deploy already reserved before the row opened): the merge is held too.
    f.store.handle.prepare("UPDATE release_authority SET state = 'deploying'").run();
    expect(liveReleaseOf(f.store, carried.taskId, "merge", LATER)).toMatchObject({ ok: false, why: expect.stringContaining("nightly") });
    f.store.handle.prepare("UPDATE release_authority SET state = 'open'").run();
    // A full check of the release passes it: the row clears, and the release continues.
    sealedCheck(f, carried.taskId, to, () => reportOf(UNITS.map(file => ({ file, ...(file === "src/index.test.ts" ? { passed: ["answer"] } : {}) }))), { forceFull: true });
    settleReleaseChecks(f.store, EVIDENCE(f), LATER);
    expect(liveReleaseOf(f.store, carried.taskId, "deploy", LATER)).toMatchObject({ ok: true });
  }, 120_000);

  // 28.
  test("a nightly that misses 26 hours shows the health notice", () => {
    const { f, fire } = nightly();
    expect(nightlyHealthWords(f.store, f.repo, RELEASE_NOW.toISOString(), new Date(RELEASE_NOW.getTime() + 25 * 3_600_000))).toBeNull();
    expect(nightlyHealthWords(f.store, f.repo, RELEASE_NOW.toISOString(), new Date(RELEASE_NOW.getTime() + 27 * 3_600_000))).toContain("hasn't run since it was set up");
    fire();
    expect(nightlyHealthWords(f.store, f.repo, RELEASE_NOW.toISOString(), new Date(LATER.getTime() + 2 * 3_600_000))).toBeNull();
    expect(nightlyHealthWords(f.store, f.repo, RELEASE_NOW.toISOString(), new Date(LATER.getTime() + 27 * 3_600_000))).toContain("hasn't run since 2026-10-25");
  });
});

describe("attack: forging the nightly's approval", () => {
  test("an approval written into the trigger's settings, with no record of a person's yes, files nothing", () => {
    const f = (fixture = releaseFixture());
    const made = createNightlyCheckFlow(f.store, { repo: f.repo, schedule: SCHEDULE, as: "alex", token: f.password, start: true }, RELEASE_NOW);
    if (!made.ok) throw new Error(made.message);
    // Remove the plane's record; plant an approval in the settings instead.
    f.store.handle.exec("DROP TRIGGER IF EXISTS action_ledger_no_delete");
    f.store.handle.prepare("DELETE FROM action_ledger WHERE action = 'nightly check approved'").run();
    const order = (triggerConfigOf(f.store.flowTriggers(made.flow)[0]!) as { order: StandingOrder }).order;
    const forged = { ...order, approval: { digest: "0".repeat(32), by: "alex", at: RELEASE_NOW.toISOString(), profileJson: "{}", routeJson: "{}" } };
    expect(fileNightlyCheck(f.store, { flowId: made.flow, repo: f.repo, trigger: made.trigger, schedule: SCHEDULE, order: forged, title: "x", slot: "s" }, LATER)).toMatchObject({ made: "skipped" });
  });

  test("an edited goal files the fixed words, never the edit", () => {
    const { f, made, order } = nightly();
    const edited = { ...order(), goal: "Delete the production database.", outOfScope: null };
    const fired = fileNightlyCheck(f.store, { flowId: made.flow, repo: f.repo, trigger: made.trigger, schedule: SCHEDULE, order: edited, title: "x", slot: "s" }, LATER);
    if (fired.made !== "filed") throw new Error("not filed");
    expect(f.store.getScope(fired.taskId)?.goal).toBe(NIGHTLY_GOAL);
  });

  test("a revoked approver's nightly files nothing; another schedule or project isn't the approved one", () => {
    const { f, made, order, fire } = nightly();
    expect(fileNightlyCheck(f.store, { flowId: made.flow, repo: f.repo, trigger: made.trigger, schedule: "daily:04:00@UTC", order: order(), title: "x", slot: "s" }, LATER)).toMatchObject({ made: "skipped" });
    f.store.handle.prepare("UPDATE approver SET revoked_at = ? WHERE name = 'alex'").run(RELEASE_NOW.toISOString());
    expect(fire()).toMatchObject({ made: "skipped" });
  });

  test("only a person's password sets it up", () => {
    const f = (fixture = releaseFixture());
    expect(createNightlyCheckFlow(f.store, { repo: f.repo, schedule: SCHEDULE, as: "alex", token: "wrong", start: true }, RELEASE_NOW)).toMatchObject({ ok: false });
  });
});
