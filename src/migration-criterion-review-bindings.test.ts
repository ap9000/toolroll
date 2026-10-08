/**
 * The in-version repair of an EXISTING criterion_review table (run 1507's
 * failure): the audit hardening widened the fresh DDL by seven hash-bound
 * review binding columns under the same schema version, so a database that
 * already carried the ORIGINAL ten-column table (commit 1b927a2, v40) kept
 * it through IF NOT EXISTS — and ingestReview's INSERT died on it with
 * "table criterion_review has no column named scope_digest".
 *
 * This is UPGRADE coverage, deliberately distinct from src/reviewer.test.ts,
 * whose every store opens fresh (":memory:") and so always had the wide
 * table. The older layout here is a deterministic fixture built from the
 * verbatim v40 DDL: a real review is ingested on a fresh file, the table is
 * rebuilt DOWN to the ten original columns (rows copied, nothing hand-
 * wound), and the store is opened again over it — a v48 file with the old
 * shape, exactly what the real installation carried — and, in a second
 * road, the authentic v47 fixture narrowed the same way, so the repair is
 * proved on the epoch-sentinel upgrade too.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { storeEvidence } from "./evidence.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import type { CriterionMatrixRow } from "./proof.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const V47_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v47-authentic.sql");

const T0 = new Date("2026-08-27T12:00:00.000Z");
const REPO = "/repos/thing";
const PATCH = ["diff --git a/src/payouts.ts b/src/payouts.ts", "--- a/src/payouts.ts", "+++ b/src/payouts.ts", "@@ -1,2 +1,3 @@", "+const guard = limiter();", ""].join("\n");
const CRITERION = { id: "c1", statement: "The payout guard is wired in.", how: null, evidence: ["manual-review"] as const };

/** The ORIGINAL criterion_review shape, verbatim from commit 1b927a2 (the
 * v40 build that first created the table) — the ten columns a real
 * installation upgraded from v40 still carried at v48. */
const V40_CRITERION_REVIEW_DDL = `CREATE TABLE criterion_review (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reviewer_run  INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  source_run    INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  criterion_id  TEXT NOT NULL,
  judgement     TEXT NOT NULL CHECK (judgement IN ('upholds','contradicts','cannot-tell')),
  note          TEXT NOT NULL,
  artifact      INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  artifact_sha  TEXT NOT NULL,
  author        TEXT NOT NULL,
  created_at    TEXT NOT NULL
)`;
const V40_COLUMNS = ["id", "reviewer_run", "source_run", "criterion_id", "judgement", "note", "artifact", "artifact_sha", "author", "created_at"] as const;
/** The binding columns the current writer (ingestReview) needs: the seven
 * audit-hardening bindings, then the v51 review-context pair. */
const BINDING_COLUMNS = ["scope_digest", "head_sha", "proof_artifact", "proof_sha", "check_log_artifact", "check_log_sha", "screenshots_json", "context_artifact", "context_sha"] as const;

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };
function columnsOf(file: string): ColumnInfo[] {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  const rows = (db.prepare("PRAGMA table_info(criterion_review)").all() as Record<string, unknown>[]).map(row => ({
    name: String(row["name"]),
    type: String(row["type"]),
    notnull: Number(row["notnull"]),
    dflt_value: row["dflt_value"],
    pk: Number(row["pk"]),
  }));
  db.close();
  return rows;
}
function reviewRowsOf(file: string): Record<string, unknown>[] {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT * FROM criterion_review ORDER BY id").all() as Record<string, unknown>[];
  db.close();
  return rows.map(row => ({ ...row }));
}
function versionOf(file: string): number {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
  db.close();
  return Number(row.version);
}
/** Every table's DDL and every row — the whole file, for the second-open
 * comparison. */
