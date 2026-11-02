import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
// @ts-expect-error plain ESM script without declarations
import { deploymentCandidate, reserveDeployment, reserveOnWritable } from "../scripts/deploy-candidate.mjs";
// @ts-expect-error plain ESM script without declarations
import { openDeploymentDatabase } from "../scripts/deploy-phases.mjs";
import { provableCandidate } from "../test/deploy-candidate-fixture.js";
import { assignmentOf } from "./assignment.js";
import * as installedScope from "./scope.js";
import { Store } from "./store.js";
import { verificationEvidence } from "./verification-evidence.js";
import { mixedCheckScreenshot } from "../test/status-evidence-fixture.js";
import { completionBlockersOf } from "./task-status.js";

const HEAD = "a".repeat(40);
const COMMAND = "npm run verify";
const DIGEST = "scope-digest";

type Run = { id: number; taskRef: number; role: string; outcome: string; headRevision: string; scopeDigest: string; worktree: string };

type PersonAnswer = { ok: true; by: string; at: string; method: string } | { ok: false; why: string };
const PERSON: PersonAnswer = { ok: true, by: "alex", at: "2026-10-24T09:00:00.000Z", method: "password-now" };

/** What the candidate check wrote to the plane: the deploy reservation, and nothing else. */
const written: [string, unknown[]][] = [];
function fixture(runs: Run[], receipts: Record<number, object | null>, readiness: { blockers: { key: string; message: string }[] } | null = { blockers: [] }, person: PersonAnswer | null = PERSON, archived = false, tables = archived) {
  const store = {
    getRun: (id: number) => runs.find(one => one.id === id) ?? null,
    runsFor: (taskRef: number) => runs.filter(one => one.taskRef === taskRef).sort((a, b) => b.id - a.id),
    refById: () => ({ externalId: "t1", repo: "/repo" }),
    getScope: () => ({ digest: DIGEST, approvedDigest: DIGEST, candidate: HEAD, acceptance: [] }),
    liveVerifyCommand: () => ({ command: COMMAND }),
    proofVerdictFor: () => null,
    proofAcceptance: () => null,
    // A plane with no release tables: no task belongs to a release. `archived`: the plane has put this task away (v145).
    handle: { prepare: (sql: string) => ({ get: () => (tables && /sqlite_master/.test(sql)) || (archived && /FROM task_archive/.test(sql)) ? { hit: 1 } : undefined, run: (...args: unknown[]) => { written.push([sql, args]); } }) },
  };
  const deps = {
    verificationEvidence: (_store: unknown, _root: string, runId: number) => {
      const receipt = receipts[runId];
      return receipt ? { ok: true, bytes: JSON.stringify(receipt), digest: `gate-${runId}` } : { ok: false, bytes: null, problem: "no receipt" };
    },
    assignmentOf: () => ({ state: "complete", receipt: { runId: 2, head: HEAD, scopeDigest: DIGEST, digest: "r" }, completion: { digest: "r" }, readiness }),
    ...(person === null ? {} : { installedScope: { personApprovalOf: () => person } }),
  };
  return (runId: number) => deploymentCandidate(store, { runId, head: HEAD, evidenceRoot: "/evidence", now: new Date() }, deps);
}

const built: Run = { id: 1, taskRef: 7, role: "builder", outcome: "built", headRevision: HEAD, scopeDigest: "old-digest", worktree: "/w1" };
const regate: Run = { id: 2, taskRef: 7, role: "builder", outcome: "no-change", headRevision: HEAD, scopeDigest: DIGEST, worktree: "/w2" };
const passing = { run: 2, head: HEAD, scopeDigest: DIGEST, result: { ran: true, exitCode: 0 }, command: { command: COMMAND } };

