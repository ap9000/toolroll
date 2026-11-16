#!/usr/bin/env node
/**
 * Terminal workbench packaging (solo-workbench plan T1). The Rust binary (tui/) ships INSIDE the `toolroll` package, at
 * `dist/tui/<platform>-<arch>/toolroll-tui`, for all four platforms below: publish.yml builds each on its own platform
 * (`--bundle`), places them (`--adopt`) and refuses to publish unless `--verify` passes. The launcher (src/tui-launch.ts)
 * runs the bundled one for this machine after its trust checks and its self-check (`toolroll-tui <version> contract
 * <engine contract digest>`), and falls back to the classic Ink screen when there is none or it fails.
 *
 *   node scripts/tui-build.mjs --bundle <dir> [--reports <dir>] [--targets <list>] [--profile release-s]
 *       Build each target into <dir>/<platform>-<arch>/toolroll-tui (mode 0755). A macOS binary is ad-hoc signed and
 *       its signature checked (`codesign -v --strict`), so only on a Mac. A target that is this machine's own runs its
 *       self-check, which must name the contract this tree was written against (test/fixtures/engine-api/schemas.json).
 *       --reports <dir>: one <platform>-<arch>.json per target (its sha256, size, self-check line), kept OUT of <dir> so
 *       nothing but the binaries is packed.
 *   node scripts/tui-build.mjs --adopt <dir> [--targets <list>]
 *       Copy <dir>/<platform>-<arch>/toolroll-tui (built elsewhere, e.g. downloaded artifacts, whose modes are lost) into
 *       this package's dist/tui/<platform>-<arch>/toolroll-tui, mode 0755.
 *   node scripts/tui-build.mjs --verify [--reports <dir>] [--targets <list>]
 *       Refuse (exit 1) unless every target's dist/tui binary is a regular 0755 file of exactly that target's
 *       architecture (its own header, and `file`/`lipo -archs` where present), a macOS one carries a code signature
 *       (`codesign -v --strict` on a Mac), a Linux one is static, and it answers the self-check with THIS build's engine
 *       contract digest (dist/contracts/engine-api.js engineContractDigest): run here for this machine's target, and the
 *       line its build recorded on its own platform (--reports, whose sha256 must be this exact file's) for the others.
 *       Then `npm pack --dry-run --json` must list exactly those binaries under dist/tui, each mode 0755.
 *   node scripts/tui-build.mjs [--targets <list>] [--profile release-s] [--out <dir>] [--smoke <dir>]
 *       The optional-package layout (the esbuild/Codex pattern, kept for the launcher's third road): one
 *       `@toolroll/tui-<platform>` npm package per target with os/cpu fields, the binary in bin/ and NO install scripts.
 *       --smoke <dir> also builds a throwaway launcher package that depends on them (file: paths) and runs `npm i -g` of
 *       it into <dir>/prefix (never the global npm, its own cache too), with and without --omit=optional.
 *
 * <list>: darwin-arm64,darwin-x64,linux-x64,linux-arm64 (the default: all four).
 *
 * Linux targets are static musl binaries linked by the toolchain's own rust-lld: no zig, no C cross compiler (the TUI
 * talks plain http to 127.0.0.1, so it has no TLS stack). A static binary runs on glibc and musl alike, so one Linux
 * binary per architecture serves every distribution. No install scripts anywhere: the package works with
 * `npm publish --ignore-scripts` and `npm i --ignore-scripts`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tui = join(root, "tui");

/** npm platform → Rust target, npm os/cpu. */
export const PLATFORMS = {
  "darwin-arm64": { target: "aarch64-apple-darwin", os: "darwin", cpu: "arm64" },
  "darwin-x64": { target: "x86_64-apple-darwin", os: "darwin", cpu: "x64" },
  "linux-x64": { target: "x86_64-unknown-linux-musl", os: "linux", cpu: "x64" },
  "linux-arm64": { target: "aarch64-unknown-linux-musl", os: "linux", cpu: "arm64" },
};
export const BINARY = "toolroll-tui";
/** Where a target's binary sits in a bundle folder (dist/tui for the package). */
export const bundled = (dir, name) => join(dir, name, BINARY);
/** The self-check's answer (tui-launch.ts reads the same shape). */
export const SELF_CHECK = /^toolroll-tui \S+ contract ([0-9a-f]{64})$/;

