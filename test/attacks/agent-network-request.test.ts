/**
 * An agent's network request lives in an unauthenticated, editable JSON file, and was once approved by re-posting the
 * full next state captured when it was filed. Now the file is only a proposal: the server derives the exact change
 * from (project, kind, hosts to add or remove, and the mode or local services only when asked for) against the setting
 * NOW, shows those terms with a digest on the project's settings page, and applies them only when the approval carries
 * that digest. A stale approval is refused, a host removed since is never re-added, and a forged summary or forged full
 * state changes nothing that applies.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "../../src/store.js";
import { addApprover } from "../../src/scope.js";
import { createDecisionServer } from "../../src/serve.js";
import { agentRequestsPath, fileAgentRequest, listAgentRequests } from "../../src/agent-requests.js";
import { NETWORK_REQUEST_CHANGED, NETWORK_REQUEST_OLD } from "../../src/agent-network-request.js";

let dir: string, repo: string, store: Store, server: Server, base: string, password: string, database: string;
const NOW = new Date();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-agent-net-"));
  repo = join(dir, "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  database = join(dir, "orders.db");
  store = openStore(database);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  password = alex.token;
  const made = store.createConsoleTask({ title: "known", repo, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, NOW);
  if (!made.ok) throw new Error(made.reason);
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo, platform: "darwin", fenceAvailable: () => true });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const signIn = async () => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" }))
  .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
const page = async (cookie: string) => (await fetch(`${base}/settings/project?repo=${encodeURIComponent(repo)}`, { headers: { cookie } })).text();
const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
const unescape = (text: string) => text.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The terms the page shows for one request: what the Mac app reads too. */
const shown = (html: string, id: string): { digest: string; after: { hosts: string[]; mode: string; loopback: string }; words: string[] } | null => {
  const at = new RegExp(`data-agent-request="${id}" data-agent-request-digest="([0-9a-f]{32})" data-agent-request-terms="([^"]*)"`).exec(html);
  return at === null ? null : JSON.parse(unescape(at[2]!)) as never;
};
const approve = async (cookie: string, csrf: string, id: string, digest: string) => {
  const answer = await fetch(`${base}/settings/project/network`, { method: "POST", headers: { cookie, origin: base },
    body: new URLSearchParams({ csrf, repo, request: id, digest, password, mode: "open", hosts: "evil.example.com", local: "any" }), redirect: "manual" });
  return decodeURIComponent(answer.headers.get("location") ?? "");
};
const request = (change: object, summary = "Allow hosts: api.stripe.com") =>
  fileAgentRequest(database, { kind: "network", repo, summary, why: "tests call Stripe", params: { change } as never }, NOW);

test("the change applies to the setting now: a host removed since the request is never re-added; the posted full state is ignored", async () => {
  store.setProjectNetwork(repo, { mode: "allowlist", hosts: ["old.example.com", "keep.example.com"], loopback: "proxy-only" }, "alex", NOW);
  const filed = request({ add: ["api.stripe.com"] });
  // After filing, a person removes old.example.com.
  store.setProjectNetwork(repo, { mode: "allowlist", hosts: ["keep.example.com"], loopback: "proxy-only" }, "alex", NOW);
  const cookie = await signIn();
  const html = await page(cookie);
  const terms = shown(html, filed.id)!;
  expect(terms.after).toEqual({ mode: "allowlist", hosts: ["api.stripe.com", "keep.example.com"], loopback: "proxy-only" });
  expect(await approve(cookie, csrfOf(html), filed.id, terms.digest)).toContain("Approved the agent's request.");
  expect(store.projectNetwork(repo)).toEqual({ mode: "allowlist", hosts: ["api.stripe.com", "keep.example.com"], loopback: "proxy-only" });
  expect(listAgentRequests(database).find(one => one.id === filed.id)?.status).toBe("approved");
});

test("a stale approval is refused: the setting changed after the page was read, and nothing changes", async () => {
  const filed = request({ add: ["api.stripe.com"] });
  const cookie = await signIn();
  const html = await page(cookie);
  const terms = shown(html, filed.id)!;
  store.setProjectNetwork(repo, { mode: "allowlist", hosts: ["other.example.com"], loopback: "proxy-only" }, "alex", NOW);
  expect(await approve(cookie, csrfOf(html), filed.id, terms.digest)).toContain(NETWORK_REQUEST_CHANGED);
  expect(store.projectNetwork(repo).hosts).toEqual(["other.example.com"]);
  expect(listAgentRequests(database).find(one => one.id === filed.id)?.status).toBe("pending");
});

test("the request edited after it was shown (a wider change under the same id) is refused", async () => {
  const filed = request({ add: ["api.stripe.com"] });
  const cookie = await signIn();
  const html = await page(cookie);
  const terms = shown(html, filed.id)!;
  const path = agentRequestsPath(database);
  const file = JSON.parse(readFileSync(path, "utf8")) as { requests: { params: { change: object } }[] };
  file.requests[0]!.params.change = { add: ["api.stripe.com"], mode: "open" };
  writeFileSync(path, JSON.stringify(file));
  expect(await approve(cookie, csrfOf(html), filed.id, terms.digest)).toContain(NETWORK_REQUEST_CHANGED);
  expect(store.projectNetwork(repo).mode).toBe("allowlist");
});

test("a forged summary or forged full state never changes what applies; a request with no explicit change is refused", async () => {
  const forged = fileAgentRequest(database, { kind: "network", repo, summary: "Allow hosts: api.stripe.com", why: "",
    params: { mode: "open", local: "any", hosts: ["evil.example.com"], change: { add: ["api.stripe.com"] } } }, NOW);
  const old = fileAgentRequest(database, { kind: "network", repo, summary: "Allow hosts: api.stripe.com", why: "", params: { mode: "open", hosts: ["evil.example.com"] } }, NOW);
  const cookie = await signIn();
  const html = await page(cookie);
  const terms = shown(html, forged.id)!;
  // The page's words are the server's, from the change alone.
  expect(terms.words).toEqual(["Allow api.stripe.com", "Builds may then reach api.stripe.com."]);
  expect(shown(html, old.id)).toBeNull();
  expect(await approve(cookie, csrfOf(html), forged.id, terms.digest)).toContain("Approved");
  expect(store.projectNetwork(repo)).toEqual({ mode: "allowlist", hosts: ["api.stripe.com"], loopback: "proxy-only" });
  // An older request carries only a full state: never applied.
  expect(await approve(cookie, csrfOf(await page(cookie)), old.id, "0".repeat(32))).toContain(NETWORK_REQUEST_OLD);
  expect(store.projectNetwork(repo).hosts).toEqual(["api.stripe.com"]);
});
