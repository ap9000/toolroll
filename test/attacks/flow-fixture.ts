/**
 * The "runs on its own" attacks' shared plane: a fresh store with two approvers (alex owns the flows, sam is another
 * approver), a project folder, an injected clock, and a script runner that never spawns (each run prints one new item
 * and calls `whileRunning`, so a test can swap a file mid-run). Mirrors src/flow-unattended.test.ts's fixtures.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { advanceFlows } from "../../src/flow-engine.js";
import { saveScript } from "../../src/flow-scripts.js";
import { addFlowTriggerTo, runFlowTriggers } from "../../src/flow-triggers.js";
import { signUnattended } from "../../src/flow-unattended.js";
import { validateFlowDefinition } from "../../src/flows.js";
import { addApprover } from "../../src/scope.js";
import { openStore, type Store } from "../../src/store.js";
import { NO_OS_FENCE } from "../inside-fence.js";
import { useScratch } from "./harness.js";

export const T0 = new Date("2026-10-12T08:00:00Z");
export const HOUR = 3_600_000;
export const at = (ms: number): Date => new Date(T0.getTime() + ms);

type Io = Parameters<typeof runFlowTriggers>[3];
type Ask = Partial<{ days: number; budgetMicrousd: number | null; dailyRunCap: number | null; include: number[] }>;

export function useFlowPlane(label: string) {
  const scratch = useScratch(label);
  let store: Store | null = null;
  let printed = 0;
  const plane = {
    dir: "", repo: "",
    get store(): Store { if (store === null) throw new Error("store used outside a test"); return store; },
    /** What happens to the project while a script runs (nothing, unless a test swaps a file). */
    whileRunning: () => {},
    io: null as unknown as Io,
  };
  beforeEach(() => {
    plane.dir = scratch();
    plane.repo = join(plane.dir, "site");
    mkdirSync(plane.repo);
    store = openStore(join(plane.dir, "orders.db"));
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok || !addApprover(store, "sam", T0, { name: "alex", token: alex.token }).ok) throw Error("account");
    // Where no OS fence can be made (inside the plane's check, a runner without bubblewrap) an operator allows unconfined agents.
    if (NO_OS_FENCE) store.setUnfencedAgentsAllowed(true, "alex", T0);
    for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
    plane.whileRunning = () => {};
    plane.io = {
      gh: async () => ({ code: 1, stdout: "", stderr: "" }), fetch, dir: plane.dir, scratch: join(plane.dir, "scratch"),
      shell: async () => { plane.whileRunning(); printed += 1; return { code: 0, stdout: JSON.stringify([{ key: `${label}-${printed}`, title: `Bump dependency ${printed}` }]), stderr: "" }; },
    } as unknown as Io;
  });
  afterEach(() => { store?.close(); store = null; });

  const s = () => plane.store;
  const flowDefinition = (start: string) => JSON.stringify(validateFlowDefinition({ version: 1, start, stages: [
    { id: "update", title: "Update them", kind: "task", instructions: "{{card.title}}", planning: "skip", next: "review" },
    { id: "review", title: "Review the updates", kind: "approval", next: "done" },
    { id: "done", title: "Done", kind: "done" },
  ] }));
  return Object.assign(plane, {
    sealed: (task: string | null): boolean => task !== null && s().scopeSealed(task),
    ended: (reason: string) => s().actionLedger({ repos: [plane.repo] }).filter(one => one.action === `flow stopped running on its own: ${reason}`),
    sign: (flow: number, ask: Ask = {}, signer = "alex", now = T0) =>
      signUnattended(s(), { flow, signer, ask: { days: 2, budgetMicrousd: null, dailyRunCap: null, ...ask } }, now),
    /** A flow owned by alex whose plain schedule ("daily 09:00") starts each card in a build. */
    scheduledFlow(): { flow: number; trigger: number } {
      const flow = s().createFlow({ repo: plane.repo, name: "Weekly upkeep", by: "alex", definitionJson: flowDefinition("update") }, T0);
      const made = addFlowTriggerTo(s(), s().getFlow(flow)!, { kind: "schedule", schedule: "daily 09:00", title: "Weekly upkeep", description: null }, "alex", T0, null);
      if (!made.ok) throw Error(made.message);
      return { flow, trigger: made.id };
    },
    /** A flow whose schedule runs the project file `file` as the issues script (`language`), saved by alex. */
    scriptFlow(file: string, language: "shell" | "node"): { flow: number; trigger: number } {
      const saved = saveScript(s(), plane.repo, { name: "issues", about: "Open issues", language, body: "", file, timeoutMinutes: 1 }, "alex", T0);
      if (!saved.ok) throw Error(saved.message);
      const flow = s().createFlow({ repo: plane.repo, name: "Triage", by: "alex", definitionJson: flowDefinition("update") }, T0);
      const made = addFlowTriggerTo(s(), s().getFlow(flow)!, { kind: "schedule", schedule: "daily 09:00", script: "issues" }, "alex", T0, null);
      if (!made.ok) throw Error(made.message);
      return { flow, trigger: made.id };
    },
    /** The clock's own firing of `trigger` at `now` (its slot is due), then the engine files the card's work;
     * `beforeFiling` runs between the two (a restore, a refresh). */
    async fire(trigger: number, now: Date, beforeFiling: () => unknown = () => {}): Promise<{ card: number; task: string | null }> {
      s().updateFlowTrigger(trigger, { nextAt: new Date(now.getTime() - 60_000).toISOString() }, now);
      const before = s().lastFlowTriggerCard(trigger);
      // One card at a time: the last one has left its first zone, as a picked-up card would.
      if (before !== null) s().updateFlowCard(before, { state: "done" }, now);
      await runFlowTriggers(s(), plane.repo, now, plane.io);
      const card = s().lastFlowTriggerCard(trigger);
      if (card === null || card === before) throw Error(`trigger ${trigger} made no new card`);
      await beforeFiling();
      advanceFlows(s(), plane.repo, now);
      return { card, task: s().getFlowCard(card)!.task };
    },
  });
}
