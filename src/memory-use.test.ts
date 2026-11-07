/**
 * "Last included in a run" (docs/plans/learning-loops.md, slice 3): a project with decisions and no knowledge row still
 * gives them to its runs; a frozen context writes its usage in the same transaction; old snapshots are backfilled from
 * their verified bytes with nothing inferred.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { memoryFixture, MEMORY_NOW, type MemoryFixture } from "../test/memory-fixture.js";
import { backfillMemoryUse, lastIncludedWords, memoryUseOf, recordLessonUse } from "./memory-use.js";
import { knowledgeContext, readKnowledgeSnapshot } from "./project-knowledge.js";
import { recordDecision } from "./project-memory.js";

let fixture: MemoryFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const open = () => (fixture = memoryFixture());
const decide = (f: MemoryFixture, claim: string) => recordDecision(f.store, { repo: f.repo, actor: "alex", draft: { claim, why: "Because the guide says so." } }, MEMORY_NOW);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("what a run was given", () => {
  test("decisions with no knowledge row reach the run, with their revision and when, and two runs count as two", () => {
    const f = open();
    const decision = decide(f, "Improve the guide with short labels");
    const first = f.start(), second = f.start();
    expect(knowledgeContext(f.store, first, undefined, f.head)).toContain("short labels");
    knowledgeContext(f.store, second, undefined, f.head);
    const snapshot = readKnowledgeSnapshot(f.store, first)!;
    expect(snapshot).toMatchObject({ version: 2, capturedAt: expect.any(String), decisions: [{ id: decision.id, revision: 1 }] });
    const rows = f.store.handle.prepare("SELECT run, kind, item, version, phase FROM memory_use ORDER BY run").all();
    expect(rows).toEqual([{ run: first, kind: "decision", item: String(decision.id), version: 1, phase: "build" }, { run: second, kind: "decision", item: String(decision.id), version: 1, phase: "build" }]);
    const use = memoryUseOf(f.store, f.repo).get(`decision:${decision.id}`)!;
    expect(use).toMatchObject({ lastRun: second, runs: 2 });
    expect(lastIncludedWords(use)).toMatch(new RegExp(`^Last included in a run: #${second}, [A-Z][a-z]{2} \\d+ · 2 runs$`));
  });

  test("a project with nothing configured stays empty, and an item never given says so", () => {
    const f = open();
    const run = f.start();
    knowledgeContext(f.store, run, undefined, f.head);
    expect(f.store.handle.prepare("SELECT identity FROM knowledge_snapshot WHERE run = ?").get(run)).toMatchObject({ identity: "unconfigured" });
    expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM memory_use").get()).toMatchObject({ n: 0 });
    expect(lastIncludedWords(undefined)).toBe("Not included yet");
  });

  test("a frozen lesson counts by its own record; a payload that doesn't read records nothing", () => {
    const f = open();
    const run = f.start();
    recordLessonUse(f.store, { run, repo: f.repo, payload: `\nadvice\n${JSON.stringify({ version: 1, phase: "build", lessons: [{ id: 7, version: 3 }] })}\n`, at: MEMORY_NOW.toISOString() });
    recordLessonUse(f.store, { run, repo: f.repo, payload: "not json", at: MEMORY_NOW.toISOString() });
    expect(f.store.handle.prepare("SELECT kind, item, version, included_at FROM memory_use").all()).toEqual([{ kind: "lesson", item: "7", version: 3, included_at: MEMORY_NOW.toISOString() }]);
  });
});

describe("backfill", () => {
  const OLD = (id: number) => JSON.stringify({ version: 1, revision: 0, instructions: "", references: [], omitted: [], inheritedFrom: null, decisions: [{ id, claim: "x", decidedAt: "2026-01-01T00:00:00.000Z" }] });
  test("an old knowledge snapshot says when it can't, an old lesson keeps its own time, and a damaged one adds nothing", () => {
    const f = open();
    const old = f.start(), damaged = f.start(), lesson = f.start();
    const add = f.store.handle.prepare("INSERT INTO knowledge_snapshot VALUES (?, ?, 'unconfigured', ?, ?)");
    add.run(old, f.repo, OLD(41), sha(OLD(41)));
    add.run(damaged, f.repo, OLD(42), sha("something else"));
    const payload = `\nadvice\n${JSON.stringify({ phase: "plan", lessons: [{ id: 9, version: 2 }] })}\n`;
    f.store.handle.prepare("INSERT INTO learning_snapshot VALUES (?, ?, 'x', ?, ?, '2026-02-03T00:00:00.000Z')").run(lesson, f.repo, payload, sha(payload));
    expect(backfillMemoryUse(f.store, MEMORY_NOW)).toBe(3);
    expect(f.store.handle.prepare("SELECT run, kind, item, version, phase, included_at FROM memory_use ORDER BY run").all()).toEqual([
      { run: old, kind: "decision", item: "41", version: null, phase: "build", included_at: null },
      { run: lesson, kind: "lesson", item: "9", version: 2, phase: "plan", included_at: "2026-02-03T00:00:00.000Z" },
    ]);
    expect(lastIncludedWords(memoryUseOf(f.store, f.repo).get("decision:41"))).toBe(`Last included in a run: #${old} (time not recorded) · 1 run`);
    // Its cursor moved: a second pass reads nothing.
    expect(backfillMemoryUse(f.store, MEMORY_NOW)).toBe(0);
  });
});
