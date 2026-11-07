/**
 * Lesson notes (docs/plans/learning-loops.md, slice 4): each rule of when a note is proposed, the words for what was
 * recorded when none is, a person's own words on accepting, who may accept, and tallies that survive retention. Real
 * repositories and plane databases, fake checks, no model.
 */
import { afterEach, describe, expect, test } from "vitest";
import { EVIDENCE, RELEASE_NOW, builtRun, releaseFixture, reportOf, type ReleaseFixture } from "../test/release-fixture.js";
import { withActor } from "./actor.js";
import { captureCheckConditions, learnRequestFor, pruneCheckResults, recordCheckFacts, type CheckConditions } from "./check-facts.js";
import type { CheckReport } from "./contracts/release-check.js";
import { storeEvidence } from "./evidence.js";
import { pruneObservations } from "./flaky.js";
import { afterwardsWords, lessonNoteOf, noteAfterwards, revisedFailures, testOrHarnessPath } from "./lesson-notes.js";
import { asLocalOwner, type LocalOwnerAct } from "./local-owner.js";
import { decideProposal, listProposals, type MemoryProposal } from "./memory-pass.js";
import { listDecisions, retireDecision } from "./project-memory.js";
import { approve, propose } from "./scope.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const open = () => (fixture = releaseFixture());
const ANSWER = "unit:src/index.test.ts::answer", ENV = ["PATH"];
const rest = [{ file: "src/browser/app.test.ts" }, { file: "test/attacks/fence.test.ts" }];
const FAILING = [{ file: "src/index.test.ts", failed: ["answer"] }, ...rest], PASSING = [{ file: "src/index.test.ts", passed: ["answer"] }, ...rest];
type Units = Parameters<typeof reportOf>[0];
const conditionsOf = (f: ReleaseFixture, head: string, over: Partial<CheckConditions> = {}): CheckConditions => ({ ...captureCheckConditions({ repo: f.repo, head, command: f.store.liveVerifyCommand(f.repo)!, access: "sandboxed", envNames: ENV, env: { PATH: "/usr/bin" } }), ...over });

/** One check of a task, its facts recorded as the builder records them. */
function check(f: ReleaseFixture, task: string, head: string, units: Units, options: { over?: Partial<CheckConditions>; log?: string; extra?: Parameters<typeof reportOf>[1]; at?: Date } = {}): number {
  const report = { ...reportOf(units, options.extra), nonce: "n", mode: "full", planDigest: null } as unknown as CheckReport;
  const runId = builtRun(f.store, task, head);
  storeEvidence(f.store, EVIDENCE(f), runId, "check-log", "check-log.txt", Buffer.from(options.log ?? "ok\n"), "npm test", RELEASE_NOW, { captureStatus: "ok" });
  recordCheckFacts(f.store, EVIDENCE(f), { runId, taskRef: f.store.refFor("built-in", task).id, repo: f.repo, conditions: conditionsOf(f, head, options.over), receipt: { status: report.exitCode === 0 ? "passed" : "failed" }, report, attempt: null, stdout: null, now: options.at ?? RELEASE_NOW });
  return runId;
}
let serial = 0;
/** A revision of the fixture's task, approved and ready to build. */
function revisionOf(f: ReleaseFixture, failed: number, parent = f.taskId): string {
  const id = `rev-${serial++}`;
  f.store.createTask({ id, title: "Fix the answer" }, RELEASE_NOW);
  const ref = f.store.refFor("built-in", id).id;
  f.store.placeTask(ref, f.repo);
  const proposed = propose(f.store, { taskId: id, goal: "Fix the answer", touches: ["src/"], acceptance: [], now: RELEASE_NOW });
  const ok = approve(f.store, id, "alex", RELEASE_NOW, proposed.digest, f.password);
  if (!ok.ok) throw new Error(ok.reason);
  const brief = f.store.saveArtifact({ run: failed, kind: "revision-brief", key: `brief-${id}.json`, bytesOriginal: 2, bytesStored: 2, sha256: "a".repeat(64), truncated: false, capture: "synthetic", captureStatus: "ok", redacted: false } as unknown as Parameters<typeof f.store.saveArtifact>[0], RELEASE_NOW);
  f.store.markRevision(ref, parent, brief);
  return id;
}
/** The usual story: a failed check, a revision with a new commit that passes. */
function story(f: ReleaseFixture, units: Units = PASSING, files: Record<string, string | null> = { "src/index.ts": "export const answer = 42;\n" }, options: Parameters<typeof check>[4] = {}) {
  const failed = check(f, f.taskId, f.approved, FAILING, { log: " FAIL  src/index.test.ts > answer\nAssertionError: expected 41\n Tests  1 failed\n" });
  const task = revisionOf(f, failed);
  const head = f.commit(files);
  const passing = check(f, task, head, units, options);
  return { failed, task, head, passing };
}
const pending = (f: ReleaseFixture): MemoryProposal[] => listProposals(f.store, f.repo);
const notesOn = (f: ReleaseFixture, run: number): string[] => f.store.handle.prepare("SELECT note FROM run_note WHERE run = ?").all(run).map(row => String(row["note"]));

