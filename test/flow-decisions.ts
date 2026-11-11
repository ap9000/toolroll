/** A flow with a card waiting in each kind of zone (docs/plans/home-other-asks.md part 4): who each waits on is read by
 * the flow page and Home through one rule (flows-ui.ts flowCardWaitsOn). Shared by the flows-ui and home-asks tests. */
import { NO_REPLY_MOVE_ON } from "../src/flow-engine.js";
import { flowFromSteps } from "../src/flows.js";
import type { Store } from "../src/store.js";
import { SUBAGENT_TEMPLATES } from "../src/subagents.js";

export const FLOW_NOW = new Date("2026-11-11T12:00:00Z");
export const FLOW_REPO = "/repos/flows-home";
const NOW = FLOW_NOW;

/** One flow (owned by alex) with a card waiting in each kind of zone; returns the card ids by name. */
export function decisionsFlow(store: Store, repo = FLOW_REPO): { flow: number; cards: Record<string, number> } {
  const definition = flowFromSteps([
    { id: "sam-decides", title: "Sam decides", kind: "approval", decider: "sam" },
    { id: "owner-decides", title: "Owner decides", kind: "approval", decider: "owner" },
    { id: "anyone", title: "Anyone decides", kind: "approval" },
    { id: "pick", title: "Pick one", kind: "choose", options: [{ label: "Ship it", goesTo: "Done" }, { label: "Ignore", goesTo: "end" }] },
    { id: "hold", title: "Wait for reply", kind: "wait", waitFor: "reply", wait: "3 days" },
    { id: "inbox", title: "Inbox", kind: "inbox" },
  ], null);
  // A zone a subagent decides first (v92).
  const anyone = definition.stages.find(one => one.id === "anyone")!;
  definition.stages.push({ ...anyone, id: "maya-decides", title: "Maya decides", subagent: "maya" });
  const flow = store.createFlow({ repo, name: "Refunds", by: "alex", definitionJson: JSON.stringify(definition) }, NOW);
  const card = (title: string, stage: string, waiting: string | null = null) => {
    const id = store.addFlowCard({ flow, title, description: null, stage, by: "alex", byKind: "person" }, NOW);
    if (waiting !== null) store.updateFlowCard(id, { waiting }, NOW);
    return id;
  };
  const cards = {
    sam: card("Refund $30", "sam-decides", "Waiting for sam"),
    owner: card("Refund $40", "owner-decides", "Waiting for alex"),
    anyone: card("Refund $50", "anyone", "Waiting for an approver"),
    maya: card("Refund $60", "maya-decides", "Maya is deciding"),
    mayaHanded: card("Refund $65", "maya-decides", "Maya handed it over"),
    pick: card("Pick a reply", "pick", "Waiting for sam to choose"),
    replied: card("Ask the customer", "hold", `No reply after 3 days. ${NO_REPLY_MOVE_ON}`),
    replying: card("Still asking", "hold", "Waiting for a reply."),
    askedSam: card("Tool call", "inbox", "Waiting on sam"),
    askedJo: card("Question for jo", "inbox", "Waiting on jo"),
  };
  store.setFlowCardOwner(cards.pick, "sam", "alex", NOW);
  const mate = store.createSubagent({ repo, handle: "maya", soul: SUBAGENT_TEMPLATES[0]!.soul, model: null, manager: "alex", by: "alex" }, NOW);
  const ask = (cardId: number, askedOf: string) => store.openSubagentQuestion({ subagent: mate, card: cardId, entry: store.getFlowCard(cardId)!.entry, question: "Refund it?",
    options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], askedOf }, NOW);
  ask(cards.askedSam, "sam");
  ask(cards.askedJo, "jo");
  return { flow, cards };
}

