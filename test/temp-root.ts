import { accessSync, constants, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { makeTempRoot, removeOnExit, removeRoot } from "../scripts/suite-lifecycle.mjs";
// @ts-expect-error plain ESM script without declarations
import { insideMacSandbox, residueCheck } from "../scripts/isolated-env.mjs";

/**
 * Tests leave no temp folders. Every test run gets one temp root of its own, before any worker starts: the workers
 * and everything they spawn inherit it as TMPDIR, so whatever a test makes in tmpdir() (so-*, standing-orders-*,
 * no-wt*, a socket, a browser profile) lands there, and the global teardown removes it all, whether or not each test
 * cleaned up after itself. An interrupted run (Ctrl-C, SIGTERM, a timeout's kill) skips the teardown: the root goes
 * at exit instead, with anything the run still had running (scripts/suite-lifecycle.mjs). So does Vitest's own
 * module cache (a random name in the temp folder, made before this runs), which only a clean finish removes. A short
 * name keeps the socket paths tests make under it within the OS limit.
 *
 * A test that needs a folder outside the temp folder, as homes and checkouts are (a Linux sandbox's /tmp is its own),
 * gets it in this run's fake outer home (TOOLROLL_TEST_OUTER_HOME, test/short-temp.ts outsideTempDir): run-owned, in
 * this checkout's ignored .test-outer folder, removed with the run — never the person's home.
 *
 * And a LIMITED residue check of the person's real home at teardown (scripts/isolated-env.mjs residueCheck, read-only):
 * Claude transcript folders named after this run's folders (new, or changed inside) and lines of
 * ~/.toolroll/git-incidents.jsonl naming them. It doesn't see build caches here (no repository is known to it) nor any
 * other write. Residue fails the run, naming what was left (the person decides about removing it); a place it can't
 * read fails it too, as unknown, unless this run's own macOS sandbox denies it. `homes`: where to look (tests of this
 * check), else the account's own home and the HOME this run started with.
 */
export default function tempRoot(project?: { vitest?: { _tmpDir?: unknown } }, options: { homes?: string[]; outerParent?: string } = {}): () => void {
  const own = project?.vitest?._tmpDir;
  if (typeof own === "string" && dirname(own) === tmpdir() && /^[\w-]{21}$/.test(basename(own))) removeOnExit(own);
  const before = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, TOOLROLL_TEST_OUTER_HOME: process.env.TOOLROLL_TEST_OUTER_HOME };
  const root = makeTempRoot("so-t", { parent: shortTempParent() });
  const outer = join(options.outerParent ?? join(import.meta.dirname, "..", ".test-outer"), basename(root));
  mkdirSync(outer, { recursive: true, mode: 0o700 });
  removeOnExit(outer);
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  process.env.TOOLROLL_TEST_OUTER_HOME = outer;
  const residue = residueCheck({ root, also: [outer], deniedBySandbox: insideMacSandbox(), ...(options.homes === undefined ? {} : { homes: options.homes }) });
  return () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const { left, unknown, unknownFails } = residue.check() as { left: string[]; unknown: string[]; unknownFails: boolean };
    removeRoot(root);
    rmSync(outer, { recursive: true, force: true });
    if (left.length > 0) throw new Error(`Residue check: these tests left ${left.length} trace(s) in the person's real home: ${left.slice(0, 10).join(", ")}. A test's HOME is its own (test/setup-state.ts); find what ignored it.`);
    if (unknownFails) throw new Error(`Residue check: couldn't read ${unknown.join(", ")}, so this run's traces there are unknown, not clean.`);
  };
}

/**
 * The shortest way to name the temp folder this run inherited, so the socket paths tests make under it stay within the
 * OS limit. On a Mac, /private/var/... is also /var/.... A check the plane runs in its macOS fence gets a temp folder
 * one level inside its own launch folder (the tmp folder in so-cmd-…), 19 bytes deeper than a person's; that launch folder is the
 * build's own and writable, so the run's root goes beside the temp folder there instead.
 */
function shortTempParent(): string {
  let parent = tmpdir();
  const launch = dirname(parent);
  if (basename(parent) === "tmp" && /^so-cmd-[\w]+$/.test(basename(launch))) {
    try { accessSync(launch, constants.W_OK); parent = launch; } catch { /* stay in the temp folder */ }
  }
  if (process.platform === "darwin" && parent.startsWith("/private/var/")) {
    const alias = parent.slice("/private".length);
    try { if (realpathSync(alias) === realpathSync(parent)) parent = alias; } catch { /* keep the real path */ }
  }
  return parent;
}
