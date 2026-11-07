/**
 * "Last included in a run" (docs/plans/learning-loops.md): one `memory_use` row per lesson, reference and decision in a
 * run's frozen context, written in the transaction that freezes it. The only writer of `memory_use`; release-auto's
 * learning scan (eval-hooks.ts learningWriteProblem) needs a person for any other. A policy path (release-auto.ts
 * EVAL_POLICY).
 *
 * Usage, never benefit: nothing here says a run did better for having an item, and nothing reads it for authority. Old
 * snapshots are backfilled from their own sha-verified bytes and nothing is inferred: a knowledge snapshot from before
 * `capturedAt` has no time and no version, so its rows say so. Lead chat contexts aren't snapshotted and aren't counted.
 */
import { createHash } from "node:crypto";
import { readKnowledgeSelection, type KnowledgeSelection } from "./contracts/project-knowledge.js";
import type { Store } from "./store.js";

export type MemoryKind = "lesson" | "reference" | "decision";
export type MemoryUse = { lastRun: number; lastAt: string | null; runs: number };

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
/** A run's role as a phase of the work. */
export const phaseOfRole = (role: string): "plan" | "review" | "build" => role === "planner" ? "plan" : role === "reviewer" ? "review" : "build";

function insertUse(store: Store, row: { run: number; repo: string; kind: MemoryKind; item: string; version: number | null; phase: string; at: string | null }): void {
  store.handle.prepare(`INSERT INTO memory_use (run, repo, kind, item, version, phase, included_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run, kind, item) DO NOTHING`)
    .run(row.run, row.repo, row.kind, row.item, row.version, row.phase, row.at);
}

/** Every reference and decision in a run's frozen knowledge. Called in the transaction that freezes it; advisory, so a
 * failure leaves the run's context exactly as it was. */
export function recordKnowledgeUse(store: Store, input: { run: number; repo: string; role: string; selection: KnowledgeSelection }): void {
  const { selection } = input, phase = phaseOfRole(input.role), at = selection.capturedAt ?? null;
  try {
    store.savepoint(() => {
      for (const ref of selection.references) insertUse(store, { run: input.run, repo: input.repo, kind: "reference", item: ref.id, version: selection.capturedAt === undefined ? null : selection.revision, phase, at });
      for (const one of selection.decisions ?? []) insertUse(store, { run: input.run, repo: input.repo, kind: "decision", item: String(one.id), version: one.revision ?? null, phase, at });
    });
  } catch { /* advisory: the run's context is unchanged */ }
}

/** The lessons in a run's frozen learning payload (its last line is the record). */
function lessonsOf(payload: string): { phase: string; lessons: { id: number; version: number }[] } | null {
  try {
    const record = JSON.parse(payload.trim().split("\n").at(-1)!) as { phase?: unknown; lessons?: unknown };
    if (typeof record.phase !== "string" || !Array.isArray(record.lessons)) return null;
    const lessons = record.lessons.flatMap((one: unknown) => { const l = one as { id?: unknown; version?: unknown }; return Number.isSafeInteger(l.id) && Number.isSafeInteger(l.version) ? [{ id: Number(l.id), version: Number(l.version) }] : []; });
    return { phase: record.phase, lessons };
  } catch { return null; }
}
/** Every lesson in a run's frozen learning context. As recordKnowledgeUse. */
export function recordLessonUse(store: Store, input: { run: number; repo: string; payload: string; at: string }): void {
  const read = lessonsOf(input.payload);
  if (read === null) return;
  try {
    store.savepoint(() => { for (const one of read.lessons) insertUse(store, { run: input.run, repo: input.repo, kind: "lesson", item: String(one.id), version: one.version, phase: read.phase, at: input.at }); });
  } catch { /* advisory: the run's context is unchanged */ }
}

const CURSOR_LESSONS = "memory-use:backfill-lessons", CURSOR_KNOWLEDGE = "memory-use:backfill-knowledge";
/**
 * Backfill from snapshots older than this feature, a bounded batch at a time (the watch loop's learning pass): each
 * snapshot's sha is verified first. Lesson rows take the snapshot's own time and version; knowledge rows from a snapshot
 * with no `capturedAt` have no version and no time. Returns how many snapshots were read.
 */
export function backfillMemoryUse(store: Store, now: Date, limit = 200): number {
  const lessonFrom = store.serviceCursor(CURSOR_LESSONS), knowledgeFrom = store.serviceCursor(CURSOR_KNOWLEDGE);
  const lessons = store.handle.prepare("SELECT run, repo, payload, sha, created_at FROM learning_snapshot WHERE run > ? ORDER BY run LIMIT ?").all(lessonFrom, limit);
  const knowledge = store.handle.prepare("SELECT k.run, k.repo, k.payload, k.sha, r.role FROM knowledge_snapshot k JOIN run r ON r.id = k.run WHERE k.run > ? ORDER BY k.run LIMIT ?").all(knowledgeFrom, limit);
  store.transact(() => {
    for (const row of lessons) {
      const payload = String(row["payload"]);
      if (sha(payload) === row["sha"]) recordLessonUse(store, { run: Number(row["run"]), repo: String(row["repo"]), payload, at: String(row["created_at"]) });
    }
    for (const row of knowledge) {
      const payload = String(row["payload"]);
      if (sha(payload) !== row["sha"]) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(payload); } catch { continue; }
      const read = readKnowledgeSelection(parsed);
      if (read.ok) recordKnowledgeUse(store, { run: Number(row["run"]), repo: String(row["repo"]), role: String(row["role"]), selection: read.value });
    }
    if (lessons.length > 0) store.setServiceCursor(CURSOR_LESSONS, Number(lessons.at(-1)!["run"]), now);
    if (knowledge.length > 0) store.setServiceCursor(CURSOR_KNOWLEDGE, Number(knowledge.at(-1)!["run"]), now);
  });
  return lessons.length + knowledge.length;
}

/** A project's usage, by `<kind>:<item>`: its newest run, that run's time and how many runs had it. */
export function memoryUseOf(store: Store, repo: string): Map<string, MemoryUse> {
  const rows = store.handle.prepare(`SELECT u.kind, u.item, u.run AS last_run, u.included_at, t.runs FROM memory_use u
    JOIN (SELECT kind, item, MAX(run) AS last_run, COUNT(*) AS runs FROM memory_use WHERE repo = ? GROUP BY kind, item) t ON t.kind = u.kind AND t.item = u.item AND t.last_run = u.run WHERE u.repo = ?`).all(repo, repo);
  return new Map(rows.map(row => [`${String(row["kind"])}:${String(row["item"])}`, { lastRun: Number(row["last_run"]), lastAt: row["included_at"] == null ? null : String(row["included_at"]), runs: Number(row["runs"]) }]));
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** "Last included in a run: #4410, Nov 3 · 41 runs"; "#2210 (time not recorded)" for a backfilled row; "Not included yet". */
export function lastIncludedWords(use: MemoryUse | undefined): string {
  if (use === undefined) return "Not included yet";
  const runs = `${use.runs.toLocaleString("en-US")} run${use.runs === 1 ? "" : "s"}`;
  return `Last included in a run: #${use.lastRun}${use.lastAt === null ? " (time not recorded)" : `, ${DAY.format(new Date(use.lastAt))}`} · ${runs}`;
}
