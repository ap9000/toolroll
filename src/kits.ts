/**
 * Starter kits: a working setup in one click — a subagent, the flow
 * it works, and the triggers that are safe to add straight away — plus a
 * checklist of what's left (connect email, connect a tool) and a sample card
 * that shows the subagent at work within seconds.
 *
 * A kit adds nothing a person couldn't add by hand, and nothing that acts
 * outside: replies go out only after you approve them, a code change is filed
 * as an ordinary task you approve, and tools start with reading free and
 * writing asking first.
 */
import { addCardToFlow, flowCardHref, flowDefinitionOf } from "./flow-engine.js";
import { flowFromSteps, type FlowStepInput } from "./flows.js";
import { addFlowTriggerTo, githubRepoOf, triggerConfigOf } from "./flow-triggers.js";
import { googleConnected } from "./google-mail.js";
import { readEmailSettings } from "./email-settings.js";
import { mailboxReady } from "./mailbox.js";
import { projectToolsOf } from "./project-tools.js";
import type { FlowRow, Store, SubagentRow } from "./store.js";
import { createSubagentFrom, nameOf } from "./subagent-admin.js";
import { grantListed, grantTool, type ToolIo } from "./subagent-tools.js";
import { SUBAGENT_TEMPLATES } from "./subagents.js";

/** A tool a kit's subagent works better with: the catalog entry that connects it, and why. */
export type KitTool = { tool: string; label: string; why: string };
export type Kit = {
  id: string; name: string; promise: string;
  /** The subagent it hires: a template, and the name it starts with. */
  subagent: { template: string; handle: string };
  flowName: string;
  steps: FlowStepInput[];
  /** Triggers safe to add at once: buttons (they fire only when pressed). */
  buttons: { label: string; questions: string[] }[];
  /** Other ways in, offered on its checklist. */
  email?: boolean; github?: boolean;
  tools: KitTool[];
  sample: { title: string; description: string };
};

