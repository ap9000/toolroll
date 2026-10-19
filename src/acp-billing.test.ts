/**
 * An ACP agent's billing (docs/plans/acp-adapter.md § Billing): declared per runner and exact model, metered unless
 * declared the agent's own plan, stamped on a run when it is admitted, and settled from that stamp — a later
 * declaration never reclassifies work already admitted.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { openStore, type Store } from "./store.js";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const RUNNER = "mac";
let store: Store;
let n = 0;

beforeEach(() => {
  store = openStore(":memory:");
  register(store, { name: RUNNER, host: "test", capacity: 9, repos: ["/repo"], now: T0, newToken: () => `tok-${RUNNER}` });
});
afterEach(() => store.close());

function admit(model: string, provider = "opencode"): number {
  const id = `t-${++n}`;
  store.createTask({ id, title: id }, T0);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, "/repo");
  const took = acquire(store, ref, RUNNER, { now: T0, token: `tok-${RUNNER}`, newLeaseId: () => `lease-${id}`, ttlMs: 3_600_000 });
  if (!took.ok) throw new Error(took.reason);
  return store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: RUNNER, branch: id, worktree: `/w/${id}`, route: { routeDigest: "legacy", phase: "build", provider, model, chosen: "legacy" }, now: T0 });
}
const spend = (run: number) => store.handle.prepare("SELECT microusd, billing FROM run_spend WHERE run = ?").get(run);

test("with no declaration an ACP run is metered, stamped with its model when it is admitted", () => {
  const run = admit("opencode/big-pickle");
  expect(store.acpBillingOfRun(run)).toEqual({ kind: "metered", revision: 0, model: "opencode/big-pickle" });
  store.settleRunSpend(run, T0);
  expect(spend(run)).toMatchObject({ billing: "api-key" });
});

test("a plan declaration covers exactly its model on its runner, and a run settles from its stamp — never the live declaration", () => {
  const revision = store.declareAcpBilling({ provider: "opencode", runner: RUNNER, model: "opencode/big-pickle", kind: "plan", by: "alex" }, T0);
  const planned = admit("opencode/big-pickle");
  const other = admit("google/gemini-2.5-flash");
  expect(store.acpBillingOfRun(planned)).toEqual({ kind: "plan", revision, model: "opencode/big-pickle" });
  expect(store.acpBillingOfRun(other)).toMatchObject({ kind: "metered", revision: 0 });
  // Declared metered afterwards: the run already admitted keeps the terms it was admitted under.
  store.declareAcpBilling({ provider: "opencode", runner: RUNNER, model: "opencode/big-pickle", kind: "metered", by: "alex" }, T0);
  store.recordUsage(planned, { tokensIn: 1000, tokensOut: 100 });
  store.settleRunSpend(planned, T0);
  expect(spend(planned)).toEqual({ microusd: 0, billing: "subscription" });
  // A run admitted now is metered.
  expect(store.acpBillingOfRun(admit("opencode/big-pickle"))).toMatchObject({ kind: "metered" });
  // Another runner's declaration is its own.
  expect(store.acpBillingFor("opencode", "another", "opencode/big-pickle")).toMatchObject({ kind: "metered", revision: 0 });
});

test("an ordinary provider's run carries no ACP stamp", () => {
  expect(store.acpBillingOfRun(admit("opus", "claude"))).toBeNull();
});
