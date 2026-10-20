/**
 * v126 step 2 (docs/plans/webhook-tasks.md §1): how a webhook proves itself. Creating a trigger never makes a secret;
 * the panel makes one (Standard, GitHub-style: shown once, the address kept) or takes the sender's own (Sentry,
 * Vercel), first or as a replacement. Each secret is written whole at an address of its own before the trigger points
 * at it, so racing changes, a crash between the two, or a delivery read during a change can never authenticate with a
 * secret that isn't current. A sender changes in place with no secret at all. A refusal writes nothing; a security
 * header sent twice — as real header lines — is refused.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, V126_ADDED_COLUMNS, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { flowFromSteps } from "./flows.js";
import { addFlowTriggerTo, changeFlowHookSender, hookReady, readHookSecret, receiveFlowHook, renewFlowHook, saveHookSecret, saveSigningSecret, setFlowHookScope, setUpFlowHook, triggerConfigOf } from "./flow-triggers.js";
import { exportFlow, importFlow, parseFlowFile, planFlowImport } from "./flow-share.js";
import { flowView } from "./flows-ui.js";
import { standardKey } from "./webhook-signing.js";
import { flowHook } from "./server/remote-hooks.js";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const REPO = "/test/shop";
const SENTRY_SECRET = "c0ffee".repeat(10) + "abcd";

let dir: string, store: Store, flow: number;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-hook-setup-")));
  store = openStore(join(dir, "orders.db"));
  flow = store.createFlow({ repo: REPO, name: "Intake", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
});
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const tokenOf = (path: string) => path.slice("/hooks/flow/".length);
const deliver = (token: string, body: string, headers: Record<string, string | string[]> = {}, now = T0) =>
  receiveFlowHook(store, token, { headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value : [value]])), body: Buffer.from(body) }, dir, now);
/** A Standard Webhooks delivery's headers, signed with `secret`. */
const standard = (secret: string, id: string, body: string, now = T0) => {
  const stamp = String(Math.floor(now.getTime() / 1000));
  return { "webhook-id": id, "webhook-timestamp": stamp, "webhook-signature": `v1,${createHmac("sha256", standardKey(secret)!).update(`${id}.${stamp}.${body}`).digest("base64")}` };
};
const githubStyle = (secret: string, body: string) => ({ "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` });
const sentry = (secret: string, body: string) => ({ "sentry-hook-signature": createHmac("sha256", secret).update(body).digest("hex") });
const add = (settings: Record<string, unknown>) => {
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", ...settings }, "alex", T0, dir);
  if (!made.ok) throw new Error(made.message);
  return { id: made.id, token: tokenOf(made.reveal!.path), secret: made.reveal!.secret };
};
const trigger = (id: number) => store.getFlowTrigger(id)!;
const receipts = (id: number) => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM flow_trigger_event WHERE trigger = ?").get(id)?.["n"]);
const made = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => { if (!result.ok) throw new Error(JSON.stringify(result)); return result as Extract<T, { ok: true }>; };

describe("provisioning", () => {
  test("creating a signed webhook on its panel shows its address and makes no secret; setting it up shows the secret once and keeps the address", () => {
    const { id, token, secret } = add({ sender: "standard", title: "Request" });
    expect(secret).toBeNull();
    expect(trigger(id).hookCredential).toBe("");
    expect(hookReady(trigger(id), dir)).toBe(false);
    // Refused while not set up, and nothing is written: no receipt, no last outcome.
    expect(deliver(token, '{"title":"x"}')).toEqual({ status: 401, said: "This webhook isn't set up yet: set up Standard Webhooks signing on the flow's Triggers panel first." });
    expect(receipts(id)).toBe(0);
    expect(trigger(id).lastOutcome).toBeNull();

    const setUp = made(setUpFlowHook(store, trigger(id), T0, dir));
    expect(setUp.reveal).toMatchObject({ path: "", address: null, secret: expect.stringMatching(/^whsec_/) });
    const key = setUp.reveal!.secret!;
    expect(hookReady(trigger(id), dir)).toBe(true);
    // The address shown when it was made is the one the sender already has: it stays.
    const fresh = token;
    expect(deliver(fresh, '{"title":"Checkout broke"}')).toEqual({ status: 401, said: "The webhook-id header is missing." });
    expect(deliver(fresh, '{"title":"Checkout broke"}', standard("whsec_" + Buffer.alloc(32, 7).toString("base64"), "m1", '{"title":"Checkout broke"}'))).toEqual({ status: 401, said: "Signature doesn't match." });
    expect(receipts(id)).toBe(0);
    expect(trigger(id).lastOutcome).toBeNull();
    expect(deliver(fresh, '{"title":"Checkout broke"}', standard(key, "m1", '{"title":"Checkout broke"}'))).toEqual({ status: 202, said: "Added 1 card." });
    expect(store.flowReceipt(id, "v3:standard:wid:m1")?.state).toBe("accepted");
    expect(deliver(fresh, '{"title":"Checkout broke"}', standard(key, "m1", '{"title":"Checkout broke"}'))).toEqual({ status: 202, said: "Already received." });
  });

  test("New address keeps the secret; Replace secret keeps the address; the replaced secret is refused even when its file survives", () => {
    const { id } = add({ sender: "github-style" });
    const first = made(setUpFlowHook(store, trigger(id), T0, dir)).reveal!.secret!;
    const firstCredential = trigger(id).hookCredential;
    const renewed = made(renewFlowHook(store, trigger(id), T0, dir));
    expect(renewed.reveal!.secret).toBeNull();
    const token = tokenOf(renewed.reveal!.path);
    expect(deliver(token, '{"title":"a"}', githubStyle(first, '{"title":"a"}'))).toMatchObject({ status: 202 });

    const second = made(setUpFlowHook(store, trigger(id), T0, dir)).reveal!.secret!;
    expect(trigger(id).hookCredential).not.toBe(firstCredential);
    // As if removing the replaced secret had failed: it is back on disk under its own id, and still never read.
    saveHookSecret(dir, id, first, firstCredential);
    expect(deliver(token, '{"title":"b"}', githubStyle(first, '{"title":"b"}'))).toEqual({ status: 401, said: "Signature doesn't match." });
    expect(deliver(token, '{"title":"b"}', githubStyle(second, '{"title":"b"}'))).toEqual({ status: 202, said: "Added 1 card." });
  });

  test("Sentry's secret is theirs: pasted, checked against its shape, and replaceable once set; the old one is then refused", () => {
    const { id, token } = add({ sender: "sentry", project: "web" });
    expect(setUpFlowHook(store, trigger(id), T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("paste it") });
    expect(saveSigningSecret(store, trigger(id), "not a secret", T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("Client Secret") });
    expect(hookReady(trigger(id), dir)).toBe(false);
    made(saveSigningSecret(store, trigger(id), SENTRY_SECRET, T0, dir));
    expect(hookReady(trigger(id), dir)).toBe(true);
    const body = JSON.stringify({ action: "triggered", data: { event: { title: "TypeError" } } });
    expect(deliver(token, body, {})).toEqual({ status: 401, said: "Sentry didn't sign this: use an Internal Integration's webhook." });
    expect(deliver(token, body, sentry(SENTRY_SECRET, body))).toMatchObject({ status: 202 });
    // Replaced while ready (the provider rotated it): the old one no longer proves anything.
    const replacement = "beef".repeat(16);
    made(saveSigningSecret(store, trigger(id), replacement, T0, dir));
    const later = JSON.stringify({ action: "triggered", data: { event: { title: "RangeError" } } });
    expect(deliver(token, later, sentry(SENTRY_SECRET, later))).toEqual({ status: 401, said: "Signature doesn't match." });
    expect(deliver(token, later, sentry(replacement, later))).toMatchObject({ status: 202 });
  });

  test("settings a sender doesn't read are refused, not kept", () => {
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "sentry", titleField: "data.title" }, "alex", T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("titleField") });
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "standard", project: "web" }, "alex", T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("project") });
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "sentry", team: "acme" }, "alex", T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("team") });
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", sender: "fax" }, "alex", T0, dir)).toMatchObject({ ok: false });
    expect(addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "webhook", idField: "data..id" }, "alex", T0, dir)).toMatchObject({ ok: false, message: expect.stringContaining("dot-path") });
  });
});

