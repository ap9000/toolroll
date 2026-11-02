/**
 * The doors Codex's first implementation review found open for a put-away task (v144, docs/plans/task-tidy.md): the
 * merge sweep's firing, a flow card held by either of its tasks (any zone, a notify zone included), the lead's words
 * and claim, requeue and resume, lists cut before their limit, and a family a person revived with a new revision.
 * Isolated stores only.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStore, archiveTaskFamily, restoreTaskFamily, type Store } from "./store.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { workIndexPage, workIndexTask } from "./work-index.js";
import { flowFromSteps } from "./flows.js";
import { advanceFlows } from "./flow-engine.js";
import { leadClaim, leadSay } from "./lead-voice.js";
import { presented } from "../test/route-fixture.js";
import { fire, seedFlow } from "../test/tidy-fixture.js";
import { tidyPreview } from "./tidy.js";

const T0 = new Date("2026-11-01T10:00:00.000Z");
const REPO = resolve("/repo/main");
const ALL = { principal: "operator" as const, repos: null, includeUnplaced: true };
const BY = { by: "alex", byKind: "person" as const, rule: null, reason: "Done with it" };
const LEAD = { account: "alex", lead: true };

let store: Store, token: string, dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toolroll-archive-doors-"));
  store = openStore(":memory:");
  for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap failed");
  token = added.token;
  register(store, { name: "mac-mini", host: "here", capacity: 4, repos: [REPO], now: T0, newToken: () => "tok-mac-mini" });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function seed(id: string, at = T0): number {
  store.createTask({ id, title: `Fix ${id}` }, at);
  const ref = store.refFor("built-in", id, "ours").id;
  store.placeTask(ref, REPO);
  propose(store, { taskId: id, goal: `fix ${id}`, now: at });
  const agreed = approve(store, id, "alex", at, store.getScope(id)!.digest, token);
  if (!agreed.ok) throw new Error(`approval refused: ${agreed.reason}`);
  return ref;
}
/** A finished build of the task: claimed, run, and let go, as a worker leaves it. */
function finishedRun(ref: number): number {
  const taken = acquire(store, ref, "mac-mini", { token: "tok-mac-mini", now: T0, ttlMs: 3_600_000 });
  if (!taken.ok) throw new Error(`claim refused: ${taken.reason}`);
  const run = store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "mac-mini", provider: "claude", branch: "b", worktree: dir, now: T0, ...presented(store, ref) });
  store.handle.prepare("UPDATE run SET outcome = 'built', finished_at = ?, head_revision = ? WHERE id = ?").run(T0.toISOString(), "a".repeat(40), run);
  store.handle.prepare("UPDATE claim SET released_at = ? WHERE task_ref = ?").run(T0.toISOString(), ref);
  return run;
}

describe("merging", () => {
  test("an intent claimed for merging keeps the task from being put away; a put-away task's intent waits for a person", () => {
    const ref = seed("pr-task");
    const run = finishedRun(ref);
    store.handle.prepare("INSERT INTO publication (run, task_ref, github_repo, remote, base, head, head_sha, body_hash, draft, state, created_at, updated_at) VALUES (?, ?, 'o/r', 'origin', 'main', 'b', ?, 'h', 0, 'opened', ?, ?)")
      .run(run, ref, "a".repeat(40), T0.toISOString(), T0.toISOString());
    const publication = Number(store.handle.prepare("SELECT id FROM publication WHERE run = ?").get(run)!["id"]);
    store.handle.prepare("INSERT INTO merge_intent (publication, grant_terms_hash, head_sha, method, state, claimed_by, claimed_until, generation, created_at) VALUES (?, 'g', ?, 'squash', 'claimed', 'w', ?, 1, ?)")
      .run(publication, "a".repeat(40), T0.toISOString(), T0.toISOString());
    expect(archiveTaskFamily(store, "pr-task", BY, T0)).toMatchObject({ ok: false, reason: "live" });
    store.handle.prepare("UPDATE merge_intent SET state = 'pending'").run();
    expect(archiveTaskFamily(store, "pr-task", BY, T0)).toMatchObject({ ok: true });
    store.handle.prepare("UPDATE merge_intent SET state = 'claimed'").run();
    const intent = Number(store.handle.prepare("SELECT id FROM merge_intent").get()!["id"]);
    expect(store.fireMergeIntent(intent, 1, { repo: REPO, headSha: "a".repeat(40), liveGrantTermsHash: "g", graceMs: 0 }, T0)).toEqual({ ok: false, outcome: "waiting-human", why: "the task is put away" });
    expect(store.handle.prepare("SELECT state FROM merge_intent").get()!["state"]).toBe("waiting-human");
  });
});

