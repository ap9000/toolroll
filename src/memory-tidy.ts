/**
 * Tidying project memory (docs/plans/learning-loops.md, "Tidy-up pass"): proposals to retire, merge or settle entries,
 * with explicit restore. Proposes; never changes. Nothing happens until a person accepts, and every accept re-reads every
 * affected item in one transaction: any difference and the proposal goes stale.
 *
 * - The scheduled pass (a quiet project, at most weekly, 10 entries or more) is deterministic: it takes no analyzer.
 *   A model is asked for contradictions only on a person's request (`proposeTidy` with an analyzer, D4).
 * - The successor chain of a decision is every decision reachable through ordinary supersession and not-undone merges,
 *   and its active tail the active ones in it. Restoring past an active tail, or undoing a merge built on, is refused
 *   until a person reviews the expanded change: a proposal that names every affected item and says what happens to the
 *   tail. Accepting compare-and-sets each one.
 * - Contradictions and a note that keeps failing have no default: a person's choice is required.
 *
 * The only writer of `memory_tidy_proposal` and `decision_merge`. Decisions change only through project-memory.ts, which
 * keeps their revisions and history. A policy path (release-auto.ts EVAL_POLICY). The lead has no tool for any of this.
 */
import { createHash } from "node:crypto";
import { lessonNoteOf, noteAfterwards, watchNote } from "./lesson-notes.js";
import { currentLocalOwner } from "./local-owner.js";
import { lastIncludedWords, memoryUseOf } from "./memory-use.js";
import { personProof } from "./person-proof.js";
import { changeKnowledge, knowledgeView } from "./project-knowledge.js";
import { changeLearning, learningIdentity } from "./project-learning.js";
import { changeDecisionStatus, getDecision, reactivateDecision, recordDecision, refuseLeadMemoryWrite, reindexProjectMemory, retireDecision, type Decision } from "./project-memory.js";
import { scanForSecrets } from "./evidence.js";
import type { Store } from "./store.js";

const DAY_MS = 86_400_000;
export const UNUSED_DAYS = 60, UNUSED_RUNS = 20, FAILING_NOTE = 3, TIDY_MIN_ENTRIES = 10;
export const TIDY_EVERY_MS = 7 * DAY_MS, TIDY_QUIET_MS = DAY_MS;
const MAX_MODEL_PAIRS = 5;
/** What a stale proposal says. */
export const TIDY_STALE = "Changed since proposed. Run Clean up again.";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export type TidyItem =
  | { kind: "decision"; id: number; revision: number; status: string; sha: string }
  | { kind: "reference"; id: string; revision: number; sha: string }
  | { kind: "lesson"; id: number; version: number; sha: string };
export type TidyKind = "retire" | "merge" | "contradiction" | "note-failing" | "restore" | "unmerge";
export type TidyProposal = { id: number; repo: string; kind: TidyKind; items: TidyItem[]; afterText: string | null; rationale: string; evidence: Record<string, unknown>; source: string; status: string; createdAt: string; decidedBy: string | null; titles: Record<string, string> };
type Draft = { kind: TidyKind; items: TidyItem[]; afterText: string | null; rationale: string; evidence: Record<string, unknown>; source: "usage" | "duplicate" | "model" | "note" | "person" };

function proposalOf(store: Store, row: Record<string, unknown>): TidyProposal {
  const items = JSON.parse(String(row["items_json"])) as TidyItem[];
  const titles: Record<string, string> = {};
  for (const item of items) if (item.kind === "decision") { const found = store.handle.prepare("SELECT claim FROM project_decision WHERE id = ?").get(item.id); if (found !== undefined) titles[`decision:${item.id}`] = String(found["claim"]); }
  return { id: Number(row["id"]), repo: String(row["repo"]), kind: String(row["kind"]) as TidyKind, items, afterText: row["after_text"] == null ? null : String(row["after_text"]), rationale: String(row["rationale"]), evidence: JSON.parse(String(row["evidence_json"])) as Record<string, unknown>,
    source: String(row["source"]), status: String(row["status"]), createdAt: String(row["created_at"]), decidedBy: row["decided_by"] == null ? null : String(row["decided_by"]), titles };
}
export function listTidy(store: Store, repo: string, status: "pending" | "all" = "pending"): TidyProposal[] {
  return store.handle.prepare("SELECT * FROM memory_tidy_proposal WHERE repo = ? AND (? = 'all' OR status = ?) ORDER BY id DESC LIMIT 100").all(repo, status, status).map(row => proposalOf(store, row as Record<string, unknown>));
}

