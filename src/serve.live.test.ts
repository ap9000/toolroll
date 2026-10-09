/** One live stream per page through the server (GET /live): each room is admitted with its page's own checks, a write
 * reaches the rooms it touches at once, who else is here, the last-activity line on Task, Home and Crew, and the
 * stream's rooms: workspace, task, flow, team. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore, type Store } from "./store.js";
import type { BrowserTaskView, BrowserWorkspace } from "./browser-workspace.js";
import { presented, T0 } from "../test/serve-kit.js";
import { mintApiToken } from "./api-tokens.js";
import { flowFromSteps } from "./flows.js";

let store: Store;
let server: Server;
let base: string;
let evidenceRoot: string;
let repoA: string;
let repoB: string;
let alexToken: string;
/** A page's stream for these rooms. */
const live = (...rooms: string[]) => `/live?${rooms.map(one => `room=${encodeURIComponent(one)}`).join("&")}`;
const taskRoom = (task: string) => `task:${encodeURIComponent(task)}`;
let robinToken: string;
const url = (path: string) => `${base}${path}`;

async function login(name: string, token: string): Promise<string> {
  const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
  expect(response.status).toBe(303);
  return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

/** A running task in a project: placed, claimed on a live lease, its run started. */
function running(id: string, repo: string): number {
  store.createTask({ id, title: `work ${id}` }, T0);
  const ref = store.refFor("built-in", id, "ours").id;
  store.placeTask(ref, repo);
  const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
  if (!taken.ok) throw new Error("claim failed");
  return store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1", branch: `b-${id}`, worktree: `/pool/${id}`, now: new Date(), ...presented(store, ref, "builder") });
}

/** An open stream's events, read as they arrive until `until` says enough (or the wait runs out). */
async function stream(path: string, cookie: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(url(path), { headers: { ...(cookie === "" ? {} : { cookie }), accept: "text/event-stream", ...headers }, signal: controller.signal, redirect: "manual" });
  const events: { event: string; data: unknown }[] = [];
  const reader = response.status === 200 ? response.body!.getReader() : null;
  let buffer = "";
  const decoder = new TextDecoder();
  const until = async (done: (all: typeof events) => boolean, ms = 5_000): Promise<typeof events> => {
    const deadline = Date.now() + ms;
    while (!done(events) && reader !== null && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise<null>(resolve => setTimeout(() => resolve(null), deadline - Date.now()))]);
      if (next === null || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        const name = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
        if (name !== undefined && data !== undefined) events.push({ event: name, data: JSON.parse(data) });
      }
    }
    return events;
  };
  return { response, events, until, close: () => controller.abort() };
}

beforeEach(async () => {
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-live-tasks-ev-"));
  repoA = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-live-tasks-a-")));
  repoB = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-live-tasks-b-")));
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap failed");
  alexToken = alex.token;
  const robin = addApprover(store, "robin", T0, { name: "alex", token: alexToken });
  if (!robin.ok) throw new Error("robin");
  robinToken = robin.token;
  // Robin works in project B only.
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
  for (const dir of [evidenceRoot, repoA, repoB]) rmSync(dir, { recursive: true, force: true });
});

