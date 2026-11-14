/**
 * Fast reads at the edges fast-reads.slow.test.ts doesn't reach: an API token, a local owner's session, an account
 * narrowed or revoked between its reads, overlapping requests for different accounts, and a commit by another process.
 * Each read is served twice — with the request's work reads (work-reads.ts) and with them switched off (this file's
 * mock makes withWorkReads run the read bare, exactly as main read every page) — and the two answers must match byte
 * for byte after the same normalization the golden uses. A mid-request write, revocation, external commit, a write
 * while the projection fills and a hold ending across the reuse window are work-reads.test.ts's.
 */
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seeded, seedWireWorld, WIRE_NOW, type WireWorld } from "../test/wire-world.js";
import type { DecisionServer } from "./serve.js";
import type { Store } from "./store.js";

const reads = vi.hoisted(() => ({ off: false }));
vi.mock("./work-reads.js", async importOriginal => {
  const real = await importOriginal<typeof import("./work-reads.js")>();
  return { ...real, withWorkReads: <T>(run: () => T): T => reads.off ? run() : real.withWorkReads(run) };
});

process.env["TZ"] = "UTC";
type Answer = { status: number; body: string; headers: IncomingHttpHeaders };
type Served = { root: string; port: number; store: Store; server: DecisionServer };
const realRandom = Math.random;
let world: WireWorld, wire: Served, laptop: Served;
const cookies: Record<string, string> = {};
let token = "", ownResult = "";

function send(at: Served, path: string, headers: Record<string, string>, method = "GET", body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: at.port, path, method, headers: { host: `127.0.0.1:${at.port}`, connection: "close", ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
/** Per-request secrets only (a form's request id, a page's script nonce): everything else must match as sent. */
const normalized = (text: string) => text.replace(/(nonce=\\?"|"nonce":")[A-Za-z0-9_\-+/=]+/g, "$1<token>")
  .replace(/(name=\\?"request\\?" value=\\?"|"requestId":")[0-9a-f]{32}/g, "$1<request>");
const asRead = (headers: Record<string, string>, json: boolean) => json
  ? { ...headers, accept: "application/json", "x-toolroll-read": "navigate", "x-toolroll-work": "1" } : { ...headers, accept: "text/html" };
const withFormat = (path: string) => `${path}${path.includes("?") ? "&" : "?"}format=workspace`;

/** The read with the request's work reads, and the same read without them: they must be the same answer. */
async function same(at: Served, path: string, headers: Record<string, string>): Promise<Answer> {
  let answer: Answer | undefined;
  for (const json of [false, true]) {
    reads.off = false;
    const fast = await send(at, json ? withFormat(path) : path, asRead(headers, json));
    reads.off = true;
    const bare = await send(at, json ? withFormat(path) : path, asRead(headers, json));
    reads.off = false;
    expect(`${fast.status} ${String(fast.headers.location ?? "")} ${normalized(fast.body)}`, `${path} ${json ? "in place" : "document"}`)
      .toBe(`${bare.status} ${String(bare.headers.location ?? "")} ${normalized(bare.body)}`);
    if (json) answer = fast;
  }
  return answer!;
}

async function serve(store: Store, root: string, options: Record<string, unknown>): Promise<Served> {
  const { createDecisionServer } = await import("./serve.js");
  const refuse = async (): Promise<never> => { throw Error("these reads never call a model or the network"); };
  const server = createDecisionServer({
    store, connectionHome: root, toolHome: root, fenceAvailable: false, clock: () => new Date(WIRE_NOW),
    connectionProbe: async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false }),
    modelCatalogFetcher: refuse as typeof fetch, chatFetcher: refuse as typeof fetch, subscriptionChatRunner: refuse,
    modelRunner: async () => ({ code: 1, stdout: "", stderr: "" }),
    firstTaskRunner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: true }),
    ghList: async () => ({ ok: false, reason: "gh-missing", message: "gh is not installed" }) as never,
    ...options,
  } as Parameters<typeof createDecisionServer>[0]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { root, store, server, port: (server.address() as { port: number }).port };
}