// ---- current items -------------------------------------------------------------------------------------------------

function decisionItem(store: Store, repo: string, id: number): TidyItem | null {
  const row = store.handle.prepare("SELECT revision, status, sha FROM project_decision WHERE id = ? AND repo = ?").get(id, repo);
  return row === undefined ? null : { kind: "decision", id, revision: Number(row["revision"]), status: String(row["status"]), sha: String(row["sha"]) };
}
type SavedKnowledge = { revision: number; references: { id: string; title: string; content: string }[] };
function savedKnowledge(store: Store, repo: string): SavedKnowledge {
  const row = store.handle.prepare("SELECT revision, payload FROM project_knowledge WHERE repo = ?").get(repo);
  if (row === undefined) return { revision: 0, references: [] };
  try { return { revision: Number(row["revision"]), references: (JSON.parse(String(row["payload"])) as { references?: SavedKnowledge["references"] }).references ?? [] }; } catch { return { revision: Number(row["revision"]), references: [] }; }
}
const referenceSha = (ref: SavedKnowledge["references"][number]): string => sha(JSON.stringify(ref));
function lessonItem(store: Store, repo: string, id: number): TidyItem | null {
  const row = store.handle.prepare("SELECT version, sha FROM project_lesson WHERE id = ? AND repo = ?").get(id, repo);
  return row === undefined ? null : { kind: "lesson", id, version: Number(row["version"]), sha: String(row["sha"]) };
}
/** Whether an item reads now exactly as it was bound. */
function itemStands(store: Store, repo: string, item: TidyItem): boolean {
  if (item.kind === "decision") { const now = decisionItem(store, repo, item.id); return now !== null && now.kind === "decision" && now.revision === item.revision && now.status === item.status && now.sha === item.sha; }
  if (item.kind === "lesson") { const now = lessonItem(store, repo, item.id); return now !== null && now.kind === "lesson" && now.version === item.version && now.sha === item.sha; }
  const saved = savedKnowledge(store, repo), ref = saved.references.find(one => one.id === item.id);
  return ref !== undefined && saved.revision === item.revision && referenceSha(ref) === item.sha;
}
const itemKey = (item: TidyItem): string => `${item.kind}:${item.id}`;

// ---- finding -------------------------------------------------------------------------------------------------------

const normal = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const dayWords = (iso: string): string => iso.slice(0, 10);

/** Everything the deterministic pass would propose now. Reads only. */
function deterministicDrafts(store: Store, repo: string, now: Date): Draft[] {
  const drafts: Draft[] = [];
  const cutoff = new Date(now.getTime() - UNUSED_DAYS * DAY_MS).toISOString();
  const use = memoryUseOf(store, repo);
  const runs = Number(store.handle.prepare("SELECT COUNT(DISTINCT run) AS n FROM memory_use WHERE repo = ? AND included_at >= ?").get(repo, cutoff)?.["n"] ?? 0);
  const active = store.handle.prepare("SELECT id, claim, decided_at, source_ref FROM project_decision WHERE repo = ? AND status = 'active' ORDER BY id").all(repo);
  /** Unused: a time older than the window, or never given to a run and older than the window. A row with no time is unknown, so no proposal. */
  const unused = (key: string, since: string): boolean => {
    const one = use.get(key);
    if (one === undefined) return since < cutoff;
    return one.lastAt !== null && one.lastAt < cutoff;
  };
  const retire = (item: TidyItem | null, key: string): void => {
    if (item !== null) drafts.push({ kind: "retire", items: [item], afterText: null, rationale: `${lastIncludedWords(use.get(key))}, while ${runs} runs got context in the last ${UNUSED_DAYS} days.`, evidence: { runs, days: UNUSED_DAYS }, source: "usage" });
  };
  if (runs >= UNUSED_RUNS) {
    for (const row of active) if (unused(`decision:${String(row["id"])}`, String(row["decided_at"]))) retire(decisionItem(store, repo, Number(row["id"])), `decision:${String(row["id"])}`);
    const saved = savedKnowledge(store, repo);
    const firstSeen = store.handle.prepare("SELECT MIN(at) AS at FROM knowledge_change WHERE repo = ?").get(repo)?.["at"];
    for (const ref of saved.references) if (unused(`reference:${ref.id}`, firstSeen == null ? now.toISOString() : String(firstSeen))) {
      retire({ kind: "reference", id: ref.id, revision: saved.revision, sha: referenceSha(ref) }, `reference:${ref.id}`);
    }
    for (const row of store.handle.prepare("SELECT l.id, (SELECT MAX(e.at) FROM learning_event e WHERE e.lesson = l.id AND e.action IN ('adopt','readopt')) AS since FROM project_lesson l WHERE l.repo = ? AND l.status = 'adopted'").all(repo)) {
      if (unused(`lesson:${String(row["id"])}`, row["since"] == null ? now.toISOString() : String(row["since"]))) retire(lessonItem(store, repo, Number(row["id"])), `lesson:${String(row["id"])}`);
    }
  }
  const groups = new Map<string, number[]>();
  for (const row of active) { const key = normal(String(row["claim"])); if (key !== "") groups.set(key, [...(groups.get(key) ?? []), Number(row["id"])]); }
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const items = ids.flatMap(id => { const item = decisionItem(store, repo, id); return item === null ? [] : [item]; });
    const newest = active.find(row => Number(row["id"]) === Math.max(...ids));
    drafts.push({ kind: "merge", items, afterText: String(newest?.["claim"] ?? ""), rationale: `${ids.length} decisions say the same thing.`, evidence: {}, source: "duplicate" });
  }
  for (const row of active) {
    const after = noteAfterwards(store, { id: Number(row["id"]), decidedAt: String(row["decided_at"]), sourceRef: row["source_ref"] == null ? null : String(row["source_ref"]) });
    const item = decisionItem(store, repo, Number(row["id"]));
    if (after === null || item === null || after.failures - after.mixed < FAILING_NOTE) continue;
    drafts.push({ kind: "note-failing", items: [item], afterText: null, rationale: `This note's test failed ${after.failures - after.mixed} times since it was accepted on ${dayWords(after.since)}.`, evidence: { failures: after.failures, mixed: after.mixed, executions: after.executions }, source: "note" });
  }
  return drafts;
}

