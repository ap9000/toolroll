import { runOperate, EXIT, OPERATE_HELP, OPERATE_BOOLEAN_FLAGS, OPERATE_VALUE_FLAGS, TASK_ACTIONS } from "./operate.js";
import { executeMateTool, MATE_TOOLS } from "./mate-tools.js";
import { applyChatTaskAction, CHAT_TASK_ACTIONS } from "./chat-task-actions.js";
import { CHAT_CONTROLS } from "./chat-controls.js";
import { createDecisionServer } from "./serve.js";
import { verificationEvidence, sealVerificationReceipt } from "./verification-evidence.js";
import { verifyApproverByPassword } from "./principal.js";
/**
 * Inherited review context (v51, contract handoff task 3), end to end
 * against a REAL git repository and a fresh store: a small revision to a
 * larger feature seals bounded source context for the criteria the
 * earlier build implemented, every item bound to source run, commit,
 * path, and digest; changed criteria, changed code, stale ancestry,
 * tampered ancestors, byte limits, binaries, and secrets all read as
 * named gaps or invalid support; historical judgements on inherited criteria must cite
 * supplied provenance. Nothing here reads a working tree as evidence.
 */

import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { run as exec } from "./exec.js";
import { budgetedStatJson, captureTerminalDiff, parseNumstat, readVerifiedArtifact, redactSecretLines, scanForSecrets, storeEvidence, writeEvidenceFile } from "./evidence.js";
import { addApprover, approve, propose } from "./scope.js";
import { register } from "./runner.js";
import { adjudicate, changedListProblems, coverageWords, foldReview, matrixWords, semanticCoverage, type CriterionMatrixRow } from "./proof.js";
import { captureReviewContext, citesSuppliedProvenance, parseReviewContext, REVIEW_CONTEXT_LIMITS, LEGACY_REVIEW_CONTEXT_LIMITS, reviewContextRules, reviewContextCustodyProblem, serializeReviewContext, type ReviewContextInventory } from "./review-context.js";
import { parseReview } from "./reviewer.js";
import { evidenceRange, evidenceRequest, isEvidenceOnlyReply } from "./review-evidence.js";
import { sealedDiffStatFacts } from "./builder.js";

const T0 = new Date("2026-09-11T12:00:00.000Z");
const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-09-11T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-09-11T12:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 }).trim();
const commitFiles = (cwd: string, files: Record<string, string | Buffer>, message: string): string => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};

