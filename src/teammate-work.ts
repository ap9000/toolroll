/**
 * A teammate's turn on a card (v92), run by the flow step pass.
 *
 * The turn reads the zone, the card (as data) and what its people told it,
 * and answers with one decision (teammates.ts). This carries the decision
 * out within the zone's own choices, and writes it down — what it did and
 * why — in the card's history and the teammate's log:
 *
 * - "Person decides" zone: approve (the draft as written, or as it rewrote
 *   it), send back with a note, or hand it to the zone's person, whose
 *   decision then arrives in their chat app as always.
 * - "Teammate handles it" zone: pick one of the zone's answers (its text is
 *   kept for the next zones), ask its person a question and wait for the
 *   answer, or say it can't and take the failure path.
 *
 * Either way (v94), before it decides it may use the project tools its
 * manager let it use: each call is checked against its rule for that action
 * (teammate-tools.ts), made at once or put to its person first, and kept as
 * a receipt; the turn goes on with what the tool answered.
 */
import type { FlowCardRow, FlowRow, Store, TeammateRow } from "./store.js";
import type { FlowDefinition, FlowStage } from "./flows.js";
import { decideFlowCard, draftFor, flowCardHref } from "./flow-engine.js";
import { wholeDraft } from "./flow-draft.js";
import { notifyPeople } from "./flow-people.js";
import { claudeTurnRunner, parseSoul, readTurn, teammateActor, teammateLabel, TURN_TIMEOUT_MS, turnOverruns, turnPrompt, type TurnAnswer, type TurnContext, type TurnRunner } from "./teammates.js";
import { passOn, shortenAsk, TEXT_LIMITS } from "./text-limits.js";
import { LIMITS } from "./decision.js";
import { callName, callOutcome, callWords, inputProblem, makeCall, offeredTools, refreshGrants, ruleFor, type OfferedTool, type ToolIo } from "./teammate-tools.js";
import { answerSuggestion, considerSuggestion, memoriesFor, remember } from "./teammate-memory.js";
import { replyToAsker } from "./teammate-desk.js";
import { claudeMachineBilling } from "./spend.js";

/** A question waits for its answer this long before the step is due again on its own: never, in practice. */
export const ASKED = "9999-12-31T00:00:00.000Z";
/** What "handle" zones with no answers of their own offer: going on to the next zone. */
const CARRY_ON = "Carry on";
/** v94: tool calls one visit of a card may make, and turns one step run may take, before it must decide with what it has. */
export const CALLS_PER_VISIT = 12;
const TURNS_PER_RUN = 8;
/** The two answers an ask-first call offers; words instead tell the teammate what to do. */
export const APPROVE = "approve", DENY = "deny";

export type TeammateOutcome = { state: "passed" | "failed" | "retry" | "waiting"; said: string; log?: string; decisionJson?: string; nextAt?: string };

const startOfDay = (now: Date) => { const day = new Date(now); day.setHours(0, 0, 0, 0); return day.toISOString(); };

/** The Claude model a teammate's turns run on: its own, or the lead chat's Claude model, or Claude's default. */
export function teammateModel(store: Store, mate: TeammateRow): string {
  const config = store.getChatConfig();
  return mate.model ?? (config?.provider === "claude-subscription" ? config.model : "default");
}

/** Whether a teammate can take a turn now: active, readable, and under its daily limit. */
export function teammateReady(store: Store, mate: TeammateRow | null, now: Date): { ok: true } | { ok: false; why: string } {
  if (mate === null) return { ok: false, why: "gone" };
  if (mate.state !== "active") return { ok: false, why: "paused" };
  if (!parseSoul(mate.soul).ok) return { ok: false, why: "its soul file can't be read" };
  if (store.teammateTurnsSince(mate.id, startOfDay(now)) >= mate.dailyTurns) return { ok: false, why: `it reached today's limit of ${mate.dailyTurns} turns` };
  // v105: its turns bill as this computer's Claude does with no key from us; billed to a key, a budget holds them.
  const held = store.budgetGate(now)({ project: mate.repo, person: null, teammate: mate.id, agents: [{ provider: "claude", billing: claudeMachineBilling(store.handle) }] });
  if (held.over !== null) return { ok: false, why: held.why === "used-up" ? "a monthly budget its work counts toward is used up" : "a monthly budget can't price its work yet" };
  // Sprint 8: its turns run on Claude, with its own model or the lead chat's: the organisation policy has to allow them.
  const disallowed = store.agentPolicyRefusal("claude", teammateModel(store, mate));
  if (disallowed !== null) return { ok: false, why: disallowed };
  return { ok: true };
}

