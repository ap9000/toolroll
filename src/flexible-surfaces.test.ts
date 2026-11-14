/**
 * Flexible projects, slice F1: the CLI (`toolroll project flexible`) and the project settings page's route, with the
 * feature replaced on for this file only (the build ships it off: flexible-disabled.test.ts). Who may turn it on, lower
 * it and turn it off on each road, the terms shown before the password, and a stale digest refused.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { runOperate, EXIT } from "./operate.js";
import { createDecisionServer } from "./serve.js";
import { flexibleStanding, proposedFlexibleTerms } from "./flexible.js";

vi.mock("./flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));

const NOW = new Date();
let dir: string, repo: string, db: string, store: Store, lines: string[];
const tokens: Record<string, string> = {};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flexible-surfaces-")));
  repo = join(dir, "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  db = join(dir, "orders.db");
  store = openStore(db);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  tokens["alex"] = alex.token;
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  tokens["sam"] = sam.token;
  expect(store.setAccountProjects("sam", [repo], "alex", NOW)).toEqual({ ok: true }); // an approver of this project only
  const made = store.createConsoleTask({ title: "known", repo, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, NOW);
  if (!made.ok) throw new Error(made.reason);
});
afterEach(() => { vi.unstubAllEnvs(); store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("toolroll project flexible", () => {
  const run = (argv: string[]) => { lines = []; return runOperate("project", ["flexible", ...argv], line => lines.push(line), { databaseFile: db }); };
  const payload = () => JSON.parse(lines.join("\n")) as Record<string, unknown>;
  const as = (name: string) => ["--as", name, "--token", tokens[name]!];

  test("show: Secure until turned on", async () => {
    expect(await run(["--repo", repo, "--json"])).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ ok: true, command: "project flexible show", flexible: { state: "secure" } });
  });

  test("enable prints the terms and their digest first; only that digest, with a password, turns it on", async () => {
    // No digest and no terminal: the terms, and nothing changed.
    expect(await run(["enable", "--repo", repo, ...as("sam")])).toBe(EXIT.refused);
    const shown = lines.join("\n");
    expect(shown).toContain("People who can approve work in this project may start Flexible threads at Full access without a password.");
    expect(shown).toContain("Full access removes the agent's permission prompts inside the sandbox only.");
    const digest = /--digest ([0-9a-f]{32})/.exec(shown)![1]!;
    expect(flexibleStanding(store, repo)).toEqual({ state: "secure" });
    // A foreign digest refuses.
    expect(await run(["enable", "--repo", repo, "--digest", "0".repeat(32), "--json", ...as("sam")])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "terms-changed" });
    // A wrong password refuses.
    expect(await run(["enable", "--repo", repo, "--digest", digest, "--as", "sam", "--token", "wrong", "--json"])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "person-only" });
    // The shown digest and the password: on, signed by sam (an approver of this project, not an instance operator).
    expect(await run(["enable", "--repo", repo, "--digest", digest, "--json", ...as("sam")])).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ ok: true, flexible: { state: "on", digest, signedBy: "sam" } });
  });

  test("the lead, a remote token or any machine never turns it on, lowers it or turns it off", async () => {
    const shown = proposedFlexibleTerms(store, repo, "alex");
    if (!shown.ok) throw new Error(shown.message);
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", "lt_x_y");
    for (const action of [["enable", "--digest", shown.digest], ["lower", "--max", "auto"], ["off"]]) {
      expect(await run([...action, "--repo", repo, "--json", ...as("alex")])).toBe(EXIT.refused);
      expect(payload()).toMatchObject({ ok: false, reason: "person-only" });
    }
    vi.unstubAllEnvs();
    vi.stubEnv("TOOLROLL_REMOTE_TOKEN", "x");
    expect(await run(["enable", "--digest", shown.digest, "--repo", repo, "--json", ...as("alex")])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "person-only" });
    expect(flexibleStanding(store, repo)).toEqual({ state: "secure" });
  });

  test("lower and off: an approver of the project, signed in; levels only go down", async () => {
    const shown = proposedFlexibleTerms(store, repo, "alex");
    if (!shown.ok) throw new Error(shown.message);
    expect(await run(["enable", "--repo", repo, "--digest", shown.digest, ...as("alex")])).toBe(EXIT.ok);
    expect(await run(["lower", "--repo", repo, "--json", ...as("sam")])).toBe(EXIT.usage);
    expect(await run(["lower", "--repo", repo, "--max", "yolo", "--json", ...as("sam")])).toBe(EXIT.usage);
    expect(await run(["lower", "--repo", repo, "--max", "auto", "--as", "sam", "--token", "wrong", "--json"])).toBe(EXIT.refused);
    expect(await run(["lower", "--repo", repo, "--max", "auto", "--json", ...as("sam")])).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ changed: true, flexible: { state: "on", terms: { max: "auto" }, signedBy: "alex" } });
    expect(await run(["lower", "--repo", repo, "--max", "full", "--json", ...as("sam")])).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ reason: "not-lower" });
    expect(await run(["off", "--repo", repo, "--json", ...as("sam")])).toBe(EXIT.ok);
    expect(flexibleStanding(store, repo)).toEqual({ state: "secure" });
  });

  test("options it doesn't name are refused", async () => {
    expect(await run(["enable", "--repo", repo, "--yes", "--json"])).toBe(EXIT.usage);
    expect(await run(["frobnicate", "--repo", repo, "--json"])).toBe(EXIT.usage);
    expect(await run(["show", "--repo", repo, "--as", "alex", "--json"])).toBe(EXIT.usage);
  });
});

describe("Settings → Project → How work starts", () => {
  let server: Server, base: string;
  beforeEach(async () => {
    server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo, platform: "darwin", fenceAvailable: () => true });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); });

  const signIn = async (name: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: tokens[name]! }), redirect: "manual" }))
    .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
  const page = async (cookie: string) => (await fetch(`${base}/settings/project?repo=${encodeURIComponent(repo)}`, { headers: { cookie } })).text();
  const post = async (cookie: string, fields: Record<string, string>) => {
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await page(cookie))![1]!;
    const answer = await fetch(`${base}/settings/project/flexible`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, repo, ...fields }), redirect: "manual" });
    return { status: answer.status, said: decodeURIComponent(answer.headers.get("location") ?? "") };
  };

  test("the terms show in full before the password; the password signs exactly the digest shown", async () => {
    const alex = await signIn("alex");
    const html = await page(alex);
    expect(html).toContain('id="flexible"');
    expect(html).toContain("How work starts");
    expect(html).toContain("Full access removes the agent");
    const digest = /name="digest" value="([0-9a-f]{32})"/.exec(html)![1]!;
    expect((await post(alex, { action: "enable", digest, password: "wrong" })).said).toMatch(/Enter your Toolroll password/);
    expect((await post(alex, { action: "enable", digest: "0".repeat(32), password: tokens["alex"]! })).said).toMatch(/terms changed/);
    expect(flexibleStanding(store, repo)).toEqual({ state: "secure" });
    expect((await post(alex, { action: "enable", digest, password: tokens["alex"]! })).said).toMatch(/Flexible is on/);
    expect(flexibleStanding(store, repo)).toMatchObject({ state: "on", digest, signedBy: "alex" });
    // Lowering and turning off are one click, no password.
    expect((await post(alex, { action: "lower", max: "supervised" })).said).toMatch(/Lowered to Supervised/);
    expect((await post(alex, { action: "off" })).said).toMatch(/Secure again/);
    expect(flexibleStanding(store, repo)).toEqual({ state: "secure" });
  });

  test("a bearer token never reaches the route; an approver limited to this project uses the CLI (the settings area needs instance access)", async () => {
    const sam = await signIn("sam");
    expect((await post(sam, { action: "off" })).status).toBe(403);
    const bearer = await fetch(`${base}/settings/project/flexible`, { method: "POST", headers: { authorization: `Bearer ${tokens["alex"]!}`, origin: base }, body: new URLSearchParams({ repo, action: "off" }), redirect: "manual" });
    expect(bearer.status).toBeGreaterThanOrEqual(400);
  });
});
