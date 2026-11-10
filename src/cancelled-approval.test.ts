/**
 * A cancelled task takes no approval, by any road (Codex review of the steps page, finding 2): the ceremony refuses
 * before any vote or proof is kept, the primitive every automatic road calls refuses too, a page left open while the
 * task was cancelled elsewhere approves nothing, the CLI says why, and a task reopened afterwards carries no seal
 * from its cancelled time. Isolated stores only.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, APPROVAL_PROOF, propose } from "./scope.js";
import { taskCancelled } from "./task-archive.js";
import { createDecisionServer } from "./serve.js";
import { EXIT, runOperate } from "./operate.js";

const T0 = new Date("2026-11-01T10:00:00.000Z");
const LATER = new Date("2026-11-01T10:05:00.000Z");
const REPO = resolve("/repo/main");

const kept = (store: Store, id: string) => ({
  votes: store.handle.prepare("SELECT COUNT(*) AS n FROM scope_approval_vote WHERE task_id = ?").get(id)?.["n"],
  proofs: store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE task_id = ? AND action = ?").get(id, APPROVAL_PROOF)?.["n"],
});

describe("the store's doors", () => {
  let store: Store, token: string;
  beforeEach(() => {
    store = openStore(":memory:");
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    token = added.token;
  });
  afterEach(() => store.close());

  function seed(id: string): string {
    store.createTask({ id, title: `Fix ${id}` }, T0);
    store.placeTask(store.refFor("built-in", id, "ours").id, REPO);
    propose(store, { taskId: id, goal: `fix ${id}`, now: T0 });
    return store.getScope(id)!.digest;
  }

  test("approving refuses, by the ceremony and by the primitive every road calls; no vote, proof or seal is kept", () => {
    const digest = seed("signup");
    expect(taskCancelled(store, "signup")).toBe(false);
    expect(store.cancelTask("signup", T0, "not needed")).toEqual({ ok: true });
    expect(taskCancelled(store, "signup")).toBe(true);
    // The digest is still the one the open page showed: nothing but the cancellation stops this yes.
    expect(store.getScope("signup")!.digest).toBe(digest);
    expect(approve(store, "signup", "alex", LATER, digest, token)).toEqual({ ok: false, reason: "cancelled" });
    for (const kind of ["mode", "chat", "grant", "schedule", "auto-check", "auto-green"] as const) {
      expect(store.sealScopeApproval("signup", "alex", LATER, {}, { kind, modeDigest: "m" }), kind).toBe(false);
    }
    expect(store.getScope("signup")).toMatchObject({ approvedAt: null, approvedBy: null, approvedDigest: null });
    expect(kept(store, "signup")).toEqual({ votes: 0, proofs: 0 });
  });

  test("a wrong password on a cancelled task is still a wrong password: the cancellation is told only to a proved person", () => {
    const digest = seed("probe");
    store.cancelTask("probe", T0);
    const refused = approve(store, "probe", "alex", LATER, digest, "not-the-password");
    expect(refused.ok).toBe(false);
    expect((refused as { reason: string }).reason).not.toBe("cancelled");
  });

  test("reopened afterwards: nothing was sealed while it was cancelled, and a fresh approval is what starts it", () => {
    const digest = seed("reopen");
    store.cancelTask("reopen", T0);
    expect(approve(store, "reopen", "alex", LATER, digest, token)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(store.setTaskState("reopen", "queued", LATER)).toEqual({ ok: true });
    expect(store.getScope("reopen")).toMatchObject({ approvedAt: null, approvedDigest: null });
    expect(approve(store, "reopen", "alex", LATER, store.getScope("reopen")!.digest, token)).toMatchObject({ ok: true });
    expect(store.getScope("reopen")!.approvedBy).toBe("alex");
  });
});

describe("the console and the CLI", () => {
  let dir: string, store: Store, server: Server, base: string, password: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "toolroll-cancelled-approval-"));
    store = openStore(join(dir, "orders.db"));
    const added = addApprover(store, "alex", new Date());
    if (!added.ok) throw new Error("bootstrap failed");
    password = added.token;
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", new Date());
    server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", configDir: dir });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>(done => server.close(() => done()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an approval page left open while the task is cancelled elsewhere: its form, sent whole and unchanged, approves nothing", async () => {
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
    const cookie = login.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/tasks`, { headers: { cookie } })).text())![1]!;
    const post = (path: string, fields: Record<string, string>) =>
      fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf, ...fields }) });
    store.createTask({ id: "t-stale", title: "t-stale" }, new Date());
    expect((await post("/t/t-stale/scope", { acceptance: "c1: ok | manual-review", sawDigest: "", goal: "do t-stale", not: "", touches: "" })).status).toBe(303);
    const page = await (await fetch(`${base}/t/t-stale`, { headers: { cookie } })).text();
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(page)?.[1] ?? "";
    const digest = store.getScope("t-stale")!.digest;
    expect(nonce).not.toBe("");
    // Cancelled in another window; the open page's nonce, digest and password are all still good.
    expect(store.cancelTask("t-stale", new Date(), "changed my mind")).toEqual({ ok: true });
    const answer = await post("/t/t-stale/approve", { nonce, digest, token: password });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(await answer.text()).toContain("not approved: this task was cancelled");
    expect(store.getScope("t-stale")).toMatchObject({ approvedAt: null, approvedBy: null });
    expect(kept(store, "t-stale")).toEqual({ votes: 0, proofs: 0 });
  });

  test("`toolroll task approve` on a cancelled task refuses in plain words and seals nothing", async () => {
    store.createTask({ id: "t-cli", title: "t-cli" }, T0);
    store.placeTask(store.refFor("built-in", "t-cli", "ours").id, REPO);
    propose(store, { taskId: "t-cli", goal: "do t-cli", now: T0 });
    const digest = store.getScope("t-cli")!.digest;
    expect(store.cancelTask("t-cli", T0)).toEqual({ ok: true });
    const lines: string[] = [];
    const code = await runOperate("task", ["approve", "t-cli", "--as", "alex", "--token", password, "--digest", digest, "--yes", "--json"], line => lines.push(line), { databaseFile: join(dir, "orders.db"), now: LATER });
    expect(code).toBe(EXIT.refused);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, reason: "cancelled", message: "t-cli was cancelled, so there is nothing to approve" });
    expect(store.getScope("t-cli")).toMatchObject({ approvedAt: null, approvedBy: null });
    expect(kept(store, "t-cli")).toEqual({ votes: 0, proofs: 0 });
  });
});
