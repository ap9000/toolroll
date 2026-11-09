/** Home's three groups (docs/plans/one-step-chat.md H1): the one rule (home-groups.ts), and Home's view on the demo's
 * work — every row the old groups showed lands in exactly one new group, the figures still equal the lists they open,
 * Done lists only the last 7 days, and the overflow count is what Waiting on you leaves out. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeFiguresLine, homeFiguresOf, homeGroupOf, HOME_GROUP_LABEL } from "./home-groups.js";
import { makeDemoRepos, seedDemo } from "./demo.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { verifyApproverByPassword } from "./principal.js";
import { assignmentOf, checkAssignmentAsOperator } from "./assignment.js";
import { openStore, type Store } from "./store.js";
import { workIndexPage, type WorkIndexItem } from "./work-index.js";
import { homeView, HOME_NEEDS_SHOWN, type HomeFacts } from "./server/home.js";

const item = (views: string[], label = "Needs you") => ({ status: { views, label } });

describe("homeGroupOf", () => {
  test("waits on you first, then working, then done; null for everything else", () => {
    expect(homeGroupOf(item(["all", "needs-you"]))).toBe("you");
    // A row that both needs you and is running waits on you.
    expect(homeGroupOf(item(["all", "needs-you", "running"]))).toBe("you");
    expect(homeGroupOf(item(["all", "needs-you", "ready"], "Ready for review"))).toBe("you");
    expect(homeGroupOf(item(["all", "running"], "Building"))).toBe("working");
    expect(homeGroupOf(item(["all", "queued"], "Waiting"))).toBe("working");
    // Queued under any headline is working: Working is what the Running and Queued figures count.
    expect(homeGroupOf(item(["all", "queued"], "Queued"))).toBe("working");
    expect(homeGroupOf(item(["all", "completed"], "Complete"))).toBe("done");
    // A complete family with a repair running is working, not done.
    expect(homeGroupOf(item(["all", "running", "completed"], "Building"))).toBe("working");
    // Cancelled, replaced and put away: no group.
    expect(homeGroupOf(item(["all"], "Cancelled"))).toBeNull();
    expect(homeGroupOf(item(["all"], "Replaced"))).toBeNull();
    expect(homeGroupOf(item(["archived"], "Archived"))).toBeNull();
  });

  test("the headings and the opening line say the plain words", () => {
    expect(Object.values(HOME_GROUP_LABEL)).toEqual(["Waiting on you", "Working", "Done"]);
    const figures = homeFiguresOf({ all: 9, "needs-you": 2, ready: 1, running: 1, queued: 0, completed: 14, archived: 3 });
    expect(figures).toEqual({ waitingOnYou: 2, running: 1, queued: 0, done: 14 });
    expect(homeFiguresLine(figures)).toBe("Waiting on you 2 · Running 1 · Queued 0 · Done 14");
  });
});

describe("Home's view", () => {
  let root: string, store: Store, repos: { api: string; web: string };
  const access = { principal: "operator" as const, repos: null, includeUnplaced: true };
  const facts = (now: Date, over: Partial<HomeFacts> = {}): HomeFacts => ({
    store, now, access, evidenceRoot: join(root, "evidence"), project: null, projects: [], chat: false, canAnswer: true, closedDoor: () => null, ...over });
  const page = (now: Date, view: "all" | "needs-you" | "running" | "queued" | "completed", limit: number) =>
    workIndexPage(store, now, access, { view, limit, root: join(root, "evidence") });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "so-home-groups-")));
    store = openStore(join(root, "orders.db"));
    repos = makeDemoRepos(root);
    mkdirSync(join(root, "evidence"), { recursive: true });
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  test("on the demo's work: every row the old groups showed is in exactly one new group, in the same order", () => {
    const now = new Date();
    store.recordInstallationFact("demo", "1", now);
    seedDemo(store, repos, join(root, "evidence"), now);
    const view = homeView(facts(now));
    // The old groups, read exactly as Home read them: what waits by its ask, then running, then waiting.
    const needs = page(now, "needs-you", HOME_NEEDS_SHOWN).items;
    const asked = (["decide", null, "review", "unblock"] as const).flatMap(ask => needs.filter(one => one.ask === ask));
    const running = page(now, "running", 8).items.filter(one => !one.status.views.includes("needs-you"));
    const waiting = page(now, "queued", 8).items.filter(one => one.status.label === "Waiting" && !one.status.views.includes("needs-you"));
    const ids = (items: readonly WorkIndexItem[]) => items.map(one => one.rootId);
    const group = (key: string) => view.groups.find(one => one.key === key)?.rows.map(row => row.id) ?? [];
    expect(asked.length + running.length + waiting.length, "the demo has work in the old groups").toBeGreaterThan(0);
    expect(group("you")).toEqual(ids(asked));
    // Working is the Running rows, then the Queued rows; every row the old Waiting group showed is among them, in order.
    const queued = page(now, "queued", 8).items.filter(one => !one.status.views.includes("needs-you") && !ids(running).includes(one.rootId));
    expect(group("working")).toEqual([...ids(running), ...ids(queued)]);
    expect(ids(queued).filter(id => ids(waiting).includes(id))).toEqual(ids(waiting).filter(id => !ids(running).includes(id)));
    const listed = view.groups.flatMap(one => one.rows.map(row => row.id));
    expect(new Set(listed).size, "one row per family").toBe(listed.length);
    for (const id of [...ids(asked), ...ids(running), ...ids(waiting)]) expect(listed.filter(one => one === id), id).toHaveLength(1);
    // Groups in Home's order, with their headings.
    expect(view.groups.map(one => [one.key, one.label])).toEqual(([["you", "Waiting on you"], ["working", "Working"], ["done", "Done"]] as const)
      .filter(([key]) => group(key).length > 0));
    // Each figure keeps the name and count of the list it opens; Done is the whole Completed total.
    const totals = page(now, "all", 1).totals;
    expect(view.counts.map(one => [one.key, one.label, one.value, one.href])).toEqual([
      ["needs", "Waiting on you", totals["needs-you"], "/tasks?scope=all&view=needs-you"], ["running", "Running", totals.running, "/tasks?scope=all&view=running"],
      ["queued", "Queued", totals.queued, "/tasks?scope=all&view=queued"], ["finished", "Done", totals.completed, "/tasks?scope=all&view=completed"]]);
    // Done lists what finished this week, newest first, never more than eight.
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const finished = page(now, "completed", 100).items.filter(one => homeGroupOf(one) === "done" && (one.completion?.at ?? one.updatedAt) >= weekAgo);
    expect(group("done")).toEqual(ids(finished).slice(0, 8));
    // What waits on you comes first and is selected: the overflow counts only what that group leaves out.
    expect(view.more).toEqual(totals["needs-you"] > group("you").length ? { count: totals["needs-you"] - group("you").length, href: view.counts[0]!.href } : null);
  });

  test("cancelled and replaced work is in no group; Done lists only the last 7 days, even when fewer than eight are newer", () => {
    const now = new Date("2026-11-01T12:00:00.000Z");
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const REPO = "/repos/storefront";
    register(store, { name: "builder-1", host: "test", capacity: 4, repos: [REPO], now: daysAgo(30), newToken: () => "tok-builder-1" });
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", daysAgo(30));
    const sam = addApprover(store, "sam", daysAgo(30));
    if (!sam.ok) throw new Error("approver");
    store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 300_000, approvedBy: "sam" }, daysAgo(30));
    const who = verifyApproverByPassword(store, "sam", sam.token, [REPO]);
    if (!who.ok) throw new Error("who");
    const evidence = join(root, "evidence");
    // A task built and accepted by a person `days` ago: complete, the way the Tasks list's Completed view reads it.
    const finish = (id: string, days: number) => {
      const at = daysAgo(days + 0.1);
      store.createTask({ id, title: `Task ${id}` }, at);
      const ref = store.refFor("built-in", id).id;
      store.placeTask(ref, REPO, {}, at);
      const proposed = propose(store, { taskId: id, goal: `Task ${id}`, touches: ["src/"], acceptance: [{ id: "c1", statement: `Task ${id}`, how: null, evidence: ["check"] }], now: at });
      if (!approve(store, id, "sam", at, proposed.digest, sam.token).ok) throw new Error("approve");
      const authority = store.routeAuthorityFor(ref, "builder");
      if (!authority?.ok) throw new Error("route");
      const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: at });
      const head = (run + 10).toString(16).padStart(2, "0").repeat(20);
      store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
      store.recordOutcomeFacts(run, { headRevision: head, handoff: `Task ${id}, with a test.` });
      store.finishRun(run, { outcome: "built", committed: true, now: at });
      store.setTaskState(id, "done", at);
      store.saveProofVerdict(run, "verified", [], at, [{ id: "c1", statement: `Task ${id}`, requiredEvidence: ["check"], state: "pass", detail: [], answered: [], review: null }] as never, "verified");
      storeEvidence(store, evidence, run, "terminal-diff", "diff.patch", Buffer.from(`diff --git a/src/${id}.ts b/src/${id}.ts\n--- a/src/${id}.ts\n+++ b/src/${id}.ts\n@@ -1 +1 @@\n-a\n+b\n`), "git diff (exit 0)", at, { captureStatus: "ok" });
      storeEvidence(store, evidence, run, "check-log", "checks.txt", Buffer.from("12 passed\n"), "npm test", at, { captureStatus: "ok" });
      sealVerificationReceipt(store, evidence, run, head, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, at);
      store.recordRunCheck(run, { status: "passed", exitCode: 0, suites: [] }, at);
      const family = assignmentOf(store, id, daysAgo(days), { principal: "operator", repos: [REPO] }, evidence)!;
      if (!checkAssignmentAsOperator(store, id, family.receipt!.digest, who.who, daysAgo(days), evidence).ok) throw new Error(`complete ${id}`);
    };
    // Ten finished this week, four more a week or two ago.
    const days = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 9, 10, 11, 12];
    days.forEach((day, n) => finish(`done-${n}`, day));
    // One task cancelled; one replaced by another.
    for (const id of ["dropped", "old-way", "new-way"]) {
      store.createTask({ id, title: `Task ${id}` }, daysAgo(1));
      store.placeTask(store.refFor("built-in", id).id, REPO, {}, daysAgo(1));
    }
    expect(store.cancelTask("dropped", daysAgo(0.5)).ok).toBe(true);
    expect(store.applyCancellation("old-way", { kind: "operator", text: null }, daysAgo(0.5), null, "new-way").changed).toBe(true);
    const ended = workIndexPage(store, now, access, { state: "cancelled", limit: 100 }).items;
    expect(ended.map(one => one.rootId).sort()).toEqual(["dropped", "old-way"]);
    expect(ended.find(one => one.rootId === "old-way")?.status.detail).toMatch(/new-way/);
    for (const one of ended) expect(homeGroupOf(one), one.rootId).toBeNull();
    const view = homeView(facts(now));
    const listed = view.groups.flatMap(one => one.rows.map(row => row.id));
    expect(listed).not.toContain("dropped");
    expect(listed).not.toContain("old-way");
    // Today: ten finished this week, so the newest eight are listed.
    const done = (v: typeof view) => v.groups.find(one => one.key === "done")?.rows.map(row => row.id) ?? [];
    expect(page(now, "all", 1).totals.completed).toBe(14);
    expect(done(view)).toEqual(["done-0", "done-1", "done-2", "done-3", "done-4", "done-5", "done-6", "done-7"]);
    // Four and a quarter days on, only five finished in the last 7 days: those five, and none of the older ones.
    const later = homeView(facts(new Date(now.getTime() + 4.25 * 86_400_000)));
    expect(done(later)).toEqual(["done-0", "done-1", "done-2", "done-3", "done-4"]);
    // The figure is still the whole Completed list it opens.
    expect(later.counts.find(one => one.key === "finished")).toMatchObject({ label: "Done", value: 14, href: "/tasks?scope=all&view=completed" });
  });

  test("the overflow count is what Waiting on you leaves out, and the first row listed waits on you", () => {
    const now = new Date("2026-11-01T12:00:00.000Z");
    for (let n = 0; n < HOME_NEEDS_SHOWN + 3; n++) {
      store.createTask({ id: `t-${n}`, title: `Task ${n}` }, now);
      store.placeTask(store.refFor("built-in", `t-${n}`, "ours").id, repos.api);
    }
    const view = homeView(facts(now));
    expect(view.counts[0]!.value).toBe(HOME_NEEDS_SHOWN + 3);
    expect(view.groups.map(one => one.key)).toEqual(["you"]);
    expect(view.groups[0]!.rows).toHaveLength(HOME_NEEDS_SHOWN);
    expect(view.more).toEqual({ count: 3, href: "/tasks?scope=all&view=needs-you" });
  });
});
