#!/usr/bin/env node
/**
 * The Quick check: typecheck, the tests named after the changed files, and the attack suite (test/attacks) whenever a
 * security-critical file changed. AGENTS.md's "tests named after your changed files": src/foo.ts runs src/foo.test.ts
 * and src/foo.*.test.ts; a changed test file runs itself; scripts/foo.mjs runs src/foo.test.ts. Nothing follows imports
 * (`vitest related` pulls most of the suite for a core file). A change to a guard below, or to the suite itself, runs
 * every attack in under a minute, so an old bypass can't reopen unnoticed.
 *
 * node scripts/quick-check.mjs [--base <ref>] [--plan]
 *
 * Changed files are those between --base (default HEAD~1, the build's own commit) and the working tree, plus untracked
 * ones. --plan prints what would run and runs nothing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The guards a build's attacks go after: a change to one runs the whole attack suite. teardown-git.ts is the one
 * helper every teardown's Git goes through (landed-cleanup, worktree, checkout-cleanup). */
export const SECURITY_CRITICAL = [
  "src/agent-fence.ts", "src/tool-broker.ts", "src/provider-home.ts", "src/invoke.ts", "src/project-tools.ts",
  "src/landed-cleanup.ts", "src/worktree.ts", "src/checkout-cleanup.ts", "src/flow-unattended.ts", "src/teardown-git.ts",
  "src/sandbox-runtime.ts",
];
export const ATTACK_SUITE = ["vitest", "run", "--config", "test/attacks/vitest.config.ts"];
const TEST = /\.test\.tsx?$/;

/**
 * What the Quick check runs for these changed paths (repository-relative, `/`-separated). `list(folder)` names a
 * folder's files (the real one reads the checkout). `attacks` says why the attack suite runs, or null.
 */
export function quickPlan(changed, list) {
  const tests = new Set();
  const listed = folder => { try { return list(folder); } catch { return []; } };
  const named = (folder, stem) => {
    for (const file of listed(folder)) if (file === `${stem}.test.ts` || (file.startsWith(`${stem}.`) && TEST.test(file))) tests.add(`${folder}/${file}`);
  };
  for (const file of changed) {
    if (file.startsWith("test/attacks/")) continue;
    if (TEST.test(file) && file.startsWith("src/")) {
      if (listed(dirname(file)).includes(basename(file))) tests.add(file);
    } else if (/^src\/.+\.tsx?$/.test(file)) {
      named(dirname(file), basename(file).replace(/\.tsx?$/, ""));
    } else if (/^scripts\/[^/]+\.mjs$/.test(file)) {
      named("src", basename(file, ".mjs"));
    }
  }
  const guard = changed.find(file => SECURITY_CRITICAL.includes(file));
  const suite = changed.find(file => file.startsWith("test/attacks/"));
  const attacks = guard !== undefined ? `${guard} is security-critical` : suite !== undefined ? `${suite} is part of the attack suite` : null;
  return { tests: [...tests].sort(), attacks };
}

const git = (...argv) => execFileSync("git", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const nul = text => text.split("\0").filter(Boolean);

/** Changed and untracked paths since `base`; a base that can't be read (a first commit) compares with the empty tree. */
export function changedSince(base) {
  let diff;
  try { diff = git("diff", "--name-only", "-z", "--no-renames", base, "--"); }
  catch { diff = git("diff", "--name-only", "-z", "--no-renames", git("hash-object", "-t", "tree", "/dev/null").trim(), "--"); }
  return [...new Set([...nul(diff), ...nul(git("ls-files", "-z", "--others", "--exclude-standard"))])].sort();
}

function step(label, file, args, env = process.env) {
  const started = Date.now();
  console.log(`\n▶ ${label}: ${[file, ...args].join(" ")}`);
  const ran = spawnSync(file, args, { stdio: "inherit", env });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (ran.status !== 0) {
    console.error(`✗ ${label} failed (${ran.status ?? ran.signal}) after ${seconds}s`);
    process.exit(ran.status ?? 1);
  }
  console.log(`✓ ${label} passed in ${seconds}s`);
}

function main() {
  const args = process.argv.slice(2);
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "HEAD~1";
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.chdir(root);
  const changed = changedSince(base);
  const plan = quickPlan(changed, folder => readdirSync(join(root, folder)));
  console.log(`Quick check against ${base} (${changed.length} changed): typecheck; ${plan.tests.length === 0 ? "no tests named after the changes" : `${plan.tests.length} test file(s) named after the changes`}; ${plan.attacks === null ? "no attack suite (no security-critical file changed)" : `the attack suite (${plan.attacks})`}.`);
  if (args.includes("--plan")) {
    for (const file of plan.tests) console.log(`  ${file}`);
    return;
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  step("Typecheck", process.platform === "win32" ? "npm.cmd" : "npm", ["run", "typecheck"]);
  if (plan.tests.length > 0) step("Tests named after the changes", npx, ["vitest", "run", ...plan.tests]);
  if (plan.attacks !== null) {
    const folder = mkdtempSync(join(tmpdir(), "toolroll-attack-skips-"));
    const skips = join(folder, "skipped.txt");
    try {
      step("Attack suite", npx, ATTACK_SUITE, { ...process.env, TOOLROLL_ATTACK_SKIPS: skips });
      const skipped = existsSync(skips) ? readFileSync(skips, "utf8").split("\n").filter(Boolean) : [];
      if (skipped.length > 0) {
        console.log(`! ${skipped.length} native attack check(s) skipped, so their sandbox half is unproven here:`);
        for (const line of skipped) console.log(`  ${line}`);
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
