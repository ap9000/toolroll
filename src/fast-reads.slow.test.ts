/**
 * Fast reads (docs/TESTING.md "Wire budgets"): what each account sees on the everyday pages is exactly what the plain
 * reads give. On a seeded wire world (test/wire-world.ts, a smaller one than the budgets' 10,000 tasks, fixed clock and
 * randomness) this renders, for the operator, an approver on every project, an approver limited to two projects and a
 * viewer limited to one (each signed in with a browser session): Home, Tasks (its default list, its second page, a state
 * filter, the completed and archived views, one project's list, the board), a result page in another project, a result
 * page in the viewer's own project, a task page, Projects and Chat — the document load and the in-place read. Each read
 * is served twice by the SAME code: once with the request's work reads (work-reads.ts: the kept projection, the saved
 * answers, the batched reads) and once without them (this file's mock makes withWorkReads run the read bare, the plain
 * path every read took before), and the two bodies must be byte for byte the same. Some answers are refusals (the
 * viewer's other-project result is a 404; Chat refuses project-limited accounts): those must match too. A page that
 * differs by one byte fails here, and both bodies are left in FAST_READS_OUT to compare. Nothing here is frozen: a page
 * may change as the product changes; the two paths may never differ.
 *
 * The plain side really is plain: before every read the workspace revision moves, and this file counts every work-reads
 * scope the server opens and every chrome read the per-revision cache answers — neither may happen on the plain side,
 * scopes must open on the fast side. A seeded divergence (one list row dropped on the fast side only) must be caught,
 * on a page that reads its list directly (Tasks) and on one that reads it through the chrome cache (Chat).
 *
 * What this does NOT cover (fast-reads-boundaries.slow.test.ts and work-reads.test.ts do): API tokens, local-owner
 * sessions, accounts revoked, narrowed or deleted mid-session, overlapping requests, commits by another process, clock
 * boundaries, the live summary room. Requests here are sequential and the clock is fixed.
 *
 * Only per-request tokens are normalized (a page's script nonce, a form's one-time request id): both sides run in one
 * process, one world, one port and one session per account.
 */
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seeded, seedWireWorld, WIRE_NOW, type WireWorld } from "../test/wire-world.js";
import type { DecisionServer } from "./serve.js";
import type { Store } from "./store.js";

/** `off`: reads run bare (the plain path). `opened`: work-reads scopes the server's reads proved, by side. `canary`: drop
 * the first row of every work index page on the fast side only (a seeded divergence this file must catch). */
const reads = vi.hoisted(() => ({ off: false, canary: false, opened: { fast: 0, plain: 0 }, cached: { fast: 0, plain: 0 } }));
vi.mock("./work-reads.js", async importOriginal => {
  const real = await importOriginal<typeof import("./work-reads.js")>();
  return {
    ...real,
    withWorkReads: <T>(run: () => T): T => reads.off ? run() : real.withWorkReads(run),
    workReadsOf: (store: Parameters<typeof real.workReadsOf>[0]) => {
      const kept = real.workReadsOf(store);
      if (kept !== null) reads.opened[reads.off ? "plain" : "fast"]++;
      return kept;
    },
  };
});
/** `cached`: chrome reads (the sidebar's states, the Tasks count, the chat landing's views) answered from the server's
 * per-revision cache rather than computed, by side. */
vi.mock("./console-chrome.js", async importOriginal => {
  const real = await importOriginal<typeof import("./console-chrome.js")>();
  class CountingCache extends real.RevisionCache {
    override read<T>(key: string, compute: () => T): T {
      if (this.peek<T>(key) !== undefined) reads.cached[reads.off ? "plain" : "fast"]++;
      return super.read(key, compute);
    }
  }
  return { ...real, RevisionCache: CountingCache };
});
vi.mock("./work-index.js", async importOriginal => {
  const real = await importOriginal<typeof import("./work-index.js")>();
  return {
    ...real,
    workIndexPage: (...args: Parameters<typeof real.workIndexPage>) => {
      const page = real.workIndexPage(...args);
      return reads.canary && !reads.off ? { ...page, items: page.items.slice(1) } : page;
    },
  };
});

