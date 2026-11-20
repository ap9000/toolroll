import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { request as httpRequest, createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { mintApiToken } from "./api-tokens.js";
import { createDecisionServer } from "./serve.js";
import { handleTerminalConnection } from "./terminal-connection.js";
import { terminalConnectionSchema } from "./contracts/terminal-connection.js";
import { engineContractDigest } from "./contracts/engine-api.js";
import type { Principal } from "./operate-remote.js";

let store: Store, dir: string, server: Server | undefined;
const now = () => new Date();
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "so-terminal-connection-")); store = openStore(join(dir, "orders.db")); });
afterEach(async () => { if (server !== undefined) await new Promise<void>((done, fail) => server!.close(error => error ? fail(error) : done())); server = undefined; vi.restoreAllMocks(); store.close(); rmSync(dir, { force: true, recursive: true }); });
function mint(account: string, access: "read" | "act" = "read", purpose: "api" | "mcp" = "api", projects: readonly string[] | null = ["/synthetic/allowed"]) {
  const token = mintApiToken(); store.createApiToken({ id: token.id, account, name: "synthetic terminal", secretHash: token.hash, access,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: account, projects, purpose }, now()); return token;
}
function people() {
  const alice = addApprover(store, "alice", now()); if (!alice.ok) throw Error("alice");
  const bob = addApprover(store, "bob", now(), { name: "alice", token: alice.token }); if (!bob.ok) throw Error("bob");
  expect(store.setAccountProjects("bob", ["/synthetic/allowed"], "alice", now())).toEqual({ ok: true }); return { alice, bob };
}
async function listen(s: Server): Promise<number> {
  server = s; await new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve)); const address = s.address();
  if (address === null || typeof address === "string") throw Error("listen"); return address.port;
}
function get(port: number, token: string, extra: string[] = [], path = "/engine/connection") {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string; body: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: ["Host", `127.0.0.1:${port}`, "Authorization", `Bearer ${token}`, "x-toolroll-client", "terminal-remote", "Accept", "application/json", ...extra] }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", part => { text += part; }); response.on("end", () => { try { resolve({ status: response.statusCode!, headers: response.headers, text, body: text === "" ? {} : JSON.parse(text) as Record<string, unknown> }); } catch { reject(Error(`Non-JSON response (${response.statusCode}): ${text.slice(0, 160)}`)); } });
    }); request.on("error", reject); request.end();
  });
}
test("native HTTP admission preserves personal read/act scope, advertises no authority, and leaves hello unchanged", async () => {
  people(); const read = mint("bob"), act = mint("alice", "act"), viewer = mint("bob", "act");
  const port = await listen(createDecisionServer({ store, configDir: dir, evidenceRoot: join(dir, "evidence") }));
  const digest = engineContractDigest(), identity = store.workspaceIdentity();
  const unrestricted = mint("alice", "read", "api", null);
  for (const [token, expected] of [[read, "read"], [act, "act"]] as const) {
    const reply = await get(port, token.token); expect(reply.status).toBe(200); const body = terminalConnectionSchema.parse(reply.body);
    expect(body.principal.access).toBe(expected); expect(body.workspace.id).toBe(identity.id); expect(body.engine.contract).toBe(digest);
    expect(body.capabilities.commands).toEqual([]); expect(Object.values(body.capabilities).some(value => value === true)).toBe(false);
    expect(reply.headers["cache-control"]).toBe("no-store"); expect(reply.text).not.toContain(token.token); expect(reply.text).not.toContain(token.hash); expect(reply.text).not.toContain("/synthetic");
  }
  store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'bob'").run();
  const downgraded = await get(port, viewer.token); expect(downgraded.status).toBe(200);
  expect(downgraded.body["principal"]).toMatchObject({ role: "viewer", access: "read" });
  const scopedHello = await get(port, read.token, [], "/engine/hello"); expect(scopedHello.status).toBe(303);
  const hello = await get(port, unrestricted.token, [], "/engine/hello"); expect(hello.status).toBe(200); expect(hello.body["contract"]).toBe(digest);
  expect(hello.body).not.toHaveProperty("workspace"); expect(store.workspaceIdentity()).toEqual(identity);
});
test("browser, duplicate credentials/client headers, query, other token kinds and wrong-purpose credentials never read workspace metadata", async () => {
  people(); const token = mint("bob"), mcp = mint("bob", "read", "mcp"), read = vi.spyOn(store, "workspaceIdentity");
  const port = await listen(createDecisionServer({ store, configDir: dir, evidenceRoot: join(dir, "evidence") }));
  for (const extra of [["Cookie", "standing-orders_session=synthetic"], ["Origin", "http://127.0.0.1:12345"], ["Sec-Fetch-Mode", "cors"], ["Referer", "https://example.test"], ["Authorization", `Bearer ${token.token}`], ["x-toolroll-client", "terminal-remote"]]) {
    const reply = await get(port, token.token, extra); expect(reply.status).toBe(400); expect(reply.headers["cache-control"]).toBe("no-store");
  }
  expect((await get(port, token.token, [], "/engine/connection?workspace=caller-chosen")).status).toBe(400);
  expect((await get(port, "lt_" + token.token.slice(3))).status).toBe(401);
  expect([401, 403]).toContain((await get(port, mcp.token)).status);
  expect(read).not.toHaveBeenCalled();
});
test("a token revoked before or during metadata reads receives no successful snapshot", async () => {
  people(); const token = mint("bob"), account = store.accountOf("bob")!;
  const principal: Principal = { kind: "person", account: "bob", generation: account.generation, scope: "read", tokenId: token.id, projects: ["/synthetic/allowed"] };
  const port = await listen(createServer((request, response) => handleTerminalConnection(request, response, { store, clock: now, authenticate: () => principal })));
  const original = store.workspaceIdentity.bind(store);
  vi.spyOn(store, "workspaceIdentity").mockImplementationOnce(() => { const identity = original(); store.revokeApiToken(token.id, "alice", now()); return identity; });
  const during = await get(port, token.token); expect(during.status).toBe(401); expect(during.body).toEqual({ protocol: 1, error: "unauthenticated" });
  const reads = vi.spyOn(store, "workspaceIdentity"); reads.mockClear(); expect((await get(port, token.token)).status).toBe(401); expect(reads).not.toHaveBeenCalled();
});
test("missing or changed workspace identity fails closed without repair", async () => {
  people(); const token = mint("bob"), account = store.accountOf("bob")!;
  const principal: Principal = { kind: "person", account: "bob", generation: account.generation, scope: "read", tokenId: token.id, projects: ["/synthetic/allowed"] };
  const port = await listen(createServer((request, response) => handleTerminalConnection(request, response, { store, clock: now, authenticate: () => principal })));
  const original = store.workspaceIdentity.bind(store);
  vi.spyOn(store, "workspaceIdentity").mockImplementationOnce(() => { const identity = original(); store.handle.prepare("UPDATE workspace_identity SET recovery_generation = ?").run("d".repeat(32)); return identity; });
  expect((await get(port, token.token)).body).toEqual({ protocol: 1, error: "workspace-unavailable" });
  vi.restoreAllMocks(); store.handle.exec("DROP TRIGGER workspace_identity_not_deleted; DELETE FROM workspace_identity");
  const reply = await get(port, token.token); expect(reply.status).toBe(503); expect(reply.body).toEqual({ protocol: 1, error: "workspace-unavailable" });
  expect(store.handle.prepare("SELECT count(*) AS n FROM workspace_identity").get()?.["n"]).toBe(0);
});
