/**
 * Fast reads (docs/TESTING.md "Wire budgets"): what each account sees on the everyday pages never changes when the
 * server reads them more cheaply. On a seeded wire world (test/wire-world.ts, a smaller one than the budgets' 10,000
 * tasks, fixed clock and randomness) this renders, for the operator, an approver on every project, an approver limited
 * to two projects and a viewer limited to one (each signed in with a browser session): Home, Tasks (its default list,
 * its second page, a state filter, the completed and archived views, one project's list, the board), a result page in
 * another project, a result page in the viewer's own project, a task page, Projects and Chat — the document load and the
 * in-place read — and holds every answer to the digest of what main sent (fast-reads.golden.json, written from main's
 * code with FAST_READS_WRITE_GOLDEN=1; since the work reads exist, written with FAST_READS_BARE=1 too, which reads every
 * page without them). Some answers are refusals (the viewer's other-project result is a 404; Chat
 * refuses project-limited accounts): those are held too. A page that differs by one byte fails here, and its body is
 * left in FAST_READS_OUT to compare.
 *
 * What this does NOT cover (fast-reads-boundaries.slow.test.ts and work-reads.test.ts do): API tokens, local-owner
 * sessions, accounts revoked or narrowed mid-session, overlapping requests, commits by another process, clock
 * boundaries. Requests here are sequential and the clock is fixed.
 *
 * Only what depends on where the run happened is normalized: the world's temp folder and the digests over it, the port,
 * and the per-session tokens a sign-in or a form mints (each the same length every run, never content).
 */
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { seeded, seedWireWorld, WIRE_NOW, type WireWorld } from "../test/wire-world.js";
import type { DecisionServer } from "./serve.js";
import type { Store } from "./store.js";

// FAST_READS_BARE=1 serves every read without its request's work reads (as main read every page before they were made
// cheap): the golden is written that way, and an ordinary run, with them, must match it byte for byte.
vi.mock("./work-reads.js", async importOriginal => {
  const real = await importOriginal<typeof import("./work-reads.js")>();
  return process.env["FAST_READS_BARE"] === "1" ? { ...real, withWorkReads: <T>(run: () => T): T => run() } : real;
});

process.env["TZ"] = "UTC";
const GOLDEN = join(import.meta.dirname, "fast-reads.golden.json");
const TASKS = 1_200;
/** Where a changed body is left to compare (the run's temp root is removed at the end, so name a folder to keep them). */
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

/** The account's second Work page: the link its first page's in-place read names (its own first page if none). */
async function nextPageOf(who: string): Promise<string> {
  const first = await send("/?view=all&format=workspace", { cookie: cookies[who]!, accept: "application/json", "x-toolroll-read": "navigate", "x-toolroll-work": "1" });
  return /"next":"(\/\?cursor=[A-Za-z0-9_-]+)"/.exec(first.body)?.[1] ?? "/?view=all";
}

