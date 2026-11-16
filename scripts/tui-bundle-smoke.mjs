#!/usr/bin/env node
/**
 * The packed install opens the Rust screen it carries (.github/workflows/tui-bundle.yml). On a throwaway computer of
 * its own (scripts/isolated-env.mjs), it packs this checkout (built, with this machine's binary already at
 * dist/tui/<platform>-<arch>/toolroll-tui: `node scripts/tui-build.mjs --bundle dist/tui --targets <this machine's>`),
 * `npm i -g`s the tarball into a scratch prefix with its own npm cache (never the global npm), and then:
 *
 *   - bare `toolroll` from that install, in a real pseudo-terminal (scripts/tui-e2e.mjs --expect bundled), must open the
 *     terminal workbench by the binary the package ships, with no --tui-binary, seen running by its real path;
 *   - with that binary deleted from the install (scripts/tui-e2e.mjs --expect classic), it must open the classic Ink
 *     screen with the launcher's one-line notice.
 *
 *   node scripts/tui-bundle-smoke.mjs --out <empty folder> [--tarball <file.tgz>] [--keep]
 *
 * Every child starts with the world's environment (built from nothing, checked by assertIsolated right before each
 * spawn): its own HOME, XDG folders, temp folder, npm prefix, cache and config, stand-ins for the browser openers and
 * the service supervisors, no credentials. The journeys pick their own port (never 4180). Exit 0 when both passed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertIsolated, isolatedEnvironment } from "./isolated-env.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const key = `${process.platform}-${process.arch}`;

const outArg = option("--out");
if (outArg === null) { console.error("usage: node scripts/tui-bundle-smoke.mjs --out <empty folder> [--tarball <file.tgz>] [--keep]"); process.exit(2); }
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
if (readdirSync(out).length > 0) { console.error(`--out ${out} is not empty`); process.exit(2); }

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) throw new Error(name);
};

const rootDir = join(realpathSync(out), "world");
mkdirSync(rootDir);
const prefix = join(rootDir, "prefix"), cache = join(rootDir, "npm-cache"), packDir = join(rootDir, "pack");
for (const one of [prefix, cache, packDir]) mkdirSync(one);
const userNpmrc = join(rootDir, "npmrc"), globalNpmrc = join(rootDir, "npmrc-global");
writeFileSync(userNpmrc, "");
writeFileSync(globalNpmrc, "");
const world = isolatedEnvironment({ root: rootDir, set: {
  npm_config_prefix: prefix, npm_config_cache: cache, npm_config_userconfig: userNpmrc, npm_config_globalconfig: globalNpmrc,
  npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", npm_config_loglevel: "error",
  // A registry mirror the caller set on purpose still applies.
  ...(process.env.npm_config_registry ? { npm_config_registry: process.env.npm_config_registry } : {}),
} });
/** A child of the world: its environment checked right before the spawn. */
const run = (command, argv, { cwd = rootDir, timeout = 300_000, stdio = "pipe" } = {}) => {
  assertIsolated(world.env, { root: rootDir });
  const ran = spawnSync(command, argv, { cwd, env: world.env, timeout, encoding: "utf8", stdio, maxBuffer: 64 * 1024 * 1024 });
  return { code: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
};
const tail = text => String(text).trim().split("\n").slice(-8).join("\n      ");

let code = 0;
try {
  const local = join(repo, "dist", "tui", key, "toolroll-tui");
  check(`this checkout carries its ${key} binary`, existsSync(local), local);

  let tarball = option("--tarball") === null ? null : resolve(option("--tarball"));
  if (tarball === null) {
    const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { cwd: repo });
    let file = null;
    try { file = JSON.parse(packed.stdout)[0].filename; } catch { /* reported below */ }
    check("npm pack", packed.code === 0 && file !== null, file ?? tail(packed.stderr));
    tarball = join(packDir, file);
  }
  const listed = run("tar", ["-tzvf", tarball]);
  const entry = listed.stdout.split("\n").find(line => line.endsWith(` package/dist/tui/${key}/toolroll-tui`)) ?? "";
  check(`the tarball holds dist/tui/${key}/toolroll-tui, executable`, /^-rwxr-xr-x/.test(entry), entry.trim() || "missing");

  const installed = run("npm", ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  check("npm i -g <tarball> into the throwaway prefix", installed.code === 0, installed.code === 0 ? prefix : tail(installed.stderr || installed.stdout));
  const pkg = join(prefix, "lib", "node_modules", "toolroll");
  const bin = join(pkg, "dist", "bin.js");
  const shipped = join(pkg, "dist", "tui", key, "toolroll-tui");
  check("the install carries the binary", existsSync(shipped) && (statSync(shipped).mode & 0o777) === 0o755, `${shipped} mode ${existsSync(shipped) ? (statSync(shipped).mode & 0o777).toString(8) : "missing"}`);

  // Bare `toolroll` from the install: the bundled workbench (no --tui-binary), then the classic screen without it.
  const journey = (expect) => {
    const folder = join(out, expect);
    const ran = run(process.execPath, [join(repo, "scripts", "tui-e2e.mjs"), "--out", folder, "--no-model", "--toolroll", bin, "--expect", expect], { cwd: repo, timeout: 600_000 });
    const lines = `${ran.stdout}\n${ran.stderr}`.trim().split("\n");
    return { ok: ran.code === 0, detail: ran.code === 0 ? `${folder}/report.json` : lines.slice(-40).join("\n      ") };
  };
  const bundled = journey("bundled");
  check("bare toolroll opens the bundled workbench", bundled.ok, bundled.detail);
  rmSync(shipped);
  const classic = journey("classic");
  check("without it, the classic screen with the notice", classic.ok, classic.detail);
} catch (error) {
  code = 1;
  if (!results.some(one => !one.ok)) console.log(`FAIL  unexpected error — ${error?.stack ?? error}`);
}
console.log(`\n${code === 0 ? "PASSED" : "FAILED"}: ${results.filter(one => one.ok).length} of ${results.length} checks`);
if (!args.includes("--keep")) rmSync(rootDir, { recursive: true, force: true });
process.exit(code);
