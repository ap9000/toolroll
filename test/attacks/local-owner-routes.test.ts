/**
 * Easy-start C1: a laptop's local owner (no password) acts only where it is marked to (the rule table over every route
 * is local-owner-routes.slow.test.ts). A refused act changes nothing; an allowed one runs; local mode turned off ends
 * the session. The adapters outside the table refuse it too: the team API, the OAuth consent, and a terminal's
 * WebSocket — a new one and one already open for the owner.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { join } from "node:path";
import { loadPtySpawn, TerminalHost } from "../../src/live-terminal.js";
import { openLocalWorld, LOCAL_T0, type LocalWorld } from "../local-owner-world.js";
import { enrollOwnerPassword } from "../../src/store.js";
import { hashPassword } from "../../src/scope.js";
import { networkInterfaces } from "node:os";
import { request as httpRequest } from "node:http";
import { LOCAL_OWNER_ELSEWHERE } from "../../src/local-owner.js";

let world: LocalWorld;
afterEach(async () => { await world.close(); });

describe("the console's rows, as a local owner", () => {
  beforeEach(async () => { world = await openLocalWorld(); });

  test("a refused act changes nothing: settings, people and tokens stay as they were", async () => {
    const { cookie, csrf } = await world.localSession();
    const before = JSON.stringify([world.store.handle.prepare("SELECT * FROM approver").all(), world.store.handle.prepare("SELECT * FROM credential").all(),
      world.store.handle.prepare("SELECT * FROM confinement_setting").all(), world.store.handle.prepare("SELECT * FROM project_check_access").all()]);
    for (const [path, form] of [["/people/invite", { name: "robin" }], ["/settings/project/check-access", { repo: world.repo, level: "unsandboxed" }],
      ["/settings/passwordless", { on: "yes" }], ["/settings/sessions", {}], ["/mode/sign", {}]] as const) {
      const answer = await world.post(path, cookie, { csrf, ...form });
      expect(answer.headers["x-toolroll-refused"], path).toBe("local-owner");
    }
    // A JSON caller hears the same refusal, with where to go: set a password, then on to the page the form belongs to.
    const json = await world.post("/people/invite", cookie, { csrf }, "application/json");
    expect(JSON.parse(json.body)).toEqual({ ok: false, said: "Set a password to do this.", href: "/password/set?next=%2Fpeople" });
    expect(JSON.stringify([world.store.handle.prepare("SELECT * FROM approver").all(), world.store.handle.prepare("SELECT * FROM credential").all(),
      world.store.handle.prepare("SELECT * FROM confinement_setting").all(), world.store.handle.prepare("SELECT * FROM project_check_access").all()])).toBe(before);
  });

  test("an allowed act runs as the local owner: a task filed", async () => {
    const { cookie, csrf } = await world.localSession();
    const filed = await world.post("/tasks/add", cookie, { csrf, repo: world.repo, title: "Fix the footer" });
    expect(filed.headers["x-toolroll-refused"]).toBeUndefined();
    expect(filed.status).toBe(303);
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM task WHERE title = 'Fix the footer'").get()?.["n"]).toBe(1);
  });

  test("the New task box stops at a title's 200 characters: no-goal words past it would never reach the planner", async () => {
    const { cookie } = await world.localSession();
    const page = await world.send("/tasks/new", "GET", { cookie });
    expect(page.status).toBe(200);
    const box = page.body.match(/<textarea[^>]*name="title"[^>]*>/)?.[0] ?? "";
    expect(box).toMatch(/maxlength="200"/);
  });

  test("a direct POST longer than a title (the belt) is filed with a whole-word title and an ellipsis", async () => {
    const { cookie, csrf } = await world.localSession();
    const words = "Format prices with a currency symbol everywhere they are shown, including the README's examples, the error messages and every test name that mentions an amount, without changing what any function returns";
    const filed = await world.post("/tasks/add", cookie, { csrf, repo: world.repo, title: words });
    expect(filed.status).toBe(303);
    const title = String(world.store.handle.prepare("SELECT title FROM task ORDER BY rowid DESC LIMIT 1").get()?.["title"]);
    expect(title).toBe("Format prices with a currency symbol everywhere they are shown, including the README's examples, the error messages and every test name that mentions an amount, without changing what any function…");
  });

  test("once a password is set, a refused act leads to signing in with it (and back to this page)", async () => {
    expect(enrollOwnerPassword(world.store, "alex", hashPassword("a long enough password"), 1, LOCAL_T0)).toMatchObject({ ok: true });
    // Local mode stays on: the local link still opens a local owner's session.
    const { cookie, csrf } = await world.localSession();
    const page = await world.send("/settings/models?tab=x", "GET", { cookie });
    expect(page.headers["x-toolroll-refused"]).toBeUndefined();
    const refused = await world.post("/people/invite", cookie, { csrf }, "application/json");
    expect(JSON.parse(refused.body)).toEqual({ ok: false, said: "Sign in with your password to do this.", href: "/login?return=%2Fpeople" });
  });

  test("local mode turned off mid-session: the cookie no longer signs in, and nothing it sends acts", async () => {
    const { cookie, csrf } = await world.localSession();
    world.store.handle.prepare("UPDATE local_mode SET enabled = 0, generation = generation + 1 WHERE id = 1").run();
    const answer = await world.post("/tasks/add", cookie, { csrf, repo: world.repo, title: "After off", goal: "Should not file." });
    expect(answer.status).toBe(401);
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM task WHERE title = 'After off'").get()?.["n"]).toBe(0);
  });

  test("the team API refuses a local owner's cookie, reads and sends alike", async () => {
    const { cookie, csrf } = await world.localSession();
    const read = await world.send("/api/team", "GET", { cookie });
    expect(read.status).toBe(401);
    const sent = await world.send("/api/team", "POST", { cookie, origin: world.origin, "x-csrf-token": csrf, "content-type": "application/json" }, JSON.stringify({ version: 1, op: "conversations" }));
    expect(sent.status).toBe(401);
  });

  test("OAuth consent never takes a local owner's session as the person consenting: it reads as signed out", async () => {
    const { cookie } = await world.localSession();
    const registered = await world.send("/oauth/register", "POST", { "content-type": "application/json" },
      JSON.stringify({ client_name: "Test Agent", redirect_uris: ["http://127.0.0.1:9/callback"], token_endpoint_auth_method: "none" }));
    expect(registered.status).toBe(201);
    const client = (JSON.parse(registered.body) as { client_id: string }).client_id;
    const start = new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: "http://127.0.0.1:9/callback", code_challenge: "a".repeat(43),
      code_challenge_method: "S256", state: "st-1", resource: `${world.origin}/mcp`, scope: "read act" });
    const first = await world.send(`/oauth/authorize?${start}`, "GET");
    const next = (/http-equiv="refresh" content="0;url=([^"]+)"/.exec(first.body)?.[1] ?? "").replace(/&amp;/g, "&");
    expect(next).toMatch(/^\/oauth\/authorize\?request=/);
    // With the local owner's cookie the consent page is the console's sign-in, never a consent form.
    const page = await world.send(next, "GET", { cookie });
    expect(page.status).toBe(303);
    expect(page.headers["location"]).toBe(`/login?return=${encodeURIComponent(next)}`);
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM oauth_code").get()?.["n"]).toBe(0);
  });
});

// Local-owner slice 0 (Codex finding c): "this computer" is checked on every request a local owner's session makes, not
// only when the session is made. From another address, through a proxy, or at a tailnet or LAN name, the cookie signs in
// no one: reads and acts alike are refused in plain words and nothing changes (not even the session's last use).
describe("a local owner's session from anywhere but this computer", () => {
  const TAILNET = "laptop.example.ts.net";
  /** Representative rows: reads (a page, a workspace read, a task) and the owner's own acts (filing, choosing a project,
   * completing, stopping). */
  const tried = (repo: string, csrf: string): [string, string, Record<string, string>][] => [
    ["GET", "/chat", {}], ["GET", "/chat?format=workspace", {}], ["GET", "/t/one", {}],
    ["POST", "/tasks/add", { csrf, repo, title: "From elsewhere" }], ["POST", "/projects/select", { csrf, path: repo }],
    ["POST", "/t/one/complete", { csrf, receipt: "0".repeat(64), run: "1" }], ["POST", "/t/one/stop", { csrf, run: "1" }],
  ];
  const unchanged = () => JSON.stringify([world.store.handle.prepare("SELECT id, title, state FROM task ORDER BY id").all(),
    world.store.webSessions("alex"), world.store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger").get()]);
  const expectRefused = (answer: { status: number; body: string; headers: Record<string, unknown> }, what: string) => {
    expect(answer.status, what).toBe(403);
    expect(answer.headers["x-toolroll-refused"], what).toBe("local-owner-elsewhere");
    expect(answer.body, what).toBe(LOCAL_OWNER_ELSEWHERE);
  };
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

  test("through a proxy: any forwarding header refuses every row, GET and POST; the same from this computer works", async () => {
    world = await openLocalWorld();
    const { cookie, csrf } = await world.localSession();
    const before = unchanged();
    for (const proxy of [{ "x-forwarded-for": "100.64.0.7" }, { forwarded: "for=100.64.0.7;proto=https" }, { "x-forwarded-host": TAILNET }, { "x-real-ip": "100.64.0.7" }, { via: "1.1 proxy" }]) {
      for (const [method, path, fields] of tried(world.repo, csrf)) {
        const answer = method === "GET" ? await world.send(path, "GET", { cookie, ...proxy })
          : await world.send(path, "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", ...proxy }, form(fields));
        expectRefused(answer, `${method} ${path} ${Object.keys(proxy)[0]}`);
      }
    }
    expect(unchanged()).toBe(before);
    // The sign-in page still answers there (a password signs in), as signed out.
    expect((await world.send("/login", "GET", { cookie, "x-forwarded-for": "100.64.0.7" })).status).toBe(200);
    // …and the first password can't be set through it: the session names no one there.
    const set = await world.send("/password/set", "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "100.64.0.7" },
      form({ csrf, password: "a long enough password", again: "a long enough password" }));
    expect(set.status).toBe(303);
    expect(world.store.accountOf("alex")!.passwordSet).toBe(false);
    // The same session from this computer: reads and the owner's own act run.
    expect((await world.send("/chat", "GET", { cookie })).status).toBe(200);
    const filed = await world.post("/tasks/add", cookie, { csrf, repo: world.repo, title: "From here" });
    expect(filed.status).toBe(303);
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM task WHERE title = 'From here'").get()?.["n"]).toBe(1);
  });

  test("at a tailnet name the console admits: refused, GET and POST, and nothing changes", async () => {
    world = await openLocalWorld({ allowedHosts: [TAILNET] });
    const { cookie, csrf } = await world.localSession();
    const before = unchanged();
    for (const [method, path, fields] of tried(world.repo, csrf)) {
      const answer = method === "GET" ? await world.send(path, "GET", { cookie, host: TAILNET })
        : await world.send(path, "POST", { cookie, host: TAILNET, origin: `http://${TAILNET}`, "content-type": "application/x-www-form-urlencoded" }, form(fields));
      expectRefused(answer, `${method} ${path}`);
    }
    expect(unchanged()).toBe(before);
    expect((await world.send("/chat", "GET", { cookie })).status).toBe(200);
  });

  // Another device on the LAN, played by this machine's own network address (the peer is then not loopback).
  const lan = Object.values(networkInterfaces()).flat().find(one => one !== undefined && one.family === "IPv4" && !one.internal)?.address;
  test.skipIf(lan === undefined)("from another address (a LAN peer naming this computer's loopback Host): refused, and nothing changes", async () => {
    world = await openLocalWorld({}, "0.0.0.0");
    const { cookie, csrf } = await world.localSession();
    const viaLan = (path: string, method: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const sent = httpRequest({ host: lan, port: world.port, path, method, headers: { host: `127.0.0.1:${world.port}`, connection: "close", ...headers } }, response => {
        let text = "";
        response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, body: text, headers: response.headers }));
      });
      sent.on("error", reject); sent.end(body);
    });
    const before = unchanged();
    for (const [method, path, fields] of tried(world.repo, csrf)) {
      const answer = method === "GET" ? await viaLan(path, "GET", { cookie })
        : await viaLan(path, "POST", { cookie, origin: world.origin, "content-type": "application/x-www-form-urlencoded" }, form(fields));
      expectRefused(answer, `${method} ${path}`);
    }
    expect(unchanged()).toBe(before);
    expect((await world.send("/chat", "GET", { cookie })).status).toBe(200);
  });
});

