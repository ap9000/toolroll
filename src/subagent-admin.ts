/**
 * Looking after subagents (v92): making one from a template or a soul
 * file, editing its soul (a new version each time), pausing or removing it,
 * telling it something, and the daily summary it sends its manager.
 *
 * Shared by the Subagents pages and the lead chat, so both do the same thing.
 */
import type { Store, SubagentRow } from "./store.js";
import { flowDefinitionOf } from "./flow-engine.js";
import { handleOf, parseSoul, SUBAGENT_TEMPLATES, subagentLabel } from "./subagents.js";

export type Done = { ok: true; said: string; id?: number } | { ok: false; said: string };
export const SUBAGENT_MODELS = ["default", "sonnet", "opus", "haiku"] as const;

/** A soul file with a different name: the template's, renamed. */
export function renamedSoul(soul: string, name: string): string {
  return soul.replace(/^name:.*$/m, `name: ${name.replace(/[\r\n]/g, " ").trim()}`);
}

/** A new subagent in a project, from a template (optionally renamed) or a whole soul file. */
export function createSubagentFrom(store: Store, input: { repo: string; template?: string | null; name?: string | null; soul?: string | null; by: string }, now: Date): Done {
  const template = SUBAGENT_TEMPLATES.find(one => one.id === input.template);
  let soul = input.soul?.trim() ? input.soul : template?.soul ?? null;
  if (soul === null) return { ok: false, said: "Start from a template, or write a soul file." };
  if (input.name?.trim()) soul = renamedSoul(soul, input.name);
  const read = parseSoul(soul);
  if (!read.ok) return { ok: false, said: read.problem };
  const handle = handleOf(read.soul.name);
  if (store.subagentByHandle(input.repo, handle) !== null) return { ok: false, said: `There's already a subagent called ${read.soul.name} in this project. Give this one another name.` };
  const id = store.createSubagent({ repo: input.repo, handle, soul, model: null, manager: input.by, by: input.by }, now);
  store.addSubagentEvent({ subagent: id, kind: "note", said: `${input.by} brought ${read.soul.name} onto the team.`, by: input.by }, now);
  return { ok: true, said: `${subagentLabel(read.soul)} is on the team. Put ${read.soul.name} on a zone to start.`, id };
}

/** Save a new version of a subagent's soul file. Its name stays: zones name it by handle. */
export function saveSoul(store: Store, mate: SubagentRow, soul: string, by: string, now: Date): Done {
  const read = parseSoul(soul);
  if (!read.ok) return { ok: false, said: read.problem };
  if (handleOf(read.soul.name) !== mate.handle) return { ok: false, said: `Keep the name (zones find this subagent as ${mate.handle}); make a new subagent for another name.` };
  const saved = store.saveSubagentSoul(mate.id, soul.replace(/\r\n?/g, "\n").trim() + "\n", by, now);
  return { ok: true, said: saved ? `Saved. ${read.soul.name} works from version ${mate.version + 1} now.` : "No changes to save." };
}

/** Pause, resume or remove. Paused, its decisions go to people and the zones it handles wait. */
export function setSubagentState(store: Store, mate: SubagentRow, state: "active" | "paused" | "removed", by: string, now: Date): Done {
  const name = nameOf(mate);
  if (state === mate.state) return { ok: true, said: "No change." };
  if (state === "removed") {
    for (const question of store.openSubagentQuestions([mate.id])) store.dropSubagentQuestion(question.id, now);
    // v94: calls waiting for approval, or approved and not made yet, are never made.
    for (const call of store.subagentCallsOf(mate.id, 500).filter(one => one.state === "asked" || one.state === "approved")) store.moveSubagentCall(call.id, ["asked", "approved"], { state: "refused", result: `${name} left the team before the call was made.` }, now);
    store.updateSubagent(mate.id, { state }, by, now);
    return { ok: true, said: `${name} is off the team. Zones that named ${name} go to people now.` };
  }
  store.updateSubagent(mate.id, { state }, by, now);
  store.addSubagentEvent({ subagent: mate.id, kind: state === "paused" ? "paused" : "resumed", said: state === "paused" ? `${by} paused ${name}.` : `${by} set ${name} working again.`, by }, now);
  return { ok: true, said: state === "paused" ? `${name} is paused. Its decisions go to people until you resume it.` : `${name} is working again.` };
}

