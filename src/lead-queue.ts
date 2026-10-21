/**
 * The personal lead queue (docs/plans/lead-message-queue.md): a message sent while one of its author's personal lead
 * turns runs (or while earlier ones wait) waits here and runs one turn per message, in order — the same machinery
 * shared team conversations use (team-leads.ts), for the person's own threads (/chat, a task's or a project's chat).
 *
 * The row's words are its lead_message (pending until the engine's admission binds it, which clears pending in the
 * same statement). Admission itself is the engine's (runLeadTurn with queuedMessageId + onAdmitted): this module only
 * decides queue-or-run at send, claims the backlog's oldest row, binds, finishes, defers, removes and expires.
 */
import { createHash } from "node:crypto";
import type { Store } from "./store.js";

/** At most this many messages wait per person, and this many characters in all; a waiting message expires after 7 days. */
export const LEAD_QUEUE_MAX_MESSAGES = 10;
export const LEAD_QUEUE_MAX_CHARS = 20_000;
export const LEAD_QUEUE_EXPIRY_MS = 7 * 86_400_000;

/** What a queued message was sent with: resolved and validated at send, re-validated before its turn. */
export type LeadQueueContext = { task?: string; result?: number; mode?: string; project?: string };
export type LeadQueueStatus = "queued" | "running" | "answered" | "failed" | "cancelled" | "uncertain";
export type LeadQueueRow = {
  message: number; thread: number; approver: string; approverGeneration: number; session: number; ceilingDigest: string;
  requestId: string; payloadHash: string; context: LeadQueueContext | null; status: LeadQueueStatus; revision: number;
  generation: number; runner: string | null; turnId: number | null; error: string | null; createdAt: string; text: string;
};
/** A claimed row: the fence every later step re-proves (status running, this runner, this generation and revision). */
export type LeadQueueClaim = LeadQueueRow & { runner: string; status: "running" };

/** The identity of a send: the same request with the same words and context is the same message. */
export function leadQueuePayloadHash(thread: number, text: string, context: LeadQueueContext | null): string {
  return createHash("sha256").update(JSON.stringify([thread, text, context === null ? null : canonical(context)])).digest("hex");
}
const canonical = (context: LeadQueueContext): LeadQueueContext => Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));

const readRow = (row: Record<string, unknown>): LeadQueueRow => ({
  message: Number(row["message"]), thread: Number(row["thread"]), approver: String(row["approver"]), approverGeneration: Number(row["approver_generation"]),
  session: Number(row["session"]), ceilingDigest: String(row["ceiling_digest"]), requestId: String(row["request_id"]), payloadHash: String(row["payload_hash"]),
  context: row["context_json"] === null ? null : JSON.parse(String(row["context_json"])) as LeadQueueContext, status: String(row["status"]) as LeadQueueStatus,
  revision: Number(row["revision"]), generation: Number(row["generation"]), runner: row["runner"] === null ? null : String(row["runner"]),
  turnId: row["turn_id"] === null ? null : Number(row["turn_id"]), error: row["error"] === null ? null : String(row["error"]),
  createdAt: String(row["created_at"]), text: String(row["text"] ?? ""),
});
const SELECT = "SELECT q.*, m.text FROM lead_queue q JOIN lead_message m ON m.id = q.message";

export type SendDecision =
  | { kind: "run" }
  | { kind: "queued"; row: LeadQueueRow; already: boolean }
  | { kind: "conflict" }
  | { kind: "full"; message: string };

export class PersonalQueue {
  constructor(private readonly store: Store) {}
  private get db() { return this.store.handle; }

  /** The approver's backlog: rows waiting or claimed but not yet bound to a turn, oldest first. */
  backlog(approver: string): LeadQueueRow[] {
    return this.db.prepare(`${SELECT} WHERE q.approver = ? AND (q.status = 'queued' OR (q.status = 'running' AND q.turn_id IS NULL)) ORDER BY q.message`).all(approver).map(readRow);
  }

  /** Every queue row of a thread (what the thread shows next to its messages). */
  forThread(thread: number): LeadQueueRow[] {
    return this.db.prepare(`${SELECT} WHERE q.thread = ? ORDER BY q.message`).all(thread).map(readRow);
  }

  get(message: number): LeadQueueRow | null {
    const row = this.db.prepare(`${SELECT} WHERE q.message = ?`).get(message);
    return row === undefined ? null : readRow(row);
  }