const MACHO_64 = 0xfeedfacf, FAT = 0xcafebabe, FAT_64 = 0xcafebabf;
const CPU = { arm64: 0x0100000c, x64: 0x01000007 };
const ELF_MACHINE = { x64: 62, arm64: 183 };
const LC_CODE_SIGNATURE = 0x1d, PT_INTERP = 3;

/**
 * What an executable's own header says it is: `{ platform, signed }` for a 64-bit Mach-O (whether it carries a code
 * signature load command), `{ platform, static }` for a 64-bit little-endian ELF (no program interpreter), or `{ why }`
 * when it is none of the four (a universal binary, 32-bit, another machine, cut short).
 */
export function headerOf(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length < 64) return { why: "too short to be a program" };
  if (buf.readUInt32BE(0) === FAT || buf.readUInt32BE(0) === FAT_64) return { why: "a universal (fat) binary, not one architecture" };
  if (buf.readUInt32LE(0) === MACHO_64) {
    const cpu = buf.readInt32LE(4);
    const arch = Object.keys(CPU).find(one => CPU[one] === cpu);
    if (arch === undefined) return { why: `a Mach-O for another CPU (0x${(cpu >>> 0).toString(16)})` };
    const count = buf.readUInt32LE(16);
    let at = 32, signed = false;
    for (let i = 0; i < count; i += 1) {
      if (at + 8 > buf.length) return { why: "its load commands are cut short" };
      const cmd = buf.readUInt32LE(at), size = buf.readUInt32LE(at + 4);
      if (size < 8) return { why: "a malformed load command" };
      if (cmd === LC_CODE_SIGNATURE) signed = true;
      at += size;
    }
    return { platform: `darwin-${arch}`, signed };
  }
  if (buf.readUInt32BE(0) === 0x7f454c46) {
    if (buf[4] !== 2 || buf[5] !== 1) return { why: "an ELF that isn't 64-bit little-endian" };
    const machine = buf.readUInt16LE(18);
    const arch = Object.keys(ELF_MACHINE).find(one => ELF_MACHINE[one] === machine);
    if (arch === undefined) return { why: `an ELF for another machine (${machine})` };
    const phoff = Number(buf.readBigUInt64LE(32)), phentsize = buf.readUInt16LE(54), phnum = buf.readUInt16LE(56);
    let interp = false;
    for (let i = 0; i < phnum; i += 1) {
      const at = phoff + i * phentsize;
      if (at + 4 > buf.length) return { why: "its program headers are cut short" };
      if (buf.readUInt32LE(at) === PT_INTERP) interp = true;
    }
    return { platform: `linux-${arch}`, static: !interp };
  }
  return { why: "not a Mach-O or ELF program" };
}

/** Whether `file -b` says this target (Linux's and macOS's `file` word it slightly differently). */
export function fileSaysOk(name, said) {
  const { os, cpu } = PLATFORMS[name];
  if (os === "darwin") return /Mach-O 64-bit/.test(said) && (cpu === "arm64" ? /\barm64\b/.test(said) && !/x86_64/.test(said) : /x86_64/.test(said) && !/\barm64\b/.test(said));
  const machine = cpu === "x64" ? /x86-64/.test(said) : /aarch64/.test(said);
  return /^ELF 64-bit LSB/.test(said) && machine && /(statically linked|static-pie linked)/.test(said);
}

/** Problems with one bundled binary's file and header (empty: none). `file`, `lipo` and `codesign`: what this
 * machine's tools said (each null when not run here). */
export function binaryProblems(name, { mode, isFile, bytes, file = null, lipo = null, codesign = null }) {
  if (!isFile) return [`${name}: not a regular file`];
  const problems = [];
  if ((mode & 0o7777) !== 0o755) problems.push(`${name}: mode ${(mode & 0o7777).toString(8)}, not 755`);
  const header = headerOf(bytes);
  if (header.why !== undefined) return [...problems, `${name}: ${header.why}`];
  if (header.platform !== name) problems.push(`${name}: its header says ${header.platform}`);
  if (PLATFORMS[name].os === "darwin" && header.signed !== true) problems.push(`${name}: no code signature`);
  if (PLATFORMS[name].os === "linux" && header.static !== true) problems.push(`${name}: not a static binary (it names a program interpreter)`);
  if (file !== null && !fileSaysOk(name, file)) problems.push(`${name}: file says ${JSON.stringify(file)}`);
  if (lipo !== null && lipo !== (PLATFORMS[name].cpu === "arm64" ? "arm64" : "x86_64")) problems.push(`${name}: lipo -archs says ${JSON.stringify(lipo)}`);
  if (codesign !== null && codesign !== "valid") problems.push(`${name}: codesign -v says ${JSON.stringify(codesign)}`);
  return problems;
}

