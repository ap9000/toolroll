/** v173: why a planner's plan or question was refused. One new column only: no saved row changes, a saved run reads
 * none, a crash after the step resumes to the same shape, and what is kept is cleaned on the way in and out. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { presented } from "../test/route-fixture.js";
import { openStore, planProblemsOf, recordPlanProblems, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V173_STEPS } from "./store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-18T00:00:00.000Z");

/** A v172 file with a finished planner run, then the v173 column taken away and the version put back. */
function v172File(): { file: string; run: number } {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v173-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.createTask({ id: "t", title: "t" }, T0);
  const run = made.startRun({ taskRef: made.lookupRef("t")!.id, leaseId: "lease-1", runner: "r", provider: "claude", role: "planner", branch: "toolroll/t", worktree: "/pool/t", now: T0, ...presented(made, made.lookupRef("t")!.id, "planner") });
  made.finishRun(run, { outcome: "failed", reason: "malformed-plan", now: T0 });
  made.close();
  const raw = new DatabaseSync(file);
  raw.exec("ALTER TABLE run DROP COLUMN plan_problems_json");
  raw.exec("UPDATE schema_version SET version = 172");
  raw.close();
  return { file, run };
}
const version = (store: ReturnType<typeof openStore>) => store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];

describe("v173", () => {
  test("fresh: the column, update-safe; the problems are kept once, cleaned, the first eight, and read back per run", () => {
    expect(UPDATE_SAFE_MIGRATIONS).toContain(173);
    expect(updateSafeSchema(172)).toBe(true);
    expect(V173_STEPS).toEqual(["plan-problems-column"]);
    const store = openStore(":memory:");
    try {
      store.createTask({ id: "t", title: "t" }, T0);
      const run = store.startRun({ taskRef: store.lookupRef("t")!.id, leaseId: "lease-1", runner: "r", provider: "claude", branch: "toolroll/t", worktree: "/pool/t", now: T0, ...presented(store, store.lookupRef("t")!.id) });
      expect(planProblemsOf(store, run)).toBeNull();
      // Re-cleaned at the store, whoever calls it: no path, no escape, the first eight.
      recordPlanProblems(store, run, ["\u001b[31mplan: touches /Users/me/secret.ts\u001b[0m", ...Array.from({ length: 10 }, (_, at) => `p${at}`)]);
      const kept = planProblemsOf(store, run)!;
      expect(kept).toHaveLength(8);
      expect(kept[0]).not.toMatch(/\/Users\/me|\u001b/);
      expect(kept.slice(1)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6"]);
      // Cleaned before it is written, not only when read.
      expect(String(store.handle.prepare("SELECT plan_problems_json FROM run WHERE id = ?").get(run)?.["plan_problems_json"])).not.toMatch(/\/Users\/me|\\u001b/);
      recordPlanProblems(store, run, ["a later write"]);
      expect(planProblemsOf(store, run)).toEqual(kept);
      expect(() => store.handle.prepare("UPDATE run SET plan_problems_json = ? WHERE id = ?").run("x".repeat(5000), run)).toThrow();
    } finally { store.close(); }
  });

  test("an unclean value stored some other way is cleaned when it is read", () => {
    const store = openStore(":memory:");
    try {
      store.createTask({ id: "t", title: "t" }, T0);
      const run = store.startRun({ taskRef: store.lookupRef("t")!.id, leaseId: "lease-1", runner: "r", provider: "claude", branch: "toolroll/t", worktree: "/pool/t", now: T0, ...presented(store, store.lookupRef("t")!.id) });
      store.handle.prepare("UPDATE run SET plan_problems_json = ? WHERE id = ?").run(JSON.stringify(["see /Users/me/.ssh/id_rsa", "\u001b]0;title\u0007ok"]), run);
      expect((planProblemsOf(store, run) ?? []).join("\n")).not.toMatch(/\/Users\/me|\u001b|\u0007/);
    } finally { store.close(); }
  });

  test("an upgrade adds the column and changes no saved row; a saved run reads no problems", () => {
    const { file, run } = v172File();
    const upgraded = openStore(file);
    try {
      expect(version(upgraded)).toBe(SCHEMA_VERSION);
      expect(upgraded.getRun(run)).toMatchObject({ outcome: "failed", reason: "malformed-plan" });
      expect(planProblemsOf(upgraded, run)).toBeNull();
    } finally { upgraded.close(); }
  });

  test("a crash after the step resumes to the same shape", () => {
    const { file } = v172File();
    expect(() => openStore(file, { migrationStep: one => { if (one === "plan-problems-column") throw new Error("crash"); } })).toThrow(/crash/);
    const resumed = openStore(file);
    try { expect(version(resumed)).toBe(SCHEMA_VERSION); } finally { resumed.close(); }
  });
});
