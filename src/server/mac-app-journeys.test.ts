/**
 * The Mac app's task journeys against the real server (docs/plans/mac-app-qa.md, level C): every request is made exactly
 * as mac/Sources/ToolrollCore/ToolrollClient.swift makes it (the local session a terminal client redeems, the same
 * paths, form fields and headers), and every answer is read the way the app reads it (sendFormActOnce: JSON words, else
 * the followed redirect's `problem`/`said`; TaskStatusTone(workTone:token:) for a Work row's sidebar section). One test
 * per requirement id. A `test.fails` is a recorded disagreement between the app and the server, left visible until fixed.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { join } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { acquire, finalize, release } from "../claim.js";
import { storeEvidence } from "../evidence.js";
import { register } from "../runner.js";
import { propose } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { sealVerificationReceipt } from "../verification-evidence.js";
import { presented } from "../../test/serve-kit.js";
import { csrfOf, signIn } from "../../test/loopback-key-kit.js";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../../test/local-owner-world.js";
import { linkRedemptionSchema, modelsReadSchema, stepCardsSchema, workRowsSchema } from "../contracts/engine-api.js";

type Answer = { status: number; body: string; headers: IncomingHttpHeaders };
type MacOutcome = { done: string } | { refused: string };

/** ToolrollClient.staleSessionWords. */
const STALE_SESSION_WORDS = ["Toolroll restarted", "isn't connected to Toolroll"];
/** WorkbenchStore+TaskActions.swift. */
const CANCELLABLE_STATES = new Set(["queued", "failed", "running"]);
const STILL_WORKING_WORDS = "still has work going on";
const ARCHIVE_REASON = "Archived from the Mac app";
const OPUS = "claude|claude-opus-5-5";

/** The sidebar section a Work row lands in: Models.swift TaskStatusTone(workTone:token:), then WorkbenchStore's
 * needsRows / runningRows / queuedRows / settledRows. */
type Section = "Needs you" | "Running" | "Queued" | "Settled" | "Settled (failed)";
function macSection(status: { tone: string; token: string }): Section {
  if (["cancelled", "assignment-cancelled", "complete", "assignment-complete"].includes(status.token)) return "Settled";
  if (status.token === "failed" || status.token === "assignment-failed") return "Settled (failed)";
  switch (status.tone) {
    case "attention": return "Needs you";
    case "live": return "Running";
    case "problem": return "Settled (failed)";
    case "done": return "Settled";
    case "ready": return status.token === "assignment-ready-to-check" ? "Needs you" : "Queued";
    case "muted": case "neutral": return "Queued";
    default: return "Settled"; // fromWire(token) → .unknown sits with Settled
  }
}

