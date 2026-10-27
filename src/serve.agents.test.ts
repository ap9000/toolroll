/** The Agents board through the server: /peek opens it, an agent's question shows on it and in Needs you, Reply
 * reaches the running agent through the steering mailbox and closes that question, and an open agent's room holds
 * its viewer's pings while it is open. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { attemptKeyOf, ingestStatus, openAgentQuestions, recordAgentTurn, watchedPing, watchingAgent } from "./agent-board.js";
import type { BrowserAgentsView, BrowserTasksView, BrowserWorkspace } from "./browser-workspace.js";
import { acquire } from "./claim.js";
import { steerFolderName } from "./evidence.js";
import { steerCapabilityOf } from "./steer-capabilities.js";
import { register } from "./runner.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openSteerMailbox, pulseSteerMailbox } from "./steer-mailbox.js";
import { openStore, type Store } from "./store.js";
import { presented, T0, workspaceOf } from "../test/serve-kit.js";

let store: Store, server: Server, base: string, evidenceRoot: string, repoA: string, repoB: string, worktree: string;
let alexToken: string, robinToken: string;
const url = (path: string) => `${base}${path}`;

async function login(name: string, token: string): Promise<string> {
  const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
  expect(response.status).toBe(303);
  return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
}
const page = async (path: string, cookie: string): Promise<BrowserWorkspace> =>
  workspaceOf(await (await fetch(url(path), { headers: { cookie } })).text());
const board = async (path: string, cookie: string) => (await page(path, cookie)).view as BrowserAgentsView;

/** A running task in a project: placed, claimed on a live lease, its run started, its agent busy. */
function running(id: string, repo: string): number {
  store.createTask({ id, title: `Fix ${id}` }, T0);
  const ref = store.refFor("built-in", id, "ours").id;
  store.placeTask(ref, repo);
  const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
  if (!taken.ok) throw new Error("claim failed");
  const run = store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1", branch: `b-${id}`, worktree, now: new Date(), ...presented(store, ref, "builder") });
  recordAgentTurn(store, { run, attemptKey: attemptKeyOf(store, run)!, state: "busy", at: new Date() });
  return run;
}
/** The agent appends a needs-decision line; the pulse reads past it. */
let offset = 0;
const ask = (run: number, key: string, question: string) =>
  ingestStatus(store, run, attemptKeyOf(store, run)!, { lines: [{ status: "needs-decision", key, question }], nextOffset: offset += 100 }, new Date());

beforeEach(async () => {
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  evidenceRoot = mkdtempSync(join(tmpdir(), "so-agents-ev-"));
  worktree = mkdtempSync(join(tmpdir(), "so-agents-wt-"));
  repoA = realpathSync(mkdtempSync(join(tmpdir(), "so-agents-a-")));
  repoB = realpathSync(mkdtempSync(join(tmpdir(), "so-agents-b-")));
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap failed");
  alexToken = alex.token;
  const robin = addApprover(store, "robin", T0, { name: "alex", token: alexToken });
  if (!robin.ok) throw new Error("robin");
  robinToken = robin.token;
  expect(store.setAccountProjects("robin", [repoB], "alex", T0)).toEqual({ ok: true });
  register(store, { name: "builder-1", host: "here", capacity: 4, repos: [repoA, repoB], now: new Date(), newToken: () => "tok-builder-1" });
  server = createDecisionServer({ store, evidenceRoot, repos: [repoA, repoB], clock: () => new Date() });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  for (const dir of [evidenceRoot, worktree, repoA, repoB]) rmSync(dir, { recursive: true, force: true });
});

