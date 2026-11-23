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
import { AGENTS_DRIFTED, AGENTS_PICK_AGAIN, applyPendingAgentChanges, LOCAL_AGENT_CHANGE_ACTION, TASK_RUNNING_NOW } from "../local-owner-acts.js";

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
    // setTaskModel: phase, agent (provider|model), the scope digest the picker read, and when (omitted: now).
    routeTask: (id: string, phase: string, agent: string, sawDigest: string, when?: string) =>
      act(`/t/${enc(id)}/route`, [["phase", phase], ["agent", agent], ["sawDigest", sawDigest], ...(when === undefined ? [] : [["when", when] as [string, string]])], "Models changed for this task."),
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

// The Mac app's Change Models (docs/plans/mac-change-models.md, revised): the local owner's own road, no password. The
// picker offers the steps read's `agentChoices` (plan and build; review is never per task) and posts `phase`, `agent`,
// `sawDigest` (the steps read's `scopeDigest`) and `when` (now, next-run or restart while a run holds the task).

/** Opus 5.5 configured for the planner and the builder (their strong tier): a choice the route accepts. Sonnet stays
 * the routine tier every medium task is routed to. */
function opusConfigured(w: LocalWorld): void {
  for (const phase of ["plan", "build"]) w.store.setPhaseTierConfig("installation", phase, "strong", "claude", "claude-opus-5-5", "test", now());
}
/** setTaskModel: read the steps for the digest, then post the pick. */
async function pick(m: Mac, id: string, phase: string, agent: string, when?: string): Promise<MacOutcome> {
  const steps = await m.steps(id);
  return m.routeTask(steps.task.id, phase, agent, steps.scopeDigest ?? "", when);
}
const ledgerOf = (w: LocalWorld, id: string, action: string) =>
  w.store.handle.prepare("SELECT actor, outcome, detail FROM action_ledger WHERE task_id = ? AND action = ? ORDER BY id").all(id, action).map(row => ({ ...row, detail: JSON.parse(String(row["detail"])) as Record<string, unknown> }));

test("MO1: the local owner changes a waiting task's planner and builder (agent=provider|model, sawDigest), no password, each read back", async () => {
  opusConfigured(world);
  proposed(world, "mo1");
  const shown = await mac.steps("mo1");
  // The picker's choices: exactly the configured, selectable agents; review is not a per-task role.
  for (const phase of ["plan", "build"] as const) expect(shown.agentChoices?.[phase]).toContainEqual({ provider: "claude", model: "claude-opus-5-5" });
  expect(Object.keys(shown.agentChoices ?? {}).sort()).toEqual(["build", "plan"]);
  expect(shown.pendingAgentChange).toBeNull();
  // setTaskModel(roleKey: "all"): plan, then build, each with the digest read just before it.
  expect(await pick(mac, "mo1", "plan", OPUS)).toEqual({ done: "The planner is now Claude claude-opus-5-5." });
  expect(await pick(mac, "mo1", "build", OPUS)).toEqual({ done: "The builder is now Claude claude-opus-5-5." });
  const models = (await mac.steps("mo1")).models ?? [];
  expect(models.find(one => one.phase === "build")).toEqual({ phase: "build", provider: "claude", model: "claude-opus-5-5", chosen: "override" });
  expect(models.find(one => one.phase === "plan")).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
  // Nothing was approved by the pick, and each change is in the ledger under the person.
  expect(world.store.getScope("mo1")?.approvedAt ?? null).toBeNull();
  expect(ledgerOf(world, "mo1", LOCAL_AGENT_CHANGE_ACTION).map(row => [row["actor"], row["outcome"], row.detail["phase"], row.detail["how"]]))
    .toEqual([["operator:alex", "changed", "plan", "now"], ["operator:alex", "changed", "build", "now"]]);
  // The same pick again writes nothing.
  const before = world.store.getScope("mo1")!.digest;
  expect(await pick(mac, "mo1", "build", OPUS)).toEqual({ done: "Claude claude-opus-5-5 is already the builder." });
  expect(world.store.getScope("mo1")!.digest).toBe(before);
});

