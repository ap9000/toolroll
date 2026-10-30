/**
 * GitHub's nightly lane debt holds every boundary (docs/plans/evals-nightly.md, part A2), in a real plane database over
 * a real repository: every deploy of the project (a release's, and a person-approved task's that no release authority
 * covers), the merge inside its reservation transaction and at its start, and the pre-tag step — unless this exact
 * candidate holds a fresh exemption. What `toolroll release nightly --github` tells the person is what the gates do.
 */
import { afterEach, describe, expect, test } from "vitest";
import { builtRun, EVIDENCE, FIXTURE_PASSWORD, releaseFixture, RELEASE_NOW, type ReleaseFixture } from "../release-fixture.js";
import { deploymentGate } from "../../src/deploy-gate.js";
import { deploymentCandidate } from "../../scripts/deploy-candidate.mjs";
import * as installedNightly from "../../src/nightly-github.js";
import { laneIdOf, nightlyBoundary, seedLanes } from "../../src/nightly-github.js";
import { runReleaseCommand } from "../../src/release-cli.js";
import { approve, propose } from "../../src/scope.js";
import { finishReleaseOperation, reserveRelease, runReleaseOperation, takeReleaseLease } from "../../src/store.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const UBUNTU = laneIdOf(".github/workflows/ci.yml", "node 24 · ubuntu-latest");
const NOW = new Date(RELEASE_NOW.getTime() + 60_000);

/** A release fixture whose project is on GitHub, opted in through the CLI as alex; returns what the CLI said. */
async function optedIn(): Promise<{ f: ReleaseFixture; said: string }> {
  const f = (fixture = releaseFixture());
  f.store.upsertProject(f.repo, "project", RELEASE_NOW, { remoteUrl: "https://github.com/acme/app.git" });
  const lines: string[] = [];
  expect(await runReleaseCommand(["nightly", "--github", "--repo", f.repo, "--as", "alex", "--token", FIXTURE_PASSWORD], line => lines.push(line), { database: f.databaseFile, now: () => RELEASE_NOW })).toBe(0);
  return { f, said: lines.join("\n") };
}
/** An open ubuntu lane failure on main, as the reader records one. */
function openFailure(f: ReleaseFixture): number {
  seedLanes(f.store, f.repo, RELEASE_NOW);
  return Number(f.store.handle.prepare(`INSERT INTO nightly_lane_failure (repo, lane_id, gh_run, attempt, job_id, sha, completed_at, opened_at) VALUES (?, ?, 7, 1, 70, ?, ?, ?)`)
    .run(f.repo, UBUNTU, f.base, RELEASE_NOW.toISOString(), RELEASE_NOW.toISOString()).lastInsertRowid);
}
const exempt = (f: ReleaseFixture, failure: number, at = NOW) => f.store.handle.prepare(`INSERT INTO nightly_exemption (task, candidate, failure_id, pr, gh_run, attempt, job_id, started_at, completed_at, read_at)
  VALUES (?, ?, ?, 240, 900, 1, 9000, ?, ?, ?)`).run(f.taskId, f.approved, failure, at.toISOString(), at.toISOString(), at.toISOString());

