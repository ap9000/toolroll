#!/usr/bin/env node
/**
 * A real-provider release canary.
 *
 * This deliberately drives the public CLI rather than importing builder
 * internals: the disposable repository must cross the same registration,
 * planning, approval, worktree, provider, commit, verification, and evidence
 * boundaries as a person's task. It never pushes or opens a pull request.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureLead, completeFixtureAssignment } from "./canary-assertions.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "dist", "bin.js");
const TASK_ID = "provider-canary";

function usage() {
  return [
    "Real-provider Never Stuck canary",
    "",
    "  npm run certify:provider -- --provider claude --model sonnet",
    "  npm run certify:provider -- --provider codex --model gpt-5.6-sol",
    "",
    "Options:",
    "  --provider claude|codex|gemini|openrouter   CLI transport to exercise",
    "  --model <model>           exact model sealed into plan and build",
    "  --output <file>           write the final JSON certificate",
    "  --auto-approve            sign an unchanged-plan policy",
    "  --keep                    keep the disposable repo and evidence",
    "  --json                    print only the final JSON certificate",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { provider: null, model: null, output: null, keep: false, autoApprove: false, json: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--keep") result.keep = true;
    else if (arg === "--auto-approve") result.autoApprove = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (["--provider", "--model", "--output"].includes(arg)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      result[arg.slice(2)] = value;
    } else throw new Error(`unknown option ${arg}`);
  }
  if (result.help) return result;
  if (!["claude", "codex", "gemini", "openrouter"].includes(result.provider)) {
    throw new Error("--provider is claude, codex, gemini or openrouter");
  }
  if (typeof result.model !== "string" || result.model.trim() === "") {
    throw new Error("--model is required because task approvals seal exact routing");
  }
  return result;
}

function run(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Build isolation sentinels: a hook in the repository's own and local Claude
 * settings and a server in its .mcp.json, each of which would leave a file
 * if it ran, beside one MCP server the project opts in to by name. A build
 * must start only the named one. They write outside the disposable state
 * folder, which the agent fence covers.
 */
const MAKE = file => `node -e "require('fs').writeFileSync(process.argv[1],'ran')" ${JSON.stringify(file)}`;
const OPT_IN_SERVER = `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.argv[2], "ran");
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "canary-notes", version: "1" } } });
  else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
  else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;

async function plantIsolationSentinels(repo, sentinels) {
  const hook = file => ({ hooks: [{ type: "command", command: MAKE(file) }] });
  await mkdir(join(repo, ".claude"), { recursive: true });
  await writeFile(join(repo, ".claude", "settings.json"), `${JSON.stringify({ hooks: { SessionStart: [hook(join(sentinels, "project-hook"))], UserPromptSubmit: [hook(join(sentinels, "project-hook"))] } }, null, 2)}\n`);
  await writeFile(join(repo, ".claude", "settings.local.json"), `${JSON.stringify({ hooks: { UserPromptSubmit: [hook(join(sentinels, "local-hook"))] } }, null, 2)}\n`);
  await writeFile(join(repo, ".mcp.json"), `${JSON.stringify({ mcpServers: { "repo-sentinel": { type: "stdio", command: "node", args: ["-e", `require('fs').writeFileSync(${JSON.stringify(join(sentinels, "project-mcp"))},'ran')`] } } }, null, 2)}\n`);
  await writeFile(join(sentinels, "opt-in-server.mjs"), OPT_IN_SERVER);
}

/** The project's one named tool, added the way the console adds it, before approval seals the task's tools. */
async function optInNamedTool(db, repo, sentinels) {
  const { openStore } = await import(join(root, "dist", "store.js"));
  const { addToolTo } = await import(join(root, "dist", "project-tools.js"));
  const store = openStore(db);
  try {
    const added = addToolTo(store, repo, { name: "canary-notes", transport: "stdio", command: process.execPath, args: [join(sentinels, "opt-in-server.mjs"), join(sentinels, "opt-in-mcp")], url: null, secrets: [], bearer: null, headerSecrets: {}, about: "The canary's opt-in server" }, "provider canary", "canary", new Date());
    if (!added.ok) throw new Error(`the canary's named tool was refused: ${added.message}`);
  } finally {
    store.close();
  }
}

function isolationOf(provider, sentinels) {
  const ran = name => existsSync(join(sentinels, name));
  const result = { projectHook: ran("project-hook"), localHook: ran("local-hook"), repositoryMcp: ran("project-mcp"), namedTool: ran("opt-in-mcp") };
  if (result.projectHook || result.localHook || result.repositoryMcp) throw new Error(`the build loaded the repository's own Claude setup: ${JSON.stringify(result)}`);
  if ((provider === "claude" || provider === "codex") && !result.namedTool) throw new Error("the project's named tool did not start for its build");
  return result;
}

