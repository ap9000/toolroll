/**
 * Flow cards move on as soon as their step is done, builds or not: from the service's own builder loop (`watch`,
 * against real git, only the agent stubbed), a card whose research finished moves while another build holds the
 * project's only slot, and a finishing build moves its own card at once. Passes that overlap never move a card or
 * run its step twice.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover } from "./scope.js";
import { run as exec, type ExecResult } from "./exec.js";
import type { Runner } from "./builder.js";
import { flowFromSteps, validateFlowDefinition } from "./flows.js";
import { saveScript } from "./flow-scripts.js";
import { alone, flowHousekeeping, moveCards, type FlowIo } from "./flow-cadence.js";

const OK: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const AGENT_SAID = JSON.stringify({ result: "Added the guard." });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The agent's half of the terminal handoff protocol. */
const concludeDone = async (cwd: string, args: readonly string[]): Promise<void> => {
  const prompt = args[args.indexOf("-p") + 1] ?? "";
  const name = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
  if (name !== undefined && cwd !== "") await writeFile(join(cwd, name), JSON.stringify({ version: 1, status: "completed", conclusion: "Added the guard." }));
};

let base: string, repo: string, db: string, pool: string;
let lines: string[] = [];
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-cadence-")));
  repo = join(base, "site");
  db = join(base, "queue.db");
  pool = join(base, "pool");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  // A build commits in a worktree of this repo: it needs an identity where none is set globally (CI machines).
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@localhost"]);
  writeFileSync(join(repo, "README.md"), "Site\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"]);
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const idle: Runner = async () => ({ ...OK, stdout: AGENT_SAID });
const run = (argv: string[], agent: Runner = idle, extra: { shouldStop?: () => boolean; flowEveryMs?: number } = {}) => {
  const [command = "", ...rest] = argv;
  lines = [];
  return runOperate(command, rest, line => lines.push(line), { databaseFile: db, agentRunner: agent, ...extra });
};
const payload = () => {
  const opens = lines.map((line, index) => ({ line, index })).filter(one => one.line.startsWith("{"));
  return JSON.parse(lines.slice(opens[opens.length - 1]?.index ?? 0).join("\n"));
};
const withStore = <T>(use: (store: Store) => T): T => {
  const store = openStore(db);
  try { return use(store); } finally { store.close(); }
};

describe("the builder moves flow cards while it builds", () => {
  /** A worker bound to the repo that builds one at a time, an approver, approved `build` tasks and unapproved `other` ones. */
  const setup = async (build: string[], other: string[] = []) => {
    const runnerToken = withStore(store => register(store, { name: "builder-1", host: "test", capacity: 2, repos: [repo], now: new Date() }).token);
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    for (const phase of ["build", "plan", "review"]) await run(["config", "set", phase, "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    for (const id of [...build, ...other]) {
      await run(["task", "add", "the work", "--id", id, "--repo", repo]);
      await run(["task", "scope", id, "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"]);
    }
    // One build at a time, so a running build holds the project's only slot.
    expect(await run(["project", "concurrency", "1", "--repo", repo, "--as", "alex", "--token", approverToken, "--json"]), lines.join("\n")).toBe(EXIT.ok);
    for (const id of build) {
      await run(["task", "approve", id, "--json"]);
      const digest = payload().scope.digest as string;
      await run(["task", "approve", id, "--yes", "--digest", digest, "--as", "alex", "--token", approverToken]);
    }
    return runnerToken;
  };

  /** A card sitting in a work zone whose task is `task`, with an Inbox zone after it. */
  const cardOn = (kind: "report" | "task", task: string): number => withStore(store => {
    const flow = store.createFlow({ repo, name: "UI inspiration", by: "alex", definitionJson: JSON.stringify(validateFlowDefinition({ version: 1, start: "work", stages: [
      { id: "work", title: kind === "report" ? "Research" : "Build", kind, instructions: "Find three references.", next: "choose" },
      { id: "choose", title: "Choose", kind: "inbox" },
    ] })) }, new Date());
    const card = store.addFlowCard({ flow, title: "Landing page ideas", description: null, stage: "work", by: "alex" }, new Date());
    store.updateFlowCard(card, { task }, new Date());
    return card;
  });
  const stageOf = (card: number) => withStore(store => store.getFlowCard(card)!.stage);

  const watch = (runnerToken: string, agent: Runner, done: string, flowEveryMs: number) => {
    let observer: Store | null = null;
    const shouldStop = () => (observer ??= openStore(db)).getTask(done)?.state === "done";
    return run(["watch", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool,
      "--for", "60000", "--tick-every", "3600000", "--bridge-every", "3600000", "--reconcile-every", "3600000", "--json"], agent, { shouldStop, flowEveryMs })
      .finally(() => observer?.close());
  };

  test("a card whose research finished moves within one beat while another build holds the only slot", async () => {
    const runnerToken = await setup(["t-build"], ["t-research"]);
    const card = cardOn("report", "t-research");
    const seen = { finishedAt: 0, movedAt: 0, stillBuilding: false };
    const agent: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      // The research finishes while this build runs; the build holds on until its card moves (or long past a beat).
      withStore(store => store.setTaskState("t-research", "done", new Date()));
      seen.finishedAt = Date.now();
      while (Date.now() - seen.finishedAt < 10_000 && stageOf(card) !== "choose") await sleep(25);
      if (stageOf(card) === "choose") { seen.movedAt = Date.now(); seen.stillBuilding = true; }
      await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
      await concludeDone(cwd, args);
      return { ...OK, stdout: AGENT_SAID };
    };

    expect(await watch(runnerToken, agent, "t-build", 250), lines.join("\n")).toBe(EXIT.ok);

    expect(seen.stillBuilding).toBe(true);
    // One beat is 250ms here; a loaded machine gets generous room, far short of the build.
    expect(seen.movedAt - seen.finishedAt).toBeLessThan(5_000);
    expect(withStore(store => store.flowEvents(card).map(one => [one.fromStage, one.toStage, one.actor]))).toEqual([[null, "work", "alex"], ["work", "choose", "flow"]]);
  }, 60_000);

  test("a finishing build moves its own card at once, not on the next beat", async () => {
    const runnerToken = await setup(["t-build"]);
    const card = cardOn("task", "t-build");
    const agent: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
      await concludeDone(cwd, args);
      return { ...OK, stdout: AGENT_SAID };
    };

    // No beat comes due, and the watch stops as soon as the build is done: only the finish itself can move the card.
    expect(await watch(runnerToken, agent, "t-build", 3_600_000), lines.join("\n")).toBe(EXIT.ok);

    expect(withStore(store => store.getTask("t-build")?.state)).toBe("done");
    expect(stageOf(card)).toBe("choose");
    expect(withStore(store => store.flowEvents(card).filter(one => one.toStage === "choose"))).toHaveLength(1);
  }, 60_000);
});

