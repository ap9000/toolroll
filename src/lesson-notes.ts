/**
 * Lesson notes (docs/plans/learning-loops.md, "Lesson notes"): when a check failure is followed by a revision whose check
 * explicitly passed the same tests, Toolroll proposes a note saying exactly that — "`<test>` failed in build #F; it
 * passed in revision R, which changed `<files>`". Not a claim that R caused it. A person writes or edits the words and
 * accepts it as a project decision through the memory proposal flow (memory-pass.ts decideProposal); nothing changes
 * before that. Then Toolroll reports how often the test fails afterwards, with no causal claim.
 *
 * The rules (all must hold), checked here when R's check is recorded:
 *  1. F is a builder run whose check failed (its own result), not infrastructure, with at least one case that failed
 *     with explicit execution evidence. File-level-only failures get no note.
 *  2. R is a builder run of a revision of F's task, or of F's explicit repair draft, or the next Full check of the same
 *     release; R's commit descends from F's (a verified commit walk).
 *  3. R's check passed with the same command and access as F's.
 *  4. Every failed case of F has an explicit `passed` line in R. F's cases join R's advisory `learn` request (never the
 *     gate's `watch`) so that can be true.
 *  5. No retry-assisted pass: nothing in R passed on a retry.
 *  6. None of those cases has mixed outcomes at F's tree.
 *  7. Otherwise no note, and R's page says exactly what was recorded: an explicit skip, a test file that isn't in R, or
 *     no test result at all. Each has its own words; none is read as another.
 *
 * Tallies are written with each check's results and never pruned, so "since" numbers survive retention. The only writer
 * of `lesson_note` and `lesson_note_tally`, and with flaky.ts of `learning_watch`. A policy path (release-auto.ts
 * EVAL_POLICY). Nothing here changes a check's outcome, a verdict, an approval or a rerun.
 */
import { createHash } from "node:crypto";
import { isUnitFile, projectGitDir } from "./check-report.js";
import { readVerifiedCommit, verifiedBlobs, verifiedTreeDiff } from "./commit-extract.js";
import { isExactCase } from "./contracts/release-check.js";
import { readVerifiedArtifact, scanForSecrets } from "./evidence.js";
import { identityFile, identityWords } from "./flaky.js";
import type { Store } from "./store.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const EXPLICIT = "('report','learn')";
const PATHS_MAX = 200;
const WALK_MAX = 500;
export const NOTE_SURFACE = "lesson-note";
const FINGERPRINT = "note:";
/** How deep a revision's ancestry is followed looking for the failed check. */
const ANCESTRY_MAX = 8;

/** The note behind a proposal, or null: the only thing that marks a `decision-add` as a lesson note. */
export type LessonNote = { proposal: number; repo: string; failedRun: number; passingRun: number; repairChain: number | null; revisionOrigin: string | null; identities: string[]; changedPaths: string[]; testFilesChanged: string[]; factsDigest: string; createdAt: string };
export function lessonNoteOf(store: Store, proposal: number): LessonNote | null {
  const row = store.handle.prepare("SELECT * FROM lesson_note WHERE proposal = ?").get(proposal);
  if (row === undefined) return null;
  return { proposal, repo: String(row["repo"]), failedRun: Number(row["failed_run"]), passingRun: Number(row["passing_run"]), repairChain: row["repair_chain"] == null ? null : Number(row["repair_chain"]), revisionOrigin: row["revision_origin"] == null ? null : String(row["revision_origin"]),
    identities: JSON.parse(String(row["identities_json"])) as string[], changedPaths: JSON.parse(String(row["changed_paths_json"])) as string[], testFilesChanged: JSON.parse(String(row["test_files_changed_json"])) as string[], factsDigest: String(row["facts_digest"]), createdAt: String(row["created_at"]) };
}

