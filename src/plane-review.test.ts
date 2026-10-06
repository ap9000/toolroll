/**
 * The morning plane review, against a real store: a seeded day with mixed failures makes one card per distinct
 * problem (counts, run ids, evidence, secrets hidden), a second look the same day adds nothing, a clean day makes
 * nothing, the same problem the next morning joins its card, and the flow's insights say which causes recur.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { flowFromSteps } from "./flows.js";
import { addFlowTriggerTo, checkFlowTriggerNow, describeTrigger, runFlowTriggers, triggerConfigOf, type TriggerIo } from "./flow-triggers.js";
import { flowInsights } from "./flow-insights.js";
import { recordIntegrationCheck } from "./integrations.js";
import { longPersonWaits, reviewPlane, runCause } from "./plane-review.js";
import { flowView } from "./flows-ui.js";

const DAY1 = new Date("2026-09-30T07:30:00.000Z");
const DAY2 = new Date("2026-10-01T07:30:00.000Z");
const hoursBefore = (at: Date, hours: number) => new Date(at.getTime() - hours * 3_600_000);
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";

let dir: string, repo: string, store: Store;
const io: TriggerIo = { gh: async () => ({ code: 1, stdout: "", stderr: "unused" }), fetch: (async () => { throw new Error("unused"); }) as unknown as typeof fetch, dir: null };

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-plane-review-")));
  repo = join(dir, "toolroll");
  store = openStore(join(dir, "orders.db"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
/** A task in the project, and a finished run of it. */
function run(finished: Date, fields: { outcome: string; reason?: string | null; handoff?: string | null; terminalClass?: string | null; check?: "passed" | "failed"; release?: boolean }): number {
  const id = `t${++seq}`;
  store.createTask({ id, title: `Task ${seq}` }, hoursBefore(finished, 1));
  const ref = store.refFor("built-in", id).id;
  store.handle.prepare("UPDATE task_ref SET repo = ? WHERE id = ?").run(repo, ref);
  // Settled, so only the runs speak: a task left open would be waiting on a person too.
  store.handle.prepare("UPDATE task SET state = 'cancelled' WHERE id = ?").run(id);
  const inserted = store.handle.prepare("INSERT INTO run (task_ref, lease_id, runner, provider, branch, worktree, outcome, reason, handoff, terminal_class, started_at, finished_at) VALUES (?, ?, 'worker', 'claude', ?, '/tmp/wt', ?, ?, ?, ?, ?, ?)")
    .run(ref, `lease-${seq}`, `toolroll/${id}`, fields.outcome, fields.reason ?? null, fields.handoff ?? null, fields.terminalClass ?? null, hoursBefore(finished, 1).toISOString(), finished.toISOString());
  const runId = Number(inserted.lastInsertRowid);
  if (fields.check !== undefined) store.handle.prepare("INSERT INTO run_check (run, status, release, recorded_at, line) VALUES (?, ?, ?, ?, ?)").run(runId, fields.check, fields.release === true ? 1 : 0, finished.toISOString(), fields.check === "failed" ? "npm test: 2 failing" : "all passed");
  return runId;
}

/** A task in the project, last touched `at`, in `state`. */
function task(id: string, title: string, at: Date, state: "queued" | "running" | "done" = "queued"): number {
  store.createTask({ id, title }, at);
  if (state !== "queued") store.setTaskState(id, state, at);
  const ref = store.refFor("built-in", id).id;
  store.handle.prepare("UPDATE task_ref SET repo = ? WHERE id = ?").run(repo, ref);
  return ref;
}

/** Approved and marked running, but no worker holds it: the dispatch is stuck. */
function stuckDispatch(id: string, title: string, at: Date): void {
  task(id, title, at, "running");
  store.handle.prepare("INSERT INTO task_scope (task_id, goal, proposed_at, digest, approved_digest, approved_at, approved_by) VALUES (?, 'Do it.', ?, 'd', 'd', ?, 'alex')").run(id, at.toISOString(), at.toISOString());
  store.handle.prepare("UPDATE task SET updated_at = ? WHERE id = ?").run(at.toISOString(), id);
}

