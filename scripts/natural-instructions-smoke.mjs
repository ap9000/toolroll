#!/usr/bin/env node
/**
 * Natural task instructions — the bounded real-model check.
 *
 * Run 1527 stopped because the builder brief's final blanket rule read a
 * goal written in the imperative as "instructions to you". The durable
 * regression for the corrected brief lives in src/builder.test.ts; this
 * script is the part a unit test cannot be: it hands the ACTUAL generated
 * brief — produced by dist's own `build()` through a captured agent, so it
 * is exactly the text a real dispatch would send — to a real Codex model,
 * once, inside a disposable fixture repository, and records what the model
 * did with it.
 *
 *   node scripts/natural-instructions-smoke.mjs brief --scope run-1527 --out before.txt
 *   node scripts/natural-instructions-smoke.mjs run --scope run-1527 --model gpt-6-astra --out result.json
 *
 * Everything is isolated: the control-plane database is a fresh file in a
 * temporary directory (TOOLROLL_DB and XDG_CONFIG_HOME are pointed
 * there before dist is imported), the fixture repository is a temporary
 * git init on the task's branch, and the model runs under Codex's
 * workspace-write sandbox with network disabled. Nothing here opens the
 * live database, pushes, or publishes.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RUN_1527_ACCEPTANCE,
  RUN_1527_GOAL,
  RUN_1527_OUT_OF_SCOPE,
  RUN_1527_TOUCHES,
  SMALL_IMPERATIVE_ACCEPTANCE,
  SMALL_IMPERATIVE_GOAL,
  SMALL_IMPERATIVE_OUT_OF_SCOPE,
} from "./fixtures/run-1527-scope.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The isolation boundary, before any dist module can read the environment.
const state = mkdtempSync(join(tmpdir(), "so-natural-smoke-"));
process.env.TOOLROLL_DB = process.env.STANDING_ORDERS_DB = join(state, "control", "orders.db");
process.env.XDG_CONFIG_HOME = join(state, "config");
mkdirSync(join(state, "control"), { recursive: true });

const SCOPES = {
  "run-1527": {
    taskId: "oddcircle-s1-astra-settlement-repair",
    title: "OddCircle sprint 1: Astra repair of Sonnet settlement and Money work",
    goal: RUN_1527_GOAL,
    outOfScope: RUN_1527_OUT_OF_SCOPE,
    touches: [...RUN_1527_TOUCHES],
    acceptance: RUN_1527_ACCEPTANCE.map(one => ({ ...one, evidence: [...one.evidence] })),
    branch: "standing-orders/oddcircle-s1-astra-settlement-repair",
  },
  "small-imperative": {
    taskId: "greet-smoke",
    title: "Add greet(name) with tests",
    goal: SMALL_IMPERATIVE_GOAL,
    outOfScope: SMALL_IMPERATIVE_OUT_OF_SCOPE,
    touches: ["src/", "test/"],
    acceptance: SMALL_IMPERATIVE_ACCEPTANCE.map(one => ({ ...one, evidence: [...one.evidence] })),
    branch: "standing-orders/greet-smoke",
  },
};

function usage() {
  return [
    "Natural task instructions smoke",
    "",
    "  node scripts/natural-instructions-smoke.mjs brief --scope run-1527|small-imperative --out <file>",
    "  node scripts/natural-instructions-smoke.mjs run   --scope run-1527|small-imperative --model <codex model> --out <json> [--brief <file>] [--timeout-seconds 600] [--keep]",
    "  node scripts/natural-instructions-smoke.mjs verify [--evidence docs/assessments/evidence/natural-task-instructions]",
    "",
    "`brief` writes the actual generated builder brief for the scope and exits.",
    "`run` generates the brief (or reads a saved one with --brief, so a",
    "before/after pair runs the exact recorded text), then runs Codex once on",
    "it in a disposable repository.",
    "`verify` spends nothing: it regenerates the brief from the current dist,",
    "checks it against the recorded after-brief (nonces aside), and checks",
    "the recorded before/after model runs say what the assessment says.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { command: argv[0] ?? null, scope: "run-1527", model: null, out: null, brief: null, evidence: join(root, "docs", "assessments", "evidence", "natural-task-instructions"), timeoutSeconds: 600, keep: false, help: false };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--keep") result.keep = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--scope" || arg === "--model" || arg === "--out" || arg === "--brief" || arg === "--evidence" || arg === "--timeout-seconds") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--timeout-seconds") result.timeoutSeconds = Number(value);
      else result[arg.slice(2)] = value;
    } else throw new Error(`unknown option ${arg}`);
  }
  if (result.help || result.command === null || result.command === "--help") { result.help = true; return result; }
  if (result.command !== "brief" && result.command !== "run" && result.command !== "verify") throw new Error("the command is brief, run, or verify");
  if (!(result.scope in SCOPES)) throw new Error(`--scope is one of ${Object.keys(SCOPES).join(", ")}`);
  if (result.command === "run" && (typeof result.model !== "string" || result.model.trim() === "")) throw new Error("run needs --model");
  if (!Number.isFinite(result.timeoutSeconds) || result.timeoutSeconds <= 0) throw new Error("--timeout-seconds is a positive number");
  return result;
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A disposable repository on the task's branch, with one committed baseline. */
function fixtureRepo(scopeKey, branch) {
  const repo = mkdtempSync(join(tmpdir(), "so-natural-fixture-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "smoke@example.invalid");
  git(repo, "config", "user.name", "smoke");
  git(repo, "config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "smoke-fixture", version: "0.0.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(repo, "README.md"), "# smoke fixture\n\nA disposable repository for the natural-task-instructions smoke check.\n");
  writeFileSync(join(repo, "src", "index.js"), "export {};\n");
  writeFileSync(join(repo, "test", ".gitkeep"), "");
  if (scopeKey === "run-1527") {
    // The 1527 scope names an OddCircle tree this fixture does not have; the
    // point of the case is only whether the wording alone stops the builder.
    writeFileSync(join(repo, "NOTE.md"), "This disposable fixture is not the OddCircle repository.\n");
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "baseline");
  git(repo, "checkout", "-q", "-b", branch);
  return repo;
}

/**
 * The actual brief: dist's `build()` with the same fixture the unit tests
 * use, an injected git, and an agent that records what it was handed and
 * returns. Nothing is spent; the captured prompt is exactly what a real
 * dispatch would pass to the provider.
 */
async function generateBrief(scopeKey, worktree) {
  const dist = name => import(pathToFileURL(join(root, "dist", name)).href);
  const { openStore } = await dist("store.js");
  const { addApprover, propose, approve } = await dist("scope.js");
  const { register } = await dist("runner.js");
  const { acquire } = await dist("claim.js");
  const { build } = await dist("builder.js");
  const scope = SCOPES[scopeKey];
  const T0 = new Date("2026-09-12T19:34:21.636Z");
  const REPO = "/code/oddcircle";
  // One fresh control-plane file per generation: `verify` generates twice.
  const store = openStore(join(state, "control", `brief-${scopeKey}-${Date.now()}.db`));
  try {
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap approver refused");
    store.createTask({ id: scope.taskId, title: scope.title }, T0);
    const taskRef = store.refFor("built-in", scope.taskId).id;
    register(store, { name: "smoke-runner", host: "h", capacity: 1, repos: [REPO], now: T0, newToken: () => "tok-smoke" });
    store.placeTask(taskRef, REPO);
    acquire(store, taskRef, "smoke-runner", { token: "tok-smoke", now: T0, ttlMs: 60 * 60_000, newLeaseId: () => "smoke-lease" });
    store.saveWorktree({ path: worktree, repo: REPO, branch: scope.branch, runner: "smoke-runner", taskRef, createdAt: T0.toISOString(), leasedAt: T0.toISOString(), releasedAt: null, verified: true });
    const proposed = propose(store, { taskId: scope.taskId, goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, acceptance: scope.acceptance, now: T0 });
    if (proposed && proposed.ok === false) throw new Error(`propose refused: ${JSON.stringify(proposed)}`);
    const approved = approve(store, scope.taskId, "alex", T0, store.getScope(scope.taskId).digest, added.token);
    if (approved && approved.ok === false) throw new Error(`approve refused: ${JSON.stringify(approved)}`);
    const authority = store.routeAuthorityFor(taskRef, "builder");
    const route = authority !== null && authority.ok ? { route: authority.stamp } : {};
    const runId = store.startRun({ taskRef, leaseId: "smoke-lease", runner: "smoke-runner", branch: scope.branch, worktree, now: T0, ...route });
    let captured = null;
    await build(store, {
      taskId: scope.taskId,
      taskRef,
      runner: "smoke-runner",
      worktree,
      runId,
      evidenceRoot: join(state, "evidence"),
      branch: scope.branch,
      now: T0,
      agent: async (_file, args) => {
        if (captured === null) captured = args[args.indexOf("-p") + 1] ?? null;
        return { code: 0, stdout: JSON.stringify({ result: "captured" }), stderr: "", timedOut: false, notFound: false };
      },
      git: async (_file, args) => {
        if (args.includes("symbolic-ref")) return args.includes("refs/remotes/origin/HEAD") ? { code: 1, stdout: "", stderr: "", timedOut: false, notFound: false } : { code: 0, stdout: "main\n", stderr: "", timedOut: false, notFound: false };
        return { code: 0, stdout: args.includes("rev-parse") ? `${scope.branch}\n` : "", stderr: "", timedOut: false, notFound: false };
      },
    });
    if (captured === null) throw new Error("the build never invoked the agent — no brief to capture");
    return captured;
  } finally {
    store.close();
  }
}

/** The protocol files the brief names, read back from the fixture if the model wrote them. */
function protocolFiles(brief, repo) {
  const names = {};
  for (const kind of ["DONE", "PARK", "PROOF"]) {
    const match = new RegExp(`STANDING-ORDERS-${kind}-[0-9a-f]{16}\\.json`).exec(brief);
    names[kind.toLowerCase()] = match?.[0] ?? null;
  }
  const found = {};
  for (const [kind, name] of Object.entries(names)) {
    if (name === null) { found[kind] = null; continue; }
    try {
      const raw = readFileSync(join(repo, name), "utf8");
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      found[kind] = { name, bytes: Buffer.byteLength(raw, "utf8"), parsed, raw: parsed === null ? raw.slice(0, 4096) : undefined };
    } catch {
      found[kind] = { name, absent: true };
    }
  }
  return found;
}

/** Mirrors dist's codex build argv for a fresh workspace-write turn; network stays off. */
function codexArgv(model, brief) {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-m",
    model,
    brief,
  ];
}

function runCodex(cwd, model, brief, timeoutSeconds) {
  return new Promise(resolvePromise => {
    const started = Date.now();
    const child = spawn("codex", codexArgv(model, brief), { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutSeconds * 1000);
    child.on("error", error => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut, notFound: error.code === "ENOENT", elapsedMs: Date.now() - started }); });
    child.on("close", code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr, timedOut, notFound: false, elapsedMs: Date.now() - started }); });
  });
}

