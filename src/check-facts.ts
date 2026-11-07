/**
 * Check facts (docs/plans/learning-loops.md, "Foundation: check facts"): what each settled check ran under and what it
 * reported, recorded at disposition, never trusted for authority. The only writer of `check_fact` and `check_result`
 * (the v149 migration aside); release-auto's learning scan (eval-hooks.ts learningWriteProblem) needs a person for
 * SQL that writes them from anywhere else. A policy path (release-auto.ts EVAL_POLICY): any change needs a person.
 *
 * - Conditions are captured when the check's command starts (captureCheckConditions, called from the builder's
 *   runVerification), held in memory and passed here: the commit's tree read through verified objects (never the
 *   checkout), the approved command's digest, the check's access, the harness digest and lockfile, and the values of
 *   every environment variable the check inherits (the setup allowlist), hashed with checkContextOf's fields as
 *   `conditions_digest`. Not re-read later.
 * - Results are tagged by source: `receipt` (the plane's own whole-check result: trusted for "the check passed or
 *   failed", nothing finer), `report` (the candidate-written report's lines), `log` (Vitest's FAIL lines in the sealed
 *   log, failures only, file level) and `learn` (the advisory learning line). Every failure is recorded; the check's
 *   blocking failure is the check's and is never changed here.
 * - Explicit execution evidence is a `report` or `learn` line naming an identity. No line is no evidence: never
 *   skipped, removed or passed.
 * - Fail closed: an unreadable tree, or conditions never captured (the command never started), records the fact row
 *   with no conditions and no results at all.
 *
 * Nothing here changes a check's outcome, a verdict, an approval or a rerun: every reader of a check's outcome reads
 * the receipt and run_check, which this module never writes.
 */
import { createHash } from "node:crypto";
import { failingTestsOf } from "./gate-failure.js";
import { checkContextOf, projectGitDir, treeFactsOf } from "./check-report.js";
import { readVerifiedArtifact } from "./evidence.js";
import { recordObservations } from "./flaky.js";
import { CHECK_REPORT_PREFIX, isExactCase, learnLineSchema, learnRequest, LEARN_MAX_BYTES, LEARN_PREFIX, type CheckReport } from "./contracts/release-check.js";
import { nightlyTaskRef, releaseTaskRef, type Store, type VerifyCommand } from "./store.js";

/** The sources a result can come from, and the states it can have. */
export const CHECK_RESULT_SOURCES = Object.freeze(["receipt", "report", "log", "learn"] as const);
export type CheckResultSource = typeof CHECK_RESULT_SOURCES[number];
export type CheckResultState = "failed" | "passed" | "skipped" | "passed-on-retry";
/** The receipt's whole-check identity, and the one a failed check with nothing else named records. */
export const WHOLE_CHECK = "check";
export const UNEXPLAINED = "unexplained";
/** How many result rows one check records at most (a report's own bounds are far above any real check). */
export const MAX_RESULTS_PER_CHECK = 20_000;
/** How old a tracked observation may be and still be asked about (docs/plans/learning-loops.md, 90-day window). */
export const OBSERVATION_WATCH_MS = 90 * 24 * 60 * 60 * 1000;
/** How long per-identity results are kept (docs/plans/learning-loops.md, "Per table"). */
const RESULT_RETAIN_MS = 180 * 24 * 60 * 60 * 1000;

/** What a check ran under, captured when its command started. `tree` null: its commit couldn't be read from verified
 * objects, and nothing about the check is comparable. */