/** The answers a "Teammate handles it" zone offers, each with the zone it leads to. */
export function handleAnswers(stage: FlowStage): { answer: string; to: string | null }[] {
  return stage.routes !== undefined && stage.routes.length > 0 ? stage.routes : [{ answer: CARRY_ON, to: stage.next }];
}

/** Everything the turn is told. */
function contextOf(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, mate: TeammateRow, tools: OfferedTool[] = [], spent = false): TurnContext {
  const soul = parseSoul(mate.soul);
  if (!soul.ok) throw new Error(soul.problem);
  const title = (id: string) => definition.stages.find(one => one.id === id)?.title ?? id;
  const draft = stage.kind === "approval" ? draftFor(definition, stage) : null;
  const question = store.teammateQuestionFor(card.id, card.entry);
  // v95: what its people told it lately, and what it kept that fits this card.
  const memory = memoriesFor(store, mate, `${card.title}\n${card.description ?? ""}`, new Date());
  return {
    soul: mate.soul, name: soul.soul.name, role: soul.soul.role, flow: flow.name, zone: stage.title, kind: stage.kind === "approval" ? "decide" : "handle",
    instructions: stage.instructions, draft: draft === null ? null : card.outputs[draft.id] ?? null, canSendBack: stage.onFail !== null,
    person: stage.kind === "approval" ? (stage.toOwner === true ? flow.owner : stage.approver ?? flow.owner) : flow.owner,
    answers: handleAnswers(stage).map(one => one.answer),
    card: {
      title: card.title, description: card.description, source: card.source?.label ?? null,
      earlier: definition.stages.filter(one => one.id !== stage.id && card.outputs[one.id] !== undefined).map(one => ({ zone: one.title, text: card.outputs[one.id]! })),
      discussion: store.flowComments(card.id).filter(one => one.kind === "comment").slice(-10).map(one => ({ by: one.author.includes("@") ? `${one.author} (by email)` : one.author, text: one.body })),
      history: store.flowEvents(card.id).slice(-8).map(one => `${one.outcome} → ${title(one.toStage)}${one.note === null ? "" : `: ${one.note}`}`),
    },
    asked: question !== null && question.state === "answered" ? [{ question: question.question, answer: [question.choice === null ? null : question.options.find(one => one.id === question.choice)?.label ?? question.choice, question.answer].filter(Boolean).join(" — ") }] : [],
    notes: memory.told.map(one => ({ by: one.createdBy, text: one.text })),
    memory: memory.kept.map(one => one.text),
    tools, toolsSpent: spent,
    calls: store.teammateCallsOn(card.id, card.entry).map(call => {
      const question = call.state === "denied" ? store.teammateQuestionForCall(call.id) : null;
      return { name: callName(call.tool, call.action), input: JSON.stringify(call.input), outcome: callOutcome(call),
        said: call.state === "denied" ? question?.answer ?? null : call.state === "asked" ? null : call.result };
    }),
  };
}

/**
 * Run one teammate turn on a card and carry out what it decided. With tools
 * (v94) a turn is a short loop: each tool call it asks for is made (or put to
 * its person, and the turn waits), and it decides again with the answer —
 * until it decides, or it has used its tools as much as a visit allows.
 */
