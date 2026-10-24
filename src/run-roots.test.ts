/**
 * Launch folders under every root (agent-fence.ts runRoots): the system temp folder, and on a Mac the short shared one
 * a check's launch folder is made in. Each fence form denies another launch's folder under both; the shared root is
 * never listed, and a link planted among a root's entries is never followed.
 */
import { argsOnlySeccomp, nativeSeccomp } from "../test/seccomp-fixture.js";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { launchRoot, launchRoots } from "./launch-root.js";
import { agentFence, codexFenceArgv, linuxFenceAvailable, linuxFenced, macosFenceAvailable, macosFenceProfile, NO_GRANTS, runFolders, type RunFolders } from "./agent-fence.js";
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

test("Linux: Toolroll's own launch-folder roots are masked whole and only this launch's own folder comes back, as writable as it was", () => {
  const own = join(root, "so-cmd-own");
  mkdirSync(join(root, "so-cmd-theirs"));
  const whole: RunFolders = { root, own, whole: true };
  const at = (args: string[], flag: string, path: string) => args.findLastIndex((arg, index) => arg === flag && args[index + 1] === path);
  // Every other launch's folder is still named in the fence (Seatbelt and Codex deny it by name too); bubblewrap never
  // masks it by itself, only through its root, so none can vanish from under a mask.
  const fence = agentFence({ databaseFile: null, worktree: null, home: join(dir, "home"), runFolders: whole });
  expect(fence).toContain(join(root, "so-cmd-theirs"));
  const open = linuxFenced("/bin/true", [], fence, { ...NO_GRANTS, seccomp: argsOnlySeccomp(), runFolders: whole }).args;
  expect(at(open, "--tmpfs", root)).toBeGreaterThan(-1);
  expect(at(open, "--bind", own)).toBeGreaterThan(at(open, "--tmpfs", root));
  expect(open).not.toContain(join(root, "so-cmd-theirs"));
  // This user's other roots (another Toolroll process's) are masked whole too.
  const other = join(dir, "other-root");
  mkdirSync(other);
  expect(at(linuxFenced("/bin/true", [], [], { ...NO_GRANTS, seccomp: argsOnlySeccomp(), runFolders: { ...whole, also: [other] } }).args, "--tmpfs", other)).toBeGreaterThan(-1);
  // A workspace build: its own folder writable only where its allowlist says.
  const listed = linuxFenced("/bin/true", [], [], { ...NO_GRANTS, seccomp: argsOnlySeccomp(), runFolders: whole, writes: { subpaths: [own], prefixes: [] } }).args;
  expect(at(listed, "--bind", own)).toBeGreaterThan(at(listed, "--tmpfs", root));
  const unlisted = linuxFenced("/bin/true", [], [], { ...NO_GRANTS, seccomp: argsOnlySeccomp(), runFolders: whole, writes: { subpaths: [join(dir, "work")], prefixes: [] } }).args;
  expect(at(unlisted, "--ro-bind", own)).toBeGreaterThan(at(unlisted, "--tmpfs", root));
  expect(at(unlisted, "--bind", own)).toBe(-1);
  // A fenced folder of its own (a Codex build's, read by its harness outside the sandbox) never comes back.
  expect(linuxFenced("/bin/true", [], [own], { ...NO_GRANTS, seccomp: argsOnlySeccomp(), runFolders: whole }).args).not.toContain(own);
});

test("with the Linux roots masked whole, Seatbelt and Codex still deny another launch's folder, by name and by pattern", () => {
  const own = join(root, "so-cmd-own");
  mkdirSync(join(root, "so-cmd-theirs"));
  const whole: RunFolders = { root, own, whole: true };
  const fence = agentFence({ databaseFile: null, worktree: null, home: join(dir, "home"), runFolders: whole });
  const codex = codexFenceArgv(fence, true, { ...NO_GRANTS, runFolders: whole }).find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
  expect(codex).toContain(`"${join(root, "so-cmd-theirs")}"="deny"`);
  expect(codex).toContain(`"${join(root, "so-cmd-*")}"="deny"`);
  const mac = macosFenceProfile(fence, { ...NO_GRANTS, runFolders: whole });
  expect(mac).toContain(join(root, "so-cmd-theirs"));
  expect(mac).toContain(`(regex #"^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(so-tools-|so-codex-|so-net-|so-cmd-)")`);
});

/** What a bubblewrap argv leaves of `path` after its last mount: each op in order, the last one over the path (or a
 * folder above it) decides. A bind shows its source's original content, so a fenced path inside a bind's source shows
 * up at the matching place under its destination: that place must end under a mask too. */
function exposed(args: readonly string[], fenced: readonly string[]): string[] {
  type Op = { dest: string; src: string | null };
  const ops: Op[] = [];
  const end = args.indexOf("--");
  for (let index = 0; index < end; index++) {
    const flag = args[index]!;
    if (["--bind", "--ro-bind", "--dev-bind", "--bind-try", "--ro-bind-try"].includes(flag)) {
      const src = args[index + 1]!, dest = args[index + 2]!;
      ops.push({ dest, src: src === "/dev/null" ? null : src });
      index += 2;
    } else if (flag === "--tmpfs") { ops.push({ dest: args[index + 1]!, src: null }); index += 1; }
    else if (["--dev", "--proc", "--remount-ro", "--unsetenv", "--dir"].includes(flag)) index += 1;
    else if (flag === "--symlink") index += 2;
  }
  const under = (path: string, folder: string) => path === folder || folder === "/" || path.startsWith(`${folder}/`);
  const last = (path: string) => ops.findLast(op => under(path, op.dest));
  const out: string[] = [];
  for (const secret of fenced) {
    for (const op of ops) {
      if (op.src === null) continue;
      // Where this bind shows the secret (or a part of it).
      const shown = under(secret, op.src) ? join(op.dest, secret.slice(op.src === "/" ? 0 : op.src.length)) : under(op.src, secret) ? op.dest : null;
      if (shown !== null && last(shown)?.src != null) out.push(`${secret} at ${shown}`);
    }
  }
  return [...new Set(out)];
}

