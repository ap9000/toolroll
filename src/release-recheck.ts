/**
 * Re-running only what failed, by file (docs/plans/release-once.md, part 2).
 *
 * On the second and later checks of a release generation, a check runs only what failed at the newest FULL check A of
 * that generation — the failed unit files, the failed journey groups, the failed upgrade versions — plus every test
 * changed since A and a sanity pass; never the whole suite.
 *
 * - Every outcome at A has a disposition (requiredSet): a passed, unchanged item carries from A; a failed or flaky one
 *   re-runs (each failed identity must pass); a part whose results can't be attributed (it stopped, it never said, a
 *   worker crashed, only the browser-error check failed) re-runs whole; a failed typecheck or build means a full check.
 * - Obligations are immutable: R(A) comes only from A's sealed evidence. Each targeted attempt seals an obligation
 *   snapshot of the earlier targeted runs it took into account and what failed in them; a targeted run C runs R(A),
 *   every identity that failed in the snapshot, every test changed since A and the sanity pass — never borrowing
 *   coverage from an earlier targeted run.
 * - Coverage is conserved (coverageOf): every item of the new run's inventory has either an eligible pass at A and is
 *   unchanged, or a qualifying pass now; otherwise the result is `partial`, which never passes. A required identity
 *   that is gone or newly skipped — in a targeted run or in the full run after it — is `identity-removed`: the release
 *   stops carrying and a person approves it again.
 *
 * Coverage trusts test code (Alex, 2026-10-25): these results protect against accidental damage, not a hostile test.
 * Authority never reads them; the release's own records do.
 */
import { CHECK_CONTEXT_CAPTURE, CHECK_INVENTORY_CAPTURE, CHECK_REPORT_CAPTURE, OBLIGATION_SNAPSHOT_CAPTURE, TARGETED_PLAN_CAPTURE, checkContextOf, fullCheckProblem, isUnitFile, payloadDigest, projectGitDir, readSealedJson, treeFactsOf } from "./check-report.js";
import { readVerifiedCommit, verifiedTreeDiff } from "./commit-extract.js";
import {
  checkContextSchema, fileIdentity, groupIdentity, journeyIdentity, obligationSnapshotSchema, readCheckReport, sealedInventorySchema, targetedPlanSchema, unitIdentity, versionIdentity,
  type CheckContext, type CheckPart, type CheckReport, type ObligationSnapshot, type SealedInventory, type TargetedPlan,
} from "./contracts/release-check.js";
import { parseContract } from "./contracts/contract.js";
import { releaseAuthority, releaseAuthorityOfTask, releaseCarries } from "./release-authority.js";
import { liveReleaseOf, releaseCheckScope } from "./scope.js";
import { checkAttemptOf, type CheckAttempt, type Store, type VerifyCommand } from "./store.js";

/** The sanity pass every targeted check runs beside its plan: a few fast tests of the core rules, when the tree has them. */
export const SANITY_UNITS: readonly string[] = Object.freeze(["src/scope.test.ts", "src/contract.test.ts", "src/check-report.test.ts", "src/update-safe-migrations.test.ts"]);

/** A run's sealed check evidence, read back and verified (check-report.ts). */
export type SealedRun = {
  run: number;
  attempt: CheckAttempt;
  report: CheckReport | null;
  reportDigest: string | null;
  inventory: SealedInventory | null;
  context: CheckContext | null;
  plan: TargetedPlan | null;
  planDigest: string | null;
  snapshot: ObligationSnapshot | null;
  snapshotDigest: string | null;
};

export function sealedRun(store: Store, root: string, run: number): SealedRun | null {
  const attempt = checkAttemptOf(store, run);
  if (attempt === null) return null;
  const read = <T>(capture: string, parse: (value: unknown) => T | null): { value: T | null; digest: string | null } => {
    const sealed = readSealedJson(store, root, run, capture);
    if (sealed === null) return { value: null, digest: null };
    return { value: parse(sealed.value), digest: sealed.digest };
  };
  const report = read(CHECK_REPORT_CAPTURE, value => { const r = readCheckReport(value); return r.ok ? r.value : null; });
  const inventory = read(CHECK_INVENTORY_CAPTURE, value => { const r = parseContract(sealedInventorySchema, value); return r.ok ? r.value : null; });
  const context = read(CHECK_CONTEXT_CAPTURE, value => { const r = parseContract(checkContextSchema, value); return r.ok ? r.value : null; });
  const plan = read(TARGETED_PLAN_CAPTURE, value => { const r = parseContract(targetedPlanSchema, value); return r.ok ? r.value : null; });
  const snapshot = read(OBLIGATION_SNAPSHOT_CAPTURE, value => { const r = parseContract(obligationSnapshotSchema, value); return r.ok ? r.value : null; });
  return { run, attempt, report: report.value, reportDigest: report.value === null ? null : report.digest, inventory: inventory.value, context: context.value,
    plan: plan.value, planDigest: plan.value === null ? null : payloadDigest(plan.value), snapshot: snapshot.value, snapshotDigest: snapshot.value === null ? null : payloadDigest(snapshot.value) };
}

