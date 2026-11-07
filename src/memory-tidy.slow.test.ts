/**
 * Cleaning up project memory (docs/plans/learning-loops.md, slice 5): the scheduled pass stays deterministic, every item
 * is bound, nothing changes without a person's accept, and restore and unmerge never quietly pass an active replacement.
 */
import { afterEach, describe, expect, test } from "vitest";
import { memoryFixture, MEMORY_NOW, type MemoryFixture } from "../test/memory-fixture.js";
import { withActor } from "./actor.js";
import { activeTail, decideTidy, listTidy, mergeDecisions, parseContradictions, proposeTidy, restoreDecision, restoreReference, scheduledTidy, successorChain, unmergeDecisions, TIDY_MIN_ENTRIES, type TidyAnalyzer } from "./memory-tidy.js";
import { changeKnowledge, knowledgeView } from "./project-knowledge.js";
import { decisionHistory, getDecision, recordDecision, retireDecision } from "./project-memory.js";

let fixture: MemoryFixture | null = null;
afterEach(() => { fixture?.close(); fixture = null; });
const open = () => (fixture = memoryFixture());
const ROOT = "/nonexistent-evidence", proof = "cli-login";
const decide = (f: MemoryFixture, claim: string, at = MEMORY_NOW, supersedes?: number) => recordDecision(f.store, { repo: f.repo, actor: "alex", draft: { claim, why: "Recorded for the test.", ...(supersedes === undefined ? {} : { supersedes }) } }, at).id;
const status = (f: MemoryFixture, id: number) => getDecision(f.store, f.repo, "alex", id)!.status;
const statuses = (f: MemoryFixture, ids: number[]) => ids.map(id => status(f, id));
const merge = (f: MemoryFixture, ids: number[], claim: string) => mergeDecisions(f.store, { repo: f.repo, actor: "alex", ids, claim, why: "They say the same.", proof }, MEMORY_NOW).id;
const mergeOf = (f: MemoryFixture, successor: number) => Number(f.store.handle.prepare("SELECT merge FROM decision_merge WHERE successor = ?").get(successor)!["merge"]);
const accept = (f: MemoryFixture, id: number, extra: object = {}) => decideTidy(f.store, ROOT, { repo: f.repo, actor: "alex", id, decision: "accept", proof, ...extra }, MEMORY_NOW);
const propose = (f: MemoryFixture, analyzer?: TidyAnalyzer) => proposeTidy(f.store, { repo: f.repo, actor: "alex", ...(analyzer === undefined ? {} : { analyzer }) }, MEMORY_NOW);
const useRuns = (f: MemoryFixture, n: number, at: Date) => { const run = f.start(); for (let i = 0; i < n; i++) f.store.handle.prepare("INSERT INTO memory_use (run, repo, kind, item, version, phase, included_at) VALUES (?, ?, 'decision', ?, 1, 'build', ?)").run(run, f.repo, `other-${i}`, at.toISOString()); };