export async function teammateTurn(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, mate: TeammateRow, now: Date,
  io: { turn?: TurnRunner; evidenceRoot?: string } & ToolIo): Promise<TeammateOutcome> {
  const model = teammateModel(store, mate);
  if (store.teammateGrants(mate.id).length > 0) {
    try { await refreshGrants(store, mate, now, io); } catch { /* the last listing stands */ }
    // Calls a person approved since the last turn are made first, exactly as they approved them.
    for (const call of store.teammateCallsOn(card.id, card.entry).filter(one => one.state === "approved" && one.undoOf === null)) await makeCall(store, call, flow.repo, io, now);
  }
  const log: string[] = [];
  /** The one shorten turn this run allows: an answer over a limit is asked once, then kept whole. */
  let shorten: { answer: string; ask: string } | undefined;
  let shortened = false;
  for (let turn = 1; ; turn++) {
    const made = store.teammateCallsOn(card.id, card.entry).length;
    const spent = made >= CALLS_PER_VISIT || turn > TURNS_PER_RUN;
    const tools = spent ? [] : offeredTools(store, mate);
    const context = { ...contextOf(store, flow, definition, stage, card, mate, tools, spent && made > 0), ...(shorten === undefined ? {} : { shorten }) };
    const asked = Date.now();
    const reply = await (io.turn ?? claudeTurnRunner())({ model, prompt: turnPrompt(context), timeoutMs: TURN_TIMEOUT_MS });
    // v97: every turn is kept with what it cost, for its weekly report.
    store.addTeammateTurn({ teammate: mate.id, card: card.id, model, ok: reply.ok, ms: reply.ok ? reply.ms : Date.now() - asked, costUsd: reply.costUsd ?? null, tokensIn: reply.tokensIn ?? null, tokensOut: reply.tokensOut ?? null }, now);
    if (!reply.ok) return { state: "retry", said: reply.said, ...(log.length === 0 ? {} : { log: log.join("\n\n") }) };
    const answer = readTurn(reply.value, context);
    if (answer === null) return { state: "retry", said: `${context.name}'s answer wasn't one this zone allows.`, log: [...log, JSON.stringify(reply.value).slice(0, 4000)].join("\n\n") };
    const header = `${context.name} (${model}) · ${(reply.ms / 1000).toFixed(1)} s`;
    const over = turnOverruns(answer);
    if (over.length > 0 && !shortened) {
      shortened = true;
      shorten = { answer: JSON.stringify(answer), ask: shortenAsk(over) };
      log.push(`${header}\n\nOver a limit, asked once to shorten: ${over.map(one => `${one.field} ${one.length} of ${one.limit}`).join(", ")}.\n\n${JSON.stringify(answer)}`);
      turn--;
      continue;
    }
    shorten = undefined;
    if (answer.remember !== "") remember(store, mate, answer.remember, { source: "teammate", card: card.id, by: teammateActor({ name: context.name }) }, now);
    if (answer.action !== "use_tool") {
      const outcome = carryOut(store, flow, definition, stage, card, mate, context, answer, now, io, header);
      return log.length === 0 ? outcome : { ...outcome, log: `${log.join("\n\n")}\n\n${outcome.log ?? ""}`.trim() };
    }
    log.push(`${header}\n\n${JSON.stringify(answer)}`);
    const waiting = await useTool(store, flow, stage, card, mate, context, answer, io, now);
    if (waiting !== null) return { ...waiting, log: log.join("\n\n") };
  }
}

/**
 * One tool call a turn asked for, checked against its rules: made now (the
 * turn goes on: null), refused with the reason (the turn goes on and reads
 * it), or put to its person — the turn waits for the answer.
 */
