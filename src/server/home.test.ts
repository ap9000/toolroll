/** Home's data (docs/plans/live-pages-and-home.md B1.2): each group's count is the work index's exact total for its ask,
 * past the rows the page lists; a row no other group fits is under Needs you; what finished today is filtered before
 * the limit; the lead's last message is one plain line. Over a throwaway store, never a person's setup. */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { register } from "../runner.js";
import { addApprover, approve, propose } from "../scope.js";
import { openStore, type Store } from "../store.js";
import { workIndexPage } from "../work-index.js";
import { HOME_NEEDS_SHOWN, homeView, leadLineOf, startOfToday, type HomeFacts } from "./home.js";
import { NO_HOME_ASKS, releaseAsks } from "./home-asks.js";
import { releaseFixture, RELEASE_NOW, VERSION, type ReleaseFixture } from "../../test/release-fixture.js";
import { recordReleaseCi } from "../release-approval.js";
import { allowAutoPublish, holdAutoPublish } from "../release-auto.js";
import { releaseTermsFor } from "../release-carry.js";

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
    expect(page.asks).toEqual({ release: 0, approve: APPROVALS, answer: 0, wrong: 1, review: 0, other: 1 });
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

describe("releases", () => {
  // A release waiting for its person (its sealed scope, never its title), beside more plans than the page lists.
  let f: ReleaseFixture;
  const PLANS = HOME_NEEDS_SHOWN + 5;
  const access = () => ({ principal: "operator" as const, repos: [f.repo] });
  const read = (approver: boolean, over: Partial<HomeFacts> = {}) => homeView({ store: f.store, now: RELEASE_NOW, access: access(), project: null, projects: [{ name: "project", path: f.repo }],
    chat: false, canAnswer: approver, approver, closedDoor: () => null,
    asks: { ...NO_HOME_ASKS, ...releaseAsks(f.store, RELEASE_NOW, access(), null, approver) }, ...over });
  beforeAll(() => {
    f = releaseFixture({ approve: false, candidate: { "src/x.js": "1\n" } });
    for (let i = 0; i < PLANS; i++) {
      const at = new Date(RELEASE_NOW.getTime() - (i + 10) * 60_000);
      f.store.createTask({ id: `plan-${i}`, title: `Task ${i}` }, at);
      f.store.placeTask(f.store.refFor("built-in", `plan-${i}`).id, f.repo, {}, at);
      propose(f.store, { taskId: `plan-${i}`, goal: `Do ${i}`, touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: at });
    }
  });
  afterAll(() => f.close());

  test("the work index names a release from its sealed state: its own ask group, counted once, exact past the page", () => {
    const page = workIndexPage(f.store, RELEASE_NOW, access(), { view: "needs-you", limit: 1 });
    expect(page.asks).toEqual({ release: 1, approve: PLANS, answer: 0, wrong: 0, review: 0, other: 0 });
    expect(page.totals["needs-you"]).toBe(PLANS + 1);
    const listed = workIndexPage(f.store, RELEASE_NOW, access(), { view: "needs-you", limit: 100 }).items;
    expect(listed.filter(one => one.askGroup === "release").map(one => one.rootId)).toEqual([f.taskId]);
    // A plan titled like a release, or with a release-shaped id, is still a plan.
    f.store.createTask({ id: "release-9.9.9-abcdef1", title: "Release 9.9.9" }, RELEASE_NOW);
    f.store.placeTask(f.store.refFor("built-in", "release-9.9.9-abcdef1").id, f.repo, {}, RELEASE_NOW);
    propose(f.store, { taskId: "release-9.9.9-abcdef1", goal: "Release it", touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: RELEASE_NOW });
    try {
      expect(workIndexPage(f.store, RELEASE_NOW, access(), { view: "needs-you", limit: 1 }).asks).toMatchObject({ release: 1, approve: PLANS + 1 });
    } finally { f.store.setTaskState("release-9.9.9-abcdef1", "cancelled", RELEASE_NOW); }
  });

  test("an approver reads a release in Approve a release with one link to its sheet, never a plan approval", () => {
    const view = read(true);
    expect(view.groups.map(group => [group.key, group.label, group.count])).toEqual([["release", "Approve a release", 1], ["approve", "Approve a plan", PLANS]]);
    expect(view.groups.reduce((sum, group) => sum + group.count, 0)).toBe(view.counts.find(one => one.key === "needs")!.value);
    const release = view.groups[0]!.rows;
    expect(release).toEqual([expect.objectContaining({ id: f.taskId, ask: "release", href: `/t/${f.taskId}/release`, question: null, line: `Version ${VERSION} waits for your approval.`,
      action: { label: "Review the release", href: `/t/${f.taskId}/release` } })]);
    expect(view.groups[1]!.rows.some(row => row.id === f.taskId)).toBe(false);
    expect(view.say).toBe(`${PLANS + 1} tasks need you`);
  });

  test("a release that can't take a yes says why, in the sheet's words", () => {
    recordReleaseCi(f.store, { taskId: f.taskId, candidate: f.approved, state: "failed", failed: ["unit"], runs: [{ id: 1, name: "unit", status: "completed", conclusion: "failure" }], now: RELEASE_NOW });
    expect(read(true).groups[0]!.rows[0]!.line).toContain(`GitHub CI failed on ${f.approved.slice(0, 7)}: unit.`);
  });

  test("for anyone else a release stays an ordinary task row in Approve a plan", () => {
    const view = read(false);
    expect(view.groups.map(group => [group.key, group.count])).toEqual([["approve", PLANS + 1]]);
    const row = view.groups[0]!.rows.find(one => one.id === f.taskId)!;
    expect(row).toMatchObject({ ask: "approve", href: `/t/${f.taskId}` });
  });
});

