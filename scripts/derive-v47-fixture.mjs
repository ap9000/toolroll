#!/usr/bin/env node
// Derive the AUTHENTIC schema-v47 database fixture from the v47 build's own
// code (commit 1d0fc9002048333c43b19b9284867bd053050232, "revise-explainable-
// risk-aware-phase-routing-v1"): that commit's src tree is extracted with
// `git archive`, a driver written against ITS store/scope/routine modules
// seeds a realistic v47 database — an approver, a runner, routed and
// pre-routing approvals, a chain approval, a stamped run, a review request,
// an approved routine, a steer note, a lead thread with a proposal — and the
// resulting file is dumped as plain SQL into src/fixtures/v47-authentic.sql.
// The migration tests load that SQL into a fresh file, so what they upgrade
// is what v47 actually wrote, never a hand-wound imitation. Re-run this
// script (no arguments) to regenerate the fixture; it needs only git, tar,
// and the repository's own tsx.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const COMMIT = "1d0fc9002048333c43b19b9284867bd053050232";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src", "fixtures", "v47-authentic.sql");
/** A plain-SQL dump: every table's DDL, then its rows, then every index. */
function dumpSql(file) {
  const { DatabaseSync } = require_("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  const master = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all();
  const lines = ["PRAGMA foreign_keys=OFF;", "BEGIN;"];
  const inserts = name => {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
      const columns = Object.keys(row);
      lines.push(`INSERT INTO "${name}" (${columns.map(c => `"${c}"`).join(", ")}) VALUES (${columns.map(c => literal(row[c])).join(", ")});`);
    }
  };
  // SQLite's own tables (sqlite_sequence) are never created by hand: they
  // appear with the first AUTOINCREMENT table, and only their rows are
  // restored — after every user table, exactly as `.dump` does.
  for (const entry of master.filter(one => one.type === "table" && !one.name.startsWith("sqlite_"))) {
    lines.push(`${entry.sql};`);
    inserts(entry.name);
  }
  for (const entry of master.filter(one => one.type === "table" && one.name.startsWith("sqlite_"))) {
    lines.push(`DELETE FROM "${entry.name}";`);
    inserts(entry.name);
  }
  for (const entry of master.filter(one => one.type !== "table")) lines.push(`${entry.sql};`);
  lines.push("COMMIT;", "");
  db.close();
  return lines.join("\n");
}

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  if (typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function require_(id) {
  return createRequire(import.meta.url)(id);
}

const DRIVER = String.raw`
// Runs against the v47 commit's OWN modules (this file is written into its
// extracted src tree). Everything here goes through that build's public
// roads so the file is exactly what v47 wrote.
import { openStore, verifiedAuthor } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { approveRoutine, routineDigestOf } from "./routine.js";
import { register } from "./runner.js";
import { resolvePhaseAgent, resolveScopeProfile } from "./agentconfig.js";
import { routeDigestOf } from "./phase-routing.js";
import { digestOf } from "./scope.js";

const file = process.argv[2];
const T0 = new Date("2026-09-11T02:00:00.000Z");
const REPO = "/repo/app";
const store = openStore(file);
const version = store.raw().prepare("SELECT version FROM schema_version").get();
if (Number(version?.version) !== 47) throw new Error("the extracted build is not v47: " + JSON.stringify(version));

store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
store.setPhaseConfig("installation", "review", "claude", "opus", "alex", T0);
const added = addApprover(store, "alex", T0, undefined, () => "tok-alex");
if (!added.ok) throw new Error("approver");
register(store, { name: "mac-1", host: "mac", capacity: 2, repos: [REPO], now: T0, newToken: () => "tok-runner" });

const acceptance = [{ id: "c1", statement: "it ships", how: null, evidence: ["check"] }];
const file_ = (id, risk) => {
  store.createTask({ id, title: id }, T0);
  const ref = store.refFor("built-in", id);
  store.placeTask(ref.id, REPO);
  propose(store, { taskId: id, goal: "ship " + id, outOfScope: "nothing else", touches: ["src/" + id + ".ts"], acceptance, now: T0, ...(risk === undefined ? {} : { riskLevel: risk }) });
  return ref;
};

// A routed, approved task with a stamped, finished run and a pending review request.
const routed = file_("t-routed", "elevated");
const routedYes = approve(store, "t-routed", "alex", T0, store.getScope("t-routed").digest, "tok-alex");
if (!routedYes.ok) throw new Error("approve t-routed: " + routedYes.reason);
const sealed = store.approvedRouteOf("t-routed");
if (sealed === null) throw new Error("no sealed route");
const build = sealed.legs.find(leg => leg.phase === "build");
const run = store.startRun({ taskRef: routed.id, leaseId: "lease-1", runner: "mac-1", branch: "standing-orders/t-routed", worktree: "/w/t-routed", provider: build.provider, model: build.model, now: T0 });
const stamped = store.stampRunRoute(run, { routeDigest: routeDigestOf(sealed), phase: "build", provider: build.provider, model: build.model, chosen: build.chosen }, T0);
if (!stamped.ok) throw new Error("stamp: " + stamped.conflict);
store.stampRun(run, { baseRevision: "a".repeat(40), sessionId: "sess-routed", scopeDigest: store.getScope("t-routed").approvedDigest, profileDigest: "x" });
store.recordOutcomeFacts(run, { headRevision: "b".repeat(40) });
store.finishRun(run, { outcome: "built", committed: true, now: new Date(T0.getTime() + 60_000) });
store.saveArtifact({ run, kind: "terminal-diff", key: "terminal-diff.patch", bytesOriginal: 120, bytesStored: 120, truncated: false, sha256: "d".repeat(64), capture: "git diff", captureStatus: "ok" }, new Date(T0.getTime() + 60_000));
const review = store.requestReview(run, "alex", new Date(T0.getTime() + 61_000));
if (!review.ok) throw new Error("review: " + review.reason);

// A pending (unapproved) routed task, and a pre-routing row v47 carried
// over from v46 (its era erased, its digest the profile-only one — exactly
// what the v47 migration left on such rows).
file_("t-pending", "routine");
const legacy = file_("t-legacy");
const legacyYes = approve(store, "t-legacy", "alex", T0, store.getScope("t-legacy").digest, "tok-alex");
if (!legacyYes.ok) throw new Error("approve t-legacy");
{
  const scope = store.getScope("t-legacy");
  const legacyDigest = digestOf({ goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, budgetMicrousd: scope.budgetMicrousd, acceptance: scope.acceptance }, scope.approvedProfile ?? null);
  store.raw().prepare("UPDATE task_scope SET route_era = NULL, proposed_route_json = NULL, approved_route_json = NULL, digest = ?, approved_digest = ? WHERE task_id = 't-legacy'").run(legacyDigest, legacyDigest);
}
void legacy;

// A chain approval (the repo configures fallbacks after the first filings).
store.setFallbackConfig(REPO, [{ provider: "codex", model: "gpt-5-codex", authMode: "subscription" }], "alex", T0);
file_("t-chain", "routine");
const chainYes = approve(store, "t-chain", "alex", T0, store.getScope("t-chain").digest, "tok-alex");
if (!chainYes.ok) throw new Error("approve t-chain: " + chainYes.reason);
if (store.approvedChainOf("t-chain") === null) throw new Error("no approved chain");

// A steer note on the pending task.
const steered = store.fileSteerNote("t-pending", verifiedAuthor("alex"), "prefer the existing formatter", T0);
if (!steered.ok) throw new Error("steer: " + steered.reason);

// An approved routine (v47: a profile, no route columns).
const resolved = resolvePhaseAgent(store, "build", REPO, {});
if (!resolved.ok) throw new Error("routine agent: " + resolved.problem);
const profileResolved = resolveScopeProfile(store, REPO, undefined, { permissionMode: "auto", provider: resolved.spec.provider, model: resolved.spec.model });
if (!profileResolved.ok) throw new Error("routine profile: " + profileResolved.problem);
const terms = { repo: REPO, goal: "refresh the lockfile", outOfScope: null, touches: ["package-lock.json"], acceptance, requirements: [], schedule: "every:60", singleFlight: true, costCeilingUsd: null, budgetPerRunMicrousd: null };
const created = store.createRoutine({ name: "nightly-deps", ...terms, digest: routineDigestOf(terms, profileResolved.profile), profile: profileResolved.profile, filedVia: "cli" }, T0);
if (!created.ok) throw new Error("routine");
const routineYes = approveRoutine(store, created.id, "alex", T0, store.getRoutine(created.id).digest, "tok-alex");
if (!routineYes.ok) throw new Error("approve routine: " + routineYes.reason);

// A lead thread with a pending proposal (the v48 rebuild widens this table).
const thread = store.openLeadThread("alex", "c".repeat(32), T0);
const proposal = store.draftLeadProposal({ thread: thread.thread.id, turn: 1, kind: "steer", payload: { taskId: "t-pending", note: "keep it small" }, ceilingDigest: "c".repeat(32) }, T0);
store.raw().prepare("UPDATE lead_proposal SET state = 'pending' WHERE id = ?").run(proposal);

store.close();
console.log("seeded v47 fixture at " + file);
`;

function main() {
  const scratch = mkdtempSync(join(tmpdir(), "so-v47-fixture-"));
  try {
    execFileSync("sh", ["-c", `git archive ${COMMIT} src | tar -x -C "${scratch}"`], { cwd: root, stdio: "inherit" });
    mkdirSync(join(scratch, "node_modules"), { recursive: true });
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "v47-fixture", type: "module", private: true }));
    const dbFile = join(scratch, "orders.db");
    writeFileSync(join(scratch, "src", "derive-driver.ts"), DRIVER);
    execFileSync(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(scratch, "src", "derive-driver.ts"), dbFile], { cwd: scratch, stdio: "inherit" });
    const sql = dumpSql(dbFile);
    writeFileSync(out, `-- AUTHENTIC schema v47 database, derived by scripts/derive-v47-fixture.mjs from\n-- commit ${COMMIT} (the v47 build's own store, scope, and routine code).\n-- Regenerate with \`node scripts/derive-v47-fixture.mjs\`; never edit by hand.\n${sql}`);
    console.log(`wrote ${out}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
