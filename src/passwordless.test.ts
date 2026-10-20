/**
 * Passwordless (docs/plans/passwordless.md): with it on, a person's own live browser session — or this computer's CLI
 * remembered login — stands in for the password at every step-up, and never at a credential act. Off, nothing changes.
 */
import { describe, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { addApprover, credentialProof, freshFacts, proveAccountNow, proveCredential, rememberedLogin, type FreshFacts } from "./scope.js";
import { passwordlessOn, passwordlessSetting, setPasswordless } from "./passwordless.js";

const T0 = new Date("2026-10-20T10:00:00.000Z");

function setup(): { store: Store; password: string } {
  const store = openStore(":memory:");
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap failed");
  return { store, password: added.token };
}

/** A browser request's facts, as serve.ts makes them. */
function facts(over: { actor?: string; live?: boolean } = {}): FreshFacts {
  const live = over.live ?? true;
  return { actor: over.actor ?? "alex", local: true, allowlisted: false, live: () => live, passwordAt: () => null, ssoReauthAt: () => null,
    ssoNow: () => null, consumeSsoNow: () => () => {}, floor: () => 0, stamp: () => {} };
}

describe("the setting", () => {
  test("off until an operator turns it on; the ledger keeps who and when", () => {
    const { store } = setup();
    expect(passwordlessSetting(store)).toEqual({ on: false, setBy: null, at: null });
    expect(setPasswordless(store, true, "alex", T0)).toEqual({ changed: true });
    expect(passwordlessSetting(store)).toMatchObject({ on: true, setBy: "alex" });
    expect(setPasswordless(store, true, "alex", T0)).toEqual({ changed: false });
    setPasswordless(store, false, "alex", T0);
    expect(passwordlessOn(store)).toBe(false);
  });

  test("a setting that can't be read is off (fail closed)", () => {
    expect(passwordlessOn({} as Store)).toBe(false);
  });
});

describe("the one reading in proveAccountNow", () => {
  test("off: an empty password from a live browser session is refused, as always", () => {
    const { store } = setup();
    expect(freshFacts.run(facts(), () => proveAccountNow(store, "alex", "")).ok).toBe(false);
  });

  test("on: the person's own live browser session proves the act, as 'session'", () => {
    const { store } = setup();
    setPasswordless(store, true, "alex", T0);
    expect(freshFacts.run(facts(), () => proveAccountNow(store, "alex", ""))).toMatchObject({ ok: true, method: "session" });
  });

  test("on, but not the person's own, not live, or no browser at all: refused", () => {
    const { store } = setup();
    setPasswordless(store, true, "alex", T0);
    expect(freshFacts.run(facts({ actor: "sam" }), () => proveAccountNow(store, "alex", "")).ok).toBe(false);
    expect(freshFacts.run(facts({ live: false }), () => proveAccountNow(store, "alex", "")).ok).toBe(false);
    // A CLI, a token, a chat bridge or a background job carries no facts.
    expect(proveAccountNow(store, "alex", "").ok).toBe(false);
    // Detached work started inside a request runs with the facts cleared (server/chat.ts).
    expect(freshFacts.run(facts(), () => freshFacts.run(null, () => proveAccountNow(store, "alex", ""))).ok).toBe(false);
  });

  test("on: a wrong typed password is still refused; a right one is still 'password-now'", () => {
    const { store, password } = setup();
    setPasswordless(store, true, "alex", T0);
    expect(freshFacts.run(facts(), () => proveAccountNow(store, "alex", "wrong-password")).ok).toBe(false);
    expect(freshFacts.run(facts(), () => proveAccountNow(store, "alex", password))).toMatchObject({ ok: true, method: "password-now" });
  });
});

describe("credential acts", () => {
  test("never accept the session; a typed password still works", () => {
    const { store, password } = setup();
    setPasswordless(store, true, "alex", T0);
    expect(freshFacts.run(facts(), () => proveCredential(store, "alex", "")).ok).toBe(false);
    expect(freshFacts.run(facts(), () => proveCredential(store, "alex", password))).toMatchObject({ ok: true, method: "password-now" });
    expect(credentialProof("session")).toBe(false);
    expect(credentialProof("cli-login")).toBe(false);
    expect(credentialProof("fresh-password")).toBe(false);
    expect(credentialProof("sso-now")).toBe(true);
  });

  test("creating an approver is one: a session can't vouch for a new approver", () => {
    const { store, password } = setup();
    setPasswordless(store, true, "alex", T0);
    expect(freshFacts.run(facts(), () => addApprover(store, "sam", T0, { name: "alex", token: "" })).ok).toBe(false);
    expect(addApprover(store, "sam", T0, { name: "alex", token: password }).ok).toBe(true);
  });
});

describe("the CLI's remembered login", () => {
  test("on: an act proved with it records 'cli-login', and no credential act accepts it", () => {
    const { store, password } = setup();
    setPasswordless(store, true, "alex", T0);
    rememberedLogin.run({ login: { name: "alex", token: password } }, () => {
      expect(proveAccountNow(store, "alex", password)).toMatchObject({ ok: true, method: "cli-login" });
      expect(proveCredential(store, "alex", password).ok).toBe(false);
    });
  });

  test("off: exactly today's behaviour (a remembered password reads as a password)", () => {
    const { store, password } = setup();
    rememberedLogin.run({ login: { name: "alex", token: password } }, () => {
      expect(proveAccountNow(store, "alex", password)).toMatchObject({ ok: true, method: "password-now" });
      expect(proveCredential(store, "alex", password).ok).toBe(true);
    });
  });

  test("a password typed for this command is never mistaken for the remembered one", () => {
    const { store, password } = setup();
    setPasswordless(store, true, "alex", T0);
    rememberedLogin.run({ login: { name: "alex", token: "an-old-remembered-password" } }, () => {
      expect(proveCredential(store, "alex", password)).toMatchObject({ ok: true, method: "password-now" });
    });
  });
});

describe("round 1 of the implementation review", () => {
  test("a credential act takes a fresh identity-provider re-check under Passwordless (the session never stands in)", () => {
    const { store } = setup();
    setPasswordless(store, true, "alex", T0);
    let spent = false;
    const withSso: FreshFacts = { ...facts(), ssoNow: () => (spent ? null : Date.now()), consumeSsoNow: () => { spent = true; return () => { spent = false; }; } };
    expect(freshFacts.run(withSso, () => proveCredential(store, "alex", ""))).toMatchObject({ ok: true, method: "sso-now" });
    expect(spent).toBe(true);
    // An ordinary act still takes the session and leaves the re-check unspent.
    let spent2 = false;
    const again: FreshFacts = { ...facts(), ssoNow: () => (spent2 ? null : Date.now()), consumeSsoNow: () => { spent2 = true; return () => {}; } };
    expect(freshFacts.run(again, () => proveAccountNow(store, "alex", ""))).toMatchObject({ ok: true, method: "session" });
    expect(spent2).toBe(false);
  });

  test("the remembered-login mark belongs to one command's holder: a fresh holder has none", () => {
    const { store, password } = setup();
    setPasswordless(store, true, "alex", T0);
    const first = { login: { name: "alex", token: password } as { name: string; token: string } | null };
    rememberedLogin.run(first, () => expect(proveAccountNow(store, "alex", password).method).toBe("cli-login"));
    rememberedLogin.run({ login: null }, () => expect(proveAccountNow(store, "alex", password)).toMatchObject({ ok: true, method: "password-now" }));
  });
});
