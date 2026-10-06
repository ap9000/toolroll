/**
 * Item 13: the console's form bodies and JSON API. Every form contract survives the JSON Schema round trip, reads
 * every body exactly as `URLSearchParams` did (first value, every value in order, presence, unknown and computed
 * names), and is the one serve.ts reads its route through; the three `?format=json` responses are checked as sent,
 * with their bytes unchanged.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { assertContract, roundTripLoss } from "./contract-test.js";
import { parseContract } from "./contract.js";
import { BODILESS_POSTS, CONSOLE_FORMS, CONSOLE_RESPONSES, checkResponse, formFields, readForm, type ConsoleFormName } from "./console-api.js";
import { openStore, type Store } from "../store.js";
import { addApprover } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { flowFromSteps } from "../flows.js";
import { packDigest, type EvidencePack } from "../evidence-pack.js";

const names = Object.keys(CONSOLE_FORMS) as ConsoleFormName[];

/** Bodies a browser, an older page or a script might send: duplicates, blanks, unknown and odd names, encodings. */
function samplesFor(name: ConsoleFormName): { name: string; input: URLSearchParams }[] {
  const contract = CONSOLE_FORMS[name];
  const declared = [...contract.fields, ...contract.prefixes.map(prefix => `${prefix}7`)];
  const every = new URLSearchParams(declared.map((field, index) => [field, `value ${index}`]));
  const twice = new URLSearchParams(declared.flatMap(field => [[field, "first"], [field, "second"]]));
  const blank = new URLSearchParams(declared.map(field => [field, ""]));
  return [
    { name: `${name}: nothing sent`, input: new URLSearchParams() },
    { name: `${name}: every field`, input: every },
    { name: `${name}: every field twice`, input: twice },
    { name: `${name}: every field blank`, input: blank },
    { name: `${name}: unknown fields and csrf`, input: new URLSearchParams("csrf=abc&__proto__=x&constructor=y&later-field=1&later-field=2") },
    { name: `${name}: encoded text`, input: new URLSearchParams(`${declared[0] ?? "x"}=%E2%9C%93+a%0D%0Ab&${declared[0] ?? "x"}`) },
  ];
}

describe("console form contracts", () => {
  test.each(names)("%s survives the JSON Schema round trip and reads every body", name => {
    const contract = CONSOLE_FORMS[name];
    expect(roundTripLoss(contract.schema)).toEqual([]);
    assertContract({
      schema: contract.schema,
      read: input => {
        const parsed = parseContract(contract.schema, input instanceof URLSearchParams ? formFields(input) : input);
        return parsed.ok ? { ok: true } : { ok: false, lines: parsed.issues.map(one => one.line) };
      },
      valid: samplesFor(name),
      // Only a value that is not a form's (a script calling the reader directly) is refused, by the field's name.
      invalid: contract.fields.length === 0 ? [] : [{ name: `${name}: a bare string`, input: { [contract.fields[0]!]: "one" }, paths: [contract.fields[0]!] }],
    });
  });

  test.each(names)("%s reads exactly as URLSearchParams did", name => {
    const contract = CONSOLE_FORMS[name];
    const report = vi.fn();
    for (const { input } of samplesFor(name)) {
      const view = readForm(input, contract, report);
      for (const field of [...contract.fields, ...contract.prefixes.map(prefix => `${prefix}7`), "csrf", "missing"]) {
        const read = view as unknown as { get(name: string): string | null; getAll(name: string): string[]; has(name: string): boolean };
        expect(read.get(field)).toBe(input.get(field));
        expect(read.getAll(field)).toEqual(input.getAll(field));
        expect(read.has(field)).toBe(input.has(field));
      }
      expect([...view.keys()]).toEqual([...input.keys()]);
      expect(view.sent).toBe(input);
    }
    expect(report).not.toHaveBeenCalled();
  });

  test("the projection keeps first-sent order, every value, and a field called __proto__", () => {
    const fields = formFields(new URLSearchParams("b=1&a=&b=2&__proto__=p&a=3"));
    expect(Object.keys(fields)).toEqual(["b", "a", "__proto__"]);
    expect(fields).toEqual(JSON.parse('{"b":["1","2"],"a":["","3"],"__proto__":["p"]}'));
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
  });

  test("a disagreement is reported and the form is still read", () => {
    const report = vi.fn();
    const view = readForm(new URLSearchParams("name=a"), { ...CONSOLE_FORMS.login, schema: z.looseObject({ required: z.array(z.string()) }) as never }, report);
    expect(view.get("name")).toBe("a");
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]![1][0].line).toMatch(/^required: required$/);
  });
});