describe("what is proposed", () => {
  test("an unused decision is proposed only with enough runs; a person's accept retires it; restore brings it back", () => {
    const f = open();
    const old = new Date(MEMORY_NOW.getTime() - 90 * 86_400_000);
    const id = decide(f, "Keep the old label", old);
    expect(scheduledTidy(f.store, f.repo, MEMORY_NOW)).toBe(0);
    // 20 distinct runs with context in the window.
    for (let i = 0; i < 20; i++) useRuns(f, 1, MEMORY_NOW);
    return propose(f).then(done => {
      expect(done.made).toBe(1);
      expect(status(f, id)).toBe("active");
      const [proposal] = listTidy(f.store, f.repo);
      expect(proposal).toMatchObject({ kind: "retire", source: "usage", items: [{ kind: "decision", id, revision: 1, status: "active" }] });
      accept(f, proposal!.id);
      expect(status(f, id)).toBe("retired");
      expect(restoreDecision(f.store, { repo: f.repo, actor: "alex", id, proof }, MEMORY_NOW)).toMatchObject({ restored: true });
      expect(status(f, id)).toBe("active");
      expect(decisionHistory(f.store, f.repo, "alex", id).map(one => one.action)).toEqual(["record", "retired", "restored"]);
    });
  });

  test("a row with no recorded time is unknown, so no retire is proposed from it", async () => {
    const f = open();
    const id = decide(f, "Keep the old label", new Date(MEMORY_NOW.getTime() - 90 * 86_400_000));
    for (let i = 0; i < 20; i++) useRuns(f, 1, MEMORY_NOW);
    const run = f.start();
    f.store.handle.prepare("INSERT INTO memory_use (run, repo, kind, item, version, phase, included_at) VALUES (?, ?, 'decision', ?, NULL, 'build', NULL)").run(run, f.repo, String(id));
    await propose(f);
    expect(listTidy(f.store, f.repo)).toEqual([]);
  });

  test("the scheduled pass is quiet, weekly and has no model in reach", () => {
    const f = open();
    const later = new Date(MEMORY_NOW.getTime() + 3 * 86_400_000);
    for (let i = 0; i < TIDY_MIN_ENTRIES - 2; i++) decide(f, `Decision number ${i}`);
    const twin = [decide(f, "Use short labels."), decide(f, "use SHORT labels")];
    // A run still open isn't quiet.
    const open_ = f.start();
    expect(scheduledTidy(f.store, f.repo, later)).toBe(0);
    f.store.finishRun(open_, { outcome: "failed", reason: "agent", now: MEMORY_NOW });
    expect(scheduledTidy(f.store, f.repo, later)).toBe(1);
    expect(listTidy(f.store, f.repo)[0]).toMatchObject({ kind: "merge", source: "duplicate" });
    expect(listTidy(f.store, f.repo)[0]!.items.map(one => one.id).sort()).toEqual(twin.sort());
    expect(scheduledTidy.length).toBe(3);
    // Weekly.
    decide(f, "Another short label"); decide(f, "another short label");
    expect(scheduledTidy(f.store, f.repo, new Date(later.getTime() + 86_400_000))).toBe(0);
  });

  test("a model's contradictions need real active ids and a clean reason", () => {
    expect(parseContradictions('{"contradictions":[{"a":1,"b":2,"why":"they conflict"},{"a":1,"b":9,"why":"x"},{"a":2,"b":1,"why":"again"},{"a":1,"b":1,"why":"self"}]}', [1, 2])).toEqual([{ a: 1, b: 2, why: "they conflict" }]);
    expect(parseContradictions("not json", [1, 2])).toEqual([]);
  });

  test("a contradiction with no choice can't be accepted; each choice does what it says", async () => {
    const f = open();
    const a = decide(f, "Deploy on Fridays"), b = decide(f, "Never deploy on Fridays");
    const analyzer: TidyAnalyzer = async () => ({ ok: true, text: JSON.stringify({ contradictions: [{ a, b, why: "They can't both hold." }] }) });
    await propose(f, analyzer);
    const [proposal] = listTidy(f.store, f.repo);
    expect(proposal).toMatchObject({ kind: "contradiction", source: "model" });
    expect(() => accept(f, proposal!.id)).toThrow(/Choose which stays/);
    expect(() => accept(f, proposal!.id, { choice: "keep:999" })).toThrow(/Choose which stays/);
    expect(statuses(f, [a, b])).toEqual(["active", "active"]);
    accept(f, proposal!.id, { choice: `keep:${a}` });
    expect(statuses(f, [a, b])).toEqual(["active", "retired"]);
  });

  test("a model that can't be asked is said, and the deterministic proposals stand", async () => {
    const f = open();
    decide(f, "One thing"); decide(f, "ONE thing");
    const done = await propose(f, async () => ({ ok: false, problem: "Chat is not configured." }));
    expect(done).toEqual({ made: 1, problem: "Chat is not configured." });
  });

  test("a rejected proposal isn't made again for the same items; a pending one isn't doubled", async () => {
    const f = open();
    decide(f, "One thing"); decide(f, "ONE thing");
    await propose(f); await propose(f);
    expect(listTidy(f.store, f.repo)).toHaveLength(1);
    decideTidy(f.store, ROOT, { repo: f.repo, actor: "alex", id: listTidy(f.store, f.repo)[0]!.id, decision: "reject", proof }, MEMORY_NOW);
    await propose(f);
    expect(listTidy(f.store, f.repo)).toEqual([]);
  });
});

