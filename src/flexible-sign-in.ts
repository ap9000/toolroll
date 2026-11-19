/**
 * Each person's own Claude sign-in for interactive agent threads (the thread sign-in plan v2 §1–§4; owner decisions:
 * each person uses their own sign-in, never a shared or installation credential; a password reset ends it; v1 takes
 * plan setup-tokens only; restoring a backup resets every sign-in).
 *
 * A thread runs only on the sign-in of the person who started it. Its rows (flexible_sign_in, v172) hold no value; the
 * value rests at an address of its own per person and generation (tool-secret-store.ts createSignInSecret), never
 * overwritten.
 *
 * Saving one is staged in three steps, so a failed save never destroys the sign-in that works:
 * 1. Transaction A: the person proves themselves now (a password typed now, or a one-use identity-provider re-check,
 *    consumed here), and a `staged` row with a fresh generation G is written, bound to this person, their account
 *    generation, G, the proof and this save (`save_op`).
 * 2. Under the person's lock, the value is written at G's own address.
 * 3. Transaction B: the binding is checked again (the row still staged with this save, the account active at the same
 *    generation, an approver, and the same kind of proof standing: the password checked again, or the same live
 *    session), and the pending activation is consumed exactly once: G becomes `active` and the one before `retiring`.
 * Then retiring generations' secrets are deleted, then their rows (also each upkeep tick, tidyFlexibleSignIns).
 *
 * Removal is one transaction that retires the person's active and staged rows: immediate, never waiting on a keychain
 * or the network, and it makes any save still under way fail at B. `retiring` is terminal.
 *
 * At dispatch the relay reads the turn's owner's active generation (signInForTurn), then checks the whole invariant
 * inside its reservation transaction (signInStandsAt): the thread's starter is the turn's owner is the sign-in's person,
 * the turn's owner generation is the sign-in's account generation is the account's generation now, an active approver,
 * the generation still active, its billing the turn's, and no recorded authentication refusal for it. Nothing ever
 * falls back to another person's sign-in or an installation-wide one: there is none.
 */
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { flexibleAvailable } from "./flexible-available.js";
import { CLAUDE_EXACT } from "./model-catalog.js";
import { FLEXIBLE_RELAY_UPSTREAMS } from "./flexible-relay-upstreams.js";
import { credentialProof, freshFacts, proveCredential } from "./scope.js";
import { createSignInSecret, readSignInSecret, removeSignInSecret, withSignInLockAsync, type SignInSecret } from "./tool-secret-store.js";
import { endThreadAuthorityFor, type ThreadAuthorityEnded } from "./flexible-authority-end.js";
import { relayCancel } from "./flexible-relay-cancel.js";
import type { Store } from "./store.js";

/** The ledger's action for every change to a person's sign-in. */
export const SIGN_IN_ACTION = "claude sign-in for threads";
/** How long a staged save may take before it is retired unused. */
export const SIGN_IN_STAGE_MS = 15 * 60_000;
const SETUP_TOKEN = FLEXIBLE_RELAY_UPSTREAMS.claude.auth["setup-token"];
const API_KEY = FLEXIBLE_RELAY_UPSTREAMS.claude.auth["api-key"];
const GENERATION = /^[0-9a-f]{32}$/;
const PERSON = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 200;

export type SignInRefusalReason = "not-available" | "invalid-request" | "not-proved" | "shape" | "api-key" | "save-ended" | "not-saved" | "check-refused";
export type SignInRefusal = { ok: false; reason: SignInRefusalReason; message: string };
const WORDS: Readonly<Record<SignInRefusalReason, string>> = Object.freeze({
  "not-available": "Interactive agent threads are off: Settings → General, or `toolroll config set flexible on`. Nothing was saved.",
  "invalid-request": "That isn't a sign-in Toolroll can save. Nothing was saved.",
  "not-proved": "Saving your Claude sign-in needs your Toolroll password, typed now. Nothing was saved.",
  shape: "That doesn't look like a token from `claude setup-token`. Run it again and paste the whole token it prints. Nothing was saved.",
  "api-key": "That's an API key. Threads need your `claude setup-token` sign-in. Nothing was saved.",
  "save-ended": "This save didn't finish: your sign-in was removed, your account changed, or the save took too long. Nothing was saved; try again.",
  "not-saved": "Toolroll couldn't keep your sign-in in its folder for secrets. Nothing was saved; your earlier sign-in, if any, still works.",
  "check-refused": "Claude didn't accept this sign-in. Run `claude setup-token` again and paste the new token. Nothing was saved; your earlier sign-in, if any, still works.",
});
const refuse = (reason: SignInRefusalReason): SignInRefusal => ({ ok: false, reason, message: WORDS[reason] });

// ---- the paste ----------------------------------------------------------------------------------------------------------

/** A pasted setup-token, whitespace and line breaks taken out (terminals wrap the long token), checked for its shape.
 * Never quotes the paste back. */
export function setupTokenFromPaste(paste: string): { ok: true; token: string } | SignInRefusal {
  if (typeof paste !== "string") return refuse("invalid-request");
  const token = paste.replace(/\s+/g, "");
  if (SETUP_TOKEN.shape.test(token)) return { ok: true, token };
  if (API_KEY.shape.test(token) || /^sk-ant-api/.test(token)) return refuse("api-key");
  return refuse("shape");
}
/** Whether text looks like any Anthropic credential (a value given where only a prompt may take it). */
export const looksLikeClaudeCredential = (text: string): boolean => /sk-ant-[A-Za-z0-9_-]{6,}/.test(text.replace(/\s+/g, ""));

