/**
 * The engine API's reads over HTTP (solo-workbench plan A0): each route admitted per persona exactly as the page it
 * mirrors (Work, the task page, the Live grid), a refused caller reading nothing (no loader runs), and every answer the
 * shape its contract says. The local owner reads them with the session a terminal client redeems (POST /login/once).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { acquire, release } from "../claim.js";
import { budgetedStatJson, parseNumstat, storeEvidence } from "../evidence.js";
import { sealVerificationReceipt } from "../verification-evidence.js";
import { mintApiToken } from "../api-tokens.js";
import { register } from "../runner.js";
import { addApprover, propose } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";
import { presented, T0 } from "../../test/serve-kit.js";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../../test/local-owner-world.js";
import * as reads from "../engine-reads.js";
import * as fast from "../fast-start.js";
import * as newTask from "./render-new-task.js";
import * as mainRead from "../live-main-read.js";
import { agentsReadSchema, engineContractDigest, helloSchema, linkRedemptionSchema, liveSessionWindowSchema, resultDiffContextSchema, resultDiffFileSchema, resultDiffSchema, stepCardsSchema, workRowsSchema } from "../contracts/engine-api.js";

// Every loader a spy around the real one: a refused caller must cause none of them.
vi.mock("../engine-reads.js", async importOriginal => {
  const real = await importOriginal<typeof import("../engine-reads.js")>();
  return { ...real, stepCardsOf: vi.fn(real.stepCardsOf), resultDiffOf: vi.fn(real.resultDiffOf), resultDiffFileOf: vi.fn(real.resultDiffFileOf), resultRunsOf: vi.fn(real.resultRunsOf) };
});
// Build's offer is the fast start's (fast-start.ts, sized by a model): stood in for, one call at a time, where a test says.
vi.mock("../fast-start.js", async importOriginal => {
  const real = await importOriginal<typeof import("../fast-start.js")>();
  return { ...real, prepareFastStart: vi.fn(real.prepareFastStart) };
});
vi.mock("./render-new-task.js", async importOriginal => {
  const real = await importOriginal<typeof import("./render-new-task.js")>();
  return { ...real, fastTermsRows: vi.fn(real.fastTermsRows) };
});
vi.mock("../live-main-read.js", async importOriginal => {
  const real = await importOriginal<typeof import("../live-main-read.js")>();
  return { ...real, readMainWindow: vi.fn(real.readMainWindow) };
});
const LOADERS = [reads.stepCardsOf, reads.resultDiffOf, reads.resultDiffFileOf, reads.resultRunsOf, mainRead.readMainWindow] as unknown as ReturnType<typeof vi.fn>[];
const loaderCalls = () => LOADERS.reduce((sum, one) => sum + one.mock.calls.length, 0);

const PATCH = [
  "diff --git a/src/total.ts b/src/total.ts", "index 1111111..2222222 100644", "--- a/src/total.ts", "+++ b/src/total.ts", "@@ -1,3 +1,3 @@",
  " export function total(items) {", "-  return sum(items);", "+  return sum(items) + tax(items);", " }",
  "diff --git a/README.md b/README.md", "index 3333333..4444444 100644", "--- a/README.md", "+++ b/README.md", "@@ -1 +1,2 @@", " # Shop", "+Totals include tax.", "",
].join("\n");

let store: Store, server: Server, base: string, evidenceRoot: string, worktree: string, repoA: string, repoB: string;
let liveRun: number, resultRun: number, readToken: string;
const cookies: Record<string, string> = {};

async function login(name: string, token: string): Promise<string> {
  const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
  expect(response.status).toBe(303);
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}
/** A task placed in a project, claimed, its build started on this computer's runner. */
function started(id: string, repo: string, sealed = false): number {
  store.createTask({ id, title: `Fix ${id}` }, T0);
  const ref = store.refFor("built-in", id, "ours").id;
  store.placeTask(ref, repo);
  // "Just code": the person's yes with the task, no plan asked for.
  if (sealed) {
    propose(store, { taskId: id, goal: `Fix ${id}`, now: T0 });
    if (!store.sealScopeApproval(id, "alex", T0)) throw new Error("seal");
  }
  const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
  if (!taken.ok) throw new Error("claim failed");
  return store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1", branch: `b-${id}`, worktree, now: new Date(), ...presented(store, ref, "builder") });
}

