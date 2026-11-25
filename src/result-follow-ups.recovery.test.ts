/** CH1a direct-road admission only. Recording runners do not prove native fences or stop custody. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import * as followUps from "./result-follow-ups.js";
import { CHECK_RECOVERY_HELD, checkRequestDigest, representCheckHoldDetail, readCheckRecoveryHoldsForRun } from "./check-recovery-hold.js";
import { requestFollowUpChecks, runFollowUpCheck, runWaitingChecks, waitingCheckRequests, FOLLOW_UP_RECEIPT, FOLLOW_UP_LOG } from "./result-follow-ups.js";
import { readVerifiedArtifact } from "./evidence.js";
import { runOperate, EXIT } from "./operate.js";

// Only bypass unrelated native fence construction: actual Store/ledger/reproof/command boundaries run below.
vi.mock("./invoke.js", async original => ({ ...await original<typeof import("./invoke.js")>(),
  checkoutRunner: (_store: unknown, _repo: unknown, _checkout: unknown, inner: unknown) => inner,
}));
const now = new Date("2026-11-20T00:00:00Z"), head = "a".repeat(40);
let store: Store, root: string, repo: string, databaseFile: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "so-check-held-")); repo = join(root, "repo"); databaseFile = join(root, "orders.db");
  store = openStore(databaseFile);
  store.setVerifyCommand({ repo, command: "synthetic-check", timeoutMs: 1000, approvedBy: "fixture" }, now);
  store.setWorktreeSetup({ repo, command: "synthetic-setup", timeoutMs: 1000, approvedBy: "fixture" }, now);
});
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true }); });
function built(name: string) {
  store.createTask({ id: name, title: name }, now); const ref = store.refFor("built-in", name).id;
  store.handle.prepare("UPDATE task_ref SET repo = ? WHERE id = ?").run(repo, ref);
  const run = Number(store.handle.prepare("INSERT INTO run(task_ref,lease_id,runner,role,branch,worktree,started_at,finished_at,outcome,head_revision) VALUES (?,?,'fixture','builder','synthetic','/synthetic',?,?,'built',?)")
    .run(ref, name, now.toISOString(), now.toISOString(), head).lastInsertRowid);
  return { name, ref, run };
}
function ask(t: ReturnType<typeof built>) {
  const asked = requestFollowUpChecks(store, { runId: t.run, level: "full", actor: "fixture" }, now);
  if (!asked.ok) throw new Error(asked.message); return asked.request;
}
function hold(t: ReturnType<typeof built>, request: number) {
  const q = store.handle.prepare("SELECT * FROM action_ledger WHERE id = ?").get(request)!;
  const digest = checkRequestDigest({ id: request, repo: q["repo"], runId: q["run_id"], taskId: q["task_id"], action: q["action"], outcome: q["outcome"], detail: q["detail"] });
  if (digest === null) throw new Error("fixture digest");
  store.recordAction({ at: now.toISOString(), actor: "toolroll", repo, taskId: t.name, runId: t.run, action: CHECK_RECOVERY_HELD,
    outcome: String(request), source: "work", detail: representCheckHoldDetail({ v: 1, q: digest, g: "b".repeat(32), r: t.ref })! });
}
const ok = { code: 0, stdout: "observed synthetic output", stderr: "", notFound: false, timedOut: false };
const actionCount = (action: string) => Number(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE action = ?").get(action)!["n"]);
function noOutcome(run: number) {
  expect(actionCount("checks finished")).toBe(0);
  expect(store.artifactsFor(run).filter(a => a.capture === FOLLOW_UP_RECEIPT)).toEqual([]);
}

describe("CH1a direct check recovery hold", () => {
  it("refuses held request, direct execution and waiting selection without starts/finishes/exec", async () => {
    const t = built("held"), q = ask(t); hold(t, q);
    const git = vi.fn(async () => ok), runner = vi.fn(async () => ok);
    expect(requestFollowUpChecks(store, { runId: t.run, level: "full", actor: "other" }, now)).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(waitingCheckRequests(store, now)).toEqual([]);
    expect(await runWaitingChecks(store, root, { now: () => now, git, runner })).toBe(0);
    expect(await runFollowUpCheck(store, root, q, { now: () => now, git, runner })).toMatchObject({ state: "recovery-held", priorExecution: "unverified" });
    expect(git).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled(); expect(actionCount("checks started")).toBe(0); noOutcome(t.run);
  });
  it("reproves cached wanted state in the start claim transaction", async () => {
    const t = built("cached"), q = ask(t), original = store.transact.bind(store);
    vi.spyOn(store, "transact").mockImplementationOnce(body => original(() => { hold(t, q); return body(); }));
    const git = vi.fn(async () => ok), runner = vi.fn(async () => ok);
    expect(await runFollowUpCheck(store, root, q, { now: () => now, git, runner })).toMatchObject({ state: "recovery-held" });
    expect(actionCount("checks started")).toBe(0); expect(git).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled(); noOutcome(t.run);
  });
  it("holds after claim before checkout, without issuing cleanup for an uncreated checkout", async () => {
    const t = built("before-checkout"), q = ask(t), original = store.recordAction.bind(store);
    vi.spyOn(store, "recordAction").mockImplementation(entry => { const id = original(entry); if (entry.action === "checks started") hold(t, q); return id; });
    const git = vi.fn(async () => ok), runner = vi.fn(async () => ok);
    expect(await runFollowUpCheck(store, root, q, { now: () => now, git, runner })).toMatchObject({ state: "recovery-held" });
    expect(actionCount("checks started")).toBe(1); expect(git).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled(); noOutcome(t.run);
  });
  it("holds between checkout and setup; only exact owned cleanup remains", async () => {
    const t = built("before-setup"), q = ask(t);
    const git = vi.fn(async (_file, args: readonly string[]) => { if (args.includes("add")) hold(t, q); return ok; }), runner = vi.fn(async () => ok);
    expect(await runFollowUpCheck(store, root, q, { now: () => now, git, runner })).toMatchObject({ state: "recovery-held" });
    expect(runner).not.toHaveBeenCalled(); expect(git.mock.calls.map(c => c[1].includes("remove") ? "owned-cleanup" : "checkout")).toEqual(["checkout", "owned-cleanup"]); noOutcome(t.run);
  });
  it("holds after setup before check and retains observed setup output without a receipt", async () => {
    const t = built("before-check"), q = ask(t), git = vi.fn(async () => ok), runner = vi.fn(async () => { hold(t, q); return ok; });
    const result = await runFollowUpCheck(store, root, q, { now: () => now, git, runner });
    expect(result).toMatchObject({ state: "recovery-held" }); expect(runner).toHaveBeenCalledTimes(1); noOutcome(t.run);
    expect(store.artifactsFor(t.run).some(a => a.capture === FOLLOW_UP_LOG)).toBe(true);
  });
  it("preserves observed failed check evidence when hold arrives during the command", async () => {
    const t = built("during-check"), q = ask(t), git = vi.fn(async () => ok);
    const runner = vi.fn(async () => { if (runner.mock.calls.length === 2) { hold(t, q); return { ...ok, code: 7, stdout: "actual failed command exit" }; } return ok; });
    expect(await runFollowUpCheck(store, root, q, { now: () => now, git, runner })).toMatchObject({ state: "recovery-held" });
    expect(runner).toHaveBeenCalledTimes(2); noOutcome(t.run);
    const artifact = store.artifactsFor(t.run).find(a => a.capture === FOLLOW_UP_LOG)!;
    const saved = readVerifiedArtifact(root, artifact);
    expect(saved.ok).toBe(true);
    if (saved.ok) { expect(saved.content.toString()).toContain("exit 7"); expect(saved.content.toString()).toContain("actual failed command exit"); }
  });
  it("does not count a cached request held before start as settled work", async () => {
    const t = built("count"), q = ask(t); let calls = 0;
    const clock = () => { if (++calls === 2) hold(t, q); return now; };
    const runner = vi.fn(async () => ok), git = vi.fn(async () => ok);
    expect(await runWaitingChecks(store, root, { now: clock, runner, git })).toBe(0); expect(runner).not.toHaveBeenCalled(); expect(git).not.toHaveBeenCalled(); noOutcome(t.run);
  });
  it("cannot bypass a held ancestor by requesting checks on a replacement", () => {
    const a = built("old"), b = built("replacement"), q = ask(a); hold(a, q);
    store.handle.prepare("INSERT INTO task_replacement(task_ref,successor,at) VALUES (?,?,?)").run(a.ref, b.name, now.toISOString());
    expect(requestFollowUpChecks(store, { runId: b.run, level: "full", actor: "fixture" }, now)).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(actionCount("checks requested")).toBe(1);
  });
  it("keeps no-event checks working and seals their real passing result", async () => {
    const t = built("personal"), q = ask(t), git = vi.fn(async () => ok), runner = vi.fn(async () => ok);
    expect(await runFollowUpCheck(store, root, q, { now: () => now, git, runner })).toMatchObject({ state: "passed", exitCode: 0 });
    expect(runner).toHaveBeenCalledTimes(2); expect(actionCount("checks started")).toBe(1); expect(actionCount("checks finished")).toBe(1);
    expect(store.artifactsFor(t.run).some(a => a.capture === FOLLOW_UP_RECEIPT)).toBe(true);
  });
  it("returns an explicit CLI refusal instead of queued or did-not-run", async () => {
    const t = built("cli-held"), q = ask(t); hold(t, q); const lines: string[] = [];
    expect(await runOperate("task", ["checks", t.name, "--json"], line => lines.push(line), { databaseFile, now })).toBe(EXIT.refused);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, reason: "recovery-held" }); expect(lines.join("\n")).not.toContain("queued"); expect(lines.join("\n")).not.toContain("didn't run"); noOutcome(t.run);
  });
  it("propagates a late held execution result through the CLI as refused", async () => {
    const t = built("cli-late"), q = ask(t);
    let control: followUps.RecoveryHeldCheck | undefined;
    expect(() => store.transact(() => {
      hold(t, q);
      const historical = followUps.followUpChecksOf(store, t.run, now)[0]!;
      control = { ...historical, state: "recovery-held", priorState: historical.state, priorExecution: "unverified",
        recovery: readCheckRecoveryHoldsForRun(store, t.run), note: "Checks are on hold after recovery. Earlier execution is unverified." };
      throw new Error("synthetic control only");
    })).toThrow("synthetic control only");
    // Contract seam only: request still succeeds; the async executor then reports the hold.
    vi.spyOn(followUps, "runFollowUpCheck").mockResolvedValueOnce(control!);
    const lines: string[] = [];
    expect(await runOperate("task", ["checks", t.name, "--json"], line => lines.push(line), { databaseFile, now })).toBe(EXIT.refused);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(lines.join("\n")).not.toContain("queued"); expect(lines.join("\n")).not.toContain("didn't run"); noOutcome(t.run);
  });

  it("keeps observed exit/output when the final transaction first discovers the hold", async () => {
    const t = built("final-boundary"), q = ask(t), git = vi.fn(async () => ok);
    const runner = vi.fn(async () => ({ ...ok, stdout: "actual successful command output" }));
    const original = store.transact.bind(store); let inserted = false;
    vi.spyOn(store, "transact").mockImplementation(body => original(() => {
      if (runner.mock.calls.length === 2 && !inserted) { inserted = true; hold(t, q); }
      return body();
    }));
    const result = await runFollowUpCheck(store, root, q, { now: () => now, git, runner });
    expect(inserted).toBe(true); expect(result).toMatchObject({ state: "recovery-held", priorExecution: "unverified" });
    expect(result?.logArtifactId).not.toBeNull(); expect(runner).toHaveBeenCalledTimes(2); noOutcome(t.run);
    const artifact = store.getArtifact(result!.logArtifactId!)!;
    expect(artifact.capture).toBe(FOLLOW_UP_LOG);
    const saved = readVerifiedArtifact(root, artifact); expect(saved.ok).toBe(true);
    if (saved.ok) { expect(saved.content.toString()).toContain("exit 0"); expect(saved.content.toString()).toContain("actual successful command output"); }
  });

});