describe("flow cards", () => {
  test("a card whose first build task is put away holds in any zone: nothing moves on or notifies", () => {
    seed("card-build");
    const flow = store.createFlow({ repo: REPO, name: "Ship", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Tell the team", kind: "notify" }], null)) }, T0);
    const stage = JSON.parse(store.getFlow(flow)!.definitionJson).stages[0].id as string;
    const card = store.addFlowCard({ flow, title: "Ship the fix", description: null, stage, by: "alex", byKind: "person" }, T0);
    store.handle.prepare("UPDATE flow_card SET task = NULL, primary_task = 'card-build' WHERE id = ?").run(card);
    archiveTaskFamily(store, "card-build", BY, T0);
    advanceFlows(store, REPO, T0);
    expect(store.getFlowCard(card)).toMatchObject({ stage, waiting: "Its task is put away. Restore the task to continue." });
    expect(store.handle.prepare("SELECT COUNT(*) n FROM notification WHERE kind = 'flow-message'").get()!["n"]).toBe(0);
    restoreTaskFamily(store, "card-build", "alex", T0);
    advanceFlows(store, REPO, T0);
    expect(store.handle.prepare("SELECT COUNT(*) n FROM notification WHERE kind = 'flow-message'").get()!["n"]).toBe(1);
  });
});

describe("the lead, requeue and resume", () => {
  test("the lead neither speaks about nor takes on a put-away task; its words about a task keep the task", () => {
    seed("lead-task");
    expect(leadSay(store, LEAD, "Looking at the footer now.", "lead-task", T0)).toMatchObject({ ok: true });
    expect(store.handle.prepare("SELECT task_id FROM notification WHERE kind = 'lead-say'").get()!["task_id"]).toBe("lead-task");
    archiveTaskFamily(store, "lead-task", BY, T0);
    expect(store.handle.prepare("SELECT resolved_at FROM notification WHERE kind = 'lead-say'").get()!["resolved_at"]).toBe(T0.toISOString());
    expect(leadSay(store, LEAD, "Still on it.", "lead-task", T0)).toMatchObject({ ok: false, reason: "refused" });
    expect(leadClaim(store, LEAD, "lead-task", T0)).toMatchObject({ ok: false, reason: "refused" });
  });

  test("requeue and resume refuse a put-away task, changing nothing", () => {
    const ref = seed("failed-task");
    store.setTaskState("failed-task", "failed", T0);
    archiveTaskFamily(store, "failed-task", BY, T0);
    expect(store.requeueTask("failed-task", "alex", T0)).toEqual({ ok: false, reason: "archived" });
    expect(store.getTask("failed-task")!.state).toBe("failed");
    expect(store.resumeRunStop({ runId: 1, taskRef: ref, by: "alex", via: "cli" }, T0)).toMatchObject({ ok: false, reason: "archived" });
  });
});

describe("lists and families", () => {
  test("a list cut to its limit leaves put-away families out first, so older active work still shows", () => {
    seed("old-active", new Date("2026-10-01T10:00:00.000Z"));
    seed("new-a", new Date("2026-10-30T10:00:00.000Z"));
    seed("new-b", new Date("2026-10-31T10:00:00.000Z"));
    archiveTaskFamily(store, "new-a", BY, T0);
    archiveTaskFamily(store, "new-b", BY, T0);
    expect(store.taskFamiliesAdmitted(null, true, { limit: 1 }).map(one => one.root.id)).toEqual(["old-active"]);
    expect(store.listTasksScoped(null, undefined, 1, null).map(one => one.id)).toEqual(["old-active"]);
  });

  test("tidy never takes a scheduled run's family once a person filed a revision of it, nor anything holding the newest run", () => {
    const flow = seedFlow(store, "Site check", { kind: "schedule", schedule: "daily:09:00@UTC", title: "Is the site current?", description: null, zone: null }, T0, REPO);
    fire(store, flow, { key: "slot:2026-10-29T16:00:00.000Z", task: "site-29", at: new Date("2026-10-29T16:00:00.000Z"), repo: REPO });
    fire(store, flow, { key: "slot:2026-10-30T16:00:00.000Z", task: "site-30", at: new Date("2026-10-30T16:00:00.000Z"), repo: REPO });
    fire(store, flow, { key: "slot:2026-10-31T16:00:00.000Z", task: "site-31", at: new Date("2026-10-31T16:00:00.000Z"), repo: REPO });
    const none = { facts: [], problem: null };
    expect(tidyPreview(store, T0, { releases: none, days: null }).map(one => one.taskId).sort()).toEqual(["site-29", "site-30"]);
    // A person revises the Oct 29 run: its family is theirs now.
    propose(store, { taskId: "site-29", goal: "check the site", now: T0 });
    expect(approve(store, "site-29", "alex", T0, store.getScope("site-29")!.digest, token)).toMatchObject({ ok: true });
    const run = finishedRun(store.lookupRef("site-29")!.id);
    store.createTask({ id: "site-29-fix", title: "Fix what the Oct 29 check found", filedBy: { name: "alex", kind: "person" } }, T0);
    const child = store.refFor("built-in", "site-29-fix", "ours").id;
    store.placeTask(child, REPO);
    store.markRevision(child, "site-29", store.saveArtifact({ run, kind: "revision-brief", key: "brief", bytesOriginal: 1, bytesStored: 1, truncated: false, sha256: "c".repeat(64), capture: "fixture" }, T0));
    expect(tidyPreview(store, T0, { releases: none, days: null }).map(one => one.taskId)).toEqual(["site-30"]);
  });

  test("a family a person revived with a new revision shows, its put-away version doesn't hold it up, and it can be put away again", () => {
    const parentRef = seed("parent");
    const run = finishedRun(parentRef);
    archiveTaskFamily(store, "parent", BY, T0);
    store.createTask({ id: "parent-2", title: "Fix parent, again" }, T0);
    const child = store.refFor("built-in", "parent-2", "ours").id;
    store.placeTask(child, REPO);
    const brief = store.saveArtifact({ run, kind: "revision-brief", key: "brief", bytesOriginal: 1, bytesStored: 1, truncated: false, sha256: "b".repeat(64), capture: "fixture" }, T0);
    store.markRevision(child, "parent", brief);
    const row = workIndexTask(store, "parent-2", T0, ALL)!;
    expect(row.archived).toBeUndefined();
    expect(row.earlierActiveCount).toBe(0);
    expect(workIndexPage(store, T0, ALL, { view: "all" }).items.map(one => one.activeTaskId)).toEqual(["parent-2"]);
    expect(archiveTaskFamily(store, "parent-2", BY, T0)).toMatchObject({ ok: true });
    expect(workIndexPage(store, T0, ALL, { view: "archived" }).items.map(one => one.activeTaskId)).toEqual(["parent-2"]);
  });
});
