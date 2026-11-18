/**
 * Each person's own Claude sign-in for threads (flexible-sign-in.ts; tool-secret-store.ts's sign-in addresses; backup.ts's
 * restore reset). Security rules and data integrity only, against isolated stores and state folders, the test's own
 * owner-only files (test/setup-state.ts) or an in-memory stand-in for a keychain: no real keychain, token or model.
 *
 * The rows named "R2"–"R5" are Codex's final requirements (the plan's acceptance criteria), one named test each; "R1"
 * (the dispatch invariant) is in src/flexible-relay-sign-in.test.ts, against the real relay.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, type Store } from "./store.js";
import { setFlexibleSetting } from "./flexible-available.js";
import { freshFacts, hashPassword, type FreshFacts } from "./scope.js";
import { chooseSecretStore, createSignInSecret, readHeldSecret, readSignInSecret, removeSignInSecret, SecretStoreError, writeHeldSecret, type SecretBackend } from "./tool-secret-store.js";
import { activateFlexibleSignIn, flexibleSignInBilling, flexibleSignInStatus, removeFlexibleSignIn, saveFlexibleSignIn, setupTokenFromPaste, signInForTurn, stageFlexibleSignIn, tidyFlexibleSignIns,
  SIGN_IN_STAGE_MS, type StagedSignIn } from "./flexible-sign-in.js";
import { onlineCopy, restoreDatabase } from "./backup.js";
import { V172_ADDED_COLUMNS, V172_TABLES } from "./flexible-sign-in-schema.js";
import { standInToken } from "../test/flexible-sign-in-kit.js";
import { flexibleReadiness } from "./flexible-start.js";
import { threadsStatusNote } from "./flexible-sign-in.js";
import { PASSWORDLESS_ACTION } from "./passwordless.js";

// Two names forced into one address slot (tool-secret-store.ts signInAddress), only where a test asks. The setup file
// loads the secret store before this file's mocks, so the test that forces it loads the store afresh.
const forced = vi.hoisted(() => ({ slot: null as string | null }));
vi.mock("./flexible-sign-in-slot.js", async original => {
  const real = await original<typeof import("./flexible-sign-in-slot.js")>();
  return { signInSlot: (person: string) => forced.slot ?? real.signInSlot(person) };
});

const NOW = new Date("2026-11-17T12:00:00.000Z");
const PASSWORD = "alex-password-1", BOB = "bob-password-22";
let dir: string, state: string, file: string, store: Store;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-sign-in-")));
  state = join(dir, "toolroll");
  mkdirSync(state);
  file = join(state, "orders.db");
  store = openStore(file);
  store.saveApprover("alex", hashPassword(PASSWORD), NOW);
  store.saveApprover("bob", hashPassword(BOB), NOW);
  setFlexibleSetting(store, true, "alex", NOW);
});
afterEach(() => {
  forced.slot = null;
  chooseSecretStore(null);
  try { store.close(); } catch { /* closed by the test */ }
  rmSync(dir, { recursive: true, force: true });
});

const rows = (person = "alex") => store.handle.prepare("SELECT generation, state, save_op, proof FROM flexible_sign_in WHERE person = ? ORDER BY staged_at, generation").all(person).map(row => ({ ...row }));
const active = (person = "alex") => store.handle.prepare("SELECT generation FROM flexible_sign_in WHERE person = ? AND state = 'active'").get(person)?.["generation"] as string | undefined;
const ledger = () => store.handle.prepare("SELECT actor, outcome FROM action_ledger WHERE action = 'claude sign-in for threads' ORDER BY id").all().map(row => ({ ...row }));
const files = () => { const at = join(state, "tool-secrets", "flexible-sign-in"); return existsSync(at) ? readdirSync(at).sort() : []; };
const accountGeneration = (person = "alex") => store.accountOf(person)!.generation;
/** An in-memory stand-in for a keychain (never the computer's own). */
function memoryKeychain(): SecretBackend & { items: Map<string, string>; failing: boolean } {
  const items = new Map<string, string>();
  const key = (item: { service: string; account: string }) => `${item.service}/${item.account}`;
  const backend = { kind: "macos-keychain" as const, limit: 3000, items, failing: false,
    get(item: { service: string; account: string }) { if (backend.failing) throw new SecretStoreError("The macOS Keychain refused to read a tool's secrets. Unlock it and try again."); return items.get(key(item)) ?? null; },
    set(item: { service: string; account: string }, value: string, options: { create?: boolean } = {}) {
      if (backend.failing) throw new SecretStoreError("The macOS Keychain refused to save a tool's secrets. Unlock it and try again.");
      if (options.create === true && items.has(key(item))) return "exists" as const;
      items.set(key(item), value);
      return "ok" as const;
    },
    remove(item: { service: string; account: string }) { if (backend.failing) throw new SecretStoreError("The macOS Keychain refused to remove a tool's secrets."); items.delete(key(item)); },
  };
  return backend;
}
/** A browser request's live facts for `actor`: a one-use identity-provider re-check waiting, its session `live()`. */
function ssoFacts(actor: string, live: { on: boolean }): FreshFacts & { consumed: number } {
  let waiting: number | null = Date.now();
  const facts = { actor, local: true, allowlisted: false, consumed: 0, live: () => live.on, passwordAt: () => null, ssoReauthAt: () => null, ssoNow: () => waiting,
    consumeSsoNow: () => { facts.consumed++; const was = waiting; waiting = null; return () => { waiting = was; }; }, floor: () => 0, stamp: () => {} };
  return facts;
}
const save = (person: string, password: string, token: string, seams = {}) => saveFlexibleSignIn(store, { state, person, password, token, check: false, clock: () => NOW, seams });

