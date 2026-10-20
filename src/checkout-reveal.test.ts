/**
 * A running attempt's files, on this computer (docs/plans/agents-cockpit.md phase E): the agent view offers the cd
 * command and Show in Finder only for a checkout proved local (live, this machine's runner, inside its pool); Show in
 * Finder proves it again and asks Finder to reveal exactly that path; a stale path, a viewer and a bearer are refused;
 * nothing is ever launched in it.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { attemptKeyOf, recordAgentTurn } from "./agent-board.js";
import type { BrowserAgentsView } from "./browser-workspace.js";
import { cdCommandOf } from "./checkout-proof.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { openStore, type Store } from "./store.js";
import { presented, T0, workspaceOf } from "../test/serve-kit.js";

let store: Store, server: Server, base: string, dir: string, pool: string, repo: string, token: string;
const revealed: string[] = [];
beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-reveal-")));
  pool = join(dir, "pool"); repo = join(dir, "shop"); mkdirSync(pool); mkdirSync(repo);
  store = openStore(":memory:");
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  token = alex.token;
  register(store, { name: "builder-1", host: "here", capacity: 4, repos: [repo], now: new Date(), newToken: () => "tok-builder-1" });
  revealed.length = 0;
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo], clock: () => new Date(), localRunner: "builder-1", poolRoot: pool,
    revealPath: path => { revealed.push(path); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const login = async () => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
/** A running build whose checkout is a real directory in this machine's pool. */
function running(id: string, worktree = join(pool, `wt-${id}`)): number {
  mkdirSync(worktree, { recursive: true });
  store.createTask({ id, title: `Fix ${id}` }, T0);
  const ref = store.refFor("built-in", id, "ours").id;
  store.placeTask(ref, repo);
  const taken = acquire(store, ref, "builder-1", { token: "tok-builder-1", now: new Date(), ttlMs: 3_600_000 });
  if (!taken.ok) throw new Error("claim");
  const run = store.startRun({ taskRef: ref, leaseId: taken.claim.leaseId, runner: "builder-1", branch: `b-${id}`, worktree, now: new Date(), ...presented(store, ref, "builder") });
  store.saveWorktree({ path: worktree, repo, branch: `b-${id}`, runner: "builder-1", taskRef: ref, createdAt: new Date().toISOString(), leasedAt: new Date().toISOString(), releasedAt: null, verified: true, leaseEpoch: 1 } as never);
  recordAgentTurn(store, { run, attemptKey: attemptKeyOf(store, run)!, state: "busy", at: new Date() });
  return run;
}

test("the cd command is one single-quoted word, whatever the path holds", () => {
  expect(cdCommandOf("/pool/wt one")).toBe("cd '/pool/wt one'");
  expect(cdCommandOf("/pool/it's here")).toBe(`cd '/pool/it'\\''s here'`);
});

test("a local running checkout is offered and revealed exactly; a finished one is refused; a bearer can't", async () => {
  const cookie = await login();
  const run = running("t-files");
  const view = workspaceOf(await (await fetch(`${base}/agents?run=${run}`, { headers: { cookie } })).text()).view as BrowserAgentsView;
  expect(view.selected?.checkout).toEqual({ path: join(pool, "wt-t-files"), cd: `cd '${join(pool, "wt-t-files")}'`, reveal: `/r/${run}/reveal` });
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/settings`, { headers: { cookie } })).text())![1]!;
  const reveal = (headers: Record<string, string>) => fetch(`${base}/r/${run}/reveal`, { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ csrf, return: "agents" }).toString() });
  expect((await reveal({ cookie })).headers.get("location")).toBe(`/agents?run=${run}&said=revealed`);
  expect(revealed).toEqual([join(pool, "wt-t-files")]);
  // A bearer token never reaches it (a person's act in their own browser).
  expect((await reveal({ authorization: "Bearer so_not-a-real-token" })).status).not.toBe(303);
  // Once the attempt ends, nothing is offered and Finder is not asked.
  store.finishRun(run, { outcome: "built", committed: true, now: new Date() });
  expect((await reveal({ cookie })).headers.get("location")).toBe(`/agents?run=${run}&said=reveal-refused`);
  expect(revealed).toHaveLength(1);
  const after = workspaceOf(await (await fetch(`${base}/agents?run=${run}`, { headers: { cookie } })).text()).view as BrowserAgentsView;
  expect(after.selected?.checkout ?? null).toBeNull();
});

test("a checkout outside this machine's pool is never offered or revealed", async () => {
  const cookie = await login();
  const outside = join(dir, "elsewhere");
  const run = running("t-outside", outside);
  const view = workspaceOf(await (await fetch(`${base}/agents?run=${run}`, { headers: { cookie } })).text()).view as BrowserAgentsView;
  expect(view.selected?.checkout ?? null).toBeNull();
});
