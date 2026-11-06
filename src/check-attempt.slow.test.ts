/**
 * A Full check of a prepared candidate through the real builder (docs/plans/release-once.md, phase A): the attempt row
 * is sealed BEFORE the command runs, the handshake goes on the command's stdin, and the check's report and inventory
 * are sealed after it, beside the ordinary receipt.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowWhereUnfenced } from "./unfenced-test-support.js";
import { build, type Runner } from "./builder.js";
import { openStore, checkAttemptOf, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { addApprover, approve, propose } from "./scope.js";
import { run } from "./exec.js";
import { CHECK_INVENTORY_CAPTURE, CHECK_REPORT_CAPTURE, readSealedJson } from "./check-report.js";
import { setProjectCheckLevel } from "./check-levels.js";
import { checkFactOf, checkResultsOf } from "./check-facts.js";
import { watchObservation } from "./flaky.js";
import { CHECK_LOAD_CAPTURE, readCheckLoad } from "./check-load.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-10-25T10:00:00.000Z");

describe("a prepared candidate's Full check carries the handshake", () => {
  let wt = "", store: Store, token = "";
  beforeEach(() => { wt = realpathSync(mkdtempSync(join(tmpdir(), "so-attempt-wt-"))); });
  const repos: string[] = [];
  afterEach(() => { store?.close(); rmSync(wt, { recursive: true, force: true }); for (const one of repos.splice(0)) rmSync(one, { recursive: true, force: true }); });

  /** A project on main, a prepared candidate, an approved scope, a claimed builder and a started run, as a release has. */
  function prepared() {
    // The project is its own checkout on main; the build runs in a linked worktree of it, and the plane reads the
    // verified tree from the project's own .git.
    const REPO = realpathSync(mkdtempSync(join(tmpdir(), "so-attempt-repo-")));
    const sh = (...args: string[]) => execFileSync("git", ["-C", REPO, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { encoding: "utf8" }).trim();
    sh("init", "-q", "-b", "main");
    // The builder commits in the linked worktree: the repository's own identity, as CI has no global one.
    sh("config", "user.name", "t"); sh("config", "user.email", "t@x");
    writeFileSync(join(REPO, ".gitignore"), ".evidence/\n");
    writeFileSync(join(REPO, "README.md"), "base\n");
    sh("add", "."); sh("commit", "-q", "-m", "base"); const base = sh("rev-parse", "HEAD");
    sh("checkout", "-q", "-b", "prepared");
    mkdirSync(join(REPO, "src"), { recursive: true }); writeFileSync(join(REPO, "src", "a.test.ts"), "x\n");
    sh("add", "."); sh("commit", "-q", "-m", "candidate"); const candidate = sh("rev-parse", "HEAD");
    sh("checkout", "-q", "main");
    rmSync(wt, { recursive: true, force: true });
    sh("worktree", "add", "-q", "-b", "feat/a", wt, base);
    repos.push(REPO);
    store = allowWhereUnfenced(openStore(":memory:"));
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("approver");
    token = added.token;
    store.createTask({ id: "t-1", title: "Release" }, T0);
    const taskRef = store.refFor("built-in", "t-1").id;
    register(store, { name: "builder-1", host: "h", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-builder-1" });
    store.placeTask(taskRef, REPO);
    store.saveWorktree({ path: wt, repo: REPO, branch: "feat/a", runner: "builder-1", taskRef, createdAt: T0.toISOString(), leasedAt: T0.toISOString(), releasedAt: null, verified: true });
    propose(store, { taskId: "t-1", goal: "Check the exact prepared commit", candidate, now: T0 });
    approve(store, "t-1", "alex", T0, store.getScope("t-1")!.digest, token);
    const claimed = acquire(store, taskRef, "builder-1", { token: "tok-builder-1", now: T0, ttlMs: 60 * 60_000, newLeaseId: () => "test-lease" });
    expect(claimed, JSON.stringify(claimed)).toMatchObject({ ok: true });
    store.setVerifyCommand({ repo: REPO, command: "release-check", timeoutMs: 5_000, approvedBy: "alex" }, T0);
    setProjectCheckLevel(store, REPO, "full", "alex", T0);
    const authority = store.routeAuthorityFor(taskRef, "builder");
    if (!authority?.ok) throw new Error("route");
    const runId = store.startRun({ taskRef, leaseId: "test-lease", runner: "builder-1", branch: "feat/a", worktree: wt, route: authority.stamp, now: T0 });
    return { REPO, taskRef, runId };
  }

  test("the attempt is sealed before the command, the nonce rides on stdin, and the report is sealed after", async () => {
    const { REPO, taskRef, runId } = prepared();
    // A tracked identity (learning loops): asked about on its own handshake field.
    watchObservation(store, { repo: REPO, identity: "unit:src/a.test.ts::adds", observation: 1, now: T0 });

    let seenAttempt: ReturnType<typeof checkAttemptOf> = null;
    let seenStdin: string | undefined;
    const verify: Runner = async (_file, _args, options) => {
      // The row exists before the command does anything; the handshake is on stdin and nowhere else.
      seenAttempt = checkAttemptOf(store, runId);
      seenStdin = options?.stdin;
      const handshake = JSON.parse(options?.stdin ?? "{}") as { nonce: string; mode: string };
      expect(JSON.stringify(options?.env ?? {})).not.toContain(handshake.nonce);
      const report = { version: 1, nonce: handshake.nonce, mode: handshake.mode, planDigest: null, exitCode: 0, parts: [], units: null, journeys: [], upgrades: null };
      const learned = `TOOLROLL-LEARN ${JSON.stringify({ nonce: handshake.nonce, results: [{ identity: "unit:src/a.test.ts::adds", state: "passed" }] })}`;
      return { ...OK, stdout: `checks passed\n${learned}\nTOOLROLL_CHECK_REPORT ${JSON.stringify(report)}\n` };
    };
    const actualGit: Runner = async (file, args, options) => run(file, args, options);
    const result = await build(store, { taskId: "t-1", taskRef, runner: "builder-1", worktree: wt, runId, evidenceRoot: join(wt, ".evidence"), branch: "feat/a", now: T0,
      agent: (async () => OK) as Runner, git: actualGit, verify });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(seenAttempt).toMatchObject({ run: runId, mode: "full" });
    expect(JSON.parse(seenStdin!)).toMatchObject({ mode: "full", plan: null, watch: [], learn: ["unit:src/a.test.ts::adds"] });
    // Its facts, recorded at disposition beside the check's own outcome (learning loops, slice 1).
    expect(checkFactOf(store, runId)).toMatchObject({ repo: REPO, tree: expect.stringMatching(/^[0-9a-f]{40}$/), learnState: "recorded",
      conditionsDigest: expect.stringMatching(/^[0-9a-f]{64}$/), conditionsClass: `${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}` });
    expect(checkResultsOf(store, runId)).toEqual(expect.arrayContaining([{ identity: "check", state: "passed", source: "receipt" }, { identity: "unit:src/a.test.ts::adds", state: "passed", source: "learn" }]));
    expect(readSealedJson(store, join(wt, ".evidence"), runId, CHECK_REPORT_CAPTURE)).not.toBeNull();
    expect(readSealedJson(store, join(wt, ".evidence"), runId, CHECK_INVENTORY_CAPTURE)!.value).toMatchObject({ sealed: { units: ["src/a.test.ts"] } });
  });

  // A busy machine (check-load.ts): the plane measures the load itself, gives the check time in proportion to the budget
  // it lost (bounded), tells it on the handshake, and seals its own load record beside the receipt.
  test.each([
    ["a busy machine (load 18.9 on 24 cores): twice the approved limit", 18.9, 10_000],
    ["a quiet machine (load 2 on 24 cores): the approved limit", 2, 5_000],
  ] as const)("%s", async (_name, load, limitMs) => {
    const { taskRef, runId } = prepared();
    let seenTimeout: number | undefined, seenLimit: number | undefined;
    const verify: Runner = async (_file, _args, options) => {
      seenTimeout = options?.timeoutMs;
      const handshake = JSON.parse(options?.stdin ?? "{}") as { nonce: string; mode: string; limitMs: number };
      seenLimit = handshake.limitMs;
      const report = { version: 1, nonce: handshake.nonce, mode: handshake.mode, planDigest: null, exitCode: 0, parts: [], units: null, journeys: [], upgrades: null };
      return { ...OK, stdout: `TOOLROLL_CHECK_REPORT ${JSON.stringify(report)}\n` };
    };
    const result = await build(store, { taskId: "t-1", taskRef, runner: "builder-1", worktree: wt, runId, evidenceRoot: join(wt, ".evidence"), branch: "feat/a", now: T0,
      agent: (async () => OK) as Runner, git: (async (file, args, options) => run(file, args, options)) as Runner, verify, machine: () => ({ cores: 24, load }) });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(seenTimeout).toBe(limitMs);
    expect(seenLimit).toBe(limitMs);
    const record = readCheckLoad(readSealedJson(store, join(wt, ".evidence"), runId, CHECK_LOAD_CAPTURE)?.value);
    expect(record).toMatchObject({ version: 1, cores: 24, grantMs: 5_000, limitMs, samples: [{ atMs: 0, load }], elapsedMs: expect.any(Number) });
    expect(record!.why).toMatch(limitMs > 5_000 ? /extended to/ : /^the approved/);
  });
});
