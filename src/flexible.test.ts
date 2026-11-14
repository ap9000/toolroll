/**
 * Flexible projects, slice F1 (the Flexible plan v2 §3 and its binding round-2 changes): who may turn a project
 * Flexible, lower it and turn it off; when signed terms stop counting; the delegation check a thread start makes at
 * the moment of use; and stored terms this build can't read exactly allowing nothing.
 *
 * The enabled behaviour is reachable only by replacing flexible-available.ts here (the build ships it false;
 * flexible-disabled.test.ts proves every writer refuses then).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { OPEN_POLICY } from "./policy.js";
import {
  enableFlexible, flexibleDelegationAtUse, flexibleDigestOf, flexibleStanding, flexibleTermsJson, flexibleTermsWords, FULL_ACCESS_WORDS, lowerFlexible,
  OPEN_NETWORK_WORDS, proposedFlexibleTerms, turnFlexibleOff, type FlexibleChoice, type FlexibleTerms,
} from "./flexible.js";

vi.mock("./flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));

const NOW = new Date("2026-11-13T10:00:00.000Z");
let dir: string;
let REPO: string;
let OTHER: string;
let store: Store;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flexible-")));
  REPO = join(dir, "app");
  OTHER = join(dir, "other");
  store = openStore(":memory:");
  store.saveApprover("alex", "hash-a", NOW); // an instance operator
  store.saveApprover("robin", "hash-r", NOW); // a second operator (so alex can be removed)
  store.saveApprover("pat", "hash-p", NOW);
  expect(store.setAccountProjects("pat", [REPO], "alex", NOW)).toEqual({ ok: true }); // an approver of REPO only
  store.saveApprover("lee", "hash-l", NOW);
  expect(store.setAccountProjects("lee", [OTHER], "alex", NOW)).toEqual({ ok: true }); // an approver of another project
  store.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, role, generation) VALUES ('vic', 'hash-v', ?, 'viewer', 1)").run(NOW.toISOString());
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const generation = (name: string) => store.accountOf(name)!.generation;
/** The ceremony's two halves: the terms shown, then the password-proved signature of exactly those. */
function enable(by: string, choice: FlexibleChoice = {}, proof = "password-now") {
  const shown = proposedFlexibleTerms(store, REPO, by, choice);
  if (!shown.ok) return shown;
  return enableFlexible(store, { repo: REPO, by, proof, choice, shownDigest: shown.digest, now: NOW });
}
const at = (by: string, digest: string, level: FlexibleTerms["max"] = "full", freshProof = false) =>
  flexibleDelegationAtUse(store, { repo: REPO, starter: { name: by, generation: generation(by) }, digest, level, freshProof });
const liveRows = () => store.handle.prepare("SELECT id, end_reason, end_detail FROM flexible_terms WHERE repo = ? ORDER BY id").all(REPO).map(row => ({ ...row }));
const ledger = () => store.handle.prepare("SELECT actor, action, outcome FROM action_ledger WHERE action LIKE 'flexible%' ORDER BY id").all().map(row => ({ ...row }));

