/**
 * A subagent's week (v97): what it did, what it cost, what its people
 * overrode, and its receipts — on its page, and each Monday morning to its
 * manager in their chat app.
 *
 * Cost is what the Claude CLI reports for each turn (at API prices; a Claude
 * plan covers subscription turns). Overrides are the calls its people turned
 * down and the cards someone moved by hand right after it moved them.
 *
 * Undo, where the tool can: a manager names, per action, another action of
 * the same tool that undoes it (remove_label for add_label, say). Undo makes
 * that call with the same input, as the person who pressed it, and both calls
 * keep their receipts.
 */
import { flowCardHref } from "./flow-engine.js";
import type { Store, SubagentCallRow, SubagentRow } from "./store.js";
import { labelOf, nameOf } from "./subagent-admin.js";
import { callWords, makeCall, type ToolIo } from "./subagent-tools.js";

type Done = { ok: true; said: string } | { ok: false; said: string };

export type Week = {
  since: string;
  turns: number; failedTurns: number; costUsd: number | null; minutes: number;
  decided: number; handled: number; handed: number; asked: number;
  calls: { made: number; approved: number; denied: number; refused: number; undone: number };
  overrides: { said: string; at: string; href: string | null }[];
  undoable: { call: number; words: string; undo: string; at: string; href: string | null }[];
};

const WEEK_MS = 7 * 86_400_000;
const money = (usd: number) => usd < 0.01 ? "under 1¢" : usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`;

/** The undo action a call's rule names, when there is one and the call can still be undone. */
export function undoFor(store: Store, call: SubagentCallRow): string | null {
  if (call.state !== "done" || call.undoneBy !== null || call.undoOf !== null) return null;
  const grant = store.subagentGrant(call.subagent, call.tool);
  const undo = grant?.rules[call.action]?.undo;
  return undo !== undefined && grant!.actions.some(one => one.name === undo) ? undo : null;
}

/** The last seven days (or since a time) for one subagent. */
export function weekOf(store: Store, mate: SubagentRow, now: Date, since: string = new Date(now.getTime() - WEEK_MS).toISOString()): Week {
  const turns = store.subagentTurns(mate.id, since);
  const costs = turns.map(one => one.costUsd).filter((one): one is number => one !== null);
  const events = store.subagentEvents(mate.id, 5000, since);
  const count = (kind: string) => events.filter(one => one.kind === kind).length;
  const calls = store.subagentCallsOf(mate.id, 5000, since).filter(one => one.undoOf === null);
  const hrefOf = (card: number | null) => { const found = card === null ? null : store.getFlowCard(card); return found === null ? null : flowCardHref(found.flow, found.id); };
  const name = nameOf(mate);
  const denied = calls.filter(one => one.state === "denied").map(one => {
    const words = store.subagentQuestionForCall(one.id)?.answer;
    return { said: `${one.decidedBy ?? "Someone"} turned down ${callWords(one.tool, one.action, one.input, 160)}${words ? `: “${words.slice(0, 160)}”` : ""}`, at: one.decidedAt ?? one.createdAt, href: hrefOf(one.card) };
  });
  const moved = store.flowMovesOverridden(`${name} (AI)`, since).map(one => ({ said: `${one.by} moved “${one.title.slice(0, 80)}” after ${name} did`, at: one.at, href: flowCardHref(one.flow, one.card) }));
  return {
    since, turns: turns.length, failedTurns: turns.filter(one => !one.ok).length, costUsd: costs.length === 0 ? null : Math.round(costs.reduce((sum, one) => sum + one, 0) * 1e6) / 1e6,
    minutes: Math.round(turns.reduce((sum, one) => sum + one.ms, 0) / 60_000),
    decided: count("decided"), handled: count("handled"), handed: count("handed"), asked: count("asked"),
    calls: { made: calls.filter(one => one.state === "done" || one.state === "failed").length, approved: calls.filter(one => one.decidedBy !== null && one.state !== "denied" && one.state !== "refused").length,
      denied: calls.filter(one => one.state === "denied").length, refused: calls.filter(one => one.state === "refused").length, undone: calls.filter(one => one.undoneBy !== null).length },
    overrides: [...denied, ...moved].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20),
    undoable: calls.flatMap(one => { const undo = undoFor(store, one); return undo === null ? [] : [{ call: one.id, words: callWords(one.tool, one.action, one.input, 200), undo, at: one.createdAt, href: hrefOf(one.card) }]; }).reverse().slice(0, 20),
  };
}

/** The week in words its manager reads at a glance. */
export function weekWords(mate: SubagentRow, week: Week): string {
  const name = nameOf(mate);
  const quiet = week.turns === 0 && week.decided + week.handled + week.handed + week.asked + week.calls.made === 0;
  if (quiet) return `${name} had nothing to do this week.`;
  const lines = [
    `${name} decided ${week.decided}, handled ${week.handled}, handed ${week.handed} to people and asked ${week.asked} question${week.asked === 1 ? "" : "s"}.`,
    `Tool calls: ${week.calls.made} made${week.calls.approved > 0 ? ` (${week.calls.approved} after a person approved)` : ""}${week.calls.denied > 0 ? `, ${week.calls.denied} turned down` : ""}${week.calls.refused > 0 ? `, ${week.calls.refused} outside its rules` : ""}${week.calls.undone > 0 ? `, ${week.calls.undone} undone` : ""}.`,
    `${week.turns} turn${week.turns === 1 ? "" : "s"}${week.failedTurns > 0 ? ` (${week.failedTurns} failed)` : ""}, about ${week.minutes} minute${week.minutes === 1 ? "" : "s"} of thinking${week.costUsd === null ? "" : `, ${money(week.costUsd)} at API prices`}.`,
    ...(week.overrides.length === 0 ? ["Nobody overrode it."] : [`You overrode it ${week.overrides.length} time${week.overrides.length === 1 ? "" : "s"}:`, ...week.overrides.slice(0, 5).map(one => `• ${one.said}`)]),
  ];
  return lines.join("\n");
}

/** Each Monday from 9:00 (this computer's time), the week's report to each active subagent's manager, once; or now, for one. */
export function sendSubagentWeeklies(store: Store, repo: string, now: Date, only: number | null = null): number {
  const monday = new Date(now); monday.setHours(9, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  let sent = 0;
  for (const mate of store.subagents([repo])) {
    // One a week, from Monday 9:00; a subagent that joined since then has its first next Monday.
    if (only !== null ? mate.id !== only : mate.state !== "active" || now < monday || (mate.weeklyAt ?? mate.createdAt) >= monday.toISOString()) continue;
    store.updateSubagent(mate.id, { weeklyAt: now.toISOString() }, "weekly", now);
    const week = weekOf(store, mate, now);
    if (week.turns === 0 && only === null) continue;
    store.enqueueNotification({ dedupeKey: `teammate-weekly:${mate.id}:${now.toISOString().slice(0, only === null ? 10 : 19)}`, kind: "teammate-weekly", recipient: mate.manager,
      subject: `${labelOf(mate)}: the week`, body: weekWords(mate, week), link: `/settings/lead/subagents/${mate.id}#week`, source: { project: repo } }, now);
    sent++;
  }
  return sent;
}