describe("saving: staged, placed, activated; the one before retired", () => {
  test("a save with the password typed now: one active row at the account's generation, the value at its own address, ledgered; a replace retires the old one and deletes its secret", async () => {
    const first = standInToken(), second = standInToken();
    const saved = await save("alex", PASSWORD, first);
    expect(saved).toMatchObject({ ok: true, replaced: false });
    const g1 = active()!;
    expect(rows()).toEqual([{ generation: g1, state: "active", save_op: null, proof: "password-now" }]);
    expect(readSignInSecret(state, "alex", g1)).toEqual({ person: "alex", generation: g1, kind: "setup-token", value: first });
    expect(flexibleSignInBilling(store, { name: "alex", generation: accountGeneration() })).toEqual({ ok: true, billing: "subscription" });
    expect(await save("alex", PASSWORD, second)).toMatchObject({ ok: true, replaced: true });
    const g2 = active()!;
    expect(g2).not.toBe(g1);
    expect(rows()).toEqual([{ generation: g2, state: "active", save_op: null, proof: "password-now" }]);
    expect(readSignInSecret(state, "alex", g1)).toBeNull();
    expect(files()).toHaveLength(1);
    expect(ledger()).toEqual([{ actor: "alex", outcome: "saved" }, { actor: "alex", outcome: "replaced" }, { actor: "upkeep", outcome: "retired" }]);
    // Never the value, in any row or the ledger.
    const everything = JSON.stringify(store.handle.prepare("SELECT * FROM flexible_sign_in").all()) + JSON.stringify(store.handle.prepare("SELECT * FROM action_ledger").all());
    for (const value of [first, second]) expect(everything).not.toContain(value.slice(14, 30));
  });

  test("who may save: a wrong password, a viewer, a revoked account, threads off, a bad paste: nothing staged, kept or ledgered", async () => {
    const token = standInToken();
    expect(await save("alex", "not-it", token)).toMatchObject({ ok: false, reason: "not-proved" });
    expect(await save("alex", "", token)).toMatchObject({ ok: false, reason: "not-proved" }); // no re-check waiting, no session stands in
    store.handle.prepare("UPDATE approver SET role = 'viewer' WHERE name = 'bob'").run();
    expect(await save("bob", BOB, token)).toMatchObject({ ok: false, reason: "not-proved" });
    setFlexibleSetting(store, false, "alex", NOW);
    expect(await save("alex", PASSWORD, token)).toMatchObject({ ok: false, reason: "not-available" });
    setFlexibleSetting(store, true, "alex", NOW);
    const key = ["sk", "ant", "api03", "k".repeat(40)].join("-");
    const refusal = await save("alex", PASSWORD, key);
    expect(refusal).toMatchObject({ ok: false, reason: "api-key" });
    expect(JSON.stringify(refusal)).not.toContain("k".repeat(8));
    expect(await save("alex", PASSWORD, "garbage-garbage-garbage")).toMatchObject({ ok: false, reason: "shape" });
    expect(rows()).toEqual([]);
    expect(rows("bob")).toEqual([]);
    expect(files()).toEqual([]);
    expect(ledger()).toEqual([]);
    // Passwordless on, and alex's own live browser session: a session standing in never proves a credential act.
    store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: null, taskId: null, runId: null, action: PASSWORDLESS_ACTION, outcome: "on", source: "policy" });
    expect(freshFacts.run(ssoFacts("alex", { on: true }), () => { const facts = freshFacts.getStore()!; facts.consumeSsoNow(); return stageFlexibleSignIn(store, { person: "alex", password: "", now: NOW }); }))
      .toMatchObject({ ok: false, reason: "not-proved" });
    expect(rows()).toEqual([]);
    // A paste wrapped across lines is the same token.
    expect(setupTokenFromPaste(`${token.slice(0, 20)}\n  ${token.slice(20)}\r\n`)).toEqual({ ok: true, token });
  });

  test("faults at each step leave the working sign-in working: a keychain that refuses to save, a process gone after A or after the value is placed, and B failing", async () => {
    const working = standInToken();
    await save("alex", PASSWORD, working);
    const g1 = active()!;
    const keychain = memoryKeychain();
    // The keychain refuses the new value: nothing new is active, the staged row is retired.
    keychain.failing = true;
    chooseSecretStore(keychain);
    const kept = await save("alex", PASSWORD, standInToken());
    expect(kept).toMatchObject({ ok: false, reason: "not-saved" });
    chooseSecretStore(null);
    expect(active()).toBe(g1);
    // Gone right after A (a process that died): the staged row waits out its time; the working one stays.
    await expect(save("alex", PASSWORD, standInToken(), { afterStage: () => { throw new Error("gone"); } })).rejects.toThrow("gone");
    // Gone right after the value is placed: likewise, its secret sits at its own address only.
    await save("alex", PASSWORD, standInToken(), { afterPlace: () => { throw new Error("gone"); } }).catch(() => null);
    expect(active()).toBe(g1);
    expect(readSignInSecret(state, "alex", g1)!.value).toBe(working);
    // The upkeep never deletes a staged generation before its time, nor the active one.
    await tidyFlexibleSignIns(store, state, { now: NOW });
    expect(rows().filter(row => row["state"] === "staged")).toHaveLength(1);
    expect(readSignInSecret(state, "alex", g1)!.value).toBe(working);
    // Past its time it is retired and its secret deleted; the active one stays.
    await tidyFlexibleSignIns(store, state, { now: new Date(NOW.getTime() + SIGN_IN_STAGE_MS + 1) });
    expect(rows()).toEqual([{ generation: g1, state: "active", save_op: null, proof: "password-now" }]);
    expect(files()).toHaveLength(1);
    // B failing (the account changed in between: a password reset) activates nothing; the reset ends the old one too.
    const reset = await save("alex", PASSWORD, standInToken(), { afterPlace: () => { store.saveApprover("alex", hashPassword(PASSWORD), NOW); } });
    expect(reset).toMatchObject({ ok: false, reason: "save-ended" });
    expect(flexibleSignInBilling(store, { name: "alex", generation: accountGeneration() })).toEqual({ ok: false, reason: "no-sign-in" });
    await tidyFlexibleSignIns(store, state, { now: NOW });
    expect(rows()).toEqual([]);
    expect(files()).toEqual([]);
  });

  test("a keychain that refuses to delete leaves the retiring row, and a later tick retires it once it answers", async () => {
    const keychain = memoryKeychain();
    chooseSecretStore(keychain);
    await save("alex", PASSWORD, standInToken());
    const g1 = active()!;
    removeFlexibleSignIn(store, { person: "alex", by: "alex", now: NOW });
    keychain.failing = true;
    expect(await tidyFlexibleSignIns(store, state, { now: NOW })).toMatchObject({ deleted: 0 });
    expect(rows()).toEqual([{ generation: g1, state: "retiring", save_op: null, proof: "password-now" }]);
    keychain.failing = false;
    expect(await tidyFlexibleSignIns(store, state, { now: NOW })).toMatchObject({ deleted: 1 });
    expect(rows()).toEqual([]);
    expect([...keychain.items.keys()].some(key => key.includes("flexible-sign-in"))).toBe(false);
  });

  test("readiness reads the record only: with the value gone from its address, billing and status still read, and the relay finds no sign-in", async () => {
    await save("alex", PASSWORD, standInToken());
    const g1 = active()!;
    for (const name of files()) rmSync(join(state, "tool-secrets", "flexible-sign-in", name));
    expect(flexibleSignInBilling(store, { name: "alex", generation: accountGeneration() })).toEqual({ ok: true, billing: "subscription" });
    expect(flexibleSignInStatus(store, "alex")).toMatchObject({ state: "active", generation: g1 });
    expect(flexibleSignInBilling(store, { name: "alex", generation: accountGeneration() + 1 })).toEqual({ ok: false, reason: "no-sign-in" });
    expect(signInForTurn(store, state, { owner: "alex", ownerGeneration: accountGeneration() })).toEqual({ ok: false, reason: "no-sign-in" });
    expect(signInForTurn(store, state, { owner: "bob", ownerGeneration: accountGeneration("bob") })).toEqual({ ok: false, reason: "no-sign-in" });
  });
});

