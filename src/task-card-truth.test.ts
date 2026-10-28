/** Task-card truth (2026-10-27): "did the approved check pass for this result" has ONE answer
 * (task-status.ts approvedCheckOf), and the task page's headline and sentence, its Project checks row, its road, the
 * Tasks list row and the result page all read it. None of them may say the check passed while another says it
 * failed, is running, didn't run, or couldn't be read; an unreadable or disagreeing check is never "passed" and never
 * lets the road reach Ready.
 *
 * A table over the real records, through real HTTP on a seeded throwaway store: the machine verdict (verified, failed
 * check, attested, none) × the saved check (passing, failing, damaged on disk, missing, the approved command changed
 * since, a follow-up check running) × publication (none, PR open, merged). No GitHub, no model. */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { createDecisionServer } from "./serve.js";
import { CHECKS_FINISHED, CHECKS_STARTED, FOLLOW_UP_LOG, FOLLOW_UP_RECEIPT, requestFollowUpChecks } from "./result-follow-ups.js";
import { telegramProgressCard } from "./telegram-progress.js";
import { approvedCheckOf, approvedCheckStateOf, type ApprovedCheckState, type ChecksFact } from "./task-status.js";
import { taskRoad } from "./first-run.js";
import { resultStatusOf } from "./workspace-ui.js";
import type { BrowserWorkspace } from "./browser-workspace.js";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const REPO = "/repos/payouts";
/** Its approved check command is approved again after the builds (a person changed it). */
const REPO_LATER = "/repos/ledger";
/** No approved check command at all. */
const REPO_NONE = "/repos/notes";

type Verdict = "verified" | "refuted" | "attested" | null;
type Case = {
  id: string; repo: string; verdict: Verdict;
  /** The sealed check receipt and its log: passed, failed, or none saved. */
  receipt: "pass" | "fail" | "none";
  /** After sealing: the check log altered on disk. */
  damage?: boolean;
  publication?: "open" | "merged";
  followUp?: boolean;
  /** A follow-up check (Run checks) passed on the same commit; `damaged`: its saved log altered since. */
  rerun?: "passed" | "damaged";
  /** The verdict's own reasons, in place of the failed-check reason a refuted verdict gets by default. */
  reasons?: string[];
  /** What the builder recorded for its check (run_check), as builder.ts does when it seals the receipt. */
  recorded?: "passed" | "failed";
  /** A person put the finished task on hold: it needs a person for a reason of its own. */
  held?: boolean;
  /** The build recorded no commit (the UI-polish fixture's payout task), so the result waits on a person for that. */
  noCommit?: boolean;
  /** The one answer every surface must agree on. */
  expect: ApprovedCheckState;
};

