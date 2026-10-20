/**
 * v126 step 4 (docs/plans/webhook-tasks.md §4): floods. What doesn't prove itself is counted per address and, past 60
 * a minute, answered 429 with nothing written, without ever crowding out a signed delivery. At most 30 cards an hour
 * per trigger, decided in the card's own transaction: a signed delivery over it is held whole and made into its card
 * when the hour has room, oldest first; an unsigned one is turned away. Beyond 200 held, deliveries are turned away and
 * counted on the trigger until a person clears it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { flowFromSteps } from "./flows.js";
import { addFlowTriggerTo, drainHeldDeliveries, receiveFlowHook, runFlowTriggers, saveSigningSecret, setUpFlowHook, type TriggerIo } from "./flow-triggers.js";
import { flowHook } from "./server/remote-hooks.js";
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
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(dir, { recursive: true, force: true }); });

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

/** Everything a delivery could change, except the named columns: rows of the trigger, receipts, cards and card events. */
function everything(id: number, except: string[] = []): unknown {
  const trigger = { ...store.handle.prepare("SELECT * FROM flow_trigger WHERE id = ?").get(id) } as Record<string, unknown>;
  for (const column of except) delete trigger[column];
  return { trigger, receipts: store.handle.prepare("SELECT * FROM flow_trigger_event WHERE trigger = ? ORDER BY key").all(id),
    cards: store.handle.prepare("SELECT * FROM flow_card WHERE flow = ? ORDER BY id").all(flow), events: store.handle.prepare("SELECT COUNT(*) AS n FROM flow_event").get() };
}

describe("what a rejection writes", () => {
  test("a delivery turned away beyond 200 held changes the trigger's turned-away count and nothing else", () => {
    const hook = signedHook();
    for (let i = 0; i < CARDS_PER_HOUR; i++) hook.send(`card ${i}`, at(0));
    for (let i = 0; i < HELD_AT_MOST; i++) hook.send(`held ${i}`, at(1));
    // The "too many" note is due again (as if written two hours ago): even so, a turned-away delivery writes no note.
    store.handle.prepare("UPDATE flow_trigger SET limit_noted_at = ? WHERE id = ?").run(at(-120).toISOString(), hook.id);
    const before = everything(hook.id, ["dropped_count", "dropped_since"]);
    expect(hook.send("turned away", at(2)).status).toBe(503);
    expect(everything(hook.id, ["dropped_count", "dropped_since"])).toEqual(before);
  });

  test("an unsigned delivery over the hour's limit writes nothing at all", () => {
    const hook = unsignedHook();
    for (let i = 0; i < CARDS_PER_HOUR; i++) hook.send(`card ${i}`, at(i * 1.5));
    const before = everything(hook.id);
    expect(hook.send("one too many", at(50)).status).toBe(429);
    expect(everything(hook.id)).toEqual(before);
  });

  test("a signed Linear delivery that is too old counts as unproven, and past the minute's limit gets 429", () => {
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "linear", team: "ENG", delivery: "webhook" }, "alex", T0, dir);
    if (!made.ok) throw new Error(made.message);
    const secret = "l".repeat(32);
    saveSigningSecret(store, store.getFlowTrigger(made.id)!, secret, T0, dir);
    const token = made.reveal!.path.slice("/hooks/flow/".length);
    const stale = JSON.stringify({ type: "Issue", action: "create", webhookTimestamp: at(-30).getTime(), data: {} });
    const send = () => receiveFlowHook(store, token, { headers: { "linear-signature": [createHmac("sha256", secret).update(stale).digest("hex")] }, body: Buffer.from(stale) }, dir, T0);
    for (let i = 0; i < UNPROVEN_PER_MINUTE; i++) expect(send()).toEqual({ status: 401, said: "Too old." });
    expect(send().status).toBe(429);
  });
});

