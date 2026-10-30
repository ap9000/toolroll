/**
 * The world `toolroll release` acts on (release.ts): the gate checkout through git, GitHub through the signed-in `gh`,
 * the npm registry over HTTPS, the installed Toolroll through its own CLI (`--json`) and launchd definitions, and the
 * Homebrew tap through `gh`. Each call is bounded; none asks for or stores a credential — `gh`, npm and Toolroll use
 * the sign-ins this machine already has.
 */

import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import { sleep } from "./sleep.js";
import { callLabel, readOnlyCall, retryCall, retryingExec, writeWithRecheck, type ExecResult, type RetryOptions } from "./release-net.js";
// Loaded on first use, like the store: a static import prints Node's SQLite warning before the CLI can quiet it.
const sqlite = (): typeof import("node:sqlite") => createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import type { CheckRun, DeployStop, GateState, HomebrewState, Installed, MainProtection, PullRequest, ReleaseAdapters } from "./release.js";
import { PROTECTION_MINIMUM_CHECKS, PROTECTION_REPORT_ONLY_CHECKS } from "./release.js";
import { activeUpdateWork } from "./desktop-update-gate.js";
import { BEFORE_SWAP, gateOwner } from "./release-gate.js";
import { findCliLinks, switchCliLinks } from "./release-links.js";
import {
  databasePath, finishReleaseOperation, requireFreshReleaseApproval, openStore, releaseAuthorityOfTask, releaseCarries, releaseOperations, renewReleaseLease, reserveRelease, runReleaseOperation,
  Store, releaseIssuerGone, takeReleaseLease, type Database,
} from "./store.js";
import { acquireDeploymentLock } from "./deploy-lock.js";
import { autoReleaseApprovalOf, liveReleaseOf } from "./scope.js";
import { recheckReleaseTask, releaseCheckStanding } from "./check-failure.js";
import { noteCiRunning, releaseCiHoldOf, releaseCiRunningOf } from "./release-ci-hold.js";
import { autoPublishHeld, holdAutoPublish, liftCiHold, authorizeAutoCheck, giveUpAutoApproval, noteAutoCheckFailed, noteAutoRelease, releaseAutoApproves, sealAutoGreen, type CiObservation } from "./release-auto.js";
import { proveCarry, type BuildRunner } from "./release-carry.js";
import { randomBytes, randomUUID } from "node:crypto";
import { deploymentGate } from "./deploy-gate.js";
import { extractCommit } from "./commit-extract.js";
import { checkoutIncludes } from "./teardown-git.js";
import { RELEASE_REMOTE, releaseConfigProblem, releaseGitArgs, releaseGitEnv, releaseRemote, releaseTools, type ReleaseRepo, type ReleaseTools } from "./release-git.js";
export { RELEASE_PATH, RELEASE_REMOTE, releaseConfigProblem, releaseGitArgs, releaseGitEnv, releaseRemote, releaseTools, type ReleaseRepo, type ReleaseTools } from "./release-git.js";

export type Exec = (command: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string }) =>
  Promise<{ code: number; stdout: string; stderr: string }>;

