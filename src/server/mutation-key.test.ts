/** The browser mutation key's one check (easy-start C2): which requests present a key, and what each session hears. */
import type { IncomingMessage } from "node:http";
import { describe, expect, test } from "vitest";
import { createBrowserKeys, keyHashOf, keyMatches, presentedKey } from "./mutation-key.js";
import type { Session, Who } from "./session.js";

const KEY = "a".repeat(64), OTHER = "b".repeat(64);
const request = (headers: Record<string, string | string[]> = {}, host = "127.0.0.1:4180") => ({ headers: { host, ...headers } }) as unknown as IncomingMessage;
const body = (fields: Record<string, string[]> = {}) => ({ getAll: (name: string) => fields[name] ?? [] });

describe("presentedKey", () => {
  test.each([
    ["the header", request({ "x-toolroll-key": KEY }), null, KEY],
    ["the form field", request(), body({ "toolroll-key": [KEY] }), KEY],
    ["the socket protocol", request({ "sec-websocket-protocol": `toolroll, toolroll.key.${KEY}` }), null, KEY],
    ["the same key by two roads", request({ "x-toolroll-key": KEY }), body({ "toolroll-key": [KEY] }), KEY],
    ["nothing", request(), body(), null],
    ["two different keys", request({ "x-toolroll-key": KEY }), body({ "toolroll-key": [OTHER] }), null],
    ["two different fields", request(), body({ "toolroll-key": [KEY, OTHER] }), null],
    ["a repeated header", request({ "x-toolroll-key": [KEY, KEY] }), null, null],
    ["a malformed key", request({ "x-toolroll-key": "A".repeat(64) }), null, null],
    ["a short key", request({ "x-toolroll-key": "a".repeat(63) }), null, null],
  ])("%s", (_name, req, form, expected) => { expect(presentedKey(req, form)).toBe(expected); });
});

test("keyMatches compares hashes and refuses a missing or malformed one", () => {
  expect(keyMatches(KEY, keyHashOf(KEY))).toBe(true);
  expect(keyMatches(OTHER, keyHashOf(KEY))).toBe(false);
  expect(keyMatches(KEY, null)).toBe(false);
  expect(keyMatches(KEY, "nothex")).toBe(false);
});

describe("check", () => {
  const session = (fields: Partial<Session>) => ({ keyEpoch: "e1", keyHash: keyHashOf(KEY), ...fields }) as Session;
  const browser = (fields: Partial<Session> = {}, authority: "full" | "local-owner" = "full"): Who => ({ via: "cookie", name: "alex", role: "approver", authority, session: session(fields) });
  const keys = (enabled = true, host: string | null = "127.0.0.1:4180") => createBrowserKeys({ enabled, epoch: "e1", protectedHost: () => host });
  test.each([
    ["the session's key", keys(), browser(), request({ "x-toolroll-key": KEY }), null],
    ["no key", keys(), browser(), request(), 403],
    ["another session's key", keys(), browser(), request({ "x-toolroll-key": OTHER }), 403],
    ["an earlier start's session", keys(), browser({ keyEpoch: "e0" }), request({ "x-toolroll-key": KEY }), 409],
    ["a session saved before keys", keys(), browser({ keyEpoch: null, keyHash: null }), request(), 409],
    ["a local owner with no key", keys(), browser({}, "local-owner"), request(), 403],
    ["not a protected install", keys(true, null), browser(), request(), null],
    ["the key turned off", keys(false), browser(), request(), null],
    ["an API token", keys(), { via: "bearer", name: "alex", role: "approver", generation: 1 } as Who, request(), null],
  ])("%s", (_name, browserKeys, who, req, status) => { expect(browserKeys.check(who, req, null)?.status ?? null).toBe(status); });

  test("a refusal names how to reconnect: the password for a full session, the terminal for a local owner", () => {
    expect(keys().check(browser({ keyEpoch: "e0" }), request(), null)?.reconnect).toEqual({ kind: "password", href: "/login/rekey" });
    expect(keys().check(browser({ keyEpoch: "e0" }, "local-owner"), request(), null)).toMatchObject({ status: 409, reconnect: { kind: "command", command: "toolroll --web" } });
  });

  test("a key is issued only on the canonical origin, and only its hash and this start's epoch are kept", () => {
    const fields = { keyEpoch: null as string | null, keyHash: null as string | null };
    expect(keys().issue(fields, request({}, "localhost:4180"))).toBeNull();
    expect(fields).toEqual({ keyEpoch: null, keyHash: null });
    const key = keys().issue(fields, request());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(fields).toEqual({ keyEpoch: "e1", keyHash: keyHashOf(key!) });
    expect(keys(true, null).issue(fields, request())).toBeNull();
  });
});
