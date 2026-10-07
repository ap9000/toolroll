/**
 * runOperateAs: a person's command on a central server, run as them with their own API token. The machine
 * contract decides what may run at all; the token's scope, the person's current project access and their
 * standing decide the rest; and nothing reaches for this machine's owner — not the saved login beside the
 * database, a prompt, or a lead token in the environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every read of the owner's saved login, by path. A remote run must leave this empty. */
const loginReads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
    if (String(path).endsWith("up-login.txt")) loginReads.push(String(path));
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});
/** A prompt would mean somebody at this machine's terminal answering for the person. */
vi.mock("./prompt.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./prompt.js")>();
  const refuse = async () => { throw new Error("a remote run prompted"); };
  return { ...actual, interactive: () => true, ask: refuse, askHidden: refuse, confirm: refuse };
});

import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { mintApiToken } from "./api-tokens.js";
import { runOperate, runOperateAs, type Principal } from "./operate.js";
import { REMOTE_ALL_PROJECTS_ONLY, REMOTE_SCOPES, remoteRowOf } from "./operate-remote.js";
import { callPersonTool } from "./mcp-person.js";
import { CheckProgressTracker } from "./check-progress.js";
import { flowFromSteps } from "./flows.js";
import { COMMAND_GUIDE } from "./surface.js";
import { OPERATE_COMMANDS } from "./cli.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
let dir: string, file: string, store: Store, A: string, B: string, out: string[];
const passwords: Record<string, string> = {};
const write = (line: string) => { out.push(line); };
const last = () => JSON.parse(out.at(-1)!) as Record<string, unknown>;

function token(account: string, name: string, access: "read" | "act", expiresAt = "2027-01-01T00:00:00.000Z"): string {
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account, name, secretHash: minted.hash, access, expiresAt, by: account }, NOW);
  return minted.id;
}
function principal(account: string, tokenId: string, scope: "read" | "act", projects: string[] | null): Principal {
  return { kind: "person", account, generation: store.accountOf(account)!.generation, scope, tokenId, projects };
}
const as = (who: Principal, argv: string[], extra: { files?: Record<string, string>; source?: "api" | "mcp" } = {}) =>
  runOperateAs(argv, { principal: who, store, write, ...extra, options: { now: NOW } });
const remoteLedger = () => store.actionLedger({ repos: null, limit: 200 }).filter(one => one.source === "api" || one.source === "mcp");
async function fileTask(repo: string, title: string): Promise<string> {
  out = [];
  expect(await runOperate("task", ["add", title, "--repo", repo, "--json", "--db", file], write, { now: NOW, openDatabase: () => openStore(file) }), out.join("\n")).toBe(0);
  return String((last()["task"] as { id: string }).id);
}

let sam: Principal, samRead: Principal, alex: Principal, taskA: string, taskB: string;

