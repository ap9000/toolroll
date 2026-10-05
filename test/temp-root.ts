import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { makeTempRoot, removeOnExit, removeRoot } from "../scripts/suite-lifecycle.mjs";

/**
 * Tests leave no temp folders. Every test run gets one temp root of its own, before any worker starts: the workers
 * and everything they spawn inherit it as TMPDIR, so whatever a test makes in tmpdir() (so-*, standing-orders-*,
 * no-wt*, a socket, a browser profile) lands there, and the global teardown removes it all, whether or not each test
 * cleaned up after itself. An interrupted run (Ctrl-C, SIGTERM, a timeout's kill) skips the teardown: the root goes
 * at exit instead, with anything the run still had running (scripts/suite-lifecycle.mjs). So does Vitest's own
 * module cache (a random name in the temp folder, made before this runs), which only a clean finish removes. A short
 * name keeps the socket paths tests make under it within the OS limit.
 */
export default function tempRoot(project?: { vitest?: { _tmpDir?: unknown } }): () => void {
  const own = project?.vitest?._tmpDir;
  if (typeof own === "string" && dirname(own) === tmpdir() && /^[\w-]{21}$/.test(basename(own))) removeOnExit(own);
  const before = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const root = makeTempRoot("so-t");
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  return () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    removeRoot(root);
  };
}