const CASES: Case[] = [
  { id: "verified-pass", repo: REPO, verdict: "verified", receipt: "pass", expect: "passed" },
  { id: "verified-damaged", repo: REPO, verdict: "verified", receipt: "pass", damage: true, expect: "unreadable" },
  // The UI-polish fixture's road: a result waiting on a person for another reason said "The approved check passed
  // against this result." over a Project checks row reading "Couldn't be read".
  { id: "verified-damaged-held", repo: REPO, verdict: "verified", receipt: "pass", damage: true, held: true, expect: "unreadable" },
  { id: "verified-no-commit", repo: REPO, verdict: "verified", receipt: "pass", noCommit: true, expect: "unreadable" },
  { id: "verified-pass-held", repo: REPO, verdict: "verified", receipt: "pass", held: true, expect: "passed" },
  { id: "verified-no-receipt", repo: REPO, verdict: "verified", receipt: "none", expect: "unreadable" },
  { id: "verified-command-changed", repo: REPO_LATER, verdict: "verified", receipt: "pass", expect: "unreadable" },
  { id: "failed-check", repo: REPO, verdict: "refuted", receipt: "fail", expect: "failed" },
  { id: "failed-check-damaged", repo: REPO, verdict: "refuted", receipt: "fail", damage: true, expect: "failed" },
  // A failure the builder recorded stands on every surface when the receipt can't be read, whatever else refuted it.
  { id: "recorded-failure-damaged", repo: REPO, verdict: "refuted", reasons: ["claimed changed path not in the sealed diff: src/other.ts"], receipt: "fail", damage: true, recorded: "failed", expect: "failed" },
  { id: "attested", repo: REPO_NONE, verdict: "attested", receipt: "none", expect: "not-run" },
  { id: "no-verdict-pass", repo: REPO, verdict: null, receipt: "pass", expect: "passed" },
  { id: "no-verdict-none", repo: REPO_NONE, verdict: null, receipt: "none", expect: "not-run" },
  { id: "verified-running", repo: REPO, verdict: "verified", receipt: "pass", followUp: true, expect: "running" },
  // A new check running never hides a failure or an unreadable check: only its result can change the answer.
  { id: "failed-rerunning", repo: REPO, verdict: "refuted", receipt: "fail", followUp: true, expect: "failed" },
  // An unreadable check with a new one underway reads running (a result waiting for its batch check has none yet), never passed.
  { id: "unreadable-rerunning", repo: REPO, verdict: "verified", receipt: "pass", damage: true, followUp: true, expect: "running" },
  // Run checks repairs an unreadable check; a follow-up pass whose own log is altered since doesn't.
  { id: "repaired-by-rerun", repo: REPO, verdict: "verified", receipt: "pass", damage: true, rerun: "passed", expect: "passed" },
  { id: "rerun-damaged", repo: REPO, verdict: "verified", receipt: "pass", damage: true, rerun: "damaged", expect: "unreadable" },
  { id: "pr-open-pass", repo: REPO, verdict: "verified", receipt: "pass", publication: "open", expect: "passed" },
  { id: "pr-open-damaged", repo: REPO, verdict: "verified", receipt: "pass", publication: "open", damage: true, expect: "unreadable" },
  { id: "merged-pass", repo: REPO, verdict: "verified", receipt: "pass", publication: "merged", expect: "passed" },
  { id: "merged-damaged", repo: REPO, verdict: "verified", receipt: "pass", publication: "merged", damage: true, expect: "unreadable" },
];

/** Any words that say the approved check passed. */
const PASSED_CLAIM = /\b(?:check|checks) passed\b|\bpassed against\b|\bPassed on\b|verified the result/i;
/** The Project checks row's words for each answer. */
const ROW: Record<ApprovedCheckState, RegExp> = {
  passed: /^Passed/, failed: /^Failed/, running: /checks running$/i, "not-run": /^Didn't run$/, off: /^Checked at release$/, unreadable: /^Couldn't be read(?: · running again)?$/,
};
/** The road's Checks step for each answer. */
const ROAD: Record<ApprovedCheckState, string> = {
  passed: "done:Checks", failed: "stuck:Checks failed", running: "current:Checks running", "not-run": "skipped:Checks not run",
  off: "skipped:Checks at release", unreadable: "stuck:Checks unreadable",
};

let store: Store;
let server: Server;
let base: string;
let root: string;
let password: string;
let cookie: string;
const runs: Record<string, number> = {};

function workspaceOf(html: string): BrowserWorkspace {
  const json = /<script type="application\/json" id="standing-orders-workspace-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(json).toBeDefined();
  return JSON.parse(json!);
}
const page = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();

