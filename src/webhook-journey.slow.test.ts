/**
 * Signed webhooks into tasks over HTTP (docs/plans/webhook-tasks.md, Tests 1 and 4): "Webhook to build" from the
 * gallery, set up through the console's own route behind the password, a signed delivery to its public address, the
 * engine's pass, and the task page as the console serves it — the task waiting for a person, saying where it came
 * from. Then every refusal over HTTP writes nothing at all, and a replay under a fresh request id makes nothing new.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { advanceFlows } from "./flow-engine.js";
import { GALLERY, useGalleryTemplate } from "./flow-gallery.js";
import { flowHook } from "./server/remote-hooks.js";
import { scopeApprovedForDispatch } from "./dispatch.js";

const T0 = new Date();
let base: string, repo: string, store: Store, servers: Server[] = [];
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "so-journey-")));
  repo = join(base, "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  store = openStore(join(base, "orders.db"));
});
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  store.close(); rmSync(base, { recursive: true, force: true });
});

const listen = async (server: Server) => { servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };

test("from the gallery to a task waiting for a person, over HTTP; and no refusal writes anything", async () => {
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
  const used = useGalleryTemplate(store, GALLERY.find(one => one.id === "webhook-to-build")!, repo, {}, { by: "alex", now: T0, dir: base });
  if (!used.ok) throw new Error(used.said);
  const trigger = store.flowTriggers(used.flow).find(one => one.kind === "webhook")!;

  const consoleUrl = await listen(createDecisionServer({ store, evidenceRoot: join(base, "evidence"), clock: () => new Date(), repos: [repo], configDir: base }));
  const hooksUrl = await listen(createServer((request, response) => { void flowHook({ store, clock: () => new Date(), options: { configDir: base } }, request, response, new URL(request.url ?? "/", "http://localhost")); }));
  const login = await fetch(`${consoleUrl}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const page = async (path: string) => (await fetch(`${consoleUrl}${path}`, { headers: { cookie } })).text();
  const post = async (path: string, fields: Record<string, string>) => {
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await page("/flows"))?.[1] ?? /"csrf":"([0-9a-f]{64})"/.exec(await page("/flows?format=workspace"))?.[1];
    if (!csrf) throw new Error("no CSRF token");
    return fetch(`${consoleUrl}${path}`, { method: "POST", headers: { cookie, origin: consoleUrl, accept: "application/json" }, body: new URLSearchParams({ ...fields, csrf }) });
  };

  // Set up behind the password: a wrong one is refused and changes nothing; the right one shows address and secret once.
  expect((await post(`/flows/${used.flow}/triggers/${trigger.id}/setup`, { password: "wrong" })).status).toBe(403);
  expect(store.getFlowTrigger(trigger.id)!.hookCredential).toBe("");
  const setUp = await (await post(`/flows/${used.flow}/triggers/${trigger.id}/setup`, { password: alex.token })).json() as { ok: boolean; reveal: { path: string; secret: string } };
  expect(setUp.ok).toBe(true);
  const key = Buffer.from(setUp.reveal.secret.slice("whsec_".length), "base64");
  const hookAddress = `${hooksUrl}${setUp.reveal.path}`;
  const signed = (id: string, body: string, stamp = String(Math.floor(Date.now() / 1000))) => ({
    "content-type": "application/json", "webhook-id": id, "webhook-timestamp": stamp, "webhook-signature": `v1,${createHmac("sha256", key).update(`${id}.${stamp}.${body}`).digest("base64")}`,
  });

  // Every refusal over HTTP writes nothing: no receipt, no card, no outcome, no trigger change.
  const everything = () => JSON.stringify({ trigger: store.handle.prepare("SELECT * FROM flow_trigger WHERE id = ?").get(trigger.id),
    receipts: store.handle.prepare("SELECT * FROM flow_trigger_event").all(), cards: store.handle.prepare("SELECT COUNT(*) AS n FROM flow_card").get() });
  const before = everything();
  const body = JSON.stringify({ title: "Round refunds to the cent", description: "Partial refunds come out a cent short." });
  const seconds = Math.floor(Date.now() / 1000);
  for (const headers of [
    { ...signed("m1", body), "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },   // wrong signature
    signed("m1", body, String(seconds - 600)),                                                          // too old
    signed("m1", body, String(Date.now())),                                                             // milliseconds
    { ...signed("m1", body), "webhook-signature": "v1,%%%" },                                           // malformed
    { "content-type": "application/json" },                                                             // unsigned
  ]) expect((await fetch(hookAddress, { method: "POST", headers, body })).status).toBe(401);
  expect(everything()).toBe(before);

  // The signed request: one card; the same delivery replayed under a fresh request id is the same delivery.
  expect(await (await fetch(hookAddress, { method: "POST", headers: signed("m1", body), body })).json()).toEqual({ said: "Added 1 card." });
  expect(await (await fetch(hookAddress, { method: "POST", headers: { ...signed("m1", body), "x-request-id": "fresh-123" }, body })).json()).toEqual({ said: "Already received." });
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM flow_card WHERE flow = ?").get(used.flow)?.["n"]).toBe(1);

  advanceFlows(store, repo, new Date());
  const card = store.lastFlowTriggerCard(trigger.id)!;
  const task = store.getFlowCard(card)!.task!;
  expect(scopeApprovedForDispatch(store, store.lookupRef(task)!.id, new Date())).toBe(false);
  // The task page, as served: waiting for approval, filed by the automation, saying where it came from.
  const taskPage = await page(`/t/${task}`);
  expect(taskPage).toContain("Round refunds to the cent");
  expect(taskPage).toContain("Webhook (signed by Standard Webhooks)");
  expect(taskPage).toContain("Webhook to build");
  expect(taskPage).toMatch(/[Aa]pprove/);
});