async function useTool(store: Store, flow: FlowRow, stage: FlowStage, card: FlowCardRow, mate: TeammateRow, context: TurnContext, answer: TurnAnswer, io: ToolIo, now: Date): Promise<TeammateOutcome | null> {
  const split = answer.tool.indexOf(".");
  const tool = split < 0 ? answer.tool : answer.tool.slice(0, split), action = split < 0 ? "" : answer.tool.slice(split + 1);
  const receipt = { teammate: mate.id, card: card.id, entry: card.entry, tool: tool.slice(0, 40), action: action.slice(0, 64) || "(none)", why: answer.reason };
  const refuse = (input: Record<string, unknown>, said: string) => { store.addTeammateCall({ ...receipt, input, rule: "never", state: "refused", result: said }, now); return null; };
  if (!(context.tools ?? []).some(one => one.name === answer.tool)) return refuse({}, `There's no ${answer.tool} among the tools you may use.`);
  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(answer.input === "" ? "{}" : answer.input) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return refuse({}, "Its input wasn't a JSON object.");
    input = parsed as Record<string, unknown>;
  } catch {
    return refuse({}, "Its input wasn't a JSON object.");
  }
  const grant = store.teammateGrant(mate.id, tool)!;
  const info = grant.actions.find(one => one.name === action)!;
  const problem = inputProblem(info, input);
  if (problem !== null) return refuse(input, problem);
  const rule = ruleFor(grant, action, input);
  if (rule.use === "never") return refuse(input, rule.why);
  if (rule.use === "free") {
    const id = store.addTeammateCall({ ...receipt, input, rule: "free", state: "running" }, now);
    await makeCall(store, store.teammateCall(id)!, flow.repo, io, now);
    return null;
  }
  // Ask first: its person approves this exact call, in their chat app or on the card.
  const soul = { name: context.name, role: context.role };
  const id = store.addTeammateCall({ ...receipt, input, rule: "ask", state: "asked", result: rule.why }, now);
  const words = callWords(tool, action, input, 480);
  const question = store.openTeammateQuestion({ teammate: mate.id, card: card.id, entry: card.entry, question: `Use ${words}?`, options: [{ id: APPROVE, label: "Approve" }, { id: DENY, label: "Deny" }], askedOf: context.person, toolCall: id }, now);
  if (question === null) return { state: "failed", said: "It asked to make the same call twice." };
  notifyPeople(store, card, [context.person], null, { key: `teammate-q:${question}`, attention: true, subject: `${teammateLabel(soul)} asks to use ${action} on “${card.title}”`,
    body: `${words}\n\n${answer.reason === "" ? "" : `Why: ${answer.reason}\n`}(${rule.why})\n\nApprove makes exactly this call. Deny stops it. Or answer in words to tell ${context.name} what to do instead.`,
  }, now);
  if (stage.kind !== "approval") store.updateFlowCard(card.id, { waiting: `${context.name} asked ${context.person} to approve: ${words}`.slice(0, 300) }, now);
  return { state: "waiting", said: `Asked ${context.person} to approve ${action}`, nextAt: ASKED };
}

/** Text still over its limit after the one shorten turn: attached whole to the card's discussion, and what is passed on
 * (a note, or what the next zones read) is a link to it. Never cut. */
function keptWhole(store: Store, flow: FlowRow, card: FlowCardRow, author: string, text: string, limit: number, holds: string, what: string, now: Date): string {
  const kept = passOn(text, limit, { label: "the card's discussion", href: flowCardHref(flow.id, card.id) }, holds);
  if (kept.kept) store.addFlowComment({ card: card.id, author, body: `${what}, in full (${text.length.toLocaleString("en-US")} characters):\n\n${text}`, mentions: [] }, now);
  return kept.text;
}

