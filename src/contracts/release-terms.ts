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
  /** The check access the release check runs with: only the fence ever carries. */
  access: z.literal("sandboxed"),
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
