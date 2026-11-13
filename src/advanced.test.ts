/** Settings → Advanced: who may change "Show advanced features", proved on the write itself (the eight plan, W4 v2/v3). */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setAdvancedPreference, advancedShownFor, type AdvancedDoor } from "./advanced.js";
import { asLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "./local-owner.js";
import { advancedPreferenceOf, initLocalMode, openStore, type Store } from "./store.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
let store: Store;
const generation = (name: string) => store.accountOf(name)!.generation;
const person = (actor: string, live = () => true): AdvancedDoor => ({ kind: "person", actor, generation: generation(actor), live });
beforeEach(() => {
  store = openStore(":memory:");
  store.saveApprover("alex", "hash-a", NOW);
  store.saveApprover("sam", "hash-s", NOW);
  // A viewer and a project-limited person change their own view too: it grants nothing.
  store.handle.prepare("INSERT INTO approver (name, credential_hash, added_at, role, generation, projects_json) VALUES ('vic', 'h', ?, 'viewer', 1, '[\"/repo/a\"]')").run(NOW.toISOString());
});
afterEach(() => { store.close(); vi.unstubAllEnvs(); });

describe("a person, from their own browser session", () => {
  test("two people, one switch: only theirs changes, and the ledger says who", () => {
    expect(setAdvancedPreference(store, person("alex"), true, NOW)).toEqual({ ok: true, on: true });
    expect(advancedShownFor(store, "alex")).toBe(true);
    expect(advancedShownFor(store, "sam")).toBe(false);
    expect(advancedPreferenceOf(store, "sam")).toBeNull();
    expect(setAdvancedPreference(store, person("alex"), false, NOW)).toEqual({ ok: true, on: false });
    expect(advancedShownFor(store, "alex")).toBe(false);
    expect(store.actionLedger({ repos: null }).filter(one => one.action === "advanced features").map(one => [one.actor, one.outcome])).toEqual(expect.arrayContaining([["alex", "shown"], ["alex", "hidden"]]));
  });
  test("a viewer limited to one project sets their own", () => {
    expect(setAdvancedPreference(store, person("vic"), true, NOW).ok).toBe(true);
    expect(advancedShownFor(store, "vic")).toBe(true);
  });
  test.each([
    ["a stale credential generation", () => ({ kind: "person", actor: "alex", generation: generation("alex") - 1, live: () => true }) as AdvancedDoor],
    ["a session that ended before the write", () => person("alex", () => false)],
    ["an account that isn't there", () => ({ kind: "person", actor: "nobody", generation: 1, live: () => true }) as AdvancedDoor],
  ])("attack: %s is refused and writes nothing", (_name, door) => {
    expect(setAdvancedPreference(store, door(), true, NOW).ok).toBe(false);
    expect(advancedPreferenceOf(store, "alex")).toBeNull();
  });
  test("attack: a revoked account is refused, and its row went with it", () => {
    expect(setAdvancedPreference(store, person("sam"), true, NOW).ok).toBe(true);
    const door = person("sam");
    expect(store.revokeAccount("sam", "alex", NOW)).toMatchObject({ ok: true });
    expect(advancedPreferenceOf(store, "sam")).toBeNull();
    expect(setAdvancedPreference(store, door, true, NOW).ok).toBe(false);
    expect(setAdvancedPreference(store, person("sam"), true, NOW).ok).toBe(false);
    expect(advancedPreferenceOf(store, "sam")).toBeNull();
  });
  test("attack: the lead's own environment is refused", () => {
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", "x");
    expect(setAdvancedPreference(store, person("alex"), true, NOW).ok).toBe(false);
  });
  test("a failed read shows everything", () => {
    const broken = { handle: { prepare: () => { throw new Error("disk"); } }, isDemo: () => false } as unknown as Store;
    expect(advancedShownFor(broken, "alex")).toBe(true);
  });
});

describe("the local owner", () => {
  const owner = (act: LocalOwnerAct): LocalPrincipal => {
    const mode = store.handle.prepare("SELECT generation FROM local_mode").get();
    return { account: "owner", localGeneration: Number(mode?.["generation"] ?? 0), accountGeneration: generation("owner"), transport: "browser", act, sessionHash: null, request: { ended: false } };
  };
  const door: AdvancedDoor = { kind: "local-owner", actor: "owner" };
  beforeEach(() => {
    store.close();
    store = openStore(":memory:", { createdBy: "laptop" });
    const init = initLocalMode(store, { owner: "owner", fenceAvailable: true, now: NOW });
    if (!init.ok) throw new Error(init.reason);
  });
  test("changes and keeps it before any password, in exactly its act", () => {
    expect(store.accountOf("owner")?.passwordSet).toBe(false);
    expect(advancedShownFor(store, "owner")).toBe(false);
    expect(asLocalOwner(owner("view-preference"), () => setAdvancedPreference(store, door, true, NOW))).toEqual({ ok: true, on: true });
    expect(advancedShownFor(store, "owner")).toBe(true);
  });
  test("attack: outside its request, in another act, or through the person door it is refused", () => {
    expect(setAdvancedPreference(store, door, true, NOW).ok).toBe(false);
    expect(asLocalOwner(owner("read"), () => setAdvancedPreference(store, door, true, NOW)).ok).toBe(false);
    expect(asLocalOwner({ ...owner("view-preference"), request: { ended: true } }, () => setAdvancedPreference(store, door, true, NOW)).ok).toBe(false);
    expect(asLocalOwner(owner("view-preference"), () => setAdvancedPreference(store, person("owner"), true, NOW)).ok).toBe(false);
    expect(advancedPreferenceOf(store, "owner")).toBeNull();
  });
  test("attack: once local mode is off, its act no longer stands", () => {
    store.handle.prepare("UPDATE local_mode SET enabled = 0, generation = generation + 1").run();
    expect(asLocalOwner(owner("view-preference"), () => setAdvancedPreference(store, door, true, NOW)).ok).toBe(false);
  });
});
