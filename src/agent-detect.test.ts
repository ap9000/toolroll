/**
 * Instant start's detection (agent-detect.ts) against stand-in agent CLIs on a PATH this test owns, with fake login
 * files in a throwaway home: signed in, installed but not signed in, not installed, a status command that hangs, and a
 * stand-in that prints a token. Every stand-in writes the arguments it was run with to a log, so the test sees exactly
 * which commands ran: only the two status commands, never a model call, never an ACP agent or Gemini CLI itself.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DETECT_TIMEOUT_MS, detectAgents, detectionLines, detectionReport, firstRunAgentLines, type AgentDetection } from "./agent-detect.js";
import { agentsReadOf } from "./engine-reads.js";
import { agentsReadSchema } from "./contracts/engine-api.js";

const TOKEN = "sk-ant-oat01-DETECTION-MUST-NEVER-ECHO-THIS";
const CODEX_TOKEN = "sk-proj-ALSO-NEVER-ECHOED-0123456789";

let dir: string, bin: string, home: string, log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toolroll-detect-"));
  bin = join(dir, "bin");
  home = join(dir, "home");
  log = join(dir, "ran.log");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(log, "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in CLI: logs its name and arguments, then runs `body` (sh). */
function stub(name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\n${body}\n`);
  chmodSync(file, 0o755);
}
const ran = (): string[] => readFileSync(log, "utf8").split("\n").filter(line => line !== "");
const file = (path: string, text = "x"): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
/** Detection on this test's PATH and home only. The deadline is generous here (a loaded test runner starts a process
 * slowly); the hang test sets its own, and the default is checked to stay under a second. */
const SLACK_MS = 5_000;
const detect = (env: Record<string, string> = {}, timeoutMs = SLACK_MS): Promise<AgentDetection> =>
  detectAgents({ env: { PATH: bin, HOME: home, ...env }, home, timeoutMs });
const stateOf = (detection: AgentDetection) => Object.fromEntries(detection.agents.map(one => [one.id, one.state]));
/** Everything a surface could show of a detection: the engine read, the CLI's report and its lines. */
const shown = (detection: AgentDetection): string => JSON.stringify([agentsReadOf(detection), detectionReport(detection), detection]);

const CLAUDE_SIGNED_IN = `echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"${TOKEN}@example.com","accessToken":"${TOKEN}"}'`;
const CLAUDE_SIGNED_OUT = `echo '{"loggedIn":false}'; exit 1`;

