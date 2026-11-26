import { afterEach, describe, expect, test, vi } from "vitest";
import { scheduleLimitsLoop } from "./codex-limits.js";
import { agentWorkActive, notePlanLimitsViewed, PLAN_LIMITS_VIEW_WINDOW_MS } from "./plan-limits-demand.js";
import type { LimitReading } from "./provider-limits.js";
import { openStore, type Store } from "./store.js";
import { fakePid } from "../test/fake-pid.js";

// Everyday 9, B3: reading Claude's plan limits is a real model turn (`claude -p . --model haiku`). An idle Toolroll asks
// no provider anything; while work runs, or for ten minutes after a person opens Spend, usage still refreshes.

const HOUR = 3_600_000;
const START = Date.parse("2026-11-25T09:00:00.000Z");

function harness(store: Store, alive: (pid: number, start: string) => boolean = () => false) {
  const calls = { claude: 0, codex: 0, gemini: 0, signIn: 0 };
  const reading = (provider: "claude" | "codex"): LimitReading => ({ provider, plan: null, windows: [{ window: "five_hour", usedPercent: 10, windowMinutes: 300, resetsAt: new Date(Date.now() + 5 * HOUR).toISOString(), reached: false }] });
  const stop = scheduleLimitsLoop(store, {
    signedIn: async () => { calls.signIn += 1; return true; },
    readCodex: async () => { calls.codex += 1; return reading("codex"); },
    readers: {
      claude: async () => { calls.claude += 1; return reading("claude"); },
      codex: async () => { calls.codex += 1; return reading("codex"); },
      gemini: async now => { calls.gemini += 1; return { connected: false, provider: "antigravity", topModel: null, modelCount: 0, observedAt: now.toISOString(), note: null }; },
    },
    clock: () => new Date(),
    alive,
  });
  return { calls, stop, total: () => calls.claude + calls.codex + calls.gemini + calls.signIn };
}

/** A build an agent is running: its run, held by its worker's live lease (`liveFor` from now; negative: it lapsed). A
 * build on Claude keeps Claude's own read away (the same sign-in), so the reads below watch one on Codex. */
function building(store: Store, id: string, liveFor = 3 * HOUR, provider: "claude" | "codex" = "codex"): { end: () => void } {
  const at = new Date();
  store.createTask({ id, title: id }, at);
  const ref = store.refFor("built-in", id).id;
  store.handle.prepare("UPDATE task SET state = 'running', updated_at = ? WHERE id = ?").run(at.toISOString(), id);
  store.handle.prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, 1, 'r', ?, ?, ?)")
    .run(`l-${id}`, ref, at.toISOString(), new Date(at.getTime() + liveFor).toISOString(), at.toISOString());
  store.handle.prepare("INSERT INTO run (task_ref, lease_id, runner, branch, worktree, started_at, provider) VALUES (?, ?, 'r', ?, ?, ?, ?)").run(ref, `l-${id}`, `b-${id}`, `/pool/${id}`, at.toISOString(), provider);
  return { end: () => {
    const now = new Date().toISOString();
    store.handle.prepare("UPDATE claim SET released_at = ?, released_by = 'released' WHERE lease_id = ?").run(now, `l-${id}`);
    store.handle.prepare("UPDATE run SET outcome = 'built', finished_at = ? WHERE lease_id = ?").run(now, `l-${id}`);
    store.handle.prepare("UPDATE task SET state = 'done', updated_at = ? WHERE id = ?").run(now, id);
  } };
}

