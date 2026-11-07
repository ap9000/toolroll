#!/usr/bin/env node
/**
 * The fenced-run harness (docs/plans/check-access.md, docs/plans/trusted-release-reports.md H3): runs a project's Full
 * check under the real check fence, at a level you name, and writes down what happened, so the choice of how a release's
 * check runs comes from a measurement and not a guess. It changes no project's setting and touches no real Toolroll
 * state: everything it needs is a temporary store and a scratch clone, removed afterwards. Needs `npm run build`.
 *
 *   node scripts/fenced-run.mjs measure --level sandboxed|sign-ins --out <file> [--repo <checkout>] [--commit <sha>]
 *                                       [--minutes <n>] [--command <shell command>] [--setup <shell command>]
 *   node scripts/fenced-run.mjs cover --measurement <file> --ci-reports <folder>
 *   node scripts/fenced-run.mjs verdict <measurement>...
 *
 * `measure` clones the checkout's commit, installs it (no scripts) and runs `node scripts/release-check.mjs --full` in the
 * same fence the plane gives a saved result's check (invoke.ts fencedCheckoutCommands), reading its report as the plane
 * does. `--command` runs something else there instead (a smoke of the fence itself).
 * `cover` matches every skipped case against the reports of that commit's macOS CI, each shard's newest attempt
 * (`gh run download <run> --pattern 'macos-shard-*' --dir <folder>`), by case identity.
 * `verdict` says the narrowest level the measurements fully cover (fenced-check-coverage.ts measuredLevel).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = name => import(new URL(`../dist/${name}.js`, import.meta.url).href);
const HOURS = 60;

/** The handshake a plane sends a Full check that must run everything here: nothing is reused from CI. */
export function fullHandshake(nonce, limitMs) {
  return { nonce, mode: "full", plan: null, watch: [], owed: ["typecheck", "build", "unit", "flows", "app", "upgrade"], ciSubstitute: false, reportBytes: 256 * 1024, limitMs };
}

