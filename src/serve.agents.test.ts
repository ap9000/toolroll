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
    expect((empty.view as BrowserAgentsView).empty).toBe("No agents in the last day. They show here the moment one starts.");

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

  test("opening a run's own result page marks its Done as seen; a failed row states its reason once", async () => {
    const cookie = await login("alex", alexToken);
    const run = running("t-done", repoA);
    store.finishRun(run, { outcome: "built", committed: true, now: new Date() });
    store.setTaskState("t-done", "done", new Date());
    expect((await board("/agents", cookie)).groups).toMatchObject([{ key: "done", rows: [{ runId: run, label: "Done", line: null, diff: null }] }]);
    const result = await fetch(url(`/review?result=t-done&run=${run}`), { headers: { cookie } });
    expect(result.status).toBe(200);
    expect((await board("/agents", cookie)).groups.map(group => group.key)).toEqual(["idle"]);

    // The chip says Failed; the line says why, never "The agent failed." again.
    const generic = running("t-failed", repoA), slow = running("t-slow", repoA);
    store.finishRun(generic, { outcome: "failed", reason: "agent", now: new Date() });
    store.finishRun(slow, { outcome: "failed", reason: "timeout", now: new Date() });
    const rows = (await board("/agents", cookie)).groups.find(group => group.key === "needs-you")!.rows;
    expect(rows.find(row => row.runId === generic)).toMatchObject({ label: "Failed", line: null });
    expect(rows.find(row => row.runId === slow)).toMatchObject({ label: "Failed", line: "Ran out of time." });
  });

  test("a steer note from the board returns to the same agent", async () => {
    const cookie = await login("alex", alexToken);
    const run = running("t-steer", repoA);
    const csrf = (await page(`/agents?run=${run}`, cookie)).csrf;
    const posted = await fetch(url("/t/t-steer/steer"), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "Start with the retry path.", return: "agents", run: String(run) }).toString() });
    expect(posted.headers.get("location")).toBe(`/agents?run=${run}&said=steered`);
    expect(store.listSteerNotes(store.getRun(run)!.taskRef).map(one => one.note)).toEqual(["Start with the retry path."]);
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