/** A thread turn that started now, with its launch live under `pid` and `start` (no launch when pid is null). */
function threadTurn(store: Store, mark: string, pid: number | null, start: string | null): void {
  const now = new Date().toISOString(), turn = mark.repeat(32), thread = "b".repeat(31) + mark;
  store.handle.prepare(`INSERT INTO thread_turn (id, thread, seq, repo, owner, owner_generation, terms_id, terms_digest, level, provider, model, billing,
    request_key, holder, admitted_at, utc_day, status, started_at) VALUES (?, ?, 1, '/p', 'alex', 1, 1, 'd', 'supervised', 'claude', 'sonnet',
    'subscription', ?, 'h', ?, ?, 'running', ?)`).run(turn, thread, `k${mark}`, now, now.slice(0, 10), now);
  if (pid === null) return;
  store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, ?, 'claude', 'supervised', ?, 'h', 'here', ?, ?, ?, 'live', ?)`).run("f".repeat(31) + mark, thread, turn, "0".repeat(32), "1".repeat(32), pid, start, now);
}
/** A Direct Chat turn running now under `pid` and `start`. */
function directChatTurn(store: Store, id: string, pid: number, start: string): void {
  store.handle.prepare("PRAGMA foreign_keys = OFF").run();
  store.handle.prepare(`INSERT INTO direct_chat_turn (id, thread_id, seq, user_prompt, log_path, stderr_path, pid, start_identity, status, created_at)
    VALUES (?, ?, 1, 'hi', '/l', '/e', ?, ?, 'running', ?)`).run(id, `dct-${id}`, pid, start, new Date().toISOString());
  store.handle.prepare("PRAGMA foreign_keys = ON").run();
}
/** A lead message the lead's queue claimed now, bound to a turn in `turn`'s state (none: no turn bound). */
function leadMessage(store: Store, message: number, turn: { state: string; deadline: Date } | null): void {
  const now = new Date().toISOString();
  store.handle.prepare("PRAGMA foreign_keys = OFF").run();
  let turnId: number | null = null;
  if (turn !== null) {
    turnId = Number(store.handle.prepare(`INSERT INTO mate_turn (approver, session, thread, credential_key, state, created_at, deadline_at, reserved_microusd)
      VALUES ('alex', 1, 1, 'k', ?, ?, ?, 0)`).run(turn.state, now, turn.deadline.toISOString()).lastInsertRowid);
  }
  store.handle.prepare(`INSERT INTO lead_queue (message, thread, approver, approver_generation, session, ceiling_digest, request_id, payload_hash, status, claimed_at, turn_id, created_at)
    VALUES (?, 1, ?, 1, 1, 'c', ?, 'p', 'running', ?, ?, ?)`).run(message, `person-${message}`, `r${message}`, now, turnId, now);
  store.handle.prepare("PRAGMA foreign_keys = ON").run();
}

let store: Store | null = null;
afterEach(() => { store?.close(); store = null; vi.useRealTimers(); });

describe("no idle model spend (everyday 9, B3)", () => {
  test("an idle engine asks no provider anything over simulated hours", async () => {
    vi.useFakeTimers({ now: START });
    store = openStore(":memory:");
    const loop = harness(store);
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(loop.total()).toBe(0);
    loop.stop();
  });

  test("while a build runs, usage refreshes (Claude's read no more than its half-hour freshness allows); it stops when the work ends", async () => {
    vi.useFakeTimers({ now: START });
    store = openStore(":memory:");
    const loop = harness(store);
    const job = building(store, "t1");
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(loop.calls.claude).toBeGreaterThanOrEqual(3);
    expect(loop.calls.claude).toBeLessThanOrEqual(5);
    job.end();
    const after = loop.total();
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(loop.total()).toBe(after);
    loop.stop();
  });

  test("only an agent actually running is work (everyday-9 C4): two hours of waiting work cost nothing", async () => {
    vi.useFakeTimers({ now: START });
    store = openStore(":memory:");
    const now = new Date().toISOString();
    // Just filed and waiting for a plan or a person; put away; a lead message and a thread turn waiting their turn.
    store.handle.prepare("INSERT INTO task (id, title, state, created_at, updated_at) VALUES ('q1', 'Add a halve function', 'queued', ?, ?)").run(now, now);
    store.handle.prepare("INSERT INTO task (id, title, state, created_at, updated_at) VALUES ('q2', 'Add a double function', 'queued', ?, ?)").run(now, now);
    store.handle.prepare(`INSERT INTO thread_turn (id, thread, seq, repo, owner, owner_generation, terms_id, terms_digest, level, provider, model, billing,
      request_key, holder, admitted_at, utc_day, status) VALUES (?, ?, 1, '/p', 'alex', 1, 1, 'd', 'supervised', 'claude', 'sonnet',
      'subscription', 'k', 'h', ?, ?, 'admitted')`).run("c".repeat(32), "d".repeat(32), now, now.slice(0, 10));
    store.handle.prepare("PRAGMA foreign_keys = OFF").run();
    store.handle.prepare(`INSERT INTO lead_queue (message, thread, approver, approver_generation, session, ceiling_digest, request_id, payload_hash, status, created_at)
      VALUES (1, 1, 'alex', 1, 1, 'c', 'r1', 'p', 'queued', ?)`).run(now);
    store.handle.prepare("PRAGMA foreign_keys = ON").run();
    // A "running" build whose worker went away: its run never ended, its lease lapsed.
    building(store, "stale", -60_000);
    const loop = harness(store);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(loop.total()).toBe(0);
    // An agent starts building: usage refreshes at once.
    building(store, "live");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(loop.calls.claude).toBe(1);
    loop.stop();
  });

  test("a queued task parked for days is not work; a running thread turn whose agent is running is", async () => {
    vi.useFakeTimers({ now: START });
    store = openStore(":memory:");
    const old = new Date(START - 3 * 24 * HOUR).toISOString();
    store.handle.prepare("INSERT INTO task (id, title, state, created_at, updated_at) VALUES ('t2', 'Parked', 'queued', ?, ?)").run(old, old);
    const agent = fakePid(1);
    const loop = harness(store, (pid, start) => pid === agent && start === "s4242");
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(loop.total()).toBe(0);
    threadTurn(store, "a", agent, "s4242");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(loop.calls.claude).toBe(1);
    loop.stop();
  });

  test("a recent running row nothing holds is not work (review round 1): a crashed thread agent or Direct Chat, a lead message with no running turn", async () => {
    vi.useFakeTimers({ now: START });
    store = openStore(":memory:");
    const live = new Set<string>();
    const loop = harness(store, (pid, start) => live.has(`${pid}:${start}`));
    // Each path's stale rows: its process is gone (or another process now has its pid), or nothing runs its turn.
    const [thread, chat, later] = [fakePid(2), fakePid(3), fakePid(4)];
    threadTurn(store, "a", thread, "s501");
    threadTurn(store, "c", null, null);
    directChatTurn(store, "dc-1", chat, "s502");
    leadMessage(store, 1, null);
    leadMessage(store, 2, { state: "running", deadline: new Date(START - 60_000) });
    leadMessage(store, 3, { state: "answered", deadline: new Date(START + HOUR) });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(loop.total()).toBe(0);
    // Actual execution on each path reads usage.
    for (const [index, start] of [() => { live.add(`${chat}:s502`); }, () => { threadTurn(store!, "e", later, "s503"); live.add(`${later}:s503`); },
      () => { leadMessage(store!, 4, { state: "running", deadline: new Date(Date.now() + HOUR) }); }].entries()) {
      live.clear();
      store.handle.prepare("DELETE FROM provider_limit").run();
      const before = loop.calls.claude;
      start();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(loop.calls.claude, `path ${index}`).toBeGreaterThan(before);
      // Done (its process gone, its lead turn answered): quiet again.
      live.clear();
      store.handle.prepare("UPDATE lead_queue SET status = 'answered' WHERE message = 4").run();
    }
    loop.stop();
  });

  test("every eligible turn is asked about (review round 2): eight stale rows never hide the ninth, which runs", () => {
    store = openStore(":memory:");
    const now = new Date();
    for (let i = 1; i <= 9; i++) directChatTurn(store, `dc-${i}`, fakePid(10 + i), `s${600 + i}`);
    expect(agentWorkActive(store, now, (pid, start) => pid === fakePid(19) && start === "s609")).toBe(true);
    expect(agentWorkActive(store, now, () => false)).toBe(false);
    store.close();
    store = openStore(":memory:");
    for (let i = 1; i <= 9; i++) threadTurn(store, String(i), fakePid(20 + i), `s${700 + i}`);
    expect(agentWorkActive(store, now, (pid, start) => pid === fakePid(29) && start === "s709")).toBe(true);
    expect(agentWorkActive(store, now, () => false)).toBe(false);
  });

  test("opening Spend reads at once and keeps limits fresh for ten minutes, then goes quiet again", async () => {
    vi.useFakeTimers({ now: START });
    store = openStore(":memory:");
    const loop = harness(store);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(loop.total()).toBe(0);
    notePlanLimitsViewed(store, new Date());
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.calls.claude).toBe(1);
    // Paging through Spend asks once, not per page.
    notePlanLimitsViewed(store, new Date());
    notePlanLimitsViewed(store, new Date());
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.calls.claude).toBe(1);
    await vi.advanceTimersByTimeAsync(PLAN_LIMITS_VIEW_WINDOW_MS);
    const quiet = loop.total();
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(loop.total()).toBe(quiet);
    loop.stop();
  });

  test("work that ends while Codex's limits are read starts no Claude probe afterwards (round 1, finding 5)", async () => {
    vi.useFakeTimers({ now: START });
    store = openStore(":memory:");
    let release: (reading: LimitReading | null) => void = () => {};
    let claude = 0, codex = 0;
    const stop = scheduleLimitsLoop(store, {
      signedIn: async () => true,
      readCodex: () => { codex += 1; return new Promise(resolve => { release = resolve; }); },
      readers: { claude: async () => { claude += 1; return null; }, gemini: async now => ({ connected: false, provider: "antigravity", topModel: null, modelCount: 0, observedAt: now.toISOString(), note: null }) },
      clock: () => new Date(),
    });
    const job = building(store, "t3", 3 * HOUR, "claude");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(codex).toBe(1);
    // The work ends while Codex's read is still out; then the read comes back.
    job.end();
    release(null);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(claude).toBe(0);
    expect(codex).toBe(1);
    stop();
  });
});
