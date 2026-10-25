/**
 * A release a person approved, in a real plane database over a real repository (docs/plans/release-once.md): the
 * project builds with `npm run build` (no dependencies, so it installs offline), its build reads `src/` and the class
 * names in `src/browser/` (as Tailwind does, tests included), and its release scope carries release terms. Shared by the
 * carry tests, the attack suite and the coordinator tests.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, releaseAuthorityOfTask, type ReleaseAuthority, type Store } from "../src/store.js";
import { addApprover, approve, propose } from "../src/scope.js";
import { releaseTermsFor, carriedTaskId } from "../src/release-carry.js";

export const RELEASE_NOW = new Date("2026-10-25T12:00:00.000Z");
export const VERSION = "0.9.71";

const BUILD = `import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.js", readFileSync("src/index.js"));
const classes = new Set();
const scan = dir => { if (!existsSync(dir)) return; for (const name of readdirSync(dir, { withFileTypes: true })) {
  const path = join(dir, name.name);
  if (name.isDirectory()) scan(path); else for (const m of readFileSync(path, "utf8").matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\\s+/)) classes.add(c);
} };
scan("src/browser");
writeFileSync("dist/app.css", [...classes].sort().map(c => "." + c + " {}").join("\\n") + "\\n");
`;

export type ReleaseFixture = {
  dir: string; repo: string; store: Store; password: string; databaseFile: string;
  git(...args: string[]): string;
  commit(files: Record<string, string | null>, message?: string): string;
  approved: string; taskId: string; authority(): ReleaseAuthority;
  close(): void;
};

/** A repository with an approved release of its head. `files` adds to the base tree. */
export function releaseFixture(options: { files?: Record<string, string>; protectedPaths?: string[]; build?: string } = {}): ReleaseFixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "so-release-once-")));
  const repo = join(dir, "project");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const write = (files: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) { rmSync(join(repo, path), { force: true }); continue; }
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  };
  const commit = (files: Record<string, string | null>, message = "change") => { write(files); git("add", "-A"); git("commit", "-q", "-m", message, "--allow-empty"); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  write({
    "package.json": JSON.stringify({ name: "fixture-app", version: VERSION, type: "module", files: ["dist"], scripts: { build: "node build.mjs" } }, null, 2) + "\n",
    "package-lock.json": JSON.stringify({ name: "fixture-app", version: VERSION, lockfileVersion: 3, requires: true, packages: { "": { name: "fixture-app", version: VERSION } } }, null, 2) + "\n",
    "build.mjs": options.build ?? BUILD,
    "src/index.js": "export const answer = 42;\n",
    "src/index.test.ts": "test('answer', () => {});\n",
    "src/browser/app.tsx": "export const App = () => '<div class=\"p-2 text-sm\"></div>';\n",
    "src/browser/app.test.ts": "test('app', () => {});\n",
    "scripts/app-e2e.mjs": "// journeys\n",
    "scripts/release-check.mjs": "// harness\n",
    "test/fresh-store.ts": "export {};\n",
    "test/attacks/fence.test.ts": "test('fence', () => {});\n",
    "docs/guide.md": "# Guide\n",
    "CHANGELOG.md": `## ${VERSION}\n`,
    "AGENTS.md": "# Agents\n",
    ...options.files,
  });
  git("add", "-A"); git("commit", "-q", "-m", "release");
  const approved = git("rev-parse", "HEAD");
  const databaseFile = join(dir, "state", "orders.db");
  mkdirSync(join(dir, "state"), { recursive: true });
  const store = openStore(databaseFile);
  const added = addApprover(store, "alex", RELEASE_NOW);
  if (!added.ok) throw new Error("approver");
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", RELEASE_NOW);
  store.setVerifyCommand({ repo, command: "node scripts/release-check.mjs --full", timeoutMs: 60_000, approvedBy: "alex" }, RELEASE_NOW);
  const taskId = carriedTaskId(VERSION, approved);
  store.createTask({ id: taskId, title: `Release ${VERSION}` }, RELEASE_NOW);
  store.placeTask(store.refFor("built-in", taskId).id, repo, {}, RELEASE_NOW);
  const terms = releaseTermsFor(store, { repo, version: VERSION, branch: "release-0.9.71", pr: 240, candidate: approved, now: RELEASE_NOW });
  if (!terms.ok) throw new Error(terms.why);
  const scope = propose(store, { taskId, goal: `Verify ${VERSION}`, candidate: approved, acceptance: [{ id: "c1", statement: "The release check passes", how: null, evidence: ["check"] }], releaseTerms: terms.terms, now: RELEASE_NOW });
  const yes = approve(store, taskId, "alex", RELEASE_NOW, scope.digest, added.token);
  if (!yes.ok) throw new Error(`approve: ${yes.reason}`);
  // Protected paths added after the approval: the current policy is the stricter one.
  if (options.protectedPaths !== undefined) store.setApprovalRules(repo, { notRequester: false, protectProject: false, protectedPaths: options.protectedPaths }, "alex", RELEASE_NOW);
  return {
    dir, repo, store, password: added.token, databaseFile, git, commit, approved, taskId,
    authority: () => { const found = releaseAuthorityOfTask(store, taskId); if (found === null) throw new Error("no authority"); return found.authority; },
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export { chmodSync, symlinkSync };

/** A finished build of a release task (no check sealed): enough for the deploy gates to reach the release rules. */
export function builtRun(store: Store, taskId: string, head: string): number {
  const ref = store.refFor("built-in", taskId).id;
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error(`route: ${JSON.stringify(authority)}`);
  const run = store.startRun({ taskRef: ref, leaseId: `l-${taskId}-${Math.random()}`, runner: "r", branch: "b", worktree: "/pool/x", route: authority.stamp, now: RELEASE_NOW });
  store.stampRun(run, { scopeDigest: store.getScope(taskId)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(run, { headRevision: head, handoff: "done" });
  store.finishRun(run, { outcome: "built", committed: true, now: RELEASE_NOW });
  return run;
}

/** A build runner that counts what it was asked to run, then runs it unfenced in the extraction (tests only). */
export function countingRunner(): { runner: import("../src/release-carry.js").BuildRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: import("../src/release-carry.js").BuildRunner = async (file, args, options) => {
    calls.push([file, ...args]);
    const { run } = await import("../src/exec.js");
    return run(file, args, { cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs, processGroup: true });
  };
  return { runner, calls };
}
