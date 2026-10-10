/**
 * v115 (D2): every routine becomes an equivalent scheduled flow. Seeded v114 routines — approved and on, approved and
 * paused, never approved, and edited after approval — arrive as a Build → Done flow with a schedule trigger carrying the
 * routine's exact terms, limits, creator, next time and (only when it was stamped) its approval; firing them files the
 * same approved scope a routine did, or an ordinary proposal; one at a time and the 7-day ceiling still count the
 * routine's earlier tasks; a second open changes nothing; a migration that dies part-way leaves v114 whole and the next
 * open finishes it. Isolated fixtures only: production databases are never opened here.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type FlowTriggerRow, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { fileTaskProposal } from "./proposal.js";
import { routeDigestOf, routeFromJson } from "./phase-routing.js";
import { parseAcceptanceCriteria, profileFromJson } from "./scope.js";
import { readTriggerConfig, runFlowTriggers, setFlowTriggerOn, type TriggerIo } from "./flow-triggers.js";
import { standingDigestOf, type StandingOrder } from "./flow-schedule.js";
import { flowDefinitionOf } from "./flow-engine.js";

/** The v114 routine tables, exactly as v114 left them (the fresh DDL plus the columns later migrations added). */
const V114_ROUTINE_DDL = `
CREATE TABLE routine (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  repo             TEXT NOT NULL,
  goal             TEXT NOT NULL,
  out_of_scope     TEXT,
  touches          TEXT NOT NULL DEFAULT '[]',
  requirements     TEXT NOT NULL DEFAULT '[]',
  schedule         TEXT NOT NULL,
  single_flight    INTEGER NOT NULL DEFAULT 1,
  cost_ceiling_usd REAL,
  budget_per_run_microusd INTEGER,
  paused           INTEGER NOT NULL DEFAULT 0,
  digest           TEXT NOT NULL,
  approved_at      TEXT,
  approved_by      TEXT,
  approved_digest  TEXT,
  profile_json          TEXT,
  approved_profile_json TEXT,
  digest_version        INTEGER NOT NULL DEFAULT 1,
  profile_provenance    TEXT,
  route_json            TEXT,
  approved_route_json   TEXT,
  next_fire_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  filed_via        TEXT,
  acceptance_json  TEXT,
  created_by       TEXT
);
CREATE TABLE routine_fire (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id        INTEGER NOT NULL REFERENCES routine(id) ON DELETE CASCADE,
  scheduled_for     TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('fired','skipped')),
  reason            TEXT,
  instance_task_ref INTEGER REFERENCES task_ref(id),
  created_at        TEXT NOT NULL,
  UNIQUE (routine_id, scheduled_for)
);
CREATE INDEX routine_fire_recent ON routine_fire (routine_id, id DESC);
`;

const T0 = new Date("2026-10-07T20:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ACCEPTANCE = [{ id: "c1", statement: "The refreshed lockfile still installs cleanly.", how: null, evidence: ["check"] }];
const io: TriggerIo = { gh: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false }), fetch, dir: null };

let dir: string, repo: string, file: string, store: Store | undefined;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-v115-routines-")));
  repo = join(dir, "site");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "Site\n");
  file = join(dir, "orders.db");
});
afterEach(() => { store?.close(); store = undefined; rmSync(dir, { recursive: true, force: true }); });

type Seed = { name: string; schedule: string; paused?: boolean; approval: "stamped" | "none" | "edited"; nextFireAt: string | null; ceiling?: number | null; budget?: number | null; touches?: string[]; requirements?: string[]; outOfScope?: string | null };

