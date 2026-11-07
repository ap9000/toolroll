/**
 * Mixed outcomes under recorded conditions (docs/plans/learning-loops.md, "Flaky tests"): advisory only. Nothing here
 * changes a check's outcome, a verdict, an approval or a rerun; rerunning stays a person's `task regate`.
 *
 * Observations are written here, in the transaction that records a check's results (recordObservations). Each adds a
 * tracked identity (`learning_watch`, reason `observation`): every Full check with a handshake asks about it for 90
 * days (check-facts.ts learnRequestFor). Lesson notes (lesson-notes.ts) add their own. This module and lesson-notes.ts
 * are the only writers of `learning_watch`, and this one of `local_observation`; release-auto's learning scan
 * (eval-hooks.ts learningWriteProblem) needs a person for any other. A policy path (release-auto.ts EVAL_POLICY).
 *
 * The list reads only. An infrastructure-class run is never an observation: a run's class is stamped after its check,
 * so recording skips the runs already stamped and every read skips the rest.
 */
import { projectGitDir } from "./check-report.js";
import { verifiedBlobs } from "./commit-extract.js";
import { ciNotPaired, ciRepositoriesOf } from "./flaky-ci.js";
import type { Store } from "./store.js";

/** Track an identity a local observation named (one row per observation; first write wins, never rewritten). */
export function watchObservation(store: Store, input: { repo: string; identity: string; observation: number; now: Date }): boolean {
  if (input.repo.trim() === "" || input.identity.length < 1 || input.identity.length > 2600 || !Number.isSafeInteger(input.observation) || input.observation < 1) {
    throw new Error("a tracked identity needs its project, a bounded identity and the observation that named it");
  }
  const added = store.handle.prepare(`INSERT INTO learning_watch (repo, identity, reason, source_ref, since, until) VALUES (?, ?, 'observation', ?, ?, NULL)
    ON CONFLICT (repo, identity, reason, source_ref) DO NOTHING`).run(input.repo, input.identity, `observation:${input.observation}`, input.now.toISOString());
  return Number(added.changes) === 1;
}

// ---- local observations --------------------------------------------------------------------------------------------

/** How far back the list looks, how long the pruned rows are kept, and how many runs clear a row (the plan's defaults). */
export const FLAKY_WINDOW_DAYS = 90;
export const FLAKY_RETAIN_DAYS = 180;
export const FLAKY_CLEAR_RUNS = 20;
const DAY_MS = 86_400_000;
/** Twin checks one settled check is compared with, observations it writes, and rows the list and a history read. */
const TWINS_MAX = 50;
const OBSERVED_MAX = 500;
const ROWS_MAX = 200;
const HISTORY_MAX = 100;
/** Distinct trees one read of the list opens: past this, the rest of a row's status stays "mixed outcomes". */
const TREES_MAX = 40;

/** What can be observed at all: a test case, a journey or its group, or a file, never `part:`, `upgrade:`, `check` or
 * `unexplained`, and never a real-model journey (a model's behaviour isn't a test's flakiness). */
export function observableIdentity(identity: string): boolean {
  if (/^(?:journey|group):[^:]*:real(?::|$)/.test(identity)) return false;
  return /^(?:unit|journey|group|file):./.test(identity);
}
const fileLevel = (identity: string): boolean => identity.startsWith("file:");
/** The explicit sources (docs/plans/learning-loops.md, "Explicit execution evidence"). */
const EXPLICIT = "('report','learn')";

/** A tree's facts as comparisons need them, or null (nothing comparable was recorded). */
function comparableFact(store: Store, runId: number): { repo: string; taskRef: number; head: string | null; tree: string; commandDigest: string | null; access: string | null; harness: string | null; digest: string; purpose: string } | null {
  const row = store.handle.prepare("SELECT repo, task_ref, head, tree, command_digest, access, harness_digest, conditions_digest, purpose FROM check_fact WHERE run = ?").get(runId);
  if (row === undefined || row["repo"] == null || row["tree"] == null || row["conditions_digest"] == null) return null;
  const text = (key: string): string | null => row[key] == null ? null : String(row[key]);
  return { repo: String(row["repo"]), taskRef: Number(row["task_ref"]), head: text("head"), tree: String(row["tree"]), commandDigest: text("command_digest"), access: text("access"), harness: text("harness_digest"), digest: String(row["conditions_digest"]), purpose: String(row["purpose"]) };
}
const infrastructure = (store: Store, runId: number): boolean => store.handle.prepare("SELECT 1 FROM run WHERE id = ? AND exec_class = 'infrastructure'").get(runId) !== undefined;

