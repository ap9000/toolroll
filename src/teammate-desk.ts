/**
 * A teammate's desk (v96): its own flow, where anything asked of it directly
 * lands as a card — a message to it by name in a chat app ("@rosa, where's
 * order 2201?", or "Rosa: …"), or one of its routines ("every weekday at
 * 9:00: …") — and its answer goes back to whoever asked.
 *
 * The desk is an ordinary flow its manager owns and can redraw. The teammate
 * handles each card there within its rules and tools (asking first when they
 * say to), writes its answer, and picks where the card goes: Done, a code
 * change (the Build zone files an ordinary task that a person approves as
 * usual), or its manager. Nothing here gives it more than its rules do.
 */
import { flowCardHref, flowDefinitionOf } from "./flow-engine.js";
import { flowFromSteps } from "./flows.js";
import { addFlowTriggerTo, removeFlowTrigger, runScheduleNow, scheduleFromWords, triggerConfigOf } from "./flow-triggers.js";
import { describeSchedule, parseSchedule } from "./flow-schedule.js";
import type { FlowCardRow, FlowRow, Store, TeammateRow } from "./store.js";
import { labelOf, nameOf } from "./teammate-admin.js";

/** The zone on a desk where the teammate handles what it's asked. */
export const DESK_ZONE = "handle";
const DESK_INSTRUCTIONS = "Someone asked you this directly, or it's one of your routines. Do what they ask within your rules, using your tools when it needs them, and write your answer to them in \"text\": it goes back to whoever asked. Pick Done when you've answered, Needs a code change when what they want is a change to this project's code (it's filed as a task for a person to approve), and Needs a person when it's beyond you.";

type Done = { ok: true; said: string } | { ok: false; said: string };

/** Its desk, when it has one. */
export function deskOf(store: Store, mate: TeammateRow): FlowRow | null {
  const flow = mate.deskFlow === null ? null : store.getFlow(mate.deskFlow);
  return flow !== null && flow.state === "active" ? flow : null;
}

/** Its desk, made the first time it's needed: owned by its manager, drawn like any flow. */
export function ensureDesk(store: Store, mate: TeammateRow, now: Date): FlowRow {
  const had = deskOf(store, mate);
  if (had !== null) return had;
  const name = nameOf(mate);
  const person = `For ${mate.manager}`.slice(0, 60);
  const definition = flowFromSteps([
    { id: DESK_ZONE, title: "Requests", kind: "teammate", teammate: mate.handle, reply: true, instructions: DESK_INSTRUCTIONS,
      routes: [{ answer: "Done", goesTo: "Done" }, { answer: "Needs a code change", goesTo: "Build it" }, { answer: "Needs a person", goesTo: person }], ifFails: person },
    { id: "build", title: "Build it", kind: "task", planning: "auto", next: "Done" },
    { id: "person", title: person, kind: "inbox" },
    { id: "done", title: "Done", kind: "done" },
  ], null);
  const id = store.createFlow({ repo: mate.repo, name: `${name}'s desk`.slice(0, 80), definitionJson: JSON.stringify(definition), by: mate.manager }, now);
  store.setTeammateDesk(mate.id, id);
  return store.getFlow(id)!;
}

/** Who a desk card's answer goes to: the person who asked (when they can see the project), else its manager. */
export function askerOf(store: Store, flow: FlowRow, card: FlowCardRow, mate: TeammateRow): string {
  return store.accountOf(card.createdBy) !== null && store.accountCanAccess(card.createdBy, flow.repo) ? card.createdBy : mate.manager;
}

/** The answer a teammate wrote, back to whoever asked, under its name. Once per visit. */
export function replyToAsker(store: Store, flow: FlowRow, card: FlowCardRow, mate: TeammateRow, text: string, now: Date): void {
  const to = askerOf(store, flow, card, mate);
  store.enqueueNotification({ dedupeKey: `teammate-reply:${card.id}:${card.entry}`, kind: "teammate-reply", recipient: to, subject: `${labelOf(mate)}: ${card.title}`.slice(0, 200),
    body: text.slice(0, 3500), link: flowCardHref(flow.id, card.id), source: { project: flow.repo } }, now);
}

/** "@rosa …", "@rosa, …", "Rosa: …" or "Rosa, …": the teammate a message is addressed to, and what it says. */
export function addressedTo(text: string): { name: string; said: string } | null {
  const at = /^\s*@([\p{L}\p{N}][\p{L}\p{N}-]{0,31})[\s,:]+([\s\S]*\S[\s\S]*)$/u.exec(text);
  if (at !== null) return { name: at[1]!, said: at[2]!.trim() };
  const named = /^\s*([\p{L}][\p{L}\p{N}-]{0,31})\s*[,:]\s+([\s\S]*\S[\s\S]*)$/u.exec(text);
  return named === null ? null : { name: named[1]!, said: named[2]!.trim() };
}

