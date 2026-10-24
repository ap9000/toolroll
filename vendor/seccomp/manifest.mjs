/**
 * Writes dist/helpers/manifest.json: the sha256 of each built seccomp helper (dist/helpers/linux-<arch>/apply-seccomp),
 * which the runtime checks before every launch (src/seccomp-helper.ts). Run by vendor/seccomp/build.mjs and
 * scripts/postbuild.mjs (the release downloads the helpers its Linux runners built into dist/helpers first).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeSeccompManifest(helpers) {
  const manifest = {};
  for (const arch of ["x64", "arm64"]) {
    const helper = join(helpers, `linux-${arch}`, "apply-seccomp");
    if (existsSync(helper)) manifest[`linux-${arch}`] = createHash("sha256").update(readFileSync(helper)).digest("hex");
  }
  mkdirSync(helpers, { recursive: true });
  writeFileSync(join(helpers, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