function seedMixedDay(): Record<string, number> {
  const at = (hours: number) => hoursBefore(DAY1, hours);
  const ids = {
    provider: run(at(20), { outcome: "failed", reason: "retryable-infra", handoff: "the provider harness never initialized — 503 from the API" }),
    timeout1: run(at(18), { outcome: "failed", reason: "timeout", handoff: "the builder ran past 45 minutes" }),
    timeout2: run(at(10), { outcome: "failed", reason: "retryable-infra", handoff: "the builder made no observable progress for 20 minutes" }),
    signIn: run(at(9), { outcome: "failed", reason: "auth-expired", terminalClass: "auth-expired" }),
    check: run(at(8), { outcome: "built", reason: "handoff", check: "failed" }),
    quit: run(at(7), { outcome: "failed", reason: "no-handoff", handoff: `The agent stopped before handing off. It printed ANTHROPIC_API_KEY=${SECRET}` }),
    orphan: run(at(6), { outcome: "failed", reason: "interrupted" }),
    release: run(at(5), { outcome: "built", reason: "handoff", check: "failed", release: true }),
  };
  // Not problems: a clean build, a run a person stopped, and yesterday's failure.
  run(at(4), { outcome: "built", reason: "handoff", check: "passed" });
  const stopped = run(at(3), { outcome: "failed", reason: "interrupted" });
  store.handle.prepare("INSERT INTO run_stop (run, task_ref, requested_by, requested_via, requested_at) SELECT id, task_ref, 'alex', 'web', ? FROM run WHERE id = ?").run(at(3).toISOString(), stopped);
  run(at(30), { outcome: "failed", reason: "timeout" });
  // A lease the worker never gave back.
  const leased = store.handle.prepare("SELECT task_ref FROM run WHERE id = ?").get(ids.provider)!["task_ref"];
  store.handle.prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at, released_by) VALUES ('lease-stuck', ?, 2, 'worker-b', ?, ?, ?, ?, 'reaped')")
    .run(leased, at(12).toISOString(), at(11).toISOString(), at(12).toISOString(), at(10).toISOString());
  // A task dispatched two days ago that no worker ever took up.
  stuckDispatch("waiting", "Rotate the release key", hoursBefore(DAY1, 50));
  // An integration that is Broken, with a token in what it said.
  recordIntegrationCheck(store, "github", { outcome: "failed", problem: `gh said: bad credentials for ghp_${"a".repeat(36)}` }, at(2));
  // What the worker counted as broke.
  const episode = store.startWatchEpisode({ repo, runner: "worker", incarnation: "inc-1" }, at(6));
  store.handle.prepare("UPDATE watch_episode SET broke = 2, ended_at = ? WHERE id = ?").run(at(1).toISOString(), episode);
  return ids;
}

function planeFlow(): { flow: number; trigger: number } {
  const flow = store.createFlow({ repo, name: "Morning plane review", definitionJson: JSON.stringify(flowFromSteps([{ id: "look", title: "Needs a look", kind: "inbox" }], null)), by: "alex" }, hoursBefore(DAY1, 2));
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "plane-review", at: "07:30", timeZone: "UTC" }, "alex", hoursBefore(DAY1, 2), null);
  if (!made.ok) throw new Error(made.message);
  return { flow, trigger: made.id };
}

