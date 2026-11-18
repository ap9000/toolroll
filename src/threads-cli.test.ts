/**
 * Threads for everyday use, slice S8 (operate.ts): the CLI's thread commands and the config prompts (the owner's D5). On a
 * solo install its one operator turns threads off, removes their own sign-in and reads its plain status with no
 * password; `--check` (it sends the saved credential to Claude) and every team install keep a proof; the credential
 * acts (turning threads on, Ship) take a password typed at a hidden prompt for the command, never --token or the
 * remembered login; prompts offer the install's own name. Isolated store and state folder; a stand-in prompt; no model.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { flexibleAvailable, setFlexibleSetting } from "./flexible-available.js";
import { declareNewInstallSolo } from "./install-mode.js";
import { hashPassword } from "./scope.js";
import { runOperate } from "./operate.js";
import { flexibleSignInStatus } from "./flexible-sign-in.js";
import { standInSignIn } from "../test/flexible-sign-in-kit.js";

// The model service: a dead loopback address (a live check that ran would fail; none should run here).
vi.mock("./flexible-relay-upstreams.js", async importOriginal => {
  const real = await importOriginal<typeof import("./flexible-relay-upstreams.js")>();
  return { FLEXIBLE_RELAY_UPSTREAMS: { claude: { ...real.FLEXIBLE_RELAY_UPSTREAMS.claude, origin: "http://127.0.0.1:9" } } };
});

const NOW = new Date();
const PASSWORD = "alex-password-1";
let dir: string, state: string, file: string, store: Store;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-threads-cli-")));
  state = join(dir, "toolroll");
  mkdirSync(state);
  file = join(state, "orders.db");
  store = openStore(file);
  store.saveApprover("alex", hashPassword(PASSWORD), NOW);
  declareNewInstallSolo(store, "alex", NOW);
  setFlexibleSetting(store, true, "alex", NOW);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** One CLI run, as JSON unless `asked` answers prompts (then as text); what the stand-in prompts were asked. */
async function cli(command: string, args: string[], answers: Record<string, string> | null = null): Promise<{ code: number; said: string; asked: string[] }> {
  const lines: string[] = [], asked: string[] = [];
  const answer = async (question: string) => { asked.push(question); return answers?.[question] ?? ""; };
  const code = await runOperate(command, [...args, ...(answers === null ? ["--json"] : [])], line => lines.push(line), { databaseFile: file,
    ...(answers === null ? {} : { easySeams: { ask: answer, askHidden: answer } }) });
  return { code, said: lines.join("\n"), asked };
}
const team = () => { store.saveApprover("bob", hashPassword("bob-password-22"), NOW); };

describe("solo: the narrowing acts and plain status need no password", () => {
  test("threads off, your sign-in removed, its plain status: no prompt, no password", async () => {
    standInSignIn(store, state, "alex");
    const status = await cli("config", ["show", "flexible-sign-in"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.said)).toMatchObject({ ok: true, signIn: { state: "active" } });
    expect(status.asked).toEqual([]);
    expect((await cli("config", ["clear", "flexible-sign-in"])).code).toBe(0);
    expect(flexibleSignInStatus(store, "alex")).toEqual({ state: "none" });
    expect((await cli("config", ["set", "flexible", "off"])).code).toBe(0);
    expect(flexibleAvailable(store)).toBe(false);
  });

  test("--check sends your sign-in to Claude, so it keeps its proof: no password, no check", async () => {
    standInSignIn(store, state, "alex");
    expect((await cli("config", ["show", "flexible-sign-in", "--check"])).code).not.toBe(0);
  });

  test("a team install keeps the step-up for the same acts", async () => {
    team();
    expect((await cli("config", ["set", "flexible", "off"])).code).not.toBe(0);
    expect(flexibleAvailable(store)).toBe(true);
    expect((await cli("config", ["show", "flexible-sign-in"])).code).not.toBe(0);
  });
});

describe("credential acts: a password typed for this command, the install's name offered", () => {
  test("turning threads on never takes the remembered login; at the prompt it offers the solo operator's name, and says what's next", async () => {
    setFlexibleSetting(store, false, "alex", NOW);
    // No prompt and no --token: nothing was typed for this command, so nothing turns on (a remembered login never counts).
    expect((await cli("config", ["set", "flexible", "on"])).code).not.toBe(0);
    expect(flexibleAvailable(store)).toBe(false);
    const on = await cli("config", ["set", "flexible", "on"], { "username [alex]: ": "", "password: ": PASSWORD });
    expect(on.asked).toEqual(["username [alex]: ", "password: "]);
    expect(on.code).toBe(0);
    expect(flexibleAvailable(store)).toBe(true);
    expect(on.said).toContain("Next: 1) your own Claude sign-in: run `claude setup-token`, then `toolroll config set flexible-sign-in` 2) this project's terms");
  });

  test("Ship never takes --token, and on an install where nobody has a password it is the workbench's one key", async () => {
    expect((await cli("thread", ["ship", "a".repeat(32), "--token", PASSWORD])).code).not.toBe(0);
    store.handle.prepare("UPDATE approver SET password_set = 0").run();
    store.handle.prepare("INSERT INTO local_mode (id, owner, generation, enabled, initialized_at, changed_at) VALUES (1, 'alex', 1, 1, ?, ?) ON CONFLICT (id) DO UPDATE SET enabled = 1").run(NOW.toISOString(), NOW.toISOString());
    const laptop = await cli("thread", ["ship", "a".repeat(32)]);
    expect(laptop.code).not.toBe(0);
    expect(laptop.said).toContain("press a");
  });
});

describe("thread commands", () => {
  test("list on a solo install: your threads, with no password; a stranger's id is no thread of yours", async () => {
    expect(JSON.parse((await cli("thread", ["list"])).said)).toMatchObject({ ok: true, threads: [] });
    expect((await cli("thread", ["end", "0123abcd"])).code).not.toBe(0);
  });
});
