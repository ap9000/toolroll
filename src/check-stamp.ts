/**
 * A check's execution stamp (docs/plans/trusted-release-reports.md, H2): what actually ran, written at launch by the code
 * that launched it. Before this, a run's `sandbox_access` was all there was, and a missing or unreadable value read as
 * "sandboxed". That reading is right for one thing only, choosing how a later check may run (narrowest), and wrong for
 * saying how a check DID run. Anything that relies on how a check ran reads a stamp here: a missing, old or damaged one
 * is `unknown`, which refuses where it matters and is never said to be sandboxed.
 *
 * Reading a stamp is strict, and a new shape takes a new version: an older build's stamp is `unknown` to a newer one.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { isCheckAccess, widerThan, type CheckAccess } from "./check-access.js";

export const CHECK_STAMP_VERSION = 1;
/** Every path: the launch had no write or read fence of that kind. */
export const EVERYWHERE = "*";

/** What the launch's network was: the machine's own, or the fence's, with exactly the hosts it allowed. */
export type StampNetwork = { mode: "machine" } | { mode: "open" | "allowlist"; hosts: string[] };
export type CheckStamp = {
  version: typeof CHECK_STAMP_VERSION;
  /** The level the commands ran at, whatever was sealed. */
  level: CheckAccess;
  /** The digest of the whole fence as given to the launch (invoke.ts fenceDigest); null with no fence. */
  policyDigest: string | null;
  /** Where it could write: exact grants, or [EVERYWHERE]. */
  writable: string[];
  /** What it was given to read beyond the fence's denies, or [EVERYWHERE]. */
  readable: string[];
  network: StampNetwork;
};

export type StampReading = { state: "current"; stamp: CheckStamp } | { state: "unknown"; why: "missing" | "old" | "unreadable" };

/** A launch with no fence at all. */
export const unfencedStamp = (): CheckStamp => ({ version: CHECK_STAMP_VERSION, level: "unsandboxed", policyDigest: null, writable: [EVERYWHERE], readable: [EVERYWHERE], network: { mode: "machine" } });

export const stampDigest = (stamp: CheckStamp): string => createHash("sha256").update(`toolroll:check-stamp:${canonicalJson(stamp as unknown as Record<string, unknown>)}`).digest("hex").slice(0, 32);

const paths = (value: unknown): value is string[] => Array.isArray(value) && value.every(one => typeof one === "string" && one !== "");
const networkIs = (value: unknown): value is StampNetwork => {
  if (value === null || typeof value !== "object") return false;
  const one = value as Record<string, unknown>;
  if (one["mode"] === "machine") return Object.keys(one).length === 1;
  return (one["mode"] === "open" || one["mode"] === "allowlist") && paths(one["hosts"]) && Object.keys(one).length === 2;
};

/** One saved stamp, exactly its shape or unknown. */
export function readStamp(text: unknown): StampReading {
  if (typeof text !== "string") return { state: "unknown", why: "missing" };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { state: "unknown", why: "unreadable" }; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { state: "unknown", why: "unreadable" };
  const one = value as Record<string, unknown>;
  if (one["version"] !== CHECK_STAMP_VERSION) return { state: "unknown", why: typeof one["version"] === "number" ? "old" : "unreadable" };
  const digest = one["policyDigest"];
  const whole = isCheckAccess(one["level"]) && (digest === null || (typeof digest === "string" && /^[0-9a-f]{32}$/.test(digest)))
    && paths(one["writable"]) && paths(one["readable"]) && networkIs(one["network"]) && Object.keys(one).length === 6;
  if (!whole) return { state: "unknown", why: "unreadable" };
  // No fence and a narrow level can't both be true: a stamp that says so is damaged.
  if (digest === null && one["level"] !== "unsandboxed") return { state: "unknown", why: "unreadable" };
  return { state: "current", stamp: value as CheckStamp };
}

/**
 * A run's whole account of its checks: every launch it stamped. Any it can't read makes the whole unknown (one launch of
 * unknown reach is reach unknown); otherwise the widest stands, so a narrow command never hides a wider one. None: unknown.
 */
export function readStamps(texts: readonly unknown[]): StampReading {
  if (texts.length === 0) return { state: "unknown", why: "missing" };
  let widest: CheckStamp | null = null;
  for (const text of texts) {
    const one = readStamp(text);
    if (one.state === "unknown") return one;
    if (widest === null || widerThan(one.stamp.level, widest.level)) widest = one.stamp;
  }
  return { state: "current", stamp: widest! };
}

/** Why relying on `reading` for a check that had to stay within `sealed` isn't possible, or null when it can be. */
export function stampRefusal(reading: StampReading, sealed: CheckAccess): string | null {
  if (reading.state === "unknown") return reading.why === "old" ? "its check's record is from an older Toolroll, so how it ran can't be shown" : "how its check ran wasn't recorded";
  return widerThan(reading.stamp.level, sealed) ? `its check ran ${reading.stamp.level}, wider than the ${sealed} it was approved for` : null;
}

/** How a check ran, as a person reads it after the fact; null for a current sandboxed one, which needs no line. */
export function ranWords(reading: StampReading): string | null {
  if (reading.state === "unknown") return "How these checks ran wasn't recorded";
  return reading.stamp.level === "sandboxed" ? null : reading.stamp.level === "unsandboxed" ? "Checks ran without a sandbox" : "Checks ran with model and GitHub sign-ins";
}

/** v154: one row per distinct launch of a run's commands (a run's repeats of one launch are one row). */
export const V154_SCHEMA = `
CREATE TABLE IF NOT EXISTS check_stamp (
  id      INTEGER PRIMARY KEY,
  run_id  INTEGER NOT NULL,
  digest  TEXT NOT NULL,
  stamp   TEXT NOT NULL,
  at      TEXT NOT NULL,
  UNIQUE (run_id, digest)
);
`;
