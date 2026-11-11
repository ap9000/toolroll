/**
 * Read purposes on workspace reads (docs/plans/live-pages-and-home.md A1.4): a re-read and a read ahead never extend the
 * session, a followed link does exactly where the page's own document load would, and every existing no-touch read
 * stays one whatever its header says. A read ahead changes nothing (no write, no nonce, no session time), is answered
 * only for a browser session and only on its allowlist, and is 204 for everything else. And `inPlace` (A1.1): the
 * allowlisted pages say it; the welcome page, the terminal and the Agents Live grid never do.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintApiToken } from "./api-tokens.js";
import type { BrowserWorkspace } from "./browser-workspace.js";
import { addApprover, propose } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { PersistentSessions } from "./server/session.js";
import { openStore, type Store } from "./store.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
let store: Store, server: Server, directory: string, repo: string, base: string, password: string;

beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "so-read-purpose-")));
  repo = join(directory, "repo"); mkdirSync(repo);
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
  const account = addApprover(store, "alex", NOW);
  if (!account.ok) throw new Error("account fixture");
  password = account.token;
  // A task whose plan waits: its page mints an approval nonce when a person reads it.
  store.createTask({ id: "t-plan", title: "Guard the limiter" }, NOW);
  store.placeTask(store.refFor("built-in", "t-plan", "ours").id, repo);
  propose(store, { taskId: "t-plan", goal: "Guard the limiter", now: NOW });
  server = createDecisionServer({ store, evidenceRoot: join(directory, "evidence"), repos: [repo], clock: () => new Date(),
    connectionProbe: async (file: string) => ({ code: 1, stdout: file === "codex" ? "Not logged in\n" : JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false }),
    firstTaskRunner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: false }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server fixture");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

async function login(): Promise<{ cookie: string; hash: string }> {
  const response = await fetch(base + "/login", { method: "POST", redirect: "manual", body: new URLSearchParams({ name: "alex", token: password }) });
  expect(response.status).toBe(303);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, hash: PersistentSessions.hash(cookie.split("=")[1]!) };
}

const writes = (): number => Number(store.raw().prepare("SELECT total_changes() AS n").get()?.["n"] ?? 0);

/** The session's kept last-seen time after one read made a minute and more after the last save (saves are once a minute). */
let clockAt = Date.now();
async function seenAfter(hash: string, read: () => Promise<Response>): Promise<{ moved: boolean; response: Response }> {
  clockAt += 120_000;
  vi.spyOn(Date, "now").mockReturnValue(clockAt);
  const before = store.webSession(hash)!.lastSeen;
  const response = await read();
  await response.arrayBuffer();
  const after = store.webSession(hash)!.lastSeen;
  vi.restoreAllMocks();
  return { moved: after !== before, response };
}

const read = (cookie: string, path: string, purpose?: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { redirect: "manual", headers: { cookie, accept: "application/json", ...(purpose === undefined ? {} : { "x-toolroll-read": purpose }), ...headers } });

test("the session table: a re-read and a read ahead never extend it, a followed link does, and every no-touch read stays one", async () => {
  const { cookie, hash } = await login();
  clockAt = Date.now();
  for (const [path, purpose, extends_] of [
    ["/tasks?format=workspace", undefined, false],
    ["/tasks?format=workspace", "poll", false],
    ["/tasks?format=workspace", "something-else", false],
    ["/tasks?format=workspace", "prefetch", false],
    ["/tasks?format=workspace", "navigate", true],
    ["/?format=workspace", "navigate", true],
    // The no-touch reads keep their rule whatever the header says.
    ["/agents?view=live&format=workspace", "navigate", false],
    ["/tasks?fragment=rail&format=workspace", "navigate", false],
    ["/term/state?format=workspace", "navigate", false],
    [`/code/${"a".repeat(32)}/state?format=workspace`, "navigate", false],
    ["/agents/live?format=workspace", "navigate", false],
    // The header means nothing on a request that is not a workspace read: the page's own GET extends, as today.
    ["/tasks", "prefetch", true],
    ["/tasks", undefined, true],
  ] as const) {
    const { moved } = await seenAfter(hash, () => read(cookie, path, purpose));
    expect(moved, `${path} ${purpose ?? "(no header)"}`).toBe(extends_);
  }
});

