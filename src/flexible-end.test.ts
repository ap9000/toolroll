/**
 * Threads for everyday use, slice S5 (flexible-session.ts closeFlexibleThread, flexible-turns.ts's barrier): Stop ends
 * the agent's turn and keeps the thread open; End is final (D4). Ending records the end and, in the same transaction,
 * withdraws every turn waiting to start, interrupts the running one in Toolroll's words and requires each live launch to
 * stop; admission and begin both refuse an ended thread whoever asks; a stop not verified yet is said truthfully; and the
 * upkeep tidies an ended thread's copy after a week. Stand-in launches led by pids that aren't running; no agent.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, flexibleTurn } from "./flexible-turns.js";
import { closeFlexibleThread, FLEXIBLE_ENDED_KEEP_MS, FLEXIBLE_ENDED_WORDS, FLEXIBLE_STOPPED_WORDS, flexibleThreadLiveOf, openFlexibleSessions, removeFlexibleThreadCopy,
  stopFlexibleThreadsEverywhere, tidyEndedFlexibleThreads, type FlexibleSessions } from "./flexible-session.js";
import { hashPassword } from "./scope.js";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";
import { standInSignIn } from "../test/flexible-sign-in-kit.js";
import { fakePid } from "../test/fake-pid.js";

vi.mock("./flexible-available.js", async original => ({ ...await original<typeof import("./flexible-available.js")>(), flexibleAvailable: () => true }));

const NOW = new Date("2026-11-18T10:00:00.000Z");
const T1 = "1".padStart(32, "0"), L1 = "a1".padStart(32, "0");
let world: ThreadWorld, sessions: FlexibleSessions, digest: string, keys = 0;
const gen = (name: string) => world.store.accountOf(name)!.generation;
const pat = () => ({ name: "pat", generation: gen("pat") });
const admit = (holder = sessions.holder) => admitFlexibleTurn(world.store, { thread: T1, starter: pat(), digest, level: "full", freshProof: false, provider: "claude", model: "claude-sonnet-4-5",
  billing: "subscription", requestKey: `m-${++keys}`, holder, clock: () => NOW });
const status = (turn: string) => flexibleTurn(world.store, turn)!.status;
const detail = (turn: string) => world.store.handle.prepare("SELECT end_detail FROM thread_turn WHERE id = ?").get(turn)?.["end_detail"];
const close = (act: "stop" | "end", by = pat(), host: FlexibleSessions | null = sessions) => closeFlexibleThread(world.store, host, { thread: T1, by, act, clock: () => NOW });

beforeEach(() => {
  world = threadWorld();
  const store = world.store;
  store.saveApprover("alex", hashPassword("alex-password-1"), NOW);
  store.saveApprover("pat", hashPassword("pat-password-22"), NOW);
  expect(store.setAccountProjects("pat", [world.project], "alex", NOW)).toEqual({ ok: true });
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: gen("alex"), starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  digest = flexibleDigestOf(terms);
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  const folder = join(world.state, "threads", T1);
  mkdirSync(join(folder, "repo"), { recursive: true });
  store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
    .run(T1, world.project, world.second, `refs/toolroll/threads/${T1}/base`, folder, NOW.toISOString());
  store.handle.prepare("INSERT INTO flexible_thread_meta (thread, title) VALUES (?, 'Fix the parser')").run(T1);
  const opened = openFlexibleSessions(store);
  if (!opened.ok) throw new Error(opened.message);
  sessions = opened.sessions;
  standInSignIn(store, world.state, "pat");
});
afterEach(() => {
  sessions.catalog.close();
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

/** A running turn with its agent's launch live, held by this host. */
function working(): string {
  const made = admit();
  if (!made.ok) throw new Error(made.message);
  expect(beginFlexibleTurn(world.store, { turn: made.turn, holder: sessions.holder, clock: () => NOW })).toMatchObject({ ok: true });
  world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, 't1', 'live', ?)`).run(L1, T1, made.turn, "f".repeat(32), sessions.holder, "9".repeat(32), fakePid(1), NOW.toISOString());
  return made.turn;
}

describe("End is final", () => {
  test("ending records the end and, in one transaction, interrupts the running turn and requires its agent to stop; nothing new starts", async () => {
    const turn = working();
    const done = await close("end");
    // The stand-in launch's network isn't this test process's to close: custody can't verify the exit, so it is said
    // to be pending, never claimed.
    expect(done).toEqual({ ok: true, already: false, stopPending: true });
    expect(status(turn)).toBe("interrupted");
    expect(detail(turn)).toBe(FLEXIBLE_ENDED_WORDS);
    expect(world.store.handle.prepare("SELECT ended_by, end_words FROM flexible_thread_meta WHERE thread = ?").get(T1)).toMatchObject({ ended_by: "pat", end_words: FLEXIBLE_ENDED_WORDS });
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_stop_request WHERE launch = ? AND settled_at IS NULL").get(L1)?.["n"]).toBe(1);
    const read = flexibleThreadLiveOf(world.store, sessions, { thread: T1, viewer: { name: "pat" }, file: "main", cursor: null });
    expect(read.ok && read.facts.ended).toEqual({ words: FLEXIBLE_ENDED_WORDS, stopPending: true });
    expect(admit()).toMatchObject({ ok: false, reason: "thread-ended" });
    // Ending again is the same end.
    expect(await close("end")).toMatchObject({ ok: true, already: true });
  });

  test("a turn admitted before the end never begins: the barrier is read at begin too", async () => {
    const made = admit();
    if (!made.ok) throw new Error(made.message);
    // The end recorded behind admission's back (as a racing End would leave it): begin refuses and withdraws it.
    world.store.handle.prepare("UPDATE flexible_thread_meta SET ended_at = ?, ended_by = 'pat', end_words = ? WHERE thread = ?").run(NOW.toISOString(), FLEXIBLE_ENDED_WORDS, T1);
    expect(beginFlexibleTurn(world.store, { turn: made.turn, holder: sessions.holder, clock: () => NOW })).toMatchObject({ ok: false, reason: "thread-ended" });
    expect(status(made.turn)).toBe("withdrawn");
  });

  test("End withdraws a turn still waiting to start, atomically with the end", async () => {
    const made = admit();
    if (!made.ok) throw new Error(made.message);
    expect(await close("end")).toMatchObject({ ok: true, already: false });
    expect(status(made.turn)).toBe("withdrawn");
  });

  test("only the thread's owner, at their account's current generation", async () => {
    expect(await close("end", { name: "alex", generation: gen("alex") })).toMatchObject({ ok: false, reason: "thread-unknown" });
    expect(await close("end", { name: "pat", generation: gen("pat") - 1 })).toMatchObject({ ok: false, reason: "stale-generation" });
    expect(world.store.handle.prepare("SELECT ended_at FROM flexible_thread_meta WHERE thread = ?").get(T1)?.["ended_at"]).toBeNull();
  });
});

describe("Stop keeps the thread open", () => {
  test("its turn is interrupted in Toolroll's words and its agent required to stop; the next reply may start", async () => {
    const turn = working();
    expect(await close("stop")).toMatchObject({ ok: true, stopPending: true });
    expect(status(turn)).toBe("interrupted");
    expect(detail(turn)).toBe(FLEXIBLE_STOPPED_WORDS);
    expect(world.store.handle.prepare("SELECT ended_at FROM flexible_thread_meta WHERE thread = ?").get(T1)?.["ended_at"]).toBeNull();
    // The thread still admits its owner's next turn once the stop is verified (custody, as a crashed holder's is).
    world.store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ? WHERE id = ?").run(NOW.toISOString(), L1);
    expect(admit()).toMatchObject({ ok: true });
  });
});

describe("the tidy, a week after the end", () => {
  test("a thread ended more than a week ago has its copy removed; a newer end is kept", async () => {
    expect(await close("end")).toMatchObject({ ok: true });
    expect(await tidyEndedFlexibleThreads(world.store, { now: new Date(NOW.getTime() + FLEXIBLE_ENDED_KEEP_MS - 60_000) })).toEqual({ tidied: 0, left: 0 });
    expect(existsSync(join(world.state, "threads", T1))).toBe(true);
    const later = new Date(NOW.getTime() + FLEXIBLE_ENDED_KEEP_MS + 60_000);
    expect(await tidyEndedFlexibleThreads(world.store, { now: later })).toEqual({ tidied: 1, left: 0 });
    expect(world.store.handle.prepare("SELECT state FROM flexible_thread WHERE id = ?").get(T1)?.["state"]).toBe("removed");
    expect(world.store.handle.prepare("SELECT tidied_at FROM flexible_thread_meta WHERE thread = ?").get(T1)?.["tidied_at"]).toBe(later.toISOString());
    // Once tidied, nothing more to do.
    expect(await tidyEndedFlexibleThreads(world.store, { now: later })).toEqual({ tidied: 0, left: 0 });
  });

  test("an ended thread whose agent may still run is left for the next pass", async () => {
    working();
    expect(await close("end")).toMatchObject({ ok: true, stopPending: true });
    expect(await tidyEndedFlexibleThreads(world.store, { now: new Date(NOW.getTime() + FLEXIBLE_ENDED_KEEP_MS + 60_000) })).toEqual({ tidied: 0, left: 1 });
    expect(world.store.handle.prepare("SELECT state FROM flexible_thread WHERE id = ?").get(T1)?.["state"]).toBe("ready");
  });
});

describe("the command line's End and removal (Codex review of the build, round 1, findings 3 and 4)", () => {
  test("the caller's proof is asked again inside the write: an install that changed meanwhile ends nothing and removes nothing", async () => {
    expect(await closeFlexibleThread(world.store, null, { thread: T1, by: pat(), act: "end", clock: () => NOW, prove: () => false }))
      .toMatchObject({ ok: false, reason: "proof-changed" });
    expect(world.store.handle.prepare("SELECT ended_at FROM flexible_thread_meta WHERE thread = ?").get(T1)?.["ended_at"]).toBeNull();
    expect(await removeFlexibleThreadCopy(world.store, { thread: T1, by: "pat", now: NOW, prove: () => false })).toMatchObject({ ok: false });
    expect(world.store.handle.prepare("SELECT state FROM flexible_thread WHERE id = ?").get(T1)?.["state"]).toBe("ready");
    expect(existsSync(join(world.state, "threads", T1))).toBe(true);
  });

  test("stopping one thread's agent from the command line touches only that thread's own launches", async () => {
    const T2 = "2".padStart(32, "0"), L2 = "a2".padStart(32, "0");
    const folder = join(world.state, "threads", T2);
    mkdirSync(join(folder, "repo"), { recursive: true });
    world.store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
      .run(T2, world.project, world.second, `refs/toolroll/threads/${T2}/base`, folder, NOW.toISOString());
    working();
    world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
      VALUES (?, ?, NULL, 'claude', 'full', ?, ?, 'here', ?, ?, 't1', 'live', ?)`).run(L2, T2, "f".repeat(32), sessions.holder, "9".repeat(32), fakePid(2), NOW.toISOString());
    const report = await stopFlexibleThreadsEverywhere(world.store, { reason: "its owner ended the thread", thread: T1, clock: () => NOW });
    expect([...report.stopped, ...report.survivors].map(one => one.thread)).toEqual([T1]);
    expect(world.store.handle.prepare("SELECT state FROM flexible_thread_launch WHERE id = ?").get(L2)?.["state"]).toBe("live");
    expect(world.store.handle.prepare("SELECT state FROM flexible_thread_launch WHERE id = ?").get(L1)?.["state"]).not.toBe("live");
  });
});