test("what the panel is given: who signs each webhook, whether its secret is made or pasted, and a warning in words until it is safe", () => {
  const unsigned = add({ title: "Open" }).id;
  const standardHook = add({ sender: "standard" }).id;
  const sentryHook = add({ sender: "sentry" }).id;
  const hookOf = (id: number) => flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null, { dir, repos: [REPO] }).triggers.find(one => one.id === id)!.hook;
  expect(hookOf(unsigned)).toMatchObject({ ready: true, sender: "none", makesSecret: false, needsSecret: false, warning: expect.stringContaining("anyone with its address") });
  expect(hookOf(standardHook)).toMatchObject({ ready: false, sender: "standard", makesSecret: true, needsSecret: false, warning: expect.stringContaining("until it is set up") });
  made(setUpFlowHook(store, trigger(standardHook), T0, dir));
  expect(hookOf(standardHook)).toMatchObject({ ready: true, warning: null });
  // Sentry's is pasted — offered again once set, to replace it — and an unscoped one says any project can add cards.
  expect(hookOf(sentryHook)).toMatchObject({ ready: false, sender: "sentry", makesSecret: false, needsSecret: true });
  made(saveSigningSecret(store, trigger(sentryHook), SENTRY_SECRET, T0, dir));
  expect(hookOf(sentryHook)).toMatchObject({ ready: true, needsSecret: true, warning: expect.stringContaining("Any Sentry project") });
  // Its reader's status is said on its own line, whatever else the row warns about.
  expect(hookOf(sentryHook)?.readerNote).toContain("Reader unverified");
  expect(hookOf(standardHook)?.readerNote).toBeNull();
});

