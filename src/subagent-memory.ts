/**
 * What a subagent remembers (v95), and how it learns from its people.
 *
 * Memory is short facts, each a line: what its people told it ("this week,
 * offer free shipping instead of a refund" — v92's notes), and what it kept
 * from its own turns ("Sam prefers email to phone"). Every turn reads what
 * its people said lately, and what it kept that fits the card. People search,
 * edit and forget any of it on the subagent's page or through the lead.
 *
 * Learning: when its manager approves the same ask-first tool action again
 * and again (five in a row, none denied), the subagent suggests loosening
 * that one rule — "You approved my last 5 refunds (amount 55 to 70): may I
 * make them on my own up to 75?" — as a question its manager accepts or
 * not, in their chat app or on its page. Accepting changes only that rule,
 * and only if it is still what it was when suggested.
 */
import { scanForSecrets } from "./evidence.js";
import { notifyPeople } from "./flow-people.js";
import type { Store, SubagentCallRow, SubagentMemoryRow, SubagentRow, ToolRule } from "./store.js";
import { labelOf, nameOf } from "./subagent-admin.js";
import { defaultRule, numberFields, setToolRules } from "./subagent-tools.js";

export const MEMORY_CHARS = 300;
/** Facts a subagent keeps on its own: past this, its oldest are forgotten. What people told it is never dropped this way. */
export const MEMORY_CAP = 300;
/** Approvals in a row of one action before the subagent suggests loosening its rule. */
export const SUGGEST_AFTER = 5;
export const ACCEPT = "accept", DISMISS = "dismiss";

type Done = { ok: true; said: string } | { ok: false; said: string };

const STOP = new Set("about after again also been before being could does doing from have here into just like more most much must only other over same some such than that their them then there these they this those through very want were what when where which while will with would your yours please thanks thank hello".split(" "));

/** The words a text is about: lower case, four letters or more, no filler. */
export function wordsOf(text: string): string[] {
  return [...new Set(text.toLowerCase().normalize("NFKD").split(/[^\p{L}\p{N}]+/u).filter(one => one.length >= 4 && !STOP.has(one)))].slice(0, 60);
}

/** Two lines about the same thing: most of their words are shared. */
export function similar(a: string, b: string): boolean {
  const left = new Set(wordsOf(a)), right = new Set(wordsOf(b));
  if (left.size === 0 || right.size === 0) return false;
  const shared = [...left].filter(one => right.has(one)).length;
  return shared / new Set([...left, ...right]).size >= 0.6;
}

/** A memory as it may be kept: one line, plain, short, no secrets. */
export function cleanMemory(text: string): { ok: true; text: string } | { ok: false; said: string } {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (line === "") return { ok: false, said: "Write what it should remember." };
  if (line.length > MEMORY_CHARS) return { ok: false, said: `Keep a memory to ${MEMORY_CHARS} characters; put lasting rules in its soul file.` };
  if (scanForSecrets(line).length > 0) return { ok: false, said: "That looks like a key or password. Keep secrets out of a subagent's memory." };
  return { ok: true, text: line };
}

/** Keep one thing: from a person (what they told it), or from the subagent itself on a turn. The same words twice are kept once. */
export function remember(store: Store, mate: SubagentRow, text: string, from: { source: SubagentMemoryRow["source"]; card?: number | null; by: string }, now: Date): Done & { id?: number } {
  const clean = cleanMemory(from.source === "subagent" ? text.slice(0, MEMORY_CHARS) : text);
  if (!clean.ok) return clean;
  const same = store.subagentMemories(mate.id).find(one => one.text.toLowerCase() === clean.text.toLowerCase());
  if (same !== undefined) return { ok: true, said: `${nameOf(mate)} already remembers that.`, id: same.id };
  // Saying nearly the same thing again on the same card (another turn of the same visit) refreshes what it kept instead of adding a second line.
  if (from.source === "subagent" && from.card !== undefined && from.card !== null) {
    const near = store.subagentMemories(mate.id, { source: "subagent" }).find(one => one.card === from.card && similar(one.text, clean.text));
    if (near !== undefined) {
      store.editSubagentMemory(near.id, clean.text, from.by, now);
      return { ok: true, said: `${nameOf(mate)} already remembers that.`, id: near.id };
    }
  }
  const id = store.addSubagentMemory({ subagent: mate.id, text: clean.text, source: from.source, card: from.card ?? null, by: from.by }, now);
  if (from.source === "subagent") for (const old of store.subagentMemories(mate.id, { source: "subagent" }).slice(MEMORY_CAP)) store.forgetSubagentMemory(old.id, "limit", now);
  return { ok: true, said: `${nameOf(mate)} will remember that.`, id };
}

