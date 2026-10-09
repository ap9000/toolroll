/**
 * Flow insights (v84): how work moves through a flow and where it breaks,
 * read from what the flow already records — every card's moves (flow_event)
 * and every script or update step's run (flow_step_run, with its log). No
 * model, no sampling: counts over a window, per zone and per script.
 */
import { flowDefinitionOf } from "./flow-engine.js";
import { parseSortDecision } from "./flow-sort.js";
import type { FlowStage } from "./flows.js";
import type { FlowRow, FlowStepRunRow, Store } from "./store.js";

export type ZoneInsight = {
  zone: string; title: string; kind: string;
  /** Cards that arrived in the window, and what happened next. */
  entered: number; movedOn: number; failed: number; sentBack: number;
  /** Cards sitting there now. */
  here: number;
  /** The middle of how long cards stayed before moving on, in minutes. */
  typicalMinutes: number | null;
  lastProblem: { card: number; cardTitle: string; note: string | null; at: string } | null;
};
export type ScriptInsight = { script: string; runs: number; passed: number; failed: number; typicalSeconds: number | null; lastFailure: string | null };
/**
 * How a sort zone is doing, from what people did after it: a card a person
 * moved to where a different answer leads was sorted wrong; one that moved
 * on from where Jev sent it was sorted right; a not-sure card a person
 * placed says what the answer should have been. Cards nobody has touched
 * since are not counted either way.
 */