/** The Mac app's local session over one console: its reads and its form acts, header for header. */
async function connect(w: Pick<LocalWorld, "server" | "send" | "origin">) {
  const link = w.server.mintLocalLink()!;
  const redeemed = await w.send("/login/once", "POST", { "content-type": "application/json", "x-toolroll-client": "terminal" }, JSON.stringify({ code: link.slice("/login/once/".length) }));
  const body = linkRedemptionSchema.parse(JSON.parse(redeemed.body));
  const cookie = `${body.cookie.name}=${body.cookie.value}`;
  // makeRequest(.localSession): every request.
  const base = { accept: "application/json", "x-toolroll-client": "terminal", cookie, origin: w.origin, "x-csrf-token": body.csrf };
  const keyed = (key: string) => ({ ...base, "x-toolroll-key": key, "x-toolroll-act": "in-place" });
  const get = async (path: string) => { const a = await w.send(path, "GET", base); return { status: a.status, body: JSON.parse(a.body) as unknown }; };
  /** sendFormActOnce, raw: csrf first, then the act's fields. */
  const post = (path: string, fields: [string, string][], key = body.key): Promise<Answer> =>
    w.send(path, "POST", { ...keyed(key), "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams([["csrf", body.csrf], ...fields]).toString());
  /** What sendFormActOnce concludes. URLSession follows a redirect (a 303 becomes a GET with the same headers), then
   * JSON words win; else the final URL's `problem` / `said`; else the default words for a 2xx/3xx. */
  const conclude = async (first: Answer, defaultDone: string, key = body.key): Promise<MacOutcome> => {
    let answer = first;
    let url = new URL("/", w.origin);
    for (let hops = 0; hops < 5 && answer.status >= 300 && answer.status < 400 && typeof answer.headers.location === "string"; hops += 1) {
      url = new URL(answer.headers.location, url);
      answer = await w.send(url.pathname + url.search, "GET", keyed(key));
    }
    if (answer.status === 401) return { refused: "Session ended or access changed — reconnect in Workspace Settings." };
    let obj: Record<string, unknown> | null = null;
    try { const parsed = JSON.parse(answer.body) as unknown; obj = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { obj = null; }
    if (obj !== null) {
      const words = [obj["words"], obj["error"], obj["said"], obj["message"]].find(one => typeof one === "string") as string | undefined ?? "";
      if (obj["outcome"] === "refused" || answer.status >= 400) return { refused: words === "" ? `Action refused (${answer.status}).` : words };
      return { done: words === "" ? defaultDone : words };
    }
    const problem = url.searchParams.get("problem"), said = url.searchParams.get("said");
    if (problem !== null && problem !== "") return { refused: problem };
    if (said !== null && said !== "") return { done: said };
    if (answer.status >= 200 && answer.status < 400) return { done: defaultDone };
    return { refused: `Action failed (HTTP ${answer.status}).` };
  };
  const act = async (path: string, fields: [string, string][], defaultDone: string, key = body.key) => conclude(await post(path, fields, key), defaultDone, key);
  const enc = (id: string) => encodeURI(id);
  return {
    key: body.key, csrf: body.csrf, cookie, get, post,
    rows: async (view?: string) => workRowsSchema.parse((await get(view === undefined ? "/work/rows" : `/work/rows?view=${view}`)).body).rows,
    steps: async (id: string) => stepCardsSchema.parse((await get(`/t/${enc(id)}/steps`)).body),
    models: async () => modelsReadSchema.parse((await get("/engine/models")).body),
    // The client's acts, field for field.
    cancelTask: (id: string, state: string, run: number | null, key?: string) => act(`/t/${enc(id)}/cancel`, [["state", state], ["run", run === null ? "none" : String(run)]], "Task cancelled.", key),
    stopTask: (id: string, run: number) => act(`/t/${enc(id)}/stop`, [["run", String(run)], ["return", "task"]], "Stopping active run."),
    archiveTask: (id: string, key?: string) => act(`/t/${enc(id)}/archive`, [["reason", ARCHIVE_REASON], ["return", "/"]], "Archived.", key),
    restoreTask: (id: string) => act(`/t/${enc(id)}/restore`, [["return", "/"]], "Restored."),
    routeTask: (id: string, phase: string, agent: string) => act(`/t/${enc(id)}/route`, [["phase", phase], ["agent", agent]], "Models changed for this task."),
    holdTask: (id: string) => act(`/t/${enc(id)}/hold`, [["reason", "Paused from Toolroll Mac"]], "Paused."),
    acceptResult: (id: string, run: number, receipt: string) => act(`/t/${enc(id)}/complete`, [["receipt", receipt], ["run", String(run)]], "Accepted. Task complete."),
  };
}
type Mac = Awaited<ReturnType<typeof connect>>;

let world: LocalWorld, mac: Mac;
const now = () => new Date();

// ---- fixtures: the store as a worker leaves it -------------------------------------------------------------------

/** A task placed in the project; `sealed`: its scope approved ("Just code"). */
function placed(w: LocalWorld, id: string, sealed = true): number {
  w.store.createTask({ id, title: `Fix ${id}` }, now());
  const ref = w.store.refFor("built-in", id, "ours").id;
  w.store.placeTask(ref, w.repo);
  if (sealed) {
    propose(w.store, { taskId: id, goal: `Fix ${id}`, now: now() });
    if (!w.store.sealScopeApproval(id, "alex", now())) throw new Error(`seal ${id}`);
  }
  return ref;
}
/** A task waiting on a plan approval (a proposed scope, nothing sealed). */
function proposed(w: LocalWorld, id: string): number {
  const made = w.store.createConsoleTask({ id, title: `Plan ${id}`, repo: w.repo, goal: `do ${id}`, acceptance: [{ id: "c1", statement: `${id} is done.`, evidence: ["manual-review"] }], filedVia: "cli" }, now());
  if (!made.ok) throw new Error(made.reason);
  return w.store.lookupRef(id)!.id;
}
/** Claimed and building on this computer's runner. */
function building(w: LocalWorld, ref: number): { run: number; lease: string } {
  const taken = acquire(w.store, ref, "mac-runner", { token: "tok-mac-runner", now: now(), ttlMs: 3_600_000 });
  if (!taken.ok) throw new Error(`claim: ${JSON.stringify(taken)}`);
  const run = w.store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "mac-runner", branch: `b-${ref}`, worktree: w.root, now: now(), ...presented(w.store, ref, "builder") });
  return { run, lease: taken.claim.leaseId };
}
function endRun(w: LocalWorld, build: { run: number; lease: string }, outcome: "built" | "failed"): void {
  w.store.finishRun(build.run, outcome === "built" ? { outcome, committed: true, now: now() } : { outcome, reason: "retryable-infra", now: now() });
  release(w.store, build.lease, now());
}
/** A revised family: `root` built a result, then a person filed `<root>-2` revising it (queued, no run yet). */
function revisedFamily(w: LocalWorld, root: string): { rootRun: number; current: string } {
  const ref = placed(w, root);
  const build = building(w, ref);
  endRun(w, build, "built");
  w.store.setTaskState(root, "done", now());
  const current = `${root}-2`;
  w.store.createTask({ id: current, title: `Fix ${root}, again`, filedBy: { name: "alex", kind: "person" } }, now());
  const child = w.store.refFor("built-in", current, "ours").id;
  w.store.placeTask(child, w.repo);
  w.store.markRevision(child, root, w.store.saveArtifact({ run: build.run, kind: "revision-brief", key: "brief", bytesOriginal: 1, bytesStored: 1, truncated: false, sha256: "b".repeat(64), capture: "fixture" }, now()));
  return { rootRun: build.run, current };
}
/** A finished build whose approved check passed and whose requirement held: a result a person can accept. */
function verifiedResult(w: LocalWorld, id: string): void {
  w.store.setVerifyCommand({ repo: w.repo, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, now());
  const made = w.store.createConsoleTask({ id, title: `Ship ${id}`, repo: w.repo, goal: `do ${id}`, acceptance: [{ id: "c1", statement: "tests pass.", evidence: ["check"] }], filedVia: "cli" }, now());
  if (!made.ok || !w.store.sealScopeApproval(id, "alex", now())) throw new Error(`verified ${id}`);
  const ref = w.store.lookupRef(id)!.id;
  const build = building(w, ref);
  w.store.stampRun(build.run, { scopeDigest: w.store.getScope(id)!.digest, baseRevision: "a".repeat(40) });
  w.store.recordOutcomeFacts(build.run, { headRevision: "b".repeat(40) });
  const evidence = join(w.root, "evidence");
  storeEvidence(w.store, evidence, build.run, "check-log", "check.txt", Buffer.from("2 checks passed"), "npm test", now(), { captureStatus: "ok" });
  sealVerificationReceipt(w.store, evidence, build.run, "b".repeat(40), w.store.liveVerifyCommand(w.repo)!, { configured: true, ran: true, exitCode: 0 }, now());
  endRun(w, build, "built");
  w.store.saveProofVerdict(build.run, "verified", ["the approved verification command passed"], now(),
    [{ id: "c1", statement: "tests pass.", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "npm test" }] }] as never);
  w.store.setTaskState(id, "done", now());
}
const rowOf = async (id: string, view?: string) => (await mac.rows(view)).find(row => row.id === id);

