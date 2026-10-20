/**
 * Password freshness (docs/plans/agents-cockpit.md B2): a password verified on this session in the last fifteen
 * minutes stands in for one typed now ONLY inside an allowlisted act on an allowlisted route, for that person, on a
 * direct local request, on a live session, within its window, after any Forget. An explicit identity-provider re-check
 * stands in for ONE step-up (spent by it). Every fact is read at the moment of the act. And the routes, the call sites
 * and every honouring of an empty password field are exactly where the plan says.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ROUTES } from "./server/route-table.js";
import { sameVisitCheck } from "./server/people-tokens.js";
import { FRESH_WINDOW_MS, SSO_NOW_MS, freshFacts, freshnessFor, proveAccountNow, ssoNowAvailable, withFreshness, type FreshFacts } from "./scope.js";
import type { Store } from "./store.js";

const NOW = Date.parse("2026-10-20T10:00:00.000Z");
type Over = { passwordAt?: number | null; ssoReauthAt?: number | null; ssoNow?: number | null; floor?: number; live?: boolean; local?: boolean; allowlisted?: boolean; actor?: string };
/** Live facts over a mutable session, as serve.ts makes them. */
function session(over: Over = {}) {
  const state = { passwordAt: NOW - 60_000 as number | null, ssoReauthAt: null as number | null, ssoNow: null as number | null, floor: 0, live: true, ...over };
  const facts: FreshFacts = { actor: over.actor ?? "alex", local: over.local ?? true, allowlisted: over.allowlisted ?? true, live: () => state.live,
    passwordAt: () => state.passwordAt, ssoReauthAt: () => state.ssoReauthAt, ssoNow: () => state.ssoNow, consumeSsoNow: () => { state.ssoNow = null; },
    floor: () => state.floor, stamp: at => { state.passwordAt = at; } };
  return { state, facts };
}
const read = (over: Over, op = true, by = "alex", now = NOW) =>
  freshFacts.run(session(over).facts, () => op ? withFreshness("approve-standard", () => freshnessFor(by, now)) : freshnessFor(by, now));
const NO_STORE = {} as Store;

describe("the window", () => {
  test("only inside an allowlisted act on an allowlisted route, for that person, on a direct local live request, within fifteen minutes, after any Forget", () => {
    expect(read({})).toEqual({ method: "fresh-password", at: NOW - 60_000 });
    expect(read({}, false)).toBeNull();
    expect(read({}, true, "robin")).toBeNull();
    expect(read({ local: false })).toBeNull();
    expect(read({ allowlisted: false })).toBeNull();
    expect(read({ live: false })).toBeNull();
    expect(read({ passwordAt: NOW - FRESH_WINDOW_MS - 1 })).toBeNull();
    expect(read({ floor: NOW - 30_000 })).toBeNull();
    expect(read({ passwordAt: null, ssoReauthAt: NOW - 120_000 })).toEqual({ method: "fresh-sso", at: NOW - 120_000 });
    expect(read({ passwordAt: null, ssoReauthAt: 0 })).toBeNull();
    // Not extended by use: a later read sees the same entry time.
    expect(read({}, true, "alex", NOW + 10 * 60_000)).toEqual({ method: "fresh-password", at: NOW - 60_000 });
    expect(read({}, true, "alex", NOW + FRESH_WINDOW_MS)).toBeNull();
  });

  test("a page may preview what its allowlisted form would accept; the preview never authorises", () => {
    const { facts } = session({ allowlisted: false, passwordAt: Date.now() - 60_000 });
    expect(freshFacts.run(facts, () => withFreshness("approve-standard", () => freshnessFor("alex", Date.now(), true)))?.method).toBe("fresh-password");
    expect(freshFacts.run(facts, () => withFreshness("approve-standard", () => proveAccountNow(NO_STORE, "alex", "")))).toEqual({ ok: false, reason: "not-an-approver" });
  });

  test("every fact is read at the moment of the act: Forget, sign-out or a credential change made mid-request is seen", () => {
    const { state, facts } = session({ passwordAt: Date.now() - 60_000 });
    freshFacts.run(facts, () => withFreshness("approve-standard", () => {
      expect(proveAccountNow(NO_STORE, "alex", "").ok).toBe(true);
      state.floor = Date.now();
      expect(proveAccountNow(NO_STORE, "alex", "").ok).toBe(false);
      state.floor = 0; state.live = false;
      expect(proveAccountNow(NO_STORE, "alex", "").ok).toBe(false);
      // A session no longer signed in proves nothing, not even with a password typed (it is never checked).
      expect(proveAccountNow(NO_STORE, "alex", "typed").ok).toBe(false);
    }));
  });
});