describe("R2: removal cancels pending saves", () => {
  test("R2 removal retires the person's active AND staged rows in one transaction, without the keychain or the network", async () => {
    await save("alex", PASSWORD, standInToken());
    const staged = stageFlexibleSignIn(store, { person: "alex", password: PASSWORD, now: NOW });
    if (!staged.ok) throw new Error(staged.message);
    // A keychain that refuses everything: removal doesn't wait on it or fail with it.
    const keychain = memoryKeychain();
    keychain.failing = true;
    chooseSecretStore(keychain);
    expect(removeFlexibleSignIn(store, { person: "alex", by: "alex", now: NOW })).toEqual({ removed: true });
    expect(rows().map(row => row["state"])).toEqual(["retiring", "retiring"]);
    expect(rows().every(row => row["save_op"] === null)).toBe(true);
    expect(flexibleSignInBilling(store, { name: "alex", generation: accountGeneration() })).toEqual({ ok: false, reason: "no-sign-in" });
    expect(ledger().at(-1)).toEqual({ actor: "alex", outcome: "removed" });
    // An operator removes someone else's (narrowing only), ledgered as theirs.
    chooseSecretStore(null);
    await save("bob", BOB, standInToken());
    expect(removeFlexibleSignIn(store, { person: "bob", by: "alex", now: NOW })).toEqual({ removed: true });
    expect(active("bob")).toBeUndefined();
  });

  test("R2 removal between A and B: activation fails, whether or not an active sign-in existed, and the staged value is deleted", async () => {
    for (const withActive of [true, false]) {
      if (withActive) await save("alex", PASSWORD, standInToken());
      const result = await save("alex", PASSWORD, standInToken(), { afterPlace: () => { removeFlexibleSignIn(store, { person: "alex", by: "alex", now: NOW }); } });
      expect(result, `with an active sign-in: ${withActive}`).toMatchObject({ ok: false, reason: "save-ended" });
      expect(active()).toBeUndefined();
      await tidyFlexibleSignIns(store, state, { now: NOW });
      expect(rows()).toEqual([]);
      expect(files()).toEqual([]);
    }
    // Directly too: a staged save whose row was retired is never activated.
    const staged = stageFlexibleSignIn(store, { person: "alex", password: PASSWORD, now: NOW });
    if (!staged.ok) throw new Error(staged.message);
    removeFlexibleSignIn(store, { person: "alex", by: "alex", now: NOW });
    expect(activateFlexibleSignIn(store, { staged: staged.staged, password: PASSWORD, now: NOW })).toMatchObject({ ok: false, reason: "save-ended" });
  });
});

