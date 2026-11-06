/** A check the machine runs reads as the check it is (Phase 1 follow-up, from a release's page during its Full check):
 * the status card names the release check, its step and its progress, never "an agent"; there is no agent activity
 * line and no "doesn't read notes" (nothing to send); the release's panel reads Running while a machine step waits,
 * and Needs you only at its Approval; the generic Plan → Build stepper gives way to the release's own steps. An agent's
 * build keeps all of those. Quiet time on an agent's build is neutral words, never amber. */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";
import { openStore, recordReleaseStep, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { addApprover, approve, propose } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { releaseStepsViewOf } from "./server/task-views.js";
import { releaseProgressFor } from "./store.js";
import { workCountsByProject, workIndexPage } from "./work-index.js";
import { workspaceOf } from "../test/serve-kit.js";
import { taskWorkSummaryOf } from "./work-summary.js";
import { telegramProgressCard } from "./telegram-progress.js";
import { runOperate } from "./operate.js";
import { MACHINE_CHECK_RUNNING } from "./task-status.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const REPO = "/repos/machine-check";
let dir: string, store: Store, server: Server, base: string, password: string, cookie: string;

function running(id: string, candidate: string | null): number {
  store.createTask({ id, title: `Task ${id}` }, ago(30));
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, ago(30));
  const proposed = propose(store, { taskId: id, goal: "Check the release candidate.", ...(candidate === null ? { touches: ["src/a.ts"] } : { candidate }), now: ago(30) });
  const ok = approve(store, id, "sam", ago(30), proposed.digest, password);
  if (!ok.ok) throw new Error(ok.reason);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  // A live lease on a registered builder: the build is running, not vanished.
  const took = acquire(store, ref, "builder-1", { now: ago(12), token: "tok", newLeaseId: () => `l-${id}`, ttlMs: 3_600_000 });
  if (!took.ok) throw new Error(took.reason);
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `b/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: ago(12) });
  store.setTaskState(id, "running", ago(12));
  return run;
}
function http(path: string): Promise<{ status: number; body: string; setCookie: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { headers: cookie === undefined ? {} : { cookie } }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, setCookie: String(res.headers["set-cookie"] ?? "") }));
    });
    req.on("error", reject); req.end();
  });
}
type TaskViewSeen = { kind: string; status: { status: { headline: string; sentence: string } } | null; activity?: unknown; steering?: unknown; journey?: unknown; release?: { state: string } | null };
const viewOf = async (id: string) => workspaceOf((await http(`/t/${id}`)).body).view as unknown as TaskViewSeen;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "machine-check-"));
  store = openStore(join(dir, "state.db"));
  register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok" });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", ago(900));
  const sam = addApprover(store, "sam", ago(900));
  if (!sam.ok) throw new Error("approver");
  password = sam.token;
  running("release-1.2.3", "a".repeat(40));
  // The release's own steps: the gate and approval done, its release check under way (a machine step that waits).
  for (const [step, state] of [["gate", "done"], ["approval", "done"], ["check", "waiting"]] as const) {
    recordReleaseStep(store, { taskId: "release-1.2.3", tag: "v1.2.3", version: "1.2.3", pr: 7, step, state: "running", at: ago(20) });
    if (state === "done") recordReleaseStep(store, { taskId: "release-1.2.3", tag: "v1.2.3", version: "1.2.3", pr: 7, step, state: "done", at: ago(15) });
    else recordReleaseStep(store, { taskId: "release-1.2.3", tag: "v1.2.3", version: "1.2.3", pr: 7, step, state: "waiting", at: ago(12) });
  }
  running("agent-build", null);
  server = createDecisionServer({ store, evidenceRoot: dir, repo: REPO, clock: () => NOW });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
  const login = await new Promise<{ setCookie: string }>((resolve, reject) => {
    const req = httpRequest(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } }, res => { res.resume(); res.on("end", () => resolve({ setCookie: String(res.headers["set-cookie"] ?? "") })); });
    req.on("error", reject); req.write(new URLSearchParams({ name: "sam", token: password }).toString()); req.end();
  });
  cookie = login.setCookie.split(";")[0]!;
});
afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a release check the machine runs", () => {
  test("the status card says the release check, its step and how long, never an agent", async () => {
    const view = await viewOf("release-1.2.3");
    expect(view.status?.status.headline).toBe("Building");
    expect(view.status?.status.sentence).toBe("Running the release check · step 3 of 13 · 12 min");
    expect(JSON.stringify(view.status)).not.toMatch(/an agent/i);
  });

  test("no agent activity line, no notes to send, and the release's own steps instead of the generic stepper", async () => {
    const view = await viewOf("release-1.2.3");
    expect(view.activity ?? null).toBeNull();
    expect(view.steering ?? null).toBeNull();
    expect(view.journey ?? null).toBeNull();
    const page = (await http("/t/release-1.2.3")).body;
    expect(page).not.toContain("doesn't read notes");
    expect(page).not.toContain("No word for");
  });

  test("the release panel reads Running while a machine step waits; Needs you only at Approval", async () => {
    expect((await viewOf("release-1.2.3")).release?.state).toBe("running");
    const at = (step: string) => releaseStepsViewOf({ tag: "v1", version: "1", pr: null, startedAt: ago(5).toISOString(), updatedAt: ago(1).toISOString(), stopped: null,
      steps: [{ step: "gate", state: "done", startedAt: ago(5).toISOString(), endedAt: ago(4).toISOString(), detail: null }, { step, state: "waiting", startedAt: ago(4).toISOString(), endedAt: null, detail: null }] }, NOW)!.state;
    expect(at("approval")).toBe("waiting");
    for (const step of ["check", "ci", "quiet", "deploy", "publish"]) expect(at(step), step).toBe("running");
    expect(releaseProgressFor(store, "release-1.2.3")).not.toBeNull();
  });
});

describe("every other surface says the same: the check is running, never an agent", () => {
  const access = { principal: "operator" as const, repos: [REPO] };
  test("the Tasks list row (and the TUI, which reads it)", () => {
    const row = workIndexPage(store, NOW, access, {}).items.find(one => one.rootId === "release-1.2.3")!;
    expect(row.status.label).toBe("Building");
    expect(row.status.detail).toBe(MACHINE_CHECK_RUNNING);
  });
  test("the work summary agents and the lead read", () => {
    expect(taskWorkSummaryOf(store, "release-1.2.3", NOW, access)!.status.detail).toBe(MACHINE_CHECK_RUNNING);
  });
  test("the chat's progress card", () => {
    const run = store.runsFor(store.lookupRef("release-1.2.3")!.id)[0]!;
    const card = telegramProgressCard(store, run, "release-1.2.3", REPO, NOW, dir);
    expect(card.status.sentence).toBe(MACHINE_CHECK_RUNNING);
    expect(card.text).not.toMatch(/an agent/i);
  });
  test("the CLI's task show", async () => {
    const out: string[] = [];
    await runOperate("task", ["show", "release-1.2.3", "--json", "--db", join(dir, "state.db")], line => { out.push(line); }, { now: NOW });
    const text = out.join("\n");
    expect(text).toContain(MACHINE_CHECK_RUNNING);
    expect(text).not.toMatch(/An agent is working on it/);
  });
});

describe("an agent's build keeps what it has", () => {
  test("its activity, its notes and its stepper stay", async () => {
    const view = await viewOf("agent-build");
    expect(view.status?.status.sentence).not.toMatch(/^Running the/);
    expect(view.journey ?? null).not.toBeNull();
  });
});

describe("the Needs you count", () => {
  test("counts real decisions only: a build that is running or checking is never one", () => {
    const access = { principal: "operator" as const, repos: [REPO] };
    const totals = workCountsByProject(store, NOW, access).find(one => one.repo === REPO)!.totals;
    expect(totals["needs-you"]).toBe(workIndexPage(store, NOW, access, { view: "needs-you" }).items.length);
    expect(workIndexPage(store, NOW, access, { view: "needs-you" }).items.map(one => one.rootId)).not.toContain("release-1.2.3");
  });
});
