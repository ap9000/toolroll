#!/usr/bin/env node
/**
 * Terminal workbench packaging (solo-workbench plan; the spike's sketch, kept current with T1). Not wired into the
 * release yet: publish.yml doesn't call it. The real launcher is src/tui-launch.ts (the smoke launcher below mirrors its
 * self-check: `toolroll-tui <version> contract <engine contract digest>`).
 *
 * Builds the Rust binary (tui/) per target and packs one npm package per platform, the esbuild/Codex pattern:
 * `@toolroll/tui-<platform>` with os/cpu fields, the binary in bin/, and NO install scripts (works with
 * `npm publish --ignore-scripts` and `npm i --ignore-scripts`). Toolroll's own package would list them as
 * optionalDependencies; its launcher resolves the one for this machine, runs a `--version` self-check and falls back to
 * the current Ink screen when there is none (`--omit=optional`, an unknown platform, a failed self-check).
 *
 *   node scripts/tui-build.mjs [--targets darwin-arm64,darwin-x64,linux-x64,linux-arm64] [--profile release-s]
 *                              [--out <dir>] [--smoke <dir>]
 *
 * --smoke <dir> also builds a throwaway launcher package that depends on the platform tarballs (file: paths), and runs
 * `npm i -g` of it into <dir>/prefix (never the global npm, its own cache too), with and without --omit=optional.
 *
 * Linux targets are static musl binaries linked by the toolchain's own rust-lld: no zig, no C cross compiler (the TUI
 * talks plain http to 127.0.0.1, so it has no TLS stack). A static binary runs on glibc and musl alike, so the Linux
 * packages carry NO `libc` field (a `libc: ["musl"]` would make npm skip them on every glibc distribution).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tui = join(root, "tui");
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };

/** npm platform → Rust target, npm os/cpu. */
export const PLATFORMS = {
  "darwin-arm64": { target: "aarch64-apple-darwin", os: "darwin", cpu: "arm64" },
  "darwin-x64": { target: "x86_64-apple-darwin", os: "darwin", cpu: "x64" },
  "linux-x64": { target: "x86_64-unknown-linux-musl", os: "linux", cpu: "x64" },
  "linux-arm64": { target: "aarch64-unknown-linux-musl", os: "linux", cpu: "arm64" },
};

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const profile = opt("--profile", "release");
const targets = opt("--targets", "darwin-arm64,darwin-x64,linux-x64,linux-arm64").split(",").filter(Boolean);
const out = resolve(opt("--out", join(tui, "npm")));
const smoke = opt("--smoke", null);
const rustupBin = "/opt/homebrew/opt/rustup/bin";
const env = { ...process.env, PATH: `${rustupBin}:${process.env.PATH}` };

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "tarballs"), { recursive: true });
const built = [];
for (const name of targets) {
  const platform = PLATFORMS[name];
  if (platform === undefined) throw new Error(`unknown platform ${name}`);
  const linkerVar = `CARGO_TARGET_${platform.target.toUpperCase().replaceAll("-", "_")}_LINKER`;
  const buildEnv = platform.os === "linux" ? { ...env, [linkerVar]: "rust-lld" } : env;
  const started = Date.now();
  const result = spawnSync("cargo", ["build", "--locked", "--profile", profile, "--target", platform.target, "-p", "toolroll-tui"], { cwd: tui, env: buildEnv, stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0) {
    console.log(JSON.stringify({ platform: name, built: false, why: result.stderr.toString().split("\n").filter(line => /error/.test(line)).slice(0, 3) }));
    continue;
  }
  const binary = join(tui, "target", platform.target, profile, "toolroll-tui");
  const dir = join(out, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(binary, join(dir, "bin", "toolroll-tui"));
  chmodSync(join(dir, "bin", "toolroll-tui"), 0o755);
  // Apple's linker ad-hoc signs arm64 output itself; x86_64 output comes out unsigned. Ad-hoc sign every macOS binary
  // the same way (no identity, no notarization: an npm-extracted file carries no quarantine, so Gatekeeper never
  // assesses it). Only possible on a Mac (the release matrix builds macOS targets on macOS runners).
  if (platform.os === "darwin" && process.platform === "darwin") execFileSync("codesign", ["--sign", "-", "--force", join(dir, "bin", "toolroll-tui")]);
  const pkg = {
    name: `@toolroll/tui-${name}`,
    version,
    description: `Toolroll's terminal workbench for ${name} (installed by toolroll as an optional dependency).`,
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/ap9000/toolroll.git" },
    os: [platform.os],
    cpu: [platform.cpu],
    files: ["bin/toolroll-tui"],
    preferUnplugged: true,
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(dir, "README.md"), `# ${pkg.name}\n\nThe ${name} binary of Toolroll's terminal workbench. Install \`toolroll\`, not this package.\n`);
  const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", join(out, "tarballs")], { cwd: dir, env }).toString();
  const file = JSON.parse(packed)[0].filename;
  const tarball = join(out, "tarballs", file);
  built.push({ name, tarball });
  console.log(JSON.stringify({ platform: name, built: true, seconds: Math.round((Date.now() - started) / 100) / 10, binary_bytes: statSync(binary).size, tarball_bytes: statSync(tarball).size, tarball: file }));
}

if (smoke !== null) runSmoke(resolve(smoke));

/** The launcher sketch: what easy-start.ts would do before opening the Ink screen. */
function launcherSource() {
  return `#!/usr/bin/env node
// Spike launcher: resolve this machine's terminal workbench binary, self-check it, run it; else the classic screen.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const PACKAGES = ${JSON.stringify(Object.fromEntries(Object.keys(PLATFORMS).map(name => [name, `@toolroll/tui-${name}`])))};
const EXPECTED = /^toolroll-tui \\S+ contract [0-9a-f]{64}$/;
function resolveTui() {
  if (process.env.TOOLROLL_SCREEN === "classic") return { ok: false, why: "TOOLROLL_SCREEN=classic" };
  const pkg = PACKAGES[\`\${process.platform}-\${process.arch}\`];
  if (pkg === undefined) return { ok: false, why: \`no terminal workbench build for \${process.platform}-\${process.arch}\` };
  let manifest;
  try { manifest = require.resolve(\`\${pkg}/package.json\`); } catch { return { ok: false, why: "the terminal workbench package isn't installed (optional dependencies were skipped)" }; }
  const bin = join(dirname(manifest), "bin", "toolroll-tui");
  const check = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000 });
  if (check.status !== 0 || !EXPECTED.test(check.stdout.trim())) return { ok: false, why: \`the terminal workbench didn't start (\${check.error?.code ?? check.status ?? check.signal})\` };
  return { ok: true, bin };
}
const found = resolveTui();
if (process.argv[2] === "--which") { console.log(JSON.stringify(found)); process.exit(0); }
if (!found.ok) {
  console.log(\`Opening the classic screen: \${found.why}.\`);
  console.log("INK-FALLBACK"); // the real launcher calls the existing openTui seam (src/tui/entry.tsx) here
  process.exit(0);
}
const child = spawn(found.bin, process.argv.slice(2), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
// The child's own end is this process's: a signal is re-raised with the forwarding handlers removed first.
child.on("exit", (code, signal) => { if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } else process.exit(code ?? 1); });
`;
}

function runSmoke(dir) {
  rmSync(dir, { recursive: true, force: true });
  const launcher = join(dir, "launcher");
  mkdirSync(join(launcher, "bin"), { recursive: true });
  writeFileSync(join(launcher, "bin", "toolroll-tui-smoke.mjs"), launcherSource(), { mode: 0o755 });
  writeFileSync(join(launcher, "package.json"), `${JSON.stringify({
    name: "toolroll-tui-smoke", version, type: "module", license: "MIT",
    bin: { "toolroll-tui-smoke": "bin/toolroll-tui-smoke.mjs" },
    // Published, these are version specs (or npm aliases like "npm:@toolroll/tui@<v>-darwin-arm64"); the spike points at
    // the local tarballs.
    optionalDependencies: Object.fromEntries(built.map(one => [`@toolroll/tui-${one.name}`, `file:${one.tarball}`])),
  }, null, 2)}\n`);
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", dir], { cwd: launcher, env }).toString())[0].filename;
  const tarball = join(dir, packed);
  const report = { launcher_tarball: tarball, installs: [] };
  for (const omit of [false, true]) {
    const prefix = join(dir, omit ? "prefix-omit" : "prefix");
    const started = Date.now();
    const install = spawnSync("npm", ["i", "-g", "--prefix", prefix, "--cache", join(dir, "npm-cache"), "--no-audit", "--no-fund", "--ignore-scripts", ...(omit ? ["--omit=optional"] : []), tarball], { env, encoding: "utf8" });
    const bin = join(prefix, "bin", "toolroll-tui-smoke");
    const which = spawnSync(bin, ["--which"], { encoding: "utf8" });
    const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
    report.installs.push({
      omit_optional: omit, install_status: install.status, install_seconds: Math.round((Date.now() - started) / 100) / 10,
      install_stderr: install.stderr.trim().split("\n").filter(line => line !== "").slice(-3),
      resolved: which.stdout.trim(), run: version.stdout.trim().split("\n"),
    });
  }
  writeFileSync(join(dir, "smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
