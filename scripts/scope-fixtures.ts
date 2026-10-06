/**
 * Records test/fixtures/scopes/rows.json: saved scope and standing-order rows to replay (test/scope-replay.ts). The
 * rows come from the authentic v47 fixture (src/fixtures/v47-authentic.sql) and from a store this code files into
 * with synthetic tasks — routed v2 routes with sizes, overrides, strong and light tiers, rubrics with and without
 * `how`, strict quality, budgets, prepared commits, approvals — plus legacy shapes earlier releases saved (no rubric,
 * an empty rubric, a fields-only version 1 digest, 50 touches). No personal data: every name and path is made up.
 *
 *   npx tsx scripts/scope-fixtures.ts             rows.json only
 *   npx tsx scripts/scope-fixtures.ts --baseline  rows.json and baseline.json (only before a reader changes)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store.js";
import { addApprover, approve, digestOf, propose } from "../src/scope.js";
import { readSavedRows, replayRows, SCOPE_FIXTURES, type SavedRow, type SavedRows } from "../test/scope-replay.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const root = fileURLToPath(new URL("..", import.meta.url));
const T0 = new Date("2026-09-20T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function v47Rows(dir: string): SavedRows {
  const file = join(dir, "v47.db");
  const db = new sqlite.DatabaseSync(file);
  db.exec(readFileSync(join(root, "src", "fixtures", "v47-authentic.sql"), "utf8"));
  db.close();
  const rows = readSavedRows(file);
  const tag = (row: SavedRow) => ({ ...row, ...(row["task_id"] === undefined ? {} : { task_id: `v47/${String(row["task_id"])}` }) });
  return { task_scope: rows.task_scope.map(tag), routine: rows.routine };
}

function currentRows(dir: string): SavedRows {
  const file = join(dir, "orders.db");
  const store = openStore(file);
  for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "claude-sonnet-4-5", "fixture", T0);
  store.setPhaseTierConfig("installation", "build", "strong", "claude", "claude-opus-4-1", "fixture", T0);
  store.setPhaseTierConfig("installation", "plan", "strong", "claude", "claude-opus-4-1", "fixture", T0);
  store.setPhaseTierConfig("installation", "build", "light", "claude", "claude-haiku-4-5", "fixture", T0);
  const added = addApprover(store, "approver-one", T0);
  if (!added.ok) throw new Error("no approver");
  const criterion = (id: string, statement: string, evidence: string[], how: string | null = null) => ({ id, statement, how, evidence }) as never;
  let minute = 0;
  const file1 = (id: string, input: Record<string, unknown>, then?: (ref: number) => void) => {
    store.createTask({ id, title: `fixture ${id}` }, at(minute++));
    const ref = store.lookupRef(id)!.id;
    then?.(ref);
    propose(store, { taskId: id, goal: `Fixture goal for ${id}.`, now: at(minute++), ...input } as never);
    return ref;
  };
  const sealIt = (id: string) => {
    const result = approve(store, id, "approver-one", at(minute++), store.getScope(id)!.digest, added.token);
    if (!result.ok) throw new Error(`${id}: approval refused (${JSON.stringify(result)})`);
  };

  file1("cur-plain", { acceptance: [criterion("c1", "The fixture passes.", ["check"])] });
  sealIt("cur-plain");
  file1("cur-rubric", {
    outOfScope: "  Nothing outside the fixture.  ",
    touches: ["src/b.ts", "src/a.ts", "docs/"],
    acceptance: [criterion("c2", "  The page shows the count.  ", ["screenshot", "check"], "Open the page."), criterion("c1", "Tests pass.", ["check"])],
    budgetMicrousd: 2_500_000,
  });
  sealIt("cur-rubric");
  file1("cur-strict", { qualityMode: "strict", riskLevel: "high", acceptance: [criterion("c1", "Every check passes.", ["check", "manual-review", "changed-path"])] });
  file1("cur-elevated", { riskLevel: "elevated", acceptance: [criterion("a-1", "Ünïcödé statement — with “quotes”.", ["manual-review"])] });
  sealIt("cur-elevated");
  file1("cur-small", { acceptance: [criterion("c1", "Typo fixed.", ["changed-path"])] }, ref => store.writeSizing(ref, { size: "small", risky: false, source: "classifier", reason: "a one-line copy change" }));
  sealIt("cur-small");
  file1("cur-large", { acceptance: [criterion("c1", "Migration runs.", ["check"])] }, ref => store.writeSizing(ref, { size: "large", risky: true, source: "person", reason: "" }));
  file1("cur-candidate", { candidate: "0123456789abcdef0123456789abcdef01234567", acceptance: [criterion("c1", "The prepared commit installs.", ["check"])] });
  file1("cur-touches-50", { touches: Array.from({ length: 50 }, (_, index) => `src/file-${String(index).padStart(2, "0")}.ts`), acceptance: [criterion("c1", "All fifty files compile.", ["check"])] });
  file1("cur-no-rubric", {});
  const overridden = file1("cur-override", { acceptance: [criterion("c1", "Overrides hold.", ["check"])] });
  const edited = store.editTaskRoute(overridden, { by: "approver-one", authenticate: () => ({ ok: true }), override: { phase: "plan", provider: "claude", model: "claude-opus-4-1" } } as never, at(minute++));
  if (!edited.ok) throw new Error(`override refused: ${JSON.stringify(edited)}`);
  sealIt("cur-override");

  store.close();

  const rows = readSavedRows(file);
  return { task_scope: rows.task_scope.map(row => ({ ...row, task_id: `current/${String(row["task_id"])}` })), routine: rows.routine };
}

/** Shapes earlier releases saved, made from a current row with the digest their release bound. */
function legacyRows(from: SavedRow): SavedRow[] {
  const fieldsOnly = (row: SavedRow) => {
    const acceptance = row["acceptance_json"] === null ? [] : (JSON.parse(String(row["acceptance_json"])) as never[]);
    return digestOf({ goal: String(row["goal"]), outOfScope: row["out_of_scope"] === null ? null : String(row["out_of_scope"]), touches: JSON.parse(String(row["touches"])) as string[], budgetMicrousd: row["budget_microusd"] as number | null, acceptance });
  };
  const legacy = (name: string, change: SavedRow): SavedRow => {
    const row: SavedRow = { ...from, task_id: `legacy/${name}`, digest_version: 1, route_era: null, proposed_route_json: null, approved_route_json: null, risk_level: "routine", quality_mode: "default", candidate: null, ...change };
    const digest = fieldsOnly(row);
    return { ...row, digest, approved_digest: row["approved_at"] === null ? null : digest };
  };
  return [
    legacy("pre-v39-null-rubric", { acceptance_json: null, approved_at: "2026-08-01T00:00:00.000Z", approved_by: "approver-one" }),
    legacy("empty-rubric", { acceptance_json: "[]", approved_at: null, approved_by: null }),
    legacy("rubric-how-and-unsorted", {
      acceptance_json: JSON.stringify([
        { id: "c2", statement: "Second.", how: "Run it.", evidence: ["screenshot", "check"] },
        { id: "c1", statement: " First, padded. ", how: null, evidence: ["manual-review"] },
      ]),
      approved_at: null,
      approved_by: null,
    }),
    legacy("rubric-how-absent", { acceptance_json: JSON.stringify([{ id: "c1", statement: "Absent how.", evidence: ["check"] }]), approved_at: null, approved_by: null }),
    legacy("fifty-touches-v1", { touches: JSON.stringify(Array.from({ length: 50 }, (_, index) => `lib/${index}.js`)), acceptance_json: null, approved_at: null, approved_by: null }),
    legacy("budget-v15", { budget_microusd: 1_000_000, acceptance_json: null, out_of_scope: null, approved_at: "2026-08-02T00:00:00.000Z", approved_by: "approver-one" }),
  ];
}

const dir = join(root, ".scope-fixtures-tmp");
mkdirSync(dir, { recursive: true });
try {
  const v47 = v47Rows(dir);
  const current = currentRows(dir);
  const plain = current.task_scope.find(row => row["task_id"] === "current/cur-plain")!;
  const rows: SavedRows = { task_scope: [...v47.task_scope, ...current.task_scope, ...legacyRows(plain)], routine: [...v47.routine, ...current.routine] };
  mkdirSync(SCOPE_FIXTURES, { recursive: true });
  writeFileSync(join(SCOPE_FIXTURES, "rows.json"), `${JSON.stringify(rows, null, 2)}\n`);
  if (process.argv.includes("--baseline")) writeFileSync(join(SCOPE_FIXTURES, "baseline.json"), `${JSON.stringify(replayRows(rows), null, 2)}\n`);
  console.log(`${rows.task_scope.length} scope rows, ${rows.routine.length} standing orders`);
} finally {
  (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
}
