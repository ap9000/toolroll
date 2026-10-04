/** Every Needs you says what it needs in one plain sentence and leads with
 * the action that resolves it (needs-you.ts). Seen Oct 1 on a phone: a
 * finished build Toolroll couldn't prove stopped read "run #2175 has an
 * incomplete spawn witness; exit is unproven" with only Request changes. */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { ASKS, BANNED_WORDS, CODE_NEED, NEED_ASK, NEEDS, WAITS, hasInternalWords, processNeedOf, type NeedKey, type WaitKey } from "./needs-you.js";
import { stageOfCode, taskStatusOf } from "./task-status.js";
import { assignmentActionHref } from "./assignment-ui.js";
import { browserWorkActionHref } from "./browser-crew.js";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { MARKER } from "./worktree.js";
import { createDecisionServer, needActionOf } from "./serve.js";
import { assignmentOf, type AssignmentSnapshot } from "./assignment.js";
import { assignmentPresentationOf } from "./assignment-presentation.js";
import { askOfCode, workIndexPage } from "./work-index.js";
import { assignmentCatchUp } from "./assignment-brief.js";
import { leadBriefHtml } from "./lead-context.js";
import type { WorkAction } from "./work-summary.js";
import type { WorkIndexItem } from "./work-index.js";
import type { BrowserWorkspace } from "./browser-workspace.js";

const NEED_KEYS = Object.keys(NEEDS) as NeedKey[];
const WAIT_KEYS = Object.keys(WAITS) as WaitKey[];

/** The action as each surface links it: the task page's own anchor or route, never nothing. */
function hrefsFor(code: string): { assignment: string | null; index: string | null } {
  const action = { code, label: "x", target: { taskId: "t-1", runId: 7, decisionId: null }, access: "read", retry: "read-again" } as unknown as WorkAction;
  const assignment = { rootId: "t-1", repo: "/r", publication: null, primaryAction: action } as unknown as AssignmentSnapshot;
  const item = { rootId: "t-1", repo: "/r", publicationUrl: null, primaryAction: action } as unknown as WorkIndexItem;
  return { assignment: assignmentActionHref(assignment), index: browserWorkActionHref(item) };
}