  /**
   * Send: run now, or wait — in ONE transaction, so a turn ending between the check and the insert can't strand a
   * message. A request already saved with the same words and context is that message (never a second send, never a
   * removed one resurrected); with different ones it conflicts. Busy means a personal lead turn of this person is
   * queued or running, or something of theirs already waits.
   */
  sendOrQueue(input: { approver: string; approverGeneration: number; session: number; ceilingDigest: string; thread: number; text: string;
    requestId: string; context: LeadQueueContext | null }, now: Date): SendDecision {
    return this.store.transact(() => {
      const hash = leadQueuePayloadHash(input.thread, input.text, input.context);
      const seen = this.db.prepare(`${SELECT} WHERE q.session = ? AND q.request_id = ?`).get(input.session, input.requestId);
      if (seen !== undefined) return String(seen["payload_hash"]) === hash ? { kind: "queued" as const, row: readRow(seen), already: true } : { kind: "conflict" as const };
      const live = this.db.prepare(`SELECT 1 FROM mate_turn WHERE approver = ? AND state IN ('queued','running')
        AND NOT EXISTS (SELECT 1 FROM team_conversation tc WHERE tc.thread = mate_turn.thread) LIMIT 1`).get(input.approver);
      const waiting = this.backlog(input.approver);
      if (live === undefined && waiting.length === 0) return { kind: "run" as const };
      if (waiting.length >= LEAD_QUEUE_MAX_MESSAGES) return { kind: "full" as const, message: `${LEAD_QUEUE_MAX_MESSAGES} messages are already waiting. Remove one, or wait for a reply.` };
      if (waiting.reduce((sum, one) => sum + one.text.length, 0) + input.text.length > LEAD_QUEUE_MAX_CHARS) {
        return { kind: "full" as const, message: "The messages waiting are already long. Remove one, or wait for a reply." };
      }
      const message = this.store.appendLeadMessage({ thread: input.thread, turn: null, role: "operator", text: input.text, pending: true }, now);
      this.db.prepare(`INSERT INTO lead_queue (message, thread, approver, approver_generation, session, ceiling_digest, request_id, payload_hash, context_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`).run(message, input.thread, input.approver, input.approverGeneration, input.session, input.ceilingDigest,
        input.requestId, hash, input.context === null ? null : JSON.stringify(canonical(input.context)), now.toISOString());
      return { kind: "queued" as const, row: this.get(message)!, already: false };
    });
  }

  /**
   * The next message to run: per person, only the oldest of their backlog, only while none of theirs runs, and only when
   * `eligible` agrees (the runtime's admission stamp). Claiming keeps it in the backlog until its turn binds it.
   */
  claimNext(runner: string, now: Date, eligible: (row: LeadQueueRow) => boolean = () => true): LeadQueueClaim | null {
    return this.store.transact(() => {
      // An uncertain row does not hold the person's later messages (unlike a team room): its outcome is shown on it, and
      // an unknown cost already pauses chat through its own latch.
      const heads = this.db.prepare(`${SELECT} WHERE q.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM lead_queue r WHERE r.approver = q.approver AND r.status = 'running')
        AND NOT EXISTS (SELECT 1 FROM lead_queue e WHERE e.approver = q.approver AND e.status = 'queued' AND e.message < q.message)
        ORDER BY q.message LIMIT 50`).all().map(readRow);
      for (const row of heads) {
        if (!eligible(row)) continue;
        const changed = this.db.prepare("UPDATE lead_queue SET status = 'running', generation = generation + 1, runner = ?, claimed_at = ? WHERE message = ? AND status = 'queued'")
          .run(runner, now.toISOString(), row.message);
        if (Number(changed.changes) !== 1) continue;
        return { ...row, status: "running" as const, runner, generation: row.generation + 1 };
      }
      return null;
    });
  }

  /** The claim still stands: running, this runner, this generation and revision, unbound or bound to `turn`. */
  current(claim: LeadQueueClaim): boolean {
    return this.db.prepare("SELECT 1 FROM lead_queue WHERE message = ? AND status = 'running' AND runner = ? AND generation = ? AND revision = ?")
      .get(claim.message, claim.runner, claim.generation, claim.revision) !== undefined;
  }

  /** Inside the engine's admission transaction (onAdmitted): the claim binds to the turn that took it, exactly once. */
  bindTurn(claim: LeadQueueClaim, turnId: number): boolean {
    if (!this.current(claim)) return false;
    const turn = this.store.getLeadTurn(turnId);
    if (turn === null || turn.thread !== claim.thread || turn.approver !== claim.approver) return false;
    return Number(this.db.prepare("UPDATE lead_queue SET turn_id = ? WHERE message = ? AND turn_id IS NULL AND status = 'running' AND generation = ?")
      .run(turnId, claim.message, claim.generation).changes) === 1;
  }

