/**
 * An attempt refused before anything ran is no check failure of the commit (run 3332: Git couldn't read HEAD; run 3333
 * passed; the pass was stopped). This is the release gate, so the exemption is the attack surface: each row dresses a real
 * failure as that attempt, and each must stay a failure.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { gitFailureWords, proveCandidate } from "./builder.js";
import { NOTHING_STARTED_ACTION, ranNoCheck, releaseCheckStanding } from "./check-failure.js";
import { propose } from "./scope.js";
import { BUILT_IN, openStore, type Store } from "./store.js";

const T0 = new Date("2026-11-07T18:24:02.000Z");
const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };
let store: Store, taskRef: number, digest: string, leases = 0;

const attempt = (outcome: "failed" | "built", reason?: string): number => {
  const run = store.startRun({ taskRef, leaseId: `lease-${leases++}`, runner: "builder-1", branch: "b", worktree: "/w", now: T0, ...legacy });
  store.handle.prepare("UPDATE run SET scope_digest = ? WHERE id = ?").run(digest, run);
  store.finishRun(run, { outcome, ...(reason === undefined ? {} : { reason }), now: T0 });
  return run;
};
const said = (run: number, action = NOTHING_STARTED_ACTION, outcome = "refused") =>
  store.recordAction({ at: T0.toISOString(), actor: "toolroll", repo: null, taskId: "t-1", runId: run, action, outcome, source: "work", detail: "could not read the base revision" });
const refused = (): number => { const run = attempt("failed", "no-op"); said(run); return run; };
const read = (run: number): boolean => {
  const row = store.handle.prepare("SELECT r.id, r.outcome, r.reason, r.head_revision AS head, c.run AS checkRow FROM run r LEFT JOIN run_check c ON c.run = r.id WHERE r.id = ?").get(run)!;
  return ranNoCheck(store, { id: run, outcome: row["outcome"], reason: row["reason"], head: row["head"] ?? null, checkRow: row["checkRow"] ?? null });
};
const set = (run: number, column: string, value: unknown) => store.handle.prepare(`UPDATE run SET ${column} = ? WHERE id = ?`).run(value as never, run);
const insert = (sql: string, ...values: unknown[]) => store.handle.prepare(sql).run(...values as never[]);

beforeEach(() => {
  store = openStore(":memory:");
  store.handle.exec("PRAGMA foreign_keys = OFF");
  store.createTask({ id: "t-1", title: "the release" }, T0);
  taskRef = store.refFor(BUILT_IN, "t-1").id;
  digest = "d".repeat(32);
});
afterEach(() => store.close());

describe("what the gate exempts", () => {
  test("the build's own word and clean records: this is the only shape that reads as no check", () => {
    const run = refused();
    expect(read(run)).toBe(true);
  });

  test.each<[string, (run: number) => void]>([
    ["a head was recorded", run => set(run, "head_revision", "a".repeat(40))],
    ["a base was stamped: the build got past its proof", run => set(run, "base_revision", "a".repeat(40))],
    ["a commit was made", run => set(run, "committed", 1)],
    ["a provider started", run => set(run, "provider_started_at", T0.toISOString())],
    ["a session exists", run => set(run, "session_id", "s")],
    ["tokens were spent", run => set(run, "tokens_out", 5)],
    ["money was spent", run => set(run, "cost_usd", 0.01)],
    ["a check result exists", run => insert("INSERT INTO run_check (run, status, exit_code, suites_json, release, recorded_at) VALUES (?, 'failed', 1, '[]', 1, ?)", run, T0.toISOString())],
    ["a process was witnessed", run => { store.handle.exec("PRAGMA ignore_check_constraints = ON"); const columns = store.handle.prepare("SELECT name, \"notnull\" AS required FROM pragma_table_info('run_process')").all().filter(one => Number(one["required"]) === 1).map(one => String(one["name"])).filter(name => name !== "run" && name !== "id"); insert(`INSERT INTO run_process (run${columns.map(one => `, ${one}`).join("")}) VALUES (?${columns.map(() => ", 'x'").join("")})`, run); }],
    ["a note was written: a run that spoke did something", run => store.addRunNote(run, "Toolroll", "Prepared candidate checked out; no agent ran.", T0)],
    ["a check launch was stamped", run => insert("INSERT INTO check_stamp (run_id, digest, stamp, at) VALUES (?, 'x', '{}', ?)", run, T0.toISOString())],
    ["its check's facts were recorded", run => { const columns = store.handle.prepare("SELECT name, type FROM pragma_table_info('check_fact') WHERE \"notnull\" = 1 AND name <> 'run'").all();
      const fixed: Record<string, string> = { purpose: "ordinary", learn_state: "recorded" };
      insert(`INSERT INTO check_fact (run, ${columns.map(one => String(one["name"])).join(", ")}) VALUES (?${", ?".repeat(columns.length)})`, run, ...columns.map(one => fixed[String(one["name"])] ?? (/INT|REAL/i.test(String(one["type"])) ? 0 : "x"))); }],
    ["a release check attempt was sealed", run => { const columns = store.handle.prepare("SELECT name FROM pragma_table_info('release_check_attempt') WHERE \"notnull\" = 1 AND name <> 'run'").all().map(one => String(one["name"])); insert(`INSERT INTO release_check_attempt (run${columns.map(one => `, ${one}`).join("")}) VALUES (?${columns.map(one => one === "mode" ? ", 'full'" : ", 'x'").join("")})`, run); }],
  ])("%s: not exempt", (_what, tamper) => {
    const run = refused();
    tamper(run);
    expect(read(run)).toBe(false);
  });

  test.each<[string, () => number]>([
    ["no-op with no word from the build: an agent's empty result ends this way", () => attempt("failed", "no-op")],
    ["the word on another run", () => { const run = attempt("failed", "no-op"); said(run + 1000); return run; }],
    ["the word said twice", () => { const run = refused(); said(run); return run; }],
    ["another ledger action", () => { const run = attempt("failed", "no-op"); said(run, "run finished"); return run; }],
    ["the right action, another outcome", () => { const run = attempt("failed", "no-op"); said(run, NOTHING_STARTED_ACTION, "passed"); return run; }],
    ["the word on a timed-out attempt", () => { const run = attempt("failed", "timeout"); said(run); return run; }],
    ["the word on a failed check", () => { const run = attempt("failed", "agent"); said(run); return run; }],
    ["the word on a finished build", () => { const run = attempt("built"); said(run); return run; }],
  ])("%s: not exempt", (_what, make) => {
    expect(read(make())).toBe(false);
  });

  test("records it can't read excuse nothing", () => {
    const run = refused();
    store.handle.exec("DROP TABLE check_stamp");
    expect(read(run)).toBe(false);
  });
});

describe("git's words stay in the refusal", () => {
  const answer = (code: number, stderr: string) => ({ code, stdout: "", stderr, timedOut: false, notFound: false });

  test("the base revision read says why it failed; run 3332 said only that it had", async () => {
    const git = (async (_file: string, args: readonly string[]) => args.includes("rev-parse") ? answer(128, "fatal: ambiguous argument 'HEAD': unknown revision\nmore") : answer(0, "")) as never;
    expect(await proveCandidate(git, "/w", "a".repeat(40), null)).toBe("could not read the base revision in /w (fatal: ambiguous argument 'HEAD': unknown revision)");
  });

  test("the hardened runner's own refusal is kept, a secret isn't, and silence still says something", () => {
    expect(gitFailureWords(answer(128, ""))).toBe("git exited 128");
    expect(gitFailureWords({ ...answer(1, ""), timedOut: true })).toBe("git ran out of time");
    expect(gitFailureWords(answer(1, `fatal: https://x:ghp_${"a".repeat(36)}@github.com/y`))).not.toContain("ghp_");
  });

  test("a candidate that truly doesn't descend stays git's plain no", async () => {
    const git = (async (_file: string, args: readonly string[]) => args.includes("merge-base") ? answer(1, "") : answer(0, "")) as never;
    expect(await proveCandidate(git, "/w", "a".repeat(40), "b".repeat(40))).toBe(`prepared candidate aaaaaaa does not descend from this task's base bbbbbbb`);
  });
});

describe("the release's standing", () => {
  const passed = (): number => {
    const run = attempt("built");
    insert("INSERT INTO run_check (run, status, exit_code, suites_json, release, recorded_at) VALUES (?, 'passed', 0, '[]', 1, ?)", run, T0.toISOString());
    return run;
  };
  test("a refused attempt doesn't stand against a pass; a failed attempt dressed the same way does", () => {
    refused();
    const first = passed();
    attempt("failed", "no-op");
    const later = passed();
    // Filed after the runs: a run under a plan needs a whole agent route, which isn't what this is about.
    propose(store, { taskId: "t-1", goal: "the goal", touches: [], acceptance: [], now: T0 });
    expect(releaseCheckStanding(store, "/ev", { taskId: "t-1", run: first })).toMatchObject({ ok: true, earlier: [] });
    expect(releaseCheckStanding(store, "/ev", { taskId: "t-1", run: later })).toMatchObject({ ok: false, why: expect.stringContaining("an earlier check of this commit") });
  });
});