beforeAll(async () => {
  world = await openLocalWorld({ browserKey: true });
  register(world.store, { name: "mac-runner", host: "here", capacity: 16, repos: [world.repo], now: now(), newToken: () => "tok-mac-runner" });
  mac = await connect(world);
}, LOCAL_WORLD_SETUP_MS);
afterAll(async () => { await world.close(); });

// ---- Sidebar ------------------------------------------------------------------------------------------------------

test("SB1: needs-you, building, queued, retrying, on hold, complete and failed rows each land in their sidebar section", async () => {
  proposed(world, "sb-needs");
  building(world, placed(world, "sb-building"));
  placed(world, "sb-queued");
  const retrying = placed(world, "sb-retrying");
  world.store.holdOwned({ taskRef: retrying, ownerKind: "backoff", ownerId: String(retrying), reason: "retrying", until: new Date(Date.now() + 100_000) }, now());
  placed(world, "sb-held");
  expect(await mac.holdTask("sb-held")).toHaveProperty("done");
  verifiedResult(world, "sb-complete");
  const review = (await mac.steps("sb-complete")).review!;
  expect(await mac.acceptResult("sb-complete", review.run, review.receipt)).toEqual({ done: "Marked complete." });
  const failed = placed(world, "sb-failed");
  endRun(world, building(world, failed), "failed");
  world.store.setTaskState("sb-failed", "failed", now());

  const expected: Record<string, Section> = {
    "sb-needs": "Needs you", "sb-building": "Running", "sb-queued": "Queued", "sb-retrying": "Queued", "sb-held": "Queued",
    "sb-complete": "Settled", "sb-failed": "Settled (failed)",
  };
  const rows = await mac.rows();
  const landed = Object.fromEntries(Object.keys(expected).map(id => {
    const row = rows.find(one => one.id === id);
    return [id, row === undefined ? "missing" : macSection(row.status)];
  }));
  expect(landed).toEqual(expected);
});

