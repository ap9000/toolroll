/**
 * The live token-count check of a Claude sign-in (flexible-sign-in.ts checkSignInToken, saveFlexibleSignIn's check,
 * recheckFlexibleSignIn): one decided outcome per answer, bounded in time and size, never following a redirect, run only
 * after the person's authority was proved, and informational only. Against a scripted stand-in for the model service
 * (flexible-relay-upstreams.ts replaced by vi.mock, as the relay's tests do); made-up tokens; no real model or network.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { setFlexibleSetting } from "./flexible-available.js";
import { hashPassword } from "./scope.js";
import { checkSignInToken, flexibleSignInStatus, recheckFlexibleSignIn, saveFlexibleSignIn, signInCheckWords, statusCheck } from "./flexible-sign-in.js";
import { standInSignIn, standInToken } from "../test/flexible-sign-in-kit.js";

const scripted = vi.hoisted(() => ({ origin: "http://127.0.0.1:9" }));
vi.mock("./flexible-relay-upstreams.js", async importOriginal => {
  const real = await importOriginal<typeof import("./flexible-relay-upstreams.js")>();
  return { FLEXIBLE_RELAY_UPSTREAMS: { claude: { ...real.FLEXIBLE_RELAY_UPSTREAMS.claude, get origin() { return scripted.origin; } } } };
});

const NOW = new Date("2026-11-17T12:00:00.000Z");
const PASSWORD = "alex-password-1";
type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
let dir: string, state: string, store: Store, upstream: Server, seen: Seen[], script: (request: IncomingMessage, response: ServerResponse) => void;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-sign-in-check-")));
  state = join(dir, "toolroll");
  mkdirSync(state);
  store = openStore(join(state, "orders.db"));
  store.saveApprover("alex", hashPassword(PASSWORD), NOW);
  setFlexibleSetting(store, true, "alex", NOW);
  seen = [];
  script = (_request, response) => { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 3 })); };
  upstream = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", chunk => parts.push(chunk));
    request.on("end", () => { seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(parts).toString("utf8") }); script(request, response); });
  });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", () => done()));
  scripted.origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
});
afterEach(async () => {
  upstream.closeAllConnections();
  await new Promise(done => upstream.close(done));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const save = (token: string, password = PASSWORD, check = true) => saveFlexibleSignIn(store, { state, person: "alex", password, token, check, clock: () => NOW });
const active = () => store.handle.prepare("SELECT generation, check_outcome, check_status FROM flexible_sign_in WHERE person = 'alex' AND state = 'active'").get();
const answer = (status: number, body: string, headers: Record<string, string> = { "content-type": "application/json" }) => { script = (_request, response) => { response.writeHead(status, headers).end(body); }; };

describe("the outcome table", () => {
  test("one decided outcome per answer, each labelled; Claude refusing it saves nothing and leaves the working sign-in; the stand-in sees one count_tokens call and no messages", async () => {
    const rows: [number, string, Record<string, string> | undefined, string, string][] = [
      [200, JSON.stringify({ input_tokens: 7 }), undefined, "accepted", "Token-count check accepted."],
      [403, JSON.stringify({ type: "error", error: { type: "permission_error", message: "no" } }), undefined, "inconclusive", "Check inconclusive (HTTP 403)."],
      [400, "{}", undefined, "inconclusive", "Check inconclusive (HTTP 400)."],
      [404, "{}", undefined, "inconclusive", "Check inconclusive (HTTP 404)."],
      [429, "{}", undefined, "inconclusive", "Check inconclusive (HTTP 429)."],
      [503, "{}", undefined, "inconclusive", "Check inconclusive (HTTP 503)."],
      [200, "not json", undefined, "inconclusive", "Check inconclusive (HTTP 200)."],
      [302, "", { location: `${scripted.origin}/elsewhere` }, "inconclusive", "Check inconclusive (redirect refused)."],
    ];
    for (const [status, body, headers, outcome, words] of rows) {
      seen = [];
      answer(status, body, headers);
      const token = standInToken();
      const saved = await save(token);
      expect(saved, `${status} ${body}`).toMatchObject({ ok: true, check: { outcome, status } });
      if (saved.ok) expect(signInCheckWords(saved.check!)).toBe(words);
      expect(active(), `${status}`).toMatchObject({ check_outcome: outcome, check_status: status });
      expect(signInCheckWords(statusCheck(flexibleSignInStatus(store, "alex")))).toBe(words);
      // Exactly one call, to count_tokens, signed in as the relay signs in; the redirect never followed.
      expect(seen.map(one => `${one.method} ${one.url}`)).toEqual(["POST /v1/messages/count_tokens"]);
      expect(seen[0]!.headers.authorization).toBe(`Bearer ${token}`);
      expect(seen[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(JSON.parse(seen[0]!.body)).toMatchObject({ messages: [{ role: "user", content: "hi" }] });
    }
    const working = active()!["generation"];
    for (const [status, type] of [[401, "authentication_error"], [403, "authentication_error"]] as const) {
      answer(status, JSON.stringify({ type: "error", error: { type, message: "invalid" } }));
      const refused = await save(standInToken());
      expect(refused).toMatchObject({ ok: false, reason: "check-refused" });
      expect(JSON.stringify(refused)).not.toContain("invalid");
      expect(active()!["generation"]).toBe(working);
    }
    expect(signInCheckWords({ outcome: "refused", status: 401 })).toBe("Claude didn't accept this sign-in (HTTP 401).");
  });

  test("bounded: a stand-in that never answers is unreachable within the total limit; one that can't be reached is unreachable; a body over the cap is decided on its first 4 KiB", async () => {
    script = () => { /* never answers */ };
    const started = Date.now();
    expect(await checkSignInToken(standInToken(), { connectMs: 5_000, totalMs: 300, bodyBytes: 4096 })).toEqual({ outcome: "unreachable", status: null });
    expect(Date.now() - started).toBeLessThan(5_000);
    scripted.origin = "http://127.0.0.1:1";
    expect(await checkSignInToken(standInToken())).toEqual({ outcome: "unreachable", status: null });
    scripted.origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    // A huge streamed body: decided once 4 KiB is in, without waiting for (or keeping) the rest.
    script = (_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.write(`{"input_tokens":1,"pad":"${"x".repeat(8192)}`); };
    expect(await checkSignInToken(standInToken())).toEqual({ outcome: "inconclusive", status: 200 });
  });

  test("authority first: a refused save sends nothing; --no-check makes no connection and says not checked", async () => {
    expect(await save(standInToken(), "not-it")).toMatchObject({ ok: false, reason: "not-proved" });
    expect(seen).toEqual([]);
    expect(await save(standInToken(), PASSWORD, false)).toMatchObject({ ok: true, check: null });
    expect(seen).toEqual([]);
    expect(active()).toMatchObject({ check_outcome: "not-checked", check_status: null });
  });
});

