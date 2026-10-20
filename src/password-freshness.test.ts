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
      // An inner act that succeeded inside an outer one that then fails (its transaction rolled back): put back.
      expect(() => spendingOnlyOnSuccess(() => { spendingOnlyOnSuccess(() => proveAccountNow(NO_STORE, "alex", ""), result => !result.ok); throw new Error("outer rolled back"); }, () => false)).toThrow("outer rolled back");
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
/** Every production module the compiler or runtime could load from src: TS and JS in all their module flavours. */
const MODULE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;
/** Exactly what tsconfig.json leaves out (`*.test.ts`, `*.test.tsx`) and declarations: everything else is read. */
const audited = (name: string): boolean => MODULE.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.[cm]?ts$/.test(name);
const productionSources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(one => one.isDirectory() ? productionSources(join(dir, one.name))
  : audited(one.name) ? [join(dir, one.name)] : []);
const langOf = (path: string): "ts" | "tsx" | "js" | "jsx" => /x$/.test(path) ? (/\.[cm]?jsx$/.test(path) ? "jsx" : "tsx") : /\.[cm]?js$/.test(path) ? "js" : "ts";
type Hits = Record<string, Record<string, number>>;
/** Nodes that change only types or grouping: what flows through them, and who owns it, is unchanged. */
const WRAPPERS = ["ChainExpression", "ParenthesizedExpression", "TSNonNullExpression", "TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion"];
const FACT_NAMES = new Set(["passwordAt", "ssoReauthAt", "ssoNowAt", "freshFloor"]);
const WATCHED_CALLS = new Set(["authenticateAccount", "authenticateApprover", "checkApproverPassword", "proveAccountNow", "consumeSsoNow", "freshnessFor", "ssoNowAvailable", "withFreshness", "spendingOnlyOnSuccess", "spendingOnlyIfDone"]);
type Node = { type?: string; [key: string]: unknown };
const each = (node: unknown, visit: (one: Node) => void): void => {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const one of node) each(one, visit); return; }
  visit(node as Node);
  for (const [key, value] of Object.entries(node as Node)) if (key !== "type") each(value, visit);
};
function audit(files: { path: string; text: string }[]): Hits {
  const hits: Hits = {};
  const add = (kind: string, file: string) => { (hits[kind] ??= {})[file] = (hits[kind]![file] ?? 0) + 1; };
  const keyOf = (member: Node): string | null => {
    const property = member["property"] as Node;
    if (member["computed"] === true) return property.type === "Literal" && typeof property["value"] === "string" ? property["value"] as string : null;
    return typeof property["name"] === "string" ? property["name"] as string : null;
  };
  /** The name an expression ends in, through optional chains, parentheses and type-only wrappers (as, satisfies, !). */
  const lastName = (node: Node | null | undefined): string | null => node == null ? null
    : node.type === "Identifier" ? node["name"] as string
    : node.type === "MemberExpression" ? keyOf(node)
    : ["ChainExpression", "ParenthesizedExpression", "TSNonNullExpression", "TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion"].includes(node.type ?? "") ? lastName(node["expression"] as Node)
    : null;
  const keyName = (key: Node | undefined): string => key === undefined ? "" : String(key["name"] ?? key["value"] ?? "");
  for (const { path, text } of files) {
    const parsed = parseSync(path, text, { lang: langOf(path) });
    if (parsed.errors.length > 0) { add("unparsed", path); continue; }
    // Local names for an SSO object and for each watched function, closed under aliasing (`const a = ctx.sso`,
    // `const b = a`, `const { sso: c } = ctx`, `import { authenticateAccount as check }`, `const check2 = check`).
    const sso = new Set(["sso"]);
    const calls = new Map<string, string>([...WATCHED_CALLS].map(name => [name, name]));
    let changed = false;
    const learn = (set: Set<string> | Map<string, string>, local: string, original: string) => {
      if (set instanceof Set) { if (!set.has(local)) { set.add(local); changed = true; } }
      else if (!set.has(local)) { set.set(local, original); changed = true; }
    };
    const unwrap = (node: Node | null | undefined): Node | null => node == null ? null : WRAPPERS.includes(node.type ?? "") ? unwrap(node["expression"] as Node) : node;
    /**
     * ONE reading of how a value flows into a pattern, used both to learn aliases and to flag reads: from the value's
     * node when it is known (object and array literals map member by member, through `as`/`satisfies`/parentheses; a
     * default is a source too), otherwise from the name it was destructured under. `read(key, from)` sees every key
     * taken out of a value whose source name is `from`.
     */
    const flow = (target: Node, value: Node | null, name: string | null, read: (key: string, from: string | null) => void): void => {
      const given = unwrap(value);
      const from = given !== null ? lastName(given) : name;
      if (target.type === "AssignmentPattern") {
        flow(target["left"] as Node, value, name, read);
        flow(target["left"] as Node, target["right"] as Node, null, read);
        return;
      }
      if (target.type === "Identifier") {
        if (from !== null && sso.has(from)) learn(sso, target["name"] as string, "sso");
        if (from !== null && calls.has(from) && given?.type !== "CallExpression") learn(calls, target["name"] as string, calls.get(from)!);
        return;
      }
      if (target.type === "RestElement") return flow(target["argument"] as Node, value, name, read);
      if (target.type === "ObjectPattern") {
        const members = given?.type === "ObjectExpression" ? given["properties"] as Node[] : null;
        for (const property of target["properties"] as Node[]) {
          // The rest of an SSO object is still an SSO object.
          if (property.type === "RestElement") { flow(property["argument"] as Node, value, name, read); continue; }
          const key = keyName(property["key"] as Node);
          read(key, from);
          const member = members?.find(one => one.type === "Property" && one["computed"] !== true && keyName(one["key"] as Node) === key);
          flow(property["value"] as Node, member === undefined ? null : member["value"] as Node, member === undefined ? key : null, read);
        }
        return;
      }
      if (target.type === "ArrayPattern") {
        const items = given?.type === "ArrayExpression" ? given["elements"] as (Node | null)[] : null;
        (target["elements"] as (Node | null)[]).forEach((element, index) => {
          if (element === null) return;
          const item = items?.[index] ?? null;
          flow(element, item?.type === "SpreadElement" ? item["argument"] as Node : item, items === null ? from : null, read);
        });
      }
    };
    const paramsOf = (node: Node): Node[] => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type ?? "") ? (node["params"] as Node[]) : [];
    const bindings = (one: Node, read: (key: string, from: string | null) => void) => {
      if (one.type === "VariableDeclarator") flow(one["id"] as Node, one["init"] as Node, null, read);
      if (one.type === "AssignmentExpression") flow(one["left"] as Node, one["right"] as Node, null, read);
      // A parameter's pattern binds from whatever is passed (its own keys say what it takes) or from its default.
      for (const param of paramsOf(one)) flow((param.type === "TSParameterProperty" ? param["parameter"] : param) as Node, null, null, read);
    };
    do {
      changed = false;
      each(parsed.program, one => {
        if (one.type === "ImportSpecifier") {
          const imported = keyName(one["imported"] as Node), local = keyName(one["local"] as Node);
          if (calls.has(imported)) learn(calls, local, calls.get(imported)!);
        }
        // A watched function (or an SSO object) stored under a key in an object or class: that key now names it
        // (`{ check: rawCheck }` makes `passwordChecks.check(...)` a call of it).
        if ((one.type === "Property" || one.type === "PropertyDefinition") && one["computed"] !== true) {
          const value = lastName(unwrap(one["value"] as Node)), key = keyName(one["key"] as Node);
          if (value !== null && key !== "" && unwrap(one["value"] as Node)?.type !== "CallExpression") {
            if (calls.has(value)) learn(calls, key, calls.get(value)!);
            if (sso.has(value)) learn(sso, key, "sso");
          }
        }
        bindings(one, () => {});
      });
    } while (changed);
    const ssoLike = (node: Node | null | undefined) => { const name = lastName(node); return name !== null && sso.has(name); };
    each(parsed.program, one => {
      if (one.type === "MemberExpression") {
        const name = keyOf(one);
        if (name === "fresh" && ssoLike(one["object"] as Node)) add("sso.fresh", path);
        if (name !== null && FACT_NAMES.has(name)) add(`.${name}`, path);
      }
      // Destructuring reads: `fresh` taken out of anything SSO-like (at any depth), and the freshness facts themselves.
      bindings(one, (key, from) => {
        if (key === "fresh" && from !== null && sso.has(from)) add("sso.fresh", path);
        if (FACT_NAMES.has(key)) add(`{${key}}`, path);
      });
      if (one.type === "CallExpression") { const name = lastName(one["callee"] as Node); if (name !== null && calls.has(name)) add(`${calls.get(name)}()`, path); }
    });
  }
  return hits;
}

