/**
 * v115 (D4): fallback chains and the declared risk level are gone. A seeded v114 database with a chain configuration,
 * a live cycle whose attempt is still open, a cycle waiting to admit its next agent, a task filed (not approved) under
 * a chain, a finished chain-approved task, and a queued task approved at elevated risk opens as v115: the fallback
 * tables are gone, the attempt a chain owned ends as an ordinary interrupted attempt, every unfinished task filed or
 * approved with fallback agents asks again in words (never silently narrowed to its first agent), and history —
 * the finished chain approval, the elevated-risk route — still decodes, verifies and renders with the same bytes.
 * A second open changes nothing. Isolated fixtures only: production databases are never opened here.
 */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, approvalOf, canonicalChainJson, chainFromJson, digestOf, describeScope, propose, type ChainEntry, type Scope } from "./scope.js";
import { canonicalRouteJson, NO_READINESS, projectRoute, routeDigestOf, routeFromJson, type PhaseRoute } from "./phase-routing.js";
import { proveApprovedProfile } from "./builder.js";

let dir: string, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });

/** The v114 fallback tables and indexes, exactly as the fresh schema created them before v115 removed them. */
const V114_FALLBACK_DDL = `
CREATE TABLE fallback_config (
  scope       TEXT NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN ('build')),
  entries_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (scope, phase)
);
CREATE TABLE fallback_cycle (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  chain_digest  TEXT NOT NULL,
  cursor        INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL CHECK (state IN ('open','sanitizing','awaiting-release','pending-admission','incident','closed')),
  transition_generation INTEGER NOT NULL DEFAULT 0,
  tail_run      INTEGER REFERENCES run(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_reason TEXT
);
CREATE TABLE fallback_transition (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle         INTEGER NOT NULL REFERENCES fallback_cycle(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('exhaustion','quota-skip')),
  from_index    INTEGER NOT NULL,
  to_index      INTEGER NOT NULL,
  predecessor_run INTEGER REFERENCES run(id),
  terminal_class  TEXT,
  evidence_provider TEXT,
  evidence_version  TEXT,
  evidence_auth_mode TEXT,
  evidence_fp     TEXT,
  created_at    TEXT NOT NULL,
  consumed_by   INTEGER REFERENCES run(id)
);
CREATE UNIQUE INDEX fallback_transition_step ON fallback_transition (cycle, from_index);
CREATE UNIQUE INDEX one_live_fallback_cycle_per_task ON fallback_cycle (task_ref) WHERE state NOT IN ('closed','incident');`;

const T0 = new Date("2026-10-07T09:00:00.000Z");
const FUTURE = "2026-10-07T21:00:00.000Z";
const REPO = "/repo/pay";
const ACCEPTANCE = [{ id: "c1", statement: "Payouts never double-send", how: null, evidence: ["check" as const] }];
const FALLBACK_NAMES = "('fallback_config','fallback_cycle','fallback_transition','fallback_transition_step','one_live_fallback_cycle_per_task')";
const REASON = "This scope named fallback agents, which Toolroll no longer uses. Save the scope again to choose its agents, then approve it.";

/** The signed terms a scope's digest binds, read back from the row. */
const termsOf = (scope: Scope) => ({ goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, budgetMicrousd: scope.budgetMicrousd, acceptance: scope.acceptance, qualityMode: scope.qualityMode ?? "default", candidate: scope.candidate ?? null });

/** Every kept row the migration may touch, for exact before/after comparison. */
function snapshot(file: string): Record<string, unknown[]> {
  const db = new DatabaseSync(file);
  try {
    const all = (sql: string) => db.prepare(sql).all().map(row => ({ ...row }));
    return {
      task: all("SELECT id, state FROM task ORDER BY id"),
      run: all("SELECT id, task_ref, outcome, reason, chain_cycle, chain_index, entry_digest, auth_mode FROM run ORDER BY id"),
      scope: all("SELECT * FROM task_scope ORDER BY task_id"),
      claim: all("SELECT lease_id, released_at, released_by FROM claim ORDER BY lease_id"),
      worktree: all("SELECT path, task_ref, released_at, verified FROM worktree ORDER BY path"),
      hold: all("SELECT task_ref, owner_kind, owner_id FROM hold ORDER BY task_ref, owner_kind, owner_id"),
      schema: all("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name"),
    };
  } finally {
    db.close();
  }
}