describe("draining, against everything else at once", () => {
  /** Thirty cards in the first half hour and `held` more held; an hour on, one slot frees for each minute. */
  function full(held: number) {
    const hook = signedHook();
    for (let i = 0; i < CARDS_PER_HOUR; i++) hook.send(`card ${i}`, at(i));
    for (let i = 0; i < held; i++) hook.send(`held ${i}`, at(31 + i / 10));
    return hook;
  }
  /** Run `meanwhile` (another handle's work) just as the drain begins its next write. */
  function beforeNextWrite(meanwhile: () => void) {
    const original = store.transact.bind(store);
    vi.spyOn(store, "transact").mockImplementationOnce(body => { meanwhile(); return original(body); });
  }

  test("a delivery taking the last slot just before the drain's write: the drain makes nothing past 30 an hour", () => {
    const hook = full(2);
    const other = openStore(file);
    try {
      beforeNextWrite(() => { expect(hook.send("fresh from B", at(60.5), other)).toEqual({ status: 202, said: "Added 1 card." }); });
      expect(drainHeldDeliveries(store, store.getFlowTrigger(hook.id)!, at(60.5))).toBe(0);
      expect(store.flowCardsAcceptedSince(hook.id, at(0.5))).toBe(CARDS_PER_HOUR);
    } finally { other.close(); }
  });

  test("a trigger paused just before the drain's write drains nothing, whatever the drain was handed", () => {
    const hook = full(2);
    const snapshot = store.getFlowTrigger(hook.id)!;
    const other = openStore(file);
    try {
      beforeNextWrite(() => other.updateFlowTrigger(hook.id, { state: "paused" }, at(60)));
      expect(drainHeldDeliveries(store, snapshot, at(70))).toBe(0);
      expect(store.heldFlowReceiptCount(hook.id)).toBe(2);
    } finally { other.close(); }
  });

  test("two drains at once make each held delivery exactly once", () => {
    const hook = full(5);
    const other = openStore(file);
    try {
      beforeNextWrite(() => { drainHeldDeliveries(other, other.getFlowTrigger(hook.id)!, at(65)); });
      drainHeldDeliveries(store, store.getFlowTrigger(hook.id)!, at(65));
      expect(cards()).toBe(CARDS_PER_HOUR + 5);
      expect(store.heldFlowReceiptCount(hook.id)).toBe(0);
      expect(store.handle.prepare("SELECT COUNT(DISTINCT title) AS n FROM flow_card WHERE flow = ? AND title LIKE 'held %'").get(flow)?.["n"]).toBe(5);
    } finally { other.close(); }
  });

  test("a card whose receipt can't move to accepted is rolled back, and the next drain makes it once", () => {
    const hook = full(1);
    vi.spyOn(store, "acceptHeldReceipt").mockReturnValueOnce(false);
    expect(() => drainHeldDeliveries(store, store.getFlowTrigger(hook.id)!, at(61))).toThrow(/changed while its card was made/);
    expect(cards()).toBe(CARDS_PER_HOUR);
    expect(drainHeldDeliveries(store, store.getFlowTrigger(hook.id)!, at(61))).toBe(1);
    expect(cards()).toBe(CARDS_PER_HOUR + 1);
  });

  test("one failing run is one fix, held or not: two GitHub triggers holding the same commit make one card", () => {
    const run = (id: number) => {
      const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "github", repo: "acme/shop", watch: "checks", delivery: "webhook", from: "anyone" }, "alex", T0, dir);
      if (!made.ok) throw new Error(made.message);
      store.recordFlowReceipt(made.id, "checks:abc123", "held", null, JSON.stringify({ title: "CI failed on abc123", description: null, by: "GitHub", source: { kind: "github", label: `Run ${id}`, url: null } }), at(1));
      return made.id;
    };
    const first = run(1), second = run(2);
    expect(drainHeldDeliveries(store, store.getFlowTrigger(first)!, at(2))).toBe(1);
    expect(drainHeldDeliveries(store, store.getFlowTrigger(second)!, at(2))).toBe(0);
    expect(store.flowReceipt(second, "checks:abc123")).toMatchObject({ state: "skipped", note: "already a card in “Intake”" });
    expect(cards()).toBe(1);
  });
});

test("a held item keeps where it came from only once it is safe and bounded: a link's query is dropped", () => {
  const hook = signedHook();
  for (let i = 0; i < CARDS_PER_HOUR; i++) hook.send(`card ${i}`, at(i));
  expect(hook.send("held one", at(31)).status).toBe(202);
  const held = store.heldFlowReceipts(hook.id, 1)[0]!;
  expect(held.itemJson.length).toBeLessThan(12_000);
  expect(JSON.parse(held.itemJson)).toMatchObject({ title: "held one", by: "Webhook", source: { label: "Webhook", url: null } });
});

