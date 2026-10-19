/**
 * v126 receipts (docs/plans/webhook-tasks.md §3–§4): what a trigger did with each delivery, typed; a held delivery
 * becomes its card only from held; the hourly limit counts when a card was made; a poll leaves known items out before
 * it takes its batch; who made a card is decided where it was made, never by its name.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { runFlowTriggers, type TriggerIo } from "./flow-triggers.js";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const INBOX = JSON.stringify({ version: 1, start: "inbox", stages: [{ id: "inbox", title: "Inbox", kind: "inbox", zone: {}, next: null, onFail: null }] });
const REPO = "/projects/shop";

let dir: string, store: Store, flow: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-receipts-"));
  store = openStore(join(dir, "state.db"));
  flow = store.createFlow({ repo: REPO, name: "Errors", by: "alex", definitionJson: INBOX }, T0);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const hookTrigger = () => store.addFlowTrigger({ flow, kind: "webhook", configJson: JSON.stringify({ kind: "webhook", title: "Error", titleField: null, bodyField: null, zone: null }), hookHash: "h", cursor: null, nextAt: null, by: "alex" }, T0);
const card = (title: string, now: Date) => store.addFlowCard({ flow, title, description: null, stage: "inbox", by: "Webhook", byKind: "automation" }, now);

describe("typed receipts", () => {
  test("a held delivery keeps its item, becomes accepted only from held, and the answer never claims a card that isn't there", () => {
    const trigger = hookTrigger();
    expect(store.recordFlowReceipt(trigger, "v3:sentry:id:1", "held", null, JSON.stringify({ title: "TypeError" }), at(0))).toBe(true);
    // Received once: a second arrival under the same key writes nothing.
    expect(store.recordFlowReceipt(trigger, "v3:sentry:id:1", "held", null, JSON.stringify({ title: "again" }), at(1))).toBe(false);
    expect(store.flowReceipt(trigger, "v3:sentry:id:1")).toMatchObject({ state: "held", card: null, itemJson: JSON.stringify({ title: "TypeError" }) });
    expect(store.heldFlowReceiptCount(trigger)).toBe(1);
    expect(store.flowTriggerSaw(trigger, "v3:sentry:id:1")).toBe(true);

    const made = card("TypeError", at(5));
    expect(store.acceptHeldReceipt(trigger, "v3:sentry:id:1", made, at(5))).toBe(true);
    expect(store.flowReceipt(trigger, "v3:sentry:id:1")).toMatchObject({ state: "accepted", card: made, acceptedAt: at(5).toISOString(), itemJson: null });
    // Only from held: accepting again (or a key that was never held) changes nothing, so the caller rolls its card back.
    expect(store.acceptHeldReceipt(trigger, "v3:sentry:id:1", made, at(6))).toBe(false);
    expect(store.acceptHeldReceipt(trigger, "v3:sentry:id:2", made, at(6))).toBe(false);
    expect(store.heldFlowReceiptCount(trigger)).toBe(0);
  });

  test("an ignored delivery is received without a card; a held receipt must keep its item and only a held one may", () => {
    const trigger = hookTrigger();
    expect(store.recordFlowReceipt(trigger, "v3:vercel:body:aa", "ignored", "not a failed deployment", null, at(0))).toBe(true);
    expect(store.flowReceipt(trigger, "v3:vercel:body:aa")).toMatchObject({ state: "ignored", card: null, note: "not a failed deployment" });
    expect(() => store.recordFlowReceipt(trigger, "k1", "held", null, null, at(0))).toThrow(/held receipt keeps its item/);
    expect(() => store.recordFlowReceipt(trigger, "k2", "ignored", null, "{}", at(0))).toThrow(/held receipt keeps its item/);
    // A card's own record says accepted (with its time); a skip says skipped.
    const made = card("x", at(1));
    store.recordFlowTriggerEvent(trigger, "k3", made, null, at(1));
    store.recordFlowTriggerEvent(trigger, "k4", null, "it looked like it held a key or password", at(1));
    expect(store.flowReceipt(trigger, "k3")).toMatchObject({ state: "accepted", acceptedAt: at(1).toISOString() });
    expect(store.flowReceipt(trigger, "k4")).toMatchObject({ state: "skipped", acceptedAt: null });
  });

  test("the hourly count is when each card was made: a queue held past an hour still admits only what the last hour allows", () => {
    const trigger = hookTrigger();
    // Forty deliveries held at the start (an outage); none counts until it becomes a card.
    for (let i = 0; i < 40; i++) store.recordFlowReceipt(trigger, `v3:standard:wid:${i}`, "held", null, "{}", at(0));
    expect(store.flowCardsAcceptedSince(trigger, at(-60))).toBe(0);
    // Two hours later, thirty are drained: all thirty count in the last hour, though they arrived long before it.
    for (const { key } of store.heldFlowReceipts(trigger, 30)) store.acceptHeldReceipt(trigger, key, card(key, at(120)), at(120));
    expect(store.flowCardsAcceptedSince(trigger, at(60))).toBe(30);
    expect(store.heldFlowReceiptCount(trigger)).toBe(10);
    // The ten left are the last ten to arrive (all at once here: arrival order breaks the tie).
    expect(store.heldFlowReceipts(trigger, 10).map(one => one.key)).toEqual(Array.from({ length: 10 }, (_, i) => `v3:standard:wid:${30 + i}`));
    // An hour after that, the window is clear again.
    expect(store.flowCardsAcceptedSince(trigger, at(121))).toBe(0);
  });

  test("held deliveries drain oldest first, exactly", () => {
    const trigger = hookTrigger();
    for (const [key, minute] of [["c", 3], ["a", 1], ["b", 2]] as const) store.recordFlowReceipt(trigger, key, "held", null, "{}", at(minute));
    expect(store.heldFlowReceipts(trigger, 3).map(one => one.key)).toEqual(["a", "b", "c"]);
  });

  test("saved receipts and new ones count together, each once: a saved card at its arrival, a new one when it was made", () => {
    const trigger = hookTrigger();
    const legacy = (key: string, minute: number, made: boolean) => store.handle.prepare("INSERT INTO flow_trigger_event (trigger, key, card, note, at) VALUES (?, ?, ?, NULL, ?)")
      .run(trigger, key, made ? card(key, at(minute)) : null, at(minute).toISOString());
    legacy("old-in", 30, true);    // saved, in the window
    legacy("old-out", -30, true);  // saved, before it
    legacy("old-skip", 30, false); // saved, no card
    store.recordFlowTriggerEvent(trigger, "new-in", card("n1", at(40)), null, at(40));
    store.recordFlowReceipt(trigger, "held-late", "held", null, "{}", at(-90));
    store.acceptHeldReceipt(trigger, "held-late", card("h", at(50)), at(50)); // arrived before the window, made in it
    store.recordFlowReceipt(trigger, "held-still", "held", null, "{}", at(45)); // in the window, no card yet
    expect(store.flowCardsAcceptedSince(trigger, at(0))).toBe(3);
  });

  test("the hourly note is claimed at most once an hour, and turned-away deliveries are counted until cleared", () => {
    const trigger = hookTrigger();
    expect(store.claimFlowLimitNote(trigger, at(0))).toBe(true);
    expect(store.claimFlowLimitNote(trigger, at(30))).toBe(false);
    expect(store.claimFlowLimitNote(trigger, at(60))).toBe(true);
    store.noteFlowDeliveryDropped(trigger, at(1));
    store.noteFlowDeliveryDropped(trigger, at(2));
    expect(store.getFlowTrigger(trigger)).toMatchObject({ droppedCount: 2, droppedSince: at(1).toISOString() });
    // Later traffic can't hide it the way it overwrites the last outcome.
    store.updateFlowTrigger(trigger, { lastAt: at(3).toISOString(), lastOutcome: "Added 1 card." }, at(3));
    expect(store.getFlowTrigger(trigger)?.droppedCount).toBe(2);
    store.clearFlowDeliveriesDropped(trigger);
    expect(store.getFlowTrigger(trigger)).toMatchObject({ droppedCount: 0, droppedSince: null });
  });
});

describe("a poll", () => {
  /** GitHub answering the issues list: issues 1..n opened after the trigger, newest first, as GitHub sends them. */
  const github = (n: number): TriggerIo["gh"] => async () => ({
    code: 0, stderr: "", timedOut: false, notFound: false,
    stdout: JSON.stringify(Array.from({ length: n }, (_, i) => n - i).map(number => ({
      number, title: `Issue ${number}`, body: "", html_url: `https://github.com/o/r/issues/${number}`, user: { login: "sam" },
      author_association: "OWNER", labels: [], created_at: at(number).toISOString(), updated_at: at(number).toISOString() }))),
  });

  test("leaves known items out before it takes its batch, so known ones can't keep the rest waiting", async () => {
    const trigger = store.addFlowTrigger({ flow, kind: "github", by: "alex", hookHash: null, cursor: null, nextAt: null,
      configJson: JSON.stringify({ kind: "github", repo: "o/r", watch: "issues", label: null, branch: null, from: "anyone", delivery: "poll", zone: null }) }, T0);
    const io = (n: number): TriggerIo => ({ gh: github(n), fetch, dir, mail: async () => ({ ok: false, problem: "no mail" }) as never });
    // Thirty issues waiting: three passes take ten each, the oldest first, and none is taken twice.
    let added = 0;
    for (const pass of [0, 1, 2, 3]) added += (await runFlowTriggers(store, REPO, at(40 + pass * 3), io(30))).added;
    expect(added).toBe(30);
    expect(store.flowCardsAcceptedSince(trigger, at(-1))).toBe(30);
    // Every card is a poll's: automation, whatever its label says.
    const kinds = store.handle.prepare("SELECT created_by, created_kind FROM flow_card WHERE flow = ? GROUP BY created_by, created_kind").all(flow);
    expect(kinds).toEqual([{ created_by: "GitHub", created_kind: "automation" }]);
  });
});