beforeAll(async () => {
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  evidenceRoot = realpathSync(mkdtempSync(join(tmpdir(), "so-engine-ev-")));
  worktree = mkdtempSync(join(tmpdir(), "so-engine-wt-"));
  repoA = realpathSync(mkdtempSync(join(tmpdir(), "so-engine-a-")));
  repoB = realpathSync(mkdtempSync(join(tmpdir(), "so-engine-b-")));
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  const by = { name: "alex", token: alex.token };
  const ines = addApprover(store, "ines", T0, by), robin = addApprover(store, "robin", T0, by), vera = addApprover(store, "vera", T0, by);
  if (!ines.ok || !robin.ok || !vera.ok) throw new Error("accounts");
  // ines: an approver over every project, not the operator; robin: limited to repoB; vera: watches.
  expect(store.setAccountProjects("robin", [repoB], "alex", T0)).toEqual({ ok: true });
  store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: "terminal", secretHash: minted.hash, access: "read", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
  readToken = minted.token;
  register(store, { name: "builder-1", host: "here", capacity: 4, repos: [repoA, repoB], now: new Date(), newToken: () => "tok-builder-1" });
  // A live build in repoA writing its records, and a finished result in repoA with a two-file patch.
  liveRun = started("t-live", repoA);
  const { openLiveLog } = await import("../live.js");
  const log = openLiveLog(evidenceRoot, liveRun, { base: worktree, commands: false })!;
  log.observe({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "reading the totals" }, { type: "tool_use", id: "t1", name: "Task", input: { description: "Check the tests" } }] } });
  log.close();
  resultRun = started("t-done", repoA, true);
  store.finishRun(resultRun, { outcome: "built", committed: true, now: new Date(), costUsd: 0.42 } as never);
  store.setTaskState("t-done", "done", T0);
  storeEvidence(store, evidenceRoot, resultRun, "terminal-diff", "diff.patch", Buffer.from(PATCH), "git diff (exit 0)", T0, { captureStatus: "ok" });
  started("t-b", repoB);
  // This computer's sign-in check (stubbed, no process): Codex signed in, nothing else installed. Builds are already set
  // to Claude Code here, so the first task waits for it.
  const notFound = { code: 127, stdout: "", stderr: "", timedOut: false, notFound: true };
  server = createDecisionServer({ store, evidenceRoot, repos: [repoA, repoB], clock: () => new Date(), localRunner: "builder-1", leadByDefault: true,
    connectionProbe: (async (file: string) => file === "codex" ? { code: 0, stdout: "Logged in using ChatGPT\n", stderr: "", timedOut: false, notFound: false } : notFound) as never });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cookies["operator"] = await login("alex", alex.token);
  cookies["approver"] = await login("ines", ines.token);
  cookies["project-limited"] = await login("robin", robin.token);
  cookies["viewer"] = await login("vera", vera.token);
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  for (const dir of [evidenceRoot, worktree, repoA, repoB]) rmSync(dir, { recursive: true, force: true });
});

const THREAD = `/agents/live/thread/${"a".repeat(32)}`;
const paths = () => ({ hello: "/engine/hello", agents: "/engine/agents", work: "/work/rows", steps: "/t/t-done/steps", diff: "/t/t-done/diff", file: `/t/t-done/diff?run=${resultRun}&file=0`, live: `/agents/live/run/${liveRun}?file=main`, thread: THREAD });
type Route = keyof ReturnType<typeof paths>;
async function read(persona: string, path: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = persona === "token" ? { authorization: `Bearer ${readToken}` } : { cookie: cookies[persona]! };
  const response = await fetch(`${base}${path}`, { headers: { ...headers, accept: "application/json" }, redirect: "manual" });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* a refusal page */ }
  return { status: response.status, body };
}

/** Who reads what, written out by hand from the pages each route mirrors: Work and the task page admit any signed-in
 * caller with the project (a token too); the Live grid's reads are a browser session's only; a thread is refused for now. */
const ADMITTED: Record<string, Record<Route, number>> = {
  operator: { hello: 200, agents: 200, work: 200, steps: 200, diff: 200, file: 200, live: 200, thread: 404 },
  approver: { hello: 200, agents: 200, work: 200, steps: 200, diff: 200, file: 200, live: 200, thread: 404 },
  viewer: { hello: 200, agents: 200, work: 200, steps: 200, diff: 200, file: 200, live: 200, thread: 404 },
  "project-limited": { hello: 200, agents: 200, work: 200, steps: 404, diff: 404, file: 404, live: 404, thread: 404 },
  token: { hello: 200, agents: 403, work: 200, steps: 200, diff: 200, file: 200, live: 403, thread: 403 },
};

describe("each engine read admits per persona as the page it mirrors; a refusal reads nothing", () => {
  test.each(Object.keys(ADMITTED))("%s", async persona => {
    for (const [route, path] of Object.entries(paths()) as [Route, string][]) {
      LOADERS.forEach(one => one.mockClear());
      const answer = await read(persona, path);
      const expected = ADMITTED[persona]![route];
      expect(answer.status, `${persona} ${route}`).toBe(expected);
      if (expected !== 200) {
        expect(loaderCalls(), `${persona} ${route}: no loader for a refusal`).toBe(0);
        expect(JSON.stringify(answer.body), `${persona} ${route}`).not.toMatch(/reading the totals|total\.ts|Fix t-done/);
      }
    }
  });

  test("a project-limited account's Work rows are its own project's only", async () => {
    const rows = workRowsSchema.parse((await read("project-limited", "/work/rows")).body);
    expect(rows.rows.map(row => row.id)).toEqual(["t-b"]);
    const all = workRowsSchema.parse((await read("operator", "/work/rows?project=__all")).body);
    expect(all.rows.map(row => row.id).sort()).toEqual(expect.arrayContaining(["t-done", "t-live"]));
  });

  test("the cost line is the Limits view's audience only: an unrestricted approver reads it, nobody else does", async () => {
    const before = workRowsSchema.parse((await read("operator", "/work/rows")).body);
    expect(before.spend).toEqual({ todayUsd: expect.any(Number), planPercent: null });
    store.recordProviderLimits({ provider: "claude", plan: "max", windows: [
      { window: "five_hour", usedPercent: 62.4, windowMinutes: 300, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), reached: false },
      // A window whose reset has passed isn't current: never the plan's figure.
      { window: "seven_day", usedPercent: 97, windowMinutes: 10_080, resetsAt: new Date(Date.now() - 60_000).toISOString(), reached: false },
    ] }, new Date());
    for (const persona of ["operator", "approver"]) expect(workRowsSchema.parse((await read(persona, "/work/rows")).body).spend, persona).toMatchObject({ planPercent: 62 });
    for (const persona of ["viewer", "project-limited", "token"]) {
      expect(workRowsSchema.parse((await read(persona, "/work/rows")).body).spend, persona).toBeNull();
    }
  });

  test("a task and a run outside every project read the same as one that doesn't exist", async () => {
    for (const path of ["/t/nope/steps", "/t/nope/diff", "/agents/live/run/999999"]) expect((await read("operator", path)).status, path).toBe(404);
    expect((await read("operator", `/t/t-done/diff?run=${liveRun}`)).status).toBe(404); // not a result of this task
    expect((await read("operator", "/t/t-done/diff?file=0")).status).toBe(400); // a file needs the run it is of
    expect((await read("operator", `/t/t-done/diff?run=${resultRun}&file=9`)).status).toBe(404);
    expect((await read("operator", "/t/t-done/steps?x=1")).status).toBe(400);
    expect((await read("operator", `/agents/live/run/${liveRun}?file=other`)).status).toBe(400);
  });
});