describe("over HTTP", () => {
  test("past the minute's limit, the answer carries Retry-After", async () => {
    const hook = signedHook();
    const server = createServer((request, response) => { void flowHook({ store, clock: () => T0, options: { configDir: dir } }, request, response, new URL(request.url ?? "/", "http://localhost")); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const forged = () => fetch(`http://127.0.0.1:${port}/hooks/flow/${hook.token}`, { method: "POST", headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, body: "{}" });
      for (let i = 0; i < UNPROVEN_PER_MINUTE; i++) expect((await forged()).status).toBe(401);
      const over = await forged();
      expect(over.status).toBe(429);
      expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
      // A body too large to read counts the same way.
      const big = await fetch(`http://127.0.0.1:${port}/hooks/flow/${hook.token}`, { method: "POST", body: "x".repeat(1_000_001) });
      expect(big.status).toBe(429);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe("GitHub and Linear deliveries under the same rules", () => {
  function github() {
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "github", repo: "acme/shop", watch: "issues", delivery: "webhook", from: "anyone" }, "alex", T0, dir);
    if (!made.ok) throw new Error(made.message);
    const token = made.reveal!.path.slice("/hooks/flow/".length), secret = made.reveal!.secret!;
    const send = (number: number, url: string, now = T0) => {
      const body = JSON.stringify({ action: "opened", repository: { full_name: "acme/shop" }, sender: { login: "sam" },
        issue: { number, title: `Issue ${number}`, body: "", html_url: url, user: { login: "sam" }, author_association: "OWNER", labels: [], created_at: now.toISOString(), updated_at: now.toISOString() } });
      return receiveFlowHook(store, token, { headers: { "x-github-event": ["issues"], "x-hub-signature-256": [`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`] }, body: Buffer.from(body) }, dir, now);
    };
    return { id: made.id, send };
  }

  test("a held GitHub issue keeps its link without the query a token could ride in", () => {
    const hook = github();
    for (let i = 1; i <= CARDS_PER_HOUR; i++) expect(hook.send(i, `https://github.com/acme/shop/issues/${i}`, at(i)).status).toBe(202);
    const token = ["ghp", "Q".repeat(36)].join("_");
    expect(hook.send(99, `https://github.com/acme/shop/issues/99?access_token=${token}#frag`, at(40))).toEqual({ status: 202, said: "Held: it will be added when there's room." });
    const held = store.heldFlowReceipts(hook.id, 1)[0]!;
    expect(held.itemJson).not.toContain(token);
    expect(JSON.parse(held.itemJson)).toMatchObject({ source: { kind: "github", label: "GitHub issue #99", url: "https://github.com/acme/shop/issues/99" } });
  });

  test("a Linear identifier that is too long, or looks like a key, is never a key: received under the bytes, made into nothing", () => {
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "linear", team: "ENG", delivery: "webhook" }, "alex", T0, dir);
    if (!made.ok) throw new Error(made.message);
    const secret = "l".repeat(32);
    saveSigningSecret(store, store.getFlowTrigger(made.id)!, secret, T0, dir);
    const token = made.reveal!.path.slice("/hooks/flow/".length);
    const send = (identifier: string) => {
      const body = JSON.stringify({ type: "Issue", action: "create", webhookTimestamp: T0.getTime(), data: { identifier, title: "Refunds", team: { key: "ENG" }, url: "https://linear.app/acme/issue/ENG-1" } });
      return receiveFlowHook(store, token, { headers: { "linear-signature": [createHmac("sha256", secret).update(body).digest("hex")] }, body: Buffer.from(body) }, dir, T0);
    };
    const planted = ["ghp", "Q".repeat(36)].join("_");
    expect(send(`ENG-${"9".repeat(300)}`)).toMatchObject({ status: 202, said: expect.stringContaining("Left out 1 item") });
    expect(send(planted)).toMatchObject({ status: 202, said: expect.stringContaining("Left out 1 item") });
    const keys = store.handle.prepare("SELECT key FROM flow_trigger_event WHERE trigger = ?").all(made.id).map(row => String(row["key"]));
    expect(keys).toHaveLength(2);
    for (const key of keys) { expect(key).toMatch(/^v3:linear:body:[0-9a-f]{64}$/); expect(key).not.toContain(planted); }
    expect(cards()).toBe(0);
  });
});

test("the largest card-sized item, escaped at every character, is held, not refused for its size", () => {
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "github-style", titleField: "t", bodyField: "d", idField: "id", urlField: "u" }, "alex", T0, dir);
  if (!made.ok) throw new Error(made.message);
  const secret = (() => { const setUp = setUpFlowHook(store, store.getFlowTrigger(made.id)!, T0, dir); if (!setUp.ok) throw new Error(setUp.message); return setUp.reveal!.secret!; })();
  const token = made.reveal!.path.slice("/hooks/flow/".length);
  const send = (payload: unknown, now: Date) => { const body = JSON.stringify(payload); return receiveFlowHook(store, token, { headers: { "x-hub-signature-256": [`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`] }, body: Buffer.from(body) }, dir, now); };
  for (let i = 0; i < CARDS_PER_HOUR; i++) send({ id: `n${i}`, t: `card ${i}` }, at(i));
  // A title and details that JSON doubles at every character, and a link near its 2,000-character limit, kept twice.
  // Lone surrogates: JSON writes each as a six-character escape.
  const heavy = { id: "heavy", t: '"'.repeat(150), d: "\ud800".repeat(3900), u: `https://status.example/${"a".repeat(1950)}` };
  expect(send(heavy, at(31))).toEqual({ status: 202, said: "Held: it will be added when there's room." });
  const held = store.heldFlowReceipts(made.id, 1)[0]!;
  expect(held.itemJson.length).toBeGreaterThan(12_000);
});

test("over HTTP, one body too large is 413 with a fresh count, and only past the minute's limit 429", async () => {
  const hook = signedHook();
  const server = createServer((request, response) => { void flowHook({ store, clock: () => T0, options: { configDir: dir } }, request, response, new URL(request.url ?? "/", "http://localhost")); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const big = () => fetch(`http://127.0.0.1:${port}/hooks/flow/${hook.token}`, { method: "POST", body: "x".repeat(1_000_001) });
    expect((await big()).status).toBe(413);
    for (let i = 1; i < UNPROVEN_PER_MINUTE; i++) expect((await big()).status).toBe(413);
    const over = await big();
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
