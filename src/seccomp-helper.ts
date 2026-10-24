/**
 * The Linux seccomp helper (docs/plans/sandbox-parity.md C7): `apply-seccomp`, built from Anthropic sandbox-runtime's
 * vendored sources (vendor/seccomp-src, Apache-2.0) and shipped in this package as dist/helpers/linux-<arch>/, with
 * its sha256 in dist/helpers/manifest.json. It refuses a workload new user and mount namespaces, VM sockets and
 * io_uring (Toolroll's filter keeps unix sockets: agent-fence.ts masks the host's).
 *
 * Trust: the plane copies it into its own state folder (`<state>/helpers/apply-seccomp`, private, inside the folder
 * every fence denies) and, right before every launch, checks that file is still a regular file of its own whose
 * sha256 is the manifest's; it is run by that exact path, bound read-only into the sandbox. No search path, no
 * fallback: a helper missing or changed means no Linux fence, and the launch is refused.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The helper a launch runs through: its path in the state folder, and the sha256 it must have. */
export type SeccompHelper = { helper: string; sha256: string };

const sha256Of = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Where this package keeps its built helpers: dist/helpers beside the compiled modules (run from the sources, the
 * sibling dist's). */
const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGED_HELPERS = basename(here) === "src" ? resolve(here, "..", "dist", "helpers") : resolve(here, "helpers");

/** This package's helper for `arch`, and its manifest sha256, or null where it ships none. */
export function packagedSeccompHelper(root: string = PACKAGED_HELPERS, arch: string = process.arch): { path: string; sha256: string } | null {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Record<string, unknown>;
    const sha256 = manifest[`linux-${arch}`];
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
    return { path: join(root, `linux-${arch}`, "apply-seccomp"), sha256 };
  } catch { return null; }
}

/** A file or folder of this user's, reached through no link at its own name. */
function own(path: string, folder: boolean): boolean {
  try {
    const held = lstatSync(path);
    return !held.isSymbolicLink() && (folder ? held.isDirectory() : held.isFile()) && (process.getuid === undefined || held.uid === process.getuid());
  } catch { return false; }
}

/**
 * The helper in `state`'s private helpers folder, copied there from this package when absent or different, or null
 * where it can't be had (no packaged helper for this machine, a helpers folder that isn't Toolroll's own, a copy that
 * doesn't hash to the manifest).
 */
export function installSeccompHelper(state: string, packaged: { path: string; sha256: string } | null = packagedSeccompHelper()): SeccompHelper | null {
  if (packaged === null) return null;
  const folder = join(state, "helpers");
  try { mkdirSync(folder, { recursive: true, mode: 0o700 }); } catch { return null; }
  if (!own(folder, true) || (lstatSync(folder).mode & 0o077) !== 0) return null;
  const helper = join(folder, "apply-seccomp");
  const ready: SeccompHelper = { helper, sha256: packaged.sha256 };
  if (verifySeccompHelper(ready)) return ready;
  const staging = join(folder, `.apply-seccomp-${process.pid}-${Date.now()}`);
  try {
    copyFileSync(packaged.path, staging);
    chmodSync(staging, 0o700);
    if (sha256Of(staging) !== packaged.sha256) return null;
    renameSync(staging, helper);
  } catch { return null; } finally { rmSync(staging, { force: true }); }
  return verifySeccompHelper(ready) ? ready : null;
}

/** Whether the helper is still the one the manifest names: checked right before every launch. */
export function verifySeccompHelper(helper: SeccompHelper): boolean {
  try { return own(helper.helper, false) && sha256Of(helper.helper) === helper.sha256; } catch { return false; }
}
