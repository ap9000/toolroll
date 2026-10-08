/** Historical review parsing and stored rows remain readable. These tests
 * retain strict payload parsing, transactional ingestion, custody fences,
 * signed route authority, one-result bindings and legacy retry-row limits.
 * Current execution never starts a reviewer; retirement is asserted below.
 * Existing database upgrades have separate migration coverage.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { storeEvidence } from "./evidence.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { routeDigestOf } from "./phase-routing.js";
import { presetTerms as currentPresetTerms, modeTermsJson, modeDigestOf } from "./modes.js";
// These fixtures exercise retained pre-retirement records, whose signed modes
// explicitly enabled review. Current presets leave it off.
const presetTerms: typeof currentPresetTerms = (...args) => ({ ...currentPresetTerms(...args), reviewAuto: true });
import { maybeRequestAutoReview } from "./dispose.js";
import { diffPathsOf, parseReview, REVIEW_LIMITS } from "./reviewer.js";
import type { CriterionMatrixRow } from "./proof.js";


/** The exact route authority a fixture PRESENTS at admission (v48 authority repair): the
 * store dictates nothing, so a routed row presents the leg it holds, exactly
 * as a real dispatch would; absent authority presents nothing and the
 * admission says why. */
const presented = (
  s: Pick<import("./store.js").Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "repair" | "planner" | "scout" | "reviewer" = "builder",
  spend: { provider: string; model: string | null } = { provider: "claude", model: null },
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  // A task with no scope presents the bare word `legacy` for the pair it
  // spends as (atomic authority closure): the default claude pair, or the
  // exact pair a fixture names.
  const authority = s.routeAuthorityFor(taskRef, role) ?? s.routeAuthorityFor(taskRef, role, spend);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

const T0 = new Date("2026-08-27T12:00:00.000Z");
const REPO = "/repos/thing";

const PATCH = [
  "diff --git a/src/payouts.ts b/src/payouts.ts",
  "--- a/src/payouts.ts",
  "+++ b/src/payouts.ts",
  "@@ -1,2 +1,3 @@",
  "+const guard = limiter();",
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "rename from src/old-name.ts",
  "rename to src/new-name.ts",
  "",
].join("\n");

describe("diff paths and the strict parser", () => {
  test("diffPathsOf collects both sides and both rename halves", () => {
    const paths = diffPathsOf(PATCH);
    expect(paths.has("src/payouts.ts")).toBe(true);
    expect(paths.has("src/old-name.ts")).toBe(true);
    expect(paths.has("src/new-name.ts")).toBe(true);
    expect(paths.has("")).toBe(false);
  });

  test("a well-formed payload parses; severity defaults to note; notes trim", () => {
    const parsed = parseReview(
      JSON.stringify({
        version: 1,
        comments: [
          { path: "src/payouts.ts", line: 2, note: "  the limiter is never awaited  ", severity: "problem" },
          { path: "src/new-name.ts", line: null, note: "rename looks right" },
        ],
      }),
      diffPathsOf(PATCH),
    );
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.comments).toEqual([
      { path: "src/payouts.ts", line: 2, note: "the limiter is never awaited", severity: "problem" },
      { path: "src/new-name.ts", line: null, note: "rename looks right", severity: "note" },
    ]);
  });

  test("an empty comments array is a valid review", () => {
    const parsed = parseReview(JSON.stringify({ version: 1, comments: [] }), diffPathsOf(PATCH));
    expect(parsed.ok).toBe(true);
  });

  test("run 1638: a reply carrying readEvidence beside review fields is neither a read nor a review", () => {
    // Claude's flat structured-output floor admits both key sets in one
    // object; only the exact evidence-only envelope is a read request, and
    // parseReview refuses the rest whole — a verdict never rides in a read.
    const paths = diffPathsOf(PATCH);
    const read = { file: "REVIEW-CONTEXT-ctx-1.txt", sha256: "a".repeat(64), offset: 0, length: 65536 };
    for (const payload of [
      { version: 1, readEvidence: read, comments: [] },
      { version: 1, readEvidence: read, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "fine" }] },
      { version: 1, readEvidence: read },
      { version: 1, readEvidence: null },
    ]) {
      const parsed = parseReview(JSON.stringify(payload), paths, new Set(["c1"]));
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems).toEqual([{ reason: expect.stringMatching(/^readEvidence must be sent alone/) }]);
    }
    // Without the foreign key the same review is accepted as before.
    expect(parseReview(JSON.stringify({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "fine" }] }), paths, new Set(["c1"])).ok).toBe(true);
    // A version-only reply, the loosest object the flat schema admits, is
    // an incomplete review, not an empty one.
    const bare = parseReview(JSON.stringify({ version: 1 }), paths);
    expect(bare).toEqual({ ok: false, problems: [{ reason: "comments must be an array" }] });
  });

  test("wholesale strictness: any invalid comment refuses the payload", () => {
    const paths = diffPathsOf(PATCH);
    const refuse = (payload: unknown, why: RegExp) => {
      const parsed = parseReview(JSON.stringify(payload), paths);
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(why);
    };
    refuse({ version: 2, comments: [] }, /version/);
    refuse({ version: 1, comments: [{ path: "src/elsewhere.ts", line: 1, note: "x" }] }, /not in the reviewed patch/);
    refuse({ version: 1, comments: [{ path: "src/payouts.ts", line: 0, note: "x" }] }, /positive integer/);
    refuse({ version: 1, comments: [{ path: "src/payouts.ts", line: 1, note: "x".repeat(REVIEW_LIMITS.note + 1) }] }, /note/);
    refuse({ version: 1, comments: [{ path: "src/payouts.ts", line: 1, note: "x", severity: "nit" }] }, /severity/);
    refuse(
      { version: 1, comments: Array.from({ length: REVIEW_LIMITS.comments + 1 }, () => ({ path: "src/payouts.ts", line: 1, note: "x" })) },
      /at most 40/,
    );
    const notJson = parseReview("not json at all", paths);
    expect(notJson.ok).toBe(false);
  });

  describe("v40: criteria judgements", () => {
    const paths = diffPathsOf(PATCH);
    const rubricIds = new Set(["c1", "c2"]);

    test("absent criteria still parses when NO rubric was signed — every task with no signed rubric, and every grandfathered review", () => {
      const parsed = parseReview(JSON.stringify({ version: 1, comments: [] }), paths, new Set());
      if (!parsed.ok) throw new Error("expected ok");
      expect(parsed.criteria).toEqual([]);
    });

    test("audit hardening: absent criteria against a SIGNED rubric refuses the whole payload — full coverage is required", () => {
      const parsed = parseReview(JSON.stringify({ version: 1, comments: [] }), paths, rubricIds);
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/missing judgement.*c1.*c2|missing judgement.*c2.*c1/);
    });

    test("audit hardening: a PARTIAL judgement set (some signed ids uncovered) refuses the whole payload", () => {
      const parsed = parseReview(
        JSON.stringify({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "contradicts", note: "never implemented" }] }),
        paths,
        rubricIds,
      );
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/missing judgement.*c2/);
    });

    test("a well-formed judgement covering every signed id parses", () => {
      const parsed = parseReview(
        JSON.stringify({
          version: 1,
          comments: [],
          criteria: [
            { id: "c1", judgement: "contradicts", note: "  never implemented  " },
            { id: "c2", judgement: "upholds", note: "this one is fine" },
          ],
        }),
        paths,
        rubricIds,
      );
      if (!parsed.ok) throw new Error("expected ok");
      expect(parsed.criteria).toEqual([
        { id: "c1", judgement: "contradicts", note: "never implemented" },
        { id: "c2", judgement: "upholds", note: "this one is fine" },
      ]);
    });

    test("a judgement for an id absent from the signed rubric refuses the WHOLE payload, comments included", () => {
      const parsed = parseReview(
        JSON.stringify({
          version: 1,
          comments: [{ path: "src/payouts.ts", line: 1, note: "fine" }],
          criteria: [{ id: "not-signed", judgement: "upholds", note: "x" }],
        }),
        paths,
        rubricIds,
      );
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/not a signed criterion/);
    });

    test("a duplicate id in one payload refuses the whole payload", () => {
      const parsed = parseReview(
        JSON.stringify({
          version: 1,
          comments: [],
          criteria: [
            { id: "c1", judgement: "upholds", note: "fine" },
            { id: "c1", judgement: "contradicts", note: "actually not" },
          ],
        }),
        paths,
        rubricIds,
      );
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/more than once/);
    });

    test("an unknown judgement word refuses the whole payload", () => {
      const parsed = parseReview(JSON.stringify({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "maybe", note: "x" }] }), paths, rubricIds);
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/judgement must be/);
    });

    test("an oversize note refuses the whole payload", () => {
      const parsed = parseReview(
        JSON.stringify({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "x".repeat(REVIEW_LIMITS.note + 1) }] }),
        paths,
        rubricIds,
      );
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/note/);
    });

    test.each(["x".repeat(500), "😀".repeat(250), "e\u0301".repeat(250), "👩‍💻".repeat(100)])("Unicode note bounds use UTF-16 units without trimming conclusions (%#)", note => {
      expect(note.length).toBe(500);
      const payload = (commentNote: string, criterionNote: string) => JSON.stringify({ version: 1, comments: [{ path: "src/payouts.ts", note: commentNote }], criteria: [{ id: "c1", judgement: "cannot-tell", note: criterionNote }] });
      const accepted = parseReview(payload(note, note), paths, new Set(["c1"]));
      expect(accepted).toMatchObject({ ok: true, comments: [{ note }], criteria: [{ note }] });
      for (const [comment, criterion] of [[note + "!", note], [note, note + "!"]]) expect(parseReview(payload(comment!, criterion!), paths, new Set(["c1"])).ok).toBe(false);
    });

    test.each([527, 560, 530, 647, 588, 517, 510])("real-run note length %i remains a strict refusal", length => {
      expect(parseReview(JSON.stringify({ version: 1, comments: [], criteria: [{ id: "c1", judgement: "upholds", note: "x".repeat(length) }] }), paths, new Set(["c1"])).ok).toBe(false);
    });

    test("more than REVIEW_LIMITS.criteria judgements refuses the whole payload", () => {
      const many = new Set(Array.from({ length: REVIEW_LIMITS.criteria + 1 }, (_, i) => `c${i}`));
      const parsed = parseReview(
        JSON.stringify({
          version: 1,
          comments: [],
          criteria: Array.from({ length: REVIEW_LIMITS.criteria + 1 }, (_, i) => ({ id: `c${i}`, judgement: "upholds", note: "x" })),
        }),
        paths,
        many,
      );
      if (parsed.ok) throw new Error("expected refusal");
      expect(parsed.problems.map(one => one.reason).join(", ")).toMatch(/at most 12/);
    });
  });
});