export type CheckConditions = {
  head: string;
  tree: string | null;
  commandDigest: string;
  access: string;
  harnessDigest: string | null;
  lockfile: string | null;
  conditionsDigest: string | null;
  conditionsClass: string | null;
  problem: string | null;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * The conditions a check's command starts under: its commit's verified tree facts, the approved command's digest, its
 * access, and the values of `envNames` (the variables the check inherits, builder.ts SETUP_ENV_ALLOWLIST) as this
 * process holds them now — what the command is given. Hashed with checkContextOf's fields; the class reads
 * `<platform>-<arch>-node<major>`. Values are hashed, never stored.
 */
export function captureCheckConditions(input: { repo: string | null; head: string; command: VerifyCommand; access: string; envNames: readonly string[]; env?: NodeJS.ProcessEnv }): CheckConditions {
  const none = (problem: string): CheckConditions => ({ head: input.head, tree: null, commandDigest: input.command.digest, access: input.access, harnessDigest: null, lockfile: null, conditionsDigest: null, conditionsClass: null, problem });
  if (input.repo === null) return none("the check's project isn't recorded");
  const gitDir = projectGitDir(input.repo);
  if (gitDir === null) return none("the project's Git directory can't be read");
  let read: ReturnType<typeof treeFactsOf>;
  // Advisory: whatever happens reading the tree, the check itself is never stopped by it.
  try { read = treeFactsOf(gitDir, input.head); } catch (error) { return none(`the checked commit can't be read from verified objects (${error instanceof Error ? error.message : String(error)})`); }
  if (!read.ok) return none(`the checked commit can't be read from verified objects (${read.problem})`);
  const context = checkContextOf(read.facts, input.command, input.access);
  const env = input.env ?? process.env;
  const environment = Object.fromEntries([...new Set(input.envNames)].sort().map(name => [name, env[name] ?? null]));
  const digest = sha256(JSON.stringify({ version: 1, context, environment }));
  const major = /^v?(\d+)/.exec(context.node)?.[1] ?? "unknown";
  return { head: input.head, tree: read.facts.tree, commandDigest: input.command.digest, access: input.access, harnessDigest: read.facts.harnessDigest, lockfile: read.facts.lockfile,
    conditionsDigest: digest, conditionsClass: `${context.platform}-${context.arch}-node${major}`, problem: null };
}

/** Why the task's check ran: a release's or the nightly's purpose, read from the plane's own records. */
export function checkPurposeOf(store: Store, taskRef: number): "release" | "nightly" | "ordinary" {
  if (nightlyTaskRef(store, taskRef)) return "nightly";
  if (releaseTaskRef(store, taskRef)) return "release";
  const terms = store.handle.prepare(`SELECT s.release_terms_json, s.release_check_json FROM task_scope s JOIN task_ref r ON r.external_id = s.task_id AND r.backend = 'built-in' WHERE r.id = ?`).get(taskRef);
  return terms !== undefined && (terms["release_terms_json"] != null || terms["release_check_json"] != null) ? "release" : "ordinary";
}

/** The advisory learning line of a check's output, read strictly: exactly one line carrying this run's nonce, at most
 * 64 KiB, before the report, matching its contract, naming only requested exact cases, each once. Anything else is
 * not recorded, with why; that loses learning evidence only. */
export function learningLinesOf(stdout: string, nonce: string, asked: readonly string[]):
  { ok: true; results: { identity: string; state: "passed" | "failed" | "skipped" }[] } | { ok: false; why: string } {
  const lines = stdout.split("\n");
  let reportAt = -1;
  for (let at = lines.length - 1; at >= 0; at--) if (lines[at]!.startsWith(CHECK_REPORT_PREFIX)) { reportAt = at; break; }
  const ours: { at: number; value: unknown }[] = [];
  let oversized = false, others = false, unreadable = false;
  lines.forEach((line, at) => {
    if (!line.startsWith(LEARN_PREFIX)) return;
    if (Buffer.byteLength(line) > LEARN_MAX_BYTES) { oversized = true; return; }
    let value: unknown;
    try { value = JSON.parse(line.slice(LEARN_PREFIX.length)); } catch { unreadable = true; return; }
    if (value === null || typeof value !== "object" || (value as Record<string, unknown>)["nonce"] !== nonce) { others = true; return; }
    ours.push({ at, value });
  });
  if (ours.length === 0) return { ok: false, why: oversized ? "the learning line was over 64 KiB" : unreadable ? "the learning line couldn't be read" : others ? "no learning line carried this run's nonce" : "the check printed no learning line" };
  if (ours.length > 1) return { ok: false, why: "the check printed more than one learning line" };
  if (oversized) return { ok: false, why: "a learning line was over 64 KiB" };
  const only = ours[0]!;
  if (reportAt >= 0 && only.at > reportAt) return { ok: false, why: "the learning line came after the report" };
  const read = learnLineSchema.safeParse(only.value);
  if (!read.success) return { ok: false, why: "the learning line doesn't match its contract" };
  const wanted = new Set(asked);
  const seen = new Set<string>();
  for (const one of read.data.results) {
    if (!wanted.has(one.identity) || !isExactCase(one.identity)) return { ok: false, why: "the learning line named an identity it wasn't asked about" };
    if (seen.has(one.identity)) return { ok: false, why: "the learning line named an identity twice" };
    seen.add(one.identity);
  }
  return { ok: true, results: read.data.results };
}

type Row = { identity: string; state: CheckResultState; source: CheckResultSource };
const RANK: Record<CheckResultState, number> = { passed: 0, skipped: 1, "passed-on-retry": 2, failed: 3 };

/** The report's lines as results: every case it names; a file, group, version or part only when it didn't simply pass. */
export function reportResults(report: CheckReport): Row[] {
  const rows: Row[] = [];
  const add = (identity: string, state: CheckResultState) => rows.push({ identity, state, source: "report" });
  for (const one of report.units?.identities ?? []) add(`unit:${one.file}::${one.name}`, one.state === "passed" && one.flaky ? "passed-on-retry" : one.state);
  for (const one of report.units?.files ?? []) {
    if (one.state !== "passed") add(`file:${one.file}`, one.state);
    else if (one.flaky) add(`file:${one.file}`, "passed-on-retry");
  }
  for (const run of report.journeys) for (const group of run.groups) {
    if (group.state === "failed") add(`group:${run.script}:${run.kind}:${group.group}`, "failed");
    else if (group.state === "passed" && group.retried) add(`group:${run.script}:${run.kind}:${group.group}`, "passed-on-retry");
    if (group.state === "not-run") continue;
    for (const journey of group.journeys) add(`journey:${run.script}:${run.kind}:${group.group}::${journey.name}`, journey.state === "passed" && group.retried ? "passed-on-retry" : journey.state);
  }
  for (const one of report.upgrades?.versions ?? []) if (one.state === "failed") add(`upgrade:${one.version}`, "failed");
  for (const part of report.parts) if (part.selected && part.ran && (part.code !== 0 || part.timedOut)) add(`part:${part.part}`, "failed");
  return rows;
}

/** The sealed log's FAIL lines (Vitest), failures only, file level; nothing when the log's own count disagrees. */
function logResults(store: Store, root: string, runId: number): Row[] {
  const logs = store.artifactsFor(runId).filter(one => one.kind === "check-log");
  if (logs.length !== 1) return [];
  const read = readVerifiedArtifact(root, logs[0]!);
  if (!read.ok) return [];
  const failing = failingTestsOf(read.content.toString("utf8")) ?? [];
  return failing.filter(one => /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\u0000-\u001f\\]{1,512}$/.test(one.file)).map(one => ({ identity: `file:${one.file}`, state: "failed" as const, source: "log" as const }));
}