/**
 * A person asks to undo one of its tool calls with the action its manager
 * named: the undo call is recorded at once (the same input, as them), and
 * made by finishUndo — right away on the page, or by the worker's next pass
 * when it was asked for in chat. Both calls keep their receipts.
 */
export function requestUndo(store: Store, mate: SubagentRow, id: number, by: string, now: Date): { ok: true; call: number; said: string } | { ok: false; said: string } {
  const call = store.subagentCall(id);
  if (call === null || call.subagent !== mate.id) return { ok: false, said: "No such call." };
  const undo = undoFor(store, call);
  if (undo === null) return { ok: false, said: call.undoneBy !== null ? `${call.undoneBy} already undid it.` : "That call can't be undone here." };
  return store.transact(() => {
    if (!store.markSubagentCallUndone(call.id, by, now)) return { ok: false as const, said: "Someone undid it just now." };
    const made = store.addSubagentCall({ subagent: mate.id, card: call.card, entry: call.entry, tool: call.tool, action: undo, input: call.input, rule: "free",
      why: `${by} undid ${call.action} (call ${call.id}).`, state: "approved", undoOf: call.id, decidedBy: by }, now);
    return { ok: true as const, call: made, said: `Undoing it with ${undo}.` };
  });
}

/** Make a requested undo call; if the tool says it failed, the original call stands (and can be undone again). */
export async function finishUndo(store: Store, id: number, io: ToolIo, now: Date): Promise<Done> {
  const pending = store.subagentCall(id);
  const mate = pending === null ? null : store.getSubagent(pending.subagent);
  if (pending === null || mate === null || pending.undoOf === null || pending.state !== "approved") return { ok: false, said: "That undo was already made." };
  const made = await makeCall(store, pending, mate.repo, io, now, { byPerson: true });
  if (made.state === "done") return { ok: true, said: `Undone: ${callWords(made.tool, made.action, made.input, 120)}. ${made.result ?? ""}`.trim() };
  store.clearSubagentCallUndone(pending.undoOf, now);
  return { ok: false, said: `The undo call failed: ${made.result ?? "no answer"}. The original call stands.` };
}

/** The worker's pass: undo calls asked for in chat, made now. */
export async function runRequestedUndos(store: Store, io: ToolIo, now: Date): Promise<number> {
  let made = 0;
  for (const call of store.pendingSubagentUndos()) { await finishUndo(store, call.id, io, now); made++; }
  return made;
}

/** Undo, on the page: asked for and made at once. */
export async function undoCall(store: Store, mate: SubagentRow, id: number, by: string, io: ToolIo, now: Date): Promise<Done> {
  const asked = requestUndo(store, mate, id, by, now);
  return asked.ok ? finishUndo(store, asked.call, io, now) : asked;
}
