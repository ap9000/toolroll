/**
 * The destination manifest (test/destinations.json, the one-workspace plan's slice S0): every address a signed-in
 * browser can land on, each declared a page, an alias, a ceremony, data, or mixed. A route row with no entry fails here,
 * so a new page is declared on purpose; the destination count stays at or under the manifest's ceiling, so a slice that
 * removes pages lowers it. Then each entry's kind is checked against real consoles: the demo (as `toolroll demo` serves
 * it, signed in through its one-time link) and an empty console with an instance operator for the rows the demo
 * account may not open.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { ROUTES, matchRoute } from "./route-table.js";
import { IN_PLACE_ROUTES } from "./in-place.js";
import { createDemoSandbox } from "../demo.js";
import { createDecisionServer } from "../serve.js";
import { openStore } from "../store.js";
import { addApprover } from "../scope.js";

type Kind = "page" | "alias" | "ceremony" | "data" | "mixed";
type Entry = { kind: Kind; path: string; to?: string; why?: string; what?: string; when?: { if: string; kind: "page" | "alias"; to?: string }[] };
type Manifest = { about: string[]; ceiling: { destinations: number; ceremonies: number }; routes: Record<string, Entry> };

const manifest = JSON.parse(readFileSync(new URL("../../test/destinations.json", import.meta.url), "utf8")) as Manifest;
/** Every address a cookie can land on: the console's GET rows that admit a browser session. */
const landable = ROUTES.filter(route => route.stage === "console" && route.method !== "POST" && route.callers.includes("cookie"));
const entries = Object.entries(manifest.routes);
const KINDS: readonly Kind[] = ["page", "alias", "ceremony", "data", "mixed"];
const count = (kind: Kind) => entries.filter(([, entry]) => entry.kind === kind).length;