function carryOut(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, mate: TeammateRow, context: TurnContext, answer: TurnAnswer, now: Date,
  io: { evidenceRoot?: string }, header: string): TeammateOutcome {
  const soul = { name: context.name, role: context.role };
  const actor = teammateActor(soul), label = teammateLabel(soul);
  const decisionJson = JSON.stringify(answer);
  const log = `${header}\n\n${decisionJson}`;
  const event = (kind: "decided" | "handled" | "handed" | "asked", said: string) =>
    store.addTeammateEvent({ teammate: mate.id, card: card.id, entry: card.entry, kind, said, detail: { flow: flow.id, zone: stage.id, action: answer.action, reason: answer.reason } }, now);
  const titleOf = (id: string | null) => definition.stages.find(one => one.id === id)?.title ?? "the next zone";
  const repos = [flow.repo];
  const note = (text: string) => keptWhole(store, flow, card, actor, text, LIMITS.note, "a note holds", `${label}'s note`, now);
  if (answer.action === "approve" || answer.action === "send_back") {
    const draft = draftFor(definition, stage);
    const decided = decideFlowCard(store, {
      card: card.id, decision: answer.action === "approve" ? "approve" : "send-back", note: answer.action === "approve" ? answer.reason || null : note(answer.note), actor, repos, teammate: mate.handle, entry: card.entry,
      ...(answer.action === "approve" && draft !== null && answer.text !== "" ? { draft: wholeDraft(answer.text) } : {}),
      ...(io.evidenceRoot === undefined ? {} : { evidenceRoot: io.evidenceRoot }),
    }, now);
    if (!decided.ok) return { state: "failed", said: decided.message, log, decisionJson };
    const said = answer.action === "approve" ? `Approved “${card.title}”${answer.reason === "" ? "" : `: ${answer.reason}`}` : `Sent “${card.title}” back: ${answer.note}`;
    event("decided", said);
    return { state: "passed", said, log, decisionJson };
  }
  if (answer.action === "hand_off") {
    event("handed", `Handed “${card.title}” to ${context.person}${answer.note === "" ? "" : `: ${answer.note}`}`);
    // The engine sees the hand-off (a passed turn in the same visit) and asks the person, with this note.
    return { state: "passed", said: `Handed to ${context.person}`, log, decisionJson };
  }
  if (answer.action === "ask") {
    const options = answer.options.map((label, at) => ({ id: `o${at + 1}`, label }));
    const opened = store.openTeammateQuestion({ teammate: mate.id, card: card.id, entry: card.entry, question: answer.question, options, askedOf: context.person }, now);
    if (opened === null) return { state: "failed", said: "It asked twice about the same visit.", log, decisionJson };
    event("asked", `Asked ${context.person} about “${card.title}”: ${answer.question}`);
    notifyPeople(store, card, [context.person], null, { key: `teammate-q:${opened}`, attention: true, subject: `${label} asks about “${card.title}”`,
      body: `${answer.question}${options.length === 0 ? "" : `\n\n${options.map(one => `• ${one.label}`).join("\n")}`}${answer.reason === "" ? "" : `\n\n(${answer.reason})`}\n\nAnswer with the buttons in your chat app, or on the card.`,
    }, now);
    store.updateFlowCard(card.id, { waiting: `${context.name} asked ${context.person}: ${answer.question}`.slice(0, 300) }, now);
    return { state: "waiting", said: `Asked ${context.person}`, log, decisionJson, nextAt: ASKED };
  }
  if (answer.action === "cant") {
    event("handled", `Couldn't handle “${card.title}”: ${answer.note}`);
    if (stage.onFail !== null) store.moveFlowCard(card.id, { to: stage.onFail, outcome: "fail", actor, note: answer.note === "" ? null : note(answer.note), expectEntry: card.entry }, now);
    else store.updateFlowCard(card.id, { waiting: `${context.name} couldn't handle it: ${answer.note}`.slice(0, 300) }, now);
    return { state: "failed", said: answer.note || "It couldn't handle this card.", log, decisionJson };
  }
  // route: the answer names where the card goes; its text is what the next zones use.
  const picked = handleAnswers(stage).find(one => one.answer.toLowerCase() === answer.answer.toLowerCase())!;
  // What the next zones read: whole up to what a step passes on; longer is attached whole to the card, and they read a link to it.
  if (answer.text !== "") store.updateFlowCard(card.id, { outputs: { ...card.outputs, [stage.id]: keptWhole(store, flow, card, actor, wholeDraft(answer.text), TEXT_LIMITS.stageOutput, "a step passes on", `What ${label} wrote for the next zones`, now) } }, now);
  const said = `Sent “${card.title}” to ${titleOf(picked.to)}${picked.answer === CARRY_ON ? "" : ` (${picked.answer})`}${answer.reason === "" ? "" : `: ${answer.reason}`}`;
  event("handled", said);
  // v96: a zone that answers whoever asked sends what it wrote back to them, under its name.
  if (stage.reply === true && answer.text !== "") replyToAsker(store, flow, card, mate, answer.text, now);
  if (picked.to === null) store.updateFlowCard(card.id, { waiting: "Finished here. Move the card on when you're ready." }, now);
  else store.moveFlowCard(card.id, { to: picked.to, outcome: "ok", actor, historyNote: `${actor}: ${picked.answer === CARRY_ON ? "" : `${picked.answer}. `}${answer.reason}`.trim(), expectEntry: card.entry }, now);
  return { state: "passed", said, log, decisionJson };
}

