/** CH0 representation/reader only. No writer, dispatch guard, retirement or native-stop proof.
 * Recognizing an event here has ZERO effect on existing executors. Do not enable recovery from this result. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { RECOVERY_GENERATION_PATTERN } from "./workspace-identity-schema.js";

export const CHECK_RECOVERY_HELD = "checks recovery held";
const REQUESTED = "checks requested", FAMILY_LIMIT = 256;
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(4096);
const requestSchema = z.object({ id, repo: text.nullable(), runId: id, taskId: z.string().min(1).max(512),
  action: z.literal(REQUESTED), outcome: z.enum(["quick", "full"]), detail: z.string().min(1).max(4096),
}).strict();
const detailSchema = z.object({ v: z.literal(1), q: z.string().regex(/^[0-9a-f]{64}$/),
  g: z.string().regex(RECOVERY_GENERATION_PATTERN), r: id,
}).strict();
export type CheckHoldDetail = z.infer<typeof detailSchema>;
/** Bytes only: no event is appended, and no caller-asserted authority is constructed. */
export function representCheckHoldDetail(input: unknown): string | null {
  const parsed = detailSchema.safeParse(input);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}
export function parseCheckHoldDetail(raw: unknown): CheckHoldDetail | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 300) return null;
  try {
    const parsed = detailSchema.safeParse(JSON.parse(raw));
    return parsed.success && JSON.stringify(parsed.data) === raw ? parsed.data : null;
  } catch { return null; }
}
/** Stable versioned tuple, not a hash of caller-chosen partial fields. Representation only. */
export function checkRequestDigest(input: unknown): string | null {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return null;
  const q = parsed.data, parts = q.detail.split(" · ");
  if ((parts.length !== 3 && parts.length !== 4) || !/^[0-9a-f]{40}$/.test(parts[0]!)
    || !["person", "pull-request", "batch", "recheck"].includes(parts[1]!) || !/^[0-9a-f]{64}$/.test(parts[2]!)
    || (parts.length === 4 && (parts[1] !== "batch" || (parts[3] !== "" && !/^[0-9a-f]{40}$/.test(parts[3]!))))) return null;
  return createHash("sha256").update(JSON.stringify([1, q.id, q.repo, q.runId, q.taskId, q.action, q.outcome, q.detail])).digest("hex");
}

type Ref = { id: number; backend: string; external_id: string; repo: string | null; revision_of: string | null; revision_brief_artifact: number | null };
type Row = Record<string, unknown>;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function refOf(row: Row | undefined): Ref | null {
  if (row === undefined || !whole(row["id"]) || row["backend"] !== "built-in" || typeof row["external_id"] !== "string"
    || (row["repo"] !== null && typeof row["repo"] !== "string") || (row["revision_of"] !== null && typeof row["revision_of"] !== "string")
    || (row["revision_brief_artifact"] !== null && !whole(row["revision_brief_artifact"]))) return null;
  return row as Ref;
}
/** Resolve both current and historical links from trusted rows, without caller-supplied family filters.
 * Raw revision links are traversed even across changed projects, then refused rather than dropped.
 * Replacement links also keep an old held request visible after a replacement task is filed. */
