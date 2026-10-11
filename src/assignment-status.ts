/** Private lead catch-up, separate from human notification delivery. These are
 * observed assignment transitions, not a promise to capture every intermediate
 * state between scans. Recording or reading them never dispatches agent work.
 * One stream serves every lead: a coordinator's or team lead's events are
 * recorded under its owner, and the built-in lead's crew updates under its
 * follow grant (`follow:<grant>`, lead-follow.ts); each reads its own through
 * the delivery inbox (assignment-delivery.ts). */
import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import { assignmentOf, type AssignmentSnapshot } from "./assignment.js";
import { publicChatText } from "./chat-display.js";
import { sweepIfMoved } from "./sweep-gate.js";

export const ASSIGNMENT_STATUS_ACTION = "assignment status observed";
export const ASSIGNMENT_STATUS_SOURCE = "work" as const;
/** The states that wake a lead: a result to check, a question, completion, or cancellation. */
export const LEAD_WAKE_STATES: readonly AssignmentSnapshot["state"][] = ["ready-to-check", "needs-decision", "complete", "cancelled"];
/** The built-in lead's events, one stream per follow grant. */
export const followActor = (grant: number): string => `follow:${grant}`;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = publicChatText;

/** No saved artifact contents, credential bytes, or polling timestamps. Exact
 * IDs and digests identify the full read; display text is deliberately bounded. */
export function assignmentStatusBrief(assignment: AssignmentSnapshot) {
  const receipt = assignment.receipt;
  const action = assignment.primaryAction;
  return {
    rootId: assignment.rootId, activeTaskId: assignment.activeTaskId,
    title: text(assignment.title, 200), state: assignment.state, detail: text(assignment.detail, 1_000),
    owner: assignment.owner === null ? null : { kind: assignment.owner.kind, id: assignment.owner.id, label: text(assignment.owner.label, 100) },
    runId: assignment.attempts.find(one => one.taskId === assignment.activeTaskId)?.runId ?? receipt?.runId ?? null,
    // The same state can be read by an operator or a coordinator. Permission
    // hints are caller-specific, not a transition or a grant to this consumer.
    primaryAction: action === null ? null : { code: action.code, label: text(action.label, 160), target: action.target },
    attention: assignment.attention.slice(0, 8).map(one => text(one, 500)),
    result: receipt === null ? null : { digest: receipt.digest, runId: receipt.runId,
      checks: { status: receipt.checks.status, exitCode: receipt.checks.exitCode, logArtifactId: receipt.checks.logArtifactId }, checksDigest: hash(receipt.checks) },
    completion: assignment.completion === null ? null : { actor: assignment.completion.actor, digest: assignment.completion.digest },
    publication: assignment.publication === null ? null : { state: text(assignment.publication.state, 80),
      prUrl: /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(assignment.publication.prUrl ?? "") && assignment.publication.prUrl!.length <= 2_000 ? assignment.publication.prUrl : null,
      remoteState: assignment.publication.remoteState === null ? null : text(assignment.publication.remoteState, 80) },
  };
}

/** An owner's events always name it; the built-in lead's follow events name whatever owner the task has, or none. */
export type AssignmentStatusEvent = {
  version: 1; digest: string; stateDigest: string;
  assignment: ReturnType<typeof assignmentStatusBrief>;
};

/** An unreadable ledger event is an explicit consumer error, not a cursor that
 * may silently skip the row. This validates the bounded data, not authority. */