// FINDING: the server's Cancelled row is token "assignment-cancelled", tone "muted" (work-index.ts `assignment-${state}`);
// The server sends token "assignment-cancelled" with the muted tone a Queued row also has: the token decides.
test("SB1: a cancelled row lands in Settled, never Queued", async () => {
  placed(world, "sb-cancelled");
  expect(await mac.cancelTask("sb-cancelled", "queued", null)).toHaveProperty("done");
  const row = await rowOf("sb-cancelled");
  expect(row?.status).toMatchObject({ label: "Cancelled", tone: "muted" });
  expect(macSection(row!.status)).toBe("Settled");
});

test("SB2: an archived task is absent from the default list and present in ?view=archived", async () => {
  placed(world, "sb2");
  expect(await rowOf("sb2")).toBeDefined();
  expect(await mac.archiveTask("sb2")).toHaveProperty("done");
  expect(await rowOf("sb2")).toBeUndefined();
  expect(await rowOf("sb2", "archived")).toBeDefined();
  // The archived list holds only archived rows (Settled → Archived lists exactly them).
  expect((await mac.rows("archived")).map(row => row.id)).not.toContain("sb-queued");
});

// ---- Cancel -------------------------------------------------------------------------------------------------------

test("CA1: a queued task with a past run is cancelled with exactly the state and latestRun the steps read shows", async () => {
  const ref = placed(world, "ca1");
  const build = building(world, ref);
  endRun(world, build, "failed");
  world.store.setTaskState("ca1", "queued", now());
  const steps = await mac.steps("ca1");
  expect(steps.task).toMatchObject({ id: "ca1", state: "queued" });
  expect(steps.latestRun).toBe(build.run);
  expect(CANCELLABLE_STATES.has(steps.task.state)).toBe(true);
  expect(await mac.cancelTask(steps.task.id, steps.task.state, steps.latestRun)).toHaveProperty("done");
  expect(world.store.getTask("ca1")?.state).toBe("cancelled");
});

test("CA2: a revised task's cancel names the current version from the steps read; the row's root id cancels nothing", async () => {
  const { current } = revisedFamily(world, "ca2");
  // The row is the family's, under its root id.
  const row = (await mac.rows()).find(one => one.id === "ca2" || one.id === current);
  expect(row?.id).toBe("ca2");
  const steps = await mac.steps(row!.id);
  expect(steps.task).toMatchObject({ id: current, root: "ca2", state: "queued" });
  // The root, named with what the steps read showed for the current version: refused, nothing changes.
  const atRoot = await mac.cancelTask(row!.id, steps.task.state, steps.latestRun);
  expect(atRoot).toHaveProperty("refused");
  expect(world.store.getTask("ca2")?.state).toBe("done");
  expect(world.store.getTask(current)?.state).toBe("queued");
  // The current version, as the app sends it: cancelled.
  expect(await mac.cancelTask(steps.task.id, steps.task.state, steps.latestRun)).toHaveProperty("done");
  expect(world.store.getTask(current)?.state).toBe("cancelled");
  expect(world.store.getTask("ca2")?.state).toBe("done");
});

test("CA3: a running task's cancel is refused in words (claimed), and nothing changes", async () => {
  const build = building(world, placed(world, "ca3"));
  const steps = await mac.steps("ca3");
  // A worker's claim leaves the task's own state as it was ("queued"); only the live run says it is building. The app
  // sends exactly what it read, so the cancel is proved and then refused for the claim.
  expect(steps.liveRun).toBe(build.run);
  expect(CANCELLABLE_STATES.has(steps.task.state)).toBe(true);
  const stateBefore = world.store.getTask("ca3")?.state;
  const answer = await mac.cancelTask(steps.task.id, steps.task.state, steps.latestRun);
  expect(answer).toHaveProperty("refused");
  expect((answer as { refused: string }).refused.trim()).not.toBe("");
  expect(world.store.getTask("ca3")?.state).toBe(stateBefore);
  expect((await mac.steps("ca3")).liveRun).toBe(build.run);
});

