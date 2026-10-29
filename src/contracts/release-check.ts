/**
 * The release check's structured results (docs/plans/release-once.md, parts 2 and 3): what the orchestrator
 * (`scripts/release-check.mjs`) reports on its last stdout line, what the plane seals before and after a check runs
 * (the inventory, the execution context, a targeted plan and its obligation snapshot), and the identities every one of
 * them names. Only the plane writes the sealed payloads, from typed values; the report comes from the check itself and
 * is read strictly — anything that doesn't match is no report.
 *
 * Coverage trusts test code (Alex, 2026-10-25): a test runs as the same user as the harness, so these results guard
 * against accidental damage — stray processes, leftover files, output that looks like a report — not a hostile test.
 * Authority decisions never read them.
 */

import { z } from "zod";
import { readVersioned, versioned, type ContractResult } from "./contract.js";

/** The parts a release check is made of. */
export const CHECK_PARTS = ["typecheck", "build", "unit", "flows", "app", "flows-real", "app-real", "upgrade"] as const;
export type CheckPart = typeof CHECK_PARTS[number];
export const JOURNEY_SCRIPTS = ["app", "flows"] as const;
export type JourneyScript = typeof JOURNEY_SCRIPTS[number];

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
/** A repository path as a tree names it: relative, normalized, no control characters. */
const repoPath = z.string().min(1).max(512).regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\u0000-\u001f\\]+$/);
const name = z.string().min(1).max(2000);
const groupName = z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/);
const versionName = z.string().regex(/^\d+\.\d+\.\d+$/);
const count = z.int().min(0).max(1_000_000);

/** What the orchestrator reports, as the last line of its output: `TOOLROLL_CHECK_REPORT <json>`, at most 256 KiB. */
export const CHECK_REPORT_PREFIX = "TOOLROLL_CHECK_REPORT ";
export const CHECK_REPORT_MAX_BYTES = 256 * 1024;

export const checkReportSchema = versioned(1, {
  /** The nonce the plane wrote on the check's stdin: the report is this run's. */
  nonce: hex64,
  mode: z.enum(["full", "targeted"]),
  /** The digest of the targeted plan the orchestrator ran, as it received it; null for a full check. */
  planDigest: hex64.nullable(),
  /** The orchestrator's own exit code. */
  exitCode: z.int().min(0).max(255),
  parts: z.array(z.strictObject({
    part: z.enum(CHECK_PARTS),
    selected: z.boolean(),
    ran: z.boolean(),
    code: z.int().min(0).max(255).nullable(),
    timedOut: z.boolean(),
    /** When it started, the signal that ended it, whether the check stopped it (another part's failure or the check's
     * own limit) and whether it could start at all — each apart from its code. Absent from an older orchestrator. */
    startedAt: z.string().max(40).nullable().optional(),
    signal: z.string().max(20).nullable().optional(),
    stopped: z.boolean().optional(),
    spawnFailed: z.boolean().optional(),
  })).max(CHECK_PARTS.length),
  /** The unit suite, from the Vitest main process's fd-3 lines: every file's outcome, and the identities that failed,
   * were skipped, passed on a retry or were asked about. Null when the unit part didn't run. */
  units: z.strictObject({
    reusedFromCI: z.boolean(),
    /** Vitest reached the end of its run and said so. */
    finished: z.boolean(),
    /** Errors no test owned (an unhandled rejection, a worker crash). */
    runErrors: count,
    files: z.array(z.strictObject({
      file: repoPath,
      state: z.enum(["passed", "failed", "skipped"]),
      passed: count, failed: count, skipped: count,
      flaky: z.boolean(),
    })).max(5000),
    identities: z.array(z.strictObject({
      file: repoPath,
      name,
      state: z.enum(["passed", "failed", "skipped"]),
      flaky: z.boolean(),
    })).max(5000),
  }).nullable(),
  /** Each journey script's run: the groups it ran and every journey's outcome in each. */
  journeys: z.array(z.strictObject({
    script: z.enum(JOURNEY_SCRIPTS),
    kind: z.enum(["scripted", "real"]),
    finished: z.boolean(),
    /** The runner listed its groups before any started (an empty list is an explicit "none of this kind"); absent or
     * false, the run has no inventory and nothing it lacks can be told from nothing it owed. */
    inventoried: z.boolean().optional(),
    groups: z.array(z.strictObject({
      group: groupName,
      state: z.enum(["passed", "failed", "not-run"]),
      /** Passed only on the runner's retry. */
      retried: z.boolean(),
      /** It ended with no result line to read, or only the browser-error check failed. */
      unattributed: z.boolean(),
      journeys: z.array(z.strictObject({ name, state: z.enum(["passed", "failed", "skipped"]) })).max(500),
    })).max(200),
  })).max(4),
  upgrades: z.strictObject({
    finished: z.boolean(),
    /** The upgrade path listed its versions before any ran. */
    inventoried: z.boolean().optional(),
    versions: z.array(z.strictObject({ version: versionName, state: z.enum(["passed", "failed", "not-run"]) })).max(500),
  }).nullable(),
});
export type CheckReport = z.infer<typeof checkReportSchema>;

export function readCheckReport(input: unknown): ContractResult<CheckReport> {
  return readVersioned(checkReportSchema, input);
}

/** What a check must account for, sealed before it runs: the unit files (from the verified tree and Vitest's include
 * globs) and the parts selected. The journey groups and upgrade versions come from the check's own report and are
 * sealed beside these after it ran. */
