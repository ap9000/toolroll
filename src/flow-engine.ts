/**
 * The flow engine: moves cards through their flow's zones. Deterministic
 * and model-free — it runs in a worker's pass beside routines, files work
 * through the ordinary task door (so every approval and check a task needs
 * still applies), reads task state, posts messages through the outbox, and
 * waits for people. See flows.ts for what each zone does.
 */
import { assignmentOf } from "./assignment.js";
import { filerFor } from "./approval-policy.js";
import { diagnoseTaskDispatch } from "./dispatch.js";
import { passOn, TEXT_LIMITS } from "./text-limits.js";
import { deciderOf, durationWords, fillFlowText, flowGoal, flowValueLabel, flowWorkTemplate, validateFlowDefinition, withinHours, type FlowDefinition, type FlowStage } from "./flows.js";
import { reportFillIns, reportSummaryFor } from "./report-summary.js";
import { fileTaskProposal } from "./proposal.js";
import { requestResultChanges } from "./result-actions.js";
import { revisionSourceOf } from "./result-review.js";
import { readVerifiedReport, scanForSecrets } from "./evidence.js";
import { cardFollowers, notifyPeople } from "./flow-people.js";
import { DRAFT_CHARS, keptDraft } from "./flow-draft.js";
import { chooseStep, flowPersonOf, sendStep } from "./flow-send.js";
import { parseSoul, teammateLabel } from "./teammates.js";
import type { FlowCardRow, FlowRow, Store, TeammateRow } from "./store.js";

export type FlowAdvance = { moved: number; filed: string[]; problems: string[] };

/** The flow's drawing, or null when it can't be read (the card then says so and waits). */
export function flowDefinitionOf(flow: FlowRow): FlowDefinition | null {
  try { return validateFlowDefinition(JSON.parse(flow.definitionJson), { stored: true }); } catch { return null; }
}

/** Where a card's link opens: the flow's canvas with the card selected. */
export const flowCardHref = (flow: number, card: number) => `/flows/${flow}?card=${card}`;
/** Where a confirmed flow action may point: a flow's canvas, maybe with one card open. */
export const FLOW_HREF = /^\/flows\/[1-9][0-9]{0,9}(\?card=[1-9][0-9]{0,9})?$/;

const ACCEPTANCE = {
  report: [{ id: "c1", statement: "The report answers the request, citing where in the repository each point comes from", how: null, evidence: ["manual-review"] }],
  task: [{ id: "c1", statement: "The requested change is made and the project's existing checks still pass", how: null, evidence: ["manual-review"] }],
};

function fill(template: string, card: FlowCardRow): string {
  return fillFlowText(template, { title: card.title, description: card.description, note: card.note, outputs: card.outputs });
}

const titleIn = (definition: FlowDefinition, id: string) => definition.stages.find(one => one.id === id)?.title ?? id;
const flowDefinitionStage = (definition: FlowDefinition, id: string) => definition.stages.find(one => one.id === id);

/** A teammate's name as its soul file gives it (its handle when the file can't be read). */
function teammateName(mate: TeammateRow): string {
  const read = parseSoul(mate.soul);
  return read.ok ? read.soul.name : mate.handle;
}

/** What a teammate said when it handed a card to its person, or why it couldn't decide. */
function handoffWords(mate: TeammateRow, turn: { state: string; result: string | null; decisionJson: string | null }): { label: string; said: string } {
  const read = parseSoul(mate.soul);
  const label = read.ok ? teammateLabel(read.soul) : mate.handle;
  let note = "";
  try { const decided = JSON.parse(turn.decisionJson ?? "{}") as { note?: unknown }; note = typeof decided.note === "string" ? decided.note : ""; } catch { note = ""; }
  return { label, said: turn.state === "failed" ? `${label} couldn't decide this one (${turn.result ?? "it didn't finish"}), so it's yours.` : `${label}: ${note || "Over to you on this one."}` };
}

