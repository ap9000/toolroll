/**
 * v126 step 4 (docs/plans/webhook-tasks.md §4): floods. What doesn't prove itself is counted per address and, past 60
 * a minute, answered 429 with nothing written, without ever crowding out a signed delivery. At most 30 cards an hour
 * per trigger, decided in the card's own transaction: a signed delivery over it is held whole and made into its card
 * when the hour has room, oldest first; an unsigned one is turned away. Beyond 200 held, deliveries are turned away and
 * counted on the trigger until a person clears it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { flowFromSteps } from "./flows.js";
import { addFlowTriggerTo, drainHeldDeliveries, receiveFlowHook, runFlowTriggers, setUpFlowHook, type TriggerIo } from "./flow-triggers.js";
import { CARDS_PER_HOUR, HELD_AT_MOST, UNPROVEN_PER_MINUTE } from "./webhook-limits.js";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const REPO = "/test/shop";
const NO_IO: TriggerIo = { gh: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: false }), fetch, dir: null };

let dir: string, file: string, store: Store, flow: number;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-floods-")));
  file = join(dir, "orders.db");
  store = openStore(file);
  flow = store.createFlow({ repo: REPO, name: "Intake", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const cards = (s: Store = store) => Number(s.handle.prepare("SELECT COUNT(*) AS n FROM flow_card WHERE flow = ?").get(flow)?.["n"]);
const receipts = (id: number) => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM flow_trigger_event WHERE trigger = ?").get(id)?.["n"]);
function signedHook(s: Store = store) {
  const made = addFlowTriggerTo(s, s.getFlow(flow)!, { kind: "webhook", sender: "github-style" }, "alex", T0, dir);
  if (!made.ok) throw new Error(made.message);
  const setUp = setUpFlowHook(s, s.getFlowTrigger(made.id)!, T0, dir);
  if (!setUp.ok) throw new Error(setUp.message);
  const token = made.reveal!.path.slice("/hooks/flow/".length), secret = setUp.reveal!.secret!;
  const send = (title: string, now = T0, into: Store = s) => {
    const body = JSON.stringify({ title });
    return receiveFlowHook(into, token, { headers: { "x-hub-signature-256": [`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`] }, body: Buffer.from(body) }, dir, now);
  };
  return { id: made.id, token, send, forged: (now = T0) => receiveFlowHook(s, token, { headers: { "x-hub-signature-256": [`sha256=${"0".repeat(64)}`] }, body: Buffer.from("{}") }, dir, now) };
}
function unsignedHook() {
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook" }, "alex", T0, dir);
  if (!made.ok) throw new Error(made.message);
  const token = made.reveal!.path.slice("/hooks/flow/".length);
  return { id: made.id, send: (title: string, now = T0) => receiveFlowHook(store, token, { headers: {}, body: Buffer.from(JSON.stringify({ title })) }, dir, now) };
}

describe("what doesn't prove itself", () => {
  test("past 60 a minute, forged deliveries get 429 with a time to retry and write nothing; a signed one right after is still taken", () => {
    const hook = signedHook();
    for (let i = 0; i < UNPROVEN_PER_MINUTE; i++) expect(hook.forged().status).toBe(401);
    expect(hook.forged()).toMatchObject({ status: 429, retryAfter: expect.any(Number) });
    expect(receipts(hook.id)).toBe(0);
    expect(hook.send("Real one")).toEqual({ status: 202, said: "Added 1 card." });
    // A minute on, the count has cleared.
    expect(hook.forged(at(1.1)).status).toBe(401);
  });

  test("unknown addresses share one count", () => {
    const ghost = (n: number) => receiveFlowHook(store, `${"x".repeat(30)}${n}`, { headers: {}, body: Buffer.from("{}") }, dir, T0);
    for (let i = 0; i < UNPROVEN_PER_MINUTE; i++) expect(ghost(i).status).toBe(404);
    expect(ghost(999).status).toBe(429);
  });

  test("an unsigned webhook has nothing to prove: every delivery counts, and past the limit nothing is written", () => {
    const hook = unsignedHook();
    for (let i = 0; i < UNPROVEN_PER_MINUTE; i++) hook.send(`flood ${i}`, at(i / 1000));
    const before = cards();
    expect(hook.send("one more", at(0.07))).toMatchObject({ status: 429 });
    expect(cards()).toBe(before);
  });
});

describe("the hourly card limit", () => {
  test("a signed delivery over it is held whole, and the next pass after the hour makes it, oldest first", async () => {
    const hook = signedHook();
    for (let i = 0; i < CARDS_PER_HOUR; i++) expect(hook.send(`card ${i}`, at(i)).status).toBe(202);
    expect(cards()).toBe(CARDS_PER_HOUR);
    expect(hook.send("held first", at(31))).toEqual({ status: 202, said: "Held: it will be added when there's room." });
    expect(hook.send("held second", at(32))).toEqual({ status: 202, said: "Held: it will be added when there's room." });
    expect(hook.send("held first", at(33))).toEqual({ status: 202, said: "Already received; waiting for room." });
    expect(store.getFlowTrigger(hook.id)!.lastOutcome).toBe("Too many in the last hour: new deliveries are held until there's room.");
    expect(cards()).toBe(CARDS_PER_HOUR);
    // Still within the hour: nothing moves.
    expect((await runFlowTriggers(store, REPO, at(40), NO_IO)).added).toBe(0);
    // An hour after the first card, one slot is free: the oldest held delivery takes it; a minute later, the next.
    expect((await runFlowTriggers(store, REPO, at(60.5), NO_IO)).added).toBe(1);
    expect(store.handle.prepare("SELECT title FROM flow_card WHERE flow = ? ORDER BY id DESC LIMIT 1").get(flow)?.["title"]).toBe("held first");
    expect((await runFlowTriggers(store, REPO, at(61.5), NO_IO)).added).toBe(1);
    expect(store.heldFlowReceiptCount(hook.id)).toBe(0);
  });

  test("an unsigned delivery over it is turned away and written nowhere", () => {
    const hook = unsignedHook();
    for (let i = 0; i < CARDS_PER_HOUR; i++) hook.send(`card ${i}`, at(i * 1.5));
    expect(hook.send("one too many", at(50))).toMatchObject({ status: 429, retryAfter: 3600 });
    expect(cards()).toBe(CARDS_PER_HOUR);
    expect(store.heldFlowReceiptCount(hook.id)).toBe(0);
  });

  test("two handles on one database competing for the last slot: one card, one held", () => {
    const hook = signedHook();
    for (let i = 0; i < CARDS_PER_HOUR - 1; i++) hook.send(`card ${i}`, at(i));
    const other = openStore(file);
    try {
      const a = hook.send("from A", at(40));
      const b = hook.send("from B", at(40), other);
      expect([a.said, b.said].sort()).toEqual(["Added 1 card.", "Held: it will be added when there's room."]);
      expect(cards()).toBe(CARDS_PER_HOUR);
    } finally { other.close(); }
  });

  test("a queue held through an outage is drained after a restart at most 30 an hour, counted when each card is made", () => {
    const hook = signedHook();
    for (let i = 0; i < CARDS_PER_HOUR; i++) hook.send(`card ${i}`, at(0));
    for (let i = 0; i < 45; i++) hook.send(`held ${i}`, at(1));
    store.close();
    store = openStore(file);
    // Three hours later: the first hour's cards are long out of the window; the held ones arrived long ago too.
    expect(drainHeldDeliveries(store, store.getFlowTrigger(hook.id)!, at(180))).toBe(CARDS_PER_HOUR);
    expect(store.heldFlowReceiptCount(hook.id)).toBe(15);
    expect(drainHeldDeliveries(store, store.getFlowTrigger(hook.id)!, at(200))).toBe(0);
    expect(drainHeldDeliveries(store, store.getFlowTrigger(hook.id)!, at(241))).toBe(15);
  });

  test("a held delivery is screened before it is kept: one that looks like it holds a key is left out, not held", () => {
    const hook = signedHook();
    for (let i = 0; i < CARDS_PER_HOUR; i++) hook.send(`card ${i}`, at(i));
    expect(hook.send(`token ${["ghp", "Q".repeat(36)].join("_")}`, at(31))).toMatchObject({ status: 202, said: expect.stringContaining("key or password") });
    expect(store.heldFlowReceiptCount(hook.id)).toBe(0);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM flow_trigger_event WHERE item_json LIKE '%ghp_%'").get()?.["n"]).toBe(0);
  });
});

test("beyond 200 held, a delivery is turned away, written nowhere but the trigger's count, which stays until it is cleared", () => {
  const hook = signedHook();
  for (let i = 0; i < CARDS_PER_HOUR; i++) hook.send(`card ${i}`, at(0));
  for (let i = 0; i < HELD_AT_MOST; i++) hook.send(`held ${i}`, at(1));
  const before = receipts(hook.id);
  expect(hook.send("one too many", at(2))).toEqual({ status: 503, said: "Too many waiting already. Resend it later from the sender's delivery log." });
  expect(hook.send("and another", at(3)).status).toBe(503);
  expect(receipts(hook.id)).toBe(before);
  expect(store.getFlowTrigger(hook.id)).toMatchObject({ droppedCount: 2, droppedSince: at(2).toISOString() });
  store.clearFlowDeliveriesDropped(hook.id);
  expect(store.getFlowTrigger(hook.id)).toMatchObject({ droppedCount: 0, droppedSince: null });
});