describe("overlapping flow passes", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(db);
    if (!addApprover(store, "alex", new Date()).ok) throw new Error("approver");
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", new Date());
  });
  afterEach(() => { store.close(); });

  const io = (shell: Runner): FlowIo => ({
    triggers: { gh: vi.fn<Runner>(async () => OK), fetch: vi.fn() as unknown as typeof fetch, dir: base, shell, scratch: join(base, "scratch") },
    replies: { fetch: vi.fn() as unknown as typeof fetch, dir: base },
    steps: { gh: vi.fn<Runner>(async () => OK), git: exec, shell, fetch: vi.fn() as unknown as typeof fetch, dir: base, scratch: join(base, "scratch"), base: "main", evidenceRoot: base },
    evidenceRoot: base,
  });

  test("a second pass of the same kind for a project is skipped while the first runs; other projects and kinds aren't", async () => {
    let release!: () => void;
    const first = alone("steps", repo, "idle", () => new Promise<string>(resolve => { release = () => resolve("ran"); }));
    expect(await alone("steps", repo, "idle", async () => "ran")).toBe("idle");
    expect(await alone("steps", "/elsewhere", "idle", async () => "ran")).toBe("ran");
    expect(await alone("triggers", repo, "idle", async () => "ran")).toBe("ran");
    release();
    expect(await first).toBe("ran");
    expect(await alone("steps", repo, "idle", async () => "ran")).toBe("ran");
  });

  test("passes started together run a card's check once and move it once, then the next zone's work is filed once", async () => {
    expect(saveScript(store, repo, { name: "journeys", about: "Runs the journeys", body: "echo checked" }, "alex", new Date())).toMatchObject({ ok: true });
    const flow = store.createFlow({ repo, name: "Check it", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { title: "Journeys", kind: "check", script: "journeys" }, { title: "Research", kind: "report", instructions: "Explain the result." },
    ], null)) }, new Date());
    const card = store.addFlowCard({ flow, title: "Nightly journeys", description: null, stage: "journeys", by: "alex" }, new Date());
    let scripts = 0;
    // The script takes a moment, so every other pass starts while it runs.
    const shell: Runner = async (file, args, options) => { scripts++; await sleep(200); return exec(file, args, options); };
    const halted = () => false;

    const passes = await Promise.all([
      flowHousekeeping(store, repo, () => new Date(), io(shell), halted),
      flowHousekeeping(store, repo, () => new Date(), io(shell), halted),
      (async () => { await sleep(50); return { flows: moveCards(store, repo, new Date(), base) }; })(),
      flowHousekeeping(store, repo, () => new Date(), io(shell), halted),
    ]);

    expect(scripts).toBe(1);
    expect(passes.map(one => "steps" in one ? one.steps.ran : 0).reduce((a, b) => a + b, 0)).toBe(1);
    // The pass that ran the check moved the card into Research and filed its work, once.
    expect(store.flowEvents(card).map(one => [one.fromStage, one.toStage])).toEqual([[null, "journeys"], ["journeys", "research"]]);
    expect(passes.flatMap(one => one.flows.filed)).toHaveLength(1);
    expect(store.getFlowCard(card)).toMatchObject({ stage: "research", task: expect.any(String) });
    // Passes after it change nothing.
    await flowHousekeeping(store, repo, () => new Date(), io(shell), halted);
    expect(scripts).toBe(1);
    expect(store.flowEvents(card)).toHaveLength(2);
  });
});