// FINDING: the refusal is the store's bare reason code ("not cancelled: claimed"), not plain words a person can act on.
test("CA3: the running task's refusal says, in plain words, to stop it first", async () => {
  building(world, placed(world, "ca3-words"));
  const steps = await mac.steps("ca3-words");
  const answer = await mac.cancelTask(steps.task.id, steps.task.state, steps.latestRun) as { refused: string };
  expect(answer.refused).not.toMatch(/: claimed$/);
  expect(answer.refused).toMatch(/stop/i);
});

test("CA4: an already-cancelled task reads as ended on the steps read, the current version of a family included", async () => {
  placed(world, "ca4");
  expect(await mac.cancelTask("ca4", "queued", null)).toHaveProperty("done");
  const steps = await mac.steps("ca4");
  expect(steps.task.state).toBe("cancelled");
  // prepareCancel: not a cancellable state, so "already ended" and no request is sent.
  expect(CANCELLABLE_STATES.has(steps.task.state)).toBe(false);
  // A family whose current version was cancelled (CA2's): the row's steps read says so too.
  expect((await mac.steps("ca2")).task).toMatchObject({ id: "ca2-2", state: "cancelled" });
});

// FINDING: a confirm that lands after the task was already cancelled (a second click, or a cancel from the web page
// meanwhile) is answered with the 409 "changed" banner, because the store proves `seen` before it sees the task ended.
test("CA4: a confirm that arrives after the task was already cancelled says it has ended, not that it changed", async () => {
  placed(world, "ca4-race");
  const shown = await mac.steps("ca4-race");
  expect(await mac.cancelTask(shown.task.id, shown.task.state, shown.latestRun)).toHaveProperty("done");
  const again = await mac.cancelTask(shown.task.id, shown.task.state, shown.latestRun) as { refused: string };
  expect(again.refused).not.toMatch(/changed since it was shown/);
});

// ---- Archive / restore --------------------------------------------------------------------------------------------

test("AR1: archive (reason, return) takes the task off the default list; restore brings it back", async () => {
  placed(world, "ar1");
  expect(await mac.archiveTask("ar1")).toHaveProperty("done");
  expect(await rowOf("ar1")).toBeUndefined();
  expect(await rowOf("ar1", "archived")).toBeDefined();
  expect(await mac.restoreTask("ar1")).toHaveProperty("done");
  expect(await rowOf("ar1")).toBeDefined();
  expect(await rowOf("ar1", "archived")).toBeUndefined();
});

test("AR2: archiving a task with work going on is refused with words containing \"still has work going on\"", async () => {
  building(world, placed(world, "ar2"));
  const answer = await mac.archiveTask("ar2");
  expect(answer).toHaveProperty("refused");
  expect((answer as { refused: string }).refused).toContain(STILL_WORKING_WORDS);
  expect(await rowOf("ar2")).toBeDefined();
  expect(await rowOf("ar2", "archived")).toBeUndefined();
});

test("AR3: Stop & Archive: the stop is accepted, archive waits while the run winds down, then succeeds", async () => {
  const build = building(world, placed(world, "ar3"));
  expect(macSection((await rowOf("ar3"))!.status)).toBe("Running");
  // archiveOne(running: true): the steps read names the current version and its live run.
  const steps = await mac.steps("ar3");
  expect(steps.liveRun).toBe(build.run);
  expect(await mac.stopTask(steps.task.id, steps.liveRun!)).toHaveProperty("done");
  // Winding down: the one refusal the app retries.
  const waiting = await mac.archiveTask("ar3");
  expect((waiting as { refused?: string }).refused ?? "").toContain(STILL_WORKING_WORDS);
  // The worker seals the stopped attempt (its processes gone, the claim let go, the task back in the queue).
  expect(finalize(world.store, build.lease, { kind: "interrupted", runId: build.run, taskId: "ar3", stopRun: build.run, now: now() })).toMatchObject({ ok: true });
  expect(await mac.archiveTask("ar3")).toHaveProperty("done");
  expect(await rowOf("ar3")).toBeUndefined();
  expect(await rowOf("ar3", "archived")).toBeDefined();
});