describe("when a note is proposed", () => {
  test("a revision that explicitly passes the failed test proposes the note, with only what was recorded", () => {
    const f = open();
    const { failed, passing, head } = story(f, PASSING, { "src/index.ts": "export const answer = 42;\n", "src/index.test.ts": "changed\n", "vitest.config.ts": "export default {};\n" });
    const [note] = pending(f);
    expect(note).toMatchObject({ kind: "decision-add", title: expect.stringContaining("Lesson note"), evidence: [{ session: `build:${failed}`, quote: expect.stringContaining("FAIL") }] });
    expect(note!.rationale).toContain(`failed in build #${failed}`);
    expect(note!.rationale).toContain(`It passed in revision ${head.slice(0, 7)} (build #${passing})`);
    expect(note!.rationale).toMatch(/That revision changed: .*src\/index\.ts/);
    expect(note!.rationale).toMatch(/Tests and harness changed: .*src\/index\.test\.ts.*vitest\.config\.ts/);
    expect(note!.rationale).not.toMatch(/caused|fixed|helped/i);
    expect(lessonNoteOf(f.store, note!.id)).toMatchObject({ failedRun: failed, passingRun: passing, identities: [ANSWER] });
    // Nothing is a decision until a person accepts it.
    expect(listDecisions(f.store, f.repo, "alex")).toEqual([]);
  });

  test("one pending note per identity set: a later revision adds no second one", () => {
    const f = open();
    const { failed, head } = story(f);
    const again = revisionOf(f, failed);
    const next = f.commit({ "src/index.ts": "export const answer = 43;\n" });
    expect(next).not.toBe(head);
    check(f, again, next, PASSING);
    expect(pending(f)).toHaveLength(1);
  });

  test("the revision's check asks about the failed test, and only the advisory way", () => {
    const f = open();
    const failed = check(f, f.taskId, f.approved, FAILING);
    const task = revisionOf(f, failed);
    const run = builtRun(f.store, task, f.approved);
    expect(revisedFailures(f.store, run)).toEqual([ANSWER]);
    expect(learnRequestFor(f.store, f.repo, RELEASE_NOW, run).learn).toEqual([ANSWER]);
    expect(learnRequestFor(f.store, f.repo, RELEASE_NOW).learn).toEqual([]);
  });

  test.each([
    ["the failure was the machine's", (f: ReleaseFixture, failed: number) => { f.store.handle.prepare("UPDATE run SET exec_class = 'infrastructure' WHERE id = ?").run(failed); }, {}],
    ["the revision's check ran a different command", () => undefined, { over: { commandDigest: "other" } }],
    ["the revision's check ran under different access", () => undefined, { over: { access: "unsandboxed" } }],
  ])("no note when %s", (_name, before, options) => {
    const f = open();
    const failed = check(f, f.taskId, f.approved, FAILING);
    before(f, failed);
    const task = revisionOf(f, failed);
    check(f, task, f.commit({ "src/index.ts": "x\n" }), PASSING, options);
    expect(pending(f)).toEqual([]);
  });

  test("no note for a file-level failure alone, a revision that doesn't descend, or a check that didn't pass", () => {
    const f = open();
    const fileOnly = check(f, f.taskId, f.approved, [{ file: "src/index.test.ts", state: "failed" as const }, ...rest]);
    check(f, revisionOf(f, fileOnly), f.commit({ "src/a.ts": "a\n" }), PASSING);
    expect(pending(f)).toEqual([]);
    const g = open();
    const failed = check(g, g.taskId, g.approved, FAILING);
    // The same commit is no revision; a check that failed again is no pass.
    check(g, revisionOf(g, failed), g.approved, PASSING);
    check(g, revisionOf(g, failed), g.commit({ "src/a.ts": "a\n" }), FAILING);
    expect(pending(g)).toEqual([]);
  });

  test("an explicit skip, a test file not in the revision and no line at all each say their own words", () => {
    const f = open();
    const skip = story(f, [{ file: "src/index.test.ts", skipped: ["answer"] }, ...rest]);
    expect(pending(f)).toEqual([]);
    expect(notesOn(f, skip.passing).join(" ")).toMatch(/was skipped in revision/);
    const g = open();
    const gone = story(g, rest, { "src/index.test.ts": null });
    expect(notesOn(g, gone.passing).join(" ")).toMatch(/The test file `src\/index\.test\.ts` is not in revision/);
    const h = open();
    const silent = story(h, rest);
    const said = notesOn(h, silent.passing).join(" ");
    expect(said).toMatch(/No test result recorded for/);
    expect(said).not.toMatch(/removed|skipped/);
  });

  test("a pass only on a retry, or anything retried in the revision, is no note", () => {
    const f = open();
    const units = { reusedFromCI: false, finished: true, runErrors: 0, files: [{ file: "src/index.test.ts", state: "passed" as const, passed: 1, failed: 0, skipped: 0, todo: 0, flaky: true }],
      identities: [{ file: "src/index.test.ts", name: "answer", state: "passed" as const, flaky: true }] };
    const retried = story(f, PASSING, undefined, { extra: { units } as Parameters<typeof reportOf>[1] });
    expect(pending(f)).toEqual([]);
    expect(notesOn(f, retried.passing).join(" ")).toMatch(/only on a retry/);
    const g = open();
    const other = { units: { ...units, identities: [{ file: "src/index.test.ts", name: "answer", state: "passed" as const, flaky: false }, { file: "src/index.test.ts", name: "other", state: "passed" as const, flaky: true }] } };
    story(g, PASSING, undefined, { extra: other as Parameters<typeof reportOf>[1] });
    expect(pending(g)).toEqual([]);
  });

  test("a test with mixed outcomes at the failed commit gets no note", () => {
    const f = open();
    const failed = check(f, f.taskId, f.approved, FAILING);
    check(f, f.taskId, f.approved, PASSING);
    const passing = check(f, revisionOf(f, failed), f.commit({ "src/a.ts": "a\n" }), PASSING);
    expect(pending(f)).toEqual([]);
    expect(notesOn(f, passing).join(" ")).toEqual("");
  });

  test("test and harness paths are told from source", () => {
    for (const path of ["src/a.test.ts", "scripts/release-check.mjs", "test/fixture.ts", ".github/workflows/ci.yml", "vitest.config.ts", "package.json"]) expect(testOrHarnessPath(path)).toBe(true);
    for (const path of ["src/a.ts", "README.md"]) expect(testOrHarnessPath(path)).toBe(false);
  });
});

