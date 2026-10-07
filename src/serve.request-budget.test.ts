/**
 * Request budgets end to end (v112): a person's API token over `/api/cli` and `/mcp` on a real server, one budget per
 * token shared by both routes, 429 with Retry-After, a wrong token still a failed sign-in, the budget surviving a
 * restart, and the instance operator's override in Settings → Sessions & tokens.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { mintApiToken } from "./api-tokens.js";
import { contractRow } from "./remote-command.js";
import { ENVELOPE_VERSION } from "./envelope.js";
import { MODERN } from "./mcp-core.js";
import { setLimitOverride } from "./request-budget.js";
import type { RunOperateAs } from "./cli-http.js";

const T0 = Date.parse("2026-10-06T12:00:00.000Z");
let dir: string, store: Store, server: Server, base: string, password: string, now: number, ran: string[][];
let onRun: (argv: string[]) => Promise<void>;

const runner: RunOperateAs = async (argv, opts) => {
  ran.push(argv);
  await onRun(argv);
  opts.write(JSON.stringify({ envelopeVersion: ENVELOPE_VERSION, command: argv.slice(0, 2).join(" "), ok: true }));
  return 0;
};
async function listen(): Promise<void> {
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", configDir: dir, cliRunner: runner, runOperateAs: runner, requestBudgetClock: () => now,
    cliModeOf: argv => { const row = contractRow(argv); return row === null ? null : { ...row, mode: "yes" }; } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
}
const stop = () => new Promise<void>(resolve => server.close(() => resolve()));
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-request-budget-http-"));
  store = openStore(join(dir, "orders.db"));
  const added = addApprover(store, "alex", new Date());
  if (!added.ok) throw new Error("bootstrap");
  password = added.token;
  now = T0; ran = []; onRun = async () => {};
  await listen();
});
afterEach(async () => {
  await stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function token(access: "read" | "act", name: string): { token: string; id: string } {
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name, secretHash: minted.hash, access, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
  return { token: minted.token, id: minted.id };
}
const cli = (bearer: string, argv: string[] = ["status"]) =>
  fetch(`${base}/api/cli`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ argv }) });
const mcp = (bearer: string, method = "tools/list") =>
  fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} } } }) });
const limitRows = () => store.actionLedger({ repos: null, limit: 100 }).filter(one => one.action === "remote request limit reached");

test("one budget per token across /api/cli and /mcp: a burst gets 429 with Retry-After and a plain reason, nothing runs, and the window recovers", async () => {
  setLimitOverride(store, "*", { readPerMinute: null, actPerMinute: 3, perDay: null }, "alex", new Date());
  const agent = token("act", "agent");
  expect((await cli(agent.token)).status).toBe(200);
  expect((await mcp(agent.token)).status).toBe(200);
  expect((await cli(agent.token)).status).toBe(200);
  expect(ran).toHaveLength(2);

  const refused = await cli(agent.token);
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).toBe("60");
  expect(await refused.json()).toEqual({ ok: false, code: "rate-limited", limit: "act-per-minute", retryAfter: 60, message: "Request limit reached (act requests per minute). Try again in 60 seconds." });
  now += 15_000;
  const viaMcp = await mcp(agent.token, "tools/call");
  expect(viaMcp.status).toBe(429);
  expect(viaMcp.headers.get("retry-after")).toBe("45");
  expect(await viaMcp.json()).toMatchObject({ jsonrpc: "2.0", error: { message: "Request limit reached (act requests per minute). Try again in 45 seconds.", data: { limit: "act-per-minute", retryAfter: 45 } } });
  expect(ran).toHaveLength(2);
  // Ledgered once for the window, with the token's name and no secret.
  expect(limitRows()).toEqual([expect.objectContaining({ actor: "alex", source: "api", outcome: "refused", detail: "token agent: act-per-minute" })]);

  now = T0 + 60_000;
  expect((await cli(agent.token)).status).toBe(200);
  // Another token has its own budget.
  setLimitOverride(store, "*", { readPerMinute: null, actPerMinute: null, perDay: null }, "alex", new Date());
  const reader = token("read", "dashboard");
  for (let i = 0; i < 120; i++) expect((await mcp(reader.token)).status).toBe(200);
  expect((await mcp(reader.token)).status).toBe(429);
  expect((await cli(agent.token)).status).toBe(200);
});

test("a long task wait is one request however long it holds the server", async () => {
  setLimitOverride(store, "*", { readPerMinute: null, actPerMinute: 2, perDay: null }, "alex", new Date());
  const agent = token("act", "laptop");
  onRun = async argv => { if (argv[1] === "wait") now += 25_000; };
  expect((await cli(agent.token, ["task", "wait", "t-1", "--timeout", "25"])).status).toBe(200);
  expect((await cli(agent.token)).status).toBe(200);
  expect((await cli(agent.token)).status).toBe(429);
});

test("a wrong token is a failed sign-in, not a charge: twenty pause the address on both routes", async () => {
  const agent = token("act", "laptop");
  const wrong = `so_${agent.id}_${"x".repeat(43)}`;
  for (let i = 0; i < 10; i++) expect((await cli(wrong)).status).toBe(401);
  for (let i = 0; i < 10; i++) expect((await mcp(wrong)).status).toBe(401);
  expect((await cli(agent.token)).status).toBe(401);
  expect((await mcp(agent.token)).status).toBe(401);
  expect(ran).toEqual([]);
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM request_budget_usage").get()?.["n"]).toBe(0);
});

test("a restart doesn't reset the budget of a client hammering the server", async () => {
  setLimitOverride(store, "*", { readPerMinute: null, actPerMinute: 2, perDay: null }, "alex", new Date());
  const agent = token("act", "laptop");
  expect((await cli(agent.token)).status).toBe(200);
  expect((await mcp(agent.token)).status).toBe(200);
  await stop();
  await listen();
  const refused = await cli(agent.token);
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).toBe("60");
});

const sessionOf = (answer: Response) => answer.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;

test("an instance operator overrides limits in the console with their password; others, and tokens, cannot", async () => {
  const agent = token("act", "agent");
  const signIn = async (name: string, secret: string) => sessionOf(await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: secret }), redirect: "manual" }));
  const cookie = await signIn("alex", password);
  let page = await (await fetch(`${base}/settings/sessions`, { headers: { cookie } })).text();
  expect(page).toContain("30 requests a minute · 10,000 a day");
  expect(page).toContain("<summary>Request limits</summary>");
  const save = (fields: Record<string, string>, as = cookie) => fetch(`${base}/settings/request-limits`, { method: "POST", headers: { cookie: as, origin: base }, body: new URLSearchParams({ csrf: csrfOf(page), action: "save", ...fields }), redirect: "manual" });
  const said = (answer: Response) => decodeURIComponent(/[?&](?:said|problem)=([^&]*)/.exec(answer.headers.get("location") ?? "")?.[1] ?? "");

  expect(said(await save({ target: "*", "act-per-minute": "5", password: "wrong" }))).toBe("Enter your Toolroll password to change request limits.");
  expect(said(await save({ target: "*", "act-per-minute": "601", password }))).toBe("Limits are whole numbers from 1 to 600. Nothing changed.");
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM request_budget_limit").get()?.["n"]).toBe(0);
  expect(said(await save({ target: "*", "act-per-minute": "5", password }))).toBe("Everyone's tokens: limits saved.");
  expect(said(await save({ target: agent.id, "per-minute": "2", "per-day": "100", password }))).toBe("agent: limits saved.");
  page = await (await fetch(`${base}/settings/sessions`, { headers: { cookie } })).text();
  expect(page).toContain("2 requests a minute · 100 a day");
  expect((await cli(agent.token)).status).toBe(200);
  expect((await cli(agent.token)).status).toBe(200);
  expect((await cli(agent.token)).status).toBe(429);
  expect(said(await save({ target: agent.id, password, action: "clear" }))).toBe("agent: default limits.");
  expect(store.actionLedger({ repos: null, source: "policy", limit: 3 }).map(one => one.detail)).toEqual([
    "token agent: act 2/min, 100/day → defaults", "token agent: defaults → act 2/min, 100/day", "installation: defaults → act 5/min"]);

  // A token never reaches the form, and someone who isn't an instance operator is refused.
  const byToken = await fetch(`${base}/settings/request-limits`, { method: "POST", headers: { authorization: `Bearer ${agent.token}` }, body: new URLSearchParams({ target: "*", "act-per-minute": "600", password }), redirect: "manual" });
  expect(byToken.status).toBeGreaterThanOrEqual(300);
  const sam = addApprover(store, "sam", new Date(), { name: "alex", token: password });
  if (!sam.ok) throw new Error("sam");
  // An approver for one project is not an instance operator.
  expect(store.setAccountProjects("sam", ["/repo/main"], "alex", new Date())).toEqual({ ok: true });
  const samCookie = await signIn("sam", sam.token);
  page = await (await fetch(`${base}/settings/sessions`, { headers: { cookie: samCookie } })).text();
  expect(page).not.toContain("<summary>Request limits</summary>");
  expect((await save({ target: "*", "act-per-minute": "600", password: sam.token }, samCookie)).status).toBe(403);
  expect(store.handle.prepare("SELECT act_per_minute FROM request_budget_limit WHERE target = '*'").get()?.["act_per_minute"]).toBe(5);
});
