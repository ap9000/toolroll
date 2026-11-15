import { createHash } from "node:crypto";
import type { Notification, Store } from "./store.js";
import { envTwins } from "./names.js";
import { outboundPrivate, safeWords } from "./outbound-privacy.js";

/** What the operator's delivery command (`outbox deliver --cmd`) is handed for one notification. It may forward it
 * anywhere (a chat, a pager, mail), so it gets what every outbound message gets (outbound-privacy.ts): words that name a
 * key or a folder on this computer go as the safe version — the project's name and "Open it in Toolroll" — never as written. */
export function notificationCommandEnv(row: Pick<Notification, "kind" | "subject" | "body" | "dedupeKey" | "project">): Record<string, string> {
  const withheld = outboundPrivate([row.subject, row.body]);
  return {
    ...envTwins("KIND", row.kind),
    ...envTwins("SUBJECT", withheld ? safeWords({ project: row.project }) : row.subject),
    ...envTwins("BODY", withheld ? "" : row.body),
    ...envTwins("DEDUPE_KEY", row.dedupeKey),
  };
}

type Claim = Notification & { destination: string; generation: number };
/** URLs and shell commands can contain secrets. Only a destination hash enters saved receipts. */
export function notificationDestination(kind: string, target: string): string {
  return `${kind}:${createHash("sha256").update(target).digest("hex")}`;
}

/** One-release compatibility for operator-configured, installation-wide senders. Personal notifications never leave here. */
export function claimNotifications(store: Store, destination: string, owner: string, now: Date): Claim[] {
  return store.transact(() => {
    const db = store.handle, stamp = now.toISOString();
    db.prepare(`INSERT OR IGNORE INTO notification_delivery(notification, destination)
      SELECT id, ? FROM notification WHERE resolved_at IS NULL AND recipient IS NULL`).run(destination);
    const claims = db.prepare(`SELECT d.notification, d.claim_generation FROM notification_delivery d
      JOIN notification n ON n.id = d.notification WHERE d.destination = ? AND n.resolved_at IS NULL AND n.recipient IS NULL
      AND d.delivered_at IS NULL AND (d.receipt IS NULL OR d.receipt NOT LIKE 'skipped:%')
      AND (d.claim_owner IS NULL OR d.claim_expires_at <= ?) ORDER BY n.id`).all(destination, stamp);
    return claims.map(raw => {
      const id = Number(raw["notification"]), generation = Number(raw["claim_generation"]) + 1;
      db.prepare(`UPDATE notification_delivery SET claim_owner = ?, claim_expires_at = ?, claim_generation = ?
        WHERE notification = ? AND destination = ?`).run(owner, new Date(now.getTime() + 60_000).toISOString(), generation, id, destination);
      return { ...store.notificationById(id)!, destination, generation };
    });
  });
}

export function finalizeNotification(store: Store, row: Claim, owner: string,
  outcome: { ok: true; receipt: string | null } | { ok: false; error: string }, now: Date): boolean {
  const skipped = outcome.ok && outcome.receipt?.startsWith("skipped:");
  return Number(store.handle.prepare(`UPDATE notification_delivery SET attempts = attempts + 1, last_attempt_at = ?,
    delivered_at = ?, receipt = ?, last_error = ?, claim_owner = NULL, claim_expires_at = NULL
    WHERE notification = ? AND destination = ? AND claim_owner = ? AND claim_generation = ?
      AND claim_expires_at > ? AND delivered_at IS NULL`).run(now.toISOString(), outcome.ok && !skipped ? now.toISOString() : null,
    outcome.ok ? outcome.receipt : null, outcome.ok ? null : outcome.error,
    row.id, row.destination, owner, row.generation, now.toISOString()).changes) === 1;
}


/** Recheck after earlier network sends: expiry or resolution must stop this send, not just its receipt. */
export function notificationClaimHeld(store: Store, row: Claim, owner: string, now: Date): boolean {
  return store.handle.prepare(`SELECT 1 FROM notification_delivery d JOIN notification n ON n.id = d.notification
    WHERE d.notification = ? AND d.destination = ? AND d.claim_owner = ? AND d.claim_generation = ?
    AND d.claim_expires_at > ? AND d.delivered_at IS NULL AND n.resolved_at IS NULL AND n.recipient IS NULL`)
    .get(row.id, row.destination, owner, row.generation, now.toISOString()) !== undefined;
}