/** Where and when the run happened, and the tokens a sign-in mints, as fixed stand-ins. */
function normalized(text: string): string {
  let out = text;
  for (const [from, to] of [[root, "/wire-world"], [encodeURIComponent(root), encodeURIComponent("/wire-world")], [`127.0.0.1:${port}`, "127.0.0.1:65000"]] as const) out = out.split(from).join(to);
  // Per-session secrets (the form token, each page's script nonce): the same length every run, never content.
  // A form's one-time request id (a hidden field, and the chat composer's requestId), raw and inside escaped HTML.
  return out.replace(/("csrf":"|name=\\?"csrf\\?" value=\\?"|nonce=\\?"|"nonce":")[A-Za-z0-9_\-+/=]+/g, "$1<token>")
    .replace(/(name=\\?"request\\?" value=\\?"|"requestId":"|"request":")[0-9a-f]{32}/g, "$1<request>")
    // Digests over the world's own paths (a result's receipt, a task's source, a page revision): fixed length, the folder
    // decides their value. A page cursor's scope is one too, inside its base64url.
    .replace(/(name=\\?"(?:receipt|source)\\?" value=\\?"|"(?:receipt|source)":")[0-9a-f]{64}/g, "$1<digest>")
    .replace(/"revision":"[0-9a-f]{16}"/g, '"revision":"<digest>"')
    .replace(/cursor=([A-Za-z0-9_-]{20,})/g, (whole, token: string) => {
      try {
        const cursor = JSON.parse(Buffer.from(token, "base64url").toString()) as Record<string, unknown>;
        return typeof cursor["scope"] === "string" ? `cursor=${Buffer.from(JSON.stringify({ ...cursor, scope: "0".repeat(64) })).toString("base64url")}` : whole;
      } catch { return whole; }
    });
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

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

test("every account sees byte for byte what it saw before the reads were made cheap", async () => {
  // A finished result in the viewer's own project, for a viewer's successful result read.
  const ownResult = String(store.handle.prepare(`SELECT t.id FROM task t JOIN task_ref r ON r.backend = 'built-in' AND r.external_id = t.id
    WHERE r.repo = ? AND t.state = 'done' AND r.revision_of IS NULL AND EXISTS(SELECT 1 FROM run WHERE task_ref = r.id AND finished_at IS NOT NULL AND role = 'builder' AND outcome = 'built')
    ORDER BY t.id LIMIT 1`).get(world.samProject)?.["id"]);
  const pages: [string, string | ((who: string) => Promise<string>)][] = [
    ["Work", "/"], ["Work (needs you)", "/?view=needs-you"], ["Work (next page)", nextPageOf], ["Work (state filter: failed)", "/?state=failed"],
    ["Work (completed)", "/?view=completed"], ["Work (archived)", "/?view=archived"], ["Work (one project)", `/?project=${encodeURIComponent(world.samProject)}`],
    ["Work (board)", "/?view=board"], ["Result", `/t/${encodeURIComponent(world.resultTask)}?tab=result`], ["Result (viewer's project)", `/t/${encodeURIComponent(ownResult)}?tab=result`],
    ["Task", `/t/${encodeURIComponent(world.probeTask)}`], ["Projects", "/projects"], ["Chat", "/chat"],
  ];
  const seen: Record<string, string> = {};
  const bodies: Record<string, string> = {};
  // Every page twice over, the second time after every other read: nothing a read leaves behind changes a later one.
  // FAST_READS_DUMP=1 keeps every body of the first pass in FAST_READS_OUT.
  for (const pass of [1, 2]) {
    for (const who of ["alex", "robin", "pat", "sam"] as const) {
      for (const [name, at] of pages) {
        const path = typeof at === "string" ? at : await at(who);
        const doc = await send(path, { cookie: cookies[who]!, accept: "text/html" });
        const inPlace = await send(`${path}${path.includes("?") ? "&" : "?"}format=workspace`, { cookie: cookies[who]!, accept: "application/json", "x-toolroll-read": "navigate", "x-toolroll-work": "1" });
        for (const [kind, answer] of [["document", doc], ["in-place read", inPlace]] as const) {
          const key = `${who} · ${name} · ${kind}`, body = normalized(answer.body);
          const value = `${answer.status} ${String(answer.headers.location ?? "")} ${body.length} ${digest(body)}`;
          if (pass === 1) { seen[key] = value; bodies[key] = body; if (process.env["FAST_READS_DUMP"] === "1") writeFileSync(join(OUT, `all-${key.replace(/[^a-z0-9]+/gi, "-")}.txt`), body); continue; }
          if (value !== seen[key]) for (const [at, text] of [["first", bodies[key]!], ["again", body]]) writeFileSync(join(OUT, `fast-reads-${key.replace(/[^a-z0-9]+/gi, "-")}.${at}.txt`), text);
          expect(value, `${key}, read again`).toBe(seen[key]);
        }
      }
    }
  }
  expect(Object.keys(seen)).toHaveLength(4 * pages.length * 2);
  if (process.env["FAST_READS_WRITE_GOLDEN"] === "1") {
    writeFileSync(GOLDEN, `${JSON.stringify({ note: "src/fast-reads.slow.test.ts: what each account received before the reads were made cheap.", tasks: TASKS, pages: seen }, null, 2)}\n`);
    return;
  }
  expect(existsSync(GOLDEN), "fast-reads.golden.json").toBe(true);
  const golden = (JSON.parse(readFileSync(GOLDEN, "utf8")) as { pages: Record<string, string> }).pages;
  const changed = Object.keys(golden).filter(key => golden[key] !== seen[key]);
  for (const key of changed) writeFileSync(join(OUT, `fast-reads-${key.replace(/[^a-z0-9]+/gi, "-")}.txt`), bodies[key] ?? "");
  expect(changed, `changed bodies are in ${OUT}/fast-reads-*.txt`).toEqual([]);
  expect(Object.keys(seen).sort()).toEqual(Object.keys(golden).sort());
}, 600_000);
