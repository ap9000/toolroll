/**
 * Launch folders under every root (agent-fence.ts runRoots): the system temp folder, and on a Mac the short shared one
 * a check's launch folder is made in. Each fence form denies another launch's folder under both; the shared root is
 * never listed, and a link planted among a root's entries is never followed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { agentFence, codexFenceArgv, macosFenceAvailable, NO_GRANTS, runFolders, sandboxedSpawn, srtTermsOf, type RunFolders } from "./agent-fence.js";
import { INSIDE_FENCE } from "../test/inside-fence.js";

let dir: string, root: string, shared: string, folders: RunFolders;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-roots-")));
  root = join(dir, "T");
  shared = join(dir, "shared");
  mkdirSync(root);
  mkdirSync(shared);
  mkdirSync(join(root, "so-cmd-own"));
  folders = { root, own: join(root, "so-cmd-own"), also: [shared] };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("every fence form denies another launch's folder under both roots", () => {
  const sibling = join(shared, "so-cmd-theirs");
  // The sandbox runtime: unread by pattern under both roots, this launch's own folder read again.
  const terms = srtTermsOf([], { ...NO_GRANTS, runFolders: folders });
  for (const at of [root, shared]) for (const prefix of ["so-tools-", "so-codex-", "so-net-", "so-cmd-"]) expect(terms.readConfig.denyOnly).toContain(join(at, `${prefix}*`));
  expect(terms.readConfig.allowWithinDeny).toContain(join(root, "so-cmd-own"));
  const codex = codexFenceArgv([], false, { ...NO_GRANTS, runFolders: folders }).join(" ");
  for (const at of [root, shared]) expect(codex).toContain(join(at, "so-cmd-*"));
  // Writes: every other launch's folder there now, under either root (never this launch's own).
  mkdirSync(sibling);
  mkdirSync(join(root, "so-cmd-other"));
  const now = srtTermsOf([], { ...NO_GRANTS, runFolders: folders }).writeConfig.denyWithinAllow;
  expect(now).toEqual(expect.arrayContaining([sibling, join(root, "so-cmd-other")]));
  expect(now).not.toContain(join(root, "so-cmd-own"));
});

test("a link planted among a root's entries is never followed or listed; nothing of another launch's is in the fence itself", () => {
  mkdirSync(join(shared, "so-cmd-theirs"));
  mkdirSync(join(root, "so-cmd-real"));
  mkdirSync(join(dir, "elsewhere"));
  symlinkSync(join(dir, "elsewhere"), join(root, "so-cmd-planted"));
  // Read by pattern, written by the folders there right before the launch (only where it writes anywhere).
  const fence = agentFence({ databaseFile: null, worktree: null, home: join(dir, "home"), runFolders: folders });
  expect(fence.some(path => path.startsWith(root) || path.startsWith(shared))).toBe(false);
  const writes = srtTermsOf([], { ...NO_GRANTS, runFolders: folders }).writeConfig.denyWithinAllow;
  expect(writes).toEqual(expect.arrayContaining([join(root, "so-cmd-real"), join(shared, "so-cmd-theirs")]));
  expect(writes).not.toContain(join(root, "so-cmd-planted"));
  expect(writes).not.toContain(join(dir, "elsewhere"));
  expect(srtTermsOf([], { ...NO_GRANTS, runFolders: folders, writes: { subpaths: [dir], prefixes: [] } }).writeConfig.denyWithinAllow).not.toContain(join(root, "so-cmd-real"));
  // The system's own roots: on a Mac the short shared one comes with them; a root a caller names brings none.
  expect(runFolders(null, root).also).toBeUndefined();
  if (process.platform === "darwin") expect(runFolders(null).also).toEqual(["/private/tmp"]);
});

test.skipIf(INSIDE_FENCE || !macosFenceAvailable())("the real sandbox: another launch's folder under the shared root is refused, read and write", () => {
  const theirs = realpathSync(mkdtempSync(join("/private/tmp", "so-cmd-")));
  writeFileSync(join(theirs, "secret"), "x");
  try {
    const own = realpathSync(mkdtempSync(join("/private/tmp", "so-cmd-")));
    const wrapped = sandboxedSpawn("/bin/sh", ["-c",
      `cat ${theirs}/secret >/dev/null 2>&1 && echo read || echo read-refused; echo y > ${theirs}/planted 2>/dev/null && echo wrote || echo write-refused; echo z > ${own}/mine && echo own-ok`], [], { ...NO_GRANTS, runFolders: { ...runFolders(own), own } });
    const result = spawnSync(wrapped.file, wrapped.args, { encoding: "utf8" });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual(["read-refused", "write-refused", "own-ok"]);
    rmSync(own, { recursive: true, force: true });
  } finally { rmSync(theirs, { recursive: true, force: true }); }
});

test.skipIf(INSIDE_FENCE || !macosFenceAvailable() || spawnSync("codex", ["--version"], { encoding: "utf8" }).error !== undefined)("the installed Codex sandbox: another launch's folder under the shared root is refused", () => {
  const theirs = realpathSync(mkdtempSync(join("/private/tmp", "so-cmd-")));
  writeFileSync(join(theirs, "secret"), "x");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "so-codex-")));
  try {
    const result = spawnSync("codex", ["sandbox", ...codexFenceArgv([], false, { ...NO_GRANTS, runFolders: runFolders(home) }), "-P", "standing-orders", "--", "/bin/sh", "-c",
      `cat ${theirs}/secret >/dev/null 2>&1 && echo read || echo read-refused`], { encoding: "utf8", env: { ...process.env, CODEX_HOME: home }, cwd: dir });
    expect(result.stdout.trim(), result.stderr).toBe("read-refused");
  } finally { rmSync(theirs, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
