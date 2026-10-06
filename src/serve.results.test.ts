/**
 * The console server: the review cockpit — a ranked, verified projection of
 * completed work and its result pages.
 */

import type { PublishExec } from "./publish.js";
import { savePublishing } from "./pull-request-flow.js";
import { COMPLETION_ACTION as PR_COMPLETION_ACTION } from "./result-completion.js";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { acceptAndCompleteAsOperator, assignmentOf } from "./assignment.js";
import { verifyApproverByPassword } from "./principal.js";
import { acquire, release } from "./claim.js";
import { register } from "./runner.js";
import { addApprover, approvalOf, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { createDecisionServer, reviewPriorityOf, rankReviewQueue, withinSignedTouches, diffFileAnchor, reviewFilePriority, orderChangedFiles, type ReviewQueueFacts, type ReviewFileRow } from "./serve.js";
import type { MateProviderAnswer } from "./converse.js";
import { resultFactsFromHtml, resultReturnTarget } from "./result-review.js";
import { Window } from "happy-dom";
import { validateTaskText, TASK_TEXT_LIMITS } from "./task-text.js";
import { presented, T0, stylesOf, renderedHtmlOf, workspaceOf, revisionIdOf, plannerKeptTerms, revisionFormOf } from "../test/serve-kit.js";
import { handoffBytes } from "../test/handoff-fixture.js";
import type { HandoffArtifact } from "./contracts/handoff.js";

describe("the review cockpit (Priority 5): a ranked, verified projection of completed work", () => {
  let store: Store;
  let server: Server | null = null;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
  const url = (path: string) => `${base}${path}`;
  const at = (hoursAgo: number): Date => new Date(T0.getTime() - hoursAgo * 3_600_000);

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const boot = async (options: Record<string, unknown> = {}) => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main", ...options });
    await new Promise<void>(resolve => (server as Server).listen(0, "127.0.0.1", resolve));
    const address = (server as Server).address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  const csrfOf = (html: string): string => {
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on the page");
    return match[1] as string;
  };
  const mainOf = (html: string): string => html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
  const queueOf = (html: string): string => /<ol class="cockpit-queue-list">(.*?)<\/ol>/s.exec(html)?.[1] ?? "";
  const post = (cookie: string, path: string, fields: Record<string, string>) =>
    fetch(url(path), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  /** A done task with a signed scope in the project (or elsewhere). */
  const seed = (id: string, title: string, repo = "/repo/main", scope: { goal?: string; outOfScope?: string | null; touches?: string[]; acceptance?: { id: string; statement: string; evidence: ("check" | "screenshot" | "changed-path" | "manual-review")[] }[] } | null = {}): number => {
    store.createTask({ id, title }, T0);
    const ref = store.refFor("built-in", id, "ours").id;
    store.placeTask(ref, repo);
    if (scope !== null) {
      const proposed = propose(store, {
        taskId: id,
        goal: scope.goal ?? `goal of ${id}`,
        outOfScope: scope.outOfScope ?? null,
        touches: scope.touches ?? [],
        acceptance: (scope.acceptance ?? [{ id: "c1", statement: `${id} is done`, evidence: ["manual-review"] }]).map(one => ({ ...one, how: null })),
        now: T0,
      });
      const agreed = approve(store, id, "alex", T0, proposed.digest, approverToken);
      if (!agreed.ok) throw new Error(`approval refused: ${agreed.reason}`);
    }
    return ref;
  };

  /** A finished build with the artifacts the cockpit projects. */
  const build = (
    id: string,
    ref: number,
    parts: {
      patch?: string;
      stat?: { path: string; additions: number | null; deletions: number | null }[];
      handoff?: Partial<Omit<HandoffArtifact, "version" | "runId">>;
      proof?: Record<string, unknown>;
      checkLog?: string;
      screenshot?: { path: string; caption: string };
      verdict?: { verdict: "verified" | "attested" | "short" | "refuted"; reasons?: string[]; matrix?: import("./proof.js").CriterionMatrixRow[]; machineVerdict?: "verified" | "attested" | "short" | "refuted" };
      outcome?: "built" | "no-change" | "failed";
      reason?: string;
      finishedAt?: Date;
    } = {},
  ): number => {
    const when = parts.finishedAt ?? T0;
    const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "night-shift-1", provider: "claude", branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: new Date(when.getTime() - 60_000), ...presented(store, ref, "builder") });
    if (parts.patch !== undefined) {
      storeEvidence(store, evidenceRoot, run, "terminal-diff", "terminal-diff.patch", Buffer.from(parts.patch, "utf8"), "git diff --no-ext-diff 0000..HEAD (exit 0)", when, { captureStatus: "ok" });
    }
    if (parts.stat !== undefined) {
      const files = parts.stat;
      const stat = {
        schema: 1, base: "a".repeat(40), head: "b".repeat(40), fileCount: files.length,
        additions: files.reduce((sum, one) => sum + (one.additions ?? 0), 0), deletions: files.reduce((sum, one) => sum + (one.deletions ?? 0), 0),
        binaryCount: files.filter(one => one.additions === null).length, filesTruncated: false, files,
      };
      storeEvidence(store, evidenceRoot, run, "diff-stat", "diff-stat.json", Buffer.from(JSON.stringify(stat), "utf8"), "parsed from git diff --numstat -z", when, { captureStatus: "ok" });
    }
    if (parts.handoff !== undefined) {
      storeEvidence(store, evidenceRoot, run, "handoff", "handoff.json", handoffBytes(run, parts.handoff), "composed at completion", when);
    }
    if (parts.proof !== undefined) {
      storeEvidence(store, evidenceRoot, run, "proof", "proof.json", Buffer.from(JSON.stringify(parts.proof), "utf8"), "agent-authored proof (validated)", when);
    }
    if (parts.checkLog !== undefined) {
      storeEvidence(store, evidenceRoot, run, "check-log", "check-log.txt", Buffer.from(parts.checkLog, "utf8"), `sh -c "npm test" (exit 0)`, when);
    }
    if (parts.screenshot !== undefined) {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      storeEvidence(store, evidenceRoot, run, "screenshot", "shot.png", png, `agent-claimed screenshot at ${parts.screenshot.path} (validated png)`, when);
    }
    if (parts.verdict !== undefined) {
      store.saveProofVerdict(run, parts.verdict.verdict, parts.verdict.reasons ?? [], when, parts.verdict.matrix ?? [], parts.verdict.machineVerdict ?? null);
    }
    store.recordOutcomeFacts(run, { headRevision: "b".repeat(40), handoff: `handoff of ${id}` });
    store.finishRun(run, { outcome: parts.outcome ?? "built", committed: true, now: when, ...(parts.reason === undefined ? {} : { reason: parts.reason }) });
    store.setTaskState(id, parts.outcome === "failed" ? "failed" : "done", when);
    return run;
  };

  const row = (id: string, statement: string, state: "pass" | "missing" | "failed" | "manual-review", answered: { kind: "check" | "screenshot" | "changed-path" | "manual-review"; ref: string }[] = [], detail: string[] = [], review: { judgement: "upholds" | "contradicts" | "cannot-tell"; note: string; author: string } | null = null): import("./proof.js").CriterionMatrixRow => ({
    id, statement, requiredEvidence: answered.length === 0 ? ["manual-review"] : [...new Set(answered.map(one => one.kind))], state, detail, answered, review,
  });

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-cockpit-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    register(store, { name: "night-shift-1", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-1" });
  });

  afterEach(async () => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = null;
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("review priority is deterministic and labeled: every band, every reason, and a stable tie-break", () => {
    const facts = (over: Partial<ReviewQueueFacts>): ReviewQueueFacts => ({ runId: 1, outcome: "built", proofVerdict: "verified", proofAccepted: false, proofMatrix: [], ciFailing: false, publicationState: null, ...over });
    expect(reviewPriorityOf(facts({}))).toEqual({ band: 2, label: "no flags", reasons: [] });
    expect(reviewPriorityOf(facts({ runId: null, proofVerdict: null }))).toEqual({ band: 1, label: "review", reasons: ["no build record"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "refuted" }))).toMatchObject({ band: 0, label: "needs action", reasons: ["conflicting evidence"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "refuted", proofAccepted: true }))).toMatchObject({ band: 1, reasons: ["conflicting evidence — accepted with exception"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "short" }))).toMatchObject({ band: 0, reasons: ["missing evidence"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "short", proofAccepted: true }))).toMatchObject({ band: 1 });
    const manualOnly = facts({ proofVerdict: "short", proofReasons: ['criterion "c1" requires manual-review evidence — an operator must accept it before this can verify'], proofMatrix: [row("c1", "Inspect phone layout", "manual-review")] });
    expect(reviewPriorityOf(manualOnly)).toEqual({ band: 1, label: "review", reasons: ["human review needed"] });
    expect(reviewPriorityOf({ ...manualOnly, proofAccepted: true }).reasons).toEqual(["accepted after human review"]);
    expect(reviewPriorityOf({ ...manualOnly, proofReasons: [...manualOnly.proofReasons!, "no proof was written"] }).reasons).toContain("missing evidence");
    expect(reviewPriorityOf(facts({ proofMatrix: [row("c2", "x", "pass", [{ kind: "check", ref: "npm test" }], [], { judgement: "contradicts", note: "no", author: "reviewer:codex" })] }))).toMatchObject({ band: 0, reasons: ["reviewer raised a concern with c2"] });
    expect(reviewPriorityOf(facts({ proofMatrix: [row("c1", "x", "failed"), row("c3", "y", "missing")] }))).toMatchObject({ band: 0, reasons: ["missing or failed evidence for c1, c3"] });
    expect(reviewPriorityOf(facts({ ciFailing: true }))).toMatchObject({ band: 0, reasons: ["CI failing on its pull request — observed, not inferred"] });
    expect(reviewPriorityOf(facts({ publicationState: "failed" }))).toMatchObject({ band: 1, reasons: ["publication failed — the branch never reached its remote"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "attested", proofMatrix: [row("c1", "x", "manual-review")] }))).toMatchObject({ band: 1, reasons: ["manual review needed for c1"] });
    expect(reviewPriorityOf(facts({ proofVerdict: "attested", proofAccepted: true, proofMatrix: [row("c1", "x", "manual-review")] }))).toMatchObject({ band: 2, reasons: [] });
    expect(reviewPriorityOf(facts({ proofVerdict: null }))).toMatchObject({ band: 1, reasons: ["no verification result"] });
    expect(reviewPriorityOf(facts({ proofVerdict: null, outcome: "no-change" }))).toMatchObject({ band: 2, reasons: [] });
    // A refuted, CI-failing result names every reason and keeps band 0.
    expect(reviewPriorityOf(facts({ proofVerdict: "refuted", ciFailing: true })).reasons).toHaveLength(2);

    // Band first, then newest completion, then task id — twice, identically.
    const rows = [
      { taskId: "b-old", completedAt: "2026-08-10T00:00:00.000Z", ...facts({}) },
      { taskId: "a-new", completedAt: "2026-08-11T00:00:00.000Z", ...facts({}) },
      { taskId: "z-same", completedAt: "2026-08-11T00:00:00.000Z", ...facts({}) },
      { taskId: "hot", completedAt: "2026-08-01T00:00:00.000Z", ...facts({ proofVerdict: "short" }) },
      { taskId: "warm", completedAt: "2026-08-02T00:00:00.000Z", ...facts({ proofVerdict: null }) },
    ];
    const order = rankReviewQueue(rows).map(one => one.taskId);
    expect(order).toEqual(["hot", "warm", "a-new", "z-same", "b-old"]);
    expect(rankReviewQueue([...rows].reverse()).map(one => one.taskId)).toEqual(order);
  });

  test("changed files rank by review priority — outside touches first, then sensitive or uncited, then churn — with stable anchors", () => {
    expect(withinSignedTouches("src/a.ts", ["src/"])).toBe(true);
    expect(withinSignedTouches("src/a.ts", ["src"])).toBe(true);
    expect(withinSignedTouches("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(withinSignedTouches("srcx/a.ts", ["src"])).toBe(false);
    expect(withinSignedTouches("docs/x/y.md", ["docs/**"])).toBe(true);
    expect(withinSignedTouches("docs/x/y.md", ["docs/*.md"])).toBe(false);
    expect(withinSignedTouches("docs/y.md", ["docs/*.md"])).toBe(true);
    expect(withinSignedTouches("a(b).ts", ["a(b).ts"])).toBe(true);
    expect(withinSignedTouches("anything", [])).toBe(false);
    // Globstar spans zero or more directories (v2 review, comment 2): a
    // false negative here is a loud "outside the signed touches" flag.
    for (const path of ["src/a.ts", "src/nested/a.ts", "src/deep/er/a.ts"]) expect(withinSignedTouches(path, ["src/**/*.ts"])).toBe(true);
    expect(withinSignedTouches("src/a.js", ["src/**/*.ts"])).toBe(false);
    expect(withinSignedTouches("lib/a.ts", ["src/**/*.ts"])).toBe(false);
    expect(withinSignedTouches("src/a.ts/x", ["src/**/*.ts"])).toBe(true);
    expect(withinSignedTouches("README.md", ["**/*.md"])).toBe(true);
    expect(withinSignedTouches("docs/x/y.md", ["**/*.md"])).toBe(true);
    expect(withinSignedTouches("docs/x/y.md", ["**/y.md"])).toBe(true);
    expect(withinSignedTouches("docs/x/y.ts", ["**/*.md"])).toBe(false);
    expect(withinSignedTouches("src/a.ts", ["src/**/"])).toBe(true);
    expect(withinSignedTouches("src/serve.test.ts", ["src/*.test.ts"])).toBe(true);
    expect(withinSignedTouches("src/x/serve.test.ts", ["src/*.test.ts"])).toBe(false);
    expect(withinSignedTouches("evidence/review-cockpit/desktop.png", ["evidence/review-cockpit/**"])).toBe(true);

    expect(diffFileAnchor("src/a.ts")).toMatch(/^diff-file-[0-9a-f]{16}$/);
    expect(diffFileAnchor("src/a.ts")).toBe(diffFileAnchor("src/a.ts"));
    expect(diffFileAnchor(`"><script>`)).toMatch(/^diff-file-[0-9a-f]{16}$/);
    expect(diffFileAnchor("a")).not.toBe(diffFileAnchor("b"));

    const file = (path: string, over: Partial<ReviewFileRow> = {}): ReviewFileRow => ({ path, additions: 1, deletions: 1, renamedFrom: null, anchor: "x", outsideTouches: false, cited: true, ...over });
    expect(reviewFilePriority(file("src/a.ts"), true)).toEqual({ band: 2, label: "no flags", reasons: [] });
    expect(reviewFilePriority(file("src/a.ts", { outsideTouches: true }), true)).toMatchObject({ band: 0, reasons: ["outside approved paths"] });
    expect(reviewFilePriority(file("img.png", { additions: null, deletions: null }), true)).toMatchObject({ band: 1, reasons: ["binary file — preview unavailable"] });
    expect(reviewFilePriority(file("package-lock.json"), true)).toMatchObject({ band: 1, reasons: ["dependencies, CI, schema, or credentials"] });
    expect(reviewFilePriority(file(".github/workflows/ci.yml"), true)).toMatchObject({ band: 1 });
    expect(reviewFilePriority(file("src/auth-token.ts"), true)).toMatchObject({ band: 1 });
    // The credential heuristic (v2 review, comment 4): whole delimited
    // name pieces only — never a substring of an ordinary word.
    const sensitiveWhy = "dependencies, CI, schema, or credentials";
    for (const path of ["src/auth.ts", "src/api-token.ts", "config/secrets.json", "credentials.yml", "auth_middleware.ts", "lib/user.credentials.ts", ".env", ".env.local", "app/.env.production", "db/schema.prisma", "prisma/migrations/0001_init.sql", "Dockerfile", "pnpm-lock.yaml"]) {
      expect(reviewFilePriority(file(path), true), path).toMatchObject({ band: 1, reasons: [sensitiveWhy] });
    }
    for (const path of ["src/author.ts", "src/tokenizer.ts", "src/permissions-ui.tsx", "src/.envelope.ts", "src/environment.ts", "src/authorize.ts", "src/permissions.ts", "docs/secretary.md", "src/tokens/theme.ts"]) {
      expect(reviewFilePriority(file(path), true), path).toEqual({ band: 2, label: "no flags", reasons: [] });
    }
    expect(reviewFilePriority(file("src/a.ts", { cited: false }), true)).toMatchObject({ band: 1, reasons: ["not referenced by a requirement"] });
    expect(reviewFilePriority(file("src/a.ts", { cited: false }), false)).toMatchObject({ band: 2, reasons: [] });
    expect(reviewFilePriority(file("src/a.ts", { additions: 150, deletions: 60 }), true)).toMatchObject({ band: 1, reasons: ["a large change"] });
    expect(reviewFilePriority(file("src/a.ts", { anchor: null }), true)).toMatchObject({ band: 1, reasons: ["not in the recorded diff — see the full diff"] });

    const ordered = orderChangedFiles([
      file("z.ts", { additions: 5, deletions: 0 }),
      file("a.ts", { additions: 5, deletions: 0 }),
      file("big.ts", { additions: 400, deletions: 0 }),
      file("drift.ts", { outsideTouches: true }),
      file("package.json"),
    ], true).map(one => one.path);
    expect(ordered).toEqual(["drift.ts", "big.ts", "package.json", "a.ts", "z.ts"]);
  });

  test("the queue is authenticated, visibility-safe, bounded to done tasks, deep-linkable, and honest when empty or when the link misses", async () => {
    await boot();
    // Unauthenticated: the login door, never the queue.
    const anonymous = await fetch(url("/review"), { redirect: "manual" });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toContain("/login");
    const cookie = await login();

    // Empty, honestly.
    const empty = await (await fetch(url("/review"), { headers: { cookie } })).text();
    expect(empty).toContain("No results in this review list.");
    expect(empty).toContain("Nothing to review yet.");
    expect(empty).toContain('<a href="/work" aria-label="Tasks" title="Tasks" class="active" aria-current="page"');

    // Two visible done tasks, one still running, one done in a repo outside the ceiling.
    seed("t-ours", "ours — the <b>title</b>");
    build("t-ours", store.refFor("built-in", "t-ours").id, { verdict: { verdict: "attested" }, patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", stat: [{ path: "x", additions: 1, deletions: 1 }] });
    seed("t-older", "older, needs eyes");
    build("t-older", store.refFor("built-in", "t-older").id, { verdict: { verdict: "short", reasons: ["no proof"] }, finishedAt: at(5) });
    seed("t-live", "still going");
    store.setTaskState("t-live", "running", T0);
    seed("t-theirs", "theirs — never shown", "/repo/other");
    build("t-theirs", store.refFor("built-in", "t-theirs").id, { verdict: { verdict: "refuted" } });

    const html = await (await fetch(url("/review"), { headers: { cookie } })).text();
    const queue = queueOf(html);
    // Only done tasks inside the ceiling. Both need a decision, so newest
    // comes first; a retired proof verdict does not create another priority.
    expect(queue).toContain("t-older");
    expect(queue).toContain("t-ours");
    expect(queue).not.toContain("t-live");
    expect(queue).not.toContain("t-theirs");
    expect(html).not.toContain("never shown");
    expect(queue.indexOf("t-ours")).toBeLessThan(queue.indexOf("t-older"));
    expect(html).toContain("2 need your attention");
    expect(queue).toContain("Needs you");
    expect(queue).not.toContain("missing evidence");
    // Escaped everywhere the title lands.
    expect(html).toContain("ours — the &lt;b&gt;title&lt;/b&gt;");
    expect(html).not.toContain("<b>title</b>");
    // The first-ranked row is selected by default and marked current.
    expect(html).toContain('data-review-task="t-ours"');
    const olderRun = store.runsFor(store.lookupRef("t-older")!.id)[0]!.id;
    const oursRun = store.runsFor(store.lookupRef("t-ours")!.id)[0]!.id;
    expect(queue).toContain(`class="cockpit-row current" href="/review?result=t-ours&amp;run=${oursRun}" aria-current="page"`);

    // A stable deep link selects, and the row it names is current.
    const picked = await (await fetch(url("/review?result=t-older"), { headers: { cookie } })).text();
    expect(picked).toContain('data-review-task="t-older"');
    expect(queueOf(picked)).toContain(`class="cockpit-row current" href="/review?result=t-older&amp;run=${olderRun}"`);
    expect(picked).not.toContain("is in view here");
    // The rebuilt page reads the same result: the list with its current row,
    // the panel's script hooks, and every tab body as the fallback's markup.
    const read = await (await fetch(url("/review?result=t-older&format=workspace"), { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    const review = read.view as import("./browser-workspace.js").BrowserResultView;
    expect(review.kind).toBe("result");
    expect(review.results.map(one => one.title)).toEqual(["ours — the <b>title</b>", "older, needs eyes"]);
    expect(review.results.find(one => one.current)?.href).toBe(`/review?result=t-older&run=${olderRun}`);
    expect(review.attention).toBe(2);
    expect(review.selected).toMatchObject({ taskId: "t-older", build: olderRun, taskHref: "/t/t-older", status: { label: "Needs you" } });
    const panel = review.selected!.panel!;
    expect(panel.attributes).toMatchObject({ "data-result-panel": "", "data-result-place": "review", "data-result-task": "t-older", "data-result-run": String(olderRun) });
    expect(panel.tabs.map(tab => [tab.key, tab.active])).toEqual([["summary", true], ["changes", false], ["checks", false]]);
    for (const one of panel.views) expect(read.pageHtml).toContain(one.html);
    expect(read.pageHtml).toContain(panel.request!);
    const missedView = (await (await fetch(url("/review?result=nope&format=workspace"), { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    expect(missedView).toMatchObject({ selected: null, missing: expect.stringContaining("No completed task nope is in view here") });
    expect(missedView.results).toHaveLength(2);

    // A hidden result and a nonexistent one read identically: a note, and
    // the top of the queue — never a 404 that confirms existence.
    for (const miss of ["t-theirs", "t-live", "nope"]) {
      const missed = await fetch(url(`/review?result=${miss}`), { headers: { cookie } });
      expect(missed.status).toBe(200);
      const body = await missed.text();
      expect(body).toContain(`No completed task <span class="mono">${miss}</span> is in view here`);
      expect(body).not.toContain("Showing the top of the queue instead.");
      expect(body).not.toContain('data-review-task="t-older"');
      expect(body).not.toContain("never shown");
    }
    // A hostile id never echoes raw.
    const hostile = await (await fetch(url(`/review?result=${encodeURIComponent("<img src=x>")}`), { headers: { cookie } })).text();
    expect(hostile).not.toContain("<img src=x>");
    expect(hostile).toContain("&lt;img src=x&gt;");
  });

  test("structured-output repair bookkeeping never replaces the build on task or review result surfaces", async () => {
    const ref = seed("t-result-lineage", "show the delivered build");
    const built = build("t-result-lineage", ref, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "x", additions: 1, deletions: 1 }],
      verdict: { verdict: "attested" },
    });
    // The repair turn mends a LIVE attempt under its own lease (atomic
    // authority closure): the fixture reopens the delivered build for the
    // admission, then restores the history the surfaces read.
    const builtRow = store.getRun(built)!;
    store.raw().prepare("UPDATE run SET outcome = NULL WHERE id = ?").run(built);
    // ... under the task's CURRENT live claim (final authority closure).
    store.raw().prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, 99, 'night-shift-1', ?, ?, ?)").run(builtRow.leaseId, ref, T0.toISOString(), new Date(T0.getTime() + 900_000).toISOString(), T0.toISOString());
    const admittedCorrection = store.admitRepair({
      taskRef: ref,
      leaseId: builtRow.leaseId,
      runner: "night-shift-1",
      provider: "claude",
      parentRun: built,
      branch: "standing-orders/t-result-lineage",
      worktree: "/pool/t-result-lineage",
      now: new Date(T0.getTime() + 1),
      ...(presented(store, ref, "repair") as { route: import("./phase-routing.js").RouteStamp }),
    });
    store.raw().prepare("UPDATE run SET outcome = ? WHERE id = ?").run(builtRow.outcome, built);
    store.raw().prepare("UPDATE claim SET released_at = ? WHERE lease_id = ? AND lease_generation = 99").run(T0.toISOString(), builtRow.leaseId);
    if (!admittedCorrection.ok) throw new Error(admittedCorrection.problem);
    const correction = admittedCorrection.runId;
    store.finishRun(correction, {
      outcome: "no-change",
      reason: "structured output repaired",
      now: new Date(T0.getTime() + 2),
    });

    await boot();
    const cookie = await login();
    const task = await (await fetch(url("/t/t-result-lineage"), { headers: { cookie } })).text();
    const receipt = /<section class="card completion-receipt"[\s\S]*?<\/section>/.exec(task)?.[0] ?? "";
    // The receipt names its build by the run it opens, never the repair.
    expect(receipt).toContain(`data-result-run="${built}"`);
    expect(receipt).not.toContain(`build #${correction}`);

    const cockpit = await (await fetch(url("/review?result=t-result-lineage"), { headers: { cookie } })).text();
    expect(cockpit).toContain(`href="/r/${built}">Full build record →`);
    expect(cockpit).not.toContain(`href="/r/${correction}">Full build history and evidence`);
  });

  test("a manual completion and a legacy result read as exactly what they are; broken artifacts name their problem", async () => {
    // Done by hand: no scope, no run.
    store.createTask({ id: "t-manual", title: "closed by hand" }, T0);
    store.placeTask(store.refFor("built-in", "t-manual", "ours").id, "/repo/main");
    store.setTaskState("t-manual", "done", at(2));
    // Legacy: a finished build with no artifacts and no verdict.
    const legacyRef = seed("t-legacy", "from before proofs");
    const legacyRun = build("t-legacy", legacyRef, { finishedAt: at(3) });
    // Broken: a patch whose bytes no longer match their record, a truncated
    // check log, and a stat capture that failed.
    const brokenRef = seed("t-broken", "tampered after sealing");
    const brokenRun = build("t-broken", brokenRef, { patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", verdict: { verdict: "attested" }, finishedAt: at(4) });
    const patchArtifact = store.artifactsFor(brokenRun).find(one => one.kind === "terminal-diff");
    if (patchArtifact === undefined) throw new Error("no patch");
    writeFileSync(join(evidenceRoot, patchArtifact.key), "diff --git a/x b/x\n+tampered\n");
    storeEvidence(store, evidenceRoot, brokenRun, "check-log", "check-log.txt", Buffer.alloc(170 * 1024, "x"), `sh -c "npm test" (exit 0)`, at(4));
    storeEvidence(store, evidenceRoot, brokenRun, "diff-stat", "diff-stat.json", Buffer.from("{}"), "git diff --numstat (exit 128)", at(4), { captureStatus: "failed" });
    await boot();
    const cookie = await login();

    const manual = await (await fetch(url("/review?result=t-manual"), { headers: { cookie } })).text();
    expect(manual).toContain('data-review-task="t-manual"');
    expect(manual).toContain('data-work-status="assignment-needs-decision"');
    expect(manual).toContain("This task was marked complete without a build record.");
    expect(manual).toContain("No scope was filed for this task");
    expect(manual).toContain("no finished build record");
    expect(manual).toContain('data-next-action="inspect-task"');
    expect(manual).toContain('href="/t/t-manual"');
    expect(mainOf(manual)).not.toContain("<form");

    const legacy = await (await fetch(url("/review?result=t-legacy"), { headers: { cookie } })).text();
    expect(legacy).toContain("Needs you");
    expect(legacy).toContain('data-work-status="assignment-needs-decision"');
    expect(legacy).toContain("no verification result");
    expect(legacy).toContain("This build has no verification result or captured evidence");
    expect(legacy).toContain("No final diff or change summary was captured for this build");
    expect(legacy).not.toContain('data-next-action="inspect-run"');
    expect(legacy).toContain(`href="/r/${legacyRun}">Full build record →</a>`);
    // No diff means no annotation form — the endpoint would refuse it anyway.
    expect(legacy).not.toContain('id="comment-form"');

    const broken = await (await fetch(url("/review?result=t-broken"), { headers: { cookie } })).text();
    expect(broken).toContain("Diff unavailable: stored but unverifiable");
    expect(broken).toContain("Change summary unavailable: capture failed");
    expect(broken).toMatch(/Check output \(shortened — [0-9]+ of [0-9]+ bytes stored\)/);
    // Package 3: every evidence problem is also named in the open, ahead
    // of the tabs, and the shared facts count them.
    expect(broken).toContain("The sealed diff is unavailable: stored but unverifiable");
    expect(broken).toContain("The check output was shortened when it was stored; its download holds only the stored part.");
    // Repair 2026-09-14: a shortened record's download is never called the full bytes.
    expect(broken).toContain("Download the stored part of the check log (shortened at storage — not the full check log)");
    expect(broken).not.toContain("Open the full check log");
    expect(broken).not.toContain("Download the full diff");
    expect(broken).toMatch(/data-result-evidence="problems:[0-9]+"/);
    expect(broken).not.toContain("tampered</code>");
    expect(broken).not.toContain('id="comment-form"');
    // The raw record is still one click away, exactly as stored.
    expect(broken).toContain(`href="/r/${brokenRun}/evidence/`);
  });

  test("intent to diff: goal, boundary, every signed criterion with its state and citations; changed-path citations anchor into the sealed file; drift outside the touches is flagged", async () => {
    const ref = seed("t-intent", "guard the payout", "/repo/main", {
      goal: "Guard the payout <script>alert(1)</script>",
      outOfScope: "No schema changes & no API changes",
      touches: ["src/payout/"],
      acceptance: [
        { id: "c1", statement: "The guard is covered by tests", evidence: ["check", "changed-path"] },
        { id: "c2", statement: "The dashboard still renders", evidence: ["screenshot"] },
        { id: "c3", statement: "An operator reads the copy", evidence: ["manual-review"] },
      ],
    });
    const patch = [
      "diff --git a/src/payout/guard.ts b/src/payout/guard.ts",
      "--- a/src/payout/guard.ts",
      "+++ b/src/payout/guard.ts",
      "@@ -1,2 +1,3 @@",
      " export const a = 1;",
      "+export const guard = true;",
      " export const b = 2;",
      'diff --git "a/docs/we\\"ird.md" "b/docs/we\\"ird.md"',
      '--- "a/docs/we\\"ird.md"',
      '+++ "b/docs/we\\"ird.md"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/package-lock.json b/package-lock.json",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1 +1 @@",
      "-1",
      "+2",
      "",
    ].join("\n");
    const run = build("t-intent", ref, {
      patch,
      stat: [
        { path: "src/payout/guard.ts", additions: 1, deletions: 0 },
        { path: 'docs/we"ird.md', additions: 1, deletions: 1 },
        { path: "package-lock.json", additions: 1, deletions: 1 },
      ],
      verdict: {
        verdict: "short",
        reasons: ["c3 needs a human"],
        matrix: [
          row("c1", "The guard is covered by tests", "pass", [{ kind: "check", ref: "npm test" }, { kind: "changed-path", ref: "src/payout/guard.ts" }]),
          row("c2", "The dashboard still renders", "failed", [{ kind: "screenshot", ref: "evidence/dash.png" }], ["the screenshot did not validate"]),
          row("c3", "An operator reads the copy", "manual-review", [{ kind: "manual-review", ref: "read it" }], ["needs a human"]),
        ],
      },
    });
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/review?result=t-intent"), { headers: { cookie } })).text();

    // The approved intent, escaped.
    expect(html).toContain("Approved by alex");
    expect(html).toContain("<strong>Goal</strong> Guard the payout &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("<strong>Not this</strong> No schema changes &amp; no API changes");
    expect(html).toContain('<span class="meta">Expected to touch</span> <span class="mono">src/payout/</span>');

    // Every signed criterion, by id, with its adjudicated state and citations.
    for (const [id, state] of [["c1", "pass"], ["c2", "failed"], ["c3", "manual-review"]] as const) {
      expect(html).toMatch(new RegExp(`data-matrix-state="${state}"[^]*?<code>${id}</code>`));
    }
    // Technical citations are available on demand; exact terms and
    // failures stay visible without opening anything.
    const matrixWindow = new Window();
    matrixWindow.document.body.innerHTML = html;
    const requirements = matrixWindow.document.querySelectorAll(".criterion-matrix .requirement");
    expect(requirements).toHaveLength(3);
    const passed = requirements[0]!;
    expect(passed.querySelector(".requirement-statement")?.textContent).toBe("The guard is covered by tests");
    expect(passed.querySelector(".requirement-statement")?.closest("details")).toBeNull();
    expect(passed.querySelector(".requirement-evidence")?.hasAttribute("open")).toBe(false);
    expect(passed.querySelector("summary")?.textContent).toBe("View evidence");
    expect(passed.querySelector(".requirement-evidence")?.textContent).toContain("npm test");
    expect(passed.querySelector(".requirement-evidence a")?.getAttribute("href")).toBe("#" + diffFileAnchor("src/payout/guard.ts"));
    expect(requirements[1]!.querySelector(".requirement-issues")?.textContent).toContain("the screenshot did not validate");
    expect(requirements[1]!.querySelector(".requirement-issues")?.closest("details")).toBeNull();
    expect(html).not.toContain("[answered:");
    await matrixWindow.happyDOM.close();
    expect(html).toContain("the screenshot did not validate");
    // The citation's anchor lands on that file's section of the sealed diff.
    expect(html).toContain(`<details class="diff-file" open id="${diffFileAnchor("src/payout/guard.ts")}">`);
    expect(html).toContain(`href="#${diffFileAnchor('docs/we"ird.md')}"`);
    expect(html).toContain(`id="${diffFileAnchor('docs/we"ird.md')}"`);
    expect(html).toContain("docs/we&quot;ird.md");

    // Drift: two files outside src/payout/ are named, first in the list.
    expect(html).toContain('data-cockpit-drift="2"');
    expect(html).toContain("2 changed files outside the approved paths");
    const files = /<ol class="cockpit-files result-files">(.*?)<\/ol>/s.exec(html)?.[1] ?? "";
    const items = [...files.matchAll(/<li data-file-priority="(\d)">.*?<a class="mono" href="#[^"]+">([^<]+)<\/a>/g)].map(m => [m[1], m[2]]);
    expect(items).toEqual([["0", "docs/we&quot;ird.md"], ["0", "package-lock.json"], ["2", "src/payout/guard.ts"]]);
    expect(files).toContain('data-outside-touches="1"');
    expect(files).toContain("outside approved paths");
    expect(files).toContain("dependencies, CI, schema, or credentials");
    expect(files).toContain("not referenced by a requirement");
    // The stored verdict and the sealed bytes are untouched by any of it.
    expect(store.proofVerdictFor(run)?.verdict).toBe("short");
    const artifact = store.artifactsFor(run).find(one => one.kind === "terminal-diff");
    if (artifact === undefined) throw new Error("no patch");
    const raw = await (await fetch(url(`/r/${run}/evidence/${artifact.id}`), { headers: { cookie } })).text();
    expect(raw).toBe(patch);
    // The patch beneath keeps its own order: guard.ts first, as sealed.
    const diff = html.slice(html.indexOf('<div class="diff-review"'));
    expect(diff.indexOf("src/payout/guard.ts")).toBeLessThan(diff.indexOf("package-lock.json"));
  });

  test("pending goal assessment does not invent a review conflict or failed checks", async () => {
    const ref = seed("t-assess", "Assess the saved goal", "/repo/main", { acceptance: [{ id: "c1", statement: "Saved values survive reload", evidence: ["check"] }] });
    const run = build("t-assess", ref, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", stat: [{ path: "x", additions: 1, deletions: 1 }],
      handoff: { conclusion: "Saved values now survive reload.", changes: [], verification: [], followUps: [] }, checkLog: "$ npm test\n164 passed\n",
      verdict: { verdict: "short", machineVerdict: "verified", reasons: ["The saved evidence is awaiting independent goal assessment."],
        matrix: [{ ...row("c1", "Saved values survive reload", "missing", [{ kind: "check", ref: "npm test" }]), assessment: { evidenceState: "pass", detail: [] } }] },
    });
    await boot(); const cookie = await login();
    for (const path of [`/r/${run}?tab=checks`, "/review?result=t-assess", "/t/t-assess"]) {
      const html = await (await fetch(url(path), { headers: { cookie } })).text();
      expect(html).not.toContain("An independent review found conflicting evidence");
      expect(html).not.toContain("Ready for goal review");
      // Plain words (task-status brief): a retired assessment is never "Not assessed".
      expect(html).not.toContain("Not assessed");
      if (path.startsWith("/r/")) {
        expect(html).toContain("Open result");
        expect(html).not.toContain("At completion:");
        expect(html).not.toContain("The agent reported no checks.");
        expect(html).not.toContain("No screenshots were needed.");
        expect(html).not.toContain("No caveats were reported.");
      }
    }
  });

  test("historical missing-evidence feedback remains readable without a new review stage", async () => {
    const ref = seed("t-gap", "Check saved settings", "/repo/main", { acceptance: [{ id: "c1", statement: "Saved values survive reload", evidence: ["check"] }] });
    const note = "Capture the selected controller layout after reloading the saved run.";
    const reason = `reviewer:codex needs more evidence for criterion "c1": ${note}`;
    const run = build("t-gap", ref, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", stat: [{ path: "x", additions: 1, deletions: 1 }],
      handoff: { conclusion: "Saved values now survive reload.", changes: [], verification: [], followUps: [] }, checkLog: "$ npm test\n164 passed\n",
      verdict: { verdict: "short", machineVerdict: "verified", reasons: [reason], matrix: [{ ...row("c1", "Saved values survive reload", "missing", [{ kind: "check", ref: "npm test" }], [reason], { judgement: "cannot-tell", note, author: "reviewer:codex" }), assessment: { evidenceState: "pass", detail: [] } }] },
    });
    await boot(); const cookie = await login();
    const html = await (await fetch(url(`/r/${run}?tab=checks`), { headers: { cookie } })).text();
    expect(html).toContain("Needs you");
    expect(html).not.toContain("More evidence needed");
    expect(html).toContain(`data-result-run="${run}"`);
    expect(renderedHtmlOf(html).split(note)).toHaveLength(2);
    expect(workspaceOf(html).pageHtml!.split(note)).toHaveLength(2);
    expect(html).not.toContain("At completion:");
  });

  test("evidence is labeled by source — machine re-run, agent checks, reviewer judgements and findings, screenshots, caveats — and says plainly what is missing", async () => {
    // The project's reviewer is codex, so the sealed review leg — and the
    // reviewer run below — is codex (v48: a run spends only as its leg).
    store.setPhaseConfig("/repo/main", "review", "codex", "gpt-5-codex", "test", T0);
    const richRef = seed("t-rich", "everything on record", "/repo/main", {
      acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }],
    });
    const rich = build("t-rich", richRef, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "x", additions: 1, deletions: 1 }],
      handoff: { conclusion: "Made it work.", changes: ["changed x"], verification: ["ran it"], followUps: ["watch the first deploy"] },
      proof: {
        version: 1,
        criteria: [{ id: "c1", statement: "It works", verdict: "met", how: "ran it", evidence: [{ kind: "check", ref: "npm test" }, { kind: "screenshot", ref: "evidence/x.png" }] }],
        checks: [{ command: "npm test", exitCode: 0, summary: "12 passed" }],
        changed: ["x"],
        caveats: ["The staging flag is still off."],
        screenshots: [{ path: "evidence/x.png", caption: "x after the change" }],
      },
      checkLog: "$ npm test\n12 passed\n",
      screenshot: { path: "evidence/x.png", caption: "x after the change" },
      verdict: {
        verdict: "refuted",
        machineVerdict: "verified",
        reasons: ["reviewer:codex contradicts c1"],
        matrix: [row("c1", "It works", "failed", [{ kind: "check", ref: "npm test" }, { kind: "screenshot", ref: "evidence/x.png" }], ["contradicted"], { judgement: "contradicts", note: "the guard is a TODO", author: "reviewer:codex" })],
      },
    });
    // The reviewer answers the finished run's open review request inside
    // its own admission (raw authority repair).
    const richAsked = store.requestReview(rich, "alex", T0);
    if (!richAsked.ok) throw new Error(`requestReview: ${richAsked.reason}`);
    const reviewerRun = store.startRun({ taskRef: richRef, leaseId: "lease-reviewer", runner: "night-shift-1", role: "reviewer", parentRun: rich, request: richAsked.id, provider: "codex", now: T0, ...presented(store, richRef, "reviewer") });
    store.stampProviderStart(reviewerRun, T0);
    const richPatch = store.artifactsFor(rich).find(one => one.kind === "terminal-diff");
    if (richPatch === undefined) throw new Error("no patch");
    store.addReviewerComments({ reviewerRunId: reviewerRun, runId: rich, artifactId: richPatch.id, author: "reviewer:codex", comments: [{ path: "x", line: 1, note: "this is not a lock", severity: "problem" }] }, T0);
    store.finishRun(reviewerRun, { outcome: "no-change", reason: "reviewed", now: T0 });

    const bareRef = seed("t-bare", "nothing but a diff");
    const bare = build("t-bare", bareRef, {
      patch: "diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "y", additions: 1, deletions: 1 }],
      verdict: { verdict: "short", reasons: ["no proof file"], matrix: [row("c1", "t-bare is done", "missing")] },
      finishedAt: at(1),
    });
    // A failed publication, observed.
    const pub = store.createPublicationIntent({ run: bare, taskRef: bareRef, githubRepo: "acme/thing", remote: "origin", base: "main", head: "standing-orders/t-bare", headSha: "b".repeat(40), bodyHash: "h", draft: false }, T0);
    store.recordPublicationError(pub, "remote: permission denied", T0);
    store.failPublication(pub, T0);
    await boot();
    const cookie = await login();

    const html = await (await fetch(url("/review?result=t-rich"), { headers: { cookie } })).text();
    expect(html).toContain('class="row result-verdict" data-proof-verdict="proof-refuted"');
    expect(html).toContain("An independent review found conflicting evidence");
    expect(html).toContain('data-cockpit-source="machine"');
    expect(html).toContain("Check output");
    expect(html).toContain("12 passed");
    expect(html).toContain('<details class="cockpit-proof-group" data-cockpit-source="agent"><summary>Agent checks · 1</summary>');
    expect(html).toContain("(exit 0) — 12 passed");
    expect(html).toContain('data-cockpit-source="reviewer"');
    expect(html).toContain('data-review-judgement="contradicts"');
    // The reviewer's concern stays in the open, with the requirement, and
    // names its author under View evidence (clear acceptance 2026-09-16).
    const reviewWindow = new Window();
    reviewWindow.document.body.innerHTML = html;
    const concern = reviewWindow.document.querySelector('.requirement[data-criterion-id="c1"] .requirement-warning[data-review-judgement="contradicts"]');
    expect(concern?.textContent).toContain("Reviewer found a problem");
    expect(concern?.textContent).toContain("the guard is a TODO");
    expect(concern?.closest("details")).toBeNull();
    expect(reviewWindow.document.querySelector('.requirement[data-criterion-id="c1"] .requirement-evidence')?.textContent).toContain("reviewer:codex");
    await reviewWindow.happyDOM.close();
    expect(html).toContain('<span class="badge badge-failed">problem</span> <span class="mono">x:1</span> this is not a lock');
    expect(html).toContain('data-cockpit-source="screenshots"');
    expect(html).toMatch(new RegExp(`<img src="/r/${rich}/evidence/\\d+" alt="x after the change">`));
    expect(html).toContain('data-cockpit-source="caveats"');
    expect(html).toContain("The staging flag is still off.");
    expect(html).toContain("Follow-up: watch the first deploy");
    expect(html).toContain("Made it work.");
    expect(html).toContain("<li>changed x</li>");
    expect(html).toContain('data-receipt-publication="none">Saved on the build branch. No publication, merge, or deployment is recorded here.');

    const plain = await (await fetch(url("/review?result=t-bare"), { headers: { cookie } })).text();
    expect(plain).toContain("No automated check was configured for this build");
    expect(plain).toContain("The agent reported no checks");
    expect(plain).toContain("No screenshots were needed");
    expect(plain).toContain("No caveats were reported");
    expect(plain).toContain('data-matrix-state="missing"');
    expect(plain).toContain('data-receipt-publication="failed">The last publication attempt failed; no pull request or merge is recorded here.</p>');
    // The failed publication stays in the open, ahead of the tabs (repair 2026-09-14), as the
    // shared status's amber Pull request row; its exact reason waits one tap away (task-status.ts).
    expect(plain).toContain('data-status-detail="pull-request" data-mark="note"');
    expect(plain.indexOf('data-status-detail="pull-request" data-mark="note"')).toBeLessThan(plain.indexOf('class="result-tabs"'));
    expect(plain).toContain("Pull request: remote: permission denied The commit is safe locally.");
  });

  test("actions: only applicable roads appear, each through its existing endpoint with the session's CSRF; a bearer session sees no forms", async () => {
    const ref = seed("t-act", "decide on me");
    const run = build("t-act", ref, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "x", additions: 1, deletions: 1 }],
      verdict: { verdict: "short", reasons: ['c1 needs a human <img src=x onerror="alert(1)">'], matrix: [row("c1", "t-act is done", "manual-review", [{ kind: "manual-review", ref: "look" }])] },
    });
    await boot();
    const cookie = await login();

    const before = await (await fetch(url("/review?result=t-act"), { headers: { cookie } })).text();
    // The primary act opens the captured check; the audited exception stays
    // beside the evidence and posts to the task's existing endpoint.
    expect(before).not.toContain('data-next-action="accept-proof"');
    // Package 3: the act opens the Checks view of the shared result panel —
    // a real link the server honours, switched in place by the script.
    expect(before).toContain('data-result-tab="checks"');
    expect(before).toContain("tab.click()");
    expect(before).toContain('data-result-tab="checks"');
    expect(before).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(before).not.toContain('<img src=x onerror="alert(1)">');
    expect(before).not.toContain('class="cockpit-accept-form"');
    expect(before).not.toContain('aria-label="exception reason"');
    expect(before).not.toContain("Accept with exception</button>");
    // Annotation and its return road, and no revision seal before a comment.
    expect(before).toContain(`<form method="post" action="/r/${run}/comment" class="diff-comment-form" id="comment-form">`);
    expect(before).toContain(`<input type="hidden" name="return" value="/review?result=t-act&amp;run=${run}">`);
    // Follow-up on build 1540: this form advertises the server's 500-character limit too, with the same helper.
    expect(before).toContain('maxlength="4000" placeholder="Describe the change…" aria-label="review comment" aria-describedby="comment-note-limit"></textarea><span class="meta diff-comment-limit" id="comment-note-limit">up to 4000 characters</span>');
    expect(before).not.toContain('maxlength="2000"');
    expect(before).not.toContain(`action="/r/${run}/revise"`);
    expect(before).not.toContain("draft-repair");
    expect(before).not.toContain("/contest/");
    // Every form carries the token, and the annotate script rides along.
    // The two forms: the note, and Add tests under Checks (this project has no check to run).
    const forms = [...mainOf(before).matchAll(/<form[^>]*>(.*?)<\/form>/gs)];
    expect(forms.length).toBe(2);
    expect(before).toContain(`<form method="post" action="/r/${run}/add-tests" class="follow-up-act">`);
    expect(before).not.toContain(`action="/r/${run}/checks"`);
    for (const form of forms) expect(form[1]).toContain('name="csrf"');
    expect(before).toContain("document.getElementById('comment-form')");
    const csrf = csrfOf(before);

    // No token: refused at the existing gate, nothing accepted.
    const forged = await post(cookie, "/t/t-act/accept-proof", { note: "sneaky" });
    expect(forged.status).toBe(403);
    expect(store.proofAcceptance(run)).toBeNull();

    // An annotation from the cockpit lands back on the cockpit, focused.
    const noted = await post(cookie, `/r/${run}/comment`, { csrf, path: "x", line: "1", note: "tighten this", return: "/review?result=t-act" });
    expect(noted.status).toBe(303);
    expect(noted.headers.get("location")).toBe("/review?result=t-act&noted=1#request-changes");
    // Any other return shape falls back to the run page.
    const elsewhere = await post(cookie, `/r/${run}/comment`, { csrf, path: "x", line: "1", note: "and this", return: "https://evil.example/review?result=t-act" });
    expect(elsewhere.headers.get("location")).toBe(`/r/${run}?noted=1#request-changes`);

    const after = await (await fetch(url("/review?result=t-act&noted=1"), { headers: { cookie } })).text();
    expect(after).toContain("tighten this");
    expect(after).toContain('name="intent" value="revise" data-request-changes>Request changes</button>');
    expect(after).toContain("Saved for later · 2");
    expect(after).toContain('aria-label="review comment" aria-describedby="comment-note-limit" autofocus>');
    // Still the accept decision first: it resolves the state; the seal waits below.
    expect(after).toContain('data-next-action="revise"');

    // Accept from the cockpit — the existing act, recorded under the session's name.
    // A message or form for a different run never accepts the current build.
    const staleLink = await fetch(url(`/review?result=t-act&run=${run + 1}&tab=checks`), { headers: { cookie } });
    expect(staleLink.status).toBe(409);
    const staleHtml = await staleLink.text();
    expect(staleHtml).toContain("Result changed");
    expect(staleHtml).toContain('<p class="refusal-back"><a class="button-link" href="/review">Review results</a></p>');
    expect(await stylesOf(staleHtml, base)).toContain('.refusal-back a { display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; }');
    expect((await fetch(url(`/review?result=t-act&run=${run}&tab=checks`), { headers: { cookie } })).status).toBe(200);
    expect((await post(cookie, "/t/t-act/accept-proof", { csrf, run: String(run + 1), note: "wrong result" })).status).toBe(409);
    expect((await post(cookie, "/t/t-act/accept-proof", { csrf, note: "missing result" })).status).toBe(409);
    expect(store.proofAcceptance(run)).toBeNull();
    const accepted = await post(cookie, "/t/t-act/accept-proof", { csrf, run: String(run), note: "read it myself" });
    expect(accepted.status).toBe(303);
    expect(store.proofAcceptance(run)?.approver).toBe("alex");
    const done = await (await fetch(url("/review?result=t-act"), { headers: { cookie } })).text();
    expect(done).not.toContain("accept-proof");
    expect(done).toContain('data-work-status="assignment-needs-decision"');
    expect(done).toContain("Accepted with an exception");
    expect(done).not.toContain("Checks passed");
    expect(done).toContain("Accepted with an exception by <span class=\"mono\">alex</span>");
    expect(done).toContain("read it myself");
    expect(queueOf(done)).toContain("Needs you");
    expect(queueOf(done)).not.toContain("missing evidence — accepted with exception");
    expect(done).toContain('data-next-action="revise"');
    // The stored verdict never moved.
    expect(store.proofVerdictFor(run)?.verdict).toBe("short");

    // A bearer credential reads the same facts but is offered no form.
    const bearer = await (await fetch(url("/review?result=t-act"), { headers: { authorization: `Bearer alex:${approverToken}` } })).text();
    expect(bearer).toContain('data-review-task="t-act"');
    expect(mainOf(bearer)).not.toContain("<form");
    expect(bearer).not.toContain('id="comment-form"');
  });

  test("a deep link resolves a completion older than the bounded queue directly, re-proved as done and in view; the queue states its cap (v2 review, comment 1)", async () => {
    // One built completion far older than a window's worth of hand-closed
    // tasks, plus an equally old one in a repo outside the ceiling.
    const oldRef = seed("t-old", "finished long ago");
    const oldRun = build("t-old", oldRef, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "x", additions: 1, deletions: 1 }],
      verdict: { verdict: "attested" },
      finishedAt: at(400),
    });
    seed("t-old-theirs", "theirs, long ago", "/repo/other");
    build("t-old-theirs", store.refFor("built-in", "t-old-theirs").id, { verdict: { verdict: "refuted" }, finishedAt: at(401) });
    // A task that was done once and reopened: no longer a completion.
    store.createTask({ id: "t-reopened", title: "reopened" }, T0);
    store.placeTask(store.refFor("built-in", "t-reopened", "ours").id, "/repo/main");
    store.setTaskState("t-reopened", "done", at(402));
    store.setTaskState("t-reopened", "queued", at(1));
    for (let i = 0; i < 101; i += 1) {
      const id = `t-recent-${String(i).padStart(3, "0")}`;
      store.createTask({ id, title: `recent ${i}` }, T0);
      store.placeTask(store.refFor("built-in", id, "ours").id, "/repo/main");
      store.setTaskState(id, "done", new Date(T0.getTime() - i * 60_000));
    }
    await boot();
    const cookie = await login();

    // The queue is bounded to the newest 100 and says so.
    const html = await (await fetch(url("/review"), { headers: { cookie } })).text();
    expect(queueOf(html).match(/<li data-review-priority=/g)?.length).toBe(100);
    expect(queueOf(html)).not.toContain("t-old");
    expect(html).toContain("Showing the newest 100; older results still open from their task");
    expect(html).not.toContain('data-cockpit-beyond="1"');

    // The old completion's link still opens it — its own build, verdict,
    // diff, and annotation road — with an honest note and no queue row.
    const old = await (await fetch(url("/review?result=t-old"), { headers: { cookie } })).text();
    expect(old).toContain('data-review-task="t-old"');
    expect(old).toContain('data-cockpit-beyond="1"');
    expect(old).toContain('This result is not in the current review list.');
    expect(old).not.toContain("is in view here");
    expect(old).not.toContain('class="cockpit-row current"');
    expect(old).toContain("Needs you");
    expect(old).toContain(`data-result-run="${oldRun}"`);
    expect(old).toContain(`href="/r/${oldRun}">Full build record →</a>`);
    expect(old).toContain(`<form method="post" action="/r/${oldRun}/comment" class="diff-comment-form" id="comment-form">`);
    expect(old).toContain('data-result-tab="changes"');

    // Outside the ceiling, or not done any more: still the missing note,
    // never the hidden row's facts.
    for (const miss of ["t-old-theirs", "t-reopened", "nope"]) {
      const body = await (await fetch(url(`/review?result=${miss}`), { headers: { cookie } })).text();
      expect(body).toContain(`No completed task <span class="mono">${miss}</span> is in view here`);
      expect(body).not.toContain('data-cockpit-beyond="1"');
      expect(body).not.toContain("theirs, long ago");
    }
  });

  test("no-change results share current task status and retain their exact saved verdicts", async () => {
    const refutedRef = seed("t-nc-refuted", "no change, refuted");
    build("t-nc-refuted", refutedRef, {
      handoff: { conclusion: "Nothing to do." },
      verdict: { verdict: "refuted", reasons: ["a criterion cites a file that did not change"] },
      outcome: "no-change",
    });
    const quietRef = seed("t-nc-attested", "no change, attested");
    build("t-nc-attested", quietRef, { handoff: { conclusion: "Already done." }, verdict: { verdict: "attested" }, outcome: "no-change", finishedAt: at(1) });
    const bareRef = seed("t-nc-bare", "no change, no verdict");
    build("t-nc-bare", bareRef, { outcome: "no-change", finishedAt: at(2) });
    await boot();
    const cookie = await login();
    // Current task state is shared; each original verdict remains exact history.
    for (const [id, verdict] of [["t-nc-refuted", "refuted"], ["t-nc-attested", "attested"], ["t-nc-bare", null]] as const) {
      const cockpit = await (await fetch(url(`/review?result=${id}`), { headers: { cookie } })).text();
      const receipt = await (await fetch(url(`/t/${id}`), { headers: { cookie } })).text();
      for (const html of [cockpit,receipt]) {
        expect(html,id).toContain('data-work-status="assignment-needs-decision"');
        expect(html,id).toContain('Needs you');
      }
      const run=store.runsFor(store.lookupRef(id)!.id)[0]!.id;
      expect(store.proofVerdictFor(run)?.verdict ?? null).toBe(verdict);
      expect(cockpit).toContain(`data-result-run="${run}"`);
    }
    const refuted = await (await fetch(url("/review?result=t-nc-refuted"), { headers: { cookie } })).text();
    expect(refuted).not.toContain('data-next-action="accept-proof"');
    expect(refuted).toContain("The build concluded that no repository change was needed.");
  });

  test("annotation eligibility is one rule: an empty or unverifiable diff offers neither the form, the file buttons, nor the picker script (v2 review, comment 5)", async () => {
    const emptyRef = seed("t-empty", "captured nothing");
    build("t-empty", emptyRef, { patch: "\n", stat: [], verdict: { verdict: "attested" } });
    const fullRef = seed("t-full", "captured something");
    const fullRun = build("t-full", fullRef, { patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", stat: [{ path: "x", additions: 1, deletions: 1 }], verdict: { verdict: "attested" }, finishedAt: at(1) });
    await boot();
    const cookie = await login();
    const empty = await (await fetch(url("/review?result=t-empty"), { headers: { cookie } })).text();
    expect(empty).toContain("Empty diff — captured successfully, nothing changed.");
    expect(empty).not.toContain('id="comment-form"');
    expect(empty).not.toContain('class="pick-file"');
    expect(empty).not.toContain('<div class="diff-review" data-review-diff>');
    // Package 3: the request-changes region says why no note can attach.
    expect(empty).toContain('data-result-feedback="unavailable"');
    expect(empty).toContain('data-result-feedback="unavailable"');
    const full = await (await fetch(url("/review?result=t-full"), { headers: { cookie } })).text();
    expect(full).toContain(`action="/r/${fullRun}/comment"`);
    expect(full).toContain('class="pick-file"');
    expect(full).toContain("document.getElementById('comment-form')");
    const bearer = await (await fetch(url("/review?result=t-full"), { headers: { authorization: `Bearer alex:${approverToken}` } })).text();
    expect(bearer).not.toContain('class="pick-file"');
    expect(bearer).not.toContain('id="comment-form"');
    expect(bearer).toContain("Sign in with a browser session to request changes.");
  });

  test("the archive and the result receipt lead into the cockpit; the cockpit leads back to the sealed record", async () => {
    const ref = seed("t-link", "linked both ways");
    const run = build("t-link", ref, {
      patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
      stat: [{ path: "x", additions: 1, deletions: 1 }],
      handoff: { conclusion: "Linked." },
      verdict: { verdict: "attested" },
    });
    await boot();
    const cookie = await login();
    const done = await (await fetch(url("/done"), { headers: { cookie } })).text();
    expect(done).toContain('<a href="/review?result=t-link">review →</a>');
    const task = await (await fetch(url("/t/t-link"), { headers: { cookie } })).text();
    expect(task).toContain('<a href="/review?result=t-link">Open result →</a>');
    const cockpit = await (await fetch(url("/review?result=t-link"), { headers: { cookie } })).text();
    expect(cockpit).toContain(`<a href="/r/${run}">Full build record →</a>`);
    expect(cockpit).toContain('href="/t/t-link"');
  });

  test("retired review controls preserve exact saved history without admitting another attempt", async () => {
    const ref = seed("t-retry", "Inspect the saved result");
    const run = build("t-retry", ref, { patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", verdict: { verdict: "verified" } });
    await boot();
    const cookie = await login();
    const pages = async () => Promise.all(["/t/t-retry", "/review?result=t-retry"].map(async path => (await fetch(url(path), { headers: { cookie } })).text()));
    for (const html of await pages()) expect(html).not.toContain('data-review-state=');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const request = store.requestReview(run, "alex", T0);
      if (!request.ok) throw new Error(request.reason);
      const [queuedTask, queuedResult] = await pages();
      expect(queuedResult).toContain('data-review-state="queued"');
      expect(queuedResult).toContain('<summary>Previous assessments</summary>');
      for (const html of [queuedTask!, queuedResult!]) expect(html).not.toContain('/retry-review');
      const admitted = store.admitReview(request.id, { runner: "night-shift-1", token: "tok-night-shift-1", provider: "claude", model: "sonnet" }, T0);
      if (!admitted.ok) throw new Error(admitted.reason);
      for (const html of await pages()) expect(html).toContain(`href="/r/${admitted.reviewerRunId}"`);
      store.finishRun(admitted.reviewerRunId, { outcome: "failed", reason: "reviewer-agent", now: T0 });
      store.stampReviewRequestOutcome(request.id, "reviewer-agent");
      const [task, cockpit] = await pages();
      expect(cockpit).toContain(`data-review-attempt="${attempt}" data-review-outcome="failed"`);
      expect(cockpit).toContain('failed · reviewer-agent');
      for (const html of [task!, cockpit!]) expect(html).not.toMatch(/action="[^"]*retry-review|Retry review|Reviewing…/);
      const csrf = csrfOf(task!);
      expect((await post(cookie, "/t/t-retry/retry-review", { run: String(run) })).status).toBe(403);
      const refused = await post(cookie, "/t/t-retry/retry-review", { csrf, run: String(run) });
      expect(refused.status).toBe(410);
      expect(await refused.text()).toContain('Separate agent reviews have retired');
      expect(store.openReviewRequests()).toEqual([]);
      expect(store.runsFor(ref).filter(one => one.role === "reviewer")).toHaveLength(attempt);
    }
  });

  test("Settings → Projects → Pull requests checks gh and push rights, then turns on behind the password", async () => {
    let permission = "READ";
    const publishExec: PublishExec = async (file, args) => {
      const key = [file, ...args].join(" ");
      const ok = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
      if (key.startsWith("git remote get-url")) return { ...ok, stdout: "https://github.com/alex/payouts.git\n" };
      if (key.startsWith("gh repo view")) return { ...ok, stdout: JSON.stringify({ nameWithOwner: "alex/payouts", defaultBranchRef: { name: "main" }, viewerPermission: permission }) };
      if (key.startsWith("gh api user")) return { ...ok, stdout: "alex\n" };
      return ok;
    };
    await boot({ publishExec });
    const cookie = await login();
    const page = async () => (await fetch(url(`/settings/pull-requests?repo=${encodeURIComponent("/repo/main")}`), { headers: { cookie } })).text();
    const blocked = await page();
    expect(blocked).toContain("Can\u2019t turn on yet");
    expect(blocked).toContain("Your GitHub account can&#39;t push to alex/payouts. Ask for write access, then try again.");
    permission = "WRITE";
    const offer = await page();
    expect(offer).toContain("Ready to turn on");
    expect(offer).toContain('Pull requests open on <span class="mono">alex/payouts</span> into <span class="mono">main</span>, as alex.');
    const csrf = csrfOf(offer);
    const fields = { csrf, repo: "/repo/main", act: "on", github: "alex/payouts", base: "main" };
    const refused = await post(cookie, "/settings/pull-requests", fields);
    expect(decodeURIComponent(refused.headers.get("location") ?? "")).toContain("problem=Enter your Toolroll password");
    expect(store.publicationGrantFor("/repo/main")).toBeNull();
    const turnedOn = await post(cookie, "/settings/pull-requests", { ...fields, password: approverToken });
    expect(decodeURIComponent(turnedOn.headers.get("location") ?? "")).toContain("said=Pull requests are on.");
    expect(store.publicationGrantFor("/repo/main")).toMatchObject({ githubRepo: "alex/payouts", base: "main", publishOn: "complete", mergeMethod: "squash", mergeWhenGreen: false });
    const on = await page();
    expect(on).toContain("<strong>On</strong>");
    expect(on).toContain("Merge when checks pass");
    await post(cookie, "/settings/pull-requests", { csrf, repo: "/repo/main", act: "settings", method: "merge", "when-green": "1", password: approverToken });
    expect(store.publicationGrantFor("/repo/main")).toMatchObject({ mergeMethod: "merge", mergeWhenGreen: true, publishOn: "complete" });
  });

  test("with pull requests set up, Complete opens a pull request, the task shows its link and CI, and Merge takes the password", async () => {
    const ref = seed("t-pr", "Keep the payout total accurate");
    const run = build("t-pr", ref, { patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", handoff: { conclusion: "Saved the payout correction." }, verdict: { verdict: "verified" } });
    const calls: string[][] = [];
    let merged = false;
    const publishExec: PublishExec = async (file, args) => {
      calls.push([file, ...args]);
      const key = [file, ...args].join(" ");
      const ok = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
      if (key.startsWith("gh pr merge")) { merged = true; return ok; }
      if (key.startsWith("gh pr view")) {
        return { ...ok, stdout: JSON.stringify({ state: merged ? "MERGED" : "OPEN", isDraft: false, headRefOid: "b".repeat(40),
          statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }], mergeCommit: merged ? { oid: "c".repeat(40) } : null }) };
      }
      return ok;
    };
    await boot({ publishExec });
    store.stampRun(run, { scopeDigest: store.getScope("t-pr")!.digest });
    store.setVerifyCommand({ repo: "/repo/main", command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, new Date(T0.getTime() - 120_000));
    storeEvidence(store, evidenceRoot, run, "check-log", "checks.txt", Buffer.from("12 payout tests passed"), "npm test", T0, { captureStatus: "ok" });
    sealVerificationReceipt(store, evidenceRoot, run, "b".repeat(40), store.liveVerifyCommand("/repo/main")!, { configured: true, ran: true, exitCode: 0 }, T0);
    savePublishing(store, { repo: "/repo/main", githubRepo: "alex/payouts", remote: "origin", base: "main", account: "alex" }, "alex", {}, T0);
    const cookie = await login();
    const chat = await (await fetch(url(`/chat?task=t-pr&result=${run}`), { headers: { cookie } })).text();
    const form = /<form[^>]*action="\/t\/t-pr\/complete"[^>]*>[\s\S]*?<\/form>/.exec(chat)?.[0] ?? "";
    expect(form).toContain('name="publish" value="1"');
    expect(form).toContain("Complete and open a pull request</button>");
    expect(form).toContain("Accept and finish</button>");
    expect(form).toContain("Finishes the task. A pull request opens on alex/payouts into main from this exact commit when you ask for one.");
    const receipt = /name="receipt" value="([a-f0-9]{64})"/.exec(form)?.[1] ?? "";
    const csrf = csrfOf(chat);
    const done = await post(cookie, "/t/t-pr/complete", { csrf, run: String(run), receipt, publish: "1" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/t/t-pr#merge");
    const publication = store.publicationForRun(run)!;
    expect(publication).toMatchObject({ headSha: "b".repeat(40), head: "standing-orders/t-pr", githubRepo: "alex/payouts", base: "main", state: "intended" });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = ? AND run_id = ?").get(PR_COMPLETION_ACTION, run)).toEqual({ n: 1 });

    // The publisher opened it and CI was seen green on the accepted commit.
    store.markPublicationPushed(publication.id, T0);
    store.markPublicationOpened(publication.id, 7, "https://github.com/alex/payouts/pull/7", T0);
    store.recordPublicationCheckState(publication.id, "passing", T0);
    const page = async () => (await (await fetch(url("/t/t-pr"), { headers: { cookie } })).text()).replace(/\\u003c/g, "<").replace(/\\"/g, '"');
    const ready = await page();
    expect(ready).toContain('data-pull-request="ready"');
    expect(ready).toContain("<strong>Ready to merge</strong>");
    expect(ready).toContain('href="https://github.com/alex/payouts/pull/7"');
    expect(ready).toContain('action="/t/t-pr/merge"');
    expect(ready).toContain("Squash-merges PR #7 into main and deletes its branch.");

    // No password, a wrong one: refused, and GitHub is never asked to merge.
    expect((await post(cookie, "/t/t-pr/merge", { csrf, run: String(run) })).status).toBe(403);
    expect((await post(cookie, "/t/t-pr/merge", { csrf, run: String(run), token: "not-the-password" })).status).toBe(403);
    expect(calls.filter(call => call[1] === "pr" && call[2] === "merge")).toEqual([]);
    const mergedResponse = await post(cookie, "/t/t-pr/merge", { csrf, run: String(run), token: approverToken });
    expect(mergedResponse.status).toBe(303);
    expect(calls.filter(call => call[1] === "pr" && call[2] === "merge")).toEqual([["gh", "pr", "merge", "7", "--repo", "alex/payouts", "--squash", "--match-head-commit", "b".repeat(40), "--delete-branch"]]);
    const after = await page();
    // Said once: the merged pull request is the status card's own row; who merged it waits under Details.
    expect(after).toContain('data-status-detail="pull-request" data-mark="ok"');
    expect(after).toContain("Merged by alex (squash). Branch deleted.");
    expect(after).toContain("c".repeat(12));
    expect(after).not.toContain('action="/t/t-pr/merge"');
  });

  test("the result page shows each item to check with its evidence before the decision, and Accept says what it does", async () => {
    const statement = "The empty state reads clearly on a phone";
    const long = `  return "${"Nothing to review yet — new results land here when a build finishes. ".repeat(3).trim()}";`;
    const ref = seed("t-look", "Clarify the empty state", "/repo/main", { acceptance: [{ id: "c1", statement, evidence: ["manual-review"] }] });
    const reason = 'criterion "c1" requires manual-review evidence — an operator must accept it before this can verify';
    const run = build("t-look", ref, {
      patch: `diff --git a/src/empty.ts b/src/empty.ts\n--- a/src/empty.ts\n+++ b/src/empty.ts\n@@ -1,3 +1,3 @@\n export function emptyWords() {\n-  return "No results";\n+${long}\n }\n`,
      stat: [{ path: "src/empty.ts", additions: 1, deletions: 1 }],
      handoff: { conclusion: "Rewrote the empty state so it says where results come from." },
      screenshot: { path: "evidence/empty.png", caption: "Empty state at 390px" },
      proof: {
        version: 1,
        criteria: [{ id: "c1", statement, verdict: "met", how: "Looked at it at 390px.", evidence: [{ kind: "manual-review", ref: "Open Results with nothing in it at 390px." }] }],
        checks: [], changed: ["src/empty.ts"], caveats: [], screenshots: [{ path: "evidence/empty.png", caption: "Empty state at 390px" }],
      },
      verdict: { verdict: "short", reasons: [reason], matrix: [row("c1", statement, "manual-review", [{ kind: "changed-path", ref: "src/empty.ts" }, { kind: "screenshot", ref: "evidence/empty.png" }, { kind: "manual-review", ref: "Open Results with nothing in it at 390px." }], [reason])] },
    });
    await boot();
    store.stampRun(run, { scopeDigest: store.getScope("t-look")!.digest });
    const cookie = await login();
    const read = async () => ((await (await fetch(url(`/review?result=t-look&run=${run}&format=workspace`), { headers: { cookie } })).json()) as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    const first = (await read()).selected!;
    const item = first.panel!.youCheck!.items[0]!;
    expect(item).toMatchObject({ id: "c1", statement, note: "Open Results with nothing in it at 390px." });
    // The changed lines it cites, whole: wrapping is the page's job, never a cut.
    expect(item.excerpts).toEqual([{ path: "src/empty.ts", cited: true, more: 0, lines: [{ kind: "deletion", line: 2, text: '  return "No results";' }, { kind: "addition", line: 2, text: long }] }]);
    expect(item.shots).toHaveLength(1);
    expect(item.shots[0]!.src).toMatch(new RegExp(`^/r/${run}/evidence/[0-9]+$`));
    expect(first.panel!.youCheck!.accept).toMatchObject({ action: "/t/t-look/accept-proof", run });
    // Its Requirements row counts it as the person's, so the page can count each Looks right as met.
    expect(first.panel!.requirements).toEqual({ met: 0, total: 1, yours: 1, missed: 0 });
    // Checks didn't run and the item is still the person's: Accept without your check, naming it, and that it finishes the task.
    expect(first.decision).toEqual({ label: "Accept without your check", ready: false, why: `Not checked yet: “${statement}”.`,
      effect: "Finishes the task. The branch stays; publishing isn't set up.", sentence: "Review the change, then accept it or ask for changes.",
      base: { label: "Accept without checks", ready: false, why: "Checks didn't run." } });
    // One request: the completion carries the acceptance the person's check owes.
    expect(first.complete).toMatchObject({ action: "/t/t-look/complete", run, accept: { note: null } });
    expect(first.complete).not.toHaveProperty("publish");
    // Until the check is answered, the next check is the ink act and Accept waits in outline.
    expect(first.acts).toEqual({ primary: "next-check", secondary: "accept", line: null });
    expect(first.actFacts).toMatchObject({ accept: { ready: false }, unanswered: 1, notRight: 0 });
    expect(first.runChecks).toBeNull();
    const csrf = csrfOf(await (await fetch(url(`/review?result=t-look&run=${run}`), { headers: { cookie } })).text());
    const verdict = store.proofVerdictFor(run);
    const ledger = () => store.handle.prepare("SELECT actor, task_id AS taskId, run_id AS runId, action, outcome, source FROM action_ledger WHERE task_id = 't-look' AND source <> 'policy' AND outcome <> 'requested' ORDER BY id").all();
    const before = ledger().length;
    // A receipt other than the one read refuses both: nothing is accepted or completed.
    expect((await post(cookie, "/t/t-look/complete", { csrf, run: String(run), receipt: "0".repeat(64), accept: "1" })).status).toBe(409);
    expect(store.proofAcceptance(run)).toBeNull();
    // Accept and finish: one request records the acceptance and completes the receipt that acceptance produces.
    const done = await post(cookie, "/t/t-look/complete", { csrf, run: String(run), receipt: first.complete!.receipt, accept: "1" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`/review?result=t-look&run=${run}`);
    expect(store.proofAcceptance(run)).toMatchObject({ approver: "alex", note: null });
    const assignment = assignmentOf(store, "t-look", new Date(), { principal: "operator", repos: null }, evidenceRoot)!;
    expect(assignment.state).toBe("complete");
    expect(assignment.receipt!.completionKind).toBe("accepted-exception");
    // Both ledger acts, as Accept then Mark complete leave them, and the completion digest is the accepted receipt's (not the one read).
    const acts = ledger().slice(before).filter(row => row["action"] !== "task complete");
    expect(acts).toEqual([
      { actor: "alex", taskId: "t-look", runId: null, action: "task accept-proof", outcome: "accepted", source: "request" },
      { actor: "operator:alex", taskId: "t-look", runId: run, action: PR_COMPLETION_ACTION, outcome: assignment.receipt!.digest, source: "work" },
    ]);
    expect(assignment.completion?.digest).toBe(assignment.receipt!.digest);
    expect(assignment.receipt!.digest).not.toBe(first.complete!.receipt);
    // The verdict stays as recorded; nothing is left to decide.
    expect(store.proofVerdictFor(run)).toEqual(verdict);
    const after = (await read()).selected!;
    expect(after.decision).toBeNull();
    expect(after.panel!.youCheck).toBeNull();
  });

  test("Accept and finish refused at completion keeps no acceptance", async () => {
    const statement = "The copy reads clearly";
    const reason = 'criterion "c1" requires manual-review evidence — an operator must accept it before this can verify';
    const ref = seed("t-undo", "Clarify the copy", "/repo/main", { acceptance: [{ id: "c1", statement, evidence: ["manual-review"] }] });
    const run = build("t-undo", ref, {
      patch: "diff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -1 +1 @@\n-a\n+b\n", stat: [{ path: "z", additions: 1, deletions: 1 }],
      verdict: { verdict: "short", reasons: [reason], matrix: [row("c1", statement, "manual-review", [{ kind: "manual-review", ref: "Read it." }], [reason])] },
    });
    await boot();
    store.stampRun(run, { scopeDigest: store.getScope("t-undo")!.digest });
    const read = () => assignmentOf(store, "t-undo", new Date(), { principal: "operator", repos: null }, evidenceRoot)!;
    const who = verifyApproverByPassword(store, "alex", approverToken, ["/repo/main"]);
    if (!who.ok) throw new Error("approver fixture");
    const receipt = read().receipt!.digest;
    // The completion is refused after the acceptance was written: the transaction keeps neither.
    const refused = acceptAndCompleteAsOperator(store, "t-undo", { runId: run, receiptDigest: receipt, note: null }, who.who, new Date(), evidenceRoot,
      () => ({ ok: false, reason: "approval-rules", message: "Someone else must complete this." }));
    expect(refused).toEqual({ ok: false, reason: "approval-rules", message: "Someone else must complete this." });
    expect(store.proofAcceptance(run)).toBeNull();
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE task_id = 't-undo' AND action IN ('task accept-proof', ?)").get(PR_COMPLETION_ACTION)).toEqual({ n: 0 });
    expect(read().receipt!.digest).toBe(receipt);
    expect(acceptAndCompleteAsOperator(store, "t-undo", { runId: run, receiptDigest: receipt, note: null }, who.who, new Date(), evidenceRoot).ok).toBe(true);
    expect(read().state).toBe("complete");
  });

  test("a crafted Accept and finish records an acceptance only for a person's check or a reasoned exception, refuses an exception without its reason, and is otherwise a plain completion", async () => {
    const mismatch = { verdict: "refuted" as const, reasons: ["a criterion cites a file that did not change"] };
    const patch = "diff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -1 +1 @@\n-a\n+b\n";
    const bare = build("t-bare", seed("t-bare", "Round the totals"), { patch, stat: [{ path: "z", additions: 1, deletions: 1 }] });
    const silent = build("t-silent", seed("t-silent", "Round the fees"), { patch, stat: [{ path: "z", additions: 1, deletions: 1 }], verdict: mismatch });
    const reasoned = build("t-reasoned", seed("t-reasoned", "Round the refunds"), { patch, stat: [{ path: "z", additions: 1, deletions: 1 }], verdict: mismatch });
    await boot();
    for (const id of ["t-bare", "t-silent", "t-reasoned"]) store.stampRun(store.runsFor(store.refFor("built-in", id).id)[0]!.id, { scopeDigest: store.getScope(id)!.digest });
    const cookie = await login();
    const read = (id: string) => assignmentOf(store, id, new Date(), { principal: "operator", repos: null }, evidenceRoot)!;
    const acceptances = (id: string) => store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE task_id = ? AND action = 'task accept-proof'").get(id);
    // A report that doesn't match its changes: the page's Accept and finish asks for the reason, required, in the same form.
    const html = await (await fetch(url(`/review?result=t-silent&run=${silent}`), { headers: { cookie } })).text();
    const form = /<form[^>]*action="\/t\/t-silent\/complete"[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    expect(form).toContain('name="accept" value="1"');
    expect(form).toMatch(/<input type="text"[^>]*name="note"[^>]*required/);
    const csrf = csrfOf(html);
    // Nothing owed (no proof at all, as the page asks for none): accept=1 is the plain completion, no acceptance, even with a note.
    expect((await post(cookie, "/t/t-bare/complete", { csrf, run: String(bare), receipt: read("t-bare").receipt!.digest, accept: "1", note: "Looks fine." })).status).toBe(303);
    expect(read("t-bare").state).toBe("complete");
    expect(store.proofAcceptance(bare)).toBeNull();
    expect(acceptances("t-bare")).toEqual({ n: 0 });
    // A mismatch posted without its reason (the form's required attribute bypassed): the server refuses it, in the page's
    // words; nothing is accepted or completed, its verdict unchanged.
    const verdict = store.proofVerdictFor(silent);
    for (const note of [undefined, "   "]) {
      const refused = await post(cookie, "/t/t-silent/complete", { csrf, run: String(silent), receipt: read("t-silent").receipt!.digest, accept: "1", ...(note === undefined ? {} : { note }) });
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain("Accepting needs a reason");
    }
    expect(read("t-silent").state).toBe("ready-to-check");
    expect(store.proofAcceptance(silent)).toBeNull();
    expect(acceptances("t-silent")).toEqual({ n: 0 });
    expect(store.proofVerdictFor(silent)).toEqual(verdict);
    // With its reason: the exception is accepted, with the reason, and the task finishes in the same request.
    expect((await post(cookie, "/t/t-reasoned/complete", { csrf, run: String(reasoned), receipt: read("t-reasoned").receipt!.digest, accept: "1", note: "The cited file moved; the change is right." })).status).toBe(303);
    expect(store.proofAcceptance(reasoned)).toMatchObject({ approver: "alex", note: "The cited file moved; the change is right." });
    expect(acceptances("t-reasoned")).toEqual({ n: 1 });
    expect(read("t-reasoned")).toMatchObject({ state: "complete", receipt: { completionKind: "accepted-exception" } });
  });

  test("checks that didn't run on a project that has one: Run checks is the one ink act, Accept without checks beside it", async () => {
    const patch = "diff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -1 +1 @@\n-a\n+b\n";
    const run = build("t-runcheck", seed("t-runcheck", "Check the rounding"), { patch, stat: [{ path: "z", additions: 1, deletions: 1 }], handoff: { conclusion: "Rounded at cent precision." } });
    await boot();
    store.stampRun(run, { scopeDigest: store.getScope("t-runcheck")!.digest });
    store.setVerifyCommand({ repo: "/repo/main", command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, new Date());
    const cookie = await login();
    const read = async () => ((await (await fetch(url(`/review?result=t-runcheck&run=${run}&format=workspace`), { headers: { cookie } })).json()) as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    const selected = (await read()).selected!;
    expect(selected.acts).toMatchObject({ primary: "run-checks", secondary: "accept", line: null });
    expect(selected.runChecks).toEqual({ action: `/r/${run}/checks`, level: "full", returnTo: `/review?result=t-runcheck&run=${run}&tab=checks` });
    expect(selected.decision).toMatchObject({ label: "Accept without checks", ready: false });
    // Run checks posts to the run's own follow-up act; once one is waiting, it isn't offered again.
    const csrf = csrfOf(await (await fetch(url(`/review?result=t-runcheck&run=${run}`), { headers: { cookie } })).text());
    const asked = await post(cookie, selected.runChecks!.action, { csrf, level: "full", return: selected.runChecks!.returnTo });
    expect(asked.status).toBe(303);
    // Back on the result's Checks tab, at an anchor that is there and showing.
    expect(asked.headers.get("location")).toBe(`/review?result=t-runcheck&run=${run}&tab=checks#follow-ups`);
    const landed = (await (await fetch(url(`/review?result=t-runcheck&run=${run}&tab=checks&format=workspace`), { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    const checksView = landed.selected!.panel!.views.find(one => one.key === "checks")!;
    expect(checksView.html).toContain('id="follow-ups"');
    expect(landed.selected!.panel!.tabs.find(one => one.active)?.key).toBe("checks");
    // While they're queued or running, no Accept is ink: a disabled Checks running leads, Accept without checks in outline.
    const after = (await read()).selected!;
    expect(after.runChecks).toBeNull();
    expect(after.acts).toEqual({ primary: "checks-running", secondary: "accept", line: null });
    expect(after.decision).toMatchObject({ label: "Accept without checks", ready: false });
  });

  test("a failed build has a working result page: what it missed, its diff and checks, Retry with the suggestion, and Run checks that stays put", async () => {
    const statement = "No reference to LEGACY remains in the codebase.";
    const patch = "diff --git a/src/flag.ts b/src/flag.ts\n--- a/src/flag.ts\n+++ b/src/flag.ts\n@@ -1,2 +1 @@\n-export const LEGACY = true;\n export const NEXT = true;\n";
    const run = build("t-fail", seed("t-fail", "Retire the flag", "/repo/main", { acceptance: [{ id: "c1", statement, evidence: ["changed-path"] }] }), {
      patch, stat: [{ path: "src/flag.ts", additions: 0, deletions: 1 }], handoff: { conclusion: "Removed the flag from src/flag.ts." },
      verdict: { verdict: "refuted", reasons: [], matrix: [row("c1", statement, "failed", [{ kind: "changed-path", ref: "src/flag.ts" }],
        ['criterion "c1" is marked met, but caveat 1 admits an exception to it: c1: src/admin.ts still reads LEGACY for the override toggle.'])] },
      outcome: "failed", reason: "acceptance",
    });
    await boot();
    store.setVerifyCommand({ repo: "/repo/main", command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, new Date());
    const cookie = await login();
    const suggestion = "Before handing off, make sure no reference to LEGACY remains in the codebase.";
    const page = `/review?result=t-fail&run=${run}`;
    // The task card names the miss, its evidence line and the build's page; Retry's note starts with the suggestion.
    const task = workspaceOf(await (await fetch(url("/t/t-fail"), { headers: { cookie } })).text()).view as import("./browser-workspace.js").BrowserTaskView;
    expect(task.failure).toEqual({ line: `Missed a requirement: ${statement}`, evidence: "The agent's own note says: src/admin.ts still reads LEGACY for the override toggle.",
      suggestion, link: { label: `See build #${run}`, href: page } });
    expect(task.retry).toEqual({ action: "/t/t-fail/requeue", note: suggestion });
    // No status row leads to Chat: Run checks is in place, posting here and coming back here.
    expect(JSON.stringify(task.status)).not.toContain("/chat?");
    expect(task.runChecks).toEqual({ action: `/r/${run}/checks`, level: "full", returnTo: "/t/t-fail" });
    expect(task.status!.status.details.find(one => one.key === "checks")?.action).toEqual({ label: "Run checks", href: `/r/${run}/checks` });

    // /r/<id> opens that page; the page is there, with the diff, the checks and the failure, and no Accept.
    const redirected = await fetch(url(`/r/${run}`), { headers: { cookie }, redirect: "manual" });
    expect(redirected.headers.get("location")).toBe(page);
    expect((await fetch(url(`/r/${run}?record=1`), { headers: { cookie } })).status).toBe(200);
    const read = async () => ((await (await fetch(url(`${page}&format=workspace`), { headers: { cookie } })).json()) as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    const selected = (await read()).selected!;
    expect(selected.status).toMatchObject({ label: "Failed" });
    expect(selected.panel!.status).toMatchObject({ headline: "Failed", sentence: `Missed a requirement: ${statement}` });
    // What it missed is said once, plainly: the recorded wording isn't repeated as a caveat.
    expect(selected.panel!.attention.join(" ")).not.toContain("caveat 1 admits");
    expect(selected.failure).toEqual({ line: `Missed a requirement: ${statement}`, evidence: task.failure!.evidence, suggestion, link: null, retry: { action: "/t/t-fail/requeue", note: suggestion } });
    // The Requirements row says what failed, in a count: never "Unverified".
    expect(selected.panel!.status!.details.find(one => one.key === "requirements")).toMatchObject({ text: "1 missed", mark: "failed" });
    expect(selected.acts).toEqual({ primary: "retry", secondary: "run-checks", line: null });
    expect(selected.decision).toBeNull();
    expect(selected.complete).toBeNull();
    expect(selected.panel!.views.find(one => one.key === "changes")!.html).toContain("src/flag.ts");
    expect(selected.panel!.views.some(one => one.key === "checks")).toBe(true);
    expect(JSON.stringify(selected.panel!.status)).not.toContain("/chat?");

    // Run checks from the task page comes back to the task page; from here it stays on this page's Checks.
    const csrf = csrfOf(await (await fetch(url("/t/t-fail"), { headers: { cookie } })).text());
    const fromTask = await post(cookie, task.runChecks!.action, { csrf, level: "full", return: task.runChecks!.returnTo });
    expect(fromTask.status).toBe(303);
    expect(fromTask.headers.get("location")).toBe("/t/t-fail");
    expect((await read()).selected!.acts).toEqual({ primary: "retry", secondary: "checks-running", line: null });
    expect(selected.runChecks).toEqual({ action: `/r/${run}/checks`, level: "full", returnTo: `${page}&tab=checks` });
    const again = await post(cookie, selected.runChecks!.action, { csrf, level: "full", return: selected.runChecks!.returnTo });
    expect(again.headers.get("location")).toBe(`${page}&tab=checks#follow-ups`);
    // Only this run's own task page is a way back; another task's page is not.
    expect(resultReturnTarget("/t/t-fail", run, ["t-fail"])).toBe("/t/t-fail");
    expect(resultReturnTarget("/t/t-other", run, ["t-fail"])).toBe(`/r/${run}`);
    expect(resultReturnTarget("/t/t-fail", run)).toBe(`/r/${run}`);

    // Retried, the task moves on; the build's page still opens, now without Retry.
    expect((await post(cookie, "/t/t-fail/requeue", { csrf })).status).toBe(303);
    const after = (await read()).selected!;
    expect(after.failure).toMatchObject({ line: `Missed a requirement: ${statement}`, retry: null });
    expect(after.acts.primary).not.toBe("retry");
  });

  test("a failed task's delivered result reads Failed: Retry is the ink act, and Accept anyway, in outline, takes a reason", async () => {
    const patch = "diff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -1 +1 @@\n-a\n+b\n";
    const run = build("t-builtfail", seed("t-builtfail", "Built, then the task failed"), { patch, stat: [{ path: "z", additions: 1, deletions: 1 }], verdict: { verdict: "verified" } });
    store.setTaskState("t-builtfail", "failed", T0);
    await boot();
    const cookie = await login();
    const page = `/review?result=t-builtfail&run=${run}`;
    expect((await fetch(url(`/r/${run}`), { headers: { cookie }, redirect: "manual" })).headers.get("location")).toBe(page);
    const read = async () => ((await (await fetch(url(`${page}&format=workspace`), { headers: { cookie } })).json()) as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    const selected = (await read()).selected!;
    // The Failed reading, with what went wrong as its sentence and Retry's note holding what to change.
    expect(selected.status.label).toBe("Failed");
    expect(selected.panel!.status).toMatchObject({ headline: "Failed", sentence: selected.failure!.line });
    expect(selected.failure!.line).not.toBe("");
    expect(selected.failure!.retry).toEqual({ action: "/t/t-builtfail/requeue", note: selected.failure!.suggestion });
    // Retry is the ink act; Accept is only the outline Accept anyway, posting this exact result with a reason.
    expect(selected.acts).toEqual({ primary: "retry", secondary: "accept-anyway", line: null });
    expect(selected.decision).toBeNull();
    expect(selected.complete).toBeNull();
    expect(selected.failure!.acceptAnyway).toEqual({ action: "/t/t-builtfail/accept-proof", run, returnTo: page });
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { ResultView } = await import("./browser/views/result-view.js");
    // The page renders in a browser: it reads its own origin.
    const shown = await read();
    const global = globalThis as { window?: unknown };
    global.window = { location: { origin: "http://127.0.0.1" } };
    const rendered = (() => { try { return renderToStaticMarkup(createElement(ResultView, { view: shown, csrf: "token" })); } finally { delete global.window; } })();
    const decision = rendered.split("data-result-decision=")[1]!.split("</section>")[0]!;
    expect(decision.startsWith(`"retry"`)).toBe(true);
    expect(decision).toMatch(/<form data-retry="true"[^>]*action="\/t\/t-builtfail\/requeue"/);
    expect(decision.indexOf("data-retry")).toBeLessThan(decision.indexOf("data-accept-anyway"));
    const anyway = decision.split("data-accept-anyway")[1]!.split("</form>")[0]!;
    expect(anyway).toContain("Accepting needs a reason");
    expect(anyway).toMatch(/<input(?=[^>]*\bname="note")(?=[^>]*\brequired)[^>]*>/);
    expect(anyway).toMatch(/data-act="accept-anyway"[^>]*>.*Accept anyway<\/button>/);
    expect(anyway).not.toContain("data-ink-act");
    expect(anyway).toContain(`name="return" value="${page.replaceAll("&", "&amp;")}"`);
    // Without a reason it is refused: posted from this result page, back to it with the refusal said there, not a task screen.
    const csrf = csrfOf(await (await fetch(url("/t/t-builtfail"), { headers: { cookie } })).text());
    const refused = await post(cookie, "/t/t-builtfail/accept-proof", { csrf, run: String(run), return: page });
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe(`${page}&refused=reason`);
    expect(store.proofAcceptance(run)).toBeNull();
    const told = await (await fetch(url(`${page}&refused=reason&format=workspace`), { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect((told.view as import("./browser-workspace.js").BrowserResultView).selected!.problem).toBe("Accepting anyway needs a reason.");
    expect(await (await fetch(url(`${page}&refused=reason`), { headers: { cookie } })).text()).toContain("Accepting anyway needs a reason.");
    // Only the fixed refusal words: an address can't put its own text on the page.
    expect((await read()).selected!.problem).toBeNull();
    const forged = await (await fetch(url(`${page}&refused=${encodeURIComponent("Your account is locked")}&format=workspace`), { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect((forged.view as import("./browser-workspace.js").BrowserResultView).selected!.problem).toBeNull();
    // Posted from anywhere else, the task screen says it.
    expect((await post(cookie, "/t/t-builtfail/accept-proof", { csrf, run: String(run) })).status).toBe(400);
    const accepted = await post(cookie, "/t/t-builtfail/accept-proof", { csrf, run: String(run), return: page, note: "The flag stays for one release on purpose." });
    expect(accepted.status).toBe(303);
    expect(store.proofAcceptance(run)).toMatchObject({ note: "The flag stays for one release on purpose." });
    const after = (await read()).selected!;
    expect(after.failure!.acceptAnyway ?? null).toBeNull();
    expect(after.acts.secondary).not.toBe("accept-anyway");
  });

  test("a missing or unreadable proof reads Accept without checks, and Accept never posts publish", async () => {
    const patch = "diff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -1 +1 @@\n-a\n+b\n";
    const missing = build("t-noproof", seed("t-noproof", "No proof on record"), { patch, stat: [{ path: "z", additions: 1, deletions: 1 }], verdict: { verdict: "verified" } });
    const damaged = build("t-badproof", seed("t-badproof", "A proof that can't be read"), { patch, stat: [{ path: "z", additions: 1, deletions: 1 }], proof: { version: 99 }, verdict: { verdict: "verified" } });
    await boot();
    store.stampRun(missing, { scopeDigest: store.getScope("t-noproof")!.digest });
    store.stampRun(damaged, { scopeDigest: store.getScope("t-badproof")!.digest });
    const cookie = await login();
    const read = async (task: string, run: number) => ((await (await fetch(url(`/review?result=${task}&run=${run}&format=workspace`), { headers: { cookie } })).json()) as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    for (const [task, run] of [["t-noproof", missing], ["t-badproof", damaged]] as const) {
      const selected = (await read(task, run)).selected!;
      expect(selected.decision).toMatchObject({ label: "Accept without checks", ready: false });
      expect(selected.decision!.why).toMatch(/^Nothing on record says what was met/);
      expect(selected.complete).not.toHaveProperty("publish");
    }
  });

  test("mark complete binds the exact saved result and preserves check failures and publication authority", async () => {
    const ref = seed("t-complete", "Keep the payout total accurate");
    const historical = build("t-complete", ref, { patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-before\n+earlier\n", handoff: { conclusion: "Saved the earlier payout correction." } });
    const run = build("t-complete", ref, { patch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", handoff: { conclusion: "Saved the payout correction." }, verdict: { verdict: "refuted", reasons: ["the repository's approved verification command exited 1"] } });
    await boot();
    store.stampRun(run, { scopeDigest: store.getScope("t-complete")!.digest });
    store.setVerifyCommand({ repo: "/repo/main", command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, new Date(T0.getTime() - 120_000));
    storeEvidence(store, evidenceRoot, run, "check-log", "checks.txt", Buffer.from("Payout rounding check failed"), "npm test", T0, { captureStatus: "ok" });
    sealVerificationReceipt(store, evidenceRoot, run, "b".repeat(40), store.liveVerifyCommand("/repo/main")!, { configured: true, ran: true, exitCode: 1 }, T0);
    const cookie = await login();
    const html = await (await fetch(url(`/review?result=t-complete&run=${run}`), { headers: { cookie } })).text();
    // Checks failed on the saved result: the one red headline (task-status.ts), still ready to complete or revise.
    expect(html).toContain('>Failed</span>');
    expect(queueOf(html)).toContain('data-work-status="assignment-ready-to-check"');
    expect(queueOf(html)).not.toContain('conflicting evidence');
    expect(html).toContain('1 needs your attention');
    expect(html).toContain('Accept and finish</button>');
    expect(html).toContain('Checks stay unchanged; nothing is published or deployed.');
    const decision = ((await (await fetch(url(`/review?result=t-complete&run=${run}&format=workspace`), { headers: { cookie } })).json()) as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    expect(decision.selected!.decision).toMatchObject({ label: "Accept and finish", ready: false, why: "Nothing on record says what was met and checks failed." });
    // The one ink act resolves it: Request changes, after one line saying why; Accept stays as allowed, in outline.
    expect(decision.selected!.acts).toEqual({ primary: "request-changes", secondary: "accept", line: "Can't accept yet: the project's check failed on these changes." });
    const receipt = /name="receipt" value="([a-f0-9]{64})"/.exec(html)?.[1];
    expect(receipt).toBeDefined();
    const csrf = csrfOf(html);
    const chatResult = await (await fetch(url(`/chat?task=t-complete&result=${run}`), { headers: { cookie } })).text();
    const completionForm = /<form[^>]*action="\/t\/t-complete\/complete"[^>]*>[\s\S]*?<\/form>/.exec(chatResult)?.[0];
    expect(completionForm).toBeDefined();
    expect(completionForm).toContain(`name="csrf" value="${csrf}"`);
    expect(completionForm).toContain(`name="receipt" value="${receipt}"`);
    expect(completionForm).toContain(`name="run" value="${run}"`);
    expect(completionForm).toContain('Accept and finish</button>');
    expect(completionForm).toContain('Checks stay unchanged; nothing is published or deployed.');
    const historicalChat = await (await fetch(url(`/chat?task=t-complete&result=${historical}`), { headers: { cookie } })).text();
    expect(historicalChat).toContain(`data-result-run="${historical}"`);
    expect(historicalChat).not.toContain('Accept and finish</button>');
    expect(historicalChat).not.toContain('/t/t-complete/complete');
    const before = store.proofVerdictFor(run);
    const approvedBefore = store.getScope('t-complete');
    const runsBefore = store.runsFor(ref);
    const publicationBefore = store.publicationForRun(run);
    expect((await post(cookie, "/t/t-complete/complete", { run: String(run), receipt: receipt! })).status).toBe(403);
    expect((await post(cookie, "/t/t-complete/complete", { csrf, run: "999", receipt: receipt! })).status).toBe(409);
    expect((await post(cookie, "/t/t-complete/complete", { csrf, run: String(run), receipt: "0".repeat(64) })).status).toBe(409);
    const done = await post(cookie, "/t/t-complete/complete", { csrf, run: String(run), receipt: receipt! });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toContain(`run=${run}`);
    expect(store.proofVerdictFor(run)).toEqual(before);
    expect(store.getScope('t-complete')).toEqual(approvedBefore);
    expect(store.runsFor(ref)).toEqual(runsBefore);
    expect(store.publicationForRun(run)).toEqual(publicationBefore);
    expect(store.openReviewRequests()).toEqual([]);
    const after = await (await fetch(url(done.headers.get("location")!), { headers: { cookie } })).text();
    expect(after).toContain('>Complete</span>');
    expect(after).toContain('Marked complete by alex');
    expect(after).not.toContain('Accept and finish</button>');
    expect(await (await fetch(url(`/chat?task=t-complete&result=${run}`), { headers: { cookie } })).text()).not.toContain('Accept and finish</button>');
    expect(after).toContain('data-actual-checks="failed"');
    expect(after).toContain('Checks failed (exit 1).');
    expect(queueOf(after)).toContain('data-work-status="assignment-complete"');
    expect(queueOf(after)).not.toContain('conflicting evidence');
    expect(after).not.toContain('needs your attention');
    expect(mainOf(after).match(/<h1>/g)).toHaveLength(1);
    expect(after).not.toContain('<h1>Results</h1>');
    expect(after).not.toContain('data-current-outcome');
    expect(after).not.toContain('Check results are unchanged.');

    // Current decisions and Ready results rank ahead of this completed
    // result, even though its stored verdict remains refuted.
    const readyRef = seed('t-ready', 'Ready for the lead');
    const readyRun = build('t-ready', readyRef, { finishedAt: at(1) });
    store.stampRun(readyRun, { scopeDigest: store.getScope('t-ready')!.digest });
    const decisionRef = seed('t-decision', 'Needs the current scope');
    build('t-decision', decisionRef, { finishedAt: at(2) });
    const mixed = await (await fetch(url(`/review?result=t-complete&run=${run}`), { headers: { cookie } })).text();
    const queue = queueOf(mixed);
    expect(mixed).toContain('2 need your attention');
    expect(queue.indexOf('result=t-decision')).toBeLessThan(queue.indexOf('result=t-ready'));
    expect(queue.indexOf('result=t-ready')).toBeLessThan(queue.indexOf('result=t-complete'));
    expect(mixed).toContain('data-actual-checks="failed"');
    expect(store.proofVerdictFor(run)).toEqual(before);
  });

  // ---- workspace package 3 (2026-09-13): result-first review -------------
  const factsOf = (html: string) => resultFactsFromHtml(html);
  const PATCH = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n keep\n-old value\n+edited\n end\n";
  const RICH = {
    patch: PATCH,
    stat: [{ path: "src/a.ts", additions: 1, deletions: 1 }],
    handoff: { conclusion: "Edited the value.", changes: ["changed src/a.ts"], verification: ["ran the focused test"], followUps: [] },
    proof: { version: 1, criteria: [{ id: "c1", statement: "It works", verdict: "met", how: "ran it", evidence: [{ kind: "check", ref: "npm test" }, { kind: "screenshot", ref: "evidence/x.png" }] }], checks: [{ command: "npm test", exitCode: 0, summary: "12 passed" }], changed: ["src/a.ts"], caveats: ["Only the USD path was exercised."], screenshots: [{ path: "evidence/x.png", caption: "x after the change" }] },
    checkLog: "$ npm test\n12 passed\n",
    screenshot: { path: "evidence/x.png", caption: "x after the change" },
    verdict: { verdict: "verified" as const, reasons: ["the approved verification command passed"], matrix: [row("c1", "It works", "pass", [{ kind: "check", ref: "npm test" }, { kind: "screenshot", ref: "evidence/x.png" }])] },
  };

  test("package 3 c1: the task receipt, the chat receipt, the chat's result detail, the run page, and the cockpit stamp identical shared facts and lead with the deliverable", async () => {
    const ref = seed("t-shared", "one result, five surfaces", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const run = build("t-shared", ref, RICH);
    await boot();
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();
    const pages = { task: await read("/t/t-shared"), chat: await read("/chat?task=t-shared"), detail: await read(`/chat?task=t-shared&result=${run}`), run: await read(`/r/${run}?record=1`), review: await read("/review?result=t-shared") };
    // One result page: the build's own link opens the task's result page, keeping the tab; the run record stays one tap away under Details.
    const redirected = await fetch(url(`/r/${run}?tab=checks`), { headers: { cookie }, redirect: "manual" });
    expect(redirected.status).toBe(303);
    expect(redirected.headers.get("location")).toBe(`/review?result=t-shared&run=${run}&tab=checks`);
    const one = ((await (await fetch(url(`/review?result=t-shared&run=${run}&format=workspace`), { headers: { cookie } })).json()) as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    expect(one.selected!.title).toBe("one result, five surfaces");
    expect(one.selected!.record).toMatchObject({ build: run, href: `/r/${run}?record=1` });
    expect(one.results.every(row => !row.href.includes("project="))).toBe(true);
    const expected = { run: String(run), head: "b".repeat(12), base: "a".repeat(12), "head-source": "sealed diff", checks: "1/1", caveats: "1", evidence: "ok", publication: "none" };
    for (const [name, html] of Object.entries(pages)) {
      const stamped = factsOf(html);
      expect(stamped.length, name).toBeGreaterThan(0);
      for (const facts of stamped) expect(facts, name).toEqual(expected);
    }
    // The receipt's one primary road opens the shared detail; the detail
    // itself is the same panel on every surface, and the deliverable leads.
    expect(pages.chat).toContain(`href="/chat?task=t-shared&amp;result=${run}" data-open-result data-primary-action>Open result</a>`);
    expect(pages.task).toContain(`data-primary-action>Open result</a>`);
    for (const html of [pages.detail, pages.run, pages.review]) {
      expect(html).toContain('data-result-panel');
      expect(html).toContain('data-result-lead="screenshots"');
      expect(html).toMatch(/data-result-view="summary"[^>]*><div class="receipt-visuals result-visuals"/);
      expect(html).toContain('<nav class="result-tabs" role="tablist" aria-label="result views">');
      expect(html).toContain('data-result-attention="2"');
      expect(html).toContain("The original approved verification command is missing or changed.");
      expect(html).toContain("Only the USD path was exercised.");
      expect(html).toContain('<section class="result-request" id="request-changes">');
    }
    expect(pages.detail).toContain('data-result-place="chat"');
    expect(pages.run).toContain('data-result-place="run"');
    expect(pages.review).toContain('data-result-place="review"');
    // The caveat sits ahead of the tabs on every surface — before any readiness words below.
    for (const html of [pages.detail, pages.run, pages.review]) expect(html.indexOf('data-result-attention="2"')).toBeLessThan(html.indexOf('class="result-tabs"'));
    // The chat detail is the ONE auxiliary panel: the context aside steps aside, Back to chat leads.
    expect(pages.detail).toContain('<div class="chat-workspace task-chat-workspace result-open" data-chat-result-open>');
    expect(pages.detail).not.toContain('class="task-chat-context"');
    expect(pages.detail).toContain('<a href="/chat?task=t-shared" data-result-back>← Back to chat</a>');
    // The tab links are real URLs the server honours; the selected view is the only one shown.
    expect(pages.run).toContain(`<a role="tab" href="/r/${run}?tab=changes" data-result-tab="changes" aria-selected="false" tabindex="-1">Changes<span class="count">1 file</span></a>`);
    const changes = await read(`/r/${run}?tab=changes`);
    expect(changes).toContain('<div class="result-view" role="tabpanel" data-result-view="changes">');
    expect(changes).toContain('<div class="result-view" role="tabpanel" data-result-view="summary" hidden>');
    expect(changes).toContain('<div class="diff-review" data-review-diff>');
    expect(await read(`/r/${run}?tab=<script>`)).toContain('<div class="result-view" role="tabpanel" data-result-view="summary">');
  });

  test("request changes directly combines typed feedback with displayed notes, replays once, and rolls back refusals", async () => {
    const ref = seed("t-direct", "One clear action");
    const run = build("t-direct", ref, RICH);
    store.stampRun(run, { scopeDigest: store.getScope("t-direct")!.digest });
    await boot();
    const cookie = await login();
    const read = async () => (await fetch(url(`/chat?task=t-direct&result=${run}`), { headers: { cookie } })).text();
    const csrf = csrfOf(await read());
    const send = (fields: Record<string, string>) => post(cookie, `/r/${run}/comment`, { csrf, return: `/chat?task=t-direct&result=${run}`, ...fields });
    const initial = revisionFormOf(await read());
    const first = { intent: "revise", request: "a".repeat(32), note: "Make the action clearer.", ...initial };
    // A failed combined action saves neither the note nor a task.
    expect((await send({ ...first, source: "stale" })).status).toBe(409);
    expect(store.allDiffComments(run)).toHaveLength(0);
    expect(store.revisionsFromRun(run)).toHaveLength(0);
    expect((await send({ ...first, line: "0", path: "src/a.ts" })).status).toBe(400);
    expect((await send({ ...first, note: "" })).status).toBe(400);
    // Save for later is a note only, and the displayed list is exact.
    expect((await send({ intent: "note", note: "Keep the short label.", request: "b".repeat(32) })).status).toBe(303);
    expect(store.revisionsFromRun(run)).toHaveLength(0);
    const saved = store.liveDiffComments(run)[0]!;
    const shown = revisionFormOf(await read());
    expect((await send({ intent: "note", note: "Added in another tab.", request: "c".repeat(32) })).status).toBe(303);
    const combined = { ...first, ...shown, path: "src/a.ts", line: "2" };
    const result = await send(combined);
    expect(result.status, await result.text()).toBe(303);
    const child = revisionIdOf(result.headers.get("location"));
    expect(store.revisionLineageOf(child, T0)).toMatchObject({ sourceTask: "t-direct", sourceRun: run });
    expect(store.getScope(child)?.approvedAt).toBeNull();
    expect(store.allDiffComments(run).find(n => n.id === saved.id)?.consumedBy).toBe(child);
    expect(store.liveDiffComments(run).map(n => n.note)).toEqual(["Added in another tab."]);
    const replay = await send(combined);
    expect(replay.headers.get("location")).toBe(result.headers.get("location"));
    expect(store.allDiffComments(run)).toHaveLength(3);
    expect(store.revisionsFromRun(run)).toHaveLength(1);
    expect((await send({ ...combined, note: "Changed after submitting." })).status).toBe(409);
    // Reopening the old result can clear this exact acknowledged draft.
    const recorded = /data-recorded-requests value="([^"]*)"/.exec(await read())?.[1].split(",").sort();
    expect(recorded).toEqual(["a".repeat(32), "b".repeat(32), "c".repeat(32)]);
  });

  test("result simplicity: name missing verification once, keep details and compact feedback accessible", async () => {
    const ref = seed("t-simple-result", "A concise result");
    const run = build("t-simple-result", ref, { patch: PATCH, handoff: RICH.handoff });
    await boot();
    const cookie = await login();
    const html = await (await fetch(url(`/r/${run}?record=1`), { headers: { cookie } })).text();
    const win = new Window();
    try {
      win.document.body.innerHTML = html;
      const panel = win.document.querySelector('.result-panel')!;
      expect(panel.querySelector('.result-head .status-headline')?.textContent).toBe('Needs you');
      expect(panel.querySelector('.result-attention')?.textContent).toBe('No machine check is recorded.');
      expect(panel.querySelector('[data-result-view="checks"]')?.textContent).toContain('no verification result');
      const field = panel.querySelector('textarea[name="note"]')!;
      expect(field.getAttribute('aria-label')).toBe('review comment');
      expect(field.getAttribute('maxlength')).toBe('4000');
      expect(panel.querySelector('#comment-note-limit')?.textContent).toBe('up to 4000 characters');
      expect(panel.querySelector('[data-request-changes]')?.textContent).toBe('Request changes');
      expect(panel.querySelector('[data-save-feedback]')?.textContent).toBe('Save for later');
      expect(panel.querySelector('.result-pin')?.hasAttribute('open')).toBe(false);
      expect(panel.querySelector('.result-feedback-hint')).toBeNull();
    } finally { await win.happyDOM.close(); }
  });

  test("result simplicity: a failed caveat is explained once in the open without hiding another caveat", async () => {
    const caveat = "The dashboard screenshot used ledger fixtures, not production data.";
    const other = "Only the USD path was exercised.";
    const reason = `Caveat 1 names no criterion: ${caveat}`;
    const ref = seed("t-caveat", "Review the rounding evidence", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const run = build("t-caveat", ref, {
      ...RICH,
      proof: { ...RICH.proof, caveats: [caveat, other] },
      verdict: { ...RICH.verdict, verdict: "refuted", reasons: [reason] },
    });
    await boot();
    const cookie = await login();
    for (const path of [`/r/${run}?record=1`, `/chat?task=t-caveat&result=${run}`, "/review?result=t-caveat"]) {
      const html = await (await fetch(url(path), { headers: { cookie } })).text();
      const win = new Window();
      try {
        win.document.body.innerHTML = html;
        const attention = win.document.querySelector('.result-attention')!;
        expect([...attention.querySelectorAll('li')].map(one => one.textContent)).toEqual(["No machine check is recorded.", reason, other]);
        expect(attention.closest('details')).toBeNull();
        expect(html.indexOf('class="result-attention"')).toBeLessThan(html.indexOf('class="result-tabs"'));
        expect(win.document.querySelector('.cockpit-next')?.textContent ?? '').not.toContain(caveat);
        const originalCaveats = win.document.querySelector('details[data-cockpit-source="caveats"]');
        expect(originalCaveats?.hasAttribute('open')).toBe(false);
        expect(originalCaveats?.textContent).toContain(caveat);
        if (path.startsWith('/review')) {
          expect(win.document.querySelector('[data-result-tab=checks]')).not.toBeNull();
        }
      } finally { await win.happyDOM.close(); }
    }
    // It can't be accepted as it stands: the headline says the report doesn't match, Request changes is the one ink act, and Accept needs a reason, in outline.
    const view = ((await (await fetch(url(`/review?result=t-caveat&run=${run}&format=workspace`), { headers: { cookie } })).json()) as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    expect(view.selected!.acts).toEqual({ primary: "request-changes", secondary: "accept", line: "Accepting needs a reason" });
    expect(view.selected!.mismatch).toMatchObject({ headline: "The report doesn't match the changes", rows: [{ text: reason, path: null, href: null, absent: false }] });
    expect(view.selected!.mismatch!.said).toContain(reason);
    expect(view.selected!.panel!.status!.details.find(one => one.key === "requirements")).toMatchObject({ text: "Unverified", mark: "none" });
    expect(view.selected!.panel!.need).toMatchObject({ href: null, accept: { note: "Why is this safe to accept?" } });
  });

  test("a report that doesn't match its saved changes: the headline says so, each mismatch names its lines or that the file isn't in the changes, and requirements read Unverified", async () => {
    const ref = seed("t-mismatch", "Fix the payout rounding drift", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "changed-path"] }] });
    const cited = row("c1", "It works", "pass", [{ kind: "check", ref: "npm test" }, { kind: "changed-path", ref: "src/a.ts" }]);
    const run = build("t-mismatch", ref, {
      ...RICH,
      proof: { ...RICH.proof, changed: ["src/a.ts", "src/ledger.ts"] },
      verdict: { verdict: "refuted" as const, matrix: [cited], reasons: [
        "claimed changed path not in the sealed diff: src/ledger.ts",
        'criterion "c1" is marked met, but caveat 1 admits an exception to it: Only the USD path was exercised.',
      ] },
    });
    await boot();
    const cookie = await login();
    const view = ((await (await fetch(url(`/review?result=t-mismatch&run=${run}&format=workspace`), { headers: { cookie } })).json()) as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    const mismatch = view.selected!.mismatch!;
    expect(mismatch.headline).toBe("The report doesn't match the changes");
    expect(mismatch.rows).toEqual([
      { text: "The report says it changed", path: "src/ledger.ts", lines: null, href: null, absent: true, noteLabel: null },
      { text: "The report marks “It works” met, but its own note says: Only the USD path was exercised.", path: "src/a.ts", lines: "line 2", absent: false, noteLabel: null,
        href: `/review?result=t-mismatch&run=${run}&tab=changes#${diffFileAnchor("src/a.ts")}-L1` },
    ]);
    expect(view.selected!.panel!.status!.details.find(one => one.key === "requirements")).toMatchObject({ text: "Unverified", mark: "none" });
    expect(view.selected!.acts.line).toBe("Accepting needs a reason");
    // The link lands: the Changes tab's change starts at that anchor.
    const changes = await (await fetch(url(`/review?result=t-mismatch&run=${run}&tab=changes`), { headers: { cookie } })).text();
    expect(changes).toContain(`<section class="diff-hunk" id="${diffFileAnchor("src/a.ts")}-L1">`);
  });

  test("every refuted result lists what went wrong in its card: a failed check keeps its own headline, and a requirement whose evidence doesn't hold is named", async () => {
    const ref = seed("t-refuted-check", "Fix the payout rounding drift", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "changed-path"] }, { id: "c2", statement: "The dashboard renders", evidence: ["screenshot"] }] });
    const shot = 'criterion "c2"\'s screenshot evidence "evidence/dash.png" could not be verified: not a PNG';
    const run = build("t-refuted-check", ref, {
      ...RICH,
      verdict: { verdict: "refuted" as const, matrix: [row("c1", "It works", "pass", [{ kind: "changed-path", ref: "src/a.ts" }]), row("c2", "The dashboard renders", "failed", [{ kind: "screenshot", ref: "evidence/dash.png" }], [shot])],
        reasons: ["the repository's approved verification command exited 1"] },
    });
    await boot();
    const cookie = await login();
    const view = ((await (await fetch(url(`/review?result=t-refuted-check&run=${run}&format=workspace`), { headers: { cookie } })).json()) as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    const mismatch = view.selected!.mismatch!;
    expect(mismatch.headline).toBeNull();
    expect(mismatch.rows).toEqual([{ text: "“The dashboard renders”: screenshot evidence \"evidence/dash.png\" could not be verified: not a PNG", path: null, lines: null, href: null, absent: false, noteLabel: null }]);
    expect(mismatch.said).toContain(shot);
  });

  test("package 3 c2: a tampered screenshot, a shortened check log, a failed change-summary capture, and an unverifiable report are named in the open, never rendered, never called validated; an investigation's report is escaped text", async () => {
    const ref = seed("t-damaged", "evidence damaged after sealing", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const run = build("t-damaged", ref, { ...RICH, checkLog: "x".repeat(170 * 1024), stat: undefined });
    storeEvidence(store, evidenceRoot, run, "diff-stat", "diff-stat.json", Buffer.from("{}"), "git diff --numstat (exit 128)", T0, { captureStatus: "failed" });
    const shot = store.artifactsFor(run).find(one => one.kind === "screenshot");
    if (shot === undefined) throw new Error("no screenshot");
    writeFileSync(join(evidenceRoot, shot.key), Buffer.from("not the image any more"));
    // An investigation: a scout run whose deliverable is a report.
    const scoutRef = seed("t-scout", "investigate the drift", "/repo/main", { acceptance: [{ id: "c1", statement: "A report names the drift", evidence: ["manual-review"] }] });
    const scoutRun = store.startRun({ taskRef: scoutRef, leaseId: "lease-scout", runner: "night-shift-1", provider: "claude", role: "scout", branch: "standing-orders/t-scout", worktree: "/pool/t-scout", now: T0, ...presented(store, scoutRef, "builder") });
    const report = { title: "Where the drift lives", summary: "Two rounding sites disagree. The footer sums unrounded rows while the ledger rounds each line.", report: "# Drift\n\n<script>alert(1)</script> is text here.", followUps: [{ title: "Round the footer", goal: "Sum rounded rows." }],
      items: [{ title: "The footer <b>sums</b> raw rows", why: "Totals drift by a cent.", url: "https://shop.example.com/cart", image: "footer.png" }],
      // Its screenshot's evidence is gone: named, never a broken picture.
      images: [{ file: "footer.png", caption: "The cart footer", url: "https://shop.example.com/cart", sha256: "0".repeat(64), artifact: 999_999 }] };
    storeEvidence(store, evidenceRoot, scoutRun, "report", "report.json", Buffer.from(JSON.stringify(report), "utf8"), "scout report (validated)", T0);
    // Native report runs settle as built/report-delivered without a builder handoff.
    store.finishRun(scoutRun, { outcome: "built", reason: "report-delivered", committed: false, now: T0 });
    store.setTaskState("t-scout", "done", T0);
    // A second scout whose report was altered after sealing.
    const brokenRef = seed("t-scout-broken", "a report that no longer verifies", "/repo/main", null);
    const brokenRun = store.startRun({ taskRef: brokenRef, leaseId: "lease-scout-2", runner: "night-shift-1", provider: "claude", role: "scout", branch: "standing-orders/t-scout-broken", worktree: "/pool/t-scout-broken", now: T0, ...presented(store, brokenRef, "builder") });
    storeEvidence(store, evidenceRoot, brokenRun, "report", "report.json", Buffer.from(JSON.stringify(report), "utf8"), "scout report (validated)", T0);
    const reportArtifact = store.artifactsFor(brokenRun).find(one => one.kind === "report");
    if (reportArtifact === undefined) throw new Error("no report");
    writeFileSync(join(evidenceRoot, reportArtifact.key), "{}");
    store.finishRun(brokenRun, { outcome: "no-change", committed: false, now: T0 });
    store.setTaskState("t-scout-broken", "done", T0);
    await boot();
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();

    for (const html of [await read(`/r/${run}`), await read("/review?result=t-damaged"), await read(`/chat?task=t-damaged&result=${run}`)]) {
      const facts = factsOf(html);
      expect(facts.length).toBeGreaterThan(0);
      for (const one of facts) expect(one.evidence).toBe("problems:3");
      const attention = /<div class="result-attention" data-result-attention="([0-9]+)">([\s\S]*?)<\/div>/.exec(html);
      expect(attention).not.toBeNull();
      expect(attention?.[2]).toContain("Screenshot evidence/x.png no longer verifies (the file&#39;s size no longer matches its record) and is not shown.");
      expect(attention?.[2]).toContain("The change summary is unavailable: capture failed");
      expect(attention?.[2]).toContain("The check output was shortened when it was stored; its download holds only the stored part.");
      expect(attention?.[2]).toContain("Only the USD path was exercised.");
      // Nothing renders the tampered bytes or calls them validated.
      expect(html).not.toContain(`<img src="/r/${run}/evidence/${shot.id}"`);
      expect(html).not.toContain("validated visual proof");
      expect(html).toContain("0 validated screenshots, 1 unavailable");
      expect(html).toContain('data-result-lead="changes"');
      expect(html).toMatch(/Check output \(shortened — [0-9]+ of [0-9]+ bytes stored\)/);
      expect(html).toContain('<p class="problem">Change summary unavailable: capture failed');
    }
    // The receipt counts it honestly too, on the task page and in chat.
    for (const html of [await read("/t/t-damaged"), await read("/chat?task=t-damaged")]) {
      expect(html).toContain("<strong>1 screenshot</strong><small>1 unavailable — not validated</small>");
      expect(html).not.toContain(`<img src="/r/${run}/evidence/${shot.id}"`);
      expect(factsOf(html)[0]?.evidence).toBe("problems:3");
    }
    // The evidence road refuses the bytes.
    expect((await fetch(url(`/r/${run}/evidence/${shot.id}`), { headers: { cookie } })).status).toBe(410);

    // The investigation leads with its escaped report and a text download; it owes no diff.
    const scout = await read(`/r/${scoutRun}`);
    const scoutResult = await read(`/chat?task=t-scout&result=${scoutRun}`);
    for (const html of [await read("/t/t-scout"), await read("/chat?task=t-scout")]) expect(html).toContain("Report saved");
    // The result panel leads with the shared headline instead (task-status.ts).
    for (const html of [scout, scoutResult]) expect(html).toMatch(/<h2 class="status-headline"[^>]*><i aria-hidden="true"><\/i>(?:Ready for review|Needs you)<\/h2>/);
    for (const html of [scout, await read("/t/t-scout"), await read("/chat?task=t-scout"), scoutResult]) {
      expect(html).toContain("Two rounding sites disagree.");
      expect(html).not.toContain("The build finished without a concise handoff.");
    }
    expect(scout).toContain('data-result-lead="report"');
    expect(scout).toContain('<article class="result-report" data-result-report="ok"><h3>Where the drift lives</h3><div class="report-items" data-report-items="1">');
    expect(scout).toContain("The footer &lt;b&gt;sums&lt;/b&gt; raw rows");
    expect(scout).toContain('href="https://shop.example.com/cart" rel="noopener noreferrer nofollow"');
    expect(scout).toContain("Screenshot unavailable: the saved screenshot is missing");
    // The outcome line is the summary's first sentence; the full summary is said once, behind the agent's disclosure.
    expect(scout).toContain('<details class="result-notes" data-result-notes-agent><summary>What the agent reported</summary><p class="recap">Two rounding sites disagree. The footer sums unrounded rows while the ledger rounds each line.</p></details>');
    expect(renderedHtmlOf(scout).split("The footer sums unrounded rows while the ledger rounds each line.").length - 1).toBe(1);
    expect(workspaceOf(scout).pageHtml!.split("The footer sums unrounded rows while the ledger rounds each line.").length - 1).toBe(1);
    expect(scout).toContain("&lt;script&gt;alert(1)&lt;/script&gt; is text here.");
    expect(scout).not.toContain("<script>alert(1)</script>");
    expect(scout).toContain(`/evidence/${store.artifactsFor(scoutRun).find(one => one.kind === "report")?.id}">Download the report</a>`);
    expect(scout).toContain("1 proposed follow-up on <a href=\"/t/t-scout\">the task</a>");
    expect(scout).toContain("an investigation changes nothing in the repository");
    expect(scout).not.toContain("no-change conclusion is not verified");
    expect(factsOf(scout)[0]).toMatchObject({ evidence: "ok", checks: "none" });
    const downloaded = await fetch(url(`/r/${scoutRun}/evidence/${store.artifactsFor(scoutRun).find(one => one.kind === "report")?.id}`), { headers: { cookie } });
    expect(downloaded.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(downloaded.headers.get("content-disposition")).toMatch(/^attachment/);
    // The altered report is a named problem, not a rendered document.
    const broken = await read(`/r/${brokenRun}`);
    expect(broken).toContain('<p class="problem" data-result-report="problem">The report cannot be shown: ');
    expect(broken).not.toContain('data-result-report="ok"');
    expect(factsOf(broken)[0]?.evidence).toBe("problems:1");
    expect(broken).toContain("The report cannot be shown:");
  });

  test("same task: review retains broken and hidden lineage with a warning and exact result targets", async () => {
    const source = seed("secret-source", "Hidden source", "/hidden");
    const sourceRun = build("secret-source", source, RICH);
    const sourceBrief = store.saveArtifact({ run: sourceRun, kind: "revision-brief", key: "synthetic.json", bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "a".repeat(64), capture: "synthetic lineage fixture" }, T0);
    for (const id of ["broken-result", "cross-result", "no-build-history"]) {
      const ref = seed(id, `Visible ${id}`);
      if (id === "no-build-history") store.setTaskState(id, "done", T0);
      else build(id, ref, RICH);
      store.markRevision(ref, id === "cross-result" ? "secret-source" : "missing-source", sourceBrief);
    }
    await boot();
    const cookie = await login();
    for (const id of ["broken-result", "cross-result", "no-build-history"]) {
      const html = await (await fetch(url(`/review?result=${id}`), { headers: { cookie } })).text();
      const selectedRun = store.runsFor(store.lookupRef(id)!.id)[0]?.id;
      expect(html).toContain(`class="cockpit-row current" href="/review?result=${id}${selectedRun === undefined ? "" : `&amp;run=${selectedRun}`}"`);
      expect(html).toContain(`data-review-task="${id}"`);
      expect(html).toContain("History unavailable");
      expect(html).toContain("This task is shown separately.");
      expect(html).not.toContain("secret-source");
      expect(html).not.toContain("Hidden source");
      expect(html).not.toContain("missing-source");
      if (id !== "no-build-history") {
        const run = store.runsFor(store.lookupRef(id)!.id)[0]!;
        expect(html).toContain(`action="/r/${run.id}/comment"`);
      }
    }
    const hidden = await (await fetch(url("/review?result=secret-source"), { headers: { cookie } })).text();
    expect(hidden).not.toContain('data-review-task="secret-source"');
  });

  test("same task: two revisions keep root navigation, exact history, safe feedback batches and stale actions", async () => {
    const root = "same-root";
    const ref = seed(root, "One task", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const first = build(root, ref, RICH);
    store.stampRun(first, { scopeDigest: store.getScope(root)!.digest });
    const unrelated = seed("other-version", "Unrelated result");
    const otherRun = build("other-version", unrelated, RICH);
    await boot();
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();
    const csrf = csrfOf(await read(`/r/${first}`));
    const before = store.artifactsFor(first);
    // Informational notes remain visible, and do not generate default work.
    const asked = store.requestReview(first, "alex", T0);
    if (!asked.ok) throw new Error(asked.reason);
    const reviewer = store.startRun({ taskRef: ref, leaseId: "review-fixture", runner: "night-shift-1", role: "reviewer", parentRun: first, request: asked.id, now: T0, ...presented(store, ref, "reviewer") });
    store.stampProviderStart(reviewer, T0);
    const patch = before.find(one => one.kind === "terminal-diff")!;
    store.addReviewerComments({ reviewerRunId: reviewer, runId: first, artifactId: patch.id, author: "reviewer:claude", comments: [
      { path: "src/a.ts", line: 2, note: "Good guard.", severity: "note" },
      { path: "src/a.ts", line: 2, note: "Should this name change?", severity: "question" },
    ] }, T0);
    const informational = await read(`/chat?task=${root}&result=${first}`);
    expect(informational).toContain("Good guard.");
    expect(informational).toContain("Should this name change?");
    expect(informational).toContain('data-review-note="Should this name change?"');
    expect(informational).not.toContain(`action="/r/${first}/revise"`);
    const infoIds = store.liveDiffComments(first).map(one => one.id);
    store.addReviewerComments({ reviewerRunId: reviewer, runId: first, artifactId: patch.id, author: "reviewer:claude", comments: [{ path: "src/a.ts", line: 2, note: "Fix the missing guard.", severity: "problem" }] }, T0);
    const problemId = store.liveDiffComments(first).at(-1)!.id;
    store.finishRun(reviewer, { outcome: "no-change", reason: "reviewed", now: T0 });
    const made: string[] = [];
    let source = root, run = first;
    for (let revision = 1; revision <= 2; revision++) {
      const note = await post(cookie, `/r/${run}/comment`, { csrf, note: `Please change version ${revision}.`, request: String(revision).repeat(32) });
      expect(note.status).toBe(303);
      const body = { csrf, return: `/chat?task=${root}&result=${run}`, ...revisionFormOf(await read(`/chat?task=${root}&result=${run}`)) };
      expect(body.batch.split(",").map(Number).some(id => infoIds.includes(id))).toBe(false);
      if (revision === 1) expect(body.batch.split(",").map(Number)).toContain(problemId);
      const invalidInfo = revision === 1 ? await post(cookie, `/r/${run}/revise`, { ...body, batch: infoIds.join(",") }) : null;
      if (invalidInfo !== null) expect(invalidInfo.status).toBe(409);
      const sealed = await post(cookie, `/r/${run}/revise`, body);
      expect(sealed.status).toBe(303);
      const child = revisionIdOf(sealed.headers.get("location")); made.push(child);
      expect(sealed.headers.get("location")).toBe(`/chat?task=${root}&revision=${child}`);
      expect(store.revisionLineageOf(child, T0)).toMatchObject({ root, sourceTask: source, sourceRun: run });
      expect((await post(cookie, `/r/${run}/revise`, body)).headers.get("location")).toBe(sealed.headers.get("location"));
      plannerKeptTerms(store, child);
      const chat = await read(`/chat?task=${root}`);
      expect(chat).toContain(`data-task="${root}" data-execution="${child}"`);
      expect(chat).toContain(`data-execution="${child}"`);
      expect(chat).toContain(`<h1>One task</h1>`);
      expect(chat).toContain(`action="/t/${child}/approve"`);
      const work = await read("/work");
      expect(work.match(new RegExp(`class="work-row" data-task="${root}"`, "g"))).toHaveLength(1);
      expect(work).not.toContain(`class="work-row" data-task="${child}"`);
      expect(await read("/tasks")).not.toContain(`href="/t/${child}"`);
      const form = new RegExp(`<form method="post" action="/t/${child}/approve"[\\s\\S]*?</form>`).exec(chat)![0];
      const digest = /name="digest" value="([^"]+)"/.exec(form)![1]!;
      const nonce = /name="nonce" value="([^"]+)"/.exec(form)![1]!;
      // A nonce for the current execution cannot be submitted to an older one.
      await post(cookie, `/t/${source}/approve`, { csrf, nonce, digest, token: approverToken });
      expect(approvalOf(store.getScope(child)).approved).toBe(false);
      const freshNonce = /name="nonce" value="([^"]+)"/.exec(await read(`/chat?task=${root}`))![1]!;
      expect((await post(cookie, `/t/${child}/approve`, { csrf, nonce: freshNonce, digest, token: approverToken })).status).toBe(303);
      expect(approvalOf(store.getScope(child)).approved).toBe(true);
      run = build(child, store.lookupRef(child)!.id, { ...RICH, handoff: { ...RICH.handoff, conclusion: `Version ${revision}` } });
      store.stampRun(run, { scopeDigest: store.getScope(child)!.digest });
      source = child;
    }
    const earlier = await read(`/chat?task=${root}&result=${first}`);
    expect(earlier).toContain("data-past-feedback");
    expect(earlier).toContain("Please change version 1.");
    expect(earlier).toContain(`href="/review?result=${root}"`);
    const history = await read(`/chat?task=${root}`);
    for (const id of [root, ...made]) expect(history).toContain(`data-history-version="${id}"`);
    expect(history).toContain("Revision 2");
    const oldReceipt = await fetch(url(`/chat?task=${root}&revision=${made[0]}`), { headers: { cookie }, redirect: "manual" });
    expect(oldReceipt.headers.get("location")).toBe(`/t/${root}?version=${made[0]}`);
    const oldTask = await fetch(url(`/t/${made[0]}`), { headers: { cookie }, redirect: "manual" });
    expect(oldTask.headers.get("location")).toBe(`/t/${root}?version=${made[0]}`);
    // Chat's Edit plan names the version's own address; the editor is still asked for after the redirect.
    const editing = await fetch(url(`/t/${made[0]}?edit=plan`), { headers: { cookie }, redirect: "manual" });
    expect(editing.headers.get("location")).toBe(`/t/${root}?version=${made[0]}&edit=plan`);
    expect(await read(`/t/${root}?version=${root}`)).toContain("Viewing Original");
    expect((await fetch(url(`/t/${root}?version=other-version`), { headers: { cookie } })).status).toBe(404);
    expect(factsOf(await read(`/chat?task=${root}&result=${otherRun}`)).some(one => one.run === String(otherRun))).toBe(false);
    expect(await read(`/chat?task=${made[0]}&result=${first}`)).toContain(`data-result-run="${first}"`);
    expect((await post(cookie, `/t/${made[0]}/stop`, { csrf, run: String(run) })).status).toBe(409);
    expect(store.getTask(made[1]!)!.state).toBe("done");
    expect(store.artifactsFor(first).filter(one => one.kind !== "revision-brief")).toEqual(before);
    expect(store.allDiffComments(first).filter(one => infoIds.includes(one.id)).every(one => one.consumedBy === null)).toBe(true);
    // Even a source whose project is admitted elsewhere may not join this root.
    seed("secret-lineage", "Secret title", "/hidden");
    store.raw().prepare("UPDATE task_ref SET revision_of = 'secret-lineage' WHERE external_id = ?").run(made[1]!);
    const damaged = await read(`/t/${made[1]}`);
    expect(damaged).toContain("data-history-problem");
    expect(damaged).not.toContain("Secret title");
    expect(damaged).not.toContain("secret-lineage");
  });

  test("chat review: messages save shared feedback and create one same-task revision through the normal approval door", async () => {
    const { verifyApproverStanding } = await import("./principal.js");
    const { subscriptionCredentialKey } = await import("./converse.js");
    const root = "chat-review-root";
    const repo = (await import("node:fs")).realpathSync(evidenceRoot);
    const ref = seed(root, "Simplify navigation", repo);
    const run = build(root, ref, RICH);
    store.stampRun(run, { scopeDigest: store.getScope(root)!.digest });
    const now = new Date();
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [repo]);
    if (!verified.ok) throw new Error(verified.reason);
    store.setChatConfig({ provider: "claude-subscription", model: "opus", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", now);
    const session = store.mintMateSession({ approver: "alex", approverGeneration: verified.who.generation, credentialKey: subscriptionCredentialKey("claude-subscription"), ceilingMicrousd: 0, ceilingDigest: verified.who.ceilingDigest, termsDigest: "fixture" }, now);
    // Messages about a task speak in that task's own thread (v77).
    const thread = store.openMateThread("alex", verified.who.ceilingDigest, now, { kind: "task", key: root }).thread;
    const answers: MateProviderAnswer[] = [];
    const contexts: string[] = [];
    const tool = (name: string, args: Record<string, unknown>): MateProviderAnswer => ({ text: "", calls: [{ id: name, name, args }], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null });
    const done = (): MateProviderAnswer => ({ text: "Review the card to confirm.", calls: [], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null });
    await boot({ repo, subscriptionChatRunner: async (request: import("./subscription-chat.js").SubscriptionMateRequest) => {
      contexts.push(request.history.filter(one => one.role === "operator").map(one => one.text).join("\n"));
      const answer = answers.shift(); if (!answer) throw new Error("No scripted answer");
      return { ok: true, answer };
    } });
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();
    const csrf = csrfOf(await read("/chat"));
    const send = async (message: string) => {
      const response = await post(cookie, "/chat", { csrf, task: root, result: String(run), message });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).not.toContain("said=");
      for (let i = 0; i < 100 && store.liveMateTurnFor("alex") !== null; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(store.liveMateTurnFor("alex")).toBeNull();
      const proposal = store.listMateProposals(thread.id, ["pending"]).at(-1)!;
      expect(proposal?.kind, JSON.stringify(store.listMateMessages(thread.id, 10))).toBe("review");
      return proposal;
    };
    answers.push(tool("get_result", { task: root, run }), tool("propose_review", { run, operation: "note", note: "Use shorter labels." }), done());
    const saved = await send("Save this feedback: use shorter labels.");
    expect(contexts.some(one => one.includes(`viewing result #${run} from execution ${root}`))).toBe(true);
    expect(store.liveDiffComments(run)).toHaveLength(0);
    // The card arrives as data too (chat cards): its label, one act, a dismiss.
    const read2 = await (await fetch(url(`/t/${root}?format=workspace`), { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    const cards = read2.conversation!.messages.flatMap(one => one.cards ?? []);
    expect(cards.find(one => one.id === saved.id)).toMatchObject({ kind: "review", label: "Note for later", state: "pending", primary: { kind: "confirm", label: "Save for later", irreversible: false, native: false }, dismissable: true, said: null });
    // Confirmed in place: the same door, answered in JSON; the page stays.
    const inPlace = await fetch(url(`/chat/proposal/${saved.id}/confirm`), { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams({ csrf }), redirect: "manual" });
    expect(inPlace.status).toBe(200);
    expect(await inPlace.json()).toMatchObject({ ok: true, said: expect.any(String) });
    const again = await fetch(url(`/chat/proposal/${saved.id}/confirm`), { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams({ csrf }), redirect: "manual" });
    expect(await again.json()).toMatchObject({ ok: false });
    const late = await fetch(url(`/chat/proposal/${saved.id}/dismiss`), { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams({ csrf }), redirect: "manual" });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ ok: false, said: "That card was already acted on.", taskId: null });
    const after = (await (await fetch(url(`/t/${root}?format=workspace`), { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace)
      .conversation!.messages.flatMap(one => one.cards ?? []).find(one => one.id === saved.id);
    expect(after).toMatchObject({ state: "confirmed", primary: null, dismissable: false, links: [{ label: "Open the task" }] });
    const note = store.liveDiffComments(run)[0]!;
    expect(note).toMatchObject({ note: "Use shorter labels.", author: "alex" });
    for (const page of [`/chat?task=${root}&result=${run}`, `/r/${run}`, `/review?result=${root}`]) expect(await read(page)).toContain("Use shorter labels.");
    expect(store.taskFamilyOf(root, [repo], false)?.versions).toHaveLength(1);
    answers.push(tool("get_result", { task: root, run }), tool("propose_review", { run, operation: "revise", saved_notes: [note.id], note: "Keep the primary action on one line.", path: "src/a.ts", line: 2 }), done());
    const revise = await send("Apply that feedback and keep the primary action on one line.");
    const card = await read(`/chat?task=${root}`);
    expect(card).toContain('data-card-kind="review"');
    expect(card).toContain("Use shorter labels.");
    expect(card).toContain("Keep the primary action on one line.");
    expect(card).toContain(">Request changes</button>");
    // Another tab adds feedback after the card was shown; it must remain unconsumed.
    await post(cookie, `/r/${run}/comment`, { csrf, note: "A later note, not in this revision." });
    const confirmed = await post(cookie, `/chat/proposal/${revise.id}/confirm`, { csrf });
    const child = revisionIdOf(confirmed.headers.get("location"));
    expect(confirmed.headers.get("location")).toBe(`/chat?task=${root}&revision=${child}#latest`);
    expect(store.revisionLineageOf(child, now)).toMatchObject({ root, sourceTask: root, sourceRun: run });
    expect(store.liveDiffComments(run).map(one => one.note)).toEqual(["A later note, not in this revision."]);
    expect(approvalOf(store.getScope(child)).approved).toBe(false);
    expect(await read(`/chat?task=${root}`)).not.toContain(`action="/t/${child}/approve"`);
    plannerKeptTerms(store, child);
    expect(await read(`/chat?task=${root}`)).toContain(`action="/t/${child}/approve"`);
    expect(await read("/work")).toContain(`data-task="${root}"`);
    await post(cookie, `/chat/proposal/${revise.id}/confirm`, { csrf });
    expect(store.taskFamilyOf(root, [repo], false)?.versions).toHaveLength(2);
    expect(store.allDiffComments(run)).toHaveLength(3);
    expect(store.getMateSession(session)?.spentMicrousd).toBe(0);
  });

  test("chat review refuses unread, stale, inaccessible and damaged results without saving partial feedback", async () => {
    const { verifyApproverStanding } = await import("./principal.js");
    const { executeMateTool } = await import("./mate-tools.js");
    const { readChatResult, applyChatReview } = await import("./chat-review.js");
    const ref = seed("review-guard", "Guard feedback");
    const run = build("review-guard", ref, RICH);
    store.stampRun(run, { scopeDigest: store.getScope("review-guard")!.digest });
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, ["/repo/main"]);
    if (!verified.ok) throw new Error(verified.reason);
    const who = verified.who;
    const ctx = { store, who, now: T0, evidenceRoot, step: 1, readDecisions: new Map(), readResults: new Map(), draft: () => 1 };
    expect(executeMateTool(ctx, "propose_review", { run, operation: "revise", note: "Fix it." })).toMatchObject({ ok: false });
    const read = readChatResult(store, who, evidenceRoot, "review-guard", run);
    if (!read.ok) throw new Error(read.message);
    const request = { snapshot: read.snapshot, operation: "revise" as const, note: "Fix this.", path: null, line: null, notes: [] };
    const other = seed("review-other", "Private", "/repo/other");
    const otherRun = build("review-other", other, RICH);
    expect(readChatResult(store, who, evidenceRoot, "review-other", otherRun)).toMatchObject({ ok: false });
    expect(readChatResult(store, who, evidenceRoot, "review-guard", otherRun)).toMatchObject({ ok: false });
    // An invalid inherited source binding fails after the new note was tentatively saved.
    store.raw().prepare("UPDATE run SET scope_digest = ? WHERE id = ?").run("f".repeat(64), run);
    expect(applyChatReview(store, who, evidenceRoot, request, T0, false)).toMatchObject({ ok: false });
    expect(store.allDiffComments(run)).toHaveLength(0);
    store.raw().prepare("UPDATE run SET scope_digest = ? WHERE id = ?").run(store.getScope("review-guard")!.digest, run);
    // New scope: old card stays attached to the old terms and refuses.
    propose(store, { taskId: "review-guard", goal: "Different terms", touches: [], now: T0 });
    expect(applyChatReview(store, who, evidenceRoot, request, T0, false)).toMatchObject({ ok: false, message: expect.stringContaining("changed") });
    expect(store.allDiffComments(run)).toHaveLength(0);
    const artifact = store.artifactsFor(run).find(one => one.kind === "terminal-diff")!;
    writeFileSync(join(evidenceRoot, artifact.key), "changed after capture");
    expect(readChatResult(store, who, evidenceRoot, "review-guard", run)).toMatchObject({ ok: false });
  });

  test.each([
    ["ASCII limit", "A".repeat(200), "A".repeat(189) + " — revision"],
    ["astral limit", "😀".repeat(100), "😀".repeat(94) + " — revision"],
    ["combining limit", "e\u0301".repeat(100), "e\u0301".repeat(94) + " — revision"],
    ["repeated suffix", "Mobile project switcher — revision — revision", "Mobile project switcher — revision"],
    ["blank title", "  ", "Task — revision"],
    ["unavailable parent", null, "Task — revision"],
  ])("revision names: %s stays canonical through revisions of a revision", async (_label, title, expected) => {
    let parent = "t-names";
    let ref = seed(parent, title ?? "Unavailable title");
    await boot();
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();
    for (let generation = 0; generation < 3; generation++) {
      const original = store.getScope(parent)!;
      const run = build(parent, ref, RICH);
      store.stampRun(run, { scopeDigest: original.digest });
      const csrf = csrfOf(await read(`/r/${run}`));
      expect((await post(cookie, `/r/${run}/comment`, { csrf, note: "Keep 日本語 😀 e\u0301 exact." })).status).toBe(303);
      const seal = revisionFormOf(await read(`/r/${run}`));
      // Simulate an unavailable human-title lookup, not a missing source or lineage.
      const getTask = store.getTask.bind(store);
      const unavailable = title === null && generation === 0
        ? vi.spyOn(store, "getTask").mockImplementation(id => id === parent ? null : getTask(id)) : null;
      let response: Response;
      try { response = await post(cookie, `/r/${run}/revise`, { csrf, ...seal }); }
      finally { unavailable?.mockRestore(); }
      expect(response.status).toBe(303);
      const child = revisionIdOf(response.headers.get("location"));
      const name = store.getTask(child)!.title;
      expect(name).toBe(expected);
      expect(validateTaskText({ title: name })).toBeNull();
      expect(name.length).toBeLessThanOrEqual(TASK_TEXT_LIMITS.title);
      expect(Buffer.from(name).toString("utf8")).toBe(name);
      expect((name.match(/ — revision/g) ?? []).length).toBe(1);
      expect(store.revisionLineageOf(child, T0)).toMatchObject({ sourceTask: parent, sourceRun: run, root: "t-names" });
      expect(store.getScope(child)?.approvedAt).toBeNull();
      expect(store.getScope(parent)).toEqual(original);
      expect((await post(cookie, `/r/${run}/revise`, { csrf, ...seal })).headers.get("location")).toBe(response.headers.get("location"));
      expect(store.revisionsFromRun(run)).toHaveLength(1);
      expect(approve(store, child, "alex", T0, store.getScope(child)!.digest, approverToken).ok).toBe(true);
      parent = child;
      ref = store.lookupRef(child)!.id;
    }
  });

  test("package 3 c3: a plain note and a line annotation are one batch and one sealed revision; a replayed note and a replayed seal mint nothing; the links run both ways; approval is untouched", async () => {
    const ref = seed("t-loop", "one revision loop", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const run = build("t-loop", ref, RICH);
    // The run built against the signed scope — the seal re-proves this binding.
    store.stampRun(run, { scopeDigest: store.getScope("t-loop")!.digest });
    await boot();
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();
    const detail = await read(`/chat?task=t-loop&result=${run}`);
    const csrf = csrfOf(detail);
    const request = /name="request" value="([a-f0-9]{32})"/.exec(detail.slice(detail.indexOf('id="comment-form"')))?.[1] ?? "";
    expect(request).toMatch(/^[a-f0-9]{32}$/);
    expect(detail).toContain(`<input type="hidden" name="return" value="/chat?task=t-loop&amp;result=${run}">`);
    // A plain note, from the chat's result view: back to that view, receipt named.
    const feedbackNote = "On the phone, keep the payout total and the cent-precision explanation together so readers can check the result without horizontal scrolling. Add a regression covering a half-cent boundary and several small settlements in the same batch. Show the expected ledger total beside the calculated amount, and keep the rounding note concise. Please also attach the dashboard evidence to its exact acceptance criterion so reviewers can distinguish fixture coverage from production behavior.";
    const noted = await post(cookie, `/r/${run}/comment`, { csrf, note: feedbackNote, request, return: `/chat?task=t-loop&result=${run}` });
    expect(noted.status).toBe(303);
    expect(noted.headers.get("location")).toBe(`/chat?task=t-loop&result=${run}&noted=${request}#request-changes`);
    // The same submission again (a double click, a replayed POST): the same receipt, no second note.
    const replayed = await post(cookie, `/r/${run}/comment`, { csrf, note: feedbackNote, request, return: `/chat?task=t-loop&result=${run}` });
    expect(replayed.status).toBe(303);
    expect(replayed.headers.get("location")).toBe(noted.headers.get("location"));
    expect(store.liveDiffComments(run)).toHaveLength(1);
    // Another account's replay of the same token is not this account's note.
    const other = addApprover(store, "sam", T0, { name: "alex", token: approverToken });
    if (!other.ok) throw new Error("sam");
    const samLogin = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name: "sam", token: other.token }), redirect: "manual" });
    const samCookie = (samLogin.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const samCsrf = csrfOf(await (await fetch(url(`/r/${run}`), { headers: { cookie: samCookie } })).text());
    expect((await post(samCookie, `/r/${run}/comment`, { csrf: samCsrf, note: "Sam agrees.", request })).status).toBe(303);
    expect(store.liveDiffComments(run).map(one => one.author)).toEqual(["alex", "sam"]);
    // A pinned annotation through the same form.
    const pinned = await post(cookie, `/r/${run}/comment`, { csrf, path: "src/a.ts", line: "2", note: "Name the helper." });
    expect(pinned.status).toBe(303);
    expect(pinned.headers.get("location")).toBe(`/r/${run}?noted=1#request-changes`);
    const batch = store.liveDiffComments(run);
    expect(batch.map(one => [one.path, one.line])).toEqual([[null, null], [null, null], ["src/a.ts", 2]]);
    // The panel shows the batch beside the result with ONE seal, and the focused note box after a receipt.
    const ready = await read(`/chat?task=t-loop&result=${run}&noted=${request}`);
    expect(ready).toContain('<div class="diff-comments" data-result-notes="3">');
    expect(ready).toContain("Saved for later · 3");
    expect(ready).toMatch(/name="note"[^>]* autofocus/);
    expect((ready.match(/data-request-changes/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(ready).not.toContain('class="card revision-from-comments"');
    // The seal names the displayed batch and source (repair 2026-09-14).
    const seal = revisionFormOf(ready);
    expect(seal.batch).toBe(batch.map(one => one.id).join(","));
    expect(seal.source).toBe(store.getScope("t-loop")?.digest);
    // The seal: one revision, unapproved, exact lineage, the original evidence untouched.
    const sealed = await post(cookie, `/r/${run}/revise`, { csrf, return: `/chat?task=t-loop&result=${run}`, ...seal });
    expect(sealed.status, await sealed.text()).toBe(303);
    const revisionId = revisionIdOf(sealed.headers.get("location"));
    expect(store.revisionsFromRun(run).map(one => one.id)).toEqual([revisionId]);
    expect(store.getScope(revisionId)?.approvedAt).toBeNull();
    expect(store.revisionLineageOf(revisionId, T0)).toMatchObject({ sourceTask: "t-loop", sourceRun: run });
    expect(store.liveDiffComments(run)).toHaveLength(0);
    expect(store.allDiffComments(run).every(one => one.consumedBy === revisionId)).toBe(true);
    // A pending revision removes its old result from the current queue even
    // when that result is recent. Do not invent an age-based explanation.
    const earlierResult = await read(`/review?result=t-loop&run=${run}`);
    expect(earlierResult).toContain('This result is not in the current review list.');
    expect(earlierResult).not.toContain('finished earlier than the newest');
    expect(earlierResult).toContain('No results in this review list.');
    expect(earlierResult).not.toContain('No finished tasks yet.');
    expect(await read('/work?view=completed')).toContain('No tasks have been marked complete in this view.');
    // Replays of the seal: the SAME revision, never a twin.
    const again = await post(cookie, `/r/${run}/revise`, { csrf, return: `/chat?task=t-loop&result=${run}`, ...seal });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(sealed.headers.get("location"));
    expect(store.revisionsFromRun(run)).toHaveLength(1);
    // Both directions: the result names the revision; the revision names the result (task page and chat card).
    const after = await read(`/r/${run}`);
    expect(after).toContain(`<p class="result-revision" data-result-revision="${revisionId}" data-result-revision-approved="0"`);
    expect(after).toContain(`<strong>Revision</strong> <a href="/t/${revisionId}">`);
    expect(after).toContain('<div class="diff-review" data-review-diff>');
    expect(after).toContain(`<img src="/r/${run}/evidence/`);
    expect(after).not.toContain(`action="/r/${run}/revise"`);
    plannerKeptTerms(store, revisionId);
    const revisionTask = await read(`/t/${revisionId}`);
    expect(revisionTask).toContain(`href="/r/${run}">build #${run}</a>`);
    expect(revisionTask).toContain(feedbackNote);
    expect(revisionTask).toContain("Name the helper.");
    expect(revisionTask).toContain('type="password"');
    const revisionWindow = new Window();
    try {
      revisionWindow.document.body.innerHTML = revisionTask;
      const reviewPlan = revisionWindow.document.querySelector('.task-plan-review')!;
      // One sentence in view, before the password: what this fixes, in the person's own words.
      const sentence = reviewPlan.querySelector('.approval-revision')!;
      expect(sentence.textContent).toMatch(new RegExp(`^Fixes what build #${run} missed: `));
      expect(sentence.textContent).toContain("Name the helper");
      expect(reviewPlan.innerHTML.indexOf('class="approval-revision"')).toBeLessThan(reviewPlan.innerHTML.indexOf('type="password"'));
      // The exact batch, with its paths, in the Details fold.
      const feedback = reviewPlan.querySelector('[data-revision-feedback]')!;
      expect(feedback?.textContent).toContain(feedbackNote);
      expect(feedback?.textContent).toContain("Name the helper.");
      expect(feedback?.textContent).toContain("src/a.ts:2");
      expect(feedback?.closest('details')).toBe(reviewPlan.querySelector('details.approval-details'));
      expect(revisionWindow.document.querySelectorAll('[data-revision-feedback]')).toHaveLength(1);
    } finally { await revisionWindow.happyDOM.close(); }
    const revisionChat = await read(`/chat?task=${revisionId}`);
    expect(revisionChat).toContain(`href="/chat?task=t-loop&amp;result=${run}" data-revision-source>Original result: build #${run} →</a>`);
    // Looks good never became a publication or an approval.
    expect(store.publicationForRun(run)).toBeNull();
    expect(store.getScope(revisionId)?.approvedBy ?? null).toBeNull();
  });

  test("package 3 c4: a refused note sends the reader back to the view they came from; a result id that is not this task's is refused for the lens; the browser script rides every result surface", async () => {
    const ref = seed("t-back", "recoverable", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const run = build("t-back", ref, RICH);
    const otherRef = seed("t-other", "another task", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const otherRun = build("t-other", otherRef, RICH);
    await boot();
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();
    const csrf = csrfOf(await read(`/r/${run}`));
    for (const back of [`/chat?task=t-back&result=${run}`, "/review?result=t-back", `/r/${run}`]) {
      const refused = await post(cookie, `/r/${run}/comment`, { csrf, note: "x", line: "abc", return: back });
      expect(refused.status).toBe(400);
      const refusedHtml = await refused.text();
      expect(refusedHtml).toContain(`<a href="${back.replace(/&/g, "&amp;")}">`);
      expect(refusedHtml).toContain("Enter a whole line number from 1 to 1,000,000, or leave it blank.");
    }
    const foreign = await post(cookie, `/r/${run}/comment`, { csrf, note: "x", line: "abc", return: `/chat?task=t-back&result=${otherRun}` });
    expect(await foreign.text()).toContain(`<a href="/r/${run}">`);
    expect(store.liveDiffComments(run)).toHaveLength(0);
    const savedInChanges = await post(cookie, `/r/${run}/comment`, { csrf, note: "Keep this view", return: `/chat?task=t-back&result=${run}`, tab: "changes" });
    expect(savedInChanges.status).toBe(303);
    expect(savedInChanges.headers.get("location")).toBe(`/chat?task=t-back&result=${run}&tab=changes&noted=1#request-changes`);
    const refusedInChecks = await post(cookie, `/r/${run}/comment`, { csrf, note: "x", line: "abc", return: `/r/${run}`, tab: "checks" });
    expect(await refusedInChecks.text()).toContain(`<a href="/r/${run}?tab=checks">`);
    // The chat lens never shows another task's run as its result.
    const wrong = await read(`/chat?task=t-back&result=${otherRun}`);
    expect(wrong).not.toContain('<section class="card result-panel"');
    expect(wrong).toContain("That result is not available for this task. The conversation is shown without it.");
    expect(wrong).toContain('data-task="t-back"');
    const nonsense = await read("/chat?task=t-back&result=abc");
    expect(nonsense).not.toContain('<section class="card result-panel"');
    expect(nonsense).toContain("That result is not available for this task.");
    // The script that keeps drafts, the view, and the position rides the chat lens, the detail, the run page, and the cockpit — keyed by account, task, run.
    for (const html of [await read("/chat?task=t-back"), await read(`/chat?task=t-back&result=${run}`), await read(`/r/${run}`), await read("/review?result=t-back")]) {
      expect(html).toContain("draftPrefix+user+':'+task+':'+run");
    }
    expect(await read(`/r/${run}`)).toContain(`data-result-task="t-back" data-result-user="alex"`);
    // A bearer session (no CSRF) sees the facts and no form, with the reason.
    const bearer = await (await fetch(url(`/r/${run}`), { headers: { authorization: `Bearer alex:${approverToken}` } })).text();
    expect(bearer).toContain("data-result-panel");
    expect(bearer).not.toContain('id="comment-form"');
    expect(bearer).toContain("Sign in with a browser session to request changes.");
  });

  // ---- repair 2026-09-14: the five independent findings ------------------
  test("repair c7: after a missed response an unchanged retry records once; the same request identity with different words, a different file, or another result is refused with the draft's way back carrying the conflict; a fresh identity records the edited note", async () => {
    const ref = seed("t-retry", "a lost response", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const run = build("t-retry", ref, RICH);
    const otherRef = seed("t-retry-other", "another result", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const otherRun = build("t-retry-other", otherRef, RICH);
    await boot();
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();
    const page = await read(`/r/${run}`);
    const csrf = csrfOf(page);
    const token = /name="request" value="([a-f0-9]{32})"/.exec(page.slice(page.indexOf('id="comment-form"')))?.[1] ?? "";
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    const back = `/chat?task=t-retry&result=${run}`;
    // Note A lands; the document never sees the receipt (the reviewer's fetch scenario).
    const first = await post(cookie, `/r/${run}/comment`, { csrf, note: "Note A", request: token, return: back });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(`${back}&noted=${token}#request-changes`);
    expect(store.liveDiffComments(run).map(one => one.note)).toEqual(["Note A"]);
    // The same identity with EDITED words: refused, nothing recorded, and
    // the way back names the conflicting token so the browser rotates it.
    const edited = await post(cookie, `/r/${run}/comment`, { csrf, note: "Note B", request: token, return: back });
    expect(edited.status).toBe(409);
    const refusal = await edited.text();
    expect(refusal).toContain("this request identity already recorded a different note on this result");
    expect(refusal).toContain("&quot;Note A&quot;");
    expect(refusal).toContain(`<a href="${back.replace(/&/g, "&amp;")}&amp;conflict=${token}#request-changes">← Back</a>`);
    expect(refusal).toContain('<p class="meta refusal-back">');
    expect(await stylesOf(refusal, base)).toContain(".refusal-back a { display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; }");
    expect(store.liveDiffComments(run).map(one => one.note)).toEqual(["Note A"]);
    // The same identity pinned to a file: a different note too.
    const repinned = await post(cookie, `/r/${run}/comment`, { csrf, note: "Note A", path: "src/a.ts", line: "2", request: token, return: back });
    expect(repinned.status).toBe(409);
    expect(store.liveDiffComments(run)).toHaveLength(1);
    // The UNCHANGED retry: the same receipt, still one note.
    const retried = await post(cookie, `/r/${run}/comment`, { csrf, note: "Note A", request: token, return: back });
    expect(retried.status).toBe(303);
    expect(retried.headers.get("location")).toBe(first.headers.get("location"));
    expect(store.liveDiffComments(run)).toHaveLength(1);
    // Cross-run reuse of the identity: refused on the other result, nothing recorded there.
    const otherCsrf = csrfOf(await read(`/r/${otherRun}`));
    const crossed = await post(cookie, `/r/${otherRun}/comment`, { csrf: otherCsrf, note: "Note A", request: token, return: `/r/${otherRun}` });
    expect(crossed.status).toBe(409);
    const crossedWords = await crossed.text();
    expect(crossedWords).toContain(`already used on another result (build #${run})`);
    expect(crossedWords).toContain(`<a href="/r/${otherRun}?conflict=${token}#request-changes">`);
    expect(store.liveDiffComments(otherRun)).toHaveLength(0);
    expect(store.liveDiffComments(run)).toHaveLength(1);
    // A fresh identity for the edited words: a second note, and the two receipts differ.
    const fresh = "c".repeat(32);
    const second = await post(cookie, `/r/${run}/comment`, { csrf, note: "Note B", request: fresh, return: back });
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe(`${back}&noted=${fresh}#request-changes`);
    expect(store.liveDiffComments(run).map(one => one.note)).toEqual(["Note A", "Note B"]);
    // The browser half is the same script on every result surface: the
    // identity is bound at submit and rotated on edit or on ?conflict=.
    for (const html of [await read(`/r/${run}`), await read(back), await read("/review?result=t-retry")]) {
      expect(html).toContain("if((bound!==null&&current!==bound)||(sent!==null&&current!==sent)){sent=null;if(requestBox)requestBox.value=mint();}");
      expect(html).toContain("saved.request===conflict");
    }
  });

  test("repair c8: the revision form seals exactly the displayed batch; replaying an old request returns its original child and never consumes later notes; a two-tab batch partly sealed elsewhere is refused whole; concurrent identical seals land on one child; stale source and malformed batches are refused", async () => {
    const ref = seed("t-batch", "exact batches", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const run = build("t-batch", ref, RICH);
    store.stampRun(run, { scopeDigest: store.getScope("t-batch")!.digest });
    const strayRef = seed("t-batch-stray", "another result", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const strayRun = build("t-batch-stray", strayRef, RICH);
    await boot();
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();
    const csrf = csrfOf(await read(`/r/${run}`));
    const note = async (words: string, where = run) => {
      const posted = await post(cookie, `/r/${where}/comment`, { csrf, note: words, return: `/r/${where}` });
      expect(posted.status).toBe(303);
      return store.liveDiffComments(where).find(one => one.note === words)!.id;
    };
    const a = await note("Note A");
    const b = await note("Note B");
    const shown = revisionFormOf(await read(`/r/${run}`));
    expect(shown).toEqual({ batch: `${a},${b}`, source: store.getScope("t-batch")!.digest });
    const oldBody = { csrf, return: `/r/${run}`, ...shown };
    // Seal A+B → child X.
    const sealed = await post(cookie, `/r/${run}/revise`, oldBody);
    expect(sealed.status, await sealed.text()).toBe(303);
    const x = revisionIdOf(sealed.headers.get("location"));
    expect(store.revisionsFromRun(run).map(one => one.id)).toEqual([x]);
    // A later note C, then the OLD request replayed byte for byte: X again, C untouched.
    const c = await note("Note C");
    const replayed = await post(cookie, `/r/${run}/revise`, oldBody);
    expect(replayed.status).toBe(303);
    expect(replayed.headers.get("location")).toBe(sealed.headers.get("location"));
    expect(store.revisionsFromRun(run).map(one => one.id)).toEqual([x]);
    expect(store.liveDiffComments(run).map(one => one.id)).toEqual([c]);
    expect(store.allDiffComments(run).find(one => one.id === c)?.consumedBy).toBeNull();
    // A consumed subset, reordered batch, or changed source is not the old request.
    for (const changed of [{ batch: String(a) }, { batch: `${b},${a}` }, { source: "wrong-source" }]) {
      expect((await post(cookie, `/r/${run}/revise`, { ...oldBody, ...changed })).status).toBe(409);
    }
    // Two tabs: tab 1 displayed [C]; tab 2 displayed [C, D]. Tab 1 seals →
    // Y. Tab 2's batch is partly sealed elsewhere: refused whole, D still live.
    const tabOne = revisionFormOf(await read(`/r/${run}`));
    const d = await note("Note D");
    const tabTwo = revisionFormOf(await read(`/r/${run}`));
    expect(tabOne.batch).toBe(String(c));
    expect(tabTwo.batch).toBe(`${c},${d}`);
    const one = await post(cookie, `/r/${run}/revise`, { csrf, return: `/r/${run}`, ...tabOne });
    expect(one.status).toBe(303);
    const y = revisionIdOf(one.headers.get("location"));
    const two = await post(cookie, `/r/${run}/revise`, { csrf, return: `/r/${run}`, ...tabTwo });
    expect(two.status).toBe(409);
    expect(await two.text()).toContain(`some of these notes were already sealed into revision ${y}; the others are still waiting`);
    expect(store.revisionsFromRun(run).map(one => one.id)).toEqual([x, y]);
    expect(store.liveDiffComments(run).map(one => one.id)).toEqual([d]);
    // Tab 2 reloads and sees [D]; two identical submissions race: one child, both land on it.
    const reloaded = revisionFormOf(await read(`/r/${run}`));
    expect(reloaded.batch).toBe(String(d));
    const [left, right] = await Promise.all([
      post(cookie, `/r/${run}/revise`, { csrf, return: `/r/${run}`, ...reloaded }),
      post(cookie, `/r/${run}/revise`, { csrf, return: `/r/${run}`, ...reloaded }),
    ]);
    expect([left.status, right.status]).toEqual([303, 303]);
    expect(left.headers.get("location")).toBe(right.headers.get("location"));
    const z = revisionIdOf(left.headers.get("location"));
    expect(store.revisionsFromRun(run).map(one => one.id)).toEqual([x, y, z]);
    expect(store.liveDiffComments(run)).toHaveLength(0);
    // The brief of each child carries exactly its batch.
    expect(store.allDiffComments(run).map(one => [one.id, one.consumedBy])).toEqual([[a, x], [b, x], [c, y], [d, z]]);
    // Malformed, foreign, and absent batches are refused before anything is read.
    const e = await note("Note E");
    for (const body of [{ csrf, return: `/r/${run}` }, { csrf, return: `/r/${run}`, batch: "abc", source: shown.source }, { csrf, return: `/r/${run}`, batch: String(e), source: "" }]) {
      const refused = await post(cookie, `/r/${run}/revise`, body);
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain("this form is out of date");
    }
    const strayId = await note("Stray", strayRun);
    const foreign = await post(cookie, `/r/${run}/revise`, { csrf, return: `/r/${run}`, batch: `${e},${strayId}`, source: shown.source });
    expect(foreign.status).toBe(400);
    expect(await foreign.text()).toContain("names notes that are not on this result");
    expect(store.liveDiffComments(run).map(one => one.id)).toEqual([e]);
    expect(store.liveDiffComments(strayRun).map(one => one.id)).toEqual([strayId]);
    // The source terms changed after the page was shown: refused; the note waits.
    propose(store, { taskId: "t-batch", goal: "goal of t-batch, rewritten", outOfScope: null, touches: [], acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"], how: null }], now: T0 });
    const stale = await post(cookie, `/r/${run}/revise`, { csrf, return: `/r/${run}`, batch: String(e), source: shown.source });
    const staleWords = await stale.text();
    expect(stale.status, staleWords.slice(staleWords.indexOf("<main>"))).toBe(409);
    expect(staleWords).toContain("the task&#39;s terms changed since this page was shown");
    const oldAfterRescope = await post(cookie, `/r/${run}/revise`, oldBody);
    expect(oldAfterRescope.status).toBe(303);
    expect(oldAfterRescope.headers.get("location")).toBe(sealed.headers.get("location"));
    expect(store.revisionsFromRun(run).map(one => one.id)).toEqual([x, y, z]);
    expect(store.liveDiffComments(run).map(one => one.id)).toEqual([e]);
  });

  test("repair c9: damaged check bytes stay visible and withheld while the saved result remains available to handle; shortened downloads describe the stored part only", async () => {
    const ref = seed("t-log", "a corrupted log", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const run = build("t-log", ref, RICH);
    const shortRef = seed("t-short", "shortened records", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const longPatch = `${PATCH}${"+// padding line that pushes the sealed diff past its storage cap\n".repeat(5_000)}`;
    const shortRun = build("t-short", shortRef, { ...RICH, patch: longPatch, checkLog: "x".repeat(170 * 1024) });
    await boot();
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();
    const surfaces = () => Promise.all([read(`/r/${run}`), read("/review?result=t-log"), read(`/chat?task=t-log&result=${run}`), read("/t/t-log"), read("/chat?task=t-log")]);
    for (const html of await surfaces()) {
      expect(factsOf(html)[0]?.evidence).toBe("ok");
      expect(html).toContain('data-work-status="assignment-needs-decision"');
    }
    // The damage, after sealing.
    const log = store.artifactsFor(run).find(one => one.kind === "check-log");
    if (log === undefined) throw new Error("no check log");
    writeFileSync(join(evidenceRoot, log.key), "$ npm test\n0 passed, 12 failed\n");
    for (const html of await surfaces()) {
      expect(factsOf(html)[0]?.evidence).toBe("problems:1");
      expect(html).toContain("The check log no longer verifies (");
      expect(html).toContain('data-work-status="assignment-needs-decision"');
      // Historical attempt labels remain recorded; current evidence health
      // must not be presented as a successful verification.
      expect(html).not.toContain('class="status-label">Ready to review</span>');
      expect(html).not.toContain("0 passed, 12 failed");
      expect(html).not.toContain("Open the full check log");
      // The result panel and the receipt offer no download of the damaged
      // bytes (the run page's raw artifact ledger still lists the record;
      // the evidence road refuses it below).
      const sharedWindow = new Window();
      try {
        sharedWindow.document.body.innerHTML = html;
        const shared = sharedWindow.document.querySelector('.completion-receipt, .result-panel')!;
        expect(shared).not.toBeNull();
        expect(shared.innerHTML).not.toContain(`/evidence/${log.id}"`);
      } finally { await sharedWindow.happyDOM.close(); }
    }
    const panel = await read(`/r/${run}?tab=checks`);
    expect(panel).toContain('<p class="problem" data-check-log="damaged" data-cockpit-source="machine">The check log no longer verifies (');
    expect(panel).toContain("Its output is not shown, and there is nothing to download.");
    expect(panel.indexOf('data-result-attention=')).toBeLessThan(panel.indexOf('class="result-tabs"'));
    expect(panel).toContain("check log (unverifiable)");
    expect((await fetch(url(`/r/${run}/evidence/${log.id}`), { headers: { cookie } })).status).toBe(410);
    // Shortened records: the readiness word stands, the detail says what was cut, and no download claims the full bytes.
    const shortLog = store.artifactsFor(shortRun).find(one => one.kind === "check-log")!;
    const shortPatch = store.artifactsFor(shortRun).find(one => one.kind === "terminal-diff")!;
    expect(shortLog.truncated && shortPatch.truncated).toBe(true);
    const shortPage = await read(`/r/${shortRun}?tab=checks`);
    expect(factsOf(shortPage)[0]?.evidence).toBe("problems:2");
    expect(shortPage).toContain('data-work-status="assignment-needs-decision"');
    expect(shortPage).toContain("The sealed diff was shortened when it was stored; its download holds only the stored part, not the full change.");
    expect(shortPage).toContain("The check output was shortened when it was stored; its download holds only the stored part.");
    expect(shortPage).toContain(`<details data-check-log="shortened" data-cockpit-source="machine"><summary>Check output (shortened — ${shortLog.bytesStored} of ${shortLog.bytesOriginal} bytes stored)</summary>`);
    expect(shortPage).toContain(`href="/r/${shortRun}/evidence/${shortLog.id}">Download the stored part of the check log (shortened at storage — not the full check log)</a>`);
    expect(shortPage).toContain(`href="/r/${shortRun}/evidence/${shortPatch.id}">Download the stored part of the diff (shortened at storage — not the full diff)</a>`);
    expect(shortPage).toContain("The sealed diff was shortened at storage: the rest of the change was never captured, here or in the download.");
    expect(shortPage).not.toContain("Download the full diff");
    expect(shortPage).not.toContain("Open the full check log");
    const shortTask = await read("/t/t-short");
    expect(shortTask).toContain("The sealed diff was shortened when it was stored; its download holds only the stored part, not the full change.");
    expect(shortTask).toContain("The check output was shortened when it was stored; its download holds only the stored part.");
    expect(shortTask).toContain('data-work-status="assignment-needs-decision"');
    // Existing acceptance stays recorded when bytes change. The saved result
    // remains ready to handle, but its current checks become unavailable.
    store.stampRun(shortRun, { scopeDigest: store.getScope("t-short")!.digest });
    store.setVerifyCommand({ repo: "/repo/main", command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, new Date(T0.getTime() - 120_000));
    sealVerificationReceipt(store, evidenceRoot, shortRun, "b".repeat(40), store.liveVerifyCommand("/repo/main")!, { configured: true, ran: true, exitCode: 0 }, T0);
    store.acceptProof(shortRun, "alex", "Inspected the stored part and accepted its limits.", T0);
    const acceptedTask = await read("/t/t-short");
    expect(acceptedTask).toContain('data-work-status="assignment-ready-to-check"');
    expect(acceptedTask).toContain("Accepted with an exception by alex. Check results are unchanged.");
    writeFileSync(join(evidenceRoot, shortLog.key), "changed after acceptance");
    const acceptedDamagedTask = await read("/t/t-short");
    expect(acceptedDamagedTask).toContain('data-work-status="assignment-ready-to-check"');
    expect(acceptedDamagedTask).not.toContain('data-work-status="assignment-needs-decision"');
    expect(acceptedDamagedTask).toContain("Accepted with an exception by alex. Check results are unchanged.");
    expect(acceptedDamagedTask).toContain("The check log no longer verifies (");
    const acceptedDamagedResult = await read(`/review?result=t-short&run=${shortRun}`);
    expect(acceptedDamagedResult).toContain('data-actual-checks="unavailable"');
    expect(acceptedDamagedResult).toContain("The retained verification log no longer verifies.");
    expect(acceptedDamagedResult).toContain('Accept and finish</button>');
    expect(acceptedDamagedResult).not.toContain('data-actual-checks="passed"');
    expect(store.proofAcceptance(shortRun)?.approver).toBe("alex");
    const damagedTask = await read("/t/t-log");
    expect(damagedTask).toContain("The check log no longer verifies");
    expect(store.proofVerdictFor(run)?.verdict).toBe("verified");
    expect(damagedTask).not.toContain('data-dispatch-status="complete-verified"');
  });

  test("repair c9: missing log and diff files and missing, corrupt or shortened reports stay honest on all shared result surfaces", async () => {
    const logRef = seed("t-missing-log", "missing log");
    const logRun = build("t-missing-log", logRef, RICH);
    const diffRef = seed("t-missing-diff", "missing diff");
    const diffRun = build("t-missing-diff", diffRef, RICH);
    for (const [run, kind] of [[logRun, "check-log"], [diffRun, "terminal-diff"]] as const) {
      const artifact = store.artifactsFor(run).find(one => one.kind === kind)!;
      rmSync(join(evidenceRoot, artifact.key));
    }
    const scouts = ["missing", "corrupt", "shortened", "cut-json"].map(kind => {
      const id = `t-report-${kind}`;
      const ref = seed(id, `${kind} report`);
      const run = store.startRun({ taskRef: ref, leaseId: id, runner: "night-shift-1", provider: "claude", role: "scout", branch: id, worktree: `/pool/${id}`, now: T0, ...presented(store, ref, "builder") });
      let artifactId: number | null = null;
      if (kind !== "missing") {
        const document = JSON.stringify({ title: "Captured report", summary: "Stored evidence.", report: "# Safe text", followUps: [] });
        const content = Buffer.from(kind === "cut-json" ? document.slice(0, -10) : document);
        const key = `${run}/report.json`;
        mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
        writeFileSync(join(evidenceRoot, key), content);
        artifactId = store.saveArtifact({ run, kind: "report", key, bytesStored: content.length, bytesOriginal: content.length + (kind === "corrupt" ? 0 : 100), truncated: kind !== "corrupt", sha256: createHash("sha256").update(content).digest("hex"), capture: "stored report" }, T0);
        if (kind === "corrupt") writeFileSync(join(evidenceRoot, key), "altered");
      }
      store.finishRun(run, { outcome: "no-change", committed: false, now: T0 });
      store.setTaskState(id, "done", T0);
      return { kind, id, run, artifactId };
    });
    await boot();
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();
    for (const sample of [{ id: "t-missing-log", run: logRun, kind: "log", artifactId: null }, { id: "t-missing-diff", run: diffRun, kind: "diff", artifactId: null }, ...scouts]) {
      const texts = await Promise.all([read(`/r/${sample.run}`), read(`/review?result=${sample.id}`), read(`/chat?task=${sample.id}&result=${sample.run}`), read(`/t/${sample.id}`), read(`/chat?task=${sample.id}`)]);
      for (const html of texts) {
        expect(factsOf(html)[0]?.evidence).toBe("problems:1");
        if (sample.kind === "shortened") {
          expect(html).toMatch(/data-result-attention=|class="problem"|<details class="assignment-notices"><summary>Saved output is partial<\/summary>|data-status-detail="evidence" data-mark="note"/);
        } else {
          // Missing, damaged, and unreadable current material stays expanded.
          // The shared status names it as an amber Saved evidence row; the exact file waits under Details.
          expect(html).toMatch(/data-result-attention=|class="problem"|data-status-detail="evidence" data-mark="note"/);
        }
        if (sample.kind !== "shortened") {
          expect(html).toContain('data-work-status="assignment-needs-decision"');
          expect(html).not.toContain('class="status-label">Ready to review</span>');
          expect(html).not.toContain('class="status-label">Report ready</span>');
        }
        if (sample.kind === "shortened") expect(html).toContain("The report was shortened when it was stored; its download holds only the stored part.");
        if (sample.kind === "cut-json") expect(html).toContain("the report was shortened at storage and cannot be read; the missing part was never captured");
      }
      if (sample.kind === "shortened") {
        expect(texts[0]).toContain(`href="/r/${sample.run}/evidence/${sample.artifactId}">Download the stored part of the report (shortened at storage — not the full report)</a>`);
        expect(texts[0]).not.toContain(">Download the report</a>");
      }
      if (sample.kind === "log" || sample.kind === "diff") {
        store.stampRun(sample.run, { scopeDigest: store.getScope(sample.id)!.digest });
        const currentResult = await read(`/review?result=${sample.id}&run=${sample.run}`);
        expect(currentResult).toContain('data-work-status="assignment-ready-to-check"');
        expect(currentResult).toContain('data-actual-checks="unavailable"');
        expect(currentResult).toContain('data-result-attention=');
        expect(currentResult).toContain('Accept and finish</button>');
        expect(currentResult).not.toContain('data-actual-checks="passed"');
      }
    }
  });

  test("repair c10: a revision's standing is the shared projection's own words — current exact approval and actual activity: approve then rescope needs approval again, and held or paused work is never called building because it was once approved", async () => {
    const ref = seed("t-standing", "revision standing", "/repo/main", { acceptance: [{ id: "c1", statement: "It works", evidence: ["check", "screenshot"] }] });
    const run = build("t-standing", ref, RICH);
    store.stampRun(run, { scopeDigest: store.getScope("t-standing")!.digest });
    // Keep the worker stale but the one-hour claim below live.
    await boot({ clock: () => new Date(T0.getTime() + 30 * 60_000) });
    const cookie = await login();
    const read = async (path: string) => (await fetch(url(path), { headers: { cookie } })).text();
    const csrf = csrfOf(await read(`/r/${run}`));
    expect((await post(cookie, `/r/${run}/comment`, { csrf, note: "Round the footer.", return: `/r/${run}` })).status).toBe(303);
    const sealed = await post(cookie, `/r/${run}/revise`, { csrf, return: `/r/${run}`, ...revisionFormOf(await read(`/r/${run}`)) });
    expect(sealed.status).toBe(303);
    const child = revisionIdOf(sealed.headers.get("location"));
    const childRef = store.lookupRef(child)!.id;
    const line = async () => /<p class="result-revision" data-result-revision="[^"]+" data-result-revision-approved="([01])" data-tone="([a-z]+)"><strong>Revision<\/strong> <a href="[^"]+">[^<]*<\/a> <span class="meta">· ([^<]*)<\/span><\/p>/.exec(await read(`/r/${run}`));
    // The Work row names the assignment; the selected result still names the exact revision state.
    const rowWords = async () => /<span class="status-label">([^<]*)<\/span>/.exec((await read("/work?view=all")).split(`data-task="t-standing"`)[1] ?? "")?.[1] ?? null;
    // Planned first: nothing to approve until the plan is updated (this fixture's worker is stale, and it says so).
    // The revision's standing is its shared headline (task-status.ts).
    expect((await line())?.[3]).toBe("Needs you");
    plannerKeptTerms(store, child);
    // Unapproved: the exact revision names approval; the root names the decision.
    const unapproved = await line();
    expect(unapproved?.[1]).toBe("0");
    expect(unapproved?.[3]).toBe("Needs you");
    expect(await rowWords()).toBe("Needs you");
    // Approved exactly: no longer waiting for approval — and not "building"
    // either: nothing runs, and this fixture's builder is not heartbeating.
    const scope = store.getScope(child)!;
    const agreed = approve(store, child, "alex", T0, scope.digest, approverToken);
    if (!agreed.ok) throw new Error(agreed.reason);
    const approved = await line();
    expect(approved?.[1]).toBe("1");
    expect(approved?.[3]).not.toMatch(/building|approval/i);
    expect(await rowWords()).toBe("Needs you");
    // Held after approval: on hold, never building.
    store.hold(childRef, "Wait for the column names to settle.", null, T0);
    const held = await line();
    expect(held?.[1]).toBe("1");
    expect(held?.[3]).toBe("Stopped");
    expect(await rowWords()).toBe("Stopped");
    store.unhold(childRef, T0);
    // Rescoped after approval: the old stamp is no approval of the new terms.
    propose(store, { taskId: child, goal: `${scope.goal} — and also the header row`, outOfScope: scope.outOfScope, touches: scope.touches, acceptance: scope.acceptance, now: T0 });
    expect(store.getScope(child)?.approvedAt).not.toBeNull();
    expect(store.revisionsFromRun(run)[0]?.approved).toBe(false);
    const rescoped = await line();
    expect(rescoped?.[1]).toBe("0");
    expect(rescoped?.[3]).toBe("Needs you");
    expect(await rowWords()).toBe("Needs you");
    // A live claim makes both the revision and its root Revising; a settled stop is Paused.
    const again = approve(store, child, "alex", T0, store.getScope(child)!.digest, approverToken);
    if (!again.ok) throw new Error(again.reason);
    const claim = acquire(store, childRef, "night-shift-1", { token: "tok-night-shift-1", now: T0, ttlMs: 3_600_000 });
    if (!claim.ok) throw new Error(claim.reason);
    const live = store.startRun({ taskRef: childRef, leaseId: claim.claim.leaseId, runner: "night-shift-1", provider: "claude", branch: `standing-orders/${child}`, worktree: `/pool/${child}`, now: T0, ...presented(store, childRef, "builder") });
    store.setTaskState(child, "running", T0);
    const running = await line();
    expect(running?.[1]).toBe("1");
    expect(running?.[3]).toBe("Building");
    expect(await rowWords()).toBe("Building");
    const stopped = store.requestRunStop({ runId: live, taskRef: childRef, by: "alex", via: "web" }, T0);
    if (!stopped.ok) throw new Error(stopped.reason);
    store.finishRun(live, { outcome: "interrupted", reason: "stopped", now: T0, stopSettlement: "interrupted" });
    release(store, claim.claim.leaseId, T0);
    store.setTaskState(child, "queued", T0);
    const paused = await line();
    expect(paused?.[1]).toBe("1");
    expect(paused?.[3]).toBe("Stopped");
    expect(await rowWords()).toBe("Stopped");
  });
});