describe("an explicit identity-provider re-check", () => {
  test("stands in for ONE step-up of any kind within five minutes, and is spent by it", () => {
    const at = Date.now() - 60_000;
    const { state, facts } = session({ passwordAt: null, ssoNow: at });
    freshFacts.run(facts, () => {
      expect(ssoNowAvailable("alex")).toBe(true);
      expect(ssoNowAvailable("robin")).toBe(false);
      // Outside any allowlisted act (a never route): still one step-up.
      expect(proveAccountNow(NO_STORE, "alex", "")).toEqual({ ok: true, method: "sso-now", at });
      expect(state.ssoNow).toBeNull();
      expect(proveAccountNow(NO_STORE, "alex", "").ok).toBe(false);
    });
  });

  test("never when stale, forgotten, signed out or from nowhere", () => {
    for (const over of [{ ssoNow: Date.now() - SSO_NOW_MS - 1 }, { ssoNow: Date.now() - 1_000, floor: Date.now() }, { ssoNow: Date.now() - 1_000, live: false }, { ssoNow: 0 }]) {
      const { facts } = session({ passwordAt: null, ...over });
      expect(freshFacts.run(facts, () => proveAccountNow(NO_STORE, "alex", "").ok)).toBe(false);
    }
    // No facts at all (a machine, a bearer): an empty field is nothing.
    expect(proveAccountNow(NO_STORE, "alex", "").ok).toBe(false);
  });

  test("the provider's check must be made for this visit: never before the visit began (only auth_time's own second)", () => {
    const started = NOW + 400;
    expect(sameVisitCheck(Math.floor(NOW / 1000), started, NOW + 5_000)).toBe(started);
    expect(sameVisitCheck(Math.floor(NOW / 1000) - 1, started, NOW + 5_000)).toBeNull();
    expect(sameVisitCheck(Math.floor((NOW - 30_000) / 1000), started, NOW + 5_000)).toBeNull();
    expect(sameVisitCheck(Math.floor((NOW + 3_000) / 1000), started, NOW + 5_000)).toBe(NOW + 3_000);
    expect(sameVisitCheck(Math.floor((NOW + 120_000) / 1000), started, NOW + 5_000)).toBeNull();
    expect(sameVisitCheck(null, started, NOW)).toBeNull();
  });
});

describe("where freshness may be honoured", () => {
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(one => one.isDirectory() ? sources(join(dir, one.name))
    : one.name.endsWith(".ts") && !one.name.endsWith(".test.ts") ? [join(dir, one.name)] : []);
  const files = sources("src").map(path => ({ path, text: readFileSync(path, "utf8") }));
  const using = (pattern: RegExp) => files.filter(one => pattern.test(one.text)).map(one => one.path).sort();
  const count = (pattern: RegExp) => Object.fromEntries(files.map(one => [one.path, (one.text.match(new RegExp(pattern.source, "g")) ?? []).length] as const).filter(([, n]) => n > 0));

  test("exactly three routes are allowlisted: approving a plan, confirming a chat proposal (its scope_approve only), and sending a chat message", () => {
    expect(ROUTES.filter(one => one.freshness === "allowlist").map(one => one.id).sort()).toEqual(["chat.proposal.confirm", "chat.send", "task.act.approve"]);
  });

  test("an allowlisted act opts in only at its own call sites; the facts are made in one place and run in two", () => {
    expect(count(/withFreshness\(/)).toEqual({ "src/chat-actions.ts": 2, "src/server/chat.ts": 1, "src/server/task-views.ts": 1, "src/server/tasks.ts": 2 });
    expect(using(/freshFacts\.run\(/)).toEqual(["src/serve.ts", "src/server/remote.ts"]);
    expect(count(/function freshFactsOf\(/)).toEqual({ "src/serve.ts": 1 });
  });

  test("no handler honours an empty password itself: no SSO 'fresh' flag authorises, no time comparison", () => {
    // `sso.fresh` is rendering only (the step-up field's words); it authorises nothing anywhere.
    expect(using(/sso\??\.fresh\s*===\s*true/)).toEqual(["src/mcp-oauth.ts"]);
    expect(files.find(one => one.path === "src/mcp-oauth.ts")!.text.split("\n").filter(line => /sso\??\.fresh/.test(line)).every(line => /const step = /.test(line))).toBe(true);
    // The two known: starting chat stands on the signed-in session's standing by design (no password stand-in), and a
    // Telegram log redaction. Anything else that branches on an empty password is new and must be reviewed.
    expect(using(/(typed|token|password)\s*===\s*""\s*\?/)).toEqual(["src/server/chat.ts", "src/telegram.ts"]);
    expect(using(/sso\??\.at\s*[<>]|-\s*[a-z.?]*sso\??\.at/)).toEqual([]);
    expect(using(/SSO_NOW_MS|FRESH_WINDOW_MS/)).toEqual(["src/scope.ts", "src/serve.ts"]);
  });

  test("only the plan's events write the session's freshness facts, and none of them is ever persisted", () => {
    expect(count(/session\.(passwordAt|ssoReauthAt|ssoNowAt|freshFloor)\s*=(?!=)/)).toEqual({ "src/serve.ts": 1, "src/server/people-tokens.ts": 2, "src/server/settings.ts": 1 });
    expect(count(/passwordAt: Date\.now\(\)/)).toEqual({ "src/server/people-tokens.ts": 2 });
    // Every login-time stamp is guarded by the transport check on the same line.
    for (const line of files.find(one => one.path === "src/server/people-tokens.ts")!.text.split("\n").filter(one => one.includes("passwordAt: Date.now()"))) {
      expect(line).toContain("fromThisComputer(request) ?");
    }
    const persisted = /saveWebSession\(\{[^}]*\}/.exec(files.find(one => one.path === "src/server/session.ts")!.text)![0];
    expect(persisted).not.toMatch(/passwordAt|ssoReauthAt|ssoNowAt|freshFloor/);
  });

  test("a password is checked only at known places, and every console empty-field step-up goes through proveAccountNow", () => {
    expect(count(/authenticateAccount\(/)).toEqual({
      "src/operate.ts": 1, "src/principal.ts": 1, "src/scope.ts": 2, "src/server/guards.ts": 1, "src/server/people-tokens.ts": 2,
      "src/server/settings.ts": 2, "src/tokens-cli.ts": 1,
    });
    // The two settings checks are typed-now ceremonies (they also compare the generation); never an empty field.
    for (const line of files.find(one => one.path === "src/server/settings.ts")!.text.split("\n").filter(one => one.includes("authenticateAccount("))) expect(line).toMatch(/body\.get\("(token|password)"\)/);
    expect(using(/proveAccountNow\(/)).toEqual(["src/scope.ts", "src/server/people-tokens.ts", "src/server/remote.ts"]);
  });
});