describe("the morning plane review", () => {
  test("c1: a seeded day with mixed failures makes one card per distinct problem, once, with counts, run ids and evidence, secrets hidden", async () => {
    const ids = seedMixedDay();
    const { flow, trigger } = planeFlow();
    const row = store.getFlowTrigger(trigger)!;
    expect(row.kind).toBe("schedule");
    expect(triggerConfigOf(row)).toEqual({ kind: "plane-review", schedule: "daily:07:30", zone: null });
    expect(row.nextAt).toBe(DAY1.toISOString());
    expect(describeTrigger(triggerConfigOf(row)!, store)).toMatch(/^Every day at 07:30: reviews the last 24 hours/);

    // Not yet due: nothing.
    expect((await runFlowTriggers(store, repo, hoursBefore(DAY1, 1), io)).added).toBe(0);
    const pass = await runFlowTriggers(store, repo, DAY1, io);
    const cards = store.flowCards(flow, true);
    const byTitle = Object.fromEntries(cards.map(card => [card.title, card]));
    expect(Object.keys(byTitle).sort()).toEqual([
      "Agents quit without a handoff", "Integration broken: github", "Leases got stuck", "Processes were left behind", "Release checks failed",
      "Runs failed on a provider error", "Runs failed their checks", "Runs stopped: sign-in expired", "Runs timed out",
      "Tasks waited over a day: Reconcile unfinished work", "The worker logged work as broke",
    ].sort());
    expect(pass.added).toBe(cards.length);
    expect(cards.every(card => card.stage === "look" && card.source?.kind === "plane-review")).toBe(true);
    expect(byTitle["Runs timed out"]!.description).toContain(`2 runs in the last 24 hours (runs ${ids.timeout1}, ${ids.timeout2}).`);
    expect(byTitle["Runs timed out"]!.description).toContain(`- Run ${ids.timeout1} (task`);
    expect(byTitle["Runs timed out"]!.description).toContain("the builder ran past 45 minutes");
    expect(byTitle["Processes were left behind"]!.description).toContain(`(run ${ids.orphan})`);
    expect(byTitle["Release checks failed"]!.description).toContain(`Run ${ids.release} (task t8): npm test: 2 failing`);
    expect(byTitle["Runs failed their checks"]!.description).toContain(`(run ${ids.check})`);
    expect(byTitle["The worker logged work as broke"]!.description).toContain("2 times in the last 24 hours");
    expect(byTitle["Tasks waited over a day: Reconcile unfinished work"]!.description).toContain("Task waiting “Rotate the release key”: 2 days waiting");
    expect(byTitle["Agents quit without a handoff"]!.description).toContain("[hidden");
    for (const card of cards) {
      expect(card.description).not.toContain(SECRET);
      expect(card.description).not.toContain("ghp_aaaa");
    }
    expect(store.getFlowTrigger(trigger)!.lastOutcome).toBe(`Added ${cards.length} cards.`);
    expect(store.getFlowTrigger(trigger)!.nextAt).toBe(DAY2.toISOString());

    // Looking again the same morning adds nothing.
    expect(await checkFlowTriggerNow(store, store.getFlowTrigger(trigger)!, new Date(DAY1.getTime() + 60_000), io)).toEqual({ ok: true, said: "Nothing new since this morning's review." });
    expect(store.flowCards(flow, true)).toHaveLength(cards.length);
  });

  test("c1: a clean day makes no cards and tells nobody", async () => {
    run(hoursBefore(DAY1, 5), { outcome: "built", reason: "handoff", check: "passed" });
    const { flow, trigger } = planeFlow();
    expect(reviewPlane(store, DAY1)).toEqual([]);
    const pass = await runFlowTriggers(store, repo, DAY1, io);
    expect(pass).toEqual({ added: 0, checked: 0, problems: [] });
    expect(store.flowCards(flow, true)).toEqual([]);
    expect(store.getFlowTrigger(trigger)!.lastOutcome).toBe("A clean day: nothing to fix.");
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM notification").get()!["n"]).toBe(0);
  });

  test("c1: the same problem the next morning joins its card; one whose card is finished starts a new one; insights show what recurs", async () => {
    const first = run(hoursBefore(DAY1, 3), { outcome: "failed", reason: "timeout", handoff: "the builder ran past 45 minutes" });
    const signIn = run(hoursBefore(DAY1, 2), { outcome: "failed", reason: "auth-expired" });
    const { flow } = planeFlow();
    await runFlowTriggers(store, repo, DAY1, io);
    const [timeout, expired] = ["Runs timed out", "Runs stopped: sign-in expired"].map(title => store.flowCards(flow, true).find(card => card.title === title)!);
    expect(timeout!.description).toContain(`(run ${first})`);
    expect(expired!.description).toContain(`(run ${signIn})`);
    // Someone finished the sign-in card; the timeouts are still being looked at.
    store.updateFlowCard(expired!.id, { state: "done" }, new Date(DAY1.getTime() + 3_600_000));

    const again = run(hoursBefore(DAY2, 4), { outcome: "failed", reason: "timeout", handoff: "the builder ran past 45 minutes" });
    const expiredAgain = run(hoursBefore(DAY2, 3), { outcome: "failed", reason: "auth-expired" });
    const pass = await runFlowTriggers(store, repo, DAY2, io);
    expect(pass.added).toBe(1);
    const cards = store.flowCards(flow, true);
    expect(cards.filter(card => card.title === "Runs timed out")).toHaveLength(1);
    expect(store.flowComments(timeout!.id).map(one => [one.author, one.body.split("\n")[0]])).toEqual([["Plane review", `Again — Oct 1: 1 run in the last 24 hours (run ${again}).`]]);
    const signIns = cards.filter(card => card.title === "Runs stopped: sign-in expired");
    expect(signIns).toHaveLength(2);
    expect(signIns.find(card => card.state === "active")!.description).toContain(`(run ${expiredAgain})`);

    const recurring = flowInsights(store, store.getFlow(flow)!, DAY2, 30).recurring;
    expect(recurring.map(one => [one.problem, one.days, one.lastSeen])).toEqual([["run/sign-in", 2, "2026-10-01"], ["run/timeout", 2, "2026-10-01"]]);
    expect(recurring.find(one => one.problem === "run/timeout")!.card).toBe(timeout!.id);
  });

  test("each finished run's cause", () => {
    const base = { outcome: "failed", reason: null, terminalClass: null, handoff: null, check: null, stopped: false };
    expect(runCause({ ...base, reason: "provider-init" })).toBe("provider");
    expect(runCause({ ...base, terminalClass: "usage-exhausted" })).toBe("plan-limit");
    expect(runCause({ ...base, reason: "interrupted", stopped: true })).toBeNull();
    expect(runCause({ ...base, outcome: "no-change", reason: "handoff" })).toBe("no-change");
    expect(runCause({ ...base, outcome: "built", reason: "handoff", check: "passed" })).toBeNull();
    expect(runCause({ ...base, reason: "agent" })).toBe("other");
  });

  test("a plane review's time is checked", () => {
    const flow = store.createFlow({ repo, name: "Review", definitionJson: JSON.stringify(flowFromSteps([{ title: "Look", kind: "inbox" }], null)), by: "alex" }, DAY1);
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "plane-review", at: "25:00" }, "alex", DAY1, null)).toMatchObject({ ok: false, message: expect.stringMatching(/^at: say the time it reviews the day as HH:MM/) });
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "plane-review", timeZone: "Europe/London" }, "alex", DAY1, null) as { id: number };
    expect(triggerConfigOf(store.getFlowTrigger(made.id)!)).toEqual({ kind: "plane-review", schedule: "daily:07:30@Europe/London", zone: null });
  });
});

