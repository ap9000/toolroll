/**
 * A release scope's terms (docs/plans/release-once.md, part 1): what a person agrees to when they approve a release —
 * the repository (from Toolroll's records), version, head branch, pull request and base, the approved commit and its
 * tree, the effective carry policy, the release check grant, the sealed check access (fenced) and the expiry. Part of
 * the scope digest when present; read strictly, so a row that doesn't match is a stated problem, never authority.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { readVersioned, versioned, type ContractResult } from "./contract.js";

/** The carry rules this runtime knows (release-carry.ts CARRY_RULES). A sealed policy naming any other refuses. */
export const CARRY_RULES_VERSION = 1;

export const releasePolicySchema = versioned(1, {
  rules: z.literal(CARRY_RULES_VERSION),
  /** False: every later commit asks again ("Ask for every release commit", or `toolroll release --no-carry`). */
  carry: z.boolean(),
  /** The project's own protection: everything (protectProject) or these paths, which never carry. */
  protectProject: z.boolean(),
  protectedPaths: z.array(z.string().min(1).max(400)).max(200),
  limits: z.strictObject({ lines: z.int().min(0).max(1_000_000), files: z.int().min(0).max(100_000), churn: z.int().min(0).max(1_000_000) }),
  /** "Carry release approvals when checks aren't sandboxed" (a person's project setting, off by default). Absent (a
   * policy sealed before it existed): off. */
  unsandboxedCarry: z.boolean().optional(),
});
export type ReleasePolicy = z.infer<typeof releasePolicySchema>;

const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const releaseTermsSchema = versioned(1, {
  repo: z.string().min(1).max(4096),
  packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  branch: z.string().min(1).max(255).regex(/^[A-Za-z0-9._/-]+$/),
  pr: z.int().min(1),
  base: z.literal("main"),
  approvedSha: sha,
  approvedTree: sha,
  policy: releasePolicySchema,
  grant: z.strictObject({ id: z.int(), digest: z.string().min(1).max(128) }),
  /** The check access the release check runs with at approval: the fence, or (only with unsandboxedCarry sealed in the
   * policy) a wider one. Never wider later: a check that reaches further than this stops the release. */
  access: z.enum(["sandboxed", "sign-ins", "unsandboxed"]),
  expiresAt: z.iso.datetime(),
});
export type ReleaseTerms = z.infer<typeof releaseTermsSchema>;

export function readReleaseTerms(input: unknown): ContractResult<ReleaseTerms> {
  return readVersioned(releaseTermsSchema, input);
}

export function readReleasePolicy(input: unknown): ContractResult<ReleasePolicy> {
  return readVersioned(releasePolicySchema, input);
}

/** The digest a scope binds for its release terms, domain-separated from every other digest input. */
export function releaseTermsDigest(terms: ReleaseTerms): string {
  return createHash("sha256").update(`release-terms:${JSON.stringify(terms)}`).digest("hex");
}

/** The digest of an effective policy, as release_authority.policy_digest holds it. */
export function releasePolicyDigest(policy: ReleasePolicy): string {
  return createHash("sha256").update(`release-policy:${JSON.stringify(policy)}`).digest("hex");
}

/** Strict stored terms: null column → null; anything that isn't exactly terms → a problem. */
export function storedReleaseTerms(raw: unknown): { ok: true; terms: ReleaseTerms | null } | { ok: false; problem: string } {
  if (raw === null || raw === undefined) return { ok: true, terms: null };
  if (typeof raw !== "string") return { ok: false, problem: "the release terms are not stored as text" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, problem: "the release terms can't be read" }; }
  const read = readReleaseTerms(parsed);
  if (!read.ok) return { ok: false, problem: `the release terms don't match their contract (${read.issues[0]?.line ?? "invalid"})` };
  // Bytes exactly as this code writes them (store.ts serializeReleaseTerms): a reordered or padded row is not what was signed.
  if (JSON.stringify(read.value) !== raw) return { ok: false, problem: "the release terms are not stored exactly as written" };
  return { ok: true, terms: read.value };
}

/**
 * A release check's purpose (docs/plans/pipeline-speed.md, P0): what a person agrees to when they approve a release
 * whose later commits can't carry (its checks run outside the sandbox, or carrying is off) — this exact candidate is a
 * release's check. It never carries a later commit, never lets CI stand in for the check's units and never approves
 * itself; it lets the plane hold the check to the release's strict report rules and rerun it, on this identical
 * candidate under this same approval, after a failure the plane itself confirmed as infrastructure. Part of the scope
 * digest when present; read strictly. A scope carries terms or this purpose, never both.
 */
export const releaseCheckPurposeSchema = versioned(1, {
  purpose: z.literal("release-check"),
  repo: z.string().min(1).max(4096),
  packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  branch: z.string().min(1).max(255).regex(/^[A-Za-z0-9._/-]+$/),
  pr: z.int().min(1),
  base: z.literal("main"),
  approvedSha: sha,
  approvedTree: sha,
  grant: z.strictObject({ id: z.int(), digest: z.string().min(1).max(128) }),
  access: z.enum(["sandboxed", "sign-ins", "unsandboxed"]),
});
export type ReleaseCheckPurpose = z.infer<typeof releaseCheckPurposeSchema>;

export function readReleaseCheckPurpose(input: unknown): ContractResult<ReleaseCheckPurpose> {
  return readVersioned(releaseCheckPurposeSchema, input);
}

/** The digest a scope binds for its release check purpose, domain-separated from the terms' and every other input. */
export function releaseCheckPurposeDigest(purpose: ReleaseCheckPurpose): string {
  return createHash("sha256").update(`release-check-purpose:${JSON.stringify(purpose)}`).digest("hex");
}

/** Strict stored purpose: null column → null; anything that isn't exactly a purpose, as written → a problem. */
export function storedReleaseCheckPurpose(raw: unknown): { ok: true; purpose: ReleaseCheckPurpose | null } | { ok: false; problem: string } {
  if (raw === null || raw === undefined) return { ok: true, purpose: null };
  if (typeof raw !== "string") return { ok: false, problem: "the release check purpose is not stored as text" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, problem: "the release check purpose can't be read" }; }
  const read = readReleaseCheckPurpose(parsed);
  if (!read.ok) return { ok: false, problem: `the release check purpose doesn't match its contract (${read.issues[0]?.line ?? "invalid"})` };
  if (JSON.stringify(read.value) !== raw) return { ok: false, problem: "the release check purpose is not stored exactly as written" };
  return { ok: true, purpose: read.value };
}

export function serializeReleaseCheckPurpose(purpose: ReleaseCheckPurpose): string {
  const read = readReleaseCheckPurpose(purpose);
  if (!read.ok) throw new Error(`The release check purpose doesn't match its contract: ${read.issues[0]?.line ?? "invalid"}`);
  return JSON.stringify(read.value);
}
