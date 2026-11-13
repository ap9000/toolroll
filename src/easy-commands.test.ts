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
import { runAsLocalOwner } from "./local-owner.js";
import { verifyCredential } from "./scope.js";
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
      [["sideways"], { terminal: true }, "Use `toolroll password set`."],
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
      requestLink: async () => ({ ok: true, url: "http://127.0.0.1:4999/login/once/abc" }),
      openBrowser: url => { opened.push(url); },
    };
    const { code, out } = await run("open", ["--web"], { terminal: true, seams });
    expect(code, out).toBe(0);
    expect(opened).toEqual(["http://127.0.0.1:4999/login/once/abc"]);
    expect(out).not.toContain("/login/once/");
  });
});

describe("task complete and send back from a shell", () => {
  test("a password-free owner is pointed at the terminal UI's key (never a sign-in road that can't work); once a password exists, the sign-in words", async () => {
    const accept = await run("task", ["complete", "t-1"]);
    expect(accept.code).toBe(3);
    expect(accept.out).toContain("Open `toolroll` and press c on the task.");
    const back = await run("task", ["revise", "t-1", "--feedback", "Use the other colour"]);
    expect(back.code).toBe(3);
    expect(back.out).toContain("Open `toolroll` and press b on the task.");
    expect(`${accept.out}${back.out}`).not.toMatch(/Sign in with up/);
    const set = await run("password", ["set"], { terminal: true, askHidden: typing("correct horse battery", "correct horse battery") });
    expect(set.code, set.out).toBe(0);
    const withPassword = await run("task", ["complete", "t-1"]);
    expect(withPassword.code).toBe(3);
    expect(withPassword.out).toContain("Run this at a terminal to sign in when asked, or open `toolroll`.");
    expect(withPassword.out).not.toContain("<your password>");
  });
});