const flagOf = (args, name) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export async function measure({ level, out, repo = ROOT, commit, minutes = 3 * HOURS, command, setup = "npm ci --ignore-scripts" }) {
  if (level !== "sandboxed" && level !== "sign-ins") throw new Error("--level is sandboxed or sign-ins: an unsandboxed run needs no measuring, and is what runs today");
  const { fencedCheckoutCommands } = await dist("invoke");
  const { macosFenceAvailable, linuxFenceAvailable, checkLaunchRoot, LEGACY_SANDBOX } = await dist("agent-fence");
  const { run } = await dist("exec");
  const { openStore, runCheckStamp } = await dist("store");
  const { reportFromOutput } = await dist("check-report");
  const { skippedCases } = await dist("fenced-check-coverage");
  const { resolveNetwork, repositoryEcosystems } = await dist("egress");
  if (!macosFenceAvailable() && !linuxFenceAvailable()) throw new Error("this machine has no OS fence, so nothing here can be measured");
  const sha = commit ?? git(repo, "rev-parse", "HEAD");
  const scratch = realpathSync(mkdtempSync(join(checkLaunchRoot(), "so-fenced-run-")));
  const started = Date.now();
  // One id for the stamps: this harness's store is its own and has no runs.
  const RUN = 1;
  let store = null;
  try {
    const clone = join(scratch, "project");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", repo, clone]);
    const checkout = join(scratch, "worktrees", "measured");
    mkdirSync(dirname(checkout), { recursive: true });
    git(clone, "worktree", "add", "--quiet", "--detach", checkout, sha);
    store = openStore(join(scratch, "state", "orders.db"));
    const network = level === "sign-ins" ? resolveNetwork("command", store.projectNetwork(clone), repositoryEcosystems(clone)) : undefined;
    const fenced = fencedCheckoutCommands(store, clone, checkout, run, undefined, level, network, LEGACY_SANDBOX, [RUN]);
    const limitMs = minutes * 60_000;
    const steps = [];
    const shell = (text, stdin) => fenced("/bin/sh", ["-c", text], { cwd: checkout, timeoutMs: limitMs, processGroup: true, ...(stdin === undefined ? {} : { stdin }) });
    if (command === undefined) {
      const installed = await shell(setup);
      steps.push({ name: "setup", code: installed.code, timedOut: installed.timedOut });
      if (installed.code !== 0) process.stderr.write(installed.stderr.slice(-2000));
    }
    const nonce = randomBytes(32).toString("hex");
    const ran = steps.some(one => one.code !== 0) ? null : await shell(command ?? "node scripts/release-check.mjs --full", command === undefined ? JSON.stringify(fullHandshake(nonce, limitMs)) : undefined);
    const read = ran === null || command !== undefined ? null : reportFromOutput(ran.stdout, nonce);
    const report = read?.ok === true ? read.report : null;
    const measurement = {
      version: 1, level, commit: sha, at: new Date(started).toISOString(), seconds: Math.round((Date.now() - started) / 1000), steps,
      exitCode: ran?.code ?? null, timedOut: ran?.timedOut ?? false, passed: ran !== null && ran.code === 0 && (command !== undefined || report !== null),
      report: read === null ? null : read.ok ? "read" : read.problem,
      parts: report?.parts.map(part => ({ part: part.part, ran: part.ran, code: part.code, timedOut: part.timedOut })) ?? [],
      skipped: report === null ? [] : skippedCases(report),
      failed: (report?.units?.identities ?? []).filter(one => one.state === "failed").map(one => `unit:${one.file}::${one.name}`),
      stamp: runCheckStamp(store, RUN),
      ...(command === undefined ? {} : { stdout: ran?.stdout.slice(-4000) ?? "", stderr: ran?.stderr.slice(-4000) ?? "" }),
    };
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, `${JSON.stringify(measurement, null, 2)}\n`);
    return measurement;
  } finally {
    try { store?.close(); } catch { /* closed */ }
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The reports in a `gh run download` folder, each shard's newest attempt, whatever their names' shape. */
export function downloadedReports(folder) {
  const newest = new Map();
  for (const name of readdirSync(folder)) {
    const match = /^macos-(shard-\d+-\d+)-a([1-9]\d*)$/.exec(name);
    if (match === null) throw new Error(`unexpected ${name} among the macOS reports`);
    const was = newest.get(match[1]);
    if (was === undefined || Number(match[2]) > was.attempt) newest.set(match[1], { attempt: Number(match[2]), name });
  }
  return [...newest.values()].map(one => JSON.parse(readFileSync(join(folder, one.name, "shard-report.json"), "utf8")));
}

async function cover(file, folder, root) {
  const { macosCases, skipCoverage } = await dist("fenced-check-coverage");
  const measurement = JSON.parse(readFileSync(file, "utf8"));
  const coverage = skipCoverage(measurement.skipped, macosCases(downloadedReports(folder), root));
  const saved = { ...measurement, coverage };
  writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
  console.log(`${measurement.level} at ${measurement.commit.slice(0, 12)}: ${measurement.skipped.length} skipped, ${coverage.covered.length} covered by macOS CI, ${coverage.exempt.length} exempt, ${coverage.uncovered.length} not covered`);
  for (const one of coverage.uncovered) console.log(`  not covered: ${one}`);
}

async function verdict(files) {
  const { measuredLevel } = await dist("fenced-check-coverage");
  const measured = files.map(file => JSON.parse(readFileSync(file, "utf8"))).map(one => ({ level: one.level, passed: one.passed === true, uncovered: one.coverage === undefined ? Infinity : one.coverage.uncovered.length }));
  for (const one of measured) console.log(`${one.level}: ${one.passed ? "passed" : "didn't pass"}, ${one.uncovered === Infinity ? "skips not matched to CI yet" : `${one.uncovered} not covered`}`);
  console.log(`A release's check can run: ${measuredLevel(measured)}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "measure") {
    const out = flagOf(args, "out");
    if (out === undefined) { console.error("--out <file> is needed"); process.exit(2); }
    const minutes = flagOf(args, "minutes");
    const done = await measure({ level: flagOf(args, "level"), out, repo: flagOf(args, "repo") ?? ROOT, commit: flagOf(args, "commit"), command: flagOf(args, "command"), ...(flagOf(args, "setup") === undefined ? {} : { setup: flagOf(args, "setup") }), ...(minutes === undefined ? {} : { minutes: Number(minutes) }) });
    console.log(`${done.level}: ${done.passed ? "passed" : "didn't pass"} in ${done.seconds}s, ${done.skipped.length} cases skipped; written to ${out}`);
    process.exit(done.passed ? 0 : 1);
  }
  if (command === "cover") {
    const repoName = flagOf(args, "repo-name") ?? "toolroll";
    await cover(flagOf(args, "measurement"), flagOf(args, "ci-reports"), `/Users/runner/work/${repoName}/${repoName}`);
    process.exit(0);
  }
  if (command === "verdict") { await verdict(args); process.exit(0); }
  console.error("usage: fenced-run.mjs measure|cover|verdict");
  process.exit(2);
}