describe("what the opt-in says is what the gates do", () => {
  test("the words name deploys, merges and tags, and each of those is held", async () => {
    const { f, said } = await optedIn();
    expect(said).toMatch(/holds this project's deploys, release merges and tags while a lane fails/);
    openFailure(f);
    // Every deploy: the release's own candidate…
    const run = builtRun(f.store, f.taskId, f.approved);
    expect(deploymentGate(f.store, { runId: run, evidenceRoot: EVIDENCE(f), now: NOW, releaseFlow: true })).toEqual({ ok: false,
      message: expect.stringMatching(/^GitHub's nightly failed "node 24 · ubuntu-latest" on main at [0-9a-f]{7} \(Oct 25, 12:00 UTC\)\. This release can't deploy until that lane passes again: re-run this release's CI, or wait for tonight's nightly\.$/) });
    // …the merge, inside its reservation…
    const lease = takeReleaseLease(f.store, f.authority().id, "coordinator", NOW, 60 * 60_000);
    if (!lease.ok) throw new Error(lease.why);
    expect(reserveRelease(f.store, { authority: f.authority().id, kind: "deploy", taskId: f.taskId, candidate: f.approved, epoch: lease.epoch, operationId: "d1", now: NOW })).toMatchObject({ ok: false, why: expect.stringContaining("can't deploy") });
    // …and the tag, even with GitHub unreadable.
    const offline = { gh: async () => ({ ok: false as const, why: "offline" }), now: () => NOW, onMain: () => "unknown" as const, mainContains: () => false };
    expect(await nightlyBoundary(f.store, { repo: f.repo, taskId: f.taskId, candidate: f.approved, pr: 240, phase: "tag" }, offline)).toMatchObject({ ok: false, why: expect.stringContaining("can't be tagged or published") });
  });
});

describe("every deploy entry point", () => {
  test("a person-approved deploy no release covers is held, in this runtime and through the installed runtime's script", async () => {
    const { f } = await optedIn();
    const task = "plain-1";
    f.store.createTask({ id: task, title: "a plain task" }, RELEASE_NOW);
    f.store.placeTask(f.store.refFor("built-in", task).id, f.repo, {}, RELEASE_NOW);
    const scope = propose(f.store, { taskId: task, goal: "Change the answer", candidate: f.approved, acceptance: [{ id: "c1", statement: "It works", how: null, evidence: ["check"] }], now: RELEASE_NOW });
    const yes = approve(f.store, task, "alex", RELEASE_NOW, scope.digest, f.password);
    if (!yes.ok) throw new Error(yes.reason);
    const run = builtRun(f.store, task, f.approved);
    // Nothing open: it gets past the nightly rule (and stops later, for its missing check).
    expect(deploymentGate(f.store, { runId: run, evidenceRoot: EVIDENCE(f), now: NOW })).toMatchObject({ ok: false, message: expect.not.stringContaining("nightly") });
    openFailure(f);
    expect(deploymentGate(f.store, { runId: run, evidenceRoot: EVIDENCE(f), now: NOW })).toMatchObject({ ok: false, message: expect.stringContaining("This candidate can't deploy until that lane passes again") });
    const deps = { assignmentOf: () => null, verificationEvidence: () => ({ ok: false, problem: "none" }) };
    for (const nightly of [{ installedNightly }, {}]) {
      expect(() => deploymentCandidate(f.store, { runId: run, head: f.approved, evidenceRoot: EVIDENCE(f), now: NOW }, { ...deps, ...nightly }), Object.keys(nightly).join()).toThrow(/GitHub's nightly/);
    }
  });
});

describe("the merge, inside its reservation transaction", () => {
  test("held at the reservation and at its start; a fresh exemption for this exact candidate lets it through", async () => {
    const { f } = await optedIn();
    const id = f.authority().id;
    const lease = takeReleaseLease(f.store, id, "coordinator", NOW, 60 * 60_000);
    if (!lease.ok) throw new Error(lease.why);
    expect(reserveRelease(f.store, { authority: id, kind: "deploy", taskId: f.taskId, candidate: f.approved, epoch: lease.epoch, operationId: "d1", now: NOW }).ok).toBe(true);
    expect(runReleaseOperation(f.store, "d1", lease.epoch, NOW)).toBe(true);
    finishReleaseOperation(f.store, "d1", "succeeded", {}, NOW, lease.epoch);
    const failure = openFailure(f);
    expect(reserveRelease(f.store, { authority: id, kind: "merge", taskId: f.taskId, candidate: f.approved, epoch: lease.epoch, operationId: "m1", now: NOW })).toMatchObject({ ok: false,
      why: expect.stringContaining("This release can't merge until that lane passes again") });
    // An exemption read 11 minutes ago no longer stands; one read now does.
    exempt(f, failure, new Date(NOW.getTime() - 11 * 60_000));
    expect(reserveRelease(f.store, { authority: id, kind: "merge", taskId: f.taskId, candidate: f.approved, epoch: lease.epoch, operationId: "m1", now: NOW }).ok).toBe(false);
    f.store.handle.prepare("UPDATE nightly_exemption SET read_at = ?").run(NOW.toISOString());
    expect(reserveRelease(f.store, { authority: id, kind: "merge", taskId: f.taskId, candidate: f.approved, epoch: lease.epoch, operationId: "m1", now: NOW }).ok).toBe(true);
    // Debt that stands again between the reservation and the start: the merge never starts.
    f.store.handle.prepare("DELETE FROM nightly_exemption").run();
    expect(runReleaseOperation(f.store, "m1", lease.epoch, NOW)).toBe(false);
  });
});
