/** Each sender's signature against published vectors where they exist, and against the raw bytes always. */
import { describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { makeSecret, proveDelivery, secretShapeOk, standardKey, type DistinctHeaders } from "./webhook-signing.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const h = (pairs: Record<string, string | string[]>): DistinctHeaders => Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
// Raw bytes that aren't ASCII, and that a parse-then-stringify would change.
const BODY = Buffer.from('{"title":"Ünïcödé — ✓",  "n": 1.0}', "utf8");

describe("Standard Webhooks", () => {
  // The specification's own example (standard-webhooks spec, "Signature scheme").
  const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const vector = { id: "msg_p5jXN8AQM9LWM0D4loKWxJek", stamp: "1614265330", body: Buffer.from('{"test": 2432232314}'), signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" };
  const at = new Date(1614265330 * 1000 + 60_000);
  const sign = (id: string, stamp: string, body: Buffer, secret = SECRET) =>
    `v1,${createHmac("sha256", standardKey(secret)!).update(Buffer.concat([Buffer.from(`${id}.${stamp}.`), body])).digest("base64")}`;

  test("the specification's vector, decoding the whsec_ key's base64 to its bytes", () => {
    expect(proveDelivery("standard", SECRET, h({ "webhook-id": vector.id, "webhook-timestamp": vector.stamp, "webhook-signature": vector.signature }), vector.body, at))
      .toEqual({ ok: true, signedId: vector.id });
  });

  test("any v1 entry in the list may match; malformed ones are passed over, but none well-formed is a refusal", () => {
    const stamp = String(Math.floor(NOW.getTime() / 1000));
    const good = sign("msg_1", stamp, BODY);
    const headers = (signature: string) => h({ "webhook-id": "msg_1", "webhook-timestamp": stamp, "webhook-signature": signature });
    expect(proveDelivery("standard", SECRET, headers(`v1,AAAA v2,zz v1,%%% ${good}`), BODY, NOW)).toMatchObject({ ok: true });
    expect(proveDelivery("standard", SECRET, headers("v1,%%% v2,abc"), BODY, NOW)).toEqual({ ok: false, said: "The webhook-signature has no v1 signature." });
    expect(proveDelivery("standard", SECRET, headers(sign("msg_1", stamp, Buffer.from("other"))), BODY, NOW)).toEqual({ ok: false, said: "Signature doesn't match." });
    // The id is signed: the same signature under another id fails.
    expect(proveDelivery("standard", SECRET, h({ "webhook-id": "msg_2", "webhook-timestamp": stamp, "webhook-signature": good }), BODY, NOW)).toMatchObject({ ok: false });
  });

  test("the timestamp is Unix seconds within five minutes: milliseconds, stale and future ones are refused", () => {
    const seconds = Math.floor(NOW.getTime() / 1000);
    const prove = (stamp: string) => proveDelivery("standard", SECRET, h({ "webhook-id": "m", "webhook-timestamp": stamp, "webhook-signature": sign("m", stamp, BODY) }), BODY, NOW);
    expect(prove(String(seconds - 299))).toMatchObject({ ok: true });
    expect(prove(String(seconds - 301))).toEqual({ ok: false, said: "Too old, or from the future." });
    expect(prove(String(seconds + 301))).toEqual({ ok: false, said: "Too old, or from the future." });
    expect(prove(String(NOW.getTime()))).toEqual({ ok: false, said: "The webhook-timestamp isn't Unix seconds." });
    expect(prove(`${seconds}.5`)).toEqual({ ok: false, said: "The webhook-timestamp isn't Unix seconds." });
  });

  test("each security header exactly once", () => {
    const stamp = String(Math.floor(NOW.getTime() / 1000));
    const signature = sign("m", stamp, BODY);
    expect(proveDelivery("standard", SECRET, h({ "webhook-id": "m", "webhook-timestamp": stamp, "webhook-signature": [signature, "v1,AAAA"] }), BODY, NOW))
      .toEqual({ ok: false, said: "The webhook-signature header was sent more than once." });
    expect(proveDelivery("standard", SECRET, h({ "webhook-timestamp": stamp, "webhook-signature": signature }), BODY, NOW)).toEqual({ ok: false, said: "The webhook-id header is missing." });
  });
});

describe("GitHub-style", () => {
  test("GitHub's documented example, under GitHub's own header and prefix", () => {
    // docs.github.com, "Validating webhook deliveries": secret "It's a Secret to Everybody", payload "Hello, World!".
    const proof = proveDelivery("github-style", "It's a Secret to Everybody", h({ "x-hub-signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17" }), Buffer.from("Hello, World!"), NOW);
    expect(proof).toEqual({ ok: true, signedId: null });
    expect(proveDelivery("github-style", "It's a Secret to Everybody", h({ "x-signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17" }), Buffer.from("Hello, World!"), NOW))
      .toEqual({ ok: false, said: "The x-hub-signature-256 header is missing." });
    expect(proveDelivery("github-style", "s", h({ "x-hub-signature-256": "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17" }), Buffer.from("x"), NOW)).toMatchObject({ ok: false });
  });
});

describe("Sentry and Vercel", () => {
  const SECRET = "a".repeat(64);
  test("Sentry: hex HMAC-SHA256 of the raw bytes; an unsigned delivery says to use an Internal Integration", () => {
    const signature = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(proveDelivery("sentry", SECRET, h({ "sentry-hook-signature": signature }), BODY, NOW)).toEqual({ ok: true, signedId: null });
    expect(proveDelivery("sentry", SECRET, h({ "sentry-hook-signature": signature.toUpperCase() }), BODY, NOW)).toMatchObject({ ok: true });
    // The same JSON re-serialized is other bytes: refused.
    expect(proveDelivery("sentry", SECRET, h({ "sentry-hook-signature": signature }), Buffer.from(JSON.stringify(JSON.parse(BODY.toString()))), NOW)).toEqual({ ok: false, said: "Signature doesn't match." });
    expect(proveDelivery("sentry", SECRET, {}, BODY, NOW)).toEqual({ ok: false, said: "Sentry didn't sign this: use an Internal Integration's webhook." });
    expect(proveDelivery("sentry", SECRET, h({ "sentry-hook-signature": [signature, signature] }), BODY, NOW)).toEqual({ ok: false, said: "The sentry-hook-signature header was sent more than once." });
  });

  test("Vercel: hex HMAC-SHA1 of the raw bytes, never SHA-256", () => {
    expect(proveDelivery("vercel", SECRET, h({ "x-vercel-signature": createHmac("sha1", SECRET).update(BODY).digest("hex") }), BODY, NOW)).toEqual({ ok: true, signedId: null });
    expect(proveDelivery("vercel", SECRET, h({ "x-vercel-signature": createHmac("sha256", SECRET).update(BODY).digest("hex") }), BODY, NOW)).toMatchObject({ ok: false });
  });
});

test("secret shapes: what is pasted is checked against its sender; what is made here passes its own check", () => {
  expect(secretShapeOk("sentry", "ab".repeat(32))).toBe(true);
  expect(secretShapeOk("sentry", "not hex")).toBe(false);
  expect(secretShapeOk("vercel", "Abc123Abc123Abc123")).toBe(true);
  expect(secretShapeOk("vercel", "short")).toBe(false);
  expect(secretShapeOk("standard", "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")).toBe(true);
  expect(secretShapeOk("standard", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")).toBe(false);
  expect(secretShapeOk("standard", makeSecret("standard"))).toBe(true);
  expect(secretShapeOk("github-style", makeSecret("github-style"))).toBe(true);
  expect(makeSecret("standard")).not.toBe(makeSecret("standard"));
});