describe("what detection says about each agent", () => {
  test("signed in, installed but not signed in, and not installed; the first task goes to the signed-in one", async () => {
    stub("claude", `[ "$1 $2 $3" = "auth status --json" ] || exit 9\n${CLAUDE_SIGNED_IN}`);
    stub("codex", `[ "$1 $2" = "login status" ] || exit 9\necho 'Not logged in'; exit 1`);
    const detection = await detect();
    expect(stateOf(detection)).toMatchObject({ claude: "signed-in", codex: "signed-out", gemini: "not-installed", openrouter: "not-installed", opencode: "not-installed" });
    expect(detection.agents.find(one => one.id === "claude")).toMatchObject({ how: "Claude account", signIn: null, ready: true });
    expect(detection.agents.find(one => one.id === "codex")).toMatchObject({ signIn: "codex login", ready: false });
    expect(detection.firstTask).toBe("claude");
    expect(detectionLines(detection)).toEqual(["Your first task goes to Claude Code."]);
    // Only the two status commands ran: no model call, nothing else.
    expect(ran().sort()).toEqual(["claude auth status --json", "codex login status"]);
    // The engine read is its contract's shape.
    expect(agentsReadSchema.parse(agentsReadOf(detection))).toEqual(agentsReadOf(detection));
  });

  test("with the default deadline, quick status commands answer inside it and the whole look stays under a second", async () => {
    stub("claude", CLAUDE_SIGNED_IN);
    stub("codex", "echo 'Logged in using ChatGPT'");
    const detection = await detectAgents({ env: { PATH: bin, HOME: home }, home });
    expect(DETECT_TIMEOUT_MS).toBeLessThan(1_000);
    expect(detection.tookMs).toBeLessThan(DETECT_TIMEOUT_MS + 200);
  });

  test("Codex alone signed in: the first task goes to Codex (the preference order: Claude Code, then Codex)", async () => {
    stub("claude", CLAUDE_SIGNED_OUT);
    stub("codex", "echo 'Logged in using ChatGPT'");
    const detection = await detect();
    expect(detection.firstTask).toBe("codex");
    // Both signed in: Claude Code first.
    stub("claude", CLAUDE_SIGNED_IN);
    expect((await detect()).firstTask).toBe("claude");
  });

  test("none signed in: one plain line per installed agent; nothing installed: how to install one", async () => {
    stub("claude", CLAUDE_SIGNED_OUT);
    stub("codex", "echo 'Not logged in'; exit 1");
    stub("gemini", "exit 0");
    const none = await detect();
    expect(none.firstTask).toBeNull();
    expect(detectionLines(none)).toEqual([
      "Sign in to Claude Code: run `claude auth login`",
      "Sign in to Codex: run `codex login`",
      "Sign in to Gemini CLI: run `toolroll keys set gemini --key-file <file>`",
    ]);
    rmSync(bin, { recursive: true });
    mkdirSync(bin);
    const empty = await detect();
    expect(Object.values(stateOf(empty)).every(state => state === "not-installed")).toBe(true);
    expect(detectionLines(empty)).toEqual([
      "Install one:",
      "  Claude Code: run `npm install -g @anthropic-ai/claude-code && claude auth login`",
      "  Codex: run `npm install -g @openai/codex && codex login`",
    ]);
    expect(firstRunAgentLines([], null, true)).toEqual(["Looking for agents on this computer…"]);
  });

  test("a status command that hangs reads unknown at the deadline, and the rest still answer", async () => {
    // By its absolute path: the stand-ins' PATH has no `sleep`. It answers nothing until it is ended.
    stub("claude", "exec /bin/sleep 30");
    stub("codex", "echo 'Logged in using ChatGPT'");
    const started = Date.now();
    const detection = await detect({}, 1_500);
    expect(Date.now() - started).toBeLessThan(1_500 + 1_000);
    expect(stateOf(detection)).toMatchObject({ claude: "unknown", codex: "signed-in" });
    expect(detection.agents.find(one => one.id === "claude")!.signIn).toBe("claude auth login");
    // Codex can take the first task; Claude Code's unknown sign-in isn't counted as signed in.
    expect(detection.firstTask).toBe("codex");
    expect(DETECT_TIMEOUT_MS).toBeLessThan(1_000);
  });

  test("a stand-in that prints a token: nothing it printed is kept or shown", async () => {
    stub("claude", CLAUDE_SIGNED_IN);
    stub("codex", `echo 'Logged in using ChatGPT'; echo '${CODEX_TOKEN}'; echo '${CODEX_TOKEN}' >&2`);
    const detection = await detect();
    expect(stateOf(detection)).toMatchObject({ claude: "signed-in", codex: "signed-in" });
    expect(shown(detection)).not.toContain(TOKEN);
    expect(shown(detection)).not.toContain(CODEX_TOKEN);
    // A login file's contents are never read: a token inside one never reaches anything shown.
    stub("opencode", "exit 0");
    file(join(home, ".local", "share", "opencode", "auth.json"), `{"anthropic":{"type":"api","key":"${TOKEN}"}}`);
    const again = await detect({ XDG_DATA_HOME: join(home, ".local", "share") });
    expect(stateOf(again).opencode).toBe("signed-in");
    expect(shown(again)).not.toContain(TOKEN);
  });
});