/** Advance every active card in one project's flows. */
export function advanceFlows(store: Store, repo: string, now: Date, options: { evidenceRoot?: string } = {}): FlowAdvance {
  const outcome: FlowAdvance = { moved: 0, filed: [], problems: [] };
  const flows = new Map<number, { flow: FlowRow; definition: FlowDefinition | null }>();
  for (const card of store.activeFlowCards(repo)) {
    let entry = flows.get(card.flow);
    if (entry === undefined) {
      const flow = store.getFlow(card.flow);
      if (flow === null) continue;
      entry = { flow, definition: flowDefinitionOf(flow) };
      flows.set(card.flow, entry);
    }
    try {
      advanceCard(store, entry.flow, entry.definition, card, now, options, outcome);
    } catch (error) {
      outcome.problems.push(`flow card ${card.id}: ${error instanceof Error ? error.message : "could not advance"}`);
    }
  }
  return outcome;
}

function advanceCard(store: Store, flow: FlowRow, definition: FlowDefinition | null, card: FlowCardRow, now: Date, options: { evidenceRoot?: string }, outcome: FlowAdvance): void {
  if (definition === null) { store.updateFlowCard(card.id, { waiting: "This flow's drawing can't be read. Open the flow and save it again." }, now); return; }
  const stage = definition.stages.find(one => one.id === card.stage);
  if (stage === undefined) {
    // The zone was removed while the card sat in it: back to the start.
    if (store.moveFlowCard(card.id, { to: definition.start, outcome: "moved", actor: "flow", note: null, expectEntry: card.entry }, now)) outcome.moved++;
    return;
  }
  const onward = (result: "ok" | "fail", note?: string | null, task?: string | null): void => {
    const to = result === "ok" ? stage.next : stage.onFail;
    if (to === null) {
      if (result === "ok" && stage.next === null) store.updateFlowCard(card.id, { waiting: "Finished here. Move the card on when you're ready." }, now);
      return;
    }
    if (store.moveFlowCard(card.id, { to, outcome: result, actor: "flow", ...(note === undefined ? {} : { note }), ...(task === undefined ? {} : { task }), expectEntry: card.entry }, now)) {
      outcome.moved++;
      if (result === "fail" && card.owner !== null) notifyPeople(store, card, [card.owner], null, { key: `failed:${card.entry}`, subject: `“${card.title}” went back to ${titleIn(definition, to)}`, body: `${note ?? "Its step didn't finish."} It's in ${titleIn(definition, to)} now.`, attention: true }, now);
    }
  };
  // A time limit (v91): once a card has sat here that long, the person it waits on hears about it, once,
  // and a Holding or "Person decides" zone can move it on.
  if (stage.limit !== undefined && stage.kind !== "wait" && stage.kind !== "done") {
    const entered = Date.parse(store.flowCardEnteredAt(card.id) ?? card.updatedAt);
    if (now.getTime() >= entered + stage.limit.minutes * 60_000) {
      const decider = stage.kind === "approval" ? deciderOf(stage, flow) : stage.kind === "choose" ? flowPersonOf(card, flow) : null;
      const to = stage.limit.to;
      notifyPeople(store, card, [decider ?? card.owner ?? flow.owner], null, { key: `limit:${card.entry}`, attention: true,
        subject: `“${card.title}” has waited ${durationWords(stage.limit.minutes)} in ${stage.title}`,
        body: to === null ? `It's still in ${stage.title}.` : `It's moving to ${titleIn(definition, to)}.` }, now);
      if (to !== null && store.moveFlowCard(card.id, { to, outcome: "moved", actor: "flow", historyNote: `Waited more than ${durationWords(stage.limit.minutes)} in ${stage.title}`, expectEntry: card.entry }, now)) {
        outcome.moved++;
        return;
      }
    }
  }
  switch (stage.kind) {
    case "inbox":
      if (card.waiting !== null) store.updateFlowCard(card.id, { waiting: null }, now);
      return;
    case "wait": {
      const wait = stage.wait ?? { for: "reply" as const, minutes: 24 * 60 };
      // Set hours (like 22:00–06:00): a card goes on once the clock is inside them, at once when it already is.
      if (wait.for === "hours") {
        if (withinHours(wait, now)) { onward("ok"); return; }
        const waiting = `Waiting until ${wait.from}.`;
        if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now);
        return;
      }
      const entered = Date.parse(store.flowCardEnteredAt(card.id) ?? card.updatedAt);
      const words = durationWords(wait.minutes);
      if (now.getTime() < entered + wait.minutes * 60_000) {
        // Replies are taken as they're read (flow-replies.ts), which moves the card on; until then it says what it waits for.
        const watch = wait.for === "reply" ? store.flowMailWatch() : null;
        const trouble = watch !== null && watch.failures > 0 && watch.lastOutcome !== null ? ` ${watch.lastOutcome}` : "";
        // How long is on the card itself (when it moves on, in the viewer's own time); this says what for.
        const waiting = wait.for === "time" ? "Waiting before moving on." : `Waiting for a reply.${trouble}`;
        if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now);
        return;
      }
      if (wait.for === "time") { onward("ok"); return; }
      if (stage.onFail !== null) {
        if (store.moveFlowCard(card.id, { to: stage.onFail, outcome: "moved", actor: "flow", historyNote: `No reply after ${words}`, expectEntry: card.entry }, now)) outcome.moved++;
        return;
      }
      const waiting = `No reply after ${words}. Move the card on when you're ready.`;
      if (card.waiting !== waiting) {
        store.updateFlowCard(card.id, { waiting }, now);
        notifyPeople(store, card, [card.owner ?? flow.owner], null, { key: `no-reply:${card.entry}`, subject: `No reply to “${card.title}” after ${words}`, body: `It's waiting in ${stage.title}.`, attention: true }, now);
      }
      return;
    }
    case "done":
      store.updateFlowCard(card.id, { state: "done", waiting: null }, now);
      notifyPeople(store, card, cardFollowers(store, card), null, { key: `done:${card.entry}`, subject: `Done: “${card.title}”`, body: `“${card.title}” reached ${stage.title} in ${flow.name}.` }, now);
      return;
    case "notify": {
      const message = fill(stage.message ?? card.title, card);
      store.enqueueNotification({
        dedupeKey: `flow:${card.id}:${card.entry}`, kind: "flow-message",
        subject: `${flow.name}: ${message}`.slice(0, 200), body: `${message}\n\nCard: ${card.title}`.slice(0, 2000),
        link: flowCardHref(flow.id, card.id), source: { project: flow.repo },
      }, now);
      onward("ok");
      return;
    }
    case "approval": {
      const decider = deciderOf(stage, flow);
      const who = decider ?? "an approver";
      // v92: a zone an active teammate staffs is its to decide first (the step pass runs it). A person hears
      // about the card only when the teammate hands it over, can't decide, or is paused or gone.
      // v102: on a protected project an AI teammate never decides; the person does.
      const mate = stage.teammate === undefined || store.approvalRules(flow.repo).protectProject ? null : store.teammateByHandle(flow.repo, stage.teammate);
      const turn = mate === null ? null : store.flowStepRun(card.id, card.entry);
      const handed = turn !== null && turn.kind === "teammate" && (turn.state === "failed" || turn.state === "passed");
      if (mate !== null && mate.state === "active" && !handed) {
        const name = teammateName(mate);
        if (card.waiting !== `${name} is deciding`) store.updateFlowCard(card.id, { waiting: `${name} is deciding` }, now);
        return;
      }
      const handoff = handed && mate !== null ? handoffWords(mate, turn!) : null;
      if (card.waiting === null || (mate !== null && card.waiting === `${teammateName(mate)} is deciding`)) {
        // A named decider hears it alone; "anyone who approves" pages everyone who can.
        // With a draft in front of it, the decision carries the draft itself: it can be read (and answered) where it arrives.
        const draft = draftFor(definition, stage);
        const text = draft === null ? undefined : card.outputs[draft.id];
        store.enqueueNotification({
          dedupeKey: `flow-decide:${card.id}:${card.entry}`, kind: "flow-decision", pushClass: "attention", ...(decider === null ? {} : { recipient: decider }),
          subject: (handoff !== null ? `${handoff.label}: ${card.title} needs ${decider === null ? "a decision" : `${decider}'s decision`}` : `${flow.name}: ${card.title} needs ${decider === null ? "a decision" : `${decider}'s decision`}`).slice(0, 200),
          body: `${handoff === null ? "" : `${handoff.said}\n\n`}${text === undefined ? `${stage.title}: approve it, or send it back with a note.`
            : `${stage.title}: approve this draft to send it as written, edit it, or send it back with a note.\n\n${text}`}`,
          link: flowCardHref(flow.id, card.id), source: { project: flow.repo },
        }, now);
        store.updateFlowCard(card.id, { waiting: `Waiting for ${who} to approve or send it back` }, now);
      }
      return;
    }
    case "send":
      // What the step before produced, to the card's person in each chat app they paired and on the card; then on.
      sendStep(store, flow, definition, stage, card, now, options.evidenceRoot);
      onward("ok");
      return;
    case "choose":
      // The same, with the zone's options as buttons: the card waits for the person's choice (chooseFlowCard).
      chooseStep(store, flow, definition, stage, card, now, options.evidenceRoot);
      return;
    case "task":
    case "report":
      workStage(store, flow, definition, stage, card, now, options, outcome, onward);
      return;
    case "check":
    case "pull-request":
    case "update":
    case "sort":
    case "draft":
    case "request":
    case "email":
    case "tool":
      // Run by the worker's step pass (flow-steps.ts), which moves the card on.
      return;
  }
}