export function parseAssignmentStatusEvent(value: string): AssignmentStatusEvent | null {
  if (Buffer.byteLength(value) > 32_768) return null;
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const string = (v: unknown, n: number): v is string => typeof v === "string" && v.length <= n;
  const sha = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const id = (v: unknown) => v === null || Number.isSafeInteger(v) && Number(v) > 0;
  const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
  try {
    const event: unknown = JSON.parse(value);
    if (!object(event) || !keys(event, ["version", "digest", "stateDigest", "assignment"]) || event["version"] !== 1 || !sha(event["digest"]) || !sha(event["stateDigest"])) return null;
    const a = event["assignment"];
    if (!object(a) || !keys(a, ["rootId", "activeTaskId", "title", "state", "detail", "owner", "runId", "primaryAction", "attention", "result", "completion", "publication"]) ||
      !string(a["rootId"], 64) || !string(a["activeTaskId"], 64) || !string(a["title"], 200) || !string(a["detail"], 1_000) || !id(a["runId"]) ||
      !["working", "checking", "needs-decision", "ready-to-check", "complete", "cancelled"].includes(String(a["state"])) ||
      !Array.isArray(a["attention"]) || a["attention"].length > 8 || !a["attention"].every(one => string(one, 500))) return null;
    const owner = a["owner"], action = a["primaryAction"], result = a["result"], completion = a["completion"], publication = a["publication"];
    if (owner !== null && (!object(owner) || !keys(owner, ["kind", "id", "label"]) || !["coordinator", "lead"].includes(String(owner["kind"])) || !string(owner["id"], 128) || !string(owner["label"], 100))) return null;
    if (action !== null && (!object(action) || !keys(action, ["code", "label", "target"]) || !string(action["code"], 80) || !string(action["label"], 160) ||
      !object(action["target"]) || !keys(action["target"], ["taskId", "runId", "decisionId"]) || !string(action["target"]["taskId"], 64) || !id(action["target"]["runId"]) || !id(action["target"]["decisionId"]))) return null;
    if (result !== null && (!object(result) || !keys(result, ["digest", "runId", "checks", "checksDigest"]) || !sha(result["digest"]) || !id(result["runId"]) || result["runId"] === null || !sha(result["checksDigest"]) ||
      !object(result["checks"]) || !keys(result["checks"], ["status", "exitCode", "logArtifactId"]) ||
      !["passed", "failed", "not-run", "unavailable"].includes(String(result["checks"]["status"])) ||
      !(result["checks"]["exitCode"] === null || Number.isInteger(result["checks"]["exitCode"]) && Number(result["checks"]["exitCode"]) >= 0 && Number(result["checks"]["exitCode"]) <= 255) || !id(result["checks"]["logArtifactId"]))) return null;
    if (completion !== null && (!object(completion) || !keys(completion, ["actor", "digest"]) || !string(completion["actor"], 160) || !sha(completion["digest"]))) return null;
    if (publication !== null && (!object(publication) || !keys(publication, ["state", "prUrl", "remoteState"]) || !string(publication["state"], 80) ||
      !(publication["prUrl"] === null || string(publication["prUrl"], 2_000)) || !(publication["remoteState"] === null || string(publication["remoteState"], 80)))) return null;
    return hash(a) === event["stateDigest"] ? event as AssignmentStatusEvent : null;
  } catch { return null; }
}

/** Call inside the mutation's transaction when possible; independently atomic
 * for worker reconciliation. The latest event, not a permanent digest set,
 * deduplicates retries so Working → Needs decision → Working is retained. */
export function noteAssignmentStatus(store: Store, snapshot: AssignmentSnapshot, now: Date): number | null {
  if (!snapshot.owner?.active || snapshot.repo === null) return null;
  return store.transact(() => {
    const owner = snapshot.owner!;
    const ref = store.lookupRef(snapshot.rootId);
    if (!ref || ref.repo !== snapshot.repo || ref.revisionOf !== null) return null;
    if (owner.kind === "lead") {
      const held = store.handle.prepare("SELECT o.lead,l.status FROM team_task_owner o JOIN team_lead l ON l.id=o.lead WHERE o.task_ref=?").get(ref.id);
      if (held?.["lead"] !== owner.id || held["status"] !== "active") return null;
    } else {
      const claimed = store.handle.prepare("SELECT actor FROM action_ledger WHERE task_id=? AND action='assignment claimed' AND source='work' ORDER BY id DESC LIMIT 1").get(snapshot.rootId);
      if ((claimed === undefined ? ref.coordinatorCid : String(claimed["actor"]).replace(/^coordinator:/, "")) !== owner.id) return null;
      const credential = store.handle.prepare("SELECT projects_json AS repos FROM credential WHERE id=? AND kind='coordinator' AND revoked_at IS NULL").get(owner.id);
      let repos: unknown;
      try { repos = JSON.parse(String(credential?.["repos"] ?? "null")); } catch { return null; }
      if (!Array.isArray(repos) || !repos.includes(snapshot.repo)) return null;
    }
    if (assignmentStatusBrief(snapshot).owner === null) return null;
    return appendStatusEvent(store, `${owner.kind}:${owner.id}`, owner.id, ref.id, snapshot, now);
  });
}