describe("credentials under races and crashes", () => {
  test("two changes from the same reading: exactly one lands, its secret stays whole, and the other's is never current", () => {
    const { id, token } = add({ sender: "sentry" });
    // Both read the trigger before either writes (two consoles, two processes).
    const seenByA = trigger(id), seenByB = trigger(id);
    const a = "aa".repeat(32), b = "bb".repeat(32);
    expect(saveSigningSecret(store, seenByA, a, T0, dir)).toMatchObject({ ok: true });
    expect(saveSigningSecret(store, seenByB, b, T0, dir)).toEqual({ ok: false, message: "That trigger changed meanwhile. Open it again." });
    expect(readHookSecret(dir, id, trigger(id).hookCredential)).toBe(a);
    const body = '{"action":"triggered"}';
    expect(deliver(token, body, sentry(b, body))).toEqual({ status: 401, said: "Signature doesn't match." });
    expect(deliver(token, body, sentry(a, body))).toMatchObject({ status: 202 });
  });

  test("what a crash leaves behind is never adopted: a sender change has no secret at all until one is made for it", () => {
    const { id, token } = add({ sender: "github-style" });
    const leftover = "left".repeat(8);
    // Anything an unfinished change may have left — at the address saved secrets once had, or at an id nothing points at.
    saveHookSecret(dir, id, leftover, "legacy");
    saveHookSecret(dir, id, leftover, "0123456789abcdef0123456789abcdef");
    expect(hookReady(trigger(id), dir)).toBe(false);
    made(changeFlowHookSender(store, trigger(id), "sentry", "alex", T0, dir));
    expect(trigger(id).hookCredential).toBe("");
    expect(hookReady(trigger(id), dir)).toBe(false);
    const body = '{"action":"triggered"}';
    expect(deliver(token, body, sentry(leftover, body))).toMatchObject({ status: 401 });
    expect(receipts(id)).toBe(0);
  });

  test("a delivery proved against a secret that changes before it writes writes nothing", () => {
    const { id, token } = add({ sender: "github-style" });
    const old = made(setUpFlowHook(store, trigger(id), T0, dir)).reveal!.secret!;
    // The receiver reads the trigger; before it writes, another process changes who signs it — and removing the old
    // secret fails, so the receiver can still prove the delivery against it. Only the binding stops the write.
    const lookup = store.flowTriggerByHook.bind(store);
    vi.spyOn(store, "flowTriggerByHook").mockImplementationOnce(hash => {
      const seen = lookup(hash);
      made(changeFlowHookSender(store, trigger(id), "sentry", "alex", T0, dir));
      saveHookSecret(dir, id, old, seen!.hookCredential);
      return seen;
    });
    const body = '{"title":"In flight"}';
    expect(deliver(token, body, githubStyle(old, body))).toEqual({ status: 409, said: "This webhook changed while the delivery was read. Send it again." });
    expect(receipts(id)).toBe(0);
    expect(trigger(id).lastOutcome).toBeNull();
  });
});