export const checkInventorySchema = versioned(1, {
  units: z.array(repoPath).max(20_000),
  /** The parts the check owes. For a full check the plane decides them before it runs (check-report.ts
   * fullObligationsOf) and they ride on the handshake; every one needs an outcome. */
  parts: z.array(z.enum(CHECK_PARTS)).max(CHECK_PARTS.length),
  /** Whether CI's run of the exact commit may stand in for the local unit suite. Absent is no. */
  ciSubstitute: z.boolean().optional(),
});
export type CheckInventory = z.infer<typeof checkInventorySchema>;

/** The sealed inventory artifact: what was sealed before the run, and what the run declared. */
export const sealedInventorySchema = versioned(1, {
  sealed: checkInventorySchema,
  declared: z.strictObject({
    groups: z.array(z.strictObject({ script: z.enum(JOURNEY_SCRIPTS), kind: z.enum(["scripted", "real"]), groups: z.array(groupName).max(200) })).max(4),
    versions: z.array(versionName).max(500),
  }),
});
export type SealedInventory = z.infer<typeof sealedInventorySchema>;

/** Where a check ran: what has to match for an earlier result to stand beside a later one. */
export const checkContextSchema = versioned(1, {
  node: z.string().max(40),
  platform: z.string().max(40),
  arch: z.string().max(40),
  /** The verified blob id of package-lock.json, or null when the tree has none. */
  lockfile: z.string().max(64).nullable(),
  /** One digest over every harness file's verified blob id. */
  harness: hex64,
  grant: z.strictObject({ id: z.int(), digest: z.string().max(128) }),
  access: z.string().max(40),
});
export type CheckContext = z.infer<typeof checkContextSchema>;

/** A targeted check's plan: exactly what it runs, sealed before it runs. */
export const targetedPlanSchema = versioned(1, {
  /** The full check A whose sealed evidence every obligation comes from. */
  base: z.int().min(1),
  units: z.array(repoPath).max(5000),
  sanity: z.array(repoPath).max(200),
  groups: z.array(z.strictObject({ script: z.enum(JOURNEY_SCRIPTS), kind: z.enum(["scripted", "real"]), groups: z.array(groupName).max(200) })).max(4),
  versions: z.array(versionName).max(500),
  /** Whole parts to run again (a part-level outcome at A). */
  parts: z.array(z.enum(CHECK_PARTS)).max(CHECK_PARTS.length),
  /** The required identities: each must be reported, and pass. */
  required: z.array(z.string().min(1).max(2600)).max(5000),
});
export type TargetedPlan = z.infer<typeof targetedPlanSchema>;

/** The earlier targeted runs of this generation a targeted attempt took into account, sealed with it. */
export const obligationSnapshotSchema = versioned(1, {
  authority: z.int().min(1),
  base: z.int().min(1),
  earlier: z.array(z.strictObject({ run: z.int().min(1), reportDigest: z.string().max(64).nullable(), failed: z.array(z.string().min(1).max(2600)).max(5000) })).max(200),
});
export type ObligationSnapshot = z.infer<typeof obligationSnapshotSchema>;

/** What the plane writes on the check's stdin before closing it. */
export type CheckHandshake = { nonce: string; mode: "full" | "targeted"; plan: TargetedPlan | null; watch: string[]; owed?: CheckPart[]; ciSubstitute?: boolean };

// ------------------------------------------------------------------ identities

/** A unit test: its file and full name. */
export const unitIdentity = (file: string, testName: string) => `unit:${file}::${testName}`;
/** A unit file. */
export const fileIdentity = (file: string) => `file:${file}`;
/** A journey group of a script and kind. */
export const groupIdentity = (script: string, kind: string, group: string) => `group:${script}:${kind}:${group}`;
/** One journey in its group. */
export const journeyIdentity = (script: string, kind: string, group: string, journey: string) => `journey:${script}:${kind}:${group}::${journey}`;
/** An upgrade version. */
export const versionIdentity = (version: string) => `upgrade:${version}`;
/** A whole part. */
export const partIdentity = (part: string) => `part:${part}`;

/** One fd-3 result line a harness process writes (test/release-reporter.ts, scripts/check-results.mjs). The
 * orchestrator reads only these shapes; anything else on the pipe is passed over. */
export const checkResultLineSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unit-case"), file: repoPath, name, state: z.enum(["passed", "failed", "skipped"]), flaky: z.boolean() }),
  z.strictObject({ kind: z.literal("unit-file"), file: repoPath, state: z.enum(["passed", "failed", "skipped"]), passed: count, failed: count, skipped: count, flaky: z.boolean() }),
  z.strictObject({ kind: z.literal("unit-end"), reason: z.string().max(40), errors: count }),
  z.strictObject({ kind: z.literal("journey-inventory"), script: z.enum(JOURNEY_SCRIPTS), journeys: z.string().max(20), groups: z.array(groupName).max(200) }),
  z.strictObject({ kind: z.literal("journey"), name, state: z.enum(["passed", "failed", "skipped"]) }),
  z.strictObject({ kind: z.literal("journey-end"), script: z.enum(JOURNEY_SCRIPTS).optional(), journeys: z.string().max(20).optional(), browserCheck: z.string().nullable().optional(), unstopped: z.boolean().optional(), catalogue: count.optional() }),
  z.strictObject({ kind: z.literal("journey-group"), script: z.enum(JOURNEY_SCRIPTS), journeys: z.string().max(20), group: groupName, state: z.enum(["passed", "failed", "not-run"]), retried: z.boolean(), unattributed: z.boolean(),
    results: z.array(z.strictObject({ name, state: z.enum(["passed", "failed", "skipped"]) })).max(500) }),
  z.strictObject({ kind: z.literal("upgrade-inventory"), versions: z.array(versionName).max(500) }),
  z.strictObject({ kind: z.literal("upgrade-version"), version: versionName, state: z.enum(["passed", "failed", "not-run"]) }),
  z.strictObject({ kind: z.literal("upgrade-end") }),
]);