function built(one: Case, at: Date): number {
  store.createTask({ id: one.id, title: `Fix ${one.id}` }, at);
  const ref = store.refFor("built-in", one.id).id;
  store.placeTask(ref, one.repo, {}, at);
  const proposed = propose(store, { taskId: one.id, goal: `Fix ${one.id}`, touches: ["src/"], acceptance: [{ id: "c1", statement: `Fix ${one.id}`, how: null, evidence: ["check"] }], now: at });
  const ok = approve(store, one.id, "sam", at, proposed.digest, password);
  if (!ok.ok) throw new Error(ok.reason);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${one.id}`, runner: "builder-1", branch: `toolroll/${one.id}`, worktree: `/pool/${one.id}`, route: authority.stamp, now: at });
  const head = (run + 10).toString(16).padStart(2, "0").repeat(20);
  store.stampRun(run, { scopeDigest: store.getScope(one.id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(run, { ...(one.noCommit === true ? {} : { headRevision: head }), handoff: `Fixed ${one.id}, with a regression test.` });
  store.finishRun(run, { outcome: "built", committed: true, now: at });
  store.setTaskState(one.id, "done", at);
  const exitCode = one.receipt === "fail" || one.verdict === "refuted" ? 1 : 0;
  if (one.verdict !== null) {
    const reasons = one.reasons ?? (one.verdict === "refuted" ? [`the repository's approved verification command exited ${exitCode}`] : []);
    store.saveProofVerdict(run, one.verdict, reasons, at,
      [{ id: "c1", statement: `Fix ${one.id}`, requiredEvidence: ["check"], state: one.verdict === "refuted" ? "fail" : "pass", detail: [], answered: [], review: null }] as never, one.verdict);
  }
  storeEvidence(store, root, run, "terminal-diff", "diff.patch", Buffer.from(`diff --git a/src/${one.id}.ts b/src/${one.id}.ts\n--- a/src/${one.id}.ts\n+++ b/src/${one.id}.ts\n@@ -1 +1 @@\n-a\n+b\n`), "git diff (exit 0)", at, { captureStatus: "ok" });
  if (one.receipt !== "none") {
    const log = storeEvidence(store, root, run, "check-log", "checks.txt", Buffer.from(exitCode === 0 ? "612 passed\n" : "1 failed\n"), "npm test", at, { captureStatus: "ok" });
    sealVerificationReceipt(store, root, run, head, store.liveVerifyCommand(one.repo)!, { configured: true, ran: true, exitCode }, at);
    if (one.damage === true) writeFileSync(join(root, store.getArtifact(log)!.key), "0 passed, 612 failed\n");
  }
  if (one.publication !== undefined) {
    const publication = store.createPublicationIntent({ run, taskRef: ref, githubRepo: "sam/payouts", remote: "origin", base: "main", head: `toolroll/${one.id}`, headSha: head, bodyHash: "body", draft: false }, at);
    store.markPublicationPushed(publication, at);
    store.markPublicationOpened(publication, 40 + run, `https://github.com/sam/payouts/pull/${40 + run}`, at);
    store.recordPublicationCheckState(publication, "passing", at);
    if (one.publication === "merged") store.recordPublicationRemoteState(publication, "MERGED", at);
  }
  if (one.recorded !== undefined) store.recordRunCheck(run, { status: one.recorded, exitCode: one.recorded === "failed" ? 1 : 0, suites: [] }, at);
  if (one.rerun !== undefined) {
    const asked = requestFollowUpChecks(store, { runId: run, level: "full", actor: "operator:sam" }, at);
    if (!asked.ok) throw new Error(`rerun: ${asked.reason}`);
    const command = store.liveVerifyCommand(one.repo)!;
    store.recordAction({ at: at.toISOString(), actor: "system", repo: one.repo, taskId: one.id, runId: run, action: CHECKS_STARTED, outcome: String(asked.request), source: "work", detail: "limit 300000" });
    const logId = storeEvidence(store, root, run, "structured-output", `follow-up-check-${asked.request}.log`, Buffer.from("612 passed\n"), FOLLOW_UP_LOG, at, { captureStatus: "ok" });
    const log = store.getArtifact(logId)!;
    storeEvidence(store, root, run, "structured-output", `follow-up-check-${asked.request}.json`, Buffer.from(JSON.stringify({ version: 1, request: asked.request, run, head, tested: head, level: "full",
      command: { repo: command.repo, command: command.command, digest: command.digest, approvedBy: command.approvedBy }, result: { ran: true, exitCode: 0 },
      log: { artifactId: log.id, sha256: log.sha256, bytesStored: log.bytesStored, truncated: log.truncated } })), FOLLOW_UP_RECEIPT, at, { captureStatus: "ok" });
    store.recordAction({ at: at.toISOString(), actor: "system", repo: one.repo, taskId: one.id, runId: run, action: CHECKS_FINISHED, outcome: `${asked.request}:passed`, source: "work", detail: `Full checks on ${head.slice(0, 7)} · exit 0` });
    if (one.rerun === "damaged") writeFileSync(join(root, log.key), "0 passed\n");
  }
  if (one.followUp === true) {
    const asked = requestFollowUpChecks(store, { runId: run, level: "full", actor: "operator:sam" }, at);
    if (!asked.ok) throw new Error(`follow-up: ${asked.reason}`);
  }
  if (one.held === true) store.hold(ref, "Checking the payout totals with finance first.", null, at);
  runs[one.id] = run;
  return run;
}