describe("this computer's agents: one inventory policy for the engine read and the welcome", () => {
  test("an instance operator sees each agent; another person's session sees only who the first task goes to; a token nothing", async () => {
    // The console's own check looked once at start (the lead on by default); wait for its answer, not a window.
    let full = agentsReadSchema.parse((await read("operator", "/engine/agents")).body);
    for (let i = 0; i < 100 && full.checkedAt === null; i++) { await new Promise(done => setTimeout(done, 20)); full = agentsReadSchema.parse((await read("operator", "/engine/agents")).body); }
    expect(full.agents.map(one => [one.id, one.state]).slice(0, 2)).toEqual([["claude", "not-installed"], ["codex", "signed-in"]]);
    expect(full.firstTask).toBeNull();
    expect(full.lines).toContain("Codex is signed in. To give it tasks, choose it in Settings → Models.");
    for (const persona of ["viewer", "project-limited"]) {
      const summary = agentsReadSchema.parse((await read(persona, "/engine/agents")).body);
      expect(summary, persona).toMatchObject({ agents: [], firstTask: null, lines: ["No coding agent can take tasks on this computer yet."] });
    }
    expect((await read("token", "/engine/agents")).status).toBe(403);
    // The welcome reads the same policy (its rendering per view: welcome.test.ts).
    const { agentInventoryOf } = await import("./welcome.js");
    const who = (name: string) => ({ name, via: "cookie" }) as never;
    expect(["alex", "vera", "robin"].map(name => agentInventoryOf(who(name), store))).toEqual(["full", "summary", "summary"]);
    expect(agentInventoryOf({ name: "alex", via: "bearer", role: "approver", generation: 1 }, store)).toBe("none");
  });
});