/** Problems with a self-check answer against the contract digest it must name. */
export function selfCheckProblems(name, line, contract) {
  const text = String(line ?? "").trim();
  const said = SELF_CHECK.exec(text);
  if (said === null) return [`${name}: its self-check said ${JSON.stringify(text.slice(0, 120))}`];
  return said[1] === contract ? [] : [`${name}: its self-check names contract ${said[1].slice(0, 12)}…, this build's is ${String(contract).slice(0, 12)}…`];
}

/** Problems with `npm pack --dry-run --json`'s file list: exactly `names`' binaries under dist/tui, each mode 0755. */
export function packProblems(files, names) {
  const problems = [];
  const under = files.filter(one => String(one.path).startsWith("dist/tui/"));
  for (const name of names) {
    const entry = under.find(one => one.path === `dist/tui/${name}/${BINARY}`);
    if (entry === undefined) problems.push(`the package doesn't hold dist/tui/${name}/${BINARY}`);
    else if ((entry.mode & 0o777) !== 0o755) problems.push(`the package holds dist/tui/${name}/${BINARY} as mode ${(entry.mode & 0o777).toString(8)}, not 755`);
  }
  const wanted = new Set(names.map(name => `dist/tui/${name}/${BINARY}`));
  for (const one of under) if (!wanted.has(one.path)) problems.push(`the package holds an unexpected file ${one.path}`);
  return problems;
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const tool = (command, args) => {
  const ran = spawnSync(command, args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }, timeout: 30_000 });
  return ran.error === undefined ? { status: ran.status, out: `${ran.stdout ?? ""}`.trim(), err: `${ran.stderr ?? ""}`.trim() } : null;
};
/** This machine's own target, or null. */
const host = () => Object.keys(PLATFORMS).find(name => PLATFORMS[name].os === process.platform && PLATFORMS[name].cpu === process.arch) ?? null;
/** `binary --version`, run directly (no shell, a bare environment). */
function runSelfCheck(binary) {
  const ran = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
  return ran.status === 0 ? `${ran.stdout ?? ""}`.trim() : `exit ${ran.status ?? ran.signal ?? ran.error?.code}`;
}
/** What this machine's tools say about `path` (null where the tool isn't here or doesn't apply). */
function toolsSay(name, path) {
  const file = tool("file", ["-b", path]);
  const onMac = process.platform === "darwin" && PLATFORMS[name].os === "darwin";
  const lipo = onMac ? tool("lipo", ["-archs", path]) : null;
  const codesign = onMac ? tool("codesign", ["-v", "--strict", path]) : null;
  return {
    file: file === null || file.status !== 0 ? null : file.out,
    lipo: lipo === null ? null : lipo.status === 0 ? lipo.out : `exit ${lipo.status}`,
    codesign: codesign === null ? null : codesign.status === 0 ? "valid" : codesign.err || `exit ${codesign.status}`,
  };
}

function cargoBuild(name, profile) {
  const platform = PLATFORMS[name];
  const env = { ...process.env, PATH: `/opt/homebrew/opt/rustup/bin:${process.env.PATH}` };
  const linkerVar = `CARGO_TARGET_${platform.target.toUpperCase().replaceAll("-", "_")}_LINKER`;
  const buildEnv = platform.os === "linux" ? { ...env, [linkerVar]: "rust-lld" } : env;
  const result = spawnSync("cargo", ["build", "--locked", "--profile", profile, "--target", platform.target, "-p", "toolroll-tui"], { cwd: tui, env: buildEnv, stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0) return { ok: false, why: result.stderr.toString().split("\n").filter(line => /error/.test(line)).slice(0, 3) };
  return { ok: true, binary: join(tui, "target", platform.target, profile, BINARY) };
}

/**
 * Copy a built binary to `to`, mode 0755. A macOS one is ad-hoc signed (no identity, no notarization: an npm-extracted
 * file carries no quarantine, so Gatekeeper never assesses it); Apple's linker signs arm64 output itself but x86_64
 * output comes out unsigned, so every macOS binary is signed the same way here, which only a Mac can do.
 */
function place(name, from, to, { mustSign }) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  chmodSync(to, 0o755);
  if (PLATFORMS[name].os !== "darwin") return;
  if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", "--force", to]);
  else if (mustSign) throw new Error(`${name}: a macOS binary is signed only on a Mac`);
}

