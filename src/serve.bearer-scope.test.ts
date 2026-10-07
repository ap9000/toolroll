/**
 * Token scope on every bearer route, at the real server boundary: a read-scope API token never mutates, and a
 * project-limited token never reaches outside its projects — on /api/team (and its event stream), /api/cli, /mcp and
 * the console. /api/sessions stays password-only. Every bearer route is budgeted, and the OAuth endpoints refuse
 * plain HTTP from outside this computer and the tailnet.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { routineDigestOf } from "./routine.js";
import { resolveRoutineAuthority } from "./agentconfig.js";
import { addApprover, propose } from "./scope.js";
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
      ["edit", { conversationId, messageId: 1, expectedRevision: 1, text: "Changed" }],
      ["withdraw", { conversationId, messageId: 1, expectedRevision: 1 }],
      ["stop", { conversationId, messageId: 1 }],
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
    expect((await post(token("act", [A]))).status).toBe(403);
  });

  test("/api/sessions refuses read and outside-project API tokens before a mutation", async () => {
    for (const bearer of [token("read"), token("act", [A])]) {
      const response = await fetch(`${base}/api/sessions/start`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ repo: B, prompt: "Must not run" }) });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ delivery: "not-sent" });
    }
    expect(ran).toEqual([]);
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

  test("password bearers on /api/team and /api/sessions share source and verified-account budgets", async () => {
    const limit = SOURCE_BUDGET_DEFAULTS.password;
    for (let i = 0; i < limit - 1; i++) await fetch(`${base}/api/team`, { headers: { authorization: `Bearer alex:${password}` } }).then(one => one.arrayBuffer());
    // A wrong password spends the source allowance but cannot spend the account allowance.
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


describe("bearer step-up and in-flight revocation", () => {
  function task() {
    store.createTask({ id: "guarded", title: "Guarded task" }, new Date());
    store.placeTask(store.refFor("built-in", "guarded").id, A);
    for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", new Date());
    return propose(store, { taskId: "guarded", goal: "Keep authorization intact", now: new Date() });
  }
  function oauthToken() {
    const minted = mintApiToken(), at = new Date(), expires = new Date(at.getTime() + 3600_000).toISOString();
    store.registerOAuthClient({ id: "test-client", name: "Test client", redirectUris: ["http://localhost/callback"], source: "test" }, at, 10, 10);
    store.createOAuthGrant("test-code", { id: minted.id, account: "alex", name: "OAuth test", secretHash: minted.hash, access: "act", expiresAt: expires },
      { client: "test-client", account: "alex", generation: store.accountOf("alex")!.generation, projects: [A], resource: `${base}/mcp`, accessExpiresAt: expires, refreshHash: "refresh-test" }, at);
    return minted.token;
  }
  const formPost = (bearer: string, path: string, fields: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", redirect: "manual",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

  // One row per direct password-check site; shared routes add variants below. The structural test keeps this exhaustive.
  const ceremonies: [string, string, Record<string, string>?][] = [
    ["routineMutation", "/routines/1/run-now"],
    ["code", "/code/start"], ["code", `/code/${"a".repeat(32)}/answer`, { decision: "accept" }],
    ["flows", "/flows/1/triggers/1/secret"], ["flows", "/flows/1/linear-key"],
    ["spendBudget", "/spend/budget"], ["projectDelete", "/settings/project/delete", { step: "delete" }],
    ["policy", "/settings/policy"], ["approval", "/settings/approval"], ["requestLimits", "/settings/request-limits"],
    ["sessions", "/settings/sessions", { action: "create-token", days: "30" }], ["signIn", "/settings/sign-in"],
    ["updates", "/settings/updates"], ["retention", "/settings/retention"], ["storage", "/settings/storage"],
    ["pullRequests", "/settings/pull-requests"], ["checks", "/settings/checks"], ["backups", "/settings/backups"],
    ["data", "/settings/data"], ["monitoring", "/settings/monitoring"], ["toolsConnect", "/settings/tools/connect"],
    ["toolsChange", "/settings/tools/change", { action: "add-custom" }], ["projectSetup", "/control/instructions-approve"],
    ["slack", "/settings/slack/connect"], ["teams", "/settings/teams/connect"], ["discord", "/settings/discord/connect"],
    ["runnerRegister", "/fleet/runner/register"], ["mode", "/mode/sign"], ["peopleProjects", "/people/projects"],
    ["peopleInvite", "/people/invite"], ["peopleInviteRevoke", "/people/invite-revoke"], ["peopleRevoke", "/people/revoke"],
    ["runnerRetire", "/fleet/runner/retire"], ["contest", "/contest/1/pick"], ["confirmStopped", "/t/guarded/confirm-stopped"],
    ["onboard", "/projects/onboard-confirm"], ["pushSubscribe", "/push/subscribe"], ["chatConfig", "/chat/config"],
    ["chat", "/chat"], ["chatFile", `/chat/file/${"a".repeat(32)}`], ["chatAck", "/chat/ack/1"],
    ["attendMutation", "/t/guarded/attend"], ["taskReopen", "/t/guarded/reopen"],
    ["taskRevision", "/t/guarded/accept-revision"], ["taskResume", "/t/guarded/resume"],
  ];
  const variants: [string, string, Record<string, string>?][] = [
    ["project setup", "/control/setup-approve"], ["task approval", "/t/guarded/approve"], ["routine approval", "/routines/1/approve"], ["contest abandon", "/contest/1/abandon"],
    ["storage clean", "/settings/storage/clean"], ["storage discard", "/settings/storage/discard"],
    ["mode confirm", "/mode/confirm"], ["chat approval confirm", "/settings/chat-approval/confirm"], ["chat approval save", "/settings/chat-approval/save"],
  ];

  test("every direct approver password call uses the browser-aware helper and has a bearer refusal case", () => {
    const source = readFileSync(new URL("./serve.ts", import.meta.url), "utf8");
    expect(source.match(/checkApproverPassword\(/g)).toHaveLength(1);
    expect(source).not.toContain("cookieOnlyCeremony");
    expect(source).not.toMatch(/authenticateApprover\(store/);
    expect(source).toMatch(/if \(who.via !== "cookie"\) return \{ ok: false, reason: "not-an-approver" \};\s+return checkApproverPassword/);
    const sites: string[] = [];
    let fn = "", form = "";
    for (const line of source.split("\n")) {
      const declaration = /^  (?:async )?function (\w+)\(/.exec(line);
      if (declaration) { fn = declaration[1]!; form = ""; }
      if (line.includes("readForm(")) form = /CONSOLE_FORMS\.(\w+)/.exec(line)?.[1] ?? form;
      if (/authenticateApprover\(who,/.test(line)) sites.push(form || fn);
    }
    expect(sites).toEqual(ceremonies.map(([site]) => site));
    expect(sites).toHaveLength(45);
  });

  test.each(["password", "api", "oauth"])("%s bearer gets 403 at every password step-up without changing protected state", async kind => {
    const scope = task();
    const terms = { repo: A, goal: "Guard routine approval", outOfScope: null, touches: [], acceptance: [], requirements: [], schedule: "every:60", singleFlight: true, costCeilingUsd: null };
    const authority = resolveRoutineAuthority(store, A, [], new Date());
    if (!authority.ok) throw Error(authority.problem);
    expect(store.createRoutine({ name: "guarded", ...terms, digest: routineDigestOf(terms, authority.profile, authority.route), profile: authority.profile, route: authority.route }, new Date()).ok).toBe(true);
    // This matrix checks authorization. Rate-limit behavior has its own exhaustive tests below.
    setLimitOverride(store, "*", { readPerMinute: null, actPerMinute: 200, perDay: null }, "alex", new Date());
    const bearer = kind === "password" ? `alex:${password}` : kind === "api" ? token("act") : oauthToken();
    const tables = store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
      .map(row => String(row["name"])).filter(name => !["action_ledger", "request_budget_usage", "ledger_chain", "ledger_head"].includes(name));
    const snapshot = () => Object.fromEntries(tables.map(table => {
      const rows = store.handle.prepare(`SELECT * FROM "${table}"`).all().filter(row => table !== "service_cursor" || row["key"] !== "workspace-content:v1").map(row => {
        if (table === "api_token") { const { last_used_at: _used, ...protectedFields } = row; return protectedFields; }
        return row;
      });
      return [table, createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
    }));
    const before = snapshot();
    for (const [site, path, fields] of [...ceremonies, ...variants]) {
      const response = await formPost(bearer, path, { token: password, password, digest: scope.digest, name: "alex", role: "approver", access: "all", repo: A, ...fields });
      expect([site, path, response.status]).toEqual([site, path, 403]);
      expect(snapshot()).toEqual(before);
    }
  });

  test.each(["console", "team"].flatMap(route => ["revoked", "read", "projects", "generation", "expired"].map(change => [route, change])))("%s refuses a token changed to %s during body delivery", async (route, change) => {
    task();
    const bearer = token("act"), id = bearer.split("_")[1]!;
    let authenticated!: () => void;
    const proved = new Promise<void>(resolve => { authenticated = resolve; });
    const touch = store.touchApiToken.bind(store);
    const spy = vi.spyOn(store, "touchApiToken").mockImplementation((...args) => { const result = touch(...args); authenticated(); return result; });
    const response = new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}${route === "team" ? "/api/team" : "/t/guarded/hold"}`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": route === "team" ? "application/json" : "application/x-www-form-urlencoded", "transfer-encoding": "chunked" } }, reply => { reply.resume(); reply.on("end", () => resolve(reply.statusCode!)); });
      request.on("error", reject);
      request.flushHeaders();
      void proved.then(() => {
        if (change === "revoked") store.revokeApiToken(id, "alex", new Date(), "regression");
        if (change === "read") store.handle.prepare("UPDATE api_token SET access = 'read' WHERE id = ?").run(id);
        if (change === "projects") store.handle.prepare("UPDATE api_token SET projects_json = ? WHERE id = ?").run(JSON.stringify([B]), id);
        if (change === "generation") store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'alex'").run();
        if (change === "expired") store.handle.prepare("UPDATE api_token SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
        request.end(route === "team" ? JSON.stringify({ operation: "create-lead", args: { name: "Must not be saved", projects: [A] } }) : "reason=Must+not+be+saved");
      }).catch(reject);
    });
    try { expect(await response).toBe(route === "team" && change !== "read" ? 401 : 403); expect(count("hold")).toBe(0); expect(count("team_lead")).toBe(0); } finally { spy.mockRestore(); }
  });

  test("a live act bearer can still hold and remove its own operator hold", async () => {
    task();
    const bearer = token("act");
    expect((await formPost(bearer, "/t/guarded/hold", { reason: "Wait for input" })).status).toBe(303);
    expect(count("hold")).toBe(1);
    expect((await formPost(bearer, "/t/guarded/unhold", {})).status).toBe(303);
  });
});


test("verified password admission is shared by account across sources and console, team and sessions", async () => {
  const other = addApprover(store, "sam", new Date(), { name: "alex", token: password });
  if (!other.ok) throw Error("sam");
  const get = (path: string, name = "alex", secret = password, source = "203.0.113.8") => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${name}:${secret}`, "x-forwarded-for": source, "x-forwarded-proto": "https" } });
  for (let i = 0; i < SOURCE_BUDGET_DEFAULTS.password; i++) {
    const response = await get(["/login", "/api/team", "/work"][i % 3]!, "alex", password, `203.0.113.${i % 3 + 1}`);
    expect(response.status).toBe(200); await response.arrayBuffer();
  }
  const denied = await get("/login", "alex", password, "203.0.113.99");
  expect(denied.status).toBe(429);
  expect(denied.headers.get("retry-after")).toBe("60");
  expect((await get("/api/team", "sam", other.token)).status).toBe(200);
  expect((await fetch(`${base}/api/sessions/list`, { method: "POST", headers: { authorization: `Bearer alex:${password}`, "content-type": "application/json" }, body: "{}" })).status).toBe(429);
  // No account allowance is consulted without proof, even when that claimed account has exhausted it.
  expect((await get("/api/team", "alex", "incorrect", "203.0.113.88")).status).toBe(401);
  now += 61_000;
  expect((await get("/api/team")).status).toBe(200);
});

test("unverified password admission is per source across console, team and sessions before authentication", async () => {
  const send = (i: number, source = "203.0.113.8") => {
    const path = ["/login", "/api/team", "/api/sessions/list"][i % 3]!;
    return fetch(`${base}${path}`, { method: path.includes("sessions") ? "POST" : "GET", headers: {
      authorization: `Bearer fabricated-${i}:bad`, "x-forwarded-for": source, "x-forwarded-proto": "https", "content-type": "application/json" },
      ...(path.includes("sessions") ? { body: "{}" } : {}) });
  };
  for (let i = 0; i < SOURCE_BUDGET_DEFAULTS.password; i++) await send(i).then(r => r.arrayBuffer());
  const auth = vi.spyOn(store, "accountOf");
  for (let i = 0; i < 3; i++) {
    const response = await send(i + SOURCE_BUDGET_DEFAULTS.password);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  }
  expect(auth).not.toHaveBeenCalled();
  expect((await send(1, "203.0.113.77")).status).toBe(401);
  expect(auth).toHaveBeenCalled();
  auth.mockRestore();
});

test.each([false, true])("fabricated account names cannot lock out a real user (distinct sources: %s)", async distinct => {
  for (let i = 0; i < 1024; i++) {
    const response = await fetch(`${base}/api/team`, { headers: { authorization: `Bearer fabricated-${i}:bad`, "x-forwarded-for": distinct ? `198.51.${Math.floor(i / 256)}.${i % 256}` : "203.0.113.8", "x-forwarded-proto": "https" } });
    await response.arrayBuffer();
  }
  const response = await fetch(`${base}/api/team`, { headers: { authorization: `Bearer alex:${password}`,
    "x-forwarded-for": "203.0.113.42", "x-forwarded-proto": "https" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true });
});
