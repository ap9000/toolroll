/**
 * youiyoux options requests (youiyoux-intake.ts, "options, both ways"): a Ready result's options file goes to the hub
 * from the result's own commit, only when it is safe and never over a file already there; a person's decision in the
 * hub completes the task without merging it, only for the exact result copied and through a person's completion
 * guards. Fixture projects are git repositories in temp folders; nothing touches the network.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { acquire, release } from "./claim.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { assignmentOf, checkAssignmentAsOperator } from "./assignment.js";
import { verifyApproverStanding } from "./principal.js";
import { gitOf } from "./landed-cleanup.js";
import { COMPLETION_ACTION, LANDED_ACTOR } from "./result-completion.js";
import { actOnDecision, OPTIONS_COPIED_ACTION, OPTIONS_DECIDED_ACTION, runYouiyoux, writeProposalFile } from "./youiyoux-intake.js";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const ID = "r-0123456789";
const PID = "p-0123456789";
const FILE = `.youi/proposals/${PID}.json`;
let base = "", repo = "", store: Store, token = "";
const io = () => ({ dir: base, env: {} as Record<string, string | undefined>, git: gitOf(), evidenceRoot: join(base, "evidence") });
const pass = (now = NOW) => runYouiyoux(store, repo, now, io(), { force: true });
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();

function optionsRequest(id = ID, change: Record<string, unknown> = {}) {
  const proposal = `p-${id.slice(2)}`;
  return {
    schema: "youi.request/v1", id, project: "shop", kind: "options", status: "open", body: "Two calmer looks for the Save button.",
    author: { kind: "person", name: "Rosa" }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    target: { route: "/flows", scope: "element", name: "Button", file: "src/button.tsx", line: 12 },
    task: {
      title: "Options for the Save button on /flows", goal: `Write ${`.youi/proposals/${proposal}.json`}: a youi.proposal/v1 file with 2 to 4 options. Change no other file.`,
      touches: [`.youi/proposals/${proposal}.json`], touchesKnown: true, not: ["Any other file"],
      acceptance: [{ statement: "Only the options file changed", evidence: ["changed-path"] }],
      offer: { proposal, file: `.youi/proposals/${proposal}.json`, choices: { tone: { type: "enum", values: ["primary", "secondary"], default: "primary" } }, text: true },
    },
    thread: [], ...change,
  };
}

function proposal(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "youi.proposal/v1", id: PID, project: "shop", route: "/flows",
    target: { name: "Button", file: "src/button.tsx", line: 12, box: { x: 10, y: 20, width: 120, height: 40 } },
    ask: "Two calmer looks for the Save button.", author: { kind: "agent", name: "claude" }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    options: [
      { id: "a", label: "Quieter", why: "The secondary tone reads calmer.", set: [{ prop: "tone", value: "secondary" }], text: null },
      { id: "b", label: "Shorter", why: "One word says it.", set: [], text: "Save" },
    ],
    status: "open", for: ID, ...change,
  };
}

const taskOf = () => String(store.handle.prepare("SELECT task_id FROM youiyoux_request WHERE request = ?").get(ID)?.["task_id"]);
const row = () => ({ ...store.handle.prepare("SELECT proposal, proposal_state, proposal_note, decided FROM youiyoux_request WHERE request = ?").get(ID) });
const statusFile = () => JSON.parse(readFileSync(join(repo, ".youi", "requests", `${ID}.task.json`), "utf8")) as Record<string, unknown>;
const inHub = () => join(repo, FILE);
const ledger = (action: string) => store.actionLedger({ repos: null, instance: true }).filter(one => one.action === action);

/** The agent's result: a commit on its own branch, made in its own checkout (as the pool's), with these files; the
 * main checkout is never touched. A link is committed as one; a folder as a folder. */
