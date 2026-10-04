/**
 * "Send to me" and "Person chooses" zones (flows.ts): what a card's step before produced, sent to the card's person.
 *
 * - The person is the card's owner, else the flow's.
 * - What is sent: the card's title and the step it comes from, a summary (the build's own report, a research report,
 *   or what the step before wrote), its links (the result, its pull request, the report, the card) and the build's
 *   screenshots. It is worked out once per visit and kept (flow_send), so every chat app and the card show the same.
 * - It goes as one notification to that person, which each chat app they paired delivers (Telegram: the screenshots as
 *   one album; Slack and Discord: uploads in its thread; Teams: a link to them), and the card shows it in the console.
 * - A choose visit carries the zone's options as buttons (telegram-flow.ts, chat-flow.ts, and the card). Each leads to
 *   a zone, or ends the card as Ignored; a reply instead is the {{note}} for where replies go. Every choice is made
 *   here (chooseFlowCard), for exactly the visit the person saw, by that person alone, and ledgered with where.
 *
 * Deterministic and model-free, in the worker's flow pass.
 */
import { assignmentOf } from "./assignment.js";
import { withActor } from "./actor.js";
import { flowCardHref, flowDefinitionOf, revisionWithNote, type FlowDecision } from "./flow-engine.js";
import { notifyPeople } from "./flow-people.js";
import { FLOW_END, replyTarget, type FlowDefinition, type FlowStage } from "./flows.js";
import { FLOW_SHOTS_KIND, type FlowCardRow, type FlowRow, type Store } from "./store.js";

/** The notice a "Send to me" visit sends: `flow-send:<card>:<entry>`. */
export const FLOW_SEND_KEY = /^flow-send:([1-9][0-9]{0,14}):([1-9][0-9]{0,9})$/;
/** The notice a "Person chooses" visit sends: `flow-choose:<card>:<entry>`, a "flow-decision" like an approval's. */
export const FLOW_CHOOSE_KEY = /^flow-choose:([1-9][0-9]{0,14}):([1-9][0-9]{0,9})$/;
/** What the person is asked under the buttons. */
export const REPLY_ASK = "Or reply with what you'd change.";

const SUMMARY_CHARS = 1500;
const STEP_CHARS = 500;

export type FlowSendLink = { label: string; path: string } | { label: string; url: string };
export type FlowSendContent = {
  /** The card's title and the step it comes from. */
  title: string;
  /** The step it comes from, when known. */
  from?: string;
  summary: string;
  links: FlowSendLink[];
  /** The build's result whose screenshots go with it, when it saved any. */
  shots: { taskId: string; run: number } | null;
  /** choose: the options as they were offered, and whether a reply is taken. */
  options?: { choice: number; label: string }[];
  reply?: boolean;
};

/** Who a card's "Send to me" and "Person chooses" zones are for: its owner, else the flow's. */
export function flowPersonOf(card: Pick<FlowCardRow, "owner">, flow: Pick<FlowRow, "owner">): string {
  return card.owner ?? flow.owner;
}

const cut = (text: string, cap: number) => text.length <= cap ? text : `${text.slice(0, cap - 1).trimEnd()}…`;
const plain = (text: string) => text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();

/** The zone the card came from into this visit: its latest move, else a zone that leads here. */
function stepBefore(store: Store, definition: FlowDefinition, card: FlowCardRow): FlowStage | null {
  const events = store.flowEvents(card.id);
  const last = events[events.length - 1];
  const from = last !== undefined && last.toStage === card.stage && last.fromStage !== card.stage ? last.fromStage : null;
  return definition.stages.find(one => one.id === from)
    ?? definition.stages.find(one => one.next === card.stage || one.onFail === card.stage || (one.options ?? []).some(option => option.to === card.stage)) ?? null;
}

