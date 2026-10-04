/**
 * The console server: task pages — the portfolio, queue, task detail,
 * live peek, tournament comparison and phase route.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { acquire, release } from "./claim.js";
import { register, hashToken } from "./runner.js";
import { addApprover, approvalOf, approve, propose } from "./scope.js";
import { planTournament, admitContest, finalizeContestant } from "./contest.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { createDecisionServer, SENSITIVE_INPUT } from "./serve.js";
import { routeOfTask } from "./agentconfig.js";
import { projectRoute } from "./phase-routing.js";
import { Window } from "happy-dom";
import { presented, T0, stylesOf, renderedHtmlOf, workspaceOf } from "../test/serve-kit.js";
import { diagnoseTaskDispatch } from "./dispatch.js";
import { createDemoSandbox } from "./demo.js";

describe("stage 5 — the tournament comparison screen and the pick ceremony, over real HTTP", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let contestId: number;
  let winnerId: number;
  let taskRef: number;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-contest-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    // A two-agent tournament, raced to pick-wait: one committed winner with
    // verified evidence, one that finished without committing.
    store.createTask({ id: "race-w", title: "raced on the web" }, T0);
    taskRef = store.refFor("built-in", "race-w", "ours").id;
    const planned = planTournament({
      agents: [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "claude", model: "claude-haiku-4-5" }],
      perAgentBudgetUsd: 5,
      totalBudgetUsd: 20,
    });
    if (!planned.ok) throw new Error(planned.reason);
    const termsId = store.fileTournamentTerms(
      {
        taskRef,
        raceDigest: planned.plan.raceDigest,
        agents: planned.plan.agents,
        perAgentBudgetMicrousd: planned.plan.perAgentBudgetMicrousd,
        overrunReserveMicrousd: planned.plan.overrunReserveMicrousd,
        totalBudgetMicrousd: planned.plan.totalBudgetMicrousd,
        priceVersion: planned.plan.priceVersion,
        publicationPolicy: "none",
      },
      T0,
    );
    store.approveTournamentTerms(termsId, "alex", planned.plan.raceDigest, T0);
    // The runner gate (MCP spec v6): registered, repo-bound, token-proved.
    store.placeTask(taskRef, "/repo/main");
    register(store, { name: "night-shift-1", host: "here", capacity: 8, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-1" });
    const taken = acquire(store, taskRef, "night-shift-1", { token: "tok-night-shift-1", now: T0, ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim");
    const admitted = admitContest(
      store,
      {
        taskId: "race-w", taskRef, runner: "night-shift-1", leaseId: taken.claim.leaseId,
        incarnation: null, scopeDigest: "scope-d", scopeApproved: true, capacity: 8, quotaBlocked: () => null,
      } as never,
      T0,
    );
    if (!admitted.ok) throw new Error(admitted.reason);
    contestId = admitted.contestId;
    store.stampContestDispatch(contestId, "base-sha-000", null);
    const contest = store.getContest(contestId);
    if (contest === null) throw new Error("contest");
    for (const agent of store.contestants(contestId)) store.casContestantState(agent.id, ["pending"], "ready", agent.generation);
    store.casContestState(contestId, ["dispatching"], "racing", contest.generation);
    for (const agent of store.contestants(contestId)) store.casContestantState(agent.id, ["ready"], "building", agent.generation);

    const [first, second] = store.contestants(contestId);
    if (first === undefined || second === undefined) throw new Error("agents");
    winnerId = first.id;
    const conclude = (agent: typeof first, committed: boolean, head: string, slot: number | null) => {
      const lane = store.admitContestLane({
        taskRef, leaseId: taken.claim.leaseId, runner: "night-shift-1", incarnation: null,
        branch: agent.branch, worktree: `/pool/${agent.id}`, contestant: agent.id, route: store.laneAuthorityFor(agent.id)!, now: T0,
      });
      if (!lane.ok) throw new Error(lane.problem);
      const runId = lane.runId;
      storeEvidence(store, evidenceRoot, runId, "terminal-diff", "terminal-diff.patch",
        Buffer.from("diff --git a/x b/x\n+raced\n", "utf8"), "git diff (exit 0)", T0, { captureStatus: "ok" });
      storeEvidence(store, evidenceRoot, runId, "diff-stat", "terminal-diff-stat.json",
        Buffer.from(JSON.stringify({ base: "base-sha-000", head, fileCount: 1, additions: 1, deletions: 0, binaryCount: 0, filesTruncated: false, files: [{ path: "x", additions: 1, deletions: 0 }] }), "utf8"),
        "git diff --numstat (exit 0)", T0, { captureStatus: "ok" });
      store.recordOutcomeFacts(runId, { headRevision: head, handoff: "swapped the guard" });
      store.finishRun(runId, { outcome: "built", committed, now: T0 });
      finalizeContestant(store, { contestId, contestantId: agent.id, runId, outcome: "built", measuredMicrousd: 500_000, slotId: slot } as never, T0);
      return runId;
    };
    conclude(first, true, "head-aaa", admitted.slotIds[0] ?? null);
    conclude(second, false, "head-bbb", admitted.slotIds[1] ?? null);
    if (store.getContest(contestId)?.state !== "pick-wait") throw new Error("not pick-wait");

    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date() });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the review cockpit offers the comparison road for a task whose result run raced (Priority 5)", async () => {
    store.setTaskState("race-w", "done", T0);
    const cookie = await login();
    const cockpit = await (await fetch(url("/review?result=race-w"), { headers: { cookie } })).text();
    expect(cockpit).toContain('data-review-task="race-w"');
    // The tournament waits for a pick: that is the one primary act, and it
    // goes to the existing comparison screen — the cockpit picks nothing.
    expect(cockpit).toContain('data-next-action="compare-contest"');
    expect(cockpit).toContain(`<a class="button-link" href="/contest/${contestId}">Compare results</a>`);
    expect(cockpit).toContain(`<a href="/contest/${contestId}">compare the tournament and pick →</a>`);
    expect(cockpit).not.toContain("Pick this result");
    expect(cockpit).not.toContain('name="nonce"');
  });

  test("the whole ceremony: compare → arm (POST mints) → password → picked; a GET never mints and a replay refuses", async () => {
    const cookie = await login();

    // The comparison screen: plain words, both agents, the refusal named.
    const compare = await (await fetch(url(`/contest/${contestId}`), { headers: { cookie } })).text();
    expect(compare).toContain("tournament");
    expect(compare).toContain("Agent 1");
    expect(compare).toContain("Agent 2");
    expect(compare).toContain("Cannot be picked — finished without committing");
    expect(compare).toContain("Pick this result");
    // The GET minted nothing: no nonce field anywhere on it.
    expect(compare).not.toContain('name="nonce"');

    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(compare)?.[1];
    if (csrf === undefined) throw new Error("no csrf on the page");

    // Arm: the POST mints the nonce and answers with the confirmation form.
    const armed = await fetch(url(`/contest/${contestId}/arm`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, choice: String(winnerId) }),
    });
    expect(armed.status).toBe(200);
    const ceremony = await armed.text();
    expect(ceremony).toContain("Pick agent 1");
    expect(ceremony).toContain("$0.50"); // the money, restated in dollars
    expect(ceremony).toContain("Nothing is published"); // no grant on this repo
    const nonce = /name="nonce" value="([A-Za-z0-9_-]+)"/.exec(ceremony)?.[1];
    if (nonce === undefined) throw new Error("no nonce in the ceremony form");

    // A wrong password decides nothing.
    const wrong = await fetch(url(`/contest/${contestId}/pick`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, choice: String(winnerId), nonce, token: "not-the-password" }),
    });
    expect(wrong.status).toBe(403);
    expect(store.getContest(contestId)?.state).toBe("pick-wait");

    // The real yes.
    const picked = await fetch(url(`/contest/${contestId}/pick`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, choice: String(winnerId), nonce, token: approverToken }),
      redirect: "manual",
    });
    expect(picked.status).toBe(303);
    expect(store.getContest(contestId)?.state).toBe("picked");
    expect(store.getContest(contestId)?.winnerContestant).toBe(winnerId);
    expect(store.getTask("race-w")?.state).toBe("done");
    expect(store.activeHolds(taskRef, T0)).toHaveLength(0);

    // Replay of the same ceremony refuses — the nonce died with the pick.
    const replay = await fetch(url(`/contest/${contestId}/pick`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, choice: String(winnerId), nonce, token: approverToken }),
    });
    expect(replay.status).toBe(409);

    // The screen now states the decision.
    const after = await (await fetch(url(`/contest/${contestId}`), { headers: { cookie } })).text();
    expect(after).toContain("Picked by alex");
    expect(after).not.toContain("Pick this result");
  });

  test("the comparison reads at a glance (arc 6): one table column per agent, cards side by side, same facts", async () => {
    const cookie = await login();
    const html = await (await fetch(url(`/contest/${contestId}`), { headers: { cookie } })).text();
    expect(html).toContain('class="contest-glance"');
    expect(html).toContain('class="contest-compare"');
    // the table and the cards derive from ONE summary — the same diff words
    expect(html).toContain("1 file(s) · +1 −0");
    expect((html.match(/Agent [0-9]/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // ceremonies untouched: the arm form still points at the same act
    expect(html).toContain(`/contest/${contestId}/arm`);
  });

  test("abandon: armed by POST, confirmed by password — the task fails requeueably and everything is kept", async () => {
    const cookie = await login();
    const compare = await (await fetch(url(`/contest/${contestId}`), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(compare)?.[1];
    if (csrf === undefined) throw new Error("no csrf");
    const armed = await fetch(url(`/contest/${contestId}/arm`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, act: "abandon" }),
    });
    const ceremony = await armed.text();
    expect(ceremony).toContain("Abandon this tournament?");
    expect(ceremony).toContain("marked <strong>failed</strong>");
    const nonce = /name="nonce" value="([A-Za-z0-9_-]+)"/.exec(ceremony)?.[1];
    if (nonce === undefined) throw new Error("no nonce");
    const gone = await fetch(url(`/contest/${contestId}/abandon`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, nonce, token: approverToken }),
      redirect: "manual",
    });
    expect(gone.status).toBe(303);
    expect(store.getContest(contestId)?.state).toBe("abandoned");
    expect(store.getTask("race-w")?.state).toBe("failed");
    expect(store.runsFor(taskRef).length).toBe(2); // nothing deleted
  });
});

describe("A2 — the live peek over real HTTP: guards, fence, and the names-only fragment", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let poolRoot: string;
  let worktree: string;
  let approverToken: string;
  let runId: number;

  const url = (path: string) => `${base}${path}`;
  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    const { gitBlobSha1, encodeBaseTreeSnapshot } = await import("./peek.js");
    const { storeEvidence } = await import("./evidence.js");
    const { mkdirSync } = await import("node:fs");
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = realpathSync(mkdtempSync(join(tmpdir(), "peek-serve-ev-")));
    poolRoot = realpathSync(mkdtempSync(join(tmpdir(), "peek-serve-pool-")));
    worktree = join(poolRoot, "wt-1");
    mkdirSync(worktree);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    approverToken = added.token;

    // The claiming runner carries a real credential and the repo binding the
    // runner gate proves (MCP spec v6).
    store.saveRunner(
      { name: "night-shift-1", host: "here", capacity: 4, capacityMode: "tasks", repos: ["/repos/thing"], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null },
      hashToken("tok-night-shift-1"),
    );
    store.saveRunner(
      { name: "other-machine", host: "there", capacity: 4, capacityMode: "tasks", repos: [], agents: [], registeredAt: T0.toISOString(), heartbeatAt: T0.toISOString(), retiredAt: null },
      "hash2",
    );
    store.createTask({ id: "peek-1", title: "watched work" }, T0);
    const taskRef = store.refFor("built-in", "peek-1", "ours").id;
    store.placeTask(taskRef, "/repos/thing");
    const taken = acquire(store, taskRef, "night-shift-1", { token: "tok-night-shift-1", now: new Date(), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim");
    runId = store.startRun({
      taskRef,
      leaseId: taken.claim.leaseId,
      runner: "night-shift-1",
      branch: "standing-orders/peek-1",
      worktree,
      now: T0,
      ...presented(store, taskRef, "builder"),
    });
    const baseSha = "b".repeat(40);
    store.stampRun(runId, { baseRevision: baseSha });
    store.saveWorktree({
      path: worktree,
      repo: "/repos/thing",
      branch: "standing-orders/peek-1",
      runner: "night-shift-1",
      taskRef,
      createdAt: T0.toISOString(),
      leasedAt: T0.toISOString(),
      releasedAt: null,
      verified: true,
      leaseEpoch: "epoch-one",
    });

    // The frozen base: one tracked file. On disk: that file edited, plus a
    // brand-new one — the fragment must say so in names only.
    const original = Buffer.from("export const answer = 41\n");
    writeFileSync(join(worktree, "app.ts"), Buffer.from("export const answer = 42\n"));
    writeFileSync(join(worktree, "notes.md"), Buffer.from("scratch\n"));
    const snapshot = encodeBaseTreeSnapshot({
      repo: "/repos/thing",
      run: runId,
      base: baseSha,
      entries: [{ path: "app.ts", mode: "100644", sha: gitBlobSha1(original), size: original.length }],
    });
    storeEvidence(store, evidenceRoot, runId, "base-tree", "base-tree.json", Buffer.from(snapshot), "git ls-tree (exit 0)", T0, {
      captureStatus: "ok",
    });

    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => new Date(),
      localRunner: "night-shift-1",
      poolRoot,
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
    rmSync(poolRoot, { recursive: true, force: true });
  });

  test("names and counts render; content never does; a session is required", async () => {
    const bare = await fetch(url(`/r/${runId}?fragment=peek`), { redirect: "manual" });
    expect([303, 403]).toContain(bare.status); // no session, no peek
    const cookie = await login();
    const peeked = await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } });
    expect(peeked.status).toBe(200);
    expect(peeked.headers.get("cache-control")).toBe("no-store");
    const body = await peeked.text();
    expect(body).toContain("Best-effort look");
    expect(body).toContain("app.ts");
    expect(body).toContain("notes.md");
    // Names only — never the bytes that changed.
    expect(body).not.toContain("answer = 42");
    // The run page itself carries the region and its poller.
    const page = await (await fetch(url(`/r/${runId}`), { headers: { cookie } })).text();
    expect(page).toContain("What is changing right now");
    expect(page).toContain('id="run-peek"');
  });

  test("the fence and the guards: epoch rotation invalidates the cached look; a finished run and a foreign machine refuse", async () => {
    const cookie = await login();
    const first = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(first).toContain("app.ts");
    // A successor occupant: file changes AND the epoch rotates. The cached
    // fragment is keyed to the dead epoch — the next look is fresh.
    writeFileSync(join(worktree, "second.ts"), "occupant two\n");
    const row = store.getWorktree(worktree);
    if (row === null) throw new Error("row");
    store.saveWorktree({ ...row, leaseEpoch: "epoch-two" });
    const second = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(second).toContain("second.ts");
    // A missing epoch (adoption path) refuses rather than guessing.
    store.saveWorktree({ ...row, leaseEpoch: null });
    const unfenced = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(unfenced).toContain("before live watching existed");
    store.saveWorktree({ ...row, leaseEpoch: "epoch-three" });
    // Another machine's build says where to look instead.
    store.saveWorktree({ ...row, leaseEpoch: "epoch-three", runner: "other-machine" });
    const foreign = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(foreign).toContain("another machine");
    store.saveWorktree({ ...row, leaseEpoch: "epoch-three", runner: "night-shift-1" });
    // A finished run points at the record, not the tree.
    store.finishRun(runId, { outcome: "built", committed: true, now: new Date() });
    const done = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(done).toContain("finished");
    expect(done).toContain("data-region-stop");
  });

  test("a released lease is superseded forever: the peek refuses finally, and the region poller stops", async () => {
    // liveClaimByLease alone would still admit a superseded lease
    // (round-4 finding 15) — the guard must prove the run's lease IS the
    // task's current live claim, and say so with the stop marker, because
    // superseded never heals.
    const cookie = await login();
    const running = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(running).toContain("app.ts");

    const leaseId = store.getRun(runId)?.leaseId;
    if (leaseId === undefined) throw new Error("run");
    release(store, leaseId, new Date());

    const gone = await (await fetch(url(`/r/${runId}?fragment=peek`), { headers: { cookie } })).text();
    expect(gone).toContain("not actively running");
    expect(gone).toContain("data-region-stop");
  });

  test("the transcript window: session-only JSON, byte offsets, replaced on shrink, final drain (arc 1)", async () => {
    const { openLiveLog } = await import("./live.js");
    const bare = await fetch(url(`/r/${runId}?fragment=transcript&from=0`), { redirect: "manual" });
    expect([303, 403]).toContain(bare.status);
    const cookie = await login();

    // No file yet: an empty window, not an error — the view has not started.
    const empty = await fetch(url(`/r/${runId}?fragment=transcript&from=0`), { headers: { cookie } });
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(await empty.json()).toMatchObject({ text: "", nextOffset: 0, final: false });

    const log = openLiveLog(evidenceRoot, runId);
    log?.observe({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hello operator" }] } });
    log?.close();

    const first = await (await fetch(url(`/r/${runId}?fragment=transcript&from=0`), { headers: { cookie } })).json() as { text: string; nextOffset: number; final: boolean };
    expect(first.text).toBe("hello operator\n");
    expect(first.final).toBe(false); // the run is still live
    const again = await (await fetch(url(`/r/${runId}?fragment=transcript&from=${first.nextOffset}`), { headers: { cookie } })).json();
    expect(again).toMatchObject({ text: "", nextOffset: first.nextOffset });

    // An offset past the file is `replaced` — the client restarts visibly.
    const shrunk = await fetch(url(`/r/${runId}?fragment=transcript&from=99999`), { headers: { cookie } });
    expect(shrunk.status).toBe(409);
    expect(await shrunk.json()).toMatchObject({ error: "replaced" });
    // A malformed offset refuses outright.
    expect((await fetch(url(`/r/${runId}?fragment=transcript&from=-1`), { headers: { cookie } })).status).toBe(400);

    // Finalize the run: the drain returns the tail and says final.
    store.finishRun(runId, { outcome: "built", reason: null, now: new Date() });
    const drained = await (await fetch(url(`/r/${runId}?fragment=transcript&from=0`), { headers: { cookie } })).json() as { final: boolean; text: string };
    expect(drained.text).toBe("hello operator\n");
    expect(drained.final).toBe(true);
  });

  test("steering: a browser session files a note; the task page shows its state (arc 1)", async () => {
    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/peek-1"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(taskHtml)?.[1] ?? "";
    expect(csrf).not.toBe("");
    expect(taskHtml).toContain("guidance for the next attempt");

    const posted = await fetch(url("/t/peek-1/steer"), {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "look at the retry path first" }).toString(),
    });
    expect(posted.status).toBe(303);
    const after = await (await fetch(url("/t/peek-1"), { headers: { cookie } })).text();
    expect(after).toContain("look at the retry path first");
    expect(after).toContain("waiting for the next attempt");

    // Without a session cookie, steering does not exist as a surface.
    const bare = await fetch(url("/t/peek-1/steer"), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ note: "no session" }).toString(),
    });
    expect([303, 401, 403]).toContain(bare.status);
    expect(store.listSteerNotes(store.refFor("built-in", "peek-1", "ours").id).length).toBe(1);
  });

  test("the install assets serve pre-auth with their disciplines; sw.js has no fetch handler (arc 3)", async () => {
    const manifest = await fetch(url("/manifest.webmanifest"));
    expect(manifest.status).toBe(200);
    const parsed = (await manifest.json()) as Record<string, unknown>;
    expect(parsed["display"]).toBe("standalone");
    expect(parsed["scope"]).toBe("/");
    const worker = await fetch(url("/sw.js"));
    expect(worker.status).toBe(200);
    expect(worker.headers.get("x-content-type-options")).toBe("nosniff");
    expect(worker.headers.get("cache-control")).toBe("no-store");
    expect(worker.headers.get("content-security-policy")).toBe("default-src 'none'");
    const body = await worker.text();
    expect(body).toContain("notificationclick");
    expect(body).not.toContain('addEventListener("fetch"');
    expect((await fetch(url("/icon-192.png"))).status).toBe(200);
    expect((await fetch(url("/apple-touch-icon.png"))).status).toBe(200);
  });

  test("the typefaces serve pre-auth as woff2, exact names only, and the page CSP admits them", async () => {
    const font = await fetch(url("/fonts/geist-sans-400.woff2"));
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("x-content-type-options")).toBe("nosniff");
    expect(font.headers.get("cache-control")).toBe("public, max-age=3600");
    const bytes = Buffer.from(await font.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect((await fetch(url("/fonts/geist-mono-600.woff2"))).status).toBe(200);
    // Unknown names fall through to the ordinary unauthenticated refusal —
    // a redirect to sign-in, never a read and never a server error.
    expect((await fetch(url("/fonts/other.woff2"), { redirect: "manual" })).status).toBe(303);
    const login = await fetch(url("/login"));
    expect(login.headers.get("content-security-policy")).toContain("font-src 'self'");
    // Every routed face is also declared: a served-but-undeclared weight
    // would silently synthesize.
    const html = await login.text();
    const css = await stylesOf(html, base);
    for (const face of ["geist-sans-400", "geist-sans-500", "geist-sans-600", "geist-mono-400", "geist-mono-500", "geist-mono-600"]) {
      expect(css).toContain(`/fonts/${face}.woff2`);
    }
  });

  test("push enrollment is a password ceremony and validates the endpoint (arc 3)", async () => {
    const cookie = await login();
    // This suite's server has no telegram file, so /settings is off — any
    // authenticated page carries the same session csrf.
    const taskHtml = await (await fetch(url("/t/peek-1"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(taskHtml)?.[1] ?? "";
    const post = (body: Record<string, string>) =>
      fetch(url("/push/subscribe"), {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      });
    // No password: refused with words, nothing enrolled.
    const bare = await post({ csrf, endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "x", auth: "y" });
    expect(bare.status).toBe(303);
    expect(bare.headers.get("location")).toContain("password");
    // Password + a NON-allow-listed endpoint: refused.
    const evil = await post({ csrf, token: approverToken, endpoint: "https://evil.example.com/x", p256dh: "x", auth: "y" });
    expect(evil.headers.get("location")).toContain("push%20service");
    expect(store.listPushSubscriptions().length).toBe(0);
  });
});

describe("the portfolio and the scope bar (portfolio arc, slice 1a)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const boot = async (options: Record<string, unknown> = {}) => {
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), ...options });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  const seedTaskIn = (id: string, title: string, repo: string): number => {
    store.createTask({ id, title }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, repo);
    return ref;
  };

  /** A parked decision with one reversible and one irreversible option. */
  const seedDecisionIn = (id: string, repo: string, question: string): number => {
    const ref = seedTaskIn(id, `decide ${id}`, repo);
    const run = store.startRun({
      taskRef: ref, leaseId: `lease-${id}`, runner: "b1",
      branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: T0,
      ...presented(store, ref, "builder"),
    });
    return store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: `why ${id} stopped`,
        question,
        options: [
          { id: "keep", label: "Keep and backfill", consequence: "reversible cleanup later", reversible: true },
          { id: "drop", label: "Drop it", consequence: "it does not come back", reversible: false },
        ],
        recommendation: "keep",
      },
      T0,
    );
  };

  /** A terminal run inside the 24h window; measured only when cost is given. */
  const seedRunIn = (
    id: string, title: string, repo: string, outcome: "built" | "failed",
    costUsd: number | null, tokens?: { tokensIn: number; tokensOut: number },
  ): number => {
    const ref = seedTaskIn(id, title, repo);
    const now = new Date();
    const run = store.startRun({
      taskRef: ref, leaseId: `lease-${id}`, runner: "b1", provider: "claude",
      branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now,
      ...presented(store, ref, "builder"),
    });
    store.stampProviderStart(run, now);
    if (costUsd !== null || tokens !== undefined) {
      store.recordUsage(run, {
        tokensIn: tokens?.tokensIn ?? 100, tokensOut: tokens?.tokensOut ?? 50,
        ...(costUsd === null ? {} : { costUsd }),
      });
    }
    store.finishRun(run, { outcome, ...(outcome === "failed" ? { reason: "agent" } : {}), now: new Date() });
    return run;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-portfolio-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  const scopeBarOf = (html: string): string => {
    // The bar runs from its opening tag to the page body (main, or the
    // split of a master-detail page) — it nests the switcher's own divs.
    const start = html.indexOf('<div class="scope-bar">');
    if (start < 0) throw new Error("no scope bar on the page");
    const ends = [html.indexOf("<main>", start), html.indexOf('<div class="split">', start)].filter(one => one > start);
    return html.slice(start, Math.min(...ends));
  };

  test("the scope bar states each surface's scope: portfolio all-project, queue project-bound", async () => {
    await boot({ repo: "/repo/main" });
    const cookie = await login();

    // The open project's inbox: the bar names the project, with the switch road.
    const home = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    const homeBar = scopeBarOf(home);
    // The bar's NAME is the summary of the switcher (board pass); the menu
    // beneath lists every project and "all projects" as plain POST forms.
    expect(homeBar).toContain('<details class="switcher"><summary class="name">main<svg');
    // The pill IS the switcher (reduction pass §1): no second road beside it.
    expect(homeBar).not.toContain("switch project");
    expect(homeBar).toContain('<form method="post" action="/projects/open">');

    // The portfolio is all-project even while a project is open.
    const portfolio = await (await fetch(url("/workbench"), { headers: { cookie } })).text();
    expect(scopeBarOf(portfolio)).toContain('<summary class="name">All projects<svg');
    expect(portfolio).toContain("<h1>Portfolio</h1>");

    // The queue stays project-bound.
    const queue = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    const queueBar = scopeBarOf(queue);
    expect(queueBar).toContain('<summary class="name">main<svg');

    // One visible /projects link per surface (portfolio arc §1, amended by
    // the mobile pass, the reduction pass, then workspace package 1): the
    // rail's projects row on desktop, "manage projects" inside the phone's
    // project switcher, and the phone's Projects tab. Exactly those three.
    expect(home).toContain('<details class="project-pill switcher"><summary><span class="name">main<svg');
    expect(home).toContain('<span class="pill-status">');
    expect((home.match(/href="\/projects"/g) ?? []).length).toBe(3);

    // The rail (workspace package 1): Chat · Tasks · Projects, then the
    // work-tools group where the portfolio lives — order, not mere presence.
    expect(home).toContain(">Portfolio<");
    expect(home.indexOf(">Chat<")).toBeLessThan(home.indexOf(">Tasks<"));
    expect(home.indexOf(">Tasks<")).toBeLessThan(home.indexOf(">Projects<"));
    expect(home.indexOf('<nav class="nav-groups">')).toBeLessThan(home.indexOf(">Portfolio<"));

    // Fleet and the rolled-up board are all-project; the scoped board is not.
    const fleet = await (await fetch(url("/fleet"), { headers: { cookie } })).text();
    expect(scopeBarOf(fleet)).toContain("All projects");
    const board = await (await fetch(url("/board"), { headers: { cookie } })).text();
    expect(scopeBarOf(board)).toContain('<summary class="name">main<svg');
    const boardAll = await (await fetch(url("/board?scope=all"), { headers: { cookie } })).text();
    expect(scopeBarOf(boardAll)).toContain('<summary class="name">All projects<svg');
  });

  test("portfolio hygiene: a hidden project leaks into no row, count, dollar, token, or claim; fictions stay out", async () => {
    seedDecisionIn("d-main", "/repo/main", "Answer the admitted question?");
    seedDecisionIn("d-secret", "/repo/secret", "SECRET-DECIDE never renders");
    const mainRun = seedRunIn("r-main", "admitted build", "/repo/main", "built", 1.23);
    // Token usage WITHOUT cost: the tokens row must still count it
    // (commit-1 review, finding 2 — spendLine's mixed branch omits tokens).
    seedRunIn("r-side", "side build", "/repo/side", "failed", null, { tokensIn: 7_000, tokensOut: 700 });
    seedRunIn("r-secret", "SECRET-RUN title", "/repo/secret", "built", 77.77, { tokensIn: 999_000, tokensOut: 999 });
    // A stored PR URL is a URL sink: only a verified github pull URL earns
    // an anchor (commit-1 review, finding 3).
    const mainRef = store.refFor("built-in", "r-main").id;
    const pub = store.createPublicationIntent({
      run: mainRun, taskRef: mainRef, githubRepo: "acme/payments", remote: "origin",
      base: "main", head: "standing-orders/r-main", headSha: "a".repeat(40), bodyHash: "b".repeat(64), draft: false,
    }, new Date());
    store.markPublicationPushed(pub, new Date());
    store.markPublicationOpened(pub, 13, "javascript:alert(1)", new Date());
    // A live claim in the hidden project: never a running row here.
    const secretLiveRef = seedTaskIn("t-sec-live", "SECRET-LIVE work", "/repo/secret");
    register(store, { name: "secret-runner", host: "h", capacity: 1, repos: ["/repo/secret"], now: T0, newToken: () => "tok-secret" });
    const taken = acquire(store, secretLiveRef, "secret-runner", { token: "tok-secret", now: new Date(), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("secret claim failed in setup");

    await boot({ repos: ["/repo/main", "/repo/side"] });
    const cookie = await login();
    const html = await (await fetch(url("/workbench"), { headers: { cookie } })).text();

    // Admitted rows render; the hidden project's rows and dollars do not.
    expect(html).toContain("Answer the admitted question?");
    expect(html).not.toContain("SECRET-DECIDE");
    expect(html).not.toContain("SECRET-RUN");
    expect(html).not.toContain("77.77");

    // The hidden live claim never renders as a running row.
    expect(html).not.toContain("secret-runner");
    expect(html).not.toContain("SECRET-LIVE");

    // The window rollup counts only visible runs, by the exhaustive
    // outcome vocabulary, with spendLine's own wording — and tokens stand
    // alone, counting the unmeasured invocation's reported usage.
    expect(html).toContain("runs started");
    expect(html).toContain("1 built · 1 failed");
    expect(html).toContain("invocation(s)");
    expect(html).toContain("$1.23");
    expect(html).toContain("unmeasured");
    expect(html).toContain(`>${(7_000 + 700 + 150).toLocaleString()}</span>`);

    // The corrupted PR URL renders as text — the number without navigation.
    expect(html).toContain("PR #13");
    expect(html).not.toContain("javascript:alert");

    // Deleted fictions never render.
    expect(html).not.toContain("Pause dispatch");
    expect(html).not.toContain("idle spend");

    // The decision card answers reversibly inline — real words, no letters,
    // no confirm field anywhere near it; the irreversible option is a link.
    expect(html).toContain("decide-inline");
    expect(html).toContain(">Keep and backfill</button>");
    expect(html).not.toContain('name="confirm"');
    expect(html).not.toContain('value="drop"');
    expect(html).toContain("Irreversible");
    expect(html).toContain(">Recommended</span>");

    // Rows wear project chips.
    expect(html).toContain("main</span>");
  });

  test("the roll-up inbox stays links-only; the selected-project inbox answers on the card", async () => {
    seedDecisionIn("d-one", "/repo/main", "Which way?");

    await boot({ repos: ["/repo/main", "/repo/side"] });
    const cookie = await login();

    // Projectless roll-up: the decision is a link, never a form.
    const rollup = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(rollup).toContain("Which way?");
    expect(rollup).not.toContain("decide-inline");
    expect(rollup).not.toMatch(/<form[^>]*\/answer/);
  });

  test("the legacy unscoped projectless inbox is links-only too — no chosen project, no forms", async () => {
    // Unplaced work in an unscoped installation (no ceiling configured).
    store.createTask({ id: "d-free", title: "decide free" }, T0);
    const ref = store.refFor("built-in", "d-free").id;
    const run = store.startRun({
      taskRef: ref, leaseId: "lease-free", runner: "b1",
      branch: "standing-orders/d-free", worktree: "/pool/d-free", now: T0,
      ...presented(store, ref, "builder"),
    });
    store.saveDecision(
      {
        run, urgency: "blocking", recap: "why", question: "Free-floating question?",
        options: [{ id: "keep", label: "Keep it", consequence: "fine", reversible: true }],
        recommendation: "keep",
      },
      T0,
    );

    await boot({});
    const cookie = await login();
    const inbox = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(inbox).toContain("Free-floating question?");
    expect(inbox).not.toContain("decide-inline");
    expect(inbox).not.toMatch(/<form[^>]*\/answer/);
  });

  test("a ceremony-bearing selected task never ships the decision script, whatever else is open", async () => {
    seedDecisionIn("d-open", "/repo/main", "Open elsewhere?");
    // A task whose page carries the password approval ceremony.
    seedTaskIn("t-approve", "needs signing", "/repo/main");
    store.saveScope({
      taskId: "t-approve", goal: "sign me", outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "c".repeat(32),
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });

    await boot({ repo: "/repo/main" });
    const cookie = await login();

    // The overview alone carries the enhancement…
    const overview = await (await fetch(url("/workbench"), { headers: { cookie } })).text();
    expect(overview).toContain("decide-inline");

    // …a selected ceremony page does not — sensitive pages gain no new
    // scripts (commit-1 review, finding 1); the scope bar stays inert.
    const selected = await (await fetch(url("/workbench?t=t-approve"), { headers: { cookie } })).text();
    expect(selected).toContain('type="password"');
    expect(selected).not.toContain("decide-inline");
    expect(selected).not.toContain("replaceChildren");
    expect(scopeBarOf(selected)).not.toMatch(/<form|<script/);
  });

  test("a reversible option posts from the card exactly as the endpoint expects", async () => {
    const decisionId = seedDecisionIn("d-tap", "/repo/main", "Tap to keep?");

    await boot({ repo: "/repo/main" });
    const cookie = await login();
    const inbox = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    // The selected-project inbox renders the partial: inline reversible
    // form without confirm, irreversible as a link.
    expect(inbox).toContain("decide-inline");
    expect(inbox).toContain(`data-decision-id="${decisionId}"`);
    expect(inbox).not.toContain('name="confirm"');
    expect(inbox).not.toContain('value="drop"');

    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(inbox)?.[1];
    if (csrf === undefined) throw new Error("no csrf on the inbox");
    const posted = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, choice: "keep" }).toString(),
      redirect: "manual",
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe(`/d/${decisionId}`);
    const page = await (await fetch(url(`/d/${decisionId}`), { headers: { cookie } })).text();
    expect(page).toContain("Answered:");
  });

  test("portfolioLedgerScoped: admission binds before the limit; unfinished runs never appear", async () => {
    // More hidden recent rows than the limit, plus one admitted row —
    // the admitted row must survive the page.
    for (let i = 0; i < 5; i++) seedRunIn(`r-h${i}`, `hidden ${i}`, "/repo/hidden", "built", null);
    seedRunIn("r-adm", "the admitted one", "/repo/main", "built", 0.5);
    // An unfinished run in the admitted repo: outcome IS NOT NULL excludes it.
    const openRef = seedTaskIn("r-open", "still going", "/repo/main");
    store.startRun({
      taskRef: openRef, leaseId: "lease-open", runner: "b1",
      branch: "standing-orders/r-open", worktree: "/pool/r-open", now: new Date(),
      ...presented(store, openRef, "builder"),
    });

    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const rows = store.portfolioLedgerScoped(null, since, 3, ["/repo/main"]);
    expect(rows.some(row => row.taskId === "r-adm")).toBe(true);
    expect(rows.every(row => row.repo !== "/repo/hidden")).toBe(true);
    expect(rows.some(row => row.taskId === "r-open")).toBe(false);

    // Without admission the recent hidden rows would crowd the page.
    const naive = store.portfolioLedgerScoped(null, since, 3, null);
    expect(naive.length).toBe(3);

    await boot({ repo: "/repo/main" }); // afterEach closes a server either way
  });
});

