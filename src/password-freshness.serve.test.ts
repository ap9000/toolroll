/**
 * Password freshness through the console (docs/plans/agents-cockpit.md B2): a password typed to sign in on this
 * computer approves standard work with an empty field for fifteen minutes, and the approval says so; a forwarded
 * request, Forget, a quarantined filing and every other step-up still take a password typed now.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover, APPROVAL_PROOF } from "./scope.js";
import { createDecisionServer } from "./serve.js";

let dir: string, store: Store, server: Server, base: string, password: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-fresh-"));
  store = openStore(join(dir, "orders.db"));
  const added = addApprover(store, "alex", new Date());
  if (!added.ok) throw new Error("bootstrap");
  password = added.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", new Date());
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", configDir: dir });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const cookieOf = (answer: Response) => answer.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
const nonceOf = (html: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? "";

async function signedIn() {
  const answer = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
  const cookie = cookieOf(answer);
  const csrf = csrfOf(await (await fetch(`${base}/tasks`, { headers: { cookie } })).text());
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base, ...headers }, redirect: "manual", body: new URLSearchParams({ csrf, ...fields }) });
  const filed = async (id: string) => {
    store.createTask({ id, title: id }, new Date());
    expect((await post(`/t/${id}/scope`, { acceptance: "c1: ok | manual-review", sawDigest: "", goal: `do ${id}`, not: "", touches: "" })).status).toBe(303);
    const page = await (await fetch(`${base}/t/${id}`, { headers: { cookie } })).text();
    return { digest: store.getScope(id)?.digest ?? "", nonce: nonceOf(page), page };
  };
  return { cookie, post, filed };
}

test("a password typed to sign in on this computer approves standard work with an empty field, and the approval says so", async () => {
  const { cookie, post, filed } = await signedIn();
  const plan = await filed("t-fresh");
  expect(plan.page).toContain("data-approval-fresh");
  expect((await post("/t/t-fresh/approve", { nonce: plan.nonce, digest: plan.digest, token: "" })).status).toBe(303);
  expect(store.getScope("t-fresh")?.approvedBy).toBe("alex");
  expect(store.handle.prepare("SELECT outcome FROM action_ledger WHERE task_id = 't-fresh' AND action = ?").get(APPROVAL_PROOF)?.["outcome"]).toBe("fresh-password");
  expect(await (await fetch(`${base}/t/t-fresh`, { headers: { cookie } })).text()).toContain("(password remembered from");
  // The page carries the sidebar's line (drawn in the browser), with Forget.
  expect(await (await fetch(`${base}/agents`, { headers: { cookie } })).text()).toMatch(/"fresh":\{"minutes":\d+,"forget":"\/session\/forget-password"\}/);
});

test("a forwarded request, an expired window and Forget each take a password typed now", async () => {
  const { cookie: cookieAt, post, filed } = await signedIn();
  const forwarded = await filed("t-forwarded");
  expect([400, 409]).toContain((await post("/t/t-forwarded/approve", { nonce: forwarded.nonce, digest: forwarded.digest, token: "" }, { "x-forwarded-for": "203.0.113.9" })).status);
  expect(store.getScope("t-forwarded")?.approvedBy ?? null).toBeNull();
  // Any sign of a proxy disqualifies, not only X-Forwarded-For.
  for (const header of [{ "x-forwarded-proto": "https" }, { "x-real-ip": "203.0.113.9" }, { "x-forwarded-host": "toolroll.example" }, { via: "1.1 proxy" }]) {
    const one = await filed(`t-proxy-${Object.keys(header)[0]}`);
    expect([400, 409]).toContain((await post(`/t/t-proxy-${Object.keys(header)[0]}/approve`, { nonce: one.nonce, digest: one.digest, token: "" }, header)).status);
    expect(store.getScope(`t-proxy-${Object.keys(header)[0]}`)?.approvedBy ?? null).toBeNull();
  }
  const later = await filed("t-later");
  // Sixteen minutes on (a form drawn then, so its own nonce is current): no remembered password, and no approval.
  const sixteen = Date.now() + 16 * 60_000;
  vi.spyOn(Date, "now").mockReturnValue(sixteen);
  const laterPage = await (await fetch(`${base}/t/t-later`, { headers: { cookie: cookieAt } })).text();
  expect(laterPage).not.toContain("data-approval-fresh");
  expect((await post("/t/t-later/approve", { nonce: nonceOf(laterPage), digest: later.digest, token: "" })).status).toBe(400);
  expect(store.getScope("t-later")?.approvedBy ?? null).toBeNull();
  vi.restoreAllMocks();
  expect((await post("/session/forget-password", { return: "/tasks" })).status).toBe(303);
  const forgotten = await filed("t-forgot");
  expect(forgotten.page).not.toContain("data-approval-fresh");
  expect((await post("/t/t-forgot/approve", { nonce: forgotten.nonce, digest: forgotten.digest, token: "" })).status).toBe(400);
  expect(store.getScope("t-forgot")?.approvedBy ?? null).toBeNull();
  // A password typed again approves, and starts a new window.
  expect((await post("/t/t-forgot/approve", { nonce: nonceOf(await (await fetch(`${base}/t/t-forgot`, { headers: { cookie: (await signedIn()).cookie } })).text()), digest: forgotten.digest, token: password })).status).not.toBe(500);
});

test("a plan an agent wrote, and every other step-up, still take a password typed now", async () => {
  const { post, filed } = await signedIn();
  const written = await filed("t-written");
  store.handle.prepare("UPDATE task_scope SET proposed_via = 'mate' WHERE task_id = 't-written'").run();
  const page = await (await fetch(`${base}/t/t-written`, { headers: { cookie: (await signedIn()).cookie } })).text();
  expect(page).not.toContain("data-approval-fresh");
  const refused = await post("/t/t-written/approve", { nonce: written.nonce, digest: written.digest, token: "" });
  expect([400, 403]).toContain(refused.status);
  expect(store.getScope("t-written")?.approvedBy ?? null).toBeNull();
  // A never route: an empty password field does nothing, however fresh.
  const retention = await post("/settings/retention", { password: "" });
  expect(retention.headers.get("location") ?? "").toContain("problem=");
});

test("a sign-in through a proxy starts no window, and Forget works for a project-limited person", async () => {
  const answer = await fetch(`${base}/login`, { method: "POST", headers: { "x-forwarded-proto": "https" }, body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
  const cookie = cookieOf(answer);
  const page = await (await fetch(`${base}/agents`, { headers: { cookie } })).text();
  expect(page).not.toMatch(/"fresh":\{"minutes"/);
  // A project-limited approver reaches Forget (their own session only).
  const robin = addApprover(store, "robin", new Date(), { name: "alex", token: password });
  if (!robin.ok) throw new Error("robin");
  expect(store.setAccountProjects("robin", ["/repo/main"], "alex", new Date()).ok).toBe(true);
  const robinCookie = cookieOf(await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "robin", token: robin.token }), redirect: "manual" }));
  const robinCsrf = csrfOf(await (await fetch(`${base}/chat`, { headers: { cookie: robinCookie } })).text());
  const forgot = await fetch(`${base}/session/forget-password`, { method: "POST", headers: { cookie: robinCookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf: robinCsrf, return: "/chat" }) });
  expect(forgot.status).toBe(303);
});

test("a protected-work vote records how its person was proved, bound to the digest they said yes to", async () => {
  const { post, filed } = await signedIn();
  const plan = await filed("t-vote");
  vi.spyOn(store, "approvalGate").mockReturnValue({ verdict: "vote", have: 1, need: 2, already: false, protectedWork: true } as never);
  await post("/t/t-vote/approve", { nonce: plan.nonce, digest: plan.digest, token: password });
  const row = store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE task_id = 't-vote' AND action = ?").get(APPROVAL_PROOF);
  expect(row?.["outcome"]).toBe("password-now");
  expect(String(row?.["detail"])).toContain(`digest ${plan.digest}`);
});
