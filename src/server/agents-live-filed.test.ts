/** Which Live tiles the viewer's own lead filed (docs/plans/lead-dispatched-tiles.md §1–2): one rule table, every link
 * proved from the store, everything short of the whole proof no link at all. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { acquire } from "../claim.js";
import { register } from "../runner.js";
import { addApprover } from "../scope.js";
import { openStore, type LeadThreadScope, type Store } from "../store.js";
import { leadFiledLinks } from "./agents-live-filed.js";

const T0 = new Date("2026-10-27T12:00:00.000Z");
const REPO = "/work/app", OTHER = "/work/other";
let store: Store;

beforeEach(() => {
  store = openStore(":memory:");
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  if (!addApprover(store, "robin", T0, { name: "alex", token: alex.token }).ok) throw new Error("robin");
  register(store, { name: "mac", host: "t", capacity: 40, repos: [REPO, OTHER], now: T0, newToken: () => "tok" });
});
afterEach(() => store.close());

const sql = (text: string, ...args: (string | number | null)[]) => store.handle.prepare(text).run(...args);
const thread = (approver: string, scope?: LeadThreadScope) => store.openLeadThread(approver, "D1", T0, scope).thread.id;
/** A task filed as given, placed in its project, with a running build. */
function filedRun(id: string, options: { by?: string | null; via?: string | null; kind?: string; repo?: string; revisionOf?: { task: string; run: number } } = {}): number {
  store.createTask({ id, title: id, ...(options.by === null ? {} : { filedBy: { name: options.by ?? "alex", kind: (options.kind ?? "person") as "person" } }) }, T0);
  const ref = store.refFor("built-in", id, "ours").id;
  if (options.via !== null) sql("UPDATE task_ref SET filed_via = ? WHERE id = ?", options.via ?? "mate", ref);
  // A revision as every revision road leaves it: its brief bound to a run of the task it revises.
  if (options.revisionOf !== undefined) {
    const brief = store.saveArtifact({ run: options.revisionOf.run, kind: "revision-brief", key: `${id}.json`, sha256: "c".repeat(64), bytesOriginal: 0, bytesStored: 0, truncated: false, capture: "synthetic revision" }, T0);
    store.markRevision(ref, options.revisionOf.task, brief);
  }
  store.placeTask(ref, options.repo ?? REPO);
  const took = acquire(store, ref, "mac", { now: T0, token: "tok", newLeaseId: () => `lease-${id}`, ttlMs: 3_600_000 });
  if (!took.ok) throw new Error(took.reason);
  return store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "mac", branch: id, worktree: `/w/${id}`, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: "m", chosen: "legacy" }, now: T0 });
}
let proposals = 0;
/** A task card in a thread, as the confirm door leaves it (state, who confirmed, the door's outcome). */
function card(threadId: number, taskId: string, options: { state?: string; by?: string; repo?: string; outcome?: Record<string, unknown>; kind?: string } = {}) {
  sql(`INSERT INTO lead_proposal (thread, turn, kind, payload_json, ceiling_digest, state, created_at, resolved_at, resolved_by, outcome_json) VALUES (?, ?, ?, ?, 'D1', ?, ?, ?, ?, ?)`,
    threadId, ++proposals, options.kind ?? "task", JSON.stringify({ repo: options.repo ?? REPO, title: taskId, goal: "g" }), options.state ?? "confirmed", T0.toISOString(), T0.toISOString(),
    options.by ?? "alex", JSON.stringify(options.outcome ?? { ok: true, kind: "task", said: "filed", taskId, via: "web" }));
}
/** A sweep and the confirmed card that started it (a shared action in the same thread), as fileSweep leaves them. */
function sweep(threadId: number | null, roots: string[], options: { owner?: string; repo?: string; card?: "none" | "pending" | "elsewhere" } = {}) {
  let proposal: number | null = null;
  if (options.card !== "none" && threadId !== null) {
    const cardThread = options.card === "elsewhere" ? thread("alex", { kind: "project", key: OTHER }) : threadId;
    proposal = Number(sql(`INSERT INTO lead_proposal (thread, turn, kind, payload_json, ceiling_digest, state, created_at, resolved_by, outcome_json) VALUES (?, ?, 'action', '{}', 'D1', ?, ?, ?, '{"ok":true}')`,
      cardThread, ++proposals, options.card === "pending" ? "pending" : "confirmed", T0.toISOString(), options.owner ?? "alex").lastInsertRowid);
  }
  const id = store.createSweep({ owner: options.owner ?? "alex", thread: threadId, repo: options.repo ?? REPO, title: "s", brief: "b", maxParallel: 2, proposal }, T0);
  roots.forEach((root, index) => store.addSweepTask(id, root, index, root));
}
const links = (viewer: string, ...runs: number[]) => Object.fromEntries([...leadFiledLinks(store, viewer, runs)].map(([run, link]) => [run, link]));