/** The exact route authority a fixture PRESENTS at admission (v48). */
const presented = (
  s: Pick<Store, "routeAuthorityFor">,
  taskRef: number,
  role: "builder" | "reviewer" = "builder",
  spend: { provider: string; model: string | null } = { provider: "claude", model: "sonnet" },
): { route: import("./phase-routing.js").RouteStamp } | Record<string, never> => {
  const authority = s.routeAuthorityFor(taskRef, role) ?? s.routeAuthorityFor(taskRef, role, spend);
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

const LIMIT_TS = "export function limiter(): number {\n  return 3;\n}\n";
const GUARD_TS = "export function guard(n: number): boolean {\n  return n < 3;\n}\n";
const REPORT_TS = "export function report(): string {\n  return 'ok';\n}\n";
const REPORT_TS_V2 = "export function report(): string {\n  return 'ok, revised';\n}\n";

const RUBRIC = [
  { id: "c1", statement: "The limiter caps retries at three.", how: null, evidence: ["check"] as const },
  { id: "c2", statement: "The guard refuses a fourth attempt.", how: null, evidence: ["check"] as const },
  { id: "c3", statement: "The report names the outcome.", how: null, evidence: ["changed-path"] as const },
  { id: "c4", statement: "The whole gate passes.", how: null, evidence: ["check"] as const },
];

type Fixture = {
  repo: string;
  store: Store;
  evidenceRoot: string;
  approverToken: string;
  sourceTaskRef: number;
  sourceRun: number;
  sourceDiffArtifact: number;
  sourceProofArtifact: number;
  revisionTaskId: string;
  revisionTaskRef: number;
  revisionRun: number;
  shas: { base: string; source: string; revision: string };
};

describe("inherited review context (v51)", () => {
  let dirs: string[] = [];
  let stores: Store[] = [];
  const temp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const store of stores) store.close();
    stores = [];
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  /**
   * One feature built in the source run (commit `source` over `base`),
   * reviewed on the source by an earlier reviewer, then a small revision
   * that changes only src/report.ts (commit `revision`). Extra files and a
   * changed rubric for the revision are options so each test names its
   * own deviation from this baseline.
   */
  const seed = async (options: {
    provider?: "claude" | "codex";
    extraSourceFiles?: Record<string, string | Buffer>;
    baseFiles?: Record<string, string | Buffer>;
    sourcePatch?: (patch: string) => string;
    shortenedLog?: boolean;
    machineGate?: boolean;
    databaseFile?: string;
    rootOnly?: boolean;
    omitProof?: boolean;
    noChange?: boolean;
    touches?: string[];
    handoff?: string;
    guardSource?: string;
    revisionFiles?: Record<string, string>;
    intermediateFiles?: Record<string, string>;
    revisionRubric?: typeof RUBRIC;
    revisionBaseSha?: "base";
    priorJudgements?: { id: string; judgement: "upholds" | "contradicts" | "cannot-tell"; note: string }[];
    strict?: boolean;
  } = {}): Promise<Fixture> => {
    // realpath: runner repo membership is compared against the placed
    // path, and macOS's tmpdir is a symlink into /private.
    const repo = realpathSync(temp("so-ctx-repo-"));
    git(repo, "init", "-q", "-b", "main");
    const base = commitFiles(repo, { "README.md": "# fixture\n", ...options.baseFiles }, "base");
    const source = options.noChange ? base : commitFiles(
      repo,
      { "src/limit.ts": LIMIT_TS, "src/guard.ts": options.guardSource ?? GUARD_TS, "src/report.ts": REPORT_TS, ...(options.extraSourceFiles ?? {}) },
      "feature",
    );
    if (options.revisionBaseSha === "base") git(repo, "checkout", "-q", base);
    const intermediate = options.intermediateFiles ? commitFiles(repo, options.intermediateFiles, "uncovered change") : null;
    const revision = commitFiles(repo, options.revisionFiles ?? { "src/report.ts": REPORT_TS_V2 }, "revision");

    const store = openStore(options.databaseFile ?? ":memory:");
    stores.push(store);
    const evidenceRoot = temp("so-ctx-evidence-");
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    const provider = options.provider ?? "claude";
    const model = provider === "claude" ? "sonnet" : "gpt-5.6-sol";
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "repair", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "review", provider, model, "alex", T0);
    register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => "tok-builder-1" });

    // The source task: signed rubric, approved, built at `source`.
    store.createTask({ id: "feat", title: "retry limiter" }, T0);
    const sourceTaskRef = store.refFor("built-in", "feat").id;
    store.placeTask(sourceTaskRef, repo);
    const sourceScope = propose(store, { taskId: "feat", goal: "cap retries", touches: options.touches ?? [], acceptance: RUBRIC, now: T0, ...(options.strict === true ? { qualityMode: "strict" as const } : {}) });
    const sourceSealed = approve(store, "feat", "alex", T0, sourceScope.digest, alex.token);
    if (!sourceSealed.ok) throw new Error(`approve feat: ${sourceSealed.reason}`);
    const sourceRun = store.startRun({ taskRef: sourceTaskRef, leaseId: "lease-src", runner: "builder-1", branch: "standing-orders/feat", worktree: repo, provider: "claude", model: "sonnet", now: T0, ...presented(store, sourceTaskRef) });
    store.stampRun(sourceRun, { scopeDigest: sourceSealed.scope.digest, baseRevision: base });
    const rawSourcePatch = git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", base, source) + "\n";
    const sourcePatch = options.sourcePatch?.(rawSourcePatch) ?? rawSourcePatch;
    const sourceHits = scanForSecrets(sourcePatch);
    const sourceDiffArtifact = storeEvidence(store, evidenceRoot, sourceRun, "terminal-diff", "terminal-diff.patch", Buffer.from(redactSecretLines(sourcePatch, sourceHits), "utf8"), `git diff ${base} ${source} (exit 0)`, T0, { captureStatus: "ok", redacted: sourceHits.length > 0 });
    const numstat = execFileSync("git", ["diff", "--numstat", "-z", base, source], { cwd: repo, encoding: "utf8", env: GIT_ENV });
    storeEvidence(store, evidenceRoot, sourceRun, "diff-stat", "terminal-diff-stat.json", budgetedStatJson(parseNumstat(numstat, base, source)), `git diff --numstat -z ${base} ${source} (exit 0)`, T0, { captureStatus: "ok" });
    const sourceChanged = git(repo, "diff", "--name-only", base, source).split("\n").filter(one => one !== "");
    const sourceProof = {
      version: 1,
      criteria: [
        { id: "c1", statement: RUBRIC[0]!.statement, verdict: "met", how: "ran the gate", evidence: [{ kind: "check", ref: "npm test" }, { kind: "changed-path", ref: "src/limit.ts" }] },
        { id: "c2", statement: RUBRIC[1]!.statement, verdict: "met", how: "ran the gate", evidence: [{ kind: "check", ref: "npm test" }, { kind: "changed-path", ref: "src/guard.ts" }] },
        { id: "c3", statement: RUBRIC[2]!.statement, verdict: "met", how: "wrote it", evidence: [{ kind: "changed-path", ref: "src/report.ts" }] },
        { id: "c4", statement: RUBRIC[3]!.statement, verdict: "met", how: "ran the gate", evidence: [{ kind: "check", ref: "npm test" }] },
      ],
      checks: [{ command: "npm test", exitCode: 0, summary: "all green" }],
      changed: sourceChanged,
      caveats: [],
      screenshots: [],
    };
    const sourceProofArtifact = options.omitProof ? 0 : storeEvidence(store, evidenceRoot, sourceRun, "proof", "proof.json", Buffer.from(JSON.stringify(sourceProof), "utf8"), "agent-authored proof (validated, re-serialized)", T0);
    if (options.machineGate) store.setVerifyCommand({ repo, command: "npm test", timeoutMs: 60000, approvedBy: "alex" }, T0);
    const checkLog = options.machineGate ? store.getArtifact(storeEvidence(store, evidenceRoot, sourceRun, "check-log", "check-log.txt", Buffer.from("=== Attempt summary ===\n- Project check · attempt 1: (exit 0)\n\n=== Project check · attempt 1 ===\n$ npm test\n(exit 0)\n\n--- stdout ---\nall green\n… output shortened; ending follows …\n\n--- stderr ---\n".padEnd(14566, " ")), "sh -c npm test (attempt recorded)", T0, { captureStatus: "ok", sourceBytesOriginal: 100541 })) : options.shortenedLog ? store.getArtifact(storeEvidence(store, evidenceRoot, sourceRun, "check-log", "check-log.txt", Buffer.from("npm test: exit 0\n[output shortened]\nall green\n"), "bounded verification log", T0, { captureStatus: "ok", sourceBytesOriginal: 100000 })) : null;
    if (options.handoff !== undefined) storeEvidence(store, evidenceRoot, sourceRun, "handoff", "handoff.json", Buffer.from(JSON.stringify({ schema: 1, conclusion: options.handoff, followUps: ["Inspect the retry boundary before acceptance"] })), "captured handoff", T0, { captureStatus: "ok" });
    store.recordOutcomeFacts(sourceRun, { headRevision: source, handoff: "capped retries" });
    store.finishRun(sourceRun, { outcome: options.noChange ? "no-change" : "built", committed: !options.noChange, now: T0 });

    // An earlier reviewer's judgements on the SOURCE run, bound exactly as
    // ingestReview binds them (head, scope, diff, proof).
    const prior = options.priorJudgements ?? [
      { id: "c1", judgement: "upholds", note: "limiter returns 3" },
      { id: "c2", judgement: "upholds", note: "guard refuses n >= 3" },
    ];
    if (prior.length > 0) {
      const asked = store.requestReview(sourceRun, "alex", T0);
      if (!asked.ok) throw new Error(`requestReview: ${asked.reason}`);
      const priorReviewer = store.startRun({ taskRef: sourceTaskRef, leaseId: "review:prior", runner: "builder-1", role: "reviewer", parentRun: sourceRun, provider, model, now: T0, ...presented(store, sourceTaskRef, "reviewer", { provider, model }), request: asked.id });
      const diffRow = store.getArtifact(sourceDiffArtifact)!;
      const proofRow = store.getArtifact(sourceProofArtifact)!;
      for (const one of prior) {
        store.raw().prepare(
          `INSERT INTO criterion_review (reviewer_run, source_run, criterion_id, judgement, note, artifact, artifact_sha, author, created_at,
             scope_digest, head_sha, proof_artifact, proof_sha, check_log_artifact, check_log_sha, screenshots_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewer:claude·sonnet', ?, ?, ?, ?, ?, ?, ?, '[]')`,
        ).run(priorReviewer, sourceRun, one.id, one.judgement, one.note, diffRow.id, diffRow.sha256, T0.toISOString(), sourceSealed.scope.digest, source, proofRow.id, proofRow.sha256, checkLog?.id ?? null, checkLog?.sha256 ?? null);
      }
      store.finishRun(priorReviewer, { outcome: "no-change", reason: "reviewed — 0 comment(s), 2 judgement(s)", now: T0 });
    }

    if (options.rootOnly) return { repo, store, evidenceRoot, approverToken: alex.token, sourceTaskRef, sourceRun, sourceDiffArtifact, sourceProofArtifact, revisionTaskId: "feat", revisionTaskRef: sourceTaskRef, revisionRun: sourceRun, shas: { base, source, revision: source } };

    // The revision: sealed through the real road with the source scope's
    // rubric (or a deliberately changed one), then approved and built at
    // `revision`.
    const brief = { schema: 1, sourceTask: "feat", sourceRun, sourceScopeDigest: store.getScope("feat")!.digest, head: source, diffArtifactSha: store.getArtifact(sourceDiffArtifact)!.sha256, comments: [] };
    const briefBytes = Buffer.from(JSON.stringify(brief), "utf8");
    const key = writeEvidenceFile(evidenceRoot, sourceRun, "revision-brief-fixture.json", briefBytes);
    const sealed = store.sealRevision(
      {
        source: { task: "feat", run: sourceRun, scopeDigest: store.getScope("feat")!.digest },
        brief: { evidenceRoot, key, bytes: briefBytes.length, sha256: createHash("sha256").update(briefBytes).digest("hex"), capture: "machine-authored revision brief (exit 0)" },
        child: { id: "feat-rev", title: "Revise feat", repair: "apply the annotations" },
        commentIds: null,
      },
      T0,
    );
    if (!sealed.ok) throw new Error(`sealRevision: ${sealed.reason}`);
    const revisionTaskId = sealed.id;
    const revisionTaskRef = store.refFor("built-in", revisionTaskId).id;
    if (options.strict === true || options.revisionRubric !== undefined) {
      const drafted = store.getScope(revisionTaskId)!;
      propose(store, { taskId: revisionTaskId, goal: drafted.goal, acceptance: options.revisionRubric ?? drafted.acceptance, qualityMode: options.strict ? "strict" : "default", now: T0 });
    }
    const revisionScope = store.getScope(revisionTaskId)!;
    const revisionSealed = approve(store, revisionTaskId, "alex", T0, revisionScope.digest, alex.token);
    if (!revisionSealed.ok) throw new Error(`approve revision: ${revisionSealed.reason}`);
    const revisionRun = store.startRun({ taskRef: revisionTaskRef, leaseId: "lease-rev", runner: "builder-1", branch: `standing-orders/${revisionTaskId}`, worktree: repo, provider: "claude", model: "sonnet", now: T0, ...presented(store, revisionTaskRef) });
    const revisionBase = options.revisionBaseSha === "base" ? base : intermediate ?? source;
    store.stampRun(revisionRun, { scopeDigest: revisionSealed.scope.digest, baseRevision: revisionBase });
    const revisionPatch = git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-color", revisionBase, revision);
    const revisionHits = scanForSecrets(revisionPatch);
    storeEvidence(store, evidenceRoot, revisionRun, "terminal-diff", "terminal-diff.patch", Buffer.from(redactSecretLines(`${revisionPatch}\n`, revisionHits), "utf8"), `git diff ${revisionBase} ${revision} (exit 0)`, T0, { captureStatus: "ok", redacted: revisionHits.length > 0 });
    const revisionNumstat = execFileSync("git", ["diff", "--numstat", "-z", revisionBase, revision], { cwd: repo, encoding: "utf8", env: GIT_ENV });
    storeEvidence(store, evidenceRoot, revisionRun, "diff-stat", "terminal-diff-stat.json", budgetedStatJson(parseNumstat(revisionNumstat, revisionBase, revision)), `git diff --numstat -z ${revisionBase} ${revision} (exit 0)`, T0, { captureStatus: "ok" });
    store.recordOutcomeFacts(revisionRun, { headRevision: revision, handoff: "revised the report" });
    store.finishRun(revisionRun, { outcome: "built", committed: true, now: T0 });

    return { repo, store, evidenceRoot, approverToken: alex.token, sourceTaskRef, sourceRun, sourceDiffArtifact, sourceProofArtifact, revisionTaskId, revisionTaskRef, revisionRun, shas: { base, source, revision } };
  };

  const patchPathsOf = (repo: string, from: string, to: string): Set<string> => new Set(git(repo, "diff", "--name-only", from, to).split("\n").filter(one => one !== ""));

  const capture = (f: Fixture, rubric = RUBRIC) =>
    captureReviewContext(f.store, exec, {
      runId: f.revisionRun,
      taskRef: f.revisionTaskRef,
      head: f.shas.revision,
      base: f.store.getRun(f.revisionRun)!.baseRevision,
      rubric: rubric.map(one => ({ id: one.id, statement: one.statement, evidence: one.evidence })),
      patchPaths: patchPathsOf(f.repo, f.store.getRun(f.revisionRun)!.baseRevision!, f.shas.revision),
      worktree: f.repo,
      root: f.evidenceRoot,
      now: () => T0,
    });

  const firstReady = async () => {
    const databaseFile = join(temp("first-review-db-"), "test.db");
    const f = await seed({ databaseFile, rootOnly: true, machineGate: true, priorJudgements: [],
      baseFiles: { "src/guard.ts": "// retry context café 🔎\n".repeat(4000) + GUARD_TS.replace("n < 3", "n < 9"), "src/telegram.ts": "// retained source\n".repeat(5000) + "export const restart = false;\n", "src/telegram.test.ts": "// retained tests\n".repeat(5000) + "// old tests\n" },
      guardSource: "// retry context café 🔎\n".repeat(4000) + GUARD_TS,
      extraSourceFiles: { "src/telegram.ts": "// retained source\n".repeat(5000) + "export const restart = true;\n", "src/telegram.test.ts": "// retained tests\n".repeat(5000) + "// restart and rate-limit assertions at end\n", "src/unrelated-secret-fixture.test.ts": "// AKIAABCDEFGHIJKLMNOP\n" } });
    f.store.saveProofVerdict(f.sourceRun, "verified", ["the repository's approved verification command passed"], T0,
      RUBRIC.map(c => ({ id: c.id, statement: c.statement, requiredEvidence: [...c.evidence], state: "pass", detail: [], answered: [], review: null })), "verified");
    const login = verifyApproverByPassword(f.store, "alex", f.approverToken, [f.repo]);
    if (!login.ok) throw new Error("login");
    const ask = () => f.store.requestReview(f.sourceRun, "alex", T0);
    return { ...f, databaseFile, ask, who: login.who };
  };
  const firstVerdict = (judgement = "upholds") => ({ version: 1, comments: [], criteria: RUBRIC.map(c => ({ id: c.id, judgement: c.id === "c4" ? "cannot-tell" : judgement, note: c.id === "c4" ? "The unrelated fixture is redacted; its lines remain unavailable." : `src/${c.id === "c1" ? "limit" : c.id === "c2" ? "guard" : "report"}.ts supplies the criterion's complete source.` })) });

  test("a first no-change result reads the signed scope's committed source without a builder proof", async () => {
    const f = await seed({ rootOnly: true, omitProof: true, noChange: true, priorJudgements: [],
      baseFiles: { "src/limit.ts": LIMIT_TS }, touches: ["src/"], handoff: "The retry limit already exists" });
    const result = await captureReviewContext(f.store, exec, { runId: f.sourceRun, taskRef: f.sourceTaskRef, head: f.shas.source, base: f.shas.base,
      rubric: RUBRIC, patchPaths: new Set(), worktree: f.repo, root: f.evidenceRoot, now: () => T0 });
    expect(result!.inventory.source.verified).toBe(true);
    expect(result!.inventory.items.map(one => one.path)).toEqual(["src/limit.ts"]);
    expect(result!.inventory.coverage.every(one => one.state === "context")).toBe(true);
    expect(result!.inventory.handoff?.content).toContain("Inspect the retry boundary");
    expect(parseReviewContext(serializeReviewContext(result!.inventory))).toMatchObject({ ok: true });
    expect(reviewContextCustodyProblem(f.store, f.evidenceRoot, result!.inventory)).toBeNull();
    const handoff = f.store.artifactsFor(f.sourceRun).find(one => one.kind === "handoff")!;
    writeFileSync(join(f.evidenceRoot, handoff.key), "changed notes");
    expect(reviewContextCustodyProblem(f.store, f.evidenceRoot, result!.inventory)).toMatch(/builder notes no longer verify/);
  });

  test("first review: two connections still admit one reviewer and cannot request a second successful review", async () => {
    const f = await firstReady(); const other = openStore(f.databaseFile); stores.push(other);
    const asked = f.ask(); expect(asked.ok).toBe(true); if (!asked.ok) throw new Error(asked.reason);
    expect(other.requestReview(f.sourceRun, "alex", T0)).toMatchObject({ ok: false, reason: "already-requested" });
    const spec = { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: "sonnet" };
    expect(f.store.admitReview(asked.id, spec, T0).ok).toBe(true);
    expect(other.admitReview(asked.id, spec, T0)).toMatchObject({ ok: false, reason: "gone" });
  });

  test("retired refresh: after one successful first review, CLI, shared chat, result, task, cockpit and work pages expose no manual Refresh review action and the review stays final", async () => {
    // Deployed schema 60 on a reviewed run: exactly one root reviewer, no
    // open request. Every surface below is the real one (operate.ts, the
    // mate tools, the decision server), not a grep over source text.
    const f = await firstReady();
    const asked = f.ask(); if (!asked.ok) throw new Error(asked.reason);
    const admitted = f.store.admitReview(asked.id, { runner: "builder-1", token: "tok-builder-1", provider: "claude", model: "sonnet" }, T0);
    if (!admitted.ok) throw new Error(admitted.reason);
    const diff = f.store.getArtifact(f.sourceDiffArtifact)!;
    const proof = f.store.getArtifact(f.sourceProofArtifact)!;
    const log = f.store.artifactsFor(f.sourceRun).find(one => one.kind === "check-log")!;
    f.store.stampProviderStart(admitted.reviewerRunId, T0);
    f.store.ingestReview({ reviewerRunId: admitted.reviewerRunId, runId: f.sourceRun, artifactId: diff.id, author: "reviewer:claude·sonnet", comments: [],
      judgements: firstVerdict().criteria as { id: string; judgement: "upholds" | "cannot-tell"; note: string }[],
      bindings: { diffSha: diff.sha256, scopeDigest: f.store.getScope("feat")!.digest, headSha: f.shas.source,
        proof: { artifactId: proof.id, sha256: proof.sha256 }, checkLog: { artifactId: log.id, sha256: log.sha256 }, screenshots: [] } }, T0);
    const reviewers = () => f.store.runsFor(f.sourceTaskRef).filter(r => r.role === "reviewer");
    expect(reviewers()).toHaveLength(1);
    expect(f.store.openReviewRequests()).toEqual([]);
    const NO_REFRESH = /Refresh review|refresh review|refresh-review|refresh_review|data-refresh-state|evidence-refresh/i;

    // CLI: no refresh entry and no separate model-review door, including historical results.
    expect(TASK_ACTIONS.filter(one => /refresh/.test(one))).toEqual([]);
    expect([...OPERATE_VALUE_FLAGS, ...OPERATE_BOOLEAN_FLAGS].filter(one => /refresh/.test(one))).toEqual([]);
    expect(OPERATE_HELP).not.toMatch(NO_REFRESH);
    const cli = async (...args: string[]) => {
      const lines: string[] = [];
      const code = await runOperate("task", [...args, "--as", "alex", "--token", f.approverToken, "--json"], line => lines.push(line), { databaseFile: f.databaseFile, now: T0 });
      return { code, envelope: JSON.parse(lines.join("\n")) as { ok: boolean; reason?: string; error?: string; detail?: string } };
    };
    const flagged = await cli("review", String(f.sourceRun), "--refresh");
    expect(flagged.code).toBe(EXIT.usage); expect(JSON.stringify(flagged.envelope)).toContain("unknown option --refresh");
    const verb = await cli("refresh-review", String(f.sourceRun));
    expect(verb.code).toBe(EXIT.usage); expect(verb.envelope.ok).toBe(false);
    const again = await cli("review", String(f.sourceRun));
    expect(again.code).toBe(EXIT.refused); expect(again.envelope).toMatchObject({ ok: false, reason: "model-review-retired" });
    expect(JSON.stringify(again.envelope)).toContain("Manual review requests have been removed");

    // Chat: no refresh action, control or proposal; the confirmed-action path refuses an unknown operation.
    expect(Object.keys(CHAT_TASK_ACTIONS).filter(one => /refresh/.test(one))).toEqual([]);
    expect(Object.keys(CHAT_CONTROLS).filter(one => /refresh/.test(one))).toEqual([]);
    expect(JSON.stringify(MATE_TOOLS.map(one => ({ name: one.name, description: one.description, inputSchema: one.inputSchema })))).not.toMatch(NO_REFRESH);
    const ctx = { store: f.store, who: f.who, now: T0, evidenceRoot: f.evidenceRoot, draft: () => { throw new Error("No refresh card may be created"); } };
    expect(JSON.stringify(executeMateTool(ctx, "get_controls", {}))).not.toMatch(NO_REFRESH);
    expect(executeMateTool(ctx, "propose_task_action", { task: "feat", operation: "refresh_review", run: f.sourceRun }).ok).toBe(false);
    expect(executeMateTool(ctx, "show_control", { control: "refresh_review", task: "feat" }).ok).toBe(false);
    expect(applyChatTaskAction(f.store, f.who, { task: "feat", operation: "refresh_review", run: f.sourceRun, stamp: "x" }, T0, true)).toMatchObject({ ok: false });

    // Web: the result, task, chat result view, review cockpit and work pages carry no refresh control; no route serves one.
    f.store.setTaskState("feat", "done", T0);
    const server = createDecisionServer({ store: f.store, evidenceRoot: f.evidenceRoot, repo: f.repo, clock: () => T0 });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
      const login = await fetch(base + "/login", { method: "POST", redirect: "manual", body: new URLSearchParams({ name: "alex", token: f.approverToken }) });
      const cookie = login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
      const page = async (path: string) => { const response = await fetch(base + path, { headers: { cookie } }); return { status: response.status, html: await response.text() }; };
      const pages = { result: await page(`/r/${f.sourceRun}`), task: await page("/t/feat"), chat: await page(`/chat?task=feat&result=${f.sourceRun}`), cockpit: await page("/review?result=feat"), work: await page("/work") };
      for (const [name, one] of Object.entries(pages)) {
        expect(one.status, name).toBe(200);
        expect(one.html, name).not.toMatch(NO_REFRESH);
        expect(one.html, name).not.toContain("/retry-review");
      }
      expect(pages.chat.html).toContain(`data-result-run="${f.sourceRun}"`);
      for (const html of [pages.task.html, pages.cockpit.html]) {
        expect(html).toContain('data-work-status="assignment-ready-to-check"');
        // Historical judgements remain stored below; they are not a current stage.
        expect(html).not.toContain('<button type="button" class="review-retry-button"');
      }
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(pages.task.html)?.[1] ?? "";
      expect(csrf).not.toBe("");
      const post = (path: string, fields: Record<string, string>) => fetch(base + path, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
      expect((await post("/t/feat/refresh-review", { run: String(f.sourceRun) })).status).toBe(404);
      expect((await post(`/r/${f.sourceRun}/refresh`, {})).status).toBe(404);
      const retried = await post("/t/feat/retry-review", { run: String(f.sourceRun) });
      expect(retried.status).toBe(410); expect(await retried.text()).toContain("Separate agent reviews have retired");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(f.ask()).toMatchObject({ ok: false, reason: "already-reviewed" });
    expect(reviewers()).toHaveLength(1); expect(f.store.openReviewRequests()).toEqual([]);
    expect(f.store.criterionReviewsFor(f.sourceRun)).toHaveLength(4);
  });

  test.each(["legacy-header-missing", "failed-check", "receipt", "receipt-tampered", "new-grant"] as const)("machine gate receipt: %s never invents or waives historical evidence", async variant => {
    const f = await firstReady();
    const command = f.store.liveVerifyCommand(f.repo)!;
    const log = f.store.artifactsFor(f.sourceRun).find(a => a.kind === "check-log")!;
    if (variant === "legacy-header-missing") {
      const bytes = Buffer.from("all green; the agent says npm test passed");
      writeFileSync(join(f.evidenceRoot, log.key), bytes);
      f.store.raw().prepare("UPDATE artifact SET sha256 = ?, bytes_stored = ? WHERE id = ?").run(sha256(bytes), bytes.length, log.id);
    } else {
      sealVerificationReceipt(f.store, f.evidenceRoot, f.sourceRun, f.shas.source, command, { configured: true, ran: true, exitCode: variant === "failed-check" ? 1 : 0 }, T0);
      if (variant === "receipt-tampered") {
        const receipt = f.store.artifactsFor(f.sourceRun).find(a => a.capture === "machine verification receipt v1")!;
        writeFileSync(join(f.evidenceRoot, receipt.key), "{}");
      }
      if (variant === "new-grant") f.store.setVerifyCommand({ repo: f.repo, command: "npm test", timeoutMs: 60000, approvedBy: "alex" }, T0);
    }
    const checked = verificationEvidence(f.store, f.evidenceRoot, f.sourceRun);
    expect(checked.ok).toBe(variant === "receipt");
    if (checked.ok) expect(JSON.parse(checked.bytes!)).toMatchObject({ head: f.shas.source, command: { id: command.id }, result: { exitCode: 0 }, log: { sha256: log.sha256, bytesStored: 14572 } });
    if (variant === "failed-check") {
      f.store.saveProofVerdict(f.sourceRun, "refuted", ["The actual check failed."], T0, [], "refuted");
      const failure = verificationEvidence(f.store, f.evidenceRoot, f.sourceRun);
      expect(failure.ok && JSON.parse(failure.bytes!).result.exitCode).toBe(1);
    }
  });

  test.each(["intact", "tampered", "missing", "failed", "changed-scope"] as const)("shortened check log: %s keeps integrity separate from completeness", async variant => {
    const f = await seed({ shortenedLog: true });
    const log = f.store.artifactsFor(f.sourceRun).find(one => one.kind === "check-log")!;
    expect(log.truncated).toBe(true);
    expect(readVerifiedArtifact(f.evidenceRoot, log).ok).toBe(true);
    if (variant === "tampered") writeFileSync(join(f.evidenceRoot, log.key), "tampered".padEnd(log.bytesStored));
    if (variant === "missing") rmSync(join(f.evidenceRoot, log.key));
    if (variant === "failed") f.store.raw().prepare("UPDATE artifact SET capture_status = 'failed' WHERE id = ?").run(log.id);
    if (variant === "changed-scope") f.store.raw().prepare("UPDATE run SET scope_digest = 'changed' WHERE id = ?").run(f.sourceRun);
    const inventory = (await capture(f))!.inventory;
    if (variant === "changed-scope") {
      expect(inventory.priorReview).toEqual([]);
      expect(inventory.gaps.some(one => one.reason === "source-scope-changed")).toBe(true);
    } else expect(inventory.priorReview.map(one => one.support)).toEqual([variant === "intact" ? "eligible" : "invalid", variant === "intact" ? "eligible" : "invalid"]);
    if (variant === "intact") {
      expect(inventory.priorReview.every(one => one.bindingsVerified)).toBe(true);
      expect(reviewContextCustodyProblem(f.store, f.evidenceRoot, inventory)).toBeNull();
      writeFileSync(join(f.evidenceRoot, log.key), "tampered".padEnd(log.bytesStored));
      expect(reviewContextCustodyProblem(f.store, f.evidenceRoot, inventory)).toMatch(/check-log/);
    }
  });

  test.each(["clean", "unrelated redaction"] as const)("large unchanged files and a small CSS revision retain exact partial sections in %s artifacts", async variant => {
    const padding = "// existing café 🔎\n".repeat(Math.ceil(REVIEW_CONTEXT_LIMITS.itemBytes / Buffer.byteLength("// existing café 🔎\n")));
    const redacted = variant === "unrelated redaction";
    const f = await seed({
      baseFiles: { "src/guard.ts": padding + GUARD_TS.replace("n < 3", "n < 9"), "src/serve.ts": padding + ".button { color: red; }\n", "src/store.ts": padding + "const retries = 9;\n", ...(redacted ? { "src/mate.test.ts": padding + "// old fixture\n" } : {}) },
      guardSource: padding + GUARD_TS,
      extraSourceFiles: { "src/serve.ts": padding + ".button { color: blue; }\n", "src/store.ts": padding + "const retries = 3;\n", ...(redacted ? { "src/mate.test.ts": padding + "// AKIAABCDEFGHIJKLMNOP\n" } : {}) },
      revisionFiles: { "src/report.ts": REPORT_TS_V2, "src/serve.ts": padding + ".button { color: green; }\n", ...(redacted ? { "src/mate.test.ts": padding + "// revised fixture\n" } : {}) },
      shortenedLog: true,
    });
    const inventory = (await capture(f))!.inventory;
    expect(inventory.schema).toBe(3);
    for (const path of ["src/guard.ts", "src/serve.ts", "src/store.ts"]) {
      const item = inventory.items.find(one => one.path === path)!;
      expect(item.patch?.coverage).toBe("partial");
      expect(item.bytes).toBeLessThan(REVIEW_CONTEXT_LIMITS.itemBytes);
      expect(item.sha256).toBe(sha256(item.content));
      expect(item.content).not.toBe(padding + GUARD_TS);
      for (const segment of item.patch!.segments) {
        const artifact = f.store.getArtifact(segment.artifact)!;
        expect(artifact.redacted).toBe(redacted);
        const read = readVerifiedArtifact(f.evidenceRoot, artifact);
        expect(read.ok).toBe(true);
        if (read.ok) expect(item.content).toContain(read.content.subarray(segment.offset, segment.offset + segment.bytes).toString("utf8"));
      }
      expect(inventory.identities!.find(one => one.path === path)).toMatchObject({ blob: git(f.repo, "rev-parse", `${f.shas.revision}:${path}`), unchangedSinceSource: path !== "src/serve.ts" });
    }
    const css = inventory.items.find(one => one.path === "src/serve.ts")!;
    expect(css.patch!.segments.map(one => one.run)).toEqual([f.sourceRun, f.revisionRun]);
    expect(css.content).toContain("-.button { color: red; }");
    expect(css.content).toContain("+.button { color: green; }");
    if (redacted) {
      expect(inventory.items.some(one => one.path === "src/mate.test.ts")).toBe(false);
      expect(inventory.gaps).toContainEqual(expect.objectContaining({ path: "src/mate.test.ts", reason: "secret-redacted" }));
      expect(inventory.coverage.find(one => one.id === "c4")?.state).toBe("gap");
      expect(inventory.items.every(one => !one.content.includes("[redacted:") && !one.content.includes("AKIAABCDEFGHIJKLMNOP"))).toBe(true);
    }
    expect(inventory.priorReview.find(one => one.criterionId === "c2")).toMatchObject({ relevantUnchanged: true, bindingsVerified: true, support: "eligible" });
    expect(inventory.coverage.find(one => one.id === "c2")).toMatchObject({ state: "gap", priorSupport: "eligible", gaps: [expect.stringContaining("full-file context is missing")] });
    expect(parseReviewContext(serializeReviewContext(inventory))).toEqual({ ok: true, inventory });
    const matrix = adjudicateRevision(f, inventory);
    expect(matrix.every(one => one.review === null)).toBe(true);
    expect(semanticCoverage(matrix, "strict")).toMatchObject({ upheld: [], satisfied: null });
    expect(reviewContextCustodyProblem(f.store, f.evidenceRoot, inventory)).toBeNull();
    const forged = structuredClone(inventory);
    forged.items.find(one => one.path === "src/guard.ts")!.patch!.segments[0]!.offset++;
    expect(reviewContextCustodyProblem(f.store, f.evidenceRoot, forged)).toMatch(/exact source bytes/);
    // Even internally hashed content at a real artifact range must be the
    // WHOLE section for this path, not a clean fragment or another file.
    for (const variant of ["fragment", "other path"] as const) {
      const rebound = structuredClone(inventory);
      const item = rebound.items.find(one => one.path === "src/guard.ts")!;
      if (variant === "fragment") {
        const removed = Buffer.byteLength(item.content.split("\n")[0]! + "\n");
        item.content = Buffer.from(item.content).subarray(removed).toString("utf8");
        item.patch!.segments[0]!.offset += removed;
        item.patch!.segments[0]!.bytes -= removed;
      } else {
        const other = rebound.items.find(one => one.path === "src/store.ts")!;
        item.content = other.content;
        item.patch = structuredClone(other.patch);
      }
      item.bytes = Buffer.byteLength(item.content);
      item.sha256 = sha256(item.content);
      expect(parseReviewContext(serializeReviewContext(rebound)).ok).toBe(true);
      expect(reviewContextCustodyProblem(f.store, f.evidenceRoot, rebound)).toMatch(/exact source bytes/);
    }
    expect(parseReviewContext(JSON.stringify({ ...inventory, schema: 1 })).ok).toBe(false);
    expect(parseReviewContext(JSON.stringify({ ...inventory, schema: 99 })).ok).toBe(false);
    const hiddenGap = structuredClone(inventory);
    hiddenGap.coverage.find(one => one.id === "c2")!.state = "context";
    expect(parseReviewContext(serializeReviewContext(hiddenGap))).toMatchObject({ ok: false, problem: expect.stringContaining("partial patches require") });
    const unsupported = structuredClone(inventory);
    const partial = unsupported.items.find(one => one.patch)!;
    delete partial.patch;
    expect(parseReviewContext(serializeReviewContext(unsupported))).toMatchObject({ ok: false, problem: expect.stringContaining("git blob identity") });
  });

  test.each(["whole file", "partial patch"] as const)("valid Unicode and quoted redaction text remain usable in a %s", async variant => {
    const padding = variant === "partial patch" ? "// existing code\n".repeat(Math.ceil(REVIEW_CONTEXT_LIMITS.itemBytes / 17)) : "";
    const marker = 'const marker = "[redacted: example detected on this line]";\n';
    const text = padding + marker + '// A literal replacement character is valid UTF-8: \uFFFD\n' + GUARD_TS;
    const f = await seed({ baseFiles: { "src/guard.ts": padding + "// old\n" }, guardSource: text });
    const inventory = (await capture(f))!.inventory;
    const item = inventory.items.find(one => one.path === "src/guard.ts");
    expect(item?.content).toContain(marker.trim());
    expect(item?.content).toContain("\uFFFD");
    expect(Boolean(item?.patch)).toBe(variant === "partial patch");
    expect(inventory.priorReview.find(one => one.criterionId === "c2")?.support).toBe("eligible");
    expect(parseReviewContext(serializeReviewContext(inventory)).ok).toBe(true);
    expect(reviewContextCustodyProblem(f.store, f.evidenceRoot, inventory)).toBeNull();
  });

  test("range protocol preserves UTF-8 and escaped long lines, and refuses arbitrary or unbounded requests", () => {
    const bytes = Buffer.from('a🔎é"\\'.repeat(20000));
    const file = { name: "REVIEW-CONTEXT-ctx-1.txt", bytes, sha256: sha256(bytes) };
    let offset = 0;
    let text = "";
    while (offset < bytes.length) {
      const request = { file: file.name, sha256: file.sha256, offset, length: 65536 };
      expect(evidenceRequest(JSON.stringify({ version: 1, readEvidence: request }))).toEqual(request);
      const range = evidenceRange([file], request);
      expect(Buffer.byteLength(JSON.stringify(range))).toBeLessThan(1024 * 1024);
      text += range.content;
      offset = range.nextOffset;
    }
    expect(Buffer.from(text)).toEqual(bytes);
    const empty = { ...file, bytes: Buffer.alloc(0), sha256: sha256("") };
    expect(evidenceRange([empty], { file: empty.name, sha256: empty.sha256, offset: 0, length: 65536 })).toMatchObject({ content: "", bytes: 0, nextOffset: 0, eof: true });
    expect(evidenceRange([file], { file: file.name, sha256: file.sha256, offset: bytes.length, length: 1 })).toMatchObject({ content: "", bytes: 0, eof: true });
    for (const patch of [{ length: 65537 }, { length: 0 }, { offset: -1 }, { offset: 0.5 }, { command: "cat /etc/passwd" }]) {
      expect(evidenceRequest(JSON.stringify({ version: 1, readEvidence: { file: file.name, sha256: file.sha256, offset: 0, length: 10, ...patch } }))).toBeNull();
    }
    // Run 1638: claude's flat reply schema can carry review keys beside a
    // read request. Only the exact two-key envelope is a read; a mixed or
    // incomplete reply is neither served bytes nor treated as a delivery
    // failure.
    const exact = { version: 1, readEvidence: { file: file.name, sha256: file.sha256, offset: 0, length: 10 } };
    expect(isEvidenceOnlyReply(JSON.stringify(exact))).toBe(true);
    for (const mixed of [{ ...exact, comments: [] }, { ...exact, criteria: [] }, { ...exact, learning: [] }, { version: 1 }, { version: 1, readEvidence: {} }]) {
      expect(isEvidenceOnlyReply(JSON.stringify(mixed))).toBe(Object.keys(mixed).length === 2);
      expect(evidenceRequest(JSON.stringify(mixed))).toBeNull();
    }
    expect(() => evidenceRange([file], { file: file.name, sha256: file.sha256, offset: 2, length: 10 })).toThrow(/UTF-8/);
  });

  test("malformed UTF-8 still cannot be represented as a complete file", async () => {
    const f = await seed({ extraSourceFiles: { "src/guard.ts": Buffer.from([0x61, 0xff, 0x62]) } });
    const inventory = (await capture(f))!.inventory;
    expect(inventory.items.some(one => one.path === "src/guard.ts")).toBe(false);
    expect(inventory.gaps.some(one => one.path === "src/guard.ts" && ["binary", "capture-failed"].includes(one.reason))).toBe(true);
  });

  test.each(["duplicate section", "wrong endpoints", "redacted header"] as const)("a %s in a redacted artifact cannot supply a large-file section", async variant => {
    const padding = "// existing code\n".repeat(Math.ceil(REVIEW_CONTEXT_LIMITS.itemBytes / 17));
    const f = await seed({
      baseFiles: { "src/guard.ts": padding + "old\n" },
      guardSource: padding + GUARD_TS,
      extraSourceFiles: { "src/mate.test.ts": "// AKIAABCDEFGHIJKLMNOP\n" },
      sourcePatch: patch => {
        const start = patch.indexOf("diff --git a/src/guard.ts b/src/guard.ts\n");
        const end = patch.indexOf("diff --git ", start + 1);
        const section = patch.slice(start, end);
        if (variant === "duplicate section") return patch + section;
        if (variant === "wrong endpoints") return patch.replace(section, section.replace(/^index .*$/m, `index ${"a".repeat(40)}..${"b".repeat(40)} 100644`));
        return patch.replace("diff --git a/src/guard.ts b/src/guard.ts", "[redacted: aws-access-key detected on this line]");
      },
    });
    const inventory = (await capture(f))!.inventory;
    expect(f.store.getArtifact(f.sourceDiffArtifact)?.redacted).toBe(true);
    expect(inventory.source.verified).toBe(true);
    expect(inventory.items.some(one => one.path === "src/guard.ts")).toBe(false);
    expect(inventory.coverage.find(one => one.id === "c2")).toMatchObject({ state: "gap", priorSupport: "invalid" });
  });

  test("a large file changed outside the sealed revision intervals is an explicit gap even if the final blob reverts", async () => {
    const padding = "// existing code\n".repeat(Math.ceil(REVIEW_CONTEXT_LIMITS.itemBytes / 17));
    const f = await seed({ baseFiles: { "src/guard.ts": padding + "old\n" }, guardSource: padding + GUARD_TS, intermediateFiles: { "src/guard.ts": padding + "uncovered\n" }, revisionFiles: { "src/guard.ts": padding + GUARD_TS, "src/report.ts": REPORT_TS_V2 } });
    const inventory = (await capture(f))!.inventory;
    expect(inventory.identities!.find(one => one.path === "src/guard.ts")?.unchangedSinceSource).toBe(true);
    expect(inventory.items.some(one => one.path === "src/guard.ts")).toBe(false);
    expect(inventory.coverage.find(one => one.id === "c2")).toMatchObject({ state: "gap", priorSupport: "invalid", gaps: expect.arrayContaining([expect.stringContaining("uncovered changes")]) });
  });

  test("an unrelated criterion change does not discard useful partial evidence for an unchanged criterion", async () => {
    const padding = "// existing code\n".repeat(Math.ceil(REVIEW_CONTEXT_LIMITS.itemBytes / 17));
    const rubric = RUBRIC.map(one => one.id === "c1" ? { ...one, statement: "The limiter caps retries at two." } : one);
    const f = await seed({ revisionRubric: rubric, baseFiles: { "src/guard.ts": padding + "old\n" }, guardSource: padding + GUARD_TS });
    const inventory = (await capture(f, rubric))!.inventory;
    expect(inventory.items.find(one => one.path === "src/guard.ts")?.patch?.coverage).toBe("partial");
    expect(inventory.priorReview.find(one => one.criterionId === "c2")?.support).toBe("eligible");
    expect(inventory.priorReview.find(one => one.criterionId === "c1")?.support).toBe("invalid");
  });

  test.each(["binary", "redacted", "over-budget"] as const)("large %s source context remains an honest gap", async variant => {
    const padding = "// existing code\n".repeat(Math.ceil(REVIEW_CONTEXT_LIMITS.itemBytes / 17));
    const before = variant === "binary" ? Buffer.alloc(80000) : padding + "old\n";
    const after = variant === "binary" ? Buffer.concat([Buffer.alloc(80000), Buffer.from([1])]) : variant === "redacted" ? padding + "// AKIAABCDEFGHIJKLMNOP\n" : padding + "x".repeat(LEGACY_REVIEW_CONTEXT_LIMITS.itemBytes + 1) + "\n";
    const f = await seed({ baseFiles: { "src/guard.ts": before }, extraSourceFiles: { "src/guard.ts": after } });
    const inventory = (await capture(f))!.inventory;
    expect(inventory.items.some(one => one.path === "src/guard.ts")).toBe(false);
    expect(inventory.gaps.some(one => one.path === "src/guard.ts" && one.reason === (variant === "binary" ? "binary" : variant === "redacted" ? "secret-redacted" : "over-limit"))).toBe(true);
    expect(inventory.coverage.find(one => one.id === "c2")?.state).toBe("gap");
    if (variant !== "over-budget") expect(inventory.priorReview.find(one => one.criterionId === "c2")?.support).toBe("invalid");
  });

  test("complete files share a storage ceiling independent of prompt delivery, with honest aggregate gaps", async () => {
    const padding = "// existing code\n".repeat(Math.floor((REVIEW_CONTEXT_LIMITS.itemBytes - 100) / 17));
    const paths = Array.from({ length: 5 }, (_, i) => `src/large-${i}.ts`);
    const f = await seed({ baseFiles: Object.fromEntries(paths.map(path => [path, padding])), extraSourceFiles: Object.fromEntries(paths.map(path => [path, padding + "// new\n"])) });
    const inventory = (await capture(f))!.inventory;
    expect(inventory.items.filter(one => paths.includes(one.path))).toHaveLength(4);
    expect(inventory.items.every(one => !one.patch)).toBe(true);
    expect(inventory.items.reduce((sum, one) => sum + one.bytes, 0)).toBeLessThanOrEqual(REVIEW_CONTEXT_LIMITS.aggregateBytes);
    expect(inventory.gaps.some(one => one.reason === "aggregate-limit" && one.path === paths[4])).toBe(true);
    expect(inventory.items.some(one => one.path === paths[4])).toBe(false);
    expect(inventory.identities!.find(one => one.path === paths[4])?.unchangedSinceSource).toBe(true);
    expect(parseReviewContext(serializeReviewContext(inventory)).ok).toBe(true);
  });

  /** Store the matrix a builder would save for the revision run, coverage attached. */
  const adjudicateRevision = (f: Fixture, inventory: ReviewContextInventory, rubric = RUBRIC): CriterionMatrixRow[] => {
    const proof = {
      version: 1,
      criteria: rubric.map(one => ({ id: one.id, statement: one.statement, verdict: "met", how: "see the revision", evidence: one.evidence.map(kind => ({ kind, ref: kind === "check" ? "npm test" : "src/report.ts" })) })),
      checks: [{ command: "npm test", exitCode: 0, summary: "green" }],
      changed: ["src/report.ts"],
      caveats: [],
      screenshots: [],
    };
    const { verdict, reasons, matrix } = adjudicate({
      proofArtifactPresent: true,
      proofParse: { ok: true, proof: proof as never },
      handoffPresent: true,
      terminalDiffPresent: true,
      terminalDiffCaptureStatus: "ok",
      diffStat: { captured: true, truncated: false, paths: new Set(["src/report.ts"]) },
      verifyCommand: { configured: false },
      screenshots: [],
      approvedCriteria: rubric.map(one => ({ id: one.id, statement: one.statement, evidence: one.evidence })),
      reviewContext: inventory.coverage,
    });
    f.store.saveProofVerdict(f.revisionRun, verdict, reasons, T0, matrix);
    return matrix;
  };

  test("c1: a small revision seals bounded source context for inherited criteria outside its patch, each item bound to source run, commit, path, and digest", async () => {
    const f = await seed();
    const captured = await capture(f);
    if (captured === null) throw new Error("expected an inventory for a revision");
    const { inventory, artifactId } = captured;

    expect(inventory.run).toBe(f.revisionRun);
    expect(inventory.head).toBe(f.shas.revision);
    expect(inventory.source).toMatchObject({ task: "feat", run: f.sourceRun, head: f.shas.source, verified: true, problems: [] });
    expect(inventory.ancestry.verified).toBe(true);

    // Every relevant source path is sealed at the EXACT revision head, with
    // git's own blob id and a SHA-256 of the stored bytes.
    const byPath = new Map(inventory.items.map(one => [one.path, one]));
    expect([...byPath.keys()].sort()).toEqual(["src/guard.ts", "src/limit.ts", "src/report.ts"]);
    for (const item of inventory.items) {
      expect(item.commit).toBe(f.shas.revision);
      expect(item.blob).toBe(git(f.repo, "rev-parse", `${f.shas.revision}:${item.path}`));
      expect(item.sha256).toBe(sha256(item.content));
      expect(item.bytes).toBe(Buffer.byteLength(item.content, "utf8"));
      expect(item.sourceRun).toBe(f.sourceRun);
      expect(item.redacted).toBe(false);
    }
    expect(byPath.get("src/limit.ts")).toMatchObject({ content: LIMIT_TS, criteria: ["c1", "c4"], why: ["source-changed-path", "source-criterion-evidence"], unchangedSinceSource: true });
    expect(byPath.get("src/guard.ts")).toMatchObject({ content: GUARD_TS, criteria: ["c2", "c4"], unchangedSinceSource: true });
    expect(byPath.get("src/report.ts")).toMatchObject({ content: REPORT_TS_V2, criteria: ["c3", "c4"], unchangedSinceSource: false });
    expect(inventory.gaps).toEqual([]);

    // Coverage: c1/c2 inherited from sealed context; c3 is in the patch;
    // c4 covers every changed path of the source build.
    const coverage = new Map(inventory.coverage.map(one => [one.id, one]));
    expect(coverage.get("c1")).toMatchObject({ state: "context", inherited: true, paths: ["src/limit.ts"], items: [byPath.get("src/limit.ts")!.id], gaps: [], priorSupport: "eligible" });
    expect(coverage.get("c2")).toMatchObject({ state: "context", inherited: true, paths: ["src/guard.ts"], priorSupport: "eligible" });
    expect(coverage.get("c3")).toMatchObject({ state: "patch", inherited: true, priorSupport: "none" });
    expect(coverage.get("c4")).toMatchObject({ state: "context", inherited: true, paths: ["src/guard.ts", "src/limit.ts", "src/report.ts"], priorSupport: "none" });

    // Prior review provenance is carried with its proof, never as a verdict.
    expect(inventory.priorReview.map(one => [one.criterionId, one.support, one.judgement])).toEqual([["c1", "eligible", "upholds"], ["c2", "eligible", "upholds"]]);
    expect(inventory.priorReview[0]).toMatchObject({ sourceRun: f.sourceRun, statementMatches: true, ancestryVerified: true, relevantUnchanged: true, bindingsVerified: true, reasons: [] });

    // The stored artifact verifies and round-trips through the strict reader.
    const artifact = f.store.getArtifact(artifactId)!;
    expect(artifact).toMatchObject({ kind: "review-context", truncated: false, captureStatus: "ok", redacted: false });
    const verified = readVerifiedArtifact(f.evidenceRoot, artifact);
    if (!verified.ok) throw new Error(verified.problem);
    const parsed = parseReviewContext(verified.content.toString("utf8"));
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(parsed.inventory).toEqual(inventory);
    expect(serializeReviewContext(parsed.inventory)).toBe(verified.content.toString("utf8"));
    expect(f.store.revisionSourceOf(f.revisionTaskRef)).toMatchObject({ sourceTask: "feat", sourceRun: f.sourceRun });

    // The matrix rows carry the coverage; nothing about the verdict moved.
    const matrix = adjudicateRevision(f, inventory);
    expect(matrix.map(row => row.coverage?.state)).toEqual(["context", "context", "patch", "context"]);
    expect(matrix.find(row => row.id === "c1")?.coverage?.items).toEqual([byPath.get("src/limit.ts")!.id]);
  });

  test("new revision files omitted from proof path hints are still sealed in full", async () => {
    const content = "// surrounding test context\n".repeat(3000) + "export const restartRegression = true;\n";
    const f = await seed({ revisionFiles: { "src/report.ts": REPORT_TS_V2, "src/new-tests.ts": content } });
    const inventory = (await capture(f))!.inventory;
    expect(inventory.items.find(item => item.path === "src/new-tests.ts")).toMatchObject({ content, redacted: false, why: ["candidate-changed-path"] });
    expect(parseReviewContext(serializeReviewContext(inventory)).ok).toBe(true);
  });

  test("an ordinary run seals full files for its first reviewer without inheriting a verdict", async () => {
    const f = await seed();
    const captured = await captureReviewContext(f.store, exec, {
      runId: f.sourceRun, taskRef: f.sourceTaskRef, head: f.shas.source, base: f.shas.base,
      rubric: RUBRIC.map(one => ({ id: one.id, statement: one.statement, evidence: one.evidence })),
      patchPaths: new Set(), worktree: f.repo, root: f.evidenceRoot, now: () => T0,
    });
    expect(captured!.inventory.items.map(item => item.path)).toEqual(["src/guard.ts", "src/limit.ts", "src/report.ts"]);
    expect(captured!.inventory.coverage.every(row => !row.inherited)).toBe(true);
    expect(f.store.artifactsFor(f.sourceRun).some(one => one.kind === "review-context")).toBe(true);
    const { matrix } = adjudicate({ proofArtifactPresent: false, proofParse: null, handoffPresent: true, terminalDiffPresent: true, terminalDiffCaptureStatus: "ok", diffStat: null, verifyCommand: { configured: false }, screenshots: [], approvedCriteria: [{ id: "c1", statement: "x", evidence: ["check"] }] });
    expect(matrix[0]).not.toHaveProperty("coverage");
  });

  describe("c2: invalidation and explicit gaps", () => {
    test("changed criterion text invalidates prior support and is a named gap — never an inherited verdict", async () => {
      const changed = RUBRIC.map(one => (one.id === "c2" ? { ...one, statement: "The guard refuses a THIRD attempt." } : one));
      const f = await seed({ revisionRubric: changed });
      const inventory = (await capture(f, changed))!.inventory;
      const c2 = inventory.coverage.find(one => one.id === "c2")!;
      expect(c2).toMatchObject({ inherited: false, state: "gap", priorSupport: "invalid" });
      expect(c2.gaps.join(" ")).toMatch(/reads differently now/);
      expect(inventory.gaps.some(one => one.reason === "criterion-changed" && one.criteria.includes("c2"))).toBe(true);
      const prior = inventory.priorReview.find(one => one.criterionId === "c2")!;
      expect(prior).toMatchObject({ support: "invalid", statementMatches: false });
      expect(prior.reasons).toContain("the criterion's signed text changed since the source review");
      // c1 is untouched by the change and still fully supported.
      expect(inventory.coverage.find(one => one.id === "c1")).toMatchObject({ state: "context", priorSupport: "eligible" });
    });

    test("changed relevant code moves the criterion into the patch and invalidates the earlier judgement", async () => {
      const f = await seed({ revisionFiles: { "src/report.ts": REPORT_TS_V2, "src/guard.ts": "export function guard(n: number): boolean {\n  return n < 2;\n}\n" } });
      const inventory = (await capture(f))!.inventory;
      const guard = inventory.items.find(one => one.path === "src/guard.ts")!;
      expect(guard.unchangedSinceSource).toBe(false);
      expect(guard.commit).toBe(f.shas.revision);
      expect(inventory.coverage.find(one => one.id === "c2")).toMatchObject({ state: "patch", inherited: true, priorSupport: "invalid" });
      const prior = inventory.priorReview.find(one => one.criterionId === "c2")!;
      expect(prior.support).toBe("invalid");
      expect(prior.reasons.join(" ")).toMatch(/not byte-identical/);
      expect(inventory.coverage.find(one => one.id === "c1")).toMatchObject({ state: "context", priorSupport: "eligible" });
    });

    test("stale ancestry: a head that does not descend from the source head invalidates every inherited support and gaps every inherited criterion", async () => {
      const f = await seed({ revisionBaseSha: "base", revisionFiles: { "src/report.ts": REPORT_TS_V2 } });
      const inventory = (await capture(f))!.inventory;
      expect(inventory.ancestry.verified).toBe(false);
      expect(inventory.ancestry.detail).toMatch(/not an ancestor/);
      expect(inventory.gaps.some(one => one.reason === "stale-ancestry")).toBe(true);
      for (const id of ["c1", "c2"]) {
        expect(inventory.coverage.find(one => one.id === id)).toMatchObject({ state: "gap", priorSupport: "invalid" });
      }
      for (const prior of inventory.priorReview) {
        expect(prior).toMatchObject({ support: "invalid", ancestryVerified: false });
      }
      // Items that do not exist at this head are gaps, never guesses.
      expect(inventory.gaps.some(one => one.reason === "missing-at-head" && one.path === "src/limit.ts")).toBe(true);
      expect(inventory.items.every(one => one.unchangedSinceSource === null)).toBe(true);
    });

    test("a tampered ancestor proof is unverified: the source is not trusted, prior support is invalid, and inherited criteria are gaps", async () => {
      const f = await seed();
      const proof = f.store.getArtifact(f.sourceProofArtifact)!;
      writeFileSync(join(f.evidenceRoot, proof.key), JSON.stringify({ version: 1, criteria: [], changed: ["src/evil.ts"] }));
      const inventory = (await capture(f))!.inventory;
      expect(inventory.source.verified).toBe(false);
      expect(inventory.source.problems.join(" ")).toMatch(/proof no longer verifies/);
      expect(inventory.gaps.some(one => one.reason === "source-proof-missing")).toBe(true);
      // The verified diff-stat still names the source's changed paths, so
      // items are sealed — but without the proof nothing binds a path to a
      // criterion, and every inherited criterion is a gap, not context.
      expect(inventory.items.every(one => one.why.includes("source-changed-path") && !one.why.includes("source-criterion-evidence"))).toBe(true);
      for (const id of ["c1", "c2"]) expect(inventory.coverage.find(one => one.id === id)?.state).toBe("gap");
      expect(inventory.coverage.find(one => one.id === "c1")?.gaps.join(" ")).toMatch(/proof no longer verifies/);
      expect(inventory.priorReview.every(one => one.support === "invalid" && one.reasons.includes("the source run's sealed artifacts do not all verify"))).toBe(true);
    });

    test("an unproven ancestor (no sealed head) supplies no ancestry and no eligible support", async () => {
      const f = await seed();
      f.store.raw().prepare("UPDATE run SET head_revision = NULL WHERE id = ?").run(f.sourceRun);
      const inventory = (await capture(f))!.inventory;
      expect(inventory.source.head).toBeNull();
      expect(inventory.ancestry.verified).toBe(false);
      expect(inventory.priorReview.every(one => one.support === "invalid")).toBe(true);
      for (const id of ["c1", "c2"]) expect(inventory.coverage.find(one => one.id === id)?.state).toBe("gap");
      // Touching one path cannot hide missing ancestry for the others.
      expect(inventory.coverage.find(one => one.id === "c4")).toMatchObject({ state: "gap", gaps: expect.arrayContaining([expect.stringMatching(/no sealed head/)]) });
    });

    test("byte limits and secrets are honest gaps: oversized paths are never truncated, images are one summary line, and a redacted item cannot support its criterion", async () => {
      const bigBase = "// existing code\n".repeat(Math.ceil(REVIEW_CONTEXT_LIMITS.itemBytes / 17));
      const big = bigBase + "x".repeat(LEGACY_REVIEW_CONTEXT_LIMITS.itemBytes + 1) + "\n";
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const f = await seed({
        baseFiles: { "src/big.ts": bigBase },
        extraSourceFiles: { "src/big.ts": big, "assets/dot.png": png },
        guardSource: `${GUARD_TS}// token: AKIAABCDEFGHIJKLMNOP\n`,
      });
      const inventory = (await capture(f))!.inventory;
      const reasons = new Map(inventory.gaps.map(one => [`${one.reason}:${one.path}`, one]));
      expect(inventory.gaps.some(one => one.path === "src/big.ts" && one.reason === "over-limit" && /exceeds the .*item limit/.test(one.detail))).toBe(true);
      expect(inventory.gaps.some(one => one.path === "assets/dot.png")).toBe(false);
      expect(reasons.get("secret-redacted:src/guard.ts")?.criteria).toEqual(["c2", "c4"]);
      expect(inventory.items.some(one => one.path === "src/big.ts" || one.path === "assets/dot.png")).toBe(false);
      const guard = inventory.items.find(one => one.path === "src/guard.ts")!;
      expect(guard.redacted).toBe(true);
      expect(guard.content).not.toContain("AKIAABCDEFGHIJKLMNOP");
      expect(guard.content).toContain("[redacted: aws-access-key");
      expect(guard.sha256).toBe(sha256(guard.content));
      expect(inventory.items.reduce((sum, one) => sum + one.bytes, 0)).toBeLessThanOrEqual(REVIEW_CONTEXT_LIMITS.aggregateBytes);
      // c2's only relevant path is redacted — a gap; c4 spans the oversized
      // path (named on its row even though the patch touches one of its
      // paths); c1 is untouched — still sealed context. The image is never
      // a gap: every row carries the same one-line summary instead.
      expect(inventory.coverage.find(one => one.id === "c2")).toMatchObject({ state: "gap", items: [guard.id] });
      expect(inventory.coverage.find(one => one.id === "c4")?.gaps).toEqual(expect.arrayContaining([expect.stringMatching(/src\/big\.ts: .*item limit/)]));
      expect(inventory.coverage.flatMap(one => one.gaps).some(gap => gap.includes("dot.png"))).toBe(false);
      expect(inventory.coverage.map(one => one.assets)).toEqual(inventory.coverage.map(() => `1 image, ${png.length} bytes, in the run's evidence`));
      expect(inventory.coverage.find(one => one.id === "c1")?.state).toBe("context");
      const artifact = f.store.artifactsFor(f.revisionRun).find(one => one.kind === "review-context")!;
      expect(artifact.redacted).toBe(true);
    });

    test("a change full of screenshots lists them as one summary line: no image is a missing file or held against the bounds", async () => {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const shots = Object.fromEntries(Array.from({ length: 55 }, (_, n) => [`evidence/feat/shot-${n}.png`, Buffer.concat([png, Buffer.alloc(1024 * 16)])]));
      const f = await seed({ rootOnly: true, priorJudgements: [], extraSourceFiles: { ...shots, "evidence/feat/journey.jpg": png, "docs/manual.pdf": png } });
      const inventory = (await capture(f))!.inventory;
      expect(inventory.gaps.filter(one => /evidence\/|\.pdf/.test(one.detail))).toEqual([]);
      expect(inventory.gaps.filter(one => one.reason === "item-cap")).toEqual([]);
      expect(inventory.items.map(one => one.path).sort()).toEqual(["src/guard.ts", "src/limit.ts", "src/report.ts"]);
      const bytes = Object.values(shots).reduce((sum, one) => sum + one.length, 0) + png.length * 2;
      const line = `56 images, 1 other binary file, ${Math.round(bytes / 1024)} KB, in the run's evidence`;
      expect(inventory.coverage.map(one => one.assets)).toEqual(inventory.coverage.map(() => line));
      expect(inventory.coverage.flatMap(one => one.gaps)).toEqual([]);
      expect(inventory.coverage.flatMap(one => one.paths).some(path => !path.startsWith("src/"))).toBe(false);
      expect(parseReviewContext(serializeReviewContext(inventory))).toMatchObject({ ok: true, inventory: { coverage: inventory.coverage } });
    });

    test("the strict reader refuses an inventory whose item bytes no longer hash, and one that claims eligibility without proof", async () => {
      const f = await seed();
      const inventory = (await capture(f))!.inventory;
      const forged = JSON.parse(serializeReviewContext(inventory)) as { items: { content: string; bytes: number }[]; priorReview: Record<string, unknown>[] };
      forged.items[0]!.content += "\n// edited after sealing";
      expect(parseReviewContext(JSON.stringify(forged))).toMatchObject({ ok: false, problem: expect.stringMatching(/bytes must equal/) });
      forged.items[0]!.bytes = Buffer.byteLength(forged.items[0]!.content, "utf8");
      expect(parseReviewContext(JSON.stringify(forged))).toMatchObject({ ok: false, problem: expect.stringMatching(/sha256 does not match/) });
      const liar = JSON.parse(serializeReviewContext(inventory)) as { priorReview: Record<string, unknown>[] };
      liar.priorReview[0]!["ancestryVerified"] = false;
      expect(parseReviewContext(JSON.stringify(liar))).toMatchObject({ ok: false, problem: expect.stringMatching(/claims eligibility/) });
      expect(parseReviewContext("nope")).toMatchObject({ ok: false });
      const legacy = { ...inventory, schema: 1, identities: undefined };
      expect(parseReviewContext(JSON.stringify(legacy))).toMatchObject({ ok: true, inventory: { schema: 1 } });
      expect(parseReviewContext(JSON.stringify({ ...inventory, schema: 2, limits: LEGACY_REVIEW_CONTEXT_LIMITS }))).toMatchObject({ ok: true, inventory: { schema: 2 } });
    });
  });

  test("real Git: the sealed stat of a revision pairs a moved file once under its destination, and only the diff-explained lists are handed back for correction (comment 396, run 1642)", async () => {
    // Run 1642 moved scripts/claude-review-schema-smoke.mjs to src/fixtures/
    // and its proof listed both names. This is git's own rename detection on
    // a real repository, sealed by the same capture the builder runs, read
    // by the same restatement the correction boundary and adjudication
    // share — an ordinary edit, a delete, an add and an unpaired rewrite
    // ride along so the whole inventory is exercised, not just the rename.
    const smoke = Array.from({ length: 40 }, (_, i) => `console.log("smoke line ${i}");
`).join("");
    const f = await seed({ baseFiles: { "scripts/smoke.mjs": smoke, "src/gone.ts": "export const gone = 1;\n", "src/rewrite.ts": "export const before = 'a';\n" } });
    // The move happens as an agent's `mv` would: old path gone, new path
    // written; pairing is git's own between the two committed trees.
    git(f.repo, "rm", "-q", "scripts/smoke.mjs", "src/gone.ts", "src/rewrite.ts");
    const head = commitFiles(f.repo, {
      "src/fixtures/smoke.mjs": smoke + "export {};\n",
      "src/report.ts": REPORT_TS_V2 + "// moved the smoke script\n",
      "src/new.ts": "export const fresh = true;\n",
      "src/rewritten.ts": Array.from({ length: 30 }, (_, i) => `export const rewritten${i} = ${i};\n`).join(""),
    }, "move the smoke script");
    // A later attempt on the signed source task, sealed from the revision
    // commit exactly as the builder seals an ordinary build.
    const run = f.store.startRun({ taskRef: f.sourceTaskRef, leaseId: "move", runner: "builder-1", branch: "move", worktree: f.repo, provider: "claude", model: "sonnet", now: T0, ...presented(f.store, f.sourceTaskRef) });
    f.store.stampRun(run, { scopeDigest: f.store.getScope("feat")!.digest, baseRevision: f.shas.revision });
    f.store.recordOutcomeFacts(run, { headRevision: head });
    f.store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    const sealed = await captureTerminalDiff(f.store, exec, f.repo, f.shas.revision, head, f.evidenceRoot, run, T0);

    const facts = sealedDiffStatFacts(f.store, f.evidenceRoot, sealed.statId);
    expect(facts).not.toBeNull();
    expect(facts).toMatchObject({ captured: true, truncated: false });
    // Git paired the move: one destination path, the old name as provenance.
    // The rewrite fell under the similarity floor: a delete plus an add.
    expect([...facts!.paths].sort()).toEqual(["src/fixtures/smoke.mjs", "src/gone.ts", "src/new.ts", "src/report.ts", "src/rewrite.ts", "src/rewritten.ts"]);
    expect([...facts!.renames!]).toEqual([["scripts/smoke.mjs", "src/fixtures/smoke.mjs"]]);
    expect(git(f.repo, "diff", "--name-only", f.shas.revision, head).split("\n").sort()).toEqual([...facts!.paths].sort());

    const exact = [...facts!.paths].sort();
    // Run 1642's list: both names. Explained by the stat, so recoverable —
    // and the only admissible correction is the exact sealed inventory.
    expect(changedListProblems([...exact, "scripts/smoke.mjs"], facts)).toEqual({
      problems: ['changed lists "scripts/smoke.mjs", the old name of a move the sealed diff records once as "src/fixtures/smoke.mjs" — list the destination only'],
      recoverable: true,
      sealed: exact,
    });
    // The unstaged recipe's other failure mode on a resumed branch: a path
    // an earlier commit touched, left out.
    expect(changedListProblems(exact.filter(one => one !== "src/report.ts"), facts)).toMatchObject({ recoverable: true, problems: ['changed omits "src/report.ts", which the sealed diff contains'] });
    // The exact inventory has nothing to correct, and a path the diff never
    // had is never explained away — adjudication refutes it by name.
    expect(changedListProblems(exact, facts)).toMatchObject({ problems: [], recoverable: false });
    expect(changedListProblems([...exact, "src/other.ts"], facts)).toMatchObject({ recoverable: false });
    // A tampered sealed stat reads as not captured: nothing to hand back.
    const stat = f.store.getArtifact(sealed.statId)!;
    writeFileSync(join(f.evidenceRoot, stat.key), JSON.stringify({ schema: 1, files: [{ path: "src/fixtures/smoke.mjs" }], filesTruncated: false }));
    expect(sealedDiffStatFacts(f.store, f.evidenceRoot, sealed.statId)).toMatchObject({ captured: false });
    expect(changedListProblems(exact, sealedDiffStatFacts(f.store, f.evidenceRoot, sealed.statId))).toEqual({ problems: [], recoverable: false, sealed: null });
  });

  test.each(["complete files", "partial CSS patches"])("a second revision retains grandparent %s and every intervening change", async variant => {
    const padding = "// existing code\n".repeat(Math.ceil(REVIEW_CONTEXT_LIMITS.itemBytes / 17));
    const large = variant === "partial CSS patches";
    const f = await seed(large ? { baseFiles: { "src/guard.ts": padding + ".button { color: red; }\n" }, guardSource: padding + ".button { color: blue; }\n", revisionFiles: { "src/guard.ts": padding + ".button { color: green; }\n", "src/report.ts": REPORT_TS_V2 } } : {});
    await capture(f);
    const proof = JSON.parse(readFileSync(join(f.evidenceRoot, f.store.getArtifact(f.sourceProofArtifact)!.key), "utf8"));
    proof.changed = [...patchPathsOf(f.repo, f.shas.source, f.shas.revision)];
    for (const criterion of proof.criteria) criterion.evidence = [{ kind: "check", ref: "npm test" }];
    storeEvidence(f.store, f.evidenceRoot, f.revisionRun, "proof", "proof.json", Buffer.from(JSON.stringify(proof)), "proof", T0);
    const brief = Buffer.from(JSON.stringify({ schema: 1, sourceTask: f.revisionTaskId, sourceRun: f.revisionRun, sourceScopeDigest: f.store.getScope(f.revisionTaskId)!.digest, head: f.shas.revision, comments: [] }));
    const key = writeEvidenceFile(f.evidenceRoot, f.revisionRun, "next-brief.json", brief);
    const child = f.store.sealRevision({ source: { task: f.revisionTaskId, run: f.revisionRun, scopeDigest: f.store.getScope(f.revisionTaskId)!.digest }, brief: { evidenceRoot: f.evidenceRoot, key, bytes: brief.length, sha256: sha256(brief), capture: "revision brief" }, child: { id: "second-revision", title: "Next report", repair: "rename report" }, commentIds: null }, T0);
    if (!child.ok) throw new Error(child.reason);
    const ref = f.store.refFor("built-in", child.id).id;
    const scope = approve(f.store, child.id, "alex", T0, f.store.getScope(child.id)!.digest, f.approverToken);
    if (!scope.ok) throw new Error(scope.reason);
    const head = commitFiles(f.repo, { "src/report.ts": REPORT_TS_V2 + "// next revision\n", ...(large ? { "src/guard.ts": padding + ".button { color: purple; }\n" } : {}) }, "next revision");
    const run = f.store.startRun({ taskRef: ref, leaseId: "next", runner: "builder-1", branch: "next", worktree: f.repo, provider: "claude", model: "sonnet", now: T0, ...presented(f.store, ref) });
    f.store.stampRun(run, { scopeDigest: scope.scope.digest, baseRevision: f.shas.revision });
    f.store.recordOutcomeFacts(run, { headRevision: head });
    f.store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    await captureTerminalDiff(f.store, exec, f.repo, f.shas.revision, head, f.evidenceRoot, run, T0);
    const captured = await captureReviewContext(f.store, exec, { runId: run, taskRef: ref, head, base: f.shas.revision, rubric: RUBRIC, patchPaths: patchPathsOf(f.repo, f.shas.revision, head), worktree: f.repo, root: f.evidenceRoot, now: () => T0 });
    expect(captured?.inventory.bindings?.map(one => one.run)).toEqual([f.sourceRun, f.revisionRun]);
    expect(captured?.inventory.items.find(one => one.path === "src/limit.ts")).toMatchObject({ commit: head, content: LIMIT_TS, criteria: expect.arrayContaining(["c1"]) });
    expect(captured?.inventory.coverage.find(one => one.id === "c1")).toMatchObject({ state: "context", paths: ["src/limit.ts"], gaps: [] });
    if (large) {
      const item = captured!.inventory.items.find(one => one.path === "src/guard.ts")!;
      expect(item.patch!.segments.map(one => one.run)).toEqual([f.sourceRun, f.revisionRun, run]);
      for (const color of ["red", "blue", "green", "purple"]) expect(item.content).toContain(`color: ${color}`);
      expect(captured!.inventory.coverage.find(one => one.id === "c2")?.state).toBe("gap");
      expect(parseReviewContext(serializeReviewContext(captured!.inventory)).ok).toBe(true);
      expect(reviewContextCustodyProblem(f.store, f.evidenceRoot, captured!.inventory)).toBeNull();
    }
  });

  test("a changed evidence requirement invalidates a previous judgement even with identical criterion text", async () => {
    const rubric = RUBRIC.map(one => one.id === "c1" ? { ...one, evidence: ["manual-review"] as never } : one);
    const f = await seed({ revisionRubric: rubric });
    const captured = await capture(f, rubric);
    expect(captured?.inventory.priorReview.find(one => one.criterionId === "c1")).toMatchObject({ statementMatches: false, support: "invalid" });
  });

  test("context paths are literal and blob bytes must agree with their Git identity", async () => {
    const f = await seed({ extraSourceFiles: { "src/a[1].ts": "literal\n", "src/a1.ts": "pattern\n" } });
    const good = await capture(f);
    expect(good?.inventory.items.find(one => one.path === "src/a[1].ts")?.content).toBe("literal\n");
    const forged = structuredClone(good!.inventory);
    const item = forged.items[0]!;
    item.blob = "a".repeat(40);
    expect(parseReviewContext(serializeReviewContext(forged))).toMatchObject({ ok: false, problem: expect.stringContaining("blob identity") });
  });

  describe("c3 and c4: the reviewer pass over a revision", () => {

    /** Seal the inventory and the matrix the builder would have stored, then ask for a review. */
    const readyForReview = async (options: Parameters<typeof seed>[0] = {}) => {
      const f = await seed(options);
      const captured = (await capture(f))!;
      adjudicateRevision(f, captured.inventory);
      const asked = f.store.requestReview(f.revisionRun, "alex", T0);
      if (!asked.ok) throw new Error(`requestReview: ${asked.reason}`);
      return { ...f, inventory: captured.inventory, contextArtifact: captured.artifactId };
    };
    const judgements = (c1: { judgement: string; note: string }, rest: { judgement: string; note: string } = { judgement: "cannot-tell", note: "not settled by the sealed files" }) => [
      { id: "c1", ...c1 },
      { id: "c2", ...rest },
      { id: "c3", judgement: "upholds", note: "src/report.ts now names the outcome" },
      { id: "c4", ...rest },
    ];

    test("the parser rules: a contradicts may cite a patch path or a sealed file, cannot-tell needs nothing, and a patch criterion is unchanged", async () => {
      const f = await readyForReview();
      const rules = { ...reviewContextRules(f.inventory), sealedFiles: new Set(["REVIEW-CHECK-LOG.txt"]) };
      const patchPaths = new Set(["src/report.ts"]);
      const ids = new Set(["c1", "c2", "c3", "c4"]);
      expect(rules.provenanceRequired).toEqual(new Set(["c1", "c2", "c4"]));
      const parse = (criteria: { id: string; judgement: string; note: string }[]) => parseReview(JSON.stringify({ version: 1, comments: [], criteria }), patchPaths, ids, rules);
      expect(parse(judgements({ judgement: "contradicts", note: "src/report.ts drops the cap" })).ok).toBe(true);
      expect(parse(judgements({ judgement: "contradicts", note: "REVIEW-CHECK-LOG.txt shows the retry test failing" })).ok).toBe(true);
      expect(parse(judgements({ judgement: "cannot-tell", note: "nothing sealed settles it" })).ok).toBe(true);
      expect(parse(judgements({ judgement: "upholds", note: "ctx-9 says so" })).ok).toBe(false);
      expect(parse(judgements({ judgement: "upholds", note: "ctx-1 says so" })).ok).toBe(true);
      // Only c3 is fully represented by the patch.
      expect(parse([{ id: "c1", judgement: "cannot-tell", note: "unsettled" }, { id: "c2", judgement: "cannot-tell", note: "unsettled" }, { id: "c3", judgement: "upholds", note: "fine" }, { id: "c4", judgement: "contradicts", note: "REVIEW-CHECK-LOG.txt shows the gate is red" }]).ok).toBe(true);
      expect(parse([{ id: "c1", judgement: "cannot-tell", note: "unsettled" }, { id: "c2", judgement: "upholds", note: "fine" }, { id: "c3", judgement: "upholds", note: "fine" }, { id: "c4", judgement: "upholds", note: "fine" }])).toMatchObject({ ok: false, problems: expect.arrayContaining([{ reason: expect.stringMatching(/"c2" is outside the reviewed patch/) }]) });
      expect(citesSuppliedProvenance("see ctx-12", { itemIds: new Set(["ctx-1"]), patchPaths: new Set(), sealedFiles: new Set() })).toBe(false);
    });
  });

  describe("c5: semantic coverage on every surface", () => {
    const rows = (judged: Record<string, "upholds" | "contradicts" | "cannot-tell" | null>, coverageOf: Record<string, "patch" | "context" | "gap">): CriterionMatrixRow[] =>
      Object.keys(coverageOf).map(id => ({
        id,
        statement: `criterion ${id}`,
        requiredEvidence: ["check"],
        state: "pass",
        detail: [],
        answered: [{ kind: "check", ref: "npm test" }],
        review: judged[id] === null || judged[id] === undefined ? null : { judgement: judged[id]!, note: `note ${id}`, author: "reviewer:claude" },
        coverage: { state: coverageOf[id]!, inherited: coverageOf[id] !== "patch", items: coverageOf[id] === "context" ? ["ctx-1"] : [], gaps: coverageOf[id] === "gap" ? ["src/limit.ts: 60000 bytes exceeds the item limit"] : [], priorSupport: "none" },
      }));

    test("cannot-tell never satisfies required coverage under strict; under default the same review is optional and says so", () => {
      const matrix = rows({ c1: "upholds", c2: "cannot-tell", c3: "upholds" }, { c1: "context", c2: "gap", c3: "patch" });
      const strict = semanticCoverage(matrix, "strict");
      expect(strict).toMatchObject({ policy: "strict", required: true, upheld: ["c1", "c3"], uncertain: ["c2"], satisfied: false, contextGaps: [{ id: "c2", gaps: ["src/limit.ts: 60000 bytes exceeds the item limit"] }] });
      expect(coverageWords(strict)[0]).toMatch(/2\/3 upheld .* required under strict quality — NOT satisfied \(cannot-tell never counts: c2\)/);
      expect(coverageWords(strict)[1]).toBe("context gap c2: src/limit.ts: 60000 bytes exceeds the item limit");
      const lax = semanticCoverage(matrix, "default");
      expect(lax).toMatchObject({ policy: "default", required: false, satisfied: false });
      expect(coverageWords(lax)[0]).toMatch(/optional under default quality — 2\/3 upheld, cannot-tell: c2/);
      // All upheld satisfies both; nothing reviewed is unsettled, not satisfied.
      expect(semanticCoverage(rows({ c1: "upholds" }, { c1: "context" }), "strict")).toMatchObject({ satisfied: true });
      expect(semanticCoverage(rows({ c1: null }, { c1: "context" }), "strict")).toMatchObject({ satisfied: null, unreviewed: ["c1"] });
      // Nothing folded: no waiting line (model review is retired), only sealed context gaps would print.
      expect(coverageWords(semanticCoverage(rows({ c1: null }, { c1: "context" }), "strict"))).toEqual([]);
      expect(coverageWords(semanticCoverage([], "strict"))).toEqual([]);
      // The fold preserves coverage rows and still never raises a verdict.
      const folded = foldReview({ verdict: "short", reasons: ["x"], matrix: rows({ c1: null }, { c1: "gap" }) }, [{ id: "c1", judgement: "upholds", note: "ctx-1", author: "reviewer:codex" }]);
      expect(folded.verdict).toBe("short");
      expect(folded.matrix[0]?.coverage?.state).toBe("gap");
    });

    test("the CLI matrix words name each criterion's context standing, including gaps", () => {
      const lines = matrixWords(rows({ c1: "upholds", c2: "cannot-tell" }, { c1: "context", c2: "gap" }));
      expect(lines).toContain("      context: inherited — sealed context ctx-1");
      expect(lines.some(line => line.startsWith("      context: GAP — inherited context is missing: src/limit.ts: 60000 bytes"))).toBe(true);
    });
  });

  test("schema v51: a v50 file widens artifact.kind for review-context and adds the criterion_review binding columns without touching a historical row", () => {
    const dir = temp("so-ctx-v51-");
    const file = join(dir, "orders.db");
    const store = openStore(file);
    store.createTask({ id: "t", title: "t" }, T0);
    const ref = store.refFor("built-in", "t");
    store.placeTask(ref.id, "/repo");
    const run = store.startRun({ taskRef: ref.id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: T0, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
    const first = store.saveArtifact({ run, kind: "proof", key: `${run}/proof.json`, bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "historical", capture: "historical", captureStatus: "ok" }, T0);
    const raw = store.raw();
    const V50_ARTIFACT = `CREATE TABLE artifact (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief','base-tree','report','proof','check-log','screenshot','structured-output')),
  key TEXT NOT NULL,
  bytes_original INTEGER NOT NULL,
  bytes_stored INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  capture TEXT NOT NULL,
  created_at TEXT NOT NULL,
  redacted INTEGER NOT NULL DEFAULT 0,
  capture_status TEXT CHECK (capture_status IN ('ok','failed'))
)`;
    const V50_CRITERION_REVIEW = String(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'criterion_review'").get()?.["sql"])
      .replace(/,\s*(--[^\n]*\n\s*)*context_artifact\s+INTEGER,\s*context_sha\s+TEXT/s, "");
    expect(V50_CRITERION_REVIEW).not.toContain("context_");
    raw.exec(`PRAGMA foreign_keys = OFF; CREATE TABLE artifact_copy AS SELECT * FROM artifact; DROP TABLE artifact; ${V50_ARTIFACT}; INSERT INTO artifact SELECT * FROM artifact_copy; DROP TABLE artifact_copy;
      DROP TABLE criterion_review; ${V50_CRITERION_REVIEW}; PRAGMA foreign_keys = ON;`);
    const before = raw.prepare("SELECT * FROM artifact ORDER BY id").all();
    expect(() => raw.prepare("INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, sha256, capture, created_at) VALUES (?, 'review-context', ?, 1, 1, 'x', 'x', ?)").run(run, `${run}/rc.json`, T0.toISOString())).toThrow();
    raw.exec("DROP TABLE service_cursor");
    raw.prepare("UPDATE schema_version SET version = 50").run();
    store.close();

    const upgraded = openStore(file);
    stores.push(upgraded);
    expect(Number(upgraded.raw().prepare("SELECT version FROM schema_version").get()?.["version"])).toBe(SCHEMA_VERSION);
    expect(upgraded.raw().prepare("SELECT * FROM artifact ORDER BY id").all()).toEqual(before);
    expect(upgraded.getArtifact(first)).toMatchObject({ kind: "proof", sha256: "historical" });
    const added = upgraded.saveArtifact({ run, kind: "review-context", key: `${run}/review-context.json`, bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "ctx", capture: "machine-captured review context", captureStatus: "ok" }, T0);
    expect(upgraded.getArtifact(added)).toMatchObject({ kind: "review-context" });
    const columns = (upgraded.raw().prepare("PRAGMA table_info(criterion_review)").all() as { name: string }[]).map(one => one.name);
    expect(columns).toEqual(expect.arrayContaining(["context_artifact", "context_sha"]));
    upgraded.close();
    stores.pop();
    const reopened = new DatabaseSync(file, { readOnly: true });
    expect(String(reopened.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact'").get()?.["sql"])).toContain("'review-context'");
    reopened.close();
  });
});
