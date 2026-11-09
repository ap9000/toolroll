/**
 * The service beats (docs/plans/live-wakeups.md, slices 4 and 6): the fast CI pass reads only the pull requests that
 * wait, at most ten a pass, through the existing reader; a failed fast pass records nothing; nothing runs while a
 * project loop's reconciliation does not stand.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN, openStore, type Store } from "./store.js";
import { FAST_CI_EVERY_MS, FAST_CI_LIMIT, fastCiWaiting, joinServiceBeats, type ServiceBeatMember } from "./operate.js";
import type { PublishExec } from "./publish.js";

const T0 = new Date("2026-11-09T12:00:00.000Z");
let dir = "";
let store: Store;

beforeEach(() => {
  // The delivery beat reads outgoing webhook addresses from the environment: a test never posts to a real one.
  for (const prefix of ["TOOLROLL_", "STANDING_ORDERS_"]) for (const name of ["SLACK_WEBHOOK", "DISCORD_WEBHOOK"]) vi.stubEnv(`${prefix}${name}`, "");
  dir = mkdtempSync(join(tmpdir(), "so-service-beats-"));
  store = openStore(join(dir, "orders.db"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An opened pull request, with what CI was last seen doing. */
function opened(n: number, lastCheck: string | null, at: Date = T0): number {
  store.createTask({ id: `t-${n}`, title: `t-${n}` }, T0);
  const taskRef = store.refFor(BUILT_IN, `t-${n}`).id;
  store.placeTask(taskRef, "/repo");
  const run = store.startRun({ taskRef, leaseId: `l-${n}`, runner: "b", branch: `b-${n}`, worktree: "/w",
    route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: T0 });
  store.handle.prepare(`INSERT INTO publication (run, task_ref, github_repo, remote, base, head, head_sha, body_hash, draft, state, pr_number, pr_url,
      last_check_state, last_check_at, created_at, updated_at) VALUES (?, ?, 'o/r', 'origin', 'main', ?, ?, 'h', 0, 'opened', ?, ?, ?, ?, ?, ?)`)
    .run(run, taskRef, `b-${n}`, String(n).padStart(40, "a"), n, `https://example.test/pull/${n}`, lastCheck, lastCheck === null ? null : at.toISOString(), at.toISOString(), at.toISOString());
  return Number(store.handle.prepare("SELECT id FROM publication WHERE run = ?").get(run)!["id"]);
}

function member(exec: PublishExec, ready: () => boolean, lines: string[]): ServiceBeatMember {
  const context = { store, databaseFile: join(dir, "orders.db"), telegramTokenFile: join(dir, "telegram-token"), evidenceRoot: join(dir, "evidence"),
    clock: () => new Date(Date.now()), publishExec: exec };
  return { context: context as unknown as ServiceBeatMember["context"], progress: line => lines.push(line), ciReady: ready };
}

test("only pull requests waiting on their checks or their merge, oldest read first, at most ten", () => {
  const unread = Array.from({ length: 12 }, (_, i) => opened(i + 1, null));
  const running = opened(20, "running", new Date(T0.getTime() - 60_000));
  opened(21, "failing");
  opened(22, "passing"); // green and not followed: nothing waits on it here
  const recentNone = opened(23, "none", new Date(T0.getTime() - 60_000));
  opened(24, "none", new Date(T0.getTime() - 2 * 60 * 60_000)); // no CI at all: the 5 minute pass keeps it
  const mergeWaits = opened(25, "passing");
  store.handle.prepare("INSERT INTO merge_intent (publication, grant_terms_hash, head_sha, method, state, generation, created_at) VALUES (?, 'g', ?, 'squash', 'pending', 1, ?)")
    .run(mergeWaits, "a".repeat(40), T0.toISOString());
  const everyWaiting = fastCiWaiting(store, T0, 100).map(one => one.id);
  expect(new Set(everyWaiting)).toEqual(new Set([...unread, running, recentNone, mergeWaits]));
  const first = fastCiWaiting(store, T0).map(one => one.id);
  expect(first).toHaveLength(FAST_CI_LIMIT);
  expect(first).toEqual(unread.slice(0, FAST_CI_LIMIT)); // never read sorts before read
});

test("the fast beat reads waiting pull requests through the existing reader, only while every loop's reconciliation stands", async () => {
  vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  for (let n = 1; n <= 12; n++) opened(n, null);
  opened(30, "failing");
  const asked: string[] = [];
  const exec: PublishExec = async (file, args) => {
    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      asked.push(String(args[2]));
      return { code: 0, stdout: JSON.stringify({ statusCheckRollup: [{ status: "IN_PROGRESS" }], headRefOid: String(args[2]).padStart(40, "a"), state: "OPEN", mergeCommit: null }), stderr: "", timedOut: false, notFound: false };
    }
    return { code: 1, stdout: "", stderr: "unexpected", timedOut: false, notFound: false };
  };
  let ready = false;
  const lines: string[] = [];
  const leave = joinServiceBeats(member(exec, () => ready, lines));
  try {
    await vi.advanceTimersByTimeAsync(FAST_CI_EVERY_MS);
    expect(asked).toEqual([]); // reconciliation doesn't stand yet: nothing is read
    ready = true;
    await vi.advanceTimersByTimeAsync(FAST_CI_EVERY_MS);
    expect(asked).toHaveLength(FAST_CI_LIMIT);
    expect(asked).not.toContain("30");
    // What it read is recorded exactly as the 5 minute pass records it: still running.
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM publication WHERE last_check_state = 'running'").get()!["n"]).toBe(FAST_CI_LIMIT);
    await vi.advanceTimersByTimeAsync(FAST_CI_EVERY_MS);
    // The two not read last time come first now.
    expect(asked.slice(FAST_CI_LIMIT, FAST_CI_LIMIT + 2).sort()).toEqual(["11", "12"]);
  } finally { await leave(); }
  const after = asked.length;
  await vi.advanceTimersByTimeAsync(FAST_CI_EVERY_MS * 3);
  expect(asked).toHaveLength(after); // the last loop left: the beat stopped
  expect(vi.getTimerCount()).toBe(0);
});

test("a failed fast pass is skipped: it records nothing and says nothing", async () => {
  vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const id = opened(1, null);
  const exec: PublishExec = async () => { throw new Error("gh went away"); };
  const lines: string[] = [];
  const leave = joinServiceBeats(member(exec, () => true, lines));
  try {
    await vi.advanceTimersByTimeAsync(FAST_CI_EVERY_MS * 2);
  } finally { await leave(); }
  expect(store.handle.prepare("SELECT last_check_state, last_check_at FROM publication WHERE id = ?").get(id)).toEqual({ last_check_state: null, last_check_at: null });
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM notification WHERE kind = 'ci-failing'").get()!["n"]).toBe(0);
  expect(lines).toEqual([]);
});