/** Save drafts that aren't waiting already and weren't rejected in this same state. */
function saveDrafts(store: Store, repo: string, drafts: readonly Draft[], now: Date): number {
  return store.transact(() => {
    const seen = store.handle.prepare("SELECT kind, status, items_json FROM memory_tidy_proposal WHERE repo = ? AND status IN ('pending','rejected')").all(repo);
    const keyOf = (kind: string, items: readonly TidyItem[]): string => `${kind}|${items.map(itemKey).sort().join(",")}`;
    const exactOf = (kind: string, items: readonly TidyItem[]): string => `${kind}|${JSON.stringify([...items].sort((a, b) => itemKey(a).localeCompare(itemKey(b))))}`;
    const waiting = new Set(seen.filter(row => row["status"] === "pending").map(row => keyOf(String(row["kind"]), JSON.parse(String(row["items_json"])) as TidyItem[])));
    const rejected = new Set(seen.filter(row => row["status"] === "rejected").map(row => exactOf(String(row["kind"]), JSON.parse(String(row["items_json"])) as TidyItem[])));
    let made = 0;
    for (const draft of drafts) {
      const key = keyOf(draft.kind, draft.items);
      if (waiting.has(key) || rejected.has(exactOf(draft.kind, draft.items))) continue;
      store.handle.prepare("INSERT INTO memory_tidy_proposal (repo, kind, items_json, after_text, rationale, evidence_json, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
        .run(repo, draft.kind, JSON.stringify(draft.items), draft.afterText, draft.rationale, JSON.stringify(draft.evidence), draft.source, now.toISOString());
      waiting.add(key);
      made++;
    }
    return made;
  });
}

/**
 * The scheduled pass: deterministic, no analyzer in reach. Runs when the project has been quiet for a day, at most
 * weekly, with at least 10 entries. Proposes only.
 */
export function scheduledTidy(store: Store, repo: string, now: Date): number {
  const key = `memory-tidy:${sha(repo).slice(0, 32)}`;
  if (now.getTime() - store.serviceCursor(key) < TIDY_EVERY_MS) return 0;
  const quiet = new Date(now.getTime() - TIDY_QUIET_MS).toISOString();
  if (store.handle.prepare("SELECT 1 FROM run r JOIN task_ref t ON t.id = r.task_ref WHERE t.repo = ? AND (r.finished_at IS NULL OR r.finished_at >= ?) LIMIT 1").get(repo, quiet) !== undefined) return 0;
  const entries = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM project_decision WHERE repo = ? AND status = 'active'").get(repo)?.["n"] ?? 0)
    + savedKnowledge(store, repo).references.length + Number(store.handle.prepare("SELECT COUNT(*) AS n FROM project_lesson WHERE repo = ? AND status = 'adopted'").get(repo)?.["n"] ?? 0);
  if (entries < TIDY_MIN_ENTRIES) return 0;
  store.setServiceCursor(key, now.getTime(), now);
  return saveDrafts(store, repo, deterministicDrafts(store, repo, now), now);
}

export type TidyAnalyzer = (input: { system: string; data: string }) => Promise<{ ok: true; text: string } | { ok: false; problem: string }>;
export const CONTRADICTION_SCHEMA = { type: "object", additionalProperties: false, required: ["contradictions"], properties: { contradictions: { type: "array", items: { type: "object", additionalProperties: false, required: ["a", "b", "why"], properties: { a: { type: "integer" }, b: { type: "integer" }, why: { type: "string" } } } } } } as const;
const CONTRADICTION_PROMPT = `You read a project's settled decisions. Find pairs that can't both hold. Say nothing about style or overlap. Refer to decisions only by id. Return one JSON object and nothing else, matching this JSON Schema: ${JSON.stringify(CONTRADICTION_SCHEMA)}`;

/** Read a model's pairs: ids of active decisions only, a clean reason, each pair once. Everything else is dropped. */
export function parseContradictions(text: string, active: readonly number[]): { a: number; b: number; why: string }[] {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  const list = (raw as { contradictions?: unknown } | null)?.contradictions;
  if (!Array.isArray(list)) return [];
  const known = new Set(active), seen = new Set<string>(), pairs: { a: number; b: number; why: string }[] = [];
  for (const one of list) {
    const { a, b, why } = (one ?? {}) as { a?: unknown; b?: unknown; why?: unknown };
    if (typeof a !== "number" || typeof b !== "number" || a === b || !known.has(a) || !known.has(b) || typeof why !== "string") continue;
    // eslint-disable-next-line no-control-regex
    const reason = why.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
    const key = [a, b].sort((x, y) => x - y).join(",");
    if (reason === "" || scanForSecrets(reason).length > 0 || seen.has(key)) continue;
    seen.add(key);
    pairs.push({ a, b, why: reason });
    if (pairs.length >= MAX_MODEL_PAIRS) break;
  }
  return pairs;
}

/** Clean up, on a person's request: the deterministic pass with no quiet gate, and contradictions when an analyzer is given. */
export async function proposeTidy(store: Store, args: { repo: string; actor: string; analyzer?: TidyAnalyzer }, now: Date): Promise<{ made: number; problem: string | null }> {
  refuseLeadMemoryWrite();
  if (!store.accountCanAccess(args.actor, args.repo) || store.accountOf(args.actor)?.role !== "approver") throw Error("Project memory is outside your access.");
  const drafts = deterministicDrafts(store, args.repo, now);
  let problem: string | null = null;
  if (args.analyzer !== undefined) {
    const active = store.handle.prepare("SELECT id, claim FROM project_decision WHERE repo = ? AND status = 'active' ORDER BY id DESC LIMIT 60").all(args.repo);
    if (active.length >= 2) {
      const answer = await args.analyzer({ system: CONTRADICTION_PROMPT, data: active.map(row => `[${String(row["id"])}] ${String(row["claim"])}`).join("\n") });
      if (!answer.ok) problem = answer.problem;
      else for (const pair of parseContradictions(answer.text, active.map(row => Number(row["id"])))) {
        const items = [decisionItem(store, args.repo, pair.a), decisionItem(store, args.repo, pair.b)].filter((one): one is TidyItem => one !== null);
        drafts.push({ kind: "contradiction", items, afterText: null, rationale: pair.why, evidence: {}, source: "model" });
      }
    }
  }
  return { made: saveDrafts(store, args.repo, drafts, now), problem };
}

// ---- chains --------------------------------------------------------------------------------------------------------

/** Every decision reachable from `id` through ordinary supersession and not-undone merges, transitively (never `id`). */
export function successorChain(store: Store, repo: string, id: number): number[] {
  const seen = new Set<number>([id]), order: number[] = [], queue = [id];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const next = [...store.handle.prepare("SELECT id FROM project_decision WHERE repo = ? AND supersedes = ?").all(repo, at).map(row => Number(row["id"])),
      ...store.handle.prepare("SELECT successor FROM decision_merge WHERE predecessor = ? AND undone_at IS NULL").all(at).map(row => Number(row["successor"]))];
    for (const one of next) if (!seen.has(one)) { seen.add(one); order.push(one); queue.push(one); }
  }
  return order;
}
const statusOf = (store: Store, repo: string, id: number): string | null => { const item = decisionItem(store, repo, id); return item === null || item.kind !== "decision" ? null : item.status; };
/** The active decisions in `id`'s chain. */
export function activeTail(store: Store, repo: string, id: number): number[] {
  return successorChain(store, repo, id).filter(one => statusOf(store, repo, one) === "active");
}

