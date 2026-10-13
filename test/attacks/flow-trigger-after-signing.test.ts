/**
 * Attack: add or rewrite a trigger after a flow's owner signed it to run on its own, so cards the owner never read
 * file sealed work. Guard: store.addFlowTrigger ends the grant when a schedule is added ("schedule changed"), and
 * cardFromSignedSchedule covers only an on-time firing of a trigger the grant names by id and settings digest
 * (triggerDigestOf), so a rewritten row, a non-schedule trigger or a row inserted past the ceremony is a person's.
 */
import { describe, expect, test } from "vitest";
import { addFlowTriggerTo, pressFlowButton } from "../../src/flow-triggers.js";
import { advanceFlows } from "../../src/flow-engine.js";
import { activeUnattendedGrant } from "../../src/flow-unattended.js";
import { at, HOUR, useFlowPlane } from "./flow-fixture.js";

describe("attack: a trigger added after an unattended grant was signed", () => {
  const plane = useFlowPlane("trigger");
  const signed = async () => {
    const { flow, trigger } = plane.scheduledFlow();
    const grant = await plane.sign(flow);
    if (!grant.ok) throw Error(grant.message);
    return { flow, trigger, grant: grant.grant };
  };
  const insertRaw = (flow: number, kind: string, config: unknown, now: Date) => Number(plane.store.handle.prepare(
    "INSERT INTO flow_trigger (flow, kind, config_json, state, next_at, created_by, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, 'sam', ?, ?)")
    .run(flow, kind, JSON.stringify(config), now.toISOString(), now.toISOString(), now.toISOString()).lastInsertRowid);
  // Settings as the table stores them (scheduleFromWords): every hour.
  const chores = { kind: "schedule", schedule: "every:60", title: "Delete the old branches", description: null, zone: null };

  test("another approver's schedule ends the grant, and its card is not sealed", async () => {
    const { flow } = await signed();
    const added = addFlowTriggerTo(plane.store, plane.store.getFlow(flow)!, { kind: "schedule", schedule: "every 1 hour", title: chores.title, description: null }, "sam", at(HOUR), null);
    if (!added.ok) throw Error(added.message);
    expect(activeUnattendedGrant(plane.store, flow, at(HOUR))).toBeNull();
    expect(plane.ended("schedule changed")).toEqual([expect.objectContaining({ actor: "sam", outcome: "ended" })]);
    expect(plane.sealed((await plane.fire(added.id, at(2 * HOUR))).task)).toBe(false);
  });

  test("the signed schedule's settings rewritten in the database are not covered", async () => {
    const { trigger } = await signed();
    plane.store.handle.prepare("UPDATE flow_trigger SET config_json = ? WHERE id = ?").run(JSON.stringify({ ...chores, schedule: "daily:09:00" }), trigger);
    expect(plane.sealed((await plane.fire(trigger, at(HOUR))).task)).toBe(false);
  });

  test("a button added after signing leaves the grant standing, and its cards are not sealed", async () => {
    const { flow } = await signed();
    const button = addFlowTriggerTo(plane.store, plane.store.getFlow(flow)!, { kind: "button", label: "Chores" }, "sam", at(HOUR), null);
    if (!button.ok) throw Error(button.message);
    // Not a schedule, so nothing ends: the grant names its triggers, and this isn't one of them.
    expect(activeUnattendedGrant(plane.store, flow, at(HOUR))).not.toBeNull();
    const pressed = pressFlowButton(plane.store, plane.store.getFlowTrigger(button.id)!, ["Force-push main"], "sam", at(HOUR));
    if (!pressed.ok) throw Error(pressed.message);
    advanceFlows(plane.store, plane.repo, at(HOUR));
    const task = plane.store.getFlowCard(pressed.card)!.task;
    expect(task).not.toBeNull();
    expect(plane.sealed(task)).toBe(false);
  });

  test("a schedule inserted past the ceremony fires on time, and its card is not sealed", async () => {
    const { flow } = await signed();
    // Through the store with another kind on the row (the ending only looks at kind "schedule"), and as raw SQL.
    const disguised = plane.store.addFlowTrigger({ flow, kind: "button", configJson: JSON.stringify(chores), hookHash: null, cursor: null, nextAt: at(HOUR).toISOString(), by: "sam" }, at(HOUR));
    const raw = insertRaw(flow, "schedule", chores, at(HOUR));
    expect(activeUnattendedGrant(plane.store, flow, at(HOUR))).not.toBeNull();
    for (const [n, trigger] of [disguised, raw].entries()) {
      const fired = await plane.fire(trigger, at((2 + n) * HOUR));
      expect(plane.store.handle.prepare("SELECT on_time FROM flow_trigger_event WHERE card = ?").get(fired.card)?.["on_time"]).toBe(1);
      expect(fired.task).not.toBeNull();
      expect(plane.sealed(fired.task)).toBe(false);
    }
  });

  test("legitimate: the signed schedule's own on-time firing is sealed, before and beside the attacks", async () => {
    const { flow, trigger, grant } = await signed();
    expect(grant.terms.triggers).toEqual([expect.objectContaining({ id: trigger, kind: "schedule" })]);
    expect(plane.sealed((await plane.fire(trigger, at(HOUR))).task)).toBe(true);
    // A button or a row past the ceremony leaves the grant standing for its own schedule.
    addFlowTriggerTo(plane.store, plane.store.getFlow(flow)!, { kind: "button", label: "Chores" }, "sam", at(HOUR), null);
    insertRaw(flow, "schedule", chores, at(HOUR));
    expect(plane.sealed((await plane.fire(trigger, at(HOUR + 24 * HOUR))).task)).toBe(true);
  });
});
