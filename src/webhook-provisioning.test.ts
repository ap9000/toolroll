/**
 * v126 step 2 (docs/plans/webhook-tasks.md §1): how a webhook proves itself. Creating a trigger never makes a secret;
 * Set up is the one place one is made (shown once, with a new address) and a sender's own is pasted; credentials move
 * by generation, so an old secret never authenticates again whatever happens to its file; a sender changes in place;
 * a refusal writes nothing; a security header sent twice — as real header lines — is refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { flowFromSteps } from "./flows.js";
import { addFlowTriggerTo, changeFlowHookSender, hookReady, readHookSecret, receiveFlowHook, renewFlowHook, saveHookSecret, saveSigningSecret, setUpFlowHook, triggerConfigOf } from "./flow-triggers.js";
import { exportFlow, importFlow, parseFlowFile, planFlowImport } from "./flow-share.js";
import { standardKey } from "./webhook-signing.js";
import { flowHook } from "./server/remote-hooks.js";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const REPO = "/test/shop";

let dir: string, store: Store, flow: number;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-hook-setup-")));
  store = openStore(join(dir, "orders.db"));
  flow = store.createFlow({ repo: REPO, name: "Intake", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const tokenOf = (path: string) => path.slice("/hooks/flow/".length);
const deliver = (token: string, body: string, headers: Record<string, string | string[]> = {}, now = T0) =>
  receiveFlowHook(store, token, { headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value : [value]])), body: Buffer.from(body) }, dir, now);
/** A Standard Webhooks delivery, signed with `secret`. */
const standard = (secret: string, id: string, body: string, now = T0) => {
  const stamp = String(Math.floor(now.getTime() / 1000));
  return { "webhook-id": id, "webhook-timestamp": stamp, "webhook-signature": `v1,${createHmac("sha256", standardKey(secret)!).update(`${id}.${stamp}.${body}`).digest("base64")}` };
};
const add = (settings: Record<string, unknown>) => {
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", ...settings }, "alex", T0, dir);
  if (!made.ok) throw new Error(made.message);
  return { id: made.id, reveal: made.reveal! };
};
const trigger = (id: number) => store.getFlowTrigger(id)!;
const receipts = (id: number) => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM flow_trigger_event WHERE trigger = ?").get(id)?.["n"]);

