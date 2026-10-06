/**
 * Sort steps (v85): Jev, TypeSafe's decision model, reached through
 * OpenRouter's Decisions API with the operator's own OpenRouter key. One
 * request per card: the card is the `state`; the zone's question is a
 * choice over its answers, and each thing the zone also notes is a score
 * or a yes/no question in the same request. Jev answers in well under a
 * second, with how sure it is. It never writes text, so nothing it returns
 * is instructions: an answer is only ever one of the zone's own options.
 */
import { redactSecretLines, scanForSecrets } from "./evidence.js";
import { SORT_ROUTE_KEY, sortKeyOf, sortNoteKeyOf } from "./contracts/flow.js";
import { readJevReply, type SortDecision, type SortNoteAnswer } from "./contracts/sort-answer.js";
import type { FlowSort, FlowStage } from "./flows.js";

export const JEV_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "~typesafe/jev-latest";
/** Jev reads up to 32,000 tokens; the card is kept well under that. */
const STATE_CHARS = 40_000;

export type { SortDecision, SortNoteAnswer } from "./contracts/sort-answer.js";

export type SortCard = { title: string; description: string | null; note: string | null; outputs: Record<string, string>; source: { label: string } | null };
type Question = { type: "choice"; instructions: string; criteria: Record<string, string> } | { type: "score"; instructions: string; criteria: string[] } | { type: "noul"; instructions: string };
export type JevRequest = { model: string; state: Record<string, string>; questions: Record<string, Question> };

const clip = (text: string, cap: number) => text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
/** Key-shaped lines never leave the machine. */
const blank = (text: string) => redactSecretLines(text, scanForSecrets(text));

/** What Jev reads: the card, where it came from, the latest note and what earlier zones reported — bounded, keys blanked. */
export function sortState(card: SortCard, earlier: readonly { id: string; title: string }[]): Record<string, string> {
  const state: Record<string, string> = { title: blank(clip(card.title, 500)) };
  if (card.description !== null && card.description.trim() !== "") state["details"] = blank(clip(card.description, 20_000));
  if (card.source !== null) state["came_from"] = clip(card.source.label, 200);
  if (card.note !== null && card.note.trim() !== "") state["latest_note"] = blank(clip(card.note, 2000));
  let room = STATE_CHARS - Object.values(state).reduce((sum, one) => sum + one.length, 0);
  for (const zone of earlier) {
    const said = card.outputs[zone.id];
    if (said === undefined || said.trim() === "" || room < 200) continue;
    const kept = blank(clip(said, Math.min(8000, room)));
    state[`notes_from_${zone.id.replace(/-/g, "_")}`] = kept;
    room -= kept.length;
  }
  return state;
}

/** The one request for a card: the zone's question over its answers, plus what it also notes. */
export function sortRequest(sort: FlowSort, state: Record<string, string>): JevRequest {
  const questions: Record<string, Question> = {
    [SORT_ROUTE_KEY]: { type: "choice", instructions: `${sort.question} Read the card's title and details.`, criteria: Object.fromEntries(sort.answers.map(one => [sortKeyOf(one.answer), one.means])) },
  };
  for (const note of sort.notes) {
    questions[sortNoteKeyOf(note.id)] = note.kind === "score" && note.levels !== null
      ? { type: "score", instructions: note.question, criteria: note.levels }
      : { type: "noul", instructions: note.question };
  }
  return { model: JEV_MODEL, state, questions };
}

export type JevAsked = { ok: true; body: Record<string, unknown>; ms: number } | { ok: false; said: string };

/** Ask Jev through OpenRouter. Trouble reaching it (or a refused key, or no credit) is a reason to try again, in words. */
export async function askJev(fetcher: typeof fetch, key: string, request: JevRequest): Promise<JevAsked> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetcher(JEV_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Toolroll" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, said: "Couldn't reach OpenRouter." };
  }
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; } catch { /* said below */ }
  if (!response.ok) {
    const error = body["error"] as { message?: unknown } | undefined;
    const detail = typeof error?.message === "string" ? ` It said: ${clip(error.message.replace(/\s+/g, " "), 160)}` : "";
    const said = response.status === 401 || response.status === 403 ? "OpenRouter didn't accept the key. Check it in Settings → AI providers."
      : response.status === 402 ? "OpenRouter says the account is out of credit."
      : response.status === 404 ? "OpenRouter couldn't find Jev for this key."
      : response.status === 429 ? "OpenRouter asked us to slow down."
      : `OpenRouter answered with an error (${response.status}).`;
    return { ok: false, said: `${said}${detail}` };
  }
  return { ok: true, body, ms: Date.now() - started };
}