function snapshot(file: string): unknown {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  const schema = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as { name: string; type: string; sql: string }[];
  const rows: Record<string, unknown[]> = {};
  // The FTS5 memory index and its shadow tables are derived (some WITHOUT ROWID); the stores of record are the proof.
  for (const table of schema.filter(one => one.type === "table" && !one.name.startsWith("memory_search"))) {
    rows[table.name] = (db.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all() as Record<string, unknown>[]).map(row => ({ ...row }));
  }
  db.close();
  return { schema: schema.map(one => ({ ...one })), rows };
}

/** Rebuild criterion_review DOWN to the ten original columns — the rows it
 * holds are copied, never re-typed — so the file carries exactly the shape a
 * v40-born installation still has. */
function narrowToV40(file: string): void {
  const db = new sqlite.DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("ALTER TABLE criterion_review RENAME TO criterion_review_wide");
  db.exec(V40_CRITERION_REVIEW_DDL);
  db.exec(`INSERT INTO criterion_review (${V40_COLUMNS.join(", ")}) SELECT ${V40_COLUMNS.join(", ")} FROM criterion_review_wide`);
  db.exec("DROP TABLE criterion_review_wide");
  // A file in this shape was written before v114: every DDL change bumps the version, and a current file is never repaired.
  db.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION - 1} WHERE version = ${SCHEMA_VERSION}`);
  db.close();
  expect(columnsOf(file).map(one => one.name)).toEqual([...V40_COLUMNS]);
}

/** The exact route authority a fixture PRESENTS at admission (v48 authority
 * repair), exactly as src/reviewer.test.ts presents it. */
const presented = (
  s: Pick<Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  const authority = s.routeAuthorityFor(taskRef, role) ?? s.routeAuthorityFor(taskRef, role, { provider: "claude", model: null });
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

/** One task with an approved rubric, a runner, and the seams every built run
 * below shares — the src/reviewer.test.ts fixture, against a FILE. */
type Seam = { taskRef: number; approverToken: string; scopeDigest: string; evidenceRoot: string };
function seedTask(store: Store, evidenceRoot: string): Seam {
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  store.createTask({ id: "t-1", title: "wire the payout guard" }, T0);
  const taskRef = store.refFor("built-in", "t-1").id;
  store.placeTask(taskRef, REPO);
  register(store, { name: "builder-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-builder-1" });
  store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
  store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
  store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
  const scope = propose(store, { taskId: "t-1", goal: "wire the payout guard", acceptance: [CRITERION], now: T0 });
  const sealed = approve(store, "t-1", "alex", T0, scope.digest, alex.token);
  if (!sealed.ok) throw new Error(`approve: ${sealed.reason}`);
  return { taskRef, approverToken: alex.token, scopeDigest: sealed.scope.digest, evidenceRoot };
}

/** A built run under the signed scope, with its terminal diff, head, and a
 * short verdict over the one signed criterion — everything a criterion
 * review binds to. */
function seedBuilt(store: Store, seam: Seam, lease: string): { runId: number; diffArtifact: number; diffSha: string } {
  const runId = store.startRun({ taskRef: seam.taskRef, leaseId: lease, runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", now: T0, ...presented(store, seam.taskRef, "builder") });
  const diffArtifact = storeEvidence(store, seam.evidenceRoot, runId, "terminal-diff", "terminal-diff.patch", Buffer.from(PATCH, "utf8"), "git diff (exit 0)", T0, { captureStatus: "ok" });
  store.recordOutcomeFacts(runId, { headRevision: "head-aaa", handoff: "guarded the payout" });
  store.finishRun(runId, { outcome: "built", committed: true, now: T0 });
  store.stampRun(runId, { scopeDigest: seam.scopeDigest });
  const row: CriterionMatrixRow = { id: "c1", statement: CRITERION.statement, requiredEvidence: ["manual-review"], state: "manual-review", detail: [], answered: [{ kind: "manual-review", ref: "looked at it" }], review: null };
  store.saveProofVerdict(runId, "short", ["needs a human look"], T0, [row]);
  const diffSha = store.getArtifact(diffArtifact)?.sha256;
  if (diffSha === undefined) throw new Error("missing diff fixture");
  return { runId, diffArtifact, diffSha };
}

/** The ROOT reviewer of a built run, admitted through the real request door. */
function seedRootReviewer(store: Store, seam: Seam, sourceRun: number, lease: string, sessionId: string): number {
  const asked = store.requestReview(sourceRun, "alex", T0);
  if (!asked.ok) throw new Error(`requestReview: ${asked.reason}`);
  const root = store.startRun({ taskRef: seam.taskRef, leaseId: lease, runner: "builder-1", role: "reviewer", parentRun: sourceRun, provider: "claude", sessionId, now: T0, ...presented(store, seam.taskRef, "reviewer"), request: asked.id });
  store.stampProviderStart(root, T0);
  return root;
}

const judgement = { id: "c1", judgement: "upholds" as const, note: "the diff wires the guard" };
const comment = { path: "src/payouts.ts", line: 2, note: "guard is in place", severity: "problem" as const };

describe("an existing ten-column criterion_review table gains the review binding columns in place", () => {
  let dir: string | undefined;
  let open: Store | null = null;
  afterEach(() => {
    open?.close();
    open = null;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A v48 file whose criterion_review carries ONE real review row in the
   * ten-column shape — the installation run 1507 failed against. */
  function buildOlderLayoutFixture(): { file: string; seam: Seam; historical: Record<string, unknown> } {
    dir = mkdtempSync(join(tmpdir(), "so-cr-upgrade-"));
    const file = join(dir, "orders.db");
    const evidenceRoot = join(dir, "evidence");
    const fresh = openStore(file);
    const seam = seedTask(fresh, evidenceRoot);
    const built = seedBuilt(fresh, seam, "build:historical");
    const root = seedRootReviewer(fresh, seam, built.runId, "review:historical", "review-session-0");
    expect(
      fresh.ingestReview(
        { reviewerRunId: root, runId: built.runId, artifactId: built.diffArtifact, author: "reviewer:claude", comments: [comment], judgements: [judgement], bindings: { diffSha: built.diffSha, scopeDigest: seam.scopeDigest, headSha: "head-aaa", proof: null, checkLog: null, screenshots: [] } },
        T0,
      ).commentIds,
    ).toHaveLength(1);
    fresh.close();
    narrowToV40(file);
    expect(versionOf(file)).toBe(SCHEMA_VERSION - 1);
    const rows = reviewRowsOf(file);
    expect(rows).toHaveLength(1);
    const historical = rows[0]!;
    expect(Object.keys(historical)).toEqual([...V40_COLUMNS]);
    return { file, seam, historical };
  }

  test("the fresh DDL and the current writer agree on exactly these binding columns (fresh-database coverage)", () => {
    dir = mkdtempSync(join(tmpdir(), "so-cr-fresh-"));
    const file = join(dir, "fresh.db");
    openStore(file).close();
    expect(columnsOf(file).map(one => one.name)).toEqual([...V40_COLUMNS, ...BINDING_COLUMNS]);
  });

  test("c1: opening the v48 older-layout file adds every binding column as the fresh DDL declares it, keeps the historical row byte for byte, and a second open changes nothing", () => {
    const { file, historical } = buildOlderLayoutFixture();
    const before = reviewRowsOf(file);

    open = openStore(file);
    open.close();
    open = null;
    expect(versionOf(file)).toBe(SCHEMA_VERSION);
    const upgraded = columnsOf(file);
    expect(upgraded.map(one => one.name)).toEqual([...V40_COLUMNS, ...BINDING_COLUMNS]);
    // Column for column — name, type, NOT NULL, default, and key — the
    // upgraded table is the fresh table.
    const freshFile = join(dir!, "fresh.db");
    openStore(freshFile).close();
    expect(upgraded).toEqual(columnsOf(freshFile));

    // The one historical row: its ten original values untouched, and its
    // seven new columns UNBOUND — NULL, an empty list — never backfilled
    // from anything: the evidence of what that reviewer was shown does not
    // exist to bind.
    const after = reviewRowsOf(file);
    expect(after).toHaveLength(1);
    for (const column of V40_COLUMNS) expect(after[0]![column]).toEqual(historical[column]);
    expect(after[0]).toMatchObject({ scope_digest: null, head_sha: null, proof_artifact: null, proof_sha: null, check_log_artifact: null, check_log_sha: null, screenshots_json: "[]", context_artifact: null, context_sha: null });
    expect(before).toEqual([historical]);

    // The store's own reader sees the same unbound row.
    open = openStore(file);
    const read = open.criterionReviewsFor(Number(historical["source_run"]));
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ criterionId: "c1", judgement: "upholds", artifactSha: historical["artifact_sha"], scopeDigest: null, headSha: null, proof: null, checkLog: null, screenshots: [] });
    open.close();
    open = null;

    // Idempotent: a second (and third) open leaves the whole file alone.
    const settled = snapshot(file);
    openStore(file).close();
    expect(snapshot(file)).toEqual(settled);
    openStore(file).close();
    expect(snapshot(file)).toEqual(settled);
    expect(versionOf(file)).toBe(SCHEMA_VERSION);
  });

  test("c1: the authentic v47 fixture narrowed to the ten-column table takes the same repair on the epoch-sentinel upgrade road", () => {
    dir = mkdtempSync(join(tmpdir(), "so-cr-v47-"));
    const file = join(dir, "orders.db");
    const raw = new sqlite.DatabaseSync(file);
    raw.exec(readFileSync(V47_FIXTURE, "utf8"));
    raw.close();
    narrowToV40(file);
    expect(versionOf(file)).toBe(47);
    openStore(file).close();
    expect(versionOf(file)).toBe(SCHEMA_VERSION);
    expect(columnsOf(file).map(one => one.name)).toEqual([...V40_COLUMNS, ...BINDING_COLUMNS]);
    const settled = snapshot(file);
    openStore(file).close();
    expect(snapshot(file)).toEqual(settled);
  });

  test("c2: after the repair a real ingestReview lands through a same-session correction child, and a changed scope or artifact binding still refuses with no partial comment or judgement", () => {
    const { file, seam, historical } = buildOlderLayoutFixture();
    const historicalRun = Number(historical["source_run"]);
    open = openStore(file);
    const store = open;
    const historicalRows = store.criterionReviewsFor(historicalRun);
    expect(historicalRows).toHaveLength(1);

    // THE CORRECTION ROAD: root reviewer, then the bounded same-session
    // child admitted by admitCorrection, which authors the accepted payload.
    const built = seedBuilt(store, seam, "build:corrected");
    const root = seedRootReviewer(store, seam, built.runId, "review:corrected", "review-session-1");
    const stamp = presented(store, seam.taskRef, "reviewer") as { route: import("./phase-routing.js").RouteStamp };
    const admitted = store.admitCorrection({ taskRef: seam.taskRef, leaseId: "review:corrected", runner: "builder-1", parentRun: root, provider: "claude", sessionId: "review-session-1", now: T0, ...stamp });
    if (!admitted.ok) throw new Error(admitted.problem);
    const child = admitted.runId;
    store.stampProviderStart(child, T0);
    const ingested = store.ingestReview(
      { reviewerRunId: child, runId: built.runId, artifactId: built.diffArtifact, author: "reviewer:claude", comments: [comment], judgements: [judgement], bindings: { diffSha: built.diffSha, scopeDigest: seam.scopeDigest, headSha: "head-aaa", proof: null, checkLog: null, screenshots: [] } },
      T0,
    );
    expect(ingested.commentIds).toHaveLength(1);
    expect(ingested.verdict).not.toBeNull();
    const saved = store.criterionReviewsFor(built.runId);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ reviewerRun: child, sourceRun: built.runId, criterionId: "c1", judgement: "upholds", artifactSha: built.diffSha, scopeDigest: seam.scopeDigest, headSha: "head-aaa", proof: null, checkLog: null, screenshots: [] });
    expect(store.getRun(root)).toMatchObject({ outcome: "no-change" });
    expect(store.getRun(child)).toMatchObject({ outcome: "no-change", reason: "structured review repaired" });
    expect(store.liveDiffComments(built.runId)).toHaveLength(1);
    // The raw row carries the bindings the writer inserted — the columns
    // the repair added are the columns it writes.
    store.close();
    open = null;
    const rawRows = reviewRowsOf(file);
    expect(rawRows).toHaveLength(2);
    expect(rawRows[1]).toMatchObject({ reviewer_run: child, source_run: built.runId, scope_digest: seam.scopeDigest, head_sha: "head-aaa", screenshots_json: "[]" });
    open = openStore(file);
    const again = open;
    expect(again.criterionReviewsFor(historicalRun)).toEqual(historicalRows);

    // THE REFUSALS, on the same repaired file: an artifact binding that
    // does not match the live inventory, and a scope revised since the
    // build was stamped. Each throws, and nothing lands — no comment, no
    // judgement, the reviewer still open.
    const other = seedBuilt(again, seam, "build:refused");
    storeEvidence(again, seam.evidenceRoot, other.runId, "proof", "proof.json", Buffer.from(JSON.stringify({ version: 1, criteria: [] }), "utf8"), "agent-authored", T0);
    const proof = again.artifactsFor(other.runId).find(one => one.kind === "proof");
    if (proof === undefined) throw new Error("missing proof fixture");
    const reviewer = seedRootReviewer(again, seam, other.runId, "review:refused", "review-session-2");
    const attempt = (bindings: Partial<Parameters<Store["ingestReview"]>[0]["bindings"]>) =>
      again.ingestReview(
        { reviewerRunId: reviewer, runId: other.runId, artifactId: other.diffArtifact, author: "reviewer:claude", comments: [comment], judgements: [judgement], bindings: { diffSha: other.diffSha, scopeDigest: seam.scopeDigest, headSha: "head-aaa", proof: { artifactId: proof.id, sha256: proof.sha256 }, checkLog: null, screenshots: [], ...bindings } },
        T0,
      );
    const nothingLanded = () => {
      expect(again.liveDiffComments(other.runId)).toHaveLength(0);
      expect(again.criterionReviewsFor(other.runId)).toEqual([]);
      expect(again.getRun(reviewer)?.outcome).toBeNull();
      expect(again.proofVerdictFor(other.runId)).toMatchObject({ verdict: "short", machineVerdict: null });
    };
    expect(() => attempt({ diffSha: "0".repeat(64) })).toThrow(/terminal diff no longer matches/);
    nothingLanded();
    expect(() => attempt({ proof: null })).toThrow(/proof inventory/);
    nothingLanded();
    expect(() => attempt({ proof: { artifactId: proof.id, sha256: "f".repeat(64) } })).toThrow(/proof inventory/);
    nothingLanded();
    expect(() => attempt({ headSha: "head-bbb" })).toThrow(/head no longer matches/);
    nothingLanded();

    // The scope is revised after the build was stamped: the run's digest
    // no longer resolves to the live signed bytes, so neither the digest
    // the reviewer read nor the new one is accepted.
    const revised = propose(again, { taskId: "t-1", goal: "wire the payout guard, and log it", acceptance: [CRITERION], now: T0 });
    expect(revised.digest).not.toBe(seam.scopeDigest);
    const sealed = approve(again, "t-1", "alex", T0, revised.digest, seam.approverToken);
    if (!sealed.ok) throw new Error(`approve: ${sealed.reason}`);
    expect(() => attempt({})).toThrow(/scope no longer matches the signed build scope/);
    nothingLanded();
    expect(() => attempt({ scopeDigest: revised.digest })).toThrow(/scope no longer matches the signed build scope/);
    nothingLanded();

    // The rows that did land are exactly the two the road above wrote.
    again.close();
    open = null;
    expect(reviewRowsOf(file)).toHaveLength(2);
  });
});
