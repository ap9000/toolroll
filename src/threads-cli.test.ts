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
import { runOperate, shipOutcomeWord, threadStateWord } from "./operate.js";
import { shipOutcome, threadWord } from "./browser/views/agents-live-view.js";
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
    expect(laptop.said).toContain("ships from the workbench");
  });
});

describe("Ship says what it needs before it asks for a password", () => {
  test("a project with no check command or no pull requests is refused with what to do next, and no prompt; once it has both, the password is asked", async () => {
    team();
    const repo = join(dir, "shop");
    mkdirSync(repo);
    const id = "5".repeat(32);
    store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'alex', ?, 'ready')`)
      .run(id, repo, "0".repeat(40), `refs/toolroll/threads/${id}/base`, join(state, "threads", id), NOW.toISOString());
    const ship = () => cli("thread", ["ship", id.slice(0, 8)], {});
    const neither = await ship();
    expect(neither).toMatchObject({ asked: [] });
    expect(neither.code).not.toBe(0);
    expect(neither.said).toContain("This project has no check command and can't open pull requests yet, and Ship needs both.");
    store.setVerifyCommand({ repo, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
    const noPullRequests = await ship();
    expect(noPullRequests).toMatchObject({ asked: [] });
    expect(noPullRequests.said).toContain("This project can't open pull requests yet, and Ship needs them");
    store.savePublicationGrant({ repo, githubRepo: "alex/shop", remote: "origin", headPrefix: "toolroll/", base: "main", capabilities: ["push-branch", "open-pr"], selector: "ours", draft: false,
      grantedBy: "alex", publishOn: "complete" }, NOW);
    // Nothing missing: only now does Ship ask who you are, and the rest of its checks follow the password.
    expect((await ship()).asked.length).toBeGreaterThan(0);
  });
});

describe("thread commands", () => {
  test("list on a solo install: your threads, with no password; a stranger's id is no thread of yours", async () => {
    expect(JSON.parse((await cli("thread", ["list"])).said)).toMatchObject({ ok: true, threads: [] });
    expect((await cli("thread", ["end", "0123abcd"])).code).not.toBe(0);
  });
});

describe("a thread's state reads the same in the command line and the browser (and the workbench: tests/thread.rs)", () => {
  // (turn, ship, ended) → its word; a question waiting is the console's (Question) and is said by both lists the same way.
  const table: Array<[string | null, string | null, boolean, string]> = [
    ["running", null, false, "Working"], ["admitted", null, false, "Working"], ["finished", "armed", false, "Shipping"],
    ["finished", null, false, "Ready"], ["finished", "merged", false, "Ready"],
    ["unknown", null, false, "Outcome unknown"], ["interrupted", null, false, "Stopped"], ["unknown", null, true, "Ended"],
    ["finished", "cancelled", false, "Ship stopped"], ["finished", "refused", false, "Ship refused"], ["finished", "failed", false, "Ship refused"],
    ["interrupted", "refused", false, "Stopped"],
  ];
  test.each(table)("turn %s, Ship %s, ended %s: %s", (turn, ship, ended, word) => {
    const row = { id: "t", title: "t", project: null, live: false, waiting: 0, turn, ended, stopPending: false, ship };
    expect(threadStateWord(row)).toBe(word);
    expect(threadWord(row).word).toBe(word);
  });
  test("a merged Ship reads Merged as its Ship outcome, apart from the thread's state; a refused one has its own word", () => {
    expect(shipOutcome("merged")).toBe("Ship: Merged");
    expect(shipOutcomeWord("merged")).toBe(" · Ship: Merged");
    expect([shipOutcome("refused"), shipOutcomeWord("refused")]).toEqual([null, ""]);
  });
  test("words the command line and the browser show name no terminal keys", async () => {
    const words = await import("./flexible-session.js");
    for (const one of [words.FLEXIBLE_THREAD_ENDED, words.FLEXIBLE_SHIP_WORKING]) expect(one).not.toMatch(/\bpress\b|\bwith [a-zA-Z]\b/i);
  });
});