const label = (script: string, kind: string) => kind === "real" ? `${script}-real` : script;
const JOURNEY_PARTS: readonly { label: CheckPart; script: "app" | "flows"; kind: "scripted" | "real" }[] = [
  { label: "flows", script: "flows", kind: "scripted" }, { label: "app", script: "app", kind: "scripted" },
  { label: "flows-real", script: "flows", kind: "real" }, { label: "app-real", script: "app", kind: "real" },
];

/** R(A): what a later check must run again, from A's sealed evidence alone — or why only a full check will do. */
export type Obligations = {
  full: string | null;
  units: string[];
  parts: CheckPart[];
  groups: { script: "app" | "flows"; kind: "scripted" | "real"; groups: string[] }[];
  versions: string[];
  /** The identities that have to be reported, and pass. */
  required: string[];
  /** Identities skipped at A: they may stay skipped. */
  skipped: string[];
};

/** The disposition of every outcome at A (the table in the plan). */
export function requiredSet(a: { report: CheckReport | null; inventory: SealedInventory | null }): Obligations {
  const none = (full: string): Obligations => ({ full, units: [], parts: [], groups: [], versions: [], required: [], skipped: [] });
  const report = a.report, inventory = a.inventory;
  if (report === null) return none("the full check gave no report");
  if (inventory === null) return none("the full check's inventory can't be read");
  const part = (name: CheckPart) => report.parts.find(one => one.part === name);
  for (const name of ["typecheck", "build"] as const) {
    const one = part(name);
    if (one === undefined || !one.ran || one.code !== 0) return none(`the ${name} failed`);
  }
  const units = new Set<string>(), parts = new Set<CheckPart>(), versions = new Set<string>(), required = new Set<string>(), skipped = new Set<string>();
  const groups = new Map<string, { script: "app" | "flows"; kind: "scripted" | "real"; groups: Set<string> }>();
  // Units.
  const unitPart = part("unit");
  if (unitPart?.selected === true) {
    const u = report.units;
    if (u === null || !unitPart.ran || u.reusedFromCI || !u.finished || u.runErrors > 0) parts.add("unit");
    else {
      const byFile = new Map(u.files.map(one => [one.file, one]));
      // Stopped or not run: an inventory file with no outcome re-runs the whole part.
      if (inventory.sealed.units.some(file => !byFile.has(file))) parts.add("unit");
      for (const file of u.files) {
        const failedHere = u.identities.filter(one => one.file === file.file && one.state === "failed");
        if (file.state === "failed") {
          units.add(file.file);
          if (failedHere.length === 0) required.add(fileIdentity(file.file));
          for (const one of failedHere) required.add(unitIdentity(one.file, one.name));
        }
        if (file.flaky) units.add(file.file);
      }
      for (const one of u.identities) {
        if (one.state === "skipped") skipped.add(unitIdentity(one.file, one.name));
        if (one.flaky) units.add(one.file);
      }
    }
  }
  // Journeys: whole groups.
  for (const lane of JOURNEY_PARTS) {
    const selected = part(lane.label);
    if (selected?.selected !== true) continue;
    const run = report.journeys.find(one => one.script === lane.script && one.kind === lane.kind);
    if (!selected.ran || run === undefined || !run.finished || run.groups.some(one => one.state === "not-run")) { parts.add(lane.label); continue; }
    for (const group of run.groups) {
      for (const journey of group.journeys) if (journey.state === "skipped") skipped.add(journeyIdentity(lane.script, lane.kind, group.group, journey.name));
      if (group.state === "passed" && !group.retried && !group.unattributed) continue;
      const key = `${lane.script}:${lane.kind}`;
      const entry = groups.get(key) ?? { script: lane.script, kind: lane.kind, groups: new Set<string>() };
      entry.groups.add(group.group);
      groups.set(key, entry);
      required.add(groupIdentity(lane.script, lane.kind, group.group));
      for (const journey of group.journeys) if (journey.state === "failed") required.add(journeyIdentity(lane.script, lane.kind, group.group, journey.name));
    }
  }
  // Upgrades: whole versions.
  const upgradePart = part("upgrade");
  if (upgradePart?.selected === true) {
    if (!upgradePart.ran || report.upgrades === null || !report.upgrades.finished) parts.add("upgrade");
    else for (const one of report.upgrades.versions) if (one.state !== "passed") { versions.add(one.version); required.add(versionIdentity(one.version)); }
  }
  return {
    full: null, units: [...units].sort(), parts: [...parts].sort(), versions: [...versions].sort(), required: [...required].sort(), skipped: [...skipped].sort(),
    groups: [...groups.values()].map(one => ({ script: one.script, kind: one.kind, groups: [...one.groups].sort() })),
  };
}

