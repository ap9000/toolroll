import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, type ChatConfig, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { configureLeadFollow, leadFollowStatus, recordLeadFollowFailure, runLeadFollowPass } from "./lead-follow.js";
import { ASSIGNMENT_STATUS_ACTION } from "./assignment-status.js";
import type { LeadTurnInput, LeadTurnOutcome } from "./lead.js";

describe("the built-in lead reads crew updates through the assignment inbox", () => {
  let root: string, repo: string, store: Store, who: VerifiedApprover, session: number, thread: number, token: string;
  const t0 = new Date("2026-10-11T12:00:00.000Z");
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  let asked: { requestId: string; context: string }[] = [];
  let answer: "answered" | "refused" | "throws" = "answered";

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lead-follow-")));
    repo = join(root, "repo");
    mkdirSync(repo);
    store = openStore(join(root, "state.db"));
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", t0);
    register(store, { name: "builder-1", host: "h", capacity: 2, repos: [repo], now: t0, newToken: () => "tok-builder-1" });
    const added = addApprover(store, "operator", t0);
    if (!added.ok) throw Error("account");
    token = added.token;
    const verified = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, [repo]);
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintLeadSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "fixture", ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, t0);
    thread = store.openLeadThread(who.name, who.ceilingDigest, t0).thread.id;
    asked = [];
    answer = "answered";
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  const follow = (now: Date) => {
    if (!configureLeadFollow(store, who, store.getLeadSession(session)!, store.getLeadThread(thread)!, true, now)) throw Error("follow");
  };
  /** A task with an approved scope: queued, which is working and asks nothing of the lead. */
  const file = (id: string, now: Date) => {
    const made = fileTaskProposal(store, { id, title: `Fix ${id}`, repo, filedVia: "cli", planning: "skip" }, now);
    if (!made.ok) throw Error(made.message);
    propose(store, { taskId: id, goal: `fix ${id}`, now });
    approve(store, id, "operator", now, store.getScope(id)!.digest, token);
  };
  /** A lead turn the fake model answers at once. */
  const runTurn = async (input: LeadTurnInput): Promise<LeadTurnOutcome> => {
    asked.push({ requestId: input.requestId ?? "", context: input.context ?? "" });
    if (answer === "throws") throw new Error("the provider broke at /Users/someone/private/path");
    if (answer === "refused") return { ok: false, refused: "provider-unavailable" as never, message: "The lead is offline." };
    const now = at(30);
    const opened = store.openLeadTurn({ approver: who.name, session, thread, credentialKey: "fixture", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
    if (!opened.ok) throw Error(opened.reason);
    const started = store.startLeadTurn(opened.id, now);
    if (!started.ok) throw Error("start");
    store.finalizeLeadTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Seen.", activity: "" } }, now);
    return { ok: true, turn: opened.id, reply: "Seen.", activity: "", proposals: 0, steps: 1, stoppedAtCap: false, settledMicrousd: 0 };
  };
  const pass = (now: Date) => runLeadFollowPass({ store, repos: () => [repo], evidenceRoot: root, clock: () => now,
    provider: () => ({ config: {} as ChatConfig, key: null }), runTurn });
  const followEvents = () => store.handle.prepare("SELECT task_id, json_extract(outcome, '$.assignment.state') AS state FROM action_ledger WHERE action = ? AND actor LIKE 'follow:%' ORDER BY id")
    .all(ASSIGNMENT_STATUS_ACTION).map(row => [row["task_id"], row["state"]]);
  const privateBatches = () => store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action LIKE 'lead batch:%' OR action LIKE 'lead update:%' OR action LIKE 'lead observed:%'").get()!["n"];

  test("a cancelled task reaches the lead, as one saved page acknowledged after the turn", async () => {
    follow(t0);
    file("login", at(1));
    await pass(at(2));
    store.setTaskState("login", "cancelled", at(3));
    await pass(at(4));

    expect(asked).toHaveLength(1);
    expect(JSON.parse(asked[0]!.context.split("\n")[1]!)).toEqual([expect.objectContaining({ task: "login", state: "cancelled" })]);
    expect(leadFollowStatus(store, who.name).detail).toBe("Crew updates handled.");
    // The page was acknowledged: the next pass finds nothing new and runs no turn.
    await pass(at(5));
    expect(asked).toHaveLength(1);
    // The status events ride the shared stream; the lead's private batches are gone.
    expect(followEvents().at(-1)).toEqual(["login", "cancelled"]);
    expect(privateBatches()).toBe(0);
  });

  test("work that has not moved since crew updates were turned on is only a baseline", async () => {
    file("old", at(-10));
    store.setTaskState("old", "cancelled", at(-5));
    follow(t0);
    await pass(at(1));
    expect(asked).toEqual([]);
    expect(followEvents()).toEqual([]);
  });

  test("a baseline is remembered, so a later transition that stamps no time still wakes the lead", async () => {
    file("old", at(-10));
    follow(t0);
    await pass(at(1));
    expect(asked).toEqual([]);
    expect(followEvents()).toEqual([]);
    // A settled review, a lifted hold or a cleared stop changes what the task reads without touching its own times.
    store.handle.prepare("UPDATE task SET state = 'cancelled' WHERE id = 'old'").run();
    await pass(at(2));
    expect(followEvents()).toEqual([["old", "cancelled"]]);
    expect(asked).toHaveLength(1);
    expect(JSON.parse(asked[0]!.context.split("\n")[1]!)).toEqual([expect.objectContaining({ task: "old", state: "cancelled" })]);
  });

  const grantId = () => Number(store.handle.prepare("SELECT MAX(id) AS id FROM action_ledger WHERE action = 'lead follow configured'").get()!["id"]);
  const ledger = (action: string, taskId: string | null, now: Date, outcome = "{}") =>
    store.recordAction({ at: now.toISOString(), actor: who.name, repo: taskId === null ? null : repo, taskId, runId: null, action, outcome, source: "work" });
  const READY = "The lead will respond when a result or decision is ready, or a task is cancelled.";

  test("a legacy crew update the old batches recorded but never handed the lead is still news", async () => {
    follow(t0);
    file("sent", at(1));
    file("queued", at(1));
    store.setTaskState("sent", "cancelled", at(2));
    store.setTaskState("queued", "cancelled", at(2));
    // The old private path: both updates recorded, one batch of only the first handed over and acknowledged later.
    const sent = ledger(`lead update:${grantId()}`, "sent", at(3));
    ledger(`lead update:${grantId()}`, "queued", at(3));
    const batch = ledger(`lead batch:${grantId()}`, null, at(4));
    store.setServiceCursor(`lead:${grantId()}:events`, sent, at(4));
    store.setServiceCursor(`lead:${grantId()}:delivery`, batch, at(4));

    await pass(at(5));
    expect(followEvents()).toEqual([["queued", "cancelled"]]);
    expect(asked).toHaveLength(1);
    expect(JSON.parse(asked[0]!.context.split("\n")[1]!)).toEqual([expect.objectContaining({ task: "queued", state: "cancelled" })]);
  });

  test("a waiting status returns to ready once a pass leaves no page unacknowledged", async () => {
    follow(t0);
    ledger(`lead delivery status:${grantId()}`, null, at(1), "Crew updates are waiting: The saved delivery page is invalid.");
    file("login", at(1));
    await pass(at(2));
    expect(asked).toEqual([]);
    expect(leadFollowStatus(store, who.name).detail).toBe(READY);
  });

  test("a failure stays visible while its page is still unacknowledged", async () => {
    follow(t0);
    file("login", at(1));
    store.setTaskState("login", "cancelled", at(2));
    answer = "throws";
    await pass(at(3));
    // No provider: the page is read but not handed over, so the lead is still waiting on it.
    await runLeadFollowPass({ store, repos: () => [repo], evidenceRoot: root, clock: () => at(4), provider: () => null, runTurn });
    expect(leadFollowStatus(store, who.name).detail).toContain("the last update check failed");
  });

  test("a change that asks nothing of the lead is acknowledged without a model turn", async () => {
    follow(t0);
    file("login", at(1));
    await pass(at(2));
    expect(followEvents()).toHaveLength(1);
    expect(followEvents()[0]![1]).not.toBe("cancelled");
    expect(asked).toEqual([]);
    // Acknowledged, not waiting: a later cancellation is the next page's only event.
    store.setTaskState("login", "cancelled", at(3));
    await pass(at(4));
    expect(asked).toHaveLength(1);
  });

  test("a refused turn keeps the saved page, and the next pass replays the same request", async () => {
    follow(t0);
    file("login", at(1));
    store.setTaskState("login", "cancelled", at(2));
    answer = "refused";
    await pass(at(3));
    expect(leadFollowStatus(store, who.name).detail).toBe("Crew updates are waiting: The lead is offline.");
    answer = "answered";
    await pass(at(4));
    expect(asked.map(one => one.requestId)).toEqual([asked[0]!.requestId, asked[0]!.requestId]);
    expect(leadFollowStatus(store, who.name).detail).toBe("Crew updates handled.");
  });

  test("a failing pass is said where follow status is read, in plain words and without private paths", async () => {
    follow(t0);
    file("login", at(1));
    store.setTaskState("login", "cancelled", at(2));
    answer = "throws";
    await pass(at(3));
    const detail = leadFollowStatus(store, who.name).detail;
    expect(detail).toMatch(/^Crew updates are waiting: the last update check failed \(.*\)\. It retries in a few seconds\.$/);
    expect(detail).not.toContain("/Users/someone");
    // Nothing was acknowledged: the same page is handed to the lead once it works again.
    answer = "answered";
    await pass(at(4));
    expect(asked.map(one => one.requestId)).toEqual([asked[0]!.requestId, asked[0]!.requestId]);

    // A failure outside any one conversation (the service's own pass) says so too,
    recordLeadFollowFailure(store, new Error("database is locked"), at(5));
    expect(leadFollowStatus(store, who.name).detail).toContain("the last update check failed (database is locked)");
    // and the next clean pass, with nothing new, clears it.
    await pass(at(6));
    expect(leadFollowStatus(store, who.name).detail).toBe("The lead will respond when a result or decision is ready, or a task is cancelled.");
  });

  describe("a sweep's burst (docs/plans/lead-fan-out.md)", () => {
    const sweepOf = (ids: string[], now: Date) => {
      const sweep = store.createSweep({ owner: "operator", thread, repo, title: "Bug sweep", brief: "Reproduce first.", maxParallel: 3, proposal: null }, now);
      ids.forEach((id, index) => store.addSweepTask(sweep, id, index, id));
      return sweep;
    };

    test("is held until the window passes, then lands on ONE page, grouped by sweep", async () => {
      follow(t0);
      for (const id of ["a", "b", "c"]) file(id, at(1));
      sweepOf(["a", "b", "c"], at(1));
      // c is being built: the sweep is still working while a and b settle.
      const claimed = acquire(store, store.refFor("built-in", "c").id, "builder-1", { token: "tok-builder-1", now: at(1), ttlMs: 60 * 60_000 });
      if (!claimed.ok) throw Error(`claim: ${claimed.reason}`);
      await pass(at(2));
      store.setTaskState("a", "cancelled", at(3));
      await pass(at(4));
      expect(asked).toHaveLength(0);
      store.setTaskState("b", "cancelled", at(5));
      await pass(at(5.5));
      expect(asked).toHaveLength(0);
      // The window (2 minutes from the first held pass at 4) has passed: one page, both, and the sweep's line.
      await pass(at(6.5));
      expect(asked).toHaveLength(1);
      expect(asked[0]!.context).toContain("ONE line per sweep");
      expect(asked[0]!.context).toMatch(/"title":"Bug sweep".*"line":"2 of 3 settled"/);
      const updates = JSON.parse(asked[0]!.context.split("\n")[1]!) as { task: string }[];
      expect(updates.map(one => one.task).sort()).toEqual(["a", "b"]);
    });

    test("a non-sweep update is never held", async () => {
      follow(t0);
      for (const id of ["a", "b"]) file(id, at(1));
      file("solo", at(1));
      sweepOf(["a", "b"], at(1));
      await pass(at(2));
      store.setTaskState("solo", "cancelled", at(3));
      await pass(at(4));
      expect(asked).toHaveLength(1);
    });

    test("a sweep whose children have all settled is not held", async () => {
      follow(t0);
      for (const id of ["a", "b"]) file(id, at(1));
      sweepOf(["a", "b"], at(1));
      await pass(at(2));
      store.setTaskState("a", "cancelled", at(3));
      store.setTaskState("b", "cancelled", at(3));
      await pass(at(4));
      expect(asked).toHaveLength(1);
    });
  });
});