export const KITS: readonly Kit[] = [
  {
    id: "support-desk", name: "Support desk",
    promise: "Maya answers customer emails, looks orders up and refunds within limits you set. You approve each reply before it goes out.",
    subagent: { template: "support", handle: "maya" },
    flowName: "Support desk",
    steps: [
      { id: "answer", title: "Maya answers", kind: "subagent", subagent: "maya",
        instructions: "Read the customer's message. Look things up (and refund, within your rules) with your tools when it helps. Write the reply we'd send in \"text\". Pick Reply when it's ready for the customer, or Needs a person when your rules say to ask first or you can't help.",
        routes: [{ answer: "Reply", goesTo: "You check the reply" }, { answer: "Needs a person", goesTo: "For you" }], ifFails: "For you" },
      { id: "check", title: "You check the reply", kind: "approval", decider: "owner", next: "Send it", ifFails: "Maya answers" },
      { id: "send", title: "Send it", kind: "email", to: "{{card.email}}", subject: "Re: {{card.title}}", body: "{{stage.answer}}", next: "Done", ifFails: "For you" },
      { id: "person", title: "For you", kind: "inbox" },
      { id: "done", title: "Done", kind: "done" },
    ],
    buttons: [], email: true,
    tools: [
      { tool: "stripe", label: "Stripe", why: "so Maya can look payments up and refund within its limit" },
      { tool: "intercom", label: "Intercom", why: "so Maya can read and answer your support conversations" },
    ],
    sample: { title: "Where's my order? It's been 9 days", description: "Hi! I ordered a desk lamp on the 14th (order #1042) and it still hasn't arrived. Could you check where it is? Thanks, Priya (priya@example.com)\n\nOrder #1042 in the shop: shipped on the 15th by UPS, out for delivery tomorrow." },
  },
  {
    id: "bug-triage", name: "Bug triage",
    promise: "Theo reads every new issue, says what it is and how urgent, answers questions, and turns real bugs into fixes you approve.",
    subagent: { template: "triage", handle: "theo" },
    flowName: "Bug triage",
    steps: [
      { id: "sort", title: "Theo sorts it", kind: "subagent", subagent: "theo",
        instructions: "Read the report. In \"text\", say in one or two sentences what it is and how urgent (for a bug, add what you'd check first; for a question, write the answer). Pick Bug for something broken in this project's code, Question for someone asking how something works, or Duplicate or noise for anything else, saying why.",
        routes: [{ answer: "Bug", goesTo: "Fix it" }, { answer: "Question", goesTo: "Answered" }, { answer: "Duplicate or noise", goesTo: "Closed" }], ifFails: "For you" },
      { id: "fix", title: "Fix it", kind: "task", planning: "auto", instructions: "Fix the bug this card reports. Theo's notes on it: {{stage.sort}}", next: "You review the fix" },
      { id: "review", title: "You review the fix", kind: "approval", decider: "owner", next: "Done", ifFails: "Fix it" },
      { id: "answered", title: "Answered", kind: "inbox" },
      { id: "person", title: "For you", kind: "inbox" },
      { id: "closed", title: "Closed", kind: "done" },
      { id: "done", title: "Done", kind: "done" },
    ],
    buttons: [{ label: "Report a bug", questions: ["What's wrong?", "How do we see it happen?"] }], github: true,
    tools: [
      { tool: "sentry", label: "Sentry", why: "so Theo can see the errors behind a report" },
      { tool: "linear", label: "Linear", why: "so Theo can find duplicates in your issues" },
    ],
    sample: { title: "Checkout button does nothing on Safari", description: "On Safari 18 (Mac), pressing Checkout on the cart page does nothing: no error on screen, no redirect. Chrome works fine. Started after yesterday's release." },
  },
  {
    id: "sales-follow-up", name: "Sales follow-up",
    promise: "Leo writes back to every new lead within minutes, you approve the email, and it waits for their answer, so no lead goes cold.",
    subagent: { template: "sales", handle: "leo" },
    flowName: "Sales follow-up",
    steps: [
      { id: "write", title: "Leo writes back", kind: "subagent", subagent: "leo",
        instructions: "Read the lead. In \"text\", write a short, friendly first reply that answers what they asked and suggests one clear next step. Pick Write back, or Not a fit (say why).",
        routes: [{ answer: "Write back", goesTo: "You check it" }, { answer: "Not a fit", goesTo: "Not a fit" }], ifFails: "Not a fit" },
      { id: "check", title: "You check it", kind: "approval", decider: "owner", next: "Send it", ifFails: "Leo writes back" },
      { id: "send", title: "Send it", kind: "email", to: "{{card.email}}", subject: "Re: {{card.title}}", body: "{{stage.write}}", next: "Wait for them", ifFails: "Not a fit" },
      { id: "wait", title: "Wait for them", kind: "wait", waitFor: "reply", wait: "3 days", next: "They replied", ifNoReply: "No reply yet" },
      { id: "replied", title: "They replied", kind: "inbox" },
      { id: "quiet", title: "No reply yet", kind: "inbox" },
      { id: "no-fit", title: "Not a fit", kind: "done" },
    ],
    buttons: [{ label: "New lead", questions: ["Who are they?", "Their email", "What do they want?"] }], email: true,
    tools: [{ tool: "attio", label: "Attio", why: "so Leo can look leads up in your CRM and log each reply" }],
    sample: { title: "Acme Co wants a demo", description: "Hi, I'm Dana, head of ops at Acme Co (about 40 people). We're looking for a better way to handle customer requests and would love a demo next week. dana@acme.example" },
  },
  {
    id: "ops-requests", name: "Ops requests",
    promise: "Ada approves routine requests under $200 without you and brings you everything else, so the team gets answers the same day.",
    subagent: { template: "ops", handle: "ada" },
    flowName: "Ops requests",
    steps: [
      { id: "decide", title: "Ada decides", kind: "approval", subagent: "ada", decider: "owner", next: "Tell the team", ifFails: "Needs more" },
      { id: "tell", title: "Tell the team", kind: "notify", message: "Approved: {{card.title}}", next: "Done" },
      { id: "more", title: "Needs more", kind: "inbox" },
      { id: "done", title: "Done", kind: "done" },
    ],
    buttons: [{ label: "Ask for something", questions: ["What do you need?", "Why?", "What will it cost?"] }],
    tools: [
      { tool: "notion", label: "Notion", why: "so Ada can check your team's policies and past requests" },
      { tool: "atlassian", label: "Jira", why: "so Ada can file the ticket once something's approved" },
    ],
    sample: { title: "New monitor for Sam", description: "Sam's monitor died this morning. A replacement 27\" monitor, same model as the rest of the team: $180. Sam needs it to work. Owner: Sam." },
  },
];

