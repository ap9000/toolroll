/**
 * Launch folders under every root (agent-fence.ts runRoots): the system temp folder, and on a Mac the short shared one
 * a check's launch folder is made in. Each fence form denies another launch's folder under both; the shared root is
 * never listed, and a link planted among a root's entries is never followed.
 */
import { argsOnlySeccomp } from "../test/seccomp-fixture.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { agentFence, codexFenceArgv, linuxFenced, macosFenceAvailable, macosFenceProfile, NO_GRANTS, runFolders, type RunFolders } from "./agent-fence.js";
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
  const mac = macosFenceProfile([], { ...NO_GRANTS, runFolders: folders });
  for (const at of [root, shared]) expect(mac).toContain(`(regex #"^${at.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(so-tools-|so-codex-|so-net-|so-cmd-)")`);
  const codex = codexFenceArgv([], false, { ...NO_GRANTS, runFolders: folders }).join(" ");
  for (const at of [root, shared]) expect(codex).toContain(join(at, "so-cmd-*"));
  // Linux: a grant inside another launch's folder under either root is dropped.
  mkdirSync(sibling);
  writeFileSync(join(sibling, "f"), "x");
  mkdirSync(join(root, "so-cmd-other"));
  writeFileSync(join(root, "so-cmd-other", "f"), "x");
  const { args } = linuxFenced("/bin/true", [], [], { ...NO_GRANTS, seccomp: argsOnlySeccomp(), readable: [join(sibling, "f"), join(root, "so-cmd-other", "f")], runFolders: folders });
  expect(args).not.toContain(join(sibling, "f"));
  expect(args).not.toContain(join(root, "so-cmd-other", "f"));
});

test("the shared root is never listed; a link planted among the system root's entries is never followed or fenced", () => {
  mkdirSync(join(shared, "so-cmd-theirs"));
  mkdirSync(join(root, "so-cmd-real"));
  mkdirSync(join(dir, "elsewhere"));
  symlinkSync(join(dir, "elsewhere"), join(root, "so-cmd-planted"));
  const fence = agentFence({ databaseFile: null, worktree: null, home: join(dir, "home"), runFolders: folders });
  expect(fence).toContain(join(root, "so-cmd-real"));
  expect(fence).not.toContain(join(root, "so-cmd-planted"));
  expect(fence).not.toContain(join(dir, "elsewhere"));
  expect(fence.some(path => path.startsWith(shared))).toBe(false);
  // The system's own roots: on a Mac the short shared one comes with them; a root a caller names brings none.
  expect(runFolders(null, root).also).toBeUndefined();
  if (process.platform === "darwin") expect(runFolders(null).also).toEqual(["/private/tmp"]);
});

test.skipIf(INSIDE_FENCE || !macosFenceAvailable())("the real sandbox: another launch's folder under the shared root is refused, read and write", () => {
  const theirs = realpathSync(mkdtempSync(join("/private/tmp", "so-cmd-")));
  writeFileSync(join(theirs, "secret"), "x");
  try {
    const own = realpathSync(mkdtempSync(join("/private/tmp", "so-cmd-")));
    const profile = macosFenceProfile([], { ...NO_GRANTS, runFolders: { ...runFolders(own), own } });
    const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c",
      `cat ${theirs}/secret >/dev/null 2>&1 && echo read || echo read-refused; echo y > ${theirs}/planted 2>/dev/null && echo wrote || echo write-refused; echo z > ${own}/mine && echo own-ok`], { encoding: "utf8" });
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
