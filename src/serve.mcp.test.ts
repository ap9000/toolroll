import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { mintApiToken } from "./api-tokens.js";
import { mintCoordinator } from "./coordinator.js";
import { ENVELOPE_VERSION } from "./envelope.js";
import { LEGACY, MODERN, TOOLS } from "./mcp-core.js";
import type { Principal, RunOperateAs } from "./mcp-person.js";
import { runOperate } from "./operate.js";

/**
 * The MCP gateway over HTTP at /mcp. People's commands run through `runOperateAs`, which the remote-principal change
 * provides; until it lands these tests inject a fake that honours its contract (project grants, act scope, a JSON
 * envelope) so what is proved here is the gateway's part: who signs in, which principal and source reach the command,
 * which tools each person sees, and how answers and refusals come back.
 */

const modernMeta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} };
const TASK_REPOS: Record<string, string> = { "t-shop": "/repo/shop", "t-bank": "/repo/bank" };

let dir: string, store: Store, base: string, close: () => Promise<void>;
let ran: { argv: string[]; principal: Principal; source: string | undefined }[];

/** Stands in for operate.ts's runOperateAs: grants and scope enforced, one envelope written. */
const fakeRunAs: RunOperateAs = async (argv, opts) => {
  ran.push({ argv, principal: opts.principal, source: opts.source });
  const command = argv.slice(0, 2).join(" ");
  const say = (body: Record<string, unknown>): number => { opts.write(`${JSON.stringify({ envelopeVersion: ENVELOPE_VERSION, command, ...body })}\n`); return body["ok"] === true ? 0 : 3; };
  const allowed = (repo: string | undefined) => repo !== undefined && (opts.principal.projects === null || opts.principal.projects.includes(repo));
  if (command === "task show" || command === "task review" && argv.includes("--brief")) {
    return allowed(TASK_REPOS[argv[2]!]) ? say({ ok: true, task: { id: argv[2] } }) : say({ ok: false, reason: "unknown-task", message: `no task \`${argv[2]}\`` });
  }
  if (command === "task add") {
    if (opts.principal.scope !== "act") return say({ ok: false, reason: "unauthenticated", message: "a read token" });
    return allowed(argv[argv.indexOf("--repo") + 1]) ? say({ ok: true, id: "t-new" }) : say({ ok: false, reason: "usage", message: "not your project" });
  }
  return say({ ok: true });
};

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-mcp-http-")));
  store = openStore(join(dir, "orders.db"));
  ran = [];
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/shop", configDir: dir, runOperateAs: fakeRunAs });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
  close = () => new Promise(resolve => server.close(() => resolve()));
});
afterEach(async () => {
  await close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Two people: alex (an operator, every project) and sam (an approver granted /repo/shop only). */
function people(): { alex: string; sam: string } {
  const now = new Date();
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("alex");
  const sam = addApprover(store, "sam", now, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  expect(store.setAccountProjects("sam", ["/repo/shop"], "alex", now)).toEqual({ ok: true });
  return { alex: alex.token, sam: sam.token };
}

function token(account: string, access: "read" | "act", name = `${account}-laptop`): { token: string; id: string } {
  const minted = mintApiToken();
  const now = new Date();
  store.createApiToken({ id: minted.id, account, name, secretHash: minted.hash, access, expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), by: account }, now);
  return { token: minted.token, id: minted.id };
}

/** One MCP HTTP client: its own bearer, a fresh POST per message. */
function client(bearer: string) {
  let next = 1;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await post({ jsonrpc: "2.0", id: next++, method, params: { _meta: modernMeta, ...params } });
    return { status: response.status, body: response.status === 200 ? await response.json() as Record<string, any> : null };
  };
  const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).body!["result"] as { content: { text: string }[]; isError?: boolean };
  return { post, rpc, call, tools: async () => ((await rpc("tools/list")).body!["result"]["tools"] as { name: string }[]).map(one => one.name) };
}