const spawn = loadPtySpawn();
describe.skipIf(spawn === null || process.platform === "win32")("terminals, as a local owner", () => {
  let host: TerminalHost;
  beforeEach(async () => {
    const dir = (await import("node:fs")).realpathSync((await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "so-local-term-")));
    host = new TerminalHost({ spawn: spawn!, worktreeRoot: join(dir, "live"), closeGraceMs: 300, programs: { claude: { file: "/bin/cat", args: [] }, shell: { file: "/bin/sh", args: [] } },
      env: () => ({ PATH: process.env["PATH"] ?? "", HOME: dir }) });
    world = await openLocalWorld({ terminalHost: host } as never);
  });
  const upgrade = (path: string, headers: Record<string, string>) => new Promise<number | "open">(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${world.port}${path}`, { headers });
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("unexpected-response", (_request, response) => { resolve(response.statusCode ?? 0); response.resume(); });
    ws.on("error", () => resolve(0));
  });

  test("starting one is refused, and one already open for the owner does not attach", async () => {
    const { cookie, csrf } = await world.localSession();
    const started = await world.post("/term/start", cookie, { csrf, repo: world.repo, program: "claude" }, "application/json");
    expect(started.headers["x-toolroll-refused"]).toBe("local-owner");
    // A terminal the owner's account already has open (as a full session would have made it): never this session's.
    const generation = world.store.accountOf("alex")!.generation;
    const open = await host.start({ name: "alex", generation }, world.repo, "claude");
    expect(await upgrade(`/term/${open.id}/socket`, { cookie, origin: world.origin })).toBe(401);
    expect(host.viewerCount(open.id)).toBe(0);
    await host.stop();
  });
});
