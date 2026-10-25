/**
 * One approval per release (docs/plans/release-once.md, part 1): which later commits carry a person's release approval,
 * and the proof that one does.
 *
 * A later commit carries only when every change since the approved commit is tests, docs or the changelog (CARRY_RULES,
 * each commit against its parent and the whole range), within the limits, under the stricter of the sealed and the
 * current policy — AND the production build is byte-for-byte the approved one. The proof runs in this order and nothing
 * from the candidate runs until the read-only preflight passed:
 *
 *   1. an idempotent retry first (a carry already written for this commit, still standing, is returned as it is);
 *   2. the read-only preflight over objects hashed here (commit-extract.ts) and the live authority (scope.ts
 *      liveReleaseOf) — ancestry through the current tip, no merges, the rules, the limits, the grant and access;
 *   3. both sides built inside the fence with no network, installed from the lockfile with no scripts, and their output
 *      digested as untrusted (process group gone, lstat, O_NOFOLLOW, regular files only, contained paths);
 *   4. one BEGIN IMMEDIATE transaction that proves every mutable fact again and writes the carry (store.ts
 *      carryReleaseApproval).
 *
 * The limits keep a carried change small enough to review; they are not a security boundary. Authority decisions here
 * read only Toolroll's records and verified objects. (Coverage, in release-recheck.ts, trusts test code by Alex's
 * explicit decision; nothing here does.)
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { checkLaunchRoot, fenceFor, linuxFenceAvailable, macosFenceAvailable, runFolders, type NetworkFence } from "./agent-fence.js";
import { touchesProtected } from "./approval-policy.js";
import { extractCommit, readVerifiedCommit, verifiedFirstParentWalk, verifiedTreeDiff, type TreeChange, type VerifiedCommit } from "./commit-extract.js";
import { projectGitDir } from "./check-report.js";
import { CARRY_RULES_VERSION, readReleasePolicy, releasePolicyDigest, type ReleasePolicy, type ReleaseTerms } from "./contracts/release-terms.js";
import { run, type ExecResult } from "./exec.js";
import { proxyEnv, startEgressProxy } from "./egress.js";
import { liveReleaseOf } from "./scope.js";
import {
  carryReleaseApproval, releaseAuthority, releaseCarryTo, sealAnchorArtifact,
  type ReleaseAuthority, type ReleaseCarry, type Store,
} from "./store.js";

// ------------------------------------------------------------------ the rules

/** The journey scripts: tests, by Alex's decision (they carry). */
export const JOURNEY_SCRIPTS: readonly string[] = Object.freeze(["scripts/app-e2e.mjs", "scripts/flows-e2e.mjs"]);

/** What carries (version 1). Everything else asks again — including every other `test/**` or `scripts/**` file (the
 * harness, what it imports, helpers and fixtures), so no harness file can slip in under a class. */