function workStage(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, now: Date, options: { evidenceRoot?: string }, outcome: FlowAdvance, onward: (result: "ok" | "fail", note?: string | null, task?: string | null) => void): void {
  // A build may work in another project (its zone's repo), one the flow's owner may file in; research stays in the flow's.
  const repo = stage.kind === "task" && stage.repo !== undefined ? stage.repo : flow.repo;
  if (card.task === null) {
    const report = stage.kind === "report";
    // Waiting cards try again every pass, so a cause that's fixed (a shorter zone, a freed backlog) files the work then.
    const wait = (why: string) => { const waiting = `Couldn't file the work: ${why} It tries again on the next pass.`; if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now); };
    // The goal fits a task: the zone's words whole and the card's details whole; a value too long for the goal (a
    // script's output) is attached instead, and the agent is given it in full (flowGoalCuts). Nothing is cut.
    const goal = flowGoal(stage.instructions ?? card.title, card, id => titleIn(definition, id));
    if (goal === null) { wait(`${stage.title}'s instructions are too long for a task. Open the flow and shorten them.`); return; }
    if (repo !== flow.repo && !store.accountCanAccess(flow.owner, repo)) { wait(`${flow.owner}, who owns this flow, can't file work in ${repo}. Choose another project for ${stage.title}, or give them access.`); return; }
    // Filed exactly once however many passes advance this project: the card is claimed (still this entry, in this zone,
    // with no task) in the same transaction that files its task, so another pass finds it claimed and leaves it.
    const filed = store.transact(() => {
      const fresh = store.getFlowCard(card.id);
      if (fresh === null || fresh.state !== "active" || fresh.entry !== card.entry || fresh.stage !== stage.id || fresh.task !== null) return null;
      const made = fileTaskProposal(store, {
        title: (report ? `${stage.title}: ${card.title}` : card.title).slice(0, 200),
        repo,
        goal,
        filedVia: `flow:${flow.id}`, filedBy: filerFor(card.createdBy), // who made the card asked for the work (an owner can be reassigned by anyone)
        deliverable: report ? "report" : "branch",
        planning: report ? "skip" : stage.planning ?? "auto",
        acceptance: report ? ACCEPTANCE.report : ACCEPTANCE.task,
        admittedRepos: [repo],
      }, now);
      if (made.ok) store.updateFlowCard(card.id, { task: made.id, ...(report || fresh.primaryTask !== null ? {} : { primaryTask: made.id }), waiting: "Filed as a task" }, now);
      return made;
    });
    if (filed === null) return;
    if (!filed.ok) { wait(/[.!?]$/.test(filed.message) ? filed.message : `${filed.message}.`); return; }
    outcome.filed.push(filed.id);
    return;
  }
  // A send back may have made a revision: follow the task's current version.
  const family = store.taskFamilyOf(card.task, [repo], false);
  const current = family?.current.id ?? card.task;
  const task = store.getTask(current);
  if (task === null) { store.updateFlowCard(card.id, { waiting: "Its task is gone. Move the card to try again." }, now); return; }
  if (task.state === "done") {
    // A build whose project checks failed is done but not good: it takes the failure path, like a failed build.
    if (stage.kind === "task") {
      const checks = assignmentOf(store, current, now, { principal: "operator", repos: [repo] }, options.evidenceRoot)?.receipt?.checks ?? null;
      if (checks?.status === "failed") {
        const said = `The checks failed on its result: ${checks.detail}`;
        store.updateFlowCard(card.id, { outputs: { ...card.outputs, [stage.id]: `${said} (task ${current})` }, primaryTask: current }, now);
        if (stage.onFail !== null) onward("fail", said);
        else if (card.waiting !== `${said} Look at the result, then move the card on or back.`) store.updateFlowCard(card.id, { waiting: `${said} Look at the result, then move the card on or back.` }, now);
        return;
      }
    }
    const outputs = { ...card.outputs };
    if (stage.kind === "report") {
      const ref = store.lookupRef(current);
      const summary = ref === null ? null : reportSummaryFor(store, options.evidenceRoot, ref.id);
      // The summary whole (a report's summary is within TEXT_LIMITS.reportSummary bytes; an older, longer one is linked).
      outputs[stage.id] = summary !== null && "summary" in summary ? passOn(summary.summary, TEXT_LIMITS.stageOutput, { label: `task ${current}`, href: null }).text : "The report is ready on its task.";
      // {{stage.<id>.items}} and {{stage.<id>.report}}: what it found and the whole report, for the zones after it.
      // A visit's report replaces the last visit's, so nothing stale is left behind.
      const view = ref === null || options.evidenceRoot === undefined ? null : readVerifiedReport(store, options.evidenceRoot, ref.id);
      const found = view?.ok === true ? reportFillIns(view.report) : { items: "", report: "" };
      for (const [part, text] of Object.entries(found)) {
        if (text === "") delete outputs[`${stage.id}.${part}`];
        else outputs[`${stage.id}.${part}`] = text;
      }
    } else {
      outputs[stage.id] = `Result ready on task ${current}.`;
    }
    store.updateFlowCard(card.id, { outputs, ...(stage.kind === "task" ? { primaryTask: current } : {}), waiting: null }, now);
    // A "Send to me" or "Person chooses" zone next reads what this task produced: the task goes with the card there.
    const following = stage.next === null ? undefined : flowDefinitionStage(definition, stage.next);
    onward("ok", undefined, following?.kind === "send" || following?.kind === "choose" ? current : undefined);
    return;
  }
  if (task.state === "failed" || task.state === "cancelled") {
    if (stage.onFail !== null) onward("fail", `The ${stage.kind === "report" ? "research" : "build"} ${task.state === "failed" ? "failed" : "was cancelled"}.`);
    else {
      const waiting = `The task ${task.state === "failed" ? "failed" : "was cancelled"}. Retry it, or move the card.`;
      if (card.waiting !== waiting && card.owner !== null) notifyPeople(store, card, [card.owner], null, { key: `stuck:${card.entry}`, subject: `“${card.title}” is stuck in ${stage.title}`, body: waiting, attention: true }, now);
      store.updateFlowCard(card.id, { waiting }, now);
    }
    return;
  }
  const diagnosis = diagnoseTaskDispatch(store, current, now);
  const waiting = diagnosis?.summary ?? "Working on it";
  if (waiting !== card.waiting) store.updateFlowCard(card.id, { waiting }, now);
}