describe("accepting a note", () => {
  const args = (f: ReleaseFixture, id: number, extra: object = {}) => ({ repo: f.repo, actor: "alex", id, decision: "accept" as const, ...extra });
  test("needs a person's own words, records a project decision, and tracks the test", () => {
    const f = open();
    story(f);
    const [note] = pending(f);
    expect(() => decideProposal(f.store, args(f, note!.id), RELEASE_NOW)).toThrow(/own words/);
    expect(() => decideProposal(f.store, args(f, note!.id, { claim: note!.afterText }), RELEASE_NOW)).toThrow(/own words/);
    decideProposal(f.store, args(f, note!.id, { claim: "The answer test needs the real value." }), RELEASE_NOW);
    const [decision] = listDecisions(f.store, f.repo, "alex");
    expect(decision).toMatchObject({ claim: "The answer test needs the real value.", sourceKind: "result", sourceRef: `lesson-note:${note!.id}`, status: "active" });
    expect(learnRequestFor(f.store, f.repo, RELEASE_NOW).learn).toEqual([ANSWER]);
    // Retiring the decision ends the tracking.
    retireDecision(f.store, { repo: f.repo, actor: "alex", id: decision!.id, reason: "No longer true here." }, RELEASE_NOW);
    expect(learnRequestFor(f.store, f.repo, RELEASE_NOW).learn).toEqual([]);
  });

  test("rejecting is remembered by its fingerprint: the same tests aren't proposed again", () => {
    const f = open();
    const { failed } = story(f);
    decideProposal(f.store, { repo: f.repo, actor: "alex", id: pending(f)[0]!.id, decision: "reject" }, RELEASE_NOW);
    check(f, revisionOf(f, failed), f.commit({ "src/index.ts": "x\n" }), PASSING);
    expect(pending(f)).toEqual([]);
  });

  test("the lead, a viewer and a revoked account are refused; the local owner may only with its own act", () => {
    const f = open();
    story(f);
    const id = pending(f)[0]!.id, claim = { claim: "The answer test needs the real value." };
    expect(() => withActor({ account: "alex", lead: true }, () => decideProposal(f.store, args(f, id, claim), RELEASE_NOW))).toThrow(/not the lead/);
    expect(() => decideProposal(f.store, { ...args(f, id, claim), actor: "nobody" }, RELEASE_NOW)).toThrow(/outside your access/);
    f.store.handle.prepare("INSERT INTO local_mode (id, owner, generation, enabled, initialized_at, changed_at) VALUES (1, 'alex', 1, 1, ?, ?)").run(RELEASE_NOW.toISOString(), RELEASE_NOW.toISOString());
    const principal = (act: LocalOwnerAct) => ({ account: "alex", localGeneration: 1, accountGeneration: f.store.accountOf("alex")!.generation, transport: "terminal" as const, act, sessionHash: null, request: null });
    expect(() => asLocalOwner(principal("read"), () => decideProposal(f.store, args(f, id, claim), RELEASE_NOW))).toThrow(/password/);
    asLocalOwner(principal("memory-review"), () => decideProposal(f.store, args(f, id, claim), RELEASE_NOW));
    expect(listDecisions(f.store, f.repo, "alex")).toHaveLength(1);
    // An instruction proposal stays with full authority.
    f.store.handle.prepare("INSERT INTO memory_proposal(repo,kind,fingerprint,title,rationale,before_text,after_text,evidence,sessions,status,created_at,surface) VALUES (?,'instruction-add','add:x','t','r',NULL,'a','[]',2,'pending',?,'s')").run(f.repo, RELEASE_NOW.toISOString());
    const instruction = pending(f)[0]!.id;
    expect(() => asLocalOwner(principal("memory-review"), () => decideProposal(f.store, args(f, instruction), RELEASE_NOW))).toThrow(/password/);
  });
});

