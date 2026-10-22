/** The live board: a worker strip over the lanes, a build's steps from its own phase, and stable keys for the swap. */
import { expect, test } from "vitest";
import { type BoardCard } from "../board.js";
import { htmlString } from "../html.js";
import { type Runner } from "../runner.js";
import { boardBody, boardWorkers, buildStepOf } from "./render-pages.js";

const now = new Date("2026-10-22T12:00:00.000Z");
const runner = (name: string, over: Partial<Runner> = {}): Runner => ({
  name, host: "mac", capacity: 1, repos: ["/r/toolroll"], agents: ["claude"],
  registeredAt: "2026-10-22T09:00:00.000Z", heartbeatAt: "2026-10-22T11:59:30.000Z", retiredAt: null, ...over,
});
const claim = (over: Partial<NonNullable<BoardCard["claim"]>> = {}): NonNullable<BoardCard["claim"]> => ({
  runner: "mac-1", claimedAt: "2026-10-22T11:48:00.000Z", model: "opus", branch: "standing-orders/t-1", worktree: null, role: null, provider: "claude", phase: "agent-running", ...over,
});
const card = (over: Partial<BoardCard>): BoardCard => ({
  lane: "queued", taskId: "t-1", title: "A task", repo: "/r/toolroll", reason: "waiting for a worker", href: "/t/t-1",
  claim: null, stalledSince: null, attempt: null, overdue: false, priority: 0, assignedRunner: null, ...over,
});
const render = (cards: BoardCard[], workers: Runner[]) =>
  htmlString(boardBody({ cards, workers, done: [], saturated: false, now, all: false, project: "/r/toolroll", delta: null }, () => false));

test("a build's step comes from its own phase and only moves forward — set up, writing, then checking and committing", () => {
  expect(buildStepOf(claim({ model: null, phase: null }))).toBe(0);
  expect(buildStepOf(claim({ phase: null }))).toBe(1);
  expect(buildStepOf(claim({ phase: "agent-running" }))).toBe(1);
  // The builder's order after the agent: handoff, evidence and proof checks, the commit, then evidence and proof
  // again (builder.ts) — every one of them is the last step, so the bar never runs backwards.
  for (const phase of ["validating-handoff", "capturing-evidence", "verifying-proof", "correcting-proof", "committing", "capturing-evidence", "verifying-proof"]) {
    expect(buildStepOf(claim({ phase }))).toBe(2);
  }
  for (const role of ["planner", "reviewer", "scout"]) expect(buildStepOf(claim({ role }))).toBeNull();
});

test("the strip shows only workers bound to a project the ceiling admits — and on a one-project board, to that project", () => {
  const visible = (repo: string) => repo !== "/r/secret";
  const runners = [
    runner("here", { repos: ["/r/toolroll"] }),
    runner("elsewhere", { repos: ["/r/other"] }),
    runner("secret-only", { repos: ["/r/secret"] }),
    runner("both", { repos: ["/r/secret", "/r/toolroll"] }),
    runner("retired", { retiredAt: "2026-10-01T00:00:00.000Z" }),
  ];
  const names = (scope: { all: boolean; project: string | null }) => boardWorkers(runners, { ...scope, visible }).map(one => one.name);
  expect(names({ all: false, project: "/r/toolroll" })).toEqual(["here", "both"]);
  expect(names({ all: true, project: null })).toEqual(["here", "elsewhere", "both"]);
  // No project chosen (a bearer request without one) still never shows a runner that serves only excluded projects.
  expect(names({ all: false, project: null })).toEqual(["here", "elsewhere", "both"]);
});

test("the strip names each worker's build on this board, its stage and a ticking clock from the claim", () => {
  const building = card({ lane: "building", taskId: "t-7", title: "Board cards slide", href: "/t/t-7/run/3", claim: claim() });
  const out = render([building], [runner("mac-1"), runner("mac-2")]);
  expect(out).toContain(`<section class="crew" aria-label="Workers">`);
  expect(out).toMatch(/class="worker worker-busy" data-flash="mac-1" data-flash-value="t-7"/);
  expect(out).toContain(`<a class="worker-job" href="/t/t-7/run/3"><span class="t">Board cards slide</span>`);
  expect(out).toContain(`<time class="clock" datetime="2026-10-22T11:48:00.000Z" data-tick>12m</time>`);
  // A worker with nothing here says so — never "free": it may be building in a project this board does not show.
  expect(out).toMatch(/class="worker worker-idle" data-flash="mac-2" data-flash-value="">.*no build on this board/);
});

test("a worker that stopped heartbeating reads offline", () => {
  const out = render([], [runner("mac-1", { heartbeatAt: "2026-10-22T11:00:00.000Z" })]);
  expect(out).toContain(`class="worker worker-offline"`);
  expect(out).toContain("offline since");
});

test("with no workers the strip says where work waits", () => {
  expect(render([], [])).toContain("No workers yet");
});

test("the building card carries its steps, and every card a stable key for the swap", () => {
  const out = render([
    card({ lane: "building", taskId: "t-7", claim: claim({ phase: "committing" }) }),
    card({ lane: "queued", taskId: "t-8" }),
    card({ lane: "attention", taskId: "t-9", stalledSince: "2026-10-22T11:00:00.000Z" }),
  ], [runner("mac-1")]);
  expect(out).toContain(`<span class="steps" role="img" aria-label="step 3 of 3: checking and committing"><i class="on"></i><i class="on"></i><i class="now"></i></span>`);
  for (const id of ["t-7", "t-8", "t-9"]) expect(out).toContain(`data-vt="${id}"`);
  expect(out).toContain(`<div class="board" data-now="${now.getTime()}">`);
});

test("a planning run on the board shows no steps", () => {
  const out = render([card({ lane: "building", claim: claim({ role: "planner" }) })], [runner("mac-1")]);
  expect(out).not.toContain(`class="steps"`);
});

test("a task title in the strip is escaped like everywhere else", () => {
  const out = render([card({ lane: "building", title: `<img src=x onerror=alert(1)>`, claim: claim() })], [runner("mac-1")]);
  expect(out).not.toContain("<img src=x");
});