/** What a flow task's goal had to cut, whole, for the agent doing it: each value its zone fills in from the card that the
 * goal doesn't hold in full. Empty when the task didn't come from a flow card or nothing was cut. Script output and
 * card text can come from outside, so the brief quotes these as untrusted data. */
/** The most of one attached value the agent's brief carries: more than any card value holds (a whole report is at most
 * 64 KiB), so in practice an attachment is never shortened. */
const FLOW_ATTACHED_LIMIT = 128_000;

export function flowGoalCuts(store: Store, taskId: string, goal: string): { label: string; text: string }[] {
  try { return goalCuts(store, taskId, goal); } catch { return []; } // context, never a reason a build can't start
}

function goalCuts(store: Store, taskId: string, goal: string): { label: string; text: string }[] {
  const root = store.taskFamilyOf(taskId, null, true)?.root.id ?? taskId;
  const card = store.flowCardByTask(root);
  const flow = card === null ? null : store.getFlow(card.flow);
  const definition = flow === null ? null : flowDefinitionOf(flow);
  const stage = definition?.stages.find(one => one.id === card!.stage);
  if (card === null || definition == null || stage === undefined || (stage.kind !== "task" && stage.kind !== "report")) return [];
  const cuts: { label: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const match of flowWorkTemplate(stage.instructions ?? card.title, card).matchAll(/\{\{\s*(card\.title|card\.description|note|stage\.([a-z0-9-]+)(?:\.(items|report))?)\s*\}\}/g)) {
    if (seen.has(match[1]!)) continue;
    seen.add(match[1]!);
    const text = fillFlowText(`{{${match[1]}}}`, card);
    if (text === "" || goal.includes(text)) continue;
    cuts.push({ label: flowValueLabel(match[1]!, id => titleIn(definition, id)), text: text.slice(0, FLOW_ATTACHED_LIMIT) });
  }
  return cuts;
}