describe("the inventory", () => {
  const source = readFileSync(new URL("../serve.ts", import.meta.url), "utf8");
  const handlePost = source.slice(source.indexOf("  async function handlePost("), source.indexOf("\n  }\n", source.indexOf("  async function handlePost(")));
  const routes = [...Object.values(CONSOLE_FORMS).map(one => one.route), ...BODILESS_POSTS];

  test("every form contract is the one serve.ts reads its route through", () => {
    const wired = new Set([...source.matchAll(/CONSOLE_FORMS\.(\w+)/g), ...source.matchAll(/FormFieldOf<"(\w+)">/g)].map(match => match[1]));
    expect(names.filter(name => !wired.has(name))).toEqual([]);
    expect(new Set(routes).size).toBe(routes.length);
  });

  test("every exact POST path the console answers is named by a contract", () => {
    const paths = new Set([...handlePost.matchAll(/url\.pathname === ["'`](\/[^"'`$]+)["'`]/g)].map(match => match[1]!));
    for (const family of handlePost.matchAll(/\[((?:"[^"]+",?\s*)+)\]\.(?:some|includes)\(/g)) {
      for (const one of family[1]!.matchAll(/"([^"]+)"/g)) if (one[1]!.startsWith("/")) paths.add(one[1]!);
    }
    for (const pre of ["/signup", "/login", "/logout"]) paths.add(pre);
    const named = (path: string) => routes.some(route => route.replace(/^POST /, "").split(", ").includes(path));
    expect([...paths].filter(path => !named(path))).toEqual([]);
  });

  test("handlePost reads nothing but typed views", () => {
    expect(handlePost).toContain("posted: URLSearchParams");
    expect(handlePost).not.toMatch(/\bbody: URLSearchParams\b/);
    expect(handlePost).not.toMatch(/\bposted\.(?:get|getAll|has)\(/);
  });
});

describe("JSON responses", () => {
  test.each(Object.keys(CONSOLE_RESPONSES) as (keyof typeof CONSOLE_RESPONSES)[])("%s survives the JSON Schema round trip", name => {
    expect(roundTripLoss(CONSOLE_RESPONSES[name].schema)).toEqual([]);
  });

  test("a response that disagrees is reported and returned unchanged", () => {
    const report = vi.fn();
    const odd = { chain: null, entries: [], nextBefore: null };
    expect(checkResponse("ledgerPage", odd, report)).toBe(odd);
    expect(report.mock.calls[0]![1].map((one: { line: string }) => one.line)).toEqual(["chain: required"]);
  });
});

describe("over HTTP", () => {
  const REPO = "/repo/main";
  let dir: string, store: Store, server: Server, base: string, password: string;
  let written: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "so-console-api-"));
    store = openStore(join(dir, "orders.db"));
    const alex = addApprover(store, "alex", new Date());
    if (!alex.ok) throw new Error("alex");
    password = alex.token;
    server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: REPO });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    base = `http://127.0.0.1:${address.port}`;
    written = [];
    const write = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const signIn = async () => {
    const answer = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams([["name", "alex"], ["token", password], ["name", "ignored"], ["extra", "1"]]), redirect: "manual" });
    expect(answer.status).toBe(303);
    return answer.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
  };
  const get = (cookie: string, path: string) => fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
  const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
  const post = (cookie: string, path: string, body: URLSearchParams) =>
    fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body, redirect: "manual" });
  const disagreements = () => written.filter(line => line.includes("disagrees with its contract"));

  test("the shared guard answers first and as before: duplicates, then the CSRF token", async () => {
    const cookie = await signIn();
    const csrf = csrfOf(await (await get(cookie, "/tasks")).text());
    const twice = await post(cookie, "/session/editor-links", new URLSearchParams([["csrf", csrf], ["csrf", csrf], ["on", "1"]]));
    expect([twice.status, await twice.text()]).toEqual([400, expect.stringContaining("duplicated csrf field")]);
    const stale = await post(cookie, "/session/editor-links", new URLSearchParams([["csrf", "0".repeat(64)], ["on", "1"], ["unknown", "x"]]));
    expect([stale.status, await stale.text()]).toEqual([403, expect.stringContaining("stale form")]);
    const missing = await post(cookie, "/settings/appearance", new URLSearchParams([["theme", "dark"]]));
    expect(missing.status).toBe(403);
    expect(disagreements()).toEqual([]);
  });

  test("a form with unknown fields, blanks and repeats reads its first value, as before", async () => {
    const cookie = await signIn();
    const csrf = csrfOf(await (await get(cookie, "/tasks")).text());
    const answer = await post(cookie, "/settings/appearance", new URLSearchParams([["csrf", csrf], ["theme", "dark"], ["theme", "light"], ["return", "/tasks"], ["return", "/elsewhere"], ["later", ""]]));
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("/tasks");
    expect(answer.headers.get("set-cookie")).toContain("dark");
    const blank = await post(cookie, "/settings/appearance", new URLSearchParams([["csrf", csrf], ["theme", ""]]));
    expect(blank.status).toBe(400);
    expect(disagreements()).toEqual([]);
  });

  test("the ledger, a flow and an evidence pack are sent as built, unversioned, and agree with their contracts", async () => {
    const cookie = await signIn();
    const ledger = await (await get(cookie, "/ledger?format=json")).text();
    const page = JSON.parse(ledger) as Record<string, unknown>;
    expect(Object.keys(page)).toEqual(["chain", "entries", "nextBefore"]);
    expect((page["entries"] as unknown[]).length).toBeGreaterThan(0);

    const flow = store.createFlow({ repo: REPO, name: "Requests", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, new Date());
    const view = JSON.parse(await (await get(cookie, `/flows/${flow}?format=json`)).text()) as Record<string, unknown>;
    expect(view["kind"]).toBe("flow");
    expect(view).not.toHaveProperty("version");

    const made = store.createConsoleTask({ title: "Rotate the signing key", repo: REPO, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, new Date());
    if (!made.ok) throw new Error(made.reason);
    const bytes = await (await get(cookie, `/t/${made.id}/evidence?format=json`)).text();
    const pack = JSON.parse(bytes) as EvidencePack;
    const { digest, ...body } = pack;
    expect(packDigest(body)).toBe(digest);
    expect(bytes).toBe(JSON.stringify(pack, null, 2));
    expect(pack).not.toHaveProperty("version");
    expect(disagreements()).toEqual([]);
  });
});