export const CARRY_RULES = Object.freeze({
  version: CARRY_RULES_VERSION,
  classes: Object.freeze([
    { name: "unit tests", matches: (path: string) => /^src\/.+\.test\.ts$/.test(path) },
    { name: "journey scripts", matches: (path: string) => JOURNEY_SCRIPTS.includes(path) },
    { name: "changelog", matches: (path: string) => path === "CHANGELOG.md" },
    // An allowlist (security review): Markdown under docs/, and the root README. Never any other .md anywhere.
    { name: "docs", matches: (path: string) => (path.startsWith("docs/") && path.endsWith(".md")) || path === "README.md" },
  ]),
  /** Never carry, even when a class above matches them. */
  never: Object.freeze([
    // Agent instructions and policy, anywhere, whatever the case.
    { why: "it's an agent or security policy file", matches: (path: string) => /(^|\/)(AGENTS|CLAUDE|GEMINI|SECURITY)\.md$/i.test(path) },
    // Agent and CI configuration folders, anywhere: they steer agents and checks.
    { why: "it configures agents or CI", matches: (path: string) => /(^|\/)\.(claude|codex|gemini|cursor|github)(\/|$)/i.test(path) },
    // Docs agents are told to follow (AGENTS.md names the testing guide; plans are the input documents tasks build
    // from). Nothing under docs/ is read by the product itself: its guides are compiled into src/guides.ts.
    { why: "agents follow it as instructions", matches: (path: string) => /^docs\/plans\//.test(path) || /^docs\/testing\.md$/i.test(path) },
    { why: "it's part of the test harness, a helper or a fixture", matches: (path: string) => path.startsWith("test/") },
    { why: "it's part of the test harness", matches: (path: string) => path.startsWith("scripts/") && !JOURNEY_SCRIPTS.includes(path) },
    { why: "it's part of the test harness", matches: (path: string) => /(^|\/)vitest\.config\.[cm]?[jt]s$/.test(path) },
  ]),
});

/** The limits (Alex, 2026-10-25): 400 changed lines and 20 files after the approval, 800 lines of churn. */
export const CARRY_LIMITS = Object.freeze({ lines: 400, files: 20, churn: 800 });

/** "Ask for every release commit": a project setting, newest choice wins (a ledger row each); off by default. */
export const ASK_EVERY_COMMIT_ACTION = "release carrying changed";
export function asksEveryReleaseCommit(store: Store, repo: string): boolean {
  const row = store.handle.prepare("SELECT outcome FROM action_ledger WHERE repo = ? AND action = ? ORDER BY id DESC LIMIT 1").get(repo, ASK_EVERY_COMMIT_ACTION);
  return row !== undefined && row["outcome"] === "ask";
}
export function setAskEveryReleaseCommit(store: Store, repo: string, ask: boolean, by: string, now: Date): void {
  store.recordAction({ at: now.toISOString(), actor: by, repo, taskId: null, runId: null, action: ASK_EVERY_COMMIT_ACTION, outcome: ask ? "ask" : "carry", source: "request",
    detail: ask ? "Ask for every release commit" : "Later test-only commits ship under the release approval" });
}

/** The effective policy now: the runtime rules, the project's protected paths and the limits. */
export function effectivePolicy(store: Store, repo: string, options: { noCarry?: boolean } = {}): ReleasePolicy {
  const rules = store.approvalRules(repo);
  return {
    version: 1, rules: CARRY_RULES_VERSION, carry: options.noCarry !== true && !asksEveryReleaseCommit(store, repo),
    protectProject: rules.protectProject, protectedPaths: [...new Set(rules.protectedPaths)].sort(), limits: { ...CARRY_LIMITS },
  };
}

/** The stricter of two policies: what either protects asks again, the lower limit wins, either one's "ask" asks. Null
 * when either is a policy this runtime doesn't know (then nothing carries). */
export function stricterOf(a: ReleasePolicy | null, b: ReleasePolicy | null): ReleasePolicy | null {
  if (a === null || b === null || !readReleasePolicy(a).ok || !readReleasePolicy(b).ok) return null;
  return {
    version: 1, rules: CARRY_RULES_VERSION, carry: a.carry && b.carry, protectProject: a.protectProject || b.protectProject,
    protectedPaths: [...new Set([...a.protectedPaths, ...b.protectedPaths])].sort(),
    limits: { lines: Math.min(a.limits.lines, b.limits.lines), files: Math.min(a.limits.files, b.limits.files), churn: Math.min(a.limits.churn, b.limits.churn) },
  };
}

/** Why one changed path doesn't carry, in words, or null when it does. */
export function changeRefusal(change: TreeChange, policy: ReleasePolicy): string | null {
  const path = change.path;
  if (change.kind === "deleted") return `${path} was deleted or renamed`;
  const modes = [change.before?.mode, change.after?.mode].filter((one): one is string => one !== undefined);
  if (modes.includes("120000")) return `${path} is a symlink`;
  if (modes.includes("160000")) return `${path} is a submodule`;
  if (change.before !== null && change.after !== null && change.before.mode !== change.after.mode) return `${path} changed its file mode`;
  if (change.binary) return `${path} is a binary file`;
  const never = CARRY_RULES.never.find(one => one.matches(path));
  if (never !== undefined) return `${path} doesn't carry: ${never.why}`;
  if (policy.protectProject || policy.protectedPaths.some(glob => touchesProtected(path, glob))) return `${path} is protected in this project`;
  if (!CARRY_RULES.classes.some(one => one.matches(path))) return `${path} isn't a test, a doc or the changelog`;
  return null;
}

// ------------------------------------------------------------------ release terms

/**
 * A release scope's terms, from the plane's own records: the project's repository, the approved commit and its
 * verified tree, the effective policy, the live release check grant and the check access (only the fence), and the
 * expiry. Null with why when the release can't carry at all (it then asks for every commit, as before).
 */
export function releaseTermsFor(store: Store, input: { repo: string; version: string; branch: string; pr: number; candidate: string; now: Date; noCarry?: boolean }):
  { ok: true; terms: ReleaseTerms } | { ok: false; why: string } {
  const gitDir = projectGitDir(input.repo);
  if (gitDir === null) return { ok: false, why: "the project's Git directory can't be read" };
  const commit = readVerifiedCommit(gitDir, input.candidate);
  if (!commit.ok) return { ok: false, why: commit.message };
  const grant = store.liveVerifyCommand(input.repo);
  if (grant === null) return { ok: false, why: "the project has no approved release check" };
  if (store.projectCheckAccess(input.repo) !== "sandboxed") return { ok: false, why: "the project's checks run outside the sandbox, so later commits always ask again" };
  return { ok: true, terms: {
    version: 1, repo: input.repo, packageVersion: input.version, branch: input.branch, pr: input.pr, base: "main",
    approvedSha: input.candidate, approvedTree: commit.value.tree, policy: effectivePolicy(store, input.repo, { noCarry: input.noCarry ?? false }),
    grant: { id: grant.id, digest: grant.digest }, access: "sandboxed",
    expiresAt: new Date(input.now.getTime() + 3 * 24 * 60 * 60_000).toISOString(),
  } };
}

// ------------------------------------------------------------------ the preflight

/** One carried commit, as the summary and the merge message list it. */
export type LandedCommit = { sha: string; files: { path: string; added: number; deleted: number }[] };

export type CarryRefusal = { ok: false; reason: "authority" | "ancestry" | "shape" | "rules" | "limits" | "build" | "artifact" | "stale"; message: string; path?: string };

export type PreflightPlan = {
  authority: ReleaseAuthority;
  to: string;
  toTree: string;
  commits: LandedCommit[];
  changedLines: number;
  files: number;
  churn: number;
  policy: ReleasePolicy;
  currentPolicyDigest: string;
};

/**
 * Step 2, read-only: nothing from the candidate is installed, built or run here. Objects come from the project's own
 * Git directory as Toolroll records it, hashed here; the authority is read live.
 */
export function preflightCarry(store: Store, input: { authority: number; to: string; epoch?: number | null; now: Date }): { ok: true; plan: PreflightPlan } | CarryRefusal {
  const refuse = (reason: CarryRefusal["reason"], message: string, path?: string): CarryRefusal => ({ ok: false, reason, message, ...(path === undefined ? {} : { path }) });
  const a = releaseAuthority(store, input.authority);
  if (a === null) return refuse("authority", `No release ${input.authority}.`);
  const live = liveReleaseOf(store, a.tipTask, "dispatch", input.now);
  if (!live.applies || !live.ok) return refuse("authority", `The release approval doesn't stand: ${live.applies && !live.ok ? live.why : "its current commit isn't part of it"}.`);
  if (input.epoch !== undefined && input.epoch !== null && (input.epoch !== a.leaseEpoch || a.leaseExpires === null || a.leaseExpires <= input.now.toISOString())) {
    return refuse("authority", "This coordinator no longer holds the release's lease.");
  }
  const policy = stricterOf(a.policy, effectivePolicy(store, a.repo));
  if (policy === null) return refuse("authority", "This Toolroll doesn't know the release's carry rules; update Toolroll first.");
  if (!policy.carry) return refuse("rules", "This project asks for every release commit.");
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(input.to)) return refuse("ancestry", `${input.to} isn't a full commit id.`);
  if (input.to === a.tipSha) return refuse("ancestry", `${input.to.slice(0, 7)} is already the release's commit.`);
  const gitDir = projectGitDir(a.repo);
  if (gitDir === null) return refuse("ancestry", "The project's Git directory can't be read.");
  const walk = verifiedFirstParentWalk(gitDir, input.to, a.approvedSha, 200);
  if (!walk.ok) return refuse("ancestry", `${input.to.slice(0, 7)} doesn't follow the approved commit: ${walk.message}`);
  const chain = walk.value;
  if (a.tipSha !== a.approvedSha && !chain.some(one => one.id === a.tipSha)) return refuse("ancestry", `${input.to.slice(0, 7)} doesn't follow the release's current commit ${a.tipSha.slice(0, 7)} (was the branch rewritten?).`);
  const merge = chain.find(one => one.parents.length !== 1);
  if (merge !== undefined) return refuse("shape", `${merge.id.slice(0, 7)} is a merge commit; a carried change is plain commits.`);
  // Each commit against its parent, oldest first.
  const ordered = [...chain].reverse();
  const treeOf = new Map<string, string>([[a.approvedSha, a.approvedTree]]);
  for (const commit of ordered) treeOf.set(commit.id, commit.tree);
  const commits: LandedCommit[] = [];
  let churn = 0;
  for (const commit of ordered) {
    const parentTree = treeOf.get(commit.parents[0]!);
    if (parentTree === undefined) return refuse("ancestry", `${commit.id.slice(0, 7)}'s parent couldn't be read.`);
    const diff = verifiedTreeDiff(gitDir, parentTree, commit.tree);
    if (!diff.ok) return refuse("shape", `${commit.id.slice(0, 7)} couldn't be read: ${diff.message}`);
    for (const change of diff.value) {
      const why = changeRefusal(change, policy);
      if (why !== null) return refuse("rules", `${commit.id.slice(0, 7)}: ${why}.`, change.path);
    }
    churn += diff.value.reduce((n, one) => n + one.added + one.deleted, 0);
    commits.push({ sha: commit.id, files: diff.value.map(one => ({ path: one.path, added: one.added, deleted: one.deleted })) });
  }
  const whole = verifiedTreeDiff(gitDir, a.approvedTree, chain[0]!.tree);
  if (!whole.ok) return refuse("shape", `The change since the approval couldn't be read: ${whole.message}`);
  for (const change of whole.value) {
    const why = changeRefusal(change, policy);
    if (why !== null) return refuse("rules", `Since the approval: ${why}.`, change.path);
  }
  const changedLines = whole.value.reduce((n, one) => n + one.added + one.deleted, 0);
  if (changedLines > policy.limits.lines) return refuse("limits", `${changedLines} lines changed since the approval; at most ${policy.limits.lines} carry.`);
  if (whole.value.length > policy.limits.files) return refuse("limits", `${whole.value.length} files changed since the approval; at most ${policy.limits.files} carry.`);
  if (churn > policy.limits.churn) return refuse("limits", `${churn} lines of churn across the carried commits; at most ${policy.limits.churn} carry.`);
  return { ok: true, plan: { authority: a, to: input.to, toTree: chain[0]!.tree, commits, changedLines, files: whole.value.length, churn, policy,
    currentPolicyDigest: releasePolicyDigest(effectivePolicy(store, a.repo)) } };
}