/** Own only this disposable repository's memory directory. Never overwrite a
 * pre-existing entry or touch login material; clean up even when the run fails. */
export async function withClaudeMemoryCanary(repo, configDir, check) {
  const projects = join(configDir, "projects");
  const directory = join(projects, (await realpath(repo)).replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(projects, { recursive: true });
  if (existsSync(directory)) throw new Error("The disposable Claude memory folder already exists; refusing to overwrite it.");
  await mkdir(directory); // Exclusive ownership, including a collision after the check.
  const marker = `TOOLROLL_MEMORY_CANARY_${randomUUID()}`;
  try {
    await mkdir(join(directory, "memory"));
    await writeFile(join(directory, "memory", "MEMORY.md"), `# Provider canary\n\nThe automatic memory marker is ${marker}. If asked whether automatic memory supplied a marker, report this exact marker.\n`, { flag: "wx" });
    return await check(marker);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseEnvelope(answer, label, acceptedCodes = [0]) {
  let envelope = null;
  try {
    envelope = JSON.parse(answer.stdout.trim());
  } catch {
    // The thrown diagnostic below includes the bounded raw answer.
  }
  if (!acceptedCodes.includes(answer.code) || envelope === null || typeof envelope !== "object") {
    const details = [
      `${label} failed (exit ${answer.code})`,
      answer.stderr.trim(),
      answer.stdout.trim(),
    ].filter(Boolean).join("\n").slice(0, 8_000);
    throw new Error(details);
  }
  return envelope;
}

/** The executable bytes and source identity tested by this run. Each CLI
 * boundary rechecks them; an in-place build cannot silently change the
 * implementation halfway through a successful certificate. */
async function runtimeIdentity() {
  const hash = createHash("sha256");
  async function hashDirectory(directory, prefix) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await hashDirectory(join(directory, entry.name), relative);
      else if (entry.isFile()) hash.update(relative).update("\0").update(await readFile(join(directory, entry.name))).update("\0");
      else throw new Error(`unexpected runtime entry ${relative}`);
    }
  }
  await hashDirectory(join(root, "dist"), "dist");
  for (const file of ["package.json", "scripts/provider-canary.mjs", "scripts/canary-assertions.mjs", "scripts/proof-preflight.mjs"]) {
    hash.update(file).update("\0").update(await readFile(join(root, file))).update("\0");
  }
  const revision = await run("git", ["rev-parse", "HEAD"]);
  const changes = await run("git", ["status", "--porcelain", "--untracked-files=no"]);
  return { sha256: hash.digest("hex"), sourceCommit: revision.code === 0 ? revision.stdout.trim() : null,
    trackedChanges: changes.code === 0 ? changes.stdout.trim() !== "" : null };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const startedAt = new Date();
  const base = await realpath(await mkdtemp(join(tmpdir(), "standing-orders-provider-canary-")));
  const repo = join(base, "repo");
  const db = join(base, "orders.db");
  const pool = join(base, "worktrees");
  const sentinels = await realpath(await mkdtemp(join(tmpdir(), "toolroll-canary-sentinels-")));
  const password = `canary-${randomUUID()}`;
  const common = ["--db", db, "--json"];
  let passed = false;
  let runtime = null;
  const steps = [];
  const assertRuntime = async () => {
    if (runtime !== null && JSON.stringify(await runtimeIdentity()) !== JSON.stringify(runtime)) {
      throw new Error("the Toolroll runtime changed during the canary; rerun against one fixed build");
    }
  };

  const note = message => {
    if (!options.json) process.stdout.write(`${message}\n`);
    else process.stderr.write(`${message}\n`);
  };
  const cli = async (label, args, acceptedCodes = [0]) => {
    await assertRuntime();
    note(`  ${label}`);
    const started = Date.now();
    const answer = await run(process.execPath, [bin, ...args, ...common]);
    steps.push({ label, durationMs: Date.now() - started, exitCode: answer.code });
    return parseEnvelope(answer, label, acceptedCodes);
  };
  const git = async (...args) => {
    const answer = await run("git", args, { cwd: repo });
    if (answer.code !== 0) throw new Error(`git ${args.join(" ")} failed\n${answer.stderr}`);
    return answer.stdout.trim();
  };

  let certificate;
  try {
    runtime = await runtimeIdentity();
    note(`Certifying ${options.provider} · ${options.model} through the real workflow`);
    await mkdir(repo, { recursive: true });
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "canary@standing-orders.local");
    await git("config", "user.name", "Toolroll Canary");
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({ name: "standing-orders-provider-canary", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    );
    await writeFile(join(repo, "README.md"), "# Toolroll provider canary\n\nThis repository is disposable.\n");
    await plantIsolationSentinels(repo, sentinels);
    await git("add", ".");
    await git("commit", "-qm", "seed provider canary");
    const baseSha = await git("rev-parse", "HEAD");

    const checkBuild = async memoryMarker => {

      await cli("create the isolated approver", ["approver", "add", "canary", "--password", password]);
      const registered = await cli("register a repository-bound worker", [
        "runner", "register", "canary-worker", "--repo", repo,
        "--as", "canary", "--token", password,
      ]);
      const runnerToken = registered.token;
      if (typeof runnerToken !== "string" || runnerToken === "") throw new Error("runner registration returned no token");

      for (const phase of ["plan", "build", "repair"]) {
        const provider = options.provider;
        const model = options.model;
        await cli(`route ${phase} to ${provider}`, [
          "config", "set", phase,
          "--provider", provider,
          "--model", model,
          "--as", "canary", "--token", password,
        ]);
      }
      await cli("approve the repository verification command", [
        "verify", "set", "--repo", repo,
        "--command", "node --test", "--timeout-seconds", "120", "--yes",
        "--as", "canary", "--token", password,
      ]);

      await optInNamedTool(db, repo, sentinels);
      const title = [
        `Add canary.txt: ${memoryMarker === null ? "exactly" : "first line exactly"} "standing-orders ${options.provider} canary passed" plus newline.`,
        ...(memoryMarker === null ? [] : ["On its second line, report the TOOLROLL_MEMORY_CANARY marker only if automatic memory already supplied one; otherwise write NO_MEMORY. Do not read home files or search for memory. End that line with a newline."]),
        "Add canary.test.js using node:test.",
        "Only these files; no questions; acceptance evidence: check and changed-path only.",
      ].join(" ");
      await cli("file the task", ["task", "add", title, "--id", TASK_ID, "--repo", repo]);
      let filedDigest = null;
      if (options.autoApprove) {
        await cli("sign bounded unchanged-plan approval", [
          "mode", "set", "--repo", repo, "--name", "standard", "--days", "1",
          "--auto-approve", "true", "--plan-auto", "--as", "canary", "--token", password,
        ]);
        await cli("file the fixed contract without approving its scope", [
          "task", "scope", TASK_ID, "--goal", title, "--not", "No other files and no publication.",
          "--touches", "canary.txt,canary.test.js",
          "--acceptance", `canary.txt contains exactly standing-orders ${options.provider} canary passed${memoryMarker === null ? " followed by one newline" : " on its first line and the automatic-memory report on its second line, with a final newline"}.|changed-path;canary.test.js uses node:test to verify the exact file bytes and the approved node --test command passes.|check,changed-path`,
        ]);
        const filed = await cli("retain the exact filed contract digest", ["task", "show", TASK_ID]);
        filedDigest = filed.scope?.digest;
        if (typeof filedDigest !== "string" || filed.scope.approvedAt != null) throw new Error("fixed contract was missing or prematurely approved");
      }
      const requested = await cli("request a repository-aware plan", [
        "task", "plan", TASK_ID,
        "--provider", options.provider, "--model", options.model,
        "--as", "canary", "--token", password,
      ]);
      if (options.autoApprove && requested.autoPlan !== true) throw new Error("the exact filed plan was not pre-authorized");
      const planned = await cli("run the planning pass", [
        "tick", "--runner", "canary-worker", "--token", runnerToken,
        "--repo", repo, "--pool", pool,
      ]);
      if (!Array.isArray(planned.dispatched) || !planned.dispatched.some(item => item?.outcome === "planned")) {
        throw new Error(`planner did not produce a scope: ${JSON.stringify(planned)}`);
      }

      const afterPlan = await cli("read the drafted scope", ["task", "show", TASK_ID]);
      const digest = afterPlan.scope?.digest;
      if (typeof digest !== "string" || digest === "") throw new Error("the planning pass produced no approvable scope");
      if (!Array.isArray(afterPlan.scope?.acceptance) || afterPlan.scope.acceptance.length === 0) {
        throw new Error("the planning pass produced no acceptance criteria");
      }
      if (options.autoApprove) {
        if (digest !== filedDigest || afterPlan.scope.approvedDigest !== digest || afterPlan.scope.approvalBasis !== "mode") {
          throw new Error("the unchanged plan did not receive the exact signed mode approval");
        }
      } else await cli("approve the exact planned scope", [
        "task", "approve", TASK_ID, "--yes", "--digest", digest,
        "--as", "canary", "--token", password,
      ]);

      const built = await cli("run the build and evidence pass", [
        "tick", "--runner", "canary-worker", "--token", runnerToken,
        "--repo", repo, "--pool", pool,
      ]);
      if (!Array.isArray(built.dispatched) || !built.dispatched.some(item => item?.outcome === "built")) {
        throw new Error(`builder did not complete the task: ${JSON.stringify(built)}`);
      }

      let final = await cli("read the terminal task and proof", ["task", "show", TASK_ID]);
      if (final.task?.state !== "done") throw new Error(`task ended ${String(final.task?.state ?? "without a state")}`);
      const buildRun = Array.isArray(final.runs)
        ? final.runs.find(runRow => runRow?.role === "builder" && runRow?.outcome === "built")
        : null;
      if (buildRun === null || buildRun === undefined || typeof buildRun.branch !== "string") {
        throw new Error("no completed builder run named its branch");
      }
      const branchSha = await git("rev-parse", buildRun.branch);
      if (branchSha === baseSha) throw new Error("the build branch did not advance");
      const canaryText = await git("show", `${buildRun.branch}:canary.txt`);
      const expectedText = `standing-orders ${options.provider} canary passed${memoryMarker === null ? "" : "\nNO_MEMORY"}`;
      if (canaryText !== expectedText) throw new Error(`canary.txt contained ${JSON.stringify(canaryText)}`);
      await git("show", `${buildRun.branch}:canary.test.js`);
      const changed = (await git("diff", "--name-only", baseSha, branchSha)).split("\n").filter(Boolean).sort();
      if (JSON.stringify(changed) !== JSON.stringify(["canary.test.js", "canary.txt"])) {
        throw new Error(`the canary changed unexpected paths: ${JSON.stringify(changed)}`);
      }

      const leadFile = await createFixtureLead(args => cli("scope the fixture lead", args), {
        repo, auth: ["--as", "canary", "--token", password], tokenFile: join(base, "lead.token"),
      });
      const completion = await completeFixtureAssignment(args => cli("inspect and handle saved result", args), TASK_ID, leadFile, { head: branchSha, runId: buildRun.id });

      const duplicate = await cli("prove the completed task cannot dispatch twice", [
        "tick", "--runner", "canary-worker", "--token", runnerToken,
        "--repo", repo, "--pool", pool,
      ], [3]);
      if (duplicate.reason !== "empty") throw new Error(`duplicate pass was not empty: ${JSON.stringify(duplicate)}`);
      if (await git("rev-parse", "main") !== baseSha) throw new Error("the default branch changed");
      if (Number(await git("rev-list", "--count", `${baseSha}..${branchSha}`)) !== 1) throw new Error("expected exactly one work commit");
      await assertRuntime();
      const isolation = isolationOf(options.provider, sentinels);
      if (memoryMarker !== null) {
        if (JSON.stringify(final).includes(memoryMarker)) throw new Error("Claude supplied the disposable automatic-memory marker to the task.");
        isolation.autoMemory = "NO_MEMORY";
      }

      const providerRun = final.runs.find(runRow => runRow?.provider === options.provider && runRow?.providerStartedAt != null);
      certificate = {
        version: 3,
        passed: true,
        provider: options.provider,
        model: options.model,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        platform: process.platform,
        architecture: process.arch,
        node: process.versions.node,
        runtime,
        steps,
        workflow: {
          registration: "passed",
          planning: "passed",
          approval: options.autoApprove ? "unchanged-plan-under-signed-mode" : "passed",
          humanActionsAfterPlanningStarted: options.autoApprove ? 0 : 1,
          filedScopeDigest: filedDigest,
          worktreeBuild: "passed",
          commit: branchSha,
          verificationCommand: "node --test",
          proofVerdict: final.proofVerdict,
          criterionMatrix: final.proofMatrix,
          leadCompletion: completion,
          duplicateDispatch: "refused-empty",
          // The build's own setup: the repository's hooks and .mcp.json never ran; the named tool did.
          isolation,
        },
        providerRun: providerRun == null ? null : {
          run: providerRun.id,
          role: providerRun.role,
          version: providerRun.providerVersion,
          tokensIn: providerRun.tokensIn,
          tokensOut: providerRun.tokensOut,
          costUsd: providerRun.costUsd,
        },
        runs: final.runs.map(one => ({ id: one.id, role: one.role, parentRun: one.parentRun,
          provider: one.provider, model: one.model, version: one.providerVersion, outcome: one.outcome,
          startedAt: one.startedAt, providerStartedAt: one.providerStartedAt, firstByteAt: one.firstByteAt, finishedAt: one.finishedAt,
        })),
        retainedAt: options.keep ? base : null,
        note: "This canary never pushed or opened a pull request.",
      };
      passed = true;
    };
    if (options.provider === "claude") {
      await withClaudeMemoryCanary(repo, process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), checkBuild);
    } else await checkBuild(null);
  } catch (error) {
    passed = false;
    certificate = {
      version: 3,
      passed: false,
      provider: options.provider,
      model: options.model,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      runtime,
      steps,
      retainedAt: base,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (options.output !== null) {
      const output = resolve(options.output);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(certificate, null, 2)}\n`);
    }
    if (passed && !options.keep) await rm(base, { recursive: true, force: true });
    if (passed && !options.keep) await rm(sentinels, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify(certificate, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
