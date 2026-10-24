#!/usr/bin/env node
/**
 * Builds the Linux seccomp helper (docs/plans/sandbox-parity.md C7) from the vendored sources in vendor/seccomp-src
 * (Anthropic sandbox-runtime c66fb77, Apache-2.0; adapted from its vendor/seccomp/build.ts): a static generator emits
 * the two filters for this machine's architecture, they are baked into apply-seccomp as a header, and apply-seccomp is
 * linked static and stripped. Linux only; needs gcc and libseccomp (the libseccomp-dev package).
 *
 *   node vendor/seccomp/build.mjs [out-dir]      (default: dist/helpers/linux-<arch>)
 *
 * The release builds it on an x64 and an arm64 runner (publish.yml) and ships both; scripts/postbuild.mjs records
 * their sha256 in dist/helpers/manifest.json, which the runtime checks before every launch.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSeccompManifest } from "./manifest.mjs";

if (process.platform !== "linux") { console.error("The seccomp helper is built on Linux only."); process.exit(1); }
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = join(root, "vendor", "seccomp-src");
const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
if (arch === null) { console.error(`No seccomp helper for ${process.arch}.`); process.exit(1); }
const out = resolve(process.argv[2] ?? join(root, "dist", "helpers", `linux-${arch}`));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "so-seccomp-build-"));
const run = (file, args) => execFileSync(file, args, { stdio: ["ignore", "inherit", "inherit"] });
const cflags = ["-static", "-O2", "-Wall", "-Wextra"];
const hex = bytes => Array.from(bytes, b => `0x${b.toString(16).padStart(2, "0")}`).reduce((lines, one, at) => { if (at % 8 === 0) lines.push([]); lines.at(-1).push(one); return lines; }, []).map(line => `    ${line.join(", ")},`).join("\n");
try {
  const gen = join(work, "seccomp-unix-block");
  run("gcc", [...cflags, "-o", gen, join(src, "seccomp-unix-block.c"), "-lseccomp"]);
  const target = arch === "x64" ? "x86_64" : "aarch64";
  const bpf = {};
  for (const rules of ["unix", "namespaces"]) {
    const file = join(work, `${rules}.bpf`);
    run(gen, [file, target, rules]);
    bpf[rules] = readFileSync(file);
  }
  writeFileSync(join(work, "unix-block-bpf.h"), `#if defined(__${target}__)\nstatic const unsigned char unix_block_bpf[] = {\n${hex(bpf.unix)}\n};\nstatic const unsigned char namespace_block_bpf[] = {\n${hex(bpf.namespaces)}\n};\n#else\n#error "these filters were generated for another architecture"\n#endif\n`);
  const helper = join(out, "apply-seccomp");
  run("gcc", [...cflags, "-I", work, "-o", helper, join(src, "apply-seccomp.c")]);
  run("strip", [helper]);
  console.log(`built ${helper}`);
  // Built into this package's own helpers folder: its manifest names it.
  if (resolve(out, "..") === join(root, "dist", "helpers")) console.log(JSON.stringify(writeSeccompManifest(join(root, "dist", "helpers"))));
} finally {
  rmSync(work, { recursive: true, force: true });
}
