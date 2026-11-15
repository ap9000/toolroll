/**
 * Instant start's detection (agent-detect.ts) against stand-in agent CLIs on a PATH this test owns, with fake login
 * files in a throwaway home: signed in, installed but not signed in, not installed, a status command that hangs, and a
 * stand-in that prints a token. Every stand-in writes the arguments it was run with to a log, so the test sees exactly
 * which commands ran: only the two status commands, never a model call, never an ACP agent or Gemini CLI itself.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DETECT_TIMEOUT_MS, detectAgents, detectionLines, detectionReport, firstRunAgentLines, type AgentDetection } from "./agent-detect.js";
import { agentsReadOf } from "./engine-reads.js";
import { agentsReadSchema } from "./contracts/engine-api.js";
import { createConnectionChecker } from "./provider-connection.js";
import { openStore } from "./store.js";
import { statusProbe } from "./status-probe.js";
import { boundedAcl } from "./trusted-path.js";

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

describe("a status command runs only from a trusted install, with nothing of this process's environment", () => {
  /** A Claude Code stand-in that leaves a mark when it runs. */
  const marking = (folder: string): void => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "claude"), `#!/bin/sh\n: > '${join(dir, "executed")}'\n${CLAUDE_SIGNED_IN}\n`);
    chmodSync(join(folder, "claude"), 0o755);
  };
  const claudeOf = async (path: string, untrusted: readonly string[] = []) => {
    const detection = await detectAgents({ env: { PATH: path, HOME: home }, home, timeoutMs: SLACK_MS, untrusted: () => untrusted });
    return detection.agents.find(one => one.id === "claude")!.state;
  };

  test("found in a project folder (an absolute PATH entry): refused, nothing run", async () => {
    const project = join(dir, "shop");
    marking(join(project, "bin"));
    expect(await claudeOf(join(project, "bin"), [project])).toBe("unknown");
    expect(existsSync(join(dir, "executed"))).toBe(false);
    // The same stand-in outside every project runs (the control).
    expect(await claudeOf(join(project, "bin"))).toBe("signed-in");
    expect(existsSync(join(dir, "executed"))).toBe(true);
  });

  test("a PATH folder inside a project, or one others can write, is refused even when it links to a trusted binary elsewhere", async () => {
    // A trusted install outside every project; a link to it from a folder an agent (or anyone) could re-point.
    marking(join(dir, "good"));
    const project = join(dir, "shop");
    mkdirSync(join(project, "bin"), { recursive: true });
    symlinkSync(join(dir, "good", "claude"), join(project, "bin", "claude"));
    expect(await claudeOf(join(project, "bin"), [project])).toBe("unknown");
    const shared = join(dir, "shared-links");
    mkdirSync(shared);
    symlinkSync(join(dir, "good", "claude"), join(shared, "claude"));
    chmodSync(shared, 0o777);
    expect(await claudeOf(shared)).toBe("unknown");
    expect(existsSync(join(dir, "executed"))).toBe(false);
  });

  test("found through a relative PATH entry: refused, nothing run (and no later match is tried instead)", async () => {
    marking(join(dir, "rel"));
    stub("claude", CLAUDE_SIGNED_IN);
    expect(await claudeOf(`${relative(process.cwd(), join(dir, "rel"))}${delimiter}${bin}`)).toBe("unknown");
    expect(existsSync(join(dir, "executed"))).toBe(false);
    expect(ran()).toEqual([]);
  });

  test("a symlink into a folder others can write: refused, nothing run", async () => {
    marking(join(dir, "open"));
    chmodSync(join(dir, "open"), 0o777);
    symlinkSync(join(dir, "open", "claude"), join(bin, "claude"));
    expect(await claudeOf(bin)).toBe("unknown");
    expect(existsSync(join(dir, "executed"))).toBe(false);
  });

  test("a group-writable PATH folder, or a group-writable binary: refused, nothing run", async () => {
    const shared = join(dir, "shared", "bin");
    marking(shared);
    chmodSync(shared, 0o775);
    expect(await claudeOf(shared)).toBe("unknown");
    chmodSync(shared, 0o755);
    chmodSync(join(shared, "claude"), 0o775);
    expect(await claudeOf(shared)).toBe("unknown");
    expect(existsSync(join(dir, "executed"))).toBe(false);
    // Every sign-in check uses the same runner: the plain checker refuses it too.
    const check = createConnectionChecker({ home, env: { PATH: shared, HOME: home } });
    expect((await check("claude", true)).state).toBe("unverified");
    expect(existsSync(join(dir, "executed"))).toBe(false);
  });

  test("its environment is built from nothing: no token, key, socket, loader or interpreter variable reaches it", async () => {
    const canaries: Record<string, string> = {
      GH_TOKEN: "canary-gh", AWS_SECRET_ACCESS_KEY: "canary-aws", SSH_AUTH_SOCK: "/home/me/canary.sock", NODE_OPTIONS: "--require /home/me/canary.js",
      DYLD_INSERT_LIBRARIES: "/home/me/canary.dylib", LD_PRELOAD: "/home/me/canary.so", ANTHROPIC_API_KEY: "canary-anthropic", OPENAI_API_KEY: "canary-openai",
      GEMINI_API_KEY: "canary-gemini", BASH_ENV: "/home/me/canary.sh",
    };
    const dump = join(dir, "env.txt");
    stub("claude", `export -p > '${dump}'\n${CLAUDE_SIGNED_IN}`);
    mkdirSync(join(home, ".claude"));
    const saved = { ...process.env };
    Object.assign(process.env, canaries);
    try {
      const detection = await detectAgents({ env: { ...process.env, PATH: bin, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") }, home, timeoutMs: SLACK_MS });
      expect(detection.agents.find(one => one.id === "claude")!.state).toBe("signed-in");
    } finally {
      for (const name of Object.keys(canaries)) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    }
    const seen = readFileSync(dump, "utf8");
    for (const [name, value] of Object.entries(canaries)) { expect(seen, name).not.toContain(name); expect(seen, name).not.toContain(value); }
    // Its PATH: this test's trusted folder only (by its real path).
    expect(seen).toMatch(new RegExp(`PATH=["']?${realpathSync(bin).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?$`, "m"));
    expect(seen).toContain("CLAUDE_CONFIG_DIR");
  });

  test("at the deadline the command and everything it started are ended, by its own process group", async () => {
    const leader = join(dir, "leader.pid"), forked = join(dir, "forked.pid");
    stub("claude", `echo $$ > '${leader}'\n/bin/sleep 30 &\necho $! > '${forked}'\nexec /bin/sleep 30`);
    // A deadline long enough for a loaded runner to start the stand-in and its child before it passes.
    const started = Date.now();
    const detection = await detect({}, 1_500);
    expect(Date.now() - started).toBeLessThan(1_500 + 1_000);
    expect(detection.agents.find(one => one.id === "claude")!.state).toBe("unknown");
    const pids = [leader, forked].map(file => Number(readFileSync(file, "utf8").trim()));
    expect(pids.every(pid => Number.isSafeInteger(pid) && pid > 1)).toBe(true);
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && pids.some(alive); i++) await new Promise(done => setTimeout(done, 20));
    expect(pids.filter(alive)).toEqual([]);
  });
});

