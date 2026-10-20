/**
 * Password freshness (docs/plans/agents-cockpit.md B2): a password verified on this session in the last fifteen
 * minutes stands in for one typed now ONLY inside an allowlisted act, for that person, on a direct local request,
 * within its window, after any Forget — and the routes, the call sites and the one reading of SSO freshness are
 * exactly where the plan says.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ROUTES } from "./server/route-table.js";
import { FRESH_WINDOW_MS, freshFacts, freshnessFor, ssoCheckedNow, withFreshness, type FreshFacts } from "./scope.js";

const NOW = Date.parse("2026-10-20T10:00:00.000Z");
const facts = (over: Partial<FreshFacts> = {}): FreshFacts => ({ actor: "alex", passwordAt: NOW - 60_000, ssoAt: null, local: true, floor: 0, stamp: () => {}, ...over });
const read = (over: Partial<FreshFacts>, op = true, by = "alex", now = NOW) =>
  freshFacts.run(facts(over), () => op ? withFreshness("approve-standard", () => freshnessFor(by, now)) : freshnessFor(by, now));

describe("the window", () => {
  test("only inside an allowlisted act, for that person, on a direct local request, within fifteen minutes, after any Forget", () => {
    expect(read({})).toEqual({ method: "fresh-password", at: NOW - 60_000 });
    expect(read({}, false)).toBeNull();
    expect(read({}, true, "robin")).toBeNull();
    expect(read({ local: false })).toBeNull();
    expect(read({ passwordAt: NOW - FRESH_WINDOW_MS - 1 })).toBeNull();
    expect(read({ floor: NOW - 30_000 })).toBeNull();
    expect(read({ passwordAt: null, ssoAt: NOW - 120_000 })).toEqual({ method: "fresh-sso", at: NOW - 120_000 });
    expect(read({ passwordAt: null, ssoAt: 0 })).toBeNull();
    // Not extended by use: a later read sees the same entry time.
    expect(read({}, true, "alex", NOW + 10 * 60_000)).toEqual({ method: "fresh-password", at: NOW - 60_000 });
    expect(read({}, true, "alex", NOW + FRESH_WINDOW_MS)).toBeNull();
  });

  test("an identity-provider check counts as now for ten minutes, and never when it carried no time", () => {
    expect(ssoCheckedNow(NOW - 60_000, NOW)).toBe(true);
    expect(ssoCheckedNow(NOW - 11 * 60_000, NOW)).toBe(false);
    expect(ssoCheckedNow(0, NOW)).toBe(false);
    expect(ssoCheckedNow(undefined, NOW)).toBe(false);
    expect(ssoCheckedNow(NOW + 5 * 60_000, NOW)).toBe(false);
  });
});

describe("where freshness may be honoured", () => {
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(one => one.isDirectory() ? sources(join(dir, one.name))
    : one.name.endsWith(".ts") && !one.name.endsWith(".test.ts") ? [join(dir, one.name)] : []);
  const files = sources("src").map(path => ({ path, text: readFileSync(path, "utf8") }));
  const using = (pattern: RegExp) => files.filter(one => pattern.test(one.text)).map(one => one.path).sort();

  test("exactly two routes are allowlisted: approving a plan, and sending a chat message", () => {
    expect(ROUTES.filter(one => one.freshness === "allowlist").map(one => one.id).sort()).toEqual(["chat.send", "task.act.approve"]);
  });

  test("an allowlisted act opts in only at its own call sites; the facts are set in one place; SSO freshness is read through one function", () => {
    expect(using(/withFreshness\(/)).toEqual(["src/server/chat.ts", "src/server/task-views.ts", "src/server/tasks.ts"]);
    expect(using(/freshFacts\.run\(/)).toEqual(["src/serve.ts"]);
    expect(using(/SSO_NOW_MS/)).toEqual(["src/scope.ts"]);
    expect(using(/ssoCheckedNow\(/)).toEqual(["src/scope.ts", "src/serve.ts", "src/server/remote.ts"]);
    // No handler compares a sign-in time itself.
    expect(using(/sso\??\.at\s*[<>]|-\s*[a-z.?]*sso\??\.at/)).toEqual([]);
  });
});
