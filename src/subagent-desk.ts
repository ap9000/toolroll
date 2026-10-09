/**
 * A subagent's desk (v96): its own flow, where anything asked of it directly
 * lands as a card — the lead asking it for its person ("ask Rosa where order
 * 2201 is", D5), or one of its routines ("every weekday at 9:00: …") — and
 * its answer goes back to whoever asked.
 *
 * The desk is an ordinary flow its manager owns and can redraw. The subagent
 * handles each card there within its rules and tools (asking first when they
 * say to), writes its answer, and picks where the card goes: Done, a code
 * change (the Build zone files an ordinary task that a person approves as
 * usual), or its manager. Nothing here gives it more than its rules do.
 */
import { flowCardHref, flowDefinitionOf } from "./flow-engine.js";
import { flowFromSteps } from "./flows.js";
import { addFlowTriggerTo, removeFlowTrigger, runScheduleNow, scheduleFromWords, triggerConfigOf } from "./flow-triggers.js";
import { describeSchedule, parseSchedule } from "./flow-schedule.js";
import type { FlowCardRow, FlowRow, Store, SubagentRow } from "./store.js";
import { labelOf, nameOf } from "./subagent-admin.js";

/** The zone on a desk where the subagent handles what it's asked. */
export const DESK_ZONE = "handle";
const DESK_INSTRUCTIONS = "Someone asked you this directly, or it's one of your routines. Do what they ask within your rules, using your tools when it needs them, and write your answer to them in \"text\": it goes back to whoever asked. Pick Done when you've answered, Needs a code change when what they want is a change to this project's code (it's filed as a task for a person to approve), and Needs a person when it's beyond you.";

type Done = { ok: true; said: string } | { ok: false; said: string };

/** Its desk, when it has one. */
export function deskOf(store: Store, mate: SubagentRow): FlowRow | null {
  const flow = mate.deskFlow === null ? null : store.getFlow(mate.deskFlow);
  return flow !== null && flow.state === "active" ? flow : null;
}

/** Its desk, made the first time it's needed: owned by its manager, drawn like any flow. */
export function ensureDesk(store: Store, mate: SubagentRow, now: Date): FlowRow {
  const had = deskOf(store, mate);
  if (had !== null) return had;
  const name = nameOf(mate);
  const person = `For ${mate.manager}`.slice(0, 60);
  const definition = flowFromSteps([
    { id: DESK_ZONE, title: "Requests", kind: "subagent", subagent: mate.handle, reply: true, instructions: DESK_INSTRUCTIONS,
      routes: [{ answer: "Done", goesTo: "Done" }, { answer: "Needs a code change", goesTo: "Build it" }, { answer: "Needs a person", goesTo: person }], ifFails: person },
    { id: "build", title: "Build it", kind: "task", planning: "auto", next: "Done" },
    { id: "person", title: person, kind: "inbox" },
    { id: "done", title: "Done", kind: "done" },
  ], null);
  const id = store.createFlow({ repo: mate.repo, name: `${name}'s desk`.slice(0, 80), definitionJson: JSON.stringify(definition), by: mate.manager }, now);
  store.setSubagentDesk(mate.id, id);
  return store.getFlow(id)!;
}

/** Who a desk card's answer goes to: the person who asked (when they can see the project), else its manager. */
export function askerOf(store: Store, flow: FlowRow, card: FlowCardRow, mate: SubagentRow): string {
  return store.accountOf(card.createdBy) !== null && store.accountCanAccess(card.createdBy, flow.repo) ? card.createdBy : mate.manager;
}

/** The answer a subagent wrote, back to whoever asked, under its name. Once per visit. */
export function replyToAsker(store: Store, flow: FlowRow, card: FlowCardRow, mate: SubagentRow, text: string, now: Date): void {
  const to = askerOf(store, flow, card, mate);
  store.enqueueNotification({ dedupeKey: `teammate-reply:${card.id}:${card.entry}`, kind: "teammate-reply", recipient: to, subject: `${labelOf(mate)}: ${card.title}`.slice(0, 200),
    body: text.slice(0, 3500), link: flowCardHref(flow.id, card.id), source: { project: flow.repo } }, now);
}

/**
 * The lead delegates (D5): "ask Rosa to …", once its person confirms the card, is a card on Rosa's desk from that
 * person. Rosa works it within her own rules and tools (asking them first where her rules say to), and her answer goes
 * back to whoever asked. It gives her nothing her rules don't: a code change is still a task a person approves.
 */