  /** The claim ends: answered (its turn's reply is in the thread), failed or cancelled (words kept as the error), or
   * uncertain (an outcome that can't be confirmed — never sent again). A message that never got a turn loses its words. */
  finish(claim: LeadQueueClaim, result: { status: "answered" | "failed" | "cancelled" | "uncertain"; error?: string; turnId?: number }, now: Date): boolean {
    return this.store.transact(() => {
      const row = this.db.prepare("SELECT turn_id FROM lead_queue WHERE message = ? AND status = 'running' AND runner = ? AND generation = ?").get(claim.message, claim.runner, claim.generation);
      if (row === undefined) return false;
      if (result.turnId !== undefined && row["turn_id"] !== null && Number(row["turn_id"]) !== result.turnId) return false;
      this.db.prepare("UPDATE lead_queue SET status = ?, error = ?, turn_id = COALESCE(turn_id, ?), revision = revision + 1, settled_at = ? WHERE message = ?")
        .run(result.status, result.error ?? null, result.turnId ?? null, now.toISOString(), claim.message);
      if (row["turn_id"] === null && result.turnId === undefined) this.forgetWords(claim.message);
      return true;
    });
  }

  /** A refusal before admission (a cap, a budget, a latch, another turn): back to waiting with the words to show. */
  defer(claim: LeadQueueClaim, error: string): boolean {
    return Number(this.db.prepare(`UPDATE lead_queue SET status = 'queued', generation = generation + 1, revision = revision + 1, runner = NULL, claimed_at = NULL, error = ?
      WHERE message = ? AND status = 'running' AND turn_id IS NULL AND runner = ? AND generation = ?`).run(error, claim.message, claim.runner, claim.generation).changes) === 1;
  }

  /** Remove a waiting message (its author only, while it still waits): its words are forgotten, its request kept. */
  remove(approver: string, message: number, now: Date): "removed" | "started" | "not-found" {
    return this.store.transact(() => {
      const row = this.db.prepare("SELECT status FROM lead_queue WHERE message = ? AND approver = ?").get(message, approver);
      if (row === undefined) return "not-found";
      if (row["status"] !== "queued") return "started";
      this.db.prepare("UPDATE lead_queue SET status = 'cancelled', error = 'Removed.', revision = revision + 1, settled_at = ? WHERE message = ?").run(now.toISOString(), message);
      this.forgetWords(message);
      return "removed";
    });
  }

  /** Settle rows whose bound turn ended (by its recorded state), expire week-old waiting rows, and mark a claim that
   * never bound by its turn deadline uncertain (the binding is the proof; elapsed time never resends). */
  reconcile(now: Date, turnDeadlineMs: number): number {
    return this.store.transact(() => {
      let changed = 0;
      for (const row of this.db.prepare(`SELECT q.message, t.state, t.failure_reason FROM lead_queue q JOIN mate_turn t ON t.id = q.turn_id
        WHERE q.status = 'running' AND t.state IN ('answered','failed')`).all()) {
        const uncertain = this.store.leadTurnCostUnconfirmed(Number(this.db.prepare("SELECT turn_id FROM lead_queue WHERE message = ?").get(Number(row["message"]))!["turn_id"]));
        const status = row["state"] === "answered" ? "answered" : uncertain ? "uncertain" : "failed";
        changed += Number(this.db.prepare("UPDATE lead_queue SET status = ?, error = ?, revision = revision + 1, settled_at = ? WHERE message = ? AND status = 'running'")
          .run(status, status === "answered" ? null : String(row["failure_reason"] ?? "failed"), now.toISOString(), Number(row["message"])).changes);
      }
      const stale = new Date(now.getTime() - turnDeadlineMs).toISOString();
      changed += Number(this.db.prepare("UPDATE lead_queue SET status = 'uncertain', error = 'Delivery could not be confirmed. Nothing was sent again.', revision = revision + 1, settled_at = ? WHERE status = 'running' AND turn_id IS NULL AND claimed_at < ?")
        .run(now.toISOString(), stale).changes);
      const old = new Date(now.getTime() - LEAD_QUEUE_EXPIRY_MS).toISOString();
      for (const row of this.db.prepare("SELECT message FROM lead_queue WHERE status = 'queued' AND created_at < ?").all(old)) {
        this.db.prepare("UPDATE lead_queue SET status = 'failed', error = 'Not sent: it waited too long.', revision = revision + 1, settled_at = ? WHERE message = ?").run(now.toISOString(), Number(row["message"]));
        this.forgetWords(Number(row["message"]));
        changed++;
      }
      return changed;
    });
  }

  /** End every waiting message sent under a session (it ended, or its person's chat was revoked). */
  cancelForSession(session: number, why: string, now: Date): number {
    return this.store.transact(() => {
      const rows = this.db.prepare("SELECT message FROM lead_queue WHERE session = ? AND status = 'queued'").all(session);
      for (const row of rows) {
        this.db.prepare("UPDATE lead_queue SET status = 'cancelled', error = ?, revision = revision + 1, settled_at = ? WHERE message = ?").run(why, now.toISOString(), Number(row["message"]));
        this.forgetWords(Number(row["message"]));
      }
      return rows.length;
    });
  }

  /** A message that never ran keeps no words: its lead_message is blanked (it stays pending, so never history). */
  private forgetWords(message: number): void {
    this.db.prepare("UPDATE lead_message SET text = '' WHERE id = ? AND pending = 1").run(message);
  }
}
