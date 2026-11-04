/**
 * The sample project the welcome offers ("Try a sample project"): a small real git repository — a README, one function
 * and its test — made in the project folder, so a first task has something true to change. It is registered like any
 * other project by its caller (project-admission.ts).
 *
 * The folder is claimed with an exclusive mkdir; a folder already there is used again only when it is ours (a real
 * directory, not a link, holding our marker inside its .git), and refused otherwise: nothing in someone else's folder
 * is touched. Git runs hardened (no system or global config, no hooks or hook templates, no fsmonitor, no signing, no
 * prompts, an allowlisted environment), and a folder this call made is removed again when making it fails.
 */
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { run, type ExecResult, type RunOptions } from "./exec.js";
import { SAMPLE_PROJECT_NAME } from "./first-run.js";
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
