/**
 * Result records (docs/plans/results-routing.md, slice 1): each state and reason a family's record can take, read
 * only from the plane's own rows. The effective check and the changed-file inventory are read through their pinned
 * readers (assignment.ts assignmentChecksForRun, result-completion.ts changedFilesOf), mocked here so each case sets
 * them directly; everything else is a real store. Isolated databases only.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seams = vi.hoisted(() => ({ checks: new Map<number, string>(), files: new Map<number, string[] | null>() }));
vi.mock("./assignment.js", async original => {
  const real = await original<typeof import("./assignment.js")>();
  return { ...real, assignmentChecksForRun: (_store: unknown, _root: unknown, runId: number) =>
    ({ status: seams.checks.get(runId) ?? "passed", exitCode: 0, command: null, logArtifactId: null, detail: "" }) };
});
vi.mock("./result-completion.js", async original => {
  const real = await original<typeof import("./result-completion.js")>();
  return { ...real, changedFilesOf: (_store: unknown, runId: number) => (seams.files.has(runId) ? seams.files.get(runId)! : ["src/app.ts"]) };
});

import { openStore, BUILT_IN, recordRunModelReported, forgetProjectModels, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { writeEvidenceFile } from "./evidence.js";
import { COMPLETION_ACTION } from "./result-completion.js";
import { evaluateFamily, execClassOf, EXEC_CLASS_OF_REASON, MATURE_AFTER_MS, recordWords, resultRecordOf, UNANSWERED_AFTER_MS } from "./route-results.js";
import { bumpModelsGeneration, modelsGenerationOf, recordExecClass, recordRevisionOrigin, reevaluateResultRecords, writeRunCohort } from "./route-store.js";
import { runModelsCommand } from "./models-cli.js";

const T0 = new Date("2026-11-01T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const REPO = "/repo/shop";
let dir: string, evidence: string, store: Store, token: string, lease = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-route-results-"));
  evidence = join(dir, "evidence");
  store = openStore(join(dir, "plane.db"));
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  token = alex.token;
  for (const phase of ["plan", "build", "review", "repair"] as const) store.setPhaseConfig("installation", phase, "claude", "claude-haiku-4-5", "alex", T0);
  seams.checks.clear();
  seams.files.clear();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const refOf = (id: string) => store.refFor(BUILT_IN, id).id;
/** A task filed and approved by a person, sized as the case says. */
function file(id: string, size: "small" | "medium" | "large" = "small", risky = false, touches: string[] = [], qualityMode: "default" | "strict" = "default"): string {
  store.createTask({ id, title: id }, T0);
  store.placeTask(refOf(id), REPO);
  store.writeSizing(refOf(id), { size, risky, source: "person", reason: "set by the test" });
  propose(store, { taskId: id, goal: "Round payouts to the cent", touches, qualityMode, now: T0 });
  const approved = approve(store, id, "alex", T0, store.getScope(id)!.digest, token);
  if (!approved.ok) throw new Error(`approve ${id}`);
  return id;
}
type Attempt = { outcome?: "built" | "failed" | "interrupted" | "no-change"; reason?: string; reported?: string | null; started?: boolean; when?: Date };
/** One builder attempt through the real admission, ended as the case says; the provider reports the model it ran. */
function build(id: string, attempt: Attempt = {}): number {
  const when = attempt.when ?? T0;
  const authority = store.routeAuthorityFor(refOf(id), "builder");
  if (authority === null || !authority.ok) throw new Error(`no route for ${id}`);
  const run = store.startRun({ taskRef: refOf(id), leaseId: `lease-${++lease}`, runner: "worker", branch: `standing-orders/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: when });
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest });
  if (attempt.started !== false) {
    store.stampProviderStart(run, when);
    recordRunModelReported(store, run, attempt.reported === undefined ? authority.stamp.model : attempt.reported, false);
  }
  const outcome = attempt.outcome ?? "built";
  if (outcome === "failed" || outcome === "interrupted") recordExecClass(store, run, attempt.reason ?? "agent");
  store.finishRun(run, { outcome, reason: outcome === "failed" ? "retryable-infra" : attempt.reason ?? null, committed: outcome === "built", now: when });
  return run;
}
const accept = (root: string, run: number, when = at(1), detail = "proof person", actor = "operator:alex") =>
  store.recordAction({ at: when.toISOString(), actor, repo: REPO, taskId: root, runId: run, action: COMPLETION_ACTION, outcome: "a".repeat(64), source: "work", detail });
/** A revision of the task's result, sealed through the real road, sized like its source, approved by a person. */
function revise(source: string, run: number, origin: Parameters<typeof recordRevisionOrigin>[2], size: "small" | "medium" | "large" = "small"): string {
  const brief = Buffer.from(JSON.stringify({ schema: 1, sourceTask: source, sourceRun: run, sourceScopeDigest: store.getScope(source)!.digest, head: store.getRun(run)!.headRevision, comments: [] }));
  const key = writeEvidenceFile(evidence, run, `revision-brief-${run}.json`, brief);
  const sealed = store.sealRevision({ source: { task: source, run, scopeDigest: store.getScope(source)!.digest },
    brief: { evidenceRoot: evidence, key, bytes: brief.length, sha256: createHash("sha256").update(brief).digest("hex"), capture: "revision brief" },
    child: { title: "Revise", repair: "apply the feedback" }, commentIds: null }, T0);
  if (!sealed.ok) throw new Error(sealed.detail);
  recordRevisionOrigin(store, sealed.id, origin);
  store.writeSizing(refOf(sealed.id), { size, risky: false, source: "person", reason: "set by the test" });
  propose(store, { taskId: sealed.id, goal: "Round payouts to the cent, as reviewed", now: T0 });
  if (!approve(store, sealed.id, "alex", T0, store.getScope(sealed.id)!.digest, token).ok) throw new Error("approve revision");
  return sealed.id;
}
const record = (id: string, now: Date) => evaluateFamily(store, id, evidence, now);
const stateOf = (id: string, now: Date) => { const one = record(id, now); return one === null ? null : `${one.state}${one.reason === null ? "" : `:${one.reason}`}`; };

describe("the execution class", () => {
  test("is kept from the raw reason before normalization; anything unlisted, or a missing write, is the model's", () => {
    expect(["timeout", "agent", "agent-reported", "no-op", "no-handoff", "moved-head", "moved-branch", "commit-failure"].map(one => execClassOf(one, null))).toEqual(Array(8).fill("model"));
    expect(["git", "setup", "provider-init", "provider-unattested", "provider-protocol", "stopped"].map(one => execClassOf(one, null))).toEqual(Array(6).fill("infrastructure"));
    expect(execClassOf("revision-brief", null)).toBe("model");
    expect(execClassOf("something-new", null)).toBe("model");
    expect(execClassOf("agent", "auth-expired")).toBe("infrastructure");
    expect(execClassOf("timeout", "usage-exhausted")).toBe("infrastructure");
    expect(Object.isFrozen(EXEC_CLASS_OF_REASON)).toBe(true);
    // First write wins: a later ending never rewrites the class.
    const id = file("first-write");
    const run = build(id, { outcome: "failed", reason: "setup" });
    recordExecClass(store, run, "timeout");
    expect(store.handle.prepare("SELECT exec_class FROM run WHERE id = ?").get(run)?.["exec_class"]).toBe("infrastructure");
  });
});

describe("a family's record", () => {
  test("pending → provisional → mature, with one model and one cohort", () => {
    const id = file("pay");
    expect(stateOf(id, T0)).toBeNull();
    const run = build(id);
    expect(stateOf(id, at(1))).toBe("pending");
    accept(id, run, at(2));
    expect(stateOf(id, at(3))).toBe("provisional");
    expect(record(id, at(3))).toMatchObject({ acceptedAt: at(2).toISOString(), model: "claude-haiku-4-5", cohortSize: "small", resultRun: run, settled: false });
    expect(stateOf(id, new Date(at(2).getTime() + MATURE_AFTER_MS - 1))).toBe("provisional");
    const mature = record(id, new Date(at(2).getTime() + MATURE_AFTER_MS))!;
    expect(mature).toMatchObject({ state: "mature", settled: true, decidedAt: new Date(at(2).getTime() + MATURE_AFTER_MS).toISOString() });
    expect(recordWords(mature)).toBe("Counts for claude-haiku-4-5: accepted, checks passed");
  });

  test("two timeouts then success: rejected; one setup failure then success: counted", () => {
    const timeouts = file("timeouts");
    build(timeouts, { outcome: "failed", reason: "timeout" });
    build(timeouts, { outcome: "failed", reason: "timeout" });
    accept(timeouts, build(timeouts));
    expect(stateOf(timeouts, at(20))).toBe("rejected:model-failures");
    const setup = file("setup");
    build(setup, { outcome: "failed", reason: "setup" });
    accept(setup, build(setup));
    expect(record(setup, at(20))).toMatchObject({ state: "mature", modelFailures: 0, infraFailures: 1 });
  });

  test("a failed run with no execution class kept counts as the model's", () => {
    const id = file("unkept");
    for (let n = 0; n < 2; n++) {
      const authority = store.routeAuthorityFor(refOf(id), "builder");
      if (authority === null || !authority.ok) throw new Error("route");
      const run = store.startRun({ taskRef: refOf(id), leaseId: `lease-${++lease}`, runner: "worker", branch: "b", worktree: "/w", route: authority.stamp, now: T0 });
      store.stampProviderStart(run, T0);
      recordRunModelReported(store, run, "claude-haiku-4-5", false);
      store.finishRun(run, { outcome: "failed", reason: "retryable-infra", now: T0 });
    }
    accept(id, build(id));
    expect(stateOf(id, at(20))).toBe("rejected:model-failures");
    // An interruption before the provider started is the infrastructure's, kept class or not.
    const early = file("early");
    const authority = store.routeAuthorityFor(refOf(early), "builder");
    if (authority === null || !authority.ok) throw new Error("route");
    for (let n = 0; n < 2; n++) {
      const run = store.startRun({ taskRef: refOf(early), leaseId: `lease-${++lease}`, runner: "worker", branch: "b", worktree: "/w", route: authority.stamp, now: T0 });
      store.finishRun(run, { outcome: "failed", reason: "interrupted", now: T0 });
    }
    accept(early, build(early));
    expect(record(early, at(20))).toMatchObject({ state: "mature", infraFailures: 2, modelFailures: 0 });
  });

  test("the task failing: rejected, unless every failure was the infrastructure's (not counted)", () => {
    const model = file("model-fail");
    build(model, { outcome: "failed", reason: "agent" });
    store.setTaskState(model, "failed", T0);
    expect(stateOf(model, at(1))).toBe("rejected:task-failed");
    const infra = file("infra-fail");
    build(infra, { outcome: "failed", reason: "provider-init" });
    store.setTaskState(infra, "failed", T0);
    expect(stateOf(infra, at(1))).toBe("not-counted:infrastructure-only");
    const cancelled = file("cancelled-early");
    build(cancelled, { outcome: "failed", reason: "git" });
    store.setTaskState(cancelled, "cancelled", T0);
    expect(stateOf(cancelled, at(1))).toBe("not-counted:cancelled-before-result");
    const after = file("cancelled-after");
    build(after);
    store.setTaskState(after, "cancelled", T0);
    expect(stateOf(after, at(1))).toBe("rejected:cancelled-after-result");
  });

  test("a HIGH finding, a refuted proof and a failed effective check each reject", () => {
    const high = file("high");
    const run = build(high);
    store.handle.prepare("INSERT INTO build_review (run, task_id, repo, state, findings_json, queued_at) VALUES (?, ?, ?, 'reviewed', ?, ?)")
      .run(run, high, REPO, JSON.stringify({ version: 1, findings: [{ severity: "HIGH", file: "a.ts", line: 1, scenario: "x" }] }), T0.toISOString());
    expect(stateOf(high, at(1))).toBe("rejected:high-finding");
    const refuted = file("refuted");
    const proof = build(refuted);
    store.saveProofVerdict(proof, "refuted", ["the report doesn't match the changes"], T0);
    expect(stateOf(refuted, at(1))).toBe("rejected:proof-refuted");
    // A follow-up check that fails after acceptance re-evaluates to rejected.
    const later = file("follow-up");
    const result = build(later);
    accept(later, result);
    expect(stateOf(later, at(3))).toBe("provisional");
    seams.checks.set(result, "failed");
    expect(stateOf(later, at(4))).toBe("rejected:check-failed");
  });

  test("no check, an unreadable or protected change, and no answer in 30 days are not counted", () => {
    const none = file("no-check");
    seams.checks.set(build(none), "not-run");
    expect(record(none, at(1))).toMatchObject({ state: "not-counted", reason: "no-check", settled: false });
    const unknown = file("unknown");
    seams.files.set(build(unknown), null);
    expect(stateOf(unknown, at(1))).toBe("not-counted:changed-files-unknown");
    store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["src/billing/**"] }, "alex", T0);
    // It declared only unprotected paths (eligible before dispatch), then changed a protected one.
    const touched = file("touched", "small", false, ["src/app.ts"]);
    seams.files.set(build(touched), ["src/billing/charge.ts"]);
    expect(stateOf(touched, at(1))).toBe("not-counted:touched-protected");
    store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: [] }, "alex", T0);
    const quiet = file("quiet");
    const run = build(quiet);
    expect(stateOf(quiet, new Date(T0.getTime() + UNANSWERED_AFTER_MS - 1))).toBe("pending");
    expect(record(quiet, new Date(T0.getTime() + UNANSWERED_AFTER_MS))).toMatchObject({ state: "not-counted", reason: "unanswered", settled: true, resultRun: run });
  });

  test("not eligible before dispatch: large, risky, strict, evidence demands, protected or a release", () => {
    for (const [id, size, risky] of [["large", "large", false], ["risky", "small", true]] as const) {
      file(id, size, risky);
      build(id);
      expect(stateOf(id, at(1))).toBe("not-counted:not-eligible");
    }
    const ineligible = (id: string) => store.handle.prepare("SELECT c.ineligible FROM run_cohort c JOIN task_ref r ON r.id = c.task_ref WHERE r.external_id = ?").get(id)?.["ineligible"];
    expect([ineligible("large"), ineligible("risky")]).toEqual(["large", "risky"]);
    file("strict", "small", false, [], "strict");
    build("strict");
    expect(ineligible("strict")).toBe("strict");
    file("guarded");
    store.setApprovalRules(REPO, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", T0);
    build("guarded");
    expect(ineligible("guarded")).toBe("protected");
    expect(stateOf("guarded", at(1))).toBe("not-counted:not-eligible");
  });

  test("a repair run on another model: mixed models; the model not reported: not counted", () => {
    const mixed = file("mixed");
    const run = build(mixed);
    const repair = Number(store.handle.prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, model, parent_run, branch, worktree, started_at, provider_started_at, finished_at, outcome, model_reported) VALUES (?, 'r', 'worker', 'repair', 'claude', 'claude-sonnet-4-5', ?, 'b', '/w', ?, ?, ?, 'built', 'claude-sonnet-4-5')")
      .run(refOf(mixed), run, T0.toISOString(), T0.toISOString(), T0.toISOString()).lastInsertRowid);
    writeRunCohort(store, { run: repair, taskRef: refOf(mixed), role: "repair", routeDigest: "d", provider: "claude", model: "claude-sonnet-4-5", qualityMode: "default", startedAt: T0.toISOString() });
    expect(stateOf(mixed, at(1))).toBe("not-counted:mixed-models");
    const silent = file("silent");
    build(silent, { reported: null });
    expect(stateOf(silent, at(1))).toBe("not-counted:model-not-reported");
    const other = file("other-model");
    build(other, { reported: "claude-opus-4-1" });
    expect(stateOf(other, at(1))).toBe("not-counted:mixed-models");
  });

  test("runs started before results were recorded: not counted", () => {
    const old = file("old");
    const run = build(old);
    store.handle.prepare("DELETE FROM run_cohort WHERE run = ?").run(run);
    expect(stateOf(old, at(1))).toBe("not-counted:before-records");
  });

  test("a person's revision rejects; an automatic-review revision under a mode signer, a flow's, a lead's or a machine's does not", () => {
    const person = file("person");
    const first = build(person);
    const child = revise(person, first, "person");
    build(child);
    expect(stateOf(person, at(1))).toBe("rejected:person-revision");
    for (const origin of ["automatic-review", "flow", "lead", "machine"] as const) {
      const id = file(`by-${origin}`);
      const source = build(id);
      const next = revise(id, source, origin);
      const result = build(next);
      accept(id, result, at(2));
      expect(record(id, at(3)), origin).toMatchObject({ state: "provisional", resultRun: result, remediationRuns: 1 });
    }
  });

  test("a revision re-sized large: mixed cohort", () => {
    const id = file("resized");
    const source = build(id);
    build(revise(id, source, "automatic-review", "large"));
    expect(stateOf(id, at(1))).toBe("not-counted:mixed-cohort");
    const medium = file("medium-revision");
    build(revise(medium, build(medium), "flow", "medium"));
    expect(stateOf(medium, at(1))).toBe("not-counted:mixed-cohort");
  });

  test("a machine's completion, a lead's and Toolroll's own landing are not acceptance; a merge is", () => {
    const id = file("not-accepted");
    const run = build(id);
    accept(id, run, at(1), "proof machine");
    accept(id, run, at(1), "its pull request merged", "system:landed");
    accept(id, run, at(1), "proof person", "lead:alex");
    expect(stateOf(id, at(20))).toBe("pending");
    const merged = file("merged");
    const result = build(merged);
    const publication = store.createPublicationIntent({ run: result, taskRef: refOf(merged), githubRepo: "alex/shop", remote: "origin", base: "main", head: "standing-orders/merged", headSha: "abc123", bodyHash: "x", draft: false }, T0);
    store.handle.prepare("INSERT INTO merge_intent (publication, grant_terms_hash, head_sha, method, state, created_at, settled_at) VALUES (?, 'h', 'abc123', 'squash', 'merged', ?, ?)")
      .run(publication, T0.toISOString(), at(2).toISOString());
    expect(record(merged, at(3))).toMatchObject({ state: "provisional", acceptedAt: at(2).toISOString() });
  });
});

describe("the re-evaluation pass and the task page's record", () => {
  test("saves records, re-reads unsettled ones as their inputs change, never rewrites a settled one", () => {
    const id = file("pass");
    const run = build(id);
    expect(reevaluateResultRecords(store, REPO, evidence, at(1))).toBe(1);
    expect(resultRecordOf(store, id, evidence, at(1))).toMatchObject({ state: "pending", words: "Pending: waiting for the result to be accepted" });
    accept(id, run, at(2));
    reevaluateResultRecords(store, REPO, evidence, at(3));
    expect(resultRecordOf(store, id, evidence, at(3))?.state).toBe("provisional");
    reevaluateResultRecords(store, REPO, evidence, at(30));
    const saved = () => ({ ...store.handle.prepare("SELECT state, decided_at, settled FROM route_record WHERE task_ref = ?").get(refOf(id)) });
    expect(saved()).toEqual({ state: "mature", decided_at: new Date(at(2).getTime() + MATURE_AFTER_MS).toISOString(), settled: 1 });
    // Settled: a later failing check doesn't move it, and the pass no longer picks it up.
    seams.checks.set(run, "failed");
    expect(reevaluateResultRecords(store, REPO, evidence, at(31))).toBe(0);
    expect(saved().state).toBe("mature");
  });

  test("models results lists the records of the projects this person can open, plainly and as JSON", async () => {
    const id = file("listed");
    accept(id, build(id), at(2));
    reevaluateResultRecords(store, REPO, evidence, at(3));
    const lines: string[] = [];
    const run = (json: boolean, flags: [string, string | true][] = []) => runModelsCommand(["results"], new Map(flags), { store, write: line => lines.push(line), json, now: at(3), actor: "alex" });
    expect(await run(false)).toBe(0);
    expect(lines.at(-1)).toBe("1 record: 0 counted, 0 counted against, 1 accepted and waiting, 0 pending, 0 not counted\nlisted · claude-haiku-4-5 · small · Accepted: counts for claude-haiku-4-5 14 days after acceptance");
    expect(await run(true)).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: true, command: "models results", records: [{ task: "listed", state: "provisional", size: "small", resultRun: expect.any(Number) }] });
    expect(await run(true, [["repo", "/repo/elsewhere"]])).toBe(1);
    expect(await runModelsCommand(["results"], new Map(), { store, write: line => lines.push(line), json: false, now: at(3), actor: null })).toBe(1);
  });
});

describe("configuration generations", () => {
  test("every Models row writer moves its (scope, phase) generation only when a row changed", () => {
    const build = () => modelsGenerationOf(store, "installation", "build");
    const start = build();
    store.setPhaseConfig("installation", "build", "claude", "claude-haiku-4-5", "alex", T0);
    expect(build()).toBe(start);
    store.setPhaseConfig("installation", "build", "claude", "claude-sonnet-4-5", "alex", T0);
    store.setPhaseConfig("installation", "build", "claude", "claude-haiku-4-5", "alex", T0);
    // Away and back is two changes: the generation never returns.
    expect(build()).toBe(start + 2);
    store.setPhaseTierConfig("installation", "build", "light", "claude", "claude-haiku-4-5", "alex", T0);
    store.setPhaseTierConfig("installation", "build", "light", "claude", "claude-haiku-4-5", "alex", T0);
    expect(build()).toBe(start + 3);
    expect(store.clearPhaseTierConfig("installation", "build", "light")).toBe(true);
    expect(store.clearPhaseTierConfig("installation", "build", "light")).toBe(false);
    store.setPhaseTierAlternate("installation", "build", "routine", "codex", "gpt-5-codex", "alex", T0);
    expect(store.clearPhaseTierAlternates("installation", "build", "routine", null)).toBe(1);
    expect(store.clearPhaseConfig("installation", "build")).toBe(true);
    expect(build()).toBe(start + 7);
    expect(modelsGenerationOf(store, "installation", "plan")).toBe(1);
  });

  test("a moved generation pauses a rule that depended on it, in the same transaction; a deleted project's rows go through the counter", () => {
    store.setPhaseConfig(REPO, "build", "claude", "claude-sonnet-4-5", "alex", T0);
    const depends = { [`installation|build`]: modelsGenerationOf(store, "installation", "build"), [`${REPO}|build`]: modelsGenerationOf(store, REPO, "build") };
    store.handle.prepare(`INSERT INTO route_rule (repo, cohort_size, kind, provider, model, configured_provider, configured_model, state, grant_json, prices_json, depends_json, accepted_by, accepted_at)
      VALUES (?, 'small', 'rule', 'claude', 'claude-haiku-4-5', 'claude', 'claude-sonnet-4-5', 'active', '{}', '{}', ?, 'alex', ?)`).run(REPO, JSON.stringify(depends), T0.toISOString());
    bumpModelsGeneration(store, "installation", "plan", T0);
    expect(store.handle.prepare("SELECT state, generation FROM route_rule").get()).toMatchObject({ state: "active", generation: 1 });
    store.setPhaseConfig(REPO, "build", "claude", "claude-opus-4-1", "alex", T0);
    expect(store.handle.prepare("SELECT state, generation FROM route_rule").get()).toMatchObject({ state: "paused", generation: 2 });
    // Deleting the project: its Models rows go, each phase's generation moves, and its routing rows go with them.
    const id = file("doomed");
    build(id);
    reevaluateResultRecords(store, REPO, evidence, at(1));
    const before = modelsGenerationOf(store, REPO, "build");
    expect(forgetProjectModels(store, REPO, at(2))).toBeGreaterThan(0);
    expect(modelsGenerationOf(store, REPO, "build")).toBe(before + 1);
    for (const table of ["phase_config", "phase_tier_config", "phase_tier_alternate"]) expect(store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope = ?`).get(REPO)?.["n"]).toBe(0);
    for (const table of ["route_rule", "route_record", "run_cohort"]) expect(store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"], table).toBe(0);
  });
});