describe("the Agents board", () => {
  test("replaces Peek, and groups agents by state in the viewer's own projects", async () => {
    const cookie = await login("alex", alexToken);
    const peek = await fetch(url("/peek"), { headers: { cookie }, redirect: "manual" });
    expect([302, 303]).toContain(peek.status);
    expect(peek.headers.get("location")).toBe("/agents");

    const empty = await page("/agents", cookie);
    expect(empty.navigation.find(item => item.label === "Agents")).toMatchObject({ href: "/agents", active: true });

    const quiet = running("t-quiet", repoA);
    const asking = running("t-ask", repoA);
    running("t-other", repoB);
    ask(asking, "keep-oauth", "Keep the old OAuth button?");
    const view = await board("/agents", cookie);
    expect(view.groups.map(group => [group.key, group.rows.map(row => row.runId)])).toEqual([["needs-you", [asking]], ["working", [expect.any(Number), quiet]]]);
    expect(view.groups[0]!.rows[0]).toMatchObject({ title: "Fix t-ask", label: "Question", line: "Keep the old OAuth button?", href: `/agents?run=${asking}` });

    // Robin works in project B only: A's agents are not on Robin's board, and A's agent room is not Robin's to open.
    const robin = await login("robin", robinToken);
    expect((await board("/agents", robin)).groups.flatMap(group => group.rows.map(row => row.title))).toEqual(["Fix t-other"]);
    expect((await board(`/agents?run=${asking}`, robin)).selected).toBeNull();
    expect((await fetch(url(`/live?room=${encodeURIComponent(`agent:${asking}`)}`), { headers: { cookie: robin } })).status).toBe(404);
  });

  test("a question shows in Needs you, and Reply reaches the running agent through its steering mailbox and closes that question", async () => {
    const cookie = await login("alex", alexToken);
    const run = running("t-ask", repoA);
    ask(run, "keep-oauth", "Keep the old OAuth button?");
    ask(run, "label", "Which label for the new button?");

    const tasks = (await page("/work?view=needs-you", cookie)).view as BrowserTasksView;
    expect(tasks.rows.find(row => row.id === "t-ask")).toMatchObject({ action: { label: "Reply", href: `/agents?run=${run}` } });

    const opened = await fetch(url(`/agents?run=${run}`), { headers: { cookie } });
    const html = await opened.text();
    const view = workspaceOf(html).view as BrowserAgentsView;
    expect(view.selected).toMatchObject({ runId: run, live: true, question: { key: "keep-oauth", text: "Keep the old OAuth button?", action: "/t/t-ask/reply" },
      steer: { action: "/t/t-ask/steer", run }, room: `agent:${run}` });
    const csrf = workspaceOf(html).csrf;

    const posted = await fetch(url("/t/t-ask/reply"), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, question: String(view.selected!.question!.id), answer: "Keep it until the new one ships." }).toString() });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe(`/agents?run=${run}&said=replied`);
    // Exactly that key closed; the other question is still open, and the run keeps going.
    expect(openAgentQuestions(store, store.getRun(run)!.taskRef).map(one => one.key)).toEqual(["label"]);
    expect(store.getRun(run)?.outcome).toBeNull();
    const after = await board(`/agents?run=${run}&said=replied`, cookie);
    expect(after.selected).toMatchObject({ question: { key: "label" }, said: { tone: "info", text: "Reply sent. The agent reads it at its next check." } });

    // The real mailbox pulse delivers the reply into the running agent's steering folder, under its key.
    const box = openSteerMailbox(worktree, steerFolderName(), run, store.getRun(run)!.taskRef, ["ab", "cd", "ef", "01", "23", "45", "67", "89"].join(""))!;
    store.markSteerFolderOpened(run, new Date());
    pulseSteerMailbox(store, box, new Date(), true);
    const [mailed] = readdirSync(box.dir).filter(name => name.endsWith(".json"));
    expect(JSON.parse(readFileSync(join(box.dir, mailed!), "utf8")).note).toContain('Reply to your question "keep-oauth": Keep it until the new one ships.');

    // The same reply again is refused in words, and saves nothing.
    const again = await fetch(url("/t/t-ask/reply"), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, question: String(view.selected!.question!.id), answer: "again" }).toString() });
    expect(again.headers.get("location")).toBe(`/agents?run=${run}&said=reply-closed`);
    expect(store.listSteerNotes(store.getRun(run)!.taskRef)).toHaveLength(1);
  });

  test("a steer note from the board returns to the same agent", async () => {
    const cookie = await login("alex", alexToken);
    const run = running("t-steer", repoA);
    const csrf = (await page(`/agents?run=${run}`, cookie)).csrf;
    const posted = await fetch(url("/t/t-steer/steer"), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "Start with the retry path.", return: "agents", run: String(run), key: "draft-board-1" }).toString() });
    expect(posted.headers.get("location")).toBe(`/agents?run=${run}&said=steered&sent=draft-board-1`);
    expect(store.listSteerNotes(store.getRun(run)!.taskRef).map(one => one.note)).toEqual(["Start with the retry path."]);
  });

  test("a steer note is bound to the run on screen: filed once per draft, and never onto another attempt", async () => {
    const cookie = await login("alex", alexToken);
    const run = running("t-bound", repoA);
    const taskRef = store.getRun(run)!.taskRef;
    const send = async (fields: Record<string, string>) => {
      const csrf = (await page(`/agents?run=${run}`, cookie)).csrf;
      const posted = await fetch(url("/t/t-bound/steer"), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, return: "agents", run: String(run), ...fields }).toString() });
      return posted.headers.get("location");
    };
    // A double submit of one draft files it once.
    expect(await send({ note: "Check the retry path.", key: "draft-0001" })).toBe(`/agents?run=${run}&said=steered&sent=draft-0001`);
    expect(await send({ note: "Check the retry path.", key: "draft-0001" })).toBe(`/agents?run=${run}&said=steered&sent=draft-0001`);
    expect(store.listSteerNotes(taskRef).map(one => one.note)).toEqual(["Check the retry path."]);
    // The same key with other words is refused, and files nothing.
    expect(await send({ note: "Something else.", key: "draft-0001" })).toBe(`/agents?run=${run}&said=steer-stale`);
    expect(store.listSteerNotes(taskRef)).toHaveLength(1);
    // A form that asks for an agent but names none properly is refused, never filed unbound.
    for (const bad of [{ run: "not-a-run", key: "draft-0003" }, { run: String(run), key: "" }, { run: String(run), key: "../x" }]) {
      const csrf = (await page(`/agents?run=${run}`, cookie)).csrf;
      const posted = await fetch(url("/t/t-bound/steer"), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, return: "agents", note: "Unbound?", ...bad }).toString() });
      expect(posted.status).toBe(400);
    }
    expect(store.listSteerNotes(taskRef)).toHaveLength(1);
    // Once that attempt has ended, a note sent from its pane is refused rather than landing on the next one.
    store.finishRun(run, { outcome: "failed", reason: "agent", now: new Date() });
    expect(await send({ note: "Too late.", key: "draft-0002" })).toBe(`/agents?run=${run}&said=steer-ended`);
    expect(store.listSteerNotes(taskRef).map(one => one.note)).toEqual(["Check the retry path."]);
    // Sent on to the next attempt on purpose, it is filed for the task — once per draft — and comes back naming that draft.
    const onward = async (fields: Record<string, string>) => {
      const csrf = (await page(`/agents?run=${run}`, cookie)).csrf;
      const posted = await fetch(url("/t/t-bound/steer"), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, ...fields }).toString() });
      return { status: posted.status, location: posted.headers.get("location") };
    };
    expect(await onward({ note: "Too late.", after: String(run), key: "draft-0002" })).toEqual({ status: 303, location: `/agents?run=${run}&said=steered-next&sent=draft-0002` });
    expect(await onward({ note: "Too late.", after: String(run), key: "draft-0002" })).toEqual({ status: 303, location: `/agents?run=${run}&said=steered-next&sent=draft-0002` });
    expect(store.listSteerNotes(taskRef).map(one => one.note)).toEqual(["Check the retry path.", "Too late."]);
    expect((await onward({ note: "Mixed.", after: String(run), key: "draft-0004", run: String(run) })).status).toBe(400);
    // One receipt for both ways of sending: a draft filed while the run lived (its answer lost) comes back as sent,
    // not twice; and a key never vouches for other words.
    expect(await onward({ note: "Check the retry path.", after: String(run), key: "draft-0001" })).toEqual({ status: 303, location: `/agents?run=${run}&said=steered-next&sent=draft-0001` });
    expect(await onward({ note: "Other words.", after: String(run), key: "draft-0002" })).toEqual({ status: 303, location: `/agents?run=${run}&said=steer-stale` });
    store.setTaskState("t-bound", "done", new Date());
    expect(await onward({ note: "After done.", after: String(run), key: "draft-0005" })).toEqual({ status: 303, location: `/agents?run=${run}&said=steer-next-finished` });
    expect(store.listSteerNotes(taskRef)).toHaveLength(2);
  });

  test("an open agent's room is a watch: its viewer's Needs you pings wait until the page closes", async () => {
    const cookie = await login("alex", alexToken);
    const run = running("t-watch", repoA);
    ask(run, "keep-oauth", "Keep the old OAuth button?");
    const ping = store.listNotifications("all").find(one => one.kind === "agent-question")!;
    expect(watchedPing(store, ping, "alex", new Date())).toBe("send");

    const controller = new AbortController();
    const response = await fetch(url(`/live?room=${encodeURIComponent(`agent:${run}`)}`), { headers: { cookie, accept: "text/event-stream" }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain(`"room":"agent:${run}"`);
    expect(watchingAgent(store, "alex", run, new Date())).toBe(true);
    expect(watchedPing(store, ping, "alex", new Date())).toEqual({ hold: expect.any(String) });
    expect(watchedPing(store, ping, "robin", new Date())).toBe("send");

    controller.abort();
    for (let i = 0; i < 200 && watchingAgent(store, "alex", run, new Date()); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(watchingAgent(store, "alex", run, new Date())).toBe(false);
    // The question is still open, so the held ping now goes.
    expect(watchedPing(store, ping, "alex", new Date())).toBe("send");
  });
});

describe("what a running agent takes (cockpit §4)", () => {
  /** The composer's own form fields, as the page would post them. */
  const csrfOf = async (cookie: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(url("/settings"), { headers: { cookie } })).text())?.[1] ?? "";
  const post = async (cookie: string, path: string, fields: Record<string, string>) => {
    const answer = await fetch(url(path), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: await csrfOf(cookie), ...fields }).toString() });
    return { status: answer.status, location: answer.headers.get("location") ?? "" };
  };

  test("each capability, from the run's own facts: live input, mailbox, repair, planner, finished", () => {
    const now = new Date();
    const live = running("t-cap-live", repoA);
    store.handle.prepare("UPDATE run SET phase = 'agent-running', steer_opened_at = ?, live_input_opened_at = ? WHERE id = ?").run(now.toISOString(), now.toISOString(), live);
    expect(steerCapabilityOf(store, live, now)).toMatchObject({ send: "live", pause: true, stop: { run: live, label: "Stop" } });
    const mailbox = running("t-cap-box", repoA);
    // Not yet at work: a note goes into its brief.
    expect(steerCapabilityOf(store, mailbox, now)).toMatchObject({ send: "mailbox", words: "It reads notes when it starts working." });
    store.handle.prepare("UPDATE run SET phase = 'agent-running', steer_opened_at = ? WHERE id = ?").run(now.toISOString(), mailbox);
    expect(steerCapabilityOf(store, mailbox, now)).toMatchObject({ send: "mailbox", pause: false, stop: { run: mailbox }, words: "It reads notes at its next check." });
    // Its mailbox closed while it finishes: no note reaches this attempt, and the view says so.
    store.handle.prepare("UPDATE run SET steer_closed_at = ? WHERE id = ?").run(now.toISOString(), mailbox);
    expect(steerCapabilityOf(store, mailbox, now)).toMatchObject({ send: null, stop: { run: mailbox } });
    store.handle.prepare("UPDATE run SET steer_closed_at = NULL WHERE id = ?").run(mailbox);
    // A stop the store would refuse is not offered: here, a claim that has lapsed.
    const lapsed = running("t-cap-lapsed", repoA);
    store.handle.prepare("UPDATE claim SET expires_at = ? WHERE task_ref = (SELECT task_ref FROM run WHERE id = ?)").run(new Date(now.getTime() - 1000).toISOString(), lapsed);
    expect(steerCapabilityOf(store, lapsed, now)?.stop ?? null).toBeNull();
    // Its protocol repair: no notes for either, and Stop names the owning attempt.
    const repair = store.handle.prepare("INSERT INTO run (task_ref, lease_id, runner, branch, worktree, started_at, role, parent_run, provider) SELECT task_ref, lease_id, runner, branch, worktree, ?, 'repair', id, provider FROM run WHERE id = ?")
      .run(now.toISOString(), mailbox).lastInsertRowid;
    expect(steerCapabilityOf(store, Number(repair), now)).toMatchObject({ send: null, stop: { run: mailbox, label: "Stop this attempt" } });
    expect(steerCapabilityOf(store, mailbox, now)).toMatchObject({ send: null, stop: { run: mailbox, label: "Stop this attempt" } });
    const planner = store.handle.prepare("UPDATE run SET role = 'planner' WHERE id = ?").run(live);
    expect(planner.changes).toBe(1);
    expect(steerCapabilityOf(store, live, now)).toMatchObject({ send: null, pause: false, words: "This planner can't take notes; stop it to change its course." });
    store.finishRun(live, { outcome: "built", committed: true, now });
    expect(steerCapabilityOf(store, live, now)).toBeNull();
  });

  test("the agent view offers what its attempt takes; Stop comes back to it; a note for an agent that takes none is refused, never filed", async () => {
    const cookie = await login("alex", alexToken);
    const run = running("t-cap-board", repoA);
    store.handle.prepare("UPDATE run SET phase = 'agent-running', steer_opened_at = ? WHERE id = ?").run(new Date().toISOString(), run);
    const detail = (await board(`/agents?run=${run}`, cookie)).selected!;
    expect(detail.controls).toMatchObject({ send: "mailbox", words: "It reads notes at its next check.", pause: null, stop: { run, label: "Stop", action: "/t/t-cap-board/stop" } });
    expect(detail.steer).toMatchObject({ run });
    // A planner running for the same task: no notes; the board's send is refused in words, and nothing is filed.
    store.handle.prepare("UPDATE run SET role = 'planner' WHERE id = ?").run(run);
    // A planner opens on the board too, saying it takes no notes, with Stop and no box.
    const planner = (await board(`/agents?run=${run}`, cookie)).selected!;
    expect(planner.controls).toMatchObject({ send: null, words: "This planner can't take notes; stop it to change its course.", stop: { run } });
    expect(planner.steer).toBeNull();
    const before = store.handle.prepare("SELECT COUNT(*) AS n FROM task_steer").get()!["n"];
    const refused = await post(cookie, "/t/t-cap-board/steer", { note: "use the other table", return: "agents", run: String(run), key: "k-planner-0001" });
    expect(refused.location).toBe(`/agents?run=${run}&said=steer-no-notes`);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM task_steer").get()!["n"]).toBe(before);
    store.handle.prepare("UPDATE run SET role = 'builder' WHERE id = ?").run(run);
    const stopped = await post(cookie, "/t/t-cap-board/stop", { run: String(run), return: "agents" });
    expect(stopped.location).toBe(`/agents?run=${run}&said=stopping`);
    expect((await board(`/agents?run=${run}&said=stopping`, cookie)).selected?.said).toMatchObject({ text: "Stopping. The work so far is kept." });
  });
});