/** The identities that failed in one run's sealed report (for an obligation snapshot). */
export function failedIdentities(report: CheckReport | null): string[] {
  if (report === null) return [];
  const out = new Set<string>();
  for (const one of report.units?.identities ?? []) if (one.state === "failed") out.add(unitIdentity(one.file, one.name));
  for (const file of report.units?.files ?? []) if (file.state === "failed" && !(report.units?.identities ?? []).some(one => one.file === file.file && one.state === "failed")) out.add(fileIdentity(file.file));
  for (const run of report.journeys) for (const group of run.groups) {
    if (group.state === "failed" || group.unattributed) out.add(groupIdentity(run.script, run.kind, group.group));
    for (const journey of group.journeys) if (journey.state === "failed") out.add(journeyIdentity(run.script, run.kind, group.group, journey.name));
  }
  for (const one of report.upgrades?.versions ?? []) if (one.state === "failed") out.add(versionIdentity(one.version));
  return [...out].sort();
}

/** The base A of a generation: the newest run with intended mode full before `before`, if it can be one. */
function baseOf(store: Store, root: string, authority: number, before: number): { base: SealedRun; obligations: Obligations } | { problem: string } {
  const row = store.handle.prepare("SELECT run FROM release_check_attempt WHERE authority = ? AND mode = 'full' AND run < ? ORDER BY run DESC LIMIT 1").get(authority, before);
  if (row === undefined) return { problem: "this release has no full check to start from" };
  const base = sealedRun(store, root, Number(row["run"]));
  if (base === null || base.report === null) return { problem: "the last full check of this release gave no report" };
  if (base.report.mode !== "full" || base.report.units?.reusedFromCI === true) return { problem: "the last full check reused CI results, so it can't be a base" };
  const obligations = requiredSet(base);
  if (obligations.full !== null) return { problem: obligations.full };
  return { base, obligations };
}

/** The earlier targeted runs of this generation after A, with their sealed report digests and what failed in them. */
export function obligationSnapshot(store: Store, root: string, authority: number, base: number, before: number): ObligationSnapshot {
  const rows = store.handle.prepare("SELECT run FROM release_check_attempt WHERE authority = ? AND mode = 'targeted' AND run > ? AND run < ? ORDER BY run").all(authority, base, before);
  return { version: 1, authority, base, earlier: rows.map(row => {
    const sealed = sealedRun(store, root, Number(row["run"]));
    // A targeted run with no readable report proves nothing passed: everything it was asked to run stays owed.
    const failed = sealed?.report == null ? [...(sealed?.plan?.required ?? [])] : failedIdentities(sealed.report);
    return { run: Number(row["run"]), reportDigest: sealed?.reportDigest ?? null, failed };
  }) };
}

/** The plan a targeted run runs: R(A), the snapshot's failures, every test changed since A, and the sanity pass. */
export function planFrom(base: number, obligations: Obligations, snapshot: ObligationSnapshot, changed: readonly string[], units: readonly string[], journeysRan: readonly CheckPart[]): TargetedPlan {
  const files = new Set(obligations.units);
  const parts = new Set(obligations.parts);
  const groups = new Map(obligations.groups.map(one => [`${one.script}:${one.kind}`, { ...one, groups: new Set(one.groups) }]));
  const versions = new Set(obligations.versions);
  const required = new Set(obligations.required);
  for (const earlier of snapshot.earlier) for (const identity of earlier.failed) {
    required.add(identity);
    const unit = /^unit:(.+?)::/.exec(identity)?.[1] ?? /^file:(.+)$/.exec(identity)?.[1];
    if (unit !== undefined) files.add(unit);
    const group = /^(?:group|journey):(app|flows):(scripted|real):([^:]+?)(?:::|$)/.exec(identity);
    if (group !== null) {
      const key = `${group[1]}:${group[2]}`;
      const entry = groups.get(key) ?? { script: group[1] as "app" | "flows", kind: group[2] as "scripted" | "real", groups: new Set<string>() };
      entry.groups.add(group[3]!);
      groups.set(key, entry);
    }
    const version = /^upgrade:(.+)$/.exec(identity)?.[1];
    if (version !== undefined) versions.add(version);
  }
  for (const path of changed) {
    if (isUnitFile(path)) files.add(path);
    // A changed journey script runs all its groups again: its whole part, as A ran it.
    if (path === "scripts/app-e2e.mjs" || path === "scripts/flows-e2e.mjs") {
      const script = path.includes("app") ? "app" : "flows";
      for (const lane of JOURNEY_PARTS) if (lane.script === script && journeysRan.includes(lane.label)) parts.add(lane.label);
    }
  }
  return {
    version: 1, base, units: [...files].filter(file => units.includes(file)).sort(), sanity: SANITY_UNITS.filter(file => units.includes(file) && !files.has(file)),
    groups: [...groups.values()].filter(one => !parts.has(label(one.script, one.kind) as CheckPart)).map(one => ({ script: one.script, kind: one.kind, groups: [...one.groups].sort() })),
    versions: parts.has("upgrade") ? [] : [...versions].sort(), parts: [...parts].sort(), required: [...required].sort(),
  };
}

