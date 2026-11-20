import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "./store.js";
import { CHECK_RECOVERY_HELD, checkRequestDigest, parseCheckHoldDetail, readCheckRecoveryHoldsForRun, representCheckHoldDetail } from "./check-recovery-hold.js";

const now = new Date("2026-11-20T00:00:00Z"), repo = "/isolated/check-project";
let store: Store;
beforeEach(() => { store = openStore(":memory:"); });
afterEach(() => store.close());
function task(name: string, project: string | null = repo) {
  store.createTask({ id: name, title: name }, now);
  const ref = store.refFor("built-in", name).id;
  store.handle.prepare("UPDATE task_ref SET repo = ? WHERE id = ?").run(project, ref);
  const run = Number(store.handle.prepare("INSERT INTO run(task_ref,lease_id,runner,role,branch,worktree,started_at,finished_at,outcome,head_revision) VALUES (?,?,'fixture','builder','fixture-branch','/isolated/worktree',?,?,'built',?)")
    .run(ref, `fixture-${name}`, now.toISOString(), now.toISOString(), "a".repeat(40)).lastInsertRowid);
  return { name, ref, run, repo: project };
}
function ask(t: ReturnType<typeof task>) {
  const input = { at: now.toISOString(), actor: "fixture", repo: t.repo, taskId: t.name, runId: t.run,
    action: "checks requested", outcome: "full", source: "work" as const, detail: `${"a".repeat(40)} · person · ${"b".repeat(64)}` };
  const id = store.recordAction(input);
  const representation = { id, repo: t.repo, runId: t.run, taskId: t.name, action: input.action, outcome: input.outcome, detail: input.detail };
  return { id, representation, digest: checkRequestDigest(representation)! };
}
/** Synthetic fixture writer is deliberately test-only. Production module has no event writer. */
function fixtureEvent(t: ReturnType<typeof task>, q: ReturnType<typeof ask>, patch: Record<string, unknown> = {}) {
  const fields = { at: now.toISOString(), actor: "toolroll", repo: t.repo, taskId: t.name, runId: t.run, action: CHECK_RECOVERY_HELD,
    outcome: String(q.id), source: "work" as const, detail: representCheckHoldDetail({ v: 1, q: q.digest, g: "c".repeat(32), r: t.ref })!, ...patch };
  return store.recordAction(fields);
}
function revision(parent: ReturnType<typeof task>, name: string) {
  const child = task(name, parent.repo);
  const artifact = Number(store.handle.prepare("INSERT INTO artifact(run,kind,key,bytes_original,bytes_stored,sha256,capture,created_at) VALUES (?,'revision-brief',?,0,0,?,'fixture',?)")
    .run(parent.run, `fixture-${name}`, "0".repeat(64), now.toISOString()).lastInsertRowid);
  store.handle.prepare("UPDATE task_ref SET revision_of = ?, revision_brief_artifact = ? WHERE id = ?").run(parent.name, artifact, child.ref);
  return child;
}
function disabled(result: ReturnType<typeof readCheckRecoveryHoldsForRun>) {
  expect(result.runtimeProtection).toBe(false); expect(result.retirementSupported).toBe(false); expect(result.nativeStopProof).toBe(false);
}
const ledger = () => store.handle.prepare("SELECT * FROM action_ledger ORDER BY id").all();