describe("the task page's note is for the exact attempt (cockpit §4)", () => {
  test("its form names the running build; a note for an attempt that has ended is refused, never filed for the next", async () => {
    const cookie = await login("alex", alexToken);
    const run = running("t-page-note", repoA);
    store.handle.prepare("UPDATE run SET phase = 'agent-running', steer_opened_at = ? WHERE id = ?").run(new Date().toISOString(), run);
    const html = await (await fetch(url("/t/t-page-note"), { headers: { cookie } })).text();
    const form = [...html.matchAll(/<form[^>]*action="\/t\/t-page-note\/steer"[^>]*>[\s\S]*?<\/form>/g)].map(one => one[0]).find(one => one.includes('name="run"')) ?? "";
    // The page's own composer names the same run, and says what it takes.
    const view = workspaceOf(html).view as import("./browser-workspace.js").BrowserTaskView;
    expect(view.steering).toMatchObject({ steer: { run, action: "/t/t-page-note/steer" }, controls: { send: "mailbox", words: "It reads notes at its next check." } });
    expect(form).toContain(`name="run" value="${run}"`);
    expect(form).toContain('name="return" value="task"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(form)?.[1] ?? "";
    const key = /name="key" value="([^"]+)"/.exec(form)?.[1] ?? "";
    store.finishRun(run, { outcome: "failed", reason: "agent", now: new Date() });
    const before = store.handle.prepare("SELECT COUNT(*) AS n FROM task_steer").get()!["n"];
    const answer = await fetch(url("/t/t-page-note/steer"), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "use the cache", run: String(run), key, return: "task" }).toString() });
    expect(answer.status).toBe(409);
    expect(await answer.text()).toContain("that attempt ended before your note");
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM task_steer").get()!["n"]).toBe(before);
  });

  test("while a planner runs, the page's form is plainly for the next attempt; the demo files nothing", async () => {
    const cookie = await login("alex", alexToken);
    const run = running("t-page-plan", repoA);
    store.handle.prepare("UPDATE run SET role = 'planner' WHERE id = ?").run(run);
    const html = await (await fetch(url("/t/t-page-plan"), { headers: { cookie } })).text();
    expect(html).toContain("Save for the next attempt");
    expect((workspaceOf(html).view as import("./browser-workspace.js").BrowserTaskView).steering).toMatchObject({ steer: null, controls: { send: null, words: "This planner can't take notes; stop it to change its course." } });
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
    store.recordInstallationFact("demo", "1", new Date());
    expect(store.isDemo()).toBe(true);
    const before = store.handle.prepare("SELECT COUNT(*) AS n FROM task_steer").get()!["n"];
    const answer = await fetch(url("/t/t-page-plan/steer"), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "try the cache" }).toString() });
    expect(answer.status).toBe(403);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM task_steer").get()!["n"]).toBe(before);
  });
});

