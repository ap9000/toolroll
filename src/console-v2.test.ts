/** Console v2 (the task page as one thread with Details, the live home, the
 * Inbox tabs): the layout moved, and every action kept its route, its
 * fields and its step-up. These tests read the page the browser gets and
 * hold the rebuilt view to the server's own forms, then prove the composer's
 * mode grants nothing and the home shows only admitted work. */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { addApprover, approve, hashPassword, propose } from "./scope.js";
import { createDecisionServer, TASK_COMPOSER_MODES } from "./serve.js";
import type { BrowserTaskView, BrowserWorkspace } from "./browser-workspace.js";
import type { LeadProviderAnswer } from "./converse.js";

const T0 = new Date("2026-10-01T12:00:00.000Z");

describe("console v2: the thread, Details, the home and the Inbox tabs keep every action as it was", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let token: string;
  let evidenceRoot: string;
  let repo: string;
  let other: string;
  let requests: { history: { role: string; text?: string }[] }[];
  let answers: LeadProviderAnswer[];
  const url = (path: string) => `${base}${path}`;

  const login = async (name = "alex", password = token): Promise<string> => {
    const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name, token: password }), redirect: "manual" });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };
  const workspace = async (cookie: string, path: string): Promise<BrowserWorkspace> => {
    // A visit starts the subscription conversation (a JSON read never does), as a browser's first load does.
    await (await fetch(url(path), { headers: { cookie } })).text();
    const response = await fetch(url(`${path}${path.includes("?") ? "&" : "?"}format=workspace`), { headers: { cookie } });
    if (response.status !== 200) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<BrowserWorkspace>;
  };
  const filed = (id: string, title: string, at: Date, approved = true, where = repo): number => {
    store.createTask({ id, title }, at);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, where, {}, at);
    const proposed = propose(store, { taskId: id, goal: `${title}.`, touches: ["src/"], acceptance: [{ id: "c1", statement: `${title}.`, how: null, evidence: ["check"] }], now: at });
    if (approved) {
      const ok = approve(store, id, "alex", at, proposed.digest, token);
      if (!ok.ok) throw new Error(ok.reason);
    }
    return ref;
  };
  const building = (id: string, title: string, runner: string, where = repo): number => {
    const ref = filed(id, title, T0, true, where);
    const claim = acquire(store, ref, runner, { now: T0, token: `tok-${runner}`, ttlMs: 4 * 3_600_000 });
    if (!claim.ok) throw new Error(claim.reason);
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner, branch: `b/${id}`, worktree: `/w/${id}`, route: authority.stamp, now: T0 });
    store.setRunPhase(run, "agent-running", T0);
    return run;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "console-v2-ev-"));
    repo = realpathSync(mkdtempSync(join(tmpdir(), "console-v2-repo-")));
    other = realpathSync(mkdtempSync(join(tmpdir(), "console-v2-other-")));
    requests = [];
    answers = [];
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    token = added.token;
    store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", T0);
    for (const name of ["builder-1", "builder-2"]) register(store, { name, host: "test", capacity: 2, repos: [repo, other], now: T0, newToken: () => `tok-${name}` });
    server = createDecisionServer({
      store, evidenceRoot, repos: [repo, other], clock: () => T0, chatEnv: {},
      subscriptionChatRunner: async request => {
        requests.push(request as unknown as { history: { role: string; text?: string }[] });
        return { ok: true, answer: answers.shift() ?? { text: "Here.", calls: [], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null } };
      },
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    for (const dir of [evidenceRoot, repo, other]) rmSync(dir, { recursive: true, force: true });
  });

  /** Every form in the rebuilt view, wherever it now sits: status, lead blocks, the thread, Details' folds and Cancel. */
  const viewForms = (view: BrowserTaskView): string => [
    view.statusHtml, view.approval, view.questions, ...view.lead.map(one => one.html),
    ...(view.thread ?? []).flatMap(one => [one.html, one.more?.html ?? ""]),
    ...view.sections.map(one => one.html), ...view.manage.map(one => one.html), view.cancel?.html ?? "",
    // Stop on the Building card is rendered from data, not HTML.
    view.stop == null ? "" : `<form method="post" action="${view.stop.action}">`,
  ].join("\n");
  const formsOf = (html: string): string[] => [...html.matchAll(/<form\b[^>]*\baction="([^"]+)"/g)].map(match => match[1]!).sort();
  const stepUps = (html: string): number => (html.match(/type="password"/g) ?? []).length;

  test("c3: the rebuilt task page carries exactly the server page's forms and password step-ups, in every state", async () => {
    filed("unscoped", "Plan the export", T0, false);
    building("live", "Export orders", "builder-1");
    const askRef = filed("asking", "Pick a cache", T0);
    const authority = store.routeAuthorityFor(askRef, "builder");
    if (!authority?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: askRef, leaseId: "l-ask", runner: "builder-2", branch: "b/ask", worktree: "/w/ask", route: authority.stamp, now: T0 });
    store.saveDecision({ run, urgency: "blocking", recap: "Two ways to cache.", question: "Per-user or global?", recommendation: "user",
      options: [{ id: "user", label: "Per-user", consequence: "More state.", reversible: true }, { id: "global", label: "Global", consequence: "Coarser.", reversible: true }] }, T0);
    const doneRef = filed("finished", "Serve smaller images", T0);
    const doneAuthority = store.routeAuthorityFor(doneRef, "builder");
    if (!doneAuthority?.ok) throw new Error("route");
    const doneRun = store.startRun({ taskRef: doneRef, leaseId: "l-done", runner: "builder-1", branch: "b/done", worktree: "/w/done", route: doneAuthority.stamp, now: T0 });
    store.stampRun(doneRun, { scopeDigest: store.getScope("finished")!.digest, baseRevision: "1".repeat(40) });
    store.recordOutcomeFacts(doneRun, { headRevision: "2".repeat(40), handoff: "Images now use responsive sizes." });
    store.finishRun(doneRun, { outcome: "built", committed: true, now: T0 });
    store.setTaskState("finished", "done", T0);
    const cookie = await login();
    for (const id of ["unscoped", "live", "asking", "finished"]) {
      const data = await workspace(cookie, `/t/${id}`);
      const view = data.view as BrowserTaskView;
      expect(view.kind).toBe("task");
      // The page's own fallback is the server's task body; the rebuilt view holds every one of its forms.
      expect(data.pageHtml).not.toBeNull();
      const serverForms = formsOf(data.pageHtml!);
      expect(serverForms.length).toBeGreaterThan(0);
      expect(formsOf(viewForms(view))).toEqual(serverForms);
      expect(stepUps(viewForms(view))).toBe(stepUps(data.pageHtml!));
      // Details are grouped, and the thread starts with the filing.
      expect(view.details?.map(group => group.title)).toEqual(["Work", "Links", "Review", "About"]);
      expect(view.thread?.[0]?.kind).toBe("filed");
      // The conversation is the thread's: no Ask tab, and the composer posts to /chat for this task.
      expect(view.tabs).toEqual([]);
      expect(data.conversation?.taskId).toBe(id);
    }
    // The open question is answered in the thread, with its own form and anchor.
    const asking = (await workspace(cookie, "/t/asking")).view as BrowserTaskView;
    const question = asking.thread!.find(one => one.key === "questions")!;
    expect(question.html).toContain('id="task-questions"');
    expect(formsOf(question.html).length).toBeGreaterThan(0);
    // The result is a thread entry with the agent's handoff, and its receipt one tap away.
    const finished = (await workspace(cookie, "/t/finished")).view as BrowserTaskView;
    expect(finished.thread!.find(one => one.kind === "result")).toMatchObject({ title: "Result ready", text: "Images now use responsive sizes.", link: { href: `/r/${doneRun}` } });
    // A live build is a progress entry in the machine's words, never the model's.
    const live = (await workspace(cookie, "/t/live")).view as BrowserTaskView;
    expect(live.thread!.find(one => one.kind === "progress")).toMatchObject({ title: "Building", text: "Writing the change." });
  });

  test("c3: the composer's mode is fixed server words for one turn; it never stands in for a confirmation", async () => {
    filed("t1", "Fix the export", T0);
    const cookie = await login();
    const data = await workspace(cookie, "/t/t1");
    const chat = data.conversation!;
    const send = (fields: Record<string, string>) => fetch(url("/chat"), { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams({ csrf: data.csrf, request: "a".repeat(32), "request-session": String(chat.sessionId), ...fields }), redirect: "manual" });
    // An unknown mode, a repeated mode, or a mode outside a task is refused before anything starts.
    expect((await send({ task: "t1", message: "hi", mode: "merge" })).status).toBe(400);
    const twice = new URLSearchParams({ csrf: data.csrf, task: "t1", message: "hi", request: "b".repeat(32), "request-session": String(chat.sessionId), mode: "plan" });
    twice.append("mode", "answer");
    expect((await fetch(url("/chat"), { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: twice, redirect: "manual" })).status).toBe(400);
    expect((await send({ message: "hi", mode: "build" })).status).toBe(400);
    expect(store.recentLeadTurns("alex", 10)).toHaveLength(0);
    // A valid mode starts the same turn, with the mode's words in its hidden context only.
    const proposalsBefore = store.listCoordinatorProposals({ repos: [repo, other], states: ["pending", "confirmed", "refused"], limit: 50 }).length;
    expect((await send({ task: "t1", message: "Exact matches first, please.", mode: "build" })).status).toBe(202);
    for (let i = 0; i < 200 && store.liveLeadTurnFor("alex") !== null; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const said = JSON.stringify(requests.at(-1)!.history);
    expect(said).toContain(TASK_COMPOSER_MODES.build);
    const after = await workspace(cookie, "/t/t1");
    expect(after.conversation!.messages.map(one => one.text)).toEqual(["Exact matches first, please.", "Here."]);
    expect(after.conversation!.messages[0]!.text).not.toContain("operator chose");
    // Nothing was filed, revised or approved by sending.
    expect(store.listCoordinatorProposals({ repos: [repo, other], states: ["pending", "confirmed", "refused"], limit: 50 }).length).toBe(proposalsBefore);
    expect(store.taskFamilyOf("t1", [repo, other], false)?.versions).toHaveLength(1);
  });

  test("the home shows each admitted agent at work, four counts and Catch up's tabs; work outside the admitted projects stays out", async () => {
    building("mine", "Export orders", "builder-1");
    building("theirs", "Rotate keys", "builder-2", other);
    filed("waiting", "Show the balance", T0, false);
    const cookie = await login();
    const home = (await workspace(cookie, "/chat")).home!;
    expect(home.agents.map(one => [one.taskId, one.phase]).sort()).toEqual([["mine", "Writing the change"], ["theirs", "Writing the change"]]);
    expect(home.counts.map(one => one.key)).toEqual(["working", "waiting", "ready", "done"]);
    expect(home.counts.find(one => one.key === "working")!.value).toBe(2);
    expect(home.catchUp.find(one => one.id === "mine")?.tab).toBe("running");
    expect(home.catchUp.find(one => one.id === "waiting")?.tab).toBe("needs-you");
    expect(JSON.stringify(home)).not.toMatch(/\$\d/);
    // Work outside this installation's projects never appears, nor counts.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "console-v2-outside-")));
    try {
      register(store, { name: "builder-3", host: "test", capacity: 1, repos: [outside], now: T0, newToken: () => "tok-builder-3" });
      building("elsewhere", "Somebody else's work", "builder-3", outside);
      const again = (await workspace(cookie, "/chat")).home!;
      expect(again.agents.map(one => one.taskId).sort()).toEqual(["mine", "theirs"]);
      expect(again.catchUp.some(one => one.id === "elsewhere")).toBe(false);
      expect(again.counts.find(one => one.key === "working")!.value).toBe(2);
    } finally { rmSync(outside, { recursive: true, force: true }); }
    // A project-restricted member has no lead chat, so no home either: the refusal is unchanged.
    const minted = store.mintInvite("approver", "alex", T0, undefined, [repo]);
    expect(store.admitInviteAttempt(minted.token, T0)).not.toBeNull();
    expect(store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name: "sam", credentialHash: hashPassword("sam-member-password") }, T0).ok).toBe(true);
    const samCookie = await login("sam", "sam-member-password");
    const refused = await fetch(url("/chat?format=workspace"), { headers: { cookie: samCookie } });
    expect(refused.status).toBe(403);
    expect((await refused.json() as BrowserWorkspace).home).toBeUndefined();
  });

  test("the Inbox has Needs you, Ready, Running and All as real links; each tab shows its own sections", async () => {
    filed("waiting", "Show the balance", T0, false);
    building("mine", "Export orders", "builder-1");
    const cookie = await login();
    const all = await fetch(url("/inbox"), { headers: { cookie } });
    const allHtml = await all.text();
    expect(all.headers.get("set-cookie")).toMatch(/^so-inbox-seen=[0-9a-f]{8}(\.[0-9a-f]{8}){3};/);
    for (const tab of ["needs-you", "ready", "running", "all"]) expect(allHtml).toContain(`href="/inbox?tab=${tab}"`);
    expect(allHtml).toContain("Approve a scope");
    expect(allHtml).toContain("Running now");
    const running = await (await fetch(url("/inbox?tab=running"), { headers: { cookie } })).text();
    expect(running).toContain("Running now");
    expect(running).not.toContain("Approve a scope");
    const needs = await (await fetch(url("/inbox?tab=needs-you"), { headers: { cookie } })).text();
    expect(needs).toContain("Approve a scope");
    expect(needs).not.toContain("Running now");
    // Needs you groups by the ask: a plan to approve is under Decide, with its count.
    expect(needs).toMatch(/<section class="inbox-ask" data-ask="decide"><h2>Decide <span class="count">1<\/span><\/h2><h3>Approve a scope<\/h3>/);
    // A tab that changed since this browser looked wears a dot (phones show it).
    const seen = (all.headers.get("set-cookie") ?? "").split(";")[0]!;
    filed("waiting-2", "Show the points", T0, false);
    const dotted = await (await fetch(url("/inbox?tab=running"), { headers: { cookie: `${cookie}; ${seen}` } })).text();
    expect(dotted).toMatch(/data-inbox-tab="needs-you">[^]*?class="inbox-unread"/);
  });
});