/**
 * Every observation one settled check adds, in the transaction that records its results (check-facts.ts): an in-check
 * retry, and each identity that failed in one check and explicitly passed in another with equal tree, command, access,
 * harness and conditions. A `file:` identity is observed only as "failed, then the whole check passed", and only when
 * no case in that file names the failure. Idempotent: racing dispositions on one pair leave one row.
 */
export function recordObservations(store: Store, runId: number, now: Date): number[] {
  const fact = comparableFact(store, runId);
  if (fact === null || infrastructure(store, runId)) return [];
  const at = now.toISOString();
  const added: number[] = [];
  const insert = store.handle.prepare(`INSERT INTO local_observation (repo, identity, failed_run, passed_run, tree, conditions_digest, kind, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (identity, failed_run, passed_run) DO NOTHING`);
  const observe = (identity: string, failed: number, passed: number, kind: "regate" | "same-tree" | "in-check-retry"): void => {
    if (added.length >= OBSERVED_MAX || !observableIdentity(identity)) return;
    const done = insert.run(fact.repo, identity, failed, passed, fact.tree, fact.digest, kind, at);
    if (Number(done.changes) !== 1) return;
    const id = Number(done.lastInsertRowid);
    added.push(id);
    watchObservation(store, { repo: fact.repo, identity, observation: id, now });
  };
  // A nightly's in-run reruns are never observations; a retry inside any other check is.
  if (fact.purpose !== "nightly") {
    for (const row of store.handle.prepare(`SELECT DISTINCT identity FROM check_result WHERE run = ? AND state = 'passed-on-retry' AND source IN ${EXPLICIT}`).all(runId)) {
      const identity = String(row["identity"]);
      if (!fileLevel(identity)) observe(identity, runId, runId, "in-check-retry");
    }
  }
  const twins = store.handle.prepare(`SELECT f.run, f.task_ref, f.head FROM check_fact f JOIN run r ON r.id = f.run
    WHERE f.repo = ? AND f.tree = ? AND f.conditions_digest = ? AND f.command_digest IS ? AND f.access IS ? AND f.harness_digest IS ? AND f.run <> ?
      AND (r.exec_class IS NULL OR r.exec_class <> 'infrastructure') ORDER BY f.run DESC LIMIT ?`).all(fact.repo, fact.tree, fact.digest, fact.commandDigest, fact.access, fact.harness, runId, TWINS_MAX);
  const mixed = store.handle.prepare(`SELECT DISTINCT a.identity FROM check_result a JOIN check_result b ON b.identity = a.identity AND b.run = ? AND b.state = 'passed' AND b.source IN ${EXPLICIT}
    WHERE a.run = ? AND a.state = 'failed' AND a.source IN ${EXPLICIT}`);
  const received = (run: number, state: string): boolean => store.handle.prepare("SELECT 1 FROM check_result WHERE run = ? AND identity = 'check' AND source = 'receipt' AND state = ?").get(run, state) !== undefined;
  for (const twin of twins) {
    const other = Number(twin["run"]);
    const kind = Number(twin["task_ref"]) === fact.taskRef && (twin["head"] == null ? null : String(twin["head"])) === fact.head ? "regate" as const : "same-tree" as const;
    for (const row of mixed.all(runId, other)) observe(String(row["identity"]), other, runId, kind);
    for (const row of mixed.all(other, runId)) observe(String(row["identity"]), runId, other, kind);
    // File level: an earlier check failed in the file, this later one passed whole.
    if (other < runId && received(runId, "passed") && received(other, "failed")) {
      const failed = store.handle.prepare("SELECT identity, source FROM check_result WHERE run = ? AND state = 'failed'").all(other).map(row => String(row["identity"]));
      for (const identity of new Set(failed.filter(fileLevel))) {
        const prefix = `unit:${identity.slice("file:".length)}::`;
        if (!failed.some(one => one.startsWith(prefix))) observe(identity, other, runId, kind);
      }
    }
  }
  return added;
}

/** The storage sweep's own step: observations older than the retention window go; nothing else deletes them. */
export function pruneObservations(store: Store, now: Date): number {
  const cut = new Date(now.getTime() - FLAKY_RETAIN_DAYS * DAY_MS).toISOString();
  return Number(store.handle.prepare("DELETE FROM local_observation WHERE observed_at < ?").run(cut).changes);
}

// ---- the list ------------------------------------------------------------------------------------------------------