beforeAll(async () => {
  store = openStore(":memory:");
  root = mkdtempSync(join(tmpdir(), "task-card-truth-"));
  register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO, REPO_LATER, REPO_NONE], now: NOW, newToken: () => "tok-builder-1" });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", ago(600));
  const sam = addApprover(store, "sam", ago(600));
  if (!sam.ok) throw new Error("approver");
  password = sam.token;
  store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "sam" }, ago(600));
  store.setVerifyCommand({ repo: REPO_LATER, command: "npm test", timeoutMs: 300_000, approvedBy: "sam" }, ago(600));
  CASES.forEach((one, index) => built(one, ago(300 - index * 10)));
  // A person approves a changed check command after the builds: the earlier receipts no longer bind to it.
  store.setVerifyCommand({ repo: REPO_LATER, command: "npm test -- --ci", timeoutMs: 300_000, approvedBy: "sam" }, ago(30));

  server = createDecisionServer({ store, evidenceRoot: root, repos: [REPO, REPO_LATER, REPO_NONE], clock: () => NOW });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "sam", token: password }), redirect: "manual" });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
});

afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()));
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("one answer to 'did the approved check pass', on every surface", () => {
  test.each(CASES)("$id: the headline, Project checks row, road, list row and result page agree ($expect)", async one => {
    const run = runs[one.id]!;
    // ---- the task page: its status card (headline, sentence, rows) and its road
    const task = workspaceOf(await page(`/t/${one.id}`)).view as Extract<BrowserWorkspace["view"], { kind: "task" }>;
    const status = task.status!.status;
    const row = status.details.find(detail => detail.key === "checks");
    expect(row, `${one.id}: Project checks row`).toBeDefined();
    expect(row!.text, `${one.id}: Project checks row`).toMatch(ROW[one.expect]);
    const claims = [status.sentence, ...status.details.filter(detail => detail.key !== "checks").map(detail => detail.text)];
    if (one.expect !== "passed" && one.expect !== "running") for (const words of claims) expect(words, `${one.id}: no surface claims a pass`).not.toMatch(PASSED_CLAIM);
    if (one.expect === "unreadable") {
      expect(status.headline, one.id).toBe("Needs you");
      // A hold is its own reason to need a person; otherwise the unreadable check is the ask.
      if (one.held !== true) expect(status.sentence, one.id).toContain("couldn't be read");
    }
    if (one.expect === "failed") expect(status.headline, one.id).toBe("Failed");
    if (one.expect === "passed") expect(["Ready for review", "Needs you"], one.id).toContain(status.headline);
    const road = task.journey!.map(step => `${step.key}:${step.state}:${step.label}`);
    expect(road[3], `${one.id}: the road's Checks step`).toBe(`checks:${ROAD[one.expect]}`);
    // Fail closed: a failed or unreadable check never lets the road reach Ready.
    if (one.expect === "failed" || one.expect === "unreadable") expect(road[4], one.id).not.toMatch(/^ready:done/);
    // A passing check never reads stuck: the road reaches Ready, or waits there on a hold.
    if (one.expect === "passed") expect(road[4], one.id).toBe(one.held === true ? "ready:stuck:Ready" : "ready:done:Ready");

    // ---- the Tasks list row: the same headline, never a pass the card doesn't show
    const list = workspaceOf(await page("/work")).view as Extract<BrowserWorkspace["view"], { kind: "tasks" }>;
    const listed = list.rows.find(item => item.id === one.id);
    expect(listed, `${one.id}: listed`).toBeDefined();
    expect(listed!.status.label, `${one.id}: list headline`).toBe(status.headline);
    if (one.expect !== "passed" && one.expect !== "running") expect(listed!.status.detail ?? "", `${one.id}: list sentence`).not.toMatch(PASSED_CLAIM);

    // ---- the result page: its headline, its own Checks row, its status and its Checks tab
    const html = await page(`/review?result=${one.id}&run=${run}&tab=checks`);
    const result = workspaceOf(html).view as Extract<BrowserWorkspace["view"], { kind: "result" }>;
    const selected = result.selected!;
    expect(selected.status.label, `${one.id}: result page headline`).toBe(status.headline);
    const panel = selected.panel!.status!;
    expect(panel.headline, `${one.id}: result panel headline`).toBe(status.headline);
    expect(panel.details.find(detail => detail.key === "checks")?.text, `${one.id}: result page Checks row`).toBe(row!.text);
    if (one.expect !== "passed" && one.expect !== "running") {
      expect(panel.sentence, one.id).not.toMatch(PASSED_CLAIM);
      if (selected.decision !== null) expect(selected.decision.label, `${one.id}: Accept`).toBe("Accept without checks");
    }
    const checksTab = selected.panel!.views.find(view => view.key === "checks")?.html ?? "";
    // A verdict that recorded a pass the check can't show now says so where it is shown.
    if (one.verdict === "verified" && one.expect === "unreadable") expect(checksTab, one.id).toMatch(/Now: the check result couldn(?:'|&#39;|&#x27;)t be read\. It doesn(?:'|&#39;|&#x27;)t count as passed\./);
    // The road and the result page read the card's one answer, never the row's words.
    expect(status.check, `${one.id}: the card's one answer`).toBe(one.expect);
    expect(panel.check, `${one.id}: result panel answer`).toBe(one.expect);
  });
});

/** The bug as Alex saw it: no surface may say the check passed while the same result's Project checks row says it
 * couldn't be read (or failed). Every text the task page, the Tasks list and the result page show, at once. */
test("no surface claims a pass beside a check row that says otherwise", async () => {
  const CLAIM = /\b(?:check|checks|command) passed\b|\bpassed against\b|\bPassed on\b|verified (?:the|this) result/i;
  const violations: string[] = [];
  const list = workspaceOf(await page("/work")).view as Extract<BrowserWorkspace["view"], { kind: "tasks" }>;
  for (const one of CASES) {
    const task = workspaceOf(await page(`/t/${one.id}`)).view as Extract<BrowserWorkspace["view"], { kind: "task" }>;
    const row = task.status!.status.details.find(detail => detail.key === "checks")?.text ?? "";
    if (/^Passed/.test(row) || /running/i.test(row)) continue;
    const result = workspaceOf(await page(`/review?result=${one.id}&run=${runs[one.id]}&tab=checks`)).view as Extract<BrowserWorkspace["view"], { kind: "result" }>;
    const checksTab = result.selected!.panel!.views.find(view => view.key === "checks")?.html ?? "";
    const verdictLine = /<p class="row result-verdict"[\s\S]*?<\/p>/.exec(checksTab)?.[0] ?? "";
    const html = await page(`/t/${one.id}`);
    const card = (/<section class="card assignment-summary"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "").replace(/<[^>]+>/g, " ");
    const chat = telegramProgressCard(store, store.getRun(runs[one.id]!)!, one.id, one.repo, NOW, root).text;
    const texts: [string, string][] = [
      ["task sentence", task.status!.status.sentence],
      ["task card, attempts included", card],
      ["chat card", chat],
      ["list row", list.rows.find(item => item.id === one.id)?.status.detail ?? ""],
      ["result headline", result.selected!.panel!.status!.sentence],
      // The completion record may say what it recorded, only beside what holds now.
      ["result checks tab", /count as passed/.test(verdictLine) ? "" : verdictLine.replace(/<[^>]+>/g, "")],
    ];
    for (const [where, words] of texts) if (CLAIM.test(words)) violations.push(`${one.id} · ${where}: "${words.trim()}" beside Project checks "${row}"`);
  }
  expect(violations).toEqual([]);
});

/** An older result of a task, its recorded pass since contradicted by a failed check on its commit: its own page says
 * what holds now, never "Toolroll independently verified this result." */
test("an earlier result whose check failed since never reads verified", async () => {
  const id = "verified-pass";
  const older = runs[id]!;
  const ref = store.refFor("built-in", id).id;
  const head = store.getRun(older)!.headRevision!;
  const asked = requestFollowUpChecks(store, { runId: older, level: "full", actor: "operator:sam" }, ago(5));
  if (!asked.ok) throw new Error(asked.reason);
  store.recordAction({ at: ago(5).toISOString(), actor: "system", repo: REPO, taskId: id, runId: older, action: CHECKS_STARTED, outcome: String(asked.request), source: "work", detail: "limit 300000" });
  store.recordAction({ at: ago(4).toISOString(), actor: "system", repo: REPO, taskId: id, runId: older, action: CHECKS_FINISHED, outcome: `${asked.request}:failed`, source: "work", detail: `Full checks on ${head.slice(0, 7)} · exit 1` });
  // A newer build of the same task becomes the task's current result.
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const newer = store.startRun({ taskRef: ref, leaseId: "l-newer", runner: "builder-1", branch: `toolroll/${id}`, worktree: `/pool/${id}-2`, route: authority.stamp, now: ago(3) });
  const newHead = (newer + 10).toString(16).padStart(2, "0").repeat(20);
  store.stampRun(newer, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(newer, { headRevision: newHead, handoff: "Fixed again." });
  store.finishRun(newer, { outcome: "built", committed: true, now: ago(3) });
  store.saveProofVerdict(newer, "verified", [], ago(3), [{ id: "c1", statement: `Fix ${id}`, requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }] as never, "verified");
  storeEvidence(store, root, newer, "terminal-diff", "diff.patch", Buffer.from("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"), "git diff (exit 0)", ago(3), { captureStatus: "ok" });
  storeEvidence(store, root, newer, "check-log", "checks.txt", Buffer.from("612 passed\n"), "npm test", ago(3), { captureStatus: "ok" });
  sealVerificationReceipt(store, root, newer, newHead, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, ago(3));
  // The older result's own page (its run record), where it isn't the task's current result.
  const shown = await page(`/r/${older}?record=1`);
  expect(shown).toContain(`Build #${older}`);
  // Only the completion record's own line may restate the verdict, and only beside what holds now.
  const unqualified = [...shown.matchAll(/independently verified this result\.(.{0,160})/g)].filter(one => !/Now: .*count as passed/.test(one[1]!));
  expect(unqualified).toEqual([]);
  expect(shown).toMatch(/data-work-status="checks-failed"/);
});

/** The derivation itself, over every combination: a pass only when the saved check read now passed. */
describe("approvedCheckOf", () => {
  const FAILED = ["the repository's approved verification command exited 2"];
  const read = (status: ChecksFact["status"], extra: Partial<ChecksFact> = {}): ChecksFact => ({ status, exitCode: status === "failed" ? 3 : null, head: "a".repeat(40), ...extra });
  const verdicts: { verdict: Verdict; reasons: string[] }[] = [{ verdict: "verified", reasons: [] }, { verdict: "refuted", reasons: FAILED }, { verdict: "attested", reasons: [] }, { verdict: null, reasons: [] }];
  const readings: (ChecksFact | null)[] = [read("passed"), read("failed"), read("running"), read("not-run"), read("unavailable"), read("passed", { running: "full" }), null];
  const table = () => verdicts.flatMap(v => readings.map(r => ({ ...v, reading: r, answer: approvedCheckStateOf(approvedCheckOf(v.verdict, v.reasons, r)) })));

  test("passed only when the saved check read now passed", () => {
    for (const row of table()) {
      const passed = row.reading?.status === "passed" && row.reading.running == null;
      expect(row.answer === "passed", JSON.stringify(row)).toBe(passed);
    }
  });
  test("a recorded pass the check can't show is unreadable; a recorded failure stays failed", () => {
    const of = (verdict: Verdict, reasons: string[], reading: ChecksFact | null) => approvedCheckStateOf(approvedCheckOf(verdict, reasons, reading));
    expect(of("verified", [], read("unavailable"))).toBe("unreadable");
    expect(of("verified", [], read("not-run"))).toBe("unreadable");
    expect(of("verified", [], null)).toBe("unreadable");
    expect(of("refuted", FAILED, read("unavailable"))).toBe("failed");
    expect(of("refuted", FAILED, null)).toBe("failed");
    expect(approvedCheckOf("refuted", FAILED, read("not-run"))?.exitCode).toBe(2);
    expect(of("attested", [], read("not-run"))).toBe("not-run");
    expect(of(null, [], null)).toBe(null);
    // Checks Off waiting for a release check, and covered by one.
    expect(of("attested", [], read("not-run", { level: "off" }))).toBe("off");
    expect(of("attested", [], read("not-run", { level: "off", release: { run: 9, head: "b".repeat(40) } }))).toBe("passed");
    // A new check underway never hides a failure or an unreadable check.
    expect(of("refuted", FAILED, read("failed", { running: "full" }))).toBe("failed");
    expect(of("verified", [], read("unavailable", { running: "full" }))).toBe("running");
    expect(of("verified", [], read("passed", { running: "full" }))).toBe("running");
  });
  test("the result's words and the road read the same answer", () => {
    const facts = (verdict: Verdict, reasons: string[], reading: ChecksFact | null) =>
      ({ runId: 1, role: "builder", outcome: "built", verdict, reasons, accepted: false, checks: reading });
    for (const row of table()) {
      const words = resultStatusOf(facts(row.verdict, row.reasons, row.reading));
      const says = `${words.label} ${words.detail}`;
      // A re-run underway keeps the pass it had; every other answer short of a pass never claims one.
      if (row.answer !== "passed" && row.answer !== "running") expect(says, JSON.stringify(row)).not.toMatch(PASSED_CLAIM);
      const road = taskRoad({ stage: "finished" }, true, true, { checks: row.answer });
      if (row.answer === "unreadable" || row.answer === "failed") expect(road.find(step => step.key === "ready")!.state, JSON.stringify(row)).not.toBe("done");
      if (row.answer === "passed") expect(road.find(step => step.key === "checks")!.state).toBe("done");
    }
    // Checks Off covered by a passing release check read as passed everywhere, the words included.
    const covered = read("not-run", { level: "off", release: { run: 9, head: "b".repeat(40) } });
    for (const verdict of ["verified", "attested"] as const) expect(resultStatusOf(facts(verdict, [], covered)).detail).toBe("The approved check passed against this result.");
    // A surface that read no check claims no pass.
    expect(resultStatusOf({ runId: 1, role: "builder", outcome: "built", verdict: "verified", reasons: [], accepted: false }).detail).not.toMatch(PASSED_CLAIM);
    // Published or merged: the publication never stands in for a check that can't be read.
    for (const publication of [{ state: "opened", prNumber: 7, prUrl: "https://github.com/a/b/pull/7", remoteState: null, lastCheckState: "passing" },
      { state: "opened", prNumber: 7, prUrl: "https://github.com/a/b/pull/7", remoteState: "MERGED", lastCheckState: "passing" }]) {
      const unread = resultStatusOf(facts("verified", [], read("unavailable")), publication);
      expect(unread.token).toBe("check-unreadable");
      expect(unread.detail).not.toMatch(PASSED_CLAIM);
      expect(resultStatusOf(facts("verified", [], read("passed")), publication).detail).toMatch(/^The approved check passed against this result\./);
    }
  });
});
