import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openStore, type Store, type TaskState } from "./store.js";
import { moveTask, TASK_MOVES, type TaskMoveName } from "./task-moves.js";

const STATES: TaskState[] = ["queued", "running", "done", "failed", "cancelled"];
const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-01T01:00:00.000Z");

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "task-moves-"));
  store = openStore(join(dir, "orders.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A task stored in `state` with updated_at at T0 (state written directly: the fixture, not the code under test). */
function taskIn(state: TaskState): string {
  const id = `t-${state}-${Math.random().toString(36).slice(2, 8)}`;
  store.createTask({ id, title: id }, T0);
  store.handle.prepare("UPDATE task SET state = ?, updated_at = ? WHERE id = ?").run(state, T0.toISOString(), id);
  return id;
}

function rowOf(id: string): { state: string; updatedAt: string } {
  const row = store.handle.prepare("SELECT state, updated_at FROM task WHERE id = ?").get(id)!;
  return { state: String(row["state"]), updatedAt: String(row["updated_at"]) };
}

/** The table's from-lists, pinned: each was copied from the statement it replaced, except exhaust (narrowed) and claim
 * (new), docs/plans/closed-task-claims.md. Widening one fails here. */
const EXPECTED_FROM: Record<TaskMoveName, readonly TaskState[] | "any"> = {
  requeue: ["running"],
  giveUp: ["queued", "running"],
  retry: ["failed", "queued", "done"],
  reopen: ["cancelled", "failed", "queued"],
  complete: "any",
  exhaust: ["queued", "running"],
  claim: ["queued", "running"],
  set: "any",
};

describe("TASK_MOVES", () => {
  test("from-lists are exactly today's guards", () => {
    expect(Object.keys(TASK_MOVES).sort()).toEqual(Object.keys(EXPECTED_FROM).sort());
    for (const [name, rule] of Object.entries(TASK_MOVES)) {
      const expected = EXPECTED_FROM[name as TaskMoveName];
      if (expected === "any") expect(rule.from).toBe("any");
      else expect([...(rule.from as readonly TaskState[])].sort()).toEqual([...expected].sort());
    }
  });

  test("no move writes cancelled", () => {
    for (const rule of Object.values(TASK_MOVES)) {
      const targets: readonly string[] = typeof rule.to === "string" ? [rule.to] : rule.to;
      expect(targets).not.toContain("cancelled");
    }
  });
});

describe("moveTask through a real store", () => {
  const guarded = (Object.keys(TASK_MOVES) as TaskMoveName[]).filter(name => TASK_MOVES[name].from !== "any");
  for (const name of guarded) {
    const rule = TASK_MOVES[name];
    const from = rule.from as readonly TaskState[];
    const target = rule.to as TaskState;
    for (const state of STATES) {
      const allowed = from.includes(state);
      test(`${name} from ${state}: ${allowed ? "moves" : "refused"}`, () => {
        const id = taskIn(state);
        expect(moveTask(store.handle, id, name, T1)).toBe(allowed);
        expect(rowOf(id)).toEqual(allowed ? { state: target, updatedAt: T1.toISOString() } : { state, updatedAt: T0.toISOString() });
      });
    }
  }

  for (const state of STATES) {
    for (const to of ["done", "failed"] as const) {
      test(`complete from ${state} to ${to}`, () => {
        const id = taskIn(state);
        expect(moveTask(store.handle, id, "complete", T1, to)).toBe(true);
        expect(rowOf(id)).toEqual({ state: to, updatedAt: T1.toISOString() });
      });
    }
    for (const to of ["queued", "running", "done", "failed"] as const) {
      test(`set from ${state} to ${to}`, () => {
        const id = taskIn(state);
        expect(moveTask(store.handle, id, "set", T1, to)).toBe(true);
        expect(rowOf(id)).toEqual({ state: to, updatedAt: T1.toISOString() });
      });
    }
  }

  test("an unknown task changes nothing and answers false", () => {
    for (const name of Object.keys(TASK_MOVES) as TaskMoveName[]) {
      const to = name === "set" ? "queued" : name === "complete" ? "done" : undefined;
      expect(moveTask(store.handle, "no-such-task", name, T1, to)).toBe(false);
    }
  });

  test("cancelled is never a target", () => {
    const id = taskIn("queued");
    expect(() => moveTask(store.handle, id, "set", T1, "cancelled")).toThrow(/cancelled/);
    expect(() => moveTask(store.handle, id, "complete", T1, "cancelled")).toThrow(/cancelled/);
    expect(() => moveTask(store.handle, id, "requeue", T1, "cancelled")).toThrow(/cancelled/);
    expect(rowOf(id)).toEqual({ state: "queued", updatedAt: T0.toISOString() });
  });

  test("a target is required exactly for the moves with more than one", () => {
    const id = taskIn("running");
    expect(() => moveTask(store.handle, id, "set", T1)).toThrow();
    expect(() => moveTask(store.handle, id, "complete", T1)).toThrow();
    expect(() => moveTask(store.handle, id, "complete", T1, "queued")).toThrow();
    expect(() => moveTask(store.handle, id, "requeue", T1, "queued")).toThrow();
    expect(() => moveTask(store.handle, id, "exhaust", T1, "failed")).toThrow();
    expect(rowOf(id)).toEqual({ state: "running", updatedAt: T0.toISOString() });
  });

  test("an unknown move is refused", () => {
    const id = taskIn("running");
    expect(() => moveTask(store.handle, id, "teleport" as TaskMoveName, T1)).toThrow(/unknown task move/);
    expect(() => moveTask(store.handle, id, "toString" as TaskMoveName, T1)).toThrow(/unknown task move/);
    expect(rowOf(id)).toEqual({ state: "running", updatedAt: T0.toISOString() });
  });
});

describe("the tracker reopen keeps its answers", () => {
  for (const state of STATES) {
    const allowed = ["cancelled", "failed", "queued"].includes(state);
    test(`reopen of a ${state} task: ${allowed ? "queued again" : "bad-state"}`, () => {
      const id = taskIn(state);
      // A tracker item closed (generation 1) and later seen open again (generation 2).
      store.handle.prepare(
        `INSERT INTO external_mirror (local_task_id, backend, remote_repo, remote_id, provenance, established_by, established_at, remote_state, close_generation, sync_generation, dispatch_ok)
         VALUES (?, 'github', 'example/repo', ?, 'local-create', 'test', ?, 'open', 1, 2, 0)`,
      ).run(id, id, T0.toISOString());
      const answer = store.reopenMirror(id, "test", T1);
      if (allowed) {
        expect(answer).toEqual({ ok: true });
        expect(rowOf(id)).toEqual({ state: "queued", updatedAt: T1.toISOString() });
      } else {
        expect(answer).toEqual({ ok: false, reason: "bad-state" });
        expect(rowOf(id)).toEqual({ state, updatedAt: T0.toISOString() });
      }
    });
  }
});

describe("one door for task state (source)", () => {
  const SRC = import.meta.dirname;
  /** Literal task-state writes allowed outside task-moves.ts, counted by file. */
  const ALLOWED: Record<string, { count: number; why: string }> = {
    "store.ts": {
      count: 4,
      why: "applyCancellationLocked (cancellation has its own door) and three requeue statements inside the v115 migration (frozen history)",
    },
  };

  /** An UPDATE of the task table that names state, in any letter case, with or without OR <word> and quotes. */
  const WRITER = /UPDATE\s+(?:OR\s+\w+\s+)?["'\[]?task["'\]]?\s+SET\b[^;`"]*?\bstate\b/gi;
  /** Other ways a row's state could be written: replacing the row, or an insert that updates on conflict. */
  const REPLACERS = [
    /REPLACE\s+INTO\s+["'\[]?task["'\]]?[\s(]/gi,
    /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'\[]?task["'\]]?\s*\([^;`]*?ON\s+CONFLICT[^;`]*?DO\s+UPDATE\s+SET\b[^;`]*?\bstate\b/gi,
  ];

  function sourceFiles(at: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
      else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path);
    }
    return out;
  }

  test("no task-state write outside task-moves.ts except the counted allow-list", () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel === "task-moves.ts") continue;
      const hits = readFileSync(file, "utf8").match(WRITER)?.length ?? 0;
      if (hits > 0) found[rel] = hits;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([file, { count }]) => [file, count])));
  });

  test("no statement replaces a task row or updates its state on an insert conflict", () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      if (REPLACERS.some(pattern => text.match(pattern) !== null)) found.push(relative(SRC, file));
    }
    expect(found).toEqual([]);
  });

  test("the writer pattern sees other spellings of the same statement", () => {
    const spelt = ["update task set state = ?", "UPDATE OR IGNORE task SET updated_at = ?, state = ?", 'UPDATE "task" SET\n  state = ?', "UPDATE task\n   SET updated_at = ?,\n       state = 'queued'"];
    for (const one of spelt) expect(one.match(WRITER)?.length, one).toBe(1);
    expect("UPDATE task_ref SET state = ?".match(WRITER)).toBeNull();
    expect("UPDATE task SET title = ?;".match(WRITER)).toBeNull();
  });

  test("the allowed store.ts statements are the cancellation write and the migration statements", () => {
    const text = readFileSync(join(SRC, "store.ts"), "utf8");
    const at = [...text.matchAll(WRITER)].map(match => match.index);
    const inside = (from: string, to: string) => (index: number) => index > text.indexOf(from) && index < text.indexOf(to, text.indexOf(from));
    const inMigration = inside("function settleContestsForV115(", "\nfunction settleFallbackChainsForV115(");
    const inFallbackMigration = inside("function settleFallbackChainsForV115(", "\n}\n");
    const inCancellation = inside("private applyCancellationLocked(", "\n  }\n");
    expect(at.filter(i => inMigration(i) || inFallbackMigration(i))).toHaveLength(3);
    expect(at.filter(inCancellation)).toHaveLength(1);
    expect(text.slice(at.find(inCancellation)!, at.find(inCancellation)! + 40)).toContain("state = 'cancelled'");
  });
});
