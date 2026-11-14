/**
 * Flexible projects ship compiled in and switched off (flexible-available.ts). With the real constant: every writer,
 * the delegation check, the CLI and the settings route refuse with a plain reason, and no page offers it. And the
 * constant can't become a runtime override: one literal, no environment, config or exported setter, imported only by
 * name, and the built file says false too.
 */
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
    expect(users.map(one => one.path).sort()).toEqual([join("src", "flexible.ts"), join("src", "operate.ts"), join("src", "server", "settings.ts")].sort());
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
  });

  test("only a browser sign-in reaches the one Flexible route; no token, MCP tool or chat action names it", () => {
    const routes = ROUTES.filter(row => /flexible/i.test(row.id) || /flexible/i.test(row.pattern));
    expect(routes.map(row => ({ id: row.id, method: row.method, callers: row.callers }))).toEqual([{ id: "settings.project-flexible", method: "POST", callers: ["cookie"] }]);
    for (const one of product.filter(file => /(^|\/)(mcp[^/]*|lead-tools|chat-actions|chat-decide|team-http)\.ts$/.test(file.path))) expect(one.text, one.path).not.toMatch(/flexible/i);
  });
});
