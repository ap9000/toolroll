/**
 * Flexible projects ship compiled in and switched off (flexible-available.ts). With the real constant: every writer,
 * the delegation check, the CLI and the settings route refuse with a plain reason, and no page offers it. And the
 * constant can't become a runtime override: one literal, no environment, config or exported setter, imported only by
 * name, and the built file says false too.
 */
import { fakePid } from "../test/fake-pid.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Server } from "node:http";
import * as available from "./flexible-available.js";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { runOperate, EXIT } from "./operate.js";
import { createDecisionServer } from "./serve.js";
import { ROUTES } from "./server/route-table.js";
import { flexibleThreadCodexProfile, flexibleThreadFence, flexibleThreadSpawn, prepareFlexibleThread, removeFlexibleThread, stopFlexibleThreadAgent, withFlexibleThreadLock } from "./flexible-thread.js";
import { admitFlexibleTurn, beginFlexibleTurn, chargeFlexibleTurn, finishFlexibleTurn, interruptFlexibleThreadTurns, interruptFlexibleTurnsOf, setFlexibleInstallationCaps, withdrawFlexibleTurn, withdrawFlexibleTurnsAbove } from "./flexible-turns.js";
import { flexibleAgentLaunch, lowerFlexibleThreadLevel, recoverFlexibleLaunchesOf, startFlexibleTurn } from "./flexible-agents.js";
import { startFlexibleRelay } from "./flexible-relay.js";
import { ackFlexibleAnswer, cancelFlexibleAnswer, decideFlexibleAnswer, decideFlexibleAnswerByPolicy, expireFlexibleAnswers, flexibleRequestsOf, noteFlexibleToolActivity, openFlexibleAnswerCatalog,
  recordFlexibleProviderDecision, recordFlexibleRequest, recoverFlexibleAnswersOf, revokeFlexibleAnswers, sendFlexibleAnswer, streamAnswerSender, type FlexibleAnswerCatalog } from "./flexible-answers.js";
import { PassThrough } from "node:stream";
import { admitFlexibleThreadOwner, answerFlexibleRequest, attachFlexibleAgent, beginFlexibleThreadTurn, closeFlexibleSessions, endFlexibleThreadTurn, flexibleThreadChangeOf, flexibleThreadLiveOf, flexibleThreadsOf,
  lowerFlexibleThreadSession, openFlexibleSessions, recoverFlexibleHolders, startFlexibleThread, startFlexibleThreadSession, stopFlexibleThreadSession, tickFlexibleSessions, waitFlexibleThreadChange,
  type FlexibleSessions } from "./flexible-session.js";
import { createFlexibleLauncher, flexibleThreadNetwork } from "./flexible-launcher.js";
import { flexibleStartCard } from "./flexible-start.js";
import * as upstreams from "./flexible-relay-upstreams.js";
import { flexibleTaskBranch, importFlexibleCandidate, readFlexibleCandidate, removeFlexibleImportRefs, settleInterruptedImport } from "./flexible-import.js";
import { cancelFlexibleShip, flexibleArmedPass, flexibleShipsOf, flexibleShipTerms, mergeArmedFlexible, reconcileFlexibleShips, removeFlexibleImport, sendBackFlexible, shipFlexible } from "./flexible-ship.js";
import { enableFlexible, flexibleDelegationAtUse, flexibleDigestOf, flexibleSettingsView, flexibleTermsJson, FLEXIBLE_UNAVAILABLE, lowerFlexible, turnFlexibleOff, type FlexibleTerms } from "./flexible.js";