type Fact = { run: number; repo: string | null; taskRef: number; head: string | null; tree: string | null; commandDigest: string | null; access: string | null; conditionsClass: string | null; purpose: string };
function factOf(store: Store, run: number): Fact | null {
  const row = store.handle.prepare("SELECT * FROM check_fact WHERE run = ?").get(run);
  if (row === undefined) return null;
  const text = (key: string): string | null => row[key] == null ? null : String(row[key]);
  return { run, repo: text("repo"), taskRef: Number(row["task_ref"]), head: text("head"), tree: text("tree"), commandDigest: text("command_digest"), access: text("access"), conditionsClass: text("conditions_class"), purpose: String(row["purpose"]) };
}
const receiptIs = (store: Store, run: number, state: "failed" | "passed"): boolean => store.handle.prepare("SELECT 1 FROM check_result WHERE run = ? AND identity = 'check' AND source = 'receipt' AND state = ?").get(run, state) !== undefined;
const roleOf = (store: Store, run: number): string | null => { const row = store.handle.prepare("SELECT role FROM run WHERE id = ?").get(run); return row === undefined ? null : String(row["role"]); };

/** The check F a run revises, by the plane's own records: its repair draft's source, the failed check of the nearest
 * ancestor task with one, or the previous check of the same release. Null when it revises none. */
function revisedRun(store: Store, runId: number, taskRef: number, purpose: string | null): { failed: number; chain: number | null; origin: string | null } | null {
  const ref = store.handle.prepare("SELECT external_id, revision_of, revision_origin FROM task_ref WHERE id = ?").get(taskRef);
  if (ref === undefined) return null;
  const origin = ref["revision_origin"] == null ? null : String(ref["revision_origin"]);
  const draft = store.repairChainForDraft(String(ref["external_id"]));
  if (draft !== null) return { failed: draft.sourceRun, chain: draft.id, origin };
  const newestCheck = store.handle.prepare("SELECT f.run FROM check_fact f JOIN run r ON r.id = f.run WHERE f.task_ref = ? AND r.role = 'builder' AND f.run < ? ORDER BY f.run DESC LIMIT 1");
  let cursor = ref["revision_of"] == null ? null : String(ref["revision_of"]);
  for (let depth = 0; cursor !== null && depth < ANCESTRY_MAX; depth++) {
    const parent = store.handle.prepare("SELECT id, revision_of FROM task_ref WHERE backend = 'built-in' AND external_id = ?").get(cursor);
    if (parent === undefined) return null;
    const newest = newestCheck.get(Number(parent["id"]), runId);
    if (newest !== undefined) return receiptIs(store, Number(newest["run"]), "failed") ? { failed: Number(newest["run"]), chain: null, origin } : null;
    cursor = parent["revision_of"] == null ? null : String(parent["revision_of"]);
  }
  if (purpose === "release") {
    const previous = newestCheck.get(taskRef, runId);
    if (previous !== undefined && receiptIs(store, Number(previous["run"]), "failed")) return { failed: Number(previous["run"]), chain: null, origin };
  }
  return null;
}
/** A run's failed cases with explicit execution evidence (the report's lines; file-level names don't count). */
function failedCases(store: Store, run: number): string[] {
  return store.handle.prepare("SELECT DISTINCT identity FROM check_result WHERE run = ? AND state = 'failed' AND source = 'report' ORDER BY identity").all(run).map(row => String(row["identity"])).filter(isExactCase);
}

/**
 * What this run's check should also ask about for learning: the failed cases of the check it revises (rule 4). Advisory:
 * a separate handshake field, never the gate's `watch`. Called before the run's check starts, so its own facts don't
 * exist yet.
 */
export function revisedFailures(store: Store, runId: number): string[] {
  const run = store.handle.prepare("SELECT task_ref, role FROM run WHERE id = ?").get(runId);
  if (run === undefined || run["role"] !== "builder") return [];
  const taskRef = Number(run["task_ref"]);
  const scoped = store.handle.prepare("SELECT purpose FROM check_fact WHERE task_ref = ? ORDER BY run DESC LIMIT 1").get(taskRef);
  const prior = revisedRun(store, runId, taskRef, scoped === undefined ? null : String(scoped["purpose"]));
  return prior === null ? [] : failedCases(store, prior.failed);
}

