/**
 * Easy-start C4/C5, the web road from a laptop's local owner (no password) to a full session: /password/set is the one
 * credential act its session may make, only while no password exists. The answer is a FRESH full session (and, on a
 * protected loopback install, a fresh browser key), every local session from before is ended, and the person continues
 * to the act that was refused. Around it: a second enrollment loses, "already set" signs in, every other credential row
 * stays refused, a GitHub clone is the local owner's own act (no password to type) while a full session still types
 * its password, turning local mode off from Settings stops local seals dispatching, and a local owner's filing says so
 * in its ledger line.
 */
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openLocalWorld, LOCAL_T0, type LocalWorld } from "../local-owner-world.js";
import { cookieOf, deliveredKey } from "../loopback-key-kit.js";
import { enrollOwnerPassword, localModeOf } from "../../src/store.js";
import { approve, authenticateAccount, hashPassword } from "../../src/scope.js";
import { asLocalOwner } from "../../src/local-owner.js";

const PASSWORD = "correct horse battery";
let world: LocalWorld;
afterEach(async () => { await world.close(); });

/** The local form: its CSRF token, as the page renders it. */
async function formOf(cookie: string, path = "/password/set"): Promise<{ status: number; body: string; csrf: string | null }> {
  const page = await world.send(path, "GET", { cookie });
  return { status: page.status, body: page.body, csrf: /name="csrf" value="([0-9a-f]{64})"/.exec(page.body)?.[1] ?? null };
}
const setPassword = (cookie: string, fields: Record<string, string>, key?: string) =>
  world.send("/password/set", "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", ...(key === undefined ? {} : { "x-toolroll-key": key }) },
    new URLSearchParams(fields).toString());
const signedIn = async (cookie: string) => (await world.send("/chat?format=workspace", "GET", { cookie })).status === 200;