/** A child process, its output kept whole; a missing program or a time limit is exit 127 or 124, never a throw. */
export const exec: Exec = (command, args, options = {}) => new Promise(done => {
  const child = execFile(command, [...args], { cwd: options.cwd, env: options.env ?? process.env, timeout: options.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
    (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      const code = failure === null ? 0 : failure.code === "ENOENT" ? 127 : failure.killed === true ? 124 : typeof failure.code === "number" ? failure.code : 1;
      done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  // `input`: written on the child's stdin, then closed (a secret that must never ride in argv).
  child.stdin?.on("error", () => { /* the child closed its stdin: its exit decides */ });
  if (options.input !== undefined) child.stdin?.end(options.input); else child.stdin?.end();
});

/** Without NODE_OPTIONS, which a test runner or debugger may have left for this process. */
const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env = { ...process.env, ...extra };
  delete env["NODE_OPTIONS"];
  return env;
};

/** A failed call, in the words every release stop uses: what, its exit code and the last lines it printed. */
const failed = (result: ExecResult, what: string): Error => new Error(`${what} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);

const must = async (run: Promise<{ code: number; stdout: string; stderr: string }>, what: string): Promise<string> => {
  const result = await run;
  if (result.code !== 0) throw failed(result, what);
  return result.stdout;
};

/** owner/name from an https or ssh GitHub remote. */
export function githubSlug(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** The runtime (a `dist` folder, resolved) each launchd service of Toolroll runs: its definition names `<dist>/cli.js`. */
export function serviceRuntimes(agents = join(homedir(), "Library", "LaunchAgents")): string[] {
  let names: string[] = [];
  try { names = readdirSync(agents).filter(one => /^com\.(toolroll|standing-orders)\..+\.plist$/.test(one)); } catch { return []; }
  const found: string[] = [];
  for (const name of names) {
    const text = readFileSync(join(agents, name), "utf8");
    for (const match of text.matchAll(/<string>([^<]*\/dist)\/cli\.js<\/string>/g)) found.push(resolved(match[1]!));
  }
  return [...new Set(found)];
}

/** The runtime each CLI name resolves to on PATH: the `dist` folder its `bin.js` sits in, or null when not linked there. */
export function cliRuntimes(path = process.env["PATH"] ?? "", names = ["toolroll", "standing-orders"]): Installed["clis"] {
  return names.map(name => {
    for (const dir of path.split(delimiter).filter(Boolean)) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      const real = resolved(candidate);
      return { name, runtime: basename(real) === "bin.js" && basename(dirname(real)) === "dist" ? dirname(real) : null };
    }
    return { name, runtime: null };
  });
}

const resolved = (path: string) => { try { return realpathSync(path); } catch { return path; } };

type Json = Record<string, unknown>;
const object = (value: unknown): Json => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const textOr = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** `task show --json`, read as the release needs it. */
export function gateStateOf(answer: Json, accounts: readonly unknown[] = []): GateState {
  if (answer["ok"] !== true) return { exists: false, candidate: null, scopeDigest: null, approval: null, result: null, failed: null, completion: null };
  const scope = object(answer["scope"]);
  const assignment = object(answer["assignment"]);
  const result = object(assignment["result"]);
  const checks = object(result["checks"]);
  const runs = Array.isArray(answer["runs"]) ? answer["runs"].map(object) : [];
  const builders = runs.filter(run => run["role"] === "builder");
  const newest = builders.sort((a, b) => Number(b["id"]) - Number(a["id"]))[0];
  const resultRun = typeof result["runId"] === "number" ? result["runId"] : null;
  const completion = object(assignment["completion"]);
  const approvedAt = textOr(scope["approvedAt"]), approvedBy = textOr(scope["approvedBy"]), approvedDigest = textOr(scope["approvedDigest"]);
  const account = accounts.map(object).find(one => one["name"] === approvedBy);
  // A newer finished build than the result, with no result of its own, failed before its check could seal one.
  const failed = newest !== undefined && newest["finishedAt"] != null && newest["outcome"] !== "built" && newest["outcome"] !== "no-change" && Number(newest["id"]) !== resultRun
    ? `run ${String(newest["id"])} ended ${String(newest["outcome"] ?? "without an outcome")}` : null;
  const worktree = runs.find(run => run["id"] === resultRun)?.["worktree"];
  // Queued again or still building past the result shown (a regate): that result is the one before the rerun.
  const state = object(answer["task"])["state"];
  const pending = resultRun !== null && (state === "queued" || state === "running" || (newest !== undefined && newest["finishedAt"] == null && Number(newest["id"]) > resultRun));
  return {
    exists: true,
    candidate: textOr(scope["candidate"]),
    scopeDigest: textOr(scope["digest"]),
    approval: approvedAt === null || approvedBy === null || approvedDigest === null ? null : {
      by: approvedBy, at: approvedAt, digest: approvedDigest, basis: textOr(scope["approvalBasis"]),
      role: textOr(account?.["role"]), active: account?.["revokedAt"] === null,
      ...personAnswerOf(answer["personApproval"]),
    },
    result: resultRun === null || textOr(result["digest"]) === null ? null : {
      run: resultRun, head: textOr(result["head"]), receipt: String(result["digest"]), worktree: textOr(worktree),
      level: textOr(checks["level"]),
      check: textOr(checks["running"]) !== null ? "running"
        : checks["status"] === "passed" && checks["level"] !== "full" ? "not-full" : String(checks["status"] ?? "not-run"),
    },
    failed,
    pending,
    completion: textOr(completion["digest"]) === null ? null : { actor: String(completion["actor"]), at: String(completion["at"]), digest: String(completion["digest"]) },
  };
}

/** Every process on this machine (`ps`): pid and full command line. */
export function processes(): { pid: number; command: string }[] {
  const listed = spawnSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`ps failed: ${listed.stderr.trim()}`);
  return listed.stdout.split("\n").map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(match => match !== null).map(match => ({ pid: Number(match[1]), command: match[2]! }));
}

/** The final line of deploy-browser's output that is a JSON object: its `runtime` (a dist folder), when it has one. */
export function deployedRuntime(stdout: string): string | null {
  const last = stdout.trim().split("\n").reverse().find(line => line.startsWith("{"));
  try {
    const runtime = object(JSON.parse(last ?? ""))["runtime"];
    return typeof runtime === "string" && /[\\/]dist$/.test(runtime) ? runtime : null;
  } catch { return null; }
}

/** What a deployment's stage says about the update pause: its id and phase when the journal is before the swap and the
 * live database's pause is that deployment's. `owner` reads the live pause's owner. */
export function stageGate(stage: string, owner: () => string | null): { id: string; phase: string } | null {
  let journal: Json;
  try { journal = object(JSON.parse(readFileSync(join(stage, "deployment.json"), "utf8"))); } catch { return null; }
  const id = textOr(journal["id"]), phase = textOr(journal["phase"]);
  return id !== null && phase !== null && BEFORE_SWAP.includes(phase) && owner() === id ? { id, phase } : null;
}

/** The recorded repository for a gate checkout, from the plane's database; throws in plain words when there is none. */
export function recordedReleaseRepo(database: string, checkout: string): ReleaseRepo {
  const real = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };
  const at = real(checkout);
  if (at === null) throw new Error(`${checkout} isn't there.`);
  if (!existsSync(database)) throw new Error("The plane's database isn't here, so the release's repository can't be read from its records.");
  const db = new (sqlite().DatabaseSync)(database, { readOnly: true }) as unknown as Database;
  let project: string | null = null, remote: string | null = null;
  try {
    const store = new Store(db);
    project = store.listProjects().map(one => one.path).find(path => real(path) === at) ?? null;
    remote = project === null ? null : store.projectRemote(project);
  } finally { db.close(); }
  if (project === null) throw new Error(`${checkout} isn't one of the projects Toolroll records, so it can't be released from here.`);
  if (remote === null) throw new Error(`${project} has no recorded remote. Record it with \`toolroll repos add ${project} --remote <url>\` first.`);
  const parsed = releaseRemote(remote);
  if (parsed === null) throw new Error(`${project}'s recorded remote (${remote}) isn't a GitHub repository over https or ssh.`);
  const named = join(at, ".git");
  let gitDir: string;
  try {
    if (!lstatSync(named).isDirectory()) throw new Error("not a folder");
    gitDir = realpathSync(named);
  } catch { throw new Error(`${project}'s Git directory isn't a plain folder, so the release won't read it.`); }
  return { checkout: at, gitDir, remote, ...parsed };
}

export type AdapterOptions = {
  checkout: string;
  /** The recorded repository and the programs, when a caller (a test) supplies them; otherwise read from the plane's
   * records and found on this machine when the first Git command runs. */
  releaseRepo?: ReleaseRepo;
  tools?: ReleaseTools;
  /** The live database (default: this installation's). */
  database?: string;
  processes?: typeof processes;
  /** owner/name of the Homebrew tap and its formula's path there. */
  tap?: string;
  formula?: string;
  /** How long the deployment itself may run, in minutes. */
  deployMinutes?: number;
  run?: Exec;
  fetch?: typeof fetch;
  say?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

/** How many times, and how far apart, a merged branch's deletion is looked for after the push lost a race. */
export const BRANCH_GONE_LOOKS = 5;
export const BRANCH_GONE_PAUSE_MS = 2_000;

export function releaseAdapters(options: AdapterOptions): ReleaseAdapters {
  const run = options.run ?? exec;
  const get = options.fetch ?? fetch;
  const { checkout } = options;
  const tap = options.tap ?? "ap9000/homebrew-toolroll";
  const formula = options.formula ?? "Formula/toolroll.rb";
  const pause = options.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  const tools = options.tools ?? releaseTools();
  const gitEnv = releaseGitEnv();
  const say = options.say ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  /** A short network failure on the way to GitHub (release-net.ts): reads are asked again for up to ~3 minutes; a
   * write never is, unless GitHub says it didn't happen (writeWithRecheck). */
  const net: RetryOptions = { say, sleep: options.sleep ?? sleep, ...(options.now === undefined ? {} : { now: options.now }) };
  const reads = retryingExec(run, net);
  // Never a PATH lookup or the checkout's Git config: gh by its absolute path, from a neutral folder, naming the repo.
  // Reads ride out a short network failure; anything that isn't provably a read passes straight through (readOnlyCall).
  const gh = (...args: string[]) => reads(tools.gh, args, { cwd: "/", env: gitEnv });
  /** A write by gh, never retried by itself. */
  const ghWrite = (...args: string[]) => run(tools.gh, args, { cwd: "/", env: gitEnv });
  const ghJson = async (what: string, ...args: string[]) => JSON.parse(await must(gh(...args), what)) as unknown;
  const toolroll = async (...args: string[]): Promise<Json> => {
    const result = await run("toolroll", [...args, "--json"], { env: cleanEnv(), timeoutMs: 120_000 });
    try { return object(JSON.parse(result.stdout)); } catch { throw new Error(`toolroll ${args[0]} ${args[1] ?? ""} answered no JSON (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`); }
  };
  const refused = (answer: Json) => `${String(answer["message"] ?? answer["reason"] ?? "refused")}`;
  /** gh for every CI and merge-base read (auto-approve-green.md): found only in the system's own folders, never the
   * caller's PATH (a test hands its own). */
  const ciGh = options.tools?.gh ?? releaseTools("").gh;
  const observeCi = async (sha: string): Promise<CiObservation> => {
    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    const runs = (await readCheckRuns(reads, ciGh, releaseRepo().slug, sha)).map(one => ({ id: one.id ?? null, name: one.name, status: one.status, conclusion: one.conclusion, app: one.app ?? null, suite: one.suite ?? null, head: one.head ?? null, workflow: one.workflow ?? null, workflowPath: one.workflowPath ?? null,
      ...(one.beforeTests === undefined ? {} : { beforeTests: one.beforeTests }) }));
    return { head: sha, observedAt, runs, complete: await readSuitesComplete(reads, ciGh, releaseRepo().slug, sha) };
  };
  const database = options.database ?? databasePath(process.env, homedir());
  let recorded: ReleaseRepo | null = options.releaseRepo ?? null;
  /** The recorded repository, read once (chat-management.md §0a.2). */
  const releaseRepo = (): ReleaseRepo => recorded ??= recordedReleaseRepo(database, checkout);
  /**
   * The coordinator's one way to run Git (§0a.2): on the recorded Git directory, hardened, with an allowlisted
   * environment and the absolute Git. Before every command the checkout's own config is read with includes off and
   * as plain files; one that includes a file, names a command or redirects a remote stops the release, naming it.
   */
  const git = async (...args: string[]) => {
    const repo = releaseRepo();
    const full = [...releaseGitArgs(repo, tools), ...args];
    const stop = (why: string) => new Error(`Toolroll won't run Git in ${repo.checkout} for a release: ${why}. Remove it from the project's Git config, then rerun.`);
    // The checkout's config is read again right before EVERY attempt, a retried one included (checked at the moment of use).
    const once = async () => {
      if (options.releaseRepo === undefined && checkoutIncludes(repo.checkout)) throw stop("its Git config includes another file, or couldn't be read as a plain file");
      const listing = await run(tools.git, [`--git-dir=${repo.gitDir}`, "--no-optional-locks", "config", "--list", "--no-includes", "--show-scope", "-z"], { cwd: "/", env: gitEnv });
      if (listing.code !== 0) throw stop("its Git config couldn't be read");
      const setting = releaseConfigProblem(listing.stdout);
      if (setting !== null) throw stop(`its Git config sets ${setting}, which a release doesn't run with (it could run a command, or change where Git connects or what it sends)`);
      return run(tools.git, full, { cwd: repo.checkout, env: gitEnv });
    };
    // ls-remote and fetch ride out a short network failure; a push or a local command is never retried (readOnlyCall).
    return readOnlyCall(tools.git, full) === null ? once() : retryCall(once, callLabel(tools.git, full), net);
  };
  /** The remote every fetch, look and push names: the recorded URL, defined only on the command line. */
  const remoteUrl = () => RELEASE_REMOTE;
  const liveOwner = () => {
    if (!existsSync(database)) return null;
    const db = new (sqlite().DatabaseSync)(database, { readOnly: true }) as unknown as Database;
    try { return gateOwner(db); } finally { db.close(); }
  };
  const tail = (result: { code: number; stdout: string; stderr: string }) => (result.stderr || result.stdout).trim().split("\n").slice(-4).join(" ") || `exit ${result.code}`;
  /** A deployment that stopped: in words, with the pause it left when that pause is before the swap. */
  const stopped = (stage: string, message: string): DeployStop => {
    const gate = stageGate(stage, liveOwner);
    return gate === null ? { ok: false, message } : { ok: false, message, gate };
  };
  /** The deployment gate in this runtime (deploy-gate.ts): a person's approval, the passing check, the exact completed
   * result. Its answer names the approved commit and the project it belongs to, from the plane's own records. */
  const proveCandidate = (runId: number): ReturnType<typeof deploymentGate> => {
    if (!existsSync(database)) return { ok: false, message: "The plane's database isn't here, so the candidate can't be proven." };
    const db = new (sqlite().DatabaseSync)(database, { readOnly: true }) as unknown as Database;
    try { return deploymentGate(new Store(db), { runId, evidenceRoot: join(dirname(database), "evidence"), now: (options.now ?? (() => new Date()))(), releaseFlow: true }); }
    catch (error) { return { ok: false, message: `The candidate can't be proven: ${(error as Error).message}` }; }
    finally { db.close(); }
  };
  /** The run's recorded commit and project, for recovery (which needs no approval). */
  const recordedCommit = (runId: number): { head: string; repo: string } | null => {
    if (!existsSync(database)) return null;
    const db = new (sqlite().DatabaseSync)(database, { readOnly: true }) as unknown as Database;
    try {
      const store = new Store(db), run = store.getRun(runId), repo = run === null ? null : store.refById(run.taskRef)?.repo ?? null;
      return run?.headRevision != null && repo != null ? { head: run.headRevision, repo } : null;
    } catch { return null; } finally { db.close(); }
  };
  /**
   * The approved commit, written by this runtime into a fresh folder it owns (commit-extract.ts): every regular file of
   * that full SHA, read byte for byte from the PROJECT's own Git directory as Toolroll records it (realpath, a real
   * directory — never the candidate worktree's `.git` pointer or anything in that worktree), with no filter, attribute,
   * replacement object, lazy fetch, hook or outside config, and no symlink or submodule. The deployment script runs
   * from here, so nothing changed, flagged, swapped or untracked in the worktree, nor its Git pointer, changes what runs.
   */
  const extractApproved = async (repo: string, head: string): Promise<{ ok: true; dir: string; gitDir: string } | { ok: false; message: string }> => {
    let gitDir: string;
    try {
      const named = join(realpathSync(repo), ".git");
      if (!lstatSync(named).isDirectory()) return { ok: false, message: `${repo}'s Git directory isn't a plain directory, so the approved commit can't be read from it.` };
      gitDir = realpathSync(named);
    } catch { return { ok: false, message: `${repo} has no Git directory to read the approved commit from.` }; }
    const dir = realpathSync(mkdtempSync(join(resolved(tmpdir()), "toolroll-deployer-")));
    const extracted = extractCommit(gitDir, head, dir);
    if (!extracted.ok) { rmSync(dir, { recursive: true, force: true }); return { ok: false, message: `The approved commit couldn't be prepared: ${extracted.message}` }; }
    return { ok: true, dir, gitDir };
  };
  /** The approved commit's own deployment script, from the pristine extraction; the worktree is only its --source. */
  const deployScript = async (worktree: string, stage: string, runId: number, commit: { head: string; repo: string }, extra: string[], input?: string) => {
    const extracted = await extractApproved(commit.repo, commit.head);
    if (!extracted.ok) return { code: 1, stdout: "", stderr: extracted.message };
    try {
      // The script node runs is the extraction's own regular file, by its real path inside the folder.
      let script: string;
      try {
        script = realpathSync(join(extracted.dir, "scripts", "deploy-browser.mjs"));
        if (!script.startsWith(extracted.dir + "/") || !lstatSync(script).isFile()) throw new Error("outside");
      } catch { return { code: 1, stdout: "", stderr: "The approved commit has no deployment script of its own." }; }
      return await run(process.execPath, [script, "--run", String(runId), "--stage", stage, "--source", worktree,
        "--head", commit.head, "--git-dir", extracted.gitDir, ...extra], {
        cwd: extracted.dir, env: cleanEnv({ TMPDIR: resolved(process.env["TMPDIR"] ?? "/tmp") }), timeoutMs: (options.deployMinutes ?? 30) * 60_000, ...(input === undefined ? {} : { input }),
      });
    } finally { rmSync(extracted.dir, { recursive: true, force: true }); }
  };

  const release = storeReleaseAdapter(() => openStore(database), store => store.close(), options.now ?? (() => new Date()), undefined,
    { observe: sha => observeCi(sha), mergeBase: (base, sha) => readMergeBase(reads, ciGh, releaseRepo().slug, base, sha),
      upToDateRequired: () => readUpToDateRequired(reads, ciGh, releaseRepo().slug), evidenceRoot: join(dirname(database), "evidence"),
      // A successful Actions job authenticates the job, not the candidate-writable JSON it uploads. Until the
      // executor protects that reporting channel, production releases must take the person's approval road.
      reportsProtected: false });

  return {
    ...(existsSync(database) ? { release } : {}),
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? sleep,
    say,
    repo: {
      // The recorded owner/name, never the checkout's origin.
      async github() { return releaseRepo().slug; },
      async sync(branch) {
        await must(git("fetch", "--quiet", "--no-tags", remoteUrl(), "+refs/heads/main:refs/remotes/origin/main"), "git fetch main");
        // A merged branch may be gone from GitHub; its commit is already here.
        await git("fetch", "--quiet", "--no-tags", remoteUrl(), `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
        const current = (await git("symbolic-ref", "--quiet", "--short", "HEAD")).stdout.trim();
        if (current === "main") { await must(git("merge", "--ff-only", "--quiet", "origin/main"), "git merge --ff-only origin/main"); return; }
        const local = (await git("rev-parse", "--verify", "--quiet", "refs/heads/main")).stdout.trim();
        if (local === "" || (await git("merge-base", "--is-ancestor", local, "origin/main")).code === 0) {
          await must(git("update-ref", "refs/heads/main", "origin/main", ...(local === "" ? [] : [local])), "git update-ref main");
        } else throw new Error(`${checkout}'s local main has commits origin/main doesn't; the gate diffs from it, so fix it first`);
      },
      async remoteHead(branch) {
        const out = await must(git("ls-remote", remoteUrl(), `refs/heads/${branch}`), "git ls-remote");
        return out.trim().split(/\s+/)[0] || null;
      },
      async deleteBranch(branch, head) {
        const ref = `refs/heads/${branch}`;
        const current = (await must(git("ls-remote", remoteUrl(), ref), "git ls-remote")).trim().split(/\s+/)[0] || null;
        if (current === null) return;
        if (current !== head) throw new Error(`${branch} moved after merging; its new head was not deleted.`);
        const pushed = await git("push", "--no-verify", `--force-with-lease=${ref}:${head}`, remoteUrl(), `:${ref}`);
        if (pushed.code === 0) return;
        // GitHub may delete a merged branch itself between the look and the push; gone is what was wanted. Its refs can
        // lag the deletion by a few seconds, so look a few times before calling it a failure.
        for (let look = 0; look < BRANCH_GONE_LOOKS; look++) {
          if (look > 0) await pause(BRANCH_GONE_PAUSE_MS);
          const after = (await must(git("ls-remote", remoteUrl(), ref), "git ls-remote")).trim().split(/\s+/)[0] || null;
          if (after === null) return;
        }
        throw new Error(`deleting merged branch ${branch} failed: ${pushed.stderr.trim() || `exit ${pushed.code}`}`);
      },
      async tree(sha) { return (await must(git("rev-parse", `${sha}^{tree}`), `git rev-parse ${sha.slice(0, 7)}^{tree}`)).trim(); },
      async fileAt(sha, path) {
        const result = await git("show", `${sha}:${path}`);
        return result.code === 0 ? result.stdout : null;
      },
    },
    toolroll: {
      async installed() { return { services: serviceRuntimes(), clis: cliRuntimes() }; },
      async runtimeCommit(runtime) {
        // deploy-browser writes this beside node_modules, not in the package's own manifest (whose version can repeat).
        try {
          const candidate = object(JSON.parse(readFileSync(join(runtime, "..", "..", "..", "package.json"), "utf8")))["candidate"];
          return typeof candidate === "string" && /^[0-9a-f]{40}$/.test(candidate) ? candidate : null;
        } catch { return null; }
      },
      async gate(taskId) {
        const answer = await toolroll("task", "show", taskId);
        if (textOr(object(answer["scope"])["approvedBy"]) === null) return gateStateOf(answer);
        const people = await toolroll("people", "list");
        if (people["ok"] !== true || !Array.isArray(people["accounts"])) throw new Error(`Cannot verify the release approver: ${refused(people)}`);
        return gateStateOf(answer, people["accounts"]);
      },
      async fileGate(input) {
        const added = await toolroll("task", "add", input.title, "--id", input.taskId, "--repo", input.checkout, "--checks", "full");
        if (added["ok"] !== true) throw new Error(`task add: ${refused(added)}`);
        const scoped = await toolroll("task", "scope", input.taskId, "--candidate", input.candidate, "--goal", input.goal, "--acceptance", input.acceptance,
          ...(input.release === undefined ? [] : ["--release", `${input.release.version}:${input.release.pr}:${input.release.branch}`, ...(input.release.noCarry ? ["--no-carry"] : [])]));
        if (scoped["ok"] !== true) throw new Error(`task scope: ${refused(scoped)}`);
        const digest = gateStateOf(await toolroll("task", "show", input.taskId)).scopeDigest;
        if (digest === null) throw new Error(`task ${input.taskId} has no scope after filing it`);
        return { scopeDigest: digest };
      },
      async complete(taskId, receipt) {
        const answer = await toolroll("task", "complete", taskId, "--digest", receipt);
        return answer["ok"] === true ? { ok: true } : { ok: false, message: refused(answer) };
      },
      async busy() {
        const db = new (sqlite().DatabaseSync)(database, { readOnly: true }) as unknown as Database;
        try {
          // Match the deploy guard, including unfinished runs whose claim is gone. Keep one read snapshot.
          db.exec("BEGIN");
          const work = activeUpdateWork(db);
          const tasks = db.prepare(`SELECT DISTINCT external_id FROM task_ref WHERE id IN (
            SELECT task_ref FROM run WHERE outcome IS NULL
            UNION SELECT task_ref FROM claim WHERE released_at IS NULL
            UNION SELECT task_ref FROM run_stop WHERE settled_at IS NULL
          ) ORDER BY external_id`).all().map(row => String(row["external_id"]));
          db.exec("COMMIT");
          return { running: Object.values(work).reduce((total, count) => total + count, 0), tasks };
        } finally { db.close(); }
      },
      async deploy({ run: runId, worktree, stage, operation }) {
        // Approval policy §1.7: this runtime proves the candidate FIRST — a person approved it, its exact result passed
        // the approved check and is complete, and the checkout is exactly that commit — before anything from the
        // candidate's checkout runs. The candidate's own script never decides its own deployment.
        const proven = proveCandidate(runId);
        if (!proven.ok) return stopped(stage, proven.message);
        // The approved commit's own deployment, extracted by this runtime: drain, backup, rehearsal, swap, health. Its
        // last JSON line names the runtime it installed; the CLI names are moved to it by the release's link step.
        // The operation the coordinator reserved, adopted by the deploy run with its secret on stdin (never in argv).
        const result = await deployScript(worktree, stage, runId, proven, ["--yes", ...(operation === undefined ? [] : ["--operation", operation.id])], operation?.secret);
        const runtime = deployedRuntime(result.stdout);
        if (result.code !== 0 || runtime === null) return stopped(stage, tail(result));
        return { ok: true, runtime };
      },
      async recoverDeploy({ run: runId, worktree, stage }) {
        // Before prepare saves deployment.json, staging has not touched the service or admission gate.
        if (!existsSync(join(stage, "deployment.json"))) return { ok: true };
        // A deployment that outlived a killed release is still at work: recovering under it would race it.
        const running = (options.processes ?? processes)().filter(one => one.command.includes("deploy-browser.mjs") && one.command.includes(stage));
        if (running.length > 0) return { ok: false, message: `the deployment is still running (process ${running.map(one => one.pid).join(", ")}); let it finish, then rerun` };
        // Recovery needs no approval, but it runs only the recorded commit's own script, extracted by this runtime.
        const recorded = recordedCommit(runId);
        if (recorded === null) return stopped(stage, `Run ${runId} names no commit to recover with.`);
        const result = await deployScript(worktree, stage, runId, recorded, ["--phase", "recover"]);
        if (result.code === 0) return { ok: true };
        // Killed while preparing, before it paused anything: nothing to undo (its journal is kept).
        const journal = (() => { try { return object(JSON.parse(readFileSync(join(stage, "deployment.json"), "utf8"))); } catch { return {}; } })();
        if (journal["phase"] === "preparing" && liveOwner() !== journal["id"]) return { ok: true };
        return stopped(stage, `${tail(result)} (the deployment journal is at ${String(journal["phase"] ?? "an unreadable phase")}; ${join(stage, "deployment.json")})`);
      },
      async deploymentIdle(stage) {
        // Whatever the stage: no deployment is running, and no update pause is held.
        if ((options.processes ?? processes)().some(one => one.command.includes("deploy-browser.mjs"))) return false;
        if (liveOwner() !== null) return false;
        if (stage === null) return false;
        const journalFile = join(stage, "deployment.json");
        // Never prepared: staging touched neither the service nor the update pause.
        if (!existsSync(journalFile)) return true;
        // Its journal lock is free (nothing holds the journal), and it stopped where nothing changed, or finished.
        try { acquireDeploymentLock(journalFile, 0).release(); } catch { return false; }
        let phase: unknown;
        try { phase = object(JSON.parse(readFileSync(journalFile, "utf8")))["phase"]; } catch { return false; }
        return phase === "preparing" || phase === "released" || phase === "deployed";
      },
      async cliLinks() { return findCliLinks(); },
      async switchLinks(links, bin, version) {
        const answers = (path: string) => spawnSync(path, ["--version"], { encoding: "utf8", env: cleanEnv(), timeout: 30_000 }).stdout?.trim() === version;
        switchCliLinks(links, bin, answers);
      },
    },
    github: {
      async authenticated() { return (await gh("auth", "status")).code === 0; },
      async pullRequest(repo, branch) {
        const rows = (await ghJson("gh pr list", "pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--limit", "10", "--json", "number,state,headRefOid,baseRefName,mergeCommit")) as Json[];
        const prs: PullRequest[] = rows.map(row => ({
          number: Number(row["number"]), state: row["state"] === "MERGED" ? "merged" : row["state"] === "OPEN" ? "open" : "closed",
          head: String(row["headRefOid"]), base: String(row["baseRefName"]), mergeCommit: textOr(object(row["mergeCommit"])["oid"]),
        }));
        return prs.find(one => one.state === "open") ?? prs.filter(one => one.state === "merged").sort((a, b) => b.number - a.number)[0] ?? null;
      },
      // Every attempt (filter=all), with its app, check suite and commit: the release judges each job by its latest attempt.
      async checks(repo, sha, options) { return readCheckRuns(reads, ciGh, repo, sha, options); },
      async complete(repo, sha) { return readSuitesComplete(reads, ciGh, repo, sha); },
      async mainHead(repo) { return readMainHead(reads, ciGh, repo); },
      async contains(repo, sha, ancestor) { return readContains(reads, ciGh, repo, sha, ancestor); },
      async upToDateRequired(repo) { return readMainProtection(reads, ciGh, repo); },
      async merge(repo, pr, head, message) {
        // The squash commit's message lists every commit that landed after the approval (release-once.md). Never asked
        // again blindly: after a short network failure GitHub is read to learn whether it merged (writeWithRecheck).
        return writeWithRecheck(`merging #${pr}`, net, {
          write: () => ghWrite("api", "-X", "PUT", `repos/${repo}/pulls/${pr}/merge`, "-f", "merge_method=squash", "-f", `sha=${head}`,
            ...(message === undefined ? [] : ["-f", `commit_message=${message}`])),
          accept: result => {
            const merged = object(JSON.parse(result.stdout));
            if (typeof merged["sha"] !== "string") throw new Error(`GitHub did not merge #${pr}: ${String(merged["message"] ?? "no merge commit")}`);
            return merged["sha"];
          },
          refuse: result => { throw failed(result, "gh api pulls merge"); },
          recheck: () => pullMergedAt(repo, pr, head),
        });
      },
      async tag(repo, tag) { return readTag(repo, tag); },
      async createTag(repo, tag, sha) {
        await writeWithRecheck(`creating ${tag}`, net, {
          write: () => ghWrite("api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/tags/${tag}`, "-f", `sha=${sha}`),
          accept: () => undefined,
          refuse: result => { throw failed(result, `creating ${tag}`); },
          recheck: async () => {
            const at = await readTag(repo, tag);
            return at === sha ? { state: "done", value: undefined } : at === null ? { state: "not-done" } : { state: "other", why: `${tag} now points at ${at.slice(0, 7)}` };
          },
        });
      },
      async release(repo, tag) { return (await gh("release", "view", tag, "--repo", repo, "--json", "tagName")).code === 0; },
    },
    registry: {
      async published(name, version) {
        const response = await get(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(20_000) });
        if (response.status === 404) return false;
        if (!response.ok) throw new Error(`the npm registry answered ${response.status} for ${name}@${version}`);
        return object(await response.json())["version"] === version;
      },
    },
    homebrew: {
      repo: tap,
      async checked(head) {
        // Only a workflow that runs on pull requests (or pushes) puts checks on the tap's change; apps that open a
        // check suite and never run it don't count. Workflows are read as the change has them and as the tap's default
        // branch has them (pull_request_target runs from there); a file this can't read counts as checking.
        for (const ref of [head, await defaultBranch()]) {
          const listed = await gh("api", `repos/${tap}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`, "--jq", ".[] | select(.type == \"file\") | .path");
          if (listed.code !== 0) {
            if (/Not Found|HTTP 404/.test(listed.stderr + listed.stdout)) continue;
            throw new Error(`listing ${tap}'s workflows at ${ref}: ${listed.stderr.trim()}`);
          }
          for (const path of listed.stdout.split("\n").filter(Boolean)) {
            if (!/\.ya?ml$/.test(path)) continue;
            const file = await gh("api", `repos/${tap}/contents/${path}?ref=${encodeURIComponent(ref)}`, "--jq", ".content");
            if (file.code !== 0) return true;
            if (workflowRunsOnChange(Buffer.from(file.stdout.replace(/\\n|\s/g, ""), "base64").toString("utf8"))) return true;
          }
        }
        return false;
      },
      async statuses(head) {
        // The older commit-status API, which some CI reports through instead of checks; newest first, so reversed.
        const out = await must(gh("api", "--paginate", `repos/${tap}/commits/${head}/statuses?per_page=100`, "--jq", ".[] | {context, state}"), "gh api statuses");
        return out.split("\n").filter(Boolean).map(line => object(JSON.parse(line))).reverse().map((one): CheckRun => {
          const state = String(one["state"]);
          return { name: `status: ${String(one["context"])}`, status: state === "pending" ? "in_progress" : "completed", conclusion: state === "pending" ? null : state === "success" ? "success" : "failure" };
        });
      },
      async state(version): Promise<HomebrewState> {
        const branch = await defaultBranch();
        const current = await formulaAt(branch);
        if (current.text.includes(`-${version}.tgz`)) return { kind: "current" };
        // Ordering (pipeline-speed.md, P1): a tap already on a later version is never moved back by an older release.
        const named = formulaVersion(current.text);
        if (named !== null && versionAfter(named, version)) return { kind: "newer", version: named };
        // Only a change from the tap's own branch counts: a fork's pull request of the same branch name never does.
        const open = (await ghJson("gh pr list", "pr", "list", "--repo", tap, "--head", brewBranch(version), "--state", "open", "--json", "number,headRefOid,headRepository,headRepositoryOwner,isCrossRepository")) as Json[];
        const own = open.filter(one => tapOwnHead(one, tap));
        if (own.length > 1) throw new Error(`${tap} has ${own.length} open changes for ${brewBranch(version)}`);
        const pr = own[0];
        return pr === undefined ? { kind: "missing" } : { kind: "proposed", pr: Number(pr["number"]), head: String(pr["headRefOid"]) };
      },
      async propose(version) {
        const tarball = `https://registry.npmjs.org/toolroll/-/toolroll-${version}.tgz`;
        const response = await get(tarball, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`downloading ${tarball} answered ${response.status}`);
        const sha256 = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
        const base = await defaultBranch();
        const baseSha = String(object(object(await ghJson("gh api git/ref", "api", `repos/${tap}/git/ref/heads/${base}`))["object"])["sha"]);
        const current = await formulaAt(baseSha);
        const baseVersion = formulaVersion(current.text);
        if (baseVersion === null || versionAfter(baseVersion, version)) throw new Error("The tap current version is unreadable or newer; no downgrade was proposed.");
        const next = bumpFormula(current.text, tarball, sha256);
        const branch = brewBranch(version);
        // A branch left by an earlier attempt is reused.
        const made = await gh("api", "-X", "POST", `repos/${tap}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${baseSha}`);
        if (made.code !== 0 && !/Reference already exists/.test(made.stderr + made.stdout)) throw new Error(`creating ${tap} ${branch}: ${made.stderr.trim()}`);
        // A branch left by an earlier attempt starts again from the base (security scan): none of its history is kept.
        if (made.code !== 0) await must(gh("api", "-X", "PATCH", `repos/${tap}/git/refs/heads/${branch}`, "-f", `sha=${baseSha}`, "-F", "force=true"), `resetting ${tap} ${branch}`);
        const onBranch = await formulaAt(branch);
        if (onBranch.text !== next) {
          await must(gh("api", "-X", "PUT", `repos/${tap}/contents/${formula}`, "-f", `message=toolroll ${version}`, "-f", `branch=${branch}`, "-f", `sha=${onBranch.sha}`,
            "-f", `content=${Buffer.from(next).toString("base64")}`), `updating ${formula}`);
        }
        await must(gh("pr", "create", "--repo", tap, "--head", branch, "--base", base, "--title", `toolroll ${version}`, "--body", `Bumps the formula to toolroll ${version} (${tarball}, sha256 ${sha256}).`), "gh pr create");
        const opened = (await ghJson("gh pr view", "pr", "view", branch, "--repo", tap, "--json", "number,headRefOid")) as Json;
        return { pr: Number(opened["number"]), head: String(opened["headRefOid"]) };
      },
      async verified(pr, head, version) {
        // The change at exactly `head` is the tap's own, and its formula is exactly today's formula with npm's published
        // tarball and that tarball's own sha256: nothing else is ever merged.
        const view = object(await ghJson("gh pr view", "pr", "view", String(pr), "--repo", tap, "--json", "number,headRefOid,headRefName,baseRefName,headRepository,headRepositoryOwner,isCrossRepository,state"));
        const base = await defaultBranch();
        const baseHead = String(object(object(await ghJson("gh api git/ref", "api", `repos/${tap}/git/ref/heads/${base}`))["object"])["sha"]);
        // The whole change against the tap's default branch head: its merge base, its commits and every file it touches.
        const compare = object(await ghJson("gh api compare", "api", `repos/${tap}/compare/${encodeURIComponent(baseHead)}...${encodeURIComponent(head)}`));
        const tarball = `https://registry.npmjs.org/toolroll/-/toolroll-${version}.tgz`;
        const response = await get(tarball, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) return { ok: false, why: `downloading ${tarball} answered ${response.status}` };
        const sha256 = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
        const current = (await formulaAt(baseHead)).text;
        const expected = bumpFormula(current, tarball, sha256);
        const problem = tapChangeProblem({ tap, pr, head, version, formula, defaultBranch: base, baseHead, baseVersion: formulaVersion(current), view, compare, expected, atHead: (await formulaAt(head)).text, sha256 });
        return problem === null ? { ok: true } : { ok: false, why: problem };
      },
      async merge(pr, head) {
        await writeWithRecheck(`merging ${tap} #${pr}`, net, {
          write: () => ghWrite("api", "-X", "PUT", `repos/${tap}/pulls/${pr}/merge`, "-f", "merge_method=squash", "-f", `sha=${head}`),
          accept: result => {
            const merged = object(JSON.parse(result.stdout));
            if (merged["merged"] !== true || typeof merged["sha"] !== "string") throw new Error(`GitHub did not merge ${tap} #${pr}: ${String(merged["message"] ?? "no merge commit")}`);
          },
          refuse: result => { throw failed(result, `merging ${tap} #${pr}`); },
          recheck: async () => { const state = await pullMergedAt(tap, pr, head); return state.state === "done" ? { state: "done", value: undefined } : state; },
        });
      },
    },
  };

  /** A tag's commit as GitHub answers now (an annotated tag: the commit it names), or null when there is no such tag. */
  async function readTag(repo: string, tag: string): Promise<string | null> {
    const result = await gh("api", `repos/${repo}/git/ref/tags/${tag}`);
    if (result.code !== 0) {
      if (/Not Found|HTTP 404/.test(result.stderr + result.stdout)) return null;
      throw new Error(`gh api git/ref/tags/${tag} failed: ${result.stderr.trim()}`);
    }
    const target = object(object(JSON.parse(result.stdout))["object"]);
    if (target["type"] !== "tag") return String(target["sha"]);
    return String(object(object(await ghJson("gh api git/tags", "api", `repos/${repo}/git/tags/${String(target["sha"])}`))["object"])["sha"]);
  }
  /** Whether a pull request is merged from exactly `head` (its merge commit), still open at `head` (not merged), or
   * anything else — read after a merge's answer was lost. */
  async function pullMergedAt(repo: string, pr: number, head: string): Promise<{ state: "done"; value: string } | { state: "not-done" } | { state: "other"; why: string }> {
    const pull = object(await ghJson("gh api pulls", "api", `repos/${repo}/pulls/${pr}`));
    const at = object(pull["head"])["sha"], commit = pull["merge_commit_sha"];
    if (pull["merged"] === true && at === head && typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit)) return { state: "done", value: commit };
    if (pull["merged"] === false && pull["state"] === "open" && at === head) return { state: "not-done" };
    return { state: "other", why: `#${pr} is no longer open at ${head.slice(0, 7)}` };
  }
  async function defaultBranch(): Promise<string> {
    return (await must(gh("api", `repos/${tap}`, "--jq", ".default_branch"), `gh api repos/${tap}`)).trim();
  }
  async function formulaAt(ref: string): Promise<{ text: string; sha: string }> {
    const file = object(await ghJson(`reading ${formula}`, "api", `repos/${tap}/contents/${formula}?ref=${encodeURIComponent(ref)}`));
    return { text: Buffer.from(String(file["content"] ?? ""), "base64").toString("utf8"), sha: String(file["sha"]) };
  }
}

const brewBranch = (version: string) => `toolroll-${version}`;

/**
 * Why a tap change isn't exactly the formula bump this release proposed (security scan), or null when it is: the tap's
 * own open pull request number `pr` at exactly `head`, from its version branch into the default branch; compared with
 * the default branch's head it is one commit on top of exactly that head, changing exactly one file, the formula; and
 * the formula there is exactly today's with npm's published tarball and that tarball's own sha256.
 */
export function tapChangeProblem(input: { tap: string; pr: number; head: string; version: string; formula: string; defaultBranch: string; baseHead: string; baseVersion: string | null;
  view: Json; compare: Json; expected: string; atHead: string; sha256: string }): string | null {
  const { tap, pr, head, version, view, compare } = input;
  // State may have changed since the coordinator checked it. Judge the immutable base used for this comparison.
  if (input.baseVersion === null) return `${tap} current version cannot be read`;
  if (versionAfter(input.baseVersion, version)) return `${tap} already names newer ${input.baseVersion}; refusing ${version}`;
  if (Number(view["number"]) !== pr || view["headRefOid"] !== head || view["headRefName"] !== brewBranch(version) || view["state"] !== "OPEN" || !tapOwnHead(view, tap)) {
    return `${tap} #${pr} isn't the tap's own open change at ${head.slice(0, 7)}`;
  }
  if (view["baseRefName"] !== input.defaultBranch) return `${tap} #${pr} merges into ${String(view["baseRefName"])}, not ${input.defaultBranch}`;
  const mergeBase = compare["merge_base_commit"] !== null && typeof compare["merge_base_commit"] === "object" ? (compare["merge_base_commit"] as Json)["sha"] : undefined;
  if (mergeBase !== input.baseHead) return `${tap} #${pr} isn't on ${input.defaultBranch}'s head ${input.baseHead.slice(0, 7)}`;
  if (compare["status"] !== "ahead" || compare["ahead_by"] !== 1 || compare["behind_by"] !== 0) return `${tap} #${pr} isn't exactly one commit on ${input.defaultBranch}'s head`;
  const files = Array.isArray(compare["files"]) ? compare["files"] as Json[] : null;
  if (files === null || files.length !== 1 || files[0]!["filename"] !== input.formula || files[0]!["status"] !== "modified") return `${tap} #${pr} changes more than ${input.formula}`;
  if (input.atHead !== input.expected) return `${tap} #${pr}'s formula isn't npm's ${version} tarball with its sha256 ${input.sha256.slice(0, 12)}`;
  return null;
}

/** Whether a pull request's head is a branch of the tap itself (never a fork's). */
export function tapOwnHead(pr: Json, tap: string): boolean {
  const [owner, name] = tap.split("/");
  const repo = pr["headRepository"], who = pr["headRepositoryOwner"];
  const repoName = repo !== null && typeof repo === "object" ? (repo as Record<string, unknown>)["name"] : undefined;
  const ownerLogin = who !== null && typeof who === "object" ? (who as Record<string, unknown>)["login"] : undefined;
  return pr["isCrossRepository"] === false && typeof repoName === "string" && typeof ownerLogin === "string"
    && repoName.toLowerCase() === (name ?? "").toLowerCase() && ownerLogin.toLowerCase() === (owner ?? "").toLowerCase();
}

/** The version a formula's tarball url names (`…/toolroll-<x.y.z>.tgz`), or null. */
export function formulaVersion(text: string): string | null {
  const found = /^\s*url "[^"]*-(\d+\.\d+\.\d+)\.tgz"/m.exec(text);
  return found === null ? null : found[1]!;
}

