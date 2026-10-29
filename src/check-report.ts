/**
 * The release check's structured report, on the plane's side (docs/plans/release-once.md, part 2 and rollout phase A).
 *
 * Before a Full check of a prepared candidate runs, the builder seals a `release_check_attempt` row: the intended mode
 * (`full`, or `targeted` with its plan and obligation snapshot), the hash of a fresh nonce, the inventory the check must
 * account for (the unit files, from the verified tree and Vitest's include globs, and the parts selected) and the
 * execution context. It then writes `{"nonce","mode","plan","watch"}` on the check's stdin and closes it.
 *
 * After the check, the report is the last `TOOLROLL_CHECK_REPORT <json>` line of its output that carries that nonce
 * (a line a test prints, or one a leftover process writes, has no nonce and is ignored). It is read strictly and sealed
 * as `check-report.json`, beside `check-inventory.json` (what was sealed, and the groups and versions the check
 * declared). A Full release check qualifies only with all of it (fullCheckProblem): a valid report carrying this run's
 * nonce, a complete inventory, a terminal result for every part, file, journey group and upgrade version it owed, and a
 * successful exit. Anything less — no report, a malformed or cut-short one, one whose exit disagrees, a part that never
 * finished, a file with no result — is an error, "no result", and never a pass. A failed check's report only has to be
 * valid: what it failed on is its result.
 *
 * Coverage trusts test code (the trust decision in the plan). Nothing here decides who may release or deploy.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readVerifiedCommit, verifiedTreeEntries, type VerifiedEntry } from "./commit-extract.js";
import {
  CHECK_PARTS, CHECK_REPORT_MAX_BYTES, CHECK_REPORT_PREFIX, readCheckReport,
  type CheckContext, type CheckPart, type CheckInventory, type CheckReport, type ObligationSnapshot, type SealedInventory, type TargetedPlan,
} from "./contracts/release-check.js";
import { readVerifiedArtifact, storeEvidence } from "./evidence.js";
import { releaseBaseline } from "./release-card.js";
import { checkAttemptOf, recordCheckAttempt, type Store, type VerifyCommand } from "./store.js";

/** The sealed artifacts' capture labels: what a reader looks for, by exact name. */
export const CHECK_REPORT_CAPTURE = "release check report v1";
export const CHECK_INVENTORY_CAPTURE = "release check inventory v1";
export const TARGETED_PLAN_CAPTURE = "release check targeted plan v1";
export const OBLIGATION_SNAPSHOT_CAPTURE = "release check obligation snapshot v1";
export const CHECK_CONTEXT_CAPTURE = "release check context v1";
/** How large a sealed check artifact may be (the report's own bound). */
export const CHECK_ARTIFACT_CAP = CHECK_REPORT_MAX_BYTES;

/** The release check's harness, named: the orchestrator, its runners and helpers, Vitest's configuration and setup, and
 * the reporter. These never carry (release-carry.ts). The execution context digests far more (inHarnessDigest). */
export const HARNESS_FILES: readonly string[] = Object.freeze([
  "scripts/release-check.mjs", "scripts/release-check-ci.mjs", "scripts/suite-lifecycle.mjs", "scripts/provider-gate.mjs",
  "scripts/e2e-parallel.mjs", "scripts/e2e-kit.mjs", "scripts/upgrade-path.mjs", "scripts/check-results.mjs",
  "vitest.config.ts", "test/attacks/vitest.config.ts",
  "test/setup-state.ts", "test/fresh-store.ts", "test/temp-root.ts", "test/ensure-build.ts", "test/release-reporter.ts",
]);

/** Vitest's include globs (vitest.config.ts), as the plane reads them: a change to that file is a harness change. */
export const UNIT_INCLUDE: readonly RegExp[] = Object.freeze([/^src\/.+\.test\.ts$/, /^test\/attacks\/.+\.test\.ts$/]);
export const isUnitFile = (path: string): boolean => UNIT_INCLUDE.some(one => one.test(path));

