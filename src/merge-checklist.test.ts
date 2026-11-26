/** "Can I merge?" (docs/plans/plain-toolroll.md P1.6): each row reads its one source and changes only when that source
 * does; a blocker carries its existing act; `toolroll task ready` and the task page's panel say the same; and Ask the
 * agent to fix is Send back: the same post, the same note batch and source terms, landing the same revision. */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import { acceptAndCompleteAsOperator, assignmentOf, checkAssignmentAsOperator } from "./assignment.js";
import { verifyApproverByPassword } from "./principal.js";
import { withActor } from "./actor.js";
import { assignmentStatusFacts, statusOf } from "./task-status.js";
import { recordActionWhole } from "./action-ledger.js";
import { LAND_INTENT, LAND_SETTLED } from "./local-landing.js";
import { landedRowsOf } from "./landed-rows.js";
import { checklistFromAssignment, checklistLines, mergeChecklistOf, noCheckSetWords, NOT_RECORDED, NOT_RECORDED_LOCAL, type ChecklistKey, type MergeChecklist } from "./merge-checklist.js";
import { revisionFormOf, workspaceOf } from "../test/serve-kit.js";
import { stepCardsOf } from "./engine-reads.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const REPO = "/repos/merge-ready";
let dir: string, ev: string, file: string, store: Store, server: Server, base: string, password: string, cookie: string;
const runs: Record<string, number> = {};