describe("the other agents: looked at, never run", () => {
  test("ACP agents: found on PATH, signed in by their own login file, never executed", async () => {
    for (const name of ["opencode", "cursor-agent", "cline", "qwen", "goose"]) stub(name, `: > '${join(dir, "executed")}'`);
    file(join(home, ".local", "share", "opencode", "auth.json"));
    file(join(home, ".qwen", "oauth_creds.json"));
    const detection = await detect();
    expect(stateOf(detection)).toMatchObject({ opencode: "signed-in", qwen: "signed-in", goose: "signed-out", cursor: "unknown", cline: "unknown" });
    // An ACP agent runs only through the gateway after its check: never here.
    expect(existsSync(join(dir, "executed"))).toBe(false);
    expect(ran()).toEqual([]);
    // Signed in but not checked: it can't take the first task yet, and its line says what to do.
    expect(detection.firstTask).toBeNull();
    expect(detectionLines(detection)).toContain("OpenCode is signed in. To give it tasks, check it once: run `toolroll agents check opencode --model <model>`.");
    // An empty login file isn't a sign-in.
    writeFileSync(join(home, ".qwen", "oauth_creds.json"), "");
    expect(stateOf(await detect()).qwen).toBe("signed-out");
  });

  test("Gemini CLI and OpenRouter: key presence (or Gemini's own login file), never run", async () => {
    stub("gemini", `: > '${join(dir, "executed")}'`);
    stub("codex", "echo 'Not logged in'; exit 1");
    expect(stateOf(await detect())).toMatchObject({ gemini: "signed-out", openrouter: "not-installed" });
    const keyed = await detect({ GEMINI_API_KEY: "present", OPENROUTER_API_KEY: "present" });
    expect(stateOf(keyed)).toMatchObject({ gemini: "signed-in", openrouter: "signed-in" });
    expect(keyed.agents.find(one => one.id === "gemini")).toMatchObject({ how: "API key", ready: false, next: "To give it tasks, choose its models in Settings → Models." });
    // On its own Google login (keys auth gemini subscription): the login file Gemini CLI writes.
    file(join(home, ".toolroll", "keys", "gemini.auth"), "subscription");
    file(join(home, ".gemini", "oauth_creds.json"));
    expect((await detect()).agents.find(one => one.id === "gemini")).toMatchObject({ state: "signed-in", how: "Google account" });
    expect(existsSync(join(dir, "executed"))).toBe(false);
    expect(ran()).toEqual(["codex login status", "codex login status", "codex login status"]);
    // Chosen for builds (Settings → Models) and signed in: the first task goes to it.
    expect((await detectAgents({ env: { PATH: bin, HOME: home }, home, routed: "gemini", timeoutMs: SLACK_MS })).firstTask).toBe("gemini");
  });

  test("builds routed to an agent that isn't here: said first, and a signed-in agent says how to choose it", async () => {
    stub("codex", "echo 'Logged in using ChatGPT'");
    const detection = await detectAgents({ env: { PATH: bin, HOME: home }, home, routed: "claude", timeoutMs: SLACK_MS });
    expect(detection.firstTask).toBeNull();
    expect(detectionLines(detection)).toEqual([
      "Your tasks go to Claude Code, which isn't installed here. Install it: run `npm install -g @anthropic-ai/claude-code && claude auth login`",
      "Codex is signed in. To give it tasks, choose it in Settings → Models.",
    ]);
  });
});

test("the engine's agents fixtures (the terminal workbench's snapshots read them) say what the lines would say", () => {
  for (const name of ["agents.json", "agents-none-signed-in.json"]) {
    const fixture = agentsReadSchema.parse(JSON.parse(readFileSync(new URL(`../test/fixtures/engine-api/${name}`, import.meta.url), "utf8")));
    expect(fixture.lines, name).toEqual(firstRunAgentLines(fixture.agents.map(one => ({ ...one, id: one.id as never })), fixture.firstTask?.id ?? null));
  }
});
