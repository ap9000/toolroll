/** A list's landing words (landed-rows.ts) are the task page's (local-landing.ts landingHistoryOf) for every landing
 * state, read for the whole page in one SQL statement however many rows it lists (review round 1). */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { recordActionWhole } from "./action-ledger.js";
import { LAND_DESTINATION, LAND_HANDOFF, LAND_HANDOFF_SETTLED, LAND_INTENT, LAND_SETTLED, landingHistoryOf } from "./local-landing.js";
import { LANDED_GIT_READS, landedRowsOf, type LandedRow } from "./landed-rows.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const REPO = "/repos/landed-rows", PR_REPO = "/repos/landed-rows-pr";
const OLD = "1".repeat(40);
let dir: string, store: Store, password: string;
const heads: Record<string, string> = {};
const runs: Record<string, number> = {};

function built(id: string, repo = REPO): void {
  store.createTask({ id, title: id }, NOW);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, repo, {}, NOW);
  const proposed = propose(store, { taskId: id, goal: `Do ${id}`, touches: ["src/a.ts"], acceptance: [], now: NOW });
  if (!approve(store, id, "sam", NOW, proposed.digest, password).ok) throw new Error("approve");
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "r", branch: `b-${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: NOW });
  const head = (run + 10).toString(16).padStart(2, "0").repeat(20);
  store.recordOutcomeFacts(run, { headRevision: head, handoff: "Done." });
  store.finishRun(run, { outcome: "built", committed: true, now: NOW });
  heads[id] = head;
  runs[id] = run;
}
const ledger = (task: string | null, repo: string, run: number | null, action: string, outcome: string, detail: unknown, source = "work") =>
  recordActionWhole(store.handle, { at: NOW.toISOString(), actor: "toolroll", repo, taskId: task, runId: run, action, outcome, source }, detail);
/** A settled landing of `candidate` as commit `commit` (an undo when `reverts` names the landing it reverts). */
function landed(task: string, candidate: string, commit: string, reverts?: string): number {
  const intent = ledger(task, REPO, runs[task]!, LAND_INTENT, "pending", { v: 1, kind: reverts === undefined ? "land" : "undo", key: "k", ref: "refs/heads/main", old: OLD, commit, mode: "ref",
    ...(reverts === undefined ? { policy: "squash", candidate } : { reverts }) }, "request");
  ledger(task, REPO, runs[task]!, LAND_SETTLED, `${intent}:landed`, { v: 1 });
  return intent;
}
function handedOff(task: string, commit: string): void {
  const handoff = ledger(task, REPO, runs[task]!, LAND_HANDOFF, "pending", { v: 1, key: "k", ref: "refs/heads/main", old: OLD, commit, keep: `refs/toolroll/land/${task}/${commit}`, folder: REPO, candidate: heads[task] }, "request");
  ledger(task, REPO, runs[task]!, LAND_HANDOFF_SETTLED, `${handoff}:kept`, { v: 1 });
}
/** git as a project would answer: `onMain` commits are on main; nothing else is said (no revert is proved). */
const onMain = new Set<string>();
const git = (_cwd: string, args: readonly string[]): string | null => args[0] === "merge-base" ? onMain.has(args[2]!) ? "" : null : null;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "landed-rows-"));
  store = openStore(join(dir, "state.db"));
  const sam = addApprover(store, "sam", NOW);
  if (!sam.ok) throw new Error("sam");
  password = sam.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
  for (const id of ["recorded", "earlier", "undone-brought-in", "kept-not-merged", "untouched", "not-complete"]) built(id);
  built("pull-requests", PR_REPO);
  ledger(null, REPO, null, LAND_DESTINATION, "refs/heads/main", { v: 1, ref: "refs/heads/main", common: join(REPO, ".git") }, "request");
  landed("recorded", heads["recorded"]!, "a".repeat(40));
  landed("earlier", "e".repeat(40), "b".repeat(40));
  const first = landed("undone-brought-in", heads["undone-brought-in"]!, "c".repeat(40));
  landed("undone-brought-in", heads["undone-brought-in"]!, "f".repeat(40), `intent:${first}`);
  handedOff("undone-brought-in", "d".repeat(40));
  onMain.add("d".repeat(40));
  handedOff("kept-not-merged", "9".repeat(40));
  landed("not-complete", heads["not-complete"]!, "8".repeat(40));
  store.savePublicationGrant({ repo: PR_REPO, githubRepo: "o/r", remote: "origin", headPrefix: "so/", base: "main", capabilities: ["push-branch", "open-pr"], selector: "ours", draft: false, grantedBy: "sam", publishOn: "complete" }, NOW);
  const prRun = runs["pull-requests"]!;
  recordActionWhole(store.handle, { at: NOW.toISOString(), actor: "toolroll", repo: PR_REPO, taskId: "pull-requests", runId: prRun, action: LAND_INTENT, outcome: "pending", source: "request" },
    { v: 1, kind: "land", key: "k", ref: "refs/heads/main", old: OLD, commit: "7".repeat(40), mode: "ref", candidate: heads["pull-requests"] });
});
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("a list's landing words", () => {
  const row = (id: string, state = "complete"): LandedRow => ({ rootId: id, repo: id === "pull-requests" ? PR_REPO : REPO, resultRunId: runs[id]!, assignmentState: state });
  const rows = () => [row("recorded"), row("earlier"), row("undone-brought-in"), row("kept-not-merged"), row("untouched"), row("not-complete", "ready-to-check"), row("pull-requests")];

  test("say exactly what the task page says, for every landing state", () => {
    const listed = landedRowsOf(store, rows(), git);
    expect([...listed].sort()).toEqual([
      ["recorded", "Landed on main (aaaaaaa)"],
      ["undone-brought-in", "Landed on main (ddddddd)"],
    ]);
    // The task page's own reading, task by task (only Complete work in a project without pull requests is asked).
    for (const one of rows().filter(r => r.assignmentState === "complete" && r.repo === REPO)) {
      const history = landingHistoryOf(store, REPO, one.rootId, heads[one.rootId]!, git);
      expect(listed.get(one.rootId) ?? null, one.rootId).toBe(history !== null && history.landed ? history.words.replace(/\.$/, "") : null);
    }
  });

  test("one SQL statement for the whole page, however many rows it lists", () => {
    const prepare = vi.spyOn(store.handle, "prepare");
    try {
      landedRowsOf(store, rows(), git);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally { prepare.mockRestore(); }
  });
});

describe("bounded, whatever a page holds (review round 2)", () => {
  test("the statement reads only what an answer rests on: its results' kept handoffs and each project's newest destination", () => {
    // History the page can't use: a kept handoff of another commit, and an older destination record.
    ledger(null, REPO, null, LAND_DESTINATION, "refs/heads/old", { v: 1, ref: "refs/heads/old", common: join(REPO, ".git") }, "request");
    ledger(null, REPO, null, LAND_DESTINATION, "refs/heads/main", { v: 1, ref: "refs/heads/main", common: join(REPO, ".git") }, "request");
    const other = ledger("kept-not-merged", REPO, runs["kept-not-merged"]!, LAND_HANDOFF, "pending", { v: 1, key: "k", ref: "refs/heads/main", old: OLD, commit: "6".repeat(40), keep: "x", folder: REPO, candidate: "5".repeat(40) }, "request");
    ledger("kept-not-merged", REPO, runs["kept-not-merged"]!, LAND_HANDOFF_SETTLED, `${other}:kept`, { v: 1 });
    const read: Record<string, unknown>[] = [];
    const prepare = store.handle.prepare.bind(store.handle);
    const spy = vi.spyOn(store.handle, "prepare").mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      return { all: (...args: unknown[]) => { const rows = (statement.all as (...a: unknown[]) => Record<string, unknown>[])(...args); read.push(...rows); return rows; } };
    }) as never);
    try {
      landedRowsOf(store, [{ rootId: "kept-not-merged", repo: REPO, resultRunId: runs["kept-not-merged"]!, assignmentState: "complete" }], git);
    } finally { spy.mockRestore(); }
    expect(read.filter(row => row["kind"] === "destination")).toHaveLength(1);
    expect(read.filter(row => row["action"] === LAND_HANDOFF).map(row => JSON.parse(String(row["detail"])).candidate)).toEqual([heads["kept-not-merged"]]);
    expect(read.filter(row => row["action"] === LAND_HANDOFF_SETTLED)).toHaveLength(1);
  });

  test("a fixed number of git reads a page: past it the rows left say nothing, and nothing said is wrong", () => {
    const many = Array.from({ length: LANDED_GIT_READS }, (_, i) => `many-${i}`);
    for (const id of many) { built(id); landed(id, heads[id]!, (i => i.toString(16).padStart(40, "a"))(many.indexOf(id))); }
    // git answers each landing's parent, so its revert check reads twice (its parent, then its change, unreadable).
    let calls = 0;
    const counted = (_cwd: string, args: readonly string[]): string | null => {
      calls += 1;
      if (args[0] === "rev-list" && args[1] === "--parents") return `${args[4]} ${OLD}`;
      return null;
    };
    const rows = many.map(id => ({ rootId: id, repo: REPO, resultRunId: runs[id]!, assignmentState: "complete" }));
    const listed = landedRowsOf(store, rows, counted);
    expect(calls).toBeLessThanOrEqual(LANDED_GIT_READS);
    expect(listed.size).toBe(LANDED_GIT_READS / 2);
    expect([...listed.keys()]).toEqual(many.slice(0, LANDED_GIT_READS / 2));
    for (const [id, words] of listed) {
      const history = landingHistoryOf(store, REPO, id, heads[id]!, counted);
      expect(words, id).toBe(history!.words.replace(/\.$/, ""));
    }
  });
});