/** Something a person tells a subagent (the page's "Tell Maya something", or the lead): kept in its memory, read by every turn while it's among the latest ten. */
export function tellSubagent(store: Store, mate: SubagentRow, note: string, by: string, now: Date): Done {
  const kept = remember(store, mate, note, { source: "person", by }, now);
  return kept.ok ? { ok: true, said: `${nameOf(mate)} will keep that in mind.` } : kept;
}

export function editMemory(store: Store, mate: SubagentRow, id: number, text: string, by: string, now: Date): Done {
  const memory = store.subagentMemory(id);
  if (memory === null || memory.subagent !== mate.id) return { ok: false, said: "It doesn't remember that any more." };
  const clean = cleanMemory(text);
  if (!clean.ok) return clean;
  store.editSubagentMemory(id, clean.text, by, now);
  return { ok: true, said: "Saved." };
}

export function forgetMemory(store: Store, mate: SubagentRow, id: number, by: string, now: Date): Done {
  const memory = store.subagentMemory(id);
  if (memory === null || memory.subagent !== mate.id) return { ok: false, said: "It doesn't remember that any more." };
  store.forgetSubagentMemory(id, by, now);
  return { ok: true, said: `${nameOf(mate)} forgot it.` };
}

/** Memories whose text holds every word searched for. */
export function searchMemories(store: Store, mate: SubagentRow, query: string): SubagentMemoryRow[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}$]+/u).filter(one => one.length >= 2);
  return store.subagentMemories(mate.id, { words, limit: 100 });
}

/**
 * What one turn reads: what its people told it lately (oldest first), and
 * what it kept that fits the card — the facts sharing most of the card's
 * words, then its newest — up to eight.
 */
export function memoriesFor(store: Store, mate: SubagentRow, cardText: string, now: Date): { told: SubagentMemoryRow[]; kept: SubagentMemoryRow[] } {
  const told = store.subagentMemories(mate.id, { source: "person", limit: 10 }).reverse();
  const own = store.subagentMemories(mate.id, { source: "subagent", limit: MEMORY_CAP });
  const words = wordsOf(cardText);
  const scored = own.map(one => ({ one, score: words.filter(word => one.text.toLowerCase().includes(word)).length })).filter(one => one.score > 0)
    .sort((a, b) => b.score - a.score || b.one.id - a.one.id).slice(0, 6).map(one => one.one);
  const kept = [...scored, ...own.filter(one => !scored.includes(one))].slice(0, 8);
  store.markSubagentMemoriesUsed(kept.map(one => one.id), now);
  return { told, kept };
}

const numberOf = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value
  : typeof value === "string" && /^\s*\$?\d+(\.\d+)?\s*$/.test(value) ? Number(value.replace(/[$\s]/g, "")) : null;
/** A limit a person would pick: rounded up to a round number. */
export const roundUp = (value: number) => { const step = value < 20 ? 1 : value < 100 ? 5 : value < 1000 ? 25 : 100; return Math.ceil(value / step) * step; };

/**
 * After a person approves an ask-first call: when they have approved this
 * action enough times in a row since it last suggested anything about it,
 * the subagent suggests the rule that would have let it make them all.
 */
