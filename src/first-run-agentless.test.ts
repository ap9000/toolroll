/**
 * The first task filed before any coding agent is signed in never just sits: the shell's `task add` says so with the
 * one command (as the terminal app and the task page already do), `task show` asks for a sign-in (never "again" for an
 * agent that was never signed in) and names a plan, never a "scope", and the welcome's third step reads "Filed", not
 * "Done", while it waits for step 1. Temp databases only; no agent CLI is run.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runOperate } from "./operate.js";
import { register } from "./runner.js";
import { openStore } from "./store.js";
import { GENERIC_FIRST_TASKS, welcomeModel } from "./first-run.js";
import { welcomeLines } from "./welcome-facts.js";
import { htmlString } from "./html.js";
import { withFormToken } from "./server/request-context.js";
import { welcomeBody } from "./server/welcome.js";

const T0 = new Date("2026-11-14T16:00:00.000Z");
const INSTALL = /npm install -g @anthropic-ai\/claude-code(;| &&) claude auth login/;

let dir = "", db = "", repo = "";
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "first-run-agentless-")));
  db = join(dir, "orders.db");
  repo = join(dir, "shop");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A builder for the project that reported its agents: both missing, or Claude Code signed in. */
function builder(agents: "none" | "ready"): void {
  const store = openStore(db);
  try {
    register(store, { name: "laptop", host: "test", capacity: 1, repos: [repo], now: T0, newToken: () => "runner-token" });
    store.recordProviderReadiness("laptop", [
      agents === "ready" ? { provider: "claude", state: "ready", reason: "installed (2.1.300); logged in", probe: "identity" }
        : { provider: "claude", state: "unavailable", reason: "`claude` is not installed on this runner's PATH", probe: "path" },
      { provider: "codex", state: "unavailable", reason: "`codex` is not installed on this runner's PATH", probe: "path" },
    ], T0);
  } finally { store.close(); }
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await runOperate(argv[0]!, argv.slice(1), line => lines.push(line), { databaseFile: db, now: T0 });
  return { code, out: lines.join("\n") };
}

describe("a first task filed from a shell with no coding agent signed in", () => {
  test("task add says no agent is signed in and the one command; task show asks to sign in and names no scope", async () => {
    builder("none");
    const added = await run(["task", "add", "Fix a typo in the README", "--id", "t-first", "--repo", repo]);
    expect(added.code).toBe(0);
    expect(added.out).toContain("Queued t-first — Fix a typo in the README");
    expect(added.out).toMatch(/^ {2}No coding agent is signed in\. Run `npm install -g @anthropic-ai\/claude-code(;| &&) claude auth login` so it can be planned\.$/m);
    expect(added.out).not.toContain("no project yet");

    const json = await run(["task", "add", "Fix another typo", "--id", "t-second", "--repo", repo, "--json"]);
    expect(JSON.parse(json.out).waiting).toMatch(/^No coding agent is signed in\. Run `/);

    // Sent for a plan (the terminal app's n, or p): its wait is the sign-in, asked for as a first sign-in.
    const store = openStore(db);
    try { store.requestPlan(store.refFor("built-in", "t-first").id, T0); } finally { store.close(); }
    const shown = await run(["task", "show", "t-first"]);
    expect(shown.out).toMatch(INSTALL);
    expect(shown.out).toContain("No coding agent is signed in.");
    expect(shown.out).toMatch(/^ {2}next: Sign in$/m);
    expect(shown.out).not.toContain("Sign in again");
    expect(shown.out).not.toMatch(/\bscope\b/);
  });

  test("filed with no project: says how to give it one", async () => {
    builder("none");
    const added = await run(["task", "add", "Fix a typo in the README", "--id", "t-loose"]);
    expect(added.code).toBe(0);
    expect(added.out).toContain("It has no project yet: choose one on its page in Toolroll, or file it with `--repo <folder>`.");
    expect(added.out).not.toContain("No coding agent");
  });

  test("with an agent signed in, task add says nothing about signing in", async () => {
    builder("ready");
    const added = await run(["task", "add", "Fix a typo in the README", "--id", "t-first", "--repo", repo]);
    expect(added.code).toBe(0);
    expect(added.out).not.toContain("No coding agent");
    const json = await run(["task", "add", "Fix another typo", "--id", "t-second", "--repo", repo, "--json"]);
    expect(JSON.parse(json.out)).not.toHaveProperty("waiting");
  });
});

describe("the welcome's first-task step while no agent is signed in", () => {
  const project = { name: "shop", path: "/work/shop" };
  const model = (agent: "not-installed" | "signed-out" | "connected") => welcomeModel({ agents: { claude: agent, codex: agent }, inUse: null, buildsOn: "claude",
    canChoose: false, projects: [project], projectRoot: "/work", ready: agent === "connected", hasTask: true, starters: GENERIC_FIRST_TASKS, platform: "darwin" });

  test("filed but waiting for step 1 reads Filed, never Done", () => {
    for (const agent of ["not-installed", "signed-out"] as const) {
      const lines = welcomeLines(model(agent));
      expect(lines, agent).toContain("3. First task · Filed");
      expect(lines.join("\n"), agent).not.toContain("First task · Done");
      expect(lines.join("\n"), agent).toContain("It starts by itself once an agent is signed in (step 1).");
    }
  });

  test("with an agent signed in, the filed task's step is Done", () => {
    expect(welcomeLines(model("connected"))).toContain("3. First task · Done");
  });

  test("the browser's welcome page: the filed task's step wears Filed while it waits for step 1, Done after", () => {
    const taskStep = (agent: "not-installed" | "connected") => {
      const page = htmlString(withFormToken("t0k", () => welcomeBody(model(agent), { canAdd: true, problem: null })).body);
      return page.slice(page.indexOf('data-step="task"'));
    };
    expect(taskStep("not-installed")).toMatch(/>Filed</);
    expect(taskStep("not-installed")).not.toMatch(/>Done</);
    expect(taskStep("not-installed")).toContain("It starts by itself once an agent is signed in (step 1).");
    expect(taskStep("connected")).toMatch(/>Done</);
  });
});
