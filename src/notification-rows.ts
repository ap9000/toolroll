/** Saved notifications, read and told apart without a store: the row readers, the lifecycle key and the predicates
 * the store and the chat core (chat-messages.ts) share. A leaf: it imports types only. */
import type { MateProposal, Notification, NotificationReceipt } from "./store.js";

/** The one task a card is about: a task its confirmation created (a new
 * task, a revision), else the task it names (and, for feedback on a result,
 * that result). Null for a card about no single task. A pointer for
 * replies, never an authority. */
export function proposalTaskOf(proposal: MateProposal | null): { task: string; run: number | null } | null {
  if (proposal === null) return null;
  const named = typeof proposal.payload["task"] === "string" && proposal.payload["task"] !== "" ? proposal.payload["task"] : null;
  const creates = proposal.kind === "task" || (proposal.kind === "review" && proposal.payload["operation"] === "revise");
  const made = creates && proposal.state === "confirmed" ? proposal.outcome?.["taskId"] : undefined;
  if (typeof made === "string" && made !== "" && made !== named) return { task: made, run: null };
  if (named === null) return null;
  const run = proposal.kind === "review" ? proposal.payload["run"] : null;
  return { task: named, run: typeof run === "number" && Number.isSafeInteger(run) ? run : null };
}

/** Every lifecycle dedupe key starts here: `life:<kind>:<identity>:<ordinal>`. */
export const LIFECYCLE_KEY_PREFIX = "life:";

/**
 * Task lifecycle updates (Telegram task updates, 2026-09-16): the CLOSED
 * vocabulary of routine progress facts the shared mutations record beside
 * the change that made them true. None carries a push class — they are
 * digest-eligible progress, never a page — and every one is project-bound
 * through the task it names. A decision, incident, gap, stall, publication
 * or merge page keeps its own producer; nothing here repeats one.
 */
export const LIFECYCLE_KINDS = [
  "task-filed",
  "scope-approved",
  "approval-withdrawn",
  "task-held",
  "task-released",
  "task-queued",
  "task-requeued",
  "task-cancelled",
  "run-started",
  "run-phase",
  "check-progress",
  "run-finished",
  "run-stopping",
  "run-stopped",
  "run-resumed",
  "review-requested",
  "review-finished",
  "acceptance-evidence",
  "acceptance-ready",
] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];
/** A progress fact, told apart by its durable key — never by display text. */
export function isLifecycleNotification(row: Pick<Notification, "dedupeKey">): boolean {
  return row.dedupeKey.startsWith(LIFECYCLE_KEY_PREFIX);
}

/** Only known progress producers can repaint a card. Decisions and urgent
 * incidents keep their own alerts; a routine retry updates its saved attempt. */
export function isTelegramProgressNotification(row: Pick<Notification, "dedupeKey" | "kind" | "pushClass" | "run">): boolean {
  if (row.kind === "check-progress" && row.pushClass === "progress" && row.run !== null) return isLifecycleNotification(row);
  if (row.pushClass !== null) return false;
  if (row.kind === "build-failed" && row.run !== null && row.dedupeKey === `run:${row.run}:failed`) return true;
  // The owner's lead took the attempt on, or let it lapse (lead-voice.ts): its card repaints in place.
  if ((row.kind === "lead-on-it" || row.kind === "lead-lapsed") && row.run !== null) return true;
  return isLifecycleNotification(row) &&
    ["run-started", "run-phase", "run-finished", "review-requested", "review-finished", "run-stopping", "run-stopped", "run-resumed", "task-held", "task-released"].includes(row.kind);
}

export function readNotification(row: Record<string, unknown>): Notification {
  return {
    id: Number(row["id"]),
    recipient: row["recipient"] == null ? null : String(row["recipient"]),
    dedupeKey: String(row["dedupe_key"]),
    scope: row["provenance_scope"] as Notification["scope"],
    project: row["project"] == null ? null : String(row["project"]),
    taskRef: row["task_ref"] == null ? null : Number(row["task_ref"]),
    taskId: row["task_id"] == null ? null : String(row["task_id"]),
    run: row["source_run"] == null ? null : Number(row["source_run"]),
    kind: String(row["kind"]),
    subject: String(row["subject"]),
    body: String(row["body"]),
    createdAt: String(row["created_at"]),
    resolvedAt:
      row["resolved_at"] === null || row["resolved_at"] === undefined
        ? null
        : String(row["resolved_at"]),
    pushClass:
      (row["push_class"] === null || row["push_class"] === undefined) && String(row["kind"]) === "check-progress"
        ? "progress"
        : row["push_class"] === null || row["push_class"] === undefined
        ? null
        : (String(row["push_class"]) as Notification["pushClass"]),
    link: row["link"] === null || row["link"] === undefined ? null : String(row["link"]),
  };
}

export function readNotificationReceipt(row: Record<string, unknown>): NotificationReceipt {
  return {
    ...readNotification(row),
    attempts: Number(row["attempts"]),
    lastAttemptAt: row["last_attempt_at"] == null ? null : String(row["last_attempt_at"]),
    lastError: row["last_error"] == null ? null : String(row["last_error"]),
    deliveredAt: row["delivered_at"] == null ? null : String(row["delivered_at"]),
    receipt: row["receipt"] == null ? null : String(row["receipt"]),
  };
}