test("the header does nothing on a page's own GET: it answers the page, not 204", async () => {
  const { cookie } = await login();
  const page = await fetch(base + "/settings", { redirect: "manual", headers: { cookie, "x-toolroll-read": "prefetch" } });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
});

test("a read ahead changes nothing, on every allowlisted page and its query variants", async () => {
  const { cookie, hash } = await login();
  clockAt = Date.now();
  for (const path of ["/", `/?project=${encodeURIComponent(repo)}`, "/tasks", `/tasks?project=${encodeURIComponent(repo)}`, "/tasks?view=needs-you", "/tasks?page=2",
    "/projects", "/agents", "/agents?run=1", "/search", "/search?q=limiter", "/t/t-plan"]) {
    const address = path + (path.includes("?") ? "&" : "?") + "format=workspace";
    const before = writes();
    const { moved, response } = await seenAfter(hash, () => read(cookie, address, "prefetch"));
    expect(response.status, path).toBe(200);
    expect(writes(), `${path} wrote`).toBe(before);
    expect(moved, `${path} extended the session`).toBe(false);
  }
});

test("a read ahead of a task page mints no approval nonce; the followed link mints one, as the page's document does", async () => {
  const { cookie } = await login();
  const ahead = await (await read(cookie, "/t/t-plan?format=workspace", "prefetch")).text();
  expect(ahead).toContain("unminted");
  const followed = await (await read(cookie, "/t/t-plan?format=workspace", "navigate")).text();
  expect(followed).not.toContain("unminted");
  expect(followed).toMatch(/name=\\?"nonce\\?" value=\\?"[0-9a-f]{32}\\?"|"nonce":"[0-9a-f]{32}"/);
});

test("a read ahead from anything but a browser session, or of any page off the allowlist, is 204 and writes nothing", async () => {
  const { cookie } = await login();
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: "laptop", secretHash: minted.hash, access: "act", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
  const before = writes();
  for (const [path, headers] of [
    ["/tasks?format=workspace", { authorization: `Bearer ${minted.token}` }],
    ["/tasks?format=workspace", {}],
    ["/tasks?format=workspace", { cookie: `standing-orders_session=${"0".repeat(64)}` }],
    ["/settings?format=workspace", { cookie }],
    ["/welcome?format=workspace", { cookie }],
    ["/chat?format=workspace", { cookie }],
    ["/term?format=workspace", { cookie }],
    ["/agents?view=live&format=workspace", { cookie }],
    ["/t/t-plan/release?format=workspace", { cookie }],
    ["/login?format=workspace", {}],
  ] as const) {
    const response = await fetch(base + path, { redirect: "manual", headers: { accept: "application/json", "x-toolroll-read": "prefetch", ...headers } });
    expect(response.status, `${path} ${Object.keys(headers).join(",")}`).toBe(204);
    expect(await response.text()).toBe("");
  }
  expect(writes()).toBe(before);
  expect(store.apiTokenSecret(minted.id)?.row.lastUsedAt).toBeNull();
});

test("inPlace: the allowlisted pages say it; the welcome page, the terminal and the Live grid never do", async () => {
  const { cookie } = await login();
  const inPlaceOf = async (path: string): Promise<boolean | "no workspace"> => {
    const response = await read(cookie, path, "navigate");
    if (response.status !== 200 || !(response.headers.get("content-type") ?? "").includes("application/json")) { await response.arrayBuffer(); return "no workspace"; }
    return ((await response.json()) as BrowserWorkspace).inPlace === true;
  };
  for (const path of ["/?format=workspace", "/tasks?format=workspace", "/projects?format=workspace", "/agents?format=workspace", "/search?format=workspace"])
    expect(await inPlaceOf(path), path).toBe(true);
  for (const path of ["/welcome?format=workspace", "/term?format=workspace", "/agents?view=live&format=workspace", "/agents/terminals?format=workspace", "/chat?format=workspace"])
    expect(await inPlaceOf(path), path).not.toBe(true);
  // A page that asks for a password (this plan's approval) is sensitive: never in place, though its route is listed.
  const task = await (await read(cookie, "/t/t-plan?format=workspace", "navigate")).json() as BrowserWorkspace;
  expect(task.sensitive && task.inPlace).toBe(false);
});
