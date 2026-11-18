/**
 * Threads for everyday use, slice S1 (flexible-authority-end.ts and its callers): every road that ends the authority a
 * person's thread runs on ends their running turn with Toolroll's words, withdraws their waiting ones, and leaves a
 * durable requirement that each agent of theirs stop, which a console acts on (whichever process wrote it) until the
 * exit is verified. A plain replacement of a sign-in ends nothing. Stand-in sign-ins and launches led by pids that
 * aren't running; no agent process, no model.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn, beginFlexibleTurn, flexibleTurn } from "./flexible-turns.js";
import { attachFlexibleAgent, FLEXIBLE_AUTHORITY_MOVED_WORDS, openFlexibleSessions, settleFlexibleStops, startFlexibleThreadSession, type FlexibleSessions } from "./flexible-session.js";
import { THREAD_AUTHORITY_WORDS } from "./flexible-authority-end.js";
import { stopFlexibleThreadAgent } from "./flexible-thread.js";
import { onRelayCancel, type RelayCancel } from "./flexible-relay-cancel.js";
import { flexibleSignInStatus, removeFlexibleSignIn, signInEpochOf } from "./flexible-sign-in.js";
import { hashPassword } from "./scope.js";
import { openStore, resetAccountPassword, type Store } from "./store.js";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";
import { standInSignIn } from "../test/flexible-sign-in-kit.js";
import { fakePid } from "../test/fake-pid.js";

vi.mock("./flexible-available.js", async original => ({ ...await original<typeof import("./flexible-available.js")>(), flexibleAvailable: () => true }));

const NOW = new Date("2026-11-18T10:00:00.000Z");
const tid = (k: number) => k.toString(16).padStart(32, "0");
const T1 = tid(1), T2 = tid(2), TB = tid(3), L1 = tid(0xa1), LB = tid(0xb1);
let world: ThreadWorld, sessions: FlexibleSessions, digest: string;
let keys = 0;
const gen = (store: Store, name: string) => store.accountOf(name)!.generation;

function thread(id: string, by: string): void {
  const folder = join(world.state, "threads", id);
  mkdirSync(folder, { recursive: true });
  world.store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')`)
    .run(id, world.project, world.second, `refs/toolroll/threads/${id}/base`, folder, by, NOW.toISOString());
}
function admitted(id: string, by: string, holder = sessions.holder): string {
  const made = admitFlexibleTurn(world.store, { thread: id, starter: { name: by, generation: gen(world.store, by) }, digest, level: "full", freshProof: false, provider: "claude",
    model: "claude-sonnet-4-5", billing: "subscription", requestKey: `m-${++keys}`, holder, clock: () => NOW });
  if (!made.ok) throw new Error(made.message);
  return made.turn;
}
function running(id: string, by: string, holder = sessions.holder): string {
  const turn = admitted(id, by, holder);
  const begun = beginFlexibleTurn(world.store, { turn, holder, clock: () => NOW });
  if (!begun.ok) throw new Error(begun.message);
  return turn;
}
function launch(id: string, thread: string, turn: string, holder = sessions.holder, offset = 1): void {
  world.store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, turn, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
    VALUES (?, ?, ?, 'claude', 'full', ?, ?, 'here', ?, ?, 't1', 'live', ?)`).run(id, thread, turn, "f".repeat(32), holder, "9".repeat(32), fakePid(offset), NOW.toISOString());
}
const stops = (store: Store = world.store) => store.handle.prepare("SELECT launch, thread, settled_at FROM flexible_stop_request ORDER BY launch").all().map(row => ({ ...row }));
const launchState = (id: string, store: Store = world.store) => store.handle.prepare("SELECT state FROM flexible_thread_launch WHERE id = ?").get(id)?.["state"];
/**
 * The console's tick acts on the requirement: the agent's processes are stopped (a stand-in pid: proved gone at once),
 * but a stand-in launch's network isn't this test process's to close, so custody leaves it `unresolved` (never `live`)
 * and the requirement stays open. The proof a real console makes when it closes its own handles is then made the way a
 * crashed holder's is (holderGone), and the next tick settles the requirement from the record.
 */