describe("changing who signs it", () => {
  test("in place: the same trigger and address, its history kept, not ready until its secret is made; nothing received unsigned stands for anything signed", () => {
    const { id, token } = add({ title: "Request" });
    const body = '{"title":"Same bytes"}';
    expect(deliver(token, body)).toEqual({ status: 202, said: "Added 1 card." });
    const before = receipts(id);

    made(changeFlowHookSender(store, trigger(id), "github-style", "alex", T0, dir));
    expect(triggerConfigOf(trigger(id))).toMatchObject({ kind: "webhook", sender: "github-style", title: "Request" });
    expect(receipts(id)).toBe(before);
    expect(hookReady(trigger(id), dir)).toBe(false);
    expect(deliver(token, '{"title":"After"}')).toMatchObject({ status: 401 });
    const setUp = made(setUpFlowHook(store, trigger(id), T0, dir));
    // Set up again under its new sender: the same address (the sender has it), a new secret. The same bytes, now signed, are a new delivery.
    expect(setUp.reveal!.path).toBe("");
    expect(deliver(token, body, githubStyle(setUp.reveal!.secret!, body))).toEqual({ status: 202, said: "Added 1 card." });

    made(changeFlowHookSender(store, trigger(id), "none", "alex", T0, dir));
    expect(hookReady(trigger(id), dir)).toBe(true);
    expect(trigger(id).hookCredential).toBe("");
  });

  test("a field the new sender doesn't read is left out on the change, and an unknown sender is refused", () => {
    const { id } = add({ titleField: "data.title", idField: "data.id" });
    made(changeFlowHookSender(store, trigger(id), "sentry", "alex", T0, dir));
    expect(triggerConfigOf(trigger(id))).toMatchObject({ sender: "sentry", titleField: null, idField: null });
    expect(changeFlowHookSender(store, trigger(id), "fax", "alex", T0, dir)).toMatchObject({ ok: false });
  });
});