export function askSubagent(store: Store, given: SubagentRow, from: { who: string; via: string }, text: string, now: Date): { ok: true; said: string; card: number; link: { label: string; path: string } } | { ok: false; said: string } {
  // As it is now (its desk may have been made since the caller read it), never as the caller last saw it.
  const mate = store.getSubagent(given.id) ?? given;
  const name = nameOf(mate);
  if (mate.state !== "active") return { ok: false, said: `${name} is paused, so nothing was passed on. Resume ${name} first.` };
  if (!store.accountCanAccess(from.who, mate.repo)) return { ok: false, said: `${name} works in a project you can't use.` };
  const said = text.replace(/\r\n?/g, "\n").trim().slice(0, 4000);
  if (said === "") return { ok: false, said: `Say what to ask ${name}.` };
  const desk = ensureDesk(store, mate, now);
  const definition = flowDefinitionOf(desk);
  const zone = definition?.stages.find(one => one.id === DESK_ZONE) ?? definition?.stages.find(one => one.id === definition.start);
  if (zone === undefined) return { ok: false, said: `${name}'s desk can't take cards right now.` };
  const firstLine = said.split("\n")[0]!.trim();
  const title = firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 99)}…`;
  const card = store.addFlowCard({ flow: desk.id, title, description: said === title ? null : said, stage: zone.id, by: from.who, source: { kind: "message", label: `Asked through ${from.via}`, url: null } }, now);
  store.setFlowCardWatcher(card, from.who, true, now);
  return { ok: true, said: `${name} has it. The answer comes to you when it's done.`, card, link: { label: "Open the card", path: flowCardHref(desk.id, card) } };
}

export type Routine = { id: number; schedule: string; text: string; state: "active" | "paused" | "removed"; lastAt: string | null; lastOutcome: string | null; nextAt: string | null };

/** Its routines: the schedules on its desk that start in its zone. */
export function routinesOf(store: Store, mate: SubagentRow): Routine[] {
  const desk = deskOf(store, mate);
  if (desk === null) return [];
  return store.flowTriggers(desk.id).flatMap(trigger => {
    const config = triggerConfigOf(trigger);
    if (config?.kind !== "schedule" || config.script !== undefined || trigger.state === "removed") return [];
    return [{ id: trigger.id, schedule: config.schedule, text: config.title, state: trigger.state, lastAt: trigger.lastAt, lastOutcome: trigger.lastOutcome, nextAt: trigger.nextAt }];
  });
}

/** This computer's time zone: what a routine's time means when it names none. */
export const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

/** A routine's schedule as kept: a calendar time with no zone is this computer's time, not UTC. */
export function routineSchedule(words: string): string | null {
  const read = scheduleFromWords(words);
  // A zone the person named, UTC included, stays theirs.
  if (read === null || read.startsWith("every:") || read.includes("@") || /\b(utc|gmt)$/i.test(words.trim())) return read;
  return scheduleFromWords(`${words.trim()} ${localZone()}`) ?? read;
}

/** A routine: on this schedule ("weekdays 09:00", "daily 17:00 Europe/London", "every 2 hours"), a card on its desk saying what to do. */
export function addRoutine(store: Store, mate: SubagentRow, schedule: string, text: string, by: string, now: Date, dir: string | null): Done {
  const what = text.replace(/\s+/g, " ").trim();
  if (what === "") return { ok: false, said: "Say what it should do each time." };
  if (what.length > 200) return { ok: false, said: "Keep a routine to 200 characters; put detail in its soul file." };
  if (routinesOf(store, mate).length >= 10) return { ok: false, said: "A subagent has at most 10 routines." };
  const kept = routineSchedule(schedule);
  if (kept === null) return { ok: false, said: "Say the schedule like “weekdays 09:00”, “daily 17:00”, “monday 09:00” or “every 2 hours”." };
  const desk = ensureDesk(store, mate, now);
  const made = addFlowTriggerTo(store, desk, { kind: "schedule", schedule: kept, title: what, zone: DESK_ZONE }, by, now, dir);
  return made.ok ? { ok: true, said: `${nameOf(mate)} will do that ${describeSchedule(parseSchedule(kept)!)}. Its answer goes to ${mate.manager}.` } : { ok: false, said: made.message };
}

function routineOf(store: Store, mate: SubagentRow, id: number) {
  const desk = deskOf(store, mate);
  const trigger = desk === null ? null : store.flowTriggers(desk.id).find(one => one.id === id) ?? null;
  return trigger !== null && trigger.state !== "removed" ? trigger : null;
}

export function removeRoutine(store: Store, mate: SubagentRow, id: number, now: Date, dir: string | null): Done {
  const trigger = routineOf(store, mate, id);
  if (trigger === null) return { ok: false, said: "That routine is already gone." };
  removeFlowTrigger(store, trigger, now, dir);
  return { ok: true, said: "Removed. It won't do that any more." };
}

/** Try a routine now: its card lands on the desk at once. */
export function runRoutine(store: Store, mate: SubagentRow, id: number, by: string, now: Date): Done {
  const trigger = routineOf(store, mate, id);
  if (trigger === null) return { ok: false, said: "That routine is gone." };
  if (mate.state !== "active") return { ok: false, said: `${nameOf(mate)} is paused. Resume it first.` };
  const ran = runScheduleNow(store, trigger, by, now);
  return ran.ok ? { ok: true, said: `${nameOf(mate)} is on it. The answer goes to ${mate.manager}.` } : ran;
}