describe("afterwards", () => {
  function accepted(f: ReleaseFixture): { id: number; decidedAt: string; sourceRef: string | null } {
    story(f);
    decideProposal(f.store, { repo: f.repo, actor: "alex", id: pending(f)[0]!.id, decision: "accept", claim: "The answer test needs the real value." }, RELEASE_NOW);
    const [decision] = listDecisions(f.store, f.repo, "alex");
    return decision!;
  }
  test("failures over eligible executions, split by who received it, with gaps counted and no causal words", () => {
    const f = open();
    const decision = accepted(f);
    const received = builtRun(f.store, f.taskId, f.approved);
    f.store.handle.prepare("INSERT INTO memory_use (run, repo, kind, item, version, phase, included_at) VALUES (?, ?, 'decision', ?, 1, 'build', ?)").run(received, f.repo, String(decision.id), RELEASE_NOW.toISOString());
    const report = { ...reportOf(PASSING), nonce: "n", mode: "full", planDigest: null } as unknown as CheckReport;
    recordCheckFacts(f.store, EVIDENCE(f), { runId: received, taskRef: f.store.refFor("built-in", f.taskId).id, repo: f.repo, conditions: conditionsOf(f, f.approved), receipt: { status: "passed" }, report, attempt: null, stdout: null, now: RELEASE_NOW });
    check(f, f.taskId, f.approved, FAILING);
    // A build with no per-test reporting.
    const silent = builtRun(f.store, f.taskId, f.approved);
    recordCheckFacts(f.store, EVIDENCE(f), { runId: silent, taskRef: f.store.refFor("built-in", f.taskId).id, repo: f.repo, conditions: conditionsOf(f, f.approved), receipt: { status: "passed" }, report: null, attempt: null, stdout: null, now: RELEASE_NOW });
    const after = noteAfterwards(f.store, decision)!;
    expect(after).toMatchObject({ executions: 2, failures: 1, receivedExecutions: 1, receivedFailures: 0, unreported: 1 });
    expect(after.mixed).toBeGreaterThan(0);
    const words = afterwardsWords(after);
    expect(words).toMatch(/failed 1 of 2 runs of this test \(0 of 1 that received this note; 1 of 1 that didn't\)/);
    expect(words).toMatch(/1 check since had no per-test reporting/);
    expect(words).not.toMatch(/help|fix|caus/i);
  });

  test("the numbers survive a retention prune", () => {
    const f = open();
    const decision = accepted(f);
    const later = new Date(RELEASE_NOW.getTime() + 86_400_000);
    check(f, f.taskId, f.approved, FAILING, { at: later });
    const before = noteAfterwards(f.store, decision);
    const far = new Date(RELEASE_NOW.getTime() + 400 * 86_400_000);
    expect(pruneCheckResults(f.store, far)).toBeGreaterThan(0);
    pruneObservations(f.store, far);
    expect(noteAfterwards(f.store, decision)).toEqual(before);
  });
});
