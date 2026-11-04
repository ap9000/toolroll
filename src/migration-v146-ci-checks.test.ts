/** v146: pull request checks' own timing (ci_check) and release steps (release_step). New tables only: no saved row
 * changes. A check row is written only with the observation that won its generation, and only from well-formed rollup
 * items. Isolated databases only. */
import { test, expect, describe } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, parseCiRollup, ciChecksFor, shipChecksForTask, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, type Store } from "./store.js";
import { historySnapshot, changedHistory } from "./toolroll-update.js";
import { observeChecks, settleWithChecks, type PublishExec } from "./publish.js";

const T0 = new Date("2026-11-02T10:00:00.000Z");

test.each([145, -145])("v%s databases gain the check and release-step tables, no saved row changed", version => {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v146-"));
  const file = join(dir, "state.db");
  try {
    const first = openStore(file);
    first.createTask({ id: "release-0.9.87-aaaaaaa", title: "Release 0.9.87" }, T0);
    first.close();
    const old = new DatabaseSync(file);
    old.exec("DROP TABLE ci_check; DROP TABLE release_step;");
    old.prepare("UPDATE schema_version SET version = ?").run(version);
    const before = historySnapshot(old);
    old.close();
    const migrated = openStore(file);
    expect(SCHEMA_VERSION).toBe(147);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(146);
    expect(migrated.getTask("release-0.9.87-aaaaaaa")?.title).toBe("Release 0.9.87");
    expect(migrated.handle.prepare("SELECT COUNT(*) n FROM ci_check").get()?.["n"]).toBe(0);
    expect(migrated.handle.prepare("SELECT COUNT(*) n FROM release_step").get()?.["n"]).toBe(0);
    migrated.close();
    const after = new DatabaseSync(file);
    try {
      expect(after.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(147);
      expect(changedHistory(after, before)).toEqual([]);
      expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const run = (over: Record<string, unknown> = {}) => ({ __typename: "CheckRun", name: "Lint", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS",
  startedAt: "2026-11-02T09:58:00Z", completedAt: "2026-11-02T09:58:11Z", detailsUrl: "https://github.com/alex/thing/actions/runs/1/job/2", ...over });

describe("parseCiRollup", () => {
  test("keeps check runs and status contexts in their own words", () => {
    expect(parseCiRollup([
      run(),
      run({ name: "Unit tests", status: "IN_PROGRESS", conclusion: null, completedAt: null }),
      run({ name: "E2E", conclusion: "FAILURE" }),
      run({ name: "Docs", status: "QUEUED", conclusion: null, startedAt: null, completedAt: null }),
      { __typename: "StatusContext", context: "netlify/deploy", state: "SUCCESS", startedAt: "2026-11-02T09:58:01Z", targetUrl: "https://app.netlify.com/x" },
    ])).toEqual([
      { name: "Lint", workflow: "CI", state: "passed", startedAt: "2026-11-02T09:58:00.000Z", completedAt: "2026-11-02T09:58:11.000Z", url: "https://github.com/alex/thing/actions/runs/1/job/2", kind: "run" },
      { name: "Unit tests", workflow: "CI", state: "running", startedAt: "2026-11-02T09:58:00.000Z", completedAt: null, url: "https://github.com/alex/thing/actions/runs/1/job/2", kind: "run" },
      { name: "E2E", workflow: "CI", state: "failed", startedAt: "2026-11-02T09:58:00.000Z", completedAt: "2026-11-02T09:58:11.000Z", url: "https://github.com/alex/thing/actions/runs/1/job/2", kind: "run" },
      { name: "Docs", workflow: "CI", state: "queued", startedAt: null, completedAt: null, url: "https://github.com/alex/thing/actions/runs/1/job/2", kind: "run" },
      // Only a link to GitHub itself is kept.
      { name: "netlify/deploy", workflow: null, state: "passed", startedAt: "2026-11-02T09:58:01.000Z", completedAt: null, url: null, kind: "status" },
    ]);
  });

  test.each([
    ["not an array", { name: "Lint" }],
    ["a non-object item", ["Lint", 7, null, []]],
    ["no name", [run({ name: "" }), run({ name: 12 })]],
    ["a name over the limit", [run({ name: "x".repeat(201) })]],
    ["an unknown status", [run({ status: "SLEEPING" })]],
    ["an unknown conclusion", [run({ conclusion: "MAYBE" })]],
    ["an unknown context state", [{ __typename: "StatusContext", context: "ci/x", state: "WEIRD" }]],
  ])("drops %s", (_, rollup) => {
    expect(parseCiRollup(rollup)).toEqual([]);
  });

  test("bad times and links read null, and the count is bounded", () => {
    const [row] = parseCiRollup([run({ startedAt: "yesterday", completedAt: "0001-01-01T00:00:00Z", detailsUrl: "javascript:alert(1)" })]);
    expect(row).toEqual({ name: "Lint", workflow: "CI", state: "passed", startedAt: null, completedAt: null, url: null, kind: "run" });
    expect(parseCiRollup([run({ detailsUrl: "http://github.com/x" })])[0]!.url).toBeNull();
    expect(parseCiRollup([run({ detailsUrl: "https://user:pw@github.com/x" })])[0]!.url).toBeNull();
    expect(parseCiRollup([run({ name: "Lint\u0000\u001b[31m" })])[0]!.name).toBe("Lint[31m");
    // C1 controls (a CSI introducer among them) and bidi/format characters are gone too: no terminal escape, no spoofed order.
    expect(parseCiRollup([run({ name: "Lint\u009b31m\u0085\u202eevil\u202c\u2066x\u2069\u200e\u200f\u200b\ufeff" })])[0]!.name).toBe("Lint31mevilx");
    expect(parseCiRollup(Array.from({ length: 500 }, (_, n) => run({ name: `check ${n}` })))).toHaveLength(200);
  });
});

describe("a failing check is never hidden behind a namesake", () => {
  test("the same name in two workflows stays two checks; the same check twice keeps the worse state", () => {
    expect(parseCiRollup([run({ name: "test", workflowName: "unit" }), run({ name: "test", workflowName: "security", conclusion: "FAILURE" })])
      .map(one => [one.workflow, one.name, one.state])).toEqual([["unit", "test", "passed"], ["security", "test", "failed"]]);
    expect(parseCiRollup([run(), run({ conclusion: "FAILURE" })]).map(one => one.state)).toEqual(["failed"]);
    expect(parseCiRollup([run({ conclusion: "FAILURE" }), run()]).map(one => one.state)).toEqual(["failed"]);
    // A check run and a commit status with one name are two checks too.
    expect(parseCiRollup([run({ name: "ci/build", workflowName: null }), { __typename: "StatusContext", context: "ci/build", state: "FAILURE" }])).toHaveLength(2);
  });

  test("a workflow-less check run and a commit status with one name stay two checks through the store", () => {
    const store = openStore(":memory:");
    try {
      const generation = store.reserveObservation("alex/thing", 9);
      settleWithChecks(store, { githubRepo: "alex/thing", prNumber: 9, headSha: "oid-1", state: "failing", generation },
        [run({ name: "ci/build", workflowName: null }), { __typename: "StatusContext", context: "ci/build", state: "FAILURE" }], T0);
      expect(ciChecksFor(store, "alex/thing", 9)!.checks.map(one => [one.kind, one.name, one.state]).sort()).toEqual([["run", "ci/build", "passed"], ["status", "ci/build", "failed"]]);
    } finally { store.close(); }
  });

  test("both are stored, and the overall status is the observation's own", () => {
    const store = openStore(":memory:");
    try {
      const generation = store.reserveObservation("alex/thing", 9);
      settleWithChecks(store, { githubRepo: "alex/thing", prNumber: 9, headSha: "oid-1", state: "failing", generation },
        [run({ name: "test", workflowName: "unit" }), run({ name: "test", workflowName: "security", conclusion: "FAILURE" })], T0);
      const read = ciChecksFor(store, "alex/thing", 9)!;
      expect(read.observed).toBe("failing");
      expect(read.checks.map(one => [one.workflow, one.state]).sort()).toEqual([["security", "failed"], ["unit", "passed"]]);
    } finally { store.close(); }
  });
});

describe("ci_check is written only with a winning observation", () => {
  const opened = (store: Store) => {
    store.createTask({ id: "t-1", title: "Fix the payout rounding drift" }, T0);
    const taskRef = store.refFor("built-in", "t-1").id;
    const runId = store.startRun({ taskRef, leaseId: "lease-1", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1",
      route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: T0 });
    const id = store.createPublicationIntent({ run: runId, taskRef, githubRepo: "alex/thing", remote: "origin", base: "main", head: "standing-orders/t-1", headSha: "abc123", bodyHash: "x", draft: true }, T0);
    store.markPublicationPushed(id, T0);
    store.markPublicationOpened(id, 9, "https://github.com/alex/thing/pull/9", T0);
  };

  test("a losing generation writes no check; the winner replaces the head's rows wholesale", () => {
    const store = openStore(":memory:");
    try {
      const older = store.reserveObservation("alex/thing", 9);
      const newer = store.reserveObservation("alex/thing", 9);
      expect(settleWithChecks(store, { githubRepo: "alex/thing", prNumber: 9, headSha: "oid-1", state: "passing", generation: older }, [run()], T0)).toEqual({ won: false });
      expect(store.handle.prepare("SELECT COUNT(*) n FROM ci_check").get()?.["n"]).toBe(0);
      expect(ciChecksFor(store, "alex/thing", 9)).toBeNull();
      expect(settleWithChecks(store, { githubRepo: "alex/thing", prNumber: 9, headSha: "oid-2", state: "running", generation: newer },
        [run(), run({ name: "Unit tests", status: "IN_PROGRESS", conclusion: null, completedAt: null })], T0)).toEqual({ won: true });
      expect(ciChecksFor(store, "alex/thing", 9)).toMatchObject({ headSha: "oid-2", checks: [{ name: "Lint", state: "passed" }, { name: "Unit tests", state: "running" }] });
      // The stale answer arriving late still loses, and leaves the winner's rows as they are.
      expect(settleWithChecks(store, { githubRepo: "alex/thing", prNumber: 9, headSha: "oid-1", state: "failing", generation: older }, [run({ conclusion: "FAILURE" })], T0)).toEqual({ won: false });
      expect(ciChecksFor(store, "alex/thing", 9)!.checks.map(one => one.name)).toEqual(["Lint", "Unit tests"]);
      // A newer head replaces the older head's rows.
      const third = store.reserveObservation("alex/thing", 9);
      settleWithChecks(store, { githubRepo: "alex/thing", prNumber: 9, headSha: "oid-3", state: "passing", generation: third }, [run({ name: "Typecheck" })], T0);
      expect(store.handle.prepare("SELECT DISTINCT head_sha FROM ci_check").all().map(one => one["head_sha"])).toEqual(["oid-3"]);
    } finally { store.close(); }
  });

  test("observeChecks records the task's pull request checks for the Ship view", async () => {
    const store = openStore(":memory:");
    try {
      opened(store);
      const exec: PublishExec = async () => ({ code: 0, stdout: JSON.stringify({ headRefOid: "oid-1", state: "OPEN", statusCheckRollup: [run(), run({ name: "E2E", conclusion: "FAILURE" }), { bogus: true }] }), stderr: "", timedOut: false, notFound: false });
      await observeChecks(store, { clock: () => T0, exec });
      expect(shipChecksForTask(store, "t-1")).toEqual({ githubRepo: "alex/thing", prNumber: 9, headSha: "oid-1", observedAt: T0.toISOString(), observed: "failing", checks: [
        { name: "E2E", workflow: "CI", state: "failed", startedAt: "2026-11-02T09:58:00.000Z", completedAt: "2026-11-02T09:58:11.000Z", url: "https://github.com/alex/thing/actions/runs/1/job/2", kind: "run" },
        { name: "Lint", workflow: "CI", state: "passed", startedAt: "2026-11-02T09:58:00.000Z", completedAt: "2026-11-02T09:58:11.000Z", url: "https://github.com/alex/thing/actions/runs/1/job/2", kind: "run" },
      ] });
      expect(shipChecksForTask(store, "no-such-task")).toBeNull();
    } finally { store.close(); }
  });
});
