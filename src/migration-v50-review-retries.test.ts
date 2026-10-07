/**
 * Schema v50 (bounded review retries): `run.review_attempt` and
 * `review_request.reviewer_run` arrive additively, v29's one-root-ever
 * index is replaced by four exact backstops, and ONE data pass makes every
 * existing root reviewer attempt 1 of its source and binds it to the one
 * request v49's admission spent on it. Historical row ids, outcomes,
 * comments, judgements, and evidence bindings are byte for byte what they
 * were; reopening is idempotent and foreign-key clean; a predecessor shape
 * the pass cannot prove refuses the open in words.
 */
import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, openStoreNoMigrate, REVIEW_ROOT_ATTEMPTS, SCHEMA_VERSION, type Database, type Store } from "./store.js";
import { storeEvidence } from "./evidence.js";
import { register } from "./runner.js";
import { addApprover } from "./scope.js";
import type { CriterionMatrixRow } from "./proof.js";

const T0 = new Date("2026-09-11T12:00:00.000Z");
const REPO = "/repos/history";
const PATCH = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+guarded\n";
const LEGACY = { routeDigest: "legacy", chosen: "legacy" as const };

/** v49's review_request shape, verbatim from that build's DDL. */
const V49_REVIEW_REQUEST_DDL = `CREATE TABLE review_request (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run             INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  requested_by    TEXT NOT NULL,
  basis           TEXT NOT NULL DEFAULT 'human' CHECK (basis IN ('human','mode')),
  mode_digest     TEXT,
  route_digest    TEXT,
  requested_at    TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_reason TEXT
)`;
const V50_INDEXES = ["root_review_attempt_ordinal", "one_live_root_review_per_source", "one_successful_root_review_per_source", "one_correction_per_reviewer", "one_root_review_per_request"];

type Seeded = { taskRef: number; reviewed: number; reviewedRoot: number; correction: number; failed: number; failedRoot: number; unrun: number; requests: number[] };

/** A v50 store carrying every review shape v49 could have written: one
 * source with a landed review (root + one correction child, comments and
 * judgements bound), one whose root failed, and one whose request was
 * spent without a run. */
