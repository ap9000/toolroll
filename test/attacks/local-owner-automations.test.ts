/**
 * The Mac app's Automations screen (docs/plans/mac-automations.md, revised 2026-11-22): the laptop's local owner (no
 * password) may pause, resume and run now (check or press) a flow's existing trigger, and read the flows it can see.
 * Every way around it is refused, with nothing written: the trigger's credential and editing acts (share, renew, secret,
 * setup, sender, scope, remove, unshare, dropped), an API token or a lead's token on the four acts, a flow in a project
 * the person can't see (absent from the read, its acts refused), a removed trigger; and a run now under a live "runs on
 * its own" grant is never the clock's firing, so it never self-approves.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openLocalWorld, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { addFlowTriggerTo } from "../../src/flow-triggers.js";
import { saveScript } from "../../src/flow-scripts.js";
import { activeUnattendedGrant, signUnattended } from "../../src/flow-unattended.js";
import { validateFlowDefinition } from "../../src/flows.js";
import { automationsSchema } from "../../src/contracts/engine-api.js";
import { mintApiToken } from "../../src/api-tokens.js";
import { NO_OS_FENCE } from "../inside-fence.js";

let world: LocalWorld, cookie: string, csrf: string, printed = 0;
const now = () => new Date();
beforeEach(async () => {
  world = await openLocalWorld({
    // A schedule's script never spawns here: each run prints one new item.
    flowTriggerIo: { shell: async () => { printed += 1; return { code: 0, stdout: JSON.stringify([{ key: `item-${printed}`, title: `Bump dependency ${printed}` }]), stderr: "" }; } },
  });
  if (NO_OS_FENCE) world.store.setUnfencedAgentsAllowed(true, "alex", now());
  ({ cookie, csrf } = await world.localSession());
}, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { await world.close(); });

const definition = JSON.stringify(validateFlowDefinition({ version: 1, start: "update", stages: [
  { id: "update", title: "Update them", kind: "task", instructions: "{{card.title}}", planning: "skip", next: "review" },
  { id: "review", title: "Review the updates", kind: "approval", next: "done" },
  { id: "done", title: "Done", kind: "done" },
] }));
/** A flow owned by alex in `repo` (default: the visible project), with each trigger given. */
function flowWith(raws: unknown[], repo = world.repo): { flow: number; triggers: number[] } {
  const flow = world.store.createFlow({ repo, name: "Upkeep", by: "alex", definitionJson: definition }, now());
  const triggers = raws.map(raw => {
    const made = addFlowTriggerTo(world.store, world.store.getFlow(flow)!, raw, "alex", now(), world.configDir, { widening: "proved" });
    if (!made.ok) throw Error(made.message);
    return made.id;
  });
  return { flow, triggers };
}
function scriptFlow(): { flow: number; trigger: number } {
  const saved = saveScript(world.store, world.repo, { name: "outdated", about: "Outdated packages", language: "shell", body: "echo '[]'", file: null, timeoutMinutes: 1 }, "alex", now());
  if (!saved.ok) throw Error(saved.message);
  const { flow, triggers } = flowWith([{ kind: "schedule", schedule: "daily 09:00", script: "outdated" }]);
  return { flow, trigger: triggers[0]! };
}
const BUTTON = { kind: "button", label: "Report a bug", questions: ["What broke?"] };
const WEBHOOK = { kind: "webhook" };
const act = (flow: number, trigger: number, verb: string, form: Record<string, string> = {}) =>
  world.post(`/flows/${flow}/triggers/${trigger}/${verb}`, cookie, { csrf, ...form }, "application/json");
const triggerRow = (id: number) => JSON.stringify(world.store.handle.prepare("SELECT state, config_json, hook_hash, hook_credential, next_at, dropped_count FROM flow_trigger WHERE id = ?").get(id));
const cards = (flow: number) => world.store.flowCards(flow, false).length;