describe("binding every item", () => {
  test("an item changed after proposing goes stale, and nothing changes", async () => {
    const f = open();
    const a = decide(f, "One thing"), b = decide(f, "ONE thing");
    await propose(f);
    const [proposal] = listTidy(f.store, f.repo);
    retireDecision(f.store, { repo: f.repo, actor: "alex", id: b, reason: "Not needed." }, MEMORY_NOW);
    expect(() => accept(f, proposal!.id)).toThrow(/Changed since proposed/);
    expect(status(f, a)).toBe("active");
    expect(listTidy(f.store, f.repo, "all")[0]).toMatchObject({ status: "stale" });
    expect(() => accept(f, proposal!.id)).toThrow(/Changed since proposed/);
  });

  test("the lead and a non-person proof are refused; an account without access too", async () => {
    const f = open();
    decide(f, "One thing"); decide(f, "ONE thing");
    await propose(f);
    const id = listTidy(f.store, f.repo)[0]!.id;
    expect(() => withActor({ account: "alex", lead: true }, () => accept(f, id))).toThrow(/not the lead/);
    expect(() => accept(f, id, { proof: "lead-token" })).toThrow(/own sign-in/);
    expect(() => decideTidy(f.store, ROOT, { repo: f.repo, actor: "nobody", id, decision: "accept", proof }, MEMORY_NOW)).toThrow(/outside your access/);
    await expect(withActor({ account: "alex", lead: true }, () => propose(f))).rejects.toThrow(/not the lead/);
    expect(listTidy(f.store, f.repo)).toHaveLength(1);
  });
});

