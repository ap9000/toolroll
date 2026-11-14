/**
 * Easy start (wave 2a): `toolroll password set`, `toolroll welcome` and `toolroll open`, through the real runOperate on
 * a temporary laptop database. The password is only ever typed twice at a person's terminal: under --json, without a
 * terminal, as the terminal UI's local owner, with local mode off or with a password already set it is refused, and
 * nothing changes. Setting it moves the account's generation and ends every saved session; local mode stays on.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, type OperateOptions } from "./operate.js";
import { asLocalOwner, runAsLocalOwner } from "./local-owner.js";
import { propose, verifyCredential } from "./scope.js";
import { passwordFreeShell } from "./task-outcome-cli.js";
import { withActor } from "./actor.js";
import { withRemote } from "./remote-run.js";
import { initLocalMode, localModeOf, openStore, setLocalModeOff } from "./store.js";
import type { EasyStartSeams } from "./easy-start.js";
import { fakePid } from "../test/fake-pid.js";

const now = new Date("2026-11-04T09:00:00Z");
let root: string, file: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-easy-cmd-")));
  file = join(root, "state.db");
  const store = openStore(file, { createdBy: "laptop" });
  try {
    if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now }).ok) throw Error("local mode");
    // A browser session the owner had: setting the password ends it.
    store.saveWebSession({ idHash: "h1", account: "alex", csrf: "c", role: "approver", generation: store.accountOf("alex")!.generation, createdAt: now.getTime(), lastSeen: now.getTime(),
      project: null, projectRevision: 0, ssoAt: null, agent: null, address: null, authority: "local-owner", localGeneration: localModeOf(store)!.generation, keyEpoch: null, keyHash: null });
  } finally { store.close(); }
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const check = async () => ({ state: "signed-out" as const, mode: "subscription" as const, checkedAt: now.toISOString() });
async function run(command: string, args: string[], easySeams: NonNullable<OperateOptions["easySeams"]> = {}): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runOperate(command, [...args, "--db", file], text => { out += `${text}\n`; }, { now, easySeams: { check, ...easySeams } });
  return { code, out };
}
const typing = (...answers: string[]) => async () => answers.shift() ?? "";
function account() {
  const store = openStore(file);
  try { return { ...store.accountOf("alex")!, sessions: Number(store.handle.prepare("SELECT COUNT(*) AS n FROM web_session").get()!["n"]), local: localModeOf(store) }; } finally { store.close(); }
}

describe("toolroll password set", () => {
  test("typed twice at a terminal: the hash is set, the generation moves, every session ends, local mode stays on; a second enrollment is refused", async () => {
    const before = account();
    expect(before.passwordSet).toBe(false);
    const set = await run("password", ["set"], { terminal: true, askHidden: typing("correct horse battery", "correct horse battery") });
    expect(set.code, set.out).toBe(0);
    expect(set.out).toContain("Password set.");
    const after = account();
    expect(after.passwordSet).toBe(true);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.sessions).toBe(0);
    expect(after.local).toMatchObject({ enabled: true, generation: before.local!.generation });
    const store = openStore(file);
    try { expect(verifyCredential(store.handle.prepare("SELECT credential_hash FROM approver WHERE name = 'alex'").get()!["credential_hash"] as string, "correct horse battery")).toBe(true); } finally { store.close(); }
    // Once set, never again through this road: the browser's sign-in owns it now.
    const again = await run("password", ["set"], { terminal: true, askHidden: typing("another password", "another password") });
    expect(again.code).toBe(3);
    expect(again.out).toContain("A password is already set.");
    expect(account().generation).toBe(after.generation);
  });

  test("never without a person at a terminal, never as the local owner, never from a flag; mismatched or short changes nothing", async () => {
    const refusals: [string[], NonNullable<OperateOptions["easySeams"]>, string][] = [
      [["set", "--json"], { terminal: true, askHidden: typing("correct horse battery", "correct horse battery") }, "Set your password yourself at a terminal"],
      [["set"], { terminal: false }, "Set your password yourself at a terminal"],
      [["set", "--password", "hunter2hunter2"], { terminal: true }, "--password is not a password set option"],
      [["set"], { terminal: true, askHidden: typing("one password", "another one") }, "didn't match"],
      [["set"], { terminal: true, askHidden: typing("short", "short") }, "at least 8 characters"],
      [["sideways"], { terminal: true }, "Use `toolroll password set` (a first password) or `toolroll password reset` (a forgotten one)."],
    ];
    for (const [args, seams, words] of refusals) {
      const { code, out } = await run("password", args, seams);
      expect(code, args.join(" ")).not.toBe(0);
      expect(out, args.join(" ")).toContain(words);
    }
    // The terminal UI's door: refused before the command runs (not a local-owner act).
    let out = "";
    await runAsLocalOwner(() => runOperate("password", ["set", "--json", "--db", file], text => { out += text; }, { now, easySeams: { terminal: true, askHidden: typing("correct horse battery", "correct horse battery") } }));
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: "refused" });
    expect(account()).toMatchObject({ passwordSet: false, sessions: 1 });
  });

  test("local mode off: refused, the password is the browser's", async () => {
    const store = openStore(file);
    try { expect(setLocalModeOff(store, { name: "alex", authority: "full" }, now)).toMatchObject({ ok: true }); } finally { store.close(); }
    const { out } = await run("password", ["set"], { terminal: true, askHidden: typing("correct horse battery", "correct horse battery") });
    expect(out).toContain("already signs in with a password");
  });
});

describe("toolroll welcome", () => {
  test("--json prints the welcome model; the local owner may read it", async () => {
    const { code, out } = await run("welcome", ["--json"]);
    expect(code).toBe(0);
    const model = JSON.parse(out) as Record<string, unknown>;
    expect(model).toMatchObject({ ok: true, command: "welcome", next: "project", agent: { done: false }, project: { done: false, projects: [] } });
    let owned = "";
    await runAsLocalOwner(() => runOperate("welcome", ["--json", "--db", file], text => { owned += text; }, { now, easySeams: { check } }));
    expect(JSON.parse(owned)).toMatchObject({ ok: true, command: "welcome" });
  });

  test("at a terminal it walks the steps, checking again when asked, and q stops", async () => {
    const asked: string[] = [];
    const { code, out } = await run("welcome", [], { terminal: true, ask: async question => { asked.push(question); return asked.length === 1 ? "s" : "q"; } });
    expect(code).toBe(0);
    expect(out).toContain("1. Agent · To do");
    expect(out).toContain("To sign in, run: claude auth login");
    expect(out).toContain("2. Project · To do");
    expect(asked).toHaveLength(2);
  });
});

describe("toolroll open", () => {
  test("only at a person's terminal; there it runs the easy start (proved console, the local link, the browser)", async () => {
    expect(JSON.parse((await run("open", ["--json"])).out)).toMatchObject({ ok: false, reason: "not-a-terminal" });
    expect(JSON.parse((await run("open", ["--web", "--json"], { terminal: false })).out)).toMatchObject({ ok: false, reason: "not-a-terminal" });
    const opened: string[] = [];
    const seams: Partial<EasyStartSeams> = {
      prove: async () => ({ ok: true, url: "http://127.0.0.1:4999", port: 4999, pid: fakePid(1), build: "x" }),
      localMode: () => "on", serviceInstalled: () => false,
      openSignedIn: async () => { opened.push("signed in"); return { ok: true, wait: async () => {} }; },
      openBrowser: url => { opened.push(url); },
    };
    const { code, out } = await run("open", ["--web"], { terminal: true, seams });
    expect(code, out).toBe(0);
    // The signed-in road only: never openBrowser (which honours TOOLROLL_BROWSER_COMMAND) with a link.
    expect(opened).toEqual(["signed in"]);
    expect(out).not.toContain("/login/once/");
  });
});

describe("task complete and send back from a shell", () => {
  test("a password-free owner is pointed at the terminal UI's key, with why (never a sign-in road that can't work); once a password exists, the sign-in words", async () => {
    // Piped, no coding agent: why, and the key.
    const piped = { agent: false, terminal: false };
    const accept = await run("task", ["complete", "t-1"], piped);
    expect(accept.code).toBe(3);
    expect(accept.out).toContain("This can't ask you when it runs piped or in the background, and you haven't set a password. Open `toolroll` in your own terminal and press c on the task.");
    const back = await run("task", ["revise", "t-1", "--feedback", "Use the other colour"], piped);
    expect(back.code).toBe(3);
    expect(back.out).toContain("press b on the task.");
    // `send-back`'s other spelling is the same command; `task accept --finish` is Accept, so c.
    const finish = await run("task", ["accept", "t-1", "--finish"], piped);
    expect(finish.code).toBe(3);
    expect(finish.out).toContain("press c on the task.");
    expect(`${accept.out}${back.out}${finish.out}`).not.toMatch(/Sign in with up|username|password:/);
    // Under a coding agent, under --json, and a person at a terminal: each says its own why.
    expect((await run("task", ["complete", "t-1"], { agent: true, terminal: true })).out).toContain("Your coding agent can't do this for you. Open `toolroll` in your own terminal and press c on the task.");
    const json = await run("task", ["revise", "t-1", "--feedback", "x", "--json"], piped);
    expect(json.code).toBe(3);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, reason: "local-owner", message: "With --json nothing can ask you, and you haven't set a password. Open `toolroll` in your own terminal and press b on the task." });
    expect((await run("task", ["complete", "t-1"], { agent: false, terminal: true })).out).toContain("You haven't set a password, so there's nothing to sign in with here. Open `toolroll` and press c on the task.");
    // A name and a password on the command line can't sign in either (no password is set): refused the same way.
    expect((await run("task", ["complete", "t-1", "--as", "alex", "--token", "guess"], piped)).out).toContain("press c on the task.");
    const set = await run("password", ["set"], { terminal: true, askHidden: typing("correct horse battery", "correct horse battery") });
    expect(set.code, set.out).toBe(0);
    const withPassword = await run("task", ["complete", "t-1"], piped);
    expect(withPassword.code).toBe(3);
    expect(withPassword.out).toContain("Run this at a terminal to sign in when asked, or open `toolroll`.");
    expect(withPassword.out).not.toContain("<your password>");
  });
});

describe("task approve from a shell", () => {
  test("a password-free owner is refused before the plan prints or anything asks for a username or password, pointed at a in the terminal UI", async () => {
    const store = openStore(file);
    try {
      store.createTask({ id: "t-1", title: "Fix the total" }, now);
      propose(store, { taskId: "t-1", goal: "Fix the total", touches: ["src/total.ts"], acceptance: [{ id: "c1", statement: "Totals add up.", how: null, evidence: ["check"] }], now });
    } finally { store.close(); }
    // A person at a real terminal (both ends a TTY): today's road would print the plan, then ask "username:".
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    let atTerminal: { code: number; out: string };
    try { atTerminal = await run("task", ["approve", "t-1"], { agent: false }); } finally {
      if (stdin === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY; else Object.defineProperty(process.stdin, "isTTY", stdin);
      if (stdout === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY; else Object.defineProperty(process.stdout, "isTTY", stdout);
    }
    expect(atTerminal.code).toBe(3);
    expect(atTerminal.out.trim()).toBe("You haven't set a password, so there's nothing to sign in with here. Open `toolroll` and press a on the task.");
    // Under --json, under a coding agent, piped: refused, each with its why; never approved.
    const json = await run("task", ["approve", "t-1", "--yes", "--digest", "a".repeat(64), "--json"], { agent: false, terminal: false });
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, reason: "local-owner", message: expect.stringContaining("press a on the task.") });
    expect((await run("task", ["approve", "t-1"], { agent: true, terminal: true })).out).toContain("Your coding agent can't do this for you.");
    expect((await run("task", ["approve", "t-1", "--as", "alex", "--token", "guess"], { agent: false, terminal: false })).out).toContain("press a on the task.");
    const after = openStore(file);
    try { expect(after.getScope("t-1")!.approvedAt).toBeNull(); } finally { after.close(); }
    // Once a password exists, today's road: the would-approve preview and the password command, not the terminal UI's key.
    expect((await run("password", ["set"], { terminal: true, askHidden: typing("correct horse battery", "correct horse battery") })).code).toBe(0);
    const withPassword = await run("task", ["approve", "t-1"], { agent: false, terminal: false });
    expect(withPassword.code).toBe(3);
    expect(withPassword.out).toContain("Nothing has been approved.");
    expect(withPassword.out).not.toContain("press a");
  });

  test("the roads that carry their own authority are never refused early: the terminal UI's local owner, a remote API run, the lead", () => {
    const store = openStore(file);
    try {
      expect(passwordFreeShell(store)).toBe(true);
      const principal = { account: "alex", localGeneration: 1, accountGeneration: store.accountOf("alex")!.generation, transport: "terminal" as const, act: "approve-plan" as const, sessionHash: null, request: null };
      expect(asLocalOwner(principal, () => passwordFreeShell(store))).toBe(false);
      expect(withActor({ account: "alex", lead: true }, () => passwordFreeShell(store))).toBe(false);
      expect(withRemote({ account: "alex", scope: "act", tokenName: "t", source: "api", secret: "s".repeat(32), allows: () => true, lens: null, noteTask: () => undefined, files: {} }, () => passwordFreeShell(store))).toBe(false);
    } finally { store.close(); }
  });
});
