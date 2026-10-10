/** Durable, explicitly acknowledged delivery of assignment status events.
 * Callers authenticate the raw coordinator credential inside the same Store
 * transaction. Delivery receipts never complete tasks or grant authority. */
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "./store.js";
import type { AssignmentOwner } from "./assignment.js";
import { ASSIGNMENT_STATUS_ACTION, parseAssignmentStatusEvent, type AssignmentStatusEvent } from "./assignment-status.js";

type SavedDeliveryEvent = {
  id: number; createdAt: string; rootId: string; project: string;
  kind: "assignment-status"; digest: string; assignment: AssignmentStatusEvent["assignment"];
};
export type AssignmentDeliveryEvent = SavedDeliveryEvent | { id: number; unavailable: true };
export type AssignmentDeliveryBatch = {
  version: 1; id: string | null; consumer: string; after: number; nextCursor: number;
  hasMore: boolean; events: AssignmentDeliveryEvent[];
};
type SavedBatch = Omit<AssignmentDeliveryBatch, "events"> & { events: SavedDeliveryEvent[] };
type Failure = { ok: false; reason: "invalid-input" | "unavailable" | "stale-batch" | "event-too-large"; message: string };
export type AssignmentInboxResult = { ok: true; batch: AssignmentDeliveryBatch; replayed: boolean } | Failure;
export type AssignmentDeliveryAckResult = { ok: true; alreadyAcknowledged: boolean; cursor: number } | Failure;
const MAX_PAGE_BYTES = 64 * 1024;
const fail = (reason: Failure["reason"], message: string): Failure => ({ ok: false, reason, message });
const actor = (owner: AssignmentOwner) => `coordinator:${owner.id}`;
const keyFor = (owner: AssignmentOwner, consumer: string) => createHash("sha256").update(JSON.stringify([owner.id, consumer])).digest("hex");
const validConsumer = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const ownerSql = `COALESCE((SELECT 'lead:'||o.lead FROM team_task_owner o WHERE o.task_ref=t.id),(SELECT a.actor FROM action_ledger a WHERE a.task_id = t.external_id
  AND a.action = 'assignment claimed' AND a.source = 'work' ORDER BY a.id DESC LIMIT 1),
  'coordinator:' || t.coordinator_cid)`;

function admittedRepos(store: Store, owner: AssignmentOwner): string[] | null {
  if (owner.kind !== "coordinator" || typeof owner.id !== "string" || owner.id.length === 0) return null;
  const row = store.handle.prepare("SELECT projects_json AS repos,revoked_at FROM credential WHERE id = ? AND kind = 'coordinator'").get(owner.id);
  if (!row || row["revoked_at"] !== null) return null;
  try {
    const repos: unknown = JSON.parse(String(row["repos"]));
    return Array.isArray(repos) && repos.every(repo => typeof repo === "string") ? repos : null;
  } catch { return null; }
}
function exposedBatch(store: Store, owner: AssignmentOwner, repos: string[], batch: SavedBatch): AssignmentDeliveryBatch {
  return { ...batch, events: batch.events.map(event => {
    const admitted = repos.includes(event.project) && store.handle.prepare(`SELECT 1 FROM task_ref t
      WHERE t.backend = 'built-in' AND t.external_id = ? AND t.repo = ? AND t.revision_of IS NULL AND ${ownerSql} = ?`)
      .get(event.rootId, event.project, actor(owner)) !== undefined;
    return admitted ? event : { id: event.id, unavailable: true as const };
  }) };
}
function eventFromRow(row: Record<string, unknown>, owner: AssignmentOwner): SavedDeliveryEvent | null {
  const parsed = parseAssignmentStatusEvent(String(row["outcome"]));
  if (parsed === null || parsed.assignment.rootId !== row["task_id"] || parsed.assignment.owner?.id !== owner.id) return null;
  return { id: Number(row["id"]), createdAt: String(row["at"]), rootId: String(row["task_id"]),
    project: String(row["repo"]), kind: "assignment-status", digest: parsed.digest, assignment: parsed.assignment };
}
function pendingBatch(store: Store, owner: AssignmentOwner, key: string): SavedBatch | null | Failure {
  const id = store.serviceCursor(`assignment-inbox:${key}:pending`);
  if (id === 0) return null;
  const invalid = () => fail("unavailable", "The saved delivery page is invalid; its cursor has not advanced.");
  const row = store.handle.prepare("SELECT outcome FROM action_ledger WHERE id = ? AND actor = ? AND action = ? AND source = 'work'")
    .get(id, actor(owner), `assignment delivery batch:${key}`);
  if (!row || Buffer.byteLength(String(row["outcome"])) > MAX_PAGE_BYTES) return invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(String(row["outcome"])); } catch { return invalid(); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return invalid();
  const batch = parsed as SavedBatch;
  if (Object.keys(batch).sort().join(",") !== "after,consumer,events,hasMore,id,nextCursor,version" || batch.version !== 1 ||
    typeof batch.id !== "string" || !/^[a-f0-9]{32}$/.test(batch.id) || !validConsumer(batch.consumer) ||
    !Number.isSafeInteger(batch.after) || batch.after < 0 || !Number.isSafeInteger(batch.nextCursor) || batch.nextCursor <= batch.after ||
    typeof batch.hasMore !== "boolean" || !Array.isArray(batch.events) || batch.events.length < 1 || batch.events.length > 100) return invalid();
  let previous = batch.after;
  for (const event of batch.events) {
    if (!event || !Number.isSafeInteger(event.id) || event.id <= previous) return invalid();
    const source = store.handle.prepare("SELECT id,at,task_id,repo,outcome FROM action_ledger WHERE id = ? AND actor = ? AND action = ? AND source = 'work'")
      .get(event.id, actor(owner), ASSIGNMENT_STATUS_ACTION);
    const original = source === undefined ? null : eventFromRow(source, owner);
    if (original === null || JSON.stringify(original) !== JSON.stringify(event)) return invalid();
    previous = event.id;
  }
  return previous === batch.nextCursor ? batch : invalid();
}

