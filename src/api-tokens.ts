/**
 * API tokens (v101): what scripts and CI use instead of a password on each
 * request. A token belongs to one person, reads or acts (never more than the
 * person may), always expires (a year at most), is shown once, and only its
 * hash is kept. `Authorization: Bearer so_<id>_<secret>`.
 *
 * A token never passes a step-up: approvals and other password ceremonies
 * stay a person's act in the console.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type TokenAccess = "read" | "act";
export type TokenPurpose = "api" | "mcp";
export const MCP_ROTATION_REFUSAL = "Reconnect the MCP client to renew this token. You can still revoke it here.";

/** Missing purpose is an old ordinary token; an unrecognised stored purpose is never treated as ordinary. */
export const tokenPurpose = (value: unknown): TokenPurpose => value === undefined || value === "api" ? "api" : "mcp";
export const tokenRotationProblem = (token: { purpose: TokenPurpose }): string | null => token.purpose === "api" ? null : MCP_ROTATION_REFUSAL;
export const TOKEN_DAYS = [30, 90, 365] as const;
const SHAPE = /^so_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/;

export function mintApiToken(): { id: string; secret: string; token: string; hash: string } {
  const id = randomBytes(6).toString("hex"), secret = randomBytes(32).toString("base64url");
  return { id, secret, token: `so_${id}_${secret}`, hash: hashSecret(secret) };
}

export const hashSecret = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");

/** The id and secret of something shaped like a token, or null. */
export function parseApiToken(presented: string): { id: string; secret: string } | null {
  const match = SHAPE.exec(presented);
  return match === null ? null : { id: match[1]!, secret: match[2]! };
}

/** Whether the secret is the one whose hash was kept, in constant time. */
export function secretMatches(secret: string, keptHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex"), b = Buffer.from(keptHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** v111: how long a rotated token keeps working beside its replacement, by default and at most. */
export const ROTATION_OVERLAP_MINUTES = 10;
export const ROTATION_OVERLAP_MAX_MINUTES = 60;
/** v111: the person is told this many days before a token expires, once each. */
export const EXPIRY_NOTICE_DAYS = [7, 1] as const;

type TokenState = { revokedAt: string | null; expiresAt: string; overlapUntil: string | null };

/** Whether a token signs anyone in at `now`: unrevoked, unexpired, and (once replaced) inside its overlap. */
export function tokenLive(token: TokenState, now: number): boolean {
  if (token.revokedAt !== null || !(Date.parse(token.expiresAt) > now)) return false;
  return token.overlapUntil === null || Date.parse(token.overlapUntil) > now;
}

/**
 * The projects a token's person may use through it now: the person's current access, narrowed by the token's limit.
 * Null is every project. A limit never widens access, and a project the person has lost stays lost.
 */
export function tokenProjects(account: readonly string[] | null, token: readonly string[] | null): string[] | null {
  if (token === null) return account === null ? null : [...account];
  return token.filter(repo => account === null || account.includes(repo));
}

/** Whether `projects` (a principal's) stays inside the token's limit. A limited token never stands for every project. */
export function withinTokenLimit(projects: readonly string[] | null, limit: readonly string[] | null): boolean {
  if (limit === null) return true;
  return projects !== null && projects.every(repo => limit.includes(repo));
}

/** Whole days until a token expires, rounded up (0 once it has). */
export const daysLeft = (expiresAt: string, now: number): number => Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 86_400_000));

/** The expiry notice a token is due at `now` (7 or 1 days), or null. Replaced and revoked tokens get none. */
export function expiryNoticeDue(token: TokenState & { replacedBy: string | null }, now: number): (typeof EXPIRY_NOTICE_DAYS)[number] | null {
  if (token.replacedBy !== null || !tokenLive(token, now)) return null;
  const left = Date.parse(token.expiresAt) - now;
  return EXPIRY_NOTICE_DAYS.filter(days => left <= days * 86_400_000).at(-1) ?? null;
}
