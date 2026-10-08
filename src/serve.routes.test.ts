/**
 * The route table at the server's edge (server/route-table.ts): an address no row declares, or a method it does not
 * declare, is refused before any handler or its shared mutation guard runs, and a caller the row does not admit gets
 * the route's own refusal.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { mintApiToken } from "./api-tokens.js";

let dir: string, store: Store, server: Server, port: number, token: string;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-routes-")));
  store = openStore(join(dir, "orders.db"));
  const now = new Date();
  if (!addApprover(store, "alice", now).ok) throw new Error("alice");
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alice", name: "alice-laptop", secretHash: minted.hash, access: "act", expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), by: "alice" }, now);
  token = minted.token;
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), configDir: dir });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: `127.0.0.1:${port}`, connection: "close", ...options.headers } }, incoming => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", chunk => { body += chunk; });
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }));
    });
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}
const bearer = () => ({ authorization: `Bearer ${token}` });
const NO_PAGE = "There's no page at this address.";

test("an undeclared address is refused for a signed-in caller, read or write", async () => {
  for (const path of ["/nope", "/settings/nope", "/t/a/b/c", "/flows/1/live/extra"]) {
    const read = await send(path, { headers: bearer() });
    expect([read.status, read.body], path).toEqual([404, NO_PAGE]);
    const write = await send(path, { method: "POST", headers: { ...bearer(), "content-type": "application/x-www-form-urlencoded" }, body: "" });
    expect([write.status, write.body], path).toEqual([404, NO_PAGE]);
  }
});

test("a wrong method is refused before the shared mutation guard runs", async () => {
  // /board is a declared read. A POST there used to reach the mutation guard, which refused the non-form body.
  const posted = await send("/board", { method: "POST", headers: { ...bearer(), "content-type": "application/json" }, body: "{}" });
  expect([posted.status, posted.body]).toEqual([404, NO_PAGE]);
  // /tasks/add is a declared action; reading it is not.
  const read = await send("/tasks/add", { headers: bearer() });
  expect([read.status, read.body]).toEqual([404, NO_PAGE]);
});

test("before sign-in, every address still asks for sign-in rather than revealing which exist", async () => {
  const unknown = await send("/nope");
  const known = await send("/board");
  expect(unknown.status).toBe(303);
  expect(known.status).toBe(303);
  expect(String(unknown.headers.location)).toMatch(/^\/login/);
  expect((await send("/nope", { method: "POST", body: "" })).status).toBe(401);
});

test("a caller the route does not admit gets that route's own refusal", async () => {
  const live = await send("/flows/1/live", { headers: bearer() });
  expect([live.status, live.headers["content-type"], live.body]).toEqual([403, "application/json", JSON.stringify({ error: "session" })]);
});

test("the edge stage's moved handlers still answer before sign-in", async () => {
  const worker = await send("/sw.js");
  expect([worker.status, worker.headers["cache-control"], worker.headers["content-security-policy"]]).toEqual([200, "no-store", "default-src 'none'"]);
  const font = await send("/fonts/geist-sans-400.woff2");
  expect([font.status, font.headers["content-type"], font.headers["cache-control"]]).toEqual([200, "font/woff2", "public, max-age=3600"]);
  expect((await send("/fonts/unknown.woff2")).status).toBe(303);
  const health = await send("/healthz", { headers: { host: "elsewhere.example" } });
  expect([health.status, health.body]).toEqual([200, JSON.stringify({ status: "ok" })]);
  expect((await send("/hooks/flow/unknown", { method: "POST", body: "{}" })).status).toBe(404);
});