// ---- rows ---------------------------------------------------------------------------------------------------------------

export type SignInRow = { person: string; accountGeneration: number; generation: string; kind: "setup-token"; state: "staged" | "active" | "retiring"; saveOp: string | null;
  proof: "password-now" | "sso-now" | "restored"; stagedAt: string; retireAfter: string | null; activatedAt: string | null; retiredAt: string | null; checkOutcome: string; checkStatus: number | null; checkedAt: string | null };
const readRow = (row: Record<string, unknown> | undefined): SignInRow | null => row === undefined ? null : {
  person: String(row["person"]), accountGeneration: Number(row["account_generation"]), generation: String(row["generation"]), kind: "setup-token",
  state: String(row["state"]) as SignInRow["state"], saveOp: row["save_op"] == null ? null : String(row["save_op"]), proof: String(row["proof"]) as SignInRow["proof"],
  stagedAt: String(row["staged_at"]), retireAfter: row["retire_after"] == null ? null : String(row["retire_after"]), activatedAt: row["activated_at"] == null ? null : String(row["activated_at"]),
  retiredAt: row["retired_at"] == null ? null : String(row["retired_at"]), checkOutcome: String(row["check_outcome"]), checkStatus: row["check_status"] == null ? null : Number(row["check_status"]), checkedAt: row["checked_at"] == null ? null : String(row["checked_at"]) };
const rowOf = (store: Store, person: string, generation: string): SignInRow | null =>
  readRow(store.handle.prepare("SELECT * FROM flexible_sign_in WHERE person = ? AND generation = ?").get(person, generation) as Record<string, unknown> | undefined);
const activeRowOf = (store: Store, person: string): SignInRow | null =>
  readRow(store.handle.prepare("SELECT * FROM flexible_sign_in WHERE person = ? AND state = 'active'").get(person) as Record<string, unknown> | undefined);
/** Whether Claude refused this generation of this person's sign-in on some call (thread_relay_call.sign_in_refused). */
const refusedOnce = (store: Store, person: string, generation: string): boolean =>
  store.handle.prepare("SELECT 1 AS refused FROM thread_relay_call WHERE sign_in_person = ? AND sign_in_generation = ? AND sign_in_refused = 1 LIMIT 1").get(person, generation) !== undefined;
/** The account a sign-in row can count for: active, an approver, at exactly `generation`. */
function standingAccount(store: Store, person: string, generation: number): boolean {
  const account = store.accountOf(person);
  return account !== null && account.revokedAt === null && account.role === "approver" && account.generation === generation;
}

// ---- saving: stage (A), place, activate (B), retire ----------------------------------------------------------------------

/** A staged save: what transaction B must match. `op` is this save's capability: random, held only in the memory of the
 * request that made it (the row keeps a hash of it, never it). */
export type StagedSignIn = { person: string; generation: string; op: string; accountGeneration: number; proof: "password-now" | "sso-now" };
const CAPABILITY = /^[0-9a-f]{64}$/;
/** What the row keeps of a save's capability: 128 bits of its hash. */
const opDigest = (op: string): string => createHash("sha256").update(`toolroll:flexible-sign-in:save:${op}`, "utf8").digest("hex").slice(0, 32);
/** The capabilities a request's own facts minted (a re-check-proved save): B accepts its capability only from the very
 * request object that minted it, so another request of the same person (another tab, another session) never can. */
const mintedBy = new WeakMap<object, Set<string>>();

/**
 * Transaction A of a save: the person proved now, for themselves only (a password typed now, or a one-use identity
 * provider re-check, consumed here: never Passwordless, a session standing in, a remembered login under Passwordless,
 * the local owner's act, a token, the lead or chat), an active approver; then a staged row with a fresh generation,
 * bound to this person, their account generation, the proof and this save. Nothing is written when the proof fails
 * (beyond what a wrong password always counts).
 */
export function stageFlexibleSignIn(store: Store, input: { person: string; password: string; now: Date }): { ok: true; staged: StagedSignIn } | SignInRefusal {
  if (!flexibleAvailable(store)) return refuse("not-available");
  if (!PERSON(input?.person) || typeof input.password !== "string" || !(input.now instanceof Date)) return refuse("invalid-request");
  return store.transact((): { ok: true; staged: StagedSignIn } | SignInRefusal => {
    if (!flexibleAvailable(store)) return refuse("not-available");
    const proved = proveCredential(store, input.person, input.password);
    if (!proved.ok || !credentialProof(proved.method)) return refuse("not-proved");
    const account = store.accountOf(input.person);
    if (account === null || !standingAccount(store, input.person, account.generation)) return refuse("not-proved");
    const generation = randomBytes(16).toString("hex"), op = randomBytes(32).toString("hex");
    const proof = proved.method as "password-now" | "sso-now";
    store.handle.prepare(`INSERT INTO flexible_sign_in (person, account_generation, generation, kind, state, save_op, proof, staged_at, retire_after)
      VALUES (?, ?, ?, 'setup-token', 'staged', ?, ?, ?, ?)`).run(input.person, account.generation, generation, opDigest(op), proof, input.now.toISOString(), new Date(input.now.getTime() + SIGN_IN_STAGE_MS).toISOString());
    // A re-check-proved save: its capability is bound to this request's own facts object (and so its session).
    const facts = freshFacts.getStore();
    if (proof === "sso-now" && facts != null) { const set = mintedBy.get(facts) ?? new Set<string>(); set.add(opDigest(op)); mintedBy.set(facts, set); }
    return { ok: true, staged: { person: input.person, generation, op, accountGeneration: account.generation, proof } };
  });
}

