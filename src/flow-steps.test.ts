/**
 * Closing the loop: project scripts run with no AI in a fresh copy of a
 * card's work (a real git repository, a real shell), updates to the issue a
 * card came from, a build whose checks failed taking its failure path, a
 * shared form, and the insights that show where a flow breaks.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, approve } from "./scope.js";
import { run as exec, type ExecResult } from "./exec.js";
import type { Runner } from "./backend.js";
import { flowFromSteps, type FlowDefinition } from "./flows.js";
import { advanceFlows } from "./flow-engine.js";
import { runFlowSteps, type StepIo } from "./flow-steps.js";
import { saveScript, scriptUses, validateScript } from "./flow-scripts.js";
import { flowInsights } from "./flow-insights.js";
import { addFlowTriggerTo, flowFormPage, receiveFlowForm, shareFlowButton } from "./flow-triggers.js";
import { storeEvidence } from "./evidence.js";
import { sealVerificationReceipt } from "./verification-evidence.js";

const T0 = new Date("2026-09-24T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false, notFound: false });

let dir: string, repo: string, store: Store, token: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-steps-")));
  repo = join(dir, "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "Shop\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed"]);
  store = openStore(join(dir, "orders.db"));
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", T0);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  token = alex.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const flowOf = (steps: Parameters<typeof flowFromSteps>[0]) => store.createFlow({ repo, name: "Ship it", definitionJson: JSON.stringify(flowFromSteps(steps, null)), by: "alex" }, T0);
const io = (extra: Partial<StepIo> = {}): StepIo => ({ gh: vi.fn<Runner>(async () => ok()), git: exec, shell: exec, fetch: vi.fn() as unknown as typeof fetch, dir, scratch: join(dir, "scratch"), base: "main", evidenceRoot: dir, ...extra });

describe("project scripts", () => {
  test("a script is checked, versioned, and known by the zones that run it", () => {
    expect(() => validateScript({ name: "Run Tests!", about: "x", body: "npm test" })).toThrow("Name the script in lowercase letters, numbers and dashes, like run-tests.");
    expect(() => validateScript({ name: "deploy", about: "Deploys", body: `curl -H "token: ${["ghp", "t".repeat(36)].join("_")}"` })).toThrow(/Keep secrets out of scripts/);
    expect(() => validateScript({ name: "slow", about: "Slow", body: "sleep 1", timeoutMinutes: 90 })).toThrow("A script may run for 1 to 60 minutes.");
    expect(saveScript(store, repo, { name: "has-readme", about: "Checks there is a README", body: "test -f README.md" }, "alex", T0)).toEqual({ ok: true, said: "Saved the has-readme script. Any flow in this project can run it.", version: 1 });
    expect(saveScript(store, repo, { name: "has-readme", about: "Checks there is a README", body: "test -f README.md" }, "alex", T0)).toMatchObject({ said: "No changes to save." });
    expect(saveScript(store, repo, { name: "has-readme", about: "Checks there is a README", body: "test -s README.md", timeoutMinutes: 5 }, "alex", T0)).toMatchObject({ version: 2 });
    expect(store.flowScript(repo, "has-readme")).toMatchObject({ version: 2, body: "test -s README.md", timeoutMinutes: 5, savedBy: "alex" });
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { title: "Readme", kind: "check", script: "has-readme" }]);
    expect(scriptUses(store, repo).get("has-readme")).toEqual([{ flow, flowName: "Ship it", zone: "Readme" }]);
  });

  test("a script zone runs the script in a fresh copy with the card's details, keeps its log, and sends a failure down the failure path", async () => {
    saveScript(store, repo, { name: "has-readme", about: "Checks there is a README", body: "test -f README.md && echo \"found it for $FLOW_CARD_TITLE\"" }, "alex", T0);
    saveScript(store, repo, { name: "lint", about: "Lints", body: "echo 'two problems' >&2\nexit 3" }, "alex", T0);
    const flow = flowOf([
      { title: "Inbox", kind: "inbox" }, { title: "Readme", kind: "check", script: "has-readme" }, { title: "Lint", kind: "check", script: "lint", ifFails: "Inbox" },
    ]);
    const card = store.addFlowCard({ flow, title: "Tidy the docs", description: null, stage: "readme", by: "alex" }, T0);
    store.setFlowCardOwner(card, "alex", "alex", T0);
    expect(await runFlowSteps(store, repo, at(1), io())).toEqual({ ran: 1, problems: [] });
    // What the script printed is the step's result (v90); the run says what happened.
    expect(store.getFlowCard(card)).toMatchObject({ stage: "lint", outputs: { readme: "found it for Tidy the docs" } });
    const passed = store.flowStepRun(card, 1)!;
    expect(passed).toMatchObject({ kind: "check", script: "has-readme", scriptVersion: 1, state: "passed", exitCode: 0, result: "has-readme passed on main." });
    expect(passed.log).toContain("found it for Tidy the docs");
    expect(passed.durationMs).toBeGreaterThanOrEqual(0);
    // The failing script: back to the inbox, with the end of its output, its owner told.
    await runFlowSteps(store, repo, at(2), io());
    expect(store.getFlowCard(card)).toMatchObject({ stage: "inbox", note: "lint failed (exit 3) on main.\ntwo problems" });
    expect(store.flowStepRun(card, 2)).toMatchObject({ state: "failed", exitCode: 3, log: expect.stringContaining("two problems") });
    expect(store.listNotifications("all").filter(one => one.kind === "flow-card").map(one => [one.recipient, one.subject])).toEqual([["alex", "Ship it: Lint didn't pass for “Tidy the docs”"]]);
    // The copies are gone; a zone naming no script waits and says so.
    expect(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
    store.removeFlowScript(repo, "has-readme");
    store.moveFlowCard(card, { to: "readme", outcome: "moved", actor: "alex" }, at(3));
    await runFlowSteps(store, repo, at(4), io());
    expect(store.getFlowCard(card)!.waiting).toBe("There's no script called has-readme in this project. Make it on the flow's Scripts panel.");

    // Insights: where it broke, how the scripts did, and every run.
    const seen = flowInsights(store, store.getFlow(flow)!, at(10), 30);
    expect(seen.breaks).toEqual([{ zone: "lint", title: "Lint", problems: 1, of: 1 }]);
    expect(seen.zones.find(one => one.zone === "lint")).toMatchObject({ entered: 1, failed: 1, lastProblem: { cardTitle: "Tidy the docs", note: "lint failed (exit 3) on main.\ntwo problems" } });
    expect(seen.scripts.map(one => [one.script, one.runs, one.passed, one.failed])).toEqual([["lint", 1, 0, 1], ["has-readme", 1, 1, 0]]);
    expect(seen.runs.map(one => [one.script, one.state, one.hasLog])).toEqual([["lint", "failed", true], ["has-readme", "passed", true]]);
  });

  test("a long log keeps its end, where the failure is, in whole lines and with keys blanked", async () => {
    // Found end to end: every log was cut to its first 200 characters. The key-shaped text is made when the script runs, never written here.
    saveScript(store, repo, { name: "noisy", about: "Prints a lot, then fails", body: [
      "seq 1 20000",
      "printf 'pushed with ghp_%s\\n' \"$(printf 'a%.0s' $(seq 1 36))\"",
      "echo \"DEPLOY_TOKEN=$(printf 'b%.0s' 1 2 3 4 5 6 7 8)\"",
      "echo 'the real failure' >&2",
      "exit 1",
    ].join("\n") }, "alex", T0);
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { title: "Noisy", kind: "check", script: "noisy" }]);
    const card = store.addFlowCard({ flow, title: "Loud", description: null, stage: "noisy", by: "alex" }, T0);
    await runFlowSteps(store, repo, at(1), io());
    const log = store.flowStepRun(card, 1)!.log!;
    expect(log.length).toBeGreaterThan(60_000);
    expect(log.length).toBeLessThanOrEqual(64_000);
    expect(log.split("\n")[0]).toMatch(/^\d+$/);
    expect(log).not.toContain("$ noisy");
    expect(log.trimEnd().endsWith("the real failure")).toBe(true);
    expect(log).toContain("[redacted: github-token detected on this line]");
    expect(log).toContain("DEPLOY_TOKEN=[redacted]");
    expect(log).not.toMatch(/ghp_a{36}|b{8}/);
  });

  test("a work zone whose words only point at the card still gives the agent the card", () => {
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { title: "Build", kind: "task", instructions: "Build a fix for the bug described on the card." }]);
    const card = store.addFlowCard({ flow, title: "Add a greet function", description: "Add src/greet.js exporting greet(name).", stage: "build", by: "alex" }, T0);
    advanceFlows(store, repo, T0, { evidenceRoot: dir });
    expect(store.getScope(store.getFlowCard(card)!.task!)!.goal).toBe("Build a fix for the bug described on the card.\n\nThe card: Add a greet function\n\nAdd src/greet.js exporting greet(name).");
  });

  test("a build whose project checks failed takes its failure path instead of moving on", () => {
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { title: "Build", kind: "task", ifFails: "Inbox" }, { title: "Review", kind: "approval" }]);
    const card = store.addFlowCard({ flow, title: "Fix totals", description: null, stage: "build", by: "alex" }, T0);
    advanceFlows(store, repo, T0, { evidenceRoot: dir });
    const id = store.getFlowCard(card)!.task!;
    expect(approve(store, id, "alex", T0, store.getScope(id)!.digest, token).ok).toBe(true);
    const ref = store.lookupRef(id)!;
    const authority = store.routeAuthorityFor(ref.id, "builder");
    if (!authority?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref.id, leaseId: "lease", runner: "builder", branch: "so/fix", worktree: "/pool/fix", route: authority.stamp, now: T0 });
    store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: "b".repeat(40) });
    store.recordOutcomeFacts(run, { headRevision: "a".repeat(40), handoff: "Totals fixed." });
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    store.setTaskState(id, "done", T0);
    store.setVerifyCommand({ repo, command: "npm test", timeoutMs: 300_000, approvedBy: "alex" }, T0);
    storeEvidence(store, dir, run, "check-log", "checks.txt", Buffer.from("1 failed"), "npm test", T0, { captureStatus: "ok" });
    sealVerificationReceipt(store, dir, run, "a".repeat(40), store.liveVerifyCommand(repo)!, { configured: true, ran: true, exitCode: 1 }, T0);
    advanceFlows(store, repo, at(1), { evidenceRoot: dir });
    expect(store.getFlowCard(card)).toMatchObject({ stage: "inbox", note: "The checks failed on its result: Checks failed (exit 1).", primaryTask: id });
  });
});

test("the console serves a flow's insights and a run's log, from All projects", async () => {
  saveScript(store, repo, { name: "lint", about: "Lints", body: "echo 'two problems' >&2\nexit 3" }, "alex", T0);
  const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { title: "Lint", kind: "check", script: "lint", ifFails: "Inbox" }]);
  const card = store.addFlowCard({ flow, title: "Tidy", description: null, stage: "lint", by: "alex" }, T0);
  await runFlowSteps(store, repo, at(1), io());
  const { createDecisionServer } = await import("./serve.js");
  const server = createDecisionServer({ store, evidenceRoot: dir, repos: [repo], configDir: dir, clock: () => at(60) }); // the seeded runs are at T0: a real clock lets them age out of the 7-day window
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
    const insights = await fetch(`${base}/flows/${flow}/insights?days=7`, { headers: { cookie }, redirect: "manual" });
    expect(insights.status).toBe(200);
    expect(await insights.json()).toMatchObject({ days: 7, breaks: [{ title: "Lint", problems: 1 }], runs: [{ script: "lint", state: "failed", hasLog: true }] });
    const log = await (await fetch(`${base}/flows/${flow}/runs/${card}/1`, { headers: { cookie }, redirect: "manual" })).json() as { log: string; exitCode: number };
    expect(log).toMatchObject({ exitCode: 3, log: expect.stringContaining("two problems") });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe("updating the issue a card came from", () => {
  test("GitHub: a comment, then closing it; Linear: a comment, then its team's done state; other cards pass through; trouble is retried", async () => {
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { title: "Close it", kind: "update", message: "Fixed: {{card.title}}" }]);
    const fromGitHub = store.addFlowCard({ flow, title: "Crash on save", description: null, stage: "close-it", by: "GitHub", source: { kind: "github", label: "GitHub issue #12", url: "https://github.com/acme/shop/issues/12" } }, T0);
    const gh = vi.fn<Runner>(async () => ok());
    await runFlowSteps(store, repo, at(1), io({ gh }));
    expect(gh.mock.calls.map(call => call[1])).toEqual([
      ["api", "-X", "POST", "repos/acme/shop/issues/12/comments", "-f", "body=Fixed: Crash on save"],
      ["api", "-X", "PATCH", "repos/acme/shop/issues/12", "-f", "state=closed", "-f", "state_reason=completed"],
    ]);
    expect(store.getFlowCard(fromGitHub)).toMatchObject({ stage: "done", outputs: { "close-it": "Commented on and closed GitHub issue #12." } });

    const fromLinear = store.addFlowCard({ flow, title: "Refunds", description: null, stage: "close-it", by: "Linear", source: { kind: "linear", label: "Linear ENG-9", url: "https://linear.app/acme/issue/ENG-9" } }, at(2));
    writeFileSync(join(dir, "linear-key"), `${["lin", "api", "k".repeat(40)].join("_")}\n`, { mode: 0o600 });
    const asked: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      asked.push(body.query.split("(")[0]!);
      const data = body.query.startsWith("query") ? { issue: { id: "uuid-9", team: { states: { nodes: [{ id: "state-done", name: "Done" }] } } } } : { ok: true };
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    await runFlowSteps(store, repo, at(3), io({ fetch: fetcher as unknown as typeof fetch }));
    expect(asked).toEqual(["query FlowIssue", "mutation FlowComment", "mutation FlowDone"]);
    expect(store.getFlowCard(fromLinear)).toMatchObject({ stage: "done", outputs: { "close-it": "Commented on ENG-9 and moved it to Done." } });

    const plain = store.addFlowCard({ flow, title: "Typed by hand", description: null, stage: "close-it", by: "alex" }, at(4));
    await runFlowSteps(store, repo, at(5), io());
    expect(store.getFlowCard(plain)).toMatchObject({ stage: "done", outputs: { "close-it": "Nothing to update: this card didn't come from a GitHub or Linear issue or a chat channel." } });

    // GitHub down: retried 5 and 15 minutes later, then the card says so.
    const flaky = store.addFlowCard({ flow, title: "Flaky", description: null, stage: "close-it", by: "GitHub", source: { kind: "github", label: "GitHub issue #13", url: "https://github.com/acme/shop/issues/13" } }, at(6));
    const down = vi.fn<Runner>(async () => ({ code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway", timedOut: false, notFound: false }));
    await runFlowSteps(store, repo, at(7), io({ gh: down }));
    expect(store.getFlowCard(flaky)!.waiting).toBe("GitHub didn't take the comment: HTTP 502: Bad Gateway. Trying again in 5 minutes.");
    await runFlowSteps(store, repo, at(8), io({ gh: down }));
    expect(down).toHaveBeenCalledTimes(1);
    await runFlowSteps(store, repo, at(13), io({ gh: down }));
    await runFlowSteps(store, repo, at(29), io({ gh: down }));
    expect(down).toHaveBeenCalledTimes(3);
    expect(store.getFlowCard(flaky)).toMatchObject({ stage: "close-it", waiting: "GitHub didn't take the comment: HTTP 502: Bad Gateway. It didn't work after three tries. Fix it, then move the card to try again." });
  });
});

describe("a button shared as a form", () => {
  test("anyone with the link sees only the questions, and each submission makes one card; bots and keys make none", () => {
    const flow = flowOf([{ title: "Requests", kind: "inbox" }]);
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "button", label: "Report a bug", questions: ["What happened?", "Where?"] }, "alex", T0, dir);
    if (!made.ok) throw new Error(made.message);
    const shared = shareFlowButton(store, store.getFlowTrigger(made.id)!, T0, dir);
    if (!shared.ok) throw new Error(shared.message);
    const token = shared.reveal!.path.split("/").at(-1)!;
    const page = flowFormPage(store, token, T0);
    expect(page.status).toBe(200);
    expect(page.html).toContain("<h1>Report a bug</h1>");
    expect(page.html).not.toContain("Ship it");
    const submit = (fields: Record<string, string>, now = at(1)) => receiveFlowForm(store, token, new URLSearchParams({ t: String(T0.getTime()), website: "", ...fields }), now);
    expect(submit({ a0: "Checkout is slow", a1: "On the phone" }).html).toContain("Thanks — it's been sent.");
    expect(store.flowCards(flow, true).map(card => [card.title, card.description, card.createdBy, card.source?.label])).toEqual([["Checkout is slow", "From the “Report a bug” form:\n\nWhere?\nOn the phone", "Form", "Form: Report a bug"]]);
    // A filled trap or an instant post: thanks, and nothing made.
    submit({ a0: "spam", website: "http://spam.example" });
    receiveFlowForm(store, token, new URLSearchParams({ t: String(at(1).getTime()), a0: "too fast" }), at(1));
    expect(submit({ a0: `key ${["ghp", "q".repeat(36)].join("_")}` }).html).toContain("looks like it holds a key or password");
    expect(store.flowCards(flow, true)).toHaveLength(1);
    expect(flowFormPage(store, "x".repeat(32), T0).status).toBe(404);
  });
});

describe("a draft step writes to a known limit", () => {
  const drafting = () => {
    const flow = flowOf([{ title: "New questions", kind: "inbox" }, { id: "reply", title: "Draft reply", kind: "draft", instructions: "Answer {{card.title}}" }, { title: "Done", kind: "done" }]);
    const card = store.addFlowCard({ flow, title: "Where is my order?", description: null, stage: "reply", by: "alex" }, T0);
    return { flow, card };
  };
  const writer = (answers: string[]) => {
    const prompts: string[] = [];
    return { prompts, draft: async (request: { prompt: string }) => { prompts.push(request.prompt); return { ok: true as const, text: answers[prompts.length - 1]!, ms: 5 }; } };
  };
  const long = "Thanks for asking. ".repeat(700).trim();

  test("its prompt states the limit; a draft over it is asked once to shorten, and the shortened one is kept", async () => {
    const { card } = drafting();
    const claude = writer([long, "Your order ships today."]);
    await runFlowSteps(store, repo, T0, io({ draft: claude.draft }));
    expect(claude.prompts).toHaveLength(2);
    expect(claude.prompts[0]).toContain("The draft: at most 12,000 characters.");
    expect(claude.prompts[1]).toContain(`draft is ${long.length.toLocaleString("en-US")} characters; the limit is 12,000.`);
    expect(claude.prompts[1]).toContain(long);
    expect(store.getFlowCard(card)!.outputs["reply"]).toBe("Your order ships today.");
  });

  test("a draft still over the limit after the one ask is kept whole in the step's log, and the steps after read a link to it", async () => {
    const { flow, card } = drafting();
    const claude = writer([long, `${long} And more.`, "never asked"]);
    await runFlowSteps(store, repo, T0, io({ draft: claude.draft }));
    expect(claude.prompts).toHaveLength(2);
    const output = store.getFlowCard(card)!.outputs["reply"]!;
    expect(output).toBe(`This is ${(long.length + 10).toLocaleString("en-US")} characters, more than the 12,000 a step passes on, so it is kept whole on the card's Draft reply step: /flows/${flow}?card=${card}.`);
    const step = store.flowStepRun(card, store.getFlowCard(card)!.entry) ?? store.flowStepRun(card, 1);
    expect(step?.log).toContain(`${long} And more.`);
    expect(step?.result).toContain("kept whole");
  });
});