describe("setting the first password", () => {
  test("a fresh full session, every local session ended, and on to the refused page", async () => {
    world = await openLocalWorld();
    const first = await world.localSession(), second = await world.localSession();
    // The refusal leads here, carrying the page that was refused.
    const refused = await world.send("/settings/passwordless", "GET", { cookie: first.cookie });
    expect(refused.status).toBe(200);
    const form = await formOf(first.cookie, "/password/set?return=%2Fsettings%2Fpasswordless");
    expect(form.status).toBe(200);
    expect(form.body).toContain("Agents can work on their own, merge and release only after you set a password.");
    expect(form.body).toContain('name="return" value="/settings/passwordless"');
    expect(form.csrf).toBe(first.csrf);
    // Too short, then two that differ: refused, nothing set, nothing echoed.
    const short = await setPassword(first.cookie, { csrf: first.csrf, password: "short", again: "short" });
    expect(short.status).toBe(400);
    expect(short.body).toContain("Use at least 8 characters.");
    const mismatch = await setPassword(first.cookie, { csrf: first.csrf, password: PASSWORD, again: `${PASSWORD}!` });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toContain("The two passwords don&#39;t match.");
    expect(mismatch.body).not.toContain(PASSWORD);
    expect(world.store.accountOf("alex")!.passwordSet).toBe(false);
    // A forged post (no CSRF, another origin) changes nothing.
    expect((await setPassword(first.cookie, { password: PASSWORD, again: PASSWORD })).status).toBe(403);
    expect((await world.send("/password/set", "POST", { cookie: first.cookie, origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ csrf: first.csrf, password: PASSWORD, again: PASSWORD }).toString())).status).toBe(403);
    expect(world.store.accountOf("alex")!.passwordSet).toBe(false);

    const generation = world.store.accountOf("alex")!.generation;
    const set = await setPassword(first.cookie, { csrf: first.csrf, password: PASSWORD, again: PASSWORD, return: "/settings/passwordless" });
    expect(set.status).toBe(303);
    expect(set.headers["location"]).toBe("/settings/passwordless");
    const fresh = cookieOf({ status: set.status, headers: set.headers, body: set.body });
    expect(fresh).not.toBe(first.cookie);
    // The account has the password now (its generation moved); local mode stays on.
    const account = world.store.accountOf("alex")!;
    expect(account.passwordSet).toBe(true);
    expect(account.generation).toBe(generation + 1);
    expect(authenticateAccount(world.store, "alex", PASSWORD).ok).toBe(true);
    expect(localModeOf(world.store)).toMatchObject({ enabled: true, generation: 1 });
    // Exactly one session: the fresh full one. Both local sessions are dead.
    expect(world.store.webSessions("alex")).toMatchObject([{ authority: "full" }]);
    expect(await signedIn(first.cookie)).toBe(false);
    expect(await signedIn(second.cookie)).toBe(false);
    expect(await signedIn(fresh)).toBe(true);
    // The fresh session acts as the full person: the row it was refused now answers it.
    expect((await world.send("/settings/passwordless", "GET", { cookie: fresh })).headers["x-toolroll-refused"]).toBeUndefined();
    expect(world.store.actionLedger({ repos: null, source: "access" }).map(one => one.action)).toContain("password set");
  });

  test("a return that is not one of the app's own pages goes home", async () => {
    world = await openLocalWorld();
    const { cookie, csrf } = await world.localSession();
    const set = await setPassword(cookie, { csrf, password: PASSWORD, again: PASSWORD, return: "//evil.example/x" });
    expect(set.status).toBe(303);
    expect(set.headers["location"]).toBe("/");
  });

  test("on a protected loopback install: the key is required, and a fresh key is delivered once with the session", async () => {
    world = await openLocalWorld({ browserKey: true });
    const spent = await world.send(world.server.mintLocalLink()!, "GET");
    const localKey = deliveredKey({ status: spent.status, headers: spent.headers, body: spent.body })!.key;
    const cookie = cookieOf({ status: spent.status, headers: spent.headers, body: spent.body });
    const form = await formOf(cookie);
    // The page fills the key into its own form (a nonce'd script), and is never cached.
    expect(form.body).toMatch(/<script nonce="[^"]+">\(function\(\)\{if\(window\.soKeyHeaders\)/);
    // Without the key (a cookie holder on another port reads the CSRF token, never the key): refused, nothing set.
    const bare = await setPassword(cookie, { csrf: form.csrf!, password: PASSWORD, again: PASSWORD });
    expect(bare.status).toBe(403);
    expect(world.store.accountOf("alex")!.passwordSet).toBe(false);
    const set = await setPassword(cookie, { csrf: form.csrf!, password: PASSWORD, again: PASSWORD, return: "/chat" }, localKey);
    expect(set.status).toBe(200);
    expect(set.headers["cache-control"]).toBe("no-store");
    const delivered = deliveredKey({ status: set.status, headers: set.headers, body: set.body })!;
    expect(delivered.key).toMatch(/^[0-9a-f]{64}$/);
    expect(delivered.key).not.toBe(localKey);
    expect(set.body).toContain('"to":"/chat"');
    const fresh = cookieOf({ status: set.status, headers: set.headers, body: set.body });
    const saved = world.store.webSessions("alex");
    expect(saved).toMatchObject([{ authority: "full" }]);
    // The fresh key acts for the fresh session; the old local key does not.
    const csrf = (JSON.parse((await world.send("/chat?format=workspace", "GET", { cookie: fresh })).body) as { csrf: string }).csrf;
    const post = (key: string) => world.send("/tasks/add", "POST", { cookie: fresh, origin: world.origin, "content-type": "application/x-www-form-urlencoded", "x-toolroll-key": key },
      new URLSearchParams({ csrf, repo: world.repo, title: `Filed with ${key.slice(0, 4)}` }).toString());
    expect((await post(localKey)).status).toBe(403);
    expect((await post(delivered.key)).status).toBe(303);
  });
});

