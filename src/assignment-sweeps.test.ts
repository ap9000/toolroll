/**
 * The three assignment sweeps on a seeded store: a pass with nothing changed
 * re-derives nothing, a wake bump or the fallback minute brings the next
 * one back, and a file lost on disk still reaches the recorded receipt.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { verifyApproverStanding } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { mintCoordinator } from "./coordinator.js";
import { storeEvidence } from "./evidence.js";
import { assignmentOf, syncAssignmentHandoffs } from "./assignment.js";
import { ASSIGNMENT_STATUS_ACTION, parseAssignmentStatusEvent } from "./assignment-status.js";
import { assignmentForCoordinator } from "./assignment-adapters.js";
import { configureLeadFollow, runLeadFollowPass } from "./lead-follow.js";
import { SWEEP_FALLBACK_MS } from "./sweep-gate.js";

const TASKS = 48;
const t0 = new Date("2026-10-11T12:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
let root: string, repo: string, evidence: string, store: Store, token: string, owner: string;
const runs: number[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "assignment-sweeps-")));
  repo = join(root, "repo");
  evidence = join(root, "evidence");
  mkdirSync(repo);
  mkdirSync(evidence);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "README.md"), "Sweeps\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"]);
  store = openStore(join(root, "state.db"));
  if (!addApprover(store, "operator", t0).ok) throw Error("account");
  const verified = verifyApproverStanding(store, "operator", store.accountOf("operator")!.generation, [repo]);
  if (!verified.ok) throw Error("identity");
  const session = store.mintLeadSession({ approver: verified.who.name, approverGeneration: verified.who.generation, credentialKey: "fixture",
    ceilingMicrousd: 10_000_000, ceilingDigest: verified.who.ceilingDigest, termsDigest: "fixture" }, t0);
  const thread = store.openLeadThread(verified.who.name, verified.who.ceilingDigest, t0).thread;
  if (!configureLeadFollow(store, verified.who, store.getLeadSession(session)!, thread, true, t0)) throw Error("follow");
  const coordinator = mintCoordinator(store, { name: "planner-bot", repos: [repo], by: "operator", now: t0 });
  if (!coordinator.ok) throw Error("coordinator");
  token = coordinator.token;
  owner = `coordinator:${coordinator.cid}`;
  runs.length = 0;
  for (let i = 0; i < TASKS; i++) {
    const id = `task-${i}`;
    const made = fileTaskProposal(store, { id, title: `Task ${i}`, repo, filedVia: "cli", planning: "skip" }, t0);
    if (!made.ok) throw Error(made.message);
    const run = store.startRun({ taskRef: store.refFor("built-in", id).id, leaseId: `l${i}`, runner: "b1", branch: `b${i}`, worktree: `/w${i}`,
      route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: t0 });
    storeEvidence(store, evidence, run, "screenshot", "screen.png", Buffer.from(`png bytes for ${id}`), "screenshot", t0);
    store.finishRun(run, { outcome: "built", now: t0 });
    store.recordAction({ at: t0.toISOString(), actor: `coordinator:${coordinator.cid}`, repo, taskId: id, runId: null, action: "assignment claimed", outcome: "owner", source: "work" });
    runs.push(run);
  }
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const handoffs = (ms: number) => syncAssignmentHandoffs(store, at(ms), [repo], evidence);
const inbox = (ms: number) => assignmentForCoordinator(store, token, "inbox", { consumer: "sweeps" }, at(ms), evidence);
const follow = (ms: number) => runLeadFollowPass({ store, repos: () => [repo], evidenceRoot: evidence, clock: () => at(ms), provider: () => null });
const allSweeps = async (ms: number) => { handoffs(ms); inbox(ms); await follow(ms); };
/** What a pass leaves behind: every ledger row and notification, and when each sweep last wrote its cursor. */
const footprint = () => ({
  ledger: Number(store.handle.prepare("SELECT MAX(id) AS id FROM action_ledger").get()!["id"]),
  notifications: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM notification").get()!["n"]),
  cursors: store.handle.prepare("SELECT key,updated_at FROM service_cursor WHERE key LIKE 'assignment-%' OR key LIKE 'lead:%:scan' ORDER BY key").all(),
});
/** The owning coordinator's events; the lead's follow grant keeps its own stream. */
const statusEvents = (taskId: string) => store.handle.prepare("SELECT outcome FROM action_ledger WHERE task_id=? AND action=? AND actor=? ORDER BY id")
  .all(taskId, ASSIGNMENT_STATUS_ACTION, owner).map(row => parseAssignmentStatusEvent(String(row["outcome"]))!);
const screenshotOf = (index: number) => store.artifactsFor(runs[index]!).find(one => one.kind === "screenshot")!;

test("on a seeded store, worker, inbox and lead-follow passes with nothing changed re-derive nothing", async () => {
  await allSweeps(0);
  expect(statusEvents("task-0")).toHaveLength(1);
  const settled = footprint();
  expect(settled.cursors.length).toBeGreaterThanOrEqual(3);
  await allSweeps(5_000);
  await allSweeps(30_000);
  // No sweep wrote its cursor, a ledger row or a notification: each pass returned without reading a task.
  expect(footprint()).toEqual(settled);
});

test("a store change that bumps the wake sequence makes the next worker sweep re-derive status", async () => {
  await allSweeps(0);
  unlinkSync(join(evidence, screenshotOf(1).key));
  handoffs(5_000);
  expect(statusEvents("task-1")).toHaveLength(1);
  store.bumpWake();
  handoffs(6_000);
  const events = statusEvents("task-1");
  expect(events).toHaveLength(2);
  expect(events.at(-1)!.assignment.attention).toContainEqual(`Saved screenshot #${screenshotOf(1).id} (run ${runs[1]}) is unavailable or changed.`);
});

test("an evidence file deleted on disk with no store write reaches the receipt within the fallback minute", async () => {
  await allSweeps(0);
  const lost = screenshotOf(0);
  const caveat = `Saved screenshot #${lost.id} (run ${runs[0]}) is unavailable or changed.`;
  const before = statusEvents("task-0");
  unlinkSync(join(evidence, lost.key));
  // A direct read sees it at once; the sweeps wait for the fallback minute since their cycle began.
  expect(assignmentOf(store, "task-0", at(2_000), { principal: "coordinator", repos: [repo] }, evidence)!.attention).toContain(caveat);
  await allSweeps(SWEEP_FALLBACK_MS - 1);
  expect(statusEvents("task-0")).toEqual(before);
  const late = SWEEP_FALLBACK_MS;
  handoffs(late);
  const events = statusEvents("task-0");
  expect(events).toHaveLength(before.length + 1);
  const live = assignmentOf(store, "task-0", at(late), { principal: "coordinator", repos: [repo] }, evidence)!;
  expect(live.receipt!.caveats).toContain(caveat);
  expect(events.at(-1)!.assignment.attention).toContain(caveat);
  expect(events.at(-1)!.assignment.result!.digest).toBe(live.receipt!.digest);
  expect(before.at(-1)!.assignment.result!.digest).not.toBe(live.receipt!.digest);
});
