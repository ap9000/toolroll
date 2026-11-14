/**
 * The sample project the welcome offers ("Try a sample project"): a small real git repository — a README, one function
 * and its test — made in the project folder, so a first task has something true to change. It is registered like any
 * other project by its caller (project-admission.ts).
 *
 * The folder is claimed with an exclusive mkdir; a folder already there is used again only when it is ours (a real
 * directory, not a link, holding our marker inside its .git), and refused otherwise: nothing in someone else's folder
 * is touched. Git runs hardened (no system or global config, no hooks or hook templates, no fsmonitor, no signing, no
 * prompts, an allowlisted environment), and a folder this call made is removed again when making it fails.
 *
 * Adding it (addSampleProject, below) is one operation for every surface: the console's "Try a sample project", the
 * terminal UI's `s` and `toolroll welcome sample`. Each passes its own proven authority and the projects it serves;
 * the operation never widens either.
 */
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { run, type ExecResult, type RunOptions } from "./exec.js";
import { SAMPLE_PROJECT_NAME } from "./first-run.js";
import { admitProject, type AdmissionActor, type FolderResolver } from "./project-admission.js";
import { authorizedProject, canonicalProject, rowVisible, unscoped, type ProjectCeiling } from "./project.js";
import { loadProjectRegistry, removeRepos, updateRepos } from "./repos.js";
import { ENV, ENV_ALLOWLIST } from "./remote-main.js";
import { TEARDOWN_FLAGS } from "./teardown-git.js";
import type { Store } from "./store.js";

export type GitRun = (file: string, args: readonly string[], options: RunOptions) => Promise<ExecResult>;
export type SampleOutcome =
  | { ok: true; path: string; created: boolean }
  | { ok: false; reason: "no-root" | "exists" | "failed"; message: string };

/** Inside the sample's .git: says the folder is the one this made (never tracked, so the work tree stays clean). */
const MARKER = "toolroll-sample";
const MARKER_TEXT = "Made by Toolroll's welcome as the sample project.\n";

const FILES: Readonly<Record<string, string>> = {
  "README.md": `# Toolroll sample

A tiny project to try Toolroll on. \`src/price.js\` has one function, and \`test/price.test.js\` checks it.

Run the tests with \`npm test\` (Node.js 22 or newer, nothing to install).

Things to ask for:

- Round prices to whole cents and add a test for it.
- Refuse a negative discount with a clear error.
- Add a short usage example to this README.
`,
  "package.json": `${JSON.stringify({ name: "toolroll-sample", version: "1.0.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/price.js": `/** The price after a percentage discount: priceWithDiscount(80, 25) is 60. */
export function priceWithDiscount(price, percent) {
  return price - (price * percent) / 100;
}
`,
  "test/price.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";
import { priceWithDiscount } from "../src/price.js";

test("takes the discount off the price", () => {
  assert.equal(priceWithDiscount(80, 25), 60);
});
`,
  ".gitignore": "node_modules/\n",
};

/** Git for the sample: fixed settings first, an allowlisted environment with no system or global config. */
const SAMPLE_FLAGS: readonly string[] = [
  ...TEARDOWN_FLAGS, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "init.templateDir=",
  "-c", "user.name=Toolroll", "-c", "user.email=sample@toolroll.invalid", "-c", "core.autocrlf=false",
];

function kindOf(path: string): "missing" | "dir" | "other" {
  try {
    const seen = lstatSync(path);
    return seen.isDirectory() && !seen.isSymbolicLink() ? "dir" : "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "other";
  }
}

/** Ours: a real folder whose .git is a real folder holding our marker, a regular file with our words. */
function isOurs(target: string): boolean {
  if (kindOf(target) !== "dir" || kindOf(join(target, ".git")) !== "dir") return false;
  const marker = join(target, ".git", MARKER);
  try {
    const seen = lstatSync(marker);
    return seen.isFile() && seen.size === Buffer.byteLength(MARKER_TEXT) && readFileSync(marker, "utf8") === MARKER_TEXT;
  } catch { return false; }
}

