/**
 * Flexible threads, slice F2e (the Flexible plan v2 §8 and Codex round 2's required changes 8 and 10): every turn is
 * admitted in one transaction against the thread's terms and every limit, with an id the thread start runs and the
 * relay charges; repeated requests never take a second turn, before or after a restart; unknown cost is never $0.
 *
 * The enabled behaviour is reachable only by replacing flexible-available.ts here (the build ships it false;
 * flexible-disabled.test.ts proves every entry point refuses then). The race runs in separate processes, each with its
 * own database handle, with the same replacement made by a module hook in the child.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, type Store } from "./store.js";
import { flexibleDigestOf, flexibleTermsJson, type FlexibleCaps, type FlexibleTerms } from "./flexible.js";
import {
  admitFlexibleTurn, beginFlexibleTurn, chargeFlexibleTurn, finishFlexibleTurn, flexibleInstallationCaps, flexibleTurn, interruptFlexibleTurnsOf, setFlexibleInstallationCaps,
  type FlexibleTurnRequest, type FlexibleUsage,
} from "./flexible-turns.js";
import { spendItems } from "./spend.js";

vi.mock("./flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));

const NOW = new Date("2026-11-14T10:00:00.000Z");
const LATER = new Date("2026-11-14T23:30:00.000Z");
const TOMORROW = new Date("2026-11-15T00:00:01.000Z");
const MIDNIGHT = "2026-11-15T00:00:00.000Z";
const DEFAULT_CAPS: FlexibleCaps = { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null };
let dir: string, file: string, REPO: string, OTHER: string, store: Store;
const digests: Record<string, string> = {};
let n = 0;

const tid = (k: number) => k.toString(16).padStart(32, "0");
const T1 = tid(1), T2 = tid(2), T3 = tid(3), T4 = tid(4);
const gen = (name: string) => store.accountOf(name)!.generation;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flexible-turns-")));
  file = join(dir, "orders.db");
  REPO = join(dir, "app");
  OTHER = join(dir, "other");
  store = openStore(file);
  store.saveApprover("alex", "hash-a", NOW); // an instance operator, signs the terms
  store.saveApprover("pat", "hash-p", NOW);
  expect(store.setAccountProjects("pat", [REPO, OTHER], "alex", NOW)).toEqual({ ok: true }); // an approver of both projects
  store.saveApprover("lee", "hash-l", NOW);
  expect(store.setAccountProjects("lee", [REPO], "alex", NOW)).toEqual({ ok: true });
  plant(REPO);
  thread(T1);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** Live terms for a project, signed by alex, as the ceremony would have written them. */