test("v114 → v115: fallback chains go; what a chain owned ends ordinary and recoverable; chain and risk history still verify", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v115-fallback-"));
  const file = join(dir, "state.db");

  // Real scopes this build files and approves, turned into what v114 could have stored.
  const first = openStore(file);
  for (const phase of ["plan", "build", "review"] as const) first.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
  const alex = addApprover(first, "alex", T0);
  if (!alex.ok) throw new Error("approver");
  register(first, { name: "runner-a", host: "test", repos: [REPO], now: T0, newToken: () => "tok-runner-a" });
  const ids = ["t-live", "t-pending", "t-filed", "t-done", "t-risk", "t-plain"] as const;
  const refs: Record<string, number> = {};
  for (const id of ids) {
    first.createTask({ id, title: id }, T0);
    refs[id] = first.refFor("built-in", id).id;
    first.placeTask(refs[id]!, REPO);
    propose(first, { taskId: id, goal: `Harden ${id}`, acceptance: ACCEPTANCE, now: T0 });
    if (id !== "t-filed") expect(approve(first, id, "alex", T0, first.getScope(id)!.digest, alex.token).ok).toBe(true);
  }
  const raw = first.raw();
  /** A chain filing (and, when approved, its seal) exactly as v30–v114 wrote one: the digest binds the whole chain. */
  const chainOf = (id: string, approved: boolean): ChainEntry[] => {
    const scope = first.getScope(id)!;
    const route = routeFromJson(scope.proposedRouteJson ?? null)!;
    const chain: ChainEntry[] = [{ profile: scope.profile!, authMode: "subscription" }, { profile: { ...scope.profile!, model: "opus" }, authMode: "api-key" }];
    const digest = digestOf(termsOf(scope), { chain }, route);
    const json = canonicalChainJson(chain);
    raw.prepare("UPDATE task_scope SET digest = ?, proposed_chain_json = ? WHERE task_id = ?").run(digest, json, id);
    if (approved) raw.prepare("UPDATE task_scope SET approved_digest = ?, approved_chain_json = ?, approval_kind = 'chain' WHERE task_id = ?").run(digest, json, id);
    return chain;
  };
  for (const id of ["t-live", "t-pending", "t-done"]) chainOf(id, true);
  chainOf("t-filed", false);
  // t-risk: approved at elevated risk under v47–v114 — the route says so, and the digest binds it.
  const plain = first.getScope("t-risk")!;
  const elevated: PhaseRoute = { ...routeFromJson(plain.proposedRouteJson ?? null)!, risk: "elevated" };
  const riskDigest = digestOf(termsOf(plain), plain.profile!, elevated);
  raw.prepare("UPDATE task_scope SET risk_level = 'elevated', proposed_route_json = ?, approved_route_json = ?, digest = ?, approved_digest = ? WHERE task_id = 't-risk'")
    .run(canonicalRouteJson(elevated), canonicalRouteJson(elevated), riskDigest, riskDigest);
  raw.prepare("UPDATE task_ref SET risk_level = 'elevated' WHERE id = ?").run(refs["t-risk"]!);
  first.close();

  // The v114 shape: the three tables, their indexes, run.chain_cycle's reference, and v114.
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(V114_FALLBACK_DDL);
  const version = Number(db.prepare("PRAGMA schema_version").get()?.["schema_version"]);
  (db as unknown as { enableDefensive?: (on: boolean) => void }).enableDefensive?.(false); // Node 24 opens defensive
  db.exec("PRAGMA writable_schema = ON");
  const runSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run'").get()?.["sql"]);
  const referenced = runSql.replace("chain_cycle INTEGER,", "chain_cycle INTEGER REFERENCES fallback_cycle(id),");
  expect(referenced).not.toBe(runSql);
  db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'run'").run(referenced);
  db.exec(`PRAGMA schema_version = ${version + 1}`);
  db.exec("PRAGMA writable_schema = OFF");
  db.prepare("UPDATE schema_version SET version = 114").run();
  db.prepare("INSERT INTO fallback_config (scope, phase, entries_json, updated_at, updated_by) VALUES (?, 'build', ?, ?, 'alex')")
    .run(REPO, JSON.stringify([{ provider: "claude", model: "opus", authMode: "api-key" }]), T0.toISOString());
  const at = T0.toISOString();
  const run = (taskRef: number, lease: string, outcome: string | null, chain: { cycle: number; index: number } | null) =>
    Number(db.prepare("INSERT INTO run (task_ref, lease_id, runner, branch, worktree, model, provider, outcome, chain_cycle, chain_index, entry_digest, auth_mode, started_at) VALUES (?, ?, 'runner-a', 'so/x', ?, 'sonnet', 'claude', ?, ?, ?, ?, ?, ?)")
      .run(taskRef, lease, `/tmp/wt-${lease}`, outcome, chain?.cycle ?? null, chain?.index ?? null, chain === null ? null : `entry-${chain.index}`, chain === null ? null : "subscription", at).lastInsertRowid);
  const cycle = (taskRef: number, state: string, cursor: number) =>
    Number(db.prepare("INSERT INTO fallback_cycle (task_ref, chain_digest, cursor, state, transition_generation, created_at, updated_at) VALUES (?, 'chain-digest', ?, ?, 0, ?, ?)")
      .run(taskRef, cursor, state, at, at).lastInsertRowid);
  const claim = (lease: string, taskRef: number, released: boolean) =>
    db.prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at, released_at, released_by) VALUES (?, ?, 1, 'runner-a', ?, ?, ?, ?, ?)")
      .run(lease, taskRef, at, FUTURE, at, released ? at : null, released ? "completed" : null);
  const checkout = (lease: string, taskRef: number) =>
    db.prepare("INSERT INTO worktree (path, repo, branch, runner, task_ref, created_at, leased_at, verified) VALUES (?, ?, 'so/x', 'runner-a', ?, ?, ?, 1)")
      .run(`/tmp/wt-${lease}`, REPO, taskRef, at, at);
  db.prepare("UPDATE task SET state = 'running' WHERE id IN ('t-live', 't-plain')").run();
  db.prepare("UPDATE task SET state = 'done' WHERE id = 't-done'").run();

  // t-live: a live cycle whose base attempt is still open under its claim and checkout.
  const liveCycle = cycle(refs["t-live"]!, "open", 0);
  claim("lease-live", refs["t-live"]!, false);
  checkout("lease-live", refs["t-live"]!);
  const liveRun = run(refs["t-live"]!, "lease-live", null, { cycle: liveCycle, index: 0 });
  db.prepare("UPDATE fallback_cycle SET tail_run = ? WHERE id = ?").run(liveRun, liveCycle);
  // t-pending: the base exhausted its plan, the cycle waits to admit the next agent; the task sits queued.
  const pendingCycle = cycle(refs["t-pending"]!, "pending-admission", 1);
  claim("lease-pending", refs["t-pending"]!, true);
  const exhausted = run(refs["t-pending"]!, "lease-pending", "failed", { cycle: pendingCycle, index: 0 });
  db.prepare("UPDATE run SET terminal_class = 'usage-exhausted', reason = 'agent' WHERE id = ?").run(exhausted);
  db.prepare("INSERT INTO fallback_transition (cycle, kind, from_index, to_index, predecessor_run, terminal_class, created_at) VALUES (?, 'exhaustion', 0, 1, ?, 'usage-exhausted', ?)").run(pendingCycle, exhausted, at);
  // t-done: a finished chain-approved task whose fallback entry built — history only.
  const doneCycle = cycle(refs["t-done"]!, "closed", 1);
  claim("lease-done", refs["t-done"]!, true);
  const doneRun = run(refs["t-done"]!, "lease-done", "built", { cycle: doneCycle, index: 1 });
  // t-plain: an ordinary attempt mid-build under its own live claim — untouched.
  claim("lease-plain", refs["t-plain"]!, false);
  checkout("lease-plain", refs["t-plain"]!);
  const plainRun = run(refs["t-plain"]!, "lease-plain", null, null);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
  const before = snapshot(file);

  store = openStore(file);
  const handle = store.handle;
  expect(SCHEMA_VERSION).toBe(119);
  expect(handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(119);
  // The tables and their indexes are gone; the run's history columns stay, without their foreign key.
  expect(handle.prepare(`SELECT name FROM sqlite_master WHERE name IN ${FALLBACK_NAMES}`).all()).toEqual([]);
  const runDdl = String(handle.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run'").get()?.["sql"]);
  expect(runDdl).toMatch(/chain_cycle INTEGER, chain_index INTEGER, entry_digest TEXT/);
  expect(runDdl).not.toMatch(/REFERENCES fallback_/);
  expect(handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(handle.prepare("PRAGMA integrity_check").all().map(row => row["integrity_check"])).toEqual(["ok"]);
  store.close(); store = undefined;

  const after = snapshot(file);
  // Every run keeps its row and its chain columns; only the attempt the live cycle owned ends, as interrupted.
  expect(after.run).toEqual([
    { id: liveRun, task_ref: refs["t-live"], outcome: "failed", reason: "interrupted", chain_cycle: liveCycle, chain_index: 0, entry_digest: "entry-0", auth_mode: "subscription" },
    { id: exhausted, task_ref: refs["t-pending"], outcome: "failed", reason: "agent", chain_cycle: pendingCycle, chain_index: 0, entry_digest: "entry-0", auth_mode: "subscription" },
    { id: doneRun, task_ref: refs["t-done"], outcome: "built", reason: null, chain_cycle: doneCycle, chain_index: 1, entry_digest: "entry-1", auth_mode: "subscription" },
    { id: plainRun, task_ref: refs["t-plain"], outcome: null, reason: null, chain_cycle: null, chain_index: null, entry_digest: null, auth_mode: null },
  ]);
  // Its claim is handed back and its checkout released unverified (the work stays on disk); others are untouched.
  expect(after.claim).toEqual([
    { lease_id: "lease-done", released_at: at, released_by: "completed" },
    { lease_id: "lease-live", released_at: expect.any(String), released_by: "interrupted" },
    { lease_id: "lease-pending", released_at: at, released_by: "completed" },
    { lease_id: "lease-plain", released_at: null, released_by: null },
  ]);
  expect(after.worktree).toEqual([
    { path: "/tmp/wt-lease-live", task_ref: refs["t-live"], released_at: expect.any(String), verified: 0 },
    { path: "/tmp/wt-lease-plain", task_ref: refs["t-plain"], released_at: null, verified: 1 },
  ]);
  expect(after.hold).toEqual(before.hold);
  // The live task returns to the queue; the rest keep their states.
  expect(after.task).toEqual([
    { id: "t-done", state: "done" },
    { id: "t-filed", state: "queued" },
    { id: "t-live", state: "queued" },
    { id: "t-pending", state: "queued" },
    { id: "t-plain", state: "running" },
    { id: "t-risk", state: "queued" },
  ]);
  // Finished history and ordinary scopes are byte-for-byte as v114 left them.
  const row = (rows: unknown[], id: string) => (rows as Record<string, unknown>[]).find(one => one["task_id"] === id);
  for (const id of ["t-done", "t-risk", "t-plain"]) expect(row(after.scope, id), id).toEqual(row(before.scope, id));

  store = openStore(file);
  // Unfinished chain work asks again: the chain approval is withdrawn (never narrowed to its first agent), the filing
  // says why in words, and nothing dispatches on it.
  for (const id of ["t-live", "t-pending", "t-filed"]) {
    const scope = store.getScope(id)!;
    expect(scope, id).toMatchObject({ proposedChainJson: null, approvedChainJson: null, approvalKind: "profile", approvedAt: null, approvedDigest: null, profileState: "unresolved", unresolvedReason: REASON });
    expect(approvalOf(scope).approved, id).toBe(false);
    expect(store.routeAuthorityFor(refs[id]!, "builder"), id).toMatchObject({ ok: false });
  }
  // The way out is one save: the scope files again under today's single agent and can be approved.
  const resaved = propose(store, { taskId: "t-pending", goal: "Harden t-pending", acceptance: ACCEPTANCE, now: T0 });
  expect(resaved).toMatchObject({ profileState: "resolved", proposedChainJson: null });
  expect(approve(store, "t-pending", "alex", T0, resaved.digest, alex.token).ok).toBe(true);
  expect(store.getScope("t-pending")).toMatchObject({ approvalKind: "profile", approvedChainJson: null });
  expect(store.sealedRouteOf("t-pending").ok).toBe(true);

  // History: the finished chain approval still decodes and its sealed route still verifies.
  const done = store.getScope("t-done")!;
  expect(done.approvalKind).toBe("chain");
  expect(chainFromJson(done.approvedChainJson ?? null)).toHaveLength(2);
  expect(store.sealedRouteOf("t-done")).toMatchObject({ ok: true });
  expect(describeScope(done).join("\n")).toContain("approved     yes, by alex");
  // History: the route approved at elevated risk keeps its bytes and digest, renders its risk, and still dispatches.
  const risky = store.getScope("t-risk")!;
  expect(risky.riskLevel).toBe("elevated");
  const sealed = store.sealedRouteOf("t-risk");
  expect(sealed).toMatchObject({ ok: true });
  if (!sealed.ok) return;
  expect(sealed.route.risk).toBe("elevated");
  expect(routeDigestOf(sealed.route)).toBe(routeDigestOf(elevated));
  expect(projectRoute(sealed.route, NO_READINESS).riskTitle).toBe("Elevated risk");
  expect(proveApprovedProfile(risky, { provider: "claude", model: "sonnet", maxTurns: undefined, timeoutMs: undefined, skipPermissions: false })).toMatchObject({ ok: true });
  store.close(); store = undefined;

  // A second open changes nothing.
  const settled = snapshot(file);
  store = openStore(file);
  store.close(); store = undefined;
  expect(snapshot(file)).toEqual(settled);
});

test("a fresh v115 database never creates the fallback tables, and new filings name no chain and no declared risk", () => {
  dir = mkdtempSync(join(tmpdir(), "so-v115-fallback-fresh-"));
  store = openStore(join(dir, "state.db"));
  expect(store.handle.prepare(`SELECT name FROM sqlite_master WHERE name IN ${FALLBACK_NAMES}`).all()).toEqual([]);
  expect(String(store.handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'run'").get()?.["sql"])).not.toMatch(/REFERENCES fallback_/);
  for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("approver");
  store.createTask({ id: "t", title: "t" }, T0);
  store.placeTask(store.refFor("built-in", "t").id, REPO);
  const filed = propose(store, { taskId: "t", goal: "Harden it", acceptance: ACCEPTANCE, now: T0 });
  expect(filed).toMatchObject({ proposedChainJson: null, riskLevel: "routine" });
  expect(routeFromJson(filed.proposedRouteJson ?? null)?.risk).toBe("routine");
  expect(approve(store, "t", "alex", T0, filed.digest, alex.token).ok).toBe(true);
  expect(store.getScope("t")).toMatchObject({ approvalKind: "profile", approvedChainJson: null });
});