test("MO1: a pick is refused in words, with nothing changed: a stale or missing digest, an unconfigured model, review, a size or clear edit, an unknown when", async () => {
  opusConfigured(world);
  proposed(world, "mo1-refused");
  const steps = await mac.steps("mo1-refused");
  const id = steps.task.id, digest = steps.scopeDigest!;
  const state = () => JSON.stringify([world.store.getScope("mo1-refused"), world.store.lookupRef("mo1-refused")]);
  const before = state();
  const refusals: [string, Promise<MacOutcome>, string][] = [
    ["stale digest", mac.routeTask(id, "build", OPUS, "0".repeat(32)), AGENTS_PICK_AGAIN],
    ["no digest", mac.routeTask(id, "build", OPUS, ""), AGENTS_PICK_AGAIN],
    ["not configured", mac.routeTask(id, "build", "claude|claude-haiku-4-5", digest), "Claude claude-haiku-4-5 isn't one of the configured builders right now. Pick again."],
    ["review", mac.routeTask(id, "review", OPUS, digest), "Pick a model for the planner or the builder."],
    ["unknown when", mac.routeTask(id, "build", OPUS, digest, "later"), "Say when: now, next run, or restart."],
  ];
  for (const [name, answer, words] of refusals) expect(await answer, name).toEqual({ refused: words });
  for (const extra of [["size", "large"], ["risky", "yes"], ["clear-phase", "build"], ["provider", "claude"], ["model", "x"]] as [string, string][]) {
    const answer = await mac.post(`/t/${id}/route`, [["phase", "build"], ["agent", OPUS], ["sawDigest", digest], extra]);
    expect(answer.status, extra[0]).toBe(400);
    expect((JSON.parse(answer.body) as { words: string }).words).toBe("Only the planner's or the builder's model can be changed here.");
  }
  expect(state()).toBe(before);
});

test("MO2: the workspace defaults are unchanged by a per-task change", async () => {
  opusConfigured(world);
  const before = await mac.models();
  const stored = ["plan", "build", "review"].map(phase => world.store.phaseConfig("installation", phase));
  proposed(world, "mo2");
  expect(await pick(mac, "mo2", "build", OPUS)).toHaveProperty("done");
  const after = await mac.models();
  expect(after.roles.map(role => [role.key, role.current])).toEqual(before.roles.map(role => [role.key, role.current]));
  expect(["plan", "build", "review"].map(phase => world.store.phaseConfig("installation", phase))).toEqual(stored);
});

test("MO3: on an approved task the pick is the owner's yes to the new agent only: still approved, the new builder sealed, in the ledger", async () => {
  opusConfigured(world);
  placed(world, "mo3");
  expect(macSection((await rowOf("mo3"))!.status)).toBe("Queued");
  const sealedBefore = world.store.getScope("mo3")!;
  expect(await pick(mac, "mo3", "build", OPUS)).toEqual({ done: "The builder is now Claude claude-opus-5-5. Still approved." });
  const scope = world.store.getScope("mo3")!;
  expect(scope.approvedDigest).toBe(scope.digest);
  expect(scope.digest).not.toBe(sealedBefore.digest);
  expect(scope.approvedBy).toBe("alex");
  const sealed = JSON.parse(scope.approvedRouteJson!) as { legs: { phase: string; provider: string; model: string }[] };
  const was = JSON.parse(sealedBefore.approvedRouteJson!) as { legs: { phase: string; provider: string; model: string }[] };
  // Only the builder (and its repair twin) moved; the planner and reviewer are as sealed.
  for (const phase of ["plan", "review"]) expect(sealed.legs.find(one => one.phase === phase)).toMatchObject({ provider: was.legs.find(one => one.phase === phase)!.provider, model: was.legs.find(one => one.phase === phase)!.model });
  expect(sealed.legs.find(one => one.phase === "build")).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
  expect(scope.approvedProfile).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
  const steps = await mac.steps("mo3");
  expect(steps.approval).toMatchObject({ by: "alex" });
  expect(steps.cards?.find(card => card.key === "approve")?.needsYou ?? false).toBe(false);
  expect(macSection((await rowOf("mo3"))!.status)).toBe("Queued");
  expect(ledgerOf(world, "mo3", LOCAL_AGENT_CHANGE_ACTION).map(row => row.detail)).toEqual([{ v: 1, phase: "build",
    from: { provider: "claude", model: "sonnet" }, to: { provider: "claude", model: "claude-opus-5-5" }, sealed: scope.digest, act: "change-task-agents", how: "now", via: "browser" }]);
  // The yes was proved as this computer's owner, for exactly the new digest.
  expect(world.store.handle.prepare("SELECT outcome FROM action_ledger WHERE task_id = 'mo3' AND action = 'approval proved' AND detail LIKE ?").all(`%${scope.digest}%`)).toEqual([{ outcome: "local-owner" }]);
});