/** Make (or find again) the sample project in `root`, the folder projects go in. */
export async function createSampleProject(root: string | null, git: GitRun = run): Promise<SampleOutcome> {
  if (root === null || root === "" || !isAbsolute(root) || kindOf(root) !== "dir") {
    return { ok: false, reason: "no-root", message: "There's no project folder to put the sample in." };
  }
  const target = join(root, SAMPLE_PROJECT_NAME);
  if (isOurs(target)) return { ok: true, path: target, created: false };
  try {
    mkdirSync(target); // the claim: exclusive, and never through a link
  } catch {
    return { ok: false, reason: "exists", message: `A folder named ${SAMPLE_PROJECT_NAME} is already there, so nothing was changed.` };
  }
  const fail = (): SampleOutcome => {
    try { rmSync(target, { recursive: true, force: true }); } catch { /* left for a person to remove */ }
    return { ok: false, reason: "failed", message: "The sample project couldn't be made. Nothing was added." };
  };
  try {
    for (const [file, body] of Object.entries(FILES)) {
      const path = join(target, file);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body, { flag: "wx" });
    }
    const options: RunOptions = { cwd: target, env: ENV, envAllowlist: ENV_ALLOWLIST, timeoutMs: 30_000 };
    for (const args of [["init", "-q", "--template=", "-b", "main"], ["add", "--", "."], ["commit", "-q", "--no-verify", "-m", "Sample project"]]) {
      const ran = await git("git", [...SAMPLE_FLAGS, ...args], options);
      if (ran.code !== 0) return fail();
    }
    writeFileSync(join(target, ".git", MARKER), MARKER_TEXT, { flag: "wx", mode: 0o600 });
  } catch {
    return fail();
  }
  return { ok: true, path: target, created: true };
}

/** The sample's own check: its one test file, run by Node's test runner. Fixed here; never anyone's input. */
export const SAMPLE_CHECK_COMMAND = "node --test";
const SAMPLE_CHECK_TIMEOUT_MS = 60_000;

/** Who the sample's check is recorded as approved by: Toolroll itself, never the person who clicked (no step-up). */
export const SAMPLE_CHECK_ACTOR = "toolroll";

/**
 * The sample project's check, set as part of making it, so its first result reads checked: the fixed command above,
 * recorded as Toolroll's (SAMPLE_CHECK_ACTOR), with the person who added the sample named in the ledger line. Only
 * for a sample this request just made (the caller passes createSampleProject's `created: true`; a folder found again
 * is never armed), only for the folder this made (our marker in its .git), and only while the project has never had
 * a check at all (no verify_command row, live or revoked, for it or its quick check): a check someone cleared stays
 * cleared, and one someone approved is never replaced. It takes no command: this is not a way to set a project's
 * check. True when it set one now.
 */
export function registerSampleCheck(store: Pick<Store, "transact" | "handle" | "setVerifyCommand" | "recordAction">, made: { path: string; created: boolean }, repo: string, addedBy: string, now: Date): boolean {
  if (!made.created || !isAbsolute(repo) || !isOurs(repo)) return false;
  return store.transact(() => {
    if (store.handle.prepare("SELECT 1 FROM verify_command WHERE repo IN (?, ?) LIMIT 1").get(repo, `quick:${repo}`) !== undefined) return false;
    store.setVerifyCommand({ repo, command: SAMPLE_CHECK_COMMAND, timeoutMs: SAMPLE_CHECK_TIMEOUT_MS, approvedBy: SAMPLE_CHECK_ACTOR }, now);
    store.recordAction({ at: now.toISOString(), actor: SAMPLE_CHECK_ACTOR, repo, taskId: null, runId: null, action: "check approved", outcome: "approved", source: "policy",
      detail: `the sample project's own test (${SAMPLE_CHECK_COMMAND}), set by Toolroll when ${addedBy} added the sample` });
    return true;
  });
}

/** Why the sample project wasn't added, as a fixed key (each surface words it; never words from a folder or git). */
export type SampleAddProblem = "no-root" | "exists" | "failed" | "not-added" | "refused";
export type SampleAdded =
  | { ok: true; repo: string; created: boolean; added: boolean; checkSet: boolean }
  | { ok: false; reason: SampleAddProblem };

/** The folder the sample goes in: the first projects folder of what the caller serves now, or null (none, or a ceiling
 * with nothing configured, which would be the legacy serve-everything mode: never a place to make a project). */
export function sampleRootOf(ceiling: ProjectCeiling): string | null {
  if (unscoped(ceiling)) return null;
  const root = ceiling.roots[0];
  return root === undefined || root === "" || !isAbsolute(root) ? null : root.replace(/\/+$/, "") || null;
}