let results = 0;
function commitResult(files: Record<string, string | { link: string } | { folder: true }>): string {
  const checkout = join(base, "pool", `result-${++results}`);
  git("worktree", "add", "-q", "-b", `toolroll/result-${results}`, checkout, "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(checkout, path, ".."), { recursive: true });
    if (typeof content === "string") writeFileSync(join(checkout, path), content);
    else if ("link" in content) symlinkSync(content.link, join(checkout, path));
    else { mkdirSync(join(checkout, path), { recursive: true }); writeFileSync(join(checkout, path, "inside.json"), "{}"); }
  }
  const inside = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: checkout, encoding: "utf8" }).trim();
  inside("add", "-A", "--", ...Object.keys(files));
  inside("commit", "-q", "-m", "options");
  return inside("rev-parse", "HEAD");
}

/** Approve the filed task as a person, then finish one build of it at `head`, as Toolroll records one. */
let builds = 0;
function finishBuild(head: string): number {
  const id = taskOf();
  const ref = store.lookupRef(id)!.id;
  if (builds === 0) {
    const scope = store.getScope(id)!;
    if (!approve(store, id, "alex", NOW, scope.digest, token).ok) throw new Error("approval");
    register(store, { name: "builder", host: "test", capacity: 2, repos: [repo], now: NOW, newToken: () => "fixture-runner" });
  } else store.setTaskState(id, "queued", NOW);
  builds++;
  const claim = acquire(store, ref, "builder", { token: "fixture-runner", now: NOW, ttlMs: 3_600_000 });
  if (!claim.ok) throw new Error(`claim: ${claim.reason}`);
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw new Error("route");
  const run = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner: "builder", branch: `toolroll/${id}`, worktree: join(base, "pool", `result-${results}`), role: "builder", route: authority.stamp, now: NOW });
  store.stampRun(run, { baseRevision: git("rev-parse", "main"), scopeDigest: store.getScope(id)!.digest });
  store.setTaskState(id, "running", NOW);
  store.recordOutcomeFacts(run, { headRevision: head, handoff: "Wrote the options." });
  store.finishRun(run, { outcome: "built", reason: "built", now: NOW });
  release(store, claim.claim.leaseId, NOW);
  store.setTaskState(id, "done", NOW);
  return run;
}

async function filed(): Promise<void> {
  writeFileSync(join(repo, ".youi", "requests", `${ID}.json`), JSON.stringify(optionsRequest()));
  expect(await pass()).toMatchObject({ filed: 1, invalid: 0 });
}