function seed(store: Store, evidenceRoot: string): Seeded {
  addApprover(store, "alex", T0);
  register(store, { name: "worker", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-worker" });
  store.createTask({ id: "history", title: "Historical work" }, T0);
  const taskRef = store.refFor("built-in", "history").id;
  store.placeTask(taskRef, REPO);
  const built = (lease: string): number => {
    const id = store.startRun({ taskRef, leaseId: lease, runner: "worker", branch: "history", worktree: "/past", now: T0, route: { ...LEGACY, phase: "build", provider: "claude", model: null } });
    storeEvidence(store, evidenceRoot, id, "terminal-diff", "terminal-diff.patch", Buffer.from(PATCH, "utf8"), "git diff (exit 0)", T0, { captureStatus: "ok" });
    store.recordOutcomeFacts(id, { headRevision: `head-${lease}`, handoff: "done" });
    store.finishRun(id, { outcome: "built", committed: true, now: T0 });
    return id;
  };
  const ask = (run: number): number => {
    const asked = store.requestReview(run, "alex", T0);
    if (!asked.ok) throw new Error(asked.reason);
    return asked.id;
  };
  const admit = (request: number): number => {
    const admitted = store.admitReview(request, { runner: "worker", token: "tok-worker", provider: "claude", model: null }, T0);
    if (!admitted.ok) throw new Error(admitted.reason);
    store.stampProviderStart(admitted.reviewerRunId, T0);
    return admitted.reviewerRunId;
  };
  const requests: number[] = [];

  // Source 1: a landed review, authored by a same-session correction child.
  const reviewed = built("lease-reviewed");
  const matrix: CriterionMatrixRow[] = [{ id: "c1", statement: "guarded", requiredEvidence: ["manual-review"], state: "manual-review", detail: [], answered: [], review: null }];
  store.saveProofVerdict(reviewed, "short", ["needs review"], T0, matrix);
  requests.push(ask(reviewed));
  const reviewedRoot = admit(requests[0]!);
  store.stampRun(reviewedRoot, { sessionId: "session-1" });
  const provenance = store.runRoute(reviewedRoot)!;
  const admittedCorrection = store.admitCorrection({
    taskRef, leaseId: store.getRun(reviewedRoot)!.leaseId, runner: "worker", provider: "claude", sessionId: "session-1", parentRun: reviewedRoot,
    route: { routeDigest: provenance.routeDigest, phase: provenance.phase, provider: provenance.provider, model: provenance.model, chosen: provenance.chosen }, now: T0,
  });
  if (!admittedCorrection.ok) throw new Error(admittedCorrection.problem);
  const correction = admittedCorrection.runId;
  store.stampProviderStart(correction, T0);
  const diff = store.artifactsFor(reviewed).find(one => one.kind === "terminal-diff")!;
  store.ingestReview(
    {
      reviewerRunId: correction, runId: reviewed, artifactId: diff.id, author: "reviewer:claude",
      comments: [{ path: "src/a.ts", line: 1, note: "guarded indeed", severity: "note" }],
      judgements: [{ id: "c1", judgement: "upholds", note: "shown" }],
      bindings: { diffSha: diff.sha256, scopeDigest: null, headSha: "head-lease-reviewed", proof: null, checkLog: null, screenshots: [] },
    },
    T0,
  );
  store.stampReviewRequestOutcome(requests[0]!, "reviewed");

  // Source 2: a root that failed.
  const failed = built("lease-failed");
  requests.push(ask(failed));
  const failedRoot = admit(requests[1]!);
  store.finishRun(failedRoot, { outcome: "failed", reason: "reviewer-agent", now: T0 });
  store.stampReviewRequestOutcome(requests[1]!, "reviewer-agent");

  // Source 3: a request spent without a run.
  const unrun = built("lease-unrun");
  requests.push(ask(unrun));
  store.consumeReviewRequest(requests[2]!, "route-changed", T0);
  return { taskRef, reviewed, reviewedRoot, correction, failed, failedRoot, unrun, requests };
}

/** Wind a v50 file back to the exact v49 shape: no review_attempt, no
 * reviewer_run, v29's one_review_per_source in place of the v50 backstops. */
function windBackToV49(file: string, version: number): void {
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA foreign_keys = OFF");
  for (const index of V50_INDEXES) raw.exec(`DROP INDEX IF EXISTS ${index}`);
  raw.exec("ALTER TABLE run DROP COLUMN review_attempt");
  raw.exec("CREATE UNIQUE INDEX one_review_per_source ON run (parent_run) WHERE role = 'reviewer'");
  raw.exec("BEGIN");
  raw.exec(V49_REVIEW_REQUEST_DDL.replace("CREATE TABLE review_request", "CREATE TABLE review_request_v49"));
  raw.exec("INSERT INTO review_request_v49 (id, run, requested_by, basis, mode_digest, route_digest, requested_at, consumed_at, consumed_reason) SELECT id, run, requested_by, basis, mode_digest, route_digest, requested_at, consumed_at, consumed_reason FROM review_request");
  raw.exec("DROP TABLE review_request");
  raw.exec("ALTER TABLE review_request_v49 RENAME TO review_request");
  raw.exec("CREATE UNIQUE INDEX one_open_review_request ON review_request (run) WHERE consumed_at IS NULL");
  raw.exec("COMMIT");
  raw.exec("DROP TABLE service_cursor");
  raw.prepare("UPDATE schema_version SET version = ?").run(version);
  raw.close();
}

/** Wind a v50 file back to build 1513's shape: v50 in every respect but
 * the `origin` column — the file a replayed Strict producer could have
 * written a human-basis retry ask into. */
function windBackToPreOrigin(file: string): void {
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec("BEGIN");
  raw.exec(V49_REVIEW_REQUEST_DDL.replace("CREATE TABLE review_request", "CREATE TABLE review_request_1513").replace("consumed_reason TEXT", "consumed_reason TEXT,\n  reviewer_run    INTEGER REFERENCES run(id)"));
  raw.exec("INSERT INTO review_request_1513 (id, run, requested_by, basis, mode_digest, route_digest, requested_at, consumed_at, consumed_reason, reviewer_run) SELECT id, run, requested_by, basis, mode_digest, route_digest, requested_at, consumed_at, consumed_reason, reviewer_run FROM review_request");
  raw.exec("DROP TABLE review_request");
  raw.exec("ALTER TABLE review_request_1513 RENAME TO review_request");
  raw.exec("CREATE UNIQUE INDEX one_open_review_request ON review_request (run) WHERE consumed_at IS NULL");
  raw.exec("CREATE UNIQUE INDEX one_root_review_per_request ON review_request (reviewer_run) WHERE reviewer_run IS NOT NULL");
  raw.exec("COMMIT");
  raw.close();
}

const rows = (file: string, sql: string): Record<string, unknown>[] => {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return raw.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
};
const strip = (list: Record<string, unknown>[], ...columns: string[]) => list.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !columns.includes(key))));
const indexesOf = (file: string) => rows(file, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('run','review_request') ORDER BY name").map(row => String(row["name"]));

describe("schema v50: bounded review retries upgrade a v49 database without rewriting its history", () => {
  for (const epoch of [49, -49]) test(`from version ${epoch}: roots become attempt 1, requests bind to their root, ids/outcomes/findings/judgements/bindings are unchanged, reopen is idempotent and FK-clean`, () => {
    const dir = mkdtempSync(join(tmpdir(), "so-v50-migration-"));
    const file = join(dir, "orders.db");
    try {
      const store = openStore(file);
      const seeded = seed(store, join(dir, "evidence"));
      store.close();
      windBackToV49(file, epoch);
      expect(indexesOf(file)).toContain("one_review_per_source");
      const before = {
        run: rows(file, "SELECT * FROM run ORDER BY id"),
        requests: rows(file, "SELECT * FROM review_request ORDER BY id"),
        comments: rows(file, "SELECT * FROM diff_comment ORDER BY id"),
        judgements: rows(file, "SELECT * FROM criterion_review ORDER BY id"),
        verdicts: rows(file, "SELECT * FROM proof_verdict ORDER BY run"),
        artifacts: rows(file, "SELECT * FROM artifact ORDER BY id"),
      };
      expect(before.comments).toHaveLength(1);
      expect(before.judgements).toHaveLength(1);

      const upgraded = openStore(file);
      expect(upgraded.raw().prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: SCHEMA_VERSION });
      // Every historical fact reads back exactly, the new columns aside.
      const after = {
        run: rows(file, "SELECT * FROM run ORDER BY id"),
        requests: rows(file, "SELECT * FROM review_request ORDER BY id"),
      };
      expect(strip(after.run, "review_attempt")).toEqual(before.run);
      expect(strip(after.requests, "reviewer_run", "origin")).toEqual(before.requests);
      // Every v49 ask reads as an operator's — the human-basis rows the
      // fixture wrote — and none was spent by the origin pass.
      for (const row of after.requests) expect(row["origin"]).toBe("operator");
      expect(after.requests.map(row => row["consumed_reason"])).toEqual(before.requests.map(row => row["consumed_reason"]));
      expect(rows(file, "SELECT * FROM diff_comment ORDER BY id")).toEqual(before.comments);
      expect(rows(file, "SELECT * FROM criterion_review ORDER BY id")).toEqual(before.judgements);
      expect(rows(file, "SELECT * FROM proof_verdict ORDER BY run")).toEqual(before.verdicts);
      expect(rows(file, "SELECT * FROM artifact ORDER BY id")).toEqual(before.artifacts);
      // The attempt bindings: each root is attempt 1, the correction child
      // and every other role carry none, and each run-bearing request
      // names its root — the unrun request stays unbound.
      const attempt = new Map(after.run.map(row => [Number(row["id"]), row["review_attempt"]]));
      expect(attempt.get(seeded.reviewedRoot)).toBe(1);
      expect(attempt.get(seeded.failedRoot)).toBe(1);
      expect(attempt.get(seeded.correction)).toBeNull();
      for (const source of [seeded.reviewed, seeded.failed, seeded.unrun]) expect(attempt.get(source)).toBeNull();
      const bound = new Map(after.requests.map(row => [Number(row["id"]), row["reviewer_run"]]));
      expect(bound.get(seeded.requests[0]!)).toBe(seeded.reviewedRoot);
      expect(bound.get(seeded.requests[1]!)).toBe(seeded.failedRoot);
      expect(bound.get(seeded.requests[2]!)).toBeNull();
      // The index replacement is exact.
      const indexes = indexesOf(file);
      expect(indexes).not.toContain("one_review_per_source");
      for (const name of V50_INDEXES) expect(indexes).toContain(name);
      expect(indexes).toContain("one_open_review_request");
      // The projection agrees: a landed review is closed, a failed root is
      // retryable with both explicit retries in hand, the unrun source is
      // plainly unrequested.
      expect(upgraded.reviewRetryStateOf(seeded.reviewed)).toMatchObject({ state: "succeeded", cap: REVIEW_ROOT_ATTEMPTS, retriesRemaining: 0 });
      expect(upgraded.reviewRetryStateOf(seeded.failed)).toMatchObject({ state: "retryable", retriesRemaining: 2, nextAttempt: 2 });
      expect(upgraded.reviewRetryStateOf(seeded.failed)!.attempts[0]).toMatchObject({ runId: seeded.failedRoot, attempt: 1, requestId: seeded.requests[1] });
      expect(upgraded.reviewRetryStateOf(seeded.unrun)).toMatchObject({ state: "unrequested", retriesRemaining: 2, nextAttempt: 1 });
      expect(upgraded.requestReview(seeded.reviewed, "alex", T0)).toMatchObject({ ok: false, reason: "already-reviewed" });
      expect(upgraded.requestReview(seeded.failed, "alex", T0)).toMatchObject({ ok: true, attempt: 2 });
      expect(upgraded.raw().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      upgraded.close();

      // Reopen: nothing moves.
      const settled = rows(file, "SELECT id, review_attempt FROM run ORDER BY id");
      const settledRequests = rows(file, "SELECT id, reviewer_run, origin, consumed_reason FROM review_request ORDER BY id");
      const again = openStore(file);
      expect(again.raw().prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: SCHEMA_VERSION });
      expect(rows(file, "SELECT id, review_attempt FROM run ORDER BY id")).toEqual(settled);
      expect(rows(file, "SELECT id, reviewer_run, origin, consumed_reason FROM review_request ORDER BY id")).toEqual(settledRequests);
      expect(again.raw().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(indexesOf(file)).toEqual(indexes);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const shape of ["v49", "v50 before origin"] as const) test(`explicit-only retries on a ${shape} file: mode asks read automatic, an open human ask that would be a retry is spent legacy-origin, a first ask keeps its authority`, () => {
    const dir = mkdtempSync(join(tmpdir(), "so-v50-origin-"));
    const file = join(dir, "orders.db");
    try {
      const store = openStore(file);
      const seeded = seed(store, join(dir, "evidence"));
      store.close();
      if (shape === "v49") windBackToV49(file, 49);
      else windBackToPreOrigin(file);
      const raw = new DatabaseSync(file);
      expect(raw.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('review_request') WHERE name = 'origin'").get()).toMatchObject({ n: 0 });
      // A mode's spent ask on the reviewed source, an OPEN human-basis ask
      // on the source whose root failed (a retry nobody can prove a person
      // asked for — build 1513's replayed Strict producer wrote exactly
      // this row), and an OPEN human-basis first ask on the unrun source.
      raw.prepare("INSERT INTO review_request (run, requested_by, basis, mode_digest, requested_at, consumed_at, consumed_reason) VALUES (?, 'mode standard', 'mode', 'deadbeef', ?, ?, 'mode-ended')").run(seeded.reviewed, T0.toISOString(), T0.toISOString());
      const stale = Number(raw.prepare("INSERT INTO review_request (run, requested_by, basis, requested_at) VALUES (?, 'alex', 'human', ?)").run(seeded.failed, T0.toISOString()).lastInsertRowid);
      const fresh = Number(raw.prepare("INSERT INTO review_request (run, requested_by, basis, requested_at) VALUES (?, 'alex', 'human', ?)").run(seeded.unrun, T0.toISOString()).lastInsertRowid);
      raw.close();

      const upgraded = openStore(file);
      const origins = new Map(rows(file, "SELECT id, basis, origin, consumed_reason FROM review_request ORDER BY id").map(row => [Number(row["id"]), row]));
      expect(origins.get(seeded.requests[0]!)).toMatchObject({ basis: "human", origin: "operator", consumed_reason: "reviewed" });
      expect([...origins.values()].find(row => row["basis"] === "mode")).toMatchObject({ origin: "automatic", consumed_reason: "mode-ended" });
      expect(origins.get(stale)).toMatchObject({ origin: "operator", consumed_reason: "legacy-origin" });
      expect(origins.get(fresh)).toMatchObject({ origin: "operator", consumed_reason: null });
      // The projection and the doors agree: the failed source is retryable
      // by a fresh operator act (nothing queued), the unrun source's first
      // ask still admits.
      expect(upgraded.reviewRetryStateOf(seeded.failed)).toMatchObject({ state: "retryable", openRequest: null, retriesRemaining: 2 });
      expect(upgraded.reviewRetryStateOf(seeded.unrun)).toMatchObject({ state: "queued", openRequest: { id: fresh, origin: "operator" } });
      expect(upgraded.admitReview(stale, { runner: "worker", token: "tok-worker", provider: "claude", model: null }, T0)).toMatchObject({ ok: false, reason: "gone" });
      expect(upgraded.admitReview(fresh, { runner: "worker", token: "tok-worker", provider: "claude", model: null }, T0)).toMatchObject({ ok: true, attempt: 1 });
      expect(upgraded.requestReview(seeded.failed, "alex", T0)).toMatchObject({ ok: true, attempt: 2 });
      expect(upgraded.raw().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      upgraded.close();
      // Reopen: the origin pass ran once; nothing moves.
      const settled = rows(file, "SELECT id, origin, consumed_reason FROM review_request ORDER BY id");
      const again = openStore(file);
      expect(rows(file, "SELECT id, origin, consumed_reason FROM review_request ORDER BY id")).toEqual(settled);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A connection that dies at one exact statement of the origin pass:
   * the statement `at` runs (or, for COMMIT, does not), then the process
   * is gone — nothing else it would have said reaches the file, its
   * ROLLBACK included; closing the raw handle is what a crash leaves
   * SQLite to do. */
  const dyingAt = (at: "alter" | "classify" | "commit"): { connect: (path: string) => Database; died: () => boolean; raw: () => DatabaseSync | undefined } => {
    let real: DatabaseSync | undefined;
    let died = false;
    let armed = false;
    const matches = (sql: string): boolean => {
      if (at === "alter") return /ALTER TABLE review_request ADD COLUMN origin /.test(sql);
      if (at === "classify") return /UPDATE review_request SET origin = 'automatic' WHERE basis = 'mode'/.test(sql);
      return armed && /^COMMIT$/.test(sql.trim());
    };
    return {
      connect: (path: string): Database => {
        real = new DatabaseSync(path);
        return {
          prepare: sql => real!.prepare(sql) as never,
          exec: sql => {
            if (died) return; // a dead process says nothing more
            if (/ALTER TABLE review_request ADD COLUMN origin /.test(sql)) armed = true;
            if (matches(sql)) {
              died = true;
              if (at !== "commit") real!.exec(sql);
              throw new Error(`injected interruption at ${at}`);
            }
            real!.exec(sql);
          },
          close: () => real!.close(),
        } as Database;
      },
      died: () => died,
      raw: () => real,
    };
  };

  for (const shape of ["v49", "v50 before origin"] as const) for (const at of ["alter", "classify", "commit"] as const) test(`an interruption at ${at} on a ${shape} file leaves no origin column and the next open runs the whole pass: the replayed automatic retry is spent, never admitted`, () => {
    const dir = mkdtempSync(join(tmpdir(), "so-v50-origin-crash-"));
    const file = join(dir, "orders.db");
    try {
      const store = openStore(file);
      const seeded = seed(store, join(dir, "evidence"));
      store.close();
      if (shape === "v49") windBackToV49(file, 49);
      else windBackToPreOrigin(file);
      const raw = new DatabaseSync(file);
      // Build 1513's replayed Strict producer wrote exactly this row: an
      // OPEN human-basis ask on a source whose root already failed.
      const stale = Number(raw.prepare("INSERT INTO review_request (run, requested_by, basis, requested_at) VALUES (?, 'alex', 'human', ?)").run(seeded.failed, T0.toISOString()).lastInsertRowid);
      const fresh = Number(raw.prepare("INSERT INTO review_request (run, requested_by, basis, requested_at) VALUES (?, 'alex', 'human', ?)").run(seeded.unrun, T0.toISOString()).lastInsertRowid);
      raw.prepare("INSERT INTO review_request (run, requested_by, basis, mode_digest, requested_at, consumed_at, consumed_reason) VALUES (?, 'mode standard', 'mode', 'deadbeef', ?, ?, 'mode-ended')").run(seeded.reviewed, T0.toISOString(), T0.toISOString());
      raw.close();
      const before = rows(file, "SELECT * FROM review_request ORDER BY id");

      const dying = dyingAt(at);
      expect(() => openStore(file, { connect: dying.connect })).toThrow(new RegExp(`injected interruption at ${at}`));
      expect(dying.died()).toBe(true);
      // Failed openers now close their connection themselves, releasing
      // migration locks even when the controller process remains alive.
      expect(() => dying.raw()!.prepare("SELECT 1").get()).toThrow(/not open/);
      // The column and the classification went together: none of it is
      // on disk, every request row reads exactly as it did (the v49 road's
      // own reviewer_run binding aside — that pass commits on its own and
      // is idempotent), and the file says the upgrade is unfinished (v49:
      // the sentinel; a build-1513 file: current, as it always was).
      expect(rows(file, "SELECT COUNT(*) AS n FROM pragma_table_info('review_request') WHERE name = 'origin'")).toEqual([{ n: 0 }]);
      expect(strip(rows(file, "SELECT * FROM review_request ORDER BY id"), "reviewer_run")).toEqual(strip(before, "reviewer_run"));
      expect(rows(file, "SELECT id, consumed_at, consumed_reason FROM review_request ORDER BY id")).toEqual(before.map(row => ({ id: row["id"], consumed_at: row["consumed_at"], consumed_reason: row["consumed_reason"] })));
      expect(rows(file, "SELECT version FROM schema_version")).toEqual([{ version: shape === "v49" ? -49 : SCHEMA_VERSION }]);

      // The next open runs the WHOLE pass: the replayed automatic retry is
      // spent before any admission could see it, the first ask keeps its
      // authority, a fresh operator act can still retry.
      const upgraded = openStore(file);
      expect(upgraded.raw().prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: SCHEMA_VERSION });
      const origins = new Map(rows(file, "SELECT id, basis, origin, consumed_reason FROM review_request ORDER BY id").map(row => [Number(row["id"]), row]));
      expect(origins.get(stale)).toMatchObject({ origin: "operator", consumed_reason: "legacy-origin" });
      expect(origins.get(fresh)).toMatchObject({ origin: "operator", consumed_reason: null });
      expect([...origins.values()].find(row => row["basis"] === "mode")).toMatchObject({ origin: "automatic", consumed_reason: "mode-ended" });
      expect(upgraded.openReviewRequests().some(open => open.id === stale)).toBe(false);
      expect(upgraded.admitReview(stale, { runner: "worker", token: "tok-worker", provider: "claude", model: null }, T0)).toMatchObject({ ok: false, reason: "gone" });
      expect(upgraded.reviewRetryStateOf(seeded.failed)).toMatchObject({ state: "retryable", openRequest: null, retriesRemaining: 2 });
      expect(upgraded.admitReview(fresh, { runner: "worker", token: "tok-worker", provider: "claude", model: null }, T0)).toMatchObject({ ok: true, attempt: 1 });
      expect(upgraded.requestReview(seeded.failed, "alex", T0)).toMatchObject({ ok: true, attempt: 2 });
      expect(upgraded.raw().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second opener that waited on the write lock finds the column inside the transaction and classifies nothing — an operator ask queued after the first migrator committed stays open", () => {
    const dir = mkdtempSync(join(tmpdir(), "so-v50-origin-wait-"));
    const file = join(dir, "orders.db");
    try {
      const store = openStore(file);
      const seeded = seed(store, join(dir, "evidence"));
      store.close();
      windBackToPreOrigin(file);
      const raw = new DatabaseSync(file);
      const stale = Number(raw.prepare("INSERT INTO review_request (run, requested_by, basis, requested_at) VALUES (?, 'alex', 'human', ?)").run(seeded.failed, T0.toISOString()).lastInsertRowid);
      raw.close();

      // The waiting opener: its BEGIN IMMEDIATE is where it would block
      // behind the first migrator. Here the first migrator runs to
      // completion at exactly that point — and, before the second opener
      // gets the lock, an operator queues a retry of the failed source:
      // an OPEN human-basis ask on a source with a root attempt, the very
      // row a repeated classification would spend as legacy.
      let waited = 0;
      let queued: number | null = null;
      let columnAtWait: boolean | null = null;
      let real: DatabaseSync | undefined;
      let opening = true;
      const waiting = (path: string): Database => {
        real = new DatabaseSync(path);
        return {
          prepare: sql => real!.prepare(sql) as never,
          exec: sql => {
            if (opening && /^BEGIN IMMEDIATE$/.test(sql.trim())) {
              waited += 1;
              columnAtWait = Number((real!.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('review_request') WHERE name = 'origin'").get() as { n: number }).n) === 1;
              const first = openStore(path);
              expect(first.reviewRetryStateOf(seeded.failed)).toMatchObject({ state: "retryable", openRequest: null });
              const retry = first.requestReview(seeded.failed, "alex", T0);
              if (!retry.ok) throw new Error(retry.reason);
              queued = retry.id;
              first.close();
            }
            real!.exec(sql);
          },
          close: () => real!.close(),
        } as Database;
      };
      const second = openStore(file, { connect: waiting });
      opening = false;
      // Exactly one write transaction in the open — the origin pass — and
      // the column was still absent when it queued for the lock.
      expect(waited).toBe(1);
      expect(columnAtWait).toBe(false);
      expect(queued).not.toBeNull();
      // The first migrator's pass spent the replayed row; the second
      // opener left the operator's fresh retry exactly as queued.
      const origins = new Map(rows(file, "SELECT id, origin, consumed_reason FROM review_request ORDER BY id").map(row => [Number(row["id"]), row]));
      expect(origins.get(stale)).toMatchObject({ origin: "operator", consumed_reason: "legacy-origin" });
      expect(origins.get(queued!)).toMatchObject({ origin: "operator", consumed_reason: null });
      expect(second.reviewRetryStateOf(seeded.failed)).toMatchObject({ state: "queued", openRequest: { id: queued, origin: "operator" }, nextAttempt: 2 });
      expect(second.admitReview(queued!, { runner: "worker", token: "tok-worker", provider: "claude", model: null }, T0)).toMatchObject({ ok: true, attempt: 2 });
      expect(second.raw().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a v49 shape the pass cannot prove refuses the open in words and binds nothing", () => {
    for (const shape of ["two-requests", "two-roots"] as const) {
      const dir = mkdtempSync(join(tmpdir(), "so-v50-refuse-"));
      const file = join(dir, "orders.db");
      try {
        const store = openStore(file);
        const seeded = seed(store, join(dir, "evidence"));
        store.close();
        windBackToV49(file, 49);
        const raw = new DatabaseSync(file);
        if (shape === "two-requests") {
          // Two run-bearing requests spent on one source: v29..v49 never
          // wrote this (one open request, one root ever), so no request can
          // be proved to be the failed root's.
          raw.prepare("INSERT INTO review_request (run, requested_by, basis, requested_at, consumed_at, consumed_reason) VALUES (?, 'alex', 'human', ?, ?, 'dispatched')").run(seeded.failed, T0.toISOString(), T0.toISOString());
        } else {
          raw.exec("DROP INDEX one_review_per_source");
          raw.prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, parent_run, started_at, outcome) VALUES (?, 'x', 'worker', 'reviewer', 'claude', ?, ?, 'failed')").run(seeded.taskRef, seeded.failed, T0.toISOString());
        }
        raw.close();
        expect(() => openStore(file)).toThrow(shape === "two-requests" ? /spent 2 review requests on one reviewer run/ : /carries 2 root reviewer runs/);
        // Nothing was bound; the epoch sentinel says the upgrade is unfinished.
        expect(rows(file, "SELECT review_attempt FROM run WHERE role = 'reviewer' AND review_attempt IS NOT NULL")).toEqual([]);
        expect(rows(file, "SELECT reviewer_run FROM review_request WHERE reviewer_run IS NOT NULL")).toEqual([]);
        expect(rows(file, "SELECT version FROM schema_version")).toEqual([{ version: -49 }]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});


describe("schema 62 compatibility without manual refresh", () => {
  // The accepted evidence fix (64e8172) proved this block at schema 60 and
  // proved that reader refusing 61 and -61 as "newer build". The Telegram
  // delivery foundation was v61; the Telegram conversation queue is v62.
  // The same review rows and receipts must survive the 60-to-62 upgrade and
  // every reopen, the retired schema-62 REFRESH draft (a refresh request
  // ledger, a second successful review per source — nothing to do with the
  // Telegram tables that now carry the number) must still be absent, and
  // the unchanged fence must refuse anything above this build exactly as
  // v60 refused 61.
  const V61_TABLES = ["notification_delivery", "telegram_outbound_message", "telegram_retry"];
  const V62_TABLES = ["telegram_conversation_part", "telegram_conversation", "telegram_proposal_action"];
  const V61_COLUMNS = ["provenance_scope", "project", "task_ref", "task_id", "source_run"];
  test.each([60, -60, 61, -61])("a v%s evidence store upgrades to v62 and reopens preserving every historical review row and receipt, and no schema-62 refresh object exists", version => {
    const root = mkdtempSync(join(tmpdir(), "refresh-migration-")), file = join(root, "test.db");
    try {
      let store = openStore(file); seed(store, join(root, "evidence"));
      expect(SCHEMA_VERSION).toBe(113);
      expect(store.raw().prepare("PRAGMA table_info(run)").all().some(row => row["name"] === "review_refresh")).toBe(false);
      expect(store.raw().prepare("PRAGMA table_info(review_request)").all().some(row => row["name"] === "refresh_json")).toBe(false);
      // The retired schema-62 draft (a refresh request ledger, a second
      // successful review per source) left no table, column, index or
      // trigger behind: the whole live schema is scanned, and v50's
      // one-successful-root-review backstop is still the deployed shape.
      const objects = store.raw().prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
      const obsolete = /refresh|second_review|second_successful|review_evidence_request|evidence_refresh/i;
      // v113's oauth_ tables (MCP sign-in refresh secrets) are not the retired draft.
      expect(objects.filter(one => !one.tbl_name.startsWith("oauth_") && (obsolete.test(one.name) || obsolete.test(one.sql ?? "")))).toEqual([]);
      for (const table of ["run", "review_request", "criterion_review", "artifact", "proof_verdict"]) {
        expect((store.raw().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).filter(column => obsolete.test(column.name))).toEqual([]);
      }
      expect(objects.find(one => one.name === "one_successful_root_review_per_source")?.sql).toContain("WHERE role = 'reviewer' AND review_attempt IS NOT NULL AND outcome = 'no-change'");
      expect(objects.find(one => one.name === "one_review_per_source")).toBeUndefined();
      const tables = ["run", "review_request", "criterion_review", "diff_comment", "artifact", "proof_verdict"];
      const before = tables.map(t => store.raw().prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
      store.close();
      // Wind the file back to the deployed v60 shape (or its mid-flight
      // sentinel): no v61/v62 tables, no provenance columns, the v52 stop
      // audit — or to the deployed v61 shape, which keeps the v61 tables.
      const raw = new DatabaseSync(file);
      for (const table of V62_TABLES) raw.exec(`DROP TABLE ${table}`);
      raw.exec("DROP TABLE run_stop");
      raw.exec(`CREATE TABLE run_stop (
        run INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE, task_ref INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
        requested_by TEXT NOT NULL, requested_via TEXT NOT NULL CHECK (requested_via IN ('cli','web')), requested_at TEXT NOT NULL,
        settled_at TEXT, settlement TEXT CHECK (settlement IN ('interrupted','recovered','held','finished')), resumed_at TEXT, resumed_by TEXT,
        resumed_via TEXT CHECK (resumed_via IN ('cli','web')), CHECK ((settled_at IS NULL) = (settlement IS NULL)),
        CHECK (resumed_at IS NULL OR settled_at IS NOT NULL), CHECK ((resumed_at IS NULL) = (resumed_by IS NULL)))`);
      if (Math.abs(version) === 60) {
        for (const table of V61_TABLES) raw.exec(`DROP TABLE ${table}`);
        for (const column of V61_COLUMNS) raw.exec(`ALTER TABLE notification DROP COLUMN ${column}`);
      }
      raw.exec("DROP TABLE service_cursor");
      raw.prepare("UPDATE schema_version SET version = ?").run(version);
      raw.close();
      store = openStore(file);
      expect(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
      for (const table of [...V61_TABLES, ...V62_TABLES]) expect(store.raw().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
      for (const column of V61_COLUMNS) expect(store.raw().prepare("PRAGMA table_info(notification)").all().some(row => row["name"] === column)).toBe(true);
      expect(String(store.raw().prepare("SELECT sql FROM sqlite_master WHERE name = 'run_stop'").get()?.["sql"])).toContain("'cli','web','telegram'");
      tables.forEach((t, index) => expect(store.raw().prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).toEqual(before[index]));
      expect(store.raw().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      store.close(); store = openStore(file);
      expect(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
      tables.forEach((t, index) => expect(store.raw().prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).toEqual(before[index]));
      expect(store.criterionReviewsFor(1)).not.toEqual([]); store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test.each([SCHEMA_VERSION + 1, -(SCHEMA_VERSION + 1)])("schema %s refuses before every write and preserves bytes — the fence an older reader applies to this current file", version => {
    const root = mkdtempSync(join(tmpdir(), "refresh-refusal-")), file = join(root, "test.db");
    try {
      const store = openStore(file); store.raw().prepare("UPDATE schema_version SET version=?").run(version); store.close();
      const before = readFileSync(file);
      expect(() => openStore(file)).toThrow(/newer build/);
      expect(readFileSync(file).equals(before)).toBe(true);
      expect(openStoreNoMigrate(file).ok).toBe(false);
      expect(readFileSync(file).equals(before)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("the negative current version is an impossible marker: an upgrade never begins at the version it upgrades to", () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-refusal-")), file = join(root, "test.db");
    try {
      const store = openStore(file); store.raw().prepare("UPDATE schema_version SET version=?").run(-SCHEMA_VERSION); store.close();
      const before = readFileSync(file);
      expect(() => openStore(file)).toThrow(/mid-flight marker no build ever wrote/);
      expect(readFileSync(file).equals(before)).toBe(true);
      expect(openStoreNoMigrate(file).ok).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
