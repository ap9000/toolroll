/** Private lead catch-up, separate from human notification delivery. These are
 * observed assignment transitions, not a promise to capture every intermediate
 * state between scans. Recording or reading them never dispatches agent work. */
import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import { assignmentOf, type AssignmentSnapshot } from "./assignment.js";
import { publicChatText } from "./chat-display.js";

export const ASSIGNMENT_STATUS_ACTION = "assignment status observed";
export const ASSIGNMENT_STATUS_SOURCE = "work" as const;
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

export type AssignmentStatusEvent = {
  version: 1; digest: string; stateDigest: string;
  assignment: ReturnType<typeof assignmentStatusBrief> & { owner: NonNullable<ReturnType<typeof assignmentStatusBrief>["owner"]> };
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
    if (!object(owner) || !keys(owner, ["kind", "id", "label"]) || !["coordinator", "lead"].includes(String(owner["kind"])) || !string(owner["id"], 128) || !string(owner["label"], 100)) return null;
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
    const assignment = assignmentStatusBrief(snapshot);
    if (assignment.owner === null) return null;
    const stateDigest = hash(assignment);
    const previous = store.handle.prepare("SELECT id,outcome FROM action_ledger WHERE task_id=? AND action=? AND source=? ORDER BY id DESC LIMIT 1")
      .get(snapshot.rootId, ASSIGNMENT_STATUS_ACTION, ASSIGNMENT_STATUS_SOURCE);
    if (previous !== undefined) {
      try { if (JSON.parse(String(previous["outcome"]))?.stateDigest === stateDigest) return null; } catch { /* Preserve an unreadable older event; append the current observation. */ }
    }
    const digest = hash({ rootRef: ref.id, owner: owner.id, previous: previous === undefined ? null : Number(previous["id"]), stateDigest });
    const event: AssignmentStatusEvent = { version: 1, digest, stateDigest, assignment: { ...assignment, owner: assignment.owner } };
    return store.recordAction({ at: now.toISOString(), actor: `${owner.kind}:${owner.id}`, repo: snapshot.repo,
      taskId: snapshot.rootId, runId: assignment.runId, action: ASSIGNMENT_STATUS_ACTION,
      outcome: JSON.stringify(event), source: ASSIGNMENT_STATUS_SOURCE });
  });
}

/** At most fifty roots per pass; the cursor survives process restarts. A full
 * pass cycles back, so changes below the cursor are eventually observed too. */
export function syncAssignmentStatuses(store: Store, now: Date, repos: readonly string[], root?: string): void {
  if (repos.length === 0) return;
  const allowed = [...new Set(repos)].sort();
  const key = `assignment-status:${hash(allowed)}`;
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
}