describe("composer receipts and reach (cockpit §4, round 2)", () => {
  const form = async (cookie: string, path: string, fields: Record<string, string>) => {
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(url("/settings"), { headers: { cookie } })).text())?.[1] ?? "";
    const answer = await fetch(url(path), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, ...fields }).toString() });
    return answer.headers.get("location") ?? "";
  };

  test("pause and send clears a draft only when that very note was stored: a repeated request with new words keeps the new draft", async () => {
    const cookie = await login("alex", alexToken);
    const run = running("t-ps", repoA);
    const now = new Date().toISOString();
    store.handle.prepare("UPDATE run SET phase = 'agent-running', steer_opened_at = ?, live_input_opened_at = ? WHERE id = ?").run(now, now, run);
    const first = await form(cookie, "/t/t-ps/pause", { run: String(run), request: "steer-draft-one-0001", note: "use the cache", key: "draft-one-0001", return: "agents" });
    expect(first).toContain("&sent=draft-one-0001");
    // The same request again, with edited words (a restored form): the store answers with the first note, so nothing clears.
    const again = await form(cookie, "/t/t-ps/pause", { run: String(run), request: "steer-draft-one-0001", note: "use the replica", key: "draft-two-0002", return: "agents" });
    expect(again).not.toContain("sent=");
    expect(again).toContain("said=pause-note-stale");
  });

  test("a running review has its composer on the task page; the timeline opens every role in the agent view", async () => {
    const cookie = await login("alex", alexToken);
    const build = running("t-rev", repoA);
    store.finishRun(build, { outcome: "built", committed: true, now: new Date() });
    const review = store.handle.prepare("INSERT INTO run (task_ref, lease_id, runner, started_at, role, provider, parent_run) SELECT task_ref, 'review-lease-1', runner, ?, 'reviewer', provider, id FROM run WHERE id = ?")
      .run(new Date().toISOString(), build).lastInsertRowid;
    const view = workspaceOf(await (await fetch(url("/t/t-rev"), { headers: { cookie } })).text()).view as import("./browser-workspace.js").BrowserTaskView;
    expect(view.steering).toMatchObject({ steer: null, controls: { send: null, words: "This reviewer can't take notes; stop it to change its course.", stop: { run: Number(review) } } });
    expect(view.steerRecent).toContain(build);
    const lanes = (await board("/agents", cookie)).lanes;
    const hrefs = (lanes?.lanes ?? []).flatMap(lane => lane.segments.map(one => one.href));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every(href => href.startsWith("/agents?run="))).toBe(true);
  });
});

