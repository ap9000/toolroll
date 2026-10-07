/** The live task page through the server (/t/<id>/live): the same sign-in, family and project checks as the task
 * page, a nudge when the agent does something, who else is here, and the last-activity line on Task, Home and Crew. */
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

let store: Store;
let server: Server;
let base: string;
let evidenceRoot: string;
let repoA: string;
let repoB: string;
let alexToken: string;
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
async function stream(path: string, cookie: string) {
  const controller = new AbortController();
  const response = await fetch(url(path), { headers: { cookie, accept: "text/event-stream" }, signal: controller.signal, redirect: "manual" });
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

describe("the live task stream", () => {
  test("a signed-in page hears where the task stands, then a nudge when the agent does something", async () => {
    const run = running("t-live", repoA);
    const cookie = await login("alex", alexToken);
    const live = await stream("/t/t-live/live", cookie);
    expect(live.response.status).toBe(200);
    expect(live.response.headers.get("content-type")).toBe("text/event-stream");
    const [first] = await live.until(all => all.some(one => one.event === "here"));
    expect(first).toMatchObject({ event: "change", data: { at: expect.stringMatching(/^[0-9a-f]{16}$/) } });

    // The agent runs a command: the next tick nudges, with no task data in it.
    store.recordRunActivity(run, "command", new Date());
    const changes = (await live.until(all => all.filter(one => one.event === "change").length >= 2)).filter(one => one.event === "change");
    expect(changes).toHaveLength(2);
    expect(changes[1]!.data).not.toEqual(changes[0]!.data);
    expect(Object.keys(changes[1]!.data as object)).toEqual(["at", "revision"]);
    live.close();
  });

  test("a revision's address follows its family: the stream is the family root's", async () => {
    running("t-root", repoA);
    const cookie = await login("alex", alexToken);
    const missing = await stream("/t/nothing-here/live", cookie);
    expect(missing.response.status).toBe(404);
    const ok = await stream(`/t/${encodeURIComponent("t-root")}/live`, cookie);
    expect(ok.response.status).toBe(200);
    ok.close();
  });

  test("without a signed-in browser session there is no stream", async () => {
    running("t-anon", repoA);
    const anonymous = await stream("/t/t-anon/live", "");
    expect(anonymous.response.status).not.toBe(200);
    expect(anonymous.response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
  });

  test("a project-scoped account hears only its own projects' tasks, and who else is looking", async () => {
    running("t-a", repoA);
    running("t-b", repoB);
    const alex = await login("alex", alexToken), robin = await login("robin", robinToken);
    const outside = await stream("/t/t-a/live", robin);
    expect(outside.response.status).toBe(404);
    expect(outside.response.headers.get("content-type") ?? "").not.toContain("text/event-stream");

    const alexOn = await stream("/t/t-b/live", alex);
    expect(alexOn.response.status).toBe(200);
    await alexOn.until(all => all.some(one => one.event === "here"));
    const robinOn = await stream("/t/t-b/live", robin);
    expect(robinOn.response.status).toBe(200);
    const heard = await alexOn.until(all => all.some(one => one.event === "here" && (one.data as { people: string[] }).people.includes("robin")));
    expect(heard.filter(one => one.event === "here").at(-1)!.data).toEqual({ people: ["robin"] });
    const robinHeard = await robinOn.until(all => all.some(one => one.event === "here" && (one.data as { people: string[] }).people.includes("alex")));
    expect(robinHeard.filter(one => one.event === "here").at(-1)!.data).toEqual({ people: ["alex"] });

    // Robin leaves: Alex hears it.
    robinOn.close();
    const after = await alexOn.until(all => { const last = all.filter(one => one.event === "here").at(-1); return last !== undefined && (last.data as { people: string[] }).people.length === 0; });
    expect(after.filter(one => one.event === "here").at(-1)!.data).toEqual({ people: [] });
    alexOn.close();
  });
});

describe("the live task stream on the bus", () => {
  const changes = (all: { event: string }[]) => all.filter(one => one.event === "change").length;

  test("a person granted one project never hears another project's writes or who is there, and is dropped when narrowed", async () => {
    const runA = running("t-a", repoA), runB = running("t-b", repoB);
    const alex = await login("alex", alexToken), robin = await login("robin", robinToken);
    const robinOn = await stream("/t/t-b/live", robin);
    await robinOn.until(all => all.some(one => one.event === "here"));
    const alexOn = await stream("/t/t-a/live", alex);
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
    const live = await stream("/t/t-secret/live", cookie);
    await live.until(all => all.some(one => one.event === "here"));
    const key = ["sk", "ant", "api03", Array.from({ length: 40 }, (_, index) => "abcdefghij"[index % 10]).join("")].join("-");
    store.recordRunActivity(run, "command", new Date());
    store.handle.prepare("INSERT INTO decision (run, urgency, state, recap, question, options, recommendation, created_at) VALUES (?, 'blocking', 'open', ?, ?, '[]', 'one', ?)")
      .run(run, `The tool call was given ${key}`, `Use ${key}?`, new Date().toISOString());
    await live.until(all => changes(all) >= 3, 2_000);
    expect(changes(live.events)).toBeGreaterThanOrEqual(2);
    const sent = JSON.stringify(live.events);
    expect(sent).not.toContain(key);
    expect(sent).not.toContain("api03");
    for (const one of live.events.filter(item => item.event === "change")) expect(Object.keys(one.data as object)).toEqual(["at", "revision"]);
    live.close();
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
    expect(task.live).toEqual({ href: "/t/t-busy/live", at: expect.stringMatching(/^[0-9a-f]{16}$/) });

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