// ------------------------------------------------------------------ the build, fenced, its output untrusted

/** How a build step runs: the fenced default, or a test's stand-in. */
export type BuildRunner = (file: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; writable: readonly string[]; timeoutMs: number }) => Promise<ExecResult>;

/** The default build runner: the OS fence, writes only where named, and no network — its only way out is a proxy of its
 * own that allows no host. No fence on this machine, no build. */
export function fencedBuildRunner(store: Store): BuildRunner {
  return async (file, args, options) => {
    if (!macosFenceAvailable() && !linuxFenceAvailable()) {
      return { code: 1, stdout: "", stderr: "This machine can't confine the build (no macOS sandbox, no working bubblewrap), so it didn't run.\n", timedOut: false, notFound: false };
    }
    const egress = await startEgressProxy({ hosts: [] });
    try {
      const network: NetworkFence = { mode: "allowlist", proxyPort: egress.port, brokerPorts: [], loopback: "proxy-only", socketRoots: [...options.writable], token: egress.secret };
      const launch = fenceFor("check", {
        databaseFile: store.databaseFile(), worktree: options.cwd, boundary: null, binding: null, runFolders: runFolders(null), poolRoots: [],
        writes: { writes: { subpaths: [...options.writable], prefixes: [] }, readOnly: [] }, network,
      });
      return await run(file, args, { cwd: options.cwd, env: { ...options.env, ...proxyEnv(egress, "proxy-only") }, timeoutMs: options.timeoutMs, processGroup: true,
        fence: launch.fence, fenceGrants: launch.fenceGrants, confinement: "required" });
    } finally { await egress.close(); }
  };
}