async function tickStops(launch: string): Promise<void> {
  const first = await settleFlexibleStops(world.store, sessions);
  expect(first).toMatchObject({ ok: true, stopped: 0 });
  expect(first.pending).toBeGreaterThan(0);
  expect(launchState(launch)).toBe("unresolved");
  expect(stops().find(one => one["launch"] === launch)?.["settled_at"]).toBeNull();
  expect(await stopFlexibleThreadAgent(world.store, { id: String(world.store.handle.prepare("SELECT thread FROM flexible_thread_launch WHERE id = ?").get(launch)?.["thread"]), reason: "test: its network closed", holderGone: true }))
    .toMatchObject({ ok: true });
  await settleFlexibleStops(world.store, sessions);
  expect(launchState(launch)).toBe("exited");
  expect(stops().find(one => one["launch"] === launch)?.["settled_at"]).toEqual(expect.any(String));
}

beforeEach(() => {
  world = threadWorld();
  const store = world.store;
  store.saveApprover("alex", hashPassword("alex-password-1"), NOW);
  store.saveApprover("pat", hashPassword("pat-password-22"), NOW);
  store.saveApprover("bob", hashPassword("bob-password-333"), NOW);
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: gen(store, "alex"), starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { liveThreads: 5, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  digest = flexibleDigestOf(terms);
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  const opened = openFlexibleSessions(store);
  if (!opened.ok) throw new Error(opened.message);
  sessions = opened.sessions;
  thread(T1, "pat");
  thread(T2, "pat");
  thread(TB, "bob");
});
afterEach(async () => {
  for (const one of sessions.threads.values()) await one.relay?.close();
  sessions.catalog.close();
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

/** pat's sign-in, a running turn and its live agent on T1, a turn waiting to start on T2; bob's own running thread. */
function patWorking() {
  standInSignIn(world.store, world.state, "pat");
  standInSignIn(world.store, world.state, "bob");
  const turn = running(T1, "pat");
  launch(L1, T1, turn);
  const waiting = admitted(T2, "pat");
  const bobs = running(TB, "bob");
  launch(LB, TB, bobs, sessions.holder, 2);
  return { turn, waiting, bobs };
}
function expectEnded(made: ReturnType<typeof patWorking>, words: string, epochBefore: number): void {
  expect(flexibleTurn(world.store, made.turn)).toMatchObject({ status: "interrupted" });
  expect(world.store.handle.prepare("SELECT end_detail FROM thread_turn WHERE id = ?").get(made.turn)?.["end_detail"]).toBe(words);
  expect(flexibleTurn(world.store, made.waiting)!.status).toBe("withdrawn");
  expect(flexibleSignInStatus(world.store, "pat")).toEqual({ state: "none" });
  expect(signInEpochOf(world.store, "pat")).toBeGreaterThan(epochBefore);
  expect(stops()).toEqual([{ launch: L1, thread: T1, settled_at: null }]);
  // Nobody else's thread is touched.
  expect(flexibleTurn(world.store, made.bobs)!.status).toBe("running");
  expect(flexibleSignInStatus(world.store, "bob").state).toBe("active");
}

describe("every road that ends a person's authority ends their threads' turns, in its own transaction", () => {
  const roads: [string, (store: Store) => void][] = [
    ["a password change", store => { store.saveApprover("pat", hashPassword("pat-password-new"), NOW); }],
    ["a password reset", store => { expect(resetAccountPassword(store, "pat", hashPassword("pat-password-reset"), gen(store, "pat"), false, NOW)).toMatchObject({ ok: true }); }],
    ["an access change", store => { expect(store.setAccountProjects("pat", [world.project], "alex", NOW)).toEqual({ ok: true }); }],
    ["a revocation", store => { expect(store.revokeAccount("pat", "alex", NOW)).toMatchObject({ ok: true }); }],
  ];
  test.each(roads)("%s", (_name, road) => {
    const made = patWorking();
    const before = signInEpochOf(world.store, "pat");
    road(world.store);
    expectEnded(made, THREAD_AUTHORITY_WORDS["account-changed"], before);
  });

  test("removing a sign-in: your own, and an operator removing someone's, each in its own words", () => {
    const made = patWorking();
    const before = signInEpochOf(world.store, "pat");
    expect(removeFlexibleSignIn(world.store, { person: "pat", by: "pat", now: NOW })).toMatchObject({ removed: true, ended: { interrupted: 1, withdrawn: 1, threads: [T1] } });
    expectEnded(made, THREAD_AUTHORITY_WORDS.removed, before);
    const bobs = flexibleTurn(world.store, made.bobs)!;
    removeFlexibleSignIn(world.store, { person: "bob", by: "alex", now: NOW });
    expect(world.store.handle.prepare("SELECT end_detail FROM thread_turn WHERE id = ?").get(bobs.id)?.["end_detail"]).toBe(THREAD_AUTHORITY_WORDS["removed-by-operator"]);
  });

  test("a plain replacement of a sign-in ends nothing", () => {
    const made = patWorking();
    const before = signInEpochOf(world.store, "pat");
    standInSignIn(world.store, world.state, "pat");
    expect(flexibleTurn(world.store, made.turn)!.status).toBe("running");
    expect(flexibleTurn(world.store, made.waiting)!.status).toBe("admitted");
    expect(signInEpochOf(world.store, "pat")).toBe(before);
    expect(stops()).toEqual([]);
  });

  test("this process's relays hear it at once; that is the fast path, not the record another process reads", () => {
    const heard: RelayCancel[] = [];
    const stop = onRelayCancel(cancel => { heard.push(cancel); }, () => {});
    try {
      const made = patWorking();
      removeFlexibleSignIn(world.store, { person: "pat", by: "pat", now: NOW });
      expect(heard).toEqual(expect.arrayContaining([{ person: "pat" }, { turn: made.turn }]));
    } finally { stop(); }
  });
});

describe("the console acts on the record, whichever process wrote it", () => {
  test("a removal written by another process (another handle on the same file): this console's tick stops its agent and settles the requirement", async () => {
    const made = patWorking();
    const other = openStore(world.databaseFile);
    try {
      // The other handle's write is all there is: the console below reads the record, not any in-process cut.
      removeFlexibleSignIn(other, { person: "pat", by: "pat", now: NOW });
      expect(stops(other)).toEqual([{ launch: L1, thread: T1, settled_at: null }]);
      await tickStops(L1);
      // bob's agent wasn't asked to stop.
      expect(launchState(LB)).toBe("live");
      expect(flexibleTurn(world.store, made.turn)!.status).toBe("interrupted");
    } finally { other.close(); }
  });

  test("interrupted, then the agent's result, then a replacement sign-in, then the tick: the agent still stops (even with the interrupt from another process)", async () => {
    standInSignIn(world.store, world.state, "pat");
    const turn = running(T1, "pat");
    launch(L1, T1, turn);
    expect(await startFlexibleThreadSession(world.store, sessions, { thread: T1 })).toMatchObject({ ok: true });
    const stdout = new PassThrough(), exit = new EventEmitter();
    expect(attachFlexibleAgent(world.store, sessions, { thread: T1, turn, launch: L1, stdout, stdin: new PassThrough(), exited: listener => { exit.once("exit", listener); }, clock: () => NOW })).toEqual({ ok: true });
    const other = openStore(world.databaseFile);
    try { removeFlexibleSignIn(other, { person: "pat", by: "pat", now: NOW }); } finally { other.close(); }
    // The agent prints its error and ends its turn: the record already says interrupted, so it stays so.
    stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "API Error: 403" })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    expect(flexibleTurn(world.store, turn)!.status).toBe("interrupted");
    expect(sessions.threads.get(T1)?.agent?.turn ?? null).toBeNull();
    // A fresh sign-in saved since revives nothing: the requirement stands until the exit is verified.
    standInSignIn(world.store, world.state, "pat");
    expect(stops()).toEqual([{ launch: L1, thread: T1, settled_at: null }]);
    await tickStops(L1);
  });

  test("the backstop: a running turn whose owner's epoch moved since it began (written by a writer that left no requirement) is interrupted and stopped", async () => {
    standInSignIn(world.store, world.state, "pat");
    const turn = running(T1, "pat");
    launch(L1, T1, turn);
    // Moved behind the record's back (an older build's removal): only the epoch, nothing else.
    world.store.handle.prepare("INSERT INTO flexible_sign_in_epoch (person, epoch) VALUES ('pat', 1) ON CONFLICT (person) DO UPDATE SET epoch = epoch + 1").run();
    standInSignIn(world.store, world.state, "pat");
    await tickStops(L1);
    expect(flexibleTurn(world.store, turn)!.status).toBe("interrupted");
    expect(world.store.handle.prepare("SELECT end_detail FROM thread_turn WHERE id = ?").get(turn)?.["end_detail"]).toBe(FLEXIBLE_AUTHORITY_MOVED_WORDS);
  });

  test("a turn begun under the epoch as it stands is left alone by the backstop", async () => {
    standInSignIn(world.store, world.state, "pat");
    const turn = running(T1, "pat");
    launch(L1, T1, turn);
    expect(await settleFlexibleStops(world.store, sessions)).toMatchObject({ stopped: 0, pending: 0 });
    expect(flexibleTurn(world.store, turn)!.status).toBe("running");
    expect(launchState(L1)).toBe("live");
  });
});