describe("every answer is its contract's shape", () => {
  test("a result waiting to be checked carries the facts its Accept and Send back post", async () => {
    store.createTask({ id: "t-ready", title: "Fix t-ready" }, T0);
    const ref = store.refFor("built-in", "t-ready", "ours").id;
    store.placeTask(ref, repoA);
    propose(store, { taskId: "t-ready", goal: "Fix t-ready", now: T0 });
    if (!store.sealScopeApproval("t-ready", "alex", T0)) throw new Error("seal");
    const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim failed");
    const run = store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1", branch: "b-t-ready", worktree, now: new Date(), ...presented(store, ref, "builder") });
    // A build whose project check passed on its exact commit: Ready for the person.
    const head = "b".repeat(40);
    store.setVerifyCommand({ repo: repoA, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, new Date(Date.now() - 60_000));
    store.stampRun(run, { scopeDigest: store.getScope("t-ready")!.digest, baseRevision: "a".repeat(40) });
    storeEvidence(store, evidenceRoot, run, "terminal-diff", "diff.patch", Buffer.from(PATCH), "git diff (exit 0)", T0, { captureStatus: "ok" });
    storeEvidence(store, evidenceRoot, run, "check-log", "check.txt", Buffer.from("1 passed"), "npm test", T0, { captureStatus: "ok" });
    store.recordOutcomeFacts(run, { headRevision: head, handoff: "Fixed it." });
    store.finishRun(run, { outcome: "built", committed: true, now: new Date() } as never);
    sealVerificationReceipt(store, evidenceRoot, run, head, store.liveVerifyCommand(repoA)!, { configured: true, ran: true, exitCode: 0 }, new Date());
    release(store, taken.claim.leaseId, new Date());
    store.setTaskState("t-ready", "done", T0);
    // Protected work on a one-person approval: the person who approved can't be the one to complete it, said as the
    // completion would say it (approval policy §1.7a), before the dialog.
    const rules = store.approvalRules(repoA);
    store.setApprovalRules(repoA, { notRequester: rules.notRequester, protectProject: true, protectedPaths: rules.protectedPaths }, "alex", T0);
    try {
      const guarded = stepCardsSchema.parse((await read("operator", "/t/t-ready/steps")).body);
      expect(guarded.review?.accept.needs).toMatch(/^This result changed .*protect/);
      expect(guarded.review?.accept).toMatchObject({ owed: null, blockers: [] });
      // The terminal's Accept with notes against the real routes: the note saves, the completion is refused (protected
      // work, its own approver completing), and the retry under the same request identity saves nothing more and is
      // still refused.
      const cookie = cookies["operator"]!;
      const page = await fetch(`${base}/chat?format=workspace`, { headers: { cookie } });
      const csrf = (JSON.parse(await page.text()) as { csrf: string }).csrf;
      const act = (path: string, fields: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", redirect: "manual",
        headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded", "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" },
        body: new URLSearchParams({ csrf, ...fields }).toString() });
      const note = { note: "Notes on the changes:\n- src/total.ts line 2 — round to cents", request: "e".repeat(32), path: "", line: "" };
      const complete = { receipt: guarded.review!.receipt, run: String(run) };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const saved = await act(`/r/${run}/comment`, note);
        expect(saved.status, `note, attempt ${attempt + 1}`).toBe(303);
        const refused = await act("/t/t-ready/complete", complete);
        expect(refused.status, `completion, attempt ${attempt + 1}`).toBeGreaterThanOrEqual(400);
        expect(await refused.json()).toMatchObject({ outcome: "refused", words: expect.stringMatching(/protect/) });
        expect(store.allDiffComments(run).filter(one => one.note === note.note), "the note saved once").toHaveLength(1);
      }
      // Still waiting on someone else, with the same receipt: nothing was completed.
      expect(stepCardsSchema.parse((await read("operator", "/t/t-ready/steps")).body).review).toMatchObject({ run, receipt: guarded.review!.receipt });
    } finally {
      store.setApprovalRules(repoA, { notRequester: rules.notRequester, protectProject: rules.protectProject, protectedPaths: rules.protectedPaths }, "alex", T0);
    }
    // Nothing owed, nothing blocking, and nobody else needed: Accept is this person's plain completion (said before the dialog).
    const steps = stepCardsSchema.parse((await read("operator", "/t/t-ready/steps")).body);
    expect(steps.review).toEqual({ run, receipt: expect.stringMatching(/^[0-9a-f]{64}$/), source: store.getScope("t-ready")!.digest,
      accept: { owed: null, blockers: [], needs: null } });
  });

  test("work rows, step cards, the diff and one file, and a LiveSession window", async () => {
    // The handshake first: this build's contract, the one the fixtures and schemas.json hold.
    expect(helloSchema.parse((await read("operator", "/engine/hello")).body)).toMatchObject({ version: 1, contract: engineContractDigest() });
    expect((await read("operator", "/engine/agents?fresh=1")).status).toBe(400);
    workRowsSchema.parse((await read("operator", "/work/rows")).body);
    const steps = stepCardsSchema.parse((await read("operator", "/t/t-done/steps")).body);
    expect(steps).toMatchObject({ task: { id: "t-done" }, room: "task:t-done" });
    // A "Just code" task: no Plan or Approval step in its chain; its build finished, with who ran it.
    expect(steps.chain).toBe("just-code");
    expect(steps.cards?.filter(card => !card.inChain).map(card => card.key)).toEqual(["plan", "approve"]);
    expect(steps.cards?.find(card => card.key === "build")).toMatchObject({ state: "done", agent: { provider: "claude" }, runs: [resultRun] });
    // Its result isn't waiting to be checked (a build still holds the task): no Accept or Send back facts.
    expect(steps.review).toBeNull();
    // A task filed for a plan reads plan first, its Plan step waiting.
    const planFirst = stepCardsSchema.parse((await read("operator", "/t/t-b/steps")).body);
    expect(planFirst.chain).toBe("plan-first");
    expect(planFirst.cards?.[0]).toMatchObject({ key: "plan", inChain: true });
    // Nothing to check yet: no Accept or Send back facts.
    expect(planFirst.review).toBeNull();
    const diff = resultDiffSchema.parse((await read("operator", "/t/t-done/diff")).body);
    expect(diff).toMatchObject({ run: resultRun, problem: null });
    expect(diff.files).toEqual([
      { file: 0, path: "src/total.ts", oldPath: "src/total.ts", additions: 1, deletions: 1, binary: false, hunks: 1 },
      { file: 1, path: "README.md", oldPath: "README.md", additions: 1, deletions: 0, binary: false, hunks: 1 },
    ]);
    const file = resultDiffFileSchema.parse((await read("operator", `/t/t-done/diff?run=${resultRun}&file=0`)).body);
    expect(file.file.hunks[0]!.lines.map(line => line.kind)).toEqual(["context", "deletion", "addition", "context"]);
    // A task with no result yet says so plainly, with no files.
    expect(resultDiffSchema.parse((await read("operator", "/t/t-b/diff")).body)).toMatchObject({ run: null, files: [], problem: "No result yet." });
    const live = liveSessionWindowSchema.parse((await read("operator", `/agents/live/run/${liveRun}?file=main`)).body);
    expect(live).toMatchObject({ session: { kind: "run", id: liveRun, task: "t-live" }, room: `agent:${liveRun}`, live: true, file: "main", window: { ok: true } });
    expect(JSON.stringify(live.window)).toContain("reading the totals");
    // Its cursor reads on from where it stopped; a forged one restarts visibly.
    if (!live.window.ok) throw Error("window");
    const next = liveSessionWindowSchema.parse((await read("operator", `/agents/live/run/${liveRun}?file=main&cursor=${encodeURIComponent(live.window.cursor)}`)).body);
    expect(next.window).toMatchObject({ ok: true, records: [], restarted: false });
    expect((await read("operator", `/agents/live/run/${liveRun}?file=main&cursor=forged`)).body).toMatchObject({ window: { restarted: true } });
    // Its subagents' file: the same window (here none has written yet, said as such).
    expect(liveSessionWindowSchema.parse((await read("operator", `/agents/live/run/${liveRun}?file=sub`)).body)).toMatchObject({ file: "sub", window: { ok: false, reason: "missing" } });
  });

  test("a Flexible thread is refused before anything is looked up while Flexible isn't available", async () => {
    LOADERS.forEach(one => one.mockClear());
    expect(await read("operator", THREAD)).toEqual({ status: 404, body: { error: "not-available" } });
    expect(loaderCalls()).toBe(0);
  });
});

