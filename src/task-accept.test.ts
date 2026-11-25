/** `task accept` names what it means (docs/plans/plain-toolroll.md P1.1): one contract table. Bare refuses for good;
 * `--despite "<reason>"` (with `--note` as its alias) is acceptance only and never completes; `--finish` and `--digest`
 * are exactly `task complete`'s exact-receipt completion, where `--json` and a scoped credential must pass `--digest`;
 * `--despite` with either of them refuses. Real CLI over a throwaway database. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { runOperate, EXIT } from "./operate.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { recordRunCheckLevel } from "./check-levels.js";
import { assignmentOf } from "./assignment.js";
import { FOLLOW_UP_LOG, FOLLOW_UP_RECEIPT } from "./result-follow-ups.js";
import { mintCoordinator } from "./coordinator.js";
import { assignmentStatusFacts, headlineOf } from "./task-status.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const REPO = "/repo/task-accept";
const HEAD = "c".repeat(40);
let dir = "", db = "", store: Store, lines: string[] = [], password = "";

const run = (argv: string[]) => {
  const [command = "", ...rest] = argv;
  lines = [];
  return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now: NOW });
};
const payload = () => JSON.parse(lines.join("\n")) as Record<string, unknown>;
const root = () => join(dir, "evidence");
const state = (id: string) => assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, root())?.state;
const receipt = (id: string) => assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, root())!.receipt!.digest;
const accepted = (run: number) => store.proofAcceptance(run) !== null;

/** A finished, checked build of `id`, ready for a person to accept. */
function built(id: string, exit = 0): number {
  store.createTask({ id, title: id }, NOW);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, NOW);
  const proposed = propose(store, { taskId: id, goal: `Do ${id}`, touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: NOW });
  const ok = approve(store, id, "alex", NOW, proposed.digest, password);
  if (!ok.ok) throw new Error(ok.reason);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "r", branch: `b-${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: NOW });
  store.stampRun(runId, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(runId, { headRevision: HEAD, handoff: "Done." });
  store.finishRun(runId, { outcome: "built", committed: true, now: NOW });
  store.setTaskState(id, "done", NOW);
  recordRunCheckLevel(store, { id: runId, taskId: id, repo: REPO }, "full", "project", NOW);
  store.saveProofVerdict(runId, "verified", [], NOW, [{ id: "c1", statement: "it works", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "true" }], review: null }] as never, "verified");
  storeEvidence(store, root(), runId, "terminal-diff", "diff.patch", Buffer.from("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n"), "git diff (exit 0)", NOW, { captureStatus: "ok" });
  storeEvidence(store, root(), runId, "check-log", "checks.txt", Buffer.from("1 passed\n"), "true", NOW, { captureStatus: "ok" });
  sealVerificationReceipt(store, root(), runId, HEAD, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: exit }, NOW);
  store.recordRunCheck(runId, { status: exit === 0 ? "passed" : "failed", exitCode: exit, suites: [] }, NOW);
  return runId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-task-accept-"));
  db = join(dir, "orders.db");
  store = openStore(db);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  password = alex.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
  store.setVerifyCommand({ repo: REPO, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
});
afterEach(() => {
  vi.unstubAllEnvs();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const as = () => ["--as", "alex", "--token", password];

describe("task accept: what each call means", () => {
  test("the contract table", async () => {
    type Row = { argv: (id: string) => string[]; code: number; reason?: string; completes: boolean; accepts: boolean };
    const rows: Record<string, Row> = {
      "bare refuses, naming --finish and --despite": { argv: id => ["task", "accept", id, ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--note is --despite: acceptance only": { argv: id => ["task", "accept", id, "--note", "Looked at it myself", ...as(), "--json"], code: EXIT.ok, completes: false, accepts: true },
      "--despite records the acceptance and never completes": { argv: id => ["task", "accept", id, "--despite", "Looked at it myself", ...as(), "--json"], code: EXIT.ok, completes: false, accepts: true },
      "an empty --despite reason refuses": { argv: id => ["task", "accept", id, "--despite", " ", ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--despite with --finish refuses": { argv: id => ["task", "accept", id, "--despite", "why", "--finish", ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--despite with --digest refuses": { argv: id => ["task", "accept", id, "--despite", "why", "--digest", receipt(id), ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--note with --finish refuses": { argv: id => ["task", "accept", id, "--note", "why", "--finish", ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--finish under --json without --digest refuses": { argv: id => ["task", "accept", id, "--finish", ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--finish at a person's terminal completes the exact receipt": { argv: id => ["task", "accept", id, "--finish", ...as()], code: EXIT.ok, completes: true, accepts: false },
      "--digest completes exactly that receipt": { argv: id => ["task", "accept", id, "--digest", receipt(id), ...as(), "--json"], code: EXIT.ok, completes: true, accepts: false },
      "--finish --digest completes exactly that receipt": { argv: id => ["task", "accept", id, "--finish", "--digest", receipt(id), ...as(), "--json"], code: EXIT.ok, completes: true, accepts: false },
      "a --digest that isn't the receipt refuses": { argv: id => ["task", "accept", id, "--digest", "f".repeat(64), ...as(), "--json"], code: EXIT.refused, completes: false, accepts: false },
    };
    let n = 0;
    for (const [name, row] of Object.entries(rows)) {
      const id = `t-${++n}`;
      const runId = built(id);
      const code = await run(row.argv(id));
      expect(code, name).toBe(row.code);
      if (row.reason !== undefined) expect(payload()["reason"], name).toBe(row.reason);
      expect(state(id) === "complete", `${name}: completes`).toBe(row.completes);
      expect(accepted(runId), `${name}: accepts`).toBe(row.accepts);
    }
  });

  test("bare says what each flag means", async () => {
    built("t-bare");
    await run(["task", "accept", "t-bare", ...as()]);
    expect(lines.join("\n")).toMatch(/--finish[\s\S]*--despite/);
  });

  test("a scoped credential completes only with --digest, as task complete does", async () => {
    built("t-lead");
    const minted = mintCoordinator(store, { name: "lead", repos: [REPO], by: "alex", now: new Date() });
    if (!minted.ok) throw new Error(minted.reason);
    vi.stubEnv("SO_TEST_LEAD", minted.token);
    expect(await run(["assignment", "claim", "t-lead", "--token-env", "SO_TEST_LEAD", "--json"]), lines.join("\n")).toBe(EXIT.ok);
    expect(await run(["task", "accept", "t-lead", "--finish", "--token-env", "SO_TEST_LEAD"])).toBe(EXIT.usage);
    expect(state("t-lead")).not.toBe("complete");
    expect(await run(["task", "accept", "t-lead", "--digest", receipt("t-lead"), "--token-env", "SO_TEST_LEAD", "--json"]), lines.join("\n")).toBe(EXIT.ok);
    expect(payload()["command"]).toBe("task accept");
    expect(state("t-lead")).toBe("complete");
  });
});

/** A completion is history (everyday-8 #7): changing the check command later never reopens it, while anything that
 * changes the result, its scope or its evidence still does, and nothing that needs today's exact receipt counts it. */
describe("a completion stays complete when the check command changes", () => {
  const LATER = new Date(NOW.getTime() + 60_000);
  const snapshot = (id: string) => assignmentOf(store, id, LATER, { principal: "operator", repos: [REPO] }, root())!;
  const complete = async (id: string) => {
    expect(await run(["task", "accept", id, "--finish", ...as()]), lines.join("\n")).toBe(EXIT.ok);
    expect(state(id)).toBe("complete");
  };

  test("replaced or cleared: still complete, under its own digest, never today's receipt", async () => {
    for (const [id, change] of [
      ["t-replaced", () => store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, LATER)],
      ["t-cleared", () => store.clearVerifyCommand(REPO, "alex", LATER)],
    ] as const) {
      built(id);
      await complete(id);
      const sealed = receipt(id);
      change();
      const after = snapshot(id);
      expect(after.state, id).toBe("complete");
      expect(after.completion?.historical, id).toBe(true);
      expect(after.completion?.digest, id).toBe(sealed);
      // Deploy and release compare the completion with the exact receipt they read now: it isn't this one.
      expect(after.receipt?.digest, id).not.toBe(sealed);
      expect(headlineOf(assignmentStatusFacts(after)), id).toBe("Complete");
      store.setVerifyCommand({ repo: REPO, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    }
  });

  test("a task finished before any check command existed stays complete when one is set", async () => {
    store.clearVerifyCommand(REPO, "alex", NOW);
    store.createTask({ id: "t-none", title: "t-none" }, NOW);
    const ref = store.refFor("built-in", "t-none").id;
    store.placeTask(ref, REPO, {}, NOW);
    const proposed = propose(store, { taskId: "t-none", goal: "Do it", touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: NOW });
    if (!approve(store, "t-none", "alex", NOW, proposed.digest, password).ok) throw new Error("approve");
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    const runId = store.startRun({ taskRef: ref, leaseId: "l-none", runner: "r", branch: "b-none", worktree: "/pool/none", route: authority.stamp, now: NOW });
    store.stampRun(runId, { scopeDigest: store.getScope("t-none")!.digest, baseRevision: "1".repeat(40) });
    store.recordOutcomeFacts(runId, { headRevision: HEAD, handoff: "Done." });
    store.finishRun(runId, { outcome: "built", committed: true, now: NOW });
    store.setTaskState("t-none", "done", NOW);
    recordRunCheckLevel(store, { id: runId, taskId: "t-none", repo: REPO }, "full", "project", NOW);
    expect(await run(["task", "accept", "t-none", "--despite", "Read the diff myself", ...as()]), lines.join("\n")).toBe(EXIT.ok);
    await complete("t-none");
    store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, LATER);
    expect(snapshot("t-none").state).toBe("complete");
  });

  test("Run checks after completing (everyday-9 A2): its own log and receipt never reopen it; any other later evidence does", async () => {
    const runId = built("t-recheck");
    await complete("t-recheck");
    // A project with no pull requests: Accept says what's next (everyday-9 A4).
    expect(lines.join("\n")).toContain("Next: toolroll task land t-recheck");
    const sealed = receipt("t-recheck");
    storeEvidence(store, root(), runId, "structured-output", "follow-up-check-1.log", Buffer.from("1 failed\n"), FOLLOW_UP_LOG, LATER, { captureStatus: "ok" });
    storeEvidence(store, root(), runId, "structured-output", "follow-up-check-1.json", Buffer.from("{}"), FOLLOW_UP_RECEIPT, LATER, { captureStatus: "ok" });
    const after = snapshot("t-recheck");
    expect(after.state).toBe("complete");
    expect(after.completion?.digest).toBe(sealed);
    // Something else saved on the result later is changed evidence: not covered by the completion.
    storeEvidence(store, root(), runId, "structured-output", "other.json", Buffer.from("{}"), "something else", LATER, { captureStatus: "ok" });
    expect(snapshot("t-recheck").state).not.toBe("complete");
  });

  test("changed scope or damaged evidence still reopens it", async () => {
    built("t-scope");
    await complete("t-scope");
    store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, LATER);
    propose(store, { taskId: "t-scope", goal: "Do something else", touches: ["src/b.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: LATER });
    expect(snapshot("t-scope").state).not.toBe("complete");

    store.setVerifyCommand({ repo: REPO, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    const runId = built("t-damaged");
    await complete("t-damaged");
    store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, LATER);
    const log = store.artifactsFor(runId).find(a => a.kind === "check-log")!;
    rmSync(join(root(), log.key), { force: true });
    expect(snapshot("t-damaged").state).not.toBe("complete");
  });
});

/** Accept owes exactly what the completion's own rule says (everyday-8 #5, assignment.ts owedAcceptance): a person's own
 * check needs no reason, an exception does, a failed check is a hard stop, and a stale result refuses. */
describe("what Accept and finish owes", () => {
  const MANUAL = (id: string) => `criterion "${id}" requires manual-review evidence — an operator must accept it before this can verify`;
  const c1 = { id: "c1", statement: "it works", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "true" }], review: null };
  const shapes = {
    "a person's own check": (runId: number) => store.saveProofVerdict(runId, "short", [MANUAL("c2")], NOW, [c1, { id: "c2", statement: "Reads well on a phone", requiredEvidence: ["manual-review"], state: "manual-review",
      detail: [MANUAL("c2")], answered: [{ kind: "manual-review", ref: "Looked at it" }], review: null }] as never, "short"),
    "an exception": (runId: number) => store.saveProofVerdict(runId, "short", ["no proof for c2"], NOW, [c1, { id: "c2", statement: "Reads well on a phone", requiredEvidence: ["screenshot"], state: "missing",
      detail: ["no proof for c2"], answered: [], review: null }] as never, "short"),
  };
  const rows: Array<{ name: string; shape: keyof typeof shapes; note: string | null; stale?: true; owes: string; ok: boolean; reason?: string }> = [
    { name: "own check, no note: completes", shape: "a person's own check", note: null, owes: "person-check", ok: true },
    { name: "exception, no reason: refused", shape: "an exception", note: null, owes: "exception", ok: false, reason: "needs-reason" },
    { name: "exception with a reason: completes", shape: "an exception", note: "Checked it on a phone myself", owes: "exception", ok: true },
    { name: "a stale result: refused", shape: "a person's own check", note: null, stale: true, owes: "person-check", ok: false, reason: "stale" },
  ];
  test("the table", async () => {
    const { verifyApproverByPassword } = await import("./principal.js");
    const { acceptAndCompleteAsOperator, owedAcceptance } = await import("./assignment.js");
    let n = 0;
    for (const row of rows) {
      const id = `owe-${++n}`;
      const runId = built(id);
      shapes[row.shape](runId);
      const read = assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, root())!;
      expect(owedAcceptance(read.receipt, read.readiness?.blockers ?? []), row.name).toBe(row.owes);
      const who = verifyApproverByPassword(store, "alex", password, [REPO]);
      if (!who.ok) throw new Error("alex");
      const done = acceptAndCompleteAsOperator(store, id, { runId, receiptDigest: row.stale ? "f".repeat(64) : read.receipt!.digest, note: row.note }, who.who, NOW, root());
      expect(done.ok, row.name).toBe(row.ok);
      if (!done.ok) expect(done.reason, row.name).toBe(row.reason);
      expect(state(id) === "complete", row.name).toBe(row.ok);
    }
  });

  test("a failed check is a hard stop: no reason makes it complete", async () => {
    const { verifyApproverByPassword } = await import("./principal.js");
    const { acceptAndCompleteAsOperator } = await import("./assignment.js");
    const runId = built("owe-failed", 1);
    store.saveProofVerdict(runId, "refuted", ["the project's check failed (exit 1)"], NOW, [] as never, "refuted");
    const read = assignmentOf(store, "owe-failed", NOW, { principal: "operator", repos: [REPO] }, root())!;
    const who = verifyApproverByPassword(store, "alex", password, [REPO]);
    if (!who.ok) throw new Error("alex");
    expect(acceptAndCompleteAsOperator(store, "owe-failed", { runId, receiptDigest: read.receipt!.digest, note: "I'm sure" }, who.who, NOW, root()).ok).toBe(false);
    expect(state("owe-failed")).not.toBe("complete");
  });
});

/** Task ids as people type them (everyday-8 #9): the screens never show the generated `task-` prefix. Exact first, then
 * exactly `task-<typed>`; never a prefix match. */
describe("task show takes the id with or without task-", () => {
  test("the table", async () => {
    store.createTask({ id: "task-bb9f68bbbed6a0b0", title: "Add a subtract" }, NOW);
    store.createTask({ id: "bb9f", title: "A task named like a prefix" }, NOW);
    expect(await run(["task", "show", "bb9f68bbbed6a0b0", "--json"])).toBe(EXIT.ok);
    expect(payload()["id"] ?? (payload()["task"] as Record<string, unknown> | undefined)?.["id"]).toBe("task-bb9f68bbbed6a0b0");
    expect(await run(["task", "show", "task-bb9f68bbbed6a0b0", "--json"])).toBe(EXIT.ok);
    // The exact id wins over a generated one; a prefix of an id names nothing.
    expect(await run(["task", "show", "bb9f", "--json"])).toBe(EXIT.ok);
    expect(JSON.stringify(payload())).toContain("A task named like a prefix");
    expect(await run(["task", "show", "bb9f68", "--json"])).toBe(EXIT.refused);
  });
});
