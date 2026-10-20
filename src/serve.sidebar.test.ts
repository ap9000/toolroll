/** The sidebar's project states through the server (docs/plans/agents-cockpit.md §2): each page carries the reader's own
 * projects with their states, a sensitive page carries none, and one summary room per page keeps them current — its
 * `change` carries the snapshot, it is the reader's own (a narrowed account sees its projects only), and being in it
 * never watches an agent. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { attemptKeyOf, ingestStatus, recordAgentTurn, watchingAgent } from "./agent-board.js";
import type { BrowserProjectState, BrowserWorkspace } from "./browser-workspace.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
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
const statesOf = (states: BrowserProjectState[] | undefined) => Object.fromEntries((states ?? []).map(one => [one.path, one]));

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

/** Read a live stream's frames until one matches, or give up. */
async function until(reader: ReadableStreamDefaultReader<Uint8Array>, match: (frame: string) => boolean): Promise<string> {
  let seen = "";
  for (let i = 0; i < 40; i++) {
    const read = await Promise.race([reader.read(), new Promise<null>(resolve => setTimeout(() => resolve(null), 3_000))]);
    if (read === null || read.done) break;
    seen += new TextDecoder().decode(read.value);
    const frames = seen.split("\n\n");
    const found = frames.find(match);
    if (found !== undefined) return found;
  }
  throw new Error(`no matching frame in: ${seen}`);
}
/** The snapshot a summary `change` frame carries. */
const snapshotOf = (frame: string): BrowserProjectState[] => {
  const data = JSON.parse(/^data: (.*)$/m.exec(frame)![1]!) as { at: string };
  return JSON.parse(data.at) as BrowserProjectState[];
};