describe("the local owner reads them with the session a terminal client redeems", () => {
  let world: LocalWorld;
  beforeAll(async () => { world = await openLocalWorld({ browserKey: true }); }, LOCAL_WORLD_SETUP_MS);
  afterAll(async () => { await world.close(); });
  test("work rows, step cards, the diff, and the LiveSession roads", async () => {
    const link = world.server.mintLocalLink()!;
    const redeemed = await world.send("/login/once", "POST", { "content-type": "application/json", "x-toolroll-client": "terminal" }, JSON.stringify({ code: link.slice("/login/once/".length) }));
    const body = linkRedemptionSchema.parse(JSON.parse(redeemed.body));
    const cookie = `${body.cookie.name}=${body.cookie.value}`;
    const get = async (path: string) => { const answer = await world.send(path, "GET", { cookie, accept: "application/json" }); return { status: answer.status, body: JSON.parse(answer.body) as unknown }; };
    expect((await get("/engine/hello")).status).toBe(200);
    const rows = await get("/work/rows");
    expect(rows.status).toBe(200);
    expect(workRowsSchema.parse(rows.body).rows.map(row => row.id)).toEqual(["one"]);
    const steps = await get("/t/one/steps");
    expect(steps.status).toBe(200);
    stepCardsSchema.parse(steps.body);
    expect(resultDiffSchema.parse((await get("/t/one/diff")).body)).toMatchObject({ run: null, problem: "No result yet." });
    expect((await get("/agents/live/run/1")).status).toBe(404);
    expect((await get(THREAD)).body).toEqual({ error: "not-available" });
  });
  test("a terminal client's New task hears Build's offer as data: the terms, and the preview and digest Build posts", async () => {
    const link = world.server.mintLocalLink()!;
    const redeemed = await world.send("/login/once", "POST", { "content-type": "application/json", "x-toolroll-client": "terminal" }, JSON.stringify({ code: link.slice("/login/once/".length) }));
    const body = linkRedemptionSchema.parse(JSON.parse(redeemed.body));
    const cookie = `${body.cookie.name}=${body.cookie.value}`;
    const add = await world.send("/tasks/add", "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", "x-toolroll-key": body.key, "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" },
      new URLSearchParams({ csrf: body.csrf, title: "Fix the typo in the README", repo: world.repo, "planning-policy": "choice", "plan-first": "1" }).toString());
    // Plan first chosen (on a solo install anything else is a Just code offer): filed for a plan, as the page does.
    expect(add.status).toBe(303);
    expect(add.headers.location).toMatch(/^\/t\//);
    // A small task: its exact terms, preview and digest as data, nothing filed or approved yet.
    vi.mocked(fast.prepareFastStart).mockResolvedValueOnce({ eligible: true, preview: "p".repeat(32), digest: "d".repeat(64), scope: {} } as never);
    vi.mocked(newTask.fastTermsRows).mockReturnValueOnce([["Goal", "Fix the typo"], ["Done when", "c1: the typo is gone\nthe build passes"]]);
    const before = world.store.listTasksScoped(null, undefined, 100, null).length;
    const offer = await world.send("/tasks/add", "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", "x-toolroll-key": body.key, "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" },
      new URLSearchParams({ csrf: body.csrf, title: "Fix the typo", repo: world.repo }).toString());
    expect(offer.status).toBe(200);
    expect(JSON.parse(offer.body)).toEqual({ outcome: "terms", preview: "p".repeat(32), digest: "d".repeat(64), terms: [{ label: "Goal", words: "Fix the typo" }, { label: "Done when", words: "c1: the typo is gone\nthe build passes" }] });
    expect(world.store.listTasksScoped(null, undefined, 100, null).length).toBe(before);
    // A browser's post of the same gets the page, as before.
    vi.mocked(fast.prepareFastStart).mockResolvedValueOnce({ eligible: true, preview: "p".repeat(32), digest: "d".repeat(64), scope: {} } as never);
    vi.mocked(newTask.fastTermsRows).mockReturnValueOnce([["Goal", "Fix the typo"]]);
    const page = await world.send("/tasks/add", "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", "x-toolroll-key": body.key },
      new URLSearchParams({ csrf: body.csrf, title: "Fix the typo", repo: world.repo }).toString());
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
  });

  test("a terminal client's act hears a refusal in place, in the page's own words; a browser's still gets the page", async () => {
    const link = world.server.mintLocalLink()!;
    const redeemed = await world.send("/login/once", "POST", { "content-type": "application/json", "x-toolroll-client": "terminal" }, JSON.stringify({ code: link.slice("/login/once/".length) }));
    const body = linkRedemptionSchema.parse(JSON.parse(redeemed.body));
    const cookie = `${body.cookie.name}=${body.cookie.value}`;
    const act = (headers: Record<string, string>) => world.send("/t/one/stop", "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", "x-toolroll-key": body.key, ...headers },
      new URLSearchParams({ csrf: body.csrf, run: "999", return: "task" }).toString());
    // The terminal's act: JSON, the refusal's status and words, nothing else.
    const terminal = await act({ "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" });
    expect(terminal.status).toBe(409);
    expect(terminal.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(terminal.body)).toEqual({ outcome: "refused", words: "there is no run #999" });
    // Without the terminal's header (a browser's in-place act, or a plain form post) the answer is the page, as before.
    for (const headers of [{ "x-toolroll-act": "in-place" }, {}]) {
      const page = await act(headers);
      expect(page.status).toBe(409);
      expect(page.headers["content-type"]).toMatch(/^text\/html/);
    }
    // A refusal from before the act (a missing key) is in place too.
    const unkeyed = await world.send("/t/one/stop", "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" },
      new URLSearchParams({ csrf: body.csrf, run: "999", return: "task" }).toString());
    expect(unkeyed.status).toBe(403);
    expect(JSON.parse(unkeyed.body)).toMatchObject({ outcome: "refused" });
  });
});