beforeEach(async () => {
  loginReads.length = 0;
  out = [];
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-remote-")));
  file = join(dir, "orders.db");
  A = join(dir, "project-a"); B = join(dir, "project-b");
  for (const repo of [A, B]) { mkdirSync(repo); execFileSync("git", ["init", "-q", repo]); }
  store = openStore(file);
  const owner = addApprover(store, "alex", NOW);
  if (!owner.ok) throw new Error("alex");
  passwords["alex"] = owner.token;
  const person = addApprover(store, "sam", NOW, { name: "alex", token: owner.token });
  if (!person.ok) throw new Error("sam");
  expect(store.setAccountProjects("sam", [A], "alex", NOW)).toEqual({ ok: true });
  // The owner's saved login sits beside the database, as `up` leaves it: a fallback would act as alex.
  writeFileSync(join(dir, "up-login.txt"), `alex ${owner.token}\n`, { mode: 0o600 });
  taskA = await fileTask(A, "Fix the login page");
  taskB = await fileTask(B, "Rotate the billing keys");
  loginReads.length = 0;
  sam = principal("sam", token("sam", "sam-laptop", "act"), "act", [A]);
  samRead = principal("sam", token("sam", "sam-dashboard", "read"), "read", [A]);
  alex = principal("alex", token("alex", "alex-ci", "act"), "act", null);
  out = [];
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Persisted resources, excluding the one required refusal audit append and its seals. */
function dataSnapshot(): string {
  const tables = store.handle.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(row => String(row["name"])).filter(name => !["action_ledger", "ledger_seal", "sqlite_sequence"].includes(name));
  return JSON.stringify(tables.map(name => [name, store.handle.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
}

async function notFoundLikeMissing(make: (id: string) => string[], hidden: string, missing = "999999999", who = sam): Promise<void> {
  const before = dataSnapshot();
  const replies: string[][] = [];
  for (const id of [hidden, missing]) {
    out = [];
    const count = remoteLedger().length;
    expect(await as(who, [...make(id), "--json"])).toBe(3);
    expect(last()).toMatchObject({ ok: false, reason: "not-found", message: "Not found." });
    replies.push([...out]);
    expect(remoteLedger().length).toBe(count + 1);
    expect(remoteLedger()[0]).toMatchObject({ actor: who.account, source: "api", outcome: "refused", repo: null, taskId: null, runId: null, detail: `token ${who.account === 'sam' ? 'sam-laptop' : 'alex-ci'} · not-found` });
  }
  expect(replies[0]).toEqual(replies[1]);
  expect(dataSnapshot()).toBe(before);
  expect(loginReads).toEqual([]);
}

function runFor(taskId: string): number {
  const ref = store.lookupRef(taskId)!;
  const authority = store.routeAuthorityFor(ref.id, "builder", null, { provider: "claude", model: null });
  if (authority === null || !authority.ok) throw new Error("fixture has no route");
  const id = store.startRun({ taskRef: ref.id, leaseId: `lease-${taskId}`, runner: "fixture", branch: "fixture", worktree: join(dir, `work-${taskId}`), now: NOW, route: authority.stamp });
  store.finishRun(id, { outcome: "built", committed: true, now: NOW });
  store.handle.prepare("INSERT INTO build_review(run, task_id, repo, state, reason, queued_at) VALUES (?, ?, ?, 'not-reviewed', ?, ?)")
    .run(id, taskId, ref.repo, `Private review of ${taskId}`, NOW.toISOString());
  const tracker = new CheckProgressTracker(snapshot => store.saveCheckProgress(id, snapshot, NOW));
  tracker.feed("Test Files  1 passed (1)\nTests  2 passed (2)\n");
  tracker.finish();
  return id;
}

function flowFor(repo: string, name = "Inbox"): number {
  return store.createFlow({ repo, name, definitionJson: JSON.stringify(flowFromSteps([{ title: "Done", kind: "done" }])), by: "alex" }, NOW);
}
function triggerFor(flow: number): number {
  return store.addFlowTrigger({ flow, kind: "button", configJson: JSON.stringify({ kind: "button", title: "Add card", fields: [] }), hookHash: null, cursor: null, nextAt: null, by: "alex" }, NOW);
}

describe("runOperateAs", () => {
  it("runs an act token's command as its person, in their project, with the token in the action history", async () => {
    expect(await as(sam, ["task", "add", "Tidy the remote docs", "--repo", A, "--json"])).toBe(0);
    const filed = last();
    expect(filed).toMatchObject({ ok: true, command: "task add", repo: A });
    const id = String((filed["task"] as { id: string }).id);
    expect(store.lookupRef(id)?.repo).toBe(A);
    // The filed task is only known once the command runs: the final line names it.
    expect(remoteLedger().map(one => ({ actor: one.actor, action: one.action, outcome: one.outcome, source: one.source, repo: one.repo, taskId: one.taskId, detail: one.detail }))).toEqual([
      { actor: "sam", action: "remote command: task add", outcome: "done", source: "api", repo: A, taskId: id, detail: "token sam-laptop" },
      { actor: "sam", action: "remote command: task add", outcome: "requested", source: "api", repo: A, taskId: null, detail: "token sam-laptop" },
    ]);
    // Their agent over MCP is the same person, from its own source.
    expect(await as(sam, ["task", "show", taskA, "--json"], { source: "mcp" })).toBe(0);
    expect(last()).toMatchObject({ ok: true, command: "task show" });
    expect(remoteLedger()[0]).toMatchObject({ actor: "sam", action: "remote command: task show", outcome: "done", source: "mcp", repo: A, taskId: taskA, detail: "token sam-laptop" });
    // What the command itself records is the person's, not the owner's whose login sits beside the database.
    expect(await as(sam, ["task", "steer", taskA, "--note", "prefer the smaller fix", "--json"])).toBe(0);
    expect(store.actionLedger({ repos: null, limit: 5 }).find(one => one.action === "steering added")).toMatchObject({ actor: "sam", taskId: taskA, outcome: "verified" });
    // The server's store is the caller's: still open, and local commands carry on.
    expect(store.accountOf("sam")).not.toBeNull();
    expect(loginReads).toEqual([]);
  });

  it("lets a read token run only reads", async () => {
    expect(await as(samRead, ["task", "show", taskA, "--json"])).toBe(0);
    expect(last()).toMatchObject({ ok: true, command: "task show" });
    expect(await as(samRead, ["task", "add", "Sneak a write in", "--repo", A, "--json"])).toBe(3);
    expect(last()).toMatchObject({ ok: false, command: "task add", reason: "read-only", message: "Your token reads only. Use an act token for this command." });
    expect(await as(samRead, ["task", "hold", taskA, "--reason", "wait", "--key", "k1", "--json"])).toBe(3);
    expect(last()).toMatchObject({ reason: "read-only" });
    // An act principal on a read token, or a viewer's act token, still only reads.
    const widened = { ...samRead, scope: "act" as const };
    expect(await as(widened, ["task", "add", "Widened", "--repo", A, "--json"])).toBe(3);
    expect(last()).toMatchObject({ reason: "read-only" });
    expect(remoteLedger().filter(one => one.outcome === "refused").map(one => one.detail)).toEqual(["token sam-dashboard · read-only", "token sam-dashboard · read-only", "token sam-dashboard · read-only"]);
  });

  it.each([
    [["serve"], "not-remote", "That command only runs on the server's own machine, not for a remote caller."],
    [["up"], "not-remote", "That command only runs on the server's own machine, not for a remote caller."],
    [["keys", "status"], "not-remote", "That command only runs on the server's own machine, not for a remote caller."],
    [["models", "update", "claude"], "not-remote", "That command only runs on the server's own machine, not for a remote caller."],
    [["backup"], "not-remote", "That isn't a command a remote caller can run."],
    [["restore", "x.db"], "not-remote", "That isn't a command a remote caller can run."],
    [["storage"], "not-remote", "That isn't a command a remote caller can run."],
    [["contract", "--commands"], "not-remote", "That command only runs on the server's own machine, not for a remote caller."],
    // It reads the server owner's own ~/.claude and ~/.codex sessions: never for anyone else.
    [["memory", "propose", "--repo", "REPO"], "not-remote", "That command only runs on the server's own machine, not for a remote caller."],
    [["task", "approve", "TASK"], "step-up", "Approvals, people and policy changes aren't taken from a token: approve in the console or chat."],
    [["people", "list"], "step-up", "Approvals, people and policy changes aren't taken from a token: approve in the console or chat."],
    ...[["tokens", "create", "--name", "x", "--access", "act", "--days", "30"], ["tokens", "list"], ["tokens", "revoke", "alex-ci"], ["tokens", "rotate", "alex-ci"]]
      .map(argv => [argv, "step-up", "Approvals, people and policy changes aren't taken from a token: approve in the console or chat."] as [string[], string, string]),
    [["mode", "set"], "step-up", "Approvals, people and policy changes aren't taken from a token: approve in the console or chat."],
    [["chat-approval", "on"], "step-up", "Approvals, people and policy changes aren't taken from a token: approve in the console or chat."],
  ])("refuses %j before any command code runs", async (argv, reason, message) => {
    const before = store.actionLedger({ repos: null, limit: 500 }).filter(one => one.source !== "api").length;
    expect(await as(alex, [...argv.map(one => one === "TASK" ? taskA : one === "REPO" ? A : one), "--json"])).toBe(3);
    expect(last()).toMatchObject({ ok: false, reason, message });
    // One refused line in the history, and nothing else happened.
    expect(remoteLedger()).toEqual([expect.objectContaining({ actor: "alex", outcome: "refused", source: "api", detail: `token alex-ci · ${reason}` })]);
    expect(store.actionLedger({ repos: null, limit: 500 }).filter(one => one.source !== "api").length).toBe(before);
  });

  it("refuses credential and path flags: who acts comes from the token alone", async () => {
    for (const argv of [["task", "show", taskA, "--as", "alex", "--token", passwords["alex"]!], ["task", "show", taskA, "--db", join(dir, "other.db")], ["task", "show", taskA, "--token-file", join(dir, "up-login.txt")]]) {
      expect(await as(sam, [...argv, "--json"])).toBe(3);
      expect(last()).toMatchObject({ ok: false, reason: "usage", message: expect.stringContaining("leave out --as, --token, --db") });
    }
    // The password never reaches the action history.
    expect(JSON.stringify(store.actionLedger({ repos: null, limit: 500 }))).not.toContain(passwords["alex"]!);
  });

  it("enforces the person's project access on every command, and never infers a project from the server's directory", async () => {
    // Another project's task is not theirs to see.
    expect(await as(sam, ["task", "show", taskB, "--json"])).toBe(3);
    expect(last()).toMatchObject({ reason: "not-found", message: "Not found." });
    expect(await as(sam, ["task", "show", "no-such-task", "--json"])).toBe(3);
    expect(last()).toMatchObject({ reason: "not-found" });
    // Filing needs a project they may use, by its exact server path.
    for (const repo of [[], ["--repo", B], ["--repo", "project-a"], ["--repo", join(dir, "nowhere")]]) {
      expect(await as(sam, ["task", "add", "Somewhere", ...repo, "--json"])).toBe(3);
      expect(last()).toMatchObject({ reason: "unknown-project", message: "Name a project you have access to with --repo (its path on the server)." });
    }
    // A task in their project, named with another project's --repo, is refused too.
    expect(await as(sam, ["task", "show", taskA, "--repo", B, "--json"])).toBe(3);
    // Installation-wide reads need access to every project.
    expect(await as(sam, ["runner", "list", "--json"])).toBe(3);
    expect(last()).toMatchObject({ reason: "all-projects" });
    expect(await as(alex, ["runner", "list", "--json"])).toBe(0);
    expect(last()).toMatchObject({ ok: true, command: "runner list" });
    // The token's own projects narrow the person's access, and access is read now, not when the token was checked.
    const narrowed = principal("alex", alex.tokenId, "act", [A]);
    expect(await as(narrowed, ["task", "show", taskB, "--json"])).toBe(3);
    expect(store.setAccountProjects("sam", [B], "alex", NOW)).toEqual({ ok: true });
    const moved = principal("sam", sam.tokenId, "act", [A]);
    expect(await as(moved, ["task", "show", taskA, "--json"])).toBe(3);
    // Changing a person's access ends their tokens (store.setAccountProjects): the old one names no one now.
    expect(last()).toMatchObject({ reason: "unauthenticated" });
    expect(loginReads).toEqual([]);
  });

  it.each(["ask", "checks", "add-tests", "show", "wait", "complete", "revise", "state", "block", "unblock", "next", "steer", "assign", "scope", "plan", "hold", "unhold", "require", "requeue", "route", "reopen", "stop", "resume"])("hides inaccessible primary tasks in task %s", async action => {
    await notFoundLikeMissing(id => ["task", action, id], taskB);
  });

  it.each(["replaces", "replaced-by", "block", "unblock"])("checks the secondary task in %s before any mutation", async route => {
    const make = (id: string) => route === "replaces" ? ["task", "add", "Replacement", "--repo", A, "--replaces", id]
      : route === "replaced-by" ? ["task", "state", taskA, "cancelled", "--replaced-by", id]
      : ["task", route, taskA, "--on", id];
    await notFoundLikeMissing(make, taskB);
  });

  it.each(["review", "repair", "check-progress", "review-brief", "revise", "complete", "stop", "resume"])("hides inaccessible run IDs on %s", async route => {
    const runB = runFor(taskB);
    const make = (id: string) => route === "check-progress" ? [route, id]
      : route === "review" || route === "repair" ? ["task", route, id]
      : route === "review-brief" ? ["task", "review", taskA, "--brief", "--run", id]
      : ["task", route, taskA, "--run", id, ...(route === "revise" ? ["--feedback", "Fix the error"] : [])];
    await notFoundLikeMissing(make, String(runB));
    for (const malformed of ["0", "-1", "1.0", "1e0", "9007199254740992", "x"]) {
      expect(await as(sam, [...make(malformed), "--json"])).toBe(3);
      expect(last()).toMatchObject({ reason: "not-found", message: "Not found." });
    }
    // The account itself has all projects, but this token is restricted to A.
    await notFoundLikeMissing(make, String(runB), "999999999", { ...alex, projects: [A] });
  });

  it.each(["review", "revise", "stop", "resume"])("refuses a %s run paired with a different granted task", async route => {
    const other = "another-allowed-task";
    store.createTask({ id: other, title: "Another allowed task" }, NOW);
    store.placeTask(store.refFor("built-in", other).id, A);
    const run = runFor(other);
    await notFoundLikeMissing(id => ["task", route, taskA, ...(route === "review" ? ["--brief"] : []), "--run", id], String(run));
  });

  it("keeps both review modes and check-progress available for the permitted run", async () => {
    const runA = runFor(taskA);
    // A numeric TASK whose text happens to equal the hidden RUN must not authorize that run.
    const runB = runFor(taskB);
    store.createTask({ id: String(runB), title: "Numeric task" }, NOW);
    store.placeTask(store.refFor("built-in", String(runB)).id, A);
    await notFoundLikeMissing(id => ["task", "review", id], String(runB));
    expect(await as(samRead, ["task", "review", String(runA), "--json"])).toBe(0);
    expect(JSON.stringify(last())).toContain(`Private review of ${taskA}`);
    expect(await as(samRead, ["task", "review", taskA, "--brief", "--run", String(runA), "--json"])).toBe(0);
    expect(await as(samRead, ["check-progress", String(runA), "--json"])).toBe(0);
    expect(last()).toMatchObject({ ok: true, run: runA });
    expect(remoteLedger()[0]).toMatchObject({ repo: A, taskId: taskA, actor: "sam", detail: "token sam-dashboard" });
  });

  it("allows secondary tasks within the project and refuses every custom creation ID", async () => {
    const before = dataSnapshot();
    const refused = [];
    for (const id of [taskA, taskB, "never-filed"]) {
      expect(await as(sam, ["task", "add", "Replacement", "--repo", A, "--id", id, "--json"])).toBe(3);
      expect(last()).toMatchObject({ reason: "not-remote", message: "That option is not available remotely." });
      refused.push(last());
      expect(remoteLedger()[0]).toMatchObject({ outcome: "refused", repo: null, taskId: null, detail: "token sam-laptop · not-remote" });
    }
    expect(refused).toEqual([refused[0], refused[0], refused[0]]);
    expect(dataSnapshot()).toBe(before);
    const other = "another-allowed-task";
    store.createTask({ id: other, title: "Another allowed task" }, NOW);
    store.placeTask(store.refFor("built-in", other).id, A);
    for (const action of ["block", "unblock"]) expect(await as(sam, ["task", action, taskA, "--on", other, "--json"])).toBe(0);
    expect(await as(sam, ["task", "add", "Replacement", "--repo", A, "--replaces", other, "--json"])).toBe(0);
    expect(store.getTask(other)?.state).toBe("cancelled");
    expect(await as(sam, ["task", "state", taskA, "cancelled", "--replaced-by", other, "--json"])).toBe(0);
    // Same title/time as an inaccessible task must not reveal a collision either.
    expect(await as(sam, ["task", "add", "Rotate the billing keys", "--repo", A, "--json"])).toBe(0);
    expect((last()["task"] as { id: string }).id).not.toBe(taskB);
    expect(store.getTask(taskB)?.state).toBe("queued");
  });

  it.each(["show", "export", "edit", "archive", "trigger add", "trigger pause", "trigger resume", "trigger remove", "card add"])("hides inaccessible flows in flows %s", async action => {
    const hidden = flowFor(B);
    await notFoundLikeMissing(id => ["flows", ...action.split(" "), id], String(hidden));
  });

  it.each(["pause", "resume", "remove"])("checks trigger ownership before flows trigger %s", async action => {
    const flowA = flowFor(A), flowB = flowFor(B), anotherA = flowFor(A, "Another inbox");
    const hidden = triggerFor(flowB), mismatch = triggerFor(anotherA), own = triggerFor(flowA);
    const make = (id: string) => ["flows", "trigger", action, String(flowA), id];
    await notFoundLikeMissing(make, String(hidden));
    await notFoundLikeMissing(make, String(mismatch));
    expect(await as(sam, [...make(String(own)), "--json"])).toBe(0);
  });

  it("checks flow references inside inline and uploaded trigger settings against the token ceiling", async () => {
    const flowA = flowFor(A), flowB = flowFor(B), flowA2 = flowFor(A, "Reports");
    await notFoundLikeMissing(id => ["flows", "trigger", "add", String(flowA), JSON.stringify({ kind: "flow", flow: Number(id) })], String(flowB));
    const who = { ...alex, projects: [A] };
    const replies = [];
    const before = dataSnapshot();
    for (const flow of [flowB, 999999999]) {
      expect(await as(who, ["flows", "trigger", "add", String(flowA), "settings.json", "--json"],
        { files: { "settings.json": JSON.stringify({ kind: "flow", flow }) } })).toBe(3);
      replies.push(last());
      expect(last()).toMatchObject({ reason: "not-found" });
    }
    expect(replies[0]).toEqual(replies[1]);
    expect(dataSnapshot()).toBe(before);
    expect(await as(sam, ["flows", "trigger", "add", String(flowA), JSON.stringify({ kind: "flow", flow: flowA2 }), "--json"])).toBe(0);
    expect(await as(samRead, ["flows", "show", String(flowA), "--json"])).toBe(0);
    expect(remoteLedger()[0]).toMatchObject({ repo: A, taskId: null, actor: "sam" });
  });

  it("refuses token-external projects embedded in uploaded build steps", async () => {
    const before = dataSnapshot();
    expect(await as({ ...alex, projects: [A] }, ["flows", "create", "--repo", A, "--name", "Cross project", "--steps", "steps.json", "--json"],
      { files: { "steps.json": JSON.stringify({ steps: [{ kind: "task", title: "Build", repo: B, goal: "Fix it" }] }) } })).toBe(3);
    expect(last()).toMatchObject({ reason: "not-found" });
    expect(dataSnapshot()).toBe(before);
  });

  it("keeps evidence, card approvals, conversations, proposals, and unsafe forms behind their remote refusal", async () => {
    for (const argv of [["task", "evidence", taskB], ["conversation", "show", "--conversation", "1"], ["proposals", "confirm", "1"],
      ["memory", "apply", "1"], ["flows", "card", "approve", "1", "2"], ["flows", "card", "send-back", "1", "2"],
      ["task", "regate", taskA], ["task", "repair", "1", "--yes"], ["task", "add", "External", "--repo", A, "--backend", "github-issues"],
      ["task", "show", taskA, "--on", taskB], ["task", "show", taskA, taskB]]) {
      const before = dataSnapshot();
      expect(await as(alex, [...argv, "--json"])).toBe(3);
      expect(dataSnapshot()).toBe(before);
    }
    for (const repos of [["--repo", `${A},${B}`], ["--repo", A, "--repo", B], ["--repo", ` ${A} `]]) {
      expect(await as(alex, ["task", "add", "Ambiguous project", ...repos, "--json"])).toBe(3);
      expect(last()).toMatchObject({ reason: "unknown-project" });
    }
    expect(loginReads).toEqual([]);
  });

  it("uses the same plain refusal outside JSON and keeps the approval variants in the console", async () => {
    for (const id of [taskB, "missing-task"]) {
      out = [];
      expect(await as(sam, ["task", "block", taskA, "--on", id])).toBe(3);
      expect(out).toEqual(["Not found."]);
    }
    for (const argv of [["task", "regate", taskA], ["task", "repair", "1", "--yes"]]) {
      expect(await as(alex, [...argv, "--json"])).toBe(3);
      expect(last()).toMatchObject({ reason: "step-up", message: expect.stringContaining("approve in the console or chat") });
    }
  });

  it("isolates replay keys by person and project, preserving retries without stray task references", async () => {
    const key = "same-user-supplied-key";
    expect(await as(alex, ["task", "add", "Private replay result", "--repo", B, "--key", key, "--json"])).toBe(0);
    const privateId = String((last()["task"] as { id: string }).id);
    expect(await as(sam, ["task", "add", "My replay result", "--repo", A, "--key", key, "--json"])).toBe(0);
    const mine = last();
    const mineId = String((mine["task"] as { id: string }).id);
    expect(mineId).not.toBe(privateId);
    const references = store.handle.prepare("SELECT * FROM task_ref").all();
    expect(await as(sam, ["task", "add", "My replay result", "--repo", A, "--key", key, "--json"])).toBe(0);
    expect(last()).toEqual(mine);
    // A replay's history names the task it answered with, never a fresh candidate.
    expect(remoteLedger()[0]).toMatchObject({ outcome: "done", taskId: mineId });
    expect(store.handle.prepare("SELECT * FROM task_ref").all()).toEqual(references);
    expect(store.lookupRef(privateId)?.repo).toBe(B);
    // The same account's other project and command have distinct replay identities too.
    expect(await as(alex, ["task", "add", "Owner in A", "--repo", A, "--key", key, "--json"])).toBe(0);
    expect((last()["task"] as { id: string }).id).not.toBe(privateId);
    expect(await as(sam, ["task", "hold", mineId, "--reason", "wait", "--key", key, "--json"])).toBe(0);
    expect(await as(sam, ["task", "unhold", mineId, "--key", key, "--json"])).toBe(0);
    // A retry cannot disclose its saved result after the task moves outside the token's projects.
    store.placeTask(store.lookupRef(mineId)!.id, B);
    expect(await as(sam, ["task", "add", "My replay result", "--repo", A, "--key", key, "--json"])).toBe(3);
    expect(last()).toMatchObject({ reason: "not-found", message: "Not found." });
    expect(store.lookupRef(mineId)?.repo).toBe(B);
    expect(loginReads).toEqual([]);
  });

  it("re-proves the principal at call time: a revoked or expired token, a changed sign-in or a forged principal names no one", async () => {
    const expired = principal("sam", token("sam", "old", "act", "2026-10-01T00:00:00.000Z"), "act", [A]);
    expect(await as(expired, ["task", "show", taskA, "--json"])).toBe(3);
    expect(last()).toMatchObject({ reason: "unauthenticated", message: "Your sign-in changed since this token was checked. Sign in again." });
    expect(await as({ ...sam, account: "alex" }, ["task", "show", taskA, "--json"])).toBe(3);
    expect(await as({ ...sam, generation: sam.generation - 1 }, ["task", "show", taskA, "--json"])).toBe(3);
    expect(await as({ ...sam, tokenId: "ffffffffffff" }, ["task", "show", taskA, "--json"])).toBe(3);
    store.revokeApiToken(sam.tokenId, "alex", NOW);
    expect(await as(sam, ["task", "show", taskA, "--json"])).toBe(3);
    expect(last()).toMatchObject({ reason: "unauthenticated" });
    expect(out.every(line => !line.includes("Fix the login page"))).toBe(true);
  });

  it("never falls back to the owner: no saved login, no prompt, no lead token from the environment", async () => {
    // Any read of a lead token from the environment throws (and so would fail the run).
    const env = process.env;
    process.env = new Proxy(env, { get: (target, key) => { if (typeof key === "string" && /LEAD_TOKEN$/.test(key)) throw new Error(`a remote run read ${key}`); return Reflect.get(target, key); } });
    try {
      // Commands that take an approver's credential locally (from --as/--token, the saved login or a prompt) run as the person.
      expect(await as(sam, ["task", "hold", taskA, "--reason", "waiting on design", "--key", "hold-1", "--json"])).toBe(0);
      expect(last()).toMatchObject({ ok: true, command: "task hold", id: taskA });
      expect(await as(sam, ["task", "unhold", taskA, "--key", "unhold-1", "--json"])).toBe(0);
      expect(await as(sam, ["memory", "status", "--json"])).toBe(0);
      expect(await as(sam, ["flows", "list", "--json"])).toBe(0);
      expect(await as(sam, ["task", "list", "--json"])).toBe(0);
      expect(await as(sam, ["task", "steer", taskA, "--note", "keep the old copy", "--json"])).toBe(0);
      expect(out.join("\n")).not.toMatch(/a remote run (prompted|read)/);
      expect(loginReads, "a remote run read the owner's saved login").toEqual([]);
      // The poison works: the same environment breaks a local command that reads it.
      await expect(runOperate("status", ["--json", "--db", file], write, { now: NOW, openDatabase: () => openStore(file) })).rejects.toThrow(/LEAD_TOKEN/);
    } finally {
      process.env = env;
    }
    // And a local command still reads the saved login, so an empty list above means something.
    expect(await runOperate("status", ["--json", "--db", file], write, { now: NOW, openDatabase: () => openStore(file) })).toBe(0);
    expect(loginReads.length).toBeGreaterThan(0);
    // Nothing the person did is the owner's.
    expect(store.actionLedger({ repos: null, limit: 200 }).filter(one => one.taskId === taskA && one.action.startsWith("remote")).every(one => one.actor === "sam")).toBe(true);
  });

  it("reads input files only from the request, by the argument that names them", async () => {
    const steps = JSON.stringify({ steps: [{ kind: "note", text: "hello" }] });
    const onDisk = join(dir, "steps.json");
    writeFileSync(onDisk, steps);
    // A path on the server is never read for the caller, even when a file is there.
    expect(await as(sam, ["flows", "create", "--repo", A, "--name", "Mine", "--steps", onDisk, "--json"])).toBe(3);
    expect(last()).toMatchObject({ ok: false, message: "The steps file couldn't be read." });
    // The same argument, sent with the request, is read from memory.
    expect(await as(sam, ["flows", "create", "--repo", A, "--name", "Mine", "--steps", onDisk, "--json"], { files: { [onDisk]: steps } })).not.toBe(1);
    expect(last()["message"]).not.toBe("The steps file couldn't be read.");
  });
});

describe("cross-project lists for a person limited to some projects", () => {
  /** Everything of project B a limited person must never see, in any output. */
  let hiddenSecond = "";
  const hidden = () => [taskB, hiddenSecond, B, "project-b", "Rotate the billing keys", "Close the old billing account", "Builds by project", "Plan windows", "Release check", "claude max"];
  const leaks = (text: string) => hidden().filter(one => text.includes(one));
  const run = async (who: Principal, argv: string[]) => { out = []; const code = await as(who, argv); return { code, text: out.join("\n") }; };

  beforeEach(async () => {
    // A second task in B and one plan window: both owner-only facts a limited person's counts must leave out.
    hiddenSecond = await fileTask(B, "Close the old billing account");
    store.recordProviderLimits({ provider: "claude", plan: "max", windows: [{ window: "five_hour", usedPercent: 40, windowMinutes: 300, resetsAt: null, reached: false }] }, NOW);
    out = [];
  });

  it("status shows only their projects, counted over them, and leaves out the installation's lines", async () => {
    const plain = await run(sam, ["status"]);
    expect(plain.code).toBe(0);
    expect(plain.text).toContain(taskA);
    expect(plain.text).toContain("Queued: 1 — ");
    expect(leaks(plain.text)).toEqual([]);
    const json = await run(samRead, ["status", "--json"]);
    expect(json.code).toBe(0);
    expect(leaks(json.text)).toEqual([]);
    const body = last();
    expect(body).toMatchObject({ ok: true, command: "status", queued: { count: 1, reasons: [{ reason: "needs a scope", count: 1 }] }, running: { count: 0 },
      waitingForReview: { count: 0 }, releaseCheck: null, planWindows: [], lead: null, projects: [] });
    expect((body["tasks"] as { task: string }[]).map(one => one.task)).toEqual([taskA]);
    for (const absent of ["update", "integrations", "updateWaiting", "unsentReplies"]) expect(body, absent).not.toHaveProperty(absent);
    // The owner still sees the whole installation.
    const owner = await run(alex, ["status"]);
    expect(owner.text).toContain("Queued: 3 — ");
    for (const line of ["Builds by project", "Plan windows: claude max", "Release check: none recorded"]) expect(owner.text).toContain(line);
  });

  it.each([[], ["--view", "all"], ["--view", "needs-you"], ["--view", "running"], ["--view", "completed"], ["--state", "queued"], ["--limit", "1"], ["--repo", "A"]])(
    "task list %j pages and counts only their projects", async (...extra) => {
      const flags = extra.map(one => one === "A" ? A : one);
      for (const mode of [[], ["--json"]]) {
        const listed = await run(sam, ["task", "list", ...flags, ...mode]);
        expect(listed.code, listed.text).toBe(0);
        expect(leaks(listed.text)).toEqual([]);
      }
      // Totals are exactly the owner's for project A alone.
      const own = last();
      const view = flags.filter((_one, index) => flags[index - 1] !== "--repo" && flags[index] !== "--repo");
      await run(alex, ["task", "list", ...view, "--repo", A, "--json"]);
      expect(own["totals"]).toEqual(last()["totals"]);
      expect(own["tasks"]).toEqual(last()["tasks"]);
    });

  it("follows a page cursor without reaching another project", async () => {
    const extra = await fileTask(A, "Second task in A");
    const first = await run(sam, ["task", "list", "--limit", "1", "--json"]);
    const cursor = String(last()["nextCursor"]);
    expect(cursor).not.toBe("null");
    const second = await run(sam, ["task", "list", "--limit", "1", "--cursor", cursor, "--json"]);
    expect(last()["nextCursor"]).toBeNull();
    expect([first.text, second.text].join("\n")).toContain(extra);
    expect(leaks(first.text + second.text)).toEqual([]);
  });

  it("answers another project's --repo exactly as a missing one", async () => {
    const replies: string[] = [];
    for (const repo of [B, join(dir, "no-such-project")]) {
      const listed = await run(sam, ["task", "list", "--repo", repo, "--json"]);
      expect(listed.code).toBe(3);
      expect(last()).toMatchObject({ ok: false, reason: "unknown-project" });
      replies.push(listed.text.replace(repo, "<repo>"));
    }
    expect(replies[0]).toBe(replies[1]);
    expect(leaks(replies.join(""))).toEqual([]);
  });

  it("ready lists and counts only their projects", async () => {
    for (const mode of [[], ["--json"]]) {
      const ready = await run(sam, ["ready", ...mode]);
      expect(ready.code).toBe(0);
      expect(ready.text).toContain(taskA);
      expect(leaks(ready.text)).toEqual([]);
    }
    expect(last()).toMatchObject({ ok: true, count: 1 });
    await run(alex, ["ready", "--json"]);
    expect(last()).toMatchObject({ ok: true, count: 3 });
  });

  it("gives the MCP status and list_tasks tools the same view", async () => {
    const runAs: typeof runOperateAs = (argv, opts) => runOperateAs(argv, { ...opts, options: { now: NOW } });
    const person = { principal: samRead, role: "approver" as const, tokenName: "sam-dashboard" };
    for (const [name, args] of [["status", {}], ["list_tasks", {}], ["list_tasks", { state: "queued" }], ["list_tasks", { repo: A }]] as const) {
      const outcome = await callPersonTool(person, store, runAs, { name, arguments: args });
      expect(outcome.kind).toBe("result");
      const result = (outcome as { result: { content: { text: string }[]; isError?: boolean } }).result;
      expect(result.isError, `${name} ${result.content[0]!.text}`).toBeUndefined();
      expect(result.content[0]!.text).toContain(taskA);
      expect(leaks(result.content[0]!.text)).toEqual([]);
    }
    const refused = await callPersonTool(person, store, runAs, { name: "list_tasks", arguments: { repo: B } });
    expect((refused as { result: { isError?: boolean; content: { text: string }[] } }).result).toMatchObject({ isError: true });
    expect(leaks((refused as { result: { content: { text: string }[] } }).result.content[0]!.text).filter(one => one !== B)).toEqual([]);
    expect(remoteLedger().slice(0, 5).every(one => one.source === "mcp" && one.actor === "sam")).toBe(true);
  });

  const mcp = async (who: Principal, name: string, args: Record<string, unknown>) => {
    const runAs: typeof runOperateAs = (argv, opts) => runOperateAs(argv, { ...opts, options: { now: NOW } });
    const outcome = await callPersonTool({ principal: who, role: "approver", tokenName: "fixture" }, store, runAs, { name, arguments: args });
    expect(outcome.kind).toBe("result");
    const result = (outcome as { result: { content: { text: string }[]; isError?: boolean } }).result;
    expect(result.isError, result.content[0]!.text).toBeUndefined();
    return result.content[0]!.text;
  };

  it.each(["queued", "failed", "cancelled", "done"] as const)("task show hides %s foreign blockers in plain, JSON and MCP answers", async state => {
    const visible = await fileTask(A, "Zebra prerequisite");
    for (const blocker of [taskB, hiddenSecond, visible]) expect(store.addEdge(taskA, blocker)).toEqual({ ok: true });
    for (const blocker of [taskB, hiddenSecond]) expect(store.setTaskState(blocker, state, NOW, {}, "No longer needed")).toEqual({ ok: true });
    // Both a token's restriction and the account's current grants narrow task references.
    for (const who of [sam, samRead, { ...alex, projects: [A] }, { ...sam, projects: null }]) {
      const plain = await run(who, ["task", "show", taskA]);
      expect(plain.code).toBe(0);
      expect(plain.text).toContain(`waits for ${visible}, a task in another project`);
      expect(plain.text).not.toContain("position  ");
      expect(leaks(plain.text)).toEqual([]);
      const json = await run(who, ["task", "show", taskA, "--json"]);
      expect(json.code).toBe(0);
      expect(leaks(json.text)).toEqual([]);
      expect(last()).toMatchObject({ blockedBy: [visible, "a task in another project"], position: null,
        dispatch: { blockerTaskId: state === "done" ? visible : null } });
      expect(await mcp(who, "task_show", { ref: taskA })).toBe(json.text);
    }
    // The owner keeps the real references and queue column, exactly as a local caller sees them.
    for (const mode of [[], ["--json"]]) {
      const remote = await run(alex, ["task", "show", taskA, ...mode]);
      expect(remote.text).toContain(taskB);
      if (mode.length > 0) {
        expect(last()["position"]).toEqual(store.queuePosition(taskA));
        expect(await mcp(alex, "task_show", { ref: taskA })).toBe(remote.text);
      }
      out = [];
      expect(await runOperate("task", ["show", taskA, ...mode, "--db", file], write, { now: NOW, openDatabase: () => openStore(file) })).toBe(remote.code);
      expect(out.join("\n")).toBe(remote.text);
    }
  });

  it.each(["queued", "failed", "cancelled"] as const)("lists and ready hide %s foreign dependencies and their counts", async state => {
    expect(store.addEdge(taskA, taskB)).toEqual({ ok: true });
    expect(store.setTaskState(taskB, state, NOW, {}, "No longer needed")).toEqual({ ok: true });
    expect(store.setTaskState(hiddenSecond, state, NOW, {}, "No longer needed")).toEqual({ ok: true });
    const visible = await fileTask(A, "A ready task with private dependents");
    const commands = [
      ["task", "show", taskA], ["task", "show", taskA, "--json"],
      ["task", "show", visible, "--json"], ["status"], ["status", "--json"], ["ready"], ["ready", "--json"],
      ...[[], ["--view", "all"], ["--view", "needs-you"], ["--view", "running"], ["--view", "completed"],
        ["--state", "queued"], ["--repo", A], ["--limit", "1"]].flatMap(flags => [
          ["task", "list", ...flags], ["task", "list", ...flags, "--json"],
        ]),
    ];
    const read = async () => {
      const answers = [];
      for (const argv of commands) {
        const answer = await run(samRead, argv);
        expect(answer.code, argv.join(" ")).toBe(0);
        expect(leaks(answer.text), argv.join(" ")).toEqual([]);
        if (argv[0] === "ready" && argv.includes("--json")) {
          expect(last()).toMatchObject({ count: 1, tasks: [{ id: visible, dispatch: { blockerTaskId: null } }] });
        }
        answers.push(answer);
      }
      for (const [name, args] of [["task_show", { ref: taskA }], ["task_show", { ref: visible }], ["status", {}], ["list_tasks", {}]] as const) {
        const text = await mcp(samRead, name, args);
        expect(leaks(text)).toEqual([]);
        answers.push({ code: 0, text });
      }
      return answers;
    };
    const before = await read();
    // A second invisible blocker, dependent and queued task must not change any limited answer.
    expect(store.addEdge(taskA, hiddenSecond)).toEqual({ ok: true });
    const dependent = await fileTask(B, "Private dependent count marker");
    expect(store.addEdge(dependent, visible)).toEqual({ ok: true });
    expect(await read()).toEqual(before);
    for (const argv of [["status"], ["status", "--json"], ["task", "list"], ["task", "list", "--json"], ["ready"], ["ready", "--json"]]) {
      const remote = await run(alex, argv);
      out = [];
      expect(await runOperate(argv[0]!, [...argv.slice(1), "--db", file], write, { now: NOW, openDatabase: () => openStore(file) })).toBe(remote.code);
      expect(out.join("\n"), argv.join(" ")).toBe(remote.text);
    }
    // Removing the sole visible ready candidate leaves an empty ready set, even with queued work in B.
    expect(store.addEdge(visible, taskB)).toEqual({ ok: true });
    for (const mode of [[], ["--json"]]) {
      const empty = await run(samRead, ["ready", ...mode]);
      expect(empty.code).toBe(3);
      expect(leaks(empty.text)).toEqual([]);
      if (mode.length > 0) expect(last()).toMatchObject({ count: 0, tasks: [], dispatchableCount: 0 });
    }
    // Completed foreign prerequisites admit the tasks without disclosing their dependency edges.
    for (const blocker of [taskB, hiddenSecond]) {
      expect(store.setTaskState(blocker, "done", NOW)).toEqual({ ok: true });
    }
    for (const mode of [[], ["--json"]]) {
      const ready = await run(samRead, ["ready", ...mode]);
      expect(ready.code).toBe(0);
      expect(leaks(ready.text)).toEqual([]);
      expect(ready.text).not.toContain(dependent);
      if (mode.length > 0) expect(last()).toMatchObject({ count: 2, tasks: expect.arrayContaining([
        expect.objectContaining({ id: taskA, dispatch: expect.objectContaining({ blockerTaskId: null }) }),
        expect.objectContaining({ id: visible, dispatch: expect.objectContaining({ blockerTaskId: null }) }),
      ]) });
    }
  });

  it("keeps an all-project owner's output byte for byte what the same command prints locally", async () => {
    for (const argv of [["status"], ["status", "--json"], ["task", "list"], ["task", "list", "--json"], ["task", "list", "--view", "needs-you", "--json"],
      ["task", "list", "--repo", B, "--json"], ["ready"], ["ready", "--json"]]) {
      const remote = await run(alex, argv);
      out = [];
      const local = await runOperate(argv[0]!, [...argv.slice(1), "--db", file], write, { now: NOW, openDatabase: () => openStore(file) });
      expect(remote.code, argv.join(" ")).toBe(local);
      expect(remote.text, argv.join(" ")).toBe(out.join("\n"));
    }
  });

  it("still refuses a limited person every cross-project command not yet scoped", async () => {
    for (const [invocation, why] of REMOTE_ALL_PROJECTS_ONLY) {
      if (why !== "not yet scoped" || !invocation.endsWith(" list")) continue;
      const refused = await run(samRead, [...invocation.split(" "), "--json"]);
      expect(refused.code, invocation).toBe(3);
      expect(last(), invocation).toMatchObject({ reason: "all-projects" });
    }
    for (const who of [samRead, alex]) for (const command of ["brief", "spend"]) {
      expect((await run(who, [command, "--json"])).code).toBe(3);
      expect(last()).toMatchObject({ reason: "not-remote" });
    }
  });
});

describe("the remote policy table", () => {
  it("scopes every cross-project row as a listing or says why it needs every project", () => {
    const installation = [...REMOTE_SCOPES].filter(([, scope]) => scope.kind === "installation").map(([row]) => row);
    expect([...REMOTE_ALL_PROJECTS_ONLY.keys()].sort()).toEqual(installation.sort());
    expect([...REMOTE_SCOPES].filter(([, scope]) => scope.kind === "listing").map(([row]) => row).sort()).toEqual(["ready", "status", "task list"]);
  });

  it("gives every runnable row a project scope, routes it to this dispatcher, and finds each row from its own words", () => {
    const yes = COMMAND_GUIDE.filter(row => row.remote === "yes").map(row => row.invocation);
    expect([...REMOTE_SCOPES.keys()].sort()).toEqual([...yes].sort());
    for (const invocation of yes) expect(OPERATE_COMMANDS.has(invocation.split(" ")[0]!), invocation).toBe(true);
    for (const row of COMMAND_GUIDE.filter(one => one.invocation !== "")) {
      const [root, ...words] = row.invocation.split(" ");
      expect(remoteRowOf(root!, [...words, "extra-argument"])?.invocation, row.invocation).toBe(row.invocation);
    }
    // A command with no row of its own is no row at all, never its parent's.
    expect(remoteRowOf("task", ["evidence", "t-1"])).toBeNull();
    expect(remoteRowOf("backup", [])).toBeNull();
  });
});
