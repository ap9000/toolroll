/** Who may change the code map, on the write itself (docs/plans/code-map.md §5). */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { endHoldout, setCodeMapSwitch, type MapDoor } from "./code-map-acts.js";
import { codeMapOn } from "./code-map-store.js";
import { asLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "./local-owner.js";
import { addApprover } from "./scope.js";
import { initLocalMode, openStore, type Store } from "./store.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const REPO = "/repo/shop";
let store: Store;
const generation = (name: string) => store.accountOf(name)!.generation;
beforeEach(() => {
  store = openStore(":memory:");
  const alex = addApprover(store, "alex", NOW); if (!alex.ok) throw new Error("fixture");
  addApprover(store, "vera", NOW, { name: "alex", token: alex.token });
  store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
  store.upsertProject(REPO, "shop", NOW, { remoteUrl: "https://git.example/shop.git" });
});
afterEach(() => { store.close(); vi.unstubAllEnvs(); });

const person = (method: string, actor = "alex"): MapDoor => ({ kind: "person", person: { actor, generation: generation(actor), method } });
const enroll = () => store.handle.prepare("UPDATE project SET code_map_enroll_until = '2026-12-01T00:00:00.000Z'").run();
const enrolled = () => store.handle.prepare("SELECT code_map_enroll_until AS u FROM project").get()!["u"];

describe("a person", () => {
  test.each([["password-now"], ["session"], ["cli-login"], ["sso-now"]])("a %s proof switches it and ends the holdout", method => {
    enroll();
    expect(setCodeMapSwitch(store, person(method), REPO, false, NOW)).toEqual({ ok: true });
    expect(codeMapOn(store, REPO)).toBe(false);
    expect(endHoldout(store, person(method), REPO, NOW)).toEqual({ ok: true });
    expect(enrolled()).toBe(NOW.toISOString());
    expect(store.actionLedger({ repos: null }).map(one => one.action)).toEqual(expect.arrayContaining(["code map switched", "code map holdout ended"]));
  });
  test.each([["lead-token"], ["remote-token"], ["made-up"]])("attack: a %s is refused both acts", method => {
    enroll();
    expect(setCodeMapSwitch(store, person(method), REPO, false, NOW).ok).toBe(false);
    expect(endHoldout(store, person(method), REPO, NOW).ok).toBe(false);
    expect(codeMapOn(store, REPO)).toBe(true);
  });
  test("attack: a viewer is refused", () => {
    expect(setCodeMapSwitch(store, person("session", "vera"), REPO, false, NOW).ok).toBe(false);
  });
  test("attack: a revoked generation is refused", () => {
    const stale: MapDoor = { kind: "person", person: { actor: "alex", generation: generation("alex") - 1, method: "session" } };
    expect(setCodeMapSwitch(store, stale, REPO, false, NOW).ok).toBe(false);
  });
  test("attack: a proof that no longer stands at the write is refused", () => {
    const door: MapDoor = { kind: "person", person: { actor: "alex", generation: generation("alex"), method: "session", live: () => false } };
    expect(setCodeMapSwitch(store, door, REPO, false, NOW).ok).toBe(false);
  });
  test("attack: the lead's own environment is refused whatever the door says", () => {
    vi.stubEnv("TOOLROLL_LEAD_TOKEN", "x");
    expect(setCodeMapSwitch(store, person("session"), REPO, false, NOW).ok).toBe(false);
  });
});

describe("the local owner", () => {
  const owner = (act: LocalOwnerAct): LocalPrincipal => {
    const mode = store.handle.prepare("SELECT generation FROM local_mode").get();
    return { account: "alex", localGeneration: Number(mode?.["generation"] ?? 0), accountGeneration: generation("alex"), transport: "terminal", act, sessionHash: null, request: null };
  };
  const door: MapDoor = { kind: "local-owner", actor: "alex" };
  test("only in exactly its act, while local mode stands", () => {
    store.close();
    store = openStore(":memory:", { createdBy: "laptop" });
    const init = initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW });
    if (!init.ok) throw new Error(init.reason);
    store.upsertProject(REPO, "shop", NOW, { remoteUrl: "https://git.example/shop.git" });
    expect(setCodeMapSwitch(store, door, REPO, false, NOW).ok).toBe(false); // not in flight
    expect(asLocalOwner(owner("read"), () => setCodeMapSwitch(store, door, REPO, false, NOW)).ok).toBe(false);
    expect(asLocalOwner(owner("code-map-switch"), () => setCodeMapSwitch(store, door, REPO, false, NOW))).toEqual({ ok: true });
    expect(codeMapOn(store, REPO)).toBe(false);
  });
  test("attack: never the holdout, by door or by basis", () => {
    store.close();
    store = openStore(":memory:", { createdBy: "laptop" });
    const init = initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW });
    if (!init.ok) throw new Error(init.reason);
    store.upsertProject(REPO, "shop", NOW, { remoteUrl: "https://git.example/shop.git" });
    expect(asLocalOwner(owner("code-map-switch"), () => endHoldout(store, door, REPO, NOW))).toEqual({ ok: false, problem: "Ending the holdout takes a person's own sign-in." });
    expect(endHoldout(store, person("local-owner"), REPO, NOW).ok).toBe(false);
    expect(asLocalOwner(owner("code-map-switch"), () => endHoldout(store, person("session"), REPO, NOW)).ok).toBe(false);
  });
});