describe("R3: the activation proof", () => {
  const stageWithSso = (facts: FreshFacts) => freshFacts.run(facts, () => stageFlexibleSignIn(store, { person: "alex", password: "", now: NOW }));
  const activateWithSso = (facts: FreshFacts, staged: StagedSignIn) => freshFacts.run(facts, () => activateFlexibleSignIn(store, { staged, password: "", now: NOW }));

  test("R3 transaction A consumes the one-use re-check and binds it to this person, account generation, staged generation and save", () => {
    const live = { on: true };
    const facts = ssoFacts("alex", live);
    const staged = stageWithSso(facts);
    if (!staged.ok) throw new Error(staged.message);
    expect(facts.consumed).toBe(1);
    expect(staged.staged).toMatchObject({ person: "alex", accountGeneration: accountGeneration(), proof: "sso-now" });
    expect(store.handle.prepare("SELECT person, account_generation, state, save_op, proof FROM flexible_sign_in WHERE generation = ?").get(staged.staged.generation))
      .toEqual(expect.objectContaining({ person: "alex", account_generation: accountGeneration(), state: "staged", save_op: expect.stringMatching(/^[0-9a-f]{32}$/), proof: "sso-now" }));
    // The row keeps a hash of the save's capability, never the capability.
    expect(JSON.stringify(store.handle.prepare("SELECT * FROM flexible_sign_in").all())).not.toContain(staged.staged.op);
    // Spent: a second A in the same request has nothing to stand on.
    expect(stageWithSso(facts)).toMatchObject({ ok: false, reason: "not-proved" });
    // Another person's request facts never prove alex.
    expect(freshFacts.run(ssoFacts("bob", live), () => stageFlexibleSignIn(store, { person: "alex", password: "", now: NOW }))).toMatchObject({ ok: false, reason: "not-proved" });
    expect(activateWithSso(facts, staged.staged)).toEqual({ ok: true, replaced: false });
  });

  test("R3 replay: the pending activation is consumed exactly once", () => {
    const facts = ssoFacts("alex", { on: true });
    const staged = stageWithSso(facts);
    if (!staged.ok) throw new Error(staged.message);
    expect(activateWithSso(facts, staged.staged)).toEqual({ ok: true, replaced: false });
    expect(activateWithSso(facts, staged.staged)).toMatchObject({ ok: false, reason: "save-ended" });
    expect(ledger()).toEqual([{ actor: "alex", outcome: "saved" }]);
  });

  test("R3 a sign-out or a revoked session between A and B refuses B; so does a changed account", () => {
    const live = { on: true };
    const facts = ssoFacts("alex", live);
    const staged = stageWithSso(facts);
    if (!staged.ok) throw new Error(staged.message);
    live.on = false; // signed out, or the session revoked or rotated
    expect(activateWithSso(facts, staged.staged)).toMatchObject({ ok: false, reason: "not-proved" });
    live.on = true;
    // B outside the request that made A (no facts at all), or with a password instead: refused.
    expect(activateFlexibleSignIn(store, { staged: staged.staged, password: "", now: NOW })).toMatchObject({ ok: false, reason: "not-proved" });
    expect(freshFacts.run(facts, () => activateFlexibleSignIn(store, { staged: staged.staged, password: PASSWORD, now: NOW }))).toMatchObject({ ok: false, reason: "not-proved" });
    // The account revoked in between.
    store.handle.prepare("UPDATE approver SET revoked_at = ? WHERE name = 'alex'").run(NOW.toISOString());
    expect(activateWithSso(facts, staged.staged)).toMatchObject({ ok: false, reason: "save-ended" });
    expect(active()).toBeUndefined();
  });

  test("R3 B takes the capability only from the very request that made it: another live request of the same person refuses", () => {
    const facts = ssoFacts("alex", { on: true });
    const staged = stageWithSso(facts);
    if (!staged.ok) throw new Error(staged.message);
    // Another request (another tab or session) of alex's, signed in and live, holding the staged save: refused.
    expect(activateWithSso(ssoFacts("alex", { on: true }), staged.staged)).toMatchObject({ ok: false, reason: "not-proved" });
    expect(active()).toBeUndefined();
    // The request that made it: activated, once.
    expect(activateWithSso(facts, staged.staged)).toEqual({ ok: true, replaced: false });
  });

  test("R3 activating another generation, or with another save's op, refuses", () => {
    const facts = ssoFacts("alex", { on: true });
    const first = stageWithSso(facts);
    if (!first.ok) throw new Error(first.message);
    const second = stageFlexibleSignIn(store, { person: "alex", password: PASSWORD, now: NOW });
    if (!second.ok) throw new Error(second.message);
    // first's op on second's generation, second's op on first's, and a made-up generation: none activates.
    expect(activateWithSso(facts, { ...first.staged, generation: second.staged.generation })).toMatchObject({ ok: false, reason: "save-ended" });
    expect(activateWithSso(facts, { ...first.staged, op: second.staged.op })).toMatchObject({ ok: false, reason: "save-ended" });
    expect(activateWithSso(facts, { ...first.staged, generation: "e".repeat(32) })).toMatchObject({ ok: false, reason: "save-ended" });
    // Nor bob's save, under alex's binding.
    expect(activateWithSso(facts, { ...first.staged, person: "bob" })).toMatchObject({ ok: false, reason: "save-ended" });
    expect(active()).toBeUndefined();
  });

  test("R3 the password path checks the password typed now again at B", () => {
    const staged = stageFlexibleSignIn(store, { person: "alex", password: PASSWORD, now: NOW });
    if (!staged.ok) throw new Error(staged.message);
    expect(staged.staged.proof).toBe("password-now");
    expect(activateFlexibleSignIn(store, { staged: staged.staged, password: "not-it", now: NOW })).toMatchObject({ ok: false, reason: "not-proved" });
    expect(activateFlexibleSignIn(store, { staged: staged.staged, password: "", now: NOW })).toMatchObject({ ok: false, reason: "not-proved" });
    expect(freshFacts.run(ssoFacts("alex", { on: true }), () => activateFlexibleSignIn(store, { staged: staged.staged, password: "", now: NOW }))).toMatchObject({ ok: false, reason: "not-proved" });
    expect(activateFlexibleSignIn(store, { staged: staged.staged, password: PASSWORD, now: new Date(NOW.getTime() + SIGN_IN_STAGE_MS) })).toMatchObject({ ok: false, reason: "save-ended" });
    expect(activateFlexibleSignIn(store, { staged: staged.staged, password: PASSWORD, now: NOW })).toEqual({ ok: true, replaced: false });
  });
});

