/**
 * Check facts (docs/plans/learning-loops.md, slice 1): each source recorded and tagged, every failure in a check kept
 * while its own outcome stays exactly as the plane recorded it, conditions that tell one environment variable apart,
 * an unreadable tree recording nothing comparable, an explicit skip apart from no evidence, and the advisory learning
 * line read strictly — a flooded or malformed one loses learning evidence only. Real repositories and plane databases.
 */
import { afterEach, describe, expect, test } from "vitest";
import { buildReport, learnLine, parseHandshake, reportLine } from "../scripts/release-check.mjs";
import { builtRun, EVIDENCE, releaseFixture, RELEASE_NOW, reportOf, sealedCheck, type ReleaseFixture } from "../test/release-fixture.js";
import { captureCheckConditions, checkFactOf, checkResultsOf, learnRequestFor, learningLinesOf, recordCheckFacts, type CheckConditions } from "./check-facts.js";
import { CHECK_INVENTORY_CAPTURE, CHECK_REPORT_CAPTURE, fullCheckProblem, readSealedJson } from "./check-report.js";
import { LEARN_MAX_BYTES, LEARN_PREFIX, type SealedInventory } from "./contracts/release-check.js";
import { storeEvidence } from "./evidence.js";
import { watchObservation } from "./flaky.js";
import { verificationEvidence } from "./verification-evidence.js";

let fixture: ReleaseFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const open = () => (fixture = releaseFixture());
const ENV = ["HOME", "LANG", "PATH", "TZ"];
const env = (over: Record<string, string | undefined> = {}) => ({ PATH: "/usr/bin:/bin", HOME: "/home/check", LANG: "en_US.UTF-8", TZ: "UTC", ...over });
const conditionsOf = (f: ReleaseFixture, head = f.approved, over: Record<string, string | undefined> = {}): CheckConditions =>
  captureCheckConditions({ repo: f.repo, head, command: f.store.liveVerifyCommand(f.repo)!, access: "sandboxed", envNames: ENV, env: env(over) });
const ref = (f: ReleaseFixture) => f.store.refFor("built-in", f.taskId).id;
const learnText = (nonce: string, results: { identity: string; state: string }[]) => `${LEARN_PREFIX}${JSON.stringify({ nonce, results })}\n`;
const ANSWER = "unit:src/index.test.ts::answer", APP = "unit:src/browser/app.test.ts::app";
/** Every unit file the fixture's tree has: a passing Full check reports each. */
const PASSING = [{ file: "src/index.test.ts" }, { file: "src/browser/app.test.ts" }, { file: "test/attacks/fence.test.ts" }];

/** A sealed release check, then its facts recorded as the builder records them. */
function checked(f: ReleaseFixture, units: Parameters<typeof reportOf>[0], options: { learn?: string[]; before?: (nonce: string) => string; conditions?: CheckConditions | null } = {}) {
  const sealed = sealedCheck(f, f.taskId, f.approved, () => reportOf(units), { forceFull: true, ...(options.learn === undefined ? {} : { learn: options.learn }), ...(options.before === undefined ? {} : { stdoutBefore: options.before }) });
  recordCheckFacts(f.store, EVIDENCE(f), { runId: sealed.runId, taskRef: ref(f), repo: f.repo, conditions: options.conditions === undefined ? conditionsOf(f) : options.conditions,
    receipt: { status: sealed.status }, report: sealed.report, attempt: { nonce: sealed.prepared.nonce, learn: sealed.prepared.learn }, stdout: sealed.stdout, now: RELEASE_NOW });
  return sealed;
}
const rows = (f: ReleaseFixture, run: number) => checkResultsOf(f.store, run).map(one => `${one.source} ${one.state} ${one.identity}`);
const runCheck = (f: ReleaseFixture, run: number) => f.store.handle.prepare("SELECT status, exit_code, suites_json FROM run_check WHERE run = ?").get(run);