/** Why a flow can't be saved as drawn: a build zone in a project its owner, or whoever saves it, may not file work in; null when none. */
export function crossProjectProblem(store: Store, definition: FlowDefinition, flow: { repo: string; owner: string }, editor: string = flow.owner): string | null {
  const elsewhere = definition.stages.filter((one): one is FlowStage & { repo: string } => one.kind === "task" && one.repo !== undefined && one.repo !== flow.repo);
  const owners = elsewhere.find(one => !store.accountCanAccess(flow.owner, one.repo));
  if (owners !== undefined) return `Zone ${owners.title}: ${flow.owner}, who owns this flow, can't file work in that project.`;
  const editors = elsewhere.find(one => !store.accountCanAccess(editor, one.repo));
  return editors === undefined ? null : `Zone ${editors.title}: you can't file work in that project, so you can't point a build there.`;
}

export type FlowAct = { ok: true; said: string; card: number } | { ok: false; message: string };

const zoneWords = (title: string) => `${title}${/[.?!]$/.test(title) ? "" : "."}`;

/** A card's words, checked once for every door: a title, an optional description, and no keys, because cards become agent instructions. */
export function flowCardText(title: unknown, description: unknown): { title: string; description: string | null } | { problem: string } {
  const cleanTitle = (typeof title === "string" ? title : "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  const cleanDescription = (typeof description === "string" ? description : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 4000) || null;
  if (cleanTitle === "") return { problem: "Give the card a title." };
  if (scanForSecrets(`${cleanTitle}\n${cleanDescription ?? ""}`).length > 0) return { problem: "That looks like a key or password. Cards become agent instructions; keep secrets out of them." };
  return { title: cleanTitle, description: cleanDescription };
}

/** Add a card to a flow, in its start zone unless a zone is named. */
export function addCardToFlow(store: Store, flow: FlowRow, input: { title: unknown; description: unknown; stage: string | null }, actor: string, now: Date): FlowAct {
  const definition = flowDefinitionOf(flow);
  if (definition === null || flow.state !== "active") return { ok: false, message: "This flow can't take cards right now." };
  const text = flowCardText(input.title, input.description);
  if ("problem" in text) return { ok: false, message: text.problem };
  const stage = definition.stages.find(one => one.id === input.stage) ?? definition.stages.find(one => one.id === definition.start)!;
  const card = store.addFlowCard({ flow: flow.id, title: text.title, description: text.description, stage: stage.id, by: actor }, now);
  // Whoever adds a card follows it; owning it is a separate, deliberate step.
  store.setFlowCardWatcher(card, actor, true, now);
  return { ok: true, said: `Card added to ${zoneWords(stage.title)}`, card };
}

/** Move a card to another zone of its flow by hand; the zone's step runs on the next pass. */
export function moveCardInFlow(store: Store, card: FlowCardRow, to: string, actor: string, now: Date): FlowAct {
  const flow = store.getFlow(card.flow);
  const definition = flow === null ? null : flowDefinitionOf(flow);
  const stage = definition?.stages.find(one => one.id === to);
  if (stage === undefined) return { ok: false, message: "Choose a zone in this flow." };
  if (card.state !== "active") return { ok: false, message: "That card is finished." };
  if (to === card.stage) return { ok: true, said: "Already there.", card: card.id };
  if (!store.moveFlowCard(card.id, { to, outcome: "moved", actor, expectEntry: card.entry }, now)) return { ok: false, message: "That card just moved. Look again." };
  if (card.owner !== null) notifyPeople(store, card, [card.owner], actor, { key: `moved:${card.entry}`, subject: `${actor} moved “${card.title}” to ${stage.title}`, body: `It was in ${definition!.stages.find(one => one.id === card.stage)?.title ?? "another zone"}.` }, now);
  return { ok: true, said: `Moved to ${zoneWords(stage.title)}`, card: card.id };
}

/** Take a card out of its flow; the tasks it filed are left as they are. */
export function cancelFlowCard(store: Store, card: FlowCardRow, actor: string, now: Date): FlowAct {
  if (card.state !== "active") return { ok: false, message: "That card is already finished." };
  store.moveFlowCard(card.id, { to: card.stage, outcome: "cancelled", actor }, now);
  store.updateFlowCard(card.id, { state: "cancelled", waiting: null }, now);
  return { ok: true, said: "Card cancelled. Its tasks are unchanged.", card: card.id };
}

export type FlowDecision = { ok: true; said: string } | { ok: false; message: string };

/** A person's decision on a card waiting in an approval zone. A send back to a build zone whose work has a result becomes a revision of that work. */
/** The draft a decision is about: the draft zone that sends its cards to this one. */
export function draftFor(definition: FlowDefinition, stage: FlowStage): FlowStage | null {
  return definition.stages.find(one => one.kind === "draft" && one.next === stage.id)
    // A teammate's zone that leads here (by its next, or one of its answers) wrote the draft this decision checks (starter kits).
    ?? definition.stages.find(one => one.kind === "teammate" && (one.next === stage.id || (one.routes ?? []).some(route => route.to === stage.id))) ?? null;
}

/** Back to a build zone with a finished result: a revision of that same work, carrying the note; null when it isn't one. */
export function revisionWithNote(store: Store, card: FlowCardRow, target: FlowStage | undefined, note: string, actor: string, repos: readonly string[], evidenceRoot: string | undefined, now: Date): string | null {
  if (target?.kind !== "task" || card.primaryTask === null || evidenceRoot === undefined) return null;
  // The build's own project (a zone may build in another) must be one the person can reach.
  const repo = store.lookupRef(card.primaryTask)?.repo ?? null;
  if (repo !== null && !repos.includes(repo)) return null;
  const snapshot = assignmentOf(store, card.primaryTask, now, { principal: "operator", repos });
  const runId = snapshot?.receipt?.runId;
  const runTask = runId === undefined ? null : store.externalIdFor(store.getRun(runId)?.taskRef ?? -1);
  if (runId === undefined || runTask === null) return null;
  const revised = requestResultChanges(store, evidenceRoot, {
    run: runId, source: revisionSourceOf(store.getScope(runTask)?.digest ?? null), actor, repos,
    batch: "", note, path: "", line: "", request: `flow-${card.id}-${card.entry}`, allowMode: true,
  }, now);
  return revised.ok ? revised.id : null;
}

export function decideFlowCard(store: Store, input: { card: number; decision: "approve" | "send-back"; note: string | null; actor: string; repos: readonly string[]; evidenceRoot?: string;
  /** The draft as the person left it: approving sends this version on. */
  draft?: string | null;
  /** The visit the person saw (a chat button's): a card that moved on since is refused. */
  entry?: number;
  /** v92: the AI teammate (by handle) deciding a zone it staffs; `actor` is then how it reads in history. */
  teammate?: string }, now: Date): FlowDecision {
  const card = store.getFlowCard(input.card);
  const flow = card === null ? null : store.getFlow(card.flow);
  const definition = flow === null ? null : flowDefinitionOf(flow);
  if (card === null || flow === null || definition === null || card.state !== "active" || !input.repos.includes(flow.repo)) return { ok: false, message: "That card is no longer waiting." };
  const stage = definition.stages.find(one => one.id === card.stage);
  if (stage === undefined || stage.kind !== "approval" || (input.entry !== undefined && input.entry !== card.entry)) return { ok: false, message: "That card has moved on since; nothing was changed." };
  // A teammate decides only a zone it staffs; its person (and only them) can always decide instead.
  const decider = deciderOf(stage, flow);
  if (input.teammate !== undefined ? stage.teammate !== input.teammate : decider !== null && decider !== input.actor) return { ok: false, message: `Only ${decider ?? "an approver"} decides here.` };
  // v102: a protected project's decisions are a person's, never an AI teammate's.
  if (input.teammate !== undefined && store.approvalRules(flow.repo).protectProject) return { ok: false, message: "This project is protected: a person decides here." };
  if (input.decision === "approve") {
    // An edited draft replaces the one Claude wrote, so the steps after this send what the person approved.
    const draft = draftFor(definition, stage);
    // A person's edit over the draft limit is refused with it, never cut. (A teammate's was asked once to shorten and is kept whole.)
    if (draft !== null && input.teammate === undefined && typeof input.draft === "string" && input.draft.trim().length > DRAFT_CHARS) {
      return { ok: false, message: `Keep the draft to ${DRAFT_CHARS.toLocaleString("en-US")} characters; this is ${input.draft.trim().length.toLocaleString("en-US")}.` };
    }
    if (draft !== null && typeof input.draft === "string" && input.draft.trim() !== "" && input.draft.trim() !== card.outputs[draft.id]?.trim()) {
      store.updateFlowCard(card.id, { outputs: { ...card.outputs, [draft.id]: keptDraft(input.draft) } }, now);
      store.addFlowComment({ card: card.id, author: input.actor, body: "Edited the draft before approving it.", mentions: [] }, now);
    }
    if (stage.next === null) {
      store.updateFlowCard(card.id, { state: "done", waiting: null }, now);
      return { ok: true, said: "Approved. The card is done." };
    }
    store.moveFlowCard(card.id, { to: stage.next, outcome: "approved", actor: input.actor, note: input.note, expectEntry: card.entry }, now);
    const title = definition.stages.find(one => one.id === stage.next)?.title ?? stage.next;
    if (card.owner !== null) notifyPeople(store, card, [card.owner], input.actor, { key: `approved:${card.entry}`, subject: `${input.actor} approved “${card.title}”`, body: `${stage.title}: approved. It moves to ${title}.${input.note === null || input.note.trim() === "" ? "" : `\n\n${input.note.trim()}`}` }, now);
    return { ok: true, said: `Approved. Moved to ${title}${/[.?!]$/.test(title) ? "" : "."}` };
  }
  if (stage.onFail === null) return { ok: false, message: "This zone has nowhere to send work back to." };
  if (input.note === null || input.note.trim() === "") return { ok: false, message: "Say what should change." };
  const target = definition.stages.find(one => one.id === stage.onFail);
  const revision = revisionWithNote(store, card, target, input.note.trim(), input.actor, input.repos, input.evidenceRoot, now);
  store.moveFlowCard(card.id, { to: stage.onFail, outcome: "sent-back", actor: input.actor, note: input.note.trim(), ...(revision === null ? {} : { task: revision }), expectEntry: card.entry }, now);
  if (card.owner !== null) notifyPeople(store, card, [card.owner], input.actor, { key: `sent-back:${card.entry}`, subject: `${input.actor} sent “${card.title}” back`, body: `Sent back to ${target?.title ?? stage.onFail}:\n\n${input.note.trim()}`, attention: true }, now);
  return { ok: true, said: revision === null ? `Sent back to ${target?.title ?? stage.onFail} with your note.` : `Sent back to ${target?.title ?? stage.onFail}: a revision was made with your note.` };
}
