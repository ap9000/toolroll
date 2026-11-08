/** A finding held for a person is on the Needs you list: in the index every list reads, and in a task's own status. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserWorkActionHref } from "./browser-crew.js";
import { heldFindingCount, sendFinding } from "./findings.js";
import { NEEDS, NEED_ASK } from "./needs-you.js";
import { fileTaskProposal } from "./proposal.js";
import { addApprover } from "./scope.js";
import { openStore, type Store } from "./store.js";
import { assignmentStageOf } from "./task-status.js";
import { workIndexPage } from "./work-index.js";
import { workStatusOf, type WorkFacts } from "./workspace-ui.js";

const now = new Date("2026-11-07T09:00:00Z");
const REPO = "/projects/shop";

describe("a finding held for a person", () => {
  let root: string, file: string, store: Store;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "finding-needs-")));
    file = join(root, "orders.db");
    store = openStore(file);
    if (!addApprover(store, "operator", now).ok) throw Error("account");
    if (!fileTaskProposal(store, { id: "t-1", title: "Tidy the footer", repo: REPO, filedVia: "cli" }, now).ok) throw Error("task");
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  function hold(): number {
    const sent = sendFinding(store, { taskId: "t-1", source: "person", by: "operator", summary: "The total rounds down." }, now);
    if (!sent.ok) throw Error(sent.message);
    store.handle.prepare("UPDATE finding SET state = 'with-person' WHERE id = ?").run(sent.id);
    return sent.id;
  }
  const listed = () => workIndexPage(store, now, { principal: "operator", repos: [REPO] }, { view: "needs-you", limit: 50 }).items.find(one => one.activeTaskId === "t-1");

  test("it joins the Needs you list, and leaves when the person closes it", () => {
    const before = listed();
    const id = hold();
    expect(heldFindingCount(store, "t-1")).toBe(1);
    const row = listed()!;
    expect(row.status.detail).toBe(NEEDS.finding.sentence({}));
    expect(row.primaryAction).toMatchObject({ code: "inspect-findings", label: "Open finding" });
    expect(browserWorkActionHref(row)).toBe("/t/t-1#findings");
    expect(row.ask).toBe("decide");
    store.handle.prepare("UPDATE finding SET state = 'closed' WHERE id = ?").run(id);
    expect(heldFindingCount(store, "t-1")).toBe(0);
    expect(listed()?.status.detail).toBe(before?.status.detail);
  });

  test("an open finding asks nothing of a person", () => {
    sendFinding(store, { taskId: "t-1", source: "person", by: "operator", summary: "The total rounds down." }, now);
    expect(heldFindingCount(store, "t-1")).toBe(0);
    expect(listed()?.primaryAction?.code).not.toBe("inspect-findings");
  });

  test("a database not yet at v155 shows nothing and still lists", () => {
    store.handle.exec("DROP TABLE finding_answer; DROP TABLE finding");
    expect(heldFindingCount(store, "t-1")).toBe(0);
    store.close();
    store = openStore(file);
    expect(workIndexPage(store, now, { principal: "operator", repos: [REPO] }, { limit: 50 }).items.some(one => one.primaryAction?.code === "inspect-findings")).toBe(false);
  });

  const facts = (over: Partial<WorkFacts>): WorkFacts => ({ id: "t-1", title: "Tidy", repo: REPO, state: "queued", updatedAt: now.toISOString(), dispatch: null, result: null, publication: null, liveRunId: null, ...over });

  test("a task's own status says so, with its act, but a cancelled task asks nothing", () => {
    const status = workStatusOf(facts({ heldFindings: 1 }));
    expect(status).toMatchObject({ token: "finding-held", label: "Needs you", detail: NEEDS.finding.sentence({}), action: { label: "Open finding", kind: "open-findings" } });
    expect(status.views).toContain("needs-you");
    expect(workStatusOf(facts({ heldFindings: 1, state: "cancelled" })).views).not.toContain("needs-you");
    expect(NEED_ASK.finding).toBe("decide");
  });

  test("it outlives a saved result, on the assignment's reading too", () => {
    expect(assignmentStageOf({ state: "ready-to-check", primaryAction: null }, { token: "finding-held" } as never)).toEqual({ stage: "needs-you", need: "finding" });
    expect(assignmentStageOf({ state: "cancelled", primaryAction: null }, { token: "finding-held" } as never)).toEqual({ stage: "stopped" });
  });
});