/** Pids whose working folder is inside `root` (lsof on macOS, /proc on Linux). */
function processesInside(root: string): number[] {
  const inside = (cwd: string) => cwd === root || cwd.startsWith(`${root}/`);
  if (process.platform === "linux") {
    const found: number[] = [];
    for (const name of readdirSync("/proc").filter(one => /^\d+$/.test(one))) {
      try { if (inside(realpathSync(`/proc/${name}/cwd`))) found.push(Number(name)); } catch { /* gone */ }
    }
    return found;
  }
  let text = "";
  try { text = execFileSync("lsof", ["-nP", "-d", "cwd", "-Fpn"], { encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch (error) { text = String((error as { stdout?: unknown }).stdout ?? ""); }
  const found: number[] = [];
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0 && pid !== process.pid && inside(line.slice(1))) found.push(pid);
  }
  return [...new Set(found)];
}

/** Files left out of the artifact digest and listed as doc changes instead. */
export const ARTIFACT_EXCLUDED: readonly string[] = Object.freeze(["CHANGELOG.md", "README.md"]);

/**
 * The digest of one built tree's production artifacts, read as untrusted: every entry walked with lstat, opened with
 * O_NOFOLLOW and checked again on the descriptor; only regular files inside `root` count; a symlink, a special file or a
 * path that escapes refuses. Each entry records path, mode and sha256.
 */
export function digestTree(root: string, paths: readonly string[]): { ok: true; digest: string; entries: number } | { ok: false; message: string } {
  const realRoot = realpathSync(root);
  const entries: [string, number, string][] = [];
  for (const path of [...new Set(paths)].sort()) {
    if (path === "" || path.startsWith("/") || path.split("/").some(part => part === "" || part === "." || part === "..")) return { ok: false, message: `${path} isn't a contained path.` };
    const full = join(realRoot, ...path.split("/"));
    let stat;
    try { stat = lstatSync(full); } catch { return { ok: false, message: `${path} is missing.` }; }
    if (stat.isSymbolicLink()) return { ok: false, message: `${path} is a symlink; the build's output has to be plain files.` };
    if (!stat.isFile()) return { ok: false, message: `${path} isn't a regular file.` };
    // Every folder on the way is a real folder inside the root.
    if (!realpathSync(join(full, "..")).startsWith(realRoot)) return { ok: false, message: `${path} escapes the build folder.` };
    let fd: number;
    try { fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return { ok: false, message: `${path} couldn't be opened as a plain file.` }; }
    try {
      const on = fstatSync(fd);
      if (!on.isFile() || on.ino !== stat.ino || on.dev !== stat.dev) return { ok: false, message: `${path} changed while it was read.` };
      const bytes = readFileSync(fd);
      entries.push([path, on.mode & 0o777, createHash("sha256").update(bytes).digest("hex")]);
    } finally { closeSync(fd); }
  }
  return { ok: true, digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries: entries.length };
}

/** Every regular entry under a folder (relative paths), walked with lstat; anything else is listed as is, so the
 * digest refuses it. */
function walk(root: string, prefix: string): string[] {
  const out: string[] = [];
  let names: string[];
  try { names = readdirSync(join(root, prefix)); } catch { return out; }
  for (const name of names.sort()) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) out.push(...walk(root, path));
    else out.push(path);
  }
  return out;
}