describe("a held publication and setup", () => {
  let f: ReleaseFixture;
  const access = () => ({ principal: "operator" as const, repos: [f.repo] });
  const builderStep = { key: "builder" as const, id: "setup:builder", title: "Connect a builder", href: "/start-builder", repo: null, at: null, line: null, action: { label: "Start a builder", href: "/start-builder" } };
  const read = (approver = true) => homeView({ store: f.store, now: RELEASE_NOW, access: access(), project: null, projects: [], chat: false, canAnswer: approver, approver, closedDoor: () => null,
    asks: { ...NO_HOME_ASKS, ...releaseAsks(f.store, RELEASE_NOW, access(), null, approver), setup: [builderStep] } });
  beforeAll(() => {
    f = releaseFixture({ candidate: { "src/x.js": "1\n" } });
    holdAutoPublish(f.store, { taskId: f.taskId, why: "CI stopped passing after the merge.", now: RELEASE_NOW });
  });
  afterAll(() => f.close());

  test("while its family is already a row (it waits for a builder), the held publication isn't listed again, and the builder step waits behind that row", () => {
    const view = read();
    expect(view.groups.map(group => group.key)).toEqual(["other"]);
    expect(view.groups[0]!.rows.map(row => row.id)).toEqual([f.taskId]);
    expect(view.say).toBe("1 task needs you");
  });

  test("otherwise it is one row in Approve a release, linked to the sheet, and the sentence names it", () => {
    register(f.store, { name: "builder-1", host: "test", capacity: 2, repos: [f.repo], now: RELEASE_NOW, newToken: () => "tok" });
    const view = read();
    expect(view.groups.map(group => [group.key, group.count])).toEqual([["release", 1], ["setup", 1]]);
    expect(view.groups[0]!.rows).toEqual([expect.objectContaining({ id: `release:${f.taskId}`, ask: "release", line: "CI stopped passing after the merge.",
      action: { label: "Review the release", href: `/t/${f.taskId}/release` } })]);
    expect(view.say).toBe("2 things need you");
    // Not for anyone but an approver.
    expect(read(false).groups).toEqual([]);
  });
});

