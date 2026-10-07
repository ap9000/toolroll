/**
 * Token scope on every bearer route, at the real server boundary: a read-scope API token never mutates, and a
 * project-limited token never reaches outside its projects — on /api/team (and its event stream), /api/cli, /mcp and
 * the console. /api/sessions stays password-only. Every bearer route is budgeted, and the OAuth endpoints refuse
 * plain HTTP from outside this computer and the tailnet.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
import { setLimitOverride, SOURCE_BUDGET_DEFAULTS } from "./request-budget.js";
import type { RunOperateAs } from "./cli-http.js";
import type { TeamResponse } from "./team-contract.js";

let dir: string, A: string, B: string, store: Store, server: Server, base: string, password: string, now: number;
let ran: { argv: string[]; scope: string; projects: string[] | null }[];

const runner: RunOperateAs = async (argv, opts) => {
  ran.push({ argv, scope: opts.principal.scope, projects: opts.principal.projects });
  opts.write(JSON.stringify({ envelopeVersion: ENVELOPE_VERSION, command: argv.slice(0, 2).join(" "), ok: true }));
  return 0;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-bearer-scope-"));
  A = realpathSync(mkdtempSync(join(tmpdir(), "so-scope-a-")));
  B = realpathSync(mkdtempSync(join(tmpdir(), "so-scope-b-")));
  store = openStore(join(dir, "orders.db"));
  const added = addApprover(store, "alex", new Date());
  if (!added.ok) throw new Error("bootstrap");
  password = added.token;
  now = Date.now(); ran = [];
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [A, B], configDir: dir, cliRunner: runner, runOperateAs: runner, requestBudgetClock: () => now,
    cliModeOf: argv => { const row = contractRow(argv); return row === null ? null : { ...row, mode: "yes" }; } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  for (const one of [dir, A, B]) rmSync(one, { recursive: true, force: true });
});

function token(access: "read" | "act", projects: string[] | null = null): string {
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: `${access}-${projects?.length ?? "all"}-${minted.id}`, secretHash: minted.hash, access, projects,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
  return minted.token;
}
const team = async (bearer: string, operation: string, args: Record<string, unknown> = {}) => {
  const response = await fetch(`${base}/api/team`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ operation, args }) });
  return { status: response.status, body: await response.json() as TeamResponse };
};
const count = (table: string) => Number(store.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"]);
const teamRows = () => Object.fromEntries(["team_lead", "team_conversation", "team_message", "team_follow", "team_read", "team_request", "team_task_owner", "team_lead_member"].map(table => [table, count(table)]));
/** A lead and a conversation on `repo`, made with the person's password (a full-access bearer). */
async function leadOn(repo: string): Promise<{ leadId: string; conversationId: string; leadRevision: number }> {
  const lead = await team(`alex:${password}`, "create-lead", { name: `Lead ${repo.slice(-4)}`, projects: [repo] });
  expect(lead.body.ok).toBe(true);
  const leadId = (lead.body.result as { leadId: string }).leadId;
  const made = await team(`alex:${password}`, "create-conversation", { leadId, title: "Plans", visibility: "team", projects: [repo] });
  expect(made.body.ok).toBe(true);
  return { leadId, conversationId: (made.body.result as { conversationId: string }).conversationId, leadRevision: made.body.snapshot!.leads.find(one => one.id === leadId)!.revision };
}