describe("what a check recorded, by source", () => {
  test("a failed release check keeps every failure, each tagged by source; its own outcome, receipt and report are untouched", () => {
    const f = open();
    const sealed = checked(f, [{ file: "src/index.test.ts", failed: ["answer"] }, { file: "src/browser/app.test.ts", skipped: ["later"] }], {
      learn: [ANSWER, APP], before: nonce => learnText(nonce, [{ identity: ANSWER, state: "failed" }, { identity: APP, state: "passed" }]) });
    const expected = [`learn passed ${APP}`, `learn failed ${ANSWER}`, "receipt failed check",
      "report failed file:src/index.test.ts", "report failed part:unit",
      // Each journey the report names is a case with explicit evidence.
      ...["app:real", "app:scripted", "flows:real", "flows:scripted"].map(run => `report passed journey:${run}:core::opens`), "report skipped unit:src/browser/app.test.ts::later", `report failed ${ANSWER}`];
    expect(rows(f, sealed.runId)).toEqual(expect.arrayContaining(expected));
    expect(rows(f, sealed.runId)).toHaveLength(expected.length);
    expect(checkFactOf(f.store, sealed.runId)).toMatchObject({ repo: f.repo, head: f.approved, purpose: "release", learnState: "recorded", learnWhy: null, conditionsClass: expect.stringMatching(/^[a-z0-9]+-[a-z0-9_]+-node\d+$/) });
    // The check's own outcome is the plane's, unchanged: run_check, the receipt, the sealed report.
    expect(runCheck(f, sealed.runId)).toMatchObject({ status: "failed" });
    expect(verificationEvidence(f.store, EVIDENCE(f), sealed.runId).ok).toBe(true);
    expect(readSealedJson(f.store, EVIDENCE(f), sealed.runId, CHECK_REPORT_CAPTURE)!.value).toEqual(sealed.report);
    // Recorded once: a second write changes nothing.
    recordCheckFacts(f.store, EVIDENCE(f), { runId: sealed.runId, taskRef: ref(f), repo: f.repo, conditions: conditionsOf(f), receipt: { status: "passed" }, report: null, attempt: null, stdout: null, now: RELEASE_NOW });
    expect(rows(f, sealed.runId)).toContain("receipt failed check");
    expect(rows(f, sealed.runId)).not.toContain("receipt passed check");
  });

  test("the sealed log's FAIL lines are file-level failures; a failed check naming nothing records it unexplained", () => {
    const f = open();
    const run = (log: string) => {
      const id = builtRun(f.store, f.taskId, f.approved);
      storeEvidence(f.store, EVIDENCE(f), id, "check-log", "check-log.txt", Buffer.from(log), "npm test", RELEASE_NOW, { captureStatus: "ok" });
      recordCheckFacts(f.store, EVIDENCE(f), { runId: id, taskRef: ref(f), repo: f.repo, conditions: conditionsOf(f), receipt: { status: "failed" }, report: null, attempt: null, stdout: null, now: RELEASE_NOW });
      return id;
    };
    const named = run(" FAIL  src/index.test.ts > answer\n FAIL  src/browser/app.test.ts > app\nAssertionError\n Tests  2 failed | 3 passed\n");
    expect(rows(f, named)).toEqual(["log failed file:src/browser/app.test.ts", "log failed file:src/index.test.ts", "receipt failed check"]);
    // A count that disagrees with the FAIL lines, or none at all: the log names nothing, and the failure is unexplained.
    for (const log of [" FAIL  src/index.test.ts\n Tests  2 failed\n", "error TS2345: nope\n"]) expect(rows(f, run(log))).toEqual(["receipt failed check", "receipt failed unexplained"]);
    expect(checkFactOf(f.store, named)).toMatchObject({ learnState: "not-asked" });
  });

  test("an unreadable tree, or a command that never started, records the fact and nothing comparable", () => {
    const f = open();
    const missing = conditionsOf(f, "0".repeat(40));
    expect(missing).toMatchObject({ tree: null, conditionsDigest: null, problem: expect.stringContaining("verified objects") });
    expect(captureCheckConditions({ repo: `${f.repo}-gone`, head: f.approved, command: f.store.liveVerifyCommand(f.repo)!, access: "sandboxed", envNames: ENV })).toMatchObject({ tree: null, conditionsDigest: null });
    for (const conditions of [missing, null]) {
      const sealed = checked(f, [{ file: "src/index.test.ts", failed: ["answer"] }], { learn: [ANSWER], before: nonce => learnText(nonce, [{ identity: ANSWER, state: "failed" }]), conditions });
      expect(rows(f, sealed.runId)).toEqual([]);
      expect(checkFactOf(f.store, sealed.runId)).toMatchObject({ tree: null, conditionsDigest: null, conditionsClass: null, learnState: "not-recorded",
        learnWhy: conditions === null ? "the check's command never started" : expect.stringContaining("verified objects") });
      expect(runCheck(f, sealed.runId)).toMatchObject({ status: "failed" });
    }
  });

  test("conditions: the same environment gives the same digest; one inherited variable apart gives another", () => {
    const f = open();
    const base = conditionsOf(f);
    expect(base.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(conditionsOf(f).conditionsDigest).toBe(base.conditionsDigest);
    for (const over of [{ TZ: "Europe/Paris" }, { LANG: "C" }, { HOME: undefined }]) expect(conditionsOf(f, f.approved, over).conditionsDigest, JSON.stringify(over)).not.toBe(base.conditionsDigest);
    // A variable the check doesn't inherit changes nothing.
    expect(conditionsOf(f, f.approved, { SECRET_TOKEN: "x" }).conditionsDigest).toBe(base.conditionsDigest);
    // Values are hashed, never kept.
    expect(JSON.stringify(base)).not.toContain("/home/check");
    // Another command or access is another condition too.
    expect(captureCheckConditions({ repo: f.repo, head: f.approved, command: f.store.liveVerifyCommand(f.repo)!, access: "sign-ins", envNames: ENV, env: env() }).conditionsDigest).not.toBe(base.conditionsDigest);
  });

  test("an explicit skip is recorded as skipped; an identity with no line has no evidence at all", () => {
    const f = open();
    const sealed = checked(f, PASSING, {
      learn: [ANSWER, APP], before: nonce => learnText(nonce, [{ identity: ANSWER, state: "skipped" }]) });
    expect(rows(f, sealed.runId).filter(one => one.startsWith("learn"))).toEqual([`learn skipped ${ANSWER}`]);
    expect(checkResultsOf(f.store, sealed.runId).some(one => one.identity === APP)).toBe(false);
    expect(rows(f, sealed.runId)).toContain("receipt passed check");
  });
});

describe("the advisory learning line", () => {
  const nonce = "a".repeat(64), other = "b".repeat(64);
  const asked = [ANSWER, APP];
  const line = (body: unknown, prefix = LEARN_PREFIX) => `${prefix}${JSON.stringify(body)}`;
  const ok = line({ nonce, results: [{ identity: ANSWER, state: "failed" }] });
  test.each([
    ["no line", "checks ran\n", "the check printed no learning line"],
    ["another run's nonce", `${line({ nonce: other, results: [] })}\n`, "no learning line carried this run's nonce"],
    ["unreadable JSON", `${LEARN_PREFIX}{"nonce":\n`, "the learning line couldn't be read"],
    ["over 64 KiB", `${LEARN_PREFIX}${"x".repeat(LEARN_MAX_BYTES)}\n`, "the learning line was over 64 KiB"],
    ["an oversized line beside a valid one", `${LEARN_PREFIX}${"x".repeat(LEARN_MAX_BYTES)}\n${ok}\n`, "a learning line was over 64 KiB"],
    ["two lines", `${ok}\n${ok}\n`, "the check printed more than one learning line"],
    ["after the report", `TOOLROLL_CHECK_REPORT {}\n${ok}\n`, "the learning line came after the report"],
    ["an unknown state", `${line({ nonce, results: [{ identity: ANSWER, state: "flaky" }] })}\n`, "the learning line doesn't match its contract"],
    ["an extra field", `${line({ nonce, results: [], verdict: "pass" })}\n`, "the learning line doesn't match its contract"],
    ["an identity it wasn't asked about", `${line({ nonce, results: [{ identity: "unit:src/x.test.ts::y", state: "passed" }] })}\n`, "the learning line named an identity it wasn't asked about"],
    ["a whole file", `${line({ nonce, results: [{ identity: "file:src/index.test.ts", state: "passed" }] })}\n`, "the learning line named an identity it wasn't asked about"],
    ["an identity twice", `${line({ nonce, results: [{ identity: ANSWER, state: "passed" }, { identity: ANSWER, state: "failed" }] })}\n`, "the learning line named an identity twice"],
  ])("%s: not recorded", (_name, stdout, why) => {
    expect(learningLinesOf(stdout, nonce, asked)).toEqual({ ok: false, why });
  });
  test("one valid line before the report, naming asked identities once, is read", () => {
    expect(learningLinesOf(`${ok}\nTOOLROLL_CHECK_REPORT {}\n`, nonce, asked)).toEqual({ ok: true, results: [{ identity: ANSWER, state: "failed" }] });
    // A line a test printed with another nonce beside it is passed over, as the report's own reading does.
    expect(learningLinesOf(`${line({ nonce: other, results: [] })}\n${ok}\n`, nonce, asked)).toMatchObject({ ok: true });
  });

  test("a flooded or malformed line leaves the same report, the same Full-check answer and the same outcome; only learning is lost", () => {
    const f = open();
    const units = PASSING;
    const plain = checked(f, units, { learn: [ANSWER] });
    const flooded = checked(f, units, { learn: [ANSWER], before: () => `${LEARN_PREFIX}${JSON.stringify({ nonce: "f".repeat(64), results: [] }).padEnd(LEARN_MAX_BYTES * 3, " ")}\n` });
    const malformed = checked(f, units, { learn: [ANSWER], before: nonce => `${LEARN_PREFIX}{"nonce":"${nonce}","results":[{"identity":"${ANSWER}","state":"passed"}],"verdict":"pass"}\n` });
    const inventory = (run: number) => readSealedJson(f.store, EVIDENCE(f), run, CHECK_INVENTORY_CAPTURE)!.value as SealedInventory;
    const answer = (run: number, report: typeof plain.report) => fullCheckProblem({ report, inventory: inventory(run), exitCode: 0 });
    const strip = (report: typeof plain.report) => ({ ...report!, nonce: "" });
    expect(answer(plain.runId, plain.report)).toBeNull();
    for (const one of [flooded, malformed]) {
      expect(strip(one.report)).toEqual(strip(plain.report));
      expect(answer(one.runId, one.report)).toBe(answer(plain.runId, plain.report));
      expect(one.status).toBe(plain.status);
      expect(runCheck(f, one.runId)).toEqual(runCheck(f, plain.runId));
      expect(checkFactOf(f.store, one.runId)).toMatchObject({ learnState: "not-recorded" });
      expect(rows(f, one.runId).filter(row => row.startsWith("learn"))).toEqual([]);
      expect(rows(f, one.runId)).toEqual(rows(f, plain.runId));
    }
    expect(checkFactOf(f.store, flooded.runId)!.learnWhy).toBe("the learning line was over 64 KiB");
    expect(checkFactOf(f.store, malformed.runId)!.learnWhy).toBe("the learning line doesn't match its contract");
    expect(checkFactOf(f.store, plain.runId)).toMatchObject({ learnState: "not-recorded", learnWhy: "the check printed no learning line" });
  });

  test("the request rides on its own handshake field: the gate's watch, inventory and context are the same without it", () => {
    const f = open();
    const a = sealedCheck(f, f.taskId, f.approved, () => reportOf([{ file: "src/index.test.ts" }, { file: "src/browser/app.test.ts" }]), { forceFull: true });
    const b = sealedCheck(f, f.taskId, f.approved, () => reportOf([{ file: "src/index.test.ts" }, { file: "src/browser/app.test.ts" }]), { forceFull: true, learn: [ANSWER, "file:src/index.test.ts", ANSWER] });
    expect(b.prepared.learn).toEqual([ANSWER]);
    expect(b.prepared.watch).toEqual(a.prepared.watch);
    expect(b.prepared.inventory).toEqual(a.prepared.inventory);
    expect(b.prepared.context).toEqual(a.prepared.context);
    const stdin = (one: typeof a) => { const { nonce: _n, learn: _l, ...rest } = JSON.parse(one.prepared.stdin) as Record<string, unknown>; return rest; };
    expect(stdin(b)).toEqual(stdin(a));
    expect(JSON.parse(b.prepared.stdin)).toMatchObject({ learn: [ANSWER] });
    expect(JSON.parse(a.prepared.stdin)).not.toHaveProperty("learn");
  });
});

describe("the harness's side (scripts/release-check.mjs)", () => {
  const nonce = "c".repeat(64);
  const handshake = (extra: Record<string, unknown> = {}) => parseHandshake(JSON.stringify({ nonce, mode: "full", plan: null, watch: [], owed: ["typecheck", "build", "unit"], ciSubstitute: false, ...extra }))!;
  const unitLines = [
    { kind: "unit-case", file: "src/index.test.ts", name: "answer", state: "failed", flaky: false },
    { kind: "unit-case", file: "src/index.test.ts", name: "other", state: "passed", flaky: false },
    { kind: "unit-file", file: "src/index.test.ts", state: "failed", passed: 1, failed: 1, skipped: 0, flaky: false },
    { kind: "unit-end", reason: "failed", errors: 0 },
  ];
  const journeyRuns = [{ script: "app", kind: "scripted", lines: [{ kind: "journey-group", script: "app", journeys: "scripted", group: "core", state: "passed", retried: false, unattributed: false, results: [{ name: "opens", state: "passed" }] }] }];
  const reportOfRun = (h: ReturnType<typeof handshake>) => buildReport({ handshake: h, exitCode: 1, parts: [], unitLines, reusedFromCI: false, journeyRuns, upgradeLines: null });

  test("learn never refuses a handshake, keeps exact cases only (at most 200) and never joins the watch", () => {
    for (const learn of [undefined, "everything", 7, null, [1, null, {}]]) expect(handshake({ learn }), String(learn)).toMatchObject({ learn: [], watch: [] });
    const many = Array.from({ length: 250 }, (_, i) => `unit:src/a.test.ts::case ${i}`);
    const read = handshake({ learn: ["file:src/a.test.ts", "group:app:scripted:core", "part:unit", ...many, many[0]] });
    expect(read.learn).toEqual(many.slice(0, 200));
    expect(read.watch).toEqual([]);
  });

  test("the report is the same with and without a learning request; the learning line holds only what was asked and ran", () => {
    const asked = handshake({ learn: ["unit:src/index.test.ts::other", "journey:app:scripted:core::opens", "unit:src/index.test.ts::never-ran"] });
    expect(reportOfRun(asked)).toEqual(reportOfRun(handshake()));
    expect(reportLine(reportOfRun(asked))).toBe(reportLine(reportOfRun(handshake())));
    // The passing case it asked about isn't in the report (only a watch puts it there): it's only on the learning line.
    expect(JSON.stringify(reportOfRun(asked))).not.toContain("\"other\"");
    const learned = learnLine({ handshake: asked, unitLines, journeyRuns })!;
    expect(learned.startsWith(LEARN_PREFIX)).toBe(true);
    expect(JSON.parse(learned.slice(LEARN_PREFIX.length))).toEqual({ nonce, results: [{ identity: "unit:src/index.test.ts::other", state: "passed" }, { identity: "journey:app:scripted:core::opens", state: "passed" }] });
    expect(learningLinesOf(`${learned}\n${reportLine(reportOfRun(asked))}\n`, nonce, asked.learn)).toMatchObject({ ok: true });
    expect(learnLine({ handshake: handshake(), unitLines, journeyRuns })).toBeNull();
  });

  test("a learning line that would be over 64 KiB isn't printed", () => {
    const long = Array.from({ length: 200 }, (_, i) => `unit:src/index.test.ts::${"n".repeat(400)} ${i}`);
    const lines = long.map(id => ({ kind: "unit-case", file: "src/index.test.ts", name: id.slice("unit:src/index.test.ts::".length), state: "passed", flaky: false }));
    expect(learnLine({ handshake: handshake({ learn: long }), unitLines: lines, journeyRuns: [] })).toBeNull();
    expect(learnLine({ handshake: handshake({ learn: long.slice(0, 10) }), unitLines: lines, journeyRuns: [] })).not.toBeNull();
  });
});

describe("tracked identities", () => {
  test("a project's Full checks ask about its recent observations' exact cases, newest first, at most 200; the rest are counted", () => {
    const f = open();
    const at = (days: number) => new Date(RELEASE_NOW.getTime() - days * 24 * 60 * 60 * 1000);
    expect(watchObservation(f.store, { repo: f.repo, identity: ANSWER, observation: 1, now: at(10) })).toBe(true);
    expect(watchObservation(f.store, { repo: f.repo, identity: ANSWER, observation: 1, now: at(1) })).toBe(false);
    watchObservation(f.store, { repo: f.repo, identity: APP, observation: 2, now: at(2) });
    watchObservation(f.store, { repo: f.repo, identity: "file:src/old.test.ts", observation: 3, now: at(1) });
    watchObservation(f.store, { repo: f.repo, identity: "unit:src/old.test.ts::stale", observation: 4, now: at(120) });
    watchObservation(f.store, { repo: "/other/project", identity: "unit:src/z.test.ts::z", observation: 5, now: at(1) });
    expect(learnRequestFor(f.store, f.repo, RELEASE_NOW)).toEqual({ learn: [APP, ANSWER], leftOut: 0 });
    for (let i = 0; i < 210; i++) watchObservation(f.store, { repo: f.repo, identity: `unit:src/many.test.ts::case ${i}`, observation: 100 + i, now: at(3) });
    const asked = learnRequestFor(f.store, f.repo, RELEASE_NOW);
    expect(asked.learn).toHaveLength(200);
    // The oldest-tracked are the ones left out, and counted.
    expect(asked.learn[0]).toBe(APP);
    expect(asked.learn).not.toContain(ANSWER);
    expect(asked.leftOut).toBe(12);
    expect(() => watchObservation(f.store, { repo: f.repo, identity: "", observation: 1, now: RELEASE_NOW })).toThrow();
  });
});