const NOW = new Date();
let dir: string, repo: string, db: string, store: Store;
const tokens: Record<string, string> = {};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flexible-off-")));
  repo = join(dir, "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  db = join(dir, "orders.db");
  store = openStore(db);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  tokens["alex"] = alex.token;
  const made = store.createConsoleTask({ title: "known", repo, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, NOW);
  if (!made.ok) throw new Error(made.reason);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** Terms planted as if a later build had written them: still nothing works here. */
function plant(): string {
  const terms: FlexibleTerms = { version: 1, repo, signer: "alex", signerGeneration: store.accountOf("alex")!.generation, starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  const digest = flexibleDigestOf(terms);
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(repo, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  return digest;
}
const rows = () => store.handle.prepare("SELECT id, ended_at FROM flexible_terms").all().map(row => ({ ...row }));

describe("switched off", () => {
  test("the build's constant is false", () => {
    expect(available.FLEXIBLE_AVAILABLE).toBe(false);
  });

  test("every writer and the delegation check refuse, and write nothing", () => {
    const digest = plant();
    const before = rows();
    const refused = { ok: false, reason: "not-available", message: FLEXIBLE_UNAVAILABLE };
    expect(enableFlexible(store, { repo, by: "alex", proof: "password-now", shownDigest: digest, now: NOW })).toEqual(refused);
    expect(lowerFlexible(store, { repo, by: "alex", max: "auto", now: NOW })).toEqual(refused);
    expect(turnFlexibleOff(store, { repo, by: "alex", now: NOW })).toEqual(refused);
    expect(flexibleDelegationAtUse(store, { repo, starter: { name: "alex", generation: store.accountOf("alex")!.generation }, digest, level: "supervised", freshProof: true })).toEqual(refused);
    expect(rows()).toEqual(before);
    expect(flexibleSettingsView(store, repo, { name: "alex", canChange: true })).toBeUndefined();
  });

  test("the thread engine refuses to make, remove, fence or start a thread, and makes nothing", async () => {
    const refused = { ok: false, reason: "not-available", message: FLEXIBLE_UNAVAILABLE };
    store.upsertProject(repo, "shop", NOW);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "first"], { cwd: repo });
    expect(await prepareFlexibleThread(store, { repo, base: "HEAD", by: "alex", now: NOW })).toEqual(refused);
    expect(existsSync(join(dir, "threads"))).toBe(false);
    // A thread planted as if a later build had made it: still nothing runs.
    const id = "a".repeat(32);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'alex', ?, 'ready')`)
      .run(id, repo, sha, `refs/toolroll/threads/${id}/base`, join(dir, "threads", id), NOW.toISOString());
    const launch = { id, network: { proxyPort: 41_000, token: "t" }, storage: { names: [], denies: [] } };
    expect(flexibleThreadFence(store, launch)).toEqual(refused);
    const marker = join(dir, "ran");
    expect(await flexibleThreadSpawn(store, { ...launch, proxyEnv: {}, launch: { provider: "claude", level: "full", turn: null, holder: "h1" } }, "/bin/sh", ["-c", `echo ran > ${marker}`])).toEqual(refused);
    expect(flexibleThreadCodexProfile(store, launch)).toEqual(refused);
    expect(await removeFlexibleThread(store, { id, by: "alex", now: NOW })).toEqual(refused);
    // F2c: stopping a thread's agent, starting a turn, lowering a level, recovering a holder's launches and building an
    // agent's launch all refuse too; and F2b: the thread's sign-in relay doesn't start. Nothing is launched, recorded or
    // listened on.
    store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
      VALUES (?, ?, 'claude', 'full', ?, 'h1', 'here', ?, ${fakePid(1)}, 't1', 'live', ?)`).run("e".repeat(32), id, "f".repeat(32), "9".repeat(32), NOW.toISOString());
    const launchesBefore = store.handle.prepare("SELECT * FROM flexible_thread_launch").all().map(row => ({ ...row }));
    expect(await stopFlexibleThreadAgent(store, { id, reason: "test", clock: () => NOW })).toEqual(refused);
    expect(await startFlexibleTurn(store, { turn: "c".repeat(32), holder: "h1", clock: () => NOW, network: { proxyPort: 41_000, token: "t", proxyEnv: {}, close: () => {} },
      relay: { url: "http://127.0.0.1:1", port: 1, issue: () => ({ url: "http://127.0.0.1:1", token: "r", revoke: () => {} }) }, storage: { names: [], denies: [] } })).toEqual(refused);
    let locked = false;
    expect(await withFlexibleThreadLock(id, async () => { locked = true; })).toEqual(refused);
    expect(locked).toBe(false);
    expect(await lowerFlexibleThreadLevel(store, { thread: id, by: { name: "alex", generation: store.accountOf("alex")!.generation }, level: "supervised", clock: () => NOW })).toEqual(refused);
    expect(await recoverFlexibleLaunchesOf(store, { holder: "h1", clock: () => NOW })).toEqual(refused);
    expect(flexibleAgentLaunch("claude", "full", { model: "claude-sonnet-4-5", relay: { url: "http://127.0.0.1:1", token: "r" }, configHome: join(dir, "home") })).toEqual(refused);
    expect(await startFlexibleRelay(store, { thread: id })).toEqual(refused);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM thread_relay_call").get()!["n"]).toBe(0);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_relay_grant").get()!["n"]).toBe(0);
    expect(store.handle.prepare("SELECT * FROM flexible_thread_launch").all().map(row => ({ ...row }))).toEqual(launchesBefore);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread_level").get()!["n"]).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(store.handle.prepare("SELECT state FROM flexible_thread WHERE id = ?").get(id)!["state"]).toBe("ready");
  });

  test("turn admission refuses to admit, start, charge, finish or end a turn, and to set the installation's limits, and writes nothing", () => {
    const refused = { ok: false, reason: "not-available", message: FLEXIBLE_UNAVAILABLE };
    const digest = plant();
    const id = "b".repeat(32);
    store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'alex', ?, 'ready')`)
      .run(id, repo, "a".repeat(40), `refs/toolroll/threads/${id}/base`, join(dir, "threads", id), NOW.toISOString());
    expect(admitFlexibleTurn(store, { thread: id, starter: { name: "alex", generation: store.accountOf("alex")!.generation }, digest, level: "full", freshProof: true, provider: "claude",
      model: "claude-sonnet-4-5", billing: "subscription", requestKey: "m-1", holder: "h1", clock: () => NOW })).toEqual(refused);
    // A turn planted as if a later build had admitted it: still nothing moves.
    const turn = "c".repeat(32);
    store.handle.prepare(`INSERT INTO thread_turn (id, thread, seq, repo, owner, owner_generation, terms_id, terms_digest, level, provider, model, billing, request_key, holder, admitted_at, utc_day, status)
      VALUES (?, ?, 1, ?, 'alex', 1, 1, ?, 'full', 'claude', 'claude-sonnet-4-5', 'subscription', 'm-0', 'h1', ?, ?, 'admitted')`).run(turn, id, repo, digest, NOW.toISOString(), NOW.toISOString().slice(0, 10));
    const before = store.handle.prepare("SELECT * FROM thread_turn").all().map(row => ({ ...row }));
    expect(beginFlexibleTurn(store, { turn, holder: "h1", clock: () => NOW })).toEqual(refused);
    expect(chargeFlexibleTurn(store, { turn, usage: { tokensIn: 1, tokensOut: 1, costUsd: 1 } })).toEqual(refused);
    expect(finishFlexibleTurn(store, { turn, holder: "h1", outcome: "finished", usage: null, clock: () => NOW })).toEqual(refused);
    expect(interruptFlexibleTurnsOf(store, { holder: "h1", clock: () => NOW })).toEqual(refused);
    expect(setFlexibleInstallationCaps(store, { by: "alex", caps: { liveThreads: 1, turnsPerDay: null, measuredMicrousdPerDay: null }, clock: () => NOW })).toEqual(refused);
    expect(withdrawFlexibleTurn(store, { turn, holder: "h1", detail: "x", clock: () => NOW })).toEqual(refused);
    expect(interruptFlexibleThreadTurns(store, { thread: id, detail: "x", clock: () => NOW })).toEqual(refused);
    expect(withdrawFlexibleTurnsAbove(store, { thread: id, level: "supervised", detail: "x", clock: () => NOW })).toEqual(refused);
    expect(store.handle.prepare("SELECT * FROM thread_turn").all().map(row => ({ ...row }))).toEqual(before);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_installation_caps").get()!["n"]).toBe(0);
  });

  test("the answers to a thread's agent (F2d): no catalog opens, and nothing is recorded, decided, sent, cancelled, acknowledged or recovered", async () => {
    const refused = { ok: false, reason: "not-available", message: FLEXIBLE_UNAVAILABLE };
    const catalogFile = join(dir, "orders.db.coding.sqlite");
    expect(openFlexibleAnswerCatalog(store)).toEqual(refused);
    expect(existsSync(catalogFile)).toBe(false);
    // A catalog handed in anyway is never touched, nor the connection.
    const touched: string[] = [];
    const catalog = new Proxy({}, { get: (_target, key) => { touched.push(String(key)); throw new Error("touched"); } }) as FlexibleAnswerCatalog;
    const connection = { id: "a".repeat(32), frame: () => { touched.push("frame"); return new Uint8Array(1); }, send: async () => { touched.push("send"); return { written: 1, complete: true }; } };
    const ids = { thread: "a".repeat(32), turn: "b".repeat(32), connection: "c".repeat(32), request: "d".repeat(32) };
    const person = { kind: "person" as const, name: "alex", generation: store.accountOf("alex")!.generation };
    expect(recordFlexibleRequest(store, catalog, { ...ids, holder: "h1", requestRef: "r1", kind: "permission", card: { title: "Allow?" } })).toEqual(refused);
    expect(decideFlexibleAnswer(store, catalog, { request: ids.request, token: "0".repeat(64), shownDigest: "1".repeat(64), by: person, decision: "accept" })).toEqual(refused);
    expect(decideFlexibleAnswerByPolicy(store, catalog, { request: ids.request, rule: "no-channel" })).toEqual(refused);
    expect(await sendFlexibleAnswer(store, catalog, { request: ids.request, connection, holder: "h1" })).toEqual(refused);
    expect(cancelFlexibleAnswer(store, catalog, { request: ids.request, by: person })).toEqual(refused);
    expect(revokeFlexibleAnswers(store, catalog, { thread: ids.thread, reason: "x" })).toEqual(refused);
    expect(ackFlexibleAnswer(store, catalog, { connection: ids.connection, requestRef: "r1" })).toEqual(refused);
    expect(noteFlexibleToolActivity(store, catalog, { connection: ids.connection, turn: ids.turn, correlation: "t1" })).toEqual(refused);
    expect(expireFlexibleAnswers(store, catalog)).toEqual(refused);
    expect(recoverFlexibleAnswersOf(store, catalog, { holder: "h1" })).toEqual(refused);
    expect(recordFlexibleProviderDecision(store, { ...ids, holder: "h1", requestRef: "r1", decision: "accept", provider: "claude" })).toEqual(refused);
    expect(streamAnswerSender(new PassThrough())).toEqual(refused);
    expect(flexibleRequestsOf(catalog, { thread: ids.thread })).toEqual(refused);
    expect(touched).toEqual([]);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM thread_decision").get()!["n"]).toBe(0);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = 'flexible answer'").get()!["n"]).toBe(0);
  });

  test("Ship (F4): no import, no terms, no Ship, no armed merge, no pass, no reconciling, no cancel, send back or removal; nothing written, no ref moved", async () => {
    const refused = { ok: false, reason: "not-available", message: FLEXIBLE_UNAVAILABLE };
    store.upsertProject(repo, "shop", NOW);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "first"], { cwd: repo });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    // A thread and a sent send planted as if a later build had made them: still nothing moves.
    const id = "a".repeat(32), ship = "b".repeat(32);
    store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'alex', ?, 'ready')`)
      .run(id, repo, sha, `refs/toolroll/threads/${id}/base`, join(dir, "threads", id), NOW.toISOString());
    store.handle.prepare(`INSERT INTO flexible_ship (id, thread, seq, repo, base_sha, candidate, import_ref, branch, terms_json, digest, summary_key, approved_by, approved_generation, proof, approved_at, delegation_id, state, state_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, '{}', ?, ?, 'alex', 1, 'password-now', ?, 1, 'approved', ?)`).run(ship, id, repo, sha, sha, `refs/toolroll/import/${id}/1`, `toolroll/code-${id}`, ship, "c".repeat(32), NOW.toISOString(), NOW.toISOString());
    const refs = () => execFileSync("git", ["for-each-ref"], { cwd: repo, encoding: "utf8" });
    const ships = () => store.handle.prepare("SELECT * FROM flexible_ship").all().map(row => ({ ...row }));
    const [refsBefore, shipsBefore] = [refs(), ships()];
    const by = { name: "alex", generation: store.accountOf("alex")!.generation };
    expect(await readFlexibleCandidate(store, { thread: id })).toEqual(refused);
    expect(await importFlexibleCandidate(store, { thread: id, seq: 1, expected: sha, branchBefore: null, by: "alex", now: NOW })).toEqual(refused);
    expect(await removeFlexibleImportRefs(store, { thread: id, seq: 1, candidate: sha, branchBefore: null })).toEqual(refused);
    expect(await flexibleTaskBranch(store, { thread: id, branch: `toolroll/flexible-${ship}`, at: sha, make: true })).toBe(false);
    expect(await flexibleShipTerms(store, { thread: id, by: "alex" })).toEqual(refused);
    expect(await settleInterruptedImport(store, { thread: id, seq: 1, candidate: sha, branchBefore: null })).toEqual(refused);
    expect(await shipFlexible(store, { thread: id, by: "alex", token: tokens["alex"]!, shownDigest: ship, shownKey: ship, now: NOW })).toEqual(refused);
    expect(flexibleShipsOf(store, id)).toEqual(refused);
    expect(await mergeArmedFlexible(store, { taskId: `flexible-${ship}`, root: join(dir, "evidence") })).toEqual(refused);
    // The watch loop's pass (the one caller outside the engine) and the reconciler refuse too: the planted Ship stays
    // `approved`, its refs untouched.
    expect(await flexibleArmedPass(store, { root: join(dir, "evidence") })).toEqual(refused);
    expect(await reconcileFlexibleShips(store, { now: NOW })).toEqual(refused);
    expect(cancelFlexibleShip(store, { taskId: `flexible-${ship}`, by, now: NOW })).toEqual(refused);
    expect(sendBackFlexible(store, { taskId: `flexible-${ship}`, by, feedback: "again", now: NOW })).toEqual(refused);
    expect(await removeFlexibleImport(store, { ship, by, now: NOW })).toEqual(refused);
    expect(refs()).toBe(refsBefore);
    expect(ships()).toEqual(shipsBefore);
    expect(existsSync(join(dir, "threads"))).toBe(false);
  });

  test("the thread view (F3): no host opens, and every session entry refuses without touching a host, a catalog, a stream or the store", async () => {
    const refused = { ok: false, reason: "not-available", message: FLEXIBLE_UNAVAILABLE };
    const catalogFile = join(dir, "orders.db.coding.sqlite");
    expect(openFlexibleSessions(store)).toEqual(refused);
    expect(existsSync(catalogFile)).toBe(false);
    // A host handed in anyway (as if a later build had opened one) is never touched; nor are the agent's streams.
    const touched: string[] = [];
    const sessions = new Proxy({}, { get: (_target, key) => { touched.push(String(key)); throw new Error("touched"); } }) as FlexibleSessions;
    const stdout = new PassThrough(), stdin = new PassThrough();
    stdout.on("newListener", event => touched.push(`stdout:${String(event)}`));
    stdin.on("newListener", event => touched.push(`stdin:${String(event)}`));
    const id = "a".repeat(32), turn = "b".repeat(32), request = "d".repeat(32);
    const before = ["thread_turn", "thread_decision", "flexible_thread_launch", "flexible_relay_grant", "flexible_thread_level", "action_ledger"].map(table => store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!["n"]);
    const person = { name: "alex", generation: store.accountOf("alex")!.generation };
    expect(await closeFlexibleSessions(store, sessions)).toEqual(refused);
    expect(tickFlexibleSessions(store, sessions)).toEqual(refused);
    expect(await recoverFlexibleHolders(store, sessions)).toEqual(refused);
    expect(await startFlexibleThreadSession(store, sessions, { thread: id })).toEqual(refused);
    expect(await stopFlexibleThreadSession(store, sessions, { thread: id, reason: "test" })).toEqual(refused);
    expect(attachFlexibleAgent(store, sessions, { thread: id, turn, launch: "c".repeat(32), stdout, stdin, exited: () => { touched.push("exited"); } })).toEqual(refused);
    expect(endFlexibleThreadTurn(store, sessions, { thread: id, turn, outcome: "finished" })).toEqual(refused);
    expect(await lowerFlexibleThreadSession(store, sessions, { thread: id, by: person, level: "supervised" })).toEqual(refused);
    const launcher = { prepare: async () => { touched.push("prepare"); return { ok: true as const, network: { proxyPort: 1, token: "t", proxyEnv: {}, close: () => {} }, storage: { names: [], denies: [] } }; },
      open: () => 0, close: async () => { touched.push("close"); } };
    expect(await beginFlexibleThreadTurn(store, sessions, { turn, message: "hello", launcher })).toEqual(refused);
    expect(await startFlexibleThread(store, sessions, { repo, by: person, digest: "0".repeat(64), message: "hello", model: "claude-sonnet-4-5", launcher })).toEqual(refused);
    expect(await answerFlexibleRequest(store, sessions, { held: () => true, thread: id, request, shownDigest: "1".repeat(64), by: { kind: "person", ...person }, choice: { decision: "accept" } })).toEqual(refused);
    expect(flexibleThreadLiveOf(store, sessions, { thread: id, viewer: { name: "alex" }, file: "main", cursor: null })).toEqual(refused);
    expect(flexibleThreadsOf(store, sessions, { owner: "alex" })).toEqual(refused);
    expect(admitFlexibleThreadOwner(store, sessions, { thread: id, viewer: { name: "alex" }, canAccess: () => { touched.push("canAccess"); return true; } })).toEqual(refused);
    // The owner's read woken on change (pre-enable push): no count is read and nothing waits.
    expect(flexibleThreadChangeOf(sessions, { thread: id })).toEqual(refused);
    expect(waitFlexibleThreadChange(sessions, { thread: id, since: 0, ms: 10, abandoned: () => { touched.push("abandoned"); } })).toEqual(refused);
    expect(touched).toEqual([]);
    expect(stdin.writableLength).toBe(0);
    expect(["thread_turn", "thread_decision", "flexible_thread_launch", "flexible_relay_grant", "flexible_thread_level", "action_ledger"].map(table => store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!["n"])).toEqual(before);
    expect(existsSync(join(dir, "threads"))).toBe(false);
  });

  test("the console's launcher and the start's terms card (pre-enable): no launcher is made, no network read, no proxy started, no card built", async () => {
    const refused = { ok: false, reason: "not-available", message: FLEXIBLE_UNAVAILABLE };
    const digest = plant();
    store.upsertProject(repo, "shop", NOW);
    const started: string[] = [];
    expect(createFlexibleLauncher(store, { startProxy: async () => { started.push("proxy"); throw new Error("started"); }, storage: async () => { started.push("storage"); return { names: [], denies: [] }; } })).toEqual(refused);
    expect(flexibleThreadNetwork(store, repo)).toEqual(refused);
    expect(flexibleStartCard(store, { repo, by: { name: "alex", generation: store.accountOf("alex")!.generation }, model: null, message: "hello" })).toEqual(refused);
    expect(started).toEqual([]);
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
  });

  test.each([["show"], ["enable"], ["lower"], ["off"]])("the CLI refuses project flexible %s", async action => {
    const lines: string[] = [];
    const code = await runOperate("project", ["flexible", action, "--repo", repo, "--json", ...(action === "show" ? [] : ["--as", "alex", "--token", tokens["alex"]!]), ...(action === "lower" ? ["--max", "auto"] : [])],
      line => lines.push(line), { databaseFile: db });
    expect(code).toBe(EXIT.refused);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, reason: "not-available", message: FLEXIBLE_UNAVAILABLE });
  });

  test("no page offers it, and the route refuses an approver's post, password and all", async () => {
    const server: Server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo, platform: "darwin", fenceAvailable: () => true });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address !== "object") throw new Error("listen");
      const base = `http://127.0.0.1:${address.port}`;
      const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: tokens["alex"]! }), redirect: "manual" }))
        .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      const html = await (await fetch(`${base}/settings/project?repo=${encodeURIComponent(repo)}`, { headers: { cookie } })).text();
      expect(html).toContain('id="sandbox"'); // the page itself drew
      expect(html).not.toContain('id="flexible"');
      expect(html).not.toContain("How work starts");
      expect(html).not.toContain("/settings/project/flexible");
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
      const digest = plant();
      for (const fields of [{ action: "enable", digest, password: tokens["alex"]! }, { action: "lower", max: "auto" }, { action: "off" }]) {
        const answer = await fetch(`${base}/settings/project/flexible`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, repo, ...fields }), redirect: "manual" });
        expect(answer.status).toBe(403);
        expect(await answer.text()).toContain("Flexible projects aren");
      }
      expect(rows().every(row => row["ended_at"] === null)).toBe(true);
      // The thread roads (F3): the list, one answer and a new thread all refuse, before anything is looked up.
      expect(await (await fetch(`${base}/agents/live/threads`, { headers: { cookie } })).json()).toEqual({ error: "not-available" });
      expect(await (await fetch(`${base}/agents/live/thread/${"a".repeat(32)}`, { headers: { cookie } })).json()).toEqual({ error: "not-available" });
      // A new thread both ways: asking for its terms card (no key), and naming one.
      for (const [path, fields] of [[`/agents/live/thread/${"a".repeat(32)}/answer`, { request: "d".repeat(32), card: "1".repeat(64), decision: "accept" }], ["/agents/live/thread", { repo, message: "hello", terms: digest }],
        ["/agents/live/thread", { repo, message: "hello" }]] as const) {
        const answer = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
        expect(answer.status, path).toBe(404);
        expect(await answer.json(), path).toEqual({ outcome: "refused", words: FLEXIBLE_UNAVAILABLE });
      }
      expect(existsSync(join(dir, "orders.db.coding.sqlite"))).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe("the switch can't become a runtime override", () => {
  const sources = (root: string): { path: string; text: string }[] => readdirSync(root, { withFileTypes: true, recursive: true })
    .filter(one => one.isFile() && /\.(ts|tsx|mts)$/.test(one.name))
    .map(one => { const path = join(one.parentPath, one.name); return { path: relative(".", path), text: readFileSync(path, "utf8") }; });
  const product = sources("src").filter(one => !/\.test\.tsx?$/.test(one.path));

  test("flexible-available.ts is one exported literal and nothing else", () => {
    const code = readFileSync("src/flexible-available.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").trim();
    expect(code).toBe("export const FLEXIBLE_AVAILABLE: boolean = false;");
    expect(Object.keys(available)).toEqual(["FLEXIBLE_AVAILABLE"]);
  });

  test("the built module says false too", () => {
    const built = "dist/flexible-available.js";
    if (!existsSync(built)) return; // the suite's setup builds dist; a source-only run has nothing to check
    expect(readFileSync(built, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").trim()).toBe("export const FLEXIBLE_AVAILABLE = false;");
  });

  test("product code only imports it by name: no assignment, no environment or config key, no re-export", () => {
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*/gm, "");
    const users = product.filter(one => code(one.text).includes("FLEXIBLE_AVAILABLE") && one.path !== join("src", "flexible-available.ts"));
    // server/engine-api.ts: the LiveSession's thread roads refuse before anything is looked up while it is false, and it
    // opens no thread host then. flexible-session.ts (F3): the one bridge from the engine to a person's surface.
    // flexible-launcher.ts and flexible-start.ts (pre-enable): the console's launcher and the start's terms card.
    expect(users.map(one => one.path).sort()).toEqual([join("src", "flexible.ts"), join("src", "flexible-thread.ts"), join("src", "flexible-turns.ts"), join("src", "flexible-agents.ts"), join("src", "flexible-relay.ts"), join("src", "flexible-answers.ts"), join("src", "flexible-session.ts"), join("src", "flexible-import.ts"), join("src", "flexible-ship.ts"), join("src", "flexible-launcher.ts"), join("src", "flexible-start.ts"), join("src", "operate.ts"), join("src", "server", "engine-api.ts"), join("src", "server", "settings.ts")].sort());
    for (const one of users) {
      expect(one.text, one.path).toMatch(/import \{ FLEXIBLE_AVAILABLE \} from "\.\.?\/flexible-available\.js";/);
      expect(one.text, one.path).not.toMatch(/FLEXIBLE_AVAILABLE\s*(?:=(?!=)|\+\+|--)|export\s*\{[^}]*FLEXIBLE_AVAILABLE|as\s+FLEXIBLE_AVAILABLE/);
    }
    // Nothing reads an environment variable or a setting that names Flexible, and only test files mock the module.
    for (const one of product) {
      expect(one.text, one.path).not.toMatch(/process\.env(?:\[["'`]|\.)[A-Z_]*FLEXIBLE/i);
      expect(one.text, one.path).not.toMatch(/vi\.mock\(["'][^"']*flexible-available/);
    }
  });

  test("every Flexible writer checks the constant first", () => {
    const flexible = readFileSync("src/flexible.ts", "utf8");
    for (const name of ["enableFlexible", "lowerFlexible", "turnFlexibleOff", "flexibleDelegationAtUse", "flexibleSettingsView"]) {
      expect(flexible, name).toMatch(new RegExp(`export function ${name}\\([^]*?\\{\\n  if \\(!FLEXIBLE_AVAILABLE\\) return (refuse\\("not-available"\\)|undefined);`));
    }
    expect(readFileSync("src/server/settings.ts", "utf8")).toMatch(/async function projectFlexible\(ctx: HandlerContext\): Promise<void> \{\n    const \{ response, now, posted \} = ctx;\n    const who = browserCaller\(ctx\.who\);\n    if \(!FLEXIBLE_AVAILABLE\) return refuse/);
    expect(readFileSync("src/operate.ts", "utf8")).toMatch(/const \{ write, json \} = context;\n  if \(!FLEXIBLE_AVAILABLE\) return fail\(write, json, command, "not-available"/);
    // The thread engine (F2a): every entry point that makes, removes, fences or starts a thread.
    const thread = readFileSync("src/flexible-thread.ts", "utf8");
    const entries = [...thread.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]!);
    const threadWriters = ["prepareFlexibleThread", "removeFlexibleThread", "flexibleThreadFence", "flexibleThreadSpawn", "flexibleThreadCodexProfile", "stopFlexibleThreadAgent", "withFlexibleThreadLock"];
    expect(entries).toEqual(expect.arrayContaining(threadWriters));
    for (const name of threadWriters) {
      expect(thread, name).toMatch(new RegExp(`export (?:async )?function ${name}(?:<[^>]*>)?\\([^]*?\\{\\n  if \\(!FLEXIBLE_AVAILABLE\\) return refuse\\("not-available"\\);`));
    }
    // Nothing outside the thread engine (and its tests) calls into it yet: no route, CLI command, MCP tool or chat action.
    // The engine's own modules (F2c: the thread start, launches, custody and levels) import each other and nothing else does.
    const engine = (...names: string[]) => (file: { path: string }) => !names.map(name => join("src", name)).includes(file.path);
    // F3: the thread view's bridge (flexible-session.ts) is the engine's one caller from outside it; F4's import and Ship
    // read the thread engine too.
    for (const one of product.filter(engine("flexible-thread.ts", "flexible-agents.ts", "flexible-session.ts", "flexible-import.ts", "flexible-ship.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-thread\.js"/);
    for (const one of product.filter(engine("flexible-agents.ts", "flexible-session.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-agents\.js"/);
    for (const one of product.filter(engine("flexible-launch.ts", "flexible-thread.ts", "flexible-agents.ts", "flexible-relay.ts", "flexible-answers.ts", "flexible-session.ts", "flexible-ship.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-launch\.js"/);
    // The sign-in relay (F2b): only the thread start and the thread's session (F3) use it, and only the relay reads its list of services.
    for (const one of product.filter(engine("flexible-relay.ts", "flexible-agents.ts", "flexible-session.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-relay\.js"/);
    for (const one of product.filter(engine("flexible-relay-upstreams.ts", "flexible-relay.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-relay-upstreams\.js"/);
    // The relay's cancellations: told by the writers that end a call's authority, heard by the relay; nothing else.
    for (const one of product.filter(engine("flexible-relay-cancel.ts", "flexible-relay.ts", "flexible-launch.ts", "flexible-turns.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-relay-cancel\.js"/);
    for (const one of product.filter(engine("flexible-custody.ts", "flexible-launch.ts", "flexible-thread.ts", "flexible-agents.ts", "flexible-session.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-custody\.js"/);
    // The answers (F2d): read the turn and the launch it is bound to; only the thread's session (F3) calls into them.
    for (const one of product.filter(engine("flexible-answers.ts", "flexible-session.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-answers\.js"/);
    // The thread's session (F3): only the engine API's thread roads call into it.
    for (const one of product.filter(engine("flexible-session.ts", join("server", "engine-api.ts")))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/(?:\.\.\/)?flexible-session\.js"/);
    for (const one of product.filter(engine("flexible-levels.ts", "flexible-turns.ts", "flexible-agents.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-levels\.js"/);
    // The thread start (F2c): every entry point checks the constant first.
    const agents = readFileSync("src/flexible-agents.ts", "utf8");
    const starters = ["flexibleAgentLaunch", "startFlexibleTurn", "lowerFlexibleThreadLevel", "recoverFlexibleLaunchesOf"];
    expect([...agents.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]!).sort()).toEqual([...starters].sort());
    for (const name of starters) expect(agents, name).toMatch(new RegExp(`export (?:async )?function ${name}\\([^]*?\\{\\n  if \\(!FLEXIBLE_AVAILABLE\\) return refuse\\("not-available"\\);`));
    // Turn admission (F2e): every entry point that admits, starts, charges, finishes or ends a turn, or sets the
    // installation's limits; and nothing outside it (and its tests) calls into it yet.
    const turns = readFileSync("src/flexible-turns.ts", "utf8");
    const writers = ["admitFlexibleTurn", "beginFlexibleTurn", "chargeFlexibleTurn", "finishFlexibleTurn", "interruptFlexibleTurnsOf", "setFlexibleInstallationCaps", "withdrawFlexibleTurn", "interruptFlexibleThreadTurns", "withdrawFlexibleTurnsAbove"];
    expect([...turns.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]!).sort()).toEqual([...writers, "flexibleInstallationCaps", "flexibleTurn"].sort());
    for (const name of writers) {
      // The first statement of the body (the line after the signature's last line) is the check.
      const lines = turns.slice(turns.indexOf(`export function ${name}(`)).split("\n");
      expect(lines[lines.findIndex(line => line.endsWith(" {")) + 1], name).toBe('  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");');
    }
    for (const one of product.filter(engine("flexible-turns.ts", "flexible-launch.ts", "flexible-thread.ts", "flexible-agents.ts", "flexible-relay.ts", "flexible-answers.ts", "flexible-session.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-turns\.js"/);
    // The sign-in relay (F2b): its one entry point checks the constant first; its other export only computes an address.
    const relay = readFileSync("src/flexible-relay.ts", "utf8");
    expect([...relay.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]!).sort()).toEqual(["relayUrlInside", "startFlexibleRelay"]);
    const lines = relay.slice(relay.indexOf("export async function startFlexibleRelay(")).split("\n");
    expect(lines[lines.findIndex(line => line.endsWith(" {")) + 1]).toBe('  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");');
    // The answers (F2d): every entry point checks the constant first, the catalog's opening included.
    const answers = readFileSync("src/flexible-answers.ts", "utf8");
    const answerEntries = ["openFlexibleAnswerCatalog", "streamAnswerSender", "recordFlexibleRequest", "decideFlexibleAnswer", "decideFlexibleAnswerByPolicy", "sendFlexibleAnswer", "cancelFlexibleAnswer",
      "revokeFlexibleAnswers", "ackFlexibleAnswer", "noteFlexibleToolActivity", "expireFlexibleAnswers", "recoverFlexibleAnswersOf", "recordFlexibleProviderDecision", "flexibleRequestsOf"];
    expect([...answers.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]!).sort()).toEqual([...answerEntries].sort());
    for (const name of answerEntries) {
      const body = answers.slice(answers.search(new RegExp(`^export (?:async )?function ${name}\\(`, "m"))).split("\n");
      expect(body[body.findIndex(line => line.endsWith(" {")) + 1], name).toBe('  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");');
    }
    // The thread's session (F3): every entry point checks the constant first, the host's opening, the upkeep tick and
    // holder recovery included; and the engine API opens no host while it is false.
    const session = readFileSync("src/flexible-session.ts", "utf8");
    const sessionEntries = ["openFlexibleSessions", "closeFlexibleSessions", "tickFlexibleSessions", "recoverFlexibleHolders", "startFlexibleThreadSession", "stopFlexibleThreadSession",
      "attachFlexibleAgent", "endFlexibleThreadTurn", "lowerFlexibleThreadSession", "beginFlexibleThreadTurn", "startFlexibleThread", "answerFlexibleRequest", "flexibleThreadLiveOf",
      "flexibleThreadsOf", "admitFlexibleThreadOwner", "flexibleThreadChangeOf", "waitFlexibleThreadChange"];
    expect([...session.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]!).sort()).toEqual([...sessionEntries].sort());
    for (const name of sessionEntries) {
      const body = session.slice(session.search(new RegExp(`^export (?:async )?function ${name}\\(`, "m"))).split("\n");
      expect(body[body.findIndex(line => line.endsWith(" {")) + 1], name).toBe('  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");');
    }
    // The console's launcher and the start's terms card (pre-enable): every entry point checks the constant first (the
    // network digest only hashes what it is given); only the engine API's thread roads, the thread's session (its type)
    // and the terms card (the thread's network) import the launcher, and only the engine API the card.
    for (const [file, names] of [["src/flexible-launcher.ts", ["flexibleThreadNetwork", "createFlexibleLauncher"]], ["src/flexible-start.ts", ["flexibleStartCard"]]] as const) {
      const text = readFileSync(file, "utf8");
      expect([...text.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]!).filter(name => name !== "flexibleNetworkDigest").sort(), file).toEqual([...names].sort());
      for (const name of names) {
        const body = text.slice(text.search(new RegExp(`^export (?:async )?function ${name}\\(`, "m"))).split("\n");
        expect(body[body.findIndex(line => line.endsWith(" {")) + 1], name).toBe('  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");');
      }
    }
    for (const one of product.filter(engine("flexible-launcher.ts", "flexible-session.ts", "flexible-start.ts", join("server", "engine-api.ts")))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/(?:\.\.\/)?flexible-launcher\.js"/);
    for (const one of product.filter(engine("flexible-start.ts", join("server", "engine-api.ts")))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/(?:\.\.\/)?flexible-start\.js"/);
    const engineApi = readFileSync("src/server/engine-api.ts", "utf8");
    expect(engineApi).toMatch(/const flexible: FlexibleSessions \| null = \(\(\) => \{\n    if \(!FLEXIBLE_AVAILABLE\) return null;/);
    expect(engineApi).toMatch(/const launcher: FlexibleLauncher \| null = \(\(\) => \{\n    if \(!FLEXIBLE_AVAILABLE \|\| flexible === null\) return null;/);
    for (const name of ["liveThread", "liveThreads", "threadAnswer", "threadStart"]) {
      expect(engineApi, name).toMatch(new RegExp(`async function ${name}\\(ctx: HandlerContext\\): Promise<void> \\{\\n[^\\n]*\\n(?:[^\\n]*\\n)?    if \\(!FLEXIBLE_AVAILABLE \\|\\| flexible === null\\) return `));
    }
    // Ship (F4): the controlled import and the Ship's two presses, send back and removal. Every entry point checks the
    // constant first; only the Ship calls the import, nothing calls the Ship yet, and the ref audit is the thread
    // engine's and the import's alone.
    /** Every exported function of `file` is a gated entry point (its first statement is the check) or a named pure one
     * (a computation over its arguments: it reads and writes nothing). */
    const gatedFirst = (file: string, gated: readonly string[], pure: readonly string[]) => {
      const text = readFileSync(file, "utf8");
      expect([...text.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]!).sort(), file).toEqual([...gated, ...pure].sort());
      for (const name of gated) {
        const body = text.slice(text.search(new RegExp(`^export (?:async )?function ${name}\\(`, "m"))).split("\n");
        expect(body[body.findIndex(line => line.endsWith(" {")) + 1], name).toMatch(/^  if \(!FLEXIBLE_AVAILABLE\) return (?:refuse\("not-available"\)|pre\("not-available"\)|false);$/);
      }
    };
    gatedFirst("src/flexible-import.ts", ["readFlexibleCandidate", "importFlexibleCandidate", "removeFlexibleImportRefs", "flexibleTaskBranch", "settleInterruptedImport"], ["linkLeadsOut", "foldName"]);
    gatedFirst("src/flexible-ship.ts", ["flexibleShipTerms", "shipFlexible", "flexibleShipsOf", "mergeArmedFlexible", "reconcileFlexibleShips", "flexibleArmedPass", "cancelFlexibleShip", "sendBackFlexible", "removeFlexibleImport"], ["flexibleShipSummary"]);
    for (const one of product.filter(engine("flexible-import.ts", "flexible-ship.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-import\.js"/);
    // The Ship's one caller outside the engine: the watch loop's pass, and nothing else of it.
    for (const one of product.filter(engine("flexible-ship.ts"))) {
      const named = [...one.text.matchAll(/import \{([^}]*)\} from "\.\.?\/flexible-ship\.js"/g)].flatMap(match => match[1]!.split(",").map(name => name.trim()).filter(Boolean));
      expect(named, one.path).toEqual(one.path === join("src", "operate.ts") ? ["flexibleArmedPass"] : []);
    }
    for (const one of product.filter(engine("flexible-refs.ts", "flexible-thread.ts", "flexible-import.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-refs\.js"/);
  });

  test("the relay's upstream is a constant: one frozen list, the production origin fixed, no environment, mocked only by tests", () => {
    expect(Object.keys(upstreams)).toEqual(["FLEXIBLE_RELAY_UPSTREAMS"]);
    expect(Object.keys(upstreams.FLEXIBLE_RELAY_UPSTREAMS)).toEqual(["claude"]);
    const claude = upstreams.FLEXIBLE_RELAY_UPSTREAMS.claude;
    expect(claude.origin).toBe("https://api.anthropic.com");
    expect(claude.routes.map(one => one.path)).toEqual(["/v1/messages", "/v1/messages/count_tokens"]);
    for (const value of [upstreams.FLEXIBLE_RELAY_UPSTREAMS, claude, claude.routes, claude.auth, claude.passHeaders, claude.betas, claude.limits]) expect(Object.isFrozen(value)).toBe(true);
    const code = readFileSync("src/flexible-relay-upstreams.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*/gm, "");
    expect(code).not.toMatch(/process\.|import\s|require\(|globalThis|let\s|var\s/);
    expect(readFileSync("src/flexible-relay.ts", "utf8")).toMatch(/import \{ FLEXIBLE_RELAY_UPSTREAMS, [^}]*\} from "\.\/flexible-relay-upstreams\.js";/);
    for (const one of product) expect(one.text, one.path).not.toMatch(/vi\.mock\(["'][^"']*flexible-relay-upstreams/);
  });

  test("only a browser sign-in reaches the one Flexible route; no token, MCP tool or chat action names it", () => {
    const routes = ROUTES.filter(row => /flexible/i.test(row.id) || /flexible/i.test(row.pattern));
    expect(routes.map(row => ({ id: row.id, method: row.method, callers: row.callers }))).toEqual([{ id: "settings.project-flexible", method: "POST", callers: ["cookie"] }]);
    for (const one of product.filter(file => /(^|\/)(mcp[^/]*|lead-tools|chat-actions|chat-decide|team-http)\.ts$/.test(file.path))) expect(one.text, one.path).not.toMatch(/flexible/i);
  });
});
