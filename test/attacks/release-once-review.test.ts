/**
 * Codex implementation review, round 1 (docs/plans/release-once.md): each finding replayed against the real guard.
 * Every test here failed before its fix.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { releaseFixture, sealedCheck, reportOf, builtRun, RELEASE_NOW, EVIDENCE, type ReleaseFixture } from "../release-fixture.js";
import { proveCarry } from "../../src/release-carry.js";
import { coverageOf, requiredSet, owedIdentities } from "../../src/release-recheck.js";
import {
  finishReleaseOperation, releaseOperations, reserveRelease, revokeRelease, runReleaseOperation, takeReleaseLease, recordTrustedMain, requireFreshReleaseApproval,
} from "../../src/store.js";
import { mergePullRequest } from "../../src/pull-request-flow.js";
import { fullCheckGate } from "../../src/result-follow-ups.js";
import { recordRunCheckLevel } from "../../src/check-levels.js";
import { createNightlyCheckFlow, fileNightlyCheck, settleReleaseChecks } from "../../src/nightly-check.js";
import { triggerConfigOf } from "../../src/flow-triggers.js";
import { approve, propose } from "../../src/scope.js";
import type { CheckReport } from "../../src/contracts/release-check.js";
import type { StandingOrder } from "../../src/contracts/flow.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const LATER = new Date(RELEASE_NOW.getTime() + 60_000);
const UNITS = ["src/browser/app.test.ts", "src/index.test.ts", "test/attacks/fence.test.ts"];

describe("finding 1: reservations and starts revalidate the live release, inside their transactions", () => {
  test.each([
    ["the approver lost access", (f: ReleaseFixture) => { f.store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'alex'").run(); }],
    ["the grant changed", (f: ReleaseFixture) => { f.store.setVerifyCommand({ repo: f.repo, command: "node other.mjs", timeoutMs: 60_000, approvedBy: "alex" }, RELEASE_NOW); }],
    ["main-check debt opened for a composed check", (f: ReleaseFixture) => {
      f.store.handle.prepare("INSERT INTO release_check_attempt (run, authority, mode, inventory_digest, context_digest, nonce_hash, created_at) VALUES (?, ?, 'targeted', 'i', 'c', 'n', ?)")
        .run(builtRun(f.store, f.taskId, f.approved), f.authority().id, RELEASE_NOW.toISOString());
      f.store.handle.prepare("INSERT INTO main_check_failure (repo, sha, run, item, opened_at) VALUES (?, ?, 1, 'part:unit', ?)").run(f.repo, f.approved, RELEASE_NOW.toISOString());
    }],
  ])("a reservation refuses when %s", (_name, spoil) => {
    const f = (fixture = releaseFixture());
    spoil(f);
    expect(reserveRelease(f.store, { authority: f.authority().id, kind: "deploy", taskId: f.taskId, candidate: f.approved, epoch: null, operationId: "d1", now: LATER })).toMatchObject({ ok: false });
  });

  test("a reserved operation can't start after the release was revoked, or after its lease expired", () => {
    const f = (fixture = releaseFixture());
    const id = f.authority().id;
    const lease = takeReleaseLease(f.store, id, "c1", RELEASE_NOW, 60_000);
    if (!lease.ok) throw new Error(lease.why);
    expect(reserveRelease(f.store, { authority: id, kind: "deploy", taskId: f.taskId, candidate: f.approved, epoch: lease.epoch, operationId: "d1", now: RELEASE_NOW }).ok).toBe(true);
    revokeRelease(f.store, id, "alex", RELEASE_NOW);
    expect(runReleaseOperation(f.store, "d1", lease.epoch, RELEASE_NOW)).toBe(false);
    fixture.close();
    const g = (fixture = releaseFixture());
    const gid = g.authority().id;
    const glease = takeReleaseLease(g.store, gid, "c1", RELEASE_NOW, 60_000);
    if (!glease.ok) throw new Error(glease.why);
    expect(reserveRelease(g.store, { authority: gid, kind: "deploy", taskId: g.taskId, candidate: g.approved, epoch: glease.epoch, operationId: "d1", now: RELEASE_NOW }).ok).toBe(true);
    expect(runReleaseOperation(g.store, "d1", glease.epoch, new Date(RELEASE_NOW.getTime() + 120_000))).toBe(false);
  });
});

describe("finding 2: release tasks merge only through the release", () => {
  test("the ordinary pull-request merge refuses a release task", async () => {
    const f = (fixture = releaseFixture());
    const run = builtRun(f.store, f.taskId, f.approved);
    expect(await mergePullRequest(f.store, { runId: run, by: "alex" })).toMatchObject({ ok: false, reason: "release" });
  });

  test("fullCheckGate doesn't take a recorded Full level for a pass: a failed or targeted check isn't clear", () => {
    const f = (fixture = releaseFixture());
    const run = builtRun(f.store, f.taskId, f.approved);
    recordRunCheckLevel(f.store, { id: run, taskId: f.taskId, repo: f.repo }, "full", "project", RELEASE_NOW);
    f.store.recordRunCheck(run, { status: "failed", exitCode: 1, suites: [] }, RELEASE_NOW);
    expect(fullCheckGate(f.store, run, LATER).state).not.toBe("clear");
  });
});

describe("finding 3: operations are fenced by the epoch that holds the lease", () => {
  test("settling an operation needs the current epoch: a stale coordinator can't settle another's", () => {
    const f = (fixture = releaseFixture());
    const id = f.authority().id;
    const one = takeReleaseLease(f.store, id, "c1", RELEASE_NOW, 60_000);
    if (!one.ok) throw new Error(one.why);
    reserveRelease(f.store, { authority: id, kind: "deploy", taskId: f.taskId, candidate: f.approved, epoch: one.epoch, operationId: "d1", now: RELEASE_NOW });
    runReleaseOperation(f.store, "d1", one.epoch, RELEASE_NOW);
    const two = takeReleaseLease(f.store, id, "c2", new Date(RELEASE_NOW.getTime() + 120_000), 60_000);
    if (!two.ok) throw new Error(two.why);
    expect(finishReleaseOperation(f.store, "d1", "succeeded", {}, new Date(RELEASE_NOW.getTime() + 130_000), one.epoch)).toBe(false);
    expect(releaseOperations(f.store, id)[0]?.state).toBe("running");
    expect(finishReleaseOperation(f.store, "d1", "failed", { detail: "reconciled" }, new Date(RELEASE_NOW.getTime() + 130_000), two.epoch)).toBe(true);
  });
});

describe("finding 5: the nightly reads main only from the plane's trusted read of the recorded remote", () => {
  const nightly = () => {
    const f = (fixture = releaseFixture());
    const made = createNightlyCheckFlow(f.store, { repo: f.repo, schedule: "daily:03:00@UTC", as: "alex", token: f.password, start: true }, RELEASE_NOW);
    if (!made.ok) throw new Error(made.message);
    const order = (triggerConfigOf(f.store.flowTriggers(made.flow)[0]!) as { order: StandingOrder }).order;
    return { f, fire: () => fileNightlyCheck(f.store, { flowId: made.flow, repo: f.repo, trigger: made.trigger, schedule: "daily:03:00@UTC", order, title: "x", slot: "s" }, LATER) };
  };
  test("a planted origin/main is never what the nightly checks; with no trusted read it files nothing", () => {
    const { f, fire } = nightly();
    const planted = f.commit({ "docs/planted.md": "# planted\n" });
    f.git("update-ref", "refs/remotes/origin/main", planted);
    expect(fire()).toMatchObject({ made: "skipped" });
    recordTrustedMain(f.store, f.repo, f.approved, "https://example.invalid/r.git", RELEASE_NOW);
    const fired = fire();
    expect(fired).toMatchObject({ made: "filed" });
    if (fired.made === "filed") expect(f.store.getScope(fired.taskId)?.candidate).toBe(f.approved);
  });

  test("debt clearing reads main from the trusted read, not a ref a build can move", () => {
    const { f } = nightly();
    f.store.handle.prepare("INSERT INTO main_check_failure (repo, sha, run, item, opened_at) VALUES (?, ?, 1, 'unit:src/index.test.ts::answer', ?)").run(f.repo, f.approved, RELEASE_NOW.toISOString());
    recordTrustedMain(f.store, f.repo, f.approved, "https://example.invalid/r.git", RELEASE_NOW);
    f.git("checkout", "-q", "-b", "side");
    const side = f.commit({ "docs/side.md": "# side\n" });
    // A build moves both main refs to its side commit.
    f.git("update-ref", "refs/heads/main", side);
    f.git("update-ref", "refs/remotes/origin/main", side);
    const id = `side-${side.slice(0, 7)}`;
    f.store.createTask({ id, title: id }, LATER);
    f.store.placeTask(f.store.refFor("built-in", id).id, f.repo, {}, LATER);
    const scope = propose(f.store, { taskId: id, goal: "side", candidate: side, acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], now: LATER });
    approve(f.store, id, "alex", LATER, scope.digest, f.password);
    sealedCheck(f, id, side, () => reportOf(UNITS.map(file => ({ file, ...(file === "src/index.test.ts" ? { passed: ["answer"] } : {}) }))));
    settleReleaseChecks(f.store, EVIDENCE(f), LATER);
    expect(f.store.handle.prepare("SELECT cleared_at FROM main_check_failure").get()?.["cleared_at"]).toBeNull();
  });
});

describe("finding 6: an owed whole part must run whole, and finish, before a check is composed", () => {
  const sealedA = (report: ReturnType<typeof reportOf>) => ({ ...report, nonce: "a".repeat(64), mode: "full", planDigest: null } as CheckReport);
  const inventory = { version: 1 as const, sealed: { version: 1 as const, units: UNITS, parts: [] }, declared: { groups: [], versions: [] } };
  test("owed app and upgrade parts that never ran leave the result partial", () => {
    const parts = reportOf([]).parts.map(one => one.part === "app" || one.part === "upgrade" ? { ...one, selected: true, ran: false, code: null } : one);
    const a = sealedA(reportOf(UNITS.map(file => ({ file })), { parts }));
    const owed = requiredSet({ report: a, inventory });
    expect(owed.parts).toEqual(["app", "upgrade"]);
    const plan = { version: 1 as const, base: 1, units: [], sanity: [], groups: [], versions: [], parts: owed.parts, required: owed.required };
    const b = { ...reportOf(UNITS.map(file => ({ file }))), nonce: "b".repeat(64), mode: "targeted" as const, planDigest: (require("node:crypto") as typeof import("node:crypto")).createHash("sha256").update(JSON.stringify(plan)).digest("hex") } as CheckReport;
    expect(coverageOf({ a: { report: a, inventory }, b: { report: b, inventory, exitCode: 0 }, plan, snapshot: { version: 1, authority: 1, base: 1, earlier: [] } })).toBe("partial");
  });

  test("a whole-upgrade retry keeps the full selection", async () => {
    const { readFileSync } = await import("node:fs");
    const script = readFileSync(join(import.meta.dirname, "../../scripts/release-check.mjs"), "utf8");
    expect(script).toMatch(/targeted\.parts\.includes\("upgrade"\) \? \["--full"\]/);
  });
});

describe("finding 7: required identities survive a full fallback", () => {
  test("A fails the typecheck and test X: X stays owed, and a full check that drops X asks again", async () => {
    const f = (fixture = releaseFixture());
    const parts = reportOf([]).parts.map(one => one.part === "typecheck" ? { ...one, code: 2 } : one);
    sealedCheck(f, f.taskId, f.approved, () => reportOf(UNITS.map(file => file === "src/index.test.ts" ? { file, failed: ["answer"] } : { file }), { parts }));
    expect(owedIdentities(f.store, EVIDENCE(f), f.authority().id, Number.MAX_SAFE_INTEGER)).toContain("unit:src/index.test.ts::answer");
    const to = f.commit({ "docs/guide.md": "# Guide\nfixed\n" });
    const carried = await proveCarry(f.store, { authority: f.authority().id, to, now: LATER });
    if (!carried.ok) throw new Error(carried.message);
    const next = sealedCheck(f, carried.taskId, to, () => reportOf(UNITS.map(file => ({ file }))));
    expect(next.decision).toMatchObject({ mode: "full", watch: expect.arrayContaining(["unit:src/index.test.ts::answer"]) });
    expect(next.coverage).toBe("identity-removed");
  }, 120_000);
});

describe("finding 8: only a successful full check clears debt", () => {
  test("a failed full check clears nothing, even items it reports passed by name", () => {
    const f = (fixture = releaseFixture());
    recordTrustedMain(f.store, f.repo, f.approved, "https://example.invalid/r.git", RELEASE_NOW);
    f.store.handle.prepare("INSERT INTO main_check_failure (repo, sha, run, item, opened_at) VALUES (?, ?, 1, 'unit:src/index.test.ts::answer', ?)").run(f.repo, f.approved, RELEASE_NOW.toISOString());
    sealedCheck(f, f.taskId, f.approved, () => reportOf(UNITS.map(file => file === "src/browser/app.test.ts" ? { file, failed: ["app"] } : file === "src/index.test.ts" ? { file, passed: ["answer"] } : { file })));
    settleReleaseChecks(f.store, EVIDENCE(f), LATER);
    expect(f.store.handle.prepare("SELECT cleared_at FROM main_check_failure").get()?.["cleared_at"]).toBeNull();
  });
});

export { writeFileSync };

describe("security review of f7912c15: every merge road refuses a release task", () => {
  /** A release task's run with a publication planted under it, as a merge road would see it. */
  const planted = (f: ReleaseFixture) => {
    const run = builtRun(f.store, f.taskId, f.approved);
    const ref = f.store.refFor("built-in", f.taskId).id;
    f.store.handle.prepare("INSERT INTO publication (run, task_ref, github_repo, remote, base, head, head_sha, body_hash, draft, state, created_at, updated_at) VALUES (?, ?, 'o/r', 'origin', 'main', 'b', ?, 'h', 0, 'intended', ?, ?)")
      .run(run, ref, f.approved, LATER.toISOString(), LATER.toISOString());
    const publication = Number(f.store.handle.prepare("SELECT id FROM publication WHERE run = ?").get(run)!["id"]);
    return { run, publication };
  };

  test("no merge intent can be made for it", () => {
    const f = (fixture = releaseFixture());
    const { publication } = planted(f);
    expect(() => f.store.createMergeIntent({ publication, repo: f.repo, grantTermsHash: "g", headSha: f.approved, method: "squash", deleteBranch: false }, LATER)).toThrow("toolroll release");
  });

  test("a planted, claimed merge intent is refused at firing and settled as refused", () => {
    const f = (fixture = releaseFixture());
    const { publication } = planted(f);
    f.store.handle.prepare("INSERT INTO merge_intent (publication, grant_terms_hash, head_sha, method, state, claimed_by, claimed_until, generation, created_at) VALUES (?, 'g', ?, 'squash', 'claimed', 'w', ?, 1, ?)").run(publication, f.approved, LATER.toISOString(), LATER.toISOString());
    const intent = Number(f.store.handle.prepare("SELECT id FROM merge_intent WHERE publication = ?").get(publication)!["id"]);
    expect(f.store.fireMergeIntent(intent, 1, { repo: f.repo, headSha: f.approved, liveGrantTermsHash: "g", graceMs: 0 }, LATER)).toMatchObject({ ok: false, why: expect.stringContaining("toolroll release") });
    expect(f.store.handle.prepare("SELECT state FROM merge_intent WHERE id = ?").get(intent)?.["state"]).toBe("refused");
  });

  test("the chat merge refuses it", async () => {
    const f = (fixture = releaseFixture());
    const { run } = planted(f);
    const { mergeInChat } = await import("../../src/chat-decide.js");
    expect(mergeInChat(f.store, f.taskId, run, "alex", LATER, "telegram" as never)).toMatchObject({ ok: false, why: expect.stringContaining("toolroll release") });
  });

  test("a carried release task is refused the same way", async () => {
    const f = (fixture = releaseFixture());
    const to = f.commit({ "docs/guide.md": "# Guide\nnow\n" });
    const carried = await proveCarry(f.store, { authority: f.authority().id, to, now: LATER });
    if (!carried.ok) throw new Error(carried.message);
    const run = builtRun(f.store, carried.taskId, to);
    const ref = f.store.refFor("built-in", carried.taskId).id;
    f.store.handle.prepare("INSERT INTO publication (run, task_ref, github_repo, remote, base, head, head_sha, body_hash, draft, state, created_at, updated_at) VALUES (?, ?, 'o/r', 'origin', 'main', 'b', ?, 'h', 0, 'intended', ?, ?)")
      .run(run, ref, to, LATER.toISOString(), LATER.toISOString());
    const publication = Number(f.store.handle.prepare("SELECT id FROM publication WHERE run = ?").get(run)!["id"]);
    expect(() => f.store.createMergeIntent({ publication, repo: f.repo, grantTermsHash: "g", headSha: to, method: "squash", deleteBranch: false }, LATER)).toThrow("toolroll release");
  }, 120_000);
});

