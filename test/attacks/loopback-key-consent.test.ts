/**
 * Attack: a server on another port holds the console's cookie and reads the MCP consent page (its CSRF token is on
 * it), then grants its own client access by posting the consent. Guard (easy-start C2): mcp-oauth.ts consent POST
 * checks the session's browser key (server/mutation-key.ts) after the CSRF token; the consent page carries only the
 * small nonce'd key fill. Refused without the key; the key-holder's own consent works.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { KEY_FIELD } from "../../src/server/mutation-key.js";
import { raw, signIn, startConsole, stop, world, type Console } from "../loopback-key-kit.js";

let one: Console | null = null, w: ReturnType<typeof world> | null = null;
afterEach(async () => { if (one !== null) await stop(one); one = null; w?.close(); w = null; });

const REDIRECT = "http://127.0.0.1:9/callback";
const hidden = (page: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)?.[1] ?? "";

test("the consent post needs the key; the page that carries the form has the key fill and never the key", async () => {
  w = world();
  w.store.createTask({ id: "t-shop", title: "shop" }, new Date());
  w.store.handle.prepare("UPDATE task_ref SET repo = ? WHERE id = ?").run("/repo/shop", w.store.refFor("built-in", "t-shop").id);
  one = await startConsole(w.store, w.dir);
  const json = { "content-type": "application/json" };
  const registered = await raw(one.port, "POST", "/oauth/register", json, JSON.stringify({ client_name: "Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }));
  expect(registered.status).toBe(201);
  const client = (JSON.parse(registered.body) as { client_id: string }).client_id;
  const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: `${one.base}/mcp`, scope: "read act" });
  const started = await raw(one.port, "GET", `/oauth/authorize?${query}`);
  const next = (/url=([^"]+)"/.exec(started.body)?.[1] ?? "").replace(/&amp;/g, "&");
  expect(next).toMatch(/^\/oauth\/authorize\?request=/);
  const { cookie, key } = await signIn(one.port, w.password);
  const page = await raw(one.port, "GET", next, { cookie });
  expect(page.status).toBe(200);
  expect(page.body).not.toContain(key);
  expect(page.body).toContain(KEY_FIELD);
  expect(String(page.headers["content-security-policy"])).toMatch(/script-src 'nonce-/);
  const fields = { request: hidden(page.body, "request"), csrf: hidden(page.body, "csrf"), decision: "allow", access: "read", project: "/repo/shop", password: w.password };
  const form = { cookie, origin: one.base, "content-type": "application/x-www-form-urlencoded" };
  const attacked = await raw(one.port, "POST", "/oauth/authorize", form, new URLSearchParams(fields).toString());
  expect(attacked.status).toBe(403);
  expect(attacked.body).toContain("Reconnect to Toolroll");
  expect(w.store.apiTokens(null)).toHaveLength(0);
  const allowed = await raw(one.port, "POST", "/oauth/authorize", { ...form, "x-toolroll-key": key }, new URLSearchParams(fields).toString());
  expect(allowed.status).toBe(200);
  expect(allowed.body).toContain("code=");
});