/** The project's own Git directory as Toolroll records it: `<realpath(repo)>/.git`, a real directory. */
export function projectGitDir(repo: string): string | null {
  try {
    const named = join(realpathSync(repo), ".git");
    return lstatSync(named).isDirectory() ? realpathSync(named) : null;
  } catch { return null; }
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
/** A digest of a payload, over its canonical JSON. */
export const payloadDigest = (value: unknown): string => sha256(JSON.stringify(value));

/**
 * Whether a tree path is part of the harness for the execution context: every file EXCEPT the unit test files
 * themselves, the two journey scripts, docs and Markdown. No import tracing: a harness dependency reached by any road
 * (a `require`, a computed `import()`, a side-effect import, a `src/` helper, a config file) is inside this set, so a
 * change to it always changes the digest (fail closed).
 */
export function inHarnessDigest(path: string): boolean {
  if (isUnitFile(path)) return false;
  if (path === "scripts/app-e2e.mjs" || path === "scripts/flows-e2e.mjs") return false;
  if (path.startsWith("docs/") || path.endsWith(".md")) return false;
  return true;
}

/** What the plane reads from a commit for a check: its tree's entries, its unit files and its harness. */
export type TreeFacts = { tree: string; entries: VerifiedEntry[]; units: string[]; harness: string[]; harnessDigest: string; lockfile: string | null };

/** The tree facts of `sha`, from objects hashed here (never the checkout). Null with why when they can't be read. */
export function treeFactsOf(gitDir: string, sha: string): { ok: true; facts: TreeFacts } | { ok: false; problem: string } {
  const commit = readVerifiedCommit(gitDir, sha);
  if (!commit.ok) return { ok: false, problem: commit.message };
  const entries = verifiedTreeEntries(gitDir, commit.value.tree);
  if (!entries.ok) return { ok: false, problem: entries.message };
  const harness = entries.value.filter(one => inHarnessDigest(one.path)).map(one => one.path).sort();
  const ids = new Map(entries.value.map(one => [one.path, one.id]));
  return { ok: true, facts: {
    tree: commit.value.tree,
    entries: entries.value,
    units: entries.value.filter(one => (one.mode === "100644" || one.mode === "100755") && isUnitFile(one.path)).map(one => one.path).sort(),
    harness,
    harnessDigest: payloadDigest(entries.value.filter(one => inHarnessDigest(one.path)).map(one => [one.path, one.mode, one.id])),
    lockfile: ids.get("package-lock.json") ?? null,
  } };
}

/** The execution context a check runs in: what must match for results to stand beside each other. The machine's load
 * budget is left out: it changes how fast a check runs, never what passes (scripts/release-check.mjs checkBudget). */
export function checkContextOf(facts: TreeFacts, command: VerifyCommand, access: string): CheckContext {
  return { version: 1, node: process.version, platform: process.platform, arch: process.arch, lockfile: facts.lockfile, harness: facts.harnessDigest, grant: { id: command.id, digest: command.digest }, access };
}

/** Every part a check can have. */
export const FULL_PARTS: readonly CheckPart[] = CHECK_PARTS;

/** Changes no test reads: the plane's copy of scripts/release-check.mjs NOTHING (check-report.test.ts holds them equal). */
export const NOTHING_PATHS: readonly RegExp[] = Object.freeze([/\.md$/, /^docs\//, /^evidence\//, /^design\//, /^output\//, /^LICENSE$/, /\.png$/]);
/** Model-facing code, whose change runs the real-model journeys: the plane's copy of scripts/release-check.mjs MODEL. */
export const MODEL_PATHS: readonly RegExp[] = Object.freeze([
  /^src\/(lead|converse|subscription-chat|chat-[a-z-]+|lead-[a-z-]+|memory-pass)\.ts$/,
  /^src\/(planner|planner-[a-z-]+|plan|builder|build-review|reviewer|scout|scout-[a-z-]+|decision|evidence)\.ts$/,
  /^src\/(subagents|subagent-work|task-sizing|flow-sort|flow-draft)\.ts$/,
  /^src\/(provider|provider-[a-z-]+|invoke|exec|attest|coding-provider|assignment-adapters|subscription-[a-z-]+)\.ts$/,
]);

/** Whether a changed path can affect an upgrade: the plane's copy of scripts/release-check.mjs needsUpgrade, without its
 * version-only exception (the plane counts a version bump as a change, so it owes more, never less). */
export function upgradeRelevant(file: string): boolean {
  if (/^(docs|evidence|design|output)\//.test(file) || /\.md$/.test(file) || file === "LICENSE") return false;
  if (/\.test\.[cm]?[jt]sx?$/.test(file) || /^test\//.test(file)) return false;
  if (/^src\/(browser|design)\//.test(file) || /\.css$/.test(file)) return false;
  if (/^scripts\/(app-e2e|flows-e2e|e2e-parallel)\.mjs$/.test(file)) return false;
  return true;
}

/** The paths that differ between two verified trees: added, removed, or with another mode or blob. */
export function changedPaths(facts: TreeFacts, base: TreeFacts): string[] {
  const before = new Map(base.entries.map(one => [one.path, `${one.mode} ${one.id}`]));
  const after = new Map(facts.entries.map(one => [one.path, `${one.mode} ${one.id}`]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort();
}

/**
 * The parts a Full check owes, decided by the plane before it runs (eval-harness review 1, finding 2), never by the
 * check's own report: the typecheck and the build always; the unit suite when anything a test reads changed since
 * `base` (the plane's own record of the last release, both trees verified here) and the tree has unit files; the
 * scripted journeys likewise when the tree has the journey scripts; the real-model journeys when model-facing code
 * changed; the upgrade path when a change can affect an upgrade and the tree has it. With no base every one the tree
 * can run is owed. The check is told these on its handshake and runs at least them.
 */
export function fullObligationsOf(facts: TreeFacts, base: TreeFacts | null): CheckPart[] {
  const has = (path: string) => facts.entries.some(one => one.path === path && (one.mode === "100644" || one.mode === "100755"));
  const journeys = has("scripts/flows-e2e.mjs") && has("scripts/app-e2e.mjs");
  const changed = base === null ? null : changedPaths(facts, base);
  const code = changed?.filter(path => !NOTHING_PATHS.some(re => re.test(path))) ?? null;
  const checks = code === null || code.length > 0;
  const real = code === null || code.some(path => !/\.test\.[cm]?[jt]s$/.test(path) && MODEL_PATHS.some(re => re.test(path)));
  const upgrade = has("scripts/upgrade-path.mjs") && (changed === null || changed.some(upgradeRelevant));
  return [
    "typecheck", "build",
    ...(checks && facts.units.length > 0 ? ["unit" as const] : []),
    ...(checks && journeys ? ["flows" as const, "app" as const] : []),
    ...(real && journeys ? ["flows-real" as const, "app-real" as const] : []),
    ...(upgrade ? ["upgrade" as const] : []),
  ];
}

/** What a check must account for, sealed before it runs: every unit file of the tree, whatever runs (a targeted
 * check accounts for the rest through its base), and the parts it owes (a full check's from fullObligationsOf), and
 * whether CI may stand in for its unit suite. */
export function inventoryOf(facts: TreeFacts, plan: TargetedPlan | null, full: { owed: readonly CheckPart[]; ciSubstitute: boolean } = { owed: FULL_PARTS, ciSubstitute: false }): CheckInventory {
  if (plan !== null) return { version: 1, units: facts.units, parts: ["typecheck", "build", ...plan.parts.filter(one => one !== "typecheck" && one !== "build")] };
  return { version: 1, units: facts.units, parts: [...full.owed], ciSubstitute: full.ciSubstitute };
}

/** A check about to run: its handshake (written on stdin, then closed) and the facts sealed with it. */
export type PreparedAttempt = {
  runId: number;
  nonce: string;
  stdin: string;
  mode: "full" | "targeted";
  inventory: CheckInventory;
  context: CheckContext;
  plan: TargetedPlan | null;
  snapshot: ObligationSnapshot | null;
  /** The identities the check was asked to report one by one (required ones). */
  watch: string[];
};

/**
 * Seal a check's attempt row before its command is spawned: intended mode, nonce hash, inventory and context (and for a
 * targeted check its plan and obligation snapshot, sealed as artifacts first). Null when the plane can't read the
 * commit, which leaves the check running exactly as it always has, with no handshake.
 */
export function prepareCheckAttempt(store: Store, root: string, input: {
  runId: number; repo: string; head: string; command: VerifyCommand; access: string;
  authority?: number | null; plan?: TargetedPlan | null; snapshot?: ObligationSnapshot | null; watch?: readonly string[];
  /** A release's check (signed release terms or a release authority): CI never stands in for its unit suite. */
  release?: boolean;
}, now: Date): PreparedAttempt | null {
  if (checkAttemptOf(store, input.runId) !== null) return null;
  const gitDir = projectGitDir(input.repo);
  if (gitDir === null) return null;
  const read = treeFactsOf(gitDir, input.head);
  if (!read.ok) return null;
  const plan = input.plan ?? null, snapshot = input.snapshot ?? null;
  // A full check owes what the plane decides here, from the last release it recorded (never a tag the checkout holds).
  const baseline = plan === null ? releaseBaseline(store, input.repo) : null;
  const baseRead = baseline === null ? null : treeFactsOf(gitDir, baseline);
  const owed = fullObligationsOf(read.facts, baseRead !== null && baseRead.ok ? baseRead.facts : null);
  const ciSubstitute = input.release !== true;
  const inventory = inventoryOf(read.facts, plan, { owed, ciSubstitute });
  const context = checkContextOf(read.facts, input.command, input.access);
  const nonce = randomBytes(32).toString("hex");
  const mode = plan === null ? "full" as const : "targeted" as const;
  sealJson(store, root, input.runId, "check-context.json", context, CHECK_CONTEXT_CAPTURE, now);
  if (plan !== null) sealJson(store, root, input.runId, "targeted-plan.json", plan, TARGETED_PLAN_CAPTURE, now);
  if (snapshot !== null) sealJson(store, root, input.runId, "obligation-snapshot.json", snapshot, OBLIGATION_SNAPSHOT_CAPTURE, now);
  recordCheckAttempt(store, {
    run: input.runId, authority: input.authority ?? null, mode, baseRun: plan?.base ?? null,
    planDigest: plan === null ? null : payloadDigest(plan), snapshotDigest: snapshot === null ? null : payloadDigest(snapshot),
    inventoryDigest: payloadDigest(inventory), contextDigest: payloadDigest(context), nonceHash: sha256(nonce),
  }, now);
  // The command's own limit rides along, so the check ends itself (logs and report printed) before the plane stops it.
  const stdin = JSON.stringify({ nonce, mode, plan, watch: [...(input.watch ?? [])], limitMs: input.command.timeoutMs, ...(plan === null ? { owed, ciSubstitute } : {}) });
  return { runId: input.runId, nonce, stdin, mode, inventory, context, plan, snapshot, watch: [...(input.watch ?? [])] };
}

/** Seal one JSON payload as a structured-output artifact under its capture label. */
export function sealJson(store: Store, root: string, runId: number, name: string, value: unknown, capture: string, now: Date): number {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > CHECK_ARTIFACT_CAP) throw new Error(`${name} is over ${CHECK_ARTIFACT_CAP} bytes`);
  return storeEvidence(store, root, runId, "structured-output", name, bytes, capture, now, { captureStatus: "ok", cap: CHECK_ARTIFACT_CAP });
}

/**
 * The check's report from its output: the LAST `TOOLROLL_CHECK_REPORT <json>` line carrying this nonce, at most 256 KiB,
 * that matches the contract. Lines without the nonce (a test's print, a leftover process's write) are passed over.
 */
export function reportFromOutput(stdout: string, nonce: string): { ok: true; report: CheckReport; raw: string } | { ok: false; problem: string } {
  const lines = stdout.split("\n");
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at]!;
    if (!line.startsWith(CHECK_REPORT_PREFIX)) continue;
    if (Buffer.byteLength(line) > CHECK_REPORT_MAX_BYTES) continue;
    const raw = line.slice(CHECK_REPORT_PREFIX.length);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (parsed === null || typeof parsed !== "object" || (parsed as Record<string, unknown>)["nonce"] !== nonce) continue;
    const read = readCheckReport(parsed);
    if (!read.ok) return { ok: false, problem: `The check's report doesn't match its contract: ${read.issues.slice(0, 3).map(one => one.line).join("; ")}` };
    return { ok: true, report: read.value, raw };
  }
  return { ok: false, problem: "The check gave no report for this run." };
}

/**
 * After the check: seal its report (when it gave a valid one) and the inventory artifact. `exitCode` is the check's own
 * exit; a report that disagrees with it is no report. Returns the report, or null.
 */
export function sealCheckOutcome(store: Store, root: string, attempt: PreparedAttempt, output: { stdout: string; exitCode: number | null }, now: Date): CheckReport | null {
  const read = reportFromOutput(output.stdout, attempt.nonce);
  const report = read.ok && read.report.mode === attempt.mode && read.report.exitCode === output.exitCode &&
    read.report.planDigest === (attempt.plan === null ? null : payloadDigest(attempt.plan)) ? read.report : null;
  const declared = report === null ? { groups: [], versions: [] } : {
    groups: report.journeys.map(one => ({ script: one.script, kind: one.kind, groups: one.groups.map(group => group.group) })),
    versions: report.upgrades?.versions.map(one => one.version) ?? [],
  };
  const sealedInventory: SealedInventory = { version: 1, sealed: attempt.inventory, declared };
  sealJson(store, root, attempt.runId, "check-inventory.json", sealedInventory, CHECK_INVENTORY_CAPTURE, now);
  if (report !== null) sealJson(store, root, attempt.runId, "check-report.json", report, CHECK_REPORT_CAPTURE, now);
  return report;
}

/** One sealed check artifact of a run, read back and verified, or null (missing, ambiguous, cut short or changed). */
export function readSealedJson(store: Store, root: string, runId: number, capture: string): { value: unknown; digest: string } | null {
  const found = store.artifactsFor(runId).filter(one => one.kind === "structured-output" && one.capture === capture);
  if (found.length !== 1) return null;
  const artifact = found[0]!;
  if (artifact.truncated || artifact.redacted || artifact.captureStatus !== "ok") return null;
  const read = readVerifiedArtifact(root, artifact);
  if (!read.ok) return null;
  try { return { value: JSON.parse(read.content.toString("utf8")), digest: artifact.sha256 }; } catch { return null; }
}

/**
 * Why a Full release check has no result it can count — or null when it qualifies as one. The plane's own facts are the
 * exit it saw (`exitCode`, null when the check didn't exit on its own: timed out or stopped) and the inventory it sealed
 * before the check ran; the report must agree with both. A failed check (a nonzero exit) needs only a valid report: what
 * it failed on is its result. A passing exit needs every obligation the plane sealed (the inventory's parts, never the
 * report's own "selected") to have an outcome, and every part the report ran too: every part once, each run to its
 * end; the unit suite finished with a result for every sealed unit file (CI stands in only when the sealed plan allowed
 * it); every journey run finished, its groups listed before they ran, each passed group with a journey result; and the
 * upgrade path finished, its versions listed, every one run. An explicitly empty inventory (no groups of that kind) is
 * an outcome; a missing one is not. Missing, malformed, truncated or skipped-required results never read as a pass.
 */
export function fullCheckProblem(input: { report: CheckReport | null; inventory: SealedInventory | null; exitCode: number | null }): string | null {
  const { report, inventory, exitCode } = input;
  if (exitCode === null) return "the check didn't end on its own (it timed out or was stopped), so it has no result";
  if (report === null) return "the check gave no valid report for this run (none, a malformed or cut-short one, or one without this run's nonce)";
  if (report.mode !== "full") return "the check reported a targeted run, not the full one it was asked for";
  if (report.exitCode !== exitCode) return `the check's report says exit ${report.exitCode}, but it exited ${exitCode}`;
  if (inventory === null) return "the check's sealed inventory can't be read";
  if (exitCode !== 0) return null;
  const parts = new Map(report.parts.map(one => [one.part, one]));
  if (parts.size !== report.parts.length || CHECK_PARTS.some(part => !parts.has(part))) return "the report doesn't account for every part of the check exactly once";
  // The obligations are the plane's, sealed before the run: the typecheck and build always, and every part it owed.
  const owed = new Set<CheckPart>(["typecheck", "build", ...inventory.sealed.parts]);
  for (const part of CHECK_PARTS) if (owed.has(part) && parts.get(part)!.selected !== true) return `the report says the ${part} wasn't selected, but the check owed it`;
  for (const part of report.parts) {
    if (!part.selected) continue;
    if (!part.ran || part.code === null) return `${part.part} has no result: it was selected and never ran`;
    if (part.timedOut || part.stopped === true || part.signal != null) return `${part.part} has no result: it was stopped before it finished`;
    if (part.code !== 0) return `${part.part} exited ${part.code}, yet the check exited 0`;
  }
  if (parts.get("unit")!.selected) {
    const units = report.units;
    if (units === null) return "the unit suite reported nothing";
    if (!units.finished) return "the unit suite didn't reach its end";
    if (units.runErrors > 0) return `the unit suite had ${units.runErrors} errors no test owned`;
    if (units.files.some(one => one.state === "failed")) return "a unit file failed, yet the check exited 0";
    if (units.reusedFromCI && inventory.sealed.ciSubstitute !== true) return "CI's run stood in for the unit suite, which this check's sealed plan doesn't allow";
    if (!units.reusedFromCI) {
      const reported = new Set(units.files.map(one => one.file));
      const missing = inventory.sealed.units.filter(file => !reported.has(file));
      if (missing.length > 0) return `${missing.length} unit file${missing.length === 1 ? " has" : "s have"} no result (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})`;
    }
  }
  for (const label of ["flows", "app", "flows-real", "app-real"] as const) {
    if (!parts.get(label)!.selected) continue;
    const script = label.replace(/-real$/, ""), kind = label.endsWith("-real") ? "real" : "scripted";
    const runs = report.journeys.filter(one => one.script === script && one.kind === kind);
    if (runs.length === 0) return `the ${label} journeys reported nothing`;
    if (runs.length > 1) return `the ${label} journeys reported more than one run`;
    const run = runs[0]!;
    if (!run.finished) return `the ${label} journeys didn't reach their end`;
    if (run.inventoried !== true) return `the ${label} journeys never listed their groups, so what they owed can't be told`;
    const open = run.groups.filter(group => group.state !== "passed");
    if (open.length > 0) return `the ${label} journey group ${open[0]!.group} ${open[0]!.state === "not-run" ? "never ran" : "failed"}, yet the check exited 0`;
    const unread = run.groups.find(group => group.unattributed || !group.journeys.some(one => one.state === "passed"));
    if (unread !== undefined) return `the ${label} journey group ${unread.group} reported no journey's result`;
  }
  if (parts.get("upgrade")!.selected) {
    const upgrades = report.upgrades;
    if (upgrades === null || !upgrades.finished) return "the upgrade path didn't reach its end";
    if (upgrades.inventoried !== true) return "the upgrade path never listed its versions, so what it owed can't be told";
    const open = upgrades.versions.filter(one => one.state !== "passed");
    if (open.length > 0) return `the upgrade from ${open[0]!.version} ${open[0]!.state === "not-run" ? "never ran" : "failed"}, yet the check exited 0`;
  }
  return null;
}