describe("where a status command may never run, what it may be handed, and its deadline", () => {
  const marking = (folder: string, body = CLAUDE_SIGNED_IN): void => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "claude"), `#!/bin/sh\n: > '${join(dir, "executed")}'\n${body}\n`);
    chmodSync(join(folder, "claude"), 0o755);
  };
  const ranIt = (): boolean => existsSync(join(dir, "executed"));

  test("an executable in another registered project, first on PATH, is refused by every checker, the store read by the probe itself", async () => {
    // This worker's own database (test/setup-state.ts: TOOLROLL_DB, a throwaway): two projects registered.
    const store = openStore(process.env["TOOLROLL_DB"]!);
    const shop = join(dir, "shop"), blog = join(dir, "blog");
    mkdirSync(shop); mkdirSync(blog);
    try { store.upsertProject(shop, "shop", new Date()); store.upsertProject(blog, "blog", new Date()); } finally { store.close(); }
    marking(join(blog, "bin"));
    const env = { PATH: `${join(blog, "bin")}${delimiter}${bin}`, HOME: home };
    // The default checker names no store or database: the probe reads the one this environment names.
    expect((await createConnectionChecker({ home, env })("claude", true)).state).toBe("unverified");
    // Detection with the store in hand, and the database file only: the same.
    const again = openStore(process.env["TOOLROLL_DB"]!);
    try {
      expect((await detectAgents({ env, home, timeoutMs: SLACK_MS, store: again })).agents.find(one => one.id === "claude")!.state).toBe("unknown");
    } finally { again.close(); }
    expect((await detectAgents({ env, home, timeoutMs: SLACK_MS, databaseFile: process.env["TOOLROLL_DB"]! })).agents.find(one => one.id === "claude")!.state).toBe("unknown");
    expect(ranIt()).toBe(false);
  });

  test("a trusted launcher whose package folder others can change, or that sits in a project, is refused", async () => {
    // The package (nearest package.json) is a shared sticky folder: the folders above the launcher pass, the package doesn't.
    const pack = join(dir, "pack");
    mkdirSync(pack);
    writeFileSync(join(pack, "package.json"), "{}");
    marking(join(pack, "bin"));
    chmodSync(pack, 0o1777);
    expect((await detectAgents({ env: { PATH: join(pack, "bin"), HOME: home }, home, timeoutMs: SLACK_MS })).agents.find(one => one.id === "claude")!.state).toBe("unknown");
    chmodSync(pack, 0o755);
    expect((await detectAgents({ env: { PATH: join(pack, "bin"), HOME: home }, home, timeoutMs: SLACK_MS, untrusted: () => [pack] })).agents.find(one => one.id === "claude")!.state).toBe("unknown");
    expect(ranIt()).toBe(false);
    // The control: the same launcher, its package trusted and outside every project, runs.
    expect((await detectAgents({ env: { PATH: join(pack, "bin"), HOME: home }, home, timeoutMs: SLACK_MS })).agents.find(one => one.id === "claude")!.state).toBe("signed-in");
  });

  test("a location variable pointing into a project is left out, and the command runs in a fresh, empty folder of its own", async () => {
    const project = join(dir, "shop");
    mkdirSync(join(project, ".claude"), { recursive: true });
    const shared = join(dir, "shared-codex");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const dump = join(dir, "seen.txt");
    stub("claude", `{ export -p; echo "PWD=$PWD"; for f in * .[!.]* ..?*; do [ -e "$f" ] && echo "NOT EMPTY: $f"; done; } > '${dump}'\n${CLAUDE_SIGNED_IN}`);
    const detection = await detectAgents({ env: { PATH: bin, HOME: home, CLAUDE_CONFIG_DIR: join(project, ".claude"), CODEX_HOME: shared, TMPDIR: tmpdir() }, home, timeoutMs: SLACK_MS, untrusted: () => [project] });
    expect(detection.agents.find(one => one.id === "claude")!.state).toBe("signed-in");
    const seen = readFileSync(dump, "utf8");
    expect(seen).not.toContain("CLAUDE_CONFIG_DIR");
    expect(seen).not.toContain("CODEX_HOME");
    expect(seen).not.toContain("NOT EMPTY");
    const cwd = /^PWD=(.*)$/m.exec(seen)![1]!;
    expect(cwd.split("/").at(-1)).toMatch(/^toolroll-status-/);
    expect(cwd).not.toBe(realpathSync(home));
    // Gone after the check.
    expect(existsSync(cwd)).toBe(false);
  });

  test("the final check before the start reads ACLs afresh: an ACL granted between the two checks refuses", async () => {
    marking(bin);
    let resolutions = 0;
    const probe = statusProbe({ env: { PATH: bin, HOME: home }, timeoutMs: SLACK_MS, aclFor: () => {
      resolutions += 1;
      const now = resolutions;
      // The first resolution's reader says no ACL anywhere; by the second, someone was granted write on the binary.
      return path => now === 1 || !path.endsWith("/claude") ? { ok: true } : { ok: false, why: "allows group:staff to change it (write)" };
    } });
    const result = await probe("claude", ["auth", "status", "--json"]);
    expect(result).toMatchObject({ code: 126, notFound: false });
    expect(resolutions).toBe(2);
    expect(ranIt()).toBe(false);
  });

  test("slow ACL reads stay inside the deadline: the whole check answers by then, and nothing runs", async () => {
    marking(bin);
    const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const probe = statusProbe({ env: { PATH: bin, HOME: home }, timeoutMs: 300, aclFor: deadline => boundedAcl(deadline, (_path, ms) => { block(ms); return { ok: true }; }) });
    const started = Date.now();
    const result = await probe("claude", ["auth", "status", "--json"]);
    expect(Date.now() - started).toBeLessThan(300 + 400);
    expect(result.code === 126 || result.timedOut).toBe(true);
    expect(ranIt()).toBe(false);
  });
});
