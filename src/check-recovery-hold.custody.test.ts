/** Recovery evidence is independent custody: no test here claims native stop or earlier nonexecution. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTaskFamily, liveFamilyAttempt, openStore, Store } from "./store.js";
import { CHECK_RECOVERY_HELD, checkRequestDigest, readCheckRecoveryHoldsForTaskRef, representCheckHoldDetail } from "./check-recovery-hold.js";
import { deleteProject, projectRecoveryDeletionProblem, projectRunning, PROJECT_RECOVERY_DELETE_MESSAGE } from "./project-delete.js";
import { runOperate } from "./operate.js";

const now = new Date("2026-11-20T00:00:00Z");
const by = { by: "alex", byKind: "person" as const, rule: null, reason: "Done" };
let root: string, file: string, repo: string, store: Store;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toolroll-hold-custody-")); file = join(root, "orders.db");
  repo = join(root, "project"); store = openStore(file);
});
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true }); });
function task(id: string, where = repo) {
  store.createTask({ id, title: id }, now); const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, where);
  const run = Number(store.handle.prepare(`INSERT INTO run(task_ref,lease_id,runner,role,branch,worktree,started_at,finished_at,outcome,head_revision)
    VALUES (?,?,'fixture','builder','fixture',?, ?,?,'built',?)`).run(ref, id, join(root, id), now.toISOString(), now.toISOString(), "a".repeat(40)).lastInsertRowid);
  return { id, ref, run, repo: where };
}
/** Exact-shaped synthetic event writer exists only in this isolated attack fixture. */
function hold(t: ReturnType<typeof task>, target = store) {
  const fields = { repo: t.repo, runId: t.run, taskId: t.id, action: "checks requested", outcome: "full", detail: `${"a".repeat(40)} · person · ${"b".repeat(16)}` };
  const q = target.recordAction({ ...fields, actor: "fixture", at: now.toISOString(), source: "work" });
  target.recordAction({ actor: "toolroll", at: now.toISOString(), source: "work", repo: t.repo, runId: t.run, taskId: t.id,
    action: CHECK_RECOVERY_HELD, outcome: String(q), detail: representCheckHoldDetail({ v: 1, q: checkRequestDigest({ id: q, ...fields })!, g: "c".repeat(32), r: t.ref })! });
  return q;
}
function finish(t: ReturnType<typeof task>, q: number) {
  store.recordAction({ actor: "fixture", at: now.toISOString(), source: "work", repo: t.repo, runId: t.run, taskId: t.id,
    action: "checks finished", outcome: `${q}:passed`, detail: "observed exit 0" });
}
const rows = (table: string) => store.handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const deleteOptions = () => ({ actor: "alex", via: "command line" as const, now, evidenceRoot: null, poolRoot: null });
async function cli(argv: string[]) {
  const lines: string[] = [];
  const code = await runOperate("task", [...argv, "--db", file, "--json"], line => lines.push(line), { now });
  return { code, envelope: JSON.parse(lines.join("\n")) as Record<string, unknown> };
}