describe("provisioning", () => {
  test("creating a signed webhook makes no secret; Set up makes one, shown once with a new address, and only then are deliveries taken", () => {
    const { id, reveal } = add({ sender: "standard", title: "Request" });
    expect(reveal.secret).toBeNull();
    expect(hookReady(trigger(id), dir)).toBe(false);
    // Refused while not set up, and nothing is written: no receipt, no last outcome.
    expect(deliver(tokenOf(reveal.path), '{"title":"x"}')).toEqual({ status: 401, said: "This webhook isn't set up yet: set up Standard Webhooks signing on the flow's Triggers panel first." });
    expect(receipts(id)).toBe(0);
    expect(trigger(id).lastOutcome).toBeNull();

    const setUp = setUpFlowHook(store, trigger(id), T0, dir);
    if (!setUp.ok) throw new Error(setUp.message);
    const secret = setUp.reveal!.secret!;
    expect(secret).toMatch(/^whsec_/);
    expect(hookReady(trigger(id), dir)).toBe(true);
    // The old address no longer works; the new one takes a signed delivery and refuses an unsigned or wrongly signed one.
    expect(deliver(tokenOf(reveal.path), '{"title":"x"}', standard(secret, "m1", '{"title":"x"}'))).toEqual({ status: 404, said: "No such address." });
    const token = tokenOf(setUp.reveal!.path);
    expect(deliver(token, '{"title":"Checkout broke"}')).toEqual({ status: 401, said: "The webhook-id header is missing." });
    expect(deliver(token, '{"title":"Checkout broke"}', standard("whsec_" + Buffer.alloc(32, 7).toString("base64"), "m1", '{"title":"Checkout broke"}'))).toEqual({ status: 401, said: "Signature doesn't match." });
    expect(receipts(id)).toBe(0);
    expect(trigger(id).lastOutcome).toBeNull();
    expect(deliver(token, '{"title":"Checkout broke"}', standard(secret, "m1", '{"title":"Checkout broke"}'))).toEqual({ status: 202, said: "Added 1 card." });
    // Keyed on the signed id: the same id again is the same delivery.
    expect(store.flowReceipt(id, "v3:standard:wid:m1")?.state).toBe("accepted");
    expect(deliver(token, '{"title":"Checkout broke"}', standard(secret, "m1", '{"title":"Checkout broke"}'))).toEqual({ status: 202, said: "Nothing new." });
  });

  test("Renew address keeps the secret; setting up again replaces it, and the old one is refused even when its file survives", () => {
    const { id } = add({ sender: "github-style" });
    const first = setUpFlowHook(store, trigger(id), T0, dir);
    if (!first.ok) throw new Error(first.message);
    const oldSecret = first.reveal!.secret!, oldGeneration = trigger(id).hookGeneration;
    const renewed = renewFlowHook(store, trigger(id), T0, dir);
    if (!renewed.ok) throw new Error(renewed.message);
    expect(renewed.reveal!.secret).toBeNull();
    const sign = (secret: string, body: string) => ({ "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` });
    expect(deliver(tokenOf(renewed.reveal!.path), '{"title":"a"}', sign(oldSecret, '{"title":"a"}'))).toMatchObject({ status: 202 });

    const second = setUpFlowHook(store, trigger(id), T0, dir);
    if (!second.ok) throw new Error(second.message);
    expect(trigger(id).hookGeneration).toBe(oldGeneration + 1);
    // As if deleting the old secret had failed: it is back on disk under its generation, and still never read.
    saveHookSecret(dir, id, oldSecret, oldGeneration);
    const token = tokenOf(second.reveal!.path);
    expect(deliver(token, '{"title":"b"}', sign(oldSecret, '{"title":"b"}'))).toEqual({ status: 401, said: "Signature doesn't match." });
    expect(deliver(token, '{"title":"b"}', sign(second.reveal!.secret!, '{"title":"b"}'))).toMatchObject({ status: 202, said: "Added 1 card." });
  });

  test("Sentry's and Vercel's secrets are theirs: Set up makes only the address, the pasted secret is checked against its shape", () => {
    const { id } = add({ sender: "sentry", project: "web" });
    const setUp = setUpFlowHook(store, trigger(id), T0, dir);
    if (!setUp.ok) throw new Error(setUp.message);
    expect(setUp.reveal!.secret).toBeNull();
    expect(hookReady(trigger(id), dir)).toBe(false);
    expect(saveSigningSecret(store, trigger(id), "not a secret", T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("Client Secret") });
    expect(hookReady(trigger(id), dir)).toBe(false);
    const secret = "c0ffee".repeat(10) + "abcd";
    expect(saveSigningSecret(store, trigger(id), secret, T0, dir)).toMatchObject({ ok: true });
    expect(hookReady(trigger(id), dir)).toBe(true);
    const body = JSON.stringify({ action: "triggered", data: { event: { title: "TypeError" } } });
    expect(deliver(tokenOf(setUp.reveal!.path), body, {})).toEqual({ status: 401, said: "Sentry didn't sign this: use an Internal Integration's webhook." });
    expect(deliver(tokenOf(setUp.reveal!.path), body, { "sentry-hook-signature": createHmac("sha256", secret).update(body).digest("hex") })).toMatchObject({ status: 202 });
  });

  test("settings a sender doesn't read are refused, not kept", () => {
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "sentry", titleField: "data.title" }, "alex", T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("titleField") });
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "standard", project: "web" }, "alex", T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("project") });
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "sentry", team: "acme" }, "alex", T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("team") });
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "fax" }, "alex", T0, dir)).toMatchObject({ ok: false });
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", idField: "data..id" }, "alex", T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("dot-path") });
  });
});

