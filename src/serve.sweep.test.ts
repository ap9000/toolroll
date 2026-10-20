/** A sweep's table over HTTP (docs/plans/lead-fan-out.md): every child, its state and verdict; cancel-the-rest stops
 * what isn't ready, only for an approver and only with the box ticked; a sweep in a project you can't see is not there. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { fileTaskProposal } from "./proposal.js";
import { T0 } from "../test/serve-kit.js";

let home: string, store: Store, server: Server, base: string, password: string, sweep: number;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "so-sweep-http-")));
  store = openStore(":memory:");
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap failed");
  password = added.token;
  sweep = store.createSweep({ owner: "alex", thread: null, repo: home, title: "Bug sweep", brief: "Reproduce first.", maxParallel: 2, proposal: null }, T0);
  for (const [index, id] of ["router", "cache"].entries()) {
    const made = fileTaskProposal(store, { id, title: id === "router" ? "Router timeout" : "Cache TTL", repo: home, filedVia: "cli", planning: "skip" }, T0);
    if (!made.ok) throw new Error(made.message);
    store.addSweepTask(sweep, id, index, id === "router" ? "Router timeout" : "Cache TTL");
  }
  server = createDecisionServer({ store, evidenceRoot: home, repos: [home], terminalHost: null } as Parameters<typeof createDecisionServer>[0]);
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

const login = async () => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;

test("the table lists every child; cancel-the-rest needs the box and stops what isn't ready", async () => {
  const cookie = await login();
  const page = await (await fetch(`${base}/sweeps/${sweep}`, { headers: { cookie } })).text();
  expect(page).toContain("Router timeout");
  expect(page).toContain("Cache TTL");
  expect(page).toMatch(/of 2 settled/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
  const post = (fields: Record<string, string>) => fetch(`${base}/sweeps/${sweep}/cancel-rest`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
  expect(decodeURIComponent((await post({})).headers.get("location") ?? "")).toMatch(/Tick the box/);
  expect(store.getTask("router")?.state).not.toBe("cancelled");
  expect(decodeURIComponent((await post({ confirm: "yes" })).headers.get("location") ?? "")).toMatch(/Cancelled 2 unfinished items/);
  expect(store.getTask("router")?.state).toBe("cancelled");
  expect(store.getTask("cache")?.state).toBe("cancelled");
});

test("an unknown sweep is not there", async () => {
  const cookie = await login();
  expect((await fetch(`${base}/sweeps/999`, { headers: { cookie } })).status).toBe(404);
});