describe("held publications, many at once", () => {
  // Several releases of one project, each its own family: held and otherwise asking nobody (cancelled here, so that
  // nothing else about it waits on a person), held but already a row that needs the person (its plan still waits for
  // a yes), held then let go on, never held.
  let f: ReleaseFixture;
  const access = (repos?: string[]) => ({ principal: "operator" as const, repos: repos ?? [f.repo] });
  const release = (id: string) => {
    f.store.createTask({ id, title: `Release ${id}` }, RELEASE_NOW);
    f.store.placeTask(f.store.refFor("built-in", id).id, f.repo, {}, RELEASE_NOW);
    const terms = releaseTermsFor(f.store, { repo: f.repo, version: VERSION, branch: "release-0.9.71", pr: 240, candidate: f.approved, now: RELEASE_NOW });
    if (!terms.ok) throw new Error(terms.why);
    propose(f.store, { taskId: id, goal: `Verify ${id}`, candidate: f.approved, acceptance: [{ id: "c1", statement: "The release check passes", how: null, evidence: ["check"] }], releaseTerms: terms.terms, now: RELEASE_NOW });
  };
  const hold = (id: string, minutes: number) => holdAutoPublish(f.store, { taskId: id, why: `${id} waits: CI stopped passing.`, now: new Date(RELEASE_NOW.getTime() + minutes * 60_000) });
  beforeAll(() => {
    f = releaseFixture({ candidate: { "src/x.js": "1\n" } });
    register(f.store, { name: "builder-1", host: "test", capacity: 8, repos: [f.repo], now: RELEASE_NOW, newToken: () => "tok" });
    for (const id of ["quiet-1", "quiet-2", "asks-a-yes", "let-go", "never-held"]) release(id);
    for (const id of ["quiet-1", "quiet-2"]) f.store.setTaskState(id, "cancelled", RELEASE_NOW);
    hold("quiet-1", 1); hold("quiet-2", 2); hold("asks-a-yes", 3); hold("let-go", 4);
    if (!allowAutoPublish(f.store, { taskId: "let-go", by: "alex", now: new Date(RELEASE_NOW.getTime() + 5 * 60_000) }).ok) throw new Error("allow");
    // Held twice is still one row.
    hold("quiet-1", 6);
  });
  afterAll(() => f.close());

  test("one row per still-held family that isn't already a row, newest first; exact counts; none outside the view", () => {
    const read = releaseAsks(f.store, RELEASE_NOW, access(), null, true);
    expect(read.held.map(one => [one.id, one.line, one.href])).toEqual([
      ["release:quiet-1", "quiet-1 waits: CI stopped passing.", "/t/quiet-1/release"],
      ["release:quiet-2", "quiet-2 waits: CI stopped passing.", "/t/quiet-2/release"],
    ]);
    const view = homeView({ store: f.store, now: RELEASE_NOW, access: access(), project: null, projects: [], chat: false, canAnswer: true, approver: true, closedDoor: () => null,
      asks: { ...NO_HOME_ASKS, ...read } });
    // The releases that wait for a yes (held or not) are their own rows in Approve a release; the two held ones follow.
    const releases = view.groups.find(one => one.key === "release")!;
    expect(releases.count).toBe(5);
    expect(releases.rows.slice(0, 3).map(one => one.id).sort()).toEqual(["asks-a-yes", "let-go", "never-held"]);
    expect(releases.rows.slice(3).map(one => one.id)).toEqual(["release:quiet-1", "release:quiet-2"]);
    expect(view.say).toBe("3 tasks and 2 other things need you");
    // Another project in view, or a view without this project: none.
    expect(releaseAsks(f.store, RELEASE_NOW, access(), "/repos/elsewhere", true).held).toEqual([]);
    expect(releaseAsks(f.store, RELEASE_NOW, access(["/repos/elsewhere"]), null, true).held).toEqual([]);
  });
});