export type RecheckDecision =
  | { mode: "targeted"; authority: number; plan: TargetedPlan; snapshot: ObligationSnapshot; watch: string[] }
  | { mode: "full"; authority: number | null; why: string; watch: string[] };

/**
 * Whether the check about to run for this release task may be targeted (planTargetedRecheck): only when A and this run
 * are gate tasks of the same current generation, A is the generation's newest full check with a valid report that
 * accounts for every item and reused nothing from CI, everything since A is test-only (the carry proved it), the
 * execution context matches A's, and no main-check failure is open. Otherwise a full check, told which identities it
 * must still report (watch).
 */
export function planTargetedRecheck(store: Store, root: string, input: { runId: number; taskId: string; repo: string; head: string; command: VerifyCommand; access: string; now: Date }): RecheckDecision {
  // The nightly's open failures are reported by name by every full check, so a pass can clear exactly them.
  const mainOpen = store.handle.prepare("SELECT DISTINCT item FROM main_check_failure WHERE repo = ? AND cleared_at IS NULL").all(input.repo).map(row => String(row["item"]));
  const found = releaseAuthorityOfTask(store, input.taskId);
  if (found === null) return { mode: "full", authority: null, why: "not a release task", watch: mainOpen.sort() };
  const a = found.authority;
  const owed = owedIdentities(store, root, a.id, input.runId);
  const full = (why: string, watch: string[] = []): RecheckDecision => ({ mode: "full", authority: a.id, why, watch: [...new Set([...watch, ...owed, ...mainOpen])].sort() });
  const live = liveReleaseOf(store, input.taskId, "dispatch", input.now);
  if (!live.applies || !live.ok) return full("the release approval doesn't stand");
  const based = baseOf(store, root, a.id, input.runId);
  if ("problem" in based) return full(based.problem);
  const { base, obligations } = based;
  const snapshot = obligationSnapshot(store, root, a.id, base.run, input.runId);
  const watch = [...new Set([...obligations.required, ...snapshot.earlier.flatMap(one => one.failed)])].sort();
  const open = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM main_check_failure WHERE repo = ? AND cleared_at IS NULL").get(a.repo)?.["n"] ?? 0);
  if (open > 0) return full("the nightly full check on main has open failures", watch);
  if (base.context === null || base.inventory === null) return full("the last full check's context can't be read", watch);
  // Everything since A, read from verified objects: only tests may differ (a carry proved the rest).
  const gitDir = projectGitDir(input.repo);
  const baseHead = store.getRun(base.run)?.headRevision ?? null;
  if (gitDir === null || baseHead === null) return full("the release's commits can't be read", watch);
  const from = readVerifiedCommit(gitDir, baseHead), to = readVerifiedCommit(gitDir, input.head);
  if (!from.ok || !to.ok) return full("the release's commits can't be read", watch);
  const diff = verifiedTreeDiff(gitDir, from.value.tree, to.value.tree);
  if (!diff.ok) return full("the change since the last full check can't be read", watch);
  const changed = diff.value.map(one => one.path);
  if (diff.value.some(one => one.kind === "deleted" || one.binary)) return full("a file was removed since the last full check", watch);
  if (changed.some(path => !(isUnitFile(path) || path === "scripts/app-e2e.mjs" || path === "scripts/flows-e2e.mjs" || path.endsWith(".md")))) return full("more than tests changed since the last full check", watch);
  if (found.carry === null && input.taskId !== a.anchorTask) return full("this task isn't part of the release", watch);
  // The context must match A's exactly (the harness digest leaves the tests themselves out).
  const facts = treeFactsOf(gitDir, input.head);
  if (!facts.ok) return full("this commit can't be read", watch);
  if (payloadDigest(checkContextOf(facts.facts, input.command, input.access)) !== payloadDigest(base.context)) return full("the check runs somewhere other than the last full check did", watch);
  if (base.inventory.sealed.units.some(file => !facts.facts.units.includes(file))) return full("a unit file the last full check had is gone", watch);
  const journeysRan = base.report!.parts.filter(one => one.ran).map(one => one.part);
  const plan = planFrom(base.run, { ...obligations, required: [...new Set([...obligations.required, ...owed])].sort(),
    units: [...new Set([...obligations.units, ...owed.flatMap(id => /^unit:(.+?)::/.exec(id)?.[1] ?? /^file:(.+)$/.exec(id)?.[1] ?? [])])].sort() }, snapshot, changed, facts.facts.units, journeysRan);
  return { mode: "targeted", authority: a.id, plan, snapshot, watch: plan.required };
}

/** Coverage of a check: full, composed from A, partial (never passes), or identity-removed (asks again). */
export type Coverage = "full" | "composed" | "partial" | "identity-removed" | "no-result";