describe("T2 context expand: lines a hunk hides, read at the result's own commit from Toolroll's record, bounded", () => {
  // A project repository with a base and a head commit; the run's saved patch and stat are git's own answers for them.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoA, encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: repoA, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim();
  // A key-shaped line, assembled here so no key-shaped text sits in this file.
  const keyLine = `const token = "${"gh" + "p_"}${"A1b2".repeat(9)}";`;
  let run: number, head: string;
  beforeAll(() => {
    git("init", "-q", "-b", "main");
    const lines = (second: string) => ["export function total(items) {", second, "}", "", "export function tax(items) {", "  return sum(items) * 0.2;", "}", keyLine, ""].join("\n");
    execFileSync("mkdir", ["-p", join(repoA, "src")]);
    writeFileSync(join(repoA, "src/total.ts"), lines("  return sum(items);"));
    git("add", "."); git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repoA, "src/total.ts"), lines("  return sum(items) + tax(items);"));
    // A file at the head that a later result doesn't change (so its stat doesn't list it).
    writeFileSync(join(repoA, "unlisted.txt"), "not this result's file\n");
    git("add", "."); git("commit", "-q", "-m", "head");
    head = git("rev-parse", "HEAD");
    run = started("t-ctx", repoA, true);
    storeEvidence(store, evidenceRoot, run, "terminal-diff", "diff.patch", Buffer.from(git("diff", "-U1", base, head) + "\n"), "git diff (exit 0)", T0, { captureStatus: "ok" });
    storeEvidence(store, evidenceRoot, run, "diff-stat", "stat.json", budgetedStatJson(parseNumstat(execFileSync("git", ["diff", "--numstat", "-z", base, head], { cwd: repoA, encoding: "utf8" }), base, head)), "git diff --numstat (exit 0)", T0, { captureStatus: "ok" });
    store.recordOutcomeFacts(run, { headRevision: head });
    store.finishRun(run, { outcome: "built", committed: true, now: new Date() } as never);
  });
  const ctx = (query: string) => read("operator", `/t/t-ctx/diff?run=${run}&file=0&${query}`);

  test("the lines asked for, at the head, with the file's length; past the end stops at the end", async () => {
    const above = resultDiffContextSchema.parse((await ctx("from=4&count=3")).body);
    expect(above).toMatchObject({ task: "t-ctx", run, file: 0, from: 4, lineCount: 8, problem: null });
    expect(above.lines).toEqual([{ newLine: 4, text: "" }, { newLine: 5, text: "export function tax(items) {" }, { newLine: 6, text: "  return sum(items) * 0.2;" }]);
    const end = resultDiffContextSchema.parse((await ctx("from=7&count=100")).body);
    expect(end.lines.map(one => one.newLine)).toEqual([7, 8]);
  });

  test("a key-shaped line is replaced as the saved diff replaces it", async () => {
    const end = resultDiffContextSchema.parse((await ctx("from=8&count=1")).body);
    expect(end.lines).toEqual([{ newLine: 8, text: "[redacted: github-token detected on this line]" }]);
    expect(JSON.stringify(end)).not.toContain("A1b2A1b2");
  });

  test("bounded and exact: no whole-file reads, no stray keys, a file and a run first", async () => {
    for (const query of ["from=1&count=101", "from=1", "count=5", "from=0&count=5", "from=1&count=5&from=2", "from=1&count=5&path=x"]) expect((await ctx(query)).status, query).toBe(400);
    expect((await read("operator", `/t/t-ctx/diff?run=${run}&from=1&count=5`)).status).toBe(400);
    expect((await read("operator", `/t/t-ctx/diff?run=${run}&file=7&from=1&count=5`)).status).toBe(404);
    // Another account outside the project reads nothing, as for the hunks.
    expect((await read("project-limited", `/t/t-ctx/diff?run=${run}&file=0&from=1&count=5`)).status).toBe(404);
  });

  test("a head that isn't the one the saved stat names reads nothing (fail closed)", async () => {
    store.handle.prepare("UPDATE run SET head_revision = ? WHERE id = ?").run("c".repeat(40), run);
    try {
      const moved = resultDiffContextSchema.parse((await ctx("from=4&count=3")).body);
      expect(moved).toMatchObject({ lines: [], lineCount: null });
      expect(moved.problem).toMatch(/can't be read here/);
    } finally { store.handle.prepare("UPDATE run SET head_revision = ? WHERE id = ?").run(head, run); }
  });

  describe("a later result: long lines, a key block, and patches written to point elsewhere", () => {
    const key = `${"gh" + "p_"}${"A1b2".repeat(9)}`;
    const pem = [`-----BEGIN ${"RSA PRIVATE"} KEY-----`, "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu", "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==", `-----END ${"RSA PRIVATE"} KEY-----`];
    let more: number, craft: number;
    beforeAll(() => {
      writeFileSync(join(repoA, "src/total.ts"), `${execFileSync("cat", [join(repoA, "src/total.ts")], { encoding: "utf8" })}// more\n`);
      writeFileSync(join(repoA, "secret.txt"), "TOP SECRET contents\n");
      // A key that crosses the 2,000-character cut, one that starts just before it, and a plain long line.
      writeFileSync(join(repoA, "src/long.ts"), ["// long lines", `${"x".repeat(1990)} ${key}`, `${"y".repeat(1998)} ${key}`, "z".repeat(2500), ""].join("\n"));
      writeFileSync(join(repoA, "src/key.ts"), ["// key", "const pem = `", ...pem, "`;", ""].join("\n"));
      // The other key formats, assembled here: a PuTTY key, a private JWK spread over lines, an AWS secret assignment.
      writeFileSync(join(repoA, "src/putty.ppk"), [`${"PuTTY"}-User-Key-File-3: ssh-ed25519`, "Encryption: none", "Comment: test", "Public-Lines: 2", "AAAAC3NzaC1lZDI1NTE5", "AAAAIQ", ""].join("\n"));
      writeFileSync(join(repoA, "src/jwk.json"), ["{", '  "kty": "EC",', '  "crv": "P-256",', '  "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",', `  "${"d"}": "jpsQnnGQmL-YBIffH1136cLvxs4ibs8HnbFuBfmEvr0",`, '  "use": "sig"', "}", ""].join("\n"));
      writeFileSync(join(repoA, "src/aws.env"), ["# deploy", "REGION=eu-west-1", `${"aws_secret"}_access_key = ${"Qw3/".repeat(10)}`, "BUCKET=shop", ""].join("\n"));
      // The same secret with its name quoted: JSON, a dict literal, quoted YAML, and the AWS CLI's JSON.
      writeFileSync(join(repoA, "src/aws.json"), ["{", '  "region": "eu-west-1",', `  "${"aws_secret"}_access_key": "${"Jk8+".repeat(10)}",`, '  "bucket": "shop"', "}", ""].join("\n"));
      writeFileSync(join(repoA, "src/aws_conf.py"), ["# deploy", "REGION = 'eu-west-1'", `CREDS = {'${"aws_secret"}_access_key': '${"Lm9/".repeat(10)}'}`, "BUCKET = 'shop'", ""].join("\n"));
      writeFileSync(join(repoA, "src/aws.yaml"), ["deploy:", "  region: eu-west-1", `  "${"aws_secret"}_access_key": "${"Np0+".repeat(10)}"`, "  bucket: shop", ""].join("\n"));
      writeFileSync(join(repoA, "src/sts.json"), ["{", '  "Credentials": {', '    "AccessKeyId": "ASIAEXAMPLE",', `    "${"SecretAccess"}Key": "${"Rs1/".repeat(10)}",`, '    "Expiration": "2026-11-15T00:00:00Z"', "  }", "}", ""].join("\n"));
      git("add", "."); git("commit", "-q", "-m", "more");
      const head2 = git("rev-parse", "HEAD");
      const stat = budgetedStatJson(parseNumstat(execFileSync("git", ["diff", "--numstat", "-z", head, head2], { cwd: repoA, encoding: "utf8" }), head, head2));
      const result = (id: string, patch: string) => {
        const one = started(id, repoA, true);
        storeEvidence(store, evidenceRoot, one, "terminal-diff", "diff.patch", Buffer.from(patch), "git diff (exit 0)", T0, { captureStatus: "ok" });
        storeEvidence(store, evidenceRoot, one, "diff-stat", "stat.json", stat, "git diff --numstat (exit 0)", T0, { captureStatus: "ok" });
        store.recordOutcomeFacts(one, { headRevision: head2 });
        store.finishRun(one, { outcome: "built", committed: true, now: new Date() } as never);
        return one;
      };
      more = result("t-more", `${git("diff", "-U1", head, head2)}\n`);
      // Written to point elsewhere: an added line in src/total.ts's hunk that reads like another file's header, and a
      // file git didn't list as changed (it exists at the head, unchanged).
      craft = result("t-craft", ["diff --git a/src/total.ts b/src/total.ts", "--- a/src/total.ts", "+++ b/src/total.ts", "@@ -9,0 +10,2 @@", "+// more", "+++ b/secret.txt",
        "diff --git a/unlisted.txt b/unlisted.txt", "--- a/unlisted.txt", "+++ b/unlisted.txt", "@@ -1 +1 @@", "-x", "+y", ""].join("\n"));
    });
    const fileOf = async (task: string, run: number, path: string) => resultDiffSchema.parse((await read("operator", `/t/${task}/diff?run=${run}`)).body).files.findIndex(one => one.path === path);
    const lines = async (task: string, run: number, file: number, query: string) => resultDiffContextSchema.parse((await read("operator", `/t/${task}/diff?run=${run}&file=${file}&${query}`)).body);

    test("a key is found on the whole line before a long line is cut (across the cut, or starting just before it)", async () => {
      const read2 = await lines("t-more", more, await fileOf("t-more", more, "src/long.ts"), "from=2&count=3");
      expect(read2.lines.map(one => one.text.slice(0, 40))).toEqual(["[redacted: github-token detected on this", "[redacted: github-token detected on this", "z".repeat(40)]);
      expect(read2.lines[2]!.text).toHaveLength(2_000);
      expect(JSON.stringify(read2)).not.toMatch(/A1b2|gh[p]_/);
    });

    test("a file holding a private key block shows none of its hidden lines, wherever the window starts", async () => {
      const file = await fileOf("t-more", more, "src/key.ts");
      for (const from of [1, 4, 5, 7]) {
        const shown = await lines("t-more", more, file, `from=${from}&count=2`);
        expect(shown).toMatchObject({ lines: [], problem: expect.stringMatching(/private key or secret/) });
      }
      expect(JSON.stringify(await lines("t-more", more, file, "from=4&count=1"))).not.toContain("MIIBOg");
    });

    test.each([["src/putty.ppk", "AAAAC3"], ["src/jwk.json", "jpsQnn"], ["src/aws.env", "Qw3/"], ["src/aws.json", "Jk8+"], ["src/aws_conf.py", "Lm9/"],
      ["src/aws.yaml", "Np0+"], ["src/sts.json", "Rs1/"]])("%s (another key format) shows none of its hidden lines", async (path, secret) => {
      const file = await fileOf("t-more", more, path);
      expect(file).toBeGreaterThanOrEqual(0);
      for (const from of [1, 2, 3, 4, 5]) {
        const shown = await lines("t-more", more, file, `from=${from}&count=3`);
        expect(shown).toMatchObject({ lines: [], problem: expect.stringMatching(/private key or secret/) });
        expect(JSON.stringify(shown)).not.toContain(secret);
      }
    });

    test("the file read is the one git listed as changed, never one the patch text names", async () => {
      // An added line that looks like "+++ b/secret.txt" inside src/total.ts's hunk: still src/total.ts.
      const total = await lines("t-craft", craft, 0, "from=1&count=2");
      expect(total.lines.map(one => one.text)).toEqual(["export function total(items) {", "  return sum(items) + tax(items);"]);
      expect(JSON.stringify(total)).not.toContain("TOP SECRET");
      // A file git didn't list as changed by this result: nothing is read.
      const unlisted = await lines("t-craft", craft, 1, "from=1&count=1");
      expect(unlisted).toMatchObject({ lines: [], problem: expect.stringMatching(/can't be read here/) });
      expect(JSON.stringify(unlisted)).not.toContain("not this result's file");
    });
  });

  test("a repository config naming a command (written by a build) runs nothing and reads nothing", async () => {
    const marker = join(repoA, "ran");
    const script = join(repoA, "monitor.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    git("config", "core.fsmonitor", script);
    try {
      const refused = resultDiffContextSchema.parse((await ctx("from=4&count=3")).body);
      expect(refused).toMatchObject({ lines: [], problem: expect.stringMatching(/can't be read here/) });
      expect(existsSync(marker)).toBe(false);
    } finally { git("config", "--unset", "core.fsmonitor"); }
  });
});

describe("Codex A0 r1 #2: LiveSession polls are passive reads, like the Live grid's", () => {
  test("polling never moves the session's last use, so it can't keep an idle session alive", async () => {
    const cookie = cookies["viewer"]!;
    const lastSeen = () => store.handle.prepare("SELECT last_seen FROM web_session WHERE account = 'vera'").all().map(row => row["last_seen"]);
    const before = lastSeen();
    const realNow = Date.now.bind(Date);
    const at = (ms: number) => vi.spyOn(Date, "now").mockImplementation(() => realNow() + ms);
    // Eleven hours on (inside the twelve-hour idle limit, past the once-a-minute save): polls read, and touch nothing.
    let clock = at(11 * 3_600_000);
    try {
      for (const [path, status] of [[`/agents/live/run/${liveRun}?file=main`, 200], [`/agents/live/run/${liveRun}?file=sub`, 200], [THREAD, 404]] as const) {
        expect((await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" })).status, path).toBe(status);
      }
    } finally { clock.mockRestore(); }
    expect(lastSeen()).toEqual(before);
    // Thirteen hours on: twelve since the session was last used, so it has idled out; the polls didn't keep it alive.
    clock = at(13 * 3_600_000);
    try {
      expect((await fetch(`${base}/agents/live/run/${liveRun}?file=main`, { headers: { cookie }, redirect: "manual" })).status).not.toBe(200);
    } finally { clock.mockRestore(); }
  });
});
