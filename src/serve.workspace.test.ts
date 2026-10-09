/**
 * The console server: the workspace — one navigation shell, Work views and
 * one truthful status projection.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { DEPRECATED_PAGE } from "./deprecations.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { acquire, release } from "./claim.js";
import { register } from "./runner.js";
import { addApprover, approve, hashPassword, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { createDecisionServer, earlierVersionsWords } from "./serve.js";
import { assignmentOf } from "./assignment.js";
import { Window } from "happy-dom";
import { presented, stylesOf, workspaceOf, sealScopeFixture } from "../test/serve-kit.js";
import { handoffBytes } from "../test/handoff-fixture.js";
import type { BrowserWorkspace } from "./browser-workspace.js";
import { workIndexPage } from "./work-index.js";

describe("workspace package 1: one navigation shell, Work views, and one truthful status projection", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let root: string;
  let alpha: string;
  let beta: string;
  let approverToken: string;
  const now = new Date("2026-09-13T12:00:00.000Z");
  const memberPassword = "member-password-1234";
  const url = (path: string): string => `${base}${path}`;
  const login = async (name = "alex", token = approverToken): Promise<string> => {
    const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };
  const page = async (cookie: string, path: string): Promise<string> => (await fetch(url(path), { headers: { cookie } })).text();
  const csrfOf = (html: string): string => /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
  const openProject = async (cookie: string, path: string): Promise<void> => {
    const csrf = csrfOf(await page(cookie, "/projects"));
    const response = await fetch(url("/projects/open"), { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, path, return: "/work" }), redirect: "manual" });
    expect(response.status).toBe(303);
  };
  /** The switcher's session-only pick — the one project verb a
   * project-scoped account may use. */
  const selectProject = async (cookie: string, path: string): Promise<void> => {
    const csrf = csrfOf(await page(cookie, "/projects"));
    const response = await fetch(url("/projects/select"), { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, path, return: "/work" }), redirect: "manual" });
    expect(response.status).toBe(303);
  };
  const seedTask = (id: string, title: string, repo: string): number => {
    store.createTask({ id, title }, new Date(now.getTime() - 3_600_000));
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo);
    return ref;
  };
  /** A finished built run with the verdict the plane would have stored. */
  const finished = (id: string, title: string, repo: string, verdict: { verdict: "verified" | "attested" | "short" | "refuted"; reasons: string[] } | null, extra: { accept?: string; publication?: { pr: number; remote?: string } } = {}): { ref: number; run: number } => {
    const ref = seedTask(id, title, repo);
    sealScopeFixture(store, id, approverToken, `do ${title}`);
    const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "night-shift-1", provider: "claude", branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: new Date(now.getTime() - 1_800_000), ...presented(store, ref, "builder") });
    storeEvidence(store, root, run, "terminal-diff", "terminal-diff.patch", Buffer.from("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", "utf8"), "git diff --no-ext-diff 0000..HEAD (exit 0)", now, { captureStatus: "ok" });
    storeEvidence(store, root, run, "handoff", "handoff.json", handoffBytes(run, { conclusion: `Finished ${title}.`, changes: [], verification: [], followUps: [] }), "composed at completion", now);
    store.finishRun(run, { outcome: "built", committed: true, now: new Date(now.getTime() - 1_200_000) });
    if (verdict !== null) store.saveProofVerdict(run, verdict.verdict, verdict.reasons, now);
    store.setTaskState(id, "done", new Date(now.getTime() - 1_200_000));
    if (extra.accept !== undefined) store.acceptProof(run, "alex", extra.accept, now);
    if (extra.publication !== undefined) {
      const publication = store.createPublicationIntent({ run, taskRef: ref, githubRepo: "owner/repo", remote: "origin", base: "main", head: `standing-orders/${id}`, headSha: "a".repeat(40), bodyHash: "b".repeat(64), draft: false }, now);
      store.markPublicationPushed(publication, now);
      store.markPublicationOpened(publication, extra.publication.pr, `https://github.com/owner/repo/pull/${extra.publication.pr}`, now);
      if (extra.publication.remote !== undefined) store.recordPublicationRemoteState(publication, extra.publication.remote, now);
    }
    return { ref, run };
  };
  // A status line, or a result's shared headline (task-status.ts), which replaces its status line.
  const statusOf = (html: string): { token: string; label: string }[] =>
    [...html.matchAll(/<span class="status-line" data-work-status="([^"]+)" data-tone="[a-z]+"><i class="status-dot" aria-hidden="true"><\/i><span class="status-label">([^<]+)<\/span>|<h2 class="status-headline" data-work-status="([^"]+)"><i aria-hidden="true"><\/i>([^<]+)<\/h2>/g)]
      .map(m => ({ token: (m[1] ?? m[3]) as string, label: (m[2] ?? m[4]) as string }));
  const rowsOf = (html: string): { id: string; token: string; views: string[]; label: string }[] =>
    [...html.matchAll(/<article class="work-row" data-task="([^"]+)" data-work-status="([^"]+)" data-work-views="([^"]+)">[\s\S]*?<span class="status-label">([^<]+)<\/span>/g)].map(m => ({ id: m[1] as string, token: m[2] as string, views: (m[3] as string).split(" "), label: m[4] as string }));
  const countsOf = (html: string): Record<string, number> =>
    Object.fromEntries([...(/<nav class="work-views"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? "").matchAll(/>([A-Za-z ]+)<span class="count">(\d+)<\/span>/g)].map(m => [m[1] as string, Number(m[2])]));

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "so-workspace-1-")));
    alpha = join(root, "alpha");
    beta = join(root, "beta");
    mkdirSync(alpha);
    mkdirSync(beta);
    // Opening a project requires a repository, not merely a configured path.
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: alpha });
    execSync("git init -q", { cwd: beta });
    store = openStore(":memory:");
    for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", now);
    const added = addApprover(store, "alex", now);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot: root, repos: [alpha, beta], clock: () => now });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("an unanswered question stays primary in Work and the task page when the builder disconnects", async () => {
    const ref = seedTask("t-question", "Choose a retry policy", alpha);
    sealScopeFixture(store, "t-question", approverToken, "Choose a retry policy");
    const earlier = new Date(now.getTime() - 3_600_000);
    register(store, { name: "worker", host: "test", repos: [alpha], capacity: 1, now: earlier });
    const run = store.startRun({ taskRef: ref, leaseId: "question-lease", runner: "worker", branch: "task/question", worktree: "/pool/question", now: earlier, ...presented(store, ref, "builder") });
    const decision = store.saveDecision({ run, urgency: "blocking", recap: "Set a limit for failed webhook deliveries.", question: "Should failed webhooks retry three times?", options: [{ id: "three", label: "Three retries", consequence: "Keeps the existing idempotency key.", reversible: true }], recommendation: "three", deadline: null }, earlier);
    store.finishRun(run, { outcome: "parked", now: earlier });
    const cookie = await login();
    const work = await page(cookie, "/work");
    expect(work).toContain(`class="work-action" data-primary-action href="/d/${decision}">Answer the question →</a>`);
    expect(work).toContain('data-work-status="assignment-needs-decision"');
    const task = await page(cookie, "/t/t-question");
    expect(task).toContain('data-work-diagnostic="no-worker-online"');
    expect(task).toContain(`href="/d/${decision}" data-primary-action>Answer the question</a>`);
    expect(task).toContain('id="task-questions"');
  });

  test("a requirement only a person can confirm reads as plain words with one Accept that returns to Chat", async () => {
    const reasons = ['criterion "c1" requires manual-review evidence — an operator must accept it before this can verify'];
    const { run } = finished("t-copy", "Confirm empty-state copy", alpha, { verdict: "short", reasons });
    store.saveProofVerdict(run, "short", reasons, now, [{ id: "c1", statement: "Empty state is clear", requiredEvidence: ["manual-review"], state: "manual-review", detail: [], answered: [], review: null }]);
    const cookie = await login();
    const chat = await page(cookie, `/chat?task=t-copy&result=${run}`);
    const youCheck = /<div class="result-you-check" data-result-you-check="1">[\s\S]*?<\/div>/.exec(chat)?.[0] ?? "";
    expect(youCheck).toContain("<li>You check this one: Empty state is clear</li>");
    // The one Accept leads, as the Needs you action: the task page's action sends the person here, never back.
    const need = /<div class="result-action" data-result-action="need">[\s\S]*?<\/div>/.exec(chat)?.[0] ?? "";
    expect(need).toContain('action="/t/t-copy/accept-proof"');
    expect(need).toContain("data-accept-result style=\"min-height:44px\">Accept result</button>");
    expect(need).not.toContain('name="note"');
    expect(chat.match(/<button[^>]*data-accept-result/g)).toHaveLength(1);
    // Said once, in a person's words: never the record's criterion vocabulary.
    expect(chat.match(/<li>You check this one/g)).toHaveLength(1);
    for (const html of [chat, await page(cookie, "/t/t-copy")]) {
      expect(html).not.toContain("requires manual-review evidence");
      expect(html).not.toContain("an operator must accept");
    }
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(need)?.[1] ?? "";
    const back = /name="return" value="([^"]+)"/.exec(need)?.[1]?.replaceAll("&amp;", "&") ?? "";
    expect(back).toBe(`/chat?task=t-copy&result=${run}`);
    const accepted = await fetch(url("/t/t-copy/accept-proof"), { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, run: String(run), return: back }), redirect: "manual" });
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe(back);
    expect(await page(cookie, back)).not.toContain('class="result-you-check"');
  });

  test("All projects opens the exact review result without changing the selected project", async () => {
    const reasons = ['criterion "c1" requires manual-review evidence — an operator must accept it before this can verify'];
    const { run } = finished("t-navigation", "Confirm empty-state copy", beta, { verdict: "short", reasons });
    store.saveProofVerdict(run, "short", reasons, now, [{ id: "c1", statement: "Empty state is clear", requiredEvidence: ["manual-review"], state: "manual-review", detail: [], answered: [], review: null }]);
    const cookie = await login();
    const work = await page(cookie, "/work");
    const row = /<article class="work-row" data-task="t-navigation"[^>]*>([\s\S]*?)<\/article>/.exec(work)?.[1] ?? "";
    const link = /class="work-action" data-primary-action href="([^"]+)"/.exec(row)?.[1]?.replaceAll("&amp;", "&") ?? "";
    // The one result page's address names the task and its run, never a project path.
    expect(link).toBe(`/review?result=t-navigation&run=${run}`);
    expect(row).toContain(">Open result →</a>");
    const signedOut = await fetch(url(link), { redirect: "manual" });
    expect(signedOut.headers.get("location")).toBe(`/login?return=${encodeURIComponent(link)}`);
    const signIn = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken, return: link }), redirect: "manual" });
    expect(signIn.headers.get("location")).toBe(link);
    const response = await fetch(url(link), { headers: { cookie }, redirect: "manual" });
    expect(response.status).toBe(200);
    const review = await response.text();
    expect(review).toContain(`data-result-run="${run}"`);
    // The project switch keeps the person's own choice (All projects), not the result's project.
    expect(review).toContain('<span class="name">All projects');
    expect(review).not.toContain("Check completed builds against their approved scope and evidence.");
    expect(review).not.toContain(`<span class="eyebrow">Build #${run}</span>`);
    expect(review).toContain(`Build #${run}`);
    expect(review).toContain(`name="return" value="/review?result=t-navigation&amp;run=${run}"`);
    expect(review).not.toContain('<p class="meta board-view">');
    expect(review).not.toContain('class="badge badge-manual-review review-priority"');
    expect(review).not.toContain('human review needed');
    expect(review).not.toContain('Review before accepting');
    expect(review).not.toContain('Inspect the saved screenshots and requirements.');
    expect(review).not.toContain('data-next-action="accept-proof"');
    expect(review).toContain('Empty state is clear');
    expect(review).not.toContain('class="cockpit-accept-form"');
    expect(review).toContain('data-result-tab="checks"');
    const queueLink = /class="cockpit-row current" href="([^"]+)"/.exec(review)?.[1]?.replaceAll("&amp;", "&");
    expect(queueLink).toBe(link);
    const reviewCss = await stylesOf(review, base);
    expect(reviewCss).toContain('.result-panel .pick-file, .result-panel .pick-line, .diff-modes button { min-height: 44px; min-width: 44px; white-space: nowrap; }');
    expect(await page(cookie, "/work")).toContain('<span class="name">All projects');
    // Old task-only links also resolve their authorized project without a switch.
    const old = await fetch(url("/review?result=t-navigation"), { headers: { cookie }, redirect: "manual" });
    expect(old.status).toBe(200);
    expect(await old.text()).toContain('data-review-task="t-navigation"');
    await openProject(cookie, alpha);
    const elsewhere = await fetch(url(link), { headers: { cookie }, redirect: "manual" });
    expect(elsewhere.status).toBe(200);
    expect(await elsewhere.text()).toContain('<summary class="name">alpha');
    expect(await page(cookie, "/work")).toContain('<summary class="name">alpha');
    // A stale run or a mismatched project must never silently select another result.
    expect((await fetch(url(link.replace(`run=${run}`, `run=${run + 1}`)), { headers: { cookie } })).status).toBe(409);
    expect((await fetch(url(`${link}&project=${encodeURIComponent(alpha)}`), { headers: { cookie } })).status).toBe(404);
    const invite = store.mintInvite("approver", "alex", now, undefined, [alpha]);
    expect(store.consumeInviteAndCreateAccount({ tokenValue: invite.token, name: "member", credentialHash: hashPassword(memberPassword) }, now).ok).toBe(true);
    const member = await login("member", memberPassword);
    const denied = await fetch(url(link), { headers: { cookie: member } });
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("Confirm empty-state copy");
  });

  test("project selection preserves the requested destination and rejects unsafe return paths", async () => {
    const cookie = await login();
    const pending = await fetch(url("/tasks?state=done"), { headers: { cookie }, redirect: "manual" });
    expect(pending.status).toBe(303);
    expect(pending.headers.get("location")).toBe("/projects?return=%2Ftasks%3Fstate%3Ddone");
    const picker = await page(cookie, pending.headers.get("location")!);
    const window = new Window();
    try {
      window.document.body.innerHTML = picker;
      const button = [...window.document.querySelectorAll('button.project-name')].find(one => one.textContent === "beta")!;
      const form = button.closest("form")!;
      expect(form.querySelector('input[name="return"]')?.getAttribute("value")).toBe("/tasks?state=done");
      const csrf = csrfOf(picker);
      const invalid = await fetch(url("/projects/open"), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, path: "/no/such/project", return: "/tasks?state=done" }) });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain('name="return" value="/tasks?state=done"');
      const selected = await fetch(url(form.getAttribute("action")!), { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, path: beta, return: "/tasks?state=done" }), redirect: "manual" });
      expect(selected.headers.get("location")).toBe("/tasks?state=done");
      for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil.example/", "/%2f%2fevil.example/"]) {
        const unsafe = await page(cookie, `/projects?return=${encodeURIComponent(bad)}`);
        window.document.body.innerHTML = unsafe;
        expect(window.document.querySelector('button.project-name')?.closest("form")?.querySelector('input[name="return"]')?.getAttribute("value")).toBe("/");
      }
    } finally { await window.happyDOM.close(); }
  });

  test("Chat, Tasks, Flows, and Projects are the only primary destinations on desktop and phone; every old page lights Work; tools and settings stay reachable and role-bounded", async () => {
    seedTask("t-a", "alpha work", alpha);
    const cookie = await login();
    await openProject(cookie, alpha);
    const primaryOf = (html: string): string[] => [...(/<aside class="side">.*?<nav>(.*?)<\/nav>/s.exec(html)?.[1] ?? "").matchAll(/<a href="([^"]+)"/g)].map(m => m[1] as string);
    const tabsOf = (html: string): string[] => [...(/<nav class="tabbar">(.*?)<\/nav>/s.exec(html)?.[1] ?? "").matchAll(/<a href="([^"]+)"/g)].map(m => m[1] as string);
    const activeOf = (html: string): string | undefined => /<aside class="side">.*?<nav>.*?<a href="([^"]+)"[^>]*class="active" aria-current="page"/s.exec(html)?.[1];
    // Old routes, query parameters, and deep links all still answer, and
    // every one of them lights the destination it now lives under.
    for (const [path, expected] of [
      ["/", "/chat"], ["/inbox", "/work"], ["/work", "/work"], ["/work?view=needs-you", "/work"], ["/tasks", "/work"], ["/tasks?state=queued", "/work"], ["/board", "/work"], ["/board?view=order", "/work"],
      ["/runs", "/work"], ["/done", "/work"], ["/review", "/work"], ["/activity", "/work"], ["/t/t-a", "/work"], ["/recipes", "/work"], ["/ledger", "/work"], ["/workbench", "/work"],
      ["/projects", "/projects"], ["/code", "/work"], ["/chat", "/chat"], ["/chat?task=t-a", "/chat"], ["/fleet", undefined], ["/system", undefined], ["/caps", undefined], ["/people", undefined], ["/menu", undefined],
    ] as const) {
      const response = await fetch(url(path), { headers: { cookie } });
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(primaryOf(html), path).toEqual(["/chat", "/work", "/flows", "/projects"]);
      expect(tabsOf(html), path).toEqual(["/chat", "/work", "/flows", "/projects"]);
      expect(activeOf(html), path).toBe(expected);
      expect(html, path).toContain('<a class="mobile-more" href="/menu" aria-label="tools and settings"');
      for (const gone of [">inbox</a>", ">builds</a>", ">board</a>"]) expect(/<nav>(.*?)<\/nav>/s.exec(html)?.[1] ?? "", path).not.toContain(gone);
      // D5: coding sessions and team chat are deprecated: /code says so first, and nothing links to either.
      if (path === "/code") expect(html).toContain(`data-deprecated="session">${DEPRECATED_PAGE.session}</p>`);
      expect(html, path).not.toContain('href="/code"');
      expect(html, path).not.toContain('href="/chat?team=1"');
    }
    // The settings group lights on its own pages, with the same rows the
    // admin group carried before.
    const fleet = await page(cookie, "/fleet");
    expect(/<details class="nav-group" data-group="settings"([^>]*)>/.exec(fleet)?.[1]).toBe(" open");
    expect(fleet).toContain('<a href="/fleet" aria-label="Fleet" title="Fleet" class="active">Fleet</a>');
    const menu = await page(cookie, "/menu");
    expect([...menu.matchAll(/<a class="menu-row" href="([^"]+)">/g)].map(m => m[1])).toEqual(["/inbox", "/board", "/tasks", "/recipes", "/workbench", "/ledger", "/spend", "/settings", "/fleet", "/caps", "/people", "/mode", "/system"]);
    // The queue's old address still answers as before.
    const queue = await fetch(url("/queue"), { headers: { cookie }, redirect: "manual" });
    expect(queue.status).toBe(303);
    expect(queue.headers.get("location")).toBe("/board?view=order");

    // A project-scoped login sees the SAME reduced tools it saw before —
    // no portfolio, fleet/requirements/mode/system or chat; project Learning is available.
    const minted = store.mintInvite("approver", "alex", now, undefined, [alpha]);
    expect(store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "member", credentialHash: hashPassword(memberPassword) }, now).ok).toBe(true);
    const member = await login("member", memberPassword);
    const memberHome = await fetch(url("/"), { headers: { cookie: member }, redirect: "manual" });
    expect(memberHome.status).toBe(303);
    expect(memberHome.headers.get("location")).toBe("/work");
    const memberWork = await page(member, "/work");
    expect(memberWork).toContain('class="brand" href="/work"');
    expect(memberWork).toContain('class="brand-mini" href="/work"');
    expect(primaryOf(memberWork)).toEqual(["/work", "/flows", "/projects"]);
    expect(tabsOf(memberWork)).toEqual(["/work", "/flows", "/projects"]);
    const memberMenu = await page(member, "/menu");
    expect([...memberMenu.matchAll(/<a class="menu-row" href="([^"]+)">/g)].map(m => m[1])).toEqual(["/inbox", "/board", "/tasks", "/recipes", "/ledger", "/settings", "/people"]);
    expect(memberMenu).toContain("/settings");
    expect((await fetch(url("/settings"), { headers: { cookie: member } })).status).toBe(200);
    for (const path of ["/code", "/fleet", "/system", "/caps", "/workbench", "/chat"]) expect((await fetch(url(path), { headers: { cookie: member } })).status, path).toBe(403);
  });

  test("the mobile menu reaches settings from All projects without changing the selected project or bypassing project and login guards", async () => {
    const cookie = await login();
    const get = (path: string) => fetch(url(path), { headers: { cookie }, redirect: "manual" });
    const home = await page(cookie, "/work");
    expect(home).toContain('<a class="mobile-more" href="/menu"');

    const menu = await get("/menu");
    expect(menu.status).toBe(200);
    expect(menu.headers.get("location")).toBeNull();
    expect(await menu.text()).toContain('<a class="menu-row" href="/settings">');
    expect((await get("/settings")).status).toBe(200);
    // Opening the menu must not silently select a project. Project-bound
    // pages still require a selection, including after returning from Settings.
    const tasks = await get("/tasks");
    expect(tasks.status).toBe(303);
    expect(tasks.headers.get("location")).toBe("/projects?return=%2Ftasks");
    await selectProject(cookie, alpha);
    expect((await get("/menu")).status).toBe(200);
    expect((await get("/tasks")).status).toBe(200);
    await selectProject(cookie, "");
    expect((await get("/menu")).status).toBe(200);

    const anonymous = await fetch(url("/menu"), { redirect: "manual" });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toContain("/login");
  });

  test("same task counts: an older live sibling counts once; released, expired and superseded claims do not look live", async () => {
    const original = finished("family-root", "One family", alpha, null);
    const older = seedTask("older-sibling", "Older", alpha);
    sealScopeFixture(store, "older-sibling", approverToken, "Earlier revision");
    const newest = finished("newest-sibling", "Newest", alpha, null);
    const brief = store.saveArtifact({ run: original.run, kind: "revision-brief", key: "fixture.json", bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "a".repeat(64), capture: "synthetic lineage fixture" }, now);
    store.markRevision(older, "family-root", brief);
    store.markRevision(newest.ref, "family-root", brief);
    register(store, { name: "family-worker", host: "here", capacity: 1, repos: [alpha], now, newToken: () => "family-token" });
    const claim = acquire(store, older, "family-worker", { token: "family-token", now });
    if (!claim.ok) throw new Error(claim.reason);
    const run = store.startRun({ taskRef: older, leaseId: claim.claim.leaseId, runner: "family-worker", branch: "fixture", worktree: join(root, "fixture"), now, ...presented(store, older) });
    store.setRunPhase(run, "verifying-proof");
    const cookie = await login(); await openProject(cookie, alpha);
    const live = await page(cookie, "/t/family-root");
    expect(live).toContain('<a href="/runs">1 live</a><a href="/board?view=order">0 queued</a>');
    expect(live).toContain('data-history-version="newest-sibling"');
    expect(live).toContain("1 earlier task version is still active");
    expect(await page(cookie, "/projects")).toContain('>1 running</a>');
    expect(countsOf(await page(cookie, "/work"))["Building"]).toBe(1);
    // A released or exactly expired lease cannot keep an orphaned run live.
    release(store, claim.claim.leaseId, now);
    expect(await page(cookie, "/t/family-root")).toContain('<a href="/runs">0 live</a>');
    store.raw().prepare("UPDATE claim SET released_at = NULL, expires_at = ? WHERE lease_id = ?").run(now.toISOString(), claim.claim.leaseId);
    expect(await page(cookie, "/t/family-root")).toContain('<a href="/runs">0 live</a>');
    // A live newest claim counts once even while an older open run survives.
    store.raw().prepare("UPDATE claim SET released_at = ? WHERE lease_id = ?").run(now.toISOString(), claim.claim.leaseId);
    const next = acquire(store, older, "family-worker", { token: "family-token", now });
    if (!next.ok) throw new Error(next.reason);
    expect(await page(cookie, "/t/family-root")).toContain('<a href="/runs">1 live</a>');
    release(store, next.claim.leaseId, now);
    // Resurrecting a stale lower-generation row cannot override the newest one.
    store.raw().prepare("UPDATE claim SET released_at = NULL, expires_at = ? WHERE lease_id = ?").run(new Date(now.getTime() + 60000).toISOString(), claim.claim.leaseId);
    expect(await page(cookie, "/t/family-root")).toContain('<a href="/runs">0 live</a>');
    expect(store.getTask("older-sibling")!.state).toBe("queued");
  });

  test("approving a newer version says an earlier one is still queued while it only waits, and running once it runs", () => {
    const original = finished("queue-root", "One family", alpha, null);
    const older = seedTask("queue-older", "Older", alpha);
    sealScopeFixture(store, "queue-older", approverToken, "Earlier revision");
    const newest = seedTask("queue-newest", "Newest", alpha);
    const brief = store.saveArtifact({ run: original.run, kind: "revision-brief", key: "fixture.json", bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "a".repeat(64), capture: "synthetic lineage fixture" }, now);
    store.markRevision(older, "queue-root", brief);
    store.markRevision(newest, "queue-root", brief);
    store.setTaskState("queue-older", "queued", now);
    const earlier = () => {
      const assignment = assignmentOf(store, "queue-root", now, { principal: "operator", repos: [alpha] }, root)!;
      expect(assignment.activeTaskId).toBe("queue-newest");
      return earlierVersionsWords(assignment.earlierActive ?? 0, assignment.earlierRunning ?? 0);
    };
    expect(earlier()).toBe("an earlier version is still queued");
    register(store, { name: "queue-worker", host: "here", capacity: 1, repos: [alpha], now, newToken: () => "queue-token" });
    const claim = acquire(store, older, "queue-worker", { token: "queue-token", now });
    if (!claim.ok) throw new Error(claim.reason);
    store.startRun({ taskRef: older, leaseId: claim.claim.leaseId, runner: "queue-worker", branch: "fixture", worktree: join(root, "fixture"), now, ...presented(store, older) });
    expect(earlier()).toBe("an earlier version is still running");
    expect(earlierVersionsWords(2, 1)).toBe("2 earlier versions are still queued or running");
    expect(earlierVersionsWords(0, 0)).toBeNull();
  });

  test("pilot 2: approval, queued, build/checks, stop, hold, rescope and failures share one status and primary action", async () => {
    const id = "t-status";
    const ref = seedTask(id, "Keep the full allowed path visible", alpha);
    const allowed = "docs/assessments/WORKSPACE_5_LONG_REQUEST_RESULT_2026-09-14.md";
    sealScopeFixture(store, id, approverToken, "Read the entire request.");
    const scope = store.getScope(id)!;
    propose(store, { taskId: id, goal: scope.goal, touches: [allowed], acceptance: scope.acceptance, now });
    const cookie = await login();
    await openProject(cookie, alpha);
    const readStanding = async (html: string, rowId?: string): Promise<{ label: string; token: string; action: string }> => {
      const window = new Window();
      try {
        window.document.body.innerHTML = html;
        const region = rowId === undefined ? window.document.querySelector('#task-chat-live') ?? window.document.querySelector('main')! : window.document.querySelector(`[data-task="${rowId}"].work-row`)!;
        const status = region.querySelector('[data-task-status], .completion-receipt .status-line, .work-row-status .status-line')!;
        const hidden = (el: Element): boolean => {
          let node = el;
          while (node.parentElement !== null) {
            if (node.parentElement.tagName === "DETAILS" && !node.parentElement.hasAttribute('open') && node.tagName !== "SUMMARY") return true;
            node = node.parentElement;
          }
          return false;
        };
        const actions = [...region.querySelectorAll('[data-primary-action], .work-action')].filter(el => !hidden(el));
        expect(actions).toHaveLength(1);
        const label = status.querySelector('h2, .status-label')!.textContent!;
        const headlines = [...region.querySelectorAll('h2, .status-label, .dispatch-copy > strong')].filter(el => !hidden(el) && el.textContent === label);
        expect(headlines).toHaveLength(1);
        return { token: status.getAttribute('data-work-status')!, label, action: actions[0]!.textContent!.replace(/ →$/, '') };
      } finally { await window.happyDOM.close(); }
    };
    // `act`: where the page itself resolves the wait (the approval sheet's
    // Approve & start), the opened task and chat show that act; the list and
    // the safe status fragment keep the navigation label.
    const agree = async (taskId: string, token: string, action?: string, act?: string): Promise<void> => {
      const work = await readStanding(await page(cookie, "/work"), taskId);
      const assignmentState = ["ready", "waiting-dependency", "running"].includes(token) ? "working" : "needs-decision";
      expect(work.token).toBe(`assignment-${assignmentState}`);
      // List metadata links to the exact result; opening it reads saved
      // checks and may name the particular failure or missing evidence.
      const recordedResult = ["checks-failed", "verification-needed"].includes(token);
      if (action !== undefined) expect(work.action).toBe(recordedResult ? "Open result" : action);
      const task = await readStanding(await page(cookie, `/t/${taskId}`));
      expect(task).toEqual({ ...work, action: act ?? action ?? work.action });
      for (const path of [`/chat?task=${taskId}`, `/chat/task-status?task=${taskId}`]) {
        const exactTask = await readStanding(await page(cookie, path));
        expect(exactTask.token, path).toBe(`assignment-${assignmentState}`);
        expect(exactTask.action, path).toBe(act !== undefined && path.startsWith("/chat/task-status") ? action ?? work.action : task.action);
      }
    };
    await agree(id, "needs-approval", "Approve plan", "Approve & start");
    const beforeApproval = await page(cookie, `/t/${id}`);
    expect(beforeApproval).toContain(`<p class="scope-paths"><strong>Touches</strong> ${allowed}</p>`);
    const css = await stylesOf(beforeApproval, base);
    expect(css).toContain('#scope .recap, #scope .scope-paths, .approval-goal { overflow-wrap: anywhere; }');
    expect(beforeApproval).toContain('<h1 class="task-main-title">Keep the full allowed path visible</h1>');
    approve(store, id, "alex", now, store.getScope(id)!.digest, approverToken);
    await agree(id, "no-worker-registered", "Connect a builder");
    const blocker = seedTask('t-before-status', 'First task', alpha);
    store.addEdge(id, 't-before-status');
    await agree(id, 'waiting-dependency', 'View task details');
    store.removeEdge(id, 't-before-status');
    void blocker;
    register(store, { name: "status-worker", host: "here", capacity: 1, repos: [alpha], now, newToken: () => "status-token" });
    await agree(id, "ready", "View task details");
    const claim = acquire(store, ref, "status-worker", { token: "status-token", now });
    if (!claim.ok) throw new Error(claim.reason);
    const run = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner: "status-worker", provider: "claude", branch: "standing-orders/t-status", worktree: join(root, "status-worktree"), now, ...presented(store, ref) });
    // Deliberately leave raw state queued, as in the live pilot.
    for (const phase of ["agent-running", "verifying-proof"] as const) {
      store.setRunPhase(run, phase);
      await agree(id, "running", "Watch the build");
      // Build #1586: a native claim leaves the row queued, including final checks.
      expect(store.getTask(id)!.state).toBe("queued");
      const taskPage = await page(cookie, `/t/${id}`);
      expect(taskPage).toContain('<a href="/runs">1 live</a><a href="/board?view=order">1 queued</a>');
      const projects = await page(cookie, "/projects");
      expect(projects).toContain('>1 running</a>');
      expect(projects).toContain('>1 queued</a>');
    }
    expect(store.requestRunStop({ runId: run, taskRef: ref, by: "alex", via: "web" }, now).ok).toBe(true);
    await agree(id, "stopping", "View stop details");
    store.finishRun(run, { outcome: "interrupted", reason: "stopped", now, stopSettlement: "interrupted" });
    release(store, claim.claim.leaseId, now);
    await agree(id, "stopped", "Review pause");
    // A separate held scope exercises approve -> change -> unhold, with
    // the original signature left intact and no copied approval state.
    const heldRef = seedTask('t-scope-status', 'Changed scope', alpha);
    sealScopeFixture(store, 't-scope-status', approverToken, 'Original request');
    store.hold(heldRef, 'Wait for names', null, now);
    await agree('t-scope-status', 'held', 'Review hold');
    const signed = store.getScope('t-scope-status')!;
    propose(store, { taskId: 't-scope-status', goal: 'Changed request', touches: signed.touches, acceptance: signed.acceptance, now });
    store.unhold(heldRef);
    await agree('t-scope-status', 'needs-approval', 'Approve plan', 'Approve & start');
    expect(store.getScope('t-scope-status')!.approvedDigest).toBe(signed.approvedDigest);
    store.setTaskState('t-scope-status', 'failed', now);
    await agree('t-scope-status', 'failed', 'Review and retry');
    finished('t-status-check', 'Failed check', alpha, { verdict: 'refuted', reasons: ["the repository's approved verification command exited 1"] });
    await agree('t-status-check', 'checks-failed', 'Open the failed check');
    finished('t-status-missing', 'Missing proof', alpha, null);
    await agree('t-status-missing', 'verification-needed', 'See what is missing');
    const oldResultScope = store.getScope('t-status-check')!;
    propose(store, { taskId: 't-status-check', goal: 'A new scope after the failed check', touches: oldResultScope.touches, acceptance: oldResultScope.acceptance, now });
    store.setTaskState('t-status-check', 'queued', now);
    await agree('t-status-check', 'needs-approval', 'Approve plan', 'Approve & start');
    expect(await page(cookie, '/t/t-status-check')).toContain('<details class="task-previous-result"><summary>Previous result</summary>');
  });

  test("pilot 2: a pending status refresh preserves focused controls, open details and dirty inputs; the composer keeps its draft and selection", async () => {
    seedTask('t-refresh-status', 'Refresh safely', alpha);
    sealScopeFixture(store, 't-refresh-status', approverToken, 'Keep the draft');
    const cookie = await login();
    await openProject(cookie, alpha);
    const html = await page(cookie, '/chat?task=t-refresh-status');
    const fragment = await page(cookie, '/chat/task-status?task=t-refresh-status');
    const window = new Window();
    try {
      window.document.body.innerHTML = html;
      const source = [...window.document.querySelectorAll('script[nonce]:not([type])')].map(one => one.textContent ?? "").find(text => text.includes('var taskLive=')) ?? "";
      const start = source.indexOf('var taskLive=');
      const end = source.indexOf('var box=', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const cycles: (() => void)[] = [];
      window.setTimeout = ((callback: () => void) => { cycles.push(callback); return 1; }) as typeof window.setTimeout;
      let requests = 0;
      let deliver!: (response: Response) => void;
      window.fetch = (() => { requests++; return new Promise<Response>(resolve => { deliver = resolve; }); }) as typeof window.fetch;
      const region = window.document.querySelector('#task-chat-live')!;
      const composer = window.document.createElement('textarea');
      window.document.body.append(composer);
      composer.value = 'An unsent chat draft';
      window.eval(source.slice(start, end));
      cycles.shift()!();
      expect(requests).toBe(1);
      const control = region.querySelector<HTMLAnchorElement>('[data-primary-action]')!;
      control.focus();
      deliver(new Response(fragment));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(window.document.querySelector('#task-chat-live')).toBe(region);
      expect(window.document.activeElement).toBe(control);
      control.blur();
      const details = region.querySelector('details')!;
      details.open = true;
      cycles.shift()!();
      expect(requests).toBe(1);
      details.open = false;
      const note = window.document.createElement('input');
      region.append(note); note.value = 'Unsubmitted decision note';
      cycles.shift()!();
      expect(requests).toBe(1);
      expect(note.value).toBe('Unsubmitted decision note');
      note.value = '';
      composer.focus(); composer.setSelectionRange(3, 8);
      cycles.shift()!();
      expect(requests).toBe(2);
      deliver(new Response(fragment));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(window.document.querySelector('#task-chat-live')).not.toBe(region);
      expect(window.document.activeElement).toBe(composer);
      expect(composer.value).toBe('An unsent chat draft');
      expect([composer.selectionStart, composer.selectionEnd]).toEqual([3, 8]);
      // A status refresh only GETs its fragment. No submit or model send.
      expect(source.slice(start, end)).not.toContain('requestSubmit');
    } finally { await window.happyDOM.close(); }
  });

  test("held-task CTAs explain the destination across Work, chat, and task details; only Remove hold releases it", async () => {
    const ref = seedTask("t-held", "Document the columns", alpha);
    sealScopeFixture(store, "t-held", approverToken, "document");
    store.hold(ref, "wait for the names to settle", null, now);
    const cookie = await login();
    await openProject(cookie, alpha);
    const work = await page(cookie, "/work");
    expect(work).toContain('<a class="work-action" data-primary-action href="/t/t-held?version=t-held#task-actions">Review hold →</a>');
    const chat = await page(cookie, "/chat?task=t-held");
    expect(chat).toContain('<a class="button-link" href="/t/t-held?version=t-held#task-actions" data-primary-action>Review hold</a>');
    const task = await page(cookie, "/t/t-held");
    expect(task).toContain('<a class="button-link" href="/t/t-held?version=t-held#task-actions" data-primary-action>Review hold</a>');
    expect(task).toContain('<details class="task-status-details" id="task-diagnostics" open>');
    expect(task).toContain('Use <strong>Remove hold</strong> when it can continue.');
    expect(task).toMatch(/action="\/t\/t-held\/unhold"[\s\S]*?<button type="submit">Remove hold<\/button>/);
    for (const html of [work, chat, task]) {
      expect(html).toContain("wait for the names to settle");
      expect(html).not.toContain("Open the next step");
    }
    // Viewing all three surfaces leaves the operator's hold intact.
    expect(rowsOf(await page(cookie, "/work"))[0]?.token).toBe("assignment-needs-decision");
    const response = await fetch(url("/t/t-held/unhold"), {
      method: "POST", headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf: csrfOf(task) }), redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(rowsOf(await page(cookie, "/work"))[0]?.token).not.toBe("held");
  });

  test("Work's All, Needs you, Running, and Complete views count and list queued, waiting, held, failed, cancelled, running, and every finished-evidence state truthfully, with meaningful empty states", async () => {
    // Nothing yet: All says so and offers the two ways in.
    const cookie = await login();
    await openProject(cookie, alpha);
    const empty = await page(cookie, "/work");
    expect(empty).toContain('data-work-empty="all"');
    expect(empty).toContain("Nothing is in progress.");
    expect(countsOf(empty)).toEqual({ All: 0, "Needs you": 0, Building: 0, Complete: 0 });
    expect(empty).toContain('<a href="/work" class="active" aria-current="page">All<span class="count">0</span></a>');

    // Approved and waiting for a builder; chained behind it; on hold;
    // failed; cancelled; running under a live claim; and finished builds.
    const builder = seedTask("t-builder", "Stream the CSV writer", alpha);
    sealScopeFixture(store, "t-builder", approverToken, "stream it");
    const chained = seedTask("t-chained", "Show export progress", alpha);
    sealScopeFixture(store, "t-chained", approverToken, "show progress");
    store.addEdge("t-chained", "t-builder");
    const held = seedTask("t-held", "Document the columns", alpha);
    sealScopeFixture(store, "t-held", approverToken, "document");
    store.hold(held, "wait for the names to settle", null, now);
    seedTask("t-failed", "Benchmark the export", alpha);
    store.setTaskState("t-failed", "failed", now);
    seedTask("t-cancelled", "Remove the old exporter", alpha);
    store.cancelTask("t-cancelled", now, "superseded");
    const live = seedTask("t-live", "Prove the DST boundary", alpha);
    sealScopeFixture(store, "t-live", approverToken, "prove it");
    register(store, { name: "night-shift-1", host: "here", capacity: 2, repos: [alpha], now, newToken: () => "tok-night-1" });
    const taken = acquire(store, live, "night-shift-1", { token: "tok-night-1", now, ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim refused");
    store.startRun({ taskRef: live, leaseId: taken.claim.leaseId, runner: "night-shift-1", provider: "claude", branch: "standing-orders/t-live", worktree: "/pool/t-live", now, ...presented(store, live, "builder") });
    store.setTaskState("t-live", "running", now);
    finished("t-checks", "Escape quotes", alpha, { verdict: "refuted", reasons: ["the repository's approved verification command exited 1"] });
    finished("t-mismatch", "Make the range inclusive", alpha, { verdict: "refuted", reasons: ["claimed changed path not in the sealed diff: src/ledger.ts"] });
    finished("t-missing", "Add subtotal rows", alpha, { verdict: "short", reasons: ["no proof was written"] });
    finished("t-attested", "Emit a BOM", alpha, { verdict: "attested", reasons: ["the proof agrees with the sealed diff; no verification command is configured to re-run"] });
    finished("t-accepted", "Keep the button reachable", alpha, { verdict: "short", reasons: ["no proof was written"] }, { accept: "checked by hand" });
    finished("t-verified", "Round at cent precision", alpha, { verdict: "verified", reasons: ["the approved verification command passed"] });
    finished("t-pr", "Handle DST", alpha, { verdict: "verified", reasons: ["the approved verification command passed"] }, { publication: { pr: 482 } });
    finished("t-merged", "Fix the timezone", alpha, { verdict: "verified", reasons: ["the approved verification command passed"] }, { publication: { pr: 479, remote: "MERGED" } });
    void builder; void chained;

    const all = await page(cookie, "/work");
    const rows = rowsOf(all);
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));
    expect(byId).toMatchObject({
      // Each row's one shared headline (task-status.ts); views and tokens are unchanged.
      "t-builder": { token: "assignment-working", views: ["all"], label: "Queued" },
      "t-chained": { token: "assignment-working", views: ["all"], label: "Queued" },
      "t-held": { token: "assignment-needs-decision", views: ["all", "needs-you"], label: "Stopped" },
      "t-failed": { token: "assignment-needs-decision", views: ["all", "needs-you"], label: "Failed" },
      "t-cancelled": { token: "assignment-cancelled", views: ["all"], label: "Stopped" },
      "t-live": { token: "assignment-working", views: ["all", "running"], label: "Building" },
      ...Object.fromEntries(["t-checks", "t-mismatch", "t-missing", "t-attested", "t-accepted", "t-verified", "t-pr", "t-merged"].map(id => [id, { token: "assignment-needs-decision", views: ["all", "needs-you"], label: "Needs you" }])),
    });
    expect(rows.length).toBe(14);
    // All lists what needs a person first, grouped by its ask (Decide, Review,
    // Unblock), then live work, then the rest by recency — and lists every one.
    const order = rows.map(row => row.token);
    expect(order.indexOf("assignment-working")).toBeGreaterThan(order.lastIndexOf("assignment-needs-decision"));
    const tasks = workspaceOf(all).view as Extract<BrowserWorkspace["view"], { kind: "tasks" }>;
    expect(tasks.groups).toEqual([{ key: "review", label: "Review", count: 8 }, { key: "unblock", label: "Unblock", count: 2 }, { key: "building", label: "Building", count: 1 }, { key: "rest", label: "Recent", count: 3 }]);
    expect(tasks.rows.map(row => row.group)).toEqual([...Array(8).fill("review"), "unblock", "unblock", "building", "rest", "rest", "rest"]);
    expect(Object.fromEntries(tasks.rows.map(row => [row.id, row.ask]))).toMatchObject({ "t-checks": "review", "t-held": "unblock", "t-failed": "unblock", "t-live": null, "t-cancelled": null, "t-builder": null });
    expect(tasks.needsYou).toBe(10);
    // Paging keeps that order across pages.
    const access = { principal: "operator" as const, repos: [alpha, beta] };
    const paged: string[] = [];
    for (let cursor: string | null = null, guard = 0; guard < 10; guard++) {
      const one = workIndexPage(store, now, access, { limit: 3, cursor });
      paged.push(...one.items.map(item => item.rootId));
      if ((cursor = one.nextCursor) === null) break;
    }
    expect(paged).toEqual(tasks.rows.map(row => row.id));
    // Finished results are not Complete until the lead or user marks the exact result complete.
    expect(countsOf(all)).toEqual({ All: 14, "Needs you": 10, Building: 1, Complete: 0 });
    // Each view lists exactly its members, and marks itself active.
    for (const [view, expected] of [
      ["needs-you", ["t-held", "t-failed", "t-checks", "t-mismatch", "t-missing", "t-attested", "t-accepted", "t-verified", "t-pr", "t-merged"]],
      ["running", ["t-live"]],
      ["completed", []],
    ] as const) {
      const html = await page(cookie, `/work?view=${view}`);
      expect(rowsOf(html).map(row => row.id).sort(), view).toEqual([...expected].sort());
      expect(html, view).toMatch(new RegExp(`<a href="/work\\?view=${view}" class="active" aria-current="page"[^>]*>`));
    }
    // Needs you groups by the ask alone; Building and Complete are one plain list.
    const needing = workspaceOf(await page(cookie, "/work?view=needs-you")).view as Extract<BrowserWorkspace["view"], { kind: "tasks" }>;
    expect(needing.groups?.map(one => one.key)).toEqual(["review", "unblock"]);
    expect((workspaceOf(await page(cookie, "/work?view=running")).view as typeof needing).groups).toBeNull();
    // Summary rows keep exact task links; saved evidence and all attempts
    // are read on the task page, without asserting fresh checks here.
    expect(all).toContain('<a class="work-title" href="/t/t-checks">Escape quotes</a>');
    expect(all).toContain('data-task="t-checks"');
    expect(all).not.toContain('<details class="assignment-attempts">');
    expect(all).not.toContain('badge-done">done');
    expect(all).not.toMatch(/\bshipped\b/i);
    expect(all).not.toContain("Deployed");
    expect(all).not.toContain("Checks passed");
    // Recorded result links preserve the exact task/run/project. Detailed
    // check and exception labels are resolved after opening the result.
    expect(all).toContain(`href="/review?result=t-checks&amp;run=${store.runsFor(store.lookupRef("t-checks")!.id)[0]!.id}">Open result →</a>`);
    expect(all).toContain(`href="/review?result=t-accepted&amp;run=${store.runsFor(store.lookupRef("t-accepted")!.id)[0]!.id}">Open result →</a>`);
    expect(await page(cookie, "/t/t-pr")).toContain('href="https://github.com/owner/repo/pull/482"');
    // Bad view values fall back to All; an unknown view is never an error.
    expect(await page(cookie, "/work?view=bogus")).toMatch(/<a href="\/work" class="active" aria-current="page"[^>]*>All/);
    // Every shortcut view has its own honest empty state.
    store.cancelTask("t-live", now); // a live claim refuses; the row stays — so check the empty copy on a fresh project instead
    await openProject(cookie, beta);
    for (const view of ["needs-you", "running", "completed"] as const) {
      const html = await page(cookie, `/work?view=${view}`);
      expect(html, view).toContain(`data-work-empty="${view}"`);
      expect(html, view).toContain('<a href="/work">See all tasks →</a>');
    }
    expect(await page(cookie, "/work?view=running")).toContain("Nothing is building right now.");
    expect(await page(cookie, "/work?view=needs-you")).toContain("Nothing needs you right now.");
    expect(await page(cookie, "/work?view=completed")).toContain("No tasks have been marked complete in this view.");
  });

  test("the same run's status agrees across Work, the task page, the focused chat, and the review cockpit — and never calls failed, missing, or agent-attested evidence verified, or local changes shipped", async () => {
    finished("t-checks", "Escape quotes", alpha, { verdict: "refuted", reasons: ["the repository's approved verification command exited 1"] });
    finished("t-mismatch", "Make the range inclusive", alpha, { verdict: "refuted", reasons: ["claimed changed path not in the sealed diff: src/ledger.ts"] });
    finished("t-missing", "Add subtotal rows", alpha, null);
    finished("t-attested", "Emit a BOM", alpha, { verdict: "attested", reasons: ["the proof agrees with the sealed diff; no verification command is configured to re-run"] });
    finished("t-accepted", "Keep the button reachable", alpha, { verdict: "refuted", reasons: ["the repository's approved verification command exited 2"] }, { accept: "checked by hand" });
    finished("t-verified", "Round at cent precision", alpha, { verdict: "verified", reasons: ["the approved verification command passed"] });
    finished("t-pr", "Handle DST", alpha, { verdict: "verified", reasons: ["the approved verification command passed"] }, { publication: { pr: 482 } });
    const cookie = await login();
    await openProject(cookie, alpha);
    const work = await page(cookie, "/work");
    const expected: Record<string, [string, string]> = {
      "t-checks": ["checks-failed", "Changes saved, but checks failed"],
      "t-mismatch": ["evidence-mismatch", "Result saved, but its record does not match"],
      "t-missing": ["verification-needed", "Result saved — verification needed"],
      "t-attested": ["agent-attested", "Result saved — checks reported by the agent"],
      "t-accepted": ["accepted-exception", "Accepted with an exception"],
      "t-verified": ["ready-to-review", "Ready"],
      "t-pr": ["pr-opened", "PR opened"],
    };
    for (const [id, [token, label]] of Object.entries(expected)) {
      const row = rowsOf(work).find(one => one.id === id);
      expect(row, id).toMatchObject({ token: "assignment-needs-decision", label: "Needs you" });
      const task = await page(cookie, `/t/${id}`);
      const chat = await page(cookie, `/chat?task=${id}`);
      const review = await page(cookie, `/review?result=${id}`);
      // The task page: the status box leads and the receipt agrees; the
      // title carries the words ONCE — no status line rides the h1 while
      // the box beneath says the same thing (concise revision).
      expect(task, id).toContain(`data-work-status="assignment-needs-decision"`);
      expect(task, id).toContain('>Needs you</h2>');
      expect(statusOf(task).map(one => one.label), id).not.toContain(label);
      expect(/<h1 class="task-main-title">([^<]*)<\/h1>/.exec(task)?.[1], id).toMatch(/^\S.*\S$/);
      expect(task, id).not.toMatch(/<h1 class="task-main-title">[^<]*<span class="status-line"/);
      expect(task, id).not.toContain('class="badge badge-done">done');
      // The focused chat: the journey headline and the receipt.
      expect(chat, id).toContain('data-work-status="assignment-needs-decision"');
      expect(chat, id).not.toContain('class="card task-journey"');
      expect(chat, id).toContain('>Needs you</h2>');
      expect(statusOf(chat).map(one => one.label), id).not.toContain(label);
      // The review cockpit's headline chip.
      expect(/<header class="cockpit-head"[^>]*>.*?<p class="cockpit-chips">(.*?)<\/p>/s.exec(review)?.[1], id).toContain(`data-work-status="assignment-needs-decision"`);
      expect(statusOf(review)[0]?.label, id).toBe("Needs you");
      // No surface calls anything shipped or deployed; the receipt names
      // what the record supports.
      for (const [name, html] of [["task", task], ["chat", chat], ["review", review]] as const) {
        expect(html, `${id} ${name}`).not.toContain("What shipped");
        expect(html, `${id} ${name}`).not.toContain("deployed</");
        expect(html, `${id} ${name}`).not.toMatch(/\bshipped\b/i);
      }
    }
    // A failed check, missing proof, and agent-attested evidence are never
    // "Verified"/"Ready to review"; acceptance is never "Checks passed".
    for (const id of ["t-checks", "t-mismatch", "t-missing", "t-attested", "t-accepted"]) {
      const task = await page(cookie, `/t/${id}`);
      expect(task, id).not.toContain("Ready to review");
      expect(task, id).not.toContain('data-work-status="ready-to-review"');
      expect(task, id).not.toContain("Checks passed");
    }
    // A failed check versus mismatched evidence: only the former says a
    // check failed, and it names the exit code.
    expect(await page(cookie, "/t/t-checks")).toContain("check failed against this build (exit 1)");
    expect(await page(cookie, "/t/t-mismatch")).not.toContain("checks failed");
    expect(await page(cookie, "/t/t-mismatch")).toContain("src/ledger.ts");
    // The receipt heading and publication line: local changes are saved;
    // a PR is "PR opened", and neither claims a merge or a deployment.
    const local = await page(cookie, "/t/t-verified");
    expect(local).toContain("<h2>Changes saved</h2>");
    expect(local).toContain("Saved on the build branch. No publication, merge, or deployment is recorded here.");
    const pr = await page(cookie, "/t/t-pr");
    expect(pr).toContain("<h2>PR opened</h2>");
    expect(pr).toContain('data-receipt-publication="opened">PR #482 was last seen open on GitHub. No merge or deployment is recorded here.');
    expect(pr).not.toContain("Merge observed");
    // No surface denies a merge or deployment it cannot see, and none calls
    // merging a person's act alone (an authorized mode may merge on green).
    for (const html of [local, pr, await page(cookie, "/review?result=t-pr"), await page(cookie, "/chat?task=t-pr")]) {
      expect(html).not.toMatch(/nothing (is|was) merged|not published, merged, or deployed|stays a person|person's act/i);
    }
    // The accepted exception keeps its original failed check visible and
    // never turns the acceptance into a claim about the checks.
    const accepted = await page(cookie, "/t/t-accepted");
    expect(accepted).toContain("verification command exited 2");
    expect(accepted).toContain("Accepted with an exception by alex. Check results are unchanged.");
    expect(work).not.toContain("Checks passed");
    expect(accepted).not.toContain("not passed by the machine");
    expect(work).not.toContain("not passed by the machine");
  });

  test("an admitted run's deep link opens from All projects without weakening visibility: a run outside the ceiling or the account still 404s, and the project gate stays for project-bound pages", async () => {
    const { run: alphaRun } = finished("t-alpha", "alpha result", alpha, { verdict: "verified", reasons: ["the approved verification command passed"] });
    const { run: betaRun } = finished("t-beta", "beta result", beta, { verdict: "verified", reasons: ["the approved verification command passed"] });
    const outsideRef = seedTask("t-outside", "outside the ceiling", join(root, "forbidden"));
    const outsideRun = store.startRun({ taskRef: outsideRef, leaseId: "lease-outside", runner: "night-shift-1", provider: "claude", branch: "standing-orders/t-outside", worktree: "/pool/t-outside", now, ...presented(store, outsideRef, "builder") });
    store.finishRun(outsideRun, { outcome: "built", committed: true, now });
    const cookie = await login();
    // A fresh session with two served projects has none open.
    expect(/<span class="name">All projects/.test(await page(cookie, "/work"))).toBe(true);
    // A builder's result opens on its one result page (titled with the task); its run record stays at ?record=1.
    for (const [path, status, location] of [[`/r/${alphaRun}`, 303, `/review?result=t-alpha&run=${alphaRun}`], [`/r/${betaRun}`, 303, `/review?result=t-beta&run=${betaRun}`],
      [`/r/${alphaRun}?record=1`, 200, null], [`/r/${outsideRun}`, 404, null], [`/r/${outsideRun}?record=1`, 404, null], ["/r/999999", 404, null]] as const) {
      const response = await fetch(url(path), { headers: { cookie }, redirect: "manual" });
      expect(response.status, path).toBe(status);
      expect(response.headers.get("location"), path).toBe(location);
    }
    const resultPage = await page(cookie, `/r/${alphaRun}`);
    expect(resultPage).toContain('<span class="name">All projects');
    expect(resultPage).toContain("alpha result");
    const runPage = await page(cookie, `/r/${alphaRun}?record=1`);
    expect(runPage).toContain(`build #${alphaRun}`);
    expect(runPage).toContain("t-alpha");
    // Selected-result links keep working through the same door, and the
    // Work roll-up lists both projects with their labels.
    const work = await page(cookie, "/work");
    expect(rowsOf(work).map(row => row.id).sort()).toEqual(["t-alpha", "t-beta"]);
    expect(work).toContain('<span class="project-label">alpha</span>');
    expect(work).toContain('<span class="project-label">beta</span>');
    expect(work).not.toContain("t-outside");
    // Project-bound pages still defer to the opener exactly as before.
    const tasks = await fetch(url("/tasks"), { headers: { cookie }, redirect: "manual" });
    expect(tasks.status).toBe(303);
    expect(tasks.headers.get("location")).toBe("/projects?return=%2Ftasks");
    // A project-scoped account gets 404 for the other project's run — the
    // same answer as before, whatever project its session holds.
    const minted = store.mintInvite("approver", "alex", now, undefined, [alpha]);
    expect(store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "member", credentialHash: hashPassword(memberPassword) }, now).ok).toBe(true);
    const member = await login("member", memberPassword);
    expect((await fetch(url(`/r/${alphaRun}`), { headers: { cookie: member } })).status).toBe(200);
    expect((await fetch(url(`/r/${betaRun}`), { headers: { cookie: member } })).status).toBe(404);
    expect(rowsOf(await page(member, "/work")).map(row => row.id)).toEqual(["t-alpha"]);
  });

  test("Work admits before it pages: exact counts, 40-row cursors reach older needs-you tasks, and excluded projects never consume a page", async () => {
    // Older needs-you tasks remain reachable, even beyond the old 200-row cap.
    // The same cursors must remain bound to the admitted project and view.
    const nextOf = (html: string): string | null => /rel="next" href="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&") ?? null;
    const at = (minutes: number): Date => new Date(now.getTime() - 24 * 3_600_000 + minutes * 60_000);
    // Each batch is fixture setup; no request reads its intermediate rows.
    // One commit preserves the same records without hundreds of fsyncs.
    store.transact(() => {
      for (let i = 0; i < 201; i++) {
        const id = `alpha-${String(i).padStart(3, "0")}`;
        store.createTask({ id, title: `alpha task ${i}` }, at(i));
        store.placeTask(store.refFor("built-in", id).id, alpha);
      }
    });
    store.createTask({ id: "beta-newest", title: "beta newest" }, at(300));
    store.placeTask(store.refFor("built-in", "beta-newest").id, beta);
    const cookie = await login();
    await openProject(cookie, alpha);
    const scoped = await page(cookie, "/work");
    const scopedRows = rowsOf(scoped).map(row => row.id);
    expect(scopedRows).toHaveLength(40);
    expect(scopedRows).not.toContain("alpha-000");
    expect(scopedRows).toContain("alpha-200");
    expect(scopedRows).not.toContain("beta-newest");
    expect(countsOf(scoped)).toEqual({ All: 201, "Needs you": 201, Building: 0, Complete: 0 });
    expect(scoped).not.toContain("200+");
    expect(scoped).not.toContain("data-work-bound");
    expect(scoped).not.toContain('data-work-empty="all"');
    const firstNext = nextOf(scoped)!;
    expect(firstNext).toContain("cursor=");
    const seen = [...scopedRows];
    let next: string | null = firstNext;
    while (next !== null) {
      const html = await page(cookie, next);
      const rows = rowsOf(html).map(row => row.id);
      expect(rows.length).toBeLessThanOrEqual(40);
      expect(countsOf(html)).toEqual({ All: 201, "Needs you": 201, Building: 0, Complete: 0 });
      seen.push(...rows);
      expect(seen.length).toBeLessThanOrEqual(201);
      next = nextOf(html);
    }
    expect(seen).toHaveLength(201);
    expect(new Set(seen).size).toBe(201);
    expect(seen.at(-1)).toBe("alpha-000");
    const needs = await page(cookie, "/work?view=needs-you");
    const olderNeeds = await page(cookie, nextOf(needs)!);
    expect(rowsOf(olderNeeds)).toHaveLength(40);
    expect(rowsOf(olderNeeds).some(row => scopedRows.includes(row.id))).toBe(false);
    const wrongView = new URL(firstNext, base);
    wrongView.searchParams.set("view", "needs-you");
    expect((await fetch(wrongView, { headers: { cookie } })).status).toBe(400);
    // Shortcut views query their complete admitted set, independent of All's page.
    const running = await page(cookie, "/work?view=running");
    expect(running).toContain('data-work-empty="running"');
    expect(running).toContain("Nothing is building right now.");
    expect(nextOf(running)).toBeNull();
    const completed = await page(cookie, "/work?view=completed");
    expect(completed).toContain("No tasks have been marked complete in this view.");
    expect(nextOf(completed)).toBeNull();
    store.cancelTask("alpha-000", now);
    await openProject(cookie, beta);
    expect((await fetch(url(firstNext), { headers: { cookie } })).status).toBe(400);
    const small = await page(cookie, "/work");
    expect(rowsOf(small).map(row => row.id)).toEqual(["beta-newest"]);
    expect(nextOf(small)).toBeNull();
    expect(countsOf(small)).toEqual({ All: 1, "Needs you": 1, Building: 0, Complete: 0 });
    expect(await page(cookie, "/work?view=completed")).toContain("No tasks have been marked complete in this view.");

    // 501 newer tasks in a repository outside the ceiling: the roll-up's
    // window belongs to admitted tasks, so the page is full and honest —
    // never the false empty claim the old post-filter produced.
    const forbidden = join(root, "forbidden");
    store.transact(() => {
      for (let i = 0; i < 501; i++) {
        const id = `foreign-${String(i).padStart(3, "0")}`;
        store.createTask({ id, title: `foreign task ${i}` }, at(1_000 + i));
        store.placeTask(store.refFor("built-in", id).id, forbidden);
      }
    });
    const all = await login();
    expect(/<span class="name">All projects/.test(await page(all, "/work"))).toBe(true);
    const rollup = await page(all, "/work");
    const rollupRows = rowsOf(rollup).map(row => row.id);
    expect(rollupRows).toHaveLength(40);
    expect(rollupRows.filter(id => id.startsWith("foreign-"))).toEqual([]);
    expect(rollupRows).toContain("beta-newest");
    expect(rollupRows).toContain("alpha-200");
    expect(rollupRows).not.toContain("alpha-001");
    expect(rollup).not.toContain('data-work-empty="all"');
    expect(countsOf(rollup)).toEqual({ All: 202, "Needs you": 201, Building: 0, Complete: 0 });
    expect(nextOf(rollup)).not.toBeNull();
    expect(rollup).toContain('<span class="project-label">beta</span>');
    // The chrome badge uses the same exact admitted count, not only this page.
    const waitingBadge = /<a href="\/work"[^>]*data-waiting="([0-9]+)"/.exec(rollup);
    expect(waitingBadge).not.toBeNull();
    expect(Number(waitingBadge![1])).toBe(countsOf(rollup)['Needs you']);
    expect(workspaceOf(rollup).crew.every(one => !one.id.startsWith('foreign-'))).toBe(true);

    // A project-scoped account admitted to alpha alone sees alpha's newest
    // 40-row page, nothing foreign, nothing from beta — with no project selected.
    const minted = store.mintInvite("approver", "alex", now, undefined, [alpha]);
    expect(store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "member", credentialHash: hashPassword(memberPassword) }, now).ok).toBe(true);
    const member = await login("member", memberPassword);
    const memberRows = rowsOf(await page(member, "/work")).map(row => row.id);
    expect(memberRows).toHaveLength(40);
    expect(memberRows.every(id => id.startsWith("alpha-"))).toBe(true);
    expect(memberRows).not.toContain("beta-newest");
    // A member of two projects opens Work and an admitted run without
    // selecting a project (the review's third check, kept permanent): the
    // session lands on its first admitted project, bounded and honest.
    const { run } = finished("t-visible", "visible result", beta, { verdict: "verified", reasons: ["the approved verification command passed"] });
    const minted2 = store.mintInvite("approver", "alex", now, undefined, [alpha, beta]);
    expect(store.consumeInviteAndCreateAccount({ tokenValue: minted2.token, name: "member2", credentialHash: hashPassword(memberPassword) }, now).ok).toBe(true);
    const member2 = await login("member2", memberPassword);
    const memberWork = await fetch(url("/work"), { headers: { cookie: member2 }, redirect: "manual" });
    expect(memberWork.status).toBe(200);
    const memberHtml = await memberWork.text();
    const memberWorkRows = rowsOf(memberHtml).map(row => row.id);
    expect(memberWorkRows).toHaveLength(40);
    expect(memberWorkRows.every(id => id.startsWith("alpha-"))).toBe(true);
    expect(countsOf(memberHtml)).toEqual({ All: 201, "Needs you": 200, Building: 0, Complete: 0 });
    expect(nextOf(memberHtml)).not.toBeNull();
    expect((await fetch(url(`/r/${run}?record=1`), { headers: { cookie: member2 }, redirect: "manual" })).status).toBe(200);
    await selectProject(member2, beta);
    expect(rowsOf(await page(member2, "/work")).map(row => row.id).sort()).toEqual(["beta-newest", "t-visible"]);

    // Unplaced rows ride every project-bound read the store makes, and a
    // project-scoped account may not see them: 201 newer unplaced tasks
    // must neither appear for the member nor spend its page.
    store.transact(() => {
      for (let i = 0; i < 201; i++) store.createTask({ id: `unplaced-${String(i).padStart(3, "0")}`, title: `unplaced task ${i}` }, at(2_000 + i));
    });
    const memberAfter = await page(member2, "/work");
    expect(rowsOf(memberAfter).map(row => row.id).sort()).toEqual(["beta-newest", "t-visible"]);
    expect(memberAfter).not.toContain("data-work-bound");
    await selectProject(member2, alpha);
    const memberAlpha = await page(member2, "/work");
    expect(rowsOf(memberAlpha).map(row => row.id)).toHaveLength(40);
    expect(rowsOf(memberAlpha).some(row => row.id.startsWith("unplaced-"))).toBe(false);
    expect(countsOf(memberAlpha)).toEqual({ All: 201, "Needs you": 200, Building: 0, Complete: 0 });
    expect(nextOf(memberAlpha)).not.toBeNull();
    // The unrestricted viewer still sees unplaced rows, newest first among
    // the admitted projects, with the honest bound.
    const withUnplaced = rowsOf(await page(all, "/work")).map(row => row.id);
    expect(withUnplaced).toHaveLength(40);
    expect(withUnplaced.filter(id => id.startsWith("unplaced-"))).toHaveLength(40);
    // 700 newer unplaced tasks the member cannot see (past the legacy
    // read's 500-row ceiling): the store binds the member's admission and
    // the unplaced exclusion before the limit, so its permitted work is
    // listed in full, with no bound and no "read was cut short" notice —
    // never an empty page (the reviewer's fifth boundary case).
    store.transact(() => {
      for (let i = 201; i < 700; i++) store.createTask({ id: `unplaced-${String(i).padStart(3, "0")}`, title: `unplaced task ${i}` }, at(2_000 + i));
    });
    await selectProject(member2, beta);
    const hidden = await page(member2, "/work");
    expect(rowsOf(hidden).map(row => row.id).sort()).toEqual(["beta-newest", "t-visible"]);
    expect(hidden).not.toContain("data-work-bound");
    expect(hidden).not.toContain("unproven");
    expect(hidden).not.toContain("500-record");
    expect(hidden).not.toContain('data-work-empty="all"');
    expect(countsOf(hidden)).toMatchObject({ Building: 0, Complete: 0 });
    expect(hidden).toContain('<span class="count">2</span>');
    // Clearing selection still chooses the first admitted project, with
    // exact counts and a cursor, without admitting any unplaced rows.
    await selectProject(member2, "");
    const memberFirst = await page(member2, "/work");
    const memberFirstRows = rowsOf(memberFirst).map(row => row.id);
    expect(memberFirstRows).toHaveLength(40);
    expect(memberFirstRows.every(id => id.startsWith("alpha-"))).toBe(true);
    expect(countsOf(memberFirst)).toEqual({ All: 201, "Needs you": 200, Building: 0, Complete: 0 });
    expect(nextOf(memberFirst)).not.toBeNull();
    // The unrestricted viewer still sees the unplaced rows, newest first.
    const unrestricted = rowsOf(await page(all, "/work")).map(row => row.id);
    expect(unrestricted).toHaveLength(40);
    expect(unrestricted[0]).toBe("unplaced-699");
    expect(unrestricted.every(id => id.startsWith("unplaced-"))).toBe(true);
  });

  test("retired review records do not replace saved check results; older runs and acceptance retain exact history", async () => {
    // Two finished builds on one task: the older one (A) verified, and the
    // newer result (B) verified too — B is what every surface projects,
    // and A's own run page must keep A's verdict whatever B's review does.
    const { ref, run: older } = finished("t-rev", "Review me", alpha, { verdict: "verified", reasons: ["the approved verification command passed"] });
    const latest = store.startRun({ taskRef: ref, leaseId: "lease-t-rev-2", runner: "night-shift-1", provider: "claude", branch: "standing-orders/t-rev", worktree: "/pool/t-rev-2", now: new Date(now.getTime() - 900_000), ...presented(store, ref, "builder") });
    storeEvidence(store, root, latest, "terminal-diff", "terminal-diff.patch", Buffer.from("diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n", "utf8"), "git diff --no-ext-diff 0000..HEAD (exit 0)", now, { captureStatus: "ok" });
    storeEvidence(store, root, latest, "handoff", "handoff.json", handoffBytes(latest, { conclusion: "Finished again.", changes: [], verification: [], followUps: [] }), "composed at completion", now);
    store.finishRun(latest, { outcome: "built", committed: true, now: new Date(now.getTime() - 600_000) });
    store.saveProofVerdict(latest, "refuted", ["the repository's approved verification command exited 1"], now);
    store.setTaskState("t-rev", "done", new Date(now.getTime() - 600_000));
    register(store, { name: "night-shift-1", host: "here", capacity: 2, repos: [alpha], now, newToken: () => "tok-night-1" });
    const cookie = await login();
    await openProject(cookie, alpha);
    const surfaces = async (): Promise<Record<string, { token: string | undefined; label: string | undefined }>> => {
      const work = rowsOf(await page(cookie, "/work")).find(row => row.id === "t-rev");
      const task = await page(cookie, "/t/t-rev");
      const chat = await page(cookie, "/chat?task=t-rev");
      const review = await page(cookie, "/review?result=t-rev");
      const run = await page(cookie, `/r/${latest}?record=1`);
      expect(statusOf(run)).toHaveLength(1); // The header says it once; Checks keeps the recorded verdict.
      // The title never repeats the box (concise revision): the h1 is the
      // bare title, and the receipt is the page's only status line.
      expect(task).toContain('<h1 class="task-main-title">Review me</h1>');
      const current = /<section class="card assignment-summary"[^>]*data-work-status="([^"]+)"[^>]*><h2 class="assignment-state status-headline"><i aria-hidden="true"><\/i>([^<]+)<\/h2>/.exec(task);
      expect(current).not.toBeNull();
      return {
        work: { token: work?.token, label: work?.label },
        receipt: { token: current?.[1], label: current?.[2] },
        chat: {
          token: /data-assignment="t-rev" data-work-status="([^"]+)"/.exec(chat)?.[1],
          label: /<h2 class="assignment-state status-headline"><i aria-hidden="true"><\/i>([^<]+)<\/h2>/.exec(chat)?.[1],
        },
        cockpit: { token: /<p class="cockpit-chips">.*?data-work-status="([^"]+)"/s.exec(review)?.[1], label: statusOf(review)[0]?.label },
        run: { token: /<header class="result-head">[\s\S]*?data-work-status="([^"]+)"/.exec(run)?.[1], label: statusOf(run)[0]?.label },
      };
    };
    const agree = (seen: Record<string, { token: string | undefined; label: string | undefined }>, token: string, label: string): void => {
      for (const [name, one] of Object.entries(seen)) {
        expect(one, name).toEqual({ token, label });
      }
    };
    // This historical fixture lacks current candidate/scope bindings. Every
    // current surface says Needs you; saved failed checks stay history.
    agree(await surfaces(), "assignment-needs-decision", "Needs you");

    // Queued: one primary status on every surface; the receipt and the
    // status box carry the earlier verdict as history, in the same words.
    const first = store.requestReview(latest, "alex", now);
    if (!first.ok) throw new Error(first.reason);
    agree(await surfaces(), "assignment-needs-decision", "Needs you");
    const queuedTask = await page(cookie, "/t/t-rev");
    // The receipt's history sentence sits behind a native disclosure (concise pass, 2026-09-13) — the same words, secondary.
    expect(queuedTask).toContain('check failed against this build (exit 1)');
    expect(await page(cookie, "/review?result=t-rev")).toContain('data-review-state="queued"');
    // The receipt's criteria label still reads from the stored verdict.
    expect(queuedTask).toContain("the agent's own claim — not checked");
    expect(rowsOf(await page(cookie, "/work")).find(row => row.id === "t-rev")?.views).toEqual(["all", "needs-you"]);
    // The older run keeps its own verdict: nothing masks a selected result.
    const olderPage = await page(cookie, `/r/${older}?record=1`);
    expect(/<header class="result-head">[\s\S]*?data-work-status="([^"]+)"/.exec(olderPage)?.[1]).toBe("ready-to-review");
    expect(olderPage).not.toContain("Waiting for review");

    // A live historical reviewer does not turn current work into Reviewing.
    const admitted = store.admitReview(first.id, { runner: "night-shift-1", token: "tok-night-1", provider: "claude", model: "sonnet" }, now);
    if (!admitted.ok) throw new Error(admitted.reason);
    agree(await surfaces(), "assignment-needs-decision", "Needs you");
    expect(rowsOf(await page(cookie, "/work")).find(row => row.id === "t-rev")?.views).toEqual(["all", "needs-you"]);
    expect(rowsOf(await page(cookie, "/work?view=running")).map(row => row.id)).not.toContain("t-rev");
    const liveTask = await page(cookie, "/t/t-rev");
    expect(liveTask).toContain('<a href="/runs">0 live</a>');
    expect(await page(cookie, "/projects")).not.toContain('>1 running</a>');
    const historyWindow = new Window();
    try {
      historyWindow.document.body.innerHTML = liveTask;
      const attempts = historyWindow.document.querySelector('#attempts')!;
      expect(attempts.textContent).not.toContain("never finished");
      expect(attempts.querySelector('.badge-running')?.textContent).toBe("Running");
      expect(liveTask).toContain(`review #${admitted.reviewerRunId}</a> · running`);
    } finally { await historyWindow.happyDOM.close(); }
    expect(await page(cookie, "/chat?task=t-rev")).not.toContain('class="card task-journey"');
    // A lost reviewer stays unfinished; a null outcome alone is no proof
    // that it is still working. Restore the heartbeat for the next case.
    store.touchRunner('night-shift-1', new Date(now.getTime() - 3_600_000));
    const orphan = await page(cookie, '/t/t-rev');
    expect(orphan).toContain(`review #${admitted.reviewerRunId}</a> · never finished`);
    expect(orphan).toContain('<a href="/runs">0 live</a>');
    expect(orphan).toContain('<h2 class="assignment-state status-headline"><i aria-hidden="true"></i>Needs you</h2>');
    store.touchRunner('night-shift-1', now);

    // A failed historical reviewer does not offer another review attempt.
    store.finishRun(admitted.reviewerRunId, { outcome: "failed", reason: "reviewer-agent", now });
    store.stampReviewRequestOutcome(first.id, "reviewer-agent");
    agree(await surfaces(), "assignment-needs-decision", "Needs you");
    const failedTask = await page(cookie, "/t/t-rev");
    expect(await page(cookie, "/review?result=t-rev")).toContain("<summary>Previous assessments</summary>");
    expect(failedTask).not.toContain("/retry-review");
    expect(rowsOf(await page(cookie, "/work")).find(row => row.id === "t-rev")?.views).toEqual(["all", "needs-you"]);

    // Historical exception acceptance never invents missing current candidate
    // bindings or marks the assignment Complete. Its exact record stays readable.
    store.acceptProof(latest, "alex", "checked by hand", now);
    agree(await surfaces(), "assignment-needs-decision", "Needs you");
    expect(await page(cookie, "/review?result=t-rev")).toContain('data-review-state="retryable"');
    expect(store.proofAcceptance(latest)?.note).toBe("checked by hand");
    expect(store.proofVerdictFor(latest)?.verdict).toBe("refuted");
    expect(await page(cookie, "/t/t-rev")).not.toContain("data-receipt-review=");
  });

  test("concise pass: a Work row is recorded title, status and next act; opening its result keeps the full diagnosis and receipt", async () => {
    const cookie = await login();
    await openProject(cookie, alpha);
    const checks = finished("t-checks", "Escape quotes", alpha, { verdict: "refuted", reasons: ["the repository's approved verification command exited 1"] });
    const optional = finished("t-optional", "Add subtotal rows", alpha, { verdict: "verified", reasons: ["the approved verification command passed"] });
    // A default-quality matrix with no settled review: coverage is owed nothing.
    store.saveProofVerdict(optional.run, "verified", ["the approved verification command passed"], now, [
      { id: "c1", statement: "subtotals add up", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "npm test" }], review: null },
    ]);
    seedTask("t-queued", "Rework the ledger export", alpha);
    const work = await page(cookie, "/work");
    // The head is the title and the tools control — no hint paragraph; the view's words ride the tab's title.
    expect(work).toContain('<div class="work-head"><h1>Tasks</h1><details class="work-tools">');
    expect(work).not.toContain('<p class="hint">Every task in view, most urgent first.</p>');
    expect(work).toContain('<a href="/work" class="active" aria-current="page">All<span class="count">');
    // The list avoids loading attempts and artifact diagnostics for every row.
    // The exact result link leads to the full diagnosis checked below.
    const row = /<article class="work-row" data-task="t-checks"[^>]*>([\s\S]*?)<\/article>/.exec(work)?.[1] ?? "";
    expect(row).toMatch(/^<div class="work-row-main"><a class="work-title" href="\/t\/t-checks">Escape quotes<\/a><p class="work-meta"><span>[^<]+<\/span><\/p><\/div>/);
    expect(row).toContain('data-work-status="assignment-needs-decision"');
    expect(row).not.toContain("Checks passed");
    expect(row).toContain('Open result →</a>');
    expect(row).not.toContain('<details class="assignment-attempts">');
    // Each family is one row; internal attempts belong to detail pages.
    expect(work.match(/<article class="work-row"/g)).toHaveLength(3);
    expect(work.match(/<details class="assignment-attempts">/g)).toBeNull();
    const css = await stylesOf(work, base);
    expect(css).toContain('.assignment-attempts summary,.assignment-notices summary{min-height:44px;');
    // The receipt: an optional, unsettled review folds behind a disclosure; the machine verdict and the facts stay in the open.
    const task = await page(cookie, `/t/t-optional`);
    expect(task).not.toContain('class="receipt-coverage"');
    expect(task).toContain('data-receipt-publication="none">Saved on the build branch. No publication, merge, or deployment is recorded here.</p>');
    expect(task).toContain("<strong>1/1 requirements met</strong><small>against the approved scope</small>");
    // The failed check and its exact result link stay visible; its saved assessment is secondary.
    const failed = await page(cookie, `/t/t-checks`);
    expect(failed).toContain("check failed against this build (exit 1)");
    expect(failed).toContain(`href="/review?result=t-checks&amp;run=${checks.run}" data-primary-action>Open the failed check</a>`);
    expect(failed).not.toContain('<details class="proof-exception">');
    expect(failed).toContain('<summary>Previous assessment</summary>');
    expect(failed).not.toContain('<details class="receipt-history">');
    void checks;
  });

  test("concise revision: the Work menu keeps its phone anchor, rows retain exact identity, and opening a task preserves history, terms and actions", async () => {
    const cookie = await login();
    await openProject(cookie, alpha);
    const { run: older } = finished("t-rev", "Escape quotes", alpha, { verdict: "verified", reasons: ["the approved verification command passed"] });
    const checks = finished("t-checks", "Round at cent precision", alpha, { verdict: "refuted", reasons: ["the repository's approved verification command exited 1"] });
    seedTask("t-queued", "Rework the ledger export", alpha);
    const work = await page(cookie, "/work");
    // The menu: right-anchored on every width — the phone override that
    // re-anchored it at left: 0 (and pushed it past a 390px viewport) is gone;
    // the menu can never be wider than the viewport minus the page gutter.
    const css = await stylesOf(work, base);
    expect(css).toContain(".work-tools-menu {\n    position: absolute; right: 0; top: calc(100% + .375rem); z-index: 20; min-width: 11rem; max-width: calc(100vw - 2rem);");
    expect(css).not.toContain(".work-tools-menu { right: auto; left: 0; }");
    expect(css).toContain(".work-tools { display: none; position:");
    expect(css).toContain(".app.sidebar-collapsed .work-tools { display: block; }");
    expect(css).toContain("    .work-tools { display: block; }");
    expect(css).not.toMatch(/\.work-tools-menu\s*\{[^}]*left:/);
    expect(work).toContain('<details class="work-tools"><summary>Work tools');
    // D5: coding sessions are deprecated, so the tools menu no longer links /code.
    expect([...work.matchAll(/<nav class="work-tools-menu">([\s\S]*?)<\/nav>/g)][0]?.[1]?.match(/<a href="/g)).toHaveLength(7);
    // The visible meta is age/project; exact task identity stays in the
    // title link and row data attribute instead of repeating diagnostics.
    const row = /<article class="work-row" data-task="t-checks"[^>]*>([\s\S]*?)<\/article>/.exec(work)?.[1] ?? "";
    const meta = /<p class="work-meta">([\s\S]*?)<\/p>/.exec(row)?.[1] ?? "";
    expect(meta).toMatch(/^<span>[^<]+<\/span>$/);
    expect(meta).not.toContain("t-checks");
    expect(row).not.toContain('<details class="assignment-attempts">');
    expect(row).toContain('href="/t/t-checks"');
    expect(row).toContain('<span class="status-label">Needs you</span>');
    expect(row).not.toContain("Checks passed");
    expect(row).toContain(`<a class="work-action" data-primary-action href="/review?result=t-checks&amp;run=${checks.run}">Open result →</a>`);
    for (const id of ["t-rev", "t-queued"]) expect(work).toContain(`data-task="${id}"`);
    // The task page: the status box leads with the result's words, the
    // receipt agrees, and the title is the bare title — the words appear
    // once above the fold. The failed check's exit code, its review action,
    // and the exception control stay in the open.
    const failed = await page(cookie, "/t/t-checks");
    expect(failed).toContain('<h1 class="task-main-title">Round at cent precision</h1>');
    expect(failed.match(/<h2 class="assignment-state status-headline"><i aria-hidden="true"><\/i>Needs you<\/h2>/g)).toHaveLength(1);
    expect(failed).toContain('data-work-status="assignment-needs-decision"');
    expect(failed).toContain("check failed against this build (exit 1)");
    expect(failed).toContain(`href="/review?result=t-checks&amp;run=${checks.run}" data-primary-action>Open the failed check</a>`);
    expect(failed).not.toContain('<details class="proof-exception">');
    expect(failed).toContain('<summary>Previous assessment</summary>');
    // A task without a result keeps its state chip in the title: the box
    // beneath answers a different question ("will this run?").
    const queued = await page(cookie, "/t/t-queued");
    expect(queued).toContain('<h1 class="task-main-title">Rework the ledger export</h1>');
    expect(queued).toContain('data-work-status="assignment-needs-decision"');
    expect(queued).toContain('<h2 class="assignment-state status-headline"><i aria-hidden="true"></i>Needs you</h2>');
    // This run remains the current result: task state is shared, while its saved verdict is retained.
    const olderPage = await page(cookie, `/r/${older}?record=1`);
    expect(/<header class="result-head">[\s\S]*?data-work-status="([^"]+)"/.exec(olderPage)?.[1]).toBe("assignment-needs-decision");
    expect(olderPage).toContain('data-proof-verdict="complete-verified"');
    // The signed terms stay exact on the task page: the approved goal, word
    // for word, and nothing pretends the checks passed.
    expect(failed).toContain("do Round at cent precision");
    expect(failed).not.toContain("Checks passed");
    void checks;
  });

  test("the task list leads with the project label and wraps the raw path; the receipt never says shipped", async () => {
    const long = join(root, "clients", "northwind-operations", "ops-console-with-a-very-long-repository-name-for-overflow-checks");
    mkdirSync(long, { recursive: true });
    const cookie = await login();
    // Served projects are the two configured; the long path is an opened
    // project only through the ceiling, so drive the intro with alpha.
    await openProject(cookie, alpha);
    const tasks = await page(cookie, "/tasks");
    expect(tasks).toContain(`Work you want done in <strong>alpha</strong>`);
    expect(tasks).toContain(`<p class="meta path-words"><span class="mono">${alpha}</span></p>`);
    expect(await stylesOf(tasks, base)).toContain(".path-words { overflow-wrap: anywhere; word-break: break-word; }");
    expect(tasks).not.toContain(`in <span class="mono">${alpha}</span> —`);
  });

  test("a project-scoped account gets its own project's live flow stream with presence, never another project's", async () => {
    const { flowFromSteps } = await import("./flows.js");
    const definitionJson = JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null));
    const own = store.createFlow({ repo: alpha, name: "Support", by: "alex", definitionJson }, now);
    const other = store.createFlow({ repo: beta, name: "Billing", by: "alex", definitionJson }, now);
    const minted = store.mintInvite("approver", "alex", now, undefined, [alpha]);
    expect(store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "member", credentialHash: hashPassword(memberPassword) }, now).ok).toBe(true);
    const member = await login("member", memberPassword);
    const abort = new AbortController();
    const live = await fetch(url(`/live?room=${encodeURIComponent(`flow:${own}`)}`), { headers: { cookie: member }, redirect: "manual", signal: abort.signal });
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toBe("text/event-stream");
    const reader = live.body!.getReader();
    let text = "";
    while (!text.includes("event: here")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain("event: change");
    expect(text).toContain(`event: here\ndata: {"room":"flow:${own}","people":[]}`);
    abort.abort();
    await reader.cancel().catch(() => undefined);
    const foreign = await fetch(url(`/live?room=${encodeURIComponent(`flow:${other}`)}`), { headers: { cookie: member }, redirect: "manual" });
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("content-type")).not.toBe("text/event-stream");
    await foreign.text();
    // With All projects open, the stream names its own flow's project too: no project chooser redirect.
    const everything = new AbortController();
    const operator = await fetch(url(`/live?room=${encodeURIComponent(`flow:${other}`)}`), { headers: { cookie: await login() }, redirect: "manual", signal: everything.signal });
    expect(operator.status).toBe(200);
    expect(operator.headers.get("content-type")).toBe("text/event-stream");
    everything.abort();
  });

  test("the Tasks count is one number per session: a flow page and a task page in different projects agree with Needs you", async () => {
    const { flowFromSteps } = await import("./flows.js");
    finished("t-a1", "Alpha result", alpha, { verdict: "verified", reasons: [] });
    finished("t-b1", "Beta result", beta, { verdict: "verified", reasons: [] });
    finished("t-b2", "Second beta result", beta, { verdict: "verified", reasons: [] });
    const flow = store.createFlow({ repo: alpha, name: "Support", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, now);
    const cookie = await login();
    const badgeOf = async (path: string): Promise<{ sidebar: number; navigation: number | undefined; href: string | undefined }> => {
      const html = await page(cookie, path);
      const tasks = workspaceOf(html).navigation.find(one => one.label === "Tasks");
      return { sidebar: Number(/<a href="\/work"[^>]*data-waiting="(\d+)"/.exec(html)?.[1]), navigation: tasks?.count, href: tasks?.href };
    };
    const surfaces = ["/flows/" + flow, "/t/t-b1", "/work", "/chat"];
    // All projects open: every surface counts Needs you across both projects.
    const everything = countsOf(await page(cookie, "/work?view=needs-you"))["Needs you"];
    expect(everything).toBe(3);
    for (const path of surfaces) expect(await badgeOf(path), path).toEqual({ sidebar: 3, navigation: 3, href: "/work" });
    // One project open: the flow (alpha) and the task (beta) both count alpha's Needs you, and link there.
    await selectProject(cookie, alpha);
    const alphaOnly = countsOf(await page(cookie, `/work?project=${encodeURIComponent(alpha)}&view=needs-you`))["Needs you"];
    expect(alphaOnly).toBe(1);
    for (const path of surfaces) expect(await badgeOf(path), path).toEqual({ sidebar: 1, navigation: 1, href: `/work?project=${encodeURIComponent(alpha)}` });
    // Reading another project's Tasks counts that project there.
    expect(await badgeOf(`/work?project=${encodeURIComponent(beta)}`)).toEqual({ sidebar: 2, navigation: 2, href: `/work?project=${encodeURIComponent(beta)}` });
    // A change from outside this console (a worker, the CLI) shows on the very next page, as on the Needs you tab.
    finished("t-a2", "Another alpha result", alpha, { verdict: "verified", reasons: [] });
    expect(countsOf(await page(cookie, `/work?project=${encodeURIComponent(alpha)}&view=needs-you`))["Needs you"]).toBe(2);
    expect(await badgeOf("/flows/" + flow)).toEqual({ sidebar: 2, navigation: 2, href: `/work?project=${encodeURIComponent(alpha)}` });
  });

  test("the Tasks badge says which projects its count covers, aloud and on hover", async () => {
    finished("t-a1", "Alpha result", alpha, { verdict: "verified", reasons: [] });
    finished("t-b1", "Beta result", beta, { verdict: "verified", reasons: [] });
    finished("t-b2", "Second beta result", beta, { verdict: "verified", reasons: [] });
    const cookie = await login();
    const labelsOf = async (path: string): Promise<{ navigation: string | undefined; rail: string | undefined; railTitle: string | undefined }> => {
      const html = await page(cookie, path);
      const tasks = workspaceOf(html).navigation.find(one => one.label === "Tasks");
      const rail = /<span aria-label="([^"]*)" title="([^"]*)" class="count badge badge-open">/.exec(html);
      return { navigation: tasks?.countLabel, rail: rail?.[1], railTitle: rail?.[2] };
    };
    const all = "3 need you across all your projects";
    expect(await labelsOf("/work")).toEqual({ navigation: all, rail: all, railTitle: all });
    await selectProject(cookie, alpha);
    const name = workspaceOf(await page(cookie, "/work")).projects.find(one => one.path === alpha)?.name;
    expect(name).toBeTruthy();
    const one = `1 needs you in ${name}`;
    expect(await labelsOf("/t/t-b1")).toEqual({ navigation: one, rail: one, railTitle: one });
  });
});