describe("chains", () => {
  test("A+B→C then C+D→E: A's chain is C and E; restoring A is refused without review, and accepted with it as chosen", () => {
    const f = open();
    const a = decide(f, "Alpha"), b = decide(f, "Beta"), c = merge(f, [a, b], "Alpha and beta"), d = decide(f, "Delta"), e = merge(f, [c, d], "All of it");
    expect(successorChain(f.store, f.repo, a)).toEqual([c, e]);
    expect(activeTail(f.store, f.repo, a)).toEqual([e]);
    const first = restoreDecision(f.store, { repo: f.repo, actor: "alex", id: a, proof }, MEMORY_NOW);
    expect(first).toMatchObject({ restored: false });
    expect(statuses(f, [a, e])).toEqual(["superseded", "active"]);
    const id = (first as { proposal: number }).proposal;
    expect(listTidy(f.store, f.repo)[0]!.items.map(one => one.id)).toEqual([a, c, e]);
    expect(() => accept(f, id)).toThrow(/Choose what happens/);
    accept(f, id, { choice: "retire" });
    expect(statuses(f, [a, c, e])).toEqual(["active", "superseded", "retired"]);
  });

  test("keeping both leaves the tail active; a changed member makes the review stale", () => {
    const f = open();
    const a = decide(f, "Alpha"), b = decide(f, "Beta"), c = merge(f, [a, b], "Alpha and beta");
    const first = restoreDecision(f.store, { repo: f.repo, actor: "alex", id: a, proof }, MEMORY_NOW) as { proposal: number };
    accept(f, first.proposal, { choice: "keep" });
    expect(statuses(f, [a, c])).toEqual(["active", "active"]);
    const again = restoreDecision(f.store, { repo: f.repo, actor: "alex", id: b, proof }, MEMORY_NOW) as { proposal: number };
    retireDecision(f.store, { repo: f.repo, actor: "alex", id: c, reason: "Not needed." }, MEMORY_NOW);
    expect(() => accept(f, again.proposal, { choice: "keep" })).toThrow(/Changed since proposed/);
    expect(status(f, b)).toBe("superseded");
  });

  test("ordinary supersession is handled the same way", () => {
    const f = open();
    const a = decide(f, "Alpha"), b = decide(f, "Better alpha", MEMORY_NOW, a);
    expect(activeTail(f.store, f.repo, a)).toEqual([b]);
    expect(restoreDecision(f.store, { repo: f.repo, actor: "alex", id: a, proof }, MEMORY_NOW)).toMatchObject({ restored: false });
    expect(status(f, a)).toBe("superseded");
  });

  test("unmerge is direct when nothing moved; a repeat is refused and changes nothing; merging again is a new merge", () => {
    const f = open();
    const a = decide(f, "Alpha"), b = decide(f, "Beta"), c = merge(f, [a, b], "Alpha and beta");
    const m = mergeOf(f, c);
    expect(unmergeDecisions(f.store, { repo: f.repo, actor: "alex", merge: m, proof }, MEMORY_NOW)).toMatchObject({ restored: true, successor: c });
    expect(statuses(f, [a, b, c])).toEqual(["active", "active", "retired"]);
    expect(() => unmergeDecisions(f.store, { repo: f.repo, actor: "alex", merge: m, proof }, MEMORY_NOW)).toThrow(/already undone on 2026-11-05/);
    expect(statuses(f, [a, b, c])).toEqual(["active", "active", "retired"]);
    expect(mergeOf(f, merge(f, [a, b], "Alpha and beta, again"))).not.toBe(m);
  });

  test("unmerging C+D→E after E was edited, or A+B→C after it was merged on, needs the expanded review", () => {
    const f = open();
    const a = decide(f, "Alpha"), b = decide(f, "Beta"), c = merge(f, [a, b], "Alpha and beta"), d = decide(f, "Delta"), e = merge(f, [c, d], "All of it");
    const inner = unmergeDecisions(f.store, { repo: f.repo, actor: "alex", merge: mergeOf(f, c), proof }, MEMORY_NOW);
    expect(inner).toMatchObject({ restored: false });
    expect(statuses(f, [a, b, c, e])).toEqual(["superseded", "superseded", "superseded", "active"]);
    expect(listTidy(f.store, f.repo)[0]!.rationale).toMatch(/merged on/);
    // E edited: retired and restored moves its revision.
    retireDecision(f.store, { repo: f.repo, actor: "alex", id: e, reason: "For a moment." }, MEMORY_NOW);
    expect(restoreDecision(f.store, { repo: f.repo, actor: "alex", id: e, proof }, MEMORY_NOW)).toMatchObject({ restored: true });
    const outer = unmergeDecisions(f.store, { repo: f.repo, actor: "alex", merge: mergeOf(f, e), proof }, MEMORY_NOW) as { proposal: number };
    expect(outer).toMatchObject({ restored: false });
    expect(status(f, e)).toBe("active");
    accept(f, outer.proposal, { choice: "keep" });
    expect(statuses(f, [c, d, e])).toEqual(["active", "active", "retired"]);
  });

  test("a reference comes back from history as a new version, bound to the current one", () => {
    const f = open();
    const change = (action: "save" | "remove", draft: object) => { const v = knowledgeView(f.store, f.repo, "alex"); changeKnowledge(f.store, { repo: f.repo, actor: "alex", identity: v.identity, revision: v.revision, action, draft }, MEMORY_NOW); };
    change("save", { title: "Guide", content: "Short labels." });
    const id = knowledgeView(f.store, f.repo, "alex").knowledge.references[0]!.id;
    change("remove", { id });
    restoreReference(f.store, { repo: f.repo, actor: "alex", id, fromRevision: 1, proof }, MEMORY_NOW);
    expect(knowledgeView(f.store, f.repo, "alex")).toMatchObject({ revision: 3, knowledge: { references: [{ id, title: "Guide" }] } });
    expect(() => restoreReference(f.store, { repo: f.repo, actor: "alex", id, fromRevision: 1, proof }, MEMORY_NOW)).toThrow(/already there/);
  });
});