/**
 * Whether a targeted run B, with A's sealed evidence, its plan and snapshot, covers every item of B's inventory
 * (coverage conservation), and every required identity passed — re-derived from sealed values only.
 */
export function coverageOf(input: { a: { report: CheckReport; inventory: SealedInventory }; b: { report: CheckReport | null; inventory: SealedInventory | null; exitCode: number | null }; plan: TargetedPlan; snapshot: ObligationSnapshot }): Coverage {
  const { a, b, plan, snapshot } = input;
  const obligations = requiredSet(a);
  if (obligations.full !== null) return "partial";
  // The plan holds everything A and the snapshot owe: a plan that leaves one out is no plan for this base.
  const owed = new Set([...obligations.required, ...snapshot.earlier.flatMap(one => one.failed)]);
  if ([...owed].some(identity => !plan.required.includes(identity))) return "partial";
  if (obligations.units.some(file => !plan.units.includes(file)) || obligations.parts.some(part => !plan.parts.includes(part))) return "partial";
  if (b.report === null || b.inventory === null || b.report.mode !== "targeted" || b.report.planDigest !== payloadDigest(plan)) return "partial";
  const report = b.report;
  for (const name of ["typecheck", "build"] as const) { const one = report.parts.find(p => p.part === name); if (one === undefined || !one.ran || one.code !== 0) return "partial"; }
  // Required identities: reported, and passed. Gone, or newly skipped, asks again.
  const passed = new Set<string>(), skippedNow = new Set<string>(), reported = new Set<string>();
  for (const one of report.units?.identities ?? []) { const id = unitIdentity(one.file, one.name); reported.add(id); if (one.state === "passed") passed.add(id); if (one.state === "skipped") skippedNow.add(id); }
  for (const file of report.units?.files ?? []) { reported.add(fileIdentity(file.file)); if (file.state === "passed") passed.add(fileIdentity(file.file)); }
  for (const run of report.journeys) for (const group of run.groups) {
    const gid = groupIdentity(run.script, run.kind, group.group);
    reported.add(gid);
    if (group.state === "passed" && !group.unattributed) passed.add(gid);
    for (const journey of group.journeys) { const id = journeyIdentity(run.script, run.kind, group.group, journey.name); reported.add(id); if (journey.state === "passed") passed.add(id); if (journey.state === "skipped") skippedNow.add(id); }
  }
  for (const one of report.upgrades?.versions ?? []) { reported.add(versionIdentity(one.version)); if (one.state === "passed") passed.add(versionIdentity(one.version)); }
  const ranFiles = new Set((report.units?.files ?? []).map(one => one.file));
  for (const identity of plan.required) {
    const unitFile = /^unit:(.+?)::/.exec(identity)?.[1];
    const ran = unitFile === undefined || ranFiles.has(unitFile);
    if (ran && (!reported.has(identity) || skippedNow.has(identity))) return "identity-removed";
  }
  for (const id of skippedNow) if (!obligations.skipped.includes(id)) return "identity-removed";
  if (plan.required.some(identity => !passed.has(identity))) return "partial";
  if (input.b.exitCode !== 0) return "partial";
  // Every owed whole part ran whole and finished, its inventory complete and every item passed (review round 1).
  for (const owedPart of plan.parts) {
    const ran = report.parts.find(one => one.part === owedPart);
    if (ran === undefined || !ran.ran || ran.code !== 0) return "partial";
    if (owedPart === "unit") {
      const u = report.units;
      if (u === null || u.reusedFromCI || !u.finished || u.runErrors > 0) return "partial";
      const states = new Map(u.files.map(one => [one.file, one.state]));
      if (b.inventory.sealed.units.some(file => states.get(file) === undefined || states.get(file) === "failed")) return "partial";
    } else if (owedPart === "upgrade") {
      const up = report.upgrades;
      if (up === null || !up.finished || up.versions.length === 0 || up.versions.some(one => one.state !== "passed")) return "partial";
      const versions = new Set(up.versions.map(one => one.version));
      if (a.inventory.declared.versions.some(version => !versions.has(version))) return "partial";
    } else if (owedPart !== "typecheck" && owedPart !== "build") {
      const lane = JOURNEY_PARTS.find(one => one.label === owedPart)!;
      const run = report.journeys.find(one => one.script === lane.script && one.kind === lane.kind);
      if (run === undefined || !run.finished || run.groups.length === 0 || run.groups.some(one => one.state !== "passed" || one.unattributed)) return "partial";
      const declared = a.inventory.declared.groups.find(one => one.script === lane.script && one.kind === lane.kind)?.groups ?? [];
      const groups = new Set(run.groups.map(one => one.group));
      if (declared.some(group => !groups.has(group))) return "partial";
    }
  }
  // Conservation, unit files: passed at A (not flaky) and not owed again, or passed here.
  const aFiles = new Map((a.report.units?.files ?? []).map(one => [one.file, one]));
  const bFiles = new Map((report.units?.files ?? []).map(one => [one.file, one]));
  const rerun = new Set([...plan.units, ...plan.sanity]);
  if (a.inventory.sealed.units.some(file => !b.inventory!.sealed.units.includes(file))) return "identity-removed";
  for (const file of b.inventory.sealed.units) {
    const here = bFiles.get(file);
    const before = aFiles.get(file);
    const eligible = !plan.parts.includes("unit") && !rerun.has(file) && before !== undefined && before.state !== "failed" && !before.flaky;
    if (!eligible && !(here !== undefined && here.state !== "failed")) return "partial";
  }
  // Journey groups and upgrade versions: passed at A and not owed, or passed here.
  for (const run of a.report.journeys) for (const group of run.groups) {
    const owedHere = plan.parts.includes(label(run.script, run.kind) as CheckPart) || plan.groups.some(one => one.script === run.script && one.kind === run.kind && one.groups.includes(group.group));
    const passedAtA = group.state === "passed" && !group.retried && !group.unattributed;
    if (owedHere || !passedAtA) { if (!passed.has(groupIdentity(run.script, run.kind, group.group))) return "partial"; }
  }
  for (const one of a.report.upgrades?.versions ?? []) {
    const owedHere = plan.parts.includes("upgrade") || plan.versions.includes(one.version) || one.state !== "passed";
    if (owedHere && !passed.has(versionIdentity(one.version))) return "partial";
  }
  return "composed";
}

