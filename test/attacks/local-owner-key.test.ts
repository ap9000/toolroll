/**
 * Easy-start C1 + C2 together: a laptop's local owner on a protected loopback install (browser key on). Its session
 * gets a key from the one-time local link, like a full session's sign-in. An allowed act needs the cookie, the CSRF
 * token AND the key; without the key it is refused like any cookie holder's on another port; a row not marked for the
 * local owner stays refused even with the key. The welcome's two acts (sample project, "Use this one") are the local
 * owner's, with the key.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { cookieOf, deliveredKey, KEY_REFUSED } from "../loopback-key-kit.js";

let world: LocalWorld;
beforeEach(async () => {
  world = await openLocalWorld({
    browserKey: true,
    // Claude Code reads as signed in on this computer, so "Use this one" can choose it.
    connectionProbe: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "", timedOut: false, notFound: false }),
  });
}, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

async function keyedLocalSession(): Promise<{ cookie: string; csrf: string; key: string }> {
  const spent = await world.send(world.server.mintLocalLink()!, "GET");
  expect(spent.status).toBe(200);
  const key = deliveredKey({ status: spent.status, headers: spent.headers, body: spent.body })?.key;
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  const cookie = cookieOf({ status: spent.status, headers: spent.headers, body: spent.body });
  expect(world.store.webSessions("alex")).toMatchObject([{ authority: "local-owner" }]);
  const csrf = (JSON.parse((await world.send("/chat?format=workspace", "GET", { cookie })).body) as { csrf: string }).csrf;
  return { cookie, csrf, key: key! };
}
const post = (path: string, cookie: string, form: Record<string, string>, key?: string) =>
  world.send(path, "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", ...(key === undefined ? {} : { "x-toolroll-key": key }) },
    new URLSearchParams(form).toString());
const filed = (title: string) => world.store.handle.prepare("SELECT COUNT(*) AS n FROM task WHERE title = ?").get(title)?.["n"];

test("an allowed act runs with the key, is refused without it, and a deny row stays refused with it", async () => {
  const { cookie, csrf, key } = await keyedLocalSession();
  // Without the key (a cookie holder on another port reads the CSRF token, never the key): refused, nothing filed.
  const bare = await post("/tasks/add", cookie, { csrf, repo: world.repo, title: "No key" });
  expect(bare.status).toBe(403);
  expect(bare.body).toMatch(KEY_REFUSED);
  expect(filed("No key")).toBe(0);
  // With the key: the local owner's own act runs.
  const keyed = await post("/tasks/add", cookie, { csrf, repo: world.repo, title: "With key" }, key);
  expect(keyed.headers["x-toolroll-refused"]).toBeUndefined();
  expect(keyed.status).toBe(303);
  expect(filed("With key")).toBe(1);
  // A row not marked for the local owner: refused as the local owner, key or not; nothing changes.
  const before = JSON.stringify(world.store.handle.prepare("SELECT * FROM approver").all());
  for (const withKey of [key, undefined]) {
    const denied = await post("/people/invite", cookie, { csrf, name: "robin" }, withKey);
    expect(denied.status).toBe(403);
    expect(denied.headers["x-toolroll-refused"]).toBe("local-owner");
  }
  expect(JSON.stringify(world.store.handle.prepare("SELECT * FROM approver").all())).toBe(before);
});

test("the welcome's acts: \"Use this one\" chooses the agent with the key, and neither runs without it", async () => {
  const { cookie, csrf, key } = await keyedLocalSession();
  expect(world.store.getChatConfig()).toBeNull();
  // Without the key: both refused before their handlers.
  for (const [path, form] of [["/settings/lead/on", { agent: "claude", return: "/welcome" }], ["/welcome/sample", {}]] as const) {
    const bare = await post(path, cookie, { csrf, ...form });
    expect(bare.status, path).toBe(403);
    expect(bare.body, path).toMatch(KEY_REFUSED);
  }
  expect(world.store.getChatConfig()).toBeNull();
  // With the key: the local owner chooses Claude Code (its write re-proves local mode still stands, Store.transact).
  const chose = await post("/settings/lead/on", cookie, { csrf, agent: "claude", return: "/welcome" }, key);
  expect(chose.headers["x-toolroll-refused"]).toBeUndefined();
  expect(chose.status).toBe(303);
  expect(chose.headers["location"]).toBe("/welcome");
  expect(world.store.getChatConfig()?.provider).toBe("claude-subscription");
  // The sample project is the local owner's act too (here no project folder is served, so it comes back with words).
  const sample = await post("/welcome/sample", cookie, { csrf }, key);
  expect(sample.headers["x-toolroll-refused"]).toBeUndefined();
  expect(sample.status).toBe(303);
  expect(String(sample.headers["location"])).toMatch(/^\/welcome\?sample=/);
});

test("the key doesn't carry a session elsewhere: a keyed act through a proxy is refused and writes nothing (local-owner slice 0)", async () => {
  const { cookie, csrf, key } = await keyedLocalSession();
  for (const proxy of [{ "x-forwarded-for": "100.64.0.7" }, { forwarded: "for=100.64.0.7" }]) {
    const relayed = await world.send("/tasks/add", "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", "x-toolroll-key": key, ...proxy },
      new URLSearchParams({ csrf, repo: world.repo, title: "Relayed" }).toString());
    expect(relayed.status).toBe(403);
    expect(relayed.headers["x-toolroll-refused"]).toBe("local-owner-elsewhere");
  }
  expect(filed("Relayed")).toBe(0);
  // From this computer, the same keyed act runs.
  expect((await post("/tasks/add", cookie, { csrf, repo: world.repo, title: "Here" }, key)).status).toBe(303);
  expect(filed("Here")).toBe(1);
});

test("local mode turned off after the key was delivered: the keyed act is refused and writes nothing", async () => {
  const { cookie, csrf, key } = await keyedLocalSession();
  world.store.handle.prepare("UPDATE local_mode SET enabled = 0, generation = generation + 1 WHERE id = 1").run();
  const after = await post("/settings/lead/on", cookie, { csrf, agent: "claude", return: "/welcome" }, key);
  expect(after.status).toBe(401);
  expect(world.store.getChatConfig()).toBeNull();
});