export function considerSuggestion(store: Store, mate: SubagentRow, approved: SubagentCallRow, now: Date): number | null {
  const grant = store.subagentGrant(mate.id, approved.tool);
  const info = grant?.actions.find(one => one.name === approved.action);
  if (grant === null || info === undefined) return null;
  const rule = grant.rules[approved.action] ?? defaultRule(info);
  if (rule.use === "never" || (rule.use === "free" && rule.limit === undefined)) return null;
  const earlier = store.subagentSuggestionsFor(mate.id, approved.tool, approved.action);
  if (earlier.some(one => one.state === "open")) return null;
  const since = earlier[0]?.createdAt ?? "";
  const run: SubagentCallRow[] = [];
  for (const call of store.subagentCallsOf(mate.id, 400).filter(one => one.tool === approved.tool && one.action === approved.action && one.rule === "ask" && one.decidedBy !== null && (one.decidedAt ?? "") > since)) {
    if (call.state === "denied") break;
    run.push(call);
  }
  if (run.length < SUGGEST_AFTER) return null;
  // The number the rule is limited on (or, with none, the one every approved call gave).
  const field = rule.limit?.field ?? numberFields(info).find(name => run.every(call => numberOf(call.input[name]) !== null)) ?? null;
  const values = field === null ? [] : run.map(call => numberOf(call.input[field])).filter((one): one is number => one !== null);
  let suggested: ToolRule, range = "";
  if (field !== null && values.length === run.length) {
    const over = roundUp(Math.max(...values));
    if (rule.limit !== undefined && over <= rule.limit.over) return null;
    suggested = { use: "free", limit: { field, over } };
    const low = Math.min(...values), high = Math.max(...values);
    range = ` (${field} ${low === high ? low : `${low} to ${high}`})`;
  } else {
    suggested = { use: "free" };
  }
  const card = store.getFlowCard(approved.card);
  if (card === null) return null;
  const said = suggested.limit === undefined
    ? `You approved my last ${run.length} ${approved.action} calls on ${approved.tool}. May I make them on my own from now on?`
    : `You approved my last ${run.length} ${approved.action} calls on ${approved.tool}${range}. May I make them on my own up to ${suggested.limit.field} ${suggested.limit.over}, and ask you above that?`;
  const id = store.addSubagentSuggestion({ subagent: mate.id, tool: approved.tool, action: approved.action, rule: suggested, was: rule, evidence: run.map(one => one.id), said }, now);
  const question = store.openSubagentQuestion({ subagent: mate.id, card: card.id, entry: approved.entry, question: said, options: [{ id: ACCEPT, label: "Yes, change it" }, { id: DISMISS, label: "Not now" }], askedOf: mate.manager, suggestion: id }, now);
  if (question === null) return id;
  notifyPeople(store, card, [mate.manager], null, { key: `teammate-q:${question}`, attention: false, subject: `${labelOf(mate)} suggests a rule change`,
    body: `${said}\n\nThis changes only that one rule; you can change it back on ${nameOf(mate)}'s page.` }, now);
  return id;
}

/** Its manager answers a suggestion: accept changes the one rule (if it is still what it was), anything else leaves it; their words are remembered. */
export function answerSuggestion(store: Store, mate: SubagentRow, suggestion: number, answer: { choice: string | null; text: string | null; by: string }, now: Date): Done {
  const offered = store.subagentSuggestion(suggestion);
  if (offered === null || offered.state !== "open") return { ok: false, said: "That suggestion was already answered." };
  if (answer.choice === ACCEPT) {
    const grant = store.subagentGrant(mate.id, offered.tool);
    const current = grant === null ? null : grant.rules[offered.action] ?? null;
    const { undo: _undo, ...compared } = current ?? { use: "never" as const };
    if (current === null || JSON.stringify(compared) !== JSON.stringify((({ undo: _was, ...rest }) => rest)(offered.was))) {
      store.decideSubagentSuggestion(offered.id, "stale", null, now);
      return { ok: false, said: "Its rules changed since it suggested this, so nothing was changed." };
    }
    const changed = setToolRules(store, mate, offered.tool, { [offered.action]: { use: offered.rule.use, limit: offered.rule.limit ?? null, undo: current.undo ?? "" } }, answer.by, now);
    if (!changed.ok) return changed;
    store.decideSubagentSuggestion(offered.id, "accepted", answer.by, now);
    return { ok: true, said: `Changed. ${nameOf(mate)} makes ${offered.action} calls on its own ${offered.rule.limit === undefined ? "from now on" : `up to ${offered.rule.limit.field} ${offered.rule.limit.over}`}.` };
  }
  store.decideSubagentSuggestion(offered.id, "dismissed", answer.by, now);
  if (answer.text !== null && answer.text.trim() !== "") remember(store, mate, `About ${offered.action} on ${offered.tool}: ${answer.text.trim()}`.slice(0, MEMORY_CHARS), { source: "person", by: answer.by }, now);
  return { ok: true, said: "Left as it is." };
}