/** A full run's own check: a required identity of the generation that is gone or newly skipped. */
export function fullRunRemovedIdentity(report: CheckReport | null, watch: readonly string[], skippedAtBase: readonly string[]): boolean {
  if (report === null || watch.length === 0) return false;
  const reported = new Map<string, string>();
  for (const one of report.units?.identities ?? []) reported.set(unitIdentity(one.file, one.name), one.state);
  for (const file of report.units?.files ?? []) reported.set(fileIdentity(file.file), file.state);
  for (const run of report.journeys) for (const group of run.groups) {
    reported.set(groupIdentity(run.script, run.kind, group.group), group.state);
    for (const journey of group.journeys) reported.set(journeyIdentity(run.script, run.kind, group.group, journey.name), journey.state);
  }
  for (const one of report.upgrades?.versions ?? []) reported.set(versionIdentity(one.version), one.state);
  const ranFiles = new Set((report.units?.files ?? []).map(one => one.file));
  return watch.some(identity => {
    const unitFile = /^unit:(.+?)::/.exec(identity)?.[1];
    if (unitFile !== undefined && !ranFiles.has(unitFile)) return true;
    const state = reported.get(identity);
    return state === undefined || (state === "skipped" && !skippedAtBase.includes(identity));
  });
}

/** What a composed receipt names (receipt version 3): each link is proved again by provedComposition. */
export type ComposedLinks = { base: number; baseReceipt: string; baseReport: string; authority: number; carries: number[]; artifacts: string; plan: string; snapshot: string; report: string };

/**
 * After the check: its coverage, and for a composed one the links its receipt names. An identity-removed result stops
 * the release carrying (a person approves it again). `gateOf` reads a run's verified receipt digest.
 */