describe("people over /mcp", () => {
  test("each person's own session: their tools, their principal, source mcp and their token", async () => {
    people();
    const alexToken = token("alex", "act", "alex-laptop");
    const samToken = token("sam", "read", "sam-agent");
    const alex = client(alexToken.token), sam = client(samToken.token);

    const discover = await alex.rpc("server/discover");
    expect(discover.body!["result"]).toMatchObject({ protocolVersion: MODERN, resultType: "complete", ttlMs: 0, cacheScope: "private" });
    expect(await alex.tools()).toEqual(["status", "list_tasks", "task_show", "task_review", "review_findings", "file_task"]);
    expect(await sam.tools()).toEqual(["status", "list_tasks", "task_show", "task_review", "review_findings"]);
    // No approval, answer, people or policy verbs exist for a person, and no coordinator tool leaks in.
    for (const name of await alex.tools()) expect(name).not.toMatch(/approve|answer|decide|propose|mint|grant/);

    const shown = await alex.call("task_show", { ref: "t-bank" });
    expect(shown.isError).toBeUndefined();
    expect(JSON.parse(shown.content[0]!.text)).toMatchObject({ ok: true, command: "task show" });
    await sam.call("task_review", { ref: "t-shop", run: 4, all: true });
    await sam.call("review_findings", { run: 7 });
    await sam.call("list_tasks", { state: "queued", repo: "/repo/shop", limit: 5 });

    expect(ran.map(one => [one.principal.account, one.principal.tokenId, one.principal.scope, one.source, one.argv])).toEqual([
      ["alex", alexToken.id, "act", "mcp", ["task", "show", "t-bank", "--json"]],
      ["sam", samToken.id, "read", "mcp", ["task", "review", "t-shop", "--brief", "--run", "4", "--all", "--json"]],
      ["sam", samToken.id, "read", "mcp", ["task", "review", "7", "--json"]],
      ["sam", samToken.id, "read", "mcp", ["task", "list", "--state", "queued", "--repo", "/repo/shop", "--limit", "5", "--json"]],
    ]);
    expect(ran[0]!.principal).toEqual({ kind: "person", account: "alex", generation: store.accountOf("alex")!.generation, scope: "act", tokenId: alexToken.id, projects: null });
    expect(ran[1]!.principal.projects).toEqual(["/repo/shop"]);
  });

  test("file_task files under the person and is the ordinary add: it waits for approval like any task", async () => {
    people();
    const alex = client(token("alex", "act").token);
    const filed = await alex.call("file_task", { repo: "/repo/shop", title: "Fix the cart total", idempotency_key: "cart-0001", deliverable: "report" });
    expect(JSON.parse(filed.content[0]!.text)).toMatchObject({ ok: true, id: "t-new" });
    expect(ran[0]!.argv).toEqual(["task", "add", "Fix the cart total", "--repo", "/repo/shop", "--key", "cart-0001", "--report", "--json"]);
    // Nothing that reaches a command line may read as a flag.
    const flagged = await alex.rpc("tools/call", { name: "file_task", arguments: { repo: "/repo/shop", title: "--approve", idempotency_key: "cart-0002" } });
    expect(flagged.body!["error"]).toMatchObject({ code: -32602 });
    expect(ran).toHaveLength(1);
  });

  test("another project's task is refused exactly like a task that does not exist", async () => {
    people();
    const sam = client(token("sam", "act").token);
    const foreign = await sam.call("task_show", { ref: "t-bank" });
    const missing = await sam.call("task_show", { ref: "t-nowhere" });
    expect(foreign.isError).toBe(true);
    expect(JSON.parse(foreign.content[0]!.text)).toMatchObject({ ok: false, reason: "unknown-task" });
    expect(JSON.parse(missing.content[0]!.text)).toMatchObject({ ok: false, reason: "unknown-task" });
    expect((await sam.call("file_task", { repo: "/repo/bank", title: "Sneak in", idempotency_key: "bank-0001" })).isError).toBe(true);
  });

  test("a read token is refused file_task before any command runs", async () => {
    people();
    const reader = client(token("alex", "read").token);
    const refused = await reader.call("file_task", { repo: "/repo/shop", title: "Write access please", idempotency_key: "read-0001" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("this token reads only");
    expect(ran).toHaveLength(0);
  });

  test("a token revoked mid-session gets 401 on its very next call", async () => {
    people();
    const minted = token("sam", "act");
    const sam = client(minted.token);
    expect((await sam.rpc("tools/list")).status).toBe(200);
    expect(store.revokeApiToken(minted.id, "alex", new Date())).toBe(true);
    const next = await sam.rpc("tools/call", { name: "status", arguments: {} });
    expect(next.status).toBe(401);
    expect(ran).toHaveLength(0);
  });

  test("a grant change ends the account's tokens; a new token carries the new grants", async () => {
    people();
    const sam = client(token("sam", "act").token);
    await sam.call("status", {});
    expect(store.setAccountProjects("sam", ["/repo/bank"], "alex", new Date())).toEqual({ ok: true });
    expect((await sam.rpc("tools/list")).status).toBe(401);
    await client(token("sam", "act").token).call("status", {});
    expect(ran.map(one => one.principal.projects)).toEqual([["/repo/shop"], ["/repo/bank"]]);
  });
});

describe("the /mcp door", () => {
  test("POST only, no browser Origin, JSON only, bounded, and never a password or nothing", async () => {
    const { alex } = people();
    const bearer = token("alex", "act").token;
    const ok = client(bearer);
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${bearer}` } })).status).toBe(405);
    expect((await ok.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta } }, { origin: base })).status).toBe(403);
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await client(`alex:${alex}`).rpc("tools/list")).status).toBe(401);
    expect((await client("so_000000000000_" + "a".repeat(43)).rpc("tools/list")).status).toBe(401);
    expect((await ok.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await ok.post({ jsonrpc: "2.0", id: 1, method: "x", params: { pad: "x".repeat(300 * 1024) } })).status).toBe(413);
    expect((await ok.post([{ jsonrpc: "2.0", id: 1, method: "tools/list" }])).status).toBe(400);
    // The console's Host check still runs first.
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const sent = request(`${base}/mcp`, { method: "POST", headers: { host: "evil.example", authorization: `Bearer ${bearer}`, "content-type": "application/json" } }, answer => { answer.resume(); resolve(answer.statusCode ?? 0); });
      sent.on("error", reject);
      sent.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta } }));
    });
    expect(wrongHost).toBe(421);
  });

  test("a body with no length is cut off at 256 KiB: 413 before the client finishes, then the connection closes", async () => {
    people();
    const bearer = token("alex", "act").token;
    const outcome = await new Promise<{ status: number; closed: boolean }>((resolve, reject) => {
      const sent = request(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "transfer-encoding": "chunked" } }, answer => {
        answer.resume();
        answer.on("end", () => resolve({ status: answer.statusCode ?? 0, closed: answer.headers.connection === "close" }));
      });
      sent.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET" && (error as NodeJS.ErrnoException).code !== "EPIPE") reject(error); });
      // 300 KiB in 16 KiB pieces and the request is never ended: only an early answer can settle this.
      const piece = "x".repeat(16 * 1024);
      for (let i = 0; i < 19; i++) sent.write(piece);
    });
    expect(outcome).toEqual({ status: 413, closed: true });
    expect(ran).toHaveLength(0);
  });

  test("a handshake-era client initializes statelessly; notifications are accepted without a body", async () => {
    people();
    const alex = client(token("alex", "act").token);
    const init = await alex.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } });
    expect(((await init.json()) as Record<string, any>)["result"]).toMatchObject({ protocolVersion: LEGACY, capabilities: { tools: {} } });
    const note = await alex.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    const listed = await alex.post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": LEGACY });
    expect(((await listed.json()) as Record<string, any>)["result"]["tools"].map((one: { name: string }) => one.name)).toContain("file_task");
  });

  test("a coordinator credential sees the coordinator registry, exactly the stdio one", async () => {
    const minted = mintCoordinator(store, { name: "ci-bot", repos: ["/repo/shop"], by: "alex", now: new Date() });
    if (!minted.ok) throw new Error("mint");
    const bot = client(minted.token);
    expect(await bot.tools()).toEqual(TOOLS.map(one => one.name));
    const status = await bot.call("status", {});
    expect(status.isError).toBeUndefined();
    expect(JSON.parse(status.content[0]!.text)).toHaveProperty("waitsOnYou");
    expect(ran).toHaveLength(0);
  });
});

/** The same doors with nothing injected: the gateway loads operate.ts's real runOperateAs. */
describe("people over /mcp, against the real runOperateAs", () => {
  let real: { base: string; close: () => Promise<void> };
  let shopRepo: string, bankRepo: string;
  beforeEach(async () => {
    shopRepo = join(dir, "shop"); bankRepo = join(dir, "bank");
    mkdirSync(shopRepo); mkdirSync(bankRepo);
    const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), configDir: dir });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    real = { base: `http://127.0.0.1:${address.port}`, close: () => new Promise(resolve => server.close(() => resolve())) };
  });
  afterEach(async () => { await real.close(); });

  const realClient = (bearer: string) => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${real.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: modernMeta, name, arguments: args } }) });
      expect(response.status).toBe(200);
      return ((await response.json()) as Record<string, any>)["result"] as { content: { text: string }[]; isError?: boolean };
    };
    return { call };
  };
  /** Two people as before, but sam's grant names the real shop folder. */
  const twoPeople = async (): Promise<{ shopTask: string; bankTask: string }> => {
    const now = new Date();
    const alex = addApprover(store, "alex", now);
    if (!alex.ok) throw new Error("alex");
    const sam = addApprover(store, "sam", now, { name: "alex", token: alex.token });
    if (!sam.ok) throw new Error("sam");
    expect(store.setAccountProjects("sam", [shopRepo], "alex", now)).toEqual({ ok: true });
    const file = async (repo: string, title: string): Promise<string> => {
      const lines: string[] = [];
      expect(await runOperate("task", ["add", title, "--repo", repo, "--json", "--db", join(dir, "orders.db")], line => { lines.push(line); }, { openDatabase: () => openStore(join(dir, "orders.db")) })).toBe(0);
      return String((JSON.parse(lines.at(-1)!) as { task: { id: string } }).task.id);
    };
    return { shopTask: await file(shopRepo, "Shop work"), bankTask: await file(bankRepo, "Bank work") };
  };
  const mcpLedger = () => store.actionLedger({ repos: null, instance: true, limit: 200 }).filter(one => one.source === "mcp");

  test("another project's task answers exactly like a missing one, and the ledger names the person, mcp and the token", async () => {
    const { shopTask, bankTask } = await twoPeople();
    const sam = realClient(token("sam", "act", "sam-agent").token);
    const own = await sam.call("task_show", { ref: shopTask });
    expect(own.isError, own.content[0]!.text).toBeUndefined();
    expect(JSON.parse(own.content[0]!.text)).toMatchObject({ ok: true, command: "task show" });
    const foreign = await sam.call("task_show", { ref: bankTask });
    const missing = await sam.call("task_show", { ref: "t-nowhere" });
    expect(foreign.isError).toBe(true);
    const shape = (text: string) => { const { message: _m, ...rest } = JSON.parse(text) as Record<string, unknown>; return rest; };
    expect(shape(foreign.content[0]!.text)).toEqual(shape(missing.content[0]!.text));
    expect(foreign.content[0]!.text).not.toContain(bankRepo);
    expect((await sam.call("file_task", { repo: bankRepo, title: "Sneak in", idempotency_key: "bank-0001" })).isError).toBe(true);
    expect(store.listTasks().filter(one => one.title === "Sneak in")).toHaveLength(0);

    const shown = mcpLedger().find(one => one.taskId === shopTask && one.outcome === "done");
    expect(shown).toMatchObject({ actor: "sam", source: "mcp", action: "remote command: task show", detail: "token sam-agent · tool task_show" });
    expect(mcpLedger().every(one => one.actor === "sam" && one.detail?.startsWith("token sam-agent"))).toBe(true);
  });

  test("v111: a project-limited token works only inside its projects on /mcp and /api/cli, never on the console, and a rotated one stops after its overlap", async () => {
    const { shopTask, bankTask } = await twoPeople();
    // alex may use every project; this token only the shop.
    const minted = mintApiToken();
    const now = new Date();
    store.createApiToken({ id: minted.id, account: "alex", name: "alex-shop", secretHash: minted.hash, access: "act", expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), by: "alex", projects: [shopRepo] }, now);
    const limited = realClient(minted.token);
    expect((await limited.call("task_show", { ref: shopTask })).isError).toBeUndefined();
    expect((await limited.call("task_show", { ref: bankTask })).isError).toBe(true);
    expect((await limited.call("file_task", { repo: bankRepo, title: "Outside the limit", idempotency_key: "limit-0001" })).isError).toBe(true);
    expect(store.listTasks().filter(one => one.title === "Outside the limit")).toHaveLength(0);
    const cli = async (argv: string[]) => {
      const response = await fetch(`${real.base}/api/cli`, { method: "POST", headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" }, body: JSON.stringify({ argv }) });
      return { status: response.status, body: await response.json() as { exitCode?: number; stdout?: string } };
    };
    expect((await cli(["task", "show", shopTask, "--json"])).body.exitCode).toBe(0);
    const outside = await cli(["task", "show", bankTask, "--json"]);
    expect(outside.body.exitCode).toBe(3);
    expect(JSON.parse(outside.body.stdout!)).toMatchObject({ ok: false, reason: "not-found" });
    // The console's own pages check the account alone, so a limited token signs in nothing there.
    const ledgerPage = (bearer: string) => fetch(`${real.base}/ledger?format=json`, { headers: { authorization: `Bearer ${bearer}` }, redirect: "manual" });
    expect((await ledgerPage(token("alex", "read", "alex-everywhere").token)).status).toBe(200);
    const refused = await ledgerPage(minted.token);
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toMatch(/^\/login/);
    // Rotated, with its overlap over: the old token signs in nowhere, before any cleanup, and the new one carries the limit.
    const replacement = mintApiToken();
    expect(store.rotateApiToken(minted.id, { id: replacement.id, secretHash: replacement.hash }, "alex", now, 600_000)).toMatchObject({ ok: true, row: { projects: [shopRepo] } });
    expect((await cli(["task", "show", shopTask, "--json"])).body.exitCode).toBe(0);
    store.handle.prepare("UPDATE api_token SET overlap_until = ? WHERE id = ?").run(new Date(Date.now() - 1).toISOString(), minted.id);
    expect((await cli(["task", "show", shopTask, "--json"])).status).toBe(401);
    expect((await fetch(`${real.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta } }) })).status).toBe(401);
    const renewed = realClient(replacement.token);
    expect((await renewed.call("task_show", { ref: bankTask })).isError).toBe(true);
    expect((await renewed.call("task_show", { ref: shopTask })).isError).toBeUndefined();
  });

  test("a read token reads its own project and files nothing", async () => {
    const { shopTask } = await twoPeople();
    const reader = realClient(token("sam", "read", "sam-dashboard").token);
    expect((await reader.call("task_show", { ref: shopTask })).isError).toBeUndefined();
    const refused = await reader.call("file_task", { repo: shopRepo, title: "Write access please", idempotency_key: "read-0001" });
    expect(refused.isError).toBe(true);
    expect(store.listTasks().filter(one => one.title === "Write access please")).toHaveLength(0);
    expect(mcpLedger().map(one => [one.action, one.outcome, one.detail])).toEqual([
      ["remote command: task show", "done", "token sam-dashboard · tool task_show"],
      ["remote command: task show", "requested", "token sam-dashboard · tool task_show"],
    ]);
  });
});