describe("CH0 check-recovery event representation and actual-Store reader", () => {
  it("leaves a no-event personal history untouched without returning execution permission", () => {
    const t = task("personal"); ask(t); const before = ledger();
    const result = readCheckRecoveryHoldsForRun(store, t.run);
    expect(result.kind).toBe("no-evidence"); expect(result.familyRefs).toEqual([t.ref]); disabled(result);
    expect(ledger()).toEqual(before); expect(Object.isFrozen(result)).toBe(true);
  });
  it("strictly bounds canonical detail and rejects duplicate/unknown/versioned/truncated input", () => {
    const raw = representCheckHoldDetail({ v: 1, q: "a".repeat(64), g: "b".repeat(32), r: 1 })!;
    expect(raw.length).toBeLessThanOrEqual(300); expect(parseCheckHoldDetail(raw)).not.toBeNull();
    for (const value of [raw + " ", raw.slice(0, -1), raw.replace('{"v":1', '{"v":0,"v":1'), raw.replace('"v":1', '"v":2'),
      raw.replace('"r":1', '"r":0'), "x".repeat(301), JSON.stringify({ ...JSON.parse(raw), approved: true }), null])
      expect(parseCheckHoldDetail(value)).toBeNull();
    expect(representCheckHoldDetail({ v: 1, q: "a".repeat(64), g: "b".repeat(32), r: 1, approved: true })).toBeNull();
  });
  it("binds the exact complete request tuple, not a caller-selected subset", () => {
    const t = task("digest"), q = ask(t);
    expect(q.digest).toMatch(/^[0-9a-f]{64}$/);
    for (const patch of [{ id: q.id + 1 }, { repo: "/other" }, { runId: t.run + 1 }, { taskId: "other" }, { outcome: "quick" }])
      expect(checkRequestDigest({ ...q.representation, ...patch })).not.toBe(q.digest);
    for (const patch of [{ action: "checks finished" }, { detail: "arbitrary" }, { id: Number.MAX_SAFE_INTEGER + 1 }, { approved: true },
      { detail: `${"a".repeat(40)} · person · ${"b".repeat(64)} · extra` }]) expect(checkRequestDigest({ ...q.representation, ...patch })).toBeNull();
  });
  it("recognizes held evidence without ending prior execution or altering real history", () => {
    const t = task("started"), q = ask(t);
    store.recordAction({ at: now.toISOString(), actor: "worker", repo, taskId: t.name, runId: t.run, action: "checks started", outcome: String(q.id), source: "work", detail: "limit 1" });
    const event = fixtureEvent(t, q), before = ledger();
    const result = readCheckRecoveryHoldsForRun(store, t.run);
    expect(result.kind).toBe("held-evidence"); expect(result.holds).toEqual([{ event, request: q.id, run: t.run, taskRef: t.ref, repo,
      recoveryGeneration: "c".repeat(32), admission: "blocked", priorExecution: "unverified" }]); disabled(result);
    expect(ledger()).toEqual(before);
    store.recordAction({ at: now.toISOString(), actor: "worker", repo, taskId: t.name, runId: t.run, action: "checks finished", outcome: `${q.id}:passed`, source: "work", detail: "exit 0" });
    expect(readCheckRecoveryHoldsForRun(store, t.run).kind).toBe("held-evidence");
    expect(store.handle.prepare("SELECT outcome FROM action_ledger WHERE action = 'checks finished'").get()?.["outcome"]).toBe(`${q.id}:passed`);
  });
  it("does not expire evidence by generation or event timestamp and returns every hold by id", () => {
    const t = task("ordering"), q = ask(t);
    const a = fixtureEvent(t, q, { at: "9999-01-01T00:00:00Z" }), b = fixtureEvent(t, q, { at: "1000-01-01T00:00:00Z" });
    expect(readCheckRecoveryHoldsForRun(store, t.run).holds.map(h => h.event)).toEqual([a, b]);
    store.handle.prepare("UPDATE workspace_identity SET recovery_generation = ?").run("d".repeat(32));
    expect(readCheckRecoveryHoldsForRun(store, t.run).kind).toBe("held-evidence");
  });
  it.each([
    ["cross repo", { repo: "/other" }], ["cross task", { taskId: "other" }], ["missing run", { runId: 99999 }],
    ["wrong actor", { actor: "builder" }], ["wrong source", { source: "request" }], ["noncanonical ID", { outcome: "01" }],
    ["unsafe ID", { outcome: "9007199254740992" }], ["missing request", { outcome: "999999" }], ["malformed detail", { detail: "{}" }],
  ])("fails closed on %s", (_name, patch) => {
    const t = task("binding"), q = ask(t); fixtureEvent(t, q, patch);
    const result = readCheckRecoveryHoldsForRun(store, t.run); expect(result.kind).toBe("invalid-evidence"); disabled(result);
  });
  it("rejects exact-shaped wrong request digests/ref without changing history", () => {
    const a = task("a"), q = ask(a), b = task("b");
    for (const detail of [{ v: 1, q: "0".repeat(64), g: "c".repeat(32), r: a.ref }, { v: 1, q: q.digest, g: "c".repeat(32), r: b.ref }]) {
      expect(() => store.transact(() => { fixtureEvent(a, q, { detail: representCheckHoldDetail(detail)! }); expect(readCheckRecoveryHoldsForRun(store, a.run).kind).toBe("invalid-evidence"); throw new Error("fixture rollback"); })).toThrow("fixture rollback");
    }
  });
  it("never narrows cross-run evidence away, regardless which run is requested", () => {
    const a = task("cross-a"), b = task("cross-b"), q = ask(a);
    fixtureEvent(b, q);
    expect(readCheckRecoveryHoldsForRun(store, a.run).kind).toBe("invalid-evidence");
    expect(readCheckRecoveryHoldsForRun(store, b.run).kind).toBe("invalid-evidence");
  });
  it("resolves old, current and sibling revisions; an unrelated project is unaffected", () => {
    const parent = task("root"), child = revision(parent, "child"), sibling = revision(parent, "sibling"), unrelated = task("unrelated", "/elsewhere");
    const q = ask(parent); fixtureEvent(parent, q);
    for (const t of [parent, child, sibling]) {
      const read = readCheckRecoveryHoldsForRun(store, t.run); expect(read.kind).toBe("held-evidence"); expect(read.familyRefs).toEqual([parent.ref, child.ref, sibling.ref]);
    }
    expect(readCheckRecoveryHoldsForRun(store, unrelated.run).kind).toBe("no-evidence");
  });
  it("keeps replacements linked in both directions, without a caller-narrowed family", () => {
    const a = task("replaced"), b = task("replacement"), q = ask(a); fixtureEvent(a, q);
    store.handle.prepare("INSERT INTO task_replacement(task_ref,successor,at) VALUES (?,?,?)").run(a.ref, b.name, now.toISOString());
    expect(readCheckRecoveryHoldsForRun(store, b.run).kind).toBe("held-evidence");
    expect(readCheckRecoveryHoldsForRun(store, a.run).familyRefs).toEqual([a.ref, b.ref]);
  });
  it("blocks moved/cross-project/broken lineage rather than dropping an old held ancestor", () => {
    const a = task("move-root"), b = revision(a, "move-child"), q = ask(a); fixtureEvent(a, q);
    store.handle.prepare("UPDATE task_ref SET repo = '/changed' WHERE id = ?").run(b.ref);
    for (const t of [a, b]) expect(readCheckRecoveryHoldsForRun(store, t.run).kind).toBe("invalid-evidence");
  });
  it("blocks a renamed request scope even if the family has only one version", () => {
    const a = task("renamed"), q = ask(a); fixtureEvent(a, q);
    store.handle.prepare("UPDATE task_ref SET repo = '/changed' WHERE id = ?").run(a.ref);
    expect(readCheckRecoveryHoldsForRun(store, a.run).kind).toBe("invalid-evidence");
  });
  it("rejects missing, cyclic or forged revision lineage and missing input runs", () => {
    const a = task("bad-root"), b = task("bad-child");
    store.handle.prepare("UPDATE task_ref SET revision_of = ? WHERE id = ?").run(a.name, b.ref);
    expect(readCheckRecoveryHoldsForRun(store, b.run).kind).toBe("invalid-evidence");
    expect(readCheckRecoveryHoldsForRun(store, a.run).kind).toBe("invalid-evidence");
    for (const input of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 99999]) expect(readCheckRecoveryHoldsForRun(store, input).kind).toBe("invalid-evidence");
  });
  it("rejects a hold recorded before its claimed request, regardless timestamps", () => {
    const t = task("future-request");
    const next = Number(store.handle.prepare("SELECT COALESCE(MAX(id),0) AS n FROM action_ledger").get()!["n"]) + 2;
    const representation = { id: next, repo, runId: t.run, taskId: t.name, action: "checks requested", outcome: "full",
      detail: `${"a".repeat(40)} · person · ${"b".repeat(64)}` };
    const fake = { id: next, representation, digest: checkRequestDigest(representation)! };
    fixtureEvent(t, fake); expect(ask(t).id).toBe(next);
    expect(readCheckRecoveryHoldsForRun(store, t.run).kind).toBe("invalid-evidence");
  });
  it("rejects proven cyclic lineage instead of hiding held ancestors", () => {
    const a = task("cycle-a"), b = revision(a, "cycle-b");
    const artifact = Number(store.handle.prepare("INSERT INTO artifact(run,kind,key,bytes_original,bytes_stored,sha256,capture,created_at) VALUES (?,'revision-brief','cycle',0,0,?,'fixture',?)")
      .run(b.run, "0".repeat(64), now.toISOString()).lastInsertRowid);
    store.handle.prepare("UPDATE task_ref SET revision_of = ?, revision_brief_artifact = ? WHERE id = ?").run(b.name, artifact, a.ref);
    const result = readCheckRecoveryHoldsForRun(store, a.run);
    expect(result.kind).toBe("invalid-evidence"); expect(result.reason).toBe("cyclic-family");
  });
  it("never commits a caller's outer transaction through its nested read snapshot", () => {
    const a = task("outer"), before = ledger();
    expect(() => store.transact(() => {
      const q = ask(a); fixtureEvent(a, q);
      expect(readCheckRecoveryHoldsForRun(store, a.run).kind).toBe("held-evidence");
      throw new Error("outer rollback");
    })).toThrow("outer rollback");
    expect(ledger()).toEqual(before); expect(readCheckRecoveryHoldsForRun(store, a.run).kind).toBe("no-evidence");
  });

  it("finds immutable original scope when the held run is rebound to a foreign family", () => {
    const original = task("immutable-original"), foreign = task("foreign-family", "/foreign");
    const q = ask(original); fixtureEvent(original, q);
    // A later attempt in the original task still needs to discover its recorded hold.
    const nextRun = Number(store.handle.prepare("INSERT INTO run(task_ref,lease_id,runner,role,branch,worktree,started_at) VALUES (?,'later','fixture','builder','later','/isolated/later',?)")
      .run(original.ref, now.toISOString()).lastInsertRowid);
    store.handle.prepare("UPDATE run SET task_ref = ? WHERE id = ?").run(foreign.ref, original.run);
    for (const run of [nextRun, original.run, foreign.run]) {
      const result = readCheckRecoveryHoldsForRun(store, run);
      expect(result.kind).toBe("invalid-evidence"); expect(result.reason).toBe("hold-binding-mismatch"); disabled(result);
    }
  });
  it("discovers malformed immutable ref scope even if recorded task text is wrong", () => {
    const original = task("ref-original"), foreign = task("ref-foreign", "/foreign");
    const input = { repo, runId: original.run, taskId: "wrong-recorded-task", action: "checks requested", outcome: "full",
      detail: `${"a".repeat(40)} · person · ${"b".repeat(64)}` };
    const id = store.recordAction({ ...input, at: now.toISOString(), actor: "fixture", source: "work" });
    const representation = { id, ...input }, q = { id, representation, digest: checkRequestDigest(representation)! };
    fixtureEvent(original, q, { taskId: "wrong-recorded-task" });
    const nextRun = Number(store.handle.prepare("INSERT INTO run(task_ref,lease_id,runner,role,branch,worktree,started_at) VALUES (?,'later','fixture','builder','later','/isolated/later',?)")
      .run(original.ref, now.toISOString()).lastInsertRowid);
    store.handle.prepare("UPDATE run SET task_ref = ? WHERE id = ?").run(foreign.ref, original.run);
    const result = readCheckRecoveryHoldsForRun(store, nextRun);
    expect(result.kind).toBe("invalid-evidence"); disabled(result);
  });

});
