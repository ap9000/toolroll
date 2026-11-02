/**
 * Tidy's CI evidence from a signed GitHub webhook (docs/plans/task-tidy.md): a completed push run on the watched branch
 * is recorded only inside the delivery's own transaction, which re-proves the trigger is still active with the same
 * config, credential and address. A trigger paused, re-keyed or re-pointed between admission and the write records
 * nothing, so tidy puts nothing away on it. Isolated temp folders only.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { flowFromSteps } from "./flows.js";
import { addFlowTriggerTo, receiveFlowHook } from "./flow-triggers.js";
import { tidyPreview } from "./tidy.js";
import { fire } from "../test/tidy-fixture.js";

const T0 = new Date("2026-11-01T12:00:00.000Z");
const FAILED = "1".repeat(40), FIXED = "2".repeat(40);
let dir: string, store: Store, flow: number;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-hook-checks-")));
  store = openStore(join(dir, "orders.db"));
  flow = store.createFlow({ repo: "/test/shop", name: "Fix failing CI", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
});
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(dir, { recursive: true, force: true }); });

function checksHook() {
  const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "github", repo: "acme/shop", watch: "checks", branch: "main", delivery: "webhook", from: "team" }, "alex", T0, dir, { ingress: "proved" });
  if (!made.ok) throw new Error(made.message);
  return { id: made.id, token: made.reveal!.path.slice("/hooks/flow/".length), secret: made.reveal!.secret! };
}
const deliver = (hook: { token: string; secret: string }) => {
  const body = JSON.stringify({ action: "completed", repository: { full_name: "acme/shop" }, workflow_run: {
    id: 77, name: "CI", head_sha: FIXED, head_branch: "main", conclusion: "success", created_at: "2026-11-01T11:00:00.000Z", event: "push", head_repository: { full_name: "acme/shop" } } });
  return receiveFlowHook(store, hook.token, { headers: { "x-github-event": ["workflow_run"], "x-hub-signature-256": [`sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}`] }, body: Buffer.from(body) }, dir, T0);
};
const recorded = () => store.handle.prepare("SELECT COUNT(*) n FROM branch_check_run").get()?.["n"];
/** An older CI failure notice from this very trigger, which the green run would resolve. */
const notice = (trigger: number) => fire(store, { flow, trigger }, { key: `checks:${FAILED}`, task: "checks-failed-on-main-ci", title: "Checks failed on main: CI",
  at: new Date("2026-10-30T10:00:00.000Z"), onTime: false, filedBy: { name: "GitHub", kind: "automation" }, repo: "/test/shop" });

test("a signed green push run on the watched branch is recorded, and resolves the older notice", () => {
  const hook = checksHook();
  notice(hook.id);
  expect(deliver(hook).status).toBeLessThan(300);
  expect(recorded()).toBe(1);
  expect(tidyPreview(store, T0, { releases: { facts: [], problem: null }, days: null }).map(one => one.taskId)).toEqual(["checks-failed-on-main-ci"]);
});

test.each([
  ["paused", { state: "paused" }],
  ["re-keyed", { hookHash: "another-address" }],
  ["re-pointed", { configJson: JSON.stringify({ kind: "github", repo: "acme/other", watch: "checks", branch: "main", delivery: "webhook", from: "team" }) }],
  ["given a new signing credential", { hookCredential: "rotated" }],
])("a trigger %s between admission and the write records nothing, and nothing is put away", (_name, changed) => {
  const hook = checksHook();
  notice(hook.id);
  const real = store.getFlowTrigger.bind(store);
  vi.spyOn(store, "getFlowTrigger").mockImplementation(id => { const row = real(id); return row === null ? null : { ...row, ...changed } as typeof row; });
  expect(deliver(hook).status).toBe(409);
  expect(recorded()).toBe(0);
  expect(tidyPreview(store, T0, { releases: { facts: [], problem: null }, days: null })).toEqual([]);
});
