/**
 * Interactive agent threads are off by default (flexible-available.ts: Settings → General's switch, no row reads off).
 * With the real module and a fresh store: every entry point that starts something new refuses with the off words and
 * writes nothing (a project's terms turned on, the start's card, a thread, a turn, an agent launch, the relay, a request,
 * an answer, Ship, a project's terms turned on), and no page offers threads; what settles, stops, turns down or reads
 * still works, so turning threads off can always clean up: a project's Flexible terms are shown, lowered and turned off
 * through the web and the CLI, never turned on. And the switch can't become an override: one table, read
 * and written only here, written only by a person's step-up in a transaction, every gated entry point checking it first.
 */
import { fakePid } from "../test/fake-pid.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Server } from "node:http";
import { PassThrough } from "node:stream";
import * as available from "./flexible-available.js";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { runOperate, EXIT } from "./operate.js";
import { createDecisionServer } from "./serve.js";
import { ROUTES } from "./server/route-table.js";
import { flexibleThreadCodexProfile, flexibleThreadFence, flexibleThreadSpawn, prepareFlexibleThread, stopFlexibleThreadAgent } from "./flexible-thread.js";
import { admitFlexibleTurn, beginFlexibleTurn, setFlexibleInstallationCaps, withdrawFlexibleTurn } from "./flexible-turns.js";
import { startFlexibleTurn } from "./flexible-agents.js";
import { startFlexibleRelay } from "./flexible-relay.js";
import { decideFlexibleAnswer, recordFlexibleRequest, sendFlexibleAnswer, type FlexibleAnswerCatalog } from "./flexible-answers.js";
import { answerFlexibleRequest, attachFlexibleAgent, beginFlexibleThreadTurn, startFlexibleThread, startFlexibleThreadSession, type FlexibleSessions } from "./flexible-session.js";
import { flexibleStartCard } from "./flexible-start.js";
import * as upstreams from "./flexible-relay-upstreams.js";
import { mergeArmedFlexible } from "./flexible-ship.js";
import { enableFlexible, flexibleDelegationAtUse, flexibleDigestOf, flexibleSettingsView, flexibleTermsJson, FLEXIBLE_UNAVAILABLE, turnFlexibleOff, type FlexibleTerms } from "./flexible.js";