process.env["TZ"] = "UTC";
const TASKS = 1_200;
/** Where a differing pair of bodies is left to compare (the run's temp root is removed at the end). */
const OUT = process.env["FAST_READS_OUT"] ?? tmpdir();

let root: string, store: Store, server: DecisionServer, world: WireWorld, port: number;
const cookies: Record<string, string> = {};
let people: Record<string, string>;
const realRandom = Math.random;

type Answer = { status: number; body: string; headers: IncomingHttpHeaders };
function send(path: string, headers: Record<string, string>, method = "GET", body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, connection: "close", ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
const IN_PLACE = { accept: "application/json", "x-toolroll-read": "navigate", "x-toolroll-work": "1" };
const withFormat = (path: string) => `${path}${path.includes("?") ? "&" : "?"}format=workspace`;

/** The account's second Tasks page: the link its first page's in-place read names (its own first page if none). */
async function nextPageOf(who: string): Promise<string> {
  const first = await send(withFormat("/tasks"), { cookie: cookies[who]!, ...IN_PLACE });
  return /"next":"(\/tasks\?cursor=[A-Za-z0-9_-]+)"/.exec(first.body)?.[1] ?? "/tasks";
}

/** Per-request tokens only: a page's script nonce and a form's one-time request id, raw and inside escaped HTML. */
const normalized = (text: string) => text.replace(/(nonce=\\?"|"nonce":")[A-Za-z0-9_\-+/=]+/g, "$1<token>")
  .replace(/(name=\\?"request\\?" value=\\?"|"requestId":")[0-9a-f]{32}/g, "$1<request>");

/** "After any change": the workspace revision moves (a cache-metadata row only), so no per-revision cache the server
 * holds answers the next read: each side computes its own. */
function bump(): void {
  store.handle.exec(`INSERT INTO service_cursor(key,value,updated_at) VALUES ('workspace-content:v1',1,'${WIRE_NOW.toISOString()}')
    ON CONFLICT(key) DO UPDATE SET value=service_cursor.value+1`);
}

/** One read served on one side, the side's caches cold. */
async function served(path: string, headers: Record<string, string>, plain: boolean): Promise<Answer> {
  reads.off = plain;
  try { bump(); return await send(path, headers); } finally { reads.off = false; }
}
/** Status, redirect and the normalized body: what the account received. */
const received = (answer: Answer) => `${answer.status} ${String(answer.headers.location ?? "")}\n${normalized(answer.body)}`;

beforeAll(async () => {
  Math.random = seeded(7);
  vi.useFakeTimers({ toFake: ["Date"], now: WIRE_NOW });
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-fast-reads-")));
  const { openStore } = await import("./store.js");
  const { createDecisionServer } = await import("./serve.js");
  store = openStore(join(root, "config", "orders.db"));
  world = seedWireWorld(store, root, { tasks: TASKS });
  // An approver limited to two projects (the measured result's and the viewer's), beside the world's three people.
  const { addApprover } = await import("./scope.js");
  const pat = addApprover(store, "pat", new Date(WIRE_NOW.getTime() - 86_400_000), { name: "alex", token: world.people.alex });
  if (!pat.ok || !store.setAccountProjects("pat", [world.repos[0]!, world.samProject], "alex", new Date(WIRE_NOW.getTime() - 86_400_000)).ok) throw Error("pat");
  people = { ...world.people, pat: pat.token };
  const refuse = async (): Promise<never> => { throw Error("these reads never call a model or the network"); };
  server = createDecisionServer({
    store, evidenceRoot: world.evidenceRoot, repos: world.repos, clock: () => new Date(WIRE_NOW), connectionHome: root, toolHome: root, fenceAvailable: false,
    connectionProbe: async () => ({ code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false }),
    modelCatalogFetcher: refuse as typeof fetch, chatFetcher: refuse as typeof fetch, subscriptionChatRunner: refuse,
    modelRunner: async () => ({ code: 1, stdout: "", stderr: "" }),
    firstTaskRunner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: true }),
    ghList: async () => ({ ok: false, reason: "gh-missing", message: "gh is not installed" }) as never,
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  for (const [who, token] of Object.entries(people)) {
    const login = await send("/login", { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${port}` }, "POST", new URLSearchParams({ name: who, token }).toString());
    if (login.status !== 303) throw Error(`sign-in for ${who}: ${login.status}`);
    cookies[who] = String(login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  }
}, 300_000);

afterAll(async () => {
  Math.random = realRandom;
  vi.useRealTimers();
  if (server?.listening) { server.closeAllConnections?.(); await new Promise<void>(resolve => server.close(() => resolve())); }
  store?.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

let pages: [string, string | ((who: string) => Promise<string>)][];
const ACCOUNTS = ["alex", "robin", "pat", "sam"] as const;

/** Every page, both kinds, for every account: the pairs that differ (their bodies left in FAST_READS_OUT). */
async function differing(): Promise<string[]> {
  const out: string[] = [];
  for (const who of ACCOUNTS) {
    for (const [name, at] of pages) {
      const path = typeof at === "string" ? at : await at(who);
      for (const [kind, url, headers] of [["document", path, { cookie: cookies[who]!, accept: "text/html" }], ["in-place read", withFormat(path), { cookie: cookies[who]!, ...IN_PLACE }]] as const) {
        const fast = received(await served(url, headers, false)), plain = received(await served(url, headers, true));
        if (fast === plain) continue;
        const key = `${who} · ${name} · ${kind}`;
        out.push(key);
        for (const [side, text] of [["fast", fast], ["plain", plain]]) writeFileSync(join(OUT, `fast-reads-${key.replace(/[^a-z0-9]+/gi, "-")}.${side}.txt`), text);
      }
    }
  }
  return out;
}

test("every account receives byte for byte what the plain reads give", async () => {
  // A finished result in the viewer's own project, for a viewer's successful result read.
  const ownResult = String(store.handle.prepare(`SELECT t.id FROM task t JOIN task_ref r ON r.backend = 'built-in' AND r.external_id = t.id
    WHERE r.repo = ? AND t.state = 'done' AND r.revision_of IS NULL AND EXISTS(SELECT 1 FROM run WHERE task_ref = r.id AND finished_at IS NOT NULL AND role = 'builder' AND outcome = 'built')
    ORDER BY t.id LIMIT 1`).get(world.samProject)?.["id"]);
  pages = [
    ["Home", "/"], ["Tasks", "/tasks"], ["Tasks (next page)", nextPageOf], ["Tasks (state filter: failed)", "/tasks?state=failed"],
    ["Tasks (completed)", "/tasks?view=completed"], ["Tasks (archived)", "/tasks?view=archived"], ["Tasks (one project)", `/tasks?project=${encodeURIComponent(world.samProject)}`],
    ["Tasks (board)", "/tasks?layout=board"], ["Result", `/t/${encodeURIComponent(world.resultTask)}?tab=result`], ["Result (viewer's project)", `/t/${encodeURIComponent(ownResult)}?tab=result`],
    ["Task", `/t/${encodeURIComponent(world.probeTask)}`], ["Projects", "/projects"], ["Chat", "/chat"],
  ];
  reads.opened = { fast: 0, plain: 0 }; reads.cached = { fast: 0, plain: 0 };
  expect(await differing(), `differing bodies are in ${OUT}/fast-reads-*.txt`).toEqual([]);
  // The plain side never read through the request's work reads; the fast side did.
  expect(reads.opened.plain).toBe(0);
  expect(reads.cached.plain, "plain reads answered from the chrome cache").toBe(0);
  expect(reads.opened.fast).toBeGreaterThan(0);
}, 600_000);

test("a divergence on the fast side alone is caught", async () => {
  reads.canary = true;
  try {
    // Tasks reads its list directly; Chat reads its views through the per-revision chrome cache, so a plain read that
    // could reuse a fast read's cached view would hide the divergence there.
    const all = pages;
    pages = all.filter(([name]) => name === "Tasks" || name === "Chat");
    let caught: string[];
    try { caught = await differing(); } finally { pages = all; }
    // Every one of them lost a row on the fast side only (Chat's refusal pages too, through their sidebar).
    expect(caught.sort()).toEqual(ACCOUNTS.flatMap(who => ["Tasks", "Chat"].flatMap(name => [`${who} · ${name} · document`, `${who} · ${name} · in-place read`])).sort());
  } finally { reads.canary = false; }
}, 300_000);