export type CheckFactsInput = {
  runId: number;
  taskRef: number;
  repo: string | null;
  /** Captured when the command started; null when no command started (nothing comparable was run). */
  conditions: CheckConditions | null;
  /** What the plane recorded as the check's own outcome (run_check), unchanged. */
  receipt: { status: "passed" | "failed" | "not-run" };
  /** The sealed report, when the check gave a valid one. */
  report: CheckReport | null;
  /** The check's handshake facts, when it had one: its nonce and what it was asked about for learning. */
  attempt: { nonce: string; learn: readonly string[] } | null;
  /** The check's final command output, for the learning line (the same bytes the report was read from). */
  stdout: string | null;
  now: Date;
};

/**
 * Record what a settled check ran under and reported, once (first write wins), in one transaction: its fact row and
 * every result row. Called at disposition by the builder right after it records the check's own outcome. Advisory:
 * nothing reads these for a verdict, a rerun or an approval.
 */
export function recordCheckFacts(store: Store, root: string, input: CheckFactsInput): void {
  const conditions = input.conditions;
  const comparable = conditions !== null && conditions.tree !== null && conditions.conditionsDigest !== null;
  const asked = input.attempt === null ? [] : learnRequest(input.attempt.learn);
  let learnState: "recorded" | "not-recorded" | "not-asked" = asked.length === 0 ? "not-asked" : "not-recorded";
  let learnWhy: string | null = null;
  const rows: Row[] = [];
  if (comparable) {
    if (input.receipt.status !== "not-run") rows.push({ identity: WHOLE_CHECK, state: input.receipt.status, source: "receipt" });
    if (input.report !== null) rows.push(...reportResults(input.report));
    rows.push(...logResults(store, root, input.runId));
  }
  if (asked.length > 0) {
    if (!comparable) learnWhy = conditions === null ? "the check's command never started" : conditions.problem ?? "the check's conditions weren't recorded";
    else if (input.stdout === null || input.attempt === null) learnWhy = "the check's output wasn't kept";
    else {
      const learned = learningLinesOf(input.stdout, input.attempt.nonce, asked);
      if (!learned.ok) learnWhy = learned.why;
      else { learnState = "recorded"; for (const one of learned.results) rows.push({ identity: one.identity, state: one.state, source: "learn" }); }
    }
  }
  if (comparable && input.receipt.status === "failed" && !rows.some(one => one.source !== "receipt" && one.state === "failed")) rows.push({ identity: UNEXPLAINED, state: "failed", source: "receipt" });
  // One row per (identity, source), its worst state; bounded.
  const kept = new Map<string, Row>();
  for (const row of rows) {
    if (row.identity.length < 1 || row.identity.length > 2600) continue;
    const key = `${row.source}\u0000${row.identity}`;
    const before = kept.get(key);
    if (before === undefined || RANK[row.state] > RANK[before.state]) kept.set(key, row);
  }
  const at = input.now.toISOString();
  store.transact(() => {
    const inserted = store.handle.prepare(`INSERT INTO check_fact (run, repo, task_ref, head, tree, command_digest, access, harness_digest, lockfile, conditions_digest,
        conditions_class, purpose, learn_state, learn_why, recorded_at) SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM run WHERE id = ?
      ON CONFLICT (run) DO NOTHING`).run(input.repo, input.taskRef, conditions?.head ?? null, comparable ? conditions.tree : null, conditions?.commandDigest ?? null,
      conditions?.access ?? null, comparable ? conditions.harnessDigest : null, comparable ? conditions.lockfile : null, comparable ? conditions.conditionsDigest : null,
      comparable ? conditions.conditionsClass : null, checkPurposeOf(store, input.taskRef), learnState, learnState === "not-recorded" ? learnWhy ?? "not recorded" : null, at, input.runId);
    if (Number(inserted.changes) !== 1) return;
    const insert = store.handle.prepare("INSERT INTO check_result (run, identity, state, source, recorded_at) VALUES (?, ?, ?, ?, ?)");
    for (const row of [...kept.values()].slice(0, MAX_RESULTS_PER_CHECK)) insert.run(input.runId, row.identity, row.state, row.source, at);
    // In the same transaction: what this check adds to the flaky-test list, advisory like everything here.
    recordObservations(store, input.runId, input.now);
  });
}