// ---- who, and the writes -------------------------------------------------------------------------------------------

/** A person who may change this project's memory, re-read inside the write. Lead and remote refused; revoked or lost
 * access refused; the laptop's local owner only in its own act; the proof must be a person's. */
function proveMemoryPerson(store: Store, repo: string, actor: string, proof: string): string {
  refuseLeadMemoryWrite();
  if (!store.accountCanAccess(actor, repo) || store.accountOf(actor)?.role !== "approver") throw Error("Project memory is outside your access.");
  const local = currentLocalOwner();
  if (local !== null && local.act !== "memory-review") throw Error("Sign in with your password to do this.");
  const said = local !== null ? "local-owner" : proof;
  if (!personProof(said)) throw Error("Project memory is changed by a person with their own sign-in.");
  return said;
}
const needDecision = (store: Store, repo: string, actor: string, id: number): Decision => {
  const found = getDecision(store, repo, actor, id);
  if (found === null) throw Error("That decision is unavailable.");
  return found;
};
/** Back to active: its note, if it had one, is tracked again. */
function bringBack(store: Store, repo: string, actor: string, id: number, action: string, reason: string, now: Date): void {
  const back = reactivateDecision(store, repo, actor, id, action, reason, now);
  const note = /^lesson-note:(\d+)$/.exec(back.sourceRef ?? "");
  if (note !== null) {
    const facts = lessonNoteOf(store, Number(note[1]));
    if (facts !== null) watchNote(store, { repo, proposal: facts.proposal, identities: facts.identities, decisionRevision: back.revision, now });
  }
}

