/** The measurement: by assigned arm, on the completed-run convention (docs/plans/code-map.md §7). */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { seedMap } from "../test/code-map-seed.js";
import { armOf, readSnapshot } from "./code-map-admission.js";
import { endHoldout } from "./code-map-acts.js";
import { codeMapReport, NOT_ENOUGH, reportRows, type Arm } from "./code-map-report.js";
import { knowledgeContext } from "./project-knowledge.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { openStore, type Store } from "./store.js";

const T0 = new Date("2026-11-06T12:00:00.000Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);
let root: string, repo: string, store: Store, password: string, head: string, serial = 0;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-map-report-")));
  repo = join(root, "repo"); mkdirSync(repo);
  git("init", "-q"); writeFileSync(join(repo, "a.md"), "x\n"); git("add", "."); git("commit", "-qm", "seed"); head = git("rev-parse", "HEAD");
  store = openStore(join(root, "orders.db"));
  const user = addApprover(store, "alex", T0); if (!user.ok) throw new Error("fixture"); password = user.token;
  for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", T0);
  register(store, { name: "runner", host: "test", capacity: 1000, repos: [repo], now: T0, newToken: () => "runner-token" });
  store.upsertProject(repo, "repo", T0, { remoteUrl: "https://git.example/repo.git" });
  seedMap(store, repo, { "src/a.ts": { names: ["a"] } }, T0);
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const idFor = (arm: Arm): string => { for (;;) { const id = `family-${serial++}`; if (armOf(id) === arm) return id; } };
function admit(id: string, at: Date, role: "builder" = "builder"): number {
  if (store.getTask(id) === null) {
    store.createTask({ id, title: "Work" }, at);
    store.placeTask(store.refFor("built-in", id).id, repo);
    propose(store, { taskId: id, goal: "Work", touches: ["src"], acceptance: [], now: at }); approve(store, id, "alex", at, store.getScope(id)!.digest, password);
  }
  const ref = store.refFor("built-in", id).id;
  const route = store.routeAuthorityFor(ref, role, { provider: "claude", model: "sonnet" }); if (!route?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `lease-${id}-${serial++}`, runner: "runner", role, branch: `standing-orders/${id}`, worktree: repo, provider: "claude", model: "sonnet", now: at, route: route.stamp });
  store.stampRun(run, { baseRevision: head, scopeDigest: store.getScope(id)!.digest });
  knowledgeContext(store, run, undefined, undefined, at);
  store.handle.prepare("UPDATE run_cohort SET ineligible = NULL, cohort_size = 'small' WHERE run = ?").run(run);
  store.handle.prepare("UPDATE run SET provider_started_at = ? WHERE id = ?").run(at.toISOString(), run);
  return run;
}
function finish(run: number, at: Date, cost = 1, turns = 4): void {
  store.recordUsage(run, { tokensIn: 100, tokensOut: 50, costUsd: cost, agentTurns: turns });
  store.finishRun(run, { outcome: "failed", committed: false, now: at });
  // A recorded API charge: known money.
  store.handle.prepare("UPDATE run SET billing_basis = 'evidence', cost_unknown = 0 WHERE id = ?").run(run);
  store.handle.prepare("DELETE FROM run_spend WHERE run = ?").run(run);
  store.handle.prepare("INSERT INTO run_spend (run, microusd, source, billing, priced_at) VALUES (?, ?, 'reported', 'api-key', ?)").run(run, Math.round(cost * 1_000_000), at.toISOString());
}
const report = (at: Date) => codeMapReport(store, repo, at);