describe("turning it on: the password ceremony", () => {
  test("the owner's defaults: Full access by default, any approver of the project may start, terms said in full", () => {
    const shown = proposedFlexibleTerms(store, REPO, "pat");
    if (!shown.ok) throw new Error(shown.message);
    expect(shown.terms).toMatchObject({ version: 1, repo: REPO, signer: "pat", signerGeneration: generation("pat"), starters: "approvers-with-access", max: "full", passwordFreeUpTo: "full", default: "full", network: "confined" });
    const words = flexibleTermsWords(shown.terms).join("\n");
    expect(words).toContain("People who can approve work in this project may start Flexible threads at Full access without a password.");
    expect(words).toContain("New threads start at Full access.");
    expect(words).toContain(FULL_ACCESS_WORDS);
    expect(words).not.toMatch(/up to Auto|proved on this computer|aren't hidden/);
    for (const line of OPEN_NETWORK_WORDS) expect(words).not.toContain(line);
  });

  test.each([
    ["an instance operator", "alex", true],
    ["an approver limited to this project", "pat", true],
    ["an approver of another project only", "lee", false],
    ["a viewer", "vic", false],
    ["nobody Toolroll knows", "stranger", false],
  ])("%s: %s", (_who, by, allowed) => {
    const done = enable(by);
    expect(done.ok).toBe(allowed);
    if (!done.ok) expect(done.reason).toBe("not-an-approver");
    expect(flexibleStanding(store, REPO).state).toBe(allowed ? "on" : "secure");
  });

  test("a removed account can't sign", () => {
    expect(store.revokeAccount("pat", "alex", NOW).ok).toBe(true);
    expect(enable("pat")).toMatchObject({ ok: false, reason: "not-an-approver" });
  });

  test.each([["session"], ["cli-login"], ["fresh-password"], ["fresh-sso"], ["lead-token"], ["remote-token"], ["local-owner"], [""]])("only a password typed now or a one-use re-check signs: %s refused", proof => {
    expect(enable("alex", {}, proof)).toMatchObject({ ok: false, reason: "proof-required" });
    expect(flexibleStanding(store, REPO)).toEqual({ state: "secure" });
    expect(enable("alex", {}, "sso-now").ok).toBe(true);
  });

  test("the password signs exactly what was shown: a stale or foreign digest refuses and writes nothing", () => {
    const shown = proposedFlexibleTerms(store, REPO, "alex");
    if (!shown.ok) throw new Error(shown.message);
    expect(enableFlexible(store, { repo: REPO, by: "alex", proof: "password-now", shownDigest: "0".repeat(32), now: NOW })).toMatchObject({ ok: false, reason: "terms-changed" });
    // Shown Full access, signed with a different choice: the digest names other terms.
    expect(enableFlexible(store, { repo: REPO, by: "alex", proof: "password-now", choice: { max: "auto" }, shownDigest: shown.digest, now: NOW })).toMatchObject({ ok: false, reason: "terms-changed" });
    // The network posture changed between the screen and the signature.
    store.setProjectNetwork(REPO, { mode: "open", hosts: [], loopback: "proxy-only" }, "alex", NOW);
    expect(enableFlexible(store, { repo: REPO, by: "alex", proof: "password-now", shownDigest: shown.digest, now: NOW })).toMatchObject({ ok: false, reason: "terms-changed" });
    // The signer's password changed between the screen and the signature (their generation moved).
    const again = proposedFlexibleTerms(store, REPO, "alex");
    if (!again.ok) throw new Error(again.message);
    store.saveApprover("alex", "hash-a2", NOW);
    expect(enableFlexible(store, { repo: REPO, by: "alex", proof: "password-now", shownDigest: again.digest, now: NOW })).toMatchObject({ ok: false, reason: "terms-changed" });
    expect(liveRows()).toEqual([]);
    expect(ledger()).toEqual([]);
  });

  test("an open-network project may be Flexible, with the disclosure in the terms before consent", () => {
    store.setProjectNetwork(REPO, { mode: "open", hosts: [], loopback: "any" }, "alex", NOW);
    const shown = proposedFlexibleTerms(store, REPO, "alex");
    if (!shown.ok) throw new Error(shown.message);
    expect(shown.terms.network).toBe("open");
    const words = flexibleTermsWords(shown.terms).join("\n");
    for (const line of OPEN_NETWORK_WORDS) expect(words).toContain(line);
    expect(words).toContain("files the sandbox allows it to read");
    expect(enable("alex").ok).toBe(true);
  });

  test("a two-person project can't be Flexible", () => {
    store.setApprovalRules(REPO, { notRequester: true, protectProject: false, protectedPaths: [] }, "alex", NOW);
    expect(enable("alex")).toMatchObject({ ok: false, reason: "two-person" });
    store.setApprovalRules(REPO, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", NOW);
    expect(enable("alex")).toMatchObject({ ok: false, reason: "two-person" });
    // Protected paths alone keep their own road (the ship slice); they don't make the project two-person.
    store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["infra"] }, "alex", NOW);
    expect(enable("alex").ok).toBe(true);
  });

  test("the organisation ceiling bounds the terms; the default is the highest it allows, never a silent swap", () => {
    store.setOrgPolicy({ ...OPEN_POLICY, ceiling: "standard" }, "alex", NOW);
    const shown = proposedFlexibleTerms(store, REPO, "alex");
    expect(shown.ok && shown.terms.max).toBe("auto");
    expect(enable("alex", { max: "full" })).toMatchObject({ ok: false, reason: "above-ceiling" });
    expect(enable("alex", { max: "auto", default: "full" })).toMatchObject({ ok: false, reason: "invalid-choice" });
    store.setOrgPolicy({ ...OPEN_POLICY, ceiling: "safe" }, "alex", NOW);
    expect(enable("alex", { max: "auto" })).toMatchObject({ ok: false, reason: "above-ceiling" });
    expect(enable("alex")).toMatchObject({ ok: true, terms: { max: "supervised", default: "supervised" } });
  });

  test("turning it on again replaces the live terms; the ledger keeps each act", () => {
    expect(enable("alex").ok).toBe(true);
    expect(enable("pat", { max: "auto" }).ok).toBe(true);
    expect(liveRows()).toEqual([{ id: 1, end_reason: "replaced", end_detail: null }, { id: 2, end_reason: null, end_detail: null }]);
    expect(flexibleStanding(store, REPO)).toMatchObject({ state: "on", signedBy: "pat", terms: { max: "auto" } });
    expect(ledger()).toEqual([{ actor: "alex", action: "flexible turned on", outcome: "on" }, { actor: "pat", action: "flexible turned on", outcome: "on" }]);
  });
});

