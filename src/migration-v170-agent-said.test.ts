/** v170: what the agent said on its way out of a failed attempt. One new column only: no saved row changes, a saved run
 * reads none, a crash after the step resumes to the same shape. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { presented } from "../test/route-fixture.js";
import { agentSaidOf, openStore, recordAgentSaid, SCHEMA_VERSION, UPDATE_SAFE_MIGRATIONS, updateSafeSchema, V170_STEPS } from "./store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const T0 = new Date("2026-11-16T00:00:00.000Z");

/** A v169 file with a finished run, then the v170 column taken away and the version put back. */
function v169File(): { file: string; run: number } {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-v170-"));
  dirs.push(dir);
  const file = join(dir, "orders.db");
  const made = openStore(file);
  made.createTask({ id: "t", title: "t" }, T0);
  const run = made.startRun({ taskRef: made.lookupRef("t")!.id, leaseId: "lease-1", runner: "r", provider: "claude", branch: "toolroll/t", worktree: "/pool/t", now: T0, ...presented(made, made.lookupRef("t")!.id) });
  made.finishRun(run, { outcome: "failed", reason: "agent-error", now: T0 });
  made.close();
  const raw = new DatabaseSync(file);
  raw.exec("ALTER TABLE run DROP COLUMN agent_said_json");
  raw.exec("UPDATE schema_version SET version = 169");
  raw.close();
  return { file, run };
}
const version = (store: ReturnType<typeof openStore>) => store.handle.prepare("SELECT version FROM schema_version").get()?.["version"];

describe("v170", () => {
  test("fresh: the column, update-safe; what the agent said is kept once, cleaned, and read back per run", () => {
    expect(SCHEMA_VERSION).toBe(171);
    expect(UPDATE_SAFE_MIGRATIONS).toContain(170);
    expect(updateSafeSchema(169)).toBe(true);
    expect(V170_STEPS).toEqual(["agent-said-column"]);
    const store = openStore(":memory:");
    try {
      store.createTask({ id: "t", title: "t" }, T0);
      const run = store.startRun({ taskRef: store.lookupRef("t")!.id, leaseId: "lease-1", runner: "r", provider: "claude", branch: "toolroll/t", worktree: "/pool/t", now: T0, ...presented(store, store.lookupRef("t")!.id) });
      expect(agentSaidOf(store, run)).toBeNull();
      // Re-cleaned at the store, whoever calls it: no path, no escape, at most eight lines.
      recordAgentSaid(store, run, ["\u001b[31m/Users/me/x.ts: broke\u001b[0m", ...Array.from({ length: 10 }, (_, at) => `l${at}`)]);
      expect(agentSaidOf(store, run)).toEqual(["l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"]);
      // Cleaned before it is written, not only when read: the stored words themselves carry no path and no escape.
      expect(JSON.parse(String(store.handle.prepare("SELECT agent_said_json FROM run WHERE id = ?").get(run)?.["agent_said_json"]))).toEqual(["l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"]);
      recordAgentSaid(store, run, ["a later write"]);
      expect(agentSaidOf(store, run)).toEqual(["l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"]);
      expect(() => store.handle.prepare("UPDATE run SET agent_said_json = ? WHERE id = ?").run("x".repeat(5000), run)).toThrow();
    } finally { store.close(); }
  });

  test("an upgrade adds the column and changes no saved row; a saved run reads nothing said", () => {
    const { file, run } = v169File();
    const upgraded = openStore(file);
    try {
      expect(version(upgraded)).toBe(171);
      expect(upgraded.getRun(run)).toMatchObject({ outcome: "failed", reason: "agent-error" });
      expect(agentSaidOf(upgraded, run)).toBeNull();
    } finally { upgraded.close(); }
  });

  test("a crash after the step resumes to the same shape", () => {
    const { file } = v169File();
    expect(() => openStore(file, { migrationStep: one => { if (one === "agent-said-column") throw new Error("crash"); } })).toThrow(/crash/);
    const resumed = openStore(file);
    try { expect(version(resumed)).toBe(171); } finally { resumed.close(); }
  });
});
