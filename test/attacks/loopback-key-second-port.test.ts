/**
 * Attack: a server on another port of this computer receives the console's session cookie (cookies are not isolated
 * by port, RFC 6265 §8.5), reads every page and JSON it likes, CSRF token included, and posts back with a valid Host,
 * Origin and CSRF token. Guard (easy-start C2): server/mutation-key.ts — on a protected loopback install every browser
 * mutation also presents a key that only the console's own origin holds; it is delivered once, never rendered.
 * Each attack fails; the browser that holds the key does the same things. Logout stays cookie-only (sign-out only).
 */
import { afterEach, describe, expect, test } from "vitest";
import { setPasswordless } from "../../src/passwordless.js";
import { createHash } from "node:crypto";
import { csrfOf, deliveredKey, KEY_REFUSED, post, raw, signIn, startConsole, stop, upgrade, world, type Console } from "../loopback-key-kit.js";

let one: Console | null = null, w: ReturnType<typeof world> | null = null;
afterEach(async () => { if (one !== null) await stop(one); one = null; w?.close(); w = null; });

for (const passwordless of [false, true]) {
  describe(`second port, Passwordless ${passwordless ? "on" : "off"}`, () => {
    test("the cookie reads every page but no key; every mutation it posts is refused, the key-holder's is not", async () => {
      w = world();
      if (passwordless) setPasswordless(w.store, true, "alex", new Date());
      one = await startConsole(w.store, w.dir);
      const { cookie, key, delivery } = await signIn(one.port, w.password);
      // The one delivery: no-store, its own nonce'd script, the key's hash kept (never the key).
      expect(delivery.status).toBe(200);
      expect(delivery.headers["cache-control"]).toBe("no-store");
      expect(String(delivery.headers["content-security-policy"])).toMatch(/script-src 'nonce-[^']+'/);
      const saved = w.store.raw().prepare("SELECT key_hash, key_epoch FROM web_session").all() as { key_hash: string; key_epoch: string }[];
      expect(saved).toHaveLength(1);
      expect(saved[0]!.key_hash).toBe(createHash("sha256").update(key).digest("hex"));
      expect(JSON.stringify(w.store.raw().prepare("SELECT * FROM web_session").all())).not.toContain(key);
      expect(saved[0]!.key_epoch).toBe(one.server.keyEpoch);

      // The attacker reads pages and JSON with the cookie: the CSRF token is there, the key never is.
      const csrf = await csrfOf(one.port, cookie);
      for (const path of ["/", "/chat", "/chat?format=workspace", "/work", "/settings", "/agents", "/settings/sessions", "/login/rekey", "/api/team"]) {
        const page = await raw(one.port, "GET", path, { cookie });
        expect(page.body, path).not.toContain(key);
        expect(JSON.stringify(page.headers), path).not.toContain(key);
      }

      // Console form post with valid Host, Origin and CSRF: refused without the key, accepted with it.
      const attacked = await post(one.port, "/session/forget-password", cookie, { csrf });
      expect(attacked.status).toBe(403);
      expect(attacked.body).toMatch(KEY_REFUSED);
      const wrongKey = await post(one.port, "/session/forget-password", cookie, { csrf }, "0".repeat(64));
      expect(wrongKey.status).toBe(403);
      // Two different keys in one request is none.
      const smuggled = await post(one.port, "/session/forget-password", cookie, { csrf, "toolroll-key": "1".repeat(64) }, key);
      expect(smuggled.status).toBe(403);
      const legit = await post(one.port, "/session/forget-password", cookie, { csrf }, key);
      expect(legit.status).not.toBe(403);
      // The form field road (a native form, filled by the page's key fill) works too.
      const field = await post(one.port, "/session/forget-password", cookie, { csrf, "toolroll-key": key });
      expect(field.status).not.toBe(403);

      // Chat send.
      const chat = await post(one.port, "/chat", cookie, { csrf, message: "delete everything", request: "r".repeat(32) });
      expect(chat.status).toBe(403);
      expect(chat.body).toMatch(KEY_REFUSED);
      expect((await post(one.port, "/chat", cookie, { csrf, message: "hello", request: "s".repeat(32) }, key)).body).not.toMatch(KEY_REFUSED);

      // The team API (its own CSRF header).
      const team = (keyed: boolean) => raw(one!.port, "POST", "/api/team", { cookie, origin: one!.base, "content-type": "application/json", "x-csrf-token": csrf, ...(keyed ? { "x-toolroll-key": key } : {}) },
        JSON.stringify({ operation: "send", args: { text: "hi" } }));
      const teamAttack = await team(false);
      expect(teamAttack.status).toBe(403);
      expect(teamAttack.body).toContain('"csrf"');
      expect((await team(true)).body).not.toContain('"csrf"');

      // The terminal socket: refused at the key (403) without it; with it, it gets as far as "no such terminal".
      expect(await upgrade(one.port, cookie, ["toolroll"])).toBe(403);
      expect(await upgrade(one.port, cookie, [])).toBe(403);
      expect(await upgrade(one.port, cookie, ["toolroll", "toolroll.key." + "0".repeat(64)])).toBe(403);
      expect(await upgrade(one.port, cookie, ["toolroll", "toolroll.key." + key])).toBe(404);

      // Sign-out stays a cookie-only act: the attacker can end the session (an accepted residual), nothing more.
      const out = await raw(one.port, "POST", "/logout", { cookie, origin: one.base, "content-type": "application/x-www-form-urlencoded" }, "");
      expect(out.status).toBe(303);
      expect(w.store.raw().prepare("SELECT COUNT(*) AS n FROM web_session").get()).toEqual({ n: 0 });
    });
  });
}

test("before and after a second sign-in: each session has its own key; one session's key never works for another", async () => {
  w = world();
  one = await startConsole(w.store, w.dir);
  const first = await signIn(one.port, w.password), second = await signIn(one.port, w.password);
  expect(first.key).not.toBe(second.key);
  const csrf = await csrfOf(one.port, second.cookie);
  expect((await post(one.port, "/session/forget-password", second.cookie, { csrf }, first.key)).status).toBe(403);
  expect((await post(one.port, "/session/forget-password", second.cookie, { csrf }, second.key)).status).not.toBe(403);
});

test("the refusal says how to reconnect; the delivery page's script names only this origin's storage", async () => {
  w = world();
  one = await startConsole(w.store, w.dir);
  const { cookie, delivery } = await signIn(one.port, w.password);
  expect(deliveredKey(delivery)?.epoch).toBe(one.server.keyEpoch);
  expect(delivery.body).toContain("localStorage.setItem");
  const csrf = await csrfOf(one.port, cookie);
  const refused = await post(one.port, "/session/forget-password", cookie, { csrf });
  expect(refused.body).toContain('href="/login/rekey"');
  expect(refused.body).toContain("Reconnect");
});