export type FlakyStatus = "mixed outcomes" | "no failures since its file changed" | "not enough recorded history";
export type FlakyRow = {
  /** The stable handle `flaky show` takes: the identity, or `github:<lane>`. */
  key: string;
  kind: "test" | "file" | "lane";
  /** What the row says, as recorded: untrusted test text, escaped wherever it's shown. */
  name: string;
  observations: number;
  lastSeen: string;
  /** `<platform>-<arch>-node<major>`, or GitHub for a lane. */
  conditions: string[];
  /** Failures under recorded conditions that have no recorded pass. */
  hardFailures: number;
  sources: string[];
  /** When the test's file last changed, as far as the recorded checks show; null when they don't. */
  fileChanged: string | null;
  status: FlakyStatus;
};
export type FlakyList = { repo: string; days: number; rows: FlakyRow[];
  /** False when the window reaches past what is kept, so a count there could be short. */
  complete: boolean;
  /** CI pairings refused, and how many checks in the window had no per-test reporting. */
  notPaired: number; unreported: number; reported: number };
export type FlakyObservation = { kind: "regate" | "same-tree" | "in-check-retry" | "github"; at: string; failed: string; passed: string; commit: string | null; conditions: string };

/** The test file an identity names, when it names one. */
export function identityFile(identity: string): string | null {
  const unit = /^unit:(.+?)::/.exec(identity);
  if (unit !== null) return unit[1]!;
  return identity.startsWith("file:") ? identity.slice("file:".length) : null;
}
/** A readable name: `<file> › <test>`; a journey's group and name; a file with its limit said. */
export function identityWords(identity: string): string {
  const unit = /^unit:(.+?)::(.*)$/s.exec(identity);
  if (unit !== null) return `${unit[1]} › ${unit[2]}`;
  const journey = /^journey:([^:]*):([^:]*):(.+?)::(.*)$/s.exec(identity);
  if (journey !== null) return `${journey[1]} journey ${journey[3]} › ${journey[4]}`;
  const group = /^group:([^:]*):([^:]*):(.*)$/s.exec(identity);
  if (group !== null) return `${group[1]} journeys ${group[3]}`;
  return fileLevel(identity) ? `${identity.slice("file:".length)} (file-level, not confirmed per test)` : identity;
}
const SOURCE_WORDS: Readonly<Record<string, string>> = { report: "Test report", learn: "Test report", log: "Check log", receipt: "Check result" };

/** Whether results older than the kept window were pruned for this project. */
function prunedBefore(store: Store, repo: string, now: Date): boolean {
  const cut = new Date(now.getTime() - FLAKY_RETAIN_DAYS * DAY_MS).toISOString();
  return store.handle.prepare("SELECT 1 FROM check_fact WHERE repo = ? AND recorded_at < ? LIMIT 1").get(repo, cut) !== undefined;
}

/** Each tree's blob ids for the given files, read through verified objects, once per tree, within a budget. */
function blobReader(repo: string, files: readonly string[]): (tree: string, file: string) => string | null | undefined {
  const gitDir = projectGitDir(repo);
  const seen = new Map<string, Map<string, string> | null>();
  return (tree, file) => {
    if (gitDir === null) return undefined;
    let read = seen.get(tree);
    if (read === undefined) {
      if (seen.size >= TREES_MAX) return undefined;
      try {
        const blobs = verifiedBlobs(gitDir, tree, files);
        read = blobs.ok ? new Map([...blobs.value].map(([path, one]) => [path, one.id])) : null;
      } catch { read = null; }
      seen.set(tree, read);
    }
    return read === null ? undefined : read.get(file) ?? null;
  };
}

/** What a row's recorded runs say since its file changed. `undefined` from the reader means a tree couldn't be read:
 * the walk stops there and claims nothing. */
