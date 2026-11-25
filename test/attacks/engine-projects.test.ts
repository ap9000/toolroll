/**
 * The engine API's Projects read (GET /engine/projects, the Mac app's project list): the projects a person can see, and
 * the folder names of repositories on the server's disk they could add. Those names are the folder picker's, so only a
 * caller the picker admits ever gets them: an approver signed in through a browser or this computer's session, not
 * limited to listed projects. Every way around it gets `found: []` and `canAdd: false`: an API token (read or act), a
 * lead's token, a viewer, a project-limited approver. A project the caller can't see is absent, and the read writes
 * nothing: no project added, no folder touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openLocalWorld, LOCAL_T0, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { projectsSchema } from "../../src/contracts/engine-api.js";
import { mintApiToken } from "../../src/api-tokens.js";
import { addApprover, hashPassword } from "../../src/scope.js";
import { enrollOwnerPassword } from "../../src/store.js";

const PASSWORD = "a long enough password";
/** A repository's folder name nobody else uses, so a body that carries it anywhere is caught. */
const FOUND = "zz-found-repo";
let world: LocalWorld, folder = "", elsewhere = "", cookie = "", csrf = "";
const passwords: Record<string, string> = {};

beforeEach(async () => {
  world = await openLocalWorld(root => {
    // The projects folder, beside the world's own folders (Toolroll's folders are never offered).
    folder = `${root}-projects`; elsewhere = `${root}-elsewhere`;
    return { projectRoots: [folder] };
  });
  // The picker's look sees a repository by its .git folder; the one the owner adds is a real repository.
  for (const one of [join(folder, FOUND), elsewhere]) mkdirSync(join(one, ".git"), { recursive: true });
  mkdirSync(join(folder, "storefront"), { recursive: true });
  execFileSync("git", ["init", "-q", join(folder, "storefront")], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  expect(enrollOwnerPassword(world.store, "alex", hashPassword(PASSWORD), 1, LOCAL_T0)).toMatchObject({ ok: true });
  for (const name of ["vera", "lim"]) {
    const made = addApprover(world.store, name, new Date(), { name: "alex", token: PASSWORD });
    if (!made.ok) throw new Error(name);
    passwords[name] = made.token;
  }
  world.store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
  world.store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'lim'").run(JSON.stringify([world.repo]));
  // The local owner's session, as the Mac app holds it (local mode stays on with a password set).
  ({ cookie, csrf } = await world.localSession());
}, LOCAL_WORLD_SETUP_MS);
afterEach(async () => {
  await world.close();
  for (const one of [folder, elsewhere]) rmSync(one, { recursive: true, force: true });
});

const read = (headers: Record<string, string>) => world.send("/engine/projects", "GET", { accept: "application/json", ...headers });
const parsed = async (headers: Record<string, string>) => {
  const answer = await read(headers);
  expect(answer.status, answer.body).toBe(200);
  return projectsSchema.parse(JSON.parse(answer.body));
};
async function login(name: string): Promise<string> {
  const answer = await world.send("/login", "POST", { "content-type": "application/x-www-form-urlencoded", origin: world.origin }, new URLSearchParams({ name, token: passwords[name]! }).toString());
  const signedIn = [answer.headers["set-cookie"] ?? []].flat().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session=") && one !== "standing-orders_session=");
  if (signedIn === undefined) throw new Error(`${name} didn't sign in: ${answer.status}`);
  return signedIn;
}
function token(access: "read" | "act"): string {
  const minted = mintApiToken();
  world.store.createApiToken({ id: minted.id, account: "alex", name: access, secretHash: minted.hash, access, projects: null,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
  return minted.token;
}

describe("who gets folder names", () => {
  test("the local owner gets the repositories in the projects folder it could add, and canAdd", async () => {
    const owner = await parsed({ cookie });
    expect(owner.canAdd).toBe(true);
    expect(owner.found.map(one => one.name)).toEqual(["storefront", FOUND]);
  });

  test("an API token (read or act) and a lead's token never get a folder name", async () => {
    const lead = world.store.mintLeadCredential("alex", "alex", new Date()).token;
    for (const bearer of [token("read"), token("act")]) {
      const answer = await parsed({ authorization: `Bearer ${bearer}` });
      expect(answer).toMatchObject({ canAdd: false, found: [] });
      expect(answer.projects.map(one => one.path)).toContain(world.repo);
    }
    const leadAnswer = await read({ authorization: `Bearer ${lead}` });
    expect(leadAnswer.body).not.toContain(FOUND);
    if (leadAnswer.status === 200) expect(projectsSchema.parse(JSON.parse(leadAnswer.body))).toMatchObject({ canAdd: false, found: [] });
  });

  test("a viewer and a project-limited approver get found: [] and canAdd: false", async () => {
    for (const name of ["vera", "lim"]) {
      const answer = await read({ cookie: await login(name) });
      expect(answer.body, name).not.toContain(FOUND);
      expect(projectsSchema.parse(JSON.parse(answer.body)), name).toMatchObject({ canAdd: false, found: [] });
    }
  });
});

describe("what a caller sees", () => {
  test("a project the caller can't see is absent: one outside every projects folder, and for a limited approver one outside its list", async () => {
    // Work filed in a repository outside the console's reach: saved, never shown.
    const made = world.store.createConsoleTask({ id: "far", title: "far away", repo: elsewhere, goal: "x", acceptance: [{ id: "c1", statement: "x.", evidence: ["manual-review"] }], filedVia: "cli" }, new Date());
    expect(made.ok).toBe(true);
    // The owner adds a repository from the projects folder (the projects page's own form).
    const added = await world.post("/projects/open", cookie, { csrf, path: join(folder, "storefront"), via: "path", return: "/work" });
    expect(added.status, added.body).toBe(303);
    const owner = await parsed({ cookie });
    expect(owner.projects.map(one => one.path).sort()).toEqual([join(folder, "storefront"), world.repo].sort());
    expect(JSON.stringify(owner)).not.toContain(elsewhere);
    const limited = await parsed({ cookie: await login("lim") });
    expect(limited.projects).toEqual([{ name: "repo", path: world.repo }]);
  });

  test("the read writes nothing: no project added, no folder in the projects folder touched", async () => {
    const tree = () => readdirSync(folder, { recursive: true }).map(String).sort().map(one => `${one}:${lstatSync(join(folder, one)).mtimeMs}`);
    const before = { projects: JSON.stringify(world.store.listProjects()), tree: tree() };
    for (const headers of [{ cookie }, { authorization: `Bearer ${token("read")}` }]) await read(headers);
    expect(await read({ cookie })).toMatchObject({ status: 200 });
    expect({ projects: JSON.stringify(world.store.listProjects()), tree: tree() }).toEqual(before);
  });
});
