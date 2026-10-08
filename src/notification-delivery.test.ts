import { expect, test } from "vitest";
import { openStore } from "./store.js";
import { claimNotifications, finalizeNotification, notificationClaimHeld, notificationDestination } from "./notification-delivery.js";

test("destination claims fence duplicate senders, expire, and never claim a personal or resolved notification", () => {
  const store = openStore(":memory:"), now = new Date("2026-10-08T00:00:00Z");
  try {
    for (const key of ["pending", "personal", "resolved"]) store.enqueueNotification({ source: { installation: true }, dedupeKey: key, kind: "test", subject: key, body: key }, now);
    store.handle.exec("UPDATE notification SET recipient = 'alex' WHERE dedupe_key = 'personal'");
    store.resolveEpisode("resolved", now);
    const target = notificationDestination("command", "secret command");
    expect(target).not.toContain("secret");
    const [first] = claimNotifications(store, target, "one", now);
    expect(first!.dedupeKey).toBe("pending");
    expect(claimNotifications(store, target, "two", now)).toEqual([]);
    expect(claimNotifications(store, "another", "two", now)).toHaveLength(1);
    const later = new Date(now.getTime() + 60_000);
    expect(notificationClaimHeld(store, first!, "one", later)).toBe(false);
    expect(finalizeNotification(store, first!, "one", { ok: true, receipt: "late" }, later)).toBe(false);
    const [next] = claimNotifications(store, target, "one", later);
    expect(finalizeNotification(store, first!, "one", { ok: true, receipt: "old generation" }, later)).toBe(false);
    expect(finalizeNotification(store, next!, "one", { ok: false, error: "offline" }, later)).toBe(true);
    const [retry] = claimNotifications(store, target, "one", later);
    expect(finalizeNotification(store, retry!, "one", { ok: true, receipt: "sent" }, later)).toBe(true);
    expect(claimNotifications(store, target, "two", later)).toEqual([]);
    store.resolveEpisode("pending", later);
    expect(notificationClaimHeld(store, first!, "one", now)).toBe(false);
  } finally { store.close(); }
});
