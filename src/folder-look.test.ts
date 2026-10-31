/**
 * Reads of a person's folders never hold the console (folder-look.ts): a look that doesn't answer is cut off at its
 * deadline, one stuck look per folder is the most there ever is, and a look stays out of other drives and ~/Library.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderAnswers, listFolder, localOrigins, lookFolders, type FolderLookRunner } from "./folder-look.js";

let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "so-folder-look-"))); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("a folder that doesn't answer", () => {
  test("is cut off at the deadline, and the same look isn't started again while the first is stuck", async () => {
    let started = 0;
    const never: FolderLookRunner = () => { started++; return new Promise(() => {}); };
    const at = Date.now();
    expect(await lookFolders({ op: "probe", path: join(base, "stuck") }, { runner: never, deadlineMs: 150 })).toEqual({ ok: false, why: "no-answer" });
    expect(Date.now() - at).toBeLessThan(1_500);
    expect(await lookFolders({ op: "probe", path: join(base, "stuck") }, { runner: never, deadlineMs: 150 })).toEqual({ ok: false, why: "no-answer" });
    expect(started).toBe(1);
  });

  test("a real blocking open in the look's child (a git config that is a FIFO nobody writes) answers within the bound", async () => {
    const repo = join(base, "held");
    mkdirSync(join(repo, ".git"), { recursive: true });
    execFileSync("mkfifo", [join(repo, ".git", "config")]);
    const at = Date.now();
    expect(await folderAnswers(repo, { deadlineMs: 600 })).toBe(false);
    expect(Date.now() - at).toBeLessThan(3_000);
  });
});

describe("what a look reads", () => {
  test("a folder's sub-folders inside the root: no links out, no dotfiles, no ~/Library, git ones marked", async () => {
    const home = join(base, "home");
    const outside = join(base, "outside");
    for (const one of [join(home, "code", ".git"), join(home, "notes"), join(home, ".hidden"), join(home, "Library", "Mail"), outside]) mkdirSync(one, { recursive: true });
    symlinkSync(outside, join(home, "escape-hatch"));
    const listed = await listFolder(home, [home], { home });
    expect(listed).toEqual({ ok: true, value: { at: home, entries: expect.arrayContaining([{ name: "code", path: join(home, "code"), git: true }, { name: "notes", path: join(home, "notes"), git: false }]) } });
    expect(listed.ok && listed.value.entries.map(one => one.name).sort()).toEqual(["code", "notes"]);
    // A path outside every root is answered as outside, and /Volumes is never entered from /.
    expect(await listFolder(outside, [home], { home })).toEqual({ ok: true, value: { at: null, entries: [] } });
    const root = await listFolder("/", ["/"], { home });
    expect(root.ok && root.value.entries.some(one => one.path === "/Volumes" || one.path.startsWith("/Volumes/"))).toBe(false);
  });

  test("origins come from each repository's own config, never through a link or from something that isn't a plain file", async () => {
    const plain = join(base, "plain"), linked = join(base, "linked"), fifo = join(base, "fifo");
    for (const one of [plain, linked, fifo]) mkdirSync(join(one, ".git"), { recursive: true });
    writeFileSync(join(plain, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/plain.git\n');
    writeFileSync(join(base, "elsewhere"), '[remote "origin"]\n\turl = git@github.com:acme/elsewhere.git\n');
    symlinkSync(join(base, "elsewhere"), join(linked, ".git", "config"));
    execFileSync("mkfifo", [join(fifo, ".git", "config")]);
    const looked = await localOrigins([plain], [base], { home: join(base, "home") });
    expect(looked.ok && looked.value.registered).toEqual([{ path: plain, url: "git@github.com:acme/plain.git" }]);
    expect(looked.ok && [...looked.value.found].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: fifo, url: null },
      { path: linked, url: null },
      { path: plain, url: "git@github.com:acme/plain.git" },
    ]);
  });
});