export function settleCoverage(store: Store, root: string, input: { runId: number; taskId: string; exitCode: number | null; now: Date }, gateOf: (run: number) => string | null): { coverage: Coverage; composed: ComposedLinks | null } {
  const b = sealedRun(store, root, input.runId);
  if (b === null) return { coverage: "full", composed: null };
  const removed = (): { coverage: Coverage; composed: null } => {
    if (b.attempt.authority !== null) {
      const a = releaseAuthority(store, b.attempt.authority);
      if (a !== null && ["open", "deploying"].includes(a.state)) {
        store.handle.prepare("UPDATE release_authority SET state = 'revoked', ended_at = ?, ended_by = ?, rev = rev + 1 WHERE id = ?").run(input.now.toISOString(), "toolroll: a required test was removed or skipped", a.id);
        store.recordAction({ at: input.now.toISOString(), actor: "toolroll", repo: a.repo, taskId: input.taskId, runId: input.runId, action: "release revoked", outcome: "identity-removed", source: "work",
          detail: `release ${a.id} · run ${input.runId}: a required test was removed, renamed or newly skipped; a person approves this commit` });
      }
    }
    return { coverage: "identity-removed", composed: null };
  };
  if (b.attempt.mode === "full") {
    // The rule on removed or skipped required identities applies to full runs too.
    if (b.attempt.authority !== null) {
      // Owed whatever made the last full check ineligible as a base: a failed typecheck never wipes them.
      const watch = owedIdentities(store, root, b.attempt.authority, input.runId);
      if (fullRunRemovedIdentity(b.report, watch, [])) return removed();
      // Every identity that ever failed in this generation stays protected, passed since or not (review round 2).
      if (removedProtected(b.report, b.inventory, protectedIdentities(store, root, b.attempt.authority, input.runId))) return removed();
    }
    // A release's Full check (its task carries signed release terms, before or after its authority opens — an automatic
    // approval's check runs before) counts only with a complete, valid result (check-report.ts): anything less is no result.
    // A release check purpose (pipeline-speed.md, P0) counts too: a termsless release is held to the same rules.
    const release = b.attempt.authority !== null || releaseCheckScope(store.getScope(input.taskId));
    if (release && fullCheckProblem({ report: b.report, inventory: b.inventory, exitCode: input.exitCode }) !== null) return { coverage: "no-result", composed: null };
    return { coverage: "full", composed: null };
  }
  if (b.plan === null || b.snapshot === null || b.attempt.baseRun === null || b.attempt.authority === null) return { coverage: "partial", composed: null };
  const a = sealedRun(store, root, b.attempt.baseRun);
  if (a === null || a.report === null || a.inventory === null) return { coverage: "partial", composed: null };
  const coverage = coverageOf({ a: { report: a.report, inventory: a.inventory }, b: { report: b.report, inventory: b.inventory, exitCode: input.exitCode }, plan: b.plan, snapshot: b.snapshot });
  if (coverage === "identity-removed") return removed();
  if (removedProtected(b.report, b.inventory, protectedIdentities(store, root, b.attempt.authority, input.runId))) return removed();
  if (coverage !== "composed") return { coverage, composed: null };
  const authority = releaseAuthority(store, b.attempt.authority);
  const baseReceipt = gateOf(a.run);
  if (authority === null || authority.artifactDigest === null || baseReceipt === null || a.reportDigest === null || b.reportDigest === null) return { coverage: "partial", composed: null };
  return { coverage, composed: { base: a.run, baseReceipt, baseReport: a.reportDigest, authority: authority.id, carries: releaseCarries(store, authority.id).filter(one => one.taskId === input.taskId).map(one => one.id),
    artifacts: authority.artifactDigest, plan: b.planDigest!, snapshot: b.snapshotDigest!, report: b.reportDigest } };
}

/**
 * Re-prove every link a composed receipt names, from sealed artifacts and the store: A's receipt and report, this run's
 * plan (re-derived from A's sealed evidence and the sealed snapshot), its snapshot and report, the release's artifact
 * digest on every carry of this task, the generation and the grant. Null when every link holds; else why not.
 */
export function provedComposition(store: Store, root: string, runId: number, links: ComposedLinks, gateOf: (run: number) => string | null, grantOf: (run: number) => string | null): string | null {
  const b = sealedRun(store, root, runId);
  if (b === null || b.attempt.mode !== "targeted" || b.attempt.baseRun !== links.base || b.attempt.authority !== links.authority) return "The composed check's attempt doesn't match its record.";
  if (b.plan === null || b.planDigest !== links.plan || b.attempt.planDigest !== links.plan) return "The composed check's plan changed.";
  if (b.snapshot === null || b.snapshotDigest !== links.snapshot || b.attempt.snapshotDigest !== links.snapshot) return "The composed check's obligation snapshot changed.";
  if (b.reportDigest === null || b.reportDigest !== links.report) return "The composed check's report changed.";
  const a = sealedRun(store, root, links.base);
  if (a === null || a.report === null || a.inventory === null || a.reportDigest !== links.baseReport || a.attempt.authority !== links.authority || a.attempt.mode !== "full") return "The full check it was composed from changed.";
  if (gateOf(links.base) !== links.baseReceipt) return "The full check it was composed from no longer verifies.";
  const authority = releaseAuthority(store, links.authority);
  if (authority === null || authority.artifactDigest !== links.artifacts) return "The release's production build changed.";
  const carries = releaseCarries(store, links.authority).filter(one => links.carries.includes(one.id));
  if (carries.length !== links.carries.length || carries.some(one => one.artifactDigest !== links.artifacts)) return "A carried commit's build doesn't match the release's.";
  if (grantOf(links.base) === null || grantOf(links.base) !== grantOf(runId)) return "The release check command differs from the full check's.";
  const coverage = coverageOf({ a: { report: a.report, inventory: a.inventory }, b: { report: b.report, inventory: b.inventory, exitCode: b.report?.exitCode ?? null }, plan: b.plan, snapshot: b.snapshot });
  if (coverage !== "composed") return "The composed check no longer covers what the full check owed.";
  if (removedProtected(b.report, b.inventory, protectedIdentities(store, root, links.authority, runId))) return "The composed check removed a test that failed earlier in this release.";
  return null;
}

/** The identities a later check of this release still has to run again and pass (the anchor page's obligations). */
export function releaseObligationsOf(store: Store, root: string, authority: number): string[] {
  const newest = store.handle.prepare("SELECT run FROM release_check_attempt WHERE authority = ? ORDER BY run DESC LIMIT 1").get(authority);
  if (newest === undefined) return [];
  const sealed = sealedRun(store, root, Number(newest["run"]));
  if (sealed?.report == null) return [];
  return sealed.report.exitCode === 0 ? [] : failedIdentities(sealed.report);
}

