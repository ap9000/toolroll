/**
 * The engine API's reads over HTTP (solo-workbench plan A0): each route admitted per persona exactly as the page it
 * mirrors (Work, the task page, the Live grid), a refused caller reading nothing (no loader runs), and every answer the
 * shape its contract says. The local owner reads them with the session a terminal client redeems (POST /login/once).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { acquire, release } from "../claim.js";
import { storeEvidence } from "../evidence.js";
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
import { engineContractDigest, helloSchema, linkRedemptionSchema, liveSessionWindowSchema, resultDiffFileSchema, resultDiffSchema, stepCardsSchema, workRowsSchema } from "../contracts/engine-api.js";

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
  server = createDecisionServer({ store, evidenceRoot, repos: [repoA, repoB], clock: () => new Date(), localRunner: "builder-1" });
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
const paths = () => ({ hello: "/engine/hello", work: "/work/rows", steps: "/t/t-done/steps", diff: "/t/t-done/diff", file: `/t/t-done/diff?run=${resultRun}&file=0`, live: `/agents/live/run/${liveRun}?file=main`, thread: THREAD });
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
  operator: { hello: 200, work: 200, steps: 200, diff: 200, file: 200, live: 200, thread: 404 },
  approver: { hello: 200, work: 200, steps: 200, diff: 200, file: 200, live: 200, thread: 404 },
  viewer: { hello: 200, work: 200, steps: 200, diff: 200, file: 200, live: 200, thread: 404 },
  "project-limited": { hello: 200, work: 200, steps: 404, diff: 404, file: 404, live: 404, thread: 404 },
  token: { hello: 200, work: 200, steps: 200, diff: 200, file: 200, live: 403, thread: 403 },
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

  test("a task and a run outside every project read the same as one that doesn't exist", async () => {
    for (const path of ["/t/nope/steps", "/t/nope/diff", "/agents/live/run/999999"]) expect((await read("operator", path)).status, path).toBe(404);
    expect((await read("operator", `/t/t-done/diff?run=${liveRun}`)).status).toBe(404); // not a result of this task
    expect((await read("operator", "/t/t-done/diff?file=0")).status).toBe(400); // a file needs the run it is of
    expect((await read("operator", `/t/t-done/diff?run=${resultRun}&file=9`)).status).toBe(404);
    expect((await read("operator", "/t/t-done/steps?x=1")).status).toBe(400);
    expect((await read("operator", `/agents/live/run/${liveRun}?file=other`)).status).toBe(400);
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
    const steps = stepCardsSchema.parse((await read("operator", "/t/t-ready/steps")).body);
    expect(steps.review).toEqual({ run, receipt: expect.stringMatching(/^[0-9a-f]{64}$/), source: store.getScope("t-ready")!.digest });
  });

  test("work rows, step cards, the diff and one file, and a LiveSession window", async () => {
    // The handshake first: this build's contract, the one the fixtures and schemas.json hold.
    expect(helloSchema.parse((await read("operator", "/engine/hello")).body)).toMatchObject({ version: 1, contract: engineContractDigest() });
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
      new URLSearchParams({ csrf: body.csrf, title: "Fix the typo in the README", repo: world.repo }).toString());
    // Not a small task (nothing sized it here): filed for a plan, as the page does.
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
