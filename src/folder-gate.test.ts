/**
 * The folder gate (folder-gate.ts), and the rules it serves:
 * - availability never decides authorization: a folder the gate holds back is unavailable, and every authorization
 *   caller denies it, never matching it by its spelling;
 * - the gate holds only the console's own work (its scope), never work started outside it (a worker in the same
 *   process), and a held-back git read keeps its caller's refusal shape;
 * - a path a checkout's own files name (`.git`, `commondir`) is checked before anything there is opened;
 * - nothing in Toolroll walks the filesystem from "/" or into /Volumes (src/server/console-folder-hang.test.ts proves the
 *   console's pages and background pass at runtime).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { folderAnswers, FolderUnavailable, inFolderScope, insideFolder } from "./folder-gate.js";
import { canonicalProject } from "./project.js";
import { projectAccessAllows } from "./project-access.js";
import { checkoutGit, checkoutIncludes } from "./teardown-git.js";
import { channelRepos } from "./chat-channel.js";
import { fileTaskProposal } from "./proposal.js";
import { RecipeError, savedRecipes } from "./recipes.js";
import { normalizeProjectAccess } from "./project-access.js";
import type { Store } from "./store.js";

let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "so-gate-"))); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("outside a console's scope every read goes ahead, work started there included; inside, the gate decides", async () => {
  const deny = (path: string) => !path.startsWith("/Volumes");
  expect(folderAnswers("/Volumes/Drive")).toBe(true);
  let later: Promise<boolean> = Promise.resolve(true);
  // A worker loop started before (outside) the scope stays outside it, even in the console's process.
  const outside = new Promise<boolean>(done => setTimeout(() => done(folderAnswers("/Volumes/Drive")), 5));
  inFolderScope(deny, () => {
    expect([folderAnswers("/projects/one"), folderAnswers("/Volumes/Drive")]).toEqual([true, false]);
    later = new Promise(done => setTimeout(() => done(folderAnswers("/Volumes/Drive")), 5));
  });
  expect(await later).toBe(false);
  expect(await outside).toBe(true);
  expect(folderAnswers("/Volumes/Drive")).toBe(true);
});

test("a held-back canonicalization is unavailable, never 'not a folder': it throws, and nothing falls back to the spelling", () => {
  mkdirSync(join(base, "outside"));
  symlinkSync(join(base, "outside"), join(base, "granted"));
  const granted = join(base, "granted");
  const none = () => false;
  expect(canonicalProject(granted)).toBe(join(base, "outside"));
  expect(() => inFolderScope(none, () => canonicalProject(granted))).toThrow(FolderUnavailable);
  // Authorization callers deny: a grant whose spelling matches but which leads elsewhere, and an exact one, alike.
  for (const [access, repo, open] of [[[granted], granted, false], [[join(base, "outside")], join(base, "outside"), true]] as const) {
    expect(projectAccessAllows(access, repo), repo).toBe(open);
    expect(inFolderScope(none, () => projectAccessAllows(access, repo)), `${repo} held back`).toBe(false);
  }
  // Instance access reads no folder and stands.
  expect(inFolderScope(none, () => projectAccessAllows(null, granted))).toBe(true);
});

test.each([
  ["a project-limited account's access", (repo: string) => { expect(projectAccessAllows([repo], repo)).toBe(false); }],
  ["granting access to a project", (repo: string) => { expect(() => normalizeProjectAccess([repo])).toThrow(FolderUnavailable); }],
  ["a chat channel's projects", (repo: string) => { expect(channelRepos({ accountCanAccess: () => true } as unknown as Store, "alex", [repo])).toEqual([]); }],
  ["filing into a project", (repo: string) => {
    const store = { createConsoleTask: () => { throw new Error("nothing is filed"); } } as unknown as Store;
    expect(fileTaskProposal(store, { title: "one", repo, filedVia: "cli" } as never, new Date())).toMatchObject({ ok: false, reason: "bad-repo" });
  }],
  ["a project's saved recipes", (repo: string) => {
    let thrown: unknown = null;
    try { savedRecipes({} as Store, "alex", repo); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(RecipeError);
    expect((thrown as RecipeError).status).toBe(503);
  }],
])("held back by the gate, %s is denied, never decided by the path's spelling", (_, check) => {
  mkdirSync(join(base, "project"));
  inFolderScope(() => false, () => check(join(base, "project")));
});

test("a checkout's commondir naming a folder that doesn't answer is never opened: the checkout is refused, as git reads it", () => {
  const repo = join(base, "repo"), admin = join(base, "admin"), hung = join(base, "hung", ".git");
  mkdirSync(repo); mkdirSync(admin); mkdirSync(hung, { recursive: true });
  writeFileSync(join(repo, ".git"), `gitdir: ${admin}\n`);
  writeFileSync(join(admin, "commondir"), `${hung}\n`);
  // A plain config: read, it includes nothing.
  writeFileSync(join(hung, "config"), "[core]\n\tbare = false\n");
  expect(checkoutIncludes(repo)).toBe(false);
  const asked: string[] = [];
  const gate = (path: string, pointer: boolean) => { asked.push(`${pointer ? "pointer " : ""}${path}`); return !insideFolder(path, join(base, "hung")); };
  expect(inFolderScope(gate, () => checkoutIncludes(repo))).toBe(true);
  expect(asked).toContain(`pointer ${hung}`);
});

test("a held-back git read keeps its refusal shape: checkoutGit answers a refusal, it doesn't throw", async () => {
  const ran = await inFolderScope(() => false, () => checkoutGit(async () => { throw new Error("git must not run"); })("git", ["status"], { cwd: join(base, "repo") }));
  expect(ran.code).not.toBe(0);
  expect(ran.stderr).toContain("didn't answer");
});

/** A directory read, a mount's statistics, or a folder opened, whose argument is "/" or names /Volumes (a literal, or
 * the root spelled through a path helper), however the call is laid out over lines. */
const ROOT_WALK = /\b(readdirSync|opendirSync|statfsSync|readdir|opendir|statfs|scandir)\s*\(\s*(?:["'`]\/(?:Volumes\b[^"'`]*)?["'`]|(?:join|resolve)\(\s*["'`]\/["'`]\s*[,)]|["'`]\/Volumes)/g;

test("no source file walks \"/\" or /Volumes", () => {
  const root = import.meta.dirname;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.(ts|mts|js|mjs)$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue;
      const text = readFileSync(path, "utf8");
      for (const found of text.matchAll(ROOT_WALK)) offenders.push(`${relative(root, path)}:${text.slice(0, found.index).split("\n").length}: ${found[0]}`);
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
  // The rule itself catches what it is for, on one line or several.
  const caught = (code: string) => [...code.matchAll(ROOT_WALK)].length > 0;
  for (const bad of ['readdirSync("/")', "readdirSync('/Volumes')", "opendirSync(`/Volumes/${drive}`)", 'statfsSync("/Volumes/DataDrive")', 'readdirSync(join("/", name))', "await readdir('/')",
    'readdirSync(\n  "/Volumes",\n)', "opendirSync(\n\t'/'\n)"]) expect(caught(bad), bad).toBe(true);
  for (const fine of ['readdirSync(folder)', 'readdirSync("/proc")', 'const fenced = ["/Volumes", "/Network"]']) expect(caught(fine), fine).toBe(false);
});
