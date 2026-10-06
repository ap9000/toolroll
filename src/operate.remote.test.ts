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
import { REMOTE_SCOPES, remoteRowOf } from "./operate-remote.js";
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
  expect(await runOperate("task", ["add", title, "--repo", repo, "--json", "--db", file], write, { now: NOW, openDatabase: () => openStore(file) })).toBe(0);
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

describe("runOperateAs", () => {
  it("runs an act token's command as its person, in their project, with the token in the action history", async () => {
    expect(await as(sam, ["task", "add", "Tidy the remote docs", "--repo", A, "--json"])).toBe(0);
    const filed = last();
    expect(filed).toMatchObject({ ok: true, command: "task add", repo: A });
    const id = String((filed["task"] as { id: string }).id);
    expect(store.lookupRef(id)?.repo).toBe(A);
    expect(remoteLedger().map(one => ({ actor: one.actor, action: one.action, outcome: one.outcome, source: one.source, repo: one.repo, detail: one.detail }))).toEqual([
      { actor: "sam", action: "remote command: task add", outcome: "done", source: "api", repo: A, detail: "token sam-laptop" },
      { actor: "sam", action: "remote command: task add", outcome: "requested", source: "api", repo: A, detail: "token sam-laptop" },
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
    [["task", "approve", "TASK"], "step-up", "Approvals, people and policy changes aren't taken from a token: approve in the console or chat."],
    [["people", "list"], "step-up", "Approvals, people and policy changes aren't taken from a token: approve in the console or chat."],
    [["mode", "set"], "step-up", "Approvals, people and policy changes aren't taken from a token: approve in the console or chat."],
    [["chat-approval", "on"], "step-up", "Approvals, people and policy changes aren't taken from a token: approve in the console or chat."],
  ])("refuses %j before any command code runs", async (argv, reason, message) => {
    const before = store.actionLedger({ repos: null, limit: 500 }).filter(one => one.source !== "api").length;
    expect(await as(alex, [...argv.map(one => one === "TASK" ? taskA : one), "--json"])).toBe(3);
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
    expect(last()).toMatchObject({ reason: "unknown-task", message: "No task by that id in your projects." });
    expect(await as(sam, ["task", "show", "no-such-task", "--json"])).toBe(3);
    expect(last()).toMatchObject({ reason: "unknown-task" });
    // Filing needs a project they may use, by its exact server path.
    for (const repo of [[], ["--repo", B], ["--repo", "project-a"], ["--repo", join(dir, "nowhere")]]) {
      expect(await as(sam, ["task", "add", "Somewhere", ...repo, "--json"])).toBe(3);
      expect(last()).toMatchObject({ reason: "unknown-project", message: "Name a project you have access to with --repo (its path on the server)." });
    }
    // A task in their project, named with another project's --repo, is refused too.
    expect(await as(sam, ["task", "show", taskA, "--repo", B, "--json"])).toBe(3);
    // Installation-wide reads need access to every project.
    expect(await as(sam, ["status", "--json"])).toBe(3);
    expect(last()).toMatchObject({ reason: "all-projects" });
    expect(await as(alex, ["status", "--json"])).toBe(0);
    expect(last()).toMatchObject({ ok: true, command: "status" });
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
      expect(await as(sam, ["task", "list", "--json"])).toBe(3);
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

describe("the remote policy table", () => {
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