describe("the task room", () => {
  test("a signed-in page hears where the task stands, then a nudge when the agent does something", async () => {
    const run = running("t-live", repoA);
    const cookie = await login("alex", alexToken);
    const page = await stream(live(taskRoom("t-live")), cookie);
    expect(page.response.status).toBe(200);
    expect(page.response.headers.get("content-type")).toBe("text/event-stream");
    const [first] = await page.until(all => all.some(one => one.event === "here"));
    expect(first).toMatchObject({ event: "change", data: { room: "task:t-live", at: expect.stringMatching(/^[0-9a-f]{16}$/) } });

    // The agent runs a command: the next tick nudges, with no task data in it.
    store.recordRunActivity(run, "command", new Date());
    const changes = (await page.until(all => all.filter(one => one.event === "change").length >= 2)).filter(one => one.event === "change");
    expect(changes).toHaveLength(2);
    expect(changes[1]!.data).not.toEqual(changes[0]!.data);
    expect(Object.keys(changes[1]!.data as object)).toEqual(["room", "at", "revision"]);
    expect((changes[1]!.data as { room: string }).room).toBe("task:t-live");
    page.close();
  });

  test("a revision's address follows its family: the stream is the family root's", async () => {
    running("t-root", repoA);
    const cookie = await login("alex", alexToken);
    const missing = await stream(live(taskRoom("nothing-here")), cookie);
    expect(missing.response.status).toBe(404);
    const ok = await stream(live(taskRoom("t-root")), cookie);
    expect(ok.response.status).toBe(200);
    ok.close();
  });

  test("without a signed-in browser session there is no stream", async () => {
    running("t-anon", repoA);
    const anonymous = await stream(live(taskRoom("t-anon")), "");
    expect(anonymous.response.status).not.toBe(200);
    expect(anonymous.response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
  });

  test("a project-scoped account hears only its own projects' tasks, and who else is looking", async () => {
    running("t-a", repoA);
    running("t-b", repoB);
    const alex = await login("alex", alexToken), robin = await login("robin", robinToken);
    const outside = await stream(live(taskRoom("t-a")), robin);
    expect(outside.response.status).toBe(404);
    expect(outside.response.headers.get("content-type") ?? "").not.toContain("text/event-stream");

    const alexOn = await stream(live(taskRoom("t-b")), alex);
    expect(alexOn.response.status).toBe(200);
    await alexOn.until(all => all.some(one => one.event === "here"));
    const robinOn = await stream(live(taskRoom("t-b")), robin);
    expect(robinOn.response.status).toBe(200);
    const heard = await alexOn.until(all => all.some(one => one.event === "here" && (one.data as { people: string[] }).people.includes("robin")));
    expect(heard.filter(one => one.event === "here").at(-1)!.data).toEqual({ room: "task:t-b", people: ["robin"] });
    const robinHeard = await robinOn.until(all => all.some(one => one.event === "here" && (one.data as { people: string[] }).people.includes("alex")));
    expect(robinHeard.filter(one => one.event === "here").at(-1)!.data).toEqual({ room: "task:t-b", people: ["alex"] });

    // Robin leaves: Alex hears it.
    robinOn.close();
    const after = await alexOn.until(all => { const last = all.filter(one => one.event === "here").at(-1); return last !== undefined && (last.data as { people: string[] }).people.length === 0; });
    expect(after.filter(one => one.event === "here").at(-1)!.data).toEqual({ room: "task:t-b", people: [] });
    alexOn.close();
  });
});

describe("the task room on the bus", () => {
  const changes = (all: { event: string }[]) => all.filter(one => one.event === "change").length;

  test("a person granted one project never hears another project's writes or who is there, and is dropped when narrowed", async () => {
    const runA = running("t-a", repoA), runB = running("t-b", repoB);
    const alex = await login("alex", alexToken), robin = await login("robin", robinToken);
    const robinOn = await stream(live(taskRoom("t-b")), robin);
    await robinOn.until(all => all.some(one => one.event === "here"));
    const alexOn = await stream(live(taskRoom("t-a")), alex);
    await alexOn.until(all => all.some(one => one.event === "here"));

    // Work in project A: Alex hears it at once; Robin, in project B only, hears nothing.
    const started = Date.now();
    store.recordRunActivity(runA, "command", new Date());
    await alexOn.until(all => changes(all) >= 2);
    expect(Date.now() - started).toBeLessThan(500);
    expect(changes(alexOn.events)).toBe(2);

    // Work in project B reaches Robin; the project A write before it never did (it would be a third change).
    store.recordRunActivity(runB, "command", new Date());
    await robinOn.until(all => changes(all) >= 2);
    expect(changes(robinOn.events)).toBe(2);
    expect(JSON.stringify(robinOn.events)).not.toContain("alex");

    // Robin's projects narrow (itself a write): the stream ends at once, not at the next poll.
    expect(store.setAccountProjects("robin", [repoA], "alex", new Date())).toEqual({ ok: true });
    await robinOn.until(all => all.some(one => one.event === "gone"), 2_000);
    expect(robinOn.events.at(-1)!.event).toBe("gone");
    robinOn.close(); alexOn.close();
  });

  test("redaction holds: a key-shaped string written at runtime never reaches the stream", async () => {
    const run = running("t-secret", repoA);
    const cookie = await login("alex", alexToken);
    const page = await stream(live(taskRoom("t-secret")), cookie);
    await page.until(all => all.some(one => one.event === "here"));
    const key = ["sk", "ant", "api03", Array.from({ length: 40 }, (_, index) => "abcdefghij"[index % 10]).join("")].join("-");
    store.recordRunActivity(run, "command", new Date());
    store.handle.prepare("INSERT INTO decision (run, urgency, state, recap, question, options, recommendation, created_at) VALUES (?, 'blocking', 'open', ?, ?, '[]', 'one', ?)")
      .run(run, `The tool call was given ${key}`, `Use ${key}?`, new Date().toISOString());
    await page.until(all => changes(all) >= 3, 2_000);
    expect(changes(page.events)).toBeGreaterThanOrEqual(2);
    const sent = JSON.stringify(page.events);
    expect(sent).not.toContain(key);
    expect(sent).not.toContain("api03");
    for (const one of page.events.filter(item => item.event === "change")) expect(Object.keys(one.data as object)).toEqual(["room", "at", "revision"]);
    page.close();
  });
});

describe("what the agent did last, on every page that shows a running task", () => {
  const read = async (cookie: string, path: string): Promise<BrowserWorkspace> => {
    await (await fetch(url(path), { headers: { cookie } })).text();
    const response = await fetch(url(`${path}${path.includes("?") ? "&" : "?"}format=workspace`), { headers: { cookie } });
    expect(response.status).toBe(200);
    return response.json() as Promise<BrowserWorkspace>;
  };

  test("the task page carries the line and its live stream; Home Now and Crew carry the same line", async () => {
    const run = running("t-busy", repoA);
    store.recordRunActivity(run, "command", new Date());
    const cookie = await login("alex", alexToken);

    const task = (await read(cookie, "/t/t-busy")).view as BrowserTaskView;
    expect(task.activity).toEqual({ what: "Ran a command", at: expect.any(String), worker: "online" });
    expect(task.live).toEqual({ room: "task:t-busy", at: expect.stringMatching(/^[0-9a-f]{16}$/) });

    const chat = await read(cookie, "/chat");
    expect(chat.home?.agents.find(one => one.taskId === "t-busy")?.activity).toMatchObject({ what: "Ran a command", worker: "online" });
    expect(chat.crew.find(one => one.id === "t-busy")?.activity).toMatchObject({ what: "Ran a command", worker: "online" });
  });

  test("the recorded activity is our words only: nothing a tool was given reaches the page", async () => {
    const run = running("t-quiet", repoA);
    const cookie = await login("alex", alexToken);
    const task = (await read(cookie, "/t/t-quiet")).view as BrowserTaskView;
    expect(task.activity).toMatchObject({ what: "Started", worker: "online" });
    store.recordRunActivity(run, "lookup", new Date());
    const body = await (await fetch(url("/t/t-quiet?format=workspace"), { headers: { cookie } })).text();
    expect(body).toContain('"what":"Looked something up"');
  });
});

describe("one stream per page", () => {
  test("rooms are validated before anything is looked up; a malformed or repeated room opens nothing", async () => {
    const cookie = await login("alex", alexToken);
    for (const path of ["/live", live("nowhere"), live("task:"), live("flow:0"), live("flow:1?card=x"), live("workspace?x=1"), live("chat?task=a&project=b"),
      live("workspace", "workspace"), live("team", "team?conversation=c"), `${live("workspace")}&other=1`, live("a", "b", "c", "d", "e", "f")]) {
      const page = await stream(path, cookie);
      expect(page.response.status, path).toBe(400);
      expect(await page.response.json(), path).toEqual({ error: "room" });
    }
  });

  test("a page's rooms share one stream: the workspace hears every write, the task only its own", async () => {
    const runA = running("t-a", repoA);
    running("t-other", repoB);
    const cookie = await login("alex", alexToken);
    const page = await stream(live("workspace", taskRoom("t-a")), cookie);
    expect(page.response.status).toBe(200);
    await page.until(all => all.some(one => one.event === "here"));
    const of = (room: string) => page.events.filter(one => one.event === "change" && (one.data as { room: string }).room === room).length;
    expect(of("workspace")).toBe(1);
    expect(of("task:t-a")).toBe(1);
    store.recordRunActivity(runA, "command", new Date());
    await page.until(() => of("workspace") >= 2 && of("task:t-a") >= 2);
    expect([of("workspace"), of("task:t-a")]).toEqual([2, 2]);
    // Another task's write moves the workspace, not this task (a burst of writes is one workspace nudge a second).
    await new Promise(resolve => setTimeout(resolve, 1_100));
    store.createTask({ id: "t-new", title: "another" }, new Date());
    await page.until(() => of("workspace") >= 3);
    expect(of("workspace")).toBe(3);
    expect(of("task:t-a")).toBe(2);
    page.close();
  });

  test("an API token reads only the team room; a browser room answers it as the old streams did", async () => {
    running("t-a", repoA);
    const minted = mintApiToken();
    store.createApiToken({ id: minted.id, account: "alex", name: "reader", secretHash: minted.hash, access: "read", projects: [repoA], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
    for (const room of ["workspace", taskRoom("t-a"), "chat", "flow:1"]) {
      const page = await stream(live(room), "", { authorization: `Bearer ${minted.token}` });
      expect(page.response.status, room).toBe(403);
      expect(await page.response.json()).toEqual({ error: "session" });
    }
    const team = await stream(live("team"), "", { authorization: `Bearer ${minted.token}` });
    expect(team.response.status).toBe(200);
    const [first] = await team.until(all => all.length > 0);
    expect(first).toMatchObject({ event: "change", data: { room: "team", at: expect.any(String) } });
    team.close();
  });

  test("signing out ends the page's rooms at the next write", async () => {
    const run = running("t-a", repoA);
    const cookie = await login("alex", alexToken);
    const page = await stream(live("workspace", taskRoom("t-a")), cookie);
    await page.until(all => all.some(one => one.event === "here"));
    const out = await fetch(url("/logout"), { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: await csrfOf(cookie) }), redirect: "manual" });
    expect(out.status).toBe(303);
    store.recordRunActivity(run, "command", new Date());
    await page.until(all => all.filter(one => one.event === "gone").length >= 2, 3_000);
    expect(page.events.filter(one => one.event === "gone").map(one => (one.data as { room: string }).room).sort()).toEqual(["task:t-a", "workspace"]);
    page.close();
  });

  test("a project-scoped account's flow outside its projects is not found; its own opens with who is here", async () => {
    const definitionJson = JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null));
    const outside = store.createFlow({ repo: repoA, name: "Support", by: "alex", definitionJson }, new Date());
    const own = store.createFlow({ repo: repoB, name: "Billing", by: "alex", definitionJson }, new Date());
    const robin = await login("robin", robinToken);
    const refused = await stream(live(`flow:${outside}`), robin);
    expect(refused.response.status).toBe(404);
    expect(await refused.response.json()).toEqual({ error: "flow" });
    const page = await stream(live(`flow:${own}?editing=1`), robin);
    expect(page.response.status).toBe(200);
    const heard = await page.until(all => all.some(one => one.event === "here"));
    expect(heard.find(one => one.event === "here")!.data).toEqual({ room: `flow:${own}?editing=1`, people: [] });
    page.close();
  });
});

async function csrfOf(cookie: string): Promise<string> {
  const html = await (await fetch(url("/settings"), { headers: { cookie } })).text();
  return /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? /"csrf":"([^"]+)"/.exec(html)![1]!;
}
