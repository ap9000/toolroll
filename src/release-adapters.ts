/**
 * The world `toolroll release` acts on (release.ts): the gate checkout through git, GitHub through the signed-in `gh`,
 * the npm registry over HTTPS, the installed Toolroll through its own CLI (`--json`) and launchd definitions, and the
 * Homebrew tap through `gh`. Each call is bounded; none asks for or stores a credential — `gh`, npm and Toolroll use
 * the sign-ins this machine already has.
 */

import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CheckRun, DeployStop, GateState, HomebrewState, Installed, PullRequest, ReleaseAdapters } from "./release.js";
import { BEFORE_SWAP, gateOwner } from "./release-gate.js";
import { findCliLinks, switchCliLinks } from "./release-links.js";
import { databasePath, type Database } from "./store.js";

export type Exec = (command: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) =>
  Promise<{ code: number; stdout: string; stderr: string }>;

/** A child process, its output kept whole; a missing program or a time limit is exit 127 or 124, never a throw. */
export const exec: Exec = (command, args, options = {}) => new Promise(done => {
  execFile(command, [...args], { cwd: options.cwd, env: options.env ?? process.env, timeout: options.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
    (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      const code = failure === null ? 0 : failure.code === "ENOENT" ? 127 : failure.killed === true ? 124 : typeof failure.code === "number" ? failure.code : 1;
      done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
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
  return {
    exists: true,
    candidate: textOr(scope["candidate"]),
    scopeDigest: textOr(scope["digest"]),
    approval: approvedAt === null || approvedBy === null || approvedDigest === null ? null : {
      by: approvedBy, at: approvedAt, digest: approvedDigest, basis: textOr(scope["approvalBasis"]),
      role: textOr(account?.["role"]), active: account?.["revokedAt"] === null,
    },
    result: resultRun === null || textOr(result["digest"]) === null ? null : {
      run: resultRun, head: textOr(result["head"]), receipt: String(result["digest"]), worktree: textOr(worktree),
      level: textOr(checks["level"]),
      check: textOr(checks["running"]) !== null ? "running"
        : checks["status"] === "passed" && checks["level"] !== "full" ? "not-full" : String(checks["status"] ?? "not-run"),
    },
    failed,
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

export type AdapterOptions = {
  checkout: string;
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

export function releaseAdapters(options: AdapterOptions): ReleaseAdapters {
  const run = options.run ?? exec;
  const get = options.fetch ?? fetch;
  const { checkout } = options;
  const tap = options.tap ?? "ap9000/homebrew-toolroll";
  const formula = options.formula ?? "Formula/toolroll.rb";
  const git = (...args: string[]) => run("git", ["-C", checkout, ...args]);
  const gh = (...args: string[]) => run("gh", args);
  const ghJson = async (what: string, ...args: string[]) => JSON.parse(await must(gh(...args), what)) as unknown;
  const toolroll = async (...args: string[]): Promise<Json> => {
    const result = await run("toolroll", [...args, "--json"], { env: cleanEnv(), timeoutMs: 120_000 });
    try { return object(JSON.parse(result.stdout)); } catch { throw new Error(`toolroll ${args[0]} ${args[1] ?? ""} answered no JSON (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`); }
  };
  const refused = (answer: Json) => `${String(answer["message"] ?? answer["reason"] ?? "refused")}`;
  const database = options.database ?? databasePath(process.env, homedir());
  const liveOwner = () => {
    if (!existsSync(database)) return null;
    const db = new DatabaseSync(database, { readOnly: true }) as unknown as Database;
    try { return gateOwner(db); } finally { db.close(); }
  };
  const tail = (result: { code: number; stdout: string; stderr: string }) => (result.stderr || result.stdout).trim().split("\n").slice(-4).join(" ") || `exit ${result.code}`;
  /** A deployment that stopped: in words, with the pause it left when that pause is before the swap. */
  const stopped = (stage: string, message: string): DeployStop => {
    const gate = stageGate(stage, liveOwner);
    return gate === null ? { ok: false, message } : { ok: false, message, gate };
  };
  const deployScript = (worktree: string, stage: string, runId: number, extra: string[]) => run(process.execPath, ["scripts/deploy-browser.mjs", "--run", String(runId), "--stage", stage, ...extra], {
    cwd: worktree, env: cleanEnv({ TMPDIR: resolved(process.env["TMPDIR"] ?? "/tmp") }), timeoutMs: (options.deployMinutes ?? 30) * 60_000,
  });

  return {
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? (ms => new Promise(done => setTimeout(done, ms))),
    say: options.say ?? (line => process.stdout.write(`${line}\n`)),
    repo: {
      async github() {
        const slug = githubSlug(await must(git("remote", "get-url", "origin"), "git remote get-url origin"));
        if (slug === null) throw new Error(`${checkout}'s origin is not a GitHub repository`);
        return slug;
      },
      async sync(branch) {
        await must(git("fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"), "git fetch origin main");
        // A merged branch may be gone from GitHub; its commit is already here.
        await git("fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
        const current = (await git("symbolic-ref", "--quiet", "--short", "HEAD")).stdout.trim();
        if (current === "main") { await must(git("merge", "--ff-only", "--quiet", "origin/main"), "git merge --ff-only origin/main"); return; }
        const local = (await git("rev-parse", "--verify", "--quiet", "refs/heads/main")).stdout.trim();
        if (local === "" || (await git("merge-base", "--is-ancestor", local, "origin/main")).code === 0) {
          await must(git("update-ref", "refs/heads/main", "origin/main", ...(local === "" ? [] : [local])), "git update-ref main");
        } else throw new Error(`${checkout}'s local main has commits origin/main doesn't; the gate diffs from it, so fix it first`);
      },
      async remoteHead(branch) {
        const out = await must(git("ls-remote", "origin", `refs/heads/${branch}`), "git ls-remote");
        return out.trim().split(/\s+/)[0] || null;
      },
      async deleteBranch(branch, head) {
        const ref = `refs/heads/${branch}`;
        const current = (await must(git("ls-remote", "origin", ref), "git ls-remote")).trim().split(/\s+/)[0] || null;
        if (current === null) return;
        if (current !== head) throw new Error(`${branch} moved after merging; its new head was not deleted.`);
        await must(git("push", `--force-with-lease=${ref}:${head}`, "origin", `:${ref}`), `deleting merged branch ${branch}`);
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
        const scoped = await toolroll("task", "scope", input.taskId, "--candidate", input.candidate, "--goal", input.goal, "--acceptance", input.acceptance);
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
        const answer = await toolroll("status");
        const running = object(answer["running"]);
        if (answer["ok"] !== true || typeof running["count"] !== "number") throw new Error(`toolroll status: ${refused(answer)}`);
        return { running: running["count"], tasks: (Array.isArray(running["tasks"]) ? running["tasks"] : []).map(one => String(object(one)["task"])) };
      },
      async deploy({ run: runId, worktree, stage }) {
        // The candidate's own deployment, from its own checkout: drain, backup, rehearsal, swap, health. Its last JSON
        // line names the runtime it installed; the CLI names are moved to it by the release's link step.
        const result = await deployScript(worktree, stage, runId, ["--yes"]);
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
        const result = await deployScript(worktree, stage, runId, ["--phase", "recover"]);
        if (result.code === 0) return { ok: true };
        // Killed while preparing, before it paused anything: nothing to undo (its journal is kept).
        const journal = (() => { try { return object(JSON.parse(readFileSync(join(stage, "deployment.json"), "utf8"))); } catch { return {}; } })();
        if (journal["phase"] === "preparing" && liveOwner() !== journal["id"]) return { ok: true };
        return stopped(stage, `${tail(result)} (the deployment journal is at ${String(journal["phase"] ?? "an unreadable phase")}; ${join(stage, "deployment.json")})`);
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
        const out = await must(gh("api", "--paginate", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", ".check_runs[] | {id, name, status, conclusion}"), "gh api check-runs");
        const runs = out.split("\n").filter(Boolean).map(line => object(JSON.parse(line)));
        // Oldest first, so a rerun's attempt is the last one listed for its name.
        return runs.sort((a, b) => Number(a["id"]) - Number(b["id"])).map((one): CheckRun => ({ name: String(one["name"]), status: String(one["status"]), conclusion: textOr(one["conclusion"]) }));
      },
      async merge(repo, pr, head) {
        const merged = object(await ghJson("gh api pulls merge", "api", "-X", "PUT", `repos/${repo}/pulls/${pr}/merge`, "-f", "merge_method=squash", "-f", `sha=${head}`));
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

/** The formula with its first `url` and `sha256` replaced; anything else is left exactly as it was. */
export function bumpFormula(text: string, url: string, sha256: string): string {
  if (!/^\s*url "[^"]*"/m.test(text) || !/^\s*sha256 "[0-9a-f]{64}"/m.test(text)) throw new Error("the formula has no url and sha256 lines to update");
  return text.replace(/^(\s*url ")[^"]*(")/m, `$1${url}$2`).replace(/^(\s*sha256 ")[0-9a-f]{64}(")/m, `$1${sha256}$2`);
}
