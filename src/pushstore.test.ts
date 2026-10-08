import { claimNotifications, finalizeNotification } from "./notification-delivery.js";
/**
 * The push ledgers (arc 3, v23): enrollment with a transactional
 * high-water mark, pair seeding that never backfills, claim/fence/settle
 * conditional on owner + generation, retirement that settles claimed
 * pairs, and episode notifications that recur after resolution.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS } from "./telegram.js";

const T0 = new Date("2026-08-24T18:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

let store: Store;
let approverToken: string;
beforeEach(() => {
  store = openStore(":memory:");
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap");
  approverToken = added.token;
});

const enroll = (endpoint = "https://fcm.googleapis.com/fcm/send/abc", extra: Record<string, unknown> = {}) =>
  store.enrollPushSubscription(
    {
      endpoint,
      p256dh: "B".repeat(87),
      auth: "a".repeat(22),
      approver: "alex",
      approverGeneration: 1,
      uaWords: "a phone",
      vapidFingerprint: "fp-1",
      ...extra,
    } as Parameters<Store["enrollPushSubscription"]>[0],
    T0,
  );

const stamped = (key: string, at: Date = T0) =>
  store.enqueueNotification(
    { dedupeKey: key, kind: "decision", subject: "s", body: "b", pushClass: "decision", link: "/d/1" },
    at,
  );

describe("enrollment", () => {
  test("the high-water mark: only notifications newer than the enrollment ever pair", () => {
    stamped("old:1");
    const made = enroll();
    expect(made).toMatchObject({ ok: true, replayed: false });
    expect(store.seedPushPairs(T0)).toBe(0); // the old fact never pages this phone
    stamped("new:1", later(1_000));
    expect(store.seedPushPairs(later(1_000))).toBe(1);
  });

  test.each(["telegram", "slack", "discord", "teams"])("a met promise made on %s is said there: a phone's push pair for it is settled, never sent", channel => {
    enroll();
    store.enqueueNotification({ dedupeKey: `lead-promise:${channel}:1`, kind: "lead-say", subject: "Lead", body: "It is time.", pushClass: "attention", recipient: "alex" }, later(1_000));
    expect(store.seedPushPairs(later(1_000))).toBe(1);
    expect(store.handle.prepare("SELECT state, last_error FROM push_delivery").all()).toEqual([{ state: "retired", last_error: "skipped:for-another-chat" }]);
    expect(store.claimPushPairs("o", 60_000, 10, later(2_000))).toEqual([]);
  });

  test("a met promise made in the console or app still reaches the phone", () => {
    enroll();
    store.enqueueNotification({ dedupeKey: "lead-promise:chat:1", kind: "lead-say", subject: "Lead", body: "It is time.", pushClass: "attention", recipient: "alex" }, later(1_000));
    expect(store.seedPushPairs(later(1_000))).toBe(1);
    expect(store.claimPushPairs("o", 60_000, 10, later(2_000))).toHaveLength(1);
  });

  test("identical live enrollment is idempotent; a conflicting binding is replaced", () => {
    const first = enroll();
    if (!first.ok) throw new Error("enroll");
    const again = enroll();
    expect(again).toMatchObject({ ok: true, replayed: true, id: first.id });
    // Same endpoint, different generation: the old activation retires.
    const replaced = enroll("https://fcm.googleapis.com/fcm/send/abc", { approverGeneration: 2 });
    expect(replaced).toMatchObject({ ok: true, replayed: false });
    const rows = store.listPushSubscriptions("alex");
    expect(rows.find(one => one.id === first.id)?.retiredReason).toBe("replaced");
  });

  test("caps: five per approver", () => {
    for (let i = 0; i < 5; i += 1) expect(enroll(`https://fcm.googleapis.com/fcm/send/${i}`)).toMatchObject({ ok: true });
    expect(enroll("https://fcm.googleapis.com/fcm/send/sixth")).toMatchObject({ ok: false, reason: "approver-cap" });
  });
});

describe("the pair machine", () => {
  test("legacy and Telegram success leave push claims and receipts independent", async () => {
    enroll();
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, T0);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: "bot", chatId: "chat", userId: "user", updateId: 1 }, T0).ok).toBe(true);
    store.enqueueNotification({ source: { installation: true }, dedupeKey: "independent", kind: "attention", subject: "Attention", body: "Check settings", pushClass: "attention" }, T0);
    store.seedPushPairs(T0);
    const [push] = store.claimPushPairs("push", 60_000, 1, T0);
    const [legacy] = claimNotifications(store, "webhook:slack:fixture", "legacy", T0);
    expect(finalizeNotification(store, legacy!, "legacy", { ok: true, receipt: "slack" }, T0)).toBe(true);

    const transport = async (method: string) => ({ ok: true, result: method === "sendMessage" ? { message_id: 7 } : [] });
    expect(await bridgePass(store, { botId: "bot", transport, clock: () => T0 })).toMatchObject({ ok: true, report: { sent: 1 } });
    expect(store.pushSendFence(push!.id, "push", push!.claimGeneration)).not.toBeNull();
    expect(store.settlePushPair(push!.id, "push", push!.claimGeneration, { kind: "accepted" }, T0)).toBe(true);
    expect(store.telegramDeliveries(store.liveTelegramBinding("bot")!)[0]?.receipt).toBe("telegram:bot:chat:7");
  });

  const pairUp = () => {
    enroll();
    stamped("d:1", later(500));
    store.seedPushPairs(later(1_000));
    const pairs = store.claimPushPairs("sender-1", 60_000, 10, later(1_000));
    expect(pairs.length).toBe(1);
    return pairs[0]!;
  };

  test("claim → fence → settle accepted, conditional on owner and generation", () => {
    const pair = pairUp();
    const fenced = store.pushSendFence(pair.id, "sender-1", pair.claimGeneration);
    expect(fenced).not.toBeNull();
    expect(fenced?.notificationRow.link).toBe("/d/1");
    // A stranger's settle writes nothing; the owner's lands.
    expect(store.settlePushPair(pair.id, "sender-2", pair.claimGeneration, { kind: "accepted" }, later(2_000))).toBe(false);
    expect(store.settlePushPair(pair.id, "sender-1", pair.claimGeneration, { kind: "accepted" }, later(2_000))).toBe(true);
    expect(store.settlePushPair(pair.id, "sender-1", pair.claimGeneration, { kind: "accepted" }, later(3_000))).toBe(false);
  });

  test("an expired claim reclaims with a bumped generation — the old owner loses every write", () => {
    const pair = pairUp();
    const reclaimed = store.claimPushPairs("sender-2", 60_000, 10, later(120_000));
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0]!.claimGeneration).toBeGreaterThan(pair.claimGeneration);
    expect(store.settlePushPair(pair.id, "sender-1", pair.claimGeneration, { kind: "accepted" }, later(121_000))).toBe(false);
    expect(store.pushSendFence(pair.id, "sender-1", pair.claimGeneration)).toBeNull();
  });

  test("a resolved notification fails the send fence — no page for yesterday", () => {
    const pair = pairUp();
    store.resolveEpisodes("d", later(1_500));
    expect(store.pushSendFence(pair.id, "sender-1", pair.claimGeneration)).toBeNull();
  });

  test("retirement settles CLAIMED pairs too, and the in-flight fence dies", () => {
    const pair = pairUp();
    store.retirePushSubscription(pair.subscription, "gone", later(1_500));
    expect(store.pushSendFence(pair.id, "sender-1", pair.claimGeneration)).toBeNull();
    expect(store.settlePushPair(pair.id, "sender-1", pair.claimGeneration, { kind: "accepted" }, later(2_000))).toBe(false);
  });

  test("credential rotation retires enrollments and their pairs", () => {
    const pair = pairUp();
    // Rotation via the derived-authority sweep (same path Telegram uses).
    const rotated = addApprover(store, "alex", later(2_000), { name: "alex", token: approverToken });
    expect(rotated.ok).toBe(true);
    expect(store.listPushSubscriptions("alex")[0]?.retiredReason).toBe("credential-rotation");
    expect(store.pushSendFence(pair.id, "sender-1", pair.claimGeneration)).toBeNull();
  });

  test("backoff reschedules and counts; key rotation retires other-key enrollments", () => {
    const pair = pairUp();
    expect(
      store.settlePushPair(pair.id, "sender-1", pair.claimGeneration, { kind: "backoff", nextAttemptAt: later(60_000), error: "503" }, later(2_000)),
    ).toBe(true);
    expect(store.claimPushPairs("sender-1", 60_000, 10, later(30_000)).length).toBe(0); // not due yet
    expect(store.claimPushPairs("sender-1", 60_000, 10, later(61_000)).length).toBe(1);
    expect(store.retirePushSubscriptionsOfOtherKeys("fp-2", later(70_000))).toBe(1);
    expect(store.listPushSubscriptions("alex")[0]?.retiredReason).toBe("key-rotated");
  });
});

describe("episode notifications (finding 23)", () => {
  test("one open episode nags; resolution closes it; recurrence pages again", () => {
    expect(store.enqueueEpisode("merge:alex/thing:7", { kind: "merge", subject: "s", body: "b", pushClass: "merge", link: "/review" }, "e1", T0)).toBe(true);
    expect(store.enqueueEpisode("merge:alex/thing:7", { kind: "merge", subject: "s", body: "b" }, "e2", later(1_000))).toBe(false);
    expect(store.resolveEpisodes("merge:alex/thing:7", later(2_000))).toBe(1);
    expect(store.enqueueEpisode("merge:alex/thing:7", { kind: "merge", subject: "s", body: "b" }, "e3", later(3_000))).toBe(true);
  });
});

describe("the v22 → v23 migration", () => {
  test("an existing database gains the push tables and columns, reopened twice", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "standing-orders-v23-"));
    const file = join(dir, "orders.db");
    try {
      openStore(file).close();
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require("node:sqlite");
      const raw = new DatabaseSync(file);
      raw.exec(
        "DROP TABLE service_cursor; DROP INDEX IF EXISTS push_delivery_due; DROP TABLE IF EXISTS push_delivery;" +
          "DROP INDEX IF EXISTS push_subscription_live; DROP TABLE IF EXISTS push_subscription;" +
          "UPDATE schema_version SET version = 22;",
      );
      raw.close();
      openStore(file).close();
      const migrated = openStore(file);
      try {
        const added = addApprover(migrated, "casey", T0);
        if (!added.ok) throw new Error("approver");
        expect(
          migrated.enrollPushSubscription(
            { endpoint: "https://updates.push.services.mozilla.com/x", p256dh: "B", auth: "a", approver: "casey", approverGeneration: 1, uaWords: "w", vapidFingerprint: "fp" },
            T0,
          ),
        ).toMatchObject({ ok: true });
        const version = (migrated as unknown as { db: { prepare(sql: string): { get(): Record<string, unknown> } } }).db
          .prepare("SELECT version FROM schema_version")
          .get();
        expect(Number(version["version"])).toBe(SCHEMA_VERSION);
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
