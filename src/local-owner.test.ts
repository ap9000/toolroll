/** Local mode's restricted principal (easy-start plan C1): every proposal kind decided, acts by id, and a binding that
 * stands only against local mode as read now. Pure: no store. */
import { describe, expect, test } from "vitest";
import { authorityOf, LOCAL_OWNER_ACTS, LOCAL_OWNER_PROPOSALS, localBindingStands, localOwnerAct, localOwnerMayConfirm, type LocalMode } from "./local-owner.js";

describe("the local owner's allowlist", () => {
  test("every lead proposal kind is decided, exactly as the plan splits them", () => {
    const allowed = Object.entries(LOCAL_OWNER_PROPOSALS).filter(([, one]) => one === "allow").map(([kind]) => kind).sort();
    const refused = Object.entries(LOCAL_OWNER_PROPOSALS).filter(([, one]) => one === "refuse").map(([kind]) => kind).sort();
    expect(allowed).toEqual(["action", "answer", "cancel", "hold", "steer", "task", "task_action", "unhold"]);
    expect(refused).toEqual(["agents", "control", "next", "repair", "reserve", "review", "scope"]);
    expect(allowed.length + refused.length).toBe(15);
    expect(Object.isFrozen(LOCAL_OWNER_PROPOSALS)).toBe(true);
  });

  test("a kind is confirmable only when allowed; an operation kind also needs a local-owner act; anything unknown refuses", () => {
    for (const kind of ["task", "answer", "steer", "cancel", "hold", "unhold"]) expect(localOwnerMayConfirm(kind), kind).toBe(true);
    for (const kind of ["next", "reserve", "scope", "repair", "agents", "review", "control"]) expect(localOwnerMayConfirm(kind, "file-task"), kind).toBe(false);
    for (const kind of ["action", "task_action"]) {
      expect(localOwnerMayConfirm(kind)).toBe(false);
      expect(localOwnerMayConfirm(kind, "invite-person")).toBe(false);
      expect(localOwnerMayConfirm(kind, "complete-task")).toBe(true);
    }
    for (const odd of ["", "toString", "__proto__", "constructor", "Task", null, undefined, 3]) expect(localOwnerMayConfirm(odd, "file-task"), String(odd)).toBe(false);
  });

  test("acts are ids; an unknown id is not one", () => {
    expect(LOCAL_OWNER_ACTS).toContain("approve-plan");
    expect(localOwnerAct("read")).toBe(true);
    for (const odd of ["set-password", "Read", "", "toString", null, 1]) expect(localOwnerAct(odd), String(odd)).toBe(false);
    expect(new Set(LOCAL_OWNER_ACTS).size).toBe(LOCAL_OWNER_ACTS.length);
  });

  test("an authority is one of two words; anything else is none (never full by default)", () => {
    expect(authorityOf("full")).toBe("full");
    expect(authorityOf("local-owner")).toBe("local-owner");
    for (const odd of ["", "FULL", "local", null, undefined, 1]) expect(authorityOf(odd), String(odd)).toBeNull();
  });
});

describe("a local binding stands only against local mode as read now", () => {
  const mode: LocalMode = { owner: "alex", generation: 3, enabled: true, initializedAt: "t", changedAt: "t" };
  test("on, at its generation, for its owner", () => {
    expect(localBindingStands(mode, { account: "alex", localGeneration: 3 })).toBe(true);
    expect(localBindingStands({ ...mode, enabled: false }, { account: "alex", localGeneration: 3 })).toBe(false);
    expect(localBindingStands({ ...mode, generation: 4 }, { account: "alex", localGeneration: 3 })).toBe(false);
    expect(localBindingStands(mode, { account: "robin", localGeneration: 3 })).toBe(false);
    expect(localBindingStands(mode, { account: "alex", localGeneration: null })).toBe(false);
    expect(localBindingStands(null, { account: "alex", localGeneration: 3 })).toBe(false);
  });
});