/** A read stages one immutable page. Until ACK, any process using this owner
 * and consumer receives that exact page, regardless of new status events or
 * a changed requested page size. Lost access replaces content with an opaque
 * tombstone; it does not prevent acknowledgment of that already issued page.
 * Consumer names identify independent inboxes. */
export function assignmentInbox(store: Store, owner: AssignmentOwner, query: { consumer: string; limit?: number }, now: Date): AssignmentInboxResult {
  if (!validConsumer(query.consumer) || (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)))
    return fail("invalid-input", "Use a consumer name of 1–64 characters and a page size of 1–100.");
  return store.transact(() => store.savepoint(() => {
    const repos = admittedRepos(store, owner);
    if (repos === null) return fail("unavailable", "The coordinator is no longer active.");
    const key = keyFor(owner, query.consumer), cursorKey = `assignment-inbox:${key}:acked`;
    const after = store.serviceCursor(cursorKey), pending = pendingBatch(store, owner, key);
    if (pending !== null) {
      if ("ok" in pending) return pending;
      if (pending.consumer !== query.consumer || pending.after !== after)
        return fail("unavailable", "The saved delivery page does not match its cursor.");
      return { ok: true as const, batch: exposedBatch(store, owner, repos, pending), replayed: true };
    }
    const limit = query.limit ?? 10;
    const rows = store.handle.prepare(`SELECT n.id,n.at,n.task_id,n.repo,n.outcome
      FROM action_ledger n JOIN task_ref t ON t.backend = 'built-in'
        AND t.external_id = n.task_id AND t.repo = n.repo AND t.revision_of IS NULL
      WHERE n.id > ? AND n.action = ? AND n.source = 'work' AND n.actor = ?
        AND n.repo IN (SELECT value FROM json_each(?)) AND ${ownerSql} = ?
      ORDER BY n.id LIMIT ?`).all(after, ASSIGNMENT_STATUS_ACTION, actor(owner), JSON.stringify(repos), actor(owner), limit + 1);
    const batch: SavedBatch = { version: 1, id: null, consumer: query.consumer, after, nextCursor: after, hasMore: rows.length > limit, events: [] };
    for (const row of rows.slice(0, limit)) {
      const event = eventFromRow(row, owner);
      if (event === null) return fail("unavailable", "The next saved assignment event is invalid; no event was skipped.");
      batch.events.push(event);
      if (Buffer.byteLength(JSON.stringify(batch)) > MAX_PAGE_BYTES - 128) {
        batch.events.pop();
        if (batch.events.length === 0) return fail("event-too-large", "The next assignment event exceeds the delivery limit; no event was skipped.");
        batch.hasMore = true;
        break;
      }
      batch.nextCursor = event.id;
    }
    if (batch.events.length === 0) return { ok: true as const, batch, replayed: false };
    batch.id = randomBytes(16).toString("hex");
    const id = store.recordAction({ at: now.toISOString(), actor: actor(owner), repo: null, taskId: null, runId: null,
      action: `assignment delivery batch:${key}`, outcome: JSON.stringify(batch), source: "work" });
    store.setServiceCursor(`assignment-inbox:${key}:pending`, id, now);
    return { ok: true as const, batch, replayed: false };
  }));
}

/** ACK advances only the exact issued page, atomically. Replaying any prior
 * ACK is harmless, including while a newer page awaits acknowledgment. */
export function acknowledgeAssignmentDelivery(store: Store, owner: AssignmentOwner, query: { consumer: string; batchId: string }, now: Date): AssignmentDeliveryAckResult {
  if (!validConsumer(query.consumer) || typeof query.batchId !== "string" || !/^[a-f0-9]{32}$/.test(query.batchId))
    return fail("invalid-input", "Use the exact consumer and batch ID returned by the inbox.");
  return store.transact(() => store.savepoint(() => {
    const repos = admittedRepos(store, owner);
    if (repos === null) return fail("unavailable", "The coordinator is no longer active.");
    const key = keyFor(owner, query.consumer), cursorKey = `assignment-inbox:${key}:acked`;
    const cursor = store.serviceCursor(cursorKey), action = `assignment delivery acknowledged:${key}`;
    const acknowledged = store.handle.prepare(`SELECT 1 FROM action_ledger WHERE actor = ? AND action = ? AND source = 'work'
      AND json_extract(outcome, '$.batchId') = ? LIMIT 1`).get(actor(owner), action, query.batchId);
    if (acknowledged) return { ok: true as const, alreadyAcknowledged: true, cursor };
    const pending = pendingBatch(store, owner, key);
    if (pending !== null && "ok" in pending) return pending;
    if (pending === null || pending.id !== query.batchId || pending.consumer !== query.consumer || pending.after !== cursor)
      return fail("stale-batch", "This batch was not issued to this inbox; its cursor has not advanced.");
    // Access loss redacts replayed events; the exact issued page remains
    // acknowledgeable so its inaccessible entries cannot wedge this inbox.
    store.recordAction({ at: now.toISOString(), actor: actor(owner), repo: null, taskId: null, runId: null,
      action, outcome: JSON.stringify({ batchId: pending.id, after: pending.after, cursor: pending.nextCursor }), source: "work" });
    store.setServiceCursor(cursorKey, pending.nextCursor, now);
    store.setServiceCursor(`assignment-inbox:${key}:pending`, 0, now);
    return { ok: true as const, alreadyAcknowledged: false, cursor: pending.nextCursor };
  }));
}
