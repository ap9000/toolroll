/**
 * A flow card acts outside exactly once, however many passes advance its project: the service's worker, a helper
 * watch on the same repo and the console's settle each open their own handle on one database. A card ready to file
 * and a card that couldn't file (tried again) each file one task, a Pull request zone owes one pull request, and a
 * check zone runs its script once for the card's visit — in three real processes at once, and with every pass
 * reading the card before any of them acts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";
import { register } from "./runner.js";
import { run as exec, type ExecResult } from "./exec.js";
import type { Runner } from "./backend.js";
import { publishPass, type PublishExec } from "./publish.js";
import { checkPublishing, savePublishing } from "./pull-request-flow.js";
import { flowFromSteps, validateFlowDefinition } from "./flows.js";
import { advanceFlows } from "./flow-engine.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { saveScript } from "./flow-scripts.js";

const T0 = new Date("2026-09-30T23:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const HEAD = "a".repeat(40);
const OK: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

let dir: string, repo: string, file: string, store: Store, token: string;
const others: Store[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-once-")));
  repo = join(dir, "site");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "Site\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"]);
  file = join(dir, "orders.db");
  store = openStore(file);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("approver");
  token = alex.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", T0);
});
afterEach(() => {
  for (const other of others.splice(0)) other.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Nightly journeys: a card in its Research zone files a report. */
function researchFlow(): number {
  return store.createFlow({ repo, name: "Nightly journeys", by: "alex", definitionJson: JSON.stringify(validateFlowDefinition({ version: 1, start: "nightly-journeys", stages: [
    { id: "nightly-journeys", title: "Nightly journeys", kind: "inbox", next: "research" },
    { id: "research", title: "Research", kind: "report", instructions: "Find the cause of tonight's failed journeys.", next: "done" },
    { id: "done", title: "Done", kind: "done" },
  ] })) }, T0);
}

