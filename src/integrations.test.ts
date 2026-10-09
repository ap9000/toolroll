/**
 * Settings → Integrations and `toolroll integrations`: each integration is
 * Connected, Not set up or Broken, with its last success and last error and
 * one action, and never a secret. Telegram, GitHub and an MCP server are each
 * shown in every state; the page renders from saved checks without waiting.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { htmlString } from "./html.js";
import { withFormToken } from "./server/request-context.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import type { ExecResult } from "./exec.js";
import { addToolTo, validateToolSpec } from "./project-tools.js";
import { checkIntegrations, createIntegrationMonitor, integrationsBrokenLine, integrationsNow, scrubIntegrationText, type Integration, type IntegrationIo } from "./integrations.js";
import { integrationsHtml } from "./integrations-ui.js";

const T0 = new Date("2026-09-30T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const BOT_TOKEN = `123456789:${"A".repeat(20)}bcdefghijklmnopq`;
const TOOL_KEY = ["sk", "live", "fixture", "0123456789abcdef"].join("_");
let dir: string, repo: string, store: Store, now: Date;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-integrations-")));
  repo = join(dir, "shop");
  mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  now = T0;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const result = (over: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false, ...over });
type Gh = NonNullable<IntegrationIo["gh"]>;
const signedInGh = (permission: string): Gh => async (_file, args) =>
  args[0] === "api" ? result({ stdout: "octocat\n" }) : result({ stdout: JSON.stringify({ nameWithOwner: "acme/shop", viewerPermission: permission }) });
const noGh: Gh = async () => result({ code: 127, notFound: true });
const telegramFetch = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
const botOk = telegramFetch(200, { ok: true, result: { id: 123456789, is_bot: true, username: "shop_alerts_bot" } });

function io(over: Partial<IntegrationIo> = {}): IntegrationIo {
  return {
    store, dir, telegramTokenFile: join(dir, "telegram-token"), env: {}, repos: [repo],
    fetch: botOk, gh: noGh, toolHome: dir, clock: () => now,
    checkConnection: async provider => ({ state: provider === "claude" ? "connected" : "not-installed", mode: "subscription", email: "alex@example.com", checkedAt: now.toISOString() }),
    reach: async () => {},
    ...over,
  };
}
const one = (list: Integration[], key: string) => list.find(row => row.key === key)!;

function mcpServer(): string {
  const server = join(dir, "shop-mcp.mjs");
  writeFileSync(server, `import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (!process.env.SHOP_KEY) process.exit(3);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "shop", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "lookup_order", inputSchema: { type: "object" } }, { name: "list_orders", inputSchema: { type: "object" } }] });
});
`);
  return server;
}

test("Telegram: Not set up, then Connected as its bot, then Broken with a fix in plain words, keeping the last success", async () => {
  expect(one(integrationsNow(io()), "telegram")).toMatchObject({ state: "not-set-up", action: { kind: "setup", label: "Set up", href: "/settings#telegram-token" } });

  writeFileSync(join(dir, "telegram-token"), `${BOT_TOKEN}\n`, { mode: 0o600 });
  // Configured but not yet checked: the page can say so without waiting.
  expect(one(integrationsNow(io()), "telegram")).toMatchObject({ checked: false });
  const connected = one(await checkIntegrations(io()), "telegram");
  expect(connected).toMatchObject({ state: "connected", account: "@shop_alerts_bot", checked: true, lastSuccessAt: T0.toISOString(), lastError: null, action: { kind: "test", label: "Send test" } });

  now = at(5);
  const broken = one(await checkIntegrations(io({ fetch: telegramFetch(401, { ok: false, description: `Unauthorized ${BOT_TOKEN}` }) })), "telegram");
  expect(broken).toMatchObject({ state: "broken", lastSuccessAt: T0.toISOString(), lastErrorAt: at(5).toISOString(), action: { kind: "fix", label: "Fix", href: "/settings#telegram-token" } });
  expect(broken.action.kind === "fix" && broken.action.words).toMatch(/doesn't accept the saved bot token/);

  // A failed delivery since the last good check also counts, from notification_delivery.
  now = at(10);
  one(await checkIntegrations(io()), "telegram");
  expect(one(integrationsNow(io()), "telegram").state).toBe("connected");
  expect(JSON.stringify(integrationsNow(io()))).not.toContain(BOT_TOKEN);
});

test("GitHub: Not set up without gh, Connected as the signed-in account with push rights, Broken without push or once a flow needs it", async () => {
  const absent = one(await checkIntegrations(io({ gh: noGh }), ["github"]), "github");
  expect(absent).toMatchObject({ state: "not-set-up", action: { kind: "setup", command: "gh auth login" } });

  const connected = one(await checkIntegrations(io({ gh: signedInGh("WRITE") }), ["github"]), "github");
  expect(connected).toMatchObject({ state: "connected", account: "octocat", detail: "Can push to acme/shop", action: { kind: "test" } });

  now = at(1);
  const readOnly = one(await checkIntegrations(io({ gh: signedInGh("READ") }), ["github"]), "github");
  expect(readOnly).toMatchObject({ state: "broken", account: "octocat", lastSuccessAt: T0.toISOString(), action: { kind: "fix", command: "gh auth login" } });
  expect(readOnly.action.kind === "fix" && readOnly.action.words).toContain("can't push to acme/shop");

  // Signed out while a flow watches GitHub: Broken, not merely Not set up.
  if (!addApprover(store, "alex", T0).ok) throw new Error("alex");
  const flow = store.createFlow({ repo, name: "Triage", by: "alex", definitionJson: JSON.stringify({ version: 1, start: "done", stages: [{ id: "done", title: "Done", kind: "done", zone: {}, instructions: null, next: null, onFail: null }] }) }, T0);
  store.handle.prepare("INSERT INTO flow_trigger (flow, kind, config_json, state, created_by, created_at, updated_at) VALUES (?, 'github', ?, 'active', 'alex', ?, ?)")
    .run(flow, JSON.stringify({ kind: "github", repo: "acme/shop", watch: "issues", label: null, branch: null, from: "team", delivery: "poll", zone: null }), T0.toISOString(), T0.toISOString());
  const signedOut: Gh = async () => result({ code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" });
  const needed = one(await checkIntegrations(io({ gh: signedOut }), ["github"]), "github");
  expect(needed).toMatchObject({ state: "broken", usedBy: ["Pull requests", "Flow Triage"] });
});

test("an MCP server: Not set up with no tools, Connected when it starts and lists its tools, Broken when it can't start", async () => {
  expect(one(integrationsNow(io()), "mcp")).toMatchObject({ state: "not-set-up", name: "MCP tools", action: { kind: "setup", href: "/settings/tools" } });

  const server = mcpServer();
  expect(addToolTo(store, repo, validateToolSpec({ name: "shop", command: process.execPath, args: [server], secrets: [{ name: "SHOP_KEY", optional: false }], about: "The shop" }), "test", "alex", T0, { values: { SHOP_KEY: TOOL_KEY }, home: dir }).ok).toBe(true);
  const key = `mcp:${repo}:shop`;
  const connected = one(await checkIntegrations(io(), [key]), key);
  expect(connected).toMatchObject({ state: "connected", name: "shop", account: "shop", detail: "2 tools", usedBy: ["Tasks in shop"] });

  now = at(2);
  expect(addToolTo(store, repo, validateToolSpec({ name: "broken", command: join(dir, "no-such-server"), args: [], secrets: [], about: "Gone" }), "test", "alex", T0, { home: dir }).ok).toBe(true);
  const brokenKey = `mcp:${repo}:broken`;
  const broken = one(await checkIntegrations(io(), [brokenKey]), brokenKey);
  expect(broken).toMatchObject({ state: "broken", action: { kind: "fix", label: "Fix" } });
  expect(broken.lastErrorAt).toBe(at(2).toISOString());
  expect(JSON.stringify(integrationsNow(io()))).not.toContain(TOOL_KEY);
});

test("toolroll integrations --json lists every integration with its state, times and action, and no secrets; status adds one line", async () => {
  writeFileSync(join(dir, "telegram-token"), `${BOT_TOKEN}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "linear-key"), `lin_api_${"x".repeat(30)}\n`, { mode: 0o600 });
  store.upsertProject(repo, "shop", T0);
  store.close();
  try {
    const lines: string[] = [];
    const linearRefuses = (async (url: string | URL) => String(url).includes("linear")
      ? new Response(JSON.stringify({ errors: [{ message: `bad key lin_api_${"x".repeat(30)}` }] }), { status: 401 })
      : new Response(JSON.stringify({ ok: true, result: { username: "shop_alerts_bot" } }), { status: 200 })) as typeof fetch;
    const options = { databaseFile: join(dir, "orders.db"), now: T0, integrationIo: { fetch: linearRefuses, gh: signedInGh("WRITE"), checkConnection: io().checkConnection!, reach: async () => {} } };
    expect(await runOperate("integrations", ["--json"], line => lines.push(line), options)).toBe(0);
    const wire = lines.join("\n");
    const body = JSON.parse(wire) as { ok: boolean; integrations: Integration[] };
    expect(body.ok).toBe(true);
    const keys = body.integrations.map(row => row.key);
    expect(keys).toEqual(expect.arrayContaining(["telegram", "slack", "discord", "teams", "github", "linear", "email", "mcp", "monitoring", "agent:claude", "agent:codex"]));
    for (const row of body.integrations) {
      expect(["connected", "not-set-up", "broken"]).toContain(row.state);
      expect(row).toHaveProperty("lastSuccessAt");
      expect(row).toHaveProperty("lastError");
      expect(["setup", "test", "fix"]).toContain(row.action.kind);
    }
    expect(body.integrations.find(row => row.key === "telegram")).toMatchObject({ state: "connected", account: "@shop_alerts_bot" });
    expect(body.integrations.find(row => row.key === "linear")).toMatchObject({ state: "broken" });
    expect(body.integrations.find(row => row.key === "agent:claude")).toMatchObject({ state: "connected", account: "alex@example.com" });
    expect(body.integrations.find(row => row.key === "agent:codex")).toMatchObject({ state: "not-set-up" });
    expect(wire).not.toContain(BOT_TOKEN);
    expect(wire).not.toContain("lin_api_");

    // The plain listing says the same, and `status` adds one line for what's Broken, from the saved checks.
    lines.length = 0;
    expect(await runOperate("integrations", ["--saved"], line => lines.push(line), options)).toBe(0);
    expect(lines.join("\n")).toMatch(/Linear\s+Broken/);
    expect(lines.join("\n")).toMatch(/Telegram\s+Connected\s+@shop_alerts_bot/);
    lines.length = 0;
    const neverCalled = (() => { throw new Error("status must not run a check"); }) as unknown as typeof fetch;
    await runOperate("status", [], line => lines.push(line), { ...options, integrationIo: { ...options.integrationIo, fetch: neverCalled }, releaseIo: { fetch: async () => { throw new Error("offline"); } } } as Parameters<typeof runOperate>[3]);
    expect(lines.join("\n").split("\n").filter(line => line.startsWith("Broken integration"))).toEqual(["Broken integration: Linear. See `toolroll integrations` or Settings → Integrations."]);
  } finally { store = openStore(join(dir, "orders.db")); }
});

test("a render never waits on an integration check: the page answers while every check hangs", async () => {
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  writeFileSync(join(dir, "telegram-token"), `${BOT_TOKEN}\n`, { mode: 0o600 });
  let started = 0;
  const hang = (() => { started += 1; return new Promise<never>(() => {}); }) as unknown as typeof fetch;
  const hangGh: Gh = () => { started += 1; return new Promise<never>(() => {}); };
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo, configDir: dir, telegramTokenFile: join(dir, "telegram-token"),
    integrationIo: { fetch: hang, gh: hangGh, reach: () => new Promise<never>(() => {}), checkConnection: () => new Promise<never>(() => {}) } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
      const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" }))
        .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      // Every check hangs forever, so a page that waited on one would never
      // answer: the "Checking" page itself is the proof, not a wall-clock
      // window a loaded machine can miss. The abort only bounds a regression.
      const response = await fetch(`${base}/settings/integrations`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
      expect(response.status).toBe(200);
      const page = await response.text();
      expect(started).toBeGreaterThan(0);
      expect(page).toContain("<h1>Integrations</h1>");
      expect(page).toMatch(/data-integration="telegram" data-state="connected"/);
      expect(page).toContain("Checking");
      expect(page).toMatch(/data-integration="slack" data-state="not-set-up"[\s\S]*?href="\/settings\/slack">Set up</);
      expect(page).not.toContain(BOT_TOKEN);
      // A second render while the checks still hang starts no second round and still answers at once.
      const again = started;
      expect((await fetch(`${base}/settings/integrations`, { headers: { cookie }, signal: AbortSignal.timeout(3_000) })).status).toBe(200);
      expect(started).toBe(again);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("the monitor answers from saved checks and refreshes in the background after its short cache", async () => {
    writeFileSync(join(dir, "telegram-token"), `${BOT_TOKEN}\n`, { mode: 0o600 });
    let clock = 0, calls = 0;
    const counting = (async () => { calls += 1; return new Response(JSON.stringify({ ok: true, result: { username: "shop_alerts_bot" } })); }) as typeof fetch;
    const monitor = createIntegrationMonitor(() => io({ fetch: counting }), { cacheMs: 60_000, now: () => clock });
    expect(one(monitor.list(), "telegram").checked).toBe(false);
    await monitor.check(["telegram"]);
    expect(one(monitor.list(), "telegram")).toMatchObject({ checked: true, state: "connected" });
    const before = calls;
    monitor.list();
    expect(calls).toBe(before);
    clock = 61_000;
    monitor.list();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(calls).toBeGreaterThan(before);
  });

  test("page rows carry one action each, fixes in plain words, and scrubbing removes token shapes", () => {
    const list: Integration[] = [
      { key: "telegram", group: "chat", name: "Telegram", state: "broken", account: null, detail: null, checked: true, checkedAt: T0.toISOString(), lastSuccessAt: null, lastError: "Telegram doesn't accept the saved bot token.", lastErrorAt: T0.toISOString(), usedBy: ["Alerts"], action: { kind: "fix", label: "Fix", words: "Telegram doesn't accept the saved bot token.", href: "/settings#telegram-token", command: null } },
      { key: "github", group: "code", name: "GitHub", state: "connected", account: "octocat", detail: "Can push to acme/shop", checked: true, checkedAt: T0.toISOString(), lastSuccessAt: T0.toISOString(), lastError: null, lastErrorAt: null, usedBy: ["Pull requests"], action: { kind: "test", label: "Send test" } },
    ];
    const html = htmlString(withFormToken("c".repeat(64), () => integrationsHtml(list, "c".repeat(64), {})));
    expect(html).toContain("1 needs fixing.");
    expect(html).toMatch(/href="\/settings#telegram-token">Fix</);
    expect(html).toMatch(/name="key" value="github"><button type="submit">Send test</);
    expect(integrationsBrokenLine(list)).toBe("Broken integration: Telegram. See `toolroll integrations` or Settings → Integrations.");
    expect(scrubIntegrationText(`failed with ${BOT_TOKEN} and xoxb-1234567890-abcdef and https://user:pw@host/x`)).not.toMatch(/AAAA|xoxb-1|user:pw/);
  });
