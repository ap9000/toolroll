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

  test("a description longer than a title is filed with a whole-word title and an ellipsis", async () => {
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
