/**
 * The one road for a change to what a flow runs: its drawing saved, or a script one of its zones runs saved or removed.
 * Every approval a person gave for the flow as it was ends here, in the same transaction as the write, with its ledger
 * line, so the flow page, `flows show` and chat all say it ended and why:
 *  - "Runs on its own" (flow-unattended.ts): its grants end ("flow changed" / "script changed"), and the work they
 *    pre-authorized falls back to a person.
 *  - Browser use (flow-browser.ts): its approval seals the drawing and each browser zone's script, so the change itself
 *    stops it standing (browserStanding re-proves at every launch). Here it is said once in the ledger, for each
 *    flow whose approval stood before the write and doesn't after; the page shows it as expired with the reason.
 * Nothing here widens anything: it only ends approvals.
 */
import { browserViewOf } from "./flow-browser.js";
import { endUnattendedGrants } from "./flow-unattended.js";
import type { FlowRow, Store } from "./store.js";

export type FlowChange = { flow: number } | { script: { repo: string; name: string } };

/** The flows a change reaches: the flow itself, or every flow in the script's project with a zone that runs it. */
function flowsOf(store: Store, change: FlowChange): FlowRow[] {
  if ("flow" in change) { const flow = store.getFlow(change.flow); return flow === null ? [] : [flow]; }
  return store.listFlows([change.script.repo]).filter(flow => {
    try {
      const drawn = JSON.parse(flow.definitionJson) as { stages?: { kind?: unknown; script?: unknown }[] };
      return (drawn.stages ?? []).some(stage => stage.kind === "check" && stage.script === change.script.name);
    } catch { return false; }
  });
}

/**
 * Run `write` (the change itself) and end what it ends, all in one transaction. `write` answers whether it changed
 * anything; when it didn't, nothing else happens. Returns what `write` returned.
 */
export function flowChanged<T>(store: Store, change: FlowChange, by: string, now: Date, write: () => T, changed: (result: T) => boolean = result => result === true): T {
  return store.transact(() => {
    const before = new Map(flowsOf(store, change).map(flow => [flow.id, browserViewOf(store, flow)?.status === "allowed"]));
    const result = write();
    if (!changed(result)) return result;
    if ("flow" in change) endUnattendedGrants(store, { flow: change.flow }, by, "flow changed", now);
    else endUnattendedGrants(store, { script: change.script }, by, "script changed", now);
    for (const [id, stood] of before) {
      const flow = store.getFlow(id);
      if (!stood || flow === null || browserViewOf(store, flow)?.status === "allowed") continue;
      store.recordAction({ at: now.toISOString(), actor: by, repo: flow.repo, taskId: null, runId: null, source: "policy", action: "flow browser use: ended", outcome: "ended",
        detail: `${flow.name} (flow #${flow.id}) · ${"flow" in change ? "the flow changed" : `the ${change.script.name} script changed`}` });
    }
    return result;
  });
}
