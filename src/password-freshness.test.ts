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
import { FRESH_WINDOW_MS, SSO_NOW_MS, freshFacts, freshnessFor, proveAccountNow, spendingOnlyOnSuccess, ssoNowAvailable, withFreshness, type FreshFacts } from "./scope.js";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, sessionWithinLifetime } from "./server/session.js";
import type { Store } from "./store.js";
import { parseSync } from "rolldown/utils";

const NOW = Date.parse("2026-10-20T10:00:00.000Z");
type Over = { passwordAt?: number | null; ssoReauthAt?: number | null; ssoNow?: number | null; floor?: number; live?: boolean; local?: boolean; allowlisted?: boolean; actor?: string };
/** Live facts over a mutable session, as serve.ts makes them. */
function session(over: Over = {}) {
  const state = { passwordAt: NOW - 60_000 as number | null, ssoReauthAt: null as number | null, ssoNow: null as number | null, floor: 0, live: true, ...over };
  const facts: FreshFacts = { actor: over.actor ?? "alex", local: over.local ?? true, allowlisted: over.allowlisted ?? true, live: () => state.live,
    passwordAt: () => state.passwordAt, ssoReauthAt: () => state.ssoReauthAt, ssoNow: () => state.ssoNow,
    consumeSsoNow: () => { const was = state.ssoNow; state.ssoNow = null; return () => { if (state.ssoNow === null) state.ssoNow = was; }; },
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

test("a session past its idle or absolute lifetime is not live (the one reading lookup and every act share)", () => {
  const now = Date.now();
  expect(sessionWithinLifetime({ lastSeen: now - 1_000, createdAt: now - 60_000 }, now)).toBe(true);
  expect(sessionWithinLifetime({ lastSeen: now - SESSION_IDLE_MS - 1, createdAt: now - 60_000 }, now)).toBe(false);
  expect(sessionWithinLifetime({ lastSeen: now - 1_000, createdAt: now - SESSION_ABSOLUTE_MS - 1 }, now)).toBe(false);
  const serve = readFileSync("src/serve.ts", "utf8");
  const live = /const live = \(\) => \{[\s\S]*?\n {4}\};/.exec(serve)![0];
  expect(live).toContain("sessionWithinLifetime(session, now)");
  expect(readFileSync("src/server/guards.ts", "utf8")).toContain("if (!sessionWithinLifetime(session, now)) {");
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

  test("is spent only if the act it proves happens: a refusal or a throw (a rolled-back transaction) puts it back", () => {
    const at = Date.now() - 60_000;
    const { state, facts } = session({ passwordAt: null, ssoNow: at });
    freshFacts.run(facts, () => {
      const refused = spendingOnlyOnSuccess(() => ({ ok: proveAccountNow(NO_STORE, "alex", "").ok && false }), result => !result.ok);
      expect(refused.ok).toBe(false);
      expect(state.ssoNow).toBe(at);
      expect(() => spendingOnlyOnSuccess(() => { proveAccountNow(NO_STORE, "alex", ""); throw new Error("rolled back"); }, () => false)).toThrow("rolled back");
      expect(state.ssoNow).toBe(at);
      expect(spendingOnlyOnSuccess(() => proveAccountNow(NO_STORE, "alex", ""), result => !result.ok).ok).toBe(true);
      expect(state.ssoNow).toBeNull();
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

/**
 * A syntax-aware reading of every source file (.ts and .tsx, oxc's parser via rolldown): member reads, destructuring
 * and calls, whatever the spelling (optional chains, bracket keys, parentheses, aliases of the object).
 */
type Hits = Record<string, Record<string, number>>;
const FACT_NAMES = new Set(["passwordAt", "ssoReauthAt", "ssoNowAt", "freshFloor"]);
const WATCHED_CALLS = new Set(["authenticateAccount", "proveAccountNow", "consumeSsoNow", "freshnessFor", "ssoNowAvailable", "withFreshness", "spendingOnlyOnSuccess"]);
type Node = { type?: string; [key: string]: unknown };
function audit(files: { path: string; text: string }[]): Hits {
  const hits: Hits = {};
  const add = (kind: string, file: string) => { (hits[kind] ??= {})[file] = (hits[kind]![file] ?? 0) + 1; };
  const keyOf = (member: Node): string | null => {
    const property = member["property"] as Node;
    if (member["computed"] === true) return property.type === "Literal" && typeof property["value"] === "string" ? property["value"] as string : null;
    return typeof property["name"] === "string" ? property["name"] as string : null;
  };
  const lastName = (node: Node | null | undefined): string | null => node == null ? null
    : node.type === "Identifier" ? node["name"] as string
    : node.type === "MemberExpression" ? keyOf(node)
    : node.type === "ChainExpression" || node.type === "ParenthesizedExpression" || node.type === "TSNonNullExpression" ? lastName(node["expression"] as Node)
    : null;
  const patternKeys = (pattern: Node): string[] => ((pattern["properties"] as Node[] | undefined) ?? []).map(one => { const key = one["key"] as Node | undefined; return key === undefined ? "" : String(key["name"] ?? key["value"] ?? ""); });
  for (const { path, text } of files) {
    const parsed = parseSync(path, text, { lang: path.endsWith(".tsx") ? "tsx" : "ts" });
    if (parsed.errors.length > 0) { add("unparsed", path); continue; }
    // Aliases of an SSO object in this file (`const s = ctx.sso`): their `fresh` is the same read.
    const aliases = new Set(["sso"]);
    const collect = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const one of node) collect(one); return; }
      const one = node as Node;
      if (one.type === "VariableDeclarator" && (one["id"] as Node).type === "Identifier" && lastName(one["init"] as Node) === "sso") aliases.add((one["id"] as Node)["name"] as string);
      for (const [key, value] of Object.entries(one)) if (key !== "type") collect(value);
    };
    collect(parsed.program);
    const ssoLike = (node: Node | null | undefined) => { const name = lastName(node); return name !== null && aliases.has(name); };
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const one of node) walk(one); return; }
      const one = node as Node;
      if (one.type === "MemberExpression") {
        const name = keyOf(one);
        if (name === "fresh" && ssoLike(one["object"] as Node)) add("sso.fresh", path);
        if (name !== null && FACT_NAMES.has(name)) add(`.${name}`, path);
      }
      if (one.type === "VariableDeclarator" && (one["id"] as Node).type === "ObjectPattern") {
        const keys = patternKeys(one["id"] as Node);
        if (keys.includes("fresh") && ssoLike(one["init"] as Node)) add("sso.fresh", path);
        for (const key of keys) if (FACT_NAMES.has(key)) add(`{${key}}`, path);
      }
      if (one.type === "CallExpression") { const name = lastName(one["callee"] as Node); if (name !== null && WATCHED_CALLS.has(name)) add(`${name}()`, path); }
      for (const [key, value] of Object.entries(one)) if (key !== "type") walk(value);
    };
    walk(parsed.program);
  }
  return hits;
}

describe("where freshness may be honoured", () => {
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(one => one.isDirectory() ? sources(join(dir, one.name))
    : /\.tsx?$/.test(one.name) && !/\.test\.tsx?$/.test(one.name) && !one.name.endsWith(".d.ts") ? [join(dir, one.name)] : []);
  const files = sources("src").map(path => ({ path, text: readFileSync(path, "utf8") }));
  const hits = audit(files);
  const using = (pattern: RegExp) => files.filter(one => pattern.test(one.text)).map(one => one.path).sort();

  test("the reader catches what a regex misses: a bypass spelled any way is seen", () => {
    const bypasses = [
      "if (!token && requestContext.getStore()?.sso?.fresh) return ok;",
      "const s = ctx.sso; if (s && (s)['fresh']) return ok;",
      "const { fresh } = who.session.sso; if (fresh) return ok;",
      "const t = session.ssoNowAt; const { passwordAt } = session;",
      "void (facts.consumeSsoNow)(); proveAccountNow(store, who, '');",
    ];
    const caught = audit(bypasses.map((text, index) => ({ path: `probe-${index}.ts`, text: `export function probe(token: string, ok: unknown) { ${text} }` })));
    expect(caught["unparsed"]).toBeUndefined();
    expect(Object.keys(caught["sso.fresh"] ?? {}).sort()).toEqual(["probe-0.ts", "probe-1.ts", "probe-2.ts"]);
    expect(caught[".ssoNowAt"]).toEqual({ "probe-3.ts": 1 });
    expect(caught["{passwordAt}"]).toEqual({ "probe-3.ts": 1 });
    expect(caught["consumeSsoNow()"]).toEqual({ "probe-4.ts": 1 });
    expect(caught["proveAccountNow()"]).toEqual({ "probe-4.ts": 1 });
  });

  test("every source file is read", () => {
    expect(hits["unparsed"]).toBeUndefined();
    expect(files.some(one => one.path.endsWith(".tsx"))).toBe(true);
  });

  test("exactly three routes are allowlisted: approving a plan, confirming a chat proposal (its scope_approve only), and sending a chat message", () => {
    expect(ROUTES.filter(one => one.freshness === "allowlist").map(one => one.id).sort()).toEqual(["chat.proposal.confirm", "chat.send", "task.act.approve"]);
  });

  test("an SSO 'fresh' flag authorises nothing: it is read only to draw the step-up field's words", () => {
    expect(hits["sso.fresh"]).toEqual({ "src/mcp-oauth.ts": 1, "src/serve.ts": 1, "src/server/render-people.ts": 1 });
    // serve.ts: the flow view's step-up words (its browser form shows "Confirmed with …" or the link), nothing else.
    expect(files.find(one => one.path === "src/serve.ts")!.text.split("\n").filter(line => /ssoFacts\.fresh/.test(line)).every(line => /stepUp: \{ label: ssoFacts\.label, fresh: ssoFacts\.fresh/.test(line))).toBe(true);
    expect(files.find(one => one.path === "src/mcp-oauth.ts")!.text.split("\n").filter(line => /sso\??\.fresh/.test(line)).every(line => /const step = /.test(line))).toBe(true);
    expect(files.find(one => one.path === "src/server/render-people.ts")!.text.split("\n").filter(line => /sso\??\.fresh/.test(line)).every(line => /\$\{sso\.fresh/.test(line))).toBe(true);
  });

  test("the session's freshness facts are read and written only where the plan says, and never persisted", () => {
    // serve.ts makes the live facts (and the sidebar chip); people-tokens.ts stamps the re-check; settings.ts is Forget;
    // scope.ts reads them only through the facts' own readers.
    expect(hits[".passwordAt"]).toEqual({ "src/scope.ts": 1, "src/serve.ts": 3, "src/server/settings.ts": 1 });
    expect(hits[".ssoReauthAt"]).toEqual({ "src/scope.ts": 1, "src/serve.ts": 1, "src/server/people-tokens.ts": 1, "src/server/settings.ts": 1 });
    expect(hits[".ssoNowAt"]).toEqual({ "src/serve.ts": 5, "src/server/people-tokens.ts": 1, "src/server/settings.ts": 1 });
    expect(hits[".freshFloor"]).toEqual({ "src/serve.ts": 1, "src/server/settings.ts": 1 });
    for (const name of FACT_NAMES) expect(hits[`{${name}}`]).toBeUndefined();
    expect((files.find(one => one.path === "src/server/people-tokens.ts")!.text.match(/passwordAt: Date\.now\(\)/g) ?? []).length).toBe(2);
    for (const line of files.find(one => one.path === "src/server/people-tokens.ts")!.text.split("\n").filter(one => one.includes("passwordAt: Date.now()"))) {
      expect(line).toContain("fromThisComputer(request) ?");
    }
    const persisted = /saveWebSession\(\{[^}]*\}/.exec(files.find(one => one.path === "src/server/session.ts")!.text)![0];
    expect(persisted).not.toMatch(/passwordAt|ssoReauthAt|ssoNowAt|freshFloor/);
  });

  test("an allowlisted act opts in only at its own call sites; a re-check is spent in one place, refunded around approvals", () => {
    expect(hits["withFreshness()"]).toEqual({ "src/chat-actions.ts": 2, "src/server/chat.ts": 2, "src/server/task-views.ts": 1, "src/server/tasks.ts": 2 });
    expect(hits["consumeSsoNow()"]).toEqual({ "src/scope.ts": 1 });
    expect(hits["spendingOnlyOnSuccess()"]).toEqual({ "src/chat-actions.ts": 1, "src/server/tasks.ts": 1 });
    expect(using(/freshFacts\.run\(/)).toEqual(["src/serve.ts", "src/server/remote.ts"]);
    expect((files.find(one => one.path === "src/serve.ts")!.text.match(/function freshFactsOf\(/g) ?? []).length).toBe(1);
  });

  test("a password is checked only at known places, and every console empty-field step-up goes through proveAccountNow", () => {
    expect(hits["authenticateAccount()"]).toEqual({
      "src/operate.ts": 1, "src/principal.ts": 1, "src/scope.ts": 1, "src/server/guards.ts": 1, "src/server/people-tokens.ts": 2,
      "src/server/settings.ts": 2, "src/tokens-cli.ts": 1,
    });
    // The two settings checks are typed-now ceremonies (they also compare the generation); never an empty field.
    for (const line of files.find(one => one.path === "src/server/settings.ts")!.text.split("\n").filter(one => one.includes("authenticateAccount("))) expect(line).toMatch(/body\.get\("(token|password)"\)/);
    expect(hits["proveAccountNow()"]).toEqual({ "src/scope.ts": 1, "src/server/people-tokens.ts": 1, "src/server/remote.ts": 1 });
    // The two known empty-password branches: starting chat stands on the signed-in session's standing by design (no
    // password stand-in), and a Telegram log redaction. Anything new that branches on one must be reviewed.
    expect(using(/(typed|token|password)\s*===\s*""\s*\?/)).toEqual(["src/server/chat.ts", "src/telegram.ts"]);
    expect(using(/SSO_NOW_MS|FRESH_WINDOW_MS/)).toEqual(["src/scope.ts", "src/serve.ts"]);
  });
});