test("MO3: a model setup that changed since the approval leaves the task waiting for a yes, in the plan's words", async () => {
  opusConfigured(world);
  placed(world, "mo3-drift");
  // The planner's default moved after the approval: a pick would carry more than the builder.
  world.store.setPhaseConfig("installation", "plan", "claude", "claude-haiku-4-5", "test", now());
  try {
    expect(await pick(mac, "mo3-drift", "build", OPUS)).toEqual({ done: `The builder is now Claude claude-opus-5-5. ${AGENTS_DRIFTED}` });
    const scope = world.store.getScope("mo3-drift")!;
    expect(scope.approvedDigest).not.toBe(scope.digest);
    expect((await mac.steps("mo3-drift")).cards?.find(card => card.key === "approve")).toMatchObject({ needsYou: true });
    expect(macSection((await rowOf("mo3-drift"))!.status)).toBe("Needs you");
  } finally {
    world.store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", now());
  }
});

test("MO3: a planner change on an approved task with a drafted plan asks for a new plan and waits for its yes", async () => {
  opusConfigured(world);
  const ref = placed(world, "mo3-plan");
  world.store.handle.prepare("UPDATE task_ref SET plan = 'drafted' WHERE id = ?").run(ref);
  expect(await pick(mac, "mo3-plan", "plan", OPUS)).toEqual({ done: "The planner is now Claude claude-opus-5-5. A new plan is coming; approve it when it's ready." });
  expect(world.store.lookupRef("mo3-plan")).toMatchObject({ plan: "requested" });
  const scope = world.store.getScope("mo3-plan")!;
  expect(scope.approvedDigest).not.toBe(scope.digest);
});

test("MO4: while a run holds the task, apply-now is refused in exactly these words and nothing changes", async () => {
  opusConfigured(world);
  building(world, placed(world, "mo4"));
  const before = (await mac.steps("mo4")).models;
  expect(await pick(mac, "mo4", "build", OPUS)).toEqual({ refused: TASK_RUNNING_NOW });
  expect(await pick(mac, "mo4", "build", OPUS, "now")).toEqual({ refused: TASK_RUNNING_NOW });
  expect(TASK_RUNNING_NOW).toBe("This task is running right now.");
  expect((await mac.steps("mo4")).models).toEqual(before);
  expect((await mac.steps("mo4")).pendingAgentChange).toBeNull();
});

test("MO4: next run — the pick waits while the run holds the task, then applies as the owner when the run ends, still approved", async () => {
  opusConfigured(world);
  const build = building(world, placed(world, "mo4-next"));
  const before = (await mac.steps("mo4-next")).models;
  expect(await pick(mac, "mo4-next", "build", OPUS, "next-run")).toEqual({ done: "Switches to Claude claude-opus-5-5 when this run ends." });
  const waiting = await mac.steps("mo4-next");
  expect(waiting.models).toEqual(before);
  expect(waiting.pendingAgentChange).toMatchObject({ phase: "build", provider: "claude", model: "claude-opus-5-5", when: "next-run", by: "alex", problem: null });
  // Still running: the worker's pass leaves it waiting.
  expect(applyPendingAgentChanges(world.store, now())).toBe(0);
  endRun(world, build, "failed");
  expect(applyPendingAgentChanges(world.store, now())).toBe(1);
  const after = await mac.steps("mo4-next");
  expect(after.pendingAgentChange).toBeNull();
  expect(after.models?.find(one => one.phase === "build")).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
  const scope = world.store.getScope("mo4-next")!;
  expect(scope.approvedDigest).toBe(scope.digest);
  expect(ledgerOf(world, "mo4-next", LOCAL_AGENT_CHANGE_ACTION).map(row => [row["outcome"], row.detail["how"]])).toEqual([["resealed", "next-run"]]);
});

test("MO4: restart — the run is asked to stop, the pick applies once it has stopped, and the task dispatches again", async () => {
  opusConfigured(world);
  const ref = placed(world, "mo4-restart");
  const build = building(world, ref);
  expect(await pick(mac, "mo4-restart", "build", OPUS, "restart")).toEqual({ done: "Stopping the run; it starts again on Claude claude-opus-5-5." });
  expect(world.store.stopOf(build.run)).not.toBeNull();
  expect(world.store.activeHolds(ref, now()).map(one => one.ownerKind)).toContain("stop");
  expect((await mac.steps("mo4-restart")).pendingAgentChange).toMatchObject({ when: "restart", problem: null });
  // The worker seals the stopped attempt; until then nothing applies.
  expect(applyPendingAgentChanges(world.store, now())).toBe(0);
  expect(finalize(world.store, build.lease, { kind: "interrupted", runId: build.run, taskId: "mo4-restart", stopRun: build.run, now: now() })).toMatchObject({ ok: true });
  if (world.store.stopOf(build.run)?.settledAt == null) world.store.settleRunStop(build.run, "interrupted", now());
  expect(applyPendingAgentChanges(world.store, now())).toBe(1);
  expect(world.store.stopOf(build.run)?.resumedAt).not.toBeNull();
  expect(world.store.activeHolds(ref, now()).map(one => one.ownerKind)).not.toContain("stop");
  const scope = world.store.getScope("mo4-restart")!;
  expect(scope.approvedDigest).toBe(scope.digest);
  expect(JSON.parse(scope.approvedRouteJson!).legs.find((one: { phase: string }) => one.phase === "build")).toMatchObject({ model: "claude-opus-5-5" });
  // It can be claimed again: the next run is on the new builder.
  const again = acquire(world.store, ref, "mac-runner", { token: "tok-mac-runner", now: now(), ttlMs: 3_600_000 });
  expect(again).toMatchObject({ ok: true });
  if (again.ok) release(world.store, again.claim.leaseId, now());
});