describe("the reviewer role in the store", () => {
  let store: Store;
  let evidenceRoot: string;
  let taskRef: number;
  let builtRun: number;
  let diffArtifact: number;
  let approverToken: string;

  const seedBuilt = (patch: string = PATCH, opts: { truncated?: boolean; captureStatus?: "ok" | "failed" } = {}) => {
    const runId = store.startRun({
      taskRef,
      leaseId: `lease-${Math.random().toString(16).slice(2, 8)}`,
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
      ...presented(store, taskRef, "builder"),
    });
    // Truncation is forced the honest way: content past the kind's cap.
    const content = opts.truncated === true ? Buffer.alloc(300 * 1024, 0x61) : Buffer.from(patch, "utf8");
    const artifactId = storeEvidence(store, evidenceRoot, runId, "terminal-diff", "terminal-diff.patch", content, "git diff (exit 0)", T0, {
      captureStatus: opts.captureStatus ?? "ok",
    });
    store.recordOutcomeFacts(runId, { headRevision: "head-aaa", handoff: "guarded the payout" });
    store.finishRun(runId, { outcome: "built", committed: true, now: T0 });
    return { runId, artifactId };
  };
  /** The open review request a ROOT reviewer answers (raw authority
   * repair): asked through the real door, consumed by the admission. */
  const askReview = (run: number): { request: number } => {
    const asked = store.requestReview(run, "alex", T0);
    if (!asked.ok) throw new Error(`requestReview: ${asked.reason}`);
    return { request: asked.id };
  };

  beforeEach(() => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "so-review-evidence-"));
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    approverToken = alex.token;
    store.createTask({ id: "t-1", title: "wire the payout guard" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    store.placeTask(taskRef, REPO);
    // admitReview authenticates inside its transaction (review finding 4).
    register(store, { name: "builder-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-builder-1" });
    register(store, { name: "builder-2", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-builder-2" });
    const seeded = seedBuilt();
    builtRun = seeded.runId;
    diffArtifact = seeded.artifactId;
  });

  afterEach(() => {
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("watch review admission refuses missing, foreign, or expired custody without consuming the request", () => {
    const asked = askReview(builtRun);
    const spec = { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null, watchIncarnation: "watch-a" };
    expect(store.admitReview(asked.request, spec, T0)).toMatchObject({ ok: false, reason: "watch-custody" });
    store.acquireWatchLease("builder-1", REPO, "watch-a", 60_000, T0);
    expect(store.admitReview(asked.request, { ...spec, watchIncarnation: "watch-b" }, T0)).toMatchObject({ ok: false, reason: "watch-custody" });
    expect(store.admitReview(asked.request, spec, new Date(T0.getTime() + 60_000))).toMatchObject({ ok: false, reason: "watch-custody" });
    expect(store.runsFor(taskRef).filter(run => run.role === "reviewer")).toHaveLength(0);
    expect(store.raw().prepare("SELECT consumed_at FROM review_request WHERE id = ?").get(asked.request)).toMatchObject({ consumed_at: null });
    expect(store.admitReview(asked.request, spec, T0)).toMatchObject({ ok: true });
  });

  test("watch takeover fences and closes its review and correction, while leaving cron reviews and the built result intact", () => {
    const asked = askReview(builtRun);
    store.acquireWatchLease("builder-1", REPO, "watch-a", 60_000, T0);
    const admitted = store.admitReview(asked.request, {
      runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null, watchIncarnation: "watch-a",
    }, T0);
    if (!admitted.ok) throw new Error(admitted.reason);
    const parent = store.getRun(admitted.reviewerRunId)!;
    store.stampProviderStart(parent.id, T0);
    store.stampRun(parent.id, { sessionId: "watch-review-session" });
    const provenance = store.runRoute(parent.id)!;
    const correction = store.admitCorrection({
      taskRef, leaseId: parent.leaseId, runner: parent.runner, provider: "claude",
      sessionId: "watch-review-session", parentRun: parent.id,
      route: { routeDigest: provenance.routeDigest, phase: provenance.phase, provider: provenance.provider, model: provenance.model, chosen: provenance.chosen }, now: T0,
    });
    if (!correction.ok) throw new Error(correction.problem);
    expect(store.getRun(correction.runId)?.watchIncarnation).toBe("watch-a");
    const cronSource = seedBuilt().runId;
    const cronRequest = askReview(cronSource);
    const cron = store.admitReview(cronRequest.request, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null }, T0);
    if (!cron.ok) throw new Error(cron.reason);
    expect(store.proveRunnerCustodyForSpawn(correction.runId, T0)).toBe(true);
    const later = new Date(T0.getTime() + 60_001);
    store.acquireWatchLease("builder-1", REPO, "watch-b", 60_000, later);
    expect(store.proveRunnerCustodyForSpawn(correction.runId, later)).toBe(false);
    expect(store.proveRunnerCustodyForSpawn(cron.reviewerRunId, later)).toBe(true);
    expect(store.recoverIncarnation("builder-1", "watch-a", later)).toBe(2);
    expect(store.recoverIncarnation("builder-1", "watch-a", later)).toBe(0);
    for (const id of [parent.id, correction.runId]) expect(store.getRun(id)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    expect(store.getRun(cron.reviewerRunId)?.outcome).toBeNull();
    expect(store.getRun(builtRun)?.outcome).toBe("built");
    expect(store.raw().prepare("SELECT consumed_reason FROM review_request WHERE id = ?").get(asked.request)).toMatchObject({ consumed_reason: "interrupted" });
  });

  test("a rotation AFTER admission fences the reviewer spawn — the runner row is younger than the run", () => {
    // Round-2 finding 3: admitReview authenticates in its transaction,
    // but the run keeps only the runner NAME — so custody at spawn must
    // notice that the name changed hands since. Rotation re-registers,
    // which stamps a newer registered_at than the run's start.
    const asked = store.requestReview(builtRun, "alex", T0);
    if (!asked.ok) throw new Error("request failed");
    const admitted = store.admitReview(
      asked.id,
      { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null },
      T0,
    );
    if (!admitted.ok) throw new Error("admission failed");
    expect(store.proveRunnerCustodyForSpawn(admitted.reviewerRunId, new Date(T0.getTime() + 5_000))).toBe(true);
    register(store, { name: "builder-1", host: "elsewhere", repos: [REPO], now: new Date(T0.getTime() + 1_000), newToken: () => "tok-rotated" });
    expect(store.proveRunnerCustodyForSpawn(admitted.reviewerRunId, new Date(T0.getTime() + 5_000))).toBe(false);
  });

  test("a same-millisecond runner replacement still fences an admitted reviewer", () => {
    // The original runner is older than the reviewer. The replacement lands
    // in the reviewer's exact millisecond, so simply maxing wall time against
    // the prior registration would make both incarnations look identical.
    const admissionTime = new Date(T0.getTime() + 1_000);
    const asked = store.requestReview(builtRun, "alex", admissionTime);
    if (!asked.ok) throw new Error("request failed");
    const admitted = store.admitReview(
      asked.id,
      { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null },
      admissionTime,
    );
    if (!admitted.ok) throw new Error("admission failed");

    register(store, {
      name: "builder-1",
      host: "replacement",
      repos: [REPO],
      now: admissionTime,
      newToken: () => "tok-replaced-in-the-same-millisecond",
    });

    expect(store.proveRunnerCustodyForSpawn(admitted.reviewerRunId, admissionTime)).toBe(false);
  });

  test("a reviewer admitted after a logical same-millisecond replacement belongs to the new incarnation", () => {
    const replacement = register(store, {
      name: "builder-1",
      host: "replacement",
      repos: [REPO],
      now: T0,
      newToken: () => "tok-current-same-millisecond",
    });
    // Its atomically assigned generation is one logical millisecond ahead
    // of T0. Admission at the same coarse wall time must bind to that current
    // generation, not falsely reject it as a future replacement.
    expect(Date.parse(replacement.runner.registeredAt)).toBe(T0.getTime() + 1);
    const asked = store.requestReview(builtRun, "alex", T0);
    if (!asked.ok) throw new Error("request failed");
    const admitted = store.admitReview(
      asked.id,
      { runner: "builder-1", token: replacement.token, provider: "claude", model: null },
      T0,
    );
    if (!admitted.ok) throw new Error("admission failed");

    expect(store.getRun(admitted.reviewerRunId)?.startedAt).toBe(replacement.runner.registeredAt);
    expect(store.proveRunnerCustodyForSpawn(admitted.reviewerRunId, T0)).toBe(true);
  });

  test("startRun's reviewer arm opens without a workspace; the CHECK refuses every mixed shape", () => {
    const reviewer = store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0, ...presented(store, taskRef, "reviewer"), ...askReview(builtRun) });
    const row = store.getRun(reviewer);
    expect(row?.role).toBe("reviewer");
    expect(row?.branch).toBeNull();
    expect(row?.worktree).toBeNull();
    // A reviewer WITH a workspace, refused by the exclusive CHECK.
    expect(() =>
      store
        .raw()
        .prepare(
          "INSERT INTO run (task_ref, lease_id, runner, branch, worktree, role, provider, parent_run, started_at) VALUES (?, 'x', 'r', 'b', '/w', 'reviewer', 'claude', ?, ?)",
        )
        .run(taskRef, builtRun, T0.toISOString()),
    ).toThrow();
    // A builder WITHOUT one, equally refused.
    expect(() =>
      store
        .raw()
        .prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, started_at) VALUES (?, 'x', 'r', 'builder', 'claude', ?)")
        .run(taskRef, T0.toISOString()),
    ).toThrow();
  });

  test("one LIVE root review per source run — the partial uniques hold, and a spent request admits nothing (v50)", () => {
    const asked = askReview(builtRun);
    const root = store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0, ...presented(store, taskRef, "reviewer"), ...asked });
    // The request was consumed by the admission that answered it, and
    // bound to the root that answers it; the root is attempt 1.
    expect(store.raw().prepare("SELECT consumed_reason, reviewer_run FROM review_request WHERE id = ?").get(asked.request)).toEqual({ consumed_reason: "dispatched", reviewer_run: root });
    expect(store.getRun(root)?.reviewAttempt).toBe(1);
    expect(() =>
      store.startRun({ taskRef, leaseId: "review:2", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0, ...presented(store, taskRef, "reviewer"), ...asked }),
    ).toThrow(/is not run #\d+'s open request/);
    // A second ask refuses while the root is live, so no second request can exist.
    expect(store.requestReview(builtRun, "alex", T0)).toMatchObject({ ok: false, reason: "review-running" });
    // The live-root unique index itself, for a row that arrives some other way.
    expect(() =>
      store.raw().prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, parent_run, started_at, review_attempt) VALUES (?, 'x', 'r', 'reviewer', 'claude', ?, ?, 2)").run(taskRef, builtRun, T0.toISOString()),
    ).toThrow();
    // …and the ordinal index: a second attempt 1 never exists.
    store.finishRun(root, { outcome: "failed", reason: "reviewer-agent", now: T0 });
    expect(() =>
      store.raw().prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, parent_run, started_at, review_attempt) VALUES (?, 'x', 'r', 'reviewer', 'claude', ?, ?, 1)").run(taskRef, builtRun, T0.toISOString()),
    ).toThrow();
    // v29's one-root-ever index is gone; the four v50 backstops stand.
    const indexes = store.raw().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('run', 'review_request')").all().map(row => String(row["name"]));
    expect(indexes).not.toContain("one_review_per_source");
    for (const name of ["root_review_attempt_ordinal", "one_live_root_review_per_source", "one_successful_root_review_per_source", "one_correction_per_reviewer", "one_root_review_per_request"]) {
      expect(indexes).toContain(name);
    }
  });

  test("requestReview: every refusal road is typed", () => {
    expect(store.requestReview(9999, "alex", T0)).toEqual({ ok: false, reason: "no-run" });

    const open = store.startRun({ taskRef, leaseId: "lease-x", runner: "builder-1", branch: "b", worktree: "/w", now: T0, ...presented(store, taskRef, "builder") });
    expect(store.requestReview(open, "alex", T0)).toEqual({ ok: false, reason: "unfinished" });
    store.finishRun(open, { outcome: "built", committed: true, now: T0 });
    expect(store.requestReview(open, "alex", T0)).toEqual({ ok: false, reason: "no-diff" });

    const truncated = seedBuilt(PATCH, { truncated: true });
    expect(store.requestReview(truncated.runId, "alex", T0)).toEqual({ ok: false, reason: "diff-truncated" });

    // A failed capture stored the failure's words AS the artifact —
    // reviewing an error message is refused, and the run's one review
    // allowance survives for a recapture (round-1 finding 5a).
    const broken = seedBuilt(PATCH, { captureStatus: "failed" });
    expect(store.requestReview(broken.runId, "alex", T0)).toEqual({ ok: false, reason: "diff-capture-failed" });

    const first = store.requestReview(builtRun, "alex", T0);
    expect(first).toMatchObject({ ok: true, attempt: 1 });
    expect(store.requestReview(builtRun, "alex", T0)).toEqual({ ok: false, reason: "already-requested" });

    // A run that already HAS its review refuses a fresh ask.
    const other = seedBuilt();
    const reviewer = store.startRun({ taskRef: store.refFor("built-in", "t-1").id, leaseId: "review:3", runner: "builder-1", role: "reviewer", parentRun: other.runId, now: T0, ...presented(store, store.refFor("built-in", "t-1").id, "reviewer"), ...askReview(other.runId) });
    store.finishRun(reviewer, { outcome: "no-change", reason: "reviewed — 0 comment(s)", now: T0 });
    expect(store.requestReview(other.runId, "alex", T0)).toMatchObject({ ok: false, reason: "already-reviewed" });

    // And a review itself is not reviewable.
    expect(store.requestReview(reviewer, "alex", T0)).toEqual({ ok: false, reason: "not-reviewable" });
  });

  test("addReviewerComments proves role, parentage, task, and artifact binding", () => {
    const reviewer = store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0, ...presented(store, taskRef, "reviewer"), ...askReview(builtRun) });
    store.stampProviderStart(reviewer, T0);
    const comment = { path: "src/payouts.ts", line: 2, note: "the limiter is never awaited", severity: "problem" as const };

    // A non-reviewer cannot author.
    expect(() =>
      store.addReviewerComments({ reviewerRunId: builtRun, runId: builtRun, artifactId: diffArtifact, author: "reviewer:claude", comments: [comment] }, T0),
    ).toThrow(/not a reviewer/);

    // Wrong parentage: a second built run this reviewer was never minted for.
    const other = seedBuilt();
    expect(() =>
      store.addReviewerComments({ reviewerRunId: reviewer, runId: other.runId, artifactId: other.artifactId, author: "reviewer:claude", comments: [comment] }, T0),
    ).toThrow(/reviews run/);

    // The right run, somebody else's artifact.
    expect(() =>
      store.addReviewerComments({ reviewerRunId: reviewer, runId: builtRun, artifactId: other.artifactId, author: "reviewer:claude", comments: [comment] }, T0),
    ).toThrow(/terminal diff/);

    const ids = store.addReviewerComments(
      { reviewerRunId: reviewer, runId: builtRun, artifactId: diffArtifact, author: "reviewer:claude·opus", comments: [comment] },
      T0,
    );
    expect(ids).toHaveLength(1);
    const live = store.liveDiffComments(builtRun);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      run: builtRun,
      artifact: diffArtifact,
      path: "src/payouts.ts",
      line: 2,
      author: "reviewer:claude·opus",
      reviewerRun: reviewer,
      severity: "problem",
    });
    // The human road's comments stay severity-free.
    const human = store.addDiffComment({ artifactId: diffArtifact, runId: builtRun, path: null, line: null, note: "looks fine", author: "alex" }, T0);
    expect(human).not.toBeNull();
    const all = store.liveDiffComments(builtRun);
    expect(all[1]?.reviewerRun).toBeNull();
    expect(all[1]?.severity).toBeNull();
  });

  test("a correction child cannot borrow another runner or lease", () => {
    const rootReviewer = store.startRun({
      taskRef,
      leaseId: "review:root",
      runner: "builder-1",
      role: "reviewer",
      parentRun: builtRun,
      provider: "claude",
      sessionId: "review-session",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
      ...askReview(builtRun),
    });
    store.stampProviderStart(rootReviewer, T0);
    // THE CORRECTION ADMISSION (atomic authority closure): the generic road
    // opens no correction; the dedicated road refuses a foreign runner,
    // lease, or session, and a parent takes one correction, ever — each
    // refusal in words, zero rows.
    const rootStamp = presented(store, taskRef, "reviewer") as { route: import("./phase-routing.js").RouteStamp };
    const correct = (over: Partial<Parameters<Store["admitCorrection"]>[0]> = {}) =>
      store.admitCorrection({ taskRef, leaseId: "review:root", runner: "builder-1", parentRun: rootReviewer, provider: "claude", sessionId: "review-session", now: T0, ...rootStamp, ...over });
    const rows = () => store.runsFor(taskRef).length;
    const before = rows();
    expect(() => store.startRun({ taskRef, leaseId: "review:root", runner: "builder-1", role: "reviewer", parentRun: rootReviewer, provider: "claude", sessionId: "review-session", now: T0, ...rootStamp } as never)).toThrow(/a correction child is admitted by admitCorrection/);
    expect(correct({ runner: "builder-2" })).toMatchObject({ ok: false, problem: expect.stringMatching(/runs on builder-1 — a correction on builder-2 is another machine's/) });
    expect(correct({ leaseId: "borrowed" })).toMatchObject({ ok: false, problem: expect.stringMatching(/holds lease review:root — a correction under lease borrowed is not its own/) });
    expect(correct({ sessionId: "another-session" })).toMatchObject({ ok: false, problem: expect.stringMatching(/resumes the root reviewer's session review-session — another-session is another/) });
    expect(rows()).toBe(before);
    const admittedChild = correct();
    if (!admittedChild.ok) throw new Error(admittedChild.problem);
    const child = admittedChild.runId;
    expect(store.getRun(child)).toMatchObject({ role: "reviewer", parentRun: rootReviewer, runner: "builder-1", leaseId: "review:root", sessionId: "review-session" });
    expect(correct()).toMatchObject({ ok: false, problem: expect.stringMatching(/was corrected once already \(run #\d+\) — a correction grant is one-use/) });
    expect(rows()).toBe(before + 1);
    store.stampProviderStart(child, T0);
    store.raw().prepare("UPDATE run SET runner = ?, lease_id = ? WHERE id = ?").run("builder-2", "borrowed", child);

    expect(() =>
      store.addReviewerComments(
        {
          reviewerRunId: child,
          runId: builtRun,
          artifactId: diffArtifact,
          author: "reviewer:claude",
          comments: [{ path: "src/payouts.ts", line: 2, note: "borrowed", severity: "problem" }],
        },
        T0,
      ),
    ).toThrow(/bounded lineage/);
  });

  test("a later correction cannot ingest until every superseded correction is terminal failed", () => {
    const root = store.startRun({
      taskRef,
      leaseId: "review:linear",
      runner: "builder-1",
      role: "reviewer",
      parentRun: builtRun,
      provider: "claude",
      sessionId: "review-session",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
      ...askReview(builtRun),
    });
    const linearStamp = presented(store, taskRef, "reviewer") as { route: import("./phase-routing.js").RouteStamp };
    const correctAfter = (parentRun: number) =>
      store.admitCorrection({ taskRef, leaseId: "review:linear", runner: "builder-1", parentRun, provider: "claude", sessionId: "review-session", now: T0, ...linearStamp });
    const first = correctAfter(root);
    if (!first.ok) throw new Error(first.problem);
    const firstCorrection = first.runId;
    // The next correction continues an ENDED one (atomic authority
    // closure): while the first is open, no leaf opens beneath it.
    expect(correctAfter(firstCorrection)).toMatchObject({ ok: false, problem: expect.stringMatching(/is still open — the next correction continues an ended one/) });
    store.finishRun(firstCorrection, { outcome: "failed", reason: "reviewer-malformed-review", now: T0 });
    const leaf = correctAfter(firstCorrection);
    if (!leaf.ok) throw new Error(leaf.problem);
    const acceptedLeaf = leaf.runId;
    // Forge the invalid history the ingest guard must still refuse: the
    // superseded correction reopened under the leaf.
    store.raw().prepare("UPDATE run SET outcome = NULL, reason = NULL, finished_at = NULL WHERE id = ?").run(firstCorrection);
    for (const run of [root, firstCorrection, acceptedLeaf]) store.stampProviderStart(run, T0);
    const diffSha = store.getArtifact(diffArtifact)?.sha256;
    if (diffSha === undefined) throw new Error("missing diff fixture");
    const review = {
      reviewerRunId: acceptedLeaf,
      runId: builtRun,
      artifactId: diffArtifact,
      author: "reviewer:claude",
      comments: [{ path: "src/payouts.ts", line: 2, note: "only the accepted leaf may land", severity: "problem" as const }],
      judgements: [],
      bindings: {
        diffSha,
        scopeDigest: null,
        headSha: "head-aaa",
        proof: null,
        checkLog: null,
        screenshots: [],
      },
    };

    // root(open) -> correction(open) -> accepted leaf(open) is not a valid
    // correction history. The proving transaction refuses it before the
    // comment insert, and leaves every run unchanged.
    expect(() => store.ingestReview(review, T0)).toThrow(/nothing is ingested/);
    expect(store.liveDiffComments(builtRun)).toHaveLength(0);
    expect([root, firstCorrection, acceptedLeaf].map(run => store.getRun(run)?.outcome)).toEqual([null, null, null]);

    // Once the superseded attempt is truthfully terminal failed, the exact
    // same leaf is a valid lineage and root + leaf finalize atomically.
    store.finishRun(firstCorrection, { outcome: "failed", reason: "reviewer-malformed-review", now: T0 });
    expect(store.proveRunnerCustodyForSpawn(acceptedLeaf, T0)).toBe(true);
    expect(store.ingestReview(review, T0).commentIds).toHaveLength(1);
    expect(store.getRun(root)).toMatchObject({ outcome: "no-change", reason: "reviewed — 1 comment(s)" });
    expect(store.getRun(firstCorrection)).toMatchObject({ outcome: "failed", reason: "reviewer-malformed-review" });
    expect(store.getRun(acceptedLeaf)).toMatchObject({ outcome: "no-change", reason: "structured review repaired" });
    expect(store.liveDiffComments(builtRun)).toHaveLength(1);
  });

  test("ingest closes a root-authored review atomically and refuses a crash replay", () => {
    const reviewer = store.startRun({
      taskRef,
      leaseId: "review:atomic-root",
      runner: "builder-1",
      role: "reviewer",
      parentRun: builtRun,
      provider: "claude",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
      ...askReview(builtRun),
    });
    store.stampProviderStart(reviewer, T0);
    const diffSha = store.getArtifact(diffArtifact)?.sha256;
    if (diffSha === undefined) throw new Error("missing diff fixture");
    const review = {
      reviewerRunId: reviewer,
      runId: builtRun,
      artifactId: diffArtifact,
      author: "reviewer:claude",
      comments: [{ path: "src/payouts.ts", line: 2, note: "atomic", severity: "problem" as const }],
      judgements: [],
      bindings: {
        diffSha,
        scopeDigest: null,
        headSha: "head-aaa",
        proof: null,
        checkLog: null,
        screenshots: [],
      },
    };

    expect(store.ingestReview(review, T0).commentIds).toHaveLength(1);
    expect(store.getRun(reviewer)).toMatchObject({ outcome: "no-change", reason: "reviewed — 1 comment(s)" });
    expect(store.liveDiffComments(builtRun)).toHaveLength(1);

    // Simulate the process returning after the commit without observing its
    // result. The closed root is part of that same commit, so replay cannot
    // duplicate the review even though the caller submits identical bytes.
    expect(() => store.ingestReview(review, T0)).toThrow(/nothing is ingested/);
    expect(store.liveDiffComments(builtRun)).toHaveLength(1);
  });

  test("a root finalization failure rolls the entire review ingest back", () => {
    const reviewer = store.startRun({
      taskRef,
      leaseId: "review:atomic-rollback",
      runner: "builder-1",
      role: "reviewer",
      parentRun: builtRun,
      provider: "claude",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
      ...askReview(builtRun),
    });
    store.stampProviderStart(reviewer, T0);
    const diffSha = store.getArtifact(diffArtifact)?.sha256;
    if (diffSha === undefined) throw new Error("missing diff fixture");
    store.raw().exec(
      `CREATE TRIGGER refuse_reviewer_finish
         BEFORE UPDATE OF outcome ON run
         WHEN OLD.id = ${reviewer}
         BEGIN
           SELECT RAISE(ABORT, 'simulated finalization crash');
         END`,
    );

    expect(() =>
      store.ingestReview(
        {
          reviewerRunId: reviewer,
          runId: builtRun,
          artifactId: diffArtifact,
          author: "reviewer:claude",
          comments: [{ path: "src/payouts.ts", line: 2, note: "must roll back", severity: "problem" }],
          judgements: [],
          bindings: {
            diffSha,
            scopeDigest: null,
            headSha: "head-aaa",
            proof: null,
            checkLog: null,
            screenshots: [],
          },
        },
        T0,
      ),
    ).toThrow(/simulated finalization crash/);
    expect(store.getRun(reviewer)?.outcome).toBeNull();
    expect(store.liveDiffComments(builtRun)).toHaveLength(0);
  });

  test("criterion ingest requires one judgement for every stored matrix id and rolls malformed sets back", () => {
    const reviewer = store.startRun({
      taskRef,
      leaseId: "review:criterion-set",
      runner: "builder-1",
      role: "reviewer",
      parentRun: builtRun,
      provider: "claude",
      now: T0,
      ...presented(store, taskRef, "reviewer"),
      ...askReview(builtRun),
    });
    store.stampProviderStart(reviewer, T0);
    const diffSha = store.getArtifact(diffArtifact)?.sha256;
    if (diffSha === undefined) throw new Error("missing diff fixture");
    const bindings = {
      diffSha,
      scopeDigest: null,
      headSha: "head-aaa",
      proof: null,
      checkLog: null,
      screenshots: [],
    };
    const comment = { path: "src/payouts.ts", line: 2, note: "must be atomic", severity: "problem" as const };
    const ingest = (judgements: readonly { id: string; judgement: "upholds"; note: string }[]) =>
      store.ingestReview(
        {
          reviewerRunId: reviewer,
          runId: builtRun,
          artifactId: diffArtifact,
          author: "reviewer:claude",
          comments: [comment],
          judgements,
          bindings,
        },
        T0,
      );

    expect(() => ingest([{ id: "c1", judgement: "upholds", note: "looks right" }])).toThrow(/no proof verdict/);
    expect(store.liveDiffComments(builtRun)).toHaveLength(0);
    expect(store.getRun(reviewer)?.outcome).toBeNull();

    const matrix: CriterionMatrixRow[] = ["c1", "c2"].map(id => ({
      id,
      statement: `criterion ${id}`,
      requiredEvidence: ["manual-review"],
      state: "manual-review",
      detail: [],
      answered: [],
      review: null,
    }));
    store.saveProofVerdict(builtRun, "short", ["needs review"], T0, matrix);

    // An empty caller array is not proof that no rubric exists. The store
    // re-derives the matrix before its comments-only fast path, so a direct
    // or replayed caller cannot spend the one review without judging c1/c2.
    expect(() => ingest([])).toThrow(/exact stored criterion set/);
    expect(store.liveDiffComments(builtRun)).toHaveLength(0);
    expect(store.criterionReviewsFor(builtRun)).toEqual([]);
    expect(store.getRun(reviewer)?.outcome).toBeNull();

    expect(() =>
      ingest([
        { id: "c1", judgement: "upholds", note: "first" },
        { id: "c1", judgement: "upholds", note: "duplicate" },
      ]),
    ).toThrow(/more than once/);
    expect(() =>
      ingest([
        { id: "c1", judgement: "upholds", note: "present" },
        { id: "c3", judgement: "upholds", note: "not signed" },
      ]),
    ).toThrow(/exact stored criterion set/);
    expect(store.liveDiffComments(builtRun)).toHaveLength(0);
    expect(store.criterionReviewsFor(builtRun)).toEqual([]);
    expect(store.proofVerdictFor(builtRun)).toMatchObject({ verdict: "short", machineVerdict: null });
    expect(store.getRun(reviewer)?.outcome).toBeNull();

    expect(
      ingest([
        { id: "c1", judgement: "upholds", note: "covered" },
        { id: "c2", judgement: "upholds", note: "covered" },
      ]).commentIds,
    ).toHaveLength(1);
    expect(store.criterionReviewsFor(builtRun).map(row => row.criterionId)).toEqual(["c1", "c2"]);
    expect(store.getRun(reviewer)?.outcome).toBe("no-change");
  });

  describe("historical review admission", () => {

    test("admission re-proves the review leg INSIDE its transaction: a provider/model mismatch, a null model, an unavailable provider, and an unreadable route all refuse before any run exists (v47)", async () => {
      store.setPhaseConfig("installation", "build", "claude", "claude-sonnet-4", "alex", T0);
      store.setPhaseConfig("installation", "plan", "claude", "claude-sonnet-4", "alex", T0);
      store.setPhaseConfig("installation", "review", "claude", "claude-sonnet-4", "alex", T0);
      propose(store, { taskId: "t-1", goal: "guard the payouts", acceptance: [{ id: "c1", statement: "guarded", how: null, evidence: ["check"] }], now: T0 });
      expect(approve(store, "t-1", "alex", T0, store.getScope("t-1")!.digest, approverToken).ok).toBe(true);
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("request failed");
      const admit = (spec: { provider: string; model: string | null }, runner = "builder-1", token = "tok-builder-1") =>
        store.admitReview(asked.id, { runner, token, ...spec }, T0);
      // Another provider, another model, no model: refused, request still open.
      expect(admit({ provider: "codex", model: "gpt-5-codex" })).toMatchObject({ ok: false, reason: "route-mismatch" });
      expect(admit({ provider: "claude", model: "claude-opus-4-1" })).toMatchObject({ ok: false, reason: "route-mismatch" });
      const nullModel = admit({ provider: "claude", model: null });
      expect(nullModel).toMatchObject({ ok: false, reason: "route-mismatch" });
      if (!nullModel.ok) expect(nullModel.detail).toContain("with no model");
      expect(store.openReviewRequests()).toHaveLength(1);
      expect(store.runsFor(taskRef).filter(run => run.role === "reviewer")).toHaveLength(0);
      // The exact leg, but the provider is reported unavailable on this runner.
      store.recordProviderReadiness("builder-1", [{ provider: "claude", state: "unavailable", reason: "not installed", probe: "version" }], T0);
      expect(admit({ provider: "claude", model: "claude-sonnet-4" })).toMatchObject({ ok: false, reason: "provider-unavailable" });
      expect(store.openReviewRequests()).toHaveLength(1);
      // Route data removed from the routed row: the request is spent, unrun, in words.
      const kept = store.getScope("t-1")!.approvedRouteJson;
      store.raw().prepare("UPDATE task_scope SET approved_route_json = NULL WHERE task_id = 't-1'").run();
      expect(store.requestReview(builtRun, "alex", T0)).toMatchObject({ ok: false, reason: "route-unreadable" });
      const unreadable = admit({ provider: "claude", model: "claude-sonnet-4" }, "builder-2", "tok-builder-2");
      expect(unreadable).toMatchObject({ ok: false, reason: "route-changed" });
      if (!unreadable.ok) expect(unreadable.detail).toContain("sealed no agent route");
      expect(store.openReviewRequests()).toHaveLength(0);
      expect(store.requestReview(builtRun, "alex", T0)).toMatchObject({ ok: false, reason: "route-unreadable" });
      // Restored: the exact leg admits, and the run carries its provenance.
      store.raw().prepare("UPDATE task_scope SET approved_route_json = ? WHERE task_id = 't-1'").run(kept);
      const again = store.requestReview(builtRun, "alex", new Date(T0.getTime() + 1_000));
      if (!again.ok) throw new Error("request failed");
      const admitted = store.admitReview(again.id, { runner: "builder-2", token: "tok-builder-2", provider: "claude", model: "claude-sonnet-4" }, T0);
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;
      expect(store.runRoute(admitted.reviewerRunId)).toMatchObject({ phase: "review", provider: "claude", model: "claude-sonnet-4", chosen: "recommended", routeDigest: routeDigestOf(store.approvedRouteOf("t-1")!) });
    });

    describe("v50: retained review retry rows", () => {
      const retryState = () => store.reviewRetryStateOf(builtRun)!;
      const rootsOf = (source: number) => store.runsFor(taskRef).filter(one => one.role === "reviewer" && one.parentRun === source).sort((a, b) => a.id - b.id);

      test("an interrupted root is retryable, and its late output can no longer ingest once the retry is the live bound root", async () => {
        const first = store.requestReview(builtRun, "alex", T0);
        if (!first.ok) throw new Error(first.reason);
        store.acquireWatchLease("builder-1", REPO, "watch-a", 60_000, T0);
        const admitted = store.admitReview(first.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null, watchIncarnation: "watch-a" }, T0);
        if (!admitted.ok) throw new Error(admitted.reason);
        store.stampProviderStart(admitted.reviewerRunId, T0);
        // The watch dies; its successor closes the attempt as interrupted.
        const later = new Date(T0.getTime() + 60_001);
        store.acquireWatchLease("builder-1", REPO, "watch-b", 60_000, later);
        expect(store.recoverIncarnation("builder-1", "watch-a", later)).toBe(1);
        expect(store.getRun(admitted.reviewerRunId)).toMatchObject({ outcome: "failed", reason: "interrupted", reviewAttempt: 1 });
        expect(store.raw().prepare("SELECT consumed_reason, reviewer_run FROM review_request WHERE id = ?").get(first.id)).toEqual({ consumed_reason: "interrupted", reviewer_run: admitted.reviewerRunId });
        expect(retryState()).toMatchObject({ state: "retryable", retriesRemaining: 2, nextAttempt: 2 });

        const retry = store.requestReview(builtRun, "alex", later);
        expect(retry).toMatchObject({ ok: true, attempt: 2 });
        if (!retry.ok) return;
        const second = store.admitReview(retry.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null, watchIncarnation: "watch-b" }, later);
        expect(second).toMatchObject({ ok: true, attempt: 2 });
        if (!second.ok) return;
        store.stampProviderStart(second.reviewerRunId, later);
        const ingest = (reviewerRunId: number) =>
          store.ingestReview(
            {
              reviewerRunId,
              runId: builtRun,
              artifactId: diffArtifact,
              author: "reviewer:claude",
              comments: [{ path: "src/payouts.ts", line: 2, note: "late", severity: "note" }],
              judgements: [],
              bindings: { diffSha: store.artifactsFor(builtRun)[0]!.sha256, scopeDigest: null, headSha: "head-aaa", proof: null, checkLog: null, screenshots: [] },
            },
            later,
          );
        // The interrupted attempt's late reply: refused whole, nothing lands.
        expect(() => ingest(admitted.reviewerRunId)).toThrow(/no longer has a live, provider-started admitted lineage|runner custody/);
        expect(store.liveDiffComments(builtRun)).toHaveLength(0);
        expect(store.getRun(second.reviewerRunId)?.outcome).toBeNull();
        // The live bound root ingests exactly once.
        expect(ingest(second.reviewerRunId).commentIds).toHaveLength(1);
        expect(store.getRun(second.reviewerRunId)).toMatchObject({ outcome: "no-change", reviewAttempt: 2 });
        expect(retryState()).toMatchObject({ state: "succeeded" });
      });

      test("admitReview re-proves the allowance inside its transaction: a queued request overtaken by success, a live root, or exhaustion is spent unrun, in words", () => {
        const spec = { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null };
        const rawRoot = (source: number, attempt: number, outcome: string | null) =>
          Number(store.raw().prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, parent_run, started_at, outcome, review_attempt) VALUES (?, 'x', 'builder-1', 'reviewer', 'claude', ?, ?, ?, ?)").run(taskRef, source, T0.toISOString(), outcome, attempt).lastInsertRowid);
        const ask = (source: number) => {
          const asked = store.requestReview(source, "alex", T0);
          if (!asked.ok) throw new Error(asked.reason);
          return asked.id;
        };
        // Overtaken by a success.
        const won = ask(builtRun);
        rawRoot(builtRun, 1, "no-change");
        expect(store.admitReview(won, spec, T0)).toMatchObject({ ok: false, reason: "already-reviewed" });
        expect(store.raw().prepare("SELECT consumed_reason, reviewer_run FROM review_request WHERE id = ?").get(won)).toEqual({ consumed_reason: "already-reviewed", reviewer_run: null });
        // Overtaken by a root that is still open.
        const live = seedBuilt().runId;
        const queued = ask(live);
        rawRoot(live, 1, null);
        expect(store.admitReview(queued, spec, T0)).toMatchObject({ ok: false, reason: "review-running" });
        expect(store.raw().prepare("SELECT consumed_reason FROM review_request WHERE id = ?").get(queued)).toEqual({ consumed_reason: "review-running" });
        // Overtaken by exhaustion.
        const spent = seedBuilt().runId;
        const last = ask(spent);
        for (const attempt of [1, 2, 3]) rawRoot(spent, attempt, "failed");
        expect(store.admitReview(last, spec, T0)).toMatchObject({ ok: false, reason: "retries-exhausted" });
        expect(store.raw().prepare("SELECT consumed_reason FROM review_request WHERE id = ?").get(last)).toEqual({ consumed_reason: "retries-exhausted" });
        // None of the three opened a run.
        expect(store.runsFor(taskRef).filter(one => one.role === "reviewer" && one.outcome === null && one.parentRun !== live)).toEqual([]);
        expect(store.openReviewRequests()).toEqual([]);
      });

      test("concurrent connections: one open request, one live root, and one landed review per source run", () => {
        const dir = mkdtempSync(join(tmpdir(), "so-review-race-"));
        const file = join(dir, "orders.db");
        const raceEvidence = join(dir, "evidence");
        const a = openStore(file);
        try {
          addApprover(a, "alex", T0);
          a.createTask({ id: "t-race", title: "race" }, T0);
          const ref = a.refFor("built-in", "t-race").id;
          a.placeTask(ref, REPO);
          register(a, { name: "builder-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-builder-1" });
          const source = a.startRun({ taskRef: ref, leaseId: "lease-race", runner: "builder-1", branch: "b", worktree: "/w", now: T0, ...presented(a, ref, "builder") });
          storeEvidence(a, raceEvidence, source, "terminal-diff", "terminal-diff.patch", Buffer.from(PATCH, "utf8"), "git diff (exit 0)", T0, { captureStatus: "ok" });
          a.finishRun(source, { outcome: "built", committed: true, now: T0 });
          const b = openStore(file);
          try {
            const spec = { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null };
            // Two operators ask at once: exactly one request opens.
            const asks = [a.requestReview(source, "alex", T0), b.requestReview(source, "sam", T0)];
            expect(asks.filter(one => one.ok)).toHaveLength(1);
            expect(asks.filter(one => !one.ok).map(one => (one as { reason: string }).reason)).toEqual(["already-requested"]);
            const request = (asks.find(one => one.ok) as { id: number }).id;
            // Two passes admit the same request: one root opens, the other finds it gone.
            const admissions = [a.admitReview(request, spec, T0), b.admitReview(request, spec, T0)];
            expect(admissions.filter(one => one.ok)).toHaveLength(1);
            expect(admissions.filter(one => !one.ok).map(one => (one as { reason: string }).reason)).toEqual(["gone"]);
            const root = (admissions.find(one => one.ok) as { reviewerRunId: number }).reviewerRunId;
            expect(b.getRun(root)).toMatchObject({ reviewAttempt: 1, outcome: null });
            // While it is live, neither connection may ask again.
            expect(a.requestReview(source, "alex", T0)).toMatchObject({ ok: false, reason: "review-running" });
            expect(b.requestReview(source, "sam", T0)).toMatchObject({ ok: false, reason: "review-running" });
            a.stampProviderStart(root, T0);
            const diff = a.artifactsFor(source).find(one => one.kind === "terminal-diff")!;
            const args = {
              reviewerRunId: root, runId: source, artifactId: diff.id, author: "reviewer:claude",
              comments: [{ path: "src/payouts.ts", line: 2, note: "once", severity: "note" as const }], judgements: [],
              bindings: { diffSha: diff.sha256, scopeDigest: null, headSha: null, proof: null, checkLog: null, screenshots: [] },
            };
            // The review lands exactly once: the second connection's replay
            // finds the root closed and ingests nothing.
            expect(a.ingestReview(args, T0).commentIds).toHaveLength(1);
            expect(() => b.ingestReview(args, T0)).toThrow(/runner custody no longer stands|no longer has a live, provider-started admitted lineage/);
            expect(b.liveDiffComments(source)).toHaveLength(1);
            expect(b.reviewRetryStateOf(source)).toMatchObject({ state: "succeeded", retriesRemaining: 0 });
            expect(b.requestReview(source, "sam", T0)).toMatchObject({ ok: false, reason: "already-reviewed" });
          } finally {
            b.close();
          }
        } finally {
          a.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

      describe("signed automatic review service retries", () => {
        const spec = { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: "sonnet" };
        const signRetry = (overrides: Partial<ReturnType<typeof presetTerms>> = {}) => {
          const terms = { ...presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString()), reviewRetryAuto: true, ...overrides };
          store.signMode({ repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, T0);
          return terms;
        };
        const authorize = () => {
          for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
          const scope = propose(store, { taskId: "t-1", goal: "guard the payout", acceptance: [{ id: "c1", statement: "guarded", how: null, evidence: ["manual-review"] }], now: T0 });
          expect(approve(store, "t-1", "alex", T0, scope.digest, approverToken).ok).toBe(true);
          store.stampRun(builtRun, { scopeDigest: scope.digest });
          store.saveProofVerdict(builtRun, "short", ["needs review"], T0, [{ id: "c1", statement: "guarded", requiredEvidence: ["manual-review"], state: "manual-review", detail: [], answered: [], review: null }]);
          return signRetry();
        };
        const finishFirst = (reason = "reviewer-agent") => {
          const asked = store.requestReview(builtRun, "alex", T0);
          if (!asked.ok) throw new Error(asked.reason);
          const admitted = store.admitReview(asked.id, spec, T0);
          if (!admitted.ok) throw new Error(admitted.reason);
          store.finishRun(admitted.reviewerRunId, { outcome: "failed", reason, now: T0 });
          store.stampReviewRequestOutcome(asked.id, reason);
          return admitted.reviewerRunId;
        };

        for (const reason of ["reviewer-agent", "reviewer-timeout", "reviewer-provider-init"])
          test(`only service failure ${reason} is eligible, and existing automatic producers stay one-shot`, () => {
            const terms = authorize();
            finishFirst(reason);
            expect(store.requestReview(builtRun, "alex", T0, { kind: "mode", digest: modeDigestOf(terms) })).toMatchObject({ ok: false, reason: "explicit-only" });
            expect(store.requestAutomaticReviewRetry(builtRun, T0)).toMatchObject({ ok: true, attempt: 2 });
            expect(store.requestAutomaticReviewRetry(builtRun, T0).ok).toBe(false);
            expect(store.openReviewRequests()).toHaveLength(1);
          });

        for (const reason of ["reviewer-malformed-review", "reviewer-no-op", "reviewer-evidence", "reviewer-dirty-scratch", "reviewer-stale-evidence", "reviewer-runner-custody", "reviewer-invocation", "reviewer-admission", "reviewer-ingestion", "reviewer-ingestion: database busy", "reviewer-stopped", "interrupted"])
          test(`${reason} requires an operator decision even with signed retry authority`, () => {
            authorize(); finishFirst(reason);
            store.reconcileAutomaticReviewRetries(T0);
            expect(store.requestAutomaticReviewRetry(builtRun, T0).ok).toBe(false);
            expect(store.openReviewRequests()).toEqual([]);
          });

        test("withdrawal, scope drift, stopped work, and changed authority are re-proved before any retry starts", () => {
          authorize(); finishFirst();
          const queued = store.requestAutomaticReviewRetry(builtRun, T0);
          if (!queued.ok) throw new Error(queued.reason);
          store.revokeMode(REPO, "alex", "operator", T0);
          expect(() => store.startRun({ taskRef, leaseId: "raw-retry", runner: "builder-1", role: "reviewer", parentRun: builtRun, request: queued.id, now: T0, provider: "claude", model: "sonnet", ...presented(store, taskRef, "reviewer") })).toThrow(/signed mode/);
          expect(store.admitReview(queued.id, spec, T0)).toMatchObject({ ok: false, reason: "mode-ended" });
          signRetry();
          store.reconcileAutomaticReviewRetries(T0);
          expect(store.openReviewRequests()).toEqual([]); // A consumed refusal is never resurrected.
          expect(rootsOf(builtRun)).toHaveLength(1);
        });

        for (const change of ["mode-digest", "mode-expiry", "scope-digest", "project-access", "scope-signer", "hold", "source-integrity"] as const)
          test(`queued retry re-proves ${change} before reserving a run`, () => {
            authorize(); const failed = finishFirst();
            const queued = store.requestAutomaticReviewRetry(builtRun, T0);
            if (!queued.ok) throw new Error(queued.reason);
            const reservations = store.raw().prepare("SELECT SUM(reserved_starts) AS n FROM mode_rail").get()!["n"];
            if (change === "mode-digest") signRetry({ dailyRunCap: 9 });
            if (change === "scope-digest") store.raw().prepare("UPDATE task_scope SET digest = 'changed' WHERE task_id = 't-1'").run();
            if (change === "project-access") store.raw().prepare("UPDATE approver SET projects_json = '[]' WHERE name = 'alex'").run();
            if (change === "scope-signer") store.raw().prepare("UPDATE task_scope SET approved_by = 'missing' WHERE task_id = 't-1'").run();
            if (change === "hold") store.hold(taskRef, "operator pause", null, T0);
            if (change === "source-integrity") store.saveProofVerdict(builtRun, "refuted", ["criterion was signed as a different statement"], T0, []);
            expect(store.admitReview(queued.id, spec, change === "mode-expiry" ? new Date(T0.getTime() + 24 * 60 * 60_000) : T0).ok).toBe(false);
            expect(rootsOf(builtRun)).toHaveLength(1);
            expect(store.raw().prepare("SELECT SUM(reserved_starts) AS n FROM mode_rail").get()!["n"]).toBe(reservations);
          });

        test("recovery pages at most fifty failures and advances past older ineligible sources", () => {
          // Real completed, manually requested failures without a signed scope
          // remain ineligible; they must not hide a later authorized source.
          for (let i = 0; i < 50; i++) {
            const asked = store.requestReview(builtRun, "alex", T0);
            if (!asked.ok) throw new Error(asked.reason);
            const admitted = store.admitReview(asked.id, { ...spec, model: null }, T0);
            if (!admitted.ok) throw new Error(admitted.reason);
            store.finishRun(admitted.reviewerRunId, { outcome: "failed", reason: "reviewer-agent", now: T0 });
            builtRun = seedBuilt().runId;
          }
          authorize(); finishFirst();
          store.reconcileAutomaticReviewRetries(T0);
          expect(store.openReviewRequests()).toEqual([]);
          expect(store.serviceCursor("review-retry-scan")).toBe(50);
          const file = join(evidenceRoot, "review-recovery.db");
          store.raw().prepare("VACUUM INTO ?").run(file);
          store.close(); store = openStore(file); // A fresh one-shot worker.
          store.reconcileAutomaticReviewRetries(T0);
          expect(store.openReviewRequests()).toMatchObject([{ run: builtRun, basis: "mode" }]);
          store.reconcileAutomaticReviewRetries(T0);
          expect(store.openReviewRequests()).toHaveLength(1);
        });
      });

      describe("explicit only (c9): automatic producers are one-shot", () => {
        const spec = { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null };
        const reviewerRows = () => store.raw().prepare("SELECT COUNT(*) AS n FROM run WHERE role = 'reviewer'").get() as { n: number };
        const railSpent = () => store.raw().prepare("SELECT COALESCE(SUM(reserved_starts), 0) AS n FROM mode_rail").get() as { n: number };
        const signStandard = () => {
          const terms = presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString());
          store.signMode({ repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, T0);
          return terms;
        };
        /** A Strict / release task whose approved scope queues the isolated
         * reviewer from the build disposition — the second automatic road. */
        const strictBuild = (): { run: number; approvedBy: string } => {
          store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
          store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
          store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
          store.createTask({ id: "t-strict", title: "release the payout guard" }, T0);
          const strictRef = store.refFor("built-in", "t-strict");
          store.placeTask(strictRef.id, REPO);
          const scope = propose(store, {
            taskId: "t-strict", goal: "release the guarded payout path", qualityMode: "strict",
            acceptance: [{ id: "c1", statement: "the payout path is guarded", how: null, evidence: ["changed-path"] }], now: T0,
          });
          expect(approve(store, "t-strict", "alex", T0, scope.digest, approverToken).ok).toBe(true);
          const run = store.startRun({ taskRef: strictRef.id, leaseId: "lease-strict", runner: "builder-1", branch: "standing-orders/t-strict", worktree: "/pool/t-strict", now: T0, ...presented(store, strictRef.id, "builder") });
          store.stampRun(run, { scopeDigest: scope.digest });
          storeEvidence(store, evidenceRoot, run, "terminal-diff", "terminal-diff.patch", Buffer.from(PATCH), "git diff (exit 0)", T0, { captureStatus: "ok" });
          store.saveProofVerdict(run, "short", ["needs review"], T0, [{ id: "c1", statement: "the payout path is guarded", requiredEvidence: ["changed-path"], state: "manual-review", detail: [], answered: [], review: null }]);
          store.recordOutcomeFacts(run, { headRevision: "head-strict", handoff: "guarded" });
          store.finishRun(run, { outcome: "built", committed: true, now: T0 });
          return { run, approvedBy: "alex" };
        };

        for (const road of ["mode", "strict"] as const) test(`replaying the ${road} producer after a failed root queues nothing and admits nothing; a fresh operator ask retries to success`, async () => {
          const source = road === "mode" ? (signStandard(), builtRun) : strictBuild().run;
          const strictSpec = road === "mode" ? spec : { ...spec, model: "sonnet" };
          // Seed the historical request explicitly; the retired producer itself does nothing.
          const oldMode = store.activeMode(REPO, T0);
          expect(store.requestReview(source, "alex", T0, road === "mode" ? { kind: "mode", digest: oldMode!.digest } : undefined, "automatic").ok).toBe(true);
          const first = store.openReviewRequests();
          expect(first).toMatchObject([{ run: source, origin: "automatic", basis: road === "mode" ? "mode" : "human" }]);
          // Replaying it while the ask is still queued adds nothing.
          maybeRequestAutoReview(store, REPO, source, true, false, T0);
          expect(store.openReviewRequests()).toHaveLength(1);
          const admitted = store.admitReview(first[0]!.id, strictSpec, T0);
          expect(admitted).toMatchObject({ ok: true, attempt: 1 });
          if (!admitted.ok) return;
          // Replaying it over the live root adds nothing.
          maybeRequestAutoReview(store, REPO, source, true, false, T0);
          expect(store.openReviewRequests()).toHaveLength(0);
          store.finishRun(admitted.reviewerRunId, { outcome: "failed", reason: "reviewer-agent", now: T0 });
          store.stampReviewRequestOutcome(first[0]!.id, "reviewer-agent");
          expect(store.reviewRetryStateOf(source)).toMatchObject({ state: "retryable", retriesRemaining: 2 });

          // THE REPLAY after the failure (the dogfood finding): the producer
          // can neither queue nor admit attempt 2 — no request, no run, no
          // rail spend. The direct door says why, in words.
          const rows = reviewerRows().n;
          const rail = railSpent().n;
          maybeRequestAutoReview(store, REPO, source, true, false, new Date(T0.getTime() + 1_000));
          maybeRequestAutoReview(store, REPO, source, true, false, new Date(T0.getTime() + 2_000));
          expect(store.openReviewRequests()).toEqual([]);
          expect(store.reviewRetryStateOf(source)).toMatchObject({ state: "retryable", openRequest: null, retriesRemaining: 2, nextAttempt: 2 });
          const direct = road === "mode"
            ? store.requestReview(source, "mode standard", T0, { kind: "mode", digest: modeDigestOf(presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString())) })
            : store.requestReview(source, "alex", T0, undefined, "automatic");
          expect(direct).toMatchObject({ ok: false, reason: "explicit-only" });
          expect((direct as { detail: string }).detail).toMatch(new RegExp(`review attempt 1 \\(reviewer run #${admitted.reviewerRunId}\\) ended reviewer-agent .*task review ${source}`));
          expect(reviewerRows().n).toBe(rows);
          expect(railSpent().n).toBe(rail);
          // History is untouched: one root, one spent request.
          expect(store.raw().prepare("SELECT id, origin, consumed_reason, reviewer_run FROM review_request WHERE run = ? ORDER BY id").all(source)).toEqual([
            { id: first[0]!.id, origin: "automatic", consumed_reason: "reviewer-agent", reviewer_run: admitted.reviewerRunId },
          ]);

          // A fresh operator act is the retry, and it runs to success.
          const retry = store.requestReview(source, "alex", new Date(T0.getTime() + 3_000));
          expect(retry).toMatchObject({ ok: true, attempt: 2 });
          expect(store.reviewRetryStateOf(source)).toMatchObject({ state: "queued", openRequest: { origin: "operator", requestedBy: "alex" }, nextAttempt: 2 });
          const admittedRetry = store.admitReview((retry as { id: number }).id, strictSpec, T0);
          if (!admittedRetry.ok) throw new Error(admittedRetry.reason);
          store.finishRun(admittedRetry.reviewerRunId, { outcome: "no-change", reason: "reviewed — retained history fixture", now: T0 });
          store.stampReviewRequestOutcome((retry as { id: number }).id, "reviewed");
          expect(store.reviewRetryStateOf(source)).toMatchObject({ state: "succeeded", retriesUsed: 1, retriesRemaining: 0 });
          expect(store.raw().prepare("SELECT origin, consumed_reason FROM review_request WHERE id = ?").get((retry as { id: number }).id)).toEqual({ origin: "operator", consumed_reason: "reviewed" });
          // And the producer stays silent over the landed review, too.
          maybeRequestAutoReview(store, REPO, source, true, false, new Date(T0.getTime() + 4_000));
          expect(store.openReviewRequests()).toEqual([]);
        });

        test("a stale queued automatic ask that would be a retry is spent 'explicit-only' at admission — before the rail, before any run — and the startRun insert refuses it on any road", () => {
          signStandard();
          const mode = store.activeMode(REPO, T0)!;
          // Attempt 1 through the real doors, failed.
          expect(store.requestReview(builtRun, "alex", T0, { kind: "mode", digest: store.activeMode(REPO, T0)!.digest }, "automatic").ok).toBe(true);
          const first = store.openReviewRequests()[0]!;
          const admitted = store.admitReview(first.id, spec, T0);
          if (!admitted.ok) throw new Error(admitted.reason);
          store.finishRun(admitted.reviewerRunId, { outcome: "failed", reason: "interrupted", now: T0 });
          store.stampReviewRequestOutcome(first.id, "interrupted");
          // The stale rows: a mode-basis ask and a human-basis-but-automatic
          // ask (the Strict producer's shape), written past the request
          // door — a row an older binary or a replayed disposition left.
          const staleMode = Number(store.raw().prepare("INSERT INTO review_request (run, requested_by, basis, mode_digest, requested_at, origin) VALUES (?, 'mode standard', 'mode', ?, ?, 'automatic')").run(builtRun, mode.digest, T0.toISOString()).lastInsertRowid);
          expect(store.reviewRetryStateOf(builtRun)).toMatchObject({ state: "queued", openRequest: { id: staleMode, origin: "automatic" } });
          const rail = railSpent().n;
          const rows = reviewerRows().n;
          const refused = store.admitReview(staleMode, spec, T0);
          expect(refused).toMatchObject({ ok: false, reason: "explicit-only" });
          expect(store.raw().prepare("SELECT consumed_reason, reviewer_run FROM review_request WHERE id = ?").get(staleMode)).toEqual({ consumed_reason: "explicit-only", reviewer_run: null });
          expect(railSpent().n).toBe(rail);
          expect(reviewerRows().n).toBe(rows);
          const staleStrict = Number(store.raw().prepare("INSERT INTO review_request (run, requested_by, basis, requested_at, origin) VALUES (?, 'alex', 'human', ?, 'automatic')").run(builtRun, T0.toISOString()).lastInsertRowid);
          // The insert itself refuses, whatever road presents the row.
          expect(() =>
            store.startRun({ taskRef, leaseId: "review:stale", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0, ...presented(store, taskRef, "reviewer"), request: staleStrict }),
          ).toThrow(/an automatic review ask is one-shot/);
          expect(store.admitReview(staleStrict, spec, T0)).toMatchObject({ ok: false, reason: "explicit-only" });
          expect(reviewerRows().n).toBe(rows);
          expect(store.openReviewRequests()).toEqual([]);
          // The first root's history is exactly as it was; a person retries.
          expect(store.getRun(admitted.reviewerRunId)).toMatchObject({ outcome: "failed", reason: "interrupted", reviewAttempt: 1 });
          expect(store.reviewRetryStateOf(builtRun)).toMatchObject({ state: "retryable", retriesRemaining: 2, nextAttempt: 2 });
          const human = store.requestReview(builtRun, "alex", new Date(T0.getTime() + 1_000));
          expect(human).toMatchObject({ ok: true, attempt: 2 });
          expect(store.admitReview((human as { id: number }).id, spec, T0)).toMatchObject({ ok: true, attempt: 2 });
        });

        test("an automatic ask before any attempt still runs; a first automatic ask after a spent-unrun ask is a replay too", async () => {
          signStandard();
          expect(store.requestReview(builtRun, "alex", T0, { kind: "mode", digest: store.activeMode(REPO, T0)!.digest }, "automatic").ok).toBe(true);
          const open = store.openReviewRequests();
          expect(open).toMatchObject([{ run: builtRun, origin: "automatic" }]);
          // A railed admission leaves the automatic ask OPEN — the same
          // request is not its own replay when the next pass admits it.
          const admitted = store.admitReview(open[0]!.id, spec, T0);
          expect(admitted).toMatchObject({ ok: true, attempt: 1 });
          // A second source: the producer's ask spent unrun, then replayed.
          const other = seedBuilt().runId;
          expect(store.requestReview(other, "alex", T0, { kind: "mode", digest: store.activeMode(REPO, T0)!.digest }, "automatic").ok).toBe(true);
          const spent = store.openReviewRequests().find(one => one.run === other)!;
          store.consumeReviewRequest(spent.id, "route-changed", T0);
          maybeRequestAutoReview(store, REPO, other, true, false, new Date(T0.getTime() + 1_000));
          expect(store.openReviewRequests().filter(one => one.run === other)).toEqual([]);
          expect(store.requestReview(other, "mode standard", T0, { kind: "mode", digest: store.activeMode(REPO, T0)!.digest })).toMatchObject({ ok: false, reason: "explicit-only", detail: expect.stringMatching(/already had its review ask \(request #\d+, spent as route-changed\)/) });
          expect(store.requestReview(other, "alex", T0)).toMatchObject({ ok: true, attempt: 1 });
        });
      });
    });

    test("admission is one winner: a second admit finds the request gone, and a crash leaves a spent request + open run", async () => {
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("ask");
      const first = store.admitReview(asked.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null }, T0);
      if (!first.ok) throw new Error("admit");
      expect(store.admitReview(asked.id, { runner: "builder-2", token: "tok-builder-2", provider: "claude", model: null }, T0)).toEqual({ ok: false, reason: "gone" });
      // The crash shape: request spent 'dispatched', run open with outcome
      // NULL — a visible cut-down attempt, not a stuck queue.
      const request = store.raw().prepare("SELECT consumed_reason FROM review_request WHERE id = ?").get(asked.id);
      expect(request).toMatchObject({ consumed_reason: "dispatched" });
      expect(store.getRun(first.reviewerRunId)?.outcome).toBeNull();
      expect(store.openReviewRequests()).toHaveLength(0);
    });

    test("a rotated credential cannot admit: the stale token refuses in-txn and the request stays OPEN for the fresh one (review finding 4)", () => {
      const asked = store.requestReview(builtRun, "alex", T0);
      if (!asked.ok) throw new Error("ask");
      // The takeover: the same name re-registers, rotating the credential.
      // Reviewer runs hold no task claim, so this txn-time identity proof is
      // the ONLY thing standing between a stale process and an admission.
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-rotated" });

      const stale = store.admitReview(asked.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null }, T0);
      expect(stale).toMatchObject({ ok: false, reason: "unauthenticated", detail: "bad-token" });

      // Nothing was spent: the request is unconsumed, no reviewer run exists.
      expect(store.raw().prepare("SELECT consumed_at FROM review_request WHERE id = ?").get(asked.id)).toMatchObject({ consumed_at: null });
      expect(store.openReviewRequests()).toHaveLength(1);
      expect(store.raw().prepare("SELECT COUNT(*) AS n FROM run WHERE role = 'reviewer'").get()?.["n"]).toBe(0);

      // The fresh credential admits the SAME request — the refusal cost nothing.
      const fresh = store.admitReview(asked.id, { runner: "builder-1", token: "tok-rotated", provider: "claude", model: null }, T0);
      expect(fresh).toMatchObject({ ok: true, sourceRun: builtRun });
    });

    test("the daily run rail refuses admission atomically and leaves the request OPEN", async () => {
      const terms = { ...presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString()), dailyRunCap: 1 };
      store.signMode(
        { repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
        T0,
      );
      const second = seedBuilt();
      const askedA = store.requestReview(builtRun, "alex", T0);
      const askedB = store.requestReview(second.runId, "alex", T0);
      if (!askedA.ok || !askedB.ok) throw new Error("asks");
      const admitA = store.admitReview(askedA.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null }, T0);
      expect(admitA.ok).toBe(true);
      const admitB = store.admitReview(askedB.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: null }, T0);
      expect(admitB).toMatchObject({ ok: false, reason: "railed", rail: "daily-runs" });
      // Open for a later pass — the rail spends no request.
      expect(store.openReviewRequests()).toHaveLength(1);
    });
  });

  describe("v40: evidence-review-v1 end to end", () => {

    const CRITERION = { id: "c1", statement: "The payout guard is wired in.", how: null, evidence: ["manual-review"] as const };
    // v47: a routed scope reviews only under a STANDING approval — the
    // rubric fixture files exact agents and approves, as a real task would.
    const seedRubric = (provider: "claude" | "codex" = "claude", model = "sonnet") => {
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
      store.setPhaseConfig("installation", "review", provider, model, "alex", T0);
      const scope = propose(store, { taskId: "t-1", goal: "wire the payout guard", acceptance: [CRITERION], now: T0 });
      const sealed = approve(store, "t-1", "alex", T0, scope.digest, approverToken);
      if (!sealed.ok) throw new Error(`seedRubric: ${sealed.reason}`);
      store.stampRun(builtRun, { scopeDigest: sealed.scope.digest });
    };
    const seedProofArtifact = (runId: number) => {
      const proof = {
        version: 1,
        criteria: [{ id: "c1", statement: CRITERION.statement, verdict: "met", how: "eyeballed the diff", evidence: [{ kind: "manual-review", ref: "looked at it" }] }],
      };
      storeEvidence(store, evidenceRoot, runId, "proof", "proof.json", Buffer.from(JSON.stringify(proof), "utf8"), "agent-authored", T0);
    };
    const CHECK_LOG_TEXT = "$ npm test\n(exit 0)\n\n--- stdout ---\n214 tests passed.\n\n--- stderr ---\n";
    const seedCheckLog = (runId: number): number =>
      storeEvidence(store, evidenceRoot, runId, "check-log", "check-log.txt", Buffer.from(CHECK_LOG_TEXT, "utf8"), 'sh -c "npm test" (exit 0)', T0);
    // A real, tiny (1x1) PNG — the same fixture proof.ts's own screenshot
    // tests use: a valid signature and header, never a placeholder.
    const ONE_BY_ONE_PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const seedScreenshot = (runId: number): number =>
      storeEvidence(store, evidenceRoot, runId, "screenshot", "screenshot-abc.png", ONE_BY_ONE_PNG, "agent-claimed screenshot at docs/before.png (validated png)", T0);

    const seedVerdict = (runId: number, verdict: "short" | "attested" = "short") => {
      const row: CriterionMatrixRow = {
        id: "c1",
        statement: CRITERION.statement,
        requiredEvidence: ["manual-review"],
        state: "manual-review",
        detail: ['criterion "c1" requires manual-review evidence — an operator must accept it before this can verify'],
        answered: [{ kind: "manual-review", ref: "looked at it" }],
        review: null,
      };
      store.saveProofVerdict(runId, verdict, ["needs a human look"], T0, [row]);
    };

    describe("audit hardening: check log, screenshots, and hash-bound bindings", () => {

      test("the durable seam refuses omitted proof, check-log, or screenshot inputs and accepts only the exact inventory", () => {
        seedRubric();
        seedProofArtifact(builtRun);
        const checkLogId = seedCheckLog(builtRun);
        const screenshotId = seedScreenshot(builtRun);
        seedVerdict(builtRun);
        const reviewerRun = store.startRun({
          taskRef,
          leaseId: "review:exact-inventory",
          runner: "builder-1",
          role: "reviewer",
          parentRun: builtRun,
          provider: "claude",
          now: T0,
          ...presented(store, taskRef, "reviewer"),
          ...askReview(builtRun),
        });
        store.stampProviderStart(reviewerRun, T0);

        const artifacts = store.artifactsFor(builtRun);
        const diff = artifacts.find(one => one.id === diffArtifact);
        const proof = artifacts.find(one => one.kind === "proof");
        const checkLog = artifacts.find(one => one.id === checkLogId);
        const screenshot = artifacts.find(one => one.id === screenshotId);
        const scope = store.getScope("t-1");
        if (diff === undefined || proof === undefined || checkLog === undefined || screenshot === undefined || scope === null) {
          throw new Error("incomplete exact-inventory fixture");
        }
        const base = {
          reviewerRunId: reviewerRun,
          runId: builtRun,
          artifactId: diffArtifact,
          author: "reviewer:claude",
          comments: [{ path: "src/payouts.ts", line: 2, note: "the whole review is atomic", severity: "problem" as const }],
          judgements: [{ id: "c1", judgement: "upholds" as const, note: "the complete sealed evidence supports it" }],
        };
        const bindingBase = {
          diffSha: diff.sha256,
          scopeDigest: scope.digest,
          headSha: "head-aaa",
        };

        expect(() =>
          store.ingestReview(
            { ...base, bindings: { ...bindingBase, proof: null, checkLog: null, screenshots: [] } },
            T0,
          ),
        ).toThrow(/proof inventory/);
        expect(() =>
          store.ingestReview(
            {
              ...base,
              bindings: {
                ...bindingBase,
                proof: { artifactId: proof.id, sha256: proof.sha256 },
                checkLog: null,
                screenshots: [],
              },
            },
            T0,
          ),
        ).toThrow(/check-log inventory/);
        expect(() =>
          store.ingestReview(
            {
              ...base,
              bindings: {
                ...bindingBase,
                proof: { artifactId: proof.id, sha256: proof.sha256 },
                checkLog: { artifactId: checkLog.id, sha256: checkLog.sha256 },
                screenshots: [],
              },
            },
            T0,
          ),
        ).toThrow(/screenshot inventory/);
        expect(store.liveDiffComments(builtRun)).toHaveLength(0);
        expect(store.criterionReviewsFor(builtRun)).toEqual([]);
        expect(store.getRun(reviewerRun)?.outcome).toBeNull();

        expect(
          store.ingestReview(
            {
              ...base,
              bindings: {
                ...bindingBase,
                proof: { artifactId: proof.id, sha256: proof.sha256 },
                checkLog: { artifactId: checkLog.id, sha256: checkLog.sha256 },
                screenshots: [{ artifactId: screenshot.id, sha256: screenshot.sha256, path: screenshot.capture }],
              },
            },
            T0,
          ).commentIds,
        ).toHaveLength(1);
        expect(store.criterionReviewsFor(builtRun)).toHaveLength(1);
        expect(store.getRun(reviewerRun)?.outcome).toBe("no-change");
      });
    });
  });

  test("retired automatic review ignores old signed reviewAuto modes and preserves results", () => {
    // No mode: nothing queued.
    maybeRequestAutoReview(store, REPO, builtRun, true, false, T0);
    expect(store.openReviewRequests()).toHaveLength(0);

    const terms = { ...presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString()), reviewAuto: true };
    store.signMode(
      { repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
    // No-change and uncommitted outcomes stay quiet.
    maybeRequestAutoReview(store, REPO, builtRun, true, true, T0);
    maybeRequestAutoReview(store, REPO, builtRun, false, false, T0);
    expect(store.openReviewRequests()).toHaveLength(0);

    maybeRequestAutoReview(store, REPO, builtRun, true, false, T0);
    const open = store.openReviewRequests();
    expect(open).toHaveLength(0);
    expect(store.runsFor(taskRef).filter(run => run.role === "reviewer")).toHaveLength(0);

    // Neither old signed terms nor new presets schedule another agent.
    const handsOff = presetTerms("hands-off", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString());
    handsOff.reviewAuto = false;
    store.signMode(
      { repo: REPO, name: "hands-off", termsJson: modeTermsJson(handsOff), digest: modeDigestOf(handsOff), signedBy: "alex", absoluteExpiry: handsOff.absoluteExpiry, publication: handsOff.publication },
      T0,
    );
    maybeRequestAutoReview(store, REPO, builtRun, true, false, T0);
    expect(store.openReviewRequests()).toHaveLength(0);
  });

  test.each(["missing", "failed", "settings-changed", "passed"] as const)("retired automatic review stays idle for every project check result: %s", state => {
    const terms = presetTerms("hands-off", new Date(T0.getTime() + 86_400_000).toISOString());
    store.signMode({ repo: REPO, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, T0);
    store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 600_000, approvedBy: "alex" }, new Date(T0.getTime() + (state === "settings-changed" ? 1000 : -1000)));
    if (state !== "missing") store.saveProofVerdict(builtRun, state === "failed" ? "refuted" : "verified", [], T0, []);
    maybeRequestAutoReview(store, REPO, builtRun, true, false, new Date(T0.getTime() + 2000));
    expect(store.openReviewRequests()).toHaveLength(0);
    expect(store.runsFor(taskRef).filter(run => run.role === "reviewer")).toHaveLength(0);
    // Historical request rows remain readable; the worker retires them without a model call.
    if (state === "failed") expect(store.requestReview(builtRun, "alex", T0).ok).toBe(true);
  });

  test("Strict and Default both finish without queuing an isolated reviewer", () => {
    maybeRequestAutoReview(store, REPO, builtRun, true, false, T0);
    expect(store.openReviewRequests()).toHaveLength(0);

    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    store.createTask({ id: "t-strict", title: "release the payout guard" }, T0);
    const strictRef = store.refFor("built-in", "t-strict");
    store.placeTask(strictRef.id, REPO);
    const scope = propose(store, {
      taskId: "t-strict",
      goal: "release the guarded payout path",
      qualityMode: "strict",
      acceptance: [{ id: "c1", statement: "the payout path is guarded", how: null, evidence: ["changed-path"] }],
      now: T0,
    });
    const approved = approve(store, "t-strict", "alex", T0, scope.digest, approverToken);
    expect(approved.ok).toBe(true);

    const strictRun = store.startRun({
      taskRef: strictRef.id,
      leaseId: "lease-strict",
      runner: "builder-1",
      branch: "standing-orders/t-strict",
      worktree: "/pool/t-strict",
      now: T0,
      ...presented(store, strictRef.id, "builder"),
    });
    expect(store.getRun(strictRun)?.qualityMode).toBe("strict");
    store.stampRun(strictRun, { scopeDigest: scope.digest });
    storeEvidence(store, evidenceRoot, strictRun, "terminal-diff", "terminal-diff.patch", Buffer.from(PATCH), "git diff (exit 0)", T0, { captureStatus: "ok" });
    store.finishRun(strictRun, { outcome: "built", committed: true, now: T0 });

    maybeRequestAutoReview(store, REPO, strictRun, true, false, T0);
    expect(store.openReviewRequests()).toHaveLength(0);
    expect(store.getRun(strictRun)?.qualityMode).toBe("strict");
  });

  test("the pre-typed upgrade fails closed: open requests from before basis existed are spent as legacy-untyped", () => {
    // Simulate the bc8b3bd shape exactly: the table without its typed
    // authority columns, holding one open mode-queued request in the old
    // display-string format and one already-spent row.
    const file = join(evidenceRoot, "legacy.db");
    {
      const old = openStore(file);
      const t = old.refFor("built-in", "t-1");
      void t; // the store exists; we only need the file's schema
      old.close();
    }
    {
      const legacy = openStore(file);
      legacy.createTask({ id: "t-legacy", title: "old work" }, T0);
      const ref = legacy.refFor("built-in", "t-legacy").id;
      legacy.placeTask(ref, REPO);
      const run = legacy.startRun({ taskRef: ref, leaseId: "l-old", runner: "b-1", branch: "b", worktree: "/w", now: T0, ...presented(legacy, ref, "builder") });
      legacy.finishRun(run, { outcome: "built", committed: true, now: T0 });
      legacy.raw().prepare("INSERT INTO review_request (run, requested_by, requested_at) VALUES (?, 'mode:deadbeef', ?)").run(run, T0.toISOString());
      legacy.raw().prepare("INSERT INTO review_request (run, requested_by, requested_at, consumed_at, consumed_reason) VALUES (?, 'alex', ?, ?, 'reviewed')").run(run, T0.toISOString(), T0.toISOString());
      legacy.raw().exec("ALTER TABLE review_request DROP COLUMN mode_digest");
      legacy.raw().exec("ALTER TABLE review_request DROP COLUMN basis");
      legacy.raw().exec("UPDATE schema_version SET version = 113"); // an older build's file reads older (v114)
      legacy.close();
    }
    const upgraded = openStore(file);
    // The open pre-typed request was spent, not granted human authority.
    expect(upgraded.openReviewRequests()).toHaveLength(0);
    const rows = upgraded
      .raw()
      .prepare("SELECT requested_by, basis, consumed_reason FROM review_request ORDER BY id")
      .all() as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ requested_by: "mode:deadbeef", basis: "human", consumed_reason: "legacy-untyped" });
    // Already-spent history keeps its own words.
    expect(rows[1]).toMatchObject({ consumed_reason: "reviewed" });
    // A reopen does not re-sweep: fresh typed requests survive restarts.
    const run2 = upgraded.startRun({ taskRef: upgraded.refFor("built-in", "t-legacy").id, leaseId: "l-new", runner: "b-1", branch: "b2", worktree: "/w2", now: T0, ...presented(upgraded, upgraded.refFor("built-in", "t-legacy").id, "builder") });
    storeEvidence(upgraded, evidenceRoot, run2, "terminal-diff", "terminal-diff.patch", Buffer.from(PATCH, "utf8"), "git diff (exit 0)", T0, { captureStatus: "ok" });
    upgraded.finishRun(run2, { outcome: "built", committed: true, now: T0 });
    expect(upgraded.requestReview(run2, "alex", T0).ok).toBe(true);
    upgraded.close();
    const reopened = openStore(file);
    expect(reopened.openReviewRequests()).toHaveLength(1);
    reopened.close();
  });

  test("workspace consumers see a reviewer run's missing worktree as null, never \"null\"", () => {
    const reviewer = store.startRun({ taskRef, leaseId: "review:1", runner: "builder-1", role: "reviewer", parentRun: builtRun, now: T0, ...presented(store, taskRef, "reviewer"), ...askReview(builtRun) });
    const row = store.getRun(reviewer);
    if (row === null) throw new Error("row");
    // The typed fact every guard keys on (D5): consumers switch on null,
    // and the string "null" — the classic String(null) bug — never forms.
    expect(row.worktree).toBeNull();
    expect(row.branch).toBeNull();
    for (const run of store.runsFor(taskRef)) {
      expect(run.worktree === null || typeof run.worktree === "string").toBe(true);
      expect(run.worktree).not.toBe("null");
      expect(run.branch).not.toBe("null");
    }
  });
});