describe("the queue (portfolio arc, slice 1b): move-to-front resolved server-side, refusals inline", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const boot = async (options: Record<string, unknown> = {}) => {
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main", ...options });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  /** A queued task; placed in a repo when one is named, else repo-less. */
  const seed = (id: string, title: string, repo: string | null, at: Date): number => {
    store.createTask({ id, title }, at);
    const ref = store.refFor("built-in", id).id;
    if (repo !== null) store.placeTask(ref, repo);
    store.saveScope({
      taskId: id, goal: "go", outOfScope: null, touches: [], acceptance: [],
      proposedAt: at.toISOString(), digest: `d-${id}`, approvedAt: at.toISOString(), approvedBy: "alex", approvedDigest: `d-${id}`,
    });
    return ref;
  };

  const worker = (name: string, capacity: number): void => {
    store.saveRunner(
      { name, host: "here", capacity, repos: ["/repo/main", "/repo/other"], agents: [], registeredAt: T0.toISOString(), heartbeatAt: new Date().toISOString(), retiredAt: null },
      hashToken(`tok-${name}`),
    );
  };

  const csrf = (html: string): string => {
    const match = /name="csrf" value="([0-9a-f]+)"/.exec(html);
    if (match === null) throw new Error("no csrf token on the page");
    return match[1] as string;
  };

  /** The exact no-script form the ▲ button submits (no `respond` field). */
  const frontForm = (cookie: string, token: string, task: string, column: string, revision: number) =>
    fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf: token, projectRevision: "1", queueRevision: String(revision), task, column, before: "__TOP__" }),
      redirect: "manual",
    });

  /** The order of one partition — exact repo AND assignment — as the store keeps it. */
  const partition = (repo: string | null, runner: string | null): string[] =>
    store.queueScoped("/repo/main", new Date()).filter(one => one.repo === repo && one.assignedRunner === runner).map(one => one.id);

  /** The shared column, mixed: a repo-less task first, then two of the project's. */
  const mixedColumn = (): void => {
    seed("t-any", "anywhere", null, new Date(T0.getTime() + 1_000));
    seed("t-b", "second of the project", "/repo/main", new Date(T0.getTime() + 2_000));
    seed("t-c", "third of the project", "/repo/main", new Date(T0.getTime() + 3_000));
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-queue-1b-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the no-script ▲ moves a card to the front of ITS partition — not before a repo-less neighbour, never a 200 alone", async () => {
    await boot();
    worker("builder-1", 2);
    mixedColumn();
    expect(partition("/repo/main", null)).toEqual(["t-b", "t-c"]);
    expect(partition(null, null)).toEqual(["t-any"]);

    const cookie = await login();
    const page = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    expect(page).toContain('name="before" value="__TOP__"');
    const before = store.queueRevision();

    const moved = await frontForm(cookie, csrf(page), "t-c", "anyone", before);
    expect(moved.status).toBe(303);
    expect(moved.headers.get("location")).toBe("/board?view=order");
    // The asserted ORDER: t-c now leads its own partition; the repo-less
    // card's partition is untouched; the revision moved exactly once.
    expect(partition("/repo/main", null)).toEqual(["t-c", "t-b"]);
    expect(partition(null, null)).toEqual(["t-any"]);
    expect(store.queueRevision()).toBe(before + 1);

    // Inside a worker's column the same button works against that column.
    store.moveTask({ taskId: "t-b", toRunner: "builder-1", beforeTaskId: null }, new Date());
    store.moveTask({ taskId: "t-c", toRunner: "builder-1", beforeTaskId: null }, new Date());
    expect(partition("/repo/main", "builder-1")).toEqual(["t-b", "t-c"]);
    const again = await frontForm(cookie, csrf(page), "t-c", "builder-1", store.queueRevision());
    expect(again.status).toBe(303);
    expect(partition("/repo/main", "builder-1")).toEqual(["t-c", "t-b"]);
  });

  test("already at the front: a no-op that still checks the revision — fresh passes, stale is the typed 409", async () => {
    await boot();
    mixedColumn();
    const cookie = await login();
    const page = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    const token = csrf(page);
    const revision = store.queueRevision();

    // t-b already leads its partition: nothing moves, nothing bumps.
    const noop = await frontForm(cookie, token, "t-b", "anyone", revision);
    expect(noop.status).toBe(303);
    expect(partition("/repo/main", null)).toEqual(["t-b", "t-c"]);
    expect(store.queueRevision()).toBe(revision);

    // The same no-op over the fragment transport says so in plain text.
    const inPlace = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ respond: "fragment", csrf: token, projectRevision: "1", queueRevision: String(revision), task: "t-b", column: "anyone", before: "__TOP__" }),
      redirect: "manual",
    });
    expect(inPlace.status).toBe(200);
    expect(await inPlace.text()).toBe("already at the front");

    // A stale revision on the no-op branch is refused — the branch never
    // reaches moveTask()'s CAS, so the handler makes the check itself.
    const stale = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ respond: "fragment", csrf: token, projectRevision: "1", queueRevision: String(revision + 9), task: "t-b", column: "anyone", before: "__TOP__" }),
      redirect: "manual",
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("moved underneath you");
    expect(partition("/repo/main", null)).toEqual(["t-b", "t-c"]);
  });

  test("the sentinel is honored only inside a task's own column; a cross-column front is refused, assignment untouched", async () => {
    await boot();
    worker("builder-1", 1);
    mixedColumn();
    const cookie = await login();
    const page = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    const refused = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ respond: "fragment", csrf: csrf(page), projectRevision: "1", queueRevision: String(store.queueRevision()), task: "t-c", column: "builder-1", before: "__TOP__" }),
      redirect: "manual",
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("own column");
    expect(store.assignedRunnerOf(store.refFor("built-in", "t-c").id)).toBeNull();
    expect(partition("/repo/main", null)).toEqual(["t-b", "t-c"]);
  });

  test("a claim that lands after the form rendered does not bump the revision — the snapshot refuses the move, order unchanged", async () => {
    await boot();
    worker("builder-1", 2);
    mixedColumn();
    const cookie = await login();
    const page = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    const revision = store.queueRevision();

    // The scheduler takes t-c between render and submit.
    const taken = acquire(store, store.refFor("built-in", "t-c").id, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error(`claim refused: ${taken.message}`);
    expect(store.queueRevision()).toBe(revision); // a claim is not a queue edit

    // The revision still matches, so only the fresh snapshot can catch it.
    const refused = await fetch(url("/queue/move"), {
      method: "POST", headers: { cookie },
      body: new URLSearchParams({ respond: "fragment", csrf: csrf(page), projectRevision: "1", queueRevision: String(revision), task: "t-c", column: "anyone", before: "__TOP__" }),
      redirect: "manual",
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("being taken");
    expect(store.queueRevision()).toBe(revision);
    // The free partition is t-b alone now; t-c kept its claim and its rank.
    expect(partition("/repo/main", null)).toEqual(["t-b", "t-c"]);
    expect(store.queueScoped("/repo/main", new Date()).find(one => one.id === "t-c")?.taken).toBe(true);
  });

  test("column headers: building counted in THIS project beside the global unattended capacity — never a ratio; no dollar figure; the claim primitive behind details", async () => {
    await boot();
    worker("builder-1", 2);
    mixedColumn();
    // builder-1 is busy once here and once in another project.
    seed("t-here", "built here", "/repo/main", new Date(T0.getTime() + 4_000));
    seed("t-there", "built elsewhere", "/repo/other", new Date(T0.getTime() + 5_000));
    for (const id of ["t-here", "t-there"]) {
      const taken = acquire(store, store.refFor("built-in", id).id, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
      if (!taken.ok) throw new Error(`claim refused: ${taken.message}`);
    }
    store.moveTask({ taskId: "t-b", toRunner: "builder-1", beforeTaskId: null }, new Date());

    const cookie = await login();
    const html = await (await fetch(url("/queue"), { headers: { cookie } })).text();
    expect(html).toContain("1 building in this project · unattended capacity 2");
    expect(html).not.toMatch(/\b[12]\s*\/\s*2\b/);
    const main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
    expect(main).not.toContain("slot");
    // Money is not in the queue query and is not invented on the screen.
    expect(html).not.toMatch(/\$\s?\d/);
    // The shared column in plain words; the claim primitive folded away.
    expect(html).toContain("Workers take from here when their column is empty");
    // No explainer disclosure on the screen (reduction pass §2).
    expect(html).not.toContain("how a worker takes from here");
    // Card chips over the existing snapshot shape: state and reservation owner.
    expect(html).toContain('<span class="badge">Queued</span>');
    expect(html).toContain('<span class="badge">Reserved for builder-1</span>');
    expect(html).toContain("Being taken — keeps its claim");
  });
});

describe("the task detail (portfolio arc, slice 1c): the attempt panel, the rail, the honest verbs", () => {
  let store: Store;
  let server: Server | null = null;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-08-11T00:00:00.000Z");
  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const boot = async (options: Record<string, unknown> = {}) => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main", ...options });
    await new Promise<void>(resolve => (server as Server).listen(0, "127.0.0.1", resolve));
    const address = (server as Server).address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  /** A task in the project with a signed scope — the store recomputes
   * the digest at filing, so the yes goes through the real ceremony. */
  const sign = (id: string): void => {
    const agreed = approve(store, id, "alex", new Date(), store.getScope(id)?.digest as string, approverToken);
    if (!agreed.ok) throw new Error(`approval refused: ${agreed.reason}`);
  };
  const seed = (id: string, title: string, agent: { provider: string; model: string } | null = null): number => {
    store.createTask({ id, title }, T0);
    const ref = store.refFor("built-in", id, "ours").id;
    store.placeTask(ref, "/repo/main");
    // A task built by another agent pins it BEFORE the scope files, so the
    // sealed route names that exact pair (v48: a run spends only as the
    // sealed build leg).
    if (agent !== null) store.pinTaskAgent(ref, agent.provider, agent.model);
    store.saveScope({
      taskId: id, goal: `goal of ${id}`, outOfScope: null, touches: [], acceptance: [],
      proposedAt: T0.toISOString(), digest: "", approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    sign(id);
    return ref;
  };

  /** A live attempt: a real claim under the runner's credential, and its run. */
  const live = (id: string, ref: number, provider = "claude", model?: string): number => {
    const taken = acquire(store, ref, "night-shift-1", { token: "tok-night-shift-1", now: new Date(), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error(`claim refused: ${taken.message}`);
    const run = store.startRun({
      taskRef: ref, leaseId: taken.claim.leaseId, runner: "night-shift-1", provider, ...(model === undefined ? {} : { model }),
      branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: new Date(Date.now() - 7 * 60_000),
      ...presented(store, ref, "builder"),
    });
    store.setRunPhase(run, "agent-running");
    store.setTaskState(id, "running", T0);
    return run;
  };

  /** A finished attempt; measured only when cost is given. */
  const finished = (id: string, ref: number, outcome: "built" | "failed", costUsd: number | null, tokens = { tokensIn: 40_000, tokensOut: 4_000 }): number => {
    const run = store.startRun({
      taskRef: ref, leaseId: `lease-${id}-${outcome}-${costUsd ?? "u"}`, runner: "night-shift-1", provider: "claude",
      branch: `standing-orders/${id}`, worktree: `/pool/${id}`, now: T0,
      ...presented(store, ref, "builder"),
    });
    store.stampProviderStart(run, T0);
    store.recordUsage(run, { ...tokens, ...(costUsd === null ? {} : { costUsd }) });
    store.finishRun(run, { outcome, ...(outcome === "failed" ? { reason: "agent" } : {}), now: T0 });
    return run;
  };

  const railOf = (html: string): string => {
    const match = /<aside class="task-rail">(.*?)<\/aside>/s.exec(html);
    if (match === null) throw new Error("no rail on the page");
    return match[1] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-task-1c-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    register(store, { name: "night-shift-1", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-night-shift-1" });
  });

  afterEach(async () => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = null;
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("a queued task says whether it can actually dispatch, including the exact worker repair", async () => {
    seed("t-ready", "tell me if this will run");
    await boot();
    const cookie = await login();

    // The runner was registered at T0 and has gone quiet. The task must not
    // merely say queued: it names the blocking gate and the one-command road.
    const offline = await (await fetch(url("/t/t-ready"), { headers: { cookie } })).text();
    expect(offline).toContain('id="run-status" data-dispatch-status="no-worker-online"');
    expect(offline).toContain("Builder disconnected");
    expect(offline).toContain("stopped checking in");
    expect(offline).toContain("toolroll up");
    expect(offline).toContain("Check connection");
    expect(offline).toContain('<details class="dispatch-recovery" open>');
    expect(offline).toContain('class="dispatch-recovery-command">toolroll up</code>');
    expect(offline).toContain("Reopen Toolroll on the machine where the project lives");
    expect(offline).toContain("This task resumes automatically when the builder reconnects");
    expect(offline).not.toContain("toolroll daemon install");
    expect(offline).not.toContain('data-dispatch-status="ready-to-run"');

    // A current heartbeat for a worker bound to this project changes the
    // same durable task to a positive, equally explicit readiness answer.
    store.touchRunner("night-shift-1", new Date());
    const ready = await (await fetch(url("/t/t-ready"), { headers: { cookie } })).text();
    expect(ready).toContain('id="run-status" data-dispatch-status="ready-to-run"');
    expect(ready).toContain("every dispatch gate currently passes");
    expect(ready).not.toContain('id="run-status" data-dispatch-status="no-worker-online"');
    expect(ready).not.toContain('class="dispatch-recovery"');
  });

  test("a cancelled dependency is shown as repair on both the task and queue", async () => {
    seed("t-blocker", "obsolete prerequisite");
    seed("t-dependent", "must not wait forever");
    seed("t-replacement", "replacement prerequisite");
    expect(store.addEdge("t-dependent", "t-blocker")).toEqual({ ok: true });
    expect(store.cancelTask("t-blocker", T0, "replaced")).toMatchObject({ ok: true });
    // All-project session: replacement candidates still come from the
    // dependent task's own project, not the sidebar's current selection.
    await boot({ repo: undefined, repos: ["/repo/main"] });
    const cookie = await login();

    const task = await (await fetch(url("/t/t-dependent"), { headers: { cookie } })).text();
    expect(task).toContain('data-dispatch-status="terminal-dependency"');
    expect(task).toContain("Choose what happens next");
    expect(task).toContain("This task was waiting for <strong>obsolete prerequisite</strong>, but that task was cancelled.");
    expect(task).toContain("Review that task");
    expect(task).toContain("Choose another task that must finish first");
    expect(task).toContain("Wait for selected task");
    expect(task).toContain("Continue without it");
    expect(task).toContain('aria-label="ways to continue this task"');
    expect(task).toContain('class="dependency-repair-replace"');
    expect(task).toContain('class="dependency-repair-unlink"');
    expect(task).toContain('name="operation" value="replace"');
    expect(task).toContain('name="operation" value="unlink"');
    expect(task).not.toContain('name="operation" value="retry"');
    expect(task).not.toContain(">plan first</button>");
    expect(task).not.toContain("Hold the next attempt");
    expect(task).not.toContain("No approved scope yet");
    expect(task).not.toContain('<details class="section" id="waits-for"');
    const css = await stylesOf(task, base);
    expect(css).toContain(".dependency-repair-actions form > button[type=submit] { width: 100%; }");
    expect(css).toContain(".dependency-repair-actions .dependency-repair-replace > button[type=submit] { width: auto; }");

    const queue = await (await fetch(url("/board?view=order"), { headers: { cookie } })).text();
    expect(queue).toContain('data-task="t-dependent"');
    expect(queue).toContain('data-dispatch-status="terminal-dependency"');
    // The shared headline, with the diagnosis one hover away.
    expect(queue).toContain('title="A required task did not finish">Needs you</a>');

    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(task)?.[1];
    if (csrf === undefined) throw new Error("no csrf on task");
    const replaced = await fetch(url("/t/t-dependent/repair-dependency"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, blocker: "t-blocker", operation: "replace", replacement: "t-replacement" }),
      redirect: "manual",
    });
    expect(replaced.status).toBe(303);
    expect(store.blockers("t-dependent")).toEqual(["t-replacement"]);

    const waiting = await (await fetch(url("/t/t-dependent"), { headers: { cookie } })).text();
    expect(waiting).toContain('data-dispatch-status="waiting-dependency"');
    expect(waiting).toContain("Waiting for another task");
    expect(waiting).not.toContain("No approved scope yet");

    expect(store.cancelTask("t-replacement", T0, "also obsolete")).toMatchObject({ ok: true });
    const afterReplace = await (await fetch(url("/t/t-dependent"), { headers: { cookie } })).text();
    const csrfAgain = /name="csrf" value="([0-9a-f]{64})"/.exec(afterReplace)?.[1];
    if (csrfAgain === undefined) throw new Error("no csrf after replacement");
    const unlinked = await fetch(url("/t/t-dependent/repair-dependency"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf: csrfAgain, blocker: "t-replacement", operation: "unlink" }),
      redirect: "manual",
    });
    expect(unlinked.status).toBe(303);
    expect(store.blockers("t-dependent")).toEqual([]);
  });

  test("a failed dependency can be retried in place without dropping the edge", async () => {
    seed("t-failed-blocker", "repair this first");
    seed("t-after", "still needs the prerequisite");
    store.addEdge("t-after", "t-failed-blocker");
    store.setTaskState("t-failed-blocker", "failed", T0);
    await boot();
    const cookie = await login();
    const task = await (await fetch(url("/t/t-after"), { headers: { cookie } })).text();
    expect(task).toContain('name="operation" value="retry"');
    expect(task).toContain("Try that task again");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(task)?.[1];
    if (csrf === undefined) throw new Error("no csrf on task");

    const retried = await fetch(url("/t/t-after/repair-dependency"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, blocker: "t-failed-blocker", operation: "retry" }),
      redirect: "manual",
    });
    expect(retried.status).toBe(303);
    expect(store.getTask("t-failed-blocker")?.state).toBe("queued");
    expect(store.blockers("t-after")).toEqual(["t-failed-blocker"]);
  });

  test("saved verdicts and recovery reasons remain exact history without replacing current task status", async () => {
    const ref = seed("t-proof", "show me the proof");
    const run = finished("t-proof", ref, "built", 0.25);
    store.setTaskState("t-proof", "done", T0);
    await boot();
    const cookie = await login();

    // This legacy fixture lacks an exact approved result. Saved verdicts
    // remain history; they cannot manufacture a current completion.
    const bare = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(bare).toContain('data-work-status="assignment-needs-decision"');
    expect(bare).not.toContain('data-dispatch-status="complete-with-evidence"');
    expect(bare).toContain('data-card-kind="result-receipt"');
    // Workspace package 1: the receipt names what the record supports —
    // changes saved locally — never an unconditional "shipped".
    expect(bare).not.toContain("What shipped");
    expect(bare).toContain("<h2>Changes saved</h2>");
    expect(bare).toContain('data-receipt-publication="none">Saved on the build branch. No publication, merge, or deployment is recorded here.</p>');
    expect(bare).toContain('data-work-status="assignment-needs-decision"');
    expect(bare).toContain("Needs you");
    expect(bare).toContain(`href="/review?result=t-proof">Open result →</a>`);
    expect(bare).not.toContain("Review the missing evidence");
    expect(bare).toContain('href="/chat?task=t-proof">Discuss in chat →</a>');

    const sha256 = createHash("sha256").update("").digest("hex");
    // The records exist on disk and verify (repair 2026-09-14): a record
    // whose bytes are missing is damaged evidence, and the status would
    // truthfully say so instead of speaking the verdict this test reads.
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    for (const kind of ["handoff", "terminal-diff"] as const) {
      writeFileSync(join(evidenceRoot, String(run), kind), "");
      store.saveArtifact({
        run,
        kind,
        key: `${run}/${kind}`,
        bytesOriginal: 0,
        bytesStored: 0,
        truncated: false,
        sha256,
        capture: `${kind} (exit 0)`,
      }, T0);
    }
    // Artifacts alone still do not say "done" — only the machine's own
    // saved verdict does (the presence-only check this strengthens).
    const stillBare = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(stillBare).toContain('data-work-status="assignment-needs-decision"');

    store.saveProofVerdict(run, "attested", ["the proof agrees with the sealed diff; no verification command is configured to re-run"], T0);
    const attested = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(attested).toContain('data-work-status="assignment-needs-decision"');
    expect(attested).toContain(`data-result-run="${run}"`);
    expect(attested).toContain("the proof agrees with the sealed diff; no verification command is configured to re-run");
    expect(attested).toContain("Needs you");
    expect(attested).not.toContain("Ready to review");

    store.saveProofVerdict(run, "verified", ["the approved verification command passed"], T0);
    const verified = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(verified).toContain('data-work-status="assignment-needs-decision"');
    expect(verified).toContain("Needs you");
    expect(store.proofVerdictFor(run)?.verdict).toBe("verified");

    store.saveProofVerdict(run, "verified", ["the approved verification command passed after the approved setup command ran"], T0);
    const recovered = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recovered).toContain('<summary>Previous assessment</summary>');
    expect(recovered).toContain("the approved verification command passed after the approved setup command ran");

    store.saveProofVerdict(run, "short", ["automatic recovery stopped because the project setup or check changed"], T0);
    const recoveryStopped = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryStopped).toContain("automatic recovery stopped because the project setup or check changed");

    store.saveProofVerdict(run, "short", ["the approved verification command could not start because a required project executable was unavailable and no approved recovery was enabled"], T0);
    const recoveryNotEnabled = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryNotEnabled).toContain("the approved verification command could not start because a required project executable was unavailable and no approved recovery was enabled");

    store.saveProofVerdict(run, "short", ["automatic recovery stopped because Toolroll could not confirm that the built checkout was unchanged"], T0);
    const recoveryUnconfirmed = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryUnconfirmed).toContain("automatic recovery stopped because Toolroll could not confirm that the built checkout was unchanged");

    store.saveProofVerdict(run, "short", ["automatic recovery stopped because tracked files no longer matched the built result"], T0);
    const recoveryFilesChanged = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryFilesChanged).toContain("automatic recovery stopped because tracked files no longer matched the built result");

    store.saveProofVerdict(run, "short", ["automatic recovery stopped because the checkout moved away from the built commit"], T0);
    const recoveryCheckoutMoved = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryCheckoutMoved).toContain("automatic recovery stopped because the checkout moved away from the built commit");

    store.saveProofVerdict(run, "short", ["automatic recovery stopped because the setup command changed tracked files after the build"], T0);
    const recoveryChangedFiles = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryChangedFiles).toContain("automatic recovery stopped because the setup command changed tracked files after the build");

    store.saveProofVerdict(run, "short", ["the required project executable was still unavailable after replaying the approved setup command"], T0);
    const recoveryExecutableStillMissing = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryExecutableStillMissing).toContain("the required project executable was still unavailable after replaying the approved setup command");

    store.saveProofVerdict(run, "short", ["the retried verification command timed out after automatic recovery"], T0);
    const recoveryRetryTimedOut = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryRetryTimedOut).toContain("the retried verification command timed out after automatic recovery");

    store.saveProofVerdict(run, "short", ["the retried verification command could not be started after automatic recovery"], T0);
    const recoveryRetryCouldNotStart = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(recoveryRetryCouldNotStart).toContain("the retried verification command could not be started after automatic recovery");

    store.saveProofVerdict(run, "verified", ["the approved verification command passed after the approved setup command ran"], T0);

    // Focused chat is a second lens over the same durable receipt, not a
    // model-authored summary or a separate result record.
    const chat = await (await fetch(url("/chat?task=t-proof"), { headers: { cookie } })).text();
    expect(chat).toContain('class="card completion-receipt" data-card-kind="result-receipt"');
    expect(chat).toContain('href="/review?result=t-proof">Open result →</a>');
    expect(chat).toContain(`href="/r/${run}">Full build record →</a>`);
    expect(chat).not.toContain("Discuss in chat →");

    store.saveProofVerdict(run, "refuted", ["claimed changed path not in the sealed diff: src/other.ts"], T0);
    const refuted = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(refuted).toContain('data-work-status="assignment-needs-decision"');
    expect(refuted).toContain("src/other.ts");
    expect(refuted).toContain('name="csrf"');
    expect(refuted).not.toContain("Accept with exception</button>");
    // A mismatched changed-path claim is NOT a failed check: the words say
    // the evidence does not match, and never that checks failed.
    expect(refuted).toContain("claimed changed path not in the sealed diff: src/other.ts");
    expect(refuted).not.toContain("checks failed");

    // A recorded exception remains visible history. It does not complete
    // a legacy task whose exact approved result has not been established.
    store.acceptProof(run, "alex", "seen it, shipping anyway", T0);
    const accepted = await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text();
    expect(accepted).toContain('data-work-status="assignment-needs-decision"');
    expect(accepted).toContain('data-work-status="assignment-needs-decision"');
    expect(accepted).toContain("Accepted with an exception");
    // Acceptance leaves the machine's verdict on record, unchanged; it
    // never asserts on its own that the checks failed or passed.
    expect(accepted).toContain("Accepted with an exception by alex. Check results are unchanged.");
    expect(accepted).not.toContain("not passed by the machine");
    expect(accepted).not.toContain("Checks passed");
    expect(accepted).not.toContain("Accept with exception</button>");
  });

  test("historical criterion judgements and repair chains remain readable without creating another inbox stage", async () => {
    store.createTask({ id: "t-review", title: "reviewed work" }, T0);
    const ref = store.refFor("built-in", "t-review", "ours").id;
    store.placeTask(ref, "/repo/main");
    propose(store, { taskId: "t-review", goal: "wire the guard", acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["manual-review"] }], now: T0 });
    sign("t-review");
    const run = store.startRun({ taskRef: ref, leaseId: "l-review", runner: "night-shift-1", provider: "claude", branch: "b", worktree: "/wt", now: T0, ...presented(store, ref, "builder") });
    store.stampRun(run, { scopeDigest: store.getScope("t-review")!.digest });
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    store.saveProofVerdict(
      run,
      "refuted",
      ['reviewer:codex contradicts criterion "c1": never wired in'],
      T0,
      [
        {
          id: "c1",
          statement: "it works",
          requiredEvidence: ["manual-review"],
          state: "failed",
          detail: ['reviewer:codex contradicts criterion "c1": never wired in'],
          answered: [],
          review: { judgement: "contradicts", note: "never wired in", author: "reviewer:codex" },
        },
      ],
      "short",
    );
    store.setTaskState("t-review", "done", T0);

    const { maybeTriggerRepair } = await import("./dispose.js");
    const trigger = maybeTriggerRepair(store, "/repo/main", evidenceRoot, run, "refuted", T0);
    if (trigger.kind !== "drafted") throw new Error(`expected a draft, got ${trigger.kind}`);

    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/t/t-review?version=t-review"), { headers: { cookie } })).text();
    expect(html).toContain('data-review-judgement="contradicts"');
    expect(html).toContain("Reviewer found a problem");
    const reviewWindow = new Window();
    reviewWindow.document.body.innerHTML = html;
    const concern = reviewWindow.document.querySelector('.requirement-warning[data-review-judgement="contradicts"]');
    expect(concern?.textContent).toContain("never wired in");
    expect(concern?.closest(".requirement-evidence")).toBeNull();
    await reviewWindow.happyDOM.close();
    expect(html).toContain("An independent review found conflicting evidence");
    expect(html).toContain("Automatic recovery");
    expect(html).toContain(trigger.draftTaskId);

    const draftHtml = await (await fetch(url(`/t/${trigger.draftTaskId}`), { headers: { cookie } })).text();
    expect(draftHtml).toContain("Automatic recovery");
    // The repair's approval says what it fixes in one sentence, the
    // criterion as words; the machine brief ("Unmet: c1") stays in Details.
    expect(draftHtml).toContain(`<p class="approval-revision">Fixes what build #${run} missed: it works.</p>`);
    const sheetMain = draftHtml.slice(draftHtml.indexOf('class="approve-form approval-sheet"'), draftHtml.indexOf('<details class="approval-details">'));
    expect(sheetMain).not.toContain("Unmet");
    // Its requirement is one only you can check, said plainly above Approve.
    expect(sheetMain).toContain('<p class="approval-you-check" data-approval-you-check>You’ll check: it works</p>');
    // Edit plan shows the goal without the machine brief, which rides along unchanged.
    expect(sheetMain).toContain('<textarea name="goal" rows="3" form="plan-editor-form">wire the guard</textarea>');
    // The thread says who asked for the repair; an ask with no words carries none (no empty bubble).
    const asked = (workspaceOf(draftHtml).view as { thread?: { key: string; title: string; text: string | null }[] }).thread?.find(one => one.key === "revision");
    expect(asked?.title).toBe("Asked for a repair");
    expect(asked?.text).toBeNull();
    expect(sheetMain).not.toContain("inherited terms");

    // Historical repair records stay readable on their task pages. They do
    // not add a second assessment-based stage to the current inbox.
    const inbox = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(inbox).toContain("t-review");
    expect(inbox).not.toContain("repair drafted, awaiting approval");
    expect(store.proofVerdictFor(run)?.verdict).toBe("refuted");
  });

  test("historical semantic coverage and context gaps remain readable while current checked work is Ready", async () => {
    store.createTask({ id: "t-ctx", title: "revised work" }, T0);
    const ref = store.refFor("built-in", "t-ctx", "ours").id;
    store.placeTask(ref, "/repo/main");
    propose(store, {
      taskId: "t-ctx",
      goal: "revise the limiter",
      acceptance: [
        { id: "c1", statement: "the limiter caps retries", how: null, evidence: ["check"] },
        { id: "c2", statement: "the guard refuses a fourth attempt", how: null, evidence: ["check"] },
      ],
      qualityMode: "strict",
      now: T0,
    });
    sign("t-ctx");
    const run = store.startRun({ taskRef: ref, leaseId: "l-ctx", runner: "night-shift-1", provider: "claude", branch: "b", worktree: "/wt", now: T0, ...presented(store, ref, "builder") });
    store.stampRun(run, { scopeDigest: store.getScope("t-ctx")!.digest, baseRevision: "a".repeat(40) });
    store.recordOutcomeFacts(run, { headRevision: "b".repeat(40) });
    store.setVerifyCommand({ repo: "/repo/main", command: "npm test", timeoutMs: 60000, approvedBy: "alex" }, T0);
    storeEvidence(store, evidenceRoot, run, "check-log", "check.txt", Buffer.from("2 checks passed"), "npm test", T0, { captureStatus: "ok" });
    sealVerificationReceipt(store, evidenceRoot, run, "b".repeat(40), store.liveVerifyCommand("/repo/main")!, { configured: true, ran: true, exitCode: 0 }, T0);
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    expect(store.getRun(run)?.qualityMode).toBe("strict");
    // The matrix a revision's settlement stores: machine proof PASSES both
    // rows; the reviewer upheld c1 from sealed context and could not tell
    // c2, whose context is a named gap.
    store.saveProofVerdict(run, "verified", ["the approved verification command passed"], T0, [
      {
        id: "c1", statement: "the limiter caps retries", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "npm test" }],
        review: { judgement: "upholds", note: "ctx-1 returns 3", author: "reviewer:codex" },
        coverage: { state: "context", inherited: true, items: ["ctx-1"], gaps: [], priorSupport: "eligible", assets: "12 images, 3.4 MB, in the run's evidence" },
      },
      {
        id: "c2", statement: "the guard refuses a fourth attempt", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "npm test" }],
        review: { judgement: "cannot-tell", note: "the guard file could not be sealed", author: "reviewer:codex" },
        coverage: { state: "gap", inherited: true, items: [], gaps: ["src/guard.ts: 70000 bytes exceeds the 49152-byte item limit"], priorSupport: "invalid" },
      },
    ]);
    store.setTaskState("t-ctx", "done", T0);
    await boot();
    const cookie = await login();

    const expectCoverage = (html: string): void => {
      expect(html).toContain('data-context-coverage="context"');
      expect(html).toContain('data-context-coverage="gap"');
      expect(html).toContain("Review context is missing");
      expect(html).toContain("src/guard.ts: 70000 bytes exceeds the 49152-byte item limit");
      expect(html).toContain("The saved assessment confirmed 1 of 2 requirements.");
    };
    // The current assignment is Ready on its exact passing receipt. The old
    // strict coverage shortfall remains history, not a completion blocker.
    const task = await (await fetch(url("/t/t-ctx"), { headers: { cookie } })).text();
    expect(task).toContain('data-work-status="assignment-ready-to-check"');
    expect(task).toContain('data-semantic-coverage="unsatisfied"');
    expect(task).toContain('data-coverage-policy="strict"');
    expectCoverage(task);
    expect(task).toContain('data-review-judgement="cannot-tell"');
    const contextWindow = new Window();
    contextWindow.document.body.innerHTML = task;
    const incomplete = contextWindow.document.querySelector('.requirement[data-criterion-id="c2"]');
    expect(incomplete?.querySelector('[data-matrix-state="pass"]')?.textContent).toBe("Met");
    const gap = incomplete?.querySelector('[data-context-coverage="gap"]');
    expect(gap?.textContent).toContain("src/guard.ts: 70000 bytes");
    expect(gap?.closest(".requirement-evidence")).toBeNull();
    expect(incomplete?.querySelector('[data-review-judgement="cannot-tell"]')?.closest(".requirement-evidence")).toBeNull();
    // The change's images are one line under the requirement's details, never a missing file.
    const assets = contextWindow.document.querySelectorAll('.requirement[data-criterion-id="c1"] [data-context-assets]');
    expect([...assets].map(one => one.textContent)).toEqual(["12 images, 3.4 MB, in the run's evidence"]);
    expect(assets[0]?.closest(".requirement-evidence")).not.toBeNull();
    await contextWindow.happyDOM.close();
    // The run page: the same projection under the evidence bundle.
    const runPage = await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text();
    expect(runPage).toContain('data-semantic-coverage="unsatisfied"');
    expectCoverage(runPage);
    // The chat receipt: the same lines, verbatim.
    const chat = await (await fetch(url("/chat?task=t-ctx"), { headers: { cookie } })).text();
    expect(chat).toContain('data-card-kind="result-receipt"');
    expect(chat).toContain("Previous assessment");
    expect(chat).toContain("semantic coverage: 1/2 upheld by an independent reviewer — required under strict quality — NOT satisfied (cannot-tell never counts: c2)");
    // Historical assessment detail stays available on demand; no reviewer
    // action or new agent run is required by the current Ready status.
    expect(chat).toContain('<details class="receipt-coverage" data-semantic-coverage="secondary"><summary>Previous assessment</summary>');
    expect(chat).toContain('data-work-status="assignment-ready-to-check"');
    expect(chat).not.toContain("/retry-review");
    expect(chat).toContain("context gap c2: src/guard.ts: 70000 bytes exceeds the 49152-byte item limit");

    // Under default quality the SAME judgements read as optional coverage —
    // the policy is explicit in the words, never inferred from the verdict.
    store.raw().prepare("UPDATE run SET quality_mode = 'default' WHERE id = ?").run(run);
    const relaxed = await (await fetch(url("/t/t-ctx"), { headers: { cookie } })).text();
    expect(relaxed).toContain('data-coverage-policy="default"');
    expect(relaxed).toContain("The saved assessment confirmed 1 of 2 requirements.");
    expect(relaxed).toContain("src/guard.ts: 70000 bytes");
  });

  test("the legacy inbox does not turn saved assessments into a second assignment queue", async () => {
    const ref = seed("t-proof", "show me the proof");
    const run = finished("t-proof", ref, "built", 0.25);
    store.setTaskState("t-proof", "done", T0);
    store.saveProofVerdict(run, "refuted", ["claimed changed path not in the sealed diff: src/other.ts"], T0);
    await boot();
    const cookie = await login();

    // The page itself (the workspace's Crew panel lists every recent task, finished ones too).
    const inbox = renderedHtmlOf(await (await fetch(url("/inbox"), { headers: { cookie } })).text());
    expect(inbox).not.toContain("conflicting evidence");
    expect(inbox).not.toContain("show me the proof");
    expect(store.proofVerdictFor(run)?.reasons).toContain("claimed changed path not in the sealed diff: src/other.ts");
    expect(await (await fetch(url("/t/t-proof"), { headers: { cookie } })).text()).toContain("src/other.ts");

    store.acceptProof(run, "alex", null, T0);
    const cleared = renderedHtmlOf(await (await fetch(url("/inbox"), { headers: { cookie } })).text());
    expect(cleared).not.toContain("show me the proof");
  });

  test("the attempt panel names the run; its pollers hit the RUN's fragments, never the task URL", async () => {
    const ref = seed("t-live", "being built");
    const run = live("t-live", ref);
    store.saveCheckProgress(run, {
      version: 1,
      final: false,
      line: "unit ✓ 191 · flows 12/18 · app 30/45",
      suites: {
        unit: { state: "passed", passed: 191, failed: 0, skipped: 0, total: 191 },
        flows: { state: "running", passed: 12, failed: 0, skipped: 0, total: 18 },
        app: { state: "running", passed: 30, failed: 0, skipped: 0, total: 45 },
      },
    }, T0);
    await boot({ localRunner: "night-shift-1" });
    const cookie = await login();
    const html = await (await fetch(url("/t/t-live"), { headers: { cookie } })).text();

    expect(html).toContain(`Build #${run} · night-shift-1 · running`);
    expect(html).toContain(`data-live-run="${run}"`);
    expect(html).toContain(`href="/r/${run}">full build view →`);
    // The embedded regions and the scripts that fill them, addressed to
    // the run's own authenticated fragments — no /t/:id?fragment= proxy.
    expect(html).toContain('id="run-peek"');
    expect(html).toContain('id="live-transcript"');
    expect(html).toContain(`"/r/${run}?fragment=peek"`);
    expect(html).toContain(`"/r/${run}?fragment=check"`);
    expect(html).toContain('id="check-progress"');
    expect(html).toContain("unit ✓ 191 · flows 12/18 · app 30/45");
    expect(html).toContain(`"/r/${run}"+"?fragment=transcript&from="`);
    expect(html).not.toContain("fetch(location.pathname");
    expect(html).not.toContain("/t/t-live?fragment");
    // Honesty lines preserved verbatim from the run page.
    expect(html).toContain("display only");

    const check = await (await fetch(url(`/r/${run}?fragment=check`), { headers: { cookie } })).text();
    expect(check).toContain('data-final="live"');
    expect(check).toContain("unit ✓ 191 · flows 12/18 · app 30/45");
    store.saveCheckProgress(run, {
      version: 1,
      final: true,
      line: "unit ✓ 191 · flows ✓ 18 · app ✕ 1/45",
      suites: {
        unit: { state: "passed", passed: 191, failed: 0, skipped: 0, total: 191 },
        flows: { state: "passed", passed: 18, failed: 0, skipped: 0, total: 18 },
        app: { state: "failed", passed: 44, failed: 1, skipped: 0, total: 45 },
      },
    }, new Date(T0.getTime() + 1_000));
    const finalCheck = await (await fetch(url(`/r/${run}?fragment=check`), { headers: { cookie } })).text();
    expect(finalCheck).toContain('data-final="failed"');
    expect(finalCheck).toContain("unit ✓ 191 · flows ✓ 18 · app ✕ 1/45");

    // The Claude-only transcript limitation is kept: a codex build gets the
    // peek and the stated limit, not an empty transcript.
    const ref2 = seed("t-codex", "built by codex", { provider: "codex", model: "gpt-5-codex" });
    const run2 = live("t-codex", ref2, "codex", "gpt-5-codex");
    const codex = await (await fetch(url("/t/t-codex"), { headers: { cookie } })).text();
    expect(codex).toContain(`Build #${run2} · night-shift-1 · running`);
    expect(codex).toContain("The live transcript needs the claude harness for now");
    expect(codex).not.toContain('id="live-transcript"');
    expect(codex).not.toContain("?fragment=transcript");

    // The workbench's selected-task pane carries no run pollers, so the
    // panel there is the static line with the door — never an empty
    // region promising a look that cannot land.
    const pane = await (await fetch(url("/workbench?t=t-live"), { headers: { cookie } })).text();
    expect(pane).toContain(`Build #${run} · night-shift-1 · running`);
    expect(pane).toContain("The live view is on the build page");
    expect(pane).toContain(`href="/r/${run}">full build view →`);
    expect(pane).not.toContain('id="run-peek"');
    expect(pane).not.toContain(`/r/${run}?fragment=peek`);
  });

  test("sensitive composition: a password ceremony beside a live attempt — no poller, a static panel, link-only decisions", async () => {
    const ref = seed("t-both", "live and unsigned");
    const run = live("t-both", ref);
    // The scope is rewritten after the claim: the approval no longer binds
    // it, so the page grows its password ceremony while the run stays live.
    const signed0 = store.getScope("t-both");
    if (signed0 === null) throw new Error("no scope");
    store.saveScope({ ...signed0, goal: "a wider goal", proposedAt: new Date().toISOString() });
    store.saveDecision(
      {
        run, urgency: "blocking", recap: "why it stopped", question: "Which way?",
        options: [
          { id: "keep", label: "Keep and backfill", consequence: "cleanup later", reversible: true },
          { id: "drop", label: "Drop it", consequence: "gone", reversible: false },
        ],
        recommendation: "keep",
      },
      new Date(),
    );
    await boot({ localRunner: "night-shift-1" });
    const cookie = await login();
    const html = await (await fetch(url("/t/t-both"), { headers: { cookie } })).text();

    expect(SENSITIVE_INPUT.test(html)).toBe(true);
    // The panel is a static line with the door; nothing polls.
    expect(html).toContain(`Build #${run} · night-shift-1 · running`);
    expect(html).toContain(`href="/r/${run}">full build view →`);
    expect(html).not.toContain('id="run-peek"');
    expect(html).not.toContain('id="live-transcript"');
    expect(html).not.toContain("?fragment=peek");
    expect(html).not.toContain("?fragment=transcript");
    // The decision renders link-only: the question and its road, no form
    // that answers, no enhancement script.
    expect(html).toContain("Which way?");
    expect(html).toContain("the full question →");
    expect(html).not.toContain('class="decide-inline"');
    expect(html).not.toContain("decide-inline");
    expect(html).not.toContain('action="/d/');

    // The same task, once re-signed, gets the live composition back.
    sign("t-both");
    const signed = await (await fetch(url("/t/t-both"), { headers: { cookie } })).text();
    expect(SENSITIVE_INPUT.test(signed)).toBe(false);
    expect(signed).toContain('id="run-peek"');
    expect(signed).toContain('class="decide-option decide-inline"');
    expect(signed).toContain("decide-inline"); // the inline enhancement rides
  });

  test("publishes as: push, open-PR, and merge are phrased independently; absent says so", async () => {
    await boot();
    const cookie = await login();
    const words = async (id: string): Promise<string> => {
      const rail = railOf(await (await fetch(url(`/t/${id}`), { headers: { cookie } })).text());
      const match = /<span class="meta">publishes as<\/span> <span class="mono">([^<]*)<\/span>/.exec(rail);
      if (match === null) throw new Error("no publishes-as row");
      return match[1] as string;
    };
    seed("t-none", "no grant");
    expect(await words("t-none")).toBe("branch only — publishing is not set up");

    const grant = (capabilities: ("push-branch" | "open-pr")[], merge: boolean) =>
      store.savePublicationGrant(
        {
          repo: "/repo/main", githubRepo: "ap9000/main", remote: "origin", headPrefix: "standing-orders/", base: "main",
          capabilities, selector: "ours", draft: false, grantedBy: "alex",
          ...(merge ? { merge: true, mergeMethod: "squash" as const } : {}),
        },
        new Date(),
      );
    grant(["push-branch"], false);
    expect(await words("t-none")).toBe("may push standing-orders/* to ap9000/main · cannot merge");
    grant(["push-branch", "open-pr"], false);
    expect(await words("t-none")).toBe("may push standing-orders/* to ap9000/main · may open a PR against main · cannot merge");
    grant(["push-branch", "open-pr"], true);
    expect(await words("t-none")).toBe("may push standing-orders/* to ap9000/main · may open a PR against main · may merge (squash)");
  });

  test("economics rows say measured or unmeasured on both lines; the approved scope wears its seal in the rail", async () => {
    const ref = seed("t-money", "costly");
    finished("t-money", ref, "built", 1.25);
    await boot();
    const cookie = await login();
    let rail = railOf(await (await fetch(url("/t/t-money"), { headers: { cookie } })).text());
    expect(rail).toContain("this attempt</span> <span class=\"mono\">$1.25 · 44k tokens · measured");
    expect(rail).toContain("task total</span> <span class=\"mono\">$1.25 · 44k tokens · measured");
    expect(rail).toContain("approved scope");
    expect(rail).toContain('<span class="seal">signs ');
    expect(rail).toContain("approved by alex");

    // A newer unmeasured attempt: this attempt is unmeasured in words, the
    // total says how many were, and $0 is never invented.
    finished("t-money", ref, "failed", null);
    rail = railOf(await (await fetch(url("/t/t-money"), { headers: { cookie } })).text());
    expect(rail).toContain("this attempt</span> <span class=\"mono\">unmeasured — 44k tokens, no dollar figure reported");
    expect(rail).toContain("task total</span> <span class=\"mono\">$1.25 measured across 1/2 attempts — 1 unmeasured · 88k tokens");
    expect(rail).not.toContain("$0.00");

    // Measured dollars with NO token report (commit-3 review, finding 2):
    // the tokens are said unreported, never summed as zero.
    const ref2 = seed("t-quiet", "priced, tokens unreported");
    const quiet = store.startRun({
      taskRef: ref2, leaseId: "lease-quiet", runner: "night-shift-1", provider: "claude",
      branch: "standing-orders/t-quiet", worktree: "/pool/t-quiet", now: T0,
      ...presented(store, ref2, "builder"),
    });
    store.stampProviderStart(quiet, T0);
    store.recordUsage(quiet, { costUsd: 0.4 });
    store.finishRun(quiet, { outcome: "built", now: T0 });
    const quietRail = railOf(await (await fetch(url("/t/t-quiet"), { headers: { cookie } })).text());
    expect(quietRail).toContain("this attempt</span> <span class=\"mono\">$0.40 · tokens unreported · measured");
    expect(quietRail).not.toContain("0 tokens");
  });

  test("subscription telemetry is labeled as an API-price equivalent, never as API-key spend", async () => {
    const ref = seed("t-membership", "covered by the membership");
    const run = finished("t-membership", ref, "built", 2.75);
    store.stampTerminalClass(run, "subscription", "unknown");
    await boot();
    const cookie = await login();

    const task = await (await fetch(url("/t/t-membership"), { headers: { cookie } })).text();
    expect(task).toContain("$2.75 API-price equivalent from subscription usage (not an API charge)");
    expect(task).toContain("subscription · $2.75 API-price equivalent (not an API charge)");
    expect(task).not.toContain(">Cost<");

    const runPage = await (await fetch(url(`/r/${run}`), { headers: { cookie } })).text();
    expect(runPage).toContain("subscription · $2.75 API-price equivalent (not an API charge)");
    expect(runPage).toContain(">usage</span>");
  });

  test("the task page leads with its title and status, keeps identity in collapsed options, and preserves failures and actions", async () => {
    const ref = seed("t-shape", "shaped");
    const failedRun = finished("t-shape", ref, "failed", null);
    store.createIncident({ run: failedRun, kind: "attempts-exhausted" }, new Date());
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/t/t-shape"), { headers: { cookie } })).text();
    // The human title leads; exact identity is available in closed options.
    const options = html.indexOf('<details class="task-status-details" id="task-diagnostics"><summary>Task options</summary>');
    const identity = html.indexOf('<p class="meta task-identity">Task ID <span class="mono">t-shape</span>');
    const title = html.indexOf('<h1 class="task-main-title">shaped</h1>');
    expect(html).toContain('data-work-status="assignment-needs-decision"');
    expect(html).toContain('Builder disconnected');
    expect(html).not.toContain('task-eyebrow');
    expect(html).toContain('<a class="item current" href="/t/t-shape"><span class="t">shaped</span></a>');
    const bar = html.indexOf('<div class="acts-bar">');
    expect(title).toBeGreaterThan(-1);
    expect(options).toBeGreaterThan(title);
    expect(identity).toBeGreaterThan(options);
    expect(bar).toBeGreaterThan(identity);
    // A stalled task's primary act is the retry; hold rides beside it with its reason.
    const barHtml = html.slice(bar, html.indexOf("</div>", bar));
    expect(barHtml).toContain('<span class="primary"><form method="post" action="/t/t-shape/requeue"');
    expect(barHtml).toContain("<button type=\"submit\">Hold the next attempt</button>");
    expect(barHtml).toContain('name="reason"');
    expect(barHtml.indexOf('name="reason"')).toBeLessThan(barHtml.indexOf("Hold the next attempt"));
    // The rail is the property list, one row grammar for every key fact.
    const rail = railOf(html);
    expect(rail).toContain('<div class="card props">');
    expect(rail).toMatch(/<span class="meta">last attempt<\/span> <span class="mono"><a href="\/r\/\d+">build #\d+<\/a> · failed · night-shift-1<\/span>/);
    expect(rail).toContain('<span class="meta">approved scope</span> <span class="mono"><span class="seal">signs ');
    expect(rail).toContain('<span class="meta">publishes as</span>');
    expect(rail).toContain('<span class="meta">this attempt</span>');
    // Sections fold with counts: attempts open, spend folded, scope open and addressable.
    expect(html).toContain('<details class="section" id="attempts"><summary><h2>Build activity <span class="lane-count">1</span></h2></summary>');
    expect(html).toContain('<details class="section" id="usage"><summary><h2>Usage</h2></summary>');
    expect(html).toContain('<details class="section" id="scope" open><summary><h2>Scope</h2></summary>');
    // Cancel stays armed at the foot, after every section.
    expect(html.lastIndexOf('<details class="arm-danger">')).toBeGreaterThan(html.lastIndexOf('<details class="section"'));
  });

  test("hold is 'Hold the next attempt'; while an attempt runs, retry says when it becomes available instead of offering a deferred button", async () => {
    const ref = seed("t-verbs", "with verbs");
    // Stalled AND live: a failed earlier attempt with an unresolved
    // incident, and a live claim right now.
    const failedRun = finished("t-verbs", ref, "failed", null);
    store.createIncident({ run: failedRun, kind: "attempts-exhausted" }, new Date());
    live("t-verbs", ref);
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/t/t-verbs"), { headers: { cookie } })).text();
    expect(html).toContain("<button type=\"submit\">Hold the next attempt</button>");
    // Said once (commit-3 review, finding 3), and only where a retry applies.
    expect(renderedHtmlOf(html).split("retry becomes available after this attempt finishes").length - 1).toBe(1);
    expect(workspaceOf(html).pageHtml!.split("retry becomes available after this attempt finishes").length - 1).toBe(1);
    expect(html).not.toContain('action="/t/t-verbs/requeue"');

    // A healthy live task offers no retry and says nothing about one.
    const ref2 = seed("t-fine", "just running");
    live("t-fine", ref2);
    const fine = await (await fetch(url("/t/t-fine"), { headers: { cookie } })).text();
    expect(fine).toContain("Hold the next attempt");
    expect(fine).not.toContain("retry becomes available");
    expect(fine).not.toContain('action="/t/t-fine/requeue"');
    // The attempts ledger row: chip, then one mono meta run with the
    // unmeasured word for the live attempt.
    expect(html).toContain("unmeasured so far");
  });

  test("a failed task says what went wrong in one line, its one ink act is Retry itself, and nothing links back to its own page", async () => {
    const ref = seed("t-broke", "broke");
    // The agent never started, so nothing of it can still be running: the page reads plain Failed.
    const earlier = store.startRun({ taskRef: ref, leaseId: "lease-broke-1", runner: "night-shift-1", provider: "claude", branch: "standing-orders/t-broke", worktree: "/pool/t-broke", now: T0, ...presented(store, ref, "builder") });
    store.finishRun(earlier, { outcome: "failed", reason: "timeout", now: T0 });
    const failedRun = store.startRun({ taskRef: ref, leaseId: "lease-broke-2", runner: "night-shift-1", provider: "claude", branch: "standing-orders/t-broke", worktree: "/pool/t-broke", now: T0, ...presented(store, ref, "builder") });
    store.finishRun(failedRun, { outcome: "failed", reason: "acceptance", now: T0 });
    store.setTaskState("t-broke", "failed", T0);
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/t/t-broke"), { headers: { cookie } })).text();
    const view = workspaceOf(html).view as import("./browser-workspace.js").BrowserTaskView;
    // The latest failed attempt's reason, in words: never the code as stored, never an earlier attempt's.
    const said = "The result didn't meet its signed requirements.";
    expect(view.status).toMatchObject({ status: { headline: "Failed", sentence: said }, action: null });
    // No check log and no saved report: the stop reason, one suggestion of what to change, and the build's own result
    // page (never the run record, which would bring the person back here).
    const suggestion = "Before handing off, check each signed requirement against the changes.";
    expect(view.failure).toEqual({ line: said, evidence: null, suggestion, link: { label: `See build #${failedRun}`, href: `/review?result=t-broke&run=${failedRun}` } });
    expect(renderedHtmlOf(html)).not.toMatch(/“acceptance”|recorded reason “/);
    // Retry stays the one ink act, its note already holding the suggestion.
    expect(view.retry).toEqual({ action: "/t/t-broke/requeue", note: suggestion });
    // That build's page works: its result page, not Not found, and /r/<id> opens it.
    expect((await fetch(url(`/review?result=t-broke&run=${failedRun}`), { headers: { cookie } })).status).toBe(200);
    expect((await fetch(url(`/r/${failedRun}`), { headers: { cookie }, redirect: "manual" })).headers.get("location")).toBe(`/review?result=t-broke&run=${failedRun}`);
    // The Tasks list says the same, in vermilion's problem line.
    const rows = (workspaceOf(await (await fetch(url("/work"), { headers: { cookie } })).text()).view as import("./browser-workspace.js").BrowserTasksView).rows;
    expect(rows.find(row => row.id === "t-broke")?.detail).toBe(said);
    // No "review its incident", said once: Task options names the reason without its own Review and retry link, and offers no second ink retry.
    const options = view.manage.find(one => one.id === "task-diagnostics")!.html;
    expect(html).not.toContain("review its incident");
    expect(options).not.toContain('href="/t/t-broke#task-actions"');
    expect(options).not.toContain('<span class="primary">');
    expect(options).toContain("<button type=\"submit\">Hold the next attempt</button>");

    // Retry with a note: the same requeue, and the note reaches the next attempt as steering.
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
    const retried = await fetch(url("/t/t-broke/requeue"), { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, note: "Keep the flag's tests; only remove the branches." }), redirect: "manual" });
    expect(retried.status).toBe(303);
    expect(store.getTask("t-broke")?.state).toBe("queued");
    expect(store.listSteerNotes(ref).map(one => one.note)).toEqual(["Keep the flag's tests; only remove the branches."]);
  });

  test("a failed task describes its latest finished attempt, whatever its outcome, across the whole revision family; machine output reads as an internal error with its detail behind the link", async () => {
    // A newer attempt that didn't fail is the one described, never the older failure.
    const ref = seed("t-later", "later");
    const old = store.startRun({ taskRef: ref, leaseId: "lease-later-1", runner: "night-shift-1", provider: "claude", branch: "standing-orders/t-later", worktree: "/pool/t-later", now: T0, ...presented(store, ref, "builder") });
    store.finishRun(old, { outcome: "failed", reason: "timeout", now: T0 });
    const newer = store.startRun({ taskRef: ref, leaseId: "lease-later-2", runner: "night-shift-1", provider: "claude", branch: "standing-orders/t-later", worktree: "/pool/t-later", now: T0, ...presented(store, ref, "builder") });
    store.finishRun(newer, { outcome: "no-change", now: T0 });
    store.setTaskState("t-later", "failed", T0);
    // A revision with no attempt of its own reads its family's latest attempt: the original's, a stack trace.
    const root = seed("t-fam", "family");
    const trace = "TypeError: Cannot read properties of undefined (reading 'id')\n    at runTask (/Users/me/so/dist/worker.js:120:7)";
    const rootRun = store.startRun({ taskRef: root, leaseId: "lease-fam", runner: "night-shift-1", provider: "claude", branch: "standing-orders/t-fam", worktree: "/pool/t-fam", now: T0, ...presented(store, root, "builder") });
    store.finishRun(rootRun, { outcome: "failed", reason: trace, now: T0 });
    const brief = store.saveArtifact({ run: rootRun, kind: "revision-brief", key: "fam.json", bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "a".repeat(64), capture: "synthetic lineage fixture" }, T0);
    const child = seed("t-fam-r", "family, revised");
    store.markRevision(child, "t-fam", brief);
    store.setTaskState("t-fam", "failed", T0);
    store.setTaskState("t-fam-r", "failed", T0);
    await boot();
    const cookie = await login();
    const later = workspaceOf(await (await fetch(url("/t/t-later"), { headers: { cookie } })).text()).view as import("./browser-workspace.js").BrowserTaskView;
    expect(later.failure).toMatchObject({ line: "No reason was recorded for this attempt.", evidence: null, suggestion: "Say what to do differently this time.", link: { href: `/review?result=t-later&run=${newer}` } });
    // Its latest attempt finished with no change; it is still the page of what failed.
    expect((await fetch(url(`/review?result=t-later&run=${newer}`), { headers: { cookie } })).status).toBe(200);
    expect(diagnoseTaskDispatch(store, "t-later", T0)?.detail).toBe("No reason was recorded for this attempt.");

    const html = await (await fetch(url("/t/t-fam"), { headers: { cookie } })).text();
    const view = workspaceOf(html).view as import("./browser-workspace.js").BrowserTaskView;
    expect(view.failure).toMatchObject({ line: "The attempt stopped with an internal error.", link: { label: "The recorded error", href: `/r/${rootRun}?record=1#run-reason-detail` } });
    expect(renderedHtmlOf(html)).not.toContain("TypeError");
    for (const id of ["t-fam", "t-fam-r"]) expect(diagnoseTaskDispatch(store, id, T0)?.detail).toBe("The attempt stopped with an internal error.");
    // The detail waits on the attempt's record, at the link's anchor, as recorded.
    const record = await (await fetch(url(`/r/${rootRun}?record=1`), { headers: { cookie } })).text();
    expect(record).toContain(`id="run-reason-detail"`);
    expect(record).toContain("TypeError: Cannot read properties of undefined (reading &#39;id&#39;)");

    const rows = (workspaceOf(await (await fetch(url("/work"), { headers: { cookie } })).text()).view as import("./browser-workspace.js").BrowserTasksView).rows;
    expect(rows.find(row => row.id === "t-later")?.detail).toBe("No reason was recorded for this attempt.");
    const family = rows.filter(row => row.id === "t-fam" || row.id === "t-fam-r");
    expect(family.length).toBe(1);
    expect(family[0]?.detail).toBe("The attempt stopped with an internal error.");
  });

  test("a failed attempt with no recorded reason says so, and Retry without a note is the plain requeue", async () => {
    const ref = seed("t-silent", "silent");
    const run = store.startRun({ taskRef: ref, leaseId: "lease-silent", runner: "night-shift-1", provider: "claude", branch: "standing-orders/t-silent", worktree: "/pool/t-silent", now: T0, ...presented(store, ref, "builder") });
    store.finishRun(run, { outcome: "failed", now: T0 });
    store.setTaskState("t-silent", "failed", T0);
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/t/t-silent"), { headers: { cookie } })).text();
    expect((workspaceOf(html).view as import("./browser-workspace.js").BrowserTaskView).failure?.line).toBe("No reason was recorded for this attempt.");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
    const retried = await fetch(url("/t/t-silent/requeue"), { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }), redirect: "manual" });
    expect(retried.status).toBe(303);
    expect(store.getTask("t-silent")?.state).toBe("queued");
    expect(store.listSteerNotes(ref)).toEqual([]);
  });
});

