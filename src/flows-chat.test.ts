/**
 * Flows from chat: the lead turns a plain list of steps into a drawing,
 * drafts create/edit/card cards through the shared confirm door, and every
 * card re-checks the flow as it was when drafted — against a real store.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { FLOW_TEMPLATES, flowFromSteps, flowTerms } from "./flows.js";
import { advanceFlows, flowDefinitionOf } from "./flow-engine.js";
import { sharedActionNeedsReview, sharedActionPayload } from "./chat-actions.js";
import { confirmMateProposal } from "./mate-doors.js";
import { executeMateTool } from "./mate-tools.js";
import { confirmedLink } from "./chat-channel.js";

describe("steps into a drawing", () => {
  const steps = [
    { title: "Requests", kind: "inbox" }, { title: "Look into it", kind: "report" }, { title: "Go ahead?", kind: "approval", decider: "alex" },
    { title: "Build", kind: "task" }, { title: "Review", kind: "approval" }, { title: "Tell the team", kind: "notify" },
  ];

  test("each step leads to the next, Done is added, decisions send work back to the nearest step that did work, and new zones are laid out in rows", () => {
    const flow = flowFromSteps(steps, null);
    expect(flow.start).toBe("requests");
    expect(flow.stages.map(one => [one.id, one.next, one.onFail])).toEqual([
      ["requests", "look-into-it", null], ["look-into-it", "go-ahead", null], ["go-ahead", "build", "look-into-it"],
      ["build", "review", null], ["review", "tell-the-team", "build"], ["tell-the-team", "done", null], ["done", null, null],
    ]);
    expect(flow.stages.find(one => one.id === "go-ahead")!.approver).toBe("alex");
    // Left-out instructions carry the card, any send-back note and the earlier research.
    expect(flow.stages.find(one => one.id === "build")!.instructions).toContain("Notes from Look into it:\n{{stage.look-into-it}}");
    expect(flow.stages.find(one => one.id === "tell-the-team")!.message).toBe("Finished: {{card.title}}");
    expect(flow.stages.map(one => [one.zone.x, one.zone.y])).toEqual([[0, 0], [300, 0], [600, 0], [900, 0], [900, 380], [600, 380], [300, 380]]);
    // Steps may point anywhere by name; a name that isn't there is refused in words.
    expect(flowFromSteps([{ title: "Build", kind: "task", ifFails: "requests" }, { title: "Requests", kind: "inbox" }], null).stages[0]!.onFail).toBe("requests");
    expect(() => flowFromSteps([{ title: "Build", kind: "task", next: "Deploy" }], null)).toThrow("Step Build: there's no step called Deploy.");
    expect(() => flowFromSteps([{ title: "Build" }], null)).toThrow("Step Build: choose what it does.");
    expect(() => flowFromSteps([], null)).toThrow("List the flow's steps in order.");
    // Found end to end: the lead names new steps with its own ids and points at them; those ids are kept.
    const named = flowFromSteps([{ id: "inbox", title: "New requests", kind: "inbox" }, { id: "build", title: "Build the fix", kind: "task" },
      { id: "tests", title: "Run unit tests", kind: "check", script: "unit-tests", ifFails: "build" }, { id: "review", title: "Review", kind: "approval", decider: "alex" }], null);
    expect(named.stages.map(one => [one.id, one.next, one.onFail])).toEqual([["inbox", "build", null], ["build", "tests", null], ["tests", "review", "build"], ["review", "done", "build"], ["done", null, null]]);
    // The card says left-out instructions in words, and the operator's own as written.
    const terms = flowTerms(flow, null);
    expect(terms[3]).toBe("4. Build — Build\nThe agent builds what the card asks, using the notes from Look into it, plus any note it was sent back with.\nThen → Review.");
    expect(terms[2]).toBe("3. Go ahead? — Person decides\nDecides: alex. Approve → Build. Send back → Look into it.");
    expect(terms[5]).toBe("6. Tell the team — Message\nPosts: Finished: [card title]\nThen → Done.");
    expect(flowTerms(flowFromSteps([{ title: "Fix", kind: "task", instructions: "Fix {{card.title}} and add a test." }], null), null)[0]).toContain("The agent is asked: Fix [card title] and add a test.");
    // A step name that ends a sentence isn't given another full stop.
    expect(flowTerms(flow, null)[1]).toMatch(/Then → Go ahead\?$/);
  });

  test("an edit keeps zones by id with what they leave out, places a new step beside the one before it, and the card names only what changed", () => {
    const before = flowFromSteps(steps, null);
    const after = flowFromSteps([{ id: "requests" }, { id: "look-into-it" }, { id: "go-ahead" }, { id: "build", planning: "required" },
      { title: "Security check", kind: "approval", decider: "sam" }, { id: "review" }, { id: "tell-the-team" }], before);
    expect(after.stages.map(one => one.id)).toEqual(["requests", "look-into-it", "go-ahead", "build", "security-check", "review", "tell-the-team", "done"]);
    expect(after.stages.find(one => one.id === "go-ahead")).toEqual(before.stages.find(one => one.id === "go-ahead"));
    expect(after.stages.find(one => one.id === "security-check")).toMatchObject({ approver: "sam", next: "review", onFail: "build", zone: { x: 1200, y: 0 } });
    expect(after.stages.find(one => one.id === "review")!.zone).toEqual(before.stages.find(one => one.id === "review")!.zone);
    expect(flowTerms(after, before)).toEqual([
      "Steps: Requests → Look into it → Go ahead? → Build → Security check → Review → Tell the team → Done",
      "4. Build — Build (changed)\nThe agent builds what the card asks, using the notes from Look into it, plus any note it was sent back with.\nPlans first.\nThen → Security check.",
      "5. Security check — Person decides (new)\nDecides: sam. Approve → Review. Send back → Build.",
      "Build and research steps become ordinary tasks, so your usual approvals and checks apply.",
    ]);
    // Removing a step says where its cards go.
    const trimmed = flowFromSteps([{ id: "requests" }, { id: "build" }, { id: "review" }], before);
    expect(flowTerms(trimmed, before)).toContain("Removes Look into it, Go ahead?, Tell the team. Any cards there go back to Requests.");
  });
});

describe("the lead builds and runs a flow", () => {
  let root: string, repo: string, store: Store, who: VerifiedApprover, thread: number, session: number;
  const now = new Date("2026-09-24T09:00:00Z");
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "flows-chat-")));
    repo = join(root, "shop");
    mkdirSync(repo);
    store = openStore(join(root, "orders.db"));
    if (!addApprover(store, "operator", now).ok) throw Error("account");
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", now);
    const verified = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, [repo]);
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintMateSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "flows", ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, now);
    thread = store.openMateThread(who.name, who.ceilingDigest, now).thread.id;
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  /** One lead turn: the tool runs as the model would call it, and its cards are ready to confirm when the turn ends. */
  function lead(name: string, args: Record<string, unknown>) {
    const turn = store.openMateTurn({ approver: who.name, session, thread, credentialKey: "flows", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
    if (!turn.ok) throw Error(turn.reason);
    const started = store.startMateTurn(turn.id, now);
    if (!started.ok) throw Error("start");
    const result = executeMateTool({ store, who, now, step: 1, readDecisions: new Map(), evidenceRoot: root,
      draft: (kind, payload) => store.draftMateProposal({ thread, turn: turn.id, kind, payload, ceilingDigest: who.ceilingDigest }, now) }, name, args);
    store.finalizeMateTurn(turn.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Here it is.", activity: "" } }, now);
    return result;
  }
  const proposalOf = (result: ReturnType<typeof lead>) => {
    if (!result.ok) throw Error(result.message);
    return (result.body as { proposal: number }).proposal;
  };
  const confirm = (id: number) => confirmMateProposal(store, who, id, now, { via: "telegram", evidenceRoot: root });

  test("create from plain steps, add a card, move it, approve it — each a card the operator confirms — and a stale card is refused", () => {
    // With no flows yet, the lead still learns that scripts are the project's and can be saved now.
    expect(lead("get_flows", {})).toMatchObject({ ok: true, body: { flows: [], templates: FLOW_TEMPLATES.map(one => ({ template: one.id })), scripts: [{ project: "r1", scripts: [] }], rule: expect.stringContaining("even before any flow exists") } });
    // Drawn from plain steps, the operator deciding; short enough to confirm right in the chat.
    const created = proposalOf(lead("propose_flow", { operation: "create", repo: "r1", name: "Bug fixes", steps: [
      { title: "Requests", kind: "inbox" }, { title: "Look into it", kind: "report" }, { title: "Go ahead?", kind: "approval", decider: "me" }, { title: "Build", kind: "task" },
    ] }));
    const drafted = sharedActionPayload(store.getMateProposal(created)!.payload)!;
    expect(drafted.title).toBe("Create the Bug fixes flow in shop");
    expect(drafted.terms[2]).toBe("3. Go ahead? — Person decides\nDecides: operator. Approve → Build. Send back → Look into it.");
    expect(sharedActionNeedsReview(drafted)).toBe(false);
    expect(store.listFlows([repo])).toEqual([]);
    const outcome = confirm(created);
    expect(outcome).toMatchObject({ ok: true, said: "Flow created. Add cards to it here or on its canvas.", href: "/flows/1" });
    expect(confirmedLink(store, outcome, store.getMateProposal(created)!, [repo])).toEqual({ label: "Open the flow", path: "/flows/1" });
    const flow = store.listFlows([repo])[0]!;
    expect(lead("get_flows", { flow: flow.id })).toMatchObject({ ok: true, body: { name: "Bug fixes", project: "r1", steps: [
      { id: "requests", does: "Holding", next: "Look into it" }, { id: "look-into-it", does: "Research" },
      { id: "go-ahead", does: "Person decides", decider: "you", next: "Build", ifFails: "Look into it" }, { id: "build", does: "Build", next: "Done" }, { id: "done", next: null },
    ], cards: [] } });

    // A card, then moved by name into research: its step files a task under the usual approvals.
    const added = proposalOf(lead("propose_flow", { operation: "add_card", flow: flow.id, title: "Checkout rounding", description: "Totals are off by a cent" }));
    expect(sharedActionPayload(store.getMateProposal(added)!.payload)!.terms).toEqual(["Checkout rounding\nTotals are off by a cent", "Starts in Requests: Cards wait here until someone moves them."]);
    expect(confirm(added)).toMatchObject({ ok: true, said: "Card added to Requests.", href: "/flows/1?card=1" });
    const moved = proposalOf(lead("propose_flow", { operation: "move_card", card: 1, zone: "look into it" }));
    expect(confirm(moved)).toMatchObject({ ok: true, said: "Moved to Look into it. Its step filed a task under your usual approvals." });
    const card = store.getFlowCard(1)!;
    expect(store.getTask(card.task!)?.title).toBe("Look into it: Checkout rounding");

    // The report is ready: the card waits on the operator, who approves it from chat.
    store.setTaskState(card.task!, "done", now);
    advanceFlows(store, repo, now, { evidenceRoot: root });
    advanceFlows(store, repo, now, { evidenceRoot: root });
    expect(lead("get_flows", { flow: flow.id })).toMatchObject({ ok: true, body: { cards: [{ card: 1, at: "Go ahead?", needsYou: true, waiting: "Waiting for you to approve or send it back" }] } });
    expect(lead("propose_flow", { operation: "send_back", card: 1 })).toEqual({ ok: false, message: "Say what should change." });
    const approve = proposalOf(lead("propose_flow", { operation: "approve", card: 1, note: "Small and safe" }));
    expect(sharedActionPayload(store.getMateProposal(approve)!.payload)!.terms).toEqual(["Go ahead?: approved. It moves to Build.", "Note: Small and safe"]);
    // A card drafted before the flow moved on is refused, not replayed.
    const late = proposalOf(lead("propose_flow", { operation: "cancel_card", card: 1 }));
    expect(confirm(approve)).toMatchObject({ ok: true, said: "Approved. Moved to Build. Its step filed a task under your usual approvals." });
    expect(confirm(late)).toMatchObject({ ok: false, said: "This action changed. Ask for a fresh proposal." });
    expect(store.getFlowCard(1)).toMatchObject({ stage: "build", state: "active" });
  });

  test("an edit is checked against the flow it was drafted from; names, keys and the generic action door are refused", () => {
    const flow = store.createFlow({ repo, name: "Bug fixes", definitionJson: JSON.stringify(FLOW_TEMPLATES[0]!.definition), by: "operator" }, now);
    const steps = [{ id: "inbox" }, { id: "triage" }, { id: "go-ahead" }, { id: "build" }, { title: "Security check", kind: "approval", decider: "me" }, { id: "review" }, { id: "announce" }, { id: "done" }];
    const edit = proposalOf(lead("propose_flow", { operation: "edit", flow, steps }));
    const payload = sharedActionPayload(store.getMateProposal(edit)!.payload)!;
    expect(payload.title).toBe("Change the Bug fixes flow");
    expect(payload.terms[0]).toBe("Steps: Inbox → Triage → Go ahead? → Build → Security check → Review → Tell the team → Done");
    expect(payload.terms).toContain("5. Security check — Person decides (new)\nDecides: operator. Approve → Review. Send back → Build.");
    // Someone saves the flow first: the drafted edit no longer applies.
    const rename = proposalOf(lead("propose_flow", { operation: "edit", flow, name: "Bugs" }));
    expect(confirm(rename)).toMatchObject({ ok: true, said: "Flow saved.", href: "/flows/1" });
    expect(confirm(edit)).toMatchObject({ ok: false, said: "This action changed. Ask for a fresh proposal." });
    expect(store.getFlow(flow)).toMatchObject({ name: "Bugs", revision: 2 });
    expect(lead("propose_flow", { operation: "edit", flow, name: "Bugs" })).toEqual({ ok: false, message: "That's the flow as it is now." });
    // A decider must be someone who can approve here; a card can't carry a key; the generic door points to propose_flow.
    expect(lead("propose_flow", { operation: "create", repo: "r1", name: "Other", steps: [{ title: "Check", kind: "approval", decider: "sam" }] }))
      .toEqual({ ok: false, message: "No one called sam can approve on this project. Name someone who can, or let anyone who approves decide." });
    expect(lead("propose_flow", { operation: "add_card", flow, title: "Use key", description: `token ${["ghp", "x".repeat(36)].join("_")}` }))
      .toEqual({ ok: false, message: "That looks like a key or password. Cards become agent instructions; keep secrets out of them." });
    expect(lead("propose_flow", { operation: "create", repo: "r1", name: "Both", template: "coding", steps: [{ title: "A", kind: "inbox" }] })).toEqual({ ok: false, message: "Give a template or the steps, not both." });
    expect(lead("propose_action", { operation: "flow_create", repo: "r1" })).toMatchObject({ ok: false });
    expect(JSON.stringify(lead("get_actions", {}))).not.toContain("flow_");
    // Cards have people too: the lead comments and takes a card on, each a card the operator confirms.
    const target = store.addFlowCard({ flow, title: "Login is slow", description: null, stage: "inbox", by: "operator" }, now);
    const comment = proposalOf(lead("propose_flow", { operation: "comment", card: target, note: "Profiling shows the session lookup." }));
    expect(sharedActionPayload(store.getMateProposal(comment)!.payload)!.terms).toEqual(["Profiling shows the session lookup.", "Its owner and followers hear about it."]);
    expect(confirm(comment)).toMatchObject({ ok: true, said: "Comment added.", href: `/flows/${flow}?card=${target}` });
    const assign = proposalOf(lead("propose_flow", { operation: "assign", card: target, owner: "me" }));
    expect(sharedActionPayload(store.getMateProposal(assign)!.payload)!.title).toBe("Make you the owner of “Login is slow”");
    expect(confirm(assign)).toMatchObject({ ok: true, said: "You own it now." });
    expect(store.getFlowCard(target)).toMatchObject({ owner: "operator" });
    expect(lead("propose_flow", { operation: "assign", card: target, owner: "me" })).toEqual({ ok: false, message: "You already own it." });
    expect(lead("get_flows", { flow, card: target })).toMatchObject({ ok: true, body: { cards: [{ card: target, owner: "you", following: true, comments: 1, discussion: [{ by: "you", text: "Profiling shows the session lookup." }] }] } });
    // Scripts: the lead drafts one as a card; confirming saves it for every flow in the project. Insights read back.
    const script = proposalOf(lead("propose_flow", { operation: "save_script", repo: "r1", script: { name: "run-tests", about: "Runs the unit tests", body: "npm ci\nnpm test", timeoutMinutes: 10 } }));
    const scriptCard = sharedActionPayload(store.getMateProposal(script)!.payload)!;
    expect(scriptCard.title).toBe("Save the run-tests script in shop");
    expect(scriptCard.terms).toEqual(["run-tests: Runs the unit tests", "npm ci\nnpm test", "Shell, with no AI, for up to 10 minutes, whenever a card reaches a zone that runs it (or a schedule does). It gets the card as data; what it prints is passed on."]);
    expect(sharedActionNeedsReview(scriptCard)).toBe(false);
    expect(confirm(script)).toMatchObject({ ok: true, said: "Saved the run-tests script. Any flow in this project can run it." });
    expect(store.flowScript(repo, "run-tests")).toMatchObject({ version: 1, savedBy: "operator" });
    expect(lead("get_flow_insights", {})).toMatchObject({ ok: true, body: { days: 30, flows: [{ flow, name: "Bugs", breaks: [] }] } });
    expect(lead("get_flow_insights", { flow })).toMatchObject({ ok: true, body: { name: "Bugs", cards: { active: 1 } } });
    // A template is a card too.
    const coding = proposalOf(lead("propose_flow", { operation: "create", repo: "r1", template: "coding" }));
    expect(confirm(coding)).toMatchObject({ ok: true, href: "/flows/2" });
    expect(store.getFlow(2)).toMatchObject({ name: "Coding flow" });
  });

  test("a choice from chat: the lead drafts the flow with options, sees the card waiting on you, and chooses or replies only as you confirm", () => {
    const created = proposalOf(lead("propose_flow", { operation: "create", repo: "r1", name: "Fixes", steps: [
      { title: "Build", kind: "task" }, { title: "Send me the result", kind: "send" },
      { title: "What next?", kind: "choose", options: [{ label: "Ship it", goesTo: "Ship" }, { label: "Ignore", goesTo: "end" }] }, { title: "Ship", kind: "inbox" },
    ] }));
    expect(sharedActionPayload(store.getMateProposal(created)!.payload)!.terms[2]).toBe("3. What next? — Person chooses\nSends the card's owner (or the flow's) what the step before produced, and asks them to choose:\nShip it → Ship.\nIgnore → ignores the card.\nOr a reply with what they'd change → Build.");
    expect(confirm(created)).toMatchObject({ ok: true });
    const flow = store.listFlows([repo])[0]!;
    expect(lead("get_flows", { flow: flow.id })).toMatchObject({ ok: true, body: { steps: [{ id: "build" }, { id: "send-me-the-result", kind: "send", next: "What next?" },
      { id: "what-next", kind: "choose", options: [{ choice: 1, label: "Ship it", goesTo: "Ship" }, { choice: 2, label: "Ignore", goesTo: "end" }], ifReplied: "Build" }, { id: "ship" }, { id: "done" }] } });
    const one = store.addFlowCard({ flow: flow.id, title: "Checkout rounding", description: "Off by a cent", stage: "what-next", by: "operator" }, now);
    const two = store.addFlowCard({ flow: flow.id, title: "Header spacing", description: null, stage: "what-next", by: "operator" }, now);
    advanceFlows(store, repo, now, { evidenceRoot: root });
    expect(lead("get_flows", { flow: flow.id })).toMatchObject({ ok: true, body: { cards: [{ card: two, needsYou: true }, { card: one, needsYou: true, waiting: "Waiting for you to choose (operation choose: choice by number, or note to reply)" }] } });
    // A choice waiting on you counts as needing you.
    expect(lead("get_flows", {})).toMatchObject({ ok: true, body: { flows: [{ flow: flow.id, needYou: 2 }] } });
    expect(lead("propose_flow", { operation: "choose", card: one, choice: 3 })).toEqual({ ok: false, message: "Choose one of its 2 options, by number." });
    expect(lead("propose_flow", { operation: "choose", card: one })).toEqual({ ok: false, message: "Say what you'd change, or choose an option by number." });
    const ship = proposalOf(lead("propose_flow", { operation: "choose", card: one, choice: 1 }));
    expect(sharedActionPayload(store.getMateProposal(ship)!.payload)!).toMatchObject({ title: "Choose “Ship it” for “Checkout rounding”", terms: ["What next?: “Ship it”. It moves to Ship."] });
    expect(store.getFlowCard(one)!.stage).toBe("what-next");
    // The option is bound as proposed: relabelled before it is confirmed, it is refused and nothing moves.
    const drawn = flowDefinitionOf(store.getFlow(flow.id)!)!;
    const relabelled = { ...drawn, stages: drawn.stages.map(one => one.id === "what-next" ? { ...one, options: [{ ...one.options![0]!, label: "Ship it now" }, one.options![1]!] } : one) };
    expect(store.saveFlow(flow.id, { name: flow.name, definitionJson: JSON.stringify(relabelled), sawRevision: flow.revision, by: "operator" }, now)).toBe(true);
    expect(confirm(ship)).toMatchObject({ ok: false, reason: "stale" });
    expect(store.getFlowCard(one)!.stage).toBe("what-next");
    expect(store.saveFlow(flow.id, { name: flow.name, definitionJson: JSON.stringify(drawn), sawRevision: flow.revision + 1, by: "operator" }, now)).toBe(true);
    expect(confirm(proposalOf(lead("propose_flow", { operation: "choose", card: one, choice: 1 })))).toMatchObject({ ok: true, said: "Ship it. Moved to Ship." });
    expect(store.getFlowCard(one)!.stage).toBe("ship");
    const reply = proposalOf(lead("propose_flow", { operation: "choose", card: two, note: "Use 16px." }));
    expect(sharedActionPayload(store.getMateProposal(reply)!.payload)!.terms).toEqual(["What next?: your reply goes to Build as its note:\nUse 16px."]);
    expect(confirm(reply)).toMatchObject({ ok: true });
    expect(store.getFlowCard(two)).toMatchObject({ stage: "build", note: "Use 16px." });
    expect(store.flowEvents(two).at(-1)).toMatchObject({ actor: "operator", outcome: "sent-back" });
  });

  test("\"do this every time\": the lead offers a starter flow as one card, saying what it does and never does; confirming makes its trigger and zones", () => {
    const offered = lead("propose_flow", { operation: "starter", repo: "r1", starter: "overnight" });
    const card = sharedActionPayload(store.getMateProposal(proposalOf(offered))!.payload)!;
    expect(card.title).toBe("Switch on Overnight queue in shop");
    expect(card.terms).toEqual(["Cards you add during the day start after 22:00; results wait for you in the morning.", "Adds a “Queue for tonight” button.",
      "Holds each card until 22:00, then builds it as a task, under your usual approvals.", "Results wait for your review in the morning.", "Never merges or ships anything without you."]);
    expect(confirm(proposalOf(offered))).toMatchObject({ ok: true, said: "Overnight queue is on.", href: "/flows/1" });
    expect(store.flowTriggers(1).map(one => JSON.parse(one.configJson))).toEqual([expect.objectContaining({ kind: "button", label: "Queue for tonight", zone: "tonight" })]);
    // Once on, it isn't offered again; a GitHub starter on a project that isn't on GitHub says why.
    expect(lead("propose_flow", { operation: "starter", repo: "r1", starter: "overnight" })).toMatchObject({ ok: false, message: expect.stringContaining("Overnight queue is already on in") });
    expect(lead("propose_flow", { operation: "starter", repo: "r1", starter: "ci-fix" })).toMatchObject({ ok: false, message: expect.stringContaining("This project isn't on GitHub") });
  });
});