/** A v114 database with routines, their frozen agents taken from a scope this build filed (so they are real ones). */
function seedV114(seeds: readonly Seed[]): { profileJson: string; routeJson: string } {
  const first = openStore(file);
  const alex = addApprover(first, "alex", T0);
  if (!alex.ok || !addApprover(first, "sam", T0, { name: "alex", token: alex.token }).ok) throw new Error("approver");
  for (const phase of ["plan", "build", "review"] as const) first.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
  const probe = fileTaskProposal(first, { id: "probe", title: "Probe", repo, goal: "Probe the agents", acceptance: ACCEPTANCE, filedVia: "cli", planning: "skip" }, T0);
  if (!probe.ok) throw new Error(probe.message);
  const scope = first.getScope("probe")!;
  const profileJson = scope.profileJson!, routeJson = scope.proposedRouteJson!;
  const profile = profileFromJson(profileJson)!, route = routeFromJson(routeJson)!;
  // An earlier instance of the first routine: finished, with one paid run in the window.
  first.createTask({ id: "nightly-deps-20261006-2000", title: "nightly-deps · 2026-10-06 20:00 UTC" }, T0);
  first.close();

  const db = new DatabaseSync(file);
  db.exec(V114_ROUTINE_DDL);
  const insert = db.prepare(`INSERT INTO routine (name, repo, goal, out_of_scope, touches, requirements, schedule, single_flight, cost_ceiling_usd, budget_per_run_microusd, paused,
    digest, approved_at, approved_by, approved_digest, profile_json, approved_profile_json, digest_version, route_json, approved_route_json, next_fire_at, created_at, updated_at, filed_via, acceptance_json, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, 'cli', ?, 'alex')`);
  for (const seed of seeds) {
    const order = orderOf(seed);
    const digest = standingDigestOf(repo, seed.schedule, order, parseAcceptanceCriteria(ACCEPTANCE).criteria, profile, route);
    const approved = seed.approval !== "none";
    insert.run(seed.name, repo, order.goal, order.outOfScope, JSON.stringify(order.touches), JSON.stringify(order.requirements), seed.schedule, order.costCeilingUsd, order.budgetPerRunMicrousd, seed.paused ? 1 : 0,
      seed.approval === "edited" ? "f".repeat(32) : digest, approved ? at(-120).toISOString() : null, approved ? "sam" : null, approved ? digest : null,
      profileJson, approved ? profileJson : null, routeJson, approved ? routeJson : null, seed.nextFireAt, at(-240).toISOString(), at(-120).toISOString(), JSON.stringify(ACCEPTANCE));
  }
  const instance = Number(db.prepare("SELECT id FROM task_ref WHERE external_id = 'nightly-deps-20261006-2000'").get()?.["id"]);
  db.prepare("UPDATE task_ref SET routine_id = 1, repo = ? WHERE id = ?").run(repo, instance);
  db.prepare("UPDATE task SET state = 'done' WHERE id = 'nightly-deps-20261006-2000'").run();
  db.prepare("INSERT INTO routine_fire (routine_id, scheduled_for, outcome, reason, instance_task_ref, created_at) VALUES (1, ?, 'fired', NULL, ?, ?)").run(at(-1440).toISOString(), instance, at(-1440).toISOString());
  db.prepare("UPDATE schema_version SET version = 114").run();
  db.close();
  return { profileJson, routeJson };
}

function orderOf(seed: Seed): StandingOrder {
  return {
    stem: seed.name, goal: `Keep ${seed.name} healthy and note anything that needs a person`, outOfScope: seed.outOfScope === undefined ? "No major version bumps" : seed.outOfScope,
    touches: seed.touches ?? ["package.json"], requirements: seed.requirements ?? [], acceptance: ACCEPTANCE, budgetPerRunMicrousd: seed.budget === undefined ? 2_000_000 : seed.budget,
    costCeilingUsd: seed.ceiling === undefined ? 10 : seed.ceiling, singleFlight: true, filedBy: "alex", routine: null, approval: null,
  };
}

const SEEDS: Seed[] = [
  { name: "nightly-deps", schedule: "every:60", approval: "stamped", nextFireAt: at(30).toISOString() },
  { name: "docs-drift", schedule: "weekly:1:09:00@Europe/London", approval: "stamped", paused: true, nextFireAt: at(600).toISOString(), ceiling: null, budget: null, touches: [], outOfScope: null },
  { name: "weekly-audit", schedule: "daily:07:30", approval: "none", nextFireAt: null, requirements: ["tool:node"] },
  { name: "edited-after", schedule: "every:120", approval: "edited", nextFireAt: at(60).toISOString() },
];

