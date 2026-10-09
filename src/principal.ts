/**
 * The branded approver principal (mate arc, ruling 3).
 *
 * Every act the lead proposes and every confirmation an operator taps
 * runs under a principal that PROVES it was authenticated — a password
 * ceremony, or a cookie session the edge already proved (csrf, role,
 * generation) and this module re-proves against the approver row. The
 * maker is module-private and the brand is RUNTIME (slice-1 review,
 * finding 3): a principal is frozen at mint and remembered in a private
 * set, so a structural look-alike, a mutated copy, or a repos list edited
 * after the fact is refused by `isVerifiedApprover` and `reproveApprover`.
 * The ceiling rides on it — the admitted repos and their digest — so a
 * principal minted on one surface can never read or confirm on another's
 * wider or narrower view.
 */
import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import { authenticateAccount } from "./scope.js";

declare const verifiedApproverBrand: unique symbol;

export type VerifiedApprover = {
  readonly [verifiedApproverBrand]: true;
  readonly name: string;
  /** The approver row's credential generation at mint; re-proved on every use. */
  readonly generation: number;
  /** The admitted repos, in the surface's own order — `r1..rN` maps by index. */
  readonly repos: readonly string[];
  readonly ceilingDigest: string;
};

/** The lead's ceiling digest: the admitted repos IN ORDER, hashed — `rN`
 * is an index, so two surfaces naming the same repos in a different order
 * hold different ceilings (slice-2 review, finding 3). */
export function ceilingDigestOf(repos: readonly string[]): string {
  return createHash("sha256").update(repos.join("\n")).digest("hex");
}

/** Every principal this process minted. Membership IS the brand at runtime. */
const minted = new WeakSet<object>();

function verified(row: { name: string; generation: number; repos: readonly string[] }): VerifiedApprover {
  const who = Object.freeze({
    name: row.name,
    generation: row.generation,
    repos: Object.freeze([...row.repos]),
    ceilingDigest: ceilingDigestOf(row.repos),
  }) as unknown as VerifiedApprover;
  minted.add(who);
  return who;
}

/** True only for an object this module minted — never for a structural copy. */
export function isVerifiedApprover(value: unknown): value is VerifiedApprover {
  return typeof value === "object" && value !== null && minted.has(value);
}

export type PrincipalRefusal = { ok: false; reason: "no-approvers" | "unknown" | "revoked" | "locked" | "not-an-approver" | "generation" | "forged" };

/** The password road: the CLI, and any ceremony that retypes it. */
export function verifyApproverByPassword(
  store: Store,
  name: string,
  token: string,
  repos: readonly string[],
): { ok: true; who: VerifiedApprover } | PrincipalRefusal {
  const account = authenticateAccount(store, name, token);
  if (!account.ok) return { ok: false, reason: account.reason };
  if (account.role !== "approver") return { ok: false, reason: "not-an-approver" };
  return { ok: true, who: verified({ name, generation: account.generation, repos }) };
}

/**
 * The session road: the edge has already proved the cookie, csrf, and the
 * origin, and holds the generation the session was opened under. This
 * re-proves the ROW — present, an approver, not revoked, SAME generation —
 * so a name alone mints nothing, and a credential rotation since the
 * session opened ends the principal.
 */
export function verifyApproverStanding(
  store: Store,
  name: string,
  generation: number,
  repos: readonly string[],
): { ok: true; who: VerifiedApprover } | PrincipalRefusal {
  const account = store.accountOf(name);
  if (account === null) return { ok: false, reason: "unknown" };
  if (account.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (account.role !== "approver") return { ok: false, reason: "not-an-approver" };
  if (account.generation !== generation) return { ok: false, reason: "generation" };
  return { ok: true, who: verified({ name, generation: account.generation, repos }) };
}

/** Re-prove a principal minted earlier: minted here, intact, same row, same generation, still an approver. */
export function reproveApprover(store: Store, who: VerifiedApprover): { ok: true } | PrincipalRefusal {
  if (!isVerifiedApprover(who) || ceilingDigestOf(who.repos) !== who.ceilingDigest) return { ok: false, reason: "forged" };
  const account = store.accountOf(who.name);
  if (account === null) return { ok: false, reason: "unknown" };
  if (account.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (account.role !== "approver") return { ok: false, reason: "not-an-approver" };
  if (account.generation !== who.generation) return { ok: false, reason: "generation" };
  return { ok: true };
}