/** One new decision from several; each old one superseded with a "merged into" history row; every member listed. */
export function mergeDecisions(store: Store, args: { repo: string; actor: string; ids: readonly number[]; claim: string; why: string; proof: string }, now: Date): Decision {
  if (new Set(args.ids).size < 2) throw Error("Choose at least two decisions to merge.");
  return store.transact(() => {
    proveMemoryPerson(store, args.repo, args.actor, args.proof);
    const olds = args.ids.map(id => needDecision(store, args.repo, args.actor, id));
    if (olds.some(one => one.status !== "active")) throw Error("Every decision being merged must be active.");
    const merge = Number(store.handle.prepare("SELECT COALESCE(MAX(merge), 0) + 1 AS next FROM decision_merge").get()!["next"]);
    const made = recordDecision(store, { repo: args.repo, actor: args.actor, draft: { claim: args.claim, why: args.why, sourceKind: "manual", sourceRef: `merge:${merge}` } }, now);
    for (const old of olds) {
      changeDecisionStatus(store, args.repo, args.actor, old.id, "superseded", `Merged into decision ${made.id}.`, now);
      store.handle.prepare("INSERT INTO decision_merge (merge, successor, successor_revision, predecessor, predecessor_revision, at, by) VALUES (?, ?, ?, ?, ?, ?, ?)").run(merge, made.id, made.revision, old.id, old.revision, now.toISOString(), args.actor);
    }
    reindexProjectMemory(store, args.repo);
    return made;
  });
}

export type ExpandedChange = { restored: false; proposal: number; items: TidyItem[] };

/**
 * Restore a retired or superseded decision. With no active tail it goes straight back to active. With one, nothing
 * changes: a proposal names every affected item, and a person chooses what happens to the tail.
 */