beforeEach(async () => {
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  evidenceRoot = mkdtempSync(join(tmpdir(), "so-sidebar-ev-"));
  worktree = mkdtempSync(join(tmpdir(), "so-sidebar-wt-"));
  repoA = realpathSync(mkdtempSync(join(tmpdir(), "so-sidebar-a-")));
  repoB = realpathSync(mkdtempSync(join(tmpdir(), "so-sidebar-b-")));
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

describe("the sidebar's project states", () => {
  test("each page carries the reader's own projects and states; a sensitive page carries none", async () => {
    running("t-a", repoA);
    running("t-b", repoB);
    const alex = await login("alex", alexToken);
    const mine = statesOf((await page("/agents", alex)).projectStates);
    expect(mine[repoA]).toMatchObject({ state: "working", counts: { working: 1 } });
    expect(mine[repoB]).toMatchObject({ state: "working", counts: { working: 1 } });

    const robin = await login("robin", robinToken);
    expect(Object.keys(statesOf((await page("/agents", robin)).projectStates))).toEqual([repoB]);

  });

  test("the summary room carries each new snapshot, only the reader's projects, and never watches", async () => {
    const run = running("t-live", repoA);
    const alex = await login("alex", alexToken);
    const controller = new AbortController();
    const response = await fetch(url("/live?room=summary"), { headers: { cookie: alex, accept: "text/event-stream" }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = snapshotOf(await until(reader, frame => frame.includes("event: change")));
    expect(statesOf(first)[repoA]).toMatchObject({ state: "working", counts: { working: 1, "needs-you": 0 } });
    expect(watchingAgent(store, "alex", run, new Date())).toBe(false);

    // The agent asks: the next snapshot says so.
    ingestStatus(store, run, attemptKeyOf(store, run)!, { lines: [{ status: "needs-decision", key: "k", question: "Keep it?" }], nextOffset: 100 }, new Date());
    const next = snapshotOf(await until(reader, frame => frame.includes("event: change") && frame.includes("needs-you\\\":1")));
    expect(statesOf(next)[repoA]).toMatchObject({ state: "needs-you" });
    controller.abort();

    // Robin's room is Robin's: project A is not in it.
    const robin = await login("robin", robinToken);
    const theirs = new AbortController();
    const robinStream = await fetch(url("/live?room=summary"), { headers: { cookie: robin, accept: "text/event-stream" }, signal: theirs.signal });
    expect(Object.keys(statesOf(snapshotOf(await until(robinStream.body!.getReader(), frame => frame.includes("event: change")))))).toEqual([repoB]);
    theirs.abort();
  });

  test("a password page carries no rail states", async () => {
    // An unscoped console with a default project, where a scope to approve makes /next a password page.
    const single = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: repoA });
    await new Promise<void>(resolve => single.listen(0, "127.0.0.1", resolve));
    const address = single.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const at = `http://127.0.0.1:${address.port}`;
    try {
      store.createTask({ id: "t-yes", title: "needs a yes" }, T0);
      store.saveScope({ taskId: "t-yes", goal: "do the thing", outOfScope: null, touches: [], acceptance: [], proposedAt: T0.toISOString(), digest: "d".repeat(32),
        approvedAt: null, approvedBy: null, approvedDigest: null });
      const signedIn = await fetch(`${at}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alexToken }), redirect: "manual" });
      const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
      const pending = workspaceOf(await (await fetch(`${at}/next`, { headers: { cookie } })).text());
      expect(pending.sensitive).toBe(true);
      expect(pending.projectStates).toBeUndefined();
      // Work with no project yet is its own entry for a reader who may see it.
      store.createTask({ id: "t-loose", title: "Somewhere" }, T0);
      store.refFor("built-in", "t-loose", "ours");
      const loose = workspaceOf(await (await fetch(`${at}/agents`, { headers: { cookie } })).text()).projectStates?.find(one => one.path === null);
      expect(loose).toMatchObject({ name: "No project", state: "needs-you" });
      // The same reader's ordinary page has them.
      expect((await (async () => workspaceOf(await (await fetch(`${at}/agents`, { headers: { cookie } })).text()))()).projectStates).toBeDefined();
    } finally {
      single.closeAllConnections?.();
      await new Promise<void>(resolve => single.close(() => resolve()));
    }
  });

  test("a narrowed console never hands out a wider snapshot: an open room hears gone, and a newcomer gets the narrow one", async () => {
    let admitted = [repoA, repoB];
    const narrowing = createDecisionServer({ store, evidenceRoot, repos: [repoA, repoB], admittedRepos: () => admitted, clock: () => new Date() });
    await new Promise<void>(resolve => narrowing.listen(0, "127.0.0.1", resolve));
    const address = narrowing.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const at = `http://127.0.0.1:${address.port}`;
    try {
      running("t-a", repoA);
      const signedIn = await fetch(`${at}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alexToken }), redirect: "manual" });
      const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
      const wide = new AbortController();
      const stream = (await fetch(`${at}/live?room=summary`, { headers: { cookie, accept: "text/event-stream" }, signal: wide.signal })).body!.getReader();
      expect(Object.keys(statesOf(snapshotOf(await until(stream, frame => frame.includes("event: change")))))).toContain(repoA);
      // The console now serves project B only; the next write re-proves the open room.
      admitted = [repoB];
      store.createTask({ id: "t-nudge", title: "nudge" }, T0);
      const after = await until(stream, frame => frame.includes("event: gone") || frame.includes("event: change"));
      expect(after).toContain("event: gone");
      wide.abort();
      const narrow = new AbortController();
      const fresh = (await fetch(`${at}/live?room=summary`, { headers: { cookie, accept: "text/event-stream" }, signal: narrow.signal })).body!.getReader();
      expect(Object.keys(statesOf(snapshotOf(await until(fresh, frame => frame.includes("event: change")))))).not.toContain(repoA);
      narrow.abort();
    } finally {
      narrowing.closeAllConnections?.();
      await new Promise<void>(resolve => narrowing.close(() => resolve()));
    }
  });

  test("reopening a project changes nothing a reader may see: the room keeps going, and its next word still comes", async () => {
    store.upsertProject(repoA, "a", new Date(Date.now() - 60_000));
    store.upsertProject(repoB, "b", new Date(Date.now() - 30_000));
    const run = running("t-again", repoA);
    const alex = await login("alex", alexToken);
    const controller = new AbortController();
    const reader = (await fetch(url("/live?room=summary"), { headers: { cookie: alex, accept: "text/event-stream" }, signal: controller.signal })).body!.getReader();
    await until(reader, frame => frame.includes("event: change"));
    // Project A opened again: first in the switcher now, the same projects.
    store.upsertProject(repoA, "a", new Date());
    ingestStatus(store, run, attemptKeyOf(store, run)!, { lines: [{ status: "needs-decision", key: "k", question: "Keep it?" }], nextOffset: 100 }, new Date());
    const next = await until(reader, frame => frame.includes("event: gone") || (frame.includes("event: change") && frame.includes("needs-you\\\":1")));
    expect(next).toContain("event: change");
    controller.abort();
  });

  test("a row that needs a person says what it needs, in the Tasks list's own words", async () => {
    store.createTask({ id: "t-plan", title: "Plan me" }, T0);
    store.placeTask(store.refFor("built-in", "t-plan", "ours").id, repoA);
    store.saveScope({ taskId: "t-plan", goal: "do it", outOfScope: null, touches: [], acceptance: [], proposedAt: T0.toISOString(), digest: "e".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null });
    const alex = await login("alex", alexToken);
    const rail = statesOf((await page("/agents", alex)).projectStates)[repoA]!;
    const row = rail.tasks.find(one => one.id === "t-plan");
    expect(row).toMatchObject({ state: "needs-you" });
    expect(row!.line).not.toBe("Needs you");
    expect(row!.line.length).toBeGreaterThan(12);
  });

  test("every listed row that needs a person has its sentence, past the index's page size", async () => {
    const repos = Array.from({ length: 18 }, (_, n) => realpathSync(mkdtempSync(join(tmpdir(), `so-sidebar-many-${n}-`))));
    const many = createDecisionServer({ store, evidenceRoot, repos, clock: () => new Date() });
    await new Promise<void>(resolve => many.listen(0, "127.0.0.1", resolve));
    const address = many.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const at = `http://127.0.0.1:${address.port}`;
    try {
      repos.forEach((repo, p) => {
        for (let t = 0; t < 6; t++) {
          const id = `t-${p}-${t}`;
          store.createTask({ id, title: id }, T0);
          store.placeTask(store.refFor("built-in", id, "ours").id, repo);
          store.saveScope({ taskId: id, goal: "do it", outOfScope: null, touches: [], acceptance: [], proposedAt: T0.toISOString(), digest: "f".repeat(32),
            approvedAt: null, approvedBy: null, approvedDigest: null });
        }
      });
      const signedIn = await fetch(`${at}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alexToken }), redirect: "manual" });
      const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
      const states = workspaceOf(await (await fetch(`${at}/agents`, { headers: { cookie } })).text()).projectStates ?? [];
      const rows = states.flatMap(one => one.tasks);
      // Every one is listed or counted (the frame bound turns some into "more"), and every listed one says what it needs.
      expect(rows.length + states.reduce((sum, one) => sum + one.more, 0)).toBe(108);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter(one => one.line === "Needs you")).toEqual([]);
      // Each one that needs this person is a chime subject.
      expect(states.reduce((sum, one) => sum + one.asks.length, 0)).toBe(108);
    } finally {
      many.closeAllConnections?.();
      await new Promise<void>(resolve => many.close(() => resolve()));
      for (const repo of repos) rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the icon with the attention dot is served beside the plain one", async () => {
    const dot = await fetch(url("/icon-attention.svg"));
    expect(dot.status).toBe(200);
    expect(dot.headers.get("content-type")).toContain("image/svg+xml");
    expect(await dot.text()).toContain("<circle");
  });

  test("the usage chip is an operator's, and never on a password page", async () => {
    store.handle.prepare("INSERT INTO provider_limit (provider, window, used_percent, window_minutes, resets_at, reached, plan, observed_at) VALUES ('claude','five_hour',82,300,?,0,NULL,?)")
      .run(new Date(Date.now() + 3 * 3_600_000).toISOString(), new Date().toISOString());
    const alex = await login("alex", alexToken);
    expect((await page("/agents", alex)).usage).toMatchObject({ text: "Claude 5-hour · 82% · resets 3h" });
    const robin = await login("robin", robinToken);
    expect((await page("/agents", robin)).usage).toBeUndefined();
  });

  test("a visit while an agent runs is not seeing it: only its finished version, opened, marks it seen", async () => {
    const run = running("t-seen", repoA);
    const alex = await login("alex", alexToken);
    const seen = () => store.handle.prepare("SELECT 1 AS hit FROM agent_seen WHERE account = 'alex' AND run = ?").get(run) !== undefined;
    await page(`/agents?run=${run}`, alex);
    await fetch(url(`/r/${run}`), { headers: { cookie: alex } });
    expect(seen()).toBe(false);
    store.finishRun(run, { outcome: "built", committed: true, now: new Date() });
    await page(`/agents?run=${run}`, alex);
    expect(seen()).toBe(true);
  });

  test("a changed plan is a new thing to need a person (a new chime key); the newest ask always has a key", async () => {
    const plan = (id: string, digest: string, at: Date, goal = "do it") => {
      if (store.getTask(id) === null) { store.createTask({ id, title: id }, at); store.placeTask(store.refFor("built-in", id, "ours").id, repoA); }
      store.saveScope({ taskId: id, goal, outOfScope: null, touches: [], acceptance: [], proposedAt: at.toISOString(), digest, approvedAt: null, approvedBy: null, approvedDigest: null });
    };
    const alex = await login("alex", alexToken);
    const asks = async () => statesOf((await page("/agents", alex)).projectStates)[repoA]!.asks;
    plan("t-terms", "a".repeat(32), new Date(Date.now() - 60_000));
    const first = (await asks()).find(one => one.task === "t-terms")!.key;
    plan("t-terms", "b".repeat(32), new Date(), "do it differently");
    expect((await asks()).find(one => one.task === "t-terms")!.key).not.toBe(first);
    // More waiting than a project names: the newest still has a key.
    for (let i = 0; i < 101; i++) plan(`t-many-${i}`, "c".repeat(32), new Date(Date.now() - (200 - i) * 1000));
    // An old task whose plan changes now is news now: its ask is named, however many newer tasks wait.
    plan("t-old", "d".repeat(32), new Date(Date.now() - 90 * 86_400_000));
    plan("t-old", "e".repeat(32), new Date(Date.now() + 5_000), "a revised plan");
    const named = await asks();
    expect(named.map(one => one.task)).toContain("t-old");
    expect(Date.parse(named.find(one => one.task === "t-old")!.at)).toBeGreaterThan(Date.now() - 60_000);
  });

  test("one summary room per page, and only for a browser session", async () => {
    const alex = await login("alex", alexToken);
    expect((await fetch(url("/live?room=summary&room=summary"), { headers: { cookie: alex } })).status).toBe(400);
    expect((await fetch(url("/live?room=summary:x"), { headers: { cookie: alex } })).status).toBe(400);
    const anonymous = await fetch(url("/live?room=summary"), { redirect: "manual" });
    expect(anonymous.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    await anonymous.body?.cancel();
  });
});
