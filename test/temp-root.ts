import { accessSync, constants, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { makeTempRoot, removeOnExit, removeRoot } from "../scripts/suite-lifecycle.mjs";
import { realHomeGuard } from "../scripts/isolated-env.mjs";

/**
 * Tests leave no temp folders. Every test run gets one temp root of its own, before any worker starts: the workers
 * and everything they spawn inherit it as TMPDIR, so whatever a test makes in tmpdir() (so-*, standing-orders-*,
 * no-wt*, a socket, a browser profile) lands there, and the global teardown removes it all, whether or not each test
 * cleaned up after itself. An interrupted run (Ctrl-C, SIGTERM, a timeout's kill) skips the teardown: the root goes
 * at exit instead, with anything the run still had running (scripts/suite-lifecycle.mjs). So does Vitest's own
 * module cache (a random name in the temp folder, made before this runs), which only a clean finish removes. A short
 * name keeps the socket paths tests make under it within the OS limit.
 */
/**
 * The run also proves it left nothing in the person's real home (scripts/isolated-env.mjs realHomeGuard, read-only):
 * no Claude transcript folder named after this run's temp root and no line in ~/.toolroll/git-incidents.jsonl naming
 * it. Anything there fails the run at teardown, naming what was left (the person decides about removing it). `homes`:
 * where to look (tests of this guard), else the account's own home and the HOME this run started with.
 */
export default function tempRoot(project?: { vitest?: { _tmpDir?: unknown } }, options: { homes?: string[] } = {}): () => void {
  const own = project?.vitest?._tmpDir;
  if (typeof own === "string" && dirname(own) === tmpdir() && /^[\w-]{21}$/.test(basename(own))) removeOnExit(own);
  const before = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const root = makeTempRoot("so-t", { parent: shortTempParent() });
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  const guard = realHomeGuard({ root, ...(options.homes === undefined ? {} : { homes: options.homes }) });
  return () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const left: string[] = guard.check();
    removeRoot(root);
    if (left.length > 0) throw new Error(`These tests wrote into the person's real home (${left.length}): ${left.slice(0, 10).join(", ")}. A test's HOME is its own (test/setup-state.ts); find what ignored it.`);
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