/** The built-in lead's crew update (lead-follow.ts): the same event, under its follow grant. The
 * caller has already proved the grant and its projects; the root must still be a placed task. */
export function noteFollowStatus(store: Store, grant: number, snapshot: AssignmentSnapshot, now: Date): number | null {
  if (snapshot.repo === null) return null;
  return store.transact(() => {
    const ref = store.lookupRef(snapshot.rootId);
    if (!ref || ref.repo !== snapshot.repo || ref.revisionOf !== null) return null;
    return appendStatusEvent(store, followActor(grant), followActor(grant), ref.id, snapshot, now);
  });
}

/** Each reader's latest event, not a permanent digest set, deduplicates its retries, so Working → Needs decision →
 * Working is retained. One reader's events never suppress or duplicate another's. */
function appendStatusEvent(store: Store, actor: string, ownerId: string, rootRef: number, snapshot: AssignmentSnapshot, now: Date): number | null {
  const assignment = assignmentStatusBrief(snapshot);
  const stateDigest = hash(assignment);
  const previous = store.handle.prepare("SELECT id,outcome FROM action_ledger WHERE task_id=? AND action=? AND source=? AND actor=? ORDER BY id DESC LIMIT 1")
    .get(snapshot.rootId, ASSIGNMENT_STATUS_ACTION, ASSIGNMENT_STATUS_SOURCE, actor);
  if (previous !== undefined) {
    try { if (JSON.parse(String(previous["outcome"]))?.stateDigest === stateDigest) return null; } catch { /* Preserve an unreadable older event; append the current observation. */ }
  }
  const digest = hash({ rootRef, owner: ownerId, previous: previous === undefined ? null : Number(previous["id"]), stateDigest });
  const event: AssignmentStatusEvent = { version: 1, digest, stateDigest, assignment };
  return store.recordAction({ at: now.toISOString(), actor, repo: snapshot.repo,
    taskId: snapshot.rootId, runId: assignment.runId, action: ASSIGNMENT_STATUS_ACTION,
    outcome: JSON.stringify(event), source: ASSIGNMENT_STATUS_SOURCE });
}

/** At most fifty roots per pass; the cursor survives process restarts. A full
 * pass cycles back, so changes below the cursor are eventually observed too.
 * A pass is skipped when nothing moved since the cycle began (sweep-gate.ts). */
export function syncAssignmentStatuses(store: Store, now: Date, repos: readonly string[], root?: string): void {
  if (repos.length === 0) return;
  const allowed = [...new Set(repos)].sort();
  const key = `assignment-status:${hash(allowed)}`;
  sweepIfMoved(store, key, now, () => {
    const rows = store.handle.prepare(`SELECT t.id,t.external_id FROM task_ref t
      WHERE t.backend='built-in' AND t.revision_of IS NULL
      AND t.repo IN (SELECT value FROM json_each(?)) AND t.id>?
      AND (t.coordinator_cid IS NOT NULL OR EXISTS(SELECT 1 FROM team_task_owner o WHERE o.task_ref=t.id) OR EXISTS
        (SELECT 1 FROM action_ledger a WHERE a.task_id=t.external_id AND a.action='assignment claimed' AND a.source='work'))
      ORDER BY t.id LIMIT 50`).all(JSON.stringify(allowed), store.serviceCursor(key));
    // Release the writer between families. Each observation and its durable
    // position still commit together; an interrupted sweep resumes after the
    // last committed family instead of holding every heartbeat behind a batch.
    if (rows.length === 0) store.setServiceCursor(key, 0, now);
    for (const [index, row] of rows.entries()) {
      store.transact(() => {
        const snapshot = assignmentOf(store, String(row['external_id']), now, { principal: 'coordinator', repos: allowed }, root);
        if (snapshot !== null) noteAssignmentStatus(store, snapshot, now);
        store.setServiceCursor(key, index === rows.length - 1 && rows.length < 50 ? 0 : Number(row['id']), now);
      });
    }
  });
}