beforeEach(() => {
  builds = 0;
  results = 0;
  base = realpathSync(mkdtempSync(join(tmpdir(), "so-youiyoux-options-")));
  repo = join(base, "shop");
  mkdirSync(join(repo, ".youi", "requests"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "shop\n");
  writeFileSync(join(repo, ".gitignore"), ".youi/requests/\n");
  git("add", "README.md", ".gitignore");
  git("commit", "-q", "-m", "start");
  store = openStore(join(base, "orders.db"));
  store.upsertProject(repo, "shop", NOW);
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  token = alex.token;
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("filing", () => {
  test("an options request is filed once, scoped to its one options file, and says it is one", async () => {
    await filed();
    expect(store.getScope(taskOf())!.touches).toEqual([FILE]);
    expect(row()).toMatchObject({ proposal: PID, proposal_state: null });
    expect(store.youiyouxOriginOf(taskOf())).toMatchObject({ request: ID, kind: "options" });
    expect(store.handle.prepare("SELECT subject FROM notification WHERE kind = 'youiyoux-requests'").get()?.["subject"]).toBe("A youiyoux options request waits for your approval");
    expect(statusFile()).toMatchObject({ status: "needs-you", detail: "Needs you" });
    // Nothing is read from a result that doesn't exist yet, and nothing is written in the hub.
    expect(existsSync(inHub())).toBe(false);
  });
});

describe("the status beside the request", () => {
  test("a task a person marked complete reads done, read with its saved evidence", async () => {
    const change = optionsRequest(ID, { kind: "change" });
    delete (change.task as Record<string, unknown>)["offer"];
    (change.task as Record<string, unknown>)["touches"] = ["src/button.tsx"];
    writeFileSync(join(repo, ".youi", "requests", `${ID}.json`), JSON.stringify(change));
    expect(await pass()).toMatchObject({ filed: 1 });
    finishBuild(commitResult({ "src/button.tsx": "export const Button = 1;\n" }));
    await pass(later(1));
    expect(statusFile()).toMatchObject({ status: "ready", detail: "Ready for review" });
    const who = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [repo]);
    if (!who.ok) throw new Error("approver");
    const root = join(base, "evidence");
    const receipt = assignmentOf(store, taskOf(), later(2), { principal: "operator", repos: [repo] }, root)!.receipt!;
    expect(checkAssignmentAsOperator(store, taskOf(), receipt.digest, who.who, later(2), root).ok).toBe(true);
    await pass(later(3));
    expect(statusFile()).toMatchObject({ status: "done", detail: "Complete" });
    // Nothing of an options request's follows a change request.
    expect(existsSync(join(repo, ".youi", "proposals"))).toBe(false);
  });
});

describe("to the hub", () => {
  test("a Ready result's options go to the hub byte for byte, from its commit, once", async () => {
    await filed();
    const text = `${JSON.stringify(proposal(), null, 2)}\n`;
    const head = commitResult({ [FILE]: text });
    // The checkout the agent had says something else: only the recorded commit is read.
    expect(existsSync(inHub())).toBe(false);
    finishBuild(head);
    expect(await pass(later(1))).toMatchObject({ copied: 1 });
    expect(readFileSync(inHub(), "utf8")).toBe(text);
    expect(row()).toMatchObject({ proposal_state: "copied", decided: null });
    expect(statusFile()).toMatchObject({ status: "ready", detail: "Options are ready in the hub." });
    expect(ledger(OPTIONS_COPIED_ACTION).map(one => one.outcome)).toEqual(["copied"]);
    expect(readdirSync(join(repo, ".youi", "proposals"))).toEqual([`${PID}.json`]);
    // Once: a later pass reads nothing again, and the main branch never moved.
    expect(await pass(later(2))).toMatchObject({ copied: 0 });
    expect(ledger(OPTIONS_COPIED_ACTION)).toHaveLength(1);
    expect(git("rev-parse", "main")).toBe(git("rev-list", "--max-parents=0", "main"));
  });

  test("a finished build that isn't Ready for review sends nothing", async () => {
    await filed();
    finishBuild(commitResult({ [FILE]: JSON.stringify(proposal()) }));
    // Its terms changed after the build: it needs a person again, and its options wait.
    const scope = store.getScope(taskOf())!;
    propose(store, { taskId: taskOf(), goal: `${scope.goal}\nAlso try a third look.`, outOfScope: scope.outOfScope, touches: scope.touches, acceptance: scope.acceptance, now: later(1) });
    expect(await pass(later(2))).toMatchObject({ copied: 0 });
    expect(statusFile()["status"]).toBe("needs-you");
    expect(existsSync(inHub())).toBe(false);
    expect(row()).toMatchObject({ proposal_state: null });
  });

  test("a result without the file says so, never copies, and a newer result is read again", async () => {
    await filed();
    finishBuild(commitResult({ "src/other.ts": "export {};\n" }));
    await pass(later(1));
    expect(existsSync(inHub())).toBe(false);
    expect(row()).toMatchObject({ proposal_state: "missing" });
    expect(statusFile()).toMatchObject({ status: "ready", detail: "The agent didn't write the options file, so nothing went to the hub." });
    await pass(later(2));
    expect(ledger(OPTIONS_COPIED_ACTION)).toHaveLength(1);
    finishBuild(commitResult({ [FILE]: JSON.stringify(proposal()) }));
    expect(await pass(later(3))).toMatchObject({ copied: 1 });
    expect(row()).toMatchObject({ proposal_state: "copied" });
  });

  const big = JSON.stringify({ ...proposal(), padding: "x".repeat(64 * 1024) });
  test.each([
    ["a link", { [FILE]: { link: "../../README.md" } }, /it is a link/],
    ["a folder", { [FILE]: { folder: true as const } }, /isn't a plain file/],
    ["over 64 KB", { [FILE]: big }, /over 64 KB/],
    ["not JSON", { [FILE]: "{ options" }, /isn't JSON/],
    ["not a proposal", { [FILE]: JSON.stringify({ schema: "youi.proposal/v2", id: PID }) }, /isn't a youi\.proposal\/v1 file/],
    ["another proposal's", { [FILE]: JSON.stringify(proposal({ id: "p-9999999999" })) }, /its id isn't p-0123456789/],
    ["an answer to another request", { [FILE]: JSON.stringify(proposal({ for: "r-9999999999" })) }, /doesn't answer r-0123456789/],
    ["already chosen by the agent", { [FILE]: JSON.stringify(proposal({ status: "chosen", choice: "a", decidedBy: { kind: "person", name: "Rosa" }, decidedAt: NOW.toISOString() })) }, /already decided/],
    ["already dismissed by the agent", { [FILE]: JSON.stringify(proposal({ status: "dismissed" })) }, /already decided/],
    ["by a person", { [FILE]: JSON.stringify(proposal({ author: { kind: "person", name: "Rosa" } })) }, /author isn't an agent/],
    ["holding a key", { [FILE]: JSON.stringify(proposal({ ask: `Use ${["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_")} to sign in` })) }, /key or password/],
  ])("a result whose options file is %s is never copied, and says why", async (_what, files, why) => {
    await filed();
    finishBuild(commitResult(files));
    expect(await pass(later(1))).toMatchObject({ copied: 0 });
    expect(existsSync(inHub())).toBe(false);
    expect(row()).toMatchObject({ proposal_state: "unsafe", proposal_note: expect.stringMatching(why) });
    expect(statusFile()["detail"]).toMatch(/^The options file wasn't copied to the hub: /);
    // And nothing a person could mistake for a decision follows from it.
    await pass(later(2));
    expect(ledger(COMPLETION_ACTION)).toEqual([]);
  });

  test("a file already in the hub is never replaced, and never read for a decision: nobody may decide for the person", async () => {
    await filed();
    mkdirSync(join(repo, ".youi", "proposals"));
    const theirs = JSON.stringify(proposal({ status: "chosen", choice: "a", decidedBy: { kind: "person", name: "Rosa" }, decidedAt: NOW.toISOString() }));
    writeFileSync(inHub(), theirs);
    finishBuild(commitResult({ [FILE]: JSON.stringify(proposal()) }));
    await pass(later(1));
    expect(readFileSync(inHub(), "utf8")).toBe(theirs);
    expect(row()).toMatchObject({ proposal_state: "taken" });
    expect(statusFile()).toMatchObject({ status: "ready", detail: "An options file was already in the hub, so Toolroll left it; the task waits for its review." });
    // It already says "chosen": that is no person's decision on these options, so the task waits for its review.
    expect(await pass(later(2))).toMatchObject({ decided: 0 });
    expect(ledger(COMPLETION_ACTION)).toEqual([]);
    expect(ledger(OPTIONS_DECIDED_ACTION)).toEqual([]);
    // Written directly, the same: never over a file, a link included.
    expect(writeProposalFile(repo, PID, "{}")).toEqual({ ok: true, made: "taken" });
    rmSync(inHub());
    writeFileSync(join(base, "victim.json"), "keep me");
    symlinkSync(join(base, "victim.json"), inHub());
    expect(writeProposalFile(repo, PID, "{}")).toMatchObject({ ok: false });
    expect(readFileSync(join(base, "victim.json"), "utf8")).toBe("keep me");
    expect(readdirSync(join(repo, ".youi", "proposals")).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a proposals folder that is a link gets nothing written through it, and is tried again once it is real", async () => {
    await filed();
    mkdirSync(join(base, "elsewhere"));
    symlinkSync(join(base, "elsewhere"), join(repo, ".youi", "proposals"));
    finishBuild(commitResult({ [FILE]: JSON.stringify(proposal()) }));
    const first = await pass(later(1));
    expect(first.problems.join(" ")).toMatch(/is a link/);
    expect(readdirSync(join(base, "elsewhere"))).toEqual([]);
    expect(row()).toMatchObject({ proposal_state: "retry" });
    expect(statusFile()["detail"]).toMatch(/^The options aren't in the hub yet: \.youi\/proposals is a link/);
    rmSync(join(repo, ".youi", "proposals"));
    expect(await pass(later(2))).toMatchObject({ copied: 1 });
    expect(existsSync(inHub())).toBe(true);
  });

  test("a .youi folder that is a link is never read or written", async () => {
    await filed();
    finishBuild(commitResult({ [FILE]: JSON.stringify(proposal()) }));
    renameSync(join(repo, ".youi"), join(base, "moved"));
    symlinkSync(join(base, "moved"), join(repo, ".youi"));
    expect(await pass(later(1))).toMatchObject({ copied: 0 });
    expect(existsSync(join(base, "moved", "proposals"))).toBe(false);
  });
});

describe("back from the hub", () => {
  async function copied(): Promise<{ head: string; run: number }> {
    await filed();
    const head = commitResult({ [FILE]: JSON.stringify(proposal()) });
    const run = finishBuild(head);
    expect(await pass(later(1))).toMatchObject({ copied: 1 });
    return { head, run };
  }
  const decide = (change: Record<string, unknown>) => writeFileSync(inHub(), JSON.stringify(proposal({ decidedAt: later(5).toISOString(), ...change })));

  test.each([
    ["a pick", { status: "chosen", choice: "b", decidedBy: { kind: "person", name: "Rosa" } }, "Rosa picked option b (“Shorter”) in youiyoux's hub", "Option b was picked in the hub, so the task is complete."],
    ["a dismissal", { status: "dismissed", decidedBy: { kind: "person", name: "Rosa" } }, "Rosa dismissed the options in youiyoux's hub", "The options were dismissed in the hub, so the task is complete."],
  ])("%s in the hub completes the task without merging it, and the ledger says who and what", async (_what, change, words, detail) => {
    const { head, run } = await copied();
    const branches = git("branch", "--list", "toolroll/*");
    expect(await pass(later(2))).toMatchObject({ decided: 0 });
    decide(change);
    expect(await pass(later(6))).toMatchObject({ decided: 1 });
    const assignment = assignmentOf(store, taskOf(), later(6), { principal: "operator", repos: [repo] }, join(base, "evidence"))!;
    expect(assignment.state).toBe("complete");
    expect(assignment.completion).toMatchObject({ actor: LANDED_ACTOR, landed: `its options went to youiyoux, where ${words}` });
    expect(ledger(COMPLETION_ACTION)).toMatchObject([{ actor: LANDED_ACTOR, runId: run, outcome: assignment.receipt!.digest }]);
    expect(ledger(OPTIONS_DECIDED_ACTION)).toMatchObject([{ actor: "youiyoux", outcome: change.status, detail: expect.stringContaining(`${words} (${later(5).toISOString()}); Toolroll marked the task complete without merging or publishing its branch`) }]);
    expect(statusFile()).toMatchObject({ status: "done", detail });
    // Its branch is neither merged nor removed; main is where it was.
    expect(git("branch", "--list", "toolroll/*")).toBe(branches);
    expect(() => git("merge-base", "--is-ancestor", head, "main")).toThrow();
    // Once.
    expect(await pass(later(7))).toMatchObject({ decided: 0 });
    expect(ledger(OPTIONS_DECIDED_ACTION)).toHaveLength(1);
  });

  test("two passes that read the same decision before either acted act on it once", async () => {
    const { run } = await copied();
    const read = { request: ID, taskId: taskOf(), proposal: PID, state: "copied", run, digest: null };
    const decision = { status: "dismissed" as const, choice: null, label: null, by: "Rosa", at: null };
    const second = openStore(join(base, "orders.db"));
    try {
      expect(actOnDecision(store, repo, read, decision, later(6), join(base, "evidence"))).toBe(true);
      expect(actOnDecision(second, repo, read, decision, later(6), join(base, "evidence"))).toBe(false);
    } finally { second.close(); }
    expect(ledger(OPTIONS_DECIDED_ACTION)).toHaveLength(1);
    expect(ledger(COMPLETION_ACTION)).toHaveLength(1);
  });

  test("a decision on an older result leaves the newer one ready for review, and says why", async () => {
    await copied();
    // A person asked for another build since: its result isn't the one whose options went to the hub.
    finishBuild(commitResult({ [FILE]: JSON.stringify(proposal({ ask: "Another try" })) }));
    decide({ status: "chosen", choice: "a", decidedBy: { kind: "person", name: "Rosa" } });
    expect(await pass(later(6))).toMatchObject({ decided: 1 });
    expect(assignmentOf(store, taskOf(), later(6), { principal: "operator", repos: [repo] }, join(base, "evidence"))!.state).toBe("ready-to-check");
    expect(ledger(COMPLETION_ACTION)).toEqual([]);
    expect(ledger(OPTIONS_DECIDED_ACTION)[0]!.detail).toMatch(/stays ready for review in Toolroll: its newest result isn't the one whose options went to the hub/);
    expect(statusFile()).toMatchObject({ status: "ready", detail: "Option a was picked in the hub; the task waits for review in Toolroll." });
  });

  test("a decision the person's completion guards refuse leaves it ready for review", async () => {
    await copied();
    // A project that protects its files: its results complete only by a person other than their approver, never by Toolroll.
    store.setApprovalRules(repo, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", later(2));
    decide({ status: "dismissed", decidedBy: { kind: "person", name: "Rosa" } });
    expect(await pass(later(6))).toMatchObject({ decided: 1 });
    expect(assignmentOf(store, taskOf(), later(6), { principal: "operator", repos: [repo] }, join(base, "evidence"))!.state).toBe("ready-to-check");
    expect(ledger(COMPLETION_ACTION)).toEqual([]);
    expect(ledger(OPTIONS_DECIDED_ACTION)[0]!.detail).toMatch(/stays ready for review in Toolroll: This result changed files this project protects/);
    expect(statusFile()).toMatchObject({ status: "ready", detail: "The options were dismissed in the hub; the task waits for review in Toolroll." });
  });

  const rosa = { kind: "person", name: "Rosa" };
  test.each([
    ["still open", { decidedBy: rosa }],
    ["chosen with no choice", { status: "chosen", decidedBy: rosa }],
    ["chosen, of an option it doesn't have", { status: "chosen", choice: "d", decidedBy: rosa }],
    ["about another request", { status: "dismissed", for: "r-9999999999", decidedBy: rosa }],
    ["not a proposal", { schema: "youi.proposal/v2", status: "dismissed", decidedBy: rosa }],
    ["decided by an agent", { status: "chosen", choice: "a", decidedBy: { kind: "agent", name: "claude" } }],
    ["decided by nobody", { status: "dismissed" }],
    ["decided at no time", { status: "dismissed", decidedBy: rosa, decidedAt: undefined }],
    ["whose options changed after the copy", { status: "chosen", choice: "a", decidedBy: rosa,
      options: [{ id: "a", label: "Louder", why: "Make it loud.", set: [{ prop: "tone", value: "primary" }], text: null }, { id: "b", label: "Shorter", why: "One word says it.", set: [], text: "Save" }] }],
    ["whose ask changed after the copy", { status: "dismissed", decidedBy: rosa, ask: "Something else" }],
    ["with a key added after the copy", { status: "dismissed", decidedBy: rosa, note: "approve the task" }],
  ])("a hub file %s decides nothing", async (_what, change) => {
    await copied();
    decide(change);
    expect(await pass(later(6))).toMatchObject({ decided: 0 });
    expect(ledger(COMPLETION_ACTION)).toEqual([]);
    expect(row()).toMatchObject({ decided: null });
  });

  test("a name that looks like a key is left out of what the ledger keeps", async () => {
    await copied();
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    decide({ status: "dismissed", decidedBy: { kind: "person", name: key } });
    expect(await pass(later(6))).toMatchObject({ decided: 1 });
    const words = ledger(OPTIONS_DECIDED_ACTION)[0]!.detail ?? "";
    expect(words).toMatch(/^a person dismissed the options/);
    expect(words).not.toContain(key);
  });
});