/** Step 2: the value written at the staged generation's own address (never the active one's, never over anything). */
export function placeFlexibleSignIn(state: string, staged: StagedSignIn, token: string): "ok" | "exists" {
  const secret: SignInSecret = { person: staged.person, generation: staged.generation, kind: "setup-token", value: token };
  return createSignInSecret(state, secret);
}

/**
 * Transaction B of a save: the staged row must still be exactly this save's (staged, this `op`, not expired), the
 * account active as an approver at the generation A bound, and the same kind of proof still standing: the password
 * typed now checked again, or, for a re-check A consumed, this request's own session still signed in as this person.
 * Then the pending activation is consumed exactly once (a replay, another generation or a removal in between finds
 * nothing staged), and the generation before it goes to retiring. With its ledger row.
 */
export function activateFlexibleSignIn(store: Store, input: { staged: StagedSignIn; password: string; now: Date; check?: SignInCheck | null }): { ok: true; replaced: boolean } | SignInRefusal {
  const staged = input?.staged;
  if (staged === undefined || !PERSON(staged.person) || typeof staged.generation !== "string" || !GENERATION.test(staged.generation) || typeof staged.op !== "string" || !CAPABILITY.test(staged.op)
    || typeof input.password !== "string" || !(input.now instanceof Date)) return refuse("invalid-request");
  return store.transact((): { ok: true; replaced: boolean } | SignInRefusal => {
    const now = input.now.toISOString();
    const row = rowOf(store, staged.person, staged.generation);
    const digest = opDigest(staged.op);
    if (row === null || row.state !== "staged" || row.saveOp !== digest || row.retireAfter === null || row.retireAfter <= now || row.accountGeneration !== staged.accountGeneration) return refuse("save-ended");
    if (!standingAccount(store, row.person, row.accountGeneration)) return refuse("save-ended");
    if (row.proof === "password-now") {
      const again = proveCredential(store, row.person, input.password);
      if (!again.ok || again.method !== "password-now") return refuse("not-proved");
    } else if (row.proof === "sso-now") {
      const facts = freshFacts.getStore();
      if (input.password !== "" || facts == null || facts.actor !== row.person || mintedBy.get(facts)?.has(digest) !== true || !facts.live()) return refuse("not-proved");
    } else return refuse("not-proved");
    const replaced = Number(store.handle.prepare("UPDATE flexible_sign_in SET state = 'retiring', retired_at = ? WHERE person = ? AND state = 'active'").run(now, row.person).changes) > 0;
    const consumed = Number(store.handle.prepare(`UPDATE flexible_sign_in SET state = 'active', save_op = NULL, retire_after = NULL, activated_at = ?
      WHERE person = ? AND generation = ? AND state = 'staged' AND save_op = ? AND account_generation = ?`).run(now, row.person, row.generation, digest, row.accountGeneration).changes);
    if (consumed !== 1) throw new Error("a sign-in's staged save changed during its own activation");
    const check = input.check ?? null;
    if (check !== null) recordCheck(store, row.person, row.generation, check, now);
    store.recordAction({ at: now, actor: row.person, repo: null, taskId: null, runId: null, action: SIGN_IN_ACTION, outcome: replaced ? "replaced" : "saved", source: "policy",
      detail: `setup-token, ${check === null ? "not checked" : checkOutcomeOf(check)}` });
    return { ok: true as const, replaced };
  });
}

/** A staged save that won't be activated (its value couldn't be kept): retired at once, so its secret, if any, goes. */
function abandonStaged(store: Store, staged: StagedSignIn, now: Date): void {
  try {
    store.handle.prepare("UPDATE flexible_sign_in SET state = 'retiring', save_op = NULL, retire_after = NULL, retired_at = ? WHERE person = ? AND generation = ? AND state = 'staged'")
      .run(now.toISOString(), staged.person, staged.generation);
  } catch { /* the upkeep retires it once its time is past */ }
}

/** The steps a save takes, for a test to stop between (never anything else). */
export type SignInSaveSeams = { afterStage?: (staged: StagedSignIn) => void | Promise<void>; afterPlace?: (staged: StagedSignIn) => void | Promise<void> };

/**
 * Save (or replace) a person's own sign-in: A, then under the person's lock the value placed and B, then retiring
 * generations' secrets deleted. The token was shape-checked by the caller (setupTokenFromPaste) and is checked again
 * here. `state` is Toolroll's state folder (beside the database).
 */