describe("waits on a person are not code problems", () => {
  test("c1: an unopened result and decision, approval or hold waits make no card and start no flow", async () => {
    task("unopened", "Rename the export button", hoursBefore(DAY1, 48), "done");
    const planned = task("planned", "Split the settings page", hoursBefore(DAY1, 30));
    store.handle.prepare("UPDATE task_ref SET plan = 'drafted' WHERE id = ?").run(planned);
    const held = task("held", "Pause the nightly sync", hoursBefore(DAY1, 30));
    store.handle.prepare("INSERT INTO hold (task_ref, owner_kind, owner_id, reason, held_at) VALUES (?, 'operator', 'alex', 'waiting on legal', ?)").run(held, hoursBefore(DAY1, 30).toISOString());
    task("unscoped", "Write the release notes", hoursBefore(DAY1, 30));
    task("unapproved", "Bump the minimum Node version", hoursBefore(DAY1, 30));
    store.handle.prepare("INSERT INTO task_scope (task_id, goal, proposed_at, digest) VALUES ('unapproved', 'Bump it.', ?, 'd')").run(hoursBefore(DAY1, 30).toISOString());

    expect(reviewPlane(store, DAY1)).toEqual([]);
    const { flow, trigger } = planeFlow();
    expect((await runFlowTriggers(store, repo, DAY1, io)).added).toBe(0);
    expect(store.flowCards(flow, true)).toEqual([]);
    // None of them has waited over three days, so the summary is a clean day.
    expect(store.getFlowTrigger(trigger)!.lastOutcome).toBe("A clean day: nothing to fix.");
  });

  test("c2: a plan waiting 4 days is mentioned once in the summary, linked to Needs you, and files nothing", async () => {
    const planned = task("planned", "Split the settings page", hoursBefore(DAY1, 4 * 24));
    store.handle.prepare("UPDATE task_ref SET plan = 'drafted' WHERE id = ?").run(planned);
    task("old-result", "Rename the export button", hoursBefore(DAY1, 5 * 24), "done");
    task("fresh-result", "Fix the footer", hoursBefore(DAY1, 36), "done");
    const failure = run(hoursBefore(DAY1, 2), { outcome: "failed", reason: "timeout", handoff: "the builder ran past 45 minutes" });

    expect(longPersonWaits(store, DAY1)).toEqual({ results: 1, tasks: 1 });
    const { flow, trigger } = planeFlow();
    expect((await runFlowTriggers(store, repo, DAY1, io)).added).toBe(1);
    expect(store.flowCards(flow, true).map(card => card.title)).toEqual(["Runs timed out"]);
    expect(store.flowCards(flow, true)[0]!.description).toContain(`(run ${failure})`);
    expect(store.getFlowTrigger(trigger)!.lastOutcome).toBe("Added 1 card. 1 result and 1 task have waited over 3 days for you.");
    const shown = flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null).triggers[0]!;
    expect(shown.statusLink).toEqual({ label: "Needs you", href: "/work?view=needs-you" });

    // A plan alone, the next morning: a clean day that still mentions it.
    store.handle.prepare("UPDATE task SET state = 'cancelled' WHERE id = 'old-result'").run();
    await runFlowTriggers(store, repo, DAY2, io);
    expect(store.flowCards(flow, true)).toHaveLength(1);
    expect(store.getFlowTrigger(trigger)!.lastOutcome).toBe("A clean day: nothing to fix. 1 task has waited over 3 days for you.");
  });

  test("c3: a stuck dispatch still makes a card", async () => {
    stuckDispatch("stuck", "Rotate the release key", hoursBefore(DAY1, 30));
    const { flow, trigger } = planeFlow();
    expect((await runFlowTriggers(store, repo, DAY1, io)).added).toBe(1);
    const [card] = store.flowCards(flow, true);
    expect(card!.title).toBe("Tasks waited over a day: Reconcile unfinished work");
    expect(card!.description).toContain("Task stuck “Rotate the release key”: 1 day waiting");
    expect(store.getFlowTrigger(trigger)!.lastOutcome).toBe("Added 1 card.");
    expect(flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null).triggers[0]!.statusLink).toBeNull();
  });
});
