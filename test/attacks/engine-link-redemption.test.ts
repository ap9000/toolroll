/**
 * The engine API's link redemption (solo-workbench plan A0, POST /login/once): a terminal client redeems the local
 * owner's one-time link for the same local-owner session a browser gets, with the cookie, form token and mutation key
 * in a no-store JSON body. Each property the browser road has is tried here: one time across both roads, never a
 * browser's (Origin, Sec-Fetch, a simple-request shape), this computer only, the console's own canonical host only,
 * local-owner links only, bound to local mode's generation and to this console start's key epoch.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { join } from "node:path";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { linkRedemptionSchema } from "../../src/contracts/engine-api.js";
import { keyHashOf } from "../../src/server/mutation-key.js";
import { createDecisionServer } from "../../src/serve.js";
import { setLocalModeOff } from "../../src/store.js";

let world: LocalWorld;
beforeEach(async () => { world = await openLocalWorld({ browserKey: true }); }, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

const TERMINAL = { "content-type": "application/json", accept: "application/json", "x-toolroll-client": "terminal" };
const codeOf = (link: string) => link.slice("/login/once/".length);
const redeem = (code: string, headers: Record<string, string> = TERMINAL, port = world.port) =>
  world.send("/login/once", "POST", { host: `127.0.0.1:${port}`, ...headers }, JSON.stringify({ code }));
const sessions = () => world.store.webSessions("alex").length;
const refusals = () => world.store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE outcome = 'sign-in refused'").get()?.["n"];

test("a local owner's link becomes the local-owner session, its cookie, form token and key in a no-store body", async () => {
  const answer = await redeem(codeOf(world.server.mintLocalLink()!));
  expect(answer.status).toBe(200);
  expect(answer.headers["cache-control"]).toBe("no-store");
  expect(answer.headers["pragma"]).toBe("no-cache");
  expect(answer.headers["referrer-policy"]).toBe("no-referrer");
  // The body carries the cookie; no browser cookie jar is ever handed one.
  expect(answer.headers["set-cookie"]).toBeUndefined();
  const body = linkRedemptionSchema.parse(JSON.parse(answer.body));
  expect(body).toMatchObject({ account: "alex", cookie: { name: "standing-orders_session" }, epoch: world.server.keyEpoch });
  // The very session the browser road makes: local-owner authority, keyed to this console start, only the key's hash kept.
  const [saved] = world.store.webSessions("alex");
  // Marked a terminal client's session on its row (mutation-key.ts TERMINAL_EPOCH): it presents its key on any install.
  expect(saved).toMatchObject({ authority: "local-owner", keyEpoch: `terminal:${world.server.keyEpoch}`, keyHash: keyHashOf(body.key) });
  expect(JSON.stringify(world.store.webSessions("alex"))).not.toContain(body.key);
  // It works: a read, and the local owner's own act with the form token and the key; without the key it is refused.
  const cookie = `${body.cookie.name}=${body.cookie.value}`;
  expect((await world.send("/work/rows", "GET", { cookie })).status).toBe(200);
  const form = (title: string) => new URLSearchParams({ csrf: body.csrf, repo: world.repo, title }).toString();
  const bare = await world.send("/tasks/add", "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded" }, form("No key"));
  expect(bare.status).toBe(403);
  const keyed = await world.send("/tasks/add", "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", "x-toolroll-key": body.key }, form("With key"));
  expect(keyed.status).toBe(303);
  // The ledger notes the sign-in, never the code, the cookie or the key.
  const ledger = JSON.stringify(world.store.handle.prepare("SELECT * FROM action_ledger").all());
  expect(ledger).toContain("local link (terminal)");
  for (const secret of [body.cookie.value, body.key, body.csrf]) expect(ledger).not.toContain(secret);
});

test("one time, across both roads: a used link is worthless however it was used", async () => {
  const json = codeOf(world.server.mintLocalLink()!);
  expect((await redeem(json)).status).toBe(200);
  expect((await redeem(json)).status).toBe(410);
  expect((await world.send(`/login/once/${json}`, "GET")).status).toBe(410);
  // Spent by the browser first: the terminal road refuses it.
  const html = world.server.mintLocalLink()!;
  expect((await world.send(html, "GET")).status).toBe(200);
  expect((await redeem(codeOf(html))).status).toBe(410);
  expect(sessions()).toBe(2);
});

test("never a browser's: an Origin, any Sec-Fetch header or a simple-request shape is refused, and the link is spent by it", async () => {
  const cases: [string, Record<string, string>, number][] = [
    ["a cross-origin page", { ...TERMINAL, origin: "https://evil.example" }, 403],
    ["this console's own page", { ...TERMINAL, origin: world.origin }, 403],
    ["a browser's fetch metadata", { ...TERMINAL, "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" }, 403],
    ["a form post (no preflight)", { "content-type": "application/x-www-form-urlencoded", "x-toolroll-client": "terminal" }, 400],
    ["a plain-text post (no preflight)", { "content-type": "text/plain", "x-toolroll-client": "terminal" }, 400],
    ["no client header", { "content-type": "application/json" }, 400],
  ];
  for (const [what, headers, status] of cases) {
    const code = codeOf(world.server.mintLocalLink()!);
    expect((await redeem(code, headers)).status, what).toBe(status);
    // Spent by that attempt: the proper request after it is too late.
    expect((await redeem(code)).status, what).toBe(410);
  }
  expect(sessions()).toBe(0);
  // A refused presentation of a real link is noted; junk codes write nothing.
  const noted = refusals();
  expect((await redeem("x".repeat(43), { ...TERMINAL, origin: "https://evil.example" })).status).toBe(403);
  expect(refusals()).toBe(noted);
});

test("this computer only, at the console's own address: forwarded, remote-looking and foreign-host requests are refused", async () => {
  for (const [what, headers] of [
    ["a proxy in front", { ...TERMINAL, "x-forwarded-for": "100.64.0.9" }],
    ["a forwarded header", { ...TERMINAL, forwarded: "for=100.64.0.9" }],
    ["localhost, not the canonical host", { ...TERMINAL, host: `localhost:${world.port}` }],
  ] as const) {
    const code = codeOf(world.server.mintLocalLink()!);
    expect((await world.send("/login/once", "POST", { host: `127.0.0.1:${world.port}`, ...headers }, JSON.stringify({ code }))).status, what).toBe(403);
    expect((await redeem(code)).status, what).toBe(410);
  }
  expect(sessions()).toBe(0);
});

test("a link minted before local mode moved, junk and a malformed body are refused (expiry: link-redemption-parity.test.ts)", async () => {
  // Local mode turned off after the link was minted: its generation no longer stands.
  const before = codeOf(world.server.mintLocalLink()!);
  expect(setLocalModeOff(world.store, { name: "alex", authority: "full" }, new Date()).ok).toBe(true);
  expect((await redeem(before)).status).toBe(410);
  expect(sessions()).toBe(0);
  // Junk, and a code of the wrong shape, are refused without a session.
  expect((await redeem("a".repeat(43))).status).toBe(410);
  expect((await world.send("/login/once", "POST", { host: `127.0.0.1:${world.port}`, ...TERMINAL }, "{\"code\":1}")).status).toBe(400);
  expect((await world.send("/login/once", "POST", { host: `127.0.0.1:${world.port}`, ...TERMINAL }, "x".repeat(2048))).status).toBe(400);
  expect(sessions()).toBe(0);
});

test("a full account's one-time link is never redeemed here (and is spent by trying)", async () => {
  world.store.handle.prepare("UPDATE approver SET password_set = 1 WHERE name = 'alex'").run();
  const full = world.server.mintSignInLink("alex");
  expect(full).not.toBeNull();
  expect((await redeem(codeOf(full!))).status).toBe(403);
  expect((await world.send(full!, "GET")).status).toBe(410);
  expect(sessions()).toBe(0);
});

test("bound to this console start: after a restart (a new key epoch) the redeemed key no longer makes changes", async () => {
  const body = linkRedemptionSchema.parse(JSON.parse((await redeem(codeOf(world.server.mintLocalLink()!))).body));
  const cookie = `${body.cookie.name}=${body.cookie.value}`;
  // The console starts again on the same database: a new epoch.
  await new Promise<void>(resolve => world.server.close(() => resolve()));
  const again = createDecisionServer({ store: world.store, evidenceRoot: join(world.root, "evidence"), repo: world.repo, admittedRepos: () => [world.repo], configDir: world.configDir, browserKey: true,
    connectionProbe: async () => ({ code: 1, stdout: "{}", stderr: "", timedOut: false, notFound: false }), modelCatalogFetcher: (async () => { throw new Error("offline"); }) as typeof fetch });
  await new Promise<void>(resolve => again.listen(0, "127.0.0.1", resolve));
  const port = (again.address() as { port: number }).port;
  try {
    expect(again.keyEpoch).not.toBe(body.epoch);
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const sent = request({ host: "127.0.0.1", port, path: "/tasks/add", method: "POST", headers: { host: `127.0.0.1:${port}`, cookie, origin: `http://127.0.0.1:${port}`,
        "content-type": "application/x-www-form-urlencoded", "x-toolroll-key": body.key } }, response => { response.resume(); resolve(response.statusCode!); });
      sent.on("error", reject);
      sent.end(new URLSearchParams({ csrf: body.csrf, repo: world.repo, title: "After restart" }).toString());
    });
    expect(status).toBe(409);
  } finally {
    await new Promise<void>(resolve => again.close(() => resolve()));
  }
});

test("off a protected loopback install (no mutation key), the terminal road is refused", async () => {
  await world.close();
  world = await openLocalWorld({ browserKey: false });
  const code = codeOf(world.server.mintLocalLink()!);
  expect((await redeem(code)).status).toBe(403);
  // Spent by that attempt: the browser road can't use it either.
  expect((await world.send(`/login/once/${code}`, "GET")).status).toBe(410);
  expect(sessions()).toBe(0);
}, LOCAL_WORLD_SETUP_MS);

test("a tailnet machine: no browser key there (unchanged), yet the terminal client still gets its key and must present it", async () => {
  await world.close();
  world = await openLocalWorld({ browserKey: true, tailnetNames: async () => ["box.tail1234.ts.net"] });
  await new Promise(resolve => setTimeout(resolve, 20)); // the names are read once, at start
  const form = (csrf: string, title: string) => new URLSearchParams({ csrf, repo: world.repo, title }).toString();
  const post = (cookie: string, body: string, key?: string) => world.send("/tasks/add", "POST",
    { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", ...(key === undefined ? {} : { "x-toolroll-key": key }) }, body);
  // The browser's road, as today: no key delivered, none kept, and its form posts without one.
  const browser = await world.localSession();
  expect(world.store.webSessions("alex")[0]).toMatchObject({ keyHash: null });
  expect((await post(browser.cookie, form(browser.csrf, "From the browser"))).status).toBe(303);
  // The terminal's road: a key, bound to this start, and its session refused without it.
  const body = linkRedemptionSchema.parse(JSON.parse((await redeem(codeOf(world.server.mintLocalLink()!))).body));
  const cookie = `${body.cookie.name}=${body.cookie.value}`;
  expect((await post(cookie, form(body.csrf, "No key"))).status).toBe(403);
  expect((await post(cookie, form(body.csrf, "Another key"), "f".repeat(64))).status).toBe(403);
  expect((await post(cookie, form(body.csrf, "With key"), body.key)).status).toBe(303);
  // The browser session is still not asked for a key.
  expect((await post(browser.cookie, form(browser.csrf, "Still from the browser"))).status).toBe(303);
  // Over the tailnet name (which this console answers to), never: only its own loopback address issues a key.
  const code = codeOf(world.server.mintLocalLink()!);
  expect((await world.send("/login/once", "POST", { ...TERMINAL, host: `box.tail1234.ts.net:${world.port}` }, JSON.stringify({ code }))).status).toBe(403);
  expect((await redeem(code)).status).toBe(410);
}, LOCAL_WORLD_SETUP_MS);

/** A console over the same database (a restart), with the options given. */
async function restarted(extra: Parameters<typeof createDecisionServer>[0] extends infer O ? Partial<O> : never): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>(resolve => world.server.close(() => resolve()));
  const again = createDecisionServer({ store: world.store, evidenceRoot: join(world.root, "evidence"), repo: world.repo, admittedRepos: () => [world.repo], configDir: world.configDir, browserKey: true,
    connectionProbe: async () => ({ code: 1, stdout: "{}", stderr: "", timedOut: false, notFound: false }), modelCatalogFetcher: (async () => { throw new Error("offline"); }) as typeof fetch, ...extra });
  await new Promise<void>(resolve => again.listen(0, "127.0.0.1", resolve));
  return { port: (again.address() as { port: number }).port, close: () => new Promise<void>(resolve => again.close(() => resolve())) };
}
/** POST /tasks/add as this session on this port, with or without its key. */
async function addTask(port: number, cookie: string, csrf: string, title: string, key?: string): Promise<number> {
  const { request } = await import("node:http");
  return new Promise<number>((resolve, reject) => {
    const sent = request({ host: "127.0.0.1", port, path: "/tasks/add", method: "POST", headers: { host: `127.0.0.1:${port}`, cookie, origin: `http://127.0.0.1:${port}`,
      "content-type": "application/x-www-form-urlencoded", ...(key === undefined ? {} : { "x-toolroll-key": key }) } }, response => { response.resume(); resolve(response.statusCode!); });
    sent.on("error", reject);
    sent.end(new URLSearchParams({ csrf, repo: world.repo, title }).toString());
  });
}

