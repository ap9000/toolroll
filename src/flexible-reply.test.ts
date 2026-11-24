/**
 * Threads for everyday use, slice S4 (flexible-session.ts continueFlexibleThread): Reply admits the thread's next turn
 * under one thread lock, with the person's own session re-read and their own sign-in's billing read inside the
 * admission's transaction, at the thread's level and agent, under the terms its last turn ran on. Only the owner, only
 * an open thread, never a second turn for the same key, never while a turn works. The launch itself is a stand-in
 * launcher that refuses (nothing runs): what is proved here is what gets admitted, and what never does.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, finishFlexibleTurn, interruptFlexibleThreadTurns } from "./flexible-turns.js";
import { continueFlexibleThread, FLEXIBLE_THREAD_ENDED, openFlexibleSessions, type FlexibleSessions } from "./flexible-session.js";
import type { FlexibleLauncher } from "./flexible-launcher.js";
import { hashPassword } from "./scope.js";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";
import { removeStandInSignIn, standInSignIn } from "../test/flexible-sign-in-kit.js";

vi.mock("./flexible-available.js", async original => ({ ...await original<typeof import("./flexible-available.js")>(), flexibleAvailable: () => true }));

const NOW = new Date("2026-11-18T10:00:00.000Z");
const T1 = "1".padStart(32, "0");
const KEY = "a".repeat(32);
let world: ThreadWorld, sessions: FlexibleSessions, digest: string;
const gen = (name: string) => world.store.accountOf(name)!.generation;
const pat = () => ({ name: "pat", generation: gen("pat") });
/** A launcher that never launches (its storage check refuses): the turn it was handed is withdrawn, nothing runs. */
const refusing: FlexibleLauncher = { prepare: async () => ({ ok: false, reason: "storage", message: "stand-in: nothing launches here" }), open: () => 0, close: async () => {} };
const turns = () => world.store.handle.prepare("SELECT seq, status, request_key, level, model, billing, owner FROM thread_turn WHERE thread = ? ORDER BY seq").all(T1).map(row => ({ ...row }));
const reply = (over: Partial<Parameters<typeof continueFlexibleThread>[2]> = {}) => continueFlexibleThread(world.store, sessions, {
  thread: T1, by: pat(), message: "Now add a test", key: KEY, freshProof: false, held: () => true, launcher: refusing, clock: () => NOW, ...over });

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
  mkdirSync(folder, { recursive: true });
  store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
    .run(T1, world.project, world.second, `refs/toolroll/threads/${T1}/base`, folder, NOW.toISOString());
  const opened = openFlexibleSessions(store);
  if (!opened.ok) throw new Error(opened.message);
  sessions = opened.sessions;
  standInSignIn(store, world.state, "pat");
  // The thread's first turn, finished.
  const first = admitFlexibleTurn(store, { thread: T1, starter: pat(), digest, level: "full", freshProof: false, provider: "claude", model: "claude-sonnet-4-5", billing: "subscription",
    requestKey: "start:first", holder: sessions.holder, clock: () => NOW });
  if (!first.ok) throw new Error(first.message);
  expect(beginFlexibleTurn(store, { turn: first.turn, holder: sessions.holder, clock: () => NOW })).toMatchObject({ ok: true });
  expect(finishFlexibleTurn(store, { turn: first.turn, holder: sessions.holder, outcome: "finished", usage: null, clock: () => NOW })).toMatchObject({ ok: true });
});
afterEach(() => {
  sessions.catalog.close();
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

describe("Reply admits the thread's next turn, and only that", () => {
  test("the owner's reply is admitted at the thread's level and agent, under its last turn's terms, billed to their own sign-in", async () => {
    // The stand-in launcher refuses, so the admitted turn is withdrawn: nothing ran, and nothing counts.
    expect(await reply()).toMatchObject({ ok: false, reason: "storage" });
    expect(turns()).toEqual([
      expect.objectContaining({ seq: 1, status: "finished" }),
      { seq: 2, status: "withdrawn", request_key: `reply:${KEY}`, level: "full", model: "claude-sonnet-4-5", billing: "subscription", owner: "pat" },
    ]);
  });

  test.each([
    ["someone else", () => reply({ by: { name: "alex", generation: gen("alex") } }), "thread-unknown"],
    ["a session that changed", () => reply({ held: () => false }), "session"],
    ["no sign-in of their own", () => { removeStandInSignIn(world.store, "pat"); return reply(); }, "no-sign-in"],
    ["an ended thread", () => {
      world.store.handle.prepare("INSERT INTO flexible_thread_meta (thread, ended_at, ended_by, end_words) VALUES (?, ?, 'pat', 'You ended this thread.')").run(T1, NOW.toISOString());
      return reply();
    }, "thread-ended"],
    ["terms that ended", () => { world.store.handle.prepare("UPDATE flexible_terms SET ended_at = ?, ended_by = 'alex', end_reason = 'off' WHERE ended_at IS NULL").run(NOW.toISOString()); return reply(); }, null],
    ["a malformed key", () => reply({ key: "not-a-key" }), "invalid-request"],
  ] as const)("refused for %s: nothing is admitted", async (_name, act, reason) => {
    const done = await act();
    expect(done.ok).toBe(false);
    if (reason !== null) expect(done).toMatchObject({ reason });
    expect(turns()).toHaveLength(1);
  });

  test("the words for an ended thread are Toolroll's own", async () => {
    world.store.handle.prepare("INSERT INTO flexible_thread_meta (thread, ended_at, ended_by, end_words) VALUES (?, ?, 'pat', 'You ended this thread.')").run(T1, NOW.toISOString());
    expect(await reply()).toEqual({ ok: false, reason: "thread-ended", message: FLEXIBLE_THREAD_ENDED });
  });

  test("never while a turn works: a second reply racing the first is refused, never a second turn", async () => {
    const working = admitFlexibleTurn(world.store, { thread: T1, starter: pat(), digest, level: "full", freshProof: false, provider: "claude", model: "claude-sonnet-4-5", billing: "subscription",
      requestKey: "reply:other", holder: sessions.holder, clock: () => NOW });
    expect(working.ok).toBe(true);
    expect(await reply()).toMatchObject({ ok: false, reason: "turn-in-progress" });
    expect(turns().map(row => row["request_key"])).toEqual(["start:first", "reply:other"]);
  });

  /** An earlier attempt of this reply's key: begun, launched or not (its start gate's ledger line), then ended. */
  const earlier = (outcome: "finished" | "unknown" | "interrupted", launched: boolean, detail: string): void => {
    const made = admitFlexibleTurn(world.store, { thread: T1, starter: pat(), digest, level: "full", freshProof: false, provider: "claude", model: "claude-sonnet-4-5", billing: "subscription",
      requestKey: `reply:${KEY}`, holder: sessions.holder, clock: () => NOW });
    if (!made.ok) throw new Error(made.message);
    expect(beginFlexibleTurn(world.store, { turn: made.turn, holder: sessions.holder, clock: () => NOW })).toMatchObject({ ok: true });
    if (launched) world.store.recordAction({ at: NOW.toISOString(), actor: "toolroll", repo: null, taskId: null, runId: null, source: "policy", action: "flexible agent launched", outcome: "launched",
      detail: `turn ${made.turn} · launch x` });
    if (outcome === "interrupted") expect(interruptFlexibleThreadTurns(world.store, { thread: T1, detail, clock: () => NOW })).toMatchObject({ ok: true, interrupted: 1 });
    else expect(finishFlexibleTurn(world.store, { turn: made.turn, holder: sessions.holder, outcome, usage: null, detail, clock: () => NOW })).toMatchObject({ ok: true });
  };

  test.each([
    ["finished", "That message already reached the agent in turn 2, and it finished. Nothing new was started."],
    ["unknown", "That message already reached the agent in turn 2, and its outcome is unknown (The agent stopped with an error.). Nothing new was started."],
    ["interrupted", "That message already reached the agent in turn 2, and it was stopped (The agent stopped with an error.). Nothing new was started."],
  ] as const)("delivered: the same key again after its agent started (%s) is refused with that turn's state, never a second turn", async (outcome, words) => {
    earlier(outcome, true, "The agent stopped with an error.");
    expect(await reply()).toEqual({ ok: false, reason: "already-sent", message: words });
    expect(turns()).toHaveLength(2);
  });

  test("failed before launch: the same key again after its turn ended with no agent ever started is sent again, as a new turn under its next key", async () => {
    earlier("unknown", false, "the agent didn't start: its sandbox couldn't be made");
    // Admitted afresh (the stand-in launcher then refuses, so this new attempt is withdrawn: it is the attempt that counts here).
    expect(await reply()).toMatchObject({ ok: false, reason: "storage" });
    expect(turns().map(row => [row["seq"], row["request_key"], row["status"]])).toEqual([
      [1, "start:first", "finished"], [2, `reply:${KEY}`, "unknown"], [3, `reply:${KEY}:again-1`, "withdrawn"]]);
    // And the attempt after that is the next key again: an attempt that ran nothing never holds the request.
    expect(await reply()).toMatchObject({ ok: false, reason: "storage" });
    expect(turns().at(-1)).toMatchObject({ seq: 4, request_key: `reply:${KEY}:again-1`, status: "withdrawn" });
  });

  test("two replies at once take the thread's lock in turn: one admission at a time", async () => {
    const both = await Promise.all([reply({ key: "b".repeat(32) }), reply({ key: "c".repeat(32) })]);
    expect(both.every(one => !one.ok)).toBe(true);
    // Each was admitted and withdrawn in turn (the stand-in launches nothing); neither overlapped the other.
    expect(turns().map(row => [row["request_key"], row["status"]])).toEqual([["start:first", "finished"], [`reply:${"b".repeat(32)}`, "withdrawn"], [`reply:${"c".repeat(32)}`, "withdrawn"]]);
  });
});