const shortLevel = (level: string) => level.split(":")[0]!.trim();

/**
 * Jev's answers, read through the reply's contract (src/contracts/sort-answer.ts) and then against the zone's own
 * options only; anything else is a problem, never a route. Confidences and chances are clamped into 0–1.
 */
export function readJevAnswers(stage: FlowStage, body: Record<string, unknown>, ms: number): SortDecision | { problem: string } {
  const sort = stage.sort!;
  const read = readJevReply(body);
  if (!read.ok) return { problem: `Jev's answer didn't say which way to go (${read.issues.map(issue => issue.line).join("; ")}).` };
  const reply = read.value;
  const route = reply.answers[SORT_ROUTE_KEY];
  const picked = sort.answers.find(one => sortKeyOf(one.answer) === route.choice);
  if (picked === undefined) return { problem: "Jev picked an answer this zone doesn't have." };
  const number = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const sure = number(route.confidence);
  const probabilities = route.probabilities ?? {};
  const chances = Object.fromEntries(sort.answers.map(one => [one.answer, Math.round(number(probabilities[sortKeyOf(one.answer)]) * 100) / 100]));
  const notes: SortNoteAnswer[] = [];
  for (const note of sort.notes) {
    const said = reply.answers[sortNoteKeyOf(note.id)];
    if (said === undefined) continue;
    if (note.kind === "score" && note.levels !== null && said.score !== undefined) {
      const level = note.levels[Math.min(note.levels.length - 1, Math.max(0, Math.round(said.score)))]!;
      notes.push({ id: note.id, question: note.question, kind: "score", answer: level, sure: Math.round(number(said.confidence) * 100) / 100 });
    } else if (said.noul !== undefined) {
      const yes = number(said.noul);
      notes.push({ id: note.id, question: note.question, kind: "yes-no", answer: yes >= 0.5 ? "yes" : "no", sure: Math.round(Math.max(yes, 1 - yes) * 100) / 100 });
    }
  }
  const confident = sure >= sort.sureAt;
  return {
    model: reply.model ?? JEV_MODEL,
    answer: picked.answer, sure: Math.round(sure * 100) / 100, sureAt: sort.sureAt,
    confident, to: confident ? picked.to : stage.onFail, chances, notes,
    cost: reply.usage?.cost ?? null, ms,
  };
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The decision in one line, as the card and later zones read it ({{stage.<id>}}). */
export function sortWords(decision: SortDecision): string {
  const lead = decision.confident ? `${decision.answer}, ${percent(decision.sure)} sure.` : `Not sure: ${percent(decision.sure)} ${decision.answer}.`;
  const notes = decision.notes.map(one => one.kind === "score" ? `${one.question} ${shortLevel(one.answer)}.` : `${one.question} ${one.answer === "yes" ? "Yes" : "No"}.`);
  return [lead, ...notes].join(" ");
}

/** The run's log: every answer's chance and each note, for the Insights run view. */
export function sortLog(stage: FlowStage, decision: SortDecision): string {
  const lines = [`Jev (${decision.model}) · ${decision.ms} ms${decision.cost === null ? "" : ` · $${decision.cost.toFixed(6)}`}`, "", stage.sort!.question];
  for (const [answer, chance] of Object.entries(decision.chances).sort((a, b) => b[1] - a[1])) lines.push(`  ${answer.padEnd(24)} ${percent(chance).padStart(4)}${answer === decision.answer ? "  ← picked" : ""}`);
  lines.push(`  Sure: ${percent(decision.sure)} (acts alone from ${percent(decision.sureAt)})`);
  for (const note of decision.notes) lines.push("", note.question, `  ${note.answer} (${percent(note.sure)} sure)`);
  return lines.join("\n");
}

/** A kept decision, or null when there is none or it can't be read. */
export function parseSortDecision(json: string | null): SortDecision | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as SortDecision;
    return typeof value.answer === "string" && typeof value.sure === "number" ? value : null;
  } catch { return null; }
}

/** A card's chip on the canvas: the answer and how sure, and the first score's short level. */
export function sortChip(decision: SortDecision): string {
  const score = decision.notes.find(one => one.kind === "score");
  return [`${decision.answer} · ${percent(decision.sure)}`, ...(score === undefined ? [] : [shortLevel(score.answer)])].join(" · ");
}