describe("deploymentCandidate", () => {
  test("a put-away task deploys nothing, read from the plane; a plane from before put-away has nothing put away", () => {
    written.length = 0;
    expect(() => fixture([built, regate], { 2: passing }, { blockers: [] }, PERSON, true)(2)).toThrow("This task is put away. Restore it before deploying.");
    expect(written).toEqual([]);
    expect(fixture([built, regate], { 2: passing })(2)).toMatchObject({ taskId: "t1" });
    // A plane without the put-away tables (this fixture's) is never written to.
    expect(written).toEqual([]);
    // With them, the proofs still only read: the reservation is reserveDeployment's own write on a writable handle.
    expect(fixture([built, regate], { 2: passing }, { blockers: [] }, PERSON, false, true)(2)).toMatchObject({ taskId: "t1", taskRef: 7, runId: 2 });
    expect(written).toEqual([]);
  });
  test("a passing gate cannot cover an invalid screenshot on a row whose check reference is missing", () => {
    const blockers = completionBlockersOf({ report: false, checks: { status: "passed", exitCode: 0, level: "full" }, checkRequired: true,
      matrix: [mixedCheckScreenshot({ path: "", ok: false, problem: "wrong file kind" })], verdict: "short", accepted: false, high: 0 });
    expect(() => fixture([built, regate], { 2: passing }, { blockers })(2)).toThrow("isn't ready to deploy");
  });
  test("a regate of the last built commit deploys on its own passing receipt", () => {
    const result = fixture([built, regate], { 2: passing })(2);
    expect(result).toMatchObject({ taskId: "t1", scopeDigest: DIGEST, gateDigest: "gate-2", worktree: "/w2" });
  });

  test("a no-change run without a passing receipt is refused", () => {
    expect(() => fixture([built, regate], {})(2)).toThrow("Native check unavailable: no receipt.");
    const failed = { ...passing, result: { ran: true, exitCode: 1 } };
    expect(() => fixture([built, regate], { 2: failed })(2)).toThrow("did not pass this candidate");
  });

  test("a completed result with a failed or missing check, an unresolved requirement or a HIGH finding is refused", () => {
    for (const blocker of [
      { key: "check-failed", message: "Checks failed (exit 1). Fix them and run checks again, or ask for changes." },
      { key: "check-missing", message: "No passing project check is recorded for this result. Run checks on it, then mark it complete." },
      { key: "criteria", message: "This requirement isn't met: Refunds post. Ask for changes, or accept the result with a reason." },
      { key: "high", message: "The automatic review found a high-severity problem. Ask for changes before marking it complete." },
    ]) expect(() => fixture([built, regate], { 2: passing }, { blockers: [blocker] })(2)).toThrow(`This result isn't ready to deploy: ${blocker.message}`);
    // A result whose readiness can't be read is never assumed ready.
    expect(() => fixture([built, regate], { 2: passing }, null)(2)).toThrow("readiness could not be read");
  });

  test("only a person's approval deploys; an installed runtime too old to ask is answered from the plane's records", () => {
    expect(fixture([built, regate], { 2: passing })(2)).toMatchObject({ approvedBy: "alex" });
    expect(() => fixture([built, regate], { 2: passing }, { blockers: [] }, { ok: false, why: "approved by the lead, not by a person" })(2))
      .toThrow("A person has to approve this candidate's scope: approved by the lead, not by a person.");
    // No installed answer: the records decide, and this scope has no recorded approval.
    expect(() => fixture([built, regate], { 2: passing }, { blockers: [] }, null)(2)).toThrow("A person has to approve this candidate's scope: not approved yet.");
  });

  test("a no-change run that is not a regate of the last built commit is refused", () => {
    expect(() => fixture([regate], { 2: passing })(2)).toThrow("Run 2 is not a built candidate");
    const elsewhere = { ...built, headRevision: "b".repeat(40) };
    expect(() => fixture([elsewhere, regate], { 2: passing })(2)).toThrow("Run 2 is not a built candidate");
  });
});

/**
 * The deployment as scripts/deploy-browser.mjs runs it, on a real plane database (v145 tables present): every phase
 * proves the candidate on a READ-ONLY handle (the 0.9.86 deploy died there: the proofs wrote the reservation, SQLITE
 * readonly), then reserves it on a short-lived writable one.
 */