describe("the phase route on the console (v47): one projection on the task page, in the ceremony, and in the focused chat", () => {
  let store: Store;
  let server: Server | null = null;
  let base: string;
  let approverToken: string;
  let viewerToken: string;
  let evidenceRoot: string;

  const T0 = new Date("2026-09-10T00:00:00.000Z");
  const url = (path: string) => `${base}${path}`;

  const loginAs = async (name: string, token: string): Promise<string> => {
    const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };
  const csrfOf = (html: string): string => {
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on the page");
    return match[1] as string;
  };
  const page = async (cookie: string, path: string): Promise<string> => (await fetch(url(path), { headers: { cookie } })).text();
  const post = (cookie: string, path: string, fields: Record<string, string>) =>
    fetch(url(path), { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), redirect: "manual" });
  const agentsCardOf = (html: string): string => /<section class="card agents-card" id="agents"[^>]*>(.*?)<\/section>/s.exec(html)?.[1] ?? "";
  const JARGON = /\b(route|phase|sealed|stales?|harness default)\b/i;

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-route-"));
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    store.setPhaseTierConfig("installation", "build", "strong", "claude", "opus", "test", T0);
    store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "test", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    const viewer = addApprover(store, "vera", T0, { name: "alex", token: approverToken });
    if (!viewer.ok) throw new Error("viewer add");
    store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
    viewerToken = viewer.token;
    register(store, { name: "mac-mini", host: "here", capacity: 4, repos: ["/repo/main"], now: T0, newToken: () => "tok-mac-mini" });
    store.createTask({ id: "payouts", title: "Harden payouts" }, T0);
    const ref = store.refFor("built-in", "payouts").id;
    store.placeTask(ref, "/repo/main");
    propose(store, {
      taskId: "payouts",
      goal: "Harden the payouts flow",
      acceptance: [{ id: "pay", statement: "Payouts never double-send", how: null, evidence: ["check", "screenshot"] }],
      riskLevel: "high",
      now: T0,
    });
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(T0.getTime() + 60_000), repo: "/repo/main" });
    await new Promise<void>(resolve => (server as Server).listen(0, "127.0.0.1", resolve));
    const address = (server as Server).address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server !== null) await new Promise<void>(resolve => (server as Server).close(() => resolve()));
    server = null;
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the task page leads with a compact plain-English Agents summary; reasons and availability are one tap away; the ceremony restates the agents without availability; the CLI projection is the same words", async () => {
    store.recordProviderReadiness("mac-mini", [{ provider: "codex", state: "unavailable", reason: "`codex login status` says not logged in", probe: "identity" }], T0);
    const cookie = await loginAs("alex", approverToken);
    const html = await page(cookie, "/t/payouts");
    const card = agentsCardOf(html);
    expect(card).toContain("<h3>Agents</h3>");
    expect(card).toContain('<span class="badge">High risk</span>');
    expect(card).toContain('<span class="badge">Stronger configured agents</span>');
    expect(card).toContain('<span class="badge">Awaiting approval</span>');
    expect(card).toContain('<p class="agents-summary">claude · sonnet plans; claude · opus builds and repairs</p>');
    // Reasons and change controls are CLOSED details, not always-open rows.
    expect(card).toContain('<details class="agents-why"><summary>Why these agents</summary>');
    expect(card).toContain('<details class="agents-change"><summary>Change agents</summary>');
    expect(card).not.toContain("<details open");
    expect(card).toContain("risk is high — every role uses the strongest configured agent");
    expect(card).toContain("acceptance requires screenshots");
    expect(card).toContain("<dt>Builder</dt><dd><span class=\"mono\">claude · opus</span> <span class=\"badge\">Recommended · strong</span>");
    // Availability is volatile metadata beside the agents.
    expect(card).not.toContain('<li class="agents-availability-unavailable"><span class="mono">codex</span>');
    expect(card).toContain('<span class="mono">claude</span> not yet checked');
    expect(card).not.toContain("Paused: a provider these agents need is reported unavailable.");
    expect(card).toContain('name="risk"');
    expect(card).toContain('name="phase"');
    // Valid forms: each form is its own element, never nested, and every
    // control is at least 44px tall.
    expect(card).not.toMatch(/<form[^>]*>(?:(?!<\/form>).)*<form/s);
    expect(card).toMatch(/<form method="post" action="\/t\/payouts\/route" class="agents-form-risk">/);
    expect(await stylesOf(html, base)).toContain(".agents-form input, .agents-form select, .agents-form-risk select { width: 100%; min-width: 0; min-height: 2.75rem; }");
    // No jargon in the visible words (form attribute names aside).
    const visible = card.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'");
    expect(visible).not.toMatch(JARGON);
    // The ceremony restates the agents where the yes is given — and never
    // the volatile availability.
    const ceremony = /<form method="post" action="\/t\/payouts\/approve"(.*?)<\/form>/s.exec(html)?.[1] ?? "";
    // One plain line of who builds in view; the full route in Details.
    expect(ceremony).toContain('<p class="approval-who">Builder Claude Opus · Planner Claude Sonnet</p>');
    const details = ceremony.slice(ceremony.indexOf('<details class="approval-details"><summary>Plan details</summary>'));
    expect(details).toContain("<h3>Why these agents</h3><p>claude · sonnet plans; claude · opus builds and repairs</p>");
    expect(details).toContain("These exact agents are part of what you approve");
    // Plain-English risk consequence, and the runtime mechanics folded away.
    expect(details).toContain("High risk: every active role — planner, builder, and repair — uses the strongest agent you have configured.");
    expect(details).toContain("<h3>Runtime limits</h3>");
    expect(ceremony).not.toContain("--dangerously");
    // No duplicate provider · model chip beside the agents summary.
    expect(ceremony).not.toMatch(/<span class="approval-chip">claude · opus<\/span>/);
    expect(ceremony).not.toContain("unavailable");
    expect(ceremony).not.toContain("not yet checked");
    expect(ceremony.replace(/<[^>]+>/g, " ")).not.toMatch(JARGON);
    // The same projection the CLI prints — one function, one set of words.
    const ref = store.refFor("built-in", "payouts");
    const routed = routeOfTask(store, "payouts", ref, new Date(T0.getTime() + 60_000))!;
    if (routed.kind !== "route") throw new Error("expected a route");
    const projection = projectRoute(routed.route, store.readinessLookupFor("/repo/main", null, new Date(T0.getTime() + 60_000)));
    expect(card).toContain(projection.summary);
    for (const leg of projection.legs) {
      for (const reason of leg.reasons) expect(card).toContain(reason.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
    }
  });

  test("an approver changes an agent from the page in one transaction: recorded with attribution, the approval needs renewing, the CAS refuses a stale form, and clearing re-files again", async () => {
    store.setPhaseTierConfig("installation", "plan", "strong", "codex", "gpt-5-codex", "test", T0);
    const cookie = await loginAs("alex", approverToken);
    const first = store.getScope("payouts")!;
    expect(approve(store, "payouts", "alex", T0, first.digest, approverToken).ok).toBe(true);
    const before = await page(cookie, "/t/payouts");
    expect(agentsCardOf(before)).toContain('<span class="badge">Approved</span>');
    expect(agentsCardOf(before)).toContain(`name="sawDigest" value="${first.digest}"`);
    const csrf = csrfOf(before);
    const bad = await post(cookie, "/t/payouts/route", { csrf, sawDigest: first.digest, phase: "plan", provider: "gemini", model: "gemini-2.5-pro" });
    expect(bad.status).toBe(400);
    const noModel = await post(cookie, "/t/payouts/route", { csrf, sawDigest: first.digest, phase: "plan", provider: "codex", model: "" });
    expect(noModel.status).toBe(400);
    // A form rendered against a digest that is no longer current is refused.
    const stale = await post(cookie, "/t/payouts/route", { csrf, sawDigest: "0".repeat(32), phase: "plan", provider: "claude", model: "sonnet" });
    expect(stale.status).toBe(409);
    expect(approvalOf(store.getScope("payouts")!).approved).toBe(true);
    // A pair configured for another role (the strong BUILDER) is not a
    // planner choice: refused inside the transaction, nothing moves.
    const borrowed = await post(cookie, "/t/payouts/route", { csrf, sawDigest: first.digest, phase: "plan", provider: "claude", model: "opus" });
    expect(borrowed.status).toBe(400);
    expect(await borrowed.text()).toContain("not one of the configured agents for the planner right now (claude · sonnet, codex · gpt-5-codex)");
    expect(approvalOf(store.getScope("payouts")!).approved).toBe(true);
    const changed = await post(cookie, "/t/payouts/route", { csrf, sawDigest: first.digest, phase: "plan", provider: "claude", model: "sonnet" });
    expect(changed.status).toBe(303);
    expect(changed.headers.get("location")).toContain("/t/payouts");
    expect(decodeURIComponent(changed.headers.get("location") ?? "")).toContain("approve it again");
    expect(changed.headers.get("location")).toMatch(/#agents$/);
    const ref = store.refFor("built-in", "payouts");
    expect(ref.routeOverrides).toEqual([expect.objectContaining({ phase: "plan", provider: "claude", model: "sonnet", by: "alex" })]);
    const after = store.getScope("payouts")!;
    expect(approvalOf(after)).toMatchObject({ approved: false, reason: "changed" });
    const html = await page(cookie, "/t/payouts");
    const card = agentsCardOf(html);
    expect(card).toContain("<dt>Planner</dt><dd><span class=\"mono\">claude · sonnet</span> <span class=\"badge\">Pinned</span>");
    expect(card).toContain("pinned to claude · sonnet by the plan request — nothing overrides a pin");
    expect(card).toContain("Planner → <span class=\"mono\">claude · sonnet</span>");
    expect(card).toContain('name="clear-phase" value="plan"');
    // The risk moves too, through the same door, with the current digest.
    const risk = await post(cookie, "/t/payouts/route", { csrf: csrfOf(html), sawDigest: after.digest, risk: "elevated" });
    expect(risk.status).toBe(303);
    expect(store.getScope("payouts")!.riskLevel).toBe("elevated");
    expect(agentsCardOf(await page(cookie, "/t/payouts"))).toContain("Elevated risk");
    // Clearing the override restores the recommendation — at elevated risk, the strong planner.
    const cleared = await post(cookie, "/t/payouts/route", { csrf, sawDigest: store.getScope("payouts")!.digest, "clear-phase": "plan" });
    expect(cleared.status).toBe(303);
    expect(store.refFor("built-in", "payouts").routeOverrides).toEqual([]);
    expect(agentsCardOf(await page(cookie, "/t/payouts"))).toContain("<dt>Planner</dt><dd><span class=\"mono\">codex · gpt-5-codex</span> <span class=\"badge\">Recommended · strong</span>");
  });

  test("a viewer reads the agents but cannot change them; a live claim refuses the edit", async () => {
    const viewer = await loginAs("vera", viewerToken);
    const html = await page(viewer, "/t/payouts");
    const card = agentsCardOf(html);
    expect(card).toContain("claude · opus");
    expect(card).not.toContain('name="phase"');
    const refused = await post(viewer, "/t/payouts/route", { csrf: csrfOf(html), risk: "routine" });
    expect(refused.status).toBe(403);
    expect(store.getScope("payouts")!.riskLevel).toBe("high");
    // Under a live claim the approver's edit is refused too.
    const cookie = await loginAs("alex", approverToken);
    const scope = store.getScope("payouts")!;
    expect(approve(store, "payouts", "alex", T0, scope.digest, approverToken).ok).toBe(true);
    const ref = store.refFor("built-in", "payouts").id;
    const taken = acquire(store, ref, "mac-mini", { token: "tok-mac-mini", now: new Date(T0.getTime() + 60_000) });
    expect(taken.ok).toBe(true);
    const running = await page(cookie, "/t/payouts");
    expect(agentsCardOf(running)).toContain("this task is running — its agents cannot change under a live claim");
    const blocked = await post(cookie, "/t/payouts/route", { csrf: csrfOf(running), risk: "routine" });
    expect(blocked.status).toBe(409);
    expect(approvalOf(store.getScope("payouts")!).approved).toBe(true);
  });

  test("the focused chat shows the same agents beside the conversation, in an always-visible strip, and inside its approval card", async () => {
    store.recordProviderReadiness("mac-mini", [{ provider: "claude", state: "unknown", reason: "installed (claude 1.2.3); no non-spending login check exists", probe: "version" }], T0);
    const cookie = await loginAs("alex", approverToken);
    const chat = await page(cookie, "/chat?task=payouts");
    const aside = /<div class="task-chat-agents-aside">(.*?)<p class="meta"><a href="\/t\/payouts#agents">Change agents on the task/s.exec(chat)?.[1] ?? "";
    expect(aside).toContain('<p class="agents-summary">claude · sonnet plans; claude · opus builds and repairs</p>');
    expect(aside).toContain('<span class="badge">High risk</span>');
    expect(aside).toContain('<span class="badge">Awaiting approval</span>');
    expect(aside).toContain('<details class="agents-why"><summary>Why these agents</summary>');
    expect(aside).toContain('<span class="mono">claude</span> not yet checked');
    // The compact strip lives in the live region, which phones keep even
    // when the desktop context panel is hidden.
    // Since 4ce2b88 the strip is one Agent setup disclosure: the summary
    // and a way to the task's agents, no decorative eyebrow.
    const strip = /<details class="task-chat-agents">(.*?)<\/details>/s.exec(chat)?.[1] ?? "";
    expect(strip).toContain("<summary>Agent setup</summary>");
    expect(strip).toContain("<p>claude · sonnet plans; claude · opus builds and repairs</p>");
    expect(strip).toContain('<a href="/t/payouts#agents">View agents</a>');
    const css = await stylesOf(chat, base);
    expect(css).toContain(".task-chat-workspace .task-chat-context { display: none; }");
    expect(css).toContain(".task-chat-agents {");
    expect(strip.replace(/<[^>]+>/g, " ")).not.toMatch(JARGON);
    // Package 2: the approval card is a section — the concise plan, then
    // the Review plan disclosure over the exact terms.
    const approvalCard = /<section class="card chat-action-card chat-plan" id="task-chat-action"[^>]*>(.*?)<\/form><\/section>/s.exec(chat)?.[0] ?? "";
    expect(approvalCard).toContain('<p class="approval-who">Builder Claude Opus · Planner Claude Sonnet</p>');
    expect(approvalCard).toContain("High risk: every active role");
    expect(approvalCard).toContain("<h3>Why these agents</h3>");
    expect(approvalCard).not.toContain("codex · gpt-5-codex");
    expect(approvalCard).not.toContain("not yet checked");
  });

  test("simple-controls: the change controls offer only configured, role-valid agents from a select, explain every risk choice, and quote no command line; an unconfigured pair is refused", async () => {
    const cookie = await loginAs("alex", approverToken);
    const html = await page(cookie, "/t/payouts");
    const card = agentsCardOf(html);
    const change = /<details class="agents-change">(.*?)<\/details>/s.exec(card)?.[1] ?? "";
    // Every risk level explained in plain words, beside the control.
    expect(change).toContain('<dl class="agents-risk-guide">');
    expect(change).toContain("<dt>Routine</dt><dd>every role uses the everyday configured agent unless the work itself asks for more");
    expect(change).toContain("<dt>Elevated risk</dt><dd>planning and building use the strongest agent you have configured");
    expect(change).toContain("<dt>High risk</dt><dd>every active role — planner, builder, and repair — uses the strongest agent you have configured");
    // One form per role, a select of exact configured pairs, no free text.
    expect(change).not.toContain('name="model"');
    expect(change).not.toContain('name="provider"');
    const forms = [...change.matchAll(/<form method="post" action="\/t\/payouts\/route" class="agents-form"[^>]*>(.*?)<\/form>/gs)].map(one => one[1] ?? "");
    expect(forms).toHaveLength(3);
    const optionsOf = (form: string): string[] => [...form.matchAll(/<option value="([^"]+)"/g)].map(one => one[1] ?? "");
    const byPhase = Object.fromEntries(forms.map(form => [/name="phase" value="([a-z]+)"/.exec(form)?.[1] ?? "", optionsOf(form)]));
    // Each role's OWN configured pairs: the everyday sonnet everywhere, the
    // strong opus builder only where it was configured (build, and repair
    // on the build provider), the strong codex reviewer only for review.
    expect(byPhase["plan"]).toEqual(["claude|sonnet"]);
    expect(byPhase["build"]).toEqual(["claude|sonnet", "claude|opus"]);
    // Repairs stay on the build provider; gemini never reviews (and was never configured).
    expect(byPhase["repair"]).toEqual(["claude|sonnet", "claude|opus"]);
    expect(byPhase["review"]).toBeUndefined();
    expect(change).not.toContain("gemini");
    // The current agent is marked, and selected.
    expect(forms.find(form => form.includes('value="build"'))).toContain('<option value="claude|opus" selected>claude · opus — current</option>');
    // No command-line jargon anywhere on the card, and no runtime switches.
    const visible = card.replace(/<[^>]+>/g, " ");
    expect(visible).not.toMatch(/config set|task route|--tier|--provider|--model|--dangerously/);
    expect(visible).not.toMatch(JARGON);
    // A pair nobody configured is refused, in words, whatever the client typed.
    const csrf = csrfOf(html);
    const digest = store.getScope("payouts")!.digest;
    const unconfigured = await post(cookie, "/t/payouts/route", { csrf, sawDigest: digest, phase: "build", agent: "codex|gpt-5" });
    expect(unconfigured.status).toBe(400);
    expect(await unconfigured.text()).toContain("not one of the configured agents for the builder right now (claude · sonnet, claude · opus)");
    expect(store.refFor("built-in", "payouts").routeOverrides).toEqual([]);
    // A strong planner configured later is offered for the planner — and only then.
    store.setPhaseTierConfig("installation", "plan", "strong", "claude", "opus", "test", T0);
    // The select's own value lands as an exact, attributed choice.
    const chosen = await post(cookie, "/t/payouts/route", { csrf, sawDigest: digest, phase: "plan", agent: "claude|opus" });
    expect(chosen.status).toBe(303);
    expect(store.refFor("built-in", "payouts").routeOverrides).toEqual([expect.objectContaining({ phase: "plan", provider: "claude", model: "opus", by: "alex" })]);
    // A planner choice IS the plan pin (v47): the leg reads pinned, exactly.
    expect(agentsCardOf(await page(cookie, "/t/payouts"))).toContain("<dt>Planner</dt><dd><span class=\"mono\">claude · opus</span> <span class=\"badge\">Pinned</span>");
  });

  test("size: an approver sets a task's size from the page; the approval says it plainly before the password, with the reason", async () => {
    const cookie = await loginAs("alex", approverToken);
    store.setPhaseTierConfig("installation", "build", "light", "claude", "haiku", "test", T0);
    const html = await page(cookie, "/t/payouts");
    expect(agentsCardOf(html)).toContain('<option value="small">Small change: fast model, no plan</option>');
    expect((await post(cookie, "/t/payouts/route", { csrf: csrfOf(html), sawDigest: store.getScope("payouts")!.digest, size: "tiny" })).status).toBe(400);
    const sized = await post(cookie, "/t/payouts/route", { csrf: csrfOf(html), sawDigest: store.getScope("payouts")!.digest, size: "small" });
    expect(sized.status).toBe(303);
    expect(store.refFor("built-in", "payouts").sizing).toEqual({ size: "small", risky: false, source: "person", reason: "set by alex" });
    const ceremony = /<form method="post" action="\/t\/payouts\/approve"(.*?)<\/form>/s.exec(await page(cookie, "/t/payouts"))?.[1] ?? "";
    const sizeAt = ceremony.indexOf('<p class="agents-size"><strong>');
    expect(sizeAt).toBeGreaterThan(-1);
    expect(ceremony.indexOf('name="token"')).toBeGreaterThan(sizeAt);
    // The rubric here asks for screenshots, which lifts the builder: the size line says what actually runs.
    expect(ceremony.slice(sizeAt)).toMatch(/^<p class="agents-size"><strong>Small change: strongest model, no plan\.<\/strong> <span class="meta">set by alex<\/span><\/p>/);
  });

  test("consent: the task page, the focused chat, and the next-up triage all restate the same concise exact agents before the password, with runtime limits closed away", async () => {
    const cookie = await loginAs("alex", approverToken);
    const summary = "claude · sonnet plans; claude · opus builds and repairs";
    const risk = "High risk: every active role — planner, builder, and repair — uses the strongest agent you have configured.";
    const ceremonyOf = (html: string, action: string): string => new RegExp(`<form method="post" action="${action}"(.*?)<\\/form>`, "s").exec(html)?.[1] ?? "";
    // The task page and chat share the approval sheet: who builds in one
    // line before the password, the exact route and limits in Details.
    const sheet = (ceremony: string): void => {
      const whoAt = ceremony.indexOf('<p class="approval-who">Builder Claude Opus · Planner Claude Sonnet</p>');
      const passwordAt = ceremony.indexOf('name="token"');
      const detailsAt = ceremony.indexOf('<details class="approval-details"><summary>Plan details</summary>');
      expect(whoAt).toBeGreaterThan(-1);
      expect(passwordAt).toBeGreaterThan(whoAt);
      expect(detailsAt).toBeGreaterThan(passwordAt);
      expect(ceremony.slice(detailsAt)).toContain(`<h3>Why these agents</h3><p>${summary}</p>`);
      expect(ceremony.slice(detailsAt)).toContain(risk);
      expect(ceremony.slice(detailsAt)).toContain("<h3>Runtime limits</h3>");
      expect(ceremony).not.toContain("<details open");
      expect(ceremony).not.toContain("not yet checked");
      expect(ceremony.replace(/<[^>]+>/g, " ")).not.toMatch(/--dangerously|config set|task route/);
    };
    const check = (ceremony: string): void => {
      const agentsAt = ceremony.indexOf('<p class="approval-label">agents</p>');
      const passwordAt = ceremony.indexOf('name="token"');
      expect(agentsAt).toBeGreaterThan(-1);
      expect(passwordAt).toBeGreaterThan(agentsAt);
      expect(ceremony).toContain(`<p class="agents-summary">${summary}</p>`);
      expect(ceremony).toContain(risk);
      expect(ceremony).toContain('<details class="agents-runtime"><summary>Runtime limits</summary>');
      expect(ceremony).not.toContain("<details open");
      expect(ceremony).not.toContain("not yet checked");
      expect(ceremony.replace(/<[^>]+>/g, " ")).not.toMatch(/--dangerously|config set|task route/);
    };
    sheet(ceremonyOf(await page(cookie, "/t/payouts"), "\\/t\\/payouts\\/approve"));
    sheet(ceremonyOf(await page(cookie, "/chat?task=payouts"), "\\/t\\/payouts\\/approve"));
    const next = await page(cookie, "/next");
    expect(next).toContain("the last thing waiting on you");
    check(ceremonyOf(next, "\\/t\\/payouts\\/approve"));
    // Changing an agent invalidates the approval every surface signed under.
    const before = store.getScope("payouts")!;
    expect(approve(store, "payouts", "alex", T0, before.digest, approverToken).ok).toBe(true);
    expect((await page(cookie, "/next"))).toContain("Nothing needs you");
    const html = await page(cookie, "/t/payouts");
    const changed = await post(cookie, "/t/payouts/route", { csrf: csrfOf(html), sawDigest: before.digest, phase: "build", agent: "claude|sonnet" });
    expect(changed.status).toBe(303);
    expect(approvalOf(store.getScope("payouts")!)).toMatchObject({ approved: false, reason: "changed" });
    const again = await page(cookie, "/next");
    expect(again).toContain("the last thing waiting on you");
    expect(ceremonyOf(again, "\\/t\\/payouts\\/approve")).toContain("claude · sonnet plans, builds, and repairs");
  });

  test("a routed task whose approval lost its agents shows the closed door in words, and a proven pre-routing approval shows its profile", async () => {
    const cookie = await loginAs("alex", approverToken);
    const scope = store.getScope("payouts")!;
    expect(approve(store, "payouts", "alex", T0, scope.digest, approverToken).ok).toBe(true);
    store.raw().prepare("UPDATE task_scope SET approved_route_json = NULL WHERE task_id = 'payouts'").run();
    const gone = agentsCardOf(await page(cookie, "/t/payouts"));
    expect(gone).toContain('<span class="badge">Cannot be read</span>');
    expect(gone).toContain("the approval sealed no agent route");
    expect(gone).toContain("Nothing runs for this task until its scope is filed again and approved.");
    store.raw().prepare("UPDATE task_scope SET route_era = NULL, proposed_route_json = NULL WHERE task_id = 'payouts'").run();
    const legacy = agentsCardOf(await page(cookie, "/t/payouts"));
    expect(legacy).toContain("claude · opus builds and repairs (repair model opus); the planner and reviewer come from configuration at run time");
  });
});