export const kitOf = (id: string): Kit | null => KITS.find(one => one.id === id) ?? null;

type Done = { ok: true; said: string; flow: number; subagent: number } | { ok: false; said: string };

/** A kit set up in a project: its flow (by name) and its subagent, when both are there. */
export function kitInstalled(store: Store, kit: Kit, repo: string): { flow: FlowRow; mate: SubagentRow } | null {
  const mate = store.subagentByHandle(repo, kit.subagent.handle);
  const flow = store.listFlows([repo]).find(one => one.name === kit.flowName && one.state === "active") ?? null;
  return mate === null || flow === null ? null : { flow, mate };
}

/**
 * Set a kit up: its subagent (kept if one of that name is already there), its
 * flow, and its button triggers; then its subagent may use whichever of the
 * kit's tools the project already has (reading free, writing asking first).
 */
export async function setUpKit(store: Store, kit: Kit, repo: string, by: string, now: Date, dir: string | null, io: ToolIo = {}): Promise<Done> {
  const made = setUpKitNow(store, kit, repo, by, now, dir);
  if (!made.ok || made.said.endsWith("already set up here.")) return made;
  const mate = store.getSubagent(made.subagent)!;
  const present = new Set(projectToolsOf(store, repo).map(one => one.name));
  for (const tool of kit.tools.filter(one => present.has(one.tool))) {
    try { await grantTool(store, mate, tool.tool, by, now, io); } catch { /* it can be given the tool on its page */ }
  }
  return made;
}

/** The same, all at once (a chat confirmation can't wait on a tool): its subagent is given the kit's connected tools by the names their last test found, and each is listed properly on its first turn. */
export function setUpKitNow(store: Store, kit: Kit, repo: string, by: string, now: Date, dir: string | null, grantByName = false): Done {
  const had = kitInstalled(store, kit, repo);
  if (had !== null) return { ok: true, said: `${kit.name} is already set up here.`, flow: had.flow.id, subagent: had.mate.id };
  let mate = store.subagentByHandle(repo, kit.subagent.handle);
  if (mate === null) {
    const template = SUBAGENT_TEMPLATES.find(one => one.id === kit.subagent.template);
    if (template === undefined) return { ok: false, said: "That kit's subagent template is missing." };
    const made = createSubagentFrom(store, { repo, template: template.id, by }, now);
    if (!made.ok) return { ok: false, said: made.said };
    mate = store.getSubagent((made as { id: number }).id)!;
  }
  let definition;
  try { definition = flowFromSteps(kit.steps, null); } catch (error) { return { ok: false, said: `The kit's flow didn't fit: ${error instanceof Error ? error.message : "unknown"}` }; }
  const flowId = store.createFlow({ repo, name: kit.flowName, definitionJson: JSON.stringify(definition), by }, now);
  const flow = store.getFlow(flowId)!;
  for (const button of kit.buttons) addFlowTriggerTo(store, flow, { kind: "button", label: button.label, questions: button.questions, zone: definition.start }, by, now, dir);
  if (grantByName) for (const tool of projectToolsOf(store, repo).filter(one => kit.tools.some(each => each.tool === one.name))) grantListed(store, mate, tool, null, by, now);
  return { ok: true, said: `${kit.name} is ready: ${nameOf(mate)} works its ${kit.flowName} flow.`, flow: flowId, subagent: mate.id };
}

/** One line of a kit's checklist: done, or the next step with where to take it. */
export type KitStep = { id: string; done: boolean; said: string; href: string | null; action?: "sample" | "github" | "connect"; tool?: string };