function bundle({ targets, profile, dir, reports }) {
  const contract = JSON.parse(readFileSync(join(root, "test", "fixtures", "engine-api", "schemas.json"), "utf8")).digest;
  let failed = false;
  for (const name of targets) {
    const started = Date.now();
    const built = cargoBuild(name, profile);
    if (!built.ok) { console.log(JSON.stringify({ platform: name, built: false, why: built.why })); failed = true; continue; }
    const to = bundled(dir, name);
    place(name, built.binary, to, { mustSign: true });
    const bytes = readFileSync(to);
    const stat = lstatSync(to);
    const problems = binaryProblems(name, { mode: stat.mode, isFile: stat.isFile(), bytes, ...toolsSay(name, to) });
    // On its own platform the self-check runs here, against the contract this tree was written against.
    const selfCheck = name === host() ? runSelfCheck(to) : null;
    if (selfCheck !== null) problems.push(...selfCheckProblems(name, selfCheck, contract));
    const report = { platform: name, profile, sha256: sha256(bytes), bytes: bytes.length, self_check: selfCheck, seconds: Math.round((Date.now() - started) / 100) / 10, problems };
    if (reports !== null) { mkdirSync(reports, { recursive: true }); writeFileSync(join(reports, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`); }
    console.log(JSON.stringify(report));
    if (problems.length > 0) failed = true;
  }
  return failed ? 1 : 0;
}

function adopt({ targets, from }) {
  const into = join(root, "dist", "tui");
  for (const name of targets) {
    const source = bundled(from, name);
    if (!existsSync(source)) { console.error(`no ${name} binary at ${source}`); return 1; }
    const folder = join(into, name);
    if (existsSync(folder) && readdirSync(folder).some(one => one !== BINARY)) { console.error(`${folder} holds something besides ${BINARY}`); return 1; }
    mkdirSync(folder, { recursive: true });
    copyFileSync(source, bundled(into, name));
    chmodSync(bundled(into, name), 0o755);
    console.log(`placed ${name}: dist/tui/${name}/${BINARY} (sha256 ${sha256(readFileSync(bundled(into, name)))})`);
  }
  return 0;
}

async function verify({ targets, reports }) {
  const problems = [];
  // THIS build's contract: the engine module this package ships (so it is built first: npm run build).
  const engine = join(root, "dist", "contracts", "engine-api.js");
  if (!existsSync(engine)) { console.error(`REFUSED: no ${engine} (build first: npm run build)`); return 1; }
  const contract = (await import(pathToFileURL(engine).href)).engineContractDigest();
  const into = join(root, "dist", "tui");
  const checked = [];
  for (const name of targets) {
    const path = bundled(into, name);
    let stat;
    try { stat = lstatSync(path); } catch { problems.push(`${name}: no binary at dist/tui/${name}/${BINARY}`); continue; }
    const bytes = stat.isFile() ? readFileSync(path) : Buffer.alloc(0);
    problems.push(...binaryProblems(name, { mode: stat.mode, isFile: stat.isFile(), bytes, ...toolsSay(name, path) }));
    if (name === host()) problems.push(...selfCheckProblems(name, runSelfCheck(path), contract));
    let report = null;
    if (reports !== null) { try { report = JSON.parse(readFileSync(join(reports, `${name}.json`), "utf8")); } catch { report = null; } }
    if (report !== null) {
      if (report.sha256 !== sha256(bytes)) problems.push(`${name}: its build's report is for another file (sha256 ${String(report.sha256).slice(0, 12)}…)`);
      problems.push(...selfCheckProblems(name, report.self_check, contract));
    } else if (name !== host()) problems.push(`${name}: no self-check recorded on its own platform (--reports)`);
    checked.push({ platform: name, sha256: sha256(bytes), bytes: bytes.length });
  }
  // What `npm publish` would pack from this tree.
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, npm_config_update_notifier: "false" } });
  let listing = null;
  try { listing = JSON.parse(packed.stdout)[0]; } catch { problems.push(`npm pack --dry-run failed: ${`${packed.stderr ?? ""}`.trim().split("\n").slice(-3).join(" ")}`); }
  if (listing !== null && listing !== undefined) problems.push(...packProblems(listing.files ?? [], targets));
  console.log(JSON.stringify({ contract, checked, package: listing == null ? null : { size: listing.size, unpackedSize: listing.unpackedSize, entryCount: listing.entryCount }, problems }, null, 2));
  if (problems.length > 0) { for (const one of problems) console.error(`REFUSED: ${one}`); return 1; }
  console.log(`verified: ${targets.join(", ")} (contract ${contract})`);
  return 0;
}

