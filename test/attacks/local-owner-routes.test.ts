/**
 * Easy-start C1: a laptop's local owner (no password) acts only where it is marked to (the rule table over every route
 * is local-owner-routes.slow.test.ts). A refused act changes nothing; an allowed one runs; local mode turned off ends
 * the session. The adapters outside the table refuse it too: the team API and the OAuth consent. A terminal's
 * WebSocket admits it only on a solo install, and only to terminals a local owner's session started (T4).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { join } from "node:path";
import { COPY_CONFIG, loadPtySpawn, TerminalHost } from "../../src/live-terminal.js";
import { openLocalWorld, LOCAL_T0, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { enrollOwnerPassword } from "../../src/store.js";
import { hashPassword } from "../../src/scope.js";
import { networkInterfaces, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { acquire, release } from "../../src/claim.js";
import { register } from "../../src/runner.js";
import { presented } from "../serve-kit.js";
import { request as httpRequest } from "node:http";
import { LOCAL_OWNER_ELSEWHERE } from "../../src/local-owner.js";
/** File for a plan (Plan first): a solo install offers Build on its own terms otherwise (fast-start.ts SOLO_START_RULE). */
const PLAN_FIRST = { "planning-policy": "choice", "plan-first": "1" } as const;

let world: LocalWorld;
afterEach(async () => { await world.close(); });