describe("Settings → Project → Live view", () => {
  /** The Project page's own form, as the person sees it: its csrf, and the single-use nonce Show commands carries. */
  const form = async (cookie: string, repo: string) => {
    const html = await (await fetch(url(`/settings/project?repo=${encodeURIComponent(repo)}`), { headers: { cookie } })).text();
    return { csrf: /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "", nonce: /name="nonce" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "" };
  };
  const post = async (cookie: string, fields: Record<string, string>) => {
    const posted = await fetch(url("/settings/project/live-view"), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString() });
    return { status: posted.status, location: decodeURIComponent(posted.headers.get("location") ?? "") };
  };
  const send = async (cookie: string, fields: Record<string, string>) => post(cookie, { ...(await form(cookie, fields["repo"]!)), ...fields });

  test("showing commands takes the approver's password, hiding them is one step; each is a ledger line the next run reads", async () => {
    const { liveCommandsShown, liveLogContext } = await import("./live-detail.js");
    const cookie = await login("alex", alexToken);
    expect(liveCommandsShown(store, repoA)).toBe(false);
    expect((await send(cookie, { repo: repoA, act: "on", password: "wrong" })).location).toContain("problem=Enter your Toolroll password");
    expect(liveCommandsShown(store, repoA)).toBe(false);
    expect((await send(cookie, { repo: repoA, act: "on", password: alexToken })).location).toContain("said=Commands now show");
    expect(liveCommandsShown(store, repoA)).toBe(true);
    // A run opened now carries the project's choice; another project is untouched.
    const run = running("t-live", repoA);
    expect(liveLogContext(store, run, store.getRun(run)!.taskRef, "/pool/wt", new Date())).toEqual({ base: "/pool/wt", commands: true });
    expect(liveCommandsShown(store, repoB)).toBe(false);
    expect((await send(cookie, { repo: repoA, act: "off" })).location).toContain("said=Commands are hidden");
    expect(liveCommandsShown(store, repoA)).toBe(false);
    // Turning it on is consent to that one change: the same form replayed, or one without its nonce, changes nothing.
    const once = await form(cookie, repoA);
    expect((await post(cookie, { ...once, repo: repoA, act: "on", password: alexToken })).location).toContain("said=Commands now show");
    await send(cookie, { repo: repoA, act: "off" });
    expect((await post(cookie, { ...once, repo: repoA, act: "on", password: alexToken })).location).toContain("problem=That form was already used");
    expect((await post(cookie, { csrf: once.csrf, repo: repoA, act: "on", password: alexToken })).location).toContain("problem=That form was already used");
    expect(liveCommandsShown(store, repoA)).toBe(false);
    expect(store.handle.prepare("SELECT actor, outcome FROM action_ledger WHERE action = 'live view commands' ORDER BY id").all().map(row => [row["actor"], row["outcome"]]))
      .toEqual([["alex", "on"], ["alex", "off"], ["alex", "on"], ["alex", "off"]]);
  });

  test("a project outside the person's access refuses, and changes nothing", async () => {
    const cookie = await login("robin", robinToken);
    expect((await send(cookie, { repo: repoA, act: "on", password: robinToken })).status).toBe(403);
    const { liveCommandsShown } = await import("./live-detail.js");
    expect(liveCommandsShown(store, repoA)).toBe(false);
  });
});