describe("/api/team carries the token's whole principal", () => {
  test("an approver's read token can read but not create a lead or change anything, and nothing is written", async () => {
    const { leadId, conversationId, leadRevision } = await leadOn(A);
    const read = token("read");
    const before = teamRows();
    // Reads still work: connect checks a token against GET /api/team.
    const listed = await fetch(`${base}/api/team`, { headers: { authorization: `Bearer ${read}` } });
    expect(listed.status).toBe(200);
    const view = await listed.json() as TeamResponse;
    expect(view.snapshot).toMatchObject({ canCreateLead: false, canManage: false, canSend: false });
    expect((await team(read, "show", { conversationId })).status).toBe(200);
    for (const [operation, args] of [
      ["create-lead", { name: "Sneaky", projects: [A], requestId: "r1" }],
      ["update-lead", { leadId, expectedRevision: leadRevision, name: "Renamed" }],
      ["create-conversation", { leadId, title: "x", visibility: "team", projects: [A] }],
      ["member", { leadId, account: "alex", role: "manager", expectedRevision: leadRevision }],
      ["send", { conversationId, text: "hello", requestId: "r2" }],
      ["read", { conversationId, messageId: 0 }],
      ["follow", { conversationId, enabled: true }],
      ["authorize", { conversationId, termsDigest: "x" }],
      ["transfer", { taskId: "t", leadId, expectedRevision: 0 }],
    ] as const) {
      const refused = await team(read, operation, args);
      expect([operation, refused.status, refused.body.code]).toEqual([operation, 403, "read-only"]);
    }
    expect(teamRows()).toEqual(before);
  });

  test("an act token limited to project A can't see or act on project B's leads and conversations", async () => {
    const onA = await leadOn(A), onB = await leadOn(B);
    const limited = token("act", [A]);
    const listed = (await (await fetch(`${base}/api/team`, { headers: { authorization: `Bearer ${limited}` } })).json()) as TeamResponse;
    expect(listed.snapshot!.leads.map(one => one.id)).toEqual([onA.leadId]);
    expect(listed.snapshot!.projects).toEqual([A]);
    expect(listed.snapshot!.conversations.map(one => one.id)).toEqual([onA.conversationId]);
    const before = teamRows();
    for (const [operation, args] of [
      ["show", { conversationId: onB.conversationId }],
      ["create-lead", { name: "Outside", projects: [B] }],
      ["update-lead", { leadId: onB.leadId, expectedRevision: onB.leadRevision, name: "Renamed" }],
      ["create-conversation", { leadId: onB.leadId, title: "x", visibility: "team", projects: [B] }],
      ["member", { leadId: onB.leadId, account: "alex", role: "manager", expectedRevision: onB.leadRevision }],
      ["send", { conversationId: onB.conversationId, text: "hello", requestId: "r3" }],
      ["read", { conversationId: onB.conversationId, messageId: 0 }],
      ["follow", { conversationId: onB.conversationId, enabled: false }],
    ] as const) {
      const refused = await team(limited, operation, args);
      expect([operation, refused.body.ok]).toEqual([operation, false]);
      expect(refused.status).toBeGreaterThanOrEqual(400);
    }
    expect(teamRows()).toEqual(before);
    // Inside its project it still acts.
    expect((await team(limited, "read", { conversationId: onA.conversationId, messageId: 0 })).body.ok).toBe(true);
  });

  test("a limited token never replays a receipt saved for the same request id by a wider credential", async () => {
    await team(`alex:${password}`, "create-lead", { name: "Lead B", projects: [B], requestId: "same" });
    const replay = await team(token("act", [A]), "create-lead", { name: "Lead B", projects: [B], requestId: "same" });
    expect(replay.body).toMatchObject({ ok: false });
    expect(JSON.stringify(replay.body)).not.toContain("leadId");
  });

  test("the event stream re-proves the token: revoking it ends the stream", async () => {
    const read = token("read");
    const id = read.split("_")[1]!;
    const controller = new AbortController();
    const response = await fetch(`${base}/api/team/events`, { headers: { authorization: `Bearer ${read}` }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    store.revokeApiToken(id, "alex", new Date(), "test");
    let text = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
      if (text.includes("revoked")) break;
    }
    controller.abort();
    expect(text).toContain("event: revoked");
  });
});

describe("the other token routes keep the token's scope and projects", () => {
  test("/api/cli: a read token's principal stays read, a limited token's stays limited", async () => {
    const send = (bearer: string) => fetch(`${base}/api/cli`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ argv: ["status"] }) });
    expect((await send(token("read"))).status).toBe(200);
    expect((await send(token("act", [A]))).status).toBe(200);
    expect(ran.map(one => [one.scope, one.projects])).toEqual([["read", null], ["act", [A]]]);
  });

  test("/mcp: a read token is never offered or allowed an acting tool, and a limited token's principal stays limited", async () => {
    const call = async (bearer: string, method: string, params: Record<string, unknown> = {}) => (await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} } } }) })).json() as { result?: { tools?: { name: string }[]; isError?: boolean } };
    const read = token("read");
    const tools = (await call(read, "tools/list")).result!.tools!.map(one => one.name);
    expect(tools).not.toContain("file_task");
    const refused = await call(read, "tools/call", { name: "file_task", arguments: { title: "x", repo: A, idempotency_key: "key-0001" } });
    expect(JSON.stringify(refused)).toContain("reads only");
    expect(ran).toEqual([]);
    await call(token("act", [A]), "tools/call", { name: "status", arguments: {} });
    expect(ran.every(one => JSON.stringify(one.projects) === JSON.stringify([A]))).toBe(true);
  });

  test("the console: a read token's POST is refused as read-only and a limited token isn't accepted at all", async () => {
    const post = (bearer: string) => fetch(`${base}/settings/sessions`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/x-www-form-urlencoded" }, body: "", redirect: "manual" });
    const read = await post(token("read"));
    expect(read.status).toBe(403);
    expect(await read.text()).toContain("reads only");
    expect((await post(token("act", [A]))).status).toBe(401);
  });

  test("/api/sessions accepts no API token at all", async () => {
    const response = await fetch(`${base}/api/sessions/list`, { method: "POST", headers: { authorization: `Bearer ${token("act")}`, "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
  });
});

describe("every bearer route is budgeted", () => {
  test("/api/team shares the token's one budget with /api/cli, and refuses with 429 before running anything", async () => {
    setLimitOverride(store, "*", { readPerMinute: 2, actPerMinute: null, perDay: null }, "alex", new Date());
    const read = token("read");
    expect((await fetch(`${base}/api/team`, { headers: { authorization: `Bearer ${read}` } })).status).toBe(200);
    expect((await fetch(`${base}/api/cli`, { method: "POST", headers: { authorization: `Bearer ${read}`, "content-type": "application/json" }, body: JSON.stringify({ argv: ["status"] }) })).status).toBe(200);
    const refused = await fetch(`${base}/api/team`, { headers: { authorization: `Bearer ${read}` } });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({ ok: false, code: "rate-limited" });
    // The console charges the same budget.
    expect((await fetch(`${base}/work`, { headers: { authorization: `Bearer ${read}` } })).status).toBe(429);
    now += 61_000;
    expect((await fetch(`${base}/api/team`, { headers: { authorization: `Bearer ${read}` } })).status).toBe(200);
  });

  test("password bearers on /api/team and /api/sessions share a per-source budget, charged before the password is checked", async () => {
    const limit = SOURCE_BUDGET_DEFAULTS.password;
    for (let i = 0; i < limit - 1; i++) await fetch(`${base}/api/team`, { headers: { authorization: `Bearer alex:${password}` } }).then(one => one.arrayBuffer());
    // A wrong password counts too: guessing is budgeted.
    expect((await fetch(`${base}/api/sessions/list`, { method: "POST", headers: { authorization: "Bearer alex:wrong-password", "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const refused = await fetch(`${base}/api/sessions/list`, { method: "POST", headers: { authorization: `Bearer alex:${password}`, "content-type": "application/json" }, body: "{}" });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ ok: false, status: "rejected", delivery: "not-sent", reason: "rate-limited" });
    expect((await fetch(`${base}/api/team`, { headers: { authorization: `Bearer alex:${password}` } })).status).toBe(429);
    // A cookie is not a bearer: it isn't charged.
    now += 61_000;
    expect((await fetch(`${base}/api/team`, { headers: { authorization: `Bearer alex:${password}` } })).status).toBe(200);
  });
});

test("/oauth/token is budgeted by source before its body is read: 429 with Retry-After, nothing minted, other sources unaffected", async () => {
  const tokens = () => count("api_token");
  const before = tokens();
  const exchange = (headers: Record<string, string> = {}) => fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: "grant_type=refresh_token&refresh_token=sor_000000000000_x&client_id=c" });
  for (let i = 0; i < SOURCE_BUDGET_DEFAULTS.oauthToken; i++) expect((await exchange()).status).not.toBe(429);
  const refused = await exchange();
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(await refused.json()).toMatchObject({ error: "temporarily_unavailable" });
  // Another caller, relayed over HTTPS by the same-host proxy, has its own budget.
  expect((await exchange({ "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" })).status).not.toBe(429);
  expect(tokens()).toBe(before);
  now += 61_000;
  expect((await exchange()).status).not.toBe(429);
});