function family(store: Store, seed: Ref): { refs: Ref[] } | { problem: string } {
  const refs = new Map<number, Ref>(), pending = [seed];
  const byId = (n: number) => refOf(store.handle.prepare("SELECT * FROM task_ref WHERE id = ?").get(n));
  const byName = (name: string) => {
    const rows = store.handle.prepare("SELECT * FROM task_ref WHERE backend = 'built-in' AND external_id = ? LIMIT 2").all(name);
    return rows.length === 1 ? refOf(rows[0]) : null;
  };
  const revision = (child: Ref, parent: Ref): boolean => {
    if (child.repo !== parent.repo || child.revision_of !== parent.external_id || child.revision_brief_artifact === null) return false;
    const proof = store.handle.prepare("SELECT a.kind, r.task_ref FROM artifact a JOIN run r ON r.id = a.run WHERE a.id = ?").get(child.revision_brief_artifact);
    return proof?.["kind"] === "revision-brief" && proof["task_ref"] === parent.id;
  };
  while (pending.length > 0) {
    const at = pending.pop()!;
    if (refs.has(at.id)) continue;
    if (refs.size >= FAMILY_LIMIT) return { problem: "family-bound-exceeded" };
    if (at.repo !== seed.repo || store.handle.prepare("SELECT 1 FROM task WHERE id = ?").get(at.external_id) === undefined) return { problem: "family-scope-mismatch" };
    refs.set(at.id, at);
    if (at.revision_of !== null) {
      const parent = byName(at.revision_of);
      if (parent === null || !revision(at, parent)) return { problem: "invalid-revision-lineage" };
      pending.push(parent);
    }
    for (const row of store.handle.prepare("SELECT * FROM task_ref WHERE backend = 'built-in' AND revision_of = ? LIMIT ?").all(at.external_id, FAMILY_LIMIT + 1)) {
      const child = refOf(row);
      if (child === null || !revision(child, at)) return { problem: "invalid-revision-lineage" };
      pending.push(child);
    }
    for (const row of store.handle.prepare("SELECT task_ref, successor FROM task_replacement WHERE task_ref = ? OR successor = ? LIMIT ?").all(at.id, at.external_id, FAMILY_LIMIT + 1)) {
      const predecessor = whole(row["task_ref"]) ? byId(row["task_ref"]) : null;
      const successor = typeof row["successor"] === "string" ? byName(row["successor"]) : null;
      if (predecessor === null || successor === null || predecessor.repo !== successor.repo) return { problem: "invalid-replacement-lineage" };
      pending.push(predecessor, successor);
    }
  }
  // Cyclic revision/replacement chains are ambiguous, not a smaller admitted family.
  const edges = new Map<number, number[]>();
  for (const at of refs.values()) {
    if (at.revision_of !== null) {
      const parent = [...refs.values()].find(r => r.external_id === at.revision_of);
      if (parent === undefined) return { problem: "missing-family-parent" };
      edges.set(at.id, [...(edges.get(at.id) ?? []), parent.id]);
    }
    for (const row of store.handle.prepare("SELECT successor FROM task_replacement WHERE task_ref = ?").all(at.id)) {
      const successor = [...refs.values()].find(r => r.external_id === row["successor"]);
      if (successor === undefined) return { problem: "missing-replacement" };
      edges.set(successor.id, [...(edges.get(successor.id) ?? []), at.id]);
    }
  }
  const done = new Set<number>(), visiting = new Set<number>();
  const cycle = (n: number): boolean => {
    if (visiting.has(n)) return true;
    if (done.has(n)) return false;
    visiting.add(n);
    if ((edges.get(n) ?? []).some(cycle)) return true;
    visiting.delete(n); done.add(n); return false;
  };
  if ([...refs.keys()].some(cycle)) return { problem: "cyclic-family" };
  return { refs: [...refs.values()].sort((a, b) => a.id - b.id) };
}
export type ReadCheckRecoveryHolds = Readonly<{
  kind: "no-evidence" | "held-evidence" | "invalid-evidence"; reason: string; familyRefs: readonly number[];
  holds: readonly Readonly<{ event: number; request: number; run: number; taskRef: number; repo: string | null;
    recoveryGeneration: string; admission: "blocked"; priorExecution: "unverified" }>[];
  runtimeProtection: false; retirementSupported: false; nativeStopProof: false;
}>;
function result(kind: ReadCheckRecoveryHolds["kind"], reason: string, refs: readonly number[] = [], holds: ReadCheckRecoveryHolds["holds"] = []): ReadCheckRecoveryHolds {
  return Object.freeze({ kind, reason, familyRefs: Object.freeze([...refs]), holds: Object.freeze([...holds]),
    runtimeProtection: false, retirementSupported: false, nativeStopProof: false });
}
/** Snapshot reader only. No event -> no-evidence, NEVER permission to run.
 * Existing production code does not import this function or honor this event. */
