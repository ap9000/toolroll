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
import { checklistLines, mergeChecklistOf, noCheckSetWords, NOT_RECORDED, type ChecklistKey, type MergeChecklist } from "./merge-checklist.js";
import { revisionFormOf, workspaceOf } from "../test/serve-kit.js";

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
function built(id: string, at: Date, kind: "verified" | "refuted" | "failed" | "unchecked" | "attested" = "verified"): number {
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
  const reasons = kind === "refuted" ? ["claimed changed path not in the sealed diff: src/other.ts"] : [];
  store.saveProofVerdict(run, kind === "refuted" ? "refuted" : kind === "attested" ? "attested" : "verified", reasons, at, [{ id: "c1", statement: "The footer link opens.", requiredEvidence: ["check"], state: kind === "refuted" ? "failed" : "pass", detail: [], answered: [], review: null }] as never, kind === "refuted" ? "refuted" : kind === "attested" ? "attested" : "verified");
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
    expect(list.rows.find(one => one.key === "up-to-date")!.say).toBe(NOT_RECORDED);
    expect(list.answer).toBe("yes");
    expect(list.sentence).toBe("Yes, as far as Toolroll records. Check up to date with main and no conflicts on GitHub.");
    expect(list.rows.every(one => one.act === null)).toBe(true);
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
  });

  test("the requirements: a result that doesn't match its plan carries Ask the agent to fix, its note naming the blocker", () => {
    const row = rowOf("refuted", "requirements");
    expect(row.mark).toBe("no");
    expect(row.act).toMatchObject({ kind: "fix", run: runs["refuted"] });
    expect(row.act?.kind === "fix" ? row.act.note : "").not.toBe("");
    expect(rowOf("refuted", "checks").mark).toBe("yes");
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
    const result = await http(`/review?result=refuted&run=${runs["refuted"]}`);
    expect({ batch: fix.batch, source: fix.source }).toEqual(revisionFormOf(result.body));
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(result.body)![1]!;
    const sent = await http(fix.action!, { method: "POST", body: new URLSearchParams({ csrf, intent: "revise", batch: fix.batch!, source: fix.source!, request: fix.request!, return: "/t/refuted", note: fix.note! }).toString() });
    expect(sent.status).toBe(303);
    // The revision it filed carries the blocker's note as its feedback, exactly as Send back's would.
    const family = store.taskFamilyOf("refuted", [REPO], false)!;
    expect(family.versions.length).toBe(2);
    const consumed = store.allDiffComments(runs["refuted"]!).filter(one => one.consumedBy === family.current.id);
    expect(consumed.map(one => one.note)).toEqual([fix.note]);
  });
});

describe("a project with no check set", () => {
  test("says where to set one and offers no Run checks; once a command exists, a result it didn't run on keeps Run checks", () => {
    const live = store.liveVerifyCommand(REPO)!;
    try {
      store.clearVerifyCommand(REPO, "sam", ago(30));
      built("no-check", ago(25), "attested");
      expect(rowOf("no-check", "checks")).toEqual({ key: "checks", label: "Project checks passed on this commit", mark: "no",
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