/** A person answers a teammate's question: once, by the person it was asked of; the card's turn is due again. */
export function answerTeammateQuestion(store: Store, id: number, answer: { choice: string | null; text: string | null; by: string; via: string }, now: Date): { ok: true; said: string } | { ok: false; said: string } {
  return store.transact(() => {
    const question = store.teammateQuestion(id);
    if (question === null || question.state !== "open") return { ok: false as const, said: "That question was already answered." };
    if (question.askedOf !== answer.by) return { ok: false as const, said: `Only ${question.askedOf} can answer this one.` };
    const choice = answer.choice === null ? null : question.options.find(one => one.id === answer.choice) ?? null;
    const text = answer.text?.trim().slice(0, 2000) || null;
    if (choice === null && text === null) return { ok: false as const, said: "Pick an answer or write one." };
    const card = store.getFlowCard(question.card);
    // v95: a rule change it suggested to its manager. Nothing about the card waits on it.
    if (question.suggestion !== null) {
      const mate = store.getTeammate(question.teammate);
      const decided = mate === null ? { ok: false as const, said: "That teammate is off the team." } : answerSuggestion(store, mate, question.suggestion, { choice: choice?.id ?? null, text, by: answer.by }, now);
      store.answerTeammateQuestion(id, { choice: choice?.id ?? null, text, by: answer.by, via: answer.via }, now);
      store.addTeammateEvent({ teammate: question.teammate, card: question.card, entry: question.entry, kind: "answered", said: `${answer.by}: ${[choice?.label, text].filter(Boolean).join(" — ")}`, by: answer.by }, now);
      return decided;
    }
    // v94: an ask-first tool call. Approve makes exactly that call (on the card's next turn); Deny, or words alone, don't.
    if (question.toolCall !== null) {
      if (card === null || card.state !== "active" || card.entry !== question.entry) {
        store.moveTeammateCall(question.toolCall, ["asked"], { state: "refused", result: "The card moved on before anyone approved it." }, now);
        store.dropTeammateQuestion(id, now);
        return { ok: false as const, said: "That card has moved on, so nothing was done." };
      }
      if (!store.moveTeammateCall(question.toolCall, ["asked"], { state: choice?.id === APPROVE ? "approved" : "denied", decidedBy: answer.by }, now)) return { ok: false as const, said: "That call was already decided." };
      // v95: approving the same action again and again teaches it to suggest a looser rule.
      const mate = store.getTeammate(question.teammate), call = store.teammateCall(question.toolCall);
      if (choice?.id === APPROVE && mate !== null && call !== null) considerSuggestion(store, mate, call, now);
    }
    store.answerTeammateQuestion(id, { choice: choice?.id ?? null, text, by: answer.by, via: answer.via }, now);
    store.addTeammateEvent({ teammate: question.teammate, card: question.card, entry: question.entry, kind: "answered", said: `${answer.by}: ${[choice?.label, text].filter(Boolean).join(" — ")}`, by: answer.by }, now);
    if (card !== null && card.state === "active" && card.entry === question.entry) {
      store.updateFlowCard(card.id, { waiting: null }, now);
      store.wakeFlowStep(card.id, card.entry, now);
    }
    return { ok: true as const, said: question.toolCall === null ? "Answered. It picks the card up again now." : choice?.id === APPROVE ? "Approved. The call is made now, exactly as shown." : "It won't make that call. It picks the card up again now." };
  });
}

/** A card's link, for messages about it. */
export const teammateCardHref = (flow: number, card: number) => flowCardHref(flow, card);
