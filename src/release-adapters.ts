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
// Loaded on first use, like the store: a static import prints Node's SQLite warning before the CLI can quiet it.
const sqlite = (): typeof import("node:sqlite") => createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import type { CheckRun, DeployStop, GateState, HomebrewState, Installed, PullRequest, ReleaseAdapters } from "./release.js";
import { activeUpdateWork } from "./desktop-update-gate.js";
import { BEFORE_SWAP, gateOwner } from "./release-gate.js";
import { findCliLinks, switchCliLinks } from "./release-links.js";
import {
  databasePath, finishReleaseOperation, requireFreshReleaseApproval, openStore, releaseAuthorityOfTask, releaseCarries, releaseOperations, renewReleaseLease, reserveRelease, runReleaseOperation,
  Store, releaseIssuerGone, takeReleaseLease, type Database,
} from "./store.js";
import { acquireDeploymentLock } from "./deploy-lock.js";
import { liveReleaseOf } from "./scope.js";
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

const must = async (run: Promise<{ code: number; stdout: string; stderr: string }>, what: string): Promise<string> => {
  const result = await run;
  if (result.code !== 0) throw new Error(`${what} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
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
  // Never a PATH lookup or the checkout's Git config: gh by its absolute path, from a neutral folder, naming the repo.
  const gh = (...args: string[]) => run(tools.gh, args, { cwd: "/", env: gitEnv });
  const ghJson = async (what: string, ...args: string[]) => JSON.parse(await must(gh(...args), what)) as unknown;
  const toolroll = async (...args: string[]): Promise<Json> => {
    const result = await run("toolroll", [...args, "--json"], { env: cleanEnv(), timeoutMs: 120_000 });
    try { return object(JSON.parse(result.stdout)); } catch { throw new Error(`toolroll ${args[0]} ${args[1] ?? ""} answered no JSON (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`); }
  };
  const refused = (answer: Json) => `${String(answer["message"] ?? answer["reason"] ?? "refused")}`;
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
    const stop = (why: string) => new Error(`Toolroll won't run Git in ${repo.checkout} for a release: ${why}. Remove it from the project's Git config, then rerun.`);
    if (options.releaseRepo === undefined && checkoutIncludes(repo.checkout)) throw stop("its Git config includes another file, or couldn't be read as a plain file");
    const listing = await run(tools.git, [`--git-dir=${repo.gitDir}`, "--no-optional-locks", "config", "--list", "--no-includes", "--show-scope", "-z"], { cwd: "/", env: gitEnv });
    if (listing.code !== 0) throw stop("its Git config couldn't be read");
    const setting = releaseConfigProblem(listing.stdout);
    if (setting !== null) throw stop(`its Git config sets ${setting}, which a release doesn't run with (it could run a command, or change where Git connects or what it sends)`);
    return run(tools.git, [...releaseGitArgs(repo, tools), ...args], { cwd: repo.checkout, env: gitEnv });
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
    try { return deploymentGate(new Store(db), { runId, evidenceRoot: join(dirname(database), "evidence"), now: (options.now ?? (() => new Date()))() }); }
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

  const release = storeReleaseAdapter(() => openStore(database), store => store.close(), options.now ?? (() => new Date()));

  return {
    ...(existsSync(database) ? { release } : {}),
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? sleep,
    say: options.say ?? (line => process.stdout.write(`${line}\n`)),
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
      async mainHead() { return (await must(git("rev-parse", "refs/remotes/origin/main"), "git rev-parse origin/main")).trim(); },
      async contains(sha, ancestor) { return (await git("merge-base", "--is-ancestor", ancestor, sha)).code === 0; },
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
      async checks(repo, sha) {
        const out = await must(gh("api", "--paginate", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", ".check_runs[] | {id, name, status, conclusion, app: .app.slug}"), "gh api check-runs");
        const runs = out.split("\n").filter(Boolean).map(line => object(JSON.parse(line)));
        // Oldest first, so a rerun's attempt is the last one listed for its name.
        return runs.sort((a, b) => Number(a["id"]) - Number(b["id"])).map((one): CheckRun => ({ name: String(one["name"]), status: String(one["status"]), conclusion: textOr(one["conclusion"]), app: textOr(one["app"]) }));
      },
      async merge(repo, pr, head, message) {
        // The squash commit's message lists every commit that landed after the approval (release-once.md).
        const merged = object(await ghJson("gh api pulls merge", "api", "-X", "PUT", `repos/${repo}/pulls/${pr}/merge`, "-f", "merge_method=squash", "-f", `sha=${head}`,
          ...(message === undefined ? [] : ["-f", `commit_message=${message}`])));
        if (typeof merged["sha"] !== "string") throw new Error(`GitHub did not merge #${pr}: ${String(merged["message"] ?? "no merge commit")}`);
        return merged["sha"];
      },
      async tag(repo, tag) {
        const result = await gh("api", `repos/${repo}/git/ref/tags/${tag}`);
        if (result.code !== 0) {
          if (/Not Found|HTTP 404/.test(result.stderr + result.stdout)) return null;
          throw new Error(`gh api git/ref/tags/${tag} failed: ${result.stderr.trim()}`);
        }
        const target = object(object(JSON.parse(result.stdout))["object"]);
        if (target["type"] !== "tag") return String(target["sha"]);
        // An annotated tag: the commit it names.
        return String(object(object(await ghJson("gh api git/tags", "api", `repos/${repo}/git/tags/${String(target["sha"])}`))["object"])["sha"]);
      },
      async createTag(repo, tag, sha) {
        await must(gh("api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/tags/${tag}`, "-f", `sha=${sha}`), `creating ${tag}`);
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
        const open = (await ghJson("gh pr list", "pr", "list", "--repo", tap, "--head", brewBranch(version), "--state", "open", "--json", "number,headRefOid")) as Json[];
        const pr = open[0];
        return pr === undefined ? { kind: "missing" } : { kind: "proposed", pr: Number(pr["number"]), head: String(pr["headRefOid"]) };
      },
      async propose(version) {
        const tarball = `https://registry.npmjs.org/toolroll/-/toolroll-${version}.tgz`;
        const response = await get(tarball, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`downloading ${tarball} answered ${response.status}`);
        const sha256 = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
        const base = await defaultBranch();
        const current = await formulaAt(base);
        const next = bumpFormula(current.text, tarball, sha256);
        const branch = brewBranch(version);
        const baseSha = String(object(object(await ghJson("gh api git/ref", "api", `repos/${tap}/git/ref/heads/${base}`))["object"])["sha"]);
        // A branch left by an earlier attempt is reused.
        const made = await gh("api", "-X", "POST", `repos/${tap}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${baseSha}`);
        if (made.code !== 0 && !/Reference already exists/.test(made.stderr + made.stdout)) throw new Error(`creating ${tap} ${branch}: ${made.stderr.trim()}`);
        const onBranch = await formulaAt(branch);
        if (onBranch.text !== next) {
          await must(gh("api", "-X", "PUT", `repos/${tap}/contents/${formula}`, "-f", `message=toolroll ${version}`, "-f", `branch=${branch}`, "-f", `sha=${onBranch.sha}`,
            "-f", `content=${Buffer.from(next).toString("base64")}`), `updating ${formula}`);
        }
        await must(gh("pr", "create", "--repo", tap, "--head", branch, "--base", base, "--title", `toolroll ${version}`, "--body", `Bumps the formula to toolroll ${version} (${tarball}, sha256 ${sha256}).`), "gh pr create");
        const opened = (await ghJson("gh pr view", "pr", "view", branch, "--repo", tap, "--json", "number,headRefOid")) as Json;
        return { pr: Number(opened["number"]), head: String(opened["headRefOid"]) };
      },
      async merge(pr, head) {
        const merged = object(await ghJson(`merging ${tap} #${pr}`, "api", "-X", "PUT", `repos/${tap}/pulls/${pr}/merge`, "-f", "merge_method=squash", "-f", `sha=${head}`));
        if (merged["merged"] !== true || typeof merged["sha"] !== "string") throw new Error(`GitHub did not merge ${tap} #${pr}: ${String(merged["message"] ?? "no merge commit")}`);
      },
    },
  };

  async function defaultBranch(): Promise<string> {
    return (await must(gh("api", `repos/${tap}`, "--jq", ".default_branch"), `gh api repos/${tap}`)).trim();
  }
  async function formulaAt(ref: string): Promise<{ text: string; sha: string }> {
    const file = object(await ghJson(`reading ${formula}`, "api", `repos/${tap}/contents/${formula}?ref=${encodeURIComponent(ref)}`));
    return { text: Buffer.from(String(file["content"] ?? ""), "base64").toString("utf8"), sha: String(file["sha"]) };
  }
}

const brewBranch = (version: string) => `toolroll-${version}`;

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
export function storeReleaseAdapter(open: () => Store, done: (store: Store) => void, now: () => Date, runner?: BuildRunner): NonNullable<ReleaseAdapters["release"]> {
  const withStore = <T>(body: (store: Store) => T): T => { const store = open(); try { return body(store); } finally { done(store); } };
  return {
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
