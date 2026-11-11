/** Home's data (docs/plans/live-pages-and-home.md B1.2): each group's count is the work index's exact total for its ask,
 * past the rows the page lists; a row no other group fits is under Needs you; what finished today is filtered before
 * the limit; the lead's last message is one plain line. Over a throwaway store, never a person's setup. */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { register } from "../runner.js";
import { addApprover, approve, propose } from "../scope.js";
import { openStore, type Store } from "../store.js";
import { workIndexPage } from "../work-index.js";
import { HOME_NEEDS_SHOWN, homeView, leadLineOf, startOfToday, type HomeFacts } from "./home.js";

const NOW = new Date(2026, 10, 5, 12, 0, 0);
const REPO = "/repos/home-groups";
const facts = (store: Store, repos: readonly string[], over: Partial<HomeFacts> = {}): HomeFacts => ({
  store, now: NOW, access: { principal: "operator", repos }, project: null, projects: repos.map(path => ({ name: path.split("/").pop()!, path })),
  chat: true, canAnswer: true, closedDoor: () => null, ...over,
});

describe("the groups", () => {
  let store: Store;
  const APPROVALS = HOME_NEEDS_SHOWN + 5;
  beforeAll(() => {
    store = openStore(":memory:");
    register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok" });
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
    if (!addApprover(store, "sam", NOW).ok) throw new Error("sam");
    const filed = (id: string, at: Date) => {
      store.createTask({ id, title: `Task ${id}` }, at);
      store.placeTask(store.refFor("built-in", id).id, REPO, {}, at);
    };
    // More plans waiting for a yes than the page lists, each a minute apart.
    for (let i = 0; i < APPROVALS; i++) {
      const at = new Date(NOW.getTime() - (i + 10) * 60_000);
      filed(`plan-${i}`, at);
      propose(store, { taskId: `plan-${i}`, goal: `Do ${i}`, touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: at });
    }
    // A build that failed: something went wrong.
    filed("broke", NOW);
    store.setTaskState("broke", "failed", NOW);
    // A task with no plan yet fits none of the four asks: Needs you.
    filed("unplanned", NOW);
  });
  afterAll(() => store.close());

  test("each group's count is the exact total for its ask, past the rows listed", () => {
    const view = homeView(facts(store, [REPO]));
    const byKey = Object.fromEntries(view.groups.map(group => [group.key, group]));
    expect(byKey["approve"]?.count).toBe(APPROVALS);
    expect(byKey["approve"]!.rows.length).toBeLessThan(APPROVALS);
    expect(byKey["approve"]!.rows.every(row => row.ask === "approve" && row.reason === null)).toBe(true);
    // The heading and the groups read the same total, and the page lists only its limit.
    const needs = view.counts.find(one => one.key === "needs")!.value;
    expect(view.groups.reduce((sum, group) => sum + group.count, 0)).toBe(needs);
    expect(view.say).toBe(`${needs} tasks need you`);
    expect(view.groups.flatMap(group => group.rows).length).toBe(HOME_NEEDS_SHOWN);
    // The groups come in their one order, each with its own heading.
    expect(view.groups.map(group => [group.key, group.label])).toEqual([["approve", "Approve a plan"], ["wrong", "Something went wrong"], ["other", "Needs you"]]);
    // The work index counts per ask over every row in view, the same totals.
    const page = workIndexPage(store, NOW, { principal: "operator", repos: [REPO] }, { view: "needs-you", limit: 1 });
    expect(page.asks).toEqual({ approve: APPROVALS, answer: 0, wrong: 1, review: 0, other: 1 });
    expect(page.items[0]!.askGroup).not.toBeNull();
  });

  test("the fallback group holds what fits none of the four, and only a failed row says why", () => {
    const view = homeView(facts(store, [REPO]));
    const other = view.groups.find(group => group.key === "other")!;
    const wrong = view.groups.find(group => group.key === "wrong")!;
    expect(other.count).toBe(1);
    expect(wrong.count).toBe(1);
    // Listed or not, nothing is lost: what the page doesn't list is still counted under its heading.
    for (const group of [other, wrong]) expect(group.rows.length).toBeLessThanOrEqual(group.count);
    for (const row of view.groups.flatMap(group => group.rows)) expect(row.reason !== null, row.id).toBe(row.ask === "wrong");
  });

  test("the lead's last message is read only when chat is allowed here, as one plain line", () => {
    const message = { text: "**Done.** The pagination build is on step 2 of 3.\n\nSee `ledger.ts` and [the plan](/t/a).", at: new Date(NOW.getTime() - 4 * 60_000).toISOString() };
    expect(homeView(facts(store, [REPO], { leadMessage: message })).lastLead).toEqual({ text: "Done. The pagination build is on step 2 of 3. See ledger.ts and the plan.", age: "4m ago", href: "/chat" });
    expect(homeView(facts(store, [REPO], { leadMessage: message, chat: false })).lastLead).toBeNull();
    expect(homeView(facts(store, [REPO], { leadMessage: null })).lastLead).toBeNull();
    expect(leadLineOf("x".repeat(400)).length).toBeLessThanOrEqual(160);
  });
});

