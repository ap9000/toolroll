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
    const WRAPPERS = ["ChainExpression", "ParenthesizedExpression", "TSNonNullExpression", "TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion"];
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
      "src/server/tasks.ts": 6, "src/task-outcome-cli.ts": 1 });
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
 */
const TRIPWIRE_PINS: Record<string, Record<string, number>> = {
  "FreshFacts": {
    "src/scope.ts": 2,
    "src/serve.ts": 3,
    "src/server/remote.ts": 3,
    "src/server/runtime.ts": 3
  },
  "authenticateAccount": {
    "src/operate.ts": 3,
    "src/principal.ts": 3,
    "src/scope.ts": 2,
    "src/server/guards.ts": 3,
    "src/server/people-tokens.ts": 4,
    "src/server/settings.ts": 4,
    "src/tokens-cli.ts": 3
  },
  "authenticateApprover": {
    "src/chat-actions.ts": 3,
    "src/control-setup.ts": 3,
    "src/desktop-host.ts": 7,
    "src/operate.ts": 60,
    "src/pull-request-flow.ts": 3,
    "src/scope.ts": 3,
    "src/serve.ts": 5,
    "src/server/chat.ts": 7,
    "src/server/flows.ts": 5,
    "src/server/guards.ts": 4,
    "src/server/pages.ts": 5,
    "src/server/people-tokens.ts": 7,
    "src/server/runtime.ts": 2,
    "src/server/settings.ts": 24,
    "src/server/tasks.ts": 8,
    "src/task-outcome-cli.ts": 3
  },
  "checkApproverPassword": {
    "src/server/guards.ts": 3,
    "src/server/runtime.ts": 2
  },
  "consumeSsoNow": {
    "src/scope.ts": 2,
    "src/serve.ts": 1
  },
  "credentialHash": {
    "src/runner.ts": 1,
    "src/scope.ts": 1,
    "src/server/people-tokens.ts": 1,
    "src/store.ts": 12
  },
  "fresh": {
    "src/acp-check.ts": 5,
    "src/acp-client.ts": 3,
    "src/backup.ts": 2,
    "src/browser-workspace.ts": 2,
    "src/browser/app.tsx": 3,
    "src/browser/chime.ts": 4,
    "src/browser/live-task.tsx": 1,
    "src/browser/team-chat.tsx": 5,
    "src/browser/views/flow-view.tsx": 2,
    "src/budget-alerts.ts": 2,
    "src/chat-decide.ts": 11,
    "src/chat-flow.ts": 2,
    "src/checkout-cleanup.ts": 5,
    "src/discord-chat.ts": 3,
    "src/evidence-pack.ts": 1,
    "src/flow-engine.ts": 12,
    "src/flow-pull-request.ts": 2,
    "src/flow-send.ts": 11,
    "src/flow-steps.ts": 5,
    "src/flow-triggers.ts": 3,
    "src/flow-unattended.ts": 5,
    "src/landed-cleanup.ts": 8,
    "src/ledger-view.ts": 8,
    "src/mcp-oauth.ts": 2,
    "src/model-catalog.ts": 2,
    "src/models-cli.ts": 3,
    "src/models-ui.ts": 5,
    "src/oidc.ts": 2,
    "src/operate.ts": 2,
    "src/orphan-sweep.ts": 5,
    "src/peek-cli.ts": 2,
    "src/process-tree.ts": 7,
    "src/provider-auth.ts": 1,
    "src/provider-connection.ts": 4,
    "src/push.ts": 4,
    "src/release-cli.ts": 1,
    "src/release-gate.ts": 11,
    "src/release.ts": 2,
    "src/restart-certification.ts": 4,
    "src/run-closeout.ts": 4,
    "src/runner.ts": 3,
    "src/scope.ts": 4,
    "src/serve.ts": 11,
    "src/server/chat.ts": 3,
    "src/server/remote.ts": 1,
    "src/server/render-people.ts": 2,
    "src/server/request-context.ts": 1,
    "src/server/runtime.ts": 2,
    "src/server/settings.ts": 1,
    "src/server/task-views.ts": 3,
    "src/server/tasks.ts": 11,
    "src/shared-deps.ts": 9,
    "src/slack-chat.ts": 3,
    "src/store.ts": 10,
    "src/telegram-flow.ts": 3,
    "src/telegram-lead.ts": 2,
    "src/telegram.ts": 3,
    "src/token-notices.ts": 2,
    "src/worktree.ts": 13
  },
  "freshFacts": {
    "src/scope.ts": 4,
    "src/serve.ts": 6,
    "src/server/remote.ts": 4
  },
  "freshFloor": {
    "src/serve.ts": 1,
    "src/server/session.ts": 1,
    "src/server/settings.ts": 1
  },
  "freshScope": {
    "src/scope.ts": 3
  },
  "freshnessFor": {
    "src/chat-actions.ts": 3,
    "src/scope.ts": 2,
    "src/server/chat.ts": 3,
    "src/server/task-views.ts": 3,
    "src/server/tasks.ts": 3
  },
  "passwordAt": {
    "src/scope.ts": 2,
    "src/serve.ts": 4,
    "src/server/people-tokens.ts": 2,
    "src/server/session.ts": 1,
    "src/server/settings.ts": 1
  },
  "proveAccountNow": {
    "src/scope.ts": 2,
    "src/server/people-tokens.ts": 3,
    "src/server/remote.ts": 3
  },
  "scryptSync": {
    "src/scope.ts": 4
  },
  "spendingOnlyOnSuccess": {
    "src/chat-actions.ts": 3,
    "src/scope.ts": 1,
    "src/server/chat.ts": 4,
    "src/server/tasks.ts": 3
  },
  "ssoNow": {
    "src/scope.ts": 3,
    "src/serve.ts": 1
  },
  "ssoNowAt": {
    "src/serve.ts": 5,
    "src/server/people-tokens.ts": 1,
    "src/server/session.ts": 1,
    "src/server/settings.ts": 1
  },
  "ssoNowAvailable": {
    "src/chat-actions.ts": 3,
    "src/scope.ts": 2,
    "src/serve.ts": 3,
    "src/server/remote.ts": 3,
    "src/server/tasks.ts": 3
  },
  "ssoReauthAt": {
    "src/scope.ts": 2,
    "src/serve.ts": 2,
    "src/server/people-tokens.ts": 1,
    "src/server/session.ts": 1,
    "src/server/settings.ts": 1
  },
  "verifyCredential": {
    "src/scope.ts": 3
  },
  "withFreshness": {
    "src/chat-actions.ts": 4,
    "src/scope.ts": 1,
    "src/server/chat.ts": 4,
    "src/server/task-views.ts": 3,
    "src/server/tasks.ts": 4
  }
};
describe("the tripwire", () => {
  const sources = productionSources;
  // The freshness facts' own carrier and its readers too: any helper that reads them (an SSO re-check's time, a window's
  // start) names one of these.
  // And the password primitives beneath every prover: a check made outside proveAccountNow names one of these.
  const WATCH = new Set(["fresh", "sso", ...WATCHED_CALLS, ...FACT_NAMES, "freshFacts", "FreshFacts", "ssoNow", "freshScope", "verifyCredential", "credentialHash", "scryptSync"]);
  const mentions = (files: { path: string; text: string }[]): Record<string, Record<string, number>> => {
    const hits: Record<string, Record<string, number>> = {};
    for (const { path, text } of files) {
      const parsed = parseSync(path, text, { lang: langOf(path) });
      expect(parsed.errors, path).toEqual([]);
      each(parsed.program, one => {
        const name = one.type === "Identifier" ? one["name"] as string
          : one.type === "Literal" && typeof one["value"] === "string" ? one["value"] as string
          : one.type === "TemplateLiteral" && (one["quasis"] as Node[]).length === 1 ? String(((one["quasis"] as Node[])[0]!["value"] as { cooked: string }).cooked)
          : null;
        if (name !== null && WATCH.has(name)) (hits[name] ??= {})[path] = (hits[name]![path] ?? 0) + 1;
      });
    }
    const out: Record<string, Record<string, number>> = {};
    for (const [name, files] of Object.entries(hits)) if (name !== "sso") out[name] = files;
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

  test("every mention in the production source is the reviewed one", () => {
    const files = sources("src").map(path => ({ path, text: readFileSync(path, "utf8") }));
    expect(mentions(files)).toEqual(TRIPWIRE_PINS);
  });
});