describe("where freshness may be honoured", () => {
  const sources = productionSources;
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
      "const s = ctx.sso; const again = s; if (!token && again.fresh) return ok;",
      "const { sso: mine } = ctx.session; if (!token && (mine as { fresh: boolean }).fresh) return ok;",
      "if (!token && (ctx.sso as { fresh: boolean }).fresh) return ok;",
      "const check = authenticateAccount; const again2 = check; again2(store, 'alex', token);",
      "const { session: { sso: mine } } = ctx; if (!token && mine.fresh) return ok;",
      "const { sso: { fresh } } = ctx; if (!token && fresh) return ok;",
      "let fresh2; ({ sso: { fresh: fresh2 } } = ctx); if (!token && fresh2) return ok;",
      "const { guards: { authenticateApprover: check } } = runtime; check(who, token);",
      "const f = ({ sso: { fresh } }: never) => fresh; return f;",
      "function g({ guards: { authenticateApprover: check } }: never) { check(who, token); } return g;",
      "const [{ sso: { fresh } }] = [ctx]; if (!token && fresh) return ok;",
      "function h(check = authenticateApprover) { return check(store, who, token); } return h;",
      "const [s] = [ctx.sso]; if (!token && s.fresh) return ok;",
      "const { ...s } = ctx.sso; if (!token && s.fresh) return ok;",
      "function d({ fresh } = ctx.sso) { return fresh; } return d;",
      "const [{ fresh }] = [ctx.sso]; if (!token && fresh) return ok;",
      "const [s2] = [ctx.sso] as const; if (!token && s2.fresh) return ok;",
      "function e({ check } = { check: authenticateApprover }) { return check(store, who, token); } return e;",
    ];
    const caught = audit(bypasses.map((text, index) => ({ path: `probe-${index}.ts`, text: `export function probe(token: string, ok: unknown) { ${text} }` })));
    expect(caught["unparsed"]).toBeUndefined();
    expect(Object.keys(caught["sso.fresh"] ?? {}).sort()).toEqual(["probe-0.ts", "probe-1.ts", "probe-10.ts", "probe-11.ts", "probe-13.ts", "probe-15.ts", "probe-17.ts", "probe-18.ts", "probe-19.ts", "probe-2.ts", "probe-20.ts", "probe-21.ts", "probe-5.ts", "probe-6.ts", "probe-7.ts", "probe-9.ts"]);
    expect(caught["authenticateApprover()"]).toEqual({ "probe-12.ts": 1, "probe-14.ts": 1, "probe-16.ts": 1, "probe-22.ts": 1 });
    expect(Object.keys(caught["sso.fresh"] ?? {})).toEqual(expect.arrayContaining(["probe-13.ts", "probe-15.ts"]));
    expect(caught["authenticateAccount()"]).toEqual({ "probe-8.ts": 1 });
    // A renamed import is the same function.
    expect(audit([{ path: "probe-import.ts", text: "import { authenticateAccount as check } from './scope.js'; export const f = () => check({} as never, 'a', 'b');" }])["authenticateAccount()"]).toEqual({ "probe-import.ts": 1 });
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
    expect(hits["spendingOnlyOnSuccess()"]).toEqual({ "src/chat-actions.ts": 1, "src/server/chat.ts": 2, "src/server/tasks.ts": 1 });
    // Refunds only where one transaction holds every effect: never console-wide (a refused answer proves nothing).
    expect(hits["spendingOnlyIfDone()"]).toBeUndefined();
    // Every approver step-up goes through authenticateApprover (scope.ts, or the console guard's wrapper of it via
    // checkApproverPassword), which proves through proveAccountNow. The counts make a new call site a reviewed change.
    expect(hits["checkApproverPassword()"]).toEqual({ "src/server/guards.ts": 1 });
    expect(hits["authenticateApprover()"]).toEqual({ "src/chat-actions.ts": 1, "src/control-setup.ts": 1, "src/desktop-host.ts": 5, "src/operate.ts": 59, "src/pull-request-flow.ts": 1,
      "src/scope.ts": 2, "src/server/chat.ts": 5, "src/server/flows.ts": 3, "src/server/pages.ts": 3, "src/server/people-tokens.ts": 5, "src/server/settings.ts": 22,
      "src/server/tasks.ts": 6, "src/server/terminals.ts": 1, "src/task-outcome-cli.ts": 1 });
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

/**
 * THE TRIPWIRE (the audit's backstop, Codex B2 r8/r9): however a value flows — through any file, any helper — an
 * authorization that skips the prover has to read a `fresh` somewhere, and a hidden prover call has to name its
 * function. So every mention — as a name, a member, a key, a string or a template literal — of `fresh`, and of each
 * authentication function and freshness fact, in EVERY production file, is counted and pinned. A new mention, however it is spelled, fails here until a person reviews it. (Only a
 * key computed at run time, like "fr" + "esh", is outside what reading the source can see.)
 *
 * STATED LIMIT (accepted 2026-10-20, Codex B2 r21): this is a regression guard, not a proof. Pins are by place, so an
 * ordinary refactor can still move an EXISTING mention or helper into an authorization path without changing a pin
 * (destructuring, argument slots, aliases, reused helpers, label collisions). Changes near scope.ts's prover still
 * need a human reviewer; the runtime gates carry the guarantee.
 */
const TRIPWIRE_PINS: Record<string, Record<string, number>> = {
  "FreshFacts": {
    "src/scope.ts#<module>": 2,
    "src/serve.ts#<module>": 2,
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51": 1,
    "src/server/remote.ts#<module>": 3,
    "src/server/runtime.ts#<module>": 3
  },
  "approveSetup": {
    "src/control-setup.ts#approveSetup@2": 1,
    "src/server/settings.ts#<module>": 2,
    "src/server/settings.ts#createSettingsHandlers@1>controlAct@64><anonymous>@1": 1
  },
  "approverHash": {
    "src/store.ts#<module>": 1
  },
  "authenticateAccount": {
    "src/operate.ts#<module>": 2,
    "src/operate.ts#noteActingPerson@103": 1,
    "src/principal.ts#<module>": 2,
    "src/principal.ts#verifyApproverByPassword@4": 1,
    "src/scope.ts#authenticateAccount@33": 1,
    "src/scope.ts#proveAccountNow@39": 1,
    "src/server/guards.ts#<module>": 2,
    "src/server/guards.ts#createSharedGuards@1>identify@14": 1,
    "src/server/people-tokens.ts#<module>": 2,
    "src/server/people-tokens.ts#createPeopleHandlers@2>loginSend@14": 1,
    "src/server/people-tokens.ts#createPeopleHandlers@2>signupSend@13": 1,
    "src/server/settings.ts#<module>": 2,
    "src/server/settings.ts#createSettingsHandlers@1>chatApprovalAct@67><anonymous>@1": 1,
    "src/server/settings.ts#createSettingsHandlers@1>telegramPairAct@68><anonymous>@1": 1,
    "src/tokens-cli.ts#<module>": 2,
    "src/tokens-cli.ts#runTokensCommand@1": 1
  },
  "authenticateApprover": {
    "src/chat-actions.ts#<module>": 2,
    "src/chat-actions.ts#executeSharedAction@25": 1,
    "src/control-setup.ts#<module>": 2,
    "src/control-setup.ts#approveSetup@2>store.transact(_)@1": 1,
    "src/desktop-host.ts#<module>": 2,
    "src/desktop-host.ts#desktopMain@14": 2,
    "src/desktop-host.ts#pairDesktopLogin@10": 3,
    "src/operate.ts#<module>": 1,
    "src/operate.ts#acceptTaskProof@100": 1,
    "src/operate.ts#authenticateApprover@126": 1,
    "src/operate.ts#bridgeCommand@70": 1,
    "src/operate.ts#budgetCommand@151": 1,
    "src/operate.ts#chatApprovalCommand@46": 1,
    "src/operate.ts#configCommand@48": 3,
    "src/operate.ts#continueTask@111": 1,
    "src/operate.ts#coordinatorCommand@23": 2,
    "src/operate.ts#decideCommand@32": 1,
    "src/operate.ts#dispatch@14": 2,
    "src/operate.ts#incidentCommand@39": 1,
    "src/operate.ts#intakeCommand@52": 1,
    "src/operate.ts#leadCommand@105": 1,
    "src/operate.ts#ledgerCommand@161": 1,
    "src/operate.ts#modeCommand@47": 1,
    "src/operate.ts#notificationsCommand@152": 1,
    "src/operate.ts#onboardLogin@66": 1,
    "src/operate.ts#pauseTask@110": 1,
    "src/operate.ts#peopleCommand@45": 1,
    "src/operate.ts#planTaskCommand@37": 1,
    "src/operate.ts#policyCommand@159": 1,
    "src/operate.ts#projectChecksCommand@143": 1,
    "src/operate.ts#projectConcurrencyCommand@142": 1,
    "src/operate.ts#projectDeleteCommand@146": 1,
    "src/operate.ts#projectDemoCommand@144": 1,
    "src/operate.ts#projectRulesCommand@141": 1,
    "src/operate.ts#publishCommand@71": 5,
    "src/operate.ts#regateTaskCommand@36": 1,
    "src/operate.ts#repairTaskCommand@101": 2,
    "src/operate.ts#requeueTask@35": 1,
    "src/operate.ts#resolveUpApprover@62": 3,
    "src/operate.ts#resumeTaskCommand@139": 1,
    "src/operate.ts#retentionCommand@153": 1,
    "src/operate.ts#reviewSwitchCommand@158": 1,
    "src/operate.ts#reviewTaskCommand@38": 1,
    "src/operate.ts#routeTaskCommand@119>edited:store.editTaskRoute(ref.id,_,clock()).authenticate@2": 1,
    "src/operate.ts#runCommand@140": 1,
    "src/operate.ts#runnerCommand@22": 4,
    "src/operate.ts#scopeTask@118": 1,
    "src/operate.ts#setupCommand@49": 1,
    "src/operate.ts#steerTask@109": 1,
    "src/operate.ts#stopTaskCommand@138": 1,
    "src/operate.ts#storageCommand@154>operator@1": 1,
    "src/operate.ts#verifyCommand@50": 2,
    "src/pull-request-flow.ts#<module>": 2,
    "src/pull-request-flow.ts#mergeAsPerson@22": 1,
    "src/scope.ts#addApprover@32>store.transact(_)@1": 1,
    "src/scope.ts#approve@44>store.transact(_)@1": 1,
    "src/scope.ts#authenticateApprover@40": 1,
    "src/serve.ts#createDecisionServer@1": 3,
    "src/serve.ts#createDecisionServer@1>handlerRuntime.authenticateApprover@220": 2,
    "src/server/chat.ts#createChatHandlers@1": 2,
    "src/server/chat.ts#createChatHandlers@1>chatAckSend@23": 1,
    "src/server/chat.ts#createChatHandlers@1>chatConfig@14": 1,
    "src/server/chat.ts#createChatHandlers@1>chatFile@22": 1,
    "src/server/chat.ts#createChatHandlers@1>chatSend@21>opened:spendingOnlyOnSuccess(_,_)@5>withFreshness(chat-send,_)@1": 1,
    "src/server/chat.ts#createChatHandlers@1>pushSubscribe@11": 1,
    "src/server/flows.ts#createFlowsHandlers@1": 2,
    "src/server/flows.ts#createFlowsHandlers@1>flowAct@30><anonymous>@1": 2,
    "src/server/flows.ts#createFlowsHandlers@1>triggerAct@32><anonymous>@1": 1,
    "src/server/guards.ts#<module>": 1,
    "src/server/guards.ts#createSharedGuards@1": 2,
    "src/server/guards.ts#createSharedGuards@1>authenticateApprover@1": 1,
    "src/server/pages.ts#createPagesHandlers@1": 2,
    "src/server/pages.ts#createPagesHandlers@1>fleetRegister@22": 1,
    "src/server/pages.ts#createPagesHandlers@1>fleetRetire@23": 1,
    "src/server/pages.ts#createPagesHandlers@1>onboardConfirm@25": 1,
    "src/server/people-tokens.ts#createPeopleHandlers@2": 2,
    "src/server/people-tokens.ts#createPeopleHandlers@2>peopleInvite@5": 1,
    "src/server/people-tokens.ts#createPeopleHandlers@2>peopleInviteRevoke@6": 1,
    "src/server/people-tokens.ts#createPeopleHandlers@2>peopleProjects@4": 1,
    "src/server/people-tokens.ts#createPeopleHandlers@2>peopleRevoke@7": 1,
    "src/server/people-tokens.ts#createPeopleHandlers@2>sessionsSend@3": 1,
    "src/server/runtime.ts#<module>": 2,
    "src/server/settings.ts#createSettingsHandlers@1": 2,
    "src/server/settings.ts#createSettingsHandlers@1>approvalSave@41": 1,
    "src/server/settings.ts#createSettingsHandlers@1>backupsSave@50": 1,
    "src/server/settings.ts#createSettingsHandlers@1>checksSave@48": 1,
    "src/server/settings.ts#createSettingsHandlers@1>controlAct@64><anonymous>@1": 1,
    "src/server/settings.ts#createSettingsHandlers@1>dataExport@51": 1,
    "src/server/settings.ts#createSettingsHandlers@1>discordAct@70><anonymous>@1": 1,
    "src/server/settings.ts#createSettingsHandlers@1>modeAct@81><anonymous>@1": 1,
    "src/server/settings.ts#createSettingsHandlers@1>monitoringSave@54": 1,
    "src/server/settings.ts#createSettingsHandlers@1>policySave@40": 1,
    "src/server/settings.ts#createSettingsHandlers@1>projectDelete@39": 1,
    "src/server/settings.ts#createSettingsHandlers@1>projectLiveView@38": 1,
    "src/server/settings.ts#createSettingsHandlers@1>pullRequestsSave@47": 1,
    "src/server/settings.ts#createSettingsHandlers@1>requestLimitsSave@42": 1,
    "src/server/settings.ts#createSettingsHandlers@1>retentionSave@45": 1,
    "src/server/settings.ts#createSettingsHandlers@1>signInSave@43": 1,
    "src/server/settings.ts#createSettingsHandlers@1>slackAct@65><anonymous>@1": 1,
    "src/server/settings.ts#createSettingsHandlers@1>spendBudget@36": 1,
    "src/server/settings.ts#createSettingsHandlers@1>storageAct@46><anonymous>@1": 1,
    "src/server/settings.ts#createSettingsHandlers@1>teamsAct@69><anonymous>@1": 1,
    "src/server/settings.ts#createSettingsHandlers@1>toolsChange@56": 1,
    "src/server/settings.ts#createSettingsHandlers@1>toolsConnect@55": 1,
    "src/server/settings.ts#createSettingsHandlers@1>updatesAct@44><anonymous>@1": 1,
    "src/server/tasks.ts#createTasksHandlers@2": 2,
    "src/server/tasks.ts#createTasksHandlers@2>codeAct@21><anonymous>@1": 2,
    "src/server/tasks.ts#createTasksHandlers@2>taskConfirmStopped@26": 1,
    "src/server/tasks.ts#createTasksHandlers@2>taskMutation@39": 3,
    // Live terminals: starting one is a step-up (a fresh password every time; never a remembered one).
    "src/server/terminals.ts#createTerminalHandlers@2>start@10": 1,
    "src/task-outcome-cli.ts#<module>": 2,
    "src/task-outcome-cli.ts#runTaskMergeCommand@2": 1
  },
  "checkApproverPassword": {
    "src/server/guards.ts#<module>": 1,
    "src/server/guards.ts#createSharedGuards@1>authenticateApprover@1": 2,
    "src/server/runtime.ts#<module>": 2
  },
  "consumeSsoNow": {
    "src/scope.ts#<module>": 1,
    "src/scope.ts#proveAccountNow@39": 1,
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51": 1
  },
  "credentialHash": {
    "src/runner.ts#authenticate@3": 1,
    "src/scope.ts#authenticateAccount@33": 1,
    "src/server/people-tokens.ts#createPeopleHandlers@2>joinSend@17": 1,
    "src/store.ts#Store.accountOf@149": 2,
    "src/store.ts#Store.bootstrapApproverIfNone@883": 1,
    "src/store.ts#Store.bootstrapApproverIfNone@883>transact(_)@1": 1,
    "src/store.ts#Store.consumeInviteAndCreateAccount@201": 1,
    "src/store.ts#Store.consumeInviteAndCreateAccount@201>transact(_)@1": 1,
    "src/store.ts#Store.getRunner@234": 2,
    "src/store.ts#Store.saveApprover@148": 1,
    "src/store.ts#Store.saveApprover@148>once(mutation,saveApprover,_)@1>transact(_)@1": 1,
    "src/store.ts#Store.saveRunner@231": 1,
    "src/store.ts#Store.saveRunner@231>once(mutation,saveRunner,_)@1>transact(_)@1": 1
  },
  "credential_hash": {
    "src/export.ts#<module>": 2,
    "src/process-recovery-anchor.ts#<module>": 1,
    "src/store-baseline.ts#<module>": 1,
    "src/store.ts#<module>": 1,
    "src/store.ts#Store.accountOf@149": 2,
    "src/store.ts#Store.approverHash@156": 2,
    "src/store.ts#Store.bootstrapApproverIfNone@883>transact(_)@1": 1,
    "src/store.ts#Store.consumeInviteAndCreateAccount@201>transact(_)@1": 1,
    "src/store.ts#Store.getRunner@234": 1,
    "src/store.ts#Store.saveApprover@148>once(mutation,saveApprover,_)@1>transact(_)@1": 1,
    "src/store.ts#Store.saveRunner@231>once(mutation,saveRunner,_)@1>transact(_)@1": 1,
    "src/store.ts#Store.signInWithSso@225>transact(_)@1": 1,
    "src/store.ts#mergeCredentialsForV118@61": 1
  },
  "fresh": {
    "src/acp-check.ts#settleChecks@2": 4,
    "src/acp-check.ts#settleChecks@2>took:acquire(store,ref,job.runner,_).newLeaseId@2": 1,
    "src/acp-client.ts#exactField@11": 3,
    "src/backup.ts#runningNow@18": 2,
    "src/browser-workspace.ts#<module>": 2,
    "src/browser/app.tsx#Navigation@21": 3,
    "src/browser/chime.ts#createChime@10>see@3": 2,
    "src/browser/chime.ts#createChime@10>see@3>window.setTimeout(_,CHIME_SETTLE_MS)@6>exclusively(_)@1": 2,
    "src/browser/live-task.tsx#ActivityLine@2": 1,
    "src/browser/team-chat.tsx#<module>": 1,
    "src/browser/team-chat.tsx#TeamChat@7><anonymous>@44>execute(send,_).then(_)@1": 1,
    "src/browser/team-chat.tsx#TeamChat@7>accept:useCallback(_,_)@7": 1,
    "src/browser/team-chat.tsx#TeamChat@7>send@13": 1,
    "src/browser/team-chat.tsx#restore@2": 1,
    "src/browser/views/flow-view.tsx#StepUp@44": 1,
    "src/browser/views/flow-view.tsx#stepUpReady@45": 1,
    "src/budget-alerts.ts#budgetAlertPass@1": 2,
    "src/chat-decide.ts#decideOffer@11": 5,
    "src/chat-decide.ts#staleWhy@28": 6,
    "src/chat-flow.ts#answerChatFlowPrompt@18>store.transact(_)@1": 2,
    "src/checkout-cleanup.ts#cleanCheckouts@14>wanted@2": 3,
    "src/checkout-cleanup.ts#slimKeptCheckouts@15>wanted@3": 2,
    "src/discord-chat.ts#deliverDiscordPart@8": 3,
    "src/evidence-pack.ts#ledgerExportChunks@4": 1,
    "src/flow-engine.ts#workStage@10>filed:store.transact(_)@3": 12,
    "src/flow-pull-request.ts#pullRequestStep@2": 2,
    "src/flow-send.ts#chooseStep@15": 3,
    "src/flow-send.ts#keep@12": 5,
    "src/flow-send.ts#sendStep@14": 3,
    "src/flow-steps.ts#claimStep@2>store.transact(_)@1": 5,
    "src/flow-triggers.ts#checkTrigger@49": 3,
    "src/flow-unattended.ts#nodeModuleGraphOf@26": 3,
    "src/flow-unattended.ts#scriptProvenanceOf@27": 2,
    "src/landed-cleanup.ts#reconcileLanded@33": 4,
    "src/landed-cleanup.ts#removeCheckout@31>wanted@2": 4,
    "src/ledger-view.ts#ledgerBody@2": 7,
    "src/ledger-view.ts#ledgerBody@2>shown.map(_)@4": 1,
    "src/mcp-oauth.ts#<module>": 1,
    "src/mcp-oauth.ts#createOAuthHttp@9>consentHtml@14": 1,
    "src/model-catalog.ts#recordCatalog@8>store.transact(_)@1": 2,
    "src/models-cli.ts#runModelsCommand@1": 3,
    "src/models-ui.ts#<module>": 1,
    "src/models-ui.ts#modelsHtml@4": 4,
    "src/oidc.ts#providerKeys@8": 2,
    "src/operate.ts#daemonCommand@55": 2,
    "src/orphan-sweep.ts#sweepOrphans@7": 5,
    "src/peek-cli.ts#advanceTail@1": 2,
    "src/process-tree.ts#remember@4": 4,
    "src/process-tree.ts#stopProcessTree@11": 3,
    "src/provider-auth.ts#startSignInProbes@20": 1,
    "src/provider-connection.ts#<module>": 1,
    "src/provider-connection.ts#createConnectionChecker@2><anonymous>@3": 2,
    "src/provider-connection.ts#createConnectionChecker@2><anonymous>@3>check@1": 1,
    "src/push.ts#loadOrCreateVapidKeys@4": 4,
    "src/release-cli.ts#runReleaseCommand@3": 1,
    "src/release-gate.ts#releaseGate@5": 11,
    "src/release.ts#<module>": 1,
    "src/release.ts#runRelease@10": 1,
    "src/restart-certification.ts#verifyRestartRecovery@6": 4,
    "src/run-closeout.ts#closeOutCheckouts@11": 4,
    "src/runner.ts#recoverDead@17>recovery:store.transact(_)@1": 3,
    "src/scope.ts#proveAccountNow@39": 4,
    "src/serve.ts#createDecisionServer@1>checkLocalAgents@98": 1,
    "src/serve.ts#createDecisionServer@1>checkLocalAgents@98>localSignInChecking:Promise.all(map(_)):map(_)@1": 1,
    "src/serve.ts#createDecisionServer@1>connectionCheck@41": 2,
    "src/serve.ts#createDecisionServer@1>handle@93": 4,
    "src/serve.ts#createDecisionServer@1>sendScreen@116": 2,
    "src/serve.ts#createDecisionServer@1>sendScreen@116>workspace@5": 1,
    "src/server/chat.ts#createChatHandlers@1>sharedActionReview@5>freshSince@2": 3,
    "src/server/remote.ts#createRemoteHandlers@1>oauthHttp:createOAuthHttp(_).session@11": 1,
    "src/server/render-people.ts#ssoStepUps@3": 1,
    "src/server/render-people.ts#ssoStepUps@3>swap@2": 1,
    "src/server/request-context.ts#<module>": 1,
    "src/server/runtime.ts#<module>": 2,
    "src/server/settings.ts#createSettingsHandlers@1>modelsView@87": 1,
    "src/server/task-views.ts#createTaskViews@1>taskViewData@14>approvalFresh@17": 3,
    "src/server/tasks.ts#createTasksHandlers@2>peekFragment@38>work@2": 11,
    "src/shared-deps.ts#pruneUnusedShared@29": 7,
    "src/shared-deps.ts#pruneUnusedShared@29>finish@2": 2,
    "src/slack-chat.ts#deliverSlackPart@13": 3,
    "src/store.ts#Store.ledgerChain@175": 1,
    "src/store.ts#Store.ledgerChain@175>recent@1": 2,
    "src/store.ts#Store.recordApprovalVote@170": 2,
    "src/store.ts#Store.seedPushPairs@1008": 2,
    "src/store.ts#initializeStore@41": 3,
    "src/telegram-flow.ts#applyFlowReply@16": 3,
    "src/telegram-lead.ts#applyProposalTap@8": 2,
    "src/telegram.ts#applyCallback@53": 3,
    "src/token-notices.ts#tokenNoticePass@1": 2,
    "src/worktree.ts#WorktreePool.discardChanges@34": 4,
    "src/worktree.ts#WorktreePool.freshen@22": 4,
    "src/worktree.ts#WorktreePool.leaseNow@21": 4,
    "src/worktree.ts#WorktreePool.prune@32": 1
  },
  "freshFacts": {
    "src/scope.ts#<module>": 1,
    "src/scope.ts#freshnessFor@37": 1,
    "src/scope.ts#proveAccountNow@39": 1,
    "src/scope.ts#ssoNowAvailable@38": 1,
    "src/serve.ts#<module>": 2,
    "src/serve.ts#createDecisionServer@1>handle@93": 2,
    "src/serve.ts#createDecisionServer@1>handle@93>requestFacts.sso.fresh@4": 1,
    "src/serve.ts#createDecisionServer@1>sendScreen@116>workspace@5": 1,
    "src/server/remote.ts#<module>": 2,
    "src/server/remote.ts#createRemoteHandlers@1>oauthHttp:createOAuthHttp(_).confirm@13": 1,
    "src/server/remote.ts#createRemoteHandlers@1>oauthHttp:createOAuthHttp(_).session@11": 1
  },
  "freshFloor": {
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51>floor@6": 1,
    "src/server/session.ts#<module>": 1,
    "src/server/settings.ts#createSettingsHandlers@1>forgetPassword@31": 1
  },
  "freshScope": {
    "src/scope.ts#<module>": 1,
    "src/scope.ts#freshnessFor@37": 1,
    "src/scope.ts#withFreshness@35": 1
  },
  "freshnessFor": {
    "src/chat-actions.ts#<module>": 2,
    "src/chat-actions.ts#executeSharedAction@25>withFreshness(approve-standard,_)@2": 1,
    "src/scope.ts#freshnessFor@37": 1,
    "src/scope.ts#proveAccountNow@39": 1,
    "src/server/chat.ts#<module>": 2,
    "src/server/chat.ts#createChatHandlers@1>sharedActionReview@5>freshSince@2>fresh:withFreshness(approve-standard,_)@1": 1,
    "src/server/task-views.ts#<module>": 2,
    "src/server/task-views.ts#createTaskViews@1>taskViewData@14>approvalFresh@17>fresh:withFreshness(approve-standard,_)@1": 1,
    "src/server/tasks.ts#<module>": 2,
    "src/server/tasks.ts#createTasksHandlers@2>taskMutation@39>withFreshness(approve-standard,_)@10": 1
  },
  "mergeAsPerson": {
    "src/pull-request-flow.ts#mergeAsPerson@22": 1,
    "src/server/tasks.ts#<module>": 2,
    "src/server/tasks.ts#createTasksHandlers@2>taskMerge@27": 1,
    "src/task-outcome-cli.ts#<module>": 2,
    "src/task-outcome-cli.ts#runTaskMergeCommand@2": 1
  },
  "pairDesktopLogin": {
    "src/desktop-host.ts#desktopMain@14": 1,
    "src/desktop-host.ts#pairDesktopLogin@10": 1
  },
  "passwordAt": {
    "src/scope.ts#<module>": 1,
    "src/scope.ts#freshnessFor@37": 1,
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51": 1,
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51>passwordAt@2": 1,
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51>stamp@7": 1,
    "src/serve.ts#createDecisionServer@1>sendScreen@116>workspace@5": 1,
    "src/server/people-tokens.ts#createPeopleHandlers@2>loginSend@14": 1,
    "src/server/people-tokens.ts#createPeopleHandlers@2>signupSend@13": 1,
    "src/server/session.ts#<module>": 1,
    "src/server/settings.ts#createSettingsHandlers@1>forgetPassword@31": 1
  },
  "proveAccountNow": {
    "src/scope.ts#authenticateApprover@40": 1,
    "src/scope.ts#proveAccountNow@39": 1,
    "src/server/people-tokens.ts#<module>": 2,
    "src/server/people-tokens.ts#createPeopleHandlers@2>sessionsSend@3": 1,
    "src/server/remote.ts#<module>": 2,
    "src/server/remote.ts#createRemoteHandlers@1>oauthHttp:createOAuthHttp(_).confirm@13>freshFacts.run(runtime.freshFactsOf(request,who),_)@1": 1
  },
  "scryptSync": {
    "src/scope.ts#<module>": 2,
    "src/scope.ts#hashPassword@3": 1,
    "src/scope.ts#verifyCredential@4": 1
  },
  "spendingOnlyOnSuccess": {
    "src/chat-actions.ts#<module>": 2,
    "src/chat-actions.ts#executeSharedAction@25": 1,
    "src/scope.ts#spendingOnlyOnSuccess@34": 1,
    "src/server/chat.ts#<module>": 2,
    "src/server/chat.ts#createChatHandlers@1>chatProposalAct@19><anonymous>@1": 1,
    "src/server/chat.ts#createChatHandlers@1>chatSend@21": 1,
    "src/server/tasks.ts#<module>": 2,
    "src/server/tasks.ts#createTasksHandlers@2>taskMutation@39": 1
  },
  "ssoNow": {
    "src/scope.ts#<module>": 1,
    "src/scope.ts#proveAccountNow@39": 1,
    "src/scope.ts#ssoNowAvailable@38": 1,
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51": 1
  },
  "ssoNowAt": {
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51>consumeSsoNow@5": 2,
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51>consumeSsoNow@5><anonymous>@1": 2,
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51>ssoNow@4": 1,
    "src/server/people-tokens.ts#createPeopleHandlers@2>ssoFinish@12": 1,
    "src/server/session.ts#<module>": 1,
    "src/server/settings.ts#createSettingsHandlers@1>forgetPassword@31": 1
  },
  "ssoNowAvailable": {
    "src/chat-actions.ts#<module>": 2,
    "src/chat-actions.ts#executeSharedAction@25": 1,
    "src/scope.ts#proveAccountNow@39": 1,
    "src/scope.ts#ssoNowAvailable@38": 1,
    "src/serve.ts#<module>": 2,
    "src/serve.ts#createDecisionServer@1>handle@93>requestFacts.sso.fresh@4": 1,
    "src/server/remote.ts#<module>": 2,
    "src/server/remote.ts#createRemoteHandlers@1>oauthHttp:createOAuthHttp(_).session@11>sso.fresh:freshFacts.run(runtime.freshFactsOf(request,who),_)@1": 1,
    "src/server/tasks.ts#<module>": 2,
    "src/server/tasks.ts#createTasksHandlers@2>taskMutation@39": 1
  },
  "ssoReauthAt": {
    "src/scope.ts#<module>": 1,
    "src/scope.ts#freshnessFor@37": 1,
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51": 1,
    "src/serve.ts#createDecisionServer@1>freshFactsOf@51>ssoReauthAt@3": 1,
    "src/server/people-tokens.ts#createPeopleHandlers@2>ssoFinish@12": 1,
    "src/server/session.ts#<module>": 1,
    "src/server/settings.ts#createSettingsHandlers@1>forgetPassword@31": 1
  },
  "verifyApproverByPassword": {
    "src/flows-cli.ts#<module>": 2,
    "src/flows-cli.ts#runFlowsCommand@3": 1,
    "src/lead-cli.ts#<module>": 2,
    "src/lead-cli.ts#runLeadCli@7": 1,
    "src/operate.ts#<module>": 1,
    "src/operate.ts#agentsCommand@43": 1,
    "src/operate.ts#dispatch@14": 1,
    "src/operate.ts#proposalsCommand@122": 1,
    "src/operate.ts#taskAction@88>runTaskOutcomeCommand(action,rest,flags,_).operator@1": 1,
    "src/operate.ts#verifyApproverByPassword@127": 1,
    "src/principal.ts#verifyApproverByPassword@4": 1,
    "src/server/chat.ts#<module>": 2,
    "src/server/chat.ts#createChatHandlers@1>leadMint@15": 1
  },
  "verifyCredential": {
    "src/scope.ts#authenticateAccount@33": 2,
    "src/scope.ts#verifyCredential@4": 1
  },
  "withFreshness": {
    "src/chat-actions.ts#<module>": 2,
    "src/chat-actions.ts#executeSharedAction@25": 1,
    "src/chat-actions.ts#executeSharedAction@25>act@3>store.savepoint(_)@1": 1,
    "src/scope.ts#withFreshness@35": 1,
    "src/server/chat.ts#<module>": 2,
    "src/server/chat.ts#createChatHandlers@1>chatSend@21>opened:spendingOnlyOnSuccess(_,_)@5": 1,
    "src/server/chat.ts#createChatHandlers@1>sharedActionReview@5>freshSince@2": 1,
    "src/server/task-views.ts#<module>": 2,
    "src/server/task-views.ts#createTaskViews@1>taskViewData@14>approvalFresh@17": 1,
    "src/server/tasks.ts#<module>": 2,
    "src/server/tasks.ts#createTasksHandlers@2>taskMutation@39": 1,
    "src/server/tasks.ts#createTasksHandlers@2>taskMutation@39>approved:spendingOnlyOnSuccess(_,_)@11": 1
  }
};
describe("the tripwire", () => {
  const sources = productionSources;
  // The freshness facts' own carrier and its readers too: any helper that reads them (an SSO re-check's time, a window's
  // start) names one of these.
  // And the password primitives beneath every prover: a check made outside proveAccountNow names one of these.
  // And every road to a stored password: the store's own reader, both scrypt forms, and any SQL naming the column.
  const WATCH = new Set(["fresh", "sso", ...WATCHED_CALLS, ...FACT_NAMES, "freshFacts", "FreshFacts", "ssoNow", "freshScope", "verifyCredential", "credentialHash",
    "scryptSync", "scrypt", "approverHash",
    // Exported wrappers that check a password themselves (each through the prover or the primitives above).
    "verifyApproverByPassword", "pairDesktopLogin", "mergeAsPerson", "approveSetup"]);
  /** The watched name a node mentions: an identifier, a string or a one-piece template; any string naming the stored
   * password column counts as `credential_hash`. */
  const mentionOf = (one: Node): string | null => {
    const name = one.type === "Identifier" ? one["name"] as string
      : one.type === "Literal" && typeof one["value"] === "string" ? one["value"] as string
      : one.type === "TemplateLiteral" ? ((one["quasis"] as Node[]).map(quasi => (quasi["value"] as { cooked: string | null }).cooked ?? "").join(""))
      : null;
    if (name === null) return null;
    if (one.type !== "Identifier" && /credential_hash/i.test(name)) return "credential_hash";
    return WATCH.has(name) && !(one.type === "TemplateLiteral" && (one["quasis"] as Node[]).length !== 1) ? name : null;
  };
  /**
   * Every mention, with the function it sits in, by a distinct identity: each function on the way down is its qualified
   * name — the object or class it belongs to and its key (`auxiliary.session`, `Store.approverHash`), or the variable it
   * is bound to — and its place among its sibling functions (`@n`), so two functions never share a pin, anonymous ones
   * included (`<anonymous>@3`). `file#<module>` at top level.
   */
  const placed = (files: { path: string; text: string }[]): { name: string; file: string; where: string }[] => {
    const found: { name: string; file: string; where: string }[] = [];
    const named = (node: Node | undefined): string | null => node === undefined || node === null ? null
      // Type and grouping wrappers name what they wrap: `(auxiliary as T).identify` is `auxiliary.identify`.
      : WRAPPERS.includes(node.type ?? "") ? named(node["expression"] as Node)
      : node.type === "Identifier" ? node["name"] as string
      : node.type === "Literal" ? String(node["value"])
      // A one-piece template is the plain text it spells (`checks[\`identify\`]` is `checks.identify`).
      : node.type === "TemplateLiteral" && (node["quasis"] as Node[]).length === 1 ? String(((node["quasis"] as Node[])[0]!["value"] as { cooked: string }).cooked)
      : node.type === "MemberExpression" ? [named(node["object"] as Node), named(node["property"] as Node)].filter(one => one !== null).join(".")
      : node.type === "PrivateIdentifier" ? `#${String(node["name"])}`
      // A call or construction is named by its callee AND everything it is given, all the way down
      // (`Object.assign(checks.get("display"),_)`, `new PasswordChecks(_)`).
      : node.type === "CallExpression" || node.type === "NewExpression" ? callLabel(node) : null;
    const callLabel = (node: Node): string => `${node.type === "NewExpression" ? "new " : ""}${named(node["callee"] as Node) ?? "<call>"}(${(node["arguments"] as Node[]).map(argument => named(argument) ?? "_").join(",")})`;
    for (const { path, text } of files) {
      const parsed = parseSync(path, text, { lang: langOf(path) });
      expect(parsed.errors, path).toEqual([]);
      // `where`: the function chain; `owner`: the object/class/variable a function written here belongs to; `count`:
      // how many functions the enclosing function has opened so far (the sibling ordinal).
      const walk = (node: unknown, where: string[], owner: string | null, count: { n: number }): void => {
        if (node === null || typeof node !== "object") return;
        if (Array.isArray(node)) { for (const one of node) walk(one, where, owner, count); return; }
        const one = node as Node;
        const mention = mentionOf(one);
        if (mention !== null) found.push({ name: mention, file: path, where: where.length === 0 ? "<module>" : where.join(">") });
        const isFunction = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(one.type ?? "");
        if (isFunction) {
          count.n += 1;
          const own = named(one["id"] as Node);
          // Both the owner and the function's own name, when it has each: renaming or rehoming either is a new place.
          const label = `${[owner, own].filter(part => part !== null).join(":") || "<anonymous>"}@${count.n}`;
          const inner = { n: 0 };
          for (const [key, value] of Object.entries(one)) if (key !== "type") walk(value, [...where, label], null, inner);
          return;
        }
        // A class names its members; a variable, a property, a method or an assignment names what is written into it.
        // A class keeps the owner it is written under, beside its own name (`passwordChecks.check:Check`).
        const classLabel = one.type === "ClassDeclaration" || one.type === "ClassExpression" ? [owner, named(one["id"] as Node)].filter(part => part !== null).join(":") || null : null;
        for (const [key, value] of Object.entries(one)) {
          if (key === "type") continue;
          const next = one.type === "VariableDeclarator" && key === "init" ? named(one["id"] as Node)
            : (one.type === "Property" || one.type === "MethodDefinition" || one.type === "PropertyDefinition") && key === "value" ? [owner, named(one["key"] as Node)].filter(part => part !== null).join(".")
            : one.type === "AssignmentExpression" && key === "right" ? named(one["left"] as Node)
            : classLabel !== null ? classLabel
            // A call's arguments are owned by the call, under whatever owns the call (`passwordChecks.check:wrap()`).
            // …and by what the call is given: its arguments' names are part of the label, so composing the same
            // value into another object (`Object.assign(passwordChecks, …)` vs `Object.assign(display, …)`) is a new place.
            : (one.type === "CallExpression" || one.type === "NewExpression") && key === "arguments" ? [owner, callLabel(one)].filter(part => part !== null).join(":")
            // Everything else passes its owner down unchanged — wrappers (`as`, `satisfies`, `!`, parentheses), choices
            // (`a ? f : g`, `override ?? f`), sequences, arrays, awaits — so a value is owned by where it is written to
            // until something names it anew. (A function body starts with no owner of its own.)
            : owner;
          walk(value, where, next, count);
        }
      };
      walk(parsed.program, [], null, { n: 0 });
    }
    return found.filter(one => one.name !== "sso");
  };
  const mentions = (files: { path: string; text: string }[]): Record<string, Record<string, number>> => {
    const out: Record<string, Record<string, number>> = {};
    for (const { name, file } of placed(files)) (out[name] ??= {})[file] = (out[name]![file] ?? 0) + 1;
    return out;
  };
  /** Pinned by place: a mention moved to another function (even in the same file) is a new place, reviewed. */
  const places = (files: { path: string; text: string }[]): Record<string, Record<string, number>> => {
    const out: Record<string, Record<string, number>> = {};
    for (const { name, file, where } of placed(files)) { const key = `${file}#${where}`; (out[name] ??= {})[key] = (out[name]![key] ?? 0) + 1; }
    return out;
  };

  test("catches every spelling Codex found, by the mention alone", () => {
    const probe = (text: string) => mentions([{ path: "probe.ts", text: `export function probe(token: string, ok: unknown, session: { sso: never }, ctx: { sso: never }) { ${text} }` }]);
    for (const text of ["const { fresh } = { ...session.sso }; if (!token && fresh) return ok;", "const [{ fresh }] = [...[ctx.sso]]; return fresh;", "return ({ ...ctx.sso }).fresh;",
      "return ctx.sso[`fresh`];", "return (ctx.sso as Record<string, unknown>)['fresh'];", "const s = ctx.sso ?? {}; return (s as { fresh: boolean }).fresh;"]) expect(probe(text)["fresh"]?.["probe.ts"], text).toBeGreaterThan(0);
    for (const text of ["const o = { ...{ check: authenticateApprover } }; return o;", "return authenticateApprover.call(null, ctx, token);", "const pick = token ? authenticateApprover : null; return pick;"]) {
      expect(probe(text)["authenticateApprover"]?.["probe.ts"], text).toBeGreaterThan(0);
    }
  });

  test("a helper in a file that names nothing about sign-in still trips it, as soon as it reads a fresh", () => {
    const files = [
      { path: "helper.ts", text: "export function isConfirmed(value: { fresh: boolean } | null | undefined): boolean { return value?.fresh === true; }" },
      { path: "caller.ts", text: "import { isConfirmed } from './helper.js'; export const c = (typed: string, session: { sso: never }) => !typed && isConfirmed(session.sso);" },
    ];
    expect(mentions(files)["fresh"]).toEqual({ "helper.ts": 2 });
  });

  test("an indirect call of a freshness wrapper trips it by naming it; every module flavour is read", () => {
    const probe = mentions([{ path: "probe.ts", text: "export const p = (confirmIt: () => unknown) => Reflect.apply(withFreshness, undefined, ['chat-send', confirmIt]);" }]);
    expect(probe["withFreshness"]).toEqual({ "probe.ts": 1 });
    expect(mentions([{ path: "helper.mts", text: "export const isConfirmed = (value: { fresh: boolean }) => value.fresh;" }])["fresh"]).toEqual({ "helper.mts": 2 });
    for (const name of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.mjs", "a.cjs", "a.jsx", "a.test.mts", "a.test.cts", "a.test.js"]) expect(audited(name), name).toBe(true);
    for (const name of ["a.test.ts", "a.test.tsx", "a.d.ts", "a.d.mts", "a.md"]) expect(audited(name), name).toBe(false);
    // A helper that reads an SSO re-check's time through the facts names their carrier and reader.
    const reader = mentions([{ path: "reader.ts", text: "export const recent = () => { const at = freshFacts.getStore()?.ssoNow(); return at !== null && at !== undefined && Date.now() - at < 300000; };" }]);
    expect(reader["freshFacts"]).toEqual({ "reader.ts": 1 });
    expect(reader["ssoNow"]).toEqual({ "reader.ts": 1 });
    // A password checked directly, beside the prover, names the primitive (and the stored hash).
    const direct = mentions([{ path: "direct.ts", text: "export const ok = (store: { accountOf(n: string): { credentialHash: string } | null }, name: string, password: string) => { const account = store.accountOf(name); return account !== null && verifyCredential(account.credentialHash, password); };" }]);
    expect(direct["verifyCredential"]).toEqual({ "direct.ts": 1 });
    expect(direct["credentialHash"]).toEqual({ "direct.ts": 2 });
  });

  test("a check moved into a new helper in the same file, or another road to the stored password, is a new place", () => {
    const before = places([{ path: "scope.ts", text: "export function ssoNowAvailable(by: string) { return check(by); } function check(by: string) { return freshFacts.getStore()?.ssoNow() !== null; }" }]);
    const moved = places([{ path: "scope.ts", text: "export function ssoNowAvailable(by: string) { return check(by); } function check(by: string) { return helper(by); } export function helper(by: string) { return freshFacts.getStore()?.ssoNow() !== null; }" }]);
    expect(moved).not.toEqual(before);
    expect(Object.keys(moved["ssoNow"] ?? {})).toEqual(["scope.ts#helper@3"]);
    // Two bodies both reached as `session`, one moved under another object: distinct identities.
    const original = places([{ path: "remote.ts", text: "export function create() { return { session: (request: never) => { const fresh = request; return fresh; } }; }" }]);
    const split = places([{ path: "remote.ts", text: "const auxiliary = { session: (request: never) => { const fresh = request; return fresh; } }; export function create() { return { session: (request: never) => auxiliary.session(request) }; }" }]);
    expect(split).not.toEqual(original);
    expect(Object.keys(split["fresh"] ?? {})).toEqual(["remote.ts#auxiliary.session@1"]);
    // A watched function kept under an object's key and called through it is a call of that function.
    const keyed = audit([{ path: "keyed.ts", text: "import { authenticateAccount as rawCheck } from './scope.js'; const passwordChecks = { check: rawCheck }; export const f = (store: never, name: string, token: string) => passwordChecks.check(store, name, token);" }]);
    expect(keyed["authenticateAccount()"]).toEqual({ "keyed.ts": 1 });
    // A named function rehomed under another object keeps a different identity (owner and own name both count).
    // Same enclosing function, same ordinal: only the owner differs — plain, `as` and `satisfies` alike.
    const home = places([{ path: "g.ts", text: "export function create() { const identify = function identify(x: never) { const fresh = x; return fresh; }; return identify; }" }]);
    for (const wrap of [(f: string) => f, (f: string) => `(${f}) as (x: never) => never`, (f: string) => `(${f}) satisfies (x: never) => never`,
      (f: string) => `Math.random() > 2 ? ${f} : null`, (f: string) => `(null as never) ?? ${f}`, (f: string) => `(0, ${f})`, (f: string) => `[${f}][0]`]) {
      const rehomed = places([{ path: "g.ts", text: `export function create() { const passwordChecks = { check: ${wrap("function identify(x: never) { const fresh = x; return fresh; }")} }; const identify = passwordChecks.check; return identify; }` }]);
      expect(Object.keys(rehomed["fresh"] ?? {})).toEqual(["g.ts#create@1>passwordChecks.check:identify@1"]);
      expect(rehomed).not.toEqual(home);
    }
    // Rehoming that still differs only by owner: a type-asserted receiver, an inline call wrapper, a named class.
    const pair = (text: (owner: string) => string) => [places([{ path: "h.ts", text: text("display") }]), places([{ path: "h.ts", text: text("passwordChecks") }])];
    for (const [a, b] of [
      pair(owner => `const ${owner}: Record<string, unknown> = {}; export function create() { (${owner} as { identify?: unknown }).identify = function identify(x: never) { const fresh = x; return fresh; }; }`),
      pair(owner => `const wrap = <T,>(f: T) => f; export function create() { const ${owner} = { check: wrap(function identify(x: never) { const fresh = x; return fresh; }) }; return ${owner}; }`),
      pair(owner => `export function create() { const ${owner} = { check: class Check { read(x: never) { const fresh = x; return fresh; } } }; return ${owner}; }`),
      pair(owner => `const display = {}; const passwordChecks = {}; export function create() { Object.assign(${owner}, { identify(value: { sso: { fresh: boolean } }) { return value.sso.fresh; } }); }`),
      pair(owner => `const checks = new Map<string, object>(); export function create() { Object.assign(checks.get("${owner}")!, { identify(v: { sso: { fresh: boolean } }) { return v.sso.fresh; } }); }`),
      pair(owner => `class display { constructor(_: object) {} } class passwordChecks { constructor(_: object) {} } export function create() { return new ${owner}({ identify(v: { sso: { fresh: boolean } }) { return v.sso.fresh; } }); }`),
      [places([{ path: "h.ts", text: "export function create() { const checks: Record<string, unknown> = {}; checks[`display`] = (value: { sso: { fresh: boolean } }) => value.sso.fresh; }" }]),
        places([{ path: "h.ts", text: "export function create() { const checks: Record<string, unknown> = {}; checks[`identify`] = (value: { sso: { fresh: boolean } }) => value.sso.fresh; }" }])],
    ]) expect(b).not.toEqual(a);
    // The wrappers that check a password are watched by name.
    expect(mentions([{ path: "w.ts", text: "export const w = (store: never, by: string, p: string) => verifyApproverByPassword(store, by, p, []);" }])["verifyApproverByPassword"]).toEqual({ "w.ts": 1 });
    const roads = mentions([{ path: "roads.ts", text: "export const a = (store: never, n: string, p: string) => { const h = store.approverHash(n); scrypt(p, 'salt', 64, () => {}); return db.prepare(`SELECT credential_hash FROM approver WHERE name = ${n}`); };" }]);
    expect(roads["approverHash"]).toEqual({ "roads.ts": 1 });
    expect(roads["scrypt"]).toEqual({ "roads.ts": 1 });
    expect(roads["credential_hash"]).toEqual({ "roads.ts": 1 });
  });

  test("every mention in the production source is the reviewed one, in the function it sits in", () => {
    const files = sources("src").map(path => ({ path, text: readFileSync(path, "utf8") }));
    const actual = places(files);
    expect(actual).toEqual(TRIPWIRE_PINS);
  });
});