/**
 * A message in someone's chat with Toolroll, addressed to a teammate
 * by name, becomes a card on its desk; null when it isn't addressed to one of
 * the teammates in their projects (it goes to the lead as usual).
 */
export function messageTeammate(store: Store, from: { who: string; repos: readonly string[]; via: string }, text: string, now: Date): { said: string; link?: { label: string; path: string } } | null {
  const addressed = addressedTo(text);
  if (addressed === null) return null;
  const wanted = addressed.name.toLowerCase();
  const mate = store.teammates(from.repos).find(one => one.handle === wanted || nameOf(one).toLowerCase() === wanted);
  if (mate === undefined || !store.accountCanAccess(from.who, mate.repo)) return null;
  const name = nameOf(mate);
  if (mate.state !== "active") return { said: `${name} is paused, so nothing was passed on. Resume ${name} on its page, or ask the lead.` };
  const desk = ensureDesk(store, mate, now);
  const definition = flowDefinitionOf(desk);
  const zone = definition?.stages.find(one => one.id === DESK_ZONE) ?? definition?.stages.find(one => one.id === definition.start);
  if (zone === undefined) return { said: `${name}'s desk can't take cards right now.` };
  const said = addressed.said.slice(0, 4000);
  const firstLine = said.split("\n")[0]!.trim();
  const title = firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 99)}…`;
  const card = store.addFlowCard({ flow: desk.id, title, description: said === title ? null : said, stage: zone.id, by: from.who, source: { kind: "message", label: `${from.via} message`, url: null } }, now);
  store.setFlowCardWatcher(card, from.who, true, now);
  return { said: `${name} has it. The answer comes here when it's done.`, link: { label: "Open the card", path: flowCardHref(desk.id, card) } };
}

export type Routine = { id: number; schedule: string; text: string; state: "active" | "paused" | "removed"; lastAt: string | null; lastOutcome: string | null; nextAt: string | null };

/** Its routines: the schedules on its desk that start in its zone. */
export function routinesOf(store: Store, mate: TeammateRow): Routine[] {
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
export function addRoutine(store: Store, mate: TeammateRow, schedule: string, text: string, by: string, now: Date, dir: string | null): Done {
  const what = text.replace(/\s+/g, " ").trim();
  if (what === "") return { ok: false, said: "Say what it should do each time." };
  if (what.length > 200) return { ok: false, said: "Keep a routine to 200 characters; put detail in its soul file." };
  if (routinesOf(store, mate).length >= 10) return { ok: false, said: "A teammate has at most 10 routines." };
  const kept = routineSchedule(schedule);
  if (kept === null) return { ok: false, said: "Say the schedule like “weekdays 09:00”, “daily 17:00”, “monday 09:00” or “every 2 hours”." };
  const desk = ensureDesk(store, mate, now);
  const made = addFlowTriggerTo(store, desk, { kind: "schedule", schedule: kept, title: what, zone: DESK_ZONE }, by, now, dir);
  return made.ok ? { ok: true, said: `${nameOf(mate)} will do that ${describeSchedule(parseSchedule(kept)!)}. Its answer goes to ${mate.manager}.` } : { ok: false, said: made.message };
}

function routineOf(store: Store, mate: TeammateRow, id: number) {
  const desk = deskOf(store, mate);
  const trigger = desk === null ? null : store.flowTriggers(desk.id).find(one => one.id === id) ?? null;
  return trigger !== null && trigger.state !== "removed" ? trigger : null;
}

export function removeRoutine(store: Store, mate: TeammateRow, id: number, now: Date, dir: string | null): Done {
  const trigger = routineOf(store, mate, id);
  if (trigger === null) return { ok: false, said: "That routine is already gone." };
  removeFlowTrigger(store, trigger, now, dir);
  return { ok: true, said: "Removed. It won't do that any more." };
}

/** Try a routine now: its card lands on the desk at once. */
export function runRoutine(store: Store, mate: TeammateRow, id: number, by: string, now: Date): Done {
  const trigger = routineOf(store, mate, id);
  if (trigger === null) return { ok: false, said: "That routine is gone." };
  if (mate.state !== "active") return { ok: false, said: `${nameOf(mate)} is paused. Resume it first.` };
  const ran = runScheduleNow(store, trigger, by, now);
  return ran.ok ? { ok: true, said: `${nameOf(mate)} is on it. The answer goes to ${mate.manager}.` } : ran;
}