/** Whether `head` descends from `ancestor`, walking verified commits, bounded. Unreadable is false: no note. */
function descends(gitDir: string, head: string, ancestor: string): boolean {
  if (head === ancestor) return false;
  const seen = new Set<string>(), queue = [head];
  while (queue.length > 0 && seen.size < WALK_MAX) {
    const at = queue.shift()!;
    if (at === ancestor) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    const commit = readVerifiedCommit(gitDir, at);
    if (!commit.ok) return false;
    queue.push(...commit.value.parents);
  }
  return false;
}
/** Test and harness files, as a reader would call them. Every one R changed is listed, never hidden. */
export function testOrHarnessPath(path: string): boolean {
  return isUnitFile(path) || /^(?:tests?|scripts|\.github)\//.test(path) || /(?:^|\/)(?:vitest|jest|playwright)[^/]*\.[a-z]+$/.test(path) || /(?:^|\/)package(?:-lock)?\.json$/.test(path);
}
/** Text from a candidate, made safe to show: one line, clipped, control-free; anything secret-shaped is withheld. */
function safeText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  if (scanForSecrets(line).length > 0) return "(text withheld)";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
/** The first failure line of F's sealed log, as output: clipped, secret-scanned, null when there is none to read. */
function firstFailureLine(store: Store, root: string, run: number): string | null {
  const log = store.artifactsFor(run).find(one => one.kind === "check-log");
  if (log === undefined) return null;
  const read = readVerifiedArtifact(root, log);
  if (!read.ok) return null;
  const line = read.content.toString("utf8").split("\n").find(one => /\b(?:FAIL|AssertionError|Error)\b/.test(one));
  return line === undefined ? null : safeText(line, 160);
}

export type NoteOutcome = { proposal: number } | { none: string };

/**
 * Consider a note for run R, once its check is recorded. Returns what happened; a note that can't be proposed for a
 * reason a person should see says so on R (rule 7). Any unreadable fact means no note.
 */
