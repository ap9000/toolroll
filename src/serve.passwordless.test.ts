/**
 * Passwordless over real HTTP (docs/plans/passwordless.md): turning it on takes a typed password and off is one click;
 * with it on, an ordinary step-up needs only the signed-in session and its form shows no password field; a credential
 * act still asks; and a session ended elsewhere signs nobody in.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { passwordlessOn } from "./passwordless.js";
import { PersistentSessions } from "./server/session.js";
import { T0 } from "../test/serve-kit.js";
import { flowFromSteps } from "./flows.js";

let home: string, store: Store, server: Server, base: string, password: string;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "so-passwordless-")));
  store = openStore(":memory:");
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap failed");
  password = added.token;
  server = createDecisionServer({ store, evidenceRoot: home, repos: [home], terminalHost: null, configDir: home } as Parameters<typeof createDecisionServer>[0]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const login = async () => {
  const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
};
const page = async (cookie: string, path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? /data-csrf="([^"]+)"/.exec(html)?.[1] ?? "";
const post = async (cookie: string, path: string, fields: Record<string, string>) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(fields), redirect: "manual" });
  return { status: response.status, location: decodeURIComponent(response.headers.get("location") ?? "") };
};

test("turning it on takes a typed password; with it on, an ordinary step-up needs only the session", async () => {
  const cookie = await login();
  const csrf = csrfOf(await page(cookie, "/settings/passwordless"));
  expect(csrf).not.toBe("");
  // Off: the retention save asks for the password.
  expect((await post(cookie, "/settings/retention", { csrf })).location).toMatch(/Enter your Toolroll password/);
  // On needs the password, typed.
  expect((await post(cookie, "/settings/passwordless", { csrf, action: "on" })).location).toMatch(/Enter your Toolroll password to turn Passwordless on/);
  expect(passwordlessOn(store)).toBe(false);
  expect((await post(cookie, "/settings/passwordless", { csrf, action: "on", password })).location).toMatch(/Passwordless is on/);
  expect(passwordlessOn(store)).toBe(true);
  // On: the same save with no password goes through.
  expect((await post(cookie, "/settings/retention", { csrf })).location).toMatch(/said=Nothing changed/);
  // Off is one click.
  expect((await post(cookie, "/settings/passwordless", { csrf, action: "off" })).location).toMatch(/Passwordless is off/);
  expect((await post(cookie, "/settings/retention", { csrf })).location).toMatch(/Enter your Toolroll password/);
});

test("with it on, ceremony forms show no password field; the sign-in form still does", async () => {
  const cookie = await login();
  const csrf = csrfOf(await page(cookie, "/settings/passwordless"));
  expect(await page(cookie, "/settings/retention")).toMatch(/type="password" name="password"/);
  await post(cookie, "/settings/passwordless", { csrf, action: "on", password });
  expect(await page(cookie, "/settings/retention")).not.toMatch(/type="password" name="password"/);
  expect(await (await fetch(`${base}/login`)).text()).toMatch(/type="password"/);
});

test("with it on, a credential act still asks for a typed password", async () => {
  const cookie = await login();
  const csrf = csrfOf(await page(cookie, "/settings/passwordless"));
  await post(cookie, "/settings/passwordless", { csrf, action: "on", password });
  const refused = await post(cookie, "/people/invite", { csrf, role: "viewer", token: "" });
  expect(refused.status).toBe(403);
  expect(store.openInvites(new Date())).toHaveLength(0);
  // The same act with the password typed goes through.
  await post(cookie, "/people/invite", { csrf, role: "viewer", token: password });
  expect(store.openInvites(new Date())).toHaveLength(1);
});

test("a session ended from another process no longer signs anyone in, even with it on", async () => {
  const cookie = await login();
  const csrf = csrfOf(await page(cookie, "/settings/passwordless"));
  await post(cookie, "/settings/passwordless", { csrf, action: "on", password });
  // Another process ends the saved session; this one still holds it in memory.
  store.dropWebSession(PersistentSessions.hash(/=([0-9a-f]{64})/.exec(cookie)![1]!));
  const response = await post(cookie, "/settings/retention", { csrf });
  expect(response.location).not.toMatch(/said=Nothing changed/);
});

test("with it on, adding a webhook trigger (an address) still takes a typed password; a schedule doesn't", async () => {
  const flow = store.createFlow({ repo: home, name: "Inbound", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ id: "triage", title: "Triage", kind: "task", instructions: "Look." }], null)) }, T0);
  const cookie = await login();
  const csrf = csrfOf(await page(cookie, "/settings/passwordless"));
  await post(cookie, "/settings/passwordless", { csrf, action: "on", password });
  const add = async (trigger: object, extra: Record<string, string> = {}) => {
    const response = await fetch(`${base}/flows/${flow}/triggers`, { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams({ csrf, trigger: JSON.stringify(trigger), ...extra }) });
    return { status: response.status, body: await response.json() as { ok: boolean } };
  };
  expect(await add({ kind: "webhook" })).toMatchObject({ status: 403, body: { ok: false } });
  expect(store.flowTriggers(flow).filter(one => one.kind === "webhook")).toHaveLength(0);
  expect(await add({ kind: "webhook" }, { password })).toMatchObject({ body: { ok: true } });
  expect(await add({ kind: "schedule", schedule: "daily 09:00", title: "Standup" })).toMatchObject({ body: { ok: true } });
});

test("the three widening actions take a password (an ordinary step-up: with Passwordless on, the session does)", async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  // Settings → Unattended permissions answers only on a console with chat settings.
  server = createDecisionServer({ store, evidenceRoot: home, repos: [home], terminalHost: null, configDir: home, telegramTokenFile: join(home, "telegram-token") } as Parameters<typeof createDecisionServer>[0]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { setUpKit, kitOf, kitInstalled } = await import("./kits.js");
  const kit = kitOf("support-desk")!;
  expect(await setUpKit(store, kit, home, "alex", T0, home)).toMatchObject({ ok: true });
  const mate = kitInstalled(store, kit, home)!.mate;
  const cookie = await login();
  const csrf = csrfOf(await page(cookie, "/settings/passwordless"));
  const widen = {
    fullAccess: (extra: Record<string, string> = {}) => post(cookie, "/settings/permission-default", { csrf, "permission-mode": "bypassPermissions", ...extra }),
    toolGrant: (extra: Record<string, string> = {}) => post(cookie, `/settings/lead/subagents/${mate.id}/tools`, { csrf, op: "grant", tool: "stripe", ...extra }),
    kitGithub: (extra: Record<string, string> = {}) => post(cookie, `/kits/${kit.id}/github`, { csrf, repo: home, ...extra }),
  };
  // No password: refused, nothing changes.
  expect((await widen.fullAccess()).location).toMatch(/Enter your Toolroll password to start new tasks with Full access/);
  expect(store.permissionDefault().mode).toBe("auto");
  expect((await widen.toolGrant()).location).toMatch(/Enter your Toolroll password to let .* use stripe/);
  expect((await widen.kitGithub()).location).toMatch(/Enter your Toolroll password to bring in GitHub issues/);
  // A wrong one: the same.
  expect((await widen.kitGithub({ password: "wrong" })).location).toMatch(/Enter your Toolroll password/);
  // The password: each goes past the check (the tool and GitHub answers are this fixture's own).
  expect((await widen.toolGrant({ password })).location).not.toMatch(/Enter your Toolroll password/);
  expect((await widen.kitGithub({ password })).location).not.toMatch(/Enter your Toolroll password/);
  expect((await widen.fullAccess({ password })).status).toBe(303);
  expect(store.permissionDefault().mode).toBe("bypassPermissions");
  // Back to Auto narrows: no password.
  await post(cookie, "/settings/permission-default", { csrf, "permission-mode": "auto" });
  expect(store.permissionDefault().mode).toBe("auto");
  // Passwordless on: the signed-in session is the step-up.
  await post(cookie, "/settings/passwordless", { csrf, action: "on", password });
  await widen.fullAccess();
  expect(store.permissionDefault().mode).toBe("bypassPermissions");
  expect((await widen.kitGithub()).location).not.toMatch(/Enter your Toolroll password/);
});

test("a trigger that brings in items from anyone takes a password on every road; a team-only one doesn't", async () => {
  const flow = store.createFlow({ repo: home, name: "Inbound", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ id: "triage", title: "Triage", kind: "task", instructions: "Look." }], null)) }, T0);
  const cookie = await login();
  const csrf = csrfOf(await page(cookie, "/settings/passwordless"));
  const add = async (trigger: object, extra: Record<string, string> = {}) => {
    const response = await fetch(`${base}/flows/${flow}/triggers`, { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams({ csrf, trigger: JSON.stringify(trigger), ...extra }) });
    return { status: response.status, body: await response.json() as { ok: boolean; said?: string } };
  };
  const github = { kind: "github", repo: "example/shop", watch: "issues", from: "anyone", delivery: "poll" };
  const mail = { kind: "email", folder: "INBOX" };
  for (const trigger of [github, mail]) {
    expect(await add(trigger)).toMatchObject({ status: 403, body: { ok: false, said: "Enter your Toolroll password to bring in items from anyone." } });
    expect(await add(trigger, { password: "wrong" })).toMatchObject({ status: 403 });
  }
  expect(store.flowTriggers(flow)).toHaveLength(0);
  expect(await add({ ...github, from: "team" })).toMatchObject({ body: { ok: true } });
  expect(await add({ ...mail, sender: "priya@example.com" })).toMatchObject({ body: { ok: true } });
  expect(await add(github, { password })).toMatchObject({ body: { ok: true } });
  expect(await add(mail, { password })).toMatchObject({ body: { ok: true } });
  // Every other road (a chat card, an import, a template) adds one only with the person's proof.
  const { addFlowTriggerTo } = await import("./flow-triggers.js");
  expect(addFlowTriggerTo(store, store.getFlow(flow)!, github, "alex", T0, home)).toMatchObject({ ok: false, message: expect.stringContaining("takes your password") });
  expect(addFlowTriggerTo(store, store.getFlow(flow)!, mail, "alex", T0, null, { shown: false })).toMatchObject({ ok: false });
});

test("loosening a subagent's tool rule, or accepting its suggestion to, takes a password; tightening doesn't", async () => {
  const { setUpKit, kitOf, kitInstalled } = await import("./kits.js");
  const kit = kitOf("support-desk")!;
  await setUpKit(store, kit, home, "alex", T0, home);
  const mate = kitInstalled(store, kit, home)!.mate;
  store.saveSubagentGrant({ subagent: mate.id, tool: "shop", actions: [{ name: "refund", readOnly: false, input: null }], rules: { refund: { use: "ask" } } }, "alex", T0);
  const cookie = await login();
  const csrf = csrfOf(await page(cookie, "/settings/passwordless"));
  const rule = (use: string, extra: Record<string, string> = {}) => post(cookie, `/settings/lead/subagents/${mate.id}/tools`, { csrf, tool: "shop", op: "rules", "use.refund": use, ...extra });
  expect((await rule("free")).location).toMatch(/Enter your Toolroll password to let .* do more on its own/);
  expect(store.subagentGrant(mate.id, "shop")?.rules["refund"]).toEqual({ use: "ask" });
  expect((await rule("never")).location).not.toMatch(/password/);
  expect(store.subagentGrant(mate.id, "shop")?.rules["refund"]).toEqual({ use: "never" });
  expect((await rule("free", { password })).location).not.toMatch(/Enter your Toolroll password/);
  expect(store.subagentGrant(mate.id, "shop")?.rules["refund"]).toEqual({ use: "free" });
});