describe("lapse: signed terms stop counting, and the change that caused it ends them", () => {
  const cases: [string, () => void, string][] = [
    ["the signer's account is removed", () => { store.revokeAccount("pat", "alex", NOW); }, "signer-revoked"],
    ["the signer's password changes (generation)", () => { store.saveApprover("pat", "hash-p2", NOW); }, "signer-changed"],
    ["the signer loses access to the project", () => { store.setAccountProjects("pat", [OTHER], "alex", NOW); }, "signer-changed"],
    ["the project now needs two approvers", () => { store.setApprovalRules(REPO, { notRequester: true, protectProject: false, protectedPaths: [] }, "alex", NOW); }, "two-person"],
    ["the project's network posture changes", () => { store.setProjectNetwork(REPO, { mode: "open", hosts: [], loopback: "proxy-only" }, "alex", NOW); }, "network-changed"],
    ["the organisation ceiling drops below the terms", () => { store.setOrgPolicy({ ...OPEN_POLICY, ceiling: "standard" }, "alex", NOW); }, "ceiling-lowered"],
  ];
  test.each(cases)("%s", (_what, change, reason) => {
    const done = enable("pat");
    if (!done.ok) throw new Error(done.message);
    expect(at("alex", done.digest).ok).toBe(true);
    change();
    // Ended durably in the change's own transaction, with why: it never comes back, even if the change is undone.
    expect(liveRows()).toEqual([{ id: 1, end_reason: "lapsed", end_detail: expect.any(String) }]);
    expect(flexibleStanding(store, REPO)).toEqual({ state: "secure" });
    expect(at("alex", done.digest)).toMatchObject({ ok: false, reason: "not-flexible" });
    expect(ledger().at(-1)).toMatchObject({ action: "flexible terms lapsed", outcome: "lapsed" });
    // The live check alone also refuses, without the durable end (a missed sweep never leaves authority alive).
    store.handle.prepare("DELETE FROM flexible_terms").run();
    store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, 'pat', ?, 'password-now', 'pat', ?)`).run(REPO, flexibleTermsJson(done.terms), done.digest, flexibleTermsJson(done.terms), done.digest, NOW.toISOString(), NOW.toISOString());
    expect(flexibleStanding(store, REPO)).toMatchObject({ state: "lapsed", reason });
    expect(at("alex", done.digest)).toMatchObject({ ok: false, reason: "terms-lapsed" });
  });

  test("a change elsewhere ends nothing: another project's rules, another person's account", () => {
    const done = enable("pat");
    if (!done.ok) throw new Error(done.message);
    store.setApprovalRules(OTHER, { notRequester: true, protectProject: false, protectedPaths: [] }, "alex", NOW);
    store.setProjectNetwork(OTHER, { mode: "open", hosts: [], loopback: "proxy-only" }, "alex", NOW);
    store.saveApprover("lee", "hash-l2", NOW);
    store.setOrgPolicy({ ...OPEN_POLICY, providers: ["claude"] }, "alex", NOW);
    expect(flexibleStanding(store, REPO)).toMatchObject({ state: "on", digest: done.digest });
  });
});

describe("lowering and turning off: any approver of the project, no password, and they serialise with starts", () => {
  test("lowering writes narrower terms under a new digest: the old digest stops starting threads", () => {
    const done = enable("alex");
    if (!done.ok) throw new Error(done.message);
    expect(lowerFlexible(store, { repo: REPO, by: "vic", max: "auto", now: NOW })).toMatchObject({ ok: false, reason: "not-an-approver" });
    expect(lowerFlexible(store, { repo: REPO, by: "lee", max: "auto", now: NOW })).toMatchObject({ ok: false, reason: "not-an-approver" });
    const lowered = lowerFlexible(store, { repo: REPO, by: "pat", max: "auto", now: NOW });
    if (!lowered.ok) throw new Error(lowered.message);
    expect(lowered).toMatchObject({ changed: true, terms: { max: "auto", passwordFreeUpTo: "auto", default: "auto", signer: "alex" } });
    expect(lowered.digest).not.toBe(done.digest);
    expect(at("pat", done.digest, "auto")).toMatchObject({ ok: false, reason: "terms-changed" });
    expect(at("pat", lowered.digest, "auto").ok).toBe(true);
    expect(at("pat", lowered.digest, "full")).toMatchObject({ ok: false, reason: "above-max" });
    // The signature it rests on is still alex's, exactly as signed.
    expect(flexibleStanding(store, REPO)).toMatchObject({ state: "on", signedBy: "alex", signedDigest: done.digest, changedBy: "pat", digest: lowered.digest });
    // Lowering never raises, and the same level again changes nothing.
    expect(lowerFlexible(store, { repo: REPO, by: "pat", max: "full", now: NOW })).toMatchObject({ ok: false, reason: "not-lower" });
    expect(lowerFlexible(store, { repo: REPO, by: "pat", max: "auto", now: NOW })).toMatchObject({ ok: true, changed: false, digest: lowered.digest });
    expect(liveRows()).toEqual([{ id: 1, end_reason: "lowered", end_detail: null }, { id: 2, end_reason: null, end_detail: null }]);
    expect(ledger().map(one => one["action"])).toEqual(["flexible turned on", "flexible lowered"]);
  });

  test("turning off ends the terms at once: no start passes after it", () => {
    const done = enable("alex");
    if (!done.ok) throw new Error(done.message);
    expect(turnFlexibleOff(store, { repo: REPO, by: "vic", now: NOW })).toMatchObject({ ok: false, reason: "not-an-approver" });
    expect(turnFlexibleOff(store, { repo: REPO, by: "pat", now: NOW })).toEqual({ ok: true, changed: true });
    expect(at("alex", done.digest)).toMatchObject({ ok: false, reason: "not-flexible" });
    expect(turnFlexibleOff(store, { repo: REPO, by: "pat", now: NOW })).toEqual({ ok: true, changed: false });
    expect(lowerFlexible(store, { repo: REPO, by: "pat", max: "auto", now: NOW })).toMatchObject({ ok: false, reason: "not-flexible" });
  });

  test("the start's check runs inside the write transaction it shares with the start, so a lower is wholly before or after it", () => {
    const done = enable("alex");
    if (!done.ok) throw new Error(done.message);
    // A start (F2's shape): the check and the start's own write in one transaction.
    const started = store.transact(() => {
      expect(store.handle.isTransaction).toBe(true);
      const allowed = at("pat", done.digest);
      if (allowed.ok) store.recordAction({ at: NOW.toISOString(), actor: "pat", repo: REPO, taskId: null, runId: null, source: "policy", action: "thread started (test)", outcome: "started" });
      return allowed;
    });
    expect(started.ok).toBe(true);
    // The check alone also takes the write lock: it is never a read that a lower could slip under.
    let inside = false;
    const original = store.handle.prepare.bind(store.handle);
    const spy = vi.spyOn(store.handle, "prepare").mockImplementation(sql => { if (String(sql).includes("FROM flexible_terms")) inside = store.handle.isTransaction; return original(sql); });
    at("pat", done.digest);
    spy.mockRestore();
    expect(inside).toBe(true);
    // A lower that commits first: the start presenting the old terms is refused.
    lowerFlexible(store, { repo: REPO, by: "alex", max: "supervised", now: NOW });
    expect(store.transact(() => at("pat", done.digest))).toMatchObject({ ok: false, reason: "terms-changed" });
  });
});

describe("delegation at the moment of use", () => {
  test("re-checks the starter now: approval standing, project access, generation and the terms' starters", () => {
    const done = enable("alex");
    if (!done.ok) throw new Error(done.message);
    expect(at("pat", done.digest).ok).toBe(true);
    expect(at("vic", done.digest)).toMatchObject({ ok: false, reason: "not-an-approver" });
    expect(at("lee", done.digest)).toMatchObject({ ok: false, reason: "not-an-approver" });
    expect(flexibleDelegationAtUse(store, { repo: REPO, starter: { name: "pat", generation: generation("pat") - 1 }, digest: done.digest, level: "full", freshProof: false }))
      .toMatchObject({ ok: false, reason: "stale-generation" });
    expect(flexibleDelegationAtUse(store, { repo: REPO, starter: { name: "nobody", generation: 1 }, digest: done.digest, level: "full", freshProof: false }))
      .toMatchObject({ ok: false, reason: "not-an-approver" });
    store.revokeAccount("pat", "alex", NOW);
    expect(flexibleDelegationAtUse(store, { repo: REPO, starter: { name: "pat", generation: generation("pat") }, digest: done.digest, level: "full", freshProof: false }))
      .toMatchObject({ ok: false, reason: "not-an-approver" });
    // A secure project allows nothing.
    expect(flexibleDelegationAtUse(store, { repo: OTHER, starter: { name: "alex", generation: generation("alex") }, digest: done.digest, level: "supervised", freshProof: false }))
      .toMatchObject({ ok: false, reason: "not-flexible" });
  });

  test("a level above the password-free one needs a fresh proof; only the signer starts under signer-only terms", () => {
    // Hand-written terms this build reads exactly: Auto without a password, Full access with one, the signer only.
    const terms: FlexibleTerms = { version: 1, repo: REPO, signer: "alex", signerGeneration: generation("alex"), starters: "signer", passwordFreeUpTo: "auto", max: "full", default: "auto", network: "confined",
      caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } };
    const digest = flexibleDigestOf(terms);
    store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(REPO, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
    expect(flexibleTermsWords(terms)[0]).toBe("Only alex may start Flexible threads at Auto without a password. A thread can be raised to Full access with that person's password. New threads start at Auto.");
    expect(at("alex", digest, "auto").ok).toBe(true);
    expect(at("alex", digest, "full")).toMatchObject({ ok: false, reason: "proof-required" });
    expect(at("alex", digest, "full", true).ok).toBe(true);
    expect(at("pat", digest, "supervised")).toMatchObject({ ok: false, reason: "not-a-starter" });
  });
});

describe("stored terms this build can't read exactly allow nothing, never a level", () => {
  const good = (): FlexibleTerms => ({ version: 1, repo: REPO, signer: "alex", signerGeneration: generation("alex"), starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full", network: "confined",
    caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null } });
  const put = (row: { terms?: string; digest?: string; signed?: string; signedDigest?: string; signedBy?: string; repo?: string }) => {
    const json = flexibleTermsJson(good()), digest = flexibleDigestOf(good());
    store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'password-now', 'alex', ?)`).run(row.repo ?? REPO, row.terms ?? json, row.digest ?? digest, row.signed ?? json, row.signedDigest ?? digest, row.signedBy ?? "alex", NOW.toISOString(), NOW.toISOString());
  };
  const reshape = (change: (one: Record<string, unknown>) => void) => { const one = JSON.parse(flexibleTermsJson(good())) as Record<string, unknown>; change(one); return JSON.stringify(one); };
  const hashed = (json: string) => ({ terms: json, digest: flexibleDigestOf(JSON.parse(json) as FlexibleTerms), signed: json, signedDigest: flexibleDigestOf(JSON.parse(json) as FlexibleTerms) });
  /** Full access in force, over a signature of Auto only. */
  const wider = () => { const narrow: FlexibleTerms = { ...good(), max: "auto", passwordFreeUpTo: "auto", default: "auto" }; return { signed: flexibleTermsJson(narrow), signedDigest: flexibleDigestOf(narrow) }; };
  test.each([
    ["not JSON", () => put({ terms: "{oops" })],
    ["an unknown level", () => put(hashed(reshape(one => { one["max"] = "yolo"; })))],
    ["an unknown key", () => put(hashed(reshape(one => { one["extra"] = true; })))],
    ["a missing key", () => put(hashed(reshape(one => { delete one["network"]; })))],
    ["a version this build doesn't speak", () => put(hashed(reshape(one => { one["version"] = 2; })))],
    ["levels out of order", () => put(hashed(reshape(one => { one["default"] = "full"; one["max"] = "auto"; one["passwordFreeUpTo"] = "auto"; })))],
    ["bytes that aren't canonical", () => put({ terms: JSON.stringify(good(), null, 1) })],
    ["a digest that doesn't match", () => put({ digest: "0".repeat(32) })],
    ["a signed digest that doesn't match", () => put({ signedDigest: "0".repeat(32) })],
    ["terms wider than what was signed", () => put(wider())],
    ["a signer that isn't the row's", () => put({ signedBy: "pat" })],
    ["another project's terms", () => put({ terms: flexibleTermsJson({ ...good(), repo: OTHER }), digest: flexibleDigestOf({ ...good(), repo: OTHER }) })],
  ])("%s", (_what, plant) => {
    plant();
    const standing = flexibleStanding(store, REPO);
    expect(standing.state).toBe("unreadable");
    expect(at("alex", flexibleDigestOf(good()), "supervised")).toMatchObject({ ok: false, reason: "terms-unreadable" });
    expect(lowerFlexible(store, { repo: REPO, by: "alex", max: "supervised", now: NOW })).toMatchObject({ ok: false, reason: "terms-unreadable" });
    // Turning it off still works, and turning it on again signs fresh terms.
    expect(turnFlexibleOff(store, { repo: REPO, by: "pat", now: NOW })).toEqual({ ok: true, changed: true });
    expect(enable("alex").ok).toBe(true);
  });
});