/**
 * The identities a release generation still owes, independent of whether a targeted check is allowed (review round
 * 1): every identity that failed in any of its checks before `before`, until a later check reported it PASSED by name.
 * A failed typecheck or build doesn't wipe them, and a full fallback keeps them: each must be reported again, and a
 * check that drops or newly skips one asks a person again.
 */
export function owedIdentities(store: Store, root: string, authority: number, before: number): string[] {
  const owed = new Set<string>();
  for (const row of store.handle.prepare("SELECT run FROM release_check_attempt WHERE authority = ? AND run < ? ORDER BY run").all(authority, before)) {
    const sealed = sealedRun(store, root, Number(row["run"]));
    const report = sealed?.report ?? null;
    if (report === null) continue;
    for (const identity of passedIdentities(report)) owed.delete(identity);
    for (const identity of failedIdentities(report)) owed.add(identity);
  }
  return [...owed].sort();
}

/**
 * The generation's protected identities (review round 2): every identity that failed in any of its checks before
 * `before`. Never shrinks — a later pass doesn't forgive a later removal: removing, renaming or newly skipping any of
 * them, in any later run of the generation, asks a person again. Separate from what is still owed (owedIdentities).
 */
export function protectedIdentities(store: Store, root: string, authority: number, before: number): string[] {
  const kept = new Set<string>();
  for (const row of store.handle.prepare("SELECT run FROM release_check_attempt WHERE authority = ? AND run < ? ORDER BY run").all(authority, before)) {
    const report = sealedRun(store, root, Number(row["run"]))?.report ?? null;
    if (report !== null) for (const identity of failedIdentities(report)) kept.add(identity);
  }
  return [...kept].sort();
}

/**
 * Whether a run's report removed one of the protected identities: a unit test or journey gone or newly skipped from a
 * file or group the run did report, a unit file gone from its inventory, a group or upgrade version missing from a lane
 * that finished. A lane that didn't run or finish is no pass, so it is judged by the next run that does.
 */
export function removedProtected(report: CheckReport | null, inventory: SealedInventory | null, kept: readonly string[]): boolean {
  if (report === null || kept.length === 0) return false;
  const states = new Map<string, string>();
  for (const one of report.units?.identities ?? []) states.set(unitIdentity(one.file, one.name), one.state);
  const ranFiles = new Set((report.units?.files ?? []).map(one => one.file));
  const units = new Set(inventory?.sealed.units ?? []);
  return kept.some(identity => {
    const unit = /^unit:(.+?)::/.exec(identity);
    if (unit !== null) {
      const file = unit[1]!;
      if (inventory !== null && !units.has(file)) return true;
      if (!ranFiles.has(file)) return false;
      const state = states.get(identity);
      return state === undefined || state === "skipped";
    }
    const file = /^file:(.+)$/.exec(identity)?.[1];
    if (file !== undefined) return inventory !== null && !units.has(file);
    const journey = /^(group|journey):(app|flows):(scripted|real):(.+)$/.exec(identity);
    if (journey !== null) {
      const script = journey[2]!, kind = journey[3]!;
      const run = report.journeys.find(one => one.script === script && one.kind === kind);
      if (run === undefined || !run.finished) return false;
      // A group that ran reports every journey in it; a group missing counts only from a full run (a targeted one
      // runs the groups it owes).
      const group = run.groups.find(one => journey[1] === "group" ? groupIdentity(run.script, run.kind, one.group) === identity : identity.startsWith(`${groupIdentity(run.script, run.kind, one.group)}::`));
      if (group === undefined) return report.mode === "full";
      if (journey[1] === "group") return false;
      const one = group.journeys.find(j => journeyIdentity(run.script, run.kind, group.group, j.name) === identity);
      return one === undefined || one.state === "skipped";
    }
    const version = /^upgrade:(.+)$/.exec(identity)?.[1];
    if (version !== undefined) return report.mode === "full" && report.upgrades !== null && report.upgrades.finished && !report.upgrades.versions.some(one => one.version === version);
    return false;
  });
}

/** The identities a report shows passed by name. */
function passedIdentities(report: CheckReport): string[] {
  const out: string[] = [];
  for (const one of report.units?.identities ?? []) if (one.state === "passed") out.push(unitIdentity(one.file, one.name));
  for (const file of report.units?.files ?? []) if (file.state === "passed" && file.failed === 0) out.push(fileIdentity(file.file));
  for (const run of report.journeys) for (const group of run.groups) {
    if (group.state === "passed" && !group.unattributed) out.push(groupIdentity(run.script, run.kind, group.group));
    for (const journey of group.journeys) if (journey.state === "passed") out.push(journeyIdentity(run.script, run.kind, group.group, journey.name));
  }
  for (const one of report.upgrades?.versions ?? []) if (one.state === "passed") out.push(versionIdentity(one.version));
  return out;
}
