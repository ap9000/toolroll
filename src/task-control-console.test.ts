/**
 * Safe task stop and resume (v52) on the console: the task page and the
 * focused chat show ONE exact-run control — Stop, Stopping…, Resume, or
 * Review again — from the same projection; stop is a guarded approver's
 * post naming the exact run; resume is the password ceremony over a
 * durable nonce; viewers, bearer callers, stale nonces, replayed forms,
 * changed approvals, foreign projects, and finished runs are refused in
 * words and change nothing.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { acquire, finalize } from "./claim.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { createDecisionServer } from "./serve.js";

const T0 = new Date("2026-09-12T10:00:00.000Z");

const presented = (store: Store, taskRef: number) => {
  const authority = store.routeAuthorityFor(taskRef, "builder") ?? store.routeAuthorityFor(taskRef, "builder", { provider: "claude", model: null });
  return authority === null || !authority.ok ? {} : { route: authority.stamp };
};

describe("the exact-run control on the console (v52)", () => {
  let store: Store;
  let server: Server | null = null;
  let base: string;
  let approverToken: string;
  let viewerToken: string;
  let evidenceRoot: string;
  const url = (path: string) => `${base}${path}`;

  const loginAs = async (name: string, token: string): Promise<string> => {
    const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };
  const csrfOf = (html: string): string => {
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on the page");
    return match[1] as string;
  };
  const page = async (cookie: string, path: string): Promise<string> => (await fetch(url(path), { headers: { cookie } })).text();
  const post = (cookie: string, path: string, fields: Record<string, string>) =>
    fetch(url(path), { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), redirect: "manual" });
  const controlOf = (html: string): string => /<section class="card task-control" id="task-control"(.*?)<\/section>/s.exec(html)?.[0] ?? "";

  const seed = (id: string, repo = resolve("/repo/main")): number => {
    store.createTask({ id, title: `Harden ${id}` }, T0);
    const ref = store.refFor("built-in", id, "ours").id;
    store.placeTask(ref, repo);
    propose(store, { taskId: id, goal: `harden ${id}`, now: T0 });
    const agreed = approve(store, id, "alex", T0, store.getScope(id)?.digest as string, approverToken);
    if (!agreed.ok) throw new Error(`approval refused: ${agreed.reason}`);
    return ref;
  };
  const live = (id: string, ref: number): { runId: number; leaseId: string } => {
    const taken = acquire(store, ref, "mac-mini", { token: "tok-mac-mini", now: new Date(), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error(`claim refused: ${taken.reason}`);
    const runId = store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "mac-mini", provider: "claude", branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: new Date(), ...presented(store, ref) });
    store.setRunPhase(runId, "agent-running");
    store.setTaskState(id, "running", T0);
    return { runId, leaseId: taken.claim.leaseId };
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-stop-console-"));
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    const viewer = addApprover(store, "vera", T0, { name: "alex", token: approverToken });
    if (!viewer.ok) throw new Error("viewer add");
    store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
    viewerToken = viewer.token;
    register(store, { name: "mac-mini", host: "here", capacity: 4, repos: [resolve("/repo/main"), resolve("/repo/other")], now: T0, newToken: () => "tok-mac-mini" });
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: resolve("/repo/main") });
    await new Promise<void>(resolve => (server as Server).listen(0, "127.0.0.1", resolve));
    const address = (server as Server).address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = null;
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("c7: the task page and the focused chat show the same exact-run Stop, then Stopping, then Resume; the chat fragment replaces only the live region", async () => {
    const ref = seed("payouts");
    const { runId, leaseId } = live("payouts", ref);
    const cookie = await loginAs("alex", approverToken);

    // Stop: one guarded form naming the exact run, on both surfaces.
    const taskHtml = await page(cookie, "/t/payouts");
    const control = controlOf(taskHtml);
    expect(control).toContain('data-task-control="stop"');
    expect(control).toContain(`data-control-run="${runId}"`);
    expect(control).toContain(`<input type="hidden" name="run" value="${runId}">`);
    expect(control).toMatch(/<form method="post" action="\/t\/payouts\/stop" class="inline task-control-form task-stop-form">/);
    expect(control).toContain('<button type="submit" class="danger task-control-button">Stop</button>');
    const chatHtml = await page(cookie, "/chat?task=payouts");
    expect(controlOf(chatHtml)).toContain(`data-control-run="${runId}"`);
    expect(controlOf(chatHtml)).toContain('data-task-control="stop"');
    expect(chatHtml).toContain('<section id="task-chat-live"');
    // The live fragment carries the control; the composer lives outside it,
    // so a refresh never touches typed input.
    const fragment = await page(cookie, "/chat/task-status?task=payouts");
    expect(fragment).toContain('id="task-control"');
    expect(fragment).not.toContain("<textarea");
    expect(fragment.startsWith('<section id="task-chat-live"')).toBe(true);
    // The page script swaps exactly that region and nothing else — the
    // composer (a sibling) keeps whatever was typed.
    expect(chatHtml).toContain("taskLive.replaceWith(next)");
    expect(chatHtml).toContain('data-poll="1"');

    // The post: durable, provenance recorded, redirect back to the control.
    const csrf = csrfOf(taskHtml);
    const stopped = await post(cookie, "/t/payouts/stop", { csrf, run: String(runId) });
    expect(stopped.status).toBe(303);
    expect(stopped.headers.get("location")).toBe("/t/payouts#task-control");
    expect(store.stopOf(runId)).toMatchObject({ requestedBy: "alex", requestedVia: "web", settledAt: null });
    expect(store.activeHolds(ref, new Date()).map(one => one.ownerKind)).toEqual(["stop"]);

    // Stopping: a disabled control with who asked, on both surfaces; the
    // page never says "stopped".
    const stopping = controlOf(await page(cookie, "/t/payouts"));
    expect(stopping).toContain('data-task-control="stopping"');
    expect(stopping).toContain("Stopping build #");
    expect(stopping).toContain('<button type="button" class="task-control-button" disabled aria-disabled="true">Stopping…</button>');
    expect(stopping).toContain('<span class="mono">alex</span>');
    expect(stopping).not.toMatch(/\bStopped\b/);
    expect(controlOf(await page(cookie, "/chat/task-status?task=payouts"))).toContain('data-task-control="stopping"');
    // Repeated (as the Building card's own Stop posts it, return=task): the same request, nothing new, back on the task page.
    const again = await post(cookie, "/t/payouts/stop", { csrf, run: String(runId), return: "task" });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/t/payouts#task-control");
    expect(store.stopsForTask(ref)).toHaveLength(1);
    // Resume is refused while stopping — even armed directly.
    const early = await post(cookie, "/t/payouts/resume-arm", { csrf, run: String(runId) });
    expect(early.status).toBe(409);
    expect(await early.text()).toContain("still stopping");

    // Settlement (the worker's fenced seal): Paused with a Resume form.
    finalize(store, leaseId, { kind: "interrupted", runId, taskId: "payouts", stopRun: runId, now: new Date() });
    const paused = controlOf(await page(cookie, "/t/payouts"));
    expect(paused).toContain('data-task-control="paused"');
    expect(paused).toContain(`<input type="hidden" name="run" value="${runId}">`);
    expect(paused).toMatch(/<form method="post" action="\/t\/payouts\/resume-arm" class="inline task-control-form task-resume-form">/);
    expect(paused).toContain(">Resume</button>");
    expect(paused).toContain("preserved");
    expect(controlOf(await page(cookie, "/chat?task=payouts"))).toContain('data-task-control="paused"');
  });

  test("chat proposals stop once and open the shared resume ceremony without granting resume authority", async () => {
    const { executeMateTool } = await import("./mate-tools.js");
    const { verifyApproverStanding } = await import("./principal.js");
    const { subscriptionCredentialKey } = await import("./converse.js");
    const ref = seed("payouts"), { runId, leaseId } = live("payouts", ref);
    const now = new Date();
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [resolve("/repo/main")]);
    if (!verified.ok) throw new Error(verified.reason);
    const who = verified.who, credentialKey = subscriptionCredentialKey("codex-subscription");
    const session = store.mintMateSession({ approver: "alex", approverGeneration: who.generation, credentialKey, ceilingMicrousd: 0, ceilingDigest: who.ceilingDigest, termsDigest: "test" }, now);
    const thread = store.openMateThread("alex", who.ceilingDigest, now).thread;
    const make = (operation: "stop" | "resume") => {
      const opened = store.openMateTurn({ approver: "alex", session, thread: thread.id, credentialKey, reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 0, deadlineMs: 60_000 }, now);
      if (!opened.ok) throw new Error(opened.reason);
      const started = store.startMateTurn(opened.id, now);
      if (!started.ok) throw new Error("start failed");
      let id = 0;
      const made = executeMateTool({ store, who, now, step: 1, readDecisions: new Map(), draft: (kind, payload) => {
        id = store.draftMateProposal({ thread: thread.id, turn: opened.id, kind, payload, ceilingDigest: who.ceilingDigest }, now); return id;
      } }, "propose_task_action", { task: "payouts", operation, run: runId });
      expect(made).toMatchObject({ ok: true });
      store.finalizeMateTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 1, tokensOut: 1 }, now);
      return id;
    };
    const cookie = await loginAs("alex", approverToken), csrf = csrfOf(await page(cookie, "/t/payouts"));
    const stop = make("stop"), staleStop = make("stop");
    expect(store.stopOf(runId)).toBeNull();
    expect((await post(cookie, `/chat/proposal/${stop}/confirm`, { csrf: "bad" })).status).toBe(403);
    expect(store.stopOf(runId)).toBeNull();
    expect((await post(cookie, `/chat/proposal/${stop}/confirm`, { csrf })).status).toBe(303);
    expect(store.getMateProposal(stop)?.outcome).toMatchObject({ said: expect.stringContaining("Stop requested") });
    expect(store.stopOf(runId)?.settledAt).toBeNull();
    await post(cookie, `/chat/proposal/${stop}/confirm`, { csrf });
    await post(cookie, `/chat/proposal/${staleStop}/confirm`, { csrf });
    expect(store.stopsForTask(ref)).toHaveLength(1);
    expect(store.getMateProposal(staleStop)?.state).toBe("refused");
    finalize(store, leaseId, { kind: "interrupted", runId, taskId: "payouts", stopRun: runId, now });
    const resume = make("resume");
    const armed = await post(cookie, `/chat/proposal/${resume}/confirm`, { csrf });
    expect(armed.status).toBe(200);
    const ceremony = await armed.text();
    expect(ceremony).toContain('action="/t/payouts/resume"');
    expect(ceremony).toContain('name="return" value="chat"');
    expect(store.stopOf(runId)?.resumedAt).toBeNull();
    const nonce = /name="nonce" value="([A-Za-z0-9_-]+)"/.exec(ceremony)![1]!;
    expect((await post(cookie, "/t/payouts/resume", { csrf, run: String(runId), nonce, token: "wrong" })).status).toBe(403);
    expect(store.stopOf(runId)?.resumedAt).toBeNull();
    expect((await post(cookie, "/t/payouts/resume", { csrf, run: String(runId), nonce, token: approverToken, return: "chat" })).headers.get("location")).toBe("/chat?task=payouts#task-control");
    expect((await post(cookie, "/t/payouts/resume", { csrf, run: String(runId), nonce, token: approverToken })).status).toBe(409);
    expect(store.runsFor(ref)).toHaveLength(1);
  });

  test("c8: stop is an approver's browser act — viewer, bearer, missing csrf, a finished run, another task's run, and a foreign project are refused", async () => {
    const ref = seed("payouts");
    const { runId, leaseId } = live("payouts", ref);
    const otherRef = seed("elsewhere", resolve("/repo/other"));
    const other = live("elsewhere", otherRef);
    const alex = await loginAs("alex", approverToken);
    const csrf = csrfOf(await page(alex, "/t/payouts"));

    // A viewer sees the control disabled and cannot post it.
    const vera = await loginAs("vera", viewerToken);
    const viewerHtml = await page(vera, "/t/payouts");
    const viewerControl = controlOf(viewerHtml);
    expect(viewerControl).toContain('data-task-control="stop"');
    const veraStop = await post(vera, "/t/payouts/stop", { csrf: csrfOf(viewerHtml), run: String(runId) });
    expect(veraStop.status).toBe(403);
    expect(await veraStop.text()).toContain("approver");
    // Bearer callers are machines; stopping is a session's act.
    const bearer = await fetch(url("/t/payouts/stop"), { method: "POST", headers: { authorization: `Bearer alex:${approverToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ run: String(runId) }), redirect: "manual" });
    expect(bearer.status).toBe(403);
    // A stale form (wrong csrf) is refused before anything is read.
    expect((await post(alex, "/t/payouts/stop", { csrf: "0".repeat(64), run: String(runId) })).status).toBe(403);
    // A run from another task, named against this one.
    const wrongTask = await post(alex, "/t/payouts/stop", { csrf, run: String(other.runId) });
    expect(wrongTask.status).toBe(409);
    expect(await wrongTask.text()).toContain("not one of this task");
    // A task outside the server's project is not visible at all.
    expect((await post(alex, "/t/elsewhere/stop", { csrf, run: String(other.runId) })).status).toBe(404);
    // Nothing above stopped anything.
    expect(store.stopOf(runId)).toBeNull();
    expect(store.stopOf(other.runId)).toBeNull();
    // A finished run refuses; its completion stands.
    store.transact(() => {
      store.finishRun(runId, { outcome: "built", committed: true, now: new Date() });
      store.raw().prepare("UPDATE claim SET released_at = ?, released_by = 'completed' WHERE lease_id = ?").run(new Date().toISOString(), leaseId);
      store.setTaskState("payouts", "done", new Date());
    });
    const late = await post(alex, "/t/payouts/stop", { csrf, run: String(runId) });
    expect(late.status).toBe(409);
    expect(await late.text()).toContain("already ended");
    expect(store.getTask("payouts")?.state).toBe("done");
    expect(store.stopOf(runId)).toBeNull();
  });

  test("c8: resume is the password ceremony over a durable nonce — wrong password, a spent nonce, a changed approval, and a stale run are refused; the right one lifts only the stop's hold", async () => {
    const ref = seed("payouts");
    const { runId, leaseId } = live("payouts", ref);
    store.hold(ref, "an operator pause that must survive", null, T0);
    const alex = await loginAs("alex", approverToken);
    const csrf = csrfOf(await page(alex, "/t/payouts"));
    expect((await post(alex, "/t/payouts/stop", { csrf, run: String(runId) })).status).toBe(303);
    finalize(store, leaseId, { kind: "interrupted", runId, taskId: "payouts", stopRun: runId, now: new Date() });

    // Arm: the ceremony page restates the exact run and carries a fresh nonce.
    const armed = await post(alex, "/t/payouts/resume-arm", { csrf, run: String(runId) });
    expect(armed.status).toBe(200);
    const ceremony = await armed.text();
    expect(ceremony).toContain(`Run #${runId}`);
    expect(ceremony).toContain("Resume task?");
    expect(ceremony).toContain('<label>Confirm with your password<input type="password" name="token" autocomplete="current-password"></label>');
    expect(ceremony).toContain("fresh evidence");
    expect(ceremony).toContain("no new approval");
    const nonce = /name="nonce" value="([A-Za-z0-9_-]+)"/.exec(ceremony)?.[1];
    if (nonce === undefined) throw new Error("no nonce on the ceremony");
    // Wrong password: refused, nonce untouched.
    const wrong = await post(alex, "/t/payouts/resume", { csrf, run: String(runId), nonce, token: "not-it" });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).toContain("password");
    expect(store.stopOf(runId)?.resumedAt).toBeNull();
    // A viewer with a stolen nonce is refused as a viewer.
    const vera = await loginAs("vera", viewerToken);
    expect((await post(vera, "/t/payouts/resume", { csrf: csrfOf(await page(vera, "/t/payouts")), run: String(runId), nonce, token: viewerToken })).status).toBe(403);
    // The approval changes between reading and confirming: the digest moved, the nonce cannot confirm.
    propose(store, { taskId: "payouts", goal: "harden payouts differently", now: new Date() });
    const moved = await post(alex, "/t/payouts/resume", { csrf, run: String(runId), nonce, token: approverToken });
    expect(moved.status).toBe(409);
    expect(await moved.text()).toContain("stale");
    expect(store.stopOf(runId)?.resumedAt).toBeNull();
    expect(store.activeHolds(ref, new Date()).map(one => one.ownerKind).sort()).toEqual(["operator", "stop"]);
    // Re-armed over the current facts: the right password resumes; only the stop's hold lifts.
    const rearmed = await post(alex, "/t/payouts/resume-arm", { csrf, run: String(runId) });
    expect(rearmed.status).toBe(200);
    const fresh = /name="nonce" value="([A-Za-z0-9_-]+)"/.exec(await rearmed.text())?.[1] as string;
    const resumed = await post(alex, "/t/payouts/resume", { csrf, run: String(runId), nonce: fresh, token: approverToken });
    expect(resumed.status).toBe(303);
    expect(resumed.headers.get("location")).toBe("/t/payouts#task-control");
    expect(store.stopOf(runId)).toMatchObject({ resumedBy: "alex", resumedVia: "web" });
    expect(store.activeHolds(ref, new Date()).map(one => one.ownerKind)).toEqual(["operator"]);
    // The spent nonce replayed: refused, nothing changes.
    const replay = await post(alex, "/t/payouts/resume", { csrf, run: String(runId), nonce: fresh, token: approverToken });
    expect(replay.status).toBe(409);
    expect(store.activeHolds(ref, new Date()).map(one => one.ownerKind)).toEqual(["operator"]);
    // The control is gone; the page shows the remaining pause honestly.
    expect(controlOf(await page(alex, "/t/payouts"))).toBe("");
    // A stale arm for a run that is no longer the paused attempt is refused.
    const stale = await post(alex, "/t/payouts/resume-arm", { csrf, run: String(runId) });
    expect(stale.status).toBe(409);
  });

  test("c8: a stopped historical review retains its stop and source result without offering retry or resume", async () => {
    const ref = seed("payouts");
    const { runId, leaseId } = live("payouts", ref);
    store.transact(() => {
      store.finishRun(runId, { outcome: "built", committed: true, now: new Date() });
      store.raw().prepare("UPDATE claim SET released_at = ?, released_by = 'completed' WHERE lease_id = ?").run(new Date().toISOString(), leaseId);
      store.setTaskState("payouts", "done", new Date());
    });
    const inserted = store.raw()
      .prepare("INSERT INTO run (task_ref, lease_id, runner, role, provider, parent_run, review_attempt, started_at) VALUES (?, 'review-lease', 'mac-mini', 'reviewer', 'claude', ?, 1, ?)")
      .run(ref, runId, new Date().toISOString());
    const reviewRun = Number(inserted.lastInsertRowid);
    const alex = await loginAs("alex", approverToken);
    const html = await page(alex, "/t/payouts");
    expect(controlOf(html)).toContain(`data-control-run="${reviewRun}"`);
    expect(controlOf(html)).toContain("review #");
    expect((await post(alex, "/t/payouts/stop", { csrf: csrfOf(html), run: String(reviewRun) })).status).toBe(303);
    store.finishRun(reviewRun, { outcome: "failed", reason: "interrupted", now: new Date(), stopSettlement: "interrupted" });
    const after = await page(alex, "/t/payouts");
    expect(after).toContain('data-task-control="review-stopped"');
    expect(after).toContain('<summary>Previous assessment stopped</summary>');
    expect(after).toContain(`Run #${reviewRun} was stopped by alex.`);
    expect(after).not.toMatch(/Review again|action="[^"]*retry-review|>Resume<\/button>/);
    expect(after).toContain(`href="/r/${runId}"`);
    expect((await fetch(url(`/r/${runId}`), { headers: { cookie: alex } })).status).toBe(200);
    expect(store.stopOf(reviewRun)).toMatchObject({ requestedBy: "alex", requestedVia: "web", settlement: "interrupted" });
    expect(store.stopOf(reviewRun)?.settledAt).not.toBeNull();
    expect(store.getRun(runId)?.outcome).toBe("built");
    expect((await post(alex, "/t/payouts/resume-arm", { csrf: csrfOf(html), run: String(reviewRun) })).status).toBe(409);
  });
});
