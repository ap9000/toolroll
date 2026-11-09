/** `task accept` names what it means (docs/plans/plain-toolroll.md P1.1): one contract table. Bare refuses for good;
 * `--despite "<reason>"` (with `--note` as its alias) is acceptance only and never completes; `--finish` and `--digest`
 * are exactly `task complete`'s exact-receipt completion, where `--json` and a scoped credential must pass `--digest`;
 * `--despite` with either of them refuses. Real CLI over a throwaway database. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { runOperate, EXIT } from "./operate.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { recordRunCheckLevel } from "./check-levels.js";
import { assignmentOf } from "./assignment.js";
import { mintCoordinator } from "./coordinator.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const REPO = "/repo/task-accept";
const HEAD = "c".repeat(40);
let dir = "", db = "", store: Store, lines: string[] = [], password = "";

const run = (argv: string[]) => {
  const [command = "", ...rest] = argv;
  lines = [];
  return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now: NOW });
};
const payload = () => JSON.parse(lines.join("\n")) as Record<string, unknown>;
const root = () => join(dir, "evidence");
const state = (id: string) => assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, root())?.state;
const receipt = (id: string) => assignmentOf(store, id, NOW, { principal: "operator", repos: [REPO] }, root())!.receipt!.digest;
const accepted = (run: number) => store.proofAcceptance(run) !== null;

/** A finished, checked build of `id`, ready for a person to accept. */
function built(id: string): number {
  store.createTask({ id, title: id }, NOW);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, REPO, {}, NOW);
  const proposed = propose(store, { taskId: id, goal: `Do ${id}`, touches: ["src/a.ts"], acceptance: [{ id: "c1", statement: "it works", how: null, evidence: ["check"] }], now: NOW });
  const ok = approve(store, id, "alex", NOW, proposed.digest, password);
  if (!ok.ok) throw new Error(ok.reason);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "r", branch: `b-${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: NOW });
  store.stampRun(runId, { scopeDigest: store.getScope(id)!.digest, baseRevision: "1".repeat(40) });
  store.recordOutcomeFacts(runId, { headRevision: HEAD, handoff: "Done." });
  store.finishRun(runId, { outcome: "built", committed: true, now: NOW });
  store.setTaskState(id, "done", NOW);
  recordRunCheckLevel(store, { id: runId, taskId: id, repo: REPO }, "full", "project", NOW);
  store.saveProofVerdict(runId, "verified", [], NOW, [{ id: "c1", statement: "it works", requiredEvidence: ["check"], state: "pass", detail: [], answered: [{ kind: "check", ref: "true" }], review: null }] as never, "verified");
  storeEvidence(store, root(), runId, "terminal-diff", "diff.patch", Buffer.from("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n"), "git diff (exit 0)", NOW, { captureStatus: "ok" });
  storeEvidence(store, root(), runId, "check-log", "checks.txt", Buffer.from("1 passed\n"), "true", NOW, { captureStatus: "ok" });
  sealVerificationReceipt(store, root(), runId, HEAD, store.liveVerifyCommand(REPO)!, { configured: true, ran: true, exitCode: 0 }, NOW);
  store.recordRunCheck(runId, { status: "passed", exitCode: 0, suites: [] }, NOW);
  return runId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-task-accept-"));
  db = join(dir, "orders.db");
  store = openStore(db);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  password = alex.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
  store.setVerifyCommand({ repo: REPO, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
});
afterEach(() => {
  vi.unstubAllEnvs();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const as = () => ["--as", "alex", "--token", password];

describe("task accept: what each call means", () => {
  test("the contract table", async () => {
    type Row = { argv: (id: string) => string[]; code: number; reason?: string; completes: boolean; accepts: boolean };
    const rows: Record<string, Row> = {
      "bare refuses, naming --finish and --despite": { argv: id => ["task", "accept", id, ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--note is --despite: acceptance only": { argv: id => ["task", "accept", id, "--note", "Looked at it myself", ...as(), "--json"], code: EXIT.ok, completes: false, accepts: true },
      "--despite records the acceptance and never completes": { argv: id => ["task", "accept", id, "--despite", "Looked at it myself", ...as(), "--json"], code: EXIT.ok, completes: false, accepts: true },
      "an empty --despite reason refuses": { argv: id => ["task", "accept", id, "--despite", " ", ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--despite with --finish refuses": { argv: id => ["task", "accept", id, "--despite", "why", "--finish", ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--despite with --digest refuses": { argv: id => ["task", "accept", id, "--despite", "why", "--digest", receipt(id), ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--note with --finish refuses": { argv: id => ["task", "accept", id, "--note", "why", "--finish", ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--finish under --json without --digest refuses": { argv: id => ["task", "accept", id, "--finish", ...as(), "--json"], code: EXIT.usage, reason: "usage", completes: false, accepts: false },
      "--finish at a person's terminal completes the exact receipt": { argv: id => ["task", "accept", id, "--finish", ...as()], code: EXIT.ok, completes: true, accepts: false },
      "--digest completes exactly that receipt": { argv: id => ["task", "accept", id, "--digest", receipt(id), ...as(), "--json"], code: EXIT.ok, completes: true, accepts: false },
      "--finish --digest completes exactly that receipt": { argv: id => ["task", "accept", id, "--finish", "--digest", receipt(id), ...as(), "--json"], code: EXIT.ok, completes: true, accepts: false },
      "a --digest that isn't the receipt refuses": { argv: id => ["task", "accept", id, "--digest", "f".repeat(64), ...as(), "--json"], code: EXIT.refused, completes: false, accepts: false },
    };
    let n = 0;
    for (const [name, row] of Object.entries(rows)) {
      const id = `t-${++n}`;
      const runId = built(id);
      const code = await run(row.argv(id));
      expect(code, name).toBe(row.code);
      if (row.reason !== undefined) expect(payload()["reason"], name).toBe(row.reason);
      expect(state(id) === "complete", `${name}: completes`).toBe(row.completes);
      expect(accepted(runId), `${name}: accepts`).toBe(row.accepts);
    }
  });

  test("bare says what each flag means", async () => {
    built("t-bare");
    await run(["task", "accept", "t-bare", ...as()]);
    expect(lines.join("\n")).toMatch(/--finish[\s\S]*--despite/);
  });

  test("a scoped credential completes only with --digest, as task complete does", async () => {
    built("t-lead");
    const minted = mintCoordinator(store, { name: "lead", repos: [REPO], by: "alex", now: new Date() });
    if (!minted.ok) throw new Error(minted.reason);
    vi.stubEnv("SO_TEST_LEAD", minted.token);
    expect(await run(["assignment", "claim", "t-lead", "--token-env", "SO_TEST_LEAD", "--json"]), lines.join("\n")).toBe(EXIT.ok);
    expect(await run(["task", "accept", "t-lead", "--finish", "--token-env", "SO_TEST_LEAD"])).toBe(EXIT.usage);
    expect(state("t-lead")).not.toBe("complete");
    expect(await run(["task", "accept", "t-lead", "--digest", receipt("t-lead"), "--token-env", "SO_TEST_LEAD", "--json"]), lines.join("\n")).toBe(EXIT.ok);
    expect(payload()["command"]).toBe("task accept");
    expect(state("t-lead")).toBe("complete");
  });
});