function plant(repo: string, caps: Partial<FlexibleCaps> = {}): string {
  store.handle.prepare("DELETE FROM flexible_terms WHERE repo = ?").run(repo);
  const terms: FlexibleTerms = { version: 1, repo, signer: "alex", signerGeneration: gen("alex"), starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { ...DEFAULT_CAPS, ...caps } };
  const digest = flexibleDigestOf(terms);
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(repo, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  digests[repo] = digest;
  return digest;
}
/** A ready thread, as the thread engine (F2a) records one. */
function thread(id: string, by = "pat", repo = REPO): void {
  store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')`)
    .run(id, repo, "a".repeat(40), `refs/toolroll/threads/${id}/base`, `/state/threads/${id}`, by, NOW.toISOString());
}
function admit(over: Partial<FlexibleTurnRequest> = {}) {
  const who = over.starter?.name ?? "pat";
  const threadRepo = String(store.handle.prepare("SELECT repo FROM flexible_thread WHERE id = ?").get(over.thread ?? T1)?.["repo"] ?? REPO);
  return admitFlexibleTurn(store, { thread: T1, starter: { name: who, generation: gen(who) }, digest: digests[threadRepo]!, level: "full", freshProof: false, provider: "claude",
    model: "claude-sonnet-4-5", billing: "subscription", requestKey: `m-${++n}`, holder: "h1", now: NOW, ...over });
}
function admitted(over: Partial<FlexibleTurnRequest> = {}): string {
  const made = admit(over);
  if (!made.ok) throw new Error(`${made.reason}: ${made.message}`);
  return made.turn;
}
/** A whole turn: admitted, started, finished. */
function turn(over: Partial<FlexibleTurnRequest> = {}, usage: FlexibleUsage | null = { tokensIn: 10, tokensOut: 5, costUsd: null }, outcome: "finished" | "unknown" = "finished"): string {
  const id = admitted(over);
  expect(beginFlexibleTurn(store, { turn: id, holder: over.holder ?? "h1", now: over.now ?? NOW })).toMatchObject({ ok: true });
  expect(finishFlexibleTurn(store, { turn: id, holder: over.holder ?? "h1", outcome, usage, now: over.now ?? NOW })).toMatchObject({ ok: true });
  return id;
}
const statusOf = (id: string) => flexibleTurn(store, id)!.status;
const ledger = () => store.handle.prepare("SELECT actor, action, outcome FROM action_ledger WHERE action LIKE 'flexible%' ORDER BY id").all().map(row => ({ ...row }));

describe("admission", () => {
  test("records an admitted turn with an id, the terms and level it was admitted under, and says so in the ledger", () => {
    const made = admit({ requestKey: "msg-1" });
    expect(made).toEqual({ ok: true, turn: expect.stringMatching(/^[0-9a-f]{32}$/), seq: 1, replayed: false });
    if (!made.ok) return;
    expect(flexibleTurn(store, made.turn)).toMatchObject({ thread: T1, seq: 1, repo: REPO, owner: "pat", ownerGeneration: gen("pat"), termsDigest: digests[REPO], level: "full",
      provider: "claude", billing: "subscription", requestKey: "msg-1", holder: "h1", status: "admitted", utcDay: "2026-11-14", costBasis: null });
    expect(ledger()).toEqual([{ actor: "pat", action: "flexible turn admitted", outcome: "admitted" }]);
  });

  test("a repeated request gets its waiting turn back, and once it started it is refused; one turn at a time per thread", () => {
    const first = admitted({ requestKey: "msg-1" });
    expect(admit({ requestKey: "msg-1" })).toEqual({ ok: true, turn: first, seq: 1, replayed: true });
    expect(admit({ requestKey: "msg-2" })).toMatchObject({ ok: false, reason: "turn-in-progress" });
    expect(beginFlexibleTurn(store, { turn: first, holder: "h1", now: NOW })).toMatchObject({ ok: true });
    expect(admit({ requestKey: "msg-1" })).toMatchObject({ ok: false, reason: "already-sent", message: "That message already started a turn. Nothing new was started." });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM thread_turn").get()!["n"]).toBe(1);
  });

  test("only the thread's owner, on a ready thread, under the live terms", () => {
    expect(admit({ starter: { name: "lee", generation: gen("lee") } })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(admit({ thread: T2 })).toMatchObject({ ok: false, reason: "thread-unknown" });
    expect(admit({ digest: "0".repeat(32) })).toMatchObject({ ok: false, reason: "terms-changed" });
    expect(admit({ starter: { name: "pat", generation: gen("pat") - 1 } })).toMatchObject({ ok: false, reason: "stale-generation" });
    expect(admit({ requestKey: "../x" })).toMatchObject({ ok: false, reason: "invalid-request" });
    store.handle.prepare("UPDATE flexible_thread SET state = 'removing' WHERE id = ?").run(T1);
    expect(admit()).toMatchObject({ ok: false, reason: "thread-not-ready" });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM thread_turn").get()!["n"]).toBe(0);
  });

  test("a different level waits while the thread's agent is still running at the old one", () => {
    turn({ level: "full" });
    store.handle.prepare("UPDATE flexible_thread SET live_pid = 4242, live_since = ? WHERE id = ?").run(NOW.toISOString(), T1);
    expect(admit({ level: "auto" })).toMatchObject({ ok: false, reason: "level-pending", message: expect.stringContaining("still running at Full access") });
    expect(admit({ level: "full" })).toMatchObject({ ok: true });
  });

  test("the defaults are far past one person's normal day: thirty turns across three threads all start", () => {
    thread(T2); thread(T3);
    for (let k = 0; k < 10; k++) for (const one of [T1, T2, T3]) turn({ thread: one });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM thread_turn WHERE status = 'finished'").get()!["n"]).toBe(30);
  });
});

describe("limits at each level", () => {
  test("threads working at once in a project: a turn waits until one finishes", () => {
    plant(REPO, { liveThreads: 2 });
    thread(T2); thread(T3);
    const a = admitted({ thread: T1 });
    admitted({ thread: T2 });
    expect(admit({ thread: T3 })).toMatchObject({ ok: false, reason: "cap-reached", cap: "project-threads", resetsAt: null,
      message: "This project already has 2 threads working, the most its Flexible terms allow. Try again when one finishes." });
    expect(beginFlexibleTurn(store, { turn: a, holder: "h1", now: NOW })).toMatchObject({ ok: true });
    expect(finishFlexibleTurn(store, { turn: a, holder: "h1", outcome: "finished", usage: null, now: NOW })).toMatchObject({ ok: true });
    expect(admit({ thread: T3 })).toMatchObject({ ok: true });
  });

  test("turns a day in a project, until midnight UTC", () => {
    plant(REPO, { turnsPerDayProject: 2 });
    turn(); turn();
    expect(admit({ now: LATER })).toMatchObject({ ok: false, reason: "cap-reached", cap: "project-turns", resetsAt: MIDNIGHT, message: "This project used its 2 agent turns for today. New turns can start after midnight UTC." });
    expect(admit({ now: TOMORROW })).toMatchObject({ ok: true });
  });

  test("a person's turns count across every project", () => {
    plant(REPO, { turnsPerDayPerson: 2 });
    plant(OTHER, { turnsPerDayPerson: 2 });
    thread(T2, "pat", OTHER);
    turn({ thread: T1 });
    turn({ thread: T2 });
    expect(admit({ thread: T1 })).toMatchObject({ ok: false, reason: "cap-reached", cap: "person-turns", resetsAt: MIDNIGHT });
    expect(admit({ thread: T2 })).toMatchObject({ ok: false, reason: "cap-reached", cap: "person-turns" });
    // Someone else in the same project still has their own day.
    thread(T3, "lee");
    expect(admit({ thread: T3, starter: { name: "lee", generation: gen("lee") } })).toMatchObject({ ok: true });
  });

  test("the installation's own limits across every project, set by an instance operator only", () => {
    expect(flexibleInstallationCaps(store)).toEqual({ liveThreads: null, turnsPerDay: null, measuredMicrousdPerDay: null });
    expect(setFlexibleInstallationCaps(store, { by: "pat", caps: { liveThreads: 1, turnsPerDay: null, measuredMicrousdPerDay: null }, now: NOW })).toMatchObject({ ok: false, reason: "not-an-operator" });
    expect(setFlexibleInstallationCaps(store, { by: "alex", caps: { liveThreads: 0, turnsPerDay: null, measuredMicrousdPerDay: null }, now: NOW })).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(setFlexibleInstallationCaps(store, { by: "alex", caps: { liveThreads: 1, turnsPerDay: 3, measuredMicrousdPerDay: null }, now: NOW })).toMatchObject({ ok: true });
    expect(ledger().at(-1)).toEqual({ actor: "alex", action: "flexible installation limits changed", outcome: "changed" });
    plant(OTHER);
    thread(T2, "pat", OTHER);
    const a = admitted({ thread: T1 });
    expect(admit({ thread: T2 })).toMatchObject({ ok: false, reason: "cap-reached", cap: "installation-threads", resetsAt: null });
    expect(beginFlexibleTurn(store, { turn: a, holder: "h1", now: NOW })).toMatchObject({ ok: true });
    expect(finishFlexibleTurn(store, { turn: a, holder: "h1", outcome: "finished", usage: null, now: NOW })).toMatchObject({ ok: true });
    turn({ thread: T2 }); turn({ thread: T1 });
    expect(admit({ thread: T2 })).toMatchObject({ ok: false, reason: "cap-reached", cap: "installation-turns", resetsAt: MIDNIGHT });
    expect(setFlexibleInstallationCaps(store, { by: "alex", caps: { liveThreads: null, turnsPerDay: null, measuredMicrousdPerDay: 1_000_000 }, now: NOW })).toMatchObject({ ok: true });
    turn({ thread: T2, billing: "api-key" }, { tokensIn: 1, tokensOut: 1, costUsd: 1.25 });
    expect(admit({ thread: T1 })).toMatchObject({ ok: false, reason: "cap-reached", cap: "installation-dollars", message: expect.stringContaining("The installation's measured spend today reached its $1.00 limit") });
  });

  test("a project's dollar limit is soft: a running turn may go past it, then no new turn starts", () => {
    plant(REPO, { measuredMicrousdPerDay: 1_000_000 });
    const running = admitted({ billing: "api-key" });
    expect(beginFlexibleTurn(store, { turn: running, holder: "h1", now: NOW })).toMatchObject({ ok: true });
    expect(chargeFlexibleTurn(store, { turn: running, usage: { tokensIn: 100, tokensOut: 100, costUsd: 0.75 } })).toEqual({ ok: true, costMicrousd: 750_000 });
    expect(chargeFlexibleTurn(store, { turn: running, usage: { tokensIn: 100, tokensOut: 100, costUsd: 0.75 } })).toEqual({ ok: true, costMicrousd: 750_000 });
    expect(finishFlexibleTurn(store, { turn: running, holder: "h1", outcome: "finished", usage: null, now: NOW })).toMatchObject({ ok: true, turn: { costMicrousd: 1_500_000, costBasis: "measured", relayCalls: 2 } });
    expect(admit()).toMatchObject({ ok: false, reason: "cap-reached", cap: "project-dollars", resetsAt: MIDNIGHT, message: "This project's measured spend today reached its $1.00 limit. New turns can start after midnight UTC." });
    expect(admit({ now: TOMORROW })).toMatchObject({ ok: true });
  });

  test("an active mode's daily starts count each turn, and a turn that never started gives its start back", () => {
    store.handle.prepare("INSERT INTO operating_mode (repo, name, terms_json, digest, signed_by, signed_at, absolute_expiry) VALUES (?, 'hands-off', ?, 'd', 'alex', ?, ?)")
      .run(REPO, JSON.stringify({ dailyRunCap: 1 }), NOW.toISOString(), TOMORROW.toISOString());
    const first = admitted({ requestKey: "msg-1" });
    expect(store.handle.prepare("SELECT reserved_starts FROM mode_rail WHERE repo = ?").get(REPO)!["reserved_starts"]).toBe(1);
    expect(interruptFlexibleTurnsOf(store, { holder: "h1", now: NOW })).toEqual({ ok: true, withdrawn: 1, interrupted: 0 });
    expect(statusOf(first)).toBe("withdrawn");
    expect(store.handle.prepare("SELECT reserved_starts FROM mode_rail WHERE repo = ?").get(REPO)!["reserved_starts"]).toBe(0);
    turn({ requestKey: "msg-1", holder: "h2" });
    expect(admit({ holder: "h2" })).toMatchObject({ ok: false, reason: "cap-reached", cap: "mode-runs", message: expect.stringContaining("This project's mode limits it") });
  });

  test("an active mode's measured budget counts thread turns' dollars, for its runs too", () => {
    store.handle.prepare("INSERT INTO operating_mode (repo, name, terms_json, digest, signed_by, signed_at, absolute_expiry) VALUES (?, 'hands-off', ?, 'd', 'alex', ?, ?)")
      .run(REPO, JSON.stringify({ dailyMeasuredCapMicrousd: 1_000_000 }), NOW.toISOString(), TOMORROW.toISOString());
    expect(store.reserveModeRail(REPO, 1, NOW)).toEqual({ ok: true });
    turn({ billing: "api-key" }, { tokensIn: 1, tokensOut: 1, costUsd: 1.5 });
    expect(store.reserveModeRail(REPO, 1, NOW)).toMatchObject({ ok: false, rail: "daily-dollars" });
    expect(admit()).toMatchObject({ ok: false, reason: "cap-reached", cap: "mode-dollars" });
  });

  test("a plan turn waits while the provider's plan window is used up; a keyed turn doesn't", () => {
    const resets = "2026-11-14T15:00:00.000Z";
    store.recordProviderLimits({ provider: "claude", plan: null, windows: [{ window: "five_hour", usedPercent: 100, windowMinutes: 300, resetsAt: resets, reached: true }] }, NOW);
    expect(admit()).toMatchObject({ ok: false, reason: "cap-reached", cap: "plan", resetsAt: resets, message: "Your Claude plan's usage limit is reached. New turns can start after it resets at 15:00 UTC on 2026-11-14." });
    expect(admit({ billing: "api-key" })).toMatchObject({ ok: true });
  });

  test("a keyed turn waits on a used-up monthly budget, counting thread turns", () => {
    store.setBudget({ scope: "project", key: REPO, limitMicrousd: 1_000_000, hardStop: true }, "alex", NOW);
    turn({ billing: "api-key" }, { tokensIn: 1, tokensOut: 1, costUsd: 2 });
    expect(admit({ billing: "api-key" })).toMatchObject({ ok: false, reason: "cap-reached", cap: "budget", message: expect.stringContaining("budget is used up for 2026-11") });
    expect(admit({ billing: "subscription" })).toMatchObject({ ok: true });
  });
});

describe("unknown cost", () => {
  test("a turn whose usage can't be read counts toward the turn limits, and a keyed one is never $0 against a dollar limit", () => {
    plant(REPO, { turnsPerDayProject: 3 });
    const blind = turn({ billing: "api-key" }, null, "unknown");
    expect(flexibleTurn(store, blind)).toMatchObject({ status: "unknown", costBasis: "unknown", costMicrousd: 0 });
    // No dollar limit: nothing to check, the next turn starts.
    turn();
    expect(spendItems(store.handle, "2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z").filter(one => one.kind === "flexible").map(one => [one.microusd, one.source]))
      .toEqual(expect.arrayContaining([[null, "unpriced"], [0, "subscription"]]));
    // With one, the day's spend can't be checked: nothing new starts until tomorrow.
    plant(REPO, { turnsPerDayProject: 3, measuredMicrousdPerDay: 50_000_000 });
    expect(admit()).toMatchObject({ ok: false, reason: "spend-unknown", cap: "project-dollars", resetsAt: MIDNIGHT, message: expect.stringContaining("can't be checked") });
    expect(admit({ now: TOMORROW })).toMatchObject({ ok: true });
  });

  test("tokens Toolroll can't price make the cost unknown; a plan turn with no usage is still $0", () => {
    plant(REPO, { measuredMicrousdPerDay: 50_000_000 });
    turn({ billing: "subscription" }, null, "unknown");
    turn(); // a plan's unreadable turn doesn't hold a dollar limit: it costs $0
    const keyed = turn({ billing: "api-key" }, { tokensIn: 1000, tokensOut: 1000, costUsd: null });
    expect(flexibleTurn(store, keyed)).toMatchObject({ costBasis: "unknown" });
    expect(admit()).toMatchObject({ ok: false, reason: "spend-unknown" });
  });

  test("an unpriceable relay call makes a finished turn's cost less certain, never more", () => {
    const id = turn({ billing: "api-key" }, { tokensIn: 1, tokensOut: 1, costUsd: 0.1 });
    expect(flexibleTurn(store, id)).toMatchObject({ costBasis: "measured", costMicrousd: 100_000 });
    expect(chargeFlexibleTurn(store, { turn: id, usage: { tokensIn: 5, tokensOut: 5, costUsd: 0.2 } })).toMatchObject({ ok: true });
    expect(flexibleTurn(store, id)).toMatchObject({ costBasis: "measured", costMicrousd: 300_000, relayCalls: 1 });
    expect(chargeFlexibleTurn(store, { turn: id, usage: { tokensIn: 5, tokensOut: 5, costUsd: null } })).toMatchObject({ ok: true });
    expect(flexibleTurn(store, id)).toMatchObject({ costBasis: "unknown" });
    expect(() => store.handle.prepare("UPDATE thread_turn SET cost_basis = 'measured' WHERE id = ?").run(id)).toThrow(/usage only grows/);
    expect(() => store.handle.prepare("UPDATE thread_turn SET cost_microusd = 0 WHERE id = ?").run(id)).toThrow(/usage only grows/);
  });
});

describe("the turn's life", () => {
  test("only the holder starts and finishes it; the relay charges only a turn that started, and its counts win over the provider's", () => {
    const id = admitted();
    expect(chargeFlexibleTurn(store, { turn: id, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 } })).toMatchObject({ ok: false, reason: "turn-not-running" });
    expect(beginFlexibleTurn(store, { turn: id, holder: "h2", now: NOW })).toMatchObject({ ok: false, reason: "held-elsewhere" });
    expect(beginFlexibleTurn(store, { turn: id, holder: "h1", now: NOW })).toMatchObject({ ok: true, turn: { status: "running" } });
    expect(beginFlexibleTurn(store, { turn: id, holder: "h1", now: NOW })).toMatchObject({ ok: false, reason: "turn-not-admitted" });
    expect(chargeFlexibleTurn(store, { turn: id, usage: { tokensIn: 7, tokensOut: 3, costUsd: null } })).toMatchObject({ ok: true, costMicrousd: 0 });
    expect(finishFlexibleTurn(store, { turn: id, holder: "h2", outcome: "finished", usage: null, now: NOW })).toMatchObject({ ok: false, reason: "held-elsewhere" });
    // The agent's own report says less than the relay counted: the relay's counts stand.
    expect(finishFlexibleTurn(store, { turn: id, holder: "h1", outcome: "finished", usage: { tokensIn: 1, tokensOut: 1, costUsd: null }, now: NOW }))
      .toMatchObject({ ok: true, turn: { status: "finished", tokensIn: 7, tokensOut: 3, costBasis: "estimated" } });
  });

  test("terms that lapse mid-day: the waiting turn is withdrawn at its start and counts for nothing; new turns are refused", () => {
    plant(REPO, { turnsPerDayProject: 2 });
    turn();
    const waiting = admitted();
    // The signer's account changed underneath (read as a lapse on every check, before anything ends the terms).
    store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'alex'").run();
    expect(beginFlexibleTurn(store, { turn: waiting, holder: "h1", now: NOW })).toMatchObject({ ok: false, reason: "terms-lapsed" });
    expect(statusOf(waiting)).toBe("withdrawn");
    expect(admit()).toMatchObject({ ok: false, reason: "terms-lapsed" });
    // The signer's password changed through the store: the lapse ends the terms durably.
    plant(REPO, { turnsPerDayProject: 2 });
    const next = admitted();
    store.saveApprover("alex", "hash-a2", NOW);
    expect(beginFlexibleTurn(store, { turn: next, holder: "h1", now: NOW })).toMatchObject({ ok: false, reason: "not-flexible" });
    expect(statusOf(next)).toBe("withdrawn");
    // Signed again: the withdrawn turn took no place in the day.
    plant(REPO, { turnsPerDayProject: 2 });
    expect(admit()).toMatchObject({ ok: true });
  });

  test("lowered terms withdraw a turn admitted under the old ones", () => {
    const waiting = admitted();
    plant(REPO, { liveThreads: 2 }); // new terms, a new digest
    expect(beginFlexibleTurn(store, { turn: waiting, holder: "h1", now: NOW })).toMatchObject({ ok: false, reason: "terms-changed" });
    expect(statusOf(waiting)).toBe("withdrawn");
  });

  test("restart: a turn that never started is withdrawn and the same request takes exactly one turn; a running one is interrupted and still counts", () => {
    plant(REPO, { turnsPerDayProject: 2 });
    thread(T2);
    const waiting = admitted({ thread: T1, requestKey: "msg-1" });
    const running = admitted({ thread: T2, requestKey: "msg-2", billing: "api-key" });
    expect(beginFlexibleTurn(store, { turn: running, holder: "h1", now: NOW })).toMatchObject({ ok: true });
    expect(interruptFlexibleTurnsOf(store, { holder: "h0", now: NOW })).toEqual({ ok: true, withdrawn: 0, interrupted: 0 }); // another process's turns are left alone
    expect(interruptFlexibleTurnsOf(store, { holder: "h1", now: NOW })).toEqual({ ok: true, withdrawn: 1, interrupted: 1 });
    expect(flexibleTurn(store, waiting)).toMatchObject({ status: "withdrawn" });
    expect(flexibleTurn(store, running)).toMatchObject({ status: "interrupted", costBasis: "unknown" });
    expect(ledger().at(-1)).toEqual({ actor: "toolroll", action: "flexible turns ended at restart", outcome: "interrupted" });
    // The new process: the request that never started is admitted once, and a retry of it gets the same turn back.
    const again = admitted({ thread: T1, requestKey: "msg-1", holder: "h2" });
    expect(again).not.toBe(waiting);
    expect(admit({ thread: T1, requestKey: "msg-1", holder: "h2" })).toEqual({ ok: true, turn: again, seq: 2, replayed: true });
    expect(admit({ thread: T2, requestKey: "msg-2", holder: "h2" })).toMatchObject({ ok: false, reason: "already-sent" });
    // Two places used today: the interrupted turn and the re-admitted one; the withdrawn one took none.
    expect(admit({ thread: T2, requestKey: "msg-3", holder: "h2" })).toMatchObject({ ok: false, reason: "cap-reached", cap: "project-turns" });
  });

  test("the record refuses what it can't name and only moves forward", () => {
    const id = admitted();
    const db = store.handle;
    expect(() => db.prepare("UPDATE thread_turn SET status = 'finished', ended_at = ?, started_at = ?, cost_basis = 'measured' WHERE id = ?").run(NOW.toISOString(), NOW.toISOString(), id)).toThrow(/only moves forward/);
    expect(() => db.prepare("UPDATE thread_turn SET level = 'supervised' WHERE id = ?").run(id)).toThrow(/written once/);
    expect(() => db.prepare("UPDATE thread_turn SET tokens_in = 5 WHERE id = ?").run(id)).toThrow(); // no usage before it starts
    expect(beginFlexibleTurn(store, { turn: id, holder: "h1", now: NOW })).toMatchObject({ ok: true });
    expect(() => db.prepare("UPDATE thread_turn SET status = 'withdrawn', ended_at = ? WHERE id = ?").run(NOW.toISOString(), id)).toThrow(/only moves forward/);
    expect(() => db.prepare("UPDATE thread_turn SET started_at = ? WHERE id = ?").run(LATER.toISOString(), id)).toThrow(/only moves forward/);
  });

  test("spend lists thread turns by when they started, toward the project and the owner", () => {
    turn({ billing: "api-key" }, { tokensIn: 3, tokensOut: 4, costUsd: 0.5 });
    expect(spendItems(store.handle, "2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z").filter(one => one.kind === "flexible"))
      .toEqual([expect.objectContaining({ kind: "flexible", microusd: 500_000, source: "reported", project: REPO, person: "pat", provider: "claude", tokensIn: 3, tokensOut: 4, authMode: "api-key" })]);
  });
});

/** Turn the project's terms off and on again with exactly the same words: a new terms row under the same digest. */
function offAndOn(repo: string): void {
  const row = store.handle.prepare("SELECT terms_json, digest FROM flexible_terms WHERE repo = ? AND ended_at IS NULL").get(repo)!;
  store.handle.prepare("UPDATE flexible_terms SET ended_at = ?, ended_by = 'alex', end_reason = 'off' WHERE repo = ? AND ended_at IS NULL").run(NOW.toISOString(), repo);
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(repo, row["terms_json"], row["digest"], row["terms_json"], row["digest"], NOW.toISOString(), NOW.toISOString());
}

describe("an admission is for exactly that request, under exactly those terms, on its own day", () => {
  test("a repeated request with anything changed is refused, and the start runs what was admitted", () => {
    const first = admitted({ requestKey: "msg-1", level: "full" });
    for (const change of [{ level: "supervised" }, { provider: "codex" }, { model: "claude-opus-4-1" }, { billing: "api-key" }, { holder: "h9" }] as Partial<FlexibleTurnRequest>[]) {
      expect(admit({ requestKey: "msg-1", ...change }), JSON.stringify(change)).toMatchObject({ ok: false, reason: "request-changed" });
    }
    expect(admit({ requestKey: "msg-1", level: "full" })).toEqual({ ok: true, turn: first, seq: 1, replayed: true });
    expect(beginFlexibleTurn(store, { turn: first, holder: "h1", now: NOW })).toMatchObject({ ok: true, turn: { level: "full", provider: "claude", billing: "subscription" } });
  });

  test("terms turned off and on again with the same words don't revive a turn admitted under the old ones", () => {
    const waiting = admitted({ requestKey: "msg-1" });
    offAndOn(REPO);
    expect(beginFlexibleTurn(store, { turn: waiting, holder: "h1", now: NOW })).toMatchObject({ ok: false, reason: "terms-changed" });
    expect(statusOf(waiting)).toBe("withdrawn");
    // The same request again: admitted afresh under the live terms.
    const again = admit({ requestKey: "msg-1" });
    expect(again).toMatchObject({ ok: true, replayed: false });
    // And a waiting turn the same request finds under ended terms is withdrawn, never handed back.
    if (!again.ok) return;
    offAndOn(REPO);
    const third = admit({ requestKey: "msg-1" });
    expect(third).toMatchObject({ ok: true, replayed: false });
    if (third.ok) expect(third.turn).not.toBe(again.turn);
    expect(statusOf(again.turn)).toBe("withdrawn");
  });

  test("a waiting turn doesn't start once a dollar limit is reached while it waited", () => {
    expect(setFlexibleInstallationCaps(store, { by: "alex", caps: { liveThreads: null, turnsPerDay: null, measuredMicrousdPerDay: 1_000_000 }, now: NOW })).toMatchObject({ ok: true });
    thread(T2);
    const a = admitted({ thread: T1, billing: "api-key" });
    const b = admitted({ thread: T2, billing: "api-key" });
    expect(beginFlexibleTurn(store, { turn: b, holder: "h1", now: NOW })).toMatchObject({ ok: true });
    expect(chargeFlexibleTurn(store, { turn: b, usage: { tokensIn: 1, tokensOut: 1, costUsd: 2 } })).toMatchObject({ ok: true });
    expect(finishFlexibleTurn(store, { turn: b, holder: "h1", outcome: "finished", usage: null, now: NOW })).toMatchObject({ ok: true });
    expect(beginFlexibleTurn(store, { turn: a, holder: "h1", now: NOW })).toMatchObject({ ok: false, reason: "cap-reached", cap: "installation-dollars", resetsAt: MIDNIGHT });
    expect(statusOf(a)).toBe("withdrawn");
  });

  test("a waiting turn doesn't start on a later day: its place was counted in the day it was admitted", () => {
    const waiting = admitted({ now: LATER });
    expect(beginFlexibleTurn(store, { turn: waiting, holder: "h1", now: TOMORROW })).toMatchObject({ ok: false, reason: "turn-expired", message: "This turn waited past midnight UTC, so it didn't start. Send the message again." });
    expect(statusOf(waiting)).toBe("withdrawn");
  });

  test("a keyed turn of unknown cost holds the monthly hard budgets it counts toward until the month ends", () => {
    turn({ billing: "api-key" }, null, "unknown");
    store.setBudget({ scope: "project", key: REPO, limitMicrousd: 50_000_000, hardStop: true }, "alex", NOW);
    expect(admit({ billing: "api-key" })).toMatchObject({ ok: false, reason: "spend-unknown", cap: "budget", resetsAt: "2026-12-01T00:00:00.000Z",
      message: expect.stringContaining("so the app project's budget can't be checked") });
    expect(admit({ billing: "subscription" })).toMatchObject({ ok: true });
  });
});

/** One process's admission, with its own database handle: the build's constant replaced by a module hook (as vi.mock
 * does here), started together with the others. */
const RACE = `
const env = JSON.parse(process.env.FLEXIBLE_RACE);
const { register } = await import("node:module");
register("data:text/javascript," + encodeURIComponent("export async function resolve(specifier, context, next) { if (/flexible-available\\\\.(js|ts)$/.test(specifier)) return { url: 'data:text/javascript,export const FLEXIBLE_AVAILABLE = true;', shortCircuit: true }; return next(specifier, context); }"));
const { existsSync, writeFileSync } = await import("node:fs");
const { openStore } = await import(env.modules.store);
const { admitFlexibleTurn } = await import(env.modules.turns);
const store = openStore(env.file);
writeFileSync(env.ready, "");
while (!existsSync(env.go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
const made = admitFlexibleTurn(store, { thread: env.thread, starter: env.starter, digest: env.digest, level: "full", freshProof: false, provider: "claude", model: "claude-sonnet-4-5",
  billing: "subscription", requestKey: "race", holder: "h-" + env.thread, now: new Date(env.now) });
store.close();
process.stdout.write(JSON.stringify(made));
`;

describe("two admissions racing for the last place", () => {
  test("four processes, one place left: exactly one is admitted", async () => {
    plant(REPO, { liveThreads: 2 });
    for (const one of [T2, T3, T4, tid(5)]) thread(one);
    admitted({ thread: T1 }); // one of the two places is taken
    const env = { file, digest: digests[REPO], starter: { name: "pat", generation: gen("pat") }, now: NOW.toISOString(),
      modules: { store: new URL("./store.ts", import.meta.url).href, turns: new URL("./flexible-turns.ts", import.meta.url).href } };
    store.close();
    const go = join(dir, "go");
    const passes = [T2, T3, T4, tid(5)].map(one => {
      const ready = join(dir, `ready-${one}`);
      const done = new Promise<{ ok: boolean; reason?: string; cap?: string }>((resolve, reject) => {
        execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", RACE], { cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { ...process.env, FLEXIBLE_RACE: JSON.stringify({ ...env, thread: one, ready, go }) }, timeout: 60_000 },
        (error, stdout, stderr) => error === null ? resolve(JSON.parse(stdout)) : reject(new Error(`${error.message}\n${stderr}`)));
      });
      return { ready, done };
    });
    const started = Date.now();
    while (!passes.every(one => existsSync(one.ready))) {
      if (Date.now() - started > 50_000) throw new Error("the processes never started");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    writeFileSync(go, "");
    const results = await Promise.all(passes.map(one => one.done));
    store = openStore(file);
    expect(results.filter(one => one.ok)).toHaveLength(1);
    expect(results.filter(one => !one.ok)).toEqual(Array(3).fill(expect.objectContaining({ ok: false, reason: "cap-reached", cap: "project-threads" })));
    expect(store.handle.prepare("SELECT COUNT(DISTINCT thread) AS n FROM thread_turn WHERE status = 'admitted'").get()!["n"]).toBe(2);
  }, 90_000);
});