describe("finished today", () => {
  let store: Store, token = "";
  const DONE_TODAY = 10;
  /** A finished task its approver marked complete at `at`: the work index's own Completed row. */
  const completed = (id: string, at: Date) => {
    const before = new Date(at.getTime() - 30 * 60_000);
    store.createTask({ id, title: `Done ${id}` }, before);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO, {}, before);
    const proposed = propose(store, { taskId: id, goal: `Do ${id}`, touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: before });
    const yes = approve(store, id, "sam", before, proposed.digest, token);
    if (!yes.ok) throw new Error(yes.reason);
    const authority = store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `b/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: before });
    store.stampRun(run, { scopeDigest: proposed.digest });
    store.handle.prepare("UPDATE run SET head_revision = ? WHERE id = ?").run("a".repeat(40), run);
    store.finishRun(run, { outcome: "built", now: before });
    store.setTaskState(id, "done", before);
    store.handle.prepare("INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source) VALUES(?,?,?,?,?,?,?,?)")
      .run(at.toISOString(), "operator:sam", REPO, id, run, "assignment handoff checked", "b".repeat(64), "work");
  };
  beforeAll(() => {
    store = openStore(":memory:");
    register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: NOW, newToken: () => "tok" });
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
    const sam = addApprover(store, "sam", NOW);
    if (!sam.ok) throw new Error("sam");
    token = sam.token;
    // More finished today than Home lists, the newest last filed; and two from before midnight.
    for (let i = 0; i < DONE_TODAY; i++) completed(`today-${i}`, new Date(NOW.getTime() - (DONE_TODAY - i) * 60 * 60_000 + 60 * 60_000));
    completed("yesterday-1", new Date(startOfToday(NOW).getTime() - 60_000));
    completed("yesterday-2", new Date(startOfToday(NOW).getTime() - 2 * 60 * 60_000));
  });
  afterAll(() => store.close());

  test("the Completed list is filtered to today before its limit, and the figure counts every one", () => {
    const access = { principal: "operator" as const, repos: [REPO] };
    const since = startOfToday(NOW).toISOString();
    const all = workIndexPage(store, NOW, access, { view: "completed", limit: 100 });
    expect(all.totals.completed).toBe(DONE_TODAY + 2);
    // A limit of one still counts every one finished today, and lists the newest.
    const one = workIndexPage(store, NOW, access, { view: "completed", limit: 1, completedSince: since });
    expect(one.completedSince).toBe(DONE_TODAY);
    expect(one.items.map(item => item.rootId)).toEqual([`today-${DONE_TODAY - 1}`]);
    // Home lists the newest eight of today's ten, never one from yesterday, and its figure says ten.
    const view = homeView(facts(store, [REPO]));
    expect(view.finishedToday.count).toBe(DONE_TODAY);
    expect(view.finishedToday.rows.map(row => row.id)).toEqual(Array.from({ length: 8 }, (_, n) => `today-${DONE_TODAY - 1 - n}`));
    expect(view.finishedToday.rows.every(row => row.state === "done" && row.ask === null)).toBe(true);
    // With only yesterday's left in the window, nothing is listed and the figure is zero.
    const later = workIndexPage(store, NOW, access, { view: "completed", limit: 100, completedSince: new Date(NOW.getTime() + 60_000).toISOString() });
    expect(later.items).toEqual([]);
    expect(later.completedSince).toBe(0);
  });
});