/** The optional-package layout: one npm package per platform (see the header). */
function packages({ targets, profile, out, smoke }) {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const env = { ...process.env, PATH: `/opt/homebrew/opt/rustup/bin:${process.env.PATH}` };
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "tarballs"), { recursive: true });
  const built = [];
  for (const name of targets) {
    const started = Date.now();
    const result = cargoBuild(name, profile);
    if (!result.ok) { console.log(JSON.stringify({ platform: name, built: false, why: result.why })); continue; }
    const dir = join(out, name);
    place(name, result.binary, join(dir, "bin", BINARY), { mustSign: false });
    const platform = PLATFORMS[name];
    const pkg = {
      name: `@toolroll/tui-${name}`, version,
      description: `Toolroll's terminal workbench for ${name} (installed by toolroll as an optional dependency).`,
      license: "MIT", repository: { type: "git", url: "git+https://github.com/ap9000/toolroll.git" },
      os: [platform.os], cpu: [platform.cpu], files: [`bin/${BINARY}`], preferUnplugged: true,
    };
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(join(dir, "README.md"), `# ${pkg.name}\n\nThe ${name} binary of Toolroll's terminal workbench. Install \`toolroll\`, not this package.\n`);
    const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", join(out, "tarballs")], { cwd: dir, env }).toString();
    const file = JSON.parse(packed)[0].filename;
    const tarball = join(out, "tarballs", file);
    built.push({ name, tarball });
    console.log(JSON.stringify({ platform: name, built: true, seconds: Math.round((Date.now() - started) / 100) / 10, binary_bytes: statSync(result.binary).size, tarball_bytes: statSync(tarball).size, tarball: file }));
  }
  if (smoke !== null) runSmoke(resolve(smoke), { built, version, env });
  return 0;
}

/** The launcher sketch for the optional-package smoke: resolve, self-check, run; else the classic screen. */
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

function runSmoke(dir, { built, version, env }) {
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
    const shown = spawnSync(bin, ["--version"], { encoding: "utf8" });
    report.installs.push({
      omit_optional: omit, install_status: install.status, install_seconds: Math.round((Date.now() - started) / 100) / 10,
      install_stderr: install.stderr.trim().split("\n").filter(line => line !== "").slice(-3),
      resolved: which.stdout.trim(), run: shown.stdout.trim().split("\n"),
    });
  }
  writeFileSync(join(dir, "smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

async function main(args) {
  const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
  const targets = opt("--targets", Object.keys(PLATFORMS).join(",")).split(",").filter(Boolean);
  const unknown = targets.filter(name => !Object.hasOwn(PLATFORMS, name));
  if (unknown.length > 0) { console.error(`unknown platform ${unknown.join(", ")}`); return 2; }
  const profile = opt("--profile", "release");
  const reports = opt("--reports", null) === null ? null : resolve(opt("--reports", ""));
  if (args.includes("--bundle")) {
    const dir = opt("--bundle", null);
    if (dir === null || dir.startsWith("--")) { console.error("--bundle needs a folder"); return 2; }
    return bundle({ targets, profile, dir: resolve(dir), reports });
  }
  if (args.includes("--adopt")) {
    const from = opt("--adopt", null);
    if (from === null || from.startsWith("--")) { console.error("--adopt needs a folder"); return 2; }
    return adopt({ targets, from: resolve(from) });
  }
  if (args.includes("--verify")) return verify({ targets, reports });
  return packages({ targets, profile, out: resolve(opt("--out", join(tui, "npm"))), smoke: opt("--smoke", null) });
}

// Run only when started as a script (its test imports the checks above and runs nothing).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