test("AR4: a bulk archive of N archives each by its row id; one Undo (restore each) brings them all back", async () => {
  placed(world, "ar4-a");
  proposed(world, "ar4-b");
  revisedFamily(world, "ar4-c");
  const ids = ["ar4-a", "ar4-b", "ar4-c"];
  expect((await mac.rows()).map(row => row.id)).toEqual(expect.arrayContaining(ids));
  for (const id of ids) expect(await mac.archiveTask(id)).toHaveProperty("done");
  expect((await mac.rows()).map(row => row.id).filter(id => ids.includes(id) || id === "ar4-c-2")).toEqual([]);
  expect((await mac.rows("archived")).map(row => row.id)).toEqual(expect.arrayContaining(ids));
  // restoreTasks(ids): the ids the archive notice kept.
  for (const id of ids) expect(await mac.restoreTask(id)).toHaveProperty("done");
  expect((await mac.rows()).map(row => row.id)).toEqual(expect.arrayContaining(ids));
  expect((await mac.rows("archived")).map(row => row.id).filter(id => ids.includes(id))).toEqual([]);
});

// ---- Models per task ----------------------------------------------------------------------------------------------

// FINDING (MO1–MO4): POST /t/<id>/route is not a local-owner act (route-table.ts LOCAL_POSTS has no "task.act.route"),
// so the app's only session for it, the local owner's, is refused before the handler runs: "Set a password to do this."
// before a password exists, "Sign in with your password to do this." after. Change Models… never changes anything.
const LOCAL_OWNER_REFUSALS = ["Set a password to do this.", "Sign in with your password to do this."];

test.fails("MO1: a route change on the current version (phase, agent=provider|model) shows in the steps read as an override", async () => {
  proposed(world, "mo1");
  const current = (await mac.steps("mo1")).task.id;
  // setTaskModel(roleKey: "all"): plan, build and review, in that order; the first refusal ends it.
  for (const phase of ["plan", "build", "review"]) expect(await mac.routeTask(current, phase, OPUS)).toHaveProperty("done");
  const models = (await mac.steps("mo1")).models ?? [];
  for (const phase of ["plan", "build", "review"]) {
    expect(models.find(one => one.phase === phase)).toEqual({ phase, provider: "claude", model: "claude-opus-5-5", chosen: "override" });
  }
});

test("MO2: the workspace defaults are unchanged by a per-task change", async () => {
  const before = await mac.models();
  const stored = ["plan", "build", "review"].map(phase => world.store.phaseConfig("installation", phase));
  proposed(world, "mo2");
  // Holds whatever the route answers (today it is refused: see MO1); the full-session check below proves it after a change.
  await mac.routeTask((await mac.steps("mo2")).task.id, "build", OPUS);
  const after = await mac.models();
  expect(after.roles.map(role => [role.key, role.current])).toEqual(before.roles.map(role => [role.key, role.current]));
  expect(["plan", "build", "review"].map(phase => world.store.phaseConfig("installation", phase))).toEqual(stored);
});

test.fails("MO3: a route change on an approved task marks the approval out of date, and the task asks for approval again", async () => {
  placed(world, "mo3");
  expect(macSection((await rowOf("mo3"))!.status)).toBe("Queued");
  const answer = await mac.routeTask((await mac.steps("mo3")).task.id, "build", OPUS);
  // The words the app shows say so (the redirect's `said`).
  expect((answer as { done?: string }).done ?? "").toMatch(/approve it again/);
  expect((await mac.steps("mo3")).cards?.find(card => card.key === "approve")).toMatchObject({ needsYou: true });
  expect(macSection((await rowOf("mo3"))!.status)).toBe("Needs you");
});

test.fails("MO4: a route change while a run holds the task is refused in words about the run, and nothing changes", async () => {
  building(world, placed(world, "mo4"));
  const before = (await mac.steps("mo4")).models;
  const answer = await mac.routeTask((await mac.steps("mo4")).task.id, "build", OPUS);
  expect((await mac.steps("mo4")).models).toEqual(before);
  expect(answer).toHaveProperty("refused");
  // Refused for the run holding the task, not for who is asking.
  expect(LOCAL_OWNER_REFUSALS).not.toContain((answer as { refused: string }).refused);
});

/** A laptop whose owner set a password, read by the app's local session, and the same person signed in with that password
 * (a full session) for the acts the local owner may not make: `route` is POST /t/<id>/route as the app sends it. */