/**
 * Add the sample project: made (or found again when it is ours) in the caller's first projects folder, then added the
 * way any project is (project-admission.ts admitProject), with its own fixed check only when this call made it.
 *
 * - `authority`: who adds it (the ledger's actor) and whether that authority still stands. Asked before anything is
 *   made, again after each wait, and inside the admission's own locked registry update and database transaction.
 * - `ceiling`: the projects the caller serves, read again at each check. The sample goes only in its first projects
 *   folder, at exactly `<root>/toolroll-sample` (canonical); a ceiling that moved meanwhile adds nothing. Nothing here
 *   adds a projects folder or a repository outside it: the ceiling is never widened.
 * - No root, command, remote or name is ever taken from the caller's input: the folder, the files, the check command
 *   and the name are fixed here. No origin remote is discovered (none exists; none is read).
 */
export async function addSampleProject(input: {
  store: Store;
  registryFile: string | null;
  ceiling: () => ProjectCeiling;
  authority: { actor: AdmissionActor; stands: () => boolean };
  now: Date;
  /** What else the caller lets this person see (the console: their own projects). */
  visible?: (repo: string) => boolean;
  /** How folders resolve (the console: off its thread, under a deadline) and the generation of what it has resolved;
   * absent, canonicalProject. */
  resolveFolder?: FolderResolver;
  generation?: () => number;
  /** Read the ceiling again from its source (the command line: the registry file) once the folder is made. */
  refreshCeiling?: () => Promise<void>;
  git?: GitRun;
}): Promise<SampleAdded> {
  const { store, authority } = input;
  const refused: SampleAdded = { ok: false, reason: "refused" };
  if (!authority.stands()) return refused;
  const root = sampleRootOf(input.ceiling());
  if (root === null) return { ok: false, reason: "no-root" };
  const made = await createSampleProject(root, input.git);
  if (!made.ok) return { ok: false, reason: made.reason };
  await input.refreshCeiling?.();
  // After the wait: the person still stands, and the folder made is still exactly the sample, inside what is served.
  if (!authority.stands()) return refused;
  const decidedOn = input.generation?.() ?? null;
  const resolveNow: FolderResolver = input.resolveFolder ?? (async path => canonicalProject(path));
  const expected = join(root, SAMPLE_PROJECT_NAME);
  const canonical = await resolveNow(made.path);
  if (!authority.stands()) return refused;
  const visible = (repo: string): boolean => input.visible === undefined || input.visible(repo);
  const servedNow = (repo: string): boolean => { const ceiling = input.ceiling(); return sampleRootOf(ceiling) === root && rowVisible(ceiling, repo); };
  if (canonical === null || canonical === "no-answer" || canonical !== expected || !servedNow(canonical)
    || !(await authorizedProject(input.ceiling(), canonical)) || !visible(canonical)) return { ok: false, reason: "not-added" };
  // Asked again inside the admission's locked registry update and its transaction: the same person, the same folder
  // identities, the same served folder.
  const stillAllowed = (repo: string): boolean => repo === canonical && authority.stands()
    && (decidedOn === null || input.generation?.() === decidedOn) && servedNow(repo) && visible(repo);
  const listed = input.registryFile === null ? null : await loadProjectRegistry(input.registryFile);
  const listedBefore = listed !== null && !("error" in listed) && listed.repos.includes(canonical);
  let admitted: Awaited<ReturnType<typeof admitProject>>;
  try {
    admitted = await admitProject(store, { registryFile: input.registryFile, path: canonical, actor: authority.actor, now: input.now, stillAllowed,
      ...(input.resolveFolder === undefined ? {} : { resolveFolder: input.resolveFolder }) });
  } catch {
    // A write refused under it (a local sign-in that lapsed mid-way): its registry line, if this call added one, goes.
    if (input.registryFile !== null && !listedBefore && !store.listProjects().some(one => one.path === canonical)) {
      await updateRepos(input.registryFile, repos => removeRepos(repos, [canonical])).catch(() => undefined);
    }
    return authority.stands() ? { ok: false, reason: "not-added" } : refused;
  }
  if (!admitted.ok || !stillAllowed(admitted.repo)) return authority.stands() ? { ok: false, reason: "not-added" } : refused;
  // Its own fixed check, only for a sample this call made, written while the person still stands.
  const checkSet = store.transact(() => authority.stands() && registerSampleCheck(store, made, admitted.repo, authority.actor.label, input.now));
  return { ok: true, repo: admitted.repo, created: made.created, added: admitted.added, checkSet };
}