/**
 * Step 3 for one commit: extract it (verified objects, regular files only) into a fresh folder, install from its
 * lockfile with no scripts and no network (npm checks every package against the lockfile's integrity hash), build it,
 * list what `npm pack` would ship, wait until nothing runs from the folder any more, and digest dist/ plus the packed
 * files twice — a difference means something is still writing, and refuses.
 */
export async function artifactDigest(gitDir: string, sha: string, runner: BuildRunner, options: { timeoutMs?: number; npmCache?: string } = {}): Promise<{ ok: true; digest: string } | { ok: false; message: string }> {
  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  const dir = realpathSync(mkdtempSync(join(checkLaunchRoot(), "so-carry-")));
  try {
    const src = join(dir, "src"), tmp = join(dir, "tmp");
    mkdirSync(src); mkdirSync(tmp, { mode: 0o700 });
    // npm reads no user or global config of the person's or the commit's: two empty files of this build's own.
    writeFileSync(join(tmp, "user.npmrc"), ""); writeFileSync(join(tmp, "global.npmrc"), "");
    const extracted = extractCommit(gitDir, sha, src);
    if (!extracted.ok) return { ok: false, message: extracted.message };
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: homedir(), TMPDIR: tmp, TMP: tmp, TEMP: tmp, NODE_OPTIONS: "",
      npm_config_userconfig: join(tmp, "user.npmrc"), npm_config_globalconfig: join(tmp, "global.npmrc"), npm_config_cache: options.npmCache ?? join(homedir(), ".npm"),
      npm_config_logs_dir: tmp, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false",
    };
    const step = async (what: string, args: string[]) => {
      const result = await runner("npm", args, { cwd: src, env, writable: [src, tmp], timeoutMs });
      return result.code === 0 && !result.timedOut ? null : `${what} failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}): ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`;
    };
    const installed = await step("The install", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
    if (installed !== null) return { ok: false, message: installed };
    const built = await step("The build", ["run", "build"]);
    if (built !== null) return { ok: false, message: built };
    // Listing what would ship touches no dependency: it gets an empty cache of its own.
    const listing = await runner("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: src, env: { ...env, npm_config_cache: join(tmp, "pack-cache") }, writable: [tmp], timeoutMs });
    if (listing.code !== 0) return { ok: false, message: `Listing the packed files failed: ${listing.stderr.trim().split("\n").slice(-2).join(" ")}` };
    let packed: string[];
    try {
      const parsed = JSON.parse(listing.stdout) as { files?: { path?: unknown }[] }[];
      packed = (parsed[0]?.files ?? []).map(one => String(one.path)).filter(path => !ARTIFACT_EXCLUDED.includes(path));
    } catch { return { ok: false, message: "The packed file list couldn't be read." }; }
    // The build's process group is gone; anything still running from the folder (a background writer) refuses.
    const left = processesInside(dir);
    if (left.length > 0) return { ok: false, message: `Something the build started is still running (process ${left.join(", ")}).` };
    const paths = [...walk(src, "dist"), ...packed];
    const first = digestTree(src, paths);
    if (!first.ok) return first;
    await new Promise(resolve => setTimeout(resolve, 300));
    const again = digestTree(src, [...walk(src, "dist"), ...packed]);
    if (!again.ok) return again;
    if (again.digest !== first.digest) return { ok: false, message: "The build's output changed after the build ended: something is still writing." };
    return { ok: true, digest: first.digest };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ the proof

/** The release task's id for a commit (release.ts gateTaskId's naming). */
export const carriedTaskId = (version: string, sha: string) => `release-${version.replace(/[^0-9A-Za-z.-]/g, "-")}-${sha.slice(0, 7)}`;

export type CarryResult = { ok: true; taskId: string; carry: ReleaseCarry; retried: boolean } | CarryRefusal;

/**
 * Carry a person's release approval to commit `to`, or say exactly why not. The lead may ask; only these rules decide.
 * A refusal seals nothing and writes no row.
 */
export async function proveCarry(store: Store, input: { authority: number; to: string; requestId?: string; epoch?: number | null; now: Date; runner?: BuildRunner; runtime?: string }): Promise<CarryResult> {
  const requestId = input.requestId ?? randomUUID();
  // 1. The idempotent retry first, before any compare-and-swap: a lost answer is retried without a refusal.
  const a0 = releaseAuthority(store, input.authority);
  if (a0 === null) return { ok: false, reason: "authority", message: `No release ${input.authority}.` };
  const existing = releaseCarryTo(store, a0.id, input.to);
  if (existing !== null) {
    const live = liveReleaseOf(store, existing.taskId, "dispatch", input.now);
    if (live.applies && live.ok) return { ok: true, taskId: existing.taskId, carry: existing, retried: true };
    return { ok: false, reason: "authority", message: `The carry to ${input.to.slice(0, 7)} doesn't stand any more: ${live.applies && !live.ok ? live.why : "it isn't part of the release"}.` };
  }
  // 2. Read-only preflight: any refusal stops here, before anything is installed or built.
  const pre = preflightCarry(store, { authority: input.authority, to: input.to, epoch: input.epoch ?? null, now: input.now });
  if (!pre.ok) return pre;
  const plan = pre.plan;
  const gitDir = projectGitDir(plan.authority.repo);
  if (gitDir === null) return { ok: false, reason: "build", message: "The project's Git directory can't be read." };
  const runner = input.runner ?? fencedBuildRunner(store);
  // 3. Both sides built. The anchor's own digest is built once (the person's seal authorized running that approved
  // commit) and sealed into the authority record; until it exists nothing carries.
  let anchorDigest = plan.authority.artifactDigest;
  if (anchorDigest === null) {
    const anchor = await artifactDigest(gitDir, plan.authority.approvedSha, runner);
    if (!anchor.ok) return { ok: false, reason: "build", message: `The approved commit couldn't be built: ${anchor.message}` };
    sealAnchorArtifact(store, plan.authority.id, anchor.digest, input.now);
    anchorDigest = releaseAuthority(store, plan.authority.id)?.artifactDigest ?? null;
    if (anchorDigest !== anchor.digest) return { ok: false, reason: "stale", message: "The release changed while its approved build was sealed; try again." };
  }
  const candidate = await artifactDigest(gitDir, input.to, runner);
  if (!candidate.ok) return { ok: false, reason: "build", message: `${input.to.slice(0, 7)} couldn't be built: ${candidate.message}` };
  if (candidate.digest !== anchorDigest) return { ok: false, reason: "artifact", message: `The production build of ${input.to.slice(0, 7)} differs from the approved one, so this commit needs approval.` };
  // 4. One transaction: every mutable check again, then the writes.
  const after = releaseAuthority(store, plan.authority.id)!;
  const written = carryReleaseApproval(store, {
    authority: after.id, expectRev: after.rev, expectTip: plan.authority.tipSha, to: input.to, toTree: plan.toTree, requestId, artifactDigest: candidate.digest,
    commits: plan.commits, changedLines: plan.changedLines, files: plan.files, churn: plan.churn, runtime: input.runtime ?? runtimeIdentity(),
    taskId: carriedTaskId(after.version, input.to), title: `Release ${after.version}`,
  }, input.now, () => {
    const now = releaseAuthority(store, after.id)!;
    if (now.tipSha !== plan.authority.tipSha) return "The release's current commit moved since this carry was checked.";
    if (releasePolicyDigest(effectivePolicy(store, now.repo)) !== plan.currentPolicyDigest) return "The project's release policy changed since this carry was checked; check it again.";
    if (input.epoch !== undefined && input.epoch !== null && now.leaseEpoch !== input.epoch) return "This coordinator no longer holds the release's lease.";
    return null;
  });
  if (!written.ok) return { ok: false, reason: "stale", message: written.why };
  return { ok: true, taskId: written.taskId, carry: written.carry, retried: false };
}

/** The runtime that proved a carry: this package's version and where it runs from. */
function runtimeIdentity(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return `toolroll ${String(manifest.version ?? "unknown")} (${realpathSync(new URL(".", import.meta.url).pathname).split(sep).slice(-2).join("/")})`;
  } catch { return "toolroll unknown"; }
}

/** The words a refused carry ends with: the commit, the path and the rule, and that a person approves it instead. */
export function carryRefusalWords(refusal: CarryRefusal, to: string): string {
  return `${to.slice(0, 7)} needs approval: ${refusal.message}`;
}

export type { VerifiedCommit };