/** A result's facts for the person, read as the operator would: its report, its pull request and screenshots. */
function resultOf(store: Store, taskId: string, now: Date, evidenceRoot: string | undefined) {
  const repo = store.lookupRef(taskId)?.repo ?? null;
  if (repo === null) return null;
  const snapshot = assignmentOf(store, taskId, now, { principal: "operator", repos: [repo] }, evidenceRoot);
  const receipt = snapshot?.receipt ?? null;
  const url = snapshot?.publication?.prUrl ?? null;
  return {
    taskId: receipt?.taskId ?? snapshot?.activeTaskId ?? taskId, report: receipt?.agentReport ?? null,
    pullRequest: url !== null && /^https:\/\/[^\s<>"]+$/.test(url) ? url : null,
    shots: receipt !== null && store.artifactsFor(receipt.runId).some(one => one.kind === "screenshot") ? { taskId: receipt.taskId, run: receipt.runId } : null,
  };
}

/** A research task's latest delivered report, when its run saved screenshots: what that step produced to show. */
function reportShotsOf(store: Store, taskId: string): { taskId: string; run: number } | null {
  const ref = store.lookupRef(taskId);
  if (ref === null) return null;
  const run = store.runsFor(ref.id).find(one => one.finishedAt !== null && one.role === "scout");
  return run !== undefined && run.outcome === "built" && store.artifactsFor(run.id).some(one => one.kind === "screenshot") ? { taskId, run: run.id } : null;
}

/** What a visit sends its person, worked out from the card as it is now. */
export function flowSendContent(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, now: Date, evidenceRoot?: string): FlowSendContent {
  const before = stepBefore(store, definition, card);
  const output = before === null ? undefined : card.outputs[before.id]?.trim() || undefined;
  // The task the step before produced (a build or research zone hands it over), and the card's main build.
  const handed = card.task !== null && before !== null && (before.kind === "task" || before.kind === "report") ? card.task : null;
  const report = handed !== null && before?.kind === "report" ? handed : null;
  const build = before?.kind === "task" && handed !== null ? handed : card.primaryTask;
  const result = build === null ? null : resultOf(store, build, now, evidenceRoot);
  const lines: string[] = [];
  if (before?.kind === "report" && output !== undefined) lines.push(cut(output, SUMMARY_CHARS));
  else if (result?.report != null && result.report.trim() !== "") {
    lines.push(cut(result.report.trim(), SUMMARY_CHARS));
    if (output !== undefined && before?.kind !== "task") lines.push(`${before!.title}: ${cut(output, STEP_CHARS)}`);
  } else if (output !== undefined) lines.push(cut(output, SUMMARY_CHARS));
  else {
    // Nothing from the step before: the latest thing any zone wrote, else the card's own details.
    const latest = [...definition.stages].reverse().find(one => one.id !== stage.id && card.outputs[one.id]?.trim());
    lines.push(latest !== undefined ? `${latest.title}: ${cut(card.outputs[latest.id]!.trim(), SUMMARY_CHARS)}` : card.description === null ? "Nothing was written down for this step." : cut(card.description, SUMMARY_CHARS));
  }
  const links: FlowSendLink[] = [];
  if (result !== null) links.push({ label: "Result", path: `/t/${encodeURIComponent(result.taskId)}` });
  if (result?.pullRequest != null) links.push({ label: "Pull request", url: result.pullRequest });
  if (report !== null) links.push({ label: "Report", path: `/t/${encodeURIComponent(report)}` });
  links.push({ label: "Card", path: flowCardHref(flow.id, card.id) });
  const options = stage.kind === "choose" ? (stage.options ?? []).map((one, choice) => ({ choice, label: one.label })) : undefined;
  return {
    title: cut(plain(before === null ? card.title : `${card.title} · ${before.title}`), 200), ...(before === null ? {} : { from: before.title }),
    // After research, its own screenshots are what that step produced; otherwise the build's.
    summary: plain(lines.join("\n\n")), links, shots: (report === null ? null : reportShotsOf(store, report)) ?? result?.shots ?? null,
    ...(options === undefined ? {} : { options, reply: replyTarget(stage) !== null }),
  };
}

/** A kept content, read back; null when it can't be. */
export function readFlowSend(json: string): FlowSendContent | null {
  try {
    const raw = JSON.parse(json) as FlowSendContent;
    return typeof raw.title === "string" && typeof raw.summary === "string" && Array.isArray(raw.links) ? raw : null;
  } catch { return null; }
}

/** The words of a sent visit: its title, summary and pull request (the one link that isn't a page of Toolroll's). */
export function flowSendText(content: FlowSendContent): string {
  const pull = content.links.find((one): one is { label: string; url: string } => "url" in one);
  return [content.title, content.summary, ...(pull === undefined ? [] : [`${pull.label}: ${pull.url}`])].filter(one => one !== "").join("\n\n");
}

/** The links a sent visit's message carries as buttons: Toolroll's own pages, the first one first. */
export function flowSendPaths(content: FlowSendContent): { label: string; path: string }[] {
  return content.links.filter((one): one is { label: string; path: string } => "path" in one);
}

/** A visit's content, kept the first time; later passes (and every chat app) read the same one. */
function keep(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, now: Date, evidenceRoot: string | undefined): { content: FlowSendContent; person: string; fresh: boolean } {
  const person = flowPersonOf(card, flow);
  const kept = store.flowSend(card.id, card.entry);
  const read = kept === null ? null : readFlowSend(kept.contentJson);
  if (kept !== null && read !== null) return { content: read, person: kept.person, fresh: false };
  const content = flowSendContent(store, flow, definition, stage, card, now, evidenceRoot);
  const fresh = store.recordFlowSend({ card: card.id, entry: card.entry, stage: stage.id, person, contentJson: JSON.stringify(content) }, now);
  return { content, person, fresh };
}

/** One notice to the person, and its screenshots after it. Never as anyone's own act: they asked for it in the flow. */
function enqueue(store: Store, flow: FlowRow, card: FlowCardRow, person: string, content: FlowSendContent, notice: { key: string; kind: string; subject: string; body: string; attention: boolean }, now: Date): void {
  if (!store.accountCanAccess(person, flow.repo)) return;
  withActor(null, () => {
    store.enqueueNotification({ dedupeKey: notice.key, kind: notice.kind, recipient: person, ...(notice.attention ? { pushClass: "attention" as const } : {}),
      subject: notice.subject.slice(0, 200), body: notice.body.slice(0, 4000), link: flowSendPaths(content)[0]?.path ?? flowCardHref(flow.id, card.id), source: { project: flow.repo } }, now);
    if (content.shots !== null && store.lookupRef(content.shots.taskId)?.repo != null && store.accountCanAccess(person, store.lookupRef(content.shots.taskId)!.repo!)) {
      store.enqueueNotification({ dedupeKey: `flow-shots:${card.id}:${card.entry}`, kind: FLOW_SHOTS_KIND, recipient: person, subject: "Screenshots with this result", body: "",
        link: `/t/${encodeURIComponent(content.shots.taskId)}`, source: { run: content.shots.run } }, now);
    }
  });
}

/** A "Send to me" visit: what the step before produced, to the person once; the card moves on after. */
export function sendStep(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, now: Date, evidenceRoot?: string): void {
  const { content, person, fresh } = keep(store, flow, definition, stage, card, now, evidenceRoot);
  if (!fresh) return;
  store.updateFlowCard(card.id, { outputs: { ...card.outputs, [stage.id]: flowSendText(content) } }, now);
  enqueue(store, flow, card, person, content, { key: `flow-send:${card.id}:${card.entry}`, kind: "flow-card", attention: false,
    subject: `${flow.name}: ${content.title}`, body: [content.summary, ...content.links.filter((one): one is { label: string; url: string } => "url" in one).map(one => `${one.label}: ${one.url}`)].join("\n\n") }, now);
}

/** A "Person chooses" visit: the same content with the zone's options, to the person once; the card waits for their choice. */
export function chooseStep(store: Store, flow: FlowRow, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, now: Date, evidenceRoot?: string): void {
  const { content, person, fresh } = keep(store, flow, definition, stage, card, now, evidenceRoot);
  const waiting = `Waiting for ${person} to choose`;
  if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now);
  if (!fresh) return;
  enqueue(store, flow, card, person, content, { key: `flow-choose:${card.id}:${card.entry}`, kind: "flow-decision", attention: true,
    subject: `${flow.name}: ${content.title}`, body: flowChooseBody(content) }, now);
}