function statusOf(store: Store, repo: string, identity: string, blobAt: ReturnType<typeof blobReader>, pruned: boolean): { status: FlakyStatus; fileChanged: string | null } {
  const file = identityFile(identity);
  if (file === null || fileLevel(identity)) return { status: "mixed outcomes", fileChanged: null };
  const rows = store.handle.prepare(`SELECT f.run, f.tree, f.recorded_at, MAX(CASE WHEN r.state IN ('failed','passed-on-retry') THEN 1 ELSE 0 END) AS failed, MAX(CASE WHEN r.state = 'passed' THEN 1 ELSE 0 END) AS passed
    FROM check_result r JOIN check_fact f ON f.run = r.run WHERE f.repo = ? AND r.identity = ? AND r.source IN ${EXPLICIT} AND f.tree IS NOT NULL GROUP BY f.run ORDER BY f.run DESC LIMIT 200`).all(repo, identity);
  if (rows.length === 0) return { status: "mixed outcomes", fileChanged: null };
  const newest = blobAt(String(rows[0]!["tree"]), file);
  if (newest === undefined) return { status: "mixed outcomes", fileChanged: null };
  let clean = 0, boundary = false, failedSince = false, earliest: string | null = null;
  for (const row of rows) {
    const here = blobAt(String(row["tree"]), file);
    if (here === undefined) return { status: "mixed outcomes", fileChanged: null };
    if (here !== newest) { boundary = true; break; }
    earliest = String(row["recorded_at"]);
    if (Number(row["failed"]) === 1) { failedSince = true; continue; }
    if (Number(row["passed"]) === 1) clean++;
  }
  const fileChanged = boundary ? earliest : null;
  if (failedSince) return { status: "mixed outcomes", fileChanged };
  if (clean >= FLAKY_CLEAR_RUNS) return { status: "no failures since its file changed", fileChanged };
  // Too few passes, and the file's change is older than the results kept: there's no telling, and no zero is shown.
  return { status: !boundary && pruned ? "not enough recorded history" : "mixed outcomes", fileChanged };
}

/** Every row for a project: reads only. `days` past the kept window is answered with `complete: false`, never a zero. */
export function flakyList(store: Store, repo: string, now: Date, days: number = FLAKY_WINDOW_DAYS): FlakyList {
  const span = Number.isSafeInteger(days) && days >= 1 && days <= 730 ? days : FLAKY_WINDOW_DAYS;
  const since = new Date(now.getTime() - span * DAY_MS).toISOString();
  const pruned = prunedBefore(store, repo, now);
  const rows = store.handle.prepare(`SELECT o.identity, COUNT(DISTINCT o.tree || ':' || o.conditions_digest) AS observations, MAX(o.observed_at) AS last_seen
    FROM local_observation o JOIN run a ON a.id = o.failed_run JOIN run b ON b.id = o.passed_run
    WHERE o.repo = ? AND o.observed_at >= ? AND (a.exec_class IS NULL OR a.exec_class <> 'infrastructure') AND (b.exec_class IS NULL OR b.exec_class <> 'infrastructure')
    GROUP BY o.identity ORDER BY last_seen DESC, o.identity LIMIT ?`).all(repo, since, ROWS_MAX);
  const identities = rows.map(row => String(row["identity"]));
  const blobAt = blobReader(repo, [...new Set(identities.flatMap(one => identityFile(one) ?? []))]);
  const local: FlakyRow[] = rows.map(row => {
    const identity = String(row["identity"]);
    const conditions = store.handle.prepare(`SELECT DISTINCT f.conditions_class FROM local_observation o JOIN check_fact f ON f.run = o.failed_run WHERE o.repo = ? AND o.identity = ? AND o.observed_at >= ? AND f.conditions_class IS NOT NULL ORDER BY 1`).all(repo, identity, since).map(one => String(one["conditions_class"]));
    const sources = store.handle.prepare(`SELECT DISTINCT r.source FROM local_observation o JOIN check_result r ON r.identity = o.identity AND r.run IN (o.failed_run, o.passed_run) WHERE o.repo = ? AND o.identity = ? AND o.observed_at >= ? ORDER BY 1`).all(repo, identity, since).map(one => SOURCE_WORDS[String(one["source"])] ?? String(one["source"]));
    const hard = store.handle.prepare(`SELECT COUNT(DISTINCT r.run) AS n FROM check_result r JOIN check_fact f ON f.run = r.run WHERE f.repo = ? AND r.identity = ? AND r.state = 'failed' AND f.recorded_at >= ? AND f.tree IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM check_result p JOIN check_fact g ON g.run = p.run WHERE p.identity = r.identity AND p.state IN ('passed','passed-on-retry') AND g.repo = f.repo AND g.tree = f.tree AND g.conditions_digest = f.conditions_digest)`).get(repo, identity, since);
    const read = statusOf(store, repo, identity, blobAt, pruned);
    return { key: identity, kind: fileLevel(identity) ? "file" : "test", name: identityWords(identity), observations: Number(row["observations"]), lastSeen: String(row["last_seen"]),
      conditions, hardFailures: Number(hard?.["n"] ?? 0), sources: [...new Set(sources)], fileChanged: read.fileChanged, status: read.status };
  });
  const lanes = store.handle.prepare(`SELECT lane_id, MAX(lane_name) AS lane_name, COUNT(*) AS observations, MAX(observed_at) AS last_seen FROM ci_flaky_observation WHERE repo = ? AND observed_at >= ? GROUP BY lane_id ORDER BY last_seen DESC, lane_id LIMIT ?`).all(repo, since, ROWS_MAX);
  const ci: FlakyRow[] = lanes.map(row => ({ key: `github:${String(row["lane_id"])}`, kind: "lane", name: `${String(row["lane_name"])} (GitHub CI)`, observations: Number(row["observations"]), lastSeen: String(row["last_seen"]),
    conditions: ["GitHub CI"], hardFailures: 0, sources: ["GitHub"], fileChanged: null, status: "mixed outcomes" }));
  const checks = store.handle.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN EXISTS (SELECT 1 FROM check_result r WHERE r.run = f.run AND r.source IN ('report','learn')) THEN 1 ELSE 0 END) AS reported FROM check_fact f WHERE f.repo = ? AND f.recorded_at >= ?").get(repo, since);
  return { repo, days: span, rows: [...local, ...ci].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.key.localeCompare(b.key)),
    complete: !(span > FLAKY_RETAIN_DAYS && pruned), notPaired: ciNotPaired(store, ciRepositoriesOf(store, repo), since), reported: Number(checks?.["reported"] ?? 0), unreported: Number(checks?.["n"] ?? 0) - Number(checks?.["reported"] ?? 0) };
}