describe("/peek: every live agent in the console (peek)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;

  const login = async (): Promise<string> => {
    const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken }), redirect: "manual" });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-serve-peek-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), localRunner: "night-shift-1" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("one pane per live run with its stage and transcript tail, a poller per pane, and the set of runs as a fragment; signed-out is a redirect", async () => {
    const { openLiveLog } = await import("./live.js");
    store.createTask({ id: "t-peek", title: "Harden webhook retries" }, T0);
    const ref = store.refFor("built-in", "t-peek").id;
    store.placeTask(ref, "/repo/main");
    register(store, { name: "night-shift-1", host: "host", capacity: 2, repos: ["/repo/main"], now: new Date(), newToken: () => "tok-peek" });
    const taken = acquire(store, ref, "night-shift-1", { token: "tok-peek", now: new Date(), ttlMs: 60 * 60_000 });
    if (!taken.ok) throw new Error("claim failed");
    const run = store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "night-shift-1", role: "builder", provider: "codex", branch: "standing-orders/t-peek", worktree: "/pool/t-peek", now: new Date(), ...presented(store, ref, "builder", null, { provider: "codex", model: null }) });
    store.setRunPhase(run, "agent-running");
    const log = openLiveLog(evidenceRoot, run);
    log?.observe({ type: "item.completed", item: { type: "agent_message", text: "Reading the retry loop now." } });
    log?.observe({ type: "item.completed", item: { type: "command_execution", command: "cat secrets" } });
    log?.close();

    const anonymous = await fetch(`${base}/peek`, { redirect: "manual" });
    expect(anonymous.status).toBe(303);

    const cookie = await login();
    const page = await (await fetch(`${base}/peek`, { headers: { cookie } })).text();
    expect(page).toContain("Harden webhook retries");
    expect(page).toContain("night-shift-1 · builder · agent running");
    expect(page).toContain("Reading the retry loop now.");
    expect(page).toContain("→ running a command");
    expect(page).not.toContain("cat secrets");
    expect(page).toContain(`id="live-transcript-${run}"`);
    expect(page).toContain(`"/r/${run}"+"?fragment=transcript`);

    const fragment = await (await fetch(`${base}/peek?fragment=1`, { headers: { cookie } })).json();
    expect(fragment).toEqual({ runs: [run] });

    // The run page of a non-claude run carries the transcript poller too.
    const runPage = await (await fetch(`${base}/r/${run}`, { headers: { cookie } })).text();
    expect(runPage).toContain("fragment=transcript");

    store.finishRun(run, { outcome: "built", now: new Date() });
    const empty = await (await fetch(`${base}/peek`, { headers: { cookie } })).text();
    expect(empty).toContain("No agent is working right now");
  });
});