export function readCheckRecoveryHoldsForRun(store: Store, runId: number): ReadCheckRecoveryHolds {
  if (!whole(runId)) return result("invalid-evidence", "invalid-run-id");
  try {
    return readSnapshot(store, () => {
      const run = store.handle.prepare("SELECT task_ref FROM run WHERE id = ?").get(runId);
      const seed = run !== undefined && whole(run["task_ref"]) ? refOf(store.handle.prepare("SELECT * FROM task_ref WHERE id = ?").get(run["task_ref"])) : null;
      if (seed === null) return result("invalid-evidence", "missing-run-ref");
      const found = family(store, seed);
      if ("problem" in found) return result("invalid-evidence", found.problem);
      const ids = found.refs.map(r => r.id), serialized = JSON.stringify(ids), names = JSON.stringify(found.refs.map(r => r.external_id));
      // Current run linkage may have moved since the immutable ledger event. Discover
      // recorded task/ref scopes too, then reject the changed binding below; never
      // let a mutable run.task_ref move make its original family's hold disappear.
      const events = store.handle.prepare(`SELECT h.* FROM action_ledger h WHERE h.action = ? AND
        (h.run_id IN (SELECT id FROM run WHERE task_ref IN (SELECT value FROM json_each(?)))
          OR h.task_id IN (SELECT value FROM json_each(?))
          OR (CASE WHEN json_valid(h.detail) THEN json_extract(h.detail, '$.r') ELSE NULL END) IN (SELECT value FROM json_each(?))
          OR EXISTS (SELECT 1 FROM action_ledger q WHERE CAST(q.id AS TEXT) = h.outcome AND
            (q.task_id IN (SELECT value FROM json_each(?)) OR q.run_id IN
              (SELECT id FROM run WHERE task_ref IN (SELECT value FROM json_each(?)))))) ORDER BY h.id`)
        .all(CHECK_RECOVERY_HELD, serialized, names, serialized, names, serialized);
      const holds: ReadCheckRecoveryHolds["holds"][number][] = [];
      for (const event of events) {
        if (typeof event["outcome"] !== "string" || !/^[1-9][0-9]*$/.test(event["outcome"])) return result("invalid-evidence", "invalid-request-id", ids);
        const requestId = Number(event["outcome"]), detail = parseCheckHoldDetail(event["detail"]);
        if (!whole(requestId) || detail === null || !whole(event["id"]) || event["id"] <= requestId
          || event["source"] !== "work" || event["actor"] !== "toolroll") return result("invalid-evidence", "invalid-hold-event", ids);
        const q = store.handle.prepare("SELECT * FROM action_ledger WHERE id = ?").get(requestId);
        if (q === undefined || !whole(q["run_id"])) return result("invalid-evidence", "missing-request", ids);
        const actual = { id: q["id"], repo: q["repo"], runId: q["run_id"], taskId: q["task_id"], action: q["action"], outcome: q["outcome"], detail: q["detail"] };
        const hashed = checkRequestDigest(actual);
        const qrun = store.handle.prepare("SELECT task_ref FROM run WHERE id = ?").get(q["run_id"]);
        const ref = found.refs.find(r => r.id === qrun?.["task_ref"]);
        if (hashed === null || hashed !== detail.q || ref === undefined || detail.r !== ref.id || ref.repo !== q["repo"] || ref.external_id !== q["task_id"]
          || event["run_id"] !== q["run_id"] || event["repo"] !== q["repo"] || event["task_id"] !== q["task_id"])
          return result("invalid-evidence", "hold-binding-mismatch", ids);
        holds.push(Object.freeze({ event: event["id"], request: requestId, run: q["run_id"], taskRef: ref.id, repo: ref.repo,
          recoveryGeneration: detail.g, admission: "blocked", priorExecution: "unverified" }));
      }
      return result(holds.length === 0 ? "no-evidence" : "held-evidence", holds.length === 0 ? "no-hold-evidence" : "recognized-only-not-enforced", ids, holds);
    });
  } catch { return result("invalid-evidence", "unreadable-evidence"); }
}

/** SQLite savepoint establishes a read snapshot without committing a caller's transaction.
 * No statement in this module mutates data; RELEASE owns only this nested savepoint. */
function readSnapshot<T>(store: Store, body: () => T): T {
  store.handle.exec("SAVEPOINT ch0_check_hold_read");
  try { return body(); } finally { store.handle.exec("RELEASE SAVEPOINT ch0_check_hold_read"); }
}