function filed(id: string, at: Date, approved = true): number {
  store.createTask({ id, title: `Task ${id}` }, at);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, at);
  const proposed = propose(store, { taskId: id, goal: "Fix the footer link.", touches: ["src/footer.ts"], acceptance: [{ id: "c1", statement: "The footer link opens.", how: null, evidence: ["check"] }], now: at });
  if (approved) {
    const ok = approve(store, id, "sam", at, proposed.digest, password);
    if (!ok.ok) throw new Error(ok.reason);
  }
  return ref;
}
function built(id: string, at: Date, kind: "verified" | "refuted" | "failed" | "unchecked" | "person" | "attested" = "verified"): number {
  const ref = filed(id, at);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: at });
  runs[id] = run;
  store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  if (kind === "failed") {
    store.finishRun(run, { outcome: "failed", reason: "agent", now: at });
    store.setTaskState(id, "failed", at);
    return run;
  }
  const head = (run + 10).toString(16).padStart(2, "0").repeat(20);
  store.recordOutcomeFacts(run, { headRevision: head, handoff: "Changed the footer." });
  store.finishRun(run, { outcome: "built", committed: true, now: at });
  store.setTaskState(id, "done", at);
  const reasons = kind === "refuted" ? ["claimed changed path not in the sealed diff: src/other.ts"]
    : kind === "person" ? ['criterion "c1" requires manual-review evidence — an operator must accept it before this can verify'] : [];
  const verdict = kind === "refuted" ? "refuted" : kind === "person" ? "short" : kind === "attested" ? "attested" : "verified";
  store.saveProofVerdict(run, verdict, reasons, at, [{ id: "c1", statement: "The footer link opens.", requiredEvidence: ["check"], state: kind === "refuted" ? "failed" : kind === "person" ? "manual-review" : "pass", detail: [], answered: [], review: null }] as never, verdict);
  storeEvidence(store, ev, run, "terminal-diff", "diff.patch", Buffer.from("diff --git a/src/footer.ts b/src/footer.ts\n--- a/src/footer.ts\n+++ b/src/footer.ts\n@@ -1 +1 @@\n-a\n+b\n"), "git diff (exit 0)", at, { captureStatus: "ok" });
  if (kind !== "unchecked" && kind !== "attested") {
    storeEvidence(store, ev, run, "check-log", "checks.txt", Buffer.from("12 passed\n"), "npm test", at, { captureStatus: "ok" });
    sealVerificationReceipt(store, ev, run, head, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, at);
  }
  return run;
}
const listOf = (id: string): MergeChecklist => mergeChecklistOf(store, id, NOW, { principal: "operator", repos: [REPO] }, ev)!;
const rowOf = (id: string, key: ChecklistKey) => listOf(id).rows.find(one => one.key === key)!;
function http(path: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: string; location: string | null; setCookie: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method: init.method ?? "GET", headers: { ...(cookie === undefined ? {} : { cookie }), ...(init.body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }) } }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location ?? null, setCookie: String(res.headers["set-cookie"] ?? "") }));
    });
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "merge-ready-"));
  file = join(dir, "state.db");
  // The CLI reads evidence beside its database: the same folder here.
  ev = join(dir, "evidence");
  store = openStore(file);
  register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok-builder-1" });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", ago(900));
  const sam = addApprover(store, "sam", ago(900));
  if (!sam.ok) throw new Error("approver");
  password = sam.token;
  store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "sam" }, ago(900));
  filed("draft", ago(80), false);
  built("ready", ago(60));
  built("failed", ago(55), "failed");
  built("refuted", ago(50), "refuted");
  built("unchecked", ago(45), "unchecked");
  built("noted", ago(40));
  built("person", ago(35), "person");
  server = createDecisionServer({ store, evidenceRoot: ev, repo: REPO, clock: () => NOW });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
  const login = await http("/login", { method: "POST", body: new URLSearchParams({ name: "sam", token: password }).toString() });
  cookie = login.setCookie.split(";")[0]!;
});
afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("each row reads its one source", () => {
  test("a verified result with checks passed: every recorded row is done; what Toolroll doesn't record says so", () => {
    const list = listOf("ready");
    const marks = Object.fromEntries(list.rows.map(one => [one.key, one.mark]));
    expect(marks).toEqual({ plan: "yes", build: "yes", checks: "yes", requirements: "yes", "pull-request": "skip", "pr-ci": "skip", "up-to-date": "unknown", conflicts: "unknown", comments: "yes", release: "skip" });
    // This project opens no pull requests, so nothing points at GitHub.
    expect(list.rows.find(one => one.key === "up-to-date")!.say).toBe(NOT_RECORDED_LOCAL);
    expect(list.answer).toBe("yes");
    expect(list.sentence).toBe("Yes, as far as Toolroll records. Check up to date with main and no conflicts in your repository.");
    expect(checklistLines(list).join("\n")).not.toMatch(/GitHub|\[/);
    expect(list.rows.every(one => one.act === null)).toBe(true);
  });

  test("up to date with main reads the task's Base line where there are no pull requests; landed work answers with its history (everyday-9 E1/E3)", () => {
    const assignment = assignmentOf(store, "ready", NOW, { principal: "operator", repos: [REPO] }, ev)!;
    const head = assignment.receipt!.head!;
    // git as a revision's project answers it: main's newer commits are already in the result's own head, while its
    // pinned review base is two commits behind main (review round 1).
    const git = (missing: string | null) => (_cwd: string, args: readonly string[]) =>
      args[0] === "rev-list" ? args[2] === `${head}..refs/heads/main` ? missing : "2" : null;
    const row = (missing: string | null, main: string | null = "main") => checklistFromAssignment(store, "ready", assignment, null, { main }, git(missing)).rows.find(one => one.key === "up-to-date")!;
    expect(row("0")).toMatchObject({ mark: "yes", say: "Up to date with main." });
    expect(row("2")).toMatchObject({ mark: "no", act: { kind: "fix", run: runs["ready"] } });
    expect(row(null)).toMatchObject({ mark: "unknown", say: NOT_RECORDED_LOCAL });
    expect(row("0", null)).toMatchObject({ mark: "unknown", say: NOT_RECORDED_LOCAL });
    const landed = checklistFromAssignment(store, "ready", assignment, "Landed on main (abc1234).");
    expect(landed).toMatchObject({ answer: "landed", sentence: "Landed on main (abc1234).", rows: [] });
    expect(checklistLines(landed)).toEqual(["Landed on main (abc1234)."]);
  });

  test("the plan: an unapproved plan is in the way, and nothing is built", () => {
    expect(rowOf("draft", "plan")).toMatchObject({ mark: "no", say: "The plan waits for your approval.", act: null });
    expect(rowOf("draft", "build").mark).toBe("waiting");
  });

  test("the build: a failed task carries Retry", () => {
    expect(rowOf("failed", "build")).toMatchObject({ mark: "no", act: { kind: "retry", taskId: "failed" } });
  });

  test("the checks: none ran on this commit carries Run checks on that build", () => {
    // No sealed check for its commit reads as one that can't be read, as the Checks row says it.
    expect(rowOf("unchecked", "checks")).toMatchObject({ mark: "no", say: "The check result couldn't be read.", act: { kind: "run-checks", run: runs["unchecked"] } });
    // In plain text (the CLI, the terminal UI) the act says where it is, never a bracketed button nobody can press.
    const lines = checklistLines(listOf("unchecked")).join("\n");
    expect(lines).toContain("Next: Run checks, on the task's page.");
    expect(lines).not.toContain("[Run checks]");
  });

  test("the requirements: a result that doesn't match its plan carries Ask the agent to fix, its note naming the blocker", () => {
    const row = rowOf("refuted", "requirements");
    expect(row.mark).toBe("no");
    expect(row.act).toMatchObject({ kind: "fix", run: runs["refuted"] });
    expect(row.act?.kind === "fix" ? row.act.note : "").not.toBe("");
    expect(rowOf("refuted", "checks").mark).toBe("yes");
  });

  test("the requirements: one only a person can confirm, not confirmed yet, waits on them; checks passing don't make it met", () => {
    expect(rowOf("person", "checks").mark).toBe("yes");
    expect(rowOf("person", "requirements")).toMatchObject({ mark: "waiting", say: "You check 1 requirement.", act: null });
    const list = listOf("person");
    expect(list.answer).toBe("not-yet");
    expect(list.sentence).toBe("Not yet: requirements met — You check 1 requirement.");
  });

  test("review comments: a saved note not sent back yet is in the way, and only that row changes", () => {
    const before = listOf("noted").rows.map(one => [one.key, one.mark]);
    const diff = store.artifactsFor(runs["noted"]!).find(one => one.kind === "terminal-diff")!;
    store.addDiffComment({ artifactId: diff.id, runId: runs["noted"]!, path: "src/footer.ts", line: 1, note: "Keep the old label.", author: "sam", sourceKey: null, image: null }, NOW);
    const after = listOf("noted").rows.map(one => [one.key, one.mark]);
    expect(after.filter((one, index) => one[1] !== before[index]![1])).toEqual([["comments", "no"]]);
    expect(rowOf("noted", "comments")).toMatchObject({ say: "1 note not sent back yet.", act: { kind: "fix", note: "" } });
  });

  test("the pull request and PR CI: read from the publication and its follow, on the exact head", () => {
    const run = runs["ready"]!;
    const ref = store.lookupRef("ready")!.id;
    store.savePublicationGrant({ repo: REPO, githubRepo: "o/r", remote: "origin", headPrefix: "so/", base: "main", capabilities: ["push-branch", "open-pr"], selector: "ours", draft: false, grantedBy: "sam", publishOn: "complete" }, NOW);
    const head = store.getRun(run)!.headRevision!;
    const publication = store.createPublicationIntent({ run, taskRef: ref, githubRepo: "o/r", remote: "origin", base: "main", head: "so/ready", headSha: head, bodyHash: "h", draft: false }, NOW);
    store.handle.prepare("UPDATE publication SET state = 'opened', pr_number = 7, last_check_state = 'failing' WHERE id = ?").run(publication);
    store.handle.prepare("INSERT INTO pull_request_follow (publication, created_at, updated_at) VALUES (?, ?, ?)").run(publication, NOW.toISOString(), NOW.toISOString());
    expect(rowOf("ready", "pull-request")).toMatchObject({ mark: "yes", say: "#7 is open." });
    expect(rowOf("ready", "pr-ci")).toMatchObject({ mark: "no", act: { kind: "fix", run } });
    store.handle.prepare("UPDATE publication SET last_check_state = 'passing' WHERE id = ?").run(publication);
    store.handle.prepare("UPDATE pull_request_follow SET ready_head = ? WHERE publication = ?").run(head, publication);
    expect(rowOf("ready", "pr-ci")).toMatchObject({ mark: "yes", say: `Passed on ${head.slice(0, 7)}.`, act: null });
  });
});

describe("one checklist on every surface", () => {
  test("`toolroll task ready` (--json) is the same checklist, and its lines are the checklist's lines", async () => {
    const out: string[] = [];
    await runOperate("task", ["ready", "refuted", "--json", "--db", file], line => { out.push(line); }, { now: NOW });
    const answer = JSON.parse(out.join("\n")) as Record<string, unknown>;
    const list = listOf("refuted");
    expect(answer).toMatchObject({ ok: true, command: "task ready", answer: list.answer, sentence: list.sentence, rows: JSON.parse(JSON.stringify(list.rows)) });
    const human: string[] = [];
    await runOperate("task", ["ready", "refuted", "--db", file], line => { human.push(line); }, { now: NOW });
    expect(human.join("\n")).toContain(checklistLines(list).join("\n"));
    const missing: string[] = [];
    await runOperate("task", ["ready", "no-such", "--json", "--db", file], line => { missing.push(line); }, { now: NOW });
    expect(JSON.parse(missing.join("\n"))).toMatchObject({ ok: false, reason: "unknown-task" });
  });

  test("the task page's panel shows the same rows, and Ask the agent to fix is Send back: the same terms and the same revision", async () => {
    const page = await http("/t/refuted");
    expect(page.status).toBe(200);
    const view = workspaceOf(page.body).view as { kind: string; mergeReady?: { answer: string; rows: { key: string; mark: string; act: { kind: string; action?: string; note?: string; batch?: string; source?: string; request?: string } | null }[] } };
    const list = listOf("refuted");
    expect(view.mergeReady?.answer).toBe(list.answer);
    expect(view.mergeReady?.rows.map(one => [one.key, one.mark])).toEqual(list.rows.filter(one => one.mark !== "skip").map(one => [one.key, one.mark]));
    const fix = view.mergeReady!.rows.find(one => one.key === "requirements")!.act!;
    expect(fix).toMatchObject({ kind: "fix", action: `/r/${runs["refuted"]}/comment` });
    // The result's own Send back form binds the same note batch and source terms.
    const result = await http(`/t/refuted?tab=result&run=${runs["refuted"]}`);
    expect({ batch: fix.batch, source: fix.source }).toEqual(revisionFormOf(result.body));
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(result.body)![1]!;
    const sent = await http(fix.action!, { method: "POST", body: new URLSearchParams({ csrf, intent: "revise", batch: fix.batch!, source: fix.source!, request: fix.request!, return: "/t/refuted", note: fix.note! }).toString() });
    expect(sent.status).toBe(303);
    // The revision it filed carries the blocker's note as its feedback, exactly as Send back's would.
    const family = store.taskFamilyOf("refuted", [REPO], false)!;
    expect(family.versions.length).toBe(2);
    const consumed = store.allDiffComments(runs["refuted"]!).filter(one => one.consumedBy === family.current.id);
    expect(consumed.map(one => one.note)).toEqual([fix.note]);
    // The revision hasn't built yet: its attempts still count the family's builds (attempt N is the Nth build of the task).
    const cards = stepCardsOf({ store, family, now: NOW, access: { principal: "operator", repos: [REPO] }, evidenceRoot: ev });
    expect(cards.cards?.find(one => one.key === "build")?.runs ?? []).toEqual([]);
    expect(cards.familyBuilds).toEqual([runs["refuted"]]);
  });
});

describe("a project with no check set", () => {
  test("says where to set one and offers no Run checks; once a command exists, a result it didn't run on keeps Run checks", () => {
    const live = store.liveVerifyCommand(REPO)!;
    try {
      store.clearVerifyCommand(REPO, "sam", ago(30));
      built("no-check", ago(25), "attested");
      expect(rowOf("no-check", "checks")).toEqual({ key: "checks", label: "Project checks passed on this commit", mark: "note",
        say: "No check is set for merge-ready. Set one in Settings → Projects → merge-ready → Checks.", act: null });
      expect(noCheckSetWords(REPO)).toBe("No check is set for merge-ready. Set one in Settings → Projects → merge-ready → Checks.");
      // Never says a check passed or ran when none did.
      expect(checklistLines(listOf("no-check")).join("\n")).not.toMatch(/Passed on|Running now/);
    } finally {
      store.setVerifyCommand({ repo: REPO, command: live.command, timeoutMs: live.timeoutMs, approvedBy: "sam" }, ago(20));
    }
    // The same result, now that the project has a check: it didn't run on this commit, so Run checks stays.
    expect(rowOf("no-check", "checks")).toMatchObject({ mark: "no", act: { kind: "run-checks", run: runs["no-check"] } });
    expect(rowOf("no-check", "checks").say).not.toMatch(/No check is set/);
  });
});

describe("accepted work reads as accepted (stranger 17)", () => {
  // A project without pull requests, as Land needs (an earlier test granted publishing here).
  beforeAll(() => { store.revokePublicationGrant(REPO, "sam", ago(20)); });
  function accept(id: string, at: Date): void {
    const who = verifyApproverByPassword(store, "sam", password, [REPO]);
    if (!who.ok) throw new Error("who");
    const read = assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, ev)!;
    const done = acceptAndCompleteAsOperator(store, id, { runId: read.receipt!.runId, receiptDigest: read.receipt!.digest, note: null }, who.who, at, ev);
    if (!done.ok) throw new Error(done.message);
  }

  test("the acceptance answers its \"You check\" requirement; Can I merge? agrees with Land; out-of-date checks still say Not yet", () => {
    built("accepted", ago(15), "person");
    expect(rowOf("accepted", "requirements").mark).toBe("waiting");
    accept("accepted", ago(14));
    expect(rowOf("accepted", "requirements")).toMatchObject({ mark: "yes", say: "Accepted by sam.", act: null });
    expect(listOf("accepted").answer).toBe("yes");
    // The check command changed since: Land refuses until they run again, and so does the answer, with the reason.
    const live = store.liveVerifyCommand(REPO)!;
    try {
      store.setVerifyCommand({ repo: REPO, command: "npm test && node -e 1", timeoutMs: live.timeoutMs, approvedBy: "sam" }, ago(10));
      const list = listOf("accepted");
      expect(list.answer).toBe("no");
      expect(list.rows.find(one => one.key === "checks")).toMatchObject({ mark: "no", act: { kind: "run-checks" } });
      expect(list.rows.find(one => one.key === "requirements")).toMatchObject({ mark: "yes", say: "Accepted by sam." });
    } finally {
      store.setVerifyCommand({ repo: REPO, command: live.command, timeoutMs: live.timeoutMs, approvedBy: "sam" }, ago(9));
    }
  });

  test("the result page offers no Looks right / Not right on accepted work, and the page's panel says it is accepted", async () => {
    const open = await http(`/t/person?tab=result&run=${runs["person"]}`);
    expect(open.body).toContain('"youCheck":{');
    // Marked complete with no acceptance of its own on record (Mark complete, the terminal's a): still accepted.
    built("marked", ago(8.9), "person");
    const who = verifyApproverByPassword(store, "sam", password, [REPO]);
    if (!who.ok) throw new Error("who");
    const marked = checkAssignmentAsOperator(store, "marked", assignmentOf(store, "marked", NOW, { principal: "operator", repos: [REPO] }, ev)!.receipt!.digest, who.who, ago(8.8), ev);
    expect(marked.ok).toBe(true);
    expect(rowOf("marked", "requirements")).toMatchObject({ mark: "yes", say: "Accepted by sam." });
    expect((await http(`/t/marked?tab=result&run=${runs["marked"]}`)).body).not.toContain('"youCheck":{');
    const page = await http(`/t/accepted?tab=result&run=${runs["accepted"]}`);
    expect(page.status).toBe(200);
    expect(page.body).not.toContain('"youCheck":{');
    const task = workspaceOf((await http("/t/accepted")).body).view as { mergeReady?: { answer: string; rows: { key: string; mark: string; say: string }[] } };
    expect(task.mergeReady?.rows.find(one => one.key === "requirements")).toMatchObject({ mark: "yes", say: "Accepted by sam." });
  });

  test("work the lead's token completed keeps the person's own check open: not met, no \"Accepted by\", Looks right still offered (review round 1)", async () => {
    built("machine-done", ago(8.7), "person");
    const who = verifyApproverByPassword(store, "sam", password, [REPO]);
    if (!who.ok) throw new Error("who");
    const digest = assignmentOf(store, "machine-done", NOW, { principal: "operator", repos: [REPO] }, ev)!.receipt!.digest;
    expect(withActor({ account: "sam", lead: true }, () => checkAssignmentAsOperator(store, "machine-done", digest, who.who, ago(8.6), ev)).ok).toBe(true);
    const read = assignmentOf(store, "machine-done", NOW, { principal: "operator", repos: [REPO] }, ev)!;
    expect(read.state).toBe("complete");
    expect(read.completion?.person).toBeUndefined();
    expect(rowOf("machine-done", "requirements")).toMatchObject({ mark: "waiting", say: "You check 1 requirement." });
    expect(listOf("machine-done").answer).toBe("not-yet");
    expect((await http(`/t/machine-done?tab=result&run=${runs["machine-done"]}`)).body).toContain('"youCheck":{');
    const requirements = (id: string) => statusOf(assignmentStatusFacts(assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, ev)!)).details.find(one => one.key === "requirements")?.text;
    expect(requirements("machine-done")).toBe("0 of 1 met · You check 1");
    // The person's own Accept on it (offered on the result, review round 2) records their yes to this exact receipt.
    const page = await http(`/t/machine-done?tab=result&run=${runs["machine-done"]}`);
    expect(page.body).toContain('"action":"/t/machine-done/complete"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page.body)![1]!;
    const posted = await http("/t/machine-done/complete", { method: "POST", body: new URLSearchParams({ csrf, run: String(runs["machine-done"]), receipt: read.receipt!.digest, accept: "1" }).toString() });
    expect(posted.status).toBe(303);
    const confirmed = assignmentOf(store, "machine-done", NOW, { principal: "operator", repos: [REPO] }, ev)!;
    expect(confirmed).toMatchObject({ state: "complete", completion: { person: "sam", digest: read.receipt!.digest } });
    expect(rowOf("machine-done", "requirements")).toMatchObject({ mark: "yes", say: "Accepted by sam." });
    expect(requirements("machine-done")).toBe("1 of 1 met");
    // A person's own completion (the terminal's a, Mark complete) answers it.
    expect(assignmentOf(store, "marked", NOW, { principal: "operator", repos: [REPO] }, ev)!.completion?.person).toBe("sam");
    expect(requirements("marked")).toBe("1 of 1 met");
  });

  test("landed work: the workbench's rows carry where it landed; work never landed carries nothing", async () => {
    const head = store.getRun(runs["accepted"]!)!.headRevision!;
    const commit = "c".repeat(40);
    const at = ago(9.5).toISOString();
    const intent = recordActionWhole(store.handle, { at, actor: "operator:sam", repo: REPO, taskId: "accepted", runId: runs["accepted"]!, action: LAND_INTENT, outcome: "pending", source: "request" },
      { v: 1, kind: "land", key: "k", ref: "refs/heads/main", old: "1".repeat(40), commit, mode: "ref", policy: "squash", candidate: head });
    recordActionWhole(store.handle, { at, actor: "toolroll", repo: REPO, taskId: "accepted", runId: runs["accepted"]!, action: LAND_SETTLED, outcome: `${intent}:landed`, source: "work" }, { v: 1 });
    const none = () => null;
    const rows = [{ rootId: "accepted", repo: REPO, resultRunId: runs["accepted"]!, assignmentState: "complete" },
      { rootId: "marked", repo: REPO, resultRunId: runs["marked"]!, assignmentState: "complete" },
      { rootId: "person", repo: REPO, resultRunId: runs["person"]!, assignmentState: "ready-to-check" }];
    expect([...landedRowsOf(store, rows, none)]).toEqual([["accepted", "Landed on main (ccccccc)"]]);
    const answer = await http("/work/rows", { method: "GET" });
    expect(answer.status).toBe(200);
    const listed = (JSON.parse(answer.body) as { rows: { id: string; landed?: string }[] }).rows;
    expect(listed.find(one => one.id === "accepted")?.landed).toBe("Landed on main (ccccccc)");
    expect(listed.find(one => one.id === "marked")).not.toHaveProperty("landed");
    // `toolroll task list` says it with the same short mark.
    const out: string[] = [];
    await runOperate("task", ["list", "--db", file], line => { out.push(line); }, { now: NOW });
    expect(out.find(line => line.includes("Task accepted"))).toMatch(/Complete\s+Task accepted · landed on main \(ccccccc\)$/);
    expect(out.find(line => line.includes("Task marked"))).toMatch(/Complete\s+Task marked$/);
    // `toolroll task show`: where it landed first, under the title; checked says who accepted it, nothing pending.
    const shown: string[] = [];
    await runOperate("task", ["show", "accepted", "--db", file], line => { shown.push(line); }, { now: NOW });
    const lines = shown.join("\n").split("\n");
    expect(lines.slice(0, 3)).toEqual(["accepted  Complete", "  Task accepted", "  landing: Landed on main (ccccccc)."]);
    expect(lines).toContain("  checked: accepted by sam");
    expect(lines.join("\n")).not.toMatch(/awaiting|not all requirements shown yet|doesn't match/);
  });

  test("no check set is a note, not a blocker: accepted work with no check answers yes, as Land lands it", () => {
    const live = store.liveVerifyCommand(REPO)!;
    try {
      store.clearVerifyCommand(REPO, "sam", ago(8.5));
      built("accepted-no-check", ago(8), "attested");
      expect(rowOf("accepted-no-check", "checks")).toMatchObject({ mark: "note", say: noCheckSetWords(REPO), act: null });
      accept("accepted-no-check", ago(7));
      const list = listOf("accepted-no-check");
      expect(list.rows.filter(one => one.mark === "no")).toEqual([]);
      expect(list.answer).toBe("yes");
      expect(checklistLines(list).join("\n")).toContain(`– Project checks passed on this commit: ${noCheckSetWords(REPO)}`);
    } finally {
      store.setVerifyCommand({ repo: REPO, command: live.command, timeoutMs: live.timeoutMs, approvedBy: "sam" }, ago(5));
    }
  });
});