describe("the inbox says when nothing will build (install review)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;

  const login = async (): Promise<string> => {
    const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken }), redirect: "manual" });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-serve-worker-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date() });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("no worker registered, a stale worker, and an answering worker each say the right thing", async () => {
    const cookie = await login();
    let inbox = await (await fetch(`${base}/inbox`, { headers: { cookie } })).text();
    expect(inbox).toContain('data-builder-status="not-connected"');
    expect(inbox).toContain("No builder is connected yet.");
    expect(inbox).toContain("Toolroll is open, but no machine is connected to do project work.");
    expect(inbox).toContain("toolroll up");
    expect(inbox).not.toContain("toolroll daemon install");

    register(store, { name: "old-1", host: "h", capacity: 1, repos: ["/repo/main"], now: new Date(Date.now() - 30 * 24 * 60 * 60_000), newToken: () => "tok-old" });
    inbox = await (await fetch(`${base}/inbox`, { headers: { cookie } })).text();
    expect(inbox).toContain('data-builder-status="disconnected"');
    expect(inbox).toContain("Builder disconnected.");
    expect(inbox).toContain("1 builder is configured, last checked in");
    expect(inbox).toContain("Reopen Toolroll on that machine.");
    expect(inbox).toContain("Queued work starts automatically when a builder reconnects.");

    store.touchRunner("old-1", new Date());
    inbox = await (await fetch(`${base}/inbox`, { headers: { cookie } })).text();
    expect(inbox).not.toContain("data-builder-status=");
    expect(inbox).not.toContain("Builder disconnected.");
  });
});