beforeAll(async () => {
  Math.random = seeded(7);
  vi.useFakeTimers({ toFake: ["Date"], now: WIRE_NOW });
  const { openStore, initLocalMode } = await import("./store.js");
  const { addApprover } = await import("./scope.js");
  const { mintApiToken } = await import("./api-tokens.js");
  // The wire world, with an approver limited to two projects and a read token of theirs.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-fast-edges-")));
  const store = openStore(join(root, "config", "orders.db"));
  world = seedWireWorld(store, root, { tasks: 600 });
  const yesterday = new Date(WIRE_NOW.getTime() - 86_400_000);
  const pat = addApprover(store, "pat", yesterday, { name: "alex", token: world.people.alex });
  if (!pat.ok || !store.setAccountProjects("pat", [world.repos[0]!, world.samProject], "alex", yesterday).ok) throw Error("pat");
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "pat", name: "ci", secretHash: minted.hash, access: "read", expiresAt: "2099-01-01T00:00:00.000Z", by: "pat" }, yesterday);
  token = minted.token;
  ownResult = String(store.handle.prepare(`SELECT t.id FROM task t JOIN task_ref r ON r.backend = 'built-in' AND r.external_id = t.id
    WHERE r.repo = ? AND t.state = 'done' AND r.revision_of IS NULL AND EXISTS(SELECT 1 FROM run WHERE task_ref = r.id AND finished_at IS NOT NULL AND role = 'builder' AND outcome = 'built')
    ORDER BY t.id LIMIT 1`).get(world.samProject)?.["id"]);
  wire = await serve(store, root, { evidenceRoot: world.evidenceRoot, repos: world.repos });
  for (const [who, password] of Object.entries({ ...world.people, pat: pat.token })) {
    const login = await send(wire, "/login", { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${wire.port}` }, "POST", new URLSearchParams({ name: who, token: password }).toString());
    if (login.status !== 303) throw Error(`sign-in for ${who}: ${login.status}`);
    cookies[who] = String(login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  }
  // A laptop install: its local owner signs in with a one-time link, no password.
  const laptopRoot = realpathSync(mkdtempSync(join(tmpdir(), "so-fast-laptop-")));
  const laptopStore = openStore(join(laptopRoot, "laptop.db"), { createdBy: "laptop" });
  if (!initLocalMode(laptopStore, { owner: "alex", fenceAvailable: true, now: WIRE_NOW }).ok) throw Error("local mode");
  const repo = join(laptopRoot, "repo");
  mkdirSync(repo, { recursive: true });
  for (const id of ["one", "two", "three"]) {
    laptopStore.createTask({ id, title: `laptop task ${id}` }, WIRE_NOW);
    laptopStore.placeTask(laptopStore.refFor("built-in", id).id, repo, {}, WIRE_NOW);
  }
  laptop = await serve(laptopStore, laptopRoot, { evidenceRoot: join(laptopRoot, "evidence"), repos: [repo], configDir: laptopRoot });
  const link = (laptop.server as DecisionServer & { mintLocalLink(): string | null }).mintLocalLink();
  if (link === null) throw Error("local link");
  cookies["owner"] = String((await send(laptop, link, {})).headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}, 300_000);

afterAll(async () => {
  Math.random = realRandom;
  vi.useRealTimers();
  for (const one of [wire, laptop]) {
    if (one === undefined) continue;
    one.server.closeAllConnections?.();
    await new Promise<void>(resolve => one.server.close(() => resolve()));
    one.store.close();
    rmSync(one.root, { recursive: true, force: true });
  }
});

test("an API token reads what it read without the request's work reads", async () => {
  const auth = { authorization: `Bearer ${token}` };
  for (const path of ["/tasks", "/tasks?layout=board", `/t/${encodeURIComponent(ownResult)}?tab=result`]) await same(wire, path, auth);
}, 300_000);

test("a local owner's session reads what it read without them", async () => {
  expect(cookies["owner"]).toMatch(/=/);
  for (const path of ["/", "/tasks", "/tasks?layout=board", "/chat"]) await same(laptop, path, { cookie: cookies["owner"]! });
}, 300_000);

test("a viewer reads a result in their own project, the same either way", async () => {
  const answer = await same(wire, `/t/${encodeURIComponent(ownResult)}?tab=result`, { cookie: cookies["sam"]! });
  expect(answer.status).toBe(200);
}, 300_000);

test("an account narrowed, then revoked, between its reads reads exactly its new access", async () => {
  const before = await same(wire, "/tasks", { cookie: cookies["pat"]! });
  expect(wire.store.setAccountProjects("pat", [world.samProject], "alex", WIRE_NOW).ok).toBe(true);
  const narrowed = await same(wire, "/tasks", { cookie: cookies["pat"]! });
  expect(narrowed.body).not.toBe(before.body);
  expect(narrowed.body).not.toContain("payments-api");
  await same(wire, "/tasks?layout=board", { cookie: cookies["pat"]! });
  expect(wire.store.revokeAccount("pat", "alex", WIRE_NOW).ok).toBe(true);
  const revoked = await same(wire, "/tasks", { cookie: cookies["pat"]! });
  expect(revoked.status).not.toBe(200);
}, 300_000);

test("overlapping requests for different accounts each read their own answer", async () => {
  const reads_ = [["alex", "/chat"], ["sam", "/tasks"], ["robin", "/"], ["sam", "/tasks?layout=board"], ["alex", "/tasks?state=failed"]] as const;
  reads.off = true;
  const bare = await Promise.all(reads_.map(([who, path]) => send(wire, withFormat(path), asRead({ cookie: cookies[who]! }, true))));
  const alone = [];
  for (const [who, path] of reads_) alone.push(await send(wire, withFormat(path), asRead({ cookie: cookies[who]! }, true)));
  reads.off = false;
  const together = await Promise.all(reads_.map(([who, path]) => send(wire, withFormat(path), asRead({ cookie: cookies[who]! }, true))));
  for (const [index, [who, path]] of reads_.entries()) {
    expect(normalized(together[index]!.body), `${who} ${path}`).toBe(normalized(alone[index]!.body));
    expect(normalized(bare[index]!.body), `${who} ${path}`).toBe(normalized(alone[index]!.body));
  }
}, 300_000);

test("a commit by another process between reads is read at once", async () => {
  const before = await same(wire, "/tasks", { cookie: cookies["alex"]! });
  const file = join(wire.root, "config", "orders.db");
  execFileSync(process.execPath, ["--no-warnings", "-e", `const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("UPDATE task SET title = 'Renamed by another process' WHERE id = ?").run(process.argv[2]); db.close();`, file, world.probeTask]);
  const after = await same(wire, "/tasks", { cookie: cookies["alex"]! });
  expect(after.body).not.toBe(before.body);
  await same(wire, `/t/${encodeURIComponent(world.probeTask)}`, { cookie: cookies["sam"]! });
}, 300_000);