test("a database from before v126: its GitHub and Linear webhooks keep authenticating; a new secret makes the old one useless even when its file survives", () => {
  const file = join(dir, "old.db");
  const old = openStore(file);
  const oldFlow = old.createFlow({ repo: REPO, name: "Intake", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
  const github = made(addFlowTriggerTo(old, old.getFlow(oldFlow)!, { kind: "github", repo: "acme/shop", watch: "issues", delivery: "webhook", from: "anyone" }, "alex", T0, dir));
  const linear = made(addFlowTriggerTo(old, old.getFlow(oldFlow)!, { kind: "linear", team: "ENG", delivery: "webhook" }, "alex", T0, dir));
  const linearSecret = "l".repeat(32);
  saveHookSecret(dir, linear.id, linearSecret); // where a pre-v126 console pasted it
  old.close();
  // Back to v125's shape: no credential pointer, no receipt state.
  const db = new DatabaseSync(file);
  db.exec("DROP INDEX flow_trigger_event_accepted");
  db.exec("DROP TABLE task_source");
  for (const [table, columns] of Object.entries(V126_ADDED_COLUMNS)) for (const column of Object.keys(columns)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.prepare("UPDATE schema_version SET version = 125").run();
  db.close();

  store.close();
  store = openStore(file);
  expect(trigger(github.id).hookCredential).toBe("legacy");
  const gh = tokenOf(github.reveal!.path), ln = tokenOf(linear.reveal!.path);
  expect(deliver(gh, "{}", { "x-github-event": "ping", ...githubStyle(github.reveal!.secret!, "{}") })).toEqual({ status: 200, said: "Connected." });
  const issue = JSON.stringify({ type: "Issue", action: "create", webhookTimestamp: T0.getTime(), data: {} });
  const signedLinear = (secret: string) => deliver(ln, issue, { "linear-signature": createHmac("sha256", secret).update(issue).digest("hex") });
  expect(signedLinear(linearSecret).status).toBe(202);

  // GitHub's New address makes a new secret (as it always has); Linear's is pasted again. The legacy files survive.
  const renewed = made(renewFlowHook(store, trigger(github.id), T0, dir));
  saveHookSecret(dir, github.id, github.reveal!.secret!, "legacy");
  const ping = (secret: string) => deliver(tokenOf(renewed.reveal!.path), "{}", { "x-github-event": "ping", ...githubStyle(secret, "{}") });
  expect(ping(github.reveal!.secret!)).toEqual({ status: 401, said: "Signature doesn't match." });
  expect(ping(renewed.reveal!.secret!)).toEqual({ status: 200, said: "Connected." });
  made(saveSigningSecret(store, trigger(linear.id), "m".repeat(32), T0, dir));
  saveHookSecret(dir, linear.id, linearSecret, "legacy");
  expect(signedLinear(linearSecret)).toEqual({ status: 401, said: "Signature doesn't match." });
});

describe("export", () => {
  test("every new setting round-trips, never a secret; an import arrives not set up", () => {
    const vercel = add({ sender: "vercel", project: "prj_1", team: "team_1" });
    made(saveSigningSecret(store, trigger(vercel.id), "A1b2C3d4E5f6G7h8", T0, dir));
    add({ sender: "standard", title: "Request", titleField: "data.title", bodyField: "data.body", idField: "data.id", urlField: "data.url" });
    const exported = exportFlow(store, store.getFlow(flow)!, dir);
    expect(exported.json).not.toContain("A1b2C3d4E5f6G7h8");
    expect(exported.file.triggers).toEqual([
      expect.objectContaining({ kind: "webhook", sender: "vercel", project: "{{param.webhook-project}}", team: "{{param.webhook-team}}" }),
      expect.objectContaining({ kind: "webhook", sender: "standard", titleField: "data.title", bodyField: "data.body", idField: "data.id", urlField: "data.url" }),
    ]);
    const other = openStore(join(dir, "other.db"));
    try {
      const plan = planFlowImport(other, "/test/theirs", parseFlowFile(exported.json), { "webhook-project": "prj_9", "webhook-team": "team_9" }, "sam");
      const imported = importFlow(other, plan, "sam", T0, dir);
      const [theirVercel, theirStandard] = other.flowTriggers(imported.id);
      expect(triggerConfigOf(theirVercel!)).toMatchObject({ sender: "vercel", project: "prj_9", team: "team_9" });
      expect(triggerConfigOf(theirStandard!)).toMatchObject({ sender: "standard", titleField: "data.title", bodyField: "data.body", idField: "data.id", urlField: "data.url" });
      for (const one of [theirVercel!, theirStandard!]) expect(hookReady(one, dir)).toBe(false);
    } finally { other.close(); }
  });

  test("a sender is kept as it is, even when a person on the flow shares its name", () => {
    // The first account bootstraps; the others are vouched for by it.
    const first = addApprover(store, "sentry", T0);
    if (!first.ok) throw new Error("bootstrap");
    for (const name of ["vercel", "standard"]) if (!addApprover(store, name, T0, { name: "sentry", token: first.token }).ok) throw new Error(name);
    store.setFlowOwner(flow, "sentry", T0);
    add({ sender: "sentry" });
    add({ sender: "standard" });
    const exported = exportFlow(store, store.getFlow(flow)!, dir);
    expect(exported.file.triggers.map(one => (one as Record<string, unknown>)["sender"])).toEqual(["sentry", "standard"]);
    expect(() => parseFlowFile(exported.json)).not.toThrow();
  });
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
    const { id, token } = add({ sender: "standard" });
    const key = made(setUpFlowHook(store, trigger(id), T0, dir)).reveal!.secret!;
    const body = '{"title":"Two lines"}';
    const good = standard(key, "m9", body);
    const lines = [`webhook-id: ${good["webhook-id"]}`, `webhook-timestamp: ${good["webhook-timestamp"]}`];
    const twice = await raw(`/hooks/flow/${token}`, [...lines, "webhook-signature: v1,AAAA", `webhook-signature: ${good["webhook-signature"]}`], body);
    expect(twice.status).toBe(401);
    // The answer arrives chunked; its words are what matter.
    expect(twice.body).toContain(JSON.stringify({ said: "The webhook-signature header was sent more than once." }));
    expect(receipts(id)).toBe(0);
    const once = await raw(`/hooks/flow/${token}`, [...lines, `webhook-signature: ${good["webhook-signature"]}`], body);
    expect(once.status).toBe(202);
  });
});

test("a Vercel webhook is scoped to its project in place: same secret and address, and another project's deployment is then ignored", () => {
  const secret = "VercelSecret0123456789";
  const { id, token } = add({ sender: "vercel" });
  made(saveSigningSecret(store, trigger(id), secret, T0, dir));
  const credential = trigger(id).hookCredential;
  const failed = (project: string) => {
    const body = JSON.stringify({ type: "deployment.error", payload: { project: { id: project }, team: { id: "team_1" }, deployment: { id: `dpl_${project}`, name: "shop" }, links: { deployment: "https://vercel.com/acme/shop/x" } } });
    return deliver(token, body, { "x-vercel-signature": createHmac("sha1", secret).update(body).digest("hex") });
  };
  expect(setFlowHookScope(store, trigger(id), { project: "prj_1", team: "team_1" }, "alex", T0)).toEqual({ ok: true, said: "Only deliveries from prj_1 add cards now." });
  expect(trigger(id).hookCredential).toBe(credential);
  expect(triggerConfigOf(trigger(id))).toMatchObject({ sender: "vercel", project: "prj_1", team: "team_1" });
  expect(failed("prj_2")).toEqual({ status: 202, said: "Ignored: from another Vercel project." });
  expect(failed("prj_1")).toEqual({ status: 202, said: "Added 1 card." });
  // Blank again takes any project; a Standard webhook has no project to scope.
  expect(setFlowHookScope(store, trigger(id), { project: "", team: "" }, "alex", T0)).toMatchObject({ ok: true, said: expect.stringContaining("Any Vercel project") });
  expect(setFlowHookScope(store, trigger(add({ sender: "standard" }).id), { project: "x", team: null }, "alex", T0)).toMatchObject({ ok: false });
});

test("an unsigned webhook with an identity field switched to signed: the signed entity makes its card, though the unsigned one named it first", () => {
  const { id, token } = add({ title: "Request", idField: "incident.id" });
  const body = JSON.stringify({ incident: { id: "INC-7" }, title: "Checkout down" });
  expect(deliver(token, body)).toEqual({ status: 202, said: "Added 1 card." });
  expect(store.flowReceipt(id, "v3:none:id:INC-7")?.state).toBe("accepted");
  made(changeFlowHookSender(store, trigger(id), "github-style", "alex", T0, dir));
  const setUp = made(setUpFlowHook(store, trigger(id), T0, dir));
  // The same incident, now signed: its key carries its sender, so the unsigned receipt neither vouches for nor blocks it.
  expect(deliver(token, body, githubStyle(setUp.reveal!.secret!, body))).toEqual({ status: 202, said: "Added 1 card." });
  expect(store.flowReceipt(id, "v3:github-style:id:INC-7")?.state).toBe("accepted");
});
