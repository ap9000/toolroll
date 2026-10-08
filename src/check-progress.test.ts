import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckProgressTracker, isCheckProgressLine, parseCheckProgressSnapshot, type CheckProgressSnapshot } from "./check-progress.js";
import { isTelegramProgressNotification, openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { register } from "./runner.js";
import { buildPushPayload } from "./push.js";
import { runOperate } from "./operate.js";
import { telegramProgressCard } from "./telegram-progress.js";

const T0 = new Date("2026-09-28T18:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const REPO = "/projects/progress";

function samples(): CheckProgressSnapshot[] {
  const seen: CheckProgressSnapshot[] = [];
  const tracker = new CheckProgressTracker(snapshot => seen.push(snapshot));
  tracker.feed("\u001b[32m Test Files  191 passed (191)\u001b[39m\n", "stderr");
  tracker.feed("[flows]   1s  PASS  opens the result\n[flows]   2s  PASS  leaves feedback\n");
  tracker.feed("[flows] 2 passed, 0 failed, 0 skipped\n");
  tracker.feed("[app]   3s  PA", "stdout");
  tracker.feed("SS  creates a revision\n[app] 1 passed, 0 failed, 0 skipped\n", "stdout");
  tracker.finish();
  return seen;
}

function fixture(store: Store): number {
  expect(addApprover(store, "alex", T0).ok).toBe(true);
  register(store, { name: "worker", host: "test", capacity: 1, repos: [REPO], now: T0, newToken: () => "runner-token" });
  store.createTask({ id: "progress-1", title: "Show check progress" }, T0);
  const ref = store.refFor("built-in", "progress-1").id;
  store.placeTask(ref, REPO, {}, T0);
  return store.startRun({
    taskRef: ref,
    leaseId: "lease-progress",
    runner: "worker",
    branch: "standing-orders/progress-1",
    worktree: "/work/progress-1",
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" },
    now: T0,
  });
}

describe("check output progress", () => {
  test("ignores output from checks that do not expose the three release suites", () => {
    const seen: CheckProgressSnapshot[] = [];
    const tracker = new CheckProgressTracker(snapshot => seen.push(snapshot));
    tracker.feed("lint passed\ncoverage complete\n");
    expect(tracker.finish()).toBeNull();
    expect(seen).toEqual([]);
  });

  test("reads split Vitest and journey output and gives every suite a final result", () => {
    const seen = samples();
    expect(seen).toContainEqual(expect.objectContaining({
      final: false,
      line: "unit ✓ 191 · flows ✓ 2 · app …",
    }));
    expect(seen.at(-1)).toMatchObject({
      final: true,
      line: "unit ✓ 191 · flows ✓ 2 · app ✓ 1",
      suites: {
        unit: { state: "passed", passed: 191, failed: 0, total: 191 },
        flows: { state: "passed", passed: 2, failed: 0, total: 2 },
        app: { state: "passed", passed: 1, failed: 0, total: 1 },
      },
    });
  });

  test("keeps failures and names missing suite results instead of guessing", () => {
    const seen: CheckProgressSnapshot[] = [];
    const tracker = new CheckProgressTracker(snapshot => seen.push(snapshot));
    tracker.feed("Test Files  1 failed | 190 passed (191)\n");
    tracker.feed("[flows] FAIL  saves feedback\n[flows] 17 passed, 1 failed, 0 skipped\n");
    expect(tracker.finish()!.line).toBe("unit ✕ 1/191 · flows ✕ 1/18 · app ?");
  });

  // Regression: the release check runs the app journeys through scripts/e2e-parallel.mjs, which
  // prefixes every line with the group's name; those lines used to leave the app suite at "…".
  test("reads the app journeys from the parallel runner, with each group's final result", () => {
    const seen: CheckProgressSnapshot[] = [];
    const tracker = new CheckProgressTracker(snapshot => seen.push(snapshot));
    tracker.feed("Test Files  191 passed (191)\n[flows] 2 passed, 0 failed, 0 skipped\n");
    tracker.feed("Running 3 groups at once: console, task, flows\n");
    tracker.feed("[console] [app]     4s  ...   Sign-in\n[console] [app]     9s  PASS  Sign-in (5 s)\n");
    tracker.feed("[flows  ] [app]     6s  PASS  Code steps (6 s)\n[task   ] [app]     7s  PASS  An idea (7 s)\n");
    expect(seen.at(-1)!.line).toBe("unit ✓ 191 · flows ✓ 2 · app 3 · 0/3 groups");
    tracker.feed("[flows  ] [app]    20s  PASS  No browser errors on any page (0 s)\n[flows  ] [app]    21s  2 passed, 0 failed, 0 skipped — /tmp/flows/report.md\n");
    tracker.feed("[console] [app]    30s  PASS  No browser errors on any page (0 s)\n[console] [app]    31s  2 passed, 0 failed, 0 skipped — /tmp/console/report.md\n");
    expect(seen.at(-1)!.line).toBe("unit ✓ 191 · flows ✓ 2 · app 5 · 2/3 groups");
    tracker.feed("[task   ] [app]    40s  FAIL  Sent back: timed out\n[task   ] [app]    41s  1 passed, 1 failed, 0 skipped — /tmp/task/report.md\n");
    expect(seen.at(-1)!.line).toBe("unit ✓ 191 · flows ✓ 2 · app ✕ 1/6 · 2/3 groups");
    tracker.feed("\n# console — 2 passed, 0 failed, 0 skipped (0.5 min)\n- ✅ Sign-in — 5 s\n");
    tracker.feed("✅ console  0.5 min\n❌ task     0.7 min\n✅ flows    0.4 min\n\n2 of 3 groups passed in 0.7 min — /tmp/out\n");
    const final = tracker.finish()!;
    expect(final).toMatchObject({
      final: true,
      line: "unit ✓ 191 · flows ✓ 2 · app ✕ 1/6 · 2/3 groups",
      suites: { app: { state: "failed", passed: 5, failed: 1, skipped: 0, total: 6, groups: { passed: 2, failed: 1, total: 3 } } },
    });
    expect(parseCheckProgressSnapshot(JSON.stringify(final))).toEqual(final);
    expect(isCheckProgressLine(final.line)).toBe(true);

    const passing = new CheckProgressTracker(() => undefined);
    passing.feed("Test Files  1 passed (1)\n[flows] 1 passed, 0 failed, 0 skipped\nRunning 2 groups at once: console, mail\n");
    passing.feed("[console] [app]  9s  PASS  Sign-in (5 s)\n[console] [app]  10s  1 passed, 0 failed, 0 skipped — r\n");
    expect(passing.snapshot().line).toBe("unit ✓ 1 · flows ✓ 1 · app 1 · 1/2 groups");
    passing.feed("[mail   ] [app]  3s  SKIP  Email inbox (no Docker)\n[mail   ] [app]  4s  0 passed, 0 failed, 1 skipped — r\n");
    passing.feed("✅ console  0.2 min\n✅ mail     0.1 min\n\n2 of 2 groups passed in 0.2 min — /tmp/out\n");
    expect(passing.finish()!.line).toBe("unit ✓ 1 · flows ✓ 1 · app ✓ 1/2 · 2/2 groups");
  });

  test("the release check's flows in groups, then app's groups, then its summary with how long each part took", () => {
    const tracker = new CheckProgressTracker(() => undefined);
    tracker.feed("== typecheck\n> tsc --noEmit\n== build\n> tsc -p tsconfig.build.json\n== unit\n Test Files  2 passed (2)\n== flows\nRunning 2 groups at once: build, triggers\n");
    tracker.feed("[build   ] [flows]     4s  PASS  Sign in (4 s)\n[triggers] [flows]     5s  PASS  Sign in (5 s)\n[triggers] [flows]    50s  2 passed, 0 failed, 0 skipped — r\n");
    tracker.feed("[build   ] [flows]    90s  PASS  A real build (80 s)\n[build   ] [flows]    91s  2 passed, 0 failed, 0 skipped — r\n");
    tracker.feed("✅ build     1.5 min\n✅ triggers  0.8 min\n\n2 of 2 groups passed in 1.5 min — /tmp/flows\n");
    expect(tracker.snapshot().line).toBe("unit ✓ 2 · flows ✓ 4 · 2/2 groups · app …");
    tracker.feed("== app\nRunning 2 groups, at most 1 at once (0.7 GB available, about 400 MB each): mail, follow-ups\n[mail      ] [app]  9s  PASS  Email inbox (9 s)\n[mail      ] [app]  10s  1 passed, 0 failed, 0 skipped — r\n");
    tracker.feed("[follow-ups] [app]  9s  FAIL  Follow-ups: timed out\n[follow-ups] [app]  10s  0 passed, 1 failed, 0 skipped — r\n");
    tracker.feed("✅ mail        0.2 min\n❌ follow-ups  0.2 min\n\n1 of 2 groups passed in 0.2 min — /tmp/app\n");
    tracker.feed("== summary\nplan: a full check was asked for\nunit: exit 0\n Test Files  2 passed (2)\nflows: exit 0\napp: exit 1\n");
    tracker.feed("took: typecheck 5 s, build 8 s, unit 4.1 min, flows 1.5 min, app 0.2 min; whole check 4.3 min\n");
    expect(tracker.finish()!.line).toBe("unit ✓ 2 · flows ✓ 4 · 2/2 groups · app ✕ 1/2 · 1/2 groups");
  });
});

describe("saved and delivered progress", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null; });

  test("saves every line, notifies once a minute, and always sends the final summary", () => {
    const store = openStore(":memory:");
    const run = fixture(store);
    expect(store.enrollPushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/progress",
      p256dh: "B".repeat(87), auth: "a".repeat(22), approver: "alex", approverGeneration: 1,
      uaWords: "phone", vapidFingerprint: "fp-progress",
    }, T0)).toMatchObject({ ok: true });
    const all = samples();
    const unit = all.find(one => one.line === "unit ✓ 191 · flows … · app …")!;
    const flows = all.find(one => one.line === "unit ✓ 191 · flows ✓ 2 · app …")!;
    const final = all.at(-1)!;

    expect(store.saveCheckProgress(run, unit, T0)).toEqual({ changed: true, notified: true });
    expect(store.saveCheckProgress(run, flows, later(30_000))).toEqual({ changed: true, notified: false });
    expect(store.checkProgress(run)?.line).toBe(flows.line);
    expect(store.saveCheckProgress(run, { ...flows, line: "unit ✓ 191 · flows ✓ 2 · app 1", suites: { ...flows.suites, app: { state: "running", passed: 1, failed: 0, skipped: 0, total: null } } }, later(60_000))).toEqual({ changed: true, notified: true });
    expect(store.saveCheckProgress(run, final, later(60_001))).toEqual({ changed: true, notified: true });
    expect(store.saveCheckProgress(run, final, later(120_000))).toEqual({ changed: false, notified: false });

    const notices = store.listNotifications("all").filter(row => row.kind === "check-progress");
    expect(notices.map(row => row.body)).toEqual([unit.line, "unit ✓ 191 · flows ✓ 2 · app 1", final.line]);
    expect(notices.every(row => isTelegramProgressNotification(row))).toBe(true);
    expect(telegramProgressCard(store, store.getRun(run)!, "progress-1", REPO, later(60_001)).text).toContain(final.line);
    expect(store.seedPushPairs(later(120_000))).toBe(3);
    const pairs = store.claimPushPairs("push", 60_000, 10, later(120_000));
    const fenced = pairs.map(pair => store.pushSendFence(pair.id, "push", pair.claimGeneration)?.notificationRow).filter(Boolean);
    expect(fenced).toHaveLength(3);
    expect(fenced.at(-1)?.pushClass).toBe("progress");
    expect(JSON.parse(buildPushPayload(fenced.at(-1)!))).toMatchObject({ body: final.line, url: `/r/${run}`, tag: `so-run-${run}` });
    store.close();
  });

  test("the CLI returns the same saved line", async () => {
    dir = mkdtempSync(join(tmpdir(), "so-check-progress-"));
    const file = join(dir, "orders.db");
    const store = openStore(file);
    const run = fixture(store);
    const final = samples().at(-1)!;
    store.saveCheckProgress(run, final, T0);
    store.close();

    const lines: string[] = [];
    const code = await runOperate("check-progress", [String(run), "--json"], line => lines.push(line), { databaseFile: file, now: T0 });
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, command: "check-progress", run, progress: { line: final.line, final: true } });
  });

  test("progress and the result share one row, and a running check does not block its result", () => {
    dir = mkdtempSync(join(tmpdir(), "so-check-progress-"));
    const store = openStore(join(dir, "orders.db"));
    const run = fixture(store);
    const seen = samples();
    store.saveCheckProgress(run, seen[0]!, T0);
    expect(store.runCheckFor(run)).toBeNull();

    store.recordRunCheck(run, { status: "passed", exitCode: 0, suites: [{ name: "unit", status: "passed", exitCode: 0 }] }, later(1_000));
    store.recordRunCheck(run, { status: "failed", exitCode: 1, suites: [] }, later(2_000));
    store.saveCheckProgress(run, seen.at(-1)!, later(3_000));
    expect(store.runCheckFor(run)).toEqual({ status: "passed", exitCode: 0, suites: [{ name: "unit", status: "passed", exitCode: 0 }] });
    expect(store.checkProgress(run)).toMatchObject({ run, line: seen.at(-1)!.line, final: true });
    expect(store.handle.prepare("SELECT count(*) AS n FROM run_check").get()).toEqual({ n: 1 });
    expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name = 'check_progress'").get()).toBeUndefined();
    store.close();
  });

  test("a file with the older separate tables opens with one row per run", () => {
    dir = mkdtempSync(join(tmpdir(), "so-check-progress-"));
    const file = join(dir, "orders.db");
    const old = openStore(file);
    const run = fixture(old);
    const final = samples().at(-1)!;
    old.handle.exec(`DROP TABLE run_check;
      CREATE TABLE run_check (run INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'not-run')),
        exit_code INTEGER, suites_json TEXT NOT NULL DEFAULT '[]', release INTEGER NOT NULL DEFAULT 0 CHECK (release IN (0, 1)), recorded_at TEXT NOT NULL);
      CREATE INDEX run_check_release ON run_check (run DESC) WHERE release = 1;
      CREATE TABLE check_progress (run INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE, snapshot TEXT NOT NULL, line TEXT NOT NULL,
        final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0,1)), updated_at TEXT NOT NULL, notified_at TEXT);`);
    old.handle.prepare("INSERT INTO run_check (run, status, exit_code, release, recorded_at) VALUES (?, 'failed', 1, 1, ?), (?, 'passed', 0, 0, ?)")
      .run(run, T0.toISOString(), run + 50, T0.toISOString());
    old.handle.prepare("INSERT INTO check_progress (run, snapshot, line, final, updated_at, notified_at) VALUES (?, ?, ?, 1, ?, ?)")
      .run(run, JSON.stringify(final), final.line, T0.toISOString(), T0.toISOString());
    old.handle.exec("UPDATE schema_version SET version = 113"); // an older build's file reads older (v114)
    old.close();

    const store = openStore(file);
    expect(store.runCheckFor(run)).toEqual({ status: "failed", exitCode: 1, suites: [] });
    expect(store.checkProgress(run)).toMatchObject({ run, line: final.line, final: true, notifiedAt: T0.toISOString() });
    expect(store.runCheckFor(run + 50)).toBeNull();
    expect(store.handle.prepare("SELECT run, release FROM run_check").all()).toEqual([{ run, release: 1 }]);
    expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name = 'run_check_next'").all()).toEqual([]);
    expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name = 'run_check_release'").get()).toEqual({ name: "run_check_release" });
    // The old table keeps its rows (a deploy refuses a migration that loses them) …
    expect(store.handle.prepare("SELECT run, line FROM check_progress").all()).toEqual([{ run, line: final.line }]);
    // … and never overwrites newer progress when the file opens again.
    const first = samples()[0]!;
    store.saveCheckProgress(run, first, later(5_000));
    store.close();
    const again = openStore(file);
    expect(again.checkProgress(run)).toMatchObject({ run, line: first.line, final: first.final });
    again.close();
  });
});