describe("the deployment's reservation against being put away", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const plane = () => {
    const root = mkdtempSync(join(tmpdir(), "toolroll-deploy-reserve-"));
    roots.push(root);
    const database = join(root, "orders.db");
    const { runId, head, now } = provableCandidate(database);
    return { database, runId, head, now, evidenceRoot: join(root, "evidence") };
  };
  const facts = (p: ReturnType<typeof plane>, db: DatabaseSync) => deploymentCandidate(new Store(db), { runId: p.runId, head: p.head, evidenceRoot: p.evidenceRoot, now: p.now },
    { assignmentOf, verificationEvidence, installedScope });
  const rows = (database: string) => { const db = new DatabaseSync(database, { readOnly: true }); try { return db.prepare("SELECT task_ref, run, at FROM deploy_in_flight").all(); } finally { db.close(); } };
  const putAway = (database: string, taskRef: number) => {
    const db = new DatabaseSync(database);
    try { db.prepare("INSERT INTO task_archive (task_ref, by, by_kind, rule, reason, at) VALUES (?, 'alex', 'person', NULL, 'done', ?)").run(taskRef, new Date().toISOString()); } finally { db.close(); }
  };
  /** deploy-browser.mjs proveAndReserve: read-only proofs, then the reservation on its own writable handle. */
  const proveAndReserve = (p: ReturnType<typeof plane>, at: Date) => {
    const ro = openDeploymentDatabase(p.database, { readOnly: true });
    let proven;
    try { proven = facts(p, ro); } finally { ro.close(); }
    reserveOnWritable(() => openDeploymentDatabase(p.database), (db: DatabaseSync) => new Store(db), { runId: p.runId, taskRef: proven.taskRef, now: at });
    return proven;
  };

  test("the proofs run on a read-only handle with the put-away tables present, and write nothing", () => {
    const p = plane();
    const ro = new DatabaseSync(p.database, { readOnly: true });
    try { expect(facts(p, ro)).toMatchObject({ taskId: "deploy-me", runId: p.runId }); } finally { ro.close(); }
    expect(rows(p.database)).toEqual([]);
  });

  test("reserveDeployment writes the row, is idempotent (a refresh moves its time), and refuses a put-away task", () => {
    const p = plane();
    const ro = new DatabaseSync(p.database, { readOnly: true });
    let taskRef: number;
    try { taskRef = facts(p, ro).taskRef; } finally { ro.close(); }
    const db = new DatabaseSync(p.database);
    try {
      const store = new Store(db);
      expect(reserveDeployment(store, { runId: p.runId, taskRef, now: new Date("2026-11-01T10:00:00.000Z") })).toEqual({ reserved: true });
      expect(reserveDeployment(store, { runId: p.runId, taskRef, now: new Date("2026-11-01T10:05:00.000Z") })).toEqual({ reserved: true });
      expect(rows(p.database)).toEqual([{ task_ref: taskRef, run: p.runId, at: "2026-11-01T10:05:00.000Z" }]);
      // A run of another task can't reserve this one.
      expect(() => reserveDeployment(store, { runId: p.runId, taskRef: taskRef + 99, now: new Date() })).toThrow("no longer belongs");
    } finally { db.close(); }
    putAway(p.database, taskRef);
    const again = new DatabaseSync(p.database);
    try {
      expect(() => reserveDeployment(new Store(again), { runId: p.runId, taskRef, now: new Date("2026-11-01T10:10:00.000Z") })).toThrow("This task is put away. Restore it before deploying.");
    } finally { again.close(); }
    // The refused refresh changed nothing.
    expect(rows(p.database)).toEqual([{ task_ref: taskRef, run: p.runId, at: "2026-11-01T10:05:00.000Z" }]);
  });

  test("a read-only handle can't reserve: it refuses, never skips", () => {
    const p = plane();
    const ro = new DatabaseSync(p.database, { readOnly: true });
    try {
      const taskRef = facts(p, ro).taskRef;
      expect(() => reserveDeployment(new Store(ro), { runId: p.runId, taskRef, now: new Date() })).toThrow(/readonly/);
    } finally { ro.close(); }
    expect(() => reserveOnWritable(() => { throw Error("unable to open database file"); }, (db: DatabaseSync) => new Store(db), { runId: p.runId, taskRef: 1, now: new Date() }))
      .toThrow("The deployment can't reserve this task against being put away: the plane's database didn't open for writing (unable to open database file).");
    expect(rows(p.database)).toEqual([]);
  });

  test("a plane from before put-away (no task_archive) has nothing to reserve against", () => {
    const db = new DatabaseSync(":memory:");
    try { expect(reserveDeployment({ handle: db, getRun: () => null }, { runId: 1, taskRef: 1, now: new Date() })).toEqual({ reserved: false }); } finally { db.close(); }
  });

  test("each proving phase (entry, then a resumed finish) proves read-only and refreshes the reservation; a put away stops the next phase", () => {
    const p = plane();
    const entry = proveAndReserve(p, new Date("2026-11-01T10:00:00.000Z"));
    expect(rows(p.database)).toEqual([{ task_ref: entry.taskRef, run: p.runId, at: "2026-11-01T10:00:00.000Z" }]);
    proveAndReserve(p, new Date("2026-11-01T10:20:00.000Z"));
    expect(rows(p.database)).toEqual([{ task_ref: entry.taskRef, run: p.runId, at: "2026-11-01T10:20:00.000Z" }]);
    putAway(p.database, entry.taskRef);
    expect(() => proveAndReserve(p, new Date("2026-11-01T10:25:00.000Z"))).toThrow("This task is put away. Restore it before deploying.");
  });
});