describe("R4: the dedicated, validated sign-in address", () => {
  test("R4 the address is its own: not a held-secret name, validated, in the installation's own service namespace", () => {
    const generation = "a".repeat(32), value = standInToken();
    // The held-secret road refuses the dotted-hex name outright (its keychain address check).
    chooseSecretStore(memoryKeychain());
    expect(() => readHeldSecret(state, `flexible-sign-in.${"0".repeat(16)}.${generation}`, ["x.json"])).toThrow(/address can't be used/);
    expect(() => writeHeldSecret(state, `flexible-sign-in.${"0".repeat(16)}.${generation}`, ["x.json"], value)).toThrow(/address can't be used/);
    chooseSecretStore(null);
    for (const [person, gen] of [["", generation], ["alex", "A".repeat(32)], ["alex", "a".repeat(31)], ["alex", "../../etc"], ["x".repeat(201), generation]]) {
      expect(() => createSignInSecret(state, { person: person!, generation: gen!, kind: "setup-token", value }), `${person} ${gen}`).toThrow(SecretStoreError);
    }
    expect(() => createSignInSecret(state, { person: "alex", generation, kind: "setup-token", value: "sk-ant-api03-nope" })).toThrow(SecretStoreError);
    const keychain = memoryKeychain();
    chooseSecretStore(keychain);
    expect(createSignInSecret(state, { person: "alex", generation, kind: "setup-token", value })).toBe("ok");
    expect([...keychain.items.keys()]).toEqual([expect.stringMatching(/^toolroll-tool-secrets\.[0-9a-f]{12}\/flexible-sign-in\.[0-9a-f]{16}\.a{32}$/)]);
    expect(readSignInSecret(state, "alex", generation)!.value).toBe(value);
  });

  test("R4 creation is immutable: an address in use is never overwritten, in files or a keychain", () => {
    const generation = "b".repeat(32), first = standInToken(), second = standInToken();
    for (const backend of [null, memoryKeychain()] as const) {
      chooseSecretStore(backend ?? "files");
      expect(createSignInSecret(state, { person: "alex", generation, kind: "setup-token", value: first })).toBe("ok");
      expect(createSignInSecret(state, { person: "alex", generation, kind: "setup-token", value: second })).toBe("exists");
      expect(readSignInSecret(state, "alex", generation)!.value).toBe(first);
      expect(removeSignInSecret(state, "alex", generation)).toBe("removed");
    }
  });

  test("R4 two names forced into one slot: another person's secret is never returned, overwritten or deleted", async () => {
    forced.slot = "0".repeat(16);
    vi.resetModules();
    const { chooseSecretStore, createSignInSecret, readSignInSecret, removeSignInSecret } = await import("./tool-secret-store.js");
    const generation = "c".repeat(32), alexValue = standInToken(), bobValue = standInToken();
    for (const backend of [null, memoryKeychain()] as const) {
      chooseSecretStore(backend ?? "files");
      expect(createSignInSecret(state, { person: "alex", generation, kind: "setup-token", value: alexValue })).toBe("ok");
      // Bob at the very same address: refused, not written over alex's.
      expect(createSignInSecret(state, { person: "bob", generation, kind: "setup-token", value: bobValue })).toBe("exists");
      // Read as bob's: what rests there names alex, so it is refused, never returned.
      expect(() => readSignInSecret(state, "bob", generation)).toThrow(/isn't the one its record names/);
      // Removed as bob's: left alone.
      expect(removeSignInSecret(state, "bob", generation)).toBe("not-theirs");
      expect(readSignInSecret(state, "alex", generation)!.value).toBe(alexValue);
      // A file of alex's copied to another generation's name is refused too (files only: the keychain seals to its address).
      if (backend === null) {
        const folder = join(state, "tool-secrets", "flexible-sign-in");
        writeFileSync(join(folder, `${"0".repeat(16)}.${"d".repeat(32)}.json`), JSON.stringify({ person: "alex", generation, kind: "setup-token", value: alexValue }), { mode: 0o600 });
        expect(() => readSignInSecret(state, "alex", "d".repeat(32))).toThrow(/isn't the one its record names/);
        rmSync(join(folder, `${"0".repeat(16)}.${"d".repeat(32)}.json`));
      }
      expect(removeSignInSecret(state, "alex", generation)).toBe("removed");
    }
    // Both names really shared the one address.
    expect(files()).toEqual([]);
    chooseSecretStore(null);
  });

  test("R4 a save holds the person's lock across its wait without stopping this process: the upkeep for that person waits it out and deletes nothing", async () => {
    await save("alex", PASSWORD, standInToken());
    const g1 = active()!;
    let during: { lock: boolean; tidy: { deleted: number; left: number } } | null = null;
    const lockFile = () => readdirSync(join(state, "tool-secrets", ".locks")).some(name => name.startsWith("flexible-sign-in."));
    // A retiring generation of alex's waiting to be deleted.
    store.handle.prepare(`INSERT INTO flexible_sign_in (person, account_generation, generation, kind, state, proof, staged_at, retired_at) VALUES ('alex', ?, ?, 'setup-token', 'retiring', 'password-now', 't', 't')`)
      .run(accountGeneration(), "f".repeat(32));
    await save("alex", PASSWORD, standInToken(), { afterPlace: async () => {
      // Inside the save's lock (where the live check will wait on the network): the lock file is there, and the upkeep,
      // run now in this same process, can't take it, so it returns without deleting anything of the person's.
      during = { lock: lockFile(), tidy: await tidyFlexibleSignIns(store, state, { now: NOW, person: "alex", waitMs: 50 }) };
      expect(rows().map(row => row["state"]).sort()).toEqual(["active", "retiring", "staged"]);
    } });
    expect(during).toEqual({ lock: true, tidy: { deleted: 0, left: 1 } });
    expect(active()).not.toBe(g1);
    // Once the save let go, its own clean-up deleted both retiring generations.
    expect(rows().map(row => row["state"])).toEqual(["active"]);
    expect(lockFile()).toBe(false);
  });
});

describe("R5: a restore resets every sign-in before the restored database is put in service", () => {
  test("R5 an interruption right after publication finds no sign-in active, and the addresses the replaced database knew are kept to be deleted", async () => {
    await save("alex", PASSWORD, standInToken());
    const backup = join(dir, "backup.db");
    await onlineCopy(file, backup);
    await save("alex", PASSWORD, standInToken()); // newer than the backup: an address the backup doesn't know
    await save("bob", BOB, standInToken());
    const known = store.handle.prepare("SELECT person, generation FROM flexible_sign_in ORDER BY person, generation").all().map(row => ({ ...row }));
    store.close();
    await expect(restoreDatabase({ databaseFile: file, file: backup, dryRun: false, now: NOW, afterPublish: () => { throw new Error("stopped right after publication"); } }))
      .rejects.toThrow("stopped right after publication");
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      expect(raw.prepare("SELECT COUNT(*) AS n FROM flexible_sign_in WHERE state <> 'retiring'").get()!["n"]).toBe(0);
      const kept = raw.prepare("SELECT person, generation FROM flexible_sign_in ORDER BY person, generation").all().map(row => ({ ...row }));
      for (const one of known) expect(kept).toContainEqual(one);
    } finally { raw.close(); }
    store = openStore(file);
    expect(flexibleSignInBilling(store, { name: "alex", generation: accountGeneration() })).toEqual({ ok: false, reason: "no-sign-in" });
    // The upkeep then deletes every one of those secrets.
    await tidyFlexibleSignIns(store, state, { now: NOW });
    expect(files()).toEqual([]);
  });

  test("R5 a restore from an older schema (v171, before sign-ins) is migrated and reset: no sign-in active, the replaced database's addresses retiring", async () => {
    const backup = join(dir, "v171.db");
    await onlineCopy(file, backup);
    const old = new DatabaseSync(backup);
    old.exec("DROP INDEX thread_relay_call_sign_in_refused");
    for (const [table, columns] of Object.entries(V172_ADDED_COLUMNS)) for (const column of Object.keys(columns).reverse()) old.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    for (const table of V172_TABLES) old.exec(`DROP TABLE ${table}`);
    old.exec("UPDATE schema_version SET version = 171");
    old.close();
    await save("alex", PASSWORD, standInToken());
    const g1 = active()!;
    store.close();
    const report = await restoreDatabase({ databaseFile: file, file: backup, dryRun: false, now: NOW });
    expect(report).toMatchObject({ ok: true, schemaVersion: 171 });
    store = openStore(file);
    expect(rows()).toEqual([{ generation: g1, state: "retiring", save_op: null, proof: "restored" }]);
    expect(ledger()).toContainEqual({ actor: "command line", outcome: "reset by restore" });
    await tidyFlexibleSignIns(store, state, { now: NOW });
    expect(rows()).toEqual([]);
    expect(files()).toEqual([]);
  });
});

describe("no installation-wide sign-in", () => {
  test("no product code names the old installation credential, and a sign-in is read only by person and generation, only by the sign-in module", () => {
    const product = (readdirSync("src", { recursive: true }) as string[]).filter(path => path.endsWith(".ts") && !path.endsWith(".test.ts")).map(path => ({ path, text: readFileSync(join("src", path), "utf8") }));
    for (const one of product) expect(one.text, one.path).not.toMatch(/FLEXIBLE_RELAY_CREDENTIAL|flexible-claude-relay|claude-relay\.json|flexibleRelayBilling/);
    const readers = product.filter(one => /\breadSignInSecret\(/.test(one.text)).map(one => one.path).sort();
    expect(readers).toEqual(["flexible-sign-in.ts", "tool-secret-store.ts"]);
    for (const call of readFileSync("src/flexible-sign-in.ts", "utf8").matchAll(/readSignInSecret\(([^)]*)\)/g)) expect(call[1]!.split(",").map(part => part.trim())).toEqual(["state", "row.person", "row.generation"]);
    // The relay reads no held secret at all: its credential is the turn's owner's own (signInForTurn).
    const relay = readFileSync("src/flexible-relay.ts", "utf8");
    expect(relay).not.toMatch(/readHeldSecret|tool-secret-store/);
    expect(relay).toMatch(/const found = signInForTurn\(store, state, turn\);/);
  });
});

describe("readiness", () => {
  test("the first thing still missing, in order: threads on (an operator turns them on, anyone else asks), your own sign-in (or Claude refused it), then the project's terms; from the record only", async () => {
    expect(store.setAccountProjects("bob", ["/nowhere"], "alex", NOW)).toEqual({ ok: true });
    setFlexibleSetting(store, false, "alex", NOW);
    expect(flexibleReadiness(store, { name: "alex", generation: accountGeneration() }, "/nowhere")).toBe("turn-on");
    expect(flexibleReadiness(store, { name: "bob", generation: accountGeneration("bob") }, "/nowhere")).toBe("ask-operator");
    setFlexibleSetting(store, true, "alex", NOW);
    expect(flexibleReadiness(store, { name: "alex", generation: accountGeneration() }, "/nowhere")).toBe("sign-in");
    const saved = await save("alex", PASSWORD, standInToken());
    expect(saved.ok).toBe(true);
    // With the value gone from its address, readiness still reads the same: it never loads the secret.
    for (const name of files()) rmSync(join(state, "tool-secrets", "flexible-sign-in", name));
    expect(flexibleReadiness(store, { name: "alex", generation: accountGeneration() }, "/nowhere")).toBe("project-terms");
    store.handle.prepare(`INSERT INTO thread_relay_call (thread, turn, launch, upstream, at, ended_at, route, streamed, status, http_status, cost_basis, sign_in_person, sign_in_generation, sign_in_refused)
      VALUES (?, ?, ?, 'claude', 't', 't', 'messages', 0, 'upstream-error', 401, 'estimated', 'alex', ?, 1)`).run("a".repeat(32), "b".repeat(32), "c".repeat(32), active());
    expect(flexibleReadiness(store, { name: "alex", generation: accountGeneration() }, "/nowhere")).toBe("sign-in-refused");
    // The Agents screen's note says the same, in one line.
    expect(threadsStatusNote(store, "alex")).toContain("Claude didn't accept your sign-in");
    expect(threadsStatusNote(store, "bob")).toContain("run `claude setup-token`, then `toolroll config set flexible-sign-in`");
    setFlexibleSetting(store, false, "alex", NOW);
    expect(threadsStatusNote(store, "alex")).toContain("Threads are off");
  });
});