const triggerOf = (s: Store, name: string): FlowTriggerRow => {
  const flow = s.handle.prepare("SELECT id FROM flow WHERE name = ?").get(name);
  return s.flowTriggers(Number(flow?.["id"]))[0]!;
};
const shape = () => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return JSON.stringify([db.prepare("SELECT * FROM flow ORDER BY id").all(), db.prepare("SELECT * FROM flow_trigger ORDER BY id").all(), db.prepare("SELECT version FROM schema_version").all()]); } finally { db.close(); }
};

test("every routine arrives as an equivalent scheduled flow, its approval moved only as it was stamped", () => {
  const { profileJson, routeJson } = seedV114(SEEDS);
  store = openStore(file);
  expect(SCHEMA_VERSION).toBe(119);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(119);
  expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'routine%'").all()).toEqual([]);
  // The history column stays (its foreign key is gone), so the earlier instance still names its routine.
  expect(store.handle.prepare("SELECT routine_id FROM task_ref WHERE external_id = 'nightly-deps-20261006-2000'").get()?.["routine_id"]).toBe(1);
  expect(store.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.handle.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");

  for (const [index, seed] of SEEDS.entries()) {
    const flowRow = store.handle.prepare("SELECT * FROM flow WHERE name = ?").get(seed.name)!;
    expect(flowRow).toMatchObject({ repo, state: "active", created_by: "alex", owner: "alex" });
    const definition = flowDefinitionOf(store.getFlow(Number(flowRow["id"]))!)!;
    expect(definition.stages.map(one => [one.id, one.kind, one.next])).toEqual([["build", "task", "done"], ["done", "done", null]]);
    expect(definition.stages[0]).toMatchObject({ instructions: orderOf(seed).goal, planning: "skip" });

    const trigger = triggerOf(store, seed.name);
    const config = readTriggerConfig(JSON.parse(trigger.configJson));
    if (!config.ok || config.value.kind !== "schedule") throw new Error("the trigger's config doesn't read");
    const carried = seed.approval === "stamped" ? { digest: expect.any(String), by: "sam", at: at(-120).toISOString(), profileJson, routeJson } : null;
    expect(config.value).toEqual({ kind: "schedule", schedule: seed.schedule, title: seed.name, description: null, zone: "build", order: { ...orderOf(seed), routine: index + 1, approval: carried } });
    // On only when it was approved and not paused; its next time as it was.
    expect(trigger.state).toBe(seed.approval === "stamped" && !seed.paused ? "active" : "paused");
    expect(trigger.nextAt).toBe(seed.nextFireAt);
  }
  expect(triggerOf(store, "nightly-deps")).toMatchObject({ lastAt: at(-1440).toISOString(), lastOutcome: "Filed a task (as a routine)." });

  // A second open changes nothing.
  store.close();
  const before = shape();
  store = openStore(file);
  store.close(); store = undefined;
  expect(shape()).toBe(before);
});

test("firing: the approved order files the routine's approved scope on its frozen agents; the unapproved one files a proposal; one at a time and the ceiling count the routine's earlier tasks", async () => {
  const { routeJson } = seedV114(SEEDS);
  store = openStore(file);
  const instance = store.lookupRef("nightly-deps-20261006-2000")!;

  // One at a time: the routine's earlier task, unfinished, keeps the slot from firing (and says so).
  store.handle.prepare("UPDATE task SET state = 'queued' WHERE id = 'nightly-deps-20261006-2000'").run();
  expect(await runFlowTriggers(store, repo, at(31), io)).toMatchObject({ added: 0, problems: [] });
  expect(triggerOf(store, "nightly-deps").lastOutcome).toBe("Skipped: the last one (nightly-deps-20261006-2000, queued) hasn't finished.");

  // The ceiling: its earlier task spent more than $10 in the last 7 days.
  store.handle.prepare("UPDATE task SET state = 'done' WHERE id = 'nightly-deps-20261006-2000'").run();
  const spent = Number(store.handle.prepare(`INSERT INTO run (task_ref, lease_id, runner, role, provider, model, branch, worktree, started_at, provider_started_at, finished_at, outcome, reason, cost_usd)
    VALUES (?, 'old', 'r', 'builder', 'claude', 'sonnet', 'b', ?, ?, ?, ?, 'built', 'built', 12)`).run(instance.id, repo, at(-600).toISOString(), at(-600).toISOString(), at(-590).toISOString()).lastInsertRowid);
  expect(await runFlowTriggers(store, repo, at(91), io)).toMatchObject({ added: 0 });
  expect(triggerOf(store, "nightly-deps").lastOutcome).toBe("Skipped: $12.00 of the $10.00 weekly limit is spent.");

  // Under the ceiling, the next slot files the routine's own scope, approved by the routine's approver, on the agents it froze.
  store.handle.prepare("UPDATE run SET cost_usd = 1 WHERE id = ?").run(spent);
  expect(await runFlowTriggers(store, repo, at(151), io)).toMatchObject({ added: 1, problems: [] });
  const firing = triggerOf(store, "nightly-deps");
  const taskId = "nightly-deps-20261007-2230";
  expect(firing.lastOutcome).toBe(`Filed ${taskId}, approved.`);
  const scope = store.getScope(taskId)!;
  expect(scope).toMatchObject({ goal: orderOf(SEEDS[0]!).goal, outOfScope: "No major version bumps", touches: ["package.json"], budgetMicrousd: 2_000_000, approvedBy: "sam" });
  expect(scope.approvedDigest).toBe(scope.digest);
  expect(routeDigestOf(store.approvedRouteOf(taskId)!)).toBe(routeDigestOf(routeFromJson(routeJson)!));
  const card = store.handle.prepare("SELECT * FROM flow_card WHERE task = ?").get(taskId);
  expect(card).toMatchObject({ stage: "build", state: "active", primary_task: taskId });
  // The next slot waits for that task.
  expect(await runFlowTriggers(store, repo, at(211), io)).toMatchObject({ added: 0 });
  expect(triggerOf(store, "nightly-deps").lastOutcome).toBe(`Skipped: the last one (${taskId}, queued) hasn't finished.`);

  // The never-approved routine: turning its schedule on is the yes to try; each firing is an ordinary proposal.
  setFlowTriggerOn(store, triggerOf(store, "weekly-audit"), true, at(240));
  const audit = triggerOf(store, "weekly-audit");
  expect(audit).toMatchObject({ state: "active", nextAt: "2026-10-08T07:30:00.000Z" });
  expect(await runFlowTriggers(store, repo, new Date(Date.parse(audit.nextAt!) + 60_000), io)).toMatchObject({ problems: [] });
  const proposal = store.getScope("weekly-audit-20261008-0730")!;
  expect(proposal).toMatchObject({ goal: orderOf(SEEDS[2]!).goal, approvedAt: null, budgetMicrousd: 2_000_000 });
  expect(store.handle.prepare("SELECT capability_requirements FROM task_ref WHERE external_id = 'weekly-audit-20261008-0730'").get()?.["capability_requirements"]).toBe(JSON.stringify(["tool:node"]));
  expect(triggerOf(store, "weekly-audit").lastOutcome).toBe("Filed weekly-audit-20261008-0730; it waits for approval.");

  // Edited after approval: its approval doesn't verify, so its firing waits for approval, and says why.
  expect(triggerOf(store, "edited-after").state).toBe("paused");
});

test("a migration that dies part-way leaves the v114 routines whole, and the next open finishes it", () => {
  seedV114(SEEDS);
  const db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER v115_dies BEFORE INSERT ON flow WHEN NEW.name = 'docs-drift' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
  db.close();
  expect(() => openStore(file)).toThrow(/simulated crash/);
  const after = new DatabaseSync(file);
  expect(after.prepare("SELECT COUNT(*) AS n FROM routine").get()?.["n"]).toBe(4);
  expect(after.prepare("SELECT COUNT(*) AS n FROM flow").get()?.["n"]).toBe(0);
  after.exec("DROP TRIGGER v115_dies");
  after.close();
  store = openStore(file);
  expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(119);
  expect(store.handle.prepare("SELECT name FROM flow ORDER BY id").all().map(row => row["name"])).toEqual(SEEDS.map(one => one.name));
  expect(store.handle.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'routine%'").all()).toEqual([]);
});