/** The words above a choice's buttons: what was done, then what to do. */
export function flowChooseBody(content: FlowSendContent): string {
  const pull = content.links.find((one): one is { label: string; url: string } => "url" in one);
  return [content.summary, ...(pull === undefined ? [] : [`${pull.label}: ${pull.url}`]), content.reply === true ? `Choose one. ${REPLY_ASK}` : "Choose one."].join("\n\n");
}

export type FlowChoiceVisit = { card: FlowCardRow; flow: FlowRow; stage: FlowStage; definition: FlowDefinition; person: string };

/** The card, if it is still at that visit, waiting for its person's choice. */
export function flowChoiceAt(store: Store, cardId: number, entry: number): FlowChoiceVisit | null {
  const card = store.getFlowCard(cardId);
  const flow = card === null ? null : store.getFlow(card.flow);
  const definition = flow === null ? null : flowDefinitionOf(flow);
  if (card === null || flow === null || definition === null || card.state !== "active" || card.entry !== entry) return null;
  const stage = definition.stages.find(one => one.id === card.stage);
  if (stage === undefined || stage.kind !== "choose") return null;
  return { card, flow, stage, definition, person: flowPersonOf(card, flow) };
}

const via = (where: string) => where === "" ? "" : ` in ${where}`;

/**
 * A person's choice on a card waiting at a "Person chooses" zone: an option (by its place, and the words and zone they saw), or a
 * reply (`choice` null) that becomes the note for where replies go. `where` names the place it was made, for the card's
 * history and the ledger: "Telegram", "Slack", "the console".
 */