async function passwordWorld() {
  const w = await openLocalWorld({ browserKey: true });
  register(w.store, { name: "mac-runner", host: "here", capacity: 4, repos: [w.repo], now: now(), newToken: () => "tok-mac-runner" });
  const first = await connect(w);
  proposed(w, "pw-first");
  const beforePassword = await first.routeTask("pw-first", "build", OPUS);
  // setFirstPassword: the console's own form, then reconnect (setting it ends every session).
  const password = "correct horse battery";
  await w.send("/password/set", "POST", { cookie: first.cookie, origin: w.origin, "x-csrf-token": first.csrf, "x-toolroll-client": "terminal", "x-toolroll-key": first.key, "x-toolroll-act": "in-place",
    accept: "text/html", "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams([["csrf", first.csrf], ["password", password], ["again", password]]).toString());
  const local = await connect(w);
  const { cookie, key } = await signIn(w.port, password);
  const csrf = await csrfOf(w.port, cookie);
  const route = async (id: string, phase: string, agent: string): Promise<MacOutcome> => {
    const answer = await w.send(`/t/${id}/route`, "POST", { cookie, origin: w.origin, "content-type": "application/x-www-form-urlencoded", "x-toolroll-key": key, "x-toolroll-act": "in-place", "x-toolroll-client": "terminal" },
      new URLSearchParams([["csrf", csrf], ["phase", phase], ["agent", agent]]).toString());
    return answer.status === 303 ? { done: new URL(answer.headers.location!, w.origin).searchParams.get("said") ?? "" } : { refused: (JSON.parse(answer.body) as { words: string }).words };
  };
  return { w, local, route, beforePassword };
}

// FINDING: the picker offers every model /engine/models lists for a step (ModelPickerPopover), but a task's route takes
// only the installation's configured tiers for that step (agentconfig.ts agentChoicesFor; store.ts editTaskRoute
// "is not one of the configured agents"). Here: Opus 5.5 is offered for the planner, only Sonnet is configured.
test.fails("MO1: a model /engine/models offers for a step is one the task's route accepts", async () => {
  const { w, local, route } = await passwordWorld();
  try {
    const plan = (await local.models()).roles.find(role => role.key === "plan")!;
    const offered = plan.choices.flatMap(choice => choice.models.map(model => `${choice.provider}|${model.value}`));
    expect(offered).toContain(OPUS);
    expect(await route("pw-first", "plan", OPUS)).toHaveProperty("done");
  } finally {
    await w.close();
  }
}, LOCAL_WORLD_SETUP_MS);

// FINDING: setTaskModel(roleKey: "all") sends plan, build, then review, and a per-task route never takes review
// (agentconfig.ts agentChoicesFor offers no review choices: "no configured agent can take the reviewer role for this
// task right now"). The planner and builder change, then the picker reports a failure: a partial change. And the
// planner's change reads `chosen: "pinned"`, not "override" (the route reconciles the planner pin).
test.fails("MO1: the app's \"all\" change (plan, build, review) lands on every step it sends, each read as an override", async () => {
  const { w, local, route } = await passwordWorld();
  try {
    for (const phase of ["plan", "build", "review"]) w.store.setPhaseTierConfig("installation", phase, "strong", "claude", "claude-opus-5-5", "test", now());
    for (const phase of ["plan", "build", "review"]) expect.soft(await route("pw-first", phase, OPUS)).toHaveProperty("done");
    const models = (await local.steps("pw-first")).models ?? [];
    for (const phase of ["plan", "build", "review"]) expect.soft(models.find(one => one.phase === phase)).toEqual({ phase, provider: "claude", model: "claude-opus-5-5", chosen: "override" });
  } finally {
    await w.close();
  }
}, LOCAL_WORLD_SETUP_MS);

test("MO1–MO4, server side: the local owner is refused either way; a password session, on a configured agent, gets what the app expects", async () => {
  const { w, local, route, beforePassword } = await passwordWorld();
  try {
    expect(beforePassword).toEqual({ refused: "Set a password to do this." });
    expect(await local.routeTask("pw-first", "build", OPUS)).toEqual({ refused: "Sign in with your password to do this." });
    // Opus 5.5 as each step's strong tier: a configured agent the route accepts.
    for (const phase of ["plan", "build", "review"]) w.store.setPhaseTierConfig("installation", phase, "strong", "claude", "claude-opus-5-5", "test", now());
    const defaults = ["plan", "build", "review"].map(phase => w.store.phaseConfig("installation", phase));
    const currentBefore = (await local.models()).roles.map(role => role.current);
    // MO1
    // (plan and build: review is its own finding below)
    for (const phase of ["plan", "build"]) expect(await route("pw-first", phase, OPUS)).toHaveProperty("done");
    const models = (await local.steps("pw-first")).models ?? [];
    expect(models.find(one => one.phase === "build")).toEqual({ phase: "build", provider: "claude", model: "claude-opus-5-5", chosen: "override" });
    // (the planner's reads "pinned": part of the finding below)
    expect(models.find(one => one.phase === "plan")).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
    // MO2
    expect(["plan", "build", "review"].map(phase => w.store.phaseConfig("installation", phase))).toEqual(defaults);
    expect((await local.models()).roles.map(role => role.current)).toEqual(currentBefore);
    // MO3
    placed(w, "pw-mo3");
    expect(((await route("pw-mo3", "build", OPUS)) as { done?: string }).done ?? "").toMatch(/approve it again/);
    expect((await local.steps("pw-mo3")).cards?.find(card => card.key === "approve")).toMatchObject({ needsYou: true });
    // MO4
    building(w, placed(w, "pw-mo4"));
    const held = (await local.steps("pw-mo4")).models;
    const refused = await route("pw-mo4", "build", OPUS);
    expect(refused).toHaveProperty("refused");
    expect((refused as { refused: string }).refused.trim()).not.toBe("");
    expect((await local.steps("pw-mo4")).models).toEqual(held);
  } finally {
    await w.close();
  }
}, LOCAL_WORLD_SETUP_MS);

// ---- Restart and session ------------------------------------------------------------------------------------------

/** The same console started again over the same database and folders (test/local-owner-world.ts's options). */
function restartedConsole(w: LocalWorld) {
  return createDecisionServer({
    store: w.store, evidenceRoot: join(w.root, "evidence"), repo: w.repo, admittedRepos: () => [w.repo], configDir: w.configDir, telegramTokenFile: join(w.configDir, "telegram-token"),
    connectionHome: w.root, toolHome: w.root, platform: "darwin", browserKey: true,
    connectionProbe: async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false }),
    modelCatalogFetcher: (async () => { throw new Error("offline"); }) as typeof fetch,
    modelRunner: async () => ({ code: 1, stdout: "", stderr: "" }),
    firstTaskRunner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: true }),
    ghList: async () => ({ ok: false, reason: "gh-missing", message: "gh is not installed" }) as never,
    chatFetcher: (async () => { throw new Error("offline"); }) as typeof fetch,
    subscriptionChatRunner: async () => { throw new Error("no model in this test"); },
  });
}