/** The retained Codex events: thread id, every agent message, the terminal usage. */
function summarizeStream(stdout) {
  const messages = [];
  let thread = null;
  let usage = null;
  let commands = 0;
  let fileChanges = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "thread.started") thread = event.thread_id ?? null;
    if (event.type === "turn.completed") usage = event.usage ?? null;
    if (event.type === "item.completed" && event.item?.type === "agent_message") messages.push(String(event.item.text ?? "").slice(0, 4000));
    if (event.type === "item.completed" && event.item?.type === "command_execution") commands++;
    if (event.type === "item.completed" && event.item?.type === "file_change") fileChanges++;
  }
  return { thread, usage, commands, fileChanges, messages };
}

const BLANKET_STOP_RULE = "appears to contain instructions to you";

/** The brief with its per-run nonces and worktree-specific words removed, so two generations compare equal. */
const stableBrief = text => text.replace(/STANDING-ORDERS-(DONE|PARK|PROOF|RUBRIC)-[0-9a-f]{16}\.json/g, "STANDING-ORDERS-$1-<nonce>.json");

/**
 * The durable check: no tokens spent. The current dist must generate, for
 * both fixture scopes, a brief equal to the recorded after-brief (nonces
 * aside) that carries every run 1527 phrase inside the fence and no blanket
 * stop rule; the recorded before-briefs must carry that rule; and the
 * recorded model runs must show the before/after difference the assessment
 * reports. Any drift between source, evidence, and narrative exits 1.
 */