export async function saveFlexibleSignIn(store: Store, input: { state: string; person: string; password: string; token: string;
  /** Whether to run the live token-count check after authority is proved (every caller decides: `--no-check` skips it). */
  check: boolean; clock?: () => Date; seams?: SignInSaveSeams }):
  Promise<{ ok: true; replaced: boolean; generation: string; check: SignInCheck | null } | SignInRefusal> {
  const clock = input.clock ?? (() => new Date());
  const paste = setupTokenFromPaste(input.token);
  if (!paste.ok) return paste;
  const staged = stageFlexibleSignIn(store, { person: input.person, password: input.password, now: clock() });
  if (!staged.ok) return staged;
  await input.seams?.afterStage?.(staged.staged);
  let saved: { ok: true; replaced: boolean; generation: string; check: SignInCheck | null } | SignInRefusal;
  try {
    saved = await withSignInLockAsync(input.state, input.person, async (): Promise<{ ok: true; replaced: boolean; generation: string; check: SignInCheck | null } | SignInRefusal> => {
      let placed: "ok" | "exists";
      try { placed = placeFlexibleSignIn(input.state, staged.staged, paste.token); } catch { placed = "exists"; }
      if (placed !== "ok") { abandonStaged(store, staged.staged, clock()); return refuse("not-saved"); }
      await input.seams?.afterPlace?.(staged.staged);
      // The live check: only now, after transaction A proved the person, and only the staged value. Claude refusing it
      // retires the staged generation (it never becomes active); anything else is saved, labelled with what was found.
      const check = input.check === true ? await checkSignInToken(paste.token) : null;
      if (check !== null && check.outcome === "refused") { abandonStaged(store, staged.staged, clock()); return refuse("check-refused"); }
      let active: { ok: true; replaced: boolean } | SignInRefusal;
      try { active = activateFlexibleSignIn(store, { staged: staged.staged, password: input.password, now: clock(), check }); } catch { active = refuse("save-ended"); }
      if (!active.ok) { abandonStaged(store, staged.staged, clock()); return active; }
      return { ok: true, replaced: active.replaced, generation: staged.staged.generation, check };
    });
  } catch { abandonStaged(store, staged.staged, clock()); saved = refuse("not-saved"); }
  // The generations this save retired (and any left by an earlier one) go now; whatever can't, the upkeep retries.
  try { await tidyFlexibleSignIns(store, input.state, { now: clock(), person: input.person }); } catch { /* the upkeep tick tries again */ }
  return saved;
}

// ---- removal --------------------------------------------------------------------------------------------------------------

/**
 * Remove a person's sign-in: one transaction (the caller proves its authority in it) retires their active AND staged
 * rows, so a save still under way fails at its activation. Never blocked: no keychain, no network, no switch. Its
 * secrets are deleted afterwards (tidyFlexibleSignIns). With its ledger row.
 */
export function removeFlexibleSignIn(store: Store, input: { person: string; by: string; now: Date }): { removed: boolean; ended: ThreadAuthorityEnded } {
  return store.transact(() => {
    const at = input.now.toISOString();
    const removed = Number(store.handle.prepare("UPDATE flexible_sign_in SET state = 'retiring', save_op = NULL, retire_after = NULL, retired_at = ? WHERE person = ? AND state IN ('staged', 'active')")
      .run(at, input.person).changes) > 0;
    store.recordAction({ at, actor: input.by, repo: null, taskId: null, runId: null, action: SIGN_IN_ACTION, outcome: removed ? "removed" : "none to remove", source: "policy",
      detail: input.by === input.person ? null : `${input.person}'s` });
    // The removal epoch moves in this transaction: every call dispatched before it stops at its next check, whatever is
    // saved after (another process's relay too); in this process, it is cut at once.
    raiseSignInEpoch(store, input.person);
    if (removed) relayCancel({ person: input.person });
    // Their threads stop with it, in this transaction (flexible-authority-end.ts): running turns interrupted with
    // Toolroll's words, waiting ones withdrawn, every agent of theirs required to stop (whichever console holds it).
    const ended = endThreadAuthorityFor(store, { person: input.person, cause: input.by === input.person ? "removed" : "removed-by-operator", at, signInsEnded: true });
    return { removed, ended };
  });
}

/**
 * Retire every sign-in in a database being restored (backup.ts restoreDatabase, before it is put in service): each row
 * retiring, and `carried` (the addresses the database it replaces knew) added as retiring, so the upkeep deletes their
 * secrets. Inside the caller's transaction on the restored store.
 */
export function resetFlexibleSignInsForRestore(store: Store, input: { now: Date; carried: readonly { person: string; generation: string; accountGeneration: number }[] }): { reset: number } {
  const at = input.now.toISOString();
  const reset = Number(store.handle.prepare("UPDATE flexible_sign_in SET state = 'retiring', save_op = NULL, retire_after = NULL, retired_at = ? WHERE state IN ('staged', 'active')").run(at).changes);
  // Every person's removal epoch moves too (no call of the restored database's era may ever count as current).
  for (const row of store.handle.prepare("SELECT DISTINCT person FROM flexible_sign_in UNION SELECT person FROM flexible_sign_in_epoch").all()) raiseSignInEpoch(store, String(row["person"]));
  for (const one of input.carried) if (PERSON(one.person)) raiseSignInEpoch(store, one.person);
  // Every turn of the restored database's era ends, and every agent it names is required to stop.
  for (const row of store.handle.prepare("SELECT DISTINCT owner AS person FROM thread_turn WHERE status IN ('admitted', 'running') UNION SELECT created_by AS person FROM flexible_thread").all()) {
    endThreadAuthorityFor(store, { person: String(row["person"]), cause: "restored", at, signInsEnded: true });
  }
  for (const one of input.carried) {
    if (!PERSON(one.person) || !GENERATION.test(one.generation) || !Number.isSafeInteger(one.accountGeneration) || one.accountGeneration < 0) continue;
    store.handle.prepare(`INSERT INTO flexible_sign_in (person, account_generation, generation, kind, state, save_op, proof, staged_at, retired_at)
      VALUES (?, ?, ?, 'setup-token', 'retiring', NULL, 'restored', ?, ?) ON CONFLICT (person, generation) DO NOTHING`).run(one.person, one.accountGeneration, one.generation, at, at);
  }
  store.recordAction({ at, actor: "command line", repo: null, taskId: null, runId: null, action: SIGN_IN_ACTION, outcome: "reset by restore", source: "policy",
    detail: "Everyone's Claude sign-in for threads needs saving again." });
  return { reset };
}