export type SortInsight = {
  zone: string; title: string; sureAt: number;
  sorted: number; alone: number; notSure: number; corrected: number;
  /** How often Jev was right, by how sure it was: [from, to) in whole percents. */
  bands: { from: number; to: number; right: number; of: number }[];
  costUsd: number;
  suggestion: string | null;
};
export type StepRunInsight = {
  card: number; cardTitle: string; entry: number; zone: string; zoneTitle: string; kind: "check" | "update" | "sort" | "draft" | "request" | "email" | "tool" | "subagent";
  script: string | null; version: number | null; state: FlowStepRunRow["state"]; result: string | null; exitCode: number | null; durationMs: number | null; at: string; hasLog: boolean;
};
export type FlowInsights = {
  flow: number; name: string; days: number;
  cards: { started: number; finished: number; active: number };
  zones: ZoneInsight[];
  /** The zones that fail or send work back most, worst first. */
  breaks: { zone: string; title: string; problems: number; of: number }[];
  scripts: ScriptInsight[];
  sorts: SortInsight[];
  runs: StepRunInsight[];
  /** A plane review's problems, the ones seen on the most days first: which causes keep coming back. */
  recurring: RecurringProblem[];
};
export type RecurringProblem = { problem: string; title: string; days: number; lastSeen: string; card: number | null };

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** One flow's insights over the last `days` days. */
export function flowInsights(store: Store, flow: FlowRow, now: Date, days = 30): FlowInsights {
  const since = new Date(now.getTime() - days * 86_400_000);
  const definition = flowDefinitionOf(flow);
  const stages = definition?.stages ?? [];
  const titleOf = (id: string) => stages.find(one => one.id === id)?.title ?? id;
  const cards = store.flowCards(flow.id, true);
  const cardTitle = (id: number) => cards.find(one => one.id === id)?.title ?? `card ${id}`;
  const zones = new Map<string, ZoneInsight & { stays: number[] }>(stages.map(stage => [stage.id, {
    zone: stage.id, title: stage.title, kind: stage.kind, entered: 0, movedOn: 0, failed: 0, sentBack: 0,
    here: cards.filter(card => card.state === "active" && card.stage === stage.id).length, typicalMinutes: null, lastProblem: null, stays: [],
  }]));
  const moves = store.flowMoves(flow.id, since);
  const byCard = new Map<number, typeof moves>();
  for (const move of moves) byCard.set(move.card, [...byCard.get(move.card) ?? [], move]);
  for (const [card, list] of byCard) list.forEach((move, index) => {
    const arrived = zones.get(move.toStage);
    if (arrived !== undefined) {
      arrived.entered++;
      const next = list[index + 1];
      if (next !== undefined) arrived.stays.push((Date.parse(next.at) - Date.parse(move.at)) / 60_000);
    }
    const left = move.fromStage === null ? undefined : zones.get(move.fromStage);
    if (left === undefined) return;
    if (move.outcome === "fail" || move.outcome === "sent-back") {
      if (move.outcome === "fail") left.failed++; else left.sentBack++;
      left.lastProblem = { card, cardTitle: cardTitle(card), note: move.note, at: move.at };
    } else if (move.outcome !== "cancelled") left.movedOn++;
  });
  const zoneList = [...zones.values()].map(({ stays, ...zone }) => ({ ...zone, typicalMinutes: median(stays) === null ? null : Math.round(median(stays)! * 10) / 10 }));
  const doneZones = new Set(stages.filter(one => one.kind === "done").map(one => one.id));
  const runs = store.flowStepRuns(flow.id, since, 200);
  const scripts = new Map<string, { runs: number; passed: number; failed: number; durations: number[]; lastFailure: string | null }>();
  for (const run of runs) {
    if (run.script === null || (run.state !== "passed" && run.state !== "failed")) continue;
    const entry = scripts.get(run.script) ?? { runs: 0, passed: 0, failed: 0, durations: [], lastFailure: null };
    entry.runs++;
    if (run.state === "passed") entry.passed++; else { entry.failed++; entry.lastFailure ??= run.result; }
    if (run.durationMs !== null) entry.durations.push(run.durationMs / 1000);
    scripts.set(run.script, entry);
  }
  const sorts = stages.filter(one => one.kind === "sort" && one.sort !== null).map(stage => sortInsight(stage, runs, byCard));
  return {
    flow: flow.id, name: flow.name, days,
    cards: {
      started: moves.filter(one => one.outcome === "created").length,
      finished: new Set(moves.filter(one => doneZones.has(one.toStage)).map(one => one.card)).size,
      active: cards.filter(one => one.state === "active").length,
    },
    zones: zoneList,
    breaks: zoneList.filter(one => one.failed + one.sentBack > 0).sort((a, b) => (b.failed + b.sentBack) - (a.failed + a.sentBack)).slice(0, 3)
      .map(one => ({ zone: one.zone, title: one.title, problems: one.failed + one.sentBack, of: Math.max(one.entered, one.failed + one.sentBack) })),
    scripts: [...scripts].map(([script, one]) => ({ script, runs: one.runs, passed: one.passed, failed: one.failed, typicalSeconds: median(one.durations) === null ? null : Math.round(median(one.durations)!), lastFailure: one.lastFailure })),
    sorts,
    recurring: recurringProblems(store, flow, since),
    runs: runs.slice(0, 40).map(run => ({
      card: run.card, cardTitle: run.cardTitle, entry: run.entry, zone: run.stage, zoneTitle: titleOf(run.stage), kind: run.kind, script: run.script, version: run.scriptVersion,
      state: run.state, result: run.result, exitCode: run.exitCode, durationMs: run.durationMs, at: run.finishedAt ?? run.startedAt, hasLog: run.log !== null && run.log !== "",
    })),
  };
}

/** Each problem a plane review trigger of this flow noted in the window (one note per problem a day), and on how many days. */
function recurringProblems(store: Store, flow: FlowRow, since: Date): RecurringProblem[] {
  const rows = store.handle.prepare(`SELECT e.key, e.card, e.at, c.title FROM flow_trigger_event e JOIN flow_trigger t ON t.id = e.trigger LEFT JOIN flow_card c ON c.id = e.card
    WHERE t.flow = ? AND json_extract(t.config_json, '$.kind') = 'plane-review' AND substr(e.key, 1, 6) = 'plane:' AND e.at >= ? ORDER BY e.rowid`).all(flow.id, since.toISOString());
  const problems = new Map<string, RecurringProblem>();
  for (const row of rows) {
    const match = /^plane:(.+):(\d{4}-\d{2}-\d{2})$/.exec(String(row["key"]));
    if (match === null) continue;
    const had = problems.get(match[1]!);
    const card = row["card"] === null ? had?.card ?? null : Number(row["card"]);
    problems.set(match[1]!, { problem: match[1]!, title: row["title"] === null ? had?.title ?? match[1]! : String(row["title"]), days: (had?.days ?? 0) + 1, lastSeen: match[2]!, card });
  }
  return [...problems.values()].sort((a, b) => b.days - a.days || b.lastSeen.localeCompare(a.lastSeen)).slice(0, 20);
}

