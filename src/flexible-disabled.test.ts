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
import { flexibleAgentLaunch, lowerFlexibleThreadLevel, recoverFlexibleLaunchesOf, startFlexibleRelayStub, startFlexibleTurn } from "./flexible-agents.js";
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
    // F2c: stopping a thread's agent, starting a turn, lowering a level, recovering a holder's launches, building an
    // agent's launch and the relay's stand-in all refuse too, and nothing is launched, recorded or listened on.
    store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, leader_pid, leader_start, state, started_at)
      VALUES (?, ?, 'claude', 'full', ?, 'h1', 'here', ?, ${fakePid(1)}, 't1', 'live', ?)`).run("e".repeat(32), id, "f".repeat(32), "9".repeat(32), NOW.toISOString());
    const launchesBefore = store.handle.prepare("SELECT * FROM flexible_thread_launch").all().map(row => ({ ...row }));
    expect(await stopFlexibleThreadAgent(store, { id, reason: "test", clock: () => NOW })).toEqual(refused);
    expect(await startFlexibleTurn(store, { turn: "c".repeat(32), holder: "h1", clock: () => NOW, network: { proxyPort: 41_000, token: "t", proxyEnv: {}, close: () => {} },
      relay: { url: "http://127.0.0.1:1", issue: () => ({ url: "http://127.0.0.1:1", token: "r", revoke: () => {} }) }, storage: { names: [], denies: [] } })).toEqual(refused);
    let locked = false;
    expect(await withFlexibleThreadLock(id, async () => { locked = true; })).toEqual(refused);
    expect(locked).toBe(false);
    expect(await lowerFlexibleThreadLevel(store, { thread: id, by: { name: "alex", generation: store.accountOf("alex")!.generation }, level: "supervised", clock: () => NOW })).toEqual(refused);
    expect(await recoverFlexibleLaunchesOf(store, { holder: "h1", clock: () => NOW })).toEqual(refused);
    expect(flexibleAgentLaunch("claude", "full", { model: "claude-sonnet-4-5", relay: { url: "http://127.0.0.1:1", token: "r" }, configHome: join(dir, "home") })).toEqual(refused);
    expect(await startFlexibleRelayStub(store)).toEqual(refused);
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
    // server/engine-api.ts: the LiveSession's thread road refuses before anything is looked up while it is false.
    expect(users.map(one => one.path).sort()).toEqual([join("src", "flexible.ts"), join("src", "flexible-thread.ts"), join("src", "flexible-turns.ts"), join("src", "flexible-agents.ts"), join("src", "operate.ts"), join("src", "server", "engine-api.ts"), join("src", "server", "settings.ts")].sort());
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
    for (const one of product.filter(engine("flexible-thread.ts", "flexible-agents.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-thread\.js"/);
    for (const one of product.filter(engine("flexible-agents.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-agents\.js"/);
    for (const one of product.filter(engine("flexible-launch.ts", "flexible-thread.ts", "flexible-agents.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-launch\.js"/);
    for (const one of product.filter(engine("flexible-custody.ts", "flexible-launch.ts", "flexible-thread.ts", "flexible-agents.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-custody\.js"/);
    for (const one of product.filter(engine("flexible-levels.ts", "flexible-turns.ts", "flexible-agents.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-levels\.js"/);
    // The thread start (F2c): every entry point checks the constant first.
    const agents = readFileSync("src/flexible-agents.ts", "utf8");
    const starters = ["startFlexibleRelayStub", "flexibleAgentLaunch", "startFlexibleTurn", "lowerFlexibleThreadLevel", "recoverFlexibleLaunchesOf"];
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
    for (const one of product.filter(engine("flexible-turns.ts", "flexible-launch.ts", "flexible-thread.ts", "flexible-agents.ts"))) expect(one.text, one.path).not.toMatch(/from "\.\.?\/flexible-turns\.js"/);
  });

  test("only a browser sign-in reaches the one Flexible route; no token, MCP tool or chat action names it", () => {
    const routes = ROUTES.filter(row => /flexible/i.test(row.id) || /flexible/i.test(row.pattern));
    expect(routes.map(row => ({ id: row.id, method: row.method, callers: row.callers }))).toEqual([{ id: "settings.project-flexible", method: "POST", callers: ["cookie"] }]);
    for (const one of product.filter(file => /(^|\/)(mcp[^/]*|lead-tools|chat-actions|chat-decide|team-http)\.ts$/.test(file.path))) expect(one.text, one.path).not.toMatch(/flexible/i);
  });
});