// ---- upkeep -----------------------------------------------------------------------------------------------------------------

/**
 * The upkeep: staged saves past their time, and rows whose account is gone, revoked, no longer an approver or at another
 * generation (a password reset ends a sign-in), retired; then, under each person's lock, each retiring generation's
 * secret deleted, then its row (re-read just before: only `retiring` rows, which nothing brings back). A keychain that
 * refuses leaves the row for the next tick. Never deletes a staged generation before its time, or an active one.
 */
export async function tidyFlexibleSignIns(store: Store, state: string, input: { now: Date; person?: string; waitMs?: number }): Promise<{ deleted: number; left: number }> {
  const at = input.now.toISOString();
  store.transact(() => {
    store.handle.prepare("UPDATE flexible_sign_in SET state = 'retiring', save_op = NULL, retire_after = NULL, retired_at = ? WHERE state = 'staged' AND retire_after <= ?").run(at, at);
    for (const row of store.handle.prepare("SELECT person, generation, account_generation FROM flexible_sign_in WHERE state IN ('staged', 'active')").all()) {
      if (standingAccount(store, String(row["person"]), Number(row["account_generation"]))) continue;
      store.handle.prepare("UPDATE flexible_sign_in SET state = 'retiring', save_op = NULL, retire_after = NULL, retired_at = ? WHERE person = ? AND generation = ? AND state IN ('staged', 'active')")
        .run(at, String(row["person"]), String(row["generation"]));
    }
  });
  const people = (input.person === undefined
    ? store.handle.prepare("SELECT DISTINCT person FROM flexible_sign_in WHERE state = 'retiring'").all()
    : store.handle.prepare("SELECT DISTINCT person FROM flexible_sign_in WHERE state = 'retiring' AND person = ?").all(input.person)).map(row => String(row["person"]));
  let deleted = 0, left = 0;
  for (const person of people) {
    try {
      await withSignInLockAsync(state, person, async () => {
        for (const row of store.handle.prepare("SELECT generation FROM flexible_sign_in WHERE person = ? AND state = 'retiring'").all(person)) {
          const generation = String(row["generation"]);
          const again = rowOf(store, person, generation);
          if (again === null || again.state !== "retiring") continue;
          try { removeSignInSecret(state, person, generation); } catch { left++; continue; }
          store.transact(() => {
            if (Number(store.handle.prepare("DELETE FROM flexible_sign_in WHERE person = ? AND generation = ? AND state = 'retiring'").run(person, generation).changes) === 1) {
              store.recordAction({ at, actor: "upkeep", repo: null, taskId: null, runId: null, action: SIGN_IN_ACTION, outcome: "retired", source: "policy", detail: `${person}'s` });
              deleted++;
            }
          });
        }
      }, { waitMs: input.waitMs ?? 2_000 });
    } catch { left++; }
  }
  return { deleted, left };
}

// ---- what readiness, the start card and the CLI read (metadata only, never the secret) ------------------------------------

/** A person's sign-in as the record says: none, saved (active), or refused by Claude on some call. Never reads the value. */
export type SignInStatus = { state: "none" } | { state: "active" | "refused"; savedAt: string; checkOutcome: string; checkStatus: number | null; checkedAt: string | null; generation: string };
export function flexibleSignInStatus(store: Store, person: string): SignInStatus {
  const account = store.accountOf(person);
  const row = activeRowOf(store, person);
  if (row === null || account === null || !standingAccount(store, person, row.accountGeneration)) return { state: "none" };
  return { state: refusedOnce(store, person, row.generation) ? "refused" : "active", savedAt: row.activatedAt ?? row.stagedAt, checkOutcome: row.checkOutcome,
    checkStatus: row.checkStatus, checkedAt: row.checkedAt, generation: row.generation };
}

/** How a person's threads are billed, from their own sign-in's record (its kind), for `by` at the generation their
 * session holds: refused when they have none that counts, or Claude refused it. Never reads the value. */