export function restoreDecision(store: Store, args: { repo: string; actor: string; id: number; proof: string }, now: Date): { restored: true; decision: Decision } | ExpandedChange {
  return store.transact(() => {
    proveMemoryPerson(store, args.repo, args.actor, args.proof);
    const decision = needDecision(store, args.repo, args.actor, args.id);
    if (decision.status === "active") throw Error("That decision is already active.");
    const tail = activeTail(store, args.repo, args.id);
    if (tail.length === 0) {
      bringBack(store, args.repo, args.actor, args.id, "restored", "Restored by a person.", now);
      reindexProjectMemory(store, args.repo);
      return { restored: true, decision: needDecision(store, args.repo, args.actor, args.id) };
    }
    const members = [args.id, ...successorChain(store, args.repo, args.id)];
    const items = members.flatMap(id => { const item = decisionItem(store, args.repo, id); return item === null ? [] : [item]; });
    const inserted = store.handle.prepare("INSERT INTO memory_tidy_proposal (repo, kind, items_json, after_text, rationale, evidence_json, source, status, created_at) VALUES (?, 'restore', ?, NULL, ?, ?, 'person', 'pending', ?)")
      .run(args.repo, JSON.stringify(items), `Restoring #${args.id} past what replaced it. Choose what happens to ${tail.map(one => `#${one}`).join(", ")}.`, JSON.stringify({ decision: args.id, tail }), now.toISOString());
    return { restored: false, proposal: Number(inserted.lastInsertRowid), items };
  });
}

type MergeRow = { merge: number; successor: number; successorRevision: number; predecessor: number; predecessorRevision: number; undoneAt: string | null };
function mergeRows(store: Store, merge: number): MergeRow[] {
  return store.handle.prepare("SELECT * FROM decision_merge WHERE merge = ?").all(merge).map(row => ({ merge, successor: Number(row["successor"]), successorRevision: Number(row["successor_revision"]), predecessor: Number(row["predecessor"]), predecessorRevision: Number(row["predecessor_revision"]), undoneAt: row["undone_at"] == null ? null : String(row["undone_at"]) }));
}
function finishUnmerge(store: Store, repo: string, actor: string, rows: readonly MergeRow[], now: Date): void {
  const successor = rows[0]!.successor;
  if (statusOf(store, repo, successor) === "active") changeDecisionStatus(store, repo, actor, successor, "retired", "Unmerged.", now);
  for (const row of rows) if (statusOf(store, repo, row.predecessor) !== "active") bringBack(store, repo, actor, row.predecessor, "unmerged", `Unmerged from decision ${successor}.`, now);
  store.handle.prepare("UPDATE decision_merge SET undone_at = ?, undone_by = ? WHERE merge = ? AND undone_at IS NULL").run(now.toISOString(), actor, rows[0]!.merge);
}
/**
 * Undo a merge. Direct only while its successor is active, at the revision recorded at the merge, and not merged on.
 * Otherwise nothing changes: a proposal names every affected item, the later merge included. A merge already undone is
 * refused and changes nothing.
 */
export function unmergeDecisions(store: Store, args: { repo: string; actor: string; merge: number; proof: string }, now: Date): { restored: true; successor: number } | ExpandedChange {
  return store.transact(() => {
    proveMemoryPerson(store, args.repo, args.actor, args.proof);
    const rows = mergeRows(store, args.merge);
    if (rows.length === 0 || decisionItem(store, args.repo, rows[0]!.successor) === null) throw Error("That merge is unavailable.");
    const undone = rows.find(row => row.undoneAt !== null);
    if (undone !== undefined) throw Error(`This merge was already undone on ${dayWords(undone.undoneAt!)}.`);
    const first = rows[0]!, successor = decisionItem(store, args.repo, first.successor);
    const mergedOn = store.handle.prepare("SELECT 1 FROM decision_merge WHERE predecessor = ? AND undone_at IS NULL LIMIT 1").get(first.successor) !== undefined;
    const direct = successor !== null && successor.kind === "decision" && successor.status === "active" && successor.revision === first.successorRevision && !mergedOn
      && rows.every(row => { const one = decisionItem(store, args.repo, row.predecessor); return one !== null && one.kind === "decision" && one.status === "superseded" && one.revision === row.predecessorRevision + 1; });
    if (direct) {
      finishUnmerge(store, args.repo, args.actor, rows, now);
      reindexProjectMemory(store, args.repo);
      return { restored: true, successor: first.successor };
    }
    const tail = activeTail(store, args.repo, first.successor);
    const members = [first.successor, ...rows.map(row => row.predecessor), ...successorChain(store, args.repo, first.successor)];
    const items = [...new Set(members)].flatMap(id => { const item = decisionItem(store, args.repo, id); return item === null ? [] : [item]; });
    const later = store.handle.prepare("SELECT DISTINCT merge FROM decision_merge WHERE predecessor = ? AND undone_at IS NULL").all(first.successor).map(row => Number(row["merge"]));
    const inserted = store.handle.prepare("INSERT INTO memory_tidy_proposal (repo, kind, items_json, after_text, rationale, evidence_json, source, status, created_at) VALUES (?, 'unmerge', ?, NULL, ?, ?, 'person', 'pending', ?)")
      .run(args.repo, JSON.stringify(items), `Decision #${first.successor} changed since the merge${later.length === 0 ? "" : ` and was merged on (${later.map(one => `merge ${one}`).join(", ")})`}.${tail.length === 0 ? "" : ` Choose what happens to ${tail.map(one => `#${one}`).join(", ")}.`}`, JSON.stringify({ merge: args.merge, tail, later }), now.toISOString());
    return { restored: false, proposal: Number(inserted.lastInsertRowid), items };
  });
}

/** A disabled lesson back in use (re-checks its support, bound to its version and sha). */
export function restoreLesson(store: Store, root: string, args: { repo: string; actor: string; id: number; proof: string }, now: Date): void {
  store.transact(() => {
    proveMemoryPerson(store, args.repo, args.actor, args.proof);
    const item = lessonItem(store, args.repo, args.id);
    if (item === null || item.kind !== "lesson") throw Error("Learning lesson is unavailable.");
    const policy = store.handle.prepare("SELECT revision FROM learning_policy WHERE repo = ?").get(args.repo);
    changeLearning(store, root, { repo: args.repo, actor: args.actor, identity: learningIdentity(args.repo), revision: Number(policy?.["revision"] ?? 0), action: "readopt", lesson: args.id, version: item.version, sha: item.sha }, now);
  });
}
/** A reference back from history, as a new knowledge revision bound to the current one. */
export function restoreReference(store: Store, args: { repo: string; actor: string; id: string; fromRevision: number; proof: string }, now: Date): void {
  store.transact(() => {
    proveMemoryPerson(store, args.repo, args.actor, args.proof);
    const view = knowledgeView(store, args.repo, args.actor);
    changeKnowledge(store, { repo: args.repo, actor: args.actor, identity: view.identity, revision: view.revision, action: "readd", draft: { id: args.id }, restore: args.fromRevision }, now);
  });
}

// ---- deciding ------------------------------------------------------------------------------------------------------

export type TidyDecision = { repo: string; actor: string; id: number; decision: "accept" | "reject"; choice?: string; claim?: string; why?: string; proof: string };
const required = (value: string | undefined, words: string): string => { const text = (value ?? "").trim(); if (text === "") throw Error(words); return text; };
const tailOf = (proposal: TidyProposal): number[] => Array.isArray(proposal.evidence["tail"]) ? (proposal.evidence["tail"] as number[]) : [];

function applyTidy(store: Store, root: string, proposal: TidyProposal, args: TidyDecision, proof: string, now: Date): void {
  const { repo, actor } = args;
  const decisions = proposal.items.filter((one): one is Extract<TidyItem, { kind: "decision" }> => one.kind === "decision");
  const reason = proposal.rationale.slice(0, 450);
  switch (proposal.kind) {
    case "retire": {
      const item = proposal.items[0]!;
      if (item.kind === "decision") retireDecision(store, { repo, actor, id: item.id, reason }, now);
      else if (item.kind === "reference") { const view = knowledgeView(store, repo, actor); changeKnowledge(store, { repo, actor, identity: view.identity, revision: view.revision, action: "remove", draft: { id: item.id } }, now); }
      else {
        const policy = store.handle.prepare("SELECT revision FROM learning_policy WHERE repo = ?").get(repo);
        changeLearning(store, root, { repo, actor, identity: learningIdentity(repo), revision: Number(policy?.["revision"] ?? 0), action: "disable", lesson: item.id, version: item.version, sha: item.sha }, now);
      }
      return;
    }
    case "merge":
      mergeDecisions(store, { repo, actor, ids: decisions.map(one => one.id), claim: (args.claim ?? "").trim() || proposal.afterText || "", why: (args.why ?? "").trim() || proposal.rationale, proof }, now);
      return;
    case "contradiction": {
      const choice = required(args.choice, "Choose which stays, keep both, or write a new one.");
      if (choice === "both") return;
      if (choice === "new") {
        const claim = required(args.claim, "Write the new decision."), why = required(args.why, "Say why.");
        for (const one of decisions) changeDecisionStatus(store, repo, actor, one.id, "retired", "Replaced after a contradiction.", now);
        recordDecision(store, { repo, actor, draft: { claim, why, sourceKind: "manual", sourceRef: `cleanup:${proposal.id}` } }, now);
        return;
      }
      const kept = /^keep:(\d+)$/.exec(choice);
      if (kept === null || !decisions.some(one => one.id === Number(kept[1]))) throw Error("Choose which stays, keep both, or write a new one.");
      for (const one of decisions) if (one.id !== Number(kept[1])) retireDecision(store, { repo, actor, id: one.id, reason: `Contradicted decision ${kept[1]}.` }, now);
      return;
    }
    case "note-failing": {
      const choice = required(args.choice, "Choose to rewrite or retire it.");
      const item = decisions[0]!;
      if (choice === "retire") retireDecision(store, { repo, actor, id: item.id, reason }, now);
      else if (choice === "rewrite") recordDecision(store, { repo, actor, draft: { claim: required(args.claim, "Write the new note."), why: required(args.why, "Say why."), sourceKind: "manual", sourceRef: `cleanup:${proposal.id}`, supersedes: item.id } }, now);
      else throw Error("Choose to rewrite or retire it.");
      return;
    }
    case "restore": case "unmerge": {
      const tail = tailOf(proposal);
      const choice = tail.length === 0 ? "keep" : required(args.choice, "Choose what happens to the decisions that replaced it.");
      if (choice !== "retire" && choice !== "keep") throw Error("Choose to retire them or keep both active.");
      if (choice === "retire") for (const id of tail) changeDecisionStatus(store, repo, actor, id, "retired", "Retired by a reviewed restore.", now);
      if (proposal.kind === "restore") bringBack(store, repo, actor, Number(proposal.evidence["decision"]), "restored", "Restored after review.", now);
      else {
        const rows = mergeRows(store, Number(proposal.evidence["merge"]));
        if (rows.length === 0 || rows.some(row => row.undoneAt !== null)) throw Error("That merge is unavailable.");
        finishUnmerge(store, repo, actor, rows, now);
      }
      return;
    }
  }
}

/**
 * Accept or reject one proposal: the one writer of a proposal's outcome. In one transaction, a person's standing, the
 * proposal's state and every bound item are re-read; any difference marks it stale and changes nothing.
 */
export function decideTidy(store: Store, root: string, args: TidyDecision, now: Date): TidyProposal {
  refuseLeadMemoryWrite();
  const outcome = store.transact((): TidyProposal | "stale" => {
    const proof = proveMemoryPerson(store, args.repo, args.actor, args.proof);
    const row = store.handle.prepare("SELECT * FROM memory_tidy_proposal WHERE id = ? AND repo = ?").get(args.id, args.repo);
    if (row === undefined) throw Error("That proposal is unavailable.");
    const proposal = proposalOf(store, row as Record<string, unknown>);
    if (proposal.status !== "pending") throw Error(proposal.status === "stale" ? TIDY_STALE : "That proposal was already decided.");
    const at = now.toISOString();
    if (args.decision === "reject") {
      store.handle.prepare("UPDATE memory_tidy_proposal SET status = 'rejected', decided_by = ?, decided_proof = ?, decided_at = ? WHERE id = ?").run(args.actor, proof, at, proposal.id);
      return { ...proposal, status: "rejected", decidedBy: args.actor };
    }
    if (!proposal.items.every(item => itemStands(store, args.repo, item))) {
      store.handle.prepare("UPDATE memory_tidy_proposal SET status = 'stale', decided_at = ? WHERE id = ?").run(at, proposal.id);
      return "stale";
    }
    applyTidy(store, root, proposal, args, proof, now);
    reindexProjectMemory(store, args.repo);
    store.handle.prepare("UPDATE memory_tidy_proposal SET status = 'accepted', decided_by = ?, decided_proof = ?, decided_at = ? WHERE id = ?").run(args.actor, proof, at, proposal.id);
    return { ...proposal, status: "accepted", decidedBy: args.actor };
  });
  if (outcome === "stale") throw Error(TIDY_STALE);
  return outcome;
}

/** Merges that can still be undone, for the page. */
export function undoableMerges(store: Store, repo: string): { merge: number; successor: number; predecessors: number[] }[] {
  const rows = store.handle.prepare("SELECT m.merge, m.successor, m.predecessor FROM decision_merge m JOIN project_decision d ON d.id = m.successor WHERE d.repo = ? AND m.undone_at IS NULL ORDER BY m.merge DESC LIMIT 200").all(repo);
  const merges = new Map<number, { merge: number; successor: number; predecessors: number[] }>();
  for (const row of rows) {
    const id = Number(row["merge"]), one = merges.get(id) ?? { merge: id, successor: Number(row["successor"]), predecessors: [] };
    one.predecessors.push(Number(row["predecessor"]));
    merges.set(id, one);
  }
  return [...merges.values()];
}
/** Lessons that were disabled and can be used again, for the page. */
export function disabledLessons(store: Store, repo: string): { id: number; observation: string }[] {
  return store.handle.prepare("SELECT id, payload FROM project_lesson WHERE repo = ? AND status = 'disabled' ORDER BY id DESC LIMIT 50").all(repo).flatMap(row => {
    try { return [{ id: Number(row["id"]), observation: String((JSON.parse(String(row["payload"])) as { observation?: unknown }).observation ?? "") }]; } catch { return []; }
  });
}