const BANDS = [[90, 101], [80, 90], [70, 80], [50, 70]] as const;
type Move = { card: number; fromStage: string | null; toStage: string; outcome: string; actor: string; at: string };

function sortInsight(stage: FlowStage, runs: ReturnType<Store["flowStepRuns"]>, byCard: Map<number, Move[]>): SortInsight {
  const sort = stage.sort!;
  const targets = new Set(sort.answers.map(one => one.to));
  const bands = BANDS.map(([from, to]) => ({ from, to: Math.min(to, 100), right: 0, of: 0 }));
  const insight: SortInsight = { zone: stage.id, title: stage.title, sureAt: sort.sureAt, sorted: 0, alone: 0, notSure: 0, corrected: 0, bands, costUsd: 0, suggestion: null };
  for (const run of runs) {
    if (run.kind !== "sort" || run.stage !== stage.id || run.state !== "passed") continue;
    const decision = parseSortDecision(run.decisionJson);
    if (decision === null) continue;
    insight.sorted++;
    if (decision.confident) insight.alone++; else insight.notSure++;
    insight.costUsd += decision.cost ?? 0;
    // Where the sort sent the card, and what happened to it next.
    const moves = byCard.get(run.card) ?? [];
    const sent = moves.findIndex(one => one.fromStage === stage.id && one.actor === "flow" && one.at >= run.startedAt);
    const after = sent === -1 ? undefined : moves[sent + 1];
    const picked = sort.answers.find(one => one.answer === decision.answer)?.to ?? null;
    let right: boolean | null = null;
    if (after !== undefined && after.actor !== "flow" && after.outcome === "moved" && targets.has(after.toStage)) {
      // A person placed it where an answer leads: that is what the answer should have been.
      right = after.toStage === picked;
      if (decision.confident && !right) insight.corrected++;
    } else if (decision.confident && after !== undefined) right = true;
    if (right === null) continue;
    const band = bands.find(one => decision.sure * 100 >= one.from && decision.sure * 100 < (one.to === 100 ? 101 : one.to));
    if (band !== undefined) { band.of++; if (right) band.right++; }
  }
  insight.costUsd = Math.round(insight.costUsd * 1_000_000) / 1_000_000;
  // Say so only with enough cards behind it.
  const at = Math.round(sort.sureAt * 100);
  const below = bands.find(one => one.to <= at && one.to > at - 15 && one.of >= 5);
  const above = bands.filter(one => one.from >= at && one.of >= 5);
  const shaky = above.find(one => one.right / one.of < 0.8);
  if (shaky !== undefined) insight.suggestion = `Jev was wrong on ${shaky.of - shaky.right} of ${shaky.of} cards it sent on alone at ${shaky.from}–${shaky.to}% sure. Consider asking for ${Math.min(95, shaky.to)}%.`;
  else if (below !== undefined && below.right / below.of >= 0.9) insight.suggestion = `Cards Jev was ${below.from}–${below.to}% sure about were right ${below.right} of ${below.of} times. You could let it act alone from ${below.from}%.`;
  return insight;
}

/** One line for a flow's list entry: where it has had the most trouble lately. */
export function troubleWords(insights: FlowInsights): string | null {
  const worst = insights.breaks[0];
  return worst === undefined ? null : `most trouble in ${worst.title} (${worst.problems} of ${worst.of} in the last ${insights.days} days)`;
}