describe("security review of f7912c15: a missing check is never a pass", () => {
  test("a Full build with no check row of its own isn't clear", () => {
    const f = (fixture = releaseFixture());
    const run = builtRun(f.store, f.taskId, f.approved);
    recordRunCheckLevel(f.store, { id: run, taskId: f.taskId, repo: f.repo }, "full", "project", RELEASE_NOW);
    f.store.handle.prepare("DELETE FROM run_check WHERE run = ?").run(run);
    expect(fullCheckGate(f.store, run, LATER).state).not.toBe("clear");
  });
});

describe("security review of f7912c15: the fresh-approval stop reports whether it took", () => {
  test("a stale epoch leaves the release standing and says so; the holder's epoch revokes it", () => {
    const f = (fixture = releaseFixture());
    const id = f.authority().id;
    const one = takeReleaseLease(f.store, id, "c1", RELEASE_NOW, 60_000);
    if (!one.ok) throw new Error(one.why);
    const two = takeReleaseLease(f.store, id, "c2", new Date(RELEASE_NOW.getTime() + 120_000), 60_000);
    if (!two.ok) throw new Error(two.why);
    const at = new Date(RELEASE_NOW.getTime() + 130_000);
    expect(requireFreshReleaseApproval(f.store, id, "ci failed", one.epoch, at)).toBe(false);
    expect(f.authority().state).toBe("open");
    expect(requireFreshReleaseApproval(f.store, id, "ci failed", two.epoch, at)).toBe(true);
    expect(f.authority().state).toBe("revoked");
  });
});

