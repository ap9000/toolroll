/**
 * Settings → Projects → Projects folder, the folder picker, and adding a repository from outside the projects folder,
 * over real HTTP on an `up`-style console (its machine registry, its own identities): who may, which folders are
 * refused and why, `~`, the live ceiling widened without a restart, the registry as the source of truth across a
 * restart, and the ledger. Its own HOME: the person's real folders are never read.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mintApiToken } from "../api-tokens.js";
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
  // The home folder: a projects folder to choose, a repository outside it, and what must never be offered or chosen.
  gitInit(join(home, "Developer", "shelf"));
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

async function boot(projectRoots: string[] = []): Promise<void> {
  const identities = projectIdentities();
  // As startConsole does after listening (consoleIdentitiesInBackground): the configured folders resolve off the thread.
  await identities.refresh(projectRoots);
  server = createDecisionServer({
    store, evidenceRoot: join(state, "evidence"), clock: () => new Date(), identities,
    upConsole: true, registryPath: registry, configDir: state, poolRoot: join(state, "worktrees"),
    admittedRepos: () => [], projectRoots,
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
const said = (location: string, key = "problem"): string => new URL(location, "http://x").searchParams.get(key) ?? "";
const roots = async (): Promise<string[]> => { const loaded = await loadProjectRegistry(registry); return "error" in loaded ? ["(error)"] : loaded.roots; };
const get = async (path: string, cookie: string) => { const answer = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" }); return { status: answer.status, body: await answer.text() }; };

describe("who may choose the projects folder", () => {
  test("only an instance operator, from a browser, with a password typed now; everyone else is refused and nothing is saved", async () => {
    const vera = await login("vera"), lim = await login("lim"), robin = await login("robin"), alex = await login("alex");
    for (const who of [vera, lim, robin]) {
      expect((await post("/settings/projects-folder", who, { path: "~/Developer", password: passwords["alex"]! })).status).toBe(403);
      expect((await get("/settings/projects-folder", who.cookie)).status).toBe(403);
      expect((await post("/settings/projects-folder/remove", who, { path: join(home, "Developer") })).status).toBe(403);
    }
    // A token never: the route admits browser sessions only.
    const token = await fetch(`${base}/settings/projects-folder`, { method: "POST", headers: { authorization: `Bearer ${actToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ path: "~/Developer", password: passwords["alex"]! }), redirect: "manual" });
    expect(token.status).toBe(403);
    // A forged form (no CSRF token, or another session's) changes nothing.
    expect((await post("/settings/projects-folder", { cookie: alex.cookie, csrf: "" }, { path: "~/Developer", password: passwords["alex"]! })).status).toBe(403);
    expect((await post("/settings/projects-folder", { cookie: alex.cookie, csrf: vera.csrf }, { path: "~/Developer", password: passwords["alex"]! })).status).toBe(403);
    // No password, a wrong one, or someone else's: refused in words.
    for (const password of ["", "not-it", passwords["robin"]!]) {
      const answer = await post("/settings/projects-folder", alex, { path: "~/Developer", password });
      expect(answer.status).toBe(303);
      expect(said(answer.location)).toContain("Enter your Toolroll password");
    }
    expect(await roots()).toEqual([]);
  });
});

describe("which folders it may be", () => {
  test("the home folder, what holds it, hidden folders, ~/Library, the system's folders, Toolroll's own and missing ones are refused by name", async () => {
    const alex = await login("alex");
    const cases: [string, RegExp][] = [
      ["~", /home folder itself/],
      [home, /home folder itself/],
      [dir, /holds your home folder/],
      ["/", /top of the disk/],
      ["~/Library/Things", /Library/],
      ["~/.secret", /Hidden folders/],
      ["~/Developer/.hidden-stuff", /Hidden folders/],
      ["~/toolroll-state", /Toolroll’s own/],
      ["/usr", /system folder/],
      ["~/nope", /isn't a folder/],
      ["~robin/x", /Only ~ for your own home folder/],
      ["Developer", /full path/],
    ];
    for (const [path, words] of cases) {
      const answer = await post("/settings/projects-folder", alex, { path, password: passwords["alex"]! });
      expect(answer.status, path).toBe(303);
      expect(said(answer.location), path).toMatch(words);
    }
    expect(await roots()).toEqual([]);
    expect(store.actionLedger({ repos: null, instance: true }).filter(one => one.action === "projects folder changed")).toEqual([]);
  });
});

describe("choosing it", () => {
  test("~ expands, the registry saves it, the live ceiling widens without a restart, a repository under it opens with no password, and the ledger says so", async () => {
    const alex = await login("alex");
    // Before: the folder is outside what this server may open, and the panel offers to choose it.
    const before = await post("/projects/open", alex, { path: "~/Developer/shelf", via: "path", return: "/projects" });
    expect(before.status).toBe(403);
    const chose = await post("/settings/projects-folder", alex, { path: "~/Developer", password: passwords["alex"]! });
    expect(chose.status).toBe(303);
    expect(said(chose.location, "said")).toContain("~/Developer is the projects folder");
    expect(await roots()).toEqual([join(home, "Developer")]);
    const ledger = store.actionLedger({ repos: null, instance: true }).filter(one => one.action === "projects folder changed");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ actor: "alex", outcome: "chosen", repo: null, detail: `none → ${join(home, "Developer")}` });
    // Live: no restart. A repository inside it opens through the exact-path field, `~` and all, with no password.
    const opened = await post("/projects/open", alex, { path: "~/Developer/shelf", via: "path", return: "/projects" });
    expect(opened.status).toBe(303);
    expect(opened.location).toBe("/projects");
    expect(store.listProjects().map(one => one.path)).toContain(join(home, "Developer", "shelf"));
    // Stopping using it narrows only: the project stays.
    const removed = await post("/settings/projects-folder/remove", alex, { path: join(home, "Developer") });
    expect(said(removed.location, "said")).toContain("Projects already added stay");
    expect(await roots()).toEqual([]);
    expect(store.listProjects().map(one => one.path)).toContain(join(home, "Developer", "shelf"));
    expect(store.actionLedger({ repos: null, instance: true }).filter(one => one.action === "projects folder changed").map(one => one.outcome).sort()).toEqual(["chosen", "removed"]);
  });

  test("a restart serves the saved folder from the registry alone (as `up` starts its console), with no flag", async () => {
    const alex = await login("alex");
    await post("/settings/projects-folder", alex, { path: "~/Developer", password: passwords["alex"]! });
    await close();
    // `up` reads the registry's folders at every start and hands them to its console (operate.ts runUpConsoleRole).
    await boot(await roots());
    const again = await login("alex");
    const opened = await post("/projects/open", again, { path: join(home, "Developer", "shelf"), via: "path", return: "/projects" });
    expect(opened.status).toBe(303);
    expect(store.listProjects().map(one => one.path)).toContain(join(home, "Developer", "shelf"));
  });
});

describe("adding a repository from outside the projects folder", () => {
  test("refused without a password typed now and for viewer, limited and token; with it, added at once and openable, with a ledger row", async () => {
    const vera = await login("vera"), lim = await login("lim"), alex = await login("alex");
    const outside = join(home, "code", "outside-repo");
    const words = async (answer: { body: string }) => answer.body;
    for (const who of [vera, lim]) {
      const answer = await post("/projects/open", who, { path: "~/code/outside-repo", via: "path", password: passwords[who === vera ? "vera" : "lim"]! });
      expect(answer.status).toBe(403);
    }
    const token = await fetch(`${base}/projects/open`, { method: "POST", headers: { authorization: `Bearer ${actToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ path: outside, via: "path", password: passwords["alex"]! }), redirect: "manual" });
    expect(token.status).toBe(403);
    // No password: the reason, in the panel, with what was typed kept.
    const bare = await post("/projects/open", alex, { path: "~/code/outside-repo", via: "path" });
    expect(bare.status).toBe(403);
    expect(await words(bare)).toContain("To add it anyway, enter your Toolroll password");
    expect(bare.body).toContain('value="~/code/outside-repo"');
    expect((await post("/projects/open", alex, { path: "~/code/outside-repo", via: "path", password: "wrong" })).body).toContain("That password didn");
    // A row's Open (no exact-path form) never adds from outside, whatever it carries.
    expect((await post("/projects/open", alex, { path: outside, password: passwords["alex"]! })).status).toBe(403);
    expect(store.listProjects()).toEqual([]);
    // Not a repository, and Toolroll's own folders: refused with the reason.
    expect((await post("/projects/open", alex, { path: "~/Documents/notes", via: "path", password: passwords["alex"]! })).body).toContain("not a git repository");
    gitInit(join(state, "worktrees", "task-1"));
    expect((await post("/projects/open", alex, { path: join(state, "worktrees", "task-1"), via: "path", password: passwords["alex"]! })).body).toContain("Toolroll’s own");
    // With the password: added, saved, live, and the session opens it at once.
    const added = await post("/projects/open", alex, { path: "~/code/outside-repo", via: "path", password: passwords["alex"]!, return: "/projects" });
    expect(added.status).toBe(303);
    expect(store.listProjects().map(one => one.path)).toEqual([outside]);
    const saved = await loadProjectRegistry(registry);
    expect("error" in saved ? [] : saved.repos).toEqual([outside]);
    expect(store.actionLedger({ repos: [outside] }).map(one => one.action)).toContain("project added from outside the projects folder");
    expect((await get(`/projects/outside-repo`, alex.cookie)).status).toBe(200);
    expect((await post("/projects/select", alex, { path: outside, return: "/projects" })).status).toBe(303);
  });
});

describe("the folder picker", () => {
  test("approvers only; lists the home folder's folders, repositories marked, without hidden, ~/Library, Toolroll's own or links out", async () => {
    const vera = await login("vera"), lim = await login("lim"), alex = await login("alex");
    expect((await get("/projects/pick", vera.cookie)).status).toBe(403);
    expect((await get("/projects/pick", lim.cookie)).status).toBe(403);
    const token = await fetch(`${base}/projects/pick`, { headers: { authorization: `Bearer ${actToken}` }, redirect: "manual" });
    expect(token.status).toBe(403);
    const top = (await get("/projects/pick", alex.cookie)).body;
    for (const shown of ["Developer", "Documents", "code"]) expect(top).toContain(`>${shown}</a>`);
    for (const hidden of [".secret", "Library", "toolroll-state"]) expect(top).not.toContain(`>${hidden}</a>`);
    const developer = (await get(`/projects/pick?at=${encodeURIComponent("~/Developer")}`, alex.cookie)).body;
    expect(developer).toMatch(/Git repository<\/span><\/span><a class="k-row-t" href="[^"]+">shelf<\/a>/);
    expect(developer).not.toContain(">.hidden-stuff<");
    expect(developer).not.toContain(">link-out<");
    // Never outside the home folder: a path spelled elsewhere starts at the home folder.
    expect((await get(`/projects/pick?at=${encodeURIComponent(join(dir, "elsewhere"))}`, alex.cookie)).body).not.toContain("far-repo");
    // Pick → add: the repository's page offers the add, with a password field outside the projects folder.
    const chosen = (await get(`/projects/pick?at=${encodeURIComponent(join(home, "code", "outside-repo"))}`, alex.cookie)).body;
    expect(chosen).toContain("outside your projects folder, so Toolroll asks for your password");
    expect(chosen).toMatch(/<input class="k-input" id="pick-password" type="password" name="password"/);
    const added = await post("/projects/open", alex, { path: join(home, "code", "outside-repo"), via: "path", password: passwords["alex"]!, return: "/projects" });
    expect(added.status).toBe(303);
    expect(store.listProjects().map(one => one.path)).toContain(join(home, "code", "outside-repo"));
    expect(existsSync(registry) && readFileSync(registry, "utf8")).toContain("outside-repo");
  });
});
