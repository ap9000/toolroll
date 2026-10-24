/**
 * The seccomp helper for tests (src/seccomp-helper.ts). `argsOnlySeccomp`: a stand-in file with its own sha256, for
 * tests that read a generated bubblewrap command and never run it. `nativeSeccomp`: the real helper this checkout
 * built (`node vendor/seccomp/build.mjs`, into dist/helpers), installed into a scratch state folder; null where none
 * was built, and a native test that needs it then skips, saying so.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSeccompHelper, packagedSeccompHelper, PACKAGED_HELPERS, type SeccompHelper } from "../src/seccomp-helper.js";

let standIn: SeccompHelper | null = null;
export function argsOnlySeccomp(): SeccompHelper {
  if (standIn !== null) return standIn;
  const dir = mkdtempSync(join(tmpdir(), "so-seccomp-stand-in-"));
  const helper = join(dir, "apply-seccomp");
  writeFileSync(helper, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  return standIn = { helper, sha256: createHash("sha256").update(readFileSync(helper)).digest("hex") };
}

let native: SeccompHelper | null | undefined;
export function nativeSeccomp(): SeccompHelper | null {
  if (native !== undefined) return native;
  if (process.platform !== "linux") return native = null;
  const state = mkdtempSync(join(tmpdir(), "so-seccomp-state-"));
  mkdirSync(state, { recursive: true });
  return native = installSeccompHelper(state, packagedSeccompHelper(PACKAGED_HELPERS));
}
