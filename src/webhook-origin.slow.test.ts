/**
 * v126 (docs/plans/webhook-tasks.md §5): where a task came from, as the console renders it to each viewer. A task in
 * project A filed by a flow in project B: an approver who can open B is told the flow's name; one who can only open A
 * is told "a flow" — on the task page and on /next — and both see the outside event's line, from what was kept.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, propose } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { flowFromSteps } from "./flows.js";

const T0 = new Date("2026-10-19T12:00:00.000Z");
let base: string, store: Store, server: Server | null = null, a: string, b: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "so-origin-")));
  [a, b] = ["shop", "secret-ops"].map(name => { const dir = join(base, name); mkdirSync(dir); execFileSync("git", ["init", "-q", "-b", "main", dir]); return dir; }) as [string, string];
  store = openStore(join(base, "orders.db"));
});
afterEach(async () => {
  if (server !== null) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null; store.close(); rmSync(base, { recursive: true, force: true });
});

test("the flow's name is rendered only for a viewer who can open its project; the outside event's line for both", async () => {
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  const sam = addApprover(store, "sam", T0, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  expect(store.setAccountProjects("sam", [a], "alex", T0)).toEqual({ ok: true });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);

  // A flow in the project sam can't open filed a task in the one he can, from a Sentry issue.
  const flow = store.createFlow({ repo: b, name: "Classified Incident Desk", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }], null)) }, T0);
  store.createTask({ id: "fix-checkout", title: "Fix checkout rounding" }, T0);
  const ref = store.refFor("built-in", "fix-checkout");
  store.handle.prepare("UPDATE task_ref SET repo = ?, filed_via = ? WHERE id = ?").run(a, `flow:${flow}`, ref.id);
  store.recordTaskSource("fix-checkout", { flow, card: 1, entry: 1 },
    JSON.stringify({ label: "Sentry issue", verified: "sentry", external: { id: "1170820242", url: "https://acme.sentry.io/issues/1170820242/" }, receipt: "v3:sentry:id:1170820242" }), T0);
  propose(store, { taskId: "fix-checkout", goal: "Round totals to the cent", outOfScope: null, touches: [], acceptance: [{ id: "c1", statement: "Totals round to the cent.", evidence: ["check"], how: null }], now: T0 });

  server = createDecisionServer({ store, evidenceRoot: join(base, "evidence"), clock: () => T0, repos: [a, b] });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const as = async (name: string, token: string) => {
    const login = await fetch(`${url}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" });
    expect(login.status).toBe(303);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    return async (path: string) => (await fetch(`${url}${path}`, { headers: { cookie } })).text();
  };

  const alexSees = await as("alex", alex.token);
  const samSees = await as("sam", sam.token);
  const alexTask = await alexSees("/t/fix-checkout");
  const samTask = await samSees("/t/fix-checkout");
  expect(alexTask).toContain("Classified Incident Desk");
  expect(samTask).not.toContain("Classified Incident Desk");
  expect(samTask).toContain("from a flow");
  for (const page of [alexTask, samTask]) {
    expect(page).toContain("Sentry issue (signed by Sentry)");
    expect(page).toContain("acme.sentry.io");
  }
  const samNext = await samSees("/next");
  expect(samNext).not.toContain("Classified Incident Desk");
  expect(samNext).toContain("Started by an outside event: Sentry issue (signed by Sentry) · acme.sentry.io.");
});