export function flexibleSignInBilling(store: Store, by: { name: string; generation: number }): { ok: true; billing: "subscription" | "api-key" } | { ok: false; reason: "no-sign-in" | "sign-in-refused" } {
  if (!PERSON(by?.name) || !Number.isSafeInteger(by.generation)) return { ok: false, reason: "no-sign-in" };
  const row = activeRowOf(store, by.name);
  if (row === null || row.accountGeneration !== by.generation || !standingAccount(store, by.name, by.generation)) return { ok: false, reason: "no-sign-in" };
  if (refusedOnce(store, by.name, row.generation)) return { ok: false, reason: "sign-in-refused" };
  return { ok: true, billing: FLEXIBLE_RELAY_UPSTREAMS.claude.auth[row.kind].billing };
}

// ---- dispatch (the relay) -----------------------------------------------------------------------------------------------

/** The sign-in a call is sent with: whose, which generation, its kind and the value. Only the relay holds one. */
export type DispatchSignIn = { person: string; generation: string; kind: "setup-token"; value: string };

/**
 * The turn's owner's own active sign-in, read for one call (before its reservation; the reservation checks it all
 * again, signInStandsAt): the owner's active generation, at the turn's owner generation, read from its own address and
 * checked to be theirs of that generation. Never anyone else's: no sign-in of the owner's is a refusal.
 */
export function signInForTurn(store: Store, state: string, turn: { owner: string; ownerGeneration: number }): { ok: true; signIn: DispatchSignIn } | { ok: false; reason: "no-sign-in" | "sign-in-refused" } {
  const billing = flexibleSignInBilling(store, { name: turn.owner, generation: turn.ownerGeneration });
  if (!billing.ok) return billing;
  const row = activeRowOf(store, turn.owner);
  if (row === null) return { ok: false, reason: "no-sign-in" };
  let secret: SignInSecret | null;
  try { secret = readSignInSecret(state, row.person, row.generation); } catch { return { ok: false, reason: "no-sign-in" }; }
  if (secret === null || secret.person !== turn.owner || secret.generation !== row.generation || !SETUP_TOKEN.shape.test(secret.value)) return { ok: false, reason: "no-sign-in" };
  return { ok: true, signIn: { person: row.person, generation: row.generation, kind: row.kind, value: secret.value } };
}

/**
 * The dispatch invariant, read inside the relay's reservation transaction, from the record alone: `thread`'s starter =
 * the turn's owner = the sign-in's person; the turn's owner generation = the sign-in's account generation = the
 * account's generation now; the account an active approver; this generation still the person's active one; its kind's
 * billing the turn's; and no call where Claude refused it. Null when all hold; else why not.
 */
export function signInStandsAt(store: Store, input: { thread: string; turn: string; person: string; generation: string }): null | "no-sign-in" | "sign-in-refused" {
  const thread = store.handle.prepare("SELECT created_by FROM flexible_thread WHERE id = ?").get(input.thread);
  const turn = store.handle.prepare("SELECT thread, owner, owner_generation, billing, status FROM thread_turn WHERE id = ?").get(input.turn);
  if (thread === undefined || turn === undefined || turn["thread"] !== input.thread || turn["status"] !== "running") return "no-sign-in";
  const owner = String(turn["owner"]), ownerGeneration = Number(turn["owner_generation"]);
  if (thread["created_by"] !== owner || owner !== input.person) return "no-sign-in";
  const row = rowOf(store, input.person, input.generation);
  if (row === null || row.state !== "active" || row.accountGeneration !== ownerGeneration || !standingAccount(store, input.person, ownerGeneration)) return "no-sign-in";
  if (FLEXIBLE_RELAY_UPSTREAMS.claude.auth[row.kind].billing !== turn["billing"]) return "no-sign-in";
  if (refusedOnce(store, input.person, input.generation)) return "sign-in-refused";
  return null;
}

/** Whether an upstream answer is Claude refusing the sign-in itself: 401, or 403 whose error type is
 * authentication_error. A 403 for anything else (a plan or model permission) is an ordinary error. */
export const signInRefusedBy = (status: number, errorType: string | null): boolean => status === 401 || (status === 403 && errorType === "authentication_error");
/** What the agent gets, and the turn ends with, when Claude refused the sign-in (never Claude's own body). */
export const signInRefusedWords = (status: number): string =>
  `Toolroll couldn't use your Claude sign-in for threads: Claude answered ${status}. Replace it in Settings → General, or with \`toolroll config set flexible-sign-in\`.`;

// ---- the live check (count_tokens) -------------------------------------------------------------------------------------

/** What one live check found. Informational: it never clears a refusal or widens anything; only a new save does. */
export type SignInCheck = { outcome: "accepted"; status: 200 } | { outcome: "refused"; status: number } | { outcome: "inconclusive"; status: number } | { outcome: "unreachable"; status: null };
/** How long the check may take: to connect, and in all; and the most of an answer it ever reads (never echoed). */
export const SIGN_IN_CHECK_LIMITS = Object.freeze({ connectMs: 5_000, totalMs: 10_000, bodyBytes: 4 * 1024 });
const CHECK_MODEL = CLAUDE_EXACT.find(one => one.value.startsWith("claude-haiku-"))?.value ?? "claude-haiku-4-5";
const checkOutcomeOf = (check: SignInCheck): string => check.outcome === "accepted" ? "token-count check accepted" : `check ${check.outcome}${check.status === null ? "" : ` (HTTP ${check.status})`}`;