describe("changing who signs it", () => {
  test("in place: the same trigger and address, its history kept, not ready until set up; nothing received unsigned stands for anything signed", () => {
    const { id, reveal } = add({ title: "Request" });
    const token = tokenOf(reveal.path);
    const body = '{"title":"Same bytes"}';
    expect(deliver(token, body)).toEqual({ status: 202, said: "Added 1 card." });
    const before = receipts(id);

    expect(changeFlowHookSender(store, trigger(id), "github-style", "alex", T0, dir)).toMatchObject({ ok: true });
    expect(trigger(id).id).toBe(id);
    expect(triggerConfigOf(trigger(id))).toMatchObject({ kind: "webhook", sender: "github-style", title: "Request" });
    expect(receipts(id)).toBe(before);
    expect(hookReady(trigger(id), dir)).toBe(false);
    // The address still answers, but refuses until it is set up: an unsigned post no longer adds anything.
    expect(deliver(token, '{"title":"After"}')).toMatchObject({ status: 401 });
    const setUp = setUpFlowHook(store, trigger(id), T0, dir);
    if (!setUp.ok) throw new Error(setUp.message);
    // The same bytes, now signed, are a new delivery: the unsigned receipt doesn't vouch for (or block) the signed one.
    const signed = { "x-hub-signature-256": `sha256=${createHmac("sha256", setUp.reveal!.secret!).update(body).digest("hex")}` };
    expect(deliver(tokenOf(setUp.reveal!.path), body, signed)).toEqual({ status: 202, said: "Added 1 card." });

    // Back to unsigned: ready at once (the address is all it has), and the signed secret is never read again.
    const signedGeneration = trigger(id).hookGeneration;
    expect(changeFlowHookSender(store, trigger(id), "none", "alex", T0, dir)).toMatchObject({ ok: true, said: expect.stringContaining("anyone with its address") });
    expect(hookReady(trigger(id), dir)).toBe(true);
    expect(trigger(id).hookGeneration).toBe(signedGeneration + 1);
    expect(readHookSecret(dir, id, trigger(id).hookGeneration)).toBeNull();
  });

  test("a scoped field the new sender doesn't read is left out on the change, and an unknown sender is refused", () => {
    const { id } = add({ titleField: "data.title", idField: "data.id" });
    expect(changeFlowHookSender(store, trigger(id), "sentry", "alex", T0, dir)).toMatchObject({ ok: true });
    expect(triggerConfigOf(trigger(id))).toMatchObject({ sender: "sentry", titleField: null, idField: null });
    expect(changeFlowHookSender(store, trigger(id), "fax", "alex", T0, dir)).toMatchObject({ ok: false });
  });
});