describe("a link proved from the store", () => {
  test("a confirmed task card and a sweep each link their task to the chat that filed it, with the chat's kind", () => {
    const lead = thread("alex"), task = thread("alex", { kind: "task", key: "other-task" });
    const a = filedRun("a"), b = filedRun("b"), c = filedRun("c");
    card(lead, "a");
    sweep(task, ["b"]);
    expect(links("alex", a, b, c)).toEqual({ [a]: { thread: lead, chat: "lead" }, [b]: { thread: task, chat: "task" } });
  });

  test("a revision of a filed task belongs to the same chat (its family root links), and so does every attempt", () => {
    const lead = thread("alex", { kind: "project", key: REPO });
    const first = filedRun("root");
    const revision = filedRun("root-r2", { by: "alex", via: "console", revisionOf: { task: "root", run: first } });
    card(lead, "root");
    // A second attempt of the same task.
    store.finishRun(first, { outcome: "failed", now: T0 });
    const again = store.startRun({ taskRef: store.lookupRef("root")!.id, leaseId: "lease-root", runner: "mac", branch: "root", worktree: "/w/root", route: { routeDigest: "legacy", phase: "build", provider: "claude", model: "m", chosen: "legacy" }, now: T0 });
    expect(links("alex", first, revision, again)).toEqual({ [first]: { thread: lead, chat: "project" }, [revision]: { thread: lead, chat: "project" }, [again]: { thread: lead, chat: "project" } });
  });

  test("a revision whose lineage doesn't hold (another project, a brief from another task's run) links nothing", () => {
    const lead = thread("alex");
    const root = filedRun("root"), unrelated = filedRun("unrelated");
    card(lead, "root");
    const borrowed = filedRun("borrowed", { revisionOf: { task: "root", run: unrelated } });
    const foreign = filedRun("foreign", { repo: OTHER, revisionOf: { task: "root", run: root } });
    expect(links("alex", borrowed, foreign)).toEqual({});
  });

  test("ending the chat erases its cards, and with them every link it made: task cards and sweeps alike", () => {
    const lead = thread("alex");
    const a = filedRun("a"), b = filedRun("b");
    card(lead, "a");
    sweep(lead, ["b"]);
    expect(Object.keys(links("alex", a, b))).toHaveLength(2);
    store.closeLeadThreadsFor("alex", T0);
    expect(links("alex", a, b)).toEqual({});
  });

  test.each([
    ["another viewer, even one who sees the run", (run: number) => { card(thread("alex"), "x"); return { viewer: "robin", run }; }],
    ["filed by someone else", (run: number) => { sql("UPDATE task_ref SET filed_by = 'robin' WHERE external_id = 'x'"); card(thread("alex"), "x"); return { viewer: "alex", run }; }],
    ["not filed through the lead", (run: number) => { sql("UPDATE task_ref SET filed_via = 'console' WHERE external_id = 'x'"); card(thread("alex"), "x"); return { viewer: "alex", run }; }],
    ["filed by an automation", (run: number) => { sql("UPDATE task_ref SET filed_by_kind = 'automation' WHERE external_id = 'x'"); card(thread("alex"), "x"); return { viewer: "alex", run }; }],
    ["a card still pending", (run: number) => { card(thread("alex"), "x", { state: "pending" }); return { viewer: "alex", run }; }],
    ["a card someone else confirmed", (run: number) => { card(thread("alex"), "x", { by: "robin" }); return { viewer: "alex", run }; }],
    ["a card for another project", (run: number) => { card(thread("alex"), "x", { repo: OTHER }); return { viewer: "alex", run }; }],
    ["an outcome the door didn't write (no ok)", (run: number) => { card(thread("alex"), "x", { outcome: { kind: "task", taskId: "x" } }); return { viewer: "alex", run }; }],
    ["a card that acted on the task without filing it", (run: number) => { card(thread("alex"), "x", { kind: "steer", outcome: { ok: true, kind: "steer", taskId: "x" } }); return { viewer: "alex", run }; }],
    ["a card in another person's thread", (run: number) => { card(thread("robin"), "x", { by: "alex" }); return { viewer: "alex", run }; }],
    ["two cards naming the task", (run: number) => { card(thread("alex"), "x"); card(thread("alex", { kind: "project", key: REPO }), "x"); return { viewer: "alex", run }; }],
    ["a card and a sweep naming the task", (run: number) => { const lead = thread("alex"); card(lead, "x"); sweep(lead, ["x"]); return { viewer: "alex", run }; }],
    ["a sweep someone else started", (run: number) => { sweep(thread("alex"), ["x"], { owner: "robin" }); return { viewer: "alex", run }; }],
    ["a sweep for another project", (run: number) => { sweep(thread("alex"), ["x"], { repo: OTHER }); return { viewer: "alex", run }; }],
    ["a sweep with no thread", (run: number) => { sweep(null, ["x"]); return { viewer: "alex", run }; }],
    ["a sweep whose card is gone", (run: number) => { sweep(thread("alex"), ["x"], { card: "none" }); return { viewer: "alex", run }; }],
    ["a sweep whose card was never confirmed", (run: number) => { sweep(thread("alex"), ["x"], { card: "pending" }); return { viewer: "alex", run }; }],
    ["a sweep whose card is in another chat", (run: number) => { sweep(thread("alex"), ["x"], { card: "elsewhere" }); return { viewer: "alex", run }; }],
    ["a team conversation's thread", (run: number) => {
      const team = thread("alex");
      store.handle.exec("PRAGMA foreign_keys = OFF");
      sql("INSERT INTO team_conversation (id, lead, title, visibility, projects_json, thread, created_by, created_at) VALUES ('c1', 'l1', 't', 'private', '[]', ?, 'alex', ?)", team, T0.toISOString());
      store.handle.exec("PRAGMA foreign_keys = ON");
      card(team, "x"); return { viewer: "alex", run };
    }],
    ["an ancestry that can't be proved", (run: number) => { sql("UPDATE task_ref SET revision_of = 'missing' WHERE external_id = 'x'"); card(thread("alex"), "x"); card(thread("alex", { kind: "project", key: REPO }), "missing"); return { viewer: "alex", run }; }],
    ["an outside tracker's task", (run: number) => { card(thread("alex"), "x"); sql("UPDATE task_ref SET backend = 'linear' WHERE external_id = 'x'"); return { viewer: "alex", run }; }],
  ] as const)("no link: %s", (_name, arrange) => {
    const run = filedRun("x");
    const { viewer, run: asked } = arrange(run);
    expect(links(viewer, asked)).toEqual({});
  });
});

