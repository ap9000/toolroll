/**
 * v126 step 3 (docs/plans/webhook-tasks.md §2–§3): Sentry's and Vercel's readers over their senders' payloads
 * (test/fixtures/webhooks), and the generic dot-paths; through a real trigger, each signed delivery is one receipt —
 * an issue's alerts one card, a deployment that succeeded or one from another project ignored without using up any
 * identity — and every link made safe before it is kept.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { flowFromSteps } from "./flows.js";
import { addFlowTriggerTo, receiveFlowHook, saveSigningSecret, setUpFlowHook } from "./flow-triggers.js";
import { readDelivery, safeLink, SENTRY_HOSTS, VERCEL_HOSTS, type ReaderSettings } from "./webhook-readers.js";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/webhooks/${name}`, import.meta.url));
const settings = (over: Partial<ReaderSettings>): ReaderSettings => ({ sender: "none", title: "Webhook", titleField: null, bodyField: null, idField: null, urlField: null, project: null, team: null, ...over });
const parse = (name: string) => JSON.parse(fixture(name).toString("utf8")) as unknown;

describe("readers", () => {
  test("Sentry: an issue alert and a new issue each name their issue; a resolved issue is ignored", () => {
    expect(readDelivery(parse("sentry-issue-alert.documented.json"), settings({ sender: "sentry" }))).toEqual({
      kind: "item", identity: "1170820242", label: "Sentry issue", title: "TypeError: Cannot read properties of undefined (reading 'total')",
      url: "https://acme.sentry.io/organizations/acme/issues/1170820242/events/68f8ab4ca0b24f6d8a7cf29e1ee8e6e8/",
      description: "From a Sentry issue, in checkout/rounding.ts in roundTotal." });
    expect(readDelivery(parse("sentry-issue-created.documented.json"), settings({ sender: "sentry", project: "web" }))).toMatchObject({ kind: "item", identity: "1170820243", url: "https://acme.sentry.io/issues/1170820243/" });
    expect(readDelivery(parse("sentry-issue-resolved.documented.json"), settings({ sender: "sentry" }))).toEqual({ kind: "ignored", why: "not an issue alert or a new issue" });
  });

  test("Sentry's scope is read from the body: another project is ignored", () => {
    expect(readDelivery(parse("sentry-issue-alert.documented.json"), settings({ sender: "sentry", project: "1" }))).toMatchObject({ kind: "item" });
    // An alert names its project by number; its slug is read from the event's API address, on Sentry's own host only.
    expect(readDelivery(parse("sentry-issue-alert.documented.json"), settings({ sender: "sentry", project: "web" }))).toMatchObject({ kind: "item", identity: "1170820242" });
    const elsewhere = JSON.parse(fixture("sentry-issue-alert.documented.json").toString().replace("https://sentry.io/api/0/projects/acme/web/", "https://evil.example/api/0/projects/acme/web/")) as unknown;
    expect(readDelivery(elsewhere, settings({ sender: "sentry", project: "web" }))).toEqual({ kind: "ignored", why: "from another Sentry project" });
    expect(readDelivery(parse("sentry-issue-alert.documented.json"), settings({ sender: "sentry", project: "2" }))).toEqual({ kind: "ignored", why: "from another Sentry project" });
    expect(readDelivery(parse("sentry-issue-created.documented.json"), settings({ sender: "sentry", project: "api" }))).toEqual({ kind: "ignored", why: "from another Sentry project" });
  });

  test("Vercel: only a failed deployment, from its project and team, linked to its inspection page", () => {
    expect(readDelivery(parse("vercel-deployment-error.documented.json"), settings({ sender: "vercel", project: "prj_1", team: "team_1" }))).toEqual({
      kind: "item", identity: "dpl_8f3k2j", label: "Vercel deployment", title: "shop failed to deploy", url: "https://vercel.com/acme/shop/8f3k2j", description: "From a failed Vercel deployment." });
    expect(readDelivery(parse("vercel-deployment-succeeded.documented.json"), settings({ sender: "vercel" }))).toEqual({ kind: "ignored", why: "not a failed deployment" });
    expect(readDelivery(parse("vercel-deployment-error.documented.json"), settings({ sender: "vercel", project: "prj_2" }))).toEqual({ kind: "ignored", why: "from another Vercel project" });
    expect(readDelivery(parse("vercel-deployment-error.documented.json"), settings({ sender: "vercel", team: "team_2" }))).toEqual({ kind: "ignored", why: "from another Vercel team" });
  });

  test("nothing the sender wrote is kept as the reason for an event Toolroll doesn't take", () => {
    const token = ["ghp", "Q".repeat(36)].join("_");
    expect(readDelivery({ action: token, data: {} }, settings({ sender: "sentry" }))).toEqual({ kind: "ignored", why: "not an issue alert or a new issue" });
    expect(readDelivery({ type: token }, settings({ sender: "vercel" }))).toEqual({ kind: "ignored", why: "not a failed deployment" });
  });

  test("an identity is judged as sent: padding, hidden characters or length never become another identity", () => {
    const generic = settings({ idField: "id" });
    expect(readDelivery({ id: "\nABC" }, generic)).toEqual({ kind: "skip", why: "its identity isn't usable" });
    expect(readDelivery({ id: " ABC " }, generic)).toEqual({ kind: "skip", why: "its identity isn't usable" });
    expect(readDelivery({ id: `ABC${" ".repeat(200)}` }, generic)).toEqual({ kind: "skip", why: "its identity isn't usable" });
    expect(readDelivery({ id: "ABC" }, generic)).toMatchObject({ kind: "item", identity: "ABC" });
  });

  test("generic: a configured identity that can't be used makes nothing, never some other identity", () => {
    const generic = settings({ sender: "standard", idField: "data.id", urlField: "data.url" });
    expect(readDelivery({ data: { id: 42, url: "https://status.example/i/42?token=x#frag" }, title: "Down" }, generic)).toMatchObject({ kind: "item", identity: "42", url: "https://status.example/i/42", title: "Down" });
    expect(readDelivery({ data: {} }, generic)).toEqual({ kind: "skip", why: "its identity is missing" });
    expect(readDelivery({ data: { id: "" } }, generic)).toEqual({ kind: "skip", why: "its identity is missing" });
    expect(readDelivery({ data: { id: "x".repeat(121) } }, generic)).toEqual({ kind: "skip", why: "its identity isn't usable" });
    expect(readDelivery({ data: { id: "a\u0007b" } }, generic)).toEqual({ kind: "skip", why: "its identity isn't usable" });
    expect(readDelivery({ data: { id: ["ghp", "Q".repeat(36)].join("_") } }, generic)).toEqual({ kind: "skip", why: "it looked like it held a key or password" });
    expect(readDelivery({ data: { id: 1.5 } }, generic)).toEqual({ kind: "skip", why: "its identity is missing" });
  });

  test("a link is kept only as an https address on its sender's site, without user information, query or fragment, or anything like a secret", () => {
    expect(safeLink("https://acme.sentry.io/issues/1/?query=is%3Aunresolved#a", SENTRY_HOSTS)).toBe("https://acme.sentry.io/issues/1/");
    expect(safeLink("https://sentry.io.evil.example/issues/1/", SENTRY_HOSTS)).toBeNull();
    expect(safeLink("https://notsentry.io/issues/1/", SENTRY_HOSTS)).toBeNull();
    expect(safeLink("http://acme.sentry.io/issues/1/", SENTRY_HOSTS)).toBeNull();
    expect(safeLink("https://user:pass@acme.sentry.io/issues/1/", SENTRY_HOSTS)).toBeNull();
    // Vercel's inspection pages are on vercel.com itself: not its subdomains.
    expect(safeLink("https://vercel.com/acme/shop/8f3k2j", VERCEL_HOSTS)).toBe("https://vercel.com/acme/shop/8f3k2j");
    expect(safeLink("https://shop.vercel.com/acme", VERCEL_HOSTS)).toBeNull();
    // A token spelled with percent-escapes is the same token; a path that won't decode isn't kept.
    expect(safeLink(`https://vercel.com/%67hp_${"Q".repeat(36)}`, VERCEL_HOSTS)).toBeNull();
    expect(safeLink(`https://status.example/a/%67%68%70_${"Q".repeat(36)}`, null)).toBeNull();
    expect(safeLink("https://status.example/%E0%A4%A", null)).toBeNull();
    expect(safeLink("https://status.example/a%0Ab", null)).toBeNull();
    expect(safeLink(`https://status.example/${["ghp", "Q".repeat(36)].join("_")}`, null)).toBeNull();
    expect(safeLink(`https://status.example/${"a".repeat(2000)}`, null)).toBeNull();
    expect(safeLink("javascript:alert(1)", null)).toBeNull();
    expect(safeLink(42, null)).toBeNull();
  });
});

describe("through a trigger", () => {
  let dir: string, store: Store, flow: number;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-readers-")));
    store = openStore(join(dir, "orders.db"));
    flow = store.createFlow({ repo: "/test/shop", name: "Errors", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const SECRET = "c0ffee".repeat(10) + "abcd";
  function hook(settingsGiven: Record<string, unknown>) {
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", ...settingsGiven }, "alex", T0, dir);
    if (!made.ok) throw new Error(made.message);
    const trigger = store.getFlowTrigger(made.id)!;
    if (settingsGiven["sender"] === "sentry" || settingsGiven["sender"] === "vercel") { if (!saveSigningSecret(store, trigger, SECRET, T0, dir).ok) throw new Error("secret"); }
    return { id: made.id, token: made.reveal!.path.slice("/hooks/flow/".length) };
  }
  const cards = () => store.handle.prepare("SELECT title, source_json FROM flow_card WHERE flow = ? ORDER BY id").all(flow).map(row => ({ title: String(row["title"]), source: JSON.parse(String(row["source_json"])) as Record<string, unknown> }));

  test("Sentry: two alerts for one issue are one card, linked to the issue and saying it was proved by Sentry", () => {
    const { id, token } = hook({ sender: "sentry" });
    const send = (name: string) => receiveFlowHook(store, token, { headers: { "sentry-hook-signature": [createHmac("sha256", SECRET).update(fixture(name)).digest("hex")] }, body: fixture(name) }, dir, T0);
    expect(send("sentry-issue-alert.documented.json")).toEqual({ status: 202, said: "Added 1 card." });
    expect(send("sentry-issue-alert-again.documented.json")).toEqual({ status: 202, said: "Already received." });
    expect(cards()).toEqual([{ title: "TypeError: Cannot read properties of undefined (reading 'total')", source: {
      kind: "sentry", label: "Sentry issue", url: "https://acme.sentry.io/organizations/acme/issues/1170820242/events/68f8ab4ca0b24f6d8a7cf29e1ee8e6e8/",
      verified: "sentry", external: { id: "1170820242", url: "https://acme.sentry.io/organizations/acme/issues/1170820242/events/68f8ab4ca0b24f6d8a7cf29e1ee8e6e8/" }, receipt: "v3:sentry:id:1170820242" } }]);
    // The card reads back with its source whole.
    expect(store.getFlowCard(store.lastFlowTriggerCard(id)!)?.source).toMatchObject({ verified: "sentry", external: { id: "1170820242" }, receipt: "v3:sentry:id:1170820242" });
    // A resolved issue is ignored, received under its delivery's key: no identity is used up.
    expect(send("sentry-issue-resolved.documented.json")).toEqual({ status: 202, said: "Ignored: not an issue alert or a new issue." });
    // The same ignored delivery again is answered for what it was.
    expect(send("sentry-issue-resolved.documented.json")).toEqual({ status: 202, said: "Already received." });
    expect(store.flowReceipt(id, "v3:sentry:id:1170820243")).toBeNull();
    expect(send("sentry-issue-created.documented.json")).toEqual({ status: 202, said: "Added 1 card." });
  });

  test("Vercel: a deployment that succeeded, or failed elsewhere, is ignored without using up the deployment it names", () => {
    const { id, token } = hook({ sender: "vercel", project: "prj_1" });
    const send = (body: Buffer) => receiveFlowHook(store, token, { headers: { "x-vercel-signature": [createHmac("sha1", SECRET).update(body).digest("hex")] }, body }, dir, T0);
    expect(send(fixture("vercel-deployment-succeeded.documented.json"))).toEqual({ status: 202, said: "Ignored: not a failed deployment." });
    const elsewhere = Buffer.from(fixture("vercel-deployment-error.documented.json").toString("utf8").replace('"prj_1"', '"prj_2"'));
    expect(send(elsewhere)).toEqual({ status: 202, said: "Ignored: from another Vercel project." });
    expect(store.flowReceipt(id, "v3:vercel:id:dpl_8f3k2j")).toBeNull();
    expect(send(fixture("vercel-deployment-error.documented.json"))).toEqual({ status: 202, said: "Added 1 card." });
    expect(cards()[0]).toMatchObject({ title: "shop failed to deploy", source: { kind: "vercel", url: "https://vercel.com/acme/shop/8f3k2j", verified: "vercel" } });
  });

  test("generic: a configured identity groups deliveries; a missing one makes nothing and says why when it comes again", () => {
    const { id } = hook({ sender: "standard", idField: "incident.id", urlField: "incident.url", titleField: "incident.name" });
    const key = setUpFlowHook(store, store.getFlowTrigger(id)!, T0, dir);
    if (!key.ok) throw new Error(key.message);
    const token = key.reveal!.path.slice("/hooks/flow/".length);
    const secret = Buffer.from(key.reveal!.secret!.slice("whsec_".length), "base64");
    const send = (messageId: string, payload: unknown) => {
      const body = JSON.stringify(payload), stamp = String(Math.floor(T0.getTime() / 1000));
      const signature = `v1,${createHmac("sha256", secret).update(`${messageId}.${stamp}.${body}`).digest("base64")}`;
      return receiveFlowHook(store, token, { headers: { "webhook-id": [messageId], "webhook-timestamp": [stamp], "webhook-signature": [signature] }, body: Buffer.from(body) }, dir, T0);
    };
    expect(send("m1", { incident: { id: "INC-7", name: "Checkout down", url: "https://status.example/INC-7?t=1" } })).toEqual({ status: 202, said: "Added 1 card." });
    // Another delivery (another message id) about the same incident: the same card.
    expect(send("m2", { incident: { id: "INC-7", name: "Checkout still down" } })).toEqual({ status: 202, said: "Already received." });
    expect(cards()).toEqual([expect.objectContaining({ title: "Checkout down", source: expect.objectContaining({ url: "https://status.example/INC-7", receipt: "v3:standard:id:INC-7" }) })]);
    expect(send("m3", { incident: { name: "No id" } })).toEqual({ status: 202, said: "No new cards. Left out 1 item: Webhook: its identity is missing." });
    expect(send("m3", { incident: { name: "No id" } })).toEqual({ status: 202, said: "Already received; it wasn't added: its identity is missing." });
    // A signed delivery id that looks like a key is never a key, a note or a card: received under its bytes, made into nothing.
    const planted = ["ghp", "Q".repeat(36)].join("_");
    expect(send(planted, { incident: { id: "INC-9", name: "Secret id" } })).toEqual({ status: 202, said: "No new cards. Left out 1 item: Webhook: its delivery id: it looked like it held a key or password." });
    expect(store.handle.prepare("SELECT key FROM flow_trigger_event WHERE trigger = ? AND key LIKE ?").all(id, `%${planted}%`)).toEqual([]);
    expect(JSON.stringify(cards())).not.toContain(planted);
  });
});