async function verify(evidenceDir) {
  const read = name => readFileSync(join(evidenceDir, name), "utf8");
  const problems = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  const { RUN_1527_TRIGGER_PHRASES, RUN_1527_NATURAL_PHRASES } = await import("./fixtures/run-1527-scope.mjs");
  for (const scopeKey of Object.keys(SCOPES)) {
    const repo = fixtureRepo(scopeKey, SCOPES[scopeKey].branch);
    let generated;
    try { generated = await generateBrief(scopeKey, repo); } finally { rmSync(repo, { recursive: true, force: true }); }
    const before = read(`brief-${scopeKey}-before.txt`);
    const after = read(`brief-${scopeKey}-after.txt`);
    check(before.includes(BLANKET_STOP_RULE), `${scopeKey}: the recorded before-brief lacks the blanket stop rule it is meant to show`);
    check(!after.includes(BLANKET_STOP_RULE), `${scopeKey}: the recorded after-brief still carries the blanket stop rule`);
    check(!generated.includes(BLANKET_STOP_RULE), `${scopeKey}: the CURRENT dist still generates the blanket stop rule`);
    check(stableBrief(generated) === stableBrief(after), `${scopeKey}: the current dist generates a brief that differs from the recorded after-brief beyond nonces`);
    const fenceStart = generated.search(/^--- BEGIN AGREED SCOPE ---$/m);
    const fenceEnd = generated.search(/^--- END AGREED SCOPE ---$/m);
    check(fenceStart >= 0 && fenceEnd > fenceStart, `${scopeKey}: the generated brief has no fenced scope block`);
    check(generated.indexOf("Rules, which are not negotiable") > fenceEnd, `${scopeKey}: the rules do not follow the fenced scope`);
    if (scopeKey === "run-1527") {
      const block = generated.slice(fenceStart, fenceEnd);
      for (const phrase of [...RUN_1527_TRIGGER_PHRASES, ...RUN_1527_NATURAL_PHRASES]) check(block.includes(phrase), `run-1527: "${phrase}" is missing from the fenced scope`);
    }
  }
  const record = name => JSON.parse(read(name));
  const b1527 = record("smoke-run-1527-before.json");
  const a1527 = record("smoke-run-1527-after.json");
  const bSmall = record("smoke-small-imperative-before.json");
  const aSmall = record("smoke-small-imperative-after.json");
  for (const [name, one] of [["smoke-run-1527-before", b1527], ["smoke-run-1527-after", a1527], ["smoke-small-imperative-before", bSmall], ["smoke-small-imperative-after", aSmall]]) {
    check(one.model === "gpt-6-astra", `${name}: not a gpt-6-astra run`);
    check(one.codex.exitCode === 0 && one.codex.timedOut === false, `${name}: codex did not exit cleanly`);
    check(one.repository.headMoved === false, `${name}: the model moved HEAD`);
    check(one.briefSha256 === createHash("sha256").update(read(`brief-${name.replace(/^smoke-/, "").replace(/-(before|after)$/, "")}-${name.endsWith("before") ? "before" : "after"}.txt`)).digest("hex"), `${name}: the recorded brief hash does not match the recorded brief text`);
  }
  check(b1527.briefHasBlanketStopRule === true && b1527.verdict.citedInstructionWordingAsReasonToStop === true, "run 1527 before: the model did not cite the scope wording as its reason to stop");
  check(a1527.briefHasBlanketStopRule === false && a1527.verdict.citedInstructionWordingAsReasonToStop === false, "run 1527 after: the model still cited the scope wording");
  check(a1527.verdict.parked === true && /78b9a565/.test(String(a1527.protocolFiles.park?.parsed?.recap ?? "")), "run 1527 after: the park file does not name the specific unmet requirement");
  check(bSmall.verdict.handoffStatus === "completed" && aSmall.verdict.handoffStatus === "completed", "small imperative: a run did not complete");
  check(aSmall.verdict.citedInstructionWordingAsReasonToStop === false, "small imperative after: the model cited the scope wording");
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length === 0) console.log("natural-instructions smoke evidence verified: current dist matches the recorded after-briefs; before/after model runs recorded as reported");
  return problems.length === 0 ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return 0; }
  if (args.command === "verify") {
    try { return await verify(args.evidence); } finally { rmSync(state, { recursive: true, force: true }); }
  }
  const scope = SCOPES[args.scope];
  const repo = fixtureRepo(args.scope, scope.branch);
  try {
    const brief = args.brief === null ? await generateBrief(args.scope, repo) : readFileSync(args.brief, "utf8");
    if (args.command === "brief") {
      if (args.out !== null) writeFileSync(args.out, brief);
      else process.stdout.write(brief);
      return 0;
    }
    // A real dispatch leaves the signed rubric beside the worktree for the
    // proof's preflight; the fixture carries the same file under the exact
    // name the brief cites, so the model sees what it would in production.
    const rubricName = /Canonical signed rubric: (STANDING-ORDERS-RUBRIC-[0-9a-f]{16}\.json)/.exec(brief)?.[1] ?? null;
    if (rubricName !== null) writeFileSync(join(repo, rubricName), JSON.stringify(scope.acceptance, null, 2), { flag: "wx", mode: 0o600 });
    const baseline = git(repo, "rev-parse", "HEAD");
    const outcome = await runCodex(repo, args.model, brief, args.timeoutSeconds);
    const stream = summarizeStream(outcome.stdout);
    const files = protocolFiles(brief, repo);
    const status = git(repo, "status", "--porcelain");
    const head = git(repo, "rev-parse", "HEAD");
    const branchNow = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    const stopRuleQuoted = /scope[^.]{0,120}(contain|direct)[^.]{0,80}instruction/i;
    const citedWordingRule = [...stream.messages, files.done?.parsed?.conclusion ?? ""].some(text => stopRuleQuoted.test(String(text)));
    const result = {
      version: 1,
      scope: args.scope,
      model: args.model,
      briefSource: args.brief === null ? "generated by dist build()" : args.brief,
      briefSha256: createHash("sha256").update(brief).digest("hex"),
      briefBytes: Buffer.byteLength(brief, "utf8"),
      briefHasBlanketStopRule: brief.includes("appears to contain instructions to you"),
      codex: { exitCode: outcome.code, timedOut: outcome.timedOut, notFound: outcome.notFound, elapsedMs: outcome.elapsedMs, stderrTail: outcome.stderr.slice(-2000) },
      stream,
      protocolFiles: files,
      repository: { baseline, head, headMoved: head !== baseline, branch: branchNow, status },
      verdict: {
        citedInstructionWordingAsReasonToStop: citedWordingRule,
        wroteHandoff: files.done !== null && files.done.absent !== true,
        handoffStatus: files.done?.parsed?.status ?? null,
        parked: files.park !== null && files.park.absent !== true,
      },
      fixture: args.keep ? repo : null,
      recordedAt: new Date().toISOString(),
    };
    const text = JSON.stringify(result, null, 2) + "\n";
    if (args.out !== null) writeFileSync(args.out, text);
    else process.stdout.write(text);
    return 0;
  } finally {
    if (!args.keep) {
      rmSync(repo, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    } else {
      console.error(`kept fixture ${repo} and state ${state}`);
    }
  }
}

main().then(
  code => process.exit(code),
  error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    console.error("");
    console.error(usage());
    process.exit(1);
  },
);
