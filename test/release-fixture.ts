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
import { archiveTaskFamily, openStore, releaseAuthorityOfTask, type ReleaseAuthority, type Store } from "../src/store.js";
import { recordReleaseCi } from "../src/release-approval.js";
import { addApprover, approve, propose } from "../src/scope.js";
import { releaseCheckPurposeFor, releaseTermsFor, carriedTaskId } from "../src/release-carry.js";

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
  /** The commit before the candidate (with `candidate` files), else the candidate itself. */
  base: string;
  close(): void;
};

/** The recorded remote every release fixture's project has (never fetched unless a test maps it). */
export const FIXTURE_REMOTE = "https://example.invalid/r.git";

/** A repository with an approved release of its head. `files` adds to the base tree. */
/** alex's password in every release fixture: fixed, so a run never depends on what a random draw looks like. */
export const FIXTURE_PASSWORD = "fixture-password-alex-8Kq2";

export function releaseFixture(options: { files?: Record<string, string>; protectedPaths?: string[]; build?: string; beforeApproval?: (store: Store, repo: string) => void;
  /** Leave the release task filed and unapproved (an automatic approval's starting point). */
  approve?: boolean;
  /** A commit on top of the base, released as the candidate. */
  candidate?: Record<string, string | null>;
  /** A commit between the base and the candidate (a branch's earlier commit). */
  intermediate?: Record<string, string | null>;
  /** alex's password (default FIXTURE_PASSWORD). */
  password?: string;
  /** The project's checks run outside the sandbox, so the release files without terms: its scope carries a release check
   * purpose instead (pipeline-speed.md, P0), as `task scope --release` files it. */
  termsless?: true } = {}): ReleaseFixture {
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
  const base = git("rev-parse", "HEAD");
  if (options.intermediate !== undefined) commit(options.intermediate, "intermediate");
  const approved = options.candidate === undefined ? base : commit(options.candidate, "candidate");
  const databaseFile = join(dir, "state", "orders.db");
  mkdirSync(join(dir, "state"), { recursive: true });
  const store = openStore(databaseFile);
  // The project's recorded remote: the trusted reads of main (nightly-check.ts) are bound to it.
  store.upsertProject(repo, "project", RELEASE_NOW, { remoteUrl: FIXTURE_REMOTE });
  // A fixed password: randomness isn't what these tests are about, and a random one starts with "--" about 1 time in
  // 4096 (0.9.76's CI: a CLI parser read such a password as a missing value).
  const added = addApprover(store, "alex", RELEASE_NOW, undefined, () => options.password ?? FIXTURE_PASSWORD);
  if (!added.ok) throw new Error("approver");
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", RELEASE_NOW);
  store.setVerifyCommand({ repo, command: "node scripts/release-check.mjs --full", timeoutMs: 60_000, approvedBy: "alex" }, RELEASE_NOW);
  options.beforeApproval?.(store, repo);
  const taskId = carriedTaskId(VERSION, approved);
  store.createTask({ id: taskId, title: `Release ${VERSION}` }, RELEASE_NOW);
  store.placeTask(store.refFor("built-in", taskId).id, repo, {}, RELEASE_NOW);
  if (options.termsless === true && store.setProjectCheckAccess(repo, "unsandboxed", "alex", RELEASE_NOW, { may: "widen" }) === null) throw new Error("check access");
  const terms = releaseTermsFor(store, { repo, version: VERSION, branch: "release-0.9.71", pr: 240, candidate: approved, now: RELEASE_NOW });
  const purpose = options.termsless === true ? releaseCheckPurposeFor(store, { repo, version: VERSION, branch: "release-0.9.71", pr: 240, candidate: approved }) : null;
  if (options.termsless === true ? terms.ok || purpose === null || !purpose.ok : !terms.ok) throw new Error(terms.ok ? "terms were made for a termsless release" : terms.why);
  const sealed = purpose !== null && purpose.ok ? { releaseCheck: purpose.purpose } : { releaseTerms: (terms as Extract<typeof terms, { ok: true }>).terms };
  const scope = propose(store, { taskId, goal: `Verify ${VERSION}`, candidate: approved, acceptance: [{ id: "c1", statement: "The release check passes", how: null, evidence: ["check"] }], ...sealed, now: RELEASE_NOW });
  if (options.approve !== false) {
    const yes = approve(store, taskId, "alex", RELEASE_NOW, scope.digest, added.token);
    if (!yes.ok) throw new Error(`approve: ${yes.reason}`);
  }
  // Protected paths added after the approval: the current policy is the stricter one.
  if (options.protectedPaths !== undefined) store.setApprovalRules(repo, { notRequester: false, protectProject: false, protectedPaths: options.protectedPaths }, "alex", RELEASE_NOW);
  return {
    dir, repo, store, password: added.token, databaseFile, git, commit, approved, taskId, base,
    authority: () => { const found = releaseAuthorityOfTask(store, taskId); if (found === null) throw new Error("no authority"); return found.authority; },
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export { chmodSync, symlinkSync };

/** A finished build of a release task (no check sealed): enough for the deploy gates to reach the release rules. */
export function builtRun(store: Store, taskId: string, head: string, base = "1".repeat(40)): number {
  const ref = store.refFor("built-in", taskId).id;
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error(`route: ${JSON.stringify(authority)}`);
  const run = store.startRun({ taskRef: ref, leaseId: `l-${taskId}-${Math.random()}`, runner: "r", branch: "b", worktree: "/pool/x", route: authority.stamp, now: RELEASE_NOW });
  store.stampRun(run, { scopeDigest: store.getScope(taskId)!.digest, baseRevision: base });
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

// ------------------------------------------------------------------ release checks, sealed as the builder seals them

import { storeEvidence } from "../src/evidence.js";
import { prepareCheckAttempt, sealCheckOutcome } from "../src/check-report.js";
import { planTargetedRecheck, settleCoverage } from "../src/release-recheck.js";
import { effectiveCheckFacts, sealVerificationReceipt, verificationEvidence } from "../src/verification-evidence.js";
import { retriedInside } from "../src/check-failure.js";
import { recordRunCheckLevel } from "../src/check-levels.js";
import { CHECK_STAMP_VERSION } from "../src/check-stamp.js";
import { recordCheckStamp } from "../src/store.js";
import { CHECK_INVENTORY_CAPTURE, CHECK_REPORT_CAPTURE } from "../src/check-report.js";
import type { CheckReport } from "../src/contracts/release-check.js";
export const EVIDENCE = (f: ReleaseFixture) => join(f.dir, "evidence");

/** One unit file's outcome in a report. */
export type UnitOutcome = { file: string; state?: "passed" | "failed" | "skipped"; failed?: string[]; skipped?: string[]; passed?: string[]; flaky?: boolean };

/** A release check report with these units (every other part passed, no journeys or upgrades unless given). */
export function reportOf(units: UnitOutcome[], extra: Partial<CheckReport> & { exitCode?: number } = {}): Omit<CheckReport, "nonce" | "mode" | "planDigest"> {
  const unitFailed = units.some(one => (one.failed ?? []).length > 0 || one.state === "failed");
  // Every part runs (the plane owes the fixture's journeys and, with no release recorded, every part the tree can run):
  // each journey run passes one group, the upgrade path one version, unless `extra` says otherwise.
  const parts = ["typecheck", "build", "unit", "flows", "app", "flows-real", "app-real", "upgrade"].map(part => ({ part: part as CheckReport["parts"][number]["part"],
    selected: true, ran: true, code: part === "unit" ? (unitFailed ? 1 : 0) : 0, timedOut: false }));
  const run = (script: "flows" | "app", kind: "scripted" | "real") => ({ script, kind, finished: true, inventoried: true,
    groups: [{ group: "core", state: "passed" as const, retried: false, unattributed: false, journeys: [{ name: "opens", state: "passed" as const }] }] });
  const runs = [run("flows", "scripted"), run("app", "scripted"), run("flows", "real"), run("app", "real")];
  const journeys = runs.map(one => extra.journeys?.find(given => given.script === one.script && given.kind === one.kind) ?? one);
  return {
    version: 1, exitCode: extra.exitCode ?? (units.some(one => (one.failed ?? []).length > 0 || one.state === "failed") ? 1 : 0),
    parts: extra.parts ?? parts,
    units: extra.units !== undefined ? extra.units : { reusedFromCI: false, finished: true, runErrors: 0,
      files: units.map(one => ({ file: one.file, state: one.state ?? ((one.failed ?? []).length > 0 ? "failed" : "passed"), passed: (one.passed ?? []).length, failed: (one.failed ?? []).length, skipped: (one.skipped ?? []).length, flaky: one.flaky === true })),
      identities: units.flatMap(one => [...(one.failed ?? []).map(name => ({ file: one.file, name, state: "failed" as const, flaky: false })),
        ...(one.skipped ?? []).map(name => ({ file: one.file, name, state: "skipped" as const, flaky: false })), ...(one.passed ?? []).map(name => ({ file: one.file, name, state: "passed" as const, flaky: false }))]) },
    journeys,
    upgrades: extra.upgrades !== undefined ? extra.upgrades : { finished: true, inventoried: true, versions: [{ version: "0.9.1", state: "passed" }] },
  };
}

/**
 * One release check of a task's build, sealed as the builder seals it: the attempt row before it "runs" (targeted when
 * planTargetedRecheck allows it), the report on the check's output with the nonce, its coverage, its log and its
 * version 3 receipt. `report` gets the attempt's plan so a targeted report can answer it.
 */
export function sealedCheck(f: ReleaseFixture, taskId: string, head: string, report: (plan: import("../src/contracts/release-check.js").TargetedPlan | null, units: readonly string[]) => Omit<CheckReport, "nonce" | "mode" | "planDigest"> | null, options: { forceFull?: boolean; base?: string; release?: boolean; setupReplayed?: true;
  /** What the check printed before its report (a test's own lines, a learning line); given the attempt's nonce. */
  stdoutBefore?: (nonce: string) => string;
  /** Asked about for learning only (the handshake's `learn`). */
  learn?: readonly string[];
  /** What the plane saw of the command instead of an exit (it never started, Toolroll's own shutdown stopped it, it
   * timed out): the builder's own result, sealed in the receipt. */
  plane?: { configured: true; ran: false; attemptFailed: true; failure: import("../src/contracts/verification-receipt.js").VerifyCommandFacts extends infer F ? F extends { failure?: infer X } ? X : never : never } } = {}) {
  const store = f.store, root = EVIDENCE(f);
  const runId = builtRun(store, taskId, head, options.base);
  recordRunCheckLevel(store, { id: runId, taskId, repo: f.repo }, "full", "project", RELEASE_NOW);
  const command = store.liveVerifyCommand(f.repo)!;
  const decision = planTargetedRecheck(store, root, { runId, taskId, repo: f.repo, head, command, access: "sandboxed", now: RELEASE_NOW });
  const targeted = decision.mode === "targeted" && options.forceFull !== true;
  const prepared = prepareCheckAttempt(store, root, { runId, repo: f.repo, head, command, access: "sandboxed", authority: decision.authority,
    ...(targeted && decision.mode === "targeted" ? { plan: decision.plan, snapshot: decision.snapshot } : {}), watch: decision.watch, ...(options.release === undefined ? {} : { release: options.release }), ...(options.learn === undefined ? {} : { learn: options.learn }) }, RELEASE_NOW);
  if (prepared === null) throw new Error("no attempt");
  const body = report(prepared.plan, prepared.inventory.units);
  const exitCode: number | null = options.plane !== undefined ? null : body?.exitCode ?? 1;
  const full = body === null ? null : { ...body, nonce: prepared.nonce, mode: prepared.mode, planDigest: prepared.plan === null ? null : createHashHex(JSON.stringify(prepared.plan)) };
  const before = options.stdoutBefore?.(prepared.nonce) ?? "";
  const stdout = full === null ? `${before}the report was lost\n` : `checks\n${before}TOOLROLL_CHECK_REPORT ${JSON.stringify(full)}\n`;
  const sealedReport = sealCheckOutcome(store, root, prepared, { stdout, exitCode }, RELEASE_NOW);
  const settled = settleCoverage(store, root, { runId, taskId, exitCode, now: RELEASE_NOW }, run => { const gate = verificationEvidence(store, root, run); return gate.ok ? gate.digest : null; });
  storeEvidence(store, root, runId, "check-log", "check-log.txt", Buffer.from(`exit ${exitCode}\n`), command.command, RELEASE_NOW, { captureStatus: "ok" });
  const sha = (capture: string) => { const found = store.artifactsFor(runId).filter(a => a.kind === "structured-output" && a.capture === capture); return found.length === 1 ? found[0]!.sha256 : null; };
  // As the builder does: coverage meets the outcome in one place.
  const effective = effectiveCheckFacts(options.plane ?? { configured: true, ran: true, exitCode: exitCode ?? 1, ...(options.setupReplayed === true ? { setupReplayed: true as const, firstAttempt: { class: "launch" as const, program: "tsc", exitCode: 127 } } : {}) }, { coverage: settled.coverage, check: { attempt: prepared.mode, report: sha(CHECK_REPORT_CAPTURE), inventory: sha(CHECK_INVENTORY_CAPTURE), retried: retriedInside(sealedReport) }, composed: settled.composed });
  sealVerificationReceipt(store, root, runId, head, command, effective.result, RELEASE_NOW, undefined, effective.facts ?? undefined);
  const passed = effective.result.configured && effective.result.ran && effective.result.exitCode === 0;
  // As the launch does (invoke.ts): how the check's commands ran, at the level it was sealed for.
  recordCheckStamp(store, runId, { version: CHECK_STAMP_VERSION, level: "sandboxed", policyDigest: "a".repeat(32), writable: [f.dir], readable: [], network: { mode: "machine" } }, RELEASE_NOW);
  store.recordRunCheck(runId, { status: passed ? "passed" : "failed", exitCode: effective.result.configured && effective.result.ran ? effective.result.exitCode : null, suites: [] }, RELEASE_NOW);
  return { runId, prepared, decision, coverage: settled.coverage, composed: settled.composed, stdout, report: sealedReport, status: passed ? "passed" as const : "failed" as const, command };
}

function createHashHex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
import { createHash } from "node:crypto";

/**
 * Every state the release sheet refuses (release-approval.ts refusalOf), each put on a fixture's unapproved release task
 * with no CI hold outstanding, and the sheet's own sentence for it. `phrase` is a piece of that sentence with no
 * apostrophe, for HTML bodies. Every approval road refuses these in these words (scope.ts approve()).
 */
export const RELEASE_REFUSALS: readonly { name: string; apply(f: ReleaseFixture, now: Date): void; words: RegExp; phrase: string }[] = [
  { name: "put away", phrase: "This release is put away. Restore it before approving.", words: /^This release is put away\. Restore it before approving\.$/,
    apply: (f, now) => {
      const put = archiveTaskFamily(f.store, f.taskId, { by: "alex", byKind: "person", rule: null, reason: "test" }, now);
      if (!put.ok) throw new Error(put.message);
    } },
  { name: "GitHub CI recorded failed, no hold", phrase: "Fix the branch or rerun the failed job on GitHub, then release again.",
    words: /^GitHub CI failed on [0-9a-f]{7}: E2E \(failure\)\. Fix the branch or rerun the failed job on GitHub, then release again\.$/,
    apply: (f, now) => {
      recordReleaseCi(f.store, { taskId: f.taskId, candidate: f.approved, state: "failed", failed: ["E2E (failure)"], runs: [{ id: 3, name: "E2E", status: "completed", conclusion: "failure" }], now });
    } },
  { name: "the release check already failed on this commit", phrase: "The release check already failed on this commit. Fix the branch and release the new commit.",
    words: /^The release check already failed on this commit\. Fix the branch and release the new commit\.$/,
    apply: (f, now) => {
      f.store.handle.prepare("INSERT INTO release_step (task_id, tag, version, pr, step, state, started_at, ended_at, detail, updated_at) VALUES (?, ?, ?, 240, 'check', 'failed', ?, ?, NULL, ?)")
        .run(f.taskId, `v${VERSION}`, VERSION, now.toISOString(), now.toISOString(), now.toISOString());
    } },
  { name: "terms changed after an earlier approval", phrase: "terms changed after an earlier approval. Read them again.",
    words: /^The release's terms changed after an earlier approval\. Read them again\.$/,
    apply: (f, now) => {
      const yes = approve(f.store, f.taskId, "alex", now, f.store.getScope(f.taskId)!.digest, f.password);
      if (!yes.ok) throw new Error(`approve: ${yes.reason}`);
      // The yes stands on an earlier version of the terms: what is on file now isn't what was agreed.
      f.store.handle.prepare("UPDATE task_scope SET approved_digest = ? WHERE task_id = ?").run("e".repeat(64), f.taskId);
    } },
];