describe("every reason", () => {
  test("each Needs you reason has one plain sentence and an action that leads somewhere", () => {
    for (const key of NEED_KEYS) {
      for (const context of [{}, { build: 2175 }, { build: 2175, provider: "Claude" }]) {
        const status = taskStatusOf({ stage: "needs-you", need: key, needContext: context });
        expect(status.headline, key).toBe("Needs you");
        expect(hasInternalWords(status.sentence), `${key}: ${status.sentence}`).toBe(false);
        for (const word of BANNED_WORDS) expect(status.sentence.toLowerCase(), key).not.toContain(word);
        expect(status.sentence, key).toMatch(/^[A-Z].*[.]$/);
        expect(status.need, key).toEqual({ key, action: NEEDS[key].action });
        expect(status.primaryAction?.label, key).toBe(NEEDS[key].action.label);
      }
      // A flow card's approval is its own button on the card; every other action is a link.
      if (key === "card") continue;
      const { assignment, index } = hrefsFor(NEEDS[key].action.code);
      expect(assignment, key).toMatch(/^\//);
      expect(index, key).toMatch(/^\//);
    }
  });

  test("a recorded reason with internal words never becomes the sentence", () => {
    const leaked = "run #2175 has an incomplete spawn witness; exit is unproven";
    for (const key of NEED_KEYS) expect(taskStatusOf({ stage: "needs-you", need: key, reason: leaked }).sentence, key).not.toBe(leaked);
    expect(taskStatusOf({ stage: "needs-you", need: "answer", reason: "Which port should the API use?" }).sentence).toBe("Which port should the API use?");
    expect(taskStatusOf({ stage: "waiting", reason: "the scope digest moved" }).sentence).not.toContain("digest");
  });

  test("a reason no person can act on reads Waiting, with what it waits for", () => {
    for (const key of WAIT_KEYS) {
      const status = taskStatusOf({ stage: "waiting", wait: key, needContext: { build: 2175 } });
      expect(status.headline, key).toBe("Waiting");
      expect(status.tone, key).toBe("neutral");
      expect(status.need, key).toBeNull();
      expect(hasInternalWords(status.sentence), key).toBe(false);
      expect(status.sentence, key).toMatch(key === "build-finishing" ? /^Finishing up; this clears on its own\.$/ : /^Waiting /);
    }
  });

  test("every dispatch code that waits on a person names its need", () => {
    for (const [code, key] of Object.entries(CODE_NEED)) {
      const read = stageOfCode(code, { needsPerson: true });
      if (read.stage !== "needs-you") continue;
      expect(read.need, code).toBe(key);
    }
    expect(stageOfCode("held", { operatorHold: false })).toEqual({ stage: "needs-you", need: "hold" });
  });

  test("every need asks one thing: a choice to make, a result to review, or something to clear", () => {
    for (const key of Object.keys(NEEDS) as NeedKey[]) expect(ASKS, key).toContain(NEED_ASK[key]);
    // The Tasks list groups by the same asks, read from the index code.
    for (const code of ["needs-approval", "waiting-decision", "decision-queue", "needs-project", "needs-scope", "invalid-scope", "needs-agent-profile"]) expect(askOfCode(code), code).toBe("decide");
    for (const code of ["ready-to-check", "result-needs-attention"]) expect(askOfCode(code), code).toBe("review");
    for (const code of ["signed-out", "no-worker-online", "no-worker-registered", "terminal-dependency", "failed", "waiting-incident", "vanished-run", "held", "stopped", "missing-requirement", "process-needs-attention", "earlier-active", "history-problem"])
      expect(askOfCode(code), code).toBe("unblock");
    // A saved result whose build may still run is cleared first, not reviewed.
    expect(askOfCode("result-needs-attention", true)).toBe("unblock");
  });

  test("a build Toolroll can't confirm stopped is a person's act only when nothing of it may run", () => {
    expect(processNeedOf({ run: 9, kind: "unprovable" })).toEqual({ need: "confirm-stopped", build: 9 });
    expect(processNeedOf({ run: 9, kind: "alive" })).toEqual({ wait: "build-stopping", build: 9 });
    expect(processNeedOf({ run: 9, kind: "open" })).toEqual({ wait: "build-stopping", build: 9 });
    expect(processNeedOf({ run: 9, kind: "settling" })).toEqual({ wait: "build-finishing", build: 9 });
    expect(processNeedOf({ run: 9, kind: "elsewhere" })).toEqual({ wait: "other-computer", build: 9 });
    // Toolroll can't look at all: the person checks; it never says nothing is running.
    expect(processNeedOf({ run: 9, kind: "unknown" })).toEqual({ need: "check-stopped", build: 9 });
    expect(taskStatusOf({ stage: "needs-you", need: "check-stopped", needContext: { build: 2175 } }).sentence)
      .toBe("Toolroll can't check whether build #2175 stopped. Make sure nothing from it is running, then confirm.");
    expect(processNeedOf(null)).toBeNull();
    expect(taskStatusOf({ stage: "needs-you", need: "confirm-stopped", needContext: { build: 2175 } }).sentence)
      .toBe("Toolroll can't confirm build #2175 stopped. Nothing from it is running.");
  });
});

describe("Confirm it stopped, end to end", () => {
  const NOW = new Date();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  let dir: string, REPO: string, HEAD: string, root: string, password: string, cookie: string, base: string;
  let store: Store;
  let server: Server;
  const runs: Record<string, number> = {};

  const workspaceOf = (html: string): BrowserWorkspace => JSON.parse(/<script type="application\/json" id="standing-orders-workspace-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!);
  const page = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
  const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const post = async (path: string, fields: Record<string, string>) =>
    fetch(`${base}${path}`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), redirect: "manual" });
  const assignment = (id: string) => assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, root)!;
  const witness = (run: number, pid: number | null) => store.raw().prepare("INSERT INTO run_process (run, pid, host, process_group, observed_at) VALUES (?, ?, ?, 0, ?)").run(run, pid, hostname(), NOW.toISOString());
  const ended = (run: number) => store.raw().prepare("INSERT INTO run_process (run, pid, host, process_group, observed_at, exited_at) VALUES (?, NULL, ?, 0, ?, ?)").run(run, hostname(), NOW.toISOString(), NOW.toISOString());
  const listed = (view: "all" | "needs-you" = "all") => workIndexPage(store, NOW, { principal: "operator", repos: [REPO] }, { view });

  const worktreeFor = (id: string) => { const path = join(dir, `wt-${id}`); execFileSync("mkdir", ["-p", path]); return path; };
  /** A finished build whose project check passed: Ready once Toolroll knows it stopped. */
  function built(id: string, title: string): number {
    store.createTask({ id, title }, NOW);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO, {}, NOW);
    const proposed = propose(store, { taskId: id, goal: title, touches: ["src/"], acceptance: [{ id: "c1", statement: title, how: null, evidence: ["manual-review"] }], now: NOW });
    const ok = approve(store, id, "sam", NOW, proposed.digest, password);
    if (!ok.ok) throw new Error(ok.reason);
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: worktreeFor(id), route: authority.stamp, now: NOW });
    store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
    store.recordOutcomeFacts(run, { headRevision: HEAD, handoff: `${title}.` });
    store.raw().prepare("UPDATE run SET provider_started_at = ? WHERE id = ?").run(NOW.toISOString(), run);
    store.finishRun(run, { outcome: "built", committed: true, now: NOW });
    store.setTaskState(id, "done", NOW);
    store.saveProofVerdict(run, "attested", [], NOW, [{ id: "c1", statement: title, requiredEvidence: ["manual-review"], state: "manual-review", detail: [], answered: [], review: null }] as never, "attested");
    storeEvidence(store, root, run, "terminal-diff", "diff.patch", Buffer.from(`diff --git a/src/${id}.ts b/src/${id}.ts\n--- a/src/${id}.ts\n+++ b/src/${id}.ts\n@@ -1 +1 @@\n-a\n+b\n`), "git diff (exit 0)", NOW, { captureStatus: "ok" });
    store.recordRunCheck(run, { status: "not-run", exitCode: null, suites: [] }, NOW);
    runs[id] = run;
    return run;
  }

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "needs-you-")));
    REPO = join(dir, "storefront");
    execFileSync("mkdir", ["-p", REPO]);
    git(REPO, "init", "-q", "-b", "main");
    writeFileSync(join(REPO, "app.txt"), "v1\n");
    git(REPO, "add", ".");
    git(REPO, "commit", "-q", "-m", "first");
    HEAD = git(REPO, "rev-parse", "HEAD");
    root = join(dir, "evidence");
    store = openStore(join(dir, "orders.db"));
    register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok-builder-1" });
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
    const sam = addApprover(store, "sam", NOW);
    if (!sam.ok) throw new Error("approver");
    password = sam.token;
    // The incident: a spawn witness reserved, its pid never written.
    witness(built("spawn-gap", "Release check"), null);
    // Spawned before any witness was written at all.
    built("no-record", "Rotate the log format");
    // Something of it may still be running: this very test process.
    witness(built("still-alive", "Cache the product list"), process.pid);
    // Toolroll can't look: its workspace note can't be read, or its OS object never finished being recorded.
    const unreadable = built("unreadable", "Trim the image cache");
    ended(unreadable);
    mkdirSync(join(store.getRun(unreadable)!.worktree!, MARKER));
    const halfContained = built("half-contained", "Resize the thumbnails");
    store.raw().prepare("INSERT INTO run_process (run, pid, host, process_group, observed_at, containment) VALUES (?, NULL, ?, 0, ?, 'job-object')").run(halfContained, hostname(), NOW.toISOString());
    // Its process is gone but its exit was never written down: the store settles it on reading, so must the list.
    witness(built("exited-quietly", "Bump the font size"), spawnSync("true").pid!);
    // Stopped, but no verdict was recorded and it was built to an earlier plan: building again resolves it, accepting would not.
    const unverified = built("unverified", "Rename the checkout button");
    ended(unverified);
    store.raw().prepare("DELETE FROM proof_verdict WHERE run = ?").run(unverified);
    store.raw().prepare("UPDATE run SET scope_digest = ? WHERE id = ?").run("0".repeat(32), unverified);
    server = createDecisionServer({ store, evidenceRoot: root, repo: REPO, clock: () => new Date() });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "sam", token: password }), redirect: "manual" });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  });

  afterAll(async () => {
    if (server !== undefined) await new Promise<void>(done => server.close(() => done()));
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the result reads in plain words, with Confirm it stopped first", async () => {
    for (const id of ["spawn-gap", "no-record"]) {
      const read = assignment(id);
      const presentation = assignmentPresentationOf(read);
      expect(read.state, id).toBe("needs-decision");
      expect(presentation.taskStatus.headline, id).toBe("Needs you");
      expect(presentation.taskStatus.sentence, id).toBe(`Toolroll can't confirm build #${runs[id]} stopped. Nothing from it is running.`);
      expect(read.primaryAction, id).toMatchObject({ code: "confirm-stopped", label: "Confirm it stopped", target: { runId: runs[id] } });
      expect(read.attention.some(hasInternalWords), id).toBe(false);
    }
    // The result page (desktop and phone render the same view): the need's action, then Request changes beside it.
    const result = workspaceOf(await page(`/review?result=spawn-gap&run=${runs["spawn-gap"]}`)).view as Extract<BrowserWorkspace["view"], { kind: "result" }>;
    const panel = result.selected!.panel!;
    expect(panel.status?.headline).toBe("Needs you");
    expect(hasInternalWords(panel.status!.sentence)).toBe(false);
    expect(panel.need).toMatchObject({ label: "Confirm it stopped", confirm: { action: "/t/spawn-gap/confirm-stopped", run: runs["spawn-gap"] } });
    // The task page: the same words, and the form behind the password.
    const task = workspaceOf(await page("/t/spawn-gap")).view as Extract<BrowserWorkspace["view"], { kind: "task" }>;
    expect(task.status?.status.headline).toBe("Needs you");
    expect(task.status?.action?.label).toBe("Confirm it stopped");
    expect(task.confirmStopped).toEqual({ action: "/t/spawn-gap/confirm-stopped", run: runs["spawn-gap"], checked: false });
  });

  test("a build Toolroll can't check says so, and confirming asks the person to say they checked", async () => {
    for (const id of ["unreadable", "half-contained"]) {
      expect(store.stopQuiescenceFact(runs[id]!)?.kind, id).toBe("unknown");
      const status = assignmentPresentationOf(assignment(id)).taskStatus;
      expect(status.headline, id).toBe("Needs you");
      expect(status.sentence, id).toBe(`Toolroll can't check whether build #${runs[id]} stopped. Make sure nothing from it is running, then confirm.`);
      expect(status.sentence, id).not.toContain("Nothing from it is running");
      const task = workspaceOf(await page(`/t/${id}`)).view as Extract<BrowserWorkspace["view"], { kind: "task" }>;
      expect(task.confirmStopped, id).toEqual({ action: `/t/${id}/confirm-stopped`, run: runs[id], checked: true });
      const result = workspaceOf(await page(`/review?result=${id}&run=${runs[id]}`)).view as Extract<BrowserWorkspace["view"], { kind: "result" }>;
      expect(result.selected!.panel!.need?.confirm?.checked, id).toBe(true);
      expect(listed("needs-you").items.find(one => one.rootId === id)?.status.detail, id).toContain("can't check");
      // Never one click: without the tick it is refused, and nothing changes.
      const html = await page(`/t/${id}`);
      const unticked = await post(`/t/${id}/confirm-stopped`, { csrf: csrfOf(html), run: String(runs[id]), token: password });
      expect(unticked.status, id).toBe(409);
      expect(store.stopQuiescenceFact(runs[id]!)?.kind, id).toBe("unknown");
      const confirmed = await post(`/t/${id}/confirm-stopped`, { csrf: csrfOf(html), run: String(runs[id]), token: password, checked: "yes" });
      expect(confirmed.status, id).toBe(303);
      expect(store.stopQuiescenceFact(runs[id]!), id).toBeNull();
      expect(assignmentPresentationOf(assignment(id)).taskStatus.headline, id).toBe("Ready for review");
      expect(listed().items.find(one => one.rootId === id)?.status.label, id).toBe("Ready for review");
    }
  });

  test("a workspace still held by a live process can't be confirmed stopped", () => {
    const run = built("held-workspace", "Compress the logs");
    ended(run);
    writeFileSync(join(store.getRun(run)!.worktree!, MARKER), `${process.pid} builder-1 group\n`);
    expect(store.stopQuiescenceFact(run)?.kind).toBe("alive");
    expect(store.settleRunWitnessesByApprover({ runId: run, by: "sam", why: "test" }, NOW)).toMatchObject({ ok: false, reason: "alive" });
  });

  test.each([false, true])("an exited witness permits completion without changing a passed check (group=%s)", async group => {
    const id = group ? "reused-group" : "reused-process", run = built(id, "Verify the release candidate");
    // This live PID represents an unrelated process. Its historical witness
    // exited before the run ended; no birth lookup or permission is needed.
    witness(run, process.pid);
    store.raw().prepare("UPDATE run_process SET exited_at=?, process_group=? WHERE run=?").run(NOW.toISOString(), group ? 1 : 0, run);
    store.recordRunCheck(run, { status: "passed", exitCode: 0, suites: [] }, NOW);
    if (!group) expect(store.settleRunWitnessesByApprover({ runId: run, by: "sam", why: "The check ended." }, NOW)).toMatchObject({ ok: true });
    expect(store.stopQuiescenceFact(run)).toBeNull();
    const read = assignment(id);
    expect(read.state).toBe("ready-to-check");
    expect(read.primaryAction?.code).not.toBe("confirm-stopped");
    const checks = store.raw().prepare("SELECT * FROM run_check WHERE run=?").all(run);
    const completed = await post(`/t/${id}/complete`, { csrf: csrfOf(await page(`/t/${id}`)), run: String(run), receipt: read.receipt!.digest, accept: "1" });
    expect(completed.status).toBe(303);
    expect(assignment(id).state).toBe("complete");
    expect(store.raw().prepare("SELECT * FROM run_check WHERE run=?").all(run)).toEqual(checks);
  });

  test("a self-clearing gap reads Finishing up across task, result, list and catch-up without confirmation", async () => {
    const id = "finishing-check", run = built(id, "Verify the prepared release");
    witness(run, process.pid);
    store.raw().prepare("UPDATE run_process SET exited_at=? WHERE run=?").run(NOW.toISOString(), run);
    witness(run, null);
    const sentence = "Finishing up; this clears on its own.";
    expect(store.stopQuiescenceFact(run)?.kind).toBe("settling");
    expect(assignmentPresentationOf(assignment(id)).taskStatus.sentence).toBe(sentence);
    expect(listed("needs-you").items.some(one => one.rootId === id)).toBe(false);
    expect(listed().items.find(one => one.rootId === id)?.status.detail).toBe(sentence);
    const task = workspaceOf(await page(`/t/${id}`)).view as Extract<BrowserWorkspace["view"], { kind: "task" }>;
    expect(task.status?.status.sentence).toBe(sentence);
    expect(task.confirmStopped).toBeNull();
    const result = workspaceOf(await page(`/review?result=${id}&run=${run}`)).view as Extract<BrowserWorkspace["view"], { kind: "result" }>;
    expect(result.selected!.panel!.status?.sentence).toBe(sentence);
    expect(result.selected!.panel!.need?.confirm).toBeFalsy();
    // Catch-up lists human actions; this wait must never become a request.
    expect(leadBriefHtml(assignmentCatchUp(store, NOW, { principal: "operator", repos: [REPO] }, { limit: 50 }, root))).not.toContain(`/t/${id}#confirm-stopped`);
    expect(store.settleUnspawnedWitnesses(NOW, run)).toBe(1);
    expect(assignment(id).state).toBe("ready-to-check");
  });

  test("Waiting rows are not counted as Needs you, and settled custody leaves it", () => {
    const all = listed();
    const needsView = listed("needs-you");
    expect(needsView.items.map(one => one.rootId)).not.toContain("still-alive");
    expect(all.totals["needs-you"]).toBe(all.items.filter(one => one.status.views.includes("needs-you")).length);
    expect(all.totals["needs-you"]).toBe(needsView.items.length);
    // The process exited without a recorded exit: the store reads it stopped, so the list reads it Ready, as the task page does.
    expect(store.stopQuiescenceFact(runs["exited-quietly"]!)).toBeNull();
    const quiet = all.items.find(one => one.rootId === "exited-quietly")!;
    expect(quiet.status.label).toBe("Ready for review");
    expect(quiet.primaryAction?.code).not.toBe("confirm-stopped");
    expect(assignmentPresentationOf(assignment("exited-quietly")).taskStatus.headline).toBe("Ready for review");
  });

  test("on the result itself, the action is never a link back to the same page", async () => {
    // Built to an earlier plan: accepting would leave it stuck. Both pages lead with Build again, in place.
    const stale = assignment("unverified");
    const words = assignmentPresentationOf(stale).taskStatus;
    expect(words).toMatchObject({ headline: "Needs you", sentence: `Build #${runs["unverified"]} was made to an earlier plan. Build it again to the current plan.` });
    expect(stale.primaryAction).toMatchObject({ code: "retry-task", label: "Build again" });
    // Build again is the task's status card itself, at the top of its page: no anchor into Task options.
    expect(assignmentActionHref(stale)).toBe("/t/unverified?version=unverified");
    const result = (workspaceOf(await page(`/review?result=unverified&run=${runs["unverified"]}`)).view as Extract<BrowserWorkspace["view"], { kind: "result" }>).selected!.panel!;
    expect(result.status?.headline).toBe("Needs you");
    expect(result.need).toMatchObject({ label: "Build again", href: null, rebuild: { action: "/t/unverified/requeue" } });
    expect(result.canRequest).toBe(true);
    const task = workspaceOf(await page("/t/unverified")).view as Extract<BrowserWorkspace["view"], { kind: "task" }>;
    expect(task.rebuild).toEqual({ action: "/t/unverified/requeue" });
    expect(task.status?.action?.label).toBe("Build again");
    expect(task.status?.action?.href).not.toContain("/review");

    // A result to review leads with Accept, the act this page holds; once accepted, no act here at all (never a link back to the task).
    const here = { ...stale, primaryAction: { ...stale.primaryAction!, code: "open-result" as const } };
    const facts = { humanReview: false, run: runs["unverified"]!, action: "/t/unverified/accept-proof" };
    const review = taskStatusOf({ stage: "needs-you", need: "review-result" });
    expect(needActionOf(here, review, "csrf", "/back", { ...facts, accepted: false }))
      .toMatchObject({ label: "Accept with exception", href: null, accept: { action: "/t/unverified/accept-proof", run: runs["unverified"], note: "Why is this safe to accept?" } });
    expect(needActionOf(here, review, "csrf", "/back", { ...facts, humanReview: true, accepted: false })?.accept?.note).toBeNull();
    expect(needActionOf(here, review, "csrf", "/back", { ...facts, accepted: true })).toBeNull();
    // Whatever else the task page sends the person here for, this page leads with what it can do, never a link back:
    // Accept a check only a person can make, or Build again a result that may run again.
    const other = taskStatusOf({ stage: "needs-you", need: "other" });
    expect(needActionOf(here, other, "csrf", "/back", { ...facts, humanReview: true, accepted: false })).toMatchObject({ label: "Accept result", accept: { note: null } });
    expect(needActionOf(here, other, "csrf", "/back", { ...facts, accepted: false, rebuildable: true })).toMatchObject({ label: "Build again", href: null, rebuild: { action: "/t/unverified/requeue" } });
    // A report that doesn't match its saved changes (a refuted proof): Accept with a reason stays allowed here, never "Open the task".
    expect(needActionOf(here, other, "csrf", "/back", { ...facts, accepted: false, refuted: true })).toMatchObject({ label: "Accept with exception", href: null, accept: { note: "Why is this safe to accept?" } });
    expect(needActionOf(here, other, "csrf", "/back", { ...facts, accepted: false })).toBeNull();

    const rebuilt = await post("/t/unverified/requeue", { csrf: csrfOf(await page("/t/unverified")) });
    expect(rebuilt.status).toBe(303);
    expect(store.getTask("unverified")?.state).toBe("queued");
  });

  test("a build that may still be running is Waiting, never Needs you, and can't be confirmed", async () => {
    const read = assignment("still-alive");
    const presentation = assignmentPresentationOf(read);
    expect(presentation.taskStatus.headline).toBe("Waiting");
    expect(presentation.taskStatus.sentence).toBe(`Waiting for build #${runs["still-alive"]} to stop. Nothing is needed from you.`);
    expect(presentation.status.views).not.toContain("needs-you");
    expect(read.state).not.toBe("needs-decision");
    const index = workIndexPage(store, NOW, { principal: "operator", repos: [REPO] }, { view: "all" }).items.find(one => one.rootId === "still-alive")!;
    expect(index.status.label).toBe("Waiting");
    expect(index.status.views).not.toContain("needs-you");
    expect(index.assignmentState).toBe("working");
    const html = await page("/t/still-alive");
    const refused = await post("/t/still-alive/confirm-stopped", { csrf: csrfOf(html), run: String(runs["still-alive"]), token: password });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("may still be running");
    expect(store.stopQuiescenceFact(runs["still-alive"]!)?.kind).toBe("alive");
  });

  test("the task list and Catch up lead with the same action", async () => {
    const index = workIndexPage(store, NOW, { principal: "operator", repos: [REPO] }, { view: "needs-you" }).items.find(one => one.rootId === "spawn-gap")!;
    expect(index.status.label).toBe("Needs you");
    expect(hasInternalWords(index.status.detail)).toBe(false);
    expect(index.primaryAction).toMatchObject({ code: "confirm-stopped", label: "Confirm it stopped", target: { runId: runs["spawn-gap"] } });
    expect(browserWorkActionHref(index)).toBe("/t/spawn-gap#confirm-stopped");
    const home = workspaceOf(await page("/chat")).home!;
    const item = home.catchUp.find(one => one.id === "spawn-gap")!;
    expect(item.tab).toBe("needs-you");
    expect(item.action).toEqual({ label: "Confirm it stopped", href: "/t/spawn-gap#confirm-stopped" });
    expect(home.catchUp.find(one => one.id === "still-alive")?.tab).not.toBe("needs-you");
    // The saved catch-up shown before the lead is on: the same button under the same sentence.
    const brief = leadBriefHtml(assignmentCatchUp(store, NOW, { principal: "operator", repos: [REPO] }, { limit: 8 }, root));
    expect(brief).toContain(`href="/t/spawn-gap#confirm-stopped" data-catch-up-action>Confirm it stopped</a>`);
    expect(hasInternalWords(brief)).toBe(false);
  });

  test("confirming takes the password, records who, and the result becomes Ready", async () => {
    for (const id of ["spawn-gap", "no-record"]) {
      const html = await page(`/t/${id}`);
      const wrong = await post(`/t/${id}/confirm-stopped`, { csrf: csrfOf(html), run: String(runs[id]), token: "not-the-password" });
      expect(wrong.status, id).toBe(403);
      expect(assignment(id).state, id).toBe("needs-decision");
      const confirmed = await post(`/t/${id}/confirm-stopped`, { csrf: csrfOf(html), run: String(runs[id]), token: password });
      expect(confirmed.status, id).toBe(303);
      expect(store.stopQuiescenceProblem(runs[id]!), id).toBeNull();
      const after = assignmentPresentationOf(assignment(id));
      expect(after.taskStatus.headline, id).toBe("Ready for review");
      const ledger = store.raw().prepare("SELECT actor, detail FROM action_ledger WHERE run_id = ? AND action = 'process witness settled by approver'").get(runs[id]!);
      expect(ledger, id).toMatchObject({ actor: "sam" });
    }
  });
});