/** A ready card, and a card that couldn't file its work once (the backlog was full) and now tries again. */
function readyAndStuck(): { ready: number; stuck: number } {
  const flow = researchFlow();
  const stuck = store.addFlowCard({ flow, title: "Nightly journeys, 29 September", description: null, stage: "research", by: "alex", byKind: "person" }, T0);
  const full = vi.spyOn(store, "createConsoleTask").mockReturnValue({ ok: false, reason: "backlog-full" });
  expect(advanceFlows(store, repo, T0).filed).toEqual([]);
  full.mockRestore();
  expect(store.getFlowCard(stuck)).toMatchObject({ task: null, waiting: expect.stringMatching(/^Couldn't file the work: the backlog is full/) });
  const ready = store.addFlowCard({ flow, title: "Nightly journeys, 30 September", description: null, stage: "research", by: "alex", byKind: "person" }, T0);
  return { ready, stuck };
}

/** A check zone whose script takes a moment, so passes overlap while it runs. */
function checkCard(): number {
  expect(saveScript(store, repo, { name: "journeys", about: "Runs the journeys", body: "sleep 1\necho \"checked $FLOW_CARD_TITLE\"" }, "alex", T0)).toMatchObject({ ok: true });
  const flow = store.createFlow({ repo, name: "Check it", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Journeys", kind: "check", script: "journeys" }, { title: "Inbox", kind: "inbox" }], null)) }, T0);
  return store.addFlowCard({ flow, title: "Checkout journey", description: null, stage: "journeys", by: "alex", byKind: "person" }, T0);
}

/** A card whose build is Ready (checked, on its branch) sitting in a Pull request zone, with pull requests set up. */
async function pullRequestCard(): Promise<{ card: number; runId: number }> {
  register(store, { name: "worker-1", host: "test", capacity: 4, repos: [repo], now: T0, newToken: () => "tok-worker-1" });
  store.setVerifyCommand({ repo, command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, T0);
  const setup: PublishExec = async (bin, args) => {
    const line = [bin, ...args].join(" ");
    if (line.startsWith("git remote get-url origin")) return { ...OK, stdout: "git@github.com:alex/site.git\n" };
    if (line.startsWith("gh repo view alex/site")) return { ...OK, stdout: JSON.stringify({ nameWithOwner: "alex/site", defaultBranchRef: { name: "main" }, viewerPermission: "WRITE" }) };
    if (line.startsWith("gh api user")) return { ...OK, stdout: "alex\n" };
    return OK;
  };
  const checked = await checkPublishing(repo, { exec: setup });
  if (!checked.ok) throw new Error(checked.message);
  savePublishing(store, checked.plan, "alex", {}, T0);
  const taskId = "fix-checkout";
  store.createTask({ id: taskId, title: "Fix the checkout journey" }, T0);
  store.placeTask(store.refFor("built-in", taskId).id, repo, {}, T0);
  propose(store, { taskId, goal: "Fix the checkout journey", touches: ["src/checkout.ts"], acceptance: [{ id: "c1", statement: "Checkout works.", how: null, evidence: ["check"] }], now: T0 });
  const approved = approve(store, taskId, "alex", T0, store.getScope(taskId)!.digest, token);
  if (!approved.ok) throw new Error(JSON.stringify(approved));
  const ref = store.lookupRef(taskId)!.id;
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route fixture");
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${taskId}`, runner: "worker-1", branch: `toolroll/${taskId}`, worktree: `/pool/${taskId}`, route: authority.stamp, now: T0 });
  store.stampRun(runId, { scopeDigest: store.getScope(taskId)!.digest, baseRevision: "b".repeat(40) });
  store.recordOutcomeFacts(runId, { headRevision: HEAD, handoff: "The checkout journey passes." });
  store.finishRun(runId, { outcome: "built", committed: true, now: T0 });
  store.setTaskState(taskId, "done", T0);
  storeEvidence(store, dir, runId, "terminal-diff", "diff.patch", Buffer.from("--- a/src/checkout.ts\n+++ b/src/checkout.ts\n"), "git diff (exit 0)", T0, { captureStatus: "ok" });
  storeEvidence(store, dir, runId, "check-log", "checks.txt", Buffer.from("1 test passed"), "npm test", T0, { captureStatus: "ok" });
  sealVerificationReceipt(store, dir, runId, HEAD, store.liveVerifyCommand(repo)!, { configured: true, ran: true, exitCode: 0 }, T0);
  const flow = store.createFlow({ repo, name: "Ship it", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Build", kind: "task" }, { title: "Pull request", kind: "pull-request" }], null)) }, T0);
  const card = store.addFlowCard({ flow, title: "Checkout journey fails", description: null, stage: "pull-request", by: "alex", byKind: "person" }, T0);
  store.updateFlowCard(card, { task: taskId, primaryTask: taskId }, T0);
  return { card, runId };
}

const researchTasks = () => store.handle.prepare("SELECT COUNT(*) AS n FROM task WHERE title LIKE 'Research: Nightly journeys%'").get()!["n"];
const follows = () => store.handle.prepare("SELECT COUNT(*) AS n FROM pull_request_follow").get()!["n"];

/** One worker's pass in its own process: advance the project's flows, then run its steps, as the worker does. */
const PASS = `
const env = JSON.parse(process.env.FLOW_ONCE);
const { existsSync, writeFileSync } = await import("node:fs");
const { openStore } = await import(env.modules.store);
const { advanceFlows } = await import(env.modules.engine);
const { runFlowSteps } = await import(env.modules.steps);
const { run } = await import(env.modules.exec);
const store = openStore(env.file);
writeFileSync(env.ready, "");
while (!existsSync(env.go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
const now = new Date(env.now);
const advanced = advanceFlows(store, env.repo, now);
let scripts = 0;
const shell = async (bin, args, options) => { scripts++; return run(bin, args, options); };
const gh = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false });
const steps = await runFlowSteps(store, env.repo, now, { gh, git: run, shell, fetch, dir: env.dir, scratch: env.scratch, base: "main", evidenceRoot: env.dir });
store.close();
process.stdout.write(JSON.stringify({ filed: advanced.filed, problems: [...advanced.problems, ...steps.problems], scripts }));
`;
const moduleUrl = (name: string) => new URL(`./${name}.ts`, import.meta.url).href;

/** Three processes, each with its own handle on the database, start their passes together. */
async function threeProcesses(now: Date): Promise<{ filed: string[]; problems: string[]; scripts: number }[]> {
  const go = join(dir, "go");
  const passes = [1, 2, 3].map(n => {
    const ready = join(dir, `ready-${n}`);
    const env = { file, repo, dir, scratch: join(dir, "scratch"), now: now.toISOString(), ready, go,
      modules: { store: moduleUrl("store"), engine: moduleUrl("flow-engine"), steps: moduleUrl("flow-steps"), exec: moduleUrl("exec") } };
    const done = new Promise<{ filed: string[]; problems: string[]; scripts: number }>((resolve, reject) => {
      execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", PASS], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, FLOW_ONCE: JSON.stringify(env) }, timeout: 60_000 },
        (error, stdout, stderr) => error === null ? resolve(JSON.parse(stdout)) : reject(new Error(`${error.message}\n${stderr}`)));
    });
    return { ready, done };
  });
  const started = Date.now();
  while (!passes.every(one => existsSync(one.ready))) {
    if (Date.now() - started > 50_000) throw new Error("the passes never started");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  writeFileSync(go, "");
  return Promise.all(passes.map(one => one.done));
}

describe("three processes advancing one project's flows at once", () => {
  test("c1 c2: a ready card and a stuck card each file one task, the Pull request zone owes one pull request, and the check runs once", async () => {
    const { ready, stuck } = readyAndStuck();
    const check = checkCard();
    const { card: pr, runId } = await pullRequestCard();
    store.close();

    const passes = await threeProcesses(at(1));
    store = openStore(file);
    expect(passes.flatMap(one => one.problems)).toEqual([]);
    // One task each, filed by whichever pass claimed the card first.
    expect(passes.flatMap(one => one.filed)).toHaveLength(2);
    expect(researchTasks()).toBe(2);
    expect(store.getFlowCard(ready)).toMatchObject({ stage: "research", entry: 1, task: expect.any(String) });
    expect(store.getFlowCard(stuck)).toMatchObject({ stage: "research", entry: 1, task: expect.any(String) });
    expect(store.getFlowCard(ready)!.task).not.toBe(store.getFlowCard(stuck)!.task);
    // The check's script ran in one process only, for the card's one visit, and the card moved on once.
    expect(passes.reduce((sum, one) => sum + one.scripts, 0)).toBe(1);
    expect(store.flowStepRun(check, 1)).toMatchObject({ state: "passed", attempts: 1, exitCode: 0 });
    expect(store.getFlowCard(check)).toMatchObject({ stage: "inbox", entry: 2 });
    expect(store.flowEvents(check).filter(event => event.fromStage === "journeys")).toHaveLength(1);
    // One pull request owed for the result, followed for the card once.
    expect(store.pendingPublications()).toMatchObject([{ run: runId, headSha: HEAD }]);
    expect(follows()).toBe(1);
    expect(store.getFlowCard(pr)).toMatchObject({ stage: "pull-request", waiting: "Opening the pull request…" });

    // Another round of passes files nothing more, and the publisher opens exactly one pull request.
    store.close();
    const again = await threeProcesses(at(2));
    store = openStore(file);
    expect(again.flatMap(one => one.filed)).toEqual([]);
    expect(again.reduce((sum, one) => sum + one.scripts, 0)).toBe(0);
    expect(researchTasks()).toBe(2);
    const created: string[][] = [];
    const publisher: PublishExec = async (bin, args) => {
      if (bin === "gh" && args[0] === "pr" && args[1] === "list") return { ...OK, stdout: "[]" };
      if (bin === "gh" && args[0] === "pr" && args[1] === "create") { created.push(args); return { ...OK, stdout: "https://github.com/alex/site/pull/7\n" }; }
      return OK;
    };
    expect(await publishPass(store, { repo, exec: publisher, clock: () => at(3), evidenceRoot: dir })).toMatchObject({ opened: 1 });
    expect(await publishPass(store, { repo, exec: publisher, clock: () => at(4), evidenceRoot: dir })).toMatchObject({ opened: 0 });
    expect(created).toHaveLength(1);
  }, 120_000);
});

describe("passes that read the card before another pass acts", () => {
  /** Every handle's pass sees the cards as they were before any of them acted. */
  const handles = (count: number): Store[] => {
    const cards = store.activeFlowCards(repo);
    return Array.from({ length: count }, () => {
      const other = openStore(file);
      others.push(other);
      vi.spyOn(other, "activeFlowCards").mockReturnValue(cards);
      return other;
    });
  };

  test("c1: three passes file one task for a ready card and one for a stuck card being retried", () => {
    const { ready, stuck } = readyAndStuck();
    const filed = handles(3).flatMap(handle => advanceFlows(handle, repo, at(1)).filed);
    expect(filed).toHaveLength(2);
    expect(researchTasks()).toBe(2);
    expect(store.getFlowCard(stuck)!.task).toBe(filed[0]);
    expect(store.getFlowCard(ready)!.task).toBe(filed[1]);
    // Still one each on the next pass, and when a pass read the card before the task was filed.
    expect(advanceFlows(store, repo, at(2)).filed).toEqual([]);
    expect(researchTasks()).toBe(2);
  });

  test("c2: concurrent passes run a check zone's script once for the entry, and never for a visit that's over", async () => {
    const check = checkCard();
    let scripts = 0;
    const shell: Runner = async (bin, args, options) => { scripts++; return exec(bin, args, options); };
    const io: StepIo = { gh: vi.fn<Runner>(async () => OK), git: exec, shell, fetch: vi.fn() as unknown as typeof fetch, dir, scratch: join(dir, "scratch"), base: "main", evidenceRoot: dir };
    const passes = await Promise.all(handles(3).map(handle => runFlowSteps(handle, repo, at(1), io)));
    expect(passes.reduce((sum, one) => sum + one.ran, 0)).toBe(1);
    expect(scripts).toBe(1);
    expect(store.getFlowCard(check)).toMatchObject({ stage: "inbox", entry: 2 });
    // A person moves the card back to the zone; a pass that read it before they moved it again runs nothing.
    store.moveFlowCard(check, { to: "journeys", outcome: "moved", actor: "alex" }, at(2));
    const [late] = handles(1);
    store.moveFlowCard(check, { to: "inbox", outcome: "moved", actor: "alex" }, at(3));
    expect(await runFlowSteps(late!, repo, at(4), io)).toEqual({ ran: 0, problems: [] });
    expect(scripts).toBe(1);
    expect(store.flowStepRun(check, 3)).toBeNull();
  });
});
