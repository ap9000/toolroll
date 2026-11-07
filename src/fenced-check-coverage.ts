/**
 * What a sandboxed Full check must show for what it couldn't run (docs/plans/trusted-release-reports.md, H3). Inside a
 * fence some cases skip: a test that makes a sandbox, or a keychain. A skipped case counts as covered only if the SAME
 * case passed in the macOS CI of that exact commit, or it is on the short reviewed list below. Being in the same file
 * isn't enough: a file is in the macOS lane even when its case is skipped there (Codex round 1, finding 6).
 *
 * This reads nothing on an unsandboxed check, which skips nothing for this reason: Toolroll's own releases, today. It
 * guards a release only once a person has narrowed that project's check access, and scripts/fenced-run.mjs has measured
 * it first. Reports are the candidate's own words (R1): this keeps an accident from passing unseen, not a hostile test.
 *
 * The fallback: when a sandboxed check can't cover everything, the release scope seals the wider level the measurement
 * shows it needs. That is an operator's widening, with a password, and a new approval whose card says so: nothing here
 * widens anything, and a release can always go out at the level a person approves.
 */
import type { CheckAccess } from "./check-access.js";
import type { CheckReport } from "./contracts/release-check.js";

/** Cases that may stay skipped with no CI case behind them, each with why. Product code, reviewed like it: never a file a
 * release's commits could carry. Empty until a measured run gives a reason. */
export const FENCED_SKIP_EXEMPTIONS: readonly { identity: string; why: string }[] = Object.freeze([]);

export const unitCaseIdentity = (file: string, name: string): string => `unit:${file}::${name}`;

type VitestAssertion = { title?: unknown; ancestorTitles?: unknown; status?: unknown };
type VitestReport = { testResults?: { name?: unknown; assertionResults?: VitestAssertion[] }[] };

/**
 * Every case in the macOS CI's reports, by the identity the release check's own reporter gives it (test/release-reporter.ts:
 * `suite > test`; Vitest's JSON `fullName` joins with spaces, so it can't be matched as it stands). A name twice in a file
 * passes only if every one of them did. `root` is the checkout the reports name files under.
 */
export function macosCases(reports: readonly VitestReport[], root: string): Map<string, boolean> {
  const cases = new Map<string, boolean>();
  for (const report of reports) {
    for (const file of report.testResults ?? []) {
      if (typeof file.name !== "string" || !file.name.startsWith(`${root}/`)) continue;
      const relative = file.name.slice(root.length + 1);
      for (const one of file.assertionResults ?? []) {
        if (typeof one.title !== "string") continue;
        const ancestors = Array.isArray(one.ancestorTitles) ? one.ancestorTitles.filter((title): title is string => typeof title === "string" && title !== "") : [];
        const identity = unitCaseIdentity(relative, [...ancestors, one.title].join(" > "));
        cases.set(identity, (cases.get(identity) ?? true) && one.status === "passed");
      }
    }
  }
  return cases;
}

/** Every case a check's report says it skipped: unit cases and journeys alike. */
export function skippedCases(report: CheckReport): string[] {
  const units = (report.units?.identities ?? []).filter(one => one.state === "skipped").map(one => unitCaseIdentity(one.file, one.name));
  const journeys = report.journeys.flatMap(run => run.groups.flatMap(group => group.journeys.filter(one => one.state === "skipped").map(one => `journey:${run.script}:${run.kind}:${group.group}::${one.name}`)));
  return [...new Set([...units, ...journeys])].sort();
}

export type SkipCoverage = { covered: string[]; exempt: string[]; uncovered: string[] };

/** Each skipped case: passed in that commit's macOS CI, reviewed as exempt, or not covered. */
export function skipCoverage(skipped: readonly string[], macos: ReadonlyMap<string, boolean>, exemptions: readonly { identity: string }[] = FENCED_SKIP_EXEMPTIONS): SkipCoverage {
  const reviewed = new Set(exemptions.map(one => one.identity));
  const result: SkipCoverage = { covered: [], exempt: [], uncovered: [] };
  for (const identity of skipped) (macos.get(identity) === true ? result.covered : reviewed.has(identity) ? result.exempt : result.uncovered).push(identity);
  return result;
}

/** A measurement's verdict on one level (scripts/fenced-run.mjs): whether the check passed there, and what it left uncovered. */
export type LevelMeasurement = { level: CheckAccess; passed: boolean; uncovered: number };

/** The narrowest level a measured check fully covers. No level covered: `unsandboxed`, as today, with a person's yes. */
export function measuredLevel(measurements: readonly LevelMeasurement[]): CheckAccess {
  for (const level of ["sandboxed", "sign-ins"] as const) if (measurements.some(one => one.level === level && one.passed && one.uncovered === 0)) return level;
  return "unsandboxed";
}

/** Why a sandboxed check can't stand for this release, in words a person can act on. */
export function uncoveredWords(uncovered: readonly string[]): string {
  const named = uncovered.slice(0, 5).map(one => one.replace(/^unit:/, "")).join("; ");
  return `${uncovered.length} ${uncovered.length === 1 ? "case" : "cases"} skipped inside the sandbox ${uncovered.length === 1 ? "isn't" : "aren't"} covered by this commit's macOS CI (${named}${uncovered.length > 5 ? "; and more" : ""}). `
    + "Widen the project's check access (`toolroll project check-access`, which takes a password) and approve the release again at that level";
}