/** One row's history, newest first: each observation with both checks (or the CI run and attempts). Null: no such row. */
export function flakyShow(store: Store, repo: string, key: string, now: Date, days: number = FLAKY_RETAIN_DAYS): { row: FlakyRow; history: FlakyObservation[]; fix: { title: string; goal: string } } | null {
  const row = flakyList(store, repo, now, Math.max(days, FLAKY_WINDOW_DAYS)).rows.find(one => one.key === key);
  if (row === undefined) return null;
  const history: FlakyObservation[] = row.kind === "lane"
    ? store.handle.prepare(`SELECT workflow_run_id, head_sha, failed_attempt, failed_conclusion, passed_attempt, passed_conclusion, observed_at FROM ci_flaky_observation WHERE repo = ? AND lane_id = ? ORDER BY observed_at DESC, id DESC LIMIT ?`)
      .all(repo, key.slice("github:".length), HISTORY_MAX).map(one => ({ kind: "github" as const, at: String(one["observed_at"]), failed: `GitHub #${String(one["workflow_run_id"])} try ${String(one["failed_attempt"])}`,
        passed: `try ${String(one["passed_attempt"])}`, commit: String(one["head_sha"]).slice(0, 7), conditions: "GitHub CI" }))
    : store.handle.prepare(`SELECT o.kind, o.failed_run, o.passed_run, o.observed_at, f.head, f.conditions_class FROM local_observation o LEFT JOIN check_fact f ON f.run = o.failed_run WHERE o.repo = ? AND o.identity = ? ORDER BY o.observed_at DESC, o.id DESC LIMIT ?`)
      .all(repo, key, HISTORY_MAX).map(one => ({ kind: String(one["kind"]) as FlakyObservation["kind"], at: String(one["observed_at"]), failed: `build #${String(one["failed_run"])}`, passed: `build #${String(one["passed_run"])}`,
        commit: one["head"] == null ? null : String(one["head"]).slice(0, 7), conditions: one["conditions_class"] == null ? "not recorded" : String(one["conditions_class"]) }));
  return { row, history, fix: fixTaskOf(row) };
}

/** The ordinary task "Make a task to fix it" files; a person approves it as usual. Never to skip or delete the test. */
export function fixTaskOf(row: Pick<FlakyRow, "key" | "name" | "observations" | "conditions" | "kind">): { title: string; goal: string } {
  // eslint-disable-next-line no-control-regex
  const name = row.name.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
  const short = name.length > 72 ? `${name.slice(0, 71)}…` : name;
  return { title: `Make this test reliable: ${short}`, goal: [
    `Toolroll recorded mixed outcomes under recorded conditions for ${name}: ${row.observations} time${row.observations === 1 ? "" : "s"} it both failed and passed with the same code, command and recorded environment (${row.conditions.join(", ") || "not recorded"}).`,
    row.kind === "lane" ? "It is a GitHub CI job, so the failing test isn't named: read that job's log to find it." : "",
    "Find out why and make the test reliable. Never skip, delete or loosen the test, and don't add retries to hide it.",
  ].filter(Boolean).join(" ") };
}