describe("upgrade", () => {
  test("a GitHub trigger set up before v126 keeps authenticating from where its secret always was; after a new secret, the old never does", () => {
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "github", repo: "acme/shop", watch: "issues", delivery: "webhook", from: "anyone" }, "alex", T0, dir);
    if (!made.ok) throw new Error(made.message);
    expect(trigger(made.id).hookGeneration).toBe(0);
    const legacy = made.reveal!.secret!;
    // Generation 0 is the address every saved secret has: nothing moved.
    expect(readHookSecret(dir, made.id, 0)).toBe(legacy);
    const ping = (secret: string) => deliver(tokenOf(made.reveal!.path), "{}", { "x-github-event": "ping", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update("{}").digest("hex")}` });
    expect(ping(legacy)).toEqual({ status: 200, said: "Connected." });
  });

  test("Linear: a pasted secret moves to the next generation, and the one before is refused even when its file survives", () => {
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "linear", team: "ENG", delivery: "webhook" }, "alex", T0, dir);
    if (!made.ok) throw new Error(made.message);
    const first = "a".repeat(32), second = "b".repeat(32);
    expect(saveSigningSecret(store, trigger(made.id), first, T0, dir)).toMatchObject({ ok: true });
    const firstGeneration = trigger(made.id).hookGeneration;
    expect(saveSigningSecret(store, trigger(made.id), second, T0, dir)).toMatchObject({ ok: true });
    saveHookSecret(dir, made.id, first, firstGeneration);
    const body = JSON.stringify({ type: "Issue", action: "create", webhookTimestamp: T0.getTime(), data: {} });
    const sent = (secret: string) => deliver(tokenOf(made.reveal!.path), body, { "linear-signature": createHmac("sha256", secret).update(body).digest("hex") });
    expect(sent(first)).toEqual({ status: 401, said: "Signature doesn't match." });
    expect(sent(second).status).toBe(202);
  });
});

test("an export carries who signs a webhook, never its secret; the import arrives not set up", () => {
  const { id } = add({ sender: "vercel", project: "prj_1", team: "team_1" });
  saveSigningSecret(store, trigger(id), "A1b2C3d4E5f6G7h8", T0, dir);
  const exported = exportFlow(store, store.getFlow(flow)!, dir);
  expect(exported.json).not.toContain("A1b2C3d4E5f6G7h8");
  expect(exported.file.triggers).toEqual([expect.objectContaining({ kind: "webhook", sender: "vercel", project: "{{param.webhook-project}}", team: "{{param.webhook-team}}" })]);
  const other = openStore(join(dir, "other.db"));
  try {
    const plan = planFlowImport(other, "/test/theirs", parseFlowFile(exported.json), { "webhook-project": "prj_9", "webhook-team": "team_9" }, "sam");
    const imported = importFlow(other, plan, "sam", T0, dir);
    const theirs = other.flowTriggers(imported.id)[0]!;
    expect(triggerConfigOf(theirs)).toMatchObject({ sender: "vercel", project: "prj_9", team: "team_9" });
    expect(hookReady(theirs, dir)).toBe(false);
  } finally { other.close(); }
});

describe("over HTTP", () => {
  let server: Server, port: number;
  beforeEach(async () => {
    server = createServer((request, response) => { void flowHook({ store, clock: () => T0, options: { configDir: dir } }, request, response, new URL(request.url ?? "/", "http://localhost")); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  /** A request written by hand, so a header can arrive on two lines, as a sender (or an attacker) may send it. */
  const raw = (path: string, lines: string[], body: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write([`POST ${path} HTTP/1.1`, "Host: localhost", "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", ...lines, "", body].join("\r\n"));
    });
    let data = "";
    socket.on("data", chunk => { data += chunk.toString(); });
    socket.on("end", () => { const [head, ...rest] = data.split("\r\n\r\n"); resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head ?? "")?.[1]), body: rest.join("\r\n\r\n") }); });
    socket.on("error", reject);
  });

  test("a signature header sent on two lines is refused, though one of them is right", async () => {
    const { id } = add({ sender: "standard" });
    const setUp = setUpFlowHook(store, trigger(id), T0, dir);
    if (!setUp.ok) throw new Error(setUp.message);
    const body = '{"title":"Two lines"}';
    const good = standard(setUp.reveal!.secret!, "m9", body);
    const lines = [`webhook-id: ${good["webhook-id"]}`, `webhook-timestamp: ${good["webhook-timestamp"]}`];
    const twice = await raw(setUp.reveal!.path, [...lines, "webhook-signature: v1,AAAA", `webhook-signature: ${good["webhook-signature"]}`], body);
    expect(twice).toMatchObject({ status: 401 });
    // The answer arrives chunked; its words are what matter.
    expect(twice.body).toContain(JSON.stringify({ said: "The webhook-signature header was sent more than once." }));
    expect(receipts(id)).toBe(0);
    const once = await raw(setUp.reveal!.path, [...lines, `webhook-signature: ${good["webhook-signature"]}`], body);
    expect(once.status).toBe(202);
  });
});