/** What's set up and what's left, read fresh each time. */
export function kitChecklist(store: Store, kit: Kit, repo: string, dir: string | null): KitStep[] {
  const set = kitInstalled(store, kit, repo);
  if (set === null) return [];
  const name = nameOf(set.mate);
  const steps: KitStep[] = [
    { id: "subagent", done: true, said: `${name} joined the team`, href: `/settings/lead/subagents/${set.mate.id}` },
    { id: "flow", done: true, said: `The ${kit.flowName} flow is ready`, href: `/flows/${set.flow.id}` },
  ];
  if (kit.email === true) {
    // (flow-actions' sendingReady, without its imports: kits load beside the chat actions.)
    const ready = (googleConnected(dir) !== null || readEmailSettings(dir) !== null) && mailboxReady(dir);
    steps.push({ id: "email", done: ready, said: ready ? "Email is connected" : "Connect your email so replies go out and answers come back", href: "/settings#email" });
  }
  if (kit.github === true) {
    const github = githubRepoOf(repo);
    const watching = store.flowTriggers(set.flow.id).some(one => one.state !== "removed" && triggerConfigOf(one)?.kind === "github");
    if (github !== null) steps.push({ id: "github", done: watching, said: watching ? `New issues on ${github} come in` : `Bring in new issues from ${github}`, href: watching ? `/flows/${set.flow.id}` : null, ...(watching ? {} : { action: "github" as const }) });
  }
  const tools = projectToolsOf(store, repo);
  for (const tool of kit.tools) {
    const connected = tools.some(one => one.name === tool.tool);
    const granted = store.subagentGrant(set.mate.id, tool.tool) !== null;
    steps.push(connected && granted
      ? { id: `tool-${tool.tool}`, done: true, said: `${name} can use ${tool.label}`, href: `/settings/lead/subagents/${set.mate.id}#tools` }
      : connected
        ? { id: `tool-${tool.tool}`, done: false, said: `Let ${name} use ${tool.label}, ${tool.why}`, href: `/settings/lead/subagents/${set.mate.id}#tools` }
        : { id: `tool-${tool.tool}`, done: false, said: `Connect ${tool.label}, ${tool.why}`, href: `/settings/tools?repo=${encodeURIComponent(repo)}&kit=${kit.id}&connect=${tool.tool}#connect`, action: "connect", tool: tool.tool });
  }
  const tried = store.flowCards(set.flow.id, true).length > 0;
  steps.push({ id: "sample", done: tried, said: tried ? `${name} has worked a card` : `See ${name} work a sample card`, href: tried ? `/flows/${set.flow.id}` : null, ...(tried ? {} : { action: "sample" as const }) });
  return steps;
}

/** A sample card in the kit's first zone, so its subagent starts on it at once. */
export function addKitSample(store: Store, kit: Kit, repo: string, by: string, now: Date): { ok: true; href: string } | { ok: false; said: string } {
  const set = kitInstalled(store, kit, repo);
  if (set === null) return { ok: false, said: `Set ${kit.name} up first.` };
  const definition = flowDefinitionOf(set.flow);
  const added = addCardToFlow(store, set.flow, { title: kit.sample.title, description: kit.sample.description, stage: definition?.start ?? null }, by, now);
  return added.ok ? { ok: true, href: flowCardHref(set.flow.id, added.card!) } : { ok: false, said: added.message };
}

/** Bring new issues from the project's GitHub repository into the kit's flow (issues from anyone, polled). */
export function addKitGithubTrigger(store: Store, kit: Kit, repo: string, by: string, now: Date, dir: string | null): { ok: true; said: string } | { ok: false; said: string } {
  const set = kitInstalled(store, kit, repo);
  const github = githubRepoOf(repo);
  if (set === null || github === null) return { ok: false, said: "This project isn't on GitHub." };
  const made = addFlowTriggerTo(store, set.flow, { kind: "github", repo: github, watch: "issues", from: "anyone", delivery: "poll", zone: flowDefinitionOf(set.flow)?.start }, by, now, dir);
  return made.ok ? { ok: true, said: `New issues on ${github} now come into ${kit.flowName}.` } : { ok: false, said: made.message };
}