describe("the destination manifest", () => {
  test("declares every landable route row exactly once, and nothing else", () => {
    const declared = new Set(Object.keys(manifest.routes));
    const missing = landable.map(route => route.id).filter(id => !declared.has(id));
    expect(missing, "route rows with no entry in test/destinations.json: declare each as page, alias, ceremony, data or mixed").toEqual([]);
    const ids = new Set(landable.map(route => route.id));
    expect(Object.keys(manifest.routes).filter(id => !ids.has(id)), "entries naming no landable route row").toEqual([]);
  });

  test("each entry is well formed, and its path is its row's own address", () => {
    for (const [id, entry] of entries) {
      expect(KINDS, id).toContain(entry.kind);
      expect(matchRoute("GET", entry.path, "console")?.id, `${id}: ${entry.path}`).toBe(id);
      if (entry.kind === "alias") expect(entry.to, id).toMatch(/^\//);
      if (entry.kind === "ceremony") expect(entry.why, id).toBeTruthy();
      if (entry.kind === "data") expect(entry.what, id).toBeTruthy();
      if (entry.kind === "mixed") {
        expect(entry.when?.map(one => one.kind).sort(), id).toEqual(["alias", "page"]);
        for (const one of entry.when ?? []) expect(one.if, id).toBeTruthy();
        expect(entry.when?.find(one => one.kind === "alias")?.to, id).toMatch(/^\//);
      }
    }
  });

  test("the destination count (pages and mixed rows) is at or under its ceiling; ceremonies are counted apart", () => {
    const destinations = count("page") + count("mixed");
    expect(destinations, `${destinations} destinations, ceiling ${manifest.ceiling.destinations}: remove a page or raise the ceiling on purpose`)
      .toBeLessThanOrEqual(manifest.ceiling.destinations);
    expect(count("ceremony")).toBeLessThanOrEqual(manifest.ceiling.ceremonies);
  });

  test("a retired row is an alias; a ceremony is never a page that changes in place", () => {
    for (const route of landable.filter(one => one.retired === true)) expect(manifest.routes[route.id]?.kind, route.id).toBe("alias");
    for (const [id, entry] of entries) if (entry.kind === "ceremony") expect(IN_PLACE_ROUTES.has(id), id).toBe(false);
  });
});

// ---- probes against real consoles --------------------------------------------------------------------------------

type Answer = { status: number; type: string; location: string; body: string };
type World = { base: string; cookie: string; close: () => Promise<void> };

async function signIn(server: Server & { mintSignInLink(account: string): string | null }, account: string): Promise<{ base: string; cookie: string }> {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link = server.mintSignInLink(account);
  if (link === null) throw Error(`no sign-in link for ${account}`);
  const signed = await fetch(base + link, { redirect: "manual" });
  const cookie = signed.headers.getSetCookie().map(one => one.split(";")[0]).join("; ");
  if (cookie === "") throw Error(`signing ${account} in set no cookie (${signed.status})`);
  return { base, cookie };
}
async function get(world: World, path: string): Promise<Answer> {
  const response = await fetch(world.base + path, { headers: { cookie: world.cookie, accept: "text/html" }, redirect: "manual" });
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const body = type === "text/html" ? await response.text() : (await response.body?.cancel(), "");
  return { status: response.status, type, location: response.headers.get("location") ?? "", body };
}
const listen = (server: Server) => new Promise<void>((ready, failed) => { server.once("error", failed); server.listen(0, "127.0.0.1", ready); });
const closeServer = (server: Server) => new Promise<void>(closed => server.close(() => closed()));

/** A full HTML document the console wrote (a page, a refusal or a not-found page, never a redirect). */
const isDocument = (answer: Answer) => answer.type === "text/html" && /^<!doctype html>/i.test(answer.body.trimStart());
const isRedirect = (answer: Answer) => [301, 302, 303, 307, 308].includes(answer.status);
/** `to` as a pattern: `:name` is one path part; the target may carry more query keys or a fragment after it. */
function leadsTo(location: string, to: string): boolean {
  const pattern = to.split(/(:[a-z]+)/).map(part => part.startsWith(":") ? "[^/?#]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${pattern}(?:[?&#].*)?$`).test(location);
}

/** Opens a project for this session, as the project switcher does. */
async function openProject(world: { base: string; cookie: string }, path: string): Promise<void> {
  const form = await (await fetch(world.base + "/tasks/new", { headers: { cookie: world.cookie } })).text();
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(form)?.[1] ?? "";
  const opened = await fetch(world.base + "/projects/select", { method: "POST", redirect: "manual",
    headers: { cookie: world.cookie, origin: world.base, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, path, return: "/" }).toString() });
  if (opened.status !== 303 || opened.headers.get("location") !== "/") throw Error(`opening ${path} answered ${opened.status}`);
}

let demo: World, operator: World;
/** The demo's own samples where a row's generic sample names nothing there. `${api}` is the demo's payments project. */
const DEMO_PATHS: Record<string, string> = {
  "task.page": "/t/fix-payout-rounding", "task.evidence": "/t/fix-payout-rounding/evidence", "task.release": "/t/fix-payout-rounding/release",
  "run.evidence": "/r/6/evidence/8", "flow.page": "/flows/3", "flow.insights": "/flows/3/insights", "flow.export": "/flows/3/export",
  "recipes.start": "/recipes/start?recipe=small-feature", "recipes.edit": "/recipes/edit?recipe=small-feature",
  "recipes.export": "/recipes/export?recipe=small-feature", "recipes.from-task": "/recipes/from-task?task=fix-payout-rounding",
  "settings.checks": "/settings/checks?repo=${api}", "settings.pull-requests": "/settings/pull-requests?repo=${api}",
};
/** Rows the demo account may not open (installation-wide, or an operator's browser): probed on the operator's console. */
const OPERATOR_ROWS = new Set(["term.page", "term.state", "term.session", "term.socket", "projects.browse", "projects.github", "settings.integrations",
  "settings.monitoring", "settings.sign-in", "settings.teams", "settings.discord", "settings.slack", "settings.slack/manifest"]);
/** Rows neither console has the object for: the status each answers instead, and why. A change here is a change of kind
 * to look at, so the status is held exactly. */
const ABSENT: Record<string, { status: number; why: string }> = {
  "code.ship": { status: 409, why: "no coding session to ship" },
  "recipes.run": { status: 404, why: "no saved project recipe" },
  "recipes.preview": { status: 404, why: "no preview token" },
  "subagent.page": { status: 404, why: "no subagent" },
  "sweep.page": { status: 404, why: "no lead sweep" },
  "release.locate": { status: 404, why: "no release waiting (it redirects to /t/<task>/release when one is)" },
  "task.release": { status: 404, why: "no release waiting" },
  "chat.ack": { status: 404, why: "no chat turn with an unknown charge" },
  "chat.action": { status: 409, why: "no chat proposal" },
};
/** Each mixed row's two answers, as the demo gives them (welcome's page: the empty console's first run). */
const MIXED: Record<string, { page: { world: "demo" | "operator"; path: string }; alias: { world: "demo" | "operator"; path: string } }> = {
  review: { page: { world: "demo", path: "/review?result=fix-payout-rounding&run=6" }, alias: { world: "demo", path: "/review" } },
  "run.page": { page: { world: "demo", path: "/r/5" }, alias: { world: "demo", path: "/r/6" } },
  welcome: { page: { world: "operator", path: "/welcome" }, alias: { world: "demo", path: "/welcome" } },
};

beforeAll(async () => {
  // The demo, as `toolroll demo` serves it, with its payments project open.
  const made = createDemoSandbox(new Date());
  const demoServer = createDecisionServer({ store: made.store, evidenceRoot: made.evidenceRoot, clock: () => new Date(), repos: made.seed.repos, demoLead: made.lead });
  await listen(demoServer);
  const signed = await signIn(demoServer, made.seed.login.name);
  const api = made.seed.repos[0]!;
  await openProject(signed, api);
  for (const [id, path] of Object.entries(DEMO_PATHS)) DEMO_PATHS[id] = path.replace("${api}", encodeURIComponent(realpathSync(api)));
  demo = { ...signed, close: async () => { made.lead.stop(); await closeServer(demoServer); made.store.close(); rmSync(made.sandbox, { recursive: true, force: true }); } };

  // An empty console with an instance operator, its own config folder and projects folder (both temporary).
  const folder = mkdtempSync(join(tmpdir(), "destinations-"));
  const store = openStore(":memory:");
  if (!addApprover(store, "operator", new Date()).ok) throw Error("operator");
  const project = join(folder, "main");
  mkdirSync(project);
  const opServer = createDecisionServer({ store, evidenceRoot: join(folder, "evidence"), repo: project, configDir: folder, projectRoots: [folder] });
  await listen(opServer);
  operator = { ...(await signIn(opServer, "operator")), close: async () => { await closeServer(opServer); store.close(); rmSync(folder, { recursive: true, force: true }); } };
  await openProject(operator, project);
  // One ceremony with its object present: a chat turn whose charge is unknown, waiting for its acknowledgement.
  const now = new Date();
  const turn = store.openChatTurn({ approver: "operator", credentialKey: "destinations", provider: "openrouter-api", model: "synthetic", reservedMicrousd: 50_000,
    dailyTurns: 10, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
  if (!turn.ok) throw Error(`chat turn: ${turn.reason}`);
  const started = store.startChatTurn(turn.id, now);
  if (!started.ok || !store.finalizeChatTurn(turn.id, started.generation, { state: "failed", settledMicrousd: null, unknownSpend: true }, now)) throw Error("chat turn");
  acknowledgement = `/chat/ack/${turn.id}`;
});
let acknowledgement = "";
afterAll(async () => { await demo?.close(); await operator?.close(); });

function expectKind(id: string, kind: "page" | "alias" | "ceremony" | "data", answer: Answer, to?: string): void {
  const absent = ABSENT[id];
  const seen = `${id}: ${answer.status} ${answer.type} ${answer.location}${absent === undefined ? "" : ` (held at ${absent.status}: ${absent.why})`}`;
  if (kind === "page") {
    expect(isDocument(answer), seen).toBe(true);
    expect(answer.status, seen).toBe(absent?.status ?? 200);
  } else if (kind === "ceremony") {
    // A ceremony's own document (its terms and proof, or the console's answer that nothing waits there): never a redirect.
    expect(isDocument(answer), seen).toBe(true);
    if (absent !== undefined) expect(answer.status, seen).toBe(absent.status);
  } else if (kind === "alias") {
    if (absent !== undefined && !isRedirect(answer)) { expect(answer.status, seen).toBe(absent.status); return; }
    expect(isRedirect(answer), seen).toBe(true);
    expect(leadsTo(answer.location, to!), `${seen} should lead to ${to}`).toBe(true);
  } else {
    // Data: never a page (a 200 document) and never a redirect to one.
    expect(isRedirect(answer), seen).toBe(false);
    expect(answer.status === 200 && isDocument(answer), seen).toBe(false);
  }
}

describe("each entry answers as its kind", () => {
  test("on the demo, and on an operator's console for the rows the demo account may not open", async () => {
    const checked: string[] = [];
    for (const [id, entry] of entries) {
      if (entry.kind === "mixed") continue;
      const world = OPERATOR_ROWS.has(id) ? operator : demo;
      const path = (world === demo ? DEMO_PATHS[id] : undefined) ?? entry.path;
      expectKind(id, entry.kind, await get(world, path), entry.to);
      checked.push(id);
    }
    expect(checked.length).toBe(entries.length - count("mixed"));
  });

  test("a ceremony with its object present is its own document carrying the proof, never changed in place", async () => {
    const answer = await get(operator, acknowledgement);
    expect(isDocument(answer) && answer.status === 200, `chat.ack: ${answer.status}`).toBe(true);
    expect(answer.body).toContain('"sensitive":true');
    expect(answer.body).toContain('"inPlace":false');
    expect(answer.body).toMatch(/type="password"/);
  });

  test("a mixed row is a page in one condition and an alias in the other", async () => {
    expect(Object.keys(MIXED).sort()).toEqual(entries.filter(([, entry]) => entry.kind === "mixed").map(([id]) => id).sort());
    for (const [id, probes] of Object.entries(MIXED)) {
      const entry = manifest.routes[id]!;
      const world = (name: "demo" | "operator") => name === "demo" ? demo : operator;
      expectKind(id, "page", await get(world(probes.page.world), probes.page.path));
      expectKind(id, "alias", await get(world(probes.alias.world), probes.alias.path), entry.when!.find(one => one.kind === "alias")!.to);
    }
  });
});

