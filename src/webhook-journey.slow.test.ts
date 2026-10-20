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
import { addFlowTriggerTo } from "./flow-triggers.js";
import { signUnattended } from "./flow-unattended.js";
import { flowHook } from "./server/remote-hooks.js";
import { scopeApprovedForDispatch } from "./dispatch.js";
import { register } from "./runner.js";
import { acquireIfReady } from "./claim.js";

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
  // The flow also runs on its own for its schedule: that grant never covers a webhook's card.
  const schedule = addFlowTriggerTo(store, store.getFlow(used.flow)!, { kind: "schedule", schedule: "daily 09:00", title: "Nightly" }, "alex", T0, base);
  if (!schedule.ok) throw new Error(schedule.message);
  const granted = await signUnattended(store, { flow: used.flow, signer: "alex", ask: { days: 2, budgetMicrousd: null, dailyRunCap: null } }, new Date());
  if (!granted.ok) throw new Error(granted.message);

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
  const ref = store.lookupRef(task)!;
  expect(scopeApprovedForDispatch(store, ref.id, new Date())).toBe(false);
  // A worker's claim is refused: the claim re-proves the approval in its own write.
  register(store, { name: "builder", host: "test", capacity: 1, repos: [repo], now: new Date(), newToken: () => "builder-token" });
  expect(acquireIfReady(store, ref.id, "builder", { token: "builder-token", now: new Date(), ttlMs: 3_600_000, dispatchRole: "builder" })).toMatchObject({ ok: false });
  // The task page, as served: waiting for approval, filed by the automation, saying where it came from.
  const taskPage = await page(`/t/${task}`);
  expect(taskPage).toContain("Round refunds to the cent");
  expect(taskPage).toContain("Webhook (signed by Standard Webhooks)");
  expect(taskPage).toContain("Webhook to build");
  expect(taskPage).toMatch(/[Aa]pprove/);

  // A person approves it with the password, through the console; only then may a worker claim it.
  const scope = store.getScope(task)!;
  const nonce = /name="nonce" value="([^"]+)"/.exec(taskPage)?.[1];
  const digest = /name="digest" value="([^"]+)"/.exec(taskPage)?.[1];
  expect(nonce && digest).toBeTruthy();
  const approved = await post(`/t/${task}/approve`, { token: alex.token, nonce: nonce!, digest: digest! });
  expect(approved.status).toBeLessThan(400);
  expect(store.getScope(task)!.approvedDigest).toBe(scope.digest);
  expect(acquireIfReady(store, ref.id, "builder", { token: "builder-token", now: new Date(), ttlMs: 3_600_000, dispatchRole: "builder" })).toMatchObject({ ok: true });
});

test("Vercel over HTTP, set up and scoped through the console's routes: only the project's failed deployments add cards", async () => {
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  const used = useGalleryTemplate(store, GALLERY.find(one => one.id === "failed-deploy")!, repo, {}, { by: "alex", now: T0, dir: base });
  if (!used.ok) throw new Error(used.said);
  const trigger = store.flowTriggers(used.flow).find(one => one.kind === "webhook")!;
  const consoleUrl = await listen(createDecisionServer({ store, evidenceRoot: join(base, "evidence"), clock: () => new Date(), repos: [repo], configDir: base }));
  const hooksUrl = await listen(createServer((request, response) => { void flowHook({ store, clock: () => new Date(), options: { configDir: base } }, request, response, new URL(request.url ?? "/", "http://localhost")); }));
  const login = await fetch(`${consoleUrl}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const post = async (path: string, fields: Record<string, string>) => {
    const csrf = /"csrf":"([0-9a-f]{64})"/.exec(await (await fetch(`${consoleUrl}/flows?format=workspace`, { headers: { cookie } })).text())?.[1]
      ?? /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${consoleUrl}/flows`, { headers: { cookie } })).text())?.[1];
    return fetch(`${consoleUrl}${path}`, { method: "POST", headers: { cookie, origin: consoleUrl, accept: "application/json" }, body: new URLSearchParams({ ...fields, csrf: csrf! }) });
  };
  const at = (verb: string) => `/flows/${used.flow}/triggers/${trigger.id}/${verb}`;
  // Made from the gallery: no address, no secret. New address makes one; until the secret is pasted, every delivery is refused.
  // A new address is a credential act: the password, typed (Passwordless never covers it).
  const renewed = await (await post(at("renew"), { password: alex.token })).json() as { reveal: { path: string } };
  const address = `${hooksUrl}${renewed.reveal.path}`;
  const secret = "VercelSecret0123456789";
  const failed = (project: string, type = "deployment.error") => {
    const body = JSON.stringify({ type, payload: { project: { id: project }, team: { id: "team_1" }, deployment: { id: `dpl_${project}_${type}`, name: "shop" }, links: { deployment: "https://vercel.com/acme/shop/x" } } });
    return fetch(address, { method: "POST", headers: { "x-vercel-signature": createHmac("sha1", secret).update(body).digest("hex") }, body });
  };
  // Before its secret is pasted, a delivery is refused and writes nothing at all.
  const everything = () => JSON.stringify({ trigger: store.handle.prepare("SELECT * FROM flow_trigger WHERE id = ?").get(trigger.id),
    receipts: store.handle.prepare("SELECT * FROM flow_trigger_event").all(), cards: store.handle.prepare("SELECT COUNT(*) AS n FROM flow_card").get() });
  const before = everything();
  expect((await failed("prj_1")).status).toBe(401);
  expect(everything()).toBe(before);
  // The secret and the project, each behind the password: a wrong one changes nothing.
  expect((await post(at("secret"), { secret, password: "wrong" })).status).toBe(403);
  expect((await post(at("secret"), { secret, password: alex.token })).status).toBe(200);
  expect((await post(at("scope"), { project: "prj_1", team: "", password: "wrong" })).status).toBe(403);
  expect(store.getFlowTrigger(trigger.id)!.configJson).not.toContain("prj_1");
  expect((await post(at("scope"), { project: "prj_1", team: "", password: alex.token })).status).toBe(200);
  expect(await (await failed("prj_1", "deployment.succeeded")).json()).toEqual({ said: "Ignored: not a failed deployment." });
  expect(await (await failed("prj_2")).json()).toEqual({ said: "Ignored: from another Vercel project." });
  expect(await (await failed("prj_1")).json()).toEqual({ said: "Added 1 card." });
});