describe("the console's rows, as a local owner", () => {
  beforeEach(async () => { world = await openLocalWorld(); }, LOCAL_WORLD_SETUP_MS);

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
    const filed = await world.post("/tasks/add", cookie, { csrf, repo: world.repo, ...PLAN_FIRST, title: "Fix the footer" });
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
    const filed = await world.post("/tasks/add", cookie, { csrf, repo: world.repo, ...PLAN_FIRST, title: words });
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
    const answer = await world.post("/tasks/add", cookie, { csrf, repo: world.repo, ...PLAN_FIRST, title: "After off", goal: "Should not file." });
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
    const filed = await world.post("/tasks/add", cookie, { csrf, repo: world.repo, ...PLAN_FIRST, title: "From here" });
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
/**
 * Solo-workbench T4 (take over): on a solo laptop install the local owner's session starts and attaches its own live
 * terminal, opened on a build's saved commit that Toolroll recorded (the request names only the task and the build).
 * It never reaches a full session's terminal; a second person joining closes its open socket and refuses the rest.
 */
describe.skipIf(spawn === null || process.platform === "win32")("terminals, as a local owner", () => {
  let host: TerminalHost, head: string, run: number, roots: string[] = [];
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  beforeEach(async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-local-term-")));
    // The shell is the real default: the person's login shell (here bash -l, with SHELL unset and a HOME of the test's
    // own), started with the take-over's short environment. Only `claude` is a stand-in (cat).
    host = new TerminalHost({ spawn: spawn!, worktreeRoot: join(dir, "live"), closeGraceMs: 300, programs: { claude: { file: "/bin/cat", args: [] } },
      // The project's own tool folder on PATH, as a person's PATH may hold one: build-writable, so never the shell's.
      env: () => ({ PATH: `${join(roots[0] ?? dir, "node_modules", ".bin")}:${process.env["PATH"] ?? ""}`, HOME: dir, SECRET_TOKEN_FOR_TEST: "never-in-a-take-over" }),
      buildWritable: () => roots });
    world = await openLocalWorld({ terminalHost: host } as never);
    roots = [world.repo];
    // The build's own commit, on a branch of the project (the project's HEAD stays where it was).
    const git = (...args: string[]) => execFileSync("git", ["-C", world.repo, "-c", "user.email=q@example.com", "-c", "user.name=q", ...args], { env: gitEnv, encoding: "utf8" }).trim();
    git("checkout", "-q", "-b", "build-one");
    writeFileSync(join(world.repo, "built.txt"), "made by the build\n");
    git("add", "built.txt");
    git("commit", "-qm", "the build's change");
    head = git("rev-parse", "HEAD");
    git("checkout", "-q", "-");
    register(world.store, { name: "builder-1", host: "here", capacity: 4, repos: [world.repo], now: new Date(), newToken: () => "tok-builder-1" });
    // A task of its own with no plan (its build runs without a route), placed in the project.
    world.store.createTask({ id: "fix", title: "Fix the footer" }, LOCAL_T0);
    const ref = world.store.refFor("built-in", "fix", "ours").id;
    world.store.placeTask(ref, world.repo);
    const taken = acquire(world.store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
    if (!taken.ok) throw new Error("claim failed");
    run = world.store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1", branch: "build-one", worktree: world.repo, now: new Date(), ...presented(world.store, ref, "builder") });
    world.store.recordOutcomeFacts(run, { headRevision: head });
    world.store.finishRun(run, { outcome: "built", committed: true, now: new Date() } as never);
    release(world.store, taken.claim.leaseId, new Date());
  }, LOCAL_WORLD_SETUP_MS);
  afterEach(async () => { await host.stop(); });
  const upgrade = (path: string, headers: Record<string, string>) => new Promise<number | "open">(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${world.port}${path}`, { headers });
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("unexpected-response", (_request, response) => { resolve(response.statusCode ?? 0); response.resume(); });
    ws.on("error", () => resolve(0));
  });
  const takeOver = async (cookie: string, csrf: string, fields: Record<string, string> = { task: "fix", run: String(run) }) => {
    const answer = await world.post("/term/start", cookie, { csrf, program: "shell", ...fields }, "application/json");
    return { status: answer.status, refused: answer.headers["x-toolroll-refused"], body: JSON.parse(answer.body) as { ok: boolean; id?: string; error?: string } };
  };

  test("solo: a take-over opens on the build's saved commit, is listed with its build, and its shell answers typing", async () => {
    const { cookie, csrf } = await world.localSession();
    const started = await takeOver(cookie, csrf);
    expect(started).toMatchObject({ status: 200, body: { ok: true } });
    const id = started.body.id!;
    const terminal = host.get(id)!;
    // The worktree is at the build's commit (the project's HEAD never had built.txt), on a branch of its own.
    expect(readFileSync(join(terminal.worktree, "built.txt"), "utf8")).toBe("made by the build\n");
    expect(execFileSync("git", ["-C", terminal.worktree, "rev-parse", "HEAD"], { env: gitEnv, encoding: "utf8" }).trim()).toBe(head);
    expect(terminal).toMatchObject({ task: "fix", run, localGeneration: expect.any(Number) });
    const state = JSON.parse((await world.send("/term/state", "GET", { cookie })).body) as { sessions: { id: string; task: string | null; run: number | null }[] };
    expect(state.sessions).toEqual([expect.objectContaining({ id, task: "fix", run })]);
    // Attached with the session's own cookie from the console's own origin: typing reaches the shell, its output comes back.
    const ws = new WebSocket(`ws://127.0.0.1:${world.port}/term/${id}/socket`, { headers: { cookie, origin: world.origin } });
    let seen = "";
    const echoed = new Promise<void>(resolve => ws.on("message", (data, binary) => { if (binary) { seen += String(data); if (seen.includes("took-over-42")) resolve(); } }));
    await new Promise(resolve => ws.on("open", resolve));
    ws.send(JSON.stringify({ t: "in", d: "echo took-over-$((40+2))\r" }));
    await echoed;
    ws.close();
  });

  test("the copy is a repository of its own: hooks and config planted in the project's shared .git never run from it", async () => {
    const { cookie, csrf } = await world.localSession();
    const id = (await takeOver(cookie, csrf)).body.id!;
    const copy = host.get(id)!.worktree;
    // Toolroll's own .git: its config is Toolroll's lines only, no hooks, objects read from the project's record only.
    expect(readFileSync(join(copy, ".git", "config"), "utf8")).toBe(COPY_CONFIG);
    expect(existsSync(join(copy, ".git", "hooks")) ? readdirSync(join(copy, ".git", "hooks")) : []).toEqual([]);
    expect(lstatSync(join(copy, ".git")).isDirectory()).toBe(true);
    // Its objects are its own (fetched and checked), never borrowed from the project's.
    expect(existsSync(join(copy, ".git", "objects", "info", "alternates"))).toBe(false);
    // A build plants a hook and a command in the project's shared git folder after the copy was made.
    const fired = join(world.root, "fired");
    const script = join(world.root, "evil.sh");
    writeFileSync(script, `#!/bin/sh\necho "$0" >> ${fired}\n`, { mode: 0o755 });
    writeFileSync(join(world.repo, ".git", "config"), `${readFileSync(join(world.repo, ".git", "config"), "utf8")}[core]\n\tfsmonitor = ${script}\n\thooksPath = ${join(world.repo, ".git", "evil-hooks")}\n`);
    mkdirSync(join(world.repo, ".git", "hooks"), { recursive: true });
    mkdirSync(join(world.repo, ".git", "evil-hooks"), { recursive: true });
    for (const hook of ["pre-commit", "post-commit", "reference-transaction"]) {
      writeFileSync(join(world.repo, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> ${fired}\n`, { mode: 0o755 });
      writeFileSync(join(world.repo, ".git", "evil-hooks", hook), `#!/bin/sh\necho ${hook} >> ${fired}\n`, { mode: 0o755 });
    }
    // The person's shell runs git in the copy: status, a commit, and the environment it was started with.
    const ws = new WebSocket(`ws://127.0.0.1:${world.port}/term/${id}/socket`, { headers: { cookie, origin: world.origin } });
    let seen = "";
    const done = new Promise<void>(resolve => ws.on("message", (data, binary) => { if (binary) { seen += String(data); if (/finished-2\b/.test(seen)) resolve(); } }));
    await new Promise(resolve => ws.on("open", resolve));
    ws.send(JSON.stringify({ t: "in", d: "git status; git -c user.email=q@example.com -c user.name=q commit -q --allow-empty -m mine; env | grep -c SECRET_TOKEN_FOR_TEST; echo \"<<$PATH>>\"; echo finished-$((1+1))\r" }));
    await done;
    ws.close();
    expect(existsSync(fired)).toBe(false);
    expect(seen).toMatch(/\r?\n0\r?\n/);
    // The project's tool folder was taken off the shell's PATH.
    const path = [...seen.matchAll(/<<([^<>\r\n]*)>>/g)].map(match => match[1]!).filter(one => one !== "$PATH").at(-1) ?? "";
    expect(path).not.toBe("");
    expect(path).not.toContain(world.repo);
    // The plant is real: git in the project itself runs it.
    execFileSync("git", ["-C", world.repo, "status"], { env: gitEnv });
    expect(readFileSync(fired, "utf8")).toContain("evil.sh");
    // The copy now holds a commit of the person's own: it isn't removed with the terminal.
    await host.close(id);
    await expect(host.remove(id)).rejects.toThrow(/1 commit \(\w+ mine\)/);
    expect(existsSync(copy)).toBe(true);
  });

  test("a copy whose own commit is on another branch, with HEAD detached back at the build, is not removed", async () => {
    const { cookie, csrf } = await world.localSession();
    const id = (await takeOver(cookie, csrf)).body.id!;
    const copy = host.get(id)!.worktree;
    const git = (...args: string[]) => execFileSync("git", ["-C", copy, "-c", "user.email=q@example.com", "-c", "user.name=q", ...args], { env: gitEnv, encoding: "utf8" }).trim();
    git("switch", "-q", "-c", "side");
    git("commit", "-q", "--allow-empty", "-m", "kept on a side branch");
    git("switch", "-q", "--detach", head);
    git("branch", "-q", "-D", "side");
    await host.close(id);
    // Only the reflog still holds it: removal names it and keeps the folder.
    await expect(host.remove(id)).rejects.toThrow(/kept on a side branch/);
    expect(existsSync(copy)).toBe(true);
  });

  test("a loose object the build rewrote under its valid name is refused, never checked out", async () => {
    const { cookie, csrf } = await world.localSession();
    // built.txt's blob, a loose object: a valid zlib stream, a blob header, the wrong content for its name.
    const blob = execFileSync("git", ["-C", world.repo, "rev-parse", `${head}:built.txt`], { env: gitEnv, encoding: "utf8" }).trim();
    const loose = join(world.repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    expect(existsSync(loose)).toBe(true);
    const forged = Buffer.from("rm -rf ~ # swapped\n");
    chmodSync(loose, 0o644);
    writeFileSync(loose, deflateSync(Buffer.concat([Buffer.from(`blob ${forged.length}\0`), forged])));
    const answer = await takeOver(cookie, csrf);
    expect(answer.status).toBe(409);
    expect(answer.body.error).toMatch(/didn't copy whole/);
    expect(host.list("alex")).toEqual([]);
  });

  test("a project whose git borrows objects from elsewhere (alternates) is refused before anything is fetched", async () => {
    const { cookie, csrf } = await world.localSession();
    mkdirSync(join(world.repo, ".git", "objects", "info"), { recursive: true });
    writeFileSync(join(world.repo, ".git", "objects", "info", "alternates"), `${join(world.root, "elsewhere")}\n`);
    const answer = await takeOver(cookie, csrf);
    expect(answer.status).toBe(409);
    expect(answer.body.error).toMatch(/alternates/);
  });

  test("it names a task and its build, nothing else: a project, half a pair or a build of no result is refused", async () => {
    const { cookie, csrf } = await world.localSession();
    expect((await takeOver(cookie, csrf, { task: "fix", run: String(run), repo: world.repo })).status).toBe(400);
    expect((await takeOver(cookie, csrf, { task: "fix" })).status).toBe(400);
    expect((await takeOver(cookie, csrf, { run: String(run) })).status).toBe(400);
    expect((await takeOver(cookie, csrf, { task: "fix", run: String(run + 100) })).status).toBe(404);
    expect((await takeOver(cookie, csrf, { task: "no-such-task", run: String(run) })).status).toBe(404);
    expect(host.list("alex")).toEqual([]);
  });

  test("a second person joins: the open socket closes, and the list and a new start are refused", async () => {
    const { cookie, csrf } = await world.localSession();
    const id = (await takeOver(cookie, csrf)).body.id!;
    const ws = new WebSocket(`ws://127.0.0.1:${world.port}/term/${id}/socket`, { headers: { cookie, origin: world.origin } });
    await new Promise(resolve => ws.on("open", resolve));
    const closed = new Promise<number>(resolve => ws.on("close", code => resolve(code)));
    world.store.saveApprover("robin", hashPassword("robin-password-1"), new Date());
    expect(await closed).toBe(4401);
    expect((await world.send("/term/state", "GET", { cookie })).status).toBe(403);
    const again = await takeOver(cookie, csrf);
    expect(again.status).toBe(403);
    expect(again.body.error).toMatch(/only person using this Toolroll/);
    expect(await upgrade(`/term/${id}/socket`, { cookie, origin: world.origin })).toBe(401);
  });

  test("a full session's terminal of the same account never attaches to the local owner's session", async () => {
    const { cookie } = await world.localSession();
    const generation = world.store.accountOf("alex")!.generation;
    const open = await host.start({ name: "alex", generation }, world.repo, "claude");
    expect(await upgrade(`/term/${open.id}/socket`, { cookie, origin: world.origin })).toBe(404);
    expect(host.viewerCount(open.id)).toBe(0);
    // And it isn't listed for the local owner either.
    const state = JSON.parse((await world.send("/term/state", "GET", { cookie })).body) as { sessions: unknown[] };
    expect(state.sessions).toEqual([]);
  });

  test("another origin, or a credential header, never upgrades", async () => {
    const { cookie, csrf } = await world.localSession();
    const id = (await takeOver(cookie, csrf)).body.id!;
    expect(await upgrade(`/term/${id}/socket`, { cookie, origin: "http://evil.example" })).toBe(403);
    expect(await upgrade(`/term/${id}/socket`, { cookie })).toBe(403);
    expect(await upgrade(`/term/${id}/socket`, { cookie, origin: world.origin, authorization: "Bearer so_x" })).toBe(403);
    expect(host.viewerCount(id)).toBe(0);
  });
});