/** A status's check, as signInCheckWords reads it. */
export function statusCheck(status: SignInStatus): SignInCheck | { outcome: "not-checked" } {
  if (status.state === "none") return { outcome: "not-checked" };
  const outcome = status.checkOutcome;
  if (outcome === "accepted") return { outcome, status: 200 };
  if ((outcome === "refused" || outcome === "inconclusive") && status.checkStatus !== null) return { outcome, status: status.checkStatus };
  if (outcome === "unreachable") return { outcome, status: null };
  return { outcome: "not-checked" };
}

/** The words for a check's outcome (the plan's outcome table), never quoting what Claude said. */
export function signInCheckWords(check: SignInCheck | { outcome: "not-checked" }): string {
  switch (check.outcome) {
    case "not-checked": return "Not checked.";
    case "accepted": return "Token-count check accepted.";
    case "refused": return `Claude didn't accept this sign-in (HTTP ${check.status}).`;
    case "inconclusive": return check.status >= 300 && check.status < 400 ? "Check inconclusive (redirect refused)." : `Check inconclusive (HTTP ${check.status}).`;
    case "unreachable": return "Couldn't reach Claude to check.";
  }
}

/**
 * One live check of a setup-token: POST /v1/messages/count_tokens (a one-word body, a small model) to the relay's own
 * fixed origin (flexible-relay-upstreams.ts), signed in as the relay signs in with a setup-token, nothing else. Connect
 * within 5 s and finish within 10 s; at most 4 KiB of the answer is read and none of it is kept or echoed. One decided
 * outcome per answer: 200 with a whole `input_tokens` accepted; 401, or 403 authentication_error, refused; a redirect
 * (never followed), any other status or an unreadable 200 inconclusive; a timeout or connection failure unreachable.
 * Callers run it only after the person's authority was proved.
 */
export function checkSignInToken(token: string, limits: { connectMs: number; totalMs: number; bodyBytes: number } = SIGN_IN_CHECK_LIMITS): Promise<SignInCheck> {
  const upstream = FLEXIBLE_RELAY_UPSTREAMS.claude, auth = upstream.auth["setup-token"];
  if (!auth.shape.test(token)) return Promise.resolve({ outcome: "unreachable", status: null });
  const route = upstream.routes.find(one => one.kind === "count-tokens")!;
  const target = new URL(route.path, upstream.origin);
  const body = Buffer.from(JSON.stringify({ model: CHECK_MODEL, messages: [{ role: "user", content: "hi" }] }), "utf8");
  return new Promise<SignInCheck>(resolve => {
    let done = false;
    const finish = (check: SignInCheck) => { if (done) return; done = true; clearTimeout(total); clearTimeout(connect); try { outgoing.destroy(); } catch { /* gone */ } resolve(check); };
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send({ protocol: target.protocol, hostname: target.hostname, port: target.port === "" ? undefined : Number(target.port), method: "POST", path: target.pathname, agent: false,
      ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
      headers: { host: target.host, "content-type": "application/json", "content-length": String(body.length), "accept-encoding": "identity", "anthropic-version": "2023-06-01",
        "anthropic-beta": auth.betas.join(","), [auth.header]: `${auth.prefix}${token}` } });
    const total = setTimeout(() => finish({ outcome: "unreachable", status: null }), limits.totalMs);
    const connect = setTimeout(() => finish({ outcome: "unreachable", status: null }), limits.connectMs);
    outgoing.on("socket", socket => {
      const connected = () => clearTimeout(connect);
      if (!socket.connecting) connected(); else socket.once(target.protocol === "https:" ? "secureConnect" : "connect", connected);
    });
    outgoing.on("error", () => finish({ outcome: "unreachable", status: null }));
    outgoing.on("response", (answer: IncomingMessage) => {
      const status = answer.statusCode ?? 0;
      if (status < 100 || status > 599) { finish({ outcome: "inconclusive", status: 502 }); return; }
      if (status >= 300 && status < 400) { finish({ outcome: "inconclusive", status }); return; }
      const parts: Buffer[] = [];
      let size = 0;
      const decide = () => {
        const text = Buffer.concat(parts).subarray(0, limits.bodyBytes).toString("utf8");
        let parsed: unknown = null;
        try { parsed = JSON.parse(text) as unknown; } catch { parsed = null; }
        const object = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
        if (status === 200) {
          const tokens = object?.["input_tokens"];
          finish(typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? { outcome: "accepted", status: 200 } : { outcome: "inconclusive", status: 200 });
          return;
        }
        const error = object?.["error"];
        const type = error !== null && typeof error === "object" ? (error as Record<string, unknown>)["type"] : undefined;
        finish(signInRefusedBy(status, typeof type === "string" ? type : null) ? { outcome: "refused", status } : { outcome: "inconclusive", status });
      };
      answer.on("data", (chunk: Buffer) => {
        if (size < limits.bodyBytes) parts.push(chunk);
        size += chunk.length;
        // Past the cap: decided on what was read (a body too long to be an answer of ours is never read whole).
        if (size >= limits.bodyBytes) decide();
      });
      answer.on("end", decide);
      answer.on("error", () => finish({ outcome: "unreachable", status: null }));
    });
    outgoing.end(body);
  });
}

/** A check's outcome on exactly that person's generation (a late answer never marks a newer one). */
function recordCheck(store: Store, person: string, generation: string, check: SignInCheck, at: string): void {
  store.handle.prepare("UPDATE flexible_sign_in SET check_outcome = ?, check_status = ?, checked_at = ? WHERE person = ? AND generation = ?")
    .run(check.outcome, check.status, at, person, generation);
}