test("Codex impl r1 #3: the viewer's card history is read once per request, however many runs and families are shown", () => {
  const lead = thread("alex");
  const runs: number[] = [];
  for (let n = 0; n < 8; n += 1) { runs.push(filedRun(`t${n}`)); card(lead, `t${n}`); }
  // Old cards that name nothing on the grid.
  for (let n = 0; n < 2_000; n += 1) card(lead, `old-${n}`);
  const prepare = vi.spyOn(store.handle, "prepare");
  expect(leadFiledLinks(store, "alex", runs).size).toBe(8);
  const reads = prepare.mock.calls.filter(([text]) => /FROM lead_proposal/.test(String(text))).length;
  prepare.mockRestore();
  // The count is the proof; a wall-clock cap here only measured how busy the machine was.
  expect(reads).toBe(1);
});

test("Codex impl r1 #2: a replaced chat keeps its cards, and so its links; ending the chat erases only what the store erases", () => {
  const first = thread("alex");
  const run = filedRun("kept");
  card(first, "kept");
  // A new chat for the same scope replaces the first (its cards are kept as history): the link stays.
  const second = store.openLeadThread("alex", "D2", T0).thread.id; // a new ceiling replaces the thread
  expect(second).not.toBe(first);
  expect(links("alex", run)).toEqual({ [run]: { thread: first, chat: "lead" } });
  // Ending chat erases the open thread's cards (closeLeadThreadsFor); the replaced thread's history is the store's to keep.
  store.closeLeadThreadsFor("alex", T0);
  expect(links("alex", run)).toEqual({ [run]: { thread: first, chat: "lead" } });
  expect(store.listLeadProposals(first)).toHaveLength(1);
});