test("no generated bubblewrap argv leaves a fenced path reachable after its last mount, in any launch form", () => {
  const own = join(root, "so-cmd-own");
  const theirs = join(root, "so-cmd-theirs");
  const secretInOwn = join(own, "fenced-inside-own");
  const state = join(dir, "state");
  const pool = join(dir, "pool");
  const checkout = join(pool, "p", "task-1");
  const sibling = join(pool, "p", "task-2");
  const scratchRoot = join(pool, "flow-checks");
  for (const path of [theirs, secretInOwn, state, checkout, sibling, scratchRoot, join(dir, "work")]) mkdirSync(path, { recursive: true });
  const whole: RunFolders = { root, own, whole: true };
  const fence = [theirs, secretInOwn, state];
  const base = { ...NO_GRANTS, seccomp: argsOnlySeccomp(), runFolders: whole };
  const forms = {
    open: base,
    workspace: { ...base, writes: { subpaths: [own, checkout], prefixes: [] } },
    poolV1: { ...base, pool: { deny: [pool], own: checkout, lookup: [], sealed: [scratchRoot] } },
    poolV2: { ...base, pool: { deny: [pool], own: checkout, lookup: [], readable: true as const, sealed: [scratchRoot] }, writes: { subpaths: [own, checkout], prefixes: [] } },
  };
  for (const [name, grants] of Object.entries(forms)) {
    const args = linuxFenced("/bin/true", [], fence, grants).args;
    const secrets = [...fence, ...("pool" in grants ? [scratchRoot, ...(name === "poolV1" ? [sibling] : [])] : [])];
    expect(exposed(args, secrets), name).toEqual([]);
  }
  // The simulator itself: a bind of a folder holding a fenced path, after the mask, is caught.
  expect(exposed(["--dev-bind", "/", "/", "--tmpfs", state, "--bind", dir, dir, "--", "true"], [state])).toEqual([`${state} at ${state}`]);
});

test("the Linux launch-folder root: made owner-only, a loose one tightened; one that isn't this user's real folder is never used, a private one is made and kept", () => {
  const base = join(dir, "base");
  mkdirSync(base);
  const made = launchRoot("linux", base);
  expect(made.startsWith(join(base, "so-runs-"))).toBe(true);
  expect(statSync(made).mode & 0o777).toBe(0o700);
  chmodSync(made, 0o755);
  expect(statSync(launchRoot("linux", base)).mode & 0o777).toBe(0o700);
  // The fixed name taken by a link (or anyone else's folder): a private root of this process's own, the same each time.
  const planted = join(dir, "planted");
  mkdirSync(planted);
  mkdirSync(join(planted, "target"));
  const fixed = join(planted, made.slice(base.length + 1));
  symlinkSync(join(planted, "target"), fixed);
  const fallback = launchRoot("linux", planted);
  expect(fallback.startsWith(`${fixed}-`)).toBe(true);
  expect(statSync(fallback).mode & 0o777).toBe(0o700);
  expect(launchRoot("linux", planted)).toBe(fallback);
  // Every root of this user's is found (to be masked), never the link.
  expect(launchRoots(planted)).toEqual([fallback]);
  expect(launchRoots(base)).toEqual([made]);
  expect(launchRoot("darwin", base)).toBe(base);
});

test.skipIf(INSIDE_FENCE || process.platform !== "linux" || !linuxFenceAvailable())("native Linux: another launch's folder, made before or after the launch or gone during it, is never reached and never fails it; nothing under the root is written", () => {
  const own = join(root, "so-cmd-own");
  const before = join(root, "so-cmd-before");
  const gone = join(root, "so-cmd-gone");
  for (const path of [before, gone]) { mkdirSync(path); writeFileSync(join(path, "secret"), "x"); }
  const seccomp = nativeSeccomp();
  expect(seccomp).not.toBeNull();
  const after = join(root, "so-tools-after");
  const script = [
    `cat ${before}/secret 2>/dev/null && echo read-before || echo before-refused`,
    `cat ${after}/secret 2>/dev/null && echo read-after || echo after-refused`,
    `echo y > ${own}/mine && echo own-ok`,
    `echo z > ${root}/planted 2>/dev/null; echo done`,
  ].join("\n");
  for (const writes of [undefined, { subpaths: [own], prefixes: [] }]) {
    const wrapped = linuxFenced("/bin/sh", ["-c", script], [], { ...NO_GRANTS, runFolders: { root, own, whole: true }, ...(writes === undefined ? {} : { writes }), seccomp: seccomp! });
    rmSync(gone, { recursive: true, force: true });
    mkdirSync(after, { recursive: true });
    writeFileSync(join(after, "secret"), "x");
    const result = spawnSync(wrapped.file, wrapped.args, { encoding: "utf8" });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual(["before-refused", "after-refused", "own-ok", "done"]);
    // Whatever it wrote at the root stayed in its own view.
    expect(existsSync(join(root, "planted"))).toBe(false);
    mkdirSync(gone, { recursive: true });
  }
});