describe("check again", () => {
  test("informational and tied to its generation: it never clears a refusal, and a late answer never marks a newer sign-in", async () => {
    const first = standInSignIn(store, state, "alex");
    // Claude refused this generation on a call: checking again (and being accepted) doesn't clear it.
    store.handle.prepare(`INSERT INTO thread_relay_call (thread, turn, launch, upstream, at, ended_at, route, streamed, status, http_status, cost_basis, sign_in_person, sign_in_generation, sign_in_refused)
      VALUES (?, ?, ?, 'claude', 't', 't', 'messages', 0, 'upstream-error', 401, 'estimated', 'alex', ?, 1)`).run("a".repeat(32), "b".repeat(32), "c".repeat(32), first.generation);
    expect(await recheckFlexibleSignIn(store, state, { person: "alex", clock: () => NOW })).toEqual({ ok: true, check: { outcome: "accepted", status: 200 } });
    expect(flexibleSignInStatus(store, "alex")).toMatchObject({ state: "refused", checkOutcome: "accepted" });
    // A check under way while a new sign-in is saved: its answer lands on nothing (the older generation is no longer active).
    const second = standInSignIn(store, state, "alex");
    let release: () => void = () => {}, arrived: () => void = () => {};
    const gate = new Promise<void>(done => { release = done; });
    const reached = new Promise<void>(done => { arrived = done; });
    script = (_request, response) => { arrived(); void gate.then(() => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }))); };
    const pending = recheckFlexibleSignIn(store, state, { person: "alex", clock: () => NOW });
    await reached;
    expect(seen.at(-1)!.headers.authorization).toBe(`Bearer ${second.value}`);
    standInSignIn(store, state, "alex");
    release();
    expect(await pending).toMatchObject({ ok: true });
    expect(flexibleSignInStatus(store, "alex")).toMatchObject({ checkOutcome: "not-checked" });
    // No sign-in: nothing to check, nothing sent.
    store.handle.prepare("UPDATE flexible_sign_in SET state = 'retiring', retired_at = 't' WHERE person = 'alex' AND state = 'active'").run();
    const calls = seen.length;
    expect(await recheckFlexibleSignIn(store, state, { person: "alex", clock: () => NOW })).toEqual({ ok: false, reason: "no-sign-in" });
    expect(seen).toHaveLength(calls);
  });
});
