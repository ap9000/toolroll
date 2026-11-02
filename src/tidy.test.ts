/**
 * Tidy's rules (docs/plans/task-tidy.md), one table each, with every never-case: old routine runs, old releases,
 * resolved CI notices and finished tasks a person chooses; the preview's digest; and the automatic pass's bound,
 * idempotence, ledger and restore exemption. Isolated stores and temp folders only.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, archiveOf, archiveTaskFamily, restoreTaskFamily, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { withActor } from "./actor.js";
import { applyTidy, readReleaseFacts, recordBranchCheckRun, runTidy, tidyDigest, tidyPreview, type ReleaseFacts } from "./tidy.js";
import { fire, personTask, releaseTaskId, seedFlow, writeJournal, REPO } from "../test/tidy-fixture.js";

const NOW = new Date("2026-11-01T18:00:00.000Z");
const day = (d: number) => new Date(Date.UTC(2026, 9, d, 16));
const NONE: ReleaseFacts = { facts: [], problem: null };
const ids = (items: readonly { taskId: string }[]) => items.map(one => one.taskId).sort();

let store: Store;
let stateDir: string;
beforeEach(() => {
  store = openStore(":memory:");
  stateDir = mkdtempSync(join(tmpdir(), "toolroll-tidy-"));
});
afterEach(() => { store.close(); rmSync(stateDir, { recursive: true, force: true }); });

const siteCheck = () => seedFlow(store, "Site check", { kind: "schedule", schedule: "daily:09:00@UTC", title: "Is the site current?", description: null, zone: null }, day(1));

describe("(a) old routine runs", () => {
  test("a newer clock firing of the same schedule replaces older unfinished runs; the newest stays", () => {
    const flow = siteCheck();
    for (const d of [29, 30, 31]) fire(store, flow, { key: `slot:2026-10-${d}T16:00:00.000Z`, task: `site-oct-${d}`, title: `Is the site current? — Oct ${d}`, at: day(d) });
    fire(store, flow, { key: "slot:2026-11-01T16:00:00.000Z", task: "site-nov-1", title: "Is the site current? — Nov 1", at: new Date("2026-11-01T16:00:00.000Z") });
    const items = tidyPreview(store, NOW, { releases: NONE, days: null });
    expect(ids(items)).toEqual(["site-oct-29", "site-oct-30", "site-oct-31"]);
    expect(items[0]).toMatchObject({ rule: "routine", reason: "A newer run, “Is the site current? — Nov 1”, replaces it." });
  });

  test.each([
    ["a person's Run now", { key: "now:2026-10-30T10:00:00.000Z", cardKind: "person" as const, filedBy: { name: "alex", kind: "person" as const } }],
    ["a skipped firing", { key: "slot:2026-10-30T16:00:00.000Z", state: "skipped" as const }],
    ["a task filed by hand onto the card", { key: "slot:2026-10-30T16:00:00.000Z", filedVia: "console" }],
    ["a plane review run by hand (same key, not on time)", { key: "plane:integration/x:2026-10-30", onTime: false }],
  ])("never taken: %s", (_name, firing) => {
    const flow = siteCheck();
    fire(store, flow, { task: "older", at: day(30), ...firing });
    fire(store, flow, { key: "slot:2026-10-31T16:00:00.000Z", task: "newest", at: day(31) });
    expect(ids(tidyPreview(store, NOW, { releases: NONE, days: null }))).toEqual([]);
  });

  test("a person's Run now never counts as the newest run, and every task the newest firing touched stays", () => {
    const flow = siteCheck();
    fire(store, flow, { key: "slot:2026-10-30T16:00:00.000Z", task: "older", at: day(30) });
    fire(store, flow, { key: "now:2026-10-31T10:00:00.000Z", task: "by-hand", at: day(31), cardKind: "person", filedBy: { name: "alex", kind: "person" } });
    expect(ids(tidyPreview(store, NOW, { releases: NONE, days: null }))).toEqual([]);
  });

  test("a plane review groups by its problem: only the same problem's older scheduled finding is replaced", () => {
    const flow = seedFlow(store, "Plane review", { kind: "plane-review", schedule: "daily:07:30@UTC", zone: "find-cause" }, day(1));
    fire(store, flow, { key: "plane:integration/mcp-a:2026-10-29", task: "cause-a-29", at: day(29) });
    fire(store, flow, { key: "plane:integration/mcp-b:2026-10-29", task: "cause-b-29", at: day(29) });
    fire(store, flow, { key: "plane:integration/mcp-a:2026-10-30", task: "cause-a-30", at: day(30) });
    expect(ids(tidyPreview(store, NOW, { releases: NONE, days: null }))).toEqual(["cause-a-29"]);
  });

  test("a standing order's own firing (its immutable task link) counts even when it files as a person", () => {
    const flow = siteCheck();
    fire(store, flow, { key: "slot:2026-10-30T16:00:00.000Z", task: "order-30", at: day(30), eventTask: true, filedVia: null, filedBy: { name: "alex", kind: "person" } });
    fire(store, flow, { key: "slot:2026-10-31T16:00:00.000Z", task: "order-31", at: day(31), eventTask: true, filedVia: null, filedBy: { name: "alex", kind: "person" } });
    expect(ids(tidyPreview(store, NOW, { releases: NONE, days: null }))).toEqual(["order-30"]);
  });

  test.each([
    ["running", (id: string) => { store.setTaskState(id, "running", NOW); }],
    ["asked of a person", (id: string) => { addApprover(store, "alex", NOW); expect(withActor({ account: "alex", lead: true }, () => store.askPerson(id, "alex", "please look", NOW))).toEqual({ ok: true }); }],
    ["with a steering note waiting", (id: string) => { store.handle.prepare("INSERT INTO task_steer (task_ref, author, note, created_at) VALUES (?, 'alex', 'also check the footer', ?)").run(store.lookupRef(id)!.id, NOW.toISOString()); }],
    ["already put away", (id: string) => { expect(archiveTaskFamily(store, id, { by: "alex", byKind: "person", rule: null, reason: "mine" }, NOW).ok).toBe(true); }],
  ])("never taken: an older run %s", (_name, make) => {
    const flow = siteCheck();
    fire(store, flow, { key: "slot:2026-10-30T16:00:00.000Z", task: "older", at: day(30) });
    fire(store, flow, { key: "slot:2026-10-31T16:00:00.000Z", task: "newest", at: day(31) });
    make("older");
    expect(ids(tidyPreview(store, NOW, { releases: NONE, days: null }))).toEqual([]);
  });
});

describe("(b) old releases", () => {
  const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40), E = "e".repeat(40), F = "f".repeat(40);
  const release = (version: string, sha: string, suffix?: number) => { const id = releaseTaskId(version, sha, suffix); personTask(store, id, day(20)); return id; };

  test("published, replaced and older-than-published release tasks go; in-flight and resumable ones stay", () => {
    const published = release("1.4.0", A), replaced = release("1.4.0", B), older = release("1.3.0", C), running = release("1.5.0", D), resumable = release("1.6.0", E), unnamed = release("1.2.0", F);
    writeJournal(stateDir, "release-1.4.0.json", { version: "1.4.0", task: published, sha: A, step: "done", published: true });
    writeJournal(stateDir, "release-1.4.0.superseded-2026-10-20.json", { version: "1.4.0", task: replaced, sha: B, step: "check", stopped: true });
    writeJournal(stateDir, "release-1.3.0.json", { version: "1.3.0", task: older, sha: C, step: "publish", stopped: true });
    writeJournal(stateDir, "release-1.5.0.json", { version: "1.5.0", task: running, sha: D, step: "approval" });
    writeJournal(stateDir, "release-1.6.0.json", { version: "1.6.0", task: resumable, sha: E, step: "check", stopped: true });
    const items = tidyPreview(store, NOW, { releases: readReleaseFacts(stateDir), days: null });
    expect(Object.fromEntries(items.map(one => [one.taskId, one.reason]))).toEqual({
      [published]: "Release 1.4.0 is published.",
      [replaced]: "A newer attempt of release 1.4.0 replaced it.",
      [older]: "Release 1.4.0 is already published.",
    });
    expect(items.map(one => one.taskId)).not.toContain(unnamed);
  });

  test.each([
    ["an unreadable journal", (dir: string) => writeFileSync(join(dir, "releases", "release-9.json"), "{ not json")],
    ["a symlinked journal", (dir: string) => symlinkSync(join(dir, "releases", "release-1.4.0.json"), join(dir, "releases", "release-link.json"))],
    ["a journal without a candidate", (dir: string) => writeFileSync(join(dir, "releases", "release-8.json"), JSON.stringify({ version: 1, step: "done", task: { id: "x" }, packageVersion: "1.0.0" }))],
  ])("%s turns the whole release rule off", (_name, spoil) => {
    const published = release("1.4.0", A);
    writeJournal(stateDir, "release-1.4.0.json", { version: "1.4.0", task: published, sha: A, step: "done", published: true });
    spoil(stateDir);
    const facts = readReleaseFacts(stateDir);
    expect(facts.problem).not.toBeNull();
    expect(tidyPreview(store, NOW, { releases: facts, days: null })).toEqual([]);
  });

  test("a journal naming a task that isn't its gate task for that commit is left alone", () => {
    const other = release("1.4.0", B);
    writeJournal(stateDir, "release-1.4.0.json", { version: "1.4.0", task: other, sha: A, step: "done", published: true });
    expect(tidyPreview(store, NOW, { releases: readReleaseFacts(stateDir), days: null })).toEqual([]);
  });

  test("newest published is per package: another repository's newer release doesn't age this one", () => {
    const mine = release("1.3.0", C), theirs = release("2.0.0", A);
    writeJournal(stateDir, "release-1.3.0.json", { version: "1.3.0", task: mine, sha: C, step: "publish", stopped: true });
    writeJournal(stateDir, "release-2.0.0.json", { version: "2.0.0", task: theirs, sha: A, step: "done", published: true, github: "acme/other" });
    expect(ids(tidyPreview(store, NOW, { releases: readReleaseFacts(stateDir), days: null }))).toEqual([theirs]);
  });
});

describe("(c) resolved CI notices", () => {
  const sha = (c: string) => c.repeat(40);
  const checks = () => seedFlow(store, "Fix failing CI", { kind: "github", repo: "acme/shop", watch: "checks", label: null, branch: "main", from: "team", delivery: "poll", zone: "fix" }, day(1));
  const notice = (flow: { flow: number; trigger: number }, task: string, commit: string, workflow: string, at: Date) =>
    fire(store, flow, { key: `checks:${commit}`, task, title: `Checks failed on main: ${workflow}`, at, onTime: false, filedBy: { name: "GitHub", kind: "automation" } });
  const run = (id: number, workflow: string, commit: string, conclusion: "success" | "failure", created: Date, extra: Record<string, unknown> = {}) =>
    recordBranchCheckRun(store, { repo: "acme/shop", branch: "main" }, { id, name: workflow, head_sha: commit, head_branch: "main", conclusion, created_at: created.toISOString(), event: "push", head_repository: { full_name: "acme/shop" }, ...extra }, NOW);

  test("while main stays red, a newer notice of the same workflow replaces older ones; the newest of each stays", () => {
    const flow = checks();
    notice(flow, "ci-1", sha("1"), "CI", day(20));
    notice(flow, "ci-2", sha("2"), "CI", day(22));
    notice(flow, "macos-1", sha("3"), "macOS", day(23));
    expect(Object.fromEntries(tidyPreview(store, NOW, { releases: NONE, days: null }).map(one => [one.taskId, one.reason])))
      .toEqual({ "ci-1": "A newer “CI” failure on main replaces it." });
  });

  test("a later commit's green run of the same workflow resolves a notice; a rerun of the same commit doesn't", () => {
    const flow = checks();
    notice(flow, "ci-2", sha("2"), "CI", day(22));
    expect(run(10, "CI", sha("2"), "success", day(23))).toBe(true);
    expect(tidyPreview(store, NOW, { releases: NONE, days: null })).toEqual([]);
    expect(run(11, "CI", sha("4"), "success", day(24))).toBe(true);
    expect(tidyPreview(store, NOW, { releases: NONE, days: null }).map(one => one.reason)).toEqual(["“CI” passed on main at 4444444."]);
  });

  test("a notice whose commit failed two workflows needs both settled", () => {
    const flow = checks();
    notice(flow, "ci-2", sha("2"), "CI", day(22));
    run(20, "macOS", sha("2"), "failure", day(22));
    run(21, "CI", sha("4"), "success", day(24));
    expect(tidyPreview(store, NOW, { releases: NONE, days: null })).toEqual([]);
    run(22, "macOS", sha("5"), "success", day(25));
    expect(ids(tidyPreview(store, NOW, { releases: NONE, days: null }))).toEqual(["ci-2"]);
  });

  test.each([
    ["a pull request's run", { event: "pull_request" }],
    ["a fork's branch also called main", { head_repository: { full_name: "mallory/shop" } }],
    ["another branch", { head_branch: "release" }],
    ["a cancelled run", { conclusion: "cancelled" }],
  ])("%s is never evidence", (_name, extra) => {
    expect(run(30, "CI", sha("4"), "success", day(24), extra)).toBe(false);
    expect(store.handle.prepare("SELECT COUNT(*) n FROM branch_check_run").get()?.["n"]).toBe(0);
  });
});

describe("finished tasks a person chooses", () => {
  test("only a person's preview offers finished tasks untouched for N days, a person's own included", () => {
    personTask(store, "old-done", day(1));
    store.setTaskState("old-done", "done", day(2));
    personTask(store, "new-done", day(29));
    store.setTaskState("new-done", "done", day(30));
    personTask(store, "old-queued", day(1));
    expect(tidyPreview(store, NOW, { releases: NONE, days: null })).toEqual([]);
    const items = tidyPreview(store, NOW, { releases: NONE, days: 14 });
    expect(ids(items)).toEqual(["old-done"]);
    expect(items[0]!.reason).toBe("Finished 2026-10-02, untouched for more than 14 days.");
  });
});

describe("the preview's digest and a person's apply", () => {
  const twoOld = () => {
    const flow = siteCheck();
    for (const d of [28, 29, 30]) fire(store, flow, { key: `slot:2026-10-${d}T16:00:00.000Z`, task: `site-${d}`, at: day(d) });
  };

  test("binds exactly the tasks, versions, project, rule and reason shown", () => {
    twoOld();
    const items = tidyPreview(store, NOW, { releases: NONE, days: 14 });
    const digest = tidyDigest(items, 14);
    expect(tidyDigest(items, 15)).not.toBe(digest);
    expect(tidyDigest(items.map(one => ({ ...one, reason: `${one.reason}!` })), 14)).not.toBe(digest);
    expect(tidyDigest(items.map(one => ({ ...one, members: [...one.members, 999] })), 14)).not.toBe(digest);
    expect(tidyDigest(items.slice(1), 14)).not.toBe(digest);
  });

  test("a stale digest, a ticked task outside the list and an empty choice are refused, changing nothing", () => {
    twoOld();
    addApprover(store, "alex", NOW);
    const items = tidyPreview(store, NOW, { releases: NONE, days: 14 });
    const digest = tidyDigest(items, 14);
    expect(applyTidy(store, NOW, { by: "alex", days: 14, digest: "0".repeat(32), only: null, releases: NONE })).toMatchObject({ ok: false, reason: "changed" });
    expect(applyTidy(store, NOW, { by: "alex", days: 14, digest, only: ["site-30"], releases: NONE })).toMatchObject({ ok: false, reason: "outside" });
    expect(applyTidy(store, NOW, { by: "alex", days: 14, digest, only: [], releases: NONE })).toMatchObject({ ok: false, reason: "empty" });
    expect(store.handle.prepare("SELECT COUNT(*) n FROM task_archive").get()?.["n"]).toBe(0);
  });

  test("puts away exactly the ticked part, under the person's name and each item's reason", () => {
    twoOld();
    addApprover(store, "alex", NOW);
    const items = tidyPreview(store, NOW, { releases: NONE, days: 14 });
    const done = applyTidy(store, NOW, { by: "alex", days: 14, digest: tidyDigest(items, 14), only: ["site-28"], releases: NONE });
    expect(done).toMatchObject({ ok: true, archived: [{ taskId: "site-28" }], skipped: [] });
    expect(archiveOf(store, "site-28")).toMatchObject({ by: "alex", byKind: "person", rule: "routine" });
    expect(archiveOf(store, "site-29")).toBeNull();
  });

  test("a person who lost the project between the preview and the write puts nothing away", () => {
    twoOld();
    const items = tidyPreview(store, NOW, { releases: NONE, days: 14 });
    const done = applyTidy(store, NOW, { by: "nobody", days: 14, digest: tidyDigest(items, 14), only: null, releases: NONE });
    expect(done).toMatchObject({ ok: true, archived: [] });
    expect(store.handle.prepare("SELECT COUNT(*) n FROM task_archive").get()?.["n"]).toBe(0);
  });
});

describe("tidy on its own", () => {
  const five = () => {
    const flow = siteCheck();
    for (const d of [25, 26, 27, 28, 29, 30]) fire(store, flow, { key: `slot:2026-10-${d}T16:00:00.000Z`, task: `site-${d}`, at: day(d) });
  };

  test("is bounded per pass, idempotent, and leaves one ledger row per task it put away", () => {
    five();
    expect(runTidy(store, NOW, NONE, 2).map(one => one.taskId)).toEqual(["site-25", "site-26"]);
    expect(runTidy(store, NOW, NONE).map(one => one.taskId)).toEqual(["site-27", "site-28", "site-29"]);
    expect(runTidy(store, NOW, NONE)).toEqual([]);
    const ledger = store.handle.prepare("SELECT actor, task_id, outcome, detail FROM action_ledger WHERE action = 'task archived' ORDER BY id").all();
    expect(ledger.map(row => row["task_id"])).toEqual(["site-25", "site-26", "site-27", "site-28", "site-29"]);
    expect(ledger[0]).toMatchObject({ actor: "tidy", outcome: "routine" });
    expect(archiveOf(store, "site-25")).toMatchObject({ by: "tidy", byKind: "tidy", reason: "A newer run, “site-30”, replaces it." });
  });

  test("never puts a restored task away again; a person's preview still may", () => {
    five();
    runTidy(store, NOW, NONE);
    expect(restoreTaskFamily(store, "site-25", "alex", NOW).ok).toBe(true);
    expect(runTidy(store, NOW, NONE)).toEqual([]);
    expect(ids(tidyPreview(store, NOW, { releases: NONE, days: 14 }))).toContain("site-25");
  });

  test("only reads the projects it is given", () => {
    const flow = siteCheck();
    fire(store, flow, { key: "slot:2026-10-29T16:00:00.000Z", task: "here", at: day(29) });
    fire(store, flow, { key: "slot:2026-10-30T16:00:00.000Z", task: "here-new", at: day(30) });
    expect(runTidy(store, NOW, NONE, 25, { principal: "operator", repos: ["/repo/elsewhere"], includeUnplaced: false })).toEqual([]);
    expect(runTidy(store, NOW, NONE, 25, { principal: "operator", repos: [REPO], includeUnplaced: false }).map(one => one.taskId)).toEqual(["here"]);
  });
});