describe("only once", () => {
  test("two enrollments: exactly one wins; the other hears it was just set", async () => {
    world = await openLocalWorld();
    // Two posts at once from two local tabs: one full session comes out, and only the winner's password signs in.
    const a = await world.localSession(), b = await world.localSession();
    const [one, two] = await Promise.all([
      setPassword(a.cookie, { csrf: a.csrf, password: "first password here", again: "first password here" }),
      setPassword(b.cookie, { csrf: b.csrf, password: "second password here", again: "second password here" }),
    ]);
    const winners = [one, two].filter(answer => answer.status === 303 && cookieOf({ status: answer.status, headers: answer.headers, body: answer.body }) !== "");
    expect(winners).toHaveLength(1);
    const won = winners[0] === one ? "first password here" : "second password here", lost = won === "first password here" ? "second password here" : "first password here";
    expect(authenticateAccount(world.store, "alex", won).ok).toBe(true);
    expect(authenticateAccount(world.store, "alex", lost).ok).toBe(false);
    expect(world.store.webSessions("alex")).toMatchObject([{ authority: "full" }]);
    // The store's own check, the one the page reports as "just set": the second enrollment writes nothing.
    const generation = world.store.accountOf("alex")!.generation;
    expect(enrollOwnerPassword(world.store, "alex", hashPassword("third password here"), 1, LOCAL_T0)).toEqual({ ok: false, reason: "already-set" });
    expect(world.store.accountOf("alex")!.generation).toBe(generation);
  });

  test("once a password exists: the page says sign in, for a full session and a local one alike, and a post changes nothing", async () => {
    world = await openLocalWorld();
    const { cookie, csrf } = await world.localSession();
    const set = await setPassword(cookie, { csrf, password: PASSWORD, again: PASSWORD });
    const full = cookieOf({ status: set.status, headers: set.headers, body: set.body });
    const page = await world.send("/password/set?return=%2Fsettings", "GET", { cookie: full });
    expect(page.status).toBe(200);
    expect(page.body).toContain("A password is already set");
    expect(page.body).toContain('href="/settings"');
    expect(page.body).not.toContain('name="password"');
    const fullCsrf = (JSON.parse((await world.send("/chat?format=workspace", "GET", { cookie: full })).body) as { csrf: string }).csrf;
    const hash = world.store.handle.prepare("SELECT credential_hash FROM approver WHERE name = 'alex'").get()!["credential_hash"];
    const again = await setPassword(full, { csrf: fullCsrf, password: "another password", again: "another password" });
    expect(again.status).toBe(409);
    // Local mode is still on: a new local session (from `toolroll open`) is told the same.
    const local = await world.localSession();
    const localPage = (await world.send("/password/set?return=%2Fsettings", "GET", { cookie: local.cookie })).body;
    expect(localPage).toContain("A password is already set");
    expect(localPage).toContain('href="/login?return=%2Fsettings"');
    expect((await setPassword(local.cookie, { csrf: local.csrf, password: "another password", again: "another password" })).status).toBe(409);
    expect(world.store.handle.prepare("SELECT credential_hash FROM approver WHERE name = 'alex'").get()!["credential_hash"]).toBe(hash);
    // Signed out: to the sign-in, coming back here. And /login itself returns to the refused page.
    expect((await world.send("/password/set?return=%2Fsettings", "GET")).headers["location"]).toBe("/login?return=%2Fsettings");
    const login = await world.send("/login", "POST", { origin: world.origin, "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ name: "alex", token: PASSWORD, return: "/settings" }).toString());
    expect(login.status).toBe(303);
    expect(login.headers["location"]).toBe("/settings");
  });
});

test("a local owner is refused on every other credential row under Settings, and led to set a password", async () => {
  world = await openLocalWorld();
  const { cookie, csrf } = await world.localSession();
  const before = JSON.stringify([world.store.handle.prepare("SELECT * FROM approver").all(), world.store.handle.prepare("SELECT * FROM local_mode").all(), world.store.handle.prepare("SELECT * FROM credential").all()]);
  for (const path of ["/settings/passwordless", "/settings/sessions", "/settings/sign-in", "/settings/local-mode/off", "/settings/chat-approval/save", "/settings/telegram/pair", "/people/invite", "/people/projects"]) {
    const answer = await world.post(path, cookie, { csrf, password: "", token: "", action: "on" }, "application/json");
    expect(answer.headers["x-toolroll-refused"], path).toBe("local-owner");
    expect(JSON.parse(answer.body), path).toEqual({ ok: false, said: "Set a password to do this.", href: "/password/set" });
  }
  // A refused page leads to setting a password and back to it.
  const settings = await world.send("/settings", "GET", { cookie });
  expect(settings.body).toContain("Let agents work on their own");
  expect(settings.body).toContain('href="/password/set?return=%2Fsettings"');
  expect(JSON.stringify([world.store.handle.prepare("SELECT * FROM approver").all(), world.store.handle.prepare("SELECT * FROM local_mode").all(), world.store.handle.prepare("SELECT * FROM credential").all()])).toBe(before);
});

describe("adding from GitHub", () => {
  const fakeClone = async (nameWithOwner: string, intoRoot: string) => {
    const target = join(intoRoot, nameWithOwner.split("/")[1]!);
    mkdirSync(target);
    execFileSync("git", ["init", "-q", target], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    return { ok: true as const, target };
  };
  const fakePreview = async (owner: string, name: string) => ({ ok: true as const, preview: { nameWithOwner: `${owner}/${name}`, visibility: "public", diskUsageKib: 512, description: "a test repo" } });
  const preview = async (cookie: string, csrf: string, repo: string): Promise<{ body: string; nonce: string }> => {
    const answer = await world.post("/projects/onboard-preview", cookie, { csrf, repo, root: "0" });
    return { body: answer.body, nonce: /name="nonce" value="([0-9a-f]{32})"/.exec(answer.body)?.[1] ?? "" };
  };
  const added = (name: string) => world.store.listProjects().some(one => one.path.endsWith(`/${name}`));

  test("the local owner clones with no password to type; a full session still types its password", async () => {
    world = await openLocalWorld(root => ({ projectRoots: [root], ghPreview: fakePreview, ghClone: fakeClone }) as never);
    const local = await world.localSession();
    const review = await preview(local.cookie, local.csrf, "ap9000/fresh-thing");
    expect(review.nonce).toMatch(/^[0-9a-f]{32}$/);
    // No password field on the local owner's review: the clone is its own act.
    expect(review.body).toContain("No password needed on this computer.");
    expect(review.body).not.toContain('name="token"');
    const cloned = await world.post("/projects/onboard-confirm", local.cookie, { csrf: local.csrf, nonce: review.nonce });
    expect(cloned.headers["x-toolroll-refused"]).toBeUndefined();
    expect(cloned.status).toBe(200);
    expect(cloned.body).toContain("is ready");
    expect(existsSync(join(world.root, "fresh-thing", ".git"))).toBe(true);
    expect(added("fresh-thing")).toBe(true);

    // After a password is set, a full session's clone still takes it, typed again.
    const set = await setPassword(local.cookie, { csrf: local.csrf, password: PASSWORD, again: PASSWORD });
    const full = cookieOf({ status: set.status, headers: set.headers, body: set.body });
    const csrf = (JSON.parse((await world.send("/chat?format=workspace", "GET", { cookie: full })).body) as { csrf: string }).csrf;
    const second = await preview(full, csrf, "ap9000/second-thing");
    expect(second.body).toContain('name="token"');
    const bare = await world.post("/projects/onboard-confirm", full, { csrf, nonce: second.nonce, token: "" });
    expect(bare.status).toBe(403);
    expect(bare.body).toContain("Cloning takes your password");
    expect(existsSync(join(world.root, "second-thing"))).toBe(false);
    const again = await preview(full, csrf, "ap9000/second-thing");
    const typed = await world.post("/projects/onboard-confirm", full, { csrf, nonce: again.nonce, token: PASSWORD });
    expect(typed.status).toBe(200);
    expect(added("second-thing")).toBe(true);
  });
});

test("local mode off from Settings: a full session's step-up, the generation moves, and local seals stop dispatching", async () => {
  world = await openLocalWorld();
  const local = await world.localSession();
  // A local owner's seal on the world's task, as the console's admission binds it (the approve-plan act, nothing typed).
  const scope = world.store.getScope("one")!;
  const sealed = asLocalOwner({ account: "alex", localGeneration: 1, accountGeneration: world.store.accountOf("alex")!.generation, transport: "browser", act: "approve-plan", sessionHash: null, request: null },
    () => approve(world.store, "one", "alex", LOCAL_T0, scope.digest, ""));
  expect(sealed).toMatchObject({ ok: true });
  const ref = world.store.lookupRef("one")!.id;
  expect(world.store.modeApprovalLive(ref, LOCAL_T0)).toBe(true);
  // The local owner sees no switch, and its post is refused.
  expect((await world.send("/settings/access", "GET", { cookie: local.cookie })).body).not.toContain("/settings/local-mode/off");
  expect((await world.post("/settings/local-mode/off", local.cookie, { csrf: local.csrf, password: "" })).headers["x-toolroll-refused"]).toBe("local-owner");
  expect(localModeOf(world.store)).toMatchObject({ enabled: true, generation: 1 });

  const set = await setPassword(local.cookie, { csrf: local.csrf, password: PASSWORD, again: PASSWORD });
  const full = cookieOf({ status: set.status, headers: set.headers, body: set.body });
  const access = await world.send("/settings/access", "GET", { cookie: full });
  expect(access.body).toContain('action="/settings/local-mode/off"');
  const csrf = (JSON.parse((await world.send("/chat?format=workspace", "GET", { cookie: full })).body) as { csrf: string }).csrf;
  // Without the password: refused, nothing changes.
  const bare = await world.post("/settings/local-mode/off", full, { csrf, password: "" });
  expect(bare.headers["location"]).toMatch(/^\/settings\/access\?problem=/);
  expect(localModeOf(world.store)).toMatchObject({ enabled: true, generation: 1 });
  const off = await world.post("/settings/local-mode/off", full, { csrf, password: PASSWORD });
  expect(off.status).toBe(303);
  expect(off.headers["location"]).toMatch(/^\/settings\/access\?said=Local%20mode%20is%20off/);
  expect(localModeOf(world.store)).toMatchObject({ enabled: false, generation: 2 });
  // Every local seal stops dispatching, and no local link can be minted any more.
  expect(world.store.modeApprovalLive(ref, LOCAL_T0)).toBe(false);
  expect(world.server.mintLocalLink()).toBeNull();
  expect(world.store.actionLedger({ repos: null, source: "access" }).find(one => one.action === "local mode off")).toMatchObject({ actor: "alex" });
  // The full session goes on.
  expect(await signedIn(full)).toBe(true);
});

test("provenance: a task the local owner files says so in its filing line; a full session's doesn't", async () => {
  world = await openLocalWorld();
  const local = await world.localSession();
  expect((await world.post("/tasks/add", local.cookie, { csrf: local.csrf, repo: world.repo, title: "Fix the footer" })).status).toBe(303);
  const line = (title: string) => {
    const id = String(world.store.handle.prepare("SELECT id FROM task WHERE title = ?").get(title)!["id"]);
    return world.store.handle.prepare("SELECT actor, detail FROM action_ledger WHERE task_id = ? AND action = 'task filed'").get(id);
  };
  expect(line("Fix the footer")).toEqual({ actor: "alex", detail: "filed via local-owner · local 1 browser" });
  // The task's own filing road is unchanged (the console form's).
  expect(world.store.filedViaOf(String(world.store.handle.prepare("SELECT id FROM task WHERE title = 'Fix the footer'").get()!["id"]))).toBe("console");
  const set = await setPassword(local.cookie, { csrf: local.csrf, password: PASSWORD, again: PASSWORD });
  const full = cookieOf({ status: set.status, headers: set.headers, body: set.body });
  const csrf = (JSON.parse((await world.send("/chat?format=workspace", "GET", { cookie: full })).body) as { csrf: string }).csrf;
  expect((await world.post("/tasks/add", full, { csrf, repo: world.repo, title: "Fix the header" })).status).toBe(303);
  expect(line("Fix the header")).toEqual({ actor: "alex", detail: null });
});
