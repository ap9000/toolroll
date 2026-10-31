/**
 * Reads of a person's folders never hold the console (folder-look.ts): a look that doesn't answer is cut off at its
 * deadline, identical looks share one child and every look holds a slot until its process is gone, files are read
 * bounded, and a look stays out of other drives and ~/Library except inside the very root the person chose there.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_LOOK_CHILDREN, folderLooksRunning, listFolder, localOrigins, lookFolders, lookIdentities, lookProjectMcp, type FolderLookRunner } from "./folder-look.js";

let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "so-folder-look-"))); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A look whose process never answers until `end` is called. */
function stuckRunner(): { runner: FolderLookRunner; started: () => number; end: () => void } {
  let started = 0;
  const ends: (() => void)[] = [];
  return {
    runner: () => { started++; return { answer: new Promise(() => {}), ended: new Promise<void>(done => ends.push(done)) }; },
    started: () => started,
    end: () => { for (const one of ends.splice(0)) one(); },
  };
}

describe("a folder that doesn't answer", () => {
  test("is cut off at the deadline; eight callers at once, however they spell it, share one child until it ends", async () => {
    const stuck = stuckRunner();
    const at = Date.now();
    const spellings = [join(base, "stuck"), `${base}/./stuck`, `${base}/x/../stuck`, `${join(base, "stuck")}/`];
    const answers = await Promise.all(Array.from({ length: 8 }, (_, n) => lookFolders({ op: "identities", paths: [spellings[n % 4]!] }, { runner: stuck.runner, deadlineMs: 150 })));
    expect(answers).toEqual(Array(8).fill({ ok: false, why: "no-answer" }));
    expect(Date.now() - at).toBeLessThan(1_500);
    expect(stuck.started()).toBe(1);
    // Asked again while that child is still stuck: answered at once, nothing new started.
    expect(await lookFolders({ op: "identities", paths: [spellings[0]!] }, { runner: stuck.runner, deadlineMs: 150 })).toEqual({ ok: false, why: "no-answer" });
    expect(stuck.started()).toBe(1);
    stuck.end();
    await new Promise(done => setTimeout(done, 0));
    expect(folderLooksRunning()).toBe(0);
  });

  test("stuck children hold their slots: past the limit nothing more starts until one ends", async () => {
    const stuck = stuckRunner();
    for (let n = 0; n < FOLDER_LOOK_CHILDREN; n++) await lookFolders({ op: "identities", paths: [join(base, `held-${n}`)] }, { runner: stuck.runner, deadlineMs: 20 });
    expect(stuck.started()).toBe(FOLDER_LOOK_CHILDREN);
    expect(await lookFolders({ op: "identities", paths: [join(base, "one-more")] }, { runner: stuck.runner, deadlineMs: 20 })).toEqual({ ok: false, why: "no-answer" });
    expect(stuck.started()).toBe(FOLDER_LOOK_CHILDREN);
    stuck.end();
    await new Promise(done => setTimeout(done, 0));
    expect(folderLooksRunning()).toBe(0);
  });
});

describe("what a look reads", () => {
  test("a folder's sub-folders inside the root: no links out, no dotfiles, no ~/Library, git ones marked", async () => {
    const home = join(base, "home");
    const outside = join(base, "outside");
    for (const one of [join(home, "code", ".git"), join(home, "notes"), join(home, ".hidden"), join(home, "Library", "Mail"), outside]) mkdirSync(one, { recursive: true });
    symlinkSync(outside, join(home, "escape-hatch"));
    const listed = await listFolder(home, [home], { home });
    expect(listed.ok && [...listed.value.entries].sort((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: "code", path: join(home, "code"), git: true }, { name: "notes", path: join(home, "notes"), git: false }]);
    expect(await listFolder(outside, [home], { home })).toEqual({ ok: true, value: { at: null, entries: [] } });
    const root = await listFolder("/", ["/"], { home });
    expect(root.ok && root.value.entries.some(one => one.path === "/Volumes" || one.path.startsWith("/Volumes/"))).toBe(false);
  });

  test("a root chosen inside ~/Library opens that root only, never the rest of ~/Library", async () => {
    const home = join(base, "home");
    for (const one of [join(home, "Library", "Keychains"), join(home, "Library", "Allowed", "repo")]) mkdirSync(one, { recursive: true });
    const roots = [home, join(home, "Library", "Allowed")];
    expect(await listFolder(join(home, "Library", "Keychains"), roots, { home })).toEqual({ ok: true, value: { at: null, entries: [] } });
    expect(await listFolder(join(home, "Library"), roots, { home })).toEqual({ ok: true, value: { at: null, entries: [] } });
    const allowed = await listFolder(join(home, "Library", "Allowed"), roots, { home });
    expect(allowed.ok && allowed.value.entries.map(one => one.name)).toEqual(["repo"]);
  });

  test("origins come from each repository's own config only: no link, no FIFO, nothing oversized is read", async () => {
    const plain = join(base, "plain"), linked = join(base, "linked"), fifo = join(base, "fifo"), huge = join(base, "huge");
    for (const one of [plain, linked, fifo, huge]) mkdirSync(join(one, ".git"), { recursive: true });
    writeFileSync(join(plain, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/plain.git\n');
    writeFileSync(join(base, "elsewhere"), '[remote "origin"]\n\turl = git@github.com:acme/elsewhere.git\n');
    symlinkSync(join(base, "elsewhere"), join(linked, ".git", "config"));
    execFileSync("mkfifo", [join(fifo, ".git", "config")]);
    writeFileSync(join(huge, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/huge.git\n');
    truncateSync(join(huge, ".git", "config"), 64 * 1024 * 1024);
    const at = Date.now();
    const looked = await localOrigins([plain], [base], { home: join(base, "home") });
    expect(Date.now() - at).toBeLessThan(3_000);
    expect(looked.ok && looked.value.registered).toEqual([{ path: plain, url: "git@github.com:acme/plain.git" }]);
    expect(looked.ok && [...looked.value.found].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: fifo, url: null },
      { path: huge, url: null },
      { path: linked, url: null },
      { path: plain, url: "git@github.com:acme/plain.git" },
    ]);
  });

  test("identities: a folder's real path, null for what isn't one", async () => {
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "alias"));
    writeFileSync(join(base, "file"), "");
    const looked = await lookIdentities([join(base, "alias"), join(base, "file"), join(base, "missing")]);
    expect(looked.ok && Object.fromEntries(looked.value)).toEqual({ [join(base, "alias")]: join(base, "real"), [join(base, "file")]: null, [join(base, "missing")]: null });
  });

  test("a project's .mcp.json for the Tools page: parsed when a plain file, nothing from a FIFO or a link", async () => {
    const plain = join(base, "plain"), fifo = join(base, "fifo"), linked = join(base, "linked");
    for (const one of [plain, fifo, linked]) mkdirSync(one);
    writeFileSync(join(plain, ".mcp.json"), JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" } } }));
    execFileSync("mkfifo", [join(fifo, ".mcp.json")]);
    symlinkSync(join(plain, ".mcp.json"), join(linked, ".mcp.json"));
    expect(await lookProjectMcp(plain)).toEqual({ ok: true, value: { mcpServers: { notes: { command: "notes-mcp" } } } });
    expect(await lookProjectMcp(fifo)).toEqual({ ok: true, value: null });
    expect(await lookProjectMcp(linked)).toEqual({ ok: true, value: null });
  });
});