export function considerLessonNote(store: Store, root: string, runId: number, now: Date): NoteOutcome {
  const passing = factOf(store, runId);
  if (passing === null || passing.repo === null || passing.head === null || passing.tree === null || roleOf(store, runId) !== "builder") return { none: "no comparable check" };
  if (!receiptIs(store, runId, "passed")) return { none: "its check didn't pass" };
  const prior = revisedRun(store, runId, passing.taskRef, passing.purpose);
  if (prior === null) return { none: "it revises no failed check" };
  const failing = factOf(store, prior.failed);
  if (failing === null || failing.repo !== passing.repo || failing.head === null || failing.tree === null) return { none: "the failed check isn't comparable" };
  if (roleOf(store, prior.failed) !== "builder" || !receiptIs(store, prior.failed, "failed")) return { none: "the earlier run isn't a failed build" };
  if (store.handle.prepare("SELECT 1 FROM run WHERE id = ? AND exec_class = 'infrastructure'").get(prior.failed) !== undefined) return { none: "the failure was the machine's" };
  const identities = failedCases(store, prior.failed);
  if (identities.length === 0) return { none: "no failed case has explicit test results" };
  const gitDir = projectGitDir(passing.repo);
  if (gitDir === null || !descends(gitDir, passing.head, failing.head)) return { none: "the revision doesn't descend from the failed commit" };
  if (passing.commandDigest !== failing.commandDigest || passing.access !== failing.access) return { none: "the two checks ran different commands or access" };
  const commit = passing.head.slice(0, 7);
  const said = (text: string): NoteOutcome => { store.addRunNote(runId, "Toolroll", text, now); return { none: text }; };
  const state = store.handle.prepare(`SELECT state FROM check_result WHERE run = ? AND identity = ? AND source IN ${EXPLICIT}`);
  const missing: string[] = [];
  for (const identity of identities) {
    const states = state.all(runId, identity).map(row => String(row["state"]));
    const name = safeText(identityWords(identity), 200);
    if (states.includes("passed-on-retry")) missing.push(`\`${name}\` passed only on a retry in revision ${commit}.`);
    else if (states.includes("passed") && !states.includes("failed")) continue;
    else if (states.includes("skipped")) missing.push(`\`${name}\` was skipped in revision ${commit}.`);
    else {
      const file = identityFile(identity);
      const blobs = file === null ? null : verifiedBlobs(gitDir, passing.tree, [file]);
      if (file !== null && blobs !== null && blobs.ok && !blobs.value.has(file)) missing.push(`The test file \`${safeText(file, 200)}\` is not in revision ${commit}.`);
      else missing.push(`No test result recorded for \`${name}\` in revision ${commit}.`);
    }
  }
  if (missing.length > 0) return said(`No lesson note: ${missing.slice(0, 10).join(" ")}`);
  if (store.handle.prepare("SELECT 1 FROM check_result WHERE run = ? AND state = 'passed-on-retry' LIMIT 1").get(runId) !== undefined) return said(`No lesson note: something in revision ${commit} passed only on a retry.`);
  const mixed = store.handle.prepare("SELECT 1 FROM local_observation WHERE identity IN (SELECT value FROM json_each(?)) AND tree = ? LIMIT 1").get(JSON.stringify(identities), failing.tree);
  if (mixed !== undefined) return said(`No lesson note: the test that failed in build #${prior.failed} has mixed outcomes at that commit.`);
  const before = readVerifiedCommit(gitDir, failing.head), after = readVerifiedCommit(gitDir, passing.head);
  if (!before.ok || !after.ok) return { none: "a commit couldn't be read" };
  const diff = verifiedTreeDiff(gitDir, before.value.tree, after.value.tree);
  if (!diff.ok) return { none: "the change couldn't be read" };
  const changed = diff.value.map(one => one.path).sort();
  const testFiles = changed.filter(testOrHarnessPath);
  const fingerprint = `${FINGERPRINT}${sha(identities.join("\n")).slice(0, 32)}`;
  const quote = firstFailureLine(store, root, prior.failed);
  const names = identities.map(one => safeText(identityWords(one), 200));
  const shown = (paths: readonly string[]): string => `${paths.slice(0, 20).map(one => safeText(one, 200)).join(", ")}${paths.length > 20 ? ` and ${paths.length - 20} more` : ""}`;
  const facts = `${names.map(one => `\`${one}\``).join(", ")} failed in build #${prior.failed} (${failing.head.slice(0, 7)}, ${failing.conditionsClass ?? "conditions not recorded"}). It passed in revision ${commit} (build #${runId}). That revision changed: ${shown(changed) || "nothing readable"}.${testFiles.length === 0 ? "" : ` Tests and harness changed: ${shown(testFiles)}.`}`;
  const draft = safeText(`${names[0]!}${names.length > 1 ? ` and ${names.length - 1} more` : ""} failed in build #${prior.failed} and passed in revision ${commit}.`, 200);
  return store.transact(() => {
    const decided = store.handle.prepare("SELECT 1 FROM memory_rejection WHERE repo = ? AND fingerprint = ?").get(passing.repo, fingerprint) !== undefined
      || store.handle.prepare("SELECT 1 FROM memory_proposal WHERE repo = ? AND fingerprint = ? AND status = 'pending'").get(passing.repo, fingerprint) !== undefined;
    if (decided) return { none: "already proposed or rejected" };
    const at = now.toISOString();
    const inserted = store.handle.prepare("INSERT INTO memory_proposal(repo,kind,fingerprint,title,rationale,before_text,after_text,evidence,sessions,status,created_at,surface) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(passing.repo, "decision-add", fingerprint, `Lesson note: ${safeText(names[0]!, 80)}`, facts, null, draft, JSON.stringify(quote === null ? [] : [{ session: `build:${prior.failed}`, quote }]), 1, "pending", at, NOTE_SURFACE);
    const proposal = Number(inserted.lastInsertRowid);
    store.handle.prepare(`INSERT INTO lesson_note (proposal, repo, failed_run, passing_run, repair_chain, revision_origin, identities_json, changed_paths_json, test_files_changed_json, facts_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(proposal, passing.repo, prior.failed, runId, prior.chain, prior.origin, JSON.stringify(identities), JSON.stringify(changed.slice(0, PATHS_MAX)), JSON.stringify(testFiles), sha(facts), at);
    return { proposal };
  });
}

// ---- accepted notes ------------------------------------------------------------------------------------------------

const sourceRefOf = (proposal: number): string => `lesson-note:${proposal}`;
const noteOfDecision = (ref: string | null): number | null => { const found = ref === null ? null : /^lesson-note:(\d+)$/.exec(ref); return found === null ? null : Number(found[1]); };

/** Track an accepted note's cases in every later Full check, whether or not a run received it. */
export function watchNote(store: Store, input: { repo: string; proposal: number; identities: readonly string[]; decisionRevision?: number; now: Date }): void {
  const sourceRef = input.decisionRevision === undefined ? `note:${input.proposal}` : `note:${input.proposal}:${input.decisionRevision}`;
  for (const identity of input.identities) store.handle.prepare(`INSERT INTO learning_watch (repo, identity, reason, source_ref, since, until) VALUES (?, ?, 'note', ?, ?, NULL) ON CONFLICT (repo, identity, reason, source_ref) DO NOTHING`).run(input.repo, identity, sourceRef, input.now.toISOString());
}
/** A note's tracking ends when its decision stops being active. */
export function endNoteWatch(store: Store, decisionSourceRef: string | null, now: Date): void {
  const proposal = noteOfDecision(decisionSourceRef);
  if (proposal === null) return;
  store.handle.prepare("UPDATE learning_watch SET until = ? WHERE reason = 'note' AND (source_ref = ? OR source_ref LIKE ?) AND until IS NULL").run(now.toISOString(), `note:${proposal}`, `note:${proposal}:%`);
}
export const lessonNoteSourceRef = sourceRefOf;

type Tally = { executions: number; failures: number; mixed: number; receivedExecutions: number; receivedFailures: number; unreported: number; sources: Set<string> };
function addTally(store: Store, note: number, month: string, add: Tally, partial = 0): void {
  const was = store.handle.prepare("SELECT sources_json FROM lesson_note_tally WHERE note = ? AND month = ?").get(note, month);
  const sources = JSON.stringify([...new Set([...(was === undefined ? [] : JSON.parse(String(was["sources_json"])) as string[]), ...add.sources])].sort());
  store.handle.prepare(`INSERT INTO lesson_note_tally (note, month, executions, failures, mixed_failures, received_executions, received_failures, unreported_checks, sources_json, partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (note, month) DO UPDATE SET executions = executions + excluded.executions, failures = failures + excluded.failures, mixed_failures = mixed_failures + excluded.mixed_failures,
      received_executions = received_executions + excluded.received_executions, received_failures = received_failures + excluded.received_failures, unreported_checks = unreported_checks + excluded.unreported_checks,
      sources_json = excluded.sources_json, partial = MAX(partial, excluded.partial)`).run(note, month, add.executions, add.failures, add.mixed, add.receivedExecutions, add.receivedFailures, add.unreported, sources, partial);
}
const activeNotes = (store: Store, repo: string): { note: number; decision: number; identities: string[]; since: string }[] =>
  store.handle.prepare(`SELECT n.proposal, n.identities_json, d.id AS decision, d.decided_at FROM lesson_note n JOIN project_decision d ON d.repo = n.repo AND d.source_ref = 'lesson-note:' || n.proposal AND d.status = 'active' WHERE n.repo = ?`).all(repo)
    .map(row => ({ note: Number(row["proposal"]), decision: Number(row["decision"]), identities: JSON.parse(String(row["identities_json"])) as string[], since: String(row["decided_at"]) }));
const monthOf = (now: Date): string => now.toISOString().slice(0, 7);

/**
 * Count one check for every accepted note, in the transaction that records its results: distinct `(run, identity)`
 * pairs with explicit results, split by whether the run received the decision. A check with no line for the note's
 * tests counts as unreported. `observations`: what this check just added, so a failure elsewhere that turned out to
 * have mixed outcomes is counted as such.
 */
export function tallyCheck(store: Store, runId: number, repo: string, observations: readonly number[], now: Date): void {
  const notes = activeNotes(store, repo);
  if (notes.length === 0) return;
  const month = monthOf(now);
  const results = store.handle.prepare(`SELECT state, source FROM check_result WHERE run = ? AND identity = ? AND source IN ${EXPLICIT}`);
  const mixedHere = store.handle.prepare("SELECT 1 FROM local_observation WHERE identity = ? AND failed_run = ? LIMIT 1");
  for (const one of notes) {
    const received = store.handle.prepare("SELECT 1 FROM memory_use WHERE run = ? AND kind = 'decision' AND item = ?").get(runId, String(one.decision)) !== undefined;
    const tally: Tally = { executions: 0, failures: 0, mixed: 0, receivedExecutions: 0, receivedFailures: 0, unreported: 0, sources: new Set() };
    for (const identity of one.identities) {
      const rows = results.all(runId, identity).filter(row => row["state"] !== "skipped");
      if (rows.length === 0) continue;
      const failed = rows.some(row => row["state"] === "failed" || row["state"] === "passed-on-retry");
      tally.executions++;
      if (received) tally.receivedExecutions++;
      for (const row of rows) tally.sources.add(String(row["source"]));
      if (failed) {
        tally.failures++;
        if (received) tally.receivedFailures++;
        if (mixedHere.get(identity, runId) !== undefined) tally.mixed++;
      }
    }
    if (tally.executions === 0) tally.unreported = 1;
    addTally(store, one.note, month, tally);
  }
  // Observations this check added about an earlier failure: that failure is now known to have mixed outcomes.
  for (const id of observations) {
    const row = store.handle.prepare("SELECT identity, failed_run FROM local_observation WHERE id = ?").get(id);
    if (row === undefined || Number(row["failed_run"]) === runId) continue;
    const at = store.handle.prepare("SELECT recorded_at FROM check_fact WHERE run = ?").get(Number(row["failed_run"]));
    for (const one of notes) if (one.identities.includes(String(row["identity"])) && at !== undefined && String(at["recorded_at"]) >= one.since) {
      addTally(store, one.note, month, { executions: 0, failures: 0, mixed: 1, receivedExecutions: 0, receivedFailures: 0, unreported: 0, sources: new Set() });
    }
  }
}
/** A month whose check couldn't be recorded is partial, and says so. */
export function markTalliesPartial(store: Store, repo: string, now: Date): void {
  for (const one of activeNotes(store, repo)) addTally(store, one.note, monthOf(now), { executions: 0, failures: 0, mixed: 0, receivedExecutions: 0, receivedFailures: 0, unreported: 0, sources: new Set() }, 1);
}

export type NoteAfterwards = { since: string; executions: number; failures: number; mixed: number; receivedExecutions: number; receivedFailures: number; unreported: number; partial: boolean; sources: string[] };
/** What a note's tallies say since it was accepted: sums of durable rows, unchanged by retention. */
export function noteAfterwards(store: Store, decision: { id: number; decidedAt: string; sourceRef: string | null }): NoteAfterwards | null {
  const note = noteOfDecision(decision.sourceRef);
  if (note === null) return null;
  const rows = store.handle.prepare("SELECT * FROM lesson_note_tally WHERE note = ?").all(note);
  const sum = (key: string): number => rows.reduce((total, row) => total + Number(row[key]), 0);
  return { since: decision.decidedAt, executions: sum("executions"), failures: sum("failures"), mixed: sum("mixed_failures"), receivedExecutions: sum("received_executions"), receivedFailures: sum("received_failures"), unreported: sum("unreported_checks"),
    partial: rows.some(row => Number(row["partial"]) === 1), sources: [...new Set(rows.flatMap(row => JSON.parse(String(row["sources_json"])) as string[]))].sort() };
}
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** "Since Nov 5: failed 1 of 31 runs of this test (0 of 18 that received this note; 1 of 13 that didn't). …". No "helped". */
export function afterwardsWords(after: NoteAfterwards): string {
  const others = after.executions - after.receivedExecutions, otherFailures = after.failures - after.receivedFailures;
  return [
    `Since ${DAY.format(new Date(after.since))}: failed ${after.failures} of ${after.executions} run${after.executions === 1 ? "" : "s"} of this test (${after.receivedFailures} of ${after.receivedExecutions} that received this note; ${otherFailures} of ${others} that didn't).`,
    after.mixed === 0 ? "" : `${after.mixed} of these had mixed outcomes.`,
    after.unreported === 0 ? "" : `${after.unreported} check${after.unreported === 1 ? "" : "s"} since had no per-test reporting.`,
    after.partial ? "Partial: not every check was counted." : "",
  ].filter(Boolean).join(" ");
}

/** What waits for a person, for pages and chat. */
export function memoryWaiting(store: Store, repo: string): { notes: number; cleanups: number } {
  return { notes: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM memory_proposal WHERE repo = ? AND status = 'pending' AND surface = ?").get(repo, NOTE_SURFACE)?.["n"] ?? 0),
    cleanups: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM memory_tidy_proposal WHERE repo = ? AND status = 'pending'").get(repo)?.["n"] ?? 0) };
}
