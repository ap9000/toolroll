#!/usr/bin/env node
/**
 * The execute bit tsc does not set.
 *
 * This was `chmod +x dist/cli.js` in the build script, which does not exist on
 * Windows — so a build that had entirely succeeded exited 1 and reported
 * itself as a failure. The bit still matters on POSIX, where `nightorders
 * link` makes a symlink to this file and the shell refuses to run it without.
 */

import { chmod, copyFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Owner, group, and other execute — the same bits npm sets on a package bin. */
const EXECUTABLE_BITS = 0o111;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The Windows Job Object helper is PowerShell — tsc ignores it, and
// containment.ts resolves it as a sibling, so dist needs its own copy.
await copyFile(resolve(root, "src", "job-object-helper.ps1"), resolve(root, "dist", "job-object-helper.ps1"));

if (process.platform !== "win32") {
  for (const name of ["bin.js", "cli.js"]) {
    const file = resolve(root, "dist", name);
    const stats = await stat(file);
    const wanted = stats.mode | EXECUTABLE_BITS;
    if (wanted !== stats.mode) await chmod(file, wanted);
  }
}

// The final gate retains this build's tree identity. Commit metadata can differ
// after a prepared tree is materialized; compare trees to identify its contents.
try {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (realpathSync(git("rev-parse", "--show-toplevel")) !== realpathSync(root)) throw Error("outside checkout");
  const head = git("rev-parse", "--verify", "HEAD"), tree = git("rev-parse", "--verify", "HEAD^{tree}");
  if (![head, tree].every(value => /^[a-f0-9]{40,64}$/.test(value))) throw Error("unknown identity");
  git("diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--");
  console.log(`Build source: ${JSON.stringify({ head, tree, trackedClean: true })}`);
} catch {
  console.log("Build source: unavailable (no clean Git checkout)");
}
