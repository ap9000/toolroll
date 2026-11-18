/**
 * Threads for everyday use, slice S6 (the owner's D2; Codex round 2): a password typed into a form counts for a local
 * owner's session on a closed list of acts only (local-owner.ts LOCAL_PASSWORD_ACTS), checked in proveAccountNow BEFORE
 * the local owner's own act could answer. The account's real password, through the sign-in lockouts; empty or wrong
 * proves nothing and never falls back to the act; right is "password-now" for that one act only (no remembered password
 * stamped, the session unchanged); every other act keeps today's rule, a typed password included.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { asLocalOwner, LOCAL_PASSWORD_ACTS, type LocalOwnerAct, type LocalPrincipal } from "./local-owner.js";
import { enrollOwnerPassword, initLocalMode, localModeOf, openStore, type Store } from "./store.js";
import { freshFacts, hashPassword, proveAccountNow, type FreshFacts } from "./scope.js";

const NOW = new Date("2026-11-18T10:00:00.000Z");
const PASSWORD = "correct horse battery";
let store: Store;

beforeEach(() => {
  store = openStore(":memory:", { createdBy: "laptop" });
  const init = initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW });
  if (!init.ok) throw new Error(init.reason);
  expect(enrollOwnerPassword(store, "alex", hashPassword(PASSWORD), localModeOf(store)!.generation, NOW)).toMatchObject({ ok: true });
});
afterEach(() => { store.close(); });

const principal = (act: LocalOwnerAct, over: Partial<LocalPrincipal> = {}): LocalPrincipal => ({ account: "alex", localGeneration: localModeOf(store)!.generation,
  accountGeneration: store.accountOf("alex")!.generation, transport: "browser", act, sessionHash: null, request: { ended: false }, ...over });
/** A browser request's freshness facts, watching whether anything stamps a remembered password. */
function facts() {
  const stamped: number[] = [];
  const made: FreshFacts = { actor: "alex", local: true, allowlisted: true, live: () => true, passwordAt: () => null, ssoReauthAt: () => null, ssoNow: () => null,
    consumeSsoNow: () => () => {}, floor: () => 0, stamp: at => { stamped.push(at); } };
  return { made, stamped };
}
const prove = (act: LocalOwnerAct, token: string, options: { credential?: boolean } = {}, over: Partial<LocalPrincipal> = {}) => {
  const { made, stamped } = facts();
  const proved = freshFacts.run(made, () => asLocalOwner(principal(act, over), () => proveAccountNow(store, "alex", token, options)));
  return { proved, stamped };
};

describe("the closed list", () => {
  test("is exactly the thread setup's credential steps", () => {
    expect([...LOCAL_PASSWORD_ACTS].sort()).toEqual(["flexible-sign-in-check", "flexible-sign-in-save", "flexible-switch", "project-flexible"]);
  });

  test.each([...LOCAL_PASSWORD_ACTS])("%s: the real password typed now is password-now (a credential act's proof), for this act only, and stamps nothing", act => {
    const { proved, stamped } = prove(act, PASSWORD, { credential: true });
    expect(proved).toMatchObject({ ok: true, method: "password-now" });
    expect(stamped).toEqual([]);
  });

  test.each([...LOCAL_PASSWORD_ACTS])("%s: empty or wrong proves nothing and never falls back to the local owner's own act", act => {
    expect(prove(act, "").proved).toEqual({ ok: false, reason: "not-an-approver" });
    expect(prove(act, "not the password").proved).toEqual({ ok: false, reason: "not-an-approver" });
    // Not the credential form either: the act itself is never its proof.
    expect(prove(act, "", { credential: false }).proved).toEqual({ ok: false, reason: "not-an-approver" });
  });

  test("a binding that no longer stands proves nothing, the right password typed or not", () => {
    expect(prove("flexible-sign-in-save", PASSWORD, {}, { accountGeneration: store.accountOf("alex")!.generation - 1 }).proved).toEqual({ ok: false, reason: "not-an-approver" });
    expect(prove("flexible-sign-in-save", PASSWORD, {}, { request: { ended: true } }).proved).toEqual({ ok: false, reason: "not-an-approver" });
    expect(prove("flexible-sign-in-save", PASSWORD, {}, { account: "robin" }).proved).toEqual({ ok: false, reason: "not-an-approver" });
  });

  test("wrong passwords count toward the lockout, as any sign-in's do: then even the right one is refused", () => {
    for (let one = 0; one < 5; one++) expect(prove("flexible-switch", `wrong-${one}`).proved.ok).toBe(false);
    expect(prove("flexible-switch", PASSWORD, { credential: true }).proved).toEqual({ ok: false, reason: "not-an-approver" });
  });
});

describe("every other act keeps today's rule", () => {
  test("an act off the list: a typed password never upgrades it to a credential act, and its own act answers only ordinary step-ups", () => {
    expect(prove("approve-plan", PASSWORD, { credential: true }).proved).toEqual({ ok: false, reason: "not-an-approver" });
    expect(prove("approve-plan", "").proved).toMatchObject({ ok: true, method: "local-owner" });
    // Removing your own sign-in only narrows: the act itself, no password.
    expect(prove("flexible-sign-in-clear", "").proved).toMatchObject({ ok: true, method: "local-owner" });
    expect(prove("flexible-sign-in-clear", PASSWORD, { credential: true }).proved).toEqual({ ok: false, reason: "not-an-approver" });
  });
});