describe("the board's order view (operator request): the one place a drag does anything", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;

  const login = async (): Promise<string> => {
    const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken }), redirect: "manual" });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-serve-order-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    store.createTask({ id: "t-order-1", title: "first in line" }, T0);
    store.createTask({ id: "t-order-2", title: "second in line" }, T0);
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date() });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the state view links to order; the order view carries the queue's drag handles and its poller; state stays a view", async () => {
    const cookie = await login();
    const state = await (await fetch(`${base}/board`, { headers: { cookie } })).text();
    expect(state).toContain('href="/board?view=order"');
    expect(state).not.toContain('class="queue-handle"');

    const order = await (await fetch(`${base}/board?view=order`, { headers: { cookie } })).text();
    expect(order).toContain("<h1>Board</h1>");
    expect(order).toContain('<a href="/board">state</a>');
    expect(order).toContain("first in line");
    expect(order).toContain("second in line");
    expect(order).toContain('class="queue-handle"');
    expect(order).toContain('id="queue-region"');
    expect(order).toContain("/queue?fragment=1");
    // The queue page itself is unchanged: same region, same handles.
    const queue = await (await fetch(`${base}/queue`, { headers: { cookie } })).text();
    expect(queue).toContain('class="queue-handle"');
  });
});

describe("failures say what failed and builds say how far along: the demo's own failed and building tasks", () => {
  let made: ReturnType<typeof createDemoSandbox>;
  let server: Server;
  let base: string;
  let cookie: string;

  beforeEach(async () => {
    made = createDemoSandbox(new Date());
    made.lead.stop();
    server = createDecisionServer({ store: made.store, evidenceRoot: made.evidenceRoot, clock: () => new Date(), repos: made.seed.repos });
    await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
    const signedIn = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "demo", token: made.seed.login.password }), redirect: "manual" });
    cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] as string;
  });

  afterEach(async () => {
    await new Promise<void>(done => server.close(() => done()));
    made.store.close();
    rmSync(made.sandbox, { recursive: true, force: true });
  });

  const view = async (path: string) => workspaceOf(await (await fetch(`${base}${path}`, { headers: { cookie } })).text()).view as import("./browser-workspace.js").BrowserTaskView;
  const runsOf = (task: string) => made.store.runsFor(made.store.lookupRef(task)!.id);

  test("the failed task names the requirement it missed and its evidence, Retry's note holds what to change, and its build has a page", async () => {
    const failed = await view("/t/retire-legacy-flag");
    const run = runsOf("retire-legacy-flag").find(one => one.outcome === "failed")!.id;
    expect(failed.status!.status).toMatchObject({ headline: "Failed", sentence: "Missed a requirement: No reference to LEGACY_PAYOUT remains in the codebase." });
    expect(failed.failure).toEqual({
      line: "Missed a requirement: No reference to LEGACY_PAYOUT remains in the codebase.",
      evidence: "The agent's own note says: src/admin/overrides.ts still reads LEGACY_PAYOUT for the per-merchant override toggle, so one reference remains.",
      suggestion: "Before handing off, make sure no reference to LEGACY_PAYOUT remains in the codebase.",
      link: { label: `See build #${run}`, href: `/review?result=retire-legacy-flag&run=${run}` },
    });
    expect(failed.retry).toEqual({ action: "/t/retire-legacy-flag/requeue", note: failed.failure!.suggestion });
    // The demo runs no checks: the Checks row says so and offers nothing, and nothing leads to Chat.
    expect(JSON.stringify(failed.status)).not.toContain("/chat?");
    expect(failed.runChecks).toBeNull();
    expect(failed.status!.status.details.find(one => one.key === "checks")).toMatchObject({ text: "Can't run in the demo", action: null, href: null });
    // The Requirements row counts what it missed.
    expect(failed.status!.status.details.find(one => one.key === "requirements")).toMatchObject({ text: "1 missed", mark: "failed" });
    // Its build record and result page are there, and Chat says the same thing.
    expect((await fetch(`${base}/review?result=retire-legacy-flag&run=${run}`, { headers: { cookie } })).status).toBe(200);
    const result = ((await (await fetch(`${base}/review?result=retire-legacy-flag&run=${run}&format=workspace`, { headers: { cookie } })).json()) as import("./browser-workspace.js").BrowserWorkspace).view as import("./browser-workspace.js").BrowserResultView;
    expect(result.selected!.panel!.status!.details.find(one => one.key === "checks")).toMatchObject({ text: "Can't run in the demo", action: null });
    expect(result.selected!.panel!.status!.details.find(one => one.key === "requirements")).toMatchObject({ text: "1 missed" });
    expect((await fetch(`${base}/r/${run}`, { headers: { cookie }, redirect: "manual" })).headers.get("location")).toBe(`/review?result=retire-legacy-flag&run=${run}`);
    const chat = await (await fetch(`${base}/chat?task=retire-legacy-flag`, { headers: { cookie } })).text();
    expect(chat).toContain("Missed a requirement: No reference to LEGACY_PAYOUT remains in the codebase.");
    expect(chat).not.toMatch(/href="\/chat\?task=retire-legacy-flag&amp;result=[0-9]+&amp;tab=checks#follow-ups"/);
  });

  test("the building task says which step it is stuck on in place of the step line, with Stop in the same card, and its earlier stopped attempt is one quiet line", async () => {
    const html = await (await fetch(`${base}/t/harden-webhook-retries`, { headers: { cookie } })).text();
    const building = workspaceOf(html).view as import("./browser-workspace.js").BrowserTaskView;
    const stuck = "Stuck on step 4 of 6: the flag is off in the staging deploy target — confirming before enforcing.";
    expect(building.status!.status.headline).toBe("Building");
    expect(building.status!.status.sentence).toBe(stuck);
    expect(building.progress).toEqual({ line: stuck, stuck: {
      step: 4, why: "the flag is off in the staging deploy target — confirming before enforcing", line: stuck,
      action: { label: "Send the agent a note", href: "#steering" } } });
    // The act lands somewhere real: the Steering fold with its note form.
    expect(building.manage.some(one => one.id === "steering")).toBe(true);
    // Stop is in that card, for this exact build; the control card below keeps its details but not a second Stop, and
    // no panel says the live file view is off.
    const live = runsOf("harden-webhook-retries").find(one => one.outcome === null && one.role === "builder")!;
    expect(building.stop).toEqual({ action: "/t/harden-webhook-retries/stop", run: live.id });
    const control = building.lead.find(one => one.key === "control")!.html;
    expect(control).toContain(`data-control-run="${live.id}"`);
    expect(control).toContain(`Stop details · build #${live.id}`);
    expect(control).not.toContain("task-stop-form");
    expect(control).not.toContain(">Stop</button>");
    expect(building.lead.some(one => one.key === "attempt")).toBe(false);
    expect(renderedHtmlOf(html)).not.toContain("the live file view is off");
    // The card keeps its way to the build's own record.
    expect(building.record).toEqual({ label: `Build #${live.id} record`, href: `/r/${live.id}` });
    // Rendered, the card holds the stuck line, its note act and the exact-run Stop form, side by side.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { TaskView } = await import("./browser/views/task-view.js");
    const card = renderToStaticMarkup(createElement(TaskView, { view: building, csrf: "token" })).split('data-task-status')[1]!.split("</section>")[0]!;
    expect(card).toContain(`data-build-stuck="4"`);
    expect(card).toContain(stuck);
    expect(card).toContain("data-stuck-action");
    expect(card).toMatch(new RegExp(`<form class="task-stop-form[^"]*" data-task-control="stop" data-control-run="${live.id}" action="/t/harden-webhook-retries/stop" method="post">`));
    expect(card).toContain(`<input type="hidden" name="run" value="${live.id}"/>`);
    expect(card).toContain(`<input type="hidden" name="return" value="task"/>`);
    expect(card).toMatch(new RegExp(`<a href="/r/${live.id}" data-build-record[^>]*>Build #${live.id} record</a>`));
    expect(card.match(/>Stop<\/button>/g)).toHaveLength(1);
    const stopped = runsOf("harden-webhook-retries").find(one => one.role === "builder" && one.outcome === "refused")!;
    expect(building.earlier).toEqual({ summary: "1 earlier attempt stopped", attempts: [{ label: `Build #${stopped.id}`, href: `/r/${stopped.id}`, text: "The plan changed, so a fresh attempt took over." }] });
    // Not a red mark in the thread beside the healthy build.
    expect(building.thread!.some(one => one.key === `run-${stopped.id}`)).toBe(false);
    expect(building.thread!.some(one => one.kind === "progress" && /^Building/.test(one.title))).toBe(true);
  });

  test("while the live build reads anything but Building, its earlier stopped attempt stays in the thread", async () => {
    const live = runsOf("harden-webhook-retries").find(one => one.outcome === null && one.role === "builder")!;
    const stopped = runsOf("harden-webhook-retries").find(one => one.role === "builder" && one.outcome === "refused")!;
    made.store.saveDecision({ run: live.id, urgency: "blocking", recap: "The staging flag is off.", question: "Enforce the limiter anyway?",
      options: [{ id: "yes", label: "Enforce it", consequence: "Turns it on.", reversible: true }, { id: "no", label: "Wait", consequence: "Leaves it off.", reversible: true }], recommendation: "no" }, new Date());
    const asking = await view("/t/harden-webhook-retries");
    expect(asking.status!.status.headline).not.toBe("Building");
    expect(asking.earlier ?? null).toBeNull();
    expect(asking.progress ?? null).toBeNull();
    expect(asking.thread!.some(one => one.key === `run-${stopped.id}`)).toBe(true);
  });

  test("the Tasks list says the same: a failed row from the database alone, a live row from its own attempt's progress", async () => {
    const rowsOf = async () => (workspaceOf(await (await fetch(`${base}/work`, { headers: { cookie } })).text()).view as import("./browser-workspace.js").BrowserTasksView).rows;
    const ref = made.store.lookupRef("harden-webhook-retries")!;
    const live = runsOf("harden-webhook-retries").find(one => one.outcome === null && one.role === "builder")!;
    const stopped = runsOf("harden-webhook-retries").find(one => one.role === "builder" && one.outcome === "refused")!;
    const recorded = made.store.latestCheckpointForRun(live.id)!;
    const at = (states: ("pending" | "current" | "completed" | "blocked")[]) => ({ revisionHash: recorded.snapshot.revisionHash,
      milestones: recorded.snapshot.milestones.map((one, index) => ({ id: one.id, state: states[index]!, note: null })) });
    // Moving on, the live build names its step in the plan's own words.
    made.store.insertRunCheckpoint({ run: live.id, taskRef: ref.id, planRevision: recorded.planRevision, snapshot: at(["completed", "current", "pending", "pending", "pending", "pending"]) }, new Date());
    // A stopped attempt's later progress is never read as the live build's.
    made.store.insertRunCheckpoint({ run: stopped.id, taskRef: ref.id, planRevision: recorded.planRevision, snapshot: at(["completed", "completed", "completed", "completed", "current", "pending"]) }, new Date(Date.now() + 1000));
    expect((await rowsOf()).find(row => row.id === "harden-webhook-retries")?.detail).toBe("Step 2 of 6: Add a per-endpoint token-bucket limiter.");
    // Every saved file gone: the live row names its step by number, and the failed row still names the missed requirement.
    rmSync(made.evidenceRoot, { recursive: true, force: true });
    const rows = await rowsOf();
    expect(rows.find(row => row.id === "harden-webhook-retries")?.detail).toBe("Step 2 of 6.");
    expect(rows.find(row => row.id === "retire-legacy-flag")?.detail).toBe("Missed a requirement: No reference to LEGACY_PAYOUT remains in the codebase.");
  });

  test("the Tasks list row of a stuck live build names the stuck step from that build's own progress", async () => {
    const rows = (workspaceOf(await (await fetch(`${base}/work`, { headers: { cookie } })).text()).view as import("./browser-workspace.js").BrowserTasksView).rows;
    expect(rows.find(row => row.id === "harden-webhook-retries")?.detail).toBe("Stuck on step 4 of 6: the flag is off in the staging deploy target — confirming before enforcing.");
  });
});