describe("CH2c independent recovery custody", () => {
  it("retains holds after later factual finishes without rewriting prior execution", () => {
    const t = task("held"), q = hold(t); finish(t, q);
    const history = rows("action_ledger"), runs = rows("run");
    expect(liveFamilyAttempt(store, [t.ref], now)).toBe(t.id);
    expect(archiveTaskFamily(store, t.id, by, now)).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(rows("task_archive")).toEqual([]); expect(rows("run")).toEqual(runs); expect(rows("action_ledger")).toEqual(history);
    expect(readCheckRecoveryHoldsForTaskRef(store, t.ref)).toMatchObject({ kind: "held-evidence", nativeStopProof: false });
  });
  it("resolves immutable scope with no seed run after its run is rebound elsewhere", () => {
    const t = task("original"), other = task("foreign", join(root, "foreign")); hold(t);
    store.handle.prepare("UPDATE run SET task_ref = ? WHERE id = ?").run(other.ref, t.run);
    expect(store.handle.prepare("SELECT 1 FROM run WHERE task_ref = ?").get(t.ref)).toBeUndefined();
    expect(readCheckRecoveryHoldsForTaskRef(store, t.ref).kind).toBe("invalid-evidence");
    expect(liveFamilyAttempt(store, [t.ref], now)).toBe(t.id);
    expect(archiveTaskFamily(store, t.id, by, now)).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(readCheckRecoveryHoldsForTaskRef(store, 99999).kind).toBe("invalid-evidence");
  });
  it("resolves the complete replacement family from a successor with no run", () => {
    const t = task("old"); hold(t); store.createTask({ id: "new", title: "new" }, now);
    const ref = store.refFor("built-in", "new").id; store.placeTask(ref, repo);
    store.handle.prepare("INSERT INTO task_replacement(task_ref,successor,at) VALUES (?,?,?)").run(t.ref, "new", now.toISOString());
    expect(readCheckRecoveryHoldsForTaskRef(store, ref).kind).toBe("held-evidence");
    expect(archiveTaskFamily(store, "new", by, now)).toMatchObject({ ok: false, reason: "recovery-held" });
  });
  it("reproves a cached archive preview and a hold appearing in its transactional guard", () => {
    const t = task("preview");
    expect(liveFamilyAttempt(store, [t.ref], now)).toBeNull();
    expect(archiveTaskFamily(store, t.id, by, now, { expect: [t.ref], guard: () => { const q = hold(t); finish(t, q); return null; } }))
      .toMatchObject({ ok: false, reason: "recovery-held" });
    expect(rows("task_archive")).toEqual([]);
  });
  it("refuses replacement while preserving explicit person cancellation and native provenance", () => {
    const t = task("source"), next = task("target"); hold(t); const runs = rows("run");
    expect(store.setTaskState(t.id, "cancelled", now, {}, undefined, next.id)).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(rows("task_replacement")).toEqual([]);
    expect(store.setTaskState(t.id, "cancelled", now)).toMatchObject({ ok: true });
    expect(readCheckRecoveryHoldsForTaskRef(store, t.ref).kind).toBe("held-evidence"); expect(rows("run")).toEqual(runs);
  });
  it.each(["source", "target"])("refuses replacement with an existing %s whose ref is missing under global hold", missing => {
    const unrelated = task("held-elsewhere", join(root, "elsewhere")); hold(unrelated);
    const source = task("damaged-source"), target = task("damaged-target"), broken = missing === "source" ? source : target;
    // Deliberately damage an isolated database: this proves refusal, not corruption repair or valid historical provenance.
    store.handle.exec("PRAGMA foreign_keys = OFF");
    store.handle.prepare("DELETE FROM task_ref WHERE id = ?").run(broken.ref);
    store.handle.exec("PRAGMA foreign_keys = ON");
    expect(store.handle.prepare("PRAGMA foreign_key_check").all().length).toBeGreaterThan(0);
    const history = rows("action_ledger"), runs = rows("run"), before = store.getTask(source.id);
    expect(store.setTaskState(source.id, "cancelled", now, {}, undefined, target.id)).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(store.getTask(source.id)).toEqual(before); expect(rows("task_replacement")).toEqual([]);
    expect(rows("action_ledger")).toEqual(history); expect(rows("run")).toEqual(runs);
  });
  it.each(["source", "target"])("refuses CLI precheck when existing %s lookup cannot resolve its ref", async missing => {
    const unrelated = task("held-elsewhere", join(root, "elsewhere")); hold(unrelated);
    const source = task("cli-damaged-source"), target = task("cli-damaged-target"), broken = missing === "source" ? source : target;
    const lookup = Store.prototype.lookupRef;
    vi.spyOn(Store.prototype, "lookupRef").mockImplementation(function (this: Store, id: string) { return id === broken.id ? null : lookup.call(this, id); });
    const id = missing === "target" ? target.id : "never-created";
    const result = await cli(["add", "Replacement", "--id", id, "--replaces", source.id, "--repo", repo]);
    expect(result.envelope).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(store.getTask("never-created")).toBeNull(); expect(rows("task_replacement")).toEqual([]);
  });
  it("preserves genuinely future successors under unrelated hold and no-event damaged-reference behavior", () => {
    const source = task("future-source"), unrelated = task("unrelated", join(root, "elsewhere")); hold(unrelated);
    expect(store.getTask("future-successor")).toBeNull();
    expect(store.setTaskState(source.id, "cancelled", now, {}, undefined, "future-successor")).toMatchObject({ ok: true });
    // A separate no-event Store proves this slice does not introduce a universal damaged-reference policy.
    const personal = openStore(":memory:");
    try {
      personal.createTask({ id: "personal", title: "personal" }, now);
      personal.createTask({ id: "next", title: "next" }, now);
      const ref = personal.lookupRef("next")!;
      personal.handle.prepare("DELETE FROM task_ref WHERE id = ?").run(ref.id);
      expect(personal.setTaskState("personal", "cancelled", now, {}, undefined, "next")).toMatchObject({ ok: true });
    } finally { personal.close(); }
  });
  it("keeps no-event personal archive and replacement behavior", () => {
    const t = task("personal"); expect(liveFamilyAttempt(store, [t.ref], now)).toBeNull();
    expect(archiveTaskFamily(store, t.id, by, now)).toMatchObject({ ok: true });
    const a = task("from"), b = task("to");
    expect(store.setTaskState(a.id, "cancelled", now, {}, undefined, b.id)).toMatchObject({ ok: true });
  });
  it("refuses CLI replacement before creating or queueing a new task", async () => {
    const t = task("source"); hold(t);
    const result = await cli(["add", "Replacement", "--id", "replacement", "--replaces", t.id, "--repo", repo]);
    expect(result.envelope).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(store.getTask("replacement")).toBeNull(); expect(rows("task_replacement")).toEqual([]);
  });
  it("rolls back creation, placement and linkage if lower replacement reproof refuses", async () => {
    const t = task("source"), beforeRefs = rows("task_ref");
    const original = Store.prototype.setTaskState;
    vi.spyOn(Store.prototype, "setTaskState").mockImplementation(function (this: Store, ...args: Parameters<Store["setTaskState"]>) {
      if (args[5] === "replacement") hold(t, this); // deterministic lower-boundary observation inside the same transaction
      return original.apply(this, args);
    });
    const result = await cli(["add", "Replacement", "--id", "replacement", "--replaces", t.id, "--repo", repo]);
    expect(result.envelope).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(store.getTask("replacement")).toBeNull(); expect(rows("task_ref")).toEqual(beforeRefs); expect(rows("task_replacement")).toEqual([]);
    // Synthetic boundary insertion rolls back too; this test proves atomic denial, not a concurrent external commit.
    expect(rows("action_ledger").some(row => row["action"] === CHECK_RECOVERY_HELD)).toBe(false);
  });
  it("keeps replacement denial atomic when the CLI Store seam joins an outer owner", async () => {
    const t = task("nested-source"), original = Store.prototype.setTaskState;
    vi.spyOn(Store.prototype, "setTaskState").mockImplementation(function (this: Store, ...args: Parameters<Store["setTaskState"]>) {
      if (args[5] === "nested-new") hold(t, this);
      return original.apply(this, args);
    });
    // The command's synchronous mutation prefix uses the supplied Store; the outer owner then commits its own work.
    // This exercises a caught nested refusal, not an asynchronous transaction or external concurrency guarantee.
    const close = vi.spyOn(store, "close").mockImplementation(() => {}), lines: string[] = [];
    let pending: Promise<number> | undefined;
    store.transact(() => {
      pending = runOperate("task", ["add", "Replacement", "--id", "nested-new", "--replaces", t.id, "--repo", repo, "--json"],
        line => lines.push(line), { now, databaseFile: file, openDatabase: () => store });
      expect(store.getTask("nested-new")).toBeNull();
      store.createTask({ id: "outer-kept", title: "Independent outer write" }, now);
    });
    await pending; close.mockRestore();
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(store.getTask("nested-new")).toBeNull(); expect(store.getTask("outer-kept")).not.toBeNull();
    expect(rows("task_replacement")).toEqual([]);
  });
  it("propagates direct CLI replacement refusal while ordinary person cancellation still works", async () => {
    const t = task("cli-source"), next = task("cli-next"); hold(t);
    expect((await cli(["state", t.id, "cancelled", "--replaced-by", next.id])).envelope).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(rows("task_replacement")).toEqual([]);
    expect((await cli(["state", t.id, "cancelled"])).envelope).toMatchObject({ ok: true });
    expect(readCheckRecoveryHoldsForTaskRef(store, t.ref).kind).toBe("held-evidence");
  });
  it("allows no-event CLI replacement through the same atomic creator", async () => {
    const t = task("source"); const result = await cli(["add", "Replacement", "--id", "replacement", "--replaces", t.id, "--repo", repo]);
    expect(result.envelope).toMatchObject({ ok: true }); expect(store.getTask("replacement")).not.toBeNull();
    expect(rows("task_replacement")).toHaveLength(1); expect(store.refFor("built-in", "replacement").repo).toBe(repo);
  });
  it("blocks project deletion before native calls even after a later finish", async () => {
    const t = task("project-held"), q = hold(t); finish(t, q); const runner = vi.fn();
    expect(projectRunning(store, repo, now)).toContain(PROJECT_RECOVERY_DELETE_MESSAGE);
    expect(await deleteProject(store, repo, { ...deleteOptions(), runner })).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(runner).not.toHaveBeenCalled(); expect(store.getTask(t.id)).not.toBeNull(); expect(rows("hold")).toEqual([]);
  });
  it("retains immutable project scope after all current task bindings move away", () => {
    const t = task("moved"); hold(t);
    store.handle.prepare("UPDATE task_ref SET repo = ? WHERE id = ?").run(join(root, "foreign"), t.ref);
    expect(projectRecoveryDeletionProblem(store, repo)).toBe(PROJECT_RECOVERY_DELETE_MESSAGE);
    expect(projectRecoveryDeletionProblem(store, join(root, "unrelated"))).toBeNull();
  });
  it("propagates a recovery hold first observed in the second project liveness read", async () => {
    const t = task("second-read-race"), prepare = store.handle.prepare.bind(store.handle); let injected = false;
    vi.spyOn(store.handle, "prepare").mockImplementation(sql => {
      if (!injected && sql.includes("COUNT(DISTINCT task_ref)") && sql.includes("FROM claim")) {
        injected = true; hold(t);
      }
      return prepare(sql);
    });
    const runner = vi.fn(), result = await deleteProject(store, repo, { ...deleteOptions(), runner });
    expect(injected).toBe(true); expect(result).toMatchObject({ ok: false, reason: "recovery-held", said: PROJECT_RECOVERY_DELETE_MESSAGE });
    expect(runner).not.toHaveBeenCalled(); expect(rows("hold")).toEqual([]); expect(store.getTask(t.id)).not.toBeNull();
  });
  it("reproves project admission after a cached preview before writing temporary holds", async () => {
    const t = task("admission-race"), original = store.transact.bind(store); let first = true;
    vi.spyOn(store, "transact").mockImplementation(body => {
      if (first) { first = false; const q = hold(t); finish(t, q); }
      return original(body);
    });
    const runner = vi.fn();
    expect(await deleteProject(store, repo, { ...deleteOptions(), runner })).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(runner).not.toHaveBeenCalled(); expect(rows("hold")).toEqual([]); expect(store.getTask(t.id)).not.toBeNull();
  });
  it("reproves project deletion at its final database transaction after a cached preview", async () => {
    const t = task("final-race"); const original = store.transact.bind(store); let calls = 0;
    vi.spyOn(store, "transact").mockImplementation(body => {
      if (++calls === 2) { const q = hold(t); finish(t, q); }
      return original(body);
    });
    const result = await deleteProject(store, repo, deleteOptions());
    expect(result).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(store.getTask(t.id)).not.toBeNull(); expect(rows("hold")).toEqual([]);
    expect(rows("action_ledger").some(row => row["action"] === "project deleted")).toBe(false);
  });
  it("reproves before destructive Git launch when a read returns after a hold commits", async () => {
    const t = task("native-race"); mkdirSync(join(repo, ".git", "objects"), { recursive: true }); mkdirSync(join(repo, ".git", "refs"));
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n"); writeFileSync(join(repo, ".git", "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
    const calls: string[][] = [];
    const runner = vi.fn(async (_file: string, args: string[]) => {
      calls.push(args);
      if (args.includes("rev-parse")) { hold(t); return { code: 0, stdout: ".git\n", stderr: "" }; }
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await deleteProject(store, repo, { ...deleteOptions(), runner });
    expect(result).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(calls.length).toBeGreaterThan(0); expect(calls.some(args => args.includes("remove") || args.includes("-D"))).toBe(false);
    expect(store.getTask(t.id)).not.toBeNull(); expect(rows("hold")).toEqual([]);
  });
});
