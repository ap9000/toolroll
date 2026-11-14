/**
 * Adding a repository from the browser, over real HTTP on an `up`-style console (its machine registry, its own
 * identities): the exact path with `~`, the Browse… picker, and a repository from outside the projects folder with a
 * password typed now. Who may, which folders are refused and why (on identity, failing closed), the live ceiling, the
 * ledger, and removals made elsewhere. Its own HOME: the person's real folders are never read.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mintApiToken } from "../api-tokens.js";
import { childLook, type FolderLookRunner } from "../folder-look.js";
import { setPasswordless } from "../passwordless.js";
import { releaseProject } from "../project-admission.js";
import { folderFacts } from "../folder-look.js";
import { folderRefusal, type FolderComparisons, type FolderIdentity, type FolderSeen } from "../project.js";
import { freshFacts, proveAccountNow, typedPasswordNow, withFreshness, type FreshFacts } from "../scope.js";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS } from "../../test/local-owner-world.js";
import { projectIdentities } from "../project-identity.js";
import { loadProjectRegistry } from "../repos.js";
import { addApprover } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const gitInit = (dir: string): void => { mkdirSync(dir, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd: dir, env: gitEnv }); };

let dir: string, home: string, state: string, registry: string;
let store: Store, server: Server, base: string;
const passwords: Record<string, string> = {};
let actToken = "";
const savedHome = process.env["HOME"];

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-pf-")));
  home = join(dir, "home");
  // The home folder: the projects folder ~/Developer, a repository outside it, and what must never be offered or added.
  gitInit(join(home, "Developer", "shelf"));
  gitInit(join(home, "Developer", ".hidden-repo"));
  gitInit(join(home, "code", "outside-repo"));
  mkdirSync(join(home, "Developer", ".hidden-stuff"), { recursive: true });
  mkdirSync(join(home, "Documents", "notes"), { recursive: true });
  mkdirSync(join(home, "Library", "Things"), { recursive: true });
  mkdirSync(join(home, ".secret"), { recursive: true });
  gitInit(join(dir, "elsewhere", "far-repo"));
  symlinkSync(join(dir, "elsewhere"), join(home, "Developer", "link-out"));
  state = join(home, "toolroll-state");
  mkdirSync(state, { recursive: true });
  registry = join(state, "repos.json");
  process.env["HOME"] = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

async function boot(projectRoots: string[] = [join(home, "Developer")], extra: Record<string, unknown> = {}): Promise<void> {
  const identities = projectIdentities();
  // As startConsole does after listening (consoleIdentitiesInBackground): the configured folders resolve off the thread.
  await identities.refresh(projectRoots);
  server = createDecisionServer({
    store, evidenceRoot: join(state, "evidence"), clock: () => new Date(), identities,
    upConsole: true, registryPath: registry, configDir: state, poolRoot: join(state, "worktrees"),
    admittedRepos: () => [], projectRoots, ...extra,
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const close = (): Promise<void> => new Promise(resolve => server.close(() => resolve()));

beforeEach(async () => {
  rmSync(registry, { force: true });
  store = openStore(":memory:");
  const now = new Date();
  const alex = addApprover(store, "alex", now); if (!alex.ok) throw new Error("bootstrap");
  passwords["alex"] = alex.token;
  const robin = addApprover(store, "robin", now, { name: "alex", token: alex.token }); if (!robin.ok) throw new Error("robin");
  passwords["robin"] = robin.token;
  const lim = addApprover(store, "lim", now, { name: "alex", token: alex.token }); if (!lim.ok) throw new Error("limited");
  passwords["lim"] = lim.token;
  const vera = addApprover(store, "vera", now, { name: "alex", token: alex.token }); if (!vera.ok) throw new Error("viewer");
  passwords["vera"] = vera.token;
  store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
  store.raw().prepare(`UPDATE approver SET projects_json = '["/repo/main"]' WHERE name = 'lim'`).run();
  // robin: an approver, but not an instance operator (instance operators are approvers with every project).
  store.raw().prepare(`UPDATE approver SET projects_json = '[]' WHERE name = 'robin'`).run();
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: "act", secretHash: minted.hash, access: "act", expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), by: "alex" }, now);
  actToken = minted.token;
  await boot();
});
afterEach(async () => {
  await close();
  store.close();
});

async function login(name: string): Promise<{ cookie: string; csrf: string }> {
  const answer = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: passwords[name]! }), redirect: "manual" });
  const cookie = (answer.headers.get("set-cookie") ?? "").split(";")[0]!;
  const page = await (await fetch(`${base}/projects`, { headers: { cookie } })).text();
  return { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? /"csrf":"([^"]+)"/.exec(page)?.[1] ?? "" };
}
async function post(path: string, who: { cookie: string; csrf: string } | null, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const answer = await fetch(`${base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(who === null ? {} : { cookie: who.cookie }), ...headers },
    body: new URLSearchParams({ ...(who === null ? {} : { csrf: who.csrf }), ...fields }),
  });
  return { status: answer.status, location: answer.headers.get("location") ?? "", body: await answer.text() };
}
const savedRepos = async (): Promise<string[]> => { const loaded = await loadProjectRegistry(registry); return "error" in loaded ? ["(error)"] : loaded.repos; };
const get = async (path: string, cookie: string) => { const answer = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" }); return { status: answer.status, body: await answer.text() }; };

const outside = (): string => join(home, "code", "outside-repo");

describe("inside the projects folder", () => {
  test("~ expands and a repository there is added with no password, as before", async () => {
    const alex = await login("alex");
    const opened = await post("/projects/open", alex, { path: "~/Developer/shelf", via: "path", return: "/projects" });
    expect(opened.status).toBe(303);
    expect(opened.location).toBe("/projects");
    expect(store.listProjects().map(one => one.path)).toEqual([join(home, "Developer", "shelf")]);
    expect((await post("/projects/open", alex, { path: "~robin/x", via: "path" })).body).toContain("Only ~ for your own home folder");
  });

  test("a hidden repository inside it is refused like any other path, by the exact path and by a row's Open", async () => {
    const alex = await login("alex");
    for (const fields of [{ path: "~/Developer/.hidden-repo", via: "path" }, { path: join(home, "Developer", ".hidden-repo") }]) {
      const answer = await post("/projects/open", alex, { ...fields, return: "/projects" });
      expect(answer.status, JSON.stringify(fields)).toBe(400);
      expect(answer.body).toContain("A hidden folder can’t be added");
    }
    expect(store.listProjects()).toEqual([]);
    expect(await savedRepos()).toEqual([]);
  });
});

describe("adding a repository from outside the projects folder", () => {
  test("refused without a password typed now and for viewer, limited and token; with it, added at once and openable, with a ledger row", async () => {
    const vera = await login("vera"), lim = await login("lim"), alex = await login("alex");
    for (const [who, name] of [[vera, "vera"], [lim, "lim"]] as const) {
      expect((await post("/projects/open", who, { path: "~/code/outside-repo", via: "path", password: passwords[name]! })).status).toBe(403);
    }
    const token = await fetch(`${base}/projects/open`, { method: "POST", headers: { authorization: `Bearer ${actToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ path: outside(), via: "path", password: passwords["alex"]! }), redirect: "manual" });
    expect(token.status).toBe(403);
    // No password: the reason, in the panel, with what was typed kept.
    const bare = await post("/projects/open", alex, { path: "~/code/outside-repo", via: "path" });
    expect(bare.status).toBe(403);
    expect(bare.body).toContain("To add it anyway, enter your Toolroll password");
    expect(bare.body).toContain('value="~/code/outside-repo"');
    expect((await post("/projects/open", alex, { path: "~/code/outside-repo", via: "path", password: "wrong" })).body).toContain("That password didn");
    // A row's Open (no exact-path form) never adds from outside, whatever it carries.
    expect((await post("/projects/open", alex, { path: outside(), password: passwords["alex"]! })).status).toBe(403);
    expect(store.listProjects()).toEqual([]);
    // Not a repository, and Toolroll's own folders: refused with the reason.
    expect((await post("/projects/open", alex, { path: "~/Documents/notes", via: "path", password: passwords["alex"]! })).body).toContain("not a git repository");
    gitInit(join(state, "worktrees", "task-1"));
    expect((await post("/projects/open", alex, { path: join(state, "worktrees", "task-1"), via: "path", password: passwords["alex"]! })).body).toContain("Toolroll’s own");
    // With the password: added, saved, live, and the session opens it at once.
    const added = await post("/projects/open", alex, { path: "~/code/outside-repo", via: "path", password: passwords["alex"]!, return: "/projects" });
    expect(added.status).toBe(303);
    expect(store.listProjects().map(one => one.path)).toEqual([outside()]);
    expect(await savedRepos()).toEqual([outside()]);
    expect(store.actionLedger({ repos: [outside()] }).map(one => one.action)).toContain("project added from outside the projects folder");
    expect((await get("/projects/outside-repo", alex.cookie)).status).toBe(200);
    expect((await post("/projects/select", alex, { path: outside(), return: "/projects" })).status).toBe(303);
  });

  test("removed elsewhere (repos remove, the lead), it leaves the console too: adding it again asks the password again", async () => {
    const alex = await login("alex");
    expect((await post("/projects/open", alex, { path: outside(), via: "path", password: passwords["alex"]!, return: "/projects" })).status).toBe(303);
    const removed = await releaseProject(store, { registryFile: registry, path: outside(), actor: { label: "alex", origin: "cli" }, now: new Date() });
    expect(removed).toMatchObject({ ok: true, removed: true });
    expect((await post("/projects/select", alex, { path: outside(), return: "/projects" })).status).toBe(403);
    expect((await get("/projects/outside-repo", alex.cookie)).status).toBe(404);
    expect((await post("/projects/open", alex, { path: outside(), via: "path" })).body).toContain("To add it anyway, enter your Toolroll password");
  });

  test("a Toolroll folder that isn't there yet still excludes by its path; one that can't be read refuses (fail closed)", async () => {
    const alex = await login("alex");
    // The task checkouts folder is configured inside the repository but not made yet: the repository holds it.
    await close();
    await boot(undefined, { poolRoot: join(outside(), "not-made-yet", "worktrees") });
    const again = await login("alex");
    const holds = await post("/projects/open", again, { path: outside(), via: "path", password: passwords["alex"]! });
    expect(holds.body).toContain("Toolroll’s own");
    expect(store.listProjects()).toEqual([]);
    // The checkouts folder sits behind a folder this user can't read: nothing can be checked, so nothing is added.
    const locked = join(home, "locked");
    mkdirSync(join(locked, "pool"), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      await close();
      await boot(undefined, { poolRoot: join(locked, "pool") });
      const third = await login("alex");
      const unread = await post("/projects/open", third, { path: outside(), via: "path", password: passwords["alex"]! });
      expect(unread.status).toBe(503);
      expect(unread.body).toContain("couldn&#39;t be read");
      expect(store.listProjects()).toEqual([]);
    } finally {
      chmodSync(locked, 0o755);
    }
    void alex;
  });
});

describe("the folder picker", () => {
  test("approvers only; lists the home folder's folders, repositories marked, without hidden, ~/Library, Toolroll's own or links out", async () => {
    const vera = await login("vera"), lim = await login("lim"), alex = await login("alex");
    expect((await get("/projects/pick", vera.cookie)).status).toBe(403);
    expect((await get("/projects/pick", lim.cookie)).status).toBe(403);
    const token = await fetch(`${base}/projects/pick`, { headers: { authorization: `Bearer ${actToken}` }, redirect: "manual" });
    expect(token.status).toBe(403);
    const top = (await get(`/projects/pick?at=${encodeURIComponent("~")}`, alex.cookie)).body;
    for (const shown of ["Developer", "Documents", "code"]) expect(top).toContain(`>${shown}</a>`);
    for (const hidden of [".secret", "Library", "toolroll-state"]) expect(top).not.toContain(`>${hidden}</a>`);
    // It starts at the projects folder.
    const developer = (await get("/projects/pick", alex.cookie)).body;
    expect(developer).toMatch(/Git repository<\/span><\/span><a class="k-row-t" href="[^"]+">shelf<\/a>/);
    expect(developer).not.toContain(">.hidden-repo<");
    expect(developer).not.toContain(">link-out<");
    // Never outside the home folder: a path spelled elsewhere starts at the projects folder.
    expect((await get(`/projects/pick?at=${encodeURIComponent(join(dir, "elsewhere"))}`, alex.cookie)).body).not.toContain("far-repo");
    // Pick → add: the repository's page offers the add, with a password field outside the projects folder.
    const chosen = (await get(`/projects/pick?at=${encodeURIComponent(outside())}`, alex.cookie)).body;
    expect(chosen).toContain("outside your projects folder, so Toolroll asks for your password");
    expect(chosen).toMatch(/<input class="k-input" id="pick-password" type="password" name="password"/);
    const added = await post("/projects/open", alex, { path: outside(), via: "path", password: passwords["alex"]!, return: "/projects" });
    expect(added.status).toBe(303);
    expect(store.listProjects().map(one => one.path)).toContain(outside());
    expect(existsSync(registry) && readFileSync(registry, "utf8")).toContain("outside-repo");
  });

  test("never opens a hidden folder, however the address names it", async () => {
    mkdirSync(join(home, ".secret", "inner-thing"), { recursive: true });
    const alex = await login("alex");
    for (const at of ["~/.secret", join(home, ".secret"), join(home, "Developer", "..", ".secret"), join(home, "Developer", ".hidden-repo")]) {
      const page = (await get(`/projects/pick?at=${encodeURIComponent(at)}`, alex.cookie)).body;
      expect(page, at).not.toContain("inner-thing");
      expect(page, at).toContain("couldn&#39;t be read");
    }
  });
});

describe("identity, not spelling; absent and unreadable folders fail closed", () => {
  const caseInsensitive = (): boolean => existsSync(join(dir, "HOME"));
  const at = (real: string, chain: string[]): FolderIdentity => ({ kind: "found", real, dir: true, uid: 501, chain });
  const homeId = at("/Users/alex", ["1:20", "1:10", "1:2"]);
  const facts = (over: Partial<FolderComparisons> = {}): FolderComparisons => ({ root: at("/", ["1:2"]), home: homeId, library: at("/Users/alex/Library", ["1:30", "1:20", "1:10", "1:2"]),
    protectedDirs: [at("/Users/alex/.config/toolroll", ["1:41", "1:40", "1:20", "1:10", "1:2"])], tops: [at("/Users", ["1:10", "1:2"]), at("/opt", ["1:50", "1:2"])], trees: [at("/usr", ["1:60", "1:2"])], ...over });

  test("aliases, firmlinks and hidden folders anywhere", () => {
    expect(folderRefusal("repo", at("/users/alex", ["1:20", "1:10", "1:2"]), facts())).toMatch(/home folder itself/);
    expect(folderRefusal("repo", at("/System/Volumes/Data/Users/alex", ["1:20", "1:10", "1:2"]), facts())).toMatch(/home folder itself/);
    expect(folderRefusal("repo", at("/USERS/ALEX/LIBRARY/x", ["1:31", "1:30", "1:20", "1:10", "1:2"]), facts())).toMatch(/Library/);
    expect(folderRefusal("repo", at("/Users/alex/.CONFIG/TOOLROLL/w", ["1:42", "1:41", "1:40", "1:20", "1:10", "1:2"]), facts())).toMatch(/Toolroll/);
    expect(folderRefusal("repo", at("/opt/alex/.secret", ["1:53", "1:52", "1:50", "1:2"]), facts())).toMatch(/hidden folder/);
    expect(folderRefusal("repo", at("/Users/alex/.dotfiles", ["1:70", "1:20", "1:10", "1:2"]), facts())).toMatch(/hidden folder/);
    expect(folderRefusal("repo", at("/usr/local/x", ["1:62", "1:61", "1:60", "1:2"]), facts())).toMatch(/system folder/);
    expect(folderRefusal("repo", at("/opt/alex/work", ["1:54", "1:52", "1:50", "1:2"]), facts())).toBeNull();
    expect(folderRefusal("repo", at("/Users/alex/Developer/x", ["1:81", "1:80", "1:20", "1:10", "1:2"]), facts())).toBeNull();
  });

  test("a Toolroll folder not made yet excludes by its path (any case); one unreadable, or an unreadable home or ~/Library, refuses", () => {
    const pool: FolderSeen = { kind: "missing", path: "/Users/alex/work/pool/worktrees" };
    const withPool = facts({ protectedDirs: [pool] });
    expect(folderRefusal("repo", at("/Users/alex/work", ["1:90", "1:20", "1:10", "1:2"]), withPool)).toMatch(/Toolroll/);
    expect(folderRefusal("repo", at("/Users/alex/WORK/Pool/worktrees/x", ["1:93", "1:92", "1:91", "1:90", "1:20", "1:10", "1:2"]), withPool)).toMatch(/Toolroll/);
    expect(folderRefusal("repo", at("/Users/alex/Developer/x", ["1:81", "1:80", "1:20", "1:10", "1:2"]), withPool)).toBeNull();
    const fine = at("/Users/alex/Developer/x", ["1:81", "1:80", "1:20", "1:10", "1:2"]);
    expect(folderRefusal("repo", fine, facts({ protectedDirs: [{ kind: "unreadable" }] }))).toMatch(/couldn’t check/);
    expect(folderRefusal("repo", fine, facts({ home: { kind: "unreadable" } }))).toMatch(/couldn’t check/);
    expect(folderRefusal("repo", fine, facts({ library: { kind: "unreadable" } }))).toMatch(/couldn’t check/);
    expect(folderRefusal("repo", at("/Users/alex/Library/x", ["1:99", "1:30", "1:20", "1:10", "1:2"]), facts({ library: { kind: "missing", path: "/Users/alex/Library" } }))).toMatch(/Library/);
  });

  test("the look reads every folder up to the top with bigint identities, and a short chain is unreadable", async () => {
    const looked = await folderFacts("/usr", [join(home, "nowhere", "pool")]);
    expect(looked.ok).toBe(true);
    if (!looked.ok || looked.value.target.kind !== "found") throw new Error("no answer");
    const usr = statSync("/usr", { bigint: true });
    expect(looked.value.target.chain).toEqual([`${usr.dev}:${usr.ino}`, `${statSync("/", { bigint: true }).dev}:${statSync("/", { bigint: true }).ino}`]);
    expect(looked.value.compare[0]).toEqual({ kind: "missing", path: join(home, "nowhere", "pool") });
    // A child that answers with a chain shorter than its path: taken as unreadable, never as found.
    const short = await folderFacts(join(home, "Developer"), [], { runner: () => ({ answer: Promise.resolve({ ok: true, value: { target: { kind: "found", real: join(home, "Developer"), dir: true, uid: 1, chain: ["1:2"] }, compare: [] } }), ended: Promise.resolve() }) });
    expect(short.ok && short.value.target.kind).toBe("unreadable");
  });

  test("a case alias of Toolroll's checkouts, or of a hidden repository, is refused as them", async () => {
    if (!caseInsensitive()) return; // a case-sensitive disk has no aliases to try
    const alex = await login("alex");
    gitInit(join(state, "worktrees", "task-2"));
    expect((await post("/projects/open", alex, { path: join(home, "TOOLROLL-STATE", "worktrees", "task-2"), via: "path", password: passwords["alex"]! })).body).toContain("Toolroll’s own");
    expect((await post("/projects/open", alex, { path: join(dir, "HOME", "developer", ".HIDDEN-REPO"), via: "path", password: passwords["alex"]! })).body).toContain("hidden folder");
    // An alias of an ordinary one is added under its own name.
    expect((await post("/projects/open", alex, { path: "~/CODE/outside-repo", via: "path", password: passwords["alex"]!, return: "/projects" })).status).toBe(303);
    expect(store.listProjects().map(one => one.path)).toEqual([outside()]);
  });
});

describe("slow drives and proofs", () => {
  test("a folder that doesn't answer never holds the console: the picker and the add say so in time, and nothing is added", async () => {
    await close();
    const stuck: FolderLookRunner = (request, deadline) => request.op === "folder" ? { answer: new Promise(() => {}), ended: new Promise(() => {}) } : childLook(request, deadline);
    await boot(undefined, { folderLook: stuck, folderLookMs: 300 });
    const alex = await login("alex");
    const started = Date.now();
    expect((await get("/projects/pick", alex.cookie)).body).toContain("didn&#39;t answer");
    const answer = await post("/projects/open", alex, { path: outside(), via: "path", password: passwords["alex"]! });
    expect(answer.body).toContain("didn&#39;t answer");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(store.listProjects()).toEqual([]);
    // And the addition's folder checks read nothing on the console's own thread.
    const source = readFileSync(new URL("./pages.ts", import.meta.url), "utf8");
    const section = source.slice(source.indexOf("// ---- Adding a repository: the picker"), source.indexOf("return { registrations, projectsScreen };"));
    expect(section.length).toBeGreaterThan(1000);
    expect(section).not.toMatch(/\b(statSync|realpathSync|existsSync|readdirSync|lstatSync)\(/);
  });

  test("only a password typed now: Passwordless, a remembered password and a provider re-check never add from outside", async () => {
    const alex = await login("alex");
    setPasswordless(store, true, "alex", new Date());
    expect((await post("/projects/open", alex, { path: "~/code/outside-repo", via: "path", password: "" })).body).toContain("To add it anyway, enter your Toolroll password");
    expect(store.listProjects()).toEqual([]);
    const now = Date.now();
    const facts: FreshFacts = { actor: "alex", local: true, allowlisted: true, live: () => true, passwordAt: () => now - 1_000, ssoReauthAt: () => null,
      ssoNow: () => now - 1_000, consumeSsoNow: () => () => {}, floor: () => 0, stamp: () => {} };
    setPasswordless(store, false, "alex", new Date());
    const sso = freshFacts.run(facts, () => proveAccountNow(store, "alex", "", { credential: true }));
    expect(sso).toMatchObject({ ok: true, method: "sso-now" });
    expect(typedPasswordNow(sso)).toBe(false);
    const remembered = freshFacts.run({ ...facts, ssoNow: () => null }, () => withFreshness("approve-standard", () => proveAccountNow(store, "alex", "")));
    expect(remembered).toMatchObject({ ok: true, method: "fresh-password" });
    expect(typedPasswordNow(remembered)).toBe(false);
    expect(typedPasswordNow(proveAccountNow(store, "alex", passwords["alex"]!))).toBe(true);
  });

  test("a browser mutation key is required where the console asks for one", async () => {
    await close();
    await boot(undefined, { browserKey: true });
    const alex = await login("alex");
    const answer = await post("/projects/open", alex, { path: outside(), via: "path", password: passwords["alex"]! });
    expect(answer.status).not.toBe(303);
    expect(store.listProjects()).toEqual([]);
  });
});

describe("a laptop's local owner", () => {
  test("never adds a repository from outside the projects folder", async () => {
    const world = await openLocalWorld();
    try {
      const other = join(world.root, "elsewhere-repo");
      gitInit(other);
      const { cookie, csrf } = await world.localSession();
      const added = await world.post("/projects/open", cookie, { csrf, path: other, via: "path", password: "anything-at-all" });
      expect(added.status).toBe(403);
      expect(added.body).toContain("only an approver signed in with a password");
      expect(world.store.listProjects().map(one => one.path)).not.toContain(other);
    } finally {
      await world.close();
    }
  }, LOCAL_WORLD_SETUP_MS);
});