export function chooseFlowCard(store: Store, input: { card: number; entry?: number; choice: number | null; label?: string; to?: string; note: string | null; actor: string; where: string; repos: readonly string[]; evidenceRoot?: string }, now: Date): FlowDecision {
  const card = store.getFlowCard(input.card);
  const flow = card === null ? null : store.getFlow(card.flow);
  if (card === null || flow === null || card.state !== "active" || !input.repos.includes(flow.repo)) return { ok: false, message: "That card is no longer waiting." };
  const visit = flowChoiceAt(store, card.id, input.entry ?? card.entry);
  if (visit === null) return { ok: false, message: "That card has moved on since; nothing was changed." };
  const { stage, definition, person } = visit;
  if (person !== input.actor) return { ok: false, message: `Only ${person} chooses here.` };
  const titleOf = (id: string) => definition.stages.find(one => one.id === id)?.title ?? id;
  const ledger = (outcome: "chosen" | "ignored" | "replied", said: string) => store.recordAction({ at: now.toISOString(), actor: input.actor, repo: flow.repo, taskId: card.primaryTask, runId: null,
    action: "flow choice", outcome, source: "request", detail: `${flow.name} · card ${card.id} · ${stage.title}: ${said} · via ${input.where || "Toolroll"}` });
  if (input.choice !== null) {
    const option = (stage.options ?? [])[input.choice];
    if (option === undefined || (input.label !== undefined && option.label !== input.label) || (input.to !== undefined && option.to !== input.to)) return { ok: false, message: "Those options changed since; nothing was changed." };
    if (option.to === FLOW_END) {
      const closed = store.transact(() => {
        if (!store.moveFlowCard(card.id, { to: card.stage, outcome: "cancelled", actor: input.actor, historyNote: `Ignored: chose “${option.label}”${via(input.where)}`, expectEntry: card.entry }, now)) return false;
        store.updateFlowCard(card.id, { state: "cancelled", waiting: "Ignored" }, now);
        store.retireFlowChoices(card.id, card.entry, now);
        ledger("ignored", `“${option.label}”`);
        return true;
      });
      return closed ? { ok: true, said: "Ignored. The card is closed." } : { ok: false, message: "That card has moved on since; nothing was changed." };
    }
    const moved = store.transact(() => {
      if (!store.moveFlowCard(card.id, { to: option.to, outcome: "moved", actor: input.actor, historyNote: `Chose “${option.label}”${via(input.where)}`, expectEntry: card.entry }, now)) return false;
      store.retireFlowChoices(card.id, card.entry, now);
      ledger("chosen", `“${option.label}”`);
      return true;
    });
    if (!moved) return { ok: false, message: "That card has moved on since; nothing was changed." };
    if (card.owner !== null && card.owner !== input.actor) notifyPeople(store, card, [card.owner], input.actor, { key: `chose:${card.entry}`, subject: `${input.actor} chose “${option.label}” for “${card.title}”`, body: `It moves to ${titleOf(option.to)}.` }, now);
    const title = titleOf(option.to);
    return { ok: true, said: `${option.label}. Moved to ${title}${/[.?!]$/.test(title) ? "" : "."}` };
  }
  const note = (input.note ?? "").trim();
  const target = replyTarget(stage);
  if (target === null) return { ok: false, message: "Choose one of the options; this step doesn't take a reply." };
  if (input.to !== undefined && target !== input.to) return { ok: false, message: "Where replies go changed since; nothing was changed." };
  if (note === "") return { ok: false, message: "Say what you'd change." };
  if (note.length > 2000) return { ok: false, message: "Keep it under 2,000 characters." };
  const revision = revisionWithNote(store, card, definition.stages.find(one => one.id === target), note, input.actor, input.repos, input.evidenceRoot, now);
  const moved = store.transact(() => {
    if (!store.moveFlowCard(card.id, { to: target, outcome: "sent-back", actor: input.actor, note, ...(revision === null ? {} : { task: revision }), expectEntry: card.entry }, now)) return false;
    store.retireFlowChoices(card.id, card.entry, now);
    ledger("replied", `a reply to ${titleOf(target)}`);
    return true;
  });
  if (!moved) return { ok: false, message: "That card has moved on since; nothing was changed." };
  if (card.owner !== null && card.owner !== input.actor) notifyPeople(store, card, [card.owner], input.actor, { key: `replied:${card.entry}`, subject: `${input.actor} replied on “${card.title}”`, body: `Sent to ${titleOf(target)}:\n\n${note}`, attention: true }, now);
  return { ok: true, said: revision === null ? `Sent to ${titleOf(target)} with your note.` : `Sent to ${titleOf(target)}: a revision was made with your note.` };
}
