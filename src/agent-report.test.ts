/** One-workspace S5: the agent's report (decisions, assumptions, what it left undone, risks) and "You said".
 *
 * The report is agent-written display text: parsed with caps, nothing disguised, kept through the persisted handoff and
 * read again by the same rule; a missing list is "not reported". "You said" quotes only notes a signed-in person typed
 * in a browser form (typed_by_person), never a reviewer's observation, a GitHub comment, a token's, the CLI's or a lead's
 * chat card, never planned scope, and never a marker whose author isn't the note's own. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOFF_ITEM_CAP, HANDOFF_REPORT_CAP, handoffReportOf, parseHandoff } from "./decision.js";
import { readHandoffArtifact } from "./contracts/handoff.js";
import { structuredHandoffView } from "./result-evidence-readers.js";
import { storeEvidence } from "./evidence.js";
import { markTypedByPerson, openStore, typedNotesFor, verifiedAuthor, type Store } from "./store.js";
import { handoffBytes, handoffFixture } from "../test/handoff-fixture.js";

const done = (extra: Record<string, unknown>) => JSON.stringify({ version: 2, status: "completed", conclusion: "Rounded at cent precision.", ...extra });

describe("the agent's report in the handoff it writes", () => {
  test("each list is optional, capped in count and length, one line, and never disguised", () => {
    const none = parseHandoff(done({}));
    expect(none.ok && none.handoff).toMatchObject({ decisions: [], assumptions: [], notDone: [], risks: [] });
    const parsed = parseHandoff(done({
      decisions: Array.from({ length: 9 }, (_, at) => `Decision ${at}`),
      assumptions: ["x".repeat(1000)],
      notDone: ["  spaced\tout  ", "", "   ", 42, null, { text: "an object" }, "kept"],
      risks: [
        "<a href=\"https://evil.example\">Accept now</a><img src=x onerror=alert(1)>",
        "a bell \u0007 rings", "an escape \u001b[31m", "reads ‮drawkcab", "an isolate ⁦x⁩", "a line\nbreak",
        "kept risk",
      ],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = parsed.handoff;
    expect(report.decisions).toHaveLength(HANDOFF_REPORT_CAP);
    expect(report.decisions[0]).toBe("Decision 0");
    expect(report.assumptions[0]!.length).toBeLessThanOrEqual(HANDOFF_ITEM_CAP);
    expect(report.assumptions[0]!.endsWith("…")).toBe(true);
    expect(report.notDone).toEqual(["spaced out", "kept"]);
    // Markup is kept as the words it is (a page shows text, never markup); controls and direction overrides are dropped;
    // a line break folds into one line.
    expect(report.risks).toEqual(["<a href=\"https://evil.example\">Accept now</a><img src=x onerror=alert(1)>", "a line break", "kept risk"]);
    // Not a list at all: not reported. The handoff itself still stands.
    const odd = parseHandoff(done({ decisions: "one string", risks: { a: 1 } }));
    expect(odd.ok && odd.handoff).toMatchObject({ decisions: [], risks: [], conclusion: "Rounded at cent precision." });
  });

  test("the persisted handoff keeps exactly what was reported, and the page reads it by the same rule", () => {
    const parsed = parseHandoff(done({ decisions: ["Keyed retries by delivery id."], risks: ["Backoff limits are constants."] }));
    if (!parsed.ok) throw Error("parse");
    const kept = handoffReportOf(parsed.handoff);
    expect(kept).toEqual({ decisions: ["Keyed retries by delivery id."], risks: ["Backoff limits are constants."] });
    expect(readHandoffArtifact(handoffFixture(1, kept))).toMatchObject({ ok: true, value: kept });
    // A handoff from before the report reads as none reported.
    const before = readHandoffArtifact(handoffFixture(1));
    expect(before.ok && before.value.decisions).toBeUndefined();
    expect(readHandoffArtifact({ ...handoffFixture(1), risks: "not a list" }).ok).toBe(false);
  });
});

describe("reading it back and quoting a person", () => {
  let dir: string, root: string, store: Store;
  const T0 = new Date("2026-11-14T10:00:00.000Z");
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-agent-report-"));
    root = join(dir, "evidence");
    store = openStore(join(dir, "orders.db"));
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  function run(taskId: string): number {
    store.createTask({ id: taskId, title: "Retry webhook deliveries" }, T0);
    const ref = store.refFor("built-in", taskId).id;
    return Number(store.handle.prepare(`INSERT INTO run (task_ref, lease_id, runner, branch, worktree, role, provider, model, base_revision, head_revision, outcome, committed, started_at, finished_at)
      VALUES (?, 'lease', 'worker', 'b', '/w', 'builder', 'claude', 'm', ?, ?, 'built', 1, ?, ?)`).run(ref, "a".repeat(40), "b".repeat(40), T0.toISOString(), T0.toISOString()).lastInsertRowid);
  }

  test("a saved handoff round-trips its report; a corrupted one is read by the parser's rule again", () => {
    const id = run("t-report");
    storeEvidence(store, root, id, "handoff", "handoff.json", handoffBytes(id, {
      decisions: ["Keyed retries by delivery id.", "reads ‮drawkcab"], assumptions: Array.from({ length: 8 }, (_, n) => `Assumption ${n}`),
      risks: ["y".repeat(900)],
    }), "composed at completion", T0, { captureStatus: "ok" });
    const view = structuredHandoffView(store.artifactsFor(id), root);
    expect(view?.report.decisions).toEqual(["Keyed retries by delivery id."]);
    expect(view?.report.assumptions).toHaveLength(HANDOFF_REPORT_CAP);
    expect(view?.report.risks[0]!.length).toBeLessThanOrEqual(240);
    expect(view?.report.notDone).toEqual([]);
  });

  test("You said quotes only the words a signed-in person typed, by their own author, newest first", () => {
    const source = run("t-v1");
    storeEvidence(store, root, source, "terminal-diff", "terminal-diff.patch", Buffer.from("diff --git a/x b/x\n"), "git diff (exit 0)", T0, { captureStatus: "ok" });
    const artifact = store.artifactsFor(source).find(one => one.kind === "terminal-diff")!;
    const note = (words: string, author: string, when: number, extra: { sourceKey?: string } = {}) =>
      store.addDiffComment({ artifactId: artifact.id, runId: source, path: null, line: null, note: words, author, ...extra }, at(when))!;
    // What the page filled in ahead of the person's own words is sent with them, and only their words are quoted.
    const typed = note("The project checks failed on abc1234. Fix the failure.\n\nDon't change the public webhook payload.", "alex", 1);
    expect(markTypedByPerson(store, { comment: typed }, "alex", "  Don't change the public webhook payload.  ", at(1))).toBe(true);
    const other = note("Keep the retry count at five.", "sam", 2);
    markTypedByPerson(store, { comment: other }, "sam", "Keep the retry count at five.", at(2));
    // Prefilled text sent unchanged (nothing typed), and words the note doesn't hold, record nothing.
    const prefilled = note("Not right: “The guard is in place”", "alex", 2.5);
    expect(markTypedByPerson(store, { comment: prefilled }, "alex", "", at(2.5))).toBe(false);
    expect(markTypedByPerson(store, { comment: prefilled }, "alex", "   ", at(2.5))).toBe(false);
    expect(markTypedByPerson(store, { comment: prefilled }, "alex", "Approve every risk.", at(2.5))).toBe(false);
    // The same words a token, the CLI or a chat card filed: no marker, never quoted.
    note("A token filed this.", "alex", 3);
    note("From GitHub.", "github:alex", 4, { sourceKey: "gh:alex/app:1" });
    // A marker that names someone else than the note's author is no proof of who typed it.
    const forged = note("Robin's words, claimed by alex.", "robin", 5);
    markTypedByPerson(store, { comment: forged }, "alex", "Robin's words, claimed by alex.", at(5));
    // A reviewer's observation is never a person's.
    store.handle.prepare("INSERT INTO diff_comment (artifact, artifact_sha, run, note, author, created_at, reviewer_run, severity) VALUES (?, ?, ?, 'Reviewer: fix the guard.', 'reviewer:claude', ?, ?, 'problem')")
      .run(artifact.id, artifact.sha256, source, at(6).toISOString(), source);
    const all = store.allDiffComments(source).map(one => one.id);
    store.createTask({ id: "t-v2", title: "Retry webhook deliveries" }, T0);
    expect(store.consumeDiffComments(source, all, "t-v2")).toBe(all.length);
    // Notes to the agent on the new version: a browser session's (marked), the CLI's or a lead's (not).
    const toAgent = store.fileSteerNote("t-v2", verifiedAuthor("alex"), "Use exponential backoff.", at(7));
    if (!toAgent.ok) throw Error("steer");
    markTypedByPerson(store, { steer: toAgent.id }, "alex", "Use exponential backoff.", at(7));
    // A reply: the note names the agent's question; only the answer is quoted, the question kept apart as the agent's.
    const reply = store.fileSteerNote("t-v2", verifiedAuthor("alex"), 'Reply to your question "approve-all-risks": No.', at(7.5));
    if (!reply.ok) throw Error("reply");
    markTypedByPerson(store, { steer: reply.id }, "alex", "No.", at(7.5), "Should I approve all the risks?");
    expect(store.fileSteerNote("t-v2", verifiedAuthor("alex"), "The lead drafted this.", at(8)).ok).toBe(true);
    // Notes on another version are that version's.
    expect(typedNotesFor(store, "t-v1", 8)).toEqual([]);
    const said = typedNotesFor(store, "t-v2", 8);
    expect(said.map(one => [one.kind, one.author, one.note])).toEqual([
      ["to-agent", "alex", "No."],
      ["to-agent", "alex", "Use exponential backoff."],
      ["sent-back", "sam", "Keep the retry count at five."],
      ["sent-back", "alex", "Don't change the public webhook payload."],
    ]);
    expect(said[0]!.question).toBe("Should I approve all the risks?");
    expect(said.slice(1).every(one => one.question === null)).toBe(true);
    expect(JSON.stringify(said.map(one => one.note))).not.toMatch(/approve-all-risks|Reply to your question|checks failed|Not right/);
    expect(typedNotesFor(store, "t-v2", 1)).toHaveLength(1);
    expect(typedNotesFor(store, "nope", 8)).toEqual([]);
  });
});