const NOW = new Date();
const OFF = "Interactive agent threads are off: Settings → General, or `toolroll config set flexible on`.";
const refused = { ok: false, reason: "not-available", message: OFF };
let dir: string, repo: string, db: string, store: Store;
const tokens: Record<string, string> = {};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flexible-off-")));
  repo = join(dir, "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "first"], { cwd: repo });
  db = join(dir, "orders.db");
  store = openStore(db);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  tokens["alex"] = alex.token;
  store.upsertProject(repo, "shop", NOW);
  const made = store.createConsoleTask({ title: "known", repo, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, NOW);
  if (!made.ok) throw new Error(made.reason);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** Terms planted as if threads had been on when they were signed: nothing new starts while threads are off. */
function plant(): string {
  const terms: FlexibleTerms = { version: 1, repo, signer: "alex", signerGeneration: store.accountOf("alex")!.generation, starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
  const digest = flexibleDigestOf(terms);
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(repo, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  return digest;
}
const sha = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
/** A ready thread and its admitted turn, planted as if threads had been on when they were made. */
function plantThread(id: string, turn: string, digest: string): void {
  store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'alex', ?, 'ready')`)
    .run(id, repo, sha(), `refs/toolroll/threads/${id}/base`, join(dir, "threads", id), NOW.toISOString());
  store.handle.prepare(`INSERT INTO thread_turn (id, thread, seq, repo, owner, owner_generation, terms_id, terms_digest, level, provider, model, billing, request_key, holder, admitted_at, utc_day, status)
    VALUES (?, ?, 1, ?, 'alex', 1, 1, ?, 'full', 'claude', 'claude-sonnet-4-5', 'subscription', 'm-0', 'h1', ?, ?, 'admitted')`).run(turn, id, repo, digest, NOW.toISOString(), NOW.toISOString().slice(0, 10));
}
const counts = (...tables: string[]) => tables.map(table => store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!["n"]);
const TABLES = ["flexible_thread", "thread_turn", "thread_decision", "flexible_thread_launch", "flexible_relay_grant", "flexible_thread_level", "flexible_ship", "flexible_installation_caps", "thread_relay_call"];

describe("off by default", () => {
  test("a fresh install has no row and reads off; the off words say where to turn them on", () => {
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_setting").get()!["n"]).toBe(0);
    expect(available.flexibleAvailable(store)).toBe(false);
    expect(FLEXIBLE_UNAVAILABLE).toBe(OFF);
  });

  test("every entry point that starts something new refuses and writes nothing; turned on, the same calls get past the switch", async () => {
    const digest = plant();
    const id = "a".repeat(32), turn = "c".repeat(32);
    plantThread(id, turn, digest);
    const before = counts(...TABLES);
    const terms = store.handle.prepare("SELECT * FROM flexible_terms").all().map(row => ({ ...row }));
    const by = { name: "alex", generation: store.accountOf("alex")!.generation };
    const marker = join(dir, "ran");
    const launch = { id, network: { proxyPort: 41_000, token: "t" }, storage: { names: [], denies: [] } };
    // Hosts, catalogs and streams handed in anyway are never touched.
    const touched: string[] = [];
    const untouchable = <T extends object>(name: string) => new Proxy({}, { get: (_target, key) => { touched.push(`${name}.${String(key)}`); throw new Error("touched"); } }) as T;
    const catalog = untouchable<FlexibleAnswerCatalog>("catalog"), sessions = untouchable<FlexibleSessions>("sessions");
    const connection = { id: "b".repeat(32), frame: () => { touched.push("frame"); return new Uint8Array(1); }, send: async () => { touched.push("send"); return { written: 1, complete: true }; } };
    const stdout = new PassThrough(), stdin = new PassThrough();
    stdout.on("newListener", event => touched.push(`stdout:${String(event)}`));
    const launcher = { prepare: async () => { touched.push("prepare"); return { ok: true as const, network: { proxyPort: 1, token: "t", proxyEnv: {}, close: () => {} }, storage: { names: [], denies: [] } }; },
      open: () => 0, close: async () => { touched.push("close"); } };
    const off: Record<string, unknown> = {
      enableFlexible: enableFlexible(store, { repo, by: "alex", proof: "password-now", shownDigest: digest, now: NOW }),
      flexibleDelegationAtUse: flexibleDelegationAtUse(store, { repo, starter: by, digest, level: "supervised", freshProof: true }),
      flexibleStartCard: flexibleStartCard(store, { repo, by, model: null, message: "hello" }),
      prepareFlexibleThread: await prepareFlexibleThread(store, { repo, base: "HEAD", by: "alex", now: NOW }),
      flexibleThreadFence: flexibleThreadFence(store, launch),
      flexibleThreadSpawn: await flexibleThreadSpawn(store, { ...launch, proxyEnv: {}, launch: { provider: "claude", level: "full", turn: null, holder: "h1" }, beforeOpen: () => null }, "/bin/sh", ["-c", `echo ran > ${marker}`]),
      flexibleThreadCodexProfile: flexibleThreadCodexProfile(store, launch),
      admitFlexibleTurn: admitFlexibleTurn(store, { thread: id, starter: by, digest, level: "full", freshProof: true, provider: "claude", model: "claude-sonnet-4-5", billing: "subscription", requestKey: "m-1", holder: "h1", clock: () => NOW }),
      beginFlexibleTurn: beginFlexibleTurn(store, { turn, holder: "h1", clock: () => NOW }),
      setFlexibleInstallationCaps: setFlexibleInstallationCaps(store, { by: "alex", caps: { liveThreads: 1, turnsPerDay: null, measuredMicrousdPerDay: null } as never, clock: () => NOW }),
      startFlexibleTurn: await startFlexibleTurn(store, { turn, holder: "h1", clock: () => NOW, network: { proxyPort: 41_000, token: "t", proxyEnv: {}, close: () => {} },
        relay: { url: "http://127.0.0.1:1", port: 1, issue: () => ({ url: "http://127.0.0.1:1", token: "r", revoke: () => {} }) }, storage: { names: [], denies: [] } }),
      startFlexibleRelay: await startFlexibleRelay(store, { thread: id }),
      recordFlexibleRequest: recordFlexibleRequest(store, catalog, { thread: id, turn, connection: connection.id, holder: "h1", requestRef: "r1", kind: "permission", card: { title: "Allow?" } }),
      decideFlexibleAnswer: decideFlexibleAnswer(store, catalog, { request: "d".repeat(32), token: "0".repeat(64), shownDigest: "1".repeat(64), by: { kind: "person", ...by }, decision: "accept" }),
      sendFlexibleAnswer: await sendFlexibleAnswer(store, catalog, { request: "d".repeat(32), connection, holder: "h1" }),
      mergeArmedFlexible: await mergeArmedFlexible(store, { taskId: `flexible-${"e".repeat(32)}`, root: join(dir, "evidence") }),
      startFlexibleThreadSession: await startFlexibleThreadSession(store, sessions, { thread: id }),
      attachFlexibleAgent: attachFlexibleAgent(store, sessions, { thread: id, turn, launch: "b".repeat(32), stdout, stdin, exited: () => { touched.push("exited"); } }),
      beginFlexibleThreadTurn: await beginFlexibleThreadTurn(store, sessions, { turn, message: "hello", launcher }),
      startFlexibleThread: await startFlexibleThread(store, sessions, { repo, by, digest, message: "hello", model: "claude-sonnet-4-5", billing: "subscription", startKey: "5".repeat(32), launcher }),
      answerFlexibleRequest: await answerFlexibleRequest(store, sessions, { held: () => true, thread: id, request: "d".repeat(32), shownDigest: "1".repeat(64), by: { kind: "person", ...by }, choice: { decision: "accept" } }),
    };
    for (const [name, result] of Object.entries(off)) expect(result, name).toEqual(refused);
    // A read: the planted terms still show, with no way to turn them on.
    expect(flexibleSettingsView(store, repo, { name: "alex", canChange: true })).toMatchObject({ standing: { state: "on" }, proposal: { problem: OFF } });
    expect(touched).toEqual([]);
    expect(stdin.writableLength).toBe(0);
    expect(counts(...TABLES)).toEqual(before);
    expect(store.handle.prepare("SELECT * FROM flexible_terms").all().map(row => ({ ...row }))).toEqual(terms);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, "threads"))).toBe(false);
    expect(existsSync(`${db}.coding.sqlite`)).toBe(false);
    // The real switch, turned on: the same calls get past it (their own checks answer instead); off again, refused again.
    available.setFlexibleSetting(store, true, "alex", NOW);
    expect(enableFlexible(store, { repo, by: "alex", proof: "password-now", shownDigest: "0".repeat(32), now: NOW })).not.toMatchObject({ reason: "not-available" });
    expect(flexibleStartCard(store, { repo, by, model: "gpt-5", message: "hello" })).toMatchObject({ ok: false, reason: "invalid-request" });
    expect(flexibleThreadCodexProfile(store, launch)).toMatchObject({ ok: false, reason: "codex-unsupported" });
    expect(flexibleSettingsView(store, repo, { name: "alex", canChange: true })).toBeDefined();
    available.setFlexibleSetting(store, false, "alex", NOW);
    expect(flexibleStartCard(store, { repo, by, model: null, message: "hello" })).toEqual(refused);
    expect(flexibleThreadCodexProfile(store, launch)).toEqual(refused);
  });

  test("what settles or stops what exists never checks the switch: turning threads off can always clean up", async () => {
    const digest = plant();
    const id = "a".repeat(32), turn = "c".repeat(32);
    plantThread(id, turn, digest);
    store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
      VALUES (?, ?, 'claude', 'full', ?, 'h1', 'here', ?, ${fakePid(1)}, 't1', 'live', ?)`).run("e".repeat(32), id, "f".repeat(32), "9".repeat(32), NOW.toISOString());
    expect(withdrawFlexibleTurn(store, { turn, holder: "h1", detail: "turned off", clock: () => NOW })).toEqual({ ok: true });
    expect(await stopFlexibleThreadAgent(store, { id, reason: "threads turned off", clock: () => NOW })).not.toMatchObject({ reason: "not-available" });
    expect(turnFlexibleOff(store, { repo, by: "alex", now: NOW })).toMatchObject({ ok: true, changed: true });
    // The installation's own limits: tightened while off, never loosened.
    const caps = (liveThreads: number | null) => setFlexibleInstallationCaps(store, { by: "alex", caps: { liveThreads, turnsPerDay: 10, measuredMicrousdPerDay: 1_000_000 }, clock: () => NOW });
    expect(caps(2)).toMatchObject({ ok: true });
    expect(caps(1)).toMatchObject({ ok: true });
    expect(caps(3)).toEqual(refused);
    expect(caps(null)).toEqual(refused);
    expect(store.handle.prepare("SELECT live_threads FROM flexible_installation_caps").get()!["live_threads"]).toBe(1);
  });

  test("the CLI with threads off: show, lower and off work; enable is refused", async () => {
    const cli = async (action: string, more: string[] = []) => {
      const lines: string[] = [];
      const code = await runOperate("project", ["flexible", action, "--repo", repo, "--json", ...(action === "show" ? [] : ["--as", "alex", "--token", tokens["alex"]!]), ...more],
        line => lines.push(line), { databaseFile: db });
      return { code, out: JSON.parse(lines.join("\n")) as Record<string, unknown> };
    };
    // A project with no terms: show says Secure; enable is refused and writes nothing.
    expect(await cli("show")).toMatchObject({ code: EXIT.ok, out: { ok: true, flexible: { state: "secure" } } });
    const digest = plant();
    expect(await cli("show")).toMatchObject({ code: EXIT.ok, out: { ok: true, flexible: { state: "on", digest } } });
    expect(await cli("enable", ["--digest", digest])).toMatchObject({ code: EXIT.refused, out: { ok: false, reason: "not-available", message: OFF } });
    expect(await cli("lower", ["--max", "auto"])).toMatchObject({ code: EXIT.ok, out: { ok: true, changed: true } });
    expect(await cli("show")).toMatchObject({ code: EXIT.ok, out: { flexible: { state: "on", terms: { max: "auto" } } } });
    expect(await cli("off")).toMatchObject({ code: EXIT.ok, out: { ok: true, changed: true, flexible: { state: "secure" } } });
    expect(store.handle.prepare("SELECT ended_at FROM flexible_terms").all().every(row => row["ended_at"] !== null)).toBe(true);
    expect(await cli("enable", ["--digest", digest])).toMatchObject({ code: EXIT.refused, out: { reason: "not-available" } });
    expect(await cli("show")).toMatchObject({ code: EXIT.ok, out: { flexible: { state: "secure" } } });
  });

  test("a project with no terms shows none; one with terms can be lowered and turned off, never turned on; every thread road refuses", async () => {
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
      const post = (fields: Record<string, string>) => fetch(`${base}/settings/project/flexible`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, repo, ...fields }), redirect: "manual" });
      const said = (answer: Response) => decodeURIComponent(answer.headers.get("location") ?? "").replace(/\+/g, " ");
      // With terms: the page shows them with Lower and Turn off, and no way to turn them on.
      const shown = await (await fetch(`${base}/settings/project?repo=${encodeURIComponent(repo)}`, { headers: { cookie } })).text();
      expect(shown).toContain('id="flexible"');
      expect(shown).toContain("Turn off Flexible");
      expect(shown).toContain('value="lower"');
      expect(shown).not.toContain('value="enable"');
      const enable = await post({ action: "enable", digest, password: tokens["alex"]! });
      expect(enable.status).toBe(403);
      expect(await enable.text()).toContain("Interactive agent threads are off");
      expect(said(await post({ action: "lower", max: "auto" }))).toContain("Lowered to");
      expect(JSON.parse(String(store.handle.prepare("SELECT terms_json FROM flexible_terms WHERE ended_at IS NULL").get()!["terms_json"]))).toMatchObject({ max: "auto" });
      expect(said(await post({ action: "off" }))).toContain("Secure again");
      expect(store.handle.prepare("SELECT ended_at FROM flexible_terms").all().every(row => row["ended_at"] !== null)).toBe(true);
      expect((await post({ action: "enable", digest, password: tokens["alex"]! })).status).toBe(403);
      expect(store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_terms WHERE ended_at IS NULL").get()!["n"]).toBe(0);
      // The reads answer (nothing was ever made here, so no host opens for them); everything that starts or answers refuses.
      expect(await (await fetch(`${base}/agents/live/threads`, { headers: { cookie } })).json()).toEqual({ version: 1, on: false, threads: [] });
      expect(await (await fetch(`${base}/agents/live/thread/${"a".repeat(32)}`, { headers: { cookie } })).json()).toEqual({ error: "thread" });
      for (const [path, fields] of [[`/agents/live/thread/${"a".repeat(32)}/answer`, { request: "d".repeat(32), card: "1".repeat(64), decision: "accept" }], ["/agents/live/thread", { repo, message: "hello", terms: digest }],
        ["/agents/live/thread", { repo, message: "hello" }]] as const) {
        const answer = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
        expect(answer.status, path).toBe(404);
        expect(await answer.json(), path).toEqual({ outcome: "refused", words: OFF });
      }
      // No thread host was opened for an install that never had one: no coding catalog beside the database.
      expect(existsSync(`${db}.coding.sqlite`)).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe("the switch can't become an override", () => {
  const sources = (root: string): { path: string; text: string }[] => readdirSync(root, { withFileTypes: true, recursive: true })
    .filter(one => one.isFile() && /\.(ts|tsx|mts)$/.test(one.name))
    .map(one => { const path = join(one.parentPath, one.name); return { path: relative(".", path), text: readFileSync(path, "utf8") }; });
  const product = sources("src").filter(one => !/\.test\.tsx?$/.test(one.path));
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*/gm, "");

  test("one table, read and written only by flexible-available.ts (the store only makes and checks it); no environment, config or request reads it", () => {
    expect(Object.keys(available).sort()).toEqual(["FLEXIBLE_SETTING_ACTION", "flexibleAvailable", "flexibleSetting", "setFlexibleSetting"]);
    const own = code(readFileSync("src/flexible-available.ts", "utf8"));
    expect(own).not.toMatch(/process\.|import\s(?!type)|require\(|globalThis/);
    expect([...own.matchAll(/(?:FROM|INTO)\s+(\w+)/g)].map(match => match[1])).toEqual(["flexible_setting", "flexible_setting", "flexible_setting"]);
    const naming = product.filter(one => /flexible_setting\b/.test(code(one.text))).map(one => one.path).sort();
    expect(naming).toEqual([join("src", "flexible-available.ts"), join("src", "flexible-setting-schema.ts"), join("src", "store.ts")].sort());
    for (const one of product) {
      expect(one.text, one.path).not.toMatch(/process\.env(?:\[["'`]|\.)[A-Z_]*FLEXIBLE/i);
      expect(one.text, one.path).not.toMatch(/vi\.mock\(["'][^"']*flexible-available/);
      expect(one.text, one.path).not.toMatch(/FLEXIBLE_AVAILABLE/);
    }
  });

  test("only a person's step-up writes it: the Settings route and the CLI twin, each proving and writing in one transaction", () => {
    const writers = product.filter(one => /\bsetFlexibleSetting\(/.test(code(one.text)) && one.path !== join("src", "flexible-available.ts")).map(one => one.path).sort();
    expect(writers).toEqual([join("src", "operate.ts"), join("src", "server", "settings.ts")].sort());
    // On is a credential act (a password typed now, every install); off the ordinary step-up or the laptop owner's act.
    expect(readFileSync("src/server/settings.ts", "utf8")).toMatch(/const saved = store\.transact\(\(\): boolean => \{\n {6}if \(!store\.isInstanceOperator\(who\.name\)\) return false;\n {6}if \(wanted === "on"\) \{\n {8}if \(!authenticateCredential\(who, body\.get\("password"\) \?\? ""\)\.ok\) return false;\n {6}\} else \{\n {8}if \(who\.authority !== "full" && localActNow\(store, "flexible-switch"\) === null\) return false;\n {8}if \(!authenticateApprover\(who, body\.get\("password"\) \?\? ""\)\.ok\) return false;\n {6}\}\n {6}setFlexibleSetting\(store, wanted === "on", who\.name, now\);/);
    expect(readFileSync("src/operate.ts", "utf8")).toMatch(/const saved = store\.transact\(\(\) => \{\n[^\n]*\n {4}const verified = value === "on" \? credentialApprover\(store, acting\.name, acting\.token\) : authenticateApprover\(store, acting\.name, acting\.token\);\n {4}if \(!verified\.ok \|\| !personProof\(verified\.method\) \|\| !store\.isInstanceOperator\(acting\.name\)\) return false;\n {4}setFlexibleSetting\(store, value === "on", acting\.name, clock\(\)\);/);
    // Every write is a browser sign-in's only (the change document is a page that reads); no token, MCP tool or chat
    // action reaches the switch or a project's terms.
    const writes = ROUTES.filter(row => row.method !== "GET" && (/flexible/i.test(row.id) || /flexible/i.test(row.pattern)));
    expect(writes.map(row => ({ id: row.id, method: row.method, callers: row.callers }))).toEqual([
      { id: "settings.project-flexible", method: "POST", callers: ["cookie"] }, { id: "settings.flexible", method: "POST", callers: ["cookie"] }]);
    for (const one of product.filter(file => /(^|\/)(mcp[^/]*|lead-tools|chat-actions|chat-decide|team-http)\.ts$/.test(file.path))) expect(one.text, one.path).not.toMatch(/flexible/i);
  });

  test("every engine entry point is decided: one that starts something new checks the switch first; one that settles, stops, narrows or reads never does", () => {
    /** Every exported function of `file` is gated (its first statement is the check) or named as not checking it. */
    const decided = (file: string, gated: readonly string[], others: readonly string[]) => {
      const text = readFileSync(file, "utf8");
      expect([...text.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]!).sort(), file).toEqual([...gated, ...others].sort());
      for (const name of gated) {
        const body = text.slice(text.search(new RegExp(`^export (?:async )?function ${name}(?:<[^>]*>)?\\(`, "m"))).split("\n");
        expect(body[body.findIndex(line => line.endsWith(" {")) + 1], name).toMatch(/^ {2}if \(!flexibleAvailable\(store\)\) return (?:refuse\("not-available"\)|pre\("not-available"\)|undefined);$/);
      }
    };
    decided("src/flexible.ts", ["enableFlexible", "flexibleDelegationAtUse"],
      ["flexibleSettingsView", "flexibleCeilingAllows", "flexibleTermsJson", "flexibleDigestOf", "flexibleTermsFromJson", "flexibleNarrowerOrEqual", "flexibleTermsWords", "flexibleNetworkOf", "flexibleTwoPerson", "flexibleStanding",
        "proposedFlexibleTerms", "lowerFlexible", "turnFlexibleOff", "endLapsedFlexible"]);
    decided("src/flexible-thread.ts", ["prepareFlexibleThread", "flexibleThreadFence", "flexibleThreadSpawn", "flexibleThreadCodexProfile"],
      ["flexibleThreadPaths", "flexibleThread", "removeFlexibleThread", "threadCredentialPaths", "flexibleThreadEnv", "withFlexibleThreadLock", "flexibleFenceDigest", "stopFlexibleThreadAgent", "flexibleProjectKnown"]);
    expect(readFileSync("src/flexible-turns.ts", "utf8")).toMatch(/const before = flexibleInstallationCaps\(store\);\n[^\n]*\n {4}if \(!flexibleAvailable\(store\) && !\(tighter\(/);
    decided("src/flexible-turns.ts", ["admitFlexibleTurn", "beginFlexibleTurn"],
      ["setFlexibleInstallationCaps", "flexibleTurn", "flexibleInstallationCaps", "chargeFlexibleTurn", "finishFlexibleTurn", "interruptFlexibleTurnsOf", "withdrawFlexibleTurn", "interruptFlexibleThreadTurns", "withdrawFlexibleTurnsAbove",
        "interruptFlexibleTurnSignIn"]);
    decided("src/flexible-agents.ts", ["startFlexibleTurn"], ["flexibleAgentLaunch", "lowerFlexibleThreadLevel", "recoverFlexibleLaunchesOf"]);
    decided("src/flexible-relay.ts", ["startFlexibleRelay"], ["relayUrlInside"]);
    // Saving your own sign-in starts something new (its transaction A checks the switch first, and again inside);
    // removing, retiring, tidying, a restore's reset and every read never do, so off can always clean up.
    decided("src/flexible-sign-in.ts", ["stageFlexibleSignIn"], ["setupTokenFromPaste", "placeFlexibleSignIn", "activateFlexibleSignIn", "saveFlexibleSignIn", "removeFlexibleSignIn", "resetFlexibleSignInsForRestore",
      "tidyFlexibleSignIns", "flexibleSignInStatus", "flexibleSignInBilling", "signInForTurn", "signInStandsAt"]);
    // Any answer reaching an agent continues its turn, so none goes while off (a decline included: the switch's stop
    // withdraws every open request instead).
    decided("src/flexible-answers.ts", ["recordFlexibleRequest", "decideFlexibleAnswer", "sendFlexibleAnswer"],
      ["streamAnswerSender", "openFlexibleAnswerCatalog", "decideFlexibleAnswerByPolicy", "cancelFlexibleAnswer", "revokeFlexibleAnswers", "ackFlexibleAnswer", "noteFlexibleToolActivity", "expireFlexibleAnswers",
        "recoverFlexibleAnswersOf", "recordFlexibleProviderDecision", "flexibleRequestsOf"]);
    decided("src/flexible-session.ts", ["startFlexibleThreadSession", "attachFlexibleAgent", "beginFlexibleThreadTurn", "startFlexibleThread", "answerFlexibleRequest"],
      ["openFlexibleSessions", "closeFlexibleSessions", "flexibleWorkOpen", "flexibleThreadsExist", "settleFlexibleStops", "stopFlexibleThreadsEverywhere", "tickFlexibleSessions", "recoverFlexibleHolders", "stopFlexibleThreadSession", "endFlexibleThreadTurn",
        "lowerFlexibleThreadSession", "flexibleThreadLiveOf", "flexibleThreadsOf", "admitFlexibleThreadOwner", "flexibleThreadChangeOf", "waitFlexibleThreadChange"]);
    // Inspecting a candidate and its quarantined import are a person's recovery of past work: never gated.
    decided("src/flexible-import.ts", [], ["readFlexibleCandidate", "importFlexibleCandidate", "foldName", "linkLeadsOut", "removeFlexibleImportRefs", "flexibleTaskBranch", "settleInterruptedImport"]);
    decided("src/flexible-ship.ts", ["mergeArmedFlexible"],
      ["flexibleShipTerms", "shipFlexible", "flexibleShipSummary", "flexibleShipsOf", "reconcileFlexibleShips", "flexibleArmedPass", "cancelFlexibleShip", "sendBackFlexible", "removeFlexibleImport"]);
    decided("src/flexible-start.ts", ["flexibleStartCard"], []);
    decided("src/flexible-launcher.ts", [], ["flexibleThreadNetwork", "flexibleNetworkDigest", "createFlexibleLauncher"]);
    // The thread start reads it again inside the transaction that records the thread; each model call through the relay
    // reads it inside its own reservation transaction.
    expect(readFileSync("src/flexible-session.ts", "utf8")).toMatch(/reserve: id => \{[^]*?\n {6}if \(!flexibleAvailable\(store\)\) return refuse\("not-available"\);\n {6}const billing = flexibleSignInBilling\(store, input\.by\);/);
    expect(readFileSync("src/flexible-relay.ts", "utf8")).toMatch(/store\.transact\(\(\) => \{\n[^\n]*\n {10}if \(!flexibleAvailable\(store\)\) \{ blocked = "threads-off"; return; \}\n {10}if \(!grantStillLive/);
    // The surfaces: a project's terms are turned on only with the switch on (the route and the CLI check it on `enable`
    // alone; lower, off and show never), and every thread road checks it before anything is looked up.
    const settingsRoute = readFileSync("src/server/settings.ts", "utf8");
    expect(settingsRoute).toMatch(/if \(action !== "enable"\) return back\([^\n]*\n {4}if \(!flexibleAvailable\(store\)\) return refuse/);
    expect(settingsRoute.match(/flexibleAvailable\(/g)).toHaveLength(1); // the enable gate, nothing else
    const cliText = readFileSync("src/operate.ts", "utf8");
    expect(cliText).toMatch(/if \(action === "enable"\) \{\n {4}if \(!flexibleAvailable\(store\)\) return fail\(write, json, command, "not-available"/);
    const projectCli = cliText.slice(cliText.indexOf("async function projectFlexibleCommand("), cliText.indexOf("async function taskSizingConfig("));
    expect(projectCli.match(/flexibleAvailable\(/g)).toHaveLength(1);
    const engineApi = readFileSync("src/server/engine-api.ts", "utf8");
    expect(engineApi).toMatch(/const threadsOn = \(\): FlexibleSessions \| null => flexibleAvailable\(store\) \? openHost\(\) : null;/);
    // Turned off mid-thread: the console's upkeep tick (every five seconds) stops what this host still holds.
    expect(engineApi).toMatch(/upkeep: \(\): void => \{[^]*?void settleFlexibleStops\(store, host\)/);
    // Ship: arming, completing and the merge's reservation each read the switch inside their own transaction.
    const ship = readFileSync("src/flexible-ship.ts", "utf8");
    expect(ship).toMatch(/return store\.transact\(\(\) => \{\n(?: {6}\/\/[^\n]*\n)+ {6}if \(!flexibleAvailable\(store\)\) throw new ShipStop\(refuse\("not-available"\)\);\n {6}const row = store\.handle\.prepare\("SELECT state FROM flexible_ship WHERE id = \?"\)/);
    expect(ship).toMatch(/store\.transact\(\(\) => \{\n {8}\/\/[^\n]*\n {8}if \(!flexibleAvailable\(store\)\) throw new ShipStop\(refuse\("not-available"\)\);\n {8}const again = rowOfTask/);
    expect(ship).toMatch(/function reserveMerge\([^\n]*\n(?: {2}\/\/[^\n]*\n)+ {2}if \(!flexibleAvailable\(store\)\) return false;/);
    // A launch's start gate opens only through its final reservation: the switch and the caller's re-check in one
    // transaction, and the re-check is required.
    expect(readFileSync("src/flexible-launch.ts", "utf8")).toMatch(/export function reserveLaunchOpen\([^\n]*\n {2}return store\.transact\(\(\): string \| null => \{\n {4}if \(!flexibleAvailable\(store\)\) return "interactive agent threads were turned off";\n {4}const why = input\.check\(\);/);
    const threadEngine = readFileSync("src/flexible-thread.ts", "utf8");
    expect(threadEngine).toMatch(/\n {2}beforeOpen: \(\) => string \| null;/);
    expect(threadEngine).toMatch(/shut = reserveLaunchOpen\(store, \{ launch: record\.id, thread: input\.id, turn: input\.launch\.turn, check: input\.beforeOpen \}\);/);
    expect(threadEngine).not.toMatch(/recordLaunchOpened/);
    expect(readFileSync("src/serve.ts", "utf8")).toMatch(/const flushBudget = \(\) => \{[^\n]*engineHandlers\.upkeep\(\); \};\n {4}const timer = setInterval\(flushBudget, REQUEST_BUDGET_FLUSH_MS\);/);
    // The roads that start or answer check it before anything is looked up; the person's reads of their own threads don't.
    for (const name of ["threadAnswer", "threadStart"]) {
      expect(engineApi, name).toMatch(new RegExp(`async function ${name}\\(ctx: HandlerContext\\): Promise<void> \\{\\n[^\\n]*\\n(?:[^\\n]*\\n)?    const flexible = threadsOn\\(\\);\\n    if \\(flexible === null\\) return `));
    }
    for (const name of ["liveThread", "liveThreads"]) expect(engineApi.slice(engineApi.indexOf(`async function ${name}(`)).split("\n  }\n")[0], name).toMatch(/const flexible = threadsRead\(\);/);
  });

  test("the relay's upstream is a constant: one frozen list, the production origin fixed, no environment, mocked only by tests", () => {
    expect(Object.keys(upstreams)).toEqual(["FLEXIBLE_RELAY_UPSTREAMS"]);
    expect(Object.keys(upstreams.FLEXIBLE_RELAY_UPSTREAMS)).toEqual(["claude"]);
    const claude = upstreams.FLEXIBLE_RELAY_UPSTREAMS.claude;
    expect(claude.origin).toBe("https://api.anthropic.com");
    expect(claude.routes.map(one => one.path)).toEqual(["/v1/messages", "/v1/messages/count_tokens"]);
    for (const value of [upstreams.FLEXIBLE_RELAY_UPSTREAMS, claude, claude.routes, claude.auth, claude.passHeaders, claude.betas, claude.limits]) expect(Object.isFrozen(value)).toBe(true);
    const text = code(readFileSync("src/flexible-relay-upstreams.ts", "utf8"));
    expect(text).not.toMatch(/process\.|import\s|require\(|globalThis|let\s|var\s/);
    expect(readFileSync("src/flexible-relay.ts", "utf8")).toMatch(/import \{ FLEXIBLE_RELAY_UPSTREAMS, [^}]*\} from "\.\/flexible-relay-upstreams\.js";/);
    for (const one of product) expect(one.text, one.path).not.toMatch(/vi\.mock\(["'][^"']*flexible-relay-upstreams/);
  });

  test("the thread engine's modules are reached only through their own doors", () => {
    const engine = (...names: string[]) => (file: { path: string }) => !names.map(name => join("src", name)).includes(file.path);
    for (const one of product.filter(engine("flexible-thread.ts", "flexible-agents.ts", "flexible-session.ts", "flexible-import.ts", "flexible-ship.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-thread\.js"/);
    for (const one of product.filter(engine("flexible-agents.ts", "flexible-session.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-agents\.js"/);
    for (const one of product.filter(engine("flexible-relay.ts", "flexible-agents.ts", "flexible-session.ts", "flexible-start.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-relay\.js"/);
    for (const one of product.filter(engine("flexible-answers.ts", "flexible-session.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-answers\.js"/);
    for (const one of product.filter(engine("flexible-session.ts", join("server", "engine-api.ts"), "operate.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/(?:\.\.\/)?flexible-session\.js"/);
    // The CLI's switch-off reaches the thread host's module only for the stop.
    expect([...readFileSync("src/operate.ts", "utf8").matchAll(/import \{([^}]*)\} from "\.\/flexible-session\.js"/g)].map(match => match[1]!.trim())).toEqual(["stopFlexibleThreadsEverywhere"]);
    for (const one of product.filter(engine("flexible-launcher.ts", "flexible-session.ts", "flexible-start.ts", join("server", "engine-api.ts")))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/(?:\.\.\/)?flexible-launcher\.js"/);
    for (const one of product.filter(engine("flexible-start.ts", join("server", "engine-api.ts")))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/(?:\.\.\/)?flexible-start\.js"/);
    for (const one of product.filter(engine("flexible-import.ts", "flexible-ship.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-import\.js"/);
    for (const one of product.filter(engine("flexible-ship.ts"))) {
      const named = [...one.text.matchAll(/import \{([^}]*)\} from "\.\.?\/flexible-ship\.js"/g)].flatMap(match => match[1]!.split(",").map(name => name.trim()).filter(Boolean));
      expect(named, one.path).toEqual(one.path === join("src", "operate.ts") ? ["flexibleArmedPass"] : []);
    }
  });
});
