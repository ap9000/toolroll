/** A workspace build's terms for the sandbox runtime (agent-fence.ts srtTermsOf): exactly its allowlist written (with the
 * runtime's own temp and log paths), its fence and read-only grants never; and a grant never made through a link. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { grantFolder, linuxFenceAvailable, macosFenceAvailable, NO_GRANTS, sandboxedSpawn, srtTermsOf, type FenceGrants } from "./agent-fence.js";

test("a workspace build writes its allowlist and the runtime's own paths; its fence and read-only grants are never written", () => {
  const grants: FenceGrants = { ...NO_GRANTS, readOnly: ["/work/repo/.git/objects/info"], writes: { subpaths: ["/work/task", "/work/repo/.git/objects"], prefixes: [{ path: "/work/repo/.git/packed-refs", suffix: "([.~][^/]*)?$" }] } };
  const terms = srtTermsOf(["/state"], grants);
  expect(terms.writeConfig.allowOnly).toEqual(expect.arrayContaining(["/work/task", "/work/repo/.git/objects", "/work/repo/.git/packed-refs*", "/tmp/claude"]));
  expect(terms.writeConfig.allowOnly).not.toContain("/");
  expect(terms.writeConfig.denyWithinAllow).toEqual(expect.arrayContaining(["/state", "/work/repo/.git/objects/info"]));
  expect(terms.readConfig.denyOnly).toContain("/state");
  // Writing anywhere (an approver's choice): everything but the denies.
  expect(srtTermsOf(["/state"], NO_GRANTS).writeConfig).toMatchObject({ allowOnly: ["/"], denyWithinAllow: ["/state"] });
});

test("a grant is never made through a link of this user's, at the folder or anywhere above it", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-grant-")));
  try {
    const target = join(dir, "LaunchAgents");
    mkdirSync(target);
    symlinkSync(target, join(dir, "linked"));
    expect(grantFolder(join(dir, "linked"))).toBeNull();
    expect(grantFolder(join(dir, "linked", "cache"))).toBeNull();
    expect(grantFolder(join(dir, "real", "cache"))).toBe(join(dir, "real", "cache"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A name only the system's resolver answers (localhost comes from the hosts file without it); null when offline. */
const lookup = (wrap?: { file: string; args: string[]; env: Record<string, string> }) => {
  const script = "require('node:dns').lookup('github.com', error => process.stdout.write(error ? 'error ' + error.code : 'found'))";
  return wrap === undefined ? spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 }).stdout
    : spawnSync(wrap.file, wrap.args, { encoding: "utf8", timeout: 30_000, env: { ...process.env, ...wrap.env } }).stdout;
};
const online = macosFenceAvailable() && lookup() === "found";

test.skipIf(!online)("on macOS a workspace build with an open network resolves a host name", () => {
  const work = realpathSync(mkdtempSync(join("/tmp", "so-dns-")));
  try {
    const script = "require('node:dns').lookup('github.com', error => process.stdout.write(error ? 'error ' + error.code : 'found'))";
    expect(lookup(sandboxedSpawn(process.execPath, ["-e", script], [join(work, "denied")], { ...NO_GRANTS, writes: { subpaths: [work], prefixes: [] } }, work))).toBe("found");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("the handoff's protected names: the sandbox runtime's dangerous files and folders, and what it can't hold once a launch has started", async () => {
  const { protectedChanges } = await import("./agent-fence.js");
  const { DANGEROUS_FILES, getDangerousDirectories } = await import("@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js");
  // A superset of the runtime's own lists.
  for (const name of DANGEROUS_FILES) expect(protectedChanges([`pkg/${name}`]), name).toEqual([`pkg/${name}`]);
  for (const dir of getDangerousDirectories()) expect(protectedChanges([`pkg/${dir}/x`]), dir).toEqual([`pkg/${dir}/x`]);
  expect(protectedChanges(["src/a.ts", ".mcp.json", "packages/x/.vscode/tasks.json", "lib/.git/hooks/x", "a/.Envrc", "b/.npmrc", ".yarnrc.yml", ".claude/settings.local.json", "README.md"]))
    .toEqual([".mcp.json", "packages/x/.vscode/tasks.json", "lib/.git/hooks/x", "a/.Envrc", "b/.npmrc", ".yarnrc.yml", ".claude/settings.local.json"]);
  expect(protectedChanges(["docs/vscode.md", "src/mcp.json.ts"])).toEqual([]);
});

test("native: a build can't rewrite the code that fences it: Toolroll's install, the sandbox runtime, its launch helper, the Node running it", async ctx => {
  ctx.skip(!(macosFenceAvailable() || linuxFenceAvailable()), "no sandbox here");
  const { fenceFor, runFolders, toolrollInstall, sandboxLaunchHelperPath } = await import("./agent-fence.js").then(async m => ({ ...m, sandboxLaunchHelperPath: (await import("./sandbox-runtime.js")).sandboxLaunchHelper }));
  const { createRequire } = await import("node:module");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-install-")));
  try {
    const launch = fenceFor("command", { databaseFile: null, worktree: null, home: join(dir, "home"), boundary: null, binding: null, runFolders: runFolders(null), poolRoots: [] });
    const runtime = join(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime"), "..", "..");
    const targets = [join(import.meta.dirname, "..", "package.json"), join(runtime, "package.json"), sandboxLaunchHelperPath(), process.execPath].map(path => realpathSync(path));
    // Each is held read-only (one the user doesn't own, a system Node, is out of a build's reach already).
    const { statSync } = await import("node:fs");
    for (const path of targets) if (statSync(path).uid === process.getuid?.()) expect(launch.fenceGrants.readOnly.some(one => path === one || path.startsWith(`${one}/`)), path).toBe(true);
    expect(toolrollInstall(null, join(dir, "home")).length).toBeGreaterThan(0);
    const probe = targets.map(path => `(: >> ${JSON.stringify(path)}) 2>/dev/null && echo written || echo denied`).join("\n");
    const wrapped = sandboxedSpawn("/bin/sh", ["-c", probe], [join(dir, "fenced")], launch.fenceGrants, dir);
    const result = spawnSync(wrapped.file, wrapped.args, { encoding: "utf8", cwd: dir, env: { ...process.env, ...wrapped.env } });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual(targets.map(() => "denied"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a build of Toolroll's own source, run from it, can still commit: the install that is its repository isn't held", async () => {
  const { toolrollInstall } = await import("./agent-fence.js");
  const install = realpathSync(join(import.meta.dirname, ".."));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "so-home-")));
  try {
    expect(toolrollInstall(null, outside)).toContain(install);
    expect(toolrollInstall(null, outside, install)).not.toContain(install);
  } finally { rmSync(outside, { recursive: true, force: true }); }
});