describe("arms", () => {
  test("families are reported by assigned arm; one delivered differently is shown, never dropped", () => {
    const a = admit(idFor("map"), T0), b = admit(idFor("holdout"), T0);
    finish(a, day(1)); finish(b, day(1));
    store.handle.prepare("UPDATE project SET code_map = 0").run();
    const late = idFor("map");
    const off = admit(late, day(2)); finish(off, day(3));
    expect(readSnapshot(store, off)!.state).toBe("off");
    const read = report(day(40));
    expect(read.arms.map).toMatchObject({ families: 2, complete: 2, deliveredDifferently: 1 });
    expect(read.arms.holdout).toMatchObject({ families: 1, complete: 1, deliveredDifferently: 0 });
  });
  test("ending the holdout early keeps existing families' arms and enrolls no more", () => {
    const held = idFor("holdout");
    finish(admit(held, T0), day(1));
    const done = endHoldout(store, { kind: "person", person: { actor: "alex", generation: store.accountOf("alex")!.generation, method: "session" } }, repo, day(2));
    expect(done).toEqual({ ok: true });
    finish(admit(held, day(3)), day(4));
    const fresh = idFor("holdout");
    const run = admit(fresh, day(3));
    expect(readSnapshot(store, run)!.state).toBe("map");
    expect(store.handle.prepare("SELECT 1 FROM code_map_family WHERE root_task = ?").get(fresh)).toBeUndefined();
    expect(report(day(40)).arms.holdout.families).toBe(1);
  });
});

describe("the completed-run convention", () => {
  test("a run admitted before the cutoff counts in full, even finished after it; one admitted after doesn't", () => {
    const id = idFor("map");
    finish(admit(id, T0), day(1), 1);
    finish(admit(id, day(20)), day(30), 2); // admitted inside the window, finished past it
    finish(admit(id, day(22)), day(23), 500); // admitted after the cutoff
    expect(report(day(40)).arms.map).toMatchObject({ complete: 1, apiUsd: 3 });
  });
  test("cost comes from the counted runs, not route_record totals that keep growing", () => {
    const id = idFor("map");
    finish(admit(id, T0), day(1), 2);
    finish(admit(id, day(22)), day(23), 500);
    store.handle.prepare(`INSERT INTO route_record (task_ref, state, api_microusd, evaluated_at) VALUES (?, 'pending', 999000000, ?)`).run(store.refFor("built-in", id).id, T0.toISOString());
    expect(report(day(40)).arms.map.apiUsd).toBeCloseTo(2);
  });
  test("an unfinished counted run keeps its family still running; one in its window is counted, not compared", () => {
    admit(idFor("map"), T0);
    finish(admit(idFor("map"), T0), day(1));
    expect(report(day(5)).arms.map).toMatchObject({ stillRunning: 1, inWindow: 1, complete: 0 });
    expect(report(day(40)).arms.map).toMatchObject({ stillRunning: 1, inWindow: 0, complete: 1 });
  });
  test("a family with no eligible cohort is counted apart", () => {
    const run = admit(idFor("map"), T0);
    finish(run, day(1));
    store.handle.prepare("UPDATE run_cohort SET ineligible = 'large', cohort_size = NULL WHERE run = ?").run(run);
    expect(report(day(40)).arms.map).toMatchObject({ families: 1, notEligible: 1, complete: 0 });
  });
});

describe("what it shows", () => {
  test("unknown shows —, and below 10 in an arm there is no comparison", () => {
    const run = admit(idFor("map"), T0);
    store.finishRun(run, { outcome: "failed", committed: false, now: day(1) });
    const read = report(day(40));
    expect(read.enough).toBe(false);
    expect(read.arms.map.turns).toBeNull();
    expect(reportRows(read).map(row => row.label)).not.toContain("Turns, per build");
    expect(NOT_ENOUGH).toBe("Not enough results yet.");
  });
  test("ten complete families in each arm compare, kept apart by kind", () => {
    for (let n = 0; n < 10; n++) { finish(admit(idFor("map"), T0), day(1), 1, 4); finish(admit(idFor("holdout"), T0), day(1), 3, 8); }
    const read = report(day(40));
    expect(read.enough).toBe(true);
    const rows = Object.fromEntries(reportRows(read).map(row => [row.label, [row.map, row.holdout]]));
    expect(rows["API dollars, per build"]).toEqual(["$1.00", "$3.00"]);
    expect(rows["Turns, per build"]).toEqual(["4.0", "8.0"]);
    expect(rows["First check passed"]).toEqual(["—", "—"]);
  });
});