/**
 * Check a person's active sign-in again (the caller proved the person first): its value, read from its own address under
 * the person's lock, checked live, and the outcome written on exactly that generation if it is still the active one.
 * Informational only: it never clears a refusal Claude made on a call, and changes nothing else.
 */
export async function recheckFlexibleSignIn(store: Store, state: string, input: { person: string; clock?: () => Date }): Promise<{ ok: true; check: SignInCheck } | { ok: false; reason: "no-sign-in" }> {
  const clock = input.clock ?? (() => new Date());
  return withSignInLockAsync(state, input.person, async () => {
    const account = store.accountOf(input.person);
    if (account === null) return { ok: false as const, reason: "no-sign-in" as const };
    const found = signInForTurn(store, state, { owner: input.person, ownerGeneration: account.generation });
    const row = activeRowOf(store, input.person);
    // A generation Claude refused on a call is still read for a check (to say so), but nothing about it changes.
    let value: string | null = found.ok ? found.signIn.value : null;
    if (!found.ok && found.reason === "sign-in-refused" && row !== null) { try { value = readSignInSecret(state, row.person, row.generation)?.value ?? null; } catch { value = null; } }
    if (value === null || row === null) return { ok: false as const, reason: "no-sign-in" as const };
    const check = await checkSignInToken(value);
    store.transact(() => {
      if (activeRowOf(store, input.person)?.generation !== row.generation) return;
      recordCheck(store, row.person, row.generation, check, clock().toISOString());
      store.recordAction({ at: clock().toISOString(), actor: input.person, repo: null, taskId: null, runId: null, action: SIGN_IN_ACTION, outcome: "checked", source: "policy", detail: checkOutcomeOf(check) });
    });
    return { ok: true as const, check };
  }, { waitMs: 15_000 });
}

/** A person's threads status in one line (the Agents screen's note on Claude Code): the switch, then their own sign-in,
 * from the records only (the value is never read). */
export function threadsStatusNote(store: Store, person: string): string {
  if (!flexibleAvailable(store)) return "Threads are off for now. An instance operator turns them on in Settings → General.";
  const status = flexibleSignInStatus(store, person);
  if (status.state === "none") return "Threads use your own Claude sign-in: run `claude setup-token`, then `toolroll config set flexible-sign-in`.";
  if (status.state === "refused") return "Claude didn't accept your sign-in for threads. Run `claude setup-token` again and save the new token.";
  return `Threads use the Claude sign-in you saved on ${status.savedAt.slice(0, 10)}. ${signInCheckWords(statusCheck(status))}`;
}

/** Whether a call already sent may go on (the relay, before each piece of its answer and on its watch): the turn's owner
 * is `person`, who still has an active sign-in (a replacement keeps a call going; a removal ends it) at the turn's
 * account generation (a password reset ends it), as an active approver (an account removed or demoted ends it). */
export function signInHoldsFor(store: Store, input: { turn: string; person: string; epoch: number }): boolean {
  const turn = store.handle.prepare("SELECT owner, owner_generation FROM thread_turn WHERE id = ?").get(input.turn);
  if (turn === undefined || turn["owner"] !== input.person) return false;
  // No removal since the call was dispatched (a removal and a fresh save between two checks still moved the epoch).
  if (signInEpochOf(store, input.person) !== input.epoch) return false;
  const generation = Number(turn["owner_generation"]);
  const row = activeRowOf(store, input.person);
  return row !== null && row.accountGeneration === generation && standingAccount(store, input.person, generation);
}

/** A person's removal epoch (flexible_sign_in_epoch; 0 when it never moved): raised only by a removal of their sign-in
 * and a restore's reset, never by a save or an ordinary replacement. A call dispatched under one epoch stops when it
 * moves. */
export function signInEpochOf(store: Store, person: string): number {
  const row = store.handle.prepare("SELECT epoch FROM flexible_sign_in_epoch WHERE person = ?").get(person);
  return row === undefined ? 0 : Number(row["epoch"]);
}
/** Raise a person's removal epoch, in the caller's transaction. */
function raiseSignInEpoch(store: Store, person: string): void {
  store.handle.prepare("INSERT INTO flexible_sign_in_epoch (person, epoch) VALUES (?, 1) ON CONFLICT (person) DO UPDATE SET epoch = epoch + 1").run(person);
}

/** Metadata-only interactive check, inside the caller's activation transaction. No secret or installation fallback. */
export function signInForInteractiveStands(store: Store, sessionId: string): boolean {
  const session = store.handle.prepare("SELECT * FROM flexible_interactive_session WHERE id = ? AND state IN ('prepared', 'active')").get(sessionId);
  if (session === undefined || session["provider"] !== "claude" || session["billing"] !== "subscription") return false;
  const thread = store.handle.prepare("SELECT created_by FROM flexible_thread WHERE id = ?").get(session["thread"]);
  if (thread === undefined || thread["created_by"] !== session["owner"] || signInEpochOf(store, String(session["owner"])) !== session["sign_in_epoch"]) return false;
  const billing = flexibleSignInBilling(store, { name: String(session["owner"]), generation: Number(session["account_generation"]) });
  return billing.ok && billing.billing === "subscription";
}