export function subagentSettings(store: Store, mate: SubagentRow, change: { model?: string; dailyTurns?: number; manager?: string }, by: string, now: Date): Done {
  const model = change.model === undefined ? undefined : change.model === "default" ? null : SUBAGENT_MODELS.includes(change.model as typeof SUBAGENT_MODELS[number]) ? change.model : undefined;
  if (change.model !== undefined && model === undefined) return { ok: false, said: "Choose one of the models listed." };
  if (change.dailyTurns !== undefined && (!Number.isInteger(change.dailyTurns) || change.dailyTurns < 1 || change.dailyTurns > 2000)) return { ok: false, said: "A daily limit is 1 to 2,000 turns." };
  if (change.manager !== undefined && !store.accountCanAccess(change.manager, mate.repo)) return { ok: false, said: "Its manager must be someone on this project." };
  store.updateSubagent(mate.id, { ...(model === undefined ? {} : { model }), ...(change.dailyTurns === undefined ? {} : { dailyTurns: change.dailyTurns }), ...(change.manager === undefined ? {} : { manager: change.manager }) }, by, now);
  return { ok: true, said: "Saved." };
}

export const nameOf = (mate: SubagentRow) => { const read = parseSoul(mate.soul); return read.ok ? read.soul.name : mate.handle; };
export const labelOf = (mate: SubagentRow) => { const read = parseSoul(mate.soul); return read.ok ? subagentLabel(read.soul) : mate.handle; };

/** Every zone a subagent works, in every flow of its project. */
export function zonesOf(store: Store, mate: SubagentRow): { flow: number; flowName: string; zone: string; title: string; kind: "decides" | "handles" }[] {
  return store.listFlows([mate.repo]).flatMap(flow => (flowDefinitionOf(flow)?.stages ?? []).filter(one => one.subagent === mate.handle)
    .map(one => ({ flow: flow.id, flowName: flow.name, zone: one.id, title: one.title, kind: one.kind === "approval" ? "decides" as const : "handles" as const })));
}

/** What a subagent did since a time, in words its manager reads at a glance. */
export function summaryOf(store: Store, mate: SubagentRow, since: string | null): { said: string; quiet: boolean } {
  const name = nameOf(mate);
  const events = store.subagentEvents(mate.id, 500, since);
  const count = (kind: string) => events.filter(one => one.kind === kind).length;
  const decided = count("decided"), handled = count("handled"), handed = count("handed"), asked = count("asked"), failed = count("failed");
  const open = store.openSubagentQuestions([mate.id]).length;
  // v94: its tool calls — made, approved first, and what its people said no to.
  const calls = store.subagentCallsOf(mate.id, 1000, since);
  const made = calls.filter(one => one.state === "done" || one.state === "failed").length, approved = calls.filter(one => one.decidedBy !== null && one.state !== "denied").length, denied = calls.filter(one => one.state === "denied").length;
  const quiet = decided + handled + handed + asked + failed + calls.length === 0;
  const lines = [
    quiet ? `${name} had nothing to do${since === null ? " yet" : " today"}.` : `${name} decided ${decided}, handled ${handled}, handed ${handed} to people, and asked ${asked} question${asked === 1 ? "" : "s"}${failed > 0 ? `; ${failed} turn${failed === 1 ? "" : "s"} failed` : ""}.`,
    ...(calls.length === 0 ? [] : [`It made ${made} tool call${made === 1 ? "" : "s"}${approved > 0 ? ` (${approved} after a person approved)` : ""}${denied > 0 ? `; ${denied} ${denied === 1 ? "was" : "were"} turned down` : ""}.`]),
    ...(open > 0 ? [`${open} question${open === 1 ? " is" : "s are"} waiting for an answer.`] : []),
    ...events.filter(one => one.kind === "handed" || one.kind === "failed").slice(0, 5).map(one => `• ${one.said}`),
  ];
  return { said: lines.join("\n"), quiet };
}

/** The daily summary, to each subagent's manager, once a day after 5 pm (this computer's time), or now when asked. */
export function sendSubagentSummaries(store: Store, repo: string, now: Date, only: number | null = null): number {
  const evening = new Date(now); evening.setHours(17, 0, 0, 0);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  let sent = 0;
  for (const mate of store.subagents([repo])) {
    if (only !== null ? mate.id !== only : mate.state !== "active" || now < evening || (mate.summaryAt !== null && mate.summaryAt >= evening.toISOString())) continue;
    const summary = summaryOf(store, mate, start.toISOString());
    store.updateSubagent(mate.id, { summaryAt: now.toISOString() }, "summary", now);
    if (summary.quiet && only === null) continue;
    store.enqueueNotification({ dedupeKey: `teammate-summary:${mate.id}:${now.toISOString().slice(0, only === null ? 10 : 19)}`, kind: "teammate-summary", recipient: mate.manager,
      subject: `${labelOf(mate)}: today`, body: summary.said, link: `/settings/lead/subagents/${mate.id}`, source: { project: repo } }, now);
    store.addSubagentEvent({ subagent: mate.id, kind: "summary", said: summary.said }, now);
    sent++;
  }
  return sent;
}
