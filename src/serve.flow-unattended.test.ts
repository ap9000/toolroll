/**
 * "Runs on its own" over real HTTP: the flow page's view says it, signing takes the owner's password and the flow
 * they read, a wrong password and a stale page are refused, and revoking is one click with no password.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { flowFromSteps } from "./flows.js";
import { T0, workspaceOf } from "../test/serve-kit.js";

const REPO = "/repo/shop";
let store: Store, server: Server, base: string, home: string, token: string, flow: number;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-unattended-")));
  store = openStore(":memory:");
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap failed");
  token = added.token;
  flow = store.createFlow({ repo: REPO, name: "Weekly upkeep", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ id: "update", title: "Update them", kind: "task", instructions: "Update the outdated dependencies." }], null)) }, T0);
  store.addFlowTrigger({ flow, kind: "schedule", configJson: JSON.stringify({ kind: "schedule", schedule: "monday 09:00", title: "Weekly upkeep", description: null, zone: null }), hookHash: null, cursor: null, nextAt: null, by: "alex" }, T0);
  server = createDecisionServer({ store, evidenceRoot: home, clock: () => T0, repos: [REPO] } as Parameters<typeof createDecisionServer>[0]);
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
  const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" });
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
};
const post = async (cookie: string, path: string, fields: Record<string, string>) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams(fields), redirect: "manual" });
  return { status: response.status, body: await response.json() as { ok: boolean; said: string; view?: { unattended: { active: { until: string } | null } } } };
};

test("the owner signs with their password; a wrong password and a stale page change nothing; revoke is one click", async () => {
  const cookie = await login();
  const html = await (await fetch(`${base}/flows/${flow}`, { headers: { cookie } })).text();
  const { csrf } = workspaceOf(html);
  const view = (await (await fetch(`${base}/flows/${flow}?format=json`, { headers: { cookie } })).json()) as { flow: { revision: number }; unattended: Record<string, unknown> & { schedulesDigest: string } };
  expect(view.unattended).toMatchObject({ active: null, canSign: true, scheduled: true, maxDays: 7, schedules: [{ words: "“Weekly upkeep”, monday 09:00", optional: null }] });
  const revision = String(view.flow.revision), schedules = view.unattended.schedulesDigest;

  expect(await post(cookie, `/flows/${flow}/unattended`, { csrf, days: "2", password: "wrong", revision })).toMatchObject({ status: 403, body: { ok: false, said: "That password isn't right. Nothing was signed." } });
  expect(await post(cookie, `/flows/${flow}/unattended`, { csrf, days: "9", password: token, revision })).toMatchObject({ status: 400, body: { ok: false, said: "Choose 1 to 7 days: it always ends." } });
  expect(await post(cookie, `/flows/${flow}/unattended`, { csrf, days: "2", password: token, revision: String(Number(revision) - 1), schedules })).toMatchObject({ status: 409, body: { ok: false, said: "This flow changed while you were reading. Read the terms again." } });
  // Schedules the page didn't show (or no list at all) are never signed for.
  expect(await post(cookie, `/flows/${flow}/unattended`, { csrf, days: "2", password: token, revision, schedules: "0".repeat(32) })).toMatchObject({ status: 409, body: { ok: false, said: "This flow's schedules changed while you were reading. Read the terms again." } });
  expect(await post(cookie, `/flows/${flow}/unattended`, { csrf, days: "2", password: token, revision })).toMatchObject({ status: 409, body: { ok: false } });
  expect(store.handle.prepare("SELECT COUNT(*) AS n FROM flow_unattended_grant").get()!["n"]).toBe(0);

  const signed = await post(cookie, `/flows/${flow}/unattended`, { csrf, days: "2", budget: "3", runs: "4", password: token, revision, schedules });
  expect(signed).toMatchObject({ status: 200, body: { ok: true, said: "Runs on its own until Aug 13, 22:00 UTC.", view: { unattended: { active: { until: "2026-08-13T22:00:00.000Z" } } } } });
  const html2 = await (await fetch(`${base}/flows/${flow}`, { headers: { cookie } })).text();
  expect(html2).toContain("Runs on its own until Aug 13, 22:00 UTC");

  // No password: lowering authority is one click.
  const off = await post(cookie, `/flows/${flow}/unattended-off`, { csrf });
  expect(off).toMatchObject({ status: 200, body: { ok: true, said: "It no longer runs on its own. New cards wait for you.", view: { unattended: { active: null } } } });
  expect(await post(cookie, `/flows/${flow}/unattended-off`, { csrf })).toMatchObject({ status: 409, body: { ok: false } });
});