describe("security review of b788181a: one release publication can't stop the merge sweep", () => {
  test("no publication can be made for a release task", () => {
    const f = (fixture = releaseFixture());
    const run = builtRun(f.store, f.taskId, f.approved);
    const ref = f.store.refFor("built-in", f.taskId).id;
    expect(() => f.store.createPublicationIntent({ run, taskRef: ref, githubRepo: "o/r", remote: "origin", base: "main", head: "b", headSha: f.approved, bodyHash: "h", draft: false }, LATER)).toThrow("toolroll release");
  });

  test("a sweep with a release publication, a bad row and an ordinary one merges the ordinary one", async () => {
    const f = (fixture = releaseFixture());
    f.store.savePublicationGrant({ repo: f.repo, githubRepo: "o/r", remote: "origin", headPrefix: "standing-orders/", base: "main", capabilities: ["push-branch", "open-pr"], selector: "all", draft: false, grantedBy: "alex", merge: true, mergeMethod: "squash" }, RELEASE_NOW);
    const opened = (taskId: string, pr: number) => {
      const run = builtRun(f.store, taskId, f.approved);
      const ref = f.store.refFor("built-in", taskId).id;
      f.store.handle.prepare("INSERT INTO publication (run, task_ref, github_repo, remote, base, head, head_sha, body_hash, draft, state, pr_number, created_at, updated_at) VALUES (?, ?, 'o/r', 'origin', 'main', ?, ?, 'h', 0, 'opened', ?, ?, ?)")
        .run(run, ref, `standing-orders/${taskId}`, f.approved, pr, LATER.toISOString(), LATER.toISOString());
    };
    const ordinary = (id: string) => {
      f.store.createTask({ id, title: id }, LATER);
      f.store.placeTask(f.store.refFor("built-in", id).id, f.repo, {}, LATER);
      const scope = propose(f.store, { taskId: id, goal: id, candidate: f.approved, acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], now: LATER });
      if (!approve(f.store, id, "alex", LATER, scope.digest, f.password).ok) throw new Error("approve");
      return id;
    };
    opened(f.taskId, 1);
    // A row that throws when its intent is written (a nightly check, planted): the sweep goes on past it.
    const bad = ordinary("planted-nightly");
    f.store.handle.prepare("INSERT INTO nightly_check (repo, sha, task, at) VALUES (?, ?, ?, ?)").run(f.repo, f.approved, bad, LATER.toISOString());
    opened(bad, 2);
    opened(ordinary("ordinary"), 3);
    const merged: string[] = [];
    const exec = async (file: string, args: readonly string[]) => {
      const ok = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
      if (args[0] === "api" && args[1] === "--paginate") return { ...ok, stdout: "[[]]" };
      if (args[0] === "api" && args[1] === "--include") return { ...ok, code: 1, stdout: "HTTP/2.0 404 Not Found\n" };
      if (args[0] === "pr" && args[1] === "view") return { ...ok, stdout: JSON.stringify({ headRefOid: f.approved, state: "OPEN", isDraft: false, baseRefName: "main", statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] }) };
      if (args[0] === "pr" && args[1] === "merge") { merged.push(String(args[2])); return ok; }
      return { ...ok, code: 1, stderr: `unexpected ${file} ${args.join(" ")}` };
    };
    const { sweepMerges } = await import("../../src/publish.js");
    const report = await sweepMerges(f.store, { repo: f.repo, exec, clock: () => LATER });
    expect(merged).toEqual(["3"]);
    expect(report.merged).toBe(1);
    expect(report.problems.some(one => one.startsWith("publication "))).toBe(true);
    expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM merge_intent m JOIN publication p ON p.id = m.publication WHERE p.pr_number = 1").get()?.["n"]).toBe(0);
  });
});