test("Codex A0 r1 #1: tailnet names appear while a browser session and a terminal session hold keys: the browser works as before, the terminal still needs its key", async () => {
  // A protected install at first; its tailnet names arrive a moment later (as the five-minute refresh would bring them).
  await world.close();
  let arrive: (names: readonly string[]) => void = () => {};
  world = await openLocalWorld({ browserKey: true, tailnetNames: () => new Promise(resolve => { arrive = resolve; }) });
  const spent = await world.send(world.server.mintLocalLink()!, "GET");
  expect(spent.status).toBe(200); // the key's delivery page: protected, the browser holds a key
  const browserCookie = [spent.headers["set-cookie"] ?? []].flat().map(one => String(one).split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
  const browserCsrf = (JSON.parse((await world.send("/chat?format=workspace", "GET", { cookie: browserCookie })).body) as { csrf: string }).csrf;
  const terminal = linkRedemptionSchema.parse(JSON.parse((await redeem(codeOf(world.server.mintLocalLink()!))).body));
  const terminalCookie = `${terminal.cookie.name}=${terminal.cookie.value}`;
  arrive(["box.tail1234.ts.net"]);
  await new Promise(resolve => setTimeout(resolve, 20));
  // Not protected any more: pages carry no key, and the browser session's form posts without one, as before.
  expect(await addTask(world.port, browserCookie, browserCsrf, "Browser after tailnet")).toBe(303);
  // The terminal session: refused without its key, accepted with it.
  expect(await addTask(world.port, terminalCookie, terminal.csrf, "Terminal, no key")).toBe(403);
  expect(await addTask(world.port, terminalCookie, terminal.csrf, "Terminal, keyed", terminal.key)).toBe(303);
  // After a restart on the tailnet machine: the browser session still works as before; the terminal session's key is
  // from the earlier start, so it is told to reconnect (409), key or not.
  const again = await restarted({ tailnetNames: async () => ["box.tail1234.ts.net"] });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await addTask(again.port, browserCookie, browserCsrf, "Browser after restart")).toBe(303);
    expect(await addTask(again.port, terminalCookie, terminal.csrf, "Terminal after restart", terminal.key)).toBe(409);
    expect(await addTask(again.port, terminalCookie, terminal.csrf, "Terminal after restart, no key")).toBe(409);
  } finally { await again.close(); }
}, LOCAL_WORLD_SETUP_MS);