describe("the Live grid (docs/plans/agents-view.md §3)", () => {
  const tiles = async (cookie: string) => {
    const response = await fetch(url("/agents/live"), { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return ((await response.json()) as { tiles: { runId: number; role: string; state: string; why: string | null; project: string | null }[] }).tiles;
  };

  test("lists running and just-ended agents in the viewer's own projects, newest first, with Needs you", async () => {
    const a = running("t-a", repoA), b = running("t-b", repoB), done = running("t-done", repoB), old = running("t-old", repoB);
    store.finishRun(done, { outcome: "built", committed: true, now: new Date() });
    store.finishRun(old, { outcome: "built", committed: true, now: new Date(Date.now() - 11 * 60_000) });
    ask(b, "keep-button", "Keep the old button?");
    store.handle.prepare("UPDATE run SET role = 'scout' WHERE id = ?").run(a); // every role is on the grid, not only builds
    const alex = await tiles(await login("alex", alexToken));
    expect(alex.find(tile => tile.runId === a)).toMatchObject({ role: "scout", state: "working" });
    expect(alex.map(tile => tile.runId)).toEqual([done, b, a]);
    expect(alex.find(tile => tile.runId === b)).toMatchObject({ state: "needs-you", why: "question" });
    expect(alex.find(tile => tile.runId === done)).toMatchObject({ state: "done" });
    const robin = await tiles(await login("robin", robinToken));
    expect(robin.map(tile => tile.runId)).toEqual([done, b]); // never another project's
  });

  test("watching changes nothing: ?view=live never marks a finished agent seen or offers a composer", async () => {
    const run = running("t-seen", repoA);
    store.finishRun(run, { outcome: "built", committed: true, now: new Date() });
    const cookie = await login("alex", alexToken);
    const live = await board(`/agents?view=live&run=${run}`, cookie);
    expect(live.selected).toBeNull();
    await tiles(cookie);
    expect(store.handle.prepare("SELECT count(*) AS n FROM agent_seen").get()?.["n"]).toBe(0);
    expect(store.handle.prepare("SELECT count(*) AS n FROM agent_view").get()?.["n"]).toBe(0);
    // The List view still opens it, and that is a view.
    expect((await board(`/agents?run=${run}`, cookie)).selected).not.toBeNull();
    expect(store.handle.prepare("SELECT count(*) AS n FROM agent_seen").get()?.["n"]).toBe(1);
  });
});

describe("the Live grid's reads (docs/plans/agents-view.md §3)", () => {
  let local: Server, localBase: string;
  beforeEach(async () => {
    local = createDecisionServer({ store, evidenceRoot, repos: [repoA, repoB], clock: () => new Date(), localRunner: "builder-1" });
    await new Promise<void>(resolve => local.listen(0, "127.0.0.1", resolve));
    const address = local.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    localBase = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { local.closeAllConnections?.(); await new Promise<void>(resolve => local.close(() => resolve())); });
  const signIn = async (name: string, token: string) => {
    const response = await fetch(`${localBase}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };
  const get = async (path: string, cookie: string) => {
    const response = await fetch(`${localBase}${path}`, { headers: { cookie } });
    return { status: response.status, body: await response.json() as Record<string, unknown> & { records?: unknown[]; cursor?: string } };
  };
  const record = async (run: number) => {
    const { openLiveLog } = await import("./live.js");
    const log = openLiveLog(evidenceRoot, run, { base: worktree, commands: false })!;
    log.observe({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "planning" }, { type: "tool_use", id: "t1", name: "Task", input: { description: "Check the tests" } }] } });
    log.observe({ type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "text", text: "running them" }, { type: "tool_use", id: "b1", name: "Bash", input: { command: "cat ~/.ssh/id_ed25519" } }] } });
    return log;
  };

  test("the run's own records and its subagents', a window at a time, from a cursor; command detail withheld", async () => {
    const run = running("t-read", repoA);
    const log = await record(run);
    const cookie = await signIn("alex", alexToken);
    const main = await get(`/agents/live/${run}?file=main`, cookie);
    expect(main.status).toBe(200);
    expect(JSON.stringify(main.body.records)).toContain("planning");
    const sub = await get(`/agents/live/${run}?file=sub`, cookie);
    expect(sub.body.records).toEqual(expect.arrayContaining([expect.objectContaining({ k: "child", s: 1, desc: "Check the tests" }), expect.objectContaining({ k: "say", s: 1, t: ["running them"] })]));
    expect(JSON.stringify(sub.body)).not.toContain("id_ed25519");
    log.observe({ type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "text", text: "all green" }] } });
    log.close();
    const next = await get(`/agents/live/${run}?file=sub&cursor=${encodeURIComponent(sub.body.cursor!)}`, cookie);
    expect(JSON.stringify(next.body.records)).toContain("all green");
    expect(JSON.stringify(next.body.records)).not.toContain("running them");
    expect((await get(`/agents/live/${run}?file=sub&cursor=forged.cursor`, cookie)).body).toMatchObject({ restarted: true });
  });

  test("another project's run, an unknown file, another runner's run: refused or off, never read", async () => {
    const run = running("t-other", repoA);
    (await record(run)).close();
    expect((await get(`/agents/live/${run}?file=main`, await signIn("robin", robinToken))).status).toBe(404);
    const cookie = await signIn("alex", alexToken);
    expect((await get(`/agents/live/${run}?file=../etc`, cookie)).status).toBe(400);
    expect((await get(`/agents/live/${run}?file=main&extra=1`, cookie)).status).toBe(400);
    store.handle.prepare("UPDATE run SET runner = 'elsewhere' WHERE id = ?").run(run);
    expect((await get(`/agents/live/${run}?file=main`, cookie)).body).toEqual({ error: "off" });
    // Reading changes nothing: no seen mark, no watch.
    expect(store.handle.prepare("SELECT count(*) AS n FROM agent_seen").get()?.["n"]).toBe(0);
    expect(store.handle.prepare("SELECT count(*) AS n FROM agent_view").get()?.["n"]).toBe(0);
  });
});
