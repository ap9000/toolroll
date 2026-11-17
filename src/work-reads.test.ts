/** One request's work reads (work-reads.ts): the projection and the rows' saved facts are read once per request, and
 * never stand in for what changed since — a write, the clock or another reader's projects. */
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { workCountsByProject, workIndexPage, workStateRows } from "./work-index.js";
import { WORK_READ_REUSE_MS, outsideWorkReads, readerOf, withWorkReads, workReadsOf } from "./work-reads.js";
import { addApprover } from "./scope.js";
import type { WorkSummaryAccess } from "./work-summary.js";
import { LEAD_CLAIMED } from "./lead-voice.js";

const now = new Date("2026-11-13T12:00:00Z");
const operator: WorkSummaryAccess = { principal: "operator", repos: null, includeUnplaced: true };
let dir: string | undefined;
const stores: Store[] = [];
afterEach(() => {
  for (const one of stores.splice(0)) one.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function world(): Store {
  dir = mkdtempSync(join(tmpdir(), "so-work-reads-"));
  const store = openStore(join(dir, "orders.db"));
  stores.push(store);
  for (const [id, repo] of [["a", "/repo/one"], ["b", "/repo/one"], ["c", "/repo/two"], ["d", null]] as const) {
    store.createTask({ id, title: `task ${id}` }, now);
    if (repo !== null) store.placeTask(store.refFor("built-in", id).id, repo, {}, now);
  }
  return store;
}
const temps = (store: Store) => store.handle.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' ORDER BY name").all().map(row => String(row["name"]));
const page = (store: Store, access: WorkSummaryAccess = operator, at: Date = now) => workIndexPage(store, at, access, { view: "all", limit: 40 });

test("outside a request nothing is kept; inside one the projection is read once and gone when it ends", () => {
  const store = world();
  expect(workReadsOf(store)).toBeNull();
  const plain = { page: page(store), states: workStateRows(store, now, operator), counts: workCountsByProject(store, now, operator) };
  expect(temps(store)).toEqual([]);
  const kept = withWorkReads(() => {
    const read = { page: page(store), states: workStateRows(store, now, operator), counts: workCountsByProject(store, now, operator) };
    // Three reads, one projection.
    expect(temps(store)).toEqual(["so_work_ranked_0"]);
    return read;
  });
  expect(kept).toEqual(plain);
  expect(temps(store)).toEqual([]);
});

test("a write during the request is read at once: nothing kept from before it stands in", () => {
  const store = world();
  withWorkReads(() => {
    const before = page(store);
    expect(before.items.find(item => item.rootId === "a")?.state).toBe("queued");
    store.setTaskState("a", "cancelled", now);
    const after = page(store);
    expect(after.items.find(item => item.rootId === "a")?.state).toBe("cancelled");
    expect(after).toEqual(withoutReads(() => page(store)));
  });
});

test("another reader's projects are another projection: a narrower reader never reads the wider one's rows", () => {
  const store = world();
  const narrow: WorkSummaryAccess = { principal: "operator", repos: ["/repo/two"], includeUnplaced: false };
  withWorkReads(() => {
    expect(page(store).items.map(item => item.rootId).sort()).toEqual(["a", "b", "c", "d"]);
    const limited = page(store, narrow);
    expect(limited.items.map(item => item.rootId)).toEqual(["c"]);
    expect(limited).toEqual(withoutReads(() => page(store, narrow)));
    expect(temps(store)).toHaveLength(2);
  });
});

test("inputs that decide no row share one copy; once they decide one, each reader reads its own", () => {
  const store = world();
  const placedOnly: WorkSummaryAccess = { principal: "operator", repos: null, includeUnplaced: false };
  const asAlex: WorkSummaryAccess = { ...operator, viewer: "alex" };
  const reads = () => withWorkReads(() => {
    const out = [page(store), page(store, placedOnly), page(store, asAlex)];
    return { out, copies: temps(store).length };
  });
  // Unplaced work (task d) and no lead claims: the unplaced copy is its own, the lead's reader shares the operator's.
  let seen = reads();
  expect(seen.copies).toBe(2);
  expect(seen.out).toEqual([page(store), page(store, placedOnly), page(store, asAlex)]);
  // Place d: nothing unplaced is left, so admitting unplaced work admits nothing.
  store.placeTask(store.refFor("built-in", "d").id, "/repo/two", {}, now);
  seen = reads();
  expect(seen.copies).toBe(1);
  expect(seen.out).toEqual([page(store), page(store, placedOnly), page(store, asAlex)]);
  // Alex's lead takes a task on: alex's reader now reads it as claimed, the others don't.
  store.recordAction({ at: now.toISOString(), actor: "lead for alex", repo: "/repo/one", taskId: "a", runId: null, action: LEAD_CLAIMED, outcome: "on it", source: "work" });
  seen = reads();
  expect(seen.copies).toBe(2);
  expect(seen.out).toEqual([page(store), page(store, placedOnly), page(store, asAlex)]);
  expect(seen.out[2]!.items.find(item => item.rootId === "a")?.lead).toBeDefined();
  expect(seen.out[0]!.items.find(item => item.rootId === "a")?.lead).toBeUndefined();
});

test("the projection is kept only near the instant it was read for: a hold that ends later reads as ended", () => {
  const store = world();
  store.hold(store.refFor("built-in", "b").id, "wait a moment", new Date(now.getTime() + 1_000), now);
  const later = new Date(now.getTime() + WORK_READ_REUSE_MS + 1_000);
  withWorkReads(() => {
    expect(page(store).items.find(item => item.rootId === "b")?.status.label).not.toBe(withoutReads(() => page(store, operator, later)).items.find(item => item.rootId === "b")?.status.label);
    expect(page(store, operator, later)).toEqual(withoutReads(() => page(store, operator, later)));
  });
});

test("saved answers are copies, and a write through the saving store forgets them", () => {
  const store = world();
  withWorkReads(() => {
    const reads = workReadsOf(store)!;
    const first = reads.store.getTask("a")!;
    (first as { title: string }).title = "changed by a caller";
    expect(reads.store.getTask("a")!.title).toBe("task a");
    reads.store.setTaskState("a", "cancelled", now);
    expect(reads.store.getTask("a")!.state).toBe("cancelled");
    // A write the saving store never saw (the store itself) is found on the next proof.
    store.setTaskState("b", "cancelled", now);
    expect(workReadsOf(store)!.store.getTask("b")!.state).toBe("cancelled");
  });
});

test("an async request keeps its reads until it ends, and drops them after", async () => {
  const store = world();
  await withWorkReads(async () => {
    page(store);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(temps(store)).toEqual(["so_work_ranked_0"]);
  });
  expect(temps(store)).toEqual([]);
});

test("a store or reader acquired earlier in the request never answers from before a write (Codex round 1, finding 1)", () => {
  const store = world();
  withWorkReads(() => {
    // Acquired once, used after writes made through the store itself (not through them).
    const saving = workReadsOf(store)!.store, reader = readerOf(store);
    expect(saving.getTask("a")!.state).toBe("queued");
    expect(reader.getTask("a")!.state).toBe("queued");
    store.setTaskState("a", "cancelled", now);
    expect(saving.getTask("a")!.state).toBe("cancelled");
    expect(reader.getTask("a")!.state).toBe("cancelled");
    // A derived value is proved before its reuse too.
    const reads = workReadsOf(store)!;
    let computed = 0;
    expect(reads.value("n", () => ++computed)).toBe(1);
    expect(reads.value("n", () => ++computed)).toBe(1);
    store.setTaskState("b", "cancelled", now);
    expect(reads.value("n", () => ++computed)).toBe(2);
  });
});

test("a grant removed or an account revoked mid-request is read by the next read of the same request", () => {
  const store = world();
  const alex = addApprover(store, "alex", now);
  const pat = alex.ok ? addApprover(store, "pat", now, { name: "alex", token: alex.token }) : alex;
  expect(pat.ok).toBe(true);
  expect(store.setAccountProjects("pat", ["/repo/one", "/repo/two"], "alex", now).ok).toBe(true);
  withWorkReads(() => {
    const saving = workReadsOf(store)!.store;
    expect(saving.accountCanAccess("pat", "/repo/two")).toBe(true);
    expect(saving.accountCanAccess("pat", "/repo/two")).toBe(true);
    expect(store.setAccountProjects("pat", ["/repo/one"], "alex", now).ok).toBe(true);
    expect(saving.accountCanAccess("pat", "/repo/two")).toBe(false);
    expect(saving.accountCanAccess("pat", "/repo/one")).toBe(true);
    expect(store.revokeAccount("pat", "alex", now).ok).toBe(true);
    expect(saving.accountCanAccess("pat", "/repo/one")).toBe(false);
    expect(readerOf(store).accountOf("pat")?.revokedAt).not.toBeNull();
  });
});

test("a grant written then rolled back in the same request never reads as granted (rollback counts)", () => {
  const store = world();
  const alex = addApprover(store, "alex", now);
  const pat = alex.ok ? addApprover(store, "pat", now, { name: "alex", token: alex.token }) : alex;
  expect(pat.ok).toBe(true);
  expect(store.setAccountProjects("pat", ["/repo/one"], "alex", now).ok).toBe(true);
  const grant = (projects: string[]) => store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'pat'").run(JSON.stringify(projects));
  withWorkReads(() => {
    const saving = workReadsOf(store)!.store;
    expect(saving.accountCanAccess("pat", "/repo/two")).toBe(false);
    // A whole transaction rolled back.
    store.handle.exec("BEGIN");
    grant(["/repo/one", "/repo/two"]);
    expect(saving.accountCanAccess("pat", "/repo/two")).toBe(true);
    store.handle.exec("ROLLBACK");
    expect(saving.accountCanAccess("pat", "/repo/two")).toBe(false);
    // A savepoint rolled back to, then released, inside a transaction that commits.
    store.handle.exec("BEGIN");
    store.handle.exec("SAVEPOINT grant_try");
    grant(["/repo/one", "/repo/two"]);
    expect(saving.accountCanAccess("pat", "/repo/two")).toBe(true);
    store.handle.exec("ROLLBACK TO grant_try");
    expect(saving.accountCanAccess("pat", "/repo/two")).toBe(false);
    store.handle.exec("RELEASE grant_try");
    store.handle.exec("COMMIT");
    expect(saving.accountCanAccess("pat", "/repo/two")).toBe(false);
    expect(readerOf(store).accountCanAccess("pat", "/repo/one")).toBe(true);
  });
});

test("a rollback run through a prepared statement's get() or all() counts as well (Codex round 2, finding 2)", () => {
  const store = world();
  const alex = addApprover(store, "alex", now);
  const pat = alex.ok ? addApprover(store, "pat", now, { name: "alex", token: alex.token }) : alex;
  expect(pat.ok).toBe(true);
  expect(store.setAccountProjects("pat", ["/repo/one"], "alex", now).ok).toBe(true);
  const grant = () => store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'pat'").run(JSON.stringify(["/repo/one", "/repo/two"]));
  withWorkReads(() => {
    const saving = workReadsOf(store)!.store;
    for (const via of ["get", "all"] as const) {
      expect(saving.accountCanAccess("pat", "/repo/two")).toBe(false);
      store.handle.prepare("BEGIN")[via]();
      grant();
      expect(saving.accountCanAccess("pat", "/repo/two")).toBe(true);
      store.handle.prepare("ROLLBACK")[via]();
      expect(saving.accountCanAccess("pat", "/repo/two"), `ROLLBACK through ${via}()`).toBe(false);
      store.handle.prepare("BEGIN")[via]();
      store.handle.prepare("SAVEPOINT grant_try")[via]();
      grant();
      expect(saving.accountCanAccess("pat", "/repo/two")).toBe(true);
      store.handle.prepare("ROLLBACK TO grant_try")[via]();
      expect(saving.accountCanAccess("pat", "/repo/two"), `ROLLBACK TO through ${via}()`).toBe(false);
      store.handle.prepare("RELEASE grant_try")[via]();
      store.handle.prepare("COMMIT")[via]();
    }
  });
});

test("a projection built after another process committed drops everything kept from before it (Codex round 2, finding 1)", async () => {
  const store = world();
  await withWorkReads(async () => {
    const reads = workReadsOf(store)!;
    const saving = reads.store;
    let computed = 0, oldFills = 0;
    // Kept in this turn, before the other process commits: an answer, a value and a projection.
    expect(saving.getTask("c")!.state).toBe("queued");
    expect(reads.value("v", () => ++computed)).toBe(1);
    const fillOld = (name: string) => { oldFills++; store.handle.exec(`CREATE TEMP TABLE "${name}" AS SELECT state FROM task WHERE id = 'c'`); };
    const old = reads.ranked("old", now, fillOld)!;
    expect(store.handle.prepare(`SELECT state FROM temp."${old}"`).get()?.["state"]).toBe("queued");
    execFileSync(process.execPath, ["--no-warnings", "-e", `const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 5000");
      db.prepare("UPDATE task SET state = 'cancelled' WHERE id = 'c'").run(); db.close();`, join(dir!, "orders.db")]);
    // Same turn: a new projection, built after the commit, reads it.
    const fresh = reads.ranked("new", now, name => { store.handle.exec(`CREATE TEMP TABLE "${name}" AS SELECT state FROM task WHERE id = 'c'`); })!;
    expect(store.handle.prepare(`SELECT state FROM temp."${fresh}"`).get()?.["state"]).toBe("cancelled");
    await Promise.resolve();
    // Later turns: nothing kept from before the commit answers.
    expect(saving.getTask("c")!.state).toBe("cancelled");
    expect(reads.value("v", () => ++computed)).toBe(2);
    const again = reads.ranked("old", now, fillOld)!;
    expect(oldFills).toBe(2);
    expect(store.handle.prepare(`SELECT state FROM temp."${again}"`).get()?.["state"]).toBe("cancelled");
  });
});

test("a lead's filtered list reads over the kept copy as over the projection, and another lead's is its own", () => {
  const store = world();
  const ref = (id: string) => store.refFor("built-in", id).id;
  for (const lead of ["lead-1", "lead-2"]) store.handle.prepare("INSERT INTO team_lead(id,name,instructions,status,created_by,created_at) VALUES (?,?,?,?,?,?)").run(lead, lead, "", "active", "alex", now.toISOString());
  const own = store.handle.prepare("INSERT INTO team_task_owner(task_ref,lead,changed_by,changed_at) VALUES (?,?,?,?)");
  own.run(ref("a"), "lead-1", "alex", now.toISOString()); own.run(ref("c"), "lead-1", "alex", now.toISOString()); own.run(ref("b"), "lead-2", "alex", now.toISOString());
  const lead = (leadId: string) => workIndexPage(store, now, operator, { view: "all", limit: 40, leadId });
  withWorkReads(() => {
    expect(lead("lead-1").items.map(item => item.rootId).sort()).toEqual(["a", "c"]);
    expect(lead("lead-2").items.map(item => item.rootId)).toEqual(["b"]);
    expect(lead("lead-1")).toEqual(withoutReads(() => lead("lead-1")));
    expect(lead("lead-2")).toEqual(withoutReads(() => lead("lead-2")));
    expect(temps(store)).toHaveLength(2);
  });
});

test("a commit by another process is read from the next turn on", async () => {
  const store = world();
  await withWorkReads(async () => {
    const saving = workReadsOf(store)!.store;
    expect(saving.getTask("c")!.state).toBe("queued");
    expect(page(store).items.find(item => item.rootId === "c")?.state).toBe("queued");
    // Another process (no Store of this one counts its write): only the file's data version says it committed.
    execFileSync(process.execPath, ["--no-warnings", "-e", `const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 5000");
      db.prepare("UPDATE task SET state = 'cancelled' WHERE id = 'c'").run(); db.close();`, join(dir!, "orders.db")]);
    await Promise.resolve();
    expect(saving.getTask("c")!.state).toBe("cancelled");
    expect(page(store).items.find(item => item.rootId === "c")?.state).toBe("cancelled");
  });
});

test("a write while the projection is built is never stamped as new: the copy is rebuilt, or not kept (finding 2)", () => {
  const store = world();
  withWorkReads(() => {
    const reads = workReadsOf(store)!;
    let fills = 0;
    // The first build writes while it fills: its copy is dropped and built again.
    const table = reads.ranked("k", now, name => {
      fills++;
      store.handle.exec(`CREATE TEMP TABLE "${name}" AS SELECT state FROM task WHERE id = 'a'`);
      if (fills === 1) store.setTaskState("a", "cancelled", now);
    });
    expect(fills).toBe(2);
    expect(table).not.toBeNull();
    expect(store.handle.prepare(`SELECT state FROM temp."${table}"`).get()?.["state"]).toBe("cancelled");
    // Every build writes: after three tries nothing is kept and the caller reads the projection itself.
    let always = 0;
    expect(reads.ranked("j", now, name => {
      always++;
      store.handle.exec(`CREATE TEMP TABLE "${name}" AS SELECT 1 AS one`);
      store.setTaskState("b", always % 2 === 0 ? "queued" : "cancelled", now);
    })).toBeNull();
    expect(always).toBe(3);
    // Those writes also dropped the first copy: nothing kept stands for a database that has since changed.
    expect(temps(store)).toEqual([]);
  });
});

/** The same read with no request around it, as every read was before. */
const withoutReads = <T>(run: () => T): T => outsideWorkReads(run);

test("stopping retries reads as the workbench's On hold; other holds keep their own words", () => {
  const store = world();
  store.holdOwned({ taskRef: store.refFor("built-in", "a").id, ownerKind: "operator", ownerId: "alex", reason: "stopped retrying from the terminal", until: null }, now);
  expect(page(store).items.find(item => item.rootId === "a")?.status).toMatchObject({ label: "On hold", detail: "you stopped retrying" });
  store.holdOwned({ taskRef: store.refFor("built-in", "b").id, ownerKind: "operator", ownerId: "alex", reason: "Waiting for the design review", until: null }, now);
  expect(page(store).items.find(item => item.rootId === "b")?.status.label).not.toBe("On hold");
});