test("MO4: a pending pick that can't apply when its run ends keeps its words in the steps read (and a restart keeps the run's stop)", async () => {
  opusConfigured(world);
  const nextRef = placed(world, "mo4-problem");
  const next = building(world, nextRef);
  expect(await pick(mac, "mo4-problem", "build", OPUS, "next-run")).toHaveProperty("done");
  // The plan changed under the run (its words were edited): the pick was made against another plan.
  propose(world.store, { taskId: "mo4-problem", goal: "Fix mo4-problem, differently", now: now() });
  endRun(world, next, "failed");
  expect(applyPendingAgentChanges(world.store, now())).toBe(0);
  expect((await mac.steps("mo4-problem")).pendingAgentChange).toMatchObject({ problem: AGENTS_PICK_AGAIN });
  expect(world.store.getScope("mo4-problem")!.digest).not.toBe("");
  // A later pass doesn't try it again; a newer pick replaces it.
  expect(applyPendingAgentChanges(world.store, now())).toBe(0);

  const stopRef = placed(world, "mo4-problem-restart");
  const stopped = building(world, stopRef);
  expect(await pick(mac, "mo4-problem-restart", "build", OPUS, "restart")).toHaveProperty("done");
  propose(world.store, { taskId: "mo4-problem-restart", goal: "Fix it, differently", now: now() });
  expect(finalize(world.store, stopped.lease, { kind: "interrupted", runId: stopped.run, taskId: "mo4-problem-restart", stopRun: stopped.run, now: now() })).toMatchObject({ ok: true });
  if (world.store.stopOf(stopped.run)?.settledAt == null) world.store.settleRunStop(stopped.run, "interrupted", now());
  expect(applyPendingAgentChanges(world.store, now())).toBe(0);
  expect((await mac.steps("mo4-problem-restart")).pendingAgentChange).toMatchObject({ when: "restart", problem: AGENTS_PICK_AGAIN });
  expect(world.store.stopOf(stopped.run)?.resumedAt ?? null).toBeNull();
  expect(world.store.activeHolds(stopRef, now()).map(one => one.ownerKind)).toContain("stop");
});

/** A laptop whose owner set a password, read by the app's local session, and the same person signed in with that password
 * (a full session): `route` is POST /t/<id>/route as a browser page sends it. */
async function passwordWorld() {
  const w = await openLocalWorld({ browserKey: true });
  register(w.store, { name: "mac-runner", host: "here", capacity: 4, repos: [w.repo], now: now(), newToken: () => "tok-mac-runner" });
  opusConfigured(w);
  const first = await connect(w);
  proposed(w, "pw-first");
  const beforePassword = await pick(first, "pw-first", "build", OPUS);
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

test("MO1–MO4, server side: the local owner's road needs no password, before or after one is set; a password session keeps today's edit", async () => {
  const { w, local, route, beforePassword } = await passwordWorld();
  try {
    expect(beforePassword).toEqual({ done: "The builder is now Claude claude-opus-5-5." });
    expect(await pick(local, "pw-first", "plan", OPUS)).toEqual({ done: "The planner is now Claude claude-opus-5-5." });
    // The password session: today's edit, unchanged (no sawDigest needed, review still its own refusal, approvals staled).
    for (const phase of ["plan", "build", "review"]) w.store.setPhaseTierConfig("installation", phase, "strong", "claude", "claude-opus-5-5", "test", now());
    placed(w, "pw-mo3");
    expect(((await route("pw-mo3", "build", OPUS)) as { done?: string }).done ?? "").toMatch(/approve it again/);
    expect((await local.steps("pw-mo3")).cards?.find(card => card.key === "approve")).toMatchObject({ needsYou: true });
    building(w, placed(w, "pw-mo4"));
    const held = (await local.steps("pw-mo4")).models;
    const refused = await route("pw-mo4", "build", OPUS);
    expect(refused).toHaveProperty("refused");
    expect((await local.steps("pw-mo4")).models).toEqual(held);
    expect((await local.steps("pw-mo4")).pendingAgentChange).toBeNull();
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