describe("who may act on a trigger", () => {
  test("a local owner's share, renew, secret, setup, sender, scope, remove, unshare and dropped are refused before the handler, and nothing changes", async () => {
    const { flow, triggers: [button, hook] } = flowWith([BUTTON, WEBHOOK]);
    const before = [triggerRow(button!), triggerRow(hook!)];
    for (const [verb, trigger, form] of [["share", button, { password: "" }], ["unshare", button, {}], ["renew", hook, {}], ["secret", hook, { secret: "whsec_x" }],
      ["setup", hook, {}], ["sender", hook, { sender: "standard" }], ["scope", hook, { project: "x" }], ["remove", button, {}], ["remove", hook, {}], ["dropped", hook, {}]] as const) {
      const answer = await act(flow, trigger!, verb, form);
      expect(answer.status, verb).toBe(403);
      expect(answer.headers["x-toolroll-refused"], verb).toBe("local-owner");
    }
    expect([triggerRow(button!), triggerRow(hook!)]).toEqual(before);
  });

  test("a local owner's pause, resume, press and check are admitted, each doing exactly its own act", async () => {
    const { flow, triggers: [button] } = flowWith([BUTTON]);
    expect(JSON.parse((await act(flow, button!, "pause")).body)).toMatchObject({ ok: true, said: "Trigger paused." });
    expect(world.store.getFlowTrigger(button!)?.state).toBe("paused");
    // A paused button can't be pressed (the handler's own rule, unchanged).
    expect(JSON.parse((await act(flow, button!, "press", { answers: JSON.stringify(["The footer"]) })).body)).toMatchObject({ ok: false, said: "That button isn't available." });
    expect(JSON.parse((await act(flow, button!, "resume")).body)).toMatchObject({ ok: true, said: "Trigger on again." });
    expect(world.store.getFlowTrigger(button!)?.state).toBe("active");
    expect(JSON.parse((await act(flow, button!, "press", { answers: JSON.stringify(["The footer"]) })).body)).toMatchObject({ ok: true, said: "Card added." });
    expect(cards(flow)).toBe(1);
    const script = scriptFlow();
    const checked = await act(script.flow, script.trigger, "check");
    expect(JSON.parse(checked.body), checked.body).toMatchObject({ ok: true, said: "Added 1 card." });
  });

  test("an API token or a lead's token never pauses, resumes, checks or presses, and nothing changes", async () => {
    const { flow, triggers: [button] } = flowWith([BUTTON]);
    const remote = mintApiToken();
    world.store.createApiToken({ id: remote.id, account: "alex", name: "laptop", secretHash: remote.hash, access: "act", projects: null,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, now());
    const lead = world.store.mintLeadCredential("alex", "alex", now()).token;
    const before = triggerRow(button!);
    for (const bearer of [remote.token, lead]) {
      for (const verb of ["pause", "resume", "check", "press"]) {
        const answer = await world.send(`/flows/${flow}/triggers/${button}/${verb}`, "POST", { authorization: `Bearer ${bearer}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          new URLSearchParams({ answers: JSON.stringify(["x"]) }).toString());
        expect(answer.status, `${verb} ${bearer.slice(0, 4)}`).toBeGreaterThanOrEqual(400);
      }
    }
    expect(triggerRow(button!)).toBe(before);
    expect(cards(flow)).toBe(0);
    // The read: a token sees the flows, and that it may not act.
    const read = await world.send("/engine/automations", "GET", { authorization: `Bearer ${remote.token}`, accept: "application/json" });
    expect(automationsSchema.parse(JSON.parse(read.body)).canAct).toBe(false);
  });

  test("a flow in a project the person can't see is absent from the read, and its acts are refused; a removed trigger is refused", async () => {
    const elsewhere = join(world.root, "elsewhere"); mkdirSync(elsewhere);
    const hidden = flowWith([BUTTON], elsewhere);
    const seen = flowWith([BUTTON]);
    const read = automationsSchema.parse(JSON.parse((await world.send("/engine/automations", "GET", { cookie, accept: "application/json" })).body));
    expect(read.canAct).toBe(true);
    expect(read.automations.map(one => one.id)).toEqual([seen.flow]);
    const before = triggerRow(hidden.triggers[0]!);
    for (const verb of ["pause", "resume", "check", "press"]) {
      const answer = await act(hidden.flow, hidden.triggers[0]!, verb, { answers: JSON.stringify(["x"]) });
      expect(answer.status, verb).toBeGreaterThanOrEqual(400);
    }
    expect(triggerRow(hidden.triggers[0]!)).toBe(before);
    expect(cards(hidden.flow)).toBe(0);
    // Removed (by a person with a password, elsewhere): gone from the read, and never turned on again.
    world.store.updateFlowTrigger(seen.triggers[0]!, { state: "removed" }, now());
    expect(automationsSchema.parse(JSON.parse((await world.send("/engine/automations", "GET", { cookie })).body)).automations[0]!.triggers).toEqual([]);
    for (const verb of ["resume", "pause", "press"]) {
      const answer = await act(seen.flow, seen.triggers[0]!, verb, { answers: JSON.stringify(["x"]) });
      expect(answer.status, verb).toBe(404);
      expect(world.store.getFlowTrigger(seen.triggers[0]!)?.state).toBe("removed");
    }
  });
});

describe("run now under a live grant", () => {
  test("a local owner's check of a signed schedule is a person's run, never the clock's: its card is not on time, nothing is reserved or sealed", async () => {
    const { flow, trigger } = scriptFlow();
    const signed = await signUnattended(world.store, { flow, signer: "alex", ask: { days: 2, budgetMicrousd: null, dailyRunCap: null, include: [trigger] } }, now());
    if (!signed.ok) throw Error(signed.message);
    // The grant covers this very schedule: its own on-time firing would run on its own.
    expect(signed.grant.terms.triggers.map(one => one.id)).toEqual([trigger]);
    const checked = await act(flow, trigger, "check");
    expect(JSON.parse(checked.body), checked.body).toMatchObject({ ok: true, said: "Added 1 card." });
    const card = world.store.lastFlowTriggerCard(trigger)!;
    expect(world.store.handle.prepare("SELECT on_time FROM flow_trigger_event WHERE card = ?").get(card)?.["on_time"]).toBe(0);
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM flow_unattended_run").get()?.["n"]).toBe(0);
    const task = world.store.getFlowCard(card)!.task;
    expect(task === null || !world.store.scopeSealed(task)).toBe(true);
    // The grant itself stands: a run now neither uses nor ends it.
    expect(activeUnattendedGrant(world.store, flow, now())?.id).toBe(signed.grant.id);
  });
});
