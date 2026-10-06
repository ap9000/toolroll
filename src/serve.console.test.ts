/**
 * The console server: the operations console, board, routines, fleet and
 * queue-clearing pages over real HTTP.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { acquire, release } from "./claim.js";
import { register, hashToken } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { approveRoutine, fireRoutine, refreshRoutineAgents, routineDigestOf } from "./routine.js";
import { planTournament, admitContest } from "./contest.js";
import { createDecisionServer } from "./serve.js";
import { parseExecutionPlanDocument, milestonesOf } from "./plan.js";
import { resolveRoutineAuthority } from "./agentconfig.js";
import { Window } from "happy-dom";
import { presented, T0, renderedHtmlOf, workspaceOf, revisionIdOf, plannerKeptTerms, revisionFormOf, sealScopeFixture } from "../test/serve-kit.js";
import { handoffBytes } from "../test/handoff-fixture.js";

describe("the operations console", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const csrfFrom = async (cookie: string, path = "/tasks"): Promise<string> => {
    const html = await (await fetch(url(path), { headers: { cookie } })).text();
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on the page");
    return match[1] as string;
  };

  const post = (path: string, cookie: string, fields: Record<string, string>) =>
    fetch(url(path), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  // Recent, not T0: the home page windows "the last 24 hours" against the
  // real clock, and a fixed seed instant would make this suite fail at a
  // particular time of day.
  const seedRun = (taskRef: number, n: number) =>
    store.startRun({
      taskRef,
      leaseId: `lease-${n}`,
      runner: "builder-1",
      branch: `standing-orders/x-${n}`,
      worktree: `/pool/x-${n}`,
      now: new Date(Date.now() - n * 60_000),
      ...presented(store, taskRef, "builder"),
    });

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-console-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => new Date(),
      repo: "/repo/main",
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the home page is the brief, live — measured spend, incidents, stranded work", async () => {
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    const run = seedRun(ref, 1);
    store.stampProviderStart(run, new Date());
    store.recordUsage(run, { tokensIn: 100, tokensOut: 50, costUsd: 1.25 });
    store.finishRun(run, { outcome: "built", reason: "clean", now: T0 });
    const incidentRun = seedRun(ref, 2);
    store.createIncident({ run: incidentRun, kind: "attempts-exhausted" }, T0);
    store.createTask({ id: "t-blocked", title: "waits" }, T0);
    store.createTask({ id: "t-dead", title: "gone" }, T0);
    store.addEdge("t-blocked", "t-dead");
    store.setTaskState("t-dead", "failed", T0);

    const cookie = await login();
    const brief = await (await fetch(url("/morning"), { headers: { cookie } })).text();
    expect(brief).toContain("<b>1</b> built");
    expect(brief).toContain("$1.25");
    expect(brief).toContain("t-blocked");
    expect(brief).toContain("t-dead");

    // The stall is the inbox's business now: one retry card per task.
    const inbox = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(inbox).toContain("Retry stalled work");
    expect(inbox).toContain("t-1");
  });

  test("evidence-first task page: attempts ledger, spend by provider, the unmeasured said in words (M5.5/6)", async () => {
    store.createTask({ id: "t-spend", title: "spendy" }, T0);
    const ref = store.refFor("built-in", "t-spend").id;
    const claudeRun = store.startRun({ taskRef: ref, leaseId: "l-s1", runner: "b-1", branch: "b", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.recordUsage(claudeRun, { tokensIn: 41_000, tokensOut: 3_000, costUsd: 1.23 });
    store.finishRun(claudeRun, { outcome: "built", now: T0 });
    const codexRun = store.startRun({ taskRef: ref, leaseId: "l-s2", runner: "b-1", branch: "b", worktree: "/w", provider: "codex", now: T0, ...presented(store, ref, "builder", null, { provider: "codex", model: null }) });
    store.recordUsage(codexRun, { tokensIn: 80_000, tokensOut: 9_000 });
    store.finishRun(codexRun, { outcome: "failed", reason: "agent", now: T0 });

    const cookie = await login();
    const page = await (await fetch(url("/t/t-spend"), { headers: { cookie } })).text();
    expect(page).toContain("attempts");
    expect(page).toContain("spend");
    expect(page).toContain("$1.23");
    // Tokens without dollars are the unmeasured, in words — never $0.00.
    expect(page).toContain("dollar cost unmeasured");
    expect(page).not.toContain("$0.00");
    // Evidence above mechanics: the ledger precedes the scope section.
    expect(page.indexOf("attempts")).toBeLessThan(page.indexOf(">scope<"));

    // A failed build's /r/<id> opens its result page; the run record itself is ?record=1.
    const runView = await (await fetch(url(`/r/${codexRun}?record=1`), { headers: { cookie } })).text();
    expect(runView).toContain("unmeasured");
    expect(runView).toContain("tokens, not prices");
  });

  test("an operator note lands beside the run, immutable and validated (M6)", async () => {
    store.createTask({ id: "t-note", title: "noted" }, T0);
    const ref = store.refFor("built-in", "t-note").id;
    const run = store.startRun({ taskRef: ref, leaseId: "l-n1", runner: "b-1", branch: "b", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.finishRun(run, { outcome: "failed", reason: "agent", now: T0 });

    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/t-note"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(taskHtml)?.[1] ?? "";
    const posted = await fetch(url(`/r/${run}/note`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "suspect — the fix touched the wrong module" }),
      redirect: "manual",
    });
    expect(posted.status).toBe(303);

    const page = await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text();
    expect(page).toContain("Operator notes");
    expect(page).toContain("suspect — the fix touched the wrong module");

    // An empty note is refused by the shared validator, not stored blank.
    const blank = await fetch(url(`/r/${run}/note`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "   " }),
      redirect: "manual",
    });
    expect(blank.status).toBe(400);
  });

  test("a revision inherits the source scope's limits, and a broken brief blocks its approval (audit IV-2/IV-3)", async () => {
    const { propose } = await import("./scope.js");
    store.createTask({ id: "t-lim", title: "bounded work" }, T0);
    const ref = store.refFor("built-in", "t-lim").id;
    propose(store, { taskId: "t-lim", goal: "fix the rounding", outOfScope: "authentication", touches: ["src/payments/"], acceptance: [{ id: "c1", statement: "The rounding is fixed.", evidence: ["check"] }], now: T0 });
    sealScopeFixture(store, "t-lim", approverToken);
    const run = store.startRun({ taskRef: ref, leaseId: "l-lim", runner: "b-1", branch: "so/t-lim", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.stampRun(run, { scopeDigest: store.getScope("t-lim")!.digest });
    store.finishRun(run, { outcome: "built", now: T0 });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    const patch = Buffer.from("diff --git a/p b/p\n+x\n", "utf8");
    writeFileSync(join(evidenceRoot, String(run), "terminal-diff.patch"), patch);
    store.saveArtifact(
      { run, kind: "terminal-diff", key: `${run}/terminal-diff.patch`, bytesOriginal: patch.length, bytesStored: patch.length, truncated: false, sha256: createHash("sha256").update(patch).digest("hex"), capture: "git diff base head (exit 0)" },
      T0,
    );

    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/t-lim"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(taskHtml)?.[1] ?? "";
    await fetch(url(`/r/${run}/comment`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "narrow this" }),
      redirect: "manual",
    });
    const revised = await fetch(url(`/r/${run}/revise`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, ...revisionFormOf(await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text()) }),
      redirect: "manual",
    });
    const target = revised.headers.get("location") ?? "";
    const newTaskId = revisionIdOf(target);

    // IV-2: the exclusions and path limits SURVIVED into the revision scope.
    const revScope = store.getScope(newTaskId);
    expect(revScope?.outOfScope).toBe("authentication");
    expect(revScope?.touches).toEqual(["src/payments/"]);
    const page1 = await (await fetch(url(target), { headers: { cookie } })).text();
    expect(page1).toContain("authentication");
    expect(page1).not.toContain("<em>no exclusions</em>");
    // Sent back with a note, it is planned afresh before anyone approves it.
    expect(page1).toContain("Updating the plan");
    expect(page1).not.toContain('id="approve"');
    plannerKeptTerms(store, newTaskId);

    // IV-3: corrupt the brief on disk — the approval surface closes.
    const newRef = store.lookupRef(newTaskId);
    const briefArtifact = store.getArtifact(newRef?.revisionBriefArtifact as number);
    writeFileSync(join(evidenceRoot, briefArtifact?.key as string), "tampered");
    const page2 = await (await fetch(url(target), { headers: { cookie } })).text();
    expect(page2).toContain("approval is blocked");
    expect(page2).not.toContain("Approve this scope");
  });

  test("a high-risk, strict revision keeps its terms on the task page, the approval card, and chat after the installation's defaults change; the CI draft reads the same (contract handoff task 2)", async () => {
    const { propose } = await import("./scope.js");
    store.createTask({ id: "t-strict", title: "careful work" }, T0);
    const ref = store.refFor("built-in", "t-strict").id;
    store.placeTask(ref, "/repo/main");
    propose(store, {
      taskId: "t-strict",
      goal: "harden the payout guard",
      outOfScope: "authentication",
      touches: ["src/payments/"],
      acceptance: [{ id: "c1", statement: "The guard refuses a negative payout.", evidence: ["check"] }, { id: "c2", statement: "The dashboard shows the refusal.", evidence: ["screenshot"] }],
      budgetMicrousd: 2_000_000,
      riskLevel: "high",
      qualityMode: "strict",
      permissionMode: "auto",
      now: T0,
    });
    sealScopeFixture(store, "t-strict", approverToken);
    const run = store.startRun({ taskRef: ref, leaseId: "l-strict", runner: "b-1", branch: "so/t-strict", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.stampRun(run, { scopeDigest: store.getScope("t-strict")!.digest });
    store.finishRun(run, { outcome: "built", now: T0 });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    const patch = Buffer.from("diff --git a/g b/g\n+guard\n", "utf8");
    writeFileSync(join(evidenceRoot, String(run), "terminal-diff.patch"), patch);
    store.saveArtifact(
      { run, kind: "terminal-diff", key: `${run}/terminal-diff.patch`, bytesOriginal: patch.length, bytesStored: patch.length, truncated: false, sha256: createHash("sha256").update(patch).digest("hex"), capture: "git diff base head (exit 0)" },
      T0,
    );
    // The installation changes its mind AFTER the source was signed.
    store.setPermissionDefault("bypassPermissions", "alex", T0);
    store.setQualityDefault("default", "alex", T0);

    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/t-strict"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(taskHtml)?.[1] ?? "";
    await fetch(url(`/r/${run}/comment`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, path: "src/payments/guard.ts", line: "4", note: "also refuse zero" }),
      redirect: "manual",
    });
    const revised = await fetch(url(`/r/${run}/revise`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, ...revisionFormOf(await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text()) }),
      redirect: "manual",
    });
    expect(revised.status).toBe(303);
    const target = revised.headers.get("location") ?? "";
    const childId = revisionIdOf(target);

    // The child's ACTUAL terms: the source's, not today's defaults.
    const child = store.getScope(childId);
    expect(child).toMatchObject({ riskLevel: "high", qualityMode: "strict", budgetMicrousd: 2_000_000, outOfScope: "authentication", touches: ["src/payments/"], approvedAt: null });
    expect(child?.acceptance.map(one => one.id)).toEqual(["c1", "c2"]);
    expect(child?.profile).toMatchObject({ provider: "claude", permissionArgv: "auto" });
    expect(store.lookupRef(childId)).toMatchObject({ revisionOf: "t-strict", riskLevel: "high", qualityMode: "strict", permissionMode: "auto" });
    plannerKeptTerms(store, childId);

    // The task page: the approval card restates the terms, and the lineage
    // says where they came from and what did not come along.
    const page = await (await fetch(url(target), { headers: { cookie } })).text();
    const lineage = `revises t-strict (build #${run})`;
    expect(page).toContain(lineage);
    expect(page).toContain("inherited terms, as they stand now: High risk · Strict / release quality · auto permissions · $2.00 attempt cap · its exclusions · 1 path limit · 2 criteria");
    expect(page).toContain("never inherited: the source&#39;s approval, attended sessions, publication and merge grants");
    expect(page).toContain("re-resolved for this approval: the agents route and the fallback chain");
    expect(page).toContain("Checks level: Strict / release · Auto permissions");
    // Who builds in one line; what the yes allows, plainly, right above Approve.
    expect(page).toContain('<p class="approval-who">Builder Claude Sonnet · Planner Claude Sonnet</p>');
    expect(page).toMatch(/<p class="approval-allowing" data-approval-allowing>You’re allowing: file edits and routine commands; anything risky stops · up to \$2\.00 per attempt( · [^<]*)?<\/p><div class="approval-act"/);
    expect(page).not.toContain("runaway breaker");
    expect(page).toContain("also refuse zero");
    const approveForm = /<form method="post" action="[^"]*\/approve" class="approve-form approval-sheet" id="approve"[^>]*>(.*?)<\/form>/s.exec(page)?.[1] ?? "";
    // One sentence in view; the lineage and inherited terms in Details.
    expect(approveForm).toContain(`<p class="approval-revision">Fixes what build #${run} missed: `);
    const details = approveForm.slice(approveForm.indexOf('<details class="approval-details">'));
    expect(details).toContain("High risk");
    expect(details).toContain(lineage);
    expect(details).toContain("never inherited");
    expect(approveForm.slice(0, approveForm.indexOf('<details class="approval-details">'))).not.toContain("inherited");

    // Chat: the same words, from the same projection.
    const chat = await (await fetch(url(`/chat?task=${encodeURIComponent(childId)}`), { headers: { cookie } })).text();
    expect(chat).toContain(lineage);
    expect(chat).toContain("inherited terms, as they stand now: High risk · Strict / release quality");
    expect(chat).toContain("never inherited: the source&#39;s approval");
    expect(chat).toContain("also refuse zero");
    expect(chat).toContain("Checks level: Strict / release · Auto permissions");

    // The CI draft on a published run of the same source reads the same.
    const pub = store.createPublicationIntent(
      { run, taskRef: ref, githubRepo: "ap9000/thing", remote: "origin", base: "main", head: "so/t-strict", headSha: "c".repeat(40), bodyHash: "h3", draft: false },
      T0,
    );
    store.markPublicationPushed(pub, T0);
    store.markPublicationOpened(pub, 103, "https://github.com/ap9000/thing/pull/103", T0);
    store.enqueueNotification({ dedupeKey: `ci:ap9000/thing:103:${"c".repeat(40)}`, kind: "ci-failed", subject: "checks failing on #103", body: "red" }, T0);
    const drafted = await fetch(url(`/r/${run}/draft-repair`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(drafted.status).toBe(303);
    expect(store.getScope("t-strict-ci-103")).toMatchObject({ riskLevel: "high", qualityMode: "strict", budgetMicrousd: 2_000_000, approvedAt: null });
    const ciPage = await (await fetch(url("/t/t-strict-ci-103"), { headers: { cookie } })).text();
    expect(ciPage).toContain("CI repair");
    expect(ciPage).toContain(lineage);
    expect(ciPage).toContain("inherited terms, as they stand now: High risk · Strict / release quality · auto permissions · $2.00 attempt cap");
    expect(ciPage).toContain(`<p class="approval-revision">Fixes the checks that failed in build #${run}.</p>`);
    expect(ciPage).toContain("Checks level: Strict / release · Auto permissions");
    expect(ciPage).not.toMatch(/<p class="approval-who">[^<]*Full access/);

    // A batch drafted against a scope digest the source no longer carries
    // refuses in words and consumes nothing: the road's own seal re-reads
    // the digest inside the transaction, so a concurrent rewrite between
    // the page's read and the click can never seal old terms.
    await fetch(url(`/r/${run}/comment`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, path: "src/payments/guard.ts", line: "9", note: "and log it" }),
      redirect: "manual",
    });
    const sealed = store.sealRevision(
      {
        source: { task: "t-strict", run, scopeDigest: "0".repeat(32) },
        brief: { evidenceRoot, key: `${run}/terminal-diff.patch`, sha256: createHash("sha256").update(patch).digest("hex"), bytes: patch.length, capture: "x" },
        child: { title: "x", repair: "y" },
        commentIds: store.liveDiffComments(run).map(one => one.id),
      },
      T0,
    );
    expect(sealed).toMatchObject({ ok: false, reason: "stale-source" });
    expect(store.liveDiffComments(run)).toHaveLength(1);
  });

  test("valid Unicode goals and exclusions fit the web form transport and preserve new-task settings on rejection", async () => {
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    const fields = { csrf, title: "Unicode request", goal: "😀".repeat(4000), not: "界".repeat(8000), acceptance: "c1: Works | check", "planning-policy": "choice", "permission-mode": "auto", "quality-mode": "default" };
    const refused = await post("/tasks/add", cookie, { ...fields, goal: fields.goal + "a", id: "unicode-new", scout: "1", after: "t-1" });
    expect(refused.status).toBe(400);
    const window = new Window();
    window.document.body.innerHTML = await refused.text();
    const form = window.document.querySelector(".task-composer")!;
    expect(form.querySelector('[name="plan-first"]')?.hasAttribute("checked")).toBe(false);
    expect(form.querySelector('[name="scout"]')?.hasAttribute("checked")).toBe(true);
    expect(form.querySelector('[name="id"]')?.getAttribute("value")).toBe("unicode-new");
    expect(form.querySelector('[name="after"] option[selected]')?.getAttribute("value")).toBe("t-1");
    expect(form.textContent).not.toContain("pre-filled from a template");
    await window.happyDOM.close();
    const created = await post("/tasks/add", cookie, fields);
    expect(created.status).toBe(303);
    const id = revisionIdOf(created.headers.get("location"));
    expect(store.getScope(id)).toMatchObject({ goal: fields.goal, outOfScope: fields.not, approvedAt: null });
    const scope = store.getScope(id)!;
    expect((await post(`/t/${id}/scope`, cookie, { ...fields, sawDigest: scope.digest })).status).toBe(303);
    expect(store.getScope(id)).toMatchObject({ goal: fields.goal, outOfScope: fields.not, approvedAt: null });
  });

  test.each(["goal", "not"])("rejected web %s stays editable and cannot replace signed terms", async field => {
    store.createTask({ id: "t-edit", title: "Edit safely" }, T0);
    propose(store, { taskId: "t-edit", goal: "Original goal", outOfScope: "Original exclusion", acceptance: [{ id: "c1", statement: "Works", how: null, evidence: ["check"] }], now: T0 });
    const original = store.getScope("t-edit")!;
    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/t-edit"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(taskHtml)?.[1] ?? "";
    for (const value of ["a".repeat(8001), "😀".repeat(4001), "界".repeat(8001), "bad\u202e", "bad\u0000", "ok\r"]) {
      const fields = { csrf, goal: "valid", not: "exclusion", touches: "src/y.ts", acceptance: "c1: Works | check", [field]: value };
      for (const path of ["/tasks/add", "/t/t-edit/scope"]) {
        const response = await fetch(url(path), { method: "POST", headers: { cookie }, body: new URLSearchParams({ ...fields, title: "New task", sawDigest: original.digest, "planning-policy": "choice", "permission-mode": "auto", "budget-usd": "12", "quality-mode": "strict" }), redirect: "manual" });
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain(value.length > 8000 ? `${field === "goal" ? "Goal" : "Exclusions"} is ${value.length.toLocaleString("en-US")} characters; the limit is 8,000. Shorten it.` : "cannot contain control or hidden characters.");
        const window = new Window();
        window.document.body.innerHTML = html;
        const form = window.document.querySelector(path === "/tasks/add" ? ".task-composer" : ".scope-editor")!;
        // HTML parsers normalize CR and replace NUL; ordinary long Unicode drafts stay exact.
        if (!/[\r\u0000]/.test(value)) expect((form.querySelector(`[name="${field}"]`) as unknown as { value: string }).value).toBe(value);
        expect(form.querySelector('[name="acceptance"]')?.textContent).toBe("c1: Works | check");
        if (path !== "/tasks/add") expect(form.querySelector('[name="budget-usd"]')?.getAttribute("value")).toBe("12");
        await window.happyDOM.close();
        expect(store.getScope("t-edit")).toEqual(original);
        expect(store.getTask("new-task")).toBeNull();
      }
    }
  });

  test.each(["plain", "annotated", "mixed"])("legacy long %s feedback seals once across lost responses and later batches", async mode => {
    store.createTask({ id: "t-rev", title: "Mobile project switcher" }, T0);
    const ref = store.refFor("built-in", "t-rev").id;
    // Synthetic legacy CLI terms, before the new authoring limit applied.
    const goal = "  " + "Réparer 日本語 😀 e\u0301\n".repeat(300) + "  ";
    const not = "  " + "No changes 日本語 🧭 e\u0301\n".repeat(300) + "  ";
    propose(store, { taskId: "t-rev", goal, outOfScope: not, touches: ["src/y.ts"], acceptance: [{ id: "c1", statement: "Works", how: null, evidence: ["check"] }], now: T0 });
    sealScopeFixture(store, "t-rev", approverToken);
    const original = store.getScope("t-rev")!;
    const run = store.startRun({ taskRef: ref, leaseId: "l-r1", runner: "b-1", branch: "so/t-rev", worktree: "/w", now: T0, ...presented(store, ref, "builder") });
    store.stampRun(run, { scopeDigest: original.digest });
    store.recordOutcomeFacts(run, { headRevision: "headsha1234", handoff: "did it" });
    store.finishRun(run, { outcome: "built", now: T0 });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    const patch = Buffer.from("diff --git a/y b/y\n+line\n", "utf8");
    writeFileSync(join(evidenceRoot, String(run), "terminal-diff.patch"), patch);
    store.saveArtifact(
      {
        run,
        kind: "terminal-diff",
        key: `${run}/terminal-diff.patch`,
        bytesOriginal: patch.length,
        bytesStored: patch.length,
        truncated: false,
        sha256: createHash("sha256").update(patch).digest("hex"),
        capture: "git diff base head (exit 0)",
      },
      T0,
    );

    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/t-rev"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(taskHtml)?.[1] ?? "";

    const noteBody = { csrf, path: mode === "plain" ? "" : "src/y.ts", line: mode === "plain" ? "" : "12", note: "tighten the guard here — 日本語 😀 e\u0301", request: "a".repeat(32) };
    const commented = await fetch(url(`/r/${run}/comment`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(noteBody),
      redirect: "manual",
    });
    expect(commented.status).toBe(303);
    // The response was missed: retry exactly the same body.
    const retried = await fetch(url(`/r/${run}/comment`), { method: "POST", headers: { cookie }, body: new URLSearchParams(noteBody), redirect: "manual" });
    expect(retried.headers.get("location")).toBe(commented.headers.get("location"));
    expect(store.liveDiffComments(run)).toHaveLength(1);

    if (mode === "mixed") {
      const plain = await fetch(url(`/r/${run}/comment`), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, note: "Keep the project name visible.", request: "c".repeat(32) }), redirect: "manual" });
      expect(plain.status).toBe(303);
    }
    const count = mode === "mixed" ? 2 : 1;
    const runView = await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text();
    expect(runView).toContain("tighten the guard here");
    // Since a97f74b the saved notes count and one Request changes action
    // ride the comment form; the sealed batch is still the displayed list.
    expect(runView).toContain(`Saved for later · ${count}`);
    expect(runView).toContain('data-request-changes>Request changes</button>');
    expect(runView).not.toContain('class="card revision-from-comments"');
    // The form names the exact batch and source it displays (repair
    // 2026-09-14); a bare seal is an out-of-date form and is refused.
    const sealForm = revisionFormOf(runView);
    expect(sealForm.batch).toBe(store.liveDiffComments(run).map(one => one.id).join(","));
    expect(sealForm.source).toBe(store.getScope("t-rev")?.digest ?? "none");
    const bare = await fetch(url(`/r/${run}/revise`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(bare.status).toBe(400);
    expect(await bare.text()).toContain("this form is out of date");
    expect(store.revisionsFromRun(run)).toHaveLength(0);

    const revised = await fetch(url(`/r/${run}/revise`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, ...sealForm }),
      redirect: "manual",
    });
    expect(revised.status).toBe(303);
    const target = revised.headers.get("location") ?? "";

    // The new task's screen restates the batch beside its own approval —
    // and the scope is unapproved by construction.
    const child = store.getScope(revisionIdOf(target))!;
    expect(Buffer.from(child.goal)).toEqual(Buffer.from(`${goal} — apply the ${mode === "annotated" ? "annotations" : "feedback"} recorded on build #${run}; the revision brief carries the exact batch`));
    expect(Buffer.from(child.outOfScope!)).toEqual(Buffer.from(not));
    expect(child).toMatchObject({ approvedAt: null, approvedDigest: null, approvedRouteJson: null });
    expect(store.revisionSourceOf(store.lookupRef(child.taskId)!.id)).toMatchObject({ sourceTask: "t-rev", sourceRun: run });
    const taskView = await (await fetch(url(target), { headers: { cookie } })).text();
    expect(store.getTask(child.taskId)?.title).toBe("Mobile project switcher — revision");
    expect(child.taskId).toBe(`revise-t-rev-from-${count}-annotation${count === 1 ? "" : "s"}-on-build-${run}`);
    expect(taskView).toContain("Mobile project switcher");
    expect(taskView).toContain(`<a class="item current" href="/t/t-rev"><span class="t">Mobile project switcher</span></a>`);
    expect(taskView).not.toContain('task-eyebrow');
    expect(taskView).toContain(`<details class="task-status-details" id="task-diagnostics"><summary>Task options</summary><p class="meta task-identity">Task ID <span class="mono">${child.taskId}</span>`);
    expect(taskView).toContain(`href="/r/${run}">build #${run}</a>`);
    if (mode === "mixed") expect(taskView).toContain("Keep the project name visible.");
    expect(taskView).toContain("Revision feedback");
    expect(taskView).toContain("tighten the guard here");
    expect(taskView).toContain("t-rev");
    expect(taskView).toContain("approve");

    // The batch is consumed: a second seal has nothing to work with, so a
    // replayed or double submission lands on the SAME revision (package 3)
    // and mints no twin.
    const again = await fetch(url(`/r/${run}/revise`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, ...sealForm }),
      redirect: "manual",
    });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(target);
    expect(store.revisionsFromRun(run).map(one => one.id)).toEqual([revisionIdOf(target)]);
    const later = await fetch(url(`/r/${run}/comment`), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, note: "later batch 日本語", request: "b".repeat(32) }), redirect: "manual" });
    expect(later.status).toBe(303);
    const replay = await fetch(url(`/r/${run}/revise`), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, ...sealForm }), redirect: "manual" });
    expect(replay.headers.get("location")).toBe(target);
    expect(store.liveDiffComments(run).map(c => c.note)).toEqual(["later batch 日本語"]);
    expect(store.revisionsFromRun(run)).toHaveLength(1);
    const currentForm = revisionFormOf(await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text());
    const second = await fetch(url(`/r/${run}/revise`), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, ...currentForm }), redirect: "manual" });
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).not.toBe(target);
    expect(store.revisionsFromRun(run)).toHaveLength(2);
    const laterId = revisionIdOf(second.headers.get("location"));
    expect(laterId).toBe(`revise-t-rev-from-1-annotation-on-build-${run}${count === 1 ? "-2" : ""}`);
    expect(store.getTask(laterId)?.title).toBe("Mobile project switcher — revision");
    expect(store.getTask(child.taskId)?.title).toBe("Mobile project switcher — revision");
    expect(store.revisionSourceOf(store.lookupRef(laterId)!.id)).toMatchObject({ sourceTask: "t-rev", sourceRun: run });
    expect(store.getScope(laterId)?.approvedAt).toBeNull();
    expect(store.liveDiffComments(run)).toHaveLength(0);
    expect(store.getScope("t-rev")).toEqual(original);
    expect(store.getTask("t-rev")?.title).toBe("Mobile project switcher");
  });

  test("the review cockpit ranks an observed CI failure first and the plane never merges (M8.19); a red episode earns the repair draft from the cockpit and the run page (M8.18)", async () => {
    // Two published PRs: one quiet, one with an observed CI failure.
    store.createTask({ id: "t-pr1", title: "shipped one" }, T0);
    const ref1 = store.refFor("built-in", "t-pr1").id;
    const run1 = store.startRun({ taskRef: ref1, leaseId: "l-p1", runner: "b-1", branch: "so/t-pr1", worktree: "/w", now: T0, ...presented(store, ref1, "builder") });
    store.finishRun(run1, { outcome: "built", now: T0 });
    store.setTaskState("t-pr1", "done", T0);
    const pub1 = store.createPublicationIntent(
      { run: run1, taskRef: ref1, githubRepo: "ap9000/thing", remote: "origin", base: "main", head: "so/t-pr1", headSha: "a".repeat(40), bodyHash: "h1", draft: false },
      T0,
    );
    store.markPublicationPushed(pub1, T0);
    store.markPublicationOpened(pub1, 101, "https://github.com/ap9000/thing/pull/101", T0);
    // Green is a FACT the watcher saw (audit SD-4): only an observed pass
    // earns "review next".
    store.recordPublicationCheckState(pub1, "passing", T0);

    store.createTask({ id: "t-pr2", title: "shipped two" }, T0);
    const ref2 = store.refFor("built-in", "t-pr2").id;
    const run2 = store.startRun({ taskRef: ref2, leaseId: "l-p2", runner: "b-1", branch: "so/t-pr2", worktree: "/w", now: T0, ...presented(store, ref2, "builder") });
    store.finishRun(run2, { outcome: "built", now: T0 });
    store.setTaskState("t-pr2", "done", new Date(T0.getTime() - 60_000));
    const pub2 = store.createPublicationIntent(
      { run: run2, taskRef: ref2, githubRepo: "ap9000/thing", remote: "origin", base: "main", head: "so/t-pr2", headSha: "b".repeat(40), bodyHash: "h2", draft: false },
      T0,
    );
    store.markPublicationPushed(pub2, T0);
    store.markPublicationOpened(pub2, 102, "https://github.com/ap9000/thing/pull/102", T0);
    store.enqueueNotification(
      { dedupeKey: `ci:ap9000/thing:102:${"b".repeat(40)}`, kind: "ci-failed", subject: "checks failing on #102", body: "red" },
      T0,
    );

    const cookie = await login();
    const queue = await (await fetch(url("/review"), { headers: { cookie } })).text();
    // Review priority puts the OBSERVED failure first — it needs a person —
    // even though the quiet PR finished later; the quiet one is not hidden.
    const list = /<ol class="cockpit-queue-list">(.*?)<\/ol>/s.exec(queue)?.[1] ?? "";
    expect(list.indexOf("PR #102")).toBeLessThan(list.indexOf("PR #101"));
    expect(list.indexOf("PR #102")).toBeGreaterThanOrEqual(0);
    expect(list).toContain("CI is failing");
    // The failing result is selected by default; its publication card says
    // exactly what the watcher saw, and offers the repair draft.
    expect(queue).toContain('data-review-task="t-pr2"');
    expect(queue).toContain("CI failing at the last check");
    expect(queue).toContain('data-ci-observed="failing"');
    expect(queue).toContain(`action="/r/${run2}/draft-repair"`);
    expect(queue).toContain('data-next-action="draft-repair"');
    // Read-only where it matters: no merge button or link anywhere (the
    // publication words may SAY "no merge is recorded"), and the only forms
    // post to endpoints that already exist.
    expect(queue).not.toMatch(/<(?:button|a)\b[^>]*>[^<]*merge/i);
    expect(queue).not.toMatch(/action="[^"]*merge/i);
    // The quiet PR, selected by its stable link, reads the observed green.
    const quiet = await (await fetch(url("/review?result=t-pr1"), { headers: { cookie } })).text();
    expect(quiet).toContain('data-review-task="t-pr1"');
    expect(quiet).toContain("CI passing, observed");
    expect(quiet).not.toContain('data-next-action="publication"');
    expect(quiet).not.toContain("draft-repair");

    // The failing run's page carries the draft button; the quiet one does not.
    const failingRun = await (await fetch(url(`/r/${run2}`), { headers: { cookie } })).text();
    expect(failingRun).toContain("Draft a repair task");
    const quietRun = await (await fetch(url(`/r/${run1}`), { headers: { cookie } })).text();
    expect(quietRun).not.toMatch(/draft a repair task/i);

    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(failingRun)?.[1] ?? "";
    const drafted = await fetch(url(`/r/${run2}/draft-repair`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(drafted.status).toBe(303);
    expect(drafted.headers.get("location")).toBe("/t/t-pr2-ci-102");

    // One draft per task/PR, ever: the second click is a 409, not a twin.
    const twin = await fetch(url(`/r/${run2}/draft-repair`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(twin.status).toBe(409);

    // The draft is unapproved and says what it is.
    const draftPage = await (await fetch(url("/t/t-pr2-ci-102"), { headers: { cookie } })).text();
    expect(draftPage).toContain("CI failing on PR #102");
    expect(draftPage).toContain("approve");
  });

  test("the overview is live: refresh meta, building-now card, system status", async () => {
    store.createTask({ id: "t-live", title: "being built right now" }, T0);
    const ref = store.refFor("built-in", "t-live").id;
    // The runner gate (MCP spec v6): registered, repo-bound, token-proved.
    store.placeTask(ref, "/repo/main");
    register(store, { name: "builder-1", host: "host", capacity: 2, repos: ["/repo/main"], now: new Date(), newToken: () => "tok-builder-1" });
    acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 60 * 60_000 });
    store.saveWorktree({
      path: "/pool/repo/standing-orders-t-live-abc123", repo: "/repo/main", branch: "standing-orders/t-live",
      runner: "builder-1", taskRef: ref, createdAt: new Date().toISOString(),
      leasedAt: new Date().toISOString(), releasedAt: null, verified: true,
    });
    const cookie = await login();

    // Live inside the workspace: it reads itself every 10 s (forms being edited are kept), never a whole-page reload.
    const system = await (await fetch(url("/system"), { headers: { cookie } })).text();
    expect(workspaceOf(system).refreshSeconds).toBe(10);
    expect(system).not.toContain('http-equiv="refresh"');
    expect(system).toContain("1/2 building");
    expect(system).toContain("standing-orders-t-live-abc123");
    // The inbox never auto-refreshes: it can hold typed input.
    const inbox = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(workspaceOf(inbox).refreshSeconds).toBeUndefined();
    expect(inbox).not.toContain('http-equiv="refresh"');
  });

  test("tasks: list, validated filter, and atomic add from the console", async () => {
    store.createTask({ id: "t-1", title: "already here" }, T0);
    const cookie = await login();

    const list = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    expect(list).toContain("already here");

    expect((await fetch(url("/tasks?state=bogus"), { headers: { cookie } })).status).toBe(400);

    const csrf = await csrfFrom(cookie);
    const added = await post("/tasks/add", cookie, {
      csrf,
      id: "from-web",
      title: "console-born",
      goal: "one clear goal",
      acceptance: "c1: ok | manual-review",
    });
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe("/t/from-web");
    expect(store.getTask("from-web")?.title).toBe("console-born");
    expect(store.getScope("from-web")?.goal).toBe("one clear goal");

    const rejected = await post("/tasks/add", cookie, { csrf, id: "bad id!", title: "x" });
    expect(rejected.status).toBe(400);
  });

  test("scope edits carry what they saw; a stale edit is refused, an edit voids approval", async () => {
    store.createTask({ id: "t-s", title: "scoped" }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    // First proposal: saw nothing, creates the scope.
    const first = await post("/t/t-s/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "narrow goal", not: "", touches: "" });
    expect(first.status).toBe(303);
    const digest = store.getScope("t-s")?.digest ?? "";
    expect(digest).not.toBe("");

    // A second tab still holding the empty form is refused, not merged.
    const stale = await post("/t/t-s/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "rival goal", not: "", touches: "" });
    expect(stale.status).toBe(409);
    expect(store.getScope("t-s")?.goal).toBe("narrow goal");

    // Approve, then edit with the right digest: approval visibly voids.
    const page = await (await fetch(url("/t/t-s"), { headers: { cookie } })).text();
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(page)?.[1] ?? "";
    const approved = await post("/t/t-s/approve", cookie, { csrf, nonce, digest, token: approverToken });
    expect(approved.status).toBe(303);

    const edited = await post("/t/t-s/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: digest, goal: "wider goal", not: "", touches: "" });
    expect(edited.status).toBe(303);
    const after = await (await fetch(url("/t/t-s"), { headers: { cookie } })).text();
    expect(after).toContain("approved once, then rewritten");
  });

  test("consent-closed: an unreadable route, a route that cannot run, or a lapsed pre-routing approval mints no nonce and shows no password on the task page, the focused chat, or /next — recovery copy names the road", async () => {
    store.createTask({ id: "t-c", title: "closed door" }, T0);
    store.placeTask(store.refFor("built-in", "t-c").id, "/repo/main");
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-c/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "the goal", not: "", touches: "" });
    const digest = store.getScope("t-c")?.digest ?? "";
    const surfaces = async () => ({
      task: await (await fetch(url("/t/t-c"), { headers: { cookie } })).text(),
      chat: await (await fetch(url("/chat?task=t-c"), { headers: { cookie } })).text(),
      next: await (await fetch(url("/next"), { headers: { cookie } })).text(),
    });
    const inboxRow = async () => {
      const inbox = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
      const start = inbox.indexOf('href="/t/t-c"');
      return start === -1 ? "" : inbox.slice(start, inbox.indexOf("</a>", start));
    };
    const nonceOf = (html: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? null;
    const closed = (html: string) => {
      expect(nonceOf(html)).toBeNull();
      expect(html).not.toContain('type="password"');
      expect(html).not.toMatch(/approve (&amp; start|this scope)/i);
      expect(html).toContain("consent-closed");
    };
    // Open first: the door mints on every surface, and the inbox offers the act.
    let pages = await surfaces();
    expect(nonceOf(pages.task)).not.toBeNull();
    expect(nonceOf(pages.chat)).not.toBeNull();
    expect(nonceOf(pages.next)).not.toBeNull();
    expect(await inboxRow()).toContain("review &amp; approve");

    // Unreadable route bytes: closed everywhere, in words, with the road —
    // the inbox row names the attention it needs and offers no approve act.
    store.raw().prepare("UPDATE task_scope SET proposed_route_json = '{\"version\":1' WHERE task_id = 't-c'").run();
    pages = await surfaces();
    for (const html of Object.values(pages)) {
      closed(html);
      expect(html).toContain("can’t be read");
      expect(html).toContain("re-file the scope");
    }
    expect(pages.task).toContain('href="/t/t-c#scope"');
    let row = await inboxRow();
    expect(row).not.toContain("review &amp; approve");
    expect(row).toContain("needs attention: the agents on file can’t be read");
    // MISSING route bytes on a routed row (no working route at all): the
    // same closed door on every surface.
    store.raw().prepare("UPDATE task_scope SET proposed_route_json = NULL WHERE task_id = 't-c'").run();
    pages = await surfaces();
    for (const html of Object.values(pages)) closed(html);
    expect(await inboxRow()).toContain("needs attention");
    // The POST road is closed too: no nonce was rendered, so none is accepted;
    // and the seal itself refuses an unreadable route.
    const forced = await post("/t/t-c/approve", cookie, { csrf, nonce: "", digest, token: approverToken });
    expect(forced.status).toBe(409);
    expect(store.getScope("t-c")?.approvedAt ?? null).toBeNull();

    // A lapsed pre-routing row (no route era, no standing approval): closed,
    // and re-filing is the road. The primitive refuses a fresh seal on it.
    store.raw().prepare("UPDATE task_scope SET proposed_route_json = NULL, route_era = NULL, approved_at = NULL, approved_by = NULL, approved_digest = NULL WHERE task_id = 't-c'").run();
    pages = await surfaces();
    for (const html of Object.values(pages)) {
      closed(html);
      expect(html).toContain("predates agent routing");
    }
    row = await inboxRow();
    expect(row).not.toContain("review &amp; approve");
    expect(row).toContain("needs attention: this scope predates agent routing");
    expect(store.sealScopeApproval("t-c", "alex", T0)).toBe(false);

    // Re-filing routes it again: the door opens, the nonce is back.
    await post("/t/t-c/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: store.getScope("t-c")?.digest ?? "", goal: "the goal", not: "", touches: "" });
    pages = await surfaces();
    expect(nonceOf(pages.task)).not.toBeNull();
    expect(pages.task).toContain('type="password"');
    expect(nonceOf(pages.next)).not.toBeNull();
    expect(await inboxRow()).toContain("review &amp; approve");
  });

  test("consent-closed (v48 integrity): the ONE strict stored-scope projection gates every surface — an extra key, a timer-unsafe clock, an unsafe integer, a malformed chain auth mode, a route/profile parity break, or a digest mismatch mints no nonce, shows no password, offers no act, and the seal refuses the same row", async () => {
    store.createTask({ id: "t-s", title: "strict door" }, T0);
    store.placeTask(store.refFor("built-in", "t-s").id, "/repo/main");
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-s/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "the goal", not: "", touches: "" });
    const filed = store.getScope("t-s")!;
    const digest = filed.digest;
    const surfaces = async () => ({
      task: await (await fetch(url("/t/t-s"), { headers: { cookie } })).text(),
      chat: await (await fetch(url("/chat?task=t-s"), { headers: { cookie } })).text(),
      next: await (await fetch(url("/next"), { headers: { cookie } })).text(),
    });
    const nonceOf = (html: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? null;
    const raw = store.raw();
    const stored = raw.prepare("SELECT profile_json, proposed_route_json, digest FROM task_scope WHERE task_id = 't-s'").get() as { profile_json: string; proposed_route_json: string; digest: string };
    const profile = JSON.parse(stored.profile_json) as { digestVersion: number; profile: Record<string, unknown> };
    const route = JSON.parse(stored.proposed_route_json) as Record<string, unknown>;
    const restore = () => raw.prepare("UPDATE task_scope SET profile_json = ?, proposed_route_json = ?, digest = ?, proposed_chain_json = NULL WHERE task_id = 't-s'").run(stored.profile_json, stored.proposed_route_json, stored.digest);
    // Open first.
    let pages = await surfaces();
    expect(nonceOf(pages.task)).not.toBeNull();
    expect(pages.task).toContain('type="password"');
    const cases: [string, () => void, string][] = [
      ["a profile with a key this code never writes", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...profile, profile: { ...profile.profile, extra: true } })), "cannot be read exactly"],
      ["a wrapper with an extra key", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...profile, note: "x" })), "cannot be read exactly"],
      ["a clock no timer can hold", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...profile, profile: { ...profile.profile, timeoutSeconds: 2_147_484 } })), "cannot be read exactly"],
      ["an unsafe turn bound", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...profile, profile: { ...profile.profile, maxTurns: 9007199254740993 } })), "cannot be read exactly"],
      ["a fractional clock", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...profile, profile: { ...profile.profile, repairTimeoutSeconds: 1.5 } })), "cannot be read exactly"],
      ["a route with an extra key", () => raw.prepare("UPDATE task_scope SET proposed_route_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...route, extra: 1 })), "cannot be read exactly"],
      ["a route whose build leg is not the profile", () => raw.prepare("UPDATE task_scope SET proposed_route_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ ...route, legs: (route["legs"] as Record<string, unknown>[]).map(leg => (leg["phase"] === "build" ? { ...leg, model: "somewhere-else" } : leg)) })), "but the agent profile says"],
      ["a chain with a malformed auth mode", () => raw.prepare("UPDATE task_scope SET proposed_chain_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ digestVersion: 1, chain: [{ profile: profile.profile, authMode: "whatever" }] })), "fallback chain cannot be read exactly"],
      ["a chain whose entry zero is not the profile", () => raw.prepare("UPDATE task_scope SET proposed_chain_json = ? WHERE task_id = 't-s'").run(JSON.stringify({ digestVersion: 1, chain: [{ profile: { ...profile.profile, model: "somewhere-else" }, authMode: "subscription" }] })), "not its fallback chain&#39;s first entry"],
      ["a digest that does not re-derive", () => raw.prepare("UPDATE task_scope SET digest = ? WHERE task_id = 't-s'").run("0".repeat(32)), "does not re-derive"],
    ];
    for (const [label, corrupt, words] of cases) {
      restore();
      corrupt();
      pages = await surfaces();
      for (const [surface, html] of Object.entries(pages)) {
        expect(nonceOf(html), `${label} (${surface})`).toBeNull();
        expect(html, `${label} (${surface})`).not.toContain('type="password"');
        expect(html, `${label} (${surface})`).not.toMatch(/approve (&amp; start|this scope)/i);
        expect(html, `${label} (${surface})`).toContain("consent-closed");
        expect(html, `${label} (${surface})`).toContain(words);
      }
      // The seal refuses the same row, and the forced POST lands nowhere.
      expect(store.sealScopeApproval("t-s", "alex", T0), label).toBe(false);
      const current = String((raw.prepare("SELECT digest FROM task_scope WHERE task_id = 't-s'").get() as { digest: string }).digest);
      const forced = await post("/t/t-s/approve", cookie, { csrf, nonce: "", digest: current, token: approverToken });
      expect(forced.status, label).toBe(409);
      expect(store.getScope("t-s")?.approvedAt ?? null, label).toBeNull();
    }
    restore();
    pages = await surfaces();
    expect(nonceOf(pages.task)).not.toBeNull();
    expect(pages.task).toContain('type="password"');
    expect(digest).toBe(store.getScope("t-s")?.digest);
  });

  test("approval is step-up: the session alone never approves", async () => {
    store.createTask({ id: "t-a", title: "approve me" }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-a/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "the goal", not: "", touches: "" });
    const digest = store.getScope("t-a")?.digest ?? "";

    const readNonce = async (): Promise<string> => {
      const html = await (await fetch(url("/t/t-a"), { headers: { cookie } })).text();
      return /name="nonce" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? "";
    };

    // No token: refused, whatever the session says.
    const tokenless = await post("/t/t-a/approve", cookie, { csrf, nonce: await readNonce(), digest, token: "" });
    expect(tokenless.status).toBe(400);

    // Wrong token: refused by authentication, inside the transaction.
    const wrong = await post("/t/t-a/approve", cookie, { csrf, nonce: await readNonce(), digest, token: "not-it" });
    expect(wrong.status).toBe(403);

    // No nonce (a form nobody rendered): refused.
    const unrendered = await post("/t/t-a/approve", cookie, { csrf, nonce: "", digest, token: approverToken });
    expect(unrendered.status).toBe(409);

    // The real thing works — once.
    const nonce = await readNonce();
    const approved = await post("/t/t-a/approve", cookie, { csrf, nonce, digest, token: approverToken });
    expect(approved.status).toBe(303);
    expect(store.getScope("t-a")?.approvedBy).toBe("alex");

    // The spent nonce buys nothing a second time.
    const replay = await post("/t/t-a/approve", cookie, { csrf, nonce, digest, token: approverToken });
    expect(replay.status).toBe(409);
  });

  test("a bearer caller approves with its credential re-stated, no nonce ceremony", async () => {
    store.createTask({ id: "t-b", title: "api approve" }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-b/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "the goal", not: "", touches: "" });
    const digest = store.getScope("t-b")?.digest ?? "";

    const approved = await fetch(url("/t/t-b/approve"), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ digest, token: approverToken }),
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    expect(store.getScope("t-b")?.approvedBy).toBe("alex");
  });

  test("hold and unhold touch only the operator's hold — a decision's survives", async () => {
    store.createTask({ id: "t-h", title: "held" }, T0);
    const ref = store.refFor("built-in", "t-h").id;
    store.holdOwned({ taskRef: ref, ownerKind: "decision", ownerId: "9", reason: "decision:9", until: null }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const held = await post("/t/t-h/hold", cookie, { csrf, reason: "operator pause" });
    expect(held.status).toBe(303);
    expect(store.activeHolds(ref, new Date())).toHaveLength(2);

    const lifted = await post("/t/t-h/unhold", cookie, { csrf });
    expect(lifted.status).toBe(303);
    const rest = store.activeHolds(ref, new Date());
    expect(rest).toHaveLength(1);
    expect(rest[0]?.ownerKind).toBe("decision");
  });

  test("requeue and cancel are re-proved server-side, stale buttons refused", async () => {
    store.createTask({ id: "t-r", title: "stalled" }, T0);
    store.setTaskState("t-r", "failed", T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const requeued = await post("/t/t-r/requeue", cookie, { csrf });
    expect(requeued.status).toBe(303);
    expect(store.getTask("t-r")?.state).toBe("queued");

    // Not stalled anymore: the same button now refuses.
    const again = await post("/t/t-r/requeue", cookie, { csrf });
    expect(again.status).toBe(409);

    // A live claim refuses cancellation rather than being overwritten later.
    // The claim rides the runner gate (MCP spec v6): registered + placed + token.
    const ref = store.refFor("built-in", "t-r").id;
    store.placeTask(ref, "/repo/main");
    register(store, { name: "builder-1", host: "host", capacity: 2, repos: ["/repo/main"], now: new Date(), newToken: () => "tok-builder-1" });
    acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 60 * 60_000 });
    const blocked = await post("/t/t-r/cancel", cookie, { csrf });
    expect(blocked.status).toBe(409);
    expect(store.getTask("t-r")?.state).not.toBe("cancelled");
  });

  test("coordinator cancellation requires a reason and retains the rejected draft", async () => {
    const { mintCoordinator, fileCoordinatorProposal } = await import("./coordinator.js");
    const minted = mintCoordinator(store, { name: "cancel-review", repos: ["/repo/main"], by: "alex", now: T0 });
    if (!minted.ok) throw new Error("mint failed");
    const filed = fileCoordinatorProposal(store, minted.token, { repo: "/repo/main", title: "Replace the outdated export", idempotencyKey: "console-cancel" }, T0);
    if (!filed.ok) throw new Error("filing failed");
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    const path = `/t/${filed.id}`;
    const page = await (await fetch(url(path), { headers: { cookie } })).text();
    expect(page).toContain('Reason for cancellation<textarea name="reason" rows="3" maxlength="500" required>');
    expect(page).toContain('class="danger">Confirm cancellation</button>');

    const empty = await post(`${path}/cancel`, cookie, { csrf });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("Enter a reason for cancelling this coordinator filing.");
    const draft = "<superseded> " + "x".repeat(501);
    const invalid = await post(`${path}/cancel`, cookie, { csrf, reason: draft });
    expect(invalid.status).toBe(400);
    const refusedPage = await invalid.text();
    expect(refusedPage).toContain('class="arm-danger" open');
    expect(refusedPage).toContain("&lt;superseded&gt; " + "x".repeat(501));
    expect(store.getTask(filed.id)?.state).toBe("queued");
    expect(store.handle.prepare("SELECT 1 FROM coordinator_event WHERE task_id = ? AND kind = 'dismissed'").get(filed.id)).toBeUndefined();

    const cancelled = await post(`${path}/cancel`, cookie, { csrf, reason: "The smaller export task replaces this proposal." });
    expect(cancelled.status).toBe(303);
    expect(store.getTask(filed.id)?.state).toBe("cancelled");
    expect(store.handle.prepare("SELECT detail FROM coordinator_event WHERE task_id = ? AND kind = 'dismissed'").get(filed.id))
      .toMatchObject({ detail: "The smaller export task replaces this proposal." });
  });

  test("inbox: approvals link (never forms), retry acts inline and returns to the inbox", async () => {
    store.createTask({ id: "t-stalled", title: "stalled work" }, T0);
    store.setTaskState("t-stalled", "failed", T0);
    store.createTask({ id: "t-approve", title: "awaiting yes" }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-approve/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: "a goal", not: "", touches: "" });

    const inbox = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    // The approval card links to the step-up screen; it never carries a
    // password field or a nonce of its own.
    expect(inbox).toContain("Approve a scope");
    expect(inbox).toContain("awaiting yes");
    expect(inbox).not.toContain('name="nonce"');
    expect(inbox).not.toContain('type="password"');

    // Inline retry returns to the inbox, and the stall is gone from it.
    const retried = await post("/t/t-stalled/requeue", cookie, { csrf, return: "inbox" });
    expect(retried.status).toBe(303);
    expect(retried.headers.get("location")).toBe("/inbox");
    expect(store.getTask("t-stalled")?.state).toBe("queued");
  });

  test("runs paginate by cursor and a run page shows the money and the conclusion", async () => {
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    const run = seedRun(ref, 1);
    store.stampProviderStart(run, T0);
    store.recordUsage(run, { tokensIn: 10, tokensOut: 5, costUsd: 0.42 });
    store.recordOutcomeFacts(run, { handoff: "Wired the guard; tests added." });
    const handoff = handoffBytes(run, {
      conclusion: "Wired the guard; tests added.",
      changes: ["Added the payout boundary"],
      verification: ["Focused tests pass"],
      followUps: ["Watch the first production run"],
    });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(run), "handoff.json"), handoff);
    store.saveArtifact({
      run, kind: "handoff", key: `${run}/handoff.json`,
      bytesOriginal: handoff.length, bytesStored: handoff.length, truncated: false,
      sha256: createHash("sha256").update(handoff).digest("hex"), capture: "agent terminal handoff",
    }, T0);
    store.finishRun(run, { outcome: "built", reason: "clean", now: T0 });
    const cookie = await login();

    const list = await (await fetch(url("/runs"), { headers: { cookie } })).text();
    expect(list).toContain(`/r/${run}`);
    expect(list).toContain('class="badge badge-built">Built</span>');
    expect(list).not.toMatch(/<p class="row"><span class="dot /);
    const tasks = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    expect(tasks).not.toMatch(/<a class="row"[^>]*><span class="dot /);
    const task = await (await fetch(url("/t/t-1"), { headers: { cookie } })).text();
    expect(task).not.toMatch(/<p class="row"><span class="dot /);

    expect((await fetch(url("/runs?before=abc"), { headers: { cookie } })).status).toBe(400);
    expect((await fetch(url("/runs?before=9007199254740993"), { headers: { cookie } })).status).toBe(400);

    const screen = await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text();
    expect(screen).toContain("$0.42");
    expect(screen).toContain("Wired the guard; tests added.");
    // Package 3: the finished result is the ONE shared panel — the
    // handoff's conclusion leads it, its changes ride Summary, and the
    // agent's own account of its checks sits under Checks.
    expect(screen).toContain('class="card result-panel" id="result" data-result-panel data-result-place="run"');
    expect(screen).toContain("Added the payout boundary");
    expect(screen).toContain("The agent's own account");
    expect(screen).toContain("Focused tests pass");
    expect(screen).toContain("Watch the first production run");
  });

  test("a finished task and its Ask view share one concise result receipt", async () => {
    store.createTask({ id: "t-receipt", title: "make completion obvious" }, T0);
    const ref = store.refFor("built-in", "t-receipt").id;
    const run = seedRun(ref, 1);
    store.recordOutcomeFacts(run, { handoff: "Shipped the compact result receipt." });
    store.finishRun(run, { outcome: "built", reason: "clean", now: T0 });
    store.setTaskState("t-receipt", "done", T0);
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });

    const save = (kind: "handoff" | "proof" | "diff-stat" | "screenshot", name: string, content: Buffer, capture: string): number => {
      const key = `${run}/${name}`;
      writeFileSync(join(evidenceRoot, key), content);
      return store.saveArtifact({
        run, kind, key,
        bytesOriginal: content.length, bytesStored: content.length, truncated: false,
        sha256: createHash("sha256").update(content).digest("hex"), capture,
      }, T0);
    };
    save("handoff", "handoff.json", Buffer.from(JSON.stringify({ conclusion: "Shipped the compact result receipt." })), "agent terminal handoff");
    save("proof", "proof.json", Buffer.from(JSON.stringify({
      version: 1,
      criteria: [{ id: "c1", statement: "The result is clear", verdict: "met", how: "Shown on task and chat", evidence: [{ kind: "changed-path", ref: "src/serve.ts" }] }],
      checks: [{ command: "npm test", exitCode: 0, summary: "passed" }],
      changed: ["src/serve.ts"],
      caveats: ["Physical Windows presentation is still awaiting certification."],
      screenshots: [{ path: "evidence/result.png", caption: "Completed task receipt" }],
    })), "agent proof manifest");
    save("diff-stat", "diff-stat.json", Buffer.from(JSON.stringify({
      base: "a".repeat(40), head: "b".repeat(40), fileCount: 2, additions: 14, deletions: 3,
      binaryCount: 0, filesTruncated: false,
      files: [{ path: "src/serve.ts", additions: 12, deletions: 3 }, { path: "docs/PRIORITIES.md", additions: 2, deletions: 0 }],
    })), "git diff --numstat (exit 0)");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const screenshot = save("screenshot", "result.png", png, "agent-claimed screenshot at evidence/result.png (validated png)");
    store.saveProofVerdict(run, "verified", ["the approved verification command passed"], T0, [{
      id: "c1", statement: "The result is clear", requiredEvidence: ["changed-path"], state: "pass", detail: [],
      answered: [{ kind: "changed-path", ref: "src/serve.ts" }], review: null,
    }]);

    const cookie = await login();
    const task = await (await fetch(url("/t/t-receipt"), { headers: { cookie } })).text();
    expect(task).toContain('data-card-kind="result-receipt"');
    expect(task).toContain('data-work-status="assignment-needs-decision"');
    expect(task).toContain("Shipped the compact result receipt.");
    expect(task).toContain("1/1 requirements met");
    expect(task).toContain("2 files · +14 −3");
    expect(task).toContain("Physical Windows presentation is still awaiting certification.");
    expect(task).toContain(`src="/r/${run}/evidence/${screenshot}"`);
    // Package 3: one primary road — Open result — to the shared panel (the
    // run page from the task, the chat's own result view from chat).
    expect(task).toContain('href="/review?result=t-receipt">Open result →</a>');
    expect(task).toContain('href="/chat?task=t-receipt">Discuss in chat →</a>');
    expect(task).not.toContain("Hold the next attempt");

    const chat = await (await fetch(url("/chat?task=t-receipt"), { headers: { cookie } })).text();
    expect(chat).toContain('data-card-kind="result-receipt"');
    expect(chat).toContain("1/1 requirements met");
    expect(chat).toContain("2 files · +14 −3");
    expect(chat).toContain('href="/review?result=t-receipt">Open result →</a>');
    expect(chat).toContain(`href="/r/${run}">Full build record →</a>`);
    expect(chat).not.toContain('class="card task-journey"');
    expect(chat).toContain('data-work-status="assignment-needs-decision"');
    expect(chat).not.toContain("Discuss in chat →");
    expect(chat).not.toContain("Get this task running");
  });

  test("run evidence: own artifacts serve, foreign artifacts and foreign repos are not found", async () => {
    store.createTask({ id: "t-1", title: "ours" }, T0);
    const ours = store.refFor("built-in", "t-1").id;
    store.placeTask(ours, "/repo/main");
    store.createTask({ id: "t-2", title: "theirs" }, T0);
    const theirs = store.refFor("built-in", "t-2").id;
    store.placeTask(theirs, "/repo/other");

    const mine = seedRun(ours, 1);
    const foreign = seedRun(theirs, 2);
    mkdirSync(join(evidenceRoot, String(mine)), { recursive: true });
    const content = Buffer.from("diff --git a/y b/y\n", "utf8");
    writeFileSync(join(evidenceRoot, String(mine), "diff.patch"), content);
    const artifact = store.saveArtifact(
      {
        run: mine,
        kind: "diff",
        key: `${mine}/diff.patch`,
        bytesOriginal: content.length,
        bytesStored: content.length,
        truncated: false,
        sha256: createHash("sha256").update(content).digest("hex"),
        capture: "git diff (exit 0)",
      },
      T0,
    );
    const cookie = await login();

    const served = await fetch(url(`/r/${mine}/evidence/${artifact}`), { headers: { cookie } });
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("diff --git");

    // The same artifact through the wrong run: not found, not explained.
    expect((await fetch(url(`/r/${foreign}/evidence/${artifact}`), { headers: { cookie } })).status).toBe(404);
    // A run of another repo's task does not exist on this console at all.
    expect((await fetch(url(`/r/${foreign}`), { headers: { cookie } })).status).toBe(404);
  });

  test("GET never mutates: an overdue decision reads as overdue while the row stays open", async () => {
    store.createTask({ id: "t-1", title: "the work" }, T0);
    const ref = store.refFor("built-in", "t-1").id;
    const run = seedRun(ref, 1);
    store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "r",
        question: "past due?",
        options: [{ id: "a", label: "a", consequence: "c", reversible: true }],
        recommendation: "a",
        deadline: new Date(Date.now() - 60_000).toISOString(),
      },
      T0,
    );
    const cookie = await login();

    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(home).toContain("overdue");
    // The page derived it; nothing wrote it.
    expect(store.listDecisions("open")).toHaveLength(1);
  });

  test("one gate for every mutation: content type, origin, csrf, and no duplicated fields", async () => {
    store.createTask({ id: "t-g", title: "gated" }, T0);
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    // Wrong content type.
    const typed = await fetch(url("/t/t-g/hold"), {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "text/plain" },
      body: "reason=x",
      redirect: "manual",
    });
    expect(typed.status).toBe(415);

    // Foreign origin.
    const foreign = await fetch(url("/t/t-g/hold"), {
      method: "POST",
      headers: { cookie, origin: "http://evil.example" },
      body: new URLSearchParams({ csrf, reason: "x" }),
      redirect: "manual",
    });
    expect(foreign.status).toBe(403);

    // Missing csrf.
    const bare = await fetch(url("/t/t-g/hold"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ reason: "x" }),
      redirect: "manual",
    });
    expect(bare.status).toBe(403);

    // A smuggled second csrf value.
    const doubled = await fetch(url("/t/t-g/hold"), {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf=${csrf}&csrf=${csrf}&reason=x`,
      redirect: "manual",
    });
    expect(doubled.status).toBe(400);

    expect(store.activeHolds(store.refFor("built-in", "t-g").id, new Date())).toHaveLength(0);
  });

  test("every database-derived string renders inert, table-driven", async () => {
    const probe = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
    store.createTask({ id: "t-x", title: `title ${probe}` }, T0);
    const ref = store.refFor("built-in", "t-x").id;
    store.hold(ref, `hold ${probe}`, null, T0);
    const run = seedRun(ref, 1);
    store.recordOutcomeFacts(run, { handoff: `conclusion ${probe}` });
    store.finishRun(run, { outcome: "failed", reason: `reason ${probe}`, now: T0 });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await post("/t/t-x/scope", cookie, { csrf, acceptance: "c1: ok | manual-review", sawDigest: "", goal: `goal ${probe}`, not: `not ${probe}`, touches: `touch-${probe}` });

    for (const path of ["/", "/inbox", "/tasks", "/t/t-x", "/runs", `/r/${run}`]) {
      const html = await (await fetch(url(path), { headers: { cookie } })).text();
      expect(html, path).not.toContain("<script>alert(1)");
      expect(html, path).not.toContain("<img src=x");
    }
  });

  test("a task id that is hostile as a URL is linked encoded and resolved decoded", async () => {
    // Legacy CLI ids are free-form; the console must not let one break a path.
    store.createTask({ id: "a b?c=1", title: "awkward id" }, T0);
    const cookie = await login();

    const list = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    expect(list).toContain(`/t/a%20b%3Fc%3D1`);

    const screen = await fetch(url("/t/a%20b%3Fc%3D1"), { headers: { cookie } });
    expect(screen.status).toBe(200);
    expect(await screen.text()).toContain("awkward id");
  });

  test("caps reads the same gaps the brief computes, and admits being read-only", async () => {
    store.saveCapability({
      repo: "/repo/main",
      kind: "cli",
      name: "gh",
      probe: "gh auth status",
      status: "unprobed",
      addedBy: "alex",
      createdAt: T0.toISOString(),
      lastVerifiedAt: null,
      verifiedBy: null,
      lastResult: null,
      expiresAt: null,
    });
    const cookie = await login();

    const caps = await (await fetch(url("/caps"), { headers: { cookie } })).text();
    expect(caps).toContain("cli:gh");
    expect(caps).toContain("unprobed");
    expect(caps).toContain("Read-only");
  });
});

describe("console v2: projects, the ceiling, and the workspace", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let repoA: string;
  let repoB: string;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const csrfFrom = async (cookie: string): Promise<string> => {
    const html = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf");
    return match[1] as string;
  };

  const post = (path: string, cookie: string, fields: Record<string, string>) =>
    fetch(url(path), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-v2-ev-"));
    // Two real directories: A is inside the ceiling, B is not.
    repoA = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-v2-repoA-")));
    repoB = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-v2-repoB-")));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    server = createDecisionServer({ store, evidenceRoot, repos: [repoA] });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    for (const dir of [evidenceRoot, repoA, repoB]) rmSync(dir, { recursive: true, force: true });
  });

  const seedTaskIn = (id: string, repo: string) => {
    store.createTask({ id, title: `work ${id}` }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo);
    return ref;
  };

  const seedDecisionIn = (id: string, repo: string): { decision: number; run: number } => {
    const ref = seedTaskIn(id, repo);
    const run = store.startRun({
      taskRef: ref, leaseId: `lease-${id}`, runner: "b1",
      branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: T0,
      ...presented(store, ref, "builder"),
    });
    const decision = store.saveDecision(
      {
        run, urgency: "blocking", recap: "r", question: `${id}?`,
        options: [{ id: "a", label: "a", consequence: "c", reversible: true }],
        recommendation: "a",
      },
      T0,
    );
    return { decision, run };
  };

  test("the sidebar shell renders with the sole configured project open", async () => {
    const cookie = await login();
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(home).toContain('class="side"');
    expect(home).toContain('<a href="/projects" aria-label="Projects" title="Projects"><span class="glyph"><svg');
    expect(home).toContain("+ New task");
    // The sole configured repo opened itself — no forced detour.
    expect(home).toContain("inbox");
    expect(home).toContain(">Tasks<");
  });

  test("a task outside the ceiling does not exist: page, mutations, list", async () => {
    seedTaskIn("t-in", repoA);
    seedTaskIn("t-out", repoB);
    const cookie = await login();

    expect((await fetch(url("/t/t-out"), { headers: { cookie } })).status).toBe(404);
    const csrf = await csrfFrom(cookie);
    expect((await post("/t/t-out/hold", cookie, { csrf, reason: "x" })).status).toBe(404);

    const list = await (await fetch(url("/tasks"), { headers: { cookie } })).text();
    expect(list).toContain("t-in");
    expect(list).not.toContain("t-out");
  });

  test("a decision outside the ceiling cannot be read, answered, or bled through evidence", async () => {
    const inside = seedDecisionIn("t-in", repoA);
    const outside = seedDecisionIn("t-out", repoB);
    const cookie = await login();

    expect((await fetch(url(`/d/${inside.decision}`), { headers: { cookie } })).status).toBe(200);
    expect((await fetch(url(`/d/${outside.decision}`), { headers: { cookie } })).status).toBe(404);

    const csrf = await csrfFrom(cookie);
    const answered = await post(`/d/${outside.decision}/answer`, cookie, { csrf, choice: "a" });
    expect(answered.status).toBe(404);
    expect(store.getDecision(outside.decision)?.state).toBe("open");

    // Evidence linked to the out-of-ceiling decision is not served.
    mkdirSync(join(evidenceRoot, String(outside.run)), { recursive: true });
    const secret = Buffer.from("their diff", "utf8");
    writeFileSync(join(evidenceRoot, String(outside.run), "diff.patch"), secret);
    const artifact = store.saveArtifact(
      {
        run: outside.run, kind: "diff", key: `${outside.run}/diff.patch`,
        bytesOriginal: secret.length, bytesStored: secret.length, truncated: false,
        sha256: createHash("sha256").update(secret).digest("hex"), capture: "git diff (exit 0)",
      },
      T0,
    );
    store.linkEvidence(outside.decision, artifact);
    expect((await fetch(url(`/d/${outside.decision}/evidence/${artifact}`), { headers: { cookie } })).status).toBe(404);
  });

  test("opening a project: outside the ceiling refused, inside opens and is remembered", async () => {
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const denied = await post("/projects/open", cookie, { csrf, path: repoB });
    expect(denied.status).toBe(403);

    const ghost = await post("/projects/open", cookie, { csrf, path: "/no/such/place" });
    expect(ghost.status).toBe(400);

    // repoA is configured but not yet a git repo — the opener requires one:
    // configuration authorizes, only being a repository makes it openable.
    const notGit = await post("/projects/open", cookie, { csrf, path: repoA });
    expect(notGit.status).toBe(400);

    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repoA });
    const opened = await post("/projects/open", cookie, { csrf, path: repoA });
    expect(opened.status).toBe(303);
    expect(store.listProjects()).toHaveLength(1);
    expect(store.listProjects()[0]?.name).toBe(repoA.split("/").pop());
  });

  test("Add a project and Remove from Toolroll go through the shared admission: ledger, idempotency, restricted accounts", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repoA });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    const added = () => store.actionLedger({ repos: [repoA] }).filter(one => one.action === "project added");

    // An account limited to other projects cannot widen its own list by opening one.
    const robin = addApprover(store, "robin", T0, { name: "alex", token: approverToken });
    if (!robin.ok) throw new Error("robin");
    expect(store.setAccountProjects("robin", ["/repo/elsewhere"], "alex", T0)).toEqual({ ok: true });
    const robinIn = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name: "robin", token: robin.token }), redirect: "manual" });
    const robinCookie = (robinIn.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect((await post("/projects/open", robinCookie, { csrf: await csrfFrom(robinCookie), path: repoA })).status).toBe(403);
    expect(store.listProjects()).toHaveLength(0);

    expect((await post("/projects/open", cookie, { csrf, path: repoA })).status).toBe(303);
    expect((await post("/projects/open", cookie, { csrf, path: repoA })).status).toBe(303);
    expect(added()).toEqual([expect.objectContaining({ actor: "alex", detail: "from console", source: "access", outcome: "added" })]);
    expect((await fetch(url(`/settings/tools?repo=${encodeURIComponent(repoA)}`), { headers: { cookie } })).status).toBe(200);
    expect(await (await fetch(url(`/settings/project?repo=${encodeURIComponent(repoA)}`), { headers: { cookie } })).text()).toContain("Remove from Toolroll");

    // Remove: off the lists, its saved work kept, and back with Add a project.
    seedTaskIn("t-kept", repoA);
    const removed = await post("/projects/remove", cookie, { csrf, repo: repoA });
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toContain("said=");
    expect(store.listProjects()).toHaveLength(0);
    expect(store.lookupRef("t-kept")?.repo).toBe(repoA);
    expect(store.actionLedger({ repos: [repoA] }).some(one => one.action === "project removed" && one.actor === "alex" && one.detail === "from console")).toBe(true);
    expect((await fetch(url(`/settings/tools?repo=${encodeURIComponent(repoA)}`), { headers: { cookie } })).status).toBe(403);
    expect((await post("/projects/remove", robinCookie, { csrf: await csrfFrom(robinCookie), repo: repoA })).status).toBe(403);
    expect((await post("/projects/open", cookie, { csrf, path: repoA })).status).toBe(303);
    expect(added()).toHaveLength(2);
    expect((await fetch(url(`/settings/tools?repo=${encodeURIComponent(repoA)}`), { headers: { cookie } })).status).toBe(200);
  });

  test("a stale tab's create lands in nobody's project: the revision refuses it", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repoA });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    // A form rendered now carries revision 1; opening a project bumps it.
    const staleRevision = "1";
    await post("/projects/open", cookie, { csrf, path: repoA });

    const created = await post("/tasks/add", cookie, {
      csrf, title: "stale tab work", projectRevision: staleRevision,
    });
    expect(created.status).toBe(409);
    expect(store.listTasks()).toHaveLength(0);
  });

  test("a blank id slugs from the title and the create lands on the approve card", async () => {
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const created = await post("/tasks/add", cookie, {
      csrf, title: "Add a Rate Limiter!", goal: "sliding windows on the public api",
      acceptance: "c1: ok | manual-review",
    });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/t/add-a-rate-limiter");

    const screen = await (await fetch(url("/t/add-a-rate-limiter"), { headers: { cookie } })).text();
    expect(screen).toContain('class="approve-form approval-sheet"');
    // The master pane lists it, marked current.
    expect(screen).toContain('class="item current"');
  });

  test("a bearer caller is confined by the same ceiling", async () => {
    seedTaskIn("t-in", repoA);
    seedTaskIn("t-out", repoB);
    const auth = { authorization: `Bearer alex:${approverToken}` };

    // Naming an out-of-ceiling project is a refusal, not a fallback.
    const denied = await fetch(url("/tasks"), { headers: { ...auth, "x-standing-orders-project": repoB } });
    expect(denied.status).toBe(403);

    // And the resource ceiling holds without any header games.
    expect((await fetch(url("/t/t-out"), { headers: auth })).status).toBe(404);
    expect((await fetch(url("/t/t-in"), { headers: auth })).status).toBe(200);

    // Opening a project is a browser act.
    const open = await fetch(url("/projects/open"), {
      method: "POST", headers: auth, body: new URLSearchParams({ path: repoA }), redirect: "manual",
    });
    expect(open.status).toBe(403);
  });

  test("a v5 database opens as v6 with the project registry usable", async () => {
    // The in-memory store in this suite was born v6; prove the additive
    // migration by opening a file store twice across the version bump path.
    const dir = mkdtempSync(join(tmpdir(), "standing-orders-v2-mig-"));
    try {
      const first = openStore(join(dir, "q.db"));
      first.createTask({ id: "t-old", title: "pre-existing" }, T0);
      first.close();
      const again = openStore(join(dir, "q.db"));
      again.upsertProject("/some/where", "where", T0);
      expect(again.listProjects()).toHaveLength(1);
      expect(again.getTask("t-old")?.title).toBe("pre-existing");
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the board — the pipeline as lanes, live in place", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-board-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("every lane renders, and a building card carries worker, model, elapsed, and workspace", async () => {
    const now = new Date();
    store.createTask({ id: "t-live", title: "being built" }, T0);
    const ref = store.refFor("built-in", "t-live").id;
    // Placed BEFORE the scope seals it in place; the claiming runner is
    // registered and repo-bound (the runner gate, MCP spec v6).
    store.placeTask(ref, "/repo/main");
    register(store, { name: "builder-1", host: "here", capacity: 2, repos: ["/repo/main"], now: T0, newToken: () => "tok-builder-1" });
    sealScopeFixture(store, "t-live", approverToken, "build it");
    const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(now.getTime() - 12 * 60_000), ttlMs: 60 * 60_000 });
    if (!taken.ok) throw new Error("claim refused");
    store.startRun({
      taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1",
      branch: "standing-orders/t-live", worktree: "/pool/standing-orders-t-live-abc",
      // The sealed route's exact model — any other opens no run (v48).
      model: "sonnet", now: new Date(now.getTime() - 12 * 60_000),
      ...presented(store, ref, "builder"),
    });
    store.createTask({ id: "t-ready", title: "all set" }, T0);
    store.saveScope({
      taskId: "t-ready", goal: "go", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d2",
      approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: "d2",
    });
    store.createTask({ id: "t-bare", title: "no scope yet" }, T0);

    const cookie = await login();
    const board = await (await fetch(url("/board"), { headers: { cookie } })).text();
    for (const lane of ["needs you", "queued", "waiting", "building", "done recently"]) {
      expect(board).toContain(lane);
    }
    expect(board).toContain("being built");
    // The building card (board pass): a live strip with the stage and the
    // clock — never a percent — then mono facts: worker, model, branch and
    // workspace. Lanes are sections that fold; a lane with cards is open.
    const card = /<a class="lane-card building".*?<\/a>/s.exec(board)?.[0] ?? "";
    expect(card).toMatch(/<span class="live-line"><span class="stage">[^<]+<\/span><span class="clock">1[0-9]m<\/span><\/span>/);
    expect(card).not.toMatch(/\d+%/);
    expect(card).toContain('<span class="id">t-live</span><span class="t">');
    expect(card).toContain('<span class="fact"><span class="k">worker</span><span class="v">builder-1</span></span>');
    expect(card).toContain('<span class="fact"><span class="k">model</span><span class="v">sonnet</span></span>');
    expect(card).toContain("standing-orders-t-live-abc");
    expect(board).toContain('<details class="lane lane-building" open><summary><h2>building');
    expect(board).toContain('<details class="lane lane-waiting"><summary><h2>waiting'); // empty: folded
    expect(board).toContain("all set");
    expect(board).toContain("write its scope");
    // Read-only by construction: an auto-refreshing surface never holds a
    // form, a nonce, or a password field — the polled region is form-free;
    // the chrome's project switcher lives outside it and is never swapped.
    expect(board.slice(board.indexOf('<div id="board-region">'), board.indexOf('id="board-region-stamp"'))).not.toContain("<form");
    expect(board).not.toContain('type="password"');
  });

  test("the board's CSP admits exactly its own script: fresh nonce per response, never unsafe-inline", async () => {
    const cookie = await login();
    const first = await fetch(url("/board"), { headers: { cookie } });
    const csp = first.headers.get("content-security-policy") ?? "";
    const html = await first.text();
    const match = /script-src 'nonce-([^']+)'/.exec(csp);
    expect(match).not.toBeNull();
    expect(html).toContain(`<script nonce="${match?.[1]}">`);
    expect(csp).not.toMatch(/script-src [^;]*unsafe-inline/);
    expect(csp).toContain("connect-src 'self'");

    const second = await fetch(url("/board"), { headers: { cookie } });
    const secondMatch = /script-src 'nonce-([^']+)'/.exec(second.headers.get("content-security-policy") ?? "");
    expect(secondMatch?.[1]).not.toBe(match?.[1]);

    // Pages without a poller carry the chrome layer's nonce but earn NO
    // network: script-src yes, connect-src no (arc 4, finding 24).
    const inbox = await fetch(url("/inbox"), { headers: { cookie } });
    const inboxCsp = inbox.headers.get("content-security-policy") ?? "";
    expect(inboxCsp).toMatch(/script-src 'nonce-/);
    // v28: the chrome layer itself fetches (the attended beat), so every
    // chrome page carries connect-src 'self' — still same-origin only.
    expect(inboxCsp).toContain("connect-src 'self'");
  });

  test("the fragment is the region alone, behind the same auth", async () => {
    const cookie = await login();
    const fragment = await fetch(url("/board?fragment=1"), { headers: { cookie } });
    const body = await fragment.text();
    expect(body).toContain('class="board"');
    expect(body).not.toContain("<html");
    expect(body).not.toContain("<script");

    const anonymous = await fetch(url("/board?fragment=1"), { redirect: "manual" });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe("/login");
  });

  test("new implementation tasks recommend and request planning before approval", async () => {
    const cookie = await login();
    const form = await (await fetch(url("/tasks/new"), { headers: { cookie } })).text();
    expect(form).toContain("What should get done?");
    expect(form).toContain('class="card task-composer"');
    expect(form).toContain("The planner will inspect the repository");
    expect(form).toContain('<details class="task-options">');
    expect(form.indexOf('name="title"')).toBeLessThan(form.indexOf('<details class="task-options">'));
    expect(form.indexOf('name="goal"')).toBeGreaterThan(form.indexOf('<details class="task-options">'));
    expect(form).toContain('name="plan-first" value="1" checked');
    expect(form).toContain("Plan task →");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(form)?.[1] as string;
    const revision = /name="projectRevision" value="([0-9]+)"/.exec(form)?.[1] as string;
    const created = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({
        csrf,
        projectRevision: revision,
        "planning-policy": "choice",
        "plan-first": "1",
        id: "planned-from-create",
        title: "Fix a small label",
      }),
      redirect: "manual",
    });
    expect(created.status).toBe(303);
    expect(store.lookupRef("planned-from-create")?.plan).toBe("requested");
    const page = await (await fetch(url("/t/planned-from-create"), { headers: { cookie } })).text();
    expect(page).toContain("Planning requested");
    expect(page).not.toContain("approval-sheet");
    expect(page).toContain('<details class="section" id="scope"><summary><h2>Scope</h2></summary>');
  });

  test("a requested plan blocks an approval submitted from a stale form", async () => {
    store.createTask({ id: "stale-plan-approval", title: "stale approval" }, T0);
    const ref = store.refFor("built-in", "stale-plan-approval").id;
    store.placeTask(ref, "/repo/main");
    propose(store, {
      taskId: "stale-plan-approval",
      goal: "implement the approved shape",
      now: T0,
    });

    const cookie = await login();
    const page = await (await fetch(url("/t/stale-plan-approval"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? "";
    const digest = /name="digest" value="([0-9a-f]{32,64})"/.exec(page)?.[1] ?? "";
    const nonce = /name="nonce" value="([^"]+)"/.exec(page)?.[1] ?? "";
    expect(digest).not.toBe("");
    expect(nonce).not.toBe("");

    store.requestPlan(ref, T0);
    const response = await fetch(url("/t/stale-plan-approval/approve"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, digest, nonce, token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("approval is blocked while planning is in progress");
    expect(store.getScope("stale-plan-approval")?.approvedAt).toBeNull();
  });

  test("plan first: the console asks, the board says planning, the draft returns for review", async () => {
    store.createTask({ id: "t-plan", title: "needs thought" }, T0);
    const ref = store.refFor("built-in", "t-plan").id;
    store.placeTask(ref, "/repo/main");

    const cookie = await login();
    const before = await (await fetch(url("/t/t-plan"), { headers: { cookie } })).text();
    expect(before).toContain("plan first");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(before)?.[1] ?? "";

    const asked = await fetch(url("/t/t-plan/plan"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf }),
      redirect: "manual",
    });
    expect(asked.status).toBe(303);
    expect(store.refFor("built-in", "t-plan").plan).toBe("requested");

    const screen = await (await fetch(url("/t/t-plan"), { headers: { cookie } })).text();
    expect(screen).toContain("Planning requested");
    expect(screen).not.toContain(">plan first<");
    expect(screen).not.toContain("approval-sheet");

    const board = await (await fetch(url("/board"), { headers: { cookie } })).text();
    expect(board).toContain("planning next");

    // The draft arrives: proposed scope + plan state; the board flips to
    // review, and the task screen shows the document with the approve card.
    store.saveScope({
      taskId: "t-plan", goal: "The negotiated goal", outOfScope: null, touches: [], acceptance: [],
      proposedAt: new Date().toISOString(), digest: "dg-negotiated",
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    store.setPlanState(ref, "drafted");
    const run = store.startRun({
      taskRef: ref, leaseId: "plan-lease", runner: "b", role: "planner",
      branch: "standing-orders-plan/t-plan", worktree: "/pool/plan", now: new Date(),
      ...presented(store, ref, "planner"),
    });
    const content = Buffer.from([
      "## Approach",
      "Use the existing task flow and keep the change narrow.",
      "## Milestones",
      "1. Do the thing carefully.",
      "2. Verify the result.",
      "## Dependencies",
      "- None found.",
      "## Risks",
      "- The first pass may miss an edge case; cover it with a focused check.",
      "## Proof",
      "- Run the focused integration check.",
      "",
    ].join("\n"), "utf8");
    const { mkdirSync: mkdirS, writeFileSync: writeS } = await import("node:fs");
    mkdirS(join(evidenceRoot, String(run)), { recursive: true });
    writeS(join(evidenceRoot, String(run), "plan.md"), content);
    store.saveArtifact({
      run, kind: "plan", key: `${run}/plan.md`,
      bytesOriginal: content.length, bytesStored: content.length, truncated: false,
      sha256: createHash("sha256").update(content).digest("hex"),
      capture: "planner handoff (verified tree)",
    }, new Date());
    store.finishRun(run, { outcome: "built", reason: "plan-drafted", now: new Date() });

    const review = await (await fetch(url("/board"), { headers: { cookie } })).text();
    expect(review).toContain("review the plan");
    const drafted = await (await fetch(url("/t/t-plan"), { headers: { cookie } })).text();
    expect(drafted).toContain("Do the thing carefully.");
    expect(drafted).toContain("How the agent will tackle this");
    expect(drafted).toContain("risks &amp; mitigations");
    expect(drafted).toContain("proof of done");
    expect(drafted).toContain("Edit plan");
    // Editing the plan in place keeps a road to the written steps' own editor.
    expect(drafted).toContain('<button type="submit" form="plan-editor-form">Save plan</button><a class="approval-link" href="#plan-edit">Edit steps</a>');
    expect(drafted).toContain('id="plan-edit"');
    expect(drafted).toContain('class="approve-form approval-sheet"');
    expect(drafted).toContain("The negotiated goal");
    expect(drafted).not.toContain('data-card-kind="result-receipt"');

    // The operator can refine the durable plan before approval. A form
    // opened on the previous artifact cannot approve the new revision.
    const sawPlan = /name="saw-plan" value="([0-9a-f]{64})"/.exec(drafted)?.[1] ?? "";
    const staleDigest = /name="digest" value="([0-9a-f]{32,64})"/.exec(drafted)?.[1] ?? "";
    const staleNonce = /name="nonce" value="([^"]+)"/.exec(drafted)?.[1] ?? "";
    expect(sawPlan).not.toBe("");
    const revisedDocument = content.toString("utf8").replace("2. Verify the result.", "2. Verify the result on desktop and mobile.");
    const edited = await fetch(url("/t/t-plan/plan-edit"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, "saw-plan": sawPlan, "plan-document": revisedDocument }),
      redirect: "manual",
    });
    expect(edited.status).toBe(303);
    expect((await (await fetch(url("/t/t-plan"), { headers: { cookie } })).text())).toContain("desktop and mobile");

    const staleApproval = await fetch(url("/t/t-plan/approve"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, digest: staleDigest, nonce: staleNonce, token: approverToken }),
      redirect: "manual",
    });
    expect(staleApproval.status).toBe(409);
    expect(store.getScope("t-plan")?.approvedAt).toBeNull();
  });

  test("adaptive execution plans: the same live milestone progress and revision ledger render on the task page and the focused chat", async () => {
    store.createTask({ id: "t-adapt", title: "adapting under evidence" }, T0);
    const ref = store.refFor("built-in", "t-adapt").id;
    store.placeTask(ref, "/repo/main");
    store.saveScope({
      taskId: "t-adapt", goal: "ship the guarded change", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d-adapt",
      approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: "d-adapt",
    });

    // Revision 1: the planner's own artifact — no plan_revision row yet,
    // exactly like every task filed before this feature (c1).
    const plannerRun = store.startRun({
      taskRef: ref, leaseId: "plan-lease-adapt", runner: "b", role: "planner",
      branch: "standing-orders-plan/t-adapt", worktree: "/pool/plan-adapt", now: T0,
      ...presented(store, ref, "planner"),
    });
    const rev1Text = [
      "## Approach", "Guard the change behind a feature flag.",
      "## Milestones", "1. Add the guard.", "2. Wire the call sites.",
      "## Dependencies", "- None found.",
      "## Risks", "- The flag default might already be flipped; check config first.",
      "## Proof", "- Run the focused suite.", "",
    ].join("\n");
    const rev1Content = Buffer.from(rev1Text, "utf8");
    mkdirSync(join(evidenceRoot, String(plannerRun)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(plannerRun), "plan.md"), rev1Content);
    const rev1Sha = createHash("sha256").update(rev1Content).digest("hex");
    store.saveArtifact({
      run: plannerRun, kind: "plan", key: `${plannerRun}/plan.md`,
      bytesOriginal: rev1Content.length, bytesStored: rev1Content.length, truncated: false,
      sha256: rev1Sha, capture: "planner handoff (verified tree)",
    }, T0);
    store.finishRun(plannerRun, { outcome: "built", reason: "plan-drafted", now: T0 });

    // A builder run files a bounded, evidence-linked, plan-only revision:
    // the repository showed the flag default was already flipped, so the
    // first milestone is unnecessary (c3, c4's plan-only path).
    sealScopeFixture(store, "t-adapt", approverToken);
    const buildRun = store.startRun({
      taskRef: ref, leaseId: "build-lease-adapt", runner: "b", role: "builder",
      branch: "standing-orders/t-adapt", worktree: "/pool/build-adapt", now: T0,
      ...presented(store, ref, "builder"),
    });
    const rev2Text = rev1Text
      .replace("1. Add the guard.", "1. Confirm the flag default (already flipped).")
      .replace("- The flag default might already be flipped; check config first.", "- None found — the default was already flipped, confirmed in config/flags.json.");
    const rev2Parsed = parseExecutionPlanDocument(rev2Text);
    if (!rev2Parsed.ok) throw new Error("fixture plan malformed");
    const milestones = milestonesOf(rev2Parsed.document);
    const rev2Content = Buffer.from(rev2Text, "utf8");
    mkdirSync(join(evidenceRoot, String(buildRun)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(buildRun), "revision.md"), rev2Content);
    const rev2Sha = createHash("sha256").update(rev2Content).digest("hex");
    const rev2ArtifactId = store.saveArtifact({
      run: buildRun, kind: "plan", key: `${buildRun}/revision.md`,
      bytesOriginal: rev2Content.length, bytesStored: rev2Content.length, truncated: false,
      sha256: rev2Sha, capture: "builder-filed revision proposal",
    }, T0);
    const rev2Id = store.insertPlanRevision({
      taskRef: ref, revision: 2, artifact: rev2ArtifactId, parentHash: rev1Sha,
      reason: "config/flags.json already flips the default — the guard milestone is unnecessary",
      evidenceLink: "config/flags.json", author: `builder:${buildRun}`, originRun: buildRun,
      kind: "builder-proposal", authorityKind: "plan-only", authorityDigest: "digest-plan-only",
      changedFields: [], status: "applied",
    }, T0);
    store.setRunPlanRevision(buildRun, rev2Id, "digest-plan-only");
    store.insertRunCheckpoint({
      run: buildRun, taskRef: ref, planRevision: rev2Id,
      snapshot: {
        revisionHash: rev2Sha,
        milestones: [
          { id: milestones[0]?.id as string, state: "completed", note: "confirmed in config" },
          { id: milestones[1]?.id as string, state: "current", note: null },
        ],
      },
    }, T0);

    const cookie = await login();
    const taskPage = await (await fetch(url("/t/t-adapt"), { headers: { cookie } })).text();
    expect(taskPage).toContain("plan revision 2");
    expect(taskPage).toContain("the guard milestone is unnecessary");
    expect(taskPage).toContain("config/flags.json");
    expect(taskPage).toContain("Confirm the flag default (already flipped).");
    expect(taskPage).toContain("confirmed in config");
    expect(taskPage).toContain("milestone-completed");
    expect(taskPage).toContain("milestone-current");
    expect(taskPage).not.toContain("Approve changes &amp; continue");
    expect(taskPage.indexOf("Build progress")).toBeLessThan(taskPage.indexOf("execution plan"));

    const chatPage = await (await fetch(url(`/chat?task=t-adapt`), { headers: { cookie } })).text();
    expect(chatPage).toContain("plan revision 2");
    expect(chatPage).toContain("the guard milestone is unnecessary");
    expect(chatPage).toContain("Confirm the flag default (already flipped).");
    expect(chatPage).toContain("milestone-completed");

    // Now an authority-changing proposal arrives (the defensive path, c4):
    // the world moved under the run, so it stays paused for a person.
    const buildRun2 = store.startRun({
      taskRef: ref, leaseId: "build-lease-adapt-2", runner: "b", role: "builder",
      branch: "standing-orders/t-adapt-2", worktree: "/pool/build-adapt-2", now: T0,
      ...presented(store, ref, "builder"),
    });
    const rev3Content = Buffer.from(rev2Text.replace("## Approach", "## Approach\nRevised once more."), "utf8");
    mkdirSync(join(evidenceRoot, String(buildRun2)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(buildRun2), "revision.md"), rev3Content);
    const rev3ArtifactId = store.saveArtifact({
      run: buildRun2, kind: "plan", key: `${buildRun2}/revision.md`,
      bytesOriginal: rev3Content.length, bytesStored: rev3Content.length, truncated: false,
      sha256: createHash("sha256").update(rev3Content).digest("hex"), capture: "builder-filed revision proposal",
    }, T0);
    const rev3Id = store.insertPlanRevision({
      taskRef: ref, revision: 3, artifact: rev3ArtifactId, parentHash: rev2Sha,
      reason: "the touches list no longer covers the file this fix needs",
      evidenceLink: "src/guard.ts", author: `builder:${buildRun2}`, originRun: buildRun2,
      kind: "builder-proposal", authorityKind: "authority-change", authorityDigest: "digest-changed",
      changedFields: ["signed-scope"], status: "blocked",
    }, T0);
    store.holdOwned({ taskRef: ref, ownerKind: "revision", ownerId: String(rev3Id), reason: "a plan revision changed signed scope — accept or reject it", until: null }, T0);

    const pendingPage = await (await fetch(url("/t/t-adapt"), { headers: { cookie } })).text();
    expect(pendingPage).toContain("The agent recommends a plan change");
    expect(pendingPage).toContain("changes the work you approved");
    expect(pendingPage).toContain("the touches list no longer covers");
    expect(pendingPage).toContain("Approve changes &amp; continue");
    expect(pendingPage).toContain("Keep current plan");
    const pendingCsrf = /name="csrf" value="([0-9a-f]{64})"/.exec(pendingPage)?.[1] ?? "";

    // Accepting without the password ceremony refuses.
    const noToken = await fetch(url("/t/t-adapt/accept-revision"), {
      method: "POST", headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf: pendingCsrf, "revision-id": String(rev3Id) }),
      redirect: "manual",
    });
    expect(noToken.status).toBe(403);
    expect(store.getPlanRevision(rev3Id)?.status).toBe("blocked");

    const accepted = await fetch(url("/t/t-adapt/accept-revision"), {
      method: "POST", headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf: pendingCsrf, "revision-id": String(rev3Id), token: approverToken }),
      redirect: "manual",
    });
    expect(accepted.status).toBe(303);
    expect(store.getPlanRevision(rev3Id)?.status).toBe("applied");
    expect(store.activeHold(ref, new Date())).toBeNull();

    const afterAccept = await (await fetch(url("/t/t-adapt"), { headers: { cookie } })).text();
    expect(afterAccept).not.toContain("Approve changes &amp; continue");
    expect(afterAccept).toContain("plan revision 3");
  });

  test("adaptive execution plans: rejecting a blocked revision keeps the prior plan current and needs no password", async () => {
    store.createTask({ id: "t-reject", title: "adapting, then declined" }, T0);
    const ref = store.refFor("built-in", "t-reject").id;
    store.placeTask(ref, "/repo/main");
    store.saveScope({
      taskId: "t-reject", goal: "ship it", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d-reject",
      approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: "d-reject",
    });
    const plannerRun = store.startRun({
      taskRef: ref, leaseId: "plan-lease-reject", runner: "b", role: "planner",
      branch: "standing-orders-plan/t-reject", worktree: "/pool/plan-reject", now: T0,
      ...presented(store, ref, "planner"),
    });
    const rev1Content = Buffer.from(
      ["## Approach", "Do it plainly.", "## Milestones", "1. Do it.", "## Dependencies", "- None found.", "## Risks", "- None found.", "## Proof", "- Run the suite.", ""].join("\n"),
      "utf8",
    );
    mkdirSync(join(evidenceRoot, String(plannerRun)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(plannerRun), "plan.md"), rev1Content);
    store.saveArtifact({
      run: plannerRun, kind: "plan", key: `${plannerRun}/plan.md`,
      bytesOriginal: rev1Content.length, bytesStored: rev1Content.length, truncated: false,
      sha256: createHash("sha256").update(rev1Content).digest("hex"), capture: "planner handoff (verified tree)",
    }, T0);
    store.finishRun(plannerRun, { outcome: "built", reason: "plan-drafted", now: T0 });

    sealScopeFixture(store, "t-reject", approverToken);
    const buildRun = store.startRun({
      taskRef: ref, leaseId: "build-lease-reject", runner: "b", role: "builder",
      branch: "standing-orders/t-reject", worktree: "/pool/build-reject", now: T0,
      ...presented(store, ref, "builder"),
    });
    const rev2Content = Buffer.from(rev1Content.toString("utf8").replace("Do it plainly.", "Do it carefully."), "utf8");
    mkdirSync(join(evidenceRoot, String(buildRun)), { recursive: true });
    writeFileSync(join(evidenceRoot, String(buildRun), "revision.md"), rev2Content);
    const rev2ArtifactId = store.saveArtifact({
      run: buildRun, kind: "plan", key: `${buildRun}/revision.md`,
      bytesOriginal: rev2Content.length, bytesStored: rev2Content.length, truncated: false,
      sha256: createHash("sha256").update(rev2Content).digest("hex"), capture: "builder-filed revision proposal",
    }, T0);
    const rev2Id = store.insertPlanRevision({
      taskRef: ref, revision: 2, artifact: rev2ArtifactId, parentHash: null,
      reason: "budget changed underneath the run", evidenceLink: null, author: `builder:${buildRun}`, originRun: buildRun,
      kind: "builder-proposal", authorityKind: "authority-change", authorityDigest: "digest-changed-2",
      changedFields: ["publication-authority"], status: "blocked",
    }, T0);
    store.holdOwned({ taskRef: ref, ownerKind: "revision", ownerId: String(rev2Id), reason: "publication authority changed", until: null }, T0);

    const cookie = await login();
    const page = await (await fetch(url("/t/t-reject"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? "";

    const rejected = await fetch(url("/t/t-reject/reject-revision"), {
      method: "POST", headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, "revision-id": String(rev2Id) }),
      redirect: "manual",
    });
    expect(rejected.status).toBe(303);
    expect(store.getPlanRevision(rev2Id)?.status).toBe("rejected");
    expect(store.activeHold(ref, new Date())).toBeNull();

    const after = await (await fetch(url("/t/t-reject"), { headers: { cookie } })).text();
    expect(after).not.toContain("The agent recommends a plan change");
    expect(after).toContain("Do it plainly.");

    // Resolving twice fails closed: the decision already resolved.
    const again = await fetch(url("/t/t-reject/reject-revision"), {
      method: "POST", headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, "revision-id": String(rev2Id) }),
      redirect: "manual",
    });
    expect(again.status).toBe(409);
  });

  test("the old morning route forwards to activity, which speaks of windows, not nights", async () => {
    const cookie = await login();
    const moved = await fetch(url("/morning"), { headers: { cookie }, redirect: "manual" });
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("/activity");

    const activity = await (await fetch(url("/activity"), { headers: { cookie } })).text();
    expect(activity).toContain("<h1>Activity</h1>");
    expect(activity).not.toContain("morning");
    expect(activity).not.toContain("overnight");
    expect(activity).not.toContain("the night");
  });
});

describe("the rolled-up board — every project, one ceiling", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-rollup-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({
      store, evidenceRoot, clock: () => new Date(),
      repos: ["/repo/alpha", "/repo/beta"],
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("scope=all shows every admitted project's cards, chipped — and nothing beyond the ceiling", async () => {
    for (const [id, repo] of [
      ["t-alpha", "/repo/alpha"],
      ["t-beta", "/repo/beta"],
      ["t-outside", "/repo/forbidden"],
    ] as const) {
      store.createTask({ id, title: `work in ${repo}` }, T0);
      store.placeTask(store.refFor("built-in", id).id, repo);
    }
    store.createTask({ id: "t-unplaced", title: "belongs to nobody yet" }, T0);

    const cookie = await login();
    const board = await (await fetch(url("/board?scope=all"), { headers: { cookie } })).text();
    expect(board).toContain("t-alpha");
    expect(board).toContain("t-beta");
    // The chips name the projects.
    expect(board).toContain(">alpha</span>");
    expect(board).toContain(">beta</span>");
    // Outside the ceiling: not a card, not a name, not a byte.
    expect(board).not.toContain("t-outside");
    expect(board).not.toContain("forbidden");
    // Unplaced work dispatches anywhere, so the roll-up owns it honestly.
    expect(board).toContain("t-unplaced");

    // The fragment carries the same scope and the same ceiling.
    const fragment = await (await fetch(url("/board?scope=all&fragment=1"), { headers: { cookie } })).text();
    expect(fragment).toContain("t-alpha");
    expect(fragment).not.toContain("t-outside");

    // Without scope=all and without an open project, the board defers to
    // the opener — the roll-up is the only project-less board.
    const bare = await fetch(url("/board"), { headers: { cookie }, redirect: "manual" });
    expect(bare.status).toBe(303);
    expect(bare.headers.get("location")).toBe("/projects?return=%2Fboard");
  });

  test("a blocker beyond the ceiling keeps its name but never its state", async () => {
    store.createTask({ id: "t-waiting", title: "blocked here" }, T0);
    store.createTask({ id: "t-secret", title: "elsewhere" }, T0);
    store.placeTask(store.refFor("built-in", "t-waiting").id, "/repo/alpha");
    store.placeTask(store.refFor("built-in", "t-secret").id, "/repo/forbidden");
    store.addEdge("t-waiting", "t-secret");
    store.setTaskState("t-secret", "running", new Date());
    store.saveScope({
      taskId: "t-waiting", goal: "wait politely", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "dg-w",
      approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: "dg-w",
    });

    const cookie = await login();
    const board = await (await fetch(url("/board?scope=all"), { headers: { cookie } })).text();
    // The edge belongs to the visible task; the other project's live
    // status does not travel through it.
    expect(board).toContain("waits on t-secret");
    expect(board).not.toContain("waits on t-secret \u2014");
    expect(board).not.toContain("Building now");
  });
});

describe("routines on the console", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const TERMS = {
    repo: "/repo/main",
    goal: "Refresh the notes",
    outOfScope: null,
    touches: [] as string[],
    acceptance: [{ id: "c1", statement: "The notes are refreshed.", how: null, evidence: ["manual-review"] as const }],
    requirements: [] as string[],
    schedule: "every:60",
    singleFlight: true,
    costCeilingUsd: null,
  };

  const file = (name: string, terms = TERMS): number => {
    // v24/v48: filing binds the profile AND the four-role route the
    // configuration resolves, like the real door.
    const authority = resolveRoutineAuthority(store, terms.repo, terms.acceptance, T0);
    if (!authority.ok) throw new Error(authority.problem);
    const created = store.createRoutine(
      { name, ...terms, digest: routineDigestOf(terms, authority.profile, authority.route), profile: authority.profile, route: authority.route },
      T0,
    );
    if (!created.ok) throw new Error("duplicate in setup");
    return created.id;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-routine-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the ceiling rules every routine read and verb, whatever the request names", async () => {
    const mine = file("mine");
    const foreign = file("foreign", { ...TERMS, repo: "/repo/secret" });
    const cookie = await login();

    const list = await (await fetch(url("/routines"), { headers: { cookie } })).text();
    expect(list).toContain("mine");
    expect(list).not.toContain("foreign");

    expect((await fetch(url(`/routines/${foreign}`), { headers: { cookie } })).status).toBe(404);
    // The verb refuses independently of authorizeMutation (finding 7): a
    // CSRF-valid, authenticated POST naming an out-of-ceiling routine is 404.
    const screen = await (await fetch(url(`/routines/${mine}`), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(screen)?.[1] as string;
    const denied = await fetch(url(`/routines/${foreign}/pause`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf }),
    });
    expect(denied.status).toBe(404);
    expect(store.getRoutine(foreign)?.paused).toBe(false);
  });

  test("approving is step-up: the restated order, the nonce, and the password again", async () => {
    const id = file("deps");
    const cookie = await login();

    const screen = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(screen).toContain("BUILDS IT WITHOUT ASKING");
    expect(screen).toContain("every 1 hour(s)");
    // routine-freeze (v48): the exact four-role agents the yes freezes are
    // restated before the password, in the same block a task's ceremony uses.
    const ceremony = /<form method="post" action="\/routines\/\d+\/approve"(.*?)<\/form>/s.exec(screen)?.[1] ?? "";
    expect(ceremony).toContain('<p class="approval-label">agents</p>');
    expect(ceremony).toContain('<p class="agents-summary">claude · sonnet plans, builds, and repairs</p>');
    expect(ceremony).toContain('<span class="badge">frozen when you approve</span>');
    expect(ceremony).toContain("a configuration change afterwards cannot re-route one");
    expect(ceremony.indexOf('<p class="approval-label">agents</p>')).toBeLessThan(ceremony.indexOf('name="token"'));
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(screen)?.[1] as string;
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(screen)?.[1] as string;
    const digest = /name="digest" value="([0-9a-f]{32})"/.exec(screen)?.[1] as string;
    expect(nonce).toBeDefined();

    // The session alone cannot agree: a wrong password refuses.
    const wrong = await fetch(url(`/routines/${id}/approve`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, digest, token: "not-the-password" }),
    });
    expect(wrong.status).toBe(403);
    expect(store.getRoutine(id)?.approvedAt).toBeNull();

    // A fresh form (the nonce was spent either way), the real credential.
    const again = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    const nonce2 = /name="nonce" value="([0-9a-f]{32})"/.exec(again)?.[1] as string;
    const approved = await fetch(url(`/routines/${id}/approve`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce: nonce2, digest, token: approverToken }),
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    const routine = store.getRoutine(id);
    expect(routine?.approvedBy).toBe("alex");
    expect(routine?.approvedRoute).not.toBeNull();
    const after = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(after).toContain('<span class="badge">frozen by the approval</span>');
    expect(after).toContain("Every firing runs on exactly these agents; a configuration change cannot re-route it.");
    expect(routine?.nextFireAt).not.toBeNull();
  });

  test("pause, resume, and run-now from the screen; run-now refuses while blocked", async () => {
    const id = file("audit");
    const cookie = await login();
    const screen = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(screen)?.[1] as string;
    const post = (verb: string, extra: Record<string, string> = {}) =>
      fetch(url(`/routines/${id}/${verb}`), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, ...extra }),
        redirect: "manual",
      });

    expect((await post("pause")).status).toBe(303);
    expect(store.getRoutine(id)?.paused).toBe(true);
    expect((await post("resume")).status).toBe(303);
    expect(store.getRoutine(id)?.paused).toBe(false);

    // run-now is spend outside the schedule: the session alone cannot ask
    // (Codex Phase C review, M3) — no password, no fire; wrong password,
    // no fire.
    expect((await post("run-now")).status).toBe(400);
    expect((await post("run-now", { token: "not-it" })).status).toBe(403);

    // Credentialed but unapproved: refuses with the reason on the screen.
    const refusedPage = await post("run-now", { token: approverToken });
    expect(refusedPage.status).toBe(409);

    const approvedNow = approveRoutine(store, id, "alex", T0, store.getRoutine(id)?.digest ?? "", approverToken);
    expect(approvedNow.ok).toBe(true);
    expect((await post("run-now", { token: approverToken })).status).toBe(303);
    // One instance exists, linked and approved; a second run-now hits
    // single-flight and refuses to the person's face.
    const instances = store.listTasks().filter(one => one.id.startsWith("audit-"));
    expect(instances).toHaveLength(1);
    expect((await post("run-now", { token: approverToken })).status).toBe(409);
  });

  test("the board keeps instances in their track row, except when they need a person", async () => {
    const id = file("notes");
    approveRoutine(store, id, "alex", T0, store.getRoutine(id)?.digest ?? "", approverToken);
    const fired = fireRoutine(store, id, new Date(T0.getTime() + 2 * 60 * 60_000));
    expect(fired.ok).toBe(true);
    if (!fired.ok) return;

    const cookie = await login();
    const board = await (await fetch(url("/board"), { headers: { cookie } })).text();
    // The track row renders: name, a dot, the week's spend.
    expect(board).toContain("routines");
    expect(board).toContain("notes");
    expect(board).toContain("track-strip");
    expect(board).toContain("this week");
    // The queued instance does NOT sit in the main lanes...
    expect(board).not.toContain(`lane-card" href="/t/${fired.taskId}`);
    // ...and the board's polled region stays form-free, tracks included.
    expect(board.slice(board.indexOf('<div id="board-region">'), board.indexOf('id="board-region-stamp"'))).not.toContain("<form");

    // Now the instance needs a person: it fails. It surfaces in attention,
    // wearing the routine's name.
    store.setTaskState(fired.taskId, "failed", new Date(T0.getTime() + 3 * 60 * 60_000));
    const after = await (await fetch(url("/board"), { headers: { cookie } })).text();
    expect(after).toContain(`href="/t/${encodeURIComponent(fired.taskId)}"`);
    expect(after).toContain("failed");
  });

  test("filing from the console lands on the approval ceremony; a bad definition names every problem", async () => {
    const cookie = await login();
    const screen = await (await fetch(url("/routines"), { headers: { cookie } })).text();
    expect(screen).toContain("File a standing order");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(screen)?.[1] as string;
    const revision = /name="projectRevision" value="([0-9]+)"/.exec(screen)?.[1] as string;

    // Every problem at once, stored nothing.
    const bad = await fetch(url("/routines/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review", csrf, projectRevision: revision, name: "Bad Name", goal: "", schedule: "hourly" }),
    });
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toContain("name:");
    expect(badHtml).toContain("goal:");
    expect(badHtml).toContain("schedule:");
    expect(store.listRoutines(null)).toHaveLength(0);

    // A good one lands on its screen — where the step-up already waits.
    const made = await fetch(url("/routines/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
        csrf, projectRevision: revision,
        name: "weekly-notes", goal: "Refresh the notes", schedule: "daily:03:30",
      }),
      redirect: "manual",
    });
    expect(made.status).toBe(303);
    const where = made.headers.get("location") as string;
    const detail = await (await fetch(url(where), { headers: { cookie } })).text();
    expect(detail).toContain("BUILDS IT WITHOUT ASKING");
    expect(detail).toContain("daily at 03:30 UTC");
    // Filed into the OPEN project, not a typed path.
    expect(store.routineByName("weekly-notes")?.repo).toBe("/repo/main");
  });

  test("/routines names the empty state and shows the ledger once firings exist", async () => {
    const cookie = await login();
    const empty = await (await fetch(url("/routines"), { headers: { cookie } })).text();
    expect(empty).toContain("No routines");
    // The empty state points at the filing form on this very page — not at
    // the terminal (round-5 copy fix).
    expect(empty).toContain("file one");
    expect(empty).not.toContain("from the terminal");

    const id = file("weekly");
    approveRoutine(store, id, "alex", T0, store.getRoutine(id)?.digest ?? "", approverToken);
    fireRoutine(store, id, new Date(T0.getTime() + 2 * 60 * 60_000));
    const list = await (await fetch(url("/routines"), { headers: { cookie } })).text();
    expect(list).toContain("weekly");
    expect(list).toContain("live");
    const screen = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(screen).toContain("Firings");
    expect(screen).toContain("weekly-");
  });

  test("consent-closed (routines): a legacy unfrozen or unreadable order shows no password and mints no nonce — the refresh act is the road, and only the re-approval unlocks the password", async () => {
    const cookie = await login();
    const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
    const nonceOf = (html: string) => /name="nonce" value="([0-9a-f]*)"/.exec(html)?.[1] ?? null;
    // An authentic pre-v48 approval: the columns say approved, no route was ever sealed.
    const id = file("legacy");
    store.raw().prepare("UPDATE routine SET route_json = NULL, digest = ?, approved_at = ?, approved_by = 'alex', approved_digest = ?, approved_profile_json = profile_json, next_fire_at = ? WHERE id = ?")
      .run(routineDigestOf(TERMS, store.getRoutine(id)!.profile), T0.toISOString(), routineDigestOf(TERMS, store.getRoutine(id)!.profile), new Date(T0.getTime() + 3_600_000).toISOString(), id);
    let page = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(page).toContain("agents not frozen — refresh and approve again");
    expect(page).toContain("approved before agents were frozen");
    expect(page).toContain('id="agents-recovery"');
    expect(page).toContain("Refresh agents");
    expect(page).not.toContain('type="password"');
    expect(nonceOf(page)).toBeNull();
    // Firing it from the page refuses in words (no run-now form either).
    expect(page).not.toContain("Run now");
    // Corrupt snapshot bytes read the same way: closed, with their own words.
    store.raw().prepare("UPDATE routine SET approved_route_json = '{\"version\":1' WHERE id = ?").run(id);
    page = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(page).toContain("cannot be read");
    expect(page).not.toContain('type="password"');
    expect(nonceOf(page)).toBeNull();
    // The recovery is ONE plain-language act with accessible, neutral
    // controls: a labelled, described button — never a danger verb, never
    // a password — and no seeded transcript anywhere near it.
    expect(page).toMatch(/<form method="post" action="\/routines\/\d+\/refresh" class="card approve-form agents-recovery" id="agents-recovery" aria-labelledby="agents-recovery-title">/);
    expect(page).toContain('<p id="agents-recovery-why" class="recap">');
    expect(page).toContain('<button type="submit" aria-describedby="agents-recovery-why">Refresh agents</button>');
    expect(page.slice(page.indexOf('id="agents-recovery"'), page.indexOf("</form>", page.indexOf('id="agents-recovery"')))).not.toContain('class="danger"');
    expect(page).not.toContain("demoTranscript");
    // A snapshot that READS but no longer hashes to the approval (a rewritten
    // review leg): not live either — closed in its own words, same road.
    const routed = refreshRoutineAgents(store, id, T0);
    expect(routed.ok).toBe(true);
    const verify = approveRoutine(store, id, "alex", T0, store.getRoutine(id)!.digest, approverToken);
    expect(verify.ok).toBe(true);
    const approvedJson = String((store.raw().prepare("SELECT approved_route_json AS j FROM routine WHERE id = ?").get(id) as { j: string }).j);
    store.raw().prepare("UPDATE routine SET approved_route_json = ? WHERE id = ?").run(approvedJson.replace('"model":"sonnet","phase":"review"', '"model":"opus","phase":"review"'), id);
    page = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(page).toContain("do not verify");
    expect(page).not.toContain('type="password"');
    expect(page).not.toContain("Run now");
    expect(nonceOf(page)).toBeNull();
    expect(page).toContain('id="agents-recovery"');
    // The refresh act: a session's own POST, nothing approved by it.
    const refreshed = await fetch(url(`/routines/${id}/refresh`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: csrfOf(page) }),
      redirect: "manual",
    });
    expect(refreshed.status).toBe(303);
    const after = store.getRoutine(id)!;
    expect(after.route).not.toBeNull();
    // The unverified approval was WITHDRAWN by the refresh, working data unchanged.
    expect(after).toMatchObject({ approvedDigest: null, approvedRoute: null, nextFireAt: null });
    expect(fireRoutine(store, id, new Date(T0.getTime() + 2 * 3_600_000))).toMatchObject({ ok: false, reason: "not-approved" });
    // Now the exact agents are restated above a password, under a fresh nonce.
    page = await (await fetch(url(`/routines/${id}`), { headers: { cookie } })).text();
    expect(page).toContain("edited — approve again");
    expect(page).toContain("claude · sonnet plans, builds, and repairs");
    expect(page).toContain('type="password"');
    expect(nonceOf(page)).toMatch(/^[0-9a-f]{32}$/);
    expect(page).not.toContain('id="agents-recovery"');
    const approved = await fetch(url(`/routines/${id}/approve`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: csrfOf(page), nonce: nonceOf(page) as string, digest: after.digest, token: approverToken }),
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    const frozen = store.getRoutine(id)!;
    expect(frozen.approvedDigest).toBe(frozen.digest);
    expect(frozen.approvedRoute).not.toBeNull();
    // (The console approved under the wall clock, so the slot is not yet
    // due — run-now proves the seal the same way.)
    const fired = fireRoutine(store, id, new Date(), { manual: true });
    expect(fired.ok).toBe(true);
    if (fired.ok) expect(store.sealedRouteOf(fired.taskId).ok).toBe(true);
  });
});

describe("the agents card — configuration, readable at a glance", () => {
  test("says what each phase runs on, who chose it, and that the browser cannot change it", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-agents-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    store.setPhaseConfig("installation", "build", "codex", "gpt-5-codex", "alex", T0);
    store.setPhaseConfig("installation", "plan", "codex", "gpt-5-codex", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "codex", "gpt-5-codex", "alex", T0);
    store.setPhaseConfig("/repo/main", "plan", "claude", "opus", "alex", T0);
    const server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(`${base}/login`, {
        method: "POST",
        body: new URLSearchParams({ name: "alex", token: added.token }),
        redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
      const html = await (await fetch(`${base}/system`, { headers: { cookie } })).text();
      // Plain sentences, provenance in words, the honest cost note — and
      // no form anywhere near it: changing routing is the terminal's act.
      expect(html).toContain("Agents");
      expect(html).toContain("chosen for this project by alex");
      expect(html).toContain("set for the whole installation by alex");
      expect(html).toContain("gpt-5-codex");
      expect(html).toContain("no dollar costs");
      expect(html).toContain("the default — nothing configured"); // repair, untouched
      expect(html).toContain("toolroll config");
      expect(html).not.toMatch(/<form[^>]*config/);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe("/next — clearing the queue one thing at a time", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const url = (path: string) => `${base}${path}`;
  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-next-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("question first, act inline, land on the next item; approvals carry the step-up on the card", async () => {
    // One open question and one unapproved scope wait.
    store.createTask({ id: "t-q", title: "asked" }, T0);
    const qRef = store.refFor("built-in", "t-q").id;
    const run = store.startRun({ taskRef: qRef, leaseId: "l1", runner: "b", branch: "br", worktree: "/w", now: T0, ...presented(store, qRef, "builder") });
    store.saveDecision({
      run, urgency: "blocking", recap: "Two ways to cache.", question: "Per-user or global?",
      options: [
        { id: "user", label: "Per-user", consequence: "More state.", reversible: true },
        { id: "global", label: "Global", consequence: "Coarser.", reversible: true },
      ],
      recommendation: "user",
    }, T0);
    store.createTask({ id: "t-a", title: "needs a yes" }, T0);
    store.saveScope({
      taskId: "t-a", goal: "do the thing", outOfScope: "not the other thing", touches: ["src/x.ts"], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });

    const cookie = await login();
    // The oldest question leads, with its answers ON the card.
    const first = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(first).toContain("1 of 2 waiting on you");
    expect(first).toContain("Per-user or global?");
    expect(first).toContain('name="return" value="next"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(first)?.[1] as string;

    // Answering lands on the NEXT item — the approval, step-up included.
    const answered = await fetch(url("/d/1/answer"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, choice: "user", return: "next" }),
      redirect: "manual",
    });
    expect(answered.status).toBe(303);
    expect(answered.headers.get("location")).toBe("/next");

    const second = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(second).toContain("the last thing waiting on you");
    expect(second).toContain("Approve exactly this:");
    expect(second).toContain("not the other thing");
    expect(second).toContain('type="password"');
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(second)?.[1] as string;
    const csrf2 = /name="csrf" value="([0-9a-f]{64})"/.exec(second)?.[1] as string;

    const approved = await fetch(url("/t/t-a/approve"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf: csrf2, nonce, digest: store.getScope("t-a")?.digest as string, token: approverToken, return: "next" }),
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toBe("/next");

    // The queue is clear, and says so like a person would.
    const done = await (await fetch(url("/next"), { headers: { cookie } })).text();
    expect(done).toContain("Nothing needs you");
  });

  test("not-now sets an item aside without touching it, and all-clear remembers the held ones", async () => {
    store.createTask({ id: "t-1", title: "one" }, T0);
    store.saveScope({
      taskId: "t-1", goal: "g", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "a".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const cookie = await login();
    const first = await (await fetch(url("/next"), { headers: { cookie } })).text();
    const skip = /href="(\/next\?skip=[^"]+)"/.exec(first)?.[1] as string;
    expect(skip).toBeDefined();
    const after = await (await fetch(url(skip.replace(/&amp;/g, "&")), { headers: { cookie } })).text();
    expect(after).toContain("the 1 you set aside");
    // Nothing was approved by setting it aside.
    expect(store.getScope("t-1")?.approvedAt).toBeNull();
  });

  test("the inbox offers the flow only when something waits", async () => {
    const cookie = await login();
    const idle = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(idle).not.toContain("clear the queue");
    store.createTask({ id: "t-w", title: "w" }, T0);
    store.saveScope({
      taskId: "t-w", goal: "g", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "b".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    const busy = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(busy).toContain("clear the queue");
  });
});

describe("since you last looked", () => {
  test("a return visit says what concluded in between; fragment polls never move the anchor", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-delta-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    const clockBox = { now: new Date() };
    const server = createDecisionServer({ store, evidenceRoot, clock: () => clockBox.now, repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(`${base}/login`, {
        method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;

      // First look: no previous anchor, no strip.
      const first = await (await fetch(`${base}/board`, { headers: { cookie } })).text();
      expect(first).not.toContain("Since you last looked");

      // Work concludes while the operator is away.
      store.createTask({ id: "t-d", title: "w" }, T0);
      const ref = store.refFor("built-in", "t-d").id;
      const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b", branch: "br", worktree: "/w", now: clockBox.now, ...presented(store, ref, "builder") });
      store.finishRun(run, { outcome: "built", now: clockBox.now });

      // A fragment poll in the open tab does NOT count as looking.
      clockBox.now = new Date(clockBox.now.getTime() + 10 * 60_000);
      await fetch(`${base}/board?fragment=1`, { headers: { cookie } });

      const back = await (await fetch(`${base}/board`, { headers: { cookie } })).text();
      expect(back).toContain("Since you last looked");
      expect(back).toContain("1 built");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe("quick capture — from thought to the approve card in two steps", () => {
  test("title + goal on the inbox lands on the task screen with the step-up ready", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-capture-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    const server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(`${base}/login`, {
        method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
      const inbox = await (await fetch(`${base}/inbox`, { headers: { cookie } })).text();
      expect(inbox).toContain("Capture new work");
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(inbox)?.[1] as string;
      const revision = /name="projectRevision" value="([0-9]+)"/.exec(inbox)?.[1] as string;

      const made = await fetch(`${base}/tasks/add`, {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
          csrf, projectRevision: revision,
          title: "Guard the webhook", goal: "Reject unsigned payloads at the edge",
        }),
        redirect: "manual",
      });
      expect(made.status).toBe(303);
      const where = made.headers.get("location") as string;
      const screen = await (await fetch(`${base}${where}`, { headers: { cookie } })).text();
      // Step two IS the approval: the scope is written, the password waits.
      expect(screen).toContain("Reject unsigned payloads");
      expect(screen).toContain('class="approve-form approval-sheet"');
      expect(screen).toContain('type="password"');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe("the roll-up inbox — every project, one ceiling, links only", () => {
  test("a projectless session sees admitted rows with chips; foreign repos neither render nor count", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-rollup-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");

    const seed = (id: string, repo: string) => {
      store.createTask({ id, title: `work in ${repo}` }, T0);
      store.placeTask(store.refFor("built-in", id).id, repo);
      store.saveScope({
        taskId: id, goal: `goal of ${id}`, outOfScope: null, touches: [], acceptance: [],
        proposedAt: T0.toISOString(), digest: id.padEnd(32, "0").slice(0, 32),
        approvedAt: null, approvedBy: null, approvedDigest: null,
      });
    };
    seed("t-main", "/repo/main");
    seed("t-side", "/repo/side");
    seed("t-secret", "/repo/secret"); // outside the ceiling
    store.createTask({ id: "t-free", title: "unplaced work" }, T0);
    store.saveScope({
      taskId: "t-free", goal: "anywhere", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "f".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });

    // TWO repos in the ceiling: no default project, sessions start open.
    const server = createDecisionServer({
      store, evidenceRoot, clock: () => new Date(),
      repos: ["/repo/main", "/repo/side"],
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(`${base}/login`, {
        method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;

      // The secondary inbox retains the admitted roll-up and its action guards.
      const inbox = await (await fetch(`${base}/inbox`, { headers: { cookie }, redirect: "manual" }));
      expect(inbox.status).toBe(200);
      const html = await inbox.text();
      expect(html).toContain("t-main");
      expect(html).toContain("t-side");
      expect(html).not.toContain("t-secret");
      // Rows wear their project; unplaced work says so instead of hiding it.
      expect(html).toContain("main</span>");
      expect(html).toContain("unplaced");
      // Links only in the roll-up: no capture form, no inline verbs.
      expect(html).not.toContain("/tasks/add");
      expect(html).not.toMatch(/<form[^>]*requeue/);
      // The badge counted 3 admitted approvals, never the secret one.
      expect(html).toMatch(/class="count badge badge-open">3/);

      // Tapping a row lands on the task itself — the roll-up hands off to
      // the detail, not to the project picker. The row's own ceiling check
      // is the authorization; the cross-project list pane never renders.
      const detail = await fetch(`${base}/t/t-main`, { headers: { cookie }, redirect: "manual" });
      expect(detail.status).toBe(200);
      const detailHtml = await detail.text();
      expect(detailHtml).toContain('class="approve-form approval-sheet"');
      expect(renderedHtmlOf(detailHtml)).not.toContain("t-side"); // no cross-project native list pane
      expect(workspaceOf(detailHtml).crew.map(one => one.id).sort()).toEqual(['t-main', 't-side']);
      expect(detailHtml).not.toContain('t-secret'); // neither fallback nor admitted crew leaks foreign work
      expect((await fetch(`${base}/t/t-secret`, { headers: { cookie } })).status).toBe(404);

      // Everything else still requires opening a project.
      const board = await fetch(`${base}/board`, { headers: { cookie }, redirect: "manual" });
      expect(board.status).toBe(303);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe("the filesystem browser — confined to what opening allows", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;
  let root: string;

  const url = (path: string) => `${base}${path}`;
  const T0 = new Date("2026-08-14T12:00:00.000Z");

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const boot = async (options: Record<string, unknown>) => {
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), ...options });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-browse-ev-"));
    root = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-browse-root-")));
    mkdirSync(join(root, "payments-api", ".git"), { recursive: true });
    mkdirSync(join(root, "notes"), { recursive: true });
    mkdirSync(join(root, ".hidden-things"), { recursive: true });
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test("a root ceiling browses its roots: repos first with open buttons, plain folders enterable, dotfiles hidden", async () => {
    await boot({ projectRoots: [root] });
    const cookie = await login();
    const html = await (await fetch(url("/projects/browse"), { headers: { cookie } })).text();
    expect(html).toContain("payments-api");
    expect(html).toContain("badge-done\">git");
    expect(html).toContain("notes");
    expect(html).not.toContain("hidden-things");
    // The projects page offers the door.
    const projects = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    expect(projects).toContain("/projects/browse");
  });

  test("containment: outside paths and symlink escapes are refused, not resolved", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-outside-")));
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outside, join(root, "escape-hatch"));
      await boot({ projectRoots: [root] });
      const cookie = await login();
      const direct = await fetch(url(`/projects/browse?at=${encodeURIComponent(outside)}`), { headers: { cookie }, redirect: "manual" });
      expect(direct.status).toBe(403);
      const etc = await fetch(url("/projects/browse?at=/etc"), { headers: { cookie }, redirect: "manual" });
      expect(etc.status).toBe(403);
      // The symlink pointing out of the fence simply does not render.
      const listing = await (await fetch(url("/projects/browse"), { headers: { cookie } })).text();
      expect(listing).not.toContain("escape-hatch");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("an explicit repo list gets no browser — the openable set is already on the page", async () => {
    await boot({ repo: root });
    const cookie = await login();
    const browse = await fetch(url("/projects/browse"), { headers: { cookie }, redirect: "manual" });
    expect(browse.status).toBe(404);
    const projects = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    expect(projects).not.toContain("/projects/browse");
  });
});

describe("the fleet — runner lanes as the agents × projects surface", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const csrf = (html: string): string => (/name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "");

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-fleet-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("one lane per runner; a building card pins to the top wearing its project; the grid is auto-fit, not five tracks", async () => {
    const now = new Date();
    // builder-1 carries a real credential and the repo binding the runner
    // gate proves (MCP spec v6); builder-2 only ever holds a reservation.
    store.saveRunner(
      { name: "builder-1", host: "here", capacity: 2, repos: ["/repo/main"], agents: [], registeredAt: T0.toISOString(), heartbeatAt: now.toISOString(), retiredAt: null },
      hashToken("tok-builder-1"),
    );
    store.saveRunner(
      { name: "builder-2", host: "here", capacity: 1, repos: [], agents: [], registeredAt: T0.toISOString(), heartbeatAt: now.toISOString(), retiredAt: null },
      "hash2",
    );
    // A live claim on builder-1.
    store.createTask({ id: "t-live", title: "being built" }, T0);
    const ref = store.refFor("built-in", "t-live").id;
    store.placeTask(ref, "/repo/main");
    const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(now.getTime() - 5 * 60_000), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim refused");
    store.startRun({
      taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1",
      branch: "standing-orders/t-live", worktree: "/pool/t-live",
      model: "claude", now: new Date(now.getTime() - 5 * 60_000),
      ...presented(store, ref, "builder", null, { provider: "claude", model: "claude" }),
    });
    // A queued reservation on builder-2.
    store.createTask({ id: "t-queued", title: "reserved work" }, T0);
    store.moveTask({ taskId: "t-queued", toRunner: "builder-2", beforeTaskId: null }, new Date());

    const cookie = await login();
    const html = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    expect(html).toContain('class="lanes"');           // auto-fit runner grid
    expect(html).toContain('<div class="lanes" data-queue-revision=');
    expect(html).not.toContain('<div class="board" data-queue-revision='); // not the 5-track board container
    expect(html).toContain("builder-1");
    expect(html).toContain("builder-2");
    expect(html).toContain("Shared queue");
    expect(html).toContain("being built");             // the live claim
    expect(html).toContain("reserved work");           // the queued reservation
    // The register/retire ceremonies are the only forms here.
    expect(html).toContain('action="/fleet/runner/register"');
    expect(html).toContain('action="/fleet/runner/retire"');
    // Its fragment is the lanes alone, behind the same auth.
    const fragment = await (await fetch(url("/fleet?fragment=1"), { headers: { cookie } })).text();
    expect(fragment).toContain('class="lanes"');
    expect(fragment).not.toContain("<html");
    expect(fragment).not.toContain("<script");
  });

  test("registering a worker takes a password and shows its token once; the token is never re-rendered", async () => {
    const cookie = await login();
    const page = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    const token = csrf(page);

    // No password: refused, nothing minted.
    const noPassword = await fetch(url("/fleet/runner/register"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf: token, name: "builder-9", capacity: "1", token: "" }),
      redirect: "manual",
    });
    expect(noPassword.status).toBe(403);
    expect(store.getRunner("builder-9")).toBeNull();

    // With the password: the token renders on this one response and nowhere else.
    const created = await fetch(url("/fleet/runner/register"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf: token, name: "builder-9", capacity: "2", token: approverToken }),
      redirect: "manual",
    });
    expect(created.status).toBe(200);
    const shown = await created.text();
    expect(shown).toContain("builder-9 is registered");
    expect(shown).toContain("shown once");
    // The shown-once page carries no live script that could re-render the token.
    expect(shown).not.toContain("<script");
    const runner = store.getRunner("builder-9");
    expect(runner).not.toBeNull();
    expect(runner?.runner.capacity).toBe(2);
    // Only a hash is kept — the raw token is not in the database's runner row.
    const later = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    expect(later).not.toContain("builder-9 is registered");
  });

  test("retiring a worker takes a password and refuses the unknown", async () => {
    store.saveRunner(
      { name: "builder-1", host: "here", capacity: 1, repos: [], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null },
      "hash",
    );
    const cookie = await login();
    const page = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    const token = csrf(page);

    const unknown = await fetch(url("/fleet/runner/retire"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: token, name: "nobody", token: approverToken }),
      redirect: "manual",
    });
    expect(unknown.status).toBe(404);

    const retired = await fetch(url("/fleet/runner/retire"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: token, name: "builder-1", token: approverToken }),
      redirect: "manual",
    });
    expect(retired.status).toBe(303);
    expect(store.getRunner("builder-1")?.runner.retiredAt).not.toBeNull();
  });

  test("dragging across projects: the fleet's move skips the open-project gate, the ceiling still walls reads", async () => {
    const cookie = await login();
    const page = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    const token = csrf(page);
    store.saveRunner(
      { name: "builder-1", host: "here", capacity: 1, repos: [], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null },
      "hash",
    );
    store.createTask({ id: "t-move", title: "movable" }, T0);
    store.saveScope({
      taskId: "t-move", goal: "go", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "d", approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: "d",
    });
    const revision = store.queueRevision();

    // A fleet-origin move (no projectRevision) re-reserves the task.
    const moved = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({
        respond: "fragment", csrf: token, queueRevision: String(revision),
        task: "t-move", column: "builder-1", before: "",
      }),
      redirect: "manual",
    });
    expect(moved.status).toBe(200);
    expect(store.assignedRunnerOf(store.refFor("built-in", "t-move").id)).toBe("builder-1");

    // A stale revision is refused with the move-reason text.
    const stale = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({
        respond: "fragment", csrf: token, queueRevision: String(store.queueRevision() + 9),
        task: "t-move", column: "anyone", before: "",
      }),
      redirect: "manual",
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("moved underneath you");
  });
});

describe("the workbench (attended A1) and the live substrate", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const url = (path: string) => `${base}${path}`;
  const T0 = new Date("2026-08-17T12:00:00.000Z");

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-wb-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    // One attention task (no scope) and one building task (live claim + run).
    store.createTask({ id: "needs-scope", title: "Needs a scope written" }, T0);
    store.refFor("built-in", "needs-scope", "ours");
    store.createTask({ id: "building-now", title: "Being built right now" }, T0);
    const ref = store.refFor("built-in", "building-now", "ours").id;
    // The runner gate (MCP spec v6): registered, repo-bound, token-proved.
    store.placeTask(ref, "/repo/main");
    register(store, { name: "night-shift-1", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-1" });
    const taken = acquire(store, ref, "night-shift-1", { token: "tok-night-shift-1", now: new Date(), ttlMs: 60 * 60_000 });
    if (!taken.ok) throw new Error("claim failed in setup");
    const run = store.startRun({
      taskRef: ref,
      leaseId: taken.claim.leaseId,
      runner: "night-shift-1",
      branch: "standing-orders/building-now",
      worktree: "/pool/building-now",
      now: new Date(),
      ...presented(store, ref, "builder"),
    });
    store.setRunPhase(run, "agent-running");
    store.setTaskState("building-now", "running", T0);

    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the rail carries needs-you and building sections, inside the workspace, with elapsed tickers", async () => {
    const cookie = await login();
    const html = await (await fetch(url("/workbench"), { headers: { cookie } })).text();
    expect(html).toContain("needs you");
    expect(html).toContain("Needs a scope written");
    expect(html).toContain("building");
    expect(html).toContain("Being built right now");
    expect(html).toContain("agent working");
    expect(html).not.toContain("agent-running");
    expect(html).toContain("data-elapsed-since=");
    // The workspace's own search (⌘K) stands in for the console palette.
    expect(workspaceOf(html).path).toBe("/workbench");
    expect(html).not.toContain('id="palette-index"');
    expect(html).toContain('id="wb-rail"');
    // The CSP carries the script nonce.
    const response = await fetch(url("/workbench"), { headers: { cookie } });
    expect(response.headers.get("content-security-policy") ?? "").toContain("nonce-");
  });

  test("the rail fragment is the rail alone — no shell, no scripts, same auth", async () => {
    const cookie = await login();
    const fragment = await (await fetch(url("/workbench?fragment=rail"), { headers: { cookie } })).text();
    expect(fragment).toContain("Needs a scope written");
    expect(fragment).not.toContain("<html");
    expect(fragment).not.toContain("<script");
    // Unauthenticated: the fragment refuses like any page.
    const bare = await fetch(url("/workbench?fragment=rail"), { redirect: "manual" });
    expect([303, 401, 403]).toContain(bare.status);
  });

  test("selection renders the full task detail — forms and all — in the main pane, never polled", async () => {
    const cookie = await login();
    const html = await (await fetch(url("/workbench?t=needs-scope"), { headers: { cookie } })).text();
    expect(html).toContain("No approved scope yet");
    expect(html).toContain("Write the scope");
    // The poll targets the rail region, not the pane.
    expect(html).toContain('"wb-rail"');
    expect(html).not.toContain('"wb-detail"');
  });

  test("an open run's facts fragment answers live; a finished run's says to reload", async () => {
    const cookie = await login();
    const open = await (await fetch(url("/r/1?fragment=facts"), { headers: { cookie } })).text();
    expect(open).toContain("agent working");
    expect(open).not.toContain("agent-running");
    expect(open).toContain("data-elapsed-since=");
    store.finishRun(1, { outcome: "built", committed: true, now: new Date() });
    const closed = await (await fetch(url("/r/1?fragment=facts"), { headers: { cookie } })).text();
    expect(closed).toContain("finished");
    expect(closed).toContain("reload for the final record");
    expect(closed).not.toContain("<form");
  });
});

describe("round 4 — liveness is proved from the current lease, never guessed from a null outcome", () => {
  let store: Store;
  let server: Server | null = null;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let liveRun: number;
  let orphanRun: number;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const boot = async (options: Record<string, unknown> = {}): Promise<void> => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), ...options });
    await new Promise<void>(resolve => (server as Server).listen(0, "127.0.0.1", resolve));
    const address = (server as Server).address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-live-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    // The runner gate (MCP spec v6): both night-shift runners registered
    // and repo-bound; every claimed task placed.
    register(store, { name: "night-shift-1", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-1" });
    register(store, { name: "night-shift-2", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-2" });

    // One genuinely live build: the claim's lease is current and unexpired.
    store.createTask({ id: "alive", title: "being built right now" }, T0);
    const aliveRef = store.refFor("built-in", "alive", "ours").id;
    store.placeTask(aliveRef, "/repo/main");
    const aliveTaken = acquire(store, aliveRef, "night-shift-1", { token: "tok-night-shift-1", now: new Date(), ttlMs: 3_600_000 });
    if (!aliveTaken.ok) throw new Error("claim failed");
    liveRun = store.startRun({
      taskRef: aliveRef, leaseId: aliveTaken.claim.leaseId, runner: "night-shift-1",
      branch: "standing-orders/alive", worktree: "/pool/alive", now: new Date(),
      ...presented(store, aliveRef, "builder"),
    });
    store.setRunPhase(liveRun, "agent-running");
    store.setTaskState("alive", "running", T0);

    // One orphan: the claim expired an hour ago; its run never finished.
    // Every "running" label must refuse this one.
    store.createTask({ id: "orphan", title: "left behind by a dead worker" }, T0);
    const orphanRef = store.refFor("built-in", "orphan", "ours").id;
    store.placeTask(orphanRef, "/repo/main");
    const orphanTaken = acquire(store, orphanRef, "night-shift-2", {
      token: "tok-night-shift-2", now: new Date(Date.now() - 7_200_000), ttlMs: 3_600_000,
    });
    if (!orphanTaken.ok) throw new Error("orphan claim failed");
    orphanRun = store.startRun({
      taskRef: orphanRef, leaseId: orphanTaken.claim.leaseId, runner: "night-shift-2",
      branch: "standing-orders/orphan", worktree: "/pool/orphan", now: new Date(Date.now() - 7_200_000),
      ...presented(store, orphanRef, "builder"),
    });
    store.setTaskState("orphan", "running", T0);

    await boot();
  });

  afterEach(async () => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = null;
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("a live run says running in plain words; an orphaned run stays never finished and gets no poller", async () => {
    const cookie = await login();
    const alive = await (await fetch(url(`/r/${liveRun}`), { headers: { cookie } })).text();
    expect(alive).toContain("badge-running");
    expect(alive).toContain(">running<");
    expect(alive).toContain("agent working");
    expect(alive).toContain('id="run-facts-stamp"');

    // The orphan's own facts say "never finished" and earn no ticker or
    // poller stamp. (The page's side list still shows OTHER runs' badges,
    // so the fragment is the honest place to assert absence.)
    const orphan = await (await fetch(url(`/r/${orphanRun}`), { headers: { cookie } })).text();
    expect(orphan).toContain("never finished");
    // The chrome layer's script text mentions the attribute name, so the
    // markup form (with =) is the honest absence assertion.
    expect(orphan).not.toContain('data-elapsed-since="');
    expect(orphan).not.toContain('id="run-facts-stamp"');
    expect(orphan).not.toContain("?fragment=facts");
    const orphanFacts = await (await fetch(url(`/r/${orphanRun}?fragment=facts`), { headers: { cookie } })).text();
    expect(orphanFacts).not.toContain("badge-running");
  });

  test("the facts fragment stops the poller for finished AND orphaned runs, and answers live otherwise", async () => {
    const cookie = await login();
    const alive = await (await fetch(url(`/r/${liveRun}?fragment=facts`), { headers: { cookie } })).text();
    expect(alive).toContain(">running<");
    expect(alive).not.toContain("data-region-stop");

    const orphan = await (await fetch(url(`/r/${orphanRun}?fragment=facts`), { headers: { cookie } })).text();
    expect(orphan).toContain("stopped without finishing");
    expect(orphan).toContain("data-region-stop");

    store.finishRun(liveRun, { outcome: "built", committed: true, now: new Date() });
    const finished = await (await fetch(url(`/r/${liveRun}?fragment=facts`), { headers: { cookie } })).text();
    expect(finished).toContain("reload for the final record");
    expect(finished).toContain("data-region-stop");
  });

  test("the task page offers the live build honestly: the attempt panel names the build, says the view is off without --runner, embeds it with", async () => {
    const cookie = await login();
    const plain = await (await fetch(url("/t/alive"), { headers: { cookie } })).text();
    // Without --runner there is nothing live to show on the task page: no
    // panel saying the view is off, no poller, no region, and no promise of
    // a live look. The build's own page says why.
    expect(plain).not.toContain("The live file view is off");
    expect(plain).not.toContain(`Build #${liveRun} · night-shift-1 · running`);
    expect(plain).not.toContain('id="run-peek"');
    expect(plain).not.toContain("?fragment=peek");

    // The run page still shows the section, saying why it is empty — the
    // click must never land on silence.
    const runPlain = await (await fetch(url(`/r/${liveRun}`), { headers: { cookie } })).text();
    expect(runPlain).toContain("What is changing right now");
    expect(runPlain).toContain("The live file view is off");

    await boot({ localRunner: "night-shift-1" });
    const cookieOn = await login();
    const watching = await (await fetch(url("/t/alive"), { headers: { cookie: cookieOn } })).text();
    // The panel (slice 1c) names the run by its one unambiguous identity
    // and always carries the door to the full build view.
    expect(watching).toContain(`Build #${liveRun} · night-shift-1 · running`);
    expect(watching).toContain(`href="/r/${liveRun}">full build view →`);
    expect(watching).toContain('id="run-peek"');
    expect(watching).toContain("Watching…");
    expect(watching).not.toContain("The live file view is off");
    const runOn = await (await fetch(url(`/r/${liveRun}`), { headers: { cookie: cookieOn } })).text();
    expect(runOn).toContain("Watching…");
    expect(runOn).not.toContain("The live file view is off");

    // The orphan's task page has no panel at all — there is nothing live.
    const orphanTask = await (await fetch(url("/t/orphan"), { headers: { cookie: cookieOn } })).text();
    expect(orphanTask).not.toContain("full build view");
    expect(orphanTask).not.toContain('class="card attempt-live"');
  });

  test("a building card lands on the build itself; a vanished build stays a repair card on the task", async () => {
    const cookie = await login();
    const board = await (await fetch(url("/board?fragment=1"), { headers: { cookie } })).text();
    expect(board).toContain(`href="/r/${liveRun}"`);
    // The orphan's dead lease earns no run link anywhere on the board — its
    // card stays on the task screen, in the attention lane.
    expect(board).not.toContain(`href="/r/${orphanRun}"`);
    expect(board).toContain(`href="/t/orphan"`);
  });

  test("unknown task and tournament pages refuse on the console's own page, not bare text", async () => {
    const cookie = await login();
    const task = await fetch(url("/t/definitely-not-here"), { headers: { cookie } });
    expect(task.status).toBe(404);
    expect(task.headers.get("content-type") ?? "").toContain("text/html");
    expect(await task.text()).toContain("no such task");

    const contest = await fetch(url("/contest/424242"), { headers: { cookie } });
    expect(contest.status).toBe(404);
    expect(contest.headers.get("content-type") ?? "").toContain("text/html");
    expect(await contest.text()).toContain("no such tournament");
  });

  test("chains from the console: wait for, stop waiting, and a loop refused in plain words", async () => {
    store.createTask({ id: "t-schema", title: "migrate the schema" }, T0);
    store.refFor("built-in", "t-schema", "ours");
    store.createTask({ id: "t-api", title: "wire the api" }, T0);
    store.refFor("built-in", "t-api", "ours");
    const cookie = await login();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(
      await (await fetch(url("/t/t-api"), { headers: { cookie } })).text(),
    )?.[1] as string;

    const post = (path: string, fields: Record<string, string>) =>
      fetch(url(path), {
        method: "POST",
        headers: { cookie },
        body: new URLSearchParams({ csrf, ...fields }),
        redirect: "manual",
      });

    // api waits for schema — created, visible, removable.
    expect((await post("/t/t-api/block", { on: "t-schema" })).status).toBe(303);
    const page = await (await fetch(url("/t/t-api"), { headers: { cookie } })).text();
    expect(page).toContain("Waits for");
    expect(page).toContain("t-schema");
    expect(page).toContain("Don't wait for this");

    // The loop refuses with the store's own sentence, on the page.
    const loop = await post("/t/t-schema/block", { on: "t-api" });
    expect(loop.status).toBe(409);
    expect(await loop.text()).toContain("cycle");

    // Remove the wait; a relationship that never existed refuses.
    expect((await post("/t/t-api/unblock", { on: "t-schema" })).status).toBe(303);
    expect((await post("/t/t-api/unblock", { on: "t-schema" })).status).toBe(409);

    // A blocker that does not exist here refuses before anything writes.
    expect((await post("/t/t-api/block", { on: "ghost" })).status).toBe(404);
  });

  test("build this next from the console: the act, the words, and the board's honest badges", async () => {
    // Approved scopes, so both cards sit in the QUEUED lane — the lane the
    // rank sorts and badges. Unapproved work is attention, not a queue.
    for (const [id, title] of [["q-one", "first filed"], ["q-two", "second filed"]] as const) {
      store.createTask({ id, title }, T0);
      store.refFor("built-in", id, "ours");
      const scoped = propose(store, { taskId: id, goal: `do ${title}`, now: T0 });
      const agreed = approve(store, id, "alex", T0, scoped.digest, approverToken);
      if (!agreed.ok) throw new Error("approve failed in setup");
    }
    const cookie = await login();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(
      await (await fetch(url("/t/q-two"), { headers: { cookie } })).text(),
    )?.[1] as string;
    const post = (path: string, fields: Record<string, string> = {}) =>
      fetch(url(path), {
        method: "POST",
        headers: { cookie },
        body: new URLSearchParams({ csrf, ...fields }),
        redirect: "manual",
      });

    expect((await post("/t/q-two/next")).status).toBe(303);
    const page = await (await fetch(url("/t/q-two"), { headers: { cookie } })).text();
    // The queue place is a property row now (task page pass).
    expect(page).toContain('<span class="meta">queue</span> <span class="mono">1 of 2 in the shared queue');
    expect(page).toContain("back to filing order");

    // Only the actual front of the shared queue says "next up".
    expect((await post("/t/q-one/next")).status).toBe(303);
    const board = await (await fetch(url("/board?fragment=1"), { headers: { cookie } })).text();
    const front = board.indexOf("first filed");
    const second = board.indexOf("second filed");
    expect(front).toBeGreaterThan(-1);
    expect(front).toBeLessThan(second);
    expect(board).toContain("next up");
    expect(board.match(/next up/g)?.length).toBe(1);

    // Undo puts it behind the still-promoted card; the badge follows rank.
    expect((await post("/t/q-one/next", { undo: "1" })).status).toBe(303);
    expect((await post("/t/q-two/next", { undo: "1" })).status).toBe(303);
    const calm = await (await fetch(url("/board?fragment=1"), { headers: { cookie } })).text();
    expect(calm.match(/next up/g)?.length).toBe(1);

    // The orphaned run's task (state running) cannot move up.
    const refused = await post("/t/orphan/next");
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("only queued work can move up");
  });

  test("a task can be filed to start after another, and a bad chain never loses the task", async () => {
    store.createTask({ id: "t-before", title: "goes first" }, T0);
    store.refFor("built-in", "t-before", "ours");
    const cookie = await login();
    const form = await (await fetch(url("/tasks/new"), { headers: { cookie } })).text();
    expect(form).toContain("Starts after");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(form)?.[1] as string;

    const created = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf, title: "goes second", id: "t-after", after: "t-before" }),
      redirect: "manual",
    });
    expect(created.status).toBe(303);
    const page = await (await fetch(url("/t/t-after"), { headers: { cookie } })).text();
    expect(page).toContain("Waits for");
    expect(page).toContain("t-before");

    // A vanished "after" still files the task — the page says what failed.
    const kept = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ csrf, title: "kept anyway", id: "t-kept", after: "nope-gone" }),
      redirect: "manual",
    });
    expect(kept.status).toBe(200);
    const keptPage = await kept.text();
    expect(keptPage).toContain("the task was created, but could not be made to wait for nope-gone");
    expect(await (await fetch(url("/t/t-kept"), { headers: { cookie } })).text()).toContain("kept anyway");
  });

  test("an interrupted tournament's agents read as stopped, never as still working", async () => {
    // Recovery marks the contest interrupted but leaves the agents' run
    // records unfinished (round-4 finding 16) — the comparison screen must
    // prove liveness rather than map a null outcome to "still working".
    store.createTask({ id: "race-int", title: "raced then interrupted" }, T0);
    const taskRef = store.refFor("built-in", "race-int", "ours").id;
    const planned = planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "claude-haiku-4-5" }],
      perAgentBudgetUsd: 5,
      totalBudgetUsd: 20,
    });
    if (!planned.ok) throw new Error(planned.reason);
    const termsId = store.fileTournamentTerms(
      {
        taskRef, raceDigest: planned.plan.raceDigest, agents: planned.plan.agents,
        perAgentBudgetMicrousd: planned.plan.perAgentBudgetMicrousd,
        overrunReserveMicrousd: planned.plan.overrunReserveMicrousd,
        totalBudgetMicrousd: planned.plan.totalBudgetMicrousd,
        priceVersion: planned.plan.priceVersion, publicationPolicy: "none",
      },
      T0,
    );
    store.approveTournamentTerms(termsId, "alex", planned.plan.raceDigest, T0);
    // The runner gate (MCP spec v6): registered, repo-bound, token-proved.
    store.placeTask(taskRef, "/repo/main");
    register(store, { name: "night-shift-3", host: "here", capacity: 8, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-3" });
    // The lease died with the machine: acquired two hours ago, one-hour TTL.
    const taken = acquire(store, taskRef, "night-shift-3", { token: "tok-night-shift-3", now: new Date(Date.now() - 7_200_000), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim");
    const admitted = admitContest(
      store,
      {
        taskId: "race-int", taskRef, runner: "night-shift-3", leaseId: taken.claim.leaseId,
        incarnation: null, scopeDigest: "scope-d", scopeApproved: true, capacity: 8, quotaBlocked: () => null,
      } as never,
      T0,
    );
    if (!admitted.ok) throw new Error(admitted.reason);
    store.stampContestDispatch(admitted.contestId, "base-sha-000", null);
    const contest = store.getContest(admitted.contestId);
    if (contest === null) throw new Error("contest");
    for (const agent of store.contestants(admitted.contestId)) store.casContestantState(agent.id, ["pending"], "ready", agent.generation);
    store.casContestState(admitted.contestId, ["dispatching"], "racing", contest.generation);
    for (const agent of store.contestants(admitted.contestId)) {
      store.casContestantState(agent.id, ["ready"], "building", agent.generation);
      const lane = store.admitContestLane({
        taskRef, leaseId: taken.claim.leaseId, runner: "night-shift-3", incarnation: null,
        branch: agent.branch, worktree: `/pool/int-${agent.id}`, contestant: agent.id, route: store.laneAuthorityFor(agent.id)!, now: new Date(Date.now() - 7_200_000),
      });
      if (!lane.ok) throw new Error(lane.problem);
    }
    const racing = store.getContest(admitted.contestId);
    if (racing === null) throw new Error("contest");
    store.casContestState(admitted.contestId, ["racing"], "interrupted", racing.generation);

    const cookie = await login();
    const html = await (await fetch(url(`/contest/${admitted.contestId}`), { headers: { cookie } })).text();
    expect(html).toContain("interrupted");
    expect(html).toContain("stopped without finishing");
    expect(html).not.toContain("still working");
  });
});