/** Whether version `a` comes after `b` (both x.y.z). */
export function versionAfter(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** The events that put checks on a change. */
const CHANGE_EVENTS = new Set(["pull_request", "pull_request_target", "push", "merge_group"]);

/**
 * Whether a workflow's triggers (its top-level `on:` as a name, a list or a map) include a change to the repository.
 * A file that doesn't parse, or whose triggers aren't one of those shapes, counts as running, so the release waits
 * rather than skipping checks it owes.
 */
export function workflowRunsOnChange(text: string): boolean {
  let parsed: unknown;
  try { parsed = parseYaml(text); } catch { return true; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const workflow = parsed as Record<string, unknown>;
  // YAML 1.1 readers take a bare `on` for true; either key names the triggers.
  const on = "on" in workflow ? workflow["on"] : workflow["true"];
  const events = typeof on === "string" ? [on]
    : Array.isArray(on) ? on
    : on !== null && typeof on === "object" ? Object.keys(on)
    : null;
  if (events === null || !events.every(one => typeof one === "string")) return true;
  return events.some(one => CHANGE_EVENTS.has(one));
}

/** The formula with its first `url` and `sha256` replaced; anything else is left exactly as it was. */
export function bumpFormula(text: string, url: string, sha256: string): string {
  if (!/^\s*url "[^"]*"/m.test(text) || !/^\s*sha256 "[0-9a-f]{64}"/m.test(text)) throw new Error("the formula has no url and sha256 lines to update");
  return text.replace(/^(\s*url ")[^"]*(")/m, `$1${url}$2`).replace(/^(\s*sha256 ")[0-9a-f]{64}(")/m, `$1${sha256}$2`);
}

/** The plane's person-approval answer from `task show --json`, read strictly: anything malformed is no person. */
function personAnswerOf(value: unknown): { person?: { ok: true; method: string } | { ok: false; why: string } } {
  if (value === undefined) return {};
  const read = object(value);
  if (read["ok"] === true && typeof read["method"] === "string") return { person: { ok: true, method: read["method"] } };
  return { person: { ok: false, why: typeof read["why"] === "string" ? read["why"] : "the plane's answer about who approved it can't be read" } };
}

/**
 * The release's authority record through a store (release-once.md): what `toolroll release` reads and writes for its
 * lease, its carries and its operations. `open` hands a store for each call and `done` lets it go.
 */
export function storeReleaseAdapter(open: () => Store, done: (store: Store) => void, now: () => Date, runner?: BuildRunner,
  /** Releases that approve themselves (auto-approve-green.md): the plane's own look at CI on a commit, and where the
   * check receipts are kept. Absent: no automatic approval, every release asks a person. */
  auto?: AutoObservers): NonNullable<ReleaseAdapters["release"]> {
  const withStore = <T>(body: (store: Store) => T): T => { const store = open(); try { return body(store); } finally { done(store); } };
  return {
    ...(auto === undefined ? {} : { auto: autoReleaseAdapter(withStore, now, auto) }),
    // After a failed release check, and before a pass is taken: the plane's own classification (check-failure.ts).
    ...(auto === undefined ? {} : {
      async recheck(taskId: string) {
        return withStore(store => {
          const answer = recheckReleaseTask(store, auto.evidenceRoot, taskId, now());
          return answer.action === "rerun" ? { action: "rerun" as const, why: answer.why } : answer.action === "pending" ? { action: "pending" as const } : { action: "stop" as const, class: answer.class, why: answer.why };
        });
      },
      async standing(taskId: string, run: number) {
        return withStore(store => {
          const standing = releaseCheckStanding(store, auto.evidenceRoot, { taskId, run });
          return standing.ok ? { ok: true as const, retried: standing.retried } : { ok: false as const, why: standing.why, retried: standing.retried };
        });
      },
    }),
    async authority(taskId) {
      return withStore(store => {
        const found = releaseAuthorityOfTask(store, taskId);
        if (found === null) return null;
        const a = found.authority;
        return { id: a.id, generation: a.generation, state: a.state, tipSha: a.tipSha, tipTask: a.tipTask, version: a.version, pr: a.pr,
          landed: releaseCarries(store, a.id).flatMap(carry => carry.commits) };
      });
    },
    async live(taskId, action) {
      return withStore(store => { const live = liveReleaseOf(store, taskId, action, now()); return live.applies ? { applies: true, ok: live.ok, why: live.ok ? null : live.why } : { applies: false, ok: false, why: null }; });
    },
    async lease(authority, owner) { return withStore(store => takeReleaseLease(store, authority, owner, now())); },
    async renew(authority, owner, epoch) { return withStore(store => renewReleaseLease(store, authority, owner, epoch, now())); },
    async carry(authority, to, requestId, epoch) {
      const store = open();
      try {
        const result = await proveCarry(store, { authority, to, requestId, epoch, now: now(), ...(runner === undefined ? {} : { runner }) });
        return result.ok ? { ok: true, taskId: result.taskId } : { ok: false, message: result.message };
      } finally { done(store); }
    },
    async reserve(input) {
      return withStore(store => {
        const secret = randomBytes(32).toString("hex");
        const result = reserveRelease(store, { ...input, operationId: randomUUID(), now: now(), secret });
        return result.ok ? { ok: true as const, operation: result.operation.id, secret } : result;
      });
    },
    async start(operation, epoch) { return withStore(store => runReleaseOperation(store, operation, epoch, now())); },
    async finish(operation, outcome, facts, epoch) { return withStore(store => finishReleaseOperation(store, operation, outcome, facts, now(), epoch)); },
    async needsApproval(authority, reason, epoch) { return withStore(store => requireFreshReleaseApproval(store, authority, reason, epoch, now())); },
    async operations(authority) {
      return withStore(store => releaseOperations(store, authority).map(op => ({ id: op.id, kind: op.kind, state: op.state, candidate: op.candidate, externalRef: op.externalRef, reservedAt: op.reservedAt,
        direct: op.direct, issuerGone: releaseIssuerGone(op), stage: op.stage })));
    },
  };
}

/** The plane's automatic release approval through a store (release-auto.ts): what `toolroll release` asks. It hands the
 * plane ids only; the plane reads CI itself (`observe`) right before it seals. */
function autoReleaseAdapter(withStore: <T>(body: (store: Store) => T) => T, now: () => Date, auto: AutoObservers): NonNullable<NonNullable<ReleaseAdapters["release"]>["auto"]> {
  const reportProblem = () => auto.reportsProtected === true ? null
    : "CI test reports aren't protected from candidate writes, so a person must approve this release";
  return {
    async setting(taskId) {
      return withStore(store => { try { const ref = store.lookupRef(taskId); return ref?.repo != null && releaseAutoApproves(store, ref.repo); } catch { return false; } });
    },
    async authorizeCheck(input) {
      const problem = reportProblem();
      if (problem !== null) return { ok: false as const, why: problem };
      // The comparison base for what the release changes: GitHub's own merge base of the candidate with the release's
      // base branch (its signed terms), read by the plane — never a task branch or a build's recorded base.
      const branch = withStore(store => store.getScope(input.taskId)?.releaseTerms?.base ?? null);
      if (branch === null) return { ok: false as const, why: "only a release task is approved automatically" };
      let base: string;
      try { base = await auto.mergeBase(branch, input.candidate); }
      catch (error) { return { ok: false as const, why: `GitHub couldn't say where ${input.candidate.slice(0, 7)} left ${branch} (${String((error as Error)?.message ?? error).slice(0, 160)})` }; }
      return withStore(store => { const answer = authorizeAutoCheck(store, { ...input, base, now: now() }); return answer.ok ? { ok: true as const } : answer; });
    },
    async checking(taskId) {
      const problem = reportProblem();
      if (problem !== null) return { ok: false as const, why: problem };
      return withStore(store => { const answer = autoReleaseApprovalOf(store, taskId, "auto-check"); return answer.ok ? { ok: true as const } : { ok: false as const, why: answer.why }; });
    },
    async approve(input) {
      const unprotected = reportProblem();
      if (unprotected !== null) {
        withStore(store => giveUpAutoApproval(store, { taskId: input.taskId, why: unprotected, now: now() }));
        return { ok: false as const, why: unprotected };
      }
      let ci: CiObservation | null = null, problem = "";
      // A short network failure is asked again a few times; GitHub not answering is never a pass.
      for (let attempt = 0; attempt < 3 && ci === null; attempt++) {
        try { ci = await auto.observe(input.candidate); } catch (error) { problem = String((error as Error)?.message ?? error).slice(0, 200); }
      }
      if (ci === null) {
        const why = `GitHub CI on ${input.candidate.slice(0, 7)} couldn't be read (${problem})`;
        withStore(store => giveUpAutoApproval(store, { taskId: input.taskId, why, now: now() }));
        return { ok: false as const, why };
      }
      const observed = ci;
      let upToDate: boolean | null;
      try { upToDate = await auto.upToDateRequired(); } catch { upToDate = null; }
      return withStore(store => sealAutoGreen(store, { ...input, ci: observed, mainUpToDate: upToDate, evidenceRoot: auto.evidenceRoot, now: now() }));
    },
    async giveUp(taskId, why) { withStore(store => giveUpAutoApproval(store, { taskId, why, now: now() })); },
    async ciRunning(taskId, candidate) { withStore(store => noteCiRunning(store, { taskId, candidate, now: now() })); },
    async ciPassed(taskId, candidate, ask) {
      // Reconcile the plane's record, not journal flags; without a pending row there is nothing to lift.
      if (!withStore(store => releaseCiHoldOf(store, taskId) !== null || releaseCiRunningOf(store, taskId) !== null)) return { ok: true as const };
      // The plane reads CI itself; a short network failure is asked again a few times, and unreadable is never a pass.
      let ci: CiObservation | null = null, problem = "";
      for (let attempt = 0; attempt < 3 && ci === null; attempt++) {
        try { ci = await auto.observe(candidate); } catch (error) { problem = String((error as Error)?.message ?? error).slice(0, 200); }
      }
      if (ci === null) return { ok: false as const, why: `GitHub CI on ${candidate.slice(0, 7)} couldn't be read (${problem})` };
      const observed = ci;
      return withStore(store => liftCiHold(store, { taskId, candidate, ci: observed, ask, now: now() }));
    },
    async checkFailed(taskId, why) { withStore(store => noteAutoCheckFailed(store, { taskId, why, now: now() })); },
    async released(taskId, tag) { withStore(store => noteAutoRelease(store, { taskId, tag, now: now() })); },
    async holdPublish(taskId, why) { withStore(store => holdAutoPublish(store, { taskId, why, now: now() })); },
    async publishHeld(taskId) { return withStore(store => autoPublishHeld(store, taskId)); },
  };
}

/** What the plane itself reads for an automatic release approval. */
export type AutoObservers = {
  /** The plane's executor policy, never a report field or project setting. Unknown refuses. Production currently
   * cannot establish this; synthetic observers may supply protected execution to exercise the remaining gates. */
  reportsProtected?: boolean;
  observe: (sha: string) => Promise<CiObservation>;
  /** GitHub's merge base of `sha` with the branch `base` of the recorded repository. */
  mergeBase: (base: string, sha: string) => Promise<string>;
  /** Whether main's protection holds for the account that merges (readMainProtection); null when unreadable. */
  upToDateRequired: () => Promise<boolean | null>;
  evidenceRoot: string;
};

/** The environment every CI read runs gh with: no caller PATH, host, config folder or proxy override. */
function ciEnv(): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(["HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "GH_TOKEN", "GITHUB_TOKEN"].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  return { ...kept, PATH: "/usr/bin:/bin", GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
}

/**
 * Every check run GitHub holds for one commit — every attempt, not only the latest (`filter=all`; GitHub's default
 * lists only the latest of each), every page — with its id, app, check suite and the commit it is filed under, oldest
 * first. A row that doesn't parse stops the read: a partial answer is never taken for the whole.
 */
export async function readCheckRuns(run: Exec, gh: string, repo: string, sha: string,
  /** A release tag (pipeline-speed.md, item 3): a push of exactly this tag binds its workflow file too. */
  options: { tag?: string } = {}): Promise<CheckRun[]> {
  if (options.tag !== undefined && !/^v\d+\.\d+\.\d+$/.test(options.tag)) throw new Error("not a release tag");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("not a repository and commit GitHub can be asked about");
  const out = await must(run(gh, ["api", "--hostname", "github.com", "--paginate", `repos/${repo}/commits/${sha}/check-runs?filter=all&per_page=100`,
    "--jq", ".check_runs[] | {id, name, status, conclusion, app: .app.slug, suite: .check_suite.id, head: .head_sha}"], { cwd: "/", env: ciEnv() }), "gh api check-runs");
  // Which workflow each check suite is a run of (GitHub's workflow-run API): a newer run of a workflow supersedes its
  // older runs on this commit (release.ts prChecksVerdict).
  const flows = await must(run(gh, ["api", "--hostname", "github.com", "--paginate", `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
    "--jq", ".workflow_runs[] | {suite: .check_suite_id, workflow: .workflow_id, path: .path, head: .head_sha, event: .event, branch: .head_branch, bases: [(.pull_requests // [])[] | .base.ref], prs: [(.pull_requests // [])[] | {number, repo: .base.repo.url}]}"], { cwd: "/", env: ciEnv() }), "gh api actions/runs");
  // A pull request's base can be edited after its runs: a run counts only if no pull request it belongs to ever had its
  // base changed (GitHub's timeline), so a run made against another base can't later read as a run into main.
  const retargeted = new Map<number, boolean>();
  const everRetargeted = async (pr: number): Promise<boolean> => {
    const known = retargeted.get(pr);
    if (known !== undefined) return known;
    let changed = true;
    try {
      const events = await run(gh, ["api", "--hostname", "github.com", "--paginate", `repos/${repo}/issues/${pr}/timeline?per_page=100`, "--jq", ".[] | .event"], { cwd: "/", env: ciEnv() });
      changed = events.code !== 0 || events.stdout.split("\n").some(line => line.trim() === "base_ref_changed");
    } catch { changed = true; }
    retargeted.set(pr, changed);
    return changed;
  };
  const workflowOf = new Map<number, number>();
  // Each suite's workflow file: a required check counts only from the workflow that defines it (release.ts).
  const pathOf = new Map<number, string>();
  for (const line of flows.split("\n").filter(Boolean)) {
    const one = object(JSON.parse(line));
    if (!Number.isSafeInteger(one["suite"]) || !Number.isSafeInteger(one["workflow"]) || one["head"] !== sha || typeof one["path"] !== "string" || one["path"] === "") throw new Error("GitHub answered a workflow run this can't read");
    const known = workflowOf.get(Number(one["suite"]));
    if (known !== undefined && (known !== Number(one["workflow"]) || pathOf.get(Number(one["suite"])) !== one["path"])) throw new Error("GitHub named two workflows for one check suite");
    workflowOf.set(Number(one["suite"]), Number(one["workflow"]));
    // Only a run on a pull request into main, or a push to main, binds its workflow file: a pull request into another
    // branch reads that branch's workflow and join verifier, which the candidate may control (security scan of the
    // join). Any other run keeps no path, so no required check counts from it.
    // Each pull request the run belongs to must be this repository's own (a number from another repository names a
    // different pull request here): any other refuses the run.
    const prs = (Array.isArray(one["prs"]) ? one["prs"] : []).map(pr => (pr !== null && typeof pr === "object" ? pr as Record<string, unknown> : {}));
    const ours = prs.length > 0 && prs.every(pr => Number.isSafeInteger(pr["number"]) && pr["repo"] === `https://api.github.com/repos/${repo}`);
    const untouched = one["event"] !== "pull_request" || (ours && !(await Promise.all(prs.map(pr => everRetargeted(Number(pr["number"]))))).some(Boolean));
    if ((options.tag === undefined ? mainTriggered(one) : tagTriggered(one, options.tag)) && untouched) pathOf.set(Number(one["suite"]), String(one["path"]));
  }
  const runs = out.split("\n").filter(Boolean).map(line => {
    const one = object(JSON.parse(line));
    if (!Number.isSafeInteger(one["id"]) || typeof one["name"] !== "string" || typeof one["status"] !== "string") throw new Error("GitHub answered a check run this can't read");
    const suite = Number.isSafeInteger(one["suite"]) ? Number(one["suite"]) : null;
    return { id: Number(one["id"]), name: one["name"], status: one["status"], conclusion: textOr(one["conclusion"]), app: textOr(one["app"]),
      suite, head: textOr(one["head"]), workflow: suite === null ? null : workflowOf.get(suite) ?? null, workflowPath: suite === null ? null : pathOf.get(suite) ?? null } satisfies CheckRun;
  });
  if (new Set(runs.map(one => one.id)).size !== runs.length) throw new Error("GitHub answered the same check run twice");
  // Each unsuccessful GitHub Actions attempt: whether GitHub's own job record (a check run's id is its job's) shows it
  // ending before any of the workflow's own steps ran. Only that ever counts as the runner's failure; unreadable is no.
  for (const one of runs as CheckRun[]) {
    if (one.app !== "github-actions" || one.status !== "completed" || one.conclusion === "success" || one.conclusion === "skipped" || one.conclusion === "neutral") continue;
    one.beforeTests = await readJobBeforeTests(run, gh, repo, one.id!);
  }
  return runs.sort((a, b) => a.id - b.id);
}

/** One job's step outcomes as GitHub's Actions API reports them. */
export type JobRecord = { id: number; status: string; conclusion: string | null; steps: { number: number; name: string; status: string; conclusion: string | null }[] };

/**
 * Whether a finished, unsuccessful job ended before any of the workflow's own steps ran: every step after GitHub's own
 * first one ("Set up job", always number 1) never ran (no conclusion, or skipped) — leaving out only GitHub's own
 * closing "Complete job" when it is the last step. Step numbers and outcomes are the runner's records; nothing the
 * candidate prints is read. A job with no steps never reached one. Anything else (a step that ran, even the checkout)
 * is not confirmed infrastructure.
 */
export function failedBeforeTests(job: JobRecord): boolean {
  if (job.status !== "completed" || job.conclusion === "success" || job.conclusion === null) return false;
  const steps = [...job.steps].sort((a, b) => a.number - b.number);
  if (new Set(steps.map(one => one.number)).size !== steps.length) return false;
  const last = steps.at(-1);
  const own = steps.filter(one => one.number > 1 && !(one === last && one.name === "Complete job" && steps.length > 1));
  return own.every(one => one.status !== "in_progress" && (one.conclusion === null || one.conclusion === "skipped"));
}

/** GitHub's job record for one check run (its job), read strictly: null when it can't be read whole. */
export async function readJobBeforeTests(run: Exec, gh: string, repo: string, id: number): Promise<boolean | null> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(id) || id <= 0) return null;
  let out: { code: number; stdout: string };
  try { out = await run(gh, ["api", "--hostname", "github.com", `repos/${repo}/actions/jobs/${id}`, "--jq", "{id, status, conclusion, steps: [(.steps // [])[] | {number, name, status, conclusion}]}"], { cwd: "/", env: ciEnv() }); }
  catch { return null; }
  if (out.code !== 0) return null;
  let job: Json;
  try { job = object(JSON.parse(out.stdout)); } catch { return null; }
  const steps = Array.isArray(job["steps"]) ? job["steps"].map(object) : null;
  if (job["id"] !== id || typeof job["status"] !== "string" || steps === null) return null;
  if (steps.some(one => !Number.isSafeInteger(one["number"]) || typeof one["status"] !== "string" || typeof one["name"] !== "string")) return null;
  return failedBeforeTests({ id, status: String(job["status"]), conclusion: textOr(job["conclusion"]),
    steps: steps.map(one => ({ number: Number(one["number"]), name: String(one["name"]), status: String(one["status"]), conclusion: textOr(one["conclusion"]) })) });
}

/** GitHub lists check runs from at most the latest 1000 check suites of a commit: the history is whole only below that. */
export const CHECK_SUITE_CEILING = 1000;
export async function readSuitesComplete(run: Exec, gh: string, repo: string, sha: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) return false;
  const out = await run(gh, ["api", "--hostname", "github.com", `repos/${repo}/commits/${sha}/check-suites?per_page=1`, "--jq", ".total_count"], { cwd: "/", env: ciEnv() });
  const total = Number(out.stdout.trim());
  return out.code === 0 && out.stdout.trim() !== "" && Number.isSafeInteger(total) && total >= 0 && total < CHECK_SUITE_CEILING;
}

/** GitHub's merge base of `sha` with branch `base` (the compare API), read by the plane. */
export async function readMergeBase(run: Exec, gh: string, repo: string, base: string, sha: string): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha) || !/^[A-Za-z0-9._/-]+$/.test(base) || base.includes("..")) throw new Error("not a repository, branch and commit GitHub can be asked about");
  const out = (await must(run(gh, ["api", "--hostname", "github.com", `repos/${repo}/compare/${base}...${sha}`, "--jq", ".merge_base_commit.sha"], { cwd: "/", env: ciEnv() }), "gh api compare")).trim();
  if (!/^[0-9a-f]{40}$/.test(out)) throw new Error("GitHub named no merge base");
  return out;
}

/**
 * Main's head as GitHub has it now (eval-harness review 1, finding 4): read by the plane's own gh from GitHub's API,
 * never from a ref in a checkout a build can write.
 */
export async function readMainHead(run: Exec, gh: string, repo: string, branch = "main"): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) throw new Error("not a repository and branch GitHub can be asked about");
  const out = (await must(run(gh, ["api", "--hostname", "github.com", `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.type + \" \" + .object.sha"], { cwd: "/", env: ciEnv() }), "gh api git/ref")).trim();
  const match = /^commit ([0-9a-f]{40})$/.exec(out);
  if (match === null) throw new Error(`GitHub named no commit for ${branch}`);
  return match[1]!;
}

/** Whether `sha` already holds `ancestor` (GitHub's compare: `sha` is not behind it), as GitHub answers now. */
export async function readContains(run: Exec, gh: string, repo: string, sha: string, ancestor: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha) || !/^[0-9a-f]{40}$/.test(ancestor)) throw new Error("not a repository and commits GitHub can be asked about");
  const out = (await must(run(gh, ["api", "--hostname", "github.com", `repos/${repo}/compare/${ancestor}...${sha}`, "--jq", "[.status, .behind_by] | @json"], { cwd: "/", env: ciEnv() }), "gh api compare")).trim();
  let answer: unknown;
  try { answer = JSON.parse(out); } catch { throw new Error("GitHub's comparison couldn't be read"); }
  if (!Array.isArray(answer) || typeof answer[0] !== "string" || !Number.isSafeInteger(answer[1])) throw new Error("GitHub's comparison couldn't be read");
  return answer[1] === 0 && (answer[0] === "ahead" || answer[0] === "identical");
}

/**
 * Main's protection, judged for the principal that merges (eval-harness review 2, finding 1; review 1, finding 4): the
 * plane's own gh, which merges as the same account. A layer holds only when it requires branches to be up to date, names
 * a non-empty set of required checks covering PROTECTION_MINIMUM_CHECKS, bound to GitHub Actions (app 15368), and
 * can't be bypassed by that account:
 * classic protection with "Do not allow bypassing the above settings" (`enforce_admins`); an active ruleset whose
 * bypass list reads whole, names no role, team or organization admin, and says this account never bypasses it. Read
 * only — Toolroll never changes a repository's settings. A layer that can't be read never holds. When no layer holds
 * and one couldn't be read (gh failed for a reason other than "not protected", or its answer didn't parse), the read
 * throws ProtectionUnreadable: "couldn't read GitHub" is never reported as "protection doesn't hold", and never as
 * holding. Null only for a repository or branch name GitHub can't be asked about.
 */
export async function readMainProtection(run: Exec, gh: string, repo: string, branch = "main"): Promise<MainProtection | null> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) return null;
  const missing: string[] = [];
  const held: string[][] = [];
  /** What couldn't be read at all, and the words gh gave. */
  const unread: string[] = [];
  const words = (out: { code: number; stdout: string; stderr: string }) => (out.stderr || out.stdout).trim().split("\n").slice(-1)[0]?.slice(0, 160) || `exit ${out.code}`;
  const judge = (where: string, strict: boolean, checks: string[], bound: string[], bypass: string[]): void => {
    const own: string[] = [];
    if (!strict) own.push(`${where}: "Require branches to be up to date before merging" is off`);
    if (checks.length === 0) own.push(`${where}: no required status checks`);
    else {
      const lacking = PROTECTION_MINIMUM_CHECKS.filter(name => !checks.includes(name));
      if (lacking.length > 0) own.push(`${where}: required checks lack ${lacking.join(", ")}`);
      const unbound = PROTECTION_MINIMUM_CHECKS.filter(name => checks.includes(name) && !bound.includes(name));
      if (unbound.length > 0) own.push(`${where}: required checks must require GitHub Actions (app 15368) as their source: ${unbound.join(", ")}`);
    }
    own.push(...bypass.map(why => `${where}: ${why}`));
    if (own.length === 0) held.push(bound); else missing.push(...own);
  };
  const notProtected = (out: { stdout: string; stderr: string }) => /HTTP 404|Not Found|not protected|not enabled/i.test(`${out.stderr}\n${out.stdout}`);
  const names = (list: unknown, key: string): string[] | null => {
    if (!Array.isArray(list)) return null;
    const out: string[] = [];
    for (const one of list) {
      const name = key === "" ? one : object(one)[key];
      if (typeof name !== "string" || name === "") return null;
      out.push(name);
    }
    return out;
  };
  const actionsChecks = (list: unknown, appKey: string): string[] => Array.isArray(list)
    ? list.flatMap(one => { const check = object(one); return check[appKey] === 15368 && typeof check["context"] === "string" ? [check["context"]] : []; }) : [];
  // Classic branch protection, read whole. Context names alone allow an arbitrary writer to supply their status.
  const classic = await run(gh, ["api", "--hostname", "github.com", `repos/${repo}/branches/${branch}/protection`], { cwd: "/", env: ciEnv() });
  if (classic.code === 0) {
    let answer: unknown = null;
    try { answer = JSON.parse(classic.stdout); } catch { /* unreadable below */ }
    const p = object(answer), checks = p["required_status_checks"];
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) unread.push("classic protection (its answer didn't parse)");
    else if (checks === undefined || checks === null) missing.push("classic protection: \"Require status checks to pass before merging\" is off");
    else {
      const rsc = object(checks), contexts = names(rsc["contexts"] ?? [], ""), apps = names(rsc["checks"] ?? [], "context");
      const admins = p["enforce_admins"];
      // GitHub answered, but without the settings this judges: read, and not holding.
      if (contexts === null || apps === null || typeof rsc["strict"] !== "boolean" || admins === undefined || admins === null || typeof object(admins)["enabled"] !== "boolean") missing.push("classic protection: GitHub's answer doesn't say which checks it requires or whether administrators can bypass it");
      else {
        judge("classic protection", rsc["strict"] === true, [...new Set([...contexts, ...apps])], actionsChecks(rsc["checks"], "app_id"),
          object(admins)["enabled"] === true ? [] : ["\"Do not allow bypassing the above settings\" is off, so administrators can merge past it"]);
      }
    }
  } else if (!notProtected(classic)) unread.push(`classic protection (${words(classic)})`);
  // Rulesets: every active rule requiring status checks on the branch, then its ruleset's enforcement and bypass list.
  const rules = await run(gh, ["api", "--hostname", "github.com", "--paginate", `repos/${repo}/rules/branches/${branch}`,
    "--jq", ".[] | select(.type == \"required_status_checks\") | @json"], { cwd: "/", env: ciEnv() });
  if (rules.code !== 0) unread.push(`main's rulesets (${words(rules)})`);
  else {
    for (const line of rules.stdout.split("\n").filter(one => one.trim() !== "")) {
      let rule: Json;
      try { rule = object(JSON.parse(line)); } catch { unread.push("a ruleset rule (its answer didn't parse)"); continue; }
      const id = rule["ruleset_id"], params = object(rule["parameters"]);
      const checks = names(params["required_status_checks"], "context");
      if (!Number.isSafeInteger(id) || Number(id) <= 0 || checks === null) { missing.push("a ruleset rule doesn't name its ruleset or required checks"); continue; }
      const where = `ruleset ${id}`;
      const got = await run(gh, ["api", "--hostname", "github.com", `repos/${repo}/rulesets/${id}`, "--jq", "{enforcement, target, current_user_can_bypass, bypass_actors} | @json"], { cwd: "/", env: ciEnv() });
      let set: Json | null = null;
      try { if (got.code === 0) set = object(JSON.parse(got.stdout)); } catch { set = null; }
      if (set === null) { unread.push(`${where}: its settings (${got.code === 0 ? "its answer didn't parse" : words(got)})`); continue; }
      const bypass: string[] = [];
      if (set["enforcement"] !== "active") bypass.push("it isn't active");
      if (set["target"] !== "branch") bypass.push("it doesn't target branches");
      if (set["current_user_can_bypass"] !== "never") bypass.push(typeof set["current_user_can_bypass"] === "string"
        ? `the account that merges can bypass it (${set["current_user_can_bypass"]})` : "whether the account that merges can bypass it couldn't be read");
      const actors = set["bypass_actors"];
      if (!Array.isArray(actors)) bypass.push("its bypass list couldn't be read");
      // Only a deploy key never merges as this account; a role, team, app or organization admin might.
      else if (actors.some(one => object(one)["actor_type"] !== "DeployKey")) bypass.push("its bypass list names a role, team, app or organization admin");
      judge(where, params["strict_required_status_checks_policy"] === true, checks, actionsChecks(params["required_status_checks"], "integration_id"), bypass);
    }
  }
  if (held.length > 0) {
    const required = new Set(held.flat());
    return { effective: true, missing: [], notYetRequired: PROTECTION_REPORT_ONLY_CHECKS.filter(name => !required.has(name)) };
  }
  if (unread.length > 0) throw new ProtectionUnreadable(unread);
  if (missing.length === 0) missing.push("main has no branch protection or ruleset requiring status checks");
  return { effective: false, missing, notYetRequired: [] };
}

/** Main's protection couldn't be read from GitHub (after the network retries): not "doesn't hold", and never "holds". */
export class ProtectionUnreadable extends Error {
  constructor(readonly unread: readonly string[]) { super(`couldn't read GitHub's branch protection for main: ${unread.join("; ")}`); }
}

/** Whether main's protection holds, as a yes/no (release-auto.ts sealAutoGreen): null when it can't be read. */
export async function readUpToDateRequired(run: Exec, gh: string, repo: string, branch = "main"): Promise<boolean | null> {
  let protection: MainProtection | null;
  try { protection = await readMainProtection(run, gh, repo, branch); } catch (error) { if (error instanceof ProtectionUnreadable) return null; throw error; }
  return protection === null ? null : protection.effective;
}

/** Whether a workflow run is the push of exactly this release tag (its workflow file is the tagged commit's own, on main). */
function tagTriggered(run: Record<string, unknown>, tag: string | undefined): boolean {
  return tag !== undefined && run["event"] === "push" && run["branch"] === tag;
}

/** Whether a workflow run was triggered on main: a push to main, or a pull request whose every base is main. */
function mainTriggered(run: Record<string, unknown>): boolean {
  const bases = Array.isArray(run["bases"]) ? run["bases"] : [];
  if (run["event"] === "push") return run["branch"] === "main";
  if (run["event"] === "pull_request") return bases.length > 0 && bases.every(base => base === "main");
  return false;
}