test("RS1: after a console restart a form act with the old key is refused in words the app recognizes, before anything changes", async () => {
  const w = await openLocalWorld({ browserKey: true });
  try {
    const before = await connect(w);
    placed(w, "rs1");
    const shown = await before.steps("rs1");
    // Toolroll restarts on the same port over the same database: a new key epoch.
    const oldEpoch = w.server.keyEpoch;
    await new Promise<void>(resolve => w.server.close(() => resolve()));
    const again = restartedConsole(w);
    await new Promise<void>(resolve => again.listen(w.port, "127.0.0.1", resolve));
    try {
      expect(again.keyEpoch).not.toBe(oldEpoch);
      const stale = await before.post("/t/rs1/cancel", [["state", shown.task.state], ["run", "none"]]);
      expect(stale.status).toBe(409);
      const refusal = JSON.parse(stale.body) as { outcome: string; words: string };
      expect(refusal.outcome).toBe("refused");
      expect(STALE_SESSION_WORDS.some(one => refusal.words.includes(one))).toBe(true);
      expect(w.store.getTask("rs1")?.state).toBe("queued");
      const archived = await before.archiveTask("rs1");
      expect(STALE_SESSION_WORDS.some(one => ((archived as { refused?: string }).refused ?? "").includes(one))).toBe(true);
      expect((await before.rows("archived")).some(row => row.id === "rs1")).toBe(false);
      // The app reconnects (a fresh local link from the restarted console) and sends once more: that one goes through.
      const renewed = await connect({ server: again, send: w.send, origin: w.origin });
      expect(await renewed.cancelTask(shown.task.id, shown.task.state, shown.latestRun)).toHaveProperty("done");
      expect(w.store.getTask("rs1")?.state).toBe("cancelled");
    } finally {
      await new Promise<void>(resolve => again.close(() => resolve()));
    }
  } finally {
    await w.close();
  }
}, LOCAL_WORLD_SETUP_MS);