/** The storage sweep's own step: results older than the retention window go; their fact rows stay. */
export function pruneCheckResults(store: Store, now: Date): number {
  const cut = new Date(now.getTime() - RESULT_RETAIN_MS).toISOString();
  return Number(store.handle.prepare("DELETE FROM check_result WHERE recorded_at < ?").run(cut).changes);
}

/** A check's recorded facts, or null. */
export type CheckFact = {
  run: number; repo: string | null; taskRef: number; head: string | null; tree: string | null; commandDigest: string | null; access: string | null;
  harnessDigest: string | null; lockfile: string | null; conditionsDigest: string | null; conditionsClass: string | null;
  purpose: "release" | "nightly" | "ordinary"; learnState: "recorded" | "not-recorded" | "not-asked"; learnWhy: string | null; recordedAt: string;
};
export function checkFactOf(store: Store, runId: number): CheckFact | null {
  const row = store.handle.prepare("SELECT * FROM check_fact WHERE run = ?").get(runId);
  if (row === undefined) return null;
  const text = (key: string) => row[key] === null ? null : String(row[key]);
  return { run: Number(row["run"]), repo: text("repo"), taskRef: Number(row["task_ref"]), head: text("head"), tree: text("tree"), commandDigest: text("command_digest"), access: text("access"),
    harnessDigest: text("harness_digest"), lockfile: text("lockfile"), conditionsDigest: text("conditions_digest"), conditionsClass: text("conditions_class"),
    purpose: String(row["purpose"]) as CheckFact["purpose"], learnState: String(row["learn_state"]) as CheckFact["learnState"], learnWhy: text("learn_why"), recordedAt: String(row["recorded_at"]) };
}
/** A check's recorded results, by source then identity. */
export function checkResultsOf(store: Store, runId: number): { identity: string; state: CheckResultState; source: CheckResultSource }[] {
  return store.handle.prepare("SELECT identity, state, source FROM check_result WHERE run = ? ORDER BY source, identity").all(runId)
    .map(row => ({ identity: String(row["identity"]), state: String(row["state"]) as CheckResultState, source: String(row["source"]) as CheckResultSource }));
}

/**
 * What a project's Full checks are asked about for learning (`learn`): its tracked identities (learning_watch) — an
 * accepted note's until it ends, an observation's for 90 days — exact cases only, the most recently tracked first, at
 * most 200. Those left out are counted (`leftOut`): a coverage gap, said, never hidden.
 */
export function learnRequestFor(store: Store, repo: string, now: Date): { learn: string[]; leftOut: number } {
  const since = new Date(now.getTime() - OBSERVATION_WATCH_MS).toISOString();
  let tracked: string[];
  // Advisory: a read that fails asks about nothing, and the check runs as it would have.
  try { tracked = store.handle.prepare(`SELECT identity, MAX(since) AS latest FROM learning_watch
      WHERE repo = ? AND ((reason = 'note' AND until IS NULL) OR (reason = 'observation' AND since >= ?))
      GROUP BY identity ORDER BY latest DESC, identity`).all(repo, since).map(row => String(row["identity"])).filter(isExactCase); } catch { return { learn: [], leftOut: 0 }; }
  const learn = learnRequest(tracked);
  return { learn, leftOut: tracked.length - learn.length };
}
